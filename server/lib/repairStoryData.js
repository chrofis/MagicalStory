'use strict';

const { COVER_PAGE_NUMBERS } = require('./coverKeys');

/**
 * The storyData object the repair / iterate pipeline works from
 * (runUnifiedRepairPipeline's context.storyData). ONE builder: the story run
 * (storyJobPipeline.js) calls it with the live values of the job, and the Test
 * Lab stage book_review_rerun (server/lib/testlab.js) calls it with the values
 * of a stored story, so the two cannot drift apart.
 *
 * Every comment below was written where the field was first assembled; they
 * moved here unchanged with the object literal.
 *
 * @param {object} d
 * @param {object} d.inputData            characters, layout, artStyle, language, season, createdAt, trialMode, dedication
 * @param {object} d.characterAvatars     storyAvatars result (cell-crop source)
 * @param {Array}  d.sceneDescriptions    the stored scene-description records (sceneDescriptionRecord shape)
 * @param {string} d.fullStoryText
 * @param {string} d.writerText
 * @param {object} d.visualBible
 * @param {object} d.clothingRequirements
 * @param {object} d.pageClothing
 * @param {object} d.coverHints
 * @param {Array}  d.rawImages            the pages handed to the pipeline
 * @param {(r: object) => (string|null)} d.textPositionOf   the page's locked text position (null when the layout has no text zone)
 * @param {object} d.coverImages
 * @param {string} d.title
 */
function buildRepairStoryData({ inputData, characterAvatars, sceneDescriptions, fullStoryText, writerText, visualBible, clothingRequirements, pageClothing, coverHints, rawImages, textPositionOf, coverImages, title }) {
  return {
    characters: inputData.characters,
    // The story's page shape: every repair/iterate redraw reads it via
    // layout.resolveStoryPageAspect, which refuses to guess. Without it every
    // repair round threw "no usable layout.imageAspect" (prod showcase
    // job_1792274214249_fsdtnb3u0, 2026-10-17, after 8eff73710).
    layout: inputData.layout,
    // Phase 7 cell-crop refs: iteratePageCore checks
    // storyData.characterAvatars to crop a single body cell per character
    // (matching the scene's pose) instead of attaching the full 2×4
    // sheet. Without this field present, the cell-crop branch silently
    // skips and Grok receives the full sheet as a reference — the model
    // then tries to recompose all 8 cells into the page.
    characterAvatars,
    // The stored record shape (brief under `description`), projected NOW
    // from expandedScenes: a spread-side mirror rewrites a scene's brief
    // after allSceneDescriptions was built, and iterate must rewrite the
    // brief the page was rendered from.
    sceneDescriptions,
    story: fullStoryText,
    storyText: fullStoryText,
    writerText, // frozen draft — carried on the checkpoint too, or a
                // story that never reaches the final save loses it
    visualBible,
    artStyle: inputData.artStyle,
    language: inputData.language,
    // Season, or the iterate path re-derives it from the RENDER date.
    // resolveSeason() falls back to `inputData.createdAt || new Date()`,
    // and neither field reached this object — so every iterate-round page
    // rebuilt its prompt with whatever season the server was living in.
    // Measured 2026-09-08 on two stories stored `season: 'summer'`: all
    // four `iterate-round-*` versions carried **SEASON: Autumn** (it was
    // September) while every first-pass version carried Summer, which is
    // the autumn almond tree on the pirate p13 climax. createdAt rides
    // along so a repair months later still resolves the drawn season —
    // the behaviour season.js already documents and could not deliver.
    season: inputData.season,
    createdAt: inputData.createdAt,
    clothingRequirements,
    pageClothing,
    // A trial (hint-made) cover's cast outfits live on its cover hint; a
    // cover char-fix resolves them from here (resolveRenderedClothingCategory).
    coverHints,
    // Preserve per-scene layout fields (imageAspect, textInImage) so any
    // iterate/redo inside the repair pipeline regenerates at the right
    // aspect. Stripping these would silently revert advanced-layout pages
    // back to 3:4 on auto-repair.
    sceneImages: rawImages.map(r => ({
      pageNumber: r.pageNumber,
      imageData: r.imageData,
      description: r.sceneDescription,
      // The page's CAST and its per-character clothing. Without these,
      // iteratePageCore could not tell who is on the page and fell back to
      // the whole story roster — it then demanded an outfit for characters
      // who are not in the scene, and the no-default clothing guard threw,
      // killing the page's repair outright (job_1786147254924_8nuyywjii:
      // every page had at least one absent character, so every page-iterate
      // died while the covers, which use iterateCover, survived).
      sceneCharacters: r.sceneCharacters || null,
      perCharClothing: r.perCharClothing || null,
      // THE PAGE'S OWN BRIEF METADATA. Absent from this whitelist,
      // `iteratePageCore` read `savedScene.sceneMetadata` as `{}` on
      // every pipeline iterate -- so `wornItems` was never carried
      // forward (81ad55a54's carryForwardWornItems had nothing to carry
      // FROM), the declared-set allowance had no original id set, and the
      // citation-drop warning compared against nothing. Measured on
      // staging job_1789584708605_rts4wqupm: all six iterate rewrites
      // stored `wornItems: []`, and p16's REQUIRED OBJECTS block shipped
      // empty because the jacket it had taken OFF was resolved back to
      // "worn" and omitted as already-referenced.
      sceneMetadata: r.sceneMetadata || null,
      // THE FIELDS THE JEV LAYER FIXED (2026-10-06). iteratePageCore re-pins them after
      // a rewrite (pinBrief) and reads `savedScene.jevFixed.shot` to tell a strict from a
      // free iterate. This whitelist lacked them, so every in-job iterate rewrite shipped
      // unpinned: essbv p3 v1 kept location LOC001 for the vantage LOC001.2, no population
      // and Emma's gaze at "water" where the plan, the text and the pin say Hans.
      jevFixed: r.scene?.jevFixed || null,
      imageAspect: inputData?.layout?.imageAspect,
      textInImage: inputData?.layout?.textInImage,
      // The page's locked text-overlay position. Used by iteratePageCore
      // (re-injected as COPY SPACE) and by character-repair (so Grok
      // doesn't drop the figure into the text zone during inpaint).
      // Only set for overlay layouts — see persistence note above.
      textPosition: textPositionOf(r),
    })),
    coverImages,  // a full-story cover's brief record — iteratePageCore reads it (covers are pages)
    trialMode: !!inputData.trialMode, // coverIteratePath: trial covers never reach the page path
    title,
    dedication: inputData.dedication || '',
  };
}


