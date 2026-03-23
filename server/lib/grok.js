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

  // grok-imagine-image: max 3 input images
  // grok-imagine-image-pro: max 1 input image — stitch multiple refs into one composite
  let images = referenceImages.slice(0, 3);

  if (model === GROK_MODELS.PRO && images.length > 1) {
    log.info(`🎨 [GROK] Pro model supports 1 image — stitching ${images.length} refs into composite`);
    const buffers = images.map(url => {
      const base64 = url.replace(/^data:image\/\w+;base64,/, '');
      return Buffer.from(base64, 'base64');
    });
    const stitched = await stitchImagesHorizontally(buffers, 768);
    const squareSize = 768;
    const meta = await sharp(stitched).metadata();
    let finalBuf = stitched;
    if (meta.width !== meta.height) {
      const size = Math.max(meta.width, meta.height, squareSize);
      finalBuf = await sharp(stitched)
        .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();
    }
    images = [`data:image/jpeg;base64,${finalBuf.toString('base64')}`];
  }

  log.info(`🎨 [GROK] Starting edit (model: ${model}, refs: ${images.length}, aspect: ${aspectRatio})`);
  log.debug(`🎨 [GROK] Prompt (${prompt.length} chars): ${prompt.substring(0, 120)}...`);

  const body = {
    model,
    prompt,
    response_format: 'b64_json',
    aspect_ratio: aspectRatio,
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
 * Detect portrait 2x2 avatar grids (aspect ~1:1.75) and crop to left half (front-facing column).
 *
 * Avatar grids are arranged:
 *   Front-Left  |  Front-Right
 *   Back-Left   |  Back-Right
 *
 * For Grok reference images, only the front-facing column is useful.
 * Non-grid images (aspect ratio far from 1:1.75) are returned unchanged.
 *
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Buffer>} Cropped (or original) JPEG buffer
 */
