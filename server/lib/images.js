/**
 * Image Generation Module
 * Handles image generation, quality evaluation, editing, and retry logic
 * Extracted from server.js for maintainability
 */

const sharp = require('sharp');
const crypto = require('crypto');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { MODEL_DEFAULTS, withRetry } = require('./textModels');
const { generateWithRunware, isRunwareConfigured, RUNWARE_MODELS } = require('./runware');
const { MODEL_DEFAULTS: CONFIG_DEFAULTS, IMAGE_MODELS } = require('../config/models');

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
  constructor(maxSize, ttlMs = 0) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL expiration
    if (this.ttlMs > 0 && Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, { value: entry.value, timestamp: entry.timestamp });
    return entry.value;
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
const imageCache = new LRUCache(IMAGE_CACHE_MAX_SIZE, CACHE_TTL_MS);

// Cache for compressed reference images (with LRU eviction)
const compressedRefCache = new LRUCache(REF_CACHE_MAX_SIZE, CACHE_TTL_MS);

// Quality threshold from environment or default
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || 50;

// Maximum mask coverage for inpainting (percentage of image area)
// Masks larger than this will skip repair - inpainting doesn't work well for large areas
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
 * Evaluate image quality using Claude API
 * Sends the image to Claude for quality assessment
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} originalPrompt - The prompt used to generate the image
 * @param {string[]} referenceImages - Reference images used for generation
 * @param {string} evaluationType - Type of evaluation: 'scene' (default) or 'cover' (text-focused)
 * @returns {Promise<number>} Quality score from 0-100
 */
