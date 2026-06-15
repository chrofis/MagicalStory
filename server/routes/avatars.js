/**
 * Avatar Routes
 *
 * Photo analysis, avatar generation, and face matching endpoints.
 * Extracted from server.js for better code organization.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { logActivity, dbQuery, saveAvatarToR2, saveAvatarThumbToR2 } = require('../services/database');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { compressImageToJPEG } = require('../lib/images');
const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../config/models');
const { generateWithRunware, generateAvatarWithACE, isRunwareConfigured } = require('../lib/runware');
const { editWithGrok } = require('../lib/grok');
const { buildHairDescription, getAgeCategory, clampApparentAge } = require('../lib/storyHelpers');
const { getFacePhoto } = require('../lib/characterPhotos');

// ============================================================================
// ART STYLE SAMPLE IMAGES (copied from styledAvatars.js — can't import due to circular dep)
// ============================================================================

const ART_STYLE_SAMPLES = {
  'watercolor': 'water color style.jpg',
  'concept': 'concept art style.jpg',
  'anime': 'anime style.jpg',
  'pixar': 'pixar art style 2.jpg',
  'cartoon': 'cartoon style.jpg',
  'comic': 'comic book style.jpg',
  'oil': 'oil painting style.jpg',
  'steampunk': 'steampunk style.jpg',
  'cyber': 'cyber punk style.jpg',
  'chibi': 'chibi style.jpg',
  'manga': 'manga style.jpg',
  'pixel': 'pixel style.jpg',
  'lowpoly': 'low poly 3-D style.jpg',
  'realistic': 'concept art style.jpg'  // Reuse concept art sample (closest to photorealistic)
};

const styleSampleCache = new Map();

// URL-only writers (Phase 5). Inline base64 only persists when R2 upload
// returned no URL — readers expect URL field. Hoisted from two identical
// definitions inside avatar persistence handlers.
const onlyIfNoUrl = (inline, url) => (url ? undefined : inline);
const onlyMissingThumbs = (inline, urls) => {
  if (!inline) return undefined;
  if (!urls) return inline;
  const out = {};
  for (const k of Object.keys(inline)) if (!urls[k]) out[k] = inline[k];
  return Object.keys(out).length ? out : undefined;
};

/**
 * Load art style sample image as base64 (local copy — mirrors styledAvatars.js)
 * @param {string} artStyle - Art style ID
 * @returns {string|null} Base64 data URL or null if not found
 */
function loadStyleSampleImage(artStyle) {
  if (styleSampleCache.has(artStyle)) {
    return styleSampleCache.get(artStyle);
  }

  const filename = ART_STYLE_SAMPLES[artStyle];
  if (!filename) {
    log.debug(`[STYLE SAMPLE] No sample image defined for art style: ${artStyle}`);
    return null;
  }

  const imagePath = path.join(__dirname, '../../images', filename);

  try {
    if (!fs.existsSync(imagePath)) {
      log.warn(`[STYLE SAMPLE] Sample image not found: ${imagePath}`);
      return null;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    styleSampleCache.set(artStyle, dataUrl);
    log.debug(`[STYLE SAMPLE] Loaded and cached sample for ${artStyle} (${Math.round(imageBuffer.length / 1024)}KB)`);

    return dataUrl;
  } catch (error) {
    log.error(`[STYLE SAMPLE] Failed to load sample for ${artStyle}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// COSTUMED AVATAR GENERATION LOG (for developer mode auditing)
// ============================================================================

// Generation log for developer mode auditing, scoped per cache scope (= per
// story job, via the AsyncLocalStorage in styledAvatars.js). Was previously
// a single module-level array — same cross-story bleed bug as the styled
// avatar log. Key: scope from styledAvatars._cacheContext.getStore().
const costumedAvatarGenerationLogs = new Map();
const MAX_GENERATION_LOG_ENTRIES = 50;
const _COSTUMED_LOG_UNSCOPED = '__unscoped__';

function _getCurrentCostumedScope() {
  // Lazy require — styledAvatars.js is loaded later in the require graph in
  // some boot orders; deferring avoids a circular-require edge case.
  const { _cacheContext } = require('../lib/styledAvatars');
  return _cacheContext.getStore() || _COSTUMED_LOG_UNSCOPED;
}

function pushGenerationLog(entry) {
  const scope = _getCurrentCostumedScope();
  let bucket = costumedAvatarGenerationLogs.get(scope);
  if (!bucket) { bucket = []; costumedAvatarGenerationLogs.set(scope, bucket); }
  bucket.push(entry);
  if (bucket.length > MAX_GENERATION_LOG_ENTRIES) {
    bucket.splice(0, bucket.length - MAX_GENERATION_LOG_ENTRIES);
  }
  if (scope === _COSTUMED_LOG_UNSCOPED) {
    log.warn(`⚠️ [COSTUMED-AVATAR LOG] Entry pushed outside cache scope — invisible to dev panels`);
  }
}

// ============================================================================
// FACE EVALUATION TOGGLE (for performance optimization)
// ============================================================================

// Internal toggle for avatar evaluation after generation
// Controls Gemini evaluation (extracts clothing, physical traits, face score)
// Keep enabled for clothing extraction to work
const ENABLE_AVATAR_EVALUATION = true;

// Internal toggle for face comparison (LPIPS + ArcFace via Python service)
// These are the slow calls (~15 network requests to Python service)
// Disable for faster avatar generation on production
const ENABLE_FACE_COMPARISON = false;

// Minimum face score for base clothing avatars before triggering a retry.
// Categories scoring below this threshold get one regeneration attempt.
// Raised from 5 to 7 alongside the F3 prompt tightening — the prior 5 paired
// with the lenient prompt let through "vaguely the same person" avatars where
// face geometry visibly drifted. With the stricter forehead/cheek/jawline
// check, a score of 5-6 now genuinely means "different face geometry" and
// should retry; 7+ is the new "actually the same person" bar.
const MIN_BASE_AVATAR_SCORE = 7;

// ============================================================================
// AVATAR JOB QUEUE (for non-blocking avatar generation)
// ============================================================================

// In-memory store for avatar generation jobs
// Jobs expire after 10 minutes
const avatarJobs = new Map();
const AVATAR_JOB_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// Clean up expired jobs periodically
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of avatarJobs.entries()) {
    if (now - job.createdAt > AVATAR_JOB_EXPIRY_MS) {
      avatarJobs.delete(jobId);
    }
  }
}, 60000); // Check every minute

/**
 * Create a short identifier for an image (first 12 chars of base64 data after header)
 */
function getImageIdentifier(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return base64.substring(0, 12) + '...';
}

/**
 * Get the size of an image in KB from base64
 */
function getImageSizeKB(imageData) {
  if (!imageData || typeof imageData !== 'string') return 0;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return Math.round((base64.length * 3 / 4) / 1024);
}

/**
 * Split a 2x2 grid image into 4 quadrants and extract face from top-left
 * Calls the Python photo_analyzer service
 * @param {string} imageData - base64 encoded 2x2 grid image
 * @returns {Object} - { success, quadrants: { faceFront, faceProfile, bodyFront, bodyProfile }, faceThumbnail }
 */
async function splitGridAndExtractFace(imageData) {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`🔪 [SPLIT-GRID] Calling Python service at ${photoAnalyzerUrl}/split-grid`);

    const response = await fetch(`${photoAnalyzerUrl}/split-grid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageData }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      log.error(`🔪 [SPLIT-GRID] Python service returned ${response.status}`);
      return { success: false, error: `HTTP ${response.status}` };
    }

    const result = await response.json();

    if (result.success) {
      log.debug(`🔪 [SPLIT-GRID] Successfully split grid into 4 quadrants`);
      if (result.faceThumbnail) {
        log.debug(`🔪 [SPLIT-GRID] Extracted face thumbnail: ${getImageSizeKB(result.faceThumbnail)}KB`);
      }
    } else {
      log.error(`🔪 [SPLIT-GRID] Python service error: ${result.error}`);
    }

    return result;
  } catch (err) {
    log.error(`🔪 [SPLIT-GRID] Error calling Python service:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Get the costumed avatar generation log for the current cache scope only.
 * Returns [] when called outside a runInCacheScope wrapper.
 */
function getCostumedAvatarGenerationLog() {
  const { _cacheContext } = require('../lib/styledAvatars');
  const scope = _cacheContext.getStore();
  if (!scope) return [];
  const bucket = costumedAvatarGenerationLogs.get(scope);
  return bucket ? [...bucket] : [];
}

/**
 * Clear the costumed avatar log for the current scope only.
 * Call after capturing into saved story result to free memory.
 */
function clearCostumedAvatarGenerationLog() {
  const { _cacheContext } = require('../lib/styledAvatars');
  const scope = _cacheContext.getStore();
  if (!scope) return;
  const count = costumedAvatarGenerationLogs.get(scope)?.length || 0;
  costumedAvatarGenerationLogs.delete(scope);
  log.debug(`🗑️ [COSTUMED AVATARS] Generation log cleared (${count} entries) for scope ${scope}`);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Extract face from an image using the Python service
 * Can optionally extract from a specific quadrant of a 2x2 grid
 * @param {string} imageData - Base64 image
 * @param {string} quadrant - Optional: 'top-left', 'top-right', 'bottom-left', 'bottom-right'
 * @param {number} size - Output size (default 256x256)
 * Returns { success, face, faceBbox, faceDetected } or null on error
 */
async function extractFace(imageData, quadrant = null, size = 256) {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    const requestBody = {
      image: imageData,
      size
    };
    if (quadrant) {
      requestBody.quadrant = quadrant;
    }

    const response = await fetch(`${photoAnalyzerUrl}/extract-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      log.warn('[EXTRACT-FACE] Service returned error:', response.status);
      return null;
    }

    const result = await response.json();

    if (result.success) {
      log.debug(`[EXTRACT-FACE] Face extracted (detected: ${result.faceDetected})`);
      return result;
    } else {
      log.warn('[EXTRACT-FACE] Extraction failed:', result.error);
      return null;
    }
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      log.debug('[EXTRACT-FACE] Service not available (offline)');
    } else {
      log.warn('[EXTRACT-FACE] Error:', err.message);
    }
    return null;
  }
}

/**
 * Compare two images using LPIPS perceptual similarity (via Python service)
 * LPIPS score: 0 = identical, 1 = very different
 * @param {string} image1 - First image (base64)
 * @param {string} image2 - Second image (base64)
 * @param {Array} bbox - Optional: crop only image2 to this region [ymin,xmin,ymax,xmax] (for face vs 2x2 grid)
 * @param {Array} bboxBoth - Optional: crop BOTH images to this region (for comparing two 2x2 grids)
 * Returns { success, lpips_score, interpretation, region } or null on error
 */
async function compareLPIPS(image1, image2, bbox = null, bboxBoth = null) {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    const requestBody = {
      image1,
      image2,
      resize_to: 256  // Faster comparison
    };

    // Optionally crop both images to same region (for comparing two 2x2 grids)
    if (bboxBoth && Array.isArray(bboxBoth) && bboxBoth.length === 4) {
      requestBody.bbox_both = bboxBoth;
    }
    // Optionally crop only image2 (for comparing face photo vs 2x2 grid)
    else if (bbox && Array.isArray(bbox) && bbox.length === 4) {
      requestBody.bbox = bbox;
    }

    const response = await fetch(`${photoAnalyzerUrl}/lpips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      log.warn('[LPIPS] Service returned error:', response.status);
      return null;
    }

    const result = await response.json();

    if (result.success) {
      console.log(`📊 [LPIPS] Score: ${result.lpips_score?.toFixed(4)} (${result.interpretation}) region: ${result.region}`);
      return {
        success: true,
        lpipsScore: result.lpips_score,
        interpretation: result.interpretation,
        region: result.region
      };
    } else {
      log.warn('[LPIPS] Comparison failed:', result.error);
      return null;
    }
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      log.debug('[LPIPS] Service not available (offline)');
    } else {
      log.warn('[LPIPS] Error:', err.message);
    }
    return null;
  }
}

/**
 * Compare faces using LPIPS after extracting faces from both images
 * This provides more accurate face-to-face comparison by removing clothing/background
 * @param {string} originalPhoto - Original face photo (base64)
 * @param {string} avatarImage - Generated avatar (2x2 grid, base64)
 * @param {string} avatarQuadrant - Quadrant to extract from avatar (default 'top-left' for front face)
 * Returns { success, lpipsScore, interpretation, region, facesExtracted } or null on error
 */
async function compareFacesLPIPS(originalPhoto, avatarImage, avatarQuadrant = 'top-left') {
  try {
    // Extract faces from both images in parallel
    const [originalFaceResult, avatarFaceResult] = await Promise.all([
      extractFace(originalPhoto, null, 256),  // Original photo - no quadrant
      extractFace(avatarImage, avatarQuadrant, 256)  // Avatar - extract from quadrant
    ]);

    // Check if face extraction succeeded
    const originalFace = originalFaceResult?.face;
    const avatarFace = avatarFaceResult?.face;

    if (!originalFace || !avatarFace) {
      log.warn('[LPIPS FACES] Face extraction failed - falling back to bbox comparison');
      // Fallback to bbox comparison
      const faceOnlyBbox = [0, 0, 0.3, 0.5];
      return await compareLPIPS(originalPhoto, avatarImage, faceOnlyBbox);
    }

    log.debug(`[LPIPS FACES] Faces extracted - original: ${originalFaceResult.faceDetected}, avatar: ${avatarFaceResult.faceDetected}`);

    // Compare the extracted faces (no bbox needed - they're already face-only)
    const lpipsResult = await compareLPIPS(originalFace, avatarFace);

    if (lpipsResult) {
      return {
        ...lpipsResult,
        region: 'extracted_faces',
        facesExtracted: {
          original: originalFaceResult.faceDetected,
          avatar: avatarFaceResult.faceDetected
        }
      };
    }

    return null;
  } catch (err) {
    log.warn('[LPIPS FACES] Error:', err.message);
    return null;
  }
}

/**
 * Compare faces using ArcFace identity embeddings (style-invariant)
 * Unlike LPIPS which measures visual similarity, ArcFace measures identity preservation
 * Works across styles: photo → illustrated avatar → anime style
 * @param {string} originalPhoto - Original face photo (base64)
 * @param {string} avatarImage - Generated avatar (2x2 grid, base64)
 * @param {string} avatarQuadrant - Quadrant to extract from avatar (default 'top-left')
 * Returns { success, similarity, samePerson, confidence, interpretation } or null on error
 */
async function compareIdentityArcFace(originalPhoto, avatarImage, avatarQuadrant = 'top-left') {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    const response = await fetch(`${photoAnalyzerUrl}/compare-identity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image1: originalPhoto,
        image2: avatarImage,
        quadrant2: avatarQuadrant
      }),
      signal: AbortSignal.timeout(60000)  // ArcFace can take longer on first load
    });

    if (!response.ok) {
      log.warn(`[ARCFACE] Python service returned ${response.status}`);
      return null;
    }

    const result = await response.json();

    if (result.success) {
      console.log(`📊 [ARCFACE] Similarity: ${result.similarity?.toFixed(4)}, same_person: ${result.same_person}, confidence: ${result.confidence}`);
      return {
        success: true,
        similarity: result.similarity,
        samePerson: result.same_person,
        confidence: result.confidence,
        interpretation: result.interpretation
      };
    }

    log.warn(`[ARCFACE] Comparison failed: ${result.error}`);
    return null;
  } catch (err) {
    log.warn('[ARCFACE] Error:', err.message);
    return null;
  }
}

/**
 * Extract physical traits from a photo using Gemini vision
 */
async function extractTraitsWithGemini(imageData, languageInstruction = '') {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      log.debug('📸 [GEMINI] No API key, skipping trait extraction');
      return null;
    }

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                text: (PROMPT_TEMPLATES.characterAnalysis || `Analyze this image of a person for a children's book illustration system. Return JSON with traits (age, gender, height, build, face, hair). Be specific about colors.`).replace('{LANGUAGE_INSTRUCTION}', languageInstruction)
              },
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64Data,
                },
              },
            ],
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json'
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      log.error('📸 [GEMINI] API error:', response.status);
      return null;
    }

    const data = await response.json();

    // Log token usage
    const modelId = 'gemini-2.5-flash';
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [CHARACTER ANALYSIS] Token usage - model: ${modelId}, input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      const text = data.candidates[0].content.parts[0].text;
      log.debug('📸 [GEMINI] Raw response length:', text.length);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        const rawResponse = text;
        if (result.traits) {
          log.debug('📸 [GEMINI] Extracted traits:', result.traits);
          return { ...result, _rawResponse: rawResponse };
        } else {
          log.debug('📸 [GEMINI] Extracted traits (flat format):', result);
          return { traits: result, _rawResponse: rawResponse };
        }
      } else {
        // JSON was truncated (no closing brace) — salvage partial traits via key-value extraction
        log.warn(`📸 [GEMINI] Truncated JSON response (${text.length} chars, ${outputTokens} tokens), attempting partial extraction`);
        const partialTraits = {};
        // Extract simple key-value pairs from the truncated text
        const kvPattern = /"(apparentAge|build|skinTone|eyeColor|hairColor|hairDensity|hairLength|hairStyle|facialHair|face|other|skinToneHex|eyeColorHex|hairColorHex)"\s*:\s*"([^"]+)"/g;
        let match;
        while ((match = kvPattern.exec(text)) !== null) {
          partialTraits[match[1]] = match[2];
        }
        if (Object.keys(partialTraits).length > 0) {
          log.info(`📸 [GEMINI] Salvaged ${Object.keys(partialTraits).length} traits from truncated response: ${Object.keys(partialTraits).join(', ')}`);
          return { traits: partialTraits, _rawResponse: text, _partial: true };
        }
        log.error('📸 [GEMINI] No JSON and no salvageable traits in response:', text.substring(0, 200));
        return { _rawResponse: text, _error: 'No JSON found in response' };
      }
    } else {
      log.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
      return { _rawResponse: JSON.stringify(data), _error: 'Unexpected response structure' };
    }
  } catch (err) {
    log.error('📸 [GEMINI] Trait extraction error:', err.message);
    return null;
  }
}

/**
 * Consensus voting across photo traits (ground truth) and multiple avatar evaluations.
 * Face-related fields use majority vote with photo as tiebreaker.
 * Clothing stays from avatar evals (handled separately).
 *
 * @param {Object} photoTraits - Traits extracted from original photo via extractTraitsWithGemini
 * @param {Object[]} avatarTraitsArray - Array of physicalTraits from avatar evaluations
 * @returns {{ traits: Object, sources: Object }} Merged traits + per-field source info
 */
