/**
 * calmRegion.js — Detect the calmest region in a children's book illustration
 * for text overlay placement.
 *
 * Given an image buffer and a text position (e.g. "top-left"), finds the largest
 * calm (uniform, low-detail) area near that position and returns it as a
 * simplified polygon.
 */

const sharp = require('sharp');

const BLOCK_SIZE = 12;
const VALID_POSITIONS = ['top-left', 'top-right', 'top-full', 'bottom-left', 'bottom-right', 'bottom-full'];

/**
 * Detect the calmest region in an image near a given text position.
 *
 * @param {Buffer} imageBuffer - Image file buffer (PNG, JPEG, etc.)
 * @param {string} textPosition - One of: top-left, top-right, top-full, bottom-left, bottom-right, bottom-full
 * @param {object} [options] - Optional overrides
 * @param {number} [options.blockSize=12] - Block size in pixels
 * @param {number} [options.minAreaFraction=0.08] - Minimum polygon area as fraction of image
 * @param {number} [options.percentile=55] - Percentile for adaptive threshold (0-100)
 * @returns {Promise<{polygon: number[][], polygonPercent: number[][], areaFraction: number, bounds: {x:number,y:number,w:number,h:number}}|null>}
 */
async function detectCalmRegion(imageBuffer, textPosition, options = {}) {
  try {
    if (!VALID_POSITIONS.includes(textPosition)) {
      console.log(`[CALM-REGION] Invalid textPosition "${textPosition}", must be one of: ${VALID_POSITIONS.join(', ')}`);
      return null;
    }

    const blockSize = options.blockSize || BLOCK_SIZE;
    const minAreaFraction = options.minAreaFraction || 0.08;
    const percentile = options.percentile || 55;

    // Step 1: Get grayscale pixels
    const { data, info } = await sharp(imageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    console.log(`[CALM-REGION] Image ${width}x${height}, blockSize=${blockSize}`);

    const gridW = Math.floor(width / blockSize);
    const gridH = Math.floor(height / blockSize);
    if (gridW < 4 || gridH < 4) {
      console.log(`[CALM-REGION] Image too small for block grid (${gridW}x${gridH})`);
      return null;
    }

    // Step 2: Compute block-based calmness grid
    const calmness = computeCalmnessGrid(data, width, height, blockSize, gridW, gridH);

    // Step 3: Detect and exclude border
    excludeBorder(data, width, height, calmness, blockSize, gridW, gridH);

    // Step 4: Restrict to target zone
    restrictToZone(calmness, gridW, gridH, textPosition);

    // Step 5: Adaptive threshold
    const binary = adaptiveThreshold(calmness, gridW, gridH, percentile);

    // Step 6: Morphological smoothing
    morphologicalSmoothing(binary, gridW, gridH);

    // Step 7: Find largest contiguous region near target
    const component = findBestComponent(binary, gridW, gridH, textPosition);
    if (!component) {
      console.log('[CALM-REGION] No contiguous region found');
      return null;
    }

    // Step 8: Extract polygon outline
    const blockPolygon = extractBorderPolygon(component, gridW, gridH);
    if (!blockPolygon || blockPolygon.length < 3) {
      console.log('[CALM-REGION] Could not extract polygon border');
      return null;
    }

    // Convert block coords to pixel coords
    const pixelPolygon = blockPolygon.map(([bx, by]) => [bx * blockSize, by * blockSize]);

    // Step 9: Simplify polygon (Douglas-Peucker)
    const perimeter = (width + height) * 2;
    const epsilon = perimeter * 0.025;
    let simplified = simplifyPolygon(pixelPolygon, epsilon);

    // Ensure 6-15 vertices
    if (simplified.length > 15) {
      simplified = simplifyPolygon(pixelPolygon, epsilon * 1.5);
    }
    if (simplified.length > 15) {
      simplified = simplifyPolygon(pixelPolygon, epsilon * 2);
    }
    if (simplified.length < 4 && pixelPolygon.length >= 4) {
      simplified = simplifyPolygon(pixelPolygon, epsilon * 0.5);
    }

    // Step 10: Validate and return
    const polyArea = polygonArea(simplified);
    const imageArea = width * height;
    const areaFraction = polyArea / imageArea;

    if (areaFraction < minAreaFraction) {
      console.log(`[CALM-REGION] Region too small: ${(areaFraction * 100).toFixed(1)}% < ${(minAreaFraction * 100).toFixed(1)}%`);
      return null;
    }

    // Compute bounds
    const xs = simplified.map(p => p[0]);
    const ys = simplified.map(p => p[1]);
    const bounds = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys)
    };

    // Percentage coordinates (0-100)
    const polygonPercent = simplified.map(([x, y]) => [
      Math.round((x / width) * 100 * 10) / 10,
      Math.round((y / height) * 100 * 10) / 10
    ]);

    console.log(`[CALM-REGION] Found region: ${simplified.length} vertices, ${(areaFraction * 100).toFixed(1)}% of image, bounds ${bounds.x},${bounds.y} ${bounds.w}x${bounds.h}`);

    return {
      polygon: simplified,
      polygonPercent,
      areaFraction,
      bounds
    };
  } catch (err) {
    console.error(`[CALM-REGION] Error: ${err.message}`);
    return null;
  }
}

