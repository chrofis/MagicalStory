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
const r2 = require('./r2');
const { withGrok } = require('./aiConcurrency');
const { frameColorForName } = require('./characterFrames');

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

  const doFetch = async () => withGrok(async () => {
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
  });

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

    // sentToGrok — verbatim snapshot of the actual API request (see
    // matching block in editWithGrok above). Single source of truth for
    // dev-panel "what was sent" — guaranteed correct because it's captured
    // at the API call site, not synthesised by every caller.
    const sentToGrok = {
      endpoint: '/v1/images/generations',
      model,
      aspectRatio,
      resolution,
      prompt,
      promptLength: prompt.length,
      referenceImages: [],  // generate endpoint has no input images
      capturedAt: new Date().toISOString(),
      elapsedMs: elapsed,
    };

    return {
      imageData,
      usage: {
        cost,
        direct_cost: cost,
        inferenceTime: elapsed,
      },
      modelId: model,
      sentToGrok,
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
    skipOutputPadding = true, // Don't letterbox-pad Grok's output — callers handle varying aspects
    padInput = false,         // PAD inputs to target aspect instead of CROP. Use when the
                              // reference image is on a uniform/white background (avatars)
                              // — padding adds invisible margins. Don't use for inputs with
                              // full backgrounds (scenes/covers) — pad bars survive through
                              // the edit and bake into the output as visible letterboxing.
    padInputWithExtension = false, // For scene-like slot-0 inputs whose aspect differs from
                              // target: pad slot 0 with MAGENTA (#FF00FF) and auto-prepend
                              // an extension instruction to the prompt telling Grok to
                              // paint the magenta regions with scene continuation (more
                              // sky above, more ground below, etc). Grok edit returns the
                              // input aspect, so a magenta-padded 3:4 input → 3:4 output
                              // with the magenta filled. Use this instead of padInput when
                              // the input has a full background. Confirmed working on the
                              // Holzbrücke Wikipedia photo: 3:2 landscape color → 3:4
                              // portrait manga B&W with sky + river extended cleanly.
                              // Slots 1+ (avatars, VB grids) keep their existing padInput
                              // behavior — only slot 0 gets the magenta treatment.
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
      const base64 = r2.stripDataUriPrefix(url);
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
  // param). To get a specific output aspect we must normalise every input image
  // to that aspect.
  //
  // Two strategies — caller picks via the `padInput` option:
  //   - default (crop): fit:cover. Loses edge content but preserves edge-to-edge
  //     visuals. Right for scenes/covers where the input is a full illustration.
  //   - padInput=true: EXPAND the shorter axis with white padding. Preserves
  //     every pixel of the source — the bug fix for clothing avatars, where the
  //     bodyNoBg input is a tall portrait and cover-crop was slicing the face
  //     off the top of the image. Safe when the source is already on a white
  //     background; for full-background inputs the bars survive into the output.
  // Parses aspectRatio strings like '3:4', '1:1', '9:16'.
  const [aspW, aspH] = String(aspectRatio).split(':').map(Number);
  const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
  // Track magenta padding applied to slot 0 so we can prepend the extension
  // instruction to the prompt. Only slot 0 (primary scene plate) gets magenta;
  // slots 1+ are labeled reference cards that shouldn't be "extended".
  let slot0Pad = null;
  for (let i = 0; i < images.length; i++) {
    try {
      const base64 = r2.stripDataUriPrefix(images[i]);
      const buf = Buffer.from(base64, 'base64');
      const meta = await sharp(buf).metadata();
      if (!meta.width || !meta.height) continue;
      const currentRatio = meta.width / meta.height;
      // Skip if already within 1% of target (avoid gratuitous re-encode)
      if (Math.abs(currentRatio - targetRatio) / targetRatio < 0.01) continue;
      const useMagentaExtension = padInputWithExtension && i === 0;
      let targetW, targetH, fit, background;
      if (padInput || useMagentaExtension) {
        // EXPAND the shorter axis. Magenta for slot 0 when extension mode is on
        // (Grok fills the magenta with scene continuation per the prompt prefix);
        // white otherwise (existing avatar behavior).
        if (currentRatio > targetRatio) {
          // Source wider than target — keep width, expand height.
          targetW = meta.width;
          targetH = Math.round(meta.width / targetRatio);
        } else {
          // Source taller than target — keep height, expand width.
          targetH = meta.height;
          targetW = Math.round(meta.height * targetRatio);
        }
        fit = 'contain';
        background = useMagentaExtension
          ? { r: 255, g: 0, b: 255 }      // magenta — placeholder Grok will fill
          : { r: 255, g: 255, b: 255 };   // white — original padInput behavior
        if (useMagentaExtension) {
          // Per-axis pad pixel counts so the prompt prefix names exact dimensions
          // ("top 343px, bottom 344px") — gives Grok an unambiguous anchor.
          const padW = targetW - meta.width;
          const padH = targetH - meta.height;
          slot0Pad = {
            top: Math.floor(padH / 2),
            bottom: padH - Math.floor(padH / 2),
            left: Math.floor(padW / 2),
            right: padW - Math.floor(padW / 2),
          };
        }
      } else {
        // CROP the longer axis. Trim edge content; preserve edge-to-edge visuals.
        if (currentRatio > targetRatio) {
          // Source wider than target — keep height, crop width.
          targetH = meta.height;
          targetW = Math.round(meta.height * targetRatio);
        } else {
          // Source taller than target — keep width, crop height.
          targetW = meta.width;
          targetH = Math.round(meta.width / targetRatio);
        }
        fit = 'cover';
      }
      const resizeOpts = { fit, position: 'centre' };
      if (background) resizeOpts.background = background;
      const out = await sharp(buf)
        .resize(targetW, targetH, resizeOpts)
        .jpeg({ quality: 90 })
        .toBuffer();
      images[i] = `data:image/jpeg;base64,${out.toString('base64')}`;
      const padMode = (padInputWithExtension && i === 0) ? 'Magenta-padded' : (padInput ? 'Padded' : 'Cropped');
      log.debug(`🎨 [GROK] ${padMode} edit input ${i}: ${meta.width}x${meta.height} → ${targetW}x${targetH} (aspect ${aspectRatio})`);
    } catch (padErr) {
      log.warn(`⚠️ [GROK] Failed to normalise edit image ${i} aspect: ${padErr.message}`);
    }
  }

  // Auto-prepend extension instruction when slot 0 got magenta-padded. Names
  // the exact pixel counts so Grok has unambiguous anchors. Without this
  // prefix the magenta would survive into the output as visible bars.
  if (slot0Pad && (slot0Pad.top + slot0Pad.bottom + slot0Pad.left + slot0Pad.right) > 0) {
    const parts = [];
    if (slot0Pad.top > 0) parts.push(`${slot0Pad.top}px at the TOP`);
    if (slot0Pad.bottom > 0) parts.push(`${slot0Pad.bottom}px at the BOTTOM`);
    if (slot0Pad.left > 0) parts.push(`${slot0Pad.left}px on the LEFT`);
    if (slot0Pad.right > 0) parts.push(`${slot0Pad.right}px on the RIGHT`);
    const prefix = `The first input image has SOLID BRIGHT MAGENTA (pure #FF00FF) placeholder padding: ${parts.join(', ')}. Extend the existing scene content INTO these magenta regions so the output is a continuous illustration filling the entire canvas — paint matching sky above, matching ground/foreground below, matching scene continuation on the sides. The non-magenta center region must remain pixel-faithful in composition and geometry. DO NOT preserve any magenta. DO NOT add a magenta/pink/purple border, frame, or vignette. The final output must have NO visible magenta and NO visible padding boundary.\n\n`;
    prompt = prefix + prompt;
    log.info(`🎨 [GROK] Magenta-extension active on slot 0: pad top=${slot0Pad.top} bottom=${slot0Pad.bottom} left=${slot0Pad.left} right=${slot0Pad.right}`);
  }

  log.info(`🎨 [GROK] Starting edit (model: ${model}, refs: ${images.length}, aspect: ${aspectRatio})`);
  // Per-slot identification — bytes + role hint when caller annotated images
  // with a `_role` (the production callers tag each ref so the log shows which
  // slot is the VB grid, costumed avatar, landmark, empty-scene, etc.).
  // Fallback when callers haven't tagged: just byte size.
  for (let i = 0; i < images.length; i++) {
    try {
      const url = typeof images[i] === 'string' ? images[i] : images[i]?.url || '';
      const tag = (typeof images[i] === 'object' && images[i]?._role) ? images[i]._role : null;
      const sizeKb = url.startsWith('data:')
        ? Math.round((url.length - url.indexOf(',') - 1) * 0.75 / 1024)
        : null;
      const sizeStr = sizeKb != null ? `${sizeKb}KB` : '(remote URL)';
      log.info(`🎨 [GROK] → slot ${i + 1}: ${tag || 'image'} ${sizeStr}`);
    } catch { /* logging only */ }
  }
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

  const doFetch = async () => withGrok(async () => {
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
  });

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
    // aspect (usually its preferred 1024x1024). Detect drift and CROP to the
    // requested aspect so the caller gets what it asked for.
    //
    // We crop (cover) instead of padding (contain+white) because padding
    // produces highly visible white bars on the stored image — scenes with
    // ~0.89 aspect fitted to 0.7 target end up with 20% of vertical space
    // being white. Center-cropping zooms the content slightly but keeps
    // the image fully illustrated, which is what children's book pages need.
    // Character repair callers set skipOutputPadding=true because they handle
    // border detection themselves.
    if (!skipOutputPadding) try {
      const outBuf = Buffer.from(imageBase64, 'base64');
      const outMeta = await sharp(outBuf).metadata();
      if (outMeta.width && outMeta.height) {
        const outRatio = outMeta.width / outMeta.height;
        const drift = Math.abs(outRatio - targetRatio) / targetRatio;
        if (drift >= 0.01) {
          // Scale source so the SHORTER dimension (relative to target) fills
          // the target, then center-crop the excess on the longer dimension.
          // Derive targetW/targetH preserving the source's smaller side.
          let targetW, targetH;
          if (outRatio > targetRatio) {
            // Source wider than target: keep height, crop width
            targetH = outMeta.height;
            targetW = Math.round(outMeta.height * targetRatio);
          } else {
            // Source taller than target: keep width, crop height
            targetW = outMeta.width;
            targetH = Math.round(outMeta.width / targetRatio);
          }
          log.warn(`⚠️ [GROK] Output aspect drift: ${outMeta.width}x${outMeta.height} (ratio ${outRatio.toFixed(3)}) vs requested ${aspectRatio} (ratio ${targetRatio.toFixed(3)}) — center-cropping to ${targetW}x${targetH}`);
          const cropped = await sharp(outBuf)
            .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 95 })
            .toBuffer();
          imageData = `data:image/jpeg;base64,${cropped.toString('base64')}`;
          log.info(`🎨 [GROK] Output corrected: ${outMeta.width}x${outMeta.height} → ${targetW}x${targetH} (cover-crop)`);
        } else {
          log.debug(`🎨 [GROK] Output ${outMeta.width}x${outMeta.height} matches target ${aspectRatio}`);
        }
      }
    } catch (verifyErr) {
      log.warn(`⚠️ [GROK] Could not verify output dimensions: ${verifyErr.message}`);
    }

    log.info(`✅ [GROK] Edit complete in ${elapsed}ms. Cost: $${cost}. Refs: ${images.length}`);

    // sentToGrok — verbatim snapshot of the actual API request. Bake it
    // here so every caller's dev-panel debug has the SAME source of truth as
    // what hit Grok's wire. If a future caller forgets to update its own
    // debug bundle, the snapshot is still correct because it comes from this
    // single call site, not a parallel code path.
    const sentToGrok = {
      endpoint: '/v1/images/edits',
      model,
      aspectRatio,
      prompt,
      promptLength: prompt.length,
      referenceImages: images.map((url, idx) => {
        const u = typeof url === 'string' ? url : (url?.url || '');
        const role = (typeof url === 'object' && url?._role) || null;
        const sizeKb = u.startsWith('data:')
          ? Math.round((u.length - u.indexOf(',') - 1) * 0.75 / 1024)
          : null;
        return { slot: idx + 1, role, dataUri: u, sizeKb };
      }),
      capturedAt: new Date().toISOString(),
      elapsedMs: elapsed,
    };

    return {
      imageData,
      usage: {
        cost,
        direct_cost: cost,
        inferenceTime: elapsed,
      },
      modelId: model,
      sentToGrok,
    };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    log.error(`❌ [GROK] Edit failed after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

// Shared constants for character composition
const CHAR_BG = { r: 220, g: 220, b: 220 };
const CHAR_GAP = 4;

/**
 * Bind a character reference card to a character with a COLOURED FRAME instead
 * of a stamped name. A name caption gets copied into the output by Grok (it
 * paints visible glyphs) — that's how child names leaked onto finished pages.
 * A frame is not paintable scene content, so it binds card↔character without
 * leaking. A white gap separates the character from the frame so Grok reads it
 * as a frame, not the character's own colour. The prompt carries the
 * "<colour> = <name>" mapping (see buildImagePrompt) — both derive the colour
 * from the same per-page name set via frameColorForName().
 *
 * @param {Buffer} buffer - Pre-composed character image (vertical stack or horizontal strip)
 * @param {{label:string, rgb:{r:number,g:number,b:number}}|null} color - frame colour; falsy → unchanged
 */
async function frameCharacterImage(buffer, color) {
  if (!color || !color.rgb) return buffer;
  const meta = await sharp(buffer).metadata();
  const width = meta.width;
  const height = meta.height;
  if (!width || !height) return buffer;

  // Border proportional to HEIGHT, not min(w,h): packReferences resizes every
  // slot to a common height, so a height-relative border lands at the SAME
  // visible thickness on every card regardless of its original size. Thin enough
  // to read as a clean frame, not a thick band that swamps the white card.
  const border = Math.max(8, Math.round(height * 0.02));
  const gap = Math.max(4, Math.round(border * 0.4)); // white gap → reads as a frame, not an aura
  // White gap first, then the solid colour border around it.
  const withGap = await sharp(buffer)
    .extend({ top: gap, bottom: gap, left: gap, right: gap, background: { r: 255, g: 255, b: 255 } })
    .toBuffer();
  return sharp(withGap)
    .extend({ top: border, bottom: border, left: border, right: border, background: color.rgb })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Extract Face Front and Body Front quadrants from a 2x2 avatar grid.
 *
 * Avatar grids are arranged:
 *   ┌──────────────┬──────────────┐
 *   │ Face Front   │ Face 3/4     │   ← Top row
 *   ├──────────────┼──────────────┤
 *   │ Body Front   │ Body Profile │   ← Bottom row
 *   └──────────────┴──────────────┘
 *
 * Grid separators are detected via row/column variance (divider lines have
 * the lowest variance). The face is auto-trimmed to remove studio background
 * (kept only if the trim retains ≥30% of original dimensions).
 *
 * @param {Buffer} buffer
 * @returns {Promise<{face: Buffer, body: Buffer}|null>} null if the buffer
 *   isn't a 2x2 grid (aspect ratio outside 1.5-2.0).
 */
async function extractFaceAndBody(buffer) {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const aspect = meta.height / meta.width;
  if (aspect < 1.5 || aspect > 2.0) return null;

  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  // Horizontal separator (face row ↔ body row)
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

  // Vertical separator (front view ↔ profile view)
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

  let faceFront = await sharp(buffer)
    .extract({ left: 0, top: 0, width: separatorX, height: separatorY })
    .toBuffer();
  const bodyFront = await sharp(buffer)
    .extract({ left: 0, top: separatorY, width: separatorX, height: height - separatorY })
    .toBuffer();

  // Trim face background; keep trimmed result only if ≥30% of original dims survive
  const preTrimMeta = await sharp(faceFront).metadata();
  try {
    const trimmed = await sharp(faceFront).trim({ threshold: 25 }).toBuffer();
    const trimMeta = await sharp(trimmed).metadata();
    if (trimMeta.width >= preTrimMeta.width * 0.3 && trimMeta.height >= preTrimMeta.height * 0.3) {
      faceFront = trimmed;
    }
  } catch { /* trim throws on uniform images — keep original */ }

  return { face: faceFront, body: bodyFront };
}

/**
 * Compose [body | face] horizontally. Body stays at native height; face is
 * resized to match. Produces a near-square strip (~9:8).
 */
async function composeBodyFaceHorizontal(face, body) {
  const bodyMeta = await sharp(body).metadata();
  const targetH = bodyMeta.height;
  const faceResized = await sharp(face)
    .resize({ height: targetH, fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer();
  const faceW = (await sharp(faceResized).metadata()).width;
  const bodyW = bodyMeta.width;
  const outW = bodyW + faceW + CHAR_GAP;
  return sharp({
    create: { width: outW, height: targetH, channels: 3, background: CHAR_BG },
  })
    .composite([
      { input: body, left: 0, top: 0 },
      { input: faceResized, left: bodyW + CHAR_GAP, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Compose [face / body] vertically. Body stays at native width; face is
 * resized to match. Produces a tall portrait strip.
 */
async function composeFaceBodyVertical(face, body) {
  const bodyMeta = await sharp(body).metadata();
  const targetW = bodyMeta.width;
  const faceResized = await sharp(face)
    .resize({ width: targetW, fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer();
  const faceH = (await sharp(faceResized).metadata()).height;
  const bodyH = bodyMeta.height;
  const outH = faceH + bodyH + CHAR_GAP;
  return sharp({
    create: { width: targetW, height: outH, channels: 3, background: CHAR_BG },
  })
    .composite([
      { input: faceResized, left: 0, top: 0 },
      { input: body, left: 0, top: faceH + CHAR_GAP },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Place image buffers horizontally in a row, all resized to max common height.
 */
async function composeRow(buffers) {
  if (buffers.length === 0) return null;
  if (buffers.length === 1) return buffers[0];
  const metas = await Promise.all(buffers.map(b => sharp(b).metadata()));
  const rowH = Math.max(...metas.map(m => m.height));
  const resized = [];
  let totalW = 0;
  for (const buf of buffers) {
    const r = await sharp(buf).resize({ height: rowH, fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
    const rm = await sharp(r).metadata();
    resized.push({ buffer: r, width: rm.width });
    totalW += rm.width;
  }
  const outW = totalW + CHAR_GAP * (resized.length - 1);
  const composites = [];
  let x = 0;
  for (const r of resized) {
    composites.push({ input: r.buffer, left: x, top: 0 });
    x += r.width + CHAR_GAP;
  }
  return sharp({
    create: { width: outW, height: rowH, channels: 3, background: CHAR_BG },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Stack two rows vertically. Both rows are centered horizontally; the wider
 * row sets the composite width and the narrower row gets grey fill on the sides.
 */
async function composeStack(topRow, bottomRow) {
  const tm = await sharp(topRow).metadata();
  const bm = await sharp(bottomRow).metadata();
  const outW = Math.max(tm.width, bm.width);
  const outH = tm.height + bm.height + CHAR_GAP;
  const topX = Math.floor((outW - tm.width) / 2);
  const botX = Math.floor((outW - bm.width) / 2);
  return sharp({
    create: { width: outW, height: outH, channels: 3, background: CHAR_BG },
  })
    .composite([
      { input: topRow, left: topX, top: 0 },
      { input: bottomRow, left: botX, top: tm.height + CHAR_GAP },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/**
 * Build a single slot image holding 1-3 characters with an aspect-aware layout.
 *
 *   n=1:        [body | face] horizontal           (~9:8, near square)
 *   n=2:        2× [face / body] vertical stacks side-by-side  (~3:4 portrait)
 *   n=3 square: 3× vertical stacks side-by-side    (~3:2, near square)
 *   n=3 A4:     2 vertical stacks on top + 1 horizontal strip below
 *
 * Characters without an avatar-grid photoType (raw face/body/bodyNoBg) fall
 * back to the raw buffer as-is.
 *
 * @param {Buffer[]} rawBuffers
 * @param {(string|null)[]} photoTypes
 * @param {string} aspectRatio - Target slot aspect (e.g. '1:1', '3:4')
 * @returns {Promise<Buffer|null>} null if rawBuffers is empty or n > 3.
 */
/**
 * Pad a composed character slot to the exact target aspect using CHAR_BG (the
 * same grey already used between characters in composeRow / composeStack).
 * Grok sees this as more of the existing inter-character background, so it
 * doesn't bake "bars" into the output the way black/white padding did. After
 * this step packReferences's aspect-pad cover-crop becomes a no-op and no
 * heads get cropped off the slot edges.
 */
async function padCharacterSlotToAspect(buffer, aspectRatio) {
  const [aspW, aspH] = String(aspectRatio || '1:1').split(':').map(Number);
  const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return buffer;
  const currentRatio = meta.width / meta.height;
  if (Math.abs(currentRatio - targetRatio) / targetRatio < 0.01) return buffer;

  let padTop = 0, padBottom = 0, padLeft = 0, padRight = 0;
  if (currentRatio > targetRatio) {
    // Source wider than target → grow height (pad top + bottom)
    const targetH = Math.round(meta.width / targetRatio);
    const total = targetH - meta.height;
    padTop = Math.floor(total / 2);
    padBottom = total - padTop;
  } else {
    // Source taller than target → grow width (pad left + right)
    const targetW = Math.round(meta.height * targetRatio);
    const total = targetW - meta.width;
    padLeft = Math.floor(total / 2);
    padRight = total - padLeft;
  }
  return sharp(buffer)
    .extend({ top: padTop, bottom: padBottom, left: padLeft, right: padRight, background: CHAR_BG })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function buildCharacterGroupSlot(rawBuffers, photoTypes, aspectRatio, charNames = [], options = {}) {
  const n = rawBuffers.length;
  if (n === 0 || n > 3) return null;

  // Per-page character name set → each card gets a colour frame (not a name
  // caption) so Grok can bind card↔character without leaking the name. Same
  // assignment as the prompt's "<colour> = <name>" mapping. frameColorForName
  // returns null on a single-character page (nothing to disambiguate), so the
  // card is left unframed and no coloured border leaks into the scene.
  const allCharNames = options.allCharNames || charNames;
  const colorFor = (i) => frameColorForName(charNames[i], allCharNames);

  // Extract face/body for each avatar-grid buffer; null for non-grid photos
  const parts = [];
  for (let i = 0; i < n; i++) {
    const photoType = photoTypes[i];
    const isGrid = photoType && (photoType.startsWith('styled-') || photoType.startsWith('costumed-') || photoType.startsWith('clothing-'));
    parts.push(isGrid ? await extractFaceAndBody(rawBuffers[i]) : null);
  }

  // Helper: vertical stack if grid, else raw buffer — then frame it in the
  // character's colour so Grok can bind card↔face.
  const buildVertical = async (i) => {
    const composed = parts[i] ? await composeFaceBodyVertical(parts[i].face, parts[i].body) : rawBuffers[i];
    return frameCharacterImage(composed, colorFor(i));
  };

  // Helper: horizontal strip if grid, else raw — framed the same way.
  const buildHorizontal = async (i) => {
    const composed = parts[i] ? await composeBodyFaceHorizontal(parts[i].face, parts[i].body) : rawBuffers[i];
    return frameCharacterImage(composed, colorFor(i));
  };

  let composed;
  if (n === 1) {
    // Frame (via colorFor) when the page has >1 character total — even if this
    // slot holds just one, a sibling slot's character needs the card↔face
    // binding to stay distinct. colorFor returns null on a single-character
    // page, so frameCharacterImage leaves the card unframed (no border leak).
    const single = parts[0]
      ? await composeBodyFaceHorizontal(parts[0].face, parts[0].body)
      : rawBuffers[0];
    composed = await frameCharacterImage(single, colorFor(0));
  } else if (n === 2) {
    const stacks = [await buildVertical(0), await buildVertical(1)];
    composed = await composeRow(stacks);
  } else {
    // n === 3: aspect-aware layout choice
    const [aspW, aspH] = String(aspectRatio || '1:1').split(':').map(Number);
    const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
    if (targetRatio >= 0.95) {
      // Square-ish target: 3 vertical stacks side by side
      const stacks = [await buildVertical(0), await buildVertical(1), await buildVertical(2)];
      composed = await composeRow(stacks);
    } else {
      // Portrait target: 2 vertical stacks on top, horizontal strip on bottom
      const topRow = await composeRow([await buildVertical(0), await buildVertical(1)]);
      const bottomRow = await buildHorizontal(2);
      composed = await composeStack(topRow, bottomRow);
    }
  }

  // Skip the aspect-pad when caller will append a VB row underneath — the VB
  // row changes the canvas height anyway, and pre-padding here would just
  // squeeze the character into the middle of two grey bars before the VB row
  // adds a third stripe at the bottom. packReferences's final aspect-pad
  // handles outer bars in either case.
  if (options.skipAspectPad) return composed;
  return padCharacterSlotToAspect(composed, aspectRatio);
}

/**
 * Extract the first 3 full-column strips from a 2×4 character sheet
 * (front-facing, 3/4, profile — skipping the back view at column 4).
 *
 * Each strip spans both rows: the head cell (top row) stacked above the
 * body cell (bottom row), same angle. Used for the trial slideshow so the
 * viewer sees face + body together rather than a faceless body.
 *
 * Aspect of the input sheet is roughly 2:1 (width:height) since 4 columns
 * × 2 rows of roughly square cells produces a 4:2 grid. If the input
 * doesn't look like a 2×4 sheet we return an empty array so callers can
 * fall back to the original image.
 */
async function extractBottomBody3Columns(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return [];
    // 2×4 sheets are landscape — width should be about 2× the height.
    const aspect = meta.width / meta.height;
    if (aspect < 1.6 || aspect > 2.4) return [];

    const w = meta.width;
    const h = meta.height;
    const colW = Math.floor(w / 4);
    const cells = [];
    for (let col = 0; col < 3; col++) {
      const left = col * colW;
      // Full column height — head + body, same angle. Previously took only
      // the bottom row which produced faceless body shots ("cropping off
      // the face" complaint).
      const cell = await sharp(buffer)
        .extract({ left, top: 0, width: colW, height: h })
        .jpeg({ quality: 88 })
        .toBuffer();
      cells.push(cell);
    }
    return cells;
  } catch (err) {
    log.warn(`⚠️ [GROK] extractBottomBody3Columns failed: ${err.message}`);
    return [];
  }
}

/**
 * Public helper retained for backwards compat: extract front views from a
 * 2×2 avatar grid and rearrange them as a horizontal [body|face] strip.
 * Non-grid images are returned unchanged.
 */
async function cropToFrontColumn(buffer) {
  try {
    const parts = await extractFaceAndBody(buffer);
    if (!parts) return buffer;
    const composed = await composeBodyFaceHorizontal(parts.face, parts.body);
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
    textAreaMask = null, // Pre-built black/white mask for empty scene text area
  } = refs;
  const { aspectRatio = '1:1', pageLabel = '', padInputWithExtension = false } = options;
  const tag = pageLabel ? `[GROK P${pageLabel}]` : '[GROK]';

  // Extract character photo buffers as raw data — the layout function decides
  // how to crop/compose based on character count and aspect ratio.
  // Accept any of: data: URI, raw base64, http(s) R2 URL, or wrapped objects
  // ({imageData}, {imageUrl}, [data, ...]). r2.bytesFromAnyImage handles the
  // string variants; we still drill through the object wrappers first.
  const rawCharData = [];
  for (const photoData of characterPhotos) {
    let photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
    const charName = typeof photoData === 'object' ? photoData?.name : null;
    if (photoUrl && typeof photoUrl === 'object') {
      if (Array.isArray(photoUrl)) {
        photoUrl = photoUrl[0];
      } else if (photoUrl.imageUrl) {
        photoUrl = photoUrl.imageUrl;
      } else if (photoUrl.data) {
        photoUrl = photoUrl.data;
      } else if (photoUrl.imageData) {
        photoUrl = photoUrl.imageData;
      }
    }
    if (photoUrl && typeof photoUrl === 'string') {
      const rawBuffer = await r2.bytesFromAnyImage(photoUrl);
      if (rawBuffer) {
        const photoType = typeof photoData === 'object' ? photoData?.photoType : null;
        rawCharData.push({ rawBuffer, photoType, charName });
      } else if (charName) {
        log.warn(`⚠️ ${tag} Skipped character "${charName}": failed to load photo bytes`);
      }
    } else if (charName) {
      log.warn(`⚠️ ${tag} Skipped character "${charName}": photoUrl is ${photoUrl ? typeof photoUrl : 'null/undefined'}`);
    }
  }

  // Extract landmark photo buffers. Accept BOTH `data:image/...;base64,XXXX`
  // and raw base64 — historical_locations rows store raw bytes without a
  // `data:` prefix, and the previous strict `startsWith('data:image')` check
  // silently dropped every curated landmark before it reached Grok. Result:
  // empty-scene plates were generated WITHOUT the landmark, so even though
  // packReferences correctly skips landmarks "already in scene background"
  // at the slot stage, that scene background never had the landmark baked in.
  // Accept landmark bytes from any source: photoUrl (R2 URL post-Phase-2),
  // photoData base64 (legacy + historical_locations rows), or raw base64.
  const landmarkBuffers = [];
  for (const lm of landmarkPhotos) {
    if (!lm) continue;
    // Try photoUrl first; if it can't be loaded (e.g. synthetic
    // magicalstory:// URLs from the tell-curated upload), fall back to
    // inline photoData.
    const candidates = [lm.photoUrl, lm.photoData].filter(s => typeof s === 'string' && s.length > 0);
    if (candidates.length === 0) continue;
    let buf = null;
    for (const source of candidates) {
      try {
        buf = await r2.bytesFromAnyImage(source);
        if (buf) break;
      } catch (err) {
        log.warn(`⚠️ ${tag} Landmark "${lm.name || 'unknown'}" load failed for "${String(source).slice(0, 40)}...": ${err.message}`);
      }
    }
    if (buf) landmarkBuffers.push(buf);
    else log.warn(`⚠️ ${tag} Skipped landmark "${lm.name || 'unknown'}": no bytes loaded from any source`);
  }

  // Count how many character slots we need (max 3 total reference slots for Grok)
  const charCount = rawCharData.length;
  const slots = [];

  // Decide whether to bake VB elements into the scene background as a border.
  // Border mode is ONLY used when 4+ characters need two character slots —
  // only then is there no free slot for a standalone VB grid. With 1-3
  // characters we have a free slot, so the scene stays clean and VB gets
  // its own slot at full size.
  const hasSceneBackground = sceneBackground && sceneBackground.startsWith('data:image');
  // Scene always goes in alone — clean style anchor. No VB, no mask, no border.
  // The mask confused Grok (it copied abstract black/white shapes into the output).
  // VB elements now ride in the same slot(s) as the character avatars instead.
  if (hasSceneBackground) {
    const base64 = r2.stripDataUriPrefix(sceneBackground);
    const buf = Buffer.from(base64, 'base64');
    const resized = await sharp(buf).resize({ height: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
    log.info(`🎨 ${tag} Slot ${slots.length}: scene background (clean, alone)`);
  }

  // Previous image goes FIRST — it's the scene being re-rendered (style transfer)
  // or the previous page for visual continuity (sequential mode)
  if (previousImage && previousImage.startsWith('data:image')) {
    const base64 = r2.stripDataUriPrefix(previousImage);
    const buf = Buffer.from(base64, 'base64');
    const resized = await sharp(buf).resize({ height: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
    log.info(`🎨 ${tag} Slot ${slots.length}: previous/source image`);
  }

  // Curated landmark photo from historical_locations becomes the SCENE ANCHOR
  // when no scene background was generated (empty-scene gen disabled). This
  // gives Grok the curated photo straight from the DB as slot 1, so the
  // character composites that follow get composited onto the right scenery.
  // When a scene background already exists, the landmark is assumed to be
  // baked into it (the empty-scene gen path uses the landmark as input) and
  // we skip — see the scene-bg slot above and the duplicate-skip log below.
  if (landmarkBuffers.length > 0 && !hasSceneBackground && slots.length < 3) {
    const resized = await sharp(landmarkBuffers[0])
      .resize({ height: 1024, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
    log.info(`🎨 ${tag} Slot ${slots.length}: landmark photo (DB scene anchor)`);
  }

  // Layout strategy (all char groups go through buildCharacterGroupSlot which
  // picks the best shape based on count and aspect ratio):
  //
  //   1 char:     [body | face] horizontal       (near square)
  //   2 chars:    2× [face/body] vertical stacks (near 3:4 portrait)
  //   3 chars 1:1: 3× vertical stacks side by side (near square)
  //   3 chars 3:4: 2 vertical stacks on top + 1 horizontal strip below
  //   4+ chars:   split at ceil(n/2), each group through the same function
  //
  // With 1–3 chars fitting in a single slot, we free up a slot compared to
  // the old "one char per slot" approach — so 2 chars can have VB grid AND
  // the char composite, and 3 chars get the same.
  //
  // Visual Bible elements: bundle them INTO the last character slot (as a row
  // of cells below the char composite) so the scene stays clean. Filter out
  // location elements since those are already painted in the scene background.
  // Location elements NEVER ride in the character-row VB strip — they should
  // be the standalone scene reference, either via the scene background slot
  // (when empty-scene gen is on) or via the landmark slot below. Bundling a
  // landmark into the character composite shrinks it to a tiny cell beside
  // the avatars and Grok treats it as another character prop instead of the
  // scene anchor. Previously the filter only ran when hasSceneBackground was
  // true, so disabling empty-scene gen routed the landmark into the character
  // slot. Now it's filtered unconditionally.
  const rawVbElements = (visualBibleGrid && Array.isArray(visualBibleGrid.rawElements))
    ? visualBibleGrid.rawElements.filter(e => e.type !== 'location')
    : [];

  // Pack character photos — ONE char per slot when space allows. Bundle only
  // when we'd exceed the 3-slot limit. The LAST char slot also absorbs any
  // VB elements as a cell row below the character.
  const pushCharSlot = async (group, includeVb) => {
    if (slots.length >= 3 || group.length === 0) return;
    const willAddVb = includeVb && rawVbElements.length > 0;
    const composed = await buildCharacterGroupSlot(
      group.map(c => c.rawBuffer),
      group.map(c => c.photoType),
      aspectRatio,
      group.map(c => c.charName),
      { skipAspectPad: willAddVb, allCharNames: rawCharData.map(c => c.charName) },
    );
    if (!composed) return;
    let slotBuf = composed;
    let vbCount = 0;
    if (willAddVb) {
      slotBuf = await composeCharWithVbRow(composed, rawVbElements, aspectRatio);
      vbCount = Math.min(rawVbElements.length, 6);
    }
    // quality 92 not 85: the input avatars were already encoded at 90, so a
    // second pass at 85 stacked visible artefacts on top. Matching the other
    // slots (and nudging a touch above the source) keeps the composite visually
    // close to the originals.
    const resized = await sharp(slotBuf).resize({ height: 1024, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
    const rm = await sharp(resized).metadata();
    const vbLabel = vbCount > 0 ? ` + ${vbCount} VB cell(s)` : '';
    slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
    log.info(`🎨 ${tag} Slot ${slots.length}: ${group.length} character${group.length > 1 ? 's' : ''}${vbLabel} composed (${rm.width}x${rm.height})`);
  };

  // Decide char grouping — one per slot when space allows.
  const availableCharSlots = 3 - slots.length;
  let charGroups = [];
  if (charCount > 0 && charCount <= availableCharSlots) {
    charGroups = rawCharData.map(c => [c]); // each in own slot
  } else if (charCount > 0 && availableCharSlots >= 2) {
    const per = Math.ceil(charCount / availableCharSlots);
    for (let i = 0; i < availableCharSlots; i++) {
      const start = i * per;
      if (start < charCount) charGroups.push(rawCharData.slice(start, Math.min(start + per, charCount)));
    }
  } else if (charCount > 0 && availableCharSlots === 1) {
    charGroups = [rawCharData]; // cram all into last slot
  }
  for (let i = 0; i < charGroups.length; i++) {
    await pushCharSlot(charGroups[i], i === charGroups.length - 1);
  }

  // Landmark already inserted above as a top-level scene anchor (slot 1 when
  // no scene background) — nothing more to do here. Log the skip in the
  // scene-background case for parity with the old debug trail.
  if (landmarkBuffers.length > 0 && hasSceneBackground) {
    log.debug(`🎨 ${tag} Skipping ${landmarkBuffers.length} landmark(s) — already in scene background`);
  }

  // Attach the text-area mask as a reference slot for empty-scene calls only.
  // For populated-page calls the scene plate already encodes the reserved zone,
  // and sending the mask there makes Grok copy the abstract shapes into the output.
  //
  // Mask convention: ~20% BLACK = reserved text zone, ~80% WHITE = rest of scene.
  // The full explanation rides in the text prompt — DO NOT composite a label
  // strip onto the mask, Grok bakes that strip's text verbatim into the output.
  if (textAreaMask && !hasSceneBackground && slots.length < 3) {
    try {
      const base64 = r2.stripDataUriPrefix(textAreaMask);
      const maskBuf = Buffer.from(base64, 'base64');
      const resized = await sharp(maskBuf)
        .resize({ height: 768, withoutEnlargement: true })
        .jpeg({ quality: 88 })
        .toBuffer();
      slots.push(`data:image/jpeg;base64,${resized.toString('base64')}`);
      log.info(`🎨 ${tag} Slot ${slots.length}: text-zone mask (no label)`);
    } catch (e) {
      log.warn(`⚠️ ${tag} Failed to attach text-zone mask: ${e.message}`);
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
    const base64 = r2.stripDataUriPrefix(slot);
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

    // Metadata invalid → force the slot into the target aspect with pad
    // (not crop). Same reasoning as the main pad path below: cropping risks
    // losing heads/feet on character cells; padding with the image's edge
    // colour is invisible on uniform backgrounds and at worst adds a small
    // bar on landmarks. Can't sample edge colour without metadata, so this
    // fallback uses plain white — acceptable since we only land here when
    // sharp couldn't even read the image dims (rare).
    if (!w || !h) {
      try {
        const fallbackRatio = targetRatio;
        const fw = Math.round(FALLBACK_SIZE * (fallbackRatio >= 1 ? 1 : fallbackRatio));
        const fh = Math.round(FALLBACK_SIZE / (fallbackRatio >= 1 ? fallbackRatio : 1));
        const padded = await sharp(buf)
          .resize(fw, fh, { fit: 'contain', position: 'centre', background: { r: 255, g: 255, b: 255 } })
          .jpeg({ quality: 90 })
          .toBuffer();
        paddedSlots.push(`data:image/jpeg;base64,${padded.toString('base64')}`);
        log.debug(`🎨 ${tag} Slot ${i + 1}: fallback padded to ${fw}x${fh}`);
      } catch (fallbackErr) {
        log.error(`❌ [GROK] Slot ${i + 1}: fallback resize failed (${fallbackErr.message}) — dropping slot`);
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

    // Scene-plate slot 0 with extension requested: leave it at native aspect so
    // editWithGrok magenta-pads + extends it (paints scene continuation into the
    // gap). Pillarboxing it here with sampled edge colours bakes flat grey bars
    // into the plate that survive the edit into the empty scene and every page
    // built on it. Only slot 0 is the scene plate; later slots keep padding.
    if (padInputWithExtension && i === 0) {
      paddedSlots.push(slot);
      log.debug(`🎨 ${tag} Slot 1: native ${w}x${h} kept for editWithGrok magenta-extension`);
      continue;
    }

    // Pad to target aspect — do NOT crop. Cropping was the previous behaviour
    // (fit: 'cover') and chopped heads / feet off character cell refs when
    // the cell aspect didn't match the target. Real-world failure: Daniel
    // page 1 V3 lost his head because the head sat near the top of the cell
    // and the centre-crop trimmed it. The original concern about "white bars
    // surviving into the output" only applies to bars that look distinct
    // against the image — when we sample the image's own edge colour and pad
    // with that, the bars blend with the existing background (character
    // cells have a uniform light background already, so the pad becomes
    // invisible). For landmark photos with varied edges, a small bar is
    // strictly better than losing landmark detail.
    //
    // Compute target dims: expand the SHORTER dimension instead of trimming
    // the longer one. Source aspect-ratio is preserved by sharp's `contain`
    // fit.
    let targetW, targetH;
    if (currentRatio > targetRatio) {
      // Source wider than target → keep width, grow height with padding
      targetW = w;
      targetH = Math.round(w / targetRatio);
    } else {
      // Source taller than target → keep height, grow width with padding
      targetH = h;
      targetW = Math.round(h * targetRatio);
    }

    // Sample edge colours PER SIDE so each pad bar blends with the part of
    // the image it's adjacent to. Previously we sampled only the TOP edge and
    // used that colour for ALL bars → user-portrait photos with sky at top
    // produced sky-blue bars on the BOTTOM of letterboxed refs (observed on
    // prod job_1780263997444 initial page). Per-side: top bar = sampled top
    // edge, bottom bar = sampled bottom edge, left/right same.
    const sampleSide = async (side) => {
      try {
        const band = Math.max(2, Math.round(Math.min(w, h) * 0.01));
        let region;
        if (side === 'top')    region = { left: 0,        top: 0,        width: w,    height: band };
        if (side === 'bottom') region = { left: 0,        top: h - band, width: w,    height: band };
        if (side === 'left')   region = { left: 0,        top: 0,        width: band, height: h    };
        if (side === 'right')  region = { left: w - band, top: 0,        width: band, height: h    };
        const { data: px } = await sharp(buf).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let sR = 0, sG = 0, sB = 0, n = 0;
        for (let p = 0; p < px.length; p += 3) { sR += px[p]; sG += px[p + 1]; sB += px[p + 2]; n++; }
        return n > 0
          ? { r: Math.round(sR / n), g: Math.round(sG / n), b: Math.round(sB / n) }
          : { r: 255, g: 255, b: 255 };
      } catch { return { r: 255, g: 255, b: 255 }; }
    };
    try {
      const isLetterbox = currentRatio > targetRatio;  // wider source → top+bottom bars
      let padded;
      if (isLetterbox) {
        const totalPad = targetH - h;
        const topBarH = Math.floor(totalPad / 2);
        const bottomBarH = totalPad - topBarH;
        const [topC, bottomC] = await Promise.all([sampleSide('top'), sampleSide('bottom')]);
        const composites = [{ input: buf, left: 0, top: topBarH }];
        if (topBarH > 0) composites.unshift({ input: { create: { width: targetW, height: topBarH, channels: 3, background: topC }}, left: 0, top: 0 });
        if (bottomBarH > 0) composites.push({ input: { create: { width: targetW, height: bottomBarH, channels: 3, background: bottomC }}, left: 0, top: targetH - bottomBarH });
        padded = await sharp({ create: { width: targetW, height: targetH, channels: 3, background: { r: 255, g: 255, b: 255 }}}).composite(composites).jpeg({ quality: 90 }).toBuffer();
        log.debug(`🎨 ${tag} Slot ${i + 1}: letterbox ${w}x${h} → ${targetW}x${targetH} (top rgb(${topC.r},${topC.g},${topC.b}), bottom rgb(${bottomC.r},${bottomC.g},${bottomC.b}))`);
      } else {
        const totalPad = targetW - w;
        const leftBarW = Math.floor(totalPad / 2);
        const rightBarW = totalPad - leftBarW;
        const [leftC, rightC] = await Promise.all([sampleSide('left'), sampleSide('right')]);
        const composites = [{ input: buf, left: leftBarW, top: 0 }];
        if (leftBarW > 0) composites.unshift({ input: { create: { width: leftBarW, height: targetH, channels: 3, background: leftC }}, left: 0, top: 0 });
        if (rightBarW > 0) composites.push({ input: { create: { width: rightBarW, height: targetH, channels: 3, background: rightC }}, left: targetW - rightBarW, top: 0 });
        padded = await sharp({ create: { width: targetW, height: targetH, channels: 3, background: { r: 255, g: 255, b: 255 }}}).composite(composites).jpeg({ quality: 90 }).toBuffer();
        log.debug(`🎨 ${tag} Slot ${i + 1}: pillarbox ${w}x${h} → ${targetW}x${targetH} (left rgb(${leftC.r},${leftC.g},${leftC.b}), right rgb(${rightC.r},${rightC.g},${rightC.b}))`);
      }
      paddedSlots.push(`data:image/jpeg;base64,${padded.toString('base64')}`);
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
/**
 * Append a row of VB element cells below a character composite.
 * Keeps the char composite at natural size and adds 1-6 labeled cells as a
 * bottom strip, so VB references travel with the avatars rather than polluting
 * the scene background.
 */
async function composeCharWithVbRow(charBuffer, vbElements = [], aspectRatio = '1:1') {
  const elements = vbElements.slice(0, 6);
  if (elements.length === 0) return charBuffer;

  const meta = await sharp(charBuffer).metadata();
  const W = meta.width;
  const charHOrig = meta.height;

  // Layout: keep the character at its natural size and append a VB cell row
  // directly underneath. No internal padding — the final aspect-pad step in
  // packReferences adds any outer bars needed. VB cell size is driven by the
  // canvas WIDTH so cells stay large regardless of target aspect.
  const cellW = Math.floor(W / elements.length);
  const cellH = Math.min(cellW, Math.round(W * 0.32));
  const finalH = charHOrig + cellH;

  const composites = [{ input: charBuffer, left: 0, top: 0 }];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!el.imageData) continue;
    try {
      const base64 = r2.stripDataUriPrefix(el.imageData);
      const elBuf = Buffer.from(base64, 'base64');
      const cell = await sharp(elBuf)
        .resize(cellW, cellH, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
        .toBuffer();
      const cellLeft = i * cellW;
      composites.push({ input: cell, left: cellLeft, top: charHOrig });

      // VB cell labels intentionally dropped — Grok knows what a bench /
      // coin / sundial / bridge looks like; the caption only ever serves to
      // leak into the rendered scene (e.g. "Holzbank am Stadtturm" baked
      // into page 7 V2 of job_1780564110486_g4gn4vzvu). Same policy as
      // buildVisualBibleGrid's labelMode='all' default (commit ac4ee3bc).
      // Character cells above carry a coloured FRAME (frameCharacterImage)
      // for card↔face binding — a frame doesn't leak the way a name caption did.
    } catch (err) {
      log.warn(`⚠️ [GROK] composeCharWithVbRow: failed cell ${i} (${el.name}): ${err.message}`);
    }
  }

  log.debug(`🎨 [GROK] char+VB: ${W}x${finalH} (char ${W}x${charHOrig} + VB row ${elements.length} cells @ ${cellW}x${cellH}), target ${aspectRatio}`);
  return sharp({ create: { width: W, height: finalH, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function composeSceneWithVbBorder(sceneBuffer, vbElements = [], options = {}) {
  const SCENE = 1024;
  const CELL_W = 256;          // right-column cell width (and right-column cell height stays 256)
  const RIGHT_COL_X = SCENE;
  const CANVAS_W = SCENE + CELL_W;  // 1280: scene + right column

  // For 1:1 target the bottom row cells stay 256×256 → canvas 1280×1280.
  // For non-1:1 targets we GROW the bottom-row HEIGHT so the canvas hits the
  // exact requested aspect. The packReferences aspect-pad loop is then a no-op
  // and no VB cells get cropped off the side.
  //
  //   Canvas = 1280 wide × (1024 + bottomH) tall
  //   bottomH = 1280 / targetRatio - 1024
  //
  // For 3:4 (0.75) → bottomH = 683 → canvas 1280×1707, bottom cells 256×683.
  // For 1:1 → bottomH = 256 → canvas 1280×1280 (preserved).
  const { aspectRatio = '1:1' } = options;
  const [aspW, aspH] = String(aspectRatio).split(':').map(Number);
  const targetRatio = (aspW > 0 && aspH > 0) ? aspW / aspH : 1;
  const naturalCanvasH = SCENE + CELL_W;             // 1280 (1:1 default)
  const aspectCanvasH = Math.round(CANVAS_W / targetRatio);
  const CANVAS_H = Math.max(naturalCanvasH, aspectCanvasH);
  const BOTTOM_H = CANVAS_H - SCENE;                  // height of the bottom-row cells
  const MAX_ELEMENTS = 9;

  // Resize scene to exactly 1024x1024. Cover-crop instead of contain+black —
  // black letterbox bars on the scene input survive through Grok's editing and
  // end up baked into every output (stacked with the outer white bars from the
  // editWithGrok input padder when that was still using contain). Cropping
  // loses a thin edge slice on one axis but keeps the illustration edge-to-edge.
  const sceneResized = await sharp(sceneBuffer)
    .resize(SCENE, SCENE, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Cell positions: 4 right column (256×256 squares), 5 bottom row
  // (256×BOTTOM_H — taller than wide for portrait targets, square for 1:1).
  const cellPositions = [
    // Right column (x = 1024, y = 0/256/512/768)
    { left: RIGHT_COL_X, top: 0,           w: CELL_W, h: CELL_W },
    { left: RIGHT_COL_X, top: CELL_W,      w: CELL_W, h: CELL_W },
    { left: RIGHT_COL_X, top: CELL_W * 2,  w: CELL_W, h: CELL_W },
    { left: RIGHT_COL_X, top: CELL_W * 3,  w: CELL_W, h: CELL_W },
    // Bottom row (y = 1024, x = 0/256/512/768/1024) — fills full 1280 width.
    // Height = BOTTOM_H so the canvas hits the requested aspect.
    { left: 0,           top: SCENE,       w: CELL_W, h: BOTTOM_H },
    { left: CELL_W,      top: SCENE,       w: CELL_W, h: BOTTOM_H },
    { left: CELL_W * 2,  top: SCENE,       w: CELL_W, h: BOTTOM_H },
    { left: CELL_W * 3,  top: SCENE,       w: CELL_W, h: BOTTOM_H },
    { left: CELL_W * 4,  top: SCENE,       w: CELL_W, h: BOTTOM_H },
  ];

  const elements = vbElements.slice(0, MAX_ELEMENTS);
  const composites = [{ input: sceneResized, left: 0, top: 0 }];

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const pos = cellPositions[i];
    if (!el.imageData) continue;

    try {
      const base64 = r2.stripDataUriPrefix(el.imageData);
      const elBuf = Buffer.from(base64, 'base64');

      // Fill the cell with the element image (cover crops to fit, maximizes visibility)
      const cellImage = await sharp(elBuf)
        .resize(pos.w, pos.h, { fit: 'cover' })
        .toBuffer();
      composites.push({ input: cellImage, left: pos.left, top: pos.top });

      // Caption strip overlay at the bottom of the cell (~14% of cell height,
      // min 36px). Stays anchored to the cell bottom regardless of cell height.
      const labelText = `${el.name} (${el.type})`;
      const displayText = labelText.length > 28 ? labelText.substring(0, 25) + '...' : labelText;
      const safeText = displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const captionHeight = Math.max(36, Math.round(pos.h * 0.14));
      const fontSize = Math.max(18, Math.round(captionHeight * 0.5));
      const captionSvg = `
        <svg width="${pos.w}" height="${captionHeight}">
          <rect width="${pos.w}" height="${captionHeight}" fill="black" fill-opacity="0.65"/>
          <text x="${pos.w / 2}" y="${Math.round(captionHeight * 0.7)}" font-family="Arial, sans-serif" font-size="${fontSize}"
                font-weight="bold" fill="white" text-anchor="middle">${safeText}</text>
        </svg>
      `;
      composites.push({
        input: Buffer.from(captionSvg),
        left: pos.left,
        top: pos.top + pos.h - captionHeight,
      });
    } catch (err) {
      log.warn(`⚠️ [GROK] composeSceneWithVbBorder: failed to render cell ${i} (${el.name}): ${err.message}`);
    }
  }

  const out = await sharp({
    create: {
      width: CANVAS_W,
      height: CANVAS_H,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 90 })
    .toBuffer();

  log.info(`🖼️ [GROK] Composed scene+VB border: ${CANVAS_W}x${CANVAS_H}, scene=${SCENE}px, ${elements.length} VB cells (right ${CELL_W}×${CELL_W}, bottom ${CELL_W}×${BOTTOM_H})`);
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
  extractBottomBody3Columns,
  buildCharacterGroupSlot,
  frameCharacterImage,
  GROK_MODELS,
};
