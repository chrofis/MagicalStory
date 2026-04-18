/**
 * textOverlayRenderer.js — Render story text with gradient background inside a
 * polygon as a transparent PNG. Used for text overlay on children's storybook pages.
 *
 * The same rendered overlay is used for both browser preview and PDF, ensuring
 * pixel-identical results.
 */

const { createCanvas } = require('canvas');
const sharp = require('sharp');
const { detectCalmRegion } = require('./calmRegion');

const VALID_POSITIONS = ['top-left', 'top-right', 'top-full', 'bottom-left', 'bottom-right', 'bottom-full'];

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Render text with gradient background inside a polygon as a transparent PNG.
 *
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {string} text - Story text (UTF-8, may contain German/French characters)
 * @param {number[][]|null} polygon - Array of [x, y] pixel coordinates, or null for rectangular fallback
 * @param {object} [options]
 * @param {string} [options.textPosition='bottom-left'] - Position hint for fallback rectangle and alignment
 * @param {number} [options.fontSize] - Override font size (default: auto from image height)
 * @param {string} [options.fontFamily='Georgia'] - Override font family
 * @returns {Buffer} Transparent PNG buffer
 */
function renderTextOverlay(width, height, text, polygon, options = {}) {
  const {
    textPosition = 'bottom-left',
    fontSize: fontSizeOverride,
    fontFamily = 'Georgia'
  } = options;

  const baseFontSize = fontSizeOverride || Math.round(height * 0.018);
  const minFontSize = Math.max(10, Math.round(baseFontSize * 0.6));
  const font = `${fontFamily}, serif`;

  // Escalation stages — if text doesn't fit in the current region, grow the
  // region anchored to the text corner and try again. Stage 0 is the detected
  // calm region (or default fallback rect). Later stages are progressively
  // larger rectangles so the full text always has somewhere to go.
  const stages = [polygon || buildFallbackRect(width, height, textPosition)];
  for (let i = 1; i <= 4; i++) {
    stages.push(buildExpandedRect(width, height, textPosition, i));
  }

  let lastResult = null;
  for (let s = 0; s < stages.length; s++) {
    const isFinalStage = s === stages.length - 1;
    const result = renderStage(width, height, text, stages[s], textPosition, baseFontSize, minFontSize, font, isFinalStage);
    lastResult = result;
    if (result.fits) {
      console.log(`[TEXT-OVERLAY] Rendered at ${result.fontSize}px, ${stages[s].length} vertices, position ${textPosition}, stage ${s}/${stages.length - 1}`);
      return result.buffer;
    }
  }

  console.log(`[TEXT-OVERLAY] Rendered at ${lastResult.fontSize}px (force at max stage), position ${textPosition}`);
  return lastResult.buffer;
}

/**
 * Render one stage: given a clipPath, try shrinking font to fit, return the
 * canvas buffer plus whether text fully fit.
 * @param {boolean} forceOnFinal - If true, force render at min font even on overflow
 *   (used for the biggest stage so we always return something).
 */
function renderStage(width, height, text, clipPath, textPosition, baseFontSize, minFontSize, font, forceOnFinal) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left') || textPosition.includes('full');
  const isFull = textPosition.includes('full');
  const isRight = textPosition.includes('right');

  // No backdrop gradient — the baked blur under the text is enough.
  // The polygon still drives text placement (insetPolygon below).

  const textPadding = 20;
  const insetPoly = insetPolygon(clipPath, textPadding);
  const scanlines = buildScanlineMap(insetPoly, height);

  let align = 'left';
  if (isFull) align = 'center';
  else if (isRight) align = 'right';

  const ys = insetPoly.map(p => p[1]);
  const polyTop = Math.max(0, Math.min(...ys));
  const polyBottom = Math.min(height, Math.max(...ys));

  let renderedFontSize = baseFontSize;
  let fits = false;

  for (let fs = baseFontSize; fs >= minFontSize; fs -= 1) {
    if (tryRenderText(ctx, text, scanlines, fs, font, align, polyTop, polyBottom, isTop, width)) {
      renderedFontSize = fs;
      fits = true;
      break;
    }
  }

  if (!fits && forceOnFinal) {
    tryRenderText(ctx, text, scanlines, minFontSize, font, align, polyTop, polyBottom, isTop, width, true);
    renderedFontSize = minFontSize;
  }

  return { buffer: canvas.toBuffer('image/png'), fits, fontSize: renderedFontSize };
}

