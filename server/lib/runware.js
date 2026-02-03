/**
 * Runware API Integration
 *
 * Provides cheap image inpainting via Runware's API.
 * Much cheaper than Gemini for inpainting tasks:
 * - SD 1.5: $0.0006/image (fastest, low quality)
 * - SDXL: $0.002/image (default - good balance of quality/cost)
 * - FLUX Fill: ~$0.05/image (best quality)
 *
 * @see https://runware.ai/docs/en/image-inference/inpainting
 */

const crypto = require('crypto');
const { log } = require('../utils/logger');

const RUNWARE_API_KEY = process.env.RUNWARE_API_KEY;
const RUNWARE_API_URL = 'https://api.runware.ai/v1';

// Log Runware configuration status at startup
// Debug: Check for env vars containing RUNWARE (to detect whitespace issues)
const runwareEnvVars = Object.keys(process.env).filter(k => k.includes('RUNWARE'));
if (runwareEnvVars.length > 0) {
  log.info(`🔍 Found env vars with 'RUNWARE': ${runwareEnvVars.map(k => `"${k}"`).join(', ')}`);
}

if (RUNWARE_API_KEY) {
  log.info(`🎨 Runware API: ✅ Configured (key: ${RUNWARE_API_KEY.substring(0, 8)}...)`);
} else {
  log.warn(`🎨 Runware API: ❌ Not configured (RUNWARE_API_KEY not set)`);
}

