/**
 * Image Generation Module
 * Handles image generation, quality evaluation, editing, and retry logic
 * Extracted from server.js for maintainability
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const crypto = require('crypto');
const pLimit = require('p-limit');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { generateWithRunware, isRunwareConfigured, RUNWARE_MODELS } = require('./runware');
const { generateWithGrok, editWithGrok, isGrokConfigured, packReferences, cropToFrontColumn, GROK_MODELS } = require('./grok');
const { MODEL_PRICING } = require('../config/models');
const { getCurrentLogger } = require('./generationLogger');
const r2Lib = require('./r2');
// Analyzer URL + in-flight cap now live in photoAnalyzerClient.js — shared
// with figure detection, compositing and garmentColourFix (one definition).
const { photoAnalyzerUrl: _photoAnalyzerUrl, withAnalyzerSlot } = require('./photoAnalyzerClient');
// sanitizeIssueForInpaint moved to imageCompositing.js with the rest of the
// mask/edit cluster; the inpaint prompt builders here still call it.
const { sanitizeIssueForInpaint } = require('./imageCompositing');
const { blackoutIssueRegions } = require('./imageInpainting');
const { buildEmptySceneVbGrid, buildPageCompositeRefs } = require('./referenceSheets');
const { GROK_ASPECT_PRESETS, closestGrokAspect } = require('./grokAspect');
// Eval cluster now lives in evalPipeline.js (verbatim move; see its header).
// Destructured here both to re-export (facade — external top-level destructures
// in server.js / regeneration.js / entityConsistency.js depend on it) and
// because generation code below calls evaluateImageQuality directly.
// evalPipeline top-level-requires leaves only; its back-edges into this module
// are lazy require('./images') at call time, so this require is cycle-safe.
const {
  runVisualInventory,
  validateEmptyScene,
  capComplianceIdentitySeverity,
  evaluateThreeStage,
  sanitizeForGemini,
  evaluateImageQuality,
  IMAGE_QUALITY_THRESHOLD,
} = require('./evalPipeline');

// STR-6: image-prompt strings that used to be inline template literals in this
// file (Gemini/Grok repair, edit, bbox-refine, iterative placement, style
// transfer) now live in prompts/*.txt so they pass through the same reviewable
// template mechanism the Grok path already uses. Loaded once at module load and
// filled with fillTemplate() exactly like PROMPT_TEMPLATES. Kept local (not in
// services/prompts.js) so this refactor touches only images.js + new prompt
// files; the fill contract is identical.
const LOCAL_PROMPTS_DIR = path.join(__dirname, '../../prompts');
// Shared repair style-match guard (single source of truth in services/prompts.js)
// — substituted into the repair templates below so it can't drift from the ones
// loaded via PROMPT_TEMPLATES.
const { applyRepairStyleGuard } = require('../services/prompts');
const readPrompt = (f) => applyRepairStyleGuard(fs.readFileSync(path.join(LOCAL_PROMPTS_DIR, f), 'utf-8'));
const LOCAL_PROMPTS = {
  iterativePlacementPass1: readPrompt('iterative-placement-pass1.txt'),
  iterativePlacementPass2: readPrompt('iterative-placement-pass2.txt'),
  characterRepairGemini: readPrompt('character-repair-gemini.txt'),
  characterRepairGrokFullscene: readPrompt('character-repair-grok-fullscene.txt'),
  inpaintGrokRegions: readPrompt('inpaint-grok-regions.txt'),
  styleTransfer: readPrompt('style-transfer.txt'),
};

// Maps callGeminiAPIForImage's evaluationType to a stable function-name tag
// for the analyze-story-log cost rollup.
const EVAL_TYPE_TO_FUNC_NAME = {
  scene: 'page_image',
  page: 'page_image',
  cover: 'cover_image',
  avatar: 'avatar',
  iterate: 'page_image_iterate',
  empty: 'empty_scene',
  repair: 'character_repair'
};

function recordImageApiUsage(modelId, evaluationType, imageUsage) {
  const genLog = getCurrentLogger();
  if (!genLog) return;  // Not in a generation context (e.g. ad-hoc avatar request)
  const perImage = MODEL_PRICING[modelId]?.perImage ?? 0.04;
  const funcName = EVAL_TYPE_TO_FUNC_NAME[evaluationType] || evaluationType || 'image';
  genLog.apiUsage(funcName, modelId, {
    inputTokens: imageUsage.input_tokens || 0,
    outputTokens: imageUsage.output_tokens || 0,
    thinkingTokens: imageUsage.thinking_tokens || 0,
    calls: 1
  }, perImage);
}
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, IMAGE_MODELS, REPAIR_DEFAULTS, TEXT_MODELS } = require('../config/models');

const { createDiffImage } = require('./repairVerification');

// Bbox-detection cluster (VB-object grounding, bbox cache, fingerprint/pairing,
// detectAllBoundingBoxes, overlay rendering, enrichWithBoundingBoxes) moved
// VERBATIM to ./bboxDetection (god-file split Phase 3, 2026-08-11). Destructured
// here for images.js's own remaining call sites AND re-exported below (facade) —
// consumer imports from './images' are unchanged. FIGURE_COLORS moved with it.
const {
  parseVisualBibleObjects,
  resolveExpectedObjectLabels,
  buildObjectGroundingHints,
  _hashBboxKey,
  _bboxCacheGet,
  _bboxCacheSet,
  getBboxCacheStats,
  imageFingerprint,
  bboxPairsWith,
  restampDetectionForCoverText,
  detectionForVersion,
  detectAllBoundingBoxes,
  detectSubRegion,
  buildExpectedCharactersForBbox,
  createBboxOverlayImage,
  createSamInputOverlayImage,
  createCutoutSheetImage,
  escapeXml,
  enrichWithBoundingBoxes,
  FIGURE_COLORS,
} = require('./bboxDetection');
const { findBadPages, selectCharRepairTasks } = require('./repairLogic');
// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
}

// Character photo helpers
const { getFacePhoto, loadVbReferenceBytes } = require('./characterPhotos');

/**
 * Call Grok vision API for image analysis (OpenAI-compatible chat completions with images).
 * Converts Gemini parts format to Grok messages format and returns a Gemini-like response.
 * @param {string} modelKey - Model key in TEXT_MODELS (e.g., 'grok-4-fast')
 * @param {string} modelId - Actual model ID (e.g., 'grok-4-1-fast-non-reasoning')
 * @param {Array} geminiParts - Gemini parts array (inline_data + text)
 * @param {string} promptText - The evaluation prompt text
 * @returns {Response} Fake Response object matching Gemini API shape
 */
async function callGrokVisionAPI(modelKey, modelId, geminiParts, promptText) {
  const xaiApiKey = process.env.XAI_API_KEY;
  if (!xaiApiKey) {
    log.error('❌ [GROK VISION] XAI_API_KEY not configured');
    return { ok: false, text: () => 'XAI_API_KEY not configured', json: () => ({}) };
  }

  // Convert Gemini parts to OpenAI messages format
  const content = [];
  for (const part of geminiParts) {
    if (part.inline_data) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` }
      });
    } else if (part.text) {
      content.push({ type: 'text', text: part.text });
    }
  }

  const body = {
    model: modelId,
    max_tokens: 16000,
    temperature: 0.3,
    messages: [{ role: 'user', content }]
  };

  const startTime = Date.now();
  const response = await withRetry(async () => {
    return fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xaiApiKey}`
      },
      body: JSON.stringify(body),
      // Eval calls had no timeout — a hung provider connection froze the whole
      // job forever (stuck-at-51% incident, 2026-07-07). Abort → withRetry
      // re-runs → on final failure eval is skipped and the job continues.
      signal: AbortSignal.timeout(120000)
    });
  }, { maxRetries: 2, baseDelay: 2000 });

  if (!response.ok) {
    const errText = await response.text();
    log.error(`❌ [GROK VISION] API error (${response.status}): ${errText.substring(0, 200)}`);
    return response;
  }

  const result = await response.json();
  const elapsed = Date.now() - startTime;
  const inputTokens = result.usage?.prompt_tokens || 0;
  const outputTokens = result.usage?.completion_tokens || 0;
  log.debug(`📊 [GROK VISION] ${modelKey} (${elapsed}ms): ${inputTokens} in, ${outputTokens} out`);

  // Convert Grok response to Gemini-compatible format so existing parsing works
  const text = result.choices?.[0]?.message?.content || '';
  return {
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: {
        promptTokenCount: inputTokens,
        candidatesTokenCount: outputTokens,
        thoughtsTokenCount: 0
      }
    })
  };
}

// Gemini safety settings — used for all Gemini API calls to avoid content filtering
const GEMINI_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
];

// Helper: Check if a model supports thinking (includeThoughts in generationConfig)
function modelSupportsThinking(modelId) {
  const config = IMAGE_MODELS[modelId];
  return config?.supportsThinking === true;
}

// Helper: Get system instruction for image generation (scenes, covers, repairs)
function getImageSystemInstruction() {
  if (!PROMPT_TEMPLATES.imageSystemInstruction) return null;
  return { parts: [{ text: PROMPT_TEMPLATES.imageSystemInstruction }] };
}

// Helper: Extract thinking text from Gemini response parts (thought: true)
function extractThinkingFromParts(parts, logPrefix = 'IMAGE GEN') {
  if (!parts || !Array.isArray(parts)) return null;
  const thoughts = parts
    .filter(p => p.thought && p.text)
    .map(p => p.text);
  if (thoughts.length === 0) return null;
  const thinkingText = thoughts.join('\n');
  log.debug(`🧠 [${logPrefix}] Thinking (${thinkingText.length} chars): ${thinkingText.substring(0, 200)}${thinkingText.length > 200 ? '...' : ''}`);
  log.verbose(`🧠 [${logPrefix}] Full thinking:\n${thinkingText}`);
  return thinkingText;
}

// =============================================================================
// PROMPT SANITIZATION FOR GEMINI SAFETY BLOCKS
// Progressive sanitization levels for retrying blocked image prompts
// =============================================================================

// Problematic words that may trigger Gemini content filtering
const PROBLEMATIC_WORDS = [
  // Violence
  'weapon', 'sword', 'knife', 'dagger', 'spear', 'axe', 'bow and arrow',
  'blood', 'bleeding', 'wound', 'injured', 'injury',
  'kill', 'killing', 'death', 'dead', 'dying', 'corpse',
  'attack', 'attacking', 'fight', 'fighting', 'combat', 'battle', 'war',
  'explosion', 'exploding', 'bomb', 'gun', 'pistol', 'rifle', 'shoot', 'shooting',
  'violent', 'violence', 'aggressive',
  // Horror
  'scary', 'horror', 'terrifying', 'nightmare', 'monster',
  'torture', 'torment', 'suffering', 'agony',
  'poison', 'poisonous', 'toxic', 'venom',
  // Fire/destruction
  'fire', 'burning', 'flames', 'ablaze', 'inferno',
  'destroy', 'destruction', 'devastation', 'ruins',
  // Other
  'slave', 'slavery', 'chains', 'shackles', 'prisoner',
  'drunk', 'alcohol', 'wine', 'beer',
  'naked', 'nude', 'undressed',
  'evil', 'demonic', 'devil', 'satan', 'hell',
  'skull', 'skeleton', 'bones'
];

/**
 * Remove problematic words from a prompt (Level 1 sanitization)
 */
