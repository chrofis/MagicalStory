/**
 * Text region detection (calmness + coverage).
 *
 * Detects the calmest (low-variance) region of a generated image so the text
 * space repair loop can decide whether to re-roll and the overlay renderer
 * knows where text will land. The image is NOT modified here — any frosted
 * blur / outline / backdrop is applied at text-render time, not baked into
 * storage.
 *
 * Algorithm:
 * 1. Convert to greyscale, divide into blocks, compute brightness + variance
 * 2. Calmness = (1 - variance) × (1 - brightness) weighting — we prefer dark,
 *    smooth regions because text renders as white glyphs on a dark backdrop.
 *    Edge density and variance dominate; brightness just tilts ties toward dark.
 * 3. Build a per-pixel alpha mask from calmness (used only for bbox + score)
 * 4. Constrain to the correct side (odd=left, even=right) + target area
 * 5. Return the original image unchanged + position + rect + coverage score
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { stripDataUriPrefix } = require('./r2');

const BLOCK_SIZE = 16;

/**
 * Per-block calmness of a greyscale image (steps 1-2 of the algorithm above), the ONE copy of
 * the variance/brightness formula: used by detectAndLightenTextRegion and chooseStripEdge.
 *
 * @param {Buffer} grayPixels - raw 1-channel pixels, row-major
 * @param {number} width - image width in px
 * @param {number} rows - Math.floor(height / BLOCK_SIZE)
 * @param {number} cols - Math.floor(width / BLOCK_SIZE)
 * @returns {Float32Array} rows*cols calmness values (0..1, higher = calmer)
 */
function blockCalmness(grayPixels, width, rows, cols) {
  const calmness = new Float32Array(rows * cols);
  let vMax = 0;
  const variances = new Float32Array(rows * cols);
  const means = new Float32Array(rows * cols);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, sumSq = 0;
      const count = BLOCK_SIZE * BLOCK_SIZE;
      for (let by = 0; by < BLOCK_SIZE; by++) {
        const rowOff = (r * BLOCK_SIZE + by) * width;
        for (let bx = 0; bx < BLOCK_SIZE; bx++) {
          const val = grayPixels[rowOff + c * BLOCK_SIZE + bx];
          sum += val;
          sumSq += val * val;
        }
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
      means[r * cols + c] = mean;
      variances[r * cols + c] = std;
      if (std > vMax) vMax = std;
    }
  }
  if (vMax === 0) vMax = 1;

  for (let i = 0; i < calmness.length; i++) {
    // Low-variance wins — the primary signal for "is this spot clean?" —
    // but dark is preferred when variance is tied, since text renders as
    // white glyphs on a dark gradient. A bright calm patch still scores,
    // but a dark calm patch scores higher.
    const vNorm = variances[i] / vMax;
    const bNorm = means[i] / 255;
    calmness[i] = (1 - vNorm) * (0.7 + 0.3 * (1 - bNorm));
  }
  return calmness;
}

// Blocks at or above this calmness count as calm (text-region wash and the strip-edge seam rule).
const TEXT_CALM_THRESHOLD = 0.35;

// Printed text strip: the text goes on the top or bottom edge of the picture
// (decisions.md, "Text strip on the calmer edge of the picture", 2026-10-27).
const STRIP_BAND_MIN = 0.15;
const STRIP_BAND_MAX = 0.5;
const STRIP_TIE_GAP = 0.05;
const STRIP_SEAM_SHARE = 0.05;   // outermost share of the picture that gets mirrored / stretched into the strip

