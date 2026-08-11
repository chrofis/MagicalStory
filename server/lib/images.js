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
const { detectFiguresWithGroundingDino, attachSamMasksToFigures, _shortGarmentPhrase } = require('./figureDetection');
const { buildEmptySceneVbGrid, buildPageCompositeRefs } = require('./referenceSheets');
const { GROK_ASPECT_PRESETS, closestGrokAspect } = require('./grokAspect');

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
  bboxRefineOverlay: readPrompt('bbox-refine-overlay.txt'),
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

// Quality-eval sampling knobs (env-overridable for A/B). Defaults chosen from
// a local variance test on job_1781310332569 p4 (4 runs × 3 configs):
//   temp 0.3 + thinking 8192 (old): mean 6.3 issues, count spread 4 (noisy)
//   temp 0   + thinking 8192      : mean 9.3 issues — thinking OVER-flags
//   temp 0   + thinking 0  (this) : mean 4.5 issues, count spread 1 — stable
//                                   AND finds the real issues, not invented ones
// Temperature 0 stabilises the issue count; thinking off stops the structured
// detection check from rationalising extra "problems" (it permanently
// condemns good images). Semantic / three-stage evals are unaffected — they
// keep their own calls and can keep thinking where reasoning genuinely helps.
const { EVAL_TEMPERATURE } = require('../config/models');
const EVAL_THINKING_BUDGET = process.env.EVAL_THINKING_BUDGET != null ? Number(process.env.EVAL_THINKING_BUDGET) : 0;
const { createDiffImage } = require('./repairVerification');

// Distinct color per figure — high contrast palette, shared between overlay drawing and prompt building
const FIGURE_COLORS = [
  { hex: '#e6194b', name: 'Red' },
  { hex: '#3cb44b', name: 'Green' },
  { hex: '#4363d8', name: 'Blue' },
  { hex: '#f58231', name: 'Orange' },
  { hex: '#911eb4', name: 'Purple' },
  { hex: '#42d4f4', name: 'Cyan' },
  { hex: '#f032e6', name: 'Magenta' },
  { hex: '#bfef45', name: 'Lime' },
  { hex: '#fabed4', name: 'Pink' },
  { hex: '#dcbeff', name: 'Lavender' },
];
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

// Quality threshold from environment or default
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || REPAIR_DEFAULTS.scoreThreshold;

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
 * Run P1 Visual Inventory — honest figure/age detection without seeing the original prompt.
 * Returns parsed inventory data or null on failure. No scoring, no P2 follow-up.
 * @param {Array} parts - Image + reference image parts (no text prompt)
 * @param {string} modelId - Gemini model to use
 * @param {string} apiKey - Gemini API key
 * @param {string} pageContext - Page context for logging
 * @returns {Promise<{figures: Array, matches: Array, objectMatches: Array, rendering: Object, inputTokens: number, outputTokens: number}|null>}
 */