function sanitizePromptLevel1(prompt) {
  let sanitized = prompt;
  for (const word of PROBLEMATIC_WORDS) {
    // Replace whole words only (case-insensitive)
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    sanitized = sanitized.replace(regex, '');
  }
  // Clean up double spaces and empty lines
  sanitized = sanitized.replace(/  +/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n');
  return sanitized;
}

// Former sanitization levels 2-3 (generic "simplified scene" / "happy child
// in a magical setting" prompts) are GONE — they produced images unrelated
// to the page. Blocked generations now get a Claude scene rewrite instead
// (see the sanitization ladder in generateImageOnly).

// =============================================================================
// LRU CACHE IMPLEMENTATION
// Prevents memory leaks by limiting cache size and implementing eviction
// =============================================================================

const IMAGE_CACHE_MAX_SIZE = parseInt(process.env.IMAGE_CACHE_MAX_SIZE) || 100;
const REF_CACHE_MAX_SIZE = parseInt(process.env.REF_CACHE_MAX_SIZE) || 200;
const CACHE_TTL_MS = parseInt(process.env.IMAGE_CACHE_TTL_MS) || 60 * 60 * 1000; // 1 hour default

/**
 * Simple LRU Cache with TTL support
 * Evicts least recently used entries when max size is reached
 */
class LRUCache {
  constructor(maxSize, ttlMs = 0, name = 'cache') {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.name = name;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    // Check TTL expiration
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, { value: entry.value, timestamp: entry.timestamp });
    this.hits++;
    return entry.value;
  }

  getStats() {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) : 0;
    return { hits: this.hits, misses: this.misses, total, hitRate, size: this.cache.size };
  }

  resetStats() {
    this.hits = 0;
    this.misses = 0;
  }

  set(key, value) {
    // Delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      log.debug(`🗑️ [CACHE] Evicted oldest entry: ${oldestKey?.substring(0, 16)}...`);
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const entry = this.cache.get(key);
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// Image cache to avoid regenerating identical images (with LRU eviction)
const imageCache = new LRUCache(IMAGE_CACHE_MAX_SIZE, CACHE_TTL_MS, 'image');

// Cache for compressed reference images (with LRU eviction)
const compressedRefCache = new LRUCache(REF_CACHE_MAX_SIZE, CACHE_TTL_MS, 'ref');


// Maximum mask coverage (%) before skipping repair - larger masks degrade quality
// Inpainting works best for small, targeted fixes. For large areas, regenerate the image instead.

/**
 * Hash image data for comparison/caching
 * @param {string} imageData - Base64 image data URL
 * @returns {string} Short hash (8 characters)
 */
function hashImageData(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const data = r2Lib.stripDataUriPrefix(imageData);
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Generate cache key for image generation
 * Creates a hash from prompt + character photo hashes + page number
 * @param {string} prompt - The image generation prompt
 * @param {Array} characterPhotos - Array of character photos (URLs or {name, photoUrl} objects)
 * @param {string|null} sequentialMarker - Optional marker for sequential mode
 * @param {number|null} pageNumber - Optional page number to ensure unique cache keys per page
 */
function generateImageCacheKey(prompt, characterPhotos = [], sequentialMarker = null, pageNumber = null, ...extraMarkers) {
  // Hash each photo and sort them for consistency
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  const photoHashes = characterPhotos
    .map(p => typeof p === 'string' ? p : p?.photoUrl)
    .filter(url => url && typeof url === 'string' && url.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = r2Lib.stripDataUriPrefix(photoUrl);
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  // Combine prompt + photo hashes + sequential marker + page number
  // Page number ensures different pages never get the same cached image
  const extraSuffix = extraMarkers.filter(Boolean).join('|');
  const combined = `${prompt}|${photoHashes}|${sequentialMarker || ''}|${pageNumber !== null ? `page${pageNumber}` : ''}${extraSuffix ? `|${extraSuffix}` : ''}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Crop image to change aspect ratio for sequential mode
 * Used in sequential mode to prevent AI from copying too much from the reference image
 * Crops 15% from top and 15% from bottom to force regeneration while preserving central context
 * @param {string} imageBase64 - Base64 encoded image (with data URI prefix)
 * @returns {Promise<string>} Cropped base64 encoded image with data URI prefix
 */
async function cropImageForSequential(imageBase64) {
  try {
    // Remove data URI prefix if present
    const base64Data = r2Lib.stripDataUriPrefix(imageBase64);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get image metadata to know dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      log.warn('⚠️ [CROP] Could not get image dimensions, returning original');
      return imageBase64;
    }

    // Crop 15% from top and 15% from bottom (30% total) - focuses on central content
    const cropTop = Math.floor(height * 0.15);
    const cropBottom = Math.floor(height * 0.15);
    const newHeight = height - cropTop - cropBottom;

    log.debug(`✂️ [CROP] Cropping reference image: ${width}x${height} → ${width}x${newHeight} (removed ${cropTop}px from top, ${cropBottom}px from bottom)`);

    // Crop the image - extract from cropTop offset
    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left: 0, top: cropTop, width: width, height: newHeight })
      .png()
      .toBuffer();

    // Convert back to base64 with data URI prefix
    const croppedBase64 = `data:image/png;base64,${croppedBuffer.toString('base64')}`;

    return croppedBase64;
  } catch (err) {
    log.error('❌ [CROP] Error cropping image:', err.message);
    // Return original image if cropping fails
    return imageBase64;
  }
}

/**
 * Compress PNG image to JPEG format
 * Converts base64 PNG to JPEG with compression to reduce file size
 * @param {string} pngBase64 - Base64 encoded PNG image (with or without data URI prefix)
/**
 * @param {number} quality - JPEG quality (1-100, default 85)
 * @param {number|null} maxDimension - Maximum width/height in pixels (null = no resize)
 * @returns {Promise<string>} Base64 encoded JPEG image with data URI prefix
 */
async function compressImageToJPEG(pngBase64, quality = 85, maxDimension = null) {
  try {
    // Validate input is a string
    if (!pngBase64 || typeof pngBase64 !== 'string') {
      log.error(`❌ [COMPRESSION] Invalid input: expected string, got ${typeof pngBase64}`);
      throw new Error(`compressImageToJPEG requires a string, got ${typeof pngBase64}`);
    }

    // Remove data URI prefix if present and detect original mime type
    const mimeMatch = pngBase64.match(/^data:(image\/\w+);base64,/);
    const originalMimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const base64Data = r2Lib.stripDataUriPrefix(pngBase64);

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get original size
    const originalSizeKB = (imageBuffer.length / 1024).toFixed(2);

    // Skip compression for small images (< 100KB) - they're already optimized
    const SMALL_IMAGE_THRESHOLD_KB = 100;
    if (imageBuffer.length < SMALL_IMAGE_THRESHOLD_KB * 1024) {
      log.debug(`🗜️  [COMPRESSION] Skipping - image already small (${originalSizeKB} KB < ${SMALL_IMAGE_THRESHOLD_KB} KB)`);
      // Return original with correct format
      if (pngBase64.startsWith('data:')) {
        return pngBase64;
      }
      return `data:${originalMimeType};base64,${base64Data}`;
    }

    // Skip re-compression for JPEG images already at target size
    // Avoids double JPEG compression quality loss (e.g., face photos stored at 768x768 JPEG 95%)
    const isJpeg = originalMimeType === 'image/jpeg';
    if (isJpeg) {
      const metadata = await sharp(imageBuffer).metadata();
      const isSmallEnough = !maxDimension || (metadata.width <= maxDimension && metadata.height <= maxDimension);
      if (isSmallEnough) {
        log.debug(`🗜️  [COMPRESSION] Skipping re-compression - already JPEG ${metadata.width}x${metadata.height} (${originalSizeKB} KB)`);
        if (pngBase64.startsWith('data:')) {
          return pngBase64;
        }
        return `data:image/jpeg;base64,${base64Data}`;
      }
    }

    // Build sharp pipeline
    let pipeline = sharp(imageBuffer);

    // Resize if maxDimension is specified
    if (maxDimension && maxDimension > 0) {
      pipeline = pipeline.resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // Compress to JPEG
    const compressedBuffer = await pipeline
      .jpeg({ quality: quality, progressive: true })
      .toBuffer();

    // Convert back to base64
    const compressedBase64 = compressedBuffer.toString('base64');
    const compressedSizeKB = (compressedBuffer.length / 1024).toFixed(2);
    const reductionPercent = ((1 - compressedBuffer.length / imageBuffer.length) * 100).toFixed(1);

    log.debug(`🗜️  [COMPRESSION] PNG ${originalSizeKB} KB → JPEG ${compressedSizeKB} KB (${reductionPercent}% reduction)`);

    return `data:image/jpeg;base64,${compressedBase64}`;
  } catch (error) {
    log.error('❌ [COMPRESSION] Error compressing image:', error);
    throw error;
  }
}


/**
 * Rewrite a blocked scene description to be safer while preserving the story moment
 * @param {string} sceneDescription - The original scene that was blocked
 * @param {Function} callTextModel - Function to call text model API
 * @returns {Promise<string>} - The rewritten, safer scene description
 */
async function rewriteBlockedScene(sceneDescription, callTextModel) {
  log.debug(`🔄 [REWRITE] Rewriting blocked scene to be safer...`);
  log.debug(`🔄 [REWRITE] Original: ${sceneDescription.substring(0, 100)}...`);

  try {
    const rewritePrompt = fillTemplate(PROMPT_TEMPLATES.rewriteBlockedScene, {
      SCENE_DESCRIPTION: sceneDescription
    });

    const rewriteResult = await callTextModel(rewritePrompt, 1000, require('../config/models').resolveSceneRewriteModel(), { usageLabel: 'scene_rewrite' });
    const rewrittenScene = rewriteResult.text;

    // Log token usage
    if (rewriteResult.usage) {
      log.debug(`📊 [REWRITE] Token usage - input: ${rewriteResult.usage.input_tokens || 0}, output: ${rewriteResult.usage.output_tokens || 0}`);
    }

    log.info(`✅ [REWRITE] Scene rewritten: ${rewrittenScene.substring(0, 100)}...`);
    return { text: rewrittenScene.trim(), usage: rewriteResult.usage };
  } catch (error) {
    log.error(`❌ [REWRITE] Failed to rewrite scene:`, error.message);
    throw error;
  }
}

/**
 * Resolve the output aspect ratio for an image-gen call: an explicit override
 * always wins, otherwise fall back to the configured default for the target
 * (avatar / cover / page) — all three live in one place (MODEL_DEFAULTS).
 * Single source of truth for the block that was copy-pasted across every
 * Grok/Gemini dispatch inside callGeminiAPIForImage.
 */
function resolveOutputAspect(evaluationType, aspectRatioOverride) {
  return aspectRatioOverride
    || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
        : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
        : MODEL_DEFAULTS.pageAspect);
}

/**
 * Truncate a prompt to a backend's max length, emitting the same "Prompt too
 * long" warning every dispatch site used to hand-roll. Returns the prompt
 * unchanged when it already fits. `modelName` is optional — when supplied the
 * warning appends " for <model>" (three sites logged it, the gen-only Gemini
 * site did not), so the emitted string stays byte-identical to each original.
 * The caller keeps any follow-on side effect (e.g. updating parts[0] on the
 * Gemini path) by testing `result !== prompt`, which is true iff truncated.
 */
function truncatePromptForModel(prompt, maxPromptLength, logLabel, modelName = null) {
  if (prompt.length <= maxPromptLength) return prompt;
  const forClause = modelName != null ? ` for ${modelName}` : '';
  log.warn(`✂️ [${logLabel}] Prompt too long (${prompt.length} chars), truncating to ${maxPromptLength}${forClause}`);
  return prompt.substring(0, maxPromptLength - 3) + '...';
}

// Over-budget prompts are SHRUNK, never blind-cut: the blunt substring cut
// dropped whole tail sections — a page whose 9.4k prompt was cut at 7.5k lost
// its entire ART STYLE block and rendered photographic on every roll (3/3
// measured), and lost its object specs (map drawn with a ship instead of the
// described bridge). Order: deterministic dedupe → LLM compression → a
// section-aware cut that always preserves the tail sections as the final
// guarantee. truncatePromptForModel above remains only as the last-resort
// fallback inside that guarantee.
function dedupeIdenticalBullets(prompt) {
  // Merge "- Name: body" bullet lines whose body text is identical (sibling
  // characters often share verbatim proportion boilerplate) into one line:
  // "- Name1, Name2: body".
  const lines = prompt.split('\n');
  const seen = new Map(); // body -> first line index
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- ([^:]{1,40}): (.{40,})$/);
    if (!m) continue;
    const body = m[2];
    if (seen.has(body)) {
      const j = seen.get(body);
      lines[j] = lines[j].replace(/^- ([^:]{1,40}):/, (_, names) => `- ${names}, ${m[1]}:`);
      lines[i] = null;
    } else {
      seen.set(body, i);
    }
  }
  return lines.filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

// Blocks this cut may drop, least load-bearing first. The scene prose and the
// reference-card colour map are NOT on the list: the prose IS the page, and the
// colour map is what pairs each baked card with a name.
const CUT_DROP_ORDER = [
  '**Composition:**',
  '**HEIGHT ORDER',
  'AGE & PROPORTIONS',
  'When the FIRST reference photo',
  'Generate a SINGLE illustration',
];
const CUT_BLOCK_MARKERS = [...CUT_DROP_ORDER, 'REFERENCE CARD COLOURS', '**THIS IMAGE DEPICTS'];

function sectionAwareCut(prompt, maxLen, logLabel) {
  // Keep the tail sections (REQUIRED OBJECTS + ART STYLE) whole.
  const objIdx = prompt.indexOf('**REQUIRED OBJECTS');
  const styleIdx = prompt.indexOf('**ART STYLE');
  const tailStart = objIdx >= 0 ? objIdx : styleIdx;
  if (tailStart < 0) return truncatePromptForModel(prompt, maxLen, logLabel);
  const tail = prompt.slice(tailStart);
  const headBudget = maxLen - tail.length - 5;
  if (headBudget < 500) return truncatePromptForModel(prompt, maxLen, logLabel); // tail alone ~fills the budget

  // DROP WHOLE BLOCKS, NEVER A CHARACTER INDEX (owner, 2026-08-17). The head is
  // written in reading order — the scene prose describes character 1, then 2,
  // then 3 — so slicing at a byte offset deletes the LAST-described characters
  // outright: outfit, position and action gone, while the evaluator still scores
  // the render against a contract they were cut out of. Measured on a real page:
  // a 5,000-char budget removed a whole character mid-sentence. Dropping ranked
  // blocks costs generic guidance instead of a person.
  let head = prompt.slice(0, tailStart);
  const dropped = [];
  const blockRange = (text, marker) => {
    const start = text.indexOf(marker);
    if (start < 0) return null;
    let end = text.length;
    for (const m of CUT_BLOCK_MARKERS) {
      if (m === marker) continue;
      const i = text.indexOf(m, start + marker.length);
      if (i >= 0 && i < end) end = i;
    }
    return { start, end };
  };
  for (const marker of CUT_DROP_ORDER) {
    if (head.length <= headBudget) break;
    const r = blockRange(head, marker);
    if (!r) continue;
    head = (head.slice(0, r.start) + head.slice(r.end)).replace(/\n{3,}/g, '\n\n');
    dropped.push(marker.replace(/\*|:/g, '').trim());
  }

  // Still over: trim the prose at a SENTENCE boundary rather than mid-word, so
  // whatever survives is at least a complete statement.
  let proseCut = 0;
  if (head.length > headBudget) {
    const keep = head.slice(0, headBudget);
    const lastStop = Math.max(keep.lastIndexOf('. '), keep.lastIndexOf('.\n'));
    const cut = lastStop > headBudget * 0.5 ? lastStop + 1 : headBudget;
    proseCut = head.length - cut;
    head = head.slice(0, cut);
  }

  log.warn(`✂️ [${logLabel}] Section-aware cut: ${tailStart}→${head.length} chars`
    + (dropped.length ? `, dropped ${dropped.join(' + ')}` : '')
    + (proseCut ? `, AND ${proseCut} chars of scene prose — a character may be missing` : '')
    + ', tail sections kept whole');
  return head.trimEnd() + '\n' + tail;
}

async function shrinkPromptForModel(prompt, maxPromptLength, logLabel, modelName = null) {
  if (!prompt || prompt.length <= maxPromptLength) return prompt;

  // 1. Deterministic: merge duplicated bullet bodies, collapse blank runs.
  let out = dedupeIdenticalBullets(prompt);
  if (out.length <= maxPromptLength) {
    log.info(`✂️ [${logLabel}] Prompt ${prompt.length}→${out.length} chars via dedupe (budget ${maxPromptLength})`);
    return out;
  }

  // 2. LLM compression — of the HEAD ONLY. The protected tail (REQUIRED
  // OBJECTS + ART STYLE) is held back and reattached verbatim, so style and
  // object specs survive by construction, not by model obedience. Full-prompt
  // rewrites were measured failing every way: qwen ignores budgets (asked
  // 800 words, returned 8.9k chars), flash overshoots (asked 4.5k, wrote
  // 8.1k) or — given a threatening budget line — collapses to a 0.7k stub.
  // Compressing 7k of prose to ~5k is the modest ask a model actually does.
  const tailStart = (() => {
    const o = out.indexOf('**REQUIRED OBJECTS');
    return o >= 0 ? o : out.indexOf('**ART STYLE');
  })();
  if (tailStart > 0) {
    const tail = out.slice(tailStart);
    let head = out.slice(0, tailStart);
    // The frame-colour map binds the baked card frames to characters — its
    // exact "<COLOUR> frame = <Name>" pairs must survive verbatim (the
    // compressor was measured silently dropping the whole block). Pull the
    // paragraph out before compression, reattach after.
    let frameBlock = '';
    const fm = head.match(/^REFERENCE CARD COLOURS[\s\S]*?scene\.\s*$/m);
    if (fm) {
      frameBlock = fm[0];
      head = head.replace(fm[0], '');
    }
    // Same for the static rendering rules (single edge-to-edge illustration /
    // no panel borders / no written characters on surfaces) — the compressor
    // was measured dropping them, and border-injection + text-leakage are
    // exactly the failure modes those paragraphs exist to prevent.
    let rulesBlock = '';
    const rm = head.match(/^Generate a SINGLE illustration[\s\S]*?(?:\n\n|$)(?:All surfaces in the scene[\s\S]*?(?:\n\n|$))?/m);
    if (rm) {
      rulesBlock = rm[0].trim();
      head = head.replace(rm[0], '\n\n');
    }
    const headBudget = maxPromptLength - tail.length - frameBlock.length - rulesBlock.length - 40;
    if (headBudget >= 1500) {
      try {
        const { callTextModel } = require('./textModels');
        const { resolvePromptCompressModel } = require('../config/models');
        const compressModel = resolvePromptCompressModel();
        // TWO targets, both computed from this page (owner, 2026-08-12): the
        // RELATIVE cut, which tells the model how hard to squeeze, and the
        // ABSOLUTE cap in characters, which is the unit that actually binds
        // (the backend limit is a char limit). A word target alone was measured
        // missing in both directions — flash returned 39% of its allowance and
        // deleted four characters' hats, deepseek 126% and then 139%. A model
        // asked to "shorten by 26%" has a size to aim at; "at most N chars"
        // alone reads as advice.
        // WHAT to cut, in order — not just how much. And the preservation rule
        // asks for the MAIN POINTS, not every fact (owner, 2026-08-12): "keep
        // every fact" plus "cut 26%" has no solution on a five-character page —
        // the text is a list of people, garments, positions and props with
        // almost no filler — so flash resolved the contradiction by deleting
        // four hats and deepseek by returning a near-copy (7,374 of 7,410
        // chars, a 0.5% cut, even given the percentage, size, cap and word
        // count). Naming the main points and ranking the rest lets the model
        // shorten wording instead of choosing between silence and disobedience.
        const cutPct = Math.max(5, Math.round((1 - headBudget / head.length) * 100));
        const capWords = Math.floor(headBudget / 6.5);
        const buildInstruction = (over) => (over
          ? `Your previous version was ${over} characters — still over the ${headBudget} limit. Cut deeper this time. `
          : '')
          + `Shorten the scene description below to at most ${headBudget} characters (roughly ${capWords} words). It is ${head.length} characters now, so about ${cutPct}% has to go. `
          + `Keep all the main points: every character with their age band and body proportions (e.g. kindergarten-age about 5 heads tall, adult about 7.5-8 heads tall), what each one wears down to the colour of each garment, where each one is, what each one is doing, and every object named. Say them in fewer words. `
          + `Cut in this order, and stop as soon as it fits: 1. mood, atmosphere and lighting adjectives; 2. background and setting detail; 3. repeated wording. `
          + `Same format, same section headers. Output ONLY the rewritten description.\n\n${head}`;
        // reasoning:{enabled:false} is REQUIRED, not an optimisation. With it on,
        // deepseek-v4-pro spent all 12,001 output tokens thinking and returned an
        // EMPTY string, so compression silently fell back to blunt truncation
        // (job_1786484554633 p9, Lab #530). Off: 6,847 chars in 9.7s for $0.008.
        // The 12k budget stays for models that ignore the flag.
        const callOpts = { usageLabel: 'prompt_compress', temperature: 0, reasoning: { enabled: false } };
        let newHead = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          const over = attempt === 1 ? 0 : newHead.length;
          const res = await callTextModel(buildInstruction(over), 12000, compressModel, callOpts);
          newHead = (res?.text || '').trim();
          if (newHead.length > 500 && newHead.length <= headBudget) break;
          log.warn(`✂️ [${logLabel}] Compression attempt ${attempt} by ${compressModel}: ${newHead.length} chars vs ${headBudget} allowed`);
        }
        if (newHead.length > 500 && newHead.length <= headBudget) {
          const assembled = newHead + (rulesBlock ? '\n\n' + rulesBlock : '') + (frameBlock ? '\n\n' + frameBlock : '') + '\n\n' + tail;
          // The head/allowance ratio is the number that matters: a model that
          // writes far under its allowance silently deletes scene facts, and
          // nothing downstream can tell that from a legitimately terse rewrite.
          log.info(`✂️ [${logLabel}] Prompt ${prompt.length}→${assembled.length} chars via head compression by ${compressModel} (head ${head.length}→${newHead.length} of ${headBudget} allowed = ${Math.round((newHead.length / headBudget) * 100)}%, budget ${maxPromptLength}, tail ${tail.length} + rules + frame map kept verbatim)`);
          return assembled;
        }
        log.warn(`✂️ [${logLabel}] Head compression unusable after 2 attempts (${newHead.length} chars vs budget ${headBudget}) — falling back to section-aware cut`);
      } catch (err) {
        log.warn(`✂️ [${logLabel}] Head compression failed (${err.message}) — falling back to section-aware cut`);
      }
    }
  }

  // 3. Guarantee: section-aware cut that never drops the tail sections.
  return sectionAwareCut(out, maxPromptLength, logLabel);
}

/**
 * Collect the data:image reference URLs from a characterPhotos array (each
 * entry is either a raw data-URI string or an object with a `photoUrl`).
 * Shared by the Runware dispatch of both image-gen entry functions and the
 * Grok avatar branch, so the extraction rule lives in one place.
 */
function extractDataImageUrls(characterPhotos) {
  const referenceImages = [];
  if (characterPhotos && characterPhotos.length > 0) {
    for (const photoData of characterPhotos) {
      const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      if (photoUrl && photoUrl.startsWith('data:image')) {
        referenceImages.push(photoUrl);
      }
    }
  }
  return referenceImages;
}

/**
 * Shared provider-dispatch core for the two image-gen entry functions
 * (`callGeminiAPIForImage` — eval path — and `generateImageOnly` — gen-only).
 *
 * Owns the ENTIRE Grok→Gemini→Runware selection ladder that both used to
 * re-implement in parallel: backend resolution, primary Runware, primary Grok,
 * Gemini `parts` construction, model-id resolution + prompt truncation,
 * model-routed Runware, model-routed Grok, and the non-Gemini→Gemini model swap.
 * It performs the actual provider API call for the Runware/Grok branches and
 * invokes `onImageReady`, but does NO quality eval and NO caching — those stay
 * in the wrappers so each keeps its own cache namespace and result shape.
 *
 * Returns one of:
 *   - a RAW generation result for a Runware/Grok branch:
 *       { provider, imageData, modelId, usage, packedRefs, promptSent }
 *     provider ∈ 'runware-primary' | 'grok-primary' | 'runware-routed' | 'grok-routed'
 *   - a Gemini fallback SENTINEL when no upstream provider produced an image:
 *       { provider: 'gemini', parts, modelId, effectivePrompt }
 *     The wrapper runs its own terminal Gemini fetch — the two differ (gen-only
 *     runs a 3-level sanitization retry loop; the eval path is a single-shot
 *     fallback that also calls recordImageApiUsage), so that one branch is not
 *     shared. Everything up to it (parts already built, model id resolved +
 *     swapped, prompt truncated) is done here.
 *
 * Every place the two original ladders differed is a documented `opts` field
 * each wrapper passes its own value for, so behavior is byte-preserved.
 */
async function _dispatchImageGeneration(prompt, characterPhotos = [], opts = {}) {
  const {
    logLabel,                            // 'IMAGE GEN' | 'IMAGE GEN-ONLY'
    verbose = false,                     // eval path: verbose logs + per-photo hash log + model name in truncate warning
    previousImage = null,
    imageModelOverride = null,
    imageBackendOverride = null,
    landmarkPhotos = [],
    visualBibleGrid = null,
    sceneBackground = null,
    textAreaMask = null,                 // gen-only threads this into primary-Grok packReferences
    onImageReady = null,
    outputAspect,                        // pre-resolved aspect (eval: resolveOutputAspect(evalType, override); gen-only: aspectRatio option)
    evaluationType = null,               // used only for the primary-Grok log line (eval path)
    grokPrimaryModel,                    // eval path honors pro override; gen-only forces STANDARD
    grokPrimaryModelKey,                 // key for maxPromptLength lookup ('grok-imagine' | override)
    usePadExtension = false,             // gen-only pads scene-plate slot 0 (both Grok branches)
    avatarMode = false,                  // eval path avatar-slices refs in model-routed Grok
    pageLabel = '',                      // Grok packReferences pageLabel
    defaultModel,                        // eval path cover-aware; gen-only pageImage
    includeSceneBackgroundPart = false,  // gen-only adds a [Background] Gemini part
  } = opts;

  // Whether slot-0 scene plates get magenta-extension padding (gen-only only).
  const slot0IsScenePlate = usePadExtension && !!(sceneBackground || (Array.isArray(landmarkPhotos) && landmarkPhotos.length) || previousImage);

  // Priority: explicit backend override > the overridden model's OWN backend >
  // CONFIG_DEFAULTS > 'gemini'. Deriving the backend from imageModelOverride is
  // what makes a model-key override actually switch providers: passing
  // imageModelOverride='gemini-2.5-flash-image' with no imageBackendOverride
  // previously stayed on the default (grok) backend and silently rendered on
  // Grok — so any model-only A/B compared a model against itself.
  const modelBackend = imageModelOverride ? IMAGE_MODELS[imageModelOverride]?.backend : null;
  const imageBackend = imageBackendOverride || modelBackend || CONFIG_DEFAULTS?.imageBackend || 'gemini';
  if (verbose) {
    log.info(`🎨 [${logLabel}] Backend: ${imageBackend} (override=${imageBackendOverride || 'none'}, default=${CONFIG_DEFAULTS?.imageBackend || 'gemini'})`);
  } else {
    log.info(`🎨 [${logLabel}] Backend: ${imageBackend}`);
  }

  // ── Primary Runware (cheap FLUX Schnell) ──────────────────────────────────
  if (imageBackend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [${logLabel}] Using Runware FLUX Schnell backend${verbose ? ' (cheap testing mode)' : ''}`);
    try {
      const referenceImages = extractDataImageUrls(characterPhotos);
      const result = await generateWithRunware(prompt, {
        model: RUNWARE_MODELS.FLUX_SCHNELL,
        width: 1024,
        height: 1024,
        steps: 4,
        referenceImages: referenceImages
      });
      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }
      return { provider: 'runware-primary', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: referenceImages, promptSent: prompt };
    } catch (runwareError) {
      log.error(verbose
        ? `❌ [RUNWARE] Generation failed, falling back to Gemini: ${runwareError.message}`
        : `❌ [${logLabel}] Runware failed, falling back to Gemini: ${runwareError.message}`);
      // Fall through to Gemini
    }
  }

  // ── Primary Grok Imagine ──────────────────────────────────────────────────
  if (imageBackend === 'grok' && isGrokConfigured()) {
    const grokModel = grokPrimaryModel;
    const grokAspect = outputAspect;
    log.info(`🎨 [${logLabel}] Using Grok Imagine backend (model: ${grokModel}${verbose ? `, type: ${evaluationType}, aspect: ${grokAspect}` : ''})`);

    // Truncate to Grok's prompt-length cap BEFORE the API call.
    const grokMaxPrompt = IMAGE_MODELS[grokPrimaryModelKey]?.maxPromptLength || 7500;
    const grokPrompt = await shrinkPromptForModel(prompt, grokMaxPrompt, logLabel, grokModel);

    try {
      const refImages = await packReferences(
        { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground, textAreaMask },
        { aspectRatio: grokAspect, pageLabel, padInputWithExtension: slot0IsScenePlate }
      );

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(grokPrompt, refImages, { model: grokModel, aspectRatio: grokAspect, padInputWithExtension: slot0IsScenePlate });
      } else {
        result = await generateWithGrok(grokPrompt, { model: grokModel, aspectRatio: grokAspect });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }

      return { provider: 'grok-primary', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: refImages, promptSent: grokPrompt };
    } catch (grokError) {
      log.error(verbose
        ? `❌ [GROK] Generation failed, falling back to Gemini: ${grokError.message}`
        : `❌ [${logLabel}] Grok failed, falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini
    }
  }

  // ── Build Gemini parts array (PROMPT FIRST, then images in order) ──────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  const hasSequentialImage = previousImage && previousImage.startsWith('data:image');
  const parts = [{ text: prompt }];
  let currentImageIndex = 1;

  // Sequential mode: cropped PREVIOUS scene image first (continuity anchor).
  if (hasSequentialImage) {
    const croppedImage = await cropImageForSequential(previousImage);
    const base64Data = r2Lib.stripDataUriPrefix(croppedImage);
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';
    parts.push({ text: `[Previous scene]:` });
    parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
    currentImageIndex++;
    log.debug(verbose
      ? `🖼️  [${logLabel}] Added cropped previous scene image for visual continuity (SEQUENTIAL MODE)`
      : `🖼️  [${logLabel}] Added cropped previous scene image (SEQUENTIAL MODE)`);
  }

  // Scene background reference (empty scene for style anchoring) — gen-only.
  if (includeSceneBackgroundPart && sceneBackground && sceneBackground.startsWith('data:image')) {
    const bgBase64 = r2Lib.stripDataUriPrefix(sceneBackground);
    const bgMime = sceneBackground.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ text: `[Background]:` });
    parts.push({ inline_data: { mime_type: bgMime, data: bgBase64 } });
    currentImageIndex++;
    log.debug(`🖼️ [${logLabel}] Added scene background reference`);
  }

  // Character photos as reference images (compressed + cached for token efficiency).
  if (characterPhotos && characterPhotos.length > 0) {
    let addedCount = 0;
    let skippedCount = 0;
    let cacheHits = 0;
    const characterNames = [];
    const apiImageHashes = [];  // verbose-only debug artifact

    for (const photoData of characterPhotos) {
      let photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      if (photoUrl && typeof photoUrl === 'object') {
        if (Array.isArray(photoUrl)) {
          photoUrl = photoUrl[0];
        } else if (photoUrl.data) {
          photoUrl = photoUrl.data;
        } else if (photoUrl.imageData) {
          photoUrl = photoUrl.imageData;
        }
      }
      const characterName = typeof photoData === 'object' ? photoData?.name : null;
      const providedHash = typeof photoData === 'object' ? photoData?.photoHash : null;

      if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
        const imageHash = hashImageData(photoUrl);
        let compressedBase64 = compressedRefCache.get(imageHash);
        if (compressedBase64) {
          cacheHits++;
        } else {
          const compressed = await compressImageToJPEG(photoUrl, 85, 768);
          compressedBase64 = r2Lib.stripDataUriPrefix(compressed);
          compressedRefCache.set(imageHash, compressedBase64);
        }

        if (verbose) {
          apiImageHashes.push({
            name: characterName || `photo_${addedCount + 1}`,
            hash: imageHash,
            matchesProvided: providedHash ? imageHash === providedHash : null
          });
        }

        // IMPORTANT: Do NOT use numbered format like [Image 1 - Name] as it triggers "character sheet" generation
        const labelName = characterName || `Character ${addedCount + 1}`;
        parts.push({ text: `[${labelName}]:` });
        if (characterName) {
          characterNames.push(characterName);
        }
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: compressedBase64 } });
        currentImageIndex++;
        addedCount++;
      } else {
        skippedCount++;
        if (verbose) {
          const charLabel = characterName ? `"${characterName}"` : `#${addedCount + skippedCount}`;
          const preview = photoUrl
            ? (typeof photoUrl === 'string' ? photoUrl.substring(0, 30) : `[object: ${Object.keys(photoUrl).join(',')}]`)
            : 'null/undefined';
          log.warn(`[${logLabel}] Skipping character ${charLabel}: invalid photoUrl (${preview}...)`);
        }
      }
    }

    if (verbose && apiImageHashes.length > 0) {
      log.debug(`🔐 [${logLabel}] API image hashes:`, apiImageHashes.map(h => `${h.name}:${h.hash}`).join(', '));
    }
    if (characterNames.length > 0) {
      log.debug(`🖼️  [${logLabel}] Added ${addedCount} LABELED reference images: ${characterNames.join(', ')} (${cacheHits} cached)`);
    } else if (verbose) {
      log.debug(`🖼️  [${logLabel}] Added ${addedCount}/${characterPhotos.length} character reference images (${cacheHits} cached)`);
    }
    if (verbose && skippedCount > 0) {
      log.warn(`[${logLabel}] WARNING: ${skippedCount} photos were SKIPPED (not base64 data URLs)`);
    }
  }

  // Primary landmark reference photo only (1st landmark as separate image).
  if (landmarkPhotos && landmarkPhotos.length > 0) {
    const primaryLandmark = landmarkPhotos[0];
    const candidates = [primaryLandmark.photoUrl, primaryLandmark.photoData].filter(s => typeof s === 'string' && s.length > 0);
    if (candidates.length > 0) {
      let buf = null;
      for (const source of candidates) {
        try { buf = await r2Lib.bytesFromAnyImage(source); if (buf) break; } catch { /* try next */ }
      }
      if (buf) {
        parts.push({ text: `[${primaryLandmark.name} (landmark)]:` });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } });
        currentImageIndex++;
        log.info(`🌍 [${logLabel}] Added primary landmark reference: ${primaryLandmark.name}`);
        if (verbose && landmarkPhotos.length > 1) {
          log.debug(`🌍 [${logLabel}] ${landmarkPhotos.length - 1} secondary landmark(s) excluded (should be in VB grid)`);
        }
      } else {
        log.warn(verbose
          ? `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}": failed to load bytes — skipping`
          : `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}": failed to load bytes from any source — skipping`);
      }
    } else {
      log.warn(verbose
        ? `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}" has no photoData — skipping`
        : `⚠️ [${logLabel}] Landmark "${primaryLandmark.name}" has no source — skipping`);
    }
  }

  // Visual Bible reference grid (secondary chars, animals, artifacts, vehicles, 2nd+ landmarks).
  if (visualBibleGrid) {
    parts.push({ text: `[Reference Grid (objects, secondary characters, locations)]:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: visualBibleGrid.toString('base64') } });
    currentImageIndex++;
    log.info(verbose
      ? `🔲 [${logLabel}] Added Visual Bible reference grid (${Math.round(visualBibleGrid.length / 1024)}KB)`
      : `🔲 [${logLabel}] Added Visual Bible reference grid`);
  }

  if (verbose) {
    log.debug(`🔍 [${logLabel}] Parts array structure: ${parts.map((p, i) =>
      p.text ? `[${i}] text(${p.text.length}ch)` :
      p.inline_data ? `[${i}] image(${p.inline_data.mime_type})` : `[${i}] unknown`
    ).join(', ')}`);
  }

  // ── Resolve model id + truncate to its cap ────────────────────────────────
  let modelId = imageModelOverride || defaultModel;
  if (verbose && imageModelOverride) {
    log.debug(`🔧 [${logLabel}] Using model override: ${modelId}`);
  }

  const modelConfig = IMAGE_MODELS[modelId];
  const maxPromptLength = modelConfig?.maxPromptLength || 30000;
  const effectivePrompt = await shrinkPromptForModel(prompt, maxPromptLength, logLabel, verbose ? modelId : null);
  if (effectivePrompt !== prompt) {
    parts[0] = { text: effectivePrompt };
  }

  // ── Model-routed Runware (model config says backend='runware') ────────────
  if (modelConfig?.backend === 'runware' && isRunwareConfigured()) {
    log.info(verbose
      ? `🎨 [${logLabel}] Model ${modelId} uses Runware backend - routing to Runware`
      : `🎨 [${logLabel}] Model ${modelId} uses Runware backend`);
    try {
      const runwareModel = modelId === 'flux-dev' ? RUNWARE_MODELS.FLUX_DEV : RUNWARE_MODELS.FLUX_SCHNELL;
      const referenceImages = extractDataImageUrls(characterPhotos);
      const result = await generateWithRunware(effectivePrompt, {
        model: runwareModel,
        width: 1024,
        height: 1024,
        steps: modelId === 'flux-dev' ? 30 : 4,
        referenceImages: referenceImages
      });
      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); }
        catch (callbackError) { log.error(`⚠️ [${logLabel}] onImageReady callback error:`, callbackError.message); }
      }
      return { provider: 'runware-routed', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: referenceImages, promptSent: effectivePrompt };
    } catch (runwareError) {
      log.error(`❌ [${logLabel}] Runware generation failed:`, runwareError.message);
      throw runwareError;
    }
  }

  // ── Model-routed Grok (model config says backend='grok') ──────────────────
  if (modelConfig?.backend === 'grok' && isGrokConfigured()) {
    log.info(verbose
      ? `🎨 [${logLabel}] Model ${modelId} uses Grok backend - routing to Grok`
      : `🎨 [${logLabel}] Model ${modelId} uses Grok backend`);
    try {
      const grokModel = modelId === 'grok-imagine-pro' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD;
      const grokAspect = outputAspect;

      // Avatars: each reference (face, body, style) as its own slot; scenes: normal packing.
      let refImages;
      if (avatarMode && characterPhotos?.length > 0) {
        refImages = extractDataImageUrls(characterPhotos.slice(0, 3));
        log.info(`🎨 [GROK] Avatar mode: ${refImages.length} reference images as separate slots`);
      } else {
        refImages = await packReferences(
          { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground },
          { aspectRatio: grokAspect, pageLabel, padInputWithExtension: slot0IsScenePlate }
        );
      }

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(effectivePrompt, refImages, { model: grokModel, aspectRatio: grokAspect, padInputWithExtension: slot0IsScenePlate });
      } else {
        result = await generateWithGrok(effectivePrompt, { model: grokModel, aspectRatio: grokAspect });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); } catch (e) { /* ignore */ }
      }

      return { provider: 'grok-routed', imageData: result.imageData, modelId: result.modelId, usage: result.usage, packedRefs: refImages, promptSent: effectivePrompt };
    } catch (grokError) {
      log.error(`❌ [${logLabel}] Grok generation failed (model-routed), falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini below
    }
  }

  // If modelId points at a non-Gemini backend (Grok/Runware) we reached here
  // via the fallback path — swap to a known-good Gemini image model so the
  // URL the wrapper builds is valid.
  if (IMAGE_MODELS[modelId]?.backend && IMAGE_MODELS[modelId].backend !== 'gemini') {
    const originalModelId = modelId;
    modelId = 'gemini-2.5-flash-image';
    log.warn(`🔄 [${logLabel}] Fallback: swapped model ${originalModelId} → ${modelId} for Gemini API call`);
  }

  // Gemini fallback sentinel — parts built, model resolved + swapped, prompt
  // truncated. The wrapper runs its own terminal Gemini fetch (they differ).
  return { provider: 'gemini', parts, modelId, effectivePrompt };
}

