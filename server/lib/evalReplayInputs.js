/**
 * EVAL REPLAY INPUTS — the `evalOptions` production hands `evaluateImageQuality`,
 * rebuilt ONCE from a Test Lab scene context.
 *
 * Production has exactly one page-eval funnel: the batch in
 * server/lib/images.js (`evaluateImagesBatch`), which passes
 *
 *     { visualBible, artStyle, storyData, clothingRequirements,
 *       expectedText, textMode, landmarkPhotos, era, sceneMetadata,
 *       pageNumber, detectedFigures, storyMeta }
 *
 * Five Test Lab eval sites each spelled a THINNER subset of that by hand, and
 * the thinnest of them (`image`'s auto-eval) passed five keys. The consequences
 * are not cosmetic — every omitted key silently disables a check:
 *
 *  - `visualBible` absent → wornItems.resolveGeneratedOutfit returns the outfit
 *    text UNCHANGED (it bails on a falsy bible), so a page whose Art Director
 *    declared a garment `off` is still judged against a CLOTHING CONTRACT that
 *    names it. Measured on Lab experiment #1272: a correct render (garment
 *    absent on the pixels, absent from the sent prompt) took MAJOR
 *    "missing his red zip-up hoodie" from multiple evaluators.
 *    It also feeds scrubVbIds on the cover fidelity reference, the cover
 *    EXPECTED CAST branch and vbNonHumanNames (the people-vs-figures count).
 *  - `clothingRequirements` absent → the contract falls back to whatever
 *    `clothingDescription` happens to ride on the reference photos, instead of
 *    the story's canonical per-category wardrobe.
 *  - `storyData` absent → buildCastIndex has no photo-backed cast, so the
 *    EXPECTED CAST roster cannot canonicalise a short form to a real character.
 *  - `artStyle` absent (the `image` and `repair_round` stages) → every
 *    style-dependent evaluator rule skipped, because the Lab hands the judge a
 *    scene DESCRIPTION, which carries no ART STYLE block to extract one from.
 *  - `expectedText` / `textMode` absent on a cover target → the
 *    "the title is an app overlay, never flag it" branch is unreachable and a
 *    correctly textless cover is marked down for a missing title.
 *
 * DELIBERATELY NOT MIRRORED: `storyMeta`. It is a pure statistics sink — the
 * only thing evaluateImageQuality does with it is fire-and-forget rows into
 * `eval_findings` for per-style/genre reporting (evalPipeline.js ~:2342). It
 * changes no score, no finding and no repair decision. Mirroring it would make
 * every Lab re-eval — including the `eval_variance` stage's 2-5 REPEATS of one
 * page — write duplicate findings for a story that was measured once, skewing
 * exactly the aggregate the registry exists to report. Pinned by a test so it
 * is not "completed" later.
 *
 * ALSO NOT MIRRORED: `outlineCharacters`. Production's batch site does not pass
 * it either (it uses `img.outlineCharacters` for DETECTION only, images.js
 * :2565/:2589), and the baseline is production, not the union of everything the
 * evaluator can read. If production starts passing it, the wiring guard in
 * tests/unit/eval-replay-inputs.test.ts fails and this comment is wrong.
 *
 * OVERRIDES ARE THE POINT OF AN A/B, not a defect — the rule is that the
 * BASELINE equals production. A stage passes its knobs through `overrides` and
 * gets back the list of keys it actually displaced, so a result can say which
 * arm a run was (same contract as beatsReplayInputs, 8777a73ea).
 *
 * Same class and same remedy as sceneMetadata.resolveEvalSceneHint (3b3070dce),
 * wornItems.resolveGeneratedOutfit (e403345b1) and beatsReplayInputs
 * (8777a73ea): ONE resolver, so a sixth divergent expression cannot be written.
 */

/**
 * Every key production's batch eval passes that a Lab replay must also pass.
 * The wiring guard asserts production still passes all of these.
 */
const MIRRORED_EVAL_OPTION_KEYS = Object.freeze([
  'visualBible',
  'clothingRequirements',
  'storyData',
  'artStyle',
  'sceneMetadata',
  'pageNumber',
  'landmarkPhotos',
  'era',
  'detectedFigures',
  'expectedText',
  'textMode',
]);

