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
 * Compute the overlay rectangle (px, integer) that the renderer will draw
 * the text inside, given the page's textPosition + word count + image size.
 * Mirrors client/src/utils/textOverlay.ts so the server-side legibility
 * check sees the same rectangle the user will see.
 */
function computeOverlayRect(textPosition, words, imgWidth, imgHeight) {
  const size = words < 20 ? 'short' : words < 50 ? 'medium' : 'long';
  const cornerW = size === 'short' ? 0.42 : size === 'medium' ? 0.52 : 0.62;
  const fullH   = size === 'short' ? 0.18 : size === 'medium' ? 0.22 : 0.28;
  const cornerH = size === 'short' ? 0.22 : size === 'medium' ? 0.28 : 0.35;
  let x, y, w, h;
  switch (textPosition) {
    case 'top-left':     x = 0;            y = 0;            w = cornerW; h = cornerH; break;
    case 'top-right':    x = 1 - cornerW;  y = 0;            w = cornerW; h = cornerH; break;
    case 'bottom-left':  x = 0;            y = 1 - cornerH;  w = cornerW; h = cornerH; break;
    case 'bottom-right': x = 1 - cornerW;  y = 1 - cornerH;  w = cornerW; h = cornerH; break;
    case 'top-full':     x = 0;            y = 0;            w = 1;       h = fullH;   break;
    case 'bottom-full':  x = 0;            y = 1 - fullH;    w = 1;       h = fullH;   break;
    default: return null;
  }
  return {
    x: Math.round(x * imgWidth),
    y: Math.round(y * imgHeight),
    w: Math.round(w * imgWidth),
    h: Math.round(h * imgHeight),
  };
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
  computeOverlayRect,
  requiredFontPt,
  countWords,
};
