/**
 * Text-region coverage thresholds + repair budget.
 *
 * The page text is overlaid onto the illustration on a calm/light area
 * detected after generation. If that calm area is too small for the actual
 * text, we run a repair pass that asks the model to move characters out of
 * the white mask region.
 *
 * All tunable numbers live here so editing behavior is a one-file change.
 */

// Coverage thresholds ──────────────────────────────────────────────────────────
const TEXT_COVERAGE = {
  // Hard floor — even a 1-word caption needs this much calm area.
  floorPct: 5,
  // Hard cap — above this the page layout itself is wrong, not the image.
  capPct: 35,
  // Per-word area requirement (% of image) by font size.
  // Derived from A4 portrait, Helvetica, with ~50% typographic overhead
  // (leading, line-end whitespace, padding so text doesn't hug a busy edge).
  perWordPct: {
    14: 0.25, // 1st-grade
    12: 0.18, // standard / advanced
    10: 0.14, // fallback if font auto-shrank
  },
  defaultPerWordPct: 0.18,
};

// Geometric per-word pixel² requirement (Helvetica, average ≈ 5.5 chars per
// word, with 1.5× overhead for line breaks, padding, and end-of-line slack).
//   font_height = pt × 96/72   (image rasters at 96dpi-equivalent)
//   char_width  ≈ pt × 0.55    (Helvetica regular)
//   line_height ≈ font_height × 1.18
//   px²/word    = chars × char_width × line_height × 1.5
const PIXELS_PER_WORD = {
  14: 14 * 0.55 * (14 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 1399 px²
  12: 12 * 0.55 * (12 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 1028 px²
  10: 10 * 0.55 * (10 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 714 px²
};
const DEFAULT_PIXELS_PER_WORD = PIXELS_PER_WORD[12];

// Repair budget ────────────────────────────────────────────────────────────────
const REPAIR = {
  // Max repair attempts on top of the original. The best-by-coverage version
  // wins, even if every attempt fell below the required threshold.
  maxRetries: 2,
};

// Helpers ──────────────────────────────────────────────────────────────────────

/** Required calm-area coverage (%) for a page with this many words. */
function requiredTextCoveragePct(words, fontPt) {
  const { floorPct, capPct, perWordPct, defaultPerWordPct } = TEXT_COVERAGE;
  const k = perWordPct[fontPt] ?? defaultPerWordPct;
  const raw = (words || 0) * k;
  return Math.min(capPct, Math.max(floorPct, raw));
}

/**
 * Required calm pixel² to fit `words` of text rendered at `fontPt`.
 * Geometric — derived from font metrics + a 1.5× overhead for line breaks
 * and padding. Caller can compare directly against pixel counts measured
 * inside the overlay rectangle.
 */
function requiredTextPixels(words, fontPt) {
  const k = PIXELS_PER_WORD[fontPt] ?? DEFAULT_PIXELS_PER_WORD;
  return Math.round((words || 0) * k);
}

/**
 * Compute the overlay polygon (px, integer vertices) that the production
 * text renderer (server/lib/textOverlayRenderer.js → getTextZonePolygon)
 * will actually draw the text inside, given textPosition + langLevel +
 * image size.
 *
 * Corner positions are RIGHT TRIANGLES (not rectangles): the right angle
 * sits at the corner of the frame and the hypotenuse cuts diagonally into
 * the scene. Full-width positions are rectangles. Size buckets are driven
 * by langLevel (1st-grade → 'small' 10%, standard → 'medium' 25%,
 * advanced → 'large' 40% of image area), NOT by word count — this matches
 * the production rendering path.
 *
 * Returns an array of [x, y] vertices, or null on unknown textPosition.
 *
 * Mirrors getTextZonePolygon in server/lib/textMasks.js exactly. Kept
 * here (and not just imported) so the config layer has no dependency on
 * lib/.
 */
const SIZE_FRACTION = { small: 0.10, medium: 0.25, large: 0.40 };
const CORNER_WIDTH_FACTOR = 0.75;

function computeOverlayPolygon(textPosition, languageLevel, imgWidth, imgHeight) {
  if (!textPosition || !imgWidth || !imgHeight) return null;
  const sizeName = languageLevel === '1st-grade' ? 'small'
    : languageLevel === 'advanced' ? 'large'
    : 'medium';
  const areaPct = SIZE_FRACTION[sizeName] ?? SIZE_FRACTION.medium;

  const isFull = textPosition.includes('full');
  const isTop = textPosition.startsWith('top');
  const isLeft = textPosition.includes('left');

  if (isFull) {
    const rectH = Math.round(imgHeight * areaPct);
    const y = isTop ? 0 : imgHeight - rectH;
    return [[0, y], [imgWidth, y], [imgWidth, y + rectH], [0, y + rectH]];
  }
  if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(textPosition)) return null;

  const scale = Math.sqrt(2 * areaPct);
  const legW = Math.round(imgWidth * scale * CORNER_WIDTH_FACTOR);
  const legH = Math.round(imgHeight * scale);
  const cx = isLeft ? 0 : imgWidth;
  const cy = isTop ? 0 : imgHeight;
  const ax = isLeft ? legW : imgWidth - legW;
  const ay = cy;
  const bx = cx;
  const by = isTop ? legH : imgHeight - legH;
  return [[cx, cy], [ax, ay], [bx, by]];
}

/**
 * Polygon area in pixels² (signed Shoelace; absolute value returned).
 * Used to size the legibility budget against what the renderer will draw.
 */
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

/** Font size the PDF renderer starts at for a given language level. */
function requiredFontPt(languageLevel) {
  return languageLevel === '1st-grade' ? 14 : 12;
}

/** Count printable words in a page's text string. */
function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

module.exports = {
  TEXT_COVERAGE,
  PIXELS_PER_WORD,
  REPAIR,
  requiredTextCoveragePct,
  requiredTextPixels,
  computeOverlayPolygon,
  polygonArea,
  requiredFontPt,
  countWords,
};
