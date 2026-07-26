/**
 * Gemini Aspect-Ratio Padding Helpers (shared)
 *
 * Single source of truth for padding an image to a Gemini-supported aspect
 * ratio before an edit/repair call, and removing that padding afterwards.
 *
 * This module was extracted from TWO previously-duplicated implementations
 * (server/lib/repairGrid.js and server/lib/entityConsistency.js) that had
 * DIFFERENT behavior. It is a pure, behavior-preserving deduplication: every
 * difference between the two callers is expressed as an explicit option so
 * neither caller's visual output changes.
 *
 * The differences that are parameterized:
 *   - Pad fill:        repairGrid pads with SOLID white/black; entityConsistency
 *                      pads with MIRROR edge-extension.  → `padMode`
 *   - Ratio table:     the two callers select the "closest" ratio against
 *                      DIFFERENT numeric values (see below).  → `ratios`
 *   - Output encoding: repairGrid re-encodes to JPEG q95; entityConsistency
 *                      keeps the raw (input-format) buffer.  → `encode`
 *   - removePadding crop math: repairGrid crops the scaled padding off each
 *                      side ('crop-remainder'); entityConsistency extracts the
 *                      scaled original region ('extract-original').  → `strategy`
 *   - Logging:         repairGrid logs a `[GRID]` line; entityConsistency is
 *                      silent.  → `logPrefix`
 *
 * NOTE ON THE TWO RATIO TABLES — they are NOT identical:
 *   GEMINI_RATIOS_EXACT  uses the pure mathematical ratios (3:4 = 0.750,
 *                        4:3 = 1.333, 16:9 = 1.778, 9:16 = 0.5625).
 *   GEMINI_RATIOS_PIXELS uses the ratios implied by Gemini's actual output
 *                        pixel dims (3:4 = 896/1120 = 0.800, 4:3 = 1120/896 =
 *                        1.250, 16:9 = 1360/768 = 1.771, 9:16 = 768/1360 =
 *                        0.5647).
 * They cover the same five NAMES but different VALUES, which changes both the
 * "closest ratio" selection and the padded dimensions. Merging them into one
 * set of numbers would alter output, so both tables are preserved and each
 * caller passes its own via `ratios`.
 */

const sharp = require('sharp');

// Pure-math aspect ratios (used by repairGrid — the default).
const GEMINI_RATIOS_EXACT = [
  { name: '1:1', ratio: 1.0 },
  { name: '4:3', ratio: 4 / 3 },   // 1.333 - landscape
  { name: '3:4', ratio: 3 / 4 },   // 0.75  - portrait
  { name: '16:9', ratio: 16 / 9 }, // 1.778 - wide
  { name: '9:16', ratio: 9 / 16 }, // 0.5625 - tall
];

// Ratios derived from Gemini's actual output pixel dimensions (used by
// entityConsistency). Same names as EXACT but slightly different values.
const GEMINI_RATIOS_PIXELS = [
  { name: '1:1', ratio: 1024 / 1024 },
  { name: '3:4', ratio: 896 / 1120 },
  { name: '4:3', ratio: 1120 / 896 },
  { name: '9:16', ratio: 768 / 1360 },
  { name: '16:9', ratio: 1360 / 768 },
];

/**
 * Find the closest Gemini-supported aspect ratio and the padded dimensions
 * needed to reach it (padding is always additive — the original never shrinks).
 *
 * @param {number} width  - Image width
 * @param {number} height - Image height
 * @param {Array<{name:string, ratio:number}>} ratios - Candidate ratio table
 * @returns {{name:string, ratio:number, paddedWidth:number, paddedHeight:number}}
 */