// ─── Step 2: Compute calmness grid ──────────────────────────────────────────

function computeCalmnessGrid(data, width, height, blockSize, gridW, gridH) {
  const variances = new Float64Array(gridW * gridH);
  const edgeDensities = new Float64Array(gridW * gridH);
  const brightnesses = new Float64Array(gridW * gridH);

  let maxVariance = 0;
  let maxEdge = 0;

  for (let by = 0; by < gridH; by++) {
    for (let bx = 0; bx < gridW; bx++) {
      const idx = by * gridW + bx;
      const px0 = bx * blockSize;
      const py0 = by * blockSize;

      // Collect pixel values in this block
      let sum = 0;
      let sumSq = 0;
      let edgeSum = 0;
      let count = 0;
      let edgeCount = 0;

      for (let dy = 0; dy < blockSize && py0 + dy < height; dy++) {
        for (let dx = 0; dx < blockSize && px0 + dx < width; dx++) {
          const px = px0 + dx;
          const py = py0 + dy;
          const val = data[py * width + px];
          sum += val;
          sumSq += val * val;
          count++;

          // Edge: |pixel - right neighbor| + |pixel - bottom neighbor|
          let edgeVal = 0;
          if (px + 1 < width) {
            edgeVal += Math.abs(val - data[py * width + px + 1]);
          }
          if (py + 1 < height) {
            edgeVal += Math.abs(val - data[(py + 1) * width + px]);
          }
          edgeSum += edgeVal;
          edgeCount++;
        }
      }

      const mean = sum / count;
      const variance = Math.sqrt(sumSq / count - mean * mean);
      const edgeDensity = edgeSum / edgeCount;

      brightnesses[idx] = mean / 255;
      variances[idx] = variance;
      edgeDensities[idx] = edgeDensity;

      if (variance > maxVariance) maxVariance = variance;
      if (edgeDensity > maxEdge) maxEdge = edgeDensity;
    }
  }

  // Normalize and compute calmness
  const calmness = new Float64Array(gridW * gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    const normVar = maxVariance > 0 ? variances[i] / maxVariance : 0;
    const normEdge = maxEdge > 0 ? edgeDensities[i] / maxEdge : 0;
    const brightness = brightnesses[i];
    calmness[i] = (1 - normVar) * (1 - Math.pow(normEdge, 0.7)) * (0.7 + 0.3 * brightness);
  }

  return calmness;
}

// ─── Step 3: Detect and exclude border ──────────────────────────────────────

function excludeBorder(data, width, height, calmness, blockSize, gridW, gridH) {
  // Check corners
  const corners = [
    data[0],                                    // top-left
    data[width - 1],                            // top-right
    data[(height - 1) * width],                 // bottom-left
    data[(height - 1) * width + width - 1]      // bottom-right
  ];

  const minCorner = Math.min(...corners);
  const maxCorner = Math.max(...corners);
  if (maxCorner - minCorner > 20) return; // Corners not similar enough

  const cornerAvg = (corners[0] + corners[1] + corners[2] + corners[3]) / 4;

  // Scan inward from each edge
  const borderTop = scanBorderEdge(data, width, height, 'top', cornerAvg);
  const borderBottom = scanBorderEdge(data, width, height, 'bottom', cornerAvg);
  const borderLeft = scanBorderEdge(data, width, height, 'left', cornerAvg);
  const borderRight = scanBorderEdge(data, width, height, 'right', cornerAvg);

  const bTop = Math.ceil(borderTop / blockSize);
  const bBottom = Math.ceil(borderBottom / blockSize);
  const bLeft = Math.ceil(borderLeft / blockSize);
  const bRight = Math.ceil(borderRight / blockSize);

  if (bTop + bBottom + bLeft + bRight === 0) return;

  console.log(`[CALM-REGION] Border detected: top=${borderTop}px, bottom=${borderBottom}px, left=${borderLeft}px, right=${borderRight}px`);

  for (let by = 0; by < gridH; by++) {
    for (let bx = 0; bx < gridW; bx++) {
      if (by < bTop || by >= gridH - bBottom || bx < bLeft || bx >= gridW - bRight) {
        calmness[by * gridW + bx] = 0;
      }
    }
  }
}

