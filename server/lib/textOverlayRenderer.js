/**
 * textOverlayRenderer.js — Render story text with gradient background inside a
 * polygon as a transparent PNG. Used for text overlay on children's storybook pages.
 *
 * The same rendered overlay is used for both browser preview and PDF, ensuring
 * pixel-identical results.
 */

const { createCanvas } = require('canvas');
const sharp = require('sharp');
const { getTextZonePolygon } = require('./textMasks');

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
    fontFamily = 'Georgia',
    pageNumber = null,
  } = options;

  // FIXED font size — the printed book must be visually consistent across
  // pages. Same px on every page, regardless of image dimensions or text
  // length. Text never shrinks; only the polygon area grows or contracts.
  const FIXED_FONT_PX = 11;
  const baseFontSize = fontSizeOverride || FIXED_FONT_PX;
  const font = `${fontFamily}, serif`;

  // Polygon-area stages, smallest → largest. Same shape (rectangle for
  // top/bottom-full, right triangle for corners) at increasing scale.
  // Algorithm: find the SMALLEST stage that fits at the fixed font.
  //   - If the text is short, a small contracted polygon hugs it tightly.
  //   - If the text is long, the polygon grows until it fits.
  //   - If even the largest scale won't hold the text, force-render at
  //     the largest with overflow logged (we never reduce the font).
  // 0.65 / 0.8 / 1.0 = "contract" stages. The base (1.0) is the original
  // calm-zone polygon shipped with the empty-scene mask. Anything below 1.0
  // is just the same shape scaled toward its centroid — visually invisible
  // (the polygon isn't drawn), but the text gets packed into a tighter
  // column so short lines don't span the full triangle.
  // 1.15 → 2.5 = "expand" stages. Each is margin-clamped to the safe text
  // box, so we can keep growing without ever crossing into the gutter,
  // bleed, or trim margin.
  const rawBase = (polygon && polygon.length >= 3)
    ? polygon
    : buildFallbackShape(width, height, textPosition);
  const stages = [];
  for (const scale of [0.65, 0.8, 1.0, 1.15, 1.3, 1.55, 1.85, 2.2, 2.5]) {
    const scaled = scale === 1.0 ? rawBase : scalePolygon(rawBase, scale, width, height);
    stages.push({ scale, shape: applyMarginClamp(scaled, pageNumber, width, height) });
  }

  // Measure-only canvas — used to check whether a polygon stage fits the
  // text at our fixed font size, without paying for a full-page render
  // attempt.
  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext('2d');

  const isTop = textPosition.startsWith('top');

  const fitsAtStage = (stage) => {
    // No additional inset — applyMarginClamp already sits the polygon at
    // 5% outer / 4% top-bottom / 10% gutter. Stroke bleed past the polygon
    // edge stays inside the 5% image margin anyway.
    const scanlines = buildScanlineMap(stage, height);
    const ys = stage.map(p => p[1]);
    const polyTop = Math.max(0, Math.min(...ys));
    const polyBottom = Math.min(height, Math.max(...ys));
    const lineHeight = Math.round(baseFontSize * 1.45);
    const minLineWidth = 60;
    measureCtx.font = `${baseFontSize}px ${font}`;
    const paragraphs = text
      .split(/\n+/)
      .map(p => p.trim().split(/\s+/).filter(w => w.length > 0))
      .filter(words => words.length > 0);
    if (paragraphs.length === 0) return { fits: true, placed: 0, total: 0 };
    const total = paragraphs.reduce((s, w) => s + w.length, 0);
    const lines = isTop
      ? wrapLinesTopDown(measureCtx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, baseFontSize, font)
      : wrapLinesBottomUp(measureCtx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, baseFontSize, font);
    const placed = lines.reduce((sum, l) => sum + l.text.split(/\s+/).length, 0);
    return { fits: placed >= total, placed, total };
  };

  // 1. Find the smallest polygon stage that holds the text at the fixed
  //    font. Smallest-first so contraction kicks in for short text and
  //    expansion only triggers when actually needed.
  for (const { scale, shape } of stages) {
    const check = fitsAtStage(shape);
    if (check.fits) {
      const result = renderStage(width, height, text, shape, textPosition, baseFontSize, baseFontSize, font, /*forceOnFinal=*/false);
      console.log(`[TEXT-OVERLAY] Rendered at ${baseFontSize}px, stage ${scale.toFixed(2)}×, pos=${textPosition}, page=${pageNumber}, words=${check.placed}/${check.total}, img=${width}x${height}`);
      return result.buffer;
    }
  }

  // 2. Loud fail — even the 2.5× expanded polygon couldn't hold the text
  //    at the fixed font. Force-render so the PDF pipeline doesn't break,
  //    but log a concrete OVERFLOW so the caller can shorten the page text.
  //    We deliberately never shrink the font here — visual consistency
  //    across pages is the goal.
  const maxStage = stages[stages.length - 1].shape;
  const overflow = fitsAtStage(maxStage);
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  console.error(`[TEXT-OVERLAY] OVERFLOW: position=${textPosition}, page=${pageNumber}, placed=${overflow.placed}/${overflow.total} words at fixed=${baseFontSize}px on max stage (2.5×). Shorten the text. Preview: "${preview}"`);
  const result = renderStage(width, height, text, maxStage, textPosition, baseFontSize, baseFontSize, font, /*forceOnFinal=*/true);
  return result.buffer;
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

  // No textPadding inset — the margin clamp (5%/4%/10%) already keeps the
  // polygon well inside the image edge; an extra 20 px centroid inset just
  // pulled text another ~5 mm away from the outer edge for no benefit.
  const scanlines = buildScanlineMap(clipPath, height);

  let align = 'left';
  if (isFull) align = 'center';
  else if (isRight) align = 'right';

  const ys = clipPath.map(p => p[1]);
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

  // Step 2: Build the text zone from the mask shape we already committed to
  // (rectangle for top-/bottom-full, right-triangle for corners). No detection
  // — the image was generated with this exact mask as a layout hint, so the
  // polygon is predetermined.
  const languageLevel = options.languageLevel || 'standard';
  let polygon = null;
  const calmRegion = null;
  if (VALID_POSITIONS.includes(textPosition)) {
    polygon = getTextZonePolygon(textPosition, languageLevel, width, height);
    if (polygon) {
      console.log(`[TEXT-OVERLAY] Text zone from mask: ${polygon.length} vertices, position ${textPosition}, level ${languageLevel}`);
    }
  }

  // Step 3: Render text-only transparent PNG (no backdrop). Its alpha channel
  // is also the source mask for the frosted halo below.
  const textLayer = renderTextOverlay(width, height, text, polygon, {
    textPosition,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    pageNumber: options.pageNumber,
  });

  // No frosted-glass halo — the text already carries a 0.85-alpha black stroke
  // (~32% of font size in width) drawn underneath the white fill, which
  // gives more legibility on busy backgrounds than a tiny blurred halo
  // ever did. The halo was visibly smudging the image around each letter
  // and adding a "blurry sticker" feel that the printed/shared book
  // shouldn't have.
  const overlayImage = textLayer;

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
 * Clamp every polygon vertex into the safe text box:
 *   • 5% inset from the outer edges (top, bottom, outer-side x)
 *   • 10% inset from the gutter (spine-side x)
 * Odd pages sit on the left side of the spread → gutter on the right. Even
 * pages → gutter on the left. Without a pageNumber (legacy callers) the box
 * is symmetric 5% on every side. Applied to the base polygon AND every
 * scaled escalation stage so growth can't creep back into the spine or trim
 * area.
 */