/**
 * Progressive rectangle expansion anchored to the text corner.
 * Stage N grows wider and taller so longer text always has somewhere to fit.
 */
function buildExpandedRect(width, height, textPosition, stage) {
  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left');
  const isFull = textPosition.includes('full');

  // Stage 1..4 — progressively larger. Stage 4 covers most of the image as
  // last-resort so extra-long text has room.
  const heightRatios = [0.38, 0.50, 0.62, 0.75];
  const widthRatios = [0.60, 0.72, 0.85, 0.95];
  const fullRatios = [0.30, 0.42, 0.55, 0.70];

  const idx = Math.min(Math.max(stage - 1, 0), 3);
  const hr = heightRatios[idx];
  const wr = widthRatios[idx];
  const fr = fullRatios[idx];

  let rw, rh, rx, ry;
  if (isFull) {
    rw = width;
    rh = Math.round(height * fr);
    rx = 0;
    ry = isTop ? 0 : height - rh;
  } else {
    rw = Math.round(width * wr);
    rh = Math.round(height * hr);
    rx = isLeft ? 0 : width - rw;
    ry = isTop ? 0 : height - rh;
  }

  return [
    [rx, ry],
    [rx + rw, ry],
    [rx + rw, ry + rh],
    [rx, ry + rh]
  ];
}

/**
 * High-level: detect calm region, render overlay, and composite onto image.
 *
 * @param {Buffer} imageBuffer - Page image buffer (JPEG or PNG)
 * @param {string} text - Story text
 * @param {string} textPosition - 'top-left', 'bottom-right', etc.
 * @param {object} [options]
 * @param {string} [options.languageLevel] - '1st-grade' | 'standard' | 'advanced'
 * @param {number} [options.fontSize] - Override font size
 * @param {string} [options.fontFamily] - Override font family
 * @returns {Promise<{overlayImage: Buffer, compositedImage: Buffer, polygon: number[][]|null, calmRegion: object|null}>}
 */