/**
 * Which edge of the picture should get the text strip. An edge is ELIGIBLE only when its outermost
 * STRIP_SEAM_SHARE band (the rows the fill is built from) is calm: every block in it at or above
 * TEXT_CALM_THRESHOLD, so a mast, treetop or head that touches the edge disqualifies it. Of two
 * eligible edges the calmer outer band (mean block calmness over `bandFraction` of the picture) wins
 * when it leads by STRIP_TIE_GAP; ties and "neither eligible" go to the bottom. A pure function of the
 * pixels (deterministic per story, nothing is stored).
 *
 * @param {Buffer} imageBuffer - the scene picture (any format sharp reads)
 * @param {Object} [opts]
 * @param {number} [opts.bandFraction=0.25] - band height as a share of the picture height; the
 *   caller passes (pageHeight - imageHeight) / imageHeight; clamped to [0.15, 0.5]
 * @returns {Promise<{edge:'top'|'bottom', top:number, bottom:number, topEligible:boolean, bottomEligible:boolean}>}
 */
async function chooseStripEdge(imageBuffer, { bandFraction = 0.25 } = {}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('chooseStripEdge: imageBuffer missing');
  const { data: gray, info } = await sharp(imageBuffer).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rows = Math.floor(info.height / BLOCK_SIZE);
  const cols = Math.floor(info.width / BLOCK_SIZE);
  if (rows < 4 || cols < 4) throw new Error(`chooseStripEdge: picture ${info.width}x${info.height} too small`);
  const calmness = blockCalmness(gray, info.width, rows, cols);
  const band = Math.max(1, Math.round(rows * Math.min(STRIP_BAND_MAX, Math.max(STRIP_BAND_MIN, bandFraction))));
  const seam = Math.max(1, Math.round(rows * STRIP_SEAM_SHARE));
  const stat = (r0, r1) => {
    let sum = 0, min = Infinity;
    for (let i = r0 * cols; i < r1 * cols; i++) { sum += calmness[i]; if (calmness[i] < min) min = calmness[i]; }
    return { mean: sum / ((r1 - r0) * cols), min };
  };
  const top = stat(0, band).mean;
  const bottom = stat(rows - band, rows).mean;
  const topEligible = stat(0, seam).min >= TEXT_CALM_THRESHOLD;
  const bottomEligible = stat(rows - seam, rows).min >= TEXT_CALM_THRESHOLD;
  let edge = 'bottom';
  if (topEligible && !bottomEligible) edge = 'top';
  else if (topEligible && bottomEligible && top - bottom >= STRIP_TIE_GAP) edge = 'top';
  else if (topEligible && bottomEligible && bottom - top >= STRIP_TIE_GAP) edge = 'bottom';
  return { edge, top, bottom, topEligible, bottomEligible };
}

/**
 * The full-width text position for a picture that stores none: 'top-full' or 'bottom-full' by
 * chooseStripEdge. The single place the "no stored textPosition" case is decided (print overlay
 * modes, text-overlay routes); there is no position cycle.
 * @returns {Promise<'top-full'|'bottom-full'>}
 */
async function pickFullWidthPosition(imageBuffer) {
  return `${(await chooseStripEdge(imageBuffer)).edge}-full`;
}

/**
 * Find the calm region, lighten it, and return the modified image + text rect.
 *
 * @param {string} imageData - base64 data URI
 * @param {string} preferredPosition - Claude's chosen position (e.g. 'top-right')
 * @param {number} pageNumber - odd=left page, even=right page
 * @param {object} [options]
 * @param {number} [options.washOpacity=0.45] - max opacity of the white wash (0-1)
 * @param {number} [options.calmThreshold=0.35] - blocks above this get the wash
 * @returns {{ imageData: string, position: string, rect: {x,y,w,h}, score: number, overridden: boolean }}
 */