/**
 * Call Gemini API for image generation
 * @param {string} prompt - The image generation prompt
 * @param {string[]} characterPhotos - Character reference photos
 * @param {string|null} previousImage - Previous image for sequential mode
 * @param {string} evaluationType - 'scene' or 'cover'
 * @param {Function|null} onImageReady - Callback when image is ready
 * @param {string|null} imageModelOverride - Override image model (e.g., 'gemini-2.5-flash-image' or 'gemini-3-pro-image-preview')
 * @param {string|null} qualityModelOverride - Override quality evaluation model
 * @param {string|null} imageBackendOverride - Override image backend ('gemini' or 'runware')
 * @param {Array<{name: string, photoData: string}>} landmarkPhotos - Landmark reference photos (only 1st used as separate image)
 * @param {number} sceneCharacterCount - Number of characters in scene (for determining if >3)
 * @param {Buffer|null} visualBibleGrid - Combined grid image of VB elements and secondary landmarks
 * @returns {Promise<{imageData, score, reasoning, modelId, ...}>}
 */
async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, imageModelOverride = null, qualityModelOverride = null, pageContext = '', imageBackendOverride = null, landmarkPhotos = [], sceneCharacterCount = 0, visualBibleGrid = null, storyText = null, sceneHint = null, sceneBackground = null, aspectRatioOverride = null, sceneCharacters = null) {
  // Extract page number from pageContext (e.g., "PAGE 5" or "PAGE 5 (consistency fix)")
  const pageMatch = pageContext.match(/PAGE\s*(\d+)/i);
  const pageNumber = pageMatch ? parseInt(pageMatch[1], 10) : null;

  // Check cache first (include previousImage presence and page number in cache key)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null, pageNumber);

  if (imageCache.has(cacheKey)) {
    log.debug(`💾 [IMAGE CACHE] HIT (${imageCache.size} cached)`);
    const cachedResult = imageCache.get(cacheKey);
    // Call onImageReady for cache hits too (for progressive display)
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
      } catch (callbackError) {
        log.error('⚠️ [IMAGE CACHE] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.debug(`🆕 [IMAGE CACHE] MISS - key: ${cacheKey.substring(0, 16)}...`);

  // Aspect ratio: explicit override wins, otherwise read from MODEL_DEFAULTS
  // (pageAspect / coverAspect / avatarAspect — all configured in one place).
  const outputAspect = resolveOutputAspect(evaluationType, aspectRatioOverride);

  // Shared provider-dispatch ladder (Runware/Grok/Gemini selection + reference
  // packing + truncation + aspect + onImageReady). See _dispatchImageGeneration.
  const raw = await _dispatchImageGeneration(prompt, characterPhotos, {
    logLabel: 'IMAGE GEN',
    verbose: true,
    previousImage,
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos,
    visualBibleGrid,
    sceneBackground,
    textAreaMask: null,
    onImageReady,
    outputAspect,
    evaluationType,
    // Honour the caller's model selection (imageModelOverride) — pro override → PRO.
    grokPrimaryModel: imageModelOverride === 'grok-imagine-pro' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD,
    grokPrimaryModelKey: imageModelOverride || 'grok-imagine',
    usePadExtension: false,
    avatarMode: evaluationType === 'avatar',
    pageLabel: pageNumber != null ? String(pageNumber) : pageContext,
    defaultModel: evaluationType === 'cover' ? MODEL_DEFAULTS.coverImage : MODEL_DEFAULTS.pageImage,
    includeSceneBackgroundPart: false,
  });

  // Same 9-arg quality eval every non-avatar branch ran inline before.
  const runEval = () => evaluateImageQuality(
    raw.imageData, prompt, characterPhotos, evaluationType,
    qualityModelOverride, pageContext, storyText, sceneHint, sceneCharacters
  );

  // ── Primary Runware branch: eval + big shape, cache ───────────────────────
  if (raw.provider === 'runware-primary') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      // Distinguish "no opinion" from "eval failed". Null score + evaluated:false
      // tells findBadPages to redo the page instead of silently shipping it
      // because the eval call timed out / blew up.
      evaluated: !!qualityResult,
      evalError: qualityResult ? null : 'evaluator returned no result',
      reasoning: qualityResult?.reasoning ?? null,
      detectedProblems: qualityResult?.detectedProblems || [],
      figures: qualityResult?.figures || [],
      matches: qualityResult?.matches || [],
      objectMatches: qualityResult?.object_matches || [],
      fixTargets: qualityResult?.fixTargets || [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      issuesSummary: qualityResult?.issuesSummary || null,
      verdict: qualityResult?.verdict || null,
      usage: raw.usage
    };
    imageCache.set(cacheKey, finalResult);
    log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);
    return finalResult;
  }

  // ── Primary Grok branch: avatar skip OR eval + big shape, cache ───────────
  if (raw.provider === 'grok-primary') {
    // Skip quality evaluation for avatar conversions (just style transfer)
    if (evaluationType === 'avatar') {
      log.debug(`⏭️ [QUALITY] Skipping quality evaluation for Grok avatar conversion`);
      const finalResult = {
        imageData: raw.imageData,
        modelId: raw.modelId,
        score: null,
        reasoning: null,
        imageUsage: raw.usage,
        usage: raw.usage
      };
      imageCache.set(cacheKey, finalResult);
      return finalResult;
    }

    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok backend) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      evaluated: !!qualityResult,
      evalError: qualityResult ? null : 'evaluator returned no result',
      reasoning: qualityResult?.reasoning ?? null,
      detectedProblems: qualityResult?.detectedProblems || [],
      figures: qualityResult?.figures || [],
      matches: qualityResult?.matches || [],
      objectMatches: qualityResult?.object_matches || [],
      fixTargets: qualityResult?.fixTargets || [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      issuesSummary: qualityResult?.issuesSummary || null,
      verdict: qualityResult?.verdict || null,
      // `imageUsage` is the field provider-style usage trackers read.
      // The legacy `usage:` field stays for any direct callers of this function.
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      // Prompt actually sent (may be truncated to Grok's max).
      prompt: raw.promptSent,
    };
    imageCache.set(cacheKey, finalResult);
    log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);
    return finalResult;
  }

  // ── Model-routed Runware branch: eval + shape (no cache, matches original) ─
  if (raw.provider === 'runware-routed') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    return {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      numericScore: qualityResult?.numericScore ?? null,
      reasoning: qualityResult?.reasoning ?? null,
      verdict: qualityResult?.verdict ?? null,
      fixTargets: qualityResult?.fixTargets ?? [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      issuesSummary: qualityResult?.issuesSummary || null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      // Reconstruction record (see Gemini/Grok branches).
      prompt: raw.promptSent,
      grokRefImages: raw.packedRefs?.length > 0 ? raw.packedRefs : undefined
    };
  }

  // ── Model-routed Grok branch: eval + shape (no cache, matches original) ────
  if (raw.provider === 'grok-routed') {
    const qualityResult = await runEval();
    if (!qualityResult) {
      log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
    }
    return {
      imageData: raw.imageData,
      modelId: raw.modelId,
      score: qualityResult?.score ?? null,
      numericScore: qualityResult?.numericScore ?? null,
      reasoning: qualityResult?.reasoning ?? null,
      verdict: qualityResult?.verdict ?? null,
      fixTargets: qualityResult?.fixTargets ?? [],
      fixableIssues: qualityResult?.fixableIssues || [],
      semanticResult: qualityResult?.semanticResult || null,
      semanticScore: qualityResult?.semanticScore ?? null,
      issuesSummary: qualityResult?.issuesSummary || null,
      qualityModelId: qualityResult?.qualityModelId ?? null,
      imageUsage: raw.usage,
      qualityUsage: qualityResult?.usage ?? null,
      // Exact packed references sent to Grok (for dev-mode "Sent to Grok" display).
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
      // Prompt actually sent (may be truncated to the model's max).
      prompt: raw.promptSent,
    };
  }

  // ── Gemini fallback: terminal single-shot fetch + eval (eval-path only) ────
  // The core already built `parts`, resolved + swapped `modelId`, and truncated
  // the prompt. This block reproduces the eval path's ORIGINAL Gemini generator:
  // one withRetry fetch, recordImageApiUsage, rich refusal-error extraction, and
  // the avatar-skip early return — deliberately NOT shared with generateImageOnly's
  // sanitization-retry-loop Gemini generator (they are different generators).
  const { parts, modelId, effectivePrompt } = raw;
  const apiKey = process.env.GEMINI_API_KEY;

  const systemInstruction = getImageSystemInstruction();
  const modelTemp = IMAGE_MODELS[modelId]?.temperature ?? 0.8;
  const geminiAspect = outputAspect;
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: modelTemp,
      ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } }),
      imageConfig: {
        aspectRatio: geminiAspect
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN] Calling Gemini API with prompt (${prompt.length} chars), scene: ${prompt.substring(0, 80).replace(/\n/g, ' ')}...`);
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: ${geminiAspect}, Temperature: ${modelTemp}, systemInstruction: ${!!systemInstruction}`);

  const data = await withRetry(async () => {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      }
    );

    log.debug('🖼️  [IMAGE GEN] Response status:', response.status, response.statusText);

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [IMAGE GEN] Gemini API error response:', error);
      const err = new Error(`Gemini API error (${response.status}): ${error}`);
      err.status = response.status;
      throw err;
    }

    return response.json();
  }, { maxRetries: 2, baseDelay: 2000 });

  // Extract token usage from response (including thinking tokens for Gemini 2.5)
  const imageUsage = {
    input_tokens: data.usageMetadata?.promptTokenCount || 0,
    output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
    thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0
  };
  if (imageUsage.input_tokens > 0 || imageUsage.output_tokens > 0) {
    const thinkingInfo = imageUsage.thinking_tokens > 0 ? `, thinking: ${imageUsage.thinking_tokens.toLocaleString()}` : '';
    log.debug(`📊 [IMAGE GEN] Token usage - input: ${imageUsage.input_tokens.toLocaleString()}, output: ${imageUsage.output_tokens.toLocaleString()}${thinkingInfo}`);
  }
  // Structured cost log so analyze-story-log.js can attribute Nano Banana spend.
  recordImageApiUsage(modelId, evaluationType, imageUsage);

  if (!data.candidates || data.candidates.length === 0) {
    log.error('❌ [IMAGE GEN] No candidates in response');
    throw new Error('No image generated - no candidates in response');
  }

  // Extract image data
  const candidate = data.candidates[0];

  // Extract thinking text from response (Gemini 3 Pro / 2.5 Flash thinking mode)
  const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN');

  if (candidate.content && candidate.content.parts) {
    for (const part of candidate.content.parts) {
      // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API may vary
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const imageDataSize = inlineData.data.length;
        const imageSizeKB = (imageDataSize / 1024).toFixed(2);
        console.log(`✅ [IMAGE GEN] Successfully extracted image data (${imageSizeKB} KB base64)`);
        const pngImageData = `data:image/png;base64,${inlineData.data}`;

        // Compress PNG to JPEG
        log.debug('🗜️  [COMPRESSION] Compressing image to JPEG...');
        const compressedImageData = await compressImageToJPEG(pngImageData);

        // Call onImageReady callback immediately (before quality eval) for progressive display
        if (onImageReady) {
          try {
            await onImageReady(compressedImageData, modelId);
            log.debug('📤 [IMAGE GEN] Image sent for immediate display (quality eval pending)');
          } catch (callbackError) {
            log.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
          }
        }

        // Skip quality evaluation for avatar conversions (just style transfer, no scene composition)
        if (evaluationType === 'avatar') {
          log.debug(`⏭️ [QUALITY] Skipping quality evaluation for avatar conversion`);
          const result = {
            imageData: compressedImageData,
            score: null,
            reasoning: null,
            modelId,
            thinkingText,
            imageUsage: imageUsage
          };
          imageCache.set(cacheKey, result);
          return result;
        }

        // Evaluate image quality with prompt and reference images
        log.debug(`📊 [EVAL] Evaluating image quality (${evaluationType})...${qualityModelOverride ? ` [model: ${qualityModelOverride}]` : ''}`);
        const qualityResult = await evaluateImageQuality(compressedImageData, prompt, characterPhotos, evaluationType, qualityModelOverride, pageContext, storyText, sceneHint, sceneCharacters);

        // Extract score, reasoning, and text error info from quality result
        const score = qualityResult ? qualityResult.score : null;
        const reasoning = qualityResult ? qualityResult.reasoning : null;
        const textIssue = qualityResult ? qualityResult.textIssue : null;
        const textErrorOnly = qualityResult ? qualityResult.textErrorOnly : false;
        const expectedText = qualityResult ? qualityResult.expectedText : null;
        const actualText = qualityResult ? qualityResult.actualText : null;
        const qualityUsage = qualityResult ? qualityResult.usage : null;
        const qualityModelId = qualityResult ? qualityResult.modelId : null;
        const fixTargets = qualityResult ? qualityResult.fixTargets : [];
        const fixableIssues = qualityResult ? qualityResult.fixableIssues : [];
        const figures = qualityResult ? qualityResult.figures : [];
        const matches = qualityResult ? qualityResult.matches : [];
        const objectMatches = qualityResult ? qualityResult.object_matches : [];

        // Store in cache (include text error info for covers)
        const result = {
          imageData: compressedImageData,
          score,
          reasoning,
          textIssue,
          textErrorOnly,
          expectedText,
          actualText,
          fixTargets, // Bounding boxes for auto-repair (from evaluation)
          fixableIssues, // New format without bboxes (for two-stage detection)
          figures, // Figure detection results from evaluation
          matches, // Character-to-figure matches from evaluation
          objectMatches, // Object/animal/landmark matches from evaluation
          semanticResult: qualityResult?.semanticResult || null,
          semanticScore: qualityResult?.semanticScore ?? null,
          issuesSummary: qualityResult?.issuesSummary || null,
          verdict: qualityResult?.verdict || null,
          modelId,  // Include which model was used for image generation
          qualityModelId,  // Include which model was used for quality evaluation
          thinkingText, // Gemini thinking/reasoning text (if available)
          imageUsage: imageUsage,  // Token usage for image generation
          qualityUsage: qualityUsage,  // Token usage for quality evaluation
          // Reconstruction record: prompt + reference images actually sent in
          // this call. parts[0] holds the exact sent text (post-truncation when
          // a model cap applied); grokRefImages is the historical field name for
          // "refs sent to the image model".
          prompt: parts[0]?.text || prompt,
          grokRefImages: parts
            .filter(p => p.inline_data)
            .map(p => `data:${p.inline_data.mime_type};base64,${p.inline_data.data}`)
        };
        imageCache.set(cacheKey, result);
        log.verbose('💾 [IMAGE CACHE] Stored in cache. Total cached:', imageCache.size, 'images');

        return result;
      }
    }
  } else {
    const reason = candidate.finishReason || 'unknown';
    const message = candidate.finishMessage || 'no message';
    log.error(`❌ [IMAGE GEN] Image blocked: reason=${reason}, message=${message}`);
    log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
    throw new Error(`Image blocked by API: reason=${reason}, message=${message}`);
  }

  // No image found - log what Gemini actually returned (likely a refusal message)
  const textParts = candidate.content?.parts?.filter(p => p.text) || [];
  if (textParts.length > 0) {
    const refusalMessage = textParts.map(p => p.text).join(' ').substring(0, 500);
    log.error(`❌ [IMAGE GEN] No image data - Gemini returned text instead: "${refusalMessage}"`);
    log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
    throw new Error(`Image generation refused: ${refusalMessage.substring(0, 200)}`);
  }

  log.error('❌ [IMAGE GEN] No image data found in any part');
  log.error(`❌ [IMAGE GEN] Failed prompt (first 1000 chars): "${prompt.substring(0, 1000)}..."`);
  throw new Error('No image data in response - check logs for API response structure');
}

/**
 * Generate image without quality evaluation
 * Used by the separated evaluation pipeline to generate all images first, then evaluate in batch
 * This is a streamlined version of callGeminiAPIForImage that skips evaluation
 *
 * @param {string} prompt - The image generation prompt
 * @param {Array} characterPhotos - Array of character photos (URLs or {name, photoUrl} objects)
 * @param {Object} options - Generation options
 * @param {string|null} options.previousImage - Previous image for sequential mode
 * @param {string|null} options.imageModelOverride - Model override for image generation
 * @param {string|null} options.imageBackendOverride - Backend override ('gemini' or 'runware')
 * @param {Array} options.landmarkPhotos - Landmark reference photos
 * @param {Buffer|null} options.visualBibleGrid - Visual Bible grid buffer
 * @param {number|null} options.pageNumber - Page number for cache key
 * @param {Function|null} options.onImageReady - Callback for progressive display
 * @returns {Promise<{imageData: string, modelId: string, usage: Object}>}
 */