async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null, pageContext = '') {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      log.verbose('⚠️  [QUALITY] Gemini API key not configured, skipping quality evaluation');
      return null;
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

    const evaluationPrompt = evaluationTemplate
      ? fillTemplate(evaluationTemplate, { ORIGINAL_PROMPT: originalPrompt })
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

    // Use centralized default for quality evaluation (or override if provided)
    let modelId = qualityModelOverride || MODEL_DEFAULTS.qualityEval;
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

    // Fallback: If 2.5 model fails at HTTP level, try 2.0
    if (!response.ok && modelId.includes('2.5')) {
      const error = await response.text();
      log.warn(`⚠️  [QUALITY] Model ${modelId} failed (HTTP ${response.status}), falling back to gemini-2.0-flash-lite. Error: ${error.substring(0, 200)}`);
      modelId = 'gemini-2.0-flash-lite';
      response = await callQualityAPI(modelId);
    }

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
      // - No mention of "children" or ages
      // - Focus purely on artistic/technical quality
      // - KEEP full analysis structure for auto-repair functionality
      const sanitizedPrompt = `You are a Technical QA Analyst evaluating an AI-generated illustration.

**TASK**: Audit for rendering errors and character consistency against reference photos.

**ANALYSIS STEPS**:

1. **Subject Mapping**: For each figure, describe position, build, hair, attire, activity, perspective
2. **Identity Sync**: Match each figure to reference photos, check hair/attire consistency
3. **Rendering Integrity**:
   - Count fingers on each visible hand (1,2,3,4,5)
   - Check for structural issues (floating objects, missing limbs, clipping)
   - Verify proportions and anatomy
4. **Scene Check**: Are all expected characters present? Does action match prompt?

**SCORING (0-10)**:
- 10: Perfect, no issues
- 8-9: Good, minor issues only
- 5-7: Acceptable, some issues
- 3-4: Poor, major issues
- 0-2: Bad, multiple major issues

**OUTPUT**: Return your COMPLETE analysis as JSON (no other text):
\`\`\`json
{
  "subject_mapping": [
    {"figure": 1, "position": "...", "frame": "...", "hair": "...", "attire": "...", "activity": "...", "perspective": "..."}
  ],
  "identity_sync": [
    {"figure": 1, "matched_reference": "...", "hair_match": "...", "attire_audit": "...", "issues": []}
  ],
  "rendering_integrity": {
    "extremities": [{"figure": 1, "hand": "left", "digit_count": "1,2,3,4,5 = 5", "status": "OK"}],
    "anatomy": ["..."],
    "environment": ["..."]
  },
  "scene_check": {
    "characters_present": ["Name (yes/missing)"],
    "style_unity": "...",
    "narrative_match": "..."
  },
  "score": 7,
  "verdict": "PASS",
  "issues_summary": "brief summary of issues",
  "fix_targets": [{"bbox": [ymin, xmin, ymax, xmax], "issue": "brief", "fix": "what to render"}]
}
\`\`\`

**RULES:**
- fix_targets: only if score < 8 and issues are fixable by re-rendering a region
- bbox: normalized 0.0-1.0, format [ymin, xmin, ymax, xmax], origin top-left`;

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

      // Parse fix_targets from JSON if present (overrides text-based parsing)
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
          log.info(`⭐ [QUALITY] Parsed ${jsonFixTargets.length} fix targets from JSON`);
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

      return {
        score,
        rawScore, // Original 0-10 score
        verdict,
        reasoning,
        issuesSummary, // Brief summary for quick display
        textIssue,
        fixTargets: jsonFixTargets,
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens, thinking_tokens: qualityThinkingTokens },
        modelId: modelId
      };
    }

    // Parse "Score: X/10" format (new simplified format)
    const score10Match = responseText.match(/Score:\s*(\d+)\/10\b/i);
    if (score10Match) {
      const rawScore = parseInt(score10Match[1]);
      const score = rawScore * 10; // Convert 0-10 to 0-100 for compatibility
      log.verbose(`⭐ [QUALITY] Image quality score: ${rawScore}/10 (${score}/100)`);
      return {
        score,
        reasoning: responseText,
        fixTargets, // Bounding boxes for auto-repair
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens, thinking_tokens: qualityThinkingTokens },
        modelId: modelId
      };
    }

    // Fallback: Parse legacy format "Score: XX/100"
    const scoreMatch = responseText.match(/Score:\s*(\d+)\/100/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1]);
      log.verbose(`⭐ [QUALITY] Image quality score: ${score}/100 (legacy format)`);
      return {
        score,
        reasoning: responseText,
        fixTargets, // Bounding boxes for auto-repair
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens, thinking_tokens: qualityThinkingTokens },
        modelId: modelId
      };
    }

    // Fallback: Try parsing just a number (0-100)
    const numericScore = parseFloat(responseText);
    if (!isNaN(numericScore) && numericScore >= 0 && numericScore <= 100) {
      log.verbose(`⭐ [QUALITY] Image quality score: ${numericScore}/100 (numeric format)`);
      return {
        score: numericScore,
        reasoning: responseText,
        fixTargets, // Bounding boxes for auto-repair
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens, thinking_tokens: qualityThinkingTokens },
        modelId: modelId
      };
    }

    log.warn(`⚠️  [QUALITY] Could not parse score from response (finishReason=${finishReason}, ${responseText.length} chars):`, responseText.substring(0, 200));
    return null;
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
    return null;
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
 * @param {Array<{name: string, photoData: string}>} landmarkPhotos - Landmark reference photos for real-world locations
 * @returns {Promise<{imageData, score, reasoning, modelId, ...}>}
 */