async function runVisualInventory(parts, modelId, apiKey, pageContext) {
  try {
    const inventoryParts = [...parts];
    inventoryParts.push({ text: PROMPT_TEMPLATES.imageVisualInventory });

    // Route to Grok vision API for xAI models
    const modelConfig = TEXT_MODELS[modelId];
    let p1Response;
    if (modelConfig?.provider === 'xai') {
      p1Response = await callGrokVisionAPI(modelId, modelConfig.modelId || modelId, inventoryParts, PROMPT_TEMPLATES.imageVisualInventory);
    } else {
      p1Response = await withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: inventoryParts }],
            // Same rationale as the quality-eval budget bump — inventory (P1)
            // stage emits detailed per-figure JSON that can run long on
            // multi-character scenes.
            generationConfig: { maxOutputTokens: 32000, temperature: 0.3 },
            safetySettings: GEMINI_SAFETY_SETTINGS
          })
        });
      }, { maxRetries: 2, baseDelay: 2000 });
    }

    if (!p1Response.ok) {
      const errText = await p1Response.text();
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️ [QUALITY P1] ${pageLabel}API error: ${errText.substring(0, 200)}`);
      // Persistent HTTP failure (after withRetry already burned its 2 retries).
      // Fall back to Grok vision so a transient Gemini outage doesn't degrade
      // the page's eval. Same fallback path as the safety-block branch below.
      if (modelConfig?.provider !== 'xai') {
        const grokFallbackId = 'grok-4-fast';
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId}) after HTTP error...`);
          try {
            const grokResp = await callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, PROMPT_TEMPLATES.imageVisualInventory);
            if (grokResp.ok) {
              p1Response = grokResp;
            } else {
              return null;
            }
          } catch (grokErr) {
            log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    let p1Data = await p1Response.json();
    let inputTokens = p1Data.usageMetadata?.promptTokenCount || 0;
    let outputTokens = p1Data.usageMetadata?.candidatesTokenCount || 0;
    const thinkingTokens = p1Data.usageMetadata?.thoughtsTokenCount || 0;

    const p1Blocked = p1Data.promptFeedback?.blockReason ||
      !p1Data.candidates || p1Data.candidates.length === 0 ||
      p1Data.candidates[0]?.finishReason === 'SAFETY' ||
      p1Data.candidates[0]?.finishReason === 'PROHIBITED_CONTENT';

    if (p1Blocked) {
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️ [QUALITY P1] ${pageLabel}Content blocked by Gemini safety`);
      // Fall back to Grok vision if we weren't already using xAI
      if (modelConfig?.provider !== 'xai') {
        const grokFallbackId = 'grok-4-fast';
        const grokFallbackModel = TEXT_MODELS[grokFallbackId];
        if (grokFallbackModel?.provider === 'xai') {
          log.info(`🔄 [QUALITY P1] ${pageLabel}Falling back to Grok vision (${grokFallbackId})...`);
          try {
            const grokResp = await callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, inventoryParts, PROMPT_TEMPLATES.imageVisualInventory);
            if (grokResp.ok) {
              p1Data = await grokResp.json();
              inputTokens = p1Data.usageMetadata?.promptTokenCount || 0;
              outputTokens = p1Data.usageMetadata?.candidatesTokenCount || 0;
              if (p1Data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                log.info(`✅ [QUALITY P1] ${pageLabel}Grok fallback succeeded`);
              } else {
                log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback returned no text`);
                return null;
              }
            } else {
              return null;
            }
          } catch (grokErr) {
            log.warn(`⚠️ [QUALITY P1] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
            return null;
          }
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    const p1Text = p1Data.candidates[0]?.content?.parts?.[0]?.text?.trim();
    if (!p1Text) {
      log.warn(`⚠️ [QUALITY P1] No text response`);
      return null;
    }

    let inventoryJson;
    try {
      inventoryJson = getStoryHelpers().extractJsonFromText(p1Text);
    } catch (e) {
      log.warn(`⚠️ [QUALITY P1] JSON parse failed`);
      return null;
    }
    if (!inventoryJson) {
      log.warn(`⚠️ [QUALITY P1] No JSON in response`);
      return null;
    }

    const thinkingInfo = thinkingTokens > 0 ? `, thinking: ${thinkingTokens.toLocaleString()}` : '';
    log.verbose(`📊 [EVAL P1] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${thinkingInfo}`);

    const figures = inventoryJson.figures || [];
    const matches = inventoryJson.matches || [];
    if (figures.length > 0) {
      log.info(`📊 [EVAL P1] Figures: ${figures.map(f => `#${f.id} ${f.hair} (${f.position})`).join('; ')}`);
    }
    if (matches.length > 0) {
      log.info(`📊 [EVAL P1] Matches: ${matches.map(m => `Fig ${m.figure} → ${m.reference} (${Math.round(m.confidence * 100)}%)`).join('; ')}`);
    }

    return {
      figures,
      matches,
      objectMatches: inventoryJson.object_matches || [],
      rendering: inventoryJson.rendering || {},
      inputTokens,
      outputTokens
    };
  } catch (err) {
    log.warn(`⚠️ [QUALITY P1] Figure check failed: ${err.message}`);
    return null;
  }
}

/**
 * Validate an empty scene (background-only) image.
 * Two-phase check:
 * Phase 1 (pixel): calmness heatmap — white boxes, too dark, text area readiness (<50ms, free)
 * Phase 2 (vision): Gemini Flash-lite — people/figures, landmark accuracy, content issues (~2s, cheap)
 *
 * @param {string} imageData - base64 data URI
 * @param {string} textPosition - e.g. 'top-right'
 * @param {string} pageContext - logging context
 * @param {object} [options]
 * @param {string} [options.sceneDescription] - expected scene description (for landmark check)
 * @param {boolean} [options.skipVision=false] - skip the Gemini vision check (pixel only)
 * @returns {{ pass: boolean, issues: string[], calmnessScore: number, visionFeedback: string|null }}
 */
async function validateEmptyScene(imageData, textPosition, pageContext = '', options = {}) {
  const { sceneDescription = null, skipVision = false, characterPlacements = null, mainScenePrompt = null, storyEra = null } = options;
  try {
    const base64 = r2Lib.stripDataUriPrefix(imageData);
    const buf = Buffer.from(base64, 'base64');
    const { data: pixels, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    const BLOCK = 16;
    const rows = Math.floor(height / BLOCK);
    const cols = Math.floor(width / BLOCK);
    if (rows < 4 || cols < 4) return { pass: true, issues: [], calmnessScore: 0.5 };

    // Compute per-block brightness and variance
    const blockBrightness = new Float32Array(rows * cols);
    const blockVariance = new Float32Array(rows * cols);
    let totalBrightness = 0;
    let vMax = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0, sumSq = 0;
        const count = BLOCK * BLOCK;
        for (let by = 0; by < BLOCK; by++) {
          const off = (r * BLOCK + by) * width;
          for (let bx = 0; bx < BLOCK; bx++) {
            const val = pixels[off + c * BLOCK + bx];
            sum += val;
            sumSq += val * val;
          }
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        blockBrightness[r * cols + c] = mean;
        blockVariance[r * cols + c] = std;
        totalBrightness += mean;
        if (std > vMax) vMax = std;
      }
    }

    const avgBrightness = totalBrightness / (rows * cols) / 255;
    if (vMax === 0) vMax = 1;

    const issues = [];

    // Check 1: uniform-patch artifact detection — a flat white OR a flat
    // black rectangle is an AI glitch regardless of the expected tone. Flag
    // either if it exceeds the artifact threshold.
    let whiteBoxBlocks = 0;
    let blackBoxBlocks = 0;
    for (let i = 0; i < rows * cols; i++) {
      if (blockBrightness[i] > 240 && blockVariance[i] < 5) whiteBoxBlocks++;
      if (blockBrightness[i] < 15 && blockVariance[i] < 5) blackBoxBlocks++;
    }
    const whiteBoxPct = whiteBoxBlocks / (rows * cols);
    const blackBoxPct = blackBoxBlocks / (rows * cols);
    if (whiteBoxPct > 0.08) {
      issues.push(`white box artifact: ${(whiteBoxPct * 100).toFixed(0)}% of image is uniform white`);
    }
    if (blackBoxPct > 0.08) {
      issues.push(`black box artifact: ${(blackBoxPct * 100).toFixed(0)}% of image is uniform black`);
    }

    // Check 2: overall too dark — darker scenes are now expected (white text on
    // dark backdrop), so the floor drops to 8%. Below that the frame is blank
    // or broken, not an artistic choice.
    if (avgBrightness < 0.08) {
      issues.push(`too dark: average brightness ${(avgBrightness * 100).toFixed(0)}%`);
    }

    // Check 3: text area calmness — smooth (low-variance) zone for text placement.
    // Previously this also rewarded darkness, but the prompt/text-overlay design
    // no longer requires a dark zone — the white-wash composited at render time
    // handles contrast. Pure smoothness is what matters: a bright clear sky or
    // a saturated flat wall are both fine, as long as they're not cluttered.
    let textAreaCalm = 0;
    let textAreaCount = 0;
    const isTop = textPosition?.startsWith('top');
    const isLeft = textPosition?.includes('left') || textPosition?.includes('full');
    const isFull = textPosition?.includes('full');

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const inVertical = isTop ? r < rows * 0.4 : r > rows * 0.6;
        const inHorizontal = isFull || (isLeft ? c < cols * 0.6 : c > cols * 0.4);
        if (inVertical && inHorizontal) {
          const vNorm = blockVariance[r * cols + c] / vMax;
          textAreaCalm += (1 - vNorm);
          textAreaCount++;
        }
      }
    }
    const calmnessScore = textAreaCount > 0 ? textAreaCalm / textAreaCount : 0;

    // 0.55 threshold tuned for pure-smoothness scoring — a cluttered zone with
    // edges/detail lands ~0.3-0.5, a calm surface ~0.6-0.9. (Previous 0.15
    // threshold was for the dark-rewarding formula and is too lax here.)
    if (calmnessScore < 0.55 && textPosition) {
      issues.push(`text area too busy: calmness ${(calmnessScore * 100).toFixed(0)}% at ${textPosition}`);
    }

    // ── Phase 2: Gemini Flash-lite vision check ──
    // Catches things pixels can't: people/figures, wrong landmark, content errors.
    let visionFeedback = null;
    if (!skipVision && issues.length === 0) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
          const base64ForVision = r2Lib.stripDataUriPrefix(imageData);
          const mimeType = imageData.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

          const sceneCtx = sceneDescription
            ? `\nEXPECTED SCENE: "${sceneDescription.substring(0, 300)}"`
            : '';
          // Era context — explicit period so the vision model doesn't have to
          // infer it. Caller derives this from storyType + costumed clothing.
          // "present-day" (or null) disables the anachronism check.
          const eraBlock = storyEra
            ? `\n\nSTORY ERA: ${storyEra} — render accordingly. Landmark reference photos are present-day; any modern elements visible in the photo must NOT appear in the output.`
            : '';
          // If the outline already declared where each character will land, ask
          // the vision model to verify the empty scene has flat usable space at
          // each of those spots — not blocked by walls, props, or scene edges.
          const placementsBlock = Array.isArray(characterPlacements) && characterPlacements.length > 0
            ? `\n\nCHARACTER PLACEMENTS TO BE COMPOSITED LATER:\n${characterPlacements.map(p => `- ${p.name || 'character'} at ${p.position || 'unspecified'}${p.depth ? ` (depth: ${p.depth})` : ''}`).join('\n')}`
            : '';
          const placementsCheck = placementsBlock
            ? `\n4. Given the character placements above, does the empty scene have open, flat, usable ground at EACH of those frame positions? FAIL if a character position (e.g. "far-left background") maps to a frame region that is blocked by a wall, a building facade, a large prop, or the very edge of a receding corridor. Name the blocked position in the issue.`
            : '';
          // Composition geometry fidelity — the main scene will composite characters,
          // aim lines, and distant targets onto this empty scene. If the path
          // direction, vanishing point, or reserved distant-target spot in the
          // empty scene doesn't match what the main scene prose describes, the
          // composite will be broken (e.g. character aims toward a target corner
          // where the empty scene has a wall instead of an opening).
          const mainSceneBlock = mainScenePrompt
            ? `\n\nMAIN SCENE PROSE (what will be composited onto this empty scene):\n"${mainScenePrompt.substring(0, 800)}"`
            : '';
          const geometryCheck = mainScenePrompt
            ? `\n5. Composition geometry — does this empty scene support the main scene's geometry? Check:
   a. Any path, river, road, corridor, shoreline, horizon, or major perspective line — does it run in the same direction the main scene prose describes (e.g. "stretches to the right background", "diagonal from lower-left to upper-right")?
   b. Vanishing point / opening location — is it at the frame position the main scene implies (e.g. main scene says "sliver of light at far right background" → empty scene must have that opening/light at the upper-right, not centered or on the left)?
   c. Reserved open space for distant composited targets — if the main scene places a "tiny figure" or small object at a specific corner, the empty scene must have open, uncluttered sky/ground/path there, not a wall or tree trunk.
   d. Lighting direction — consistent with the main scene's time of day and declared light source.
   FAIL with a specific fix instruction if any of (a)–(d) disagree. The issue description must name WHAT geometry is wrong AND the corrected direction/position. Example: "path runs front-to-center instead of diagonally to the upper-right; regenerate with the path angled toward the upper-right corner where the target will be composited".`
            : '';

          const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
          const visionResp = await fetch(visionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: mimeType, data: base64ForVision } },
                { text: `This is a background scene for a children's book illustration. Small background figures, animals, and distant people are fine — they add life to the scene.${sceneCtx}${eraBlock}${placementsBlock}${mainSceneBlock}

Check:
- Setting / location: does it roughly match the expected scene? (FAIL if completely wrong location — e.g. expected a forest but got a city)
- Naturalness: does the image look like a natural, plausible illustration of the scene? Or are there strange artefacts, geometry that doesn't make sense, doubled props, melted shapes, surfaces that change material mid-stroke, perspective lines that contradict each other, or anything that looks "off" for a competent painter? (FAIL — describe what looks unnatural)
- Geometric artefact patches: are there large artificial-looking patches — white or near-white **rectangles, triangles, diagonals, wedges, or any solid geometric shape**, monochrome panels, blank patches, or obvious AI glitches that cover a meaningful portion of the frame? Pay special attention to bright triangular or diagonal cutouts that don't belong to the scene's geometry. (FAIL — name the shape and where it is)
- Foreground space: is there visible open space in the foreground where main characters could be placed later? (FAIL if the entire foreground is filled with objects or walls)
- Unrequested text or signage: does the image contain readable text, letters, numbers, shop signs, banners, posters, logos, labels, or written inscriptions that are NOT named in the expected scene? (FAIL — name where the text appears. A pub sign, street sign, poster text, or any inscription not explicitly requested counts. Distant painted banners with no readable text are OK.)${storyEra ? `
- Anachronistic elements for the stated STORY ERA above: are there objects that don't fit the period? (FAIL — name them. Cars, parked vehicles, modern street lights, traffic signs, billboards, power lines, utility poles, satellite dishes, air conditioners, modern shopfront windows with price stickers, commercial ads, plastic bins, painted crosswalks, road markings, telephone poles, fire hydrants. Skip this check only if the story era is "present-day" or "modern".)` : ''}${placementsCheck}${geometryCheck}

Reply JSON only: {"pass": true/false, "issues": ["short issue"], "feedback": "one sentence naming WHAT to remove or fix — e.g. 'remove the pub sign at upper-left and the parked car at lower-right'. Be specific enough that a regeneration prompt can target the named elements."}` }
              ]}],
              generationConfig: { maxOutputTokens: 350, temperature: 0.1, responseMimeType: 'application/json' },
              safetySettings: GEMINI_SAFETY_SETTINGS
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (visionResp.ok) {
            const visionData = await visionResp.json();
            const visionText = visionData.candidates?.[0]?.content?.parts?.[0]?.text || '';
            try {
              const visionResult = JSON.parse(visionText);
              if (visionResult.pass === false) {
                issues.push(...(visionResult.issues || ['vision check failed']));
                visionFeedback = visionResult.feedback || null;
                log.warn(`❌ [EMPTY-SCENE-QC] ${pageContext} Vision FAILED: ${(visionResult.issues || []).join(', ')}${visionFeedback ? ` — fix: ${visionFeedback}` : ''}`);
              } else {
                log.debug(`✅ [EMPTY-SCENE-QC] ${pageContext} Vision passed`);
              }
            } catch {
              // Unparseable — check for keywords
              if (visionText.toLowerCase().includes('"pass": false') || visionText.toLowerCase().includes('"pass":false')) {
                issues.push('vision check failed (unparseable)');
                visionFeedback = visionText.substring(0, 200);
              }
            }
          }
        }
      } catch (visionErr) {
        log.debug(`⚠️ [EMPTY-SCENE-QC] ${pageContext} Vision check skipped: ${visionErr.message}`);
      }
    }

    const pass = issues.length === 0;
    if (!pass) {
      log.warn(`❌ [EMPTY-SCENE-QC] ${pageContext} FAILED (calmness ${(calmnessScore * 100).toFixed(0)}%): ${issues.join(', ')}`);
    } else {
      log.debug(`✅ [EMPTY-SCENE-QC] ${pageContext} passed (brightness ${(avgBrightness * 100).toFixed(0)}%, text calmness ${(calmnessScore * 100).toFixed(0)}%, white ${(whiteBoxPct * 100).toFixed(0)}%, black ${(blackBoxPct * 100).toFixed(0)}%)`);
    }

    return { pass, issues, calmnessScore, visionFeedback };
  } catch (err) {
    log.warn(`⚠️ [EMPTY-SCENE-QC] ${pageContext} Error: ${err.message} — skipping check`);
    return { pass: true, issues: [], calmnessScore: 0.5, visionFeedback: null };
  }
}

/**
 * Never-CRITICAL gate for the compliance stage's identity-absence findings
 * (docs/decisions.md + models.js "presence-is-input + never-CRITICAL"): the
 * compliance judge never sees the image — a "missing / not identified"
 * character finding from it is an INFERENCE from the identification input
 * (QUALITY_FIGURES.matches[]), not an observed image defect. When the
 * identification stage produced an empty or incomplete matches[] (e.g. no
 * usable reference photos), every named character looks "missing" and each
 * CRITICAL costs 30 pts in the merged recompute → a good cover/page tanks and
 * loops through repair forever, because the repaired image re-evals through
 * the same broken input. The image-seeing quality eval still owns true
 * missing-character CRITICALs, so capping the blind judge at MAJOR loses no
 * real detection power. Enforced in CODE (not only in the prompt) so a model
 * that disobeys its own contract cannot re-open the loop.
 *
 * Mutates severity in place; stamps `severityCapped` for the dev panel.
 * @param {Array<{description: string, severity: string, type: string}>} issues
 * @returns {Array} the same array (for chaining)
 */
function capComplianceIdentitySeverity(issues) {
  if (!Array.isArray(issues)) return issues;
  // Self-contained (no module-scope deps) so unit tests can vm-extract it.
  const identityAbsenceRe = /\bnot identified\b|\bunidentified\b|matches\s*\[\s*\]|\bno (?:entry|match(?:es)?) in\b|\babsent from (?:the )?match/i;
  for (const issue of issues) {
    if (!issue || typeof issue !== 'object') continue;
    const sev = String(issue.severity || '').toUpperCase();
    if (sev !== 'CRITICAL' && sev !== 'CATASTROPHIC') continue;
    const isIdentityAbsence = issue.type === 'missing_character'
      || identityAbsenceRe.test(String(issue.description || ''));
    if (isIdentityAbsence) {
      issue.severity = 'MAJOR';
      issue.severityCapped = 'identity-input'; // eval-input deficiency, not an observed defect
    }
  }
  return issues;
}

/**
 * Three-stage image evaluation: vision inventory (flash-lite) + prompt compliance (Haiku).
 * Stage 1 describes the image without seeing the prompt (unbiased).
 * Stage 2 compares the vision inventory against the original prompt (text-only, no image).
 * Returns a compliance score (0-100) and fixable issues, or null on failure.
 *
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} imagePrompt - The prompt used to generate the image
 * @param {string|null} sceneHint - Original scene description (may contain interaction metadata)
 * @param {Object} options
 * @param {string|null} options.qualityModelOverride - Override model for Stage 1 vision
 * @param {string} options.pageContext - Page context for logging (e.g., "PAGE 5")
 * @returns {Promise<Object|null>} Three-stage result or null on failure
 */
async function evaluateThreeStage(imageData, imagePrompt, sceneHint, options = {}) {
  const {
    qualityModelOverride = null,
    pageContext = '',
    storyText = null,
    qualityFiguresPromise = null,
    complianceModelOverride = null,   // Stage-2 model A/B (default evalModel = qwen-plus)
    compliancePromptOverride = null,  // Stage-2 template A/B
    artStyle = null,                  // resolved style — same value the quality eval gets
    clothingContract = null,          // per-character outfit block — same value the quality eval gets
  } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  const visionPrompt = PROMPT_TEMPLATES.imageVisionInventory;
  const complianceTemplate = compliancePromptOverride || PROMPT_TEMPLATES.imagePromptCompliance;

  if (!visionPrompt || !complianceTemplate) {
    log.warn(`[THREE-STAGE] ${pageLabel}Templates not loaded, skipping`);
    return null;
  }

  // Extract interactions from sceneHint for Stage 2
  let interactionsBlock = '(none declared)';
  try {
    const { extractSceneMetadata } = getStoryHelpers();
    const meta = extractSceneMetadata(sceneHint || imagePrompt);
    const interactions = meta?.interactions
      || (Array.isArray(meta?.fullData?.interactions) ? meta.fullData.interactions : null);
    if (interactions && interactions.length > 0) {
      interactionsBlock = interactions
        .map(i => `- ${i.character || '?'} + ${i.object || '?'}: ${i.where || '(no placement given)'}`)
        .join('\n');
    }
  } catch { /* silent */ }

  // --- Stage 1: Vision inventory with flash-lite (WITH image, no prompt) ---
  let visionText = null;
  let stage1Usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const visionModel = qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash-lite';
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn(`[THREE-STAGE] ${pageLabel}No Gemini API key, skipping`);
      return null;
    }

    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

    const parts = [
      { inline_data: { mime_type: mimeType, data: base64Data } },
      { text: visionPrompt }
    ];

    // Route to Grok vision for xAI models
    const modelConfig = TEXT_MODELS[visionModel];
    let response;
    if (modelConfig?.provider === 'xai') {
      response = await callGrokVisionAPI(visionModel, modelConfig.modelId || visionModel, parts, visionPrompt);
    } else {
      response = await withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            // Stage 1 is the blind image description every downstream compliance
            // finding is derived from — if it varies, the findings vary no matter
            // how deterministic the judges are. Pinned with the rest of them.
            generationConfig: { maxOutputTokens: 4096, temperature: EVAL_TEMPERATURE },
            safetySettings: GEMINI_SAFETY_SETTINGS
          }),
          // No timeout here froze jobs mid-eval (stuck-at-51% incident,
          // 2026-07-07); abort feeds withRetry, then the eval is skipped.
          signal: AbortSignal.timeout(120000)
        });
        // Throw on 5xx so withRetry can retry with backoff
        if (resp.status >= 500) {
          const err = new Error(`Gemini ${resp.status}`);
          err.status = resp.status;
          throw err;
        }
        return resp;
      }, { maxRetries: 3, baseDelay: 2000 });
    }

    if (!response.ok) {
      const errText = await response.text();
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 1 API error: ${errText.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();
    stage1Usage = {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0
    };

    if (isBlockedResponse(data)) {
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 1 blocked by safety filter`);
      return null;
    }

    visionText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!visionText) {
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 1 returned no text`);
      return null;
    }

    log.info(`[THREE-STAGE] ${pageLabel}Stage 1 vision inventory: ${visionText.length} chars`);
  } catch (err) {
    log.warn(`[THREE-STAGE] ${pageLabel}Stage 1 failed: ${err.message}`);
    return null;
  }

  // --- Stage 2: Prompt compliance with Sonnet (text only, NO image) ---
  let complianceResult = null;
  let stage2Usage = { input_tokens: 0, output_tokens: 0 };
  try {
    // If quality eval is producing its own figures[] + matches[], wait for those
    // so Stage 2 can pair named figures (quality) with independent descriptions (vision)
    // using the shared 9-zone vocabulary. If quality eval isn't running or fails,
    // pass an empty block and Stage 2 falls back to vision-only reasoning.
    let qualityFiguresBlock = '(not available)';
    if (qualityFiguresPromise) {
      try {
        const qf = await qualityFiguresPromise;
        if (qf && (qf.figures?.length || qf.matches?.length)) {
          qualityFiguresBlock = JSON.stringify({
            figures: qf.figures || [],
            matches: qf.matches || [],
          }, null, 2);
        }
      } catch (e) {
        log.debug(`[THREE-STAGE] ${pageLabel}quality figures unavailable: ${e.message}`);
      }
    }

    const complianceInput = fillTemplate(complianceTemplate, {
      ORIGINAL_PROMPT: (imagePrompt || '').substring(0, 3000),
      // Passed separately: ORIGINAL_PROMPT is truncated at 3000 chars and the
      // ART STYLE and CLOTHING blocks can sit past the cut, so the compliance
      // judge never saw them and treated required style/costume elements as
      // unrequested additions (a steampunk cover's goggles drew a CRITICAL).
      ART_STYLE: artStyle || require('../services/prompts').extractArtStyle(imagePrompt),
      CLOTHING_CONTRACT: clothingContract || '',
      VISUAL_INVENTORY: visionText,
      QUALITY_FIGURES: qualityFiguresBlock,
      INTERACTIONS_BLOCK: interactionsBlock,
      STORY_TEXT: (storyText || '(not provided)').substring(0, 2000)
    });

    const { callTextModel } = require('./textModels');
    // Stage 2 was Sonnet — Haiku didn't reliably follow the "ignore prose
    // decoration unless it's a DECLARED INTERACTION" rule and kept flagging
    // false-positive gaze/facing issues that drove pointless repair rounds.
    // Now configurable (resolveEvalModel, key-guarded to sonnet). NOTE: this is
    // quality-critical and NOT yet A/B-validated on Qwen — watch repair churn.
    const complianceModel = complianceModelOverride || require('../config/models').resolveComplianceModel();
    const sonnetResult = await callTextModel(complianceInput, 8192, complianceModel, { usageLabel: 'semantic_compliance', temperature: EVAL_TEMPERATURE });

    stage2Usage = {
      input_tokens: sonnetResult.usage?.input_tokens || 0,
      output_tokens: sonnetResult.usage?.output_tokens || 0
    };

    // Parse JSON from compliance response
    const parsed = getStoryHelpers().extractJsonFromText(sonnetResult.text);
    // Gate on the STRUCTURE, not on a score — the prompt no longer returns
    // one. Keying this on parsed.score would make every three-stage eval
    // return null the moment the score field was dropped.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      complianceResult = parsed;
    } else {
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 could not parse JSON from Sonnet response`);
      return null;
    }

    log.info(`[THREE-STAGE] ${pageLabel}Stage 2 compliance: ${(complianceResult.fixable_issues || []).length} finding(s), verdict=${complianceResult.verdict || 'N/A'}`);
  } catch (err) {
    log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 failed: ${err.message}`);
    return null;
  }

  // Parse fixable issues from compliance result. Tag with `source: 'three-stage'`
  // so downstream UI can group them separately from the main quality eval — the
  // two evaluators run independently and Sonnet's compliance check often finds
  // different defects than Gemini's quality eval.
  let fixableIssues = [];
  if (Array.isArray(complianceResult.fixable_issues)) {
    fixableIssues = complianceResult.fixable_issues
      .filter(i => i.description)
      .map(i => ({
        description: i.description,
        severity: i.severity || 'MODERATE',
        type: i.type || 'default',
        fix: i.fix || `Fix: ${i.description}`,
        source: 'three-stage'
      }));
    // Never-CRITICAL gate on identity-absence findings (see helper above):
    // presence is an INPUT to this blind judge, never its judgment.
    capComplianceIdentitySeverity(fixableIssues);
  }

  // THE SCORE IS THE DEFECTS (owner, 2026-08-08). Same 0-10 rubric as the
  // visual and semantic evaluators, so all three subscores stay comparable.
  const COMPLIANCE_SEVERITY_PENALTY = { CATASTROPHIC: 5, CRITICAL: 3, MAJOR: 2, MODERATE: 1, MINOR: 0.5 };
  const compliancePenalty = fixableIssues.reduce(
    (sum, i) => sum + (COMPLIANCE_SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
    0
  );
  const score100 = Math.max(0, Math.min(10, 10 - compliancePenalty)) * 10;

  // Issues summary
  let issuesSummary = complianceResult.issues_summary || '';
  if (Array.isArray(issuesSummary)) {
    issuesSummary = issuesSummary.join('. ');
  }

  return {
    score: score100,
    verdict: complianceResult.verdict || 'UNKNOWN',
    issuesSummary,
    fixableIssues,
    visionInventory: visionText,
    complianceResult,
    usage: {
      threeStage_input_tokens: stage1Usage.input_tokens + stage2Usage.input_tokens,
      threeStage_output_tokens: stage1Usage.output_tokens + stage2Usage.output_tokens,
      stage1_input_tokens: stage1Usage.input_tokens,
      stage1_output_tokens: stage1Usage.output_tokens,
      stage2_input_tokens: stage2Usage.input_tokens,
      stage2_output_tokens: stage2Usage.output_tokens
    }
  };
}

/**
 * Evaluate image quality using Gemini API (visual quality + optional semantic fidelity)
 * Sends the image to Gemini for quality assessment, with parallel semantic check when storyText provided
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} originalPrompt - The prompt used to generate the image
 * @param {string[]} referenceImages - Reference images used for generation
 * @param {string} evaluationType - Type of evaluation: 'scene' (default) or 'cover' (text-focused)
 * @param {string|null} qualityModelOverride - Override model for quality evaluation
 * @param {string} pageContext - Page context for logging (e.g., "PAGE 5")
 * @param {string|null} storyText - Optional story text for semantic fidelity check (runs in parallel)
 * @param {string|null} sceneHint - Direct statement of what image should show (for semantic eval)
 * @returns {Promise<Object>} Quality result with score, reasoning, semantic issues, etc.
 */

// Unified sanitizer for Gemini safety filters.
// 'light' — strip age numbers, "young boy" → "character", body builds. Keeps standalone "boy"/"girl".
// 'full'  — everything from light PLUS all standalone gender/age nouns → "figure".
function sanitizeForGemini(text, level = 'light') {
  if (!text || typeof text !== 'string') return text;
  let result = text
    // "8-year-old boy" → "character" (light) or "figure" (full) — catch compound first
    .replace(/\b\d+[-\s]?years?[-\s]?old\s+(boy|girl|child|kid|man|woman)\b/gi, level === 'full' ? 'figure' : 'character')
    // Standalone "7-year-old" → ""
    .replace(/\b\d+[-\s]?years?[-\s]?old\b/gi, '')
    // "young boy", "little girl" → "character"/"figure"
    .replace(/\b(young|little|small|tiny)\s+(child|boy|girl|kid|man|woman)\b/gi, level === 'full' ? 'figure' : 'character')
    // "aged 5" → ""
    .replace(/\bage[sd]?\s*\d+\b/gi, '')
    // "slim build" → ""
    .replace(/\b(slim|thin|chubby|petite|small-framed|athletic)\s+(body|build|figure)\b/gi, '');

  if (level === 'full') {
    result = result
      .replace(/\b(boy|girl|child|kid|man|woman|teenager|teen|adult|elderly|toddler|infant|baby)\b/gi, 'figure')
      .replace(/\b(male|female)\s+figure\b/gi, 'figure');
  }

  return result.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
}

// Helper function to check if a Gemini response indicates blocked content
const isBlockedResponse = (responseData) => {
  // Check promptFeedback for block reason
  if (responseData.promptFeedback?.blockReason) {
    return true;
  }
  // Check if no candidates due to safety
  if (!responseData.candidates || responseData.candidates.length === 0) {
    return true;
  }
  // Check candidate-level blocking
  const finishReason = responseData.candidates[0]?.finishReason;
  if (finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
    return true;
  }
  return false;
};

async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null, pageContext = '', storyText = null, sceneHint = null, sceneCharacters = null, evalOptions = {}) {
  // evalOptions.evalTemplateOverride / .semanticTemplateOverride: Test Lab A/B
  // variants — full replacement template strings used instead of the loaded
  // files for THIS call only (PROMPT_TEMPLATES is never mutated).
  // Hoisted outside try so the catch/finally below can reference them.
  // `let` is block-scoped to the try body — without these declarations here,
  // the finally's `if (qualityFiguresResolve)` throws ReferenceError on every
  // call, taking down all 10 page evaluations + cover gen with it.
  let semanticPromise = null;
  let threeStagePromise = null;
  let qualityFiguresPromise = null;
  let qualityFiguresResolve = null;
  let p1Promise = null;
  try {
    // Guard against undefined/invalid imageData
    if (!imageData || typeof imageData !== 'string') {
      log.warn(`⚠️ [QUALITY] Invalid imageData passed to evaluateImageQuality: ${typeof imageData}`);
      return null;
    }

    // Strip scene description to relevant parts (remove Art Director checks, corrections, preview mismatches)
    // This reduces prompt size significantly and focuses the model on actual scene content
    if (originalPrompt && (originalPrompt.includes('"previewMismatches"') || originalPrompt.includes('"checks"'))) {
      const { stripSceneMetadata } = getStoryHelpers();
      const stripped = stripSceneMetadata(originalPrompt);
      if (stripped && stripped !== originalPrompt) {
        log.debug(`✂️ [QUALITY] ${pageContext} Stripped scene description: ${originalPrompt.length} → ${stripped.length} chars`);
        originalPrompt = stripped;
      }
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      log.verbose('⚠️  [QUALITY] Gemini API key not configured, skipping quality evaluation');
      return null;
    }

    // Covers get the SAME fidelity checks as pages (semantic, three-stage,
    // visual inventory) — they are not exempt. A page's reference is its story
    // prose; a cover has none, so its reference is the cover brief, which
    // arrives as sceneHint (scene.outlineExtract). Comparing the cover against
    // its own brief catches wrong placement ("characters standing in the
    // river"), wrong/extra objects, and missing figures. The title/dedication
    // text is the only cover-specific concern, handled by the TEXT RULES below.
    const isCover = evaluationType === 'cover';
    // Covers are head-on portraits: viewer-gaze and a flat 2D title are correct,
    // not defects. Tell the fidelity evaluators so they don't penalize those,
    // while still catching placement / text / identity problems.
    const coverEvalNote = '\n\nCOVER: a book-cover portrait. Characters facing or looking at the viewer is intended — do not deduct for gaze direction or for facing the camera. A flat 2D title is acceptable — do not deduct for the title not being three-dimensional. Still flag implausible placement (a figure on a surface that cannot support it), wrong or garbled text on objects, and missing, extra, or mismatched characters.';
    const fidelityRef = storyText || (isCover && sceneHint ? sceneHint + coverEvalNote : null);
    const runFidelity = !!fidelityRef && (evaluationType === 'scene' || isCover);

    // Art style + clothing contract are inputs to EVERY evaluator (quality,
    // semantic, compliance) — built once, up front, before the parallel evals
    // start. A contract that only some evaluators see is how a steampunk
    // cover's commissioned costume got repair-stripped as "unrequested attire".
    // evalOptions.artStyle lets a caller supply the style when originalPrompt is
    // not the full page prompt (Test Lab passes the scene description).
    const artStyleForEval = evalOptions.artStyle
      || require('../services/prompts').extractArtStyle(originalPrompt);
    // Two sources, one block. The reference photos already carry the resolved
    // per-page outfit (`clothingDescription`, set by the prompt builder) and
    // that is what every call site has in scope; evalOptions.clothingRequirements
    // is the explicit override for callers that resolved it themselves.
    let clothingContractBlock = '';
    try {
      const lines = [];
      const reqs = evalOptions.clothingRequirements || null;
      if (reqs) {
        const { buildClothingDescription } = require('./entityConsistency');
        for (const c of (sceneCharacters || [])) {
          if (!c?.name) continue;
          const category = reqs[c.name]?._currentClothing;
          if (!category) continue;
          const outfit = buildClothingDescription(c, category, artStyleForEval, reqs);
          if (outfit && String(outfit).trim()) lines.push(`- ${c.name}: ${String(outfit).trim()}`);
        }
      }
      if (lines.length === 0) {
        for (const p of (referenceImages || [])) {
          if (p?.name && p?.clothingDescription) lines.push(`- ${p.name}: ${String(p.clothingDescription).trim()}`);
        }
      }
      clothingContractBlock = lines.join('\n');
      if (!clothingContractBlock && evaluationType === 'scene') {
        // Loud, because an empty contract is what let the judge invent one.
        log.warn(`👕 [EVAL] ${pageContext || 'page'}: no clothing contract available — clothing findings suppressed (N-16)`);
      }
    } catch (err) { log.debug(`[EVAL] clothing contract block skipped: ${err.message}`); }

    // Start semantic evaluation in parallel when we have a reference (page prose
    // or cover brief).
    if (runFidelity) {
      const { evaluateSemanticFidelity } = require('./sceneValidator');
      semanticPromise = evaluateSemanticFidelity(imageData, fidelityRef, originalPrompt, sceneHint, evalOptions.semanticTemplateOverride || null, {
        artStyle: artStyleForEval,
        clothingContract: clothingContractBlock,
      });
      log.debug('🔍 [QUALITY] Starting parallel semantic fidelity evaluation');
    }

    // Start three-stage eval in parallel for scene evaluations.
    // Stage 2 (compliance) needs the quality eval's named figures[] + matches[] so it
    // can pair each named character with the blind vision inventory by zone. We expose
    // those via qualityFiguresResolve, fulfilled once the quality JSON is parsed below.
    if (evaluationType === 'scene' || isCover) {
      qualityFiguresPromise = new Promise((resolve) => { qualityFiguresResolve = resolve; });
      threeStagePromise = evaluateThreeStage(imageData, originalPrompt, sceneHint, {
        qualityModelOverride,
        pageContext,
        storyText: fidelityRef,
        qualityFiguresPromise,
        complianceModelOverride: evalOptions.complianceModelOverride || null,
        compliancePromptOverride: evalOptions.compliancePromptOverride || null,
        artStyle: artStyleForEval,
        clothingContract: clothingContractBlock,
      });
      log.debug(`📊 [QUALITY] Starting parallel three-stage evaluation`);
    }

    // Extract base64 and mime type for generated image
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Use standard evaluation for all images (scenes + covers)
    // Covers get the expected text prepended so the evaluator checks text accuracy too
    let evaluationTemplate;
    if (evalOptions.evalTemplateOverride) {
      evaluationTemplate = evalOptions.evalTemplateOverride;
      log.verbose(`📊 [EVAL] Using OVERRIDE evaluation template (${evaluationType})`);
    } else if (PROMPT_TEMPLATES.imageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      log.verbose(`📊 [EVAL] Using standard evaluation (${evaluationType})`);
    } else {
      evaluationTemplate = null;
    }
    // O7: hash of the template that produced this score. Prompt-file edits
    // silently change what a historical score means — the hash makes each
    // stored eval traceable to its template version.
    const evalTemplateHash = evaluationTemplate
      ? require('crypto').createHash('md5').update(evaluationTemplate).digest('hex').slice(0, 8)
      : null;

    // Determine model to use (parameter override > config default > fallback)
    // let: may be reassigned to fallback model on content block
    let modelId = qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';

    // Pre-sanitize for 2.5 models to reduce content blocking on first attempt
    let promptForEval = modelId.includes('2.5') ? sanitizeForGemini(originalPrompt, 'light') : originalPrompt;
    // Resolved from the UNSTRIPPED prompt: the cover branch below deletes the
    // ART STYLE block from promptForEval as evaluator noise, which would leave
    // artStyleForEval / clothingContractBlock: built above, before the
    // parallel evals started, so all three evaluators receive them.

    // For cover evaluations: strip art style noise and prepend expected text prominently
    if (evaluationType === 'cover' && promptForEval) {
      // Expected text arrives STRUCTURED (evalOptions.expectedText / textMode)
      // from the pipeline's cover pseudo-page record. Prompt-regex extraction
      // remains as fallback for callers that evaluate against the raw
      // generation prompt (the templates say `Paint "{STORY_TITLE}" in the
      // upper third` etc.) — without the Paint pattern a misspelled painted
      // title ("gelhen") once sailed through at score 85.
      const textMode = evalOptions.textMode || null;
      let expectedText = evalOptions.expectedText || null;
      if (!expectedText && textMode !== 'appOverlay') {
        const titleMatch = promptForEval.match(/MUST include this exact (?:title |dedication )?text:\s*"([^"]+)"/i);
        const magicalMatch = promptForEval.match(/MUST include this exact text:\s*"(magicalstory\.ch)"/i);
        const paintMatch = promptForEval.match(/Paint\s+"([^"]+)"\s+(?:in|as)\b/i);
        expectedText = titleMatch?.[1] || magicalMatch?.[1] || paintMatch?.[1];
        if (expectedText) expectedText = expectedText.replace(/<\/?user_input>/g, '').trim();
      }

      // Strip art style description (noise for evaluator)
      promptForEval = promptForEval.replace(/\*\*ART STYLE[^*]*\*\*[^*]*(?=\*\*|$)/s, '');

      // Cover portraits: viewer-gaze and a flat title are intended, not defects.
      promptForEval = `COVER NOTE: a book-cover portrait. Do not deduct for characters facing or looking at the viewer, or for the title being flat 2D rather than three-dimensional.\n\n${promptForEval}`;

      if (textMode === 'appOverlay') {
        // Mode B: art is textless; title/dedication/branding composited by the
        // app after persistence. Was previously appended to the pseudo-page's
        // sceneDescription as string surgery (server.js pipeline entry).
        promptForEval = `TEXT NOTE: The title, dedication, and "magicalstory.ch" branding on this cover are handled by the app as a typographic overlay, not painted by the image model. Never flag missing/absent title/dedication/branding text as a defect, and if such text IS present treat it as the intended app-composited overlay — never flag it as unrequested rendered text.\n\n${promptForEval}`;
      } else if (expectedText) {
        promptForEval = `⚠️ TEXT RULES FOR THIS IMAGE:\nAllowed text: "${expectedText}" — and nothing else prominent.\nSeverities for text issues:\n- Allowed text missing or misspelled (any character difference) → severity: CATASTROPHIC.\n- Other prominent unrequested text on the cover (labels, captions, watermarks, extra words) → severity: MAJOR.\n- Small incidental in-world signage in the background → do not flag; if garbled → severity: MINOR.\nIf the only text on the image is exactly the allowed text, evaluate normally.\n\nBefore reporting a title misspelling, RE-READ the rendered text letter-by-letter against the allowed text above. Report a mismatch ONLY if you can quote the exact rendered string and it differs from the allowed text. If you are uncertain whether the rendering matches, do NOT flag it.\n\n${promptForEval}`;
      }
    }

    // Extract declared character interactions from the scene metadata.
    // Use sceneHint (original scene description with metadata block) rather than
    // originalPrompt (image prompt where metadata was already stripped).
    let interactionsBlock = '(none declared)';
    let sceneIntentBlock = '(none declared)';
    try {
      const interactionSource = sceneHint || originalPrompt;
      const sceneMeta = getStoryHelpers().extractSceneMetadata(interactionSource);
      const interactions = sceneMeta?.interactions
        || (Array.isArray(sceneMeta?.fullData?.interactions) ? sceneMeta.fullData.interactions : null);
      if (interactions && interactions.length > 0) {
        interactionsBlock = interactions
          .map(i => `- ${i.character || '?'} + ${i.object || '?'}: ${i.where || '(no placement given)'}`)
          .join('\n');
      }
      const intent = sceneMeta?.sceneIntent || sceneMeta?.fullData?.sceneIntent;
      if (intent && String(intent).trim()) sceneIntentBlock = String(intent).trim();
    } catch { /* silent — evaluator defaults to "(none declared)" */ }

    // Build expected head-to-body ratios per character (for STEP 2C proportion
    // check). Uses getHeadBodyRatio() from storyHelpers — single source of
    // truth shared with avatar generation. Age words ("child"/"toddler") are
    // never sent to Gemini, only the numeric ratios, which are safety-filter
    // neutral. Empty string when no characters or none have age set.
    let figureProportionsBlock = '';
    try {
      const { getHeadBodyRatio } = getStoryHelpers();
      const lines = [];
      for (const c of (sceneCharacters || [])) {
        if (!c?.name) continue;
        const ratio = getHeadBodyRatio(c.age);
        if (ratio) lines.push(`- ${c.name}: ${ratio}`);
      }
      if (lines.length > 0) {
        figureProportionsBlock = `EXPECTED FIGURE PROPORTIONS (standing, head-to-body):\n${lines.join('\n')}`;
      }
    } catch { /* silent — evaluator tolerates empty block */ }

    // CLOTHING CONTRACT (owner, 2026-08-08). The evaluator used to infer the
    // outfit from ORIGINAL_PROMPT alone. When the prompt carried no clothing —
    // job_1786193650012_7baiaeftb page 11 v2 had none at all, not even the word
    // "wears" — it invented one from the story's theme ("a full pirate costume
    // including red-and-white striped trousers and a black waistcoat") and
    // flagged the CORRECT wardrobe as wrong, four times, sinking the one
    // properly-dressed version of that page. Pass the resolved per-page outfit
    // as its own input so the judge compares against the contract, not against
    // its prior of what a pirate looks like. Empty when unknown — the template
    // then tells it not to judge clothing at all, which is the honest default.
    const { buildEvaluationPrompt } = require('../services/prompts');
    const evaluationPrompt = evaluationTemplate
      ? buildEvaluationPrompt({
          originalPrompt: promptForEval,
          artStyle: artStyleForEval,
          interactionsBlock,
          figureProportions: figureProportionsBlock,
          sceneIntent: sceneIntentBlock,
          clothingContract: clothingContractBlock,
          template: evalOptions.evalTemplateOverride || undefined,
        })
      : 'Evaluate this AI-generated children\'s storybook illustration on a scale of 0-100. Consider: visual appeal, clarity, artistic quality, age-appropriateness, and technical quality. Respond with ONLY a number between 0-100, nothing else.';

    // Build content array for Gemini format
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Add reference images if provided (compressed and cached for token efficiency)
    // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
    // Sources are resolved via bytesFromAnyImage: inline data: URIs (generation-time)
    // AND http(s) R2 URLs (post-save paths — stripInlineImagesFromStoryData sweeps
    // every inline byte out of stories.data, so re-evaluate / repair rounds hand
    // this function URL refs). Before this, non-data: refs were silently dropped
    // → the quality eval and P1 inventory ran with ZERO labeled reference photos
    // → matches[] came back empty → the compliance stage flagged every named
    // character as unidentified (identity CRITICALs → repair loop on covers).
    if (referenceImages && referenceImages.length > 0) {
      let addedCount = 0;
      let cacheHits = 0;
      let skippedCount = 0;
      for (const refImg of referenceImages) {
        // Handle both formats: string URL or {name, photoUrl} object
        const photoUrl = typeof refImg === 'string' ? refImg : refImg?.photoUrl;
        const charName = typeof refImg === 'object' ? refImg?.name : null;
        if (!photoUrl || typeof photoUrl !== 'string') { skippedCount++; continue; }
        try {
          // Cache key: hash of the source string (data URI payload or URL) — stable per ref
          const imageHash = hashImageData(photoUrl);
          let compressedBase64 = compressedRefCache.get(imageHash);

          if (compressedBase64) {
            cacheHits++;
          } else {
            let dataUri = photoUrl;
            if (!photoUrl.startsWith('data:image')) {
              const buf = await r2Lib.bytesFromAnyImage(photoUrl); // https / raw base64 → Buffer, null on unsupported
              if (!buf) {
                skippedCount++;
                log.warn(`⚠️ [EVAL] Reference photo${charName ? ` "${charName}"` : ''} could not be resolved to bytes (${photoUrl.substring(0, 40)}...) — skipping`);
                continue;
              }
              dataUri = `data:image/jpeg;base64,${buf.toString('base64')}`;
            }
            // Compress and cache
            const compressed = await compressImageToJPEG(dataUri, 85, 768); // 85% quality, max 768px
            compressedBase64 = r2Lib.stripDataUriPrefix(compressed);
            compressedRefCache.set(imageHash, compressedBase64);
          }

          // Add label with character name so Gemini can identify by name (not just "Reference 1")
          if (charName) {
            parts.push({ text: `Reference: ${charName}` });
          }
          parts.push({
            inline_data: {
              mime_type: 'image/jpeg',
              data: compressedBase64
            }
          });
          addedCount++;
        } catch (refErr) {
          skippedCount++;
          log.warn(`⚠️ [EVAL] Reference photo${charName ? ` "${charName}"` : ''} failed to load (${refErr.message}) — skipping`);
        }
      }
      log.verbose(`📊 [EVAL] Added ${addedCount} reference images (${cacheHits} cached, ${addedCount - cacheHits} compressed)`);
      if (skippedCount > 0) {
        log.warn(`⚠️ [EVAL] ${skippedCount}/${referenceImages.length} reference photos unusable — figure-identity matching will be degraded${addedCount === 0 ? ' (NO references: matches[] will be empty)' : ''}`);
      }
    }

    // === LAUNCH P1 VISUAL INVENTORY IN PARALLEL (age/figure detection) ===
    // Covers included — the standing-surface / implausible-placement signal that
    // catches "characters in the river" lives in this inventory pass.
    if ((evaluationType === 'scene' || isCover) && PROMPT_TEMPLATES.imageVisualInventory) {
      log.debug(`📊 [EVAL P1] Launching parallel figure/age detection for ${pageContext || 'scene'}`);
      p1Promise = runVisualInventory(parts, modelId, apiKey, pageContext);
    }

    // Add evaluation prompt text
    parts.push({ text: evaluationPrompt });

    // Log if using model override (modelId already defined at top of function)
    if (qualityModelOverride) {
      log.debug(`🔧 [QUALITY] Using model override: ${modelId}`);
    }

    // Helper function to call the API with retry for socket errors.
    // thinkingBudget caps how many of the 32k output tokens Gemini may spend on
    // hidden reasoning. Without a cap, 2.5 Flash has been observed burning the
    // entire budget on thinking (30k+) and emitting truncated JSON → MAX_TOKENS.
    const callQualityAPI = async (model, thinkingBudget = EVAL_THINKING_BUDGET) => {
      // Route to Grok vision API for xAI models
      const modelConfig = TEXT_MODELS[model];
      if (modelConfig?.provider === 'xai') {
        return callGrokVisionAPI(model, modelConfig.modelId || model, parts, evaluationPrompt);
      }
      return withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              maxOutputTokens: 32000,
              // Evaluation is a judgment task — temperature 0 minimises the
              // run-to-run severity/detection swing (same image scored 0 vs 60
              // on consecutive runs at 0.3). thinkingBudget: 0 disables the
              // hidden reasoning pass, another variance source for this
              // structured check. Both env-overridable for A/B.
              temperature: EVAL_TEMPERATURE,
              thinkingConfig: { thinkingBudget }
            },
            safetySettings: GEMINI_SAFETY_SETTINGS
          }),
          // No timeout here froze jobs mid-eval (stuck-at-51% incident,
          // 2026-07-07); abort feeds withRetry, then the eval is skipped.
          signal: AbortSignal.timeout(120000)
        });
      }, { maxRetries: 2, baseDelay: 2000 });
    };

    let response = await callQualityAPI(modelId);

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [QUALITY] Gemini API error:', error);
      return null;
    }

    let data = await response.json();

    // Extract and log token usage for quality evaluation
    const qualityInputTokens = data.usageMetadata?.promptTokenCount || 0;
    const qualityOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const qualityThinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
    if (qualityInputTokens > 0 || qualityOutputTokens > 0) {
      const thinkingInfo = qualityThinkingTokens > 0 ? `, thinking: ${qualityThinkingTokens.toLocaleString()}` : '';
      log.verbose(`📊 [EVAL] Token usage - input: ${qualityInputTokens.toLocaleString()}, output: ${qualityOutputTokens.toLocaleString()}${thinkingInfo}`);
    }

    // Blocked content: retry with full sanitization, then fall back to Grok vision.
    if (isBlockedResponse(data)) {
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      const promptBlockReason = data.promptFeedback?.blockReason || null;
      const promptSafety = data.promptFeedback?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
      const candFinish = data.candidates?.[0]?.finishReason || 'none';
      const candSafety = data.candidates?.[0]?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
      const reason = promptBlockReason || candFinish;
      log.info(`[QUALITY] ${pageLabel}Gemini safety block (${reason}), retrying with sanitization...`);
      log.debug(`[QUALITY] ${pageLabel}Safety details: prompt=[${promptSafety}], candidate=[${candSafety}]`);

      // Step 1: Retry with full sanitization (strips all gender/age nouns).
      // Go through buildEvaluationPrompt so the retry keeps the same four-block
      // contract as the primary path — a raw fillTemplate here dropped
      // SCENE_INTENT + FIGURE_PROPORTIONS, leaving the safety-retry eval blind
      // to scene intent and proportion expectations on exactly the pages a
      // safety block forced us to re-run.
      const fullSanitized = sanitizeForGemini(originalPrompt, 'full');
      const { buildEvaluationPrompt } = require('../services/prompts');
      const fullEvalPrompt = evaluationTemplate
        ? buildEvaluationPrompt({
            originalPrompt: fullSanitized,
            artStyle: artStyleForEval,
            interactionsBlock,
            figureProportions: figureProportionsBlock,
            sceneIntent: sceneIntentBlock,
            clothingContract: clothingContractBlock,
            template: evalOptions.evalTemplateOverride || undefined,
          })
        : evaluationPrompt;
      parts[parts.length - 1] = { text: fullEvalPrompt };
      try {
        const retryResponse = await callQualityAPI(modelId);
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          if (!isBlockedResponse(retryData)) {
            log.info(`✅ [QUALITY] ${pageLabel}Full sanitization retry succeeded`);
            data = retryData;
          } else {
            data = retryData; // still blocked — fall through to Grok
          }
        }
      } catch (retryErr) {
        log.warn(`⚠️ [QUALITY] ${pageLabel}Full sanitization retry failed: ${retryErr.message}`);
      }

      // Step 2: Grok vision fallback if still blocked
      if (isBlockedResponse(data)) {
        const usedModelConfig = TEXT_MODELS[modelId];
        if (usedModelConfig?.provider !== 'xai') {
          const grokFallbackId = 'grok-4-fast';
          const grokFallbackModel = TEXT_MODELS[grokFallbackId];
          if (grokFallbackModel?.provider === 'xai') {
            log.info(`🔄 [QUALITY] ${pageLabel}Still blocked, falling back to Grok vision (${grokFallbackId})...`);
            try {
              const grokResponse = await callGrokVisionAPI(grokFallbackId, grokFallbackModel.modelId || grokFallbackId, parts, fullEvalPrompt);
              if (grokResponse.ok) {
                const grokData = await grokResponse.json();
                if (grokData?.candidates?.[0]?.content?.parts?.[0]?.text) {
                  log.info(`✅ [QUALITY] ${pageLabel}Grok fallback succeeded`);
                  data = grokData;
                } else {
                  log.error(`❌ [QUALITY] ${pageLabel}Grok fallback returned no text`);
                  return null;
                }
              } else {
                log.error(`❌ [QUALITY] ${pageLabel}Grok fallback HTTP error`);
                return null;
              }
            } catch (grokErr) {
              log.error(`❌ [QUALITY] ${pageLabel}Grok fallback failed: ${grokErr.message}`);
              return null;
            }
          } else {
            return null;
          }
        } else {
          return null;
        }
      }
    }

    // Log finish reason to diagnose early stops
    let finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`⚠️  [QUALITY] Gemini finish reason: ${finishReason}`);
    }

    // MAX_TOKENS retry: thinking ate the budget → retry once with a tighter
    // thinkingBudget so the model has more room for the actual JSON output.
    // Failing fast (returning null) is preferable to silently hanging the pipeline.
    if (finishReason === 'MAX_TOKENS' && TEXT_MODELS[modelId]?.provider !== 'xai') {
      log.warn(`⚠️  [QUALITY] MAX_TOKENS — retrying once with thinkingBudget=2048`);
      try {
        const retry = await callQualityAPI(modelId, 2048);
        if (retry.ok) {
          const retryData = await retry.json();
          const retryFinish = retryData.candidates?.[0]?.finishReason;
          if (retryData.candidates?.[0]?.content?.parts?.[0]?.text && retryFinish !== 'MAX_TOKENS') {
            log.info(`✅ [QUALITY] MAX_TOKENS retry succeeded`);
            data = retryData;
            finishReason = retryFinish;
          } else {
            log.warn(`⚠️  [QUALITY] MAX_TOKENS retry still truncated (finishReason=${retryFinish}) — giving up on this eval`);
            return null;
          }
        } else {
          log.warn(`⚠️  [QUALITY] MAX_TOKENS retry HTTP error — giving up on this eval`);
          return null;
        }
      } catch (retryErr) {
        log.warn(`⚠️  [QUALITY] MAX_TOKENS retry threw: ${retryErr.message} — giving up on this eval`);
        return null;
      }
    }

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'unknown';
      log.warn(`⚠️  [QUALITY] No text response (reason: ${reason})`);
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse FIX_TARGETS section if present (bounding boxes for auto-repair)
    const parseFixTargets = (text) => {
      const fixTargets = [];
      // Look for FIX_TARGETS: section
      const fixTargetsMatch = text.match(/FIX_TARGETS:[\s\S]*?(?=\n\n|\*\*|$)/i);
      if (fixTargetsMatch) {
        // Find all JSON objects on separate lines
        const lines = fixTargetsMatch[0].split('\n');
        for (const line of lines) {
          const jsonMatch = line.match(/\{.*\}/);
          if (jsonMatch) {
            try {
              const target = JSON.parse(jsonMatch[0]);
              if (target.bbox && Array.isArray(target.bbox) && target.bbox.length === 4) {
                fixTargets.push({
                  boundingBox: target.bbox, // [ymin, xmin, ymax, xmax]
                  issue: target.issue || 'unknown issue',
                  fixPrompt: target.fix || 'fix the issue'
                });
              }
            } catch (e) {
              log.debug(`📊 [EVAL] Could not parse FIX_TARGET: ${line}`);
            }
          }
        }
      }
      if (fixTargets.length > 0) {
        log.info(`📊 [EVAL] Parsed ${fixTargets.length} fix targets with bounding boxes`);
      }
      return fixTargets;
    };

    const fixTargets = parseFixTargets(responseText);

    // Try to parse as JSON (new format with 0-10 scale)
    let parsedJson = null;
    try {
      // Extract JSON from response (may have markdown code blocks)
      parsedJson = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.debug(`📊 [EVAL] Response is not JSON, trying legacy format`);
    }

    // Gate on the DEFECT REPORT, not on a score. The prompts stopped emitting
    // `score` (b9658b501: "the prompts report defects; the score is the defects")
    // but this condition still required it, so every well-formed evaluation fell
    // through to the legacy regex fallbacks, matched none of them, and returned
    // null — which left the three-stage compliance call waiting forever on
    // figures[]/matches[] that never arrived. Recognise the response by the
    // fields the prompt actually produces.
    const isDefectReport = parsedJson && typeof parsedJson === 'object' && (
      Array.isArray(parsedJson.fixable_issues) || Array.isArray(parsedJson.figures)
      || parsedJson.coherence_gate || typeof parsedJson.verdict === 'string'
      || typeof parsedJson.score === 'number'
    );
    if (isDefectReport) {
      // The score below is DERIVED from the defect list; parsedJson.score is
      // deliberately not read even when a stale prompt still emits one.
      const verdict = parsedJson.verdict || parsedJson.final_verdict || 'UNKNOWN';
      // Support both old 'issues' and new 'issues_summary' field
      // Handle case where issues might be an array (convert to string)
      let issuesSummary = parsedJson.issues_summary || parsedJson.issues || '';
      if (Array.isArray(issuesSummary)) {
        issuesSummary = issuesSummary.join('. ');
      } else if (typeof issuesSummary !== 'string') {
        issuesSummary = String(issuesSummary);
      }

      // Parse fixable_issues from JSON (new two-stage format - no bboxes)
      // These will be enriched with bounding boxes in a separate detection step
      let fixableIssues = [];
      if (parsedJson.fixable_issues && Array.isArray(parsedJson.fixable_issues)) {
        fixableIssues = parsedJson.fixable_issues
          .filter(i => i.description)
          .map(i => ({
            description: i.description,
            severity: i.severity || 'MODERATE',
            type: i.type || 'default',
            character: i.character || null,  // Preserved for bbox matching (incl. STEP 2C proportion issues)
            fix: i.fix || `Fix: ${i.description}`
          }));
        if (fixableIssues.length > 0) {
          const proportionCount = fixableIssues.filter(f => f.type === 'proportion').length;
          if (proportionCount > 0) {
            log.info(`📊 [EVAL] Parsed ${fixableIssues.length} fixable issues (two-stage detection, ${proportionCount} proportion)`);
          } else {
            log.info(`📊 [EVAL] Parsed ${fixableIssues.length} fixable issues (two-stage detection)`);
          }
        }
      }

      // STEP 0 COHERENCE GATE (wired 2026-08-06). image-evaluation.txt has always
      // asked for `coherence_gate: {applied, reason}` — the "this image cannot be
      // published, repainting one region cannot save it" verdict — and NOTHING in
      // the codebase ever read it. It was write-only: the model emitted it, it sat
      // in the raw reasoning text, and the redo it exists to trigger could not
      // happen. Observed cost: a page framed by a full-perimeter comic-book border
      // (a listed catastrophic trigger) was reported in STEP 4 as
      // `composition/MINOR` instead, scored 68 — the highest in the book — and
      // shipped unrepaired.
      //
      // The gate does not get its own repair path. Catastrophic severity already
      // routes to regenerate (repairLogic: catastrophic visual/semantic → iterate),
      // so an applied gate is expressed as a CATASTROPHIC issue and rides the
      // existing route. If the model applied the gate but severitied the same
      // defect lower in STEP 4, the gate wins — that mismatch is exactly the
      // failure above.
      const coherenceGate = parsedJson.coherence_gate || null;
      if (coherenceGate?.applied === true) {
        const reason = coherenceGate.reason || 'image is fundamentally broken (coherence gate)';
        const alreadyCatastrophic = fixableIssues.some(i => /catastrophic/i.test(String(i.severity || '')));
        if (!alreadyCatastrophic) {
          fixableIssues.unshift({
            description: reason,
            severity: 'CATASTROPHIC',
            type: 'coherence',
            character: null,
            fix: `Regenerate the page from scratch: ${reason}`,
          });
          log.warn(`🚧 [EVAL] coherence gate APPLIED → forcing CATASTROPHIC (no STEP 4 issue matched it): ${reason}`);
        } else {
          log.warn(`🚧 [EVAL] coherence gate APPLIED: ${reason}`);
        }
      }

      // STYLE GATE (wired 2026-08-09). The medium check spent its life as a
      // defect code — D-27, 27th of 28 — and fired ZERO times in every story
      // measured. Moving it to the front of the prompt (folded into N-01)
      // changed nothing: replayed on two known-photoreal pages of a steampunk
      // book (exp #488), one came back a clean PASS, 100/100, zero defects.
      // A rule can be skimmed wherever it sits; a required output FIELD cannot.
      //
      // The prompt now asks for the observed medium FIRST, in the model's own
      // words, before it is allowed to look at what was commissioned — naming
      // what you see is harder to skip than judging against a spec.
      const styleGate = parsedJson.style_gate || null;
      if (styleGate) {
        // Medium alone was too coarse: it catches a PHOTOGRAPH in a drawn book
        // and nothing else. Watercolour, comic and anime are all "illustration"
        // — what separates them is linework and, above all, how a FACE is
        // rendered, which is why every ART_STYLES descriptor carries a "Faces:"
        // clause. A flat-vector page with simple outlined faces in a book
        // commissioned for ink linework passed the medium-only gate.
        const observed = String(styleGate.observed || '').trim();
        const linework = String(styleGate.linework || '').trim();
        const faces = String(styleGate.faces || '').trim();
        const seen = [observed, linework && `linework: ${linework}`, faces && `faces: ${faces}`]
          .filter(Boolean).join(' | ');
        if (styleGate.matches_style === false) {
          // Gate wins over a mis-severitied STEP 4 finding — same precedence as
          // the coherence gate, and the same failure it exists to prevent.
          const already = fixableIssues.some(i => /style_consistency/i.test(String(i.type || '')));
          if (!already) {
            const reason = styleGate.reason
              || `page is rendered as ${observed || 'a different medium'}, not the commissioned art style`;
            fixableIssues.unshift({
              description: reason,
              severity: 'MAJOR',
              type: 'style_consistency',
              character: null,
              fix: 'Regenerate the page in the commissioned art style — match the medium, not just the subject.',
            });
            log.warn(`🎨 [EVAL] style gate FAILED — saw [${seen}] → style_consistency MAJOR: ${reason}`);
          } else {
            log.warn(`🎨 [EVAL] style gate FAILED — saw [${seen}] — STEP 4 already reported it`);
          }
        } else if (observed) {
          // INFO, not debug. The whole point of a gate is that its answer is
          // observable; logging the normal case at debug made "the model said
          // it matches" indistinguishable from "the model never answered",
          // which cost two inconclusive investigations.
          log.info(`🎨 [EVAL] style gate: saw [${seen}] — matches the commissioned style`);
        } else {
          log.warn('🎨 [EVAL] style gate returned no `observed` value — medium was not actually named');
        }
      } else {
        // Absence is itself the signal: the field is mandatory, so a missing
        // one means the model skipped the gate (or an old prompt is live).
        log.warn('🎨 [EVAL] style_gate MISSING from the evaluator response — medium was not checked');
      }

      // MULTI-JUDGE JURY (EVAL_JUDGES): run the extra judges (Grok, Qwen) on the
      // SAME parts, then merge ALL judges by PURE MEDIAN per bucket (evalBuckets)
      // and replace fixableIssues with the deduplicated merged set before scoring.
      // Default EVAL_JUDGES=gemini → runExtraJudges returns [] → single-judge path
      // unchanged (zero prod behaviour change). NOTE: the merge de-duplicates issues
      // into one severity per bucket, which changes score magnitude — the redo
      // threshold must be A/B-calibrated in the Test Lab before the jury drives prod.
      try {
        const { getEvalJudges, runExtraJudges } = require('./evalJudges');
        const judges = getEvalJudges();
        if (judges.length > 1) {
          const extra = await runExtraJudges({ parts, judges });
          if (extra.length) {
            const { mapIssuesToBuckets, mergeJudges, bucketsToIssues } = require('./evalBuckets');
            const vectors = [mapIssuesToBuckets(fixableIssues), ...extra.map(e => mapIssuesToBuckets(e.fixableIssues))];
            const merged = mergeJudges(vectors);
            const mergedIssues = bucketsToIssues(merged);
            const lowConf = Object.values(merged).filter(m => m.lowConfidence).length;
            log.info(`🧑‍⚖️ [EVAL] Jury ${vectors.length} judges (gemini,${extra.map(e => e.judge).join(',')}) → ${mergedIssues.length} merged buckets (${lowConf} low-confidence)`);
            fixableIssues = mergedIssues.map(m => ({
              description: m.description,
              severity: String(m.severity).toUpperCase(),
              type: m.type,
              character: null,
              fix: `Fix: ${m.description}`,
              agreement: m.agreement,
            }));
          }
        }
      } catch (juryErr) {
        log.warn(`[EVAL] multi-judge merge skipped (${juryErr.message}) — using primary judge only`);
      }

      // STATS: record the (merged) buckets to eval_findings for per-style/genre
      // reporting. Best-effort, fire-and-forget; only records when the caller
      // passes evalOptions.storyMeta (else skipped). Works in single- and
      // multi-judge mode so stats populate even before the jury is enabled.
      try {
        const sm = evalOptions && evalOptions.storyMeta;
        if (sm && sm.storyId) {
          const { mapIssuesToBuckets } = require('./evalBuckets');
          const db = require('../services/database');
          const vec = mapIssuesToBuckets(fixableIssues);
          const rows = Object.entries(vec).map(([bucket, m]) => ({
            story_id: sm.storyId, page_number: sm.pageNumber ?? null, bucket,
            severity: String(m.severity).toLowerCase(), eval_type: evaluationType,
            art_style: sm.artStyle || null, genre: sm.genre || null, language: sm.language || null,
            char_count: sm.charCount ?? null, judges: process.env.EVAL_JUDGES || 'gemini',
          }));
          if (rows.length && typeof db.recordEvalFindings === 'function') db.recordEvalFindings(rows).catch(() => {});
        }
      } catch (recErr) {
        log.warn(`[EVAL] eval_findings record skipped (${recErr.message})`);
      }

      // THE SCORE IS THE DEFECTS (owner, 2026-08-08). The eval prompts no
      // longer return a score — they return fixable_issues[], and every number
      // downstream is derived from it by the §2 rubric here. blendVisualScore
      // used to let the model's own number pull the result back UP
      // (max(computed, model − 3)), so an image the model felt good about
      // outranked what its own defect list justified.
      //
      // One of TWO severity→number tables that exist on purpose — see the note
      // above SEVERITY_POINTS in scoring.js. This one is the 0-10 scale used by
      // qualityScore + the repair-method gates; it never feeds finalScore.
      const SEVERITY_PENALTY = { CATASTROPHIC: 5, CRITICAL: 3, MAJOR: 2, MODERATE: 1, MINOR: 0.5 };
      const totalPenalty = fixableIssues.reduce(
        (sum, i) => sum + (SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
        0
      );
      const visualScore10 = Math.max(0, Math.min(10, 10 - totalPenalty));
      const score = visualScore10 * 10; // 0-100 for compatibility

      log.info(`📊 [EVAL] Score: ${visualScore10}/10 (${score}/100) from ${fixableIssues.length} defect(s), Verdict: ${verdict}`);
      const hasRealIssues = issuesSummary && issuesSummary !== 'none' && issuesSummary.toLowerCase() !== 'none';
      if (hasRealIssues) {
        log.info(`📊 [EVAL] Issues: ${issuesSummary}`);
      }

      // Also parse legacy fix_targets for backwards compatibility
      let jsonFixTargets = fixTargets;
      if (parsedJson.fix_targets && Array.isArray(parsedJson.fix_targets)) {
        jsonFixTargets = parsedJson.fix_targets
          .filter(t => t.bbox && Array.isArray(t.bbox) && t.bbox.length === 4)
          .map(t => ({
            boundingBox: t.bbox,
            issue: t.issue || 'unknown issue',
            fixPrompt: t.fix || 'fix the issue'
          }));
        if (jsonFixTargets.length > 0) {
          log.info(`📊 [EVAL] Parsed ${jsonFixTargets.length} fix targets from JSON (legacy format)`);
        }
      }

      // For covers, classify text issues by severity. The eval prompt's
      // TEXT RULES block above tells the model:
      //   - title missing/misspelled          → severity CATASTROPHIC
      //   - other prominent unrequested text  → severity MAJOR
      //   - small incidental signage          → not flagged (MINOR if garbled)
      // (CRITICAL matched too for evals stored before the graded-severity
      // change.) The buckets need different handling:
      //   TITLE_ERROR — full regen; no inpaint can paint a missing title.
      //   STRAY_TEXT  — flows through the normal repair path. Inpaint can
      //                 paint over the unwanted-text region instead of
      //                 trashing an otherwise-good cover and retrying.
      // Before this split, ANY cover text issue forced a full regen, which
      // wasted a generation every time a character incidentally held
      // anything written.
      let textIssue = null;
      if (evaluationType === 'cover' && Array.isArray(fixableIssues) && fixableIssues.length > 0) {
        const TEXT_RE = /\b(text|letter|word|sign|caption|label|spell|title|writing|inscription|misspell)/i;
        const textRelated = fixableIssues.filter(i =>
          i?.type === 'rendered_text' || TEXT_RE.test(i?.description || '')
        );
        if (textRelated.some(i => /catastrophic|critical/i.test(String(i?.severity || '')))) {
          textIssue = 'TITLE_ERROR';
        } else if (textRelated.length > 0) {
          textIssue = 'STRAY_TEXT';
        }
      }
      // Fallback for evaluators that didn't emit structured fixable_issues but
      // mentioned text in issuesSummary — assume worst case (title error) so
      // we don't ship a missing-title cover when the eval format drifts.
      if (textIssue === null && evaluationType === 'cover' && issuesSummary) {
        const issuesLower = issuesSummary.toLowerCase();
        if (issuesLower.includes('text') || issuesLower.includes('spell') || issuesLower.includes('letter')) {
          textIssue = 'TITLE_ERROR';
        }
      }

      // Store the FULL analysis JSON as reasoning (for dev mode display)
      // This includes subject_mapping, identity_sync, rendering_integrity, scene_check
      const reasoning = JSON.stringify(parsedJson, null, 2);

      // Extract figures and matches for character-aware bbox matching
      // figures: [{id, position, hair, clothing, action, view}]
      // matches: [{figure, reference (char name), confidence, face_bbox, issues}]
      let figures = parsedJson.figures || [];
      let matches = parsedJson.matches || [];
      if (matches.length > 0) {
        log.info(`📊 [EVAL] Character matches: ${matches.map(m => `Figure ${m.figure} → ${m.reference} (${Math.round(m.confidence * 100)}%)`).join(', ')}`);
      }

      // Merge P1 figure data if available (better age detection — P1 doesn't see the prompt)
      let p1Usage = null;
      if (p1Promise) {
        try {
          const p1Result = await p1Promise;
          if (p1Result) {
            // Use P1's figures/matches (more honest, no prompt bias) — but only
            // when P1 actually produced some. runVisualInventory returns
            // `matches = inventoryJson.matches || []`, i.e. ALWAYS an array, and
            // an empty array is truthy: `p1Result.matches || matches` therefore
            // discarded the quality evaluator's matches unconditionally on every
            // successful P1 pass. Compliance's "authoritative for who is where"
            // input then came from an empty list, and it reported present
            // characters as missing — measured 9 false absence findings worth
            // 135 points across two stories, e.g. quality matched all five
            // characters at 0.90 while compliance declared two of them absent.
            if (p1Result.figures?.length) figures = p1Result.figures;
            if (p1Result.matches?.length) matches = p1Result.matches;
            p1Usage = { inputTokens: p1Result.inputTokens, outputTokens: p1Result.outputTokens };
          }
        } catch (e) {
          log.warn(`⚠️ [QUALITY P1] Figure check failed: ${e.message}`);
        }
      }

      // Release quality figures/matches to three-stage Stage 2
      if (qualityFiguresResolve) {
        qualityFiguresResolve({ figures, matches });
      }

      // Await semantic evaluation if running in parallel
      let semanticResult = null;
      let finalScore = score;
      let combinedIssuesSummary = issuesSummary;
      if (semanticPromise) {
        try {
          semanticResult = await semanticPromise;
          if (semanticResult && semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0) {
            // Apply semantic penalties to score
            // CRITICAL (-30), MAJOR (-20) severity
            let semanticPenalty = 0;
            for (const issue of semanticResult.semanticIssues) {
              if (issue.severity === 'CRITICAL') semanticPenalty += 30;
              else if (issue.severity === 'MAJOR') semanticPenalty += 20;
              else semanticPenalty += 10;
            }
            finalScore = score - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Semantic score: ${semanticResult.score}/100, penalty: ${semanticPenalty} points (quality ${score} → final ${finalScore})`);
            // Append semantic issues to summary
            const semanticSummary = semanticResult.semanticIssues.map(i => i.problem).join('; ');
            combinedIssuesSummary = issuesSummary
              ? `${issuesSummary}; SEMANTIC: ${semanticSummary}`
              : `SEMANTIC: ${semanticSummary}`;
          }
        } catch (semanticErr) {
          log.warn(`[SEMANTIC] Parallel evaluation failed: ${semanticErr.message}`);
        }
      }

      // Await three-stage eval. Always merge its fixableIssues into the
      // visible list (the dev panel shows the full set). Then RECOMPUTE the
      // visual quality score from the full merged fixable_issues array using
      // the same §2 rubric — otherwise three-stage findings show up in the
      // UI but never influence the threshold gate that triggers repair
      // (observed on page 5 of job_1777325711738_d5brbvvx3: main eval
      // emitted 1 MINOR → score 95, three-stage added 2 MODERATE + 1 MINOR
      // composition issues, merged into the display array but NOT into the
      // score → page stayed at qualityScore 85, above the 80 threshold,
      // never repaired despite -30 worth of real visual defects).
      let threeStageResult = null;
      let visualScore = score; // Quality score AFTER any three-stage merge
      if (threeStagePromise) {
        try {
          threeStageResult = await threeStagePromise;
          if (threeStageResult?.fixableIssues?.length) {
            fixableIssues = [...fixableIssues, ...threeStageResult.fixableIssues];
            // Recompute visual score from merged fixable_issues (same rubric
            // as main eval). Then re-apply semantic penalty on top.
            const mergedPenalty = fixableIssues.reduce(
              (sum, i) => sum + (SEVERITY_PENALTY[String(i.severity).toUpperCase()] ?? 1),
              0
            );
            const mergedRawScore = Math.max(0, Math.min(10, 10 - mergedPenalty));
            visualScore = mergedRawScore * 10;
            // Re-derive semantic penalty so finalScore = visualScore − semantic.
            // (Was applied to `score` above; recomputed here against visualScore.)
            let semanticPenalty = 0;
            if (semanticResult?.semanticIssues?.length) {
              for (const issue of semanticResult.semanticIssues) {
                if (issue.severity === 'CRITICAL') semanticPenalty += 30;
                else if (issue.severity === 'MAJOR') semanticPenalty += 20;
                else semanticPenalty += 10;
              }
            }
            finalScore = visualScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Merged ${threeStageResult.fixableIssues.length} issue(s); recomputed visual ${score}→${visualScore}, final ${finalScore} (semantic −${semanticPenalty})`);
          }
          if (threeStageResult?.issuesSummary) {
            combinedIssuesSummary = combinedIssuesSummary
              ? `${combinedIssuesSummary}; THREE-STAGE: ${threeStageResult.issuesSummary}`
              : `THREE-STAGE: ${threeStageResult.issuesSummary}`;
          }
        } catch (tsErr) {
          log.warn(`[THREE-STAGE] Parallel evaluation failed: ${tsErr.message}`);
        }
      }

      // Aggregate usage from quality + P1 + semantic + three-stage evaluations
      const semanticUsage = semanticResult?.usage || {};
      const threeStageUsage = threeStageResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (p1Usage?.inputTokens || 0) + (semanticUsage.input_tokens || 0) + (threeStageUsage.threeStage_input_tokens || 0),
        output_tokens: qualityOutputTokens + (p1Usage?.outputTokens || 0) + (semanticUsage.output_tokens || 0) + (threeStageUsage.threeStage_output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        p1_input_tokens: p1Usage?.inputTokens || 0,
        p1_output_tokens: p1Usage?.outputTokens || 0,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0,
        threeStage_input_tokens: threeStageUsage.threeStage_input_tokens || 0,
        threeStage_output_tokens: threeStageUsage.threeStage_output_tokens || 0
      };

      // SCORE NAMING CONVENTION (counterintuitive but intentional):
      // - score:        FINAL penalized score = visual - semantic - entity - three-stage penalties. Used for redo decisions.
      // - qualityScore: RAW visual quality score from Gemini eval only (before any penalties).
      // - semanticScore: Separate semantic fidelity score (0-100, null if not evaluated).
      // - threeStageScore: Separate three-stage compliance score (0-100, null if not evaluated).
      // When writing to scene.qualityScore in DB, use evaluation.qualityScore (NOT evaluation.score).
      return {
        score: finalScore,                    // Combined final score (visual − semantic)
        qualityScore: visualScore,            // Visual quality score AFTER three-stage merge
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        threeStageScore: threeStageResult?.score ?? null, // Three-stage compliance score (0-100)
        visualScore10, // 0-10 defect-derived visual score, BEFORE the three-stage merge (audit)
        verdict,
        reasoning,
        rawOutput: responseText,              // Full unparsed API response (for dev testing)
        evalTemplateHash,                     // Template version that produced this score
        issuesSummary: combinedIssuesSummary,
        textIssue,
        fixTargets: jsonFixTargets,       // Legacy format with bboxes (backwards compat)
        fixableIssues: Array.isArray(fixableIssues) ? fixableIssues : [],  // always an array — eliminates downstream null-checks
        figures,                          // Detected figures with descriptions
        matches,                          // Character name → figure mapping with face_bbox
        coherenceGate,                    // STEP 0 gate {applied, reason} — drives the forced redo above
        // STYLE GATE {observed, matches_style, reason}. Returned so it is
        // auditable: without this the gate was a local variable that pushed a
        // finding and vanished, so across two full stories there was no way to
        // tell whether the model had answered it, answered it wrongly, or never
        // emitted the field at all. A gate you cannot inspect is not a gate.
        styleGate,
        semanticResult,                   // Full semantic evaluation result (if available)
        threeStageResult,                 // Full three-stage evaluation result (if available)
        usage: totalUsage,
        modelId: modelId
      };
    }

    // Helper to merge semantic + P1 results into quality result (used by fallback text-format parsers)
    const mergeSemanticResult = async (qualityScore, reasoning) => {
      let semanticResult = null;
      let finalScore = qualityScore;
      let issuesSummary = '';

      // Await P1 for figure data (best-effort)
      let p1Usage = null;
      if (p1Promise) {
        try {
          const p1Result = await p1Promise;
          if (p1Result) {
            p1Usage = { inputTokens: p1Result.inputTokens, outputTokens: p1Result.outputTokens };
          }
        } catch (e) { /* already logged */ }
      }

      if (semanticPromise) {
        try {
          semanticResult = await semanticPromise;
          if (semanticResult && semanticResult.semanticIssues && semanticResult.semanticIssues.length > 0) {
            // Apply semantic penalties to score
            let semanticPenalty = 0;
            for (const issue of semanticResult.semanticIssues) {
              if (issue.severity === 'CRITICAL') semanticPenalty += 30;
              else if (issue.severity === 'MAJOR') semanticPenalty += 20;
              else semanticPenalty += 10;
            }
            finalScore = qualityScore - semanticPenalty;  // no 0-floor: see scoring.js computeMathFinalScore
            log.info(`🔍 [SEMANTIC] Applied ${semanticPenalty} point penalty for semantic issues (${qualityScore} → ${finalScore})`);
            issuesSummary = `SEMANTIC: ${semanticResult.semanticIssues.map(i => i.problem).join('; ')}`;
          }
        } catch (semanticErr) {
          log.warn(`[SEMANTIC] Parallel evaluation failed: ${semanticErr.message}`);
        }
      }

      // Await three-stage eval and merge (use lower score)
      let threeStageResult = null;
      if (threeStagePromise) {
        try {
          threeStageResult = await threeStagePromise;
          if (threeStageResult && threeStageResult.score < finalScore) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} < quality ${finalScore} — using three-stage score`);
            finalScore = threeStageResult.score;
            issuesSummary = threeStageResult.issuesSummary
              ? (issuesSummary ? `${issuesSummary}; THREE-STAGE: ${threeStageResult.issuesSummary}` : `THREE-STAGE: ${threeStageResult.issuesSummary}`)
              : issuesSummary;
          } else if (threeStageResult) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} >= quality ${finalScore} — keeping quality score`);
          }
        } catch (tsErr) {
          log.warn(`[THREE-STAGE] Parallel evaluation failed: ${tsErr.message}`);
        }
      }

      // Aggregate usage
      const semanticUsage = semanticResult?.usage || {};
      const threeStageUsage = threeStageResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (p1Usage?.inputTokens || 0) + (semanticUsage.input_tokens || 0) + (threeStageUsage.threeStage_input_tokens || 0),
        output_tokens: qualityOutputTokens + (p1Usage?.outputTokens || 0) + (semanticUsage.output_tokens || 0) + (threeStageUsage.threeStage_output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        p1_input_tokens: p1Usage?.inputTokens || 0,
        p1_output_tokens: p1Usage?.outputTokens || 0,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0,
        threeStage_input_tokens: threeStageUsage.threeStage_input_tokens || 0,
        threeStage_output_tokens: threeStageUsage.threeStage_output_tokens || 0
      };

      return {
        score: finalScore,                    // Combined final score
        qualityScore: qualityScore,           // Visual quality score only
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        threeStageScore: threeStageResult?.score ?? null, // Three-stage compliance score (0-100)
        reasoning,
        rawOutput: responseText,              // Full unparsed API response
        evalTemplateHash,                     // Template version that produced this score
        issuesSummary,
        fixTargets,
        semanticResult,
        threeStageResult,
        usage: totalUsage,
        modelId: modelId
      };
    };

    // Parse "Score: X/10" format (new simplified format)
    const score10Match = responseText.match(/Score:\s*(\d+)\/10\b/i);
    if (score10Match) {
      const visualScore10 = parseInt(score10Match[1]);
      const qualityScore = visualScore10 * 10; // legacy text format; new prompts emit no score
      log.verbose(`📊 [EVAL] Image quality score: ${visualScore10}/10 (${qualityScore}/100)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Parse legacy format "Score: XX/100"
    const scoreMatch = responseText.match(/Score:\s*(\d+)\/100/i);
    if (scoreMatch) {
      const qualityScore = parseInt(scoreMatch[1]);
      log.verbose(`📊 [EVAL] Image quality score: ${qualityScore}/100 (legacy format)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Try parsing just a number (0-100)
    const numericScore = parseFloat(responseText);
    if (!isNaN(numericScore) && numericScore >= 0 && numericScore <= 100) {
      log.verbose(`📊 [EVAL] Image quality score: ${numericScore}/100 (numeric format)`);
      return mergeSemanticResult(numericScore, responseText);
    }

    log.warn(`⚠️  [QUALITY] Response is neither a defect report nor a legacy score (finishReason=${finishReason}, ${responseText.length} chars):`, responseText.substring(0, 200));
    // Await parallel promises to prevent memory leak
    if (p1Promise) await p1Promise.catch(() => {});
    if (semanticPromise) await semanticPromise.catch(() => {});
    if (threeStagePromise) await threeStagePromise.catch(() => {});
    return null;
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
    // Await parallel promises to prevent memory leak
    if (p1Promise) await p1Promise.catch(() => {});
    if (semanticPromise) await semanticPromise.catch(() => {});
    if (threeStagePromise) await threeStagePromise.catch(() => {});
    return null;
  } finally {
    // Always release three-stage Stage 2 so it doesn't hang on any early return.
    // Safe to call twice — promises ignore subsequent resolve() calls.
    if (qualityFiguresResolve) qualityFiguresResolve(null);
  }
}

