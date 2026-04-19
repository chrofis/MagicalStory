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

  // Print-book target: ~12pt on A4. At our A4-normalized canvas (height 1365
  // ≈ 297 mm × ~4.6 px/mm), 12 pt ≈ 4.2 mm ≈ ~19 px. Going a touch lower
  // (0.012 * height ≈ 16 px ≈ 10 pt) so the preview matches what the printed
  // book actually looks like.
  const baseFontSize = fontSizeOverride || Math.round(height * 0.012);
  const minFontSize = Math.max(8, Math.round(baseFontSize * 0.6));
  const font = `${fontFamily}, serif`;

  // Escalation stages — if text doesn't fit, *grow the polygon* instead of
  // switching to a corner box. Stage 0 = the detected calm polygon (or a
  // shape-appropriate fallback: a band for top-full/bottom-full, a triangle
  // for corners). Stages 1-4 scale that same shape outward from its centroid
  // so the text area always follows the calm-region contour.
  const baseShape = (polygon && polygon.length >= 3)
    ? polygon
    : buildFallbackShape(width, height, textPosition);
  const stages = [baseShape];
  for (const scale of [1.15, 1.3, 1.55, 1.85]) {
    stages.push(scalePolygon(baseShape, scale, width, height));
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
function renderStage(width, height, text, clipPath, textPosition, baseFontSize, _minFontSize, font, forceOnFinal) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const isTop = textPosition.startsWith('top');
  const isFull = textPosition.includes('full');
  const isRight = textPosition.includes('right');

  const textPadding = 20;
  const insetPoly = insetPolygon(clipPath, textPadding);
  const scanlines = buildScanlineMap(insetPoly, height);

  let align = 'left';
  if (isFull) align = 'center';
  else if (isRight) align = 'right';

  const ys = insetPoly.map(p => p[1]);
  const polyTop = Math.max(0, Math.min(...ys));
  const polyBottom = Math.min(height, Math.max(...ys));

  // Font size is FIXED across all pages — never shrink. If the text doesn't
  // fit this region, the caller escalates to a larger rectangle (stages 1-4
  // in renderTextOverlay). Only the final forced stage draws if still
  // doesn't fit.
  const fits = tryRenderText(ctx, text, scanlines, baseFontSize, font, align, polyTop, polyBottom, isTop, width, !!forceOnFinal);

  return { buffer: canvas.toBuffer('image/png'), fits, fontSize: baseFontSize };
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

  // Step 3: Render text-only transparent PNG (no backdrop). Its alpha channel
  // is also the source mask for the frosted halo below.
  const textLayer = renderTextOverlay(width, height, text, polygon, {
    textPosition,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily
  });

  // Step 4: Build a tight frosted-glass halo AROUND the glyphs (not the whole
  // calm polygon). Blurred image pixels show through only where the glyph
  // mask dilated by ~2% of the image extends — so the halo is local to the
  // text, not a big washed area.
  const blurLayer = await buildBlurLayer(imageBuffer, textLayer, width, height);

  // Step 5: Stack halo → text into a single overlay PNG.
  const overlayImage = await sharp(blurLayer)
    .composite([{ input: textLayer }])
    .png()
    .toBuffer();

  // Step 6: Provide a fully-composited image for the PDF path.
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

/**
 * Build a PNG where a small halo *around the text glyphs* contains blurred
 * image pixels and everything else is fully transparent. Not the whole calm
 * area — just ~2% of the min image dimension beyond each glyph. That keeps
 * the frosted effect local to the text.
 */
async function buildBlurLayer(imageBuffer, textPng, width, height) {
  // Tight halo — the frosted area extends ~dilatePx beyond each glyph, period.
  // Anything past that stays original (no blur leak).
  const dilatePx = 5;    // how far the halo extends beyond glyph edges
  const featherPx = 2;   // soft fade at the halo edge
  const imageBlurSigma = 4; // subtle blur of the image under the halo

  // 1) Alpha channel of the rendered text — shape of the glyphs + stroke.
  //    extractChannel + toColourspace('b-w') forces a single-channel output so
  //    downstream blur can't silently upconvert to RGB (which would scramble
  //    our pixel-index math later).
  const textAlpha = await sharp(textPng)
    .extractChannel('alpha')
    .toColourspace('b-w')
    .raw()
    .toBuffer();

  // 2) Dilate by blurring then thresholding to a hard binary mask — this
  //    grows the glyph shape by ~dilatePx without smearing alpha outward.
  //    toColourspace('b-w') again: sharp's blur on a 1-channel raw input
  //    can re-expand to 3 channels; force single-channel back.
  const spread = await sharp(textAlpha, { raw: { width, height, channels: 1 } })
    .blur(dilatePx)
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  if (spread.length !== width * height) {
    throw new Error(`spread buffer wrong size: got ${spread.length}, expected ${width * height}`);
  }
  const binary = Buffer.alloc(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = spread[i] > 20 ? 255 : 0;

  // 3) Feather the hard edges so the halo fades smoothly into the original,
  //    then hard-clamp any sub-visible alpha (< 8) to 0.
  const haloMaskRaw = await sharp(binary, { raw: { width, height, channels: 1 } })
    .blur(featherPx)
    .toColourspace('b-w')
    .raw()
    .toBuffer();
  if (haloMaskRaw.length !== width * height) {
    throw new Error(`haloMask buffer wrong size: got ${haloMaskRaw.length}, expected ${width * height}`);
  }
  const haloMask = Buffer.from(haloMaskRaw);
  for (let i = 0; i < haloMask.length; i++) {
    if (haloMask[i] < 8) haloMask[i] = 0;
  }

  // 4) Compute halo bbox so we only touch pixels that will actually be
  //    shown. Guarantees no blur can leak outside the halo — the rest of
  //    the canvas is left fully transparent with zeroed RGB.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (haloMask[row + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const rgba = Buffer.alloc(width * height * 4); // zero-initialised
  if (maxX < minX || maxY < minY) {
    // No halo (no text) — fully transparent overlay
    for (let i = 0; i < width * height; i++) rgba[i * 4 + 3] = haloMask[i];
    return await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  }

  // Pad bbox by imageBlurSigma*2 so the edge pixels of the crop see correct
  // neighbours when blurred (avoids darkening at the crop border).
  const pad = Math.ceil(imageBlurSigma * 2);
  const cropX = Math.max(0, minX - pad);
  const cropY = Math.max(0, minY - pad);
  const cropW = Math.min(width - cropX, maxX - minX + 1 + pad * 2);
  const cropH = Math.min(height - cropY, maxY - minY + 1 + pad * 2);

  // 5) Blur ONLY the bbox crop — not the whole image
  const blurCrop = await sharp(imageBuffer)
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .blur(imageBlurSigma)
    .removeAlpha()
    .raw()
    .toBuffer();

  // 6) Stamp blurred crop pixels into the RGBA buffer only where halo > 0
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const idx = y * width + x;
      const a = haloMask[idx];
      if (a === 0) continue;
      const cIdx = ((y - cropY) * cropW + (x - cropX)) * 3;
      const oIdx = idx * 4;
      rgba[oIdx] = blurCrop[cIdx];
      rgba[oIdx + 1] = blurCrop[cIdx + 1];
      rgba[oIdx + 2] = blurCrop[cIdx + 2];
      rgba[oIdx + 3] = a;
    }
  }
  return await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
}

