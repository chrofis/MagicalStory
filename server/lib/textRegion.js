/**
 * Text region detection — finds the best light/calm area in a generated
 * illustration for overlaying dark story text.
 *
 * Ported from tests/manual/test-text-region-detect.py to Node.js.
 * Uses sharp for pixel access — no OpenCV dependency.
 *
 * Algorithm:
 * 1. Convert to grayscale, divide into blocks
 * 2. Compute per-block brightness (mean) and variance (std)
 * 3. Calmness = brightness^1.5 * (1 - normalized_variance)
 *    High score = bright + uniform = good for dark text
 * 4. Find the best rectangle anchored to each candidate position
 * 5. Return the position with the highest calmness score
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');

const BLOCK_SIZE = 16;

// All valid text positions
const ALL_POSITIONS = [
  'top-left', 'top-right', 'top-full',
  'bottom-left', 'bottom-right', 'bottom-full'
];

/**
 * Detect the best text overlay position in a generated image.
 *
 * @param {string} imageData - base64 data URI of the page image
 * @param {string} preferredPosition - the position Claude chose (e.g. 'top-right')
 * @param {number} pageNumber - for spread enforcement (odd=left, even=right)
 * @returns {{ position: string, score: number, preferredScore: number, overridden: boolean }}
 */
async function detectBestTextPosition(imageData, preferredPosition, pageNumber) {
  try {
    const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    const { data: pixels, info } = await sharp(buf)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const rows = Math.floor(height / BLOCK_SIZE);
    const cols = Math.floor(width / BLOCK_SIZE);

    if (rows < 4 || cols < 4) {
      return { position: preferredPosition, score: 0, preferredScore: 0, overridden: false };
    }

    // Compute per-block brightness and variance
    const brightness = new Float32Array(rows * cols);
    const variance = new Float32Array(rows * cols);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        let sumSq = 0;
        const count = BLOCK_SIZE * BLOCK_SIZE;
        for (let by = 0; by < BLOCK_SIZE; by++) {
          const rowOffset = (r * BLOCK_SIZE + by) * width;
          for (let bx = 0; bx < BLOCK_SIZE; bx++) {
            const val = pixels[rowOffset + c * BLOCK_SIZE + bx];
            sum += val;
            sumSq += val * val;
          }
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        brightness[r * cols + c] = mean;
        variance[r * cols + c] = std;
      }
    }

    // Normalize and compute calmness
    let vMax = 0;
    for (let i = 0; i < variance.length; i++) {
      if (variance[i] > vMax) vMax = variance[i];
    }
    if (vMax === 0) vMax = 1;

    const calmness = new Float32Array(rows * cols);
    for (let i = 0; i < calmness.length; i++) {
      const bNorm = brightness[i] / 255;
      const vNorm = variance[i] / vMax;
      calmness[i] = Math.pow(bNorm, 1.5) * (1 - vNorm);
    }

    // Build integral image
    const integral = new Float64Array((rows + 1) * (cols + 1));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        integral[(r + 1) * (cols + 1) + (c + 1)] =
          calmness[r * cols + c]
          + integral[r * (cols + 1) + (c + 1)]
          + integral[(r + 1) * (cols + 1) + c]
          - integral[r * (cols + 1) + c];
      }
    }

    const rectSum = (r1, c1, r2, c2) =>
      integral[r2 * (cols + 1) + c2]
      - integral[r1 * (cols + 1) + c2]
      - integral[r2 * (cols + 1) + c1]
      + integral[r1 * (cols + 1) + c1];

    // Score each candidate position
    const isLeftPage = pageNumber % 2 === 1;
    const candidates = ALL_POSITIONS.filter(p => {
      // Enforce spread: odd=left, even=right (skip wrong-side corners)
      if (p.includes('left') && !isLeftPage) return false;
      if (p.includes('right') && isLeftPage) return false;
      return true;
    });

    const minHFrac = 0.15;
    const maxHFrac = 0.40;
    const minWFrac = 0.30;
    const maxWFrac = 0.65;

    const scorePosition = (position) => {
      const isTop = position.startsWith('top');
      const isLeft = position.includes('left') || position.includes('full');
      const isFull = position.includes('full');

      const minH = Math.max(2, Math.floor(rows * minHFrac));
      const maxH = Math.floor(rows * maxHFrac);
      const minW = Math.max(2, Math.floor(cols * minWFrac));
      const maxW = Math.floor(cols * maxWFrac);

      let bestScore = -1;
      // Step by 2 to reduce computation (still fine-grained enough)
      for (let h = minH; h <= maxH; h += 2) {
        for (let w = minW; w <= maxW; w += 2) {
          let r1, r2, c1, c2;
          if (isFull) {
            c1 = 0; c2 = cols;
            r1 = isTop ? 0 : rows - h;
            r2 = isTop ? h : rows;
          } else {
            r1 = isTop ? 0 : rows - h;
            r2 = isTop ? h : rows;
            c1 = isLeft ? 0 : cols - w;
            c2 = isLeft ? w : cols;
          }
          if (r2 > rows || c2 > cols || r1 < 0 || c1 < 0) continue;

          const area = (r2 - r1) * (c2 - c1);
          const avg = rectSum(r1, c1, r2, c2) / area;
          const sizeBonus = (area / (rows * cols)) * 0.3;
          const score = avg + sizeBonus;

          if (score > bestScore) bestScore = score;
        }
      }
      return bestScore;
    };

    const scores = {};
    for (const pos of candidates) {
      scores[pos] = scorePosition(pos);
    }

    // Find best position
    let bestPos = preferredPosition;
    let bestScore = scores[preferredPosition] ?? -1;
    for (const [pos, score] of Object.entries(scores)) {
      if (score > bestScore) {
        bestScore = score;
        bestPos = pos;
      }
    }

    const preferredScore = scores[preferredPosition] ?? -1;
    const overridden = bestPos !== preferredPosition;
    // Only override if the detected position is significantly better (>15% higher score)
    const significantlyBetter = preferredScore > 0 && (bestScore - preferredScore) / preferredScore > 0.15;

    if (overridden && significantlyBetter) {
      log.info(`📝 [TEXT-REGION] Override: ${preferredPosition} (${preferredScore.toFixed(2)}) → ${bestPos} (${bestScore.toFixed(2)})`);
      return { position: bestPos, score: bestScore, preferredScore, overridden: true };
    }

    return { position: preferredPosition, score: preferredScore, preferredScore, overridden: false };
  } catch (err) {
    log.warn(`⚠️ [TEXT-REGION] Detection failed: ${err.message} — using preferred position`);
    return { position: preferredPosition, score: 0, preferredScore: 0, overridden: false };
  }
}

module.exports = { detectBestTextPosition };