async function generateImageOnly(prompt, characterPhotos = [], options = {}) {
  const {
    previousImage = null,
    imageModelOverride = null,
    imageBackendOverride = null,
    landmarkPhotos = [],
    visualBibleGrid = null,
    pageNumber = null,
    onImageReady = null,
    skipCache = false,
    artStyle = 'watercolor',
    sceneBackground = null,
    // Text area mask — black/white PNG telling the model where to keep calm
    // space for text overlay. White region = calm/light, black = full detail.
    // Used primarily by empty scene generation.
    textAreaMask = null,
    // Output aspect ratio — defaults to MODEL_DEFAULTS.pageAspect (A4 portrait)
    // so callers that forget to pass one still get the configured page aspect.
    // Callers can override: avatars pass '9:16', covers pass MODEL_DEFAULTS.coverAspect.
    // Flows through to Grok and Gemini image configs.
    aspectRatio = CONFIG_DEFAULTS.pageAspect,
    // Test Lab prompt-capture label (promptCapture.js). When set, the prompt is
    // recorded at this shared chokepoint so every provider route is covered by
    // one line (e.g. 'image_cover', 'image_scene'). No-op outside an experiment.
    captureLabel = null,
    // Post-gen crop of a stray uniform frame the model paints despite the D-01
    // prompt ban (a blue/black keyline framing the art). Page scenes want it;
    // covers (title paint) and avatars opt out by passing stripBorder: false.
    stripBorder = true
  } = options;

  if (captureLabel) {
    require('./promptCapture').recordPrompt(captureLabel, imageModelOverride, prompt, { kind: 'image' });
  }

  // Check cache first (include previousImage presence and page number in cache key)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null, pageNumber, sceneBackground ? 'bg' : null);

  // For generateImageOnly, we use a separate cache namespace to avoid conflicts with evaluated images
  const genOnlyCacheKey = `genonly_${cacheKey}`;

  if (!skipCache && imageCache.has(genOnlyCacheKey)) {
    log.debug(`💾 [IMAGE GEN-ONLY] Cache HIT (${imageCache.size} cached)`);
    const cachedResult = imageCache.get(genOnlyCacheKey);
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
      } catch (callbackError) {
        log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.debug(`🆕 [IMAGE GEN-ONLY] Cache MISS - key: ${genOnlyCacheKey.substring(0, 24)}...`);

  // Shared provider-dispatch ladder (Runware/Grok/Gemini selection + reference
  // packing + truncation + aspect + onImageReady). See _dispatchImageGeneration.
  const raw = await _dispatchImageGeneration(prompt, characterPhotos, {
    logLabel: 'IMAGE GEN-ONLY',
    verbose: false,
    previousImage,
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos,
    visualBibleGrid,
    sceneBackground,
    textAreaMask,
    onImageReady,
    outputAspect: aspectRatio,
    evaluationType: null,
    // generateImageOnly is only used for page regeneration, so always STANDARD.
    grokPrimaryModel: GROK_MODELS.STANDARD,
    grokPrimaryModelKey: 'grok-imagine',
    usePadExtension: true,
    avatarMode: false,
    pageLabel: pageNumber != null ? String(pageNumber) : '',
    defaultModel: MODEL_DEFAULTS.pageImage,
    includeSceneBackgroundPart: true,
  });

  // Strip a stray uniform frame the model painted despite the D-01 prompt ban
  // (a blue/black keyline framing the art — observed ~20% of pages). Deterministic
  // + conservative: server/lib/borderCrop.js only fires for a genuine four-sided
  // thin uniform frame. Covers the Grok/Runware branches (raw.imageData is set
  // here); the rare Gemini fallback below is not yet covered.
  if (stripBorder && raw?.imageData) {
    try {
      const { stripUniformBorder } = require('./borderCrop');
      const cropRes = await stripUniformBorder(Buffer.from(r2Lib.stripDataUriPrefix(raw.imageData), 'base64'));
      if (cropRes.cropped) {
        raw.imageData = `data:image/jpeg;base64,${cropRes.buffer.toString('base64')}`;
        log.info(`✂️ [IMAGE GEN-ONLY]${pageNumber != null ? ` p${pageNumber}` : ''} stripped uniform frame ${JSON.stringify(cropRes.frameColor)} (sides ${JSON.stringify(cropRes.sides)})`);
      }
    } catch (e) {
      log.warn(`⚠️ [IMAGE GEN-ONLY] border strip failed (keeping original): ${e.message}`);
    }
  }

  // ── Shape raw result per provider (gen-only: no eval, minimal shape) + cache ─
  if (raw.provider === 'runware-primary') {
    const finalResult = {
      imageData: raw.imageData,
      modelId: raw.modelId,
      usage: raw.usage
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'grok-primary') {
    const finalResult = {
      imageData: raw.imageData,
      prompt,
      modelId: raw.modelId,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'runware-routed') {
    const finalResult = {
      imageData: raw.imageData,
      prompt: raw.promptSent,
      modelId: raw.modelId,
      usage: raw.usage,
      // Reconstruction record — refs were built above but never stamped.
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  if (raw.provider === 'grok-routed') {
    const finalResult = {
      imageData: raw.imageData,
      prompt: raw.promptSent,
      modelId: raw.modelId,
      usage: raw.usage,
      grokRefImages: raw.packedRefs.length > 0 ? raw.packedRefs : undefined,
    };
    if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
    return finalResult;
  }

  // ── Gemini fallback: terminal fetch WITH the 3-level safety sanitization loop ─
  // The core already built `parts`, resolved + swapped `modelId`, and truncated
  // the prompt into `effectivePrompt`. This block is generateImageOnly's ORIGINAL
  // Gemini generator — deliberately NOT shared with callGeminiAPIForImage's
  // single-shot generator (that one records usage + extracts refusal text; this
  // one runs a sanitization retry loop instead).
  const { parts, modelId, effectivePrompt } = raw;
  const apiKey = process.env.GEMINI_API_KEY;

  const systemInstruction = getImageSystemInstruction();
  const modelTemp = IMAGE_MODELS[modelId]?.temperature ?? 0.8;
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: modelTemp,
      ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } }),
      imageConfig: {
        aspectRatio
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN-ONLY] Calling Gemini API with prompt (${prompt.length} chars), model: ${modelId}, temperature: ${modelTemp}, aspect: ${aspectRatio}, systemInstruction: ${!!systemInstruction}`);

  // Progressive retry with sanitization on safety blocks
  // Progressive retries on safety blocks. Level 1 is a cheap local word
  // strip; level 2 asks Claude to REWRITE the scene — defuse the safety
  // trigger while keeping the story moment (same rewriteBlockedScene used
  // by the main generation path). The former levels 2-3 replaced the prompt
  // with a generic "happy child in a magical setting" one-liner, so the
  // "successful" image had nothing to do with the page (observed: a
  // fairy/bubbles image shipped as a Tell-saga crossbow scene on
  // job_1781289599516 p4). If the rewritten scene is STILL blocked, this
  // function throws — a wrong image is worse than no image.
  const rewriteSceneInPrompt = async () => {
    const { callTextModel } = require('./textModels');
    const sceneMatch = prompt.match(/\*\*THIS IMAGE DEPICTS:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i)
      || prompt.match(/\*\*SCENE:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i)
      || prompt.match(/Scene Description:\s*([\s\S]*?)(?=\n\n\*\*|$)/i);
    const originalScene = sceneMatch?.[1]?.trim();
    const rewriteResult = await rewriteBlockedScene(originalScene || prompt, callTextModel);
    // Replace the scene block in place so style / reference / no-text rules
    // survive; when no scene block was found (custom prompts like
    // scale-repair or empty-scene), use the rewrite as the whole prompt.
    return originalScene ? prompt.replace(originalScene, rewriteResult.text) : rewriteResult.text;
  };
  const sanitizationLevels = [
    null,                                       // Level 0: original prompt
    () => sanitizePromptLevel1(prompt),         // Level 1: strip safety-trigger words
    rewriteSceneInPrompt,                       // Level 2: Claude scene rewrite (keeps the story moment)
  ];

  for (let sanitizationLevel = 0; sanitizationLevel < sanitizationLevels.length; sanitizationLevel++) {
    // Apply sanitization if needed
    let currentPrompt = prompt;
    if (sanitizationLevel > 0) {
      try {
        currentPrompt = await sanitizationLevels[sanitizationLevel]();
      } catch (rewriteErr) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Level ${sanitizationLevel} prompt rewrite failed: ${rewriteErr.message}`);
        throw new Error(`Image blocked and scene rewrite failed: ${rewriteErr.message}`);
      }
      parts[0] = { text: currentPrompt };
      log.info(`🔄 [IMAGE GEN-ONLY] Retry with sanitization level ${sanitizationLevel}${sanitizationLevel === 2 ? ' (Claude scene rewrite)' : ''}, prompt: ${currentPrompt.substring(0, 100)}...`);
    }

    try {
      const data = await withRetry(async () => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const error = await response.text();
          log.error('❌ [IMAGE GEN-ONLY] Gemini API error response:', error);
          const err = new Error(`Gemini API error (${response.status}): ${error}`);
          err.status = response.status;
          throw err;
        }

        return response.json();
      }, { maxRetries: 2, baseDelay: 2000 });

      // Extract token usage
      const usage = {
        input_tokens: data.usageMetadata?.promptTokenCount || 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0
      };

      if (!data.candidates || data.candidates.length === 0) {
        // No candidates = likely safety block
        log.warn(`⚠️ [IMAGE GEN-ONLY] No candidates (safety block?) at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error('No image generated - no candidates in response');
      }

      const candidate = data.candidates[0];
      const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN-ONLY');

      // Check for safety block at candidate level
      const finishReason = candidate.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Content blocked (${finishReason}) at level ${sanitizationLevel}`);
        if (sanitizationLevel < sanitizationLevels.length - 1) continue;
        throw new Error(`Image blocked by API: reason=${finishReason}`);
      }

      if (candidate.content && candidate.content.parts) {
        for (const part of candidate.content.parts) {
          const inlineData = part.inlineData || part.inline_data;
          if (inlineData && inlineData.data) {
            const pngImageData = `data:image/png;base64,${inlineData.data}`;
            const compressedImageData = await compressImageToJPEG(pngImageData);

            if (onImageReady) {
              try {
                await onImageReady(compressedImageData, modelId);
              } catch (callbackError) {
                log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
              }
            }

            const result = {
              imageData: compressedImageData,
              // parts[0] holds the exact sent text — after a safety block the
              // sanitized/rewritten prompt, not the original.
              prompt: parts[0]?.text || effectivePrompt,
              modelId,
              thinkingText,
              usage,
              sanitizationLevel, // Track which level succeeded
              // Reconstruction record — refs were in parts but never stamped.
              grokRefImages: parts
                .filter(p => p.inline_data)
                .map(p => `data:${p.inline_data.mime_type};base64,${p.inline_data.data}`)
            };

            if (!skipCache) imageCache.set(genOnlyCacheKey, result);
            if (sanitizationLevel > 0) {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated with sanitization level ${sanitizationLevel}`);
            } else {
              log.info(`✅ [IMAGE GEN-ONLY] Image generated successfully`);
            }
            return result;
          }
        }
      }

      // No image data in response but also not explicitly blocked
      const reason = candidate.finishReason || 'unknown';
      log.warn(`⚠️ [IMAGE GEN-ONLY] No image data, reason=${reason} at level ${sanitizationLevel}`);
      if (sanitizationLevel < sanitizationLevels.length - 1) continue;
      throw new Error(`Image blocked by API: reason=${reason}`);

    } catch (error) {
      const errorMsg = error.message?.toLowerCase() || '';
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                            errorMsg.includes('prohibited') || errorMsg.includes('filtered') ||
                            errorMsg.includes('no candidates') || errorMsg.includes('no image generated');

      if (isSafetyBlock && sanitizationLevel < sanitizationLevels.length - 1) {
        log.warn(`⚠️ [IMAGE GEN-ONLY] Safety block at level ${sanitizationLevel}, trying level ${sanitizationLevel + 1}...`);
        continue;
      }
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw new Error('Image generation failed after all sanitization levels');
}

/**
 * Generate an image with iterative placement for scenes with characters at different depths.
 * Pass 1: Generate scene with only foreground character(s)
 * Pass 2: Send Pass 1 image as reference + background character avatar, ask model to add background character as tiny figure
 *
 * @param {string} prompt - The full image generation prompt
 * @param {Array} allCharacterPhotos - All character reference photos
 * @param {Object} sceneMetadata - Scene metadata with character depth info
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Image generation result
 */
async function generateWithIterativePlacement(prompt, allCharacterPhotos, sceneMetadata, options = {}) {
  const {
    imageModelOverride,
    imageBackendOverride,
    landmarkPhotos = [],
    visualBibleGrid = null,
    pageNumber = null,
    artStyle = '',
  } = options;

  // 1. Split characters by depth from sceneMetadata.fullData (the parsed JSON scene object)
  // sceneMetadata.characters is string[] (names only), fullData.characters has depth/position/action
  const sceneChars = sceneMetadata?.fullData?.characters || [];
  const foregroundChars = [];
  const backgroundChars = [];

  for (const sc of sceneChars) {
    // Only "background" depth triggers two-pass (midground is close enough for single-pass)
    // Also check position string for "background" patterns from the iteration prompt
    const depth = (sc.depth || '').toLowerCase();
    const position = (sc.position || '').toLowerCase();
    if (depth === 'background' || position.includes('background')) {
      backgroundChars.push(sc);
    } else {
      foregroundChars.push(sc);
    }
  }

  // If no background chars, no structured data, or only 1 character total, use single-pass
  if (backgroundChars.length === 0 || sceneChars.length <= 1) {
    log.info(`🎯 [ITERATIVE] No background characters found (${sceneChars.length} chars, ${backgroundChars.length} bg), using single-pass generation`);
    return generateImageOnly(prompt, allCharacterPhotos, {
      imageModelOverride, imageBackendOverride, landmarkPhotos, visualBibleGrid, pageNumber, skipCache: true
    });
  }

  // 2. Split character photos by foreground/background
  const foregroundNames = new Set(foregroundChars.map(c => c.name));
  const foregroundPhotos = allCharacterPhotos.filter(p => foregroundNames.has(p.name || p.characterName));
  const backgroundNames = backgroundChars.map(c => c.name);
  const backgroundPhotos = allCharacterPhotos.filter(p => backgroundNames.includes(p.name || p.characterName));

  // Extract scene info for prompt building
  // Prose format: setting details are in imageSummary (the prose itself), no structured setting object
  const imageSummary = sceneMetadata?.fullData?.imageSummary || sceneMetadata?.imageSummary || '';
  const settingDesc = sceneMetadata?.fullData?.setting?.description || '';
  const camera = sceneMetadata?.fullData?.setting?.camera || 'wide shot';
  const fgNames = foregroundChars.map(c => c.name).join(', ');
  const bgNamesList = backgroundChars.map(c => c.name).join(', ');
  const styleLine = artStyle ? `**ART STYLE:** ${artStyle}\n\n` : '';

  // 3. Pass 1: Generate scene with ONLY foreground character(s)
  const fgCharDesc = foregroundChars.map(c =>
    `- ${c.name}: ${c.position || 'foreground'}, ${c.action || 'standing'}${c.expression ? ', ' + c.expression : ''}`
  ).join('\n');

  const pass1Prompt = fillTemplate(LOCAL_PROMPTS.iterativePlacementPass1, {
    STYLE_LINE: styleLine,
    SCENE_BODY: settingDesc || imageSummary,
    CAMERA: camera,
    FG_CHAR_DESC: fgCharDesc,
    FG_NAMES: fgNames,
  });

  log.info(`🎯 [ITERATIVE] Pass 1: ${foregroundPhotos.length} foreground chars (${fgNames}), excluding ${bgNamesList}`);
  log.info(`🎯 [ITERATIVE] Pass 1 prompt (${pass1Prompt.length} chars)`);

  let pass1Result;
  try {
    pass1Result = await generateImageOnly(pass1Prompt, foregroundPhotos, {
      imageModelOverride, imageBackendOverride, landmarkPhotos, visualBibleGrid, pageNumber, skipCache: true
    });
  } catch (err) {
    log.error(`🎯 [ITERATIVE] Pass 1 threw: ${err.message}`);
    throw err;
  }

  if (!pass1Result?.imageData) {
    log.error('🎯 [ITERATIVE] Pass 1 failed — no image generated');
    return pass1Result;
  }

  log.info(`🎯 [ITERATIVE] Pass 1 complete. Now adding ${backgroundChars.length} background character(s)...`);

  // 4. Pass 2: Add background character(s) to the Pass 1 image
  const bgCharDesc = backgroundChars.map(c => {
    const parts = [c.name];
    if (c.position) parts.push(`on the ${c.position}`);
    if (c.action) parts.push(c.action);
    if (c.clothing) parts.push(`wearing ${c.clothing}`);
    return parts.join(', ');
  }).join('\n- ');

  const pass2Prompt = fillTemplate(LOCAL_PROMPTS.iterativePlacementPass2, {
    STYLE_LINE: styleLine,
    FG_NAMES: fgNames,
    BG_CHAR_DESC: bgCharDesc,
  });

  log.info(`🎯 [ITERATIVE] Pass 2 prompt (${pass2Prompt.length} chars)`);

  let pass2Result;
  try {
    pass2Result = await generateImageOnly(pass2Prompt, backgroundPhotos, {
      imageModelOverride, imageBackendOverride,
      previousImage: pass1Result.imageData,
      landmarkPhotos, visualBibleGrid,
      pageNumber, skipCache: true
    });
  } catch (err) {
    log.error(`🎯 [ITERATIVE] Pass 2 threw: ${err.message}`);
    return {
      ...pass1Result,
      iterativePlacement: true,
      pass2Failed: true,
      pass2Error: err.message,
      pass1Image: pass1Result.imageData,
      pass1Prompt: pass1Prompt,
      pass2Prompt: pass2Prompt,
      prompt: prompt,
    };
  }

  if (pass2Result?.imageData) {
    log.info(`🎯 [ITERATIVE] Pass 2 complete. Scene with iterative placement ready.`);
    return {
      ...pass2Result,
      iterativePlacement: true,
      pass1Image: pass1Result.imageData,
      pass1Prompt: pass1Prompt,
      pass2Prompt: pass2Prompt,
      prompt: prompt,
    };
  }

  // Pass 2 returned no imageData (shouldn't happen, but just in case)
  log.warn('🎯 [ITERATIVE] Pass 2 returned no imageData, returning Pass 1 result');
  return {
    ...pass1Result,
    iterativePlacement: true,
    pass2Failed: true,
    pass2Error: 'Pass 2 returned no imageData',
    pass1Image: pass1Result.imageData,
    pass1Prompt: pass1Prompt,
    pass2Prompt: pass2Prompt,
    prompt: prompt,
  };
}

// =============================================================================
// SEPARATED EVALUATION PIPELINE FUNCTIONS
// These functions support the unified pipeline architecture:
// 1. Generate ALL images first (generateImageOnly)
// 2. Evaluate ALL images in parallel (evaluateImageBatch)
// 3. Run the unified repair loop (runUnifiedRepairPipeline) which iterates,
//    inpaints, picks best versions, and runs character repair on entity issues
// =============================================================================


/**
 * Evaluate multiple images in parallel for quality and issues
 * This is used by the separated evaluation pipeline to evaluate all generated images at once
 *
 * @param {Array<Object>} images - Array of image objects
 * @param {string} images[].imageData - Base64 image data
 * @param {number} images[].pageNumber - Page number
 * @param {string} images[].prompt - The prompt used to generate the image
 * @param {Array} images[].characterPhotos - Character reference photos
 * @param {string} images[].sceneDescription - Scene description for metadata extraction
 * @param {string} images[].pageText - Story text for this page (for semantic fidelity check)
 * @param {string} images[].sceneHint - Direct statement of what image should show (for semantic eval)
 * @param {Object} options - Evaluation options
 * @param {number} options.concurrency - Max concurrent evaluations (default: 10)
 * @param {string|null} options.qualityModelOverride - Model override for quality evaluation
 * @returns {Promise<Array<Object>>} Array of evaluation results per page
 */
async function evaluateImageBatch(images, options = {}) {
  const {
    concurrency = 100,
    qualityModelOverride = null,
    visualBible = null,
    clothingRequirements = null,
    artStyle = null,
    // Story-level context for eval_findings stats (best-effort; per-style works
    // from artStyle alone, the rest populate once the batch caller threads them).
    storyId = null,
    genre = null,
    language = null
  } = options;

  if (!images || images.length === 0) {
    return [];
  }

  log.info(`🔍 [BATCH EVAL] Evaluating ${images.length} images (concurrency: ${concurrency})...`);
  const startTime = Date.now();

  const evalLimit = pLimit(concurrency);

  const results = await Promise.all(images.map(img => evalLimit(async () => {
    const pageLabel = `PAGE ${img.pageNumber}`;
    try {
      // Skip if no image data
      if (!img.imageData) {
        log.warn(`⚠️  [BATCH EVAL] ${pageLabel}: No image data, skipping evaluation`);
        return {
          pageNumber: img.pageNumber,
          evaluated: false,
          error: 'No image data'
        };
      }

      // The clothing facts now travel as the CLOTHING CONTRACT input, built
      // inside evaluateImageQuality from these same photos — prepending them to
      // the prompt as well would state the outfit twice.
      const sceneDescWithClothing = `${img.sceneDescription || img.prompt || ''}`;

      // Run quality evaluation (with parallel semantic fidelity check if pageText provided)
      // Use img.evaluationType if set (covers use 'cover' for text-focused eval)
      // Lab/staging parity: resolveEvalArtStyle is the ONE resolver both this
      // path and the Test Lab quality_eval stage use. ORIGINAL_PROMPT here is the
      // scene DESCRIPTION (no ART STYLE block), so without this every
      // style-dependent evaluator rule skipped silently in production too.
      //
      // allCharacterPhotos (batch-global identity list, {name, photoUrl} only)
      // wins the refs slot, and the eval's clothing-contract builder reads
      // clothingDescription off THESE refs — so the contract was empty for
      // every batch eval. Pages hid it (scene prose weaves the outfits into
      // ORIGINAL_PROMPT); a cover's description has no clothing text, so the
      // judge ruled the requested costume "unrequested" and the repair
      // stripped it (verified: identical cover + prompt scores 0 without
      // clothingDescription on refs, 100 with). Merge the per-page outfit in.
      const richClothingByName = new Map((img.characterPhotos || [])
        .filter(p => p?.name && p?.clothingDescription)
        .map(p => [String(p.name).toLowerCase(), p.clothingDescription]));
      const refsForEval = (img.allCharacterPhotos || img.characterPhotos || []).map(p =>
        p?.clothingDescription ? p : {
          ...p,
          clothingDescription: richClothingByName.get(String(p?.name || '').toLowerCase()) || null,
        });
      const qualityResult = await evaluateImageQuality(
        img.imageData,
        sceneDescWithClothing,
        refsForEval,
        img.evaluationType || 'scene',
        qualityModelOverride,
        pageLabel,
        img.pageText || null,  // Story text for semantic fidelity check
        img.sceneHint || null, // Scene hint for semantic evaluation
        img.sceneCharacters || null,  // Enables STEP 2C head-to-body proportion check
        // evalOptions: story-level context so the eval records per-style/genre
        // stats to eval_findings (best-effort; no behaviour change).
        {
          artStyle: require('../services/prompts').resolveEvalArtStyle(artStyle, img.prompt || null),
          // Structured cover text contract from the pseudo-page record
          // (expectedText / textMode) — see evaluateImageQuality's cover branch.
          expectedText: img.expectedText ?? null,
          textMode: img.textMode ?? null,
          storyMeta: {
          storyId, pageNumber: img.pageNumber, artStyle, genre, language,
          charCount: Array.isArray(img.sceneCharacters) ? img.sceneCharacters.length : null,
        } }
      );

      // Use pre-extracted scene metadata if available, otherwise extract from scene description
      const sceneMetadata = img.sceneMetadata || (img.sceneDescription
        ? getStoryHelpers().extractSceneMetadata(img.sceneDescription)
        : null);
      const expectedCharacterPositions = sceneMetadata?.characterPositions || {};
      const expectedCharacterClothing = sceneMetadata?.characterClothing || {};
      const expectedObjects = sceneMetadata?.objects || [];

      // Use rich character descriptions from full character objects when available
      let characterDescriptions;
      if (img.sceneCharacters && img.sceneCharacters.length > 0) {
        characterDescriptions = {};
        for (const char of img.sceneCharacters) {
          // Resolve each category through the story's clothingRequirements
          // (signature → description → avatars.clothing fallback) — raw
          // avatars.clothing is character-level metadata that can be stale
          // across stories, so the evaluator judged against the wrong outfit.
          let clothingDescriptions = char.avatars?.clothing || {};
          if (clothingRequirements) {
            const { buildClothingDescription } = require('./entityConsistency');
            const { resolveCharacterReqs } = require('./clothingCategories');
            const categories = new Set([
              ...Object.keys(char.avatars?.clothing || {}),
              ...Object.keys(resolveCharacterReqs(clothingRequirements, char.name) || {}),
            ]);
            const resolved = {};
            for (const cat of categories) {
              resolved[cat] = buildClothingDescription(char, cat, artStyle, clothingRequirements);
            }
            clothingDescriptions = resolved;
          }
          characterDescriptions[char.name] = {
            richDescription: getStoryHelpers().buildCharacterPhysicalDescription(char),
            clothingDescriptions
          };
        }
      } else {
        // Fallback: parse minimal descriptions from prompt
        characterDescriptions = img.prompt
          ? getStoryHelpers().parseCharacterDescriptions(img.prompt)
          : {};
      }

      // Story-invented characters are in the Visual Bible, never in
      // sceneCharacters (that array is the photo-backed cast). Resolve the ones
      // this scene references so they reach the detector WITH a description —
      // a name-only entry can't tell figures apart. Same evidence as the shared
      // pre-detection in storyJobPipeline.js (job_1786737619634_d66c7bg9g p4:
      // Lira the mermaid missing → SoM answered A=Emma on the mermaid's badge).
      const sceneOnly = getStoryHelpers().buildSecondaryCharacterDescriptions(
        visualBible,
        getStoryHelpers().collectSceneCharacterNames(sceneMetadata, img.outlineCharacters || img.scene?.outlineCharacters || []),
        Object.keys(characterDescriptions),
        `PAGE ${img.pageNumber} `
      );
      if (Object.keys(sceneOnly).length > 0) {
        Object.assign(characterDescriptions, sceneOnly);
        log.debug(`📦 [BATCH EVAL] PAGE ${img.pageNumber}: ${Object.keys(sceneOnly).length} secondary character(s) from the Visual Bible: ${Object.keys(sceneOnly).join(', ')}`);
      }

      // Parse Visual Bible objects from prompt
      const vbObjects = parseVisualBibleObjects(img.prompt || '');
      // Scene metadata emits VB IDs ("ART003", "LOC001.2"); translate them to
      // natural-language names from the visualBible before passing to the bbox
      // detector — opaque IDs have no visual meaning and cause found:false
      // entries that produce fake appearance records downstream.
      const mergedExpected = [...expectedObjects, ...vbObjects.filter(o => !expectedObjects.includes(o))];
      const allExpectedObjects = resolveExpectedObjectLabels(mergedExpected, visualBible);

      // Run bounding box detection for all figures/objects
      const fixableIssues = qualityResult?.fixableIssues || [];
      const qualityMatches = qualityResult?.matches || [];
      const objectMatches = qualityResult?.object_matches || [];

      let bboxDetection = null;
      let enrichedFixTargets = [];

      if (qualityResult) {
        const enrichResult = await enrichWithBoundingBoxes(
          img.imageData,
          fixableIssues,
          qualityMatches,
          objectMatches,
          expectedCharacterPositions,
          allExpectedObjects,
          characterDescriptions,
          expectedCharacterClothing,
          null,
          null,
          `PAGE ${img.pageNumber}`,
          img.sharedBboxDetection || null, // Reuse pre-detected bbox if available
          artStyle,
          buildObjectGroundingHints(allExpectedObjects, visualBible),
          visualBible
        );
        bboxDetection = enrichResult.detectionHistory;
        enrichedFixTargets = enrichResult.targets || [];
      }

      // Create bbox overlay image for dev mode display
      let bboxOverlayImage = null;
      if (bboxDetection) {
        bboxOverlayImage = await createBboxOverlayImage(img.imageData, bboxDetection);
      }

      const evalResult = {
        pageNumber: img.pageNumber,
        evaluated: true,
        // Fingerprint of the EXACT bytes this eval scored. applyScore copies it
        // onto the version; pickBestVersionIndex refuses a score whose version
        // bytes no longer hash to it. Guards the eval↔bytes pairing the same way
        // sourceImageFp guards detections (job_1786571353564 p4: a version
        // shipped red bytes carrying the eval of its yellow predecessor).
        evalImageFp: hashImageData(img.imageData),
        score: qualityResult?.score ?? null,                    // Combined final score
        qualityScore: qualityResult?.qualityScore ?? qualityResult?.score ?? null,  // Visual quality only
        semanticScore: qualityResult?.semanticScore ?? null,    // Semantic fidelity only
        reasoning: qualityResult?.reasoning || null,
        verdict: qualityResult?.verdict || null,
        issuesSummary: qualityResult?.issuesSummary || null,
        fixableIssues: qualityResult?.fixableIssues || [],
        fixTargets: qualityResult?.fixTargets || [],
        enrichedFixTargets,
        figures: qualityResult?.figures || [],
        matches: qualityResult?.matches || [],
        objectMatches: qualityResult?.object_matches || [],
        // evaluateImageQuality returns these three, but this batch wrapper
        // rebuilds a whitelisted eval object and used to drop them — which is
        // why every stored scene had qualityRawOutput/evalTemplateHash null
        // even though repairPipeline maps finalEval.rawOutput into the scene
        // (O7) and buildVersionEntry reads evaluation.coherenceGate. The
        // whitelist, not the mapping, was the leak.
        rawOutput: qualityResult?.rawOutput ?? null,
        evalTemplateHash: qualityResult?.evalTemplateHash ?? null,
        coherenceGate: qualityResult?.coherenceGate ?? null,
        // Same whitelist lesson as rawOutput/coherenceGate above: a field not
        // listed here never reaches the stored version, however faithfully the
        // evaluator produced it.
        styleGate: qualityResult?.styleGate ?? null,
        bboxDetection,
        bboxOverlayImage,
        usage: qualityResult?.usage || null,
        modelId: qualityResult?.modelId || null,
        // Semantic fidelity results (parallel evaluation when pageText provided)
        semanticResult: qualityResult?.semanticResult || null,
        // Three-stage eval (vision-inventory + Sonnet compliance). Surfaced
        // verbatim so the dev panel can show Stage-1's free-form "what I see"
        // text and Stage-2's raw compliance JSON. Was being dropped before
        // this — only the score + issuesSummary survived.
        threeStageResult: qualityResult?.threeStageResult || null,
        // Text error info for covers
        textIssue: qualityResult?.textIssue || null,
        expectedText: qualityResult?.expectedText || null,
        actualText: qualityResult?.actualText || null
      };

      log.debug(`✅ [BATCH EVAL] ${pageLabel}: Quality ${evalResult.qualityScore ?? 'N/A'}%, Semantic ${evalResult.semanticScore ?? 'N/A'}%, Final ${evalResult.score ?? 'N/A'}%, ${enrichedFixTargets.length} fix targets`);
      return evalResult;
    } catch (error) {
      log.error(`❌ [BATCH EVAL] ${pageLabel}: Evaluation failed - ${error.message}`);
      return {
        pageNumber: img.pageNumber,
        evaluated: false,
        error: error.message
      };
    }
  })));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const successCount = results.filter(r => r.evaluated).length;
  log.info(`✅ [BATCH EVAL] Completed ${successCount}/${images.length} evaluations in ${elapsed}s`);

  return results;
}



// ============================================================================
// UNIFIED REPAIR PIPELINE
// Single pipeline: evaluate → regenerate (max 2) → pick best → character fix
// ============================================================================

/**
 * Select the best version from multiple image versions by score.
 * On tie, prefers the earlier version (less API cost).
 *
 * @param {Array<{imageData: string, score: number|null, source: string}>} versions
 * @returns {Object} The version with the highest score
 */

/**
 * Inpaint a page using Grok text edit. Builds an instruction from quality + semantic issues
 * and applies it via editImageWithPrompt().
 *
 * Reuses the same logic as the manual repair endpoint (POST /:id/repair/image/:pageNum).
 *
 * @param {string} imageData - Current image (base64 data URI)
 * @param {Object} evaluation - Evaluation result with fixableIssues, semanticResult, etc.
 * @param {Object} [options] - Optional overrides
 * @returns {Promise<{imageData: string|null, repaired: boolean, instruction: string|null, usage: Object|null}>}
 */
async function inpaintPage(imageData, evaluation, options = {}) {
  const {
    visualBible = null,
    characters = null,
    entityReport = null,
    pageNumber = null,
    sceneDescription = '',
    artStyle = null,
    characterClothing = null,
    // Story-level clothing spec ({name: {standard: {description, signature}, ...}}).
    // Merged into the per-character requirements passed to getCharacterPhotoDetails
    // so resolveClothingDescription reads THIS story's clothing instead of falling
    // through to stale cross-story avatars.clothing.
    clothingRequirements = null,
    // Audit trail: when provided, consolidator calls get persisted to DB
    storyId = null,
    round = null,
    // Per-page aspect (e.g. '1:1' for advanced/Jugendbuch, '3:4' for standard).
    // Without this, inpaint produces 3:4 images for square pages — which then
    // become the active version after the round-1 score, silently changing the
    // book's layout. Falls through to editImageWithPrompt → Grok/Gemini.
    aspectRatio = null,
    // Page's locked text-overlay corner. When set, the inpaint instruction
    // gets a soft "Quiet zone:" suffix telling Grok not to introduce
    // high-contrast detail in that corner — same warning the character-fix
    // path uses. Without this, inpaint can paint a face/hat into the calm
    // zone when the bbox happens to overlap it.
    textPosition = null,
  } = options;

  // Resolve the current-page clothing category for a character. Case-insensitive.
  // NO DEFAULT (owner, 2026-08-07): returns null when the scene metadata does
  // not list this character. The old 'standard' fallback named a category the
  // story may not use, which resolves to the character's stored wardrobe from
  // an unrelated story — and here that wardrobe becomes the REFERENCE IMAGE the
  // inpaint copies, so the guess is painted straight into the page.
  const clothingFor = (name) => {
    if (!characterClothing || !name) return null;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(characterClothing)) {
      if (k.toLowerCase() === lower) return v ? String(v).toLowerCase() : null;
    }
    return null;
  };

  const { getStyledAvatarForClothing } = require('./entityConsistency');

  // Collect quality issues (legacy path)
  const qualityIssues = (evaluation.fixableIssues || []).map(i => ({
    description: i.description || i.issue || i,
    source: 'quality'
  }));

  // Collect semantic issues (legacy path)
  const semanticIssues = (evaluation.semanticResult?.issues || evaluation.semanticResult?.semanticIssues || [])
    .map(si => ({
      description: si.problem || `${si.type}: ${si.item || ''}`,
      source: 'semantic',
      type: si.type,
      item: si.item
    }));

  // Combine and deduplicate
  const combinedIssues = [...qualityIssues, ...semanticIssues]
    .filter((issue, idx, arr) => {
      const desc = issue.description || '';
      return desc && arr.findIndex(i => (i.description || '') === desc) === idx;
    });

  if (combinedIssues.length === 0) {
    log.debug(`[INPAINT PAGE] No issues to fix, skipping inpaint`);
    return { imageData: null, repaired: false, instruction: null, usage: null };
  }

  // ---------------------------------------------------------------------------
  // NEW: Haiku consolidation — translates names to visual identifiers and
  // splits per-character fixes from scene fixes.
  // ---------------------------------------------------------------------------
  const { consolidateFeedback } = require('./feedbackConsolidator');

  // Resolve per-scene clothing descriptions so the consolidator reads the
  // variant the scene actually uses (e.g. costumed:mittelalterlich) instead
  // of the character's default (modern) clothing. Without this the
  // consolidator writes fixes like "redress figure in grey hoodie" for a
  // medieval scene.
  const sceneClothing = {};
  try {
    const helpers = getStoryHelpers();
    const charReqs = {};
    for (const [name, variant] of Object.entries(characterClothing || {})) {
      // Merge the story-level spec so resolveClothingDescription finds
      // clothingRequirements[name][category].signature/description (this
      // story's clothing) before falling back to stale avatars.clothing.
      const storyReqs = require('./clothingCategories').resolveCharacterReqs(clothingRequirements, name);
      charReqs[name] = {
        ...(storyReqs && typeof storyReqs === 'object' ? storyReqs : {}),
        _currentClothing: variant,
      };
    }
    const photos = helpers.getCharacterPhotoDetails(characters || [], null, artStyle || 'watercolor', charReqs);
    for (const p of photos) {
      if (p?.name && p?.clothingDescription) sceneClothing[p.name] = p.clothingDescription;
    }
  } catch (err) {
    log.debug(`[INPAINT PAGE] scene-clothing resolve failed: ${err.message}`);
  }

  // Pass full character objects so the consolidator can build authoritative
  // physical descriptions (with glasses, facial hair, etc.) — which override
  // any stale/incomplete scene descriptions or false eval flags.
  // Text-only consolidator: no image. Sonnet's job is to dedupe / sort / trim
  // evaluator findings, not to run its own vision pass. Without this, Sonnet
  // would invent fixes (e.g. "Replace the face") that no evaluator flagged.
  const consolidation = await consolidateFeedback({
    sceneDescription,
    evaluation,
    entityReport,
    pageNumber,
    characters: characters || [],
    sceneClothing,
    storyId,
    round,
  });

  // Decide the instruction to send Grok.
  // - If consolidator produced a plan: use scene_fix.instruction + attach avatars
  //   of any character referenced in per_character_fixes (Grok now KNOWS who to fix).
  // - Else fall back to the legacy concat instruction.
  let editInstruction;
  let consolidatedPlan = null;
  const referenceImages = [];
  const referenceImageSources = [];

  if (consolidation?.plan && !consolidation.error) {
    consolidatedPlan = consolidation.plan;

    // SAFETY NET — Haiku is told never to use character names in fix
    // instructions, but sometimes slips "Werner's body" or "Lukas's gaze"
    // into the text. Strip any main-character names and replace with the
    // character's own visual identifier (from per_character_fixes). Falls
    // back to "the character" for names not in the plan.
    const characterNames = (characters || []).map(c => c?.name).filter(Boolean);
    const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Per-name visual-identifier lookup from the consolidator plan.
    const visualIdByName = new Map();
    for (const pcf of (consolidatedPlan.per_character_fixes || [])) {
      if (pcf?.characterName && pcf?.visual_identifier) {
        visualIdByName.set(pcf.characterName.toLowerCase(), pcf.visual_identifier);
      }
    }
    // Fallback identifier when a name has no per_character_fixes entry: a
    // short age/gender descriptor from the character data. "the character"
    // loses WHO — observed: "Add <object> held in one of the character'
    // hands" let Grok pick the wrong figure entirely.
    const descriptorByName = new Map();
    for (const c of (characters || [])) {
      if (!c?.name) continue;
      const bits = [c.age ? `${c.age}-year-old` : null, c.gender || null].filter(Boolean).join(' ');
      descriptorByName.set(c.name.toLowerCase(), bits ? `the ${bits} figure` : 'the character');
    }
    const stripNames = (text, ownVisualId) => {
      if (!text || typeof text !== 'string' || characterNames.length === 0) return text;
      let out = text;
      for (const name of characterNames) {
        // Prefer the per-name visual identifier, else the current entry's own
        // identifier, else an age/gender descriptor built from character data.
        const vid = visualIdByName.get(name.toLowerCase()) || ownVisualId
          || descriptorByName.get(name.toLowerCase()) || 'the character';
        // Possessives: both "Hans's" and bare-apostrophe "Hans'" — the bare
        // form otherwise falls through to the name regex and leaves a
        // dangling apostrophe ("the character' hands").
        const possRe = new RegExp(`\\b${escapeRe(name)}['’]s?(?!\\w)`, 'g');
        out = out.replace(possRe, `${vid}'s`);
        const bareRe = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
        out = out.replace(bareRe, vid);
      }
      return out.replace(/\s{2,}/g, ' ').trim();
    };

    const sceneInstrRaw = consolidatedPlan.scene_fix?.instruction || '';
    const sceneInstr = stripNames(sceneInstrRaw, null);
    const perCharItems = (consolidatedPlan.per_character_fixes || [])
      .map(p => {
        const visualId = p.visual_identifier || 'this character';
        const fixRaw = p.fix_instruction || (p.issues || []).join('; ');
        const fix = stripNames(fixRaw, visualId);
        return { severity: p.severity, text: `For ${visualId}: ${fix}` };
      })
      .filter(x => x.text);

    // Merge scene fix + per-char fixes, order by severity (highest first), and
    // emit as a numbered list. Grok prioritises top items; putting the most
    // critical change first makes the instruction harder to ignore.
    const SEV_RANK = { CRITICAL: 4, MAJOR: 3, MODERATE: 2, MINOR: 1, NONE: 0 };
    const sevRank = (s) => SEV_RANK[String(s || 'MODERATE').toUpperCase()] ?? 2;
    const items = [];
    if (sceneInstr) items.push({ severity: consolidatedPlan.scene_fix?.severity, text: sceneInstr });
    for (const c of perCharItems) items.push(c);
    items.sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
    editInstruction = items
      .map((it, i) => `${i + 1}. ${it.text}`)
      .join('\n');

    // Note: avatars for per_character_fixes are NOT attached here. The figures
    // are already in the page image — Grok edits in place. Attaching the
    // standing-portrait avatar dragged Grok's pose toward the portrait
    // (characters drifted to the wrong positions, gestures mutated). The
    // page image is the best identity anchor for cosmetic fixes; avatars are
    // still attached below for "missing" issues where the figure isn't in the
    // page yet.

    const droppedAll = consolidatedPlan.dropped_issues || [];
    const deferred = droppedAll.filter(d => /capped at 3/i.test(d.reason || ''));
    const trueDrops = droppedAll.filter(d => !/capped at 3/i.test(d.reason || ''));

    log.info(`[INPAINT PAGE] P${pageNumber}: plan = ${consolidatedPlan.per_character_fixes.length} per-char + scene=${consolidatedPlan.scene_fix?.severity || 'NONE'}, ${deferred.length} deferred (cap=3), ${trueDrops.length} consolidated`);

    // Only flag drops that aren't the intentional cap-at-3 deferral. A
    // CRITICAL/MAJOR consolidated away (e.g. as a duplicate) is fine; one
    // dropped for an unrecognized reason is worth a warn.
    for (const d of trueDrops) {
      const issueText = d.issue || d.description || JSON.stringify(d);
      const reason = d.reason || '(no reason)';
      const sev = String(d.severity || '').toUpperCase();
      if (sev === 'CRITICAL' || sev === 'MAJOR') {
        log.info(`[INPAINT PAGE] P${pageNumber}: ${sev} consolidated — "${issueText}" (${reason})`);
      } else {
        log.debug(`[INPAINT PAGE] P${pageNumber}: dropped — "${issueText}" (${reason})`);
      }
    }
    for (const d of deferred) {
      const issueText = d.issue || d.description || JSON.stringify(d);
      log.debug(`[INPAINT PAGE] P${pageNumber}: deferred to next round — "${issueText}"`);
    }
  } else {
    // Fallback (consolidation returned no plan — usually its JSON was truncated
    // at the output cap on a busy page). Do NOT concatenate every issue: that
    // sent Grok a 4-issue blob it cannot execute atomically (observed on
    // job_1783845868262 P4). Rank by severity, keep the top few, and emit a
    // numbered atomic list — same shape and ≤3 cap as the plan path.
    const SEV = { CRITICAL: 4, MAJOR: 3, MODERATE: 2, MINOR: 1, NONE: 0 };
    const ranked = combinedIssues
      .filter(i => i.description)
      .sort((a, b) => (SEV[String(b.severity || 'MODERATE').toUpperCase()] ?? 2) - (SEV[String(a.severity || 'MODERATE').toUpperCase()] ?? 2))
      .slice(0, 3);
    editInstruction = ranked.map((it, i) => `${i + 1}. ${sanitizeIssueForInpaint(it.description)}`).join('\n');
    log.warn(`[INPAINT PAGE] Consolidator failed (${consolidation?.error || 'no plan'}), fallback to top-${ranked.length} of ${combinedIssues.length} issues by severity`);
  }

  // Find reference images for missing characters/animals from Visual Bible (still useful)
  const missingItems = combinedIssues.filter(i => i.type === 'missing_character' || i.type === 'missing_element');
  for (const missing of missingItems) {
    const itemName = (missing.item || '').toLowerCase().trim();
    if (!itemName) continue;

    const hasRef = (e) => !!(e?.referenceImageData || e?.referenceImageUrl);

    const vbAnimal = visualBible?.animals?.find(a => a.name?.toLowerCase() === itemName && hasRef(a));
    if (vbAnimal) {
      const bytes = await loadVbReferenceBytes(vbAnimal);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-animal:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB animal reference for missing "${missing.item}"`);
        continue;
      }
    }
    const vbChar = visualBible?.secondaryCharacters?.find(c => (c.name?.toLowerCase() === itemName || c.id?.toLowerCase() === itemName) && hasRef(c));
    if (vbChar) {
      const bytes = await loadVbReferenceBytes(vbChar);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-char:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB secondary character reference for missing "${missing.item}"`);
        continue;
      }
    }
    const vbArtifact = visualBible?.artifacts?.find(a => a.name?.toLowerCase() === itemName && hasRef(a));
    if (vbArtifact) {
      const bytes = await loadVbReferenceBytes(vbArtifact);
      if (bytes) {
        referenceImages.push(`data:image/jpeg;base64,${bytes}`);
        referenceImageSources.push(`vb-artifact:${missing.item}`);
        log.info(`[INPAINT PAGE] Adding VB artifact reference for missing "${missing.item}"`);
        continue;
      }
    }
    if (characters) {
      const mainChar = characters.find(c => c.name?.toLowerCase() === itemName);
      if (mainChar) {
        const pageClothing = clothingFor(mainChar.name);
        if (!pageClothing) {
          log.error(`❌ [INPAINT PAGE] ${mainChar.name}: no per-page clothing category — NOT adding an avatar reference. A guessed category would hand the inpaint an outfit from another story to copy.`);
          continue;
        }
        const avatar = await getStyledAvatarForClothing(mainChar, artStyle || 'watercolor', pageClothing);
        const photoUrl = typeof avatar === 'string' ? avatar : (avatar?.imageData || mainChar.photos?.body || mainChar.photos?.face);
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image') && !referenceImages.includes(photoUrl)) {
          referenceImages.push(photoUrl);
          referenceImageSources.push(`avatar-missing:${missing.item}:${pageClothing}`);
          log.info(`[INPAINT PAGE] Adding ${pageClothing} avatar for missing "${missing.item}" (style=${artStyle || 'watercolor'})`);
        }
      }
    }
  }

  if (!editInstruction || editInstruction.trim().length === 0) {
    log.debug(`[INPAINT PAGE] Empty instruction after consolidation, skipping`);
    return { imageData: null, repaired: false, instruction: null, consolidatedPlan, usage: null };
  }

  // Append a quiet-zone reminder when the page reserves a text-overlay
  // corner. Same wording as the character-fix path so Grok gets the same
  // signal regardless of repair mode.
  const TEXT_POSITION_DESC_INPAINT = {
    'top-left': 'upper left corner',
    'top-right': 'upper right corner',
    'bottom-left': 'lower left corner',
    'bottom-right': 'lower right corner',
    'top-full': 'upper third (full width)',
    'bottom-full': 'lower third (full width)',
  };
  // Pull the per-page textZoneDescription out of the scene metadata so the
  // quiet-zone instruction names the actual surface ("deep grey November sky",
  // "wet cobblestones") instead of just saying "calm". Without this Grok
  // interprets "soft and calm" as "flat uniform color" and replaces the
  // overcast sky with a uniform grey wash, losing all atmospheric detail.
  let inpaintTextZoneDesc = null;
  if (sceneDescription) {
    try {
      const meta = getStoryHelpers().extractSceneMetadata(sceneDescription);
      inpaintTextZoneDesc = meta?.textZoneDescription || null;
    } catch { /* fall through with null */ }
  }
  // Quiet zone is a SCENE-page concept: text is overlaid client-side onto a
  // calm region of the page. Covers render their text baked into the image
  // (title upper-third, branding bottom-left) and have no reserved calm
  // area — applying a quiet-zone instruction here would falsely tell Grok
  // to keep e.g. the upper-left soft, which conflicts with the title.
  const isCover = typeof pageNumber === 'number' && pageNumber <= 0;
  const quietZoneSuffix = !isCover && textPosition && TEXT_POSITION_DESC_INPAINT[textPosition]
    ? `\n\nQuiet zone: keep the ${TEXT_POSITION_DESC_INPAINT[textPosition]} as ${inpaintTextZoneDesc ? `the established ${inpaintTextZoneDesc} — preserve its existing atmospheric character (clouds, gradient, texture)` : 'soft and visually calm'}. Do not introduce faces, hats, patterns, or other high-contrast detail there, and do not flatten it to a uniform color. It is intentional negative space in the composition.`
    : '';

  // (Cover text is no longer preserved via a prompt hint. Covers render textless
  // and the title/dedication/branding is composited app-side by composeCover;
  // cover inpaint repaints the textless art layer and re-composites the text
  // afterward — see executeInpaintAction / restampCover.)

  // Strip entity-grid vocabulary ("cells A, D, F", "the reference (R)")
  // before the instruction reaches the image model — image models DRAW what
  // a prompt names. Previously only character-repair prompts were guarded.
  editInstruction = sanitizeIssueForInpaint(editInstruction);
  // Resolve raw VB ids that evals quote back verbatim ("missing ART001") —
  // an unresolved id makes Grok invent an object with the id painted on it
  // as lettering (observed: gadget labelled "ART001" instead of the VB
  // artifact, a child's backpack).
  {
    const { sanitizeVbIdsInPrompt } = require('./storyHelpers');
    editInstruction = sanitizeVbIdsInPrompt(editInstruction, visualBible, pageNumber);
  }
  const fullInstruction = `Fix these issues in this children's book illustration:\n${editInstruction}${quietZoneSuffix}`;
  log.info(`[INPAINT PAGE] Inpainting (refs: ${referenceImages.length}): ${editInstruction.substring(0, 200)}`);

  try {
    // No artStyle for a normal (local) edit — the source image already carries
    // the style and Grok matches the surrounding pixels; passing the resolved
    // descriptor there regressed inpaint quality versus the manual-repair path.
    // EXCEPTION — a reframe (rule 7b): the router (decideRepairMethod) sends
    // these to iterate, but the round-loop flip can bounce one back to inpaint
    // after an iterate regression. A reframe regenerates part of the frame, so
    // there are no surrounding pixels to match and "match the source" drifts to
    // photoreal — anchor the medium explicitly for that case only.
    const reframe = consolidatedPlan?.scene_fix?.requires_regeneration === true;
    const editResult = await editImageWithPrompt(imageData, fullInstruction, undefined, referenceImages, reframe ? (artStyle || null) : null, aspectRatio);
    if (editResult?.imageData) {
      if (editResult.imageData.length < 1000) {
        log.warn(`[INPAINT PAGE] Edit produced too-small image (${editResult.imageData.length} chars), rejecting`);
        return { imageData: null, repaired: false, instruction: editInstruction, consolidatedPlan, usage: editResult.usage };
      }
      return {
        imageData: editResult.imageData,
        repaired: true,
        instruction: editInstruction,
        referenceImages,
        referenceImageSources,
        consolidatedPlan,
        consolidatorUsage: consolidation?.usage || null,
        usage: editResult.usage,
      };
    }
    return { imageData: null, repaired: false, instruction: editInstruction, referenceImages, referenceImageSources, consolidatedPlan, usage: null };
  } catch (err) {
    log.error(`[INPAINT PAGE] Edit failed: ${err.message}`);
    return { imageData: null, repaired: false, instruction: editInstruction, referenceImages, referenceImageSources, consolidatedPlan, usage: null, error: err.message };
  }
}