async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, imageModelOverride = null, qualityModelOverride = null, pageContext = '', imageBackendOverride = null, landmarkPhotos = [], sceneCharacterCount = 0) {
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

      // If LLM ignored 3-character limit, provide ALL reference photos
      const useAllRefs = sceneCharacterCount > 3;
      const finalReferenceImages = useAllRefs ? referenceImages : referenceImages.slice(0, 3);
      if (useAllRefs && referenceImages.length > 3) {
        log.info(`🎭 [IMAGE GEN] Scene has ${sceneCharacterCount} characters (>3), using ALL ${referenceImages.length} reference photos`);
      }

      const result = await generateWithRunware(prompt, {
        model: RUNWARE_MODELS.FLUX_SCHNELL,
        width: 1024,
        height: 1024,
        steps: 4,
        referenceImages: finalReferenceImages
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

    // Add numbered label for clarity
    parts.push({ text: `[Image ${currentImageIndex} - Previous scene]:` });
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

        // Add numbered label BEFORE the image (matches reference map in prompt)
        const labelName = characterName || `Character ${addedCount + 1}`;
        parts.push({ text: `[Image ${currentImageIndex} - ${labelName}]:` });
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

  // Add landmark reference photos for real-world locations (e.g., Eiffel Tower, Big Ben)
  if (landmarkPhotos && landmarkPhotos.length > 0) {
    let landmarkAddedCount = 0;
    for (const landmark of landmarkPhotos) {
      if (landmark.photoData && landmark.photoData.startsWith('data:image')) {
        const base64Data = landmark.photoData.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = landmark.photoData.match(/^data:(image\/\w+);base64,/) ?
          landmark.photoData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

        // Add numbered label before the image (matches reference map in prompt)
        parts.push({ text: `[Image ${currentImageIndex} - ${landmark.name} (landmark)]:` });
        parts.push({
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        });
        currentImageIndex++;
        landmarkAddedCount++;
        log.debug(`🌍 [IMAGE GEN] Added landmark reference: ${landmark.name}`);
      }
    }
    if (landmarkAddedCount > 0) {
      log.info(`🌍 [IMAGE GEN] Added ${landmarkAddedCount} landmark reference photo(s)`);
    }
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
        referenceImages: referenceImages.slice(0, 3)
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

  const requestBody = {
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.8,
      imageConfig: {
        aspectRatio: "1:1"
      }
    }
  };

  log.debug(`🖼️  [IMAGE GEN] Calling Gemini API with prompt (${prompt.length} chars), scene: ${prompt.substring(0, 80).replace(/\n/g, ' ')}...`);
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: 1:1, Temperature: 0.8`);

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
          modelId,  // Include which model was used for image generation
          qualityModelId,  // Include which model was used for quality evaluation
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
    throw new Error(`Image blocked by API: reason=${reason}, message=${message}`);
  }

  log.error('❌ [IMAGE GEN] No image data found in any part');
  throw new Error('No image data in response - check logs for API response structure');
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

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          temperature: 0.6,
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
    log.debug(`📊 [IMAGE EDIT] Token usage - input: ${inputTokens}, output: ${outputTokens}, model: ${modelId}`);

    // Log response structure for debugging
    log.debug('✏️  [IMAGE EDIT] Response structure:', {
      hasCandidates: !!data.candidates,
      candidatesCount: data.candidates?.length || 0,
      responseKeys: Object.keys(data)
    });

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
          return { imageData: editedImageData, usage: { inputTokens, outputTokens, model: modelId } };
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
 * @param {Object} options - Additional options: { isAdmin, landmarkPhotos }
 * @returns {Promise<{imageData, score, reasoning, wasRegenerated, retryHistory, totalAttempts}>}
 */
async function generateImageWithQualityRetry(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, usageTracker = null, callTextModel = null, modelOverrides = null, pageContext = '', options = {}) {
  const {
    isAdmin = false,
    enableAutoRepair = false,
    landmarkPhotos = [],
    sceneCharacterCount = 0,
    // Incremental consistency options
    incrementalConsistency = null,  // { enabled, dryRun, lookbackCount, previousImages, ... }
  } = options;
  // MAX ATTEMPTS: 3 for both covers and scenes (allows 2 retries after initial attempt)
  const MAX_ATTEMPTS = 3;
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
      result = await callGeminiAPIForImage(currentPrompt, characterPhotos, previousImage, evaluationType, onImageReady, imageModelOverride, qualityModelOverride, pageContext, imageBackendOverride, landmarkPhotos, sceneCharacterCount);
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
      return {
        ...result,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts,
        evalSkipped: true,
        score: null
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
      shouldRepair = !hasTextError && score <= AUTO_REPAIR_THRESHOLD && result.fixTargets && result.fixTargets.length > 0;
      fixTargetsToUse = result.fixTargets || [];
    }

    const couldRepair = shouldRepair && fixTargetsToUse.length > 0;
    if (couldRepair && !enableAutoRepair) {
      log.debug(`⏭️ [QUALITY RETRY] ${pageLabel}Auto-repair skipped (disabled). ${fixTargetsToUse.length} fix targets available.`);
    }
    if (enableAutoRepair && couldRepair) {
      const repairSource = incrEnabled ? 'unified (quality + consistency)' : 'quality';
      log.info(`🔧 [QUALITY RETRY] ${pageLabel}Attempting auto-repair on ${fixTargetsToUse.length} fix targets (${repairSource})...`);
      try {
        // Inpainting uses text-based coordinates instead of mask images
        // This avoids confusion when there are multiple similar elements
        const repairResult = await autoRepairWithTargets(
          result.imageData,
          fixTargetsToUse,
          0,  // No additional inspection attempts
          { includeDebugImages: isAdmin }  // Include before/after images for admin users
        );

        if (repairResult.repaired && repairResult.imageData !== result.imageData) {
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
              type: 'auto_repair',
              preRepairScore: score,
              postRepairScore: repairedScore,
              fixTargetsCount: result.fixTargets.length,
              imageData: repairResult.imageData,
              repairUsage: repairResult.usage,
              reEvalUsage: reEvalResult.usage,
              // Full evaluation data for dev mode
              preRepairEval: {
                score: result.score,
                reasoning: result.reasoning,
                fixTargets: result.fixTargets
              },
              postRepairEval: {
                score: reEvalResult.score,
                reasoning: reEvalResult.reasoning,
                fixTargets: reEvalResult.fixTargets
              },
              // Repair details from autoRepairWithTargets
              repairDetails: repairResult.repairHistory || [],
              timestamp: new Date().toISOString()
            });

            // Update result with repaired image if improved
            if (repairedScore > score) {
              result = {
                ...result,
                imageData: repairResult.imageData,
                score: repairedScore,
                reasoning: reEvalResult.reasoning,
                wasRepaired: true,
                fixTargets: reEvalResult.fixTargets || [],  // Use new fix targets from re-eval
                repairHistory: repairResult.repairHistory || []  // Include repair details
              };
              score = repairedScore;  // Update score for threshold check
              log.info(`✅ [QUALITY RETRY] Using repaired image (score improved from ${retryHistory[retryHistory.length - 1].preRepairScore}% to ${score}%)`);
            }

            // Update best result if this is now best
            if (score > bestScore) {
              bestScore = score;
              bestResult = result;
            }
          }
        } else {
          log.info(`ℹ️  [QUALITY RETRY] Auto-repair did not change the image`);
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
      return {
        ...result,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts
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
  return {
    ...bestResult,
    wasRegenerated: true,
    retryHistory: retryHistory,
    totalAttempts: attempts
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

/**
 * Get image dimensions from base64 data
 * @param {string} imageData - Base64 image data URL
 * @returns {Promise<{width: number, height: number}>}
 */
async function getImageDimensions(imageData) {
  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  const metadata = await sharp(buffer).metadata();
  return { width: metadata.width, height: metadata.height };
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
  const [ymin, xmin, ymax, xmax] = bbox;

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
 * @param {Array} fixTargets - Array of {boundingBox, issue, fixPrompt}
 * @returns {Object} Grouped targets: { faceTargets, anatomyTargets, objectTargets }
 */
function groupFixTargetsForInpainting(fixTargets) {
  const faceTargets = [];
  const anatomyTargets = [];
  const objectTargets = [];

  for (const target of fixTargets) {
    const issueType = classifyIssueType(target.issue);

    // Apply adaptive padding to bounding box
    const paddedBbox = padBoundingBox(target.boundingBox, issueType);
    const paddedTarget = { ...target, boundingBox: paddedBbox, issueType };

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

    const data = await withRetry(async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            temperature: 0.6
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

      for (const part of responseParts) {
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const rawImageData = `data:${respMimeType};base64,${inlineData.data}`;

          // Compress inpainted image to JPEG (same as initial generation)
          log.debug('🗜️  [INPAINT] Compressing repaired image to JPEG...');
          const compressedImageData = await compressImageToJPEG(rawImageData);

          log.info(`✅ [INPAINT] Successfully inpainted image (tokens: ${usage.input_tokens} in, ${usage.output_tokens} out)`);
          return { imageData: compressedImageData, usage, modelId, fullPrompt: inpaintPrompt };
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

        // Run targeted verification in background (non-blocking for performance)
        // Verification results stored for dev mode display
        if (includeDebugImages) {
          historyEntry.maskImage = mask;
          historyEntry.beforeImage = currentImage;
          historyEntry.afterImage = repaired.imageData;

          // Run verification and add results to history entry
          try {
            const verification = await verifyInpaintResult(currentImage, repaired.imageData, targets);
            historyEntry.verification = verification;
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

  // Sum up total usage from all repair attempts
  const totalUsage = repairHistory.reduce((acc, r) => {
    if (r.usage) {
      acc.input_tokens += r.usage.input_tokens || 0;
      acc.output_tokens += r.usage.output_tokens || 0;
      acc.thinking_tokens += r.usage.thinking_tokens || 0;
    }
    return acc;
  }, { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

  log.info(`✅ [AUTO-REPAIR] Targeted repair complete: ${successCount > 0 ? 'success' : 'failed'} (total tokens: ${totalUsage.input_tokens} in, ${totalUsage.output_tokens} out)`);

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
    IMAGE_INFO: imageInfo
  });

  // Build parts array with all images
  const parts = [];

  // Add reference photos first (if doing character check)
  if (checkType === 'character' && options.referencePhotos?.length > 0) {
    for (const refPhoto of options.referencePhotos.slice(0, 3)) {
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
            // Convert batch-local indices (1-based) to actual page numbers
            if (issue.images && Array.isArray(issue.images)) {
              issue.images = issue.images.map(localIdx => {
                // localIdx is 1-based index within the batch
                const batchIdx = localIdx - 1;
                if (batchIdx >= 0 && batchIdx < batch.images.length) {
                  return batch.images[batchIdx].pageNumber;
                }
                return localIdx; // Fallback
              });
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
    const fullCheck = await evaluateConsistencyAcrossImages(imagesWithPages, 'full');
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
      for (const character of characters.slice(0, 3)) { // Limit to 3 main characters
        const charName = character.name;
        const charPhoto = character.photoUrl || character.photo;

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

  // Build clothing info string
  const clothingLines = [];
  const characterSet = new Set();
  for (const img of imagesToCompare) {
    if (img.characterClothing) {
      for (const [charName, clothing] of Object.entries(img.characterClothing)) {
        characterSet.add(charName);
        clothingLines.push(`- ${charName} (Page ${img.pageNumber}): ${clothing}`);
      }
    } else if (img.characters && img.clothing) {
      for (const char of img.characters) {
        characterSet.add(char);
      }
      clothingLines.push(`- All characters (Page ${img.pageNumber}): ${img.clothing}`);
    }
  }

  const characters = Array.from(characterSet).join(', ') || 'Unknown';
  const clothingInfo = clothingLines.length > 0 ? clothingLines.join('\n') : 'No specific clothing information';

  // Fill template
  const prompt = fillTemplate(promptTemplate, {
    PAGE_NUMBER: currentPageNumber,
    IMAGE_COUNT: imagesToCompare.length + 1,
    PREV_PAGES: prevPageNumbers,
    CHARACTERS: characters,
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
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);

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

  // Cache management
  clearImageCache,
  deleteFromImageCache,
  getImageCacheSize,

  // Auto-repair functions
  inspectImageForErrors,
  createMaskFromBoundingBox,
  createCombinedMask,
  calculateMaskCoverage,
  inpaintWithMask,
  autoRepairImage,
  autoRepairWithTargets,

  // Final consistency checks
  evaluateConsistencyAcrossImages,
  runFinalConsistencyChecks,

  // Incremental consistency checks
  evaluateIncrementalConsistency,
  mergeEvaluationIssues,
  logDryRunReport,
  INCREMENTAL_CONSISTENCY_DEFAULTS,

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD,
  MAX_MASK_COVERAGE_PERCENT
};