/**
 * Parse Visual Bible objects from the image prompt
 * Looks for REQUIRED OBJECTS section with format:
 * * **ObjectName** (type): Description
 *
 * @param {string} prompt - The full image generation prompt
 * @returns {string[]} Array of object names found
 */
function parseVisualBibleObjects(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];

  const objects = [];

  // Look for REQUIRED OBJECTS section
  const requiredSection = prompt.match(/\*\*REQUIRED OBJECTS[^*]*\*\*:?\s*([\s\S]*?)(?=\n\n|\*\*[A-Z]|$)/i);
  if (requiredSection) {
    // Match entries like: * **ObjectName** (type): Description
    const entryPattern = /\*\s*\*\*([^*]+)\*\*\s*\((\w+)\):/g;
    let match;
    while ((match = entryPattern.exec(requiredSection[1])) !== null) {
      const name = match[1].trim();
      const type = match[2].toLowerCase();
      // Only include objects and animals, not locations
      if (type !== 'location') {
        objects.push(name);
      }
    }
  }

  return objects;
}

/**
 * Translate Visual-Bible entity IDs (e.g. "ART003", "CHR001", "LOC001.2") into
 * their natural-language names from the visualBible. Entries that don't look
 * like IDs pass through unchanged. Without this step, `expectedObjects` passed
 * to the bbox detector contain opaque IDs — the detector has nothing visual to
 * match against, reports `found:false`, and downstream entity-check generates
 * fake appearance records with null bboxes.
 *
 * @param {string[]} entries - Mix of VB IDs and plain names (order preserved)
 * @param {Object|null} visualBible - Story visual bible
 * @returns {string[]} Array of names, deduplicated case-insensitively
 */
