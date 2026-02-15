/**
 * Avatar Routes
 *
 * Photo analysis, avatar generation, and face matching endpoints.
 * Extracted from server.js for better code organization.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { logActivity, dbQuery } = require('../services/database');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { compressImageToJPEG } = require('../lib/images');
const { IMAGE_MODELS } = require('../config/models');
const { generateWithRunware, generateAvatarWithACE, isRunwareConfigured } = require('../lib/runware');
const { buildHairDescription, getAgeCategory } = require('../lib/storyHelpers');
const { getFacePhoto } = require('../lib/characterPhotos');

// ============================================================================
// COSTUMED AVATAR GENERATION LOG (for developer mode auditing)
// ============================================================================

// Generation log for developer mode auditing
// Tracks all costumed avatar generations with inputs, prompts, outputs, timing
let costumedAvatarGenerationLog = [];

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
 * Get the costumed avatar generation log for developer mode auditing
 */
function getCostumedAvatarGenerationLog() {
  return [...costumedAvatarGenerationLog];
}

/**
 * Clear the costumed avatar generation log
 */
function clearCostumedAvatarGenerationLog() {
  const count = costumedAvatarGenerationLog.length;
  costumedAvatarGenerationLog = [];
  log.debug(`🗑️ [COSTUMED AVATARS] Generation log cleared (${count} entries)`);
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
            maxOutputTokens: 2048,
            responseMimeType: 'application/json'
          }
        }),
        signal: AbortSignal.timeout(20000)
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
        // Always include raw response for debugging
        const rawResponse = text;
        if (result.traits) {
          log.debug('📸 [GEMINI] Extracted traits:', result.traits);
          return { ...result, _rawResponse: rawResponse };
        } else {
          log.debug('📸 [GEMINI] Extracted traits (flat format):', result);
          return { traits: result, _rawResponse: rawResponse };
        }
      } else {
        log.error('📸 [GEMINI] No JSON found in response:', text.substring(0, 200));
        return { _rawResponse: text, _error: 'No JSON found in response' };
      }
    } else {
      log.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
      return { _rawResponse: JSON.stringify(data), _error: 'Unexpected response structure' };
    }
    return null;
  } catch (err) {
    log.error('📸 [GEMINI] Trait extraction error:', err.message);
    return null;
  }
}

/**
 * Evaluate face match between original photo and generated avatar
 * Also extracts physical traits and clothing from the generated avatar
 * Runs both Gemini LLM evaluation AND LPIPS perceptual comparison
 * Returns { score, details, physicalTraits, clothing, lpips } or null on error
 */
