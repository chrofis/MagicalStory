'use strict';

/**
 * THE PAGE RENDER CALL — one set of builders for the story run's page render
 * (storyJobPipeline.js Phase 5a) and the Test Lab `image` stage.
 *
 * WHY THIS EXISTS (owner, 2026-09-27: "The Lab must use 100% identical code to
 * production"). The run assembled every input of a page render inline — the
 * element selection, the plate-borne cell filter, the model tier, the prompt
 * closure, the reference mode, the copy-space mask — and the Lab stage rebuilt
 * each of them its own way. Measured on 2026-09-27 the Lab:
 *   - built `inputData` without `layout`, so buildImagePrompt read
 *     textInImage=true and sent a COPY SPACE block on text-below stories that
 *     production never sends;
 *   - selected grid elements without the brief's objects[] and without the
 *     id fallback, so its grid held different cells than production's;
 *   - attached the page's stored references raw, while production passes them
 *     through the route's reference mode (applyReferenceMode 'loose'/'off');
 *   - attached a text mask on plateless pages, which production never does.
 *
 * Every function here is the ONE implementation both callers use. A Lab
 * `params.*` knob may override an input explicitly; with no params the Lab call
 * equals production's. Parity is pinned by tests/unit/lab-prod-call-parity.test.ts.
 */

const { log } = require('../utils/logger');

/**
 * The Visual Bible elements a page SELECTS for its grid: the page's own
 * elements (with the Art Director's objects[] and the worn-item dedupe), plus
 * any element the brief names by id that the bible filed under another page.
 * Before the plate-borne filter (keepPageGridElements), which needs to know
 * whether a plate was sent.
 */