function resolveExpectedObjectLabels(entries, visualBible) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const vb = visualBible || {};
  const byId = new Map();
  const addPool = (list) => {
    for (const e of (list || [])) {
      if (e && e.id && e.name) byId.set(String(e.id).toUpperCase(), e.name);
    }
  };
  addPool(vb.artifacts);
  addPool(vb.animals);
  addPool(vb.vehicles);
  addPool(vb.secondaryCharacters);
  // Locations are skipped downstream in parseVisualBibleObjects, but LOC IDs
  // still appear in scene metadata objects[] — translate them too so the
  // detector doesn't see "LOC001".
  addPool(vb.locations);

  const seen = new Set();
  const out = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'string') continue;
    const cleaned = raw.trim();
    if (!cleaned) continue;
    // VB ID pattern: three uppercase letters + three digits, optional .N variant
    const idMatch = cleaned.match(/^([A-Z]{3}\d{3})(?:\.\d+)?$/);
    let name = cleaned;
    if (idMatch) {
      const vbName = byId.get(idMatch[1]);
      if (vbName) {
        name = vbName;
      } else {
        // Unknown ID — skip rather than send opaque token to the detector
        continue;
      }
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Per-label grounding hints for the GroundingDINO object pass. VB names are
 * story-language (often German), which DINO's English text encoder grounds
 * poorly — German labels latch onto salient figures instead of the prop. The
 * VB descriptions are English, so DINO grounds on those. Locations are marked
 * so the object pass can skip them (a location IS the scene — grounding it
 * yields a useless whole-frame or random box).
 *
 * @returns {Object} label(lowercase) → { text: english description, kind }
 */
function buildObjectGroundingHints(entries, visualBible) {
  const vb = visualBible || {};
  const byName = new Map();
  const addPool = (list, kind) => {
    for (const e of (list || [])) {
      if (e && e.name) byName.set(String(e.name).toLowerCase(), { text: String(e.description || ''), kind });
    }
  };
  addPool(vb.artifacts, 'artifact');
  addPool(vb.animals, 'animal');
  addPool(vb.vehicles, 'vehicle');
  addPool(vb.secondaryCharacters, 'secondary');
  addPool(vb.locations, 'location');
  const hints = {};
  for (const label of (entries || [])) {
    const h = byName.get(String(label).toLowerCase());
    if (h) hints[String(label).toLowerCase()] = h;
  }
  return hints;
}

// Content-hashed bbox cache. Without this, the eval + entity-consistency
// passes each detect bboxes for the same regenerated image — burning a
// Gemini call per redundant pair (~$0.30-0.60/story across a 3-pass repair).
// Cache key is sha256 of image bytes + expected-character names (since the
// model uses that list to identify figures; different expectations would
// yield different `name` fields on figures even on identical pixels).
// Entries expire after BBOX_CACHE_TTL_MS and an LRU-ish eviction caps memory.
// (crypto is required at the top of this module — reused here.)
const _bboxCache = new Map(); // key -> { result, ts }
const BBOX_CACHE_TTL_MS = 30 * 60 * 1000;
const BBOX_CACHE_MAX_ENTRIES = 500;
const _bboxCacheStats = { hits: 0, misses: 0 };

function _hashBboxKey(imageData, expectedCharacters, expectedObjects) {
  if (!imageData) return null;
  const b64 = typeof imageData === 'string' && imageData.includes(',')
    ? imageData.split(',', 2)[1]
    : imageData;
  if (typeof b64 !== 'string') return null;
  const h = crypto.createHash('sha256');
  h.update(b64);
  // Names only — descriptions/positions don't affect detection identity.
  h.update('|chars:' + (expectedCharacters || []).map(c => (c.name || c)).sort().join(','));
  h.update('|objs:' + (expectedObjects || []).slice().sort().join(','));
  return h.digest('hex').slice(0, 32);
}

function _bboxCacheGet(key) {
  if (!key) return null;
  const entry = _bboxCache.get(key);
  if (!entry) { _bboxCacheStats.misses++; return null; }
  if (Date.now() - entry.ts > BBOX_CACHE_TTL_MS) {
    _bboxCache.delete(key);
    _bboxCacheStats.misses++;
    return null;
  }
  _bboxCacheStats.hits++;
  return entry.result;
}

function _bboxCacheSet(key, result) {
  if (!key || !result) return;
  if (_bboxCache.size >= BBOX_CACHE_MAX_ENTRIES) {
    // Drop oldest insertion (Map preserves insertion order).
    const oldest = _bboxCache.keys().next().value;
    if (oldest) _bboxCache.delete(oldest);
  }
  _bboxCache.set(key, { result, ts: Date.now() });
}

function getBboxCacheStats() {
  return { ..._bboxCacheStats, size: _bboxCache.size };
}


/**
 * Detect bounding boxes for a specific issue using Gemini's native detection
 * This is stage 2 of the two-stage detection approach:
 * Stage 1: Quality evaluation identifies issues (no bboxes needed)
 * Stage 2: This function detects ALL figures, faces, and objects in one call
 *
 * @param {string} imageData - Base64 image data
 * @param {Object} options - Detection options
 * @param {Array<{name: string, description: string, position: string}>} options.expectedCharacters - Characters to identify
 * @param {string[]} options.expectedObjects - Objects to check for
 * @param {boolean} [options.skipCache] - Bypass the bbox cache (force fresh detection)
 * @returns {Promise<{figures: Array, objects: Array, usage: Object}|null>}
 */
/**
 * Fingerprint of the exact image bytes a detection was computed on.
 * Detections are only meaningful for the bytes they ran on — a box from
 * version A applied to the pixels of version B silently crops/repairs the
 * wrong region. Every detectAllBoundingBoxes result is stamped with
 * `sourceImageFp`; consumers verify via bboxPairsWith() before reusing a
 * stored detection and fall back to fresh detection on mismatch.
 */
function imageFingerprint(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  return require('crypto').createHash('sha1').update(imageData).digest('hex').slice(0, 16);
}

/**
 * True when a stored detection may be paired with these image bytes.
 * Legacy detections (no sourceImageFp stamp) are trusted — they predate the
 * invariant and are usually stored alongside the bytes they ran on.
 */
function bboxPairsWith(detection, imageData) {
  if (!detection) return false;
  if (!detection.sourceImageFp) return true;
  const fp = imageFingerprint(imageData);
  return !fp || detection.sourceImageFp === fp;
}

/**
 * Detection stored on an image VERSION (owner decision 2026-07-31:
 * "detection is part of every image version" — covers AND pages, exactly
 * like grokRefImages are stored per version). Single resolution rule used
 * by every version-entry writer:
 *   1. v.bboxDetection — a detection stamped directly on the version
 *      (e.g. the final-assembly fresh-bbox refresh, regen/iterate results)
 *      always wins: it was computed on this version's own bytes.
 *   2. v.evaluation.bboxDetection — the eval-time detection attached when
 *      the version was scored.
 *   3. null — version never had a detection (the dev endpoint's refresh
 *      button re-detects on demand).
 */
function detectionForVersion(v) {
  return v?.bboxDetection || v?.evaluation?.bboxDetection || null;
}

// Public entry — stamps every result with the fingerprint of the bytes it was
// computed on (see imageFingerprint above). Cache hits keep the stamp from
// when they were computed; the cache key already includes the image hash, so
// a hit is always for the same bytes.
async function detectAllBoundingBoxes(imageData, options = {}) {
  const result = await _detectAllBoundingBoxesImpl(imageData, options);
  if (result && !result.sourceImageFp) result.sourceImageFp = imageFingerprint(imageData);
  return result;
}

async function _detectAllBoundingBoxesImpl(imageData, options = {}) {
  const { expectedCharacters = [], expectedObjects = [], sceneContext = null, bboxModelOverride = null, pageContext = '', skipCache = false, artStyle = null, objectGroundingHints = null } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Cache check — content-hashed by image bytes + expected names. Hits skip
  // the full Gemini round-trip; misses fall through to the API and populate.
  const cacheKey = _hashBboxKey(imageData, expectedCharacters, expectedObjects);
  if (!skipCache && cacheKey) {
    const cached = _bboxCacheGet(cacheKey);
    if (cached) {
      log.debug(`♻️ [BBOX-CACHE] ${pageLabel}hit (${cached.figures?.length || 0} figures)`);
      return cached;
    }
  }

  // Alternative detection backend: local Grounded-SAM (GroundingDINO → MobileSAM).
  // Figure detection only — object detection stays with Gemini, so this path is
  // used when there are expected characters (the common repair / figure case);
  // it emits no objects (missingObjects empty → no false "missing object" flags).
  // Gated to styles that render a recognisable clothed human figure (see
  // MODEL_DEFAULTS.figureDetectionEligibleStyles). With the concise
  // buildGroundingPrompt, GDINO grounds on figure shape + clothing colour and
  // works across the range (realistic 0.69, anime 0.59, watercolor 0.63,
  // 2026-07-15). Only super-deformed/abstract styles (chibi, pixel, lowpoly)
  // stay on Gemini. Fails open: any null/error → Gemini below.
  let gdinoDiag = null;  // persisted with whichever backend produces the result
  // Undercounted-but-complete DINO result awaiting the Gemini second opinion
  // (owner, 2026-08-09): fewer persons than expected either means the painter
  // painted fewer (DINO right → keep its boxes+masks) or DINO merged two
  // overlapping figures (Gemini finds more → its boxes win, SAM-masked below).
  let dinoUndercountResult = null;
  const eligibleStyles = CONFIG_DEFAULTS.figureDetectionEligibleStyles || ['realistic'];
  const gdinoEligible = CONFIG_DEFAULTS.figureDetectionBackend === 'grounding-dino'
    && !!artStyle && eligibleStyles.includes(String(artStyle).toLowerCase());
  if (gdinoEligible && expectedCharacters.length > 0) {
    try {
      const gd = await detectFiguresWithGroundingDino(imageData, expectedCharacters, { pageLabel, expectedObjects, objectGroundingHints });
      gdinoDiag = gd?.diag || null;
      if (gd && Array.isArray(gd.figures) && gd.figures.length > 0) {
        // No Haar cascade merge here — faceBoxes come from DINO "face" boxes
        // (cleaner: no phantom faces, found background faces Haar missed).
        const foundObjects = (gd.objects || []).filter(o => o.found).map(o => o.name);
        const result = {
          figures: gd.figures,
          objects: gd.objects || [],
          expectedCharacters,
          expectedObjects,
          foundObjects,
          // Deliberately empty: a DINO miss is not evidence of absence, so it
          // must not raise missing-object flags (docs/decisions.md).
          missingObjects: [],
          unknownFigures: gd.figures.filter(f => f.name === 'UNKNOWN').length,
          usage: { input_tokens: 0, output_tokens: 0 },
          rawPrompt: 'grounding-dino',
          rawResponse: null,
          refinementResponse: null,
          detectionBackend: 'grounding-dino',
          gdinoDiag: gd.diag || null,
        };
        // Per-figure mask PNGs ride along non-enumerably: the overlay renderer
        // uses them for the cutout strip, JSON persistence (stories.data JSONB)
        // and the raw API response never see them.
        Object.defineProperty(result, '_gdinoMasks', { value: gd.masks || [], enumerable: false });
        if (gd.diag?.undercount) {
          // Don't trust-or-discard yet — stash and fall through to the Gemini
          // detection below, which acts as the second opinion. Not cached: the
          // cache stores only the arbitrated final answer.
          dinoUndercountResult = result;
          log.info(`🦖 [BBOX-DETECT] ${pageLabel}GroundingDINO undercount (${gd.diag.undercount}) — asking Gemini for a second opinion`);
        } else {
          if (!skipCache && cacheKey) _bboxCacheSet(cacheKey, result);
          log.info(`🦖 [BBOX-DETECT] ${pageLabel}GroundingDINO backend (${gd.figures.length} figures, ${foundObjects.length} objects)`);
          return result;
        }
      }
      if (!dinoUndercountResult) {
        log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}GroundingDINO backend returned nothing — falling back to Gemini`);
        getCurrentLogger()?.warn?.('detection_fallback', `${pageLabel}figure detection fell back to Gemini — GroundingDINO returned nothing (analyzer cold/unhealthy?)`, null, { pageLabel, reason: gdinoDiag?.reason || 'no figures' });
      }
    } catch (gdErr) {
      log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}GroundingDINO backend error (${gdErr.message}) — falling back to Gemini`);
      getCurrentLogger()?.warn?.('detection_fallback', `${pageLabel}figure detection fell back to Gemini — GroundingDINO ERROR: ${gdErr.message} (analyzer down/unhealthy?)`, null, { pageLabel, error: gdErr.message });
    }
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn('⚠️  [BBOX-DETECT] Gemini API key not configured');
      return dinoUndercountResult || null;
    }

    // Load prompt template
    if (!PROMPT_TEMPLATES.boundingBoxDetection) {
      log.warn('⚠️  [BBOX-DETECT] Bounding box detection prompt template not loaded');
      return dinoUndercountResult || null;
    }

    // Build dynamic prompt with expected characters and objects
    let prompt = PROMPT_TEMPLATES.boundingBoxDetection;

    // Inject expected characters section
    if (expectedCharacters.length > 0) {
      const charSection = `EXPECTED CHARACTERS (identify by name if found):\n` +
        expectedCharacters.map((c, i) =>
          `${i + 1}. ${c.name} - ${c.description}${c.position ? `\n   Expected position: ${c.position}` : ''}`
        ).join('\n');
      prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', charSection);
    } else {
      prompt = prompt.replace('{{EXPECTED_CHARACTERS}}', '(No expected characters provided - detect all figures as UNKNOWN)');
    }

    // Inject expected objects section
    if (expectedObjects.length > 0) {
      const objSection = `EXPECTED OBJECTS (check if present):\n` +
        expectedObjects.map(o => `- ${o}`).join('\n');
      prompt = prompt.replace('{{EXPECTED_OBJECTS}}', objSection);
    } else {
      prompt = prompt.replace('{{EXPECTED_OBJECTS}}', '(No expected objects provided)');
    }

    // Inject scene context (helps distinguish characters by position and action)
    if (sceneContext) {
      prompt = prompt.replace('{{SCENE_CONTEXT}}', `SCENE DESCRIPTION (use to identify characters by position and action):\n${sceneContext}`);
    } else {
      prompt = prompt.replace('{{SCENE_CONTEXT}}', '');
    }

    // Extract base64 and mime type
    const base64Data = r2Lib.stripDataUriPrefix(imageData);
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: prompt }
    ];

    // Bbox needs spatial precision — use dedicated bbox model
    const modelId = bboxModelOverride || MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
    const modelConfig = TEXT_MODELS[modelId];

    // Route based on provider
    let data;
    let inputTokens = 0;
    let outputTokens = 0;
    if (modelConfig?.provider === 'anthropic') {
      // Claude vision path — uses callTextModel with images option
      log.info(`🔲 [BBOX-DETECT] ${pageLabel}Using Claude vision: ${modelId}`);
      const { callTextModel } = require('./textModels');
      const imageDataUri = `data:${mimeType};base64,${base64Data}`;
      const claudeResult = await callTextModel(prompt, 16000, modelId, { images: [imageDataUri], usageLabel: 'bbox_detect' });
      if (!claudeResult?.text) {
        log.warn('⚠️  [BBOX-DETECT] Claude returned no text response');
        return dinoUndercountResult || null;
      }
      // Wrap in Gemini-compatible format for downstream parsing
      data = {
        candidates: [{ content: { parts: [{ text: claudeResult.text }] } }],
        usageMetadata: { promptTokenCount: claudeResult.usage?.input_tokens || 0, candidatesTokenCount: claudeResult.usage?.output_tokens || 0 }
      };
      inputTokens = claudeResult.usage?.input_tokens || 0;
      outputTokens = claudeResult.usage?.output_tokens || 0;
    } else if (modelConfig?.provider === 'xai') {
      log.info(`🔲 [BBOX-DETECT] ${pageLabel}Using Grok vision: ${modelId}`);
      const grokResponse = await callGrokVisionAPI(modelId, modelConfig.modelId || modelId, parts, prompt);
      data = await grokResponse.json();
      if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        log.warn('⚠️  [BBOX-DETECT] Grok returned no text response');
        return dinoUndercountResult || null;
      }
      inputTokens = data.usageMetadata?.promptTokenCount || data.usage?.prompt_tokens || 0;
      outputTokens = data.usageMetadata?.candidatesTokenCount || data.usage?.completion_tokens || 0;
    } else {
      // Gemini path — retry once on empty response (0 output tokens)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      for (let bboxAttempt = 1; bboxAttempt <= 2; bboxAttempt++) {
        const response = await withRetry(async () => {
          return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts }],
              generationConfig: {
                // A clean bbox response for 5 figures + 5 objects is ~600
                // tokens. When Gemini 2.5-flash-lite hits 15k+ it's stuck in
                // a repetition loop inside a verbose label, not producing
                // more figures. A tighter cap (2500) fails fast on repetition
                // loops so the Grok fallback kicks in quickly. The real fix
                // is the ≤10-word label cap in the prompt — this cap is the
                // pressure valve if the prompt rule doesn't hold.
                maxOutputTokens: 2500,
                temperature: 0.5,  // Google recommends >0 for bbox to prevent repetition loops
                responseMimeType: 'application/json',
                // Disable thinking unconditionally — Google's image-understanding docs
                // explicitly recommend thinkingBudget=0 for object detection (thinking
                // adds latency without improving spatial accuracy). Without this,
                // gemini-2.5-flash burns ~3-4k thinking tokens before output and trips
                // MAX_TOKENS before producing the JSON. The previous gate
                // `modelSupportsThinking(modelId)` checks IMAGE_MODELS, but gemini-2.5-flash
                // is a TEXT_MODELS entry — the gate was always false for bbox detection.
                // The field is silently ignored on non-thinking models.
                thinkingConfig: { thinkingBudget: 0 },
              },
              safetySettings: GEMINI_SAFETY_SETTINGS
            })
          });
        }, { maxRetries: 2, baseDelay: 1000 });

        if (!response.ok) {
          const error = await response.text();
          const errorOneLine = error.replace(/[\n\r]+/g, ' ').replace(/\s{2,}/g, ' ').substring(0, 200);
          log.warn(`⚠️ [BBOX-DETECT] API error ${response.status} (${modelId}): ${errorOneLine}`);
          // Try Grok fallback on API error
          const grokFallbackId = (bboxModelOverride && TEXT_MODELS[bboxModelOverride]?.provider === 'xai') ? bboxModelOverride : 'grok-4-fast';
          const grokModel = TEXT_MODELS[grokFallbackId];
          if (grokModel?.provider === 'xai') {
            log.info(`🔄 [BBOX-DETECT] Gemini API error, falling back to Grok vision (${grokFallbackId})...`);
            try {
              const grokResp = await callGrokVisionAPI(grokFallbackId, grokModel.modelId || grokFallbackId, parts, prompt);
              data = await grokResp.json();
              if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                inputTokens = data.usage?.prompt_tokens || 0;
                outputTokens = data.usage?.completion_tokens || 0;
                log.info(`✅ [BBOX-DETECT] Grok fallback succeeded after API error`);
                break;
              }
            } catch (grokErr) {
              log.warn(`⚠️  [BBOX-DETECT] Grok fallback also failed: ${grokErr.message}`);
            }
          }
          return dinoUndercountResult || null;
        }

        data = await response.json();

        inputTokens = data.usageMetadata?.promptTokenCount || 0;
        outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        log.debug(`📊 [BBOX-DETECT] Token usage - input: ${inputTokens}, output: ${outputTokens}${bboxAttempt > 1 ? ` (retry ${bboxAttempt})` : ''}`);

        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') {
          log.warn(`⚠️  [BBOX-DETECT] Finish reason: ${finishReason}`);
        }

        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          break; // Got content
        }

        // Log full response structure for debugging empty responses
        const candidateCount = data.candidates?.length || 0;
        const promptBlockReason = data.promptFeedback?.blockReason || null;
        const promptSafety = data.promptFeedback?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
        const candBlockReason = data.candidates?.[0]?.blockReason || null;
        const candSafety = data.candidates?.[0]?.safetyRatings?.map(r => `${r.category}:${r.probability}${r.blocked ? '(BLOCKED)' : ''}`).join(', ') || 'none';
        const blockReason = promptBlockReason || candBlockReason;
        log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Empty response: candidates=${candidateCount}, finishReason=${finishReason || 'none'}, blockReason=${blockReason || 'none'}, model=${modelId}`);
        log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Safety details: prompt=[${promptSafety}], candidate=[${candSafety}]`);

        // PROHIBITED_CONTENT is most often triggered by prompt TEXT (German
        // story vocabulary like "stumble", "fall into water", combined with
        // child references), not the image. Sanitize the text portion of the
        // prompt and retry — same approach SEMANTIC eval uses. Only fall
        // through to Grok if sanitization-retry also fails.
        if (blockReason === 'PROHIBITED_CONTENT' && bboxAttempt < 2) {
          const sanitized = sanitizeForGemini(prompt, 'full');
          if (sanitized !== prompt) {
            log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Blocked (PROHIBITED_CONTENT), retrying with full text sanitization...`);
            parts[parts.length - 1] = { text: sanitized };
            prompt = sanitized;
            continue;
          }
          // Sanitization produced no change — go to Grok fallback below.
          log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}PROHIBITED_CONTENT and sanitization is no-op, routing to Grok fallback`);
        }

        if (bboxAttempt < 2 && blockReason !== 'PROHIBITED_CONTENT') {
          log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Empty response (0 output tokens), retrying in 2s...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          // Gemini failed — try Grok vision as fallback
          const grokFallbackId2 = (bboxModelOverride && TEXT_MODELS[bboxModelOverride]?.provider === 'xai') ? bboxModelOverride : 'grok-4-fast';
          const grokFallbackModel = TEXT_MODELS[grokFallbackId2];
          if (grokFallbackModel?.provider === 'xai') {
            log.info(`🔄 [BBOX-DETECT] Gemini failed, falling back to Grok vision (${grokFallbackId2})...`);
            try {
              const grokResponse = await callGrokVisionAPI(grokFallbackId2, grokFallbackModel.modelId || grokFallbackId2, parts, prompt);
              data = await grokResponse.json();
              if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                inputTokens = data.usageMetadata?.promptTokenCount || data.usage?.prompt_tokens || 0;
                outputTokens = data.usageMetadata?.candidatesTokenCount || data.usage?.completion_tokens || 0;
                log.info(`✅ [BBOX-DETECT] Grok fallback succeeded (${outputTokens} output tokens)`);
                break; // Got content from Grok
              }
              log.warn('⚠️  [BBOX-DETECT] Grok fallback also returned no text');
            } catch (grokErr) {
              log.warn(`⚠️  [BBOX-DETECT] Grok fallback failed: ${grokErr.message}`);
            }
          }
          log.warn('🔄 [FALLBACK] No response for bbox detection after retry');
          return dinoUndercountResult || null;
        }
      }
    }

    // Guard: if all attempts failed (e.g., PROHIBITED_CONTENT block), data has no candidates
    if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      log.warn('🔄 [FALLBACK] Detection failed, no bounding boxes available');
      return dinoUndercountResult || null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse JSON response
    let parsedResult;
    try {
      parsedResult = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.warn(`⚠️  [BBOX-DETECT] Failed to parse response: ${e.message}`);
      log.debug(`⚠️  [BBOX-DETECT] Raw response (first 1000 chars): ${responseText.substring(0, 1000)}`);

      // Attempt to repair truncated JSON (e.g. from MAX_TOKENS finish reason)
      try {
        const jsonStart = responseText.match(/\{[\s\S]*/);
        if (jsonStart) {
          let truncated = jsonStart[0];

          // Strategy: Find last complete object in array and truncate there
          // Look for pattern like: }, or }] that marks end of complete object
          const lastCompleteObject = truncated.lastIndexOf('},');
          const lastArrayEnd = truncated.lastIndexOf('}]');
          const cutPoint = Math.max(lastCompleteObject, lastArrayEnd);

          if (cutPoint > 0 && cutPoint < truncated.length - 5) {
            // Cut at the last complete structure
            truncated = truncated.substring(0, cutPoint + 1);
          } else {
            // Fallback: remove incomplete trailing data
            truncated = truncated.replace(/,(\s*)$/, '$1');
            // Remove incomplete arrays like [10, 20, or [10, 20, 30
            truncated = truncated.replace(/\[\s*[\d\s,]*$/, '');
            // Remove incomplete key-value pairs
            truncated = truncated.replace(/,?\s*"[^"]*":\s*("(?:[^"\\]|\\.)*)?$/, '');
            truncated = truncated.replace(/,?\s*"[^"]*":\s*\[?\s*$/, '');
            truncated = truncated.replace(/,?\s*"[^"]*"\s*$/, '');
          }

          // Count open brackets/braces and close them
          const openBraces = (truncated.match(/\{/g) || []).length - (truncated.match(/\}/g) || []).length;
          const openBrackets = (truncated.match(/\[/g) || []).length - (truncated.match(/\]/g) || []).length;
          // Remove any trailing comma before we close
          truncated = truncated.replace(/,\s*$/, '');
          // Close in correct order: inner brackets first, then braces
          truncated += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
          parsedResult = JSON.parse(truncated);
          log.info(`🔧 [BBOX-DETECT] Repaired truncated JSON (finishReason: ${finishReason || 'STOP'})`);
        }
      } catch (repairError) {
        log.warn(`⚠️  [BBOX-DETECT] JSON repair failed: ${repairError.message}`);

        // Last resort: try to extract complete figure objects using regex
        try {
          const figurePattern = /\{\s*"label"\s*:\s*"([^"]+)"\s*,\s*"position"\s*:\s*"([^"]+)"\s*,\s*"face_box"\s*:\s*\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]\s*,\s*"body_box"\s*:\s*\[(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\]\s*\}/g;
          const extractedFigures = [];
          let match;
          while ((match = figurePattern.exec(responseText)) !== null) {
            extractedFigures.push({
              label: match[1],
              position: match[2],
              face_box: [parseInt(match[3]), parseInt(match[4]), parseInt(match[5]), parseInt(match[6])],
              body_box: [parseInt(match[7]), parseInt(match[8]), parseInt(match[9]), parseInt(match[10])]
            });
          }
          if (extractedFigures.length > 0) {
            parsedResult = { figures: extractedFigures, objects: [] };
            log.info(`🔧 [BBOX-DETECT] Extracted ${extractedFigures.length} figures via regex fallback`);
          }
        } catch (regexError) {
          log.warn(`⚠️  [BBOX-DETECT] Regex extraction also failed: ${regexError.message}`);
        }

        if (!parsedResult) {
          return dinoUndercountResult || null;
        }
      }
    }

    if (!parsedResult) {
      // Dump the full response (head + tail + total length) so we can see
      // whether the model truncated inside a long label, hit a repetition
      // loop, or produced something entirely different from JSON.
      const total = responseText.length;
      const head = responseText.slice(0, 400);
      const tail = total > 800 ? responseText.slice(-400) : '';
      log.warn(`⚠️  [BBOX-DETECT] No JSON found in response (${total} chars). HEAD: ${head}${tail ? `\n...TAIL: ${tail}` : ''}`);
      return dinoUndercountResult || null;
    }

    // Normalize coordinates from 0-1000 to 0.0-1.0
    const normalizeBox = (box) => {
      if (!box || !Array.isArray(box) || box.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = box;
      // Handle both 0-1000 format (Gemini native) and 0-1 format (already normalized)
      const scale = (ymax > 1 || xmax > 1) ? 1000 : 1;
      return [
        Math.max(0, Math.min(1, ymin / scale)),
        Math.max(0, Math.min(1, xmin / scale)),
        Math.max(0, Math.min(1, ymax / scale)),
        Math.max(0, Math.min(1, xmax / scale))
      ];
    };

    // Normalize all figures (now includes name and confidence from AI identification)
    const figures = (parsedResult.figures || []).map(fig => ({
      name: fig.name || 'UNKNOWN',  // Character name or "UNKNOWN"
      label: fig.label,
      position: fig.position,
      faceBox: normalizeBox(fig.face_box),
      bodyBox: normalizeBox(fig.body_box),
      confidence: fig.confidence || 'low'  // "high", "medium", "low"
    }));

    // Normalize all objects (now includes found status and expected name)
    const objects = (parsedResult.objects || []).map(obj => ({
      name: obj.name,  // Expected object name (from input)
      found: obj.found !== false,  // Default true for backward compatibility
      label: obj.label,
      position: obj.position,
      bodyBox: normalizeBox(obj.body_box)
    }));

    // Log character identifications (pass 1)
    const identifiedChars = figures.filter(f => f.name !== 'UNKNOWN');
    const unknownFiguresPass1 = figures.filter(f => f.name === 'UNKNOWN');
    if (identifiedChars.length > 0) {
      log.info(`📦 [BBOX-DETECT] Pass 1: Identified ${identifiedChars.length} characters: ${identifiedChars.map(f => `${f.name} (${f.confidence})`).join(', ')}`);
    }
    if (unknownFiguresPass1.length > 0) {
      log.info(`📦 [BBOX-DETECT] Pass 1: ${unknownFiguresPass1.length} UNKNOWN figures: ${unknownFiguresPass1.map(f => f.label).join(', ')}`);
    }
    log.info(`📦 [BBOX-DETECT] Pass 1: ${figures.length} figures, ${objects.length} objects`);

    // ── Pass 2: Refinement — send pass-1 boxes back for verification/correction ──
    // Skip refinement if explicitly disabled or if using Grok (different API format)
    let finalFigures = figures;
    let finalObjects = objects;
    let refinementResponse = null;
    let totalInputTokens = inputTokens;
    let totalOutputTokens = outputTokens;

    // Only refine if we have identified main characters (skip UNKNOWN-only results)
    const mainCharacters = figures.filter(f => f.name && f.name !== 'UNKNOWN');
    if (options.skipRefinement !== true && mainCharacters.length > 0) {
      try {
        // Generate overlay image from pass 1 so the model can see its own drawn boxes
        const pass1Result = { figures, objects, expectedCharacters, expectedObjects };
        const overlayDataUri = await createBboxOverlayImage(imageData, pass1Result);

        if (overlayDataUri) {
          const overlayBase64 = r2Lib.stripDataUriPrefix(overlayDataUri);
          const overlayMime = overlayDataUri.match(/^data:(image\/\w+);base64,/)
            ? overlayDataUri.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

          // Same focused prompt as the manual "Bbox verfeinern" button (iterate-bbox endpoint)
          const figuresSummary = mainCharacters.map((f, i) => {
            const fb = f.faceBox ? `face:[${f.faceBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no face';
            const bb = f.bodyBox ? `body:[${f.bodyBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no body';
            return `  ${i + 1}. "${f.name}" (${f.confidence}) — ${fb}, ${bb}`;
          }).join('\n');

          const refinePrompt = fillTemplate(LOCAL_PROMPTS.bboxRefineOverlay, {
            FIGURES_SUMMARY: figuresSummary,
          });

          const refineModelId = bboxModelOverride || MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
          const refineModelConfig = TEXT_MODELS[refineModelId];
          let refineData;

          if (refineModelConfig?.provider === 'xai') {
            const refineParts = [
              { inline_data: { mime_type: overlayMime, data: overlayBase64 } },
              { text: refinePrompt }
            ];
            const grokResp = await callGrokVisionAPI(refineModelId, refineModelConfig.modelId || refineModelId, refineParts, refinePrompt);
            refineData = await grokResp.json();
          } else {
            const refineUrl = `https://generativelanguage.googleapis.com/v1beta/models/${refineModelId}:generateContent?key=${apiKey}`;
            const refineResp = await withRetry(async () => {
              return fetch(refineUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [
                    { inline_data: { mime_type: overlayMime, data: overlayBase64 } },
                    { text: refinePrompt }
                  ] }],
                  generationConfig: {
                    // Refine pass: smaller response (just refined main character boxes),
                    // so a tight cap is fine and prevents repetition loops.
                    maxOutputTokens: 2500,
                    temperature: 0.5,
                    responseMimeType: 'application/json',
                    ...(modelSupportsThinking(refineModelId) && { thinkingConfig: { thinkingBudget: 0 } })
                  },
                  safetySettings: GEMINI_SAFETY_SETTINGS
                })
              });
            }, { maxRetries: 1, baseDelay: 1000 });

            if (!refineResp.ok) throw new Error(`Refine API ${refineResp.status}`);
            refineData = await refineResp.json();
          }

          totalInputTokens += refineData?.usageMetadata?.promptTokenCount || 0;
          totalOutputTokens += refineData?.usageMetadata?.candidatesTokenCount || 0;

          const refineText = refineData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (refineText) {
            refinementResponse = refineText;
            const refined = getStoryHelpers().extractJsonFromText(refineText);
            if (refined?.figures) {
              // Merge: update main characters with refined boxes, keep UNKNOWN crowd from pass 1
              const refinedMap = new Map();
              for (const fig of refined.figures) {
                refinedMap.set((fig.name || '').toLowerCase(), {
                  name: fig.name || 'UNKNOWN',
                  label: fig.label,
                  position: fig.position,
                  faceBox: normalizeBox(fig.face_box),
                  bodyBox: normalizeBox(fig.body_box),
                  confidence: fig.confidence || 'low'
                });
              }
              finalFigures = [];
              for (const mc of mainCharacters) {
                finalFigures.push(refinedMap.get(mc.name.toLowerCase()) || mc);
              }
              // Keep UNKNOWN crowd figures from pass 1
              for (const uf of figures.filter(f => f.name === 'UNKNOWN')) {
                finalFigures.push(uf);
              }
              log.info(`📦 [BBOX-DETECT] Pass 2 (refine): refined ${refinedMap.size} main character boxes, kept ${finalFigures.length - refinedMap.size} crowd figures`);
            }
          }
        }
      } catch (refineErr) {
        log.warn(`⚠️  [BBOX-DETECT] Pass 2 refinement failed, keeping pass 1 results: ${refineErr.message}`);
      }
    }

    // Cascade face merge — Gemini face boxes are often tight/cropped. The cascade
    // detector (anime + haar) typically finds looser, better-centered faces. Merge
    // them in before returning so every downstream consumer (character repair,
    // masking, entity check) gets the improved box.
    try {
      const { detectIllustrationFaces, mergeCascadeFacesWithGemini } = require('./entityConsistency');
      const cascadeFaces = await detectIllustrationFaces(imageData, 60);
      if (cascadeFaces.length > 0) {
        let imgW = 1024, imgH = 1024;
        try {
          const meta = await sharp(Buffer.from(r2Lib.stripDataUriPrefix(imageData), 'base64')).metadata();
          imgW = meta.width || 1024;
          imgH = meta.height || 1024;
        } catch { /* use defaults */ }
        finalFigures = await mergeCascadeFacesWithGemini(finalFigures, cascadeFaces, imgW, imgH, expectedCharacters);
        const improved = finalFigures.filter(f => f._cascadeFace).length;
        if (improved > 0) {
          log.info(`🎯 [BBOX-DETECT] ${pageLabel}Cascade improved ${improved}/${finalFigures.length} face boxes`);
        }
      }
    } catch (cascadeErr) {
      log.debug(`[BBOX-DETECT] ${pageLabel}Cascade merge skipped: ${cascadeErr.message}`);
    }

    // Compute found/missing objects from final results
    const foundObjects = finalObjects.filter(o => o.found).map(o => o.name);
    const missingObjects = finalObjects.filter(o => !o.found).map(o => o.name);

    const finalResult = {
      figures: finalFigures,
      objects: finalObjects,
      // Include expected inputs for dev mode display
      expectedCharacters,
      expectedObjects,
      foundObjects,
      missingObjects,
      unknownFigures: finalFigures.filter(f => f.name === 'UNKNOWN').length,
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      // Include raw prompt and response for dev mode debugging
      rawPrompt: prompt,
      rawResponse: responseText,
      refinementResponse,
      // When the flag is on but GroundingDINO fell back to Gemini, keep its
      // diagnostics (raw batched scores + why it fell back) on the result so
      // the page is still debuggable.
      detectionBackend: gdinoDiag ? 'gemini-fallback' : undefined,
      gdinoDiag: gdinoDiag || undefined,
    };

    // ── Second-opinion arbitration (owner, 2026-08-09) ─────────────────────
    // A stashed undercounted DINO result means Gemini just ran as the second
    // opinion. More Gemini figures than DINO persons → DINO merged overlapping
    // figures (e.g. a child standing in front of an adult) → Gemini's boxes
    // win, and SAM masks are attached to THEM so cutouts/carve-out still work.
    // Same-or-fewer → the painter really painted fewer people; DINO's tight
    // boxes + masks + SoM names stand, and the undercount stays visible to the
    // evals as genuinely missing characters.
    if (dinoUndercountResult) {
      const dinoN = dinoUndercountResult.figures.length;
      const gemN = (finalResult.figures || []).length;
      if (gemN > dinoN) {
        try {
          const masks = await attachSamMasksToFigures(imageData, finalResult.figures, { pageLabel });
          Object.defineProperty(finalResult, '_gdinoMasks', { value: masks, enumerable: false });
        } catch (maskErr) {
          log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}SAM mask attach on Gemini boxes failed (${maskErr.message}) — boxes stay maskless`);
        }
        finalResult.detectionBackend = 'gemini-second-opinion';
        finalResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { dino: dinoN, gemini: gemN, chose: 'gemini' } };
        log.info(`⚖️ [BBOX-DETECT] ${pageLabel}second opinion: Gemini ${gemN} > DINO ${dinoN} figures — DINO merged; using Gemini boxes + SAM masks`);
        if (!skipCache) _bboxCacheSet(cacheKey, finalResult);
        return finalResult;
      }
      dinoUndercountResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { dino: dinoN, gemini: gemN, chose: 'dino' } };
      log.info(`⚖️ [BBOX-DETECT] ${pageLabel}second opinion: Gemini ${gemN} ≤ DINO ${dinoN} figures — painter painted fewer; keeping DINO boxes+masks`);
      if (!skipCache) _bboxCacheSet(cacheKey, dinoUndercountResult);
      return dinoUndercountResult;
    }

    // Populate the cache so the entity-consistency pass can reuse this on
    // the same image without re-paying the Gemini call.
    if (!skipCache) _bboxCacheSet(cacheKey, finalResult);

    return finalResult;

  } catch (error) {
    log.error(`❌ [BBOX-DETECT] Error detecting bounding boxes: ${error.message}`);
    if (dinoUndercountResult) {
      // The second opinion failed to materialize — the undercounted DINO
      // result is still strictly better than nothing (real boxes + masks).
      log.warn(`⚠️ [BBOX-DETECT] ${pageLabel}Gemini second opinion errored — keeping the undercounted DINO result`);
      dinoUndercountResult.gdinoDiag = { ...(dinoUndercountResult.gdinoDiag || {}), secondOpinion: { chose: 'dino', error: error.message } };
      return dinoUndercountResult;
    }
    return null;
  }
}

/**
 * Detect a specific sub-region within a character crop
 * Stage 2 of targeted repair: refines full body_box to specific element (shoes, shirt, hands, etc.)
 *
 * @param {Buffer|string} characterCrop - Cropped image of the character (Buffer or base64)
 * @param {string} targetElement - What to find (shoes, shirt, hands, etc.)
 * @returns {Promise<{found: boolean, box: [number,number,number,number]|null, confidence: string, description: string}|null>}
 */
async function detectSubRegion(characterCrop, targetElement) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn('⚠️  [SUB-REGION] Gemini API key not configured');
      return null;
    }

    // Load prompt template
    if (!PROMPT_TEMPLATES.subRegionDetection) {
      log.warn('⚠️  [SUB-REGION] Sub-region detection prompt template not loaded');
      return null;
    }

    // Build prompt with target element
    const prompt = fillTemplate(PROMPT_TEMPLATES.subRegionDetection, {
      TARGET_ELEMENT: targetElement
    });

    // Convert to base64 if Buffer
    let base64Data;
    let mimeType = 'image/jpeg';
    if (Buffer.isBuffer(characterCrop)) {
      base64Data = characterCrop.toString('base64');
    } else if (typeof characterCrop === 'string') {
      const base64Match = characterCrop.match(/^data:(image\/\w+);base64,(.+)$/);
      if (base64Match) {
        mimeType = base64Match[1];
        base64Data = base64Match[2];
      } else {
        base64Data = characterCrop;
      }
    } else {
      log.warn('⚠️  [SUB-REGION] Invalid characterCrop type');
      return null;
    }

    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: prompt }
    ];

    // Bbox needs spatial precision — use dedicated bbox model (gemini-2.5-flash)
    const modelId = MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await withRetry(async () => {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 2000,
            temperature: 0.1,
            responseMimeType: 'application/json'
          },
          safetySettings: GEMINI_SAFETY_SETTINGS
        })
      });
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!response.ok) {
      const error = await response.text();
      log.error(`❌ [SUB-REGION] Gemini API error ${response.status}: ${error.replace(/[\n\r]+/g, ' ').substring(0, 200)}`);
      return null;
    }

    const data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    log.debug(`📊 [SUB-REGION] Token usage - input: ${inputTokens}, output: ${outputTokens}`);

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      log.warn('⚠️  [SUB-REGION] No response from Gemini');
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse JSON response
    let parsedResult;
    try {
      parsedResult = getStoryHelpers().extractJsonFromText(responseText);
    } catch (e) {
      log.warn(`⚠️  [SUB-REGION] Failed to parse response: ${e.message}`);
      log.debug(`⚠️  [SUB-REGION] Raw response: ${responseText.substring(0, 500)}`);
      return null;
    }

    if (!parsedResult) {
      log.warn(`⚠️  [SUB-REGION] No JSON found in response`);
      return null;
    }

    // Normalize coordinates from 0-1000 to 0.0-1.0
    let normalizedBox = null;
    if (parsedResult.found && parsedResult.box && Array.isArray(parsedResult.box) && parsedResult.box.length === 4) {
      const [ymin, xmin, ymax, xmax] = parsedResult.box;
      // Handle both 0-1000 format (Gemini native) and 0-1 format (already normalized)
      const scale = (ymax > 1 || xmax > 1) ? 1000 : 1;
      normalizedBox = [
        Math.max(0, Math.min(1, ymin / scale)),
        Math.max(0, Math.min(1, xmin / scale)),
        Math.max(0, Math.min(1, ymax / scale)),
        Math.max(0, Math.min(1, xmax / scale))
      ];
    }

    const result = {
      found: parsedResult.found === true,
      box: normalizedBox,
      confidence: parsedResult.confidence || 'low',
      description: parsedResult.description || '',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    };

    if (result.found) {
      log.info(`🎯 [SUB-REGION] Found "${targetElement}": ${result.description} (${result.confidence})`);
    } else {
      log.info(`🎯 [SUB-REGION] "${targetElement}" not found: ${result.description}`);
    }

    return result;

  } catch (error) {
    log.error(`❌ [SUB-REGION] Error detecting sub-region: ${error.message}`);
    return null;
  }
}


/**
 * Build expected characters array for bbox detection from character descriptions, positions, and clothing
 * @param {Object} characterDescriptions - Map of charName → {age, gender, isChild, genderTerm}
 * @param {Object} expectedPositions - Map of charName → position string
 * @param {Object} characterClothing - Map of charName → clothing description string
 * @returns {Array<{name: string, description: string, position: string}>}
 */

function buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing = {}) {
  const chars = [];
  const addedNames = new Set();

  // Helper to get clothing for a character name (case-insensitive lookup)
  const getClothing = (name) => {
    return characterClothing?.[name] ||
           characterClothing?.[name.charAt(0).toUpperCase() + name.slice(1)] ||
           characterClothing?.[name.toLowerCase()] || '';
  };

  // Category names that aren't actual wearable descriptions — these are internal
  // metadata tags (e.g. "standard", "costumed:wizard") and must never leak into
  // the detector prompt as if they were clothing.
  const isCategoryLabel = (str) => {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim().toLowerCase();
    if (['standard', 'winter', 'summer', 'costumed'].includes(s)) return true;
    if (s.startsWith('costumed:')) return true;
    return false;
  };

  // Resolve a clothing category (including nested costumed:type) to a prose
  // description. char.avatars.clothing has this shape:
  //   { standard: "...", winter: "...", costumed: { cowboy: "...", wizard: "..." } }
  // so "costumed:cowboy" needs to hit avatars.clothing.costumed.cowboy, not
  // avatars.clothing["costumed:cowboy"] which doesn't exist.
  const resolveClothingDesc = (clothingDescriptions, category) => {
    if (!clothingDescriptions || !category) return '';
    // Costumed (bare or legacy 'costumed:<type>') — one costume per character,
    // so pick the first entry of the nested costumed object regardless of any
    // legacy subtype string.
    if (category === 'costumed' || category.startsWith('costumed:')) {
      const costumed = clothingDescriptions.costumed;
      if (typeof costumed === 'string') return costumed;
      if (costumed && typeof costumed === 'object') {
        // If legacy subtype-keyed, prefer the matching key; else first entry.
        if (category.startsWith('costumed:')) {
          const type = category.split(':')[1];
          if (costumed[type]) return costumed[type];
        }
        const firstCostume = Object.values(costumed).find(v => typeof v === 'string');
        if (firstCostume) return firstCostume;
      }
      return '';
    }
    if (clothingDescriptions[category]) return clothingDescriptions[category];
    return '';
  };

  // First, add characters from characterDescriptions (which have age/gender info)
  for (const [name, desc] of Object.entries(characterDescriptions || {})) {
    const position = expectedPositions?.[name] || expectedPositions?.[name.charAt(0).toUpperCase() + name.slice(1)] || '';
    // Use clothing from characterClothing map, or from parsed description (covers), or empty
    let clothingCategory = getClothing(name) || desc.clothing || '';
    // Resolve category names (standard/winter/summer/costumed:X) to actual descriptions
    let clothing = clothingCategory;
    if (desc.clothingDescriptions && clothingCategory) {
      const resolved = resolveClothingDesc(desc.clothingDescriptions, clothingCategory);
      if (resolved) {
        clothing = resolved;
      } else if (clothingCategory === 'standard' && desc.clothingDescriptions.standard) {
        clothing = desc.clothingDescriptions.standard;
      }
    }
    // Strip bare category labels — they're metadata tags, not wearable descriptions
    if (isCategoryLabel(clothing)) {
      clothing = '';
    }

    let description;
    if (desc.richDescription) {
      // For bbox DETECTION (not image generation), Gemini's safety filter is not
      // triggered by gender words — this is a text comprehension task on an
      // already-rendered image. Keep "boy"/"girl"/"man"/"woman": crucial for
      // disambiguating multiple characters. Only strip explicit numeric ages.
      const sanitized = desc.richDescription
        .replace(/\b\d+[-\s]?years?[-\s]?old\s+/gi, '')   // "7-year-old " → ""
        .replace(/\bage[sd]?\s*\d+\b/gi, '')              // "aged 7" → ""
        .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();
      // If we have a resolved per-page clothing, it OVERRIDES the baked-in
      // default clothing from richDescription. Without this, the detector
      // was told to look for "Lukas wearing striped hoodie" on a cowboy-page
      // where Lukas is actually in a cowboy costume — Gemini saw the
      // clothing mismatch and tagged every figure UNKNOWN.
      if (clothing) {
        const stripped = sanitized.replace(/\.?\s*Wearing:\s*[^.]+\.?\s*$/i, '').trim().replace(/[.,;]\s*$/, '');
        description = `${stripped}. Wearing: ${clothing}`;
      } else {
        description = sanitized;
      }
    } else {
      // Minimal description from prompt parsing — keep "character" placeholder
      // rather than "figure" (less likely to confuse the detector as a typo).
      const descParts = ['character'];
      if (clothing) descParts.push(clothing);
      description = descParts.join(', ');
    }
    // Concise grounding/identity prompt: identity (age/gender/hair/beard/
    // glasses) + a SHORT garment phrase. Feeds the SoM character lines (and
    // the layout fallback), so the garment must be a real visible garment:
    // structured clothing strings ("headwear: none; top: red striped shirt
    // under a leather vest; bottom: …") previously produced "wearing
    // headwear: none" (first segment naively taken) or a mid-word 50-char cut.
    const gdinoIdentity = desc.gdinoIdentity || null;
    let gdinoPrompt = null;
    if (gdinoIdentity) {
      const shortClothing = _shortGarmentPhrase(clothing);
      gdinoPrompt = shortClothing ? `${gdinoIdentity} wearing ${shortClothing}` : gdinoIdentity;
    }
    chars.push({
      name,
      description,
      position,
      // Clothing kept separate (in addition to being inside `description`) so the
      // GroundingDINO detection path can build negative/disambiguation prompts
      // from the OTHER characters' clothing on an overlap retry.
      clothing: clothing || '',
      // Concise prompt for GroundingDINO (null → detector falls back to `description`).
      gdinoPrompt,
    });
    addedNames.add(name.toLowerCase());
  }

  // Then, add any characters from expectedPositions that weren't in characterDescriptions.
  // Skip Visual-Bible IDs (e.g. "CHR001") entirely — they have no descriptive traits
  // for the detector and just add noise ("figure, costumed:wizard" is unmatchable).
  for (const [name, position] of Object.entries(expectedPositions || {})) {
    if (addedNames.has(name.toLowerCase())) continue;
    if (/^(CHR|LOC|ANI|VEH|ART|OBJ)\d+$/i.test(name)) {
      log.debug(`📦 [BBOX-BUILD] Skipping VB-id "${name}" — no descriptive traits available`);
      continue;
    }
    let clothing = getClothing(name);
    if (isCategoryLabel(clothing)) clothing = '';
    chars.push({
      name,
      description: clothing || 'character',
      position,
      clothing: clothing || ''
    });
    addedNames.add(name.toLowerCase());
    log.debug(`📦 [BBOX-BUILD] Added character "${name}" from expectedPositions (clothing: ${clothing || 'none'})`);
  }

  return chars;
}

/**
 * Create an overlay image with bounding boxes drawn on it
 * @param {string} imageData - Base64 image data
 * @param {Object} bboxDetection - Result from detectAllBoundingBoxes (includes qualityMatches, objectMatches)
 * @returns {Promise<string|null>} Base64 image with boxes drawn, or null on error
 */
async function createBboxOverlayImage(imageData, bboxDetection) {
  if (!bboxDetection || (!bboxDetection.figures?.length && !bboxDetection.objects?.length)) {
    return null;
  }

  try {
    // Extract base64 data
    const base64Match = imageData.match(/^data:image\/\w+;base64,(.+)$/);
    const base64Data = base64Match ? base64Match[1] : imageData;
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get image dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    // Build SVG overlay — figures, faces, and detected VB object boxes
    const svgParts = [`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`];

    const unknownColor = '#888888'; // Gray for unidentified figures

    // Draw figure boxes — each figure gets a unique color for both body and face
    for (let i = 0; i < (bboxDetection.figures || []).length; i++) {
      const fig = bboxDetection.figures[i];
      const isIdentified = fig.name && fig.name !== 'UNKNOWN';
      const figColor = isIdentified ? FIGURE_COLORS[i % FIGURE_COLORS.length].hex : unknownColor;

      // Body box
      if (fig.bodyBox) {
        const [ymin, xmin, ymax, xmax] = fig.bodyBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);

        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="4"/>`);

        // Label — character name or "? Figure N"
        const label = isIdentified ? fig.name : `? ${fig.label ? fig.label.substring(0, 25) : `Figure ${i + 1}`}`;
        const labelWidth = Math.min(label.length * 8 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${Math.max(0, y - 22)}" width="${labelWidth}" height="22" fill="${figColor}" opacity="0.9" rx="3"/>`);
        svgParts.push(`<text x="${x + 5}" y="${Math.max(16, y - 5)}" font-family="Arial" font-size="13" font-weight="bold" fill="white">${escapeXml(label)}</text>`);
      }

      // Raw GroundingDINO person box (dashed, dimmer) — shown when SAM tightened
      // it into the bodyBox above, so drift between the two is visible.
      if (fig.gdinoBox) {
        const [ymin, xmin, ymax, xmax] = fig.gdinoBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="2" stroke-dasharray="6,4" opacity="0.55"/>`);
        svgParts.push(`<text x="${x + 2}" y="${y + h - 4}" font-family="Arial" font-size="9" fill="${figColor}" opacity="0.7">dino${fig.score != null ? ` ${fig.score}` : ''}</text>`);
      }

      // Original Gemini face box (dashed, dimmer) — shown when cascade improved the face
      if (fig._geminiFaceBox && fig._cascadeFace) {
        const [ymin, xmin, ymax, xmax] = fig._geminiFaceBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="2" stroke-dasharray="6,4" opacity="0.5"/>`);
        svgParts.push(`<text x="${x + 2}" y="${y - 3}" font-family="Arial" font-size="9" fill="${figColor}" opacity="0.6">gemini</text>`);
      }

      // Final face box (solid = cascade-improved, or dashed = Gemini-only if no cascade)
      if (fig.faceBox) {
        const [ymin, xmin, ymax, xmax] = fig.faceBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        const isCascade = !!fig._cascadeFace;
        const isDinoFace = fig._faceSource === 'dino';
        const strokeStyle = (isCascade || isDinoFace) ? '' : ' stroke-dasharray="8,4"'; // solid if local detector, dashed if gemini-only
        const strokeWidth = (isCascade || isDinoFace) ? 4 : 3;
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="${strokeWidth}"${strokeStyle}/>`);
        // DINO face anchor — red dot at the face center
        if (isDinoFace) {
          svgParts.push(`<circle cx="${x + w / 2}" cy="${y + h / 2}" r="8" fill="#FF2D55" stroke="white" stroke-width="2.5"/>`);
        }
        // Face label
        const sourceTag = isCascade ? ` [${fig._cascadeFace}]` : isDinoFace ? ` [dino${fig._faceScore != null ? ` ${fig._faceScore}` : ''}]` : '';
        const faceLabel = isIdentified ? `FACE ${fig.name}${sourceTag}` : `FACE ${i + 1}${sourceTag}`;
        const faceLabelWidth = Math.min(faceLabel.length * 7 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${y + h}" width="${faceLabelWidth}" height="16" fill="${figColor}" opacity="0.9" rx="2"/>`);
        svgParts.push(`<text x="${x + 4}" y="${y + h + 12}" font-family="Arial" font-size="10" font-weight="bold" fill="white">${escapeXml(faceLabel)}</text>`);
      }
    }

    // Detected object boxes (VB props) — yellow dashed so they read apart from figures
    const objColor = '#FFD60A';
    for (const obj of (bboxDetection.objects || [])) {
      if (!obj?.bodyBox || obj.found === false) continue;
      const [ymin, xmin, ymax, xmax] = obj.bodyBox;
      const x = Math.round(xmin * width);
      const y = Math.round(ymin * height);
      const w = Math.round((xmax - xmin) * width);
      const h = Math.round((ymax - ymin) * height);
      svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${objColor}" stroke-width="3" stroke-dasharray="10,5"/>`);
      const objLabel = `${obj.label || obj.name}${obj.score != null ? ` ${obj.score}` : ''}`.substring(0, 40);
      const objLabelWidth = Math.min(objLabel.length * 7 + 10, 280);
      svgParts.push(`<rect x="${x}" y="${Math.min(height - 18, y + h)}" width="${objLabelWidth}" height="18" fill="${objColor}" opacity="0.9" rx="2"/>`);
      svgParts.push(`<text x="${x + 4}" y="${Math.min(height - 5, y + h + 13)}" font-family="Arial" font-size="11" font-weight="bold" fill="black">${escapeXml(objLabel)}</text>`);
    }

    svgParts.push('</svg>');
    const svgBuffer = Buffer.from(svgParts.join(''));

    // Composite SVG over image
    let resultBuffer = await sharp(imageBuffer)
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();

    // Cutout strip — per-figure SAM cutouts appended below the annotated page.
    // Masks arrive as a non-enumerable `_gdinoMasks` (index-aligned with
    // figures) so they exist only in-process, never in stories.data.
    const gdinoMasks = bboxDetection._gdinoMasks;
    if (Array.isArray(gdinoMasks) && gdinoMasks.some(Boolean)) {
      try {
        const STRIP_H = 260, GAP = 8, LABEL_H = 20;
        const tiles = [];
        for (let i = 0; i < (bboxDetection.figures || []).length; i++) {
          const maskPng = gdinoMasks[i];
          const fig = bboxDetection.figures[i];
          if (!maskPng || !fig?.bodyBox) continue;
          const [ymin, xmin, ymax, xmax] = fig.bodyBox;
          const pad = 12;
          const ex = Math.max(0, Math.round(xmin * width) - pad);
          const ey = Math.max(0, Math.round(ymin * height) - pad);
          const ew = Math.min(width, Math.round(xmax * width) + pad) - ex;
          const eh = Math.min(height, Math.round(ymax * height) + pad) - ey;
          if (ew < 4 || eh < 4) continue;
          // Two steps — sharp applies extract BEFORE composite regardless of
          // call order, so masking and cropping must be separate pipelines.
          const masked = await sharp(imageBuffer).ensureAlpha()
            .composite([{ input: maskPng, blend: 'dest-in' }])
            .png().toBuffer();
          const cut = await sharp(masked)
            .extract({ left: ex, top: ey, width: ew, height: eh })
            .resize({ height: STRIP_H - LABEL_H })
            .png().toBuffer();
          const cutMeta = await sharp(cut).metadata();
          tiles.push({ png: cut, w: cutMeta.width, name: fig.name || `Figure ${i + 1}`, named: !!(fig.name && fig.name !== 'UNKNOWN') });
        }
        if (tiles.length > 0) {
          const stripW = width;
          // Named characters lead the strip — on crowd pages the row must
          // never cut off a named figure in favour of background UNKNOWNs.
          tiles.sort((a, b) => Number(b.named) - Number(a.named));
          // Shrink-to-fit instead of dropping: scale every tile by the same
          // factor so all cutouts stay visible (floor 35% to keep them
          // recognisable; below that the smallest UNKNOWNs are dropped).
          const totalW = tiles.reduce((s, t) => s + t.w, 0) + GAP * (tiles.length + 1);
          let scale = Math.min(1, (stripW - GAP * (tiles.length + 1)) / Math.max(1, tiles.reduce((s, t) => s + t.w, 0)));
          while (scale < 0.35 && tiles.length > 1 && !tiles[tiles.length - 1].named) {
            tiles.pop();
            scale = Math.min(1, (stripW - GAP * (tiles.length + 1)) / Math.max(1, tiles.reduce((s, t) => s + t.w, 0)));
          }
          if (scale < 1) {
            for (const t of tiles) {
              const h = Math.max(24, Math.round((STRIP_H - LABEL_H) * scale));
              t.png = await sharp(t.png).resize({ height: h }).png().toBuffer();
              t.w = (await sharp(t.png).metadata()).width;
            }
          }
          let cursor = GAP;
          const comps = [];
          const labelSvg = [`<svg width="${stripW}" height="${STRIP_H}" xmlns="http://www.w3.org/2000/svg">`];
          for (const t of tiles) {
            if (cursor + t.w > stripW) break; // safety — should not trigger after scaling
            comps.push({ input: t.png, left: cursor, top: GAP });
            labelSvg.push(`<text x="${cursor + 4}" y="${STRIP_H - 6}" font-family="Arial" font-size="14" font-weight="bold" fill="white">${escapeXml(t.name)}</text>`);
            cursor += t.w + GAP;
          }
          labelSvg.push('</svg>');
          const strip = await sharp({ create: { width: stripW, height: STRIP_H, channels: 3, background: { r: 34, g: 34, b: 34 } } })
            .composite([...comps, { input: Buffer.from(labelSvg.join('')), top: 0, left: 0 }])
            .jpeg({ quality: 85 }).toBuffer();
          resultBuffer = await sharp({ create: { width, height: height + STRIP_H, channels: 3, background: { r: 34, g: 34, b: 34 } } })
            .composite([{ input: resultBuffer, top: 0, left: 0 }, { input: strip, top: height, left: 0 }])
            .jpeg({ quality: 85 }).toBuffer();
        }
      } catch (stripErr) {
        log.debug(`📦 [BBOX-OVERLAY] cutout strip skipped: ${stripErr.message}`);
      }
    }

    const result = 'data:image/jpeg;base64,' + resultBuffer.toString('base64');
    const figCount = bboxDetection.figures?.length || 0;
    const objCount = (bboxDetection.objects || []).filter(o => o.found !== false && o.bodyBox).length;
    log.debug(`📦 [BBOX-OVERLAY] Created overlay image: ${figCount} figures, ${objCount} objects (${Math.round(resultBuffer.length / 1024)}KB)`);
    return result;

  } catch (error) {
    log.error(`❌ [BBOX-OVERLAY] Error creating overlay: ${error.message}`);
    return null;
  }
}