function consensusTraits(photoTraits, avatarTraitsArray) {
  // Face-related fields that use consensus voting.
  // Hair shape/length/density/styling consolidated into detailedHairAnalysis
  // (a photo-only field), so they don't participate in consensus voting.
  const CONSENSUS_FIELDS = [
    'apparentAge', 'build', 'skinTone', 'eyeColor',
    'hairColor', 'facialHair'
  ];

  // Fields that just copy from photo (no avatar equivalent or photo is definitive).
  // `glasses` belongs here: the photo is ground truth for whether the person wears
  // glasses (avatars in stylized art may render them inconsistently). Without this,
  // glasses were silently dropped — Sarah's profile had no glasses field even
  // though her uploaded photo shows glasses, which produced an endless eval loop
  // ("unrequested glasses" vs "missing glasses" depending on which version).
  const PHOTO_ONLY_FIELDS = ['face', 'other', 'glasses'];

  // Fields that copy best value available (hex codes — take from photo if available)
  const HEX_FIELDS = ['skinToneHex', 'eyeColorHex', 'hairColorHex'];

  const result = {};
  const sources = {}; // Track which source won for each field

  for (const field of CONSENSUS_FIELDS) {
    const votes = [];
    if (photoTraits?.[field]) votes.push({ value: photoTraits[field], source: 'photo' });
    for (const avatarTraits of avatarTraitsArray) {
      if (avatarTraits?.[field]) votes.push({ value: avatarTraits[field], source: 'avatar' });
    }

    if (votes.length === 0) continue;

    // Count occurrences of each value
    const counts = {};
    for (const { value } of votes) {
      counts[value] = (counts[value] || 0) + 1;
    }

    // Find majority (most common value)
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topValue = sorted[0][0];
    const topCount = sorted[0][1];

    // If tie, photo value wins (ground truth)
    if (sorted.length > 1 && topCount === sorted[1][1] && photoTraits?.[field]) {
      result[field] = photoTraits[field];
      sources[field] = 'photo (tiebreaker)';
    } else {
      result[field] = topValue;
      sources[field] = topCount >= 3 ? 'consensus' : (topValue === photoTraits?.[field] ? 'photo' : 'avatar');
    }
  }

  // Photo-only fields
  for (const field of PHOTO_ONLY_FIELDS) {
    if (photoTraits?.[field]) result[field] = photoTraits[field];
  }

  // Hex fields — prefer photo
  for (const field of HEX_FIELDS) {
    result[field] = photoTraits?.[field] || avatarTraitsArray.find(a => a?.[field])?.[field];
  }

  return { traits: result, sources };
}

/**
 * Evaluate face match between original photo and generated avatar
 * Also extracts physical traits and clothing from the generated avatar
 * Runs both Gemini LLM evaluation AND LPIPS perceptual comparison
 * Returns { score, details, physicalTraits, clothing, lpips } or null on error
 */
