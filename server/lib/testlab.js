/**
 * Test Lab — per-stage rerun harness (admin only).
 *
 * Runs ONE pipeline stage in isolation against a story page, with the CURRENT
 * prompt templates by default or a caller-supplied template override for A/B
 * runs. Image-producing stages store their output as `is_test` rows in
 * story_images (excluded from every user-facing read; promoted by flipping
 * the flag). Eval stages return their verdict JSON without touching the story.
 *
 * Stages: empty_scene | image | quality_eval | semantic_eval | bbox |
 *         char_repair | entity
 *
 * Template overrides never mutate PROMPT_TEMPLATES for async code: the
 * generation builders accept an explicit `template` option, and the only
 * swap-based path (buildImagePrompt) is synchronous, so the swap window
 * contains no await and cannot leak into concurrent generations.
 */
'use strict';

const { log } = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────
// Context loading
// ─────────────────────────────────────────────────────────────────────

async function toDataUri(src) {
  if (!src || typeof src !== 'string') return null;
  if (src.startsWith('data:')) return src;
  if (/^https?:\/\//.test(src)) {
    try {
      const resp = await fetch(src);
      if (!resp.ok) return null;
      const buf = Buffer.from(await resp.arrayBuffer());
      const mime = resp.headers.get('content-type') || 'image/jpeg';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      log.warn(`[TESTLAB] Failed to fetch reference image: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Load one scene + the story-level fields the stage runners need.
 * Reference/landmark photos are resolved to data URIs (R2 URLs fetched).
 */
async function loadSceneContext(storyId, pageNumber) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery(
    `SELECT (scene)::text AS scene_text,
            data->>'artStyle' AS art_style,
            data->>'language' AS language,
            data->>'languageLevel' AS language_level,
            data->>'storyType' AS story_type,
            data->>'title' AS title,
            data->'layout' AS layout,
            (data->'visualBible')::text AS visual_bible
     FROM stories, jsonb_array_elements(data->'sceneImages') scene
     WHERE stories.id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  if (rows.length === 0) throw new Error(`Scene not found: ${storyId} page ${pageNumber}`);

  const scene = JSON.parse(rows[0].scene_text);
  const layout = typeof rows[0].layout === 'string' ? JSON.parse(rows[0].layout) : (rows[0].layout || {});
  let visualBible = null;
  try {
    visualBible = rows[0].visual_bible ? JSON.parse(rows[0].visual_bible) : null;
  } catch { /* malformed VB — run without grid refs */ }

  const referencePhotos = [];
  for (const p of (scene.referencePhotos || [])) {
    const uri = await toDataUri(p.photoUrl || p.photoData);
    if (uri) referencePhotos.push({ ...p, photoUrl: uri, photoData: undefined });
  }
  const landmarkPhotos = [];
  for (const lm of (scene.landmarkPhotos || [])) {
    const uri = await toDataUri(lm.photoData || lm.photoUrl);
    if (uri) landmarkPhotos.push({ ...lm, photoData: uri });
  }

  return {
    storyId,
    pageNumber,
    scene,
    layout,
    visualBible,
    artStyle: rows[0].art_style || 'pixar',
    language: rows[0].language || 'de',
    languageLevel: rows[0].language_level || 'standard',
    storyType: rows[0].story_type || null,
    title: rows[0].title || null,
    referencePhotos,
    landmarkPhotos,
    // null when the story renders text below the image (layout square-below) —
    // stages must NOT invent a text zone then (production omits it too).
    textPosition: scene.textPosition || scene.sceneMetadata?.textPosition || null,
    // Outline hint for evals — stored as outlineExtract/sceneHint on the
    // scene (there is no sceneMetadata.hint field; production reads these).
    outlineHint: scene.outlineExtract || scene.sceneHint || null,
  };
}

async function bytesFor(img) {
  if (!img) return null;
  const { imgBytesAsync } = require('../services/database');
  return imgBytesAsync({ image_data: img.imageData || img.image_data || null, image_url: img.imageUrl || img.image_url || null });
}

/** Baseline empty scene for a page (non-test rows only). */
async function loadEmptyScene(storyId, pageNumber) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery(
    `SELECT image_data, image_url FROM story_images
     WHERE story_id = $1 AND image_type = 'empty_scene' AND page_number = $2 AND NOT is_test
     ORDER BY version_index LIMIT 1`,
    [storyId, pageNumber]
  );
  return rows.length > 0 ? bytesFor(rows[0]) : null;
}

/** Active (user-visible) page image as a data URI. */
async function loadActivePageImage(storyId, pageNumber) {
  const { getActiveVersion, getStoryImage } = require('../services/database');
  const activeIdx = await getActiveVersion(storyId, pageNumber);
  const img = await getStoryImage(storyId, 'scene', pageNumber, activeIdx)
    || await getStoryImage(storyId, 'scene', pageNumber, 0);
  if (!img) throw new Error(`No image for ${storyId} page ${pageNumber}`);
  const data = await bytesFor(img);
  if (!data) throw new Error(`Image bytes unavailable for ${storyId} page ${pageNumber}`);
  return data;
}

/** A specific test-version image (Test Lab rows included). */
async function loadTestImage(storyId, imageType, pageNumber, versionIndex) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery(
    `SELECT image_data, image_url, is_test, experiment_id FROM story_images
     WHERE story_id = $1 AND image_type = $2 AND page_number IS NOT DISTINCT FROM $3 AND version_index = $4`,
    [storyId, imageType, pageNumber, versionIndex]
  );
  if (rows.length === 0) return null;
  return { imageData: await bytesFor(rows[0]), isTest: rows[0].is_test, experimentId: rows[0].experiment_id };
}

// Per-slot promise chain so concurrent saves (3 parallel redos + a running
// experiment on the same page) can't compute the same next version index and
// silently overwrite each other (saveStoryImage upserts on conflict).
const _saveChains = new Map();

async function saveTestVersion(storyId, imageType, pageNumber, imageData, experimentId, qualityScore = null) {
  const key = `${storyId}|${imageType}|${pageNumber}`;
  const prev = _saveChains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const { getNextVersionIndex, saveStoryImage } = require('../services/database');
    const versionIndex = await getNextVersionIndex(storyId, imageType, pageNumber);
    await saveStoryImage(storyId, imageType, pageNumber, imageData, {
      versionIndex,
      isTest: true,
      experimentId,
      qualityScore,
      generatedAt: new Date().toISOString(),
    });
    return versionIndex;
  });
  _saveChains.set(key, run);
  run.finally(() => { if (_saveChains.get(key) === run) _saveChains.delete(key); }).catch(() => {});
  return run;
}

// ─────────────────────────────────────────────────────────────────────
// Stage runners — each returns a JSON-safe result object (no image bytes;
// images are referenced by {imageType, versionIndex} test rows).
// ─────────────────────────────────────────────────────────────────────

async function runImageStage(ctx, { promptOverride, experimentId, autoEval = true, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildImagePrompt } = require('./storyHelpers');
  const { generateImageOnly, buildVisualBibleGrid } = require('./images');
  const { getElementReferenceImagesForPage } = require('./visualBible');
  const { getTextAreaMask } = require('./textMasks');
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');

  // artStyleOverride: render the page in a different art style than the story's
  // (style-matrix benchmark runs). Caveat: reference photos stay the story's
  // original styled avatars — the style prompt dominates rendering.
  const artStyle = params.artStyleOverride || ctx.artStyle;
  const inputData = {
    artStyle,
    language: ctx.language,
    ageFrom: 3,
    ageTo: 8,
    languageLevel: ctx.languageLevel,
  };

  // Same VB-text rule as production: Grok's 8000-char limit means the VB prose
  // is skipped and the grid image carries the references instead.
  const isGrokImage = IMAGE_MODELS[MODEL_DEFAULTS.pageImage]?.backend === 'grok';

  // buildImagePrompt reads PROMPT_TEMPLATES.imageGeneration internally and is
  // SYNCHRONOUS — swap the key only around this call (no await inside the
  // window, so concurrent generations can never observe the override).
  let prompt;
  const origTemplate = PROMPT_TEMPLATES.imageGeneration;
  if (promptOverride) PROMPT_TEMPLATES.imageGeneration = promptOverride;
  try {
    prompt = buildImagePrompt(
      ctx.scene.sceneDescription,
      inputData,
      ctx.scene.sceneCharacters || null,
      ctx.visualBible,
      ctx.pageNumber,
      ctx.referencePhotos,
      { textPositionOverride: ctx.textPosition || undefined, skipVisualBible: isGrokImage }
    );
  } finally {
    PROMPT_TEMPLATES.imageGeneration = origTemplate;
  }

  // avatarSheets: { characterName: tl_avatar versionIndex } — swap this page's
  // character refs to cell crops from Test Lab avatar sheets (the production
  // applyStoryCellRefs path), e.g. style-matrix runs with per-style avatars.
  if (params.avatarSheets && typeof params.avatarSheets === 'object') {
    const storyCharacterAvatars = {};
    for (const [name, vIdx] of Object.entries(params.avatarSheets)) {
      const sheet = await loadTestImage(ctx.storyId, 'tl_avatar', null, vIdx);
      if (sheet?.imageData) storyCharacterAvatars[name] = { costumed: sheet.imageData };
    }
    const { applyStoryCellRefs } = require('./storyAvatars');
    await applyStoryCellRefs(ctx.referencePhotos, storyCharacterAvatars, ctx.scene.sceneCharacters || []);
  }

  // backgroundRef: use a specific (test) empty-scene version as the background
  // anchor — style-matrix runs chain empty_scene(style) → image(style, that bg).
  let emptyScene;
  if (params.backgroundRef?.versionIndex !== undefined) {
    const bg = await loadTestImage(ctx.storyId, params.backgroundRef.imageType || 'empty_scene', ctx.pageNumber, params.backgroundRef.versionIndex);
    emptyScene = bg?.imageData || null;
    if (!emptyScene) throw new Error(`backgroundRef v${params.backgroundRef.versionIndex} not found`);
  } else {
    emptyScene = await loadEmptyScene(ctx.storyId, ctx.pageNumber);
  }
  const textInImage = ctx.layout?.textInImage !== false;
  const textAreaMask = textInImage && ctx.textPosition ? getTextAreaMask(ctx.textPosition, ctx.languageLevel) : null;

  // Visual Bible grid — same construction as the production page path: page
  // elements (minus locations when a background anchors the location already)
  // plus secondary landmarks, composited into one reference grid image.
  let visualBibleGrid = null;
  if (ctx.visualBible) {
    let elementReferences = getElementReferenceImagesForPage(ctx.visualBible, ctx.pageNumber, 6);
    if (emptyScene) elementReferences = elementReferences.filter(e => e.type !== 'location');
    const secondaryLandmarks = ctx.landmarkPhotos.slice(1);
    if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
      try {
        visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
      } catch (err) {
        log.warn(`[TESTLAB] VB grid build failed (continuing without): ${err.message}`);
      }
    }
  }

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, ctx.referencePhotos, {
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    landmarkPhotos: ctx.landmarkPhotos,
    visualBibleGrid,
    artStyle,
    sceneBackground: emptyScene,
    textAreaMask,
    pageNumber: ctx.pageNumber,
    skipCache: true,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('Image generation returned no image');

  let scores = null;
  if (autoEval) {
    try {
      const { evaluateImageQuality } = require('./images');
      const evalRes = await evaluateImageQuality(
        result.imageData, ctx.scene.sceneDescription, ctx.referencePhotos, 'scene',
        null, `testlab-exp${experimentId}-P${ctx.pageNumber}`,
        ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null
      );
      if (evalRes) {
        scores = {
          quality: evalRes.qualityScore ?? evalRes.score ?? null,
          final: evalRes.score ?? null,
          semantic: evalRes.semanticScore ?? null,
          verdict: evalRes.verdict || null,
          issuesSummary: evalRes.issuesSummary || null,
        };
      }
    } catch (err) {
      log.warn(`[TESTLAB] auto-eval failed: ${err.message}`);
      scores = { error: err.message };
    }
  }

  const versionIndex = await saveTestVersion(
    ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId,
    scores?.final != null ? Math.round(scores.final) : null
  );

  return { imageType: 'scene', versionIndex, promptUsed: prompt, modelId: result.modelId || null, elapsedMs, scores, artStyle: params.artStyleOverride || undefined };
}

