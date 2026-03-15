/**
 * Grok Imagine API Integration (xAI Aurora)
 *
 * Image generation using xAI's Grok Imagine API.
 * - Standard: $0.02/image (grok-imagine-image)
 * - Pro: $0.07/image (grok-imagine-image-pro)
 *
 * Supports up to 3 reference images via the edit endpoint.
 * Character photos are concatenated into a grid when >3 to fit the limit.
 *
 * @see https://docs.x.ai/docs/guides/image-generations
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');

const XAI_API_KEY = process.env.XAI_API_KEY;
const XAI_API_URL = 'https://api.x.ai/v1';

if (XAI_API_KEY) {
  log.info(`🎨 Grok Imagine API: ✅ Configured (key: ${XAI_API_KEY.substring(0, 8)}...)`);
} else {
  log.warn(`🎨 Grok Imagine API: ❌ Not configured (XAI_API_KEY not set)`);
}

const GROK_MODELS = {
  STANDARD: 'grok-imagine-image',       // $0.02/image, 300 RPM
  PRO: 'grok-imagine-image-pro',        // $0.07/image, 30 RPM
};

function isGrokConfigured() {
  return !!XAI_API_KEY;
}

/**
 * Generate image with Grok Imagine API
 *
 * Uses the generation endpoint (text-only, no reference images).
 *
 * @param {string} prompt - Text prompt for image generation
 * @param {Object} options
 * @param {string} options.model - Model ID (default: grok-imagine-image)
 * @param {string} options.aspectRatio - Aspect ratio (default: 1:1)
 * @param {string} options.resolution - Resolution: '1k' or '2k' (default: 1k)
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function generateWithGrok(prompt, options = {}) {
  const {
    model = GROK_MODELS.STANDARD,
    aspectRatio = '1:1',
    resolution = '1k',
  } = options;

  if (!XAI_API_KEY) {
    throw new Error('XAI_API_KEY not configured');
  }

  log.info(`🎨 [GROK] Starting generation (model: ${model}, aspect: ${aspectRatio}, res: ${resolution})`);
  log.debug(`🎨 [GROK] Prompt (${prompt.length} chars): ${prompt.substring(0, 120)}...`);

  const body = {
    model,
    prompt,
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: aspectRatio,
    resolution,
  };

  const startTime = Date.now();

  try {
    const response = await fetch(`${XAI_API_URL}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 2 min timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [GROK] API error ${response.status}: ${errorText.substring(0, 300)}`);
      throw new Error(`Grok API error (${response.status}): ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    if (!data.data || !data.data[0]) {
      throw new Error('No image data in Grok response');
    }

    const imageBase64 = data.data[0].b64_json;
    const imageData = `data:image/jpeg;base64,${imageBase64}`;
    const cost = model === GROK_MODELS.PRO ? 0.07 : 0.02;

    log.info(`✅ [GROK] Generation complete in ${elapsed}ms. Cost: $${cost}`);

    return {
      imageData,
      usage: {
        cost,
        direct_cost: cost,
        inferenceTime: elapsed,
      },
      modelId: model,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [GROK] Generation failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/**
 * Generate image with reference images using Grok Imagine edit endpoint
 *
 * Accepts up to 3 reference images. If a visual bible grid is provided,
 * it's used as one of the reference slots.
 *
 * @param {string} prompt - Text prompt with character descriptions
 * @param {string[]} referenceImages - Array of base64 data URIs (max 3)
 * @param {Object} options
 * @param {string} options.model - Model ID
 * @param {string} options.aspectRatio - Aspect ratio
 * @param {string} options.resolution - Resolution
 * @returns {Promise<{imageData: string, usage: Object, modelId: string}>}
 */