function scanBorderEdge(data, width, height, edge, cornerVal) {
  const threshold = 40;
  let maxDepth = 0;

  if (edge === 'top') {
    const midX = Math.floor(width / 2);
    for (let y = 0; y < Math.min(height, Math.floor(height * 0.15)); y++) {
      if (Math.abs(data[y * width + midX] - cornerVal) > threshold) {
        maxDepth = y;
        break;
      }
      maxDepth = y + 1;
    }
  } else if (edge === 'bottom') {
    const midX = Math.floor(width / 2);
    for (let y = height - 1; y >= Math.max(0, height - Math.floor(height * 0.15)); y--) {
      if (Math.abs(data[y * width + midX] - cornerVal) > threshold) {
        maxDepth = height - 1 - y;
        break;
      }
      maxDepth = height - y;
    }
  } else if (edge === 'left') {
    const midY = Math.floor(height / 2);
    for (let x = 0; x < Math.min(width, Math.floor(width * 0.15)); x++) {
      if (Math.abs(data[midY * width + x] - cornerVal) > threshold) {
        maxDepth = x;
        break;
      }
      maxDepth = x + 1;
    }
  } else if (edge === 'right') {
    const midY = Math.floor(height / 2);
    for (let x = width - 1; x >= Math.max(0, width - Math.floor(width * 0.15)); x--) {
      if (Math.abs(data[midY * width + x] - cornerVal) > threshold) {
        maxDepth = width - 1 - x;
        break;
      }
      maxDepth = width - x;
    }
  }

  return maxDepth;
}

// ─── Step 4: Restrict to target zone ────────────────────────────────────────

function restrictToZone(calmness, gridW, gridH, textPosition) {
  const cutoff = Math.floor(gridH * 0.65);

  if (textPosition.startsWith('top')) {
    // Zero out bottom 65%
    for (let by = gridH - cutoff; by < gridH; by++) {
      for (let bx = 0; bx < gridW; bx++) {
        calmness[by * gridW + bx] = 0;
      }
    }
  } else if (textPosition.startsWith('bottom')) {
    // Zero out top 65%
    for (let by = 0; by < cutoff; by++) {
      for (let bx = 0; bx < gridW; bx++) {
        calmness[by * gridW + bx] = 0;
      }
    }
  }
}

// ─── Step 5: Adaptive threshold ─────────────────────────────────────────────

function adaptiveThreshold(calmness, gridW, gridH, percentile) {
  // Collect non-zero values
  const nonZero = [];
  for (let i = 0; i < gridW * gridH; i++) {
    if (calmness[i] > 0) nonZero.push(calmness[i]);
  }

  if (nonZero.length === 0) return new Uint8Array(gridW * gridH);

  nonZero.sort((a, b) => a - b);
  const pIdx = Math.floor(nonZero.length * percentile / 100);
  const threshold = nonZero[Math.min(pIdx, nonZero.length - 1)];

  const binary = new Uint8Array(gridW * gridH);
  for (let i = 0; i < gridW * gridH; i++) {
    binary[i] = calmness[i] >= threshold ? 1 : 0;
  }

  return binary;
}

// ─── Step 6: Morphological smoothing ────────────────────────────────────────