async function runEmptySceneStage(ctx, { promptOverride, experimentId, params = {} }) {
  const { loadPromptTemplates, buildEmptyScenePrompt } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildTextZoneInstruction, buildEraGuard, buildLandmarkFidelityBlock, resolveArtStyleForEmptyScene } = require('./storyHelpers');
  const { generateImageOnly } = require('./images');
  const { getTextAreaMask } = require('./textMasks');
  const { MODEL_DEFAULTS } = require('../config/models');

  const meta = ctx.scene.sceneMetadata || {};
  const description = meta.emptyScenePrompt || ctx.scene.emptyScenePrompt || ctx.scene.sceneDescription;
  if (!description) throw new Error('No empty-scene description available for this page');

  // Text zone only when this story overlays text on the image AND the scene
  // has a position — production omits it for text-below layouts.
  const wantsTextZone = ctx.layout?.textInImage !== false && !!ctx.textPosition;
  const prompt = buildEmptyScenePrompt({
    template: promptOverride || undefined,
    style: resolveArtStyleForEmptyScene(params.artStyleOverride || ctx.artStyle, null),
    description,
    characterSpace: meta.characterSpace || '',
    textAreaInstruction: wantsTextZone
      ? buildTextZoneInstruction(ctx.textPosition, meta.textZoneDescription || null, 'a quarter of the frame', { isEmptyScene: true })
      : '',
    eraGuard: buildEraGuard(meta.era),
    landmarkFidelity: buildLandmarkFidelityBlock(ctx.landmarkPhotos[0] || null),
  });

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, [], {
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    landmarkPhotos: ctx.landmarkPhotos,
    textAreaMask: wantsTextZone ? getTextAreaMask(ctx.textPosition, ctx.languageLevel) : null,
    pageNumber: ctx.pageNumber,
    skipCache: true,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('Empty-scene generation returned no image');

  // Same QC the pipeline runs (pixel + Gemini vision) — report-only here, no
  // retry loop: the point is seeing whether a prompt variant passes the gate.
  // The calm-zone half needs a text position, so QC is skipped for text-below
  // layouts (production never validates those either).
  let qc = null;
  if (!wantsTextZone) qc = { pass: true, issues: [], skipped: 'no text zone (text-below layout)' };
  else try {
    const { validateEmptyScene } = require('./images');
    const qcRes = await validateEmptyScene(result.imageData, ctx.textPosition, `testlab-exp${experimentId}-P${ctx.pageNumber}`, {
      sceneDescription: description,
      mainScenePrompt: ctx.scene.sceneDescription || null,
      storyEra: meta.era || null,
    });
    qc = { pass: qcRes.pass, issues: qcRes.issues || [], visionFeedback: qcRes.visionFeedback || null };
  } catch (err) {
    log.warn(`[TESTLAB] empty-scene QC failed: ${err.message}`);
    qc = { error: err.message };
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'empty_scene', ctx.pageNumber, result.imageData, experimentId);
  return { imageType: 'empty_scene', versionIndex, promptUsed: prompt, modelId: result.modelId || null, elapsedMs, qc, artStyle: params.artStyleOverride || undefined };
}

