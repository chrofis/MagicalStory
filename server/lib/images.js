/**
 * Image Generation Module
 * Handles image generation, quality evaluation, editing, and retry logic
 * Extracted from server.js for maintainability
 */

const sharp = require('sharp');
const crypto = require('crypto');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

// Image cache to avoid regenerating identical images
const imageCache = new Map();

// Cache for compressed reference images (to avoid re-compressing same photo/avatar)
const compressedRefCache = new Map();

// Quality threshold from environment or default
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || 50;

/**
 * Hash image data for comparison/caching
 * @param {string} imageData - Base64 image data URL
 * @returns {string} Short hash (8 characters)
 */
function hashImageData(imageData) {
  if (!imageData) return null;
  const data = imageData.replace(/^data:image\/\w+;base64,/, '');
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Generate cache key for image generation
 * Creates a hash from prompt + character photo hashes
 */
function generateImageCacheKey(prompt, characterPhotos = [], sequentialMarker = null) {
  // Hash each photo and sort them for consistency
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  const photoHashes = characterPhotos
    .map(p => typeof p === 'string' ? p : p?.photoUrl)
    .filter(url => url && url.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  // Combine prompt + photo hashes + sequential marker (to distinguish sequential vs parallel cache)
  const combined = `${prompt}|${photoHashes}|${sequentialMarker || ''}`;
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
async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene', qualityModelOverride = null) {
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
        if (photoUrl && photoUrl.startsWith('data:image')) {
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

    // Use Gemini Flash for fast quality evaluation (or override if provided)
    let modelId = qualityModelOverride || 'gemini-2.0-flash';
    if (qualityModelOverride) {
      log.debug(`🔧 [QUALITY] Using model override: ${modelId}`);
    }

    // Helper function to call the API
    const callQualityAPI = async (model) => {
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
      log.warn(`⚠️  [QUALITY] Model ${modelId} failed (HTTP ${response.status}), falling back to gemini-2.0-flash. Error: ${error.substring(0, 200)}`);
      modelId = 'gemini-2.0-flash';
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
      log.warn(`⚠️  [QUALITY] Content blocked by ${modelId} (${blockReason}), retrying with sanitized prompt...`);

      // Create a SANITIZED prompt that removes potentially triggering content:
      // - No detailed physical descriptions (age, body type, etc.)
      // - No mention of "children" or ages
      // - Focus purely on artistic/technical quality
      // - KEEP the FIX_TARGETS format for auto-repair functionality
      const sanitizedPrompt = `You are evaluating an AI-generated cartoon illustration for artistic quality.

**TASK**: Check the artistic quality of this illustration. Compare illustrated characters to reference photos if provided.

**EVALUATION CRITERIA**:
1. Art Quality - Is it well-rendered with no visual artifacts?
2. Character Consistency - Do illustrated characters match the reference photos? (hair, clothing, general features)
3. Scene Composition - Is the scene well-composed?
4. Technical Quality - Check for:
   - Extra or missing fingers (should be 5 per hand)
   - Distorted faces or merged features
   - Extra/missing limbs
   - Floating objects or disconnected body parts

**SCORING (0-10)**:
- 10: Perfect, no issues
- 8-9: Good, minor issues only
- 5-7: Acceptable, some issues
- 3-4: Poor, major issues
- 0-2: Bad, multiple major issues

**OUTPUT FORMAT**:
Scene: [Brief description of what's shown]

Artifact Scan:
- Hands: [OK / count fingers, note issues]
- Faces: [OK / issues found]
- Floating objects: [None / describe]

Quality Issues: [List problems, or "None"]

Score: [0-10]/10
Verdict: [PASS if 5+, SOFT_FAIL if 3-4, HARD_FAIL if 0-2]

FIX_TARGETS: [Only if Score < 8 and fixable issues exist. One JSON per line]
{"bbox": [ymin, xmin, ymax, xmax], "issue": "brief issue", "fix": "what to draw instead"}

**BOUNDING BOX FORMAT:**
- Coordinates are normalized 0.0-1.0 (not pixels)
- Format: [ymin, xmin, ymax, xmax] where 0,0 is top-left`;

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
          log.info(`✅ [QUALITY] Sanitized prompt retry succeeded with ${modelId}`);
          data = retryData;
        } else {
          // Still blocked, now fall back to 2.0
          log.warn(`⚠️  [QUALITY] Sanitized prompt still blocked, falling back to gemini-2.0-flash...`);
          modelId = 'gemini-2.0-flash';
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
        log.warn(`⚠️  [QUALITY] Sanitized prompt HTTP error, falling back to gemini-2.0-flash...`);
        modelId = 'gemini-2.0-flash';
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
      // New JSON format with 0-10 scale
      const rawScore = parsedJson.score;
      const score = rawScore * 10; // Convert 0-10 to 0-100 for compatibility
      const verdict = parsedJson.final_verdict || 'UNKNOWN';
      const reasoning = parsedJson.reasoning || '';
      const analysis = parsedJson.analysis || null;
      const evaluation = parsedJson.evaluation || {};

      log.verbose(`⭐ [QUALITY] Score: ${rawScore}/10 (${score}/100), Verdict: ${verdict}`);
      if (reasoning) {
        log.verbose(`⭐ [QUALITY] Reasoning: ${reasoning}`);
      }
      if (analysis?.defects && analysis.defects !== 'None') {
        log.verbose(`⭐ [QUALITY] Defects: ${analysis.defects}`);
      }

      // For covers, check if there are text issues in the analysis
      let textIssue = null;
      if (evaluationType === 'cover' && analysis?.defects) {
        const defects = analysis.defects.toLowerCase();
        if (defects.includes('text') || defects.includes('spell') || defects.includes('letter')) {
          textIssue = 'TEXT_ERROR';
        }
      }

      return {
        score,
        rawScore, // Original 0-10 score
        verdict,
        reasoning: responseText,
        analysis,
        evaluation,
        textIssue,
        fixTargets, // Bounding boxes for auto-repair
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
    console.log(`✅ [REWRITE] Scene rewritten: ${rewrittenScene.substring(0, 100)}...`);
    return rewrittenScene.trim();
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
 * @returns {Promise<{imageData, score, reasoning, modelId, ...}>}
 */
async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, imageModelOverride = null, qualityModelOverride = null) {
  // Check cache first (include previousImage presence in cache key for sequential mode)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null);

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

  // Call Gemini API for image generation with optional character reference images
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Build parts array with prompt + reference images
  const parts = [{ text: prompt }];

  // For sequential mode: Add PREVIOUS scene image FIRST (most important for continuity)
  // Crop the image slightly to change aspect ratio - this forces AI to regenerate
  // rather than copying too much from the reference image
  if (previousImage && previousImage.startsWith('data:image')) {
    // Crop 15% from top and bottom to change aspect ratio
    const croppedImage = await cropImageForSequential(previousImage);

    const base64Data = croppedImage.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
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
      const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      const characterName = typeof photoData === 'object' ? photoData?.name : null;
      const providedHash = typeof photoData === 'object' ? photoData?.photoHash : null;

      if (photoUrl && photoUrl.startsWith('data:image')) {
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

        // Option A: Add text label BEFORE the image if we have a name
        if (characterName) {
          parts.push({ text: `[Reference photo of ${characterName}]:` });
          characterNames.push(characterName);
        }

        parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: compressedBase64
          }
        });
        addedCount++;
      } else {
        skippedCount++;
        // Log warning for skipped photos to help diagnose issues
        const preview = photoUrl ? photoUrl.substring(0, 50) : 'null/undefined';
        log.warn(`[IMAGE GEN] Skipping character photo ${addedCount + skippedCount}: not a valid data URL (starts with: ${preview}...)`);
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

  // Use model override if provided, otherwise default based on type:
  // - Covers: Gemini 3 Pro Image (higher quality)
  // - Scenes: Gemini 2.5 Flash Image (faster)
  const defaultModel = evaluationType === 'cover' ? 'gemini-3-pro-image-preview' : 'gemini-2.5-flash-image';
  const modelId = imageModelOverride || defaultModel;
  if (imageModelOverride) {
    log.debug(`🔧 [IMAGE GEN] Using model override: ${modelId}`);
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

  log.debug('🖼️  [IMAGE GEN] Calling Gemini API with prompt:', prompt.substring(0, 100) + '...');
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: 1:1, Temperature: 0.8`);

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
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();

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

        // Evaluate image quality with prompt and reference images
        log.debug(`⭐ [QUALITY] Evaluating image quality (${evaluationType})...${qualityModelOverride ? ` [model: ${qualityModelOverride}]` : ''}`);
        const qualityResult = await evaluateImageQuality(compressedImageData, prompt, characterPhotos, evaluationType, qualityModelOverride);

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

    // Use Gemini 2.5 Flash Image for editing (optimized for pixel-level manipulation and inpainting)
    const modelId = 'gemini-2.5-flash-image';
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
          console.log(`✅ [IMAGE EDIT] Successfully edited image`);
          return { imageData: editedImageData };
        }
      }
    }

    log.warn('⚠️  [IMAGE EDIT] No edited image in response');
    return null;
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
 * @param {Object|null} modelOverrides - Model overrides: { imageModel, qualityModel }
 * @returns {Promise<{imageData, score, reasoning, wasRegenerated, retryHistory, totalAttempts}>}
 */
async function generateImageWithQualityRetry(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, usageTracker = null, callTextModel = null, modelOverrides = null) {
  // MAX ATTEMPTS: 3 for both covers and scenes (allows 2 retries after initial attempt)
  const MAX_ATTEMPTS = 3;
  let bestResult = null;
  let bestScore = -1;
  let attempts = 0;
  let currentPrompt = prompt;
  let wasSceneRewritten = false;

  // Store all attempts for dev mode
  const retryHistory = [];

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    log.debug(`🎨 [QUALITY RETRY] Attempt ${attempts}/${MAX_ATTEMPTS} (threshold: ${IMAGE_QUALITY_THRESHOLD}%)...`);

    // Clear cache for retries to force new generation
    if (attempts > 1) {
      const cacheKey = generateImageCacheKey(currentPrompt, characterPhotos, previousImage ? 'seq' : null);
      imageCache.delete(cacheKey);
    }

    let result;
    try {
      const imageModelOverride = modelOverrides?.imageModel || null;
      const qualityModelOverride = modelOverrides?.qualityModel || null;
      result = await callGeminiAPIForImage(currentPrompt, characterPhotos, previousImage, evaluationType, onImageReady, imageModelOverride, qualityModelOverride);
      // Track usage if tracker provided
      if (usageTracker && result) {
        usageTracker(result.imageUsage, result.qualityUsage, result.modelId, result.qualityModelId);
      }
    } catch (error) {
      // Check if this is a safety/content block error
      const errorMsg = error.message.toLowerCase();
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                           errorMsg.includes('prohibited') || errorMsg.includes('filtered');

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
            const rewrittenScene = await rewriteBlockedScene(originalScene, callTextModel);

            // Replace scene in prompt
            currentPrompt = currentPrompt.replace(originalScene, rewrittenScene);
            wasSceneRewritten = true;

            // Record the rewrite attempt
            retryHistory.push({
              attempt: attempts,
              type: 'safety_block_rewrite',
              originalScene: originalScene.substring(0, 200),
              rewrittenScene: rewrittenScene.substring(0, 200),
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
    const score = evalWasBlocked ? null : result.score;

    if (evalWasBlocked) {
      log.debug(`⭐ [QUALITY RETRY] Attempt ${attempts}: quality eval was blocked/failed`);
    } else {
      log.debug(`⭐ [QUALITY RETRY] Attempt ${attempts} score: ${score}%`);
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

    // Store this attempt in history
    retryHistory.push({
      attempt: attempts,
      type: 'generation',
      score: score,
      evalSkipped: evalWasBlocked,
      reasoning: result.reasoning,
      textIssue: result.textIssue,
      expectedText: result.expectedText,
      actualText: result.actualText,
      imageData: result.imageData,
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
      log.warn(`⚠️  [QUALITY RETRY] Accepting image (quality eval was blocked/failed after fallback)`);
      return {
        ...result,
        wasRegenerated: attempts > 1,
        retryHistory: retryHistory,
        totalAttempts: attempts,
        evalSkipped: true,
        score: null
      };
    }

    // Check if quality is good enough (and no text errors for covers)
    if (score >= IMAGE_QUALITY_THRESHOLD && !hasTextError) {
      console.log(`✅ [QUALITY RETRY] Success on attempt ${attempts}! Score ${score}% >= ${IMAGE_QUALITY_THRESHOLD}%${wasSceneRewritten ? ' (scene was rewritten for safety)' : ''}`);
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
      log.debug(`⚠️  [QUALITY RETRY] Score ${score}% < ${IMAGE_QUALITY_THRESHOLD}%, retrying...`);
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

    // Use Gemini 2.0 Flash for fast analysis
    const modelId = 'gemini-2.0-flash';
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
              fixPrompt: result.fix_prompt
            };
          } else {
            log.info('🔍 [INSPECT] No errors detected');
            return { errorFound: false };
          }
        } catch (parseError) {
          log.warn('⚠️ [INSPECT] Failed to parse JSON response:', parseError.message);
          return { errorFound: false };
        }
      }
    }

    log.warn('⚠️ [INSPECT] No valid response from inspection');
    return { errorFound: false };
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
 * Inpaint an image using a mask and fix prompt
 * @param {string} originalImage - Base64 original image
 * @param {string} maskImage - Base64 mask (white = area to fix)
 * @param {string} fixPrompt - Instruction for what to fix
 * @returns {Promise<{imageData: string}|null>}
 */
async function inpaintWithMask(originalImage, maskImage, fixPrompt) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    log.debug(`🔧 [INPAINT] Inpainting with prompt: "${fixPrompt}"`);

    // Extract base64 and mime type for original image
    const origBase64 = originalImage.replace(/^data:image\/\w+;base64,/, '');
    const origMimeType = originalImage.match(/^data:(image\/\w+);base64,/) ?
      originalImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Extract base64 for mask
    const maskBase64 = maskImage.replace(/^data:image\/\w+;base64,/, '');

    // Build the inpainting prompt
    const inpaintPrompt = `Edit this image. The white area in the mask shows what needs to be changed.

CHANGE ONLY THE MASKED AREA: ${fixPrompt}

Keep everything outside the masked area exactly the same. Maintain the same art style and colors.`;

    // Build parts array: prompt, original image, mask
    const parts = [
      { text: inpaintPrompt },
      {
        inline_data: {
          mime_type: origMimeType,
          data: origBase64
        }
      },
      { text: '[MASK - white area shows what to edit]:' },
      {
        inline_data: {
          mime_type: 'image/png',
          data: maskBase64
        }
      }
    ];

    // Use Gemini 2.5 Flash Image for editing
    const modelId = 'gemini-2.5-flash-image';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

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
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const responseParts = data.candidates[0].content.parts;

      for (const part of responseParts) {
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const editedImageData = `data:${respMimeType};base64,${inlineData.data}`;
          log.info('✅ [INPAINT] Successfully inpainted image');
          return { imageData: editedImageData };
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
 * @param {string} imageData - Base64 image data URL
 * @param {Array} fixTargets - Array of {boundingBox, issue, fixPrompt} from evaluation
 * @param {number} maxAdditionalAttempts - Extra inspection-based attempts after combined fix (default 0)
 * @returns {Promise<{imageData: string, repaired: boolean, repairHistory: Array}>}
 */
async function autoRepairWithTargets(imageData, fixTargets, maxAdditionalAttempts = 0) {
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

  log.info(`🔄 [AUTO-REPAIR] Combining ${fixTargets.length} fix targets into ONE repair call...`);

  try {
    // Get image dimensions
    const dimensions = await getImageDimensions(currentImage);

    // Collect all bounding boxes
    const boundingBoxes = fixTargets.map(t => t.boundingBox);

    // Create combined mask with ALL regions
    const combinedMask = await createCombinedMask(
      dimensions.width,
      dimensions.height,
      boundingBoxes
    );

    // Build combined fix prompt with numbered issues
    const combinedPrompt = fixTargets.length === 1
      ? fixTargets[0].fixPrompt
      : `Fix the following issues in the masked areas:\n${fixTargets.map((t, i) => `${i + 1}. ${t.fixPrompt}`).join('\n')}`;

    log.debug(`🔄 [AUTO-REPAIR] Combined prompt: ${combinedPrompt}`);

    // Single inpaint call for ALL fixes
    const repaired = await inpaintWithMask(
      currentImage,
      combinedMask,
      combinedPrompt
    );

    if (!repaired || !repaired.imageData) {
      log.warn(`⚠️ [AUTO-REPAIR] Combined inpainting failed for ${fixTargets.length} targets`);
      repairHistory.push({
        attempt: 1,
        errorType: 'combined-pre-computed',
        description: fixTargets.map(t => t.issue).join('; '),
        boundingBoxes: boundingBoxes,
        fixPrompt: combinedPrompt,
        maskImage: combinedMask,
        beforeImage: currentImage,
        afterImage: null,
        success: false,
        skippedInspection: true,
        targetCount: fixTargets.length,
        timestamp: new Date().toISOString()
      });
    } else {
      // Record successful combined repair
      repairHistory.push({
        attempt: 1,
        errorType: 'combined-pre-computed',
        description: fixTargets.map(t => t.issue).join('; '),
        boundingBoxes: boundingBoxes,
        fixPrompt: combinedPrompt,
        maskImage: combinedMask,
        beforeImage: currentImage,
        afterImage: repaired.imageData,
        success: true,
        skippedInspection: true,
        targetCount: fixTargets.length,
        timestamp: new Date().toISOString()
      });

      currentImage = repaired.imageData;
      log.info(`✅ [AUTO-REPAIR] Fixed ${fixTargets.length} targets in ONE API call`);
    }
  } catch (error) {
    log.error(`❌ [AUTO-REPAIR] Combined repair failed:`, error.message);
    repairHistory.push({
      attempt: 1,
      errorType: 'combined-pre-computed',
      description: `Error: ${error.message}`,
      success: false,
      targetCount: fixTargets.length,
      timestamp: new Date().toISOString()
    });
  }

  // Phase 2: Optional additional inspection-based repairs
  if (maxAdditionalAttempts > 0) {
    log.debug(`🔄 [AUTO-REPAIR] Running ${maxAdditionalAttempts} additional inspection-based attempts...`);
    const additionalResult = await autoRepairImage(currentImage, maxAdditionalAttempts);
    if (additionalResult.repaired) {
      currentImage = additionalResult.imageData;
      repairHistory.push(...additionalResult.repairHistory);
    }
  }

  const successCount = repairHistory.filter(r => r.success).length;
  log.info(`✅ [AUTO-REPAIR] Targeted repair complete: ${successCount > 0 ? 'success' : 'failed'}`);

  return {
    imageData: currentImage,
    repaired: successCount > 0,
    noErrorsFound: false,
    repairHistory
  };
}

/**
 * Auto-repair an image by detecting and fixing physics errors
 * Runs up to maxAttempts cycles of inspect → mask → fix
 * @param {string} imageData - Base64 image data URL
 * @param {number} maxAttempts - Maximum repair cycles (default 2)
 * @returns {Promise<{imageData: string, repaired: boolean, repairHistory: Array}>}
 */
async function autoRepairImage(imageData, maxAttempts = 2) {
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

    // 2. Get image dimensions and create mask
    const dimensions = await getImageDimensions(currentImage);
    const mask = await createMaskFromBoundingBox(
      dimensions.width,
      dimensions.height,
      inspection.boundingBox
    );

    // 3. Inpaint the masked area
    const repaired = await inpaintWithMask(
      currentImage,
      mask,
      inspection.fixPrompt
    );

    if (!repaired || !repaired.imageData) {
      log.warn(`⚠️ [AUTO-REPAIR] Inpainting failed at attempt ${attempt}`);
      repairHistory.push({
        attempt,
        errorType: inspection.errorType,
        description: inspection.description,
        boundingBox: inspection.boundingBox,
        fixPrompt: inspection.fixPrompt,
        maskImage: mask,
        beforeImage: currentImage,
        afterImage: null,
        success: false,
        timestamp: new Date().toISOString()
      });
      break;
    }

    // Record the repair
    repairHistory.push({
      attempt,
      errorType: inspection.errorType,
      description: inspection.description,
      boundingBox: inspection.boundingBox,
      fixPrompt: inspection.fixPrompt,
      maskImage: mask,
      beforeImage: currentImage,
      afterImage: repaired.imageData,
      success: true,
      timestamp: new Date().toISOString()
    });

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
  inpaintWithMask,
  autoRepairImage,
  autoRepairWithTargets,

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD
};
