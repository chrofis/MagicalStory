/**
 * Page layout resolver — single source of truth for "what aspect + how is text shown"
 * decision per page.
 *
 * Driven by the existing `languageLevel` setting on the story:
 *   - '1st-grade'  → A4 portrait + text overlaid on image (current pipeline: calm-zone, mask, QC, repair)
 *   - 'standard'   → A4 portrait + text overlaid on image (current pipeline)
 *   - 'advanced'   → square image + text below in a white strip (no calm-zone, no mask, no QC, no repair)
 *
 * The reason: `advanced` stories have long page text. Overlaying long text on the
 * image would dominate the picture; instead we render a square image at the top
 * 2/3 of the A4 page and typeset text on a white strip below (bottom 1/3).
 *
 * A developer override can force any layout (or invoke the legacy 2-page mode).
 *
 * Returns a stable object the rest of the pipeline reads from: imageAspect drives
 * Grok aspect_ratio; textInImage gates the text-zone instructions, mask reference
 * cell, empty-scene QC, and text-space-repair pass.
 */

/**
 * @typedef {'auto' | 'a4-overlay' | 'square-below' | 'legacy-square-2page'} LayoutOverride
 * @typedef {'a4-overlay' | 'square-below' | 'legacy-square-2page'} LayoutMode
 *
 * @typedef {Object} LayoutResult
 * @property {'1:1' | '3:4'} imageAspect       Aspect ratio for image generation (also drives Grok ref slot composition).
 * @property {boolean}       textInImage       True ⇒ text overlay on image (calm-zone, mask, QC, repair).
 *                                              False ⇒ text rendered separately below the image.
 * @property {LayoutMode}    mode              Effective mode after applying override.
 */

const LAYOUTS = {
  'a4-overlay':         { imageAspect: '3:4', textInImage: true,  mode: 'a4-overlay' },
  'square-below':       { imageAspect: '1:1', textInImage: false, mode: 'square-below' },
  'legacy-square-2page':{ imageAspect: '1:1', textInImage: false, mode: 'legacy-square-2page' },
};

/**
 * Resolve the page layout for a story.
 *
 *   - '1st-grade' (very short text) → a4-overlay (text on image, calm-zone reserved)
 *   - 'standard'  (middle text)     → square-below (square image + text strip below)
 *   - 'advanced'  (long text)       → square-below (square image + text strip below)
 *
 * @param {string} languageLevel - Story-wide reading level ('1st-grade' | 'standard' | 'advanced').
 * @param {LayoutOverride} [override='auto'] - Developer override. 'auto' (default) follows the languageLevel mapping.
 * @returns {LayoutResult}
 */
function resolveLayout(languageLevel, override = 'auto') {
  if (override && override !== 'auto' && LAYOUTS[override]) {
    return { ...LAYOUTS[override] };
  }
  if (languageLevel === '1st-grade') {
    return { ...LAYOUTS['a4-overlay'] };
  }
  // standard, advanced, and any unknown value → square image + text below.
  return { ...LAYOUTS['square-below'] };
}

/**
 * Read-only view: is the layout legacy 2-page mode? Some pipeline steps (PDF
 * pagination, frontend display) need to know the full mode, not just the two
 * boolean fields.
 */
function isLegacy2Page(layout) {
  return layout?.mode === 'legacy-square-2page';
}

module.exports = {
  resolveLayout,
  isLegacy2Page,
  LAYOUTS,
};
