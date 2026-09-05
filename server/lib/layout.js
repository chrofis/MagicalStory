/**
 * Page layout resolver — single source of truth for "what aspect + how is text shown"
 * decision per page.
 *
 * Every reading level defaults to `square-below`: a square image with the page
 * text typeset in a white strip underneath. `a4-overlay` (text painted INSIDE
 * the picture over a reserved calm zone) survives only as an explicit developer
 * override.
 *
 * The reason is measured, not aesthetic. Overlay text has to fit a calm zone
 * inside the frame, and `requiredTextPixels()` (server/config/textRegion.js)
 * prices a word at ~1399 px² at 14pt and ~1028 px² at 12pt. The largest zone the
 * text-region pass actually offers is ~99,360 px² (a full-width band; a corner or
 * half zone is ~74,675 px²) — about 71 and 53 words at 14pt. Against the
 * LANGUAGE_LEVELS budgets (1st-grade 25–50 words, standard 40–150, advanced
 * 250–300) only 1st-grade's FLOOR fits with room to spare; its 50-word ceiling
 * already eats 94% of the smaller zone, and standard/advanced cannot fit at all.
 * A budget whose top end has no headroom is not a layout that can be the default:
 * `job_1788614817116_vxnu60yjg` (1st-grade, 18 pages) came in at 73–118 words a
 * page and failed the text-fit check on 18 pages out of 18.
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
 *   - every reading level ('1st-grade', 'standard', 'advanced', unknown)
 *     → square-below (square image + text strip below)
 *   - an explicit override → whatever it names, including a4-overlay
 *
 * @param {string} languageLevel - Story-wide reading level ('1st-grade' | 'standard' | 'advanced').
 * @param {LayoutOverride} [override='auto'] - Developer override. 'auto' (default) follows the languageLevel mapping.
 * @returns {LayoutResult}
 */
function resolveLayout(languageLevel, override = 'auto') {
  if (override && override !== 'auto' && LAYOUTS[override]) {
    return { ...LAYOUTS[override] };
  }
  // No reading level's word budget fits the overlay calm zone (see the header
  // note) — every level gets a square image + text below.
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