/**
 * The pseudo-page a cover enters the repair pipeline as (negative page number,
 * evaluationType 'cover'). ONE builder: the story run adds each finished cover
 * with it, and the Test Lab stage book_review_rerun builds the same entry from a
 * stored cover's original art. Moved unchanged from storyJobPipeline.js.
 *
 * @param {string} coverKey   frontCover | initialPage | backCover
 * @param {object} coverData  the cover record (imageData = the textless art; prompt, description, referencePhotos, ...)
 * @param {object} d
 * @param {string} d.title
 * @param {object} d.inputData     characters, title, storyTitle, dedication
 * @param {object} d.coverHints
 */
function buildCoverRepairEntry(coverKey, coverData, { title, inputData, coverHints }) {
  // Text requirements travel as STRUCTURED fields (expectedText /
  // textMode) on the pseudo-page — never as sentences appended to
  // sceneDescription (the old string surgery leaked eval-only notes
  // into the entity check and semantic reference).
  // Mode A (appSideCoverType=false, textMode 'painted'): the image
  // model PAINTS the text, so the eval verifies it (expectedText).
  // The TITLE comes from `title` (extracted by UnifiedStoryParser),
  // NOT from inputData — the user never types one, the model invents
  // it. Reading inputData.title first yields '' on every unified run
  // and the evaluator then flags the cover's OWN title as unrequested
  // text (observed job_1778525478433_fkl0f12x4: frontCover -20).
  // Mode B (appSideCoverType=true, default, textMode 'appOverlay'):
  // art is TEXTLESS, typography composited post-persist
  // (server/lib/coverTypography.js) — the evaluator must never flag
  // missing/present title text (a good textless cover otherwise
  // tanks to 0 and triggers a destructive re-iteration).
  // A BAKED front cover (coverTitleMode='baked') is Mode A for this
  // one cover even while the flag says app-side: the model painted the
  // title, so the evaluator must VERIFY it — spelling is the whole risk
  // baked mode takes on. The other covers keep app-side typography.
  // ONE resolver, shared with the cover ITERATE path (2026-09-13) so
  // a regenerated / Lab cover is judged under the same text contract
  // as a freshly generated one.
  const { textMode, expectedText } = require('./coverTypography').resolveCoverTextContract(coverKey, {
    titleBaked: coverData.titleBaked === true,
    title: title || inputData.title || inputData.storyTitle || null,
    dedication: coverData.dedication || inputData.dedication || null,
  });
  // Synthetic sceneMetadata from the outline's structured cover hint,
  // so the shared Phase 5b-pre detection and eval enrich see expected
  // character positions + objects exactly like pages do.
  const coverHint = coverHints?.[coverKey] || null;
  const hintCharacterPositions = {};
  if (coverHint?.characterDetails && typeof coverHint.characterDetails === 'object') {
    for (const d of Object.values(coverHint.characterDetails)) {
      if (d?.name) hintCharacterPositions[d.name] = d.position || 'center';
    }
  }
  const coverSceneMetadata = {
    characterPositions: hintCharacterPositions,
    objects: Array.isArray(coverHint?.objects)
      ? coverHint.objects.filter(o => typeof o === 'string')
      : [],
  };
  // Resolve full character objects for the figures appearing on this
  // cover so downstream eval/enrich/char-repair can identify them by
  // name. Without this, covers reach BBOX-ENRICH with 0 expected
  // characters and every figure comes back UNKNOWN — char repair
  // then filters them all out and `protectedFaces` ends up empty,
  // so only the target face gets blurred.
  const coverCharacterNames = (coverData.referencePhotos || [])
    .map(p => p.name)
    .filter(Boolean);
  const coverSceneCharacters = (inputData.characters || [])
    .filter(c => coverCharacterNames.includes(c.name));
  return {
    pageNumber: COVER_PAGE_NUMBERS[coverKey],
    text: '',
    sceneDescription: coverData.description || coverData.prompt || '',
    sceneMetadata: coverSceneMetadata,
    expectedText,
    textMode,
    imageData: coverData.imageData,
    // WHICH MODEL PAINTED IT. The page path has carried
    // `modelId: activeModelId` since it was written; this push never
    // did, so every cover entered the repair pipeline model-less and
    // its v0 version record stamped `modelId: img.modelId` = undefined
    // — a cover could not answer "Grok or Gemini" after the fact.
    modelId: coverData.modelId || null,
    prompt: coverData.prompt,
    // The sent prose of the ORIGINAL cover render. The repair
    // pipeline's version builder resolves a version's own
    // `compressedScene` and falls back to the page's — so without
    // this the original cover version (v0) resolves to null even
    // when the render was shrunk, and every judge scores it against
    // the pre-shrink build.
    compressedScene: coverData.compressedScene || null,
    characterPhotos: coverData.referencePhotos || [],
    // Carry the original render's references onto the pipeline img so
    // the persisted V1 (original) version records what was actually
    // sent to the image model. Without these, the version-builder
    // stores null and the per-version dev panel shows "no avatars" for
    // the original cover even though the render attached them — the
    // refs only survived on the top-level cover object, not per-version.
    referencePhotos: coverData.referencePhotos || [],
    grokRefImages: coverData.grokRefImages || null,
    sceneCharacters: coverSceneCharacters,
    // THE JUDGE GETS THE GENERATOR'S TRIM (owner, 2026-09-15: "Cover
    // the author is correct max 5"). The cover was rendered from a
    // roster capped at MAX_COVER_CHARACTERS; every other story
    // character is excluded, and the EXPECTED CAST must not rebuild
    // them from the cover prose. One resolver with the iterate path.
    excludedCastNames: require('./coverCastRoster')
      .resolveCoverCastRoster(coverSceneCharacters, inputData.characters || []).excluded,
    scene: { outlineExtract: coverData.description },
    evaluationType: 'cover', // Use cover evaluation (includes text checks)
  };
}

module.exports = { buildRepairStoryData, buildCoverRepairEntry };