function morphologicalSmoothing(binary, gridW, gridH) {
  const size = gridW * gridH;

  // Close: dilate then erode
  // Dilate: if any 3x3 neighbor is 1, set to 1
  const dilated = new Uint8Array(size);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let any1 = false;
      for (let dy = -1; dy <= 1 && !any1; dy++) {
        for (let dx = -1; dx <= 1 && !any1; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW) {
            if (binary[ny * gridW + nx] === 1) any1 = true;
          }
        }
      }
      dilated[y * gridW + x] = any1 ? 1 : 0;
    }
  }

  // Erode the dilated result: if any 3x3 neighbor is 0, set to 0
  const closed = new Uint8Array(size);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let any0 = false;
      for (let dy = -1; dy <= 1 && !any0; dy++) {
        for (let dx = -1; dx <= 1 && !any0; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW) {
            if (dilated[ny * gridW + nx] === 0) any0 = true;
          } else {
            any0 = true; // Treat out-of-bounds as 0
          }
        }
      }
      closed[y * gridW + x] = any0 ? 0 : 1;
    }
  }

  // Erode once more: if any 8-neighbor is 0, set to 0
  const eroded = new Uint8Array(size);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let any0 = false;
      for (let dy = -1; dy <= 1 && !any0; dy++) {
        for (let dx = -1; dx <= 1 && !any0; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW) {
            if (closed[ny * gridW + nx] === 0) any0 = true;
          } else {
            any0 = true;
          }
        }
      }
      eroded[y * gridW + x] = any0 ? 0 : 1;
    }
  }

  // Blur: replace each cell with average of 5x5 neighborhood, re-threshold at 0.5
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let sum = 0, count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ny = y + dy, nx = x + dx;
          if (ny >= 0 && ny < gridH && nx >= 0 && nx < gridW) {
            sum += eroded[ny * gridW + nx];
            count++;
          }
        }
      }
      binary[y * gridW + x] = (sum / count) >= 0.5 ? 1 : 0;
    }
  }
}

// ─── Step 7: Find best component ────────────────────────────────────────────

function findBestComponent(binary, gridW, gridH, textPosition) {
  const labels = new Int32Array(gridW * gridH).fill(-1);
  const components = []; // Array of { cells: Set, area: number }
  let nextLabel = 0;

  // Flood-fill to find connected components
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = y * gridW + x;
      if (binary[idx] === 0 || labels[idx] >= 0) continue;

      // BFS flood fill
      const label = nextLabel++;
      const cells = new Set();
      const queue = [[x, y]];
      labels[idx] = label;

      while (queue.length > 0) {
        const [cx, cy] = queue.pop();
        cells.add(cy * gridW + cx);

        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
            const ni = ny * gridW + nx;
            if (binary[ni] === 1 && labels[ni] < 0) {
              labels[ni] = label;
              queue.push([nx, ny]);
            }
          }
        }
      }

      components.push({ cells, area: cells.size });
    }
  }

  if (components.length === 0) return null;

  // Determine target corner
  let targetX, targetY;
  if (textPosition.includes('left')) {
    targetX = 0;
  } else if (textPosition.includes('right')) {
    targetX = gridW - 1;
  } else {
    targetX = Math.floor(gridW / 2); // 'full' positions
  }
  if (textPosition.startsWith('top')) {
    targetY = 0;
  } else {
    targetY = gridH - 1;
  }

  const maxDist = Math.sqrt(gridW * gridW + gridH * gridH);
  const maxArea = Math.max(...components.map(c => c.area));

  let bestScore = -1;
  let bestComponent = null;

  for (const comp of components) {
    if (comp.area < 4) continue; // Skip tiny components

    // Find centroid
    let sumX = 0, sumY = 0;
    for (const idx of comp.cells) {
      sumX += idx % gridW;
      sumY += Math.floor(idx / gridW);
    }
    const cx = sumX / comp.area;
    const cy = sumY / comp.area;

    const dist = Math.sqrt((cx - targetX) ** 2 + (cy - targetY) ** 2);
    const proximity = 1 - dist / maxDist;
    const areaNorm = comp.area / maxArea;

    const score = areaNorm * 0.4 + proximity * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bestComponent = comp;
    }
  }

  return bestComponent;
}

// ─── Step 8: Extract polygon outline ────────────────────────────────────────

/**
 * Extract the outline polygon of a component by scanning its row profile.
 * For each row that contains component cells, record the leftmost and rightmost
 * extent. This builds two chains (left edge going down, right edge going up)
 * that form a closed polygon. The result is in block coordinates.
 */