function findClosestGeminiRatio(width, height, ratios = GEMINI_RATIOS_EXACT) {
  const currentRatio = width / height;

  let best = null;
  let bestDiff = Infinity;

  for (const r of ratios) {
    const diff = Math.abs(currentRatio - r.ratio);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }

  // Calculate padded dimensions to match the target ratio
  let paddedWidth, paddedHeight;
  if (currentRatio > best.ratio) {
    // Image is wider than target - pad height
    paddedWidth = width;
    paddedHeight = Math.round(width / best.ratio);
  } else {
    // Image is taller than target - pad width
    paddedHeight = height;
    paddedWidth = Math.round(height * best.ratio);
  }

  return {
    name: best.name,
    ratio: best.ratio,
    paddedWidth,
    paddedHeight,
  };
}

/**
 * Pad an image to a Gemini-supported aspect ratio.
 *
 * @param {Buffer} imageBuffer - Original image buffer
 * @param {object} [opts]
 * @param {number} [opts.width]  - Explicit source width (skips metadata read)
 * @param {number} [opts.height] - Explicit source height (skips metadata read)
 * @param {Array}  [opts.ratios=GEMINI_RATIOS_EXACT] - Candidate ratio table
 * @param {'solid'|'mirror'} [opts.padMode='mirror'] - Fill for the padded area
 * @param {'white'|'black'} [opts.padColor='white']  - Solid fill color (padMode='solid')
 * @param {'jpeg'|null} [opts.encode=null] - 'jpeg' re-encodes at q95; null keeps raw/input format
 * @param {string|null} [opts.logPrefix=null] - If set, logs a padding line with this prefix
 * @param {boolean} [opts.skipWhenNoPad=false] - Return original buffer untouched when no padding needed
 * @returns {Promise<{buffer:Buffer, padding:object, targetRatio:object, paddingInfo:object}>}
 *   Return object carries BOTH shapes: `padding`/`targetRatio` (repairGrid) and
 *   `paddingInfo` (entityConsistency), so either caller can destructure what it needs.
 */
async function padToGeminiRatio(imageBuffer, opts = {}) {
  const {
    ratios = GEMINI_RATIOS_EXACT,
    padMode = 'mirror',
    padColor = 'white',
    encode = null,
    logPrefix = null,
    skipWhenNoPad = false,
  } = opts;

  let width = opts.width;
  let height = opts.height;
  if (width == null || height == null) {
    const meta = await sharp(imageBuffer).metadata();
    width = meta.width;
    height = meta.height;
  }

  const target = findClosestGeminiRatio(width, height, ratios);

  // Additive, centered padding. Math.max(0, …) is a guard — padded dims are
  // always >= source dims by construction, so it is a no-op in practice.
  const padX = Math.max(0, target.paddedWidth - width);
  const padY = Math.max(0, target.paddedHeight - height);
  const padLeft = Math.floor(padX / 2);
  const padRight = padX - padLeft;
  const padTop = Math.floor(padY / 2);
  const padBottom = padY - padTop;

  const padding = { top: padTop, left: padLeft, bottom: padBottom, right: padRight };
  const paddingInfo = {
    padTop,
    padBottom,
    padLeft,
    padRight,
    originalWidth: width,
    originalHeight: height,
    paddedWidth: target.paddedWidth,
    paddedHeight: target.paddedHeight,
    aspectRatio: target.name,
  };

  // No padding needed — return the original untouched (used by repairGrid).
  if (skipWhenNoPad && padX === 0 && padY === 0) {
    return { buffer: imageBuffer, padding, targetRatio: target, paddingInfo };
  }

  const extendOpts = { top: padTop, bottom: padBottom, left: padLeft, right: padRight };
  if (padMode === 'solid') {
    extendOpts.background = padColor === 'black'
      ? { r: 0, g: 0, b: 0, alpha: 1 }
      : { r: 255, g: 255, b: 255, alpha: 1 };
  } else {
    extendOpts.extendWith = 'mirror'; // Mirror edges for more natural blending
  }

  let pipeline = sharp(imageBuffer).extend(extendOpts);
  if (encode === 'jpeg') pipeline = pipeline.jpeg({ quality: 95 });
  const paddedBuffer = await pipeline.toBuffer();

  if (logPrefix) {
    console.log(`  ${logPrefix} Padded ${width}x${height} → ${target.paddedWidth}x${target.paddedHeight} (${target.name}, +${padLeft}/${padRight}/${padTop}/${padBottom})`);
  }

  return { buffer: paddedBuffer, padding, targetRatio: target, paddingInfo };
}

