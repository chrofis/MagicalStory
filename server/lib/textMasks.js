/**
 * Text area mask loader — pre-built PNGs from assets/masks/
 *
 * Masks are generated once by scripts/build-text-masks.js and loaded into memory
 * at module import. Each mask is a white-background PNG with a black (blurred)
 * region marking the reserved text zone (~20% of the frame; white story text
 * overlays on top). The model is told (via the prompt) to treat the black region
 * as a POSITION guide only: render that area as a natural, saturated, high-
 * contrast surface (deep sky, dark foliage, rich wall) — NOT as a literal black
 * box, panel, or frame. Calmness matters more than colour.
 */

const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logger');

const MASKS_DIR = path.join(__dirname, '..', '..', 'assets', 'masks');

// In-memory cache of loaded masks
const masks = {};

function loadMasks() {
  if (!fs.existsSync(MASKS_DIR)) {
    log.warn(`⚠️ [TEXT-MASKS] Directory not found: ${MASKS_DIR} — run scripts/build-text-masks.js`);
    return;
  }
  const files = fs.readdirSync(MASKS_DIR).filter(f => f.startsWith('text-mask-') && f.endsWith('.png'));
  for (const file of files) {
    const key = file.replace(/^text-mask-/, '').replace(/\.png$/, ''); // e.g. "top-right-medium"
    const buf = fs.readFileSync(path.join(MASKS_DIR, file));
    masks[key] = `data:image/png;base64,${buf.toString('base64')}`;
  }
  log.info(`✅ [TEXT-MASKS] Loaded ${Object.keys(masks).length} pre-built text area masks`);
}

loadMasks();

/**
 * Get a text area mask by position and reading level.
 * @param {string} textPosition - e.g. 'top-right', 'bottom-full'
 * @param {string} langLevel - '1st-grade' | 'standard' | 'advanced'
 * @returns {string|null} - base64 data URI of the mask PNG, or null if not found
 */
function getTextAreaMask(textPosition, langLevel = 'standard') {
  if (!textPosition) return null;
  const sizeName = langLevel === '1st-grade' ? 'small'
    : langLevel === 'advanced' ? 'large'
    : 'medium';
  const key = `${textPosition}-${sizeName}`;
  const mask = masks[key];
  if (!mask) {
    log.warn(`⚠️ [TEXT-MASKS] No mask for "${key}" — falling back to null`);
    return null;
  }
  return mask;
}

const SIZE_FRACTION = { small: 0.10, medium: 0.25, large: 0.40 };

/**
 * Analytical outer border of the mask's black region in image pixel coords.
 * Replaces the calm-region detector: we designed this shape in
 * scripts/build-text-masks.js and asked the image model to respect it —
 * there's no reason to hunt for it afterwards in the generated pixels.
 *
 *   top-full    → rectangle across the top N% of the frame
 *   bottom-full → rectangle across the bottom N%
 *   corners     → right triangle hugging the corner, matching SIZE area
 *
 * Returns a polygon as an array of [x, y] vertices in image pixel space.
 *
 * @param {string} textPosition - 'top-left' | 'top-right' | 'top-full' | 'bottom-left' | 'bottom-right' | 'bottom-full'
 * @param {string} langLevel - '1st-grade' | 'standard' | 'advanced'
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {number[][]|null} polygon vertices, or null if textPosition is unknown
 */
function getTextZonePolygon(textPosition, langLevel, width, height) {
  if (!textPosition) return null;
  const sizeName = langLevel === '1st-grade' ? 'small'
    : langLevel === 'advanced' ? 'large'
    : 'medium';
  const areaPct = SIZE_FRACTION[sizeName] ?? SIZE_FRACTION.medium;

  const isFull = textPosition.includes('full');
  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left');

  if (isFull) {
    const rectH = Math.round(height * areaPct);
    const y = isTop ? 0 : height - rectH;
    return [[0, y], [width, y], [width, y + rectH], [0, y + rectH]];
  }

  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(textPosition)) return null;

  // Right-triangle with the right angle at the corner of the frame and the
  // hypotenuse pointing into the scene. Area = 0.5 × legW × legH; legs
  // scaled by sqrt(2 * areaPct) so the total area matches the rectangular
  // size at the same SIZE_FRACTION.
  //
  // The horizontal leg gets an extra 0.75× factor so the triangle occupies
  // less of the image's width. Without it the bottom corner vertex sat at
  // ~29% of image width — too far into the scene. 0.75× moves it out to
  // ~47%, matching the "text hugs the outer corner" design intent and
  // leaving a clear swath of image uncluttered by text.
  const scale = Math.sqrt(2 * areaPct);
  const CORNER_WIDTH_FACTOR = 0.75;
  const legW = Math.round(width * scale * CORNER_WIDTH_FACTOR);
  const legH = Math.round(height * scale);
  const cx = isLeft ? 0 : width;
  const cy = isTop ? 0 : height;
  const ax = isLeft ? legW : width - legW;
  const ay = cy;
  const bx = cx;
  const by = isTop ? legH : height - legH;
  return [[cx, cy], [ax, ay], [bx, by]];
}

/** Polygon area in px² (Shoelace, absolute). */
function polygonArea(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  let s = 0;
  for (let i = 0, n = polygon.length; i < n; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Map a pipeline languageLevel to the polygon's size bucket name. */
function sizeNameFor(languageLevel) {
  return languageLevel === '1st-grade' ? 'small'
    : languageLevel === 'advanced' ? 'large'
    : 'medium';
}

module.exports = { getTextAreaMask, getTextZonePolygon, polygonArea, sizeNameFor };
