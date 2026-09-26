/**
 * THE COVER-ONLY RENDER OPTIONS of a full-story cover page (2026-09-24).
 *
 * A full-story cover is briefed and rendered as a page (coverBeats.js). What
 * stays different is only what a cover genuinely is:
 *   - its aspect (`MODEL_DEFAULTS.coverAspect`, on every book layout);
 *   - its copy space is always in the image — a cover carries its title,
 *     dedication or back-cover line whatever the page layout does with text —
 *     at the beat's `textPosition` (COVER_TEXT_POSITION). The render takes it
 *     from here, like the iterate's locked position: on a story whose text-zone
 *     rules are off the Art Director's metadata carries no `textPosition` at
 *     all (Lab 1458), and its prose already stages the band;
 *   - the front cover's baked title (runtime `coverTitleMode`): the typography-
 *     aware model, and the REQUIRED TEXT block at the prompt tail;
 *   - its text contract for the judges (`resolveCoverTextContract`);
 *   - its usage bucket and its progressive-display checkpoint.
 * Story pages get null, and the page path is unchanged for them.
 */

const { MODEL_DEFAULTS } = require('../config/models');
const { coverKeyOfPage } = require('./coverBeats');
const { COVER_TEXT_POSITION } = require('./coverKeys');

/**
 * @param {number} pageNumber
 * @param {Object} ctx
 * @param {string} [ctx.title] - the story title (baked onto the front cover)
 * @param {string} [ctx.dedication]
 * @param {string} [ctx.coverTitleMode] - a run override of runtime.coverTitleMode
 * @returns {null|{coverKey, aspectRatio, textInImage, textPosition, bakeTitle, titleBaked, imageModel, textMode, expectedText, appTexts, usageLabel, captureLabel}}
 */
function coverRenderOptions(pageNumber, { title = '', dedication = null, coverTitleMode = null } = {}) {
  const coverKey = coverKeyOfPage(pageNumber);
  if (!coverKey) return null;
  const { resolveCoverTitleMode, resolveCoverTextContract } = require('./coverTypography');
  const titleMode = resolveCoverTitleMode(coverKey, title || '', { modeOverride: coverTitleMode });
  const titleBaked = titleMode.baked === true;
  const { textMode, expectedText, appTexts } = resolveCoverTextContract(coverKey, {
    titleBaked, title: title || null, dedication: dedication || null,
  });
  return {
    coverKey,
    aspectRatio: MODEL_DEFAULTS.coverAspect,
    textInImage: true,
    textPosition: COVER_TEXT_POSITION[coverKey],
    bakeTitle: titleMode.bakeTitle || '',
    titleBaked,
    imageModel: titleMode.bakedModel || null,
    textMode,
    expectedText,
    appTexts,
    usageLabel: 'cover_images',
    captureLabel: 'image_cover',
  };
}

/**
 * ITERATE A FULL-STORY COVER THROUGH THE PAGE PATH (owner, 2026-09-24 — plan
 * covers-as-pages Q7 (a)): the post-generation entry the cover routes and the
 * Test Lab use. `iteratePageCore` rewrites the cover's Art Director brief and
 * renders it exactly like a page (it refuses a trial or pre-change cover via
 * coverIteratePath); the app-side typography is then re-composited onto the
 * textless render, the one extra pass a cover gets over a page. A baked front
 * cover carries its title in the pixels and is served as rendered.
 *
 * The in-generation repair pipeline does NOT come here: it calls iteratePage
 * directly and the post-persist bake stamps the typography once.
 *
 * @param {string} coverKey
 * @param {Object} storyData - rehydrated (the cover's active bytes on coverImages[coverKey].imageData)
 * @param {Object} [options] - passed to iteratePage (modelOverrides, evaluationFeedback, ...)
 * @returns {Promise<Object>} iteratePage's result, with `imageData` the served (stamped)
 *   bytes, `artImageData` the textless art (or null), `typography`, `prompt`.
 */
async function iterateFullStoryCover(coverKey, storyData, options = {}) {
  const { COVER_PAGE_NUMBERS } = require('./coverKeys');
  const { coverIteratePath } = require('./coverBeats');
  if (coverIteratePath(storyData, coverKey) !== 'page') {
    throw new Error(`${coverKey}: a trial cover iterates through iterateCover, never the page path`);
  }
  const record = storyData.coverImages[coverKey];
  if (!record.imageData) throw new Error(`${coverKey}: no cover image to iterate`);
  const pageNumber = COVER_PAGE_NUMBERS[coverKey];
  const result = await require('./images').iteratePage(record.imageData, pageNumber, storyData, options);
  if (result.previewOnly) return result;
  const opts = coverRenderOptions(pageNumber, {
    title: storyData.title || storyData.storyTitle || '',
    dedication: storyData.dedication || null,
    coverTitleMode: options.modelOverrides?.coverTitleMode || null,
  });
  const { stampRepaintedCover } = require('./coverTypography');
  const stamped = await stampRepaintedCover(storyData, coverKey, result, { force: true, skip: opts.titleBaked, logTag: 'COVER-PAGE-ITERATE' });
  return {
    ...result,
    imageData: stamped.servedImageData,
    artImageData: stamped.artImageData,
    typography: stamped.typographySpec,
    prompt: result.promptSent || result.imagePrompt || null,
    titleBaked: opts.titleBaked,
    previousImage: record.imageData,
    previousScore: record.qualityScore ?? null,
  };
}

module.exports = { coverRenderOptions, iterateFullStoryCover };