async function evaluateAvatarFaceMatch(originalPhoto, generatedAvatar, geminiApiKey) {
  try {
    const originalBase64 = originalPhoto.replace(/^data:image\/\w+;base64,/, '');
    const originalMime = originalPhoto.match(/^data:(image\/\w+);base64,/) ?
      originalPhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    const avatarBase64 = generatedAvatar.replace(/^data:image\/\w+;base64,/, '');
    const avatarMime = generatedAvatar.match(/^data:(image\/\w+);base64,/) ?
      generatedAvatar.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const evalPrompt = PROMPT_TEMPLATES.avatarEvaluation || 'Compare these two faces. Rate similarity 1-10. Output: FINAL SCORE: [number]';

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

    log.debug(`🔍 [AVATAR EVAL] Raw response: ${responseText.substring(0, 300)}${responseText.length > 300 ? '...' : ''}`);

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

      if (typeof score === 'number' && score >= 1 && score <= 10) {
        const fm = faceMatch;
        const details = [
          `Face Shape: ${fm.faceShape?.score}/10 - ${fm.faceShape?.reason}`,
          `Eyes: ${fm.eyes?.score}/10 - ${fm.eyes?.reason}`,
          `Nose: ${fm.nose?.score}/10 - ${fm.nose?.reason}`,
          `Mouth: ${fm.mouth?.score}/10 - ${fm.mouth?.reason}`,
          `Overall: ${fm.overallStructure?.score}/10 - ${fm.overallStructure?.reason}`,
          `Final Score: ${score}/10`
        ].join('\n');

        log.debug(`🔍 [AVATAR EVAL] Score: ${score}/10`);
        if (lpipsResult) {
          log.debug(`🔍 [AVATAR EVAL] LPIPS: ${lpipsResult.lpipsScore?.toFixed(4)} (${lpipsResult.interpretation})`);
        }
        if (arcfaceResult) {
          log.debug(`🔍 [AVATAR EVAL] ArcFace: ${arcfaceResult.similarity?.toFixed(4)} (${arcfaceResult.interpretation}, same_person: ${arcfaceResult.samePerson})`);
        }
        if (physicalTraits) {
          log.debug(`🔍 [AVATAR EVAL] Extracted traits: ${JSON.stringify(physicalTraits).substring(0, 100)}...`);
        }
        if (clothing) {
          log.debug(`🔍 [AVATAR EVAL] Extracted clothing: ${JSON.stringify(clothing)}`);
        }
        if (detailedHairAnalysis) {
          log.debug(`💇 [AVATAR EVAL] Detailed hair: ${JSON.stringify(detailedHairAnalysis)}`);
        }

        return { score, details, physicalTraits, clothing, detailedHairAnalysis, lpips: lpipsResult, arcface: arcfaceResult, raw: evalResult };
      }
    } catch (parseErr) {
      log.warn(`[AVATAR EVAL] JSON parse failed, trying text fallback: ${parseErr.message}`);
      const scoreMatch = responseText.match(/finalScore["']?\s*:\s*(\d+)/i);
      if (scoreMatch) {
        const score = parseInt(scoreMatch[1], 10);
        return { score, details: responseText, physicalTraits: null, clothing: null, lpips: lpipsResult, arcface: arcfaceResult };
      }
    }

    return null;
  } catch (err) {
    log.error('[AVATAR EVAL] Error evaluating face match:', err.message);
    return null;
  }
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
  } else if (category === 'formal') {
    tag = isFemale ? '[FORMAL_FEMALE]' : '[FORMAL_MALE]';
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
    // Build the prompt
    const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingPrompt = getDynamicClothingPrompt(category, config, isFemale);
    const avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingPrompt
    });

    // Prepare image data - resize to avoid Gemini IMAGE_OTHER errors
    const photoSizeKB = Math.round(facePhoto.length / 1024);
    log.debug(`🎭 [DYNAMIC AVATAR] Input photo: ${photoSizeKB}KB`);

    const sharp = require('sharp');
    const base64Input = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const resizedPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.debug(`🎭 [DYNAMIC AVATAR] Resized to ${Math.round(resizedPhoto.length / 1024)}KB (was ${photoSizeKB}KB)`);

    const base64Data = resizedPhoto.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = 'image/jpeg'; // Always JPEG after resize

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

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [DYNAMIC AVATAR] ${logCategory} generation failed:`, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    let data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [DYNAMIC AVATAR] ${logCategory} - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    // Check if blocked by safety filters
    if (data.promptFeedback?.blockReason) {
      log.warn(`[DYNAMIC AVATAR] ${logCategory} blocked by safety filters:`, data.promptFeedback.blockReason);
      return { success: false, error: `Blocked by safety filters: ${data.promptFeedback.blockReason}` };
    }

    // Extract image from response
    let imageData = null;
    if (data.candidates && data.candidates[0]?.content?.parts) {
      for (const part of data.candidates[0].content.parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const imgMime = part.inlineData.mimeType;
          imageData = `data:${imgMime};base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (!imageData) {
      log.error(`❌ [DYNAMIC AVATAR] No image in response for ${logCategory}`);
      return { success: false, error: 'No image generated' };
    }

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
  if (traits.facialHair && traits.facialHair !== 'none' && traits.facialHair !== 'clean-shaven') {
    parts.push(`Facial hair: ${traits.facialHair}`);
  }
  if (traits.skinTone) parts.push(`Skin tone: ${traits.skinTone}`);
  if (traits.other && traits.other !== 'none') {
    parts.push(`Other features: ${traits.other}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'Match reference photo exactly';
}

/**
 * Generate a styled costumed avatar in a single API call
 * Combines costume transformation + art style conversion
 *
 * @param {Object} character - Character object with photoUrl, physicalTraits, etc.
 * @param {Object} config - { costume: string, description: string }
 * @param {string} artStyle - Art style ID (pixar, watercolor, oil, etc.)
 * @returns {Promise<Object>} - { success, imageData, clothing, costumeType, artStyle, error? }
 */
async function generateStyledCostumedAvatar(character, config, artStyle) {
  const startTime = Date.now();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log.error('[STYLED COSTUME] No Gemini API key available');
    return { success: false, error: 'Avatar generation service unavailable' };
  }

  // Get standard avatar as primary reference (has correct face + proportions)
  // Fall back to face photo if standard avatar isn't available
  const hasAvatars = !!character.avatars;
  const hasStandard = !!character.avatars?.standard;
  const hasPhotos = !!character.photos;

  log.debug(`[STYLED COSTUME] ${character.name} data check: avatars=${hasAvatars}, standard=${hasStandard}, photos=${hasPhotos}`);

  let standardAvatar = character.avatars?.standard;

  // Handle case where avatar is stored as object {data: '...', mimeType: '...'}
  if (standardAvatar && typeof standardAvatar === 'object' && standardAvatar.data) {
    standardAvatar = standardAvatar.data;
  }

  // Check if it's a valid string
  if (!standardAvatar || typeof standardAvatar !== 'string') {
    // Fallback: use face photo if standard avatar doesn't exist or isn't a string
    let facePhoto = getFacePhoto(character);

    // Handle object format for photos too
    if (facePhoto && typeof facePhoto === 'object' && facePhoto.data) {
      facePhoto = facePhoto.data;
    }

    if (facePhoto && typeof facePhoto === 'string') {
      log.warn(`[STYLED COSTUME] ${character.name}: No valid standard avatar found, using face photo as fallback`);
      standardAvatar = facePhoto;
    } else {
      log.error(`[STYLED COSTUME] No valid standard avatar or face photo for ${character.name} (got ${typeof standardAvatar})`);
      return { success: false, error: 'No reference image available - generate clothing avatars or upload photo first' };
    }
  } else {
    log.debug(`[STYLED COSTUME] ${character.name}: Using standard avatar (${Math.round(standardAvatar.length / 1024)}KB)`);
  }

  const costumeType = (config.costume || 'costume').toLowerCase();
  // Use character-specific art style (without scene elements like "rainy streets")
  // Fall back to scene art style if character version doesn't exist
  const characterArtStyle = `${artStyle}-character`;
  const artStylePrompt = ART_STYLE_PROMPTS[characterArtStyle] || ART_STYLE_PROMPTS[artStyle] || ART_STYLE_PROMPTS['pixar-character'] || '';
  log.debug(`[STYLED COSTUME] Using art style: ${ART_STYLE_PROMPTS[characterArtStyle] ? characterArtStyle : artStyle}`);

  log.debug(`🎨 [STYLED COSTUME] Generating ${costumeType} avatar in ${artStyle} style for ${character.name}`);

  try {
    // Build the combined prompt using the styled-costumed-avatar template
    const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
    const avatarPrompt = fillTemplate(template, {
      'ART_STYLE_PROMPT': artStylePrompt,
      'COSTUME_DESCRIPTION': config.description || 'A creative costume appropriate for the story',
      'COSTUME_TYPE': config.costume || 'Costume',
      'PHYSICAL_TRAITS': buildPhysicalTraitsForAvatar(character)
    });

    // Prepare standard avatar data as the only reference
    const avatarBase64 = standardAvatar.replace(/^data:image\/\w+;base64,/, '');
    const avatarMimeType = standardAvatar.match(/^data:(image\/\w+);base64,/) ?
      standardAvatar.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build image parts array with only the standard avatar
    const imageParts = [
      {
        inline_data: {
          mime_type: avatarMimeType,
          data: avatarBase64
        }
      }
    ];

    // System instruction - top row keeps reference style, bottom row gets new style
    const systemText = `You are an expert character artist creating avatar illustrations for children's books.
You are given a reference avatar.
Your task is to create a 2x2 grid:
- TOP ROW: EXACT copies of the reference face (same style as reference), just zoomed in to show face only
- BOTTOM ROW: Full body in NEW ${artStyle} style wearing the specified costume
- The TOP ROW must keep the ORIGINAL reference style - do NOT change it
- Only the BOTTOM ROW gets the new ${artStyle} style
- All 4 images must show the SAME person`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemText }]
      },
      contents: [{
        parts: [
          ...imageParts,
          { text: avatarPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.5,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "1:1"  // Square for 2x2 grid
        }
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
      ]
    };

    // Retry loop for costume application issues
    const MAX_COSTUME_RETRIES = 2;
    let finalImageData = null;
    let costumeEvalResult = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_COSTUME_RETRIES; attempt++) {
      const attemptStart = Date.now();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        log.error(`❌ [STYLED COSTUME] Generation failed (attempt ${attempt}):`, errorText);
        lastError = `API error: ${response.status}`;
        continue;
      }

      let data = await response.json();

      // Log token usage
      const inputTokens = data.usageMetadata?.promptTokenCount || 0;
      const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
      if (inputTokens > 0 || outputTokens > 0) {
        console.log(`📊 [STYLED COSTUME] ${costumeType}@${artStyle} attempt ${attempt} - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
      }

      // Check if blocked by safety filters
      if (data.promptFeedback?.blockReason) {
        log.warn(`[STYLED COSTUME] Blocked by safety filters:`, data.promptFeedback.blockReason);
        lastError = `Blocked by safety filters: ${data.promptFeedback.blockReason}`;
        continue;
      }

      // Extract image from response
      let imageData = null;
      if (data.candidates && data.candidates[0]?.content?.parts) {
        for (const part of data.candidates[0].content.parts) {
          if (part.inlineData?.mimeType?.startsWith('image/')) {
            const imgMime = part.inlineData.mimeType;
            imageData = `data:${imgMime};base64,${part.inlineData.data}`;
            break;
          }
        }
      }

      if (!imageData) {
        log.error(`❌ [STYLED COSTUME] No image in response (attempt ${attempt})`);
        lastError = 'No image generated';
        continue;
      }

      // Compress the avatar
      const compressed = await compressImageToJPEG(imageData, 85, 768);
      finalImageData = compressed || imageData;

      // Evaluate costume application (check both bottom row images have costume)
      if (ENABLE_AVATAR_EVALUATION) {
        costumeEvalResult = await evaluateCostumeApplication(
          finalImageData,
          config.description || config.costume || 'costume',
          geminiApiKey
        );

        if (!costumeEvalResult.pass && costumeEvalResult.confidence === 'high') {
          log.warn(`👔 [STYLED COSTUME] Costume check FAILED (attempt ${attempt}): ${costumeEvalResult.reason}`);
          if (attempt < MAX_COSTUME_RETRIES) {
            log.info(`🔄 [STYLED COSTUME] Retrying due to costume mismatch...`);
            continue;
          } else {
            log.warn(`⚠️ [STYLED COSTUME] Max retries reached, using last generated image despite costume issue`);
          }
        } else {
          log.debug(`👔 [STYLED COSTUME] Costume check passed (attempt ${attempt}): ${costumeEvalResult.reason}`);
        }
      }

      // Success - break out of retry loop
      const attemptDuration = Date.now() - attemptStart;
      log.debug(`✅ [STYLED COSTUME] Image generated in ${attemptDuration}ms (attempt ${attempt})`);
      break;
    }

    if (!finalImageData) {
      log.error(`❌ [STYLED COSTUME] All attempts failed`);
      return { success: false, error: lastError || 'Failed to generate image' };
    }

    // Evaluate face match to get clothing description (optional)
    // Use standardAvatar as reference (it contains the face we're matching against)
    let clothingDescription = null;
    if (ENABLE_AVATAR_EVALUATION) {
      const faceMatchResult = await evaluateAvatarFaceMatch(standardAvatar, finalImageData, geminiApiKey);
      if (faceMatchResult?.clothing) {
        clothingDescription = faceMatchResult.clothing;
        log.debug(`👕 [STYLED COSTUME] Clothing extracted: ${JSON.stringify(clothingDescription)}`);
      }
    }

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED COSTUME] Generated ${costumeType}@${artStyle} avatar for ${character.name} in ${duration}ms`);

    // Log generation details for developer mode auditing
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType,
      artStyle,
      costumeDescription: config.description || '',
      durationMs: duration,
      success: true,
      costumeEvaluation: costumeEvalResult ? {
        pass: costumeEvalResult.pass,
        confidence: costumeEvalResult.confidence,
        reason: costumeEvalResult.reason,
        details: costumeEvalResult.details
      } : null,
      inputs: {
        // standardAvatar is used as the reference image (contains face + body)
        referenceAvatar: {
          identifier: getImageIdentifier(standardAvatar),
          sizeKB: getImageSizeKB(standardAvatar),
          imageData: standardAvatar
        }
      },
      prompt: avatarPrompt,
      output: {
        identifier: getImageIdentifier(finalImageData),
        sizeKB: getImageSizeKB(finalImageData),
        imageData: finalImageData
      }
    });

    return {
      success: true,
      imageData: finalImageData,
      clothing: clothingDescription,
      costumeType: costumeType,
      artStyle: artStyle
    };

  } catch (err) {
    const duration = Date.now() - startTime;
    log.error(`❌ [STYLED COSTUME] Error:`, err.message);

    // Log failed generation
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType,
      artStyle,
      costumeDescription: config.description || '',
      durationMs: duration,
      success: false,
      error: err.message,
      inputs: {
        // standardAvatar is used as the reference image (contains face + body)
        referenceAvatar: standardAvatar ? {
          identifier: getImageIdentifier(standardAvatar),
          sizeKB: getImageSizeKB(standardAvatar),
          imageData: standardAvatar
        } : null
      }
    });

    return { success: false, error: err.message };
  }
}

/**
 * Generate a styled avatar with signature items in a single API call
 * Similar to generateStyledCostumedAvatar but for standard/winter/summer with signature additions
 * Takes the base category avatar and adds signature items while styling
 *
 * @param {Object} character - Character object with avatars
 * @param {string} category - 'standard', 'winter', or 'summer'
 * @param {Object} config - { signature?: string } - signature items to add
 * @param {string} artStyle - Art style ID (pixar, watercolor, oil, etc.)
 * @returns {Promise<Object>} - { success, imageData, clothing, category, artStyle, error? }
 */
async function generateStyledAvatarWithSignature(character, category, config, artStyle) {
  const startTime = Date.now();
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    log.error('[STYLED SIGNATURE] No Gemini API key available');
    return { success: false, error: 'Avatar generation service unavailable' };
  }

  // Get avatar for the specified category as reference (has correct face + body + base clothing)
  const hasAvatars = !!character.avatars;
  const hasCategory = !!character.avatars?.[category];
  const hasStandard = !!character.avatars?.standard;
  const hasPhotos = !!character.photos;
  const hasFace = !!character.photos?.face;

  log.debug(`[STYLED SIGNATURE] ${character.name} data check: avatars=${hasAvatars}, ${category}=${hasCategory}, standard=${hasStandard}, photos=${hasPhotos}, face=${hasFace}`);

  // Priority: category avatar > standard avatar > face photo
  // Avatars are always strings (clothing stored separately)
  let baseAvatar = character.avatars?.[category];
  if (!baseAvatar) {
    baseAvatar = character.avatars?.standard;
    if (baseAvatar) {
      log.warn(`[STYLED SIGNATURE] ${character.name}: No ${category} avatar found, using standard avatar as fallback`);
    }
  }
  if (!baseAvatar) {
    const facePhoto = getFacePhoto(character);
    if (facePhoto) {
      log.warn(`[STYLED SIGNATURE] ${character.name}: No ${category} or standard avatar found, using face photo as fallback`);
      baseAvatar = facePhoto;
    } else {
      log.error(`[STYLED SIGNATURE] No ${category} avatar, standard avatar, or face photo for ${character.name}`);
      return { success: false, error: `No reference image available - generate clothing avatars or upload photo first` };
    }
  } else {
    log.debug(`[STYLED SIGNATURE] ${character.name}: Using ${category} avatar (${Math.round(baseAvatar.length / 1024)}KB)`);
  }

  // Get art style prompt
  const characterArtStyle = `${artStyle}-character`;
  const artStylePrompt = ART_STYLE_PROMPTS[characterArtStyle] || ART_STYLE_PROMPTS[artStyle] || ART_STYLE_PROMPTS['pixar-character'] || '';
  log.debug(`[STYLED SIGNATURE] Using art style: ${ART_STYLE_PROMPTS[characterArtStyle] ? characterArtStyle : artStyle}`);

  // Build clothing description: base clothing + signature items
  const isFemale = character.gender === 'female';
  const baseClothing = character.avatars?.clothing?.[category] || getClothingStylePrompt(category, isFemale);
  const clothingWithSignature = config.signature && config.signature.toLowerCase() !== 'none'
    ? `${baseClothing}, plus this signature element: ${config.signature}`
    : baseClothing;

  log.debug(`🎨 [STYLED SIGNATURE] Generating ${category} avatar with signature in ${artStyle} style for ${character.name}`);

  try {
    // Build the combined prompt using the styled-costumed-avatar template
    // (same template works for both costumes and signature items)
    const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
    const avatarPrompt = fillTemplate(template, {
      'ART_STYLE_PROMPT': artStylePrompt,
      'COSTUME_DESCRIPTION': clothingWithSignature,  // Clothing + signature items
      'COSTUME_TYPE': `${category} outfit`,  // e.g., "winter outfit" instead of "Cowboy"
      'PHYSICAL_TRAITS': buildPhysicalTraitsForAvatar(character)
    });

    // Prepare base avatar data as the only reference
    const avatarBase64 = baseAvatar.replace(/^data:image\/\w+;base64,/, '');
    const avatarMimeType = baseAvatar.match(/^data:(image\/\w+);base64,/) ?
      baseAvatar.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build image parts array
    const imageParts = [
      {
        inline_data: {
          mime_type: avatarMimeType,
          data: avatarBase64
        }
      }
    ];

    // System instruction - top row keeps reference style, bottom row gets new style
    const systemText = `You are an expert character artist creating avatar illustrations for children's books.
