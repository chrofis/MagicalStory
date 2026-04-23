/**
 * Image Generation Module
 * Handles image generation, quality evaluation, editing, and retry logic
 * Extracted from server.js for maintainability
 */

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
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, IMAGE_MODELS, REPAIR_DEFAULTS, TEXT_MODELS } = require('../config/models');
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
// Grid-based repair (lazy-loaded to avoid circular dependencies)
let gridBasedRepairModule = null;
function getGridBasedRepair() {
  if (!gridBasedRepairModule) {
    gridBasedRepairModule = require('./gridBasedRepair');
  }
  return gridBasedRepairModule;
}

// storyHelpers functions (lazy-loaded to avoid circular dependencies)
let storyHelpersModule = null;
function getStoryHelpers() {
  if (!storyHelpersModule) {
    storyHelpersModule = require('./storyHelpers');
  }
  return storyHelpersModule;
}

// Character photo helpers
const { getFacePhoto } = require('./characterPhotos');

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
      body: JSON.stringify(body)
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

/**
 * Simplify prompt to core scene elements only (Level 2 sanitization)
 * Keeps: art style, character names/positions, setting, time, weather
 * Removes: detailed descriptions, mood, atmosphere
 */
function sanitizePromptLevel2(prompt) {
  // Try to extract key elements from the prompt
  const settingMatch = prompt.match(/Setting:\s*([^\n|]+)/i);
  const timeMatch = prompt.match(/Time:\s*([^\n|]+)/i);
  const styleMatch = prompt.match(/(?:art\s*style|style):\s*([^\n,]+)/i);
  const charMatches = prompt.match(/(?:Characters?|Character Reference).*?(?:\n|:)([\s\S]*?)(?=Setting:|Key objects:|$)/i);

  const setting = settingMatch ? settingMatch[1].trim() : 'a scenic location';
  const time = timeMatch ? timeMatch[1].trim() : 'daytime';
  const style = styleMatch ? styleMatch[1].trim() : 'watercolor';

  // Extract just character names
  let characters = 'a child';
  if (charMatches) {
    const names = charMatches[1].match(/[\w]+(?:\s+[\w]+)?(?=\s*\()/g);
    if (names) characters = names.join(' and ');
  }

  return `A ${style} illustration of ${characters} in ${setting} during ${time}. Warm, friendly, child-appropriate scene. Bright colors, soft lighting.`;
}

/**
 * Build minimal fallback prompt (Level 3 sanitization)
 */
function sanitizePromptLevel3(artStyle) {
  const style = artStyle || 'watercolor';
  return `A beautiful ${style} illustration of a happy child on an adventure in a colorful, magical setting. Bright, warm colors. Friendly atmosphere. Child-appropriate.`;
}

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
const MAX_MASK_COVERAGE_PERCENT = 25;

/**
 * Hash image data for comparison/caching
 * @param {string} imageData - Base64 image data URL
 * @returns {string} Short hash (8 characters)
 */
function hashImageData(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const data = imageData.replace(/^data:image\/\w+;base64,/, '');
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
      const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
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
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

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
    const base64Data = pngBase64.replace(/^data:image\/\w+;base64,/, '');

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
      log.warn(`⚠️ [QUALITY P1] API error: ${errText.substring(0, 200)}`);
      return null;
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
  const { sceneDescription = null, skipVision = false, characterPlacements = null, mainScenePrompt = null } = options;
  try {
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
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

    // Check 3: text area calmness — white text needs a DARK and smooth zone.
    // The calmness metric now rewards darkness (brightness inverted) and low
    // variance. Anything below 0.15 fails and triggers text-space-repair.
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
          const bNorm = blockBrightness[r * cols + c] / 255;
          const vNorm = blockVariance[r * cols + c] / vMax;
          textAreaCalm += Math.pow(1 - bNorm, 1.5) * (1 - vNorm);
          textAreaCount++;
        }
      }
    }
    const calmnessScore = textAreaCount > 0 ? textAreaCalm / textAreaCount : 0;

    if (calmnessScore < 0.15 && textPosition) {
      issues.push(`text area too busy/bright: calmness ${(calmnessScore * 100).toFixed(0)}% at ${textPosition}`);
    }

    // ── Phase 2: Gemini Flash-lite vision check ──
    // Catches things pixels can't: people/figures, wrong landmark, content errors.
    let visionFeedback = null;
    if (!skipVision && issues.length === 0) {
      try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (apiKey) {
          const base64ForVision = imageData.replace(/^data:image\/\w+;base64,/, '');
          const mimeType = imageData.match(/^data:(image\/\w+);/)?.[1] || 'image/jpeg';

          const sceneCtx = sceneDescription
            ? `\nEXPECTED SCENE: "${sceneDescription.substring(0, 300)}"`
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

          const visionUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
          const visionResp = await fetch(visionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [
                { inline_data: { mime_type: mimeType, data: base64ForVision } },
                { text: `This is a background scene for a children's book illustration. Small background figures, animals, and distant people are fine — they add life to the scene.${sceneCtx}${placementsBlock}${mainSceneBlock}

Check:
1. Does the setting/location roughly match the expected scene? (FAIL if completely wrong location — e.g. expected a forest but got a city)
2. Are there large artificial-looking patches — white rectangles, solid color blocks, or obvious AI glitches? (FAIL)
3. Is there visible open space in the foreground where main characters could be placed later? (FAIL if the entire foreground is filled with objects or walls)${placementsCheck}${geometryCheck}

Reply JSON only: {"pass": true/false, "issues": ["short issue"], "feedback": "one sentence describing what to fix if failed, or empty if passed"}` }
              ]}],
              generationConfig: { maxOutputTokens: 250, temperature: 0.1, responseMimeType: 'application/json' },
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
  const { qualityModelOverride = null, pageContext = '', storyText = null } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  const visionPrompt = PROMPT_TEMPLATES.imageVisionInventory;
  const complianceTemplate = PROMPT_TEMPLATES.imagePromptCompliance;

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

    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
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
            generationConfig: { maxOutputTokens: 4096, temperature: 0.3 },
            safetySettings: GEMINI_SAFETY_SETTINGS
          })
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

  // --- Stage 2: Prompt compliance with Haiku (text only, NO image) ---
  let complianceResult = null;
  let stage2Usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const complianceInput = fillTemplate(complianceTemplate, {
      ORIGINAL_PROMPT: (imagePrompt || '').substring(0, 3000),
      VISUAL_INVENTORY: visionText,
      INTERACTIONS_BLOCK: interactionsBlock,
      STORY_TEXT: (storyText || '(not provided)').substring(0, 2000)
    });

    const { callTextModel } = require('./textModels');
    // Stage 2 uses Sonnet — Haiku didn't reliably follow the "ignore prose
    // decoration unless it's a DECLARED INTERACTION" rule and kept flagging
    // false-positive gaze/facing issues that drove pointless repair rounds.
    const sonnetResult = await callTextModel(complianceInput, 4096, 'claude-sonnet');

    stage2Usage = {
      input_tokens: sonnetResult.usage?.input_tokens || 0,
      output_tokens: sonnetResult.usage?.output_tokens || 0
    };

    // Parse JSON from compliance response
    const parsed = getStoryHelpers().extractJsonFromText(sonnetResult.text);
    if (parsed && typeof parsed.score === 'number') {
      complianceResult = parsed;
    } else {
      log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 could not parse JSON from Sonnet response`);
      return null;
    }

    log.info(`[THREE-STAGE] ${pageLabel}Stage 2 compliance: score=${complianceResult.score}/10, verdict=${complianceResult.verdict || 'N/A'}`);
  } catch (err) {
    log.warn(`[THREE-STAGE] ${pageLabel}Stage 2 failed: ${err.message}`);
    return null;
  }

  // Parse fixable issues from compliance result
  let fixableIssues = [];
  if (Array.isArray(complianceResult.fixable_issues)) {
    fixableIssues = complianceResult.fixable_issues
      .filter(i => i.description)
      .map(i => ({
        description: i.description,
        severity: i.severity || 'MODERATE',
        type: i.type || 'default',
        fix: i.fix || `Fix: ${i.description}`
      }));
  }

  // Convert 0-10 score to 0-100
  const score100 = complianceResult.score * 10;

  // Issues summary
  let issuesSummary = complianceResult.issues_summary || '';
  if (Array.isArray(issuesSummary)) {
    issuesSummary = issuesSummary.join('. ');
  }

  return {
    score: score100,
    rawScore: complianceResult.score,
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

async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null, pageContext = '', storyText = null, sceneHint = null, sceneCharacters = null) {
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

    // Start semantic evaluation in parallel if story text provided (for scene evaluations)
    let semanticPromise = null;
    if (storyText && evaluationType === 'scene') {
      const { evaluateSemanticFidelity } = require('./sceneValidator');
      semanticPromise = evaluateSemanticFidelity(imageData, storyText, originalPrompt, sceneHint);
      log.debug('🔍 [QUALITY] Starting parallel semantic fidelity evaluation');
    }

    // Start three-stage eval in parallel for scene evaluations
    let threeStagePromise = null;
    if (evaluationType === 'scene') {
      threeStagePromise = evaluateThreeStage(imageData, originalPrompt, sceneHint, { qualityModelOverride, pageContext, storyText });
      log.debug(`📊 [QUALITY] Starting parallel three-stage evaluation`);
    }

    // Extract base64 and mime type for generated image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Use standard evaluation for all images (scenes + covers)
    // Covers get the expected text prepended so the evaluator checks text accuracy too
    let evaluationTemplate;
    if (PROMPT_TEMPLATES.imageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      log.verbose(`📊 [EVAL] Using standard evaluation (${evaluationType})`);
    } else {
      evaluationTemplate = null;
    }

    // Determine model to use (parameter override > config default > fallback)
    // let: may be reassigned to fallback model on content block
    let modelId = qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';

    // Pre-sanitize for 2.5 models to reduce content blocking on first attempt
    let promptForEval = modelId.includes('2.5') ? sanitizeForGemini(originalPrompt, 'light') : originalPrompt;

    // For cover evaluations: strip art style noise and prepend expected text prominently
    if (evaluationType === 'cover' && promptForEval) {
      // Extract expected text
      const titleMatch = promptForEval.match(/MUST include this exact (?:title |dedication )?text:\s*"([^"]+)"/i);
      const magicalMatch = promptForEval.match(/MUST include this exact text:\s*"(magicalstory\.ch)"/i);
      const expectedText = titleMatch?.[1] || magicalMatch?.[1];

      // Strip art style description (noise for evaluator)
      promptForEval = promptForEval.replace(/\*\*ART STYLE[^*]*\*\*[^*]*(?=\*\*|$)/s, '');

      if (expectedText) {
        promptForEval = `⚠️ TEXT RULES FOR THIS IMAGE (HARD FAIL):\nAllowed text: "${expectedText}" — and NOTHING else.\nScore MUST be 0 if ANY of the following are true:\n- The allowed text is missing or misspelled (even one wrong letter).\n- The image shows ANY other text anywhere (character names, labels, watermarks, captions, extra words, stray letters on clothing or signs).\nIf the only text on the image is exactly the allowed text, evaluate normally.\n\n${promptForEval}`;
      }
    }

    // Extract declared character interactions from the scene metadata.
    // Use sceneHint (original scene description with metadata block) rather than
    // originalPrompt (image prompt where metadata was already stripped).
    let interactionsBlock = '(none declared)';
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

    const evaluationPrompt = evaluationTemplate
      ? fillTemplate(evaluationTemplate, {
          ORIGINAL_PROMPT: promptForEval,
          INTERACTIONS_BLOCK: interactionsBlock,
          FIGURE_PROPORTIONS: figureProportionsBlock,
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
    if (referenceImages && referenceImages.length > 0) {
      let addedCount = 0;
      let cacheHits = 0;
      for (const refImg of referenceImages) {
        // Handle both formats: string URL or {name, photoUrl} object
        const photoUrl = typeof refImg === 'string' ? refImg : refImg?.photoUrl;
        const charName = typeof refImg === 'object' ? refImg?.name : null;
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
          // Check cache first using hash of original image
          const imageHash = hashImageData(photoUrl);
          let compressedBase64 = compressedRefCache.get(imageHash);

          if (compressedBase64) {
            cacheHits++;
          } else {
            // Compress and cache
            const compressed = await compressImageToJPEG(photoUrl, 85, 768); // 85% quality, max 768px
            compressedBase64 = compressed.replace(/^data:image\/\w+;base64,/, '');
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
        }
      }
      log.verbose(`📊 [EVAL] Added ${addedCount} reference images (${cacheHits} cached, ${addedCount - cacheHits} compressed)`);
    }

    // === LAUNCH P1 VISUAL INVENTORY IN PARALLEL (age/figure detection) ===
    let p1Promise = null;
    if (evaluationType === 'scene' && PROMPT_TEMPLATES.imageVisualInventory) {
      log.debug(`📊 [EVAL P1] Launching parallel figure/age detection for ${pageContext || 'scene'}`);
      p1Promise = runVisualInventory(parts, modelId, apiKey, pageContext);
    }

    // Add evaluation prompt text
    parts.push({ text: evaluationPrompt });

    // Log if using model override (modelId already defined at top of function)
    if (qualityModelOverride) {
      log.debug(`🔧 [QUALITY] Using model override: ${modelId}`);
    }

    // Helper function to call the API with retry for socket errors
    const callQualityAPI = async (model) => {
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
              // Gemini 2.5's thinking tokens count against maxOutputTokens. 16k
              // was too tight for complex scenes (3+ characters + multiple
              // objects + spatial checks) — the response would hit the cap
              // mid-JSON and the parse would fail, leaving the page un-scored.
              // 32k gives ~22-24k for the actual JSON output after thinking,
              // comfortably above the ~16k the longest responses produced.
              maxOutputTokens: 32000,
              temperature: 0.3
            },
            safetySettings: GEMINI_SAFETY_SETTINGS
          })
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
      log.warn(`⚠️ [QUALITY] ${pageLabel}Blocked by Gemini safety (${reason}), retrying with full sanitization...`);
      log.debug(`⚠️ [QUALITY] ${pageLabel}Safety details: prompt=[${promptSafety}], candidate=[${candSafety}]`);

      // Step 1: Retry with full sanitization (strips all gender/age nouns)
      const fullSanitized = sanitizeForGemini(originalPrompt, 'full');
      const fullEvalPrompt = evaluationTemplate
        ? fillTemplate(evaluationTemplate, { ORIGINAL_PROMPT: fullSanitized, INTERACTIONS_BLOCK: interactionsBlock })
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
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`⚠️  [QUALITY] Gemini finish reason: ${finishReason}`);
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

    if (parsedJson && typeof parsedJson.score === 'number') {
      // Full JSON format with 0-10 scale and detailed analysis
      const rawScore = parsedJson.score;
      const score = rawScore * 10; // Convert 0-10 to 0-100 for compatibility
      const verdict = parsedJson.verdict || parsedJson.final_verdict || 'UNKNOWN';
      // Support both old 'issues' and new 'issues_summary' field
      // Handle case where issues might be an array (convert to string)
      let issuesSummary = parsedJson.issues_summary || parsedJson.issues || '';
      if (Array.isArray(issuesSummary)) {
        issuesSummary = issuesSummary.join('. ');
      } else if (typeof issuesSummary !== 'string') {
        issuesSummary = String(issuesSummary);
      }

      log.info(`📊 [EVAL] Score: ${rawScore}/10 (${score}/100), Verdict: ${verdict}`);
      const hasRealIssues = issuesSummary && issuesSummary !== 'none' && issuesSummary.toLowerCase() !== 'none';
      if (hasRealIssues) {
        log.info(`📊 [EVAL] Issues: ${issuesSummary}`);
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

      // For covers, check if there are text issues
      let textIssue = null;
      if (evaluationType === 'cover' && issuesSummary) {
        const issuesLower = issuesSummary.toLowerCase();
        if (issuesLower.includes('text') || issuesLower.includes('spell') || issuesLower.includes('letter')) {
          textIssue = 'TEXT_ERROR';
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
            // Use P1's figures/matches (more honest, no prompt bias)
            figures = p1Result.figures || figures;
            matches = p1Result.matches || matches;
            p1Usage = { inputTokens: p1Result.inputTokens, outputTokens: p1Result.outputTokens };
          }
        } catch (e) {
          log.warn(`⚠️ [QUALITY P1] Figure check failed: ${e.message}`);
        }
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
            finalScore = Math.max(0, score - semanticPenalty);
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

      // Await three-stage eval and merge (use lower score)
      let threeStageResult = null;
      if (threeStagePromise) {
        try {
          threeStageResult = await threeStagePromise;
          if (threeStageResult && threeStageResult.score < finalScore) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} < quality ${finalScore} — using three-stage score`);
            finalScore = threeStageResult.score;
            // Merge fixable issues
            if (threeStageResult.fixableIssues?.length) {
              fixableIssues = [...fixableIssues, ...threeStageResult.fixableIssues];
            }
            combinedIssuesSummary = threeStageResult.issuesSummary
              ? (combinedIssuesSummary ? `${combinedIssuesSummary}; THREE-STAGE: ${threeStageResult.issuesSummary}` : `THREE-STAGE: ${threeStageResult.issuesSummary}`)
              : combinedIssuesSummary;
          } else if (threeStageResult) {
            log.info(`📊 [THREE-STAGE] ${pageContext ? `[${pageContext}] ` : ''}Score ${threeStageResult.score} >= quality ${finalScore} — keeping quality score`);
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
        score: finalScore,                    // Combined final score
        qualityScore: score,                  // Visual quality score only
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        threeStageScore: threeStageResult?.score ?? null, // Three-stage compliance score (0-100)
        rawScore, // Original 0-10 score (visual only)
        verdict,
        reasoning,
        rawOutput: responseText,              // Full unparsed API response (for dev testing)
        issuesSummary: combinedIssuesSummary,
        textIssue,
        fixTargets: jsonFixTargets,       // Legacy format with bboxes (backwards compat)
        fixableIssues: fixableIssues,     // New format without bboxes (for two-stage detection)
        figures,                          // Detected figures with descriptions
        matches,                          // Character name → figure mapping with face_bbox
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
            finalScore = Math.max(0, qualityScore - semanticPenalty);
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
      const rawScore = parseInt(score10Match[1]);
      const qualityScore = rawScore * 10; // Convert 0-10 to 0-100 for compatibility
      log.verbose(`📊 [EVAL] Image quality score: ${rawScore}/10 (${qualityScore}/100)`);
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

    log.warn(`⚠️  [QUALITY] Could not parse score from response (finishReason=${finishReason}, ${responseText.length} chars):`, responseText.substring(0, 200));
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
 * Detect bounding boxes for a specific issue using Gemini's native detection
 * This is stage 2 of the two-stage detection approach:
 * Stage 1: Quality evaluation identifies issues (no bboxes needed)
 * Stage 2: This function detects ALL figures, faces, and objects in one call
 *
 * @param {string} imageData - Base64 image data
 * @param {Object} options - Detection options
 * @param {Array<{name: string, description: string, position: string}>} options.expectedCharacters - Characters to identify
 * @param {string[]} options.expectedObjects - Objects to check for
 * @returns {Promise<{figures: Array, objects: Array, usage: Object}|null>}
 */
async function detectAllBoundingBoxes(imageData, options = {}) {
  const { expectedCharacters = [], expectedObjects = [], sceneContext = null, bboxModelOverride = null, pageContext = '' } = options;
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      log.warn('⚠️  [BBOX-DETECT] Gemini API key not configured');
      return null;
    }

    // Load prompt template
    if (!PROMPT_TEMPLATES.boundingBoxDetection) {
      log.warn('⚠️  [BBOX-DETECT] Bounding box detection prompt template not loaded');
      return null;
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
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
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
      const claudeResult = await callTextModel(prompt, 16000, modelId, { images: [imageDataUri] });
      if (!claudeResult?.text) {
        log.warn('⚠️  [BBOX-DETECT] Claude returned no text response');
        return null;
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
        return null;
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
                // Disable thinking for bbox — Google says it adds latency without improving spatial accuracy
                ...(modelSupportsThinking(modelId) && { thinkingConfig: { thinkingBudget: 0 } })
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
          return null;
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

        // PROHIBITED_CONTENT is a system-level block — retrying won't help, go straight to fallback
        if (blockReason === 'PROHIBITED_CONTENT') {
          log.warn(`⚠️  [BBOX-DETECT] ${pageLabel}Image blocked by Gemini safety (PROHIBITED_CONTENT), skipping retry`);
          break;
        }

        if (bboxAttempt < 2) {
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
          return null;
        }
      }
    }

    // Guard: if all attempts failed (e.g., PROHIBITED_CONTENT block), data has no candidates
    if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      log.warn('🔄 [FALLBACK] Detection failed, no bounding boxes available');
      return null;
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
          return null;
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
      return null;
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
          const overlayBase64 = overlayDataUri.replace(/^data:image\/\w+;base64,/, '');
          const overlayMime = overlayDataUri.match(/^data:(image\/\w+);base64,/)
            ? overlayDataUri.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

          // Same focused prompt as the manual "Bbox verfeinern" button (iterate-bbox endpoint)
          const figuresSummary = mainCharacters.map((f, i) => {
            const fb = f.faceBox ? `face:[${f.faceBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no face';
            const bb = f.bodyBox ? `body:[${f.bodyBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no body';
            return `  ${i + 1}. "${f.name}" (${f.confidence}) — ${fb}, ${bb}`;
          }).join('\n');

          const refinePrompt = `Detect the 2d bounding boxes: verify and correct the drawn boxes in this illustration.

The image shows colored bounding boxes overlaid on a storybook illustration:
- THICK GREEN boxes = character BODY region
- THICK BLUE boxes labeled "FACE" = character FACE region

CURRENT BOXES (0-1000 scale, [ymin, xmin, ymax, xmax]):
${figuresSummary}

CRITICAL CHECK — for each character:
1. Is the FACE BOX centered on the actual face? If the box only covers half the face or is placed on the shoulder/chest/hair instead of the face, MOVE it to the correct position.
2. Is the FACE BOX the right size? It must cover forehead-to-chin and ear-to-ear. Include hair/hat. Exclude neck/shoulders.
3. Is the BODY BOX covering the complete character from head to feet? Nothing cut off.

MOST COMMON ERROR: Face box placed at wrong location — shifted to one side, covering only half the face, or placed on the body instead of the face. Fix this by re-centering the face_box on the actual face in the image.

Return corrected coordinates. Keep the same character names.

Output JSON:
{
  "figures": [
    {"name": "CharName", "label": "description", "position": "center", "confidence": "high", "face_box": [ymin, xmin, ymax, xmax], "body_box": [ymin, xmin, ymax, xmax]}
  ]
}

Coordinates: 0-1000 scale, [0,0] = top-left, [1000,1000] = bottom-right.
Respond with ONLY the JSON.`;

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
          const meta = await sharp(Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64')).metadata();
          imgW = meta.width || 1024;
          imgH = meta.height || 1024;
        } catch { /* use defaults */ }
        finalFigures = await mergeCascadeFacesWithGemini(finalFigures, cascadeFaces, imgW, imgH);
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

    return {
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
      refinementResponse
    };

  } catch (error) {
    log.error(`❌ [BBOX-DETECT] Error detecting bounding boxes: ${error.message}`);
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
 * Build scene context string for bbox detection prompt.
 * Includes imageSummary and per-character position/action/clothing.
 */
function buildBboxSceneContext(sceneMetadata, sceneCharacters = [], characterClothing = {}) {
  if (!sceneMetadata) return null;

  const parts = [];

  // Scene summary
  if (sceneMetadata.imageSummary) {
    parts.push(`**SCENE:** ${sceneMetadata.imageSummary}`);
  }

  // Per-character position, action, and clothing from scene description
  const sceneChars = sceneMetadata.characters || [];
  if (sceneChars.length > 0) {
    const charLines = sceneChars.map(c => {
      const clothing = characterClothing[c.name] || '';
      const lineParts = [`- ${c.name}:`];
      if (c.position) lineParts.push(c.position);
      if (c.action) lineParts.push(c.action);
      if (c.expression) lineParts.push(c.expression);
      if (clothing) lineParts.push(`Wearing: ${clothing}`);
      return lineParts.join(', ');
    });
    parts.push(charLines.join('\n'));
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
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
    if (['standard', 'winter', 'summer', 'formal'].includes(s)) return true;
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
    if (category.startsWith('costumed:')) {
      const type = category.split(':')[1];
      const costumed = clothingDescriptions.costumed;
      if (costumed && typeof costumed === 'object') {
        if (costumed[type]) return costumed[type];
        // Any costume description is better than none on a costumed page
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
    chars.push({
      name,
      description,
      position
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
      position
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

    // Build SVG overlay — figures and faces only (no object boxes to reduce noise)
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
        const strokeStyle = isCascade ? '' : ' stroke-dasharray="8,4"'; // solid if cascade, dashed if gemini-only
        const strokeWidth = isCascade ? 4 : 3;
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${figColor}" stroke-width="${strokeWidth}"${strokeStyle}/>`);
        // Face label
        const sourceTag = isCascade ? ` [${fig._cascadeFace}]` : '';
        const faceLabel = isIdentified ? `FACE ${fig.name}${sourceTag}` : `FACE ${i + 1}${sourceTag}`;
        const faceLabelWidth = Math.min(faceLabel.length * 7 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${y + h}" width="${faceLabelWidth}" height="16" fill="${figColor}" opacity="0.9" rx="2"/>`);
        svgParts.push(`<text x="${x + 4}" y="${y + h + 12}" font-family="Arial" font-size="10" font-weight="bold" fill="white">${escapeXml(faceLabel)}</text>`);
      }
    }

    svgParts.push('</svg>');
    const svgBuffer = Buffer.from(svgParts.join(''));

    // Composite SVG over image
    const resultBuffer = await sharp(imageBuffer)
      .composite([{ input: svgBuffer, top: 0, left: 0 }])
      .jpeg({ quality: 85 })
      .toBuffer();

    const result = 'data:image/jpeg;base64,' + resultBuffer.toString('base64');
    const figCount = bboxDetection.figures?.length || 0;
    log.debug(`📦 [BBOX-OVERLAY] Created overlay image: ${figCount} figures (${Math.round(resultBuffer.length / 1024)}KB)`);
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
 * Legacy wrapper for backwards compatibility
 * @deprecated Use detectAllBoundingBoxes instead
 */
async function detectBoundingBoxesForIssue(imageData, issueDescription) {
  log.warn('⚠️  [BBOX-DETECT] detectBoundingBoxesForIssue is deprecated, use detectAllBoundingBoxes');
  const result = await detectAllBoundingBoxes(imageData);
  if (!result || !result.figures || result.figures.length === 0) return null;
  // Return first figure for backwards compatibility
  const fig = result.figures[0];
  return {
    faceBox: fig.faceBox,
    bodyBox: fig.bodyBox,
    label: fig.label,
    usage: result.usage
  };
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
async function enrichWithBoundingBoxes(imageData, fixableIssues, qualityMatches = [], objectMatches = [], expectedPositions = {}, expectedObjects = [], characterDescriptions = {}, characterClothing = {}, sceneContext = null, bboxModelOverride = null, pageContext = '', sharedBboxDetection = null) {
  // Build expected characters for bbox detection (AI will identify by name)
  const expectedCharacters = buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing);

  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Reuse shared bbox detection if provided (avoids redundant API call)
  let allDetections;
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
      pageContext
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
    timestamp: new Date().toISOString()
  };

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
      if (issue.type === 'face' || issue.type === 'hand' || issue.type === 'clothing') {
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
      log.warn(`⚠️ [BBOX-ENRICH] Could not match issue: ${issue.description.substring(0, 50)}...`);
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

    const rewriteResult = await callTextModel(rewritePrompt, 1000);
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

  // Check if we should use Runware backend (for cheap testing with FLUX Schnell)
  // Priority: override param > CONFIG_DEFAULTS > 'gemini'
  const imageBackend = imageBackendOverride || CONFIG_DEFAULTS?.imageBackend || 'gemini';
  log.info(`🎨 [IMAGE GEN] Backend: ${imageBackend} (override=${imageBackendOverride || 'none'}, default=${CONFIG_DEFAULTS?.imageBackend || 'gemini'})`);
  if (imageBackend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [IMAGE GEN] Using Runware FLUX Schnell backend (cheap testing mode)`);

    try {
      // Extract photo URLs for reference images
      const referenceImages = [];
      if (characterPhotos && characterPhotos.length > 0) {
        for (const photoData of characterPhotos) {
          const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
          if (photoUrl && photoUrl.startsWith('data:image')) {
            referenceImages.push(photoUrl);
          }
        }
      }

      // Pass all reference images (prompt already limits character count)
      const result = await generateWithRunware(prompt, {
        model: RUNWARE_MODELS.FLUX_SCHNELL,
        width: 1024,
        height: 1024,
        steps: 4,
        referenceImages: referenceImages
      });

      // Call onImageReady callback for progressive display
      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
        }
      }

      // Evaluate quality using Gemini (still needed for consistency checking)
      const qualityResult = await evaluateImageQuality(
        result.imageData,
        prompt,              // originalPrompt (string)
        characterPhotos,     // referenceImages (array)
        evaluationType,
        qualityModelOverride,
        pageContext,
        storyText,
        sceneHint,
        sceneCharacters      // Enables STEP 2C head-to-body proportion check
      );
      if (!qualityResult) {
        log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware) — returning image with score=null so pipeline can re-evaluate next round`);
      }

      const finalResult = {
        imageData: result.imageData,
        modelId: result.modelId,
        score: qualityResult?.score ?? null,
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
        usage: result.usage
      };

      // Cache the result
      imageCache.set(cacheKey, finalResult);
      log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);

      return finalResult;
    } catch (runwareError) {
      log.error(`❌ [RUNWARE] Generation failed, falling back to Gemini: ${runwareError.message}`);
      // Fall through to Gemini
    }
  }

  // Check if we should use Grok Imagine backend
  if (imageBackend === 'grok' && isGrokConfigured()) {
    const grokModel = evaluationType === 'cover' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD;
    // Aspect ratio: explicit override wins, otherwise read from MODEL_DEFAULTS
    // (pageAspect / coverAspect / avatarAspect — all configured in one place).
    const grokAspect = aspectRatioOverride
      || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
          : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
          : MODEL_DEFAULTS.pageAspect);
    log.info(`🎨 [IMAGE GEN] Using Grok Imagine backend (model: ${grokModel}, type: ${evaluationType}, aspect: ${grokAspect})`);

    try {
      const refImages = await packReferences(
        { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground },
        { aspectRatio: grokAspect, pageLabel: pageNumber != null ? String(pageNumber) : pageContext }
      );

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(prompt, refImages, { model: grokModel, aspectRatio: grokAspect });
      } else {
        result = await generateWithGrok(prompt, { model: grokModel, aspectRatio: grokAspect });
      }

      // Call onImageReady callback for progressive display
      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
        }
      }

      // Skip quality evaluation for avatar conversions (just style transfer)
      if (evaluationType === 'avatar') {
        log.debug(`⏭️ [QUALITY] Skipping quality evaluation for Grok avatar conversion`);
        const finalResult = {
          imageData: result.imageData,
          modelId: result.modelId,
          score: null,
          reasoning: null,
          imageUsage: result.usage,
          usage: result.usage
        };
        imageCache.set(cacheKey, finalResult);
        return finalResult;
      }

      // Evaluate quality using Gemini
      const qualityResult = await evaluateImageQuality(
        result.imageData,
        prompt,
        characterPhotos,
        evaluationType,
        qualityModelOverride,
        pageContext,
        storyText,
        sceneHint
      );
      if (!qualityResult) {
        log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok backend) — returning image with score=null so pipeline can re-evaluate next round`);
      }

      const finalResult = {
        imageData: result.imageData,
        modelId: result.modelId,
        score: qualityResult?.score ?? null,
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
        usage: result.usage,
        grokRefImages: refImages.length > 0 ? refImages : undefined,
      };

      imageCache.set(cacheKey, finalResult);
      log.debug(`💾 [IMAGE CACHE] Stored (${imageCache.size}/${IMAGE_CACHE_MAX_SIZE})`);

      return finalResult;
    } catch (grokError) {
      log.error(`❌ [GROK] Generation failed, falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini
    }
  }

  // Call Gemini API for image generation with optional character reference images
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Determine if we have a previous scene image (for sequential mode)
  const hasSequentialImage = previousImage && previousImage.startsWith('data:image');

  // Build parts array: PROMPT FIRST, then images in order
  const parts = [{ text: prompt }];

  // Track image index for numbered labels (matches the reference map in the prompt)
  let currentImageIndex = 1;

  // For sequential mode: Add PREVIOUS scene image FIRST (most important for continuity)
  // Crop the image slightly to change aspect ratio - this forces AI to regenerate
  // rather than copying too much from the reference image
  if (hasSequentialImage) {
    // Crop 15% from top and bottom to change aspect ratio
    const croppedImage = await cropImageForSequential(previousImage);

    const base64Data = croppedImage.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    // Add label for sequential mode (avoid numbered format)
    parts.push({ text: `[Previous scene]:` });
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
    currentImageIndex++;
    log.debug(`🖼️  [IMAGE GEN] Added cropped previous scene image for visual continuity (SEQUENTIAL MODE)`);
  }

  // Add character photos as reference images (compressed and cached for token efficiency)
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  if (characterPhotos && characterPhotos.length > 0) {
    let addedCount = 0;
    let skippedCount = 0;
    let cacheHits = 0;
    const characterNames = [];
    const apiImageHashes = [];  // Track hashes of images actually sent to API

    for (const photoData of characterPhotos) {
      // Handle both formats: string URL or {name, photoUrl} object
      let photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      // Handle various legacy formats
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
        // Check cache first using hash of original image
        const imageHash = hashImageData(photoUrl);
        let compressedBase64 = compressedRefCache.get(imageHash);

        if (compressedBase64) {
          cacheHits++;
        } else {
          // Compress and cache (768px for image gen - slightly larger than quality eval)
          const compressed = await compressImageToJPEG(photoUrl, 85, 768);
          compressedBase64 = compressed.replace(/^data:image\/\w+;base64,/, '');
          compressedRefCache.set(imageHash, compressedBase64);
        }

        // Calculate hash of the compressed data being sent to API
        apiImageHashes.push({
          name: characterName || `photo_${addedCount + 1}`,
          hash: imageHash,
          matchesProvided: providedHash ? imageHash === providedHash : null
        });

        // Add name label BEFORE the image (matches reference map in prompt)
        // IMPORTANT: Do NOT use numbered format like [Image 1 - Name] as it triggers "character sheet" generation
        const labelName = characterName || `Character ${addedCount + 1}`;
        parts.push({ text: `[${labelName}]:` });
        if (characterName) {
          characterNames.push(characterName);
        }

        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: compressedBase64
          }
        });
        currentImageIndex++;
        addedCount++;
      } else {
        skippedCount++;
        // Bug #10 fix: Log character name for skipped photos to help diagnose issues
        const charLabel = characterName ? `"${characterName}"` : `#${addedCount + skippedCount}`;
        const preview = photoUrl
          ? (typeof photoUrl === 'string' ? photoUrl.substring(0, 30) : `[object: ${Object.keys(photoUrl).join(',')}]`)
          : 'null/undefined';
        log.warn(`[IMAGE GEN] Skipping character ${charLabel}: invalid photoUrl (${preview}...)`);
      }
    }

    // Log hashes of images being sent to API
    if (apiImageHashes.length > 0) {
      log.debug(`🔐 [IMAGE GEN] API image hashes:`, apiImageHashes.map(h => `${h.name}:${h.hash}`).join(', '));
    }

    if (characterNames.length > 0) {
      log.debug(`🖼️  [IMAGE GEN] Added ${addedCount} LABELED reference images: ${characterNames.join(', ')} (${cacheHits} cached)`);
    } else {
      log.debug(`🖼️  [IMAGE GEN] Added ${addedCount}/${characterPhotos.length} character reference images (${cacheHits} cached)`);
    }
    if (skippedCount > 0) {
      log.warn(`[IMAGE GEN] WARNING: ${skippedCount} photos were SKIPPED (not base64 data URLs)`);
    }
  }

  // Add PRIMARY landmark reference photo only (1st landmark as separate image)
  // Secondary landmarks (2nd+) go into the Visual Bible grid instead
  if (landmarkPhotos && landmarkPhotos.length > 0) {
    const primaryLandmark = landmarkPhotos[0];
    if (primaryLandmark.photoData && primaryLandmark.photoData.startsWith('data:image')) {
      const base64Data = primaryLandmark.photoData.replace(/^data:image\/\w+;base64,/, '');
      const mimeType = primaryLandmark.photoData.match(/^data:(image\/\w+);base64,/) ?
        primaryLandmark.photoData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

      // Add name label before the image (avoid numbered format to prevent "character sheet" generation)
      parts.push({ text: `[${primaryLandmark.name} (landmark)]:` });
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      });
      currentImageIndex++;
      log.info(`🌍 [IMAGE GEN] Added primary landmark reference: ${primaryLandmark.name}`);
      if (landmarkPhotos.length > 1) {
        log.debug(`🌍 [IMAGE GEN] ${landmarkPhotos.length - 1} secondary landmark(s) excluded (should be in VB grid)`);
      }
    }
  }

  // Add Visual Bible reference grid (combines secondary chars, animals, artifacts, vehicles, 2nd+ landmarks)
  if (visualBibleGrid) {
    parts.push({ text: `[Reference Grid (objects, secondary characters, locations)]:` });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: visualBibleGrid.toString('base64')
      }
    });
    currentImageIndex++;
    log.info(`🔲 [IMAGE GEN] Added Visual Bible reference grid (${Math.round(visualBibleGrid.length / 1024)}KB)`);
  }

  // Log parts array structure for verification (text first, then images)
  log.debug(`🔍 [IMAGE GEN] Parts array structure: ${parts.map((p, i) =>
    p.text ? `[${i}] text(${p.text.length}ch)` :
    p.inline_data ? `[${i}] image(${p.inline_data.mime_type})` : `[${i}] unknown`
  ).join(', ')}`);

  // Use model override if provided, otherwise default based on type:
  // - Covers: Gemini 3 Pro Image (higher quality)
  // - Scenes: Gemini 2.5 Flash Image (faster)
  const defaultModel = evaluationType === 'cover' ? MODEL_DEFAULTS.coverImage : MODEL_DEFAULTS.pageImage;
  // let — may be swapped to a Gemini model below if we reach the Gemini
  // branch via a Grok/Runware fallback.
  let modelId = imageModelOverride || defaultModel;
  if (imageModelOverride) {
    log.debug(`🔧 [IMAGE GEN] Using model override: ${modelId}`);
  }

  // Check if the selected model is a Runware model (flux-schnell, flux-dev)
  const modelConfig = IMAGE_MODELS[modelId];

  // Truncate prompt if needed based on model's maxPromptLength
  const maxPromptLength = modelConfig?.maxPromptLength || 30000;
  let effectivePrompt = prompt;
  if (prompt.length > maxPromptLength) {
    log.warn(`✂️ [IMAGE GEN] Prompt too long (${prompt.length} chars), truncating to ${maxPromptLength} for ${modelId}`);
    effectivePrompt = prompt.substring(0, maxPromptLength - 3) + '...';
    // Update parts array with truncated prompt for Gemini path
    parts[0] = { text: effectivePrompt };
  }

  if (modelConfig?.backend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [IMAGE GEN] Model ${modelId} uses Runware backend - routing to Runware`);

    try {
      // Determine which Runware model to use
      const runwareModel = modelId === 'flux-dev' ? RUNWARE_MODELS.FLUX_DEV : RUNWARE_MODELS.FLUX_SCHNELL;

      // Extract photo URLs for reference images
      const referenceImages = [];
      if (characterPhotos && characterPhotos.length > 0) {
        for (const photoData of characterPhotos) {
          const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
          if (photoUrl && photoUrl.startsWith('data:image')) {
            referenceImages.push(photoUrl);
          }
        }
      }

      const result = await generateWithRunware(effectivePrompt, {
        model: runwareModel,
        width: 1024,
        height: 1024,
        steps: modelId === 'flux-dev' ? 30 : 4,
        referenceImages: referenceImages  // No limit - prompt controls character count
      });

      // Call onImageReady callback for progressive display
      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
        }
      }

      // Evaluate quality using Gemini
      const qualityResult = await evaluateImageQuality(
        result.imageData,
        prompt,              // originalPrompt (string)
        characterPhotos,     // referenceImages (array)
        evaluationType,
        qualityModelOverride,
        pageContext,
        storyText,
        sceneHint,
        sceneCharacters      // Enables STEP 2C head-to-body proportion check
      );
      if (!qualityResult) {
        log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Runware in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
      }

      return {
        imageData: result.imageData,
        modelId: result.modelId,
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
        imageUsage: result.usage,
        qualityUsage: qualityResult?.usage ?? null
      };
    } catch (runwareError) {
      log.error('❌ [IMAGE GEN] Runware generation failed:', runwareError.message);
      throw runwareError;
    }
  }

  // Route to Grok if model config says so
  if (modelConfig?.backend === 'grok' && isGrokConfigured()) {
    log.info(`🎨 [IMAGE GEN] Model ${modelId} uses Grok backend - routing to Grok`);

    try {
      const grokModel = modelId === 'grok-imagine-pro' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD;
      // Aspect ratio: explicit override wins, otherwise read from MODEL_DEFAULTS.
      // editWithGrok pads input refs to this aspect so the output matches.
      const grokAspect = aspectRatioOverride
        || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
            : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
            : MODEL_DEFAULTS.pageAspect);

      // For avatars: each reference image (face, body, style sample) gets its own slot
      // For scenes: use normal packing (VB grid + landmarks + characters + scene background)
      let refImages;
      if (evaluationType === 'avatar' && characterPhotos?.length > 0) {
        refImages = [];
        for (const photoData of characterPhotos.slice(0, 3)) {
          const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
          if (photoUrl && photoUrl.startsWith('data:image')) {
            refImages.push(photoUrl);
          }
        }
        log.info(`🎨 [GROK] Avatar mode: ${refImages.length} reference images as separate slots`);
      } else {
        refImages = await packReferences(
          { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground },
          { aspectRatio: grokAspect, pageLabel: pageNumber != null ? String(pageNumber) : pageContext }
        );
      }

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(effectivePrompt, refImages, { model: grokModel, aspectRatio: grokAspect });
      } else {
        result = await generateWithGrok(effectivePrompt, { model: grokModel, aspectRatio: grokAspect });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); } catch (e) { /* ignore */ }
      }

      const qualityResult = await evaluateImageQuality(
        result.imageData, prompt, characterPhotos, evaluationType,
        qualityModelOverride, pageContext, storyText, sceneHint, sceneCharacters
      );
      if (!qualityResult) {
        log.warn(`⚠️  [IMAGE GEN] Quality eval unavailable for ${pageContext || 'image'} (Grok in generateImageOnly) — returning image with score=null so pipeline can re-evaluate next round`);
      }

      return {
        imageData: result.imageData,
        modelId: result.modelId,
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
        imageUsage: result.usage,
        qualityUsage: qualityResult?.usage ?? null,
        // Exact packed references sent to Grok (for dev-mode "Sent to Grok" display).
        // The primary Grok branch at the top of this function already returns
        // this field — the secondary "route to Grok if model config says so"
        // branch used to forget it, so covers (which hit this path because
        // CONFIG_DEFAULTS.imageBackend='gemini' but grok-imagine's modelConfig
        // says backend='grok') always had grokRefImages=null in the DB.
        grokRefImages: refImages.length > 0 ? refImages : undefined,
      };
    } catch (grokError) {
      log.error(`❌ [IMAGE GEN] Grok generation failed (model-routed), falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini below
    }
  }

  // If modelId points at a non-Gemini backend (Grok/Runware) we reached here
  // via the fallback path — swap to a known-good Gemini image model so the
  // URL below is valid. Without this, the URL becomes
  // `.../models/grok-imagine:generateContent` → Google returns 404.
  if (IMAGE_MODELS[modelId]?.backend && IMAGE_MODELS[modelId].backend !== 'gemini') {
    const originalModelId = modelId;
    modelId = 'gemini-2.5-flash-image';
    log.warn(`🔄 [IMAGE GEN] Fallback: swapped model ${originalModelId} → ${modelId} for Gemini API call`);
  }

  const systemInstruction = getImageSystemInstruction();
  const modelTemp = IMAGE_MODELS[modelId]?.temperature ?? 0.8;
  // Aspect ratio: explicit override wins, otherwise read from MODEL_DEFAULTS
  // (pageAspect / coverAspect / avatarAspect — one source of truth).
  const geminiAspect = aspectRatioOverride
    || (evaluationType === 'avatar' ? MODEL_DEFAULTS.avatarAspect
        : evaluationType === 'cover' ? MODEL_DEFAULTS.coverAspect
        : MODEL_DEFAULTS.pageAspect);
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
          qualityUsage: qualityUsage  // Token usage for quality evaluation
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
    aspectRatio = CONFIG_DEFAULTS.pageAspect
  } = options;

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

  // Check if we should use Runware backend
  const imageBackend = imageBackendOverride || CONFIG_DEFAULTS?.imageBackend || 'gemini';
  log.info(`🎨 [IMAGE GEN-ONLY] Backend: ${imageBackend}`);

  if (imageBackend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [IMAGE GEN-ONLY] Using Runware FLUX Schnell backend`);

    try {
      const referenceImages = [];
      if (characterPhotos && characterPhotos.length > 0) {
        for (const photoData of characterPhotos) {
          const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
          if (photoUrl && photoUrl.startsWith('data:image')) {
            referenceImages.push(photoUrl);
          }
        }
      }

      const result = await generateWithRunware(prompt, {
        model: RUNWARE_MODELS.FLUX_SCHNELL,
        width: 1024,
        height: 1024,
        steps: 4,
        referenceImages: referenceImages
      });

      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
        }
      }

      const finalResult = {
        imageData: result.imageData,
        modelId: result.modelId,
        usage: result.usage
      };

      if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (runwareError) {
      log.error(`❌ [IMAGE GEN-ONLY] Runware failed, falling back to Gemini: ${runwareError.message}`);
    }
  }

  // Check if we should use Grok Imagine backend
  if (imageBackend === 'grok' && isGrokConfigured()) {
    // generateImageOnly is only used for page regeneration, so always STANDARD
    log.info(`🎨 [IMAGE GEN-ONLY] Using Grok Imagine backend (model: ${GROK_MODELS.STANDARD})`);

    try {
      const refImages = await packReferences(
        { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground, textAreaMask },
        { aspectRatio, pageLabel: pageNumber != null ? String(pageNumber) : '' }
      );

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(prompt, refImages, { model: GROK_MODELS.STANDARD, aspectRatio });
      } else {
        result = await generateWithGrok(prompt, { model: GROK_MODELS.STANDARD, aspectRatio });
      }

      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
        }
      }

      const finalResult = {
        imageData: result.imageData,
        prompt,
        modelId: result.modelId,
        usage: result.usage,
        grokRefImages: refImages.length > 0 ? refImages : undefined,
      };

      if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (grokError) {
      log.error(`❌ [IMAGE GEN-ONLY] Grok failed, falling back to Gemini: ${grokError.message}`);
    }
  }

  // Gemini path
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Determine if we have a previous scene image (for sequential mode)
  const hasSequentialImage = previousImage && previousImage.startsWith('data:image');

  // Build parts array: PROMPT FIRST, then images in order
  const parts = [{ text: prompt }];
  let currentImageIndex = 1;

  // For sequential mode: Add PREVIOUS scene image FIRST
  if (hasSequentialImage) {
    const croppedImage = await cropImageForSequential(previousImage);
    const base64Data = croppedImage.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    parts.push({ text: `[Previous scene]:` });
    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
    currentImageIndex++;
    log.debug(`🖼️  [IMAGE GEN-ONLY] Added cropped previous scene image (SEQUENTIAL MODE)`);
  }

  // Scene background reference (empty scene for style anchoring)
  if (sceneBackground && sceneBackground.startsWith('data:image')) {
    const bgBase64 = sceneBackground.replace(/^data:image\/\w+;base64,/, '');
    const bgMime = sceneBackground.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
    parts.push({ text: `[Background — copy composition, lighting, camera angle, colors, and depth. Add characters onto this background, do not redraw the environment. Preserve any calm, low-detail areas — they are reserved for text overlay]:` });
    parts.push({ inline_data: { mime_type: bgMime, data: bgBase64 } });
    currentImageIndex++;
    log.debug(`🖼️ [IMAGE GEN-ONLY] Added scene background reference`);
  }

  // Add character photos as reference images
  if (characterPhotos && characterPhotos.length > 0) {
    let addedCount = 0;
    let cacheHits = 0;
    const characterNames = [];

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

      if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
        const imageHash = hashImageData(photoUrl);
        let compressedBase64 = compressedRefCache.get(imageHash);

        if (compressedBase64) {
          cacheHits++;
        } else {
          const compressed = await compressImageToJPEG(photoUrl, 85, 768);
          compressedBase64 = compressed.replace(/^data:image\/\w+;base64,/, '');
          compressedRefCache.set(imageHash, compressedBase64);
        }

        // IMPORTANT: Do NOT use numbered format like [Image 1 - Name] as it triggers "character sheet" generation
        const labelName = characterName || `Character ${addedCount + 1}`;
        parts.push({ text: `[${labelName}]:` });
        if (characterName) {
          characterNames.push(characterName);
        }

        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: compressedBase64
          }
        });
        currentImageIndex++;
        addedCount++;
      }
    }

    if (characterNames.length > 0) {
      log.debug(`🖼️  [IMAGE GEN-ONLY] Added ${addedCount} LABELED reference images: ${characterNames.join(', ')} (${cacheHits} cached)`);
    }
  }

  // Add PRIMARY landmark reference photo only
  if (landmarkPhotos && landmarkPhotos.length > 0) {
    const primaryLandmark = landmarkPhotos[0];
    if (primaryLandmark.photoData && primaryLandmark.photoData.startsWith('data:image')) {
      const base64Data = primaryLandmark.photoData.replace(/^data:image\/\w+;base64,/, '');
      const mimeType = primaryLandmark.photoData.match(/^data:(image\/\w+);base64,/) ?
        primaryLandmark.photoData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

      parts.push({ text: `[${primaryLandmark.name} (landmark)]:` });
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      });
      currentImageIndex++;
      log.info(`🌍 [IMAGE GEN-ONLY] Added primary landmark reference: ${primaryLandmark.name}`);
    }
  }

  // Add Visual Bible reference grid
  if (visualBibleGrid) {
    parts.push({ text: `[Reference Grid (objects, secondary characters, locations)]:` });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: visualBibleGrid.toString('base64')
      }
    });
    currentImageIndex++;
    log.info(`🔲 [IMAGE GEN-ONLY] Added Visual Bible reference grid`);
  }

  // Use model override if provided
  const defaultModel = MODEL_DEFAULTS.pageImage;
  // let — may be swapped to a Gemini model below if we reach the Gemini
  // branch via a Grok/Runware fallback.
  let modelId = imageModelOverride || defaultModel;

  // Check if the selected model is a Runware model
  const modelConfig = IMAGE_MODELS[modelId];

  // Truncate prompt if needed
  const maxPromptLength = modelConfig?.maxPromptLength || 30000;
  let effectivePrompt = prompt;
  if (prompt.length > maxPromptLength) {
    log.warn(`✂️ [IMAGE GEN-ONLY] Prompt too long (${prompt.length} chars), truncating to ${maxPromptLength}`);
    effectivePrompt = prompt.substring(0, maxPromptLength - 3) + '...';
    parts[0] = { text: effectivePrompt };
  }

  if (modelConfig?.backend === 'runware' && isRunwareConfigured()) {
    log.info(`🎨 [IMAGE GEN-ONLY] Model ${modelId} uses Runware backend`);

    try {
      const runwareModel = modelId === 'flux-dev' ? RUNWARE_MODELS.FLUX_DEV : RUNWARE_MODELS.FLUX_SCHNELL;
      const referenceImages = [];
      if (characterPhotos && characterPhotos.length > 0) {
        for (const photoData of characterPhotos) {
          const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
          if (photoUrl && photoUrl.startsWith('data:image')) {
            referenceImages.push(photoUrl);
          }
        }
      }

      const result = await generateWithRunware(effectivePrompt, {
        model: runwareModel,
        width: 1024,
        height: 1024,
        steps: modelId === 'flux-dev' ? 30 : 4,
        referenceImages: referenceImages
      });

      if (onImageReady && result.imageData) {
        try {
          await onImageReady(result.imageData, result.modelId);
        } catch (callbackError) {
          log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
        }
      }

      const finalResult = {
        imageData: result.imageData,
        prompt: effectivePrompt,
        modelId: result.modelId,
        usage: result.usage
      };

      if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (runwareError) {
      log.error('❌ [IMAGE GEN-ONLY] Runware generation failed:', runwareError.message);
      throw runwareError;
    }
  }

  // Route to Grok if model config says so
  if (modelConfig?.backend === 'grok' && isGrokConfigured()) {
    log.info(`🎨 [IMAGE GEN-ONLY] Model ${modelId} uses Grok backend`);

    try {
      const grokModel = modelId === 'grok-imagine-pro' ? GROK_MODELS.PRO : GROK_MODELS.STANDARD;
      const refImages = await packReferences(
        { visualBibleGrid, landmarkPhotos, characterPhotos, previousImage, sceneBackground },
        { aspectRatio, pageLabel: pageNumber != null ? String(pageNumber) : '' }
      );

      let result;
      if (refImages.length > 0) {
        result = await editWithGrok(effectivePrompt, refImages, { model: grokModel, aspectRatio });
      } else {
        result = await generateWithGrok(effectivePrompt, { model: grokModel, aspectRatio });
      }

      if (onImageReady && result.imageData) {
        try { await onImageReady(result.imageData, result.modelId); } catch (e) { /* ignore */ }
      }

      const finalResult = {
        imageData: result.imageData,
        prompt: effectivePrompt,
        modelId: result.modelId,
        usage: result.usage,
        grokRefImages: refImages.length > 0 ? refImages : undefined,
      };

      if (!skipCache) imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (grokError) {
      log.error(`❌ [IMAGE GEN-ONLY] Grok generation failed (model-routed), falling back to Gemini: ${grokError.message}`);
      // Fall through to Gemini below
    }
  }

  // If modelId points at a non-Gemini backend (Grok/Runware) we reached here
  // via the fallback path — swap to a known-good Gemini image model so the
  // URL below is valid. Without this, the URL becomes
  // `.../models/grok-imagine:generateContent` → Google returns 404.
  if (IMAGE_MODELS[modelId]?.backend && IMAGE_MODELS[modelId].backend !== 'gemini') {
    const originalModelId = modelId;
    modelId = 'gemini-2.5-flash-image';
    log.warn(`🔄 [IMAGE GEN-ONLY] Fallback: swapped model ${originalModelId} → ${modelId} for Gemini API call`);
  }

  // Gemini API call
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
  const sanitizationLevels = [
    null,                                                    // Level 0: original prompt
    () => sanitizePromptLevel1(prompt),                      // Level 1: remove problematic words
    () => sanitizePromptLevel2(prompt),                      // Level 2: simplify to core scene
    () => sanitizePromptLevel3(artStyle)                     // Level 3: minimal fallback
  ];

  for (let sanitizationLevel = 0; sanitizationLevel < sanitizationLevels.length; sanitizationLevel++) {
    // Apply sanitization if needed
    let currentPrompt = prompt;
    if (sanitizationLevel > 0) {
      currentPrompt = sanitizationLevels[sanitizationLevel]();
      parts[0] = { text: currentPrompt };
      log.info(`🔄 [IMAGE GEN-ONLY] Retry with sanitization level ${sanitizationLevel}, prompt: ${currentPrompt.substring(0, 100)}...`);
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
              prompt: effectivePrompt,
              modelId,
              thinkingText,
              usage,
              sanitizationLevel // Track which level succeeded
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

  const pass1Prompt = `${styleLine}Generate a SINGLE illustration. No split screen, no panels, no grid. No text or watermarks.

**SCENE:** ${settingDesc || imageSummary}
Camera: ${camera}

**Characters (foreground ONLY):**
${fgCharDesc}

IMPORTANT: Show ONLY ${fgNames}. Leave the far background OPEN and EMPTY — no other figures. Space must remain for a tiny character to be added later.`;

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

  const pass2Prompt = `${styleLine}This illustration shows ${fgNames} in the foreground. Do NOT change them.

ADD to the FAR BACKGROUND as a TINY FIGURE (approximately 1/5 the size of the foreground character):
- ${bgCharDesc}

The added character must be:
- Very small compared to the foreground figure
- In the distant background area
- Recognizable but tiny — match the scene's art style and lighting
- PRESERVE the entire foreground exactly as shown`;

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
    visualBible = null
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

      // Run quality evaluation (with parallel semantic fidelity check if pageText provided)
      // Use img.evaluationType if set (covers use 'cover' for text-focused eval)
      const qualityResult = await evaluateImageQuality(
        img.imageData,
        img.sceneDescription || img.prompt || '',
        img.allCharacterPhotos || img.characterPhotos || [],
        img.evaluationType || 'scene',
        qualityModelOverride,
        pageLabel,
        img.pageText || null,  // Story text for semantic fidelity check
        img.sceneHint || null, // Scene hint for semantic evaluation
        img.sceneCharacters || null  // Enables STEP 2C head-to-body proportion check
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
          characterDescriptions[char.name] = {
            richDescription: getStoryHelpers().buildCharacterPhysicalDescription(char),
            clothingDescriptions: char.avatars?.clothing || {}
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
          img.sharedBboxDetection || null // Reuse pre-detected bbox if available
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
        bboxDetection,
        bboxOverlayImage,
        usage: qualityResult?.usage || null,
        modelId: qualityResult?.modelId || null,
        // Semantic fidelity results (parallel evaluation when pageText provided)
        semanticResult: qualityResult?.semanticResult || null,
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

/**
 * Classify issues from an evaluation into repair categories.
 * Helper used by callers that want to inspect the issue mix on a page.
 *
 * @param {Object} evaluation - Single page evaluation from evaluateImageBatch
 * @returns {Object} Classified issues: { majorIssues, styleMismatch, characterMismatches, clothingIssues }
 */
function classifyIssues(evaluation) {
  const majorIssues = [];
  const characterMismatches = [];
  const clothingIssues = [];

  // Parse the quality JSON from reasoning if available
  let quality = {};
  if (evaluation.reasoning) {
    try {
      quality = typeof evaluation.reasoning === 'string'
        ? JSON.parse(evaluation.reasoning)
        : evaluation.reasoning;
    } catch (e) {
      // If reasoning isn't JSON, use individual fields
    }
  }

  const matches = quality.matches || evaluation.matches || [];
  const rendering = quality.rendering || {};
  const scene = quality.scene || {};
  const spatial = quality.spatial || {};
  const fixableIssues = quality.fixable_issues || evaluation.fixableIssues || [];

  // Check for major issues requiring full regeneration (iterate)
  // 1. Missing characters
  if (scene.all_present === false || (scene.missing && scene.missing.length > 0)) {
    majorIssues.push({
      type: 'missing_character',
      details: scene.missing || ['unknown'],
      reason: `Missing character(s): ${(scene.missing || ['unknown']).join(', ')}`
    });
  }

  // 2. Extra limbs (3+ arms/hands on a figure)
  if (rendering.extra_limbs === true) {
    majorIssues.push({
      type: 'extra_limbs',
      reason: 'Extra limbs detected (3+ arms/hands)'
    });
  }

  // 3. Physics violations (floating people, impossible poses)
  if (rendering.physics_ok === false) {
    majorIssues.push({
      type: 'physics_violation',
      details: rendering.issues || [],
      reason: 'Physics violation (floating, impossible poses)'
    });
  }

  // 4. Cross eyes (eyes looking different directions)
  if (rendering.cross_eyes === true) {
    majorIssues.push({
      type: 'cross_eyes',
      reason: 'Cross-eyed character detected'
    });
  }

  // 5. Spatial mismatches (wrong pointing/looking direction)
  if (spatial.issues && spatial.issues.length > 0) {
    majorIssues.push({
      type: 'spatial_mismatch',
      details: spatial.issues,
      reason: `Spatial issues: ${spatial.issues.join(', ')}`
    });
  }

  // 6. Semantic fidelity issues (action direction wrong, relationship reversed)
  const semanticResult = evaluation.semanticResult;
  if (semanticResult?.semanticIssues && semanticResult.semanticIssues.length > 0) {
    for (const issue of semanticResult.semanticIssues) {
      // CRITICAL and MAJOR semantic issues trigger regeneration
      if (issue.severity === 'CRITICAL' || issue.severity === 'MAJOR') {
        majorIssues.push({
          type: 'semantic_mismatch',
          severity: issue.severity,
          details: { action: issue.action, observed: issue.observed, expected: issue.expected },
          reason: `Semantic: ${issue.problem}`
        });
      }
    }
  }

  // Check for style mismatch
  const styleMismatch = scene.style_consistent === false;

  // Check for individual character mismatches (candidates for targeted replacement)
  for (const match of matches) {
    const issues = [];

    if (match.hair_match === false) {
      issues.push('hair mismatch');
    }
    if (typeof match.confidence === 'number' && match.confidence < 0.5) {
      issues.push(`low confidence (${Math.round(match.confidence * 100)}%)`);
    }

    if (issues.length > 0) {
      characterMismatches.push({
        reference: match.reference || `figure_${match.figure}`,
        figure: match.figure,
        face_bbox: match.face_bbox,
        issues,
        confidence: match.confidence,
        reason: `${match.reference || 'Unknown'}: ${issues.join(', ')}`
      });
    }
  }

  // Check for clothing/artifact issues (inpaintable)
  // From fixable_issues array
  for (const issue of fixableIssues) {
    if (issue.type === 'clothing' || issue.type === 'object' ||
        issue.severity === 'MODERATE' || issue.severity === 'MINOR') {
      clothingIssues.push({
        type: issue.type || 'clothing',
        description: issue.description,
        severity: issue.severity || 'MODERATE',
        fix: issue.fix || `Fix: ${issue.description}`
      });
    }
  }

  // Also check matches for clothing mismatches
  for (const match of matches) {
    if (match.clothing_match === false) {
      clothingIssues.push({
        type: 'clothing',
        description: `${match.reference || 'Character'} clothing mismatch`,
        reference: match.reference,
        figure: match.figure,
        severity: 'MODERATE'
      });
    }
  }

  return {
    majorIssues,
    styleMismatch,
    characterMismatches,
    clothingIssues
  };
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
function selectBestVersion(versions) {
  if (!versions || versions.length === 0) return null;
  if (versions.length === 1) return versions[0];

  return versions.reduce((best, v) =>
    (v.score != null && (best.score == null || v.score > best.score)) ? v : best
  , versions[0]);
}

/**
 * Build a feedback suffix from evaluation results to inject into regen prompts.
 * Tells the image model what quality issues to fix in the next attempt.
 */
function buildRegenFeedback(evaluation) {
  if (!evaluation?.evaluated) return '';
  const parts = [];
  // Only include fixable issues (concise) — skip verbose reasoning (can be 5000+ chars)
  if (evaluation.fixableIssues?.length > 0) {
    parts.push('IMPORTANT — Fix these issues from the previous attempt:\n' +
      evaluation.fixableIssues.map(i => `- ${i.description || i.issue || i}`).join('\n'));
  }
  // Cap total feedback to 2000 chars to stay within prompt limits
  const feedback = parts.join('\n\n');
  return feedback.length > 2000 ? feedback.substring(0, 2000) + '\n...(truncated)' : feedback;
}

/**
 * Choose whether to inpaint or iterate a bad page.
 *
 * Philosophy: **default = repair** (inpaint). Iterate ONLY when the image is
 * total crap (fundamentally broken visual/semantic) or when repair has nothing
 * to act on. Repair is cheaper, preserves rendering, and is smarter for most
 * issues (extra hand, wrong framing, character pose nudge, etc.).
 *
 * Decision logic:
 *   1. Visual score < VISUAL_BROKEN_FLOOR → iterate (image is visually broken)
 *   2. Semantic score < SEMANTIC_BROKEN_FLOOR → iterate (image shows wrong scene)
 *   3. No inpaintable content (no quality/semantic issues, no fix targets) → iterate
 *   4. Otherwise → inpaint (default)
 *
 * @param {Object} evaluation - { qualityScore, semanticScore, fixableIssues, fixTargets, enrichedFixTargets, semanticResult }
 * @returns {{ strategy: 'inpaint'|'iterate', reason: string }}
 */
function chooseRepairStrategy(evaluation) {
  const VISUAL_BROKEN_FLOOR = 50;     // below this, the image is visually total crap
  const SEMANTIC_BROKEN_FLOOR = 30;   // below this, the image shows the wrong scene

  const visualScore = evaluation.qualityScore ?? 100;
  const semanticScore = evaluation.semanticScore ?? 100;

  // Inpaint can act on quality fixableIssues, enriched/fix targets, OR semantic issues.
  const fixableCount = evaluation.fixableIssues?.length || 0;
  const enrichedCount = evaluation.enrichedFixTargets?.length || 0;
  const fixTargetCount = evaluation.fixTargets?.length || 0;
  const semanticIssueCount = (evaluation.semanticResult?.issues?.length
    || evaluation.semanticResult?.semanticIssues?.length || 0);
  const hasInpaintableContent = fixableCount + enrichedCount + fixTargetCount + semanticIssueCount > 0;

  if (visualScore < VISUAL_BROKEN_FLOOR) {
    return { strategy: 'iterate', reason: `image visually broken (visual=${visualScore})` };
  }
  if (semanticScore < SEMANTIC_BROKEN_FLOOR) {
    return { strategy: 'iterate', reason: `wrong scene (semantic=${semanticScore})` };
  }
  if (!hasInpaintableContent) {
    return { strategy: 'iterate', reason: 'no inpaintable content' };
  }

  const parts = [];
  if (fixableCount) parts.push(`${fixableCount} quality`);
  if (semanticIssueCount) parts.push(`${semanticIssueCount} semantic`);
  if (enrichedCount || fixTargetCount) parts.push(`${enrichedCount + fixTargetCount} targets`);
  return { strategy: 'inpaint', reason: parts.join(', ') || 'default' };
}

/**
 * Force strategy switch when two consecutive repairs of the same kind have
 * already failed on this page. If the page is entering a new repair round
 * (meaning it's still bad) and the two previous rounds both used 'inpaint'
 * (or both used 'iterate'), flip to the other approach. A third attempt of
 * the same kind rarely succeeds where the first two didn't; swapping gives
 * the alternative strategy a real chance before we spend the round budget.
 *
 * Returns 'inpaint' | 'iterate' | null. null means don't force anything.
 */
function forcedStrategyAfterFailures(versions) {
  if (!Array.isArray(versions)) return null;
  const repairs = versions.filter(v =>
    v?.source && (v.source.startsWith('inpaint-') || v.source.startsWith('iterate-'))
  );
  if (repairs.length < 2) return null;
  const last = repairs.slice(-2);
  const strat = (v) => v.source.startsWith('inpaint-') ? 'inpaint' : 'iterate';
  if (strat(last[0]) !== strat(last[1])) return null;
  return strat(last[0]) === 'inpaint' ? 'iterate' : 'inpaint';
}

/**
 * If the most recent repair regressed the score (final image is worse than the
 * best version that existed BEFORE the repair), flip strategy. A regression
 * means the chosen approach actively damaged the image — repeating it is much
 * more likely to keep damaging it than to recover. Switch to the other approach
 * for the next round instead of waiting for two failures.
 *
 * Returns 'inpaint' | 'iterate' | null. null = no regression, no forced flip.
 */
function lastRepairRegressed(versions) {
  if (!Array.isArray(versions) || versions.length < 2) return null;
  const scoreOf = (v) => v?.evaluation?.score ?? v?.score ?? v?.qualityScore ?? null;
  // Find the most recent repair version and its index.
  let lastIdx = -1;
  for (let i = versions.length - 1; i >= 0; i--) {
    const src = versions[i]?.source || '';
    if (src.startsWith('inpaint-') || src.startsWith('iterate-')) { lastIdx = i; break; }
  }
  if (lastIdx <= 0) return null;
  const last = versions[lastIdx];
  const lastScore = scoreOf(last);
  if (lastScore == null) return null;
  let priorBest = -Infinity;
  for (let i = 0; i < lastIdx; i++) {
    const s = scoreOf(versions[i]);
    if (s != null && s > priorBest) priorBest = s;
  }
  if (!isFinite(priorBest)) return null;
  if (lastScore >= priorBest) return null;
  return last.source.startsWith('inpaint-') ? 'iterate' : 'inpaint';
}

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
    // Audit trail: when provided, consolidator calls get persisted to DB
    storyId = null,
    round = null,
  } = options;

  // Resolve the current-page clothing category for a character. Case-insensitive.
  // Falls back to 'standard' if the scene metadata doesn't list this character.
  const clothingFor = (name) => {
    if (!characterClothing || !name) return 'standard';
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(characterClothing)) {
      if (k.toLowerCase() === lower) return (v || 'standard').toLowerCase();
    }
    return 'standard';
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
      charReqs[name] = { _currentClothing: variant };
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
  const consolidation = await consolidateFeedback({
    imageDataUri: imageData,
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
    const stripNames = (text, ownVisualId) => {
      if (!text || typeof text !== 'string' || characterNames.length === 0) return text;
      let out = text;
      for (const name of characterNames) {
        // Prefer the per-name visual identifier, else the current entry's own
        // identifier, else a neutral placeholder.
        const vid = visualIdByName.get(name.toLowerCase()) || ownVisualId || 'the character';
        const possRe = new RegExp(`\\b${escapeRe(name)}['’]s\\b`, 'g');
        out = out.replace(possRe, `${vid}'s`);
        const bareRe = new RegExp(`\\b${escapeRe(name)}\\b`, 'g');
        out = out.replace(bareRe, vid);
      }
      return out.replace(/\s{2,}/g, ' ').trim();
    };

    const sceneInstrRaw = consolidatedPlan.scene_fix?.instruction || '';
    const sceneInstr = stripNames(sceneInstrRaw, null);
    const perCharInstrs = (consolidatedPlan.per_character_fixes || [])
      .map(p => {
        const visualId = p.visual_identifier || 'this character';
        const fixRaw = p.fix_instruction || (p.issues || []).join('; ');
        const fix = stripNames(fixRaw, visualId);
        return `- For ${visualId}: ${fix}`;
      })
      .filter(Boolean);

    const parts = [];
    if (sceneInstr) parts.push(sceneInstr);
    if (perCharInstrs.length > 0) {
      parts.push('Character adjustments:');
      parts.push(...perCharInstrs);
    }
    editInstruction = parts.join('\n');

    // Attach avatars for every character referenced in per_character_fixes
    // — Grok needs a visual reference for appearance fixes. The avatar must
    // match the character's CURRENT clothing on this page (e.g. costumed:superhero),
    // not their unstyled base photo. Uses getStyledAvatarForClothing which
    // resolves: styled+clothing → styled standard → base → face photo.
    if (characters && consolidatedPlan.per_character_fixes?.length > 0) {
      for (const pcf of consolidatedPlan.per_character_fixes) {
        const charName = (pcf.characterName || '').toLowerCase();
        if (!charName) continue;
        const mainChar = characters.find(c => c.name?.toLowerCase() === charName);
        if (!mainChar) continue;
        const pageClothing = clothingFor(mainChar.name);
        const avatar = getStyledAvatarForClothing(mainChar, artStyle || 'watercolor', pageClothing);
        const photoUrl = typeof avatar === 'string' ? avatar : (avatar?.imageData || mainChar.photos?.body || mainChar.photos?.face);
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
          referenceImages.push(photoUrl);
          referenceImageSources.push(`avatar:${mainChar.name}:${pageClothing}`);
          log.info(`[INPAINT PAGE] Attaching ${pageClothing} avatar for ${mainChar.name} (Grok ref image, style=${artStyle || 'watercolor'})`);
        }
      }
    }

    log.info(`[INPAINT PAGE] Using consolidated plan: ${consolidatedPlan.per_character_fixes.length} per-char + scene=${consolidatedPlan.scene_fix?.severity || 'NONE'}, ${consolidatedPlan.dropped_issues?.length || 0} dropped`);

    // Audit: which issues did Haiku drop? A dropped CRITICAL/MAJOR is a
    // pipeline bug — the repair instruction we send to Grok will ignore the
    // actual problem and the next eval round will re-detect it.
    const dropped = consolidatedPlan.dropped_issues || [];
    for (const d of dropped) {
      const issueText = d.issue || d.description || JSON.stringify(d);
      const reason = d.reason || '(no reason)';
      // Cross-check against the original CRITICAL/MAJOR set so we can flag
      // when a high-severity issue is silently discarded.
      const originalCritical = (evaluation.fixableIssues || []).some(i => {
        const sev = String(i.severity || '').toUpperCase();
        if (sev !== 'CRITICAL' && sev !== 'MAJOR') return false;
        const orig = (i.description || i.issue || '').toLowerCase();
        return orig && issueText.toLowerCase().includes(orig.slice(0, 30));
      });
      if (originalCritical) {
        log.error(`🚨 [INPAINT PAGE] P${pageNumber}: CRITICAL/MAJOR issue dropped by consolidator — "${issueText}" (reason: ${reason})`);
      } else {
        log.debug(`[INPAINT PAGE] P${pageNumber}: dropped — "${issueText}" (${reason})`);
      }
    }
  } else {
    // Fallback: legacy concat
    editInstruction = combinedIssues.map(i => i.description).filter(Boolean).join('. ');
    log.warn(`[INPAINT PAGE] Consolidator failed (${consolidation?.error || 'no plan'}), falling back to legacy instruction`);
  }

  // Find reference images for missing characters/animals from Visual Bible (still useful)
  const missingItems = combinedIssues.filter(i => i.type === 'missing_character' || i.type === 'missing_element');
  for (const missing of missingItems) {
    const itemName = (missing.item || '').toLowerCase().trim();
    if (!itemName) continue;

    const vbAnimal = visualBible?.animals?.find(a => a.name?.toLowerCase() === itemName && a.referenceImageData);
    if (vbAnimal) {
      referenceImages.push(vbAnimal.referenceImageData);
      referenceImageSources.push(`vb-animal:${missing.item}`);
      log.info(`[INPAINT PAGE] Adding VB animal reference for missing "${missing.item}"`);
      continue;
    }
    const vbChar = visualBible?.secondaryCharacters?.find(c => (c.name?.toLowerCase() === itemName || c.id?.toLowerCase() === itemName) && c.referenceImageData);
    if (vbChar) {
      referenceImages.push(vbChar.referenceImageData);
      referenceImageSources.push(`vb-char:${missing.item}`);
      log.info(`[INPAINT PAGE] Adding VB secondary character reference for missing "${missing.item}"`);
      continue;
    }
    const vbArtifact = visualBible?.artifacts?.find(a => a.name?.toLowerCase() === itemName && a.referenceImageData);
    if (vbArtifact) {
      referenceImages.push(vbArtifact.referenceImageData);
      referenceImageSources.push(`vb-artifact:${missing.item}`);
      log.info(`[INPAINT PAGE] Adding VB artifact reference for missing "${missing.item}"`);
      continue;
    }
    if (characters) {
      const mainChar = characters.find(c => c.name?.toLowerCase() === itemName);
      if (mainChar) {
        const pageClothing = clothingFor(mainChar.name);
        const avatar = getStyledAvatarForClothing(mainChar, artStyle || 'watercolor', pageClothing);
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

  const fullInstruction = `Fix these issues in this children's book illustration:\n${editInstruction}`;
  log.info(`[INPAINT PAGE] Inpainting (refs: ${referenceImages.length}): ${editInstruction.substring(0, 200)}`);

  try {
    const editResult = await editImageWithPrompt(imageData, fullInstruction, undefined, referenceImages);
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
 * Unified repair pipeline — evaluates, inpaints/iterates bad pages, picks best,
 * then runs character repair on final images.
 *
 * Flow:
 *   1. Evaluate all images + entity consistency (parallel)
 *   2. Round loop (1 to maxPasses): for each bad page, chooseRepairStrategy() → inpaint or iterate
 *   3. Pick best versions
 *   4. Entity consistency check (on picked images)
 *   5. Character repair (on final images)
 *   6. Evaluate character-repaired pages
 *   7. Final pick best
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
async function runUnifiedRepairPipeline(rawImages, context, options = {}) {
  const {
    characters = [],
    modelOverrides = {},
    usageTracker,
    visualBible,
    artStyle,
    jobId,
    dbPool,
    storyData
  } = context;

  const {
    regenThreshold = REPAIR_DEFAULTS.scoreThreshold,
    maxRegenAttempts = REPAIR_DEFAULTS.maxPasses,
    evalConcurrency = 100,
    qualityModelOverride = null,
    useIteratePage = false,
    inpaintMaxPasses = REPAIR_DEFAULTS.inpaintMaxPasses,
  } = options;

  const { runEntityConsistencyChecks, getStyledAvatarForClothing } = require('./entityConsistency');
  const { extractSceneMetadata } = getStoryHelpers();

  const imagesWithData = rawImages.filter(r => r.imageData);
  const effectiveUseIteratePage = useIteratePage && !!storyData;
  if (useIteratePage && !storyData) {
    log.warn('[UNIFIED PIPELINE] useIteratePage=true but storyData not provided; falling back to generateImageOnly');
  }
  log.info(`🔧 [UNIFIED PIPELINE] Starting: ${imagesWithData.length} images, threshold=${regenThreshold}, maxPasses=${maxRegenAttempts}, mode=${effectiveUseIteratePage ? 'iteratePage' : 'generateImageOnly'}`);

  // Helper for progress updates
  const updateProgress = async (percent, message) => {
    if (jobId && dbPool) {
      try {
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [percent, message, jobId]
        );
      } catch (e) {
        log.warn(`⚠️ [UNIFIED PIPELINE] Progress update failed: ${e.message}`);
      }
    }
  };

  // =========================================================================
  // Step 1: Evaluate all images + entity consistency (parallel)
  // =========================================================================
  await updateProgress(32, 'Evaluating image quality...');  // 32 = eval start
  log.info(`🔍 [UNIFIED PIPELINE] Step 1: Evaluating ${imagesWithData.length} images + entity consistency...`);
  const step1Start = Date.now();

  // Build ALL character photos for evaluation (matches re-evaluate endpoint behavior)
  const allCharacterPhotos = characters
    .filter(c => c.photoUrl || c.avatars?.styled)
    .map(c => ({
      name: c.name,
      photoUrl: c.avatars?.styled || c.photoUrl
    }));

  // Reusable helper: build eval inputs for an array of image entries
  const buildEvalInputs = (imageEntries) => imageEntries.map(entry => {
    const orig = rawImages.find(img => img.pageNumber === entry.pageNumber) || entry;
    return {
      imageData: entry.imageData,
      pageNumber: entry.pageNumber,
      prompt: orig.prompt,
      characterPhotos: orig.characterPhotos,
      allCharacterPhotos,
      sceneDescription: orig.sceneDescription,
      sceneCharacters: orig.sceneCharacters,
      sceneMetadata: orig.sceneMetadata,
      pageText: orig.text,
      sceneHint: orig.scene?.outlineExtract || orig.scene?.sceneHint || null,
      evaluationType: orig.evaluationType,
    };
  });

  // Reusable helper: build entity check data for an array of image entries
  const buildEntityCheckData = (imageEntries) => ({
    sceneImages: imageEntries.map(entry => {
      const orig = rawImages.find(r => r.pageNumber === entry.pageNumber) || entry;
      const metadata = extractSceneMetadata(orig.sceneDescription) || {};
      // Build per-character clothing from multiple sources (covers don't have
      // prose metadata, so we fall back to characterPhotos / referencePhotos).
      const clothingFromPhotos = (orig.characterPhotos || []).reduce((acc, p) => {
        if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
        return acc;
      }, {});
      const perCharClothing = orig.perCharClothing
        || metadata.characterClothing
        || (Object.keys(clothingFromPhotos).length > 0 ? clothingFromPhotos : {});
      let sceneSummary = '';
      if (metadata.fullData?.imageSummary) {
        sceneSummary = metadata.fullData.imageSummary.substring(0, 150);
      } else if (orig.sceneDescription) {
        const beforeJson = orig.sceneDescription.split('```json')[0].trim();
        const lines = beforeJson.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        sceneSummary = lines[0]?.substring(0, 150) || '';
      }
      return {
        imageData: entry.imageData,
        pageNumber: entry.pageNumber,
        characters: metadata.characters || [],
        clothing: metadata.clothing || 'standard',
        characterClothing: perCharClothing,
        sceneSummary,
        referenceCharacters: (orig.characterPhotos || []).map(p => p.name).filter(Boolean),
        referenceClothing: (orig.characterPhotos || []).reduce((acc, p) => {
          if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
          return acc;
        }, {}),
        retryHistory: [],
        // Shared bbox detection from pre-step (avoids redundant Gemini call)
        sharedBboxDetection: orig.sharedBboxDetection || null,
      };
    }),
    // Pass scene descriptions so entity-collect can determine per-page characters.
    // Without this, runEntityConsistencyChecks falls back to sending ALL story
    // characters to bbox detection — which causes false Werner/Uschi labels on
    // pages where Werner/Uschi don't appear, then triggers bogus character fixes.
    sceneDescriptions: imageEntries.map(entry => {
      const orig = rawImages.find(r => r.pageNumber === entry.pageNumber) || entry;
      return {
        pageNumber: entry.pageNumber,
        description: orig.sceneDescription || ''
      };
    }),
    artStyle: artStyle || 'pixar'
  });

  const evalInputs = buildEvalInputs(imagesWithData);
  const imageCheckData = buildEntityCheckData(imagesWithData);

  // Run both in parallel
  const [evaluations, entityReport] = await Promise.all([
    evaluateImageBatch(evalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible }),
    runEntityConsistencyChecks(imageCheckData, characters, {
      checkCharacters: true,
      checkObjects: true,
      saveGrids: false
    }).catch(err => {
      log.error(`❌ [UNIFIED PIPELINE] Entity consistency check failed: ${err.message}`);
      return { characters: {}, totalIssues: 0, overallConsistent: true, summary: 'Entity check failed', grids: [] };
    })
  ]);

  // Track usage
  for (const evalResult of evaluations) {
    if (evalResult.usage && usageTracker) {
      usageTracker('gemini_quality', evalResult.usage, 'page_quality', evalResult.modelId);
    }
  }
  if (entityReport?.tokenUsage && usageTracker) {
    usageTracker('gemini_quality', {
      input_tokens: entityReport.tokenUsage.inputTokens || 0,
      output_tokens: entityReport.tokenUsage.outputTokens || 0
    }, 'entity_consistency_check', entityReport.tokenUsage.model || 'gemini-2.5-flash');
  }

  const step1Duration = ((Date.now() - step1Start) / 1000).toFixed(1);
  const avgScore = evaluations.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / Math.max(1, evaluations.length);
  log.info(`✅ [UNIFIED PIPELINE] Step 1 complete in ${step1Duration}s: avg score ${avgScore.toFixed(0)}%, entity issues: ${entityReport.totalIssues}`);

  // Build eval map for quick lookup
  const evalMap = new Map();
  for (const ev of evaluations) {
    evalMap.set(ev.pageNumber, ev);
  }

  // Evaluate the truly-original image when text-space repair picked a different
  // candidate as winner. Without this, retryHistory[0] (the original) shows no
  // score and we lose the baseline needed to judge whether text-space repair
  // helped or hurt quality. Runs in parallel via evaluateImageBatch concurrency.
  const baselineEvalInputs = [];
  for (const img of rawImages) {
    const cands = img.textSpaceCandidates;
    if (!Array.isArray(cands) || cands.length <= 1) continue;
    const original = cands.find(c => c.source === 'original');
    if (!original || original.isWinner) continue;
    baselineEvalInputs.push({
      imageData: original.imageData,
      pageNumber: img.pageNumber,
      prompt: img.prompt,
      characterPhotos: img.characterPhotos,
      allCharacterPhotos,
      sceneDescription: img.sceneDescription,
      sceneCharacters: img.sceneCharacters,
      sceneMetadata: img.sceneMetadata,
      pageText: img.text,
      sceneHint: img.scene?.outlineExtract || img.scene?.sceneHint || null,
      evaluationType: img.evaluationType,
    });
  }
  const baselineEvalsByPage = new Map();
  if (baselineEvalInputs.length > 0) {
    const baselineEvals = await evaluateImageBatch(baselineEvalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible });
    for (const ev of baselineEvals) {
      baselineEvalsByPage.set(ev.pageNumber, ev);
      if (ev.usage && usageTracker) {
        usageTracker('gemini_quality', ev.usage, 'page_quality_original_baseline', ev.modelId);
      }
    }
    log.info(`📊 [UNIFIED PIPELINE] Evaluated ${baselineEvalInputs.length} non-winner originals for baseline scores`);
  }

  // =========================================================================
  // Shared helpers for the round loop
  // =========================================================================
  const ENTITY_PENALTIES = { critical: 30, major: 20, minor: 10 };
  const getEntityPenalty = (pageNumber, report) => {
    if (!report?.characters) return 0;
    let penalty = 0;
    for (const charData of Object.values(report.characters)) {
      const issues = charData.issues || [];
      for (const issue of issues) {
        if (issue.pages?.includes(pageNumber) || issue.pageNumber === pageNumber) {
          penalty += ENTITY_PENALTIES[issue.severity] || 0;
        }
      }
    }
    return penalty;
  };

  // Track all versions per page: { pageNumber -> [{ imageData, score, source, evaluation, entityPenalty, evaluatedAt }] }
  const pageVersions = new Map();
  for (const img of rawImages) {
    const ev = evalMap.get(img.pageNumber);
    const baseVersion = {
      imageData: img.imageData,
      score: ev?.score ?? ev?.qualityScore ?? null,
      source: 'original',
      evaluation: ev || null,
      modelId: img.modelId,
      grokRefImages: img.grokRefImages || null,
      entityPenalty: getEntityPenalty(img.pageNumber, entityReport),
      evaluatedAt: new Date().toISOString(),
    };

    // If the text-space repair ran, it already produced multiple candidates
    // (the truly-original image plus 1–2 repair attempts). Expand them into
    // separate versions so the viewer shows each one and the user can switch
    // between them — otherwise only the coverage-winner survives and the
    // others are lost. Eval only runs on the winner (img.imageData), so the
    // non-winner versions start without scores; that's fine — they're there
    // for inspection and manual selection.
    if (Array.isArray(img.textSpaceCandidates) && img.textSpaceCandidates.length > 1) {
      const baselineEval = baselineEvalsByPage.get(img.pageNumber);
      const allVersions = img.textSpaceCandidates.map((c) => {
        const isWinner = c.isWinner;
        const isOriginal = c.source === 'original';
        const evalForThis = isWinner ? baseVersion.evaluation : (isOriginal ? baselineEval : null);
        const scoreForThis = isWinner
          ? baseVersion.score
          : (isOriginal ? (baselineEval?.score ?? baselineEval?.qualityScore ?? null) : null);
        return {
          imageData: c.imageData,
          score: scoreForThis,
          source: c.source,
          evaluation: evalForThis,
          modelId: c.modelId || baseVersion.modelId,
          // Each candidate now carries its own refs (original inherits from
          // the initial Grok call; repair attempts capture refs from their
          // own generateImageOnly call). Fall back to baseVersion only when
          // the candidate didn't capture any.
          grokRefImages: c.grokRefImages || baseVersion.grokRefImages || null,
          entityPenalty: isWinner ? baseVersion.entityPenalty : 0,
          evaluatedAt: new Date().toISOString(),
          // Surface the text-space repair inputs in the viewer's repair section.
          inpaintInstruction: c.prompt || null,
          textSpaceCoveragePct: c.coveragePct,
          textSpacePosition: c.position,
        };
      });
      pageVersions.set(img.pageNumber, allVersions);
    } else {
      pageVersions.set(img.pageNumber, [baseVersion]);
    }
  }

  // Helper: execute an iterate action for a page
  const executeIterateAction = async (img, latestEval) => {
    const canIterate = effectiveUseIteratePage && img.pageNumber > 0;
    let result;
    if (canIterate) {
      const evalFeedback = latestEval ? {
        score: latestEval.score ?? latestEval.qualityScore,
        reasoning: latestEval.reasoning?.substring(0, 1000),
        fixableIssues: (latestEval.fixableIssues || []).slice(0, 10),
      } : null;
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      const inputImage = bestSoFar?.imageData || img.imageData;
      // Read the per-scene aspect from saved metadata so a 1:1 advanced page
      // doesn't get redone as 3:4. img.imageAspect (preserved in pipelineStoryData)
      // is the source of truth; null falls back to global default in iteratePageCore.
      const sceneAspect = img.imageAspect
        || storyData?.sceneImages?.find(s => s.pageNumber === img.pageNumber)?.imageAspect
        || null;
      result = await iteratePage(inputImage, img.pageNumber, storyData, {
        aspectRatio: sceneAspect,
        modelOverrides,
        usageTracker, // pass through so Haiku scene re-expansion + image gen are tracked
        evaluationFeedback: evalFeedback,
        sceneBackground: img.emptySceneImage || null,
      });
      // iteratePage tracks its own usage internally; nothing to add here
    } else if (img.pageNumber < 0 && storyData) {
      const { iterateCover } = require('./coverIterate');
      const coverKeys = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
      const ck = coverKeys[String(img.pageNumber)];
      if (ck && storyData.coverImages?.[ck]?.imageData) {
        const coverFeedback = latestEval ? {
          score: latestEval.score ?? latestEval.qualityScore,
          reasoning: latestEval.reasoning?.substring(0, 1000),
          fixableIssues: (latestEval.fixableIssues || []).slice(0, 10),
        } : null;
        result = await iterateCover(ck, storyData, {
          imageModel: modelOverrides?.imageModel,
          evaluationFeedback: coverFeedback,
          usageTracker,
        });
      } else if (ck) {
        log.debug(`⏭️  [UNIFIED PIPELINE] Skipping cover ${ck} iterate — no image data available yet`);
      }
    } else {
      const feedbackSuffix = buildRegenFeedback(latestEval);
      const regenPrompt = feedbackSuffix
        ? `${img.prompt}\n\n${feedbackSuffix}`
        : img.prompt;
      result = await generateImageOnly(regenPrompt, img.characterPhotos, {
        imageModelOverride: modelOverrides.imageModel,
        imageBackendOverride: modelOverrides.imageBackend,
        landmarkPhotos: img.landmarkPhotos,
        visualBibleGrid: img.visualBibleGrid,
        pageNumber: img.pageNumber,
        skipCache: true
      });
      if (result?.usage && usageTracker) {
        const isRunware = result.modelId && result.modelId.startsWith('runware:');
        const isGrok = result.modelId && result.modelId.startsWith('grok-imagine');
        const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
        // Route to page_images function so it shows up in the proper bucket
        usageTracker(provider, result.usage, 'page_images', result.modelId);
      }
    }
    return result;
  };

  // Helper: execute an inpaint action for a page
  const executeInpaintAction = async (img, latestEval, roundNum = null) => {
    const versions = pageVersions.get(img.pageNumber) || [];
    const bestSoFar = selectBestVersion(versions);
    const inputImage = bestSoFar?.imageData || img.imageData;
    // Parse per-character clothing for this page so the avatar lookup picks the
    // styled+costumed variant matching what's actually drawn on this page.
    // Without this, inpaint attaches unstyled base photos and Grok has no visual
    // reference for the current costume/style.
    const { parseCharacterClothing } = getStoryHelpers();
    const pageCharacterClothing = parseCharacterClothing(img.sceneDescription || img.description || '') || {};
    const result = await inpaintPage(inputImage, latestEval || {}, {
      visualBible: storyData?.visualBible || null,
      characters: storyData?.characters || characters || null,
      entityReport: currentEntityReport,
      pageNumber: img.pageNumber,
      sceneDescription: img.sceneDescription || img.description || '',
      artStyle: storyData?.artStyle || artStyle || null,
      characterClothing: pageCharacterClothing,
      // Thread storyId + round so consolidator calls get persisted
      storyId: storyData?.id || jobId || null,
      round: roundNum,
    });
    if (result.usage && usageTracker) {
      // Detect actual provider from the model used
      const inpaintModel = result.usage?.model || '';
      const isRunware = inpaintModel.startsWith('runware:');
      const isGrok = inpaintModel.startsWith('grok');
      const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
      usageTracker(provider, {
        input_tokens: result.usage?.inputTokens || 0,
        output_tokens: result.usage?.outputTokens || 0,
        cost: result.usage?.cost,
        direct_cost: result.usage?.cost,  // Grok/Runware track via direct_cost
      }, 'inpaint', inpaintModel || 'grok-text-edit');
    }
    return result;
  };

  // =========================================================================
  // Step 2: Round loop (1 to maxPasses) — inpaint or iterate per bad page
  // =========================================================================
  // Score terminology (THREE dimensions feed the round-loop decisions):
  //   visual    = raw vision-model quality score (qualityScore in evaluation)
  //               "is the image well rendered?"
  //   semantic  = semantic fidelity penalty already folded into evaluation.score
  //               BEFORE this loop runs. semanticPenalty = visual - evaluation.score
  //               "does the image match what the scene description says?"
  //   image     = visual - semantic = evaluation.score
  //               combined "how good is the image itself" score (no entity yet)
  //   entity    = entity consistency penalty (computed in this loop from entity report)
  //               "do characters look consistent across pages?"
  //   final     = image - entity
  //               the score findBadPages compares to regenThreshold
  //
  // Page classification:
  //   final >= regenThreshold                                  → ok                 (no action)
  //   image < regenThreshold                                   → BAD-image          → iterate/inpaint (visual or semantic broken)
  //   image in [regenThreshold, HIGH_IMAGE_FLOOR) AND final<thr → BAD-mixed         → iterate/inpaint
  //   image >= HIGH_IMAGE_FLOOR AND final < regenThreshold     → ENTITY-ONLY        → defer to Step 5 (character repair)
  //
  // Rationale: a high-quality image with high semantic match but only entity drift
  // should NOT be redone — Step 5 surgically repairs the character (~$0.02) instead of
  // regenerating the whole image (~$0.05+) which produces a different image with
  // different micro-issues (the convergence loop). But if visual OR semantic is low,
  // the image itself is the problem and a full redo is justified.
  const HIGH_IMAGE_FLOOR = 90;

  let currentEntityReport = entityReport;
  let upgradedCount = 0;

  for (let round = 1; round <= maxRegenAttempts; round++) {
    // Build eval map for this round using best versions so far. Each entry now
    // carries explicit visualScore / semanticPenalty / imageScore / entityPenalty /
    // finalScore so bad-page detection and strategy choice can read each dimension
    // directly without mutating the existing qualityScore field (300+ call sites).
    const roundEvalPages = {};
    const entityOnlyPages = [];
    for (const img of rawImages) {
      if (!img.imageData) continue;
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      if (bestSoFar && bestSoFar.score != null) {
        // bestSoFar.evaluation.qualityScore = raw visual (no penalties)
        // bestSoFar.score                   = visual - semanticPenalty (image score)
        const visualScore = bestSoFar.evaluation?.qualityScore ?? bestSoFar.score;
        const imageScore = bestSoFar.score;
        const semanticPenalty = Math.max(0, visualScore - imageScore);
        const entityPenalty = getEntityPenalty(img.pageNumber, currentEntityReport);
        const finalScore = Math.max(0, imageScore - entityPenalty);

        // Entity-only = image (visual+semantic combined) is good, only entity drags
        const isEntityOnly =
          imageScore >= HIGH_IMAGE_FLOOR &&
          finalScore < regenThreshold;

        const verdict =
          finalScore >= regenThreshold ? 'ok'
          : isEntityOnly ? 'ENTITY-ONLY → defer to Step 5'
          : 'BAD → iterate/inpaint';

        log.debug(`📊 [PIPELINE] Round ${round} Page ${img.pageNumber}: vis=${visualScore} sem=-${semanticPenalty} img=${imageScore} ent=-${entityPenalty} final=${finalScore} → ${verdict}`);

        if (isEntityOnly) {
          // Skip from this round's bad-page list — Step 5 character repair
          // handles the character drift surgically. Don't iterate.
          entityOnlyPages.push(img.pageNumber);
          continue;
        }

        roundEvalPages[img.pageNumber] = {
          ...bestSoFar.evaluation,
          // Explicit score fields — readers should use these instead of
          // the ambiguous qualityScore which we leave untouched at the raw
          // visual value.
          visualScore,
          semanticPenalty,
          imageScore,
          entityPenalty,
          finalScore,
        };
      }
    }

    if (entityOnlyPages.length > 0) {
      log.info(`👤 [UNIFIED PIPELINE] Round ${round}: ${entityOnlyPages.length} entity-only page(s) deferred to Step 5: [${entityOnlyPages.join(', ')}]`);
    }

    const badPageNums = findBadPages(roundEvalPages, { scoreThreshold: regenThreshold });
    const badPages = rawImages.filter(img => badPageNums.includes(img.pageNumber));

    if (badPages.length === 0) {
      log.info(`✅ [UNIFIED PIPELINE] Round ${round}: No bad pages, skipping remaining rounds`);
      break;
    }

    // Progress: spread rounds across 35-60% range
    const progressBase = 35 + Math.floor((round - 1) / maxRegenAttempts * 25);
    await updateProgress(progressBase, `Round ${round}/${maxRegenAttempts}: Repairing ${badPages.length} pages...`);

    // Choose strategy for each bad page. If the last two repair rounds on
    // this page both used the same approach and didn't fix it, force a flip
    // — doing inpaint a third time rarely succeeds where two already failed.
    const pageStrategies = badPages.map(img => {
      const versions = pageVersions.get(img.pageNumber) || [];
      const bestSoFar = selectBestVersion(versions);
      const latestEval = bestSoFar?.evaluation || evalMap.get(img.pageNumber);

      const regressedFlip = lastRepairRegressed(versions);
      const forced = forcedStrategyAfterFailures(versions);
      let strategy, reason;
      if (regressedFlip) {
        strategy = regressedFlip;
        const prevStrat = regressedFlip === 'inpaint' ? 'iterate' : 'inpaint';
        reason = `forced ${regressedFlip} — last ${prevStrat} regressed the score, flipping strategy`;
      } else if (forced) {
        strategy = forced;
        reason = `forced ${forced} — last two rounds both used ${forced === 'inpaint' ? 'iterate' : 'inpaint'} without fixing it`;
      } else {
        const chosen = chooseRepairStrategy(latestEval || {});
        strategy = chosen.strategy;
        reason = chosen.reason;
      }
      log.info(`  📋 [UNIFIED PIPELINE] Round ${round} page ${img.pageNumber}: ${strategy} (${reason})`);

      return { img, strategy, latestEval };
    });

    const inpaintCount = pageStrategies.filter(p => p.strategy === 'inpaint').length;
    const iterateCount = pageStrategies.filter(p => p.strategy === 'iterate').length;
    log.info(`🔄 [UNIFIED PIPELINE] Round ${round}: ${badPages.length} bad pages → ${inpaintCount} inpaint, ${iterateCount} iterate`);

    const roundStart = Date.now();
    const repairLimit = pLimit(50);

    // Execute all repairs in parallel
    const roundResults = await Promise.all(
      pageStrategies.map(({ img, strategy, latestEval }) => repairLimit(async () => {
        const pageNumber = img.pageNumber;
        try {
          if (strategy === 'inpaint') {
            const inpaintResult = await executeInpaintAction(img, latestEval, round);
            if (inpaintResult.repaired && inpaintResult.imageData) {
              return {
                pageNumber,
                imageData: inpaintResult.imageData,
                source: `inpaint-round-${round}`,
                modelId: inpaintResult.usage?.model || 'grok-text-edit',
                inpaintInstruction: inpaintResult.instruction,
                inpaintReferenceImages: inpaintResult.referenceImages || null,
                inpaintReferenceSources: inpaintResult.referenceImageSources || null,
                consolidatedPlan: inpaintResult.consolidatedPlan || null,
                grokRefImages: null,
              };
            }
            return { pageNumber, imageData: null, error: 'inpaint produced no result' };
          } else {
            // iterate
            const result = await executeIterateAction(img, latestEval);
            if (result?.imageData) {
              return {
                pageNumber,
                imageData: result.imageData,
                source: `iterate-round-${round}`,
                modelId: result.modelId,
                grokRefImages: result.grokRefImages || null,
              };
            }
            return { pageNumber, imageData: null, error: 'iterate produced no result' };
          }
        } catch (err) {
          log.error(`❌ [UNIFIED PIPELINE] Round ${round} ${strategy} failed for page ${pageNumber}: ${err.message}`);
          return { pageNumber, imageData: null, error: err.message };
        }
      }))
    );

    const roundSuccess = roundResults.filter(r => r.imageData);
    const roundDuration = ((Date.now() - roundStart) / 1000).toFixed(1);
    log.info(`✅ [UNIFIED PIPELINE] Round ${round}: ${roundSuccess.length}/${badPages.length} repaired in ${roundDuration}s`);

    // Run fresh entity consistency FIRST (on the latest images including new repairs)
    // so the new versions get their own entity penalty, not a stale one from the
    // previous round. Runs every round (including the last) so final-round repairs
    // also get proper per-version entity data.
    if (roundSuccess.length > 0) {
      log.info(`🔍 [UNIFIED PIPELINE] Round ${round}: Running entity consistency on latest images...`);
      // Build snapshot of latest images: repaired images from this round + original
      // best-so-far for pages not touched this round.
      const roundImageMap = new Map(roundSuccess.map(r => [r.pageNumber, r.imageData]));
      const latestImages = rawImages.filter(img => img.imageData).map(img => {
        if (roundImageMap.has(img.pageNumber)) {
          return { imageData: roundImageMap.get(img.pageNumber), pageNumber: img.pageNumber };
        }
        const versions = pageVersions.get(img.pageNumber) || [];
        const best = selectBestVersion(versions);
        return { imageData: best?.imageData || img.imageData, pageNumber: img.pageNumber };
      });
      const freshEntityCheckData = buildEntityCheckData(latestImages);
      try {
        const freshEntity = await runEntityConsistencyChecks(freshEntityCheckData, characters, {
          checkCharacters: true,
          checkObjects: true,
          saveGrids: false
        });
        if (freshEntity?.tokenUsage && usageTracker) {
          usageTracker('gemini_quality', {
            input_tokens: freshEntity.tokenUsage.inputTokens || 0,
            output_tokens: freshEntity.tokenUsage.outputTokens || 0
          }, `entity_consistency_r${round}`, freshEntity.tokenUsage.model || 'gemini-2.5-flash');
        }
        currentEntityReport = freshEntity;
        log.info(`✅ [UNIFIED PIPELINE] Round ${round}: Entity consistency: ${freshEntity.totalIssues} issues`);
      } catch (entityErr) {
        log.warn(`⚠️ [UNIFIED PIPELINE] Round ${round}: Entity consistency failed: ${entityErr.message}`);
      }
    }

    // Evaluate repaired pages using the FRESH entity report.
    if (roundSuccess.length > 0) {
      const evalProgressPct = progressBase + 8;
      await updateProgress(evalProgressPct, `Round ${round}: Evaluating ${roundSuccess.length} repaired images...`);
      log.info(`🔍 [UNIFIED PIPELINE] Round ${round}: Evaluating ${roundSuccess.length} repaired images...`);

      const roundEvalInputs = buildEvalInputs(roundSuccess);
      const roundEvals = await evaluateImageBatch(roundEvalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible });

      for (const ev of roundEvals) {
        if (ev.usage && usageTracker) {
          usageTracker('gemini_quality', ev.usage, `unified_pipeline_quality_r${round}`, ev.modelId);
        }
        const versions = pageVersions.get(ev.pageNumber);
        const repairResult = roundSuccess.find(r => r.pageNumber === ev.pageNumber);
        if (versions && repairResult) {
          versions.push({
            imageData: repairResult.imageData,
            score: ev.score ?? ev.qualityScore ?? null,
            source: repairResult.source,
            evaluation: ev,
            modelId: repairResult.modelId,
            grokRefImages: repairResult.grokRefImages || null,
            inpaintInstruction: repairResult.inpaintInstruction || null,
            inpaintReferenceImages: repairResult.inpaintReferenceImages || null,
            entityPenalty: getEntityPenalty(ev.pageNumber, currentEntityReport),
            evaluatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  // =========================================================================
  // Step 3: Pick best versions (across all rounds)
  // =========================================================================
  await updateProgress(63, 'Selecting best versions...');
  log.info(`📊 [UNIFIED PIPELINE] Step 3: Selecting best version per page...`);

  const bestPerPage = new Map();
  for (const [pageNumber, versions] of pageVersions) {
    const best = selectBestVersion(versions);
    bestPerPage.set(pageNumber, best);
    if (best.source !== 'original') {
      upgradedCount++;
      log.debug(`📊 [UNIFIED PIPELINE] Page ${pageNumber}: selected ${best.source} (score ${best.score}) over original (score ${versions[0].score})`);
    }
  }
  log.info(`✅ [UNIFIED PIPELINE] Step 3: ${upgradedCount} pages upgraded from repair rounds`);

  // =========================================================================
  // Step 4: Entity consistency check on picked images
  // =========================================================================
  await updateProgress(65, 'Running entity consistency on final images...');
  log.info(`🔍 [UNIFIED PIPELINE] Step 4: Entity consistency check on picked images...`);

  let finalEntityReport = currentEntityReport;
  {
    const pickedImages = rawImages.filter(img => img.imageData).map(img => {
      const best = bestPerPage.get(img.pageNumber);
      return { imageData: best?.imageData || img.imageData, pageNumber: img.pageNumber };
    });
    const finalEntityCheckData = buildEntityCheckData(pickedImages);
    try {
      finalEntityReport = await runEntityConsistencyChecks(finalEntityCheckData, characters, {
        checkCharacters: true,
        checkObjects: true,
        saveGrids: false
      });
      if (finalEntityReport?.tokenUsage && usageTracker) {
        usageTracker('gemini_quality', {
          input_tokens: finalEntityReport.tokenUsage.inputTokens || 0,
          output_tokens: finalEntityReport.tokenUsage.outputTokens || 0
        }, 'entity_consistency_final', finalEntityReport.tokenUsage.model || 'gemini-2.5-flash');
      }
      log.info(`✅ [UNIFIED PIPELINE] Step 4: Entity consistency: ${finalEntityReport.totalIssues} issues`);
    } catch (entityErr) {
      log.warn(`⚠️ [UNIFIED PIPELINE] Step 4: Entity consistency failed: ${entityErr.message}`);
      finalEntityReport = currentEntityReport;
    }
  }

  // =========================================================================
  // Step 5: Character repair (on final picked images)
  // =========================================================================
  const charFixResults = new Map();
  const charFixDetails = new Map();

  if (finalEntityReport && finalEntityReport.totalIssues > 0) {
    await updateProgress(68, 'Fixing character consistency...');
    log.info(`👤 [UNIFIED PIPELINE] Step 5: Character fix pass (${finalEntityReport.totalIssues} entity issues)...`);

    const pageScores = new Map();
    for (const [pageNumber, best] of bestPerPage) {
      pageScores.set(pageNumber, best?.score ?? 100);
    }

    const maxCharTasks = bestPerPage.size; // all story + cover pages
    const { tasks: fixTasks, dropped } = selectCharRepairTasks(finalEntityReport, { pageScores, maxTasks: maxCharTasks });
    log.info(`👤 [UNIFIED PIPELINE] ${fixTasks.length} character fix tasks across ${new Set(fixTasks.map(t => t.pageNumber)).size} pages (cap ${maxCharTasks})`);
    if (dropped > 0) {
      log.info(`👤 [UNIFIED PIPELINE] Dropped ${dropped} lower-priority fixes (cap ${maxCharTasks}).`);
    }

    const fixesByPage = new Map();
    for (const task of fixTasks) {
      if (!fixesByPage.has(task.pageNumber)) {
        fixesByPage.set(task.pageNumber, []);
      }
      fixesByPage.get(task.pageNumber).push(task);
    }

    const charFixLimit = pLimit(50);
    await Promise.all([...fixesByPage.entries()].map(([pageNumber, pageFixes]) => charFixLimit(async () => {
      const best = bestPerPage.get(pageNumber);
      if (!best?.imageData) {
        log.warn(`⚠️ [UNIFIED PIPELINE] Page ${pageNumber}: no image data for character fix, skipping`);
        return;
      }

      let currentImageData = best.imageData;
      let anyFixApplied = false;

      for (const fix of pageFixes) {
        let faceBbox = null;
        let bodyBbox = null;
        const bestEval = best.evaluation;

        // Tier 1: bboxDetection on the scene
        if (bestEval?.bboxDetection?.figures) {
          const figure = bestEval.bboxDetection.figures.find(f =>
            f.name?.toLowerCase() === fix.charName.toLowerCase() ||
            f.label?.toLowerCase().includes(fix.charName.toLowerCase())
          );
          if (figure) {
            if (figure.faceBox) faceBbox = figure.faceBox;
            if (figure.bodyBox) bodyBbox = figure.bodyBox;
          }
        }

        // Tier 2: entity report appearances
        if (!faceBbox && !bodyBbox && finalEntityReport?.characters?.[fix.charName]?.byClothing) {
          for (const clothingData of Object.values(finalEntityReport.characters[fix.charName].byClothing)) {
            const app = clothingData.appearances?.find(a => a.pageNumber === pageNumber);
            if (app?.faceBox) {
              faceBbox = Array.isArray(app.faceBox) ? app.faceBox : [app.faceBox.y, app.faceBox.x, app.faceBox.y + app.faceBox.height, app.faceBox.x + app.faceBox.width];
            }
            if (app?.bodyBox) {
              bodyBbox = Array.isArray(app.bodyBox) ? app.bodyBox : [app.bodyBox.y, app.bodyBox.x, app.bodyBox.y + app.bodyBox.height, app.bodyBox.x + app.bodyBox.width];
            }
            if (faceBbox || bodyBbox) break;
          }
        }

        // Tier 3: quality eval matches
        if (!faceBbox && !bodyBbox && bestEval?.matches) {
          const charMatch = bestEval.matches.find(m =>
            m.name?.toLowerCase() === fix.charName.toLowerCase() ||
            m.character?.toLowerCase() === fix.charName.toLowerCase()
          );
          if (charMatch?.face_bbox) faceBbox = charMatch.face_bbox;
          if (charMatch?.bbox) bodyBbox = charMatch.bbox;
        }

        if (!faceBbox && !bodyBbox) {
          // Tier 4: fresh detection
          log.info(`🔍 [UNIFIED PIPELINE] No stored bbox for ${fix.charName} on page ${pageNumber}, running fresh detection...`);
          try {
            const detection = await detectAllBoundingBoxes(currentImageData, {
              expectedCharacters: [{ name: fix.charName }]
            });
            const charFigure = detection?.figures?.find(f =>
              f.name?.toLowerCase() === fix.charName.toLowerCase()
            );
            if (charFigure) {
              faceBbox = charFigure.faceBox || null;
              bodyBbox = charFigure.bodyBox || null;
            }
          } catch (detectErr) {
            log.warn(`⚠️ [UNIFIED PIPELINE] Fresh bbox detection failed for ${fix.charName}: ${detectErr.message}`);
          }
        }

        if (!faceBbox && !bodyBbox) {
          log.warn(`⚠️ [UNIFIED PIPELINE] Page ${pageNumber}, ${fix.charName}: no bbox found, skipping character fix`);
          continue;
        }

        const character = characters.find(c => c.name === fix.charName);
        if (!character) {
          log.warn(`⚠️ [UNIFIED PIPELINE] Character ${fix.charName} not found, skipping`);
          continue;
        }

        const rawImg = rawImages.find(img => img.pageNumber === pageNumber);
        const clothingCategory = rawImg?.perCharClothing?.[fix.charName] || 'standard';
        const styledAvatar = getStyledAvatarForClothing(character, artStyle, clothingCategory);
        const avatarPhoto = styledAvatar || getFacePhoto(character);
        const avatarPhotoType = styledAvatar ? (clothingCategory.startsWith('costumed') ? `costumed-${clothingCategory.split(':')[1] || 'default'}` : `styled-${clothingCategory}`) : 'face';

        if (!avatarPhoto) {
          log.warn(`⚠️ [UNIFIED PIPELINE] No avatar photo for ${fix.charName}, skipping character fix`);
          continue;
        }

        try {
          const issueText = (fix.issueDescription || '').toLowerCase();
          const hasFaceIssue = issueText.includes('face') || issueText.includes('hair') || issueText.includes('skin') || issueText.includes('eye') || issueText.includes('age');
          const hasClothingIssue = issueText.includes('cloth') || issueText.includes('outfit') || issueText.includes('dress') || issueText.includes('shirt') || issueText.includes('jacket') || issueText.includes('color');

          const useFaceOnly = hasFaceIssue && !hasClothingIssue && !!faceBbox;
          const repairBbox = useFaceOnly ? faceBbox : (bodyBbox || faceBbox);

          // Collect both face AND body bboxes for every OTHER detected character.
          //   - Face repair: we blur just other faces; protectedFaces drives the mask restore.
          //   - Body repair: we blur other characters' FULL BODIES (not just faces) so Grok
          //     can't trait-bleed their hair, clothing, skin tone, etc. into the target;
          //     protectedBodies drives the mask restore.
          const protectedFaces = [];
          const protectedBodies = [];
          const bboxFigures = bestEval?.bboxDetection?.figures || [];
          const toRect = (b) => Array.isArray(b) ? b : [b.y, b.x, b.y + b.height, b.x + b.width];
          for (const fig of bboxFigures) {
            if (!fig.name || fig.name === 'UNKNOWN') continue;
            if (fig.name.toLowerCase() === fix.charName.toLowerCase()) continue;
            if (fig.faceBox) protectedFaces.push(toRect(fig.faceBox));
            if (fig.bodyBox) protectedBodies.push(toRect(fig.bodyBox));
          }

          const clothingDesc = character.avatars?.clothing?.[clothingCategory] || '';
          const sceneDesc = rawImg?.sceneDescription || rawImg?.text || '';

          // Look up the page's locked text-overlay position so the repair
          // prompt can warn Grok not to land the redrawn figure in that zone.
          const pageTextPosition = (storyData?.sceneImages || []).find(s => s.pageNumber === pageNumber)?.textPosition || null;

          log.info(`👤 [UNIFIED PIPELINE] Fixing ${fix.charName} on page ${pageNumber}: ${useFaceOnly ? 'FACE only' : 'FULL character'} (bbox: [${repairBbox.map(v => Math.round(v * 100) + '%').join(', ')}])`);
          const repairResult = await repairCharacterMismatch(currentImageData, avatarPhoto, repairBbox, fix.charName, {
            imageBackend: 'grok',
            issueDescription: fix.issueDescription,
            clothingDescription: clothingDesc,
            photoType: avatarPhotoType,
            sceneDescription: sceneDesc,
            faceBbox,
            protectedFaces,
            protectedBodies,
            whiteoutTarget: useFaceOnly ? 'face' : 'body',
            textPosition: pageTextPosition,
            includeDebug: true,  // Returns prompt + sceneSent + avatarSent for version-viewer inspection
          });

          if (repairResult?.imageData) {
            if (repairResult.imageData.length < 1000) {
              log.warn(`⚠️ [UNIFIED PIPELINE] Character fix for ${fix.charName} on page ${pageNumber} produced too-small image (${repairResult.imageData.length} chars), rejecting`);
              continue;
            }

            const beforeImageData = currentImageData;
            currentImageData = repairResult.imageData;
            anyFixApplied = true;

            if (!charFixDetails.has(fix.charName)) charFixDetails.set(fix.charName, new Map());
            charFixDetails.get(fix.charName).set(pageNumber, {
              before: beforeImageData,
              after: currentImageData,
              blackoutImage: repairResult.blackoutImage || null,
              grokRawResult: repairResult.grokRawResult || null,
              blendMask: repairResult.blendMask || null,
              croppedAvatar: repairResult.croppedAvatar || null,
              method: repairResult.method || 'grok_blended',
              prompt: repairResult.debug?.prompt || null,
              avatarSent: repairResult.debug?.avatarSent || repairResult.croppedAvatar || null,
              bbox: repairResult.debug?.bbox || null,
            });

            if (repairResult.usage && usageTracker) {
              usageTracker('gemini_image', {
                input_tokens: repairResult.usage.inputTokens || 0,
                output_tokens: repairResult.usage.outputTokens || 0
              }, 'unified_pipeline_char_fix', repairResult.usage.model);
            }
          }
        } catch (repairErr) {
          log.error(`❌ [UNIFIED PIPELINE] Character fix failed for ${fix.charName} on page ${pageNumber}: ${repairErr.message}`);
        }
      }

      if (anyFixApplied) {
        const preFixScore = bestPerPage.get(pageNumber)?.score ?? 0;
        // Capture repair info per fix for the version-viewer dev panel, so every
        // character-fix step is visible: what we asked, what avatar we sent.
        const perCharRepairs = pageFixes
          .map(pf => {
            const d = charFixDetails.get(pf.charName)?.get(pageNumber);
            if (!d) return null;
            return { character: pf.charName, prompt: d.prompt, avatarSent: d.avatarSent, bbox: d.bbox, method: d.method };
          })
          .filter(Boolean);
        const combinedPrompt = perCharRepairs
          .map(r => `[${r.character}${r.method ? ' · ' + r.method : ''}]\n${r.prompt || '(no prompt captured)'}`)
          .join('\n\n');
        const avatarsSent = perCharRepairs.map(r => r.avatarSent).filter(Boolean);
        const lastMethod = perCharRepairs[perCharRepairs.length - 1]?.method || null;
        const modelLabel = lastMethod ? `grok-imagine (${lastMethod})` : 'grok-imagine';
        charFixResults.set(pageNumber, {
          imageData: currentImageData,
          source: 'character-fix',
          modelId: modelLabel,
          method: lastMethod || null,
          repairPrompt: combinedPrompt || null,
          repairAvatars: avatarsSent.length > 0 ? avatarsSent : null,
          repairs: perCharRepairs,
        });
        if (preFixScore >= 85) {
          log.info(`⚠️ [UNIFIED PIPELINE] Page ${pageNumber}: character fix applied to high-score page (pre-fix: ${preFixScore}%), monitor for quality regression`);
        } else {
          log.info(`✅ [UNIFIED PIPELINE] Page ${pageNumber}: character fix applied (pre-fix score: ${preFixScore}%)`);
        }
      }
    })));

    log.info(`✅ [UNIFIED PIPELINE] Step 5: ${charFixResults.size} pages had character fixes applied`);
  } else {
    log.info(`✅ [UNIFIED PIPELINE] Step 5: No entity issues, skipping character fix`);
  }

  // =========================================================================
  // Step 6: Evaluate character-repaired pages
  // =========================================================================
  if (charFixResults.size > 0) {
    await updateProgress(70, `Evaluating ${charFixResults.size} character-repaired pages...`);
    log.info(`🔍 [UNIFIED PIPELINE] Step 6: Evaluating ${charFixResults.size} character-repaired pages...`);

    const charFixEntries = [...charFixResults.entries()].map(([pageNumber, fix]) => ({
      imageData: fix.imageData,
      pageNumber,
    }));

    const charFixEvalInputs = buildEvalInputs(charFixEntries);
    const charFixEvals = await evaluateImageBatch(charFixEvalInputs, { concurrency: evalConcurrency, qualityModelOverride, visualBible });

    for (const ev of charFixEvals) {
      if (ev.usage && usageTracker) {
        usageTracker('gemini_quality', ev.usage, 'unified_pipeline_charfix_eval', ev.modelId);
      }
      const versions = pageVersions.get(ev.pageNumber);
      const fix = charFixResults.get(ev.pageNumber);
      if (versions && fix) {
        versions.push({
          imageData: fix.imageData,
          score: ev.score ?? ev.qualityScore ?? null,
          source: 'character-fix',
          evaluation: ev,
          modelId: fix.modelId || null,
          grokRefImages: null,
          // Reuse the same viewer fields as inpaint: these are the Grok repair
          // prompt and avatar(s) sent as references for the character-fix step.
          inpaintInstruction: fix.repairPrompt || null,
          inpaintReferenceImages: fix.repairAvatars || null,
        });
        fix.afterScore = ev.score ?? ev.qualityScore ?? null;
      }
    }
  }

  // =========================================================================
  // Step 7: Final pick best (including character repair versions)
  // =========================================================================
  await updateProgress(72, 'Selecting final best versions...');
  log.info(`📊 [UNIFIED PIPELINE] Step 7: Final pick best (including character repair versions)...`);

  const finalBestPerPage = new Map();
  let finalUpgradedCount = 0;

  for (const [pageNumber, versions] of pageVersions) {
    const best = selectBestVersion(versions);
    finalBestPerPage.set(pageNumber, best);
    if (best.source !== 'original') {
      finalUpgradedCount++;
    }
  }
  log.info(`✅ [UNIFIED PIPELINE] Step 7: ${finalUpgradedCount} pages upgraded total`);

  await updateProgress(73, 'Finalizing repair results...');

  // =========================================================================
  // Build final results
  // =========================================================================
  log.info(`📦 [UNIFIED PIPELINE] Building final results...`);

  // Repair rounds' eval can leave bboxDetection.figures empty for iterate/inpaint
  // outputs, which makes the UI show all expected characters as "missing" even
  // when they ARE in the image. Re-run bbox detection on the picked best image
  // for any page where figures is empty.
  const freshBboxMap = new Map();
  await Promise.all(rawImages.map(async img => {
    const pageNumber = img.pageNumber;
    const versions = pageVersions.get(pageNumber) || [];
    const best = finalBestPerPage.get(pageNumber) || versions[0];
    const bestBbox = best?.evaluation?.bboxDetection;
    const hasFigures = Array.isArray(bestBbox?.figures) && bestBbox.figures.length > 0;
    if (best?.imageData && !hasFigures && best.source !== 'original') {
      try {
        const fresh = await detectAllBoundingBoxes(best.imageData, {
          pageContext: `P${pageNumber}-final-bbox`,
        });
        if (fresh && Array.isArray(fresh.figures) && fresh.figures.length > 0) {
          freshBboxMap.set(pageNumber, fresh);
          log.info(`📦 [UNIFIED PIPELINE] P${pageNumber}: refreshed bbox (${fresh.figures.length} figures, ${fresh.objects?.length || 0} objects) for ${best.source}`);
        }
      } catch (err) {
        log.warn(`📦 [UNIFIED PIPELINE] P${pageNumber}: bbox refresh failed: ${err.message}`);
      }
    }
  }));

  const results = rawImages.map(img => {
    const pageNumber = img.pageNumber;
    const versions = pageVersions.get(pageNumber) || [];
    const best = finalBestPerPage.get(pageNumber) || versions[0];
    const charFix = charFixResults.get(pageNumber);

    // Final image: best version (which may be original, inpaint, iterate, or character-fix)
    const finalImageData = best?.imageData || img.imageData;
    const finalEval = best?.evaluation;

    // Build imageVersions array — ALL versions in chronological order
    const imageVersions = [];
    const typeFor = (source) => {
      if (source === 'original') return 'original';
      if (source === 'character-fix') return 'entity-repair';
      if (typeof source === 'string' && source.startsWith('text-space-repair')) return 'text-space-repair';
      return 'repair';
    };
    const buildVersionEntry = (v) => ({
      imageData: v.imageData,
      qualityScore: v.score,                                    // combined final (visual − semantic penalty)
      rawQualityScore: v.evaluation?.qualityScore ?? null,      // raw visual eval
      semanticScore: v.evaluation?.semanticScore ?? null,
      semanticResult: v.evaluation?.semanticResult || null,
      entityPenalty: v.entityPenalty ?? 0,
      evaluatedAt: v.evaluatedAt || null,
      issuesSummary: v.evaluation?.issuesSummary || null,
      fixableIssues: v.evaluation?.fixableIssues || [],
      source: v.source,
      type: typeFor(v.source),
      modelId: v.modelId,
      generatedAt: new Date().toISOString(),
      qualityReasoning: v.evaluation?.reasoning || null,
      fixTargets: v.evaluation?.enrichedFixTargets || v.evaluation?.fixTargets || [],
      bboxDetection: v.evaluation?.bboxDetection || null,
      description: img.sceneDescription || null,
      prompt: img.prompt || null,
      grokRefImages: v.grokRefImages || null,
      inpaintInstruction: v.inpaintInstruction || null,
      inpaintReferenceImages: v.inpaintReferenceImages || null,
      textSpaceCoveragePct: v.textSpaceCoveragePct ?? null,
      textSpacePosition: v.textSpacePosition || null,
    });
    for (const v of versions) {
      imageVersions.push(buildVersionEntry(v));
    }

    // Build retryHistory
    const retryHistory = versions.map((v, idx) => ({
      attempt: idx + 1,
      type: 'unified_pipeline',
      source: v.source,
      score: v.score,
      bboxDetection: v.evaluation?.bboxDetection,
      bboxOverlayImage: v.evaluation?.bboxOverlayImage,
      timestamp: new Date().toISOString()
    }));

    return {
      pageNumber,
      imageData: finalImageData,
      text: img.text,
      sceneDescription: img.sceneDescription,
      scene: img.scene,
      prompt: img.prompt,
      characterPhotos: img.characterPhotos,
      landmarkPhotos: img.landmarkPhotos,
      visualBibleGrid: img.visualBibleGrid,
      grokRefImages: best?.grokRefImages || img.grokRefImages || null,
      emptySceneImage: img.emptySceneImage || null,
      emptyScenePrompt: img.emptyScenePrompt || null,
      emptySceneQc: img.emptySceneQc || null,
      textAreaMask: img.textAreaMask || null,
      emptySceneVbGrid: img.emptySceneVbGrid || null,
      textCoverageReport: img.textCoverageReport || null,
      sceneCharacters: img.sceneCharacters,
      sceneMetadata: img.sceneMetadata,
      perCharClothing: img.perCharClothing,
      modelId: best?.modelId || img.modelId,
      thinkingText: img.thinkingText || null,
      qualityScore: best?.score ?? finalEval?.qualityScore ?? null,
      qualityReasoning: finalEval?.reasoning ?? null,
      semanticScore: finalEval?.semanticScore ?? null,
      semanticResult: finalEval?.semanticResult ?? null,
      issuesSummary: finalEval?.issuesSummary ?? null,
      verdict: finalEval?.verdict ?? null,
      fixTargets: finalEval?.enrichedFixTargets || finalEval?.fixTargets || [],
      fixableIssues: finalEval?.fixableIssues || [],
      bboxDetection: freshBboxMap.get(pageNumber) || finalEval?.bboxDetection || null,
      bboxOverlayImage: finalEval?.bboxOverlayImage ?? null,
      figures: finalEval?.figures || [],
      matches: finalEval?.matches || [],
      imageVersions,
      retryHistory,
      entityReport: finalEntityReport || null,
      wasRegenerated: best?.source !== 'original',
      wasCharacterFixed: !!charFix,
      wasInpainted: best?.source?.startsWith('inpaint') || false,
      bestSource: best?.source || 'original'
    };
  });

  log.info(`✅ [UNIFIED PIPELINE] Complete: ${results.length} pages, ${finalUpgradedCount} upgraded, ${charFixResults.size} character-fixed`);

  // Convert charFixDetails Map to plain object for serialization
  const charFixDetailsObj = {};
  for (const [charName, pages] of charFixDetails) {
    charFixDetailsObj[charName] = { pages: {} };
    for (const [pageNum, data] of pages) {
      charFixDetailsObj[charName].pages[pageNum] = {
        comparison: {
          before: data.before.startsWith('data:') ? data.before : `data:image/png;base64,${data.before}`,
          after: data.after.startsWith('data:') ? data.after : `data:image/png;base64,${data.after}`,
          blackoutImage: data.blackoutImage || null,
          grokRawResult: data.grokRawResult || null,
          blendMask: data.blendMask || null,
          croppedAvatar: data.croppedAvatar || null,
        },
        method: data.method || 'grok_blended',
      };
    }
  }

  return { results, charFixDetails: charFixDetailsObj };
}

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
  } = options;
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
    convertClothingToCurrentFormat
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
  const imageDescription = await analyzeGeneratedImage(imageData, characters, visualBible, clothingRequirements);
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Composition analysis complete (${imageDescription.description.length} chars)`);

  // Step 2: Build previewFeedback from the image analysis
  const previewFeedback = {
    composition: imageDescription.description
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

  // Get expected clothing for this page
  const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing || 'standard';

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

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Building scene description prompt with preview feedback...`);

  // Step 3: Build the scene description prompt with preview feedback
  const scenePrompt = buildSceneDescriptionPrompt(
    pageNumber,
    pageText,
    characters,
    shortSceneDesc,
    language,
    visualBible,
    previousScenes,
    expectedClothing,
    '',  // No correction notes for iteration
    availableAvatars,
    null,  // rawOutlineContext
    previewFeedback  // The actual image analysis feedback!
  );

  // Step 4: Call Claude to run 18 checks and generate corrected scene (uses iteration model).
  // Output is prose paragraph + ---METADATA--- + JSON block (same shape as initial expansion,
  // plus the iterate-specific `previewMismatches`, `checks`, `issues`, `corrections`,
  // `draftValidation` fields inside the metadata JSON). No JSON prefill — the response starts
  // with the prose directly.
  const effectiveSceneModel = modelOverrides?.sceneIterationModel || modelOverrides?.sceneModel || CONFIG_DEFAULTS.sceneIteration;
  log.info(`🔄 [ITERATE] Page ${pageNumber}: Running 18 validation checks with ${effectiveSceneModel}...`);
  const sceneResult = await callClaudeAPI(scenePrompt, 16000, effectiveSceneModel);
  const newSceneDescription = sceneResult.text;

  // Track usage (Claude Haiku scene re-expansion)
  if (usageTracker && sceneResult.usage) {
    usageTracker('anthropic', sceneResult.usage, 'scene_iterate', sceneResult.modelId || effectiveSceneModel);
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
  const newSceneMetadata = extractSceneMetadata(newSceneDescription);

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
    clothingCategory = (firstClothing && firstClothing.startsWith('costumed:')) ? firstClothing : (firstClothing || 'standard');
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
    clothingCategory = (firstClothing && firstClothing.startsWith('costumed:')) ? firstClothing : (firstClothing || 'standard');
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
      clothingCategory = (firstClothing && firstClothing.startsWith('costumed:')) ? firstClothing : (firstClothing || 'standard');
      log.debug(`🔄 [ITERATE] Using per-character clothing from pageClothing: ${JSON.stringify(pageClothingEntry)}`);
    } else {
      clothingCategory = parseClothingCategory(newSceneDescription) || pageClothingData?.primaryClothing || 'standard';
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
  let sceneBackground = sceneBackgroundIn;
  if (!sceneBackground && emptySceneCallbacks) {
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
        const { buildTextZoneInstruction } = getStoryHelpers();
        const iterateTextZoneDesc = iterateSceneMetadata?.textZoneDescription || null;
        const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
          STYLE_DESCRIPTION: artStyleDesc,
          EMPTY_SCENE_DESCRIPTION: iterateSceneMetadata.emptyScenePrompt,
          REQUIRED_OBJECTS: '',
          CHARACTER_SPACE: '',
          TEXT_AREA_INSTRUCTION: textPos ? buildTextZoneInstruction(textPos, iterateTextZoneDesc, '25%') : ''
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
  let visualBibleGrid = null;
  let finalLandmarkPhotos = pageLandmarkPhotos;
  if (visualBible) {
    let elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
    let secondaryLandmarks = pageLandmarkPhotos.slice(1);
    if (sceneBackground) {
      elementReferences = elementReferences.filter(e => e.type !== 'vehicle' && e.type !== 'location');
      secondaryLandmarks = [];
      finalLandmarkPhotos = [];
      log.debug(`🔲 [ITERATE] Page ${pageNumber}: sceneBackground set — dropping vehicles/locations/landmarks from composite refs`);
    } else if (useOriginalAsReference || pageLandmarkPhotos.length > 0) {
      elementReferences = elementReferences.filter(e => e.type !== 'location');
    }
    if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
      visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
    }
  }

  // The iterate output is prose + ---METADATA--- + JSON (same shape as initial
  // expansion). buildImagePrompt's prose branch strips the metadata block and
  // uses only the prose for the image prompt — no JSON-scene extraction needed.
  let imagePrompt = buildImagePrompt(newSceneDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true, referencePhotos, { imageBackend: iterateImageBackend, textPositionOverride: lockedTextPosition });

  // Append evaluation feedback if provided
  if (evaluationFeedback) {
    if (usageTracker) {
      // Pipeline caller — append all feedback
      const feedbackParts = [];
      if (evaluationFeedback.reasoning) {
        feedbackParts.push(`IMPORTANT - The previous generation had these quality issues that MUST be fixed:\n${evaluationFeedback.reasoning}`);
      }
      if (evaluationFeedback.fixableIssues?.length > 0) {
        feedbackParts.push('Specific problems to avoid:\n' +
          evaluationFeedback.fixableIssues.slice(0, 10).map(i => `- ${i.description || i.issue || i}`).join('\n'));
      }
      if (feedbackParts.length > 0) {
        imagePrompt = `${imagePrompt}\n\n${feedbackParts.join('\n\n')}`;
        log.info(`🔄 [ITERATE] Page ${pageNumber}: Appended evaluation feedback (score: ${evaluationFeedback.score ?? 'N/A'}, ${evaluationFeedback.fixableIssues?.length ?? 0} issues)`);
      }
    } else {
      // UI route caller — only keep critical issues (missing/wrong elements)
      const criticalIssues = (evaluationFeedback.fixableIssues || [])
        .filter(i => {
          const desc = (i.description || i.issue || '').toLowerCase();
          return desc.includes('missing') || desc.includes('absent') || desc.includes('not present')
            || desc.includes('wrong setting') || desc.includes('wrong location');
        });
      if (criticalIssues.length > 0) {
        const feedbackText = 'IMPORTANT — ensure these elements are present this time:\n' +
          criticalIssues.map(i => `- ${i.description || i.issue || i}`).join('\n');
        imagePrompt = `${imagePrompt}\n\n${feedbackText}`;
        log.info(`🔄 [ITERATE] Page ${pageNumber}: Appended ${criticalIssues.length} critical issues as positive instructions (score: ${evaluationFeedback.score ?? 'N/A'})`);
      }
    }
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

  log.info(`🔄 [ITERATE] Page ${pageNumber}: Generating new image with corrected scene description...`);

  // Step 6: Generate image
  let imageResult;
  if (iterativePlacement) {
    const { resolveArtStyle: resolveIterStyle } = getStoryHelpers();
    const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
    const iterArtStyleDesc = resolveIterStyle(storyData.artStyle || 'pixar', iterBackend) || resolveIterStyle('pixar') || '';
    imageResult = await generateWithIterativePlacement(imagePrompt, referencePhotos, iterateSceneMetadata, {
      imageModelOverride,
      imageBackendOverride: iterBackend,
      landmarkPhotos: finalLandmarkPhotos,
      visualBibleGrid,
      pageNumber,
      artStyle: iterArtStyleDesc,
      sceneBackground,
    });
  } else {
    imageResult = await generateImageWithQualityRetry(
      imagePrompt, referencePhotos, previousImage, 'scene', null, usageTracker, null,
      { imageModel: imageModelOverride },
      `PAGE ${pageNumber} ITERATE`,
      { landmarkPhotos: finalLandmarkPhotos, visualBibleGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata: iterateSceneMetadata, aspectRatio: sceneAspect, sceneBackground, visualBible: storyData?.visualBible || null }
    );
  }

  log.info(`🔄 [ITERATE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
    imagePrompt,
    newScene: newSceneDescription,
    newSceneMetadata,
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

  // Default: Gemini repair
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  const [ymin, xmin, ymax, xmax] = bbox;
  log.info(`👤 [CHAR REPAIR] Starting character replacement for ${charName} at bbox [${bbox.map(v => Math.round(v * 100) + '%').join(', ')}]`);

  // Extract base64 from both images
  const currentBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const avatarBase64 = characterPhoto.replace(/^data:image\/\w+;base64,/, '');

  // Build issue context if provided
  const issueDescription = options.issueDescription || '';
  const issueContext = issueDescription
    ? `\nSPECIFIC ISSUE: ${issueDescription}\n`
    : '';

  // Calculate region description for spatial awareness
  const regionWidth = Math.round((xmax - xmin) * 100);
  const regionHeight = Math.round((ymax - ymin) * 100);
  const centerX = Math.round(((xmin + xmax) / 2) * 100);
  const centerY = Math.round(((ymin + ymax) / 2) * 100);
  const horizontalPos = centerX < 33 ? 'left side' : centerX > 66 ? 'right side' : 'center';
  const verticalPos = centerY < 33 ? 'upper' : centerY > 66 ? 'lower' : 'middle';
  const regionDesc = `${verticalPos} ${horizontalPos}`;

  const prompt = `FIX the character in this illustration. The character at the ${regionDesc} of the scene does NOT correctly match ${charName}'s reference appearance. You MUST change their face to match the reference.

IMAGE 1 (Reference): Shows the CORRECT appearance of ${charName}. This is the ground truth.
IMAGE 2 (Scene to fix): The illustration where the character at the ${regionDesc} needs to be corrected.
${issueContext}
THE CHARACTER TO FIX is located at the ${regionDesc} of the scene (approximately ${regionWidth}% wide, ${regionHeight}% tall, centered at ${centerX}% from left, ${centerY}% from top).

YOU MUST CHANGE the following to match the reference photo:
1. FACE - Match the exact facial features: eyes, nose, mouth shape, face shape from the reference
2. HAIR - Match the exact hair color, style, length, and texture from the reference
3. SKIN TONE - Match the exact skin complexion from the reference
4. BODY PROPORTIONS - Match the age appearance and build from the reference

KEEP UNCHANGED:
- The character's current pose, position, and gesture
- The background and all other elements in the scene
- The art style and lighting
- All other characters in the scene

CRITICAL: The current face is WRONG. You MUST produce a visibly different result where ${charName}'s face matches the reference. If you return the image unchanged, the repair has FAILED.

Output a single corrected image.`;

  // Build parts: prompt, reference image (IMAGE 1), scene to fix (IMAGE 2)
  const parts = [
    { text: prompt },
    { text: `IMAGE 1 — ${charName} reference (CORRECT appearance):` },
    { inline_data: { mime_type: 'image/jpeg', data: avatarBase64 } },
    { text: `IMAGE 2 — Scene to fix (character at ${regionDesc} has WRONG face):` },
    { inline_data: { mime_type: 'image/jpeg', data: currentBase64 } }
  ];

  // Character repair always uses a Gemini image model (pageImage may be Grok)
  const defaultPageImage = MODEL_DEFAULTS.pageImage || '';
  const modelId = defaultPageImage.startsWith('gemini') ? defaultPageImage : 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

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
        temperature: 0.7,  // Moderate temperature to encourage actual changes while staying faithful
        ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } })
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('❌ [CHAR REPAIR] Gemini API error:', error);
    throw new Error(`Character replacement failed: ${response.status}`);
  }

  const data = await response.json();

  // Extract usage
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  const thinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
  log.debug(`📊 [CHAR REPAIR] Token usage - input: ${inputTokens}, output: ${outputTokens}${thinkingTokens ? `, thinking: ${thinkingTokens}` : ''}`);

  // Extract thinking text
  const thinkingText = extractThinkingFromParts(data.candidates?.[0]?.content?.parts, 'CHAR REPAIR');

  // Extract the generated image
  if (data.candidates && data.candidates[0]?.content?.parts) {
    for (const part of data.candidates[0].content.parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
        const repairedImageData = `data:${respMimeType};base64,${inlineData.data}`;
        log.info(`✅ [CHAR REPAIR] Character replacement for ${charName} completed successfully`);
        return {
          imageData: repairedImageData,
          comparison: { before: imageData, after: repairedImageData },
          character: charName,
          usage: { inputTokens, outputTokens, thinkingTokens, model: modelId },
          thinkingText,
          method: 'character_replacement'
        };
      }
    }
  }

  log.warn('⚠️ [CHAR REPAIR] No image in response');
  return { imageData: null, character: charName, method: 'character_replacement' };
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
// Full set of aspect presets the Grok Imagine edit endpoint supports.
// Source: https://docs.x.ai/developers/model-capabilities/images/generation
// Previously we only listed 7 — the other 6 (2:1, 1:2, 19.5:9, 9:19.5, 20:9,
// 9:20) give us tighter snaps for odd cutout shapes, so the scene extract
// can naturally match a preset without any letterbox padding.
const GROK_ASPECT_PRESETS = [
  { name: '1:1',    value: 1.0 },
  { name: '4:3',    value: 4 / 3 },
  { name: '3:4',    value: 3 / 4 },
  { name: '16:9',   value: 16 / 9 },
  { name: '9:16',   value: 9 / 16 },
  { name: '3:2',    value: 3 / 2 },
  { name: '2:3',    value: 2 / 3 },
  { name: '2:1',    value: 2 / 1 },
  { name: '1:2',    value: 1 / 2 },
  { name: '19.5:9', value: 19.5 / 9 },
  { name: '9:19.5', value: 9 / 19.5 },
  { name: '20:9',   value: 20 / 9 },
  { name: '9:20',   value: 9 / 20 },
];
function closestGrokAspect(width, height) {
  if (!width || !height) return '1:1';
  const ratio = width / height;
  let best = GROK_ASPECT_PRESETS[0];
  let bestDist = Infinity;
  for (const p of GROK_ASPECT_PRESETS) {
    const d = Math.abs(p.value - ratio);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best.name;
}

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
function computePresetAlignedExtract({ pixelLeft, pixelTop, pixelWidth, pixelHeight, padFactor, sceneWidth, sceneHeight }) {
  // Start from the minimum-padded box
  const minPadX = Math.floor(pixelWidth * padFactor);
  const minPadY = Math.floor(pixelHeight * padFactor);
  const baseLeft = Math.max(0, pixelLeft - minPadX);
  const baseTop = Math.max(0, pixelTop - minPadY);
  const baseRight = Math.min(sceneWidth, pixelLeft + pixelWidth + minPadX);
  const baseBottom = Math.min(sceneHeight, pixelTop + pixelHeight + minPadY);
  const baseW = baseRight - baseLeft;
  const baseH = baseBottom - baseTop;

  // Pick closest preset to the padded box aspect
  const baseRatio = baseW / baseH;
  let best = GROK_ASPECT_PRESETS[0];
  let bestDist = Infinity;
  for (const p of GROK_ASPECT_PRESETS) {
    const d = Math.abs(p.value - baseRatio);
    if (d < bestDist) { bestDist = d; best = p; }
  }

  // Expand one axis to match preset exactly. Whichever axis grows, the other
  // stays at baseW / baseH so we only ADD scene pixels, never subtract.
  const targetRatio = best.value;
  let targetW, targetH;
  if (baseRatio < targetRatio) {
    // Too tall — grow width
    targetH = baseH;
    targetW = Math.round(baseH * targetRatio);
  } else {
    // Too wide — grow height
    targetW = baseW;
    targetH = Math.round(baseW / targetRatio);
  }

  // If the preset-aligned target exceeds scene bounds on either axis, shrink
  // both axes proportionally so the crop fits (keeps the preset ratio exact).
  // This happens when the base box is already near a scene edge.
  if (targetW > sceneWidth || targetH > sceneHeight) {
    const scale = Math.min(sceneWidth / targetW, sceneHeight / targetH);
    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
  }

  // Center the expanded box on the bbox center, then clamp left/top so the
  // full box fits. Because targetW ≤ sceneWidth and targetH ≤ sceneHeight,
  // clamping can never produce negative coordinates.
  const cx = pixelLeft + pixelWidth / 2;
  const cy = pixelTop + pixelHeight / 2;
  let left = Math.round(cx - targetW / 2);
  let top = Math.round(cy - targetH / 2);
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  if (left + targetW > sceneWidth) left = sceneWidth - targetW;
  if (top + targetH > sceneHeight) top = sceneHeight - targetH;

  return { left, top, width: targetW, height: targetH, preset: best.name };
}

/**
 * Detect uniform pale border in an image (from Grok aspect drift / letterboxing).
 * Returns { left, top, width, height, imgWidth, imgHeight } of the content box, or null.
 */
async function detectGrokBorder(buffer) {
  try {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (width < 100 || height < 100) return null;

    const px = (x, y) => {
      const i = (y * width + x) * channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
    const baseline = [
      Math.round((corners[0][0] + corners[1][0] + corners[2][0] + corners[3][0]) / 4),
      Math.round((corners[0][1] + corners[1][1] + corners[2][1] + corners[3][1]) / 4),
      Math.round((corners[0][2] + corners[1][2] + corners[2][2] + corners[3][2]) / 4),
    ];
    for (const c of corners) {
      if (Math.abs(c[0] - baseline[0]) > 20 || Math.abs(c[1] - baseline[1]) > 20 || Math.abs(c[2] - baseline[2]) > 20) {
        return null;
      }
    }

    const THRESH = 40;
    const deviates = (r, g, b) =>
      Math.abs(r - baseline[0]) > THRESH || Math.abs(g - baseline[1]) > THRESH || Math.abs(b - baseline[2]) > THRESH;

    const maxInset = Math.floor(Math.min(width, height) * 0.4);
    let top = 0;
    for (; top < maxInset; top++) {
      let hit = false;
      for (let x = 0; x < width; x++) { const [r, g, b] = px(x, top); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let bottom = height - 1;
    for (; bottom > height - 1 - maxInset; bottom--) {
      let hit = false;
      for (let x = 0; x < width; x++) { const [r, g, b] = px(x, bottom); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let left = 0;
    for (; left < maxInset; left++) {
      let hit = false;
      for (let y = 0; y < height; y++) { const [r, g, b] = px(left, y); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }
    let right = width - 1;
    for (; right > width - 1 - maxInset; right--) {
      let hit = false;
      for (let y = 0; y < height; y++) { const [r, g, b] = px(right, y); if (deviates(r, g, b)) { hit = true; break; } }
      if (hit) break;
    }

    const contentW = right - left + 1;
    const contentH = bottom - top + 1;
    const maxSideInset = Math.max((width - contentW) / width, (height - contentH) / height);
    if (maxSideInset > 0.45) return null;

    return { left, top, right, bottom, width: contentW, height: contentH, imgWidth: width, imgHeight: height };
  } catch { return null; }
}

/**
 * Detect a border that Grok ADDED to its output that wasn't in the input.
 * Compares border of both images — returns content box only when output has
 * significantly more border than input.
 */
async function detectAddedBorder(inputBuffer, outputBuffer) {
  const outputBorder = await detectGrokBorder(outputBuffer);
  if (!outputBorder) return null;
  const outputLeftFrac = outputBorder.left / outputBorder.imgWidth;
  const outputRightFrac = (outputBorder.imgWidth - outputBorder.right - 1) / outputBorder.imgWidth;
  const outputTopFrac = outputBorder.top / outputBorder.imgHeight;
  const outputBottomFrac = (outputBorder.imgHeight - outputBorder.bottom - 1) / outputBorder.imgHeight;

  const inputBorder = await detectGrokBorder(inputBuffer);
  let inputLeftFrac = 0, inputRightFrac = 0, inputTopFrac = 0, inputBottomFrac = 0;
  if (inputBorder) {
    inputLeftFrac = inputBorder.left / inputBorder.imgWidth;
    inputRightFrac = (inputBorder.imgWidth - inputBorder.right - 1) / inputBorder.imgWidth;
    inputTopFrac = inputBorder.top / inputBorder.imgHeight;
    inputBottomFrac = (inputBorder.imgHeight - inputBorder.bottom - 1) / inputBorder.imgHeight;
  }

  const TOLERANCE = 0.03;
  const leftAdded = outputLeftFrac > inputLeftFrac + TOLERANCE;
  const rightAdded = outputRightFrac > inputRightFrac + TOLERANCE;
  const topAdded = outputTopFrac > inputTopFrac + TOLERANCE;
  const bottomAdded = outputBottomFrac > inputBottomFrac + TOLERANCE;

  if (!leftAdded && !rightAdded && !topAdded && !bottomAdded) return null;
  return outputBorder;
}

async function repairCharacterMismatchWithGrok(imageData, characterPhoto, bbox, charName, options = {}) {
  if (!isGrokConfigured()) {
    throw new Error('XAI_API_KEY not configured for Grok repair');
  }

  let [ymin, xmin, ymax, xmax] = bbox;

  // Validate bbox coordinates — NaN or out-of-range values crash Sharp
  if ([ymin, xmin, ymax, xmax].some(v => v == null || isNaN(v) || v < 0 || v > 1) || ymin >= ymax || xmin >= xmax) {
    log.warn(`⚠️ [CHAR REPAIR GROK] Invalid bbox for ${charName}: [${bbox.join(', ')}] — skipping`);
    return { imageData: null, character: charName, method: 'grok_blended', error: 'Invalid bounding box' };
  }

  // If a separate face bbox is provided and it pokes outside the body bbox
  // (happens when the character detector gives a body box that cuts through
  // the character — the face lands above / beside the body box), expand
  // the body bbox to contain the face. Prevents the crosshatch / blur from
  // missing half the face and leaving a sliver of the original figure that
  // Grok then preserves alongside the repaint.
  const faceBboxIn = options.faceBbox;
  if (Array.isArray(faceBboxIn) && faceBboxIn.length === 4
      && faceBboxIn.every(v => v != null && !isNaN(v) && v >= 0 && v <= 1)) {
    const [fymin, fxmin, fymax, fxmax] = faceBboxIn;
    const faceOutside = fymin < ymin || fxmin < xmin || fymax > ymax || fxmax > xmax;
    if (faceOutside) {
      const unionYmin = Math.min(ymin, fymin);
      const unionXmin = Math.min(xmin, fxmin);
      const unionYmax = Math.max(ymax, fymax);
      const unionXmax = Math.max(xmax, fxmax);
      log.info(`👤 [CHAR REPAIR GROK] Face bbox [${faceBboxIn.map(v => Math.round(v*100)+'%').join(', ')}] outside body bbox [${bbox.map(v => Math.round(v*100)+'%').join(', ')}] — expanding body bbox to union [${[unionYmin, unionXmin, unionYmax, unionXmax].map(v => Math.round(v*100)+'%').join(', ')}]`);
      ymin = unionYmin;
      xmin = unionXmin;
      ymax = unionYmax;
      xmax = unionXmax;
      bbox = [ymin, xmin, ymax, xmax];
    }
  }

  // Default repair mode depends on whiteoutTarget:
  //   - face repair  → blended       (face blur + feathered blend back)
  //   - body repair  → fullSceneInpaint (mirror-pad to 2:3 → crosshatch body +
  //                                      solid face block → Grok edits full scene →
  //                                      unpad. No compositing back, no zoom drift.)
  // Cutout (cropped figure + paste back) is still available via useCutout: true.
  // Blackout (full scene, no mask) is the legacy fallback.
  const whiteoutTargetOpt = options.whiteoutTarget || 'body';
  const defaultToBlended = whiteoutTargetOpt === 'face';
  let useBlended, useCutout, useFullScene;
  if (options.useBlended === true) { useBlended = true; useCutout = false; useFullScene = false; }
  else if (options.useCutout === true) { useBlended = false; useCutout = true; useFullScene = false; }
  else if (options.useFullScene === true) { useBlended = false; useCutout = false; useFullScene = true; }
  else if (options.useBlended === false && options.useCutout === false && options.useFullScene === false) {
    useBlended = false; useCutout = false; useFullScene = false;
  } else {
    useBlended = defaultToBlended;
    useCutout = false;
    useFullScene = !defaultToBlended;
  }
  const method = useBlended ? 'grok_blended' : useCutout ? 'grok_cutout' : useFullScene ? 'grok_inpaint' : 'grok_blackout';

  log.info(`👤 [CHAR REPAIR GROK] Starting ${method} repair for ${charName} at bbox [${bbox.map(v => Math.round(v * 100) + '%').join(', ')}]`);

  // Crop character reference to front column only for styled avatars (2-column grid: front | side)
  // Raw photos are single images — cropping cuts the person in half
  const avatarBase64 = characterPhoto.replace(/^data:image\/\w+;base64,/, '');
  const avatarBuffer = Buffer.from(avatarBase64, 'base64');
  const isAvatarGrid = options.photoType && (options.photoType.startsWith('styled-') || options.photoType.startsWith('costumed-') || options.photoType.startsWith('clothing-'));
  const croppedAvatar = isAvatarGrid ? await cropToFrontColumn(avatarBuffer) : avatarBuffer;
  const croppedAvatarDataUri = `data:image/jpeg;base64,${croppedAvatar.toString('base64')}`;

  const currentBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const sceneBuffer = Buffer.from(currentBase64, 'base64');

  const issueDescription = options.issueDescription || '';
  const clothingDescription = options.clothingDescription || '';
  const sceneDescription = options.sceneDescription || '';
  const issueContext = issueDescription ? `\nIssues to fix: ${issueDescription}` : '';
  const clothingContext = clothingDescription ? `\nClothing: ${clothingDescription}` : '';
  // textPositionContext: when text overlay will land on a fixed zone of the
  // image, tell the model not to move the character into that zone. Inpaint
  // can shift bodies — a face landing in the bottom-left text area would
  // become unreadable once text is composited on top.
  const TEXT_POSITION_DESC = {
    'top-left': 'upper left corner',
    'top-right': 'upper right corner',
    'bottom-left': 'lower left corner',
    'bottom-right': 'lower right corner',
    'top-full': 'upper third (full width)',
    'bottom-full': 'lower third (full width)',
  };
  const textPositionDesc = options.textPosition ? TEXT_POSITION_DESC[options.textPosition] : null;
  const textPositionContext = textPositionDesc
    ? `\n\nQuiet zone: keep the ${textPositionDesc} soft and visually calm — do not place the character's face or any high-contrast detail there. It is intentional negative space in the composition.`
    : '';

  if (useBlended) {
    // ── Blended mode: whiteout head → Grok redraws face → feathered blend ──
    // White out only the face/head area so Grok knows what to fix.
    // The full body bbox is used for the blend region.
    const sceneMeta = await sharp(sceneBuffer).metadata();

    const bboxLeft = Math.floor(xmin * sceneMeta.width);
    const bboxTop = Math.floor(ymin * sceneMeta.height);
    const bboxWidth = Math.max(1, Math.ceil((xmax - xmin) * sceneMeta.width));
    const bboxHeight = Math.max(1, Math.ceil((ymax - ymin) * sceneMeta.height));

    // Face-only blur: blur ALL faces (target + others), leave body/scene untouched.
    // Grok sees blurred faces + reference avatar → redraws all blurred faces.
    // The feathered blend restores non-target faces from the original.
    const faceBbox = options.faceBbox;
    let sceneForGrok = sceneBuffer;

    const composites = [];
    const FACE_BLUR_RADIUS_FACTOR = 0.03; // 3% of face width — very slight blur, enough to signal "redraw this"
    const FACE_PADDING = 0.2; // 20% padding around face bbox

    // Helper: blur a single face region
    const blurFace = async (faceCoords, label) => {
      const [fymin, fxmin, fymax, fxmax] = faceCoords;
      const fW = fxmax - fxmin, fH = fymax - fymin;
      const padXmin = Math.max(0, fxmin - fW * FACE_PADDING);
      const padYmin = Math.max(0, fymin - fH * FACE_PADDING);
      const padXmax = Math.min(1, fxmax + fW * FACE_PADDING);
      const padYmax = Math.min(1, fymax + fH * FACE_PADDING);
      const fLeft = Math.max(0, Math.floor(padXmin * sceneMeta.width));
      const fTop = Math.max(0, Math.floor(padYmin * sceneMeta.height));
      const fWidth = Math.max(1, Math.min(Math.ceil((padXmax - padXmin) * sceneMeta.width), sceneMeta.width - fLeft));
      const fHeight = Math.max(1, Math.min(Math.ceil((padYmax - padYmin) * sceneMeta.height), sceneMeta.height - fTop));
      const blurRadius = Math.max(10, Math.round(fWidth * FACE_BLUR_RADIUS_FACTOR));
      try {
        const blurred = await sharp(sceneBuffer)
          .extract({ left: fLeft, top: fTop, width: fWidth, height: fHeight })
          .blur(blurRadius)
          .toBuffer();
        composites.push({ input: blurred, left: fLeft, top: fTop });
        log.info(`👤 [CHAR REPAIR GROK] Blur ${label}: ${fWidth}x${fHeight} at (${fLeft},${fTop}), radius ${blurRadius}`);
      } catch (err) {
        log.warn(`⚠️ [CHAR REPAIR GROK] Blur ${label} failed: ${err.message}`);
      }
    };

    const whiteoutTarget = options.whiteoutTarget || 'face';
    const protectedFacesForGrok = options.protectedFaces || [];
    const protectedBodiesForGrok = options.protectedBodies || [];

    if (whiteoutTarget === 'body') {
      // Body repair: blur the full body region (face + body + clothing).
      const bodyBox = [ymin, xmin, ymax, xmax];
      await blurFace(bodyBox, `target body (${charName})`);

      // Blur OTHER characters' FULL BODIES (not just faces). This prevents Grok
      // from seeing their hair, skin tone, clothing, or build and trait-bleeding
      // any of those into the target character's redraw. The blend mask then
      // restores these regions from the original via protectedBodies.
      // Fallback: if bodyBox wasn't detected for a figure, its faceBox is still
      // blurred so hair/skin color near the face is hidden (partial protection).
      if (protectedBodiesForGrok.length > 0) {
        for (const pb of protectedBodiesForGrok) {
          await blurFace(pb, 'other body');
        }
      } else {
        // No body boxes available — fall back to blurring other faces only.
        log.warn(`⚠️ [CHAR REPAIR GROK] Body repair: no protectedBodies available, falling back to face-only blur of other characters (trait bleed risk)`);
        for (const pf of protectedFacesForGrok) {
          await blurFace(pf, 'other face (fallback)');
        }
      }
    } else {
      // Face repair: blur only the target face + other characters' faces.
      if (faceBbox) {
        await blurFace(faceBbox, `target face (${charName})`);
      }
      for (const pf of protectedFacesForGrok) {
        await blurFace(pf, 'other face');
      }
    }

    if (composites.length > 0) {
      sceneForGrok = await sharp(sceneBuffer)
        .composite(composites)
        .jpeg({ quality: 90 }).toBuffer();
    }

    const sceneDataUri = `data:image/jpeg;base64,${sceneForGrok.toString('base64')}`;

    // Extract structured character data (expression, gaze, pose) from scene metadata.
    // The face must match the original emotion and gaze direction — not a generic smile.
    let actionContext = '';
    if (sceneDescription) {
      try {
        const sceneMetadata = getStoryHelpers().extractSceneMetadata(sceneDescription);
        const charData = sceneMetadata?.fullData?.characters?.find(
          c => c.name?.toLowerCase() === charName.toLowerCase()
        );
        if (charData) {
          const parts = [];
          if (charData.expression) parts.push(`Expression: ${charData.expression}`);
          if (charData.pose) parts.push(`Pose: ${charData.pose}`);
          if (charData.action) parts.push(`Action: ${charData.action}`);
          if (charData.gaze) parts.push(`Gaze: ${charData.gaze}`);
          if (charData.holding && typeof charData.holding === 'object') {
            const holding = [];
            if (charData.holding.leftHand && charData.holding.leftHand !== 'empty') holding.push(`left hand: ${charData.holding.leftHand}`);
            if (charData.holding.rightHand && charData.holding.rightHand !== 'empty') holding.push(`right hand: ${charData.holding.rightHand}`);
            if (holding.length > 0) parts.push(`Holding: ${holding.join(', ')}`);
          }
          if (parts.length > 0) {
            actionContext = `\n\n${charName}'s state in this scene (MUST be preserved in the redrawn face):\n- ${parts.join('\n- ')}`;
          }
        }
      } catch (err) {
        // Fall back to text-based extraction
      }
      // Fallback: search for character mentions in plain text if no structured data found
      if (!actionContext) {
        const charNameLower = charName.toLowerCase();
        const lines = sceneDescription.split(/[.\n]/).filter(l => l.toLowerCase().includes(charNameLower));
        if (lines.length > 0) {
          actionContext = `\n${charName} in this scene: ${lines.slice(0, 2).join('. ').trim()}`;
        }
      }
    }

    // Pick the template that matches the whiteout mode. Body-mode repair blurs
    // the full figure, so the prompt must tell Grok to repaint the ENTIRE figure
    // (face + hair + body + clothing). The face-only template says "preserve the
    // body, only redo the face" — which left body repairs looking unchanged
    // because Grok obediently preserved the blurry body and only touched the face.
    const repairTemplate = whiteoutTarget === 'body' && PROMPT_TEMPLATES.characterRepairBodyBlended
      ? PROMPT_TEMPLATES.characterRepairBodyBlended
      : PROMPT_TEMPLATES.characterRepairBlended;
    const prompt = repairTemplate
      ? fillTemplate(repairTemplate, {
          charName,
          clothingContext,
          actionContext,
          issueContext,
          textPositionContext,
        })
      : `This is a children's book illustration. All character faces have been blurred. Redraw ALL blurred faces to look like ${charName} from the reference photo. Match face, hair, skin tone exactly. CRITICAL: preserve the original expression (look at body language and scene context — match the emotion, do not default to a smile) and gaze direction (do not make the character face the camera if they were not). Bodies, poses and clothing are fully visible — preserve these. Keep art style and background unchanged.${clothingContext}${actionContext}${issueContext}`;

    // Pick the closest Grok-supported preset to the scene's actual aspect so
    // editWithGrok's internal pad loop doesn't letterbox the scene to 1:1
    // (which then makes Grok return a square image, which our resize back to
    // the non-square scene would stretch). Grok only accepts specific preset
    // ratios for edits — can't pass raw "1024:768".
    const sceneAspectStr = closestGrokAspect(sceneMeta.width, sceneMeta.height);
    log.info(`👤 [CHAR REPAIR GROK] Blended: character at ${bboxWidth}x${bboxHeight} (${bboxLeft},${bboxTop}), head ${faceBbox ? 'blurred' : 'intact'}, scene=${sceneMeta.width}x${sceneMeta.height} (aspect preset=${sceneAspectStr}), sending to Grok...`);
    const grokResult = await editWithGrok(prompt, [croppedAvatarDataUri, sceneDataUri], { aspectRatio: sceneAspectStr, skipOutputPadding: true });

    if (!grokResult.imageData) {
      log.warn('⚠️ [CHAR REPAIR GROK] No image in Grok response');
      return { imageData: null, character: charName, method };
    }

    // C. Decode Grok result. Resize to scene dimensions aspect-preserving
    // (fit:'inside') and letterbox-crop if Grok returned a slightly
    // different aspect. Never fit:'fill' — that stretches the image.
    const grokBase64 = grokResult.imageData.replace(/^data:image\/\w+;base64,/, '');
    let grokBuffer = Buffer.from(grokBase64, 'base64');
    const grokMeta = await sharp(grokBuffer).metadata();
    if (grokMeta.width !== sceneMeta.width || grokMeta.height !== sceneMeta.height) {
      const grokAspect = grokMeta.width / grokMeta.height;
      const sceneAspect = sceneMeta.width / sceneMeta.height;
      const aspectMatches = Math.abs(grokAspect - sceneAspect) / sceneAspect < 0.02;
      log.warn(`⚠️ [CHAR REPAIR GROK] Grok returned ${grokMeta.width}x${grokMeta.height} (aspect ${grokAspect.toFixed(3)}), scene ${sceneMeta.width}x${sceneMeta.height} (aspect ${sceneAspect.toFixed(3)}), aspect ${aspectMatches ? 'matches' : 'MISMATCH'} — ${aspectMatches ? 'proportional resize' : 'cover-crop to recover'}`);
      if (aspectMatches) {
        // Same aspect → simple proportional resize, no distortion
        grokBuffer = await sharp(grokBuffer).resize(sceneMeta.width, sceneMeta.height, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
      } else {
        // Different aspect → center-crop to scene aspect (fit:'cover'), then resize
        grokBuffer = await sharp(grokBuffer)
          .resize(sceneMeta.width, sceneMeta.height, { fit: 'cover', position: 'center' })
          .jpeg({ quality: 95 })
          .toBuffer();
      }
    }

    // D. Calculate blend region: bbox + 10% padding (just enough for the edge feather).
    // Was 50% previously — that caused the blend rectangle to cover a huge chunk of
    // the scene, letting Grok's repaint overwrite background and other elements.
    // Now only a thin ring outside the target bbox gets blended.
    const BLEND_PADDING = 0.1;
    const FEATHER_PX = 30;
    const padX = (xmax - xmin) * BLEND_PADDING;
    const padY = (ymax - ymin) * BLEND_PADDING;
    const blendXmin = Math.max(0, xmin - padX);
    const blendYmin = Math.max(0, ymin - padY);
    const blendXmax = Math.min(1, xmax + padX);
    const blendYmax = Math.min(1, ymax + padY);

    const blendLeft = Math.floor(blendXmin * sceneMeta.width);
    const blendTop = Math.floor(blendYmin * sceneMeta.height);
    const blendWidth = Math.min(sceneMeta.width - blendLeft, Math.ceil((blendXmax - blendXmin) * sceneMeta.width));
    const blendHeight = Math.min(sceneMeta.height - blendTop, Math.ceil((blendYmax - blendYmin) * sceneMeta.height));

    // E. Extract blend regions from both images
    const grokRegion = await sharp(grokBuffer).extract({ left: blendLeft, top: blendTop, width: blendWidth, height: blendHeight }).raw().toBuffer();
    const origRegion = await sharp(sceneBuffer).extract({ left: blendLeft, top: blendTop, width: blendWidth, height: blendHeight }).raw().toBuffer();

    // Pre-compute protected rects in blend-region pixel coords.
    // Other characters must NEVER be changed regardless of whether we're fixing
    // a face or a body — always restore BOTH their faces AND their bodies from
    // the original where they overlap our blend region.
    const protectedSourceBoxes = [
      ...(options.protectedBodies || []),
      ...(options.protectedFaces || []),
    ];
    const protectedRects = protectedSourceBoxes.map(([fymin, fxmin, fymax, fxmax]) => {
      const fw = fxmax - fxmin, fh = fymax - fymin;
      const pad = 0.1;
      const pxmin = Math.max(0, fxmin - fw * pad), pymin = Math.max(0, fymin - fh * pad);
      const pxmax = Math.min(1, fxmax + fw * pad), pymax = Math.min(1, fymax + fh * pad);
      // Clamp coordinates to blend-region pixel space. Without clamping the
      // coordinates can go negative (char straddles blend region boundary) or
      // exceed blendWidth/blendHeight, which breaks the distance calculation
      // below and causes protected characters to bleed traits into the repair.
      return {
        left: Math.max(0, Math.floor(pxmin * sceneMeta.width) - blendLeft),
        top: Math.max(0, Math.floor(pymin * sceneMeta.height) - blendTop),
        right: Math.min(blendWidth, Math.ceil(pxmax * sceneMeta.width) - blendLeft),
        bottom: Math.min(blendHeight, Math.ceil(pymax * sceneMeta.height) - blendTop),
      };
    }).filter(r => r.right > r.left && r.bottom > r.top);
    if (protectedRects.length > 0) {
      log.info(`🛡️ [CHAR REPAIR GROK] Protecting ${protectedRects.length} other-character region(s) from blend`);
    }

    // F. Feathered blend: original outside, Grok inside, gradient at edges
    // Protected faces get smooth feathered transition (not hard rectangle edges)
    const blended = Buffer.alloc(blendWidth * blendHeight * 3);
    const maskPixels = Buffer.alloc(blendWidth * blendHeight);
    for (let i = 0; i < blendWidth * blendHeight; i++) {
      const y = Math.floor(i / blendWidth);
      const x = i % blendWidth;

      // Calculate protection factor: 0 = fully protected, 1 = no protection
      // Uses distance-to-rect with feathered gradient around protected faces
      let protectedAlpha = 1;
      for (const r of protectedRects) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          protectedAlpha = 0;
          break;
        }
        // Euclidean distance to rect boundary — smooth circular feather at corners.
        // Axis-aligned distance: 0 if x is within [r.left, r.right], else distance
        // to the nearest edge. Same for y. Math.max was WRONG here — it returned
        // the largest of (leftGap, 0, rightGap) which is not the distance-to-rect.
        const dx = x < r.left ? r.left - x : (x > r.right ? x - r.right : 0);
        const dy = y < r.top ? r.top - y : (y > r.bottom ? y - r.bottom : 0);
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < FEATHER_PX) {
          protectedAlpha = Math.min(protectedAlpha, dist / FEATHER_PX);
        }
      }

      const dMin = Math.min(x, blendWidth - 1 - x, y, blendHeight - 1 - y);
      const edgeAlpha = dMin >= FEATHER_PX ? 1 : dMin / FEATHER_PX;
      const alpha = edgeAlpha * protectedAlpha;
      maskPixels[i] = Math.round(alpha * 255);
      const idx = i * 3;
      blended[idx]     = Math.round(origRegion[idx]     * (1 - alpha) + grokRegion[idx]     * alpha);
      blended[idx + 1] = Math.round(origRegion[idx + 1] * (1 - alpha) + grokRegion[idx + 1] * alpha);
      blended[idx + 2] = Math.round(origRegion[idx + 2] * (1 - alpha) + grokRegion[idx + 2] * alpha);
    }

    const blendedRegion = await sharp(blended, { raw: { width: blendWidth, height: blendHeight, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    // Composite mask region onto black full-scene canvas to show position
    const maskRegionGray = await sharp(maskPixels, { raw: { width: blendWidth, height: blendHeight, channels: 1 } })
      .toColourspace('srgb').jpeg({ quality: 80 }).toBuffer();
    const blendMaskBuffer = await sharp({ create: { width: sceneMeta.width, height: sceneMeta.height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .jpeg({ quality: 80 }).toBuffer();
    const blendMaskFinal = await sharp(blendMaskBuffer)
      .composite([{ input: maskRegionGray, left: blendLeft, top: blendTop }])
      .jpeg({ quality: 80 }).toBuffer();

    // G. Composite blended region onto original scene
    const composited = await sharp(sceneBuffer)
      .composite([{ input: blendedRegion, left: blendLeft, top: blendTop }])
      .jpeg({ quality: 92 }).toBuffer();

    const finalImageData = `data:image/jpeg;base64,${composited.toString('base64')}`;
    log.info(`✅ [CHAR REPAIR GROK] Blended repair for ${charName} completed. Blend region: ${blendWidth}x${blendHeight}. Cost: $${grokResult.usage?.cost || 0.02}`);

    const originalSceneDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;
    return {
      imageData: finalImageData,
      comparison: { before: originalSceneDataUri, after: finalImageData },
      blackoutImage: `data:image/jpeg;base64,${sceneForGrok.toString('base64')}`,
      grokRawResult: grokResult.imageData,
      blendMask: `data:image/jpeg;base64,${blendMaskFinal.toString('base64')}`,
      croppedAvatar: croppedAvatarDataUri,
      character: charName,
      usage: grokResult.usage,
      method,
      // Debug: what was sent to Grok (for dev panel inspection) — gated by options.includeDebug
      debug: options.includeDebug ? {
        prompt,
        sceneSent: sceneDataUri,
        avatarSent: croppedAvatarDataUri,
        grokRawResult: grokResult.imageData,
        bbox: [ymin, xmin, ymax, xmax],
        faceBbox: faceBbox || null,
        blendRegion: { left: blendLeft, top: blendTop, width: blendWidth, height: blendHeight },
      } : null
    };
  } else if (useCutout) {
    // ── Cut-out mode: extract the figure's bbox + 20% padding, send to Grok
    // as an inpaint-style replacement, composite back with a feathered edge.
    // The surrounding 20% padding gives Grok visual context but the prompt
    // tells it not to change anything outside the figure. The feathered
    // composite hides any small edge mismatches so the seam is invisible.
    const sceneMeta = await sharp(sceneBuffer).metadata();
    const pixelLeft = Math.max(0, Math.floor(xmin * sceneMeta.width));
    const pixelTop = Math.max(0, Math.floor(ymin * sceneMeta.height));
    const pixelWidth = Math.min(sceneMeta.width - pixelLeft, Math.ceil((xmax - xmin) * sceneMeta.width));
    const pixelHeight = Math.min(sceneMeta.height - pixelTop, Math.ceil((ymax - ymin) * sceneMeta.height));

    // Add padding around bbox for context (40% each side minimum), then
    // expand ONE axis so the final crop lands exactly on a Grok-supported
    // aspect preset. No letterbox padding inside editWithGrok — we extract
    // more scene pixels instead of adding white bars, which was the root
    // cause of the "shorter and less wide" seam at composite time.
    //
    // The 40% padding is the MINIMUM — the preset alignment may add more on
    // one axis. That's fine: the extra padding pulls in sharp background,
    // which gives Grok more context AND gives the feather-blend a wider
    // transition zone. Worst case the hatch is off-center in a taller/wider
    // cutout; the hatch coords below are computed from the actual pixelLeft/
    // pixelTop relative to extractLeft/extractTop, so they stay correct.
    const PAD_FACTOR = 0.4;
    const aligned = computePresetAlignedExtract({
      pixelLeft, pixelTop, pixelWidth, pixelHeight,
      padFactor: PAD_FACTOR,
      sceneWidth: sceneMeta.width,
      sceneHeight: sceneMeta.height,
    });
    const extractLeft = aligned.left;
    const extractTop = aligned.top;
    const extractWidth = aligned.width;
    const extractHeight = aligned.height;
    const cutoutAspectStr = aligned.preset;
    log.info(`👤 [CHAR REPAIR GROK] Preset-aligned extract: bbox ${pixelWidth}x${pixelHeight} at (${pixelLeft},${pixelTop}) → ${extractWidth}x${extractHeight} at (${extractLeft},${extractTop}), aspect=${cutoutAspectStr}`);

    // Extract the raw cutout as PNG (lossless) — avoid JPEG round-trips that
    // cause banding artifacts in the feather blend zone. Only the final
    // composite back into the scene gets JPEG-encoded.
    const rawCutoutBuffer = await sharp(sceneBuffer)
      .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
      .png()
      .toBuffer();

    // Overlay a magenta crosshatch pattern on the figure area so Grok has
    // a clear "replace this" signal. Diffusion edit models are trained on
    // watermark / artifact removal, so an obvious foreign pattern is a
    // much stronger disruption signal than a blur (which the model tends
    // to "enhance" instead of replace).
    //
    // The hatch extends 12% beyond the bbox on each side to absorb
    // imperfect bboxes — any figure fragments that poke out past the bbox
    // get covered by the hatch and treated as part of the "remove" zone.
    // With the now-larger 40% extract padding, the outer ~25% of the cutout
    // stays sharp on every side — more than enough for Grok context and the
    // downstream feather blend.
    const figureLeft = pixelLeft - extractLeft;
    const figureTop = pixelTop - extractTop;
    const figureWidth = pixelWidth;
    const figureHeight = pixelHeight;
    const HATCH_SAFETY = 0.12;
    const hatchMarginX = Math.round(figureWidth * HATCH_SAFETY);
    const hatchMarginY = Math.round(figureHeight * HATCH_SAFETY);
    const hatchLeft = Math.max(0, figureLeft - hatchMarginX);
    const hatchTop = Math.max(0, figureTop - hatchMarginY);
    const hatchRight = Math.min(extractWidth, figureLeft + figureWidth + hatchMarginX);
    const hatchBottom = Math.min(extractHeight, figureTop + figureHeight + hatchMarginY);
    const hatchWidth = hatchRight - hatchLeft;
    const hatchHeight = hatchBottom - hatchTop;
    // Thin lines with wide spacing so the figure stays visible through the
    // hatch — Grok still needs pose/silhouette cues. User feedback: previous
    // 3px stroke at 4% spacing covered too much of the figure.
    const hatchSpacing = Math.max(16, Math.round(Math.min(hatchWidth, hatchHeight) * 0.06));
    const HATCH_STROKE = 2;
    const HATCH_COLOR = '#FF00FF'; // bright magenta — unambiguously foreign
    let regionBuffer = rawCutoutBuffer;
    try {
      // Build an SVG crosshatch sized EXACTLY to the hatch region. Extract
      // the hatch sub-region from the raw cutout, paint the SVG onto it,
      // then composite the hatched sub-region back at (hatchLeft, hatchTop).
      // This guarantees magenta pixels only exist inside the hatch rect —
      // SVG stroke-width can't bleed outside a sub-buffer that's only
      // `hatchWidth × hatchHeight` pixels wide.
      const hatchSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${hatchWidth}" height="${hatchHeight}">
  <defs>
    <pattern id="hatch" x="0" y="0" width="${hatchSpacing}" height="${hatchSpacing}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${hatchSpacing}" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
      <line x1="${hatchSpacing}" y1="0" x2="0" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${hatchWidth}" height="${hatchHeight}" fill="url(#hatch)"/>
</svg>`;
      // Extract hatch region, paint hatch onto it, composite back
      const hatchRegionBuffer = await sharp(rawCutoutBuffer)
        .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
        .composite([{ input: Buffer.from(hatchSvg), top: 0, left: 0 }])
        .png()
        .toBuffer();
      regionBuffer = await sharp(rawCutoutBuffer)
        .composite([{ input: hatchRegionBuffer, top: hatchTop, left: hatchLeft }])
        .png()
        .toBuffer();
      log.info(`👤 [CHAR REPAIR GROK] Cut-out ${extractWidth}x${extractHeight} at (${extractLeft},${extractTop}), hatch region ${hatchWidth}x${hatchHeight} @ stroke ${HATCH_STROKE}px spacing ${hatchSpacing}px`);
    } catch (err) {
      log.warn(`⚠️ [CHAR REPAIR GROK] Cut-out hatch overlay failed: ${err.message} — sending raw cutout`);
    }
    const regionDataUri = `data:image/png;base64,${regionBuffer.toString('base64')}`;

    // Extract structured character data (expression, pose, gaze) so the
    // repaired figure matches the original emotion and body language.
    let actionContext = '';
    if (sceneDescription) {
      try {
        const sceneMetadata = getStoryHelpers().extractSceneMetadata(sceneDescription);
        const charData = sceneMetadata?.fullData?.characters?.find(
          c => c.name?.toLowerCase() === charName.toLowerCase()
        );
        if (charData) {
          const parts = [];
          if (charData.expression) parts.push(`Expression: ${charData.expression}`);
          if (charData.pose) parts.push(`Pose: ${charData.pose}`);
          if (charData.action) parts.push(`Action: ${charData.action}`);
          if (charData.gaze) parts.push(`Gaze: ${charData.gaze}`);
          if (charData.holding && typeof charData.holding === 'object') {
            const holding = [];
            if (charData.holding.leftHand && charData.holding.leftHand !== 'empty') holding.push(`left hand: ${charData.holding.leftHand}`);
            if (charData.holding.rightHand && charData.holding.rightHand !== 'empty') holding.push(`right hand: ${charData.holding.rightHand}`);
            if (holding.length > 0) parts.push(`Holding: ${holding.join(', ')}`);
          }
          if (parts.length > 0) {
            actionContext = `\n\n${charName}'s state in this scene (preserve in the repaint):\n- ${parts.join('\n- ')}`;
          }
        }
      } catch { /* fall through to text fallback */ }
      if (!actionContext) {
        const charNameLower = charName.toLowerCase();
        const lines = sceneDescription.split(/[.\n]/).filter(l => l.toLowerCase().includes(charNameLower));
        if (lines.length > 0) {
          actionContext = `\n${charName} in this scene: ${lines.slice(0, 2).join('. ').trim()}`;
        }
      }
    }

    // Art style context — helps Grok match the illustration style
    const artStyleContext = options.artStyle
      ? `\n\nArt style: ${options.artStyle}`
      : '';

    const prompt = PROMPT_TEMPLATES.characterRepairCutout
      ? fillTemplate(PROMPT_TEMPLATES.characterRepairCutout, {
          charName,
          clothingContext,
          actionContext,
          issueContext,
          artStyleContext,
          textPositionContext,
        })
      : `Inpaint: replace the figure in this cutout with ${charName} from the reference photo. Match the reference's face, hair, skin tone, build, and clothing. Keep the original pose, expression, and gaze. Do not change the background or edges — this cutout will be composited back into a larger scene.${clothingContext}${actionContext}${issueContext}${artStyleContext}`;

    // The cutout dims were picked to land exactly on a Grok preset aspect,
    // so editWithGrok's pad-loop will no-op (drift < 1%). No letterbox.
    log.info(`👤 [CHAR REPAIR GROK] Sending cutout ${extractWidth}x${extractHeight} (preset ${cutoutAspectStr}) to Grok`);
    const grokResult = await editWithGrok(prompt, [croppedAvatarDataUri, regionDataUri], { aspectRatio: cutoutAspectStr, skipOutputPadding: true });

    if (!grokResult.imageData) {
      log.warn('⚠️ [CHAR REPAIR GROK] No image in Grok response');
      return { imageData: null, character: charName, method };
    }

    // Decode Grok's output
    const repairedRegionBase64 = grokResult.imageData.replace(/^data:image\/\w+;base64,/, '');
    let repairedRegionBuffer = Buffer.from(repairedRegionBase64, 'base64');

    // Step 1: detect and trim any uniform pale border Grok ADDED (letterbox
    // from aspect drift, internal content-framing bias, API-level padding).
    // Compare against the cutout we SENT (regionBuffer) so we don't trim
    // borders that already existed in the scene.
    const grokCutoutBorder = await detectAddedBorder(regionBuffer, repairedRegionBuffer);
    if (grokCutoutBorder) {
      log.warn(`⚠️ [CHAR REPAIR GROK] Cutout Grok added a border: content ${grokCutoutBorder.width}x${grokCutoutBorder.height} at (${grokCutoutBorder.left},${grokCutoutBorder.top}) — trimming`);
      repairedRegionBuffer = await sharp(repairedRegionBuffer)
        .extract({ left: grokCutoutBorder.left, top: grokCutoutBorder.top, width: grokCutoutBorder.width, height: grokCutoutBorder.height })
        .jpeg({ quality: 95 })
        .toBuffer();
    }

    // Step 2: resize to extract dimensions. Cover-crop only if aspect drifts
    // (shouldn't after the border trim) — never fit:'fill' stretching.
    const grokCutoutMeta = await sharp(repairedRegionBuffer).metadata();
    const grokCutoutAspect = grokCutoutMeta.width / grokCutoutMeta.height;
    const cutoutAspect = extractWidth / extractHeight;
    const cutoutAspectMatches = Math.abs(grokCutoutAspect - cutoutAspect) / cutoutAspect < 0.02;
    if (!cutoutAspectMatches) {
      log.warn(`⚠️ [CHAR REPAIR GROK] Cutout post-trim ${grokCutoutMeta.width}x${grokCutoutMeta.height} (aspect ${grokCutoutAspect.toFixed(3)}), expected ${extractWidth}x${extractHeight} (aspect ${cutoutAspect.toFixed(3)}) — cover-cropping`);
    }
    // Always use 'cover' — 'fill' stretches when aspects differ by even 1-2 pixels
    // after border trimming. Cover crops at most a few pixels and never distorts.
    const resizedRegion = await sharp(repairedRegionBuffer)
      .resize(extractWidth, extractHeight, { fit: 'cover', position: 'center' })
      .raw()
      .toBuffer();

    // Original region pixels for feathered blending
    const origRegion = await sharp(sceneBuffer)
      .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
      .raw()
      .toBuffer();

    // Feathered blend: full Grok content in the center, original pixels at
    // the outer edges. With the now-larger 40% extract padding, the outer
    // ring is thick enough that an 8% feather gives a smooth transition
    // back to the scene without a visible seam.
    const FEATHER_PX = Math.max(20, Math.round(Math.min(extractWidth, extractHeight) * 0.08));
    const blended = Buffer.alloc(extractWidth * extractHeight * 3);
    for (let y = 0; y < extractHeight; y++) {
      for (let x = 0; x < extractWidth; x++) {
        const dMin = Math.min(x, extractWidth - 1 - x, y, extractHeight - 1 - y);
        const alpha = dMin >= FEATHER_PX ? 1 : dMin / FEATHER_PX;
        const idx = (y * extractWidth + x) * 3;
        blended[idx]     = Math.round(origRegion[idx]     * (1 - alpha) + resizedRegion[idx]     * alpha);
        blended[idx + 1] = Math.round(origRegion[idx + 1] * (1 - alpha) + resizedRegion[idx + 1] * alpha);
        blended[idx + 2] = Math.round(origRegion[idx + 2] * (1 - alpha) + resizedRegion[idx + 2] * alpha);
      }
    }
    const blendedRegion = await sharp(blended, { raw: { width: extractWidth, height: extractHeight, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const composited = await sharp(sceneBuffer)
      .composite([{ input: blendedRegion, left: extractLeft, top: extractTop }])
      .jpeg({ quality: 92 })
      .toBuffer();

    const finalImageData = `data:image/jpeg;base64,${composited.toString('base64')}`;
    const originalSceneDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;
    log.info(`✅ [CHAR REPAIR GROK] Cut-out repair for ${charName} completed (feather ${FEATHER_PX}px). Cost: $${grokResult.usage?.cost || 0.02}`);

    // The cutout sent to Grok is always returned in the comparison payload
    // so the UI can show exactly what was inpainted (alongside before/after).
    return {
      imageData: finalImageData,
      comparison: {
        before: originalSceneDataUri,
        after: finalImageData,
        cutoutSent: regionDataUri,
        grokRawResult: grokResult.imageData,
      },
      croppedAvatar: croppedAvatarDataUri,
      character: charName,
      usage: grokResult.usage,
      method,
      debug: options.includeDebug ? {
        prompt,
        sceneSent: regionDataUri,
        avatarSent: croppedAvatarDataUri,
        grokRawResult: grokResult.imageData,
        bbox: [ymin, xmin, ymax, xmax],
        extractRegion: { left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight },
        featherPx: FEATHER_PX,
      } : null,
    };
  } else if (useFullScene) {
    // ── Full-scene inpaint: pad scene to Grok's 2:3 preset with mirror,
    //    paint magenta crosshatch on the body bbox + solid magenta block
    //    on the face area, send full padded scene to Grok. Grok edits the
    //    whole scene; we crop the mirror padding off and we're done.
    //    No paste-back → no seam artifacts. Aspect padding → no zoom drift
    //    on repeated iterations. ──
    const sceneMeta = await sharp(sceneBuffer).metadata();

    // Step 1 — pad scene to exact 2:3 aspect (Grok's standard preset).
    // Mirror extension keeps the padding visually plausible so Grok doesn't
    // try to "fix" the padding region. After Grok responds we crop it off
    // exactly, losing zero scene pixels per iteration.
    const GROK_ASPECT_W = 2;
    const GROK_ASPECT_H = 3;
    const targetAspect = GROK_ASPECT_W / GROK_ASPECT_H;
    const sceneAspect = sceneMeta.width / sceneMeta.height;
    let padTop = 0, padBottom = 0, padLeft = 0, padRight = 0;
    let paddedW = sceneMeta.width, paddedH = sceneMeta.height;
    if (Math.abs(sceneAspect - targetAspect) > 0.005) {
      if (sceneAspect > targetAspect) {
        paddedH = Math.round(sceneMeta.width / targetAspect);
        const total = paddedH - sceneMeta.height;
        padTop = Math.floor(total / 2);
        padBottom = total - padTop;
      } else {
        paddedW = Math.round(sceneMeta.height * targetAspect);
        const total = paddedW - sceneMeta.width;
        padLeft = Math.floor(total / 2);
        padRight = total - padLeft;
      }
    }
    const paddedScene = (padTop || padBottom || padLeft || padRight)
      ? await sharp(sceneBuffer)
          .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, extendWith: 'mirror' })
          .jpeg({ quality: 95 }).toBuffer()
      : sceneBuffer;

    // Step 2 — figure & face rectangles in padded-canvas pixel coords.
    const figLeft   = Math.floor(xmin * sceneMeta.width) + padLeft;
    const figTop    = Math.floor(ymin * sceneMeta.height) + padTop;
    const figWidth  = Math.max(1, Math.ceil((xmax - xmin) * sceneMeta.width));
    const figHeight = Math.max(1, Math.ceil((ymax - ymin) * sceneMeta.height));

    // Step 3 — magenta crosshatch on the body bbox + 12% safety margin.
    const HATCH_SAFETY = 0.12;
    const HATCH_STROKE = 2;
    const HATCH_COLOR = '#FF00FF';
    const hatchMarginX = Math.round(figWidth * HATCH_SAFETY);
    const hatchMarginY = Math.round(figHeight * HATCH_SAFETY);
    const hatchLeft   = Math.max(0, figLeft - hatchMarginX);
    const hatchTop    = Math.max(0, figTop - hatchMarginY);
    const hatchRight  = Math.min(paddedW, figLeft + figWidth + hatchMarginX);
    const hatchBottom = Math.min(paddedH, figTop + figHeight + hatchMarginY);
    const hatchWidth  = hatchRight - hatchLeft;
    const hatchHeight = hatchBottom - hatchTop;
    const hatchSpacing = Math.max(16, Math.round(Math.min(hatchWidth, hatchHeight) * 0.06));
    const hatchSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${hatchWidth}" height="${hatchHeight}">
  <defs>
    <pattern id="h" x="0" y="0" width="${hatchSpacing}" height="${hatchSpacing}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${hatchSpacing}" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
      <line x1="${hatchSpacing}" y1="0" x2="0" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${hatchWidth}" height="${hatchHeight}" fill="url(#h)"/>
</svg>`;
    const hatchRegion = await sharp(paddedScene)
      .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
      .composite([{ input: Buffer.from(hatchSvg), top: 0, left: 0 }])
      .png().toBuffer();
    let masked = await sharp(paddedScene)
      .composite([{ input: hatchRegion, top: hatchTop, left: hatchLeft }])
      .jpeg({ quality: 92 }).toBuffer();

    // Step 4 — solid magenta block over the face. Use options.faceBbox if
    // provided (entity consistency passes one when face detection ran);
    // otherwise heuristic = top 22% of body, narrower than full body width.
    let faceLeft, faceTop, faceWidth, faceHeight;
    const faceBboxOpt = options.faceBbox;
    if (Array.isArray(faceBboxOpt) && faceBboxOpt.length === 4
        && faceBboxOpt.every(v => v != null && !isNaN(v) && v >= 0 && v <= 1)) {
      const [fy0, fx0, fy1, fx1] = faceBboxOpt;
      faceLeft   = Math.floor(fx0 * sceneMeta.width) + padLeft;
      faceTop    = Math.floor(fy0 * sceneMeta.height) + padTop;
      faceWidth  = Math.max(1, Math.ceil((fx1 - fx0) * sceneMeta.width));
      faceHeight = Math.max(1, Math.ceil((fy1 - fy0) * sceneMeta.height));
    } else {
      const headFraction = 0.22;
      const headWidthFraction = 0.60;
      faceHeight = Math.round(figHeight * headFraction);
      faceWidth  = Math.round(figWidth * headWidthFraction);
      faceTop    = figTop;
      faceLeft   = figLeft + Math.round((figWidth - faceWidth) / 2);
    }
    // Pad ~10% so ears/jawline are covered too.
    const facePad = Math.round(Math.min(faceWidth, faceHeight) * 0.10);
    faceLeft = Math.max(0, faceLeft - facePad);
    faceTop  = Math.max(0, faceTop - facePad);
    const faceRight  = Math.min(paddedW, faceLeft + faceWidth + facePad * 2);
    const faceBottom = Math.min(paddedH, faceTop + faceHeight + facePad * 2);
    faceWidth  = faceRight - faceLeft;
    faceHeight = faceBottom - faceTop;
    const solidFace = await sharp({
      create: { width: faceWidth, height: faceHeight, channels: 3, background: HATCH_COLOR },
    }).jpeg({ quality: 95 }).toBuffer();
    masked = await sharp(masked)
      .composite([{ input: solidFace, top: faceTop, left: faceLeft }])
      .jpeg({ quality: 92 }).toBuffer();

    log.info(`👤 [CHAR REPAIR GROK] Inpaint canvas ${paddedW}x${paddedH} (pad t${padTop} b${padBottom} l${padLeft} r${padRight}); hatch ${hatchWidth}x${hatchHeight} @ (${hatchLeft},${hatchTop}); face block ${faceWidth}x${faceHeight} @ (${faceLeft},${faceTop})`);

    // Step 5 — build action context (expression / pose / gaze / holding).
    // This is what stops repaired characters defaulting to "smiling at the
    // camera". The block is placed early in the prompt where image models
    // weight it most heavily.
    let actionContext = '';
    if (sceneDescription) {
      try {
        const sceneMetadata = getStoryHelpers().extractSceneMetadata(sceneDescription);
        const charData = sceneMetadata?.fullData?.characters?.find(
          c => c.name?.toLowerCase() === charName.toLowerCase()
        );
        if (charData) {
          const parts = [];
          if (charData.action)     parts.push(`Action: ${charData.action}`);
          if (charData.pose)       parts.push(`Pose: ${charData.pose}`);
          if (charData.expression) parts.push(`Expression: ${charData.expression}`);
          if (charData.gaze)       parts.push(`Gaze: ${charData.gaze}`);
          if (charData.holding && typeof charData.holding === 'object') {
            const h = [];
            if (charData.holding.leftHand && charData.holding.leftHand !== 'empty')   h.push(`left hand: ${charData.holding.leftHand}`);
            if (charData.holding.rightHand && charData.holding.rightHand !== 'empty') h.push(`right hand: ${charData.holding.rightHand}`);
            if (h.length) parts.push(`Holding: ${h.join(', ')}`);
          }
          if (parts.length) {
            actionContext = `\n\n${charName} in this scene (the repainted figure MUST match this exactly):\n- ${parts.join('\n- ')}`;
          }
        }
      } catch { /* fall through to text fallback */ }
      if (!actionContext) {
        const lower = charName.toLowerCase();
        const lines = sceneDescription.split(/[.\n]/).filter(l => l.toLowerCase().includes(lower));
        if (lines.length) {
          actionContext = `\n\n${charName} in this scene: ${lines.slice(0, 2).join('. ').trim()}`;
        }
      }
    }

    // Step 6 — build the prompt.
    const cx = Math.round(((xmin + xmax) / 2) * 100);
    const cy = Math.round(((ymin + ymax) / 2) * 100);
    const hPos = cx < 33 ? 'left side' : cx > 66 ? 'right side' : 'center';
    const vPos = cy < 33 ? 'upper' : cy > 66 ? 'lower' : 'middle';
    const regionDesc = `${vPos} ${hPos}`;
    const artStyleContext = options.artStyle ? `\n\nArt style of the surrounding illustration: ${options.artStyle}.` : '';

    const prompt = PROMPT_TEMPLATES.characterRepairInpaint
      ? fillTemplate(PROMPT_TEMPLATES.characterRepairInpaint, {
          charName,
          regionDesc,
          actionContext,
          clothingContext,
          issueContext,
          artStyleContext,
          textPositionContext,
        })
      : `Inpaint task: paint ${charName} into this children's book illustration. Magenta marks (at the ${regionDesc}) show what to repaint — crosshatch over body, solid block over face. Replace ALL magenta with one ${charName} from the reference photo.${actionContext}\n\nMatch the reference's face, hair, skin tone, and build. Preserve framing — do not zoom in or crop. Keep other characters and background unchanged.${clothingContext}${issueContext}${artStyleContext}`;

    // Step 7 — send to Grok at 2:3 (already matches our padded canvas).
    log.info(`👤 [CHAR REPAIR GROK] Sending inpaint canvas ${paddedW}x${paddedH} to Grok`);
    const grokResult = await editWithGrok(prompt, [croppedAvatarDataUri, `data:image/jpeg;base64,${masked.toString('base64')}`], {
      aspectRatio: '2:3',
      skipOutputPadding: true,
    });

    if (!grokResult.imageData) {
      log.warn(`⚠️ [CHAR REPAIR GROK] No image in Grok response (inpaint mode)`);
      return { imageData: null, character: charName, method };
    }

    // Step 8 — resize Grok output to padded dims (aspects match → fill is safe),
    // then crop the mirror padding off → exact original scene dims, zero loss.
    const rawBuf = Buffer.from(grokResult.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const resizedToPadded = await sharp(rawBuf)
      .resize(paddedW, paddedH, { fit: 'fill' })
      .toBuffer();
    const finalBuf = await sharp(resizedToPadded)
      .extract({ left: padLeft, top: padTop, width: sceneMeta.width, height: sceneMeta.height })
      .jpeg({ quality: 95 }).toBuffer();

    const finalImageData = `data:image/jpeg;base64,${finalBuf.toString('base64')}`;
    const originalSceneDataUri = `data:image/jpeg;base64,${sceneBuffer.toString('base64')}`;
    const sentToGrokDataUri = `data:image/jpeg;base64,${masked.toString('base64')}`;
    log.info(`✅ [CHAR REPAIR GROK] Inpaint repair for ${charName} completed. Cost: $${grokResult.usage?.cost || 0.02}`);

    return {
      imageData: finalImageData,
      comparison: {
        before: originalSceneDataUri,
        after: finalImageData,
        sentToGrok: sentToGrokDataUri,
        grokRawResult: grokResult.imageData,
      },
      croppedAvatar: croppedAvatarDataUri,
      character: charName,
      usage: grokResult.usage,
      method,
      debug: options.includeDebug ? {
        prompt,
        sceneSent: sentToGrokDataUri,
        avatarSent: croppedAvatarDataUri,
        grokRawResult: grokResult.imageData,
        bbox: [ymin, xmin, ymax, xmax],
        faceBbox: faceBboxOpt || null,
        padInfo: { padTop, padBottom, padLeft, padRight, paddedW, paddedH },
        hatchRect: { left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight },
        faceRect: { left: faceLeft, top: faceTop, width: faceWidth, height: faceHeight },
      } : null,
    };
  } else {
    // ── Full-scene mode (blackout): send full scene + reference to Grok ──
    const regionWidth = Math.round((xmax - xmin) * 100);
    const regionHeight = Math.round((ymax - ymin) * 100);
    const centerX = Math.round(((xmin + xmax) / 2) * 100);
    const centerY = Math.round(((ymin + ymax) / 2) * 100);
    const horizontalPos = centerX < 33 ? 'left side' : centerX > 66 ? 'right side' : 'center';
    const verticalPos = centerY < 33 ? 'upper' : centerY > 66 ? 'lower' : 'middle';
    const regionDesc = `${verticalPos} ${horizontalPos}`;

    const prompt = `Fix the character at the ${regionDesc} of this illustration. Their face does not match the reference photo of ${charName}. Change their face, hair, and skin tone to match the reference exactly. The character is at approximately ${centerX}% from left, ${centerY}% from top, ${regionWidth}% wide, ${regionHeight}% tall. Keep the pose, background, art style, and all other characters unchanged.${issueContext}`;

    const grokResult = await editWithGrok(prompt, [croppedAvatarDataUri, imageData], { aspectRatio: CONFIG_DEFAULTS.pageAspect });

    log.info(`✅ [CHAR REPAIR GROK] Full-scene repair for ${charName} completed. Cost: $${grokResult.usage?.cost || 0.02}`);

    return {
      imageData: grokResult.imageData,
      comparison: { before: imageData, after: grokResult.imageData },
      croppedAvatar: croppedAvatarDataUri,
      character: charName,
      usage: grokResult.usage,
      method
    };
  }
}


/**
 * Edit an image based on a user-provided prompt using Gemini's image editing capabilities
 * Pure text/instruction based - no character photos to avoid regeneration artifacts
 * @param {string} imageData - The original image data (base64)
 * @param {string} editInstruction - What the user wants to change
 * @returns {Promise<{imageData: string}|null>}
 */
async function editImageWithPrompt(imageData, editInstruction, model, referenceImages = []) {
  const modelId = model || MODEL_DEFAULTS.pageImage;
  const modelConfig = IMAGE_MODELS[modelId];
  const backend = modelConfig?.backend || 'gemini';
  const aspectRatio = CONFIG_DEFAULTS.pageAspect;

  log.debug(`✏️  [IMAGE EDIT] Editing image with instruction: "${editInstruction}" (model: ${modelId}, backend: ${backend}, refs: ${referenceImages.length}, aspect: ${aspectRatio})`);

  // Build the editing prompt from template
  const editPrompt = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, {
    EDIT_INSTRUCTION: editInstruction
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
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
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
            aspectRatio: CONFIG_DEFAULTS.pageAspect
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
 * Generate image with automatic retry if quality score is below threshold
 * Stores all attempts for dev mode viewing
 * @param {string} prompt - The image generation prompt
 * @param {string[]} characterPhotos - Character reference photos
 * @param {string|null} previousImage - Previous image for sequential mode
 * @param {string} evaluationType - Type of evaluation ('scene' or 'cover')
 * @param {Function|null} onImageReady - Optional callback called immediately when image is generated (before quality eval)
 * @param {Function|null} usageTracker - Optional callback to track token usage: (imageUsage, qualityUsage) => void
 * @param {Function|null} callTextModel - Function to call text model for scene rewriting
 * @param {Object|null} modelOverrides - Model overrides: { imageModel, qualityModel, imageBackend }
 * @param {string} pageContext - Context label for logging
 * @param {Object} options - Additional options: { isAdmin, landmarkPhotos, visualBibleGrid }
 * @returns {Promise<{imageData, score, reasoning, wasRegenerated, retryHistory, totalAttempts}>}
 */
async function generateImageWithQualityRetry(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, usageTracker = null, callTextModel = null, modelOverrides = null, pageContext = '', options = {}) {
  const {
    isAdmin = false,
    enableAutoRepair: enableAutoRepairInput = false,
    landmarkPhotos = [],
    sceneCharacterCount = 0,
    // Visual Bible reference grid (combines secondary chars, objects, 2nd+ landmarks)
    visualBibleGrid = null,
    // Incremental consistency options
    incrementalConsistency: incrementalConsistencyInput = null,  // { enabled, dryRun, lookbackCount, previousImages, ... }
    // Check-only mode: run all checks but skip regeneration/repair
    checkOnlyMode = false,
    // Grid-based repair: extracts issues, creates grids, repairs with Gemini, verifies
    // Defaults to true when enableAutoRepair is true (use grid repair instead of legacy inpainting)
    useGridRepair: useGridRepairInput = null,
    // Output directory for grid-based repair (auto-generated if not provided)
    gridRepairOutputDir: gridRepairOutputDirInput = null,
    // Story ID for grid-based repair manifest
    storyId = null,
    // Force repair threshold: when set, repair ANY page with fixable issues if score < this value
    // Default: null (use standard logic). Set to 100 to always repair pages with issues.
    // Can also be passed via incrementalConsistency.forceRepairThreshold
    forceRepairThreshold: forceRepairThresholdInput = null,
    // Full character objects for rich bbox descriptions (from scene character lookup)
    sceneCharacters = [],
    // Pre-extracted scene metadata with character positions (avoids re-parsing from flattened prompt)
    sceneMetadata: sceneMetadataInput = null,
    // Story text and scene hint for semantic evaluation (text-to-image fidelity)
    storyText = null,
    sceneHint = null,
    sceneBackground = null,
    // Aspect ratio override — if set, wins over the MODEL_DEFAULTS.pageAspect /
    // coverAspect / avatarAspect defaults inside callGeminiAPIForImage.
    // Used by iteratePage to preserve the scene's configured aspect across repairs.
    aspectRatio: aspectRatioOverride = null,
    // Full Visual Bible — used to enrich bbox character descriptions when scene
    // metadata references entities (animals, secondary characters) that aren't in
    // sceneCharacters. Without this, e.g. a dragon "Floh" registered as ANI001
    // gets sent to the bbox detector with no traits and is reported as UNKNOWN.
    visualBible = null,
  } = options;

  // Extract forceRepairThreshold from incrementalConsistency if not provided directly
  const forceRepairThreshold = forceRepairThresholdInput !== null
    ? forceRepairThresholdInput
    : (incrementalConsistencyInput?.forceRepairThreshold ?? null);

  // In check-only mode: only 1 attempt, no auto-repair, force dry-run for consistency
  // enableQualityRetry: when false, generate once and accept (no retry on low scores)
  const enableQualityRetry = options.enableQualityRetry === true; // Default: false
  const MAX_ATTEMPTS = checkOnlyMode ? 1 : (enableQualityRetry ? 3 : 1);
  const enableAutoRepair = checkOnlyMode ? false : enableAutoRepairInput;
  const incrementalConsistency = checkOnlyMode && incrementalConsistencyInput
    ? { ...incrementalConsistencyInput, dryRun: true }
    : incrementalConsistencyInput;

  // Grid repair: enabled by default (new system) unless explicitly disabled
  const useGridRepair = useGridRepairInput !== null ? useGridRepairInput : CONFIG_DEFAULTS.useGridRepair;
  // Auto-generate output directory for grid repair if not provided
  const gridRepairOutputDir = gridRepairOutputDirInput || (useGridRepair ? path.join(os.tmpdir(), 'grid-repair', `job-${Date.now()}`) : null);

  if (useGridRepair && enableAutoRepair) {
    log.info(`🔲 [QUALITY RETRY] Grid-based repair enabled (output: ${gridRepairOutputDir})`);
  }

  if (forceRepairThreshold !== null && enableAutoRepair) {
    log.info(`🔧 [QUALITY RETRY] Force repair threshold: ${forceRepairThreshold}% (will repair any page with issues below this score)`);
  }

  if (checkOnlyMode) {
    log.debug(`🔍 [QUALITY RETRY] Check-only mode: MAX_ATTEMPTS=1, autoRepair=OFF, incrementalDryRun=ON`);
  }
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  // Extract page number from pageContext for cache key uniqueness
  const pageMatch = pageContext.match(/PAGE\s*(\d+)/i);
  const pageNumber = pageMatch ? parseInt(pageMatch[1], 10) : null;

  let bestResult = null;
  let bestScore = -1;
  let attempts = 0;
  let currentPrompt = prompt;
  let wasSceneRewritten = false;

  // Store all attempts for dev mode
  const retryHistory = [];

  // Track bbox detection across attempts (declared outside loop so return after loop can access them)
  let bboxDetectionHistory = null;
  let bboxOverlayImage = null;
  let enrichedFixTargets = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    log.debug(`🎨 [QUALITY RETRY] ${pageLabel}Attempt ${attempts}/${MAX_ATTEMPTS} (threshold: ${IMAGE_QUALITY_THRESHOLD}%)...`);

    // Clear cache for retries to force new generation
    if (attempts > 1) {
      const cacheKey = generateImageCacheKey(currentPrompt, characterPhotos, previousImage ? 'seq' : null, pageNumber);
      imageCache.delete(cacheKey);
    }

    let result;
    try {
      const imageModelOverride = modelOverrides?.imageModel || null;
      const qualityModelOverride = modelOverrides?.qualityModel || null;
      const imageBackendOverride = modelOverrides?.imageBackend || null;
      result = await callGeminiAPIForImage(currentPrompt, characterPhotos, previousImage, evaluationType, onImageReady, imageModelOverride, qualityModelOverride, pageContext, imageBackendOverride, landmarkPhotos, sceneCharacterCount, visualBibleGrid, storyText, sceneHint, sceneBackground, aspectRatioOverride, sceneCharacters);
      // Track usage if tracker provided
      if (usageTracker && result) {
        usageTracker(result.imageUsage, result.qualityUsage, result.modelId, result.qualityModelId);
      }
    } catch (error) {
      // Check if this is a safety/content block error
      // "no candidates" means Gemini refused to generate - likely safety filter
      const errorMsg = error.message.toLowerCase();
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                           errorMsg.includes('prohibited') || errorMsg.includes('filtered') ||
                           errorMsg.includes('no candidates') || errorMsg.includes('moderation');

      if (isSafetyBlock && !wasSceneRewritten && attempts < MAX_ATTEMPTS && callTextModel) {
        log.debug(`🚫 [QUALITY RETRY] Image blocked by safety filter, attempting to rewrite scene...`);

        // Extract scene description from prompt - supports English, German, and French
        const sceneMatch = currentPrompt.match(/Scene Description:\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/\*\*SCENE:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/Szenenbeschreibung:\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/Description de la scène:\s*([\s\S]*?)(?=\n\n\*\*|$)/i);

        if (sceneMatch && sceneMatch[1]) {
          try {
            const originalScene = sceneMatch[1].trim();
            const rewriteResult = await rewriteBlockedScene(originalScene, callTextModel);
            const rewrittenScene = rewriteResult.text;

            // Replace scene in prompt
            currentPrompt = currentPrompt.replace(originalScene, rewrittenScene);
            wasSceneRewritten = true;

            // Record the rewrite attempt
            retryHistory.push({
              attempt: attempts,
              type: 'safety_block_rewrite',
              originalScene: originalScene.substring(0, 200),
              rewrittenScene: rewrittenScene.substring(0, 200),
              rewriteUsage: rewriteResult.usage,
              error: error.message,
              timestamp: new Date().toISOString()
            });

            // Don't increment attempts for the rewrite, let it retry with new prompt
            attempts--;
            continue;
          } catch (rewriteError) {
            log.error(`❌ [QUALITY RETRY] Scene rewrite failed:`, rewriteError.message);
          }
        } else {
          log.warn(`[QUALITY RETRY] Could not extract scene from prompt for rewriting. First 500 chars: ${currentPrompt.substring(0, 500)}`);
        }
      }

      // If we can't recover, record the error and continue
      retryHistory.push({
        attempt: attempts,
        type: 'generation_failed',
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // If this was the last attempt, throw the error
      if (attempts >= MAX_ATTEMPTS) {
        throw error;
      }
      continue;
    }
    // Distinguish between: eval returned null/failed vs eval returned a score
    // When score is null, the image was generated fine but quality eval was blocked
    const evalWasBlocked = result.score === null || result.score === undefined;
    let score = evalWasBlocked ? null : result.score;

    if (evalWasBlocked) {
      log.debug(`⭐ [QUALITY RETRY] ${pageLabel}Attempt ${attempts}: quality eval was blocked/failed`);
    } else {
      log.debug(`⭐ [QUALITY RETRY] ${pageLabel}Attempt ${attempts} score: ${score}%`);
    }

    // Check for text errors on covers (but not when "NO TEXT" was expected and is missing)
    const noTextExpected = result.expectedText && result.expectedText.toUpperCase() === 'NO TEXT';
    const isExpectedNoText = noTextExpected && result.textIssue === 'MISSING';
    const hasTextError = evaluationType === 'cover' &&
      result.textIssue &&
      result.textIssue !== 'NONE' &&
      !isExpectedNoText;

    if (hasTextError) {
      log.debug(`📝 [QUALITY RETRY] Text error: ${result.textIssue}`);
      log.debug(`📝 [QUALITY RETRY] Expected: "${result.expectedText}" | Actual: "${result.actualText}"`);
    } else if (isExpectedNoText) {
      console.log(`✅ [QUALITY RETRY] No text expected and none found - correct`);
    }

    // Store this attempt in history (including imageData for dev mode debugging)
    retryHistory.push({
      attempt: attempts,
      type: 'generation',
      score: score,
      evalSkipped: evalWasBlocked,
      reasoning: result.reasoning,
      thinkingText: result.thinkingText || null,  // Gemini thinking/reasoning (if available)
      textIssue: result.textIssue,
      expectedText: result.expectedText,
      actualText: result.actualText,
      imageData: result.imageData,  // Include for dev mode Generierungshistorie
      modelId: result.modelId,
      timestamp: new Date().toISOString()
    });

    // Track if this is the best so far (only compare when we have scores)
    if (score !== null && score > bestScore) {
      bestScore = score;
      bestResult = result;
    } else if (bestResult === null) {
      // First result - keep it even if eval was blocked
      bestResult = result;
    }

    // If eval was blocked (after fallback attempted in evaluateImageQuality), accept the image
    // The image itself was generated successfully, only the evaluation failed
    if (evalWasBlocked) {
      log.warn(`⚠️  [QUALITY RETRY] ${pageLabel}Accepting image (quality eval was blocked/failed after fallback)`);
      // Extract rewrite usage from retryHistory if a scene was rewritten
      const rewriteEntry = retryHistory.find(h => h.type === 'safety_block_rewrite' && h.rewriteUsage);
      return {
        ...result,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts,
        evalSkipped: true,
        score: null,
        rewriteUsage: rewriteEntry?.rewriteUsage || null
      };
    }

    // INCREMENTAL CONSISTENCY CHECK: If enabled, compare with previous images
    let consistencyResult = null;
    let unifiedReport = null;
    const incrConfig = incrementalConsistency || {};
    const incrEnabled = incrConfig.enabled && evaluationType === 'scene' && incrConfig.previousImages?.length > 0;

    if (incrEnabled) {
      log.debug(`🔍 [QUALITY RETRY] ${pageLabel}Running incremental consistency check...`);
      consistencyResult = await evaluateIncrementalConsistency(
        result.imageData,
        pageNumber || attempts,  // Use page number if available
        incrConfig.previousImages,
        incrConfig
      );

      // Track consistency check usage
      if (usageTracker && consistencyResult?.usage) {
        usageTracker(null, consistencyResult.usage, null, consistencyResult.usage.model);
      }

      // Merge quality and consistency issues
      unifiedReport = mergeEvaluationIssues(result, consistencyResult, incrConfig);

      // Log the unified report
      if (incrConfig.dryRun) {
        logDryRunReport(pageContext, unifiedReport);
      } else {
        const totalIssues = unifiedReport.allIssues.length;
        const fixableCount = unifiedReport.fixPlan.estimatedFixCount;
        if (totalIssues > 0) {
          log.info(`📋 [QUALITY RETRY] ${pageLabel}Unified report: ${totalIssues} issue(s) found, ${fixableCount} will be fixed`);
        }
      }

      // Record in retry history
      retryHistory.push({
        attempt: attempts,
        type: 'incremental_consistency',
        consistencyScore: consistencyResult?.score,
        consistencyIssues: consistencyResult?.issues?.length || 0,
        unifiedReport: {
          qualityScore: unifiedReport.qualityScore,
          consistencyScore: unifiedReport.consistencyScore,
          totalIssues: unifiedReport.allIssues.length,
          fixableIssues: unifiedReport.fixPlan.estimatedFixCount
        },
        dryRun: incrConfig.dryRun,
        timestamp: new Date().toISOString()
      });
    }

    // AUTO-REPAIR: Run if enabled AND there are issues to fix
    // Now uses unified fix plan if incremental consistency is enabled
    const AUTO_REPAIR_THRESHOLD = 90;

    // Determine if we should repair based on unified report or just quality
    let shouldRepair = false;
    let fixTargetsToUse = [];
    bboxDetectionHistory = null;  // Reset for this attempt
    bboxOverlayImage = null;
    enrichedFixTargets = null;

    // ALWAYS run bbox detection for every image (figure locations needed for other features)
    // This runs regardless of whether issues were found, incrEnabled, or autoRepair settings
    const fixableIssues = result.fixableIssues || [];
    const qualityMatches = result.matches || [];  // Character → figure mapping from quality eval
    const objectMatches = result.objectMatches || [];  // Object/animal/landmark mapping from quality eval

    // Use pre-extracted scene metadata if available, otherwise try to extract from prompt
    const sceneMetadata = sceneMetadataInput || getStoryHelpers().extractSceneMetadata(currentPrompt);
    const expectedCharacterPositions = sceneMetadata?.characterPositions || {};
    const expectedCharacterClothing = sceneMetadata?.characterClothing || {};
    const expectedObjects = sceneMetadata?.objects || [];

    // Build character descriptions for bbox detection
    // Use rich descriptions from full character objects when available, fall back to prompt parsing
    let characterDescriptions;
    if (sceneCharacters.length > 0) {
      characterDescriptions = {};
      for (const char of sceneCharacters) {
        characterDescriptions[char.name] = {
          richDescription: getStoryHelpers().buildCharacterPhysicalDescription(char),
          // Pass the full clothing map (including nested costumed.*) so bbox
          // detection can resolve per-page clothing — otherwise the detector
          // gets told "Lukas wearing striped hoodie" on cowboy-costumed pages
          // and tags every figure UNKNOWN because the clothes don't match.
          clothingDescriptions: char.avatars?.clothing || {}
        };
      }
    } else {
      // Fallback: parse minimal descriptions from prompt
      characterDescriptions = getStoryHelpers().parseCharacterDescriptions(currentPrompt);
    }

    // Enrich with Visual Bible entities (animals, secondary characters) that
    // appear in the scene but aren't in sceneCharacters (which only has main
    // input characters). Without this, e.g. a dragon "Floh" registered as ANI001
    // is sent to the bbox detector with no description → returned as UNKNOWN
    // → all evaluation issues mentioning Floh fail to match a character.
    if (visualBible) {
      const knownNames = new Set(Object.keys(characterDescriptions).map(n => n.toLowerCase()));
      const expectedNames = Object.keys(expectedCharacterPositions || {});
      for (const name of expectedNames) {
        if (knownNames.has(name.toLowerCase())) continue;
        // Search Visual Bible: secondary characters first, then animals.
        // (Vehicles/artifacts go through the objects list, not characters.)
        const vbLists = [
          { list: visualBible.secondaryCharacters, kind: 'secondary character' },
          { list: visualBible.animals, kind: 'creature' },
        ];
        let matched = null;
        for (const { list, kind } of vbLists) {
          if (!Array.isArray(list)) continue;
          const entry = list.find(e => (e?.name && e.name.toLowerCase() === name.toLowerCase()) || (e?.id && e.id.toLowerCase() === name.toLowerCase()));
          if (entry) { matched = { entry, kind }; break; }
        }
        if (!matched) continue;

        const e = matched.entry;
        // Compose a compact rich description from VB fields (varies by entity type).
        const parts = [];
        if (e.species) parts.push(`Species: ${e.species}`);
        if (e.size) parts.push(`Size: ${e.size}`);
        if (e.coloring) parts.push(`Coloring: ${e.coloring}`);
        if (e.features) parts.push(`Features: ${e.features}`);
        if (e.hair) parts.push(`Hair: ${e.hair}`);
        if (e.face) parts.push(`Face: ${e.face}`);
        if (e.signatureLook) parts.push(`Distinctive: ${e.signatureLook}`);
        if (e.clothing) parts.push(`Wearing: ${e.clothing}`);
        const baseDesc = e.description || parts.join('. ');
        const rich = baseDesc
          ? `${e.name} (${matched.kind}). ${baseDesc}`
          : `${e.name} (${matched.kind})`;

        // Key by the scene-metadata name (which may be a VB id placeholder like
        // "CHR001") so buildExpectedCharactersForBbox finds it via the same key
        // that appears in expectedCharacterPositions.
        characterDescriptions[name] = { richDescription: rich };
        log.debug(`📦 [BBOX-PREP] ${pageLabel}Enriched bbox description for VB ${matched.kind} "${e.name}" (key: "${name}")`);
      }
    }

    // Parse Visual Bible objects from prompt (REQUIRED OBJECTS section)
    const vbObjects = parseVisualBibleObjects(currentPrompt);
    // Merge VB objects with scene objects, then resolve any VB IDs
    // ("ART003", "LOC001.2") to their natural names so the detector has
    // something visual to look for.
    const mergedExpected = [...expectedObjects, ...vbObjects.filter(o => !expectedObjects.includes(o))];
    const allExpectedObjects = resolveExpectedObjectLabels(mergedExpected, visualBible);

    if (Object.keys(expectedCharacterPositions).length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Expected character positions: ${Object.entries(expectedCharacterPositions).map(([n, p]) => `${n}=${p}`).join(', ')}`);
    }
    if (Object.keys(characterDescriptions).length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Character descriptions: ${Object.entries(characterDescriptions).map(([n, d]) => `${n}=${d.genderTerm || 'unknown'}`).join(', ')}`);
    }
    if (allExpectedObjects.length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Expected objects: ${allExpectedObjects.join(', ')}`);
    }

    // Build scene context for bbox detection (helps distinguish similar characters)
    const bboxSceneContext = buildBboxSceneContext(sceneMetadata, sceneCharacters, expectedCharacterClothing);

    log.info(`📦 [QUALITY RETRY] ${pageLabel}Bbox detection: locating all figures/objects${fixableIssues.length > 0 ? `, matching ${fixableIssues.length} issues` : ''}${qualityMatches.length > 0 ? `, ${qualityMatches.length} character matches` : ''}${objectMatches.length > 0 ? `, ${objectMatches.length} object matches` : ''}${allExpectedObjects.length > 0 ? `, ${allExpectedObjects.length} expected objects` : ''}...`);
    const enrichResult = await enrichWithBoundingBoxes(result.imageData, fixableIssues, qualityMatches, objectMatches, expectedCharacterPositions, allExpectedObjects, characterDescriptions, expectedCharacterClothing, bboxSceneContext, null, pageContext);
    bboxDetectionHistory = enrichResult.detectionHistory;
    // Track bbox detection tokens (Gemini quality-category)
    if (bboxDetectionHistory?.usage && usageTracker) {
      usageTracker(null, bboxDetectionHistory.usage, null, 'gemini-2.5-flash');
    }
    enrichedFixTargets = enrichResult.targets;
    if (bboxDetectionHistory) {
      const figCount = bboxDetectionHistory.figures?.length || 0;
      const objCount = bboxDetectionHistory.objects?.length || 0;
      log.info(`✅ [QUALITY RETRY] ${pageLabel}Bbox detection complete: ${figCount} figures, ${objCount} objects${enrichedFixTargets.length > 0 ? `, ${enrichedFixTargets.length} fix targets` : ''}`);
      // Create overlay image with boxes drawn for dev mode display
      bboxOverlayImage = await createBboxOverlayImage(result.imageData, bboxDetectionHistory);
    } else {
      log.warn(`⚠️  [QUALITY RETRY] ${pageLabel}Bbox detection failed`);
    }

    if (incrEnabled && unifiedReport && !incrConfig.dryRun) {
      // Use unified fix plan
      shouldRepair = unifiedReport.fixPlan.requiresFix;
      fixTargetsToUse = unifiedReport.fixPlan.fixTargets.map(t => ({
        element: t.type,
        issue: t.instruction,
        severity: t.severity,
        bounds: t.region === 'full' ? null : t.region,
        fix_instruction: t.instruction
      }));
    } else if (!incrEnabled) {
      // Fall back to quality-only repair (original behavior)
      if (enrichedFixTargets && enrichedFixTargets.length > 0) {
        // Use results from two-stage detection above
        shouldRepair = !hasTextError && score <= AUTO_REPAIR_THRESHOLD;
        fixTargetsToUse = enrichedFixTargets;
      } else if (result.fixTargets && result.fixTargets.length > 0) {
        // Legacy format: fixTargets already has bounding boxes
        shouldRepair = !hasTextError && score <= AUTO_REPAIR_THRESHOLD;
        fixTargetsToUse = result.fixTargets;
      }
    }

    // Force repair override: if forceRepairThreshold is set and there are fix targets,
    // force repair when score < forceRepairThreshold (set to 100 to always repair)
    if (forceRepairThreshold !== null && !hasTextError) {
      const hasFixTargets = (enrichedFixTargets && enrichedFixTargets.length > 0) ||
                           (result.fixTargets && result.fixTargets.length > 0) ||
                           (unifiedReport?.fixPlan?.fixTargets?.length > 0);
      if (hasFixTargets && score < forceRepairThreshold) {
        log.info(`🔧 [QUALITY RETRY] ${pageLabel}Force repair triggered (score ${score}% < forceRepairThreshold ${forceRepairThreshold}%)`);
        shouldRepair = true;
        // Use enriched targets if available, otherwise unified, otherwise raw
        if (enrichedFixTargets && enrichedFixTargets.length > 0) {
          fixTargetsToUse = enrichedFixTargets;
        } else if (unifiedReport?.fixPlan?.fixTargets?.length > 0) {
          fixTargetsToUse = unifiedReport.fixPlan.fixTargets.map(t => ({
            element: t.type,
            issue: t.instruction,
            severity: t.severity,
            bounds: t.region === 'full' ? null : t.region,
            fix_instruction: t.instruction
          }));
        } else if (result.fixTargets) {
          fixTargetsToUse = result.fixTargets;
        }
      }
    }

    const couldRepair = shouldRepair && fixTargetsToUse.length > 0;
    if (couldRepair && !enableAutoRepair) {
      log.debug(`⏭️ [QUALITY RETRY] ${pageLabel}Auto-repair skipped (disabled). ${fixTargetsToUse.length} fix targets available.`);
    }

    // Attach bbox analysis to the most recent generation entry (not as a separate entry — bbox is analysis, not a generation attempt)
    if (bboxDetectionHistory) {
      const lastGenEntry = [...retryHistory].reverse().find(h => h.type === 'generation' || h.type === 'incremental_consistency');
      if (lastGenEntry) {
        lastGenEntry.bboxDetection = bboxDetectionHistory;
        lastGenEntry.bboxOverlayImage = bboxOverlayImage;
        lastGenEntry.hasBboxOverlay = !!bboxOverlayImage;
      }
    }
    if (enableAutoRepair && couldRepair) {
      const repairSource = incrEnabled ? 'unified (quality + consistency)' : 'quality';
      log.info(`🔧 [QUALITY RETRY] ${pageLabel}Attempting auto-repair on ${fixTargetsToUse.length} fix targets (${repairSource})...`);
      try {
        let repairResult;

        // Choose repair method: grid-based (new) or direct inpainting (legacy)
        if (useGridRepair && gridRepairOutputDir) {
          // Grid-based repair: extract regions, create grid, repair with Gemini, verify
          log.info(`🔧 [QUALITY RETRY] ${pageLabel}Using grid-based repair method`);
          const { gridBasedRepair } = getGridBasedRepair();

          // Build evaluation results from current state
          const evalResults = {
            quality: {
              score: result.score,
              fixTargets: fixTargetsToUse,
              reasoning: result.reasoning,
              matches: result.matches || []  // Character → figure mapping with face_bbox
            },
            incremental: incrEnabled ? consistencyResult : null,
            final: null  // Final consistency handled separately
          };

          const gridResult = await gridBasedRepair(
            result.imageData,
            pageNumber || 1,
            evalResults,
            {
              outputDir: gridRepairOutputDir,
              storyId: storyId,
              skipVerification: false,
              saveIntermediates: isAdmin,
              bboxDetection: bboxDetectionHistory,  // Pass bbox detection for character lookup
              onProgress: (step, msg) => log.debug(`  [GRID] ${step}: ${msg}`)
            }
          );

          // Normalize grid repair result into the shared { imageData, repairHistory } shape
          repairResult = {
            imageData: gridResult.imageData,
            repaired: gridResult.repaired,
            repairHistory: gridResult.history?.steps || [],
            usage: null,  // Grid repair usage tracked in history
            modelId: 'grid-repair',
            // Store grid data for UI display
            grids: gridResult.grids,
            gridFixedCount: gridResult.fixedCount,
            gridFailedCount: gridResult.failedCount,
            gridTotalIssues: gridResult.totalIssues
          };

          if (gridResult.repaired) {
            log.info(`✅ [QUALITY RETRY] ${pageLabel}Grid repair: ${gridResult.fixedCount}/${gridResult.totalIssues} issues fixed`);
          }
        } else {
          // Grok text edit: send quality + semantic issues as text instruction (no bbox needed)
          const qualityIssues = result.fixableIssues || [];
          const semanticIssues = (result.semanticResult?.issues || result.semanticResult?.semanticIssues || [])
            .map(si => ({ description: si.problem || `${si.type}: ${si.item || ''}` }));
          const allRepairIssues = [...qualityIssues, ...semanticIssues]
            .map(i => i.description || i.issue || i.fix || '').filter(Boolean);
          if (allRepairIssues.length > 0) {
            const editInstruction = allRepairIssues.join('. ');
            log.info(`🔧 [QUALITY RETRY] ${pageLabel}Using Grok text edit with ${allRepairIssues.length} issues: ${editInstruction.substring(0, 200)}`);
            const editResult = await editImageWithPrompt(result.imageData, `Fix these issues in this children's book illustration: ${editInstruction}`);
            repairResult = editResult?.imageData ? {
              repaired: true, imageData: editResult.imageData,
              repairHistory: allRepairIssues.map(i => ({ issue: i, method: 'grok-text-edit', success: true })),
              usage: editResult.usage, modelId: 'grok-text-edit'
            } : { repaired: false };
          } else {
            repairResult = { repaired: false };
          }
        }

        // Validate repair result: must have repaired=true, valid imageData, and be different from original
        const hasValidRepairResult = repairResult.repaired &&
          repairResult.imageData &&
          typeof repairResult.imageData === 'string' &&
          repairResult.imageData.length > 1000 &&  // Minimum size for a valid JPEG
          repairResult.imageData !== result.imageData;

        if (hasValidRepairResult) {
          // Verify images are actually different by comparing hashes
          const originalHash = hashImageData(result.imageData);
          const repairedHash = hashImageData(repairResult.imageData);
          log.info(`✅ [QUALITY RETRY] ${pageLabel}Auto-repair completed, re-evaluating quality...`);
          log.debug(`🔍 [QUALITY RETRY] ${pageLabel}Image hash: original=${originalHash}, repaired=${repairedHash}, different=${originalHash !== repairedHash}`);

          // Track usage from repair (5th param = true indicates inpaint)
          if (usageTracker && repairResult.usage) {
            usageTracker(repairResult.usage, null, repairResult.modelId, null, true);
          }

          // Re-evaluate the repaired image (NOT the original!)
          const qualityModelOverride = modelOverrides?.qualityModel || null;
          const reEvalResult = await evaluateImageQuality(
            repairResult.imageData,  // IMPORTANT: Use repaired image, not result.imageData
            currentPrompt,
            characterPhotos,
            evaluationType,
            qualityModelOverride,
            pageContext,
            storyText,
            sceneHint,
            sceneCharacters  // Enables STEP 2C head-to-body proportion check
          );

          if (reEvalResult && reEvalResult.score !== null) {
            const repairedScore = reEvalResult.score;
            log.info(`🔧 [QUALITY RETRY] ${pageLabel}Post-repair score: ${repairedScore}% (was ${score}%)`);

            // Track quality eval usage
            if (usageTracker && reEvalResult.usage) {
              usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
            }

            // Record repair attempt in history with full evaluation data
            retryHistory.push({
              attempt: attempts,
              type: repairResult.modelId === 'grid-repair' ? 'grid_repair' : 'auto_repair',
              preRepairScore: score,
              postRepairScore: repairedScore,
              fixTargetsCount: fixTargetsToUse.length,
              imageData: repairResult.imageData,
              repairUsage: repairResult.usage,
              reEvalUsage: reEvalResult.usage,
              // Full evaluation data for dev mode
              preRepairEval: {
                score: result.score,
                reasoning: result.reasoning,
                fixTargets: result.fixTargets,
                fixableIssues: result.fixableIssues  // New format issues
              },
              postRepairEval: {
                score: reEvalResult.score,
                reasoning: reEvalResult.reasoning,
                fixTargets: reEvalResult.fixTargets,
                fixableIssues: reEvalResult.fixableIssues
              },
              // Two-stage bounding box detection results (new)
              bboxDetection: bboxDetectionHistory,
              bboxOverlayImage: bboxOverlayImage,  // Image with boxes drawn for dev mode
              // Repair details from inpaint / grid repair
              repairDetails: repairResult.repairHistory || [],
              // Grid repair data for UI display (only present for grid repairs)
              grids: repairResult.grids,
              gridFixedCount: repairResult.gridFixedCount,
              gridFailedCount: repairResult.gridFailedCount,
              gridTotalIssues: repairResult.gridTotalIssues,
              timestamp: new Date().toISOString()
            });

            // Update result with repaired image if:
            // 1. Score improved, OR
            // 2. Grid repair had verified fixes (verification is more reliable than score for specific fixes)
            const hasVerifiedGridFixes = repairResult.gridFixedCount > 0;
            const shouldUseRepair = repairedScore > score || hasVerifiedGridFixes;

            if (shouldUseRepair) {
              result = {
                ...result,
                imageData: repairResult.imageData,
                score: repairedScore,
                reasoning: reEvalResult.reasoning,
                wasRepaired: true,
                fixTargets: reEvalResult.fixTargets || [],  // Use new fix targets from re-eval
                repairHistory: repairResult.repairHistory || [],  // Include repair details
                // Include grid data for UI display
                grids: repairResult.grids
              };
              score = repairedScore;  // Update score for threshold check

              if (repairedScore > retryHistory[retryHistory.length - 1].preRepairScore) {
                log.info(`✅ [QUALITY RETRY] Using repaired image (score improved from ${retryHistory[retryHistory.length - 1].preRepairScore}% to ${score}%)`);
              } else if (hasVerifiedGridFixes) {
                log.info(`✅ [QUALITY RETRY] Using repaired image (${repairResult.gridFixedCount} verified fixes applied, score: ${score}%)`);
              }
            }

            // Update best result if this is now best
            if (score > bestScore) {
              bestScore = score;
              bestResult = result;
            }
          }
        } else {
          // Log why repair was skipped
          let failReason = 'unknown';
          if (!repairResult.repaired) {
            log.info(`ℹ️  [QUALITY RETRY] Auto-repair reported no repairs made`);
            failReason = 'no_repairs_made';
          } else if (!repairResult.imageData) {
            log.warn(`⚠️  [QUALITY RETRY] Auto-repair returned null/undefined imageData`);
            failReason = 'no_image_data';
          } else if (repairResult.imageData.length <= 1000) {
            log.warn(`⚠️  [QUALITY RETRY] Auto-repair returned invalid imageData (too small: ${repairResult.imageData.length} bytes)`);
            failReason = 'image_too_small';
          } else {
            log.info(`ℹ️  [QUALITY RETRY] Auto-repair did not change the image`);
            failReason = 'image_unchanged';
          }

          // Store failed grid repairs for debugging (grids data shows what was attempted)
          if (repairResult.grids && repairResult.grids.length > 0) {
            retryHistory.push({
              attempt: attempts,
              type: 'grid_repair_failed',
              failReason,
              preRepairScore: score,
              gridFixedCount: repairResult.gridFixedCount || 0,
              gridFailedCount: repairResult.gridFailedCount || 0,
              gridTotalIssues: repairResult.gridTotalIssues || 0,
              grids: repairResult.grids,
              bboxDetection: bboxDetectionHistory,
              bboxOverlayImage: bboxOverlayImage,
              timestamp: new Date().toISOString()
            });
          }
        }
      } catch (repairError) {
        log.warn(`⚠️  [QUALITY RETRY] Auto-repair failed: ${repairError.message}`);
        retryHistory.push({
          attempt: attempts,
          type: 'auto_repair_failed',
          error: repairError.message,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Check if quality is good enough (and no text errors for covers)
    if (score >= IMAGE_QUALITY_THRESHOLD && !hasTextError) {
      console.log(`✅ [QUALITY RETRY] Success on attempt ${attempts}! Score ${score}% >= ${IMAGE_QUALITY_THRESHOLD}%${wasSceneRewritten ? ' (scene was rewritten for safety)' : ''}${result.wasRepaired ? ' (after auto-repair)' : ''}`);

      // Extract rewrite usage from retryHistory if a scene was rewritten
      const rewriteEntry = retryHistory.find(h => h.type === 'safety_block_rewrite' && h.rewriteUsage);
      return {
        ...result,
        // Prefer enriched fix targets (with bounding boxes from bbox detection) over raw quality eval targets
        fixTargets: (enrichedFixTargets && enrichedFixTargets.length > 0) ? enrichedFixTargets : result.fixTargets,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts,
        rewriteUsage: rewriteEntry?.rewriteUsage || null,
        // Two-stage bbox detection results (for version-level storage)
        bboxDetection: bboxDetectionHistory || null,
        bboxOverlayImage: bboxOverlayImage || null
      };
    }

    // Log retry status
    if (attempts >= MAX_ATTEMPTS) {
      // No more attempts — just report the final score
      const reason = hasTextError ? `text error: ${result.textIssue}` : `score ${score}% < ${IMAGE_QUALITY_THRESHOLD}%`;
      if (MAX_ATTEMPTS === 1) {
        log.debug(`📊 [EVAL] ${pageLabel}${reason} (quality retry disabled, accepting result)`);
      } else {
        log.debug(`⚠️  [QUALITY RETRY] ${pageLabel}${reason}, no attempts remaining`);
      }
    } else if (hasTextError) {
      log.debug(`⚠️  [QUALITY RETRY] ${pageLabel}Retrying due to text error: ${result.textIssue}`);
    } else {
      log.debug(`⚠️  [QUALITY RETRY] ${pageLabel}Score ${score}% < ${IMAGE_QUALITY_THRESHOLD}%, retrying with new generation...`);
    }
  }

  // All attempts exhausted, return best result
  log.info(`📊 [EVAL] ${pageLabel}Max attempts (${MAX_ATTEMPTS}) reached. Using best result with score ${bestScore === -1 ? 'unknown' : bestScore + '%'}`);
  // Extract rewrite usage from retryHistory if a scene was rewritten
  const rewriteEntry = retryHistory.find(h => h.type === 'safety_block_rewrite' && h.rewriteUsage);
  return {
    ...bestResult,
    wasRegenerated: true,
    retryHistory: retryHistory,
    totalAttempts: attempts,
    rewriteUsage: rewriteEntry?.rewriteUsage || null,
    bboxDetection: bboxDetectionHistory || null,
    bboxOverlayImage: bboxOverlayImage || null
  };
}

/**
 * Clear the image cache
 */
function clearImageCache() {
  imageCache.clear();
  log.debug('[IMAGE CACHE] Cache cleared');
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
 * Get image cache size
 */
function getImageCacheSize() {
  return imageCache.size;
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

/**
 * Log cache efficiency summary
 */
function logCacheSummary() {
  const stats = getCacheStats();
  if (stats.image.total > 0) {
    log.info(`📊 [CACHE] Image cache: ${stats.image.hits} hits, ${stats.image.misses} misses (${stats.image.hitRate}% hit rate)`);
  }
  if (stats.ref.total > 0) {
    log.info(`📊 [CACHE] Ref cache: ${stats.ref.hits} hits, ${stats.ref.misses} misses (${stats.ref.hitRate}% hit rate)`);
  }
}

/**
 * Reset cache statistics (call at start of story generation)
 */
function resetCacheStats() {
  imageCache.resetStats();
  compressedRefCache.resetStats();
}

// ============================================
// AUTO-REPAIR (INPAINTING) FUNCTIONS
// ============================================

/**
 * Inspect an image for physics/visual errors using Gemini Flash
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{errorFound: boolean, errorType?: string, description?: string, boundingBox?: number[], fixPrompt?: string}>}
 */
async function inspectImageForErrors(imageData) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    log.debug('🔍 [INSPECT] Analyzing image for physics errors...');

    // Extract base64 and mime type
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Load the inspection prompt
    const inspectionPrompt = PROMPT_TEMPLATES.imageInspection ||
      'Analyze this image for physics errors. Return JSON with error_found (boolean), error_type, description, bounding_box [ymin,xmin,ymax,xmax], and fix_prompt.';

    // Build parts array
    const parts = [
      { text: inspectionPrompt },
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Use utility model for fast analysis
    const modelId = MODEL_DEFAULTS.utility;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [INSPECT] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract and log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    log.debug(`📊 [INSPECT] Token usage - input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}`);

    // Extract text response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const textPart = data.candidates[0].content.parts.find(p => p.text);
      if (textPart) {
        const responseText = textPart.text.trim();
        log.debug('🔍 [INSPECT] Raw response:', responseText.substring(0, 300));

        // Parse JSON from response (handle markdown code blocks)
        let jsonStr = responseText;
        const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1].trim();
        }

        try {
          const result = JSON.parse(jsonStr);

          if (result.error_found) {
            log.info(`🔍 [INSPECT] Error detected: ${result.error_type} - ${result.description}`);
            return {
              errorFound: true,
              errorType: result.error_type,
              description: result.description,
              boundingBox: result.bounding_box,
              fixPrompt: result.fix_prompt,
              usage: { inputTokens, outputTokens, model: modelId }
            };
          } else {
            log.info('🔍 [INSPECT] No errors detected');
            return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
          }
        } catch (parseError) {
          log.warn('⚠️ [INSPECT] Failed to parse JSON response:', parseError.message);
          return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
        }
      }
    }

    log.warn('⚠️ [INSPECT] No valid response from inspection');
    return { errorFound: false, usage: { inputTokens, outputTokens, model: modelId } };
  } catch (error) {
    log.error('❌ [INSPECT] Error inspecting image:', error);
    throw error;
  }
}

// Simple cache for image dimensions to avoid repeated Sharp metadata calls
const dimensionCache = new Map();
const DIMENSION_CACHE_MAX_SIZE = 100;

/**
 * Get image dimensions from base64 data (with caching)
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{width: number, height: number}>}
 */
async function getImageDimensions(imageData) {
  // Use first 100 chars of base64 as cache key (unique enough, cheap to compute)
  const cacheKey = imageData.substring(0, 100);
  if (dimensionCache.has(cacheKey)) {
    return dimensionCache.get(cacheKey);
  }

  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const metadata = await sharp(buffer).metadata();
  const dimensions = { width: metadata.width, height: metadata.height };

  // Limit cache size to prevent memory issues
  if (dimensionCache.size >= DIMENSION_CACHE_MAX_SIZE) {
    const firstKey = dimensionCache.keys().next().value;
    dimensionCache.delete(firstKey);
  }
  dimensionCache.set(cacheKey, dimensions);

  return dimensions;
}

/**
 * Create a black/white mask from bounding box coordinates
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number[]} boundingBox - [ymin, xmin, ymax, xmax] normalized 0-1000
 * @returns {Promise<string>} Base64 mask image (black background, white rectangle)
 */
async function createMaskFromBoundingBox(width, height, boundingBox) {
  const [ymin, xmin, ymax, xmax] = boundingBox;

  // Convert normalized coordinates (0-1000) to pixel coordinates
  const left = Math.floor((xmin / 1000) * width);
  const top = Math.floor((ymin / 1000) * height);
  const rectWidth = Math.floor(((xmax - xmin) / 1000) * width);
  const rectHeight = Math.floor(((ymax - ymin) / 1000) * height);

  log.debug(`🎭 [MASK] Creating mask: ${width}x${height}, box: [${left},${top},${rectWidth},${rectHeight}]`);

  // Create black background
  const blackBackground = await sharp({
    create: {
      width: width,
      height: height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  }).png().toBuffer();

  // Create white rectangle
  const whiteRect = await sharp({
    create: {
      width: rectWidth,
      height: rectHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).png().toBuffer();

  // Composite white rectangle onto black background
  const maskBuffer = await sharp(blackBackground)
    .composite([{
      input: whiteRect,
      left: left,
      top: top
    }])
    .png()
    .toBuffer();

  const maskBase64 = `data:image/png;base64,${maskBuffer.toString('base64')}`;
  log.debug('🎭 [MASK] Mask created successfully');

  return maskBase64;
}

/**
 * Calculate the percentage of image area covered by bounding boxes
 * Uses union of boxes to avoid counting overlapping areas twice
 * @param {Array<number[]>} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0.0-1.0 or 0-1000
 * @returns {number} Percentage of image covered (0-100)
 */
function calculateMaskCoverage(boundingBoxes) {
  if (!boundingBoxes || boundingBoxes.length === 0) {
    return 0;
  }

  // Normalize all boxes to 0.0-1.0 format
  const normalizedBoxes = boundingBoxes.map(box => {
    const [ymin, xmin, ymax, xmax] = box;
    const scale = (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) ? 1 : 1000;
    return [ymin / scale, xmin / scale, ymax / scale, xmax / scale];
  });

  // Simple approach: sum areas (may overcount overlaps, but gives upper bound)
  // For more accuracy, we'd need a sweep line algorithm, but this is good enough
  let totalArea = 0;
  for (const [ymin, xmin, ymax, xmax] of normalizedBoxes) {
    const width = Math.max(0, xmax - xmin);
    const height = Math.max(0, ymax - ymin);
    totalArea += width * height;
  }

  // Cap at 100% (overlaps could theoretically exceed 100%)
  return Math.min(100, totalArea * 100);
}

/**
 * Classify issue type from issue description text
 * Used to determine appropriate padding and model selection
 * @param {string} issue - Issue description text
 * @returns {string} Issue type: 'face', 'hand', 'anatomy', 'object', or 'default'
 */
function classifyIssueType(issue) {
  if (!issue || typeof issue !== 'string') return 'default';
  const lower = issue.toLowerCase();

  // Face/identity issues - need high-quality model + face reference
  if (lower.match(/\b(face|facial|eye|eyes|nose|mouth|expression|identity|portrait)\b/)) {
    return 'face';
  }

  // Hand issues - common AI artifact
  if (lower.match(/\b(hand|hands|finger|fingers|thumb|palm|grip|holding)\b/)) {
    return 'hand';
  }

  // Other anatomy issues
  if (lower.match(/\b(arm|arms|leg|legs|foot|feet|limb|limbs|body|torso|anatomy|anatomical)\b/)) {
    return 'anatomy';
  }

  // Object issues - props, items, weapons, etc.
  if (lower.match(/\b(object|sword|shield|weapon|item|prop|tool|hat|clothing|accessory|artifact|broken|fragmented|duplicate)\b/)) {
    return 'object';
  }

  return 'default';
}

/**
 * Apply adaptive padding to bounding box based on issue type
 * Research shows: high padding preserves context, low padding = more creativity
 * @param {number[]} bbox - [ymin, xmin, ymax, xmax] normalized 0.0-1.0
 * @param {string} issueType - Type of issue (face, hand, anatomy, object, default)
 * @returns {number[]} Padded bounding box
 */
function padBoundingBox(bbox, issueType) {
  // Padding values based on research:
  // - Face: 10% (preserve identity, don't alter too much context)
  // - Hand: 15% (need some context for fingers)
  // - Anatomy: 15% (body parts need context)
  // - Object: 25% (more context needed for object coherence)
  // - Default: 20% (balanced approach)
  const padding = {
    'face': 0.10,
    'hand': 0.15,
    'anatomy': 0.15,
    'object': 0.25,
    'default': 0.20
  };

  const pad = padding[issueType] || padding.default;
  let [ymin, xmin, ymax, xmax] = bbox;

  // Normalize to 0-1 format if in 0-1000 format (consistent with createCombinedMask)
  if (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1) {
    ymin /= 1000;
    xmin /= 1000;
    ymax /= 1000;
    xmax /= 1000;
  }

  return [
    Math.max(0, ymin - pad),  // ymin
    Math.max(0, xmin - pad),  // xmin
    Math.min(1, ymax + pad),  // ymax
    Math.min(1, xmax + pad)   // xmax
  ];
}

/**
 * Verify inpaint results using LPIPS perceptual similarity
 * Compares before/after images in the specific repaired region
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {Array} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized
 * @returns {Object} { lpipsScore, interpretation, changed } or null if unavailable
 */
async function verifyInpaintWithLPIPS(beforeImage, afterImage, bbox = null) {
  try {
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    const requestBody = {
      image1: beforeImage,
      image2: afterImage,
      resize_to: 256
    };

    // Crop to specific region if bbox provided
    if (bbox && Array.isArray(bbox) && bbox.length === 4) {
      requestBody.bbox = bbox;
    }

    const response = await fetch(`${photoAnalyzerUrl}/lpips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      return null;
    }

    const result = await response.json();

    if (result.success) {
      // LPIPS interpretation for inpaint verification:
      // - Score near 0: Images nearly identical (inpaint may not have changed anything)
      // - Score 0.05-0.20: Expected range for successful repair (visible change, similar style)
      // - Score > 0.30: Significant change (could be good or bad depending on issue)
      return {
        lpipsScore: result.lpips_score,
        interpretation: result.interpretation,
        region: result.region,
        changed: result.lpips_score > 0.02  // True if meaningful change detected
      };
    }
    return null;
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      log.debug('[LPIPS VERIFY] Service not available');
    } else {
      log.debug(`[LPIPS VERIFY] Error: ${err.message}`);
    }
    return null;
  }
}

/**
 * Verify inpaint results using targeted LLM analysis
 * Uses a focused prompt to check if the specific issue was fixed
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {string} issueDescription - What the original issue was
 * @param {string} fixDescription - What the fix was supposed to do
 * @param {Array} bbox - Bounding box [ymin, xmin, ymax, xmax] normalized
 * @returns {Object} { fixed, confidence, explanation } or null
 */
async function verifyInpaintWithLLM(beforeImage, afterImage, issueDescription, fixDescription, bbox = null) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return null;
    }

    const beforeBase64 = beforeImage.replace(/^data:image\/\w+;base64,/, '');
    const beforeMime = beforeImage.match(/^data:(image\/\w+);base64,/) ?
      beforeImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const afterBase64 = afterImage.replace(/^data:image\/\w+;base64,/, '');
    const afterMime = afterImage.match(/^data:(image\/\w+);base64,/) ?
      afterImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Region hint for LLM
    const regionHint = bbox
      ? `Focus on the region at approximately: top ${Math.round(bbox[0] * 100)}%, left ${Math.round(bbox[1] * 100)}%, bottom ${Math.round(bbox[2] * 100)}%, right ${Math.round(bbox[3] * 100)}% of the image.`
      : '';

    const prompt = `You are verifying an image repair operation. Compare the BEFORE and AFTER images.

ORIGINAL ISSUE: ${issueDescription}
INTENDED FIX: ${fixDescription}
${regionHint}

Analyze whether the repair was successful. Consider:
1. Was the original issue actually fixed?
2. Did the fix introduce any new artifacts or problems?
3. Does the repaired area blend naturally with surrounding content?

Output JSON only:
{
  "fixed": true/false,
  "confidence": 0.0-1.0,
  "explanation": "Brief explanation of the repair result"
}`;

    const requestBody = {
      contents: [{
        parts: [
          { text: "BEFORE image:" },
          { inline_data: { mime_type: beforeMime, data: beforeBase64 } },
          { text: "AFTER image:" },
          { inline_data: { mime_type: afterMime, data: afterBase64 } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500,
        responseMimeType: 'application/json'
      }
    };

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000)
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    const modelId = 'gemini-2.0-flash';
    log.debug(`📊 [INPAINT VERIFY] Token usage - input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}`);

    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const usage = { inputTokens, outputTokens, model: modelId };

    try {
      const result = getStoryHelpers().extractJsonFromText(responseText);
      if (!result) {
        log.warn('⚠️ [INPAINT VERIFY] Could not extract JSON from response');
        return { usage };
      }
      return {
        fixed: result.fixed === true,
        confidence: parseFloat(result.confidence) || 0.5,
        explanation: result.explanation || 'No explanation provided',
        usage
      };
    } catch (parseErr) {
      log.debug(`[INPAINT VERIFY] Failed to parse response: ${parseErr.message}`);
      return { usage }; // Return usage even on parse failure
    }
  } catch (err) {
    log.debug(`[INPAINT VERIFY] Error: ${err.message}`);
    return null;
  }
}

/**
 * Comprehensive inpaint verification combining LPIPS and LLM
 * Returns verification results for dev mode display
 * @param {string} beforeImage - Image before inpainting
 * @param {string} afterImage - Image after inpainting
 * @param {Array} targets - Array of {boundingBox, issue, fixPrompt}
 * @returns {Object} { lpips, llm, success }
 */
async function verifyInpaintResult(beforeImage, afterImage, targets) {
  if (!targets || targets.length === 0) {
    return { lpips: null, llm: null, success: true };
  }

  // Get combined bounding box from all targets
  const allBboxes = targets.map(t => t.boundingBox).filter(Boolean);
  const combinedBbox = allBboxes.length > 0 ? [
    Math.min(...allBboxes.map(b => b[0])),  // ymin
    Math.min(...allBboxes.map(b => b[1])),  // xmin
    Math.max(...allBboxes.map(b => b[2])),  // ymax
    Math.max(...allBboxes.map(b => b[3]))   // xmax
  ] : null;

  // Combine issue/fix descriptions
  const issueDescription = targets.map(t => t.issue).join('; ');
  const fixDescription = targets.map(t => t.fixPrompt).join('; ');

  // Run LPIPS and LLM verification in parallel
  const [lpipsResult, llmResult] = await Promise.all([
    verifyInpaintWithLPIPS(beforeImage, afterImage, combinedBbox),
    verifyInpaintWithLLM(beforeImage, afterImage, issueDescription, fixDescription, combinedBbox)
  ]);

  // Determine overall success
  // - LPIPS: Image should have changed (score > 0.02)
  // - LLM: Should confirm fix was applied (fixed === true)
  const lpipsSuccess = lpipsResult ? lpipsResult.changed : null;
  const llmSuccess = llmResult ? llmResult.fixed : null;

  // If both available, require both to pass; otherwise use whichever is available
  let success = true;
  if (lpipsSuccess !== null && llmSuccess !== null) {
    success = lpipsSuccess && llmSuccess;
  } else if (llmSuccess !== null) {
    success = llmSuccess;
  } else if (lpipsSuccess !== null) {
    success = lpipsSuccess;
  }

  return {
    lpips: lpipsResult,
    llm: llmResult,
    success,
    combinedBbox
  };
}

/**
 * Group fix targets by issue type for smart inpainting
 * Research: Combining unrelated regions in one mask causes artifacts
 * Face issues need high-quality model + reference, objects can use cheaper model
 *
 * Two-stage detection provides separate face_box and body_box:
 * - Face issues use faceBox (precise face region for identity preservation)
 * - Anatomy issues use bodyBox (full body context for hands/limbs)
 * - Object issues use bodyBox (more context for coherent object repair)
 *
 * @param {Array} fixTargets - Array of {boundingBox, faceBox?, bodyBox?, issue, fixPrompt}
 * @returns {Object} Grouped targets: { faceTargets, anatomyTargets, objectTargets }
 */
function groupFixTargetsForInpainting(fixTargets) {
  const faceTargets = [];
  const anatomyTargets = [];
  const objectTargets = [];

  for (const target of fixTargets) {
    const issueType = classifyIssueType(target.issue);

    // Select the appropriate bounding box based on issue type
    // Two-stage detection provides faceBox and bodyBox separately
    let selectedBbox;
    if (issueType === 'face' && target.faceBox) {
      // Use precise face box for identity-related issues
      selectedBbox = target.faceBox;
      log.debug(`🔧 [GROUPING] Using faceBox for face issue: "${target.issue.substring(0, 40)}..."`);
    } else if (target.bodyBox) {
      // Use body box for anatomy/object issues (more context)
      selectedBbox = target.bodyBox;
      log.debug(`🔧 [GROUPING] Using bodyBox for ${issueType} issue: "${target.issue.substring(0, 40)}..."`);
    } else {
      // Fall back to generic boundingBox (legacy format or detection failed)
      selectedBbox = target.boundingBox;
      if (selectedBbox) {
        log.debug(`🔧 [GROUPING] Using fallback boundingBox for ${issueType} issue`);
      }
    }

    if (!selectedBbox) {
      log.warn(`⚠️  [GROUPING] No bounding box available for issue: "${target.issue.substring(0, 40)}..."`);
      continue;
    }

    // Apply adaptive padding to the selected bounding box
    const paddedBbox = padBoundingBox(selectedBbox, issueType);
    const paddedTarget = {
      ...target,
      boundingBox: paddedBbox,
      originalBox: selectedBbox,  // Keep original for debugging
      issueType
    };

    switch (issueType) {
      case 'face':
        faceTargets.push(paddedTarget);
        break;
      case 'hand':
      case 'anatomy':
        anatomyTargets.push(paddedTarget);
        break;
      case 'object':
      default:
        objectTargets.push(paddedTarget);
        break;
    }
  }

  log.debug(`🔧 [GROUPING] Grouped ${fixTargets.length} targets: ${faceTargets.length} face, ${anatomyTargets.length} anatomy, ${objectTargets.length} object`);

  return { faceTargets, anatomyTargets, objectTargets };
}

/**
 * Create a combined mask from multiple bounding boxes
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {Array<number[]>} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0.0-1.0
 * @returns {Promise<string>} Base64 mask image (black background, white rectangles for all boxes)
 */
async function createCombinedMask(width, height, boundingBoxes) {
  if (!boundingBoxes || boundingBoxes.length === 0) {
    throw new Error('No bounding boxes provided');
  }

  log.debug(`🎭 [MASK] Creating combined mask with ${boundingBoxes.length} regions`);

  try {
    // Create black background
    const blackBackground = await sharp({
      create: {
        width: width,
        height: height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 }
      }
    }).png().toBuffer();

    // Create white rectangles for each bounding box
    const compositeInputs = [];
    for (let i = 0; i < boundingBoxes.length; i++) {
      const [ymin, xmin, ymax, xmax] = boundingBoxes[i];

      // Handle both 0.0-1.0 format (from FIX_TARGETS) and 0-1000 format (legacy)
      const scale = (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) ? 1 : 1000;

      const left = Math.floor((xmin / scale) * width);
      const top = Math.floor((ymin / scale) * height);
      const rectWidth = Math.max(1, Math.floor(((xmax - xmin) / scale) * width));
      const rectHeight = Math.max(1, Math.floor(((ymax - ymin) / scale) * height));

      log.debug(`🎭 [MASK] Box ${i + 1}: [${left},${top},${rectWidth},${rectHeight}]`);

      // Create white rectangle for this box
      const whiteRect = await sharp({
        create: {
          width: rectWidth,
          height: rectHeight,
          channels: 3,
          background: { r: 255, g: 255, b: 255 }
        }
      }).png().toBuffer();

      compositeInputs.push({
        input: whiteRect,
        left: left,
        top: top
      });
    }

    // Composite all white rectangles onto black background
    const maskBuffer = await sharp(blackBackground)
      .composite(compositeInputs)
      .png()
      .toBuffer();

    const maskBase64 = `data:image/png;base64,${maskBuffer.toString('base64')}`;
    log.info(`🎭 [MASK] Combined mask created with ${boundingBoxes.length} regions`);

    return maskBase64;
  } catch (error) {
    log.error(`[MASK] Failed to create combined mask: ${error.message}`);
    throw new Error(`Mask generation failed for ${boundingBoxes.length} regions: ${error.message}`);
  }
}

/**
 * Black out issue regions in an image to force regeneration of broken areas.
 * Takes fix targets from quality evaluation and composites black rectangles
 * over the affected areas, choosing the most appropriate box per issue type.
 * @param {string} imageBase64 - Base64 image data (with or without data: prefix)
 * @param {Array} fixTargets - Enriched fix targets with boundingBox, faceBox, bodyBox, type
 * @param {number} padding - Padding around each region as fraction (0.05 = 5%)
 * @returns {Promise<string>} Modified image as base64 (with data: prefix)
 */
async function blackoutIssueRegions(imageBase64, fixTargets, padding = 0.05) {
  if (!fixTargets || fixTargets.length === 0) {
    log.warn('⬛ [BLACKOUT] No fix targets provided, returning original image');
    return imageBase64;
  }

  try {
    // Decode image
    const rawBase64 = imageBase64.replace(/^data:image\/[^;]+;base64,/, '');
    const imageBuffer = Buffer.from(rawBase64, 'base64');
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    log.info(`⬛ [BLACKOUT] Blacking out ${fixTargets.length} issue regions in ${width}x${height} image`);

    // Build black rectangles for each fix target
    const compositeInputs = [];
    for (let i = 0; i < fixTargets.length; i++) {
      const target = fixTargets[i];

      // Choose the most appropriate box based on issue type
      let box;
      if (target.type === 'face' && target.faceBox) {
        box = target.faceBox;
      } else if ((target.type === 'clothing' || target.type === 'limb' || target.type === 'hand') && target.bodyBox) {
        box = target.bodyBox;
      } else {
        box = target.boundingBox || target.bodyBox || target.faceBox;
      }

      if (!box || box.length < 4) {
        log.debug(`⬛ [BLACKOUT] Target ${i + 1} has no usable box, skipping: ${target.issue?.substring(0, 50)}`);
        continue;
      }

      let [ymin, xmin, ymax, xmax] = box;

      // Handle both 0.0-1.0 format and 0-1000 format
      const scale = (ymin <= 1 && xmin <= 1 && ymax <= 1 && xmax <= 1) ? 1 : 1000;
      ymin /= scale;
      xmin /= scale;
      ymax /= scale;
      xmax /= scale;

      // Add padding (clamped to 0-1)
      const padX = (xmax - xmin) * padding;
      const padY = (ymax - ymin) * padding;
      ymin = Math.max(0, ymin - padY);
      xmin = Math.max(0, xmin - padX);
      ymax = Math.min(1, ymax + padY);
      xmax = Math.min(1, xmax + padX);

      // Convert to pixel coordinates
      const left = Math.floor(xmin * width);
      const top = Math.floor(ymin * height);
      const rectWidth = Math.max(1, Math.floor((xmax - xmin) * width));
      const rectHeight = Math.max(1, Math.floor((ymax - ymin) * height));

      log.debug(`⬛ [BLACKOUT] Target ${i + 1} (${target.type || 'unknown'}): [${left},${top},${rectWidth}x${rectHeight}] — ${target.issue?.substring(0, 60) || 'no description'}`);

      // Semi-transparent magenta overlay — preserves composition context
      // while clearly marking the area as needing regeneration
      const overlay = await sharp({
        create: {
          width: rectWidth,
          height: rectHeight,
          channels: 4,
          background: { r: 200, g: 0, b: 100, alpha: 0.6 }
        }
      }).png().toBuffer();

      compositeInputs.push({ input: overlay, left, top });
    }

    if (compositeInputs.length === 0) {
      log.warn('⬛ [BLACKOUT] No valid bounding boxes found in fix targets, returning original image');
      return imageBase64;
    }

    // Composite black rectangles onto the original image
    const resultBuffer = await sharp(imageBuffer)
      .composite(compositeInputs)
      .jpeg({ quality: 90 })
      .toBuffer();

    const resultBase64 = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;
    log.info(`⬛ [BLACKOUT] Blacked out ${compositeInputs.length}/${fixTargets.length} regions (${Math.round(resultBuffer.length / 1024)}KB)`);

    return resultBase64;
  } catch (error) {
    log.error(`⬛ [BLACKOUT] Failed to blackout issue regions: ${error.message}`);
    // Return original image on failure rather than crashing
    return imageBase64;
  }
}

/**
 * Inpaint using Runware API backend
 * Uses actual mask images (white=replace, black=preserve) instead of text coordinates.
 * Much cheaper than Gemini: ~$0.002/image (SDXL) vs ~$0.03/image
 *
 * @param {string} originalImage - Base64 original image
 * @param {Array} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1 coordinates
 * @param {string} fixPrompt - Instruction for what to fix
 * @param {string} existingMask - Optional pre-generated mask image
 * @param {Object} options - Runware options
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}|null>}
 */
async function inpaintWithRunwareBackend(originalImage, boundingBoxes, fixPrompt, existingMask = null, options = {}) {
  try {
    const { inpaintWithRunware, downloadRunwareImage, isRunwareConfigured } = require('./runware');

    if (!isRunwareConfigured()) {
      throw new Error('Runware API key not configured. Set RUNWARE_API_KEY in environment or use INPAINT_BACKEND=gemini');
    }

    // Get image dimensions for mask generation
    const dimensions = await getImageDimensions(originalImage);
    const { width, height } = dimensions;

    // Generate mask if not provided
    let mask = existingMask;
    if (!mask) {
      log.debug(`🎭 [INPAINT-RUNWARE] Generating mask for ${boundingBoxes.length} region(s)`);
      mask = await createCombinedMask(width, height, boundingBoxes);
    }

    log.info(`🎨 [INPAINT-RUNWARE] Starting inpaint with model ${options.model || 'runware:101@1'}`);

    // Call Runware API
    const result = await inpaintWithRunware(originalImage, mask, fixPrompt, {
      model: options.model || 'runware:101@1',
      strength: 0.85,
      steps: 20,
      width: width,
      height: height
    });

    // If Runware returns a URL, download and convert to base64
    let imageData = result.imageData;
    if (imageData && !imageData.startsWith('data:')) {
      log.debug(`📥 [INPAINT-RUNWARE] Downloading result from URL...`);
      imageData = await downloadRunwareImage(imageData);
    }

    // Compress to JPEG for consistency with Gemini output
    log.debug('🗜️ [INPAINT-RUNWARE] Compressing to JPEG...');
    const compressedImageData = await compressImageToJPEG(imageData);

    log.info(`✅ [INPAINT-RUNWARE] Complete. Cost: $${result.usage?.cost?.toFixed(6) || '0.002000'}`);

    // Construct descriptive fullPrompt for display (includes bounding box info)
    const coordText = boundingBoxes.map((bbox, i) => {
      const [ymin, xmin, ymax, xmax] = bbox;
      return `Region ${i + 1}: [y: ${(ymin * 100).toFixed(0)}%-${(ymax * 100).toFixed(0)}%, x: ${(xmin * 100).toFixed(0)}%-${(xmax * 100).toFixed(0)}%]`;
    }).join('\n');
    const descriptivePrompt = `TARGET REGION(S) (mask-based):\n${coordText}\n\nREQUESTED CHANGE:\n${fixPrompt}`;

    return {
      imageData: compressedImageData,
      usage: result.usage,
      modelId: result.modelId,
      fullPrompt: descriptivePrompt
    };

  } catch (error) {
    log.error(`❌ [INPAINT-RUNWARE] Error: ${error.message}`);
    throw error;
  }
}

/**
 * Inpaint regions using Grok edit API with blackout+blend technique.
 *
 * Approach (mirrors repairCharacterMismatchWithGrok blended mode):
 * 1. White out all bounding box regions on the original image
 * 2. Send whiteout image + fix prompt to editWithGrok()
 * 3. Resize Grok result to match original dimensions
 * 4. Feathered-blend each bbox region from Grok result back onto the original (30px feather)
 *
 * @param {string} originalImage - Base64 data URI of the original image
 * @param {Array<number[]>} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1
 * @param {string} fixPrompt - Instruction for what to fix in the regions
 * @param {Object} options - Additional options
 * @returns {Promise<{imageData: string, modelId: string, usage?: Object, fullPrompt: string}>}
 */
async function inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options = {}) {
  // 1. Create whiteout overlay on all bounding box regions
  const origBase64 = originalImage.replace(/^data:image\/\w+;base64,/, '');
  const origBuffer = Buffer.from(origBase64, 'base64');
  const metadata = await sharp(origBuffer).metadata();
  const { width, height } = metadata;

  // Build composite operations for all bounding boxes
  const composites = [];
  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    const bx = Math.round(xmin * width);
    const by = Math.round(ymin * height);
    const bw = Math.max(1, Math.round((xmax - xmin) * width));
    const bh = Math.max(1, Math.round((ymax - ymin) * height));
    // White rectangle with 80% opacity (same as character repair outer ring)
    const whiteRect = await sharp({
      create: { width: bw, height: bh, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 204 } }
    }).png().toBuffer();
    composites.push({ input: whiteRect, left: bx, top: by });
  }

  const whiteoutBuffer = await sharp(origBuffer)
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
  const whiteoutDataUri = `data:image/jpeg;base64,${whiteoutBuffer.toString('base64')}`;

  // 2. Build prompt for Grok
  const regionDescriptions = boundingBoxes.map((bbox, idx) => {
    const [ymin, xmin, ymax, xmax] = bbox;
    return `Region ${idx + 1}: top ${Math.round(ymin * 100)}%-${Math.round(ymax * 100)}%, left ${Math.round(xmin * 100)}%-${Math.round(xmax * 100)}%`;
  }).join('\n');

  const grokPrompt = `Fix the whited-out region(s) in this illustration. Regenerate ONLY the blanked areas to match the surrounding art style perfectly.

TARGET REGIONS:
${regionDescriptions}

WHAT TO FIX:
${fixPrompt}

IMPORTANT:
- Preserve everything outside the white regions exactly as shown
- Match the art style, lighting, and color palette of the surrounding image
- Make the repaired areas blend seamlessly with the rest`;

  // 3. Send to Grok — detect aspect ratio from original image dimensions
  const aspectRatio = width > height ? '16:9' : height > width ? '9:16' : '1:1';
  log.info(`🔧 [INPAINT-GROK] Sending ${boundingBoxes.length} region(s) to Grok for repair (aspect: ${aspectRatio})`);

  const grokResult = await editWithGrok(grokPrompt, [whiteoutDataUri], {
    model: GROK_MODELS.STANDARD,
    aspectRatio
  });

  if (!grokResult?.imageData) {
    throw new Error('Grok returned no image for inpaint repair');
  }

  // 4. Feathered blend each region back onto original (same technique as character repair)
  const FEATHER_PX = 30;
  const grokBase64 = grokResult.imageData.replace(/^data:image\/\w+;base64,/, '');
  let grokBuffer = Buffer.from(grokBase64, 'base64');

  // Resize Grok result to match original dimensions if needed
  const grokMeta = await sharp(grokBuffer).metadata();
  if (grokMeta.width !== width || grokMeta.height !== height) {
    log.warn(`⚠️ [INPAINT-GROK] Grok returned ${grokMeta.width}x${grokMeta.height}, expected ${width}x${height} — resizing`);
    grokBuffer = await sharp(grokBuffer).resize(width, height, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  }

  let resultBuffer = origBuffer;

  for (const bbox of boundingBoxes) {
    const [ymin, xmin, ymax, xmax] = bbox;
    // Add 10% padding for blend region
    const padX = (xmax - xmin) * 0.1;
    const padY = (ymax - ymin) * 0.1;
    const bx = Math.max(0, Math.round((xmin - padX) * width));
    const by = Math.max(0, Math.round((ymin - padY) * height));
    const bx2 = Math.min(width, Math.round((xmax + padX) * width));
    const by2 = Math.min(height, Math.round((ymax + padY) * height));
    const bw = bx2 - bx;
    const bh = by2 - by;

    if (bw <= 0 || bh <= 0) continue;

    // Extract regions from both images as raw RGB
    const origRegion = await sharp(resultBuffer)
      .extract({ left: bx, top: by, width: bw, height: bh })
      .raw().toBuffer();
    const grokRegion = await sharp(grokBuffer)
      .extract({ left: bx, top: by, width: bw, height: bh })
      .raw().toBuffer();

    // Create feathered blend: original at edges, Grok result in center
    const blended = Buffer.alloc(bw * bh * 3);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        // Distance from edge (0 at edge, 1 in center beyond feather)
        const dx = Math.min(x, bw - 1 - x) / FEATHER_PX;
        const dy = Math.min(y, bh - 1 - y) / FEATHER_PX;
        const alpha = Math.min(1, Math.min(dx, dy)); // 0=original, 1=grok
        const idx = (y * bw + x) * 3;
        for (let c = 0; c < 3; c++) {
          blended[idx + c] = Math.round(origRegion[idx + c] * (1 - alpha) + grokRegion[idx + c] * alpha);
        }
      }
    }

    // Composite blended region back onto result
    const blendedPng = await sharp(blended, { raw: { width: bw, height: bh, channels: 3 } }).png().toBuffer();
    resultBuffer = await sharp(resultBuffer)
      .composite([{ input: blendedPng, left: bx, top: by }])
      .jpeg({ quality: 92 }).toBuffer();
  }

  const finalDataUri = `data:image/jpeg;base64,${resultBuffer.toString('base64')}`;
  log.info(`✅ [INPAINT-GROK] Repair complete. ${boundingBoxes.length} region(s) blended. Cost: $${grokResult.usage?.cost || 0.02}`);

  return {
    imageData: finalDataUri,
    modelId: grokResult.modelId || 'grok-imagine',
    usage: grokResult.usage,
    fullPrompt: grokPrompt
  };
}

/**
 * Inpaint an image using TEXT-BASED region coordinates (semantic masking)
 * NOTE: Gemini 2.5 Flash Image uses natural language to identify regions.
 * We pass coordinates as text in the prompt instead of as a mask image,
 * which is more reliable when there are multiple similar elements (e.g., multiple hands).
 *
 * Supports multiple backends:
 * - 'gemini' (default): Uses text-based coordinates with Gemini API
 * - 'runware': Uses mask images with Runware API (much cheaper)
 * - 'grok': Uses blackout+blend with Grok edit API
 *
 * @param {string} originalImage - Base64 original image
 * @param {Array} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1 coordinates
 * @param {string} fixPrompt - Instruction for what to fix
 * @param {string} maskImage - Optional mask image (required for Runware, optional for Gemini)
 * @param {Object} options - Additional options
 * @param {string} options.backend - 'gemini', 'runware', or 'grok' (default: MODEL_DEFAULTS.inpaintBackend)
 * @param {string} options.runwareModel - Runware model to use (default: 'runware:101@1' SDXL)
 * @returns {Promise<{imageData: string, usage?: Object, modelId?: string}|null>}
 */
async function inpaintWithMask(originalImage, boundingBoxes, fixPrompt, maskImage = null, options = {}) {
  const {
    backend = MODEL_DEFAULTS.inpaintBackend || 'runware',
    runwareModel = 'runware:101@1'
  } = options;

  log.debug(`🔧 [INPAINT] Using backend: ${backend}`);

  // Route to Runware if configured
  if (backend === 'runware') {
    return inpaintWithRunwareBackend(originalImage, boundingBoxes, fixPrompt, maskImage, { model: runwareModel });
  }

  // Route to Grok if configured
  if (backend === 'grok') {
    return inpaintWithGrokBackend(originalImage, boundingBoxes, fixPrompt, options);
  }

  // Default: Gemini backend
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    // Build coordinate descriptions for each region
    const regionDescriptions = boundingBoxes.map((bbox, idx) => {
      const [ymin, xmin, ymax, xmax] = bbox;
      // Convert to percentages for clearer instruction
      const top = Math.round(ymin * 100);
      const left = Math.round(xmin * 100);
      const bottom = Math.round(ymax * 100);
      const right = Math.round(xmax * 100);
      return `Region ${idx + 1}: from top ${top}% to ${bottom}%, left ${left}% to ${right}%`;
    });

    const coordText = regionDescriptions.join('\n');
    log.debug(`🔧 [INPAINT] Inpainting ${boundingBoxes.length} region(s) with text coordinates`);
    log.debug(`🔧 [INPAINT] Regions:\n${coordText}`);
    log.debug(`🔧 [INPAINT] Fix prompt: "${fixPrompt}"`);

    // Extract base64 and mime type for original image
    const origBase64 = originalImage.replace(/^data:image\/\w+;base64,/, '');
    const origMimeType = originalImage.match(/^data:(image\/\w+);base64,/) ?
      originalImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build the inpainting prompt with TEXT-BASED coordinates
    // This avoids confusion when multiple images are sent
    const inpaintPrompt = fillTemplate(PROMPT_TEMPLATES.inpainting || `Edit this image. Make changes ONLY in the specified region(s).

TARGET REGION(S) TO EDIT:
{REGIONS}

WHAT TO FIX IN THESE REGIONS:
{FIX_PROMPT}

IMPORTANT INSTRUCTIONS:
- ONLY modify the content within the specified coordinate regions
- Keep everything outside these regions EXACTLY the same
- Maintain the same art style and color palette
- Make minimal changes - just fix the specific issues mentioned`, {
      REGIONS: coordText,
      FIX_PROMPT: fixPrompt
    });

    // Build parts array: prompt + ONLY the original image
    // NOTE: We do NOT send the mask as an image - coordinates are in the text prompt
    const parts = [
      { text: inpaintPrompt },
      {
        inline_data: {
          mime_type: origMimeType,
          data: origBase64
        }
      }
    ];

    // Use page image model for editing with retry for socket errors
    const modelId = MODEL_DEFAULTS.pageImage;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const systemInstruction = getImageSystemInstruction();
    const data = await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction && { systemInstruction }),
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            temperature: 0.6,
            ...(modelSupportsThinking(modelId) && { thinkingConfig: { includeThoughts: true } })
          }
        })
      });

      if (!response.ok) {
        const error = await response.text();
        log.error('❌ [INPAINT] Gemini API error:', error);
        const err = new Error(`Gemini API error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      return response.json();
    }, { maxRetries: 2, baseDelay: 2000 });

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const responseParts = data.candidates[0].content.parts;

      // Extract token usage from response
      const usageMetadata = data.usageMetadata || {};
      const usage = {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        thinking_tokens: usageMetadata.thoughtsTokenCount || 0
      };

      // Extract thinking text
      const thinkingText = extractThinkingFromParts(responseParts, 'INPAINT');

      for (const part of responseParts) {
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const rawImageData = `data:${respMimeType};base64,${inlineData.data}`;

          // Compress inpainted image to JPEG (same as initial generation)
          log.debug('🗜️  [INPAINT] Compressing repaired image to JPEG...');
          const compressedImageData = await compressImageToJPEG(rawImageData);

          log.info(`✅ [INPAINT] Successfully inpainted image (tokens: ${usage.input_tokens} in, ${usage.output_tokens} out)`);
          return { imageData: compressedImageData, thinkingText, usage, modelId, fullPrompt: inpaintPrompt };
        }
      }
    }

    log.warn('⚠️ [INPAINT] No edited image in response');
    return null;
  } catch (error) {
    log.error('❌ [INPAINT] Error inpainting image:', error);
    throw error;
  }
}


// =============================================================================
// FINAL CONSISTENCY CHECKS
// Cross-image consistency evaluation for story quality assurance
// =============================================================================

/**
 * Evaluate consistency across multiple images
 * Used for final quality checks before completing story generation
 *
 * @param {Array<{imageData: string, pageNumber: number|string}>} images - Array of images with page info
 * @param {string} checkType - 'character' | 'sequence' | 'full'
 * @param {object} options - Additional options
 * @param {string} options.characterName - Character name for character-focused checks
 * @param {Array<string>} options.referencePhotos - Reference photos for character comparison
 * @returns {Promise<object>} Consistency analysis result
 */
/**
 * Evaluate a single batch of images for consistency
 * @private
 */
async function evaluateSingleBatch(imagesToCheck, checkType, options, batchInfo = '') {
  const apiKey = process.env.GEMINI_API_KEY;

  // Load prompt template
  const promptTemplate = PROMPT_TEMPLATES.finalConsistencyCheck;
  if (!promptTemplate) {
    log.error('❌ [CONSISTENCY] Missing prompt template: final-consistency-check.txt');
    return null;
  }

  // Build character descriptions from characters array
  let characterDescriptions = 'No character descriptions available.';
  if (options.characters?.length > 0) {
    const descriptions = options.characters.map(char => {
      const parts = [];

      // Name and basic info
      parts.push(`**${char.name}**`);
      if (char.gender) parts.push(char.gender);
      if (char.age) parts.push(`${char.age} years old`);
      if (char.ageCategory) parts.push(`(${char.ageCategory})`);

      // Physical traits
      const physical = char.physical || {};
      const physicalParts = [];
      if (physical.hairColor) {
        let hair = physical.hairColor + ' hair';
        if (physical.hairLength) hair = `${physical.hairLength} ${hair}`;
        if (physical.hairStyle) hair += ` (${physical.hairStyle})`;
        physicalParts.push(hair);
      }
      if (physical.eyeColor) physicalParts.push(`${physical.eyeColor} eyes`);
      if (physical.skinTone) physicalParts.push(`${physical.skinTone} skin`);
      if (physical.build) physicalParts.push(physical.build);
      if (physical.facialHair && physical.facialHair !== 'none') physicalParts.push(physical.facialHair);
      if (physical.glasses && physical.glasses !== 'none') physicalParts.push(physical.glasses);
      if (physical.other) physicalParts.push(physical.other);

      if (physicalParts.length > 0) {
        parts.push('- Physical: ' + physicalParts.join(', '));
      }

      // Clothing (from structured clothing or current)
      const clothing = char.clothing || {};
      const clothingParts = [];
      if (clothing.structured) {
        if (clothing.structured.upperBody) clothingParts.push(clothing.structured.upperBody);
        if (clothing.structured.lowerBody) clothingParts.push(clothing.structured.lowerBody);
        if (clothing.structured.shoes) clothingParts.push(clothing.structured.shoes);
        if (clothing.structured.fullBody) clothingParts.push(clothing.structured.fullBody);
      } else if (clothing.current) {
        clothingParts.push(clothing.current);
      }

      if (clothingParts.length > 0) {
        parts.push('- Clothing: ' + clothingParts.join(', '));
      }

      return parts.join('\n');
    });
    characterDescriptions = descriptions.join('\n\n');
  }

  // Build image info as JSON array for cleaner parsing
  const imageInfoArray = imagesToCheck.map((img, idx) => {
    const pageNum = img.pageNumber || 'unknown';

    // Get character names from metadata or reference photos
    const chars = img.characters?.length > 0
      ? img.characters
      : (img.referenceCharacters?.length > 0 ? img.referenceCharacters : []);

    // Build per-character clothing object
    let clothing = img.characterClothing || img.referenceClothing || {};
    if (Object.keys(clothing).length === 0 && img.clothing) {
      // Fallback: single clothing category for all characters
      clothing = { _default: img.clothing };
    }

    return {
      image: idx + 1,
      page: pageNum,
      characters: chars,
      clothing: clothing,
      scene: img.sceneSummary || null
    };
  });

  // Convert to formatted JSON string
  const imageInfo = JSON.stringify(imageInfoArray, null, 2);

  // Fill template
  const prompt = fillTemplate(promptTemplate, {
    CHECK_TYPE: checkType.toUpperCase(),
    CHARACTER_NAME: options.characterName || 'all characters',
    CHARACTER_DESCRIPTIONS: characterDescriptions,
    IMAGE_INFO: imageInfo
  });

  // Build parts array with all images
  const parts = [];

  // Add reference photos first (if doing character check) - up to 5 characters
  if (checkType === 'character' && options.referencePhotos?.length > 0) {
    for (const refPhoto of options.referencePhotos.slice(0, 5)) {
      if (refPhoto && refPhoto.startsWith('data:image')) {
        const imageHash = hashImageData(refPhoto);
        let compressedBase64 = compressedRefCache.get(imageHash);

        if (!compressedBase64) {
          const compressed = await compressImageToJPEG(refPhoto, 85, 768);
          compressedBase64 = compressed.replace(/^data:image\/\w+;base64,/, '');
          compressedRefCache.set(imageHash, compressedBase64);
        }

        parts.push({
          text: `Reference photo for ${options.characterName}:`
        });
        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: compressedBase64
          }
        });
      }
    }
  }

  // Add all scene images
  for (let i = 0; i < imagesToCheck.length; i++) {
    const img = imagesToCheck[i];
    const imageData = img.imageData || img;

    if (!imageData || !imageData.startsWith('data:image')) {
      continue;
    }

    // Compress image for efficiency
    const compressed = await compressImageToJPEG(imageData, 80, 768);
    const base64Data = compressed.replace(/^data:image\/\w+;base64,/, '');

    parts.push({
      text: `Image ${i + 1} (Page ${img.pageNumber || 'unknown'}):`
    });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: base64Data
      }
    });
  }

  // Add the evaluation prompt
  parts.push({ text: prompt });

  // Entity consistency needs precise visual comparison — use bbox/consistency model (2.5-flash)
  const modelId = MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  log.info(`🔍 [CONSISTENCY] Checking ${imagesToCheck.length} images${batchInfo} (type: ${checkType})`);

  let data;
  try {
    data = await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 8000,
            temperature: 0.2
          },
          safetySettings: GEMINI_SAFETY_SETTINGS
        })
      });

      if (!response.ok) {
        const error = await response.text();
        log.error(`❌ [CONSISTENCY] API error: ${error.substring(0, 200)}`);
        const err = new Error(`Consistency API error (${response.status})`);
        err.status = response.status;
        throw err;
      }

      return response.json();
    }, { maxRetries: 2, baseDelay: 2000 });
  } catch (error) {
    log.error(`❌ [CONSISTENCY] Request failed after retries: ${error.message}`);
    return null;
  }

  // Log token usage
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  log.verbose(`📊 [CONSISTENCY] Tokens - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);

  // Extract response text
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Parse JSON response
  try {
    const result = getStoryHelpers().extractJsonFromText(responseText);
    if (result) {
      return { ...result, usage: { inputTokens, outputTokens, model: modelId }, evaluationPrompt: prompt, rawResponse: responseText };
    }
  } catch (parseError) {
    log.error(`❌ [CONSISTENCY] Failed to parse response: ${parseError.message}`);
    log.debug(`Response was: ${responseText.substring(0, 500)}`);
  }

  return { usage: { inputTokens, outputTokens, model: modelId }, evaluationPrompt: prompt, rawResponse: responseText };
}

/**
 * Evaluate consistency across images with batching
 * - Max 10 images per batch
 * - 5 image overlap between batches (1-10, 6-15, 11-20, ...)
 * - Merges results and deduplicates issues
 */
async function evaluateConsistencyAcrossImages(images, checkType = 'full', options = {}) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      log.warn('⚠️  [CONSISTENCY] Gemini API key not configured, skipping consistency check');
      return null;
    }

    if (!images || images.length < 2) {
      log.verbose('[CONSISTENCY] Need at least 2 images for consistency check');
      return { consistent: true, overallScore: 10, issues: [], summary: 'Single image - no consistency check needed' };
    }

    const BATCH_SIZE = 10;
    const OVERLAP = 5;

    // If 10 or fewer images, just run single batch
    if (images.length <= BATCH_SIZE) {
      const result = await evaluateSingleBatch(images, checkType, options);
      if (result) {
        const issueCount = result.issues?.length || 0;
        if (issueCount > 0) {
          log.warn(`⚠️  [CONSISTENCY] Found ${issueCount} issue(s): ${result.summary || 'see details'}`);
        } else {
          log.info(`✅ [CONSISTENCY] All images consistent (score: ${result.overallScore || 'N/A'})`);
        }
      }
      return result;
    }

    // Create batches with overlap: 1-10, 6-15, 11-20, ...
    const batches = [];
    for (let start = 0; start < images.length; start += (BATCH_SIZE - OVERLAP)) {
      const end = Math.min(start + BATCH_SIZE, images.length);
      const batch = images.slice(start, end);

      // Only add batch if it has at least 2 images
      if (batch.length >= 2) {
        batches.push({
          images: batch,
          startIndex: start,
          endIndex: end - 1,
          pageNumbers: batch.map(img => img.pageNumber)
        });
      }

      // Stop if we've reached the end
      if (end >= images.length) break;
    }

    log.info(`🔍 [CONSISTENCY] Processing ${images.length} images in ${batches.length} batches (size: ${BATCH_SIZE}, overlap: ${OVERLAP})`);

    // Process all batches
    const batchResults = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchInfo = ` [batch ${i + 1}/${batches.length}, pages ${batch.pageNumbers[0]}-${batch.pageNumbers[batch.pageNumbers.length - 1]}]`;

      const result = await evaluateSingleBatch(batch.images, checkType, options, batchInfo);

      if (result) {
        // Track token usage
        if (result.usage) {
          totalInputTokens += result.usage.inputTokens || 0;
          totalOutputTokens += result.usage.outputTokens || 0;
        }

        // Map batch-local image indices to actual page numbers
        if (result.issues && result.issues.length > 0) {
          result.issues = result.issues.map(issue => {
            // Helper to convert batch-local index (1-based) to page number
            const mapToPageNumber = (localIdx) => {
              const batchIdx = localIdx - 1;
              if (batchIdx >= 0 && batchIdx < batch.images.length) {
                return batch.images[batchIdx].pageNumber;
              }
              return localIdx; // Fallback if already a page number
            };

            // Convert issue.images (involved images)
            if (issue.images && Array.isArray(issue.images)) {
              issue.images = issue.images.map(mapToPageNumber);
            }

            // Also convert issue.pagesToFix (AI might return batch indices instead of page numbers)
            if (issue.pagesToFix && Array.isArray(issue.pagesToFix)) {
              issue.pagesToFix = issue.pagesToFix.map(mapToPageNumber);
            }

            return issue;
          });
        }

        batchResults.push(result);
      }
    }

    // Merge results from all batches
    const mergedIssues = [];
    const seenIssueKeys = new Set();
    let lowestScore = 10;
    let anyInconsistent = false;
    const evaluationPrompts = [];
    const rawResponses = [];

    for (const result of batchResults) {
      // Collect prompts and raw responses from each batch
      if (result.evaluationPrompt) {
        evaluationPrompts.push(result.evaluationPrompt);
      }
      if (result.rawResponse) {
        rawResponses.push(result.rawResponse);
      }
      if (!result.consistent) {
        anyInconsistent = true;
      }
      if (result.overallScore !== undefined && result.overallScore < lowestScore) {
        lowestScore = result.overallScore;
      }

      // Deduplicate issues (same pages + same type = same issue)
      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) {
          const issueKey = `${issue.images?.sort().join('-')}_${issue.type}_${issue.characterInvolved || ''}`;
          if (!seenIssueKeys.has(issueKey)) {
            seenIssueKeys.add(issueKey);
            mergedIssues.push(issue);
          }
        }
      }
    }

    // Build final result
    const finalResult = {
      consistent: !anyInconsistent && mergedIssues.length === 0,
      overallScore: lowestScore,
      issues: mergedIssues,
      summary: mergedIssues.length === 0
        ? `All ${images.length} images checked across ${batches.length} batches - consistent`
        : `Found ${mergedIssues.length} issue(s) across ${images.length} images (${batches.length} batches)`,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash',
        batches: batches.length
      },
      evaluationPrompts: evaluationPrompts.length > 0 ? evaluationPrompts : undefined,
      // For backward compatibility, also include first prompt as singular
      evaluationPrompt: evaluationPrompts[0] || undefined,
      // Raw responses for debugging/fine-tuning
      rawResponses: rawResponses.length > 0 ? rawResponses : undefined
    };

    // Log summary
    if (mergedIssues.length > 0) {
      log.warn(`⚠️  [CONSISTENCY] Found ${mergedIssues.length} issue(s) across ${batches.length} batches`);
    } else {
      log.info(`✅ [CONSISTENCY] All ${images.length} images consistent (score: ${lowestScore}, ${batches.length} batches)`);
    }

    return finalResult;
  } catch (error) {
    log.error(`❌ [CONSISTENCY] Error: ${error.message}`);
    return null;
  }
}

/**
 * Run all final consistency checks for a completed story
 *
 * @param {object} storyData - Story data containing images and text
 * @param {Array<object>} characters - Main characters with photos
 * @param {object} options - Check options
 * @returns {Promise<object>} Combined consistency report
 */
async function runFinalConsistencyChecks(storyData, characters = [], options = {}) {
  const report = {
    timestamp: new Date().toISOString(),
    imageChecks: [],
    textCheck: null,
    overallConsistent: true,
    totalIssues: 0,
    summary: '',
    // Token usage tracking for consistency checks
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      model: null
    }
  };

  try {
    const sceneImages = storyData.sceneImages || [];

    if (sceneImages.length < 2) {
      report.summary = 'Not enough images for consistency check';
      return report;
    }

    // Prepare images with page numbers and preserve all metadata for consistency evaluation
    const imagesWithPages = sceneImages.map((img, idx) => ({
      imageData: img.imageData || img,
      pageNumber: img.pageNumber || idx + 1,
      // Preserve metadata for scene context in consistency check prompt
      characters: img.characters || [],
      clothing: img.clothing || 'standard',
      characterClothing: img.characterClothing || null,
      referenceCharacters: img.referenceCharacters || [],
      referenceClothing: img.referenceClothing || {},
      sceneSummary: img.sceneSummary || null
    })).filter(img => img.imageData);

    // 1. Full consistency check across all images
    log.info('🔍 [FINAL CHECKS] Running full image consistency check...');
    const fullCheck = await evaluateConsistencyAcrossImages(imagesWithPages, 'full', { characters });
    if (fullCheck) {
      report.imageChecks.push({
        type: 'full',
        ...fullCheck
      });
      if (!fullCheck.consistent) {
        report.overallConsistent = false;
      }
      report.totalIssues += fullCheck.issues?.length || 0;
      // Aggregate token usage
      if (fullCheck.usage) {
        report.tokenUsage.inputTokens += fullCheck.usage.inputTokens || 0;
        report.tokenUsage.outputTokens += fullCheck.usage.outputTokens || 0;
        report.tokenUsage.calls += fullCheck.usage.batches || 1;
        report.tokenUsage.model = fullCheck.usage.model;
      }
    }

    // 2. Character-specific checks (one per main character)
    if (characters?.length > 0 && options.checkCharacters !== false) {
      for (const character of characters.slice(0, 5)) { // Limit to 5 main characters
        const charName = character.name;
        const charPhoto = getFacePhoto(character);

        // Find images where this character appears (based on scene hints or all images)
        const charImages = imagesWithPages; // For now, check all images

        if (charImages.length >= 2 && charPhoto) {
          log.info(`🔍 [FINAL CHECKS] Checking character consistency: ${charName}`);
          const charCheck = await evaluateConsistencyAcrossImages(
            charImages,
            'character',
            { characterName: charName, referencePhotos: [charPhoto] }
          );

          if (charCheck) {
            report.imageChecks.push({
              type: 'character',
              characterName: charName,
              ...charCheck
            });
            if (!charCheck.consistent) {
              report.overallConsistent = false;
            }
            report.totalIssues += charCheck.issues?.length || 0;
            // Aggregate token usage
            if (charCheck.usage) {
              report.tokenUsage.inputTokens += charCheck.usage.inputTokens || 0;
              report.tokenUsage.outputTokens += charCheck.usage.outputTokens || 0;
              report.tokenUsage.calls += charCheck.usage.batches || 1;
              if (!report.tokenUsage.model) {
                report.tokenUsage.model = charCheck.usage.model;
              }
            }
          }
        }
      }
    }

    // Build summary
    const checksRun = report.imageChecks.length;
    if (report.totalIssues === 0) {
      report.summary = `All ${checksRun} checks passed - images are consistent`;
    } else {
      report.summary = `Found ${report.totalIssues} issue(s) across ${checksRun} checks`;
    }

    log.info(`📋 [FINAL CHECKS] Complete: ${report.summary}`);

  } catch (error) {
    log.error(`❌ [FINAL CHECKS] Error running checks: ${error.message}`);
    report.error = error.message;
  }

  return report;
}

// =============================================================================
// INCREMENTAL CONSISTENCY CHECK
// Real-time consistency checking during story generation
// =============================================================================

/**
 * Default configuration for incremental consistency checks
 */
const INCREMENTAL_CONSISTENCY_DEFAULTS = {
  enabled: true,
  lookbackCount: 3,           // How many previous images to compare
  fixThreshold: 7,            // Score below which to trigger fixes (0-10)
  minSeverityToFix: 'major',  // 'critical' | 'major' | 'minor'
  dryRun: false,              // If true, log what would be fixed but don't fix
  checks: {
    characterIdentity: true,
    clothing: true,
    artStyle: true
  }
};

/**
 * Evaluate a newly generated image for consistency with previous images
 *
 * @param {string} currentImage - Base64 image data of the new image
 * @param {number} currentPageNumber - Page number of the new image
 * @param {Array<object>} previousImages - Array of previous images with metadata
 * @param {object} options - Evaluation options
 * @returns {Promise<object>} Consistency evaluation result
 */
async function evaluateIncrementalConsistency(currentImage, currentPageNumber, previousImages, options = {}) {
  const config = { ...INCREMENTAL_CONSISTENCY_DEFAULTS, ...options };
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    log.warn('⚠️  [INCR-CONSISTENCY] Gemini API key not configured, skipping');
    return null;
  }

  if (!previousImages || previousImages.length === 0) {
    log.verbose('[INCR-CONSISTENCY] No previous images to compare against');
    return { consistent: true, score: 10, issues: [], summary: 'First image - no comparison needed' };
  }

  // Limit to lookback count
  const imagesToCompare = previousImages.slice(-config.lookbackCount);
  const prevPageNumbers = imagesToCompare.map(img => img.pageNumber).join(', ');

  log.info(`🔍 [INCR-CONSISTENCY] Page ${currentPageNumber}: checking against pages ${prevPageNumbers}`);

  // Load prompt template
  const promptTemplate = PROMPT_TEMPLATES.incrementalConsistencyCheck;
  if (!promptTemplate) {
    log.error('❌ [INCR-CONSISTENCY] Missing prompt template: incremental-consistency-check.txt');
    return null;
  }

  // Build clothing info string from previous pages
  const clothingLines = [];
  const previousCharacterSet = new Set();
  for (const img of imagesToCompare) {
    if (img.characterClothing) {
      for (const [charName, clothing] of Object.entries(img.characterClothing)) {
        previousCharacterSet.add(charName);
        clothingLines.push(`- ${charName} (Page ${img.pageNumber}): ${clothing}`);
      }
    } else if (img.characters && img.clothing) {
      for (const char of img.characters) {
        previousCharacterSet.add(char);
      }
      clothingLines.push(`- All characters (Page ${img.pageNumber}): ${img.clothing}`);
    }
  }

  // Current page characters (from config) - these are who should actually be in this scene
  const currentCharacters = config.currentCharacters || [];
  const currentCharactersStr = currentCharacters.length > 0 ? currentCharacters.join(', ') : 'Unknown';

  // Previous pages characters (for reference only)
  const previousCharactersStr = Array.from(previousCharacterSet).join(', ') || 'Unknown';
  const clothingInfo = clothingLines.length > 0 ? clothingLines.join('\n') : 'No specific clothing information';

  // Fill template
  const prompt = fillTemplate(promptTemplate, {
    PAGE_NUMBER: currentPageNumber,
    IMAGE_COUNT: imagesToCompare.length + 1,
    PREV_PAGES: prevPageNumbers,
    CURRENT_CHARACTERS: currentCharactersStr,
    PREVIOUS_CHARACTERS: previousCharactersStr,
    CLOTHING_INFO: clothingInfo
  });

  // Build parts array
  const parts = [];

  // Add current image first (Image 1)
  const currentBase64 = currentImage.replace(/^data:image\/\w+;base64,/, '');
  parts.push({ text: `Image 1 (Page ${currentPageNumber} - CURRENT, to evaluate):` });
  parts.push({
    inline_data: {
      mime_type: 'image/jpeg',
      data: currentBase64
    }
  });

  // Add previous images (Images 2, 3, ...)
  for (let i = 0; i < imagesToCompare.length; i++) {
    const img = imagesToCompare[i];
    const imageData = img.imageData || img;

    if (!imageData || !imageData.startsWith('data:image')) continue;

    // Compress for efficiency
    const compressed = await compressImageToJPEG(imageData, 80, 768);
    const base64Data = compressed.replace(/^data:image\/\w+;base64,/, '');

    parts.push({ text: `Image ${i + 2} (Page ${img.pageNumber} - reference):` });
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data: base64Data
      }
    });
  }

  // Add the evaluation prompt
  parts.push({ text: prompt });

  // Entity consistency needs precise visual comparison — use bbox/consistency model (2.5-flash)
  const modelId = MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  let data;
  try {
    data = await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 4000,
            temperature: 0.2
          },
          safetySettings: GEMINI_SAFETY_SETTINGS
        })
      });

      if (!response.ok) {
        const error = await response.text();
        log.error(`❌ [INCR-CONSISTENCY] API error: ${error.substring(0, 200)}`);
        throw new Error(`API error (${response.status})`);
      }

      return response.json();
    }, { maxRetries: 2, baseDelay: 2000 });
  } catch (error) {
    log.error(`❌ [INCR-CONSISTENCY] Request failed: ${error.message}`);
    return null;
  }

  // Log token usage
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  log.verbose(`📊 [INCR-CONSISTENCY] Tokens - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);

  // Extract response text
  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  // Parse JSON response
  try {
    // Clean up response: remove markdown fences and trailing commas
    let cleanedText = responseText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    // Use a balanced brace matching approach to find the JSON object
    const startIdx = cleanedText.indexOf('{');
    if (startIdx === -1) throw new Error('No JSON object found in response');

    let braceCount = 0;
    let endIdx = -1;
    for (let i = startIdx; i < cleanedText.length; i++) {
      if (cleanedText[i] === '{') braceCount++;
      else if (cleanedText[i] === '}') braceCount--;
      if (braceCount === 0) {
        endIdx = i + 1;
        break;
      }
    }

    if (endIdx === -1) throw new Error('Unbalanced braces in JSON response');

    let jsonStr = cleanedText.substring(startIdx, endIdx);
    // Clean trailing commas before } or ]
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1');

    const result = JSON.parse(jsonStr);
    if (result) {

      // Log result
      if (result.consistent) {
        log.info(`✅ [INCR-CONSISTENCY] Page ${currentPageNumber}: consistent (score: ${result.score})`);
      } else {
        log.warn(`⚠️  [INCR-CONSISTENCY] Page ${currentPageNumber}: ${result.issues?.length || 0} issue(s) found (score: ${result.score})`);
        for (const issue of result.issues || []) {
          log.debug(`   - [${issue.severity}] ${issue.type}: ${issue.description}`);
        }
      }

      return {
        ...result,
        usage: { inputTokens, outputTokens, model: modelId },
        pageNumber: currentPageNumber,
        comparedTo: prevPageNumbers
      };
    }
  } catch (parseError) {
    log.error(`❌ [INCR-CONSISTENCY] Failed to parse response: ${parseError.message}`);
    log.debug(`Response was: ${responseText.substring(0, 500)}`);
  }

  return null;
}

/**
 * Merge issues from quality evaluation and consistency check
 * Deduplicates similar issues and creates a unified fix plan
 *
 * @param {object} qualityResult - Result from evaluateImageQuality
 * @param {object} consistencyResult - Result from evaluateIncrementalConsistency
 * @param {object} options - Merge options
 * @returns {object} Unified issue report with fix plan
 */
function mergeEvaluationIssues(qualityResult, consistencyResult, options = {}) {
  const config = { ...INCREMENTAL_CONSISTENCY_DEFAULTS, ...options };

  const report = {
    qualityScore: qualityResult?.score ?? null,
    consistencyScore: consistencyResult?.score ?? null,
    qualityIssues: [],
    consistencyIssues: [],
    allIssues: [],
    fixPlan: {
      requiresFix: false,
      fixTargets: [],
      estimatedFixCount: 0
    },
    dryRunReport: null
  };

  // Collect quality issues (from fixTargets)
  if (qualityResult?.fixTargets) {
    for (const target of qualityResult.fixTargets) {
      report.qualityIssues.push({
        source: 'quality',
        type: target.element || 'rendering',
        severity: target.severity || 'major',
        description: target.issue || target.description || 'Quality issue',
        fixTarget: {
          region: target.bounds || 'full',
          instruction: target.fix_instruction || target.instruction || 'Fix the issue'
        }
      });
    }
  }

  // Collect consistency issues
  if (consistencyResult?.issues) {
    for (const issue of consistencyResult.issues) {
      report.consistencyIssues.push({
        source: 'consistency',
        type: issue.type || 'consistency',
        severity: issue.severity || 'major',
        description: issue.description,
        affectedCharacter: issue.affectedCharacter,
        comparedToPage: issue.comparedToPage,
        fixTarget: issue.fixTarget
      });
    }
  }

  // Merge all issues
  report.allIssues = [...report.qualityIssues, ...report.consistencyIssues];

  // Determine severity threshold
  const severityOrder = { critical: 0, major: 1, minor: 2 };
  const minSeverityLevel = severityOrder[config.minSeverityToFix] || 1;

  // Filter issues that meet severity threshold
  const fixableIssues = report.allIssues.filter(issue => {
    const issueSeverity = severityOrder[issue.severity] ?? 1;
    return issueSeverity <= minSeverityLevel;
  });

  // Build fix plan
  if (fixableIssues.length > 0) {
    report.fixPlan.requiresFix = true;
    report.fixPlan.estimatedFixCount = fixableIssues.length;

    // Collect fix targets, merging overlapping regions
    for (const issue of fixableIssues) {
      if (issue.fixTarget) {
        report.fixPlan.fixTargets.push({
          source: issue.source,
          type: issue.type,
          severity: issue.severity,
          region: issue.fixTarget.region,
          instruction: issue.fixTarget.instruction
        });
      }
    }
  }

  // Build dry-run report
  if (config.dryRun) {
    report.dryRunReport = {
      wouldFix: fixableIssues.map(i => `[${i.severity}] ${i.type}: ${i.description}`),
      wouldSkip: report.allIssues
        .filter(i => !fixableIssues.includes(i))
        .map(i => `[${i.severity}] ${i.type}: ${i.description} [SKIPPED - below threshold]`)
    };
  }

  return report;
}

/**
 * Log dry-run report showing what would be fixed
 *
 * @param {string} pageContext - Page context string (e.g., "PAGE 5")
 * @param {object} report - Unified issue report from mergeEvaluationIssues
 */
function logDryRunReport(pageContext, report) {
  const pageLabel = pageContext ? `[${pageContext}] ` : '';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📋 ${pageLabel}DRY RUN REPORT - Incremental Consistency`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Quality score: ${report.qualityScore ?? 'N/A'}`);
  console.log(`Consistency score: ${report.consistencyScore ?? 'N/A'}`);
  console.log(`Quality issues: ${report.qualityIssues.length}`);
  console.log(`Consistency issues: ${report.consistencyIssues.length}`);
  console.log(`Total issues: ${report.allIssues.length}`);
  console.log('');

  if (report.dryRunReport?.wouldFix?.length > 0) {
    console.log('Would FIX:');
    for (const fix of report.dryRunReport.wouldFix) {
      console.log(`  ✓ ${fix}`);
    }
  } else {
    console.log('Would FIX: (none)');
  }

  if (report.dryRunReport?.wouldSkip?.length > 0) {
    console.log('');
    console.log('Would SKIP:');
    for (const skip of report.dryRunReport.wouldSkip) {
      console.log(`  ✗ ${skip}`);
    }
  }

  console.log(`${'='.repeat(60)}\n`);
}

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
async function splitGridIntoReferences(gridImage, count) {
  // Convert input to BOTH a Buffer (for sharp fallback) and a base64 string
  // (for the Python call) so we don't pay the conversion twice.
  let buffer;
  let base64;
  if (typeof gridImage === 'string') {
    base64 = gridImage.replace(/^data:image\/\w+;base64,/, '');
    buffer = Buffer.from(base64, 'base64');
  } else {
    buffer = gridImage;
    base64 = buffer.toString('base64');
  }

  // Try Python service first — variance-based separator detection that
  // finds the ACTUAL cell boundaries instead of blindly dividing pixels.
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  try {
    const response = await fetch(`${photoAnalyzerUrl}/split-reference-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: `data:image/png;base64,${base64}`,
        count,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success && Array.isArray(result.cells) && result.cells.length === count) {
        log.info(`[REF-SHEET] Python split: ${result.layout.cols}x${result.layout.rows}, separators v=[${result.separators.vertical.join(',')}] h=[${result.separators.horizontal.join(',')}]`);
        return result.cells;
      }
      log.warn(`[REF-SHEET] Python split returned ${result.cells?.length ?? 'no'} cells (expected ${count}) — falling back to sharp`);
    } else {
      log.debug(`[REF-SHEET] Python service unavailable (${response.status}) — using sharp fallback`);
    }
  } catch (err) {
    log.debug(`[REF-SHEET] Python service unreachable (${err.message}) — using sharp fallback`);
  }

  // Fallback: blind equal-cell math via sharp. Works only when cells are
  // really equal-sized with no padding/separator/title bar.
  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Could not get grid image dimensions');
  }

  // Calculate grid layout — match prompt logic: 2x2 only for exactly 4, otherwise single column
  const cols = count === 4 ? 2 : 1;
  const rows = count === 4 ? 2 : count;
  const cellWidth = Math.floor(width / cols);
  const cellHeight = Math.floor(height / rows);

  log.debug(`[REF-SHEET] Sharp fallback: ${width}x${height} → ${cols}x${rows} cells (${cellWidth}x${cellHeight} each)`);

  const references = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);

    try {
      const cropped = await sharp(buffer)
        .extract({
          left: col * cellWidth,
          top: row * cellHeight,
          width: cellWidth,
          height: cellHeight
        })
        .png()
        .toBuffer();

      references.push(cropped.toString('base64'));
      log.debug(`[REF-SHEET] Sharp extracted cell ${i + 1}/${count} (col=${col}, row=${row})`);
    } catch (err) {
      log.error(`[REF-SHEET] Sharp failed to extract cell ${i}: ${err.message}`);
      references.push(null);
    }
  }

  return references;
}

/**
 * Build reference sheet prompt for a batch of elements
 *
 * @param {Array} elements - Elements to include (from getElementsNeedingReferenceImages)
 * @param {string} styleDescription - Art style description
 * @returns {string} Complete prompt for reference sheet generation
 */
function buildReferenceSheetPrompt(elements, styleDescription) {
  const count = elements.length;
  // Only use 2x2 for exactly 4 elements. Everything else uses a single column
  // to avoid partial rows (e.g. 3 elements in a 2x2 leaves an empty cell that
  // confuses image models and grid splitters).
  const cols = count === 4 ? 2 : 1;
  const rows = count === 4 ? 2 : count;

  // Build grid layout description
  const positions2x2 = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'];
  const gridLayoutLines = elements.map((el, i) => {
    const pos = cols === 2 ? (positions2x2[i] || `Cell ${i + 1}`) : `Row ${i + 1}`;
    const desc = el.extractedDescription || el.description;
    return `${pos}: ${el.name} (${el.type}) - ${desc}`;
  });

  const prompt = fillTemplate(PROMPT_TEMPLATES.referenceSheet, {
    STYLE_DESCRIPTION: styleDescription,
    GRID_SIZE: `${cols}x${rows}`,
    GRID_LAYOUT: gridLayoutLines.join('\n'),
    COLS: cols.toString(),
    ROWS: rows.toString()
  });

  return prompt;
}

/**
 * Generate reference sheet for Visual Bible elements
 * Creates a grid image with reference illustrations for secondary characters and key objects
 *
 * @param {Object} visualBible - Visual Bible object
 * @param {string} styleDescription - Art style description for the story
 * @param {Object} options - Generation options
 * @param {number} options.minAppearances - Minimum page appearances (default 2)
 * @param {number} options.maxPerBatch - Maximum elements per grid (default 4)
 * @param {string} options.imageModel - Image model override
 * @returns {Promise<{generated: number, failed: number, elements: Array}>}
 */
async function generateReferenceSheet(visualBible, styleDescription, options = {}) {
  const {
    minAppearances = 2,
    maxPerBatch = 4,
    imageModel = null,
    maxElements = null
  } = options;

  // Generate reference sheets using whatever image model is configured
  // (same flow for Gemini, Grok, etc.)

  // DEBUG: Log visual bible contents to diagnose reference image generation
  log.info(`[REF-SHEET] Visual Bible summary:`);
  log.info(`  - Secondary characters: ${visualBible?.secondaryCharacters?.length || 0}`);
  log.info(`  - Artifacts: ${visualBible?.artifacts?.length || 0}`);
  log.info(`  - Animals: ${visualBible?.animals?.length || 0}`);
  log.info(`  - Vehicles: ${visualBible?.vehicles?.length || 0}`);
  log.info(`  - Locations (non-landmark): ${(visualBible?.locations || []).filter(l => !l.isRealLandmark).length}`);

  // Log each element with page appearances for debugging
  const logEntries = (entries, type) => {
    for (const e of entries || []) {
      const pages = e.appearsInPages || e.pages || [];
      const status = pages.length >= minAppearances ? '✓' : '✗';
      log.debug(`  ${status} ${type}: "${e.name}" pages=[${pages.join(',')}] (${pages.length} appearances)`);
    }
  };
  logEntries(visualBible?.secondaryCharacters, 'char');
  logEntries(visualBible?.artifacts, 'artifact');
  logEntries(visualBible?.animals, 'animal');
  logEntries(visualBible?.vehicles, 'vehicle');
  logEntries((visualBible?.locations || []).filter(l => !l.isRealLandmark), 'location');

  // Import the function here to avoid circular dependency
  const { getElementsNeedingReferenceImages, updateElementReferenceImage } = require('./visualBible');

  // Get elements that need reference images
  let needsReference = getElementsNeedingReferenceImages(visualBible, minAppearances);

  // Limit elements if maxElements specified (trial mode)
  if (maxElements && needsReference.length > maxElements) {
    // Sort by page count descending, then alphabetically
    needsReference.sort((a, b) => b.pageCount - a.pageCount || a.name.localeCompare(b.name));
    needsReference.length = maxElements;
    log.info(`[REF-SHEET] Limited to top ${maxElements} elements (trial mode)`);
  }

  if (needsReference.length === 0) {
    log.info('[REF-SHEET] No elements need reference images (none with 2+ page appearances)');
    return { generated: 0, failed: 0, elements: [] };
  }

  log.info(`[REF-SHEET] 🎨 Generating reference images for ${needsReference.length} element(s)`);
  log.info(`[REF-SHEET] Elements: ${needsReference.map(e => `${e.name} (${e.type}, ${e.pageCount} pages)`).join(', ')}`);

  let generated = 0;
  let failed = 0;
  const processedElements = [];

  // Batch elements into grids, balancing across batches so we never end up
  // with a lone-element batch (which costs a full generation for 1 output
  // and leaves no "neighbours" for the splitter to calibrate against).
  // With N total and max per batch M: batchCount = ceil(N/M), perBatch =
  // ceil(N/batchCount). Then distribute N elements across batchCount slots
  // as evenly as possible.
  //   N=5, M=4 → 2 batches of 3,2   (was 4,1)
  //   N=6, M=4 → 2 batches of 3,3   (was 4,2)
  //   N=9, M=4 → 3 batches of 3,3,3 (was 4,4,1)
  const batches = [];
  const N = needsReference.length;
  const batchCount = Math.max(1, Math.ceil(N / maxPerBatch));
  const basePer = Math.floor(N / batchCount);
  const remainder = N - basePer * batchCount; // first `remainder` batches get +1
  let cursor = 0;
  for (let b = 0; b < batchCount; b++) {
    const size = basePer + (b < remainder ? 1 : 0);
    batches.push(needsReference.slice(cursor, cursor + size));
    cursor += size;
  }

  log.info(`[REF-SHEET] Processing ${batches.length} batch(es) — sizes: ${batches.map(b => b.length).join(', ')}`);

  // Capture source grids per batch so callers can persist them for debugging.
  // The grid image is normally discarded after splitting — keep it for the
  // dev panel so users can see what got cut and verify the splitter is right.
  const sourceGrids = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    log.info(`[REF-SHEET] Batch ${batchIdx + 1}/${batches.length}: ${batch.length} elements`);

    try {
      // Build the prompt for this batch
      const prompt = buildReferenceSheetPrompt(batch, styleDescription);

      // Generate the grid image using the configured image model (Gemini, Grok, etc.)
      const imageModelOverride = imageModel || null;
      const result = await callGeminiAPIForImage(prompt, [], null, 'avatar', null, imageModelOverride, null, '');

      if (!result || !result.imageData) {
        throw new Error('Image generation did not return an image');
      }

      // Extract base64 from data URI
      const gridImageData = result.imageData.replace(/^data:image\/\w+;base64,/, '');

      log.info(`[REF-SHEET] ✓ Generated ${batch.length}-element grid (${Math.round(gridImageData.length / 1024)}KB)`);

      // Capture the source grid for debugging (caller persists it)
      sourceGrids.push({
        batchIdx,
        imageData: result.imageData,
        elementNames: batch.map(e => `${e.name} (${e.type})`),
        elementIds: batch.map(e => e.id),
      });

      // Split grid into individual references
      const references = await splitGridIntoReferences(gridImageData, batch.length);

      // Update Visual Bible with extracted references
      for (let i = 0; i < batch.length; i++) {
        const element = batch[i];
        const refImage = references[i];

        if (refImage) {
          updateElementReferenceImage(visualBible, element.id, `data:image/png;base64,${refImage}`);
          generated++;
          processedElements.push({
            id: element.id,
            name: element.name,
            type: element.type,
            success: true
          });
        } else {
          failed++;
          processedElements.push({
            id: element.id,
            name: element.name,
            type: element.type,
            success: false,
            error: 'Failed to extract from grid'
          });
        }
      }
    } catch (err) {
      log.error(`[REF-SHEET] ❌ Batch ${batchIdx + 1} failed: ${err.message}`);

      // Mark all elements in batch as failed
      for (const element of batch) {
        failed++;
        processedElements.push({
          id: element.id,
          name: element.name,
          type: element.type,
          success: false,
          error: err.message
        });
      }
    }
  }

  log.info(`[REF-SHEET] Complete: ${generated} generated, ${failed} failed`);

  return {
    generated,
    failed,
    elements: processedElements,
    sourceGrids,  // Source grid images per batch — caller persists for debugging
  };
}

// =============================================================================
// VISUAL BIBLE GRID BUILDER
// Combines VB elements and secondary landmarks into a single labeled grid image
// =============================================================================

/**
 * Build a labeled grid image combining Visual Bible elements and secondary landmarks
 * This reduces API image count by combining multiple references into one grid
 *
 * @param {Array} vbElements - Elements from getElementReferenceImagesForPage()
 *   Each element: { name, type, referenceImageData, description }
 * @param {Array} secondaryLandmarks - Secondary landmark photos (2nd+ landmarks)
 *   Each landmark: { name, photoData }
 * @returns {Promise<Buffer|null>} - JPEG buffer of the grid image, or null if no elements
 */
/**
 * Build a VB grid filtered for EMPTY SCENE generation: vehicles + non-landmark locations only.
 * Skips characters, animals, and artifacts (these belong on the populated page, not the
 * empty background — and including artifacts caused doubling, e.g. a book rendered both
 * in the background and later in the character's hand).
 *
 * @param {Object} visualBible - Story visual bible
 * @param {number} pageNumber - Page number to filter elements for
 * @param {Array} pageLandmarkPhotos - Landmark photos already loaded for this page
 * @returns {Promise<Buffer|null>} VB grid buffer (with rawElements property), or null if empty
 */
async function buildEmptySceneVbGrid(visualBible, pageNumber, pageLandmarkPhotos = []) {
  if (!visualBible) return null;
  const { getEmptySceneElementReferences } = require('./visualBible');
  const vehicleAndLocationRefs = getEmptySceneElementReferences(visualBible, pageNumber, 9);
  const secondaryLandmarks = (pageLandmarkPhotos || []).slice(1);
  if (vehicleAndLocationRefs.length === 0 && secondaryLandmarks.length === 0) return null;
  return buildVisualBibleGrid(vehicleAndLocationRefs, secondaryLandmarks);
}

async function buildVisualBibleGrid(vbElements = [], secondaryLandmarks = []) {
  const allElements = [];

  // Add VB elements (secondary chars, animals, artifacts, vehicles, locations)
  for (const el of vbElements) {
    if (el.referenceImageData) {
      allElements.push({
        name: el.name,
        type: el.type,
        imageData: el.referenceImageData
      });
    }
  }

  // Add secondary landmarks (2nd+ go in grid, 1st stays as separate photo)
  for (const lm of secondaryLandmarks) {
    if (lm.photoData && lm.photoData.startsWith('data:image')) {
      allElements.push({
        name: lm.name,
        type: 'landmark',
        imageData: lm.photoData
      });
    }
  }

  if (allElements.length === 0) {
    return null;
  }

  // Max 9 elements (4 right column + 5 bottom row in Grok's bordered scene layout)
  const gridElements = allElements.slice(0, 9);
  if (allElements.length > 9) {
    const dropped = allElements.slice(9).map(e => `${e.name} (${e.type})`).join(', ');
    log.warn(`⚠️ [VB-GRID] Grid overflow: ${allElements.length} elements, keeping first 9, dropping: ${dropped}`);
  }

  // Single element: return the image directly with a small label strip on top.
  // No grid wrapper, no dark background, no wasted space.
  if (gridElements.length === 1) {
    try {
      const el = gridElements[0];
      const base64Data = el.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const resized = await sharp(imageBuffer)
        .resize({ width: 512, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      const labelHeight = 24;
      const totalHeight = resized.info.height + labelHeight;
      const labelText = `${el.name} (${el.type})`;
      const displayText = escapeXml(labelText.length > 40 ? labelText.substring(0, 37) + '...' : labelText);
      const labelSvg = `<svg width="512" height="${labelHeight}">
        <rect width="512" height="${labelHeight}" fill="#555"/>
        <text x="256" y="17" font-family="Arial, sans-serif" font-size="13" fill="white" text-anchor="middle">${displayText}</text>
      </svg>`;
      const gridBuffer = await sharp({
        create: { width: 512, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } }
      })
        .composite([
          { input: Buffer.from(labelSvg), left: 0, top: 0 },
          { input: resized.data, left: 0, top: labelHeight },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
      log.info(`🔲 [VB-GRID] Single element: ${el.name} (${el.type}), ${512}x${totalHeight}px, ${Math.round(gridBuffer.length / 1024)}KB`);
      gridBuffer.rawElements = gridElements;
      return gridBuffer;
    } catch (err) {
      log.warn(`⚠️ [VB-GRID] Single element layout failed: ${err.message}, falling back to stack`);
    }
  }

  // Multi-element: single column vertical stack — each element gets full width
  const cellWidth = 512;
  const labelHeight = 28;
  const gap = 4;

  log.debug(`🔲 [VB-GRID] Building vertical stack with ${gridElements.length} elements`);

  try {
    // First pass: resize all images and calculate total height
    const resizedElements = [];
    for (const el of gridElements) {
      const base64Data = el.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      const resized = await sharp(imageBuffer)
        .resize({ width: cellWidth, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      resizedElements.push({ el, buffer: resized.data, width: resized.info.width, height: resized.info.height });
    }

    const gridWidth = cellWidth;
    const gridHeight = resizedElements.reduce((sum, r) => sum + r.height + labelHeight + gap, 0) - gap;

    // Create composite operations — stack vertically
    const composites = [];
    let y = 0;
    for (const { el, buffer, height } of resizedElements) {
      // Label above the image
      const labelText = `${el.name} (${el.type})`;
      const displayText = escapeXml(labelText.length > 40 ? labelText.substring(0, 37) + '...' : labelText);
      const labelSvg = `
        <svg width="${cellWidth}" height="${labelHeight}">
          <rect width="${cellWidth}" height="${labelHeight}" fill="#333"/>
          <text x="${cellWidth / 2}" y="20" font-family="Arial, sans-serif" font-size="14"
                fill="white" text-anchor="middle">${displayText}</text>
        </svg>
      `;
      composites.push({ input: Buffer.from(labelSvg), left: 0, top: y });
      y += labelHeight;

      // Image below the label
      composites.push({ input: buffer, left: 0, top: y });
      y += height + gap;
    }

    // Create base image and composite all elements
    const gridBuffer = await sharp({
      create: {
        width: gridWidth,
        height: gridHeight,
        channels: 3,
        background: { r: 50, g: 50, b: 50 }
      }
    })
      .composite(composites)
      .jpeg({ quality: 85 })
      .toBuffer();

    log.info(`🔲 [VB-GRID] Created vertical stack: ${gridElements.length} elements, ${gridWidth}x${gridHeight}px, ${Math.round(gridBuffer.length / 1024)}KB`);

    // Attach raw elements so Grok's packReferences can lay them out individually
    // around the empty scene (256x256 cells in a right column + bottom row).
    // Buffers are mutable objects in Node, so adding a property is safe and the
    // buffer continues to behave like a normal Buffer for image consumers.
    gridBuffer.rawElements = gridElements;

    return gridBuffer;
  } catch (error) {
    log.error(`❌ [VB-GRID] Failed to build grid: ${error.message}`);
    return null;
  }
}

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
  const { imageModelOverride, imageBackendOverride, characterPhotos = [] } = options;
  const { resolveArtStyle } = require('./storyHelpers');

  // artStyle can be: a preset key ("pixar"), or a custom description string
  const styleDescription = resolveArtStyle(artStyle, imageBackendOverride) || artStyle;

  const withAvatars = characterPhotos.length > 0;
  const prompt = withAvatars
    ? `Redraw this illustration in the following art style. Keep ALL characters, their positions, sizes, actions, and the scene layout EXACTLY the same. Only change the visual art style. Use the provided character reference photos to ensure faces remain accurate and recognizable.

Art Style: ${styleDescription}

CRITICAL:
- Same characters in same positions — use reference photos to preserve facial features
- Same scene composition and background
- Same objects and landmarks
- Only the rendering style changes (colors, brush strokes, texture, shading)`
    : `Redraw this illustration in the following art style. Keep ALL characters, their positions, sizes, actions, and the scene layout EXACTLY the same. Only change the visual art style.

Art Style: ${styleDescription}

CRITICAL:
- Same characters in same positions
- Same scene composition and background
- Same objects and landmarks
- Only the rendering style changes (colors, brush strokes, texture, shading)`;

  log.info(`🎨 [STYLE TRANSFER] ${withAvatars ? `With ${characterPhotos.length} avatar references` : 'Without avatars'}, target: ${artStyle}, model: ${imageModelOverride || 'default'}`);

  return generateImageOnly(prompt, characterPhotos, {
    imageModelOverride,
    imageBackendOverride,
    previousImage: imageData,
    skipCache: true,
  });
}

/**
 * Analyze the art style of an image using Gemini vision.
 * Returns a text description of the style that can be used for style transfer.
 */
async function analyzeImageStyle(imageData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: `Analyze the art style of this illustration. Describe it in detail so another AI image generator could reproduce the same style. Include:

1. Medium/technique (watercolor, digital, oil, 3D render, etc.)
2. Line work (bold outlines, soft edges, no outlines, etc.)
3. Color palette (warm/cool, muted/vibrant, specific dominant colors)
4. Shading/lighting style (flat, cel-shaded, volumetric, chiaroscuro, etc.)
5. Level of realism (photorealistic, stylized, cartoon, abstract)
6. Texture (smooth, grainy, brush strokes visible, paper texture, etc.)
7. Overall mood/aesthetic

Output ONLY the style description as a single paragraph (3-5 sentences) that could be used as an art style prompt. No headers, no bullet points, no analysis structure — just the description.` }
        ]
      }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini style analysis failed: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('No style analysis returned');

  log.info(`🎨 [STYLE ANALYZE] Result: ${text.substring(0, 150)}...`);
  return { style: text, usage: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: data.usageMetadata?.candidatesTokenCount || 0 } };
}

/**
 * Compare two images for art style similarity.
 * Sends both images to Gemini and returns a similarity score + breakdown.
 */
async function compareImageStyles(imageDataA, imageDataB) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const toBase64 = (img) => img.replace(/^data:image\/\w+;base64,/, '');
  const getMime = (img) => img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'Image A:' },
          { inline_data: { mime_type: getMime(imageDataA), data: toBase64(imageDataA) } },
          { text: 'Image B:' },
          { inline_data: { mime_type: getMime(imageDataB), data: toBase64(imageDataB) } },
          { text: `Compare the art styles of Image A and Image B. They depict the same scene but were generated by different AI models.

Evaluate their visual style similarity (ignore content differences — focus only on artistic rendering style).

Return a JSON object:
{
  "similarity": <0-100 overall score>,
  "dimensions": {
    "medium": <0-100>,
    "colorPalette": <0-100>,
    "lineWork": <0-100>,
    "shading": <0-100>,
    "texture": <0-100>,
    "aesthetic": <0-100>
  },
  "summary": "<2-3 sentences: what matches, what differs, and specific suggestions to make them more similar>"
}

Return ONLY the JSON, no markdown fences.` }
        ]
      }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.2 }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini style comparison failed: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('No style comparison returned');

  // Parse JSON from response (handle markdown fences)
  let parsed = getStoryHelpers().extractJsonFromText(text);
  if (!parsed || typeof parsed.similarity !== 'number') {
    // Fallback: try stripping fences manually and parsing
    const stripped = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      log.error(`🎨 [STYLE COMPARE] Failed to parse response (${text.length} chars): ${text.substring(0, 500)}`);
      throw new Error(`Invalid style comparison response — see server logs`);
    }
  }

  log.info(`🎨 [STYLE COMPARE] Similarity: ${parsed.similarity}/100 — ${parsed.summary?.substring(0, 100)}`);
  return parsed;
}

module.exports = {
  // Utility functions
  hashImageData,
  generateImageCacheKey,
  cropImageForSequential,
  compressImageToJPEG,

  // Core image functions
  validateEmptyScene,
  evaluateImageQuality,
  evaluateThreeStage,
  callGeminiAPIForImage,
  editImageWithPrompt,
  generateImageWithQualityRetry,
  rewriteBlockedScene,
  buildVisualBibleGrid,
  buildEmptySceneVbGrid,

  // Separated evaluation pipeline functions (new architecture)
  generateImageOnly,
  generateWithIterativePlacement,
  applyStyleTransfer,
  analyzeImageStyle,
  compareImageStyles,
  evaluateImageBatch,

  // Unified repair pipeline (the only active repair pipeline)
  selectBestVersion,
  runUnifiedRepairPipeline,
  chooseRepairStrategy,
  inpaintPage,

  // Active repair primitives
  classifyIssues,
  iteratePageCore,
  iteratePage,
  repairCharacterMismatch,

  // Cache management
  clearImageCache,
  deleteFromImageCache,
  getImageCacheSize,
  getCacheStats,
  logCacheSummary,
  resetCacheStats,

  // Mask + region helpers (used by inpaint paths)
  createCombinedMask,
  blackoutIssueRegions,
  calculateMaskCoverage,
  getGridBasedRepair,  // Lazy-loaded grid-based repair module

  // Two-stage bounding box detection
  detectAllBoundingBoxes,
  detectSubRegion,  // Sub-region detection for targeted repairs (shoes, shirt, hands, etc.)
  createBboxOverlayImage,  // Create overlay image with boxes drawn
  FIGURE_COLORS,  // Color palette for bbox overlay (shared with prompt building)
  callGrokVisionAPI,  // Grok vision API for bbox/quality eval
  GEMINI_SAFETY_SETTINGS,  // Safety settings for Gemini API calls
  detectBoundingBoxesForIssue,  // deprecated, use detectAllBoundingBoxes
  enrichWithBoundingBoxes,

  // Final consistency checks
  evaluateConsistencyAcrossImages,
  runFinalConsistencyChecks,

  // Incremental consistency checks
  evaluateIncrementalConsistency,
  mergeEvaluationIssues,
  logDryRunReport,
  INCREMENTAL_CONSISTENCY_DEFAULTS,

  // Reference sheet generation for secondary elements
  splitGridIntoReferences,
  buildReferenceSheetPrompt,
  generateReferenceSheet,

  // Issue collection
  collectAllIssuesForPage,

  // Standalone visual inventory (for evaluate-single endpoint)
  runVisualInventory,

  // Sanitization helpers
  sanitizeForGemini,

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD,
  MAX_MASK_COVERAGE_PERCENT
};