async function evaluateAvatarFaceMatch(originalPhoto, generatedAvatar, geminiApiKey, requestedClothing = null) {
  try {
    // Both inputs may arrive as data: URIs, raw base64, or HTTPS R2 URLs (the
    // common case post-R2 migration). bytesFromAnyImage normalizes all three
    // shapes into Buffer bytes. The old .replace(/^data:image\/\w+;base64,/)
    // path was a no-op on URLs, sent the URL string to Gemini as base64,
    // produced a 400 from the API, and silently returned null — which meant
    // the avatar's eval score never landed on the result, so retries didn't
    // fire and stale scores persisted. Fail loudly when decoding fails so
    // the eval skip is visible in logs instead of silent.
    const r2 = require('../lib/r2');
    const [originalBytes, avatarBytes] = await Promise.all([
      r2.bytesFromAnyImage(originalPhoto),
      r2.bytesFromAnyImage(generatedAvatar),
    ]);
    if (!originalBytes) {
      log.warn(`[AVATAR EVAL] Could not decode originalPhoto (type=${typeof originalPhoto}, len=${originalPhoto?.length}) — skipping eval`);
      return null;
    }
    if (!avatarBytes) {
      log.warn(`[AVATAR EVAL] Could not decode generatedAvatar (type=${typeof generatedAvatar}, len=${generatedAvatar?.length}) — skipping eval`);
      return null;
    }
    const originalBase64 = originalBytes.toString('base64');
    const originalMime = 'image/jpeg';
    const avatarBase64 = avatarBytes.toString('base64');
    const avatarMime = 'image/jpeg';

    let evalPrompt = PROMPT_TEMPLATES.avatarEvaluation || 'Compare these two faces. Rate similarity 1-10. Output: FINAL SCORE: [number]';

    // Append clothing match task when requested clothing description is provided
    if (requestedClothing) {
      evalPrompt += `\n\nTASK 5: CLOTHING MATCH\nThe avatar was requested to wear: "${requestedClothing}"\nScore 1-10 how well the generated avatar's clothing matches this request (10 = perfect match).\nAdd to your JSON response: "clothingMatch": {"score": 8, "reason": "explanation"}`;
    }

    const requestBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: originalMime, data: originalBase64 } },
          { inline_data: { mime_type: avatarMime, data: avatarBase64 } },
          { text: evalPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json'
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    // Run Gemini evaluation (always) and optionally LPIPS/ArcFace (controlled by ENABLE_FACE_COMPARISON)
    // Gemini: extracts clothing, physical traits, face score
    // LPIPS: measures visual similarity (style-sensitive) - SLOW, requires Python service
    // ArcFace: measures identity preservation (style-invariant) - SLOW, requires Python service
    const geminiPromise = fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000)
      }
    );

    let lpipsResult = null;
    let arcfaceResult = null;

    if (ENABLE_FACE_COMPARISON) {
      // Run all in parallel when face comparison is enabled
      const [geminiRes, lpipsRes, arcfaceRes] = await Promise.all([
        geminiPromise,
        compareFacesLPIPS(originalPhoto, generatedAvatar, 'top-left'),
        compareIdentityArcFace(originalPhoto, generatedAvatar, 'top-left')
      ]);
      lpipsResult = lpipsRes;
      arcfaceResult = arcfaceRes;
      var geminiResponse = geminiRes;
    } else {
      // Only run Gemini when face comparison is disabled (fast path)
      var geminiResponse = await geminiPromise;
    }

    if (!geminiResponse.ok) {
      return null;
    }

    const data = await geminiResponse.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0) {
      console.log(`📊 [AVATAR EVAL] model: gemini-2.5-flash, input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    log.verbose(`🔍 [AVATAR EVAL] Raw response: ${responseText.replace(/\n\s*/g, ' ').substring(0, 200)}...`);

    // Parse JSON response (new combined format)
    try {
      const evalResult = JSON.parse(responseText);

      // Extract face match from new nested structure
      const faceMatch = evalResult.faceMatch || evalResult;
      const score = faceMatch.finalScore || evalResult.finalScore;

      // Extract physical traits (from generated avatar)
      const physicalTraits = evalResult.physicalTraits || null;

      // Extract structured clothing (from generated avatar)
      const clothing = evalResult.clothing || null;

      // Extract detailed hair analysis (from generated avatar)
      const detailedHairAnalysis = evalResult.detailedHairAnalysis || null;

      // Extract clothing match score (only present when requestedClothing was provided)
      const clothingMatch = evalResult.clothingMatch || null;

      if (typeof score === 'number' && score >= 1 && score <= 10) {
        const fm = faceMatch;
        const details = [
          `Face Shape: ${fm.faceShape?.score}/10 - ${fm.faceShape?.reason}`,
          `Forehead/Cheek/Jaw: ${fm.foreheadCheekJawline?.score ?? '?'}/10 - ${fm.foreheadCheekJawline?.reason ?? '(not scored)'}`,
          `Eyes: ${fm.eyes?.score}/10 - ${fm.eyes?.reason}`,
          `Nose: ${fm.nose?.score}/10 - ${fm.nose?.reason}`,
          `Mouth: ${fm.mouth?.score}/10 - ${fm.mouth?.reason}`,
          `Overall: ${fm.overallStructure?.score}/10 - ${fm.overallStructure?.reason}`,
          `Final Score: ${score}/10`
        ].join('\n');

        log.debug(`🔍 [AVATAR EVAL] Score: ${score}/10, traits: ${!!physicalTraits}, clothing: ${!!clothing}, hair: ${!!detailedHairAnalysis}${clothingMatch ? `, clothingMatch: ${clothingMatch.score}/10` : ''}${lpipsResult ? `, LPIPS: ${lpipsResult.lpipsScore?.toFixed(4)}` : ''}${arcfaceResult ? `, ArcFace: ${arcfaceResult.similarity?.toFixed(4)}` : ''}`);

        return { score, details, physicalTraits, clothing, clothingMatch, detailedHairAnalysis, lpips: lpipsResult, arcface: arcfaceResult, raw: evalResult };
      }
    } catch (parseErr) {
      log.warn(`[AVATAR EVAL] JSON parse failed, trying text fallback: ${parseErr.message}`);
      const scoreMatch = responseText.match(/finalScore["']?\s*:\s*(\d+)/i);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        return { score, details: responseText, physicalTraits: null, clothing: null, clothingMatch: null, lpips: lpipsResult, arcface: arcfaceResult };
      }
    }

    return null;
  } catch (err) {
    log.error('[AVATAR EVAL] Error evaluating face match:', err.message);
    return null;
  }
}

/**
 * Single shared Gemini avatar-generation call. Used by EVERY avatar code path
 * — generateDynamicAvatar (option-picker route), generateSingleAvatar inline
 * in /generate-clothing-avatars, and any future avatar caller. Eliminates the
 * ~80 lines of duplicated request-body / fetch / parse / token-extract logic
 * that existed in two places.
 *
 * Returns a result shape that lets the caller decide how to surface errors:
 *   { ok: true,  imageData, inputTokens, outputTokens }
 *   { ok: false, error,                 inputTokens, outputTokens }
 *   { ok: false, blocked: true, blockReason, inputTokens, outputTokens }   // safety filter
 *
 * @param {Object} opts
 * @param {string}  opts.geminiApiKey
 * @param {string}  opts.referenceImageBase64  base64 (no `data:` prefix)
 * @param {string}  opts.referenceMimeType     'image/jpeg' | 'image/png'
 * @param {string}  opts.prompt                full text prompt
 * @param {string}  [opts.modelId='gemini-2.5-flash-image']
 * @param {string}  [opts.aspectRatio='9:16']
 * @param {number}  [opts.temperature=0.3]
 * @param {string}  [opts.safetyThreshold='BLOCK_ONLY_HIGH']
 * @param {string}  [opts.systemInstruction]   defaults to PROMPT_TEMPLATES.avatarSystemInstruction
 * @param {string}  [opts.logTag='[AVATAR API]']
 */
async function callGeminiAvatarApi(opts) {
  const {
    geminiApiKey,
    referenceImageBase64,
    referenceMimeType = 'image/jpeg',
    prompt,
    modelId = 'gemini-2.5-flash-image',
    aspectRatio = '9:16',
    temperature = 0.3,
    safetyThreshold = 'BLOCK_ONLY_HIGH',
    systemInstruction = PROMPT_TEMPLATES.avatarSystemInstruction,
    logTag = '[AVATAR API]',
  } = opts;

  const requestBody = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{
      parts: [
        { inline_data: { mime_type: referenceMimeType, data: referenceImageBase64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: safetyThreshold },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: safetyThreshold },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: safetyThreshold },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: safetyThreshold },
    ],
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${geminiApiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) }
  );
  if (!response.ok) {
    const errorText = await response.text();
    log.error(`❌ ${logTag} HTTP ${response.status}:`, errorText);
    return { ok: false, error: `API error: ${response.status}`, inputTokens: 0, outputTokens: 0 };
  }
  const data = await response.json();
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  if (data.promptFeedback?.blockReason) {
    return { ok: false, blocked: true, blockReason: data.promptFeedback.blockReason, inputTokens, outputTokens };
  }
  let imageData = null;
  if (data.candidates?.[0]?.content?.parts) {
    for (const part of data.candidates[0].content.parts) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        break;
      }
    }
  }
  if (!imageData) return { ok: false, error: 'No image in response', inputTokens, outputTokens };
  return { ok: true, imageData, inputTokens, outputTokens };
}

/**
 * Evaluate if costume was properly applied to BOTH bottom row images in a 2x2 grid.
 * Returns { pass: boolean, reason: string, confidence: 'high'|'medium'|'low' }
 *
 * Only fails with high confidence if there's a clear mismatch (one image has costume, other doesn't).
 * Grid layout: top row = face close-ups, bottom row = full body with costume
 */
async function evaluateCostumeApplication(gridImage, costumeDescription, geminiApiKey) {
  const startTime = Date.now();
  try {
    const imageBase64 = gridImage.replace(/^data:image\/\w+;base64,/, '');
    const imageMime = gridImage.match(/^data:(image\/\w+);base64,/) ?
      gridImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const evalPrompt = `You are evaluating a 2x2 avatar grid for costume consistency.

GRID LAYOUT:
- TOP ROW (left & right): Face close-up portraits - IGNORE these for costume check
- BOTTOM ROW (left & right): Full body images that should show the character wearing a costume

EXPECTED COSTUME: ${costumeDescription}

TASK: Check if BOTH bottom row images show the expected costume.

Analyze:
1. Does the BOTTOM-LEFT image show the expected costume? (yes/no/partial)
2. Does the BOTTOM-RIGHT image show the expected costume? (yes/no/partial)
3. Are the costumes in both bottom images consistent with each other?

Return JSON:
{
  "bottomLeft": {
    "hasCostume": true/false,
    "costumeMatch": "full" | "partial" | "none" | "different_outfit",
    "description": "brief description of what they're wearing"
  },
  "bottomRight": {
    "hasCostume": true/false,
    "costumeMatch": "full" | "partial" | "none" | "different_outfit",
    "description": "brief description of what they're wearing"
  },
  "consistent": true/false,
  "pass": true/false,
  "confidence": "high" | "medium" | "low",
  "reason": "explanation"
}

IMPORTANT: Only set pass=false with confidence=high if there's a CLEAR problem:
- One image has the costume, the other has completely different clothing
- One image shows the costume, the other shows casual/default clothes
- The costumes are obviously mismatched (e.g., pirate vs superhero)

Set pass=true if:
- Both images show the expected costume (even with minor variations)
- Both images show similar costumes (slight color/detail differences are OK)
- Can't clearly see the costume details (give benefit of doubt)`;

    const requestBody = {
      contents: [{
        parts: [
          { inline_data: { mime_type: imageMime, data: imageBase64 } },
          { text: evalPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2000,
        responseMimeType: 'application/json'
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(20000)
      }
    );

    if (!response.ok) {
      log.warn(`[COSTUME EVAL] API error: ${response.status}`);
      return { pass: true, reason: 'Evaluation failed, giving benefit of doubt', confidence: 'low' };
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const finishReason = data.candidates?.[0]?.finishReason;

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const duration = Date.now() - startTime;
    console.log(`📊 [COSTUME EVAL] input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}, ${duration}ms`);

    // Check for truncated response
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`[COSTUME EVAL] Response truncated (finishReason: ${finishReason}), giving benefit of doubt`);
      return { pass: true, reason: `Response truncated: ${finishReason}`, confidence: 'low' };
    }

    // Check for empty response
    if (!responseText) {
      log.warn(`[COSTUME EVAL] Empty response from API`);
      return { pass: true, reason: 'Empty response, giving benefit of doubt', confidence: 'low' };
    }

    try {
      const result = JSON.parse(responseText);

      log.debug(`👔 [COSTUME EVAL] Bottom-left: ${result.bottomLeft?.costumeMatch} (${result.bottomLeft?.description})`);
      log.debug(`👔 [COSTUME EVAL] Bottom-right: ${result.bottomRight?.costumeMatch} (${result.bottomRight?.description})`);
      log.debug(`👔 [COSTUME EVAL] Result: pass=${result.pass}, confidence=${result.confidence}, reason=${result.reason}`);

      return {
        pass: result.pass !== false, // Default to pass if not explicitly false
        reason: result.reason || 'No reason provided',
        confidence: result.confidence || 'medium',
        details: {
          bottomLeft: result.bottomLeft,
          bottomRight: result.bottomRight,
          consistent: result.consistent
        }
      };
    } catch (parseErr) {
      // Log the raw response for debugging (truncated for log readability)
      const truncatedResponse = responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText;
      log.warn(`[COSTUME EVAL] JSON parse failed: ${parseErr.message}. Response: ${truncatedResponse}`);
      return { pass: true, reason: 'Parse error, giving benefit of doubt', confidence: 'low' };
    }
  } catch (err) {
    log.error('[COSTUME EVAL] Error:', err.message);
    return { pass: true, reason: 'Evaluation error, giving benefit of doubt', confidence: 'low' };
  }
}

/**
 * Get clothing style prompt for a given category and gender
 */
function getClothingStylePrompt(category, isFemale) {
  const template = PROMPT_TEMPLATES.avatarMainPrompt || '';
  const styleSection = template.split('CLOTHING_STYLES:')[1] || '';

  let tag;
  if (category === 'winter') {
    tag = isFemale ? '[WINTER_FEMALE]' : '[WINTER_MALE]';
  } else if (category === 'standard') {
    tag = isFemale ? '[STANDARD_FEMALE]' : '[STANDARD_MALE]';
  } else if (category === 'summer') {
    tag = isFemale ? '[SUMMER_FEMALE]' : '[SUMMER_MALE]';
  } else {
    return 'Full outfit with shoes matching the style of the reference.';
  }

  const tagIndex = styleSection.indexOf(tag);
  if (tagIndex === -1) {
    return 'Full outfit with shoes matching the style of the reference.';
  }

  const afterTag = styleSection.substring(tagIndex + tag.length);
  const nextTagIndex = afterTag.search(/\n\[/);
  const styleText = nextTagIndex === -1 ? afterTag : afterTag.substring(0, nextTagIndex);

  return styleText.trim();
}

/**
 * Get clothing style prompt from ACE++ template (shorter, optimized version)
 */
function getClothingStylePromptFromAce(category, isFemale, aceTemplate) {
  const styleSection = aceTemplate.split('CLOTHING_STYLES:')[1] || '';

  let tag;
  if (category === 'winter') {
    tag = isFemale ? '[WINTER_FEMALE]' : '[WINTER_MALE]';
  } else if (category === 'standard') {
    tag = isFemale ? '[STANDARD_FEMALE]' : '[STANDARD_MALE]';
  } else if (category === 'summer') {
    tag = isFemale ? '[SUMMER_FEMALE]' : '[SUMMER_MALE]';
  } else {
    return 'Casual comfortable outfit matching reference clothing style.';
  }

  const tagIndex = styleSection.indexOf(tag);
  if (tagIndex === -1) {
    return 'Casual comfortable outfit matching reference clothing style.';
  }

  const afterTag = styleSection.substring(tagIndex + tag.length);
  const nextTagIndex = afterTag.search(/\n\[/);
  const styleText = nextTagIndex === -1 ? afterTag : afterTag.substring(0, nextTagIndex);

  return styleText.trim();
}

/**
 * Build clothing prompt for dynamic avatar generation
 * Handles signature items (additions to base) and full costume descriptions
 *
 * @param {string} category - 'standard', 'winter', 'summer', or 'costumed'
 * @param {Object} config - { signature?: string, costume?: string, description?: string }
 * @param {boolean} isFemale - Whether character is female
 * @returns {string} - Clothing prompt for avatar generation
 */
function getDynamicClothingPrompt(category, config, isFemale) {
  // For costumed: use full costume description
  if (category === 'costumed' && config.description) {
    const costumeType = config.costume || 'costume';
    return `FULL COSTUME TRANSFORMATION - ${costumeType.toUpperCase()}:
${config.description}

This is a COMPLETE outfit change. The character wears this entire costume from head to toe.
Include ALL costume elements: headwear, shirt/top, pants/skirt/dress, footwear, and any accessories mentioned.
The costume should look authentic and age-appropriate for a children's book illustration.`;
  }

  // For standard/winter/summer: use base prompt + optional signature items
  const basePrompt = getClothingStylePrompt(category, isFemale);

  if (config.signature) {
    return `${basePrompt}

SIGNATURE ITEMS (MUST INCLUDE these specific elements):
${config.signature}

These signature items are essential to the character's look in this story.
Add them to the base outfit described above. They should be prominently visible.`;
  }

  // No signature - just use base prompt
  return basePrompt;
}

/**
 * Generate a single avatar with dynamic clothing requirements
 * Called internally from story generation flow
 *
 * @param {Object} character - Character object with photoUrl, physicalTraits, etc.
 * @param {string} category - 'standard', 'winter', 'summer', or 'costumed'
 * @param {Object} config - { signature?: string, costume?: string, description?: string }
 * @returns {Promise<Object>} - { success, imageData, clothing, error? }
 */
async function generateDynamicAvatar(character, category, config) {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log.error('[DYNAMIC AVATAR] No Gemini API key available');
    return { success: false, error: 'Avatar generation service unavailable' };
  }

  const facePhoto = getFacePhoto(character);
  if (!facePhoto) {
    log.error(`[DYNAMIC AVATAR] No face photo for ${character.name}`);
    return { success: false, error: 'No face photo available' };
  }

  const isFemale = character.gender === 'female';
  const costumeType = category === 'costumed' ? (config.costume || 'costume').toLowerCase() : null;
  const logCategory = costumeType ? `costumed:${costumeType}` : category;

  log.debug(`🎭 [DYNAMIC AVATAR] Generating ${logCategory} avatar for ${character.name}`);

  try {
    // Fail-fast if prompt templates aren't loaded. Without this guard we used
    // to JSON.stringify `text: undefined` → Gemini received parts:[{}] → 400
    // "system_instruction.parts[0].data: required oneof field 'data' must
    // have one initialized field". The 400 looked unrelated; the real cause
    // was a missing prompt file silently swallowed by the prompt loader.
    if (!PROMPT_TEMPLATES.avatarMainPrompt || !PROMPT_TEMPLATES.avatarSystemInstruction) {
      const missing = [
        !PROMPT_TEMPLATES.avatarMainPrompt && 'avatarMainPrompt',
        !PROMPT_TEMPLATES.avatarSystemInstruction && 'avatarSystemInstruction',
      ].filter(Boolean).join(', ');
      log.error(`[DYNAMIC AVATAR] Prompt templates not loaded: ${missing} — refusing to call Gemini`);
      return { success: false, error: `Avatar prompt templates not loaded: ${missing}` };
    }
    // Build the prompt
    const promptPart = PROMPT_TEMPLATES.avatarMainPrompt.split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingPrompt = getDynamicClothingPrompt(category, config, isFemale);
    const avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingPrompt
    });

    // Prepare image data - keep 768px for quality, only convert format
    const photoSizeKB = Math.round(facePhoto.length / 1024);
    log.debug(`🎭 [DYNAMIC AVATAR] Input photo: ${photoSizeKB}KB`);

    const sharp = require('sharp');
    const base64Input = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const resizedPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.debug(`🎭 [DYNAMIC AVATAR] Prepared: ${Math.round(resizedPhoto.length / 1024)}KB (was ${photoSizeKB}KB)`);

    const result = await callGeminiAvatarApi({
      geminiApiKey,
      referenceImageBase64: resizedPhoto.replace(/^data:image\/\w+;base64,/, ''),
      referenceMimeType: 'image/jpeg',
      prompt: avatarPrompt,
      logTag: `[DYNAMIC AVATAR] ${logCategory}`,
    });
    if (result.inputTokens > 0 || result.outputTokens > 0) {
      console.log(`📊 [DYNAMIC AVATAR] ${logCategory} - input: ${result.inputTokens.toLocaleString()}, output: ${result.outputTokens.toLocaleString()}`);
    }
    if (result.blocked) {
      log.warn(`[DYNAMIC AVATAR] ${logCategory} blocked by safety filters: ${result.blockReason}`);
      return { success: false, error: `Blocked by safety filters: ${result.blockReason}` };
    }
    if (!result.ok) {
      return { success: false, error: result.error || 'Gemini avatar call failed' };
    }
    const imageData = result.imageData;

    // Compress the avatar
    const compressed = await compressImageToJPEG(imageData, 85, 768);
    const finalImageData = compressed || imageData;

    // Evaluate face match to get clothing description (optional)
    let clothingDescription = null;
    if (ENABLE_AVATAR_EVALUATION) {
      const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, finalImageData, geminiApiKey);
      if (faceMatchResult?.clothing) {
        clothingDescription = faceMatchResult.clothing;
        log.debug(`👕 [DYNAMIC AVATAR] ${logCategory} clothing: ${clothingDescription}`);
      }
    }

    log.debug(`✅ [DYNAMIC AVATAR] Generated ${logCategory} avatar for ${character.name}`);

    return {
      success: true,
      imageData: finalImageData,
      clothing: clothingDescription,
      signature: config.signature || null,
      costumeType: costumeType
    };

  } catch (err) {
    log.error(`❌ [DYNAMIC AVATAR] Error generating ${logCategory}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Load art style prompts from prompts/art-styles.txt
 */
function loadArtStylePrompts() {
  const fs = require('fs');
  const artStylesPath = require('path').join(__dirname, '../../prompts/art-styles.txt');
  const prompts = {};
  try {
    const content = fs.readFileSync(artStylesPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
          const styleId = trimmed.substring(0, colonIndex).trim();
          const prompt = trimmed.substring(colonIndex + 1).trim();
          prompts[styleId] = prompt;
        }
      }
    }
  } catch (err) {
    log.error(`[AVATARS] Failed to load art-styles.txt:`, err.message);
  }
  return prompts;
}

const ART_STYLE_PROMPTS = loadArtStylePrompts();

/**
 * Build physical traits string for avatar prompts
 * Uses detailed hair analysis from storyHelpers for accurate hair description
 * @param {Object} character - Character object with physical traits
 * @returns {string} Physical traits description
 */
function buildPhysicalTraitsForAvatar(character) {
  const traits = character?.physical || {};
  const parts = [];

  // Age and body proportions (CRITICAL for correct head-to-body ratio)
  // Priority: apparentAge from avatar analysis > computed from numeric age
  const apparentAge = traits.apparentAge || (character?.age ? getAgeCategory(character.age) : null);
  log.debug(`[AVATAR TRAITS] ${character?.name}: apparentAge=${apparentAge} (from ${traits.apparentAge ? 'physical.apparentAge' : 'computed from age ' + character?.age})`);
  if (apparentAge) {
    parts.push(`Age: ${apparentAge}`);
    // Add explicit head-to-body ratio guidance based on age
    const ageStr = String(apparentAge).toLowerCase();

    // Try to extract numeric age first
    const numericAge = parseInt(ageStr.match(/\d+/)?.[0] || '', 10);
    let ratio = '8 heads tall (adult proportions)';

    if (!isNaN(numericAge)) {
      // Use numeric age for precise matching
      if (numericAge <= 1) {
        ratio = '4 heads tall (infant proportions)';
      } else if (numericAge <= 3) {
        ratio = '5 heads tall (toddler proportions)';
      } else if (numericAge <= 6) {
        ratio = '5.5 heads tall (young child proportions)';
      } else if (numericAge <= 10) {
        ratio = '6 heads tall (child proportions)';
      } else if (numericAge <= 12) {
        ratio = '6.5 heads tall (preteen proportions)';
      } else if (numericAge <= 17) {
        ratio = '7 heads tall (teen proportions)';
      }
      // 18+ defaults to adult (8 heads)
    } else {
      // Fallback to category name matching for non-numeric values
      if (ageStr.includes('infant') || ageStr.includes('baby')) {
        ratio = '4 heads tall (infant proportions)';
      } else if (ageStr.includes('toddler')) {
        ratio = '5 heads tall (toddler proportions)';
      } else if (ageStr.includes('preschool') || ageStr.includes('kindergart')) {
        ratio = '5.5 heads tall (young child proportions)';
      } else if (ageStr.includes('school-age') || ageStr.includes('school age')) {
        ratio = '6 heads tall (child proportions)';
      } else if (ageStr.includes('preteen')) {
        ratio = '6.5 heads tall (preteen proportions)';
      } else if (ageStr.includes('teen') && !ageStr.includes('preteen')) {
        ratio = '7 heads tall (teen proportions)';
      }
    }
    parts.push(`Body proportions: ${ratio}`);
  }

  // Build/height
  if (traits.height) parts.push(`Height: ${traits.height}`);
  if (traits.build) parts.push(`Build: ${traits.build}`);

  // Use detailed hair description from storyHelpers (handles detailedHairAnalysis)
  const hairDesc = buildHairDescription(traits, character?.physicalTraitsSource);
  if (hairDesc) parts.push(`Hair: ${hairDesc}`);

  if (traits.eyeColor) parts.push(`Eye color: ${traits.eyeColor}`);
  if (traits.facialHair && traits.facialHair !== 'none') {
    if (traits.facialHair.toLowerCase() === 'clean-shaven') {
      parts.push(`Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face`);
    } else {
      parts.push(`Facial hair: ${traits.facialHair}`);
    }
  }
  if (traits.skinTone) parts.push(`Skin tone: ${traits.skinTone}`);
  if (traits.glasses && String(traits.glasses).trim().toLowerCase() !== 'none') {
    parts.push(`Glasses: ${traits.glasses} — ALWAYS visible on the face`);
  }
  if (traits.other && traits.other !== 'none') {
    parts.push(`Other features: ${traits.other}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'Match reference photo exactly';
}


// ============================================================================
// ROUTES
// ============================================================================

/**
 * POST /api/analyze-photo
 * Analyze a photo to detect face and body (Python service)
 * Supports multi-face detection - if multiple faces found, returns thumbnails for selection
 * Physical traits are now extracted during avatar evaluation, not here
 */
router.post('/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData, selectedFaceId, cachedFaces, existingCharacterId } = req.body;

    if (!imageData) {
      log.debug('📸 [PHOTO] Missing imageData in request');
      return res.status(400).json({ error: 'Missing imageData' });
    }

    const imageSize = imageData.length;
    const imageType = imageData.substring(0, 30);
    log.debug(`📸 [PHOTO] Received image: ${imageSize} bytes, type: ${imageType}..., selectedFaceId: ${selectedFaceId}, cachedFaces: ${cachedFaces ? cachedFaces.length : 'none'}`);

    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`📸 [PHOTO] Calling Python service at: ${photoAnalyzerUrl}/analyze`);

    const startTime = Date.now();

    try {
      // Call Python service with optional selectedFaceId and cachedFaces
      // cachedFaces prevents re-detection (face IDs are unstable between calls)
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageData,
          selected_face_id: selectedFaceId !== undefined ? selectedFaceId : null,
          cached_faces: cachedFaces || null
        }),
        signal: AbortSignal.timeout(30000)
      });
      if (!analyzerResponse.ok) {
        const text = await analyzerResponse.text().catch(() => '');
        log.error(`📸 [PHOTO] Python analyzer HTTP ${analyzerResponse.status}: ${text.substring(0, 200)}`);
        return res.status(502).json({ error: 'Photo analysis service error', details: `HTTP ${analyzerResponse.status}` });
      }
      const analyzerData = await analyzerResponse.json();

      const duration = Date.now() - startTime;

      log.debug(`📸 [PHOTO] Analysis complete in ${duration}ms:`, {
        pythonSuccess: analyzerData.success,
        hasError: !!analyzerData.error,
        error: analyzerData.error || null,
        multipleFacesDetected: analyzerData.multiple_faces_detected,
        faceCount: analyzerData.face_count,
        hasFaceThumbnail: !!analyzerData.faceThumbnail || !!analyzerData.face_thumbnail,
        hasBodyCrop: !!analyzerData.bodyCrop || !!analyzerData.body_crop,
        hasBodyNoBg: !!analyzerData.bodyNoBg || !!analyzerData.body_no_bg,
        traceback: analyzerData.traceback ? analyzerData.traceback.substring(0, 500) : null
      });

      if (!analyzerData.success) {
        if (analyzerData.error === 'no_face_detected') {
          log.warn('📸 [PHOTO] No face detected in photo');
          return res.json({
            success: false,
            error: 'no_face_detected'
          });
        }
        log.error('📸 [PHOTO] Python analysis failed:', analyzerData.error, analyzerData.traceback);
        return res.status(500).json({
          error: 'Photo analysis failed',
          details: analyzerData.error || 'Unknown error',
          traceback: analyzerData.traceback
        });
      }

      // Handle multi-face response - return faces for selection
      if (analyzerData.multiple_faces_detected && analyzerData.faces) {
        log.info(`📸 [PHOTO] Multiple faces detected (${analyzerData.face_count}), returning for selection`);

        // Convert faces to camelCase (handle both old snake_case and new camelCase from Python)
        const faces = analyzerData.faces.map(face => ({
          id: face.id,
          confidence: face.confidence,
          faceBox: face.faceBox || face.face_box,
          thumbnail: face.thumbnail
        }));

        return res.json({
          success: true,
          multipleFacesDetected: true,
          faceCount: analyzerData.face_count,
          faces: faces
        });
      }

      // Single face or face selected - return normal response
      await logActivity(req.user.id, req.user.username, 'PHOTO_ANALYZED', {
        hasFace: !!analyzerData.face_thumbnail || !!analyzerData.faceThumbnail,
        hasBody: !!analyzerData.body_crop || !!analyzerData.bodyCrop,
        faceCount: analyzerData.face_count,
        selectedFaceId: selectedFaceId
      });

      // Create or update character in database immediately so avatar job can find it later
      // If existingCharacterId provided, update that character (photo re-upload)
      // Otherwise create new character
      const isReupload = existingCharacterId && typeof existingCharacterId === 'number' && existingCharacterId > 0;
      const characterId = isReupload ? existingCharacterId : Date.now();
      const faceThumbnail = analyzerData.face_thumbnail || analyzerData.faceThumbnail;
      const bodyCrop = analyzerData.body_crop || analyzerData.bodyCrop;
      const bodyNoBg = analyzerData.body_no_bg || analyzerData.bodyNoBg;

      try {
        const rowId = `characters_${req.user.id}`;

        // Use transaction with FOR UPDATE to prevent race with avatar job writes
        await dbQuery('BEGIN');

        // Get existing characters for this user (locked)
        const existingResult = await dbQuery(
          'SELECT data FROM characters WHERE id = $1 FOR UPDATE',
          [rowId]
        );

        let charData = existingResult.length > 0 ? (existingResult[0].data || {}) : {};
        let characters = charData.characters || [];

        // Build photos object (new structure used by frontend)
        const photosObj = {
          face: faceThumbnail,
          original: imageData,
          bodyNoBg: bodyNoBg,
          body: bodyCrop
        };

        if (isReupload) {
          // Update existing character's photo data (don't create new)
          const charIndex = characters.findIndex(c => c.id === characterId);
          if (charIndex >= 0) {
            // Write only to canonical photos.* structure (normalized format)
            characters[charIndex].photos = photosObj;
            // Remove legacy fields if they exist (cleanup)
            delete characters[charIndex].photo_url;
            delete characters[charIndex].thumbnail_url;
            delete characters[charIndex].body_photo_url;
            delete characters[charIndex].body_no_bg_url;
            // Mark avatars as stale, but PRESERVE existing avatar images
            // This prevents data loss if avatar generation fails
            if (characters[charIndex].avatars) {
              characters[charIndex].avatars.stale = true;
              characters[charIndex].avatars.status = 'pending';
            } else {
              characters[charIndex].avatars = { status: 'pending', stale: true };
            }
            log.info(`📸 [PHOTO] Updated existing character ${characterId} with new photo for user ${req.user.id}`);
          } else {
            // Character not in DB yet (wizard hasn't saved) — create a minimal entry
            // so the avatar job can find it later
            log.warn(`📸 [PHOTO] Existing character ${characterId} not found in DB — creating placeholder entry`);
            const newCharacter = {
              id: characterId,
              name: '',  // Will be filled when wizard saves
              gender: undefined,
              age: '',
              photos: photosObj,
              physical: {},
              avatars: { status: 'pending' },
              traits: { strengths: [], flaws: [], challenges: [], specialDetails: '' }
            };
            characters.push(newCharacter);
          }
        } else {
          // Create new character with photo data
          // Write only to canonical photos.* and traits.* structure (normalized format)
          const newCharacter = {
            id: characterId,
            name: '',  // User will fill in later
            gender: undefined,
            age: '',
            photos: photosObj,
            physical: {},  // Will be populated during avatar evaluation
            avatars: { status: 'pending' },
            traits: { strengths: [], flaws: [], challenges: [], specialDetails: '' }
          };

          characters.push(newCharacter);
          log.info(`📸 [PHOTO] Created new character ${characterId} in database for user ${req.user.id}`);
        }

        charData.characters = characters;

        // Build lightweight metadata (matching POST route format)
        // Must include all display fields - not just id/name
        const lightCharacters = characters.map(char => {
          const { body_no_bg_url, body_photo_url, photo_url, thumbnail_url, clothing_avatars, photos, ...lightChar } = char;
          if (lightChar.avatars) {
            // Dual-shape (Phase 1 migration): NEW `faceThumb.standard` wins,
            // OLD `faceThumbnailsUrl.standard` / `faceThumbnails.standard` fall back.
            // hasFullAvatars also probes both shapes.
            const av = lightChar.avatars;
            const standardThumb = av.faceThumb?.standard
              || av.faceThumbnailsUrl?.standard
              || av.faceThumbnails?.standard;
            lightChar.avatars = {
              status: av.status,
              stale: av.stale,
              generatedAt: av.generatedAt,
              hasFullAvatars: !!(av.winter || av.standard || av.summer
                || av.winterUrl || av.standardUrl || av.summerUrl),
              faceThumbnails: standardThumb ? { standard: standardThumb } : undefined,
              clothing: av.clothing
            };
          }
          return lightChar;
        });
        const metadataObj = Array.isArray(charData) ? lightCharacters : { ...charData, characters: lightCharacters };

        // Upsert the characters row
        await dbQuery(`
          INSERT INTO characters (id, user_id, data, metadata)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET data = $3, metadata = $4
        `, [rowId, req.user.id, JSON.stringify(charData), JSON.stringify(metadataObj)]);

        await dbQuery('COMMIT');
      } catch (dbErr) {
        // Rollback on any error
        try { await dbQuery('ROLLBACK'); } catch (_) { /* ignore */ }
        // Log but don't fail - character creation is a nice-to-have
        log.warn(`📸 [PHOTO] Failed to create character in DB (avatar job will retry): ${dbErr.message}`);
      }

      // Convert snake_case to camelCase for frontend compatibility
      const response = {
        success: analyzerData.success,
        multipleFacesDetected: false,
        faceCount: analyzerData.face_count,
        selectedFaceId: analyzerData.selected_face_id,
        characterId: characterId,  // Return the new character ID
        faceThumbnail: faceThumbnail,
        bodyCrop: bodyCrop,
        bodyNoBg: bodyNoBg,
        faceBox: analyzerData.face_box || analyzerData.faceBox,
        bodyBox: analyzerData.body_box || analyzerData.bodyBox
      };

      log.debug('📸 [PHOTO] Sending response (face/body detection) with characterId:', characterId);
      res.json(response);

    } catch (fetchErr) {
      log.error('Photo analyzer service error:', fetchErr.message);

      if (fetchErr.cause?.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'Photo analysis service unavailable',
          details: 'The photo analysis service is not running. Please contact support.',
          fallback: true
        });
      }

      throw fetchErr;
    }

  } catch (err) {
    log.error('Error analyzing photo:', err);
    res.status(500).json({
      error: 'Failed to analyze photo',
      details: err.message,
      fallback: true
    });
  }
});

/**
 * GET /api/avatar-prompt
 * Get the avatar generation prompt for a given category and gender (for developer mode)
 */