async function cropToFrontColumn(buffer) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  // Try Python service first (detects actual separator line via variance analysis)
  try {
    const b64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    const response = await fetch(`${photoAnalyzerUrl}/crop-front-column`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: b64 }),
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success && result.image) {
        const croppedB64 = result.image.replace(/^data:image\/\w+;base64,/, '');
        log.info(`🎨 [GROK] Cropped to front column via Python (separator at x=${result.separator_x})`);
        return Buffer.from(croppedB64, 'base64');
      }
    }
    log.debug(`[GROK] Python crop-front-column unavailable (${response.status}), using Sharp fallback`);
  } catch (err) {
    log.debug(`[GROK] Python crop-front-column failed: ${err.message}, using Sharp fallback`);
  }

  // Fallback: naive half-width crop with Sharp
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return buffer;

    const halfWidth = Math.floor(meta.width / 2);
    const cropped = await sharp(buffer)
      .extract({ left: 0, top: 0, width: halfWidth, height: meta.height })
      .jpeg({ quality: 90 })
      .toBuffer();

    log.info(`🎨 [GROK] Cropped to front column (Sharp fallback): ${meta.width}x${meta.height} → ${halfWidth}x${meta.height}`);
    return cropped;
  } catch (err) {
    log.warn(`⚠️ [GROK] cropToFrontColumn failed: ${err.message}`);
    return buffer;
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

  // Extract character photo buffers (handle same formats as Gemini path)
  const charBuffers = [];
  for (const photoData of characterPhotos) {
    let photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
    const charName = typeof photoData === 'object' ? photoData?.name : null;
    // Handle nested object formats: {data: "..."}, {imageData: "..."}, or arrays
    if (photoUrl && typeof photoUrl === 'object') {
      if (Array.isArray(photoUrl)) {
        photoUrl = photoUrl[0];
      } else if (photoUrl.data) {
        photoUrl = photoUrl.data;
      } else if (photoUrl.imageData) {
        photoUrl = photoUrl.imageData;
      }
    }
    if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
      const base64 = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      const rawBuffer = Buffer.from(base64, 'base64');
      const croppedBuffer = await cropToFrontColumn(rawBuffer);
      charBuffers.push(croppedBuffer);
    } else if (charName) {
      log.warn(`⚠️ [GROK] Skipped character "${charName}": photoUrl is ${photoUrl ? typeof photoUrl : 'null/undefined'} (not base64)`);
    }
  }

  // Extract landmark photo buffers
  const landmarkBuffers = [];
  for (const lm of landmarkPhotos) {
    if (lm.photoData && lm.photoData.startsWith('data:image')) {
      const base64 = lm.photoData.replace(/^data:image\/\w+;base64,/, '');
      landmarkBuffers.push(Buffer.from(base64, 'base64'));
    }
  }

  // Count how many character slots we need (max 2, since 1 slot reserved for VB/landmarks)
  const charCount = charBuffers.length;
  const slots = [];

  // Strategy: maximize character image quality by giving them separate slots
  //   1 char:  Slot 1 = VB grid, Slot 2 = landmark(s), Slot 3 = character
  //   2 chars: Slot 1 = VB + landmarks stitched, Slot 2 = char 1, Slot 3 = char 2
  //   3+ chars: Slot 1 = VB + landmarks stitched, Slot 2 = chars first half, Slot 3 = chars second half

  if (charCount <= 1) {
    // ── 0-1 characters: spread VB and landmarks across separate slots ──
    if (visualBibleGrid) {
      const resized = await sharp(visualBibleGrid).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 [GROK] Slot ${slots.length}: VB grid`);
    }

    if (landmarkBuffers.length > 0 && slots.length < 3) {
      const stitched = await stitchImagesHorizontally(landmarkBuffers, 768);
      slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
      log.info(`🎨 [GROK] Slot ${slots.length}: ${landmarkBuffers.length} landmark(s)`);
    }

    if (charCount === 1 && slots.length < 3) {
      const resized = await sharp(charBuffers[0]).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 [GROK] Slot ${slots.length}: 1 character photo`);
    }
  } else {
    // ── 2+ characters: VB + landmarks share one slot, characters get 2 slots ──
    const contextImages = [];
    if (visualBibleGrid) contextImages.push(visualBibleGrid);
    contextImages.push(...landmarkBuffers);

    if (contextImages.length > 0) {
      const stitched = await stitchImagesHorizontally(contextImages, 768);
      slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
      log.info(`🎨 [GROK] Slot ${slots.length}: VB grid + ${landmarkBuffers.length} landmark(s) stitched`);
    }

    if (charCount === 2) {
      // 2 characters: one per slot
      for (const buf of charBuffers) {
        if (slots.length >= 3) break;
        const resized = await sharp(buf).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      }
      log.info(`🎨 [GROK] Slot ${slots.length - 1}-${slots.length}: 2 character photos (separate)`);
    } else {
      // 3+ characters: split into two groups, stitch each
      const mid = Math.ceil(charCount / 2);
      const group1 = charBuffers.slice(0, mid);
      const group2 = charBuffers.slice(mid);

      if (group1.length > 0 && slots.length < 3) {
        const stitched = await stitchImagesHorizontally(group1, 768);
        slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
        log.info(`🎨 [GROK] Slot ${slots.length}: ${group1.length} characters stitched`);
      }
      if (group2.length > 0 && slots.length < 3) {
        const stitched = await stitchImagesHorizontally(group2, 768);
        slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
        log.info(`🎨 [GROK] Slot ${slots.length}: ${group2.length} characters stitched`);
      }
    }
  }

  // Grok edit with single image: output matches input aspect ratio (ignores aspect_ratio param).
  // Pad all reference images to square so output is always 1:1.
  const squareSlots = [];
  for (const slot of slots) {
    try {
      const base64 = slot.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      const meta = await sharp(buf).metadata();
      if (meta.width !== meta.height) {
        const size = Math.max(meta.width, meta.height);
        const padded = await sharp(buf)
          .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .jpeg({ quality: 90 })
          .toBuffer();
        squareSlots.push(`data:image/jpeg;base64,${padded.toString('base64')}`);
        log.debug(`🎨 [GROK] Padded ref ${meta.width}x${meta.height} → ${size}x${size}`);
      } else {
        squareSlots.push(slot);
      }
    } catch {
      squareSlots.push(slot);
    }
  }

  log.info(`🎨 [GROK] Packed ${squareSlots.length}/3 reference slots (${charCount} chars, ${landmarkBuffers.length} landmarks, VB: ${visualBibleGrid ? 'yes' : 'no'})`);
  return squareSlots;
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
  cropToFrontColumn,
  GROK_MODELS,
};