/**
 * Remove padding from a padded (and possibly Gemini-resized) image.
 *
 * @param {Buffer} imageBuffer - Padded image buffer
 * @param {object} paddingInfo - {padLeft, padTop, padRight, padBottom, paddedWidth, paddedHeight, originalWidth, originalHeight}
 * @param {object} [opts]
 * @param {'extract-original'|'crop-remainder'} [opts.strategy='extract-original']
 *   - 'extract-original' (entityConsistency): extract the scaled original region from (left, top).
 *   - 'crop-remainder'   (repairGrid): crop the scaled padding off every side.
 *   The two differ by ±1px rounding, so each caller keeps its own strategy.
 * @param {'jpeg'|null} [opts.encode=null] - 'jpeg' re-encodes at q95; null keeps raw/input format
 * @param {string|null} [opts.logPrefix=null] - If set, logs on removal / invalid crop
 * @returns {Promise<Buffer>}
 */
async function removePadding(imageBuffer, paddingInfo, opts = {}) {
  const {
    strategy = 'extract-original',
    encode = null,
    logPrefix = null,
  } = opts;

  const meta = await sharp(imageBuffer).metadata();

  // Scale factor is identical for both strategies: the output may have been
  // resized by Gemini relative to the padded input.
  const scaleX = meta.width / paddingInfo.paddedWidth;
  const scaleY = meta.height / paddingInfo.paddedHeight;

  if (strategy === 'crop-remainder') {
    const scaledPadding = {
      left: Math.round(paddingInfo.padLeft * scaleX),
      top: Math.round(paddingInfo.padTop * scaleY),
      right: Math.round(paddingInfo.padRight * scaleX),
      bottom: Math.round(paddingInfo.padBottom * scaleY),
    };

    const cropWidth = meta.width - scaledPadding.left - scaledPadding.right;
    const cropHeight = meta.height - scaledPadding.top - scaledPadding.bottom;

    if (cropWidth <= 0 || cropHeight <= 0) {
      if (logPrefix) console.warn(`  ${logPrefix} Invalid crop dimensions after padding removal: ${cropWidth}x${cropHeight}`);
      return imageBuffer;
    }

    let pipeline = sharp(imageBuffer).extract({
      left: scaledPadding.left,
      top: scaledPadding.top,
      width: cropWidth,
      height: cropHeight,
    });
    if (encode === 'jpeg') pipeline = pipeline.jpeg({ quality: 95 });
    const croppedBuffer = await pipeline.toBuffer();

    if (logPrefix) console.log(`  ${logPrefix} Removed padding: ${meta.width}x${meta.height} → ${cropWidth}x${cropHeight}`);

    return croppedBuffer;
  }

  // 'extract-original'
  const left = Math.round(paddingInfo.padLeft * scaleX);
  const top = Math.round(paddingInfo.padTop * scaleY);
  const extractWidth = Math.round(paddingInfo.originalWidth * scaleX);
  const extractHeight = Math.round(paddingInfo.originalHeight * scaleY);

  let pipeline = sharp(imageBuffer).extract({
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.min(extractWidth, meta.width - left),
    height: Math.min(extractHeight, meta.height - top),
  });
  if (encode === 'jpeg') pipeline = pipeline.jpeg({ quality: 95 });
  return pipeline.toBuffer();
}

module.exports = {
  GEMINI_RATIOS_EXACT,
  GEMINI_RATIOS_PIXELS,
  findClosestGeminiRatio,
  padToGeminiRatio,
  removePadding,
};
