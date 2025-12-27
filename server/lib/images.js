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
 * @returns {Promise<string>} Base64 encoded JPEG image with data URI prefix
 */
async function compressImageToJPEG(pngBase64) {
  try {
    // Remove data URI prefix if present
    const base64Data = pngBase64.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get original size
    const originalSizeKB = (imageBuffer.length / 1024).toFixed(2);

    // Compress to JPEG with quality 85 (good balance between quality and size)
    const compressedBuffer = await sharp(imageBuffer)
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    // Convert back to base64
    const compressedBase64 = compressedBuffer.toString('base64');
    const compressedSizeKB = (compressedBuffer.length / 1024).toFixed(2);

    log.debug(`🗜️  [COMPRESSION] PNG ${originalSizeKB} KB → JPEG ${compressedSizeKB} KB (${((1 - compressedBuffer.length / imageBuffer.length) * 100).toFixed(1)}% reduction)`);

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
            maxOutputTokens: 4000,  // Increased further to prevent MAX_TOKENS cutoff
            temperature: 0.3
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
          ]
        })
      });
    };

    let response = await callQualityAPI(modelId);

    // Fallback: If 2.5 model fails, try 2.0
    if (!response.ok && modelId.includes('2.5')) {
      const error = await response.text();
      log.warn(`⚠️  [QUALITY] Model ${modelId} failed, falling back to gemini-2.0-flash. Error: ${error.substring(0, 200)}`);
      modelId = 'gemini-2.0-flash';
      response = await callQualityAPI(modelId);
    }

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [QUALITY] Gemini API error:', error);
      return null;
    }

    const data = await response.json();

    // Extract and log token usage for quality evaluation
    const qualityInputTokens = data.usageMetadata?.promptTokenCount || 0;
    const qualityOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (qualityInputTokens > 0 || qualityOutputTokens > 0) {
      log.verbose(`📊 [QUALITY] Token usage - input: ${qualityInputTokens.toLocaleString()}, output: ${qualityOutputTokens.toLocaleString()}`);
    }

    // Log finish reason to diagnose early stops
    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      log.warn(`⚠️  [QUALITY] Gemini finish reason: ${finishReason}`);
    }

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      log.warn('⚠️  [QUALITY] No text response from Gemini');
      if (data.candidates?.[0]) {
        log.warn('⚠️  [QUALITY] Candidate info:', JSON.stringify({
          finishReason: data.candidates[0].finishReason,
          finishMessage: data.candidates[0].finishMessage,
          safetyRatings: data.candidates[0].safetyRatings
        }));
      } else if (data.promptFeedback) {
        // No candidates at all - likely blocked by safety
        log.warn('⚠️  [QUALITY] Prompt blocked:', JSON.stringify(data.promptFeedback));
      } else {
        log.warn('⚠️  [QUALITY] Unexpected response structure:', JSON.stringify(data).substring(0, 500));
      }
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

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
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens },
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
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens },
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
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens },
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
        usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens },
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
    log.verbose('💾 [IMAGE CACHE] Cache HIT - reusing previously generated image');
    log.debug('💾 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');
    log.debug('💾 [IMAGE CACHE] Cache size:', imageCache.size, 'images');
    const cachedResult = imageCache.get(cacheKey);
    // Call onImageReady for cache hits too (for progressive display)
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
        log.debug('📤 [IMAGE CACHE] Cached image sent for immediate display');
      } catch (callbackError) {
        log.error('⚠️ [IMAGE CACHE] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.verbose('🆕 [IMAGE CACHE] Cache MISS - generating new image');
  log.debug('🆕 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');

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

  // Extract token usage from response
  const imageUsage = {
    input_tokens: data.usageMetadata?.promptTokenCount || 0,
    output_tokens: data.usageMetadata?.candidatesTokenCount || 0
  };
  if (imageUsage.input_tokens > 0 || imageUsage.output_tokens > 0) {
    log.debug(`📊 [IMAGE GEN] Token usage - input: ${imageUsage.input_tokens.toLocaleString()}, output: ${imageUsage.output_tokens.toLocaleString()}`);
  }

  // Log response structure (without base64 data to avoid massive logs)
  log.debug('🖼️  [IMAGE GEN] Response structure:', {
    hasCandidates: !!data.candidates,
    candidatesCount: data.candidates?.length || 0,
    responseKeys: Object.keys(data)
  });

  if (!data.candidates || data.candidates.length === 0) {
    log.error('❌ [IMAGE GEN] No candidates in response. Response keys:', Object.keys(data));
    throw new Error('No image generated - no candidates in response');
  }

  // Extract image data
  const candidate = data.candidates[0];
  log.debug('🖼️  [IMAGE GEN] Candidate structure:', {
    hasContent: !!candidate.content,
    hasParts: !!candidate.content?.parts,
    partsCount: candidate.content?.parts?.length || 0,
    candidateKeys: Object.keys(candidate)
  });

  if (candidate.content && candidate.content.parts) {
    log.debug('🖼️  [IMAGE GEN] Found', candidate.content.parts.length, 'parts in candidate');
    for (const part of candidate.content.parts) {
      log.debug('🖼️  [IMAGE GEN] Part keys:', Object.keys(part));
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

        // Store in cache (include text error info for covers)
        const result = {
          imageData: compressedImageData,
          score,
          reasoning,
          textIssue,
          textErrorOnly,
          expectedText,
          actualText,
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
    log.error('❌ [IMAGE GEN] Unexpected candidate structure. Keys:', Object.keys(candidate));
    // Log the finishReason and finishMessage to understand why image was blocked
    if (candidate.finishReason) {
      log.error('🚫 [IMAGE GEN] FINISH REASON:', candidate.finishReason);
    }
    if (candidate.finishMessage) {
      log.error('🚫 [IMAGE GEN] FINISH MESSAGE:', candidate.finishMessage);
    }
    // Log the full candidate for debugging
    log.error('🚫 [IMAGE GEN] FULL CANDIDATE DUMP:', JSON.stringify(candidate, null, 2));

    // Throw with more context about why it failed
    const reason = candidate.finishReason || 'unknown';
    const message = candidate.finishMessage || 'no message';
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
        log.debug('✏️  [IMAGE EDIT] Part keys:', Object.keys(part));
        // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API varies
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const respMimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const editedImageData = `data:${respMimeType};base64,${inlineData.data}`;
          console.log(`✅ [IMAGE EDIT] Successfully edited image`);
          return { imageData: editedImageData };
        }
        if (part.text) {
          log.debug('✏️  [IMAGE EDIT] Text response:', part.text.substring(0, 200));
        }
      }
    } else if (data.candidates && data.candidates[0]) {
      const candidate = data.candidates[0];
      log.debug('✏️  [IMAGE EDIT] Candidate structure:', {
        hasContent: !!candidate.content,
        finishReason: candidate.finishReason,
        finishMessage: candidate.finishMessage
      });
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
    const score = result.score || 0;
    log.debug(`⭐ [QUALITY RETRY] Attempt ${attempts} score: ${score}%`);

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
      reasoning: result.reasoning,
      textIssue: result.textIssue,
      expectedText: result.expectedText,
      actualText: result.actualText,
      imageData: result.imageData,
      modelId: result.modelId,
      timestamp: new Date().toISOString()
    });

    // Track if this is the best so far
    if (score > bestScore) {
      bestScore = score;
      bestResult = result;
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
  console.log(`⚠️  [QUALITY RETRY] Max attempts (${MAX_ATTEMPTS}) reached. Using best result with score ${bestScore}%`);
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

  // Constants (for external access if needed)
  IMAGE_QUALITY_THRESHOLD
};