// ─── Clipping & gradient ───────────────────────────────────────────────────────

/**
 * Fallback shape when no calm polygon was detected. Matches the requested
 * textPosition semantics:
 *   - top-full / bottom-full  → a horizontal band across that half
 *   - corner positions        → a right triangle hugging that corner
 * Never a box in the corner — corners are always triangular so the diagonal
 * flows with the scene's negative space.
 */
function buildFallbackShape(width, height, textPosition) {
  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left');
  const isFull = textPosition.includes('full');

  if (isFull) {
    const bandH = Math.round(height * 0.28);
    if (isTop) return [[0, 0], [width, 0], [width, bandH], [0, bandH]];
    return [[0, height - bandH], [width, height - bandH], [width, height], [0, height]];
  }

  // Right-triangle hugging the chosen corner. "size" is how far the triangle
  // extends along each edge (fraction of width / height).
  const size = 0.62;
  const w = width, h = height;
  if (isTop && isLeft)   return [[0, 0], [w * size, 0], [0, h * size]];
  if (isTop && !isLeft)  return [[w, 0], [w * (1 - size), 0], [w, h * size]];
  if (!isTop && isLeft)  return [[0, h], [w * size, h], [0, h * (1 - size)]];
  return [[w, h], [w * (1 - size), h], [w, h * (1 - size)]];
}