router.get('/avatar-prompt', authenticateToken, async (req, res) => {
  try {
    const { category, gender } = req.query;
    const isFemale = gender === 'female';

    // Build the prompt from template
    const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingStyle = getClothingStylePrompt(category, isFemale);
    const avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingStyle
    });

    res.json({ success: true, prompt: avatarPrompt });
  } catch (error) {
    log.error('Error getting avatar prompt:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/generate-avatar-options
 * Generate 3 avatar options for user to choose from
 */
router.post('/generate-avatar-options', authenticateToken, async (req, res) => {
  try {
    const { facePhoto, gender, category = 'standard' } = req.body;

    if (!facePhoto) {
      return res.status(400).json({ error: 'Missing facePhoto' });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    log.debug(`🎭 [AVATAR OPTIONS] Generating 3 options for ${gender}...`);

    const character = {
      photoUrl: facePhoto,
      gender: gender,
      name: 'temp'
    };
    const config = {};

    // Generate 3 attempts sequentially with 5s delay between requests
    const options = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      const result = await generateDynamicAvatar(character, category, config);
      if (result.success) {
        options.push({ id: i, imageData: result.imageData });
      }
    }

    log.debug(`✅ [AVATAR OPTIONS] Generated ${options.length}/3 options`);

    return res.json({
      success: true,
      options: options
    });

  } catch (err) {
    log.error('❌ [AVATAR OPTIONS] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Process avatar generation in the background (for async mode)
 * This function is called without awaiting, so it runs after the response is sent
 */
async function processAvatarJobInBackground(jobId, bodyParams, user, geminiApiKey) {
  const job = avatarJobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'processing';
    job.message = 'Generating avatars...';
    job.progress = 10;

    // `referencePhoto` is the bg-removed body photo with the user's clothing
    // visible — what Grok edits to apply the seasonal outfit.
    // `facePhoto` is the separate high-res face crop the Python service
    // produced. We send both as Grok edit references: the body anchors
    // outfit/pose, the face anchors identity (eyes/hair/skin) at full
    // resolution since the face is tiny in the body crop.
    const { characterId, facePhoto, physicalDescription, name, age, apparentAge, gender, build, physicalTraits, clothing, avatarModel } = bodyParams;

    // Mirror the sync endpoint's normalization (see /api/avatars/generate):
    // referencePhoto is the bg-removed body photo, but the trial account-claim
    // path only carries a face crop — fall back to facePhoto so it isn't undefined.
    const referencePhoto = bodyParams.referencePhoto || facePhoto;
    if (!referencePhoto) {
      throw new Error(`[AVATAR JOB ${jobId}] No referencePhoto or facePhoto provided`);
    }

    // Import the actual generation logic (reuse from sync path)
    // For now, we'll make a simplified version that calls the same helpers

    const selectedModel = avatarModel || MODEL_DEFAULTS.avatar || 'grok-imagine';
    const modelConfig = IMAGE_MODELS[selectedModel];
    const useRunware = modelConfig?.backend === 'runware' || selectedModel === 'flux-schnell';
    const useGrok = modelConfig?.backend === 'grok';
    const geminiModelId = modelConfig?.modelId || 'gemini-2.5-flash-image';
    const isFemale = gender === 'female';

    log.debug(`👔 [AVATAR JOB ${jobId}] Starting background generation for ${name || 'unnamed'} (id: ${characterId}), model: ${selectedModel}, backend: ${useGrok ? 'grok' : useRunware ? 'runware' : 'gemini'}`);

    const clothingCategories = {
      winter: { emoji: '❄️' },
      standard: { emoji: '👕' },
      summer: { emoji: '☀️' }
    };

    const results = {
      status: 'generating',
      generatedAt: null,
      faceMatch: {},
      clothing: {},
      structuredClothing: {},
      extractedTraits: null,
      rawEvaluation: null,
      prompts: {},
      tokenUsage: { byModel: {} }  // Track token usage for cost metrics
    };

    // Log photo info
    const photoSizeKB = Math.round(referencePhoto.length / 1024);
    log.info(`[AVATAR JOB ${jobId}] 📸 Input reference photo: ${photoSizeKB}KB`);

    // Resize to 768px so Grok/Gemini get a consistent input size.
    // bytesFromAnyImage handles all the input shapes (HTTPS URL after R2 migration,
    // data: URI, raw base64). Doing Buffer.from(url, 'base64') on a URL produces
    // garbage bytes and sharp throws "Input buffer contains unsupported image format".
    const sharp = require('sharp');
    const r2 = require('../lib/r2');
    const inputBuffer = await r2.bytesFromAnyImage(referencePhoto);
    if (!inputBuffer) throw new Error(`Could not load reference photo (got ${typeof referencePhoto}, len=${referencePhoto?.length})`);
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const finalPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.info(`[AVATAR JOB ${jobId}] Prepared reference photo: ${Math.round(finalPhoto.length / 1024)}KB (was ${photoSizeKB}KB)`);
    const base64Data = finalPhoto.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = finalPhoto.match(/^data:(image\/\w+);base64,/) ?
      finalPhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build user clothing section
    let userClothingSection = '';
    if (clothing) {
      const clothingParts = [];
      if (clothing.fullBody) {
        clothingParts.push(`Full outfit: ${clothing.fullBody}`);
      } else {
        if (clothing.upperBody) clothingParts.push(`Top: ${clothing.upperBody}`);
        if (clothing.lowerBody) clothingParts.push(`Bottom: ${clothing.lowerBody}`);
      }
      if (clothing.shoes) clothingParts.push(`Shoes: ${clothing.shoes}`);
      if (clothing.accessories) clothingParts.push(`Accessories: ${clothing.accessories}`);
      if (clothingParts.length > 0) {
        userClothingSection = `\n\nUSER-SPECIFIED CLOTHING (MUST USE - override default clothing style):\n${clothingParts.join('\n')}\nIMPORTANT: Use the user-specified clothing above instead of the default clothing style.`;
      }
    }

    // Build user traits section
    let userTraitsSection = '';
    if (physicalTraits && Object.keys(physicalTraits).length > 0) {
      const traitLines = [];
      if (physicalTraits.hairColor) traitLines.push(`- Hair color: ${physicalTraits.hairColor}`);
      if (physicalTraits.eyeColor) traitLines.push(`- Eye color: ${physicalTraits.eyeColor}`);
      // Hair shape/length from detailedHairAnalysis (single source of truth).
      const hairDesc = buildHairDescription(physicalTraits);
      if (hairDesc) traitLines.push(`- Hair: ${hairDesc}`);
      if (physicalTraits.build) traitLines.push(`- Body build: ${physicalTraits.build}`);
      if (physicalTraits.skinTone) traitLines.push(`- Skin tone: ${physicalTraits.skinTone}`);
      if (physicalTraits.face) traitLines.push(`- Face shape: ${physicalTraits.face}`);
      if (physicalTraits.facialHair) {
        if (physicalTraits.facialHair.toLowerCase() === 'clean-shaven') {
          traitLines.push(`- Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face`);
        } else if (physicalTraits.facialHair.toLowerCase() !== 'none') {
          traitLines.push(`- Facial hair: ${physicalTraits.facialHair}`);
        }
      }
      if (physicalTraits.glasses && String(physicalTraits.glasses).trim().toLowerCase() !== 'none') {
        traitLines.push(`- Glasses: ${physicalTraits.glasses} — ALWAYS visible on the face`);
      }
      if (physicalTraits.other) traitLines.push(`- Other: ${physicalTraits.other}`);
      if (traitLines.length > 0) {
        userTraitsSection = `\n\nPHYSICAL TRAIT CORRECTIONS (CRITICAL - MUST APPLY):\n${traitLines.join('\n')}`;
      }
    }

    job.progress = 20;
    job.message = 'Generating winter, standard, summer avatars...';

    // Generate avatars (simplified - uses Gemini API directly)
    const generationStart = Date.now();

    // Helper to generate single avatar with the selected backend (Grok / Gemini / Runware).
    // Grok is the default — Gemini's safety filter rejects adult-face photos with
    // IMAGE_OTHER; Grok's edit endpoint handles the same photos cleanly.
    const generateSingleAvatarForJob = async (category) => {
      const MAX_RETRIES = 2; // Total attempts = MAX_RETRIES + 1 = 3
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      try {
        const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
        const clothingStylePrompt = getClothingStylePrompt(category, isFemale);
        let avatarPrompt = fillTemplate(promptPart, { 'CLOTHING_STYLE': clothingStylePrompt });

        if (userClothingSection && category === 'standard') {
          avatarPrompt += userClothingSection;
        }
        if (userTraitsSection) {
          avatarPrompt += userTraitsSection;
        }

        // Grok branch — edit endpoint with face photo as reference.
        if (useGrok) {
          log.info(`[AVATAR JOB ${jobId}] 🎨 Generating ${category} via Grok (${selectedModel})`);
          for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
              log.info(`[AVATAR JOB ${jobId}] 🔄 Retry ${attempt}/${MAX_RETRIES} for ${category} (Grok)...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            try {
              // Send body AND face crop as references. Body anchors outfit/pose,
              // face provides identity at full resolution (the face area in the
              // body crop is tiny — ~100px in a 432-wide canvas — too small for
              // Grok to faithfully replicate in the face-dominant top quadrants).
              const grokRefs = facePhoto ? [finalPhoto, facePhoto] : [finalPhoto];
              const result = await editWithGrok(avatarPrompt, grokRefs, {
                aspectRatio: '9:16',
                resolution: '1k',
                model: modelConfig?.modelId || 'grok-imagine-image',
                padInput: true,  // Body cutout is on white bg already; pad instead
                                 // of crop so the face isn't sliced off the top.
              });
              if (result?.imageData) {
                const compressedImage = await compressImageToJPEG(result.imageData);
                if (attempt > 0) {
                  log.info(`[AVATAR JOB ${jobId}] ✅ ${category} succeeded on Grok retry ${attempt}`);
                }
                return { category, imageData: compressedImage, prompt: avatarPrompt, inputTokens: 0, outputTokens: 0 };
              }
            } catch (grokErr) {
              log.warn(`[AVATAR JOB ${jobId}] Grok ${category} attempt ${attempt + 1} failed: ${grokErr.message}`);
              if (attempt >= MAX_RETRIES) {
                return { category, imageData: null, prompt: avatarPrompt, inputTokens: 0, outputTokens: 0 };
              }
            }
          }
          return { category, imageData: null, prompt: avatarPrompt, inputTokens: 0, outputTokens: 0 };
        }

        // Build request body matching the sync CLOTHING AVATARS path
        const requestBody = {
          systemInstruction: {
            parts: [{
              text: PROMPT_TEMPLATES.avatarSystemInstruction
            }]
          },
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              },
              { text: avatarPrompt }
            ]
          }],
          generationConfig: {
            temperature: 0.3,
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16"
            }
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
          ]
        };

        // Log prompt for debugging IMAGE_OTHER issue
        log.info(`[AVATAR JOB ${jobId}] 🔍 Prompt for ${category} (${avatarPrompt.length} chars)`);
        log.info(`[AVATAR JOB ${jobId}] 🔍 System instruction present: ${!!PROMPT_TEMPLATES.avatarSystemInstruction} (${PROMPT_TEMPLATES.avatarSystemInstruction?.length || 0} chars)`);
        log.info(`[AVATAR JOB ${jobId}] 🔍 Photo: ${base64Data.length} chars, mime: ${mimeType}`);

        // Retry loop for IMAGE_OTHER failures
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          if (attempt > 0) {
            log.info(`[AVATAR JOB ${jobId}] 🔄 Retry ${attempt}/${MAX_RETRIES} for ${category} after IMAGE_OTHER...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
          }

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${geminiApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            }
          );

          const data = await response.json();
          let imageData = null;

          // Extract token usage from response
          const inputTokens = data.usageMetadata?.promptTokenCount || 0;
          const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;

          // Log API response status for debugging
          if (!response.ok) {
            log.error(`[AVATAR JOB ${jobId}] Gemini API error for ${category}: ${response.status} ${response.statusText}`);
            log.error(`[AVATAR JOB ${jobId}] Response body:`, JSON.stringify(data).substring(0, 500));

            // Check if this is a retryable error (503 model overloaded, 429 rate limit)
            const isRetryableHttpError = response.status === 503 || response.status === 429;
            if (isRetryableHttpError && attempt < MAX_RETRIES) {
              log.info(`[AVATAR JOB ${jobId}] 🔄 Will retry ${category} after ${response.status} error...`);
              continue; // Go to next attempt in the retry loop
            }

            return { category, imageData: null, prompt: avatarPrompt, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
          }

          if (data.candidates && data.candidates[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              // Handle both camelCase (inlineData) and snake_case (inline_data) - Gemini API varies
              const inlineData = part.inlineData || part.inline_data;
              if (inlineData && inlineData.data) {
                const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
                imageData = `data:${respMimeType};base64,${inlineData.data}`;
                break;
              }
            }
          }

          // Success - return the image
          if (imageData) {
            if (attempt > 0) {
              log.info(`[AVATAR JOB ${jobId}] ✅ ${category} succeeded on retry ${attempt}`);
            }
            const compressedImage = await compressImageToJPEG(imageData);
            return { category, imageData: compressedImage, prompt: avatarPrompt, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
          }

          // No image - check if it's IMAGE_OTHER (retryable) or something else
          const finishReason = data.candidates?.[0]?.finishReason;
          const isImageOther = finishReason === 'IMAGE_OTHER';

          if (!isImageOther || attempt === MAX_RETRIES) {
            // Non-retryable error or last attempt - log and return failure
            log.warn(`[AVATAR JOB ${jobId}] No image data in Gemini response for ${category}`);
            if (finishReason) {
              log.warn(`[AVATAR JOB ${jobId}] Finish reason: ${finishReason}`);
            }
            if (data.promptFeedback) {
              log.warn(`[AVATAR JOB ${jobId}] Prompt feedback: ${JSON.stringify(data.promptFeedback)}`);
            }
            if (data.error) {
              log.error(`[AVATAR JOB ${jobId}] API error: ${JSON.stringify(data.error)}`);
            }
            // Log full response for debugging IMAGE_OTHER
            log.warn(`[AVATAR JOB ${jobId}] Full Gemini response: ${JSON.stringify(data).substring(0, 1000)}`);
            return { category, imageData: null, prompt: avatarPrompt, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
          }

          // IMAGE_OTHER with retries remaining - continue to next iteration
          log.warn(`[AVATAR JOB ${jobId}] IMAGE_OTHER for ${category}, will retry...`);
        }

        // Should not reach here, but just in case
        return { category, imageData: null, prompt: avatarPrompt, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
      } catch (err) {
        log.error(`[AVATAR JOB ${jobId}] Generation failed for ${category}:`, err.message);
        return { category, imageData: null, prompt: null, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
      }
    };

    // Generate all avatars in parallel
    const generationPromises = Object.keys(clothingCategories).map(cat => generateSingleAvatarForJob(cat));
    const generatedAvatars = await Promise.all(generationPromises);

    // Upload each avatar to R2 in parallel and store the public URL on
    // results[`${category}Url`]. R2 misconfig or upload failure leaves the
    // URL undefined; the writer below then persists inline as the fallback.
    //
    // `r2Version` is a per-regeneration tag baked into every R2 key for this
    // job (avatars + face/body thumbnails). Without it, regenerations
    // overwrote the same R2 path (e.g. .../standard.jpg) — Cloudflare's
    // 4-hour cache + the browser's HTTP cache then served the stale image
    // even though the new bytes were on R2. With it, every regen produces a
    // brand-new URL → no cache collision, no "save failed" mirage.
    const r2Version = Date.now().toString(36);
    const r2UploadPromises = generatedAvatars
      .filter(a => a.imageData && job.userId && characterId)
      .map(async ({ category, imageData }) => {
        const url = await saveAvatarToR2(job.userId, characterId, category, imageData, r2Version);
        return { category, url };
      });
    const r2Results = await Promise.all(r2UploadPromises);
    const urlByCategory = new Map();
    for (const { category, url } of r2Results) {
      if (url) urlByCategory.set(category, url);
    }
    if (urlByCategory.size > 0) {
      log.info(`☁️  [AVATAR JOB ${jobId}] R2 uploaded ${urlByCategory.size}/${generatedAvatars.length} avatars`);
    } else if (generatedAvatars.some(a => a.imageData)) {
      log.debug(`☁️  [AVATAR JOB ${jobId}] R2 not configured or all uploads failed — falling back to inline storage only`);
    }

    // Store images in results — both inline base64 (legacy path) and Url (R2)
    for (const { category, imageData } of generatedAvatars) {
      if (imageData) results[category] = imageData;
      const url = urlByCategory.get(category);
      if (url) results[`${category}Url`] = url;
    }

    job.progress = 70;
    job.message = 'Processing avatars...';

    // Aggregate token usage
    for (const { category, prompt, inputTokens, outputTokens } of generatedAvatars) {
      if (prompt) results.prompts[category] = prompt;
      if (inputTokens > 0 || outputTokens > 0) {
        if (!results.tokenUsage.byModel[geminiModelId]) {
          results.tokenUsage.byModel[geminiModelId] = { input_tokens: 0, output_tokens: 0 };
        }
        results.tokenUsage.byModel[geminiModelId].input_tokens += inputTokens;
        results.tokenUsage.byModel[geminiModelId].output_tokens += outputTokens;
      }
    }

    // Extract face/body thumbnails from 2x2 grids — ALL in parallel.
    // Each thumbnail is also uploaded to R2; the URL lands in
    // results.faceThumbnailsUrl / .bodyThumbnailsUrl.
    const avatarsWithImages = generatedAvatars.filter(a => a.imageData);
    const splitPromises = avatarsWithImages.map(async ({ category, imageData }) => {
      try {
        const splitResult = await splitGridAndExtractFace(imageData);
        if (splitResult.success) {
          if (splitResult.faceThumbnail) {
            if (!results.faceThumbnails) results.faceThumbnails = {};
            results.faceThumbnails[category] = splitResult.faceThumbnail;
            log.debug(`✅ [AVATAR JOB ${jobId}] Extracted ${category} face thumbnail`);
            if (job.userId && characterId) {
              const u = await saveAvatarThumbToR2(job.userId, characterId, 'face', category, splitResult.faceThumbnail, r2Version);
              if (u) {
                if (!results.faceThumbnailsUrl) results.faceThumbnailsUrl = {};
                results.faceThumbnailsUrl[category] = u;
              }
            }
          }
          if (splitResult.quadrants?.bodyFront) {
            if (!results.bodyThumbnails) results.bodyThumbnails = {};
            results.bodyThumbnails[category] = splitResult.quadrants.bodyFront;
            log.debug(`✅ [AVATAR JOB ${jobId}] Extracted ${category} body thumbnail`);
            if (job.userId && characterId) {
              const u = await saveAvatarThumbToR2(job.userId, characterId, 'body', category, splitResult.quadrants.bodyFront, r2Version);
              if (u) {
                if (!results.bodyThumbnailsUrl) results.bodyThumbnailsUrl = {};
                results.bodyThumbnailsUrl[category] = u;
              }
            }
          }
        }
      } catch (err) {
        log.warn(`[AVATAR JOB ${jobId}] Face thumbnail extraction failed for ${category}: ${err.message}`);
      }
    });

    // Wait for grid splits + R2 thumb uploads (needed for thumbnails the client displays)
    await Promise.all(splitPromises);

    // Return thumbnails to client NOW — evaluation + DB save continue in background
    // User sees avatars after Gemini (~5s) + grid splits (~1s parallel) = ~6s
    if (results.standard) {
      results.status = 'complete';
      results.generatedAt = new Date().toISOString();
      job.status = 'complete';
      job.progress = 100;
      job.message = 'Avatars ready';
      job.result = results;
      log.info(`⚡ [AVATAR JOB ${jobId}] Thumbnails ready in ${Date.now() - generationStart}ms — returning to client, evaluation continues in background`);
    }

    // Evaluation + DB save run in background (client already has images)
    if (ENABLE_AVATAR_EVALUATION) {
    const avatarsToEvaluate = generatedAvatars.filter(a => a.imageData);
    log.debug(`🔍 [AVATAR JOB ${jobId}] Checking evaluation: avatarsToEvaluate=${avatarsToEvaluate.length}, geminiApiKey=${!!geminiApiKey}`);
    if (avatarsToEvaluate.length > 0 && geminiApiKey) {
      log.debug(`🔍 [AVATAR JOB ${jobId}] Starting PARALLEL grid splits + evaluation of ${avatarsToEvaluate.length} avatars...`);
      job.progress = 80;
      job.message = 'Extracting traits and clothing...';

      try {
        // Extract traits from ORIGINAL PHOTO (ground truth for face) in parallel with avatar evals
        const photoTraitsPromise = extractTraitsWithGemini(referencePhoto);

        // Evaluate all avatars in parallel. Use facePhoto for the face match
        // when available (zoomed crop = more face pixels for Gemini to read);
        // referencePhoto is the bg-removed body where the face occupies ~5%
        // of pixels and identity signal is dilute. Falls back to referencePhoto
        // when no dedicated face crop was uploaded.
        const faceRef = facePhoto || referencePhoto;
        const evalPromises = avatarsToEvaluate.map(async ({ category, imageData }) => {
          const faceMatchResult = await evaluateAvatarFaceMatch(faceRef, imageData, geminiApiKey);
          return { category, faceMatchResult };
        });

        // Wait for photo analysis + avatar evaluations in parallel
        const [photoTraitsResult, ...evalResults] = await Promise.all([
          photoTraitsPromise,
          ...evalPromises
        ]);

        // Collect physical traits from ALL avatar evaluations for consensus voting
        const allAvatarTraits = [];

        // Process results for each category
        for (const { category, faceMatchResult } of evalResults) {
          if (!faceMatchResult) continue;

          // Store raw evaluation for dev mode debugging (first one only)
          if (!results.rawEvaluation && faceMatchResult.raw) {
            results.rawEvaluation = faceMatchResult.raw;
          }

          // Store faceMatch for this category
          results.faceMatch = results.faceMatch || {};
          results.faceMatch[category] = {
            score: faceMatchResult.score,
            details: faceMatchResult.details,
            lpips: faceMatchResult.lpips || null
          };

          // Store structured clothing for this category
          if (faceMatchResult.clothing && typeof faceMatchResult.clothing === 'object') {
            results.structuredClothing = results.structuredClothing || {};
            results.structuredClothing[category] = faceMatchResult.clothing;

            // Build text description for avatars.clothing
            const clothingParts = [];
            if (faceMatchResult.clothing.fullBody) {
              clothingParts.push(faceMatchResult.clothing.fullBody);
            } else {
              if (faceMatchResult.clothing.upperBody) clothingParts.push(faceMatchResult.clothing.upperBody);
              if (faceMatchResult.clothing.lowerBody) clothingParts.push(faceMatchResult.clothing.lowerBody);
            }
            if (faceMatchResult.clothing.shoes) clothingParts.push(faceMatchResult.clothing.shoes);
            results.clothing = results.clothing || {};
            results.clothing[category] = clothingParts.join(', ');

            log.debug(`👕 [AVATAR JOB] ${category} clothing: ${results.clothing[category]}`);
          }

          // Collect physical traits from ALL categories for consensus voting
          if (faceMatchResult.physicalTraits) {
            // Normalize apparentAge field names before collecting
            const traits = { ...faceMatchResult.physicalTraits };
            if (!traits.apparentAge) {
              if (traits.apparent_age) { traits.apparentAge = traits.apparent_age; delete traits.apparent_age; }
              else if (traits.age) { traits.apparentAge = traits.age; delete traits.age; }
            }
            allAvatarTraits.push(traits);
          }
        }

        // Apply consensus voting: photo traits (ground truth) + all avatar traits
        const photoTraits = photoTraitsResult?.traits || {};
        // Normalize photo trait field names (character-analysis.txt uses 'age' for numeric, 'apparentAge' for category)
        if (!photoTraits.apparentAge && photoTraits.apparent_age) {
          photoTraits.apparentAge = photoTraits.apparent_age;
          delete photoTraits.apparent_age;
        }
        // Map 'distinctive markings' to 'other' for consensus compatibility
        if (photoTraits['distinctive markings'] && !photoTraits.other) {
          photoTraits.other = photoTraits['distinctive markings'];
        }

        if (allAvatarTraits.length > 0 || Object.keys(photoTraits).length > 0) {
          const { traits: consensusResult, sources } = consensusTraits(photoTraits, allAvatarTraits);
          results.extractedTraits = consensusResult;
          results.traitSources = sources; // For debugging

          // Use detailedHairAnalysis from photo (ground truth), fall back to avatar
          results.extractedTraits.detailedHairAnalysis =
            photoTraitsResult?.detailedHairAnalysis ||
            photoTraitsResult?.traits?.detailedHairAnalysis ||
            evalResults.find(r => r.faceMatchResult?.detailedHairAnalysis)?.faceMatchResult.detailedHairAnalysis;

          // Clamp the analyzed apparentAge to within ±1 group of the user-stated
          // age. Trust the visual age normally (a 12yo who looks 13 stays as
          // young-teen) but catch absurd mis-analyses (12yo analyzed as adult →
          // clamped to young-teen, one group above preteen).
          const photoConfidence = photoTraitsResult?.confidence?.overallConfidence
            || photoTraitsResult?.traits?.confidence?.overallConfidence
            || null;
          const clampResult = clampApparentAge(consensusResult.apparentAge, age, photoConfidence);
          if (clampResult.clamped) {
            log.info(`[AGE CLAMP] ${name || characterId}: ${clampResult.reason}`);
            consensusResult.apparentAge = clampResult.category;
            sources.apparentAge = `${sources.apparentAge || 'photo'} → clamped`;
          } else {
            log.debug(`[AGE CLAMP] ${name || characterId}: ${clampResult.reason}`);
          }

          // Log consensus decisions where photo won (highlights "beautification" corrections)
          for (const [field, source] of Object.entries(sources)) {
            if (source.includes('photo')) {
              log.info(`📋 [CONSENSUS] ${field}: "${consensusResult[field]}" (${source})`);
            }
          }
          log.debug(`📋 [AVATAR JOB] Consensus traits: apparentAge=${consensusResult.apparentAge}, build=${consensusResult.build}, hairDensity=${consensusResult.hairDensity || 'N/A'}`);
        } else {
          log.warn(`📋 [AVATAR JOB ${jobId}] No traits from photo or avatars — skipping consensus`);
        }

        // Auto-retry categories with low face scores
        const lowScoreCategories = Object.entries(results.faceMatch || {})
          .filter(([, fm]) => fm.score != null && fm.score < MIN_BASE_AVATAR_SCORE)
          .map(([cat]) => cat);

        if (lowScoreCategories.length > 0) {
          log.debug(`🔄 [AVATAR JOB ${jobId}] Retrying ${lowScoreCategories.length} low-score categories: ${lowScoreCategories.join(', ')}`);
          job.message = `Retrying ${lowScoreCategories.length} low-quality avatar(s)...`;
          const retryStart = Date.now();

          const retryPromises = lowScoreCategories.map(async (category) => {
            const originalScore = results.faceMatch[category].score;
            log.debug(`🔄 [AVATAR JOB ${jobId}] Retrying ${category} (score ${originalScore}/10 < ${MIN_BASE_AVATAR_SCORE})...`);

            // Regenerate using the same helper
            const retryGen = await generateSingleAvatarForJob(category);
            if (!retryGen?.imageData) {
              log.warn(`🔄 [AVATAR JOB ${jobId}] Retry for ${category} produced no image — keeping original`);
              return null;
            }

            // Aggregate retry token usage
            if (retryGen.inputTokens > 0 || retryGen.outputTokens > 0) {
              if (!results.tokenUsage.byModel[geminiModelId]) {
                results.tokenUsage.byModel[geminiModelId] = { input_tokens: 0, output_tokens: 0 };
              }
              results.tokenUsage.byModel[geminiModelId].input_tokens += retryGen.inputTokens;
              results.tokenUsage.byModel[geminiModelId].output_tokens += retryGen.outputTokens;
            }

            // Extract thumbnails from retry result
            let faceThumbnail = null;
            let bodyThumbnail = null;
            try {
              const splitResult = await splitGridAndExtractFace(retryGen.imageData);
              if (splitResult.success) {
                faceThumbnail = splitResult.faceThumbnail || null;
                bodyThumbnail = splitResult.quadrants?.bodyFront || null;
              }
            } catch (splitErr) {
              log.warn(`🔄 [AVATAR JOB ${jobId}] Thumbnail extraction failed for ${category} retry: ${splitErr.message}`);
            }

            // Re-evaluate (use facePhoto for face match — see comment above)
            const retryEval = await evaluateAvatarFaceMatch(faceRef, retryGen.imageData, geminiApiKey);
            const retryScore = retryEval?.score ?? 0;
            log.debug(`🔄 [AVATAR JOB ${jobId}] Retry ${category}: new score ${retryScore}/10 (was ${originalScore}/10)`);

            if (retryScore > originalScore) {
              log.debug(`✅ [AVATAR JOB ${jobId}] Retry improved ${category}: ${originalScore} → ${retryScore}`);
              return { category, retryGen, retryEval, retryScore, faceThumbnail, bodyThumbnail, improved: true };
            } else {
              log.debug(`⏭️ [AVATAR JOB ${jobId}] Retry did NOT improve ${category}: ${originalScore} → ${retryScore}, keeping original`);
              return null;
            }
          });

          const retryOutcomes = await Promise.all(retryPromises);

          for (const outcome of retryOutcomes) {
            if (!outcome?.improved) continue;
            const { category, retryGen, retryEval, faceThumbnail, bodyThumbnail } = outcome;

            // Replace image + thumbnails
            results[category] = retryGen.imageData;
            if (faceThumbnail) {
              if (!results.faceThumbnails) results.faceThumbnails = {};
              results.faceThumbnails[category] = faceThumbnail;
            }
            if (bodyThumbnail) {
              if (!results.bodyThumbnails) results.bodyThumbnails = {};
              results.bodyThumbnails[category] = bodyThumbnail;
            }
            if (retryGen.prompt) results.prompts[category] = retryGen.prompt;

            // Replace evaluation
            results.faceMatch[category] = {
              score: retryEval.score,
              details: retryEval.details,
              lpips: retryEval.lpips || null
            };

            // Replace clothing if available
            if (retryEval.clothing && typeof retryEval.clothing === 'object') {
              results.structuredClothing = results.structuredClothing || {};
              results.structuredClothing[category] = retryEval.clothing;
              const clothingParts = [];
              if (retryEval.clothing.fullBody) {
                clothingParts.push(retryEval.clothing.fullBody);
              } else {
                if (retryEval.clothing.upperBody) clothingParts.push(retryEval.clothing.upperBody);
                if (retryEval.clothing.lowerBody) clothingParts.push(retryEval.clothing.lowerBody);
              }
              if (retryEval.clothing.shoes) clothingParts.push(retryEval.clothing.shoes);
              results.clothing = results.clothing || {};
              results.clothing[category] = clothingParts.join(', ');
            }
          }

          log.debug(`🔄 [AVATAR JOB ${jobId}] Retry phase completed in ${Date.now() - retryStart}ms`);
        }
      } catch (evalErr) {
        log.warn(`[AVATAR JOB ${jobId}] Evaluation failed (continuing without traits):`, evalErr.message);
      }
    }
    } else {
      log.debug(`⏭️ [AVATAR JOB ${jobId}] Skipping face evaluation (ENABLE_AVATAR_EVALUATION=false)`);
    }

    // Directly update character in database with extracted traits and clothing
    if (characterId && (results.extractedTraits || results.structuredClothing?.standard || results.standard)) {
      try {
        log.debug(`💾 [AVATAR JOB ${jobId}] Updating character ${characterId} (internal ID) in database with extracted data`);

        // Retry logic: character might not be saved yet if avatar job finishes before wizard completes
        let charIndex = -1;
        let rows = null;
        let charData = null;
        let characters = null;
        let rowId = null;

        // 30 retries × 2 seconds = 60 seconds max wait for character to be saved
        for (let retryAttempt = 0; retryAttempt < 30; retryAttempt++) {
          // Get current character data - query by user_id since there's one row per user
          // Note: dbQuery returns rows array directly, not { rows: [...] }
          rows = await dbQuery(`
            SELECT id, data FROM characters WHERE user_id = $1
          `, [user.id]);

          if (rows.length > 0) {
            rowId = rows[0].id; // e.g., "characters_1764881868108"
            charData = rows[0].data || {};
            characters = charData.characters || [];

            // Find the character by its internal ID (characterId is the character's id within the array)
            charIndex = characters.findIndex(c => c.id === characterId || c.id === parseInt(characterId));

            // Fallback: find by name if ID match fails - ONLY if exactly one match (avoid ambiguity)
            if (charIndex < 0 && name) {
              const availableIds = characters.map(c => `${c.name}(${c.id})`).join(', ');
              log.debug(`💾 [AVATAR JOB ${jobId}] Character ID ${characterId} not found, available: [${availableIds}], trying name fallback...`);
              const nameMatches = characters.filter(c => c.name === name);
              if (nameMatches.length === 1) {
                charIndex = characters.findIndex(c => c.name === name);
                log.warn(`📍 [AVATAR JOB ${jobId}] Using name fallback: "${name}" found at index ${charIndex} (ID mismatch: wanted ${characterId}, found ${characters[charIndex].id})`);
              } else if (nameMatches.length > 1) {
                log.warn(`⚠️ [AVATAR JOB ${jobId}] Name fallback SKIPPED: ${nameMatches.length} characters named "${name}" - cannot determine which one`);
              }
            }
          }

          if (charIndex >= 0) {
            if (retryAttempt > 0) {
              log.info(`💾 [AVATAR JOB ${jobId}] Found character after ${retryAttempt + 1} attempts (wizard may have just saved)`);
            }
            break;
          }

          // Character not found yet - wait and retry (wizard might still be saving)
          if (retryAttempt < 29) {
            log.debug(`💾 [AVATAR JOB ${jobId}] Character not found (attempt ${retryAttempt + 1}/30), waiting 2s for wizard to save...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Log warning if character still not found after all retries
        if (charIndex < 0) {
          const availableChars = characters ? characters.map(c => `${c.name}(${c.id})`).join(', ') : 'none';
          log.warn(`⚠️ [AVATAR JOB ${jobId}] CHARACTER NOT FOUND after 30 attempts (60s)! Wanted ID: ${characterId}, name: "${name}". Available: [${availableChars}]. Avatars generated but NOT saved to DB!`);
        }

        if (rows && rows.length > 0 && charIndex >= 0) {
            log.debug(`💾 [AVATAR JOB ${jobId}] Found character at index ${charIndex} (rowId: ${rowId}) - starting transaction for update`);

          // Use transaction with row lock to prevent race condition with character save
          // The charIndex from retry loop may be stale if user modified characters during avatar generation
          await dbQuery('BEGIN');

          try {
            // Lock row and get fresh data
            const freshRows = await dbQuery(
              `SELECT id, data FROM characters WHERE user_id = $1 FOR UPDATE`,
              [user.id]
            );

            if (freshRows.length === 0) {
              await dbQuery('ROLLBACK');
              throw new Error('Character row disappeared during transaction');
            }

            const freshRowId = freshRows[0].id;
            const freshData = freshRows[0].data || {};
            const freshCharacters = freshData.characters || [];

            // Find character with fresh index (may have changed if user reordered/deleted characters)
            let freshCharIndex = freshCharacters.findIndex(c => c.id === characterId || c.id === parseInt(characterId));

            // Fallback to name if ID not found
            if (freshCharIndex < 0 && name) {
              const nameMatches = freshCharacters.filter(c => c.name === name);
              if (nameMatches.length === 1) {
                freshCharIndex = freshCharacters.findIndex(c => c.name === name);
                log.warn(`📍 [AVATAR JOB ${jobId}] Using name fallback in transaction: "${name}" at index ${freshCharIndex}`);
              }
            }

            if (freshCharIndex < 0) {
              await dbQuery('ROLLBACK');
              const availableChars = freshCharacters.map(c => `${c.name}(${c.id})`).join(', ');
              throw new Error(`Character ${characterId} (${name}) not found in fresh lookup - may have been deleted. Available: [${availableChars}]`);
            }

            // Log if index changed (indicates user modified characters during avatar generation)
            if (freshCharIndex !== charIndex) {
              log.warn(`🔄 [AVATAR JOB ${jobId}] Character index changed: ${charIndex} → ${freshCharIndex} (array was modified during generation)`);
            }

          if (freshCharacters[freshCharIndex]) {
            // Note: In-memory updates below are for logging/debugging only
            // The actual DB update uses freshCharIndex with atomic jsonb_set

            // Apply extracted traits as FLAT properties (not nested in physical)
            // This matches the format used by frontend save and photo analysis
            if (results.extractedTraits) {
              const t = results.extractedTraits;
              log.debug(`💾 [AVATAR JOB ${jobId}] Will apply extracted traits: apparent_age=${t.apparentAge}, build=${t.build}`);
            }

            // Apply extracted clothing
            if (results.structuredClothing?.standard) {
              log.debug(`💾 [AVATAR JOB ${jobId}] Will apply extracted clothing: ${JSON.stringify(results.structuredClothing.standard)}`);
            }

            // Save avatars data including faceThumbnails
            if (results.faceThumbnails || results.standard || results.winter || results.summer) {
              log.debug(`💾 [AVATAR JOB ${jobId}] Will apply avatar data including faceThumbnails`);
            }

            // Save token usage for cost tracking (ASYNC path)
            const hasTokenUsage = results.tokenUsage && Object.keys(results.tokenUsage.byModel || {}).length > 0;
            if (hasTokenUsage) {
              log.info(`📊 [AVATAR JOB ${jobId}] Will save token usage: ${JSON.stringify(results.tokenUsage.byModel)}`);
            }

            // Build avatar data for full data column. URL-only — inline base64
            // is persisted ONLY when R2 upload failed (so the readers, which
            // require URL, still have something). Sliced inlines elsewhere
            // are intermediate results that don't need to land in Postgres.
            // onlyIfNoUrl / onlyMissingThumbs are hoisted to module scope.
            const fbThumbs = onlyMissingThumbs(results.faceThumbnails, results.faceThumbnailsUrl);
            const bbThumbs = onlyMissingThumbs(results.bodyThumbnails, results.bodyThumbnailsUrl);
            const newAvatarData = {
              status: 'complete',
              generatedAt: new Date().toISOString(),
              ...(fbThumbs && { faceThumbnails: fbThumbs }),
              ...(bbThumbs && { bodyThumbnails: bbThumbs }),
              ...(onlyIfNoUrl(results.standard, results.standardUrl) && { standard: results.standard }),
              ...(onlyIfNoUrl(results.winter, results.winterUrl) && { winter: results.winter }),
              ...(onlyIfNoUrl(results.summer, results.summerUrl) && { summer: results.summer }),
              ...(results.standardUrl && { standardUrl: results.standardUrl }),
              ...(results.winterUrl && { winterUrl: results.winterUrl }),
              ...(results.summerUrl && { summerUrl: results.summerUrl }),
              ...(results.faceThumbnailsUrl && { faceThumbnailsUrl: results.faceThumbnailsUrl }),
              ...(results.bodyThumbnailsUrl && { bodyThumbnailsUrl: results.bodyThumbnailsUrl }),
              ...(results.clothing && { clothing: results.clothing }),
              // Dev-mode diagnostics — small payload, lets the "Show prompt" /
              // "Face eval" details panels in CharacterForm read after a page
              // reload instead of only during the fresh wizard session.
              ...(results.prompts && Object.keys(results.prompts).length > 0 && { prompts: results.prompts }),
              ...(results.faceMatch && Object.keys(results.faceMatch).length > 0 && { faceMatch: results.faceMatch }),
              ...(results.extractedTraits && { extractedTraits: results.extractedTraits }),
              ...(results.structuredClothing && Object.keys(results.structuredClothing).length > 0 && { structuredClothing: results.structuredClothing }),
            };

            // Lightweight metadata: prefer URL standard slot, fall back to
            // inline only when R2 had no URL.
            const stdFace = results.faceThumbnailsUrl?.standard || results.faceThumbnails?.standard;
            const stdBody = results.bodyThumbnailsUrl?.standard || results.bodyThumbnails?.standard;
            const lightAvatarData = {
              status: 'complete',
              generatedAt: newAvatarData.generatedAt,
              hasFullAvatars: true,
              faceThumbnails: stdFace ? { standard: stdFace } : undefined,
              bodyThumbnails: stdBody ? { standard: stdBody } : undefined,
              clothing: results.clothing,
            };

            // Build atomic update SQL with all field updates using FRESH index
            // Each jsonb_set wraps the previous, creating nested atomic updates
            let dataUpdate = 'data';
            let metaUpdate = 'metadata';
            const params = [freshRowId]; // $1 = rowId (use fresh rowId)
            let paramIndex = 2;

            // Avatar data (always update if we have results)
            // Use SQL-level merge: COALESCE(existing, '{}') || new_data to preserve other avatar fields
            if (results.faceThumbnails || results.standard || results.winter || results.summer) {
              // Merge new avatars with existing DB avatars (references current DB value, not stale in-memory)
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},avatars}', COALESCE(data->'characters'->${freshCharIndex}->'avatars', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},avatars}', $${paramIndex + 1}::jsonb, true)`;
              params.push(JSON.stringify(newAvatarData), JSON.stringify(lightAvatarData));
              paramIndex += 2;
            }

            // Extracted traits - write to canonical physical.* structure
            // Respect user-edited fields — don't overwrite them with AI extraction
            if (results.extractedTraits) {
              const t = results.extractedTraits;
              const existingChar = freshCharacters[freshCharIndex] || {};
              const existingSources = existingChar.physicalTraitsSource || {};

              // Build physical object with only non-null values, skipping user-edited fields
              const physical = {};
              const traitSources = {};

              const setTrait = (field, value) => {
                if (value && existingSources[field] !== 'user') {
                  physical[field] = value;
                  traitSources[field] = 'extracted';
                }
              };

              setTrait('apparentAge', t.apparentAge);
              setTrait('build', t.build);
              setTrait('eyeColor', t.eyeColor);
              setTrait('hairColor', t.hairColor);
              setTrait('skinTone', t.skinTone);
              setTrait('skinToneHex', t.skinToneHex);
              setTrait('facialHair', t.facialHair);
              setTrait('face', t.face);
              setTrait('other', t.other);
              setTrait('glasses', t.glasses);
              setTrait('eyeColorHex', t.eyeColorHex);
              setTrait('hairColorHex', t.hairColorHex);
              // Hair shape — physical.detailedHairAnalysis is the extraction
              // baseline, re-extracted from the freshly generated avatar.
              // physical.userHairOverride is kept permanently across
              // regenerations: Gemini's hair analysis often returns coarse
              // generic enum values ("natural" for what was generated as a
              // ponytail), so trusting re-extraction to "agree" with the
              // user's intent silently nukes the user's choice. The override
              // wins forever until the user changes or removes it themselves.
              if (t.detailedHairAnalysis && existingSources['hairType'] !== 'user') {
                physical.detailedHairAnalysis = t.detailedHairAnalysis;
              }

              // Merge with existing physical object
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},physical}', COALESCE(data->'characters'->${freshCharIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},physical}', COALESCE(metadata->'characters'->${freshCharIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(physical));
              paramIndex += 1;

              // Persist trait sources (merge with existing, preserving 'user' entries)
              if (Object.keys(traitSources).length > 0) {
                dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},physicalTraitsSource}', COALESCE(data->'characters'->${freshCharIndex}->'physicalTraitsSource', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
                metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},physicalTraitsSource}', COALESCE(metadata->'characters'->${freshCharIndex}->'physicalTraitsSource', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
                params.push(JSON.stringify(traitSources));
                paramIndex += 1;
              }
            }

            // Structured clothing
            if (results.structuredClothing?.standard) {
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},structuredClothing}', $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},structuredClothing}', $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(results.structuredClothing.standard));
              paramIndex += 1;
            }

            // Token usage - merge with existing at SQL level to avoid race conditions
            if (hasTokenUsage) {
              // Build new token usage data
              const newUsage = { byModel: {}, lastUpdated: new Date().toISOString() };
              for (const [modelId, usage] of Object.entries(results.tokenUsage.byModel)) {
                newUsage.byModel[modelId] = {
                  input_tokens: usage.input_tokens || 0,
                  output_tokens: usage.output_tokens || 0,
                  calls: usage.calls || 0
                };
              }

              // Use SQL-level merge for token usage (only in data column)
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},avatarTokenUsage}', COALESCE(data->'characters'->${freshCharIndex}->'avatarTokenUsage', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(newUsage));
              paramIndex += 1;

              log.info(`📊 [AVATAR JOB ${jobId}] Token usage saved: ${JSON.stringify(newUsage.byModel)}`);
            }

            // Execute atomic update
            const updateQuery = `UPDATE characters SET data = ${dataUpdate}, metadata = ${metaUpdate} WHERE id = $1`;
            await dbQuery(updateQuery, params);

            // Commit transaction
            await dbQuery('COMMIT');

            log.info(`✅ [AVATAR JOB ${jobId}] Successfully updated character ${name || characterId} at index ${freshCharIndex} in row ${freshRowId} (data + metadata)`);
            results.dbSaveSuccessful = true;
          } else {
            await dbQuery('ROLLBACK');
            throw new Error(`Character at fresh index ${freshCharIndex} is undefined`);
          }
          } catch (txErr) {
            // Ensure rollback on any error
            try { await dbQuery('ROLLBACK'); } catch (rollbackErr) { /* ignore rollback errors */ }
            throw txErr;
          }
        } else {
          // Character still not found after all retries - fail the job
          throw new Error(`Character not found by ID ${characterId} or name "${name}" after 30 retries - cannot save avatars`);
        }
      } catch (dbErr) {
        log.error(`❌ [AVATAR JOB ${jobId}] Failed to save avatars to database:`, dbErr.message);
        results.dbSaveSuccessful = false;
        throw new Error(`Database save failed: ${dbErr.message}`);
      }
    }

    // Finalize results (images were already returned to client via early completion)
    results.status = 'complete';
    if (!results.generatedAt) results.generatedAt = new Date().toISOString();
    if (results.dbSaveSuccessful === undefined) results.dbSaveSuccessful = true;

    if (!results.standard) {
      throw new Error('Failed to generate standard avatar');
    }

    log.debug(`✅ [AVATAR JOB ${jobId}] Fully completed (eval + DB) in ${Date.now() - generationStart}ms`);

    // Log activity
    try {
      await logActivity(user.id, user.username, 'AVATAR_GENERATED', {
        characterId,
        characterName: name,
        model: selectedModel,
        async: true,
        avatarsGenerated: Object.keys(clothingCategories).filter(cat => results[cat]).length
      });
    } catch (activityErr) {
      log.warn(`[AVATAR JOB ${jobId}] Failed to log activity:`, activityErr.message);
    }

  } catch (err) {
    log.error(`[AVATAR JOB ${jobId}] Failed:`, err.message);
    job.status = 'failed';
    job.error = err.message;

    // Persist avatars.status='failed' to the character record so the wizard's
    // generateStory() pre-flight loop (StoryWizard.tsx) can skip permanently-
    // failed avatars instead of re-triggering the same Gemini call forever.
    // Without this, status stays at 'pending' and the wizard stalls before
    // POST /api/jobs/create-story is ever sent.
    try {
      const { characterId } = bodyParams;
      const rowId = `characters_${user.id}`;
      const rowRes = await dbQuery(`SELECT data FROM characters WHERE id = $1`, [rowId]);
      if (rowRes.length > 0) {
        const characters = rowRes[0].data?.characters || [];
        const charIndex = characters.findIndex(c => String(c.id) === String(characterId));
        if (charIndex >= 0) {
          const failedAvatars = { status: 'failed', failedAt: new Date().toISOString(), error: err.message };
          await dbQuery(
            `UPDATE characters
             SET data = jsonb_set(data, $2, COALESCE(data->'characters'->${charIndex}->'avatars', '{}'::jsonb) || $3::jsonb, true),
                 metadata = jsonb_set(metadata, $2, COALESCE(metadata->'characters'->${charIndex}->'avatars', '{}'::jsonb) || $3::jsonb, true)
             WHERE id = $1`,
            [rowId, `{characters,${charIndex},avatars}`, JSON.stringify(failedAvatars)]
          );
          log.warn(`[AVATAR JOB ${jobId}] Marked character ${characterId} avatars.status='failed' in DB`);
        }
      }
    } catch (persistErr) {
      log.error(`[AVATAR JOB ${jobId}] Failed to persist failed-status to character:`, persistErr.message);
    }
  }
}