/** Keys production passes that a Lab replay deliberately does NOT — see header. */
const NOT_MIRRORED_EVAL_OPTION_KEYS = Object.freeze(['storyMeta']);

/** Same map as testlab.js's COVER_KEY_BY_PAGE — negative page numbers are covers. */
const COVER_KEY_BY_PAGE = Object.freeze({ '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' });

/**
 * The 4th positional argument of evaluateImageQuality. Production sends 'cover'
 * for the three cover pseudo-pages (storyJobPipeline.js ~:5758); the Lab sites
 * all hard-coded 'scene', so a cover target skipped the whole cover branch
 * (its fidelity reference, its gaze/flat-title exemptions and its text rules).
 */
function resolveEvalReplayType(pageNumber) {
  return COVER_KEY_BY_PAGE[String(pageNumber)] ? 'cover' : 'scene';
}

/**
 * @param {object} ctx  a testlab loadSceneContext() result
 * @param {object} [opts]
 * @param {Array|null} [opts.detectedFigures] figures detected on THESE bytes, or
 *        null to withhold the count (fresh bytes / a pinned version the stored
 *        detection does not belong to).
 * @param {string|null} [opts.artStyleKey] art-style KEY to resolve the style
 *        description from; defaults to the story's. An A/B that renders in a
 *        different style passes that style here so the judge is told about it.
 * @param {object} [opts.overrides] explicit Lab-only knobs and A/B overrides,
 *        merged last. `undefined` values are ignored.
 * @returns {{options: object, evaluationType: string, coverKey: string|null, overridden: string[]}}
 */
function buildEvalReplayOptions(ctx, opts = {}) {
  const { detectedFigures = null, artStyleKey, overrides = {} } = opts;
  const scene = (ctx && ctx.scene) || {};
  const { resolveEvalArtStyle } = require('../services/prompts');
  const { resolveSceneEra } = require('./landmarkProtection');

  const pageNumber = ctx && ctx.pageNumber != null ? ctx.pageNumber : null;
  const coverKey = COVER_KEY_BY_PAGE[String(pageNumber)] || null;

  const options = {
    visualBible: (ctx && ctx.visualBible) || null,
    clothingRequirements: (ctx && ctx.clothingRequirements) || null,
    // buildCastIndex reads storyData.characters and nothing else
    // (castResolver.js:66-69); loadSceneContext already pulls that exact array
    // out of the same `data->'characters'` jsonb production reads.
    storyData: { characters: Array.isArray(ctx && ctx.characters) ? ctx.characters : [] },
    // The ONE resolver both this path and production's batch use, from the same
    // source (the story's art-style key). Never re-derive it locally.
    artStyle: resolveEvalArtStyle(
      artStyleKey === undefined ? (ctx && ctx.artStyle) || null : artStyleKey,
      scene.prompt || null
    ),
    sceneMetadata: scene.sceneMetadata || null,
    pageNumber,
    landmarkPhotos: scene.landmarkPhotos || null,
    era: resolveSceneEra(scene.sceneMetadata),
    detectedFigures: detectedFigures || null,
    expectedText: null,
    textMode: null,
  };

  if (coverKey) {
    const { resolveCoverTextContract } = require('./coverTypography');
    const contract = resolveCoverTextContract(coverKey, {
      titleBaked: scene.titleBaked === true,
      title: (ctx && ctx.title) || null,
      dedication: scene.dedication || null,
    });
    options.expectedText = contract.expectedText;
    options.textMode = contract.textMode;
  }

  const overridden = [];
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(options, key) && options[key] !== value) overridden.push(key);
    options[key] = value;
  }

  return { options, evaluationType: resolveEvalReplayType(pageNumber), coverKey, overridden };
}

module.exports = {
  MIRRORED_EVAL_OPTION_KEYS,
  NOT_MIRRORED_EVAL_OPTION_KEYS,
  COVER_KEY_BY_PAGE,
  resolveEvalReplayType,
  buildEvalReplayOptions,
};