/**
 * Unified repair pipeline — evaluates, picks ONE repair method per page per
 * round (skip / inpaint / iterate / char-fix), runs them in parallel, picks
 * best across all rounds, then runs the style-consistency audit.
 *
 * Flow:
 *   1. Evaluate all images: quality + semantic + entity (one parallel batch)
 *   2. Round loop (1 to maxPasses):
 *        - decideRepairMethod() per bad page → ONE method (or skip)
 *        - dispatch to executeIterateAction / executeInpaintAction /
 *          executeCharFixAction in parallel
 *        - re-evaluate every repaired page: quality + semantic + entity
 *          (entity included so rounds can compare scores like-for-like)
 *        - inpaint↔iterate flip on regression (lastRepairRegressed); char-fix
 *          stays char-fix when entity issues persist
 *   3. Pick best version per page (single pass over ALL rounds + original)
 *   4. Post-repair calm-zone recovery
 *   5. Style-consistency audit across the picked images
 *   6. Build final results
 *
 * Char-fix runs INSIDE the round loop as a per-page method choice — there is
 * no separate post-loop character-repair stage anymore. Entity consistency
 * is checked exactly once per round (Step 1's initial + Step 2's per-round)
 * and not separately at the end.
 *
 * @param {Array<Object>} rawImages - Array from Phase 5a, each with imageData, prompt, characterPhotos, etc.
 * @param {Object} context
 * @param {Array} context.characters - Character array
 * @param {Object} context.modelOverrides - Model overrides
 * @param {Function} context.usageTracker - (provider, usage, funcName, modelId) => void
 * @param {Object} context.visualBible - Visual bible object
 * @param {string} context.artStyle - Art style string
 * @param {string} context.jobId - Job ID for progress updates
 * @param {Object} context.dbPool - Database pool for progress updates
 * @param {Object} context.storyData - Full story data (needed for iteratePage mode)
 * @param {Object} [options]
 * @param {number} [options.regenThreshold=REPAIR_DEFAULTS.scoreThreshold] - Score below which to regenerate
 * @param {number} [options.maxRegenAttempts=REPAIR_DEFAULTS.maxPasses] - Max repair rounds
 * @param {number} [options.evalConcurrency=100] - Concurrency for evaluations
 * @param {string} [options.qualityModelOverride] - Model override for quality evaluation
 * @param {boolean} [options.useIteratePage=false] - Use iteratePage (re-expansion) instead of generateImageOnly
 * @param {number} [options.inpaintMaxPasses=1] - Inpaint attempts per page per round
 * @returns {Promise<{results: Array<Object>, charFixDetails: Object}>}
 */

/**
 * Resolve a character's face/body bbox for char-fix targeting AND for building
 * the protection list of OTHER characters on the same page.
 *
 * Single source-of-truth lookup so target and protection always agree:
 *   1. entityReport.characters[name].byClothing[*].appearances[pageNumber]
 *      — same upstream as bbox detection, but face boxes are cascade-improved
 *      (anime + Haar) when cascade ran. Prefer this over raw figures.
 *   2. bestEval.bboxDetection.figures[name] — canonical bbox detection result
 *      cached at img.sharedBboxDetection.
 *   3. bestEval.matches[name].face_bbox — quality eval's independent face
 *      detection (no bodyBox available here).
 *
 * Skips UNKNOWN figures. Case-insensitive name match. Normalises to
 * [y0, x0, y1, x1].
 *
 * @param {string} charName
 * @param {Object} sources
 * @param {Object} [sources.bestEval]
 * @param {Object} [sources.entityReport]
 * @param {number} sources.pageNumber
 * @returns {{ faceBbox: Array|null, bodyBbox: Array|null, source: string|null }}
 */


// ============================================================================
// CATEGORIZED REPAIR FUNCTIONS
// Different repair methods for different issue types
// ============================================================================