/**
 * POST /api/generate-clothing-avatars
 * Generate clothing avatars for a character (winter, standard, summer, formal)
 *
 * Query params:
 *   - async=true: Return immediately with job ID, poll /api/avatar-jobs/:jobId for result
 *                 This prevents connection blocking and allows parallel requests
 */
router.post('/generate-clothing-avatars', authenticateToken, async (req, res) => {
  try {
    // `referencePhoto` is the bg-removed body with clothing visible (what Grok edits).
    // `facePhoto` is the high-res face crop, used as a SECOND Grok reference so
    // identity (eyes/hair/skin) survives the 4-quadrant generation. Legacy clients
    // sent the body under the field name `facePhoto`; we still accept that.
    const referencePhoto = req.body.referencePhoto || req.body.facePhoto;
    const { characterId, physicalDescription, name, age, apparentAge, gender, build, physicalTraits, clothing, avatarModel } = req.body;
    // The new face-crop second-reference. Only set when the client deliberately
    // sends it via the `facePhoto` field *alongside* `referencePhoto` (so we
    // don't mistake a legacy single-field call for a multi-ref call).
    const faceRefPhoto = (req.body.referencePhoto && req.body.facePhoto) ? req.body.facePhoto : null;
    const asyncMode = req.query.async === 'true' || req.body.async === true;

    if (!referencePhoto) {
      return res.status(400).json({ error: 'Missing referencePhoto' });
    }

    // Validate characterId - must be a valid number for DB lookup
    if (!characterId || (typeof characterId !== 'number' && isNaN(parseInt(characterId)))) {
      return res.status(400).json({ error: 'Invalid or missing characterId' });
    }
    const validCharacterId = typeof characterId === 'number' ? characterId : parseInt(characterId);

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    // ASYNC MODE: Return immediately with job ID
    if (asyncMode) {
      const crypto = require('crypto');
      const jobId = `avatar_${crypto.randomBytes(8).toString('hex')}`;

      // Create job entry with validated characterId
      avatarJobs.set(jobId, {
        userId: req.user.id,
        characterId: validCharacterId,
        characterName: name,
        status: 'pending',
        progress: 0,
        message: 'Starting avatar generation...',
        createdAt: Date.now(),
        result: null,
        error: null
      });

      // Return immediately
      res.json({
        success: true,
        async: true,
        jobId,
        message: 'Avatar generation started. Poll /api/avatar-jobs/' + jobId + ' for status.'
      });

      // Update body with validated characterId for background processing.
      // Normalize the legacy `facePhoto` wire field into `referencePhoto`
      // so processAvatarJobInBackground sees a single canonical name.
      const validatedBody = { ...req.body, characterId: validCharacterId, referencePhoto };

      // Continue processing in background (don't await)
      processAvatarJobInBackground(jobId, validatedBody, req.user, geminiApiKey).catch(err => {
        log.error(`[AVATAR JOB ${jobId}] Background processing failed:`, err.message);
        const job = avatarJobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = err.message;
        }
      });

      return; // Exit early - background job continues
    }

    // SYNC MODE: Original blocking behavior (for backwards compatibility)

    // Determine which model to use
    const selectedModel = avatarModel || MODEL_DEFAULTS.avatar || 'grok-imagine';
    const modelConfig = IMAGE_MODELS[selectedModel];
    const useRunware = modelConfig?.backend === 'runware' || selectedModel === 'flux-schnell';
    const useGrok = modelConfig?.backend === 'grok';
    const geminiModelId = modelConfig?.modelId || 'gemini-2.5-flash-image';

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name || 'unnamed'} (id: ${characterId}), model: ${selectedModel}, backend: ${useGrok ? 'grok' : useRunware ? 'runware' : 'gemini'}`);

    const isFemale = gender === 'female';

    // Define clothing categories - generate winter, standard, and summer avatars in parallel
    // Formal avatar is not generated (rarely needed)
    const clothingCategories = {
      winter: { emoji: '❄️' },
      standard: { emoji: '👕' },
      summer: { emoji: '☀️' }
    };

    const results = {
      status: 'generating',
      generatedAt: null,
      faceMatch: {},
      clothing: {},           // Legacy: text clothing per category
      structuredClothing: {}, // New: structured clothing from evaluation
      extractedTraits: null,  // Physical traits extracted from generated avatar
      rawEvaluation: null,    // Full unfiltered API response (for dev mode)
      prompts: {},
      tokenUsage: {           // Track Gemini token usage for cost tracking (per model)
        byModel: {}           // { 'gemini-2.5-flash-image': { input_tokens, output_tokens, calls }, ... }
      }
    };

    // SYNC PATH: Resize photos for Gemini to avoid IMAGE_OTHER errors (matches async path logic)
    const photoSizeKB = Math.round(referencePhoto.length / 1024);
    const isPNG = referencePhoto.startsWith('data:image/png');
    log.info(`👔 [CLOTHING AVATARS] 📸 Input reference photo: ${photoSizeKB}KB, format: ${isPNG ? 'PNG' : 'JPEG'}`);

    // Resize reference photo to 768px so the generator gets a consistent input size.
    // Same URL-vs-base64 fix as the async path above — see avatars.js:1715.
    const sharp = require('sharp');
    const r2 = require('../lib/r2');
    const inputBuffer = await r2.bytesFromAnyImage(referencePhoto);
    if (!inputBuffer) throw new Error(`Could not load reference photo (got ${typeof referencePhoto}, len=${referencePhoto?.length})`);
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const resizedPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.info(`👔 [CLOTHING AVATARS] Prepared: ${Math.round(resizedPhoto.length / 1024)}KB (was ${photoSizeKB}KB)`);

    // Prepare base64 data once for all requests
    const base64Data = resizedPhoto.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = 'image/jpeg'; // Always JPEG after resize

    // Build user clothing section if provided
    let userClothingSection = '';
    if (clothing) {
      const clothingParts = [];
      if (clothing.fullBody) {
        clothingParts.push(`Full outfit: ${clothing.fullBody}`);
      } else {
        if (clothing.upperBody) clothingParts.push(`Top: ${clothing.upperBody}`);
        if (clothing.lowerBody) clothingParts.push(`Bottom: ${clothing.lowerBody}`);
      }
      if (clothing.shoes) clothingParts.push(`Shoes: ${clothing.shoes}`);
      if (clothing.accessories) clothingParts.push(`Accessories: ${clothing.accessories}`);

      if (clothingParts.length > 0) {
        userClothingSection = `\n\nUSER-SPECIFIED CLOTHING (MUST USE - override default clothing style):\n${clothingParts.join('\n')}\nIMPORTANT: Use the user-specified clothing above instead of the default clothing style.`;
        log.debug(`👕 [CLOTHING AVATARS] Using user-specified clothing: ${clothingParts.join(', ')}`);
      }
    }

    // Build user physical traits section if provided (user-edited traits that must be applied)
    let userTraitsSection = '';
    if (physicalTraits && Object.keys(physicalTraits).length > 0) {
      const traitLines = [];
      if (physicalTraits.hairColor) traitLines.push(`- Hair color: ${physicalTraits.hairColor}`);
      if (physicalTraits.eyeColor) traitLines.push(`- Eye color: ${physicalTraits.eyeColor}`);
      // Hair shape/length from detailedHairAnalysis (single source of truth).
      const hairDesc = buildHairDescription(physicalTraits);
      if (hairDesc) traitLines.push(`- Hair: ${hairDesc}`);
      if (physicalTraits.build) traitLines.push(`- Body build: ${physicalTraits.build}`);
      if (physicalTraits.skinTone) traitLines.push(`- Skin tone: ${physicalTraits.skinTone}`);
      if (physicalTraits.face) traitLines.push(`- Face shape: ${physicalTraits.face}`);
      if (physicalTraits.facialHair) {
        if (physicalTraits.facialHair.toLowerCase() === 'clean-shaven') {
          traitLines.push(`- Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face`);
        } else if (physicalTraits.facialHair.toLowerCase() !== 'none') {
          traitLines.push(`- Facial hair: ${physicalTraits.facialHair}`);
        }
      }
      if (physicalTraits.glasses && String(physicalTraits.glasses).trim().toLowerCase() !== 'none') {
        traitLines.push(`- Glasses: ${physicalTraits.glasses} — ALWAYS visible on the face`);
      }
      if (physicalTraits.other) traitLines.push(`- Other: ${physicalTraits.other}`);

      if (traitLines.length > 0) {
        userTraitsSection = `\n\nPHYSICAL TRAIT CORRECTIONS (CRITICAL - MUST APPLY):
The user has specified the following traits that MUST be applied to the output:
${traitLines.join('\n')}

These corrections OVERRIDE what is visible in the reference photo.
- If hair color is specified, the output MUST show that exact hair color
- If eye color is specified, the output MUST show that exact eye color
- If skin tone is specified, the output MUST show that exact skin tone
- Apply these traits while preserving the person's facial identity from the reference.`;
        log.info(`🎨 [CLOTHING AVATARS] Using user-specified physical traits: ${traitLines.join(', ')}`);
      }
    }

    // Check if using ACE++ model (face-consistent avatar generation)
    const useACEPlusPlus = selectedModel === 'ace-plus-plus';

    // Helper function to generate avatar using Grok edit (face photo as reference).
    // Grok is the default avatar backend; Gemini was deprecated because IMAGE_OTHER
    // safety refusals on adult-face photos left avatars permanently 'pending'.
    const generateAvatarWithGrok = async (category, avatarPrompt) => {
      try {
        const result = await editWithGrok(avatarPrompt, [referencePhoto], {
          aspectRatio: '9:16',
          resolution: '1k',
          model: modelConfig?.modelId || 'grok-imagine-image',
          padInput: true,  // Avatars: pad to preserve the face/head when the
                           // bodyNoBg input is a taller-than-9:16 portrait.
        });
        if (result?.imageData) {
          const compressed = await compressImageToJPEG(result.imageData, 85, 768);
          return compressed || result.imageData;
        }
        return null;
      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] Grok generation failed for ${category}:`, err.message);
        return null;
      }
    };

    // Helper function to generate avatar using ACE++ (face-consistent)
    // Uses optimized shorter prompt - ACE++ gets face from reference image
    const generateAvatarWithACEPlusPlus = async (category, userTraits) => {
      try {
        if (!isRunwareConfigured()) {
          log.error(`❌ [CLOTHING AVATARS] Runware not configured`);
          return null;
        }

        // Build ACE++ prompt from optimized template
        const aceTemplate = PROMPT_TEMPLATES.avatarAcePrompt || '';
        const clothingStylePrompt = getClothingStylePromptFromAce(category, isFemale, aceTemplate);

        // Build final prompt: base template + clothing + user traits
        const basePrompt = aceTemplate.split('---')[0].trim();
        let acePrompt = fillTemplate(basePrompt, { 'CLOTHING_STYLE': clothingStylePrompt });

        // Add user traits (hair color, build, etc.) - ACE++ won't get these from face reference
        if (userTraits) {
          acePrompt += '\n\n' + userTraits;
        }

        log.debug(`🎨 [ACE++] Generating ${category} avatar with face reference`);
        log.debug(`🎨 [ACE++] Prompt length: ${acePrompt.length} chars`);

        const result = await generateAvatarWithACE(referencePhoto, acePrompt, {
          width: 768,
          height: 1024,
          identityStrength: 0.8
        });

        if (result?.imageData) {
          // Compress the result
          const compressed = await compressImageToJPEG(result.imageData, 85, 768);
          return compressed || result.imageData;
        }
        return null;
      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] ACE++ generation failed for ${category}:`, err.message);
        return null;
      }
    };

    // Helper function to generate a single avatar using Runware (FLUX) - text-to-image only
    const generateAvatarWithRunwareFLUX = async (category, avatarPrompt) => {
      try {
        if (!isRunwareConfigured()) {
          log.error(`❌ [CLOTHING AVATARS] Runware not configured`);
          return null;
        }

        // For FLUX, we need to include the reference image as IP-Adapter input
        // Build a simpler prompt since FLUX handles things differently
        const fluxPrompt = `Portrait illustration of a person, full body standing pose, facing forward, ${avatarPrompt}. Children's book illustration style, clean background, high quality.`;

        const result = await generateWithRunware(fluxPrompt, {
          model: 'runware:5@1',  // FLUX Schnell
          width: 576,  // 9:16 aspect ratio
          height: 1024,
          steps: 4,
          referenceImages: [referencePhoto]  // Reference body/face photo for IP-Adapter
        });

        if (result?.imageData) {
          // Compress the result
          const compressed = await compressImageToJPEG(result.imageData, 85, 768);
          return compressed || result.imageData;
        }
        return null;
      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] Runware FLUX generation failed for ${category}:`, err.message);
        return null;
      }
    };

    // Helper function to generate a single avatar
    const generateSingleAvatar = async (category, config) => {
      try {
        log.debug(`${config.emoji} [CLOTHING AVATARS] Generating ${category} avatar for ${name || 'unnamed'} (${gender || 'unknown'}), model: ${selectedModel}...`);

        // Build the prompt from template
        const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
        const clothingStylePrompt = getClothingStylePrompt(category, isFemale);
        log.debug(`   [CLOTHING] Style for ${category}: "${clothingStylePrompt}"`);
        let avatarPrompt = fillTemplate(promptPart, {
          'CLOTHING_STYLE': clothingStylePrompt
        });
        // Add user-specified clothing ONLY for standard avatar (not winter/summer)
        // Winter and summer should use their seasonal clothing styles
        if (userClothingSection && category === 'standard') {
          avatarPrompt += userClothingSection;
        }

        // Add user-specified physical traits to ALL avatar categories
        // Physical traits (hair color, eye color, etc.) should be consistent across all outfits
        if (userTraitsSection) {
          avatarPrompt += userTraitsSection;
        }

        // Grok branch — default. Edit endpoint accepts face photo as reference and
        // produces a clothing-variant avatar in one call, no IMAGE_OTHER rejections
        // on adult-face photos.
        if (useGrok) {
          const imageData = await generateAvatarWithGrok(category, avatarPrompt);
          if (imageData) {
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated via Grok`);
            return { category, prompt: avatarPrompt, imageData };
          } else {
            log.warn(`[CLOTHING AVATARS] Grok generation failed for ${category}`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        // Use ACE++ for face-consistent avatar generation
        // Uses optimized shorter prompt from avatar-ace-prompt.txt
        if (useACEPlusPlus) {
          const imageData = await generateAvatarWithACEPlusPlus(category, userTraitsSection);
          if (imageData) {
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated via ACE++`);
            return { category, prompt: avatarPrompt, imageData };
          } else {
            log.warn(`[CLOTHING AVATARS] ACE++ generation failed for ${category}`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        // Use Runware for other FLUX models (text-to-image only, no face consistency)
        if (useRunware && !useACEPlusPlus) {
          const imageData = await generateAvatarWithRunwareFLUX(category, clothingStylePrompt);
          if (imageData) {
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated via Runware FLUX`);
            return { category, prompt: avatarPrompt, imageData };
          } else {
            log.warn(`[CLOTHING AVATARS] Runware FLUX generation failed for ${category}`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        // Use Grok Imagine for grok models
        const useGrok = modelConfig?.backend === 'grok' || selectedModel.startsWith('grok-imagine');
        if (useGrok) {
          const { generateWithGrok, editWithGrok, isGrokConfigured, GROK_MODELS } = require('../lib/grok');
          if (isGrokConfigured()) {
            try {
              const grokModel = selectedModel === 'grok-imagine-pro' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD;
              // Use the body-clothed reference photo as input — Grok edits it.
              const refImages = [referencePhoto];
              const result = await editWithGrok(avatarPrompt, refImages, {
                model: grokModel,
                aspectRatio: '9:16',
                padInput: true,  // Same reason as the generateAvatarWithGrok path.
              });
              if (result.imageData) {
                log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated via Grok Imagine`);
                return { category, prompt: avatarPrompt, imageData: result.imageData, usage: result.usage };
              }
            } catch (grokError) {
              log.error(`❌ [CLOTHING AVATARS] Grok generation failed for ${category}: ${grokError.message}`);
              // Fall through to Gemini
            }
          }
        }

        // Gemini avatar gen — funnel through the shared callGeminiAvatarApi
        // helper so request setup / safety threshold / parse / token extract
        // logic isn't duplicated. Token tracking + safety-filter retry
        // (with the simplified avatarRetryPrompt) stay route-local because
        // they fold into `results.tokenUsage` and the per-category retry
        // policy is route-specific.
        const callOpts = {
          geminiApiKey,
          referenceImageBase64: base64Data,
          referenceMimeType: mimeType,
          prompt: avatarPrompt,
          modelId: geminiModelId,
          logTag: `[CLOTHING AVATARS] ${category}`,
        };
        const trackTokens = (modelId, input, output) => {
          if (input <= 0 && output <= 0) return;
          console.log(`📊 [AVATAR GENERATION] ${category} - model: ${modelId}, input: ${input.toLocaleString()}, output: ${output.toLocaleString()}`);
          if (!results.tokenUsage.byModel[modelId]) {
            results.tokenUsage.byModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
          }
          results.tokenUsage.byModel[modelId].input_tokens += input;
          results.tokenUsage.byModel[modelId].output_tokens += output;
          results.tokenUsage.byModel[modelId].calls += 1;
        };

        let geminiResult = await callGeminiAvatarApi(callOpts);
        trackTokens(selectedModel, geminiResult.inputTokens, geminiResult.outputTokens);

        if (geminiResult.blocked) {
          log.warn(`[CLOTHING AVATARS] ${category} blocked by safety filters: ${geminiResult.blockReason} — retrying with simplified prompt`);
          const outfitDescription = category === 'winter' ? 'a winter coat'
            : category === 'summer' ? 'a casual T-shirt and shorts'
              : 'casual clothes';
          const retryPrompt = fillTemplate(PROMPT_TEMPLATES.avatarRetryPrompt, {
            '{OUTFIT_DESCRIPTION}': outfitDescription
          });
          geminiResult = await callGeminiAvatarApi({ ...callOpts, prompt: retryPrompt, logTag: `[CLOTHING AVATARS] ${category} retry` });
          trackTokens(selectedModel, geminiResult.inputTokens, geminiResult.outputTokens);
          if (geminiResult.blocked) {
            log.warn(`[CLOTHING AVATARS] ${category} retry also blocked: ${geminiResult.blockReason}`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        if (!geminiResult.ok) {
          return { category, prompt: avatarPrompt, imageData: null };
        }
        const imageData = geminiResult.imageData;

        if (imageData) {
          // Compress avatar to JPEG
          try {
            const originalSize = Math.round(imageData.length / 1024);
            const compressedImage = await compressImageToJPEG(imageData);
            const compressedSize = Math.round(compressedImage.length / 1024);
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated and compressed (${originalSize}KB -> ${compressedSize}KB)`);

            // Extract face + body thumbnails from 2x2 grid for display (original image kept for generation)
            let faceThumbnail = null;
            let bodyThumbnail = null;
            try {
              const splitResult = await splitGridAndExtractFace(compressedImage);
              if (splitResult.success) {
                if (splitResult.faceThumbnail) {
                  faceThumbnail = splitResult.faceThumbnail;
                  log.debug(`✅ [CLOTHING AVATARS] ${category} face thumbnail extracted`);
                }
                if (splitResult.quadrants?.bodyFront) {
                  bodyThumbnail = splitResult.quadrants.bodyFront;
                  log.debug(`✅ [CLOTHING AVATARS] ${category} body thumbnail extracted`);
                }
              } else {
                log.warn(`[CLOTHING AVATARS] Thumbnail extraction failed for ${category}: ${splitResult.error || 'no thumbnail'}`);
              }
            } catch (splitErr) {
              log.warn(`[CLOTHING AVATARS] Split failed for ${category}:`, splitErr.message);
            }

            // Return original compressed image (unchanged) + optional face/body thumbnails
            return { category, prompt: avatarPrompt, imageData: compressedImage, faceThumbnail, bodyThumbnail };
          } catch (compressErr) {
            log.warn(`[CLOTHING AVATARS] Compression failed for ${category}, using original:`, compressErr.message);
            return { category, prompt: avatarPrompt, imageData };
          }
        } else {
          log.warn(`[CLOTHING AVATARS] No image in ${category} response`);
          return { category, prompt: avatarPrompt, imageData: null };
        }
      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] Error generating ${category}:`, err.message);
        return { category, prompt: null, imageData: null };
      }
    };

    // PHASE 1: Generate all clothing avatars in parallel (winter, standard, summer)
    const categoryCount = Object.keys(clothingCategories).length;
    log.debug(`🚀 [CLOTHING AVATARS] Generating ${categoryCount} avatars for ${name || 'unnamed'} in parallel...`);
    const generationStart = Date.now();
    const generationPromises = Object.entries(clothingCategories).map(
      ([category, config]) => generateSingleAvatar(category, config)
    );
    const generatedAvatars = await Promise.all(generationPromises);
    const generationTime = Date.now() - generationStart;
    log.debug(`⚡ [CLOTHING AVATARS] ${categoryCount} avatars generated in ${generationTime}ms (parallel)`);

    // Upload main avatars + thumbnails to R2 in parallel. R2 misconfig or
    // upload failure leaves URL undefined; the writer below then persists
    // inline as the fallback.
    //
    // `r2Version` (see comment in the async-job path above) is baked into
    // every R2 key for this regen so each run produces a fresh URL. Without
    // it, Cloudflare's edge cache + the browser HTTP cache continued to
    // serve the previous avatar bytes for hours after a regeneration,
    // making it look like the save failed.
    const r2Version = Date.now().toString(36);
    const r2Uploads = [];
    if (req.user?.id && validCharacterId) {
      for (const { category, imageData, faceThumbnail, bodyThumbnail } of generatedAvatars) {
        if (imageData) {
          r2Uploads.push(saveAvatarToR2(req.user.id, validCharacterId, category, imageData, r2Version)
            .then(url => ({ kind: 'main', category, url })));
        }
        if (faceThumbnail) {
          r2Uploads.push(saveAvatarThumbToR2(req.user.id, validCharacterId, 'face', category, faceThumbnail, r2Version)
            .then(url => ({ kind: 'face', category, url })));
        }
        if (bodyThumbnail) {
          r2Uploads.push(saveAvatarThumbToR2(req.user.id, validCharacterId, 'body', category, bodyThumbnail, r2Version)
            .then(url => ({ kind: 'body', category, url })));
        }
      }
    }
    const uploadResults = await Promise.all(r2Uploads);
    const mainUrls = new Map();
    const faceUrls = new Map();
    const bodyUrls = new Map();
    for (const { kind, category, url } of uploadResults) {
      if (!url) continue;
      if (kind === 'main') mainUrls.set(category, url);
      else if (kind === 'face') faceUrls.set(category, url);
      else if (kind === 'body') bodyUrls.set(category, url);
    }
    if (mainUrls.size + faceUrls.size + bodyUrls.size > 0) {
      log.info(`☁️  [CLOTHING AVATARS] R2 uploaded ${mainUrls.size} main + ${faceUrls.size} face + ${bodyUrls.size} body thumbs`);
    }

    // Store prompts, images, face thumbnails, and body thumbnails
    for (const { category, prompt, imageData, faceThumbnail, bodyThumbnail } of generatedAvatars) {
      if (prompt) results.prompts[category] = prompt;
      if (imageData) {
        // Store original 2x2 grid image (unchanged - used for story generation)
        results[category] = imageData;
        const mainUrl = mainUrls.get(category);
        if (mainUrl) results[`${category}Url`] = mainUrl;
        log.debug(`📦 [CLOTHING AVATARS] Stored ${category} avatar${mainUrl ? ' (+R2 url)' : ''}`);
      }
      // Store face thumbnail separately (for display only)
      if (faceThumbnail) {
        if (!results.faceThumbnails) results.faceThumbnails = {};
        results.faceThumbnails[category] = faceThumbnail;
        const u = faceUrls.get(category);
        if (u) {
          if (!results.faceThumbnailsUrl) results.faceThumbnailsUrl = {};
          results.faceThumbnailsUrl[category] = u;
        }
        log.debug(`📦 [CLOTHING AVATARS] Stored ${category} face thumbnail${u ? ' (+R2 url)' : ''}`);
      }
      // Store body thumbnail separately (for display only)
      if (bodyThumbnail) {
        if (!results.bodyThumbnails) results.bodyThumbnails = {};
        results.bodyThumbnails[category] = bodyThumbnail;
        const u = bodyUrls.get(category);
        if (u) {
          if (!results.bodyThumbnailsUrl) results.bodyThumbnailsUrl = {};
          results.bodyThumbnailsUrl[category] = u;
        }
        log.debug(`📦 [CLOTHING AVATARS] Stored ${category} body thumbnail${u ? ' (+R2 url)' : ''}`);
      }
    }

    // PHASE 2: Evaluate all generated avatars in parallel (optional, controlled by ENABLE_AVATAR_EVALUATION)
    if (ENABLE_AVATAR_EVALUATION) {
    const avatarsToEvaluate = generatedAvatars.filter(a => a.imageData);
    if (avatarsToEvaluate.length > 0) {
      log.debug(`🔍 [CLOTHING AVATARS] Starting PARALLEL evaluation of ${avatarsToEvaluate.length} avatars...`);
      const evalStart = Date.now();

      // Extract traits from ORIGINAL PHOTO (ground truth for face) in parallel with avatar evals
      const photoTraitsPromise = extractTraitsWithGemini(referencePhoto);

      // Use the dedicated face photo for face matching when available; the
      // body referencePhoto has too little face signal (see F2 comment in
      // the async/job path above).
      const faceRefSync = faceRefPhoto || referencePhoto;
      const evalPromises = avatarsToEvaluate.map(async ({ category, imageData }) => {
        const faceMatchResult = await evaluateAvatarFaceMatch(faceRefSync, imageData, geminiApiKey);
        return { category, faceMatchResult };
      });

      // Wait for both photo analysis and avatar evaluations (zero added latency)
      const [photoTraitsResult, ...evalResults] = await Promise.all([
        photoTraitsPromise,
        ...evalPromises
      ]);
      const evalTime = Date.now() - evalStart;
      log.debug(`⚡ [CLOTHING AVATARS] All evaluations completed in ${evalTime}ms (parallel)`);

      // Collect physical traits from ALL avatar evaluations for consensus voting
      const allAvatarTraits = [];

      // Store evaluation results
      for (const { category, faceMatchResult } of evalResults) {
        if (faceMatchResult) {
          results.faceMatch[category] = {
            score: faceMatchResult.score,
            details: faceMatchResult.details,
            lpips: faceMatchResult.lpips || null  // LPIPS comparison result
          };

          // Store full raw evaluation for dev mode (only from first result)
          if (faceMatchResult.raw && !results.rawEvaluation) {
            results.rawEvaluation = faceMatchResult.raw;
          }

          // Collect physical traits from ALL categories for consensus voting
          if (faceMatchResult.physicalTraits) {
            const traits = { ...faceMatchResult.physicalTraits };
            if (!traits.apparentAge) {
              if (traits.apparent_age) { traits.apparentAge = traits.apparent_age; delete traits.apparent_age; }
              else if (traits.age) { traits.apparentAge = traits.age; delete traits.age; }
            }
            allAvatarTraits.push(traits);
          }

          // Store structured clothing (from generated avatar)
          if (faceMatchResult.clothing) {
            // Check if it's structured (object) or legacy (string)
            if (typeof faceMatchResult.clothing === 'object') {
              results.structuredClothing[category] = faceMatchResult.clothing;
              // Also create legacy text version for backwards compatibility
              const clothingParts = [];
              if (faceMatchResult.clothing.fullBody) {
                clothingParts.push(faceMatchResult.clothing.fullBody);
              } else {
                if (faceMatchResult.clothing.upperBody) clothingParts.push(faceMatchResult.clothing.upperBody);
                if (faceMatchResult.clothing.lowerBody) clothingParts.push(faceMatchResult.clothing.lowerBody);
              }
              if (faceMatchResult.clothing.shoes) clothingParts.push(faceMatchResult.clothing.shoes);
              results.clothing[category] = clothingParts.join(', ');
              log.debug(`👕 [AVATAR EVAL] ${category} structured clothing: ${JSON.stringify(faceMatchResult.clothing)}`);
            } else {
              // Legacy string format
              results.clothing[category] = faceMatchResult.clothing;
              log.debug(`👕 [AVATAR EVAL] ${category} clothing: ${faceMatchResult.clothing}`);
            }
          }

          log.debug(`🔍 [AVATAR EVAL] ${category} score: ${faceMatchResult.score}/10`);
        }
      }

      // Apply consensus voting: photo traits (ground truth) + all avatar traits
      const photoTraits = photoTraitsResult?.traits || {};
      if (!photoTraits.apparentAge && photoTraits.apparent_age) {
        photoTraits.apparentAge = photoTraits.apparent_age;
        delete photoTraits.apparent_age;
      }
      if (photoTraits['distinctive markings'] && !photoTraits.other) {
        photoTraits.other = photoTraits['distinctive markings'];
      }

      if (allAvatarTraits.length > 0 || Object.keys(photoTraits).length > 0) {
        const { traits: consensusResult, sources } = consensusTraits(photoTraits, allAvatarTraits);
        results.extractedTraits = consensusResult;
        results.traitSources = sources;

        // Use detailedHairAnalysis from photo (ground truth), fall back to avatar
        results.extractedTraits.detailedHairAnalysis =
          photoTraitsResult?.detailedHairAnalysis ||
          photoTraitsResult?.traits?.detailedHairAnalysis ||
          evalResults.find(r => r.faceMatchResult?.detailedHairAnalysis)?.faceMatchResult.detailedHairAnalysis;

        // Clamp analyzed apparentAge to ±1 group of stated age (see avatar job
        // path for details). Trusts visual age normally but catches absurd
        // mis-analyses where the photo got read as the wrong life stage.
        const photoConfidence = photoTraitsResult?.confidence?.overallConfidence
          || photoTraitsResult?.traits?.confidence?.overallConfidence
          || null;
        const clampResult = clampApparentAge(consensusResult.apparentAge, age, photoConfidence);
        if (clampResult.clamped) {
          log.info(`[AGE CLAMP] ${name || characterId}: ${clampResult.reason}`);
          consensusResult.apparentAge = clampResult.category;
          sources.apparentAge = `${sources.apparentAge || 'photo'} → clamped`;
        } else {
          log.debug(`[AGE CLAMP] ${name || characterId}: ${clampResult.reason}`);
        }

        for (const [field, source] of Object.entries(sources)) {
          if (source.includes('photo')) {
            log.info(`📋 [CONSENSUS] ${field}: "${consensusResult[field]}" (${source})`);
          }
        }
        log.debug(`📋 [CLOTHING AVATARS] Consensus traits: apparentAge=${consensusResult.apparentAge}, build=${consensusResult.build}, hairDensity=${consensusResult.hairDensity || 'N/A'}`);
      } else {
        log.warn(`📋 [CLOTHING AVATARS] No traits from photo or avatars — skipping consensus`);
      }

      // PHASE 2b: Auto-retry categories with low face scores
      const lowScoreCategories = Object.entries(results.faceMatch)
        .filter(([, fm]) => fm.score != null && fm.score < MIN_BASE_AVATAR_SCORE)
        .map(([cat]) => cat);

      if (lowScoreCategories.length > 0) {
        log.debug(`🔄 [CLOTHING AVATARS] Retrying ${lowScoreCategories.length} low-score categories: ${lowScoreCategories.join(', ')}`);
        const retryStart = Date.now();

        const retryPromises = lowScoreCategories.map(async (category) => {
          const config = clothingCategories[category];
          if (!config) return null;

          const originalScore = results.faceMatch[category].score;
          log.debug(`🔄 [CLOTHING AVATARS] Retrying ${category} (score ${originalScore}/10 < ${MIN_BASE_AVATAR_SCORE})...`);

          // Regenerate
          const retryResult = await generateSingleAvatar(category, config);
          if (!retryResult?.imageData) {
            log.warn(`🔄 [CLOTHING AVATARS] Retry for ${category} produced no image — keeping original`);
            return null;
          }

          // Re-evaluate (use face crop for face match — see F2 comment above)
          const retryEval = await evaluateAvatarFaceMatch(faceRefSync, retryResult.imageData, geminiApiKey);
          const retryScore = retryEval?.score ?? 0;
          log.debug(`🔄 [CLOTHING AVATARS] Retry ${category}: new score ${retryScore}/10 (was ${originalScore}/10)`);

          if (retryScore > originalScore) {
            log.debug(`✅ [CLOTHING AVATARS] Retry improved ${category}: ${originalScore} → ${retryScore}`);
            return { category, retryResult, retryEval, retryScore, improved: true };
          } else {
            log.debug(`⏭️ [CLOTHING AVATARS] Retry did NOT improve ${category}: ${originalScore} → ${retryScore}, keeping original`);
            return null;
          }
        });

        const retryOutcomes = await Promise.all(retryPromises);

        for (const outcome of retryOutcomes) {
          if (!outcome?.improved) continue;
          const { category, retryResult, retryEval } = outcome;

          // Replace image + thumbnails
          results[category] = retryResult.imageData;
          if (retryResult.faceThumbnail) {
            if (!results.faceThumbnails) results.faceThumbnails = {};
            results.faceThumbnails[category] = retryResult.faceThumbnail;
          }
          if (retryResult.bodyThumbnail) {
            if (!results.bodyThumbnails) results.bodyThumbnails = {};
            results.bodyThumbnails[category] = retryResult.bodyThumbnail;
          }
          if (retryResult.prompt) results.prompts[category] = retryResult.prompt;

          // Replace evaluation
          results.faceMatch[category] = {
            score: retryEval.score,
            details: retryEval.details,
            lpips: retryEval.lpips || null
          };

          // Replace clothing if available
          if (retryEval.clothing && typeof retryEval.clothing === 'object') {
            results.structuredClothing[category] = retryEval.clothing;
            const clothingParts = [];
            if (retryEval.clothing.fullBody) {
              clothingParts.push(retryEval.clothing.fullBody);
            } else {
              if (retryEval.clothing.upperBody) clothingParts.push(retryEval.clothing.upperBody);
              if (retryEval.clothing.lowerBody) clothingParts.push(retryEval.clothing.lowerBody);
            }
            if (retryEval.clothing.shoes) clothingParts.push(retryEval.clothing.shoes);
            results.clothing[category] = clothingParts.join(', ');
          }
        }

        log.debug(`🔄 [CLOTHING AVATARS] Retry phase completed in ${Date.now() - retryStart}ms`);
      }

      // PHASE 3: Cross-avatar LPIPS/ArcFace comparison (optional, controlled by ENABLE_FACE_COMPARISON)
      // This helps verify consistency - avatars of same person should be similar
      // Skip when ENABLE_FACE_COMPARISON is false for faster generation
      if (ENABLE_FACE_COMPARISON) {
      // Extract faces from top-left quadrant of each avatar, then compare face-to-face
      const avatarImages = {};
      for (const { category, imageData } of avatarsToEvaluate) {
        if (imageData) avatarImages[category] = imageData;
      }

      const crossPairs = [
        ['winter', 'standard'],
        ['winter', 'summer'],
        ['standard', 'summer']
      ];

      // First, extract faces from all avatars in parallel
      const faceExtractionPromises = Object.entries(avatarImages).map(async ([category, imageData]) => {
        const result = await extractFace(imageData, 'top-left', 256);
        return { category, face: result?.face || null, detected: result?.faceDetected || false };
      });
      const extractedFaces = await Promise.all(faceExtractionPromises);
      const avatarFaces = {};
      for (const { category, face, detected } of extractedFaces) {
        if (face) {
          avatarFaces[category] = face;
          log.debug(`[LPIPS CROSS] Extracted face from ${category} (detected: ${detected})`);
        }
      }

      results.crossLpips = {};
      for (const [cat1, cat2] of crossPairs) {
        if (avatarFaces[cat1] && avatarFaces[cat2]) {
          // Compare extracted faces (no bbox needed - already face-only)
          const crossResult = await compareLPIPS(avatarFaces[cat1], avatarFaces[cat2]);
          if (crossResult?.success) {
            const pairKey = `${cat1}_vs_${cat2}`;
            results.crossLpips[pairKey] = crossResult.lpipsScore;
            console.log(`📊 [LPIPS CROSS] ${cat1} vs ${cat2}: ${crossResult.lpipsScore?.toFixed(4)} (${crossResult.interpretation}) [face-to-face]`);
          }
        }
      }

      // Cross-avatar ArcFace identity comparison (style-invariant)
      results.crossArcface = {};
      const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
      for (const [cat1, cat2] of crossPairs) {
        if (avatarFaces[cat1] && avatarFaces[cat2]) {
          try {
            const response = await fetch(`${photoAnalyzerUrl}/compare-identity`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                image1: avatarFaces[cat1],
                image2: avatarFaces[cat2]
              }),
              signal: AbortSignal.timeout(30000)
            });
            const arcResult = await response.json();
            if (arcResult?.success) {
              const pairKey = `${cat1}_vs_${cat2}`;
              results.crossArcface[pairKey] = {
                similarity: arcResult.similarity,
                samePerson: arcResult.same_person,
                confidence: arcResult.confidence
              };
              console.log(`📊 [ARCFACE CROSS] ${cat1} vs ${cat2}: ${arcResult.similarity?.toFixed(4)} (${arcResult.confidence}, same_person: ${arcResult.same_person})`);
            }
          } catch (err) {
            log.warn(`[ARCFACE CROSS] Failed ${cat1} vs ${cat2}:`, err.message);
          }
        }
      }
      } // end if (ENABLE_FACE_COMPARISON) - PHASE 3
    } // end if (avatarsToEvaluate.length > 0)
    } else {
      log.debug(`⏭️ [CLOTHING AVATARS] Skipping avatar evaluation (ENABLE_AVATAR_EVALUATION=false)`);
    } // end if (ENABLE_AVATAR_EVALUATION)

    log.debug(`✅ [CLOTHING AVATARS] Total time: ${Date.now() - generationStart}ms`)

    // Check if standard avatar was generated
    if (!results.standard) {
      return res.status(500).json({ error: 'Failed to generate avatar' });
    }

    results.status = 'complete';
    results.generatedAt = new Date().toISOString();

    // Log avatar generation to activity log
    const avatarsGenerated = Object.keys(clothingCategories).filter(cat => results[cat]).length;
    const evaluationsRun = Object.keys(results.faceMatch).length;
    try {
      await logActivity(req.user.id, req.user.username, 'AVATAR_GENERATED', {
        characterId,
        characterName: name,
        model: selectedModel,
        backend: useRunware ? 'runware' : 'gemini',
        avatarsGenerated,
        evaluationsRun,
        tokenUsage: results.tokenUsage,
        // Runware cost: $0.0006 per image
        estimatedCost: useRunware ? avatarsGenerated * 0.0006 : null
      });
    } catch (activityErr) {
      log.warn('Failed to log avatar generation activity:', activityErr.message);
    }

    // Store token usage and extracted traits in character data
    const hasTokenUsage = Object.keys(results.tokenUsage?.byModel || {}).length > 0;
    const hasExtractedData = results.extractedTraits || results.structuredClothing;
    if (characterId && (hasTokenUsage || hasExtractedData)) {
      try {
        // Get current character data and accumulate token usage
        const charResult = await dbQuery(
          `SELECT id, data FROM characters WHERE user_id = $1`,
          [req.user.id]
        );

        // Note: dbQuery returns rows array directly, not { rows: [...] }
        if (charResult?.[0]) {
          const rowId = charResult[0].id;
          const data = typeof charResult[0].data === 'string'
            ? JSON.parse(charResult[0].data)
            : charResult[0].data;

          // Find the character and update its data
          const characters = data.characters || [];
          let charIndex = characters.findIndex(c => c.id === characterId || c.id === parseInt(characterId));

          // Fallback: find by name if ID match fails
          if (charIndex < 0 && name) {
            const availableIds = characters.map(c => `${c.name}(${c.id})`).join(', ');
            log.debug(`💾 [CLOTHING AVATARS] Character ID ${characterId} not found, available: [${availableIds}], trying name fallback...`);
            charIndex = characters.findIndex(c => c.name === name);
            if (charIndex >= 0) {
              log.info(`📍 [CLOTHING AVATARS] Found character "${name}" by name fallback at index ${charIndex} (ID mismatch: wanted ${characterId}, found ${characters[charIndex].id})`);
            }
          }

          // Warn if character still not found
          if (charIndex < 0) {
            const availableChars = characters.map(c => `${c.name}(${c.id})`).join(', ');
            log.warn(`⚠️ [CLOTHING AVATARS] CHARACTER NOT FOUND! Wanted ID: ${characterId}, name: "${name}". Available: [${availableChars}]. Avatars generated but NOT saved to DB!`);
          }

          if (charIndex >= 0) {
            // Use ATOMIC updates to prevent race conditions with concurrent saves
            // Instead of read-modify-write on entire document, use jsonb_set for each field

            // URL-only writer (Phase 5). Inline base64 only persists when
            // R2 upload returned no URL — readers expect URL field.
            // onlyIfNoUrl / onlyMissingThumbs are hoisted to module scope.
            const fbThumbs = onlyMissingThumbs(results.faceThumbnails, results.faceThumbnailsUrl);
            const bbThumbs = onlyMissingThumbs(results.bodyThumbnails, results.bodyThumbnailsUrl);
            const newAvatarData = {
              status: 'complete',
              generatedAt: new Date().toISOString(),
              ...(fbThumbs && { faceThumbnails: fbThumbs }),
              ...(bbThumbs && { bodyThumbnails: bbThumbs }),
              ...(onlyIfNoUrl(results.standard, results.standardUrl) && { standard: results.standard }),
              ...(onlyIfNoUrl(results.winter, results.winterUrl) && { winter: results.winter }),
              ...(onlyIfNoUrl(results.summer, results.summerUrl) && { summer: results.summer }),
              ...(results.standardUrl && { standardUrl: results.standardUrl }),
              ...(results.winterUrl && { winterUrl: results.winterUrl }),
              ...(results.summerUrl && { summerUrl: results.summerUrl }),
              ...(results.faceThumbnailsUrl && { faceThumbnailsUrl: results.faceThumbnailsUrl }),
              ...(results.bodyThumbnailsUrl && { bodyThumbnailsUrl: results.bodyThumbnailsUrl }),
              ...(results.clothing && { clothing: results.clothing }),
              // Dev-mode diagnostics persisted (mirrors async-path persistence).
              ...(results.prompts && Object.keys(results.prompts).length > 0 && { prompts: results.prompts }),
              ...(results.faceMatch && Object.keys(results.faceMatch).length > 0 && { faceMatch: results.faceMatch }),
              ...(results.extractedTraits && { extractedTraits: results.extractedTraits }),
              ...(results.structuredClothing && Object.keys(results.structuredClothing).length > 0 && { structuredClothing: results.structuredClothing }),
            };

            // Lightweight metadata: prefer URL standard slot, fall back to inline only when missing.
            const stdFace = results.faceThumbnailsUrl?.standard || results.faceThumbnails?.standard;
            const stdBody = results.bodyThumbnailsUrl?.standard || results.bodyThumbnails?.standard;
            const lightAvatarData = {
              status: 'complete',
              generatedAt: newAvatarData.generatedAt,
              hasFullAvatars: true,
              faceThumbnails: stdFace ? { standard: stdFace } : undefined,
              bodyThumbnails: stdBody ? { standard: stdBody } : undefined,
              clothing: results.clothing,
            };

            // Build atomic update SQL with all field updates
            let dataUpdate = 'data';
            let metaUpdate = 'metadata';
            const params = [rowId]; // $1 = rowId
            let paramIndex = 2;

            // Avatar data - merge with existing at SQL level
            if (results.standard || results.winter || results.summer) {
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},avatars}', COALESCE(data->'characters'->${charIndex}->'avatars', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},avatars}', $${paramIndex + 1}::jsonb, true)`;
              params.push(JSON.stringify(newAvatarData), JSON.stringify(lightAvatarData));
              paramIndex += 2;
              log.debug(`💾 [CLOTHING AVATARS] Applied avatar data including faceThumbnails`);
            }

            // Extracted traits - write to canonical physical.* structure
            // Respect user-edited fields — don't overwrite them with AI extraction
            if (results.extractedTraits) {
              const t = results.extractedTraits;
              const existingChar = characters[charIndex] || {};
              const existingSources = existingChar.physicalTraitsSource || {};

              // Build physical object with only non-null values, skipping user-edited fields
              const physical = {};
              const traitSources = {};

              const setTrait = (field, value) => {
                if (value && existingSources[field] !== 'user') {
                  physical[field] = value;
                  traitSources[field] = 'extracted';
                }
              };

              setTrait('apparentAge', t.apparentAge);
              setTrait('build', t.build);
              setTrait('eyeColor', t.eyeColor);
              setTrait('hairColor', t.hairColor);
              setTrait('skinTone', t.skinTone);
              setTrait('skinToneHex', t.skinToneHex);
              setTrait('facialHair', t.facialHair);
              setTrait('face', t.face);
              setTrait('other', t.other);
              setTrait('glasses', t.glasses);
              setTrait('eyeColorHex', t.eyeColorHex);
              setTrait('hairColorHex', t.hairColorHex);
              // Hair shape — extraction baseline gets refreshed; userHairOverride
              // stays permanent across regenerations (see same-named comment
              // in the parallel call site above).
              if (t.detailedHairAnalysis && existingSources['hairType'] !== 'user') {
                physical.detailedHairAnalysis = t.detailedHairAnalysis;
              }

              // Merge with existing physical object
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},physical}', COALESCE(data->'characters'->${charIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},physical}', COALESCE(metadata->'characters'->${charIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(physical));
              paramIndex += 1;

              // Persist trait sources (merge with existing, preserving 'user' entries)
              if (Object.keys(traitSources).length > 0) {
                dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},physicalTraitsSource}', COALESCE(data->'characters'->${charIndex}->'physicalTraitsSource', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
                metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},physicalTraitsSource}', COALESCE(metadata->'characters'->${charIndex}->'physicalTraitsSource', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
                params.push(JSON.stringify(traitSources));
                paramIndex += 1;
              }

              log.debug(`💾 [CLOTHING AVATARS] Applied extracted traits to character.physical: apparentAge=${t.apparentAge}`);
            }

            // Structured clothing
            if (results.structuredClothing?.standard) {
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},structuredClothing}', $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},structuredClothing}', $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(results.structuredClothing.standard));
              paramIndex += 1;
              log.debug(`💾 [CLOTHING AVATARS] Applied extracted clothing to character`);
            }

            // Token usage - merge with existing at SQL level
            if (hasTokenUsage) {
              const newUsage = { byModel: {}, lastUpdated: new Date().toISOString() };
              for (const [modelId, usage] of Object.entries(results.tokenUsage.byModel)) {
                newUsage.byModel[modelId] = {
                  input_tokens: usage.input_tokens || 0,
                  output_tokens: usage.output_tokens || 0,
                  calls: usage.calls || 0
                };
              }
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},avatarTokenUsage}', COALESCE(data->'characters'->${charIndex}->'avatarTokenUsage', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(newUsage));
              paramIndex += 1;
            }

            // Execute atomic update
            const updateQuery = `UPDATE characters SET data = ${dataUpdate}, metadata = ${metaUpdate} WHERE id = $1`;
            await dbQuery(updateQuery, params);

            // Log summary
            if (hasTokenUsage) {
              const totalCalls = Object.values(results.tokenUsage.byModel).reduce((sum, u) => sum + u.calls, 0);
              const models = Object.keys(results.tokenUsage.byModel).join(', ');
              log.debug(`📊 [AVATAR TOKENS] Stored usage for character ${characterId}: ${totalCalls} calls using ${models}`);
            }
            if (results.extractedTraits) {
              log.debug(`📊 [AVATAR TRAITS] Saved to DB: apparentAge=${results.extractedTraits.apparentAge}, build=${results.extractedTraits.build}`);
            }
            results.dbSaveSuccessful = true;
          }
        }
      } catch (dbErr) {
        log.error(`❌ [CLOTHING AVATARS] Failed to save to database:`, dbErr.message);
        results.dbSaveSuccessful = false;
        throw new Error(`Database save failed: ${dbErr.message}`);
      }
    }

    // Ensure dbSaveSuccessful is set (true if we got here without error)
    if (results.dbSaveSuccessful === undefined) results.dbSaveSuccessful = true;

    log.debug(`✅ [CLOTHING AVATARS] Generated standard avatar for ${name || 'unnamed'}`);
    // Log extracted traits for debugging
    if (results.extractedTraits) {
      log.debug(`📋 [CLOTHING AVATARS] Response extractedTraits: ${JSON.stringify(results.extractedTraits).substring(0, 200)}...`);
      log.debug(`💇 [CLOTHING AVATARS] Response detailedHairAnalysis: ${results.extractedTraits.detailedHairAnalysis ? JSON.stringify(results.extractedTraits.detailedHairAnalysis) : 'NOT PRESENT'}`);
    } else {
      log.warn(`⚠️ [CLOTHING AVATARS] No extractedTraits in response!`);
    }
    res.json({ success: true, clothingAvatars: results });

  } catch (err) {
    log.error('Error generating clothing avatars:', err);
    res.status(500).json({ error: 'Failed to generate clothing avatars', details: err.message });
  }
});