async function runQualityEvalStage(ctx, { promptOverride, experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { evaluateImageQuality } = require('./images');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await evaluateImageQuality(
    imageData, ctx.scene.sceneDescription, ctx.referencePhotos, 'scene',
    null, `testlab-exp${experimentId}-P${ctx.pageNumber}`,
    ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
    { evalTemplateOverride: promptOverride || null }
  );
  const elapsedMs = Date.now() - t0;
  if (!result) throw new Error('Quality evaluation returned null');

  return {
    elapsedMs,
    scores: {
      quality: result.qualityScore ?? result.score ?? null,
      final: result.score ?? null,
      semantic: result.semanticScore ?? null,
      verdict: result.verdict || null,
    },
    issuesSummary: result.issuesSummary || null,
    fixableIssues: result.fixableIssues || [],
    figures: (result.figures || []).map(f => ({ name: f.name, match: f.match, issues: f.issues })),
    storedBaseline: { qualityScore: ctx.scene.qualityScore ?? null, semanticScore: ctx.scene.semanticScore ?? null },
  };
}

async function runSemanticEvalStage(ctx, { promptOverride, experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { evaluateSemanticFidelity } = require('./sceneValidator');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const storyText = ctx.scene.text || null;
  if (!storyText) throw new Error('Scene has no story text — semantic eval needs it');

  const t0 = Date.now();
  const result = await evaluateSemanticFidelity(
    imageData, storyText, ctx.scene.sceneDescription,
    ctx.outlineHint, promptOverride || null
  );
  const elapsedMs = Date.now() - t0;
  if (!result) throw new Error('Semantic evaluation returned null');

  return {
    elapsedMs,
    scores: { semantic: result.score ?? null, verdict: result.verdict || null },
    semanticIssues: result.semanticIssues || [],
    visible: result.visible || null,
    expected: result.expected || null,
    storedBaseline: { semanticScore: ctx.scene.semanticScore ?? null },
  };
}

/**
 * Expected-characters list for detection. Scene characters carry only names —
 * descriptions live in the prior detection's characterDescriptions and
 * positions in sceneMetadata.characterPositions.
 */
function buildExpectedCharacters(ctx) {
  const descriptions = ctx.scene.bboxDetection?.characterDescriptions || {};
  const positions = ctx.scene.sceneMetadata?.characterPositions || {};
  return (ctx.scene.sceneCharacters || ctx.referencePhotos || []).map(c => ({
    name: c.name,
    description: descriptions[c.name]?.richDescription || descriptions[c.name] || c.description || '',
    position: positions[c.name] || c.position || '',
  })).filter(c => c.name);
}

async function runBboxStage(ctx, { experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { detectAllBoundingBoxes } = require('./images');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const expectedCharacters = buildExpectedCharacters(ctx);

  const t0 = Date.now();
  const result = await detectAllBoundingBoxes(imageData, {
    expectedCharacters,
    sceneContext: (ctx.scene.sceneDescription || '').slice(0, 2000),
    artStyle: ctx.artStyle,
    skipCache: true,
    pageContext: `testlab-exp${experimentId}-P${ctx.pageNumber}`,
  });
  const elapsedMs = Date.now() - t0;
  if (!result) throw new Error('Bbox detection returned null');

  return {
    elapsedMs,
    detectionBackend: result.detectionBackend || null,
    figures: (result.figures || []).map(f => ({ name: f.name, bbox: f.bodyBox || f.bbox || f.box_2d, faceBbox: f.faceBox || f.faceBbox || null, confidence: f.confidence })),
    objects: (result.objects || []).map(o => ({ name: o.name, bbox: o.bodyBox || o.bbox || o.box_2d })),
  };
}

/**
 * Character box for a page: stored detection first, else run a fresh bbox
 * detection on the image (same call the bbox stage uses). Returns
 * {bbox, faceBbox, source} or null.
 */
async function resolveCharacterBox(ctx, imageData, charName) {
  // Figure boxes appear as bodyBox/faceBox (detection contract) or bbox/box_2d
  // (older records / repair params) depending on the writer.
  const fromDet = (det) => {
    const fig = (det?.figures || det?.characters || []).find(f => (f.name || '').toLowerCase() === charName.toLowerCase());
    if (!fig) return null;
    const bbox = fig.bodyBox || fig.bbox || fig.box_2d || null;
    return bbox?.length === 4 ? { bbox, faceBbox: fig.faceBox || fig.faceBbox || null } : null;
  };
  const stored = ctx._skipStoredBox ? null : fromDet(ctx.scene.bboxDetection);
  if (stored) return { ...stored, source: 'stored' };

  const { detectAllBoundingBoxes } = require('./images');
  const expectedCharacters = buildExpectedCharacters(ctx);
  const det = await detectAllBoundingBoxes(imageData, {
    expectedCharacters,
    sceneContext: (ctx.scene.sceneDescription || '').slice(0, 2000),
    artStyle: ctx.artStyle,
    skipCache: true,
    pageContext: `testlab-boxresolve-P${ctx.pageNumber}`,
  });
  const fresh = fromDet(det);
  return fresh ? { ...fresh, source: 'fresh-detection' } : null;
}

async function runCharRepairStage(ctx, opts) {
  const { experimentId, params = {} } = opts;
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { repairCharacterMismatch } = require('./images');

  const charName = params.characterName;
  if (!charName) throw new Error('char_repair requires params.characterName');

  // backend 'qwen' → crop-bounded Qwen REPLACEMENT at the character's box.
  // Repair mode: tight crop (large crops with other figures trigger full
  // re-imagination) + replace-wording (the scene already contains the figure).
  if (params.backend === 'qwen') {
    const r = await runQwenInsertStage(ctx, {
      ...opts,
      params: { ...params, base: params.base || 'active', repairMode: true, cropPad: params.cropPad ?? 0.15 },
    });
    return { ...r, backend: 'qwen', repairMode: 'qwen-replace' };
  }

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const ref = ctx.referencePhotos.find(p => (p.name || '').toLowerCase() === charName.toLowerCase());
  if (!ref) {
    const avail = ctx.referencePhotos.map(p => p.name).filter(Boolean).join(', ');
    throw new Error(`No reference photo for character "${charName}" on this page (available: ${avail || 'none'})`);
  }

  // Bbox: explicit param → stored detection → fresh detection on the image.
  // params.freshDetection skips the stored box (stale/misattributed names on
  // older stories) and always re-detects.
  let bbox = params.bbox || null;
  let faceBbox = params.faceBbox || null;
  let boxSource = bbox ? 'param' : null;
  if (!bbox) {
    if (params.freshDetection) ctx._skipStoredBox = true;
    const resolved = await resolveCharacterBox(ctx, imageData, charName);
    delete ctx._skipStoredBox;
    if (resolved) { bbox = resolved.bbox; faceBbox = faceBbox || resolved.faceBbox; boxSource = resolved.source; }
  }
  if (!bbox || bbox.length !== 4) {
    throw new Error(`"${charName}" not found on the page image (stored detection AND fresh detection both missed) — is the character actually visible?`);
  }

  // Mode mapping — the real repair options are the useBlended/useCutout/
  // useFullScene flags; 'auto' passes none and lets whiteoutTarget pick the
  // default exactly as the automatic pipeline does.
  const repairMode = params.repairMode || 'blended';
  const modeFlags = {};
  if (repairMode === 'blended') modeFlags.useBlended = true;
  else if (repairMode === 'cutout') modeFlags.useCutout = true;
  else if (repairMode === 'fullscene') modeFlags.useFullScene = true;
  else if (repairMode !== 'auto') throw new Error(`Unknown repairMode "${repairMode}" — use blended|cutout|fullscene|auto`);

  const backend = params.backend || 'grok';
  if (!['grok', 'gemini'].includes(backend)) throw new Error(`Unknown backend "${backend}" — use grok|gemini|qwen`);
  // The Gemini path is a single full-image repaint — it consumes NONE of the
  // mode flags / whiteoutTarget / faceBbox. Refuse a mode request it would
  // silently ignore instead of reporting it as honored.
  if (backend === 'gemini' && params.repairMode && params.repairMode !== 'auto') {
    throw new Error(`backend "gemini" ignores repairMode — it always does a full-image repaint. Use grok for blended/cutout/fullscene.`);
  }

  const t0 = Date.now();
  const result = await repairCharacterMismatch(imageData, ref.photoUrl, bbox, charName, {
    imageBackend: backend,
    ...(backend === 'grok' ? {
      ...modeFlags,
      faceBbox,
      whiteoutTarget: params.whiteoutTarget || 'face',
    } : {}),
  });
  const elapsedMs = Date.now() - t0;
  const repairedImage = result?.imageData || result?.repairedImage || null;
  if (!repairedImage) throw new Error('Character repair returned no image');

  // Every intermediate the repair produced, saved as tl_step test versions so
  // the UI can show the full chain, not just the final composite.
  const steps = [];
  const stepImages = [
    ['input: character reference', ref.photoUrl],
    ['sent to model (whiteout)', result?.blackoutImage || result?.comparison?.blackoutImage || result?.debug?.sceneSent],
    ['model raw output', result?.grokRawResult || result?.comparison?.grokRawResult],
  ];
  for (const [label, img] of stepImages) {
    if (typeof img === 'string' && img.startsWith('data:image')) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, img, experimentId);
      steps.push({ label, imageType: 'tl_step', versionIndex: v });
    }
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, repairedImage, experimentId);
  return {
    imageType: 'scene', versionIndex, characterName: charName, bbox, faceBbox: faceBbox || undefined, boxSource, backend,
    repairMode: backend === 'grok' ? repairMode : null,
    method: result?.method || null, steps, elapsedMs,
  };
}

async function runEntityStage(ctx, { experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { dbQuery, rehydrateStoryImages } = require('../services/database');
  const { runEntityConsistencyChecks } = require('./entityConsistency');

  const rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [ctx.storyId]);
  if (rows.length === 0) throw new Error('Story not found');
  let storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  storyData = await rehydrateStoryImages(ctx.storyId, storyData);

  const t0 = Date.now();
  const report = await runEntityConsistencyChecks(storyData, storyData.characters || [], {
    checkCharacters: true,
    checkObjects: false,
    saveGrids: false,
  });
  const elapsedMs = Date.now() - t0;

  // Strip any embedded image data from the report before persisting.
  const safe = JSON.parse(JSON.stringify(report, (key, value) => {
    if (typeof value === 'string' && value.startsWith('data:image')) return `[image ${Math.round(value.length / 1024)}KB]`;
    return value;
  }));
  return { elapsedMs, report: safe };
}

// ─────────────────────────────────────────────────────────────────────
// Avatar stages — production two-pass sheet flow, split so the realistic
// anchor (Pass 1) is generated once per character and every style transfer
// (Pass 2) reuses it.
// ─────────────────────────────────────────────────────────────────────

/** Character record + story costume description for one character. */
async function loadCharacterContext(storyId, characterName) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) throw new Error(`Story ${storyId} not found`);
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

  let characters = data.characters || [];
  const charRows = await dbQuery('SELECT data FROM characters WHERE id = $1', [`characters_${rows[0].user_id}`]);
  if (charRows.length) {
    const cd = typeof charRows[0].data === 'string' ? JSON.parse(charRows[0].data) : charRows[0].data;
    const canonical = Array.isArray(cd) ? cd : (cd.characters || []);
    if (canonical.length) characters = canonical;
  }
  const character = characters.find(c => c.name === characterName)
    || characters.find(c => (c.name || '').toLowerCase() === characterName.toLowerCase());
  if (!character) throw new Error(`Character "${characterName}" not found`);

  let costume = { category: 'standard', description: null };
  for (const scene of data.sceneImages || []) {
    const rp = (scene.referencePhotos || []).find(r => (r.name || '').toLowerCase() === characterName.toLowerCase());
    if (rp) { costume = { category: rp.clothingCategory || 'standard', description: rp.clothingDescription || null }; break; }
  }
  return { storyId, character, costume };
}

/** Pass 1: realistic anchor sheet (generated once per character, reused). */
async function runAvatarRealisticStage(target, { experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
  const { character, costume } = await loadCharacterContext(target.storyId, target.character);
  const t0 = Date.now();
  const result = await generateCharacter2x4Sheet(character, {
    clothingCategory: costume.category,
    costumeDescription: costume.description || 'standard outfit',
    artStyle: 'realistic',
  });
  if (!result?.imageData) throw new Error('no realistic sheet returned');
  const versionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, result.imageData, experimentId,
    result.finalScore != null ? Math.round(result.finalScore) : null);
  return {
    character: character.name, imageType: 'tl_avatar', versionIndex,
    pass: 1, artStyle: 'realistic', clothingCategory: costume.category,
    finalScore: result.finalScore ?? null, elapsedMs: Date.now() - t0,
  };
}

/** Pass 2: style transfer of an existing realistic sheet (never re-runs Pass 1). */
async function runAvatarStyleStage(target, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { runStyleTransferPass, resolveFacePhoto } = require('./character2x4Sheet');
  const artStyle = params.artStyle || target.artStyle;
  const realisticVersionIndex = params.realisticVersionIndex ?? target.realisticVersionIndex;
  if (!artStyle) throw new Error('avatar_style requires artStyle');
  if (realisticVersionIndex === undefined || realisticVersionIndex === null) {
    throw new Error('avatar_style requires realisticVersionIndex (run avatar_realistic first)');
  }
  const { character } = await loadCharacterContext(target.storyId, target.character);
  const sheet = await loadTestImage(target.storyId, 'tl_avatar', null, realisticVersionIndex);
  if (!sheet?.imageData) throw new Error(`realistic sheet v${realisticVersionIndex} not found`);
  const facePhoto = await resolveFacePhoto(character);

  const t0 = Date.now();
  const result = await runStyleTransferPass({
    pass1ImageData: sheet.imageData,
    facePhoto,
    artStyle,
    characterName: character.name,
    promptOverride: promptOverride || null,
  });
  if (!result?.imageData) throw new Error('style transfer returned no image');
  const versionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, result.imageData, experimentId,
    result.finalScore != null ? Math.round(result.finalScore) : null);
  return {
    character: character.name, imageType: 'tl_avatar', versionIndex,
    pass: 2, artStyle, realisticVersionIndex,
    finalScore: result.finalScore ?? null, elapsedMs: Date.now() - t0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Shared loaders for the repair-side stages
// ─────────────────────────────────────────────────────────────────────

/** Full story data (optionally rehydrated — always a full rehydrate; a
 * per-page fast path would need a proper single-page helper, none is exported
 * from services/database today). */
async function loadStoryDataFull(storyId, { rehydrate = true } = {}) {
  const db = require('../services/database');
  const rows = await db.dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) throw new Error(`Story ${storyId} not found`);
  let storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  if (rehydrate) {
    storyData = await db.rehydrateStoryImages(storyId, storyData);
  }
  return { storyData, userId: rows[0].user_id };
}

/**
 * Rebuild an evaluation-shaped object from the fields persisted on a scene —
 * what decideRepairMethod / the consolidator / inpaint read in the pipeline.
 * New-pipeline stories persist scoreBreakdown/consolidatedPlan/finalScore on
 * the imageVersions entries, not the scene root — fall back to the newest
 * version entry carrying each field.
 */
