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
  REPAIR,
  requiredTextCoveragePct,
  requiredFontPt,
  countWords,
};