/**
 * Core iterate function — shared by the pipeline (executeIterateAction) and the
 * UI route (POST /:id/iterate/:pageNum).  Analyzes the current image, re-expands
 * the scene description with Claude's 17-check prompt, then regenerates.
 *
 * @param {string} imageData - Current image data (base64)
 * @param {number} pageNumber - Page number being iterated
 * @param {Object} storyData - Full story data object
 * @param {Object} options
 * @param {Object}   options.modelOverrides       - { imageModel, sceneIterationModel, imageBackend }
 * @param {Function} options.usageTracker          - Usage tracking callback
 * @param {boolean}  options.useOriginalAsReference - Send current image as reference to generator
 * @param {Object}   options.evaluationFeedback    - { score, reasoning, fixableIssues }
 * @param {string}   options.sceneBackground       - Empty scene plate (base64) for composite
 * @param {boolean}  options.iterativePlacement    - Use two-pass iterative placement
 * @param {boolean}  options.blackoutIssues        - Black out fixTargets on input image
 * @param {Array}    options.fixTargets            - Fix target bboxes (required when blackoutIssues=true)
 * @param {boolean}  options.previewOnly           - Return prompt + mismatches without generating
 * @param {string}   options.customImagePrompt     - Override the built image prompt
 * @param {Object}   options.emptySceneCallbacks   - { load, save } for DB-backed empty scene handling
 *   load(pageNumber): Promise<string|null>  — load existing empty scene from DB
 *   save(pageNumber, imageData): Promise<void> — save generated empty scene to DB
 *   When omitted, empty scene is only used if sceneBackground is pre-supplied.
 * @returns {Promise<Object>} result object (see end of function)
 */
async function iteratePageCore(imageData, pageNumber, storyData, options = {}) {
  const {
    modelOverrides = {},
    usageTracker = null,
    useOriginalAsReference = false,
    evaluationFeedback = null,
    sceneBackground: sceneBackgroundIn = null,
    iterativePlacement = false,
    blackoutIssues = false,
    fixTargets: optionFixTargets = null,
    previewOnly = false,
    customImagePrompt = null,
    emptySceneCallbacks = null,
    // Per-scene aspect override — caller (regeneration route or repair pipeline)
    // passes the scene's saved imageAspect so the regenerated image matches the
    // shape the layout expects. null/undefined falls back to the global default.
    aspectRatio: aspectRatioIn = null,
    // freeIterate: opt into the looser scene-iteration-free.txt template.
    // Default (false) keeps the cast locked to the original scene and uses the
    // strict template (outline authoritative). When true, iterate may drop/swap
    // characters and reframe the scene to escape an impossible composition.
    freeIterate = false,
    // Reference mode + single-pass flag — see applyReferenceMode in storyHelpers.
    // null/undefined = inherit MODEL_DEFAULTS; otherwise one of strict|loose|styled-only|off.
    referenceMode = null,
    singlePassScene = null,
    // Phase 7: cell-crop refs from story-scoped 2×4 sheet (default on).
    // Each character's full-image styled-avatar reference is replaced with a
    // single body cell cropped out of story.data.characterAvatars[name][slot]
    // at the scene-expansion-prescribed pose. Falls through silently when
    // the story has no sheet for the character yet (legacy stories pre-Phase-1).
    useStorySheetCells = true,
    // Pipeline callers (executeIterateAction) score round results themselves
    // (round detect + batch eval) — they pass skipEval so pages are evaluated
    // exactly once per version. External callers (regen/iterate routes) keep
    // the scored contract: eval + detection run here.
    skipEval = false,
  } = options;
  const effectiveReferenceMode = referenceMode || CONFIG_DEFAULTS.referenceMode || 'strict';
  // Explicit boolean from caller wins over the run-level default.
  const effectiveSinglePass = typeof singlePassScene === 'boolean'
    ? singlePassScene
    : CONFIG_DEFAULTS.singlePassScene === true;
  const sceneAspect = aspectRatioIn || CONFIG_DEFAULTS.pageAspect;

  const {
    analyzeGeneratedImage
  } = require('./sceneValidator');

  const {
    getPageText,
    buildSceneDescriptionPrompt,
    buildImagePrompt,
    getCharactersInScene,
    getCharacterPhotoDetails,
    buildAvailableAvatarsForPrompt,
    extractSceneMetadata,
    parseProseMetadataFormat,
    parseClothingCategory,
    getLandmarkPhotosForScene,
    convertClothingToCurrentFormat,
    buildSceneClothingRequirements
  } = getStoryHelpers();

  const { callClaudeAPI } = require('./textModels');
  const { getElementReferenceImagesForPage } = require('./visualBible');
  const { applyStyledAvatars } = require('./styledAvatars');

  // Extract story context
  const characters = storyData.characters || [];
  const language = storyData.language || 'en';
  const visualBible = storyData.visualBible || null;
  const clothingRequirements = storyData.clothingRequirements || null;
  const pageClothingData = storyData.pageClothing || null;
  const sceneDescriptions = storyData.sceneDescriptions || [];
  const artStyle = storyData.artStyle || 'pixar';

  // Get page text
  const fullStoryText = storyData.storyText || storyData.story || '';
  const pageText = getPageText(fullStoryText, pageNumber);
  if (!pageText) {
    throw new Error(`Page ${pageNumber} text not found`);
  }

  // Get current scene description
  const currentScene = sceneDescriptions.find(s => s.pageNumber === pageNumber);
  if (!currentScene) {
    throw new Error(`No scene description found for page ${pageNumber}`);
  }

  // The page's textPosition is locked at first generation — iterate must NOT
  // re-pick it (would break the spread rule and shift the calm zone). Pull the
  // saved value from sceneImages so buildImagePrompt and the empty-scene
  // re-gen can both inject the same COPY SPACE instruction the original had.
  const savedScene = (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber) || {};
  const lockedTextPosition = savedScene.textPosition || null;

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Analyzing current image with vision model...`);

  // Step 1: Analyze the current image using analyzeGeneratedImage (composition analysis)
  // The analysis is told what each character is WEARING, and that text flows
  // into the scene rewrite as previewFeedback.composition. It must therefore
  // carry THIS PAGE's outfit: formatCharacterContext reads `_currentClothing`,
  // which only the per-page view of clothingRequirements carries. Passing the
  // story-level blob resolved every character to 'standard' → the unused
  // standard category has no description → buildClothingDescription fell
  // through to the character-level avatars.clothing.standard, and the rewrite
  // dressed a summer story in the stored winter/standard wardrobe (observed on
  // staging job_1786053708336_8cdsca519 p10: Noah's sky-blue polo became a
  // "dark green T-Rex hoodie, dark grey sweatpants" — his avatars standard
  // entry verbatim). Same reason only the page's cast is passed: an absent
  // character's outfit is noise the vision model can attach to a figure.
  const pageCharClothing = savedScene.perCharClothing
    || pageClothingData?.pageClothing?.[pageNumber]
    || null;
  // NO CAST FALLBACK (owner, 2026-08-08). The old code fell back to the whole
  // story roster when the page's cast was unknown. That is the same class of
  // guess as defaulting the clothing category, and it cost more: the roster
  // includes characters who are not in the picture, so the analysis described
  // absent people to the vision model AND the no-default clothing guard threw
  // on them (they legitimately have no per-page outfit), killing the repair for
  // every page of job_1786147254924_8nuyywjii. If we do not know who is on the
  // page, we do not guess — we fail here.
  const analysisCharacters = (() => {
    const names = (savedScene.sceneCharacters || []).map(c => String(c?.name || '').trim().toLowerCase()).filter(Boolean);
    if (names.length === 0) {
      // An EMPTY cast and an UNKNOWN cast are different states. A landscape page
      // legitimately has nobody in it; a page whose prose names people the roster
      // could not resolve is a failure we must not paper over. The scene metadata
      // decides which one this is.
      const metaNames = (() => {
        try {
          const m = extractSceneMetadata(currentScene.description || currentScene.sceneDescription || '');
          const cs = m?.characters;
          return Array.isArray(cs) ? cs.map(c => String(c?.name || c || '').trim()).filter(Boolean) : [];
        } catch { return []; }
      })();
      if (metaNames.length === 0) {
        log.info(`🔄 [ITERATE] Page ${pageNumber}: scene has no characters — analysis runs without a cast`);
        return [];
      }
      // SECONDARY CHARACTERS are a third, legitimate state. They live in the
      // Visual Bible, not the roster: no photo, no avatar, no identity to check,
      // rendered from their VB description alone. getCharactersInScene matches
      // the ROSTER only, so a page whose cast is entirely secondary yields an
      // empty sceneCharacters — that is correct, not unknown. Only a name that
      // is in neither place means we genuinely do not know who is in the picture.
      const secondaryNames = new Set(
        ((visualBible?.secondaryCharacters) || [])
          .map(sc => String(sc?.name || '').trim().toLowerCase())
          .filter(Boolean)
      );
      const unknown = metaNames.filter(n => !secondaryNames.has(n.trim().toLowerCase()));
      if (unknown.length === 0) {
        log.info(`🔄 [ITERATE] Page ${pageNumber}: cast is entirely secondary characters (${metaNames.join(', ')}) — no roster identities to analyse`);
        return [];
      }
      throw new Error(`[ITERATE] Page ${pageNumber}: the scene names ${unknown.join(', ')}, who are in neither the story roster (${characters.map(c => c.name).join(', ')}) nor the Visual Bible's secondary characters. Refusing to fall back to the whole roster.`);
    }
    const matched = characters.filter(c => names.includes(String(c.name || '').trim().toLowerCase()));
    if (matched.length === 0) {
      throw new Error(`[ITERATE] Page ${pageNumber}: none of the page's characters (${names.join(', ')}) match the story roster (${characters.map(c => c.name).join(', ')}). Refusing to fall back to the whole roster.`);
    }
    if (matched.length !== names.length) {
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: ${matched.length}/${names.length} scene characters matched the story roster`);
    }
    return matched;
  })();
  // buildSceneClothingRequirements itself throws when a cast member has no
  // per-page category — no second check here, one rule in one place.
  const analysisClothingRequirements = buildSceneClothingRequirements(
    analysisCharacters, pageCharClothing, clothingRequirements
  );
  const imageDescription = await analyzeGeneratedImage(imageData, analysisCharacters, visualBible, analysisClothingRequirements);
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Composition analysis complete (${imageDescription.description.length} chars)`);

  // Step 2: Build previewFeedback from the image analysis.
  // Eval bullets from the previous round (if any) are routed here too so
  // Claude integrates them into the corrected scene — they must NOT go to
  // the image API, which can't reason about evaluator feedback.
  const previewFeedback = {
    composition: imageDescription.description,
    fixIssues: (() => {
      if (!evaluationFeedback) return [];
      const src = evaluationFeedback.fixableIssues || [];
      const issues = src.slice(0, 10).map(i => i?.description || i?.issue || String(i));
      // Consolidator-declared spec conflicts lead the list: the rewrite's
      // primary job is resolving them (change the interactions), not
      // re-transcribing the conflicting requirements from the story text.
      const conflicts = evaluationFeedback.consolidatedPlan?.spec_conflicts;
      if (Array.isArray(conflicts) && conflicts.length > 0) {
        issues.unshift(...conflicts.map(c =>
          `SPEC CONFLICT — rewrite the interactions to resolve: "${c.a}" vs "${c.b}"${c.why ? ` (${c.why})` : ''}`));
      }
      return issues;
    })(),
    previousScore: evaluationFeedback?.score ?? null,
  };

  // Build previous scenes context
  const previousScenes = [];
  for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
    if (prevPage >= 1) {
      const prevText = getPageText(fullStoryText, prevPage);
      if (prevText) {
        let prevClothing = pageClothingData?.pageClothing?.[prevPage] || null;
        if (!prevClothing) {
          const prevSceneDesc = sceneDescriptions.find(s => s.pageNumber === prevPage);
          prevClothing = prevSceneDesc ? parseClothingCategory(prevSceneDesc.description) : null;
        }
        previousScenes.push({
          pageNumber: prevPage,
          text: prevText,
          sceneHint: '',
          clothing: prevClothing
        });
      }
    }
  }

  // Get expected clothing for this page. NO DEFAULT (owner, 2026-08-07): this
  // value becomes the rewrite prompt's "This page's clothing" line, so a
  // guessed 'standard' actively instructs the rewriter to dress the page in a
  // category the story may not use.
  const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing;
  if (!expectedClothing) {
    throw new Error(`[ITERATE] Page ${pageNumber}: no per-page clothing and no primaryClothing on the story. Refusing to tell the rewriter 'standard'.`);
  }

  // Build available avatars
  const availableAvatars = buildAvailableAvatarsForPrompt(characters, clothingRequirements);

  // Extract short scene description from current scene
  // Handle both field names: 'description' (saved stories) and 'sceneDescription' (pipeline)
  const sceneDescText = currentScene.description || currentScene.sceneDescription || '';
  let shortSceneDesc = '';
  const sceneMetadata = extractSceneMetadata(sceneDescText);
  if (sceneMetadata?.imageSummary) {
    shortSceneDesc = sceneMetadata.imageSummary;
  } else {
    shortSceneDesc = sceneDescText.substring(0, 500);
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Building scene description prompt with preview feedback (mode=${freeIterate ? 'free' : 'strict'})...`);

  // Strict mode: lock cast to the original scene's characters so iterate can't
  // drop/swap them. Free mode: pass the full roster so iterate can reframe.
  let promptCharacters = characters;
  if (!freeIterate) {
    const originalSceneCharNames = (() => {
      try {
        const meta = sceneMetadata?.characters;
        if (Array.isArray(meta) && meta.length > 0) {
          return meta.map(c => String(c?.name || '').trim().toLowerCase()).filter(Boolean);
        }
      } catch { /* fall through */ }
      return null;
    })();
    const lockedCast = originalSceneCharNames
      ? characters.filter(c => originalSceneCharNames.includes(String(c.name || '').trim().toLowerCase()))
      : characters;
    if (originalSceneCharNames && lockedCast.length !== originalSceneCharNames.length) {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: Locked cast resolved ${lockedCast.length}/${originalSceneCharNames.length} from original scene metadata`);
    } else if (originalSceneCharNames) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Locked cast to original scene (${lockedCast.length} chars: ${lockedCast.map(c => c.name).join(', ')})`);
    }
    promptCharacters = lockedCast;
  }

  // Step 3: Build the scene description prompt with preview feedback
  // Per-scene textInImage gates the overlay-only rules in scene-iteration.txt
  // / scene-iteration-free.txt. Pulled from storyData.sceneImages (preserved
  // by the unified pipeline at server.js:5980), falling back to story-level
  // layout. Defaults false so non-overlay stories never carry calm-zone
  // instructions through iterate.
  const iterateTextInImage = (
    storyData?.sceneImages?.find(s => s.pageNumber === pageNumber)?.textInImage
    ?? storyData?.layout?.textInImage
    ?? false
  ) === true;
  const scenePrompt = buildSceneDescriptionPrompt(
    pageNumber,
    pageText,
    promptCharacters,
    shortSceneDesc,
    language,
    visualBible,
    previousScenes,
    expectedClothing,
    '',  // No correction notes for iteration
    availableAvatars,
    null,  // rawOutlineContext
    previewFeedback,  // The actual image analysis feedback!
    // clothingRequirements so the EXPECTED_CLOTHING block can state each
    // character's actual outfit TEXT. Without it the Art Director only sees the
    // category key and writes it into the prose ("wearing her standard clothes"),
    // which the evaluator then judges the render against.
    { freeIterate, textInImage: iterateTextInImage, extraRule: options.sceneExtraRule || null, clothingRequirements }
  );

  // Step 4: Call Claude to run 18 checks and generate corrected scene (uses iteration model).
  // Output is prose paragraph + ---METADATA--- + JSON block (same shape as initial expansion,
  // plus the iterate-specific `previewMismatches`, `checks`, `issues`, `corrections`,
  // `draftValidation` fields inside the metadata JSON). No JSON prefill — the response starts
  // with the prose directly.
  // Default (CONFIG_DEFAULTS.sceneIteration = qwen-plus) is key-guarded to
  // sonnet when OPENROUTER_API_KEY is unset; explicit overrides pass through.
  const effectiveSceneModel = modelOverrides?.sceneIterationModel || modelOverrides?.sceneModel || require('../config/models').resolveSceneIterationModel();
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Running 18 validation checks with ${effectiveSceneModel}...`);
  let sceneResult = await callClaudeAPI(scenePrompt, null, effectiveSceneModel, { usageLabel: 'scene_iterate' });
  let newSceneDescription = sceneResult.text;

  // Track usage (Claude Haiku scene re-expansion)
  if (usageTracker && sceneResult.usage) {
    usageTracker('anthropic', sceneResult.usage, 'scene_iterate', sceneResult.modelId || effectiveSceneModel);
  }

  // ENFORCE the sceneIntent contract. The template requires it (it becomes
  // the image prompt's THIS IMAGE DEPICTS overview) but the model
  // occasionally omits it and the prompt then shipped WITHOUT its overview
  // (observed: an iterate-round version rendered from a header-less prompt).
  // One retry; still missing → loud error, never a silent header-less send.
  if (!extractSceneMetadata(newSceneDescription)?.sceneIntent) {
    log.warn(`⚠️ [ITERATE] Page ${pageNumber}: scene iteration omitted sceneIntent — retrying once`);
    const retry = await callClaudeAPI(
      `${scenePrompt}\n\nYour previous answer omitted the required "sceneIntent" field in the metadata JSON. It is mandatory — include it.`,
      null, effectiveSceneModel, { usageLabel: 'scene_iterate_retry' }
    );
    if (usageTracker && retry.usage) {
      usageTracker('anthropic', retry.usage, 'scene_iterate', retry.modelId || effectiveSceneModel);
    }
    if (extractSceneMetadata(retry.text)?.sceneIntent) {
      sceneResult = retry;
      newSceneDescription = retry.text;
    } else {
      log.error(`❌ [ITERATE] Page ${pageNumber}: sceneIntent still missing after retry — the image prompt will lack its overview line`);
    }
  }

  // Extract previewMismatches + checks from the metadata JSON block. parseProseMetadataFormat
  // splits on ---METADATA--- and parses the JSON — the fields live alongside scene structure.
  let previewMismatches = [];
  let checksRun = {};
  try {
    const parsed = parseProseMetadataFormat(newSceneDescription);
    if (parsed?.metadata) {
      previewMismatches = parsed.metadata.previewMismatches || [];
      checksRun = parsed.metadata.checks || parsed.metadata.selfCritique || {};
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Found ${previewMismatches.length} mismatches: ${JSON.stringify(previewMismatches)}`);
    } else {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: Could not parse prose+metadata format — mismatches/checks unavailable`);
    }
  } catch (parseErr) {
    log.warn(`🔄 [ITERATE] Could not extract mismatches from prose+metadata: ${parseErr.message}`);
  }

  // Step 5: Prepare for image generation
  const sceneCharacters = getCharactersInScene(newSceneDescription, characters);

  // Extract metadata from the new scene description for per-character clothing
  let newSceneMetadata = extractSceneMetadata(newSceneDescription);

  // ANCHORED OBJECT ALLOW-LIST (user decision 2026-07-18): the rewrite may
  // keep/drop objects freely and may ADD an object only when something asked
  // for it — the original scene metadata, the eval feedback (e.g. "rowing
  // boat missing"), or the page text. Unanchored additions are scrubbed
  // (observed: a rewrite swapped the scene's vehicle for an unrelated statue
  // and the model painted it into the scene). Matching is tolerant across
  // the language boundary: entity id, entity name, or ≥5-char words from the
  // name/English VB description against feedback + page text.
  const rewriteObjects = Array.isArray(newSceneMetadata?.objects) ? newSceneMetadata.objects : [];
  const origObjects = (savedScene.sceneMetadata?.objects || savedScene.sceneMetadata?.fullData?.objects || []);
  if (rewriteObjects.length > 0) {
    const baseId = (o) => String(o).trim().toUpperCase().split('.')[0];
    const origSet = new Set(origObjects.map(baseId));
    const haystack = `${JSON.stringify(evaluationFeedback || {})}\n${pageText || ''}`.toLowerCase();
    const vbEntityById = new Map();
    for (const pool of [visualBible?.artifacts, visualBible?.animals, visualBible?.vehicles, visualBible?.locations, visualBible?.secondaryCharacters]) {
      for (const e of (pool || [])) if (e?.id) vbEntityById.set(baseId(e.id), e);
    }
    const isAnchored = (obj) => {
      const id = baseId(obj);
      if (origSet.has(id)) return true;
      if (haystack.includes(id.toLowerCase())) return true;
      const ent = vbEntityById.get(id);
      if (!ent) return true; // not a VB id — plain names pass through
      const tokens = [String(ent.name || ''), ...String(ent.name || '').split(/\s|-/), ...String(ent.description || '').split(/[^A-Za-zÀ-ž]+/)]
        .map(t => t.trim().toLowerCase()).filter(t => t.length >= 5);
      return tokens.some(t => haystack.includes(t));
    };
    const scrubbed = rewriteObjects.filter(o => !isAnchored(o));
    if (scrubbed.length > 0) {
      const kept = rewriteObjects.filter(o => !scrubbed.includes(o));
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: rewrite added unanchored VB object(s) ${JSON.stringify(scrubbed)} — scrubbed (not in original metadata, feedback, or page text)`);
      const objRe = /"objects"\s*:\s*\[[^\]]*\]/;
      if (objRe.test(newSceneDescription)) {
        newSceneDescription = newSceneDescription.replace(objRe, `"objects": ${JSON.stringify(kept)}`);
        newSceneMetadata = extractSceneMetadata(newSceneDescription);
      }
    }
  }

// Resolve clothing. The stored pageClothing was set by the unified Sonnet
  // call at generation time and reflects the canonical per-page costume
  // decision — if it says costumed:mittelalterlich for this page, the Haiku
  // iterate call must not downgrade it to standard. So: when the stored
  // pageClothing has any costumed entry, it wins. Otherwise fall back to
  // Claude's iterate output (for pages that legitimately change clothing
  // mid-story).
  let clothingCategory;
  let effectiveClothingRequirements = clothingRequirements;

  const storedPageClothing = pageClothingData?.pageClothing?.[pageNumber];
  // Normalize string form ("costumed:mittelalterlich" applied page-wide) into per-character
  // map so the override below catches both string and object input shapes.
  const storedPageClothingMap = (() => {
    if (!storedPageClothing) return null;
    if (typeof storedPageClothing === 'object') return storedPageClothing;
    if (typeof storedPageClothing === 'string') {
      return Object.fromEntries(sceneCharacters.map(c => [c.name, storedPageClothing]));
    }
    return null;
  })();
  const storedHasCostumed = storedPageClothingMap
    ? Object.values(storedPageClothingMap).some(v => typeof v === 'string' && v.startsWith('costumed'))
    : false;

  if (storedHasCostumed && storedPageClothingMap) {
    const perPageClothing = convertClothingToCurrentFormat(storedPageClothingMap);
    effectiveClothingRequirements = { ...clothingRequirements };
    for (const [charName, charClothing] of Object.entries(perPageClothing)) {
      effectiveClothingRequirements[charName] = {
        ...effectiveClothingRequirements[charName],
        ...charClothing
      };
    }
    const clothingValues = Object.values(storedPageClothingMap);
    const firstClothing = clothingValues[0];
    if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
    const iterateCh = newSceneMetadata?.characterClothing || null;
    if (iterateCh && Object.values(iterateCh).some(v => !String(v).startsWith('costumed'))) {
      log.warn(`⚠️ [ITERATE] Page ${pageNumber}: Haiku tried to downgrade clothing to ${JSON.stringify(iterateCh)} — overriding with stored pageClothing ${JSON.stringify(storedPageClothing)}`);
    } else {
      log.debug(`🔄 [ITERATE] Using stored pageClothing (authoritative costumed): ${JSON.stringify(storedPageClothing)}`);
    }
  } else if (newSceneMetadata?.characterClothing && Object.keys(newSceneMetadata.characterClothing).length > 0) {
    // Priority 1: Per-character clothing from newly generated scene description
    const sceneClothing = newSceneMetadata.characterClothing;
    const perCharClothing = convertClothingToCurrentFormat(sceneClothing);
    effectiveClothingRequirements = { ...clothingRequirements };
    for (const [charName, charClothing] of Object.entries(perCharClothing)) {
      effectiveClothingRequirements[charName] = {
        ...effectiveClothingRequirements[charName],
        ...charClothing
      };
    }
    const clothingValues = Object.values(sceneClothing);
    const firstClothing = clothingValues[0];
    if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
    log.debug(`🔄 [ITERATE] Using per-character clothing from scene description: ${JSON.stringify(sceneClothing)}`);
  } else {
    // Priority 2: Per-character clothing from pageClothing (stored data)
    const pageClothingEntry = storedPageClothing;
    if (typeof pageClothingEntry === 'string') {
      clothingCategory = pageClothingEntry;
    } else if (pageClothingEntry && typeof pageClothingEntry === 'object') {
      const perPageClothing = convertClothingToCurrentFormat(pageClothingEntry);
      effectiveClothingRequirements = { ...clothingRequirements };
      for (const [charName, charClothing] of Object.entries(perPageClothing)) {
        effectiveClothingRequirements[charName] = {
          ...effectiveClothingRequirements[charName],
          ...charClothing
        };
      }
      const clothingValues = Object.values(pageClothingEntry);
      const firstClothing = clothingValues[0];
      if (!firstClothing) {
      // NO DEFAULT (owner, 2026-08-07): an empty clothing map means nothing
      // on this page says what anyone wears; 'standard' would resolve to a
      // wardrobe from an unrelated story.
      throw new Error(`[ITERATE] Page ${pageNumber}: clothing map is empty. Refusing to default to 'standard'.`);
    }
    clothingCategory = firstClothing;
      log.debug(`🔄 [ITERATE] Using per-character clothing from pageClothing: ${JSON.stringify(pageClothingEntry)}`);
    } else {
      // NO DEFAULT CLOTHING (owner, 2026-08-07). Reaching here means the page
      // has no stored clothing, the rewrite named none, and the story has no
      // primary category — there is nothing to dress this page from except a
      // guess, and a guessed category resolves to the character-level avatars
      // wardrobe, i.e. an outfit from an unrelated story.
      clothingCategory = parseClothingCategory(newSceneDescription) || pageClothingData?.primaryClothing;
      if (!clothingCategory) {
        throw new Error(`[ITERATE] Page ${pageNumber}: no clothing category from pageClothing, the rewrite, or the story's primaryClothing. Refusing to fall back to 'standard'.`);
      }
    }
  }

  let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, artStyle, effectiveClothingRequirements);

  // Apply styled avatars (skip when all already styled or costumed)
  const allAlreadyStyled = referencePhotos.every(p =>
    p.photoType?.startsWith('styled-') || p.photoType?.startsWith('costumed-')
  );
  if (!allAlreadyStyled && (!clothingCategory || !clothingCategory.startsWith('costumed'))) {
    referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
  }

  // Phase 3b: optionally replace each character's full-image styled-avatar
  // reference with a single body cell cropped out of the story-scoped 2×4
  // sheet at story.data.characterAvatars[name][slotKey]. Pose comes from
  // scene-expansion metadata so the cell matches the figure's intended
  // facing direction on this page. Skips characters with no story sheet.
  if (useStorySheetCells && storyData?.characterAvatars) {
    const { cropAvatarCell } = require('./sceneComposite');
    const metaChars = newSceneMetadata?.fullData?.characters
      || newSceneMetadata?.characters
      || sceneCharacters
      || [];
    // Pose + depth resolution is shared with applyStoryCellRefs — beats
    // metadata carries `perspective` prose, not `pose`, and the inline copy
    // here served threeQuarter to every declared back-view figure.
    const { resolveCellPose, resolveSheetForRef } = require('./storyAvatars');
    const poseByName = new Map();
    for (const sc of metaChars) {
      const nm = (typeof sc === 'string' ? sc : sc?.name) || '';
      if (!nm) continue;
      poseByName.set(nm.toLowerCase(), resolveCellPose(sc));
    }
    for (const ref of referencePhotos) {
      const charName = ref.name;
      if (!charName) continue;
      const story = storyData.characterAvatars[charName];
      if (!story) continue;
      // Shared resolver: slot mapping, the loud costumed fallback (which also
      // corrects ref.clothingCategory) lives in storyAvatars.js. The inline
      // copy here fell back silently.
      const resolved = resolveSheetForRef(story, ref);
      if (!resolved) continue;
      const { uri: sheetUri, slotKey } = resolved;
      const pf = poseByName.get(charName.toLowerCase()) || { pose: 'threeQuarter', depth: 'foreground' };
      const includeFace = pf.depth === 'foreground';
      try {
        const { body, stacked } = await cropAvatarCell(sheetUri, { pose: pf.pose, includeFace, stack: includeFace });
        const buf = stacked || body;
        ref.photoUrl = `data:image/png;base64,${buf.toString('base64')}`;
        ref.photoType = `cell-${pf.pose}${includeFace ? '-headbody' : ''}`;
        ref.cellPose = pf.pose;
        ref.cellDepth = pf.depth;
        ref.cellIncludesFace = includeFace;
        log.debug(`[CELL REFS] ${charName}: cropped ${pf.pose}${includeFace ? ' + head' : ''} (depth=${pf.depth}) from ${slotKey}`);
      } catch (err) {
        log.warn(`[CELL REFS] crop failed for ${charName}: ${err.message} — falling back to existing ref`);
      }
    }
  }

  // Build landmark photos
  const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, newSceneMetadata) : [];

  // Determine image model and backend (needed before empty scene generation)
  let imageModelOverride = modelOverrides?.imageModel || null;
  // The rewrite's metadata is the working copy, but scene-iteration.txt does
  // not emit `era` or `textZoneDescription` — context fields iterate has no
  // business re-deciding. Read them from the rewrite when present, else from
  // the saved scene, or the anachronism guard and text-zone hint go dark on
  // every repaired page (same disease 6738d7dca fixed for beats pages).
  const savedMeta = savedScene?.sceneMetadata || {};
  const iterateSceneMetadata = {
    ...newSceneMetadata,
    era: newSceneMetadata?.era || savedMeta.era || savedMeta.fullData?.era || null,
    textZoneDescription: newSceneMetadata?.textZoneDescription || savedMeta.textZoneDescription || null,
  };

  // Route by scene complexity when no explicit model override
  if (!imageModelOverride) {
    const sceneComplexity = iterateSceneMetadata?.sceneComplexity || 'simple';
    if (sceneComplexity === 'complex') {
      imageModelOverride = CONFIG_DEFAULTS.complexPageImage;
      log.info(`🎯 [ITERATE] Page ${pageNumber}: complex scene → ${imageModelOverride}`);
    }
  }

  const iterateImageBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;

  // Resolve empty scene background.
  // If sceneBackgroundIn was pre-supplied (pipeline), use it directly.
  // If emptySceneCallbacks are provided (UI route), load/generate based on scene metadata.
  // singlePassScene flag forces a one-pass render with no plate.
  let sceneBackground = sceneBackgroundIn;
  if (effectiveSinglePass) {
    sceneBackground = null;
    log.info(`🎛️ [ITERATE] Page ${pageNumber}: singlePassScene=true — skipping empty-scene plate`);
  } else if (!sceneBackground && emptySceneCallbacks) {
    if (iterateSceneMetadata?.reuseEmptyScene) {
      try {
        const existing = await emptySceneCallbacks.load(pageNumber);
        if (existing) {
          sceneBackground = existing;
          log.info(`🎬 [ITERATE] Page ${pageNumber}: reusing empty scene as style anchor`);
        }
      } catch (e) {
        log.debug(`[ITERATE] No empty scene for page ${pageNumber}: ${e.message}`);
      }
    } else if (iterateSceneMetadata?.reuseEmptyScene === false && iterateSceneMetadata?.emptyScenePrompt) {
      log.info(`🎬 [ITERATE] Page ${pageNumber}: generating fresh empty scene (setting changed)`);
      try {
        const { resolveArtStyleForEmptyScene, resolveArtStyle: resolveStyleForEmpty } = getStoryHelpers();
        const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
        const artStyleDesc = resolveArtStyleForEmptyScene(storyData.artStyle || 'pixar', iterBackend)
          || resolveArtStyleForEmptyScene('pixar')
          || resolveStyleForEmpty(storyData.artStyle || 'pixar', iterBackend)
          || '';
        const textPos = lockedTextPosition || iterateSceneMetadata?.textPosition || null;
        const { buildTextZoneInstruction, buildEraGuard } = getStoryHelpers();
        const iterateTextZoneDesc = iterateSceneMetadata?.textZoneDescription || null;
        const iterateEra = iterateSceneMetadata?.era || null;
        // Named landmark-fidelity block when this page attaches a landmark
        // photo (pageLandmarkPhotos below) — '' otherwise. Shared builder
        // in storyHelpers; used to be built only on the TRIAL empty-scene
        // path while every other caller shipped the generic unnamed block.
        const { buildEmptyScenePrompt } = require('../services/prompts');
        const { buildLandmarkFidelityBlock } = getStoryHelpers();
        const emptyPrompt = buildEmptyScenePrompt({
          style: artStyleDesc,
          description: iterateSceneMetadata.emptyScenePrompt,
          textAreaInstruction: textPos ? buildTextZoneInstruction(textPos, iterateTextZoneDesc, (storyData?.languageLevel === '1st-grade' ? '10%' : storyData?.languageLevel === 'advanced' ? '40%' : '30%'), { isEmptyScene: true }) : '',
          eraGuard: buildEraGuard(iterateEra),
          landmarkFidelity: buildLandmarkFidelityBlock(pageLandmarkPhotos?.[0]),
        });
        const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, pageNumber, pageLandmarkPhotos);
        const isCoverPage = pageNumber < 0;
        const emptyResult = await generateImageOnly(emptyPrompt, [], {
          imageModelOverride,
          imageBackendOverride: iterBackend,
          landmarkPhotos: pageLandmarkPhotos,
          visualBibleGrid: emptySceneVbGrid,
          pageNumber,
          skipCache: true,
          aspectRatio: isCoverPage ? CONFIG_DEFAULTS.coverAspect : sceneAspect
        });
        if (emptyResult?.imageData) {
          sceneBackground = emptyResult.imageData;
          if (emptySceneCallbacks.save) {
            await emptySceneCallbacks.save(pageNumber, sceneBackground);
          }
          log.info(`🎬 [ITERATE] Page ${pageNumber}: fresh empty scene generated and saved`);
        }
      } catch (e) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: fresh empty scene failed: ${e.message}`);
      }
    }
  }

  // Build VB grid — when sceneBackground is set, vehicles/locations/landmarks are already
  // painted into the empty scene plate, so drop them from the composite refs.
  const pageRefs = visualBible
    ? await buildPageCompositeRefs(visualBible, pageNumber, pageLandmarkPhotos, {
        hasBackground: !!sceneBackground,
        hasOtherRefs: !!useOriginalAsReference,
        logTag: 'ITERATE',
      })
    : { visualBibleGrid: null, landmarkPhotos: pageLandmarkPhotos };
  const visualBibleGrid = pageRefs.visualBibleGrid;
  const finalLandmarkPhotos = pageRefs.landmarkPhotos;

  // The iterate output is prose + ---METADATA--- + JSON (same shape as initial
  // expansion). buildImagePrompt's prose branch strips the metadata block and
  // uses only the prose for the image prompt — no JSON-scene extraction needed.
  let imagePrompt = buildImagePrompt(newSceneDescription, storyData, sceneCharacters, visualBible, pageNumber, referencePhotos, { imageBackend: iterateImageBackend, textPositionOverride: lockedTextPosition });

  // Eval feedback was already routed to Claude via previewFeedback.fixIssues
  // (see Step 2 above). The image API gets a prose-only prompt — it cannot
  // reason about evaluator bullets, and stacking them on the prose led to
  // cherry-picking and prompt-leak text artifacts.
  if (evaluationFeedback?.fixableIssues?.length > 0) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: ${evaluationFeedback.fixableIssues.length} eval bullets routed to scene re-expansion (score: ${evaluationFeedback.score ?? 'N/A'})`);
  }

  // Preview mode: return prompt + mismatches without generating image
  if (previewOnly) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Preview mode — returning prompt only (${imagePrompt.length} chars)`);
    return {
      previewOnly: true,
      imagePrompt,
      newScene: newSceneDescription,
      newSceneMetadata,
      compositionAnalysis: previewFeedback.composition,
      previewMismatches,
      checksRun,
      method: 'iterate'
    };
  }

  // Allow custom image prompt override (from preview → edit → generate flow)
  if (customImagePrompt) {
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Using custom image prompt (${customImagePrompt.length} chars, was ${imagePrompt.length})`);
    imagePrompt = customImagePrompt;
  }

  // Clear cache to force new generation
  const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
  deleteFromImageCache(cacheKey);

  // Resolve previousImage based on blackout / useOriginalAsReference
  let previousImage = null;
  if (blackoutIssues) {
    const targets = optionFixTargets || [];
    if (targets.length > 0) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Blacking out ${targets.length} issue regions in current image`);
      previousImage = await blackoutIssueRegions(imageData, targets);
    } else {
      log.warn(`🔄 [ITERATE] Page ${pageNumber}: No fix targets available for blackout, falling back to original as reference`);
      previousImage = imageData;
    }
  } else if (useOriginalAsReference) {
    previousImage = imageData;
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Using original image as reference for generation`);
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Generating new image (referenceMode=${effectiveReferenceMode}, singlePassScene=${effectiveSinglePass})...`);

  // Apply reference-mode flag to refs/grid/landmarks/sceneBackground.
  const { applyReferenceMode } = getStoryHelpers();
  const refApplied = applyReferenceMode({
    mode: effectiveReferenceMode,
    characterPhotos: referencePhotos,
    visualBibleGrid,
    landmarkPhotos: finalLandmarkPhotos,
    sceneBackground,
    sceneMetadata: iterateSceneMetadata,
  });

  // Step 6: Generate image
  let imageResult;
  if (iterativePlacement) {
    const { resolveArtStyle: resolveIterStyle } = getStoryHelpers();
    const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
    const iterArtStyleDesc = resolveIterStyle(storyData.artStyle || 'pixar', iterBackend) || resolveIterStyle('pixar') || '';
    imageResult = await generateWithIterativePlacement(imagePrompt, refApplied.characterPhotos, iterateSceneMetadata, {
      imageModelOverride,
      imageBackendOverride: iterBackend,
      landmarkPhotos: refApplied.landmarkPhotos,
      visualBibleGrid: refApplied.visualBibleGrid,
      pageNumber,
      artStyle: iterArtStyleDesc,
      sceneBackground: refApplied.sceneBackground,
    });
  } else {
    // Shared page generation — same entry Phase 5a uses. Eval + detection run
    // via the shared primitives below (skipped for pipeline callers, which
    // score round results themselves).
    const iterLabel = `PAGE ${pageNumber} ITERATE`;
    const genResult = await generateImageOnly(imagePrompt, refApplied.characterPhotos, {
      previousImage,
      imageModelOverride,
      landmarkPhotos: refApplied.landmarkPhotos,
      visualBibleGrid: refApplied.visualBibleGrid,
      sceneBackground: refApplied.sceneBackground,
      pageNumber,
      artStyle,
      skipCache: true,
      aspectRatio: sceneAspect,
      captureLabel: 'image_scene',
    });
    if (usageTracker && genResult?.usage) {
      const m = genResult.modelId || '';
      const genProvider = m.startsWith('runware:') ? 'runware' : m.startsWith('grok-imagine') ? 'grok' : 'gemini_image';
      usageTracker(genProvider, genResult.usage, 'page_images', genResult.modelId);
    }
    let iterQuality = null;
    let iterDetection = null;
    if (!skipEval && genResult?.imageData) {
      try {
        iterQuality = await evaluateImageQuality(
          genResult.imageData, imagePrompt, refApplied.characterPhotos, 'scene', null,
          iterLabel, null, null, sceneCharacters, {}
        );
        if (usageTracker && iterQuality?.usage) {
          usageTracker('gemini_quality', iterQuality.usage, 'page_quality', iterQuality.modelId);
        }
      } catch (evalErr) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: eval failed (${evalErr.message}) — serving unscored render`);
      }
      try {
        // sceneCharacters is the photo-backed cast; story-invented characters
        // live only in the Visual Bible and must be appended, or the identity
        // call assigns a cast name to the invented figure
        // (job_1786737619634_d66c7bg9g p4).
        // Same identity line the first detection gets. A bare-name re-detect here
        // OVERWRITES a good detection: job_1786737619634_d66c7bg9g p4 ran a repair
        // and its stored expectedCharacters came back with empty descriptions.
        const iterClothing = iterateSceneMetadata?.characterClothing || {};
        const iterExpectedCharacters = (sceneCharacters || []).map(c => {
          const cname = c.name || c;
          if (typeof c !== 'object') return { name: cname, description: '' };
          let clothingText = '';
          if (iterClothing[cname]) {
            try {
              clothingText = require('./entityConsistency').buildClothingDescription(
                c, iterClothing[cname], artStyle, storyData?.clothingRequirements || null) || '';
            } catch { /* identity line goes without clothing */ }
          }
          return { name: cname, description: c.description || getStoryHelpers().buildCastIdentityDescription(c, clothingText) };
        });
        iterExpectedCharacters.push(...getStoryHelpers().buildSecondaryExpectedCharacters(
          visualBible, iterateSceneMetadata, iterExpectedCharacters.map(c => c.name),
          { pageLabel: `${iterLabel} ` }
        ));
        iterDetection = await detectAllBoundingBoxes(genResult.imageData, {
          expectedCharacters: iterExpectedCharacters,
          expectedObjects: Array.isArray(iterateSceneMetadata?.objects)
            ? iterateSceneMetadata.objects.filter(o => typeof o === 'string')
            : [],
          sceneContext: newSceneDescription,
          pageContext: iterLabel,
          artStyle,
        });
      } catch (bboxErr) {
        log.warn(`⚠️ [ITERATE] Page ${pageNumber}: detection failed (${bboxErr.message})`);
      }
    }
    imageResult = {
      ...(iterQuality || {}),
      imageData: genResult.imageData,
      modelId: genResult.modelId,
      qualityModelId: iterQuality?.modelId || null,
      grokRefImages: genResult.grokRefImages || null,
      totalAttempts: 1,
      bboxDetection: iterDetection,
    };
    if (imageResult.score === undefined) imageResult.score = null;
    if (skipEval) imageResult.reasoning = 'no gen-time eval (pipeline scores versions)';
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
    imagePrompt,
    newScene: newSceneDescription,
    newSceneMetadata,
    // The rewritten scene is a NEW contract — its character set can legitimately
    // differ from the original plan (e.g. the rewrite re-includes a character
    // the outline dropped but the page text mentions). Callers must evaluate
    // the result against THIS contract, not the original page metadata.
    newSceneCharacters: sceneCharacters,
    previewMismatches,
    checksRun,
    compositionAnalysis: previewFeedback.composition,
    score: imageResult.score,
    reasoning: imageResult.reasoning,
    qualityModelId: imageResult.qualityModelId || null,
    fixTargets: imageResult.fixTargets || [],
    fixableIssues: imageResult.fixableIssues || [],
    totalAttempts: imageResult.totalAttempts,
    referencePhotos,
    landmarkPhotos: pageLandmarkPhotos,
    visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null,
    grokRefImages: imageResult.grokRefImages || null,
    modelId: imageResult.modelId || null,
    bboxDetection: imageResult.bboxDetection || null,
    // The blackout image (when blackout mode was used and fixTargets were found)
    blackoutImage: (blackoutIssues && previousImage && previousImage !== imageData) ? previousImage : null,
    method: 'iterate'
  };
}

