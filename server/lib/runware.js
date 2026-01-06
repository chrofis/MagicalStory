/**
 * Runware API Integration
 *
 * Provides cheap image inpainting via Runware's API.
 * Much cheaper than Gemini for inpainting tasks:
 * - SD 1.5: $0.0006/image (50x cheaper)
 * - SDXL: $0.002/image
 *
 * @see https://runware.ai/docs/en/image-inference/inpainting
 */

const crypto = require('crypto');
const log = require('./logger')('runware');

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

// Available inpainting models
const RUNWARE_MODELS = {
  SD15: 'runware:100@1',      // SD 1.5 Inpaint - $0.0006/image, fastest
  SDXL: 'runware:101@1',      // SDXL Inpaint - $0.002/image, better quality
  FLUX_SCHNELL: 'runware:5@1', // FLUX Schnell - $0.0006/image
  FLUX_DEV: 'runware:6@1'     // FLUX Dev - $0.004/image, best quality
};

/**
 * Inpaint image regions using Runware API
 *
 * @param {string} seedImage - Base image (data URI, base64, or URL)
 * @param {string|Buffer} maskImage - Mask image (white=replace, black=preserve)
 * @param {string} prompt - What to generate in masked areas
 * @param {Object} options - Additional options
 * @param {string} options.model - Model to use (default: SD 1.5)
 * @param {number} options.strength - Modification strength 0-1 (default: 0.85)
 * @param {number} options.steps - Inference steps (default: 20)
 * @param {number} options.width - Output width (default: from image)
 * @param {number} options.height - Output height (default: from image)
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function inpaintWithRunware(seedImage, maskImage, prompt, options = {}) {
  const {
    model = RUNWARE_MODELS.SD15,
    strength = 0.85,
    steps = 20,
    width = 1024,
    height = 1024
  } = options;

  if (!RUNWARE_API_KEY) {
    throw new Error('RUNWARE_API_KEY not configured');
  }

  const taskUUID = crypto.randomUUID();
  log.info(`🎨 [RUNWARE] Starting inpaint task ${taskUUID.slice(0, 8)}...`);
  log.debug(`🎨 [RUNWARE] Model: ${model}, Strength: ${strength}, Steps: ${steps}`);

  // Convert mask buffer to data URI if needed
  let maskDataUri = maskImage;
  if (Buffer.isBuffer(maskImage)) {
    maskDataUri = `data:image/png;base64,${maskImage.toString('base64')}`;
  }

  // Ensure seed image is in correct format
  let seedDataUri = seedImage;
  if (Buffer.isBuffer(seedImage)) {
    seedDataUri = `data:image/png;base64,${seedImage.toString('base64')}`;
  }

  // Runware accepts array of tasks
  const payload = [{
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: prompt,
    model: model,
    seedImage: seedDataUri,
    maskImage: maskDataUri,
    strength: strength,
    steps: steps,
    width: width,
    height: height,
    outputFormat: 'PNG',
    numberResults: 1
  }];

  const startTime = Date.now();

  try {
    const response = await fetch(RUNWARE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNWARE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [RUNWARE] API error ${response.status}: ${errorText}`);
      throw new Error(`Runware API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    // Handle errors in response
    if (data.errors && data.errors.length > 0) {
      const error = data.errors[0];
      log.error(`❌ [RUNWARE] Task error: ${error.message || JSON.stringify(error)}`);
      throw new Error(`Runware task error: ${error.message || 'Unknown error'}`);
    }

    // Response is array of results
    const result = data.data?.find(d => d.taskUUID === taskUUID);
    if (!result) {
      log.error(`❌ [RUNWARE] No result for task ${taskUUID}`);
      throw new Error('No result in Runware response');
    }

    // Get the image - could be URL or base64
    let imageData = result.imageURL;
    if (!imageData && result.imageBase64) {
      imageData = `data:image/png;base64,${result.imageBase64}`;
    }

    if (!imageData) {
      throw new Error('No image data in Runware response');
    }

    const cost = result.cost || 0.0006;
    log.info(`✅ [RUNWARE] Inpaint complete in ${elapsed}ms. Cost: $${cost.toFixed(6)}`);

    return {
      imageData: imageData,
      imageBase64: result.imageBase64,
      usage: {
        cost: cost,
        inferenceTime: result.inferenceTime || elapsed
      },
      modelId: model
    };

  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [RUNWARE] Failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/**
 * Download image from URL and convert to base64 data URI
 * Useful when Runware returns a URL instead of base64
 *
 * @param {string} imageUrl - URL to download
 * @returns {Promise<string>} Base64 data URI
 */
async function downloadRunwareImage(imageUrl) {
  if (imageUrl.startsWith('data:')) {
    return imageUrl; // Already a data URI
  }

  log.debug(`📥 [RUNWARE] Downloading image from ${imageUrl.slice(0, 50)}...`);

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/png';

  return `data:${contentType};base64,${base64}`;
}

/**
 * Check if Runware API is configured and available
 * @returns {boolean}
 */
function isRunwareConfigured() {
  return !!RUNWARE_API_KEY;
}

module.exports = {
  inpaintWithRunware,
  downloadRunwareImage,
  isRunwareConfigured,
  RUNWARE_MODELS
};
