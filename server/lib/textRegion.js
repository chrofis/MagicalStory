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
 * 2. Calmness = (1 - variance) — low-variance regions, regardless of brightness
 * 3. Build a per-pixel alpha mask from calmness (used only for bbox + score)
 * 4. Constrain to the correct side (odd=left, even=right) + target area
 * 5. Return the original image unchanged + position + rect + coverage score
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');

const BLOCK_SIZE = 16;

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
  const { washOpacity = 0.9, calmThreshold = 0.35 } = options;

  try {
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
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
      // Low-variance wins, regardless of brightness — white text with a dark
      // stroke reads on both light and dark as long as the area isn't busy.
      const vNorm = variances[i] / vMax;
      calmness[i] = 1 - vNorm;
    }

    // ── Step 3: Build a per-pixel alpha mask from the calmness map ──
    // Only include blocks on the correct side of the image (spread rule).
    const isLeftPage = pageNumber % 2 === 1;
    const isTop = preferredPosition?.startsWith('top') ?? true;

    // Target zone: the half (top/bottom) × half (left/right) or full width
    const isFull = preferredPosition?.includes('full');
    const isLeft = preferredPosition?.includes('left') || isFull;

    // Build block-level mask: 1.0 for calm blocks in target zone, 0 elsewhere
    const blockMask = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        // Side constraint: block must be on the correct side
        const blockCenterX = (c + 0.5) / cols;
        if (!isFull) {
          if (isLeftPage && blockCenterX > 0.65) continue;  // left page: keep left 65%
          if (!isLeftPage && blockCenterX < 0.35) continue;  // right page: keep right 65%
        }
        // Vertical preference: prefer the chosen half but allow spillover
        const blockCenterY = (r + 0.5) / rows;
        let verticalWeight = 1.0;
        if (isTop && blockCenterY > 0.6) verticalWeight = 0.3;
        if (!isTop && blockCenterY < 0.4) verticalWeight = 0.3;

        if (calmness[idx] >= calmThreshold) {
          blockMask[idx] = calmness[idx] * verticalWeight;
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

    if (washCoverage < 0.05) {
      // Less than 5% of image is calm enough — don't wash, just return original
      log.info(`📝 [TEXT-REGION] P${pageNumber}: no calm region found (${(washCoverage * 100).toFixed(1)}% coverage) — using original`);
      return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false };
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
      return { imageData: washedDataUri, position: preferredPosition, rect: null, score: washCoverage, overridden: false };
    }

    const rect = {
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY,
      imgWidth: width,
      imgHeight: height,
    };

    // Determine position label from rect center
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    const detectedIsTop = centerY < height / 2;
    const detectedIsLeft = centerX < width / 2;
    const detectedIsFull = rect.w > width * 0.75;
    let position;
    if (detectedIsFull) {
      position = detectedIsTop ? 'top-full' : 'bottom-full';
    } else {
      position = `${detectedIsTop ? 'top' : 'bottom'}-${detectedIsLeft ? 'left' : 'right'}`;
    }

    const overridden = position !== preferredPosition;
    log.info(`📝 [TEXT-REGION] P${pageNumber}: ${overridden ? preferredPosition + ' → ' : ''}${position}, wash ${(washCoverage * 100).toFixed(0)}% of image, rect ${rect.x},${rect.y} ${rect.w}×${rect.h}`);

    return {
      imageData: washedDataUri,
      position,
      rect,
      score: washCoverage,
      overridden,
    };
  } catch (err) {
    log.warn(`⚠️ [TEXT-REGION] P${pageNumber} failed: ${err.message}`);
    return { imageData, position: preferredPosition, rect: null, score: 0, overridden: false };
  }
}

module.exports = { detectAndLightenTextRegion };