// Helper to escape XML special characters
function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


/**
 * Detect all bounding boxes in image and match to fixable issues
 * Single API call detects ALL figures, faces, and objects for dev mode display
 *
 * @param {string} imageData - Base64 image data
 * @param {Array<{description: string, severity: string, type: string, fix: string}>} fixableIssues - Issues from quality eval
 * @param {Array<{figure: number, reference: string, confidence: number, position: string, hair: string, clothing: string}>} qualityMatches - Character→figure mapping from quality eval (legacy, not used)
 * @param {Array<{reference: string, type: string, position: string, appearance: string, confidence: number}>} objectMatches - Object/animal/landmark matches from quality eval (legacy, not used)
 * @returns {Promise<{targets: Array, detectionHistory: Object}>} - Enriched fix targets and full detection for display
 */
async function enrichWithBoundingBoxes(imageData, fixableIssues, qualityMatches = [], objectMatches = [], expectedPositions = {}, expectedObjects = [], characterDescriptions = {}, characterClothing = {}, sceneContext = null, bboxModelOverride = null, pageContext = '', sharedBboxDetection = null, artStyle = null, objectGroundingHints = null) {
  // Build expected characters for bbox detection (AI will identify by name)
  const expectedCharacters = buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing);

  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Reuse shared bbox detection if provided (avoids redundant API call)
  let allDetections;
  if (sharedBboxDetection && !bboxPairsWith(sharedBboxDetection, imageData)) {
    log.warn(`⚠️ [BBOX-ENRICH] ${pageLabel}Shared bbox was computed on DIFFERENT image bytes (stale version) — discarding, re-detecting`);
    sharedBboxDetection = null;
  }
  if (sharedBboxDetection) {
    log.info(`♻️  [BBOX-ENRICH] ${pageLabel}Reusing shared bbox detection (${sharedBboxDetection.figures?.length || 0} figures, ${sharedBboxDetection.objects?.length || 0} objects)`);
    allDetections = sharedBboxDetection;
  } else {
    log.info(`📦 [BBOX-ENRICH] ${pageLabel}Detecting figures/objects with ${expectedCharacters.length} expected characters, ${expectedObjects.length} expected objects${sceneContext ? ', with scene context' : ''}${bboxModelOverride ? `, model: ${bboxModelOverride}` : ''}...`);
    allDetections = await detectAllBoundingBoxes(imageData, {
      expectedCharacters,
      expectedObjects,
      sceneContext,
      bboxModelOverride,
      pageContext,
      artStyle,
      objectGroundingHints
    });
  }

  if (!allDetections) {
    log.warn(`🔄 [FALLBACK] Detection failed, no bounding boxes available`);
    return { targets: [], detectionHistory: null };
  }

  log.info(`📦 [BBOX-ENRICH] Found ${allDetections.figures.length} figures, ${allDetections.objects.length} objects`);

  // Direct mapping - AI already labeled figures with character names
  const charToDetectionFigure = {};
  const unknownFigures = [];
  for (const figure of allDetections.figures) {
    if (figure.name && figure.name !== 'UNKNOWN') {
      charToDetectionFigure[figure.name.toLowerCase()] = figure;
      log.verbose(`📦 [BBOX-ENRICH] Character identified: "${figure.name}" (${figure.confidence}) → "${figure.label}"`);
    } else {
      unknownFigures.push(figure);
    }
  }

  if (Object.keys(charToDetectionFigure).length > 0) {
    log.info(`📦 [BBOX-ENRICH] Identified ${Object.keys(charToDetectionFigure).length} characters: ${Object.keys(charToDetectionFigure).join(', ')}`);
  }
  if (unknownFigures.length > 0) {
    log.info(`📦 [BBOX-ENRICH] ${unknownFigures.length} UNKNOWN figures: ${unknownFigures.map(f => f.label).join(', ')}`);
  }

  // Track position mismatches between expected and detected
  const positionMismatches = [];
  const foundCharacters = new Set(Object.keys(charToDetectionFigure).map(n => n.toLowerCase()));

  for (const [charNameLower, figure] of Object.entries(charToDetectionFigure)) {
    // Find expected position (try both lowercase and capitalized versions)
    const charName = charNameLower.charAt(0).toUpperCase() + charNameLower.slice(1);
    const expectedPos = expectedPositions[charName] || expectedPositions[charNameLower];
    if (expectedPos) {
      const expectedLCR = getStoryHelpers().normalizePositionToLCR(expectedPos);
      if (expectedLCR && figure.position && figure.position !== expectedLCR) {
        positionMismatches.push({
          character: charName,
          expected: expectedPos,
          expectedLCR: expectedLCR,
          actual: figure.position
        });
        log.debug(`📍 [BBOX-ENRICH] Position note: "${charName}" expected at ${expectedLCR} (${expectedPos}) but detected at ${figure.position}`);
      }
    }
  }

  // Detect missing characters (expected in scene but not identified by AI)
  const missingCharacters = Object.keys(expectedPositions)
    .filter(name => !foundCharacters.has(name.toLowerCase()));
  if (missingCharacters.length > 0) {
    log.info(`📍 [BBOX-ENRICH] Missing characters (expected but not identified): ${missingCharacters.join(', ')}`);
  }

  // Object tracking is now direct from detection results
  const foundObjects = allDetections.foundObjects || [];
  const missingObjects = allDetections.missingObjects || [];
  const matchedExpectedObjects = foundObjects.map(name => ({ expected: name, matched: name }));

  if (foundObjects.length > 0 || missingObjects.length > 0) {
    log.info(`📦 [BBOX-ENRICH] Objects: ${foundObjects.length} found, ${missingObjects.length} missing`);
  }

  // Build detection history for dev mode display
  const detectionHistory = {
    figures: allDetections.figures,
    objects: allDetections.objects,
    expectedCharacters: allDetections.expectedCharacters,
    expectedObjects: allDetections.expectedObjects,
    expectedPositions: Object.keys(expectedPositions).length > 0 ? expectedPositions : undefined,
    positionMismatches: positionMismatches.length > 0 ? positionMismatches : undefined,
    missingCharacters: missingCharacters.length > 0 ? missingCharacters : undefined,
    foundObjects: foundObjects.length > 0 ? foundObjects : undefined,
    missingObjects: missingObjects.length > 0 ? missingObjects : undefined,
    matchedObjects: matchedExpectedObjects.length > 0 ? matchedExpectedObjects : undefined,
    unknownFigures: unknownFigures.length,
    characterDescriptions: Object.keys(characterDescriptions).length > 0 ? characterDescriptions : undefined,
    usage: allDetections.usage,
    rawPrompt: allDetections.rawPrompt,
    rawResponse: allDetections.rawResponse,
    // Which backend produced this + GroundingDINO per-figure diagnostics (raw
    // batched scores, recovery, low-conf flags, collisions, fallback reason) so
    // detection is debuggable from the stored record, not only live logs.
    detectionBackend: allDetections.detectionBackend,
    gdinoDiag: allDetections.gdinoDiag,
    // Byte-pairing stamp (see imageFingerprint) — must survive this rebuild,
    // detectionHistory IS the object persisted as bboxDetection. The shared
    // detection was verified against imageData above, so its fp equals ours.
    sourceImageFp: allDetections.sourceImageFp || imageFingerprint(imageData),
    timestamp: new Date().toISOString()
  };
  // Carry the in-process SAM mask PNGs across to the overlay renderer
  // (non-enumerable — never serialized into stories.data).
  if (allDetections._gdinoMasks) {
    Object.defineProperty(detectionHistory, '_gdinoMasks', { value: allDetections._gdinoMasks, enumerable: false });
  }

  // If no issues to fix, just return the detections
  if (!fixableIssues || fixableIssues.length === 0) {
    return { targets: [], detectionHistory };
  }

  // Match issues to detected elements for repair targets
  // Now uses direct character name matching from AI identification
  const enrichedTargets = [];
  const allElements = [
    ...allDetections.figures.map(f => ({ ...f, elementType: 'figure' })),
    ...allDetections.objects.map(o => ({ ...o, elementType: 'object', faceBox: null }))
  ];

  // Helper: extract character names mentioned in issue text
  const extractCharacterNames = (text) => {
    const textLower = (text || '').toLowerCase();
    const foundChars = [];
    for (const charName of Object.keys(charToDetectionFigure)) {
      const escapedName = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedName}(?:[\u2019']s)?\\b`, 'i');
      if (regex.test(textLower)) {
        foundChars.push(charName);
      }
    }
    return foundChars;
  };

  // Helper: extract meaningful keywords from text
  const commonWords = new Set(['with', 'that', 'this', 'from', 'have', 'been', 'were', 'being', 'their', 'there', 'which', 'would', 'could', 'should', 'about', 'figure', 'image', 'shown', 'visible']);
  const extractKeywords = (text) => {
    return (text || '').toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !commonWords.has(w));
  };

  // Only character-targeted issues get bbox enrichment. Object / scene /
  // composition issues ("wooden crossbow is missing", "extra building in
  // background", "deep shadow band at bottom") pass through as text only —
  // they flow downstream through the consolidator (inpaintPage → Haiku →
  // scene_fix.instruction), which doesn't need a per-issue bbox.
  //
  // The bbox detector doesn't reliably localise objects today: expected
  // objects that aren't found come back as found:false/null-bbox, and even
  // when they ARE found, the old targeted-magenta inpaint rarely improved
  // them. Skipping those issues here eliminated a noisy "Could not match"
  // log spam (~48 warnings per run) without losing real repair capability
  // — the main pipeline already handles non-character fixes via prose.
  //
  // Revive object bbox-enrichment when/if we build a dedicated
  // object-targeted repair pass. For now, character-only keeps the path
  // simple and honest about what actually works.
  const characterTypes = new Set(['face', 'hand', 'clothing', 'limb', 'proportion']);
  const isCharacterIssue = (issue) => {
    if (issue.character) return true;
    if (issue.type && characterTypes.has(String(issue.type).toLowerCase())) return true;
    // Fallback: issue text mentions a known character name.
    return extractCharacterNames((issue.description || '') + ' ' + (issue.fix || '')).length > 0;
  };

  for (const issue of fixableIssues) {
    if (!isCharacterIssue(issue)) {
      log.verbose(`📦 [BBOX-ENRICH] Skipping non-character issue (passes through as text): ${(issue.description || '').substring(0, 60)}`);
      continue;
    }

    const issueDesc = (issue.description || '').toLowerCase();
    const issueFix = (issue.fix || '').toLowerCase();
    const issueKeywords = extractKeywords(issueDesc + ' ' + issueFix);

    let bestMatch = null;
    let matchedCharacter = null;

    // PRIORITY 1: Use explicit character field from Pass 2 fixable_issues
    if (issue.character) {
      const charKey = issue.character.toLowerCase();
      const figure = charToDetectionFigure[charKey];
      if (figure) {
        bestMatch = { ...figure, elementType: 'figure' };
        matchedCharacter = charKey;
        log.debug(`📦 [BBOX-ENRICH] Issue has character="${issue.character}" → direct match to "${figure.label}"`);
      }
    }

    // PRIORITY 2: Check if issue text mentions a character name we know about
    if (!bestMatch) {
      const mentionedChars = extractCharacterNames(issueDesc + ' ' + issueFix);
      if (mentionedChars.length > 0) {
        for (const charName of mentionedChars) {
          const figure = charToDetectionFigure[charName];
          if (figure) {
            bestMatch = { ...figure, elementType: 'figure' };
            matchedCharacter = charName;
            log.verbose(`📦 [BBOX-ENRICH] Issue mentions "${charName}" → direct match to "${figure.label}"`);
            break;
          }
        }
      }
    }

    // Fallback: character-type issues without an explicit character name or
    // mention get pinned to the most likely figure (identified character, or
    // largest figure as a last resort). Object issues are filtered out above
    // and never reach this block — see the isCharacterIssue gate.
    if (!bestMatch) {
      // If the issue explicitly NAMES a character we know but PRIORITY 1/2
      // couldn't find that character's detected figure, do NOT fall back to a
      // different person's figure — repairing the wrong character (e.g.
      // Patrick's clothing issue pinned to Nicole's figure) is worse than
      // leaving it text-only. Only the last-resort largest/identified-figure
      // fallback is for GENERIC "a child / the boy" issues that name nobody.
      const namesAKnownChar = !!issue.character
        || extractCharacterNames(issueDesc + ' ' + issueFix).length > 0;
      if (namesAKnownChar) {
        log.debug(`📦 [BBOX-ENRICH] Issue names a character whose figure wasn't detected — leaving text-only (not mis-assigning to another person): "${(issue.description || '').substring(0, 60)}"`);
      } else if (issue.type === 'face' || issue.type === 'hand' || issue.type === 'clothing'
                 || issue.type === 'accessory' || issue.type === 'accessory_missing') {
        // For character-related issues, prefer identified characters or largest figure
        const identifiedFigures = allDetections.figures.filter(f => f.name && f.name !== 'UNKNOWN');
        if (identifiedFigures.length > 0) {
          bestMatch = { ...identifiedFigures[0], elementType: 'figure' };
        } else if (allDetections.figures.length > 0) {
          // Use largest figure
          bestMatch = allDetections.figures.reduce((largest, fig) => {
            const getArea = (box) => box ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
            return getArea(fig.bodyBox) > getArea(largest?.bodyBox) ? fig : largest;
          }, allDetections.figures[0]);
          bestMatch = { ...bestMatch, elementType: 'figure' };
        }
      } else {
        // Character-typed issue we couldn't confidently pin to a figure —
        // leave it text-only. Better than repairing the wrong region.
        log.debug(`📦 [BBOX-ENRICH] Issue "${(issue.description || '').substring(0, 60)}" — no matching figure, skipping`);
      }
    }

    if (bestMatch) {
      // Choose appropriate box based on issue type
      let boundingBox = bestMatch.bodyBox || bestMatch.faceBox;
      if (issue.type === 'face' && bestMatch.faceBox) {
        boundingBox = bestMatch.faceBox;
      }

      enrichedTargets.push({
        faceBox: bestMatch.faceBox,
        bodyBox: bestMatch.bodyBox,
        boundingBox: boundingBox,
        bounds: boundingBox,
        issue: issue.description,
        fix_instruction: issue.fix || `Fix: ${issue.description}`,
        severity: issue.severity,
        type: issue.type,
        element: issue.type,
        affectedCharacter: matchedCharacter || bestMatch.name,
        fixPrompt: issue.fix || `Fix: ${issue.description}`,
        label: bestMatch.label,
        matchedPosition: bestMatch.position,
        matchMethod: matchedCharacter ? 'character' : 'fallback',
        matchedCharacter: matchedCharacter || (bestMatch.name !== 'UNKNOWN' ? bestMatch.name : null)
      });
      log.verbose(`📊 [EVAL] Matched: "${issue.description.substring(0, 30)}..." → "${bestMatch.label}" (${matchedCharacter ? 'character' : 'fallback'})`);
    } else {
      // Missing-character/element issues have no bbox by definition — that's
      // the issue. Only warn when we expected to find a region.
      const isMissing = issue.type === 'missing_character' || issue.type === 'missing_element' ||
        /\b(missing|entirely missing|not present|absent)\b/i.test(issue.description || '');
      if (isMissing) {
        log.debug(`[BBOX-ENRICH] No bbox for missing-element issue: ${issue.description.substring(0, 50)}...`);
      } else {
        log.warn(`[BBOX-ENRICH] Could not match issue: ${issue.description.substring(0, 50)}...`);
      }
    }
  }

  // Summarize matching methods used
  const byChar = enrichedTargets.filter(t => t.matchMethod === 'character').length;
  const byFallback = enrichedTargets.filter(t => t.matchMethod === 'fallback').length;
  const methodSummary = [
    byChar > 0 ? `${byChar} by character name` : null,
    byFallback > 0 ? `${byFallback} by fallback` : null
  ].filter(Boolean).join(', ');
  log.info(`📦 [BBOX-ENRICH] Matched ${enrichedTargets.length}/${fixableIssues.length} issues to detected elements${methodSummary ? ` (${methodSummary})` : ''}`);

  return { targets: enrichedTargets, detectionHistory };
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