// Available models
// Text-to-image: https://runware.ai/models
// Inpainting/Tools: https://runware.ai/docs/en/image-inference/flux-tools
const RUNWARE_MODELS = {
  // Text-to-image models
  FLUX_SCHNELL: 'runware:100@1', // FLUX.1 Schnell - $0.0006/image, fast 4-step
  FLUX_DEV: 'runware:101@1',     // FLUX.1 Dev - $0.004/image, better quality
  SDXL: 'civitai:101055@128078', // SDXL base v1.0 VAE fix - for PuLID compatibility
  // FLUX Tools (inpainting, etc)
  FLUX_FILL: 'runware:102@1',    // FLUX Fill - inpainting/outpainting
  FLUX_DEPTH: 'runware:103@1',   // FLUX Depth - depth map guidance
  FLUX_CANNY: 'runware:104@1',   // FLUX Canny - edge guidance
  FLUX_REDUX: 'runware:105@1'    // FLUX Redux - image variation
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
    model = RUNWARE_MODELS.FLUX_FILL,  // Use FLUX Fill for best quality inpainting
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
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)  // 60 second timeout to prevent hanging forever
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

    const cost = result.cost || 0.002;  // SDXL default cost
    log.info(`✅ [RUNWARE] Inpaint complete in ${elapsed}ms. Cost: $${cost.toFixed(6)}`);

    return {
      imageData: imageData,
      imageBase64: result.imageBase64,
      usage: {
        cost: cost,
        direct_cost: cost,  // For addUsage compatibility
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
 * Generate image from text prompt using Runware API
 *
 * @param {string} prompt - Text prompt for image generation
 * @param {Object} options - Generation options
 * @param {string} options.model - Model to use (default: FLUX Schnell)
 * @param {number} options.width - Output width (default: 1024)
 * @param {number} options.height - Output height (default: 1024)
 * @param {number} options.steps - Inference steps (default: 4 for Schnell)
 * @param {string[]} options.referenceImages - Optional reference images for character consistency
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function generateWithRunware(prompt, options = {}) {
  const {
    model = RUNWARE_MODELS.FLUX_SCHNELL,
    width = 1024,
    height = 1024,
    steps = 4,  // FLUX Schnell works best with 4 steps
    referenceImages = []
  } = options;

  if (!RUNWARE_API_KEY) {
    throw new Error('RUNWARE_API_KEY not configured');
  }

  const taskUUID = crypto.randomUUID();
  log.info(`🎨 [RUNWARE] Starting generation task ${taskUUID.slice(0, 8)}...`);
  log.debug(`🎨 [RUNWARE] Model: ${model}, Size: ${width}x${height}, Steps: ${steps}`);
  log.debug(`🎨 [RUNWARE] Prompt (${prompt.length} chars): ${prompt.substring(0, 100)}...`);

  // Build the task payload
  // Note: Prompt should already be truncated by caller based on IMAGE_MODELS config
  const task = {
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: prompt,
    model: model,
    width: width,
    height: height,
    steps: steps,
    outputFormat: 'PNG',
    numberResults: 1
  };

  // Note: FLUX models don't support IP-Adapter/ControlNet for face reference
  // Avatar generation with Runware will be text-only (no face preservation)
  if (referenceImages.length > 0) {
    log.warn(`🎨 [RUNWARE] Reference images provided but FLUX doesn't support IP-Adapter - generating without face reference`);
  }

  const payload = [task];
  const startTime = Date.now();

  try {
    const response = await fetch(RUNWARE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNWARE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)  // 60 second timeout to prevent hanging forever
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

    // If we got a URL, download and convert to base64
    if (imageData && !imageData.startsWith('data:')) {
      imageData = await downloadRunwareImage(imageData);
    }

    if (!imageData) {
      throw new Error('No image data in Runware response');
    }

    const cost = result.cost || 0.0006;
    log.info(`✅ [RUNWARE] Generation complete in ${elapsed}ms. Cost: $${cost.toFixed(6)}`);

    return {
      imageData: imageData,
      imageBase64: result.imageBase64,
      usage: {
        cost: cost,
        direct_cost: cost,  // For addUsage compatibility
        inferenceTime: result.inferenceTime || elapsed
      },
      modelId: model
    };

  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [RUNWARE] Generation failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/**
 * Generate character-consistent avatar using ACE++ framework
 * ACE++ preserves facial identity from a reference photo
 *
 * @param {string} referenceImage - Reference photo (data URI or base64) with clear face
 * @param {string} prompt - Description of desired avatar (pose, style, clothing)
 * @param {Object} options - Generation options
 * @param {number} options.width - Output width (default: 768)
 * @param {number} options.height - Output height (default: 1024)
 * @param {number} options.identityStrength - How strongly to preserve identity 0-1 (default: 0.8)
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function generateAvatarWithACE(referenceImage, prompt, options = {}) {
  const {
    width = 768,
    height = 1024,
    identityStrength = 0.8
  } = options;

  if (!RUNWARE_API_KEY) {
    throw new Error('RUNWARE_API_KEY not configured');
  }

  const taskUUID = crypto.randomUUID();
  log.info(`🎨 [RUNWARE ACE++] Starting avatar generation ${taskUUID.slice(0, 8)}...`);
  log.debug(`🎨 [RUNWARE ACE++] Size: ${width}x${height}, Identity strength: ${identityStrength}`);
  log.debug(`🎨 [RUNWARE ACE++] Prompt: ${prompt.substring(0, 100)}...`);

  // Ensure reference image is in correct format
  let refDataUri = referenceImage;
  if (Buffer.isBuffer(referenceImage)) {
    refDataUri = `data:image/png;base64,${referenceImage.toString('base64')}`;
  }

  // ACE++ uses FLUX Fill model with acePlusPlus configuration
  // referenceImages must be at ROOT level, not inside acePlusPlus
  const payload = [{
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: prompt,
    model: RUNWARE_MODELS.FLUX_FILL,  // runware:102@1
    width: width,
    height: height,
    outputFormat: 'PNG',
    numberResults: 1,
    referenceImages: [refDataUri],  // Reference face image at ROOT level
    // ACE++ specific configuration
    acePlusPlus: {
      type: 'portrait',  // 'subject', 'portrait', or 'local_editing'
      identityStrength: identityStrength  // How much to preserve identity (0-1)
    }
  }];

  const startTime = Date.now();

  try {
    const response = await fetch(RUNWARE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNWARE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)  // 60 second timeout to prevent hanging forever
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [RUNWARE ACE++] API error ${response.status}: ${errorText}`);
      throw new Error(`Runware ACE++ API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    // Handle errors in response
    if (data.errors && data.errors.length > 0) {
      const error = data.errors[0];
      log.error(`❌ [RUNWARE ACE++] Task error: ${error.message || JSON.stringify(error)}`);
      throw new Error(`Runware ACE++ error: ${error.message || 'Unknown error'}`);
    }

    // Response is array of results
    const result = data.data?.find(d => d.taskUUID === taskUUID);
    if (!result) {
      log.error(`❌ [RUNWARE ACE++] No result for task ${taskUUID}`);
      throw new Error('No result in Runware ACE++ response');
    }

    // Get the image - could be URL or base64
    let imageData = result.imageURL;
    if (!imageData && result.imageBase64) {
      imageData = `data:image/png;base64,${result.imageBase64}`;
    }

    // If we got a URL, download and convert to base64
    if (imageData && !imageData.startsWith('data:')) {
      imageData = await downloadRunwareImage(imageData);
    }

    if (!imageData) {
      throw new Error('No image data in Runware ACE++ response');
    }

    const cost = result.cost || 0.005;  // Estimate ~$0.005 for ACE++
    log.info(`✅ [RUNWARE ACE++] Avatar complete in ${elapsed}ms. Cost: $${cost.toFixed(6)}`);

    return {
      imageData: imageData,
      imageBase64: result.imageBase64,
      usage: {
        cost: cost,
        direct_cost: cost,  // For addUsage compatibility
        inferenceTime: result.inferenceTime || elapsed
      },
      modelId: 'ace-plus-plus'
    };

  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [RUNWARE ACE++] Failed after ${elapsed}ms: ${error.message}`);
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
 * Generate face-consistent image using PuLID (Pure and Lightning ID)
 * PuLID provides excellent identity preservation from a single reference photo
 *
 * @param {string} referenceImage - Reference photo (data URI or base64) with clear face
 * @param {string} prompt - Description of desired output
 * @param {Object} options - Generation options
 * @param {number} options.width - Output width (default: 896)
 * @param {number} options.height - Output height (default: 1152)
 * @param {number} options.idWeight - Identity weight 0-3 (default: 1.0, higher = stronger identity)
 * @param {number} options.startStep - When to start applying identity 0-100% (default: 0, lower = stronger)
 * @param {number} options.trueCFGScale - True CFG scale (default: 1)
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function generateWithPuLID(referenceImage, prompt, options = {}) {
  const {
    width = 1024,
    height = 1024,
    idWeight = 1.0,  // Identity strength (0-3, default 1)
    steps = 25       // More steps = sharper but slower
  } = options;

  if (!RUNWARE_API_KEY) {
    throw new Error('RUNWARE_API_KEY not configured');
  }

  const taskUUID = crypto.randomUUID();
  log.info(`🎨 [RUNWARE PuLID] Starting face-consistent generation ${taskUUID.slice(0, 8)}...`);
  log.debug(`🎨 [RUNWARE PuLID] Size: ${width}x${height}, ID weight: ${idWeight}`);
  log.debug(`🎨 [RUNWARE PuLID] Prompt: ${prompt.substring(0, 100)}...`);

  // Ensure reference image is in correct format
  let refDataUri = referenceImage;
  if (Buffer.isBuffer(referenceImage)) {
    refDataUri = `data:image/png;base64,${referenceImage.toString('base64')}`;
  }

  // PuLID requires FLUX models: runware:101@1 (Dev), runware:100@1 (Schnell), or runware:107@1
  const payload = [{
    taskType: 'imageInference',
    taskUUID: taskUUID,
    positivePrompt: prompt,
    negativePrompt: 'blurry, low quality, distorted, disfigured, bad anatomy, naked, nude, nsfw',
    model: RUNWARE_MODELS.FLUX_DEV,  // FLUX Dev - required for PuLID
    width: width,
    height: height,
    steps: steps,
    CFGScale: 4,
    outputFormat: 'PNG',
    numberResults: 1,
    // PuLID specific configuration
    puLID: {
      inputImages: [refDataUri],  // Reference face image(s)
      idWeight: idWeight          // Identity strength (0-3, default 1)
      // Note: trueCFGScale and CFGStartStep are mutually exclusive
    }
  }];

  const startTime = Date.now();

  try {
    const response = await fetch(RUNWARE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RUNWARE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000)  // 60 second timeout to prevent hanging forever
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [RUNWARE PuLID] API error ${response.status}: ${errorText}`);
      throw new Error(`Runware PuLID API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    // Handle errors in response
    if (data.errors && data.errors.length > 0) {
      const error = data.errors[0];
      log.error(`❌ [RUNWARE PuLID] Task error: ${error.message || JSON.stringify(error)}`);
      throw new Error(`Runware PuLID error: ${error.message || 'Unknown error'}`);
    }

    // Response is array of results
    const result = data.data?.find(d => d.taskUUID === taskUUID);
    if (!result) {
      log.error(`❌ [RUNWARE PuLID] No result for task ${taskUUID}`);
      throw new Error('No result in Runware PuLID response');
    }

    // Get the image - could be URL or base64
    let imageData = result.imageURL;
    if (!imageData && result.imageBase64) {
      imageData = `data:image/png;base64,${result.imageBase64}`;
    }

    // If we got a URL, download and convert to base64
    if (imageData && !imageData.startsWith('data:')) {
      imageData = await downloadRunwareImage(imageData);
    }

    if (!imageData) {
      throw new Error('No image data in Runware PuLID response');
    }

    const cost = result.cost || 0.002;  // SDXL cost ~$0.002
    log.info(`✅ [RUNWARE PuLID] Complete in ${elapsed}ms. Cost: $${cost.toFixed(6)}`);

    return {
      imageData: imageData,
      imageBase64: result.imageBase64,
      usage: {
        cost: cost,
        direct_cost: cost,
        inferenceTime: result.inferenceTime || elapsed
      },
      modelId: 'pulid-flux'
    };

  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [RUNWARE PuLID] Failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
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
  generateWithRunware,
  generateAvatarWithACE,
  generateWithPuLID,
  downloadRunwareImage,
  isRunwareConfigured,
  RUNWARE_MODELS
};
