/**
 * MagicAPI Integration
 *
 * Provides face swap and hair fix functionality using MagicAPI services.
 * Pipeline: crop face region -> face swap -> hair fix -> stitch back
 *
 * Features:
 * - Iterative crop checking: evaluates crop quality and adjusts up to 4 times
 * - Uses Gemini to analyze if face is properly centered and visible
 *
 * Pricing (approx):
 * - Face swap: ~$0.003/image
 * - Hair fix: ~$0.003/image
 * - Total: ~$0.006 per character repair (+ crop evaluation costs)
 */

const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MAGICAPI_KEY = process.env.MAGICAPI_KEY;
const FACESWAP_BASE = 'https://api.magicapi.dev/api/v1/magicapi/faceswap';
const HAIR_BASE = 'https://api.magicapi.dev/api/v1/magicapi/hair-v2';

// Free image hosting for MagicAPI (requires public URLs)
const FREEIMAGE_API_KEY = '6d207e02198a847aa98d0a2a901485a5';

/**
 * Upload a buffer to freeimage.host and return the public URL
 * MagicAPI requires public URLs for input images
 *
 * @param {Buffer} buffer - Image buffer to upload
 * @returns {Promise<string>} Public URL of uploaded image
 */
async function uploadToFreeImageHost(buffer) {
  const base64 = buffer.toString('base64');
  const formData = new URLSearchParams();
  formData.append('source', base64);
  formData.append('type', 'base64');
  formData.append('action', 'upload');

  const response = await fetch(`https://freeimage.host/api/1/upload?key=${FREEIMAGE_API_KEY}`, {
    method: 'POST',
    body: formData
  });

  const result = await response.json();
  if (!result.image?.url) {
    throw new Error(`Image upload failed: ${JSON.stringify(result)}`);
  }

  return result.image.url;
}

/**
 * Perform face swap using MagicAPI
 * Swaps the face from the source image onto the target image
 *
 * @param {Buffer} sourceBuffer - Source face image (avatar)
 * @param {Buffer} targetBuffer - Target image to swap face onto
 * @returns {Promise<Buffer>} Result image buffer
 */
async function faceSwap(sourceBuffer, targetBuffer) {
  if (!MAGICAPI_KEY) {
    throw new Error('MAGICAPI_KEY environment variable is not set');
  }

  log.info('[MAGICAPI] Starting face swap...');

  // Upload both images to get public URLs
  const [sourceUrl, targetUrl] = await Promise.all([
    uploadToFreeImageHost(sourceBuffer),
    uploadToFreeImageHost(targetBuffer)
  ]);

  log.debug(`[MAGICAPI] Uploaded images - source: ${sourceUrl.substring(0, 50)}..., target: ${targetUrl.substring(0, 50)}...`);

  // Submit face swap request
  const submitResp = await fetch(FACESWAP_BASE + '/faceswap-image', {
    method: 'POST',
    headers: {
      'x-magicapi-key': MAGICAPI_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        swap_image: sourceUrl,
        target_image: targetUrl
      }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.request_id) {
    log.error('[MAGICAPI] Face swap submit error:', submitResult);
    throw new Error(`Face swap submission failed: ${JSON.stringify(submitResult)}`);
  }

  log.debug(`[MAGICAPI] Face swap request_id: ${submitResult.request_id}`);

  // Poll for result
  let result = submitResult;
  let attempts = 0;
  const maxAttempts = 30; // 60 seconds max

  while (result.status !== 'processed' && result.status !== 'failed' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;

    const statusResp = await fetch(FACESWAP_BASE + '/result', {
      method: 'POST',
      headers: {
        'x-magicapi-key': MAGICAPI_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ request_id: submitResult.request_id })
    });
    result = await statusResp.json();
    log.debug(`[MAGICAPI] Face swap status: ${result.status} (attempt ${attempts})`);
  }

  if (result.status === 'failed') {
    throw new Error(`Face swap failed: ${JSON.stringify(result)}`);
  }

  if (result.status !== 'processed') {
    throw new Error(`Face swap timed out after ${maxAttempts * 2} seconds`);
  }

  // Download result image
  const imgResp = await fetch(result.output);
  const resultBuffer = Buffer.from(await imgResp.arrayBuffer());

  log.info('[MAGICAPI] Face swap completed successfully');
  return resultBuffer;
}

