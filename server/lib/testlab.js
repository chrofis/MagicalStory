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
    textPosition: scene.textPosition || scene.sceneMetadata?.textPosition || 'top-left',
  };
}

async function bytesFor(img) {
  if (!img) return null;
  const { imgBytesAsync } = require('../services/database');
  return imgBytesAsync({ image_data: img.imageData || img.image_data || null, image_url: img.imageUrl || img.image_url || null });
}

/** Baseline empty scene for a page (non-test rows only; blob fallback). */
async function loadEmptyScene(storyId, pageNumber) {
  const { dbQuery } = require('../services/database');
  const rows = await dbQuery(
    `SELECT image_data, image_url FROM story_images
     WHERE story_id = $1 AND image_type = 'empty_scene' AND page_number = $2 AND NOT is_test
     ORDER BY version_index LIMIT 1`,
    [storyId, pageNumber]
  );
  if (rows.length > 0) return bytesFor(rows[0]);
  const blob = await dbQuery(
    `SELECT scene->>'emptySceneImage' AS img
     FROM stories, jsonb_array_elements(data->'sceneImages') scene
     WHERE stories.id = $1 AND (scene->>'pageNumber')::int = $2`,
    [storyId, pageNumber]
  );
  return blob[0]?.img || null;
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

async function saveTestVersion(storyId, imageType, pageNumber, imageData, experimentId, qualityScore = null) {
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
      { textPosition: ctx.textPosition, skipVisualBible: isGrokImage }
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
  const textAreaMask = textInImage ? getTextAreaMask(ctx.textPosition, ctx.languageLevel) : null;

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
    pageContext: `testlab-exp${experimentId}`,
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
        ctx.scene.text || null, ctx.scene.sceneMetadata?.hint || null, ctx.scene.sceneCharacters || null
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

  const prompt = buildEmptyScenePrompt({
    template: promptOverride || undefined,
    style: resolveArtStyleForEmptyScene(params.artStyleOverride || ctx.artStyle, null),
    description,
    characterSpace: meta.characterSpace || '',
    textAreaInstruction: buildTextZoneInstruction(ctx.textPosition, meta.textZoneDescription || null, 'a quarter of the frame', { isEmptyScene: true }),
    eraGuard: buildEraGuard(meta.era),
    landmarkFidelity: buildLandmarkFidelityBlock(ctx.landmarkPhotos[0] || null),
  });

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, [], {
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    landmarkPhotos: ctx.landmarkPhotos,
    textAreaMask: getTextAreaMask(ctx.textPosition, ctx.languageLevel),
    pageNumber: ctx.pageNumber,
    skipCache: true,
    pageContext: `testlab-exp${experimentId}`,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('Empty-scene generation returned no image');

  // Same QC the pipeline runs (pixel + Gemini vision) — report-only here, no
  // retry loop: the point is seeing whether a prompt variant passes the gate.
  let qc = null;
  try {
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
    ctx.scene.text || null, ctx.scene.sceneMetadata?.hint || null, ctx.scene.sceneCharacters || null,
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
    ctx.scene.sceneMetadata?.hint || null, promptOverride || null
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

async function runBboxStage(ctx, { experimentId }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { detectAllBoundingBoxes } = require('./images');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const expectedCharacters = (ctx.scene.sceneCharacters || ctx.referencePhotos || []).map(c => ({
    name: c.name,
    description: c.description || '',
    position: c.position || '',
  })).filter(c => c.name);

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
    figures: (result.figures || []).map(f => ({ name: f.name, bbox: f.bbox || f.box_2d, faceBbox: f.faceBbox || null, confidence: f.confidence })),
    objects: (result.objects || []).map(o => ({ name: o.name, bbox: o.bbox || o.box_2d })),
  };
}

async function runCharRepairStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { repairCharacterMismatch } = require('./images');

  const charName = params.characterName;
  if (!charName) throw new Error('char_repair requires params.characterName');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const ref = ctx.referencePhotos.find(p => (p.name || '').toLowerCase() === charName.toLowerCase());
  if (!ref) throw new Error(`No reference photo for character "${charName}" on this page`);

  // Bbox: explicit param wins; otherwise take the stored detection for this character.
  let bbox = params.bbox || null;
  let faceBbox = params.faceBbox || null;
  if (!bbox) {
    const det = ctx.scene.bboxDetection;
    const fig = (det?.figures || det?.characters || []).find(f => (f.name || '').toLowerCase() === charName.toLowerCase());
    bbox = fig?.bbox || fig?.box_2d || null;
    if (!faceBbox) faceBbox = fig?.faceBbox || null;
  }
  if (!bbox || bbox.length !== 4) throw new Error(`No bounding box for "${charName}" — pass params.bbox [ymin,xmin,ymax,xmax] (0-1)`);

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
  if (!['grok', 'gemini'].includes(backend)) throw new Error(`Unknown backend "${backend}" — use grok|gemini`);

  const t0 = Date.now();
  const result = await repairCharacterMismatch(imageData, ref.photoUrl, bbox, charName, {
    imageBackend: backend,
    ...modeFlags,
    faceBbox,
    whiteoutTarget: params.whiteoutTarget || 'face',
    pageContext: `testlab-exp${experimentId}-P${ctx.pageNumber}`,
  });
  const elapsedMs = Date.now() - t0;
  const repairedImage = result?.imageData || result?.repairedImage || null;
  if (!repairedImage) throw new Error('Character repair returned no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, repairedImage, experimentId);
  return { imageType: 'scene', versionIndex, characterName: charName, bbox, backend, repairMode, method: result?.method || null, elapsedMs };
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

/** Full story data (optionally rehydrated: full or single page). */
async function loadStoryDataFull(storyId, { pageNumber = null, rehydrate = true } = {}) {
  const db = require('../services/database');
  const rows = await db.dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [storyId]);
  if (!rows.length) throw new Error(`Story ${storyId} not found`);
  let storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  if (rehydrate) {
    storyData = pageNumber != null && typeof db.rehydrateActivePageImage === 'function'
      ? await db.rehydrateActivePageImage(storyId, storyData, pageNumber)
      : await db.rehydrateStoryImages(storyId, storyData);
  }
  return { storyData, userId: rows[0].user_id };
}

/**
 * Rebuild an evaluation-shaped object from the fields persisted on a scene —
 * what decideRepairMethod / the consolidator / inpaint read in the pipeline.
 */
function storedEvalFromScene(scene) {
  return {
    qualityScore: scene.qualityScore ?? null,
    score: scene.qualityScore ?? null,
    finalScore: scene.finalScore ?? scene.qualityScore ?? null,
    semanticScore: scene.semanticScore ?? null,
    scoreBreakdown: scene.scoreBreakdown || null,
    fixableIssues: scene.fixableIssues || [],
    issuesSummary: scene.qualityReasoning || scene.issuesSummary || null,
    semanticResult: scene.semanticResult
      || (scene.semanticIssues ? { semanticIssues: scene.semanticIssues } : null),
    consolidatedPlan: scene.consolidatedPlan || null,
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

  // Fresh canonical characters (avatar fallback), same as the regen endpoint.
  const charRows = await dbQuery('SELECT data FROM characters WHERE user_id = $1', [userId]);
  const freshCharData = charRows[0]?.data || {};
  const freshCharacters = (typeof freshCharData === 'string' ? JSON.parse(freshCharData) : freshCharData).characters || [];

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
  const { storyData } = await loadStoryDataFull(ctx.storyId, { pageNumber: ctx.pageNumber });

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
    const r = await runIterateStage(ctx, { experimentId, params: { ...params, feedback: latestEval.issuesSummary || null } });
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
  return { imageType: 'scene', versionIndex, elapsedMs, modelId: result.modelId || null, promptUsed: instruction };
}

/** Grid-based artifact repair (same core as repair-workflow/artifact-repair). */
async function runArtifactRepairStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { gridBasedRepair } = require('./gridBasedRepair');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const scene = { ...ctx.scene, imageData };
  const t0 = Date.now();
  const result = await gridBasedRepair(scene, { retryHistory: ctx.scene.retryHistory || [] });
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

/** Report which stored version pick-best would choose (best score, later wins ties). */
async function runPickBestStage(ctx, { experimentId }) {
  const versions = (ctx.scene.imageVersions || []).map((v, i) => ({
    index: i,
    dbVersionIndex: v.dbVersionIndex ?? v.versionIndex ?? null,
    type: v.type || null,
    qualityScore: v.qualityScore ?? null,
    createdAt: v.createdAt || null,
  }));
  if (versions.length === 0) return { versions: [], winner: null, elapsedMs: 0 };
  let winner = null;
  for (const v of versions) {
    const score = v.qualityScore ?? -1;
    if (!winner || score >= (winner.qualityScore ?? -1)) winner = v; // later wins ties
  }
  return { versions, winner, activeIsPinned: ctx.scene.activeVersionPinned ?? null, elapsedMs: 0 };
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
      { artStyleId: ctx.artStyle, referencePhotos: ctx.referencePhotos }
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

/** Re-run the scene-description regen (scene-iteration.txt, same as /regenerate/scene-description). */
async function runSceneDescriptionStage(ctx, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneDescriptionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
  const { callClaudeAPI } = require('./textModels');
  const { MODEL_DEFAULTS } = require('../config/models');
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
  const result = await callClaudeAPI(prompt, 10000, MODEL_DEFAULTS.sceneIteration, {
    prefill: '{"previewMismatches":[', usageLabel: 'testlab_scene_description',
  });
  const elapsedMs = Date.now() - t0;
  return {
    elapsedMs, modelId: result.modelId || null, promptUsed: prompt,
    newSceneDescription: result.text,
    storedSceneDescription: ctx.scene.sceneDescription || null,
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
  return {
    elapsedMs,
    imageType: diffVersionIndex !== undefined ? 'tl_diff' : undefined,
    versionIndex: diffVersionIndex,
    report: verdict,
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
  scene_description: runSceneDescriptionStage,
  rewrite_blocked: runRewriteBlockedStage,
  repair_verify: runRepairVerifyStage,
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

module.exports = {
  STAGES: [...Object.keys(STAGE_RUNNERS), ...Object.keys(AVATAR_STAGES), ...Object.keys(STORY_STAGES)],
  STORY_STAGES: Object.keys(STORY_STAGES),
  AVATAR_STAGE_NAMES: Object.keys(AVATAR_STAGES),
  runStageOnTarget,
  loadSceneContext,
  loadCharacterContext,
  loadTestImage,
  loadActivePageImage,
};