function selectPageElementRefs(visualBible, pageNumber, sceneMetadata) {
  const { getElementReferenceImagesForPage, getElementReferenceImagesByIds } = require('./visualBible');
  // The PHYSICAL grid bound (one Grok reference slot, cell size 1/n), not the
  // Art Director's element budget — see storyJobPipeline.js for the history.
  const { VB_SLOT_MAX_ELEMENTS } = require('./grok');
  let refs = getElementReferenceImagesForPage(visualBible, pageNumber, VB_SLOT_MAX_ELEMENTS, sceneMetadata?.objects || null, sceneMetadata);
  // Also match by the ids the brief cites (covers a page mismatch between the
  // bible's page list and the scene).
  if (sceneMetadata?.fullData) {
    const sceneIds = [];
    for (const char of sceneMetadata.fullData.characters || []) {
      if (char.id && char.id !== 'null') sceneIds.push(char.id);
    }
    for (const obj of sceneMetadata.fullData.objects || []) {
      const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
      if (id && !id.startsWith('LOC')) sceneIds.push(id);
    }
    if (sceneIds.length > 0) {
      const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds, pageNumber);
      const existingIds = new Set(refs.map(r => r.id));
      const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
      if (newRefs.length > 0) {
        log.info(`🔗 [VB-MATCH] Page ${pageNumber}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
        refs = [...refs, ...newRefs].slice(0, 4);
      }
    }
  }
  return refs;
}

/**
 * The selected elements that actually enter the page grid. A plate that was
 * SENT carries every plate-borne element (vehicles, building/landscape scale)
 * the brief's objects[] admitted; the element the camera stands on (`aboard`)
 * never enters the grid. A plateless page keeps its large elements.
 */
function keepPageGridElements(refs, { hasPlate, sceneMetadata }) {
  const aboardId = sceneMetadata?.aboard || null;
  const { isPlateBorneElement } = require('./visualBible');
  const sceneObjects = sceneMetadata?.objects || null;
  return (hasPlate ? (refs || []).filter(e => !isPlateBorneElement(e, sceneObjects)) : (refs || []))
    .filter(e => !aboardId || e.id !== aboardId);
}

/**
 * The model a page renders on. `modelOverrides` are the run's developer
 * overrides (sceneRouting/imageModel/imageBackend); a cover's baked title
 * renders on the typography-aware model.
 */
function pageRenderModel({ sceneMetadata, modelOverrides = {}, coverOpts = null, pageNumber = null }) {
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
  const sceneComplexity = sceneMetadata?.sceneComplexity || 'simple';
  const sceneRouting = modelOverrides.sceneRouting || 'auto';
  let pageImageModel, pageImageBackend;
  if (sceneRouting === 'auto') {
    pageImageModel = sceneComplexity === 'complex' ? MODEL_DEFAULTS.complexPageImage : MODEL_DEFAULTS.simplePageImage;
    pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'gemini';
    log.info(`🎯 [ROUTING] Page ${pageNumber}: ${sceneComplexity} → ${pageImageModel} (${pageImageBackend})`);
  } else if (sceneRouting === 'grok') {
    pageImageModel = MODEL_DEFAULTS.simplePageImage;
    pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
  } else if (sceneRouting === 'gemini') {
    pageImageModel = MODEL_DEFAULTS.complexPageImage;
    pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'gemini';
  } else {
    pageImageModel = modelOverrides.imageModel;
    pageImageBackend = modelOverrides.imageBackend;
  }
  if (coverOpts?.imageModel) {
    pageImageModel = coverOpts.imageModel;
    pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || pageImageBackend;
  }
  return { pageImageModel, pageImageBackend, sceneComplexity };
}

/**
 * The page prompt, as a function of the element ids whose reference render
 * rides with the call (the prompt must never promise an image the call does not
 * carry — production rebuilds it once the grid is final). `extraOptions` is the
 * Lab's explicit A/B surface (pageScaleScope) and the iterate repair's locked
 * text position and render backend (images.js iteratePageCore, 2026-09-28 —
 * the repair builds its prompt here too); the first render passes none.
 */
function makePageImagePrompt({ sceneDescription, inputData, sceneCharacters, visualBible, pageNumber, characterPhotos, pageImageModel, coverOpts = null, extraOptions = null }) {
  const { IMAGE_MODELS } = require('../config/models');
  const { buildImagePrompt, withBakedTitle } = require('./promptBuilders');
  // Grok's prompt cap: the VB prose is skipped and the grid carries the refs.
  const isGrokImage = IMAGE_MODELS[pageImageModel]?.backend === 'grok';
  return (vbRefElementIds) => withBakedTitle(buildImagePrompt(
    sceneDescription, inputData, sceneCharacters, visualBible, pageNumber, characterPhotos, {
      skipVisualBible: isGrokImage,
      vbRefElementIds,
      // A cover's copy space is its beat's (coverRender.js).
      ...(coverOpts ? { textPositionOverride: coverOpts.textPosition } : {}),
      ...(extraOptions || {}),
    }
  ), coverOpts?.bakeTitle || '');
}

/**
 * The copy-space mask a page's PLATE is rendered with, and that the page render
 * then attaches — null when text is not in the image. The spread rule decides
 * the side, as for the plate's calm-zone instruction.
 */
function pageTextAreaMask({ textInImage, rawTextPosition, pageNumber, languageLevel }) {
  if (!textInImage) return null;
  const { enforceSpreadTextPosition } = require('./sceneMetadata');
  const textPos = enforceSpreadTextPosition(rawTextPosition, pageNumber);
  return require('./textMasks').getTextAreaMask(textPos, languageLevel || 'standard');
}

/**
 * generateImageOnly's options for a page render. `refApplied` is the output
 * of applyReferenceMode for the page's route; `plateTextAreaMask` the mask its
 * plate was rendered with (null when no plate).
 */
function pageRenderOptions({ page, renderAspect, pageImageModel, pageImageBackend, refApplied, textInImage, plateTextAreaMask, coverOpts = null }) {
  const { pageLandmarkScene } = require('./landmarkScene');
  return {
    // THE CAST-0 EXEMPTION: a page with no named cast renders on its landmark
    // photo (owner ruling 2026-09-02).
    landmarkScene: pageLandmarkScene(page),
    aspectRatio: renderAspect,
    imageModelOverride: pageImageModel,
    imageBackendOverride: pageImageBackend,
    landmarkPhotos: refApplied.landmarkPhotos,
    visualBibleGrid: refApplied.visualBibleGrid,
    pageNumber: page.pageNumber,
    sceneBackground: refApplied.sceneBackground,
    // Text-zone mask only when text is overlaid on the image (always on a
    // cover); for a text-below layout the model fills the whole frame.
    textAreaMask: textInImage ? (plateTextAreaMask || null) : null,
    ...(coverOpts ? { captureLabel: coverOpts.captureLabel } : {}),
  };
}

module.exports = {
  selectPageElementRefs,
  keepPageGridElements,
  pageRenderModel,
  makePageImagePrompt,
  pageTextAreaMask,
  pageRenderOptions,
};