function sectionAwareCut(prompt, maxLen, logLabel) {
  // Keep the tail sections (REQUIRED OBJECTS + ART STYLE) whole; cut the
  // excess from the end of the head prose instead.
  const objIdx = prompt.indexOf('**REQUIRED OBJECTS');
  const styleIdx = prompt.indexOf('**ART STYLE');
  const tailStart = objIdx >= 0 ? objIdx : styleIdx;
  if (tailStart < 0) return truncatePromptForModel(prompt, maxLen, logLabel);
  const tail = prompt.slice(tailStart);
  const headBudget = maxLen - tail.length - 5;
  if (headBudget < 500) return truncatePromptForModel(prompt, maxLen, logLabel); // tail alone ~fills the budget
  log.warn(`✂️ [${logLabel}] Section-aware cut: head ${tailStart}→${headBudget} chars, tail sections kept whole`);
  return prompt.slice(0, headBudget) + '\n...\n' + tail;
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
        const words = Math.floor((headBudget * 0.9) / 6.5);
        const instruction = `Rewrite the scene description below to at most ${words} words, keeping every fact — `
          + `every character with their outfit, position and expression; every object; the composition. `
          + `State every character's age band and body proportions explicitly (e.g. kindergarten-age about 5 heads tall, adult about 7.5-8 heads tall). `
          + `Remove only repetition and filler. Same format, same section headers. Output ONLY the rewritten description.\n\n${head}`;
        // 12k budget: flash 2.5 spends ~4k tokens THINKING before it writes —
        // at 4k total the answer came back as a 158-token stub cut mid-sentence.
        const res = await callTextModel(instruction, 12000, 'gemini-2.5-flash', { usageLabel: 'prompt_compress', temperature: 0 });
        const newHead = (res?.text || '').trim();
        if (newHead.length > 500 && newHead.length <= headBudget) {
          const assembled = newHead + (rulesBlock ? '\n\n' + rulesBlock : '') + (frameBlock ? '\n\n' + frameBlock : '') + '\n\n' + tail;
          log.info(`✂️ [${logLabel}] Prompt ${prompt.length}→${assembled.length} chars via head compression (budget ${maxPromptLength}, tail ${tail.length} + rules + frame map kept verbatim)`);
          return assembled;
        }
        log.warn(`✂️ [${logLabel}] Head compression unusable (${newHead.length} chars vs budget ${headBudget}) — falling back to section-aware cut`);
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
    captureLabel = null
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
      const qualityResult = await evaluateImageQuality(
        img.imageData,
        sceneDescWithClothing,
        img.allCharacterPhotos || img.characterPhotos || [],
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

      // Log character/position data for debugging bbox expected list
      if (Object.keys(expectedCharacterPositions).length > Object.keys(characterDescriptions).length) {
        const sceneOnly = Object.keys(expectedCharacterPositions).filter(n => !characterDescriptions[n]);
        if (sceneOnly.length > 0) {
          log.debug(`📦 [BATCH EVAL] PAGE ${img.pageNumber}: ${sceneOnly.length} secondary character(s) from scene metadata: ${sceneOnly.join(', ')}`);
        }
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
          buildObjectGroundingHints(allExpectedObjects, visualBible)
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
    // No artStyle here — the source image already carries the style and Grok
    // matches the surrounding pixels. Passing the resolved style descriptor
    // duplicates information and, in practice, regressed inpaint quality
    // versus the manual-repair path (which passes none).
    const editResult = await editImageWithPrompt(imageData, fullInstruction, undefined, referenceImages, null, aspectRatio);
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
    const poseByName = new Map();
    for (const sc of metaChars) {
      const nm = (typeof sc === 'string' ? sc : sc?.name) || '';
      if (!nm) continue;
      const pose = (sc?.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(sc.pose))
        ? sc.pose : 'threeQuarter';
      // Depth drives whether we include the head cell alongside the body
      // cell. Foreground (close-up canvas-large faces) gets head+body
      // stacked; midground / background get body only — the face inside
      // the body cell is enough at that scale, and a separate head ref
      // would just add noise for a small-on-canvas figure.
      const depth = (sc?.depth && ['foreground', 'midground', 'background'].includes(sc.depth))
        ? sc.depth : 'foreground';
      poseByName.set(nm.toLowerCase(), { pose, depth });
    }
    for (const ref of referencePhotos) {
      const charName = ref.name;
      if (!charName) continue;
      const story = storyData.characterAvatars[charName];
      if (!story) continue;
      const clothingRaw = String(ref.clothingCategory || '').toLowerCase();
      let slotKey;
      if (clothingRaw.startsWith('costumed')) slotKey = 'costumed';
      else if (clothingRaw === 'standard' || clothingRaw === 'winter' || clothingRaw === 'summer') slotKey = `styled-${clothingRaw}`;
      else slotKey = 'costumed';
      const sheetUri = story[slotKey] || story.costumed;
      if (!sheetUri) continue;
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
  const iterateSceneMetadata = newSceneMetadata;

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
        iterDetection = await detectAllBoundingBoxes(genResult.imageData, {
          expectedCharacters: (sceneCharacters || []).map(c => ({
            name: c.name || c,
            description: typeof c === 'object' ? (c.description || '') : '',
          })),
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

  // Two-stage bounding box detection
  detectAllBoundingBoxes,
  imageFingerprint,
  bboxPairsWith,
  detectionForVersion,
  // Region/geometry + treatment helpers consumed by the unified faceRepair.js.
  // Exported (minimal) rather than duplicated so the merge stays single-source.
  REPAIR_SHARPNESS_MIN_ORIG,
  REPAIR_SHARPNESS_REJECT_RATIO,
  closestGrokAspect,
  detectSubRegion,  // Sub-region detection for targeted repairs (shoes, shirt, hands, etc.)
  createBboxOverlayImage,  // Create overlay image with boxes drawn
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