async function editWithGrok(prompt, referenceImages = [], options = {}) {
  const {
    model = GROK_MODELS.STANDARD,
    aspectRatio = '1:1',
    resolution = '1k',
  } = options;

  if (!XAI_API_KEY) {
    throw new Error('XAI_API_KEY not configured');
  }

  // Grok edit endpoint accepts max 3 images
  const images = referenceImages.slice(0, 3);

  log.info(`🎨 [GROK] Starting edit (model: ${model}, refs: ${images.length}, aspect: ${aspectRatio})`);
  log.debug(`🎨 [GROK] Prompt (${prompt.length} chars): ${prompt.substring(0, 120)}...`);

  const body = {
    model,
    prompt,
    response_format: 'b64_json',
  };

  // Single vs multiple image format
  if (images.length === 1) {
    body.image = { url: images[0], type: 'image_url' };
  } else if (images.length > 1) {
    body.images = images.map(url => ({ url, type: 'image_url' }));
  }

  const startTime = Date.now();

  try {
    const response = await fetch(`${XAI_API_URL}/images/edits`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`❌ [GROK] Edit API error ${response.status}: ${errorText.substring(0, 300)}`);
      throw new Error(`Grok edit API error (${response.status}): ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    if (!data.data || !data.data[0]) {
      throw new Error('No image data in Grok edit response');
    }

    const imageBase64 = data.data[0].b64_json;
    const imageData = `data:image/jpeg;base64,${imageBase64}`;
    const cost = model === GROK_MODELS.PRO ? 0.07 : 0.02;

    log.info(`✅ [GROK] Edit complete in ${elapsed}ms. Cost: $${cost}. Refs: ${images.length}`);

    return {
      imageData,
      usage: {
        cost,
        direct_cost: cost,
        inferenceTime: elapsed,
      },
      modelId: model,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [GROK] Edit failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/**
 * Pack reference images into max 3 slots for Grok's edit endpoint.
 *
 * Strategy:
 * - Slot 1: Visual bible grid + landmark photos stitched into one image
 * - Slot 2: All character photos stitched into a labeled grid
 * - Slot 3: Previous scene image (for sequential consistency)
 *
 * If a category is empty, the slot is skipped (fewer images sent).
 *
 * @param {Object} refs
 * @param {Buffer|null} refs.visualBibleGrid - VB grid buffer (JPEG)
 * @param {Array<{name: string, photoData: string}>} refs.landmarkPhotos - Landmark data URIs
 * @param {Array} refs.characterPhotos - Character photos (string data URIs or {name, photoUrl})
 * @param {string|null} refs.previousImage - Previous scene data URI
 * @returns {Promise<string[]>} Array of data URIs (max 3)
 */
async function packReferences(refs = {}) {
  const {
    visualBibleGrid = null,
    landmarkPhotos = [],
    characterPhotos = [],
    previousImage = null,
  } = refs;

  const slots = [];

  // ── Slot 1: Visual Bible grid + landmark photos ──
  const contextImages = [];

  if (visualBibleGrid) {
    contextImages.push(visualBibleGrid); // Buffer
  }

  for (const lm of landmarkPhotos) {
    if (lm.photoData && lm.photoData.startsWith('data:image')) {
      const base64 = lm.photoData.replace(/^data:image\/\w+;base64,/, '');
      contextImages.push(Buffer.from(base64, 'base64'));
    }
  }

  if (contextImages.length > 0) {
    const stitched = await stitchImagesHorizontally(contextImages, 768);
    slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
    log.info(`🎨 [GROK] Slot 1: VB grid + ${landmarkPhotos.length} landmark(s) stitched`);
  }

  // ── Slot 2: All character photos stitched into one grid ──
  const charBuffers = [];
  for (const photoData of characterPhotos) {
    const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
    if (photoUrl && photoUrl.startsWith('data:image')) {
      const base64 = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      charBuffers.push(Buffer.from(base64, 'base64'));
    }
  }

  if (charBuffers.length > 0) {
    const stitched = await stitchImagesHorizontally(charBuffers, 768);
    slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
    log.info(`🎨 [GROK] Slot 2: ${charBuffers.length} character photo(s) stitched`);
  }

  // ── Slot 3: Previous scene image ──
  if (previousImage && previousImage.startsWith('data:image') && slots.length < 3) {
    slots.push(previousImage);
    log.info(`🎨 [GROK] Slot 3: Previous scene image`);
  }

  log.info(`🎨 [GROK] Packed ${slots.length}/3 reference slots`);
  return slots;
}

/**
 * Stitch multiple image buffers horizontally into one row.
 * All images resized to the same height, then placed side by side.
 *
 * @param {Buffer[]} buffers - Array of image buffers
 * @param {number} targetHeight - Height to normalize to
 * @returns {Promise<Buffer>} JPEG buffer of the stitched image
 */
async function stitchImagesHorizontally(buffers, targetHeight = 768) {
  if (buffers.length === 1) {
    // Single image — just resize and return
    return sharp(buffers[0])
      .resize({ height: targetHeight, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  // Resize all to same height, get metadata
  const resized = [];
  for (const buf of buffers) {
    const img = sharp(buf).resize({ height: targetHeight, withoutEnlargement: true });
    const meta = await img.toBuffer({ resolveWithObject: true });
    resized.push({ buffer: meta.data, width: meta.info.width, height: meta.info.height });
  }

  const gap = 4;
  const totalWidth = resized.reduce((sum, r) => sum + r.width, 0) + gap * (resized.length - 1);

  // Compose horizontally
  const composites = [];
  let x = 0;
  for (const r of resized) {
    composites.push({ input: r.buffer, left: x, top: 0 });
    x += r.width + gap;
  }

  return sharp({
    create: {
      width: totalWidth,
      height: targetHeight,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

module.exports = {
  generateWithGrok,
  editWithGrok,
  isGrokConfigured,
  packReferences,
  GROK_MODELS,
};