function extractBorderPolygon(component, gridW, gridH) {
  // Build a 2D boolean grid for this component
  const grid = new Uint8Array(gridW * gridH);
  for (const idx of component.cells) {
    grid[idx] = 1;
  }

  // Find the row range and per-row left/right extents
  let minRow = gridH, maxRow = -1;
  const rowLeft = new Int32Array(gridH).fill(gridW);
  const rowRight = new Int32Array(gridH).fill(-1);

  for (const idx of component.cells) {
    const x = idx % gridW;
    const y = Math.floor(idx / gridW);
    if (y < minRow) minRow = y;
    if (y > maxRow) maxRow = y;
    if (x < rowLeft[y]) rowLeft[y] = x;
    if (x > rowRight[y]) rowRight[y] = x;
  }

  if (minRow > maxRow) return null;

  // Build polygon: walk down the left edge, then up the right edge
  // Use block corner coordinates (each cell spans from (x, y) to (x+1, y+1) in block coords)
  const leftChain = [];  // top-left corners going down
  const rightChain = []; // top-right corners going up

  for (let y = minRow; y <= maxRow; y++) {
    if (rowLeft[y] > rowRight[y]) continue; // skip empty rows (shouldn't happen in connected component)
    leftChain.push([rowLeft[y], y]);         // top-left of leftmost cell
    rightChain.push([rowRight[y] + 1, y]);   // top-right of rightmost cell
  }

  // Close bottom: add bottom-left and bottom-right of last row
  const lastY = maxRow + 1;
  const lastRowIdx = leftChain.length - 1;
  if (lastRowIdx < 0) return null;

  // The polygon goes: down the left side, across the bottom, up the right side, across the top
  const points = [];

  // Left chain (top to bottom)
  for (let i = 0; i < leftChain.length; i++) {
    points.push(leftChain[i]);
  }
  // Bottom-left corner
  points.push([leftChain[lastRowIdx][0], lastY]);
  // Bottom-right corner
  points.push([rightChain[rightChain.length - 1][0], lastY]);
  // Right chain (bottom to top)
  for (let i = rightChain.length - 1; i >= 0; i--) {
    points.push(rightChain[i]);
  }

  if (points.length < 3) return null;

  // Remove consecutive duplicates
  const deduped = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] !== deduped[deduped.length - 1][0] || points[i][1] !== deduped[deduped.length - 1][1]) {
      deduped.push(points[i]);
    }
  }
  // Remove last if same as first
  if (deduped.length > 1 &&
      deduped[deduped.length - 1][0] === deduped[0][0] &&
      deduped[deduped.length - 1][1] === deduped[0][1]) {
    deduped.pop();
  }

  // Remove collinear points
  const cleaned = [];
  for (let i = 0; i < deduped.length; i++) {
    const prev = deduped[(i - 1 + deduped.length) % deduped.length];
    const curr = deduped[i];
    const next = deduped[(i + 1) % deduped.length];
    const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
    if (cross !== 0) {
      cleaned.push(curr);
    }
  }

  return cleaned.length >= 3 ? cleaned : deduped;
}

// ─── Step 9: Douglas-Peucker simplification ─────────────────────────────────

function simplifyPolygon(points, epsilon) {
  if (points.length <= 2) return points.slice();

  // For a closed polygon, find the two most distant points as start/end
  let maxDist = 0;
  let splitA = 0, splitB = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
      if (d > maxDist) {
        maxDist = d;
        splitA = i;
        splitB = j;
      }
    }
  }

  // Split polygon into two chains and simplify each
  const chain1 = [];
  for (let i = splitA; i !== splitB; i = (i + 1) % points.length) {
    chain1.push(points[i]);
  }
  chain1.push(points[splitB]);

  const chain2 = [];
  for (let i = splitB; i !== splitA; i = (i + 1) % points.length) {
    chain2.push(points[i]);
  }
  chain2.push(points[splitA]);

  const s1 = douglasPeucker(chain1, epsilon);
  const s2 = douglasPeucker(chain2, epsilon);

  // Merge, removing duplicate endpoints
  const result = [...s1];
  for (let i = 1; i < s2.length - 1; i++) {
    result.push(s2[i]);
  }

  return result;
}

function douglasPeucker(points, epsilon) {
  if (points.length <= 2) return points.slice();

  // Find point with max distance from line between first and last
  let maxDist = 0;
  let maxIdx = 0;

  const [ax, ay] = points[0];
  const [bx, by] = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = pointToLineDistance(points[i], [ax, ay], [bx, by]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  } else {
    return [points[0], points[points.length - 1]];
  }
}

function pointToLineDistance(point, lineStart, lineEnd) {
  const [px, py] = point;
  const [x1, y1] = lineStart;
  const [x2, y2] = lineEnd;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return Math.hypot(px - x1, py - y1);

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.hypot(px - projX, py - projY);
}

// ─── Step 10: Polygon area (Shoelace formula) ───────────────────────────────

function polygonArea(points) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i][0] * points[j][1];
    area -= points[j][0] * points[i][1];
  }
  return Math.abs(area) / 2;
}

module.exports = { detectCalmRegion };