function storedEvalFromScene(scene) {
  const versions = Array.isArray(scene.imageVersions) ? scene.imageVersions : [];
  const newestWith = (field) => {
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i] && versions[i][field] != null) return versions[i][field];
    }
    return null;
  };
  const finalScore = scene.finalScore
    ?? newestWith('finalScore')
    ?? newestWith('evalScore')
    ?? scene.qualityScore
    ?? null;
  return {
    qualityScore: scene.qualityScore ?? newestWith('evalScore') ?? null,
    score: finalScore,
    finalScore,
    semanticScore: scene.semanticScore ?? null,
    scoreBreakdown: scene.scoreBreakdown || newestWith('scoreBreakdown') || null,
    fixableIssues: scene.fixableIssues || [],
    fixTargets: scene.fixTargets || [],
    issuesSummary: scene.qualityReasoning || scene.issuesSummary || null,
    semanticResult: scene.semanticResult
      || (scene.semanticIssues ? { semanticIssues: scene.semanticIssues } : null),
    consolidatedPlan: scene.consolidatedPlan || newestWith('consolidatedPlan') || null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cover + story-level stages
// ─────────────────────────────────────────────────────────────────────

const COVER_KEYS_SET = new Set(['frontCover', 'initialPage', 'backCover']);

/**
 * Cover render — same single entry point every production cover path uses
 * (iterateCover). Target: {storyId, coverType: frontCover|initialPage|backCover}.
 */
async function runCoverStage(target, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { iterateCover } = require('./coverIterate');
  const { MODEL_DEFAULTS } = require('../config/models');
  const { dbQuery } = require('../services/database');

  const coverKey = params.coverType || target.coverType;
  if (!COVER_KEYS_SET.has(coverKey)) {
    throw new Error(`cover requires coverType frontCover|initialPage|backCover (got "${coverKey}")`);
  }
  const { storyData, userId } = await loadStoryDataFull(target.storyId);
  if (!storyData.coverImages?.[coverKey]) {
    throw new Error(`Story has no ${coverKey} (covers were skipped for this story) — pick a story generated with covers`);
  }

  // Fresh canonical characters (avatar fallback), same as the regen endpoint.
  // characters.data can be array-shaped or {characters:[...]} — handle both.
  const charRows = await dbQuery('SELECT data FROM characters WHERE user_id = $1', [userId]);
  let freshCharData = charRows[0]?.data || {};
  if (typeof freshCharData === 'string') freshCharData = JSON.parse(freshCharData);
  const freshCharacters = Array.isArray(freshCharData) ? freshCharData : (freshCharData.characters || []);

  const t0 = Date.now();
  const result = await iterateCover(coverKey, storyData, {
    imageModel: MODEL_DEFAULTS.coverImage,
    freshCharacters,
    compositeCovers: false,
    promptTemplateOverride: promptOverride || null,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('Cover render returned no image');

  const versionIndex = await saveTestVersion(
    target.storyId, coverKey, null, result.imageData, experimentId,
    result.score != null ? Math.round(result.score) : null
  );
  return {
    imageType: coverKey, coverType: coverKey, versionIndex,
    promptUsed: result.prompt || null, modelId: result.modelId || null, elapsedMs,
    scores: { final: result.score ?? null },
    issuesSummary: result.reasoning || null,
  };
}

/** Cross-page style consistency check (report only). Target: {storyId}. */
async function runStyleCheckStage(target, { experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { checkStoryStyleConsistency } = require('./styleConsistency');
  const { storyData } = await loadStoryDataFull(target.storyId);
  const t0 = Date.now();
  const result = await checkStoryStyleConsistency(storyData);
  const elapsedMs = Date.now() - t0;
  const safe = JSON.parse(JSON.stringify(result, (key, value) => {
    if (typeof value === 'string' && value.startsWith('data:image')) return `[image ${Math.round(value.length / 1024)}KB]`;
    return value;
  }));
  return { elapsedMs, report: safe };
}

// ─────────────────────────────────────────────────────────────────────
// Text-zone + repair-side page stages
// ─────────────────────────────────────────────────────────────────────

/** Calm-zone detection + white-wash/retry — the production text-space path. */
async function runTextZoneStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { ensureCalmZone } = require('./textSpaceRepair');
  const { generateImageOnly } = require('./images');
  const { getTextAreaMask } = require('./textMasks');
  const { MODEL_DEFAULTS } = require('../config/models');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const textPosition = params.textPosition || ctx.textPosition;
  if (!textPosition) {
    throw new Error('This story renders text below the image (no text zone) — text_zone does not apply. Pass params.textPosition to force one.');
  }
  const textAreaMask = getTextAreaMask(textPosition, ctx.languageLevel);

  // Same wrapper the pipeline builds (ensureCalmZone never imports images.js).
  const generateImage = (repairPrompt, opts) => generateImageOnly(repairPrompt, ctx.referencePhotos, {
    landmarkPhotos: ctx.landmarkPhotos,
    previousImage: opts.previousImage,
    textAreaMask: opts.textAreaMask,
    pageNumber: ctx.pageNumber,
    skipCache: true,
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
  });

  const t0 = Date.now();
  const result = await ensureCalmZone({
    imageData,
    text: ctx.scene.text || '',
    textPosition,
    pageNumber: ctx.pageNumber,
    languageLevel: ctx.languageLevel,
    textAreaMask,
    sceneDescription: ctx.scene.sceneDescription || '',
    generateImage,
    label: 'TESTLAB-TEXT-SPACE',
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.winnerImageData) throw new Error('ensureCalmZone returned no winner image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.winnerImageData, experimentId);
  return {
    imageType: 'scene', versionIndex, elapsedMs,
    textZone: {
      candidates: (result.candidates || []).map(c => ({
        source: c.source, position: c.position, rect: c.rect,
        calmFoundPx: c.calmFoundPx, areaPx: c.areaPx,
      })),
      winnerSource: (result.candidates || []).find(c => c.imageData === result.winnerImageData)?.source || null,
    },
  };
}

/** Feedback consolidator on the page's stored eval + entity issues (report only). */
async function runConsolidateStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { consolidateEvaluation } = require('./feedbackConsolidator');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const evalResult = params.evaluation || storedEvalFromScene(ctx.scene);
  const t0 = Date.now();
  const result = await consolidateEvaluation({
    evalResult,
    entityIssues: params.entityIssues || [],
    sceneDescription: ctx.scene.sceneDescription || '',
    characters: storyData.characters || [],
    storyId: ctx.storyId,
    pageNumber: ctx.pageNumber,
    round: 0,
  });
  const elapsedMs = Date.now() - t0;
  return { elapsedMs, plan: result?.plan || null, dedupedIssues: result?.dedupedIssues || null, skipped: !!result?.skipped, consolidateError: result?.error || null };
}

/** Targeted inpaint from the stored (or supplied) eval — the pipeline's inpaintPage. */
async function runInpaintStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { inpaintPage } = require('./images');
  const { MODEL_DEFAULTS } = require('../config/models');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const evaluation = params.evaluation || storedEvalFromScene(ctx.scene);

  const t0 = Date.now();
  const result = await inpaintPage(imageData, evaluation, {
    visualBible: ctx.visualBible,
    characters: storyData.characters || [],
    pageNumber: ctx.pageNumber,
    sceneDescription: ctx.scene.sceneDescription || '',
    artStyle: ctx.artStyle,
    clothingRequirements: storyData.clothingRequirements || null,
    storyId: ctx.storyId,
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.repaired || !result?.imageData) {
    throw new Error(result?.error || 'inpaint produced no result (nothing actionable?)');
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return {
    imageType: 'scene', versionIndex, elapsedMs,
    inpaintInstruction: result.instruction || null,
    plan: result.consolidatedPlan || null,
  };
}

/** Full page re-render via the iterate path (iteratePageCore). */
async function runIterateStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { iteratePageCore } = require('./images');
  const { storyData } = await loadStoryDataFull(ctx.storyId);

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await iteratePageCore(imageData, ctx.pageNumber, storyData, {
    evaluationFeedback: params.feedback || null,
    useOriginalAsReference: params.useOriginalAsReference === true,
    freeIterate: params.freeIterate === true,
    aspectRatio: ctx.layout?.imageAspect || null,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('iterate produced no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return {
    imageType: 'scene', versionIndex, elapsedMs, modelId: result.modelId || null,
    promptUsed: result.imagePrompt || null,
    newSceneDescription: result.newScene || null,
  };
}

/**
 * ONE full automatic repair round on one page, exactly as the pipeline decides:
 * stored eval + entity report → decideRepairMethod → inpaint / iterate /
 * char-fix (auto mode). The truest test of the automatic repair chain.
 */
async function runRepairRoundStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { decideRepairMethod } = require('./repairLogic');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const latestEval = params.evaluation || storedEvalFromScene(ctx.scene);
  const entityReport = params.entityReport || storyData.finalChecksReport?.entity || null;
  const decision = decideRepairMethod(ctx.pageNumber, latestEval, entityReport);

  const base = { decision: { method: decision.method, reason: decision.reason, charName: decision.charName || null } };
  if (decision.method === 'skip') {
    return { ...base, skippedRepair: true, elapsedMs: 0 };
  }
  if (decision.method === 'inpaint') {
    const r = await runInpaintStage(ctx, { experimentId, params });
    return { ...base, ...r };
  }
  if (decision.method === 'iterate') {
    // iteratePageCore expects the evaluation OBJECT ({score, fixableIssues, …}),
    // same as the pipeline passes — not a text summary.
    const r = await runIterateStage(ctx, { experimentId, params: { ...params, feedback: latestEval } });
    return { ...base, ...r };
  }
  if (decision.method === 'char-fix') {
    const r = await runCharRepairStage(ctx, {
      experimentId,
      params: { ...params, characterName: decision.charName, repairMode: 'auto' },
    });
    return { ...base, ...r };
  }
  throw new Error(`Unknown repair decision "${decision.method}"`);
}

/** Freeform prompt edit of the page image (editImageWithPrompt). */
async function runEditImageStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { editImageWithPrompt } = require('./images');

  const instruction = params.instruction || promptOverride;
  if (!instruction) throw new Error('edit_image requires params.instruction (or a prompt override) — the edit text');
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);

  const t0 = Date.now();
  const result = await editImageWithPrompt(imageData, instruction, null, [], ctx.artStyle);
  const elapsedMs = Date.now() - t0;
  const edited = result?.imageData || null;
  if (!edited) throw new Error('edit produced no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, edited, experimentId);
  // editImageWithPrompt reports the model at usage.model (no top-level modelId).
  return { imageType: 'scene', versionIndex, elapsedMs, modelId: result.usage?.model || null, promptUsed: instruction };
}

/**
 * Grid-based artifact repair. Contract (gridBasedRepair.js):
 * (imageDataUri, pageNumber, {quality, incremental, final}, {outputDir, ...})
 * — same call shape as images.js generateImageWithQualityRetry.
 */
async function runArtifactRepairStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { gridBasedRepair } = require('./gridBasedRepair');
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const stored = storedEvalFromScene(ctx.scene);
  const evalResults = {
    quality: {
      score: stored.finalScore,
      fixTargets: stored.fixTargets.length ? stored.fixTargets : stored.fixableIssues,
      reasoning: stored.issuesSummary,
      matches: [],
    },
    incremental: null,
    final: null,
  };
  const outputDir = path.join(os.tmpdir(), `testlab-grid-${ctx.storyId}-P${ctx.pageNumber}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const t0 = Date.now();
  const result = await gridBasedRepair(imageData, ctx.pageNumber, evalResults, {
    outputDir,
    storyId: ctx.storyId,
    skipVerification: false,
    saveIntermediates: false,
    bboxDetection: ctx.scene.bboxDetection || null,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.repaired || !result?.imageData) {
    throw new Error(`artifact repair made no changes (fixed ${result?.fixedCount || 0}/${result?.totalIssues || 0} issues)`);
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return {
    imageType: 'scene', versionIndex, elapsedMs,
    artifactRepair: { fixedCount: result.fixedCount || 0, failedCount: result.failedCount || 0, totalIssues: result.totalIssues || 0 },
  };
}

/** Tiny-background-figure scale repair (needs depth=background in metadata). */
async function runScaleRepairStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { needsScaleRepair, runScaleRepair } = require('./scaleRepair');
  const { extractSceneMetadata } = require('./storyHelpers');

  const sceneMetadata = ctx.scene.sceneMetadata || extractSceneMetadata(ctx.scene.sceneDescription || '') || {};
  if (!needsScaleRepair(sceneMetadata)) {
    throw new Error('Scene does not need scale repair (no depth=background characters in metadata)');
  }
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await runScaleRepair(imageData, sceneMetadata, { pageNumber: ctx.pageNumber });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('scale repair produced no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return { imageType: 'scene', versionIndex, elapsedMs };
}

/** Restyle the page image (applyStyleTransfer, style-transfer.txt). */
async function runStyleTransferStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { applyStyleTransfer } = require('./images');

  const artStyle = params.artStyle || ctx.artStyle;
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await applyStyleTransfer(imageData, artStyle);
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('style transfer produced no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return { imageType: 'scene', versionIndex, elapsedMs, artStyle, modelId: result.modelId || null };
}

/**
 * Report which stored version pick-best would choose — delegates to the
 * CANONICAL scorer (scoring.js computeFinalScore/pickBestVersionIndex; handles
 * every version shape: finalScore, evalScore−entityPenalty, legacy
 * qualityScore). Pinning lives in stories.image_version_meta, not on the scene.
 */
async function runPickBestStage(ctx, { experimentId }) {
  const { computeFinalScore, pickBestVersionIndex } = require('./scoring');
  const { dbQuery } = require('../services/database');

  const raw = ctx.scene.imageVersions || [];
  const versions = raw.map((v, i) => ({
    index: i,
    type: v.type || null,
    finalScore: computeFinalScore(v),
    generatedAt: v.generatedAt || v.evaluatedAt || null,
  }));
  if (versions.length === 0) {
    return { versions: [], winner: null, note: 'Page has no imageVersions entries — nothing to rank', elapsedMs: 0 };
  }
  const winnerIdx = pickBestVersionIndex(raw, { tieBreak: 'latest' });
  const metaRows = await dbQuery('SELECT image_version_meta FROM stories WHERE id = $1', [ctx.storyId]);
  const pageMeta = metaRows[0]?.image_version_meta?.[String(ctx.pageNumber)] || null;
  return {
    versions,
    winner: winnerIdx >= 0 ? versions[winnerIdx] : null,
    active: pageMeta ? { activeVersion: pageMeta.activeVersion ?? null, pinned: !!pageMeta.pinned } : null,
    elapsedMs: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Text-side stages (LLM only)
// ─────────────────────────────────────────────────────────────────────

/** Re-run the Art Director expansion for one page (scene-expansion.txt). */
async function runSceneExpansionStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneExpansionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const { callTextModel } = require('./textModels');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const characters = (storyData.characters || []).filter(c =>
    (ctx.scene.sceneCharacters || []).some(sc => (sc.name || sc) === c.name)
  );
  const availableAvatars = buildAvailableAvatarsForPrompt
    ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
    : '';

  // buildSceneExpansionPrompt is synchronous — same safe swap window as image.
  let prompt;
  const orig = PROMPT_TEMPLATES.sceneExpansion;
  if (promptOverride) PROMPT_TEMPLATES.sceneExpansion = promptOverride;
  try {
    prompt = buildSceneExpansionPrompt(
      ctx.pageNumber,
      ctx.scene.text || '',
      characters.length ? characters : (storyData.characters || []),
      ctx.language,
      ctx.visualBible,
      availableAvatars,
      null,
      { referencePhotos: ctx.referencePhotos }
    );
  } finally {
    PROMPT_TEMPLATES.sceneExpansion = orig;
  }

  const t0 = Date.now();
  const result = await callTextModel(prompt, 10000, null, { usageLabel: 'testlab_scene_expansion' });
  const elapsedMs = Date.now() - t0;
  return {
    elapsedMs, modelId: result.modelId || null, promptUsed: prompt,
    newSceneDescription: result.text,
    storedSceneDescription: ctx.scene.sceneDescription || null,
  };
}

/**
 * Scene-expansion A/B with images: run the Art Director twice on the same
 * page — variant A = current scene-expansion template, variant B = template
 * + an extra rule (params.extraRule; promptOverride, when set, IS the full
 * variant-B template) — then render one image per resulting scene
 * description. Both images save as test versions; the result carries both
 * pointers for a side-by-side card.
 *
 * Default extraRule tests the near-touch choreography fix: "reaching toward
 * but not touching" specs collapse into touching in generated images, then
 * fail evaluation round after round.
 */
const DEFAULT_AB_EXTRA_RULE = 'Interactions must show either clear contact or clear separation; never a hand reaching toward another character without touching.';

// Appended to every Test-Lab expansion run (stage-level, not a user rule):
// production scenes get their sceneIntent from the unified outline, which a
// standalone expansion run doesn't have.
const SCENE_INTENT_FIELD_INSTRUCTION = 'In the metadata JSON also include "sceneIntent": one short present-tense sentence naming who does what, where — it becomes the top overview line of the image prompt.';

async function runSceneExpansionAbStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneExpansionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const { callTextModel } = require('./textModels');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const characters = (storyData.characters || []).filter(c =>
    (ctx.scene.sceneCharacters || []).some(sc => (sc.name || sc) === c.name)
  );
  const availableAvatars = buildAvailableAvatarsForPrompt
    ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
    : '';

  const baseTemplate = PROMPT_TEMPLATES.sceneExpansion;
  const extraRule = params.extraRule || DEFAULT_AB_EXTRA_RULE;
  const variantTemplate = promptOverride || `${baseTemplate}\n${extraRule}`;

  // Build both prompts with the same safe synchronous swap window.
  const buildWith = (template) => {
    const orig = PROMPT_TEMPLATES.sceneExpansion;
    PROMPT_TEMPLATES.sceneExpansion = template;
    try {
      return buildSceneExpansionPrompt(
        ctx.pageNumber,
        ctx.scene.text || '',
        characters.length ? characters : (storyData.characters || []),
        ctx.language,
        ctx.visualBible,
        availableAvatars,
        null,
        { referencePhotos: ctx.referencePhotos }
      );
    } finally {
      PROMPT_TEMPLATES.sceneExpansion = orig;
    }
  };
  const promptA = buildWith(`${baseTemplate}\n${SCENE_INTENT_FIELD_INSTRUCTION}`);
  const promptB = buildWith(`${variantTemplate}\n${SCENE_INTENT_FIELD_INSTRUCTION}`);

  const t0 = Date.now();
  const [resA, resB] = await Promise.all([
    callTextModel(promptA, 10000, null, { usageLabel: 'testlab_scene_expansion_ab' }),
    callTextModel(promptB, 10000, null, { usageLabel: 'testlab_scene_expansion_ab' }),
  ]);

  // Render each variant's scene description through the standard image stage
  // (shallow ctx clone with the description swapped — reuses refs, VB grid,
  // background anchor, eval, and test-version storage unchanged).
  const renderFor = (sceneDescription) => runImageStage(
    { ...ctx, scene: { ...ctx.scene, sceneDescription } },
    { experimentId, autoEval: params.autoEval !== false, params: {} }
  );
  const imgA = await renderFor(resA.text);
  const imgB = await renderFor(resB.text);
  const elapsedMs = Date.now() - t0;

  return {
    imageType: 'scene',
    // A occupies the standard slot (versionIndex) so existing promote/render
    // paths work; B rides in variant fields.
    versionIndex: imgA.versionIndex,
    variantVersionIndex: imgB.versionIndex,
    scores: imgA.scores,
    variantScores: imgB.scores,
    newSceneDescriptionA: resA.text,
    newSceneDescriptionB: resB.text,
    extraRule,
    promptOverridden: !!promptOverride,
    // Full prompts for the details view — the card itself shows the diff.
    promptUsedA: promptA,
    promptUsedB: promptB,
    elapsedMs,
    modelId: imgA.modelId || null,
  };
}

/**
 * Single scene-expansion variant: base template + params.extraRule (or a
 * full promptOverride template) → one scene description → one image → eval.
 * The iterative sibling of scene_expansion_ab: run it as many times as
 * there are rule ideas (C, D, E, …); each experiment is one attempt, the
 * experiments list accumulates the series, and a winning rule is then run
 * across more benchmark targets.
 */
async function runSceneVariantStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneExpansionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const { callTextModel } = require('./textModels');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const characters = (storyData.characters || []).filter(c =>
    (ctx.scene.sceneCharacters || []).some(sc => (sc.name || sc) === c.name)
  );
  const availableAvatars = buildAvailableAvatarsForPrompt
    ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
    : '';

  const extraRule = params.extraRule || null;
  // In production the DEPICTS overview (sceneIntent) comes from the unified
  // OUTLINE and is merged into the scene metadata — a fresh Test-Lab
  // expansion has no outline pass, so the stage asks the expansion to emit
  // its own (consistent with its own staging). Without this the rendered
  // image prompt loses its top overview line.
  const template = (promptOverride || (extraRule ? `${PROMPT_TEMPLATES.sceneExpansion}\n${extraRule}` : PROMPT_TEMPLATES.sceneExpansion))
    + `\n${SCENE_INTENT_FIELD_INSTRUCTION}`;

  let prompt;
  const orig = PROMPT_TEMPLATES.sceneExpansion;
  PROMPT_TEMPLATES.sceneExpansion = template;
  try {
    prompt = buildSceneExpansionPrompt(
      ctx.pageNumber,
      ctx.scene.text || '',
      characters.length ? characters : (storyData.characters || []),
      ctx.language,
      ctx.visualBible,
      availableAvatars,
      null,
      { artStyleId: ctx.artStyle, referencePhotos: ctx.referencePhotos }
    );
  } finally {
    PROMPT_TEMPLATES.sceneExpansion = orig;
  }

  const t0 = Date.now();
  const res = await callTextModel(prompt, 10000, null, { usageLabel: 'testlab_scene_variant' });
  const img = await runImageStage(
    { ...ctx, scene: { ...ctx.scene, sceneDescription: res.text } },
    { experimentId, autoEval: params.autoEval !== false, params: {} }
  );
  return {
    imageType: 'scene',
    versionIndex: img.versionIndex,
    scores: img.scores,
    newSceneDescription: res.text,
    storedSceneDescription: ctx.scene.sceneDescription || null,
    extraRule,
    promptOverridden: !!promptOverride,
    // The IMAGE prompt actually sent to the image model — the contract the
    // result must fulfil (scene overview at top, interactions at bottom).
    // Always displayed in full on the card. promptUsed = the Art Director
    // prompt that produced the scene description (detail view).
    imagePrompt: img.promptUsed || null,
    promptUsed: prompt,
    elapsedMs: Date.now() - t0,
    modelId: img.modelId || null,
  };
}

/** Re-run the scene-description regen (scene-iteration.txt, same as /regenerate/scene-description). */
async function runSceneDescriptionStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneDescriptionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const { callClaudeAPI } = require('./textModels');
  // resolveSceneIterationModel guards the OpenRouter-hosted default and falls
  // back to Sonnet without the key — raw MODEL_DEFAULTS.sceneIteration throws.
  const { resolveSceneIterationModel } = require('../config/models');
  const { storyData } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const availableAvatars = buildAvailableAvatarsForPrompt
    ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
    : '';

  let prompt;
  const orig = PROMPT_TEMPLATES.sceneDescriptions;
  if (promptOverride) PROMPT_TEMPLATES.sceneDescriptions = promptOverride;
  try {
    prompt = buildSceneDescriptionPrompt(
      ctx.pageNumber, ctx.scene.text || '', storyData.characters || [], '',
      ctx.language, ctx.visualBible, [], 'standard', '', availableAvatars
    );
  } finally {
    PROMPT_TEMPLATES.sceneDescriptions = orig;
  }

  const t0 = Date.now();
  const result = await callClaudeAPI(prompt, 10000, resolveSceneIterationModel(), {
    prefill: '{"previewMismatches":[', usageLabel: 'testlab_scene_description',
  });
  const elapsedMs = Date.now() - t0;
  return {
    elapsedMs, modelId: result.modelId || null, promptUsed: prompt,
    newSceneDescription: result.text,
    storedSceneDescription: ctx.scene.sceneDescription || null,
  };
}

/**
 * Crop-bounded Qwen character insertion (composite-v2 recipe, validated
 * 2026-07-17 — docs/tests/qwen-composite-experiment.html). Crops the target
 * region + margin, has Qwen-Image-Edit-2511 insert the character into the
 * CROP (the model never sees the rest of the page, so the background is
 * pixel-immutable by construction), then pastes the crop back with a
 * feathered edge. Full-page Qwen edits re-imagine the layout — never widen
 * the canvas.
 *
 * params:
 *   characterName  (required) — matched against the scene's referencePhotos
 *   crop           {x,y,w,h} normalized 0-1 — target region. Falls back to
 *                  the character's stored detection box, padded.
 *   pose           short pose/scale phrase woven into the prompt
 *   base           'active' (default) | 'empty_scene' | {imageType, versionIndex}
 * promptOverride replaces the whole built prompt (crop refs stay).
 * Crops for different figures must NOT overlap — a later crop repaints
 * whatever the earlier one inserted.
 */
async function runQwenInsertStage(ctx, { experimentId, promptOverride, params = {} }) {
  const sharp = require('sharp');
  const { editWithQwen } = require('./runware');

  const charName = params.characterName;
  if (!charName) throw new Error('qwen_insert requires params.characterName');
  const ref = ctx.referencePhotos.find(p => (p.name || '').toLowerCase() === charName.toLowerCase());
  if (!ref) throw new Error(`No reference photo for "${charName}" on this page`);

  // Base canvas
  let baseUri;
  if (params.base === 'empty_scene') {
    baseUri = await loadEmptyScene(ctx.storyId, ctx.pageNumber);
    if (!baseUri) throw new Error('No empty scene stored for this page');
  } else if (params.base && typeof params.base === 'object') {
    const img = await loadTestImage(ctx.storyId, params.base.imageType || 'scene', ctx.pageNumber, params.base.versionIndex);
    baseUri = img?.imageData;
    if (!baseUri) throw new Error(`base version v${params.base.versionIndex} not found`);
  } else {
    baseUri = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  }
  const baseBuf = Buffer.from(baseUri.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const meta = await sharp(baseBuf).metadata();
  const W = meta.width, H = meta.height;

  // Crop region: explicit normalized rect, else padded detection box.
  let crop = null;
  let figureBox = null; // page-normalized [ymin,xmin,ymax,xmax] when detection-derived
  if (params.crop && [params.crop.x, params.crop.y, params.crop.w, params.crop.h].every(v => typeof v === 'number')) {
    crop = {
      x: Math.round(params.crop.x * W), y: Math.round(params.crop.y * H),
      w: Math.round(params.crop.w * W), h: Math.round(params.crop.h * H),
    };
  } else {
    // Stored detection first, else fresh detection (resolveCharacterBox);
    // params.freshDetection forces a re-detect.
    if (params.freshDetection) ctx._skipStoredBox = true;
    const resolved = await resolveCharacterBox(ctx, baseUri, charName).catch(() => null);
    delete ctx._skipStoredBox;
    const box = resolved?.bbox; // [ymin,xmin,ymax,xmax] 0-1
    if (box?.length === 4) figureBox = box;
    if (box?.length === 4) {
      const pad = params.cropPad ?? 0.35;
      const padX = (box[3] - box[1]) * pad, padY = (box[2] - box[0]) * pad * 0.6;
      crop = {
        x: Math.round(Math.max(0, box[1] - padX) * W),
        y: Math.round(Math.max(0, box[0] - padY) * H),
        w: Math.round(Math.min(1, box[3] - box[1] + 2 * padX) * W),
        h: Math.round(Math.min(1, box[2] - box[0] + 2 * padY) * H),
      };
    }
  }
  if (!crop) throw new Error('qwen_insert needs params.crop {x,y,w,h} (normalized 0-1) — the character was not found on the base image either');
  crop.x = Math.max(0, Math.min(W - 64, crop.x));
  crop.y = Math.max(0, Math.min(H - 64, crop.y));
  crop.w = Math.min(W - crop.x, crop.w);
  crop.h = Math.min(H - crop.y, crop.h);

  const cropBuf = await sharp(baseBuf).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).jpeg({ quality: 95 }).toBuffer();

  // Repair mode: white-out the target figure's SILHOUETTE inside the crop
  // (same trick Grok blended repair uses) — turns "replace" into "paint into
  // the white gap", the operation Qwen actually performs faithfully. Plain
  // replace-wording made the model re-imagine the whole crop (exp #11/#12).
  // Figure-mask fetch with warm-up retries: the Python service lazy-loads
  // MobileSAM (~90s cold after a deploy) against a 30s HTTP timeout — the
  // first call after a restart reliably times out. Retry while it warms.
  const fetchMaskWithRetry = async (buf, box, tries = 3) => {
    const { fetchFigureMaskPng } = require('./images');
    for (let i = 0; i < tries; i++) {
      const m = await fetchFigureMaskPng(buf, box);
      if (m) return m;
      if (i < tries - 1) {
        log.info(`[TESTLAB] figure mask unavailable (attempt ${i + 1}/${tries}) — waiting for model warm-up`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    return null;
  };

  let sentBuf = cropBuf;
  let whiteoutApplied = false;
  let oldMaskPng = null; // SAM silhouette of the ORIGINAL figure — reused for the blend
  let boxInCrop = null;
  if (params.repairMode && figureBox) {
    try {
      const { fetchFigureMaskPng } = require('./images');
      boxInCrop = [
        Math.max(0, Math.round(figureBox[1] * W) - crop.x),
        Math.max(0, Math.round(figureBox[0] * H) - crop.y),
        Math.min(crop.w, Math.round(figureBox[3] * W) - crop.x),
        Math.min(crop.h, Math.round(figureBox[2] * H) - crop.y),
      ];
      oldMaskPng = await fetchMaskWithRetry(cropBuf, boxInCrop);
      if (oldMaskPng) {
        sentBuf = await sharp(cropBuf).composite([{ input: oldMaskPng, left: 0, top: 0 }]).jpeg({ quality: 95 }).toBuffer();
        whiteoutApplied = true;
      }
    } catch (err) {
      log.warn(`[TESTLAB] qwen repair whiteout unavailable (${err.message}) — falling back to replace wording`);
    }
  }

  // Render at ~2x for detail; Runware dims must be multiples of 64 in [128,2048].
  const snap = v => Math.max(128, Math.min(2048, Math.round(v / 64) * 64));
  const rw = snap(crop.w * 2), rh = snap(crop.h * 2);

  const pose = params.pose || 'standing naturally, scale matching the scene perspective';
  const prompt = promptOverride
    || (params.repairMode
      ? (whiteoutApplied
        ? `Paint the person from the second image into the white silhouette area of the first image. The silhouette shows their exact position, pose and scale — fill it with that person in that pose. The painted person must have the EXACT same face, age, hair color and clothing as shown in the second image${ref.clothingDescription ? ` (${ref.clothingDescription})` : ''}. Keep everything outside the white area exactly unchanged: same background, same other people, same objects, same colors, same framing. Match the illustration style and lighting.`
        : `Replace the person in the first image with the person from the second image: SAME position, SAME pose, SAME scale as the existing figure — only the face and appearance change to match the second image. Keep everything else in the first image exactly unchanged: same background, same other people, same objects, same colors, same framing. Match the illustration style.`)
      : `Insert the person from the second image into the watercolor scene from the first image: ${pose}. Keep the background of the scene exactly as it is — same objects, same colors, same framing. Match the illustration style and lighting, add a soft contact shadow.`);

  const t0 = Date.now();
  const result = await editWithQwen(prompt, [
    `data:image/jpeg;base64,${sentBuf.toString('base64')}`,
    ref.photoUrl,
  ], { width: rw, height: rh });
  const elapsedMs = Date.now() - t0;

  // Save the intermediates IMMEDIATELY — before gating can throw. A failed
  // run must still show what was sent and what the model produced, otherwise
  // the failure is undiagnosable from the UI. ALL inputs appear: the crop,
  // the character reference, and the model's raw output.
  const outBufEarly = Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const steps = [];
  const addStep = async (label, dataUri) => {
    const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, dataUri, experimentId);
    steps.push({ label, imageType: 'tl_step', versionIndex: v });
  };
  await addStep(whiteoutApplied ? 'input 1: crop (figure whiteout)' : 'input 1: crop sent to model', `data:image/jpeg;base64,${sentBuf.toString('base64')}`);
  await addStep('input 2: character reference', ref.photoUrl);
  await addStep('model raw output', `data:image/jpeg;base64,${outBufEarly.toString('base64')}`);

  // Paste back. Default 'figure' mode: within the crop, keep ONLY the changed
  // blob (the inserted figure + its shadow, diff vs the original crop,
  // despeckled + dilated + feathered) — the model's incidental background
  // repaint inside the crop is discarded, so no rectangle seam. 'crop' mode
  // pastes the whole crop with a rectangular feather (debug/fallback).
  const back = await sharp(outBufEarly).resize(crop.w, crop.h, { fit: 'fill' }).toBuffer();
  let feathered;

  // Repair blend: SAM SILHOUETTE UNION (production Grok-blended technique) —
  // mask of the OLD figure (already fetched for the whiteout) ∪ mask of the
  // NEW figure in the model output. Exact figure pixels, no diff-blob
  // guessing, no half-mixed colors. Falls through to the diff blob only when
  // SAM is unavailable.
  if ((params.pasteMode || 'figure') === 'figure' && params.repairMode && oldMaskPng && boxInCrop) {
    try {
      const newMaskPng = await fetchMaskWithRetry(back, boxInCrop);
      if (newMaskPng) {
        const raw1 = { raw: { width: crop.w, height: crop.h, channels: 1 } };
        const oldA = await sharp(oldMaskPng).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        const newA = await sharp(newMaskPng).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        const n = crop.w * crop.h;

        // Union = every pixel that must come from the model output (new figure
        // pixels, plus the model's background infill where the old figure was).
        // XOR = the DISAGREEMENT band — where the model filled more or less of
        // the silhouette than the original figure occupied. That band is where
        // seams appear; agreed edges are true figure edges and stay crisp.
        const union = Buffer.alloc(n);
        const xor = Buffer.alloc(n);
        for (let i = 0; i < n; i++) {
          const o = (oldA[i] || 0) > 128 ? 255 : 0;
          const w = (newA[i] || 0) > 128 ? 255 : 0;
          union[i] = Math.max(o, w);
          xor[i] = o !== w ? 255 : 0;
        }

        // Visualize the disagreement: red = old-only (model infilled background
        // there), green = new-only (figure grew beyond the old silhouette).
        const diffRgb = Buffer.alloc(n * 3);
        for (let i = 0; i < n; i++) {
          const o = (oldA[i] || 0) > 128, w = (newA[i] || 0) > 128;
          diffRgb[i * 3] = o && !w ? 255 : 40;
          diffRgb[i * 3 + 1] = w && !o ? 255 : 40;
          diffRgb[i * 3 + 2] = 40;
        }
        const diffJpeg = await sharp(diffRgb, { raw: { width: crop.w, height: crop.h, channels: 3 } }).jpeg().toBuffer();
        await addStep('mask difference (red = old-only, green = new-only)', `data:image/jpeg;base64,${diffJpeg.toString('base64')}`);

        // Selective feathering: crisp alpha (1px soften) everywhere, WIDE
        // feather only inside the dilated disagreement zone.
        const strip = (buf) => {
          const s = Math.max(1, Math.round(buf.length / n));
          if (s === 1) return buf;
          const out = Buffer.alloc(n);
          for (let i = 0; i < n; i++) out[i] = buf[i * s];
          return out;
        };
        const crisp = strip(await sharp(union, raw1).blur(1).raw().toBuffer());
        const soft = strip(await sharp(union, raw1).blur(6).raw().toBuffer());
        const zone = strip(await sharp(xor, raw1).blur(5).threshold(16).blur(2).raw().toBuffer()); // dilated disagreement
        const alpha1 = Buffer.alloc(n);
        for (let i = 0; i < n; i++) {
          const z = zone[i] / 255;
          alpha1[i] = Math.round(crisp[i] * (1 - z) + soft[i] * z);
        }
        const maskJpeg = await sharp(Buffer.from(alpha1), raw1).jpeg().toBuffer();
        await addStep('blend mask (crisp on agreed edges, feathered on disagreement)', `data:image/jpeg;base64,${maskJpeg.toString('base64')}`);
        feathered = await sharp(back).ensureAlpha().joinChannel(Buffer.from(alpha1), raw1).png().toBuffer();
      }
    } catch (err) {
      log.warn(`[TESTLAB] SAM union blend unavailable (${err.message}) — falling back to diff blob`);
    }
  }

  if (!feathered && (params.pasteMode || 'figure') === 'figure') {
    const origRaw = await sharp(cropBuf).resize(crop.w, crop.h, { fit: 'fill' }).raw().toBuffer();
    const newRaw = await sharp(back).raw().toBuffer();
    const bin = Buffer.alloc(crop.w * crop.h);
    for (let i = 0; i < crop.w * crop.h; i++) {
      const d = Math.max(
        Math.abs(origRaw[i * 3] - newRaw[i * 3]),
        Math.abs(origRaw[i * 3 + 1] - newRaw[i * 3 + 1]),
        Math.abs(origRaw[i * 3 + 2] - newRaw[i * 3 + 2]));
      bin[i] = d > 30 ? 255 : 0;
    }
    const raw1 = { raw: { width: crop.w, height: crop.h, channels: 1 } };
    const dense = await sharp(bin, raw1).blur(4).threshold(96).toBuffer();     // despeckle
    const alpha = await sharp(dense, raw1).blur(5).threshold(20).blur(4).raw().toBuffer(); // dilate + feather
    // Re-imagination guard: a figure change owns a figure-sized blob. If the
    // model repainted (almost) the whole crop, gating would degrade to a
    // visible rectangle paste — fail loudly instead of shipping that.
    // (alpha may come back multi-channel from sharp's raw round-trip — stride it.)
    const n = crop.w * crop.h;
    const stride = Math.max(1, Math.round(alpha.length / n));
    let ownedPx = 0;
    for (let i = 0; i < n; i++) if (alpha[i * stride] > 128) ownedPx++;
    const ownedFrac = ownedPx / n;
    // Repair whiteout legitimately changes the whole silhouette (~most of a
    // tight crop) — allow more there.
    const guardMax = params.repairMode ? 0.92 : 0.8;
    if (ownedFrac > guardMax) {
      const err = new Error(`Model re-imagined the whole crop (${Math.round(ownedFrac * 100)}% changed) instead of editing the figure — retry, or use a tighter crop / simpler pose instruction. The steps below show what it produced.`);
      // Failed runs keep their intermediates — the caller merges this into
      // the failed entry so the UI can show what the model actually did.
      err.partialResult = { steps, crop: { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: crop.h / H }, characterName: ref.name };
      throw err;
    }
    let alpha1 = alpha;
    if (stride > 1) {
      alpha1 = Buffer.alloc(n);
      for (let i = 0; i < n; i++) alpha1[i] = alpha[i * stride];
    }
    // The blend mask itself (white = pixels taken from the model output).
    const maskJpeg = await sharp(Buffer.from(alpha1), raw1).jpeg().toBuffer();
    await addStep('blend mask (white = model pixels kept)', `data:image/jpeg;base64,${maskJpeg.toString('base64')}`);
    feathered = await sharp(back).ensureAlpha()
      .joinChannel(Buffer.from(alpha1), raw1).png().toBuffer();
  } else if (!feathered) {
    const fe = Math.max(8, Math.round(Math.min(crop.w, crop.h) * 0.04));
    const maskSvg = `<svg width="${crop.w}" height="${crop.h}"><defs><filter id="f"><feGaussianBlur stdDeviation="${fe / 2}"/></filter></defs><rect x="${fe}" y="${fe}" width="${crop.w - 2 * fe}" height="${crop.h - 2 * fe}" fill="white" filter="url(#f)"/></svg>`;
    const mask = await sharp(Buffer.from(maskSvg)).resize(crop.w, crop.h).ensureAlpha().extractChannel(3).raw().toBuffer();
    feathered = await sharp(back).ensureAlpha()
      .joinChannel(mask, { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
  }
  const composed = await sharp(baseBuf).composite([{ input: feathered, left: crop.x, top: crop.y }]).jpeg({ quality: 95 }).toBuffer();

  const versionIndex = await saveTestVersion(
    ctx.storyId, 'scene', ctx.pageNumber,
    `data:image/jpeg;base64,${composed.toString('base64')}`, experimentId
  );
  return {
    imageType: 'scene', versionIndex, characterName: ref.name, elapsedMs,
    modelId: result.modelId, promptUsed: prompt,
    crop: { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: crop.h / H },
    steps, cost: result.cost,
  };
}

/** Rewrite a provider-blocked scene description (rewrite-blocked-scene.txt). */
async function runRewriteBlockedStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
  await loadPromptTemplates();
  const { callTextModel } = require('./textModels');

  // Prompt built explicitly (no PROMPT_TEMPLATES swap across the model await).
  const template = promptOverride || PROMPT_TEMPLATES.rewriteBlockedScene;
  if (!template) throw new Error('rewriteBlockedScene template not loaded');
  const prompt = fillTemplate(template, { SCENE_DESCRIPTION: ctx.scene.sceneDescription || '' });

  const t0 = Date.now();
  const result = await callTextModel(prompt, 1000, null, { usageLabel: 'testlab_scene_rewrite' });
  return {
    elapsedMs: Date.now() - t0,
    promptUsed: prompt,
    newSceneDescription: (result?.text || '').trim() || null,
    storedSceneDescription: ctx.scene.sceneDescription || null,
  };
}

/**
 * Repair verification on two stored versions of a page: diff image + Gemini
 * verdict (same core the automatic repair chain uses). params:
 * {originalVersionIndex?, repairedVersionIndex, issueType?, issueDescription?}.
 */
async function runRepairVerifyStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { verifyRepairWithGemini, createDiffImage } = require('./repairVerification');
  const r2Lib = require('./r2');

  const repairedIdx = params.repairedVersionIndex;
  if (repairedIdx == null) throw new Error('repair_verify requires params.repairedVersionIndex (a test or stored version)');
  const repaired = await loadTestImage(ctx.storyId, 'scene', ctx.pageNumber, repairedIdx);
  if (!repaired?.imageData) throw new Error(`scene v${repairedIdx} not found`);
  const original = params.originalVersionIndex != null
    ? (await loadTestImage(ctx.storyId, 'scene', ctx.pageNumber, params.originalVersionIndex))?.imageData
    : await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  if (!original) throw new Error('original image not found');

  const toBuf = (d) => Buffer.from(r2Lib.stripDataUriPrefix(d), 'base64');
  const issue = { type: params.issueType || 'object', description: params.issueDescription || 'repair quality check' };

  const t0 = Date.now();
  const [verdict, diff] = await Promise.all([
    verifyRepairWithGemini(toBuf(original), toBuf(repaired.imageData), issue),
    createDiffImage(toBuf(original), toBuf(repaired.imageData)).catch(() => null),
  ]);
  const elapsedMs = Date.now() - t0;

  let diffVersionIndex;
  if (diff) {
    const diffUri = `data:image/jpeg;base64,${Buffer.isBuffer(diff) ? diff.toString('base64') : diff}`;
    diffVersionIndex = await saveTestVersion(ctx.storyId, 'tl_diff', ctx.pageNumber, diffUri, experimentId);
  }
  // verifyRepairWithGemini returns comparisonImage as a raw JPEG Buffer —
  // strip Buffers before the result lands in the experiment's JSONB row.
  const safeVerdict = JSON.parse(JSON.stringify(verdict, (key, value) => {
    if (value && value.type === 'Buffer' && Array.isArray(value.data)) return `[image ${Math.round(value.data.length / 1024)}KB]`;
    if (typeof value === 'string' && value.startsWith('data:image')) return `[image ${Math.round(value.length / 1024)}KB]`;
    return value;
  }));
  return {
    elapsedMs,
    imageType: diffVersionIndex !== undefined ? 'tl_diff' : undefined,
    versionIndex: diffVersionIndex,
    report: safeVerdict,
    comparedVersions: { original: params.originalVersionIndex ?? 'active', repaired: repairedIdx },
  };
}

/** Standalone avatar-sheet evaluation on a stored tl_avatar test version. */
async function runAvatarEvalStage(target, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { _internal, resolveFacePhoto } = require('./character2x4Sheet');
  const { character, costume } = await loadCharacterContext(target.storyId, target.character);

  const versionIndex = params.versionIndex ?? target.versionIndex;
  if (versionIndex == null) throw new Error('avatar_eval requires versionIndex (a tl_avatar test version)');
  const sheet = await loadTestImage(target.storyId, 'tl_avatar', null, versionIndex);
  if (!sheet?.imageData) throw new Error(`tl_avatar v${versionIndex} not found`);
  const facePhoto = await resolveFacePhoto(character);

  const t0 = Date.now();
  let evalResult;
  if (params.styled) {
    const realisticVersionIndex = params.realisticVersionIndex;
    if (realisticVersionIndex == null) throw new Error('styled avatar_eval requires realisticVersionIndex');
    const anchor = await loadTestImage(target.storyId, 'tl_avatar', null, realisticVersionIndex);
    if (!anchor?.imageData) throw new Error(`realistic anchor v${realisticVersionIndex} not found`);
    evalResult = await _internal.evaluateStyledSheetWithGemini(
      facePhoto, anchor.imageData, sheet.imageData,
      params.artStyle || target.artStyle || 'pixar',
      process.env.GEMINI_API_KEY
    );
  } else {
    evalResult = await _internal.evaluateSheetWithGemini(
      sheet.imageData, costume.description || 'standard outfit',
      process.env.GEMINI_API_KEY, facePhoto, null,
      { characterDescription: character.description || '' }
    );
  }
  const elapsedMs = Date.now() - t0;
  return { character: character.name, versionIndex, styled: !!params.styled, elapsedMs, report: evalResult };
}

const STAGE_RUNNERS = {
  image: runImageStage,
  empty_scene: runEmptySceneStage,
  quality_eval: runQualityEvalStage,
  semantic_eval: runSemanticEvalStage,
  bbox: runBboxStage,
  char_repair: runCharRepairStage,
  entity: runEntityStage,
  text_zone: runTextZoneStage,
  consolidate: runConsolidateStage,
  inpaint: runInpaintStage,
  iterate: runIterateStage,
  repair_round: runRepairRoundStage,
  edit_image: runEditImageStage,
  artifact_repair: runArtifactRepairStage,
  scale_repair: runScaleRepairStage,
  style_transfer: runStyleTransferStage,
  pick_best: runPickBestStage,
  scene_expansion: runSceneExpansionStage,
  scene_expansion_ab: runSceneExpansionAbStage,
  scene_variant: runSceneVariantStage,
  scene_description: runSceneDescriptionStage,
  rewrite_blocked: runRewriteBlockedStage,
  repair_verify: runRepairVerifyStage,
  qwen_insert: runQwenInsertStage,
};

// Story-level stages: target {storyId} (+ coverType for cover). No page context.
const STORY_STAGES = {
  cover: runCoverStage,
  style_check: runStyleCheckStage,
};

// Avatar stages take {storyId, character} targets, not page targets.
const AVATAR_STAGES = {
  avatar_realistic: runAvatarRealisticStage,
  avatar_style: runAvatarStyleStage,
  avatar_eval: runAvatarEvalStage,
};

/**
 * Run one stage against one target. Page stages take {storyId, pageNumber};
 * avatar stages take {storyId, character}; story-level stages take {storyId}
 * (+ coverType for cover). Returns a JSON-safe result; throws on
 * unrecoverable errors (caller records per-target failure).
 */
async function runStageOnTarget(stage, target, opts) {
  if (AVATAR_STAGES[stage]) {
    if (!target.character) throw new Error(`${stage} requires target.character`);
    return AVATAR_STAGES[stage](target, opts);
  }
  if (STORY_STAGES[stage]) {
    if (!target.storyId) throw new Error(`${stage} requires target.storyId`);
    return STORY_STAGES[stage](target, opts);
  }
  const runner = STAGE_RUNNERS[stage];
  if (!runner) throw new Error(`Unknown stage: ${stage}. Valid: ${[...Object.keys(STAGE_RUNNERS), ...Object.keys(AVATAR_STAGES), ...Object.keys(STORY_STAGES)].join(', ')}`);
  const ctx = await loadSceneContext(target.storyId, target.pageNumber);
  return runner(ctx, opts);
}

/**
 * Genericity check for prompt changes. Prompt rules must be story-agnostic
 * (archetypes only — "the main character", "a vehicle") because every prompt
 * runs on every story; a scene-specific rule leaks into unrelated stories.
 * Two layers:
 *   1. Name scan — the target story's character / VB entity names must not
 *      appear in the rule (derived from the story, not a hardcoded list).
 *   2. Archetype check — a small text-model call flags wording that only
 *      fits one specific scene even without naming it.
 * Returns { generic, issues: string[] } — advisory (warn, never block).
 */
async function checkRuleGenericity(ruleText, storyId) {
  const issues = [];
  const text = String(ruleText || '');
  if (!text.trim()) return { generic: true, issues };
  try {
    if (storyId) {
      const { storyData } = await loadStoryDataFull(storyId, { rehydrate: false });
      const names = new Set();
      for (const c of (storyData.characters || [])) if (c?.name) names.add(String(c.name));
      const vb = storyData.visualBible || {};
      for (const pool of [vb.characters, vb.artifacts, vb.animals, vb.vehicles, vb.locations, vb.secondaryCharacters]) {
        for (const e of (pool || [])) if (e?.name) names.add(String(e.name));
      }
      for (const n of names) {
        if (n.length >= 3 && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
          issues.push(`references story entity "${n}" — prompts must use archetypes, never names`);
        }
      }
    }
  } catch (e) {
    log.debug(`[TESTLAB] genericity name scan skipped: ${e.message}`);
  }
  try {
    const { callTextModel } = require('./textModels');
    const check = await callTextModel(
      `You review a rule that will be appended to an illustration-prompt template used for EVERY story. Rule:\n"${text}"\nFlag wording that is specific to one story or scene: entity names, place names, plot objects, or phrasing that only applies to a single situation. Broad archetypes (a vehicle, a guard, the main character) are fine. Reply JSON only: {"generic": true|false, "issues": ["..."]}.`,
      500, null, { usageLabel: 'testlab_genericity' }
    );
    const m = String(check.text || '').match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed && parsed.generic === false && Array.isArray(parsed.issues)) issues.push(...parsed.issues.map(String));
    }
  } catch (e) {
    log.debug(`[TESTLAB] genericity model check skipped: ${e.message}`);
  }
  return { generic: issues.length === 0, issues };
}

module.exports = {
  STAGES: [...Object.keys(STAGE_RUNNERS), ...Object.keys(AVATAR_STAGES), ...Object.keys(STORY_STAGES)],
  STORY_STAGES: Object.keys(STORY_STAGES),
  AVATAR_STAGE_NAMES: Object.keys(AVATAR_STAGES),
  runStageOnTarget,
  loadSceneContext,
  loadCharacterContext,
  loadTestImage,
  loadActivePageImage,
  checkRuleGenericity,
};