// Backward-compatible alias
const iteratePage = iteratePageCore;


/**
 * Repair character mismatch by replacing a specific character with their avatar
 *
 * @param {string} imageData - Current image data (base64)
 * @param {string} characterPhoto - Character's avatar photo (base64)
 * @param {Array<number>} bbox - Bounding box [ymin, xmin, ymax, xmax] in 0-1 normalized coords
 * @param {string} charName - Character name for the prompt
 * @param {Object} options - Options
 * @returns {Promise<Object>} { imageData, character, method: 'character_replacement' }
 */
async function repairCharacterMismatch(imageData, characterPhoto, bbox, charName, options = {}) {
  if (!bbox || bbox.length !== 4) {
    throw new Error('Valid bounding box required for character replacement');
  }

  // Route to Grok repair if requested
  if (options.imageBackend === 'grok') {
    return repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options);
  }

  // Default: Gemini repair — folded into the unified spine as model:'gemini'
  // (Stage 5). This was the last no-gate verbatim path: an ungated full-scene
  // Gemini repaint with no mask and no blend. It now flows through the SAME
  // treatment + samUnionBlend + gate battery (style-match / IoU / white-card /
  // coverage / sharpness) as grok and qwen. Axes come from the ONE central rule.
  const { repairCharacterFace, resolveRepairAxes } = require('./faceRepair');
  const geminiAxes = resolveRepairAxes(options.issueDescription, {
    hasFaceBbox: Array.isArray(options.faceBbox) && options.faceBbox.length === 4,
    forceTarget: (options.whiteoutTarget === 'face' || options.whiteoutTarget === 'body') ? options.whiteoutTarget : null,
    model: 'gemini',
  });
  return repairCharacterFace(imageData, characterPhoto, {
    ...options,
    ...geminiAxes,
    charName,
    bbox,
    bodyBbox: bbox,
    faceBbox: options.faceBbox,
  });
}

/**
 * Repair character mismatch using Grok Imagine edit endpoint.
 *
 * Two modes:
 * - Cut-out (options.useCutout = true): Extract bbox region, send region + characterRef to Grok,
 *   composite result back into original scene.
 * - Full scene (default): Send full scene + characterRef to Grok with repair prompt.
 *
 * @param {string} imageData - Current scene image (base64 data URI)
 * @param {string} characterPhoto - Character avatar photo (base64 data URI)
 * @param {Array<number>} bbox - Bounding box [ymin, xmin, ymax, xmax] in 0-1 normalized coords
 * @param {string} charName - Character name
 * @param {Object} options
 * @returns {Promise<Object>} { imageData, character, method, usage }
 */
// Grok image edits only support specific aspect ratios — pick the closest
// preset for a given source (width, height). Used by character repair so we
// don't send "1024:768" (which Grok may reject) and instead send "4:3".
// Full set of aspect presets the Grok Imagine edit endpoint supports lives
// in ./grokAspect (GROK_ASPECT_PRESETS + closestGrokAspect), imported above.
// The 13-preset set (incl 2:1, 1:2, 19.5:9, 9:19.5, 20:9, 9:20) gives tighter
// snaps for odd cutout shapes so the scene extract can naturally match a
// preset without any letterbox padding.
// Source: https://docs.x.ai/developers/model-capabilities/images/generation

/**
 * Pick an extract rectangle that naturally matches a Grok preset aspect.
 *
 * Given a character bbox in pixels and a desired padding factor, expand the
 * extract on ONE axis so the final crop dimensions land exactly on a supported
 * Grok aspect preset. No letterbox padding involved — we grab more scene pixels
 * instead. The extract is centered on the bbox and clamped to scene bounds.
 *
 * @param {object} args
 * @param {number} args.pixelLeft     - bbox left in scene pixels
 * @param {number} args.pixelTop      - bbox top in scene pixels
 * @param {number} args.pixelWidth    - bbox width in pixels
 * @param {number} args.pixelHeight   - bbox height in pixels
 * @param {number} args.padFactor     - minimum padding as fraction of bbox dim
 * @param {number} args.sceneWidth    - scene canvas width
 * @param {number} args.sceneHeight   - scene canvas height
 * @returns {{left:number, top:number, width:number, height:number, preset:string}}
 */

// Repaired-figure blur gate: reject when the repaired figure region has lost
// most of its edge detail vs the original. Ratio-based so soft art styles
// (watercolor) pass — both sides are equally soft there.
const REPAIR_SHARPNESS_REJECT_RATIO = 0.5;
const REPAIR_SHARPNESS_MIN_ORIG = 25; // orig region too flat → ratio meaningless, skip gate