You are given a reference avatar.
Your task is to create a 2x2 grid:
- TOP ROW: EXACT copies of the reference face (same style as reference), just zoomed in to show face only
- BOTTOM ROW: Full body in NEW ${artStyle} style wearing the specified outfit with signature items
- The TOP ROW must keep the ORIGINAL reference style - do NOT change it
- Only the BOTTOM ROW gets the new ${artStyle} style
- All 4 images must show the SAME person
- Signature items must be prominently visible in the bottom row`;

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemText }]
      },
      contents: [{
        parts: [
          ...imageParts,
          { text: avatarPrompt }
        ]
      }],
      generationConfig: {
        temperature: 0.5,
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: "1:1"  // Square for 2x2 grid
        }
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
      ]
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [STYLED SIGNATURE] Generation failed:`, errorText);
      return { success: false, error: `API error: ${response.status}` };
    }

    let data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (inputTokens > 0 || outputTokens > 0) {
      console.log(`📊 [STYLED SIGNATURE] ${category}@${artStyle} - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
    }

    // Check if blocked by safety filters
    if (data.promptFeedback?.blockReason) {
      log.warn(`[STYLED SIGNATURE] Blocked by safety filters:`, data.promptFeedback.blockReason);
      return { success: false, error: `Blocked by safety filters: ${data.promptFeedback.blockReason}` };
    }

    // Extract image from response
    let imageData = null;
    if (data.candidates && data.candidates[0]?.content?.parts) {
      for (const part of data.candidates[0].content.parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          const imgMime = part.inlineData.mimeType;
          imageData = `data:${imgMime};base64,${part.inlineData.data}`;
          break;
        }
      }
    }

    if (!imageData) {
      log.error(`❌ [STYLED SIGNATURE] No image in response`);
      return { success: false, error: 'No image generated' };
    }

    // Compress the avatar
    const compressed = await compressImageToJPEG(imageData, 85, 768);
    const finalImageData = compressed || imageData;

    // Evaluate face match to get clothing description (optional)
    let clothingDescription = null;
    if (ENABLE_AVATAR_EVALUATION) {
      const faceMatchResult = await evaluateAvatarFaceMatch(baseAvatar, finalImageData, geminiApiKey);
      if (faceMatchResult?.clothing) {
        clothingDescription = faceMatchResult.clothing;
        log.debug(`👕 [STYLED SIGNATURE] Clothing extracted: ${JSON.stringify(clothingDescription)}`);
      }
    }

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED SIGNATURE] Generated ${category}@${artStyle} avatar with signature for ${character.name} in ${duration}ms`);

    // Log generation details for developer mode auditing (reuse costumed log)
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType: `${category}+signature`,
      artStyle,
      costumeDescription: clothingWithSignature,
      signature: config.signature || null,
      durationMs: duration,
      success: true,
      inputs: {
        referenceAvatar: {
          identifier: getImageIdentifier(baseAvatar),
          sizeKB: getImageSizeKB(baseAvatar),
          imageData: baseAvatar
        }
      },
      prompt: avatarPrompt,
      output: {
        identifier: getImageIdentifier(finalImageData),
        sizeKB: getImageSizeKB(finalImageData),
        imageData: finalImageData
      }
    });

    return {
      success: true,
      imageData: finalImageData,
      clothing: clothingDescription,
      category: category,
      signature: config.signature || null,
      artStyle: artStyle
    };

  } catch (err) {
    const duration = Date.now() - startTime;
    log.error(`❌ [STYLED SIGNATURE] Error:`, err.message);

    // Log failed generation
    costumedAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName: character.name,
      costumeType: `${category}+signature`,
      artStyle,
      signature: config.signature || null,
      durationMs: duration,
      success: false,
      error: err.message,
      inputs: {
        referenceAvatar: baseAvatar ? {
          identifier: getImageIdentifier(baseAvatar),
          sizeKB: getImageSizeKB(baseAvatar),
          imageData: baseAvatar
        } : null
      }
    });

    return { success: false, error: err.message };
  }
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

        // Get existing characters for this user
        const existingResult = await dbQuery(
          'SELECT data FROM characters WHERE id = $1',
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
            log.warn(`📸 [PHOTO] Existing character ${characterId} not found in DB, will be updated by avatar job`);
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

        // Upsert the characters row
        await dbQuery(`
          INSERT INTO characters (id, user_id, data, metadata)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (id) DO UPDATE SET data = $3, metadata = $4
        `, [rowId, req.user.id, JSON.stringify(charData), JSON.stringify({ characters: characters.map(c => ({ id: c.id, name: c.name })) })]);
      } catch (dbErr) {
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

    const { characterId, facePhoto, physicalDescription, name, age, apparentAge, gender, build, physicalTraits, clothing, avatarModel } = bodyParams;

    // Import the actual generation logic (reuse from sync path)
    // For now, we'll make a simplified version that calls the same helpers

    const selectedModel = avatarModel || 'gemini-2.5-flash-image';
    const modelConfig = IMAGE_MODELS[selectedModel];
    const useRunware = modelConfig?.backend === 'runware' || selectedModel === 'flux-schnell';
    const geminiModelId = modelConfig?.modelId || 'gemini-2.5-flash-image';
    const isFemale = gender === 'female';

    log.debug(`👔 [AVATAR JOB ${jobId}] Starting background generation for ${name || 'unnamed'} (id: ${characterId}), model: ${selectedModel}`);

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

    // Log photo info to understand what's being sent
    const photoSizeKB = Math.round(facePhoto.length / 1024);
    const isPNG = facePhoto.startsWith('data:image/png');
    log.info(`[AVATAR JOB ${jobId}] 📸 Input photo: ${photoSizeKB}KB, format: ${isPNG ? 'PNG' : 'JPEG'}`);

    // LOCALHOST FIX: If photo is large JPEG (likely unprocessed original), try to remove background
    // Production processes photos during upload (creates bodyNoBg), but localhost may not have MediaPipe
    // This ensures avatar generation works even with unprocessed photos
    let processedFacePhoto = facePhoto;
    if (!isPNG && photoSizeKB > 50) {
      log.info(`[AVATAR JOB ${jobId}] 🔄 Photo appears unprocessed (JPEG ${photoSizeKB}KB), attempting background removal...`);
      try {
        const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
        const analyzeResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: facePhoto,
            extract_face: true,
            extract_body: false,
            remove_background: true
          })
        });

        if (analyzeResponse.ok) {
          const analyzeData = await analyzeResponse.json();
          // Prefer face thumbnail (processed, background on peach), then body with no bg
          const processedPhoto = analyzeData.faceThumbnail || analyzeData.face_thumbnail ||
                                 analyzeData.bodyNoBg || analyzeData.body_no_bg;
          if (processedPhoto) {
            const processedSize = Math.round(processedPhoto.length / 1024);
            log.info(`[AVATAR JOB ${jobId}] ✅ Got processed photo from analyzer: ${processedSize}KB`);
            processedFacePhoto = processedPhoto;
          } else {
            log.warn(`[AVATAR JOB ${jobId}] ⚠️ Analyzer returned no processed photo, using original`);
          }
        } else {
          log.warn(`[AVATAR JOB ${jobId}] ⚠️ Photo analyzer returned ${analyzeResponse.status}, using original`);
        }
      } catch (analyzerErr) {
        log.warn(`[AVATAR JOB ${jobId}] ⚠️ Photo analyzer error: ${analyzerErr.message}, using original`);
      }
    }

    // Prepare base64 data - ALWAYS resize photos for Gemini to avoid IMAGE_OTHER errors
    // Gemini works better with smaller images (tested: 13KB works, 90KB fails)
    log.info(`[AVATAR JOB ${jobId}] Resizing photo (${processedFacePhoto.length} chars) for Gemini...`);

    // Force resize to 512px max dimension - this bypasses the 100KB skip threshold in compressImageToJPEG
    const sharp = require('sharp');
    const base64Input = processedFacePhoto.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const finalPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.info(`[AVATAR JOB ${jobId}] Resized to ${finalPhoto.length} chars (was ${processedFacePhoto.length})`);
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
      if (physicalTraits.hairLength) traitLines.push(`- Hair length: ${physicalTraits.hairLength}`);
      if (physicalTraits.hairStyle) traitLines.push(`- Hair style: ${physicalTraits.hairStyle}`);
      if (physicalTraits.build) traitLines.push(`- Body build: ${physicalTraits.build}`);
      if (physicalTraits.skinTone) traitLines.push(`- Skin tone: ${physicalTraits.skinTone}`);
      if (physicalTraits.face) traitLines.push(`- Face shape: ${physicalTraits.face}`);
      if (physicalTraits.facialHair) traitLines.push(`- Facial hair: ${physicalTraits.facialHair}`);
      if (physicalTraits.other) traitLines.push(`- Other: ${physicalTraits.other}`);
      if (traitLines.length > 0) {
        userTraitsSection = `\n\nPHYSICAL TRAIT CORRECTIONS (CRITICAL - MUST APPLY):\n${traitLines.join('\n')}`;
      }
    }

    job.progress = 20;
    job.message = 'Generating winter, standard, summer avatars...';

    // Generate avatars (simplified - uses Gemini API directly)
    const generationStart = Date.now();

    // Helper to generate single avatar with Gemini
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

    job.progress = 70;
    job.message = 'Evaluating generated avatars...';

    // Store results, extract faceThumbnails, and aggregate token usage
    for (const { category, imageData, prompt, inputTokens, outputTokens } of generatedAvatars) {
      if (prompt) results.prompts[category] = prompt;

      // Aggregate token usage by model
      if (inputTokens > 0 || outputTokens > 0) {
        if (!results.tokenUsage.byModel[geminiModelId]) {
          results.tokenUsage.byModel[geminiModelId] = { input_tokens: 0, output_tokens: 0 };
        }
        results.tokenUsage.byModel[geminiModelId].input_tokens += inputTokens;
        results.tokenUsage.byModel[geminiModelId].output_tokens += outputTokens;
      }

      if (imageData) {
        results[category] = imageData;
        // Extract face thumbnail from 2x2 grid (same as sync endpoint)
        try {
          const splitResult = await splitGridAndExtractFace(imageData);
          if (splitResult.success && splitResult.faceThumbnail) {
            if (!results.faceThumbnails) results.faceThumbnails = {};
            results.faceThumbnails[category] = splitResult.faceThumbnail;
            log.debug(`✅ [AVATAR JOB ${jobId}] Extracted ${category} face thumbnail`);
          }
        } catch (err) {
          log.warn(`[AVATAR JOB ${jobId}] Face thumbnail extraction failed for ${category}: ${err.message}`);
        }
      }
    }

    // Run evaluation on ALL avatars in parallel to extract clothing for each (optional)
    if (ENABLE_AVATAR_EVALUATION) {
    const avatarsToEvaluate = generatedAvatars.filter(a => a.imageData);
    log.debug(`🔍 [AVATAR JOB ${jobId}] Checking evaluation: avatarsToEvaluate=${avatarsToEvaluate.length}, geminiApiKey=${!!geminiApiKey}`);
    if (avatarsToEvaluate.length > 0 && geminiApiKey) {
      log.debug(`🔍 [AVATAR JOB ${jobId}] Starting PARALLEL evaluation of ${avatarsToEvaluate.length} avatars...`);
      job.progress = 80;
      job.message = 'Extracting traits and clothing...';

      try {
        // Evaluate all avatars in parallel
        const evalPromises = avatarsToEvaluate.map(async ({ category, imageData }) => {
          const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, imageData, geminiApiKey);
          return { category, faceMatchResult };
        });
        const evalResults = await Promise.all(evalPromises);

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

          // Only extract physical traits from standard avatar (same traits for all)
          if (category === 'standard' && faceMatchResult.physicalTraits) {
            results.extractedTraits = faceMatchResult.physicalTraits;
            // Normalize apparentAge field names
            if (!results.extractedTraits.apparentAge) {
              if (results.extractedTraits.apparent_age) {
                results.extractedTraits.apparentAge = results.extractedTraits.apparent_age;
                delete results.extractedTraits.apparent_age;
                log.debug(`📋 [AVATAR JOB] Normalized 'apparent_age' to 'apparentAge': ${results.extractedTraits.apparentAge}`);
              } else if (results.extractedTraits.age) {
                results.extractedTraits.apparentAge = results.extractedTraits.age;
                delete results.extractedTraits.age;
                log.debug(`📋 [AVATAR JOB] Normalized 'age' to 'apparentAge': ${results.extractedTraits.apparentAge}`);
              }
            }
            if (faceMatchResult.detailedHairAnalysis) {
              results.extractedTraits.detailedHairAnalysis = faceMatchResult.detailedHairAnalysis;
            }
            log.debug(`📋 [AVATAR JOB] Extracted traits: apparentAge=${results.extractedTraits.apparentAge}, build=${results.extractedTraits.build}`);
          }
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

            // Build avatar data for full data column
            // NOTE: We intentionally DON'T spread old avatars here - we use SQL-level merge below
            // to avoid race conditions with stale in-memory data
            const newAvatarData = {
              status: 'complete',
              generatedAt: new Date().toISOString(),
              ...(results.faceThumbnails && { faceThumbnails: results.faceThumbnails }),
              ...(results.standard && { standard: results.standard }),
              ...(results.winter && { winter: results.winter }),
              ...(results.summer && { summer: results.summer }),
              ...(results.clothing && { clothing: results.clothing }),
            };

            // Build lightweight avatar data for metadata column
            const lightAvatarData = {
              status: 'complete',
              generatedAt: newAvatarData.generatedAt,
              hasFullAvatars: true,
              faceThumbnails: results.faceThumbnails?.standard ? { standard: results.faceThumbnails.standard } : undefined,
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
            if (results.extractedTraits) {
              const t = results.extractedTraits;
              // Build physical object with only non-null values
              const physical = {};
              if (t.apparentAge) physical.apparentAge = t.apparentAge;
              if (t.build) physical.build = t.build;
              if (t.eyeColor) physical.eyeColor = t.eyeColor;
              if (t.hairColor) physical.hairColor = t.hairColor;
              if (t.hairLength) physical.hairLength = t.hairLength;
              if (t.hairStyle) physical.hairStyle = t.hairStyle;
              if (t.skinTone) physical.skinTone = t.skinTone;
              if (t.skinToneHex) physical.skinToneHex = t.skinToneHex;
              if (t.facialHair) physical.facialHair = t.facialHair;
              if (t.face) physical.other = t.face;
              if (t.other) physical.other = t.other;
              if (t.detailedHairAnalysis) physical.detailedHairAnalysis = t.detailedHairAnalysis;

              // Merge with existing physical object
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},physical}', COALESCE(data->'characters'->${freshCharIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},physical}', COALESCE(metadata->'characters'->${freshCharIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(physical));
              paramIndex += 1;
            }

            // Structured clothing
            if (results.structuredClothing?.standard) {
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${freshCharIndex},structured_clothing}', $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${freshCharIndex},structured_clothing}', $${paramIndex}::jsonb, true)`;
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
          throw new Error(`Character not found by ID ${characterId} or name "${name}" after 10 retries - cannot save avatars`);
        }
      } catch (dbErr) {
        log.error(`❌ [AVATAR JOB ${jobId}] Failed to save avatars to database:`, dbErr.message);
        results.dbSaveSuccessful = false;
        throw new Error(`Database save failed: ${dbErr.message}`);
      }
    }

    results.status = 'complete';
    results.generatedAt = new Date().toISOString();
    // Ensure dbSaveSuccessful is set (true if we got here without error)
    if (results.dbSaveSuccessful === undefined) results.dbSaveSuccessful = true;

    if (!results.standard) {
      throw new Error('Failed to generate standard avatar');
    }

    job.status = 'complete';
    job.progress = 100;
    job.message = 'Avatar generation complete';
    job.result = results;

    log.debug(`✅ [AVATAR JOB ${jobId}] Completed in ${Date.now() - generationStart}ms`);

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
    const { characterId, facePhoto, physicalDescription, name, age, apparentAge, gender, build, physicalTraits, clothing, avatarModel } = req.body;
    const asyncMode = req.query.async === 'true' || req.body.async === true;

    if (!facePhoto) {
      return res.status(400).json({ error: 'Missing facePhoto' });
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

      // Update body with validated characterId for background processing
      const validatedBody = { ...req.body, characterId: validCharacterId };

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
    const selectedModel = avatarModel || 'gemini-2.5-flash-image';
    const modelConfig = IMAGE_MODELS[selectedModel];
    const useRunware = modelConfig?.backend === 'runware' || selectedModel === 'flux-schnell';
    const geminiModelId = modelConfig?.modelId || 'gemini-2.5-flash-image';

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name || 'unnamed'} (id: ${characterId}), model: ${selectedModel}, backend: ${useRunware ? 'runware' : 'gemini'}`);

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
    const photoSizeKB = Math.round(facePhoto.length / 1024);
    const isPNG = facePhoto.startsWith('data:image/png');
    log.info(`👔 [CLOTHING AVATARS] 📸 Input photo: ${photoSizeKB}KB, format: ${isPNG ? 'PNG' : 'JPEG'}`);

    // Force resize to 512px max dimension for Gemini
    const sharp = require('sharp');
    const base64Input = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const resizedPhoto = `data:image/jpeg;base64,${resizedBuffer.toString('base64')}`;
    log.info(`👔 [CLOTHING AVATARS] Resized to ${resizedPhoto.length} chars (was ${facePhoto.length})`);

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
      if (physicalTraits.hairLength) traitLines.push(`- Hair length: ${physicalTraits.hairLength}`);
      if (physicalTraits.hairStyle) traitLines.push(`- Hair style: ${physicalTraits.hairStyle}`);
      if (physicalTraits.build) traitLines.push(`- Body build: ${physicalTraits.build}`);
      if (physicalTraits.skinTone) traitLines.push(`- Skin tone: ${physicalTraits.skinTone}`);
      if (physicalTraits.face) traitLines.push(`- Face shape: ${physicalTraits.face}`);
      if (physicalTraits.facialHair) traitLines.push(`- Facial hair: ${physicalTraits.facialHair}`);
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

        const result = await generateAvatarWithACE(facePhoto, acePrompt, {
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
          referenceImages: [facePhoto]  // Use face photo as reference
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

        // Use Gemini for Gemini models
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

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          log.error(`❌ [CLOTHING AVATARS] ${category} generation failed:`, errorText);
          return { category, prompt: avatarPrompt, imageData: null };
        }

        let data = await response.json();

        // Track token usage for cost tracking (per model)
        const avatarModelId = selectedModel;
        const avatarInputTokens = data.usageMetadata?.promptTokenCount || 0;
        const avatarOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        if (avatarInputTokens > 0 || avatarOutputTokens > 0) {
          console.log(`📊 [AVATAR GENERATION] ${category} - model: ${avatarModelId}, input: ${avatarInputTokens.toLocaleString()}, output: ${avatarOutputTokens.toLocaleString()}`);
          // Accumulate tokens per model for accurate cost tracking
          if (!results.tokenUsage.byModel[avatarModelId]) {
            results.tokenUsage.byModel[avatarModelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
          }
          results.tokenUsage.byModel[avatarModelId].input_tokens += avatarInputTokens;
          results.tokenUsage.byModel[avatarModelId].output_tokens += avatarOutputTokens;
          results.tokenUsage.byModel[avatarModelId].calls += 1;
        }

        // Check if blocked by safety filters - retry with simplified prompt
        if (data.promptFeedback?.blockReason) {
          log.warn(`[CLOTHING AVATARS] ${category} blocked by safety filters:`, data.promptFeedback.blockReason);
          log.debug(`🔄 [CLOTHING AVATARS] Retrying ${category} with simplified prompt...`);

          const outfitDescription = category === 'winter' ? 'a winter coat' : category === 'summer' ? 'a casual T-shirt and shorts' : category === 'formal' ? 'formal attire' : 'casual clothes';
          const retryPrompt = fillTemplate(PROMPT_TEMPLATES.avatarRetryPrompt, {
            '{OUTFIT_DESCRIPTION}': outfitDescription
          });

          const retryRequestBody = {
            ...requestBody,
            contents: [{
              parts: [
                requestBody.contents[0].parts[0],
                { text: retryPrompt }
              ]
            }]
          };

          const retryResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${geminiApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(retryRequestBody)
            }
          );

          if (retryResponse.ok) {
            data = await retryResponse.json();
            const retryInputTokens = data.usageMetadata?.promptTokenCount || 0;
            const retryOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
            if (retryInputTokens > 0 || retryOutputTokens > 0) {
              console.log(`📊 [AVATAR GENERATION] ${category} retry - model: ${avatarModelId}, input: ${retryInputTokens.toLocaleString()}, output: ${retryOutputTokens.toLocaleString()}`);
              // Accumulate retry tokens per model
              if (!results.tokenUsage.byModel[avatarModelId]) {
                results.tokenUsage.byModel[avatarModelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
              }
              results.tokenUsage.byModel[avatarModelId].input_tokens += retryInputTokens;
              results.tokenUsage.byModel[avatarModelId].output_tokens += retryOutputTokens;
              results.tokenUsage.byModel[avatarModelId].calls += 1;
            }
            if (data.promptFeedback?.blockReason) {
              log.warn(`[CLOTHING AVATARS] ${category} retry also blocked:`, data.promptFeedback.blockReason);
              return { category, prompt: avatarPrompt, imageData: null };
            }
          } else {
            log.error(`❌ [CLOTHING AVATARS] ${category} retry failed`);
            return { category, prompt: avatarPrompt, imageData: null };
          }
        }

        // Extract image from response
        let imageData = null;
        if (data.candidates && data.candidates[0]?.content?.parts) {
          for (const part of data.candidates[0].content.parts) {
            if (part.inlineData) {
              imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (imageData) {
          // Compress avatar to JPEG
          try {
            const originalSize = Math.round(imageData.length / 1024);
            const compressedImage = await compressImageToJPEG(imageData);
            const compressedSize = Math.round(compressedImage.length / 1024);
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated and compressed (${originalSize}KB -> ${compressedSize}KB)`);

            // Extract face thumbnail from 2x2 grid for display (original image kept for generation)
            let faceThumbnail = null;
            try {
              const splitResult = await splitGridAndExtractFace(compressedImage);
              if (splitResult.success && splitResult.faceThumbnail) {
                faceThumbnail = splitResult.faceThumbnail;
                log.debug(`✅ [CLOTHING AVATARS] ${category} face thumbnail extracted`);
              } else {
                log.warn(`[CLOTHING AVATARS] Face thumbnail extraction failed for ${category}: ${splitResult.error || 'no thumbnail'}`);
              }
            } catch (splitErr) {
              log.warn(`[CLOTHING AVATARS] Split failed for ${category}:`, splitErr.message);
            }

            // Return original compressed image (unchanged) + optional face thumbnail
            return { category, prompt: avatarPrompt, imageData: compressedImage, faceThumbnail };
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

    // Store prompts, images, and face thumbnails
    for (const { category, prompt, imageData, faceThumbnail } of generatedAvatars) {
      if (prompt) results.prompts[category] = prompt;
      if (imageData) {
        // Store original 2x2 grid image (unchanged - used for story generation)
        results[category] = imageData;
        log.debug(`📦 [CLOTHING AVATARS] Stored ${category} avatar`);
      }
      // Store face thumbnail separately (for display only)
      if (faceThumbnail) {
        if (!results.faceThumbnails) results.faceThumbnails = {};
        results.faceThumbnails[category] = faceThumbnail;
        log.debug(`📦 [CLOTHING AVATARS] Stored ${category} face thumbnail`);
      }
    }

    // PHASE 2: Evaluate all generated avatars in parallel (optional, controlled by ENABLE_AVATAR_EVALUATION)
    if (ENABLE_AVATAR_EVALUATION) {
    const avatarsToEvaluate = generatedAvatars.filter(a => a.imageData);
    if (avatarsToEvaluate.length > 0) {
      log.debug(`🔍 [CLOTHING AVATARS] Starting PARALLEL evaluation of ${avatarsToEvaluate.length} avatars...`);
      const evalStart = Date.now();
      const evalPromises = avatarsToEvaluate.map(async ({ category, imageData }) => {
        const faceMatchResult = await evaluateAvatarFaceMatch(facePhoto, imageData, geminiApiKey);
        return { category, faceMatchResult };
      });
      const evalResults = await Promise.all(evalPromises);
      const evalTime = Date.now() - evalStart;
      log.debug(`⚡ [CLOTHING AVATARS] All evaluations completed in ${evalTime}ms (parallel)`);

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

          // Store extracted physical traits (from generated avatar - reflects user corrections)
          if (faceMatchResult.physicalTraits && !results.extractedTraits) {
            results.extractedTraits = faceMatchResult.physicalTraits;
            // Normalize apparentAge: AI might return different field names
            // Handle: 'apparent_age' (snake_case) or 'age' instead of 'apparentAge'
            if (!results.extractedTraits.apparentAge) {
              if (results.extractedTraits.apparent_age) {
                // AI returned snake_case version
                results.extractedTraits.apparentAge = results.extractedTraits.apparent_age;
                delete results.extractedTraits.apparent_age;
                log.debug(`📋 [AVATAR EVAL] Normalized 'apparent_age' to 'apparentAge': ${results.extractedTraits.apparentAge}`);
              } else if (results.extractedTraits.age) {
                // AI returned simple 'age'
                results.extractedTraits.apparentAge = results.extractedTraits.age;
                delete results.extractedTraits.age;
                log.debug(`📋 [AVATAR EVAL] Normalized 'age' to 'apparentAge': ${results.extractedTraits.apparentAge}`);
              }
            }
            // Include detailed hair analysis if available
            if (faceMatchResult.detailedHairAnalysis) {
              results.extractedTraits.detailedHairAnalysis = faceMatchResult.detailedHairAnalysis;
              log.debug(`💇 [AVATAR EVAL] Stored detailed hair: lengthTop=${faceMatchResult.detailedHairAnalysis.lengthTop}, lengthSides=${faceMatchResult.detailedHairAnalysis.lengthSides}, bangs=${faceMatchResult.detailedHairAnalysis.bangsEndAt}`);
            }
            log.debug(`📋 [AVATAR EVAL] Extracted traits from avatar: apparentAge=${results.extractedTraits.apparentAge}, build=${results.extractedTraits.build}`);
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

            // Build avatar data for full data column (don't spread stale in-memory data)
            const newAvatarData = {
              status: 'complete',
              generatedAt: new Date().toISOString(),
              ...(results.faceThumbnails && { faceThumbnails: results.faceThumbnails }),
              ...(results.standard && { standard: results.standard }),
              ...(results.winter && { winter: results.winter }),
              ...(results.summer && { summer: results.summer }),
              ...(results.clothing && { clothing: results.clothing }),
            };

            // Build lightweight avatar data for metadata column
            const lightAvatarData = {
              status: 'complete',
              generatedAt: newAvatarData.generatedAt,
              hasFullAvatars: true,
              faceThumbnails: results.faceThumbnails?.standard ? { standard: results.faceThumbnails.standard } : undefined,
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
            if (results.extractedTraits) {
              const t = results.extractedTraits;
              // Build physical object with only non-null values
              const physical = {};
              if (t.apparentAge) physical.apparentAge = t.apparentAge;
              if (t.build) physical.build = t.build;
              if (t.eyeColor) physical.eyeColor = t.eyeColor;
              if (t.hairColor) physical.hairColor = t.hairColor;
              if (t.hairLength) physical.hairLength = t.hairLength;
              if (t.hairStyle) physical.hairStyle = t.hairStyle;
              if (t.skinTone) physical.skinTone = t.skinTone;
              if (t.skinToneHex) physical.skinToneHex = t.skinToneHex;
              if (t.facialHair) physical.facialHair = t.facialHair;
              if (t.face) physical.other = t.face;
              if (t.other) physical.other = t.other;
              if (t.detailedHairAnalysis) physical.detailedHairAnalysis = t.detailedHairAnalysis;

              // Merge with existing physical object
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},physical}', COALESCE(data->'characters'->${charIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},physical}', COALESCE(metadata->'characters'->${charIndex}->'physical', '{}'::jsonb) || $${paramIndex}::jsonb, true)`;
              params.push(JSON.stringify(physical));
              paramIndex += 1;
              log.debug(`💾 [CLOTHING AVATARS] Applied extracted traits to character.physical: apparentAge=${t.apparentAge}`);
            }

            // Structured clothing
            if (results.structuredClothing?.standard) {
              dataUpdate = `jsonb_set(${dataUpdate}, '{characters,${charIndex},structured_clothing}', $${paramIndex}::jsonb, true)`;
              metaUpdate = `jsonb_set(${metaUpdate}, '{characters,${charIndex},structured_clothing}', $${paramIndex}::jsonb, true)`;
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
    // Return the result and delete the job
    const result = job.result;
    avatarJobs.delete(jobId);
    return res.json({
      jobId,
      status: 'complete',
      success: true,
      clothingAvatars: result
    });
  }

  if (job.status === 'failed') {
    const error = job.error;
    avatarJobs.delete(jobId);
    return res.json({
      jobId,
      status: 'failed',
      success: false,
      error
    });
  }

  res.json({ jobId, status: job.status });
});

module.exports = router;
module.exports.generateDynamicAvatar = generateDynamicAvatar;
module.exports.generateStyledCostumedAvatar = generateStyledCostumedAvatar;
module.exports.generateStyledAvatarWithSignature = generateStyledAvatarWithSignature;
module.exports.getCostumedAvatarGenerationLog = getCostumedAvatarGenerationLog;
module.exports.clearCostumedAvatarGenerationLog = clearCostumedAvatarGenerationLog;
module.exports.avatarJobs = avatarJobs; // Export for testing
