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

  const doFetch = async () => {
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
      const err = new Error(`Grok API error (${response.status}): ${errorText.substring(0, 200)}`);
      err.statusCode = response.status;
      log.error(`❌ [GROK] API error ${response.status}: ${errorText.substring(0, 300)}`);
      throw err;
    }
    return response;
  };

  try {
    let response;
    try {
      response = await doFetch();
    } catch (firstError) {
      // Retry once on 500 (Grok internal error) after a short delay
      if (firstError.statusCode === 500) {
        log.warn(`⚠️ [GROK] Got 500, retrying generation once after 2s delay...`);
        await new Promise(r => setTimeout(r, 2000));
        response = await doFetch();
      } else {
        throw firstError;
      }
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
    // Stitched composite is a wide rectangle — normalize it into an ASCII-clean
    // JPEG and let the aspect-pad loop below snap it to the requested aspect
    // ratio. Previously this was hardcoded to square, which silently broke
    // non-1:1 outputs (e.g. covers).
    images = [`data:image/jpeg;base64,${stitched.toString('base64')}`];
  }

  // Grok edit output matches the input image aspect ratio (ignores aspect_ratio
  // param). To get a specific output aspect, pad every input image to that aspect
  // with white letterbox bars. Parses aspectRatio strings like '3:4', '1:1', '9:16'.
  const [aspW, aspH] = String(aspectRatio).split(':').map(Number);
  const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
  for (let i = 0; i < images.length; i++) {
    try {
      const base64 = images[i].replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(base64, 'base64');
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) continue;
      const currentRatio = meta.width / meta.height;
      // Skip if already within 1% of target (avoid gratuitous re-encode)
      if (Math.abs(currentRatio - targetRatio) / targetRatio < 0.01) continue;
      // Compute the smallest box that contains the source and matches target aspect
      let targetW, targetH;
      if (currentRatio > targetRatio) {
        // Source is wider — keep width, grow height
        targetW = meta.width;
        targetH = Math.round(meta.width / targetRatio);
      } else {
        // Source is taller — keep height, grow width
        targetH = meta.height;
        targetW = Math.round(meta.height * targetRatio);
      }
      const padded = await sharp(buf)
        .resize(targetW, targetH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();
      images[i] = `data:image/jpeg;base64,${padded.toString('base64')}`;
      log.debug(`🎨 [GROK] Padded edit image ${i}: ${meta.width}x${meta.height} → ${targetW}x${targetH} (aspect ${aspectRatio})`);
    } catch (padErr) {
      log.warn(`⚠️ [GROK] Failed to pad edit image ${i}: ${padErr.message}`);
    }
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

  const doFetch = async () => {
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
      const err = new Error(`Grok edit API error (${response.status}): ${errorText.substring(0, 200)}`);
      err.statusCode = response.status;
      log.error(`❌ [GROK] Edit API error ${response.status}: ${errorText.substring(0, 300)}`);
      throw err;
    }
    return response;
  };

  try {
    let response;
    try {
      response = await doFetch();
    } catch (firstError) {
      // Retry once on 500 (Grok internal error) after a short delay
      if (firstError.statusCode === 500) {
        log.warn(`⚠️ [GROK] Got 500 on edit, retrying once after 2s delay...`);
        await new Promise(r => setTimeout(r, 2000));
        response = await doFetch();
      } else {
        throw firstError;
      }
    }

    const data = await response.json();
    const elapsed = Date.now() - startTime;

    if (!data.data || !data.data[0]) {
      throw new Error('No image data in Grok edit response');
    }

    const imageBase64 = data.data[0].b64_json;
    let imageData = `data:image/jpeg;base64,${imageBase64}`;
    const cost = model === GROK_MODELS.PRO ? 0.07 : 0.02;

    // Verify output aspect ratio. Grok edit output is *supposed* to follow the
    // aspect_ratio param, but empirically it sometimes returns a different
    // aspect (usually its preferred 1024x1024). Detect drift and letterbox/pad
    // back to the requested aspect so the caller gets what it asked for.
    try {
      const outBuf = Buffer.from(imageBase64, 'base64');
      const outMeta = await sharp(outBuf).metadata();
      if (outMeta.width && outMeta.height) {
        const outRatio = outMeta.width / outMeta.height;
        const drift = Math.abs(outRatio - targetRatio) / targetRatio;
        if (drift >= 0.01) {
          log.warn(`⚠️ [GROK] Output aspect drift: ${outMeta.width}x${outMeta.height} (ratio ${outRatio.toFixed(3)}) vs requested ${aspectRatio} (ratio ${targetRatio.toFixed(3)}) — letterbox padding to correct`);
          let targetW, targetH;
          if (outRatio > targetRatio) {
            targetW = outMeta.width;
            targetH = Math.round(outMeta.width / targetRatio);
          } else {
            targetH = outMeta.height;
            targetW = Math.round(outMeta.height * targetRatio);
          }
          const padded = await sharp(outBuf)
            .resize(targetW, targetH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
            .jpeg({ quality: 90 })
            .toBuffer();
          imageData = `data:image/jpeg;base64,${padded.toString('base64')}`;
          log.info(`🎨 [GROK] Output corrected: ${outMeta.width}x${outMeta.height} → ${targetW}x${targetH}`);
        } else {
          log.debug(`🎨 [GROK] Output ${outMeta.width}x${outMeta.height} matches target ${aspectRatio}`);
        }
      }
    } catch (verifyErr) {
      log.warn(`⚠️ [GROK] Could not verify output dimensions: ${verifyErr.message}`);
    }

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
 * Extract the front-facing views from a 2x2 avatar grid and arrange them
 * horizontally side-by-side, producing a near-square reference image.
 *
 * Avatar grids are arranged:
 *   ┌──────────────┬──────────────┐
 *   │ Face Front   │ Face 3/4     │   ← Top row
 *   ├──────────────┼──────────────┤
 *   │ Body Front   │ Body Profile │   ← Bottom row
 *   └──────────────┴──────────────┘
 *
 * The previous implementation cropped to the LEFT COLUMN (Face Front + Body Front
 * stacked vertically), giving a 1:3.5 narrow strip. When that strip was padded to
 * a square slot for Grok, the character filled only ~28% of the slot width and
 * ended up rendered tiny in the output.
 *
 * This version extracts the same two cells (Face Front + Body Front) but lays
 * them out HORIZONTALLY = ~9:8 aspect, very close to square. After padding to
 * a square slot, the character fills ~89% of the slot — roughly 3× larger.
 *
 * Non-grid images (aspect ratio far from 1:1.75) are returned unchanged.
 *
 * @param {Buffer} buffer - Image buffer
 * @returns {Promise<Buffer>} Rearranged (or original) JPEG buffer
 */
async function cropToFrontColumn(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return buffer;

    // Only process portrait 2x2 grids (aspect ratio ~1.5-2.0).
    const aspect = meta.height / meta.width;
    if (aspect < 1.5 || aspect > 2.0) return buffer;

    // Detect actual grid separators via row/column variance (not blind 50/50).
    // The divider line has uniform color → lowest variance among all rows/columns.
    const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;

    // Find horizontal separator (face row ↔ body row)
    const hStart = Math.floor(height * 0.25);
    const hEnd = Math.floor(height * 0.75);
    let minHVar = Infinity, separatorY = Math.floor(height / 2);
    for (let y = hStart; y < hEnd; y++) {
      let sum = 0, sumSq = 0;
      for (let x = 0; x < width; x++) {
        const v = data[y * width + x];
        sum += v; sumSq += v * v;
      }
      const mean = sum / width;
      const variance = sumSq / width - mean * mean;
      if (variance < minHVar) { minHVar = variance; separatorY = y; }
    }

    // Find vertical separator (front view ↔ profile view)
    const vStart = Math.floor(width * 0.3);
    const vEnd = Math.floor(width * 0.7);
    let minVVar = Infinity, separatorX = Math.floor(width / 2);
    for (let x = vStart; x < vEnd; x++) {
      let sum = 0, sumSq = 0;
      for (let y = 0; y < height; y++) {
        const v = data[y * width + x];
        sum += v; sumSq += v * v;
      }
      const mean = sum / height;
      const variance = sumSq / height - mean * mean;
      if (variance < minVVar) { minVVar = variance; separatorX = x; }
    }

    log.debug(`🎨 [GROK] Grid separators detected: x=${separatorX} (of ${width}), y=${separatorY} (of ${height})`);

    // Extract Face Front (top-left) and Body Front (bottom-left) quadrants
    let faceFront = await sharp(buffer)
      .extract({ left: 0, top: 0, width: separatorX, height: separatorY })
      .toBuffer();
    const bodyFront = await sharp(buffer)
      .extract({ left: 0, top: separatorY, width: separatorX, height: height - separatorY })
      .toBuffer();

    // Trim background from face — the face is a tight crop that only fills ~30-50%
    // of the quadrant (rest is studio background). Trimming makes the face larger
    // relative to the body when composed side-by-side.
    const BG = { r: 220, g: 220, b: 220 };
    const preTrimMeta = await sharp(faceFront).metadata();
    try {
      const trimmed = await sharp(faceFront).trim({ threshold: 25 }).toBuffer();
      const trimMeta = await sharp(trimmed).metadata();
      // Only use trimmed result if it kept at least 30% of original dimensions
      // (avoids over-trimming when background color matches skin tone)
      if (trimMeta.width >= preTrimMeta.width * 0.3 && trimMeta.height >= preTrimMeta.height * 0.3) {
        faceFront = trimmed;
      }
    } catch { /* trim throws if entire image is uniform — keep original */ }

    // Resize both to same height (body height drives, face scales to match)
    const bodyMeta = await sharp(bodyFront).metadata();
    const targetH = bodyMeta.height;
    const faceResized = await sharp(faceFront)
      .resize({ height: targetH, fit: 'inside' })
      .jpeg({ quality: 90 })
      .toBuffer();
    const faceW = (await sharp(faceResized).metadata()).width;
    const bodyW = bodyMeta.width;

    // Compose side-by-side: body (left) + face (right) on light grey canvas
    const gap = 4;
    const outW = bodyW + faceW + gap;
    const composed = await sharp({
      create: {
        width: outW,
        height: targetH,
        channels: 3,
        background: BG,
      },
    })
      .composite([
        { input: bodyFront, left: 0, top: 0 },
        { input: faceResized, left: bodyW + gap, top: 0 },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    log.info(`🎨 [GROK] Rearranged front views: ${meta.width}x${meta.height} → ${outW}x${targetH} (sep: ${separatorX},${separatorY}, face trimmed to ${faceW}px)`);
    return composed;
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
 * All slots are padded to the requested aspect ratio with white letterbox bars
 * before being returned. Grok edit output matches the input aspect ratio, so
 * mismatched-aspect inputs would otherwise produce mismatched-aspect outputs.
 *
 * @param {Object} refs
 * @param {Buffer|null} refs.visualBibleGrid - VB grid buffer (JPEG)
 * @param {Array<{name: string, photoData: string}>} refs.landmarkPhotos - Landmark data URIs
 * @param {Array} refs.characterPhotos - Character photos (string data URIs or {name, photoUrl})
 * @param {string|null} refs.previousImage - Previous scene data URI
 * @param {string|null} refs.sceneBackground - Scene background data URI (style anchor)
 * @param {Object} [options]
 * @param {string} [options.aspectRatio='1:1'] - Target output aspect ratio (e.g. '1:1', '3:4', '9:16')
 * @returns {Promise<string[]>} Array of data URIs (max 3), all padded to the target aspect
 */
async function packReferences(refs = {}, options = {}) {
  const {
    visualBibleGrid = null,
    landmarkPhotos = [],
    characterPhotos = [],
    previousImage = null,
    sceneBackground = null,
  } = refs;
  const { aspectRatio = '1:1', pageLabel = '' } = options;
  const tag = pageLabel ? `[GROK P${pageLabel}]` : '[GROK]';

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
      // Crop to front column for avatar grids (2-column: front | side view)
      // Avatar types (styled-*, costumed-*, clothing-*) are 2-column grids — crop to left half
      // Raw photos (face, body, bodyNoBg, fallback) are single images — do NOT crop
      const photoType = typeof photoData === 'object' ? photoData?.photoType : null;
      const isAvatarGrid = photoType && (photoType.startsWith('styled-') || photoType.startsWith('costumed-') || photoType.startsWith('clothing-'));
      const croppedBuffer = isAvatarGrid ? await cropToFrontColumn(rawBuffer) : rawBuffer;
      charBuffers.push(croppedBuffer);
    } else if (charName) {
      log.warn(`⚠️ ${tag} Skipped character "${charName}": photoUrl is ${photoUrl ? typeof photoUrl : 'null/undefined'} (not base64)`);
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

  // Count how many character slots we need (max 3 total reference slots for Grok)
  const charCount = charBuffers.length;
  const slots = [];

  // Decide whether to bake VB elements into the scene background as a border.
  // Border mode is ONLY used when 2+ characters need their own slots — there's
  // no free slot for a standalone VB grid. With 0–1 characters we have a free
  // slot, so the scene stays clean and the VB grid gets its own slot at full size.
  const hasSceneBackground = sceneBackground && sceneBackground.startsWith('data:image');
  // Filter out location elements when scene background exists — the location is
  // already painted in the background, so a border cell showing the same thing
  // wastes a reference slot.
  const rawVbElements = (visualBibleGrid && Array.isArray(visualBibleGrid.rawElements))
    ? visualBibleGrid.rawElements.filter(e => !(hasSceneBackground && e.type === 'location'))
    : [];
  const useBorderedScene = hasSceneBackground && rawVbElements.length > 0 && charCount >= 2;

  // Scene background goes first — style anchor for visual consistency
  if (hasSceneBackground) {
    const base64 = sceneBackground.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');

    if (useBorderedScene) {
      const bordered = await composeSceneWithVbBorder(buf, rawVbElements);
      slots.push(`data:image/jpeg;base64,${bordered.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: scene background + ${Math.min(rawVbElements.length, 9)} VB cells (bordered 1280x1280)`);
    } else {
      const resized = await sharp(buf).resize({ height: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: scene background (clean style anchor)`);
    }
  }

  // Previous image goes FIRST — it's the scene being re-rendered (style transfer)
  // or the previous page for visual continuity (sequential mode)
  if (previousImage && previousImage.startsWith('data:image')) {
    const base64 = previousImage.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const resized = await sharp(buf).resize({ height: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
    log.info(`🎨 ${tag} Slot ${slots.length}: previous/source image`);
  }

  // Strategy: maximize character image quality by giving them separate slots.
  // When the scene background is BORDERED (2+ chars), VB+landmarks are already
  // embedded in it, so we skip them below to free slots for character photos.
  // With a CLEAN scene background (0–1 chars), the VB grid gets its own slot.
  //
  // Character takes priority over landmark in 0–1 char mode: when a scene
  // background is present, the landmark is already baked into it (empty scenes
  // are generated with the landmark photo as reference), so the dedicated
  // landmark slot is redundant — the character slot matters more.
  //
  // Bordered scene (slots used: 1 for bg with VB baked in):
  //   2 chars: Slot 2 = char 1, Slot 3 = char 2
  //   3+ chars: Slot 2 = chars first half, Slot 3 = chars second half
  //
  // Clean scene + 0–1 chars (slot 1 = scene, slots 2-3 free):
  //   0 chars: Slot 2 = VB grid, Slot 3 = landmark(s)
  //   1 char:  Slot 2 = VB grid, Slot 3 = character (landmark dropped — already in scene)
  //
  // No scene background (all 3 slots free):
  //   1 char:  Slot 1 = VB grid, Slot 2 = character, Slot 3 = landmark(s)
  //   2 chars: Slot 1 = VB + landmarks stitched, Slot 2 = char 1, Slot 3 = char 2
  //   3+ chars: Slot 1 = VB + landmarks stitched, Slot 2 = chars first half, Slot 3 = chars second half

  // Skip VB grid and landmarks only when they are baked into the bordered scene
  const skipContext = useBorderedScene;

  if (charCount <= 1) {
    // ── 0-1 characters ──
    // Character takes priority over landmark: when a scene background is present,
    // the landmark is already baked into it (empty scenes are generated with the
    // landmark photo as reference). The dedicated landmark slot is therefore
    // redundant in that case, and the character slot matters more for consistency.
    if (!skipContext && visualBibleGrid) {
      const resized = await sharp(visualBibleGrid).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: VB grid`);
    }

    if (charCount === 1 && slots.length < 3) {
      // Upscale to height 768 (no withoutEnlargement) so the rearranged
      // front-views fill the slot at higher resolution for Grok.
      const resized = await sharp(charBuffers[0]).resize({ height: 768 }).jpeg({ quality: 85 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: 1 character photo`);
    }

    // Add landmark photo if there's a free slot (max 3 total)
    if (landmarkBuffers.length > 0 && slots.length < 3) {
      const resized = await sharp(landmarkBuffers[0]).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: landmark photo`);
    } else if (landmarkBuffers.length > 0) {
      log.debug(`🎨 ${tag} Skipping ${landmarkBuffers.length} landmark(s) — no free slots`);
    }
  } else {
    // ── 2+ characters ──
    if (!skipContext) {
      // VB grid only — no landmarks (they waste a slot that characters need)
      if (visualBibleGrid) {
        const resized = await sharp(visualBibleGrid).resize({ height: 768, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
        slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
        log.info(`🎨 ${tag} Slot ${slots.length}: VB grid`);
      }
    }

    if (charCount === 2) {
      // 2 characters: one per slot — upscale so each fills the slot
      for (const buf of charBuffers) {
        if (slots.length >= 3) break;
        const resized = await sharp(buf).resize({ height: 768 }).jpeg({ quality: 85 }).toBuffer();
        slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      }
      if (charBuffers.length > 0) log.info(`🎨 ${tag} Slot ${slots.length - Math.min(charCount, 3 - (slots.length - charCount))}-${slots.length}: ${Math.min(charCount, 3 - slots.length + charCount)} character photos (separate)`);
    } else {
      // 3+ characters: split into two groups, stitch each
      const mid = Math.ceil(charCount / 2);
      const group1 = charBuffers.slice(0, mid);
      const group2 = charBuffers.slice(mid);

      if (group1.length > 0 && slots.length < 3) {
        const stitched = await stitchImagesHorizontally(group1, 768, { allowEnlargement: true });
        slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
        log.info(`🎨 ${tag} Slot ${slots.length}: ${group1.length} characters stitched`);
      }
      if (group2.length > 0 && slots.length < 3) {
        const stitched = await stitchImagesHorizontally(group2, 768, { allowEnlargement: true });
        slots.push(`data:image/jpeg;base64,${stitched.toString('base64')}`);
        log.info(`🎨 ${tag} Slot ${slots.length}: ${group2.length} characters stitched`);
      }
    }
  }

  // Grok edit output matches the input image aspect ratio (it mostly ignores the
  // aspect_ratio API param for edits). Pad every slot to the requested aspect so
  // the output matches. Never leave a non-matching slot in place — doing so would
  // let the output inherit the wrong shape (e.g. square pages rendering as 3:4).
  const [aspW, aspH] = String(aspectRatio).split(':').map(Number);
  const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
  const TOLERANCE = 0.01; // within 1% of target → no-op
  const FALLBACK_SIZE = 1024;

  const paddedSlots = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const base64 = slot.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');

    let meta;
    try {
      meta = await sharp(buf).metadata();
    } catch (metaErr) {
      log.warn(`⚠️ ${tag} Slot ${i + 1}: metadata read failed (${metaErr.message}) — forcing ${FALLBACK_SIZE}x${FALLBACK_SIZE} fallback`);
      meta = null;
    }

    const w = meta?.width || 0;
    const h = meta?.height || 0;

    // Metadata invalid → force the slot into a fallback square and continue
    if (!w || !h) {
      try {
        const fallbackRatio = targetRatio;
        const fw = Math.round(FALLBACK_SIZE * (fallbackRatio >= 1 ? 1 : fallbackRatio));
        const fh = Math.round(FALLBACK_SIZE / (fallbackRatio >= 1 ? fallbackRatio : 1));
        const padded = await sharp(buf)
          .resize(fw, fh, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .jpeg({ quality: 90 })
          .toBuffer();
        paddedSlots.push(`data:image/jpeg;base64,${padded.toString('base64')}`);
        log.debug(`🎨 ${tag} Slot ${i + 1}: fallback padded to ${fw}x${fh}`);
      } catch (fallbackErr) {
        log.error(`❌ [GROK] Slot ${i + 1}: fallback padding failed (${fallbackErr.message}) — dropping slot`);
      }
      continue;
    }

    const currentRatio = w / h;

    // Already within tolerance → no-op (log the confirmed shape so we can verify)
    if (Math.abs(currentRatio - targetRatio) / targetRatio < TOLERANCE) {
      paddedSlots.push(slot);
      log.debug(`🎨 ${tag} Slot ${i + 1}: ${w}x${h} already matches target ${aspectRatio}`);
      continue;
    }

    // Compute the smallest box that contains the source and matches target aspect
    let targetW, targetH;
    if (currentRatio > targetRatio) {
      // Source is wider than target → keep width, grow height with letterbox bars
      targetW = w;
      targetH = Math.round(w / targetRatio);
    } else {
      // Source is taller than target → keep height, grow width with letterbox bars
      targetH = h;
      targetW = Math.round(h * targetRatio);
    }

    try {
      const padded = await sharp(buf)
        .resize(targetW, targetH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .jpeg({ quality: 90 })
        .toBuffer();
      paddedSlots.push(`data:image/jpeg;base64,${padded.toString('base64')}`);
      log.debug(`🎨 ${tag} Slot ${i + 1}: padded ${w}x${h} → ${targetW}x${targetH} (target ${aspectRatio})`);
    } catch (padErr) {
      log.warn(`⚠️ [GROK] Slot ${i + 1}: pad failed (${padErr.message}) — dropping slot`);
    }
  }

  log.info(`🎨 [GROK] Packed ${paddedSlots.length}/3 reference slots at ${aspectRatio} (prev: ${previousImage ? 'yes' : 'no'}, ${charCount} chars, ${landmarkBuffers.length} landmarks, VB: ${visualBibleGrid ? 'yes' : 'no'})`);
  return paddedSlots;
}

/**
 * Compose the empty scene with VB reference elements arranged around it as a border.
 *
 * Layout (1280x1280 canvas, black background):
 *   ┌──────────────────────┬─────┐
 *   │                      │  1  │
 *   │                      ├─────┤
 *   │     Empty scene      │  2  │
 *   │      1024x1024       ├─────┤
 *   │                      │  3  │
 *   │                      ├─────┤
 *   │                      │  4  │
 *   ├─────┬─────┬─────┬─────┬────┤
 *   │  5  │  6  │  7  │  8  │  9 │
 *   └─────┴─────┴─────┴─────┴────┘
 *
 * Each cell is 256x256. Right column = slots 1-4, bottom row = slots 5-9.
 * Capped at 9 elements total.
 *
 * @param {Buffer} sceneBuffer - Empty scene image buffer (any size, will be resized to 1024x1024)
 * @param {Array<{imageData: string, name: string, type: string}>} vbElements - Up to 9 VB elements
 * @returns {Promise<Buffer>} JPEG buffer of the composited 1280x1280 image
 */
async function composeSceneWithVbBorder(sceneBuffer, vbElements = []) {
  const CANVAS = 1280;
  const SCENE = 1024;
  const CELL = 256;
  const MAX_ELEMENTS = 9;

  // Resize scene to exactly 1024x1024 (contain so we don't crop the artwork)
  const sceneResized = await sharp(sceneBuffer)
    .resize(SCENE, SCENE, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .toBuffer();

  // Cell positions: 4 right column, then 5 bottom row
  const cellPositions = [
    // Right column (x = 1024, y = 0/256/512/768)
    { left: SCENE, top: 0 },
    { left: SCENE, top: CELL },
    { left: SCENE, top: CELL * 2 },
    { left: SCENE, top: CELL * 3 },
    // Bottom row (y = 1024, x = 0/256/512/768/1024) — fills full 1280 width
    { left: 0, top: SCENE },
    { left: CELL, top: SCENE },
    { left: CELL * 2, top: SCENE },
    { left: CELL * 3, top: SCENE },
    { left: CELL * 4, top: SCENE },
  ];

  const elements = vbElements.slice(0, MAX_ELEMENTS);
  const composites = [{ input: sceneResized, left: 0, top: 0 }];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const pos = cellPositions[i];
    if (!el.imageData) continue;

    try {
      const base64 = el.imageData.replace(/^data:image\/\w+;base64,/, '');
      const elBuf = Buffer.from(base64, 'base64');

      // Fill the cell with the element image (cover crops to fit, maximizes visibility)
      const cellImage = await sharp(elBuf)
        .resize(CELL, CELL, { fit: 'cover' })
        .toBuffer();
      composites.push({ input: cellImage, left: pos.left, top: pos.top });

      // Caption strip overlay at the bottom of the cell (40px tall, dark translucent)
      const labelText = `${el.name} (${el.type})`;
      const displayText = labelText.length > 28 ? labelText.substring(0, 25) + '...' : labelText;
      // Escape XML special chars
      const safeText = displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const captionHeight = 36;
      const captionSvg = `
        <svg width="${CELL}" height="${captionHeight}">
          <rect width="${CELL}" height="${captionHeight}" fill="black" fill-opacity="0.65"/>
          <text x="${CELL / 2}" y="24" font-family="Arial, sans-serif" font-size="18"
                font-weight="bold" fill="white" text-anchor="middle">${safeText}</text>
        </svg>
      `;
      composites.push({
        input: Buffer.from(captionSvg),
        left: pos.left,
        top: pos.top + CELL - captionHeight,
      });
    } catch (err) {
      log.warn(`⚠️ [GROK] composeSceneWithVbBorder: failed to render cell ${i} (${el.name}): ${err.message}`);
    }
  }

  const out = await sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();

  log.info(`🖼️ [GROK] Composed scene+VB border: ${CANVAS}x${CANVAS}, scene=${SCENE}px, ${elements.length} VB cells (${CELL}x${CELL})`);
  return out;
}

/**
 * Stitch multiple image buffers horizontally into one row.
 * All images resized to the same height, then placed side by side.
 *
 * @param {Buffer[]} buffers - Array of image buffers
 * @param {number} targetHeight - Height to normalize to
 * @returns {Promise<Buffer>} JPEG buffer of the stitched image
 */
async function stitchImagesHorizontally(buffers, targetHeight = 768, options = {}) {
  const { allowEnlargement = false } = options;
  const resizeOpts = allowEnlargement
    ? { height: targetHeight }
    : { height: targetHeight, withoutEnlargement: true };

  if (buffers.length === 1) {
    // Single image — just resize and return
    return sharp(buffers[0])
      .resize(resizeOpts)
      .jpeg({ quality: 85 })
      .toBuffer();
  }

  // Resize all to same height, get metadata
  const resized = [];
  for (const buf of buffers) {
    const img = sharp(buf).resize(resizeOpts);
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
      background: { r: 220, g: 220, b: 220 },
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