/**
 * Fix hair color/style using MagicAPI Hair V2
 *
 * @param {Buffer} imageBuffer - Image to fix hair on
 * @param {string} hairColor - Target hair color (e.g., "dark brown", "blonde")
 * @param {string} hairStyle - Target hair style (e.g., "short bangs above eyebrows forward")
 * @param {string} hairProperty - Hair texture (default: "textured")
 * @returns {Promise<Buffer>} Result image buffer
 */
async function fixHair(imageBuffer, hairColor, hairStyle, hairProperty = 'textured') {
  if (!MAGICAPI_KEY) {
    throw new Error('MAGICAPI_KEY environment variable is not set');
  }

  log.info(`[MAGICAPI] Starting hair fix - color: ${hairColor}, style: ${hairStyle}`);

  // Upload image to get public URL
  const imageUrl = await uploadToFreeImageHost(imageBuffer);
  log.debug(`[MAGICAPI] Uploaded image for hair fix: ${imageUrl.substring(0, 50)}...`);

  // Submit hair fix request
  const submitResp = await fetch(HAIR_BASE + '/run', {
    method: 'POST',
    headers: {
      'x-magicapi-key': MAGICAPI_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: {
        image: imageUrl,
        haircolor: hairColor,
        hairstyle: hairStyle,
        hairproperty: hairProperty
      }
    })
  });

  const submitResult = await submitResp.json();
  if (!submitResult.id) {
    log.error('[MAGICAPI] Hair fix submit error:', submitResult);
    throw new Error(`Hair fix submission failed: ${JSON.stringify(submitResult)}`);
  }

  log.debug(`[MAGICAPI] Hair fix job id: ${submitResult.id}`);

  // Poll for result
  let result = submitResult;
  let attempts = 0;
  const maxAttempts = 30; // 90 seconds max

  while (result.status !== 'COMPLETED' && result.status !== 'FAILED' && attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 3000));
    attempts++;

    const statusResp = await fetch(HAIR_BASE + '/status/' + submitResult.id, {
      headers: { 'x-magicapi-key': MAGICAPI_KEY }
    });
    result = await statusResp.json();
    log.debug(`[MAGICAPI] Hair fix status: ${result.status} (attempt ${attempts})`);
  }

  if (result.status === 'FAILED') {
    throw new Error(`Hair fix failed: ${JSON.stringify(result)}`);
  }

  if (result.status !== 'COMPLETED' || !result.output?.image_url) {
    throw new Error(`Hair fix timed out or no output after ${maxAttempts * 3} seconds`);
  }

  // Download result image
  const imgResp = await fetch(result.output.image_url);
  const resultBuffer = Buffer.from(await imgResp.arrayBuffer());

  log.info('[MAGICAPI] Hair fix completed successfully');
  return resultBuffer;
}

/**
 * Crop a face region from an image
 *
 * @param {Buffer} imageBuffer - Full image buffer
 * @param {object} region - Crop region {left, top, width, height}
 * @returns {Promise<Buffer>} Cropped image buffer
 */
