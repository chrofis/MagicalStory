/**
 * Text-region pixel budget + repair budget.
 *
 * Story text is overlaid onto the illustration on a calm area whose shape
 * comes from `getTextZonePolygon` (server/lib/textMasks.js). After
 * generation we count calm pixels INSIDE that polygon and require at
 * least `requiredTextPixels(words, fontPt)` of them. If not, the page is
 * re-rolled with the textAreaMask hint until either the budget is met
 * or the retry budget runs out.
 *
 * One source of truth: the polygon shape lives in textMasks.js next to
 * the renderer that actually draws into it. This file just owns the
 * pixel-budget formulas and the retry budget.
 */

// Geometric per-word pixel² requirement.
//   font_height = pt × 96/72   (image rasters at 96dpi-equivalent)
//   char_width  ≈ pt × 0.55    (Helvetica regular)
//   line_height ≈ font_height × 1.18
//   px²/word    = char_width × line_height × 5.5 chars/word × 1.5 overhead
const PIXELS_PER_WORD = {
  14: 14 * 0.55 * (14 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 1399 px²
  12: 12 * 0.55 * (12 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 1028 px²
  10: 10 * 0.55 * (10 * 96 / 72 * 1.18) * 5.5 * 1.5, // ≈ 714 px²
};

// Repair budget — max attempts on top of the original. Best by calm
// pixels inside the polygon wins, even if every attempt fell short.
const REPAIR = { maxRetries: 2 };

/** Required calm pixel² to fit `words` of text rendered at `fontPt`. */
function requiredTextPixels(words, fontPt) {
  const k = PIXELS_PER_WORD[fontPt];
  if (!k) throw new Error(`requiredTextPixels: unsupported fontPt ${fontPt}`);
  return Math.round((words || 0) * k);
}

/** Font size the PDF renderer uses for a given language level. */
function requiredFontPt(languageLevel) {
  return languageLevel === '1st-grade' ? 14 : 12;
}

/** Count printable words in a page's text string. */
function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

module.exports = {
  PIXELS_PER_WORD,
  REPAIR,
  requiredTextPixels,
  requiredFontPt,
  countWords,
};