async function generateTextOverlay(imageBuffer, text, textPosition, options = {}) {
  // Step 1: Get image dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;
  console.log(`[TEXT-OVERLAY] Image ${width}x${height}, position ${textPosition}`);

  // Step 2: Detect calm region
  let calmRegion = null;
  let polygon = null;

  if (VALID_POSITIONS.includes(textPosition)) {
    calmRegion = await detectCalmRegion(imageBuffer, textPosition);
    if (calmRegion) {
      polygon = calmRegion.polygon;
      console.log(`[TEXT-OVERLAY] Calm region: ${polygon.length} vertices, ${(calmRegion.areaFraction * 100).toFixed(1)}% area`);
    } else {
      console.log('[TEXT-OVERLAY] No calm region found, using rectangular fallback');
    }
  }

  // Step 3: Render overlay
  const overlayImage = renderTextOverlay(width, height, text, polygon, {
    textPosition,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily
  });

  // Step 4: Composite overlay onto image
  const compositedImage = await sharp(imageBuffer)
    .composite([{ input: overlayImage }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    overlayImage,
    compositedImage,
    polygon,
    calmRegion
  };
}

// ─── Clipping & gradient ───────────────────────────────────────────────────────

/**
 * Build a fallback rectangle when no polygon is detected.
 * Returns array of [x, y] corner points.
 */
function buildFallbackRect(width, height, textPosition) {
  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left');
  const isFull = textPosition.includes('full');

  let rw, rh, rx, ry;

  if (isFull) {
    rw = width;
    rh = Math.round(height * 0.22);
    rx = 0;
    ry = isTop ? 0 : height - rh;
  } else {
    rw = Math.round(width * 0.52);
    rh = Math.round(height * 0.28);
    rx = isLeft ? 0 : width - rw;
    ry = isTop ? 0 : height - rh;
  }

  return [
    [rx, ry],
    [rx + rw, ry],
    [rx + rw, ry + rh],
    [rx, ry + rh]
  ];
}

/**
 * Apply a polygon as a clipping path on the canvas context.
 */
function applyClipPath(ctx, polygon) {
  ctx.beginPath();
  ctx.moveTo(polygon[0][0], polygon[0][1]);
  for (let i = 1; i < polygon.length; i++) {
    ctx.lineTo(polygon[i][0], polygon[i][1]);
  }
  ctx.closePath();
  ctx.clip();
}

/**
 * Draw gradient fill inside the current clip region.
 * Corner positions use a diagonal linear gradient from the corner.
 * Full-width positions use a vertical linear gradient from the edge.
 */
function drawGradient(ctx, polygon, width, height, isTop, isLeft, isRight, isFull) {
  // Compute polygon bounding box
  const xs = polygon.map(p => p[0]);
  const ys = polygon.map(p => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  let grad;

  if (isFull) {
    // Full-width: vertical gradient from the text edge
    const y1 = isTop ? minY : maxY;
    const y2 = isTop ? maxY : minY;
    grad = ctx.createLinearGradient(minX, y1, minX, y2);
  } else {
    // Corner: diagonal gradient from the corner toward the opposite corner
    const x1 = isLeft ? minX : maxX;
    const y1 = isTop ? minY : maxY;
    const x2 = isLeft ? maxX : minX;
    const y2 = isTop ? maxY : minY;
    grad = ctx.createLinearGradient(x1, y1, x2, y2);
  }

  // Dark gradient for white text — darkens the zone so the fill pops.
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
  grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.3)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');

  ctx.fillStyle = grad;
  // Fill a large rect — the clip will constrain it to the polygon
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
}

// ─── Polygon inset ─────────────────────────────────────────────────────────────

/**
 * Shrink a polygon inward by `inset` pixels.
 * Uses simple vertex offset toward the polygon centroid.
 */
function insetPolygon(polygon, inset) {
  if (polygon.length < 3) return polygon;

  // Compute centroid
  let cx = 0, cy = 0;
  for (const [x, y] of polygon) {
    cx += x;
    cy += y;
  }
  cx /= polygon.length;
  cy /= polygon.length;

  return polygon.map(([x, y]) => {
    const dx = cx - x;
    const dy = cy - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return [x, y];
    const ratio = inset / dist;
    return [
      Math.round(x + dx * ratio),
      Math.round(y + dy * ratio)
    ];
  });
}

// ─── Scanline map ──────────────────────────────────────────────────────────────

/**
 * For each y pixel, find the leftmost and rightmost x inside the polygon.
 * Uses ray-casting (horizontal line intersection with polygon edges).
 *
 * @param {number[][]} polygon - Array of [x, y] vertices
 * @param {number} imageHeight - Image height (limits scanning range)
 * @returns {Map<number, {left: number, right: number}>} Map from y to {left, right}
 */
function buildScanlineMap(polygon, imageHeight) {
  const ys = polygon.map(p => p[1]);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(imageHeight - 1, Math.ceil(Math.max(...ys)));

  const map = new Map();

  for (let y = minY; y <= maxY; y++) {
    // Find all x intersections of horizontal line y with polygon edges
    const intersections = [];
    const n = polygon.length;

    for (let i = 0; i < n; i++) {
      const [x1, y1] = polygon[i];
      const [x2, y2] = polygon[(i + 1) % n];

      // Skip horizontal edges
      if (y1 === y2) continue;

      // Check if y is within this edge's y range
      if ((y < Math.min(y1, y2)) || (y >= Math.max(y1, y2))) continue;

      // Compute x intersection
      const t = (y - y1) / (y2 - y1);
      const x = x1 + t * (x2 - x1);
      intersections.push(x);
    }

    if (intersections.length >= 2) {
      intersections.sort((a, b) => a - b);
      map.set(y, {
        left: Math.ceil(intersections[0]),
        right: Math.floor(intersections[intersections.length - 1])
      });
    }
  }

  return map;
}

// ─── Text rendering ────────────────────────────────────────────────────────────

/**
 * Try to render text inside the polygon scanline map at the given font size.
 * Returns true if all text fits, false if it overflows.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {Map} scanlines - Scanline map from buildScanlineMap
 * @param {number} fontSize
 * @param {string} fontFamily
 * @param {string} align - 'left', 'right', or 'center'
 * @param {number} polyTop - Top y of the inset polygon
 * @param {number} polyBottom - Bottom y of the inset polygon
 * @param {boolean} isTop - Whether text starts from top
 * @param {number} canvasWidth - Canvas width for right-align
 * @param {boolean} [force=false] - Render even if text doesn't fit
 * @returns {boolean} Whether all text fit within the polygon
 */
function tryRenderText(ctx, text, scanlines, fontSize, fontFamily, align, polyTop, polyBottom, isTop, canvasWidth, force = false) {
  const lineHeight = Math.round(fontSize * 1.45);
  const minLineWidth = 60;

  ctx.font = `${fontSize}px ${fontFamily}`;

  // Word-wrap text line by line within the polygon
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;

  // Generate y positions from top of polygon downward
  const yPositions = [];
  for (let y = Math.round(polyTop + fontSize); y <= polyBottom; y += lineHeight) {
    yPositions.push(y);
  }

  // For bottom positions, lay out lines bottom-up: use positions from the end
  // and reverse-wrap the words so text anchors to the bottom edge.
  let lines;
  if (!isTop) {
    lines = wrapLinesBottomUp(ctx, words, yPositions, scanlines, lineHeight, minLineWidth, fontSize, fontFamily);
  } else {
    lines = wrapLinesTopDown(ctx, words, yPositions, scanlines, lineHeight, minLineWidth, fontSize, fontFamily);
  }

  // Check if all words were placed
  const totalWords = words.length;
  const placedWords = lines.reduce((sum, l) => sum + l.text.split(/\s+/).length, 0);
  const allFit = placedWords >= totalWords;
  if (!allFit && !force) return false;

  // Draw the text lines
  for (const line of lines) {
    const availableWidth = line.right - line.left;
    let drawX;

    if (align === 'center') {
      drawX = line.left + (availableWidth - line.width) / 2;
    } else if (align === 'right') {
      drawX = line.right - line.width;
    } else {
      drawX = line.left;
    }

    // White text with a dark glyph-stroke — paint-order: stroke fill.
    // Works on any background: the dark outline gives contrast on light areas,
    // the white fill gives contrast on dark areas.
    ctx.save();
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2.5, fontSize * 0.32);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeText(line.text, drawX, line.y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line.text, drawX, line.y);
    ctx.restore();
  }

  return allFit;
}