async function cropFaceRegion(imageBuffer, region) {
  const image = sharp(imageBuffer);
  const meta = await image.metadata();

  log.debug(`[MAGICAPI] Cropping - image: ${meta.width}x${meta.height}, region: ${JSON.stringify(region)}`);

  // Validate and clamp region to image bounds
  const left = Math.max(0, Math.round(region.left));
  const top = Math.max(0, Math.round(region.top));
  const width = Math.min(Math.round(region.width), meta.width - left);
  const height = Math.min(Math.round(region.height), meta.height - top);

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid crop region: ${JSON.stringify({ left, top, width, height })}`);
  }

  const cropped = await image.extract({ left, top, width, height }).toBuffer();
  return cropped;
}

/**
 * Stitch the repaired face back into the original image with feathered oval blending
 *
 * @param {Buffer} faceBuffer - Repaired face image
 * @param {Buffer} originalBuffer - Original full image
 * @param {object} region - Region where face was cropped from {left, top, width, height}
 * @returns {Promise<Buffer>} Composited image buffer
 */
async function stitchBack(faceBuffer, originalBuffer, region) {
  const { left, top, width, height } = region;

  log.debug(`[MAGICAPI] Stitching back - region: ${JSON.stringify(region)}`);

  // Resize face to exact region size
  const resizedFace = await sharp(faceBuffer)
    .resize(width, height, { fit: 'fill' })
    .toBuffer();

  // Create feathered oval mask for smooth blending
  const feather = Math.min(8, Math.floor(Math.min(width, height) / 10));
  const svgMask = Buffer.from(
    `<svg width="${width}" height="${height}">
      <defs><filter id="blur"><feGaussianBlur stdDeviation="${feather}"/></filter></defs>
      <ellipse cx="${width/2}" cy="${height/2}" rx="${width/2 - feather}" ry="${height/2 - feather}" fill="white" filter="url(#blur)"/>
    </svg>`
  );

  const mask = await sharp(svgMask).png().toBuffer();

  // Apply mask to face (creates alpha channel with feathered edges)
  const maskedFace = await sharp(resizedFace)
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .toBuffer();

  // Composite masked face onto original image
  const result = await sharp(originalBuffer)
    .composite([{ input: maskedFace, left: Math.round(left), top: Math.round(top) }])
    .png()
    .toBuffer();

  log.info('[MAGICAPI] Stitch back completed');
  return result;
}

/**
 * Expand bounding box to include hair above the face
 * Hair fix needs the full head region, not just the face
 *
 * @param {object} bbox - Original bounding box {left, top, width, height} or {x, y, width, height}
 * @param {number} imageWidth - Full image width
 * @param {number} imageHeight - Full image height
 * @returns {object} Expanded region {left, top, width, height}
 */
function expandBboxForHair(bbox, imageWidth, imageHeight) {
  // Normalize bbox format - handle array [x1, y1, x2, y2] or object {left, top, width, height}
  let left, top, width, height;

  if (Array.isArray(bbox)) {
    // Normalized coordinates [x1, y1, x2, y2] - convert to pixel values
    const [x1, y1, x2, y2] = bbox;
    left = Math.round(x1 * imageWidth);
    top = Math.round(y1 * imageHeight);
    width = Math.round((x2 - x1) * imageWidth);
    height = Math.round((y2 - y1) * imageHeight);
  } else {
    left = bbox.left ?? bbox.x ?? 0;
    top = bbox.top ?? bbox.y ?? 0;
    width = bbox.width || 100;
    height = bbox.height || 100;
  }

  // Expand upward for hair (50% of face height) and slightly to sides (20%)
  const hairExpansionUp = Math.round(height * 0.5);
  const sideExpansion = Math.round(width * 0.2);

  const expandedLeft = Math.max(0, left - sideExpansion);
  const expandedTop = Math.max(0, top - hairExpansionUp);
  const expandedWidth = Math.min(imageWidth - expandedLeft, width + sideExpansion * 2);
  const expandedHeight = Math.min(imageHeight - expandedTop, height + hairExpansionUp);

  return {
    left: expandedLeft,
    top: expandedTop,
    width: expandedWidth,
    height: expandedHeight
  };
}

/**
 * Evaluate crop quality using Gemini
 * Checks if the face is properly positioned and visible in the crop
 *
 * @param {Buffer} cropBuffer - Cropped image buffer
 * @returns {Promise<object>} Evaluation result with adjustments if needed
 */
async function evaluateCropQuality(cropBuffer) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `Analyze this cropped image of a face/head region. Evaluate the crop quality for face processing.

Check:
1. Is there a clearly visible face in the image?
2. Is the face reasonably centered (not cut off at edges)?
3. Is there enough head/hair visible above the face?
4. Is the crop too tight or too loose?

Respond in JSON format:
{
  "isGoodCrop": true/false,
  "faceVisible": true/false,
  "issues": ["list of issues if any"],
  "adjustment": {
    "needed": true/false,
    "moveLeftPercent": 0,
    "moveUpPercent": 0,
    "expandWidthPercent": 0,
    "expandHeightPercent": 0
  },
  "confidence": 0.0-1.0
}

Adjustment percentages should be relative to current crop size:
- Negative moveLeftPercent means move right
- Negative moveUpPercent means move down
- Positive expand values mean make the crop larger

Be conservative with adjustments (max 30% per direction).`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/png',
          data: cropBuffer.toString('base64')
        }
      }
    ]);

    const text = result.response.text();
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const evaluation = JSON.parse(jsonMatch[0]);
      log.debug(`[MAGICAPI] Crop evaluation: ${JSON.stringify(evaluation)}`);
      return evaluation;
    }

    return { isGoodCrop: true, adjustment: { needed: false }, confidence: 0.5 };
  } catch (err) {
    log.warn(`[MAGICAPI] Crop evaluation failed: ${err.message}`);
    // Default to accepting the crop if evaluation fails
    return { isGoodCrop: true, adjustment: { needed: false }, confidence: 0.5 };
  }
}

/**
 * Apply adjustment to a region based on percentage changes
 *
 * @param {object} region - Current region {left, top, width, height}
 * @param {object} adjustment - Adjustment percentages
 * @param {number} imageWidth - Full image width
 * @param {number} imageHeight - Full image height
 * @returns {object} Adjusted region
 */
function applyRegionAdjustment(region, adjustment, imageWidth, imageHeight) {
  const { left, top, width, height } = region;

  // Calculate new dimensions
  const widthChange = Math.round(width * (adjustment.expandWidthPercent || 0) / 100);
  const heightChange = Math.round(height * (adjustment.expandHeightPercent || 0) / 100);
  const leftChange = Math.round(width * (adjustment.moveLeftPercent || 0) / 100);
  const topChange = Math.round(height * (adjustment.moveUpPercent || 0) / 100);

  let newWidth = width + widthChange;
  let newHeight = height + heightChange;
  let newLeft = left - leftChange - Math.round(widthChange / 2); // Center the expansion
  let newTop = top - topChange - Math.round(heightChange / 2);

  // Clamp to image bounds
  newLeft = Math.max(0, newLeft);
  newTop = Math.max(0, newTop);
  newWidth = Math.min(newWidth, imageWidth - newLeft);
  newHeight = Math.min(newHeight, imageHeight - newTop);

  // Ensure minimum size
  newWidth = Math.max(50, newWidth);
  newHeight = Math.max(50, newHeight);

  return {
    left: newLeft,
    top: newTop,
    width: newWidth,
    height: newHeight
  };
}

/**
 * Iteratively crop and evaluate until good quality or max attempts reached
 *
 * @param {Buffer} sceneImageBuffer - Full scene image
 * @param {object} initialRegion - Initial crop region
 * @param {number} imageWidth - Full image width
 * @param {number} imageHeight - Full image height
 * @param {number} maxAttempts - Maximum recrop attempts (default: 4)
 * @returns {Promise<object>} Final crop result with buffer and region
 */
async function iterativeCrop(sceneImageBuffer, initialRegion, imageWidth, imageHeight, maxAttempts = 4) {
  let currentRegion = { ...initialRegion };
  let attempt = 0;
  const cropHistory = [];

  while (attempt < maxAttempts) {
    attempt++;
    log.info(`[MAGICAPI] Crop attempt ${attempt}/${maxAttempts} - region: ${JSON.stringify(currentRegion)}`);

    // Crop with current region
    const croppedBuffer = await cropFaceRegion(sceneImageBuffer, currentRegion);

    // Evaluate crop quality
    const evaluation = await evaluateCropQuality(croppedBuffer);
    cropHistory.push({
      attempt,
      region: { ...currentRegion },
      evaluation
    });

    if (evaluation.isGoodCrop) {
      log.info(`[MAGICAPI] Good crop found on attempt ${attempt} (confidence: ${evaluation.confidence})`);
      return {
        buffer: croppedBuffer,
        region: currentRegion,
        attempts: attempt,
        history: cropHistory
      };
    }

    // If we're on the last attempt, use whatever we have
    if (attempt >= maxAttempts) {
      log.info(`[MAGICAPI] Max attempts reached, using last crop`);
      return {
        buffer: croppedBuffer,
        region: currentRegion,
        attempts: attempt,
        history: cropHistory
      };
    }

    // Apply adjustment for next iteration
    log.info(`[MAGICAPI] Adjusting crop: ${JSON.stringify(evaluation.adjustment)}`);
    currentRegion = applyRegionAdjustment(
      currentRegion,
      evaluation.adjustment,
      imageWidth,
      imageHeight
    );
  }

  // Should never reach here, but just in case
  const finalBuffer = await cropFaceRegion(sceneImageBuffer, currentRegion);
  return {
    buffer: finalBuffer,
    region: currentRegion,
    attempts: attempt,
    history: cropHistory
  };
}

/**
 * Full repair pipeline: iterative crop -> face swap -> hair fix -> stitch back
 * This is the main function to call for character face repair
 *
 * @param {Buffer} sceneImageBuffer - Full scene image buffer
 * @param {Buffer} avatarBuffer - Character avatar face image buffer
 * @param {object} boundingBox - Face bounding box from detection {left/x, top/y, width, height}
 * @param {object} hairConfig - Hair configuration {color, style, property}
 * @param {object} options - Additional options {skipCropEvaluation, maxCropAttempts}
 * @returns {Promise<object>} Result with repairedBuffer and metadata
 */
async function repairFaceWithMagicApi(sceneImageBuffer, avatarBuffer, boundingBox, hairConfig = {}, options = {}) {
  log.info('[MAGICAPI] Starting full repair pipeline');

  // Get image dimensions
  const sceneMeta = await sharp(sceneImageBuffer).metadata();

  // Expand bounding box to include hair region
  const initialRegion = expandBboxForHair(boundingBox, sceneMeta.width, sceneMeta.height);
  log.info(`[MAGICAPI] Initial expanded region: ${JSON.stringify(initialRegion)}`);

  // Step 1: Iterative crop with quality checking
  let croppedFace;
  let finalRegion;
  let cropHistory = [];

  if (options.skipCropEvaluation) {
    // Skip evaluation, just crop directly
    croppedFace = await cropFaceRegion(sceneImageBuffer, initialRegion);
    finalRegion = initialRegion;
  } else {
    // Use iterative cropping with evaluation
    const maxAttempts = options.maxCropAttempts || 4;
    const cropResult = await iterativeCrop(
      sceneImageBuffer,
      initialRegion,
      sceneMeta.width,
      sceneMeta.height,
      maxAttempts
    );
    croppedFace = cropResult.buffer;
    finalRegion = cropResult.region;
    cropHistory = cropResult.history;
    log.info(`[MAGICAPI] Final crop after ${cropResult.attempts} attempts: ${JSON.stringify(finalRegion)}`);
  }

  // Step 2: Face swap
  let processedFace = await faceSwap(avatarBuffer, croppedFace);

  // Step 3: Hair fix (if hair config provided)
  const hairColor = hairConfig.color || hairConfig.hairColor;
  const hairStyle = hairConfig.style || hairConfig.hairStyle;

  if (hairColor && hairStyle) {
    try {
      processedFace = await fixHair(
        processedFace,
        hairColor,
        hairStyle,
        hairConfig.property || hairConfig.hairProperty || 'textured'
      );
    } catch (hairErr) {
      // Hair fix is optional - log warning but continue
      log.warn(`[MAGICAPI] Hair fix failed (continuing without): ${hairErr.message}`);
    }
  } else {
    log.info('[MAGICAPI] Skipping hair fix - no hair config provided');
  }

  // Step 4: Stitch back
  const repairedBuffer = await stitchBack(processedFace, sceneImageBuffer, finalRegion);

  return {
    success: true,
    repairedBuffer,
    region: finalRegion,
    initialRegion,
    cropHistory,
    method: 'magicapi',
    steps: ['iterativeCrop', 'faceSwap', hairColor && hairStyle ? 'hairFix' : null, 'stitch'].filter(Boolean)
  };
}

/**
 * Check if MagicAPI is configured
 * @returns {boolean}
 */
function isMagicApiConfigured() {
  return !!MAGICAPI_KEY;
}

module.exports = {
  faceSwap,
  fixHair,
  cropFaceRegion,
  stitchBack,
  expandBboxForHair,
  evaluateCropQuality,
  iterativeCrop,
  repairFaceWithMagicApi,
  isMagicApiConfigured
};