function applyMarginClamp(polygon, pageNumber, width, height) {
  if (!polygon) return polygon;
  const OUTER = 0.05;
  const GUTTER = 0.10;
  // Bottom/top margin is 4% — we need at least the bleed (~1% of image) clear
  // of the text, but we also don't want text hugging the trim edge. 4% puts the
  // text safely inside the visible page while giving each line an extra couple
  // of pixels to breathe vs the 5% side margin.
  const VERTICAL = 0.04;
  let minX = Math.round(width * OUTER);
  let maxX = Math.round(width * (1 - OUTER));
  const minY = Math.round(height * VERTICAL);
  const maxY = Math.round(height * (1 - VERTICAL));
  if (pageNumber) {
    const isLeftPage = pageNumber % 2 === 1;
    if (isLeftPage) {
      // outer = left (5%), gutter = right (10%)
      maxX = Math.round(width * (1 - GUTTER));
    } else {
      // gutter = left (10%), outer = right (5%)
      minX = Math.round(width * GUTTER);
    }
  }
  return polygon.map(([x, y]) => [
    Math.min(maxX, Math.max(minX, x)),
    Math.min(maxY, Math.max(minY, y)),
  ]);
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

  // Always left-align, but anchor each line to its OWN scan.left (the
  // polygon's left edge at that y) — not a shared polyMinLeft. For left-
  // corner triangles scan.left is ~0 (vertical leg), so every line starts
  // at the same x. For right-corner triangles the left edge IS the
  // hypotenuse, so scan.left grows with y — each successive line indents
  // further right, and the text column takes the triangle's shape. Wrap
  // width already uses each line's scan.left/right, so the right edge is
  // also triangle-respecting.
  ctx.textAlign = 'left';
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
 *
 * `startY` lets the bottom-up wrapper restart wrap at a lower y so each line
 * is packed against the scan width at its FINAL drawn y, not the narrow
 * scan widths at the top of the triangle.
 */
function wrapLinesTopDown(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily, startY) {
  ctx.font = `${fontSize}px ${fontFamily}`;
  const paragraphGap = Math.round(lineHeight * 0.25);
  const lines = [];
  let y = Math.round(startY != null ? startY : polyTop + fontSize);

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

  // insetPolygon moves every vertex toward the centroid, which produces
  // a slanted bottom edge over a few pixels when the two bottom vertices
  // are displaced by different amounts. If we pick lastUsableY right at
  // polyBottom, findScanlineWidth's ±lineHeight*0.3 window ends up
  // straddling that tapered band — bestLeft = MAX(scan.left) then picks
  // the taper's inner x, not the polygon's true left leg. The last line
  // renders far right instead of left-aligned.
  //
  // Find the stable left (minimum scan.left across ALL scanlines in the
  // polygon — the hypotenuse tip for right-anchored triangles, the
  // vertical leg for left-anchored) and only pick y's whose scan.left is
  // close to it. That skips the tapered corner and anchors the last line
  // where the polygon's geometry is regular.
  let stableLeft = Infinity;
  for (const s of scanlines.values()) {
    if (s.left < stableLeft) stableLeft = s.left;
  }
  const STABLE_TOLERANCE = 6;

  let lastUsableY = -1;
  for (let y = polyBottom; y >= polyTop; y -= 1) {
    const exact = scanlines.get(y);
    if (!exact) continue;
    if (exact.left > stableLeft + STABLE_TOLERANCE) continue; // still in taper
    const s = findScanlineWidth(scanlines, y, lineHeight);
    if (s && (s.right - s.left) >= minLineWidth) { lastUsableY = y; break; }
  }
  // Fallback: if we never found a stable-left y (shouldn't happen with the
  // 4%/10% margin clamp, but be defensive), accept any usable y.
  if (lastUsableY < 0) {
    for (let y = polyBottom; y >= polyTop; y -= 1) {
      const s = findScanlineWidth(scanlines, y, lineHeight);
      if (s && (s.right - s.left) >= minLineWidth) { lastUsableY = y; break; }
    }
  }
  if (lastUsableY < 0) return topLines;

  // Pin the last line at lastUsableY. Two coupled unknowns:
  //   N  = final line count after wrap at the bottom widths
  //   sY = startY such that lastLine.y ≈ lastUsableY
  // Iterate: given an N guess, place startY = lastUsableY - (N-1)*lineHeight,
  // re-wrap, observe the resulting line count. If it fits all words in ≤ N
  // lines, converge on the smallest N that fits. If it overflows, grow N.
  //
  // This replaces the old "pack from polyTop then rigid-shift down" which
  // left every line 60-260 px shy of scan.right for right-corner triangles,
  // because lines were packed against the narrow widths near the triangle
  // apex but drawn where the polygon is wide.
  const totalWords = paragraphs.reduce((s, w) => s + w.length, 0);
  let N = topLines.length;
  let lines = topLines;
  for (let iter = 0; iter < 8; iter++) {
    const startY = Math.max(
      Math.round(polyTop + fontSize),
      Math.round(lastUsableY - (N - 1) * lineHeight)
    );
    const rewrapped = wrapLinesTopDown(ctx, paragraphs, polyTop, polyBottom, scanlines, lineHeight, minLineWidth, fontSize, fontFamily, startY);
    if (rewrapped.length === 0) break;
    const placed = rewrapped.reduce((sum, l) => sum + l.text.split(/\s+/).length, 0);
    lines = rewrapped;
    if (placed < totalWords) {
      // Overflow: need more room — grow N (start higher, more lines available).
      N = N + 1;
      continue;
    }
    if (rewrapped.length < N) {
      // Wider widths let text pack into fewer lines. Pin to that count so
      // the last line lands exactly at lastUsableY next iteration.
      N = rewrapped.length;
      continue;
    }
    // Converged: all words placed in exactly N lines, last line at lastUsableY.
    break;
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
