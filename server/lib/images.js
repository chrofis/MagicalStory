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
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, IMAGE_MODELS } = require('../config/models');
const { createDiffImage } = require('./repairVerification');
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
  log.info(`🧠 [${logPrefix}] Thinking (${thinkingText.length} chars): ${thinkingText.substring(0, 300)}${thinkingText.length > 300 ? '...' : ''}`);
  log.verbose(`🧠 [${logPrefix}] Full thinking:\n${thinkingText}`);
  return thinkingText;
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
    return this.get(key) !== undefined;
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
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || 50;

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
function generateImageCacheKey(prompt, characterPhotos = [], sequentialMarker = null, pageNumber = null) {
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
  const combined = `${prompt}|${photoHashes}|${sequentialMarker || ''}|${pageNumber !== null ? `page${pageNumber}` : ''}`;
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
async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null, pageContext = '', storyText = null, sceneHint = null) {
  try {
    // Guard against undefined/invalid imageData
    if (!imageData || typeof imageData !== 'string') {
      log.warn(`⚠️ [QUALITY] Invalid imageData passed to evaluateImageQuality: ${typeof imageData}`);
      return null;
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

    // Extract base64 and mime type for generated image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Select evaluation prompt based on type
    // Cover images use text-focused evaluation (automatic 0 for text errors)
    // Scene images use standard character/style evaluation
    let evaluationTemplate;
    if (evaluationType === 'cover' && PROMPT_TEMPLATES.coverImageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.coverImageEvaluation;
      log.verbose('⭐ [QUALITY] Using COVER evaluation (text-focused)');
    } else if (PROMPT_TEMPLATES.imageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      log.verbose('⭐ [QUALITY] Using SCENE evaluation (standard)');
    } else {
      evaluationTemplate = null;
    }

    // Determine model to use (parameter override > config default > fallback)
    const modelId = qualityModelOverride || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';

    // Sanitize prompt for Gemini 2.5 to avoid content filter triggers
    // Remove age references and detailed physical descriptions while keeping scene context
    const sanitizePromptFor25 = (prompt) => {
      if (!prompt) return prompt;
      return prompt
        // Remove age references like "8-year-old", "6 years old", "young child"
        .replace(/\b\d{1,2}[-\s]?year[-\s]?old\b/gi, '')
        .replace(/\b(young|little|small)\s+(child|boy|girl|kid)\b/gi, 'character')
        .replace(/\bage[sd]?\s*\d+\b/gi, '')
        // Remove body type descriptions
        .replace(/\b(slim|thin|chubby|petite|small-framed|athletic)\s+(body|build|figure)\b/gi, '')
        // Clean up extra whitespace
        .replace(/\s{2,}/g, ' ')
        .trim();
    };

    // Pre-sanitize for 2.5 models to reduce content blocking on first attempt
    const promptForEval = modelId.includes('2.5') ? sanitizePromptFor25(originalPrompt) : originalPrompt;

    const evaluationPrompt = evaluationTemplate
      ? fillTemplate(evaluationTemplate, { ORIGINAL_PROMPT: promptForEval })
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
            const compressed = await compressImageToJPEG(photoUrl, 80, 512); // 80% quality, max 512px
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
      log.verbose(`⭐ [QUALITY] Added ${addedCount} reference images (${cacheHits} cached, ${addedCount - cacheHits} compressed)`);
    }

    // Add evaluation prompt text
    parts.push({ text: evaluationPrompt });

    // Log if using model override (modelId already defined at top of function)
    if (qualityModelOverride) {
      log.debug(`🔧 [QUALITY] Using model override: ${modelId}`);
    }

    // Helper function to call the API with retry for socket errors
    const callQualityAPI = async (model) => {
      return withRetry(async () => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              maxOutputTokens: 16000,  // High limit to accommodate Gemini 2.5 thinking tokens
              temperature: 0.3
            },
            safetySettings: [
              { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
              { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
            ]
          })
        });
      }, { maxRetries: 2, baseDelay: 2000 });
    };

    // Helper function to check if response indicates blocked content
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
      log.verbose(`📊 [QUALITY] Token usage - input: ${qualityInputTokens.toLocaleString()}, output: ${qualityOutputTokens.toLocaleString()}${thinkingInfo}`);
    }

    // Fallback: If content was blocked and we're using 2.5, try sanitized prompt first
    if (isBlockedResponse(data) && modelId.includes('2.5')) {
      const blockReason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'UNKNOWN';
      const pageLabel = pageContext ? `[${pageContext}] ` : '';
      log.warn(`⚠️  [QUALITY] ${pageLabel}Content blocked by ${modelId} (${blockReason}), retrying with sanitized prompt...`);

      // Create a SANITIZED prompt that removes potentially triggering content:
      // - No detailed physical descriptions (age, body type, etc.)
      // Simplified prompt to avoid content filters
      const sanitizedPrompt = `Illustration QA: Evaluate artwork against reference images.

Check: rendering quality, character consistency, AI artifacts (hands, objects).

Return JSON only:
{
  "figures": [{"id": 1, "position": "...", "hair": "...", "clothing": "..."}],
  "matches": [{"figure": 1, "reference": "...", "confidence": 0.85, "face_bbox": [0.1,0.2,0.3,0.4], "issues": []}],
  "rendering": {"hands": [{"figure": 1, "fingers": 5, "ok": true}], "issues": []},
  "scene": {"all_present": true, "missing": []},
  "score": 7,
  "verdict": "PASS",
  "issues_summary": "brief summary",
  "fixable_issues": [{"description": "visual description", "severity": "MAJOR", "type": "hand", "fix": "what to render"}]
}

Score 0-10. PASS=5+, SOFT_FAIL=3-4, HARD_FAIL=0-2`;

      // Rebuild parts with sanitized prompt (keep images, replace text)
      const sanitizedParts = parts.slice(0, -1); // Remove original prompt
      sanitizedParts.push({ text: sanitizedPrompt });

      // Retry with 2.5 and sanitized prompt
      const retryUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      const retryResponse = await fetch(retryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: sanitizedParts }],
          generationConfig: {
            maxOutputTokens: 16000,
            temperature: 0.3
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
        })
      });

      if (retryResponse.ok) {
        const retryData = await retryResponse.json();
        if (!isBlockedResponse(retryData)) {
          log.info(`✅ [QUALITY] ${pageLabel}Sanitized prompt retry succeeded with ${modelId}`);
          data = retryData;
        } else {
          // Still blocked, now fall back to 2.0
          log.warn(`⚠️  [QUALITY] ${pageLabel}Sanitized prompt still blocked, falling back to gemini-2.0-flash-lite...`);
          modelId = 'gemini-2.0-flash-lite';
          response = await callQualityAPI(modelId);
          if (!response.ok) {
            const error = await response.text();
            log.error('❌ [QUALITY] Fallback model also failed:', error);
            return null;
          }
          data = await response.json();
        }
      } else {
        // HTTP error on retry, fall back to 2.0
        log.warn(`⚠️  [QUALITY] ${pageLabel}Sanitized prompt HTTP error, falling back to gemini-2.0-flash-lite...`);
        modelId = 'gemini-2.0-flash-lite';
        response = await callQualityAPI(modelId);
        if (!response.ok) {
          const error = await response.text();
          log.error('❌ [QUALITY] Fallback model also failed:', error);
          return null;
        }
        data = await response.json();
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
              log.debug(`⭐ [QUALITY] Could not parse FIX_TARGET: ${line}`);
            }
          }
        }
      }
      if (fixTargets.length > 0) {
        log.info(`⭐ [QUALITY] Parsed ${fixTargets.length} fix targets with bounding boxes`);
      }
      return fixTargets;
    };

    const fixTargets = parseFixTargets(responseText);

    // Try to parse as JSON (new format with 0-10 scale)
    let parsedJson = null;
    try {
      // Extract JSON from response (may have markdown code blocks)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedJson = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      log.debug(`⭐ [QUALITY] Response is not JSON, trying legacy format`);
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

      log.info(`⭐ [QUALITY] Score: ${rawScore}/10 (${score}/100), Verdict: ${verdict}`);
      const hasRealIssues = issuesSummary && issuesSummary !== 'none' && issuesSummary.toLowerCase() !== 'none';
      if (hasRealIssues) {
        log.info(`⭐ [QUALITY] Issues: ${issuesSummary}`);
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
            fix: i.fix || `Fix: ${i.description}`
          }));
        if (fixableIssues.length > 0) {
          log.info(`⭐ [QUALITY] Parsed ${fixableIssues.length} fixable issues (two-stage detection)`);
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
          log.info(`⭐ [QUALITY] Parsed ${jsonFixTargets.length} fix targets from JSON (legacy format)`);
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
      const figures = parsedJson.figures || [];
      const matches = parsedJson.matches || [];
      if (matches.length > 0) {
        log.info(`⭐ [QUALITY] Character matches: ${matches.map(m => `Figure ${m.figure} → ${m.reference} (${Math.round(m.confidence * 100)}%)`).join(', ')}`);
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

      // Aggregate usage from quality + semantic evaluations
      const semanticUsage = semanticResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (semanticUsage.input_tokens || 0),
        output_tokens: qualityOutputTokens + (semanticUsage.output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0
      };

      return {
        score: finalScore,                    // Combined final score
        qualityScore: score,                  // Visual quality score only
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        rawScore, // Original 0-10 score (visual only)
        verdict,
        reasoning,
        issuesSummary: combinedIssuesSummary,
        textIssue,
        fixTargets: jsonFixTargets,       // Legacy format with bboxes (backwards compat)
        fixableIssues: fixableIssues,     // New format without bboxes (for two-stage detection)
        figures,                          // Detected figures with descriptions
        matches,                          // Character name → figure mapping with face_bbox
        semanticResult,                   // Full semantic evaluation result (if available)
        usage: totalUsage,
        modelId: modelId
      };
    }

    // Helper to merge semantic results into quality result
    const mergeSemanticResult = async (qualityScore, reasoning) => {
      let semanticResult = null;
      let finalScore = qualityScore;
      let issuesSummary = '';

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

      // Aggregate usage
      const semanticUsage = semanticResult?.usage || {};
      const totalUsage = {
        input_tokens: qualityInputTokens + (semanticUsage.input_tokens || 0),
        output_tokens: qualityOutputTokens + (semanticUsage.output_tokens || 0),
        thinking_tokens: qualityThinkingTokens,
        semantic_input_tokens: semanticUsage.input_tokens || 0,
        semantic_output_tokens: semanticUsage.output_tokens || 0
      };

      return {
        score: finalScore,                    // Combined final score
        qualityScore: qualityScore,           // Visual quality score only
        semanticScore: semanticResult?.score ?? null,  // Semantic fidelity score (0-100)
        reasoning,
        issuesSummary,
        fixTargets,
        semanticResult,
        usage: totalUsage,
        modelId: modelId
      };
    };

    // Parse "Score: X/10" format (new simplified format)
    const score10Match = responseText.match(/Score:\s*(\d+)\/10\b/i);
    if (score10Match) {
      const rawScore = parseInt(score10Match[1]);
      const qualityScore = rawScore * 10; // Convert 0-10 to 0-100 for compatibility
      log.verbose(`⭐ [QUALITY] Image quality score: ${rawScore}/10 (${qualityScore}/100)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Parse legacy format "Score: XX/100"
    const scoreMatch = responseText.match(/Score:\s*(\d+)\/100/i);
    if (scoreMatch) {
      const qualityScore = parseInt(scoreMatch[1]);
      log.verbose(`⭐ [QUALITY] Image quality score: ${qualityScore}/100 (legacy format)`);
      return mergeSemanticResult(qualityScore, responseText);
    }

    // Fallback: Try parsing just a number (0-100)
    const numericScore = parseFloat(responseText);
    if (!isNaN(numericScore) && numericScore >= 0 && numericScore <= 100) {
      log.verbose(`⭐ [QUALITY] Image quality score: ${numericScore}/100 (numeric format)`);
      return mergeSemanticResult(numericScore, responseText);
    }

    log.warn(`⚠️  [QUALITY] Could not parse score from response (finishReason=${finishReason}, ${responseText.length} chars):`, responseText.substring(0, 200));
    // Await semantic to prevent memory leak
    if (semanticPromise) await semanticPromise.catch(() => {});
    return null;
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
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
  const { expectedCharacters = [], expectedObjects = [] } = options;

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

    // Use same model as quality evaluation for consistent spatial reasoning
    const modelId = MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await withRetry(async () => {
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 16000,  // Doubled to avoid MAX_TOKENS truncation in complex scenes
            temperature: 0.1,  // Low temperature for precise detection
            responseMimeType: 'application/json'
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
        })
      });
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!response.ok) {
      const error = await response.text();
      log.error(`❌ [BBOX-DETECT] Gemini API error: ${error.substring(0, 200)}`);
      return null;
    }

    const data = await response.json();

    // Log token usage
    const inputTokens = data.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    log.debug(`📊 [BBOX-DETECT] Token usage - input: ${inputTokens}, output: ${outputTokens}`);

    // Check finish reason for truncation or safety blocks
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`⚠️  [BBOX-DETECT] Gemini finish reason: ${finishReason}`);
    }

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      log.warn('⚠️  [BBOX-DETECT] No response from Gemini');
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse JSON response
    let parsedResult;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        // Try to fix common JSON issues from LLM output
        let jsonText = jsonMatch[0];
        // Remove trailing commas before ] or }
        jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
        // Remove any markdown code fence artifacts
        jsonText = jsonText.replace(/```json?\s*/g, '').replace(/```\s*/g, '');
        parsedResult = JSON.parse(jsonText);
      }
    } catch (e) {
      log.warn(`⚠️  [BBOX-DETECT] Failed to parse response: ${e.message}`);
      // Log more context around the error position
      const errorMatch = e.message.match(/position (\d+)/);
      if (errorMatch) {
        const pos = parseInt(errorMatch[1]);
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const context = jsonMatch[0].substring(Math.max(0, pos - 50), pos + 50);
          log.warn(`⚠️  [BBOX-DETECT] JSON context around error: ...${context}...`);
        }
      }
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
      log.warn(`⚠️  [BBOX-DETECT] No JSON found in response: ${responseText.substring(0, 100)}`);
      return null;
    }

    // Normalize coordinates from 0-1000 to 0.0-1.0
    const normalizeBox = (box) => {
      if (!box || !Array.isArray(box) || box.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = box;
      // Handle both 0-1000 format (Gemini native) and 0-1 format (already normalized)
      const scale = (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1) ? 1000 : 1;
      return [ymin / scale, xmin / scale, ymax / scale, xmax / scale];
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

    // Log character identifications
    const identifiedChars = figures.filter(f => f.name !== 'UNKNOWN');
    const unknownFigures = figures.filter(f => f.name === 'UNKNOWN');
    if (identifiedChars.length > 0) {
      log.info(`📦 [BBOX-DETECT] Identified ${identifiedChars.length} characters: ${identifiedChars.map(f => `${f.name} (${f.confidence})`).join(', ')}`);
    }
    if (unknownFigures.length > 0) {
      log.info(`📦 [BBOX-DETECT] ${unknownFigures.length} UNKNOWN figures: ${unknownFigures.map(f => f.label).join(', ')}`);
    }
    log.info(`📦 [BBOX-DETECT] Detected ${figures.length} figures, ${objects.length} objects`);

    // Compute found/missing objects from detection results
    const foundObjects = objects.filter(o => o.found).map(o => o.name);
    const missingObjects = objects.filter(o => !o.found).map(o => o.name);

    return {
      figures,
      objects,
      // Include expected inputs for dev mode display
      expectedCharacters,
      expectedObjects,
      foundObjects,
      missingObjects,
      unknownFigures: figures.filter(f => f.name === 'UNKNOWN').length,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      // Include raw prompt and response for dev mode debugging
      rawPrompt: prompt,
      rawResponse: responseText
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

    // Use same model as quality evaluation for consistent spatial reasoning
    const modelId = MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';
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
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
        })
      });
    }, { maxRetries: 2, baseDelay: 1000 });

    if (!response.ok) {
      const error = await response.text();
      log.error(`❌ [SUB-REGION] Gemini API error: ${error.substring(0, 200)}`);
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
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        let jsonText = jsonMatch[0];
        jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
        parsedResult = JSON.parse(jsonText);
      }
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
      const scale = (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1) ? 1000 : 1;
      normalizedBox = [ymin / scale, xmin / scale, ymax / scale, xmax / scale];
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

  // First, add characters from characterDescriptions (which have age/gender info)
  for (const [name, desc] of Object.entries(characterDescriptions || {})) {
    const position = expectedPositions?.[name] || expectedPositions?.[name.charAt(0).toUpperCase() + name.slice(1)] || '';
    // Use clothing from characterClothing map, or from parsed description (covers), or empty
    const clothing = getClothing(name) || desc.clothing || '';
    const descParts = [];
    if (desc.genderTerm) descParts.push(desc.genderTerm);
    if (desc.age) descParts.push(`${desc.age} years old`);
    if (desc.isChild === true) descParts.push('child');
    else if (desc.isChild === false) descParts.push('adult');
    if (clothing) descParts.push(clothing);
    chars.push({
      name,
      description: descParts.join(', ') || 'character',
      position
    });
    addedNames.add(name.toLowerCase());
  }

  // Then, add any characters from expectedPositions that weren't in characterDescriptions
  // These are characters that appear in the scene but didn't have parsed descriptions
  for (const [name, position] of Object.entries(expectedPositions || {})) {
    if (!addedNames.has(name.toLowerCase())) {
      const clothing = getClothing(name);
      chars.push({
        name,
        description: clothing || 'character',  // Use clothing if available, else fallback
        position
      });
      addedNames.add(name.toLowerCase());
      log.debug(`📦 [BBOX-BUILD] Added character "${name}" from expectedPositions (clothing: ${clothing || 'none'})`);
    }
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

    // Build SVG overlay with boxes
    const svgParts = [`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`];

    // Confidence level to color mapping
    const confidenceColors = {
      high: '#00cc00',    // Green for high confidence
      medium: '#ffaa00',  // Yellow/amber for medium confidence
      low: '#ff6600'      // Orange for low confidence
    };

    // Draw figure boxes - now uses name directly from detection
    for (let i = 0; i < (bboxDetection.figures || []).length; i++) {
      const fig = bboxDetection.figures[i];

      // Body box - color based on identification confidence
      if (fig.bodyBox) {
        const [ymin, xmin, ymax, xmax] = fig.bodyBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);

        // Character name comes directly from figure.name (AI identified)
        const isIdentified = fig.name && fig.name !== 'UNKNOWN';
        const confidence = fig.confidence || 'low';
        const boxColor = isIdentified ? (confidenceColors[confidence] || '#aa00ff') : '#888888';  // Gray for UNKNOWN
        const labelBgColor = boxColor;

        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${boxColor}" stroke-width="3"/>`);

        // Label - show character name + confidence, or "UNKNOWN" + visual label
        let label;
        if (isIdentified) {
          const confIcon = confidence === 'high' ? '★' : confidence === 'medium' ? '◆' : '○';
          label = `${confIcon} ${fig.name}`;
        } else {
          label = `? ${fig.label ? fig.label.substring(0, 25) : `Figure ${i + 1}`}`;
        }
        const labelWidth = Math.min(label.length * 8 + 10, 200);
        svgParts.push(`<rect x="${x}" y="${Math.max(0, y - 22)}" width="${labelWidth}" height="22" fill="${labelBgColor}" opacity="0.9" rx="3"/>`);
        svgParts.push(`<text x="${x + 5}" y="${Math.max(16, y - 5)}" font-family="Arial" font-size="13" font-weight="bold" fill="white">${escapeXml(label)}</text>`);
      }

      // Face box - blue dashed
      if (fig.faceBox) {
        const [ymin, xmin, ymax, xmax] = fig.faceBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);
        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#0088ff" stroke-width="2" stroke-dasharray="5,3"/>`);
      }
    }

    // Draw object boxes - now uses found status directly
    for (let i = 0; i < (bboxDetection.objects || []).length; i++) {
      const obj = bboxDetection.objects[i];
      if (obj.bodyBox) {
        const [ymin, xmin, ymax, xmax] = obj.bodyBox;
        const x = Math.round(xmin * width);
        const y = Math.round(ymin * height);
        const w = Math.round((xmax - xmin) * width);
        const h = Math.round((ymax - ymin) * height);

        // Object was found (has bbox) so color indicates it was expected
        const wasExpected = obj.name && obj.found !== false;
        const boxColor = wasExpected ? '#00cccc' : '#ff8800';  // Cyan if expected & found, orange otherwise
        const labelBgColor = boxColor;

        svgParts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${boxColor}" stroke-width="2"/>`);

        // Label - show expected object name if matched
        const label = wasExpected ? `✓ ${obj.name}` : (obj.label ? obj.label.substring(0, 25) : `Object ${i + 1}`);
        const labelWidth = Math.min(label.length * 7 + 10, 180);
        svgParts.push(`<rect x="${x}" y="${y + h}" width="${labelWidth}" height="20" fill="${labelBgColor}" opacity="0.9" rx="3"/>`);
        svgParts.push(`<text x="${x + 5}" y="${y + h + 14}" font-family="Arial" font-size="12" font-weight="bold" fill="white">${escapeXml(label)}</text>`);
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
    const objCount = bboxDetection.objects?.length || 0;
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
async function enrichWithBoundingBoxes(imageData, fixableIssues, qualityMatches = [], objectMatches = [], expectedPositions = {}, expectedObjects = [], characterDescriptions = {}, characterClothing = {}) {
  // Build expected characters for bbox detection (AI will identify by name)
  const expectedCharacters = buildExpectedCharactersForBbox(characterDescriptions, expectedPositions, characterClothing);

  log.info(`📦 [BBOX-ENRICH] Detecting figures/objects with ${expectedCharacters.length} expected characters, ${expectedObjects.length} expected objects...`);

  // Call bbox detection WITH character/object context - AI identifies directly by name
  const allDetections = await detectAllBoundingBoxes(imageData, {
    expectedCharacters,
    expectedObjects
  });

  if (!allDetections) {
    log.warn(`⚠️  [BBOX-ENRICH] Detection failed, no bounding boxes available`);
    return { targets: [], detectionHistory: null };
  }

  log.info(`📦 [BBOX-ENRICH] Found ${allDetections.figures.length} figures, ${allDetections.objects.length} objects`);

  // Direct mapping - AI already labeled figures with character names
  const charToDetectionFigure = {};
  const unknownFigures = [];
  for (const figure of allDetections.figures) {
    if (figure.name && figure.name !== 'UNKNOWN') {
      charToDetectionFigure[figure.name.toLowerCase()] = figure;
      log.debug(`📦 [BBOX-ENRICH] Character identified: "${figure.name}" (${figure.confidence}) → "${figure.label}"`);
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
        log.warn(`⚠️ [BBOX-ENRICH] Position mismatch: "${charName}" expected at ${expectedLCR} (${expectedPos}) but detected at ${figure.position}`);
      }
    }
  }

  // Detect missing characters (expected in scene but not identified by AI)
  const missingCharacters = Object.keys(expectedPositions)
    .filter(name => !foundCharacters.has(name.toLowerCase()));
  if (missingCharacters.length > 0) {
    log.warn(`⚠️ [BBOX-ENRICH] Missing characters (expected but not identified): ${missingCharacters.join(', ')}`);
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

  for (const issue of fixableIssues) {
    const issueDesc = (issue.description || '').toLowerCase();
    const issueFix = (issue.fix || '').toLowerCase();
    const issueKeywords = extractKeywords(issueDesc + ' ' + issueFix);

    // Check if issue mentions a character name we know about (now directly identified)
    const mentionedChars = extractCharacterNames(issueDesc + ' ' + issueFix);

    let bestMatch = null;
    let matchedCharacter = null;

    // DIRECT CHARACTER MATCH (AI already identified by name)
    if (mentionedChars.length > 0) {
      for (const charName of mentionedChars) {
        const figure = charToDetectionFigure[charName];
        if (figure) {
          bestMatch = { ...figure, elementType: 'figure' };
          matchedCharacter = charName;
          log.debug(`📦 [BBOX-ENRICH] Issue mentions "${charName}" → direct match to "${figure.label}"`);
          break;
        }
      }
    }

    // Fallback: keyword matching or type-based selection
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
      } else if (issue.type === 'object') {
        // For object issues, prefer found expected objects or largest object
        const foundObjs = allDetections.objects.filter(o => o.found !== false);
        if (foundObjs.length > 0) {
          bestMatch = { ...foundObjs[0], elementType: 'object', faceBox: null };
        } else if (allDetections.objects.length > 0) {
          bestMatch = allDetections.objects.reduce((largest, obj) => {
            const getArea = (box) => box ? (box[2] - box[0]) * (box[3] - box[1]) : 0;
            return getArea(obj.bodyBox) > getArea(largest?.bodyBox) ? obj : largest;
          }, allDetections.objects[0]);
          bestMatch = { ...bestMatch, elementType: 'object', faceBox: null };
        }
      } else {
        // Generic fallback: largest element in scene
        const allWithArea = allElements.map(e => ({
          element: e,
          area: e.bodyBox ? (e.bodyBox[2] - e.bodyBox[0]) * (e.bodyBox[3] - e.bodyBox[1]) : 0
        }));
        allWithArea.sort((a, b) => b.area - a.area);
        bestMatch = allWithArea[0]?.element;
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
      log.debug(`📦 [BBOX-ENRICH] Matched: "${issue.description.substring(0, 30)}..." → "${bestMatch.label}" (${matchedCharacter ? 'character' : 'fallback'})`);
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
async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, imageModelOverride = null, qualityModelOverride = null, pageContext = '', imageBackendOverride = null, landmarkPhotos = [], sceneCharacterCount = 0, visualBibleGrid = null) {
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
        qualityModelOverride
      );

      const finalResult = {
        imageData: result.imageData,
        modelId: result.modelId,
        score: qualityResult.score,
        reasoning: qualityResult.reasoning,
        detectedProblems: qualityResult.detectedProblems || [],
        figures: qualityResult.figures || [],
        matches: qualityResult.matches || [],
        objectMatches: qualityResult.object_matches || [],
        fixTargets: qualityResult.fixTargets || [],
        fixableIssues: qualityResult.fixableIssues || [],
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
  const modelId = imageModelOverride || defaultModel;
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
        qualityModelOverride
      );

      return {
        imageData: result.imageData,
        modelId: result.modelId,
        score: qualityResult.score,
        numericScore: qualityResult.numericScore,
        reasoning: qualityResult.reasoning,
        verdict: qualityResult.verdict,
        fixTargets: qualityResult.fixTargets,
        qualityModelId: qualityResult.qualityModelId,
        imageUsage: result.usage,
        qualityUsage: qualityResult.usage
      };
    } catch (runwareError) {
      log.error('❌ [IMAGE GEN] Runware generation failed:', runwareError.message);
      throw runwareError;
    }
  }

  const systemInstruction = getImageSystemInstruction();
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.8,
      ...(modelSupportsThinking(modelId) && { includeThoughts: true }),
      imageConfig: {
        aspectRatio: "1:1"
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN] Calling Gemini API with prompt (${prompt.length} chars), scene: ${prompt.substring(0, 80).replace(/\n/g, ' ')}...`);
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: 1:1, Temperature: 0.8, systemInstruction: ${!!systemInstruction}`);

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
        log.debug(`⭐ [QUALITY] Evaluating image quality (${evaluationType})...${qualityModelOverride ? ` [model: ${qualityModelOverride}]` : ''}`);
        const qualityResult = await evaluateImageQuality(compressedImageData, prompt, characterPhotos, evaluationType, qualityModelOverride, pageContext);

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
    onImageReady = null
  } = options;

  // Check cache first (include previousImage presence and page number in cache key)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null, pageNumber);

  // For generateImageOnly, we use a separate cache namespace to avoid conflicts with evaluated images
  const genOnlyCacheKey = `genonly_${cacheKey}`;

  if (imageCache.has(genOnlyCacheKey)) {
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

      imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (runwareError) {
      log.error(`❌ [IMAGE GEN-ONLY] Runware failed, falling back to Gemini: ${runwareError.message}`);
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
  const modelId = imageModelOverride || defaultModel;

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
        modelId: result.modelId,
        usage: result.usage
      };

      imageCache.set(genOnlyCacheKey, finalResult);
      return finalResult;
    } catch (runwareError) {
      log.error('❌ [IMAGE GEN-ONLY] Runware generation failed:', runwareError.message);
      throw runwareError;
    }
  }

  // Gemini API call
  const systemInstruction = getImageSystemInstruction();
  const requestBody = {
    ...(systemInstruction && { systemInstruction }),
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.8,
      ...(modelSupportsThinking(modelId) && { includeThoughts: true }),
      imageConfig: {
        aspectRatio: "1:1"
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN-ONLY] Calling Gemini API with prompt (${prompt.length} chars), systemInstruction: ${!!systemInstruction}`);

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
    log.error('❌ [IMAGE GEN-ONLY] No candidates in response');
    throw new Error('No image generated - no candidates in response');
  }

  // Extract image data
  const candidate = data.candidates[0];

  // Extract thinking text from response
  const thinkingText = extractThinkingFromParts(candidate.content?.parts, 'IMAGE GEN-ONLY');

  if (candidate.content && candidate.content.parts) {
    for (const part of candidate.content.parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const pngImageData = `data:image/png;base64,${inlineData.data}`;

        // Compress PNG to JPEG
        const compressedImageData = await compressImageToJPEG(pngImageData);

        // Call onImageReady callback immediately
        if (onImageReady) {
          try {
            await onImageReady(compressedImageData, modelId);
          } catch (callbackError) {
            log.error('⚠️ [IMAGE GEN-ONLY] onImageReady callback error:', callbackError.message);
          }
        }

        const result = {
          imageData: compressedImageData,
          modelId,
          thinkingText,
          usage
        };

        imageCache.set(genOnlyCacheKey, result);
        log.info(`✅ [IMAGE GEN-ONLY] Image generated successfully`);
        return result;
      }
    }
  } else {
    const reason = candidate.finishReason || 'unknown';
    const message = candidate.finishMessage || 'no message';
    log.error(`❌ [IMAGE GEN-ONLY] Image blocked: reason=${reason}`);
    throw new Error(`Image blocked by API: reason=${reason}, message=${message}`);
  }

  log.error('❌ [IMAGE GEN-ONLY] No image data found in response');
  throw new Error('No image data in response');
}

// =============================================================================
// SEPARATED EVALUATION PIPELINE FUNCTIONS
// These functions support the new architecture:
// 1. Generate ALL images first (generateImageOnly or generateAllImages)
// 2. Evaluate ALL images in parallel (evaluateImageBatch)
// 3. Build a repair plan based on all results (buildRepairPlan)
// 4. Execute repairs/regenerations (executeRepairPlan)
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
    concurrency = 10,
    qualityModelOverride = null
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
      const qualityResult = await evaluateImageQuality(
        img.imageData,
        img.prompt || '',
        img.characterPhotos || [],
        'scene',
        qualityModelOverride,
        pageLabel,
        img.pageText || null,  // Story text for semantic fidelity check
        img.sceneHint || null  // Scene hint for semantic evaluation
      );

      // Extract scene metadata for character positions and clothing
      const sceneMetadata = img.sceneDescription
        ? getStoryHelpers().extractSceneMetadata(img.sceneDescription)
        : null;
      const expectedCharacterPositions = sceneMetadata?.characterPositions || {};
      const expectedCharacterClothing = sceneMetadata?.characterClothing || {};
      const expectedObjects = sceneMetadata?.objects || [];

      // Parse character descriptions from prompt
      const characterDescriptions = img.prompt
        ? getStoryHelpers().parseCharacterDescriptions(img.prompt)
        : {};

      // Parse Visual Bible objects from prompt
      const vbObjects = parseVisualBibleObjects(img.prompt || '');
      const allExpectedObjects = [...expectedObjects, ...vbObjects.filter(o => !expectedObjects.includes(o))];

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
          expectedCharacterClothing
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
 * Classify issues from an evaluation into repair categories
 * Used by buildRepairPlan to determine the best repair method for each page
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

    if (match.age_match === false) {
      issues.push('age mismatch');
    }
    if (match.height_order_ok === false) {
      issues.push('height order wrong');
    }
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

/**
 * Build a repair plan based on evaluation results
 * Analyzes all page evaluations and consistency reports to decide which pages need:
 * - Regeneration (score too low or generation failed)
 * - Repair (fixable issues detected)
 * - Keeping (score good enough)
 *
 * @param {Array<Object>} pageEvaluations - Evaluation results from evaluateImageBatch
 * @param {Object} options - Plan options
 * @param {Object|null} options.consistencyReport - Results from runFinalConsistencyChecks
 * @param {Object|null} options.entityReport - Results from runEntityConsistencyChecks
 * @param {number} options.regenerateThreshold - Score below which to regenerate (default: 30)
 * @param {number} options.repairThreshold - Score below which to repair if fixable (default: 70)
 * @param {number} options.keepThreshold - Score at or above which to keep (default: 50)
 * @param {boolean} options.useCategorizedRepairs - Use new categorized repair system (default: false)
 * @returns {Object} Repair plan with pagesToRegenerate, pagesToRepair, pagesToKeep
 */
function buildRepairPlan(pageEvaluations, options = {}) {
  const {
    consistencyReport = null,
    entityReport = null,
    regenerateThreshold = 30,
    repairThreshold = 70,
    keepThreshold = 50,
    useCategorizedRepairs = false
  } = options;

  // New categorized repair plan structure
  if (useCategorizedRepairs) {
    return buildCategorizedRepairPlan(pageEvaluations, options);
  }

  // Legacy plan structure (backwards compatible)
  const plan = {
    pagesToRegenerate: [],
    pagesToRepair: [],
    pagesToKeep: [],
    reasoning: {},
    stats: {
      totalPages: pageEvaluations.length,
      evaluated: 0,
      avgScore: 0
    }
  };

  // Build a map of consistency issues by page
  const consistencyIssuesByPage = new Map();
  if (consistencyReport?.issues) {
    for (const issue of consistencyReport.issues) {
      if (issue.pageNumber) {
        if (!consistencyIssuesByPage.has(issue.pageNumber)) {
          consistencyIssuesByPage.set(issue.pageNumber, []);
        }
        consistencyIssuesByPage.get(issue.pageNumber).push(issue);
      }
    }
  }

  // Build a map of entity issues by page
  const entityIssuesByPage = new Map();
  if (entityReport?.issues) {
    for (const issue of entityReport.issues) {
      if (issue.pageNumber) {
        if (!entityIssuesByPage.has(issue.pageNumber)) {
          entityIssuesByPage.set(issue.pageNumber, []);
        }
        entityIssuesByPage.get(issue.pageNumber).push(issue);
      }
    }
  }

  let totalScore = 0;
  let scoredCount = 0;

  for (const evaluation of pageEvaluations) {
    const pageNum = evaluation.pageNumber;
    // Use combined final score (includes semantic penalties), fallback to qualityScore for backwards compat
    const score = evaluation.score ?? evaluation.qualityScore;
    // Warn if fallback is used despite semantic evaluation running (indicates bug)
    if (evaluation.score === null && evaluation.qualityScore !== null && evaluation.semanticScore !== null) {
      log.warn(`⚠️ [REPAIR PLAN] Page ${pageNum}: Missing combined score despite semantic evaluation, using qualityScore fallback`);
    }
    const hasFixable = (evaluation.enrichedFixTargets?.length > 0) ||
                       (evaluation.fixableIssues?.length > 0);
    const evaluationFailed = !evaluation.evaluated;
    const consistencyIssues = consistencyIssuesByPage.get(pageNum) || [];
    const entityIssues = entityIssuesByPage.get(pageNum) || [];

    // Track stats
    if (score !== null && score !== undefined) {
      totalScore += score;
      scoredCount++;
      plan.stats.evaluated++;
    }

    // Decision logic
    if (evaluationFailed || score === null) {
      // Evaluation failed - keep the image as-is (it was generated, just couldn't evaluate)
      plan.pagesToKeep.push(pageNum);
      plan.reasoning[pageNum] = `Evaluation failed: ${evaluation.error || 'unknown error'}`;
    } else if (score < regenerateThreshold) {
      // Score too low - regenerate
      plan.pagesToRegenerate.push(pageNum);
      plan.reasoning[pageNum] = `Score ${score}% < ${regenerateThreshold}% threshold`;
    } else if (score < repairThreshold && hasFixable) {
      // Below repair threshold with fixable issues
      plan.pagesToRepair.push(pageNum);
      const fixCount = (evaluation.enrichedFixTargets?.length || 0) +
                       consistencyIssues.length + entityIssues.length;
      plan.reasoning[pageNum] = `Score ${score}% < ${repairThreshold}% with ${fixCount} fixable issues`;
    } else if (score < keepThreshold) {
      // Between regenerate and keep threshold, no fixable issues - regenerate
      plan.pagesToRegenerate.push(pageNum);
      plan.reasoning[pageNum] = `Score ${score}% < ${keepThreshold}% without fixable issues`;
    } else {
      // Score good enough
      plan.pagesToKeep.push(pageNum);
      plan.reasoning[pageNum] = `Score ${score}% >= ${keepThreshold}% threshold`;
    }
  }

  plan.stats.avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0;

  log.info(`📋 [REPAIR PLAN] Built plan: ${plan.pagesToRegenerate.length} regenerate, ${plan.pagesToRepair.length} repair, ${plan.pagesToKeep.length} keep (avg score: ${plan.stats.avgScore}%)`);

  return plan;
}

/**
 * Build a categorized repair plan with different repair methods for different issue types
 *
 * Categories:
 * - iterate: Major issues → full regeneration via image analysis + 17-check scene
 * - styleRepair: Style mismatch → style transfer with good reference
 * - charRepair: Single character mismatch → targeted character replacement
 * - gridRepair: Clothing/artifacts → grid-based inpainting
 * - keep: Good enough pages
 *
 * @param {Array<Object>} pageEvaluations - Evaluation results from evaluateImageBatch
 * @param {Object} options - Plan options
 * @returns {Object} Categorized repair plan
 */
function buildCategorizedRepairPlan(pageEvaluations, options = {}) {
  const {
    regenerateThreshold = 30,
    keepThreshold = 70
  } = options;

  const plan = {
    iterate: [],       // Major issues → full regeneration via iterate
    styleRepair: [],   // Style mismatch → style transfer
    charRepair: [],    // Character mismatch → character replacement
    gridRepair: [],    // Clothing/artifacts → inpainting
    keep: [],          // Good enough
    reasoning: {},
    stats: {
      totalPages: pageEvaluations.length,
      evaluated: 0,
      avgScore: 0
    },
    // Flag to indicate this is a categorized plan
    isCategorized: true
  };

  let totalScore = 0;
  let scoredCount = 0;

  for (const evaluation of pageEvaluations) {
    const pageNum = evaluation.pageNumber;
    // Use combined final score (includes semantic penalties), fallback to qualityScore for backwards compat
    const score = evaluation.score ?? evaluation.qualityScore;
    // Warn if fallback is used despite semantic evaluation running (indicates bug)
    if (evaluation.score === null && evaluation.qualityScore !== null && evaluation.semanticScore !== null) {
      log.warn(`⚠️ [CATEGORIZED REPAIR] Page ${pageNum}: Missing combined score despite semantic evaluation, using qualityScore fallback`);
    }
    const evaluationFailed = !evaluation.evaluated;

    // Track stats
    if (score !== null && score !== undefined) {
      totalScore += score;
      scoredCount++;
      plan.stats.evaluated++;
    }

    // Skip failed evaluations
    if (evaluationFailed || score === null) {
      plan.keep.push({ pageNumber: pageNum, score: null });
      plan.reasoning[pageNum] = `Evaluation failed: ${evaluation.error || 'unknown error'}`;
      continue;
    }

    // Classify issues for this page
    const issues = classifyIssues(evaluation);

    // Decision priority: major > multiple character > style > single character > clothing
    // Very low score always goes to iterate
    if (score < regenerateThreshold || issues.majorIssues.length > 0) {
      // Major issues or very low score → full iteration
      const reasons = issues.majorIssues.map(i => i.reason);
      if (score < regenerateThreshold) {
        reasons.unshift(`Score ${score}% < ${regenerateThreshold}%`);
      }
      plan.iterate.push({
        pageNumber: pageNum,
        score,
        reasons,
        majorIssues: issues.majorIssues
      });
      plan.reasoning[pageNum] = `Iterate: ${reasons.join('; ')}`;
    } else if (issues.characterMismatches.length > 1) {
      // Multiple character mismatches → full iteration (too many to fix individually)
      plan.iterate.push({
        pageNumber: pageNum,
        score,
        reasons: [`${issues.characterMismatches.length} character mismatches`],
        characterMismatches: issues.characterMismatches
      });
      plan.reasoning[pageNum] = `Iterate: ${issues.characterMismatches.length} character mismatches`;
    } else if (issues.styleMismatch) {
      // Style mismatch → style transfer
      plan.styleRepair.push({
        pageNumber: pageNum,
        score,
        reason: 'Style inconsistent with other pages'
      });
      plan.reasoning[pageNum] = 'Style repair: style_consistent=false';
    } else if (issues.characterMismatches.length === 1) {
      // Single character mismatch → targeted replacement
      const charIssue = issues.characterMismatches[0];
      plan.charRepair.push({
        pageNumber: pageNum,
        score,
        character: charIssue.reference,
        figure: charIssue.figure,
        face_bbox: charIssue.face_bbox,
        issues: charIssue.issues,
        reason: charIssue.reason
      });
      plan.reasoning[pageNum] = `Character repair: ${charIssue.reason}`;
    } else if (issues.clothingIssues.length > 0 && score < keepThreshold) {
      // Clothing/artifact issues below keep threshold → grid inpainting
      plan.gridRepair.push({
        pageNumber: pageNum,
        score,
        issues: issues.clothingIssues,
        reason: `${issues.clothingIssues.length} clothing/artifact issues`
      });
      plan.reasoning[pageNum] = `Grid repair: ${issues.clothingIssues.length} issues`;
    } else {
      // Score good enough or no actionable issues
      plan.keep.push({ pageNumber: pageNum, score });
      plan.reasoning[pageNum] = `Keep: score ${score}% >= ${keepThreshold}%`;
    }
  }

  plan.stats.avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0;

  log.info(`📋 [REPAIR PLAN] Categorized: ${plan.iterate.length} iterate, ${plan.styleRepair.length} style, ${plan.charRepair.length} character, ${plan.gridRepair.length} grid, ${plan.keep.length} keep (avg: ${plan.stats.avgScore}%)`);

  return plan;
}

/**
 * Execute a repair plan - regenerate or repair pages as specified
 *
 * @param {Object} plan - Repair plan from buildRepairPlan
 * @param {Map<number, Object>} pageData - Map of page number to page data (imageData, prompt, etc.)
 * @param {Map<number, Object>} evaluations - Map of page number to evaluation results
 * @param {Object} context - Generation context
 * @param {Object} context.modelOverrides - Model overrides for generation
 * @param {Function} context.usageTracker - Usage tracking callback
 * @param {Object} context.visualBible - Visual Bible data
 * @param {boolean} context.isAdmin - Whether user is admin (for debug output)
 * @param {Object} options - Execution options
 * @param {boolean} options.repairFirst - Run repairs before regenerations (default: true)
 * @param {boolean} options.useGridRepair - Use grid-based repair (default: true)
 * @returns {Promise<Object>} Results with updated images and repair history
 */
async function executeRepairPlan(plan, pageData, evaluations, context, options = {}) {
  const {
    repairFirst = true,
    useGridRepair = true
  } = options;

  const {
    modelOverrides = {},
    usageTracker = null,
    visualBible = null,
    isAdmin = false
  } = context;

  const results = {
    repaired: new Map(),
    regenerated: new Map(),
    failed: new Map(),
    history: []
  };

  const startTime = Date.now();

  // Execute repairs first (faster, more likely to succeed)
  if (repairFirst && plan.pagesToRepair.length > 0) {
    log.info(`🔧 [REPAIR EXEC] Repairing ${plan.pagesToRepair.length} pages...`);

    for (const pageNum of plan.pagesToRepair) {
      const page = pageData.get(pageNum);
      const evaluation = evaluations.get(pageNum);

      if (!page || !page.imageData) {
        log.warn(`⚠️  [REPAIR EXEC] Page ${pageNum}: No image data, skipping repair`);
        results.failed.set(pageNum, { error: 'No image data' });
        continue;
      }

      try {
        let repairResult;

        if (useGridRepair) {
          const { gridBasedRepair } = getGridBasedRepair();

          const evalResults = {
            quality: {
              score: evaluation?.qualityScore,
              fixTargets: evaluation?.enrichedFixTargets || evaluation?.fixTargets || [],
              reasoning: evaluation?.reasoning,
              matches: evaluation?.matches || []
            },
            incremental: null,
            final: null
          };

          const gridRepairOutputDir = path.join(os.tmpdir(), 'grid-repair', `repair-${Date.now()}`);

          const gridResult = await gridBasedRepair(
            page.imageData,
            pageNum,
            evalResults,
            {
              outputDir: gridRepairOutputDir,
              skipVerification: false,
              saveIntermediates: isAdmin,
              bboxDetection: evaluation?.bboxDetection,
              onProgress: (step, msg) => log.debug(`  [GRID] Page ${pageNum} ${step}: ${msg}`)
            }
          );

          if (gridResult.repaired && gridResult.imageData) {
            // Re-evaluate repaired image to compare with original
            const originalScore = evaluation?.qualityScore ?? 0;
            const reEvalResult = await evaluateImageQuality(
              gridResult.imageData,
              page.prompt || '',
              page.characterPhotos || [],
              'scene',
              modelOverrides?.qualityModel,
              `PAGE ${pageNum} (post-repair)`
            );
            const repairedScore = reEvalResult?.score ?? 0;

            // Track quality eval usage
            if (usageTracker && reEvalResult?.usage) {
              usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
            }

            // Use repaired only if score improved OR grid repair verified fixes
            const hasVerifiedFixes = gridResult.fixedCount > 0;
            const scoreImproved = repairedScore > originalScore;

            if (scoreImproved || hasVerifiedFixes) {
              repairResult = {
                imageData: gridResult.imageData,
                repaired: true,
                method: 'grid',
                fixedCount: gridResult.fixedCount,
                totalIssues: gridResult.totalIssues,
                originalScore,
                repairedScore
              };
              results.repaired.set(pageNum, repairResult);
              log.info(`✅ [REPAIR EXEC] Page ${pageNum}: ${gridResult.fixedCount}/${gridResult.totalIssues} issues fixed (score: ${originalScore}% → ${repairedScore}%)`);
            } else {
              // Repair made it worse or no improvement - keep original
              results.failed.set(pageNum, {
                error: 'Repair did not improve score',
                originalScore,
                repairedScore,
                keptOriginal: true
              });
              log.warn(`⚠️  [REPAIR EXEC] Page ${pageNum}: Repair rejected (score: ${originalScore}% → ${repairedScore}%), keeping original`);
            }
          } else {
            results.failed.set(pageNum, { error: 'Grid repair failed', result: gridResult });
            log.warn(`⚠️  [REPAIR EXEC] Page ${pageNum}: Grid repair failed`);
          }
        } else {
          // Legacy inpainting repair
          const fixTargets = evaluation?.enrichedFixTargets || evaluation?.fixTargets || [];
          const inpaintResult = await autoRepairWithTargets(
            page.imageData,
            fixTargets,
            0,
            { includeDebugImages: isAdmin }
          );

          if (inpaintResult.repaired && inpaintResult.imageData) {
            // Re-evaluate repaired image to compare with original
            const originalScore = evaluation?.qualityScore ?? 0;
            const reEvalResult = await evaluateImageQuality(
              inpaintResult.imageData,
              page.prompt || '',
              page.characterPhotos || [],
              'scene',
              modelOverrides?.qualityModel,
              `PAGE ${pageNum} (post-repair)`
            );
            const repairedScore = reEvalResult?.score ?? 0;

            // Track quality eval usage
            if (usageTracker && reEvalResult?.usage) {
              usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
            }

            if (repairedScore > originalScore) {
              repairResult = {
                imageData: inpaintResult.imageData,
                repaired: true,
                method: 'inpaint',
                originalScore,
                repairedScore
              };
              results.repaired.set(pageNum, repairResult);
              log.info(`✅ [REPAIR EXEC] Page ${pageNum}: Inpaint repair completed (score: ${originalScore}% → ${repairedScore}%)`);
            } else {
              // Repair made it worse - keep original
              results.failed.set(pageNum, {
                error: 'Repair did not improve score',
                originalScore,
                repairedScore,
                keptOriginal: true
              });
              log.warn(`⚠️  [REPAIR EXEC] Page ${pageNum}: Inpaint rejected (score: ${originalScore}% → ${repairedScore}%), keeping original`);
            }
          } else {
            results.failed.set(pageNum, { error: 'Inpaint repair failed' });
          }
        }

        results.history.push({
          pageNumber: pageNum,
          action: 'repair',
          success: results.repaired.has(pageNum),
          method: useGridRepair ? 'grid' : 'inpaint'
        });
      } catch (error) {
        log.error(`❌ [REPAIR EXEC] Page ${pageNum}: Repair error - ${error.message}`);
        results.failed.set(pageNum, { error: error.message });
        results.history.push({
          pageNumber: pageNum,
          action: 'repair',
          success: false,
          error: error.message
        });
      }
    }
  }

  // Execute regenerations
  if (plan.pagesToRegenerate.length > 0) {
    log.info(`🔄 [REPAIR EXEC] Regenerating ${plan.pagesToRegenerate.length} pages...`);

    for (const pageNum of plan.pagesToRegenerate) {
      const page = pageData.get(pageNum);

      if (!page || !page.prompt) {
        log.warn(`⚠️  [REPAIR EXEC] Page ${pageNum}: No prompt data, skipping regeneration`);
        results.failed.set(pageNum, { error: 'No prompt data' });
        continue;
      }

      try {
        // Use generateImageOnly to regenerate
        const genResult = await generateImageOnly(
          page.prompt,
          page.characterPhotos || [],
          {
            imageModelOverride: modelOverrides?.imageModel,
            imageBackendOverride: modelOverrides?.imageBackend,
            landmarkPhotos: page.landmarkPhotos || [],
            visualBibleGrid: page.visualBibleGrid,
            pageNumber: pageNum
          }
        );

        if (genResult.imageData) {
          results.regenerated.set(pageNum, {
            imageData: genResult.imageData,
            modelId: genResult.modelId,
            thinkingText: genResult.thinkingText || null,
            usage: genResult.usage
          });
          log.info(`✅ [REPAIR EXEC] Page ${pageNum}: Regenerated successfully`);

          // Track usage
          if (usageTracker && genResult.usage) {
            usageTracker(genResult.usage, null, genResult.modelId, null, false);
          }
        } else {
          results.failed.set(pageNum, { error: 'No image data returned' });
        }

        results.history.push({
          pageNumber: pageNum,
          action: 'regenerate',
          success: results.regenerated.has(pageNum)
        });
      } catch (error) {
        log.error(`❌ [REPAIR EXEC] Page ${pageNum}: Regeneration error - ${error.message}`);
        results.failed.set(pageNum, { error: error.message });
        results.history.push({
          pageNumber: pageNum,
          action: 'regenerate',
          success: false,
          error: error.message
        });
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`✅ [REPAIR EXEC] Completed in ${elapsed}s: ${results.repaired.size} repaired, ${results.regenerated.size} regenerated, ${results.failed.size} failed`);

  return results;
}

/**
 * Merge repair execution results back into the original image array
 *
 * @param {Array<Object>} originalImages - Original page images array
 * @param {Array<Object>} evaluations - Evaluation results from evaluateImageBatch
 * @param {Object} repairResults - Results from executeRepairPlan
 * @returns {Array<Object>} Merged array with updated images and evaluation data
 */
function mergeRepairResults(originalImages, evaluations, repairResults) {
  // Build lookup maps
  const evalMap = new Map();
  for (const eval of evaluations) {
    evalMap.set(eval.pageNumber, eval);
  }

  return originalImages.map(img => {
    const pageNum = img.pageNumber;
    const evaluation = evalMap.get(pageNum);
    const repaired = repairResults.repaired.get(pageNum);
    const regenerated = repairResults.regenerated.get(pageNum);

    // Start with original image data
    let mergedImage = { ...img };

    // Apply repair or regeneration if available
    if (repaired?.imageData) {
      mergedImage.imageData = repaired.imageData;
      mergedImage.wasRepaired = true;
      mergedImage.repairMethod = repaired.method;
    } else if (regenerated?.imageData) {
      mergedImage.imageData = regenerated.imageData;
      mergedImage.wasRegenerated = true;
      mergedImage.modelId = regenerated.modelId;
    }

    // Add evaluation data
    if (evaluation) {
      mergedImage.qualityScore = evaluation.qualityScore;
      mergedImage.qualityReasoning = evaluation.reasoning;
      mergedImage.bboxDetection = evaluation.bboxDetection;
      mergedImage.bboxOverlayImage = evaluation.bboxOverlayImage;
      mergedImage.fixableIssues = evaluation.fixableIssues;
      mergedImage.figures = evaluation.figures;
      mergedImage.matches = evaluation.matches;
    }

    return mergedImage;
  });
}

// ============================================================================
// CATEGORIZED REPAIR FUNCTIONS
// Different repair methods for different issue types
// ============================================================================

/**
 * Helper: Get text for a specific page from storyText
 * @param {string} storyText - Full story text with page markers
 * @param {number} pageNumber - Page number to extract
 * @returns {string|null} Page text or null if not found
 */
function getPageText(storyText, pageNumber) {
  if (!storyText) return null;

  // Match page markers like "--- Page X ---" or "## Page X"
  const pageRegex = new RegExp(`(?:---|##)\\s*Page\\s+${pageNumber}\\s*(?:---|\\n)([\\s\\S]*?)(?=(?:---|##)\\s*Page\\s+\\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  return match ? match[1].trim() : null;
}

/**
 * Iterate a page using image analysis and 17-check scene description prompt
 * This is the most comprehensive repair - analyzes what's wrong and regenerates with corrections
 *
 * @param {string} imageData - Current image data (base64)
 * @param {number} pageNumber - Page number being iterated
 * @param {Object} storyData - Full story data object
 * @param {Object} options - Options
 * @param {Object} options.modelOverrides - Model overrides for generation
 * @param {Function} options.usageTracker - Usage tracking callback
 * @returns {Promise<Object>} { imageData, newScene, previewMismatches, method: 'iterate' }
 */
async function iteratePage(imageData, pageNumber, storyData, options = {}) {
  const { modelOverrides = {}, usageTracker = null } = options;

  const {
    analyzeGeneratedImage
  } = require('./sceneValidator');

  const {
    buildSceneDescriptionPrompt,
    buildImagePrompt,
    getCharactersInScene,
    getCharacterPhotoDetails,
    buildAvailableAvatarsForPrompt,
    extractSceneMetadata,
    parseClothingCategory,
    getLandmarkPhotosForScene
  } = getStoryHelpers();

  const { callClaudeAPI } = require('./textModels');
  const { getElementReferenceImagesForPage } = require('./visualBible');

  // Extract story context
  const characters = storyData.characters || [];
  const language = storyData.language || 'en';
  const visualBible = storyData.visualBible || null;
  const clothingRequirements = storyData.clothingRequirements || null;
  const pageClothingData = storyData.pageClothing || null;
  const sceneDescriptions = storyData.sceneDescriptions || [];
  const artStyle = storyData.artStyle || 'pixar';

  // Get page text
  const pageText = getPageText(storyData.storyText, pageNumber);
  if (!pageText) {
    throw new Error(`Page ${pageNumber} text not found`);
  }

  // Get current scene description
  const currentScene = sceneDescriptions.find(s => s.pageNumber === pageNumber);
  if (!currentScene) {
    throw new Error(`No scene description found for page ${pageNumber}`);
  }

  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Analyzing current image with vision model...`);

  // Step 1: Analyze the current image using analyzeGeneratedImage (composition analysis for regeneration)
  const imageDescription = await analyzeGeneratedImage(imageData, characters, visualBible, clothingRequirements);
  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Composition analysis complete (${imageDescription.description.length} chars)`);

  // Step 2: Build previewFeedback from the image analysis
  const previewFeedback = {
    composition: imageDescription.description
  };

  // Build previous scenes context
  const previousScenes = [];
  for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
    if (prevPage >= 1) {
      const prevText = getPageText(storyData.storyText, prevPage);
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
  let shortSceneDesc = '';
  const sceneMetadata = extractSceneMetadata(currentScene.description);
  if (sceneMetadata?.imageSummary) {
    shortSceneDesc = sceneMetadata.imageSummary;
  } else {
    shortSceneDesc = currentScene.description.substring(0, 500);
  }

  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Building scene description prompt with preview feedback...`);

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

  // Step 4: Call Claude to run 17 checks and generate corrected scene
  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Running 17 validation checks with Claude...`);
  const sceneResult = await callClaudeAPI(scenePrompt, 6000, null, { prefill: '{"previewMismatches":[' });
  const newSceneDescription = sceneResult.text;

  // Track usage
  if (usageTracker && sceneResult.usage) {
    usageTracker(null, sceneResult.usage, null, sceneResult.modelId || 'claude');
  }

  // Parse the scene JSON to extract previewMismatches
  let previewMismatches = [];
  try {
    const sceneJson = JSON.parse(newSceneDescription);
    previewMismatches = sceneJson.previewMismatches || [];
    log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Found ${previewMismatches.length} mismatches: ${JSON.stringify(previewMismatches)}`);
  } catch (parseErr) {
    log.warn(`🔄 [ITERATE PAGE] Could not parse scene JSON for mismatches: ${parseErr.message}`);
  }

  // Step 5: Prepare for image generation
  const sceneCharacters = getCharactersInScene(newSceneDescription, characters);

  // Get clothing category
  let clothingCategory = typeof pageClothingData?.pageClothing?.[pageNumber] === 'string'
    ? pageClothingData.pageClothing[pageNumber]
    : parseClothingCategory(newSceneDescription) || pageClothingData?.primaryClothing || 'standard';

  let effectiveClothing = clothingCategory;
  let costumeType = null;
  if (clothingCategory && clothingCategory.startsWith('costumed:')) {
    costumeType = clothingCategory.split(':')[1];
    effectiveClothing = 'costumed';
  }

  let referencePhotos = getCharacterPhotoDetails(sceneCharacters, effectiveClothing, costumeType, artStyle, clothingRequirements);

  // Apply styled avatars if not costumed
  if (effectiveClothing !== 'costumed') {
    const { applyStyledAvatars } = require('./styledAvatars');
    referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
  }

  // Build landmark photos and VB grid
  const newSceneMetadata = extractSceneMetadata(newSceneDescription);
  const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, newSceneMetadata) : [];

  let vbGrid = null;
  if (visualBible) {
    const elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
    const secondaryLandmarks = pageLandmarkPhotos.slice(1);
    if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
      vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
    }
  }

  // Build image prompt
  const imagePrompt = buildImagePrompt(newSceneDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true, referencePhotos);

  // Clear cache to force new generation
  const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
  deleteFromImageCache(cacheKey);

  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: Generating new image with corrected scene description...`);

  // Step 6: Generate new image with corrected scene
  const imageModelId = modelOverrides?.imageModel || 'gemini-3-pro-image-preview';
  const imageResult = await generateImageWithQualityRetry(
    imagePrompt, referencePhotos, null, 'scene', null, usageTracker, null,
    { imageModel: imageModelId },
    `PAGE ${pageNumber} ITERATE`,
    { landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid }
  );

  log.info(`🔄 [ITERATE PAGE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
    newScene: newSceneDescription,
    newSceneMetadata,
    previewMismatches,
    compositionAnalysis: previewFeedback.composition,
    score: imageResult.score,
    reasoning: imageResult.reasoning,
    totalAttempts: imageResult.totalAttempts,
    referencePhotos,
    landmarkPhotos: pageLandmarkPhotos,
    visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
    method: 'iterate'
  };
}

/**
 * Repair style mismatch by transferring style from a good reference page
 *
 * @param {string} imageData - Current image data (base64) that needs style fix
 * @param {string} referenceImage - Good reference image data (base64) with correct style
 * @param {string} artStyle - Art style name (e.g., 'pixar', 'watercolor')
 * @param {Object} options - Options
 * @returns {Promise<Object>} { imageData, method: 'style_transfer' }
 */
async function repairStyleMismatch(imageData, referenceImage, artStyle, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  log.info(`🎨 [STYLE REPAIR] Starting style transfer to match ${artStyle} reference...`);

  // Extract base64 from both images
  const currentBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const referenceBase64 = referenceImage.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `Convert this illustration to match the art style of the reference image.

REFERENCE STYLE: ${artStyle} illustration style
The reference image shows the CORRECT style including:
- Color palette and saturation levels
- Line weight and stroke style
- Shading technique and lighting approach
- Overall artistic rendering

CURRENT IMAGE: Has correct composition but inconsistent style

YOUR TASK: Redraw the current image (second image) in the EXACT style of the reference (first image).
- Match the color palette and saturation
- Match the line weight and stroke style
- Match the shading and lighting technique
- Keep the composition, characters, poses, and actions IDENTICAL to the current image
- Only change the artistic rendering style to match the reference

OUTPUT: A single image matching the reference style.`;

  // Build parts: prompt, reference image (labeled), current image (labeled)
  const parts = [
    { text: prompt },
    { text: 'REFERENCE (correct style):' },
    { inline_data: { mime_type: 'image/jpeg', data: referenceBase64 } },
    { text: 'CURRENT IMAGE (needs style fix):' },
    { inline_data: { mime_type: 'image/jpeg', data: currentBase64 } }
  ];

  const modelId = MODEL_DEFAULTS.pageImage || 'gemini-3-pro-image-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const systemInstruction = getImageSystemInstruction();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(systemInstruction && { systemInstruction }),
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.5,
        ...(modelSupportsThinking(modelId) && { includeThoughts: true })
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    log.error('❌ [STYLE REPAIR] Gemini API error:', error);
    throw new Error(`Style repair failed: ${response.status}`);
  }

  const data = await response.json();

  // Extract usage
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  const thinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;
  log.debug(`📊 [STYLE REPAIR] Token usage - input: ${inputTokens}, output: ${outputTokens}${thinkingTokens ? `, thinking: ${thinkingTokens}` : ''}`);

  // Extract thinking text
  const thinkingText = extractThinkingFromParts(data.candidates?.[0]?.content?.parts, 'STYLE REPAIR');

  // Extract the generated image
  if (data.candidates && data.candidates[0]?.content?.parts) {
    for (const part of data.candidates[0].content.parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
        const repairedImageData = `data:${respMimeType};base64,${inlineData.data}`;
        log.info(`✅ [STYLE REPAIR] Style transfer completed successfully`);
        return {
          imageData: repairedImageData,
          usage: { inputTokens, outputTokens, thinkingTokens, model: modelId },
          thinkingText,
          method: 'style_transfer'
        };
      }
    }
  }

  log.warn('⚠️ [STYLE REPAIR] No image in response');
  return { imageData: null, method: 'style_transfer' };
}

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  if (!bbox || bbox.length !== 4) {
    throw new Error('Valid bounding box required for character replacement');
  }

  const [ymin, xmin, ymax, xmax] = bbox;
  log.info(`👤 [CHAR REPAIR] Starting character replacement for ${charName} at bbox [${bbox.map(v => Math.round(v * 100) + '%').join(', ')}]`);

  // Extract base64 from both images
  const currentBase64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  const avatarBase64 = characterPhoto.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `Replace the figure in the marked region with this character.

CHARACTER REFERENCE: ${charName}
- The first image shows exactly how ${charName} should look
- Match their face, hair color/style, and body proportions
- This is the AUTHORITATIVE reference for this character's appearance

MARKED REGION: The figure located approximately between coordinates:
- Left edge: ${Math.round(xmin * 100)}% from left
- Right edge: ${Math.round(xmax * 100)}% from left
- Top edge: ${Math.round(ymin * 100)}% from top
- Bottom edge: ${Math.round(ymax * 100)}% from top

YOUR TASK: Replace ONLY the figure in the marked region.
- Keep the exact same pose and body position
- Keep the same action/gesture they are performing
- Keep the same clothing style but adjust to match character's typical appearance
- Make the face match ${charName}'s face from the reference photo
- Keep everything else in the image COMPLETELY unchanged
- The replacement should blend seamlessly with the rest of the image

OUTPUT: A single image with the replaced character.`;

  // Build parts: prompt, character reference, scene image
  const parts = [
    { text: prompt },
    { text: `${charName} reference photo:` },
    { inline_data: { mime_type: 'image/jpeg', data: avatarBase64 } },
    { text: 'Scene to fix:' },
    { inline_data: { mime_type: 'image/jpeg', data: currentBase64 } }
  ];

  const modelId = MODEL_DEFAULTS.pageImage || 'gemini-3-pro-image-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const systemInstruction = getImageSystemInstruction();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(systemInstruction && { systemInstruction }),
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.4,  // Lower temperature for more faithful reproduction
        ...(modelSupportsThinking(modelId) && { includeThoughts: true })
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
 * Execute a categorized repair plan - uses different repair methods for different issues
 *
 * @param {Object} plan - Categorized repair plan from buildCategorizedRepairPlan
 * @param {Map<number, Object>} pageData - Map of page number to page data
 * @param {Map<number, Object>} evaluations - Map of page number to evaluation results
 * @param {Object} context - Generation context
 * @param {Object} context.storyData - Full story data object (required for iterate)
 * @param {Array} context.characters - Character array with avatarUrl
 * @param {Object} context.modelOverrides - Model overrides
 * @param {Function} context.usageTracker - Usage tracking callback
 * @param {Object} options - Execution options
 * @returns {Promise<Object>} Results with updated images and repair history
 */
async function executeCategorizedRepairPlan(plan, pageData, evaluations, context, options = {}) {
  const {
    storyData = null,
    characters = [],
    modelOverrides = {},
    usageTracker = null,
    isAdmin = false
  } = context;

  const results = {
    iterated: new Map(),
    styleRepaired: new Map(),
    charRepaired: new Map(),
    gridRepaired: new Map(),
    failed: new Map(),
    history: []
  };

  const startTime = Date.now();

  // 1. Execute iterations (major issues) - most expensive, highest priority
  if (plan.iterate.length > 0 && storyData) {
    log.info(`🔄 [REPAIR EXEC] Iterating ${plan.iterate.length} pages with major issues...`);

    for (const item of plan.iterate) {
      const page = pageData.get(item.pageNumber);
      if (!page || !page.imageData) {
        log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: No image data, skipping iterate`);
        results.failed.set(item.pageNumber, { error: 'No image data' });
        continue;
      }

      try {
        log.info(`🔄 [REPAIR EXEC] Page ${item.pageNumber}: Full iteration (${item.reasons.join('; ')})`);

        const iterResult = await iteratePage(
          page.imageData,
          item.pageNumber,
          storyData,
          { modelOverrides, usageTracker }
        );

        if (iterResult.imageData) {
          // Re-evaluate to compare scores
          const originalScore = item.score || 0;
          const reEvalResult = await evaluateImageQuality(
            iterResult.imageData,
            page.prompt || '',
            page.characterPhotos || [],
            'scene',
            modelOverrides?.qualityModel,
            `PAGE ${item.pageNumber} (post-iterate)`
          );
          const newScore = reEvalResult?.score ?? 0;

          if (usageTracker && reEvalResult?.usage) {
            usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
          }

          // Accept if improved or at least as good (iteration addresses structural issues)
          if (newScore >= originalScore) {
            results.iterated.set(item.pageNumber, {
              imageData: iterResult.imageData,
              newScene: iterResult.newScene,
              previewMismatches: iterResult.previewMismatches,
              originalScore,
              newScore,
              method: 'iterate'
            });
            log.info(`✅ [REPAIR EXEC] Page ${item.pageNumber}: Iteration accepted (score: ${originalScore}% → ${newScore}%)`);
          } else {
            results.failed.set(item.pageNumber, {
              error: 'Iteration did not improve score',
              originalScore,
              newScore,
              keptOriginal: true
            });
            log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: Iteration rejected (score: ${originalScore}% → ${newScore}%), keeping original`);
          }
        } else {
          results.failed.set(item.pageNumber, { error: 'Iteration produced no image' });
        }

        results.history.push({
          pageNumber: item.pageNumber,
          action: 'iterate',
          success: results.iterated.has(item.pageNumber),
          reasons: item.reasons
        });
      } catch (error) {
        log.error(`❌ [REPAIR EXEC] Page ${item.pageNumber}: Iteration error - ${error.message}`);
        results.failed.set(item.pageNumber, { error: error.message });
        results.history.push({
          pageNumber: item.pageNumber,
          action: 'iterate',
          success: false,
          error: error.message
        });
      }
    }
  }

  // 2. Execute style repairs - if we have good reference pages
  if (plan.styleRepair.length > 0) {
    // Find a good reference page (score >= 70, not in any repair list)
    const goodPages = plan.keep.filter(p => p.score >= 70);
    if (goodPages.length > 0) {
      const referencePageNum = goodPages[0].pageNumber;
      const referencePage = pageData.get(referencePageNum);
      const referenceImage = referencePage?.imageData;

      if (referenceImage) {
        log.info(`🎨 [REPAIR EXEC] Style repairing ${plan.styleRepair.length} pages using page ${referencePageNum} as reference...`);

        for (const item of plan.styleRepair) {
          const page = pageData.get(item.pageNumber);
          if (!page || !page.imageData) {
            results.failed.set(item.pageNumber, { error: 'No image data' });
            continue;
          }

          try {
            log.info(`🎨 [REPAIR EXEC] Page ${item.pageNumber}: Style transfer`);

            const styleResult = await repairStyleMismatch(
              page.imageData,
              referenceImage,
              storyData?.artStyle || 'pixar'
            );

            if (styleResult.imageData) {
              // Re-evaluate
              const originalScore = item.score || 0;
              const reEvalResult = await evaluateImageQuality(
                styleResult.imageData,
                page.prompt || '',
                page.characterPhotos || [],
                'scene',
                modelOverrides?.qualityModel,
                `PAGE ${item.pageNumber} (post-style)`
              );
              const newScore = reEvalResult?.score ?? 0;

              if (usageTracker && reEvalResult?.usage) {
                usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
              }

              results.styleRepaired.set(item.pageNumber, {
                imageData: styleResult.imageData,
                originalScore,
                newScore,
                method: 'style_transfer'
              });
              log.info(`✅ [REPAIR EXEC] Page ${item.pageNumber}: Style transfer completed (score: ${originalScore}% → ${newScore}%)`);
            } else {
              results.failed.set(item.pageNumber, { error: 'Style transfer produced no image' });
            }

            results.history.push({
              pageNumber: item.pageNumber,
              action: 'style_repair',
              success: results.styleRepaired.has(item.pageNumber)
            });
          } catch (error) {
            log.error(`❌ [REPAIR EXEC] Page ${item.pageNumber}: Style repair error - ${error.message}`);
            results.failed.set(item.pageNumber, { error: error.message });
            results.history.push({
              pageNumber: item.pageNumber,
              action: 'style_repair',
              success: false,
              error: error.message
            });
          }
        }
      } else {
        log.warn(`⚠️ [REPAIR EXEC] No good reference image available for style repair`);
        for (const item of plan.styleRepair) {
          results.failed.set(item.pageNumber, { error: 'No reference image for style repair' });
        }
      }
    } else {
      log.warn(`⚠️ [REPAIR EXEC] No good reference pages (score >= 70) for style repair`);
      for (const item of plan.styleRepair) {
        // Fall back to iteration for style issues
        plan.iterate.push({ ...item, reasons: ['Style mismatch (no reference available)'] });
      }
    }
  }

  // 3. Execute character replacements
  if (plan.charRepair.length > 0) {
    log.info(`👤 [REPAIR EXEC] Character replacing ${plan.charRepair.length} pages...`);

    for (const item of plan.charRepair) {
      const page = pageData.get(item.pageNumber);
      if (!page || !page.imageData) {
        results.failed.set(item.pageNumber, { error: 'No image data' });
        continue;
      }

      // Find the character's avatar
      const charName = item.character;
      const charData = characters.find(c =>
        c.name?.toLowerCase() === charName?.toLowerCase()
      );

      if (!charData?.avatarUrl && !charData?.data?.avatarUrl) {
        log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: No avatar for ${charName}, falling back to grid repair`);
        plan.gridRepair.push({
          pageNumber: item.pageNumber,
          score: item.score,
          issues: [{ type: 'character', description: `${charName} mismatch`, severity: 'MODERATE' }]
        });
        continue;
      }

      const avatarUrl = charData.avatarUrl || charData.data?.avatarUrl;

      // We need a face bbox - check if we have one from evaluation
      const faceBbox = item.face_bbox;
      if (!faceBbox || faceBbox.length !== 4) {
        log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: No face bbox for ${charName}, falling back to grid repair`);
        plan.gridRepair.push({
          pageNumber: item.pageNumber,
          score: item.score,
          issues: [{ type: 'character', description: `${charName} mismatch (no bbox)`, severity: 'MODERATE' }]
        });
        continue;
      }

      try {
        log.info(`👤 [REPAIR EXEC] Page ${item.pageNumber}: Character replacement (${charName})`);

        const charResult = await repairCharacterMismatch(
          page.imageData,
          avatarUrl,
          faceBbox,
          charName
        );

        if (charResult.imageData) {
          // Re-evaluate
          const originalScore = item.score || 0;
          const reEvalResult = await evaluateImageQuality(
            charResult.imageData,
            page.prompt || '',
            page.characterPhotos || [],
            'scene',
            modelOverrides?.qualityModel,
            `PAGE ${item.pageNumber} (post-char)`
          );
          const newScore = reEvalResult?.score ?? 0;

          if (usageTracker && reEvalResult?.usage) {
            usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
          }

          if (newScore >= originalScore) {
            results.charRepaired.set(item.pageNumber, {
              imageData: charResult.imageData,
              character: charName,
              originalScore,
              newScore,
              method: 'character_replacement'
            });
            log.info(`✅ [REPAIR EXEC] Page ${item.pageNumber}: Character replacement accepted (score: ${originalScore}% → ${newScore}%)`);
          } else {
            results.failed.set(item.pageNumber, {
              error: 'Character replacement did not improve score',
              originalScore,
              newScore,
              keptOriginal: true
            });
            log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: Character replacement rejected (score: ${originalScore}% → ${newScore}%)`);
          }
        } else {
          results.failed.set(item.pageNumber, { error: 'Character replacement produced no image' });
        }

        results.history.push({
          pageNumber: item.pageNumber,
          action: 'char_repair',
          success: results.charRepaired.has(item.pageNumber),
          character: charName
        });
      } catch (error) {
        log.error(`❌ [REPAIR EXEC] Page ${item.pageNumber}: Character repair error - ${error.message}`);
        results.failed.set(item.pageNumber, { error: error.message });
        results.history.push({
          pageNumber: item.pageNumber,
          action: 'char_repair',
          success: false,
          error: error.message
        });
      }
    }
  }

  // 4. Execute grid-based repairs (clothing/artifacts)
  if (plan.gridRepair.length > 0) {
    log.info(`🔧 [REPAIR EXEC] Grid repairing ${plan.gridRepair.length} pages...`);

    const { gridBasedRepair } = getGridBasedRepair();

    for (const item of plan.gridRepair) {
      const page = pageData.get(item.pageNumber);
      const evaluation = evaluations.get(item.pageNumber);

      if (!page || !page.imageData) {
        results.failed.set(item.pageNumber, { error: 'No image data' });
        continue;
      }

      try {
        log.info(`🔧 [REPAIR EXEC] Page ${item.pageNumber}: Grid inpainting (${item.issues.length} issues)`);

        const evalResults = {
          quality: {
            score: evaluation?.qualityScore,
            fixTargets: evaluation?.enrichedFixTargets || evaluation?.fixTargets || [],
            reasoning: evaluation?.reasoning,
            matches: evaluation?.matches || [],
            fixable_issues: item.issues
          },
          incremental: null,
          final: null
        };

        const gridRepairOutputDir = path.join(os.tmpdir(), 'grid-repair', `repair-${Date.now()}`);

        const gridResult = await gridBasedRepair(
          page.imageData,
          item.pageNumber,
          evalResults,
          {
            outputDir: gridRepairOutputDir,
            skipVerification: false,
            saveIntermediates: isAdmin,
            bboxDetection: evaluation?.bboxDetection,
            onProgress: (step, msg) => log.debug(`  [GRID] Page ${item.pageNumber} ${step}: ${msg}`)
          }
        );

        if (gridResult.repaired && gridResult.imageData) {
          // Re-evaluate
          const originalScore = item.score || 0;
          const reEvalResult = await evaluateImageQuality(
            gridResult.imageData,
            page.prompt || '',
            page.characterPhotos || [],
            'scene',
            modelOverrides?.qualityModel,
            `PAGE ${item.pageNumber} (post-grid)`
          );
          const newScore = reEvalResult?.score ?? 0;

          if (usageTracker && reEvalResult?.usage) {
            usageTracker(null, reEvalResult.usage, null, reEvalResult.modelId);
          }

          const hasVerifiedFixes = gridResult.fixedCount > 0;
          if (newScore >= originalScore || hasVerifiedFixes) {
            results.gridRepaired.set(item.pageNumber, {
              imageData: gridResult.imageData,
              fixedCount: gridResult.fixedCount,
              totalIssues: gridResult.totalIssues,
              originalScore,
              newScore,
              method: 'grid_inpaint'
            });
            log.info(`✅ [REPAIR EXEC] Page ${item.pageNumber}: Grid repair completed (${gridResult.fixedCount}/${gridResult.totalIssues} fixed, score: ${originalScore}% → ${newScore}%)`);
          } else {
            results.failed.set(item.pageNumber, {
              error: 'Grid repair did not improve score',
              originalScore,
              newScore,
              keptOriginal: true
            });
            log.warn(`⚠️ [REPAIR EXEC] Page ${item.pageNumber}: Grid repair rejected (score: ${originalScore}% → ${newScore}%)`);
          }
        } else {
          results.failed.set(item.pageNumber, { error: 'Grid repair failed', result: gridResult });
        }

        results.history.push({
          pageNumber: item.pageNumber,
          action: 'grid_repair',
          success: results.gridRepaired.has(item.pageNumber),
          issueCount: item.issues.length
        });
      } catch (error) {
        log.error(`❌ [REPAIR EXEC] Page ${item.pageNumber}: Grid repair error - ${error.message}`);
        results.failed.set(item.pageNumber, { error: error.message });
        results.history.push({
          pageNumber: item.pageNumber,
          action: 'grid_repair',
          success: false,
          error: error.message
        });
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log.info(`✅ [REPAIR EXEC] Categorized repairs completed in ${elapsed}s: ${results.iterated.size} iterated, ${results.styleRepaired.size} style, ${results.charRepaired.size} character, ${results.gridRepaired.size} grid, ${results.failed.size} failed`);

  return results;
}

/**
 * Edit an image based on a user-provided prompt using Gemini's image editing capabilities
 * Pure text/instruction based - no character photos to avoid regeneration artifacts
 * @param {string} imageData - The original image data (base64)
 * @param {string} editInstruction - What the user wants to change
 * @returns {Promise<{imageData: string}|null>}
 */
async function editImageWithPrompt(imageData, editInstruction) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    log.debug(`✏️  [IMAGE EDIT] Editing image with instruction: "${editInstruction}"`);

    // Extract base64 and mime type from the image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build the editing prompt from template
    const editPrompt = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, {
      EDIT_INSTRUCTION: editInstruction
    });
    log.debug(`✏️  [IMAGE EDIT] Full prompt: "${editPrompt}"`);

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

    // Use page image model for editing (optimized for pixel-level manipulation and inpainting)
    const modelId = MODEL_DEFAULTS.pageImage;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const systemInstruction = getImageSystemInstruction();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(systemInstruction && { systemInstruction }),
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.6,
          ...(modelSupportsThinking(modelId) && { includeThoughts: true }),
          imageConfig: {
            aspectRatio: "1:1"
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
  } = options;

  // Extract forceRepairThreshold from incrementalConsistency if not provided directly
  const forceRepairThreshold = forceRepairThresholdInput !== null
    ? forceRepairThresholdInput
    : (incrementalConsistencyInput?.forceRepairThreshold ?? null);

  // In check-only mode: only 1 attempt, no auto-repair, force dry-run for consistency
  const MAX_ATTEMPTS = checkOnlyMode ? 1 : 3;
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
      result = await callGeminiAPIForImage(currentPrompt, characterPhotos, previousImage, evaluationType, onImageReady, imageModelOverride, qualityModelOverride, pageContext, imageBackendOverride, landmarkPhotos, sceneCharacterCount, visualBibleGrid);
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
                           errorMsg.includes('no candidates');

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
    let bboxDetectionHistory = null;  // Track two-stage detection for dev mode display
    let bboxOverlayImage = null;  // Image with boxes drawn for dev mode
    let enrichedFixTargets = null;

    // ALWAYS run bbox detection for every image (figure locations needed for other features)
    // This runs regardless of whether issues were found, incrEnabled, or autoRepair settings
    const fixableIssues = result.fixableIssues || [];
    const qualityMatches = result.matches || [];  // Character → figure mapping from quality eval
    const objectMatches = result.objectMatches || [];  // Object/animal/landmark mapping from quality eval

    // Extract expected character positions, clothing, and objects from scene description in prompt
    // Scene descriptions contain structured JSON with character positions like "bottom-left foreground"
    // and objects like "star [ART001]"
    const sceneMetadata = getStoryHelpers().extractSceneMetadata(currentPrompt);
    const expectedCharacterPositions = sceneMetadata?.characterPositions || {};
    const expectedCharacterClothing = sceneMetadata?.characterClothing || {};
    const expectedObjects = sceneMetadata?.objects || [];

    // Parse character descriptions (age, gender) from prompt for smarter matching
    const characterDescriptions = getStoryHelpers().parseCharacterDescriptions(currentPrompt);

    // Parse Visual Bible objects from prompt (REQUIRED OBJECTS section)
    const vbObjects = parseVisualBibleObjects(currentPrompt);
    // Merge VB objects with scene objects
    const allExpectedObjects = [...expectedObjects, ...vbObjects.filter(o => !expectedObjects.includes(o))];

    if (Object.keys(expectedCharacterPositions).length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Expected character positions: ${Object.entries(expectedCharacterPositions).map(([n, p]) => `${n}=${p}`).join(', ')}`);
    }
    if (Object.keys(characterDescriptions).length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Character descriptions: ${Object.entries(characterDescriptions).map(([n, d]) => `${n}=${d.genderTerm || 'unknown'}`).join(', ')}`);
    }
    if (allExpectedObjects.length > 0) {
      log.debug(`📦 [QUALITY RETRY] ${pageLabel}Expected objects: ${allExpectedObjects.join(', ')}`);
    }

    log.info(`📦 [QUALITY RETRY] ${pageLabel}Bbox detection: locating all figures/objects${fixableIssues.length > 0 ? `, matching ${fixableIssues.length} issues` : ''}${qualityMatches.length > 0 ? `, ${qualityMatches.length} character matches` : ''}${objectMatches.length > 0 ? `, ${objectMatches.length} object matches` : ''}${allExpectedObjects.length > 0 ? `, ${allExpectedObjects.length} expected objects` : ''}...`);
    const enrichResult = await enrichWithBoundingBoxes(result.imageData, fixableIssues, qualityMatches, objectMatches, expectedCharacterPositions, allExpectedObjects, characterDescriptions, expectedCharacterClothing);
    bboxDetectionHistory = enrichResult.detectionHistory;
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

    // ALWAYS record bbox detection in retryHistory for dev mode display
    // This ensures Object Detection section shows for ALL pages, not just repaired ones
    if (bboxDetectionHistory) {
      retryHistory.push({
        attempt: attempts,
        type: 'bbox_detection_only',
        score: score,
        fixableIssuesCount: result.fixableIssues?.length || 0,
        enrichedTargetsCount: enrichedFixTargets?.length || 0,
        bboxDetection: bboxDetectionHistory,
        bboxOverlayImage: bboxOverlayImage,  // Image with boxes drawn for dev mode
        hasBboxOverlay: !!bboxOverlayImage,  // Flag for lazy loading
        autoRepairEnabled: enableAutoRepair,
        timestamp: new Date().toISOString()
      });
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

          // Convert grid result to match autoRepairWithTargets format
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
          // Legacy: Inpainting uses text-based coordinates instead of mask images
          // This avoids confusion when there are multiple similar elements
          repairResult = await autoRepairWithTargets(
            result.imageData,
            fixTargetsToUse,
            0,  // No additional inspection attempts
            { includeDebugImages: isAdmin }  // Include before/after images for admin users
          );
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
            pageContext
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
              // Repair details from autoRepairWithTargets
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

      // Add bbox detection to retryHistory if not already there (for dev mode visibility)
      const hasBboxEntry = retryHistory.some(h => h.bboxDetection || h.bboxOverlayImage);
      if (bboxDetectionHistory && !hasBboxEntry) {
        retryHistory.push({
          attempt: attempts,
          type: 'bbox_detection_only',
          score: score,
          fixableIssuesCount: result.fixableIssues?.length || 0,
          enrichedTargetsCount: enrichedFixTargets?.length || 0,
          bboxDetection: bboxDetectionHistory,
          bboxOverlayImage: bboxOverlayImage,
          autoRepairEnabled: enableAutoRepair,
          timestamp: new Date().toISOString()
        });
      }

      // Extract rewrite usage from retryHistory if a scene was rewritten
      const rewriteEntry = retryHistory.find(h => h.type === 'safety_block_rewrite' && h.rewriteUsage);
      return {
        ...result,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts,
        rewriteUsage: rewriteEntry?.rewriteUsage || null
      };
    }

    // Log why we're retrying
    if (hasTextError) {
      log.debug(`⚠️  [QUALITY RETRY] Retrying due to text error: ${result.textIssue}`);
    } else {
      log.debug(`⚠️  [QUALITY RETRY] Score ${score}% < ${IMAGE_QUALITY_THRESHOLD}%, retrying with new generation...`);
    }
  }

  // All attempts exhausted, return best result
  console.log(`⚠️  [QUALITY RETRY] Max attempts (${MAX_ATTEMPTS}) reached. Using best result with score ${bestScore === -1 ? 'unknown' : bestScore + '%'}`);
  // Extract rewrite usage from retryHistory if a scene was rewritten
  const rewriteEntry = retryHistory.find(h => h.type === 'safety_block_rewrite' && h.rewriteUsage);
  return {
    ...bestResult,
    wasRegenerated: true,
    retryHistory: retryHistory,
    totalAttempts: attempts,
    rewriteUsage: rewriteEntry?.rewriteUsage || null
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
      const result = JSON.parse(responseText);
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
 * Inpaint an image using TEXT-BASED region coordinates (semantic masking)
 * NOTE: Gemini 2.5 Flash Image uses natural language to identify regions.
 * We pass coordinates as text in the prompt instead of as a mask image,
 * which is more reliable when there are multiple similar elements (e.g., multiple hands).
 *
 * Supports multiple backends:
 * - 'gemini' (default): Uses text-based coordinates with Gemini API
 * - 'runware': Uses mask images with Runware API (much cheaper)
 *
 * @param {string} originalImage - Base64 original image
 * @param {Array} boundingBoxes - Array of [ymin, xmin, ymax, xmax] normalized 0-1 coordinates
 * @param {string} fixPrompt - Instruction for what to fix
 * @param {string} maskImage - Optional mask image (required for Runware, optional for Gemini)
 * @param {Object} options - Additional options
 * @param {string} options.backend - 'gemini' or 'runware' (default: MODEL_DEFAULTS.inpaintBackend)
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
            ...(modelSupportsThinking(modelId) && { includeThoughts: true })
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

/**
 * Auto-repair using pre-computed fix targets from quality evaluation
 * Combines ALL fix targets into ONE mask and ONE API call for efficiency
 * Uses text-based coordinates instead of mask images for reliable region targeting.
 * @param {string} imageData - Base64 image data URL
 * @param {Array} fixTargets - Array of {boundingBox, issue, fixPrompt} from evaluation
 * @param {number} maxAdditionalAttempts - Extra inspection-based attempts after combined fix (default 0)
 * @param {Object} options - Optional settings
 * @param {boolean} options.includeDebugImages - Include before/after images in repair history (for admin users)
 * @returns {Promise<{imageData: string, repaired: boolean, repairHistory: Array}>}
 */
async function autoRepairWithTargets(imageData, fixTargets, maxAdditionalAttempts = 0, options = {}) {
  const { includeDebugImages = false } = options;
  const repairHistory = [];
  let currentImage = imageData;

  if (!fixTargets || fixTargets.length === 0) {
    log.info(`🔄 [AUTO-REPAIR] No fix targets provided, skipping repair`);
    return {
      imageData: currentImage,
      repaired: false,
      noErrorsFound: true,
      repairHistory
    };
  }

  // Group fix targets by issue type and apply adaptive padding
  // Research: Combining unrelated regions (face vs objects) causes artifacts
  const { faceTargets, anatomyTargets, objectTargets } = groupFixTargetsForInpainting(fixTargets);

  // Collect all padded bounding boxes for coverage check
  const allTargets = [...faceTargets, ...anatomyTargets, ...objectTargets];
  const boundingBoxes = allTargets.map(t => t.boundingBox);

  // Check mask coverage before attempting repair
  const maskCoverage = calculateMaskCoverage(boundingBoxes);
  log.info(`🔄 [AUTO-REPAIR] ${fixTargets.length} fix targets covering ${maskCoverage.toFixed(1)}% of image (with padding)`);

  if (maskCoverage > MAX_MASK_COVERAGE_PERCENT) {
    log.warn(`⚠️ [AUTO-REPAIR] Mask covers ${maskCoverage.toFixed(1)}% of image (>${MAX_MASK_COVERAGE_PERCENT}%) - too large for inpainting, skipping repair`);
    log.warn(`   Inpainting works best for small fixes. For large areas, consider regenerating the entire image.`);
    repairHistory.push({
      attempt: 1,
      errorType: 'mask_too_large',
      description: `Mask coverage ${maskCoverage.toFixed(1)}% exceeds ${MAX_MASK_COVERAGE_PERCENT}% threshold`,
      boundingBoxes: boundingBoxes,
      targetCount: fixTargets.length,
      coverage: maskCoverage,
      success: false,
      skipped: true,
      reason: 'Inpainting is not effective for large masked areas. The image should be regenerated instead.',
      timestamp: new Date().toISOString()
    });
    return {
      imageData: currentImage,
      repaired: false,
      maskTooLarge: true,
      coverage: maskCoverage,
      repairHistory
    };
  }

  // Helper function to repair a group of targets
  const repairGroup = async (targets, groupName, modelId, passNumber) => {
    if (targets.length === 0) return { success: true, skipped: true };

    const groupBboxes = targets.map(t => t.boundingBox);
    const groupPrompt = targets.length === 1
      ? targets[0].fixPrompt
      : `Fix the following issues:\n${targets.map((t, i) => `${i + 1}. ${t.fixPrompt}`).join('\n')}`;

    log.info(`🔄 [AUTO-REPAIR] Pass ${passNumber}: ${groupName} (${targets.length} targets) using ${modelId}`);

    try {
      const dimensions = await getImageDimensions(currentImage);
      const mask = await createCombinedMask(dimensions.width, dimensions.height, groupBboxes);

      const repaired = await inpaintWithMask(
        currentImage,
        groupBboxes,
        groupPrompt,
        mask,
        { runwareModel: modelId }
      );

      if (repaired?.imageData) {
        const historyEntry = {
          attempt: passNumber,
          errorType: groupName,
          description: targets.map(t => t.issue).join('; '),
          boundingBoxes: groupBboxes,
          fixPrompt: groupPrompt,
          fullPrompt: repaired.fullPrompt || groupPrompt,  // Full inpainting prompt sent to API
          success: true,
          targetCount: targets.length,
          modelId: repaired.modelId || modelId,
          usage: repaired.usage,
          timestamp: new Date().toISOString()
        };

        // Always run verification (LPIPS is fast, provides useful metrics)
        try {
          const verification = await verifyInpaintResult(currentImage, repaired.imageData, targets);
          historyEntry.verification = verification;

          if (verification.success) {
            log.info(`🔍 [REPAIR VERIFY] Verification: repair successful`);
          } else {
            log.warn(`🔍 [REPAIR VERIFY] Verification: repair may not have fixed issue`);
          }

          if (verification.lpips) {
            log.info(`🔍 [REPAIR VERIFY] LPIPS: ${verification.lpips.lpipsScore?.toFixed(4)} (${verification.lpips.changed ? 'changed' : 'unchanged'})`);
          }
          if (verification.llm) {
            log.info(`🔍 [REPAIR VERIFY] LLM: ${verification.llm.fixed ? '✅ Fixed' : '❌ Not fixed'} (${(verification.llm.confidence * 100).toFixed(0)}% confidence)`);
          }
        } catch (verifyErr) {
          log.debug(`[REPAIR VERIFY] Verification failed: ${verifyErr.message}`);
          historyEntry.verification = { error: verifyErr.message };
        }

        // Only store images in debug mode (to save memory)
        if (includeDebugImages) {
          historyEntry.maskImage = mask;
          historyEntry.beforeImage = currentImage;
          historyEntry.afterImage = repaired.imageData;

          // Generate diff image to highlight changes
          try {
            const beforeBuffer = Buffer.from(currentImage.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const afterBuffer = Buffer.from(repaired.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const diffBuffer = await createDiffImage(beforeBuffer, afterBuffer);
            if (diffBuffer) {
              historyEntry.diffImage = `data:image/jpeg;base64,${diffBuffer.toString('base64')}`;
            }
          } catch (diffErr) {
            log.debug(`[AUTO-REPAIR] Failed to create diff image: ${diffErr.message}`);
          }
        }

        repairHistory.push(historyEntry);
        currentImage = repaired.imageData;
        return { success: true };
      }
      return { success: false, error: 'No image returned' };
    } catch (err) {
      log.error(`❌ [AUTO-REPAIR] ${groupName} repair failed:`, err.message);
      repairHistory.push({
        attempt: passNumber,
        errorType: groupName,
        description: `Error: ${err.message}`,
        success: false,
        targetCount: targets.length,
        timestamp: new Date().toISOString()
      });
      return { success: false, error: err.message };
    }
  };

  try {
    let passNumber = 1;
    let anyRepaired = false;

    // Pass 1: Face issues (highest priority, needs high-quality model)
    // Use FLUX Fill for face repair - best quality for identity preservation
    if (faceTargets.length > 0) {
      const result = await repairGroup(faceTargets, 'face-repair', 'runware:102@1', passNumber++);
      if (result.success && !result.skipped) anyRepaired = true;
    }

    // Pass 2: Anatomy issues (hands, limbs)
    // Use SDXL - good quality, more affordable
    if (anatomyTargets.length > 0) {
      const result = await repairGroup(anatomyTargets, 'anatomy-repair', 'runware:101@1', passNumber++);
      if (result.success && !result.skipped) anyRepaired = true;
    }

    // Pass 3: Object issues (props, items, backgrounds)
    // Use SDXL - good enough for objects
    if (objectTargets.length > 0) {
      const result = await repairGroup(objectTargets, 'object-repair', 'runware:101@1', passNumber++);
      if (result.success && !result.skipped) anyRepaired = true;
    }

    // Log summary
    const totalPasses = passNumber - 1;
    if (anyRepaired) {
      log.info(`✅ [AUTO-REPAIR] Completed ${totalPasses} repair pass(es) for ${fixTargets.length} targets`);
    }

    // All repairs recorded in repairHistory by repairGroup
    // No additional logging needed here
  } catch (error) {
    log.error(`❌ [AUTO-REPAIR] Grouped repair failed:`, error.message);
    repairHistory.push({
      attempt: 0,
      errorType: 'grouped-repair-error',
      description: `Error: ${error.message}`,
      success: false,
      targetCount: fixTargets.length,
      timestamp: new Date().toISOString()
    });
  }

  // Phase 2: Optional additional inspection-based repairs
  if (maxAdditionalAttempts > 0) {
    log.debug(`🔄 [AUTO-REPAIR] Running ${maxAdditionalAttempts} additional inspection-based attempts...`);
    const additionalResult = await autoRepairImage(currentImage, maxAdditionalAttempts, { includeDebugImages });
    if (additionalResult.repaired) {
      currentImage = additionalResult.imageData;
      repairHistory.push(...additionalResult.repairHistory);
    }
  }

  const successCount = repairHistory.filter(r => r.success).length;
  const skippedCount = repairHistory.filter(r => r.skipped && !r.success).length;
  const failedCount = repairHistory.filter(r => !r.success && !r.skipped).length;

  // Sum up total usage from all repair attempts (including verification LLM costs)
  const totalUsage = repairHistory.reduce((acc, r) => {
    if (r.usage) {
      acc.input_tokens += r.usage.input_tokens || 0;
      acc.output_tokens += r.usage.output_tokens || 0;
      acc.thinking_tokens += r.usage.thinking_tokens || 0;
    }
    // Include verification LLM usage if present
    if (r.verification?.llm?.usage) {
      acc.input_tokens += r.verification.llm.usage.inputTokens || 0;
      acc.output_tokens += r.verification.llm.usage.outputTokens || 0;
    }
    return acc;
  }, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

  log.info(`✅ [AUTO-REPAIR] Targeted repair complete: ${successCount} successful, ${skippedCount} skipped, ${failedCount} failed (total tokens: ${totalUsage.input_tokens} in, ${totalUsage.output_tokens} out)`);

  return {
    imageData: currentImage,
    repaired: successCount > 0,
    noErrorsFound: false,
    repairHistory,
    usage: totalUsage,
    modelId: repairHistory.find(r => r.modelId)?.modelId
  };
}

/**
 * Auto-repair an image by detecting and fixing physics errors
 * Runs up to maxAttempts cycles of inspect → mask → fix
 * @param {string} imageData - Base64 image data URL
 * @param {number} maxAttempts - Maximum repair cycles (default 2)
 * @param {Object} options - Optional settings
 * @param {boolean} options.includeDebugImages - Include before/after images in repair history (for admin users)
 * @returns {Promise<{imageData: string, repaired: boolean, repairHistory: Array}>}
 */
async function autoRepairImage(imageData, maxAttempts = 2, options = {}) {
  const { includeDebugImages = false } = options;
  const repairHistory = [];
  let currentImage = imageData;

  log.info(`🔄 [AUTO-REPAIR] Starting auto-repair (max ${maxAttempts} attempts)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.debug(`🔄 [AUTO-REPAIR] Attempt ${attempt}/${maxAttempts}`);

    // 1. Inspect the image for errors
    const inspection = await inspectImageForErrors(currentImage);

    if (!inspection.errorFound) {
      log.info(`✅ [AUTO-REPAIR] No errors found after ${attempt - 1} repairs`);
      return {
        imageData: currentImage,
        repaired: attempt > 1,
        noErrorsFound: true,
        repairHistory
      };
    }

    // 2. Get image dimensions and create mask (for dev view only)
    const dimensions = await getImageDimensions(currentImage);
    const mask = await createMaskFromBoundingBox(
      dimensions.width,
      dimensions.height,
      inspection.boundingBox
    );

    // 3. Inpaint using text-based coordinates
    // Pass bounding box as array, mask is kept for dev view only
    const repaired = await inpaintWithMask(
      currentImage,
      [inspection.boundingBox],  // Single bbox as array
      inspection.fixPrompt,
      mask  // Mask for dev view, not sent to API
    );

    if (!repaired || !repaired.imageData) {
      log.warn(`⚠️ [AUTO-REPAIR] Inpainting failed at attempt ${attempt}`);
      const historyEntry = {
        attempt,
        errorType: inspection.errorType,
        description: inspection.description,
        boundingBox: inspection.boundingBox,
        fixPrompt: inspection.fixPrompt,
        success: false,
        timestamp: new Date().toISOString()
      };
      // Include debug images for admin users
      if (includeDebugImages) {
        historyEntry.maskImage = mask;
        historyEntry.beforeImage = currentImage;
      }
      repairHistory.push(historyEntry);
      break;
    }

    // Record the repair
    const historyEntry = {
      attempt,
      errorType: inspection.errorType,
      description: inspection.description,
      boundingBox: inspection.boundingBox,
      fixPrompt: inspection.fixPrompt,
      fullPrompt: repaired.fullPrompt || inspection.fixPrompt,  // Full inpainting prompt sent to API
      success: true,
      timestamp: new Date().toISOString()
    };
    // Include debug images for admin users
    if (includeDebugImages) {
      historyEntry.maskImage = mask;
      historyEntry.beforeImage = currentImage;
      historyEntry.afterImage = repaired.imageData;
    }
    repairHistory.push(historyEntry);

    currentImage = repaired.imageData;
    log.info(`✅ [AUTO-REPAIR] Repair ${attempt} complete: fixed ${inspection.errorType}`);
  }

  return {
    imageData: currentImage,
    repaired: repairHistory.length > 0 && repairHistory.some(r => r.success),
    noErrorsFound: false,
    repairHistory
  };
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
          const compressed = await compressImageToJPEG(refPhoto, 80, 512);
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

  // Call Gemini API with retry for socket errors
  const modelId = MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';
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
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
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
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
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
        model: MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash',
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

  // Call Gemini API
  const modelId = MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';
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
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
          ]
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
 * Split a grid image into individual reference images
 * Used after generating reference sheets to extract individual element references
 *
 * @param {Buffer|string} gridImage - Grid image as Buffer or base64 data URL
 * @param {number} count - Number of elements in the grid
 * @returns {Promise<string[]>} Array of base64 PNG images (without data URL prefix)
 */
async function splitGridIntoReferences(gridImage, count) {
  // Convert base64 data URL to buffer if needed
  let buffer;
  if (typeof gridImage === 'string') {
    const base64Data = gridImage.replace(/^data:image\/\w+;base64,/, '');
    buffer = Buffer.from(base64Data, 'base64');
  } else {
    buffer = gridImage;
  }

  const metadata = await sharp(buffer).metadata();
  const { width, height } = metadata;

  if (!width || !height) {
    throw new Error('Could not get grid image dimensions');
  }

  // Calculate grid layout (always 2 columns for simplicity)
  const cols = count <= 2 ? count : 2;
  const rows = Math.ceil(count / cols);
  const cellWidth = Math.floor(width / cols);
  const cellHeight = Math.floor(height / rows);

  log.debug(`[REF-SHEET] Splitting ${width}x${height} grid into ${cols}x${rows} cells (${cellWidth}x${cellHeight} each)`);

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
        .resize(512, 512, { fit: 'cover' }) // Standardize size
        .png()
        .toBuffer();

      references.push(cropped.toString('base64'));
      log.debug(`[REF-SHEET] Extracted cell ${i + 1}/${count} (col=${col}, row=${row})`);
    } catch (err) {
      log.error(`[REF-SHEET] Failed to extract cell ${i}: ${err.message}`);
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
  const cols = count <= 2 ? count : 2;
  const rows = Math.ceil(count / cols);

  // Build grid layout description
  const positions = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right'];
  const gridLayoutLines = elements.map((el, i) => {
    const pos = positions[i] || `Cell ${i + 1}`;
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
    imageModel = null
  } = options;

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
  const needsReference = getElementsNeedingReferenceImages(visualBible, minAppearances);

  if (needsReference.length === 0) {
    log.info('[REF-SHEET] No elements need reference images (none with 2+ page appearances)');
    return { generated: 0, failed: 0, elements: [] };
  }

  log.info(`[REF-SHEET] 🎨 Generating reference images for ${needsReference.length} element(s)`);
  log.info(`[REF-SHEET] Elements: ${needsReference.map(e => `${e.name} (${e.type}, ${e.pageCount} pages)`).join(', ')}`);

  let generated = 0;
  let failed = 0;
  const processedElements = [];

  // Batch elements into grids (max 4 per grid for quality)
  const batches = [];
  for (let i = 0; i < needsReference.length; i += maxPerBatch) {
    batches.push(needsReference.slice(i, i + maxPerBatch));
  }

  log.info(`[REF-SHEET] Processing ${batches.length} batch(es)`);

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    log.info(`[REF-SHEET] Batch ${batchIdx + 1}/${batches.length}: ${batch.length} elements`);

    try {
      // Build the prompt for this batch
      const prompt = buildReferenceSheetPrompt(batch, styleDescription);

      // Generate the grid image using Gemini
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('Gemini API key not configured');
      }

      // Use the image model from config or default (pageImage is for regular illustrations)
      const modelId = imageModel || MODEL_DEFAULTS.pageImage;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['image', 'text'],
            responseMimeType: 'text/plain'
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Extract image from response
      const parts = data.candidates?.[0]?.content?.parts || [];
      let gridImageData = null;

      for (const part of parts) {
        if (part.inlineData?.data) {
          gridImageData = part.inlineData.data;
          break;
        }
      }

      if (!gridImageData) {
        throw new Error('Gemini did not return an image');
      }

      log.info(`[REF-SHEET] ✓ Generated ${batch.length}-element grid (${Math.round(gridImageData.length / 1024)}KB)`);

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
    elements: processedElements
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

  // Max 6 elements in grid (2x3)
  const gridElements = allElements.slice(0, 6);
  if (allElements.length > 6) {
    const dropped = allElements.slice(6).map(e => `${e.name} (${e.type})`).join(', ');
    log.warn(`⚠️ [VB-GRID] Grid overflow: ${allElements.length} elements, keeping first 6, dropping: ${dropped}`);
  }
  const cellSize = 256;
  const labelHeight = 24;
  const cols = 2;
  const rows = Math.ceil(gridElements.length / cols);

  const gridWidth = cols * cellSize;
  const gridHeight = rows * (cellSize + labelHeight);

  log.debug(`🔲 [VB-GRID] Building grid with ${gridElements.length} elements (${cols}x${rows})`);

  try {
    // Create composite operations for each cell
    const composites = [];

    for (let i = 0; i < gridElements.length; i++) {
      const el = gridElements[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellSize;
      const y = row * (cellSize + labelHeight);

      // Extract base64 data from data URL
      const base64Data = el.imageData.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');

      // Resize image to fit cell (maintaining aspect ratio, cover)
      const resizedImage = await sharp(imageBuffer)
        .resize(cellSize, cellSize, { fit: 'cover' })
        .toBuffer();

      composites.push({
        input: resizedImage,
        left: x,
        top: y
      });

      // Create label text as SVG
      const labelText = `${el.name} (${el.type})`;
      // Truncate if too long
      const displayText = labelText.length > 28 ? labelText.substring(0, 25) + '...' : labelText;
      const labelSvg = `
        <svg width="${cellSize}" height="${labelHeight}">
          <rect width="${cellSize}" height="${labelHeight}" fill="#333"/>
          <text x="${cellSize / 2}" y="17" font-family="Arial, sans-serif" font-size="12"
                fill="white" text-anchor="middle">${displayText}</text>
        </svg>
      `;

      composites.push({
        input: Buffer.from(labelSvg),
        left: x,
        top: y + cellSize
      });
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

    log.info(`🔲 [VB-GRID] Created grid: ${gridElements.length} elements, ${gridWidth}x${gridHeight}px, ${Math.round(gridBuffer.length / 1024)}KB`);

    return gridBuffer;
  } catch (error) {
    log.error(`❌ [VB-GRID] Failed to build grid: ${error.message}`);
    return null;
  }
}

module.exports = {
  // Utility functions
  hashImageData,
  generateImageCacheKey,
  cropImageForSequential,
  compressImageToJPEG,

  // Core image functions
  evaluateImageQuality,
  callGeminiAPIForImage,
  editImageWithPrompt,
  generateImageWithQualityRetry,
  rewriteBlockedScene,
  buildVisualBibleGrid,

  // Separated evaluation pipeline functions (new architecture)
  generateImageOnly,
  evaluateImageBatch,
  buildRepairPlan,
  executeRepairPlan,
  mergeRepairResults,

  // Categorized repair system (new)
  classifyIssues,
  buildCategorizedRepairPlan,
  iteratePage,
  repairStyleMismatch,
  repairCharacterMismatch,
  executeCategorizedRepairPlan,

  // Cache management
  clearImageCache,
  deleteFromImageCache,
  getImageCacheSize,
  getCacheStats,
  logCacheSummary,
  resetCacheStats,

  // Auto-repair functions
  inspectImageForErrors,
  createMaskFromBoundingBox,
  createCombinedMask,
  calculateMaskCoverage,
  inpaintWithMask,
  autoRepairImage,
  autoRepairWithTargets,
  getGridBasedRepair,  // Lazy-loaded grid-based repair module

  // Two-stage bounding box detection
  detectAllBoundingBoxes,
  detectSubRegion,  // Sub-region detection for targeted repairs (shoes, shirt, hands, etc.)
  createBboxOverlayImage,  // Create overlay image with boxes drawn
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

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD,
  MAX_MASK_COVERAGE_PERCENT
};