/**
 * Wrap words top-down: fill lines from the top of the polygon downward.
 */
function wrapLinesTopDown(ctx, words, yPositions, scanlines, lineHeight, minLineWidth, fontSize, fontFamily) {
  const lines = [];
  let wordIdx = 0;

  ctx.font = `${fontSize}px ${fontFamily}`;

  for (const y of yPositions) {
    if (wordIdx >= words.length) break;

    const scan = findScanlineWidth(scanlines, y, lineHeight);
    if (!scan || (scan.right - scan.left) < minLineWidth) continue;

    const availableWidth = scan.right - scan.left;
    let lineText = '';
    let lineWidth = 0;

    while (wordIdx < words.length) {
      const testWord = lineText ? lineText + ' ' + words[wordIdx] : words[wordIdx];
      const testWidth = ctx.measureText(testWord).width;
      if (testWidth > availableWidth && lineText) break;
      lineText = testWord;
      lineWidth = testWidth;
      wordIdx++;
    }

    if (lineText) {
      lines.push({ text: lineText, y, left: scan.left, right: scan.right, width: lineWidth });
    }
  }

  return lines;
}

/**
 * Wrap words bottom-up: anchor text to the bottom of the polygon.
 * First estimate how many lines we need, then place them from the bottom.
 */
function wrapLinesBottomUp(ctx, words, yPositions, scanlines, lineHeight, minLineWidth, fontSize, fontFamily) {
  ctx.font = `${fontSize}px ${fontFamily}`;

  // First pass top-down to figure out how many lines we need
  const tempLines = [];
  let wordIdx = 0;

  for (const y of yPositions) {
    if (wordIdx >= words.length) break;

    const scan = findScanlineWidth(scanlines, y, lineHeight);
    if (!scan || (scan.right - scan.left) < minLineWidth) continue;

    const availableWidth = scan.right - scan.left;
    let lineText = '';

    while (wordIdx < words.length) {
      const testWord = lineText ? lineText + ' ' + words[wordIdx] : words[wordIdx];
      const testWidth = ctx.measureText(testWord).width;
      if (testWidth > availableWidth && lineText) break;
      lineText = testWord;
      wordIdx++;
    }

    if (lineText) tempLines.push(lineText);
  }

  const linesNeeded = tempLines.length;

  // Use the last N y-positions from the available slots
  // Filter yPositions to only those with sufficient scanline width
  const usablePositions = yPositions.filter(y => {
    const scan = findScanlineWidth(scanlines, y, lineHeight);
    return scan && (scan.right - scan.left) >= minLineWidth;
  });

  const startIdx = Math.max(0, usablePositions.length - linesNeeded);
  const bottomPositions = usablePositions.slice(startIdx);

  // Re-wrap at the actual bottom y positions (widths may differ)
  const lines = [];
  wordIdx = 0;

  for (const y of bottomPositions) {
    if (wordIdx >= words.length) break;

    const scan = findScanlineWidth(scanlines, y, lineHeight);
    if (!scan || (scan.right - scan.left) < minLineWidth) continue;

    const availableWidth = scan.right - scan.left;
    let lineText = '';
    let lineWidth = 0;

    while (wordIdx < words.length) {
      const testWord = lineText ? lineText + ' ' + words[wordIdx] : words[wordIdx];
      const testWidth = ctx.measureText(testWord).width;
      if (testWidth > availableWidth && lineText) break;
      lineText = testWord;
      lineWidth = testWidth;
      wordIdx++;
    }

    if (lineText) {
      lines.push({ text: lineText, y, left: scan.left, right: scan.right, width: lineWidth });
    }
  }

  return lines;
}

/**
 * Find the scanline width at a given y, checking a few rows around it
 * for the narrowest point (accounts for line height).
 */
function findScanlineWidth(scanlines, y, lineHeight) {
  let bestLeft = -Infinity;
  let bestRight = Infinity;
  let found = false;

  // Check the y range that the line occupies
  const checkY = Math.round(y);
  for (let dy = -Math.round(lineHeight * 0.3); dy <= Math.round(lineHeight * 0.3); dy++) {
    const scan = scanlines.get(checkY + dy);
    if (scan) {
      found = true;
      if (scan.left > bestLeft) bestLeft = scan.left;
      if (scan.right < bestRight) bestRight = scan.right;
    }
  }

  if (!found) return null;
  if (bestRight <= bestLeft) return null;

  return { left: bestLeft, right: bestRight };
}

module.exports = { renderTextOverlay, generateTextOverlay };