async function detectAndLightenTextRegion(imageData, preferredPosition, pageNumber, options = {}) {
  // washOpacity and calmThreshold are kept for the coverage/rect math below;
  // no wash is actually baked into the image anymore.
  // overlayPolygon: the actual polygon the renderer will draw text into.
  //   Corner positions are RIGHT TRIANGLES, not rectangles — measuring a
  //   bounding rectangle overestimates calm coverage by ~2× (triangle area
  //   is half the bounding rect's). When provided, we count calm pixels
  //   INSIDE that polygon, which is the only measurement that tells us
  //   whether the rendered overlay will land on a calm area.
  const { washOpacity = 0.9, calmThreshold = TEXT_CALM_THRESHOLD, overlayPolygon = null } = options;

  try {
    const base64 = stripDataUriPrefix(imageData);
    const buf = Buffer.from(base64, 'base64');
    const meta = await sharp(buf).metadata();
    const width = meta.width;
    const height = meta.height;

    const { data: grayPixels } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });

    const rows = Math.floor(height / BLOCK_SIZE);
    const cols = Math.floor(width / BLOCK_SIZE);
    if (rows < 4 || cols < 4) {
      return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false };
    }

    // ── Step 1-2: Compute per-block calmness ──
    const calmness = blockCalmness(grayPixels, width, rows, cols);

    // ── Step 3: Build a per-pixel alpha mask from the calmness map ──
    // Only include blocks on the correct side of the image (spread rule).
    const isLeftPage = pageNumber % 2 === 1;
    const isTop = preferredPosition?.startsWith('top') ?? true;

    // Target zone: the half (top/bottom) × half (left/right) or full width
    const isFull = preferredPosition?.includes('full');
    const isLeft = preferredPosition?.includes('left') || isFull;

    // Build block-level mask: calm blocks INSIDE the intended zone only.
    // Hard-restrict both axes to the zone the outline chose (bottom-left is
    // bottom + left, etc). Previously this was a soft weight (0.3 for the
    // wrong half) which let a very-calm top override a chosen bottom and
    // swap the stored position from bottom-left → top-left at the bbox
    // re-derivation step below. Now: blocks outside the zone are excluded
    // entirely so the detected rect can never leave the intended corner.
    const blockMask = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const blockCenterX = (c + 0.5) / cols;
        const blockCenterY = (r + 0.5) / rows;
        // Horizontal zone
        if (!isFull) {
          if (isLeft && blockCenterX > 0.5) continue;
          if (!isLeft && blockCenterX < 0.5) continue;
        }
        // Vertical zone — hard split on 0.5. top-* only top, bottom-* only bottom.
        if (isTop && blockCenterY > 0.5) continue;
        if (!isTop && blockCenterY < 0.5) continue;

        if (calmness[idx] >= calmThreshold) {
          blockMask[idx] = calmness[idx];
        }
      }
    }

    // ── Step 4: Upscale block mask to pixel-level and blur for feathered edges ──
    // Create a single-channel buffer at block resolution, then resize
    const maskBlockBuf = Buffer.alloc(rows * cols);
    for (let i = 0; i < blockMask.length; i++) {
      maskBlockBuf[i] = Math.round(Math.min(1, blockMask[i] / 0.8) * washOpacity * 255);
    }

    // Upscale to full image size with bilinear interpolation (smooth edges)
    const maskPixels = await sharp(maskBlockBuf, { raw: { width: cols, height: rows, channels: 1 } })
      .resize(width, height, { kernel: 'cubic' })
      .blur(Math.max(0.3, Math.round(Math.min(width, height) * 0.03)))
      .toColourspace('b-w')  // force single channel output
      .raw()
      .toBuffer();

    // ── Step 5: Check if there's enough calm area to place text ──
    let washPixelCount = 0;
    for (let i = 0; i < maskPixels.length; i++) {
      if (maskPixels[i] > 30) washPixelCount++;
    }
    const washCoverage = washPixelCount / (width * height);

    // Count calm pixels INSIDE the actual overlay polygon (the shape the
    // production renderer will draw text into). For corner positions the
    // polygon is a right TRIANGLE — measuring a bounding rectangle would
    // overestimate calm area by ~2× because triangle area is half its
    // bounding rect's. For full-width positions the polygon is a rectangle.
    let overlayCalmPx = null;
    let overlayAreaPx = null;
    if (Array.isArray(overlayPolygon) && overlayPolygon.length >= 3) {
      // Compute polygon's pixel-axis bounding box to limit the scan.
      let minPx = width, minPy = height, maxPx = 0, maxPy = 0;
      for (const [px, py] of overlayPolygon) {
        if (px < minPx) minPx = px;
        if (py < minPy) minPy = py;
        if (px > maxPx) maxPx = px;
        if (py > maxPy) maxPy = py;
      }
      const x0 = Math.max(0, Math.floor(minPx));
      const y0 = Math.max(0, Math.floor(minPy));
      const x1 = Math.min(width, Math.ceil(maxPx));
      const y1 = Math.min(height, Math.ceil(maxPy));

      // Polygon area via shoelace (absolute, in pixel²).
      let signed = 0;
      for (let i = 0; i < overlayPolygon.length; i++) {
        const [x1p, y1p] = overlayPolygon[i];
        const [x2p, y2p] = overlayPolygon[(i + 1) % overlayPolygon.length];
        signed += x1p * y2p - x2p * y1p;
      }
      overlayAreaPx = Math.abs(signed) / 2;

      // Ray-cast point-in-polygon test, only across the bbox region.
      const insidePolygon = (px, py) => {
        let inside = false;
        for (let i = 0, j = overlayPolygon.length - 1; i < overlayPolygon.length; j = i++) {
          const [xi, yi] = overlayPolygon[i];
          const [xj, yj] = overlayPolygon[j];
          if (((yi > py) !== (yj > py))
            && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) {
            inside = !inside;
          }
        }
        return inside;
      };

      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          if (maskPixels[row + x] > 30 && insidePolygon(x + 0.5, y + 0.5)) count++;
        }
      }
      overlayCalmPx = count;
    }

    if (washCoverage < 0.05) {
      // Less than 5% of image is calm enough — don't wash, just return original
      log.info(`📝 [TEXT-REGION] P${pageNumber}: no calm region found (${(washCoverage * 100).toFixed(1)}% coverage) — using original`);
      return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false, overlayCalmPx, overlayAreaPx };
    }

    // Image is returned untouched — blur + text are composited at render time,
    // not baked in.
    const washedDataUri = imageData;

    // ── Step 7: Compute bounding box of the washed region for text placement ──
    let minX = width, minY = height, maxX = 0, maxY = 0;
    const threshold = Math.round(washOpacity * 255 * 0.3); // ~30% of max wash
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (maskPixels[y * width + x] > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // Guard: if no pixel passed the threshold, bbox stays at init values (negative dims)
    if (maxX <= minX || maxY <= minY) {
      log.info(`📝 [TEXT-REGION] P${pageNumber}: washed but no pixels above bbox threshold — using position only`);
      return { imageData: washedDataUri, position: preferredPosition, rect: null, score: washCoverage, overridden: false, overlayCalmPx, overlayAreaPx };
    }

    const rect = {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      imgWidth: width,
      imgHeight: height,
    };

    // The outline already chose the zone (preferredPosition). We only refine
    // the RECT inside that zone — never change which quadrant it sits in.
    // With the hard zone restriction above, the detected bbox is guaranteed
    // to lie inside the intended half, so preferredPosition is authoritative.
    const position = preferredPosition;
    const overridden = false;
    const overlayPctStr = overlayAreaPx
      ? ` overlay ${overlayCalmPx}/${overlayAreaPx}px (${((overlayCalmPx / overlayAreaPx) * 100).toFixed(0)}% calm)`
      : '';
    log.info(`📝 [TEXT-REGION] P${pageNumber}: ${position}, wash ${(washCoverage * 100).toFixed(0)}% of image, rect ${rect.x},${rect.y} ${rect.w}×${rect.h}${overlayPctStr}`);

    return {
      imageData: washedDataUri,
      position,
      rect,
      score: washCoverage,
      overridden,
      overlayCalmPx,
      overlayAreaPx,
    };
  } catch (err) {
    log.warn(`⚠️ [TEXT-REGION] P${pageNumber} failed: ${err.message}`);
    return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false, overlayCalmPx: null, overlayAreaPx: null };
  }
}

module.exports = { detectAndLightenTextRegion, chooseStripEdge, pickFullWidthPosition, blockCalmness, STRIP_TIE_GAP, STRIP_SEAM_SHARE, TEXT_CALM_THRESHOLD };