/**
 * Scale a polygon outward from its centroid by `scale`, clamped to image
 * bounds. Used to grow the calm-region polygon instead of falling back to a
 * hard-coded rectangle when text doesn't fit.
 */
function scalePolygon(polygon, scale, width, height) {
  let cx = 0, cy = 0;
  for (const [x, y] of polygon) { cx += x; cy += y; }
  cx /= polygon.length;
  cy /= polygon.length;
  return polygon.map(([x, y]) => [
    Math.max(0, Math.min(width, cx + scale * (x - cx))),
    Math.max(0, Math.min(height, cy + scale * (y - cy)))
  ]);
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
function tryRenderText(ctx, text, scanlines, fontSize, fontFamily, _align, polyTop, polyBottom, isTop, canvasWidth, force = false) {
  const lineHeight = Math.round(fontSize * 1.45);
  const minLineWidth = 60;

  ctx.font = `${fontSize}px ${fontFamily}`;

  // Split into paragraphs on any run of newlines, then into words per paragraph.
  const paragraphs = text
    .split(/\n+/)
    .map(p => p.trim().split(/\s+/).filter(w => w.length > 0))
    .filter(words => words.length > 0);
  if (paragraphs.length === 0) return true;
  const totalWords = paragraphs.reduce((s, w) => s + w.length, 0);

  // For bottom positions, lay out lines bottom-up (anchor to bottom of polygon).
  let lines;
  if (!isTop) {
    lines = wrapLinesBottomUp(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily);
  } else {
    lines = wrapLinesTopDown(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily);
  }

  const placedWords = lines.reduce((sum, l) => sum + l.text.split(/\s+/).length, 0);
  const allFit = placedWords >= totalWords;
  if (!allFit && !force) return false;

  // Always left-aligned — easier to read than centre/right on varying polygon widths.
  for (const line of lines) {
    const drawX = line.left;

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
 * Wrap paragraphs top-down. Uses a continuous y cursor so paragraph breaks
 * can be half a line instead of a full one.
 */
function wrapLinesTopDown(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily) {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const paragraphGap = Math.round(lineHeight * 0.5);
  const lines = [];
  let y = Math.round(polyTop + fontSize);

  for (let p = 0; p < paragraphs.length; p++) {
    const words = paragraphs[p];
    let wordIdx = 0;

    while (wordIdx < words.length && y <= polyBottom) {
      const scan = findScanlineWidth(scanlines, y, lineHeight);
      if (!scan || (scan.right - scan.left) < minLineWidth) {
        y += lineHeight;
        continue;
      }
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
      y += lineHeight;
    }
    if (p < paragraphs.length - 1) y += paragraphGap;
  }

  return lines;
}

/**
 * Wrap paragraphs bottom-up: anchor text to the bottom of the polygon,
 * preserving paragraph spacing. Runs the top-down packer first to get the
 * line layout, then shifts every line down by the delta between the last
 * yPosition and the last used yPosition.
 */
function wrapLinesBottomUp(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily) {
  const topLines = wrapLinesTopDown(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily);
  if (topLines.length === 0) return topLines;

  // Find the last y inside the polygon with usable width; shift every line
  // down so the last drawn line sits at that y, preserving paragraph gaps.
  let lastUsableY = -1;
  for (let y = polyBottom; y >= polyTop; y -= 1) {
    const s = findScanlineWidth(scanlines, y, lineHeight);
    if (s && (s.right - s.left) >= minLineWidth) { lastUsableY = y; break; }
  }
  if (lastUsableY < 0) return topLines;

  const lastDrawnY = topLines[topLines.length - 1].y;
  const delta = lastUsableY - lastDrawnY;
  if (delta <= 0) return topLines;

  return topLines.map(l => {
    const newY = l.y + delta;
    const scan = findScanlineWidth(scanlines, newY, lineHeight);
    return scan
      ? { ...l, y: newY, left: scan.left, right: scan.right }
      : { ...l, y: newY };
  });
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