/**
 * GET /api/avatar-jobs/:jobId
 * Get the status/result of an async avatar generation job
 */
router.get('/avatar-jobs/:jobId', authenticateToken, async (req, res) => {
  const { jobId } = req.params;
  const job = avatarJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' });
  }

  // Verify ownership
  if (job.userId !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized to view this job' });
  }

  // Return job status
  if (job.status === 'pending' || job.status === 'processing') {
    return res.json({
      jobId,
      status: job.status,
      progress: job.progress || 0,
      message: job.message || 'Processing...'
    });
  }

  if (job.status === 'complete') {
    // Don't delete on read — let the expiry cleanup handle it.
    // Deleting on first read causes "Job not found" errors when the client
    // re-polls (React StrictMode, component re-mount, network retry).
    return res.json({
      jobId,
      status: 'complete',
      success: true,
      clothingAvatars: job.result
    });
  }

  if (job.status === 'failed') {
    return res.json({
      jobId,
      status: 'failed',
      success: false,
      error: job.error
    });
  }

  res.json({ jobId, status: job.status });
});

module.exports = router;
module.exports.getCostumedAvatarGenerationLog = getCostumedAvatarGenerationLog;
module.exports.clearCostumedAvatarGenerationLog = clearCostumedAvatarGenerationLog;
module.exports.evaluateAvatarFaceMatch = evaluateAvatarFaceMatch;
module.exports.avatarJobs = avatarJobs; // Export for testing
module.exports.processAvatarJobInBackground = processAvatarJobInBackground;
module.exports.getClothingStylePrompt = getClothingStylePrompt;
module.exports.extractTraitsWithGemini = extractTraitsWithGemini;