// Production FACE repair via the shared SAM-union insert blend (samBlend.samUnionBlend)
// — the Test-Lab "insert path" ported to prod: square face crop → SAM head whiteout →
// Grok redraw → SAM round-1∪round-2 union → erode-then-feather composite. NO crosshatch,
// NO rectangular blend. Feather-only first (colorCorrect:false; garment/border colour is
// a later follow-up). The blended FACE branch calls this inside a try/catch → falls back
// to the legacy blur+rectangular blend on ANY failure (SAM down, gate reject, style
// drift), so a repair always returns an image. Everything stays in CROP space; the
// feathered crop is composited back at the crop origin. Mirrors runQwenInsertStage.
async function repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options = {}) {
  // ── ADAPTER (Stage 3) ─────────────────────────────────────────────────────
  // The five legacy Grok repair branches (blended / cutout / fullScene inpaint /
  // blackout + the face-insert early-return) and their two private blend engines
  // were deleted here and MERGED into the unified 3-axis spine repairCharacterFace
  // (server/lib/faceRepair.js). This thin adapter keeps the old signature and
  // legacy option flags working: it validates + expands the bbox exactly as
  // before, maps the flags onto {regionSource, treatment, model, faceOnly} via
  // legacyFlagsToAxes, and hands off. All region/treatment/model/blend logic and
  // EVERY gate (style-match, IoU, white-card, coverage, requireMobilesam,
  // sharpness) now live in the spine — one path, no branch skips a gate.
  // See docs/face-repair-merge-design.md.
  if (!isGrokConfigured()) {
    throw new Error('XAI_API_KEY not configured for Grok repair');
  }

  // Runtime metrics: every char-repair invocation. The styled-avatar cache
  // scope IS the jobId (== storyId) inside a full-mode pipeline run; undefined
  // outside one (manual repair endpoints) → forJob() no-ops.
  require('./runMetrics').forJob(require('./styledAvatars')._cacheContext?.getStore?.()).count('char_repair_run');

  let [ymin, xmin, ymax, xmax] = bbox;

  // Validate bbox coordinates — NaN or out-of-range values crash Sharp.
  if ([ymin, xmin, ymax, xmax].some(v => v == null || isNaN(v) || v < 0 || v > 1) || ymin >= ymax || xmin >= xmax) {
    log.warn('⚠️ [CHAR REPAIR GROK] Invalid bbox for ' + charName + ': [' + bbox.join(', ') + '] — skipping');
    return { imageData: null, character: charName, method: 'grok_blended', error: 'Invalid bounding box' };
  }

  // Face bbox union expansion: if a separate face box pokes outside the body box
  // (detector cut through the character), expand the body box to contain it so
  // the treatment mask doesn't miss half the face.
  // FAITHFULNESS-CHECK: images.js:11318-11341 (pre-merge).
  const faceBboxIn = options.faceBbox;
  if (Array.isArray(faceBboxIn) && faceBboxIn.length === 4
      && faceBboxIn.every(v => v != null && !isNaN(v) && v >= 0 && v <= 1)) {
    const [fymin, fxmin, fymax, fxmax] = faceBboxIn;
    if (fymin < ymin || fxmin < xmin || fymax > ymax || fxmax > xmax) {
      ymin = Math.min(ymin, fymin); xmin = Math.min(xmin, fxmin);
      ymax = Math.max(ymax, fymax); xmax = Math.max(xmax, fxmax);
      bbox = [ymin, xmin, ymax, xmax];
      log.info('👤 [CHAR REPAIR GROK] Face bbox outside body bbox — expanded body bbox to union [' + bbox.map(v => Math.round(v * 100) + '%').join(', ') + ']');
    }
  }

  // Legacy flags → 3 axes (the face-insert precedence, the blended/cutout/
  // fullScene modes, and the deprecated blackout default all live in
  // legacyFlagsToAxes).
  const { repairCharacterFace, legacyFlagsToAxes } = require('./faceRepair');
  const axes = legacyFlagsToAxes({
    useBlended: options.useBlended === true ? true : null,
    useCutout: options.useCutout === true ? true : null,
    useFullScene: options.useFullScene === true ? true : null,
    whiteoutTarget: options.whiteoutTarget || 'body',
    hasFaceBbox: Array.isArray(options.faceBbox) && options.faceBbox.length === 4,
    model: 'grok',
  });

  return repairCharacterFace(imageData, characterPhoto, {
    ...options,      // issueDescription, clothingDescription, sceneDescription,
                     // photoType, protectedFaces/Bodies, textPosition, artStyle,
                     // includeDebug, characterDescription/richDescription, etc.
    ...axes,         // regionSource / treatment / model / faceOnly (override any
                     // stray same-named option keys).
    charName,
    bbox,
    bodyBbox: bbox,
    faceBbox: options.faceBbox,
  });
}


/**
 * Edit an image based on a user-provided prompt using Gemini's image editing capabilities
 * Pure text/instruction based - no character photos to avoid regeneration artifacts
 * @param {string} imageData - The original image data (base64)
 * @param {string} editInstruction - What the user wants to change
 * @returns {Promise<{imageData: string}|null>}
 */
async function editImageWithPrompt(imageData, editInstruction, model, referenceImages = [], artStyle = null, aspectRatioOverride = null) {
  const modelId = model || MODEL_DEFAULTS.pageImage;
  const modelConfig = IMAGE_MODELS[modelId];
  const backend = modelConfig?.backend || 'gemini';
  // editWithGrok center-crops every input to match the requested aspect ratio.
  // For an EDIT of an existing image the right output aspect is the source's
  // own aspect — Grok's /edits endpoint returns at input aspect anyway. If we
  // pass a different ratio (e.g. coverAspect='3:4'=0.75 vs the actual 880×1245
  // cover at 0.707), the crop slices ~36px off the top and bottom of the cover
  // before Grok ever sees it, cutting into the burned-in title text.
  // Measure imageData and use its actual aspect; fall back to caller override
  // or the global default when measurement fails.
  let measuredAspect = null;
  try {
    if (typeof imageData === 'string') {
      const m = imageData.match(/^data:image\/\w+;base64,(.+)$/);
      const buf = m ? Buffer.from(m[1], 'base64') : null;
      if (buf) {
        const meta = await sharp(buf).metadata();
        if (meta.width && meta.height) {
          // Snap to the nearest preset both Grok and Gemini accept. Raw
          // "1024:1024" is rejected by both APIs ("unknown variant"); even
          // GCD-reduced values like "176:249" (an 880×1245 cover) aren't on
          // either side's allow-list. Pick the closest standard preset by
          // ratio. Order matters only for ties — list runs portrait → square
          // → landscape so the natural reading is preserved.
          const PRESETS = [
            ['9:16', 9 / 16],   // 0.5625
            ['2:3',  2 / 3],    // 0.667
            ['3:4',  3 / 4],    // 0.75
            ['4:5',  4 / 5],    // 0.8
            ['1:1',  1],        // 1.0
            ['5:4',  5 / 4],    // 1.25
            ['4:3',  4 / 3],    // 1.333
            ['3:2',  3 / 2],    // 1.5
            ['16:9', 16 / 9],   // 1.778
          ];
          const r = meta.width / meta.height;
          let best = PRESETS[0];
          let bestDelta = Math.abs(Math.log(r / best[1]));
          for (const p of PRESETS) {
            const delta = Math.abs(Math.log(r / p[1]));
            if (delta < bestDelta) { best = p; bestDelta = delta; }
          }
          measuredAspect = best[0];
        }
      }
    }
  } catch { /* fall through */ }
  const aspectRatio = measuredAspect || aspectRatioOverride || CONFIG_DEFAULTS.pageAspect;

  log.debug(`✏️  [IMAGE EDIT] Editing image with instruction: "${editInstruction}" (model: ${modelId}, backend: ${backend}, refs: ${referenceImages.length}, aspect: ${aspectRatio})`);

  // Resolve the art-style description so the edit prompt can anchor it.
  // Without this, Grok's edit endpoint defaults to its house cartoon/anime
  // style when repainting faces, even when the source image is realistic.
  const { resolveArtStyle } = getStoryHelpers();
  const styleText = (artStyle && resolveArtStyle)
    ? (resolveArtStyle(artStyle, backend) || '')
    : '';

  // Build the editing prompt from template
  const editPrompt = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, {
    EDIT_INSTRUCTION: editInstruction,
    ART_STYLE: styleText || 'Match the source image\'s artistic style.',
  });
  log.debug(`✏️  [IMAGE EDIT] Full prompt: "${editPrompt}"`);

  if (backend === 'grok') {
    // Grok edit path — uses /images/edits endpoint with reference images
    // Include the current image + any additional character/VB references
    const allRefs = [imageData, ...referenceImages].slice(0, 3); // Grok max 3 refs
    try {
      const grokResult = await editWithGrok(editPrompt, allRefs, { model: modelConfig.modelId, aspectRatio });
      log.info(`✅ [IMAGE EDIT] Successfully edited image via Grok`);
      return {
        imageData: grokResult.imageData,
        usage: { model: modelId, cost: grokResult.usage?.cost }
      };
    } catch (grokErr) {
      // Content moderation block — sanitize prompt and retry, then fall back to Gemini
      if (grokErr.message?.includes('content moderation') || grokErr.message?.includes('400')) {
        log.warn(`⚠️ [IMAGE EDIT] Grok blocked by content moderation, sanitizing prompt and retrying...`);
        // Soften violent/weapon language for retry
        const sanitized = editPrompt
          .replace(/\b(stab|pierce|impale|kill|slay|attack|strike|hit|slash|cut|wound|bleed|blood|die|dead|death)\b/gi, 'touch')
          .replace(/\b(spear|sword|knife|blade|weapon|arrow|axe)\s+(go(?:es|ing)?|plung(?:es|ing)?|driv(?:es|ing)?|thrust(?:s|ing)?)\s+(into|through)\b/gi, '$1 reaches toward')
          .replace(/\b(into|through)\s+(the\s+)?(body|chest|stomach|head|neck|heart|flesh|skin)\b/gi, 'near the $3')
          .replace(/going into/gi, 'pointing at')
          .replace(/touch.*chin/gi, 'be positioned near the face');
        if (sanitized !== editPrompt) {
          log.info(`🔄 [IMAGE EDIT] Retrying with sanitized prompt: "${sanitized.substring(0, 120)}..."`);
          try {
            const retryResult = await editWithGrok(sanitized, [imageData], { model: modelConfig.modelId, aspectRatio });
            log.info(`✅ [IMAGE EDIT] Sanitized retry succeeded via Grok`);
            return {
              imageData: retryResult.imageData,
              usage: { model: modelId, cost: retryResult.usage?.cost }
            };
          } catch (retryErr) {
            log.warn(`⚠️ [IMAGE EDIT] Sanitized retry also blocked, falling back to Gemini`);
          }
        }
        // Fall through to Gemini path below
        log.info(`🔄 [IMAGE EDIT] Falling back to Gemini for content-moderated edit`);
      } else {
        log.error(`❌ [IMAGE EDIT] Grok edit failed, falling back to Gemini: ${grokErr.message}`);
        // Fall through to Gemini path below
      }
    }
  }

  // Gemini edit path — uses generateContent with responseModalities: IMAGE
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Extract base64 and mime type from the image
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build parts array with text FIRST, then image (helps model understand it's an edit instruction)
    const parts = [
      { text: editPrompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // When this branch is reached via Grok fallback, modelConfig.modelId is a
    // Grok model id ('grok-imagine-image'), which Gemini's API doesn't know
    // and returns 404 for. Only trust modelConfig.modelId when the backend is
    // actually Gemini — otherwise use the canonical Gemini image model id.
    const geminiModelId = modelConfig?.backend === 'gemini'
      ? modelConfig.modelId
      : 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModelId}:generateContent?key=${apiKey}`;

    const systemInstruction = getImageSystemInstruction();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        ...(systemInstruction && { systemInstruction }),
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.6,
          ...(modelSupportsThinking(geminiModelId) && { thinkingConfig: { includeThoughts: true } }),
          imageConfig: {
            aspectRatio
          }
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [IMAGE EDIT] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const thinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
    log.debug(`📊 [IMAGE EDIT] Token usage - input: ${inputTokens}, output: ${outputTokens}${thinkingTokens ? `, thinking: ${thinkingTokens}` : ''}, model: ${modelId}`);

    // Extract thinking text
    const thinkingText = extractThinkingFromParts(data.candidates?.[0]?.content?.parts, 'IMAGE EDIT');

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const responseParts = data.candidates[0].content.parts;
      log.debug(`✏️  [IMAGE EDIT] Found ${responseParts.length} parts in response`);

      for (const part of responseParts) {
        // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API varies
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const editedImageData = `data:${respMimeType};base64,${inlineData.data}`;
          log.info(`✅ [IMAGE EDIT] Successfully edited image`);
          return { imageData: editedImageData, thinkingText, usage: { inputTokens, outputTokens, thinkingTokens, model: modelId } };
        }
      }
    }

    log.warn('⚠️  [IMAGE EDIT] No edited image in response');
    return { imageData: null, usage: { inputTokens, outputTokens, model: modelId } };
  } catch (error) {
    log.error('❌ [IMAGE EDIT] Error editing image:', error);
    throw error;
  }
}

/**
 * Composite routing for the shared image path.
 *
 * `composite` is a first-class route helper on the shared image path, not a
 * cover-only fork. When `options.composite === true` AND the landmark-buffer
 * prerequisite is met, the image is produced by the manual-composite + 2-pass
 * Grok pipeline (`generateCoverViaComposite`) instead of the normal direct
 * generate+eval path, and returned in an imageResult-shaped object marked
 * `composite:true`. The composite result skips quality eval (score null) —
 * identical to the behaviour before this became a shared-path option.
 *
 * Returns null to signal "run the normal direct generate+eval path". That
 * happens in three cases, each byte-identical to the previous cover fork:
 *   1. composite not requested (the DEFAULT — every page image; pages never set
 *      the option, so they skip this entirely and are unaffected),
 *   2. composite requested but the landmark-buffer prerequisite is missing
 *      (invented-location fallback → direct render with location prose),
 *   3. the composite generator threw (fall back to direct).
 *
 * Gated on the OPTION VALUE, never on evaluationType — a page COULD opt in
 * (owner principle: covers and images share one code path, composite is just an
 * option that is ON for covers and OFF for pages). Defaults differ, code does not.
 *
 * @param {Object} options - { composite: true, compositeInputs } bag
 * @param {Function|null} usageTracker - forwarded to the composite generator
 * @param {string} pageLabel - log prefix
 * @returns {Promise<Object|null>} composite imageResult, or null → run direct path
 */
async function _maybeGenerateComposite(options, usageTracker = null, pageLabel = '') {
  if (!options || options.composite !== true) return null;
  const ci = options.compositeInputs || {};
  // Composite requires a real background plate (the landmark buffer). Without
  // one, pass 2 (the photo-protection edit) is skipped and the path degrades to
  // figures-on-white — so covers for invented/landmark-less locations fall back
  // to the direct render, whose location prose drives the backdrop directly.
  if (!ci.landmarkBuf) {
    log.info(`🎨 [QUALITY RETRY] ${pageLabel}composite requested but no landmark buffer — using normal generation`);
    return null;
  }
  try {
    const { generateCoverViaComposite } = require('./coverComposite');
    const compositeResult = await generateCoverViaComposite({
      coverKey: ci.coverKey,
      characters: ci.characters,
      coverHint: ci.coverHint,
      sceneDescription: ci.sceneDescription,
      vbGrid: ci.vbGrid,
      landmarkBuf: ci.landmarkBuf,
      sceneBackground: ci.sceneBackground,
      artStyle: ci.artStyle,
      title: ci.title,
      dedication: ci.dedication,
      styleHint: ci.styleHint,
      usageTracker,
      visualBible: ci.visualBible,
      orient: ci.orient || 'frontal',
    });
    log.info(`🎨 [QUALITY RETRY] ${pageLabel}composite-cover generated (modelId=${compositeResult.modelId})`);
    return {
      composite: true,
      imageData: compositeResult.imageData,
      score: null, // composite path skips quality eval — returns immediately
      reasoning: 'composite-cover (no quality eval)',
      modelId: compositeResult.modelId,
      totalAttempts: compositeResult.totalAttempts || 1,
      prompt: compositeResult.prompt,
      usage: { cost: 0.04, direct_cost: 0.04 }, // 2 Grok edits
      grokRefImages: null,
      compositeDebug: compositeResult.debug,
    };
  } catch (err) {
    log.warn(`⚠️ [QUALITY RETRY] ${pageLabel}composite path failed: ${err.message} — falling back to normal path`);
    return null;
  }
}

/**
 * Delete a specific entry from the image cache
 * @param {string} cacheKey - The cache key to delete
 * @returns {boolean} True if the key was deleted, false if it didn't exist
 */
function deleteFromImageCache(cacheKey) {
  if (imageCache.has(cacheKey)) {
    imageCache.delete(cacheKey);
    return true;
  }
  return false;
}


/**
 * Get cache statistics for logging
 * @returns {{image: Object, ref: Object}} Stats for both caches
 */
function getCacheStats() {
  return {
    image: imageCache.getStats(),
    ref: compressedRefCache.getStats()
  };
}



// ============================================
// AUTO-REPAIR (INPAINTING) FUNCTIONS
// ============================================

/**
 * Inspect an image for physics/visual errors using Gemini Flash
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{errorFound: boolean, errorType?: string, description?: string, boundingBox?: number[], fixPrompt?: string}>}
 */


// =============================================================================
// REFERENCE SHEET GENERATION FOR SECONDARY ELEMENTS
// =============================================================================

/**
 * Split a grid image into individual reference images.
 *
 * Tries the Python /split-reference-sheet endpoint first — it uses variance
 * analysis to find the actual cell boundaries (handles visible gaps, title
 * bars, uneven cell sizes). Falls back to blind sharp-based math if the
 * Python service is unavailable.
 *
 * @param {Buffer|string} gridImage - Grid image as Buffer or base64 data URL
 * @param {number} count - Number of elements in the grid
 * @returns {Promise<string[]>} Array of base64 PNG images (without data URL prefix)
 */

/**
 * Collect ALL fixable issues for a given page from every source:
 * quality eval, retry history, entity consistency (characters + objects), and image checks.
 * Returns a unified array of issue objects suitable for enrichWithBoundingBoxes.
 */
function collectAllIssuesForPage(scene, storyData, pageNumber) {
  const issues = [];

  // Source 1: Quality eval fixableIssues (on scene)
  if (scene.fixableIssues?.length) {
    issues.push(...scene.fixableIssues.map(i => ({ ...i, source: 'quality eval' })));
  }

  // Source 2: Retry history evals
  const latestRetry = scene.retryHistory?.slice(-1)[0];
  if (latestRetry?.postRepairEval?.fixableIssues?.length) {
    issues.push(...latestRetry.postRepairEval.fixableIssues.map(i => ({ ...i, source: 'post-repair eval' })));
  }
  if (latestRetry?.preRepairEval?.fixableIssues?.length) {
    issues.push(...latestRetry.preRepairEval.fixableIssues.map(i => ({ ...i, source: 'pre-repair eval' })));
  }

  // Source 3: Entity consistency issues (characters)
  const entity = storyData.finalChecksReport?.entity;
  if (entity?.characters) {
    for (const [charName, charResult] of Object.entries(entity.characters)) {
      const charIssues = [];
      if (charResult.byClothing && Object.keys(charResult.byClothing).length > 0) {
        for (const cr of Object.values(charResult.byClothing)) {
          if (cr.issues) charIssues.push(...cr.issues);
        }
      } else if (charResult.issues) {
        charIssues.push(...charResult.issues);
      }
      for (const issue of charIssues) {
        if (issue.pagesToFix?.includes(pageNumber) || issue.pageNumber === pageNumber) {
          issues.push({
            description: issue.fixInstruction || issue.description,
            severity: issue.severity,
            type: 'consistency',
            fix: issue.canonicalVersion || issue.fixInstruction || '',
            character: charName,
            source: 'entity check',
          });
        }
      }
    }
  }

  // Source 4: Entity consistency issues (objects)
  if (entity?.objects) {
    for (const [objName, objResult] of Object.entries(entity.objects)) {
      const objIssues = [];
      if (objResult.byClothing && Object.keys(objResult.byClothing).length > 0) {
        for (const cr of Object.values(objResult.byClothing)) {
          if (cr.issues) objIssues.push(...cr.issues);
        }
      } else if (objResult.issues) {
        objIssues.push(...objResult.issues);
      }
      for (const issue of objIssues) {
        if (issue.pagesToFix?.includes(pageNumber) || issue.pageNumber === pageNumber) {
          issues.push({
            description: issue.fixInstruction || issue.description,
            severity: issue.severity,
            type: 'consistency',
            fix: issue.canonicalVersion || issue.fixInstruction || '',
            character: objName,
            source: 'entity check',
          });
        }
      }
    }
  }

  // Source 5: Image checks (cross-page consistency)
  if (storyData.finalChecksReport?.imageChecks) {
    for (const check of storyData.finalChecksReport.imageChecks) {
      for (const issue of check.issues || []) {
        if (issue.pagesToFix?.includes(pageNumber) || issue.images?.includes(pageNumber)) {
          issues.push({
            description: issue.description,
            severity: issue.severity,
            type: issue.type || 'consistency',
            fix: issue.recommendation || issue.description,
            character: issue.characterInvolved || check.characterName || null,
            source: 'image checks',
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Apply style transfer: re-render an existing image in the story's art style using a different model.
 * Sends the current image as a reference and asks the model to redraw it in the specified art style,
 * keeping all characters, positions, and scene composition identical.
 */
async function applyStyleTransfer(imageData, artStyle, options = {}) {
  const { imageModelOverride, imageBackendOverride } = options;
  const { resolveArtStyle } = require('./storyHelpers');

  // artStyle can be: a preset key ("pixar"), or a custom description string
  const styleDescription = resolveArtStyle(artStyle, imageBackendOverride) || artStyle;

  // Style transfer: input image is the ONLY reference. No avatars — they cause
  // the model to redraw faces from the avatar (which often look photo-real),
  // defeating the whole point of restyling.
  //
  // Prompt design notes:
  //   - "Layout reference" framing tells the model the input is COMPOSITION
  //     ONLY, not rendering. Without this, Grok/Gemini treat the previous
  //     image as authoritative and barely restyle (or restyle backgrounds
  //     while leaving faces photo-real, which is the #1 user complaint).
  //   - Style is at the TOP, before composition rules — earlier tokens get
  //     more weight.
  //   - Explicit per-element enforcement (faces, skin, hair, clothing, sky,
  //     ground) closes the loophole where the model styles backgrounds but
  //     leaves figures in source rendering.
  //   - Anti-photo banner addresses the recurring "figures look like photos"
  //     case directly.
  const prompt = fillTemplate(LOCAL_PROMPTS.styleTransfer, {
    STYLE_DESCRIPTION: styleDescription,
  });

  log.info(`🎨 [STYLE TRANSFER] target: ${artStyle}, model: ${imageModelOverride || 'default'} (no avatars — input image is sole reference)`);

  // characterPhotos intentionally omitted — see comment above. The previousImage
  // is the only reference attached, so the model can't drift toward an avatar.
  return generateImageOnly(prompt, [], {
    imageModelOverride,
    imageBackendOverride,
    previousImage: imageData,
    skipCache: true,
  });
}

module.exports = {
  // Gemini plumbing consumed by imageInpainting via lazy accessors (the
  // inpaint LLM-verify path); exported for that one consumer.
  withRetry,
  modelSupportsThinking,
  getImageSystemInstruction,
  extractThinkingFromParts,
  // Utility functions
  hashImageData,
  generateImageCacheKey,
  cropImageForSequential,
  compressImageToJPEG,
  // Live shared ref-compression LRU — single instance; evalPipeline.js reaches
  // it lazily via require('./images').compressedRefCache. Never duplicate it.
  compressedRefCache,
  buildExpectedCharactersForBbox,
  buildObjectGroundingHints,
  // Exported for tests/unit/sam-mask-guard.test.ts — the SAM acceptance rule
  // decides every figure's bodyBox, so its thresholds need direct coverage.

  // Core image functions
  validateEmptyScene,
  evaluateImageQuality,
  evaluateThreeStage,
  capComplianceIdentitySeverity,
  callGeminiAPIForImage,
  editImageWithPrompt,
  _maybeGenerateComposite,
  rewriteBlockedScene,

  // Separated evaluation pipeline functions (new architecture)
  generateImageOnly,
  generateWithIterativePlacement,
  applyStyleTransfer,
  evaluateImageBatch,

  // Unified repair pipeline (the only active repair pipeline)
  inpaintPage,

  // Active repair primitives
  iteratePageCore,
  iteratePage,
  repairCharacterMismatch,

  // Cache management
  deleteFromImageCache,
  getCacheStats,

  // Mask + region helpers (used by inpaint paths)

  // Two-stage bounding box detection — implementation lives in ./bboxDetection
  // (verbatim move, 2026-08-11); re-exported here so consumers keep importing
  // from './images'. Same function objects — never a duplicate implementation.
  detectAllBoundingBoxes,
  imageFingerprint,
  bboxPairsWith,
  restampDetectionForCoverText,
  detectionForVersion,
  parseVisualBibleObjects,
  resolveExpectedObjectLabels,
  escapeXml,
  _hashBboxKey,
  _bboxCacheGet,
  _bboxCacheSet,
  // Region/geometry + treatment helpers consumed by the unified faceRepair.js.
  // Exported (minimal) rather than duplicated so the merge stays single-source.
  REPAIR_SHARPNESS_MIN_ORIG,
  REPAIR_SHARPNESS_REJECT_RATIO,
  closestGrokAspect,
  detectSubRegion,  // Sub-region detection for targeted repairs (shoes, shirt, hands, etc.)
  createBboxOverlayImage,  // Create overlay image with boxes drawn
  createSamInputOverlayImage,  // Per-figure SAM prompt: box + labelled points
  createCutoutSheetImage,      // The final cut-outs, full height, as their own image
  getBboxCacheStats, // Telemetry for the content-hashed bbox cache
  FIGURE_COLORS,  // Color palette for bbox overlay (shared with prompt building)
  callGrokVisionAPI,  // Grok vision API for bbox/quality eval
  GEMINI_SAFETY_SETTINGS,  // Safety settings for Gemini API calls
  enrichWithBoundingBoxes,

  // Reference sheet generation for secondary elements

  // Issue collection
  collectAllIssuesForPage,

  // Standalone visual inventory (for evaluate-single endpoint)
  runVisualInventory,

  // Sanitization helpers
  sanitizeForGemini,

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD,

  // Pure dispatch helpers (exported for unit tests / reuse)
  resolveOutputAspect,
  truncatePromptForModel,
  shrinkPromptForModel,
  extractDataImageUrls
};
