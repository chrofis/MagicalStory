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
const { samUnionBlend, maskBlurThreshold, fetchMaskWithRetry, BLEND_RULE_VERSION } = require('./samBlend');

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
// Covers addressable as negative page numbers — same convention the
// regeneration routes use (refresh-bbox, repair). Lets detection/eval stages
// run on cover images, not only story pages.
const COVER_KEY_BY_PAGE = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };

async function loadSceneContext(storyId, pageNumber) {
  const { dbQuery } = require('../services/database');
  const coverKey = pageNumber < 0 ? COVER_KEY_BY_PAGE[String(pageNumber)] : null;
  if (pageNumber < 0 && !coverKey) throw new Error(`Invalid cover page number: ${pageNumber}`);
  const rows = coverKey
    ? await dbQuery(
      `SELECT (data->'coverImages'->$2)::text AS scene_text,
              data->>'artStyle' AS art_style,
              data->>'language' AS language,
              data->>'languageLevel' AS language_level,
              data->>'storyType' AS story_type,
              data->>'title' AS title,
              data->'layout' AS layout,
              (data->'visualBible')::text AS visual_bible,
              (data->'clothingRequirements')::text AS clothing_reqs,
              (data->'characters')::text AS characters_json,
              (data->'characterAvatars')::text AS character_avatars
       FROM stories WHERE stories.id = $1`,
      [storyId, coverKey]
    )
    : await dbQuery(
      `SELECT (scene)::text AS scene_text,
              data->>'artStyle' AS art_style,
              data->>'language' AS language,
              data->>'languageLevel' AS language_level,
              data->>'storyType' AS story_type,
              data->>'title' AS title,
              data->'layout' AS layout,
              (data->'visualBible')::text AS visual_bible,
              (data->'clothingRequirements')::text AS clothing_reqs,
              (data->'characters')::text AS characters_json,
              (data->'characterAvatars')::text AS character_avatars
       FROM stories, jsonb_array_elements(data->'sceneImages') scene
       WHERE stories.id = $1 AND (scene->>'pageNumber')::int = $2`,
      [storyId, pageNumber]
    );
  if (rows.length === 0 || !rows[0].scene_text) throw new Error(`Scene not found: ${storyId} page ${pageNumber}`);

  const scene = JSON.parse(rows[0].scene_text);
  if (coverKey) {
    // Covers store their prose under `description`; stage runners read
    // scene.sceneDescription and scene.pageNumber.
    scene.pageNumber = pageNumber;
    if (!scene.sceneDescription) scene.sceneDescription = scene.description || '';
  }
  const layout = typeof rows[0].layout === 'string' ? JSON.parse(rows[0].layout) : (rows[0].layout || {});
  let visualBible = null;
  try {
    visualBible = rows[0].visual_bible ? JSON.parse(rows[0].visual_bible) : null;
  } catch { /* malformed VB — run without grid refs */ }
  let clothingRequirements = null;
  try {
    clothingRequirements = rows[0].clothing_reqs ? JSON.parse(rows[0].clothing_reqs) : null;
  } catch { /* run without — repairs fall back to avatar clothing */ }
  let characters = [];
  try {
    characters = rows[0].characters_json ? JSON.parse(rows[0].characters_json) : [];
  } catch { /* run without full character objects */ }
  let characterAvatars = null;
  try {
    characterAvatars = rows[0].character_avatars ? JSON.parse(rows[0].character_avatars) : null;
  } catch { /* run without — refCrop:'costumedHead' falls back to full refs */ }

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
    clothingRequirements,
    characters,
    characterAvatars,
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

/**
 * Active (user-visible) page image as a data URI. Covers via -1/-2/-3.
 *
 * `versionIndex` pins an EXACT version instead of the active one. Without it a
 * stage always reads whatever won pick-best, which silently re-runs a repair on
 * an already-repaired image: on job_1786484554633_crojok432 p3 the active
 * version IS the garment recolour, so a replay measured the leftover distance
 * to blue rather than the original purple→blue correction. Pinning fails loudly
 * when the version is missing — a silent fall back to v0 would answer a
 * different question than the one asked.
 */
// imageType lets a stage target an intermediate instead of the page itself —
// 'tl_step' holds the composite's plate, depopulated background and pasted
// canvas, so detection can be run on the ghosts rather than on the finished
// illustration. Only meaningful together with a pinned versionIndex.
// Which bytes the last loadActivePageImage call served — module-level on
// purpose: a property hung off the function object came back null in the
// payload on the very first production run (exp #13), so absence itself was
// unreadable. One experiment runs at a time (route guard), so a single slot
// cannot be raced.
let _lastPageLoad = null;
function getLastPageLoad() { return _lastPageLoad; }

async function loadActivePageImage(storyId, pageNumber, versionIndex = null, imageType = null) {
  _lastPageLoad = null;
  const { getActiveVersion, getStoryImage } = require('../services/database');
  const coverKey = pageNumber < 0 ? COVER_KEY_BY_PAGE[String(pageNumber)] : null;
  // null/undefined/'' mean "load the ACTIVE version". Number(null) is 0, so
  // the old isFinite(Number(versionIndex)) turned the DEFAULT into pinned v0:
  // every unpinned Lab load silently detected on v0, which is both the
  // loadedFrom={unrecorded} symptom AND the 2026-08-19 "detected on v0
  // although activeVersion=2" mystery (bug lab-unpinned-loads-v0).
  const pinned = (versionIndex == null || versionIndex === '') ? null
    : (Number.isFinite(Number(versionIndex)) ? Number(versionIndex) : null);
  // A Lab step image is written with is_test = true, and getStoryImage filters
  // those out — so an intermediate has to come through loadTestImage, which
  // does not.
  if (pinned !== null && imageType) {
    const img = await loadTestImage(storyId, imageType, pageNumber, pinned);
    if (!img?.imageData) throw new Error(`No ${imageType} v${pinned} for ${storyId} page ${pageNumber}`);
    return img.imageData;
  }
  if (pinned !== null) {
    const row = await getStoryImage(storyId, coverKey || 'scene', coverKey ? null : pageNumber, pinned);
    if (!row) throw new Error(`No version ${pinned} for ${storyId} page ${pageNumber}`);
    const bytes = await bytesFor(row);
    if (!bytes) throw new Error(`Bytes unavailable for ${storyId} page ${pageNumber} v${pinned}`);
    return bytes;
  }
  // Cover rows live in story_images as image_type=<coverKey> with NULL
  // page_number; active-version meta is keyed by the cover key string.
  const activeIdx = await getActiveVersion(storyId, coverKey || pageNumber);
  const atActive = coverKey
    ? await getStoryImage(storyId, coverKey, null, activeIdx)
    : await getStoryImage(storyId, 'scene', pageNumber, activeIdx);
  const img = atActive || (coverKey
    ? await getStoryImage(storyId, coverKey, null, 0)
    : await getStoryImage(storyId, 'scene', pageNumber, 0));
  // OBSERVABLE, ALWAYS (owner, 2026-08-19). Three unpinned Lab runs on
  // job_1787120984020_pg71z58ba9 p7 detected on v0 content although
  // image_version_meta says activeVersion=2 and the pinned load of v2 works —
  // and nothing logged which version was actually served, so the mismatch was
  // only provable by eyeballing shirt colours in the step image. Every unpinned
  // load now states what it asked for and what it got; a fallback to v0 is a
  // WARNING, not a silent shrug.
  _lastPageLoad = { storyId, pageNumber, activeIdx, loadedVersion: img?.version_index ?? (atActive ? activeIdx : 0), fellBackToV0: !atActive };
  if (!atActive) {
    log.warn(`⚠️ [TESTLAB] ${storyId} p${pageNumber}: active version v${activeIdx} did not load — FELL BACK to v0. Whatever runs next is NOT testing the reader-facing image.`);
  } else {
    log.info(`[TESTLAB] ${storyId} p${pageNumber}: loaded active version v${activeIdx}`);
  }
  if (!img) throw new Error(`No image for ${storyId} page ${pageNumber}`);
  const data = await bytesFor(img);
  if (!data) throw new Error(`Image bytes unavailable for ${storyId} page ${pageNumber}`);
  return data;
}

/**
 * BLEND REPLAY — resolve `params.replayOf = {experimentId, resultIndex}` into the
 * inputs that reproduce a past repair EXACTLY, minus the model call:
 *   - the source run's own params (backend, whiteoutTarget, cropPad …) as the base,
 *   - its PINNED detection (the experiment's fresh-detection entry), so the boxes
 *     and therefore the crop are recomputed identically instead of re-detected,
 *   - `reuseModelOutput` = the stored "model raw output" step of that result.
 * The caller's params win over all of it, so an A/B changes ONLY the blend knobs
 * (featherPx, erodeFeather, colorCorrect, bgBorderMatch, bodyColorMode, garmentOnly).
 * Cost: zero — no image model is called. `_replayCrop` is carried so the stage can
 * assert the recomputed crop matches the source; a drift would silently misalign
 * the reused output and invalidate the comparison.
 */
async function resolveReplayParams(replayOf, ctx) {
  const { dbQuery } = require('../services/database');
  const expId = Number(replayOf.experimentId);
  const idx = Number(replayOf.resultIndex);
  if (!Number.isInteger(expId) || !Number.isInteger(idx)) {
    throw new Error('replayOf needs {experimentId, resultIndex} as integers');
  }
  const rows = await dbQuery('SELECT params, results FROM testlab_experiments WHERE id = $1', [expId]);
  if (!rows.length) throw new Error(`replayOf: experiment #${expId} not found`);
  const results = rows[0].results || [];
  const src = results[idx];
  if (!src) throw new Error(`replayOf: experiment #${expId} has no result #${idx} (it has ${results.length})`);
  if (src.storyId !== ctx.storyId || src.pageNumber !== ctx.pageNumber) {
    throw new Error(`replayOf: result #${idx} is ${src.storyId} P${src.pageNumber}, but this target is ${ctx.storyId} P${ctx.pageNumber} — a replay must run on the same page.`);
  }
  const rawStep = (src.steps || []).find(s => /model raw output/i.test(s.label || ''));
  if (!rawStep) throw new Error(`replayOf: result #${idx} stored no "model raw output" step — nothing to replay the blend on.`);
  if (!src.crop) throw new Error(`replayOf: result #${idx} stored no crop rect — cannot verify alignment.`);
  // Pinned detection: the experiment's fresh-detection entry (every option in a
  // compare-all run was blended against these same boxes). A replay-of-a-replay
  // stores no detection of its own — follow the params.replayOf chain back to
  // the root experiment (bounded: a chain is user-created, never deep). The
  // characterName rides the same chain (replay experiments don't store it).
  let det = results.find(r => Array.isArray(r?.figures) && r.figures.length);
  let charName = rows[0].params?.characterName;
  {
    let cursor = rows[0].params?.replayOf;
    let hops = 0;
    while ((!det || !charName) && cursor && hops++ < 5) {
      const anc = await dbQuery('SELECT params, results FROM testlab_experiments WHERE id = $1', [Number(cursor.experimentId)]);
      if (!anc.length) break;
      if (!det) det = (anc[0].results || []).find(r => Array.isArray(r?.figures) && r.figures.length);
      if (!charName) charName = anc[0].params?.characterName;
      cursor = anc[0].params?.replayOf;
    }
  }
  if (!det) throw new Error(`replayOf: experiment #${expId} (and its replay ancestors) stored no detection entry — re-detecting would move the crop and invalidate the replay.`);
  // The source run's own knobs: its variant params when it was one of several.
  const srcVariant = (rows[0].params?.variants || []).find(v => v.label === src.label);
  return {
    ...(charName ? { characterName: charName } : {}),
    ...(srcVariant?.params || {}),
    ...(src.backend ? { backend: src.backend } : {}),
    detection: { figures: det.figures, objects: det.objects || [] },
    reuseModelOutput: rawStep.versionIndex,
    _replayCrop: src.crop,
    _replayLabel: `replay of #${expId} result #${idx}${src.label ? ` (${src.label})` : ''}`,
  };
}


/**
 * Reference photo for an IDENTITY-SWAP test: page reference photos only cover
 * characters ON that page, so swapping in someone who is not in the scene
 * (`params.referenceCharacter`) must fall back to the story's character list and
 * that character's styled avatar. Returns a ref shaped like a referencePhoto.
 */
async function resolveSwapReference(ctx, refName, artStyle) {
  const onPage = (ctx.referencePhotos || []).find(p => (p.name || '').toLowerCase() === refName.toLowerCase());
  if (onPage) return onPage;
  const character = (ctx.characters || []).find(c => (c.name || '').toLowerCase() === refName.toLowerCase());
  if (!character) {
    const avail = [...new Set([...(ctx.referencePhotos || []).map(p => p.name), ...(ctx.characters || []).map(c => c.name)])].filter(Boolean).join(', ');
    throw new Error(`No reference for "${refName}" — not on this page and not a story character (available: ${avail || 'none'})`);
  }
  const { getStyledAvatarForClothing } = require('./entityConsistency');
  let photoUrl = null;
  try {
    const styled = await getStyledAvatarForClothing(character, artStyle || ctx.artStyle, 'standard');
    if (styled) photoUrl = await toDataUri(styled);
  } catch { /* fall through to raw photo */ }
  if (!photoUrl) photoUrl = await toDataUri(character.photoUrl || character.photoData || character.avatars?.standard);
  if (!photoUrl) throw new Error(`Character "${refName}" has no usable avatar or photo for the swap`);
  log.info(`[TESTLAB] swap reference for ${refName} resolved from the story character list (not on this page)`);
  return { name: character.name, photoUrl, clothingDescription: null };
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

/**
 * Scene description for quality/semantic eval. The clothing facts no longer
 * ride in this string: evaluateImageQuality builds the CLOTHING CONTRACT input
 * itself, from the reference photos it is handed (2026-08-08). Production and
 * the Lab therefore share one mechanism again — prepending the old header here
 * would state the outfit twice in the Lab and once in production, which is the
 * systematic score skew this helper was written to prevent.
 *
 * The Lab's job is to pass the same photos production does; when its own
 * referencePhotos carry no clothing, fall back to the expected characters so
 * the contract is still populated.
 */
function evalSceneDescription(ctx, params = null) {
  // A/B runs with sceneDescriptionOverride generate FROM the override — the
  // eval contract must be the same override, or the judge deducts for lacking
  // exactly the defects the override removed (observed: three P6 A/B renders
  // scored sem=0 against the stored brief's "gap in the railing"/"ankle-deep").
  return `${params?.sceneDescriptionOverride || ctx.scene.sceneDescription || ''}`;
}

/** Reference photos for eval, guaranteed to carry clothingDescription. */
function evalReferencePhotos(ctx) {
  const photos = (ctx.referencePhotos || []).filter(p => p?.name && p?.clothingDescription);
  if (photos.length > 0) return photos;
  return buildExpectedCharacters(ctx)
    .filter(c => c.clothing)
    .map(c => ({ name: c.name, clothingDescription: c.clothing }));
}

async function runImageStage(ctx, { promptOverride, experimentId, autoEval = true, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildImagePrompt } = require('./storyHelpers');
  const { generateImageOnly } = require('./images');
  const { buildPageCompositeRefs } = require('./referenceSheets');
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
      // sceneDescriptionOverride: test a corrected scene brief (e.g. removing a
      // duplicated object) without regenerating the story's unified outline.
      params.sceneDescriptionOverride || ctx.scene.sceneDescription,
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

  // refCrop: 'head' | 'upperBody' | 'costumedHead' — shrink each character
  // reference before generation. A/B how much reference body the model needs:
  // a full-body ref pulls the render toward full-figure present-to-camera
  // poses even when the brief asks for a hands-only/close-up framing.
  // 'head'/'upperBody' crop the stored (stacked) ref's top fraction — cheap,
  // but the stack's top panel is the HATLESS face cell, so headwear is lost.
  // 'costumedHead' rebuilds from the costumed avatar sheet: face cell
  // (identity) + the head region of the costumed body cell (headwear), so
  // hats and bandanas survive the crop.
  if (params.refCrop === 'costumedHead') {
    // Same code path as production close-up pages (cropAvatarCell headOnly).
    const { cropAvatarCell } = require('./sceneComposite');
    const { resolveCellPose } = require('./storyAvatars');
    const sheets = ctx.characterAvatars || {};
    for (const p of ctx.referencePhotos) {
      const sheetUri = sheets[p.name]?.costumed;
      if (!sheetUri) { log.warn(`[TESTLAB] costumedHead: no costumed sheet for ${p.name} — full ref kept`); continue; }
      const sc = (ctx.scene.sceneCharacters || []).find(c => ((typeof c === 'string' ? c : c?.name) || '').toLowerCase() === String(p.name).toLowerCase());
      const pf = resolveCellPose(typeof sc === 'string' ? { name: sc } : (sc || {}));
      const { body, stacked } = await cropAvatarCell(sheetUri, { pose: pf.pose, includeFace: true, stack: true, headOnly: true });
      const out = stacked || body;
      p.photoUrl = 'data:image/png;base64,' + out.toString('base64');
      p.photoData = undefined;
      p.photoType = `cell-${pf.pose}-costumedHead`;
    }
  } else if (params.refCrop) {
    const fraction = params.refCrop === 'head' ? 0.35 : 0.55;
    const sharp = require('sharp');
    for (const p of ctx.referencePhotos) {
      const src = p.photoUrl || p.photoData;
      if (!src) continue;
      const buf = Buffer.from(String(src).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const meta = await sharp(buf).metadata();
      const cropped = await sharp(buf)
        .extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * fraction) })
        .jpeg({ quality: 92 }).toBuffer();
      p.photoUrl = 'data:image/jpeg;base64,' + cropped.toString('base64');
      p.photoData = undefined;
    }
  }

  // backgroundRef: use a specific (test) empty-scene version as the background
  // anchor — style-matrix runs chain empty_scene(style) → image(style, that bg).
  // noBackground: render WITHOUT the Pass-1 plate — A/B what the empty scene
  // actually contributes to the final page (VB grid then carries locations).
  let emptyScene;
  if (params.noBackground) {
    emptyScene = null;
  } else if (params.backgroundRef?.versionIndex !== undefined) {
    const bg = await loadTestImage(ctx.storyId, params.backgroundRef.imageType || 'empty_scene', ctx.pageNumber, params.backgroundRef.versionIndex);
    emptyScene = bg?.imageData || null;
    if (!emptyScene) throw new Error(`backgroundRef v${params.backgroundRef.versionIndex} not found`);
  } else {
    emptyScene = await loadEmptyScene(ctx.storyId, ctx.pageNumber);
  }
  const textInImage = ctx.layout?.textInImage !== false;
  const textAreaMask = textInImage && ctx.textPosition ? getTextAreaMask(ctx.textPosition, ctx.languageLevel) : null;

  // Visual Bible grid + landmark refs — production's shared helper (a plate
  // background drops vehicles/locations/landmarks; otherwise locations only).
  let visualBibleGrid = null;
  let genLandmarkPhotos = ctx.landmarkPhotos;
  if (ctx.visualBible) {
    try {
      const refs = await buildPageCompositeRefs(ctx.visualBible, ctx.pageNumber, ctx.landmarkPhotos, {
        hasBackground: !!emptyScene,
        logTag: 'TESTLAB',
      });
      visualBibleGrid = refs.visualBibleGrid;
      genLandmarkPhotos = refs.landmarkPhotos;
    } catch (err) {
      log.warn(`[TESTLAB] VB grid build failed (continuing without): ${err.message}`);
    }
  }

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, ctx.referencePhotos, {
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    // params.imageModel: A/B the page render model (grok-imagine vs
    // gemini-2.5-flash-image) — style-adherence routing tests. Null = prod default.
    imageModelOverride: params.imageModel || null,
    landmarkPhotos: genLandmarkPhotos,
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
        result.imageData, evalSceneDescription(ctx, params), evalReferencePhotos(ctx), 'scene',
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
  // descriptionOverride: test a corrected empty-scene brief (e.g. fixing a
  // contradictory exterior/interior description, or a stair-direction) without
  // regenerating the whole story. Falls back to the stored per-page description.
  const description = params.descriptionOverride || meta.emptyScenePrompt || ctx.scene.emptyScenePrompt || ctx.scene.sceneDescription;
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
    visualBible: ctx.visualBible,
    pageNumber: ctx.pageNumber ?? null,
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

async function runQualityEvalStage(ctx, { promptOverride, experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { evaluateImageQuality } = require('./images');

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await evaluateImageQuality(
    imageData, evalSceneDescription(ctx), evalReferencePhotos(ctx), 'scene',
    null, `testlab-exp${experimentId}-P${ctx.pageNumber}`,
    ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
    {
      evalTemplateOverride: promptOverride || null,
      // Lab/staging parity: the SAME resolver the production repair-round eval
      // uses, from the same source (the story's art-style key). Never re-derive
      // this locally - a second derivation is how the Lab silently stopped
      // reproducing production for style-dependent rules.
      artStyle: require('../services/prompts').resolveEvalArtStyle(ctx.artStyle, ctx.scene.prompt || null),
      // Stage-2 compliance A/B: swap the model (default qwen-plus) and/or its
      // template to test the over-strict-CRITICAL problem.
      complianceModelOverride: params.complianceModel || null,
      compliancePromptOverride: params.compliancePrompt || null,
    }
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

/**
 * The stored score of the image eval_variance actually loaded. A pinned
 * versionIndex is a DB index, so it is resolved through arrayIndexForDb rather
 * than used as an array offset (the two diverge as soon as a version is
 * dropped — see the version-pinning contract).
 */
function storedBaselineFor(ctx, versionIndex) {
  if (versionIndex == null) {
    return { source: 'active version', finalScore: ctx.scene.finalScore ?? null, qualityScore: ctx.scene.qualityScore ?? null };
  }
  const versions = ctx.scene.imageVersions || [];
  const { arrayIndexForDb } = require('./versionManager');
  const v = versions[arrayIndexForDb(versions, versionIndex, 'scene')] || null;
  return {
    source: `v${versionIndex}`,
    finalScore: v?.finalScore ?? null,
    qualityScore: v?.qualityScore ?? null,
    // The page-level number too, so a member that resolved to nothing is
    // obvious rather than silently reading as an unscored version.
    pageActiveFinalScore: ctx.scene.finalScore ?? null,
  };
}

/**
 * EVAL VARIANCE — the same image, scored N times, nothing else changed.
 *
 * The question this answers: when two near-identical versions of a page score
 * 28 and 85, how much of that gap is the IMAGE and how much is the JUDGE?
 * Everything the judges see here is frozen — same bytes, same brief, same
 * reference photos, same templates — so every difference between repeats is
 * judge nondeterminism, measured rather than argued about.
 *
 * The score reproduced per repeat is the production one, through the WHOLE
 * chain a repair round uses: 4 evaluators → feedback consolidator →
 * applyScore over the deduped issues. Scoring the raw buckets instead would
 * measure a number the pipeline never uses, and would miss the consolidator's
 * own contribution — merging two evaluators' reports of one defect, or failing
 * to, moves the score without any evaluator changing its mind. Both numbers
 * are reported per run (rawScore vs finalScore) so that contribution is
 * readable rather than assumed.
 *
 * ENTITY IS EXCLUDED — it is a separate cross-page evaluator that
 * evaluateImageQuality does not run, so its own variance is out of scope here.
 *
 * Attribution: findings are matched across repeats with the SAME rule the
 * ranker uses to merge findings across evaluators (scoring.sameConcept), which
 * splits the variance into the two mechanisms that behave differently:
 *   - DETECTION flips: a concept present in some repeats and absent in others
 *   - SEVERITY flips: a concept present in every repeat at different severities
 * Anything left is the deterministic floor — the findings all repeats agree on.
 *
 * target.versionIndex pins a stored version (the two versions of one page are
 * two members of the set); omitted → the page's active version.
 * params.repeats     — 2..5, default 3.
 * params.consolidate — default true (the production chain). false measures the
 *                      raw evaluator buckets only, to separate the two layers.
 */
async function runEvalVarianceStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { evaluateImageQuality } = require('./images');
  const { consolidateEvaluation } = require('./feedbackConsolidator');
  const {
    composeDeductions, computeMathFinalScore, deductionPoints, deductionClassKey,
    significantWords, sameConcept,
  } = require('./scoring');

  const repeats = Math.max(2, Math.min(5, parseInt(params.repeats, 10) || 3));
  const useConsolidator = params.consolidate !== false;
  const versionIndex = Number.isFinite(Number(ctx.target?.versionIndex))
    ? Number(ctx.target.versionIndex) : null;
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, versionIndex);

  // Frozen inputs, resolved ONCE and reused by every repeat — re-deriving them
  // per run would let an input drift and be mistaken for judge variance.
  const sceneDescription = evalSceneDescription(ctx);
  const referencePhotos = evalReferencePhotos(ctx);
  const artStyle = require('../services/prompts').resolveEvalArtStyle(ctx.artStyle, ctx.scene.prompt || null);

  const runs = [];
  for (let i = 1; i <= repeats; i++) {
    const t0 = Date.now();
    let evalResult = null;
    let error = null;
    try {
      evalResult = await evaluateImageQuality(
        imageData, sceneDescription, referencePhotos, 'scene',
        null, `testlab-var${experimentId}-P${ctx.pageNumber}-r${i}`,
        ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
        { artStyle }
      );
    } catch (err) { error = err.message; }
    const elapsedMs = Date.now() - t0;

    if (!evalResult) {
      // A null eval is itself a variance datum (a safety block or a truncated
      // response IS a way the eval differs run to run) — recorded, not thrown,
      // so the remaining repeats still produce a measurement.
      runs.push({ run: i, ok: false, error: error || 'evaluateImageQuality returned null', elapsedMs });
      continue;
    }

    // RAW layer — what the four evaluators said, before any deduping. The
    // findings measured for stability come from here: the consolidator's
    // deduped list is a summary, and attributing a flip to a judge needs the
    // judge's own words.
    const raw = composeDeductions({ evalResult });
    const findings = [];
    for (const bucket of ['quality', 'semantic', 'compliance']) {
      for (const d of (raw[bucket] || [])) {
        findings.push({
          source: bucket, type: d.type || null, severity: d.severity,
          // The subject (character/object) and the billing key it produces.
          // Without these a variance run cannot tell whether two findings of
          // one type are one defect or two on different characters — which is
          // exactly the question the per-character grouping turns on.
          name: d.name || null,
          classKey: deductionClassKey(d),
          points: deductionPoints(d), description: d.description || '',
        });
      }
    }
    const pointsBy = (b) => (raw[b] || []).reduce((s, d) => s + deductionPoints(d), 0);

    // CONSOLIDATED layer — the production score. Same call the repair round
    // makes, against the same scene contract.
    let plan = null;
    let consolidateError = null;
    if (useConsolidator) {
      try {
        const res = await consolidateEvaluation({
          evalResult, entityIssues: [],
          sceneDescription, characters: ctx.characters || [],
          storyId: ctx.storyId, pageNumber: ctx.pageNumber, round: i,
        });
        plan = res.plan || null;
        if (res.error) consolidateError = res.error;
      } catch (err) { consolidateError = err.message; }
    }
    const scored = plan ? composeDeductions({ evalResult, consolidated: plan.deduped_issues }) : raw;

    runs.push({
      run: i, ok: true, elapsedMs,
      finalScore: computeMathFinalScore(scored),
      rawScore: computeMathFinalScore(raw),
      dedupedCount: plan ? (plan.deduped_issues || []).length : null,
      ...(consolidateError ? { consolidateError } : {}),
      points: {
        quality: pointsBy('quality'), semantic: pointsBy('semantic'),
        compliance: pointsBy('compliance'),
        total: pointsBy('quality') + pointsBy('semantic') + pointsBy('compliance'),
      },
      counts: {
        quality: (raw.quality || []).length,
        semantic: (raw.semantic || []).length,
        compliance: (raw.compliance || []).length,
      },
      findings,
      issuesSummary: evalResult.issuesSummary || null,
    });
  }

  const ok = runs.filter(r => r.ok);
  if (ok.length < 2) throw new Error(`Only ${ok.length}/${repeats} evaluations returned a result — cannot measure variance`);

  // MIN-MAX RANGE IS A BAD ESTIMATOR AT n=3, and it is the headline number on
  // every card — so it also reports the statistics that degrade more gracefully
  // and flags its own unreliability.
  //
  // This is not theoretical. Comparing exp769 against the exp768 baseline, two
  // pages appeared to REGRESS (pixar 40->55, and the deliberately-stable control
  // 10->40) and both were reported to the owner as real. Re-running the same 5
  // pages against the shipped rule (exp770) put them at 40 and 0 — the
  // "regressions" were sampling. Range keys on the two most extreme draws, so one
  // unlucky repeat moves it by its full amount; MAD and stdev do not.
  //
  // Read the AGGREGATE across a set, not a single page's range, when n < 5.
  const stat = (values) => {
    const n = values.length;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const sorted = [...values].sort((a, b) => a - b);
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const devs = values.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = devs.length % 2 ? devs[(devs.length - 1) / 2] : (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2;
    const r1 = (x) => Math.round(x * 10) / 10;
    return {
      values, min: Math.min(...values), max: Math.max(...values),
      range: Math.max(...values) - Math.min(...values),
      mean: r1(mean), median: r1(median),
      stdev: r1(Math.sqrt(variance)),
      // Median absolute deviation — unmoved by one outlying repeat, which is
      // exactly the failure mode that produced the false regressions above.
      mad: r1(mad),
      // Honest label for how much weight this page's number can carry alone.
      reliability: n >= 5 ? 'ok' : 'low',
      ...(n < 5 ? { reliabilityNote: `range over ${n} samples is noisy — compare the set aggregate, not this page alone` } : {}),
    };
  };

  // Cluster every finding from every repeat into concepts. A concept records
  // WHICH repeats saw it and at what severity/cost — that pair is the whole
  // attribution.
  const concepts = [];
  for (const r of ok) {
    for (const f of r.findings) {
      const words = significantWords(f.description);
      // A concept may only be hit ONCE per repeat, or one repeat reporting the
      // same defect twice would read as agreement across repeats.
      let c = concepts.find(x => sameConcept(x.words, words) && !x.runs.includes(r.run));
      if (!c) {
        c = concepts.find(x => sameConcept(x.words, words));
        if (c && c.runs.includes(r.run)) { c.duplicatesWithinRun = (c.duplicatesWithinRun || 0) + 1; continue; }
      }
      if (!c) {
        c = { words, label: f.description.slice(0, 160), sources: [], types: [], severities: {}, points: [], runs: [] };
        concepts.push(c);
      }
      for (const w of words) c.words.add(w);
      if (!c.sources.includes(f.source)) c.sources.push(f.source);
      if (f.type && !c.types.includes(f.type)) c.types.push(f.type);
      c.severities[f.severity] = (c.severities[f.severity] || 0) + 1;
      c.points.push(f.points);
      c.runs.push(r.run);
    }
  }

  const conceptOut = concepts.map(c => {
    const detectionStable = c.runs.length === ok.length;
    const severityStable = Object.keys(c.severities).length === 1;
    return {
      label: c.label, sources: c.sources, types: c.types,
      seenIn: c.runs.sort((a, b) => a - b), of: ok.length,
      severities: c.severities,
      minPoints: Math.min(...c.points), maxPoints: Math.max(...c.points),
      // Cost swing this ONE concept can put on the score: absent-vs-worst for a
      // detection flip, cheapest-vs-dearest severity for a severity flip.
      swing: detectionStable ? Math.max(...c.points) - Math.min(...c.points) : Math.max(...c.points),
      verdict: !detectionStable ? 'detection-flip' : (!severityStable ? 'severity-flip' : 'stable'),
      ...(c.duplicatesWithinRun ? { duplicatesWithinRun: c.duplicatesWithinRun } : {}),
    };
  }).sort((a, b) => b.swing - a.swing || a.verdict.localeCompare(b.verdict));

  const detectionFlips = conceptOut.filter(c => c.verdict === 'detection-flip');
  const severityFlips = conceptOut.filter(c => c.verdict === 'severity-flip');
  const stable = conceptOut.filter(c => c.verdict === 'stable');

  const bySource = {};
  for (const src of ['quality', 'semantic', 'compliance']) {
    bySource[src] = {
      pointRange: stat(ok.map(r => r.points[src])).range,
      detectionFlips: detectionFlips.filter(c => c.sources.includes(src)).length,
      severityFlips: severityFlips.filter(c => c.sources.includes(src)).length,
    };
  }

  return {
    storyId: ctx.storyId, pageNumber: ctx.pageNumber,
    versionIndex, repeats, okRuns: ok.length, consolidated: useConsolidator,
    // The production number …
    scoreSpread: stat(ok.map(r => r.finalScore)),
    // … and the same runs scored WITHOUT the consolidator. A rawSpread that is
    // tight while scoreSpread is wide means the evaluators agreed and the
    // consolidator did not; the reverse means the consolidator is absorbing
    // evaluator noise.
    rawSpread: stat(ok.map(r => r.rawScore)),
    countSpread: stat(ok.map(r => r.findings.length)),
    pointSpread: {
      quality: stat(ok.map(r => r.points.quality)),
      semantic: stat(ok.map(r => r.points.semantic)),
      compliance: stat(ok.map(r => r.points.compliance)),
    },
    attribution: {
      // Points every repeat charges — the deterministic floor of this page.
      stablePoints: stable.reduce((s, c) => s + c.maxPoints, 0),
      detectionFlipCount: detectionFlips.length,
      severityFlipCount: severityFlips.length,
      stableCount: stable.length,
      // Worst-case score gap two runs of THIS eval could produce on this image
      // if every flip landed the same way. The observed range is a sample of it.
      potentialSwing: conceptOut.reduce((s, c) => s + c.swing, 0),
      bySource,
    },
    concepts: conceptOut,
    runs,
    // The score this exact image already carries, which is what the repeats are
    // compared against. For a PINNED version that is the version's own stored
    // score — ctx.scene.finalScore is the page's ACTIVE version, so on a set
    // holding two versions of one page both members would otherwise report the
    // winner's score and the comparison would read backwards.
    storedBaseline: storedBaselineFor(ctx, versionIndex),
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
/**
 * Expected-characters list for detection — MUST be production's builder
 * (buildExpectedCharactersForBbox): it resolves per-page/costume clothing and
 * overrides the modern wardrobe baked into richDescription. The Test Lab's
 * old hand-rolled version passed raw richDescription ("wearing gray hoodie")
 * on costume pages, so the SoM identity step matched against the wrong outfit
 * and tagged figures UNKNOWN (exp #68: Roger unfindable on a medieval page).
 * The Test Lab only ASSEMBLES the stored inputs; the logic is production's.
 */
function buildExpectedCharacters(ctx) {
  const { buildExpectedCharactersForBbox } = require('./images');
  const descriptions = ctx.scene.bboxDetection?.characterDescriptions || {};

  // Positions/actions: stored sceneMetadata → production extractor on the Art
  // Director prose → outlineExtract (structured per-character position incl.
  // action, e.g. "center-right background being led away" — feeds the SoM
  // position hint, often the only cue for occluded figures).
  const positions = { ...(ctx.scene.sceneMetadata?.characterPositions || {}) };
  if (Object.keys(positions).length === 0 && ctx.scene.sceneDescription) {
    try {
      const meta = require('./storyHelpers').extractSceneMetadata(ctx.scene.sceneDescription);
      Object.assign(positions, meta?.characterPositions || {});
    } catch { /* prose without metadata — outlineExtract below */ }
  }
  try {
    const oe = typeof ctx.scene.outlineExtract === 'string'
      ? JSON.parse(ctx.scene.outlineExtract) : ctx.scene.outlineExtract;
    for (const c of (oe?.characters || [])) {
      if (c?.name && c.position && !positions[c.name]) positions[c.name] = c.position;
    }
  } catch { /* outlineExtract not JSON */ }

  // A COVER GETS THE SAME CLOTHING INFO AS A PAGE (owner, 2026-08-15).
  //
  // Covers carry no per-page clothing category — `pageClothing` is keyed by page
  // number and stops at the last page, and a cover's scene object has neither
  // sceneCharacterClothing nor sceneMetadata. With an empty map every figure
  // reached the detector as a bare name, so nothing could read the garment
  // colours off the identity line and the garment seed points never fired: on
  // job_1786780194082_s980g4s9a p-2 Sarah's cut-out came back full of holes,
  // 38,107px against the 73,828px she masks once one dot lands on her blouse.
  //
  // The story-level requirement is the canonical source and always knows which
  // category is in play, so fall back to the one marked `used`. This also
  // rescues any ordinary page whose per-page metadata is missing.
  let clothing = ctx.scene.sceneCharacterClothing || ctx.scene.sceneMetadata?.characterClothing || {};
  if (Object.keys(clothing).length === 0 && ctx.clothingRequirements) {
    const fromRequirements = {};
    for (const [name, cats] of Object.entries(ctx.clothingRequirements)) {
      const used = Object.entries(cats || {}).find(([, v]) => v && v.used);
      if (used) fromRequirements[name] = used[0];
    }
    if (Object.keys(fromRequirements).length > 0) clothing = fromRequirements;
  }
  if (Object.keys(descriptions).length > 0) {
    return buildExpectedCharactersForBbox(descriptions, positions, clothing);
  }
  // Very old story without stored characterDescriptions — minimal fallback.
  return (ctx.scene.sceneCharacters || ctx.referencePhotos || []).map(c => ({
    name: c.name,
    description: c.description || '',
    position: positions[c.name] || c.position || '',
    clothing: '',
    gdinoPrompt: null,
  })).filter(c => c.name);
}

async function runBboxStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { detectAllBoundingBoxes } = require('./images');
  const { MODEL_DEFAULTS } = require('../config/models');

  // params.versionIndex pins the exact bytes so an A/B of the detection knobs
  // compares the same picture, not whatever won pick-best in between.
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, params.versionIndex, params.imageType);
  // Which bytes this run actually tested — exp #7/#9 could not answer that,
  // and 'null' must be impossible: an unrecorded load is itself a finding.
  const _load = getLastPageLoad();
  // Same null-guard as the loader: Number(null)===0 must not read as "pinned 0".
  const _pinnedParam = (params.versionIndex == null || params.versionIndex === '') ? null
    : (Number.isFinite(Number(params.versionIndex)) ? Number(params.versionIndex) : null);
  const loadedFrom = _pinnedParam !== null
    ? { pinned: _pinnedParam }
    : (_load && _load.storyId === ctx.storyId && String(_load.pageNumber) === String(ctx.pageNumber)
      ? { ..._load } : { unrecorded: true });
  const expectedCharacters = buildExpectedCharacters(ctx);

  // When grounding-dino is the configured backend, a cold analyzer (every
  // deploy restarts it; DINO loads ~90s+) makes detectAllBoundingBoxes fall
  // back to the Gemini bbox SILENTLY — exps #70-#74 ran on Gemini's sloppy
  // left-shifted face boxes without anyone knowing, which made runs
  // incomparable ("what changed? DINO is deterministic"). The lab demands
  // the configured backend: retry until DINO answers, fail loudly if it
  // never does. Production keeps its silent fallback (resilience there is
  // deliberate); comparability is the lab's whole point.
  const wantDino = MODEL_DEFAULTS.figureDetectionBackend === 'grounding-dino';
  const t0 = Date.now();
  let result = null;
  const ATTEMPTS = 5;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    result = await detectAllBoundingBoxes(imageData, {
      expectedCharacters,
      sceneContext: (ctx.scene.sceneDescription || '').slice(0, 2000),
      artStyle: ctx.artStyle,
      skipCache: true,
      pageContext: `testlab-exp${experimentId}-P${ctx.pageNumber}`,
      // Detection knob under test: 'box'|'face' badge anchor. `facePairing` is
      // gone — face->figure is now solved ONCE, globally, before masking
      // (_pairFacesGlobally), rather than by two competing strategies chosen
      // here. Passing it would have quietly done nothing.
      badgeAnchor: params.badgeAnchor,
    });
    // 'gemini-second-opinion' is a DELIBERATE arbitration verdict (DINO ran,
    // undercounted, Gemini found more figures) — not a cold-analyzer fallback.
    const okBackends = ['grounding-dino', 'gemini-second-opinion', 'dino+gemini-extra'];
    if (!wantDino || okBackends.includes(result?.detectionBackend)) break;
    if (attempt < ATTEMPTS) {
      log.info(`[TESTLAB] detection fell back to ${result?.detectionBackend || 'gemini'} (DINO cold after deploy?) — retry ${attempt}/${ATTEMPTS - 1} in 45s`);
      await new Promise(r => setTimeout(r, 45000));
    }
  }
  const elapsedMs = Date.now() - t0;
  if (!result) throw new Error('Bbox detection returned null');
  if (wantDino && !['grounding-dino', 'gemini-second-opinion', 'dino+gemini-extra'].includes(result.detectionBackend)) {
    throw new Error(`Detection fell back to ${result.detectionBackend || 'gemini'} on every attempt — GroundingDINO unreachable (cold analyzer after deploy?). Rerun when the service is warm; refusing to chain repairs onto fallback boxes.`);
  }

  // ALWAYS attach the box overlay as a step image (production renderer) —
  // the detector's body+face boxes must be inspectable on every detection
  // entry, not reconstructed by hand when something looks off.
  const steps = [];
  try {
    const { createBboxOverlayImage, createSamInputOverlayImage, createCutoutSheetImage } = require('./images');
    const overlay = await createBboxOverlayImage(imageData, result);
    if (overlay) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, overlay, experimentId);
      steps.push({ label: `detected boxes (${result.detectionBackend || 'gemini'}): body solid, face dashed`, imageType: 'tl_step', versionIndex: v });
    }
    // The SAM PROMPT, one cell per call. Output without input made every
    // segmentation failure a re-run: a merged figure looks the same whether its
    // face dot was missing, its garment dot landed on the neighbour, or the
    // neighbour's negative was never placed.
    // What the identity call SAW and was ASKED. A wrong name is otherwise an
    // argument; with the badged image it is one look (a badge sitting in the gap
    // between two people names the wrong one every time).
    const som = result.gdinoDiag?._som;
    if (som?.image) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, som.image, experimentId);
      steps.push({ label: 'SENT FOR IDENTITY — badged scene (SoM)', imageType: 'tl_step', versionIndex: v });
    }
    // THE RESULT, first in the list and full size. Everything downstream —
    // eval, repair, garment fix — consumes these cut-outs, so they are not a
    // footnote under the annotated page.
    const sheet = await createCutoutSheetImage(imageData, result);
    if (sheet) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, sheet, experimentId);
      steps.unshift({ label: 'CUT-OUTS — the result: what every eval and repair downstream actually sees', imageType: 'tl_step', versionIndex: v });
    }
    const samIn = await createSamInputOverlayImage(imageData, result);
    if (samIn) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, samIn, experimentId);
      steps.push({ label: 'SENT TO SAM — the FULL PAGE + this box + these points (green face, blue garment, red = not me). Nothing is erased; the dimming is only so the box reads as a frame', imageType: 'tl_step', versionIndex: v });
    }
  } catch (err) {
    log.warn(`[TESTLAB] bbox overlay failed (${err.message}) — entry has numeric boxes only`);
  }

  return {
    elapsedMs,
    steps: steps.length ? steps : undefined,
    detectionBackend: result.detectionBackend || null,
    // Which stored version this run detected on (pinned, or the active-version
    // resolution incl. whether the v0 fallback fired).
    loadedFrom,
    // How the figures got their names, and — when SoM ran — the exact prompt and
    // its raw answer. 'layout-fallback' here means the names are geometry and
    // gender guesses, which is worth seeing before trusting any of them.
    identity: result.gdinoDiag?.identity || null,
    somPrompt: result.gdinoDiag?._som?.prompt || null,
    figures: (result.figures || []).map(f => ({
      name: f.name,
      bbox: f.bodyBox || f.bbox || f.box_2d,
      faceBbox: f.faceBox || f.faceBbox || null,
      // Raw detector boxes for debugging drift: DINO person box (pre-SAM)
      // and unpadded DINO face box + its score.
      gdinoBox: f.gdinoBox || null,
      faceBboxRaw: f.faceBoxRaw || null,
      faceScore: f.faceScore,
      confidence: f.confidence,
      // SAM silhouette decision per figure — this mask is now the shared cutout
      // for both eval and repair, so its verdict must be inspectable here. The
      // mask itself is drawn in the overlay cutout strip above; these say whether
      // it was accepted (bodyBox = mask bounds) or the tight DINO box was kept.
      samApplied: f.samApplied ?? null,
      maskVerdict: f.maskVerdict || null,
      // Share of the DINO box the accepted mask fills — the number the
      // coverage floor is judged against, so a 'rejected-too-small' verdict
      // can be checked here instead of re-deriving it from the boxes.
      maskCoverage: f.maskCoverage ?? null,
      // Occlusion facts from the joint depth pass (2026-08-15). Without these a
      // Lab run can only be judged by eye off the cut-out strip: it cannot say
      // how much of a figure survived, how much a figure in front took from it,
      // who took it, or whether the garment seed points fired at all. That
      // blocked three separate conclusions the day they were added.
      maskPx: f.maskPx ?? null,
      pxLostToFront: f.pxLostToFront ?? null,
      occluded: f.occluded ?? null,
      occludedBy: f.occludedBy || null,
      garmentSeeds: f.garmentSeeds ?? null,
      // WHERE each seed landed and why one was not placed — the count alone
      // could not explain a figure coming back with its clothing erased.
      seedTrace: f.seedTrace || null,
      facePoint: f.facePoint || null,
      // The prompt SAM was actually given for this figure (px box + labelled
      // points), so the rendered cell above can be checked against numbers.
      samBox: f.samBox || null,
      samPoints: f.samPoints || null,
    })),
    objects: (result.objects || []).map(o => ({ name: o.name, bbox: o.bodyBox || o.bbox || o.box_2d })),
  };
}

/**
 * Character box for a page: stored detection first, else run a fresh bbox
 * detection on the image (same call the bbox stage uses). Returns
 * {bbox, faceBbox, source} or null.
 */
async function resolveCharacterBox(ctx, imageData, charName, { detection = null } = {}) {
  // Figure boxes appear as bodyBox/faceBox (detection contract) or bbox/box_2d
  // (older records / repair params) depending on the writer.
  const fromDet = (det) => {
    const fig = (det?.figures || det?.characters || []).find(f => (f.name || '').toLowerCase() === charName.toLowerCase());
    if (!fig) return null;
    const bbox = fig.bodyBox || fig.bbox || fig.box_2d || null;
    // faceBboxRaw = the TIGHT (unpadded) DINO face box — used to place the SAM
    // dots on the real face/hair, not out in the padded box's empty margin.
    return bbox?.length === 4 ? { bbox, faceBbox: fig.faceBox || fig.faceBbox || null, faceBboxRaw: fig.faceBboxRaw || null } : null;
  };
  // Chained-experiment detection (fresh, from a bbox step in the SAME
  // experiment) always wins over whatever generation-time data is stored.
  // GDINO→SAM bodyBoxes are MASK-TIGHT bounds — they clip hair/fingertips/
  // feet. Pad slightly for repair use; the detection entry keeps raw truth.
  if (detection) {
    const chained = fromDet(detection);
    // Chained detection is AUTHORITATIVE: when the experiment reran detection
    // and the character isn't in the result, falling back to the stored
    // generation-time box silently mixes in an older, worse detector's
    // opinion — exp #68 repainted the wrong person that way (stale "Roger"
    // box sat on another figure). Fail honestly instead.
    if (!chained) {
      const found = (detection.figures || []).map(f => f.name).filter(Boolean).join(', ');
      throw new Error(`"${charName}" not found in this experiment's fresh detection (figures found: ${found || 'none'}) — refusing the stored generation-time box, it can point at the wrong figure. The character may be occluded or unidentifiable on this page.`);
    }
    const [y0, x0, y1, x1] = chained.bbox;
    const padY = (y1 - y0) * 0.04, padX = (x1 - x0) * 0.05;
    return {
      ...chained,
      bbox: [Math.max(0, y0 - padY), Math.max(0, x0 - padX), Math.min(1, y1 + padY), Math.min(1, x1 + padX)],
      source: 'chained-detection (padded 4-5%)',
    };
  }
  // Stored generation-time detection is only valid for the bytes it ran on
  // (sourceImageFp stamp) — stale box on newer pixels repaints the wrong
  // region. Mismatch → fresh detection below.
  const { bboxPairsWith } = require('./images');
  const storedDet = (!ctx._skipStoredBox && bboxPairsWith(ctx.scene.bboxDetection, imageData))
    ? ctx.scene.bboxDetection : null;
  const stored = fromDet(storedDet);
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
  let { experimentId, params = {} } = opts;
  // Blend replay: reuse a past run's model output + pinned detection, so an A/B
  // isolates the blend/colour stage on byte-identical images ($0, no model call).
  if (params.replayOf) {
    params = { ...(await resolveReplayParams(params.replayOf, ctx)), ...params };
    opts = { ...opts, params };
  }
  // Warm the SAM figure-mask service for any insert-pipeline run (qwen OR grok);
  // the legacy Grok blended/cutout path (explicit repairMode) warms it too.
  if (opts.params?.samBlend || opts.params?.backend === 'qwen' || opts.params?.backend === 'grok') warmupFigureMask();
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();

  const charName = params.characterName;
  if (!charName) throw new Error('char_repair requires params.characterName');

  // backend 'qwen' | 'grok' → the SAME crop-bounded insert pipeline (SAM face
  // extraction → union blend → colour-aware correction). The ONLY difference is
  // the model call inside runQwenInsertStage. This is the head-to-head path.
  // The legacy Grok blended/cutout/fullscene repair stays reachable via an
  // explicit repairMode (below); grok with no legacy repairMode = insert.
  const legacyGrokModes = ['blended', 'cutout', 'fullscene'];
  // An arm that names an AXIS is testing the spine, so it must not be routed to
  // the insert pipeline — that path never calls repairCharacterFace and does its
  // own whiteout regardless. Exps 862-865 asked for treatment blur vs whiteout,
  // fell through to grok-insert because repairMode was 'auto', and ran the SAME
  // treatment four times: a $1 comparison of nothing.
  const wantsAxis = !!(params.treatment || params.regionSource || params.faceOnly !== undefined);
  if (params.backend === 'qwen' || (params.backend === 'grok' && !legacyGrokModes.includes(params.repairMode) && !wantsAxis)) {
    const r = await runQwenInsertStage(ctx, {
      ...opts,
      params: { ...params, base: params.base || 'active', repairMode: true, cropPad: params.cropPad ?? 0.15 },
    });
    return { ...r, backend: params.backend, repairMode: `${params.backend}-insert` };
  }

  // target.versionIndex pins a stored version — repairing the ORIGINAL render
  // rather than whatever is active is how a repair is re-run under the same
  // conditions production saw. Null keeps the active version (previous default).
  const pinnedVersion = Number.isFinite(Number(ctx.target?.versionIndex))
    ? Number(ctx.target.versionIndex) : null;
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, pinnedVersion);
  // IDENTITY-TRANSFER TEST: params.referenceCharacter sends a DIFFERENT character's
  // avatar while still targeting charName's box. If the repair returns the original
  // character, identity is being copied from the page instead of the reference —
  // the sharpest test there is for a treatment (owner, 2026-08-05).
  const refName = params.referenceCharacter || charName;
  let ref = ctx.referencePhotos.find(p => (p.name || '').toLowerCase() === refName.toLowerCase());
  if (!ref && params.referenceCharacter) ref = await resolveSwapReference(ctx, refName, params.artStyleOverride);
  if (!ref) {
    const avail = ctx.referencePhotos.map(p => p.name).filter(Boolean).join(', ');
    throw new Error(`No reference photo for character "${refName}" on this page (available: ${avail || 'none'})`);
  }
  if (params.referenceCharacter) {
    log.info(`[TESTLAB] IDENTITY SWAP: repairing ${charName}'s region with ${refName}'s reference`);
  }

  // Bbox: explicit param → stored detection → fresh detection on the image.
  // params.freshDetection skips the stored box (stale/misattributed names on
  // older stories) and always re-detects.
  let bbox = params.bbox || null;
  let faceBbox = params.faceBbox || null;
  let boxSource = bbox ? 'param' : null;
  if (!bbox) {
    if (params.freshDetection) ctx._skipStoredBox = true;
    const resolved = await resolveCharacterBox(ctx, imageData, charName, { detection: params.detection || null });
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

  // Face repair with no face box: recover (zoom into the known body box,
  // re-run face detection) or fail loudly — never silently repair the body.
  const whiteoutTarget = params.whiteoutTarget || 'face';
  if (backend === 'grok' && whiteoutTarget === 'face' && !(faceBbox?.length === 4)) {
    const { recoverFaceBox } = require('./figureDetection');
    faceBbox = await recoverFaceBox(imageData, bbox, `testlab-P${ctx.pageNumber} ${charName}: `);
    if (faceBbox) boxSource = `${boxSource} + face-recovered`;
    else throw new Error(`Face repair requested for "${charName}" but no face box — full-page detection AND body-crop zoom recovery both found no face. Use whiteoutTarget "body" explicitly if a body repair is intended.`);
  }

  // Production-parity inputs — same as the automatic char-fix path: the
  // clothing-scoped styled avatar, the story's resolved clothing description
  // (clothingRequirements is canonical, avatars.clothing can be stale), and
  // protection boxes for every OTHER named character on the page.
  const { normalizeClothingCategory, resolveCharacterReqs } = require('./clothingCategories');
  const { getStyledAvatarForClothing } = require('./entityConsistency');
  // The styled avatar must follow the REFERENCE, not the target region — looking
  // it up by charName silently replaced a swapped reference with the original
  // character's avatar, so the identity-swap test ran with the wrong image and
  // its result was meaningless (owner caught this on exp #320).
  const character = (ctx.characters || []).find(c => (c.name || '').toLowerCase() === refName.toLowerCase()) || null;
  const clothingKey = Object.keys(ctx.scene.sceneCharacterClothing || {})
    .find(k => k.toLowerCase() === charName.toLowerCase());
  const clothingCategory = clothingKey
    ? normalizeClothingCategory(ctx.scene.sceneCharacterClothing[clothingKey])
    : 'standard';
  let avatarPhoto = ref.photoUrl;
  let avatarPhotoType = 'reference';
  if (character) {
    try {
      const styled = await getStyledAvatarForClothing(character, ctx.artStyle, clothingCategory);
      if (styled) {
        avatarPhoto = (await toDataUri(styled)) || avatarPhoto;
        avatarPhotoType = clothingCategory.startsWith('costumed')
          ? `costumed-${clothingCategory.split(':')[1] || 'default'}` : `styled-${clothingCategory}`;
      }
    } catch (err) {
      log.warn(`[TESTLAB] styled avatar lookup failed for ${charName} (${err.message}) — using page reference photo`);
    }
  }

  // Same cell selection as production's char-fix (repairPipeline): the shared
  // resolveCellPose/cropAvatarCell chain picks the sheet cell matching the
  // figure's declared facing — body cell for a body repair, face cell stacked
  // above it for a face repair. params.referenceCells overrides for A/B:
  // 'full' forces the raw 2x4 sheet (the old behaviour), 'body4' the body row,
  // 'body1' the front body cell.
  if (avatarPhoto && params.referenceCells !== 'full') {
    try {
      const sharpRC = require('sharp');
      const r2RC = require('./r2');
      if (params.referenceCells === 'body4' || params.referenceCells === 'body1') {
        const rcBuf = Buffer.from(r2RC.stripDataUriPrefix(await toDataUri(avatarPhoto) || avatarPhoto), 'base64');
        const rcMeta = await sharpRC(rcBuf).metadata();
        const W = rcMeta.width, H = rcMeta.height;
        const region = params.referenceCells === 'body1'
          ? { left: 0, top: Math.round(H / 2), width: Math.round(W / 4), height: Math.round(H / 2) }
          : { left: 0, top: Math.round(H / 2), width: W, height: Math.round(H / 2) };
        const cropped = await sharpRC(rcBuf).extract(region).jpeg({ quality: 92 }).toBuffer();
        avatarPhoto = `data:image/jpeg;base64,${cropped.toString('base64')}`;
        avatarPhotoType = `${avatarPhotoType}+${params.referenceCells}`;
      } else {
        const { resolveCellPose } = require('./storyAvatars');
        const { cropAvatarCell } = require('./sceneComposite');
        const metaChars = ctx.scene.sceneMetadata?.fullData?.characters
          || ctx.scene.sceneMetadata?.characters || ctx.scene.sceneCharacters || [];
        const sc = (Array.isArray(metaChars) ? metaChars : []).find(c =>
          ((typeof c === 'string' ? c : c?.name) || '').toLowerCase() === refName.toLowerCase());
        const pf = resolveCellPose(sc || {});
        const wantFace = whiteoutTarget === 'face';
        const { body, stacked } = await cropAvatarCell(avatarPhoto,
          { pose: pf.pose, includeFace: wantFace, stack: wantFace });
        const cell = wantFace ? (stacked || body) : body;
        if (cell) {
          avatarPhoto = cell;
          avatarPhotoType = `${avatarPhotoType}+cell-${pf.pose}${wantFace ? '-stacked' : ''}`;
        }
      }
    } catch (err) {
      log.warn(`[TESTLAB] cell selection failed (${err.message}) — sending the full sheet`);
    }
  }

  const clothingDescription = (() => {
    // Follows the REFERENCE character: during an identity swap the prompt must
    // not keep demanding the TARGET's outfit, or the model is told to paint the
    // original clothing onto the swapped person and nothing changes (owner:
    // "neither changed the clothing", exp #326).
    const reqs = resolveCharacterReqs(ctx.clothingRequirements, refName);
    if (reqs?.[clothingCategory]) {
      const cat = reqs[clothingCategory];
      if (cat.signature && cat.signature !== 'none') return cat.signature;
      if (cat.description) return cat.description;
    }
    return character?.avatars?.clothing?.[clothingCategory] || '';
  })();
  const detFigures = params.detection?.figures
    || ctx.scene.bboxDetection?.figures || ctx.scene.bboxDetection?.characters || [];
  const protectedFaces = [];
  const protectedBodies = [];
  const protectedNames = [];
  for (const f of detFigures) {
    const n = (f?.name || '').trim();
    // Named characters only — mirrors production, which protects sceneCharacters.
    if (!n || n.toUpperCase() === 'UNKNOWN' || n.toLowerCase() === charName.toLowerCase()) continue;
    const fb = f.faceBox || f.faceBbox;
    const bb = f.bodyBox || f.bbox || f.box_2d;
    if (fb?.length === 4) protectedFaces.push(fb);
    if (bb?.length === 4) protectedBodies.push(bb);
    if (fb?.length === 4 || bb?.length === 4) protectedNames.push(n);
  }

  // LAB DIVERGENCE (indexed): protectTargetFace adds the TARGET's own face box
  // to the protected set, so a body repaint keeps the original head pixels
  // instead of repainting them. Tests the two-pass idea — fix the body first,
  // then the face — against the measured failure where a full-figure repaint
  // returns a head in the wrong medium and proportion 7 times in 8. Production
  // does not have this option yet; promote or reject per docs/lab-divergences.md.
  if (params.protectTargetFace && faceBbox?.length === 4) {
    protectedBodies.push(faceBbox);
    protectedNames.push(`${charName}'s own face (protected)`);
  }

  // Route through the unified spine (server/lib/faceRepair.js). Legacy
  // repairMode flags + whiteoutTarget + backend → axes via legacyFlagsToAxes;
  // the spine blends INTERNALLY through samUnionBlend, so the old post-hoc
  // re-blend is gone. That re-blend was the testlab↔prod divergence — it stacked
  // a SECOND samUnionBlend on TOP of the production repair's own composite, so
  // the lab never saw what prod actually ships. Now both use the one spine.
  // Axes are NOT resolved here. The stage calls the same entry point the story
  // pipeline calls (images.repairCharacterMismatch), which owns bbox validation,
  // the face-box union expansion — "if a separate face box pokes outside the
  // body box, expand the body box so the treatment mask doesn't miss half the
  // face" — the char_repair_run metric, and legacyFlagsToAxes itself. Resolving
  // axes here meant the Lab skipped all of that and repaired a different region
  // than production would have.

  // Intermediates saved as tl_step versions so the UI shows the full chain. The
  // spine emits its SAM round-1/2 views through this addStep (threaded into
  // samUnionBlend), plus the treated input + model raw output below.
  const steps = [];
  const addStep = async (label, dataUri) => {
    if (typeof dataUri !== 'string' || !dataUri.startsWith('data:image')) return;
    const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, dataUri, experimentId);
    steps.push({ label, imageType: 'tl_step', versionIndex: v });
  };
  await addStep(`input: character reference (${avatarPhotoType})`, avatarPhoto);

  // Replay support for the crosshatch/blur spine: params.reuseModelOutput is a
  // tl_step version index (or a data URI) holding a previous 'model raw output'.
  let reuseCandidateUri = null;
  if (params.reuseModelOutput != null) {
    const v = params.reuseModelOutput;
    if (typeof v === 'string' && v.startsWith('data:image')) reuseCandidateUri = v;
    else {
      const img = await loadTestImage(ctx.storyId, 'tl_step', ctx.pageNumber, Number(v));
      if (!img?.imageData) throw new Error(`reuseModelOutput: tl_step v${v} not found on this page`);
      reuseCandidateUri = img.imageData;
    }
    log.info(`[TESTLAB] spine replay: reusing stored model output ${typeof v === 'number' ? 'tl_step v' + v : '(data URI)'}`);
  }

  const t0 = Date.now();
  // The SHARED production contract (charRepairRequest.js). Built from the same
  // field list the unified pipeline uses, so a Lab run sends what production
  // sends; anything this stage deliberately does differently is an override or
  // a Lab-only mechanic below, and every one is indexed in
  // docs/lab-divergences.md.
  const { buildCharRepairRequest } = require('./charRepairRequest');
  const sharedRequest = buildCharRepairRequest({
    imageBackend: backend,
    issueDescription: params.issueDescription || null,
    clothingDescription,
    // Face/hair/build text for the prompt. Follows refName so an identity swap
    // describes the person we actually want painted.
    characterDescription: (() => {
      const d = ctx.scene.bboxDetection?.characterDescriptions?.[refName];
      return (typeof d === 'string' ? d : d?.richDescription) || '';
    })(),
    photoType: avatarPhotoType,
    sceneDescription: ctx.scene.sceneDescription || ctx.scene.text || '',
    artStyle: params.artStyleOverride || ctx.artStyle || null,
    faceBbox: faceBbox || null,
    bodyBbox: bbox,
    whiteoutTarget,
    // SAME AS PRODUCTION: reuse the stored detection silhouette. This was
    // hardcoded null on the grounds that "a Lab run has no detection pass" —
    // true before masks were persisted, false now that detection writes
    // figure_mask rows. Left as null the Lab re-segmented on a crop while
    // production reused, so a Lab result was not evidence about production.
    // Resolves to null for a story with no stored mask, which is the old
    // behaviour and is reported as a miss.
    detectionBodyMask: await require('./charRepairTarget').resolveFigureMask(
      charName, { figures: ctx.scene.bboxDetection?.figures || [] },
      { storyId: ctx.storyId, pageNumber: ctx.pageNumber },
    ),
    protectedFaces,
    protectedBodies,
    textPosition: ctx.textPosition,
    includeDebug: true,
    // Axis overrides — omitted unless the experiment names one, so an unset run
    // resolves exactly as production does. This is what lets the Lab A/B a
    // treatment (blur vs whiteout on a face) instead of only a legacy mode.
    ...(params.treatment ? { treatment: params.treatment } : {}),
    ...(params.regionSource ? { regionSource: params.regionSource } : {}),
    ...(params.faceOnly !== undefined ? { faceOnly: !!params.faceOnly } : {}),
  });
  const { repairCharacterMismatch } = require('./images');
  const result = await repairCharacterMismatch(imageData, avatarPhoto, bbox, charName, {
    ...sharedRequest,
    // The A/B knob: legacy mode flags are what production's adapter reads to
    // pick the method, so forcing a mode here goes through the SAME resolution
    // production uses instead of bypassing it.
    ...modeFlags,
    // Lab-only MECHANICS (not behaviour deviations): per-step image capture and
    // deterministic replay of a stored model output.
    addStep,
    ...(reuseCandidateUri ? { reuseCandidate: reuseCandidateUri } : {}),
    // FULL identity swap: the prompt must NAME the reference character, or the
    // text keeps ordering the target back (exp #329: Roger's avatar + 'paint one
    // Lukas' = no change). Region/pose stay the target's.
    ...(params.referenceCharacter ? { promptName: refName } : {}),
    ...(params.blurStrength ? { blurStrength: params.blurStrength } : {}),
    ...(params.r2Prompt ? { r2Prompt: params.r2Prompt } : {}),
    // Crosshatch carries a blurred head by default (body pose from the hatch,
    // identity from the avatar). params.blurFace=false A/Bs the plain hatch.
    ...(params.blurFace !== undefined ? { blurFace: params.blurFace } : {}),
  });
  const elapsedMs = Date.now() - t0;
  const finalImage = result?.imageData;
  if (!finalImage) {
    // A GATE rejection is a result, not a void: show WHY and what the model
    // produced. Previously the card said only "returned no image (blend_gate)"
    // with zero steps, so a rejected treatment was undiagnosable (exp #306 blur).
    if (result?.blackoutImage) await addStep('sent to model (treated input)', result.blackoutImage);
    if (result?.grokRawResult) await addStep('model raw output (REJECTED)', result.grokRawResult);
    const err = new Error(`Character repair REJECTED by the ${result?.rejectedReason || 'unknown'} gate: ${result?.gateMessage || 'no detail'}`);
    err.partialResult = {
      steps,
      characterName: charName,
      bbox,
      faceBbox: faceBbox || undefined,
      descriptor: result?.descriptor,
      rejectedReason: result?.rejectedReason || 'unknown',
      gateMessage: result?.gateMessage || null,
      promptUsed: result?.promptSent || null,
      elapsedMs,
    };
    throw err;
  }

  await addStep('sent to model (whiteout/crosshatch)', result.blackoutImage);
  await addStep('model raw output', result.grokRawResult);

  // PER-FIGURE SAM AFTER THE REPAIR. One silhouette per detected character,
  // segmented from the FINAL image: the direct way to see whether a repair
  // damaged a neighbour or absorbed part of them (owner request). Diagnostic
  // only — never gates anything, and failures are silent.
  try {
    const sharpL = require('sharp');
    const { fetchFigureMaskPng } = require('./imageCompositing');
    const finalBuf = Buffer.from(String(finalImage).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const meta = await sharpL(finalBuf).metadata();
    const FW = meta.width, FH = meta.height;
    for (const f of detFigures) {
      const nm = (f?.name || '').trim();
      const bb = f?.bodyBox || f?.bbox || f?.box_2d;
      if (!nm || !Array.isArray(bb) || bb.length !== 4) continue;
      const box = [
        Math.max(0, Math.round(bb[1] * FW)), Math.max(0, Math.round(bb[0] * FH)),
        Math.min(FW, Math.round(bb[3] * FW)), Math.min(FH, Math.round(bb[2] * FH)),
      ];
      if (box[2] - box[0] < 12 || box[3] - box[1] < 12) continue;
      const m = await fetchFigureMaskPng(finalBuf, box, {});
      if (!m) continue;
      const alpha = await sharpL(m).resize(FW, FH, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
      const cut = await sharpL(finalBuf).ensureAlpha()
        .joinChannel(alpha, { raw: { width: FW, height: FH, channels: 1 } }).png().toBuffer();
      const onDark = await sharpL({ create: { width: FW, height: FH, channels: 3, background: { r: 26, g: 26, b: 30 } } })
        .composite([{ input: cut }]).jpeg({ quality: 88 }).toBuffer();
      const isTarget = nm.toLowerCase() === charName.toLowerCase();
      await addStep(`AFTER repair — SAM of ${nm}${isTarget ? ' (repaired)' : ''}`, `data:image/jpeg;base64,${onDark.toString('base64')}`);
    }
  } catch (err) {
    log.warn(`[TESTLAB] per-figure SAM diagnostic failed (${err.message}) — skipped`);
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, finalImage, experimentId);
  return {
    imageType: 'scene', versionIndex, characterName: charName, bbox, faceBbox: faceBbox || undefined, boxSource, backend,
    repairMode: backend === 'grok' ? repairMode : null,
    clothingCategory, avatarPhotoType,
    protectedCharacters: protectedNames.length ? protectedNames : undefined,
    samBlend: true,
    blendRule: BLEND_RULE_VERSION,
    descriptor: result.descriptor,
    // The spine returns promptSent; the card shows promptUsed — without this
    // the legacy treatments (crosshatch/blur) showed NO prompt at all (#302).
    promptUsed: result.promptSent || null,
    method: result?.method || null, steps, elapsedMs,
  };
}

/**
 * params.repeats (1-5, default 1) — run the check N times on the SAME frozen
 * story and report how much it disagrees with itself.
 *
 * WHY: entity consistency is the one evaluator eval_variance cannot see —
 * evaluateImageQuality never runs it — so while every other judge's run-to-run
 * spread was measured (exp768: mean 36.8 points), entity's was simply unknown,
 * and it can charge a capped penalty against every page's finalScore.
 *
 * repeats=1 returns exactly what it always did, byte for byte; the variance
 * block only appears when someone asks for repeats.
 */
async function runEntityStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { dbQuery, rehydrateStoryImages } = require('../services/database');
  const { runEntityConsistencyChecks } = require('./entityConsistency');
  const { SEVERITY_POINTS, significantWords, sameConcept, capEntityPenalty } = require('./scoring');

  const repeats = Math.max(1, Math.min(5, parseInt(params.repeats, 10) || 1));

  // Loaded ONCE and reused by every repeat — re-reading per run would let the
  // input drift and be mistaken for judge variance.
  const rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [ctx.storyId]);
  if (rows.length === 0) throw new Error('Story not found');
  let storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  storyData = await rehydrateStoryImages(ctx.storyId, storyData);

  const stripImages = (obj) => JSON.parse(JSON.stringify(obj, (key, value) => {
    if (typeof value === 'string' && value.startsWith('data:image')) return `[image ${Math.round(value.length / 1024)}KB]`;
    return value;
  }));

  // The signal the PIPELINE scores on: per-page penalty derived from each
  // character's issues (repairPipeline.getEntityPenaltyAndIssues), not the
  // report's own display score.
  const extract = (report) => {
    const issues = [];
    const pagePenalty = {};
    for (const [name, data] of Object.entries(report?.characters || {})) {
      for (const issue of (data.issues || [])) {
        const sev = String(issue.severity || '').toLowerCase();
        const pts = SEVERITY_POINTS[sev] || 0;
        const pages = issue.pages || issue.pagesToFix || (issue.pageNumber != null ? [issue.pageNumber] : []);
        issues.push({ name, severity: sev, points: pts, pages: [...pages].sort((x, y) => x - y), description: issue.description || issue.problem || '' });
        for (const p of pages) pagePenalty[p] = (pagePenalty[p] || 0) + pts;
      }
    }
    for (const p of Object.keys(pagePenalty)) pagePenalty[p] = capEntityPenalty(pagePenalty[p]);
    return {
      totalIssues: report?.totalIssues ?? issues.length,
      overallConsistent: report?.overallConsistent ?? null,
      charactersChecked: Object.keys(report?.characters || {}).length,
      evalFailures: Object.values(report?.characters || {}).filter(c => c.evalFailed).length,
      issues,
      pagePenalty,
      penaltyTotal: Object.values(pagePenalty).reduce((s, v) => s + v, 0),
    };
  };

  const runs = [];
  let firstReport = null;
  for (let i = 1; i <= repeats; i++) {
    const t0 = Date.now();
    const report = await runEntityConsistencyChecks(storyData, storyData.characters || [], {
      checkCharacters: true,
      checkObjects: false,
      saveGrids: false,
    });
    if (i === 1) firstReport = stripImages(report);
    runs.push({ run: i, elapsedMs: Date.now() - t0, ...extract(report) });
  }

  if (repeats === 1) return { elapsedMs: runs[0].elapsedMs, report: firstReport };

  // Match issues across runs by the SAME rule the ranker uses to merge findings
  // across evaluators, so "did it find the same thing twice?" is not a second
  // definition of sameness.
  const concepts = [];
  for (const r of runs) {
    for (const f of r.issues) {
      const words = significantWords(f.description);
      let c = concepts.find(x => x.name === f.name && sameConcept(x.words, words) && !x.runs.includes(r.run));
      if (!c) {
        c = { name: f.name, words, label: f.description.slice(0, 140), severities: {}, points: [], pages: new Set(), runs: [] };
        concepts.push(c);
      }
      for (const w of words) c.words.add(w);
      c.severities[f.severity] = (c.severities[f.severity] || 0) + 1;
      c.points.push(f.points);
      for (const p of f.pages) c.pages.add(p);
      c.runs.push(r.run);
    }
  }
  const spread = (vals) => ({ values: vals, min: Math.min(...vals), max: Math.max(...vals), range: Math.max(...vals) - Math.min(...vals) });

  return {
    storyId: ctx.storyId, repeats,
    issueCountSpread: spread(runs.map(r => r.issues.length)),
    penaltySpread: spread(runs.map(r => r.penaltyTotal)),
    evalFailureSpread: spread(runs.map(r => r.evalFailures)),
    concepts: concepts.map(c => ({
      character: c.name, label: c.label, seenIn: c.runs.sort((a, b) => a - b), of: repeats,
      severities: c.severities, pages: [...c.pages].sort((a, b) => a - b),
      verdict: c.runs.length !== repeats ? 'detection-flip'
        : (Object.keys(c.severities).length > 1 ? 'severity-flip' : 'stable'),
    })).sort((a, b) => a.verdict.localeCompare(b.verdict)),
    runs: runs.map(({ issues, ...rest }) => ({ ...rest, issues })),
    report: firstReport,
  };
}

/**
 * Garment-hue normalization stage — the pre-eval, lighting-aware hue correction
 * (server/lib/garmentHueNormalize.js). Runs a FRESH detection (so the in-process
 * SAM masks exist — stored DB detections have none), resolves each figure's
 * styled avatar for THIS page's clothing, and runs the normalization with
 * before/after crops. Surfaces per figure: measured hue drift, the estimated
 * illumination cast, whether a correction was applied + why, and before/after
 * crops — so the owner can eyeball that lighting is preserved and only true
 * drift is corrected. Saves the corrected full page as a scene test version.
 * Target: {storyId, pageNumber}. params.opts = threshold overrides (A/B).
 */
/**
 * Render ONE "shift summary" image for a garment-colour run: a row per
 * character showing the figure before, the SAM garment mask, the figure after,
 * three colour chips (garment as rendered / avatar target / result), and the
 * numbers. Skipped figures are included with their reason — "how did each
 * character shift" has to answer "not at all, because X" too.
 *
 * The MASK is on the row deliberately. It is the one artifact that separates
 * "the mask was wrong" from "the colour maths was wrong", which is the first
 * question anyone asks of a bad result.
 */
async function renderGarmentColourSummary(perFigure, stepsByFigure, pageNumber) {
  const sharp = require('sharp');
  const { _labToRgb } = require('./imageCompositing');
  const ROW_H = 196, PAD = 12, THUMB = 140, CHIP = 38, W = 1420, HEAD_H = 52;
  const rows = perFigure.filter(f => f && f.name);
  if (!rows.length) return null;
  const H = HEAD_H + rows.length * ROW_H + PAD;
  const esc = (v) => String(v == null ? '' : v).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const RAD = Math.PI / 180;
  // The report stores hue+chroma+L, not RGB — rebuild the swatch from them.
  const chip = (c) => {
    if (!c || c.hueDeg == null || c.chroma == null || c.L == null) return '#ccc';
    const rgb = _labToRgb(c.L, c.chroma * Math.cos(c.hueDeg * RAD), c.chroma * Math.sin(c.hueDeg * RAD));
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  };

  const composites = [];
  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <text x="${PAD}" y="30" font-family="sans-serif" font-size="20" font-weight="700" fill="#111">Garment colour fix — page ${pageNumber}</text>
    <text x="${PAD}" y="${HEAD_H - 8}" font-family="sans-serif" font-size="12" fill="#777">page before  ·  SAM mask (magenta = moved, cyan = gated out)  ·  page after  ·  STYLE REFERENCE the target colour was measured from</text>`;

  for (let i = 0; i < rows.length; i++) {
    const f = rows[i];
    const y = HEAD_H + i * ROW_H;
    const imgs = stepsByFigure[f.name] || {};
    // Fourth panel is the avatar sheet. Without it a wrong result is unreadable:
    // a perfect mask and a wrong target look identical in the numbers.
    const slots = [
      ['before', PAD, 'page BEFORE'],
      ['mask', PAD + THUMB + 8, 'SAM mask'],
      ['after', PAD + 2 * (THUMB + 8), 'page AFTER'],
      ['avatar', PAD + 3 * (THUMB + 8) + 14, 'STYLE REFERENCE'],
    ];
    for (const [key, left, caption] of slots) {
      const has = !!imgs[key];
      svg += `<text x="${left}" y="${y + 16}" font-family="sans-serif" font-size="10" font-weight="700" fill="${key === 'avatar' ? '#8a4b00' : '#888'}">${esc(caption)}</text>`;
      if (!has) {
        svg += `<text x="${left}" y="${y + 78}" font-family="sans-serif" font-size="11" fill="#bbb">— none —</text>`;
        continue;
      }
      try {
        const buf = Buffer.from(String(imgs[key]).replace(/^data:[^;]+;base64,/, ''), 'base64');
        composites.push({
          input: await sharp(buf).resize(THUMB, THUMB - 22, { fit: 'contain', background: '#fff' }).png().toBuffer(),
          left, top: y + 22,
        });
      } catch { /* a missing thumbnail must not sink the summary */ }
    }
    const tx = PAD + 4 * (THUMB + 8) + 24;
    const chipY = y + 44;
    const chips = [
      ['as rendered', chip(f.current)],
      [`target (${f.target?.source || 'avatar'})`, chip(f.target)],
      ['result', chip(f.applied ? f.target : f.current)],
    ];
    let chipSvg = '';
    chips.forEach(([label, col], k) => {
      const cx = tx + k * (CHIP + 76);
      chipSvg += `<rect x="${cx}" y="${chipY}" width="${CHIP}" height="${CHIP}" fill="${col}" stroke="#999" stroke-width="1"/>
        <text x="${cx}" y="${chipY + CHIP + 13}" font-family="sans-serif" font-size="10" fill="#555">${esc(label)}</text>`;
    });
    const verdict = f.applied ? `SHIFTED  ΔE ${f.delta?.deltaE ?? '–'}` : 'unchanged';
    const fill = f.applied ? '#0a7d32' : '#777';
    const nx = tx + 3 * (CHIP + 76) + 12;
    svg += `<line x1="0" y1="${y + 4}" x2="${W}" y2="${y + 4}" stroke="#e5e5e5" stroke-width="1"/>
      <text x="${tx}" y="${y + 28}" font-family="sans-serif" font-size="16" font-weight="700" fill="#111">${esc(f.name)}</text>
      <text x="${tx + 140}" y="${y + 28}" font-family="sans-serif" font-size="14" font-weight="700" fill="${fill}">${esc(verdict)}</text>
      ${chipSvg}
      <text x="${nx}" y="${chipY + 14}" font-family="sans-serif" font-size="13" fill="#333">hue ${f.current?.hueDeg ?? '–'}° → ${f.target?.hueDeg ?? '–'}°   ·   L ${f.current?.L ?? '–'} → ${f.target?.L != null && f.lighting != null ? (f.target.L * f.lighting).toFixed(0) : '–'}</text>
      <text x="${nx}" y="${chipY + 32}" font-family="sans-serif" font-size="12" fill="#666">DINO ${f.dinoScore ?? '–'}${f.dinoScore != null && f.dinoScore < 0.6 ? ' (low)' : ''}   ·   ${f.current?.px ?? 0} px   ·   dilated +${f.maskDilated || 0}   ·   gated −${f.colourGated || 0}</text>
      <text x="${nx}" y="${chipY + 50}" font-family="sans-serif" font-size="12" fill="#666">lighting ×${f.lighting ?? '–'} (${esc(f.lightingSource || '–')})</text>
      <text x="${nx}" y="${chipY + 68}" font-family="sans-serif" font-size="12" fill="${f.target?.source?.startsWith('sam:') ? '#666' : '#a15c00'}">target from ${esc(f.target?.source || '–')}${f.target?.maskPx != null ? ` · ${f.target.maskPx} px` : ''}${f.target?.dinoScore != null ? ` · DINO ${f.target.dinoScore}` : ''}${f.target?.agreement ? ` · ${f.target.agreement === 'agreed' ? `${f.target.panelsAgreed}/${f.target.panelsMeasured} panels agree (max pair ΔE ${f.target.maxPairDeltaE})` : f.target.agreement === 'single' ? '1 panel only — unverified' : f.target.agreement}` : ''}${f.target?.source && !f.target.source.startsWith('sam:') ? '  ← fallback, low-chroma blind spot' : ''}</text>
      <text x="${tx}" y="${y + ROW_H - 14}" font-family="sans-serif" font-size="12" fill="#555">${esc(f.reason || '')}</text>`;
  }
  svg += '</svg>';
  return 'data:image/jpeg;base64,' + (await sharp(Buffer.from(svg)).composite(composites).jpeg({ quality: 92 }).toBuffer()).toString('base64');
}

/**
 * Mechanical garment-colour repair — the consumer of the entity check's
 * `garmentColourMismatches` channel. DINO garment box → SAM mask → full
 * L*a*b* match toward the styled avatar's colour, scaled by a skin-probed
 * lighting factor. See server/lib/garmentColourFix.js.
 *
 * params.characterName — repair only that character (default: every figure with
 *   a resolvable avatar, so a run shows what WOULD be touched page-wide).
 */
async function runGarmentColourFixStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { fixFigureGarmentColour } = require('./garmentColourFix');
  const { detectAllBoundingBoxes } = require('./images');
  const { getStyledAvatarForClothing, normalizeClothingCategory } = require('./entityConsistency');

  // params.versionIndex replays against an EXACT version — needed to reproduce
  // what a production repair did, because the active version is often that
  // repair's own output.
  let imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, params.versionIndex);
  const t0 = Date.now();
  // Reuse the STORED detection. Production Step 1b resolves the same box from
  // the evaluation it just produced for those bytes, falling back to the image
  // and then to the stored scene (repairPipeline.js → detectionForPage). Note
  // what that means for this stage: it feeds off stored data, which is ALWAYS
  // populated, so it kept working through the whole period Step 1b was skipping
  // 100% of its fixes for want of a box. A green run here is not evidence the
  // production path is wired — only a real generation is.
  // Re-detecting here tests a different input: a fresh pass
  // can fail to attribute figures and return UNKNOWN, which then skips every
  // figure and makes the Lab disagree with the pipeline for reasons that have
  // nothing to do with the colour repair. Fall back to a fresh detect only when
  // the story carries none. params.freshDetection forces one.
  let detection = params.freshDetection ? null : (ctx.scene.bboxDetection || null);
  let detectionSource = detection?.figures?.length ? 'stored' : null;
  if (!detection?.figures?.length) {
    detection = await detectAllBoundingBoxes(imageData, {
      expectedCharacters: buildExpectedCharacters(ctx),
      sceneContext: (ctx.scene.sceneDescription || '').slice(0, 2000),
      artStyle: ctx.artStyle,
      skipCache: true,
      pageContext: `testlab-exp${experimentId}-P${ctx.pageNumber}`,
    });
    detectionSource = 'fresh';
  }
  if (!detection?.figures?.length) throw new Error('No figures detected on this page');

  const chars = ctx.characters || [];
  const pageClothing = ctx.scene.sceneCharacterClothing || ctx.scene.sceneMetadata?.characterClothing || {};
  const only = params.characterName ? String(params.characterName).toLowerCase() : null;

  const steps = [];
  const perFigure = [];
  const stepsByFigure = {};
  let anyChange = false;
  for (const fig of detection.figures) {
    const name = fig?.name;
    if (!name || name === 'UNKNOWN') { perFigure.push({ name: name || 'UNKNOWN', applied: false, reason: 'unnamed figure' }); continue; }
    if (only && name.toLowerCase() !== only) continue;
    const character = chars.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
    if (!character) { perFigure.push({ name, applied: false, reason: 'character not in story' }); continue; }
    // NO DEFAULT CLOTHING (owner, 2026-08-07): the avatar is the colour target.
    if (!pageClothing[character.name]) { perFigure.push({ name, applied: false, reason: 'no per-page clothing category (refusing to default to standard)' }); continue; }
    const cat = normalizeClothingCategory(pageClothing[character.name]);
    // EXACT category — same rule as production Step 1b: the avatar's pixels are
    // the colour target, so never accept another outfit's sheet as a stand-in.
    const avatarUri = await getStyledAvatarForClothing(character, ctx.artStyle, cat, { exactCategory: true });
    if (!avatarUri) { perFigure.push({ name, applied: false, reason: `no styled avatar for category ${cat}` }); continue; }

    // params.garment lets the Lab exercise the garment ROUTING (top vs footwear
    // vs headwear...) the way production does from the entity channel's word.
    const res = await fixFigureGarmentColour(imageData, fig, avatarUri, {
      // params.observedColour exercises the colour points + verification gate
      // the way production does from the entity channel's own field.
      opts: params.opts || {}, garment: params.garment, collectSteps: true,
      observedColour: params.observedColour,
    });
    perFigure.push(res.report);
    const slot = {};
    for (const st of res.steps) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, st.data, experimentId);
      steps.push({ label: st.label, imageType: 'tl_step', versionIndex: v });
      if (/BEFORE/.test(st.label)) slot.before = st.data;
      else if (/MASK/.test(st.label)) slot.mask = st.data;
      else if (/AFTER/.test(st.label)) slot.after = st.data;
    }
    // THE STYLE REFERENCE IS EVIDENCE, NOT PLUMBING (owner, 2026-08-09). The
    // avatar sheet decides the whole result — the fix reads its colour and
    // paints the page toward it — so a run that hides it cannot be judged. On
    // job_1786277779744 Hans's sheet had a leaked anchor family pasted in (a
    // boy, a woman, three old men); the torso band averaged across them to
    // brown and a correct light-blue shirt was repainted brown. The numbers
    // alone looked healthy: every gate passed. Emit the sheet full size AND on
    // the summary row so "is the target believable" is answerable at a glance.
    try {
      const av = await toDataUri(avatarUri);
      if (av) {
        const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, av, experimentId);
        steps.push({ label: `${name} STYLE REFERENCE — the avatar sheet the target colour is measured from`, imageType: 'tl_step', versionIndex: v });
        slot.avatar = av;
      }
    } catch (err) {
      log.warn(`[TESTLAB] ${name}: style reference not attached (${err.message})`);
    }
    stepsByFigure[name] = slot;
    // Chain: each figure repairs on top of the previous one's output, so a
    // multi-character page ends with ONE image carrying every correction.
    if (res.changed) { imageData = res.imageData; anyChange = true; }
  }

  // Summary FIRST in the step list — one image answering "what happened to every
  // character on this page", mask included, without scrolling per-figure crops.
  try {
    const summary = await renderGarmentColourSummary(perFigure, stepsByFigure, ctx.pageNumber);
    if (summary) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, summary, experimentId);
      steps.unshift({ label: `SHIFT SUMMARY — all ${perFigure.length} figure(s) on page ${ctx.pageNumber}`, imageType: 'tl_step', versionIndex: v });
    }
  } catch (err) {
    log.warn(`[TESTLAB] garment-colour summary failed: ${err.message} — per-figure steps still emitted`);
  }

  const correctedVersion = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, imageData, experimentId);
  return {
    elapsedMs: Date.now() - t0,
    changed: anyChange,
    detectionSource,
    correctedVersion,
    perFigure,
    steps: steps.length ? steps : undefined,
  };
}

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

  // NO DEFAULT CLOTHING (owner, 2026-08-07): null category means "unknown", not
  // "standard" — the caller must not dress a character from a guess.
  let costume = { category: null, description: null };
  for (const scene of data.sceneImages || []) {
    const rp = (scene.referencePhotos || []).find(r => (r.name || '').toLowerCase() === characterName.toLowerCase());
    if (rp?.clothingCategory) { costume = { category: rp.clothingCategory, description: rp.clothingDescription || null }; break; }
  }
  if (!costume.category) log.error(`❌ [TESTLAB] ${characterName}: no clothing category found on any page's reference photos.`);
  return { storyId, character, costume };
}

/** Pass 1: realistic anchor sheet (generated once per character, reused). */
async function runAvatarRealisticStage(target, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
  const { character, costume } = await loadCharacterContext(target.storyId, target.character);
  // params.costumeDescription: A/B a modified outfit description (e.g.
  // carried-accessory removal experiments) against the stored wardrobe.
  const costumeDescription = params.costumeDescription || costume.description || 'standard outfit';
  const t0 = Date.now();
  const result = await generateCharacter2x4Sheet(character, {
    clothingCategory: costume.category,
    costumeDescription,
    artStyle: 'realistic',
  });
  if (!result?.imageData) throw new Error('no realistic sheet returned');
  const versionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, result.imageData, experimentId,
    result.finalScore != null ? Math.round(result.finalScore) : null);
  return {
    character: character.name, imageType: 'tl_avatar', versionIndex,
    pass: 1, artStyle: 'realistic', clothingCategory: costume.category,
    costumeDescription: costumeDescription.slice(0, 300),
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
    // Compliance issues — production consolidation always receives these;
    // omitting them made lab consolidate runs materially weaker than the
    // real pipeline (spec-conflict check fired in production-shaped local
    // runs but not in the lab).
    threeStageResult: scene.threeStageResult || newestWith('threeStageResult') || null,
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
  // compositeCovers: default false (direct render). Pass params.composite=true
  // to test the cutout+plate composite path (3+ figures / realistic styles —
  // see docs/image-routing.md direct-vs-composite rule).
  // params.backgroundStoryId + params.backgroundPage: BORROW an empty_scene
  // plate from any story as the composite background, so the composite path can
  // run on a landmark-less story (else it silently falls back to direct).
  // params.artStyle: override the story's art style for the render (e.g. 'oil').
  let landmarkBufOverride = null;
  if (params.composite === true && params.backgroundStoryId && params.backgroundPage != null) {
    const bgRows = await dbQuery(
      "SELECT image_url, image_data FROM story_images WHERE story_id=$1 AND image_type='empty_scene' AND page_number=$2 ORDER BY version_index DESC LIMIT 1",
      [params.backgroundStoryId, params.backgroundPage]);
    const bg = bgRows[0];
    if (!bg) throw new Error(`no empty_scene plate for story ${params.backgroundStoryId} p${params.backgroundPage}`);
    landmarkBufOverride = bg.image_url
      ? Buffer.from(await (await fetch(bg.image_url)).arrayBuffer())
      : Buffer.from(bg.image_data, 'base64');
  }
  if (params.artStyle) storyData.artStyle = params.artStyle;
  const result = await iterateCover(coverKey, storyData, {
    // params.imageModel: A/B the cover render model (e.g. grok-imagine vs
    // gemini-2.5-flash-image) — style-adherence routing tests. Defaults to prod.
    imageModel: params.imageModel || MODEL_DEFAULTS.coverImage,
    freshCharacters,
    compositeCovers: params.composite === true,
    landmarkBufOverride,
    // Figure orientation lever for the composite path (2026-07-19):
    // 'frontal' | 'turned-source' | 'turned-prompt' | 'both'. See
    // docs/image-routing.md. Only affects params.composite=true runs.
    orient: params.orient || 'frontal',
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

// ---------------------------------------------------------------------------
// Cover title PAINT-IN (glyph-conditioned text integration) — 2026-08-05
//
// WHY this shape: no image model spells reliably. The 2026 SOTA sits at ~90-95%
// on short copy (Ideogram 4, GPT Image 2, Qwen-Image) and degrades further on
// the umlauts/accents every German and French title carries — so "let the model
// write the title" ships a garbled cover roughly 1 in 10 books, and a VLM judge
// does not reliably catch a single transposed letter. The research direction
// that DID solve this (GlyphControl, AnyText, TextDiffuser, Glyph-ByT5: <20% →
// ~90%) never asks the model to spell: it pre-renders the correct glyphs and
// lets diffusion only STYLE them.
//
// This stage is that principle on our own stack:
//   1. composeCover renders the title from a real font file  → spelling correct
//      by construction (this is the existing app-side typography, unchanged).
//   2. Diff composed-vs-textless art → exact GLYPH MASK (no new detection).
//   3. Crop the title region and hand it to Qwen-Image-Edit ($0.008), whose
//      single strongest documented capability is editing text ALREADY PRESENT
//      in an image while preserving font/size/layout. It paints medium,
//      texture, edge bleed and contact shadow into letters it does not have to
//      invent.
//   4. Paste back gated by the dilated glyph mask, so the artwork outside the
//      letters stays pixel-identical (the crop-bounded-insertion rule from the
//      Qwen composite experiments — full-frame edits re-imagine the scene).
//   5. OCR GATE: transcribe the painted title and compare EXACTLY against the
//      story title (diacritic-sensitive). Deterministic pass/fail — not a
//      quality judge. Production port fails back to the flat composite, so a
//      garbled title is structurally unable to ship.
//
// CROP WIDTH is a resolution-vs-context lever, NOT a safety one (2026-08-05,
// owner question). The tight crop came from the Qwen composite recipe where a
// full-frame edit re-imagined the scene — but here the mask-gated paste-back
// already discards everything outside the glyph mask, so a wider crop cannot
// damage the artwork. What it changes is (a) how many pixels each letter gets
// in the 2× render and (b) HOW MUCH PALETTE THE MODEL CAN SEE. A crop that
// shows only the sky behind the title gives the model no idea that the accent
// colour of the cover lives in a character's coat 60% further down, so it
// cannot pick a title colour that echoes the artwork. Levers:
//   params.marginPct  — crop padding around the glyph bbox (default 0.12)
//   params.contextRef — also send the FULL cover as a second reference so the
//                       model sees the whole palette while editing only the
//                       crop (default true; costs nothing, no repaint risk)
//   params.recolor    — allow the model to CHOOSE the lettering colour from
//                       the artwork's palette instead of preserving the
//                       deterministic one (default false)
//
// Target: {storyId}. params: { coverType (frontCover), title, marginPct,
// dilatePct, contextRef, recolor, style }. promptOverride replaces the prompt.
// ---------------------------------------------------------------------------
const TITLE_PAINTIN_BASE = `The first image is a children's book cover whose title lettering has been placed on top of the artwork as a flat graphic. Repaint the lettering so it belongs to the illustration: the letters take on the medium, brush texture, edge quality and lighting of the artwork, pigment sitting in the paper, a soft contact shadow under each letter and slight natural edge bleed.
Keep the spelling, the letters, the word order, the line breaks, the letterforms, the size and the exact position identical. Do not add, remove or redraw any letter. Leave the artwork behind and around the lettering unchanged.`;
// Colour clauses — the ONLY difference between the two modes.
const TITLE_PAINTIN_KEEP_COLOUR = `\nKeep the lettering colour exactly as it is.`;
const TITLE_PAINTIN_RECOLOUR = `\nYou may change the lettering colour: pick a colour that already appears in the artwork as an accent (a garment, an object, a highlight) so the title reads as part of the illustration. It must stay clearly legible against what is directly behind it — if no accent gives enough separation, keep the current colour.`;
// Appended when the full cover rides along as a second reference.
const TITLE_PAINTIN_CONTEXT = `\nThe second image is the complete cover for context — use it to judge the artwork's palette and lighting. Edit only the first image.`;

/** Transcribe visible text in an image. Deterministic OCR gate input — the
 *  model is asked to copy characters, never to judge quality. */
async function transcribeTextInImage(imageDataUri) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const { MODEL_DEFAULTS } = require('../config/models');
  const r2 = require('./r2');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: imageDataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2.stripDataUriPrefix(imageDataUri) } },
          { text: 'Transcribe the large title lettering in this image character by character. Copy exactly what is drawn, including accents and umlauts, even if a letter looks malformed or misspelled — do not correct it. Return JSON: {"text": "<transcription>"}' },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  if (!response.ok) throw new Error(`OCR call failed: ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  const parsed = require('./storyHelpers').extractJsonFromText(raw);
  if (!parsed || typeof parsed.text !== 'string') throw new Error(`Invalid OCR response: ${raw.slice(0, 120)}`);
  return parsed.text;
}

// Case-insensitive (several title fonts render uppercase-only) but
// DIACRITIC-sensitive — "Marchen" must fail against "Märchen".
function normalizeTitleForGate(s) {
  return String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function runCoverTitlePaintinStage(target, { experimentId, promptOverride, params = {} }) {
  const sharp = require('sharp');
  const r2 = require('./r2');
  const { composeCover } = require('./coverTypography');
  const { editWithQwen } = require('./runware');

  const coverKey = params.coverType || target.coverType || 'frontCover';
  if (coverKey !== 'frontCover') {
    throw new Error(`cover_title_paintin runs on the frontCover title lockup (got "${coverKey}")`);
  }
  const { storyData } = await loadStoryDataFull(target.storyId);
  const cover = storyData.coverImages?.[coverKey];
  if (!cover) throw new Error(`Story has no ${coverKey} — pick a story generated with covers`);
  const title = String(params.title || storyData.title || '').trim();
  if (!title) throw new Error('Story has no title to paint in');

  // The TEXTLESS plate lives in story_images as `${coverKey}Art` — the
  // "top-level ${key}Art row" the cover-typography contract describes. It is NOT
  // a field on the cover object: `cover.artImageData` is undefined on real
  // stories, so reading that and falling back to `cover.imageData` fed the
  // SERVED, ALREADY-TITLED cover into the pipeline (exp #311 — every crop went
  // to Qwen with the title baked in twice, and "Das Seil fliegt…" came back
  // showing two titles). Read the Art row; fail loudly if there is none.
  const artRow = await loadTestImage(target.storyId, `${coverKey}Art`, null, 0);
  const artSrc = artRow?.imageData || cover.artImageData;
  if (!artSrc) {
    throw new Error(`No textless cover plate (story_images ${coverKey}Art) — this story predates `
      + 'app-side typography, so compositing a title would double-stamp it.');
  }
  const artBytes = await r2.bytesFromAnyImage(artSrc);
  if (!artBytes) throw new Error('Could not resolve cover art bytes');

  const steps = [];
  const addStep = async (label, dataUri) => {
    const v = await saveTestVersion(target.storyId, 'tl_step', null, dataUri, experimentId);
    steps.push({ label, imageType: 'tl_step', versionIndex: v });
  };

  // --- 1. deterministic lockup (unchanged production typography) -------------
  const figures = cover.bboxDetection?.figures || [];
  const { buffer: composedBuf, spec } = await composeCover({
    artBuffer: artBytes, kind: 'front', title, seed: storyData.title, figures,
    style: params.style || cover.typographyStyle || undefined,
  });
  if (spec?.skipped) throw new Error(`Typography skipped (${spec.skipped}) — nothing to paint in`);
  await addStep('baseline: deterministic lockup (composeCover)', `data:image/jpeg;base64,${composedBuf.toString('base64')}`);

  // --- 2. glyph mask = composed − art ---------------------------------------
  const meta = await sharp(composedBuf).metadata();
  const W = meta.width, H = meta.height;
  const rawArt = await sharp(artBytes).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const rawComposed = await sharp(composedBuf).removeAlpha().raw().toBuffer();
  const inkMask = Buffer.alloc(W * H);
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (let p = 0, i = 0; p < W * H; p++, i += 3) {
    const d = Math.max(
      Math.abs(rawComposed[i] - rawArt[i]),
      Math.abs(rawComposed[i + 1] - rawArt[i + 1]),
      Math.abs(rawComposed[i + 2] - rawArt[i + 2]));
    if (d > 12) {
      inkMask[p] = 255;
      const x = p % W, y = (p / W) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) throw new Error('No typography ink found in the composed cover');

  // Dilate so the painted letters may grow an outline / bleed / shadow beyond
  // the flat glyph edge, then soften the mask border so the paste-back has no
  // hard cut. The dilation is what lets the model add the effects we want.
  const dilatePx = Math.max(4, Math.round(Math.min(W, H) * (params.dilatePct ?? 0.012)));
  // toColourspace('b-w') + a hard length assertion are LOAD-BEARING. sharp emits
  // sRGB (3-channel) by default even from a 1-channel raw input, and the mask was
  // then indexed as 1 channel: joinChannel took the first W*H bytes as alpha, so
  // the alpha was the mask SQUEEZED 3x horizontally and wrapped across rows —
  // a comb/scanline pattern that let model pixels through in stripes far outside
  // the letters (the "lines" and "smaller version" artifacts in exps #311/#316).
  const grownMaskRaw = await sharp(inkMask, { raw: { width: W, height: H, channels: 1 } })
    .blur(dilatePx).threshold(28).blur(Math.max(1.5, dilatePx / 6))
    .toColourspace('b-w').raw().toBuffer();
  if (grownMaskRaw.length !== W * H) {
    throw new Error(`glyph mask is not single-channel: ${grownMaskRaw.length} bytes for ${W}x${H}`);
  }
  const grownMaskPng = await sharp(grownMaskRaw, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  await addStep(`glyph mask (dilated ${dilatePx}px — paint-in is clipped to this)`, `data:image/png;base64,${grownMaskPng.toString('base64')}`);

  // --- 3. crop-bounded edit --------------------------------------------------
  // Default BACK to 0.05 after exp #311: at 0.12 the crop reached 31-53% of the
  // cover and swallowed the characters, and Qwen then RE-COMPOSED the crop —
  // shrunken duplicate figures got stamped into the letter band (the girl inside
  // the word "tock"; a second crossbow man above the real one). Context has to
  // come from the context REFERENCE, not from a fatter edit crop.
  const padPx = Math.round(Math.max(W, H) * (params.marginPct ?? 0.05));
  const crop = {
    left: Math.max(0, minx - padPx),
    top: Math.max(0, miny - padPx),
  };
  crop.width = Math.min(W, maxx + 1 + padPx) - crop.left;
  crop.height = Math.min(H, maxy + 1 + padPx) - crop.top;

  // MODE (owner directive 2026-08-05: "we have the scene without text, why not
  // send the full scene, very simple, and then find the text").
  //   'full' (DEFAULT) — send the WHOLE composed cover; the model returns the
  //     whole cover at the same aspect, so nothing is offset or sub-sampled. The
  //     crop round-trip was the source of EVERY geometry bug this stage had.
  //   'crop' — the old crop-bounded path, kept only for comparison.
  const mode = params.mode === 'crop' ? 'crop' : (params.mode === 'plate' ? 'plate' : 'full');

  // ── PLATE MODE ────────────────────────────────────────────────────────────
  // Don't create the detection problem. Instead of restyling the title ON the
  // cover and then trying to separate letters from re-rendered artwork, send TWO
  // inputs: (1) the cover as a STYLE reference, (2) the title alone on a keyable
  // background. The model redraws only the lettering, on that background, so
  // extraction is a chroma key — every letter pixel, no leaves, no counters
  // filled, and the artwork is never re-rendered at all.
  if (mode === 'plate') {
    // Runs the PRODUCTION module — what the Lab shows here is exactly what ships
    // (server/lib/coverTitlePaint.js). Lab-only copies of a production recipe are
    // how #302/#304/#315 ended up comparing the wrong thing.
    const { paintCoverTitle } = require('./coverTitlePaint');
    const t0p = Date.now();
    const r = await paintCoverTitle(artBytes, title, {
      figures, seed: storyData?.title, artStyle: storyData?.artStyle,
      style: params.style || cover.typographyStyle || undefined,
      backend: params.backend, model: params.model, debug: true,
      // A/B levers — both default to the production setting:
      //   sceneRef        : send the artwork as a style reference (default ON —
      //                     it carries the cover's colour and style)
      //   strictEmptyPage : the "page stays pure white and empty" wording
      sceneRef: params.sceneRef,
      strictEmptyPage: params.strictEmptyPage,
    });
    const elapsedP = Date.now() - t0p;
    if (r.debug?.plate) await addStep('INPUT 2 (edited): title strip on WHITE, preset-padded', r.debug.plate);
    if (r.debug?.raw) await addStep('raw model output (lettering plate)', r.debug.raw);
    const viP = await saveTestVersion(target.storyId, coverKey, null, r.imageData, experimentId);
    return {
      imageType: coverKey, coverType: coverKey, versionIndex: viP, steps,
      modelId: params.model || params.backend || 'grok-imagine', elapsedMs: elapsedP, cost: r.cost ?? null,
      alignGate: {
        offMaskMeanDiff: r.spill ?? 0, threshold: 0, pass: !!r.ok,
        coverage: r.coverage, spread: r.spill,
        verdict: r.ok
          ? `PASS — painted title kept (coverage ${(r.coverage ?? 0).toFixed(2)}, spill ${(r.spill ?? 0).toFixed(2)})`
          : `FAIL — ${r.reason} (coverage ${(r.coverage ?? 0).toFixed(2)}, spill ${(r.spill ?? 0).toFixed(2)}) — flat title served`,
      },
      typography: { fontId: r.spec?.fontId, layout: r.spec?.layout, face: r.spec?.face, lines: r.spec?.lines },
      paintinSetup: { mode: 'plate', backend: params.backend || 'grok',
        refsSent: params.sceneRef === false ? 1 : 2,
        sceneRef: params.sceneRef !== false,
        strictEmptyPage: params.strictEmptyPage !== false,
        deterministicColour: r.spec?.face || null },
      issuesSummary: r.ok ? null : r.reason,
    };
  }
  const cropPctW = Math.round(crop.width / W * 100), cropPctH = Math.round(crop.height / H * 100);
  const cropBuf = mode === 'crop'
    ? await sharp(composedBuf).extract(crop).jpeg({ quality: 95 }).toBuffer()
    : composedBuf;
  await addStep(mode === 'full'
    ? `INPUT (edited): the FULL composed cover ${W}×${H}px — no crop`
    : `INPUT 1 (edited): title crop ${crop.width}×${crop.height}px = ${cropPctW}%×${cropPctH}% of the cover`,
    `data:image/jpeg;base64,${cropBuf.toString('base64')}`);

  // INPUT 2 (context only): the whole cover. The model needs the full palette
  // to choose/echo a colour — a crop that only shows sky cannot know the accent
  // colour lives in a coat further down. It edits input 1; input 2 is reference.
  // DEFAULT OFF after exp #311. A second reference does NOT act as "context" for
  // Qwen — it composes from both, and here it took the FULL COVER as its base:
  // every output carried whole-cover content (crossbow man, houses, the girl's
  // shoes) that was not in the crop at all, at the crop's aspect. Pasted back
  // through the glyph mask that reads as scaled, misaligned scene fragments
  // inside the letters. Palette context must be given as TEXT, not as an image.
  const useContextRef = params.contextRef === true;
  const contextBuf = useContextRef
    ? await sharp(composedBuf).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer()
    : null;
  if (contextBuf) {
    await addStep('INPUT 2 (context only, not edited): full cover for palette + lighting',
      `data:image/jpeg;base64,${contextBuf.toString('base64')}`);
  }

  const styleLine = (() => {
    try {
      const { ART_STYLES } = require('./storyHelpers');
      const raw = ART_STYLES[storyData.artStyle];
      const txt = typeof raw === 'string' ? raw : (raw && raw.default) || '';
      return txt ? `\nThe artwork's style: ${txt}` : '';
    } catch { return ''; }
  })();
  const recolor = params.recolor === true;
  const prompt = promptOverride
    || (TITLE_PAINTIN_BASE
      + (recolor ? TITLE_PAINTIN_RECOLOUR : TITLE_PAINTIN_KEEP_COLOUR)
      + (useContextRef ? TITLE_PAINTIN_CONTEXT : '')
      + styleLine);

  const refs = [`data:image/jpeg;base64,${cropBuf.toString('base64')}`];
  if (contextBuf) refs.push(`data:image/jpeg;base64,${contextBuf.toString('base64')}`);

  // BACKEND is a lever, not an assumption (owner, 2026-08-05: the
  // "Gemini for style / Qwen for small edits" rule came from avatars and repair,
  // NOT from text — do not carry it over, measure it here instead).
  //   params.backend: 'qwen' (Runware, default) | 'grok' | 'gemini'
  //   params.model  : exact model id — a Runware id for qwen (lets other
  //                   Runware edit models be tried with no code change), or an
  //                   IMAGE_MODELS key for grok/gemini.
  const backend = params.backend || 'qwen';
  const snap = v => Math.max(512, Math.min(2048, Math.round(v / 64) * 64));
  const editW = mode === 'full' ? W : crop.width;
  const editH = mode === 'full' ? H : crop.height;
  const t0 = Date.now();
  let result;
  if (backend === 'qwen') {
    result = await editWithQwen(prompt, refs, {
      width: snap(editW), height: snap(editH),
      ...(params.model ? { model: params.model } : {}),
    });
  } else {
    // Shared dispatcher: routes by IMAGE_MODELS[...].backend and snaps the
    // output aspect to the nearest preset both Grok and Gemini accept.
    const { editImageWithPrompt } = require('./images');
    const modelKey = params.model || (backend === 'grok' ? 'grok-imagine' : 'gemini-2.5-flash-image');
    result = await editImageWithPrompt(refs[0], prompt, modelKey, refs.slice(1), storyData.artStyle);
    if (!result?.imageData) throw new Error(`${backend} (${modelKey}) returned no image`);
  }
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error(`${backend} returned no image`);
  await addStep(`raw ${backend} output (before mask gating)`, result.imageData);

  // --- 4. FIND the new letters in the output, paste them on the EMPTY scene ---
  // Owner directive: the model may shift the letters slightly AND may degrade
  // faces, so do not trust the mask we drew and do not keep the model's version
  // of the artwork. Instead:
  //   found = (output differs from the TEXTLESS plate)  ∩  (near where we drew)
  // The first term finds the painted lettering wherever it actually landed —
  // including strokes that grew outside the original glyph. The second term is a
  // generous neighbourhood of the drawn mask (searchPct, default 3% of the short
  // side), which discards everything the model changed elsewhere: degraded
  // faces, tone shifts, re-rendered background. The result is composited onto
  // the ORIGINAL textless art, so the only model pixels that survive are letters.
  const outW = mode === 'full' ? W : crop.width;
  const outH = mode === 'full' ? H : crop.height;
  const paintedRaw = await sharp(Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    .resize(outW, outH, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const drawnMaskRaw = mode === 'full'
    ? grownMaskRaw
    : await sharp(grownMaskRaw, { raw: { width: W, height: H, channels: 1 } })
      .extract(crop).toColourspace('b-w').raw().toBuffer();
  if (drawnMaskRaw.length !== outW * outH) {
    throw new Error(`mask is not single-channel: ${drawnMaskRaw.length} bytes for ${outW}x${outH}`);
  }
  // Search zone: the drawn glyphs blurred wide, so a letter that moved or grew
  // is still inside it, but a face 500px away is not.
  const searchPx = Math.max(8, Math.round(Math.min(outW, outH) * (params.searchPct ?? 0.03)));
  const searchZone = await sharp(drawnMaskRaw, { raw: { width: outW, height: outH, channels: 1 } })
    .blur(searchPx).threshold(6).toColourspace('b-w').raw().toBuffer();

  const artOutRaw = await sharp(artBytes).resize(outW, outH, { fit: 'fill' }).removeAlpha().raw().toBuffer();

  // ── SAM DETECTION (params.detect='sam', default) ──────────────────────────
  // The title is opaque display type sitting ON the artwork, so a region mask
  // is all we need — box-prompted MobileSAM per text LINE, on the model's own
  // output, so the mask follows the letters where they actually are (drift and
  // painted overshoot included) instead of where we drew them.
  // Boxes and positive points come from the drawn glyphs: we know which rows
  // carry a line and which pixels are certainly inside a stroke.
  const detect = params.detect || 'pigment';
  let samMaskRaw = null;
  if (detect === 'sam') {
    const { fetchFigureMaskPng } = require('./imageCompositing');
    // group ink rows into lines
    const rowHas = new Array(outH).fill(false);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) if (drawnMaskRaw[y * outW + x] > 8) { rowHas[y] = true; break; }
    }
    const lines = [];
    for (let y = 0; y < outH; y++) {
      if (!rowHas[y]) continue;
      const y0 = y; while (y + 1 < outH && rowHas[y + 1]) y++;
      lines.push([y0, y]);
    }
    samMaskRaw = Buffer.alloc(outW * outH);
    const outJpeg = await sharp(paintedRaw, { raw: { width: outW, height: outH, channels: 3 } })
      .jpeg({ quality: 95 }).toBuffer();
    for (const [ly0, ly1] of lines) {
      let lx0 = outW, lx1 = 0;
      const pts = [];
      for (let y = ly0; y <= ly1; y++) {
        for (let x = 0; x < outW; x++) {
          if (drawnMaskRaw[y * outW + x] > 8) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; }
        }
      }
      if (lx1 <= lx0) continue;
      // positive points: a few certainly-inside-a-stroke pixels across the line
      for (let k = 1; k <= 5; k++) {
        const tx = Math.round(lx0 + (lx1 - lx0) * k / 6);
        let best = -1;
        for (let y = ly0; y <= ly1; y++) if (drawnMaskRaw[y * outW + tx] > 200) { best = y; break; }
        if (best >= 0) pts.push([tx, best + Math.round((ly1 - ly0) * 0.15)]);
      }
      const pad = Math.round((ly1 - ly0) * 0.35);
      const cx0 = Math.max(0, lx0 - pad), cy0 = Math.max(0, ly0 - pad);
      const cw = Math.min(outW, lx1 + pad) - cx0, ch = Math.min(outH, ly1 + pad) - cy0;
      const lineCrop = await sharp(outJpeg).extract({ left: cx0, top: cy0, width: cw, height: ch })
        .jpeg({ quality: 95 }).toBuffer();
      const boxInCrop = [lx0 - cx0, ly0 - cy0, lx1 - cx0, ly1 - cy0];
      const png = await fetchFigureMaskPng(lineCrop, boxInCrop, {
        points: pts.map(([px, py]) => [px - cx0, py - cy0]),
        requireMobilesam: true,
      });
      if (!png) continue;
      const m = await sharp(png).resize(cw, ch, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (m[y * cw + x] > 128) samMaskRaw[(cy0 + y) * outW + (cx0 + x)] = 255;
        }
      }
    }
    await addStep(`SAM letter mask (${lines.length} text line(s), box+points prompted on the model output)`,
      `data:image/png;base64,${(await sharp(samMaskRaw, { raw: { width: outW, height: outH, channels: 1 } }).png().toBuffer()).toString('base64')}`);
  }

  // ── PAINT-LAYER EXTRACTION ────────────────────────────────────────────────
  // Copying pixels is wrong in principle: every pixel at a stroke edge is a MIX
  // of pigment and background, and the model's background has the trees shifted
  // a few px from ours. Copy it and each soft edge, pooled bleed and shadow
  // carries misaligned trees — ghosting no mask can fix, because the
  // contaminated pixels ARE the ones that make the letters look painted.
  //
  // So extract the layer instead of a region:  O = α·F + (1−α)·B
  //   B = OUR empty scene (known exactly — it is the plate)
  //   F = the pigment colour, sampled from each stroke's OPAQUE interior
  //       (never from an edge, so no background contamination gets into it)
  //   α = projection of (O−B) onto (F−B): how far the pixel travelled from our
  //       background toward the pigment.
  // The rejection that kills the shifted trees is the PERPENDICULAR RESIDUAL: a
  // paint/background mix lies ON the B→F line, a repainted tree is a colour
  // change in some other direction entirely. Large residual ⇒ not paint ⇒ α=0.
  // Recompositing α·F over OUR B means every partial pixel blends with OUR
  // trees, so misalignment is impossible by construction.

  // F per pixel: the local pigment colour, from the stroke interior only.
  // Erode the drawn mask hard so edge pixels can't pollute the sample, then
  // normalized-convolution (blur the masked colour, blur the mask, divide) to
  // spread that colour smoothly outward — this keeps per-letter colour variation
  // instead of collapsing the title to one flat hue.
  const interior = await sharp(drawnMaskRaw, { raw: { width: outW, height: outH, channels: 1 } })
    .blur(3).threshold(230).toColourspace('b-w').raw().toBuffer();
  const maskedPaint = Buffer.alloc(outW * outH * 3);
  for (let p = 0, i = 0; p < outW * outH; p++, i += 3) {
    if (interior[p] > 128) {
      maskedPaint[i] = paintedRaw[i]; maskedPaint[i + 1] = paintedRaw[i + 1]; maskedPaint[i + 2] = paintedRaw[i + 2];
    }
  }
  const SPREAD_R = Math.max(6, Math.round(Math.min(outW, outH) * 0.02));
  const blurPaint = await sharp(maskedPaint, { raw: { width: outW, height: outH, channels: 3 } })
    .blur(SPREAD_R).raw().toBuffer();
  const blurCov = await sharp(interior, { raw: { width: outW, height: outH, channels: 1 } })
    .blur(SPREAD_R).raw().toBuffer();

  const alphaBuf = Buffer.alloc(outW * outH);
  const fgBuf = Buffer.alloc(outW * outH * 3);
  const RESID_MAX = params.residualMax ?? 42;   // colour distance off the B→F line
  const ALPHA_MIN = params.alphaMin ?? 0.12;
  let foundN = 0, drawnN = 0, overlapN = 0;
  for (let p = 0, i = 0; p < outW * outH; p++, i += 3) {
    if (drawnMaskRaw[p] > 8) drawnN++;
    if (searchZone[p] <= 8) continue;
    const cov = blurCov[p];
    if (cov < 4) continue;                       // no pigment sample nearby → cannot solve
    const fr = blurPaint[i] * 255 / cov, fg = blurPaint[i + 1] * 255 / cov, fb = blurPaint[i + 2] * 255 / cov;
    const br = artOutRaw[i], bg = artOutRaw[i + 1], bb = artOutRaw[i + 2];
    const dr = fr - br, dg = fg - bg, db = fb - bb;
    const den = dr * dr + dg * dg + db * db;
    if (den < 120) continue;                     // pigment ≈ background here: unsolvable, leave plate
    const or_ = paintedRaw[i] - br, og = paintedRaw[i + 1] - bg, ob = paintedRaw[i + 2] - bb;
    let a = (or_ * dr + og * dg + ob * db) / den;
    if (a <= ALPHA_MIN) continue;
    if (a > 1) a = 1;
    // perpendicular residual — the tree test
    const rr = or_ - a * dr, rg = og - a * dg, rb = ob - a * db;
    if (Math.sqrt(rr * rr + rg * rg + rb * rb) > RESID_MAX) continue;
    alphaBuf[p] = Math.round(a * 255);
    fgBuf[i] = Math.max(0, Math.min(255, Math.round(fr)));
    fgBuf[i + 1] = Math.max(0, Math.min(255, Math.round(fg)));
    fgBuf[i + 2] = Math.max(0, Math.min(255, Math.round(fb)));
    foundN++;
    if (drawnMaskRaw[p] > 8) overlapN++;
  }
  // Anchor: keep alpha only where it is connected to a drawn glyph. Distance
  // rules are arbitrary; this is shape-driven — a stroke that pooled far past
  // the glyph stays (same blob), a stray blob with no glyph in it goes.
  const anchored = Buffer.alloc(outW * outH);
  {
    const stack = [];
    for (let p = 0; p < outW * outH; p++) if (drawnMaskRaw[p] > 8 && alphaBuf[p] > 0) { anchored[p] = 1; stack.push(p); }
    while (stack.length) {
      const p = stack.pop(), x = p % outW, y = (p / outW) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
        const q = ny * outW + nx;
        if (!anchored[q] && alphaBuf[q] > 0) { anchored[q] = 1; stack.push(q); }
      }
    }
  }
  let keptN = 0;
  for (let p = 0; p < outW * outH; p++) {
    if (!anchored[p]) { alphaBuf[p] = 0; } else if (alphaBuf[p] > 0) keptN++;
  }
  foundN = keptN;
  // SAM wins when it produced a mask: it followed the letters in the model's own
  // output. The solved-alpha path stays as the fallback / comparison detector.
  let foundMaskSmooth = alphaBuf;
  // SEED SOURCE. 'pigment' (default) needs no model at all: sample the deep
  // INTERIOR of the old glyphs — eroded well inside every stroke, so a letter
  // that shifted a few px is still covered by its own old footprint. SAM was
  // only ever a seed generator, and it cost an analyzer round-trip per text line
  // and missed whole letters (#340), so it is now opt-in.
  const seedMask = detect === 'sam'
    ? samMaskRaw
    : await sharp(drawnMaskRaw, { raw: { width: outW, height: outH, channels: 1 } })
      .blur(4).threshold(245).toColourspace('b-w').raw().toBuffer();
  if ((detect === 'sam' && samMaskRaw) || detect === 'pigment') {
    // SAM SEEDS THE COLOUR; COLOUR FINDS THE LETTERS (owner, exp #342 → #343).
    // Unioning with the drawn glyphs was a crutch: it reinstates the OLD
    // letterform as a floor, so if the model reshapes a stroke the flat original
    // leaks out around it — and it hides detection failures instead of exposing
    // them. The letters are supposed to be free to change form.
    //
    // So SAM is used only as a SEED: whatever letters it did find give us the
    // pigment. Then every pixel of that pigment in the title area is taken, which
    // recovers the letters SAM missed (LINDENBAUM's tail over the canopy) with no
    // reference to the drawn shape at all.
    //
    // Green-title-on-green-forest is the hazard, so a pixel must satisfy BOTH:
    //   (a) its colour matches the sampled pigment (ΔE in Lab), and
    //   (b) it CHANGED versus the plate.
    // Foliage that stayed foliage fails (b); foliage the model repainted in some
    // other colour fails (a).
    const toLab = (r, g, b) => {
      let R = r / 255, G = g / 255, B = b / 255;
      R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
      G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
      B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
      let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
      let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
      let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
      const f = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
      X = f(X); Y = f(Y); Z = f(Z);
      return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
    };
    // 1. sample pigment inside the SAM seed (bin, keep the dominant clusters —
    //    display type has a face colour plus an outline/shadow colour)
    const bins = new Map();
    for (let p2 = 0, i2 = 0; p2 < outW * outH; p2++, i2 += 3) {
      if (seedMask[p2] <= 128) continue;
      const k = ((paintedRaw[i2] >> 4) << 8) | ((paintedRaw[i2 + 1] >> 4) << 4) | (paintedRaw[i2 + 2] >> 4);
      const e = bins.get(k) || { r: 0, g: 0, b: 0, n: 0 };
      e.r += paintedRaw[i2]; e.g += paintedRaw[i2 + 1]; e.b += paintedRaw[i2 + 2]; e.n++;
      bins.set(k, e);
    }
    // Plate colours at the SAME sample positions — a "pigment" cluster that
    // matches these is background we picked up because the letter moved away.
    const plateBins = new Map();
    for (let p2 = 0, i2 = 0; p2 < outW * outH; p2++, i2 += 3) {
      if (seedMask[p2] <= 128) continue;
      const k = ((artOutRaw[i2] >> 4) << 8) | ((artOutRaw[i2 + 1] >> 4) << 4) | (artOutRaw[i2 + 2] >> 4);
      const e = plateBins.get(k) || { r: 0, g: 0, b: 0, n: 0 };
      e.r += artOutRaw[i2]; e.g += artOutRaw[i2 + 1]; e.b += artOutRaw[i2 + 2]; e.n++;
      plateBins.set(k, e);
    }
    const plateLabs = [...plateBins.values()].filter(e => e.n > 40)
      .map(e => toLab(e.r / e.n, e.g / e.n, e.b / e.n));
    const rawSeeds = [...bins.values()].filter(e => e.n > 40).sort((a, b) => b.n - a.n).slice(0, 8)
      .map(e => toLab(e.r / e.n, e.g / e.n, e.b / e.n));
    let seeds = rawSeeds.filter(l => !plateLabs.some(pl =>
      Math.hypot(l[0] - pl[0], l[1] - pl[1], l[2] - pl[2]) < (params.seedRejectDE ?? 10)));
    let seedSource = 'sampled';
    if (!seeds.length) {
      // Every cluster looked like the plate ⇒ the letters are not where we drew
      // them. Fail over to the colour composeCover DELIBERATELY chose — known
      // exactly, needs no image — rather than selecting background.
      const hex = spec?.face && /^#[0-9a-f]{6}$/i.test(spec.face) ? spec.face : null;
      if (hex) {
        seeds = [toLab(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16))];
        seedSource = 'composeCover spec (sample was all background)';
      }
    }
    // 2. title area: the bbox of the drawn glyphs generously padded — a REGION,
    //    not a shape, so it constrains where we look without dictating form.
    const bandPad = Math.round(Math.min(outW, outH) * (params.bandPct ?? 0.05));
    const bx0 = Math.max(0, minx - bandPad), bx1 = Math.min(outW - 1, maxx + bandPad);
    const by0 = Math.max(0, miny - bandPad), by1 = Math.min(outH - 1, maxy + bandPad);
    const TOL = params.colorTol ?? 26;   // grab generously; filtering + feather clean up              // ΔE to a seed colour
    const CHANGED = params.plateDiff ?? 22;         // must differ from the plate
    const sel = Buffer.alloc(outW * outH);
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const p2 = y * outW + x, i2 = p2 * 3;
        const dPlate = Math.max(Math.abs(paintedRaw[i2] - artOutRaw[i2]),
          Math.abs(paintedRaw[i2 + 1] - artOutRaw[i2 + 1]), Math.abs(paintedRaw[i2 + 2] - artOutRaw[i2 + 2]));
        if (dPlate < CHANGED) continue;             // (b) unchanged ⇒ not letter
        const lab = toLab(paintedRaw[i2], paintedRaw[i2 + 1], paintedRaw[i2 + 2]);
        let best = 1e9;
        for (const s2 of seeds) {
          const d = Math.hypot(lab[0] - s2[0], lab[1] - s2[1], lab[2] - s2[2]);
          if (d < best) best = d;
        }
        if (best <= TOL) sel[p2] = 255;             // (a) pigment match
      }
    }
    // 2b. OPENING — erode then dilate. Thin filaments (leaf wisps, a trunk edge
    //     grazing a letter) are severed, so they become their own components and
    //     die in the size test; letter strokes are far thicker and survive.
    const openPx = params.openPx ?? 2;
    if (openPx > 0) {
      const eroded = await sharp(sel, { raw: { width: outW, height: outH, channels: 1 } })
        .blur(openPx).threshold(200).toColourspace('b-w').raw().toBuffer();
      const reopened = await sharp(eroded, { raw: { width: outW, height: outH, channels: 1 } })
        .blur(openPx).threshold(60).toColourspace('b-w').raw().toBuffer();
      for (let p2 = 0; p2 < outW * outH; p2++) sel[p2] = reopened[p2] > 128 ? 255 : 0;
    }

    // 3. CONNECTED AREAS ONLY (owner): a letter is a big, connected blob sitting
    //    where a letter belongs. Two tests, both structural:
    //      size   — components below minComp are speckle (leaf fragments, grain)
    //      anchor — the component must touch the title's own footprint
    //    The anchor uses the drawn glyphs only as a POSITION reference, never as
    //    shape: the component keeps its full colour-selected form (overshoot and
    //    all), it just has to belong to a letter rather than float in the canopy.
    //    That is what removes the birch trunks and leaf clusters, which match the
    //    pigment but touch no letter.
    const MIN_COMP = params.minComp ?? Math.max(150, Math.round(outW * outH * 0.00012));
    const seen = Buffer.alloc(outW * outH);
    const cleaned = Buffer.alloc(outW * outH);
    for (let p2 = 0; p2 < outW * outH; p2++) {
      if (sel[p2] !== 255 || seen[p2]) continue;
      const stack = [p2]; const comp = []; seen[p2] = 1;
      while (stack.length) {
        const q = stack.pop(); comp.push(q);
        const qx = q % outW, qy = (q / outW) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= outW || ny >= outH) continue;
          const r2 = ny * outW + nx;
          if (!seen[r2] && sel[r2] === 255) { seen[r2] = 1; stack.push(r2); }
        }
      }
      let anchored2 = false;
      for (const q of comp) { if (drawnMaskRaw[q] > 8 || (samMaskRaw && samMaskRaw[q] > 128)) { anchored2 = true; break; } }
      if (comp.length >= MIN_COMP && anchored2) for (const q of comp) cleaned[q] = 255;
    }
    // FEATHER: grab generously, then soften the boundary so the paste has no cut.
    foundMaskSmooth = await sharp(cleaned, { raw: { width: outW, height: outH, channels: 1 } })
      .blur(params.featherPx ?? 1.6).toColourspace('b-w').raw().toBuffer();
    await addStep(`colour-selected letters — ${seeds.length} seed(s) [${seedSource}], ΔE≤${TOL}, open ${openPx}px, no old-shape fallback`,
      `data:image/png;base64,${(await sharp(cleaned, { raw: { width: outW, height: outH, channels: 1 } }).png().toBuffer()).toString('base64')}`);
    foundN = 0; overlapN = 0;
    for (let p2 = 0; p2 < outW * outH; p2++) {
      if (foundMaskSmooth[p2] > 8) { foundN++; if (drawnMaskRaw[p2] > 8) overlapN++; }
    }
  }

  // LETTER GATE — replaces pixel-equality, which punished the backend with the
  // BEST lettering (Grok shifts global tone: #323 failed 3/4 with perfect
  // letters) and never measured anything we care about, since non-letter pixels
  // are discarded by construction now. What matters: did we find letter-shaped
  // ink, and does it sit where the title belongs?
  const coverage = drawnN ? +(overlapN / drawnN).toFixed(3) : 0;   // drawn glyphs that got repainted
  const spread = drawnN ? +(foundN / drawnN).toFixed(2) : 0;       // found ink vs drawn ink (≫1 ⇒ smear)
  const INK_MIN = params.inkMin ?? 0.55;
  const SPREAD_MAX = params.spreadMax ?? 3.0;
  const alignPass = coverage >= INK_MIN && spread <= SPREAD_MAX;
  const offMaskMeanDiff = spread;
  const ALIGN_MAX = SPREAD_MAX;

  // The composited layer is PIGMENT (fgBuf) with the solved alpha — NOT model
  // pixels. Its partial-alpha edges therefore blend with our own background.
  const layerSource = (detect === 'sam' && samMaskRaw) ? paintedRaw : fgBuf;
  const paintedRgba = await sharp(layerSource, { raw: { width: outW, height: outH, channels: 3 } })
    .joinChannel(foundMaskSmooth, { raw: { width: outW, height: outH, channels: 1 } })
    .png().toBuffer();
  await addStep(`solved alpha (${foundN} px, ${Math.round(coverage * 100)}% of the drawn glyphs)`,
    `data:image/png;base64,${(await sharp(foundMaskSmooth, { raw: { width: outW, height: outH, channels: 1 } }).png().toBuffer()).toString('base64')}`);
  await addStep('extracted pigment layer (colour × alpha, over checker = transparent)', `data:image/png;base64,${paintedRgba.toString('base64')}`);

  // Base = the EMPTY (textless) scene, so the model's artwork never survives.
  const baseBuf = await sharp(artBytes).resize(W, H, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  const finalBuf = alignPass
    ? await sharp(baseBuf)
      .composite([{ input: paintedRgba, left: mode === 'full' ? 0 : crop.left, top: mode === 'full' ? 0 : crop.top }])
      .jpeg({ quality: 92 }).toBuffer()
    : composedBuf;
  const finalUri = `data:image/jpeg;base64,${finalBuf.toString('base64')}`;

  // --- 5. OCR gate (deterministic, diacritic-sensitive) ----------------------
  const paintedCropUri = `data:image/jpeg;base64,${(await sharp(finalBuf).extract(crop).jpeg({ quality: 95 }).toBuffer()).toString('base64')}`;
  let ocrText = null, gatePass = null, gateError = null;
  try {
    ocrText = await transcribeTextInImage(paintedCropUri);
    gatePass = normalizeTitleForGate(ocrText) === normalizeTitleForGate(title);
  } catch (e) {
    gateError = e.message;
  }

  const versionIndex = await saveTestVersion(target.storyId, coverKey, null, finalUri, experimentId);
  return {
    imageType: coverKey, coverType: coverKey, versionIndex, steps,
    promptUsed: prompt, modelId: result.modelId || params.model || backend, elapsedMs,
    cost: result.cost ?? null,
    alignGate: {
      offMaskMeanDiff, threshold: ALIGN_MAX, pass: alignPass, coverage, spread, foundPx: foundN,
      verdict: alignPass
        ? `PASS — repainted ${Math.round(coverage * 100)}% of the drawn glyphs, ink spread ${spread}x (letters only, artwork from the empty scene)`
        : (coverage < INK_MIN
          ? `FAIL — only ${Math.round(coverage * 100)}% of the drawn glyphs were repainted (need ${Math.round(INK_MIN * 100)}%); discarded, flat composite kept`
          : `FAIL — found ink spreads ${spread}x the drawn glyphs (max ${SPREAD_MAX}) — the model smeared beyond the letters; discarded`),
    },
    titleGate: {
      expected: title,
      ocr: ocrText,
      pass: gatePass,
      error: gateError,
      verdict: gatePass === true ? 'PASS — letters intact, paint-in shippable'
        : gatePass === false ? 'FAIL — lettering changed; production would keep the flat composite'
          : `GATE ERROR — ${gateError}`,
    },
    typography: { fontId: spec?.fontId, layout: spec?.layout, face: spec?.face, lines: spec?.lines },
    paintinSetup: {
      cropPx: `${crop.width}×${crop.height}`,
      cropPctOfCover: `${cropPctW}%×${cropPctH}%`,
      renderedAt: `${snap(crop.width * 2)}×${snap(crop.height * 2)}`,
      marginPct: params.marginPct ?? 0.12,
      dilatePx,
      contextRef: useContextRef,
      recolor,
      backend,
      mode,
      detect,
      searchPx,
      refsSent: refs.length,
      deterministicColour: spec?.face || null,
    },
    maskPx: { dilatePx, crop },
    issuesSummary: gatePass === false ? `OCR mismatch: drew "${ocrText}" for "${title}"` : null,
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

/**
 * Final-book audit (report only). Target: {storyId}.
 *
 * Reads the stored book the way a child receives it — each page's text next to
 * the image that actually shipped on it. `loadStoryDataFull` rehydrates the
 * ACTIVE image per page, which is the picture the reader sees; bookAudit falls
 * back to the bestSource version for any page that arrives without bytes.
 */
async function runBookAuditStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, withTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { auditStoryBook } = require('./bookAudit');
  const { storyData } = await loadStoryDataFull(target.storyId);
  const t0 = Date.now();
  // withTemplates, not a global assignment: the override must be visible only
  // inside this run's async tree so two concurrent experiments cannot read each
  // other's prompt.
  const audit = await withTemplates({ bookAudit: promptOverride }, () => auditStoryBook(storyData, {
    storyId: target.storyId,
    modelId: params.modelId || undefined,
  }));
  if (!audit) return { ok: false, elapsedMs: Date.now() - t0, faults: 0, byRoute: { IMG: [], TEXT: [] }, logLines: [] };
  return {
    ok: true,
    elapsedMs: Date.now() - t0,
    modelId: audit.modelId,
    faults: audit.faults,
    byRoute: audit.byRoute,
    pagesRead: audit.pagesRead,
    pagesSkipped: audit.pagesSkipped,
    // The fault lines verbatim — the same yardstick countFaults reads.
    logLines: [...audit.byRoute.IMG, ...audit.byRoute.TEXT]
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
      .map(f => f.line),
    raw: audit.raw,
  };
}

/**
 * Audit replay — run the hostile audit for one level (arc | beats | text) on a
 * story's STORED artifact with one or more models. The artifact is frozen, so
 * the only variable is the model (or an overridden prompt): this is the
 * auditor bake-off as a repeatable Lab stage. Report only — writes nothing
 * back to the story.
 *
 * params.level  : 'arc' | 'beats' | 'text' (required)
 * params.models : comma list of TEXT_MODELS keys (default: the production
 *                 auditor for that level)
 */
async function runAuditReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, withTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');
  const H = require('./storyHelpers');

  const level = String(params.level || '').toLowerCase();
  if (!['arc', 'beats', 'text'].includes(level)) throw new Error(`params.level must be arc | beats | text, got "${params.level}"`);
  const defaultModel = level === 'text'
    ? (MODEL_DEFAULTS.textAuditModel || MODEL_DEFAULTS.arcReviewModel)
    : (level === 'arc'
      ? (MODEL_DEFAULTS.arcAuditModel || MODEL_DEFAULTS.arcReviewModel)
      : (MODEL_DEFAULTS.beatsAuditModel || MODEL_DEFAULTS.outlineReviewModel));
  const models = String(params.models || params.model || defaultModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const outline = String(storyData.outline || '');
  let prompt = null;
  let templateKey = null;
  if (level === 'arc') {
    templateKey = 'storyArcAudit';
    const arc = H.parseBeats(outline).arc || storyData.beatsReviewReport?.arc || '';
    if (!arc.trim()) throw new Error('story has no stored arc to audit');
    prompt = H.buildArcAuditPrompt(storyData, arc);
  } else if (level === 'beats') {
    templateKey = 'storyBeatsAudit';
    const beatsSection = (outline.match(/---\s*BEATS\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
    const beats = H.parseBeats(beatsSection).pages;
    if (!beats.length) throw new Error('story has no stored beats to audit');
    const pagePlan = (outline.match(/---\s*PAGE PLAN\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
    prompt = H.buildBeatsAuditPrompt(beats, pagePlan);
  } else {
    templateKey = 'storyTextAudit';
    const pages = (storyData.sceneImages || [])
      .map(p => ({ pageNumber: p.pageNumber, text: p.text, sceneIntent: p.sceneIntent || p.sceneDescription }))
      .filter(p => String(p.text || '').trim());
    if (!pages.length) throw new Error('story has no page text to audit');
    prompt = H.buildTextAuditPrompt(storyData, pages);
  }
  if (!prompt) throw new Error(`${templateKey} template unavailable`);

  const t0 = Date.now();
  const runs = await Promise.all(models.map(async (model) => {
    const t = Date.now();
    try {
      const res = await withTemplates({ [templateKey]: promptOverride }, () =>
        callTextModelStreaming(prompt, 16000, null, model, { usageLabel: 'testlab_audit_replay', temperature: 0 }));
      const raw = String(res.text || '').trim();
      return {
        model,
        modelId: res.modelId || TEXT_MODELS[model].modelId,
        ok: raw.length > 0,
        faults: H.countFaults(raw),
        byCategory: H.faultsByCategory(raw),
        faultLines: raw.split('\n').filter(l => /^FAULT/.test(l.trim())),
        raw: raw.slice(0, 30000),
        elapsedMs: Date.now() - t,
        usage: { input_tokens: res.usage?.input_tokens || 0, output_tokens: res.usage?.output_tokens || 0 },
        cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
      };
    } catch (e) {
      return { model, ok: false, error: e.message, elapsedMs: Date.now() - t };
    }
  }));
  return {
    ok: runs.some(r => r.ok),
    level,
    elapsedMs: Date.now() - t0,
    promptChars: prompt.length,
    runs,
    logLines: runs.flatMap(r => [`— ${r.model}: ${r.ok ? `${r.faults} fault(s), ${Math.round(r.elapsedMs / 1000)}s, $${(r.cost || 0).toFixed(3)}` : `FAILED ${r.error || 'empty output'}`}`, ...(r.faultLines || [])]),
  };
}

/**
 * Outline-review model comparison (split outline review, Call 2). Target:
 * {storyId}. Compares how DIFFERENT models perform AS THE REVIEWER.
 *
 * One critique-free writer draft (Call 1, split mode) is generated ONCE from
 * the story's reconstructed creation input, then every model in params.models
 * runs buildOutlineReviewPrompt on that SAME draft (Call 2) — so the only
 * variable is the reviewer. Faithful to production: same split writer, same
 * deterministic REVIEW HINTS pre-check, same buildOutlineReviewPrompt. Report
 * only — nothing is written back to the story.
 *
 * params.models    : string[] of TEXT_MODELS keys to compare (default: the
 *                    configured outlineReviewModel).
 * params.writerModel : model for the shared Call-1 draft (default: MODEL_DEFAULTS.outline).
 */
async function runOutlineReviewStage(target, { params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildUnifiedStoryPrompt, buildOutlineReviewPrompt } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');
  const { UnifiedStoryParser } = require('./outlineParser');
  const { checkSceneConsistency } = require('./sceneConsistencyCheck');

  const models = Array.isArray(params.models) && params.models.length
    ? params.models
    : [MODEL_DEFAULTS.outlineReviewModel];
  const bad = models.filter(m => !TEXT_MODELS[m]);
  if (bad.length) throw new Error(`Unknown reviewer model(s): ${bad.join(', ')}. Valid: ${Object.keys(TEXT_MODELS).join(', ')}`);

  // Reconstruct the creation input from the PERMANENT story record (story_jobs
  // is pruned ~1h after completion — routes/jobs.js). stories.data carries every
  // field the prompt builders read, copied verbatim at save time (server.js).
  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const inputData = {
    pages: storyData.pages,
    languageLevel: storyData.languageLevel,
    language: storyData.language,
    mainCharacters: storyData.mainCharacters || [],
    characters: storyData.characters || [],
    relationships: storyData.relationships || {},
    relationshipTexts: storyData.relationshipTexts || {},
    storyCategory: storyData.storyCategory,
    storyTopic: storyData.storyTopic,
    storyTheme: storyData.storyTheme,
    storyType: storyData.storyType,
    storyTypeName: storyData.storyTypeName,
    storyDetails: storyData.storyDetails,
    artStyle: storyData.artStyle,
    season: storyData.season,
    userLocation: storyData.userLocation,
    dedication: storyData.dedication,
    layout: storyData.layout,
    storyPromptVariant: storyData.storyPromptVariant,
    availableLandmarks: storyData.availableLandmarks,
    customThemeText: storyData.customThemeText,
    modelOverrides: storyData.modelOverrides,
    splitOutlineReview: true, // force the critique-free Call-1 writer draft
  };
  if (!(inputData.characters || []).length) {
    throw new Error(`Story ${target.storyId} has no persisted characters/input to rebuild the review.`);
  }

  // Call 1 — one shared critique-free writer draft.
  const writerModel = params.writerModel || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[writerModel]) throw new Error(`Unknown writer model "${writerModel}"`);
  const writerPrompt = buildUnifiedStoryPrompt(inputData, inputData.pages || null);
  const wt0 = Date.now();
  // STREAMING, like production (server.js buildUnified call) — not optional. A
  // non-streaming request gets no response headers until the whole completion is
  // finished, so any draft that takes over 5 minutes trips undici's default
  // 300s headersTimeout and surfaces as "fetch failed". withRetry sees that as
  // retryable, so it burns 3 x 5 min and ends with zero results (exp #270).
  // Streaming delivers headers immediately, so the ceiling never applies.
  const writer = await callTextModelStreaming(writerPrompt, 64000, null, writerModel, { usageLabel: 'testlab_review_writer' });
  const writerElapsedMs = Date.now() - wt0;
  const writerOutput = writer.text || '';
  if (!writerOutput) throw new Error('Writer draft (Call 1) came back empty');

  // Deterministic scene-consistency pre-check → REVIEW HINTS (same as prod).
  let hints = [];
  try {
    const draftPages = new UnifiedStoryParser(writerOutput).extractPages();
    hints = checkSceneConsistency(draftPages, writerOutput, {
      knownCharacterNames: (inputData.characters || []).map(c => c.name),
    });
  } catch (e) {
    log.warn(`[TESTLAB] outline_review hint pre-check failed (non-fatal): ${e.message}`);
  }
  const hintCount = hints.reduce((n, e) => n + (e.issues?.length || 0), 0);

  // ── Call 2 ──────────────────────────────────────────────────────────
  const CAP = 120000; // per-text storage cap; full reviews are large
  const validAspect = a => (a === 'text' || a === 'scene') ? a : 'both';
  const fixCountOf = t => (String(t).match(/^[\s\-*•]*Pages?\s+[\d,\s\-–]+?\s*:/gim) || []).length;

  // Run one review call: build the aspect-scoped prompt (optionally with prior
  // passes fed in for the repeated-review convergence test), score its fixes.
  const runOneReview = async (modelKey, aspect, priorReviews) => {
    if (!TEXT_MODELS[modelKey]) throw new Error(`Unknown reviewer model "${modelKey}"`);
    const prompt = buildOutlineReviewPrompt(inputData, writerOutput, hints, { aspect, priorReviews });
    if (!prompt) throw new Error('outline-review template unavailable');
    const t0 = Date.now();
    // Streaming for the same headersTimeout reason as the writer above. Anthropic
    // / xAI / Gemini reviewers stream; OpenRouter has no streaming path and falls
    // back to the plain call, so those stay exposed to the 5-minute ceiling.
    const r = await callTextModelStreaming(prompt, 32000, null, modelKey, { usageLabel: 'testlab_outline_review' });
    const elapsedMs = Date.now() - t0;
    const usage = r.usage || {};
    const modelId = r.modelId || TEXT_MODELS[modelKey].modelId;
    let reviewText = r.text || '';
    const reviewTruncated = reviewText.length > CAP;
    if (reviewTruncated) reviewText = reviewText.slice(0, CAP) + '\n…[output truncated for storage]';
    return {
      modelKey, modelId, aspect, ok: true, elapsedMs,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 },
      cost: calculateTextCost(modelId, usage), fixCount: fixCountOf(reviewText), reviewText, reviewTruncated,
    };
  };

  let writerDraft = writerOutput;
  const writerTruncated = writerDraft.length > CAP;
  if (writerTruncated) writerDraft = writerDraft.slice(0, CAP) + '\n…[draft truncated for storage]';

  const mode = params.mode === 'iterate' ? 'iterate' : 'compare';
  const base = {
    stageKind: 'outline_review',
    mode,
    writerModel,
    writerModelId: writer.modelId || TEXT_MODELS[writerModel].modelId,
    writerElapsedMs,
    writerChars: writerOutput.length,
    writerTruncated,
    writerDraft,
    hintCount,
  };

  if (mode === 'iterate') {
    // Repeated reviews: each round's critique feeds the next ("go deeper, only
    // add what's new"). Per-round model(s) — same or different — test whether
    // mixing models helps; per-round fix counts show whether it converges.
    const roundsCfg = Array.isArray(params.rounds) && params.rounds.length ? params.rounds : [{}];
    const priorCombined = [], priorText = [], priorScene = [];
    const rounds = [];
    for (let i = 0; i < roundsCfg.length; i++) {
      const rc = roundsCfg[i] || {};
      const startedAt = Date.now();
      try {
        if (rc.split) {
          const textModel = rc.textModel || MODEL_DEFAULTS.outlineReviewModel;
          const sceneModel = rc.sceneModel || MODEL_DEFAULTS.outlineReviewModel;
          const [tr, sr] = await Promise.all([
            runOneReview(textModel, 'text', priorText),
            runOneReview(sceneModel, 'scene', priorScene),
          ]);
          priorText.push(tr.reviewText); priorScene.push(sr.reviewText);
          const totalFixCount = tr.fixCount + sr.fixCount;
          rounds.push({ round: i + 1, split: true, text: tr, scene: sr, totalFixCount, converged: totalFixCount === 0, elapsedMs: Date.now() - startedAt });
        } else {
          const modelKey = rc.model || MODEL_DEFAULTS.outlineReviewModel;
          const rev = await runOneReview(modelKey, validAspect(params.aspect), priorCombined);
          priorCombined.push(rev.reviewText);
          rounds.push({ round: i + 1, split: false, review: rev, totalFixCount: rev.fixCount, converged: rev.fixCount === 0, elapsedMs: Date.now() - startedAt });
        }
      } catch (err) {
        rounds.push({ round: i + 1, ok: false, error: err.message, elapsedMs: Date.now() - startedAt });
        break; // later rounds depend on this one's output
      }
    }
    return { ...base, rounds };
  }

  // Compare mode (default): N models each do ONE review of the same draft, same
  // aspect, independently — which model reviews best.
  const aspect = validAspect(params.aspect);
  const reviewRuns = await Promise.all(models.map(m =>
    runOneReview(m, aspect, []).catch(err => ({ modelKey: m, ok: false, elapsedMs: 0, error: err.message }))
  ));
  return { ...base, aspect, reviewRuns };
}

/**
 * TEXT REFINEMENT — iterative, full text in / full text out.
 *
 * Distinct from outline_review's `iterate` mode on purpose. There, every round
 * re-reads the SAME writer draft with a growing stack of prior critiques
 * attached, and answers in patches — so the rounds argue with each other's
 * comments instead of building on each other's prose. Here each round receives
 * only (target + scene outlines + the current text) and returns the complete
 * text; round N+1's input is literally round N's output, and no commentary is
 * ever carried forward.
 *
 * Reads the STORED story rather than generating a fresh draft: refining the text
 * that actually shipped is the point, and it skips a ~6-minute writer call.
 * Scene outlines are read-only — the illustrations already exist.
 *
 * params.rounds  : number of passes (default 2, capped at 5)
 * params.model   : model for every round, or params.roundModels[] for per-round
 */
/**
 * BEATS-FIRST PLANNING — measures time-to-lock.
 *
 * The current pipeline produces outline + visual bible + full text + scene hints
 * in ONE writer call (~345s) before anything can be drawn. Images are 25 of the
 * 38 minutes a story takes, so the number that matters is how soon scenes are
 * locked and the image run can start. This stage runs the proposed front half —
 * beats + one-line scene intents, then a fast structural review — against a real
 * story's brief, so time-to-lock and plan quality can be judged before the
 * production pipeline is restructured.
 *
 * Nothing here writes prose. The full text and its refinement are the OTHER
 * branch, which already runs parallel with images in production.
 *
 * params.beatsModel  : planner (default MODEL_DEFAULTS.outline)
 * params.reviewModel : fast reviewer (default MODEL_DEFAULTS.outlineReviewModel)
 * params.pages       : page count (default: the story's own)
 * params.skipReview  : plan only, to isolate planner cost
 * params.storyDetails : replace the story's own idea text. The idea is an input
 *   to the plan, so a change to the idea GENERATOR can only be measured by
 *   planning the same cast and setting from a different idea.
 */
/**
 * Stored beats → Art Director → (optionally) page text, run twice: once with
 * the beats-audit faults carried in, once without.
 *
 * Answers the question CARRY_ROUTES exists for — can a stage downstream of the
 * beats repair what the beats review left behind — on a story that already
 * shipped, with no images and no re-planning. Uses the SAME route text
 * production uses (server/lib/carryRoutes.js), or the arms would measure a
 * string production never sends.
 */
async function runStoredBeatsScenes(storyData, storedBeats, { params = {}, costOf }) {
  const { buildSceneExpansionAllPrompt, buildAvailableAvatarsForPrompt, parseRefinedText: parseAll,
    buildStoryTextFromBeatsPrompt } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../config/models');
  const { CARRY_ROUTES, withCarriedFindings } = require('./carryRoutes');
  const { checkScenes, REVIEWABLE } = require('./sceneBriefCheck');

  const beatsAudit = String(params.beatsAudit || storyData?.beatsReviewReport?.audit || '').trim();
  if (!beatsAudit) throw new Error('no beats audit findings stored on this story — nothing to carry');

  const limit = parseInt(params.expandPages, 10) || storedBeats.length;
  const toExpand = storedBeats.slice(0, limit);
  const model = params.expansionModel || MODEL_DEFAULTS.outline;
  const imgCfg = IMAGE_MODELS[storyData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage];
  const availableAvatars = buildAvailableAvatarsForPrompt
    ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
    : '';

  const basePrompt = buildSceneExpansionAllPrompt(
    { ...storyData, characters: storyData.characters || [], pageClothing: null },
    toExpand.map(b => ({ pageNumber: b.pageNumber, beat: b.beat, scene: b.scene })),
    {
      visualBible: storyData.visualBible || null,
      availableAvatars,
      maxCharactersPerScene: imgCfg?.maxCharactersPerScene || 3,
      clothingRequirements: storyData.clothingRequirements || null,
    }
  );
  if (!basePrompt) throw new Error('scene-expansion-all template unavailable');

  const castNames = [
    ...(storyData.characters || []).map(c => c && c.name),
    ...(Array.isArray(storyData.visualBible?.secondaryCharacters)
      ? storyData.visualBible.secondaryCharacters
      : Object.values(storyData.visualBible?.secondaryCharacters || {})).map(c => c && c.name),
  ].filter(Boolean);

  const arms = [
    { key: 'control', label: 'no carry', prompt: basePrompt },
    { key: 'carry', label: 'beats audit carried', prompt: withCarriedFindings(basePrompt, beatsAudit, CARRY_ROUTES.beatsToArtDirector) },
  ];

  const results = [];
  for (const arm of arms) {
    const t0 = Date.now();
    const res = await callTextModelStreaming(arm.prompt, null, null, model, { usageLabel: 'testlab_carry_ab' });
    const parsed = parseAll(res.text || '', toExpand.map(b => b.pageNumber), 'SCENES');
    const briefs = parsed.pages.map(p => ({ pageNumber: p.pageNumber, brief: p.text }));
    const checked = checkScenes(briefs, castNames, storyData.visualBible || null);
    const faults = checked.findings.filter(f => REVIEWABLE.has(f.type));
    results.push({
      arm: arm.key,
      label: arm.label,
      promptChars: arm.prompt.length,
      elapsedMs: Date.now() - t0,
      modelId: res.modelId,
      usage: res.usage,
      cost: costOf ? costOf(res) : null,
      pagesReturned: briefs.length,
      faultCount: faults.length,
      faults: faults.map(f => ({ page: f.pageNumber, type: f.type })),
      briefs,
    });
  }

  let storyText = null;
  if (params.alsoText) {
    const textBase = buildStoryTextFromBeatsPrompt(storyData, toExpand, [], storyData.outline || '');
    if (textBase) {
      const textArms = [
        { key: 'control', prompt: textBase },
        { key: 'carry', prompt: withCarriedFindings(textBase, beatsAudit, CARRY_ROUTES.beatsToStoryText) },
      ];
      storyText = [];
      for (const a of textArms) {
        const r = await callTextModelStreaming(a.prompt, null, null, params.textModel || MODEL_DEFAULTS.storyText || model, { usageLabel: 'testlab_carry_ab_text' });
        storyText.push({ arm: a.key, promptChars: a.prompt.length, modelId: r.modelId, usage: r.usage, cost: costOf ? costOf(r) : null, text: String(r.text || '').slice(0, 30000) });
      }
    }
  }

  return {
    stageKind: 'beats_scenes',
    mode: 'stored_beats_carry_ab',
    storyId: storyData.id || null,
    beatsAuditFaults: (beatsAudit.match(/^FAULT(\[[A-Z]+\])?:/gm) || []).length,
    beatsAudit,
    pages: toExpand.length,
    arms: results,
    delta: results.length === 2 ? { control: results[0].faultCount, carry: results[1].faultCount } : null,
    storyText,
  };
}

async function runBeatsScenesStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildBeatsPrompt, buildBeatsReviewPrompt, parseBeats } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');

  const { storyData: loaded } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  // Same cast, same setting, different idea — the only way to measure a change
  // to the idea generator downstream of it.
  const storyData = params.storyDetails
    ? { ...loaded, storyDetails: String(params.storyDetails) }
    : loaded;
  const pageCount = parseInt(params.pages, 10) || (storyData.sceneImages || []).length || storyData.pages || 10;
  const expected = Array.from({ length: pageCount }, (_, i) => i + 1);

  const beatsModel = params.beatsModel || MODEL_DEFAULTS.outline;
  const reviewModel = params.reviewModel || MODEL_DEFAULTS.outlineReviewModel;
  for (const m of [beatsModel, reviewModel]) {
    if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);
  }

  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});
  const lockStart = Date.now();

  // START FROM THE STORED BEATS (owner, 2026-08-25). The stage normally plans
  // and reviews beats from scratch, which measures the planner. To ask the
  // different question — can the Art Director and the text writer repair what
  // the beats left behind — the beats have to be the ones that actually
  // shipped, not a fresh draft. Every page keeps its own beat in
  // `outlineExtract` ("BEAT: … SCENE: …"), so the shipped set is recoverable
  // without re-running anything.
  if (params.useStoredBeats) {
    const stored = (storyData.sceneImages || [])
      .map((s) => {
        const raw = String(s.outlineExtract || '');
        const beat = (raw.match(/BEAT:\s*([\s\S]*?)(?=\nSCENE:|$)/i) || [, ''])[1].trim();
        const scene = (raw.match(/SCENE:\s*([\s\S]*)$/i) || [, ''])[1].trim();
        return beat ? { pageNumber: s.pageNumber, beat, scene } : null;
      })
      .filter(Boolean);
    if (stored.length === 0) throw new Error('useStoredBeats: no page carries an outlineExtract BEAT');
    return await runStoredBeatsScenes(storyData, stored, { params, experimentId: null, costOf, lockStart });
  }

  // ── Step 1: plan ────────────────────────────────────────────────────────
  let plannerPrompt = buildBeatsPrompt(storyData, pageCount);
  if (!plannerPrompt) throw new Error('story-beats template unavailable');
  if (promptOverride) plannerPrompt = promptOverride;

  const t0 = Date.now();
  const planRes = await callTextModelStreaming(plannerPrompt, null, null, beatsModel, { usageLabel: 'testlab_beats' });
  const planMs = Date.now() - t0;
  const planParsed = parseBeats(planRes.text || '', expected);
  if (planParsed.pages.length === 0) throw new Error('Planner returned no parseable beats');

  const plan = {
    modelKey: beatsModel,
    modelId: planRes.modelId,
    provider: planRes.provider || null,
    elapsedMs: planMs,
    ttftMs: planRes.ttft ?? null,
    usage: planRes.usage,
    cost: costOf(planRes),
    promptChars: plannerPrompt.length,
    prompt: plannerPrompt,
    rawResponse: (planRes.text || '').slice(0, 40000),
    pages: planParsed.pages,
    missingPages: planParsed.missing,
  };

  // ── Step 2: fast structural review ──────────────────────────────────────
  let review = null;
  let finalBeats = planParsed.pages;
  if (!params.skipReview) {
    const tlPagePlan = (String(planRes.text || '').match(/---\s*PAGE PLAN\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]*---|$)/i) || [, ''])[1].trim();
    const reviewPrompt = buildBeatsReviewPrompt(storyData, planParsed.pages, planParsed.arc, tlPagePlan);
    if (!reviewPrompt) throw new Error('story-beats-review template unavailable');
    const t1 = Date.now();
    const revRes = await callTextModelStreaming(reviewPrompt, null, null, reviewModel, { usageLabel: 'testlab_beats_review' });
    const revMs = Date.now() - t1;
    const revParsed = parseBeats(revRes.text || '', []);

    // Only rewritten pages come back; everything else keeps its planned beat.
    const byPage = new Map(revParsed.pages.map(p => [p.pageNumber, p]));
    finalBeats = planParsed.pages.map(p => {
      const fix = byPage.get(p.pageNumber);
      return fix ? { ...p, beat: fix.beat || p.beat, scene: fix.scene || p.scene } : p;
    });
    const changed = finalBeats
      .filter((p, i) => p.beat !== planParsed.pages[i].beat || p.scene !== planParsed.pages[i].scene)
      .map(p => p.pageNumber);

    review = {
      modelKey: reviewModel,
      modelId: revRes.modelId,
      provider: revRes.provider || null,
      elapsedMs: revMs,
      ttftMs: revRes.ttft ?? null,
      usage: revRes.usage,
      cost: costOf(revRes),
      promptChars: reviewPrompt.length,
      prompt: reviewPrompt,
      rawResponse: (revRes.text || '').slice(0, 40000),
      analysis: (revParsed.analysis || '').slice(0, 40000),
      changedPages: changed,
      strayPages: revParsed.pages.map(p => p.pageNumber).filter(n => !expected.includes(n)),
    };
  }

  const timeToLockMs = Date.now() - lockStart;

  // ── Step 3: scene creation FROM BEATS ───────────────────────────────────
  // The load-bearing question for the whole restructure. Production expands
  // scenes from the finished page TEXT (server.js passes page.text) — but in a
  // beats-first pipeline the text does not exist yet. So this feeds the Art
  // Director the BEAT + SCENE line instead and puts the result next to the scene
  // description the real pipeline produced for the same page, so "good enough to
  // draw from" is a judgement about two visible artefacts rather than a guess.
  let sceneExpansions = null;
  let sceneReview = null;
  let sceneReviews = null;
  let timeToScenesMs = null;
  if (params.expandScenes !== false) {
    const { buildSceneExpansionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
    const { callTextModelStreaming: callStream } = require('./textModels');
    const { IMAGE_MODELS } = require('../config/models');

    const expandLimit = parseInt(params.expandPages, 10) || finalBeats.length;
    const toExpand = finalBeats.slice(0, expandLimit);
    const lang = storyData.language || 'en';
    const imgModelConfig = IMAGE_MODELS[storyData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage];
    const availableAvatars = buildAvailableAvatarsForPrompt
      ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
      : '';
    const storedByPage = new Map((storyData.sceneImages || []).map(s => [s.pageNumber, s.sceneDescription || '']));

    const expStart = Date.now();

    // ALL-PAGES PATH — what production actually runs (owner, 2026-08-09).
    // beatsPipeline expands every page in ONE call via buildSceneExpansionAllPrompt
    // and hands the Art Director each character's resolved OUTFIT TEXT. This
    // harness was still calling the PER-PAGE builder with no clothing at all, so
    // it measured a code path production no longer uses and would have
    // reproduced the old outfit bug no matter what shipped. Opt out with
    // params.perPageExpansion for the historical comparison.
    //
    // `primaryClothing` is deliberately NOT passed: production cannot have it
    // here (pageClothing is derived from THIS stage's output), and a finished
    // story does, so passing it made the lab resolve outfits down a branch
    // production never takes — masking exactly the bug that shipped.
    if (params.perPageExpansion !== true) {
      const { buildSceneExpansionAllPrompt, parseRefinedText: parseAll } = require('./storyHelpers');
      const allPrompt = buildSceneExpansionAllPrompt(
        { ...storyData, characters: storyData.characters || [], pageClothing: null },
        toExpand.map(b => ({ pageNumber: b.pageNumber, beat: b.beat, scene: b.scene })),
        {
          visualBible: storyData.visualBible || null,
          availableAvatars,
          maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
          clothingRequirements: storyData.clothingRequirements || null,
        }
      );
      if (allPrompt) {
        const tAll = Date.now();
        const res = await callStream(allPrompt, null, null, params.sceneModel || MODEL_DEFAULTS.sceneDescription, {
          usageLabel: 'testlab_beats_scene_expansion_all',
          ...(params.sceneNoReasoning ? { reasoning: { enabled: false } } : {}),
        });
        const parsedAll = parseAll(res.text || '', toExpand.map(b => b.pageNumber), 'SCENES');
        const byPage = new Map((parsedAll.pages || []).map(x => [x.pageNumber, x.text]));
        sceneExpansions = toExpand.map(b => ({
          pageNumber: b.pageNumber,
          ok: byPage.has(b.pageNumber),
          elapsedMs: Date.now() - tAll,
          modelId: res.modelId,
          provider: res.provider || null,
          usage: res.usage,
          cost: costOf(res),
          promptChars: allPrompt.length,
          prompt: allPrompt,
          fromBeats: String(byPage.get(b.pageNumber) || '').slice(0, 20000),
          storedProduction: (storedByPage.get(b.pageNumber) || '').slice(0, 20000),
          ...(byPage.has(b.pageNumber) ? {} : { error: 'page missing from the all-pages response' }),
        }));
        timeToScenesMs = Date.now() - lockStart;
      }
    }

    if (!sceneExpansions) sceneExpansions = await Promise.all(toExpand.map(async b => {
      // BEAT + SCENE stands in for page.text. No rawOutlineContext: in a
      // beats-first run there is no outline block yet, so this measures the
      // Art Director working from the plan alone.
      const pageContent = `BEAT: ${b.beat}\nSCENE: ${b.scene}`;
      const prompt = buildSceneExpansionPrompt(
        b.pageNumber, pageContent, storyData.characters || [], lang,
        storyData.visualBible || null, availableAvatars, null,
        {
          maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
          artStyleId: storyData.artStyle,
          imageBackend: imgModelConfig?.backend,
        }
      );
      const t = Date.now();
      try {
        const res = await callStream(prompt, null, null, params.sceneModel || MODEL_DEFAULTS.sceneDescription, {
          usageLabel: 'testlab_beats_scene_expansion',
          // Scene expansion is transcription, not judgement — reasoning is pure
          // waste here (measured 14,867 reasoning tokens for 2,505 of answer).
          ...(params.sceneNoReasoning ? { reasoning: { enabled: false } } : {}),
        });
        return {
          pageNumber: b.pageNumber,
          ok: true,
          elapsedMs: Date.now() - t,
          modelId: res.modelId,
          provider: res.provider || null,
          ttftMs: res.ttft ?? null,
          usage: res.usage,
          cost: costOf(res),
          promptChars: prompt.length,
          prompt,
          fromBeats: (res.text || '').slice(0, 20000),
          storedProduction: (storedByPage.get(b.pageNumber) || '').slice(0, 20000),
        };
      } catch (err) {
        return { pageNumber: b.pageNumber, ok: false, elapsedMs: Date.now() - t, error: err.message };
      }
    }));
    // ── Step 4: ONE review over ALL scene briefs ──────────────────────────
    // Repetition between pages, visual arc and continuity are invisible to a
    // per-scene reviewer — they only exist across the set — so every brief goes
    // into a single call. Reviews whatever model wrote the scenes, so Sonnet vs
    // DeepSeek can be compared as REVIEWER independently of who generated.
    const okScenes = sceneExpansions.filter(x => x.ok);
    if (params.reviewScenes !== false && okScenes.length > 0) {
      const { buildSceneReviewPrompt, parseRefinedText } = require('./storyHelpers');
      // Comma-separated list runs every model against ONE frozen set of briefs.
      // Scene expansion is non-deterministic, so two separate experiments give
      // the reviewers different inputs — measured on exp 357 vs 358, where the
      // page-3 cast differed and made the comparison meaningless. Fanning out
      // from a single expansion is the only way the difference is the reviewer.
      const srModels = String(params.sceneReviewModel || MODEL_DEFAULTS.outlineReviewModel)
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const m of srModels) if (!TEXT_MODELS[m]) throw new Error('Unknown model "' + m + '"');
      const expectedPages = okScenes.map(x => x.pageNumber);
      // Deterministic brief pre-check → {BRIEF_FINDINGS}, exactly as production
      // does it (beatsPipeline.js). Without this the harness handed the reviewer
      // a WEAKER prompt than the real pipeline and could never measure whether a
      // finding changes what it rewrites: exp 821 produced four two-action pages
      // and the review prompt carried no BRIEF FAULTS block at all.
      let briefFindings = '';
      try {
        const { checkScenes: checkBriefs, renderFindingsBlock: renderBriefBlock } = require('./sceneBriefCheck');
        const vb = storyData.visualBible || null;
        const secondaryList = Array.isArray(vb?.secondaryCharacters)
          ? vb.secondaryCharacters : Object.values(vb?.secondaryCharacters || {});
        const seen = new Set();
        const castNames = [
          ...(storyData.characters || []).map(c => c && c.name),
          ...secondaryList.map(c => c && c.name),
        ].filter(Boolean).filter((n) => {
          const k = String(n).trim().toLowerCase();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        const res = checkBriefs(okScenes.map(x => ({ pageNumber: x.pageNumber, brief: x.fromBeats })), castNames, vb);
        briefFindings = renderBriefBlock(res.byPage);
        log.info(`[TESTLAB] beats_scenes brief pre-check: ${res.findings.length} finding(s), block ${briefFindings ? briefFindings.length + ' chars' : 'empty'}`);
      } catch (bcErr) {
        log.warn(`[TESTLAB] beats_scenes brief pre-check failed (non-fatal): ${bcErr.message}`);
      }
      // finalBeats feeds the review's check 5 (character in beat vs brief),
      // same as the production callsite in beatsPipeline.js.
      const srPrompt = buildSceneReviewPrompt(storyData, okScenes.map(x => ({ pageNumber: x.pageNumber, brief: x.fromBeats })), { beats: finalBeats, briefFindings });
      if (srPrompt) {
        const reviewOnce = async (srModel) => {
          const t2 = Date.now();
          try {
            const srRes = await callStream(srPrompt, 16000, null, srModel, { usageLabel: 'testlab_scene_review' });
            const parsed = parseRefinedText(srRes.text || '', expectedPages, 'SCENES');
            return {
              modelKey: srModel,
              modelId: srRes.modelId,
              provider: srRes.provider || null,
              elapsedMs: Date.now() - t2,
              ttftMs: srRes.ttft ?? null,
              usage: srRes.usage,
              cost: costOf(srRes),
              promptChars: srPrompt.length,
              prompt: srPrompt,
              rawResponse: (srRes.text || '').slice(0, 40000),
              analysis: (parsed.analysis || '').slice(0, 40000),
              rewrotePages: parsed.pages.map(x => x.pageNumber),
              _pages: parsed.pages,
            };
          } catch (err) {
            return { modelKey: srModel, ok: false, elapsedMs: Date.now() - t2, error: err.message };
          }
        };
        sceneReviews = await Promise.all(srModels.map(reviewOnce));
        // Only the FIRST reviewer's rewrites land on the briefs — with several
        // arms their outputs conflict, and the comparison lives in sceneReviews.
        const primary = sceneReviews[0];
        if (primary && primary._pages) {
          const byPage = new Map(primary._pages.map(x => [x.pageNumber, x.text]));
          for (const x of sceneExpansions) {
            const fixed = byPage.get(x.pageNumber);
            if (fixed) { x.reviewedBrief = fixed; x.reviewRewrote = true; }
          }
        }
        for (const r of sceneReviews) delete r._pages;
        sceneReview = sceneReviews[0] || null;
      }
    }
    // Parallel, as production runs them — so this is wall-clock, not the sum.
    timeToScenesMs = timeToLockMs + (Date.now() - expStart);
  }

  return {
    stageKind: 'beats_scenes',
    sceneExpansions,
    sceneReview,
    sceneReviews,
    timeToScenesMs,
    storyId: target.storyId,
    title: storyData.title || null,
    language: storyData.language || null,
    pageCount,
    // THE headline number: how long until scenes are locked and images could
    // start. Compare against the current pipeline's storyGen stage (~5.5 min on
    // a 10-page story) — that is the whole case for restructuring.
    timeToLockMs,
    beatsPlan: plan,
    beatsReview: review,
    finalBeats,
  };
}

async function runTextRefineStage(target, { params = {}, promptOverride = null }) {
  const { refineStoryText, extractRefinablePages } = require('./textRefine');
  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });

  // Delegates to the SAME loop production runs (textRefine.js), so a Lab result
  // is evidence about the real thing rather than about a copy of it.
  const pages = extractRefinablePages(storyData.sceneImages || []);
  if (pages.length === 0) throw new Error(`Story ${target.storyId} has no page text to refine`);

  // EXACT REPLAY — params.fromWriterText restores the text the refiner actually
  // started from, so a prompt change is compared against the stored first round
  // instead of refining already-refined prose (a second round, which measures
  // nothing about the change).
  //
  // The source is textRefineReport.pages[].before, NOT data.storyText: whether
  // storyText holds the writer's draft or the refined result varies by run —
  // measured 2026-08-25, prod job_1787638707796 kept the draft while staging
  // job_1787436913379 had it overwritten with the refined text, which would
  // make this replay silently a no-op. The report lists only pages the stage
  // changed, so every other page's shipped text IS the writer's text.
  if (params.fromWriterText === true || params.fromWriterText === 'true') {
    const before = new Map(
      (storyData.textRefineReport?.pages || [])
        .filter(p => p && p.pageNumber != null && String(p.before || '').trim())
        .map(p => [p.pageNumber, String(p.before).trim()])
    );
    if (before.size === 0) {
      throw new Error(`Story ${target.storyId} has no textRefineReport.pages — nothing to replay from (the stage never changed a page, or predates the report)`);
    }
    let moved = 0;
    for (const p of pages) {
      const writerText = before.get(p.pageNumber);
      if (writerText && writerText !== p.text) { p.text = writerText; moved++; }
    }
    log.info(`[TESTLAB] text_refine exact replay: ${moved}/${pages.length} page(s) restored to the writer's text (report lists ${before.size})`);
  }

  const res = await refineStoryText(storyData, pages, {
    rounds: params.rounds,
    model: params.model,
    roundModels: params.roundModels,
    promptOverride,
    usageLabel: 'testlab_text_refine',
  });

  return {
    stageKind: 'text_refine',
    storyId: target.storyId,
    title: storyData.title || null,
    language: storyData.language || null,
    pageCount: pages.length,
    // NOT `rounds` — outline_review's iterate mode already returns that key with
    // a different shape, and both land in the same ExperimentResult.
    refineRounds: res.rounds,
    finalPages: res.pages.map((p, idx) => ({
      pageNumber: p.pageNumber,
      original: res.original[idx].text,
      final: p.text,
      changed: p.text !== res.original[idx].text,
    })),
  };
}


/**
 * STYLE-REPAIR A/B stage (roadmap Pt 10). The missing repair half of the
 * detection-only `style_check`: find the style-outlier pages, then repaint each
 * one toward the dominant style cluster with BOTH Gemini and Grok, and surface
 * the two candidates side-by-side with their before/after style-match scores so
 * a human can pick the winning model. Test-Lab-FIRST — nothing in the
 * production auto-repair pipeline calls repairPageStyle yet (PRODUCTION WIRING:
 * deferred — see docs/decisions.md Pt 10).
 *
 * Reuses production code end-to-end: detection = checkStoryStyleConsistency,
 * repaint = editImageWithPrompt (via repairPageStyle), gate = checkStyleMatch.
 *
 * Target: {storyId}. Params:
 *   - models     : string[] of {'gemini','grok'} (default both) — the A/B arms.
 *   - maxTargets : cap on outlier pages repaired this run (default 3, cost bound).
 *   - pages      : optional explicit page-number list to override detection.
 *   - detection  : optional pre-computed checkStoryStyleConsistency result
 *                  (skip re-detecting; e.g. a redo reusing the first run's audit).
 */
async function runStyleRepairStage(target, { experimentId, params = {}, promptOverride = null }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { checkStoryStyleConsistency } = require('./styleConsistency');
  const { repairPageStyle, planStyleRepair } = require('./styleRepair');

  const models = Array.isArray(params.models) && params.models.length
    ? params.models.filter(m => m === 'gemini' || m === 'grok')
    : ['gemini', 'grok'];
  if (models.length === 0) throw new Error('style_repair: params.models must contain "gemini" and/or "grok"');
  const maxTargets = Number.isInteger(params.maxTargets) && params.maxTargets > 0 ? params.maxTargets : 3;

  const { storyData } = await loadStoryDataFull(target.storyId);
  const artStyle = storyData.artStyle || null;

  const t0 = Date.now();

  // 1) Detection — reuse the existing style audit (or a passed-in result).
  const detection = params.detection || await checkStoryStyleConsistency(storyData);

  // 2) Plan — deterministic outlier→target selection.
  const plan = planStyleRepair(detection, storyData);

  // Optional explicit page override (repair specific pages regardless of the
  // audit). Each still repaints toward the planned dominant-cluster anchor.
  let targets = plan.targets;
  if (Array.isArray(params.pages) && params.pages.length) {
    const wanted = new Set(params.pages.map(Number));
    const byNum = new Map((storyData.sceneImages || []).filter(s => s?.imageData && typeof s.pageNumber === 'number').map(s => [s.pageNumber, s.imageData]));
    targets = [...wanted].filter(p => byNum.has(p)).map(p => ({
      page: p, image: byNum.get(p), targetRefPage: plan.anchorPage,
      targetRefImage: plan.anchorPage != null ? byNum.get(plan.anchorPage) : null, severity: null, differences: [],
    })).filter(tg => tg.targetRefImage);
  }
  targets = targets.slice(0, maxTargets);

  // `characterRefs` runs BOTH arms per model — prompt-only and the same
  // repaint with the page cast's styled avatars attached as style sheets.
  // One arm alone cannot answer "does the sheet improve it", which is the
  // question holding `styleRepairCharacterRefs` flag-off (decisions.md
  // 2026-08-24). Doubles the images per page; keep maxTargets small.
  const refArms = params.characterRefs === true ? [false, true] : [false];

  // 3) A/B — repaint each outlier with every requested model.
  const results = [];
  const steps = [];
  for (const tg of targets) {
    const perModel = {};
    let sheets = [];
    if (refArms.includes(true)) {
      const { collectStyleRefSheets } = require('./repairPipeline');
      sheets = await collectStyleRefSheets(tg.page, storyData.sceneImages || [], storyData.characters || [], artStyle);
      if (sheets.length === 0) {
        log.warn(`[TESTLAB] style_repair page ${tg.page}: no styled avatar sheets resolved — the refs arm is prompt-only, so the A/B is void for this page`);
      }
    }
    for (const model of models) {
      for (const useRefs of refArms) {
        const arm = useRefs ? `${model}+refs` : model;
        const m0 = Date.now();
        try {
          const rep = await repairPageStyle(tg.image, tg.targetRefImage, {
            model, artStyle, promptOverride,
            refImages: useRefs ? sheets : [],
          });
          const versionIndex = await saveTestVersion(target.storyId, 'scene', tg.page, rep.imageData, experimentId);
          perModel[arm] = {
            versionIndex,
            passedGate: rep.passedGate,
            beforeStyleMatch: rep.beforeStyleMatch,
            afterStyleMatch: rep.afterStyleMatch,
            styleComparison: rep.styleComparison || null,
            refSheets: useRefs ? sheets.length : 0,
            modelId: rep.modelId,
            elapsedMs: Date.now() - m0,
          };
          steps.push({
            label: `page ${tg.page} — ${model}${useRefs ? ` + ${sheets.length} character style sheet(s)` : ', prompt-only'}`,
            imageType: 'tl_step',
            versionIndex,
            pageNumber: tg.page,
          });
        } catch (err) {
          log.warn(`[TESTLAB] style_repair ${arm} failed on page ${tg.page}: ${err.message}`);
          perModel[arm] = { error: err.message, elapsedMs: Date.now() - m0 };
        }
      }
    }
    results.push({
      page: tg.page,
      targetRefPage: tg.targetRefPage,
      severity: tg.severity,
      differences: tg.differences,
      refSheetsAvailable: sheets.length,
      models: perModel,
    });
  }

  const elapsedMs = Date.now() - t0;

  // Strip image bytes from the surfaced detection (grid JPEG + any inline).
  const detectionSafe = JSON.parse(JSON.stringify(detection, (key, value) => {
    if (typeof value === 'string' && value.startsWith('data:image')) return `[image ${Math.round(value.length / 1024)}KB]`;
    return value;
  }));

  return {
    imageType: 'scene',
    elapsedMs,
    models,
    detection: {
      verdict: detectionSafe.verdict,
      dominantCluster: detectionSafe.dominantCluster,
      anchorPage: detectionSafe.anchorPage,
      outliers: detectionSafe.outliers,
      reasoning: detectionSafe.reasoning,
    },
    plan: { anchorPage: plan.anchorPage, targetPages: targets.map(t => t.page), skipped: plan.skipped },
    results,
    steps: steps.length ? steps : undefined,
  };
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
async function runConsolidateStage(ctx, { promptOverride, experimentId, params = {} }) {
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
    // A/B knobs: `promptOverride` swaps the consolidator's rules (severity
    // policy, dedupe, MINOR definition); `params.model` swaps the model that
    // applies them (shipped default is the configured eval model).
    promptOverride: promptOverride || null,
    modelOverride: params.model || null,
  });
  const elapsedMs = Date.now() - t0;
  // Severity mix is the point of these runs — surface it next to the plan so a
  // comparison doesn't require reading every issue by hand.
  const issues = result?.dedupedIssues || [];
  const severityMix = {};
  let singleSourceAboveModerate = 0;
  for (const i of issues) {
    const sev = String(i?.severity || '').toLowerCase();
    severityMix[sev] = (severityMix[sev] || 0) + 1;
    if (Array.isArray(i?.sources) && i.sources.length === 1
      && ['major', 'critical', 'catastrophic'].includes(sev)) singleSourceAboveModerate++;
  }
  return {
    elapsedMs,
    plan: result?.plan || null,
    dedupedIssues: result?.dedupedIssues || null,
    skipped: !!result?.skipped,
    consolidateError: result?.error || null,
    model: params.model || null,
    issueCount: issues.length,
    severityMix,
    singleSourceAboveModerate,
  };
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

/**
 * Rebuild one page through the SCENE COMPOSITE instead of a direct render:
 * plate with colour silhouettes → depopulate → detect → paste real avatar
 * cut-outs at corrected stature → blend.
 *
 * Deliberately 1:1 with what the page already has — same stored
 * emptyScenePrompt, same scene description, same per-page clothing, same cast
 * and aspect ratio — so a run is directly comparable against the page's
 * existing versions rather than against a differently-prompted scene.
 *
 * NOTE this reaches generateSceneComposite directly. The composite is disabled
 * for production generation (kill-switch, server.js) and this stage does not
 * change that: it is the Lab harness for deciding whether the path is worth
 * re-enabling, and nothing here writes an active page version.
 *
 * params:
 *   strategy 'uniform' (default) | 'stratified'
 *   facing   'threeQuarter' (default, identical to production) | 'derive'
 *   blend    true (default) — false stops after the paste, which is the step
 *            the stature work actually controls, and saves a Grok call
 */
async function runSceneCompositeStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildCompositeCast, splitCastByStratum } = require('./compositeCastBuilder');
  const { generateSceneComposite, generateStratifiedComposite, POSE_CELL, buildBlendMetadata } = require('./sceneComposite');
  const { MODEL_DEFAULTS } = require('../config/models');
  const { storyData, userId } = await loadStoryDataFull(ctx.storyId, { rehydrate: false });

  const scene = ctx.scene || {};
  const fd = scene.sceneMetadata?.fullData || scene.sceneMetadata || {};
  const strategy = params.strategy === 'stratified' ? 'stratified' : 'uniform';
  const facing = params.facing === 'derive' ? 'derive' : 'threeQuarter';
  const wantBlend = params.blend !== false;
  // 'paste' composites cut-outs and blends; 'charRepair' hands each silhouette
  // to the production character-repair call instead.
  const figureMethod = params.figureMethod === 'charRepair' ? 'charRepair' : 'paste';

  const cast = await buildCompositeCast({
    sceneMetadata: scene.sceneMetadata,
    sceneCharacters: fd.characters || scene.sceneCharacters,
    perCharClothing: scene.sceneCharacterClothing || {},
    scene: fd,
  }, {
    artStyle: ctx.artStyle || storyData.artStyle,
    characters: storyData.characters || [],
    clothingRequirements: storyData.clothingRequirements || storyData.outline?.clothingRequirements || {},
  }, {
    userId, log,
    storyCharacterAvatars: storyData.characterAvatars || null,
    // Lab parity: the same VB secondary-character fallback production uses.
    visualBible: storyData.visualBible || null,
  });

  if (!cast || !cast.length) throw new Error('composite cast is empty — page has no scene characters, or no story avatar sheets');

  // Facing. Scene-expansion emits no `pose` today (verified: 0 of 23 scene
  // characters on a real story), so production — the composite AND normal page
  // rendering, which share cropAvatarCell — lands on threeQuarter for every
  // figure. 'derive' is the A/B arm: turn the declared position into a facing
  // so side figures look toward the middle of the frame.
  for (const c of cast) {
    if (facing !== 'derive') continue;
    const s = String(c.position || '').toLowerCase();
    if (s.includes('left') && !s.includes('center')) { c.pose = 'threeQuarter'; c.flip = false; }
    else if (s.includes('right') && !s.includes('center')) { c.pose = 'threeQuarter'; c.flip = true; }
    else { c.pose = 'front'; c.flip = false; }
  }

  const { backCast, frontCast } = splitCastByStratum(cast);
  // The page's OWN generation prompt, rebuilt exactly as preparePageData builds
  // it, so a Lab run sends the blend pass what production sends it. Without this
  // the Lab would exercise a different prompt than the pipeline and its verdicts
  // would not transfer.
  let pagePrompt = null;
  try {
    const { buildImagePrompt } = require('./storyHelpers');
    pagePrompt = buildImagePrompt(
      scene.sceneDescription || fd.description || '',
      {
        artStyle: ctx.artStyle || storyData.artStyle,
        language: ctx.language || storyData.language,
        languageLevel: ctx.languageLevel || storyData.languageLevel,
        layout: ctx.layout || storyData.layout || {},
        characters: storyData.characters || [],
      },
      fd.characters || scene.sceneCharacters || null,
      ctx.visualBible || null,
      ctx.pageNumber,
      ctx.referencePhotos || null,
      { skipVisualBible: true },
    );
  } catch (err) {
    log.warn(`[TESTLAB] could not rebuild the page prompt (${err.message}) — blend falls back to the legacy brief`);
  }
  const compositeScene = {
    description: String(fd.description || scene.sceneDescription || '').slice(0, 2500),
    artStyle: ctx.artStyle || storyData.artStyle || 'watercolor',
    pageBrief: String(scene.compositeBrief || fd.pageBrief || scene.sceneDescription || '').slice(0, 2000),
    interactions: fd.interactions || [],
    pagePrompt,
    ...buildBlendMetadata(fd, scene, storyData.clothingRequirements || storyData.outline?.clothingRequirements || null),
  };
  // Pass the stored emptyScenePrompt WHOLE. It runs ~4000 chars: a leading ART
  // STYLE block, then **LOCATION:** around char 1350. Cutting either end has
  // been measured to break a run — truncating to 900 chars fed the plate style
  // boilerplate with no setting (a Living Room came back as a lakeside
  // boathouse), and skipping to **LOCATION:** dropped the style so the plate
  // came back photorealistic. Both halves are load-bearing, and the budget
  // fits: ~4000 setting + ~1300 prompt head + ~250 per cast entry stays under
  // Grok's 8000-char limit for a five-character page.
  const rawBg = String(scene.emptyScenePrompt || fd.emptyScenePrompt || scene.sceneDescription || '');
  const cleanBackgroundPrompt = rawBg.slice(0, 5000);

  const usage = [];
  const t0 = Date.now();

  // ── BLEND REPLAY ──────────────────────────────────────────────────────────
  // params.replayPasteOf = {experimentId, resultIndex} re-blends a PAST run's
  // pasted canvas instead of building a new one. Every blend variant then runs
  // against identical staging, which is the only way to read a prompt change:
  // a fresh composite re-rolls the plate, so a "better" result can just be a
  // different plate. One Grok call per try (~$0.02) instead of three.
  if (params.replayPasteOf) {
    const { blendPastedCanvas } = require('./sceneComposite');
    const { dbQuery } = require('../services/database');
    const expId = Number(params.replayPasteOf.experimentId);
    const idx = Number(params.replayPasteOf.resultIndex || 0);
    const rows = await dbQuery('SELECT results FROM testlab_experiments WHERE id = $1', [expId]);
    if (!rows.length) throw new Error(`replayPasteOf: experiment #${expId} not found`);
    const src = (rows[0].results || [])[idx];
    if (!src) throw new Error(`replayPasteOf: experiment #${expId} has no result #${idx}`);
    if (src.storyId !== ctx.storyId || src.pageNumber !== ctx.pageNumber) {
      throw new Error(`replayPasteOf: result #${idx} is ${src.storyId} P${src.pageNumber}, not this target`);
    }
    const pasteStep = (src.steps || []).find(s => /pre-blend/i.test(s.label || ''));
    if (!pasteStep) throw new Error(`replayPasteOf: result #${idx} stored no pre-blend step`);
    const img = await loadTestImage(ctx.storyId, 'tl_step', ctx.pageNumber, Number(pasteStep.versionIndex));
    if (!img?.imageData) throw new Error(`replayPasteOf: tl_step v${pasteStep.versionIndex} not found`);

    // EVAL → REPAIR arm. Instead of describing the page to the model and hoping
    // it only changes what is wrong, ask the production evaluator what IS wrong
    // and hand back the worst few as the entire instruction. One pass, no
    // iteration: the repair call never sees its own output.
    let evalReport = null;
    let promptOverride = params.blendPrompt || null;
    if (params.blendMode === 'evalRepair') {
      const { evaluateImageQuality } = require('./evalPipeline');
      const ev = await evaluateImageQuality(
        img.imageData, evalSceneDescription(ctx), evalReferencePhotos(ctx), 'scene',
        null, `testlab-exp${experimentId}-P${ctx.pageNumber}-composite`,
        ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
        { artStyle: require('../services/prompts').resolveEvalArtStyle(ctx.artStyle, ctx.scene.prompt || null) },
      );
      if (!ev) throw new Error('evalRepair: the evaluator returned nothing');
      const RANK = { CATASTROPHIC: 5, CRITICAL: 4, MAJOR: 3, MODERATE: 2, MINOR: 1 };
      const all = (ev.fixableIssues || [])
        .map(i => ({ ...i, _r: RANK[String(i.severity || '').toUpperCase()] || 2 }))
        .sort((a, b) => b._r - a._r);
      const top = all.slice(0, Number(params.topIssues) || 3);
      evalReport = {
        score: ev.score, verdict: ev.verdict, issueCount: all.length,
        used: top.map(i => ({ severity: i.severity, type: i.type, description: i.description, fix: i.fix })),
        dropped: all.slice(top.length).map(i => `${i.severity}: ${i.description}`),
      };
      if (!top.length) {
        log.info('[TESTLAB] evalRepair: the evaluator found nothing to fix — returning the pasted canvas unchanged');
        const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, img.imageData, experimentId);
        return {
          imageType: 'scene', versionIndex, elapsedMs: Date.now() - t0,
          blended: false, evalReport, modelCalls: 0, cost: 0,
        };
      }
      const artStyle = String(compositeScene.artStyle || '');
      promptOverride = `Image 1 is a finished illustration with a small number of specific defects. Repair exactly these and nothing else.\n\n`
        + top.map((i, n) => `${n + 1}. ${i.description}\n   Correction: ${i.fix}`).join('\n')
        + `\n\nEverything not listed above is correct and must survive untouched: every person stays at their exact position, size, pose, facing, face, hair, age and clothing; the camera, framing, architecture, landscape and light do not change; no one is added, removed or substituted. No text, captions, numbers or signatures.\n\nArt style: ${artStyle}.`;
      log.info(`[TESTLAB] evalRepair: score ${ev.score}, ${all.length} issues, repairing the top ${top.length}`);
    }

    const dbg = {};
    const out = await blendPastedCanvas({
      compositedData: img.imageData,
      scene: compositeScene,
      cast,
      aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
      visualBibleGridImage: ctx.visualBibleGrid || null,
      promptOverride,
      usageTracker: (provider, u, fnName, modelId) => usage.push({ provider, fn: fnName, modelId, cost: u?.cost || 0 }),
      debug: dbg,
    });
    const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, out.imageData, experimentId);
    return {
      imageType: 'scene', versionIndex, elapsedMs: Date.now() - t0,
      replayOf: { experimentId: expId, resultIndex: idx, pasteVersion: pasteStep.versionIndex },
      blended: true,
      blendPrompt: out.blendPrompt,
      blendPromptSource: params.blendMode === 'evalRepair' ? 'eval-repair'
        : (params.blendPrompt ? 'override' : (pagePrompt ? 'page-prompt' : 'legacy-brief')),
      evalReport,
      modelCalls: usage.length,
      cost: usage.reduce((a, u) => a + (u.cost || 0), 0),
    };
  }

  const fn = strategy === 'stratified' ? generateStratifiedComposite : generateSceneComposite;
  // A refused composite is a RESULT, not a void. Both abort gates fire after
  // the plate and depopulated plate have been generated and paid for, and the
  // Lab used to save steps only on success — so the very images that show WHY
  // it refused were discarded, and the owner could not see the refusal. The
  // composite attaches its partial debug to the error (err.compositeDebug);
  // save those frames onto err.partialResult, which the runner already merges
  // into the stored failure entry.
  const saveAbortSteps = async (err) => {
    const adbg = err?.compositeDebug;
    if (!adbg) return;
    const aborted = [];
    for (const [key, label] of [
      ['populatedPlate', '1 · plate with colour silhouettes (run aborted after this)'],
      ['cleanBackground', '2 · depopulated (silhouettes removed)'],
      ['composited', '3 · pasted (raw)'],
    ]) {
      const uri = adbg[key];
      if (typeof uri !== 'string' || !uri.startsWith('data:image')) continue;
      try {
        const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, uri, experimentId);
        aborted.push({ label, imageType: 'tl_step', versionIndex: v });
      } catch (e) { log.warn(`[TESTLAB] abort step "${label}" not saved: ${e.message}`); }
    }
    err.partialResult = {
      ...(err.partialResult || {}),
      steps: aborted,
      aborted: true,
      depthSpread: adbg.depthSpread ?? null,
      populatedPlatePrompt: adbg.populatedPlatePrompt || null,
      cleanBackgroundPrompt: adbg.cleanBackgroundPrompt || null,
    };
  };
  let res;
  try {
    res = await fn({
    compositeStrategy: strategy,
    cast, frontCast, backCast,
    scene: compositeScene,
    cleanBackgroundPrompt,
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    skipBlend: !wantBlend,
    figureMethod,
    // Same creature resolution production uses — the Lab has to reproduce the
    // plate the pipeline would build, or a composite bug shows up in one and
    // not the other.
    sceneCreatures: require('./visualBible')
      .resolveSceneCreatures(storyData.visualBible, fd.objects || [], ctx.pageNumber),
    figureDetect: params.figureDetect === 'diff' ? 'diff' : 'dino',
    usageTracker: (provider, u, fnName, modelId) => usage.push({ provider, fn: fnName, modelId, cost: u?.cost || 0 }),
    });
  } catch (err) {
    await saveAbortSteps(err);
    throw err;
  }
  const elapsedMs = Date.now() - t0;

  // Every intermediate goes into the Lab as a step image. The whole point of
  // the stage is to see WHERE it breaks, not just the final frame.
  const dbg = res.debug || {};
  const steps = [];
  // EVERY intermediate is stored, not a chosen three. When a run looks wrong
  // the answer is almost always in a middle frame — the plate that placed a
  // figure on water, the depopulate that erased a prop, the per-character
  // repair that got skipped — and a step that was never saved cannot be
  // inspected after the fact.
  const STEP_LABELS = [
    ['populatedPlate', '1 · plate with colour silhouettes'],
    ['cleanBackground', '2 · depopulated (silhouettes removed)'],
    ['composited', figureMethod === 'charRepair'
      ? '3 · after character repair (all figures)'
      : '3 · avatar cut-outs pasted (raw, pre-blend)'],
  ];
  const saveStep = async (uri, label) => {
    if (typeof uri !== 'string' || !uri.startsWith('data:image')) return;
    try {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, uri, experimentId);
      steps.push({ label, imageType: 'tl_step', versionIndex: v });
    } catch (err) {
      log.warn(`[TESTLAB] composite step "${label}" not saved: ${err.message}`);
    }
  };
  for (const [key, label] of STEP_LABELS) await saveStep(dbg[key], label);
  // Per-character frames: one image after each figure is repaired, so a bad
  // figure can be traced to the call that produced it.
  for (const [name, uri] of Object.entries(dbg.charRepairSteps || {})) {
    await saveStep(uri, `· after repairing ${name}`);
  }
  // Each pasted cut-out, exactly as it went onto the canvas.
  for (const [name, uri] of Object.entries(dbg.cutouts || {})) {
    await saveStep(uri, `· cut-out used for ${name}`);
  }
  // Phantom-pose renders when that path is on.
  for (const [name, v] of Object.entries(dbg.phantomPoseRenders || {})) {
    await saveStep(v?.output, `· phantom-pose render for ${name}`);
  }

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, res.imageData, experimentId);

  return {
    imageType: 'scene',
    versionIndex,
    elapsedMs,
    steps: steps.length ? steps : undefined,
    strategy,
    facing,
    figureMethod,
    detector: (res.debug || {}).detector || null,
    blended: figureMethod === 'charRepair' ? false : wantBlend,
    charRepairLog: (res.debug || {}).charRepairLog || null,
    modelCalls: usage.length,
    cost: usage.reduce((a, u) => a + (u.cost || 0), 0),
    cast: cast.map(c => ({
      name: c.name, age: c.age, depth: c.depth, position: c.position,
      pose: c.pose, flip: !!c.flip, cell: POSE_CELL[c.pose], color: c.color,
    })),
    // The measurements the stature work turns on — box as painted, head band,
    // what the figure was scaled to, and which rule decided it.
    placements: dbg.placements || null,
    bboxes: dbg.bboxes || null,
    plateHeadRatio: dbg.plateHeadRatio || null,
    statureModel: dbg.statureModel || null,
    promptUsed: dbg.populatedPlatePrompt || null,
    // The blend prompt as SENT (after any shrink), plus whether it was the
    // page's own generation prompt or the legacy brief — the difference decides
    // whether the model was even allowed to render occlusion.
    blendPrompt: dbg.blendPrompt || null,
    // The blend no longer sends the page prompt — it sends the census + the
    // metadata expressions (buildBlendEditPrompt). Labelling it 'page-prompt'
    // made Lab cards claim a prompt source that has not been used since
    // 2026-08-15.
    blendPromptSource: 'census+emotions',
    cleanBackgroundPrompt,
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
    // Rule experiment: appended to the scene-iteration template (per-call,
    // no global swap).
    sceneExtraRule: params.sceneExtraRule || null,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('iterate produced no image');

  const versionIndex = await saveTestVersion(ctx.storyId, 'scene', ctx.pageNumber, result.imageData, experimentId);
  return {
    imageType: 'scene', versionIndex, elapsedMs, modelId: result.modelId || null,
    promptUsed: result.imagePrompt || null,
    // Contract display (mandatory): the IMAGE prompt actually sent for this
    // result, plus the ORIGINAL page's image prompt so the card can show
    // both contracts (DEPICTS + EXACT POSES) side by side.
    imagePrompt: result.imagePrompt || null,
    baselinePrompt: ctx.scene.prompt || null,
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

  let latestEval = params.evaluation || storedEvalFromScene(ctx.scene);
  const t0 = Date.now();
  // freshEval: run the full evaluation NOW on the active image instead of
  // reusing the stored one — for decision-reliability runs ("does this page
  // reliably route to iterate?") the stored eval would make every repeat
  // identical and prove nothing.
  if (params.freshEval) {
    const { evaluateImageQuality } = require('./images');
    const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
    const fresh = await evaluateImageQuality(
      imageData, ctx.scene.sceneDescription, ctx.referencePhotos, 'scene',
      null, `testlab-exp${experimentId}-P${ctx.pageNumber}-decide`,
      ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null
    );
    if (!fresh) throw new Error('Fresh evaluation returned null');
    // Production stamps the consolidated plan onto the eval at scoring time;
    // decideRepairMethod's spec-conflict gate and iterate's conflict feedback
    // both read it. Without this the fresh-eval path under-reproduces the
    // pipeline (gate falls through to the score floors).
    try {
      const { consolidateEvaluation } = require('./feedbackConsolidator');
      const cons = await consolidateEvaluation({
        evalResult: fresh,
        entityIssues: [],
        sceneDescription: ctx.scene.sceneDescription || '',
        characters: storyData.characters || [],
        storyId: ctx.storyId,
        pageNumber: ctx.pageNumber,
        round: 0,
      });
      if (cons?.plan) fresh.consolidatedPlan = cons.plan;
    } catch (cErr) {
      log.warn(`[TESTLAB] fresh-eval consolidation failed (continuing): ${cErr.message}`);
    }
    latestEval = fresh;
  }
  const entityReport = params.entityReport || storyData.finalChecksReport?.entity || null;
  const decision = decideRepairMethod(ctx.pageNumber, latestEval, entityReport);

  const base = { decision: { method: decision.method, reason: decision.reason, charName: decision.charName || null } };
  // decideOnly: report the routing decision + the scores that drove it and
  // STOP — no repair executed, no image credits spent. For "is the routing
  // reliable on this page" experiments.
  if (params.decideOnly) {
    return {
      ...base,
      decideOnly: true,
      scores: {
        quality: latestEval.qualityScore ?? latestEval.scoreBreakdown?.visual?.score ?? null,
        semantic: latestEval.semanticScore ?? latestEval.scoreBreakdown?.semantic?.score ?? null,
        final: latestEval.score ?? latestEval.finalScore ?? null,
      },
      issuesSummary: latestEval.issuesSummary || null,
      elapsedMs: Date.now() - t0,
    };
  }
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
 * (gridBasedRepair's own contract; the former quality-retry wrapper is gone).
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
 * Figure-mask fetch with warm-up retries: the Python service lazy-loads
 * MobileSAM (~90s cold after a deploy) against a 30s HTTP timeout — the
 * first call after a restart reliably times out. Retry while it warms.
 */
// Fire-and-forget SAM warm-up: deploys restart the Python service and the
// first real mask call would eat the ~90s model load. Fired at stage start,
// in parallel with the 15-60s model generation, so SAM is warm by blend time.
let _maskWarmupFired = false;
function warmupFigureMask() {
  if (_maskWarmupFired) return;
  _maskWarmupFired = true;
  (async () => {
    try {
      const sharp = require('sharp');
      const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toBuffer();
      const { fetchFigureMaskPng } = require('./imageCompositing');
      await fetchFigureMaskPng(buf, [8, 8, 56, 56]);
      log.info('[TESTLAB] SAM warm-up complete');
    } catch { /* warm-up is best-effort */ }
  })();
}


/**
 * Head mask for face repairs: MobileSAM segments hair as a SEPARATE object
 * from the face even with hair point prompts — so union TWO prompts: the
 * face box (with face+hair points) and a dedicated hair box (upper part of
 * the head). Returns a binarized white-on-transparent PNG at cropW×cropH.
 */
async function fetchFaceHeadMask(buf, faceBox, cropW, cropH, opts = {}) {
  // Shared implementation lives in images.js (production's blended-face
  // whiteout uses the identical logic); the Test Lab injects its retry-aware
  // fetcher for post-deploy SAM cold starts. requireMobilesam: rembg's
  // whole-figure fallback produced garbage head whiteouts during a SAM
  // outage (rectangle over a church tower) — better to retry/fail loudly.
  // opts {rawFaceBox, boxScale, singleCall, onGeom} tune the SAM box + dots.
  const { fetchFaceHeadMaskPng } = require('./imageCompositing');
  return fetchFaceHeadMaskPng(buf, faceBox, cropW, cropH,
    (b, box, o) => fetchMaskWithRetry(b, box, 4, { ...(o || {}), requireMobilesam: true }),
    opts);
}



// Head mask via the whole figure (robust): SAM the figure from the body box,
// keep only the pixels inside the face box. No fragile face-region dots.
async function fetchFigureHeadMask(buf, bodyBoxInCrop, faceBoxInCrop, cropW, cropH, opts = {}) {
  const { fetchFigureHeadMaskPng } = require('./imageCompositing');
  return fetchFigureHeadMaskPng(buf, bodyBoxInCrop, faceBoxInCrop, cropW, cropH,
    (b, box, o) => fetchMaskWithRetry(b, box, 4, { ...(o || {}), requireMobilesam: true }),
    opts);
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
  if (params.replayOf && !params.reuseModelOutput) params = { ...(await resolveReplayParams(params.replayOf, ctx)), ...params };
  if (params.repairMode) warmupFigureMask();
  const { editWithQwen } = require('./runware');

  const charName = params.characterName;
  if (!charName) throw new Error('qwen_insert requires params.characterName');
  // params.referenceCharacter → identity-transfer test (see runCharRepairStage).
  const refName = params.referenceCharacter || charName;
  let ref = ctx.referencePhotos.find(p => (p.name || '').toLowerCase() === refName.toLowerCase());
  if (!ref && params.referenceCharacter) ref = await resolveSwapReference(ctx, refName, params.artStyleOverride);
  if (!ref) throw new Error(`No reference photo for "${refName}" on this page`);
  if (params.referenceCharacter) {
    log.info(`[TESTLAB] IDENTITY SWAP: inserting ${refName}'s reference into ${charName}'s region`);
  }

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
  let rawFigureBox = null; // tight unpadded face box (page-normalized) for SAM dots
  let bodyFigureBox = null; // body box (page-normalized) — SAM segments the whole figure
  if (params.crop && [params.crop.x, params.crop.y, params.crop.w, params.crop.h].every(v => typeof v === 'number')) {
    crop = {
      x: Math.round(params.crop.x * W), y: Math.round(params.crop.y * H),
      w: Math.round(params.crop.w * W), h: Math.round(params.crop.h * H),
    };
  } else {
    // Stored detection first, else fresh detection (resolveCharacterBox);
    // params.freshDetection forces a re-detect. Resolution errors (character
    // missing from an authoritative chained detection) propagate — a generic
    // "needs params.crop" would hide the real cause.
    if (params.freshDetection) ctx._skipStoredBox = true;
    let resolved;
    try {
      resolved = await resolveCharacterBox(ctx, baseUri, charName, { detection: params.detection || null });
    } finally {
      delete ctx._skipStoredBox;
    }
    // Face-only repair: the detection's faceBox becomes the target — the SAM
    // whiteout, union and paste all scope to the head, body/pose untouched.
    // A missing faceBox NEVER silently downgrades to a body repair (exp #68:
    // Lukas's whole body got whited out and Qwen re-imagined a studio shot).
    // Recovery first (zoom into the known body box, re-run face detection),
    // loud failure second.
    let faceMode = false;
    if (params.whiteoutTarget === 'face') {
      let fb = resolved?.faceBbox?.length === 4 ? resolved.faceBbox : null;
      if (!fb && resolved?.bbox?.length === 4) {
        const { recoverFaceBox } = require('./figureDetection');
        fb = await recoverFaceBox(baseUri, resolved.bbox, `testlab-P${ctx.pageNumber} ${charName}: `);
        if (fb) resolved = { ...resolved, faceBbox: fb, source: `${resolved.source} + face-recovered` };
      }
      if (!fb) throw new Error(`Face repair requested for "${charName}" but no face box — full-page detection AND body-crop zoom recovery both found no face. Not downgrading to a body repair; use whiteoutTarget "body" explicitly if that is intended.`);
      faceMode = true;
    }
    const box = faceMode ? resolved.faceBbox : resolved?.bbox; // [ymin,xmin,ymax,xmax] 0-1
    if (box?.length === 4) figureBox = box;
    // Tight (unpadded) face box for SAM dot placement — falls back to the
    // padded box when a recovered/older detection has no raw box.
    if (faceMode && resolved?.faceBboxRaw?.length === 4) rawFigureBox = resolved.faceBboxRaw;
    // Body box → SAM segments the whole figure, then we clip to the face box.
    if (faceMode && resolved?.bbox?.length === 4) bodyFigureBox = resolved.bbox;
    if (faceMode) params._faceMode = true;
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
  // Replay alignment gate: the reused model output was rendered for the SOURCE
  // crop. If the recomputed crop drifted (different detection, different cropPad),
  // pasting it back would be misaligned and the A/B meaningless — fail loudly.
  if (params._replayCrop) {
    const want = params._replayCrop;
    const off = Math.max(
      Math.abs(want.x * W - crop.x), Math.abs(want.y * H - crop.y),
      Math.abs(want.w * W - crop.w), Math.abs(want.h * H - crop.h),
    );
    if (off > 1) {
      throw new Error(`Replay crop drifted ${Math.round(off)}px from the source run (source ${JSON.stringify(want)}) — the reused model output would be misaligned. The source detection did not reproduce the same box.`);
    }
  }
  // Face mode: SQUARE crop centered on the head. A 1:1 crop is a valid Grok edit
  // aspect BY CONSTRUCTION, so there is NO mid-pipeline reshape — the earlier
  // aspect-snap mutated crop.w/h/x/y AFTER coordinates were derived from it and
  // desynced the paste (faces landed in empty sky, backgrounds re-imagined). One
  // square crop feeds detection mapping, SAM, boxInCrop, union, paste AND both
  // models. Side ≈ 3× the head, floor 384px, capped to the image.
  if (params._faceMode) {
    const fw = Math.round((figureBox[3] - figureBox[1]) * W);
    const fh = Math.round((figureBox[2] - figureBox[0]) * H);
    const cx0 = crop.x + crop.w / 2, cy0 = crop.y + crop.h / 2;
    const side = Math.min(W, H, Math.max(3 * fw, 3 * fh, 384));
    crop = {
      x: Math.max(0, Math.min(W - side, Math.round(cx0 - side / 2))),
      y: Math.max(0, Math.min(H - side, Math.round(cy0 - side / 2))),
      w: side, h: side,
    };
    params._grokAspect = '1:1';
  } else {
    crop.x = Math.max(0, Math.min(W - 64, crop.x));
    crop.y = Math.max(0, Math.min(H - 64, crop.y));
    crop.w = Math.min(W - crop.x, crop.w);
    crop.h = Math.min(H - crop.y, crop.h);
    // Body mode: EXPAND the crop to the nearest supported Grok aspect BEFORE
    // any coordinate derives from it — same by-construction rule as the 1:1
    // face crop above. The call below otherwise sends a fixed '3:4', and Grok
    // coerces the output to it: a tall figure crop (e.g. 0.385) came back
    // re-framed at 3:4, the figure moved, and every run died on the IoU gate
    // (exp #781: 51% / 34% / 5%). Widening (or heightening) toward the preset
    // keeps the original pixels — more scene context, no reshape.
    {
      const { closestGrokAspect } = require('./grokAspect');
      const target = closestGrokAspect(crop.w, crop.h);
      const [aw, ah] = target.split(':').map(Number);
      const targetRatio = aw / ah;
      const ratio = crop.w / crop.h;
      if (Math.abs(ratio - targetRatio) > 0.01) {
        if (ratio < targetRatio) {
          const wantW = Math.min(W, Math.round(crop.h * targetRatio));
          crop.x = Math.max(0, Math.min(W - wantW, Math.round(crop.x - (wantW - crop.w) / 2)));
          crop.w = wantW;
        } else {
          const wantH = Math.min(H, Math.round(crop.w / targetRatio));
          crop.y = Math.max(0, Math.min(H - wantH, Math.round(crop.y - (wantH - crop.h) / 2)));
          crop.h = wantH;
        }
      }
      params._grokAspect = target;
      log.debug(`[TESTLAB] body crop snapped to ${target}: ${crop.w}x${crop.h} at (${crop.x},${crop.y})`);
    }
  }

  const cropBuf = await sharp(baseBuf).extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h }).png().toBuffer(); // PNG: pristine original crop (model input + colour reference)

  // Repair mode: white-out the target figure's SILHOUETTE inside the crop
  // (same trick Grok blended repair uses) — turns "replace" into "paint into
  // the white gap", the operation Qwen actually performs faithfully. Plain
  // replace-wording made the model re-imagine the whole crop (exp #11/#12).
  let sentBuf = cropBuf;
  let whiteoutApplied = false;
  let oldMaskPng = null; // SAM silhouette of the ORIGINAL figure — reused for the blend
  let boxInCrop = null;
  if (params.repairMode && figureBox) {
    try {
      boxInCrop = [
        Math.max(0, Math.round(figureBox[1] * W) - crop.x),
        Math.max(0, Math.round(figureBox[0] * H) - crop.y),
        Math.min(crop.w, Math.round(figureBox[3] * W) - crop.x),
        Math.min(crop.h, Math.round(figureBox[2] * H) - crop.y),
      ];
      // Face mode: head mask = whole-figure SAM (body box) ∩ face box. Robust
      // where face-region dots over-segment (exp #123 Verena). The body box in
      // crop coords (clamped); if detection had no body box, fall back to the
      // whole crop as the SAM prompt (segment the dominant figure).
      const bodyBoxInCrop = (params._faceMode && bodyFigureBox?.length === 4) ? [
        Math.max(0, Math.round(bodyFigureBox[1] * W) - crop.x),
        Math.max(0, Math.round(bodyFigureBox[0] * H) - crop.y),
        Math.min(crop.w, Math.round(bodyFigureBox[3] * W) - crop.x),
        Math.min(crop.h, Math.round(bodyFigureBox[2] * H) - crop.y),
      ] : [0, 0, crop.w, crop.h];
      params._bodyBoxInCrop = bodyBoxInCrop;
      params._faceBoxInCrop = boxInCrop;
      // Hair box for the 'hairunion' clip variant — widen the face box left/
      // right (hair frames the head) and up (crown), same bottom.
      {
        const fbw = boxInCrop[2] - boxInCrop[0], fbh = boxInCrop[3] - boxInCrop[1];
        params._hairBoxInCrop = [
          Math.max(0, Math.round(boxInCrop[0] - fbw * 0.5)),
          Math.max(0, Math.round(boxInCrop[1] - fbh * 0.35)),
          Math.min(crop.w, Math.round(boxInCrop[2] + fbw * 0.5)),
          boxInCrop[3],
        ];
      }
      oldMaskPng = params._faceMode
        ? await fetchFigureHeadMask(cropBuf, bodyBoxInCrop, boxInCrop, crop.w, crop.h, { onGeom: (g) => { params._samGeom = g; }, onFullMask: (png) => { params._fullSamR1 = png; }, clipMode: params.headClipMode || 'bottom', hairBox: params._hairBoxInCrop })
        : await fetchMaskWithRetry(cropBuf, boxInCrop, 5, params._maskPoints || {});
      if (oldMaskPng) {
        // Rebuild the whiteout mask BINARIZED (no soft SAM edges = no
        // feathered-looking whiteout). BOTTOM-only clip (full width/top, cut at
        // the face-box bottom) so round-1 matches round-2 — both rounds share
        // the same clip. (Was face-box-clipped on all sides; now bottom-only.)
        const clipRect = params._faceMode ? [
          0, 0, crop.w, Math.min(crop.h, Math.round(figureBox[2] * H) - crop.y),
        ] : null;
        const a = await sharp(oldMaskPng).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
        const stride = Math.max(1, Math.round(a.length / (crop.w * crop.h)));
        const hard = Buffer.alloc(crop.w * crop.h);
        for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
          const i = y * crop.w + x;
          const inClip = !clipRect || (x >= clipRect[0] && x < clipRect[2] && y >= clipRect[1] && y < clipRect[3]);
          hard[i] = inClip && a[i * stride] > 128 ? 255 : 0;
        }
        // SAM sanity: a mask filling nearly the whole face region means SAM
        // returned the box, not a face silhouette (huge anime faces) — the
        // warning lands in the run log; the repaint gates still decide.
        let cov = 0;
        for (let i = 0; i < hard.length; i++) if (hard[i]) cov++;
        const clipArea = clipRect ? Math.max(1, (clipRect[2] - clipRect[0]) * (clipRect[3] - clipRect[1])) : hard.length;
        if (cov > 0.9 * clipArea) {
          log.warn(`[TESTLAB] head mask fills ${Math.round(100 * cov / clipArea)}% of the face region — SAM likely returned the whole box, not a face silhouette`);
        }
        oldMaskPng = await sharp(Buffer.alloc(crop.w * crop.h * 3, 255), { raw: { width: crop.w, height: crop.h, channels: 3 } })
          .ensureAlpha().joinChannel(Buffer.from(hard), { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
        sentBuf = await sharp(cropBuf).composite([{ input: oldMaskPng, left: 0, top: 0 }]).png().toBuffer(); // PNG: pristine model input
        whiteoutApplied = true;
      }
    } catch (err) {
      log.warn(`[TESTLAB] qwen repair whiteout unavailable (${err.message}) — falling back to replace wording`);
    }
  }
  // Face repair without a head whiteout is not a face repair — the replace-
  // wording fallback repaints whole figures. Fail loudly (SAM outage etc.).
  if (params._faceMode && params.repairMode && !whiteoutApplied) {
    throw new Error('Face repair needs the SAM head whiteout and the mask service did not deliver one (MobileSAM down?) — not degrading to a whole-figure replace. Retry when the analyzer is up.');
  }

  // Render at ~2x for detail; Runware dims must be multiples of 64 in [128,2048].
  const snap = v => Math.max(512, Math.min(2048, Math.round(v / 64) * 64)); // qwen rejects tiny dims
  const rw = snap(crop.w * 2), rh = snap(crop.h * 2);

  // Face mode: measured head-pose facts (text) replace the blurred pose
  // reference image — blur preserves silhouette, so the original hairstyle
  // leaked into repaints (two side pigtails instead of one ponytail). The
  // facts are read from the ORIGINAL face region by a cheap vision call;
  // fallback to the blurred image if the call fails.
  let poseText = null;
  if (params._faceMode && whiteoutApplied && figureBox) {
    try {
      const fp = 0.3;
      const fh = figureBox[2] - figureBox[0], fw = figureBox[3] - figureBox[1];
      const fx = Math.max(0, Math.round((figureBox[1] - fw * fp) * W));
      const fy = Math.max(0, Math.round((figureBox[0] - fh * fp) * H));
      const fww = Math.min(W - fx, Math.round(fw * (1 + 2 * fp) * W));
      const fhh = Math.min(H - fy, Math.round(fh * (1 + 2 * fp) * H));
      const faceCrop = await sharp(baseBuf).extract({ left: fx, top: fy, width: fww, height: fhh }).jpeg({ quality: 92 }).toBuffer();
      const { describeHeadPose } = require('./styleAnalysis');
      const p = await describeHeadPose(`data:image/jpeg;base64,${faceCrop.toString('base64')}`);
      poseText = [
        p.facing ? `facing ${p.facing}` : null,
        p.headTilt ? `head ${p.headTilt}` : null,
        p.gaze ? `gaze ${p.gaze}` : null,
        p.expression ? `expression: ${p.expression}` : null,
        p.mouth ? `mouth ${p.mouth}` : null,
      ].filter(Boolean).join('; ');
    } catch (err) {
      log.warn(`[TESTLAB] head-pose description failed (${err.message}) — falling back to blurred pose reference image`);
    }
  }

  // Face identity facts from the character description (hair style/color,
  // glasses, facial hair) — same information the Grok repair prompt carries.
  const faceFacts = (() => {
    if (!params._faceMode) return '';
    const desc = ctx.scene.bboxDetection?.characterDescriptions?.[charName];
    const rich = (typeof desc === 'string' ? desc : desc?.richDescription) || '';
    const t = rich.split(/Wearing:/i)[0].replace(/\s+/g, ' ').trim();
    return t ? ` The person: ${t.slice(0, 380)}` : '';
  })();

  const pose = params.pose || 'standing naturally, scale matching the scene perspective';
  // Name the story's actual art style — the generic "match the style" phrase
  // left Qwen free to flip the crop into a flat vector look (exp #69).
  const styleLine = (() => {
    try {
      const { ART_STYLES } = require('./storyHelpers');
      const raw = ART_STYLES[ctx.artStyle];
      const txt = typeof raw === 'string' ? raw : (raw && raw.default) || '';
      // Send the FULL style description — NOT just the first sentence. The old
      // first-sentence truncation dropped the crucial "photorealistic, real skin
      // texture, never stylized" guidance for photo styles AND left the word
      // "illustration", which pushed Qwen to a 3D render on photo scenes. Also
      // say "medium" so the model keeps photo-as-photo / watercolor-as-watercolor.
      return txt ? ` Match the exact visual style, medium and rendering of the first image: ${txt}` : ' Match the visual style and lighting of the first image.';
    } catch { return ' Match the visual style and lighting of the first image.'; }
  })();
  // WHOLE-FIGURE repairs get the same scene state the production spine feeds a
  // face repair (expression / pose / action / gaze / holding). Without it the
  // model invents a mood — exp #302 returned a startled, blushing child for a
  // scene whose metadata says smiling. FAITHFULNESS: faceRepair.buildActionContext.
  let bodyActionContext = '';
  if (params.repairMode && !params._faceMode) {
    try {
      const { buildActionContext } = require('./faceRepair');
      bodyActionContext = buildActionContext(ctx.scene.sceneDescription || ctx.scene.text || '', ref.name) || '';
    } catch { /* optional enrichment */ }
  }

  const prompt = promptOverride
    || (params.repairMode
      ? (whiteoutApplied
        ? (params._faceMode
          ? (() => {
              // "glasses" only for characters who wear them — the generic
              // enumeration made Qwen ADD glasses to glasses-free characters
              // (all-5 chain: Lukas and Franziska came back bespectacled).
              const desc = ctx.scene.bboxDetection?.characterDescriptions?.[charName];
              const rich = (typeof desc === 'string' ? desc : desc?.richDescription) || '';
              const hasGlasses = /\bglasses\b|\bbrille\b/i.test(rich);
              const glassesClause = hasGlasses ? ', including the same glasses' : '. The person does NOT wear glasses — do not add any';
              const poseClause = poseText
                ? ` HEAD POSE AND EXPRESSION (from the original scene; directions are from the viewer's perspective): ${poseText}. Paint the head in exactly this pose — never turn it toward the camera unless stated.`
                : ` HEAD POSE comes from the third image (blurred on purpose): copy only its head direction, gaze direction, tilt and facial expression — if the person was looking left, the painted face looks left; never copy its blurry detail.`;
              return `Paint the FACE and head of the person from the second image into the white area of the first image. The white area shows the head's exact position and scale. IDENTITY comes from the second image: exact same facial features, age, hair style and hair color${glassesClause}.${faceFacts}${poseClause} Keep everything outside the white area exactly unchanged: same body, same clothing, same pose, same background, same other people.${styleLine}`;
            })()
          : `Paint the person from the second image into the white silhouette area of the first image. The silhouette shows their exact position, pose and scale — fill it with that person in that pose. Paint the silhouette FULLY to its edge — no light rim, halo or unpainted border may remain inside it. The painted person must have the EXACT same face, age, hair color and clothing as shown in the second image${ref.clothingDescription ? ` (${ref.clothingDescription})` : ''}. Keep everything outside the white area exactly unchanged: same background, same other people, same objects, same colors, same framing.${bodyActionContext}${styleLine}`)
        : `Replace the person in the first image with the person from the second image: SAME position, SAME pose, SAME scale as the existing figure — only the face and appearance change to match the second image. Keep everything else in the first image exactly unchanged: same background, same other people, same objects, same colors, same framing.${styleLine}`)
      : `Insert the person from the second image into the scene from the first image: ${pose}. Keep the background of the scene exactly as it is — same objects, same colors, same framing. Add a soft contact shadow.${styleLine}`);

  const t0 = Date.now();
  const qwenRefs = [
    `data:image/jpeg;base64,${sentBuf.toString('base64')}`,
    ref.photoUrl,
  ];
  // Face mode fallback only: when the text pose facts are unavailable, the
  // third reference = the ORIGINAL crop, BLURRED. (With poseText the blurred
  // image is NOT sent — blur preserves silhouette and the wrong hairstyle
  // leaked from it into repaints.)
  let poseRefBuf = null;
  if (params._faceMode && whiteoutApplied && !poseText) {
    const sigma = Math.max(4, Math.round(Math.min(crop.w, crop.h) / 80));
    poseRefBuf = await sharp(cropBuf).blur(sigma).jpeg({ quality: 90 }).toBuffer();
    qwenRefs.push(`data:image/jpeg;base64,${poseRefBuf.toString('base64')}`);
  }
  // Model dispatch — the ONLY difference between the qwen and grok runs. Same
  // whiteout crop, same character ref, same prompt, same pose refs. Grok edit
  // coerces its output to the slot-0 (whiteout crop) aspect, so passing the crop
  // aspect keeps the output geometry identical to Qwen's rw:rh; everything
  // downstream (SAM re-detect, union blend, colour-aware correction) is shared.
  let result;
  if (params.reuseModelOutput != null) {
    // ISOLATION HARNESS: reuse a saved model output (a tl_step versionIndex or a
    // data URI) instead of calling the model, so blend variants run on the SAME
    // image — only the blend params differ, making an honest A/B. Requires the
    // SAME detection (→ identical crop/boxes) as the source run.
    let imageData = params.reuseModelOutput;
    if (typeof imageData === 'number' || /^\d+$/.test(String(imageData))) {
      const img = await loadTestImage(ctx.storyId, 'tl_step', ctx.pageNumber, Number(imageData));
      if (!img?.imageData) throw new Error(`reuseModelOutput: tl_step v${imageData} not found`);
      imageData = img.imageData;
    }
    result = { imageData, modelId: 'reused', cost: 0 };
  } else {
    result = params.backend === 'grok'
      ? await require('./grok').editWithGrok(prompt, qwenRefs, { aspectRatio: params._grokAspect || '3:4', resolution: '1k' })
      : await editWithQwen(prompt, qwenRefs, { width: rw, height: rh });
  }
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
  // What SAM was actually prompted with: the face box (yellow), the hair
  // sub-box (cyan, if used) and the two point dots (red = face, magenta =
  // hair) drawn on the crop — so a wrong box/dot is visible, not inferred.
  if (params._samGeom) {
    try {
      const g = params._samGeom;
      const rect = (b, stroke, dash) => b ? `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${stroke}" stroke-width="3"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` : '';
      // Figure-head approach: yellow = body box (SAM segments the figure here),
      // cyan = face box (the figure mask is clipped to this → head silhouette).
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.w}" height="${crop.h}">${rect(g.samBox, '#ffcc00')}${rect(g.faceClip, '#00e0ff', '6,4')}</svg>`;
      const viz = await sharp(cropBuf).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 95 }).toBuffer();
      await addStep('SAM prompt: body box (yellow=figure) ∩ face box (cyan=clip)', `data:image/jpeg;base64,${viz.toString('base64')}`);
    } catch (err) { log.warn(`[TESTLAB] SAM-geom viz failed: ${err.message}`); }
  }
  // FULL SAM (unclipped): the whole-figure silhouette before the head clip and
  // before the disconnected-island filter — so a stray fragment is visible here.
  if (params._fullSamR1) {
    try {
      const nn = crop.w * crop.h;
      const alpha = await sharp(params._fullSamR1).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
      const st = Math.max(1, Math.round(alpha.length / nn));
      const abin = Buffer.alloc(nn);
      for (let i = 0; i < nn; i++) abin[i] = alpha[i * st] > 128 ? 255 : 0;
      const figPng = await sharp(cropBuf).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().joinChannel(abin, { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
      const cut = await sharp({ create: { width: crop.w, height: crop.h, channels: 3, background: { r: 30, g: 30, b: 30 } } }).composite([{ input: figPng }]).jpeg({ quality: 95 }).toBuffer();
      await addStep('FULL SAM round 1 (unclipped figure — before head clip & island filter)', `data:image/jpeg;base64,${cut.toString('base64')}`);
    } catch (err) { log.warn(`[TESTLAB] full-SAM viz failed: ${err.message}`); }
  }
  await addStep('input 2: character reference', ref.photoUrl);
  if (poseRefBuf) await addStep('input 3: pose/gaze reference (blurred original)', `data:image/jpeg;base64,${poseRefBuf.toString('base64')}`);
  await addStep('model raw output', `data:image/jpeg;base64,${outBufEarly.toString('base64')}`);

  // ALWAYS-ON geometry overlay — every box and dot the SAM prompts could use,
  // drawn on BOTH the original crop and the redone (model output), so the full
  // geometry is always inspectable (even though the live head mask uses only
  // the body box ∩ face box). body=yellow, face=cyan, hair=magenta boxes;
  // face=red, hair=orange dots.
  if (params._faceMode && boxInCrop) {
    try {
      const bodyBox = params._bodyBoxInCrop || [0, 0, crop.w, crop.h];
      const faceBox = boxInCrop;
      const rb = (params._faceMode && rawFigureBox?.length === 4) ? [
        Math.max(0, Math.round(rawFigureBox[1] * W) - crop.x),
        Math.max(0, Math.round(rawFigureBox[0] * H) - crop.y),
        Math.min(crop.w, Math.round(rawFigureBox[3] * W) - crop.x),
        Math.min(crop.h, Math.round(rawFigureBox[2] * H) - crop.y),
      ] : faceBox;
      const hairBox = [faceBox[0], faceBox[1], faceBox[2], Math.round(faceBox[1] + (faceBox[3] - faceBox[1]) * 0.55)];
      const rh = rb[3] - rb[1], rcx = (rb[0] + rb[2]) / 2;
      const facePt = [Math.round(rcx), Math.round(rb[1] + rh * 0.45)];
      const hbcx = (hairBox[0] + hairBox[2]) / 2, hbcy = (hairBox[1] + hairBox[3]) / 2;
      const hairPt = [Math.round(hbcx + 0.25 * (facePt[0] - hbcx)), Math.round(hbcy + 0.25 * (facePt[1] - hbcy))];
      const rect = (b, st, d) => `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${st}" stroke-width="3"${d ? ` stroke-dasharray="${d}"` : ''}/>`;
      const dot = (p, f) => `<circle cx="${p[0]}" cy="${p[1]}" r="7" fill="${f}" stroke="white" stroke-width="2"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.w}" height="${crop.h}">`
        + rect(bodyBox, '#ffcc00') + rect(faceBox, '#00e0ff', '6,4') + rect(hairBox, '#ff44ff', '4,3')
        + dot(facePt, '#ff2222') + dot(hairPt, '#ff9900') + `</svg>`;
      const svgBuf = Buffer.from(svg);
      const orig = await sharp(cropBuf).composite([{ input: svgBuf }]).jpeg({ quality: 95 }).toBuffer();
      const redone = await sharp(outBufEarly).resize(crop.w, crop.h, { fit: 'fill' }).composite([{ input: svgBuf }]).jpeg({ quality: 95 }).toBuffer();
      await addStep('geometry — ORIGINAL (body=yellow, face=cyan, hair=magenta; dots: face=red, hair=orange)', `data:image/jpeg;base64,${orig.toString('base64')}`);
      await addStep('geometry — REDONE (same boxes/dots on the model output)', `data:image/jpeg;base64,${redone.toString('base64')}`);
    } catch (err) { log.warn(`[TESTLAB] geometry overlay failed: ${err.message}`); }
  }

  // STYLE GATE — Qwen occasionally flips the whole crop into a flat vector/
  // anime look (exp #69 Franziska); the geometry gates can't see that.
  // Binary same-style classification (checkStyleMatch): the numeric
  // similarity score was too lenient (flat repaint of watercolor still hit
  // 85/100). Gate unavailability (no Gemini key, transient error) is logged
  // and skipped — it must not turn a good repair into a failure.
  let styleMatch = null;
  if (params.repairMode) {
    try {
      const { checkStyleMatch } = require('./styleAnalysis');
      styleMatch = await checkStyleMatch(
        `data:image/jpeg;base64,${cropBuf.toString('base64')}`,
        `data:image/jpeg;base64,${outBufEarly.toString('base64')}`
      );
      if (styleMatch.sameStyle === false) {
        const err = new Error(`Style drift: model output is "${styleMatch.styleB}" but the scene is "${styleMatch.styleA}" — Redo.`);
        err.partialResult = { steps, crop: { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: crop.h / H }, characterName: ref.name, styleMatch };
        throw err;
      }
    } catch (err) {
      if (err.partialResult) throw err;
      log.warn(`[TESTLAB] style gate unavailable (${err.message}) — continuing without`);
    }
  }

  // Paste back. Default 'figure' mode: within the crop, keep ONLY the changed
  // blob (the inserted figure + its shadow, diff vs the original crop,
  // despeckled + dilated + feathered) — the model's incidental background
  // repaint inside the crop is discarded, so no rectangle seam. 'crop' mode
  // pastes the whole crop with a rectangular feather (debug/fallback).
  const back = await sharp(outBufEarly).resize(crop.w, crop.h, { fit: 'fill' }).png().toBuffer(); // PNG: no JPEG re-encode on the paste source
  let feathered;
  let colorInfo = null;

  // Round-2 figure re-detect on the FULL PAGE: composite the candidate crop back
  // into the page, run DINO 'person' on the whole image, pick the person box
  // that CONTAINS the target face, map it to crop coords. The full page has
  // scene context so DINO separates the figures cleanly — on the cutout it
  // grabbed a bigger neighbour (exp #129: the monk → IoU 0%). Falls back to the
  // copied original box if no person contains the face.
  params._r2BodyBox = null;
  if (params._faceMode && figureBox) {
    try {
      const { detectPersonBoxInCrop } = require('./figureDetection');
      const candFull = await sharp(baseBuf).composite([{ input: back, left: crop.x, top: crop.y }]).jpeg({ quality: 92 }).toBuffer();
      const facePagePx = [Math.round(figureBox[1] * W), Math.round(figureBox[0] * H), Math.round(figureBox[3] * W), Math.round(figureBox[2] * H)];
      const pageBox = await detectPersonBoxInCrop(candFull, facePagePx, `testlab-P${ctx.pageNumber} ${charName} (full-page): `);
      if (pageBox) {
        params._r2BodyBox = [
          Math.max(0, pageBox[0] - crop.x), Math.max(0, pageBox[1] - crop.y),
          Math.min(crop.w, pageBox[2] - crop.x), Math.min(crop.h, pageBox[3] - crop.y),
        ];
      }
    } catch (err) { log.warn(`[TESTLAB] round-2 full-page re-detect failed (${err.message}) — using copied box`); }
  }

  // Repair blend: the shared engine-agnostic SAM-union blend (samUnionBlend).
  // MANDATORY in repair mode — no silent diff-blob degradation (exp #30).
  if ((params.pasteMode || 'figure') === 'figure' && params.repairMode) {
    const failCtx = { steps, crop: { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: crop.h / H }, characterName: ref.name };
    if (!oldMaskPng || !boxInCrop) {
      const err = new Error('Repair blend needs the figure silhouette and the mask service did not deliver one (cold Python service?) — retry.');
      err.partialResult = failCtx;
      throw err;
    }
    const blend = await samUnionBlend({
      originalCropBuf: cropBuf,
      candidateCropBuf: back,
      boxInCrop,
      cropW: crop.w,
      cropH: crop.h,
      oldMaskPng,
      addStep,
      failCtx,
      maskPoints: params._maskPoints || null,
      // Round 2 (the RESULT) uses the FULL-PAGE re-detected figure box (computed
      // above) — aligned to the actual repainted figure — then SAM ∩ face box.
      // Falls back to the copied original box when the re-detect found nothing.
      maskFetcher: params._faceMode ? (async (buf) => {
        const fresh = params._r2BodyBox;
        const r2Body = fresh || params._bodyBoxInCrop || [0, 0, crop.w, crop.h];
        let g2 = null;
        const emitFullSam = async (png) => {
          try {
            const nn = crop.w * crop.h;
            const alpha = await sharp(png).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().extractChannel(3).raw().toBuffer();
            const st = Math.max(1, Math.round(alpha.length / nn));
            const abin = Buffer.alloc(nn);
            for (let i = 0; i < nn; i++) abin[i] = alpha[i * st] > 128 ? 255 : 0;
            const figPng = await sharp(buf).resize(crop.w, crop.h, { fit: 'fill' }).ensureAlpha().joinChannel(abin, { raw: { width: crop.w, height: crop.h, channels: 1 } }).png().toBuffer();
            const cut = await sharp({ create: { width: crop.w, height: crop.h, channels: 3, background: { r: 30, g: 30, b: 30 } } }).composite([{ input: figPng }]).jpeg({ quality: 95 }).toBuffer();
            await addStep('FULL SAM round 2 (unclipped figure — before head clip & island filter)', `data:image/jpeg;base64,${cut.toString('base64')}`);
          } catch { /* viz only */ }
        };
        const m = await fetchFigureHeadMask(buf, r2Body, boxInCrop, crop.w, crop.h, { onGeom: (g) => { g2 = g; }, onFullMask: emitFullSam, clipMode: params.headClipMode || 'bottom', hairBox: params._hairBoxInCrop });
        if (g2) {
          try {
            const rect = (b, st, d) => b ? `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}" fill="none" stroke="${st}" stroke-width="3"${d ? ` stroke-dasharray="${d}"` : ''}/>` : '';
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.w}" height="${crop.h}">${rect(g2.samBox, '#ffcc00')}${rect(g2.faceClip, '#00e0ff', '6,4')}</svg>`;
            const viz = await sharp(buf).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 95 }).toBuffer();
            await addStep(`SAM-2 input (result): ${fresh ? 'RE-DETECTED' : 'copied'} body box ∩ face box on the model output`, `data:image/jpeg;base64,${viz.toString('base64')}`);
          } catch { /* viz only */ }
        }
        return m;
      }) : null,
      // Face mode: union hard-clipped to the face region — body pixels never
      // enter the union no matter what round-2 SAM returns.
      // clipRect matches the head-mask clip mode so it doesn't re-cut the hair
      // the mask deliberately kept. 'bottom' → clip only at the face-box bottom
      // (full width/top, so side/top hair survives); else the face-box rect.
      clipRect: params._faceMode && figureBox ? (
        (params.headClipMode || 'bottom') === 'bottom'
          ? [0, 0, crop.w, Math.min(crop.h, Math.round(figureBox[2] * H) - crop.y)]
          : [
            Math.max(0, Math.round(figureBox[1] * W) - crop.x),
            Math.max(0, Math.round(figureBox[0] * H) - crop.y),
            Math.min(crop.w, Math.round(figureBox[3] * W) - crop.x),
            Math.min(crop.h, Math.round(figureBox[2] * H) - crop.y),
          ]
      ) : null,
      colorCorrect: params.colorCorrect !== false,
      featherPx: params.featherPx,
      erodeFeather: params.erodeFeather,
      featherMode: params.featherMode,
      padMode: params.padMode,
      // FIGURE/BODY repair defaults to the correct construction: full opacity over
      // old ∪ new+pad, content-substituted feather band, outward ramp — the old
      // figure cannot show through and the model cannot paint outside the region.
      // Face mode keeps 'padded-union' (masks nearly coincide; its default is
      // calibrated separately). Override with params.blendShape to A/B.
      blendShape: params.blendShape != null ? params.blendShape : (params._faceMode ? 'padded-union' : 'figure-exact'),
      // Diagnostic raw paste: model content over the union, hard, no colour work.
      rawPaste: params.rawPaste === true,
      colorBorderRefine: params.colorBorderRefine,
      // FIGURE/BODY repair (not face mode) → protect background at the border, let
      // the redrawn figure colour drift. Override with params.bodyColorMode to A/B.
      bodyColorMode: params.bodyColorMode != null ? params.bodyColorMode : !params._faceMode,
      bgBorderMatch: params.bgBorderMatch != null ? params.bgBorderMatch : true,
      // Only colour-match the garment (materials continuing outside the paste); leave
      // Grok's skin/hair. Override with params.garmentOnly=false to match all materials.
      garmentOnly: params.garmentOnly != null ? params.garmentOnly : true,
    });
    feathered = blend.feathered;
    colorInfo = blend.colorInfo || null;
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
    const dense = await maskBlurThreshold(bin, crop.w, crop.h, 4, 96);          // despeckle
    const dilated = await maskBlurThreshold(dense, crop.w, crop.h, 5, 20);      // dilate
    const alpha = await sharp(dilated, raw1).blur(4).raw().toBuffer();          // feather
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
  const composed = await sharp(baseBuf).composite([{ input: feathered, left: crop.x, top: crop.y }]).png().toBuffer(); // PNG: lossless final — no JPEG artifacts on the paste or the page

  const versionIndex = await saveTestVersion(
    ctx.storyId, 'scene', ctx.pageNumber,
    `data:image/png;base64,${composed.toString('base64')}`, experimentId
  );
  return {
    imageType: 'scene', versionIndex, characterName: ref.name, elapsedMs,
    modelId: result.modelId, promptUsed: prompt,
    crop: { x: crop.x / W, y: crop.y / H, w: crop.w / W, h: crop.h / H },
    blendRule: params.repairMode ? BLEND_RULE_VERSION : undefined,
    styleMatch: styleMatch || undefined,
    headPose: poseText || undefined,
    colorCorrection: colorInfo || undefined,
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
// Materialize a styledAvatarGeneration image slot to a data URI. Slots come in
// three shapes: a bare string (data URI or R2 URL — e.g. passes.pass1.imageData),
// {imageData} (older inline entries), or {imageUrl} (post-R2 input slots).
async function resolveAvatarSlotBytes(slot) {
  if (!slot) return null;
  const fetchUrl = (url) => {
    const { imgBytesAsync } = require('../services/database');
    return imgBytesAsync({ image_url: url });
  };
  if (typeof slot === 'string') {
    if (slot.startsWith('data:')) return slot;
    if (/^https?:\/\//.test(slot)) return fetchUrl(slot);
    return null;
  }
  if (slot.imageData) return slot.imageData;
  if (slot.imageUrl) return fetchUrl(slot.imageUrl);
  return null;
}

/**
 * Avatar sheet eval. Two source modes:
 *   • STORED production sheet (what the story actually shipped): pass params.pass
 *     — 1 = realistic anchor (styledAvatarGeneration[].inputs.standardAvatar),
 *       2 = styled sheet (styledAvatarGeneration[].output). Disambiguate with
 *       params.entryIndex when a character has several entries; default = latest.
 *   • LAB test version: pass params.versionIndex (a tl_avatar), as before.
 * params.model A/Bs the eval model (any Gemini id; default gemini-2.5-flash);
 * promptOverride A/Bs the eval prompt text. Both are eval-only — no image is
 * generated, so this never spends generation credits.
 */
async function runAvatarEvalStage(target, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { _internal, resolveFacePhoto } = require('./character2x4Sheet');
  const { character, costume } = await loadCharacterContext(target.storyId, target.character);
  const model = params.model || 'gemini-2.5-flash';
  const t0 = Date.now();

  const versionIndex = params.versionIndex ?? target.versionIndex;
  if (versionIndex != null) {
    // Lab test-version path (a sheet generated by avatar_realistic/avatar_style).
    const sheet = await loadTestImage(target.storyId, 'tl_avatar', null, versionIndex);
    if (!sheet?.imageData) throw new Error(`tl_avatar v${versionIndex} not found`);
    const facePhoto = await resolveFacePhoto(character);
    let evalResult;
    if (params.styled) {
      const realisticVersionIndex = params.realisticVersionIndex;
      if (realisticVersionIndex == null) throw new Error('styled avatar_eval requires realisticVersionIndex');
      const anchor = await loadTestImage(target.storyId, 'tl_avatar', null, realisticVersionIndex);
      if (!anchor?.imageData) throw new Error(`realistic anchor v${realisticVersionIndex} not found`);
      evalResult = await _internal.evaluateStyledSheetWithGemini(
        facePhoto, anchor.imageData, sheet.imageData,
        params.artStyle || target.artStyle || 'pixar', process.env.GEMINI_API_KEY,
        null /* usageTracker */, params.declaredAge ?? null,
        { model, promptOverride }
      );
    } else {
      evalResult = await _internal.evaluateSheetWithGemini(
        sheet.imageData, costume.description || 'standard outfit',
        process.env.GEMINI_API_KEY, facePhoto, null,
        { characterDescription: character.description || '', model, promptOverride }
      );
    }
    return { character: character.name, source: 'testVersion', versionIndex, styled: !!params.styled, model, elapsedMs: Date.now() - t0, report: evalResult };
  }

  // Stored production sheet path — pick the sheet by pass from the story's
  // avatar-generation audit. pass/entryIndex may be set PER TARGET (sheet-set
  // runs mix pass-1 and pass-2 members) or globally on params.
  const pass = Number(target.pass ?? params.pass);
  if (pass !== 1 && pass !== 2) {
    throw new Error('avatar_eval needs pass (1=realistic anchor, 2=styled sheet) on the target or params, or params.versionIndex (a lab tl_avatar)');
  }
  const entryIndexParam = target.entryIndex ?? params.entryIndex;
  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const entries = storyData.styledAvatarGeneration || [];
  const wanted = (target.character || '').toLowerCase();
  const matches = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (e.characterName || '').toLowerCase() === wanted);
  if (!matches.length) {
    const names = [...new Set(entries.map(e => e.characterName).filter(Boolean))];
    throw new Error(`No styledAvatarGeneration entry for "${target.character}" (have: ${names.join(', ') || 'none'})`);
  }
  const chosen = entryIndexParam != null
    ? matches.find(m => m.i === Number(entryIndexParam))
    : matches[matches.length - 1];
  if (!chosen) throw new Error(`entryIndex ${params.entryIndex} not found for "${target.character}"`);
  const entry = chosen.e;
  const artStyle = params.artStyle || entry.artStyle || 'watercolor';
  const facePhoto = (await resolveAvatarSlotBytes(entry.inputs?.facePhoto)) || (await resolveFacePhoto(character));
  // The evaluators score the 2×4 SHEETS, not the 2×2 standard-avatar body ref.
  // pass 1 = the realistic 2×4 anchor (passes.pass1.imageData / realisticImageData);
  // pass 2 = the styled 2×4 sheet (passes.pass2.imageData, falling back to output).
  const realistic = (await resolveAvatarSlotBytes(entry.passes?.pass1?.imageData))
    || (await resolveAvatarSlotBytes(entry.realisticImageData));

  // Resolve which sheet is scored (and shown) for this pass.
  let slot, sheetForDisplay;
  let realisticVersionIndex; // pass-2 also shows the realistic anchor as baseline
  if (pass === 1) {
    if (!realistic) throw new Error('pass-1 realistic 2×4 sheet (passes.pass1.imageData) not stored on this entry');
    slot = 'passes.pass1.imageData';
    sheetForDisplay = realistic;
  } else {
    const styled = (await resolveAvatarSlotBytes(entry.passes?.pass2?.imageData))
      || (await resolveAvatarSlotBytes(entry.output));
    if (!styled) throw new Error('pass-2 styled 2×4 sheet (passes.pass2.imageData / output) not stored on this entry');
    if (!realistic) throw new Error('pass-2 eval needs the realistic anchor (passes.pass1.imageData) — not stored on this entry');
    slot = 'passes.pass2.imageData';
    sheetForDisplay = styled;
    // Save the realistic anchor too so the pass-2 card shows both side by side.
    realisticVersionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, realistic, experimentId);
  }

  // The lab calls the SINGLE-SOURCE evaluator (evaluateAvatarSheet) — the exact
  // function production calls — so a lab verdict IS the production verdict. There
  // is no lab-only eval path: pass keys the behaviour (1 → split head/body/
  // identity; 2 → holistic styled), identical to generateCharacter2x4Sheet /
  // runStyleTransferPass. Divergence is only ever a recorded promptOverride/model.
  let evalResult;
  let splitSteps;
  let splitPromptUsed;
  let splitPrompts;
  if (pass === 1) {
    const standardAvatar = await resolveAvatarSlotBytes(entry.inputs?.standardAvatar);
    const { split } = await _internal.evaluateAvatarSheet(sheetForDisplay, {
      pass: 1, facePhoto, standardAvatar,
      costumeDescription: costume.description || 'standard outfit',
      model, promptOverride,
    });
    const { heads, bodies, identity } = split;
    splitPromptUsed = split.promptUsed;
    splitPrompts = split.prompts;
    evalResult = { split: true, splitY: split.splitY, model, heads, bodies, identity, finalScore: split.verdict.finalScore, valid: split.verdict.valid };
    // Save the anchors AND the two crops as steps so the lab shows exactly what
    // the judge saw: face photo + avatar faces (identity anchors) + the two rows.
    const [vTop, vBottom, vPhoto, vAvatar] = await Promise.all([
      saveTestVersion(target.storyId, 'tl_step', null, split.topHeads, experimentId, heads?.finalScore ?? null),
      saveTestVersion(target.storyId, 'tl_step', null, split.bottomBody, experimentId, bodies?.finalScore ?? null),
      facePhoto ? saveTestVersion(target.storyId, 'tl_step', null, facePhoto, experimentId) : Promise.resolve(null),
      split.avatarFaces ? saveTestVersion(target.storyId, 'tl_step', null, split.avatarFaces, experimentId) : Promise.resolve(null),
    ]);
    splitSteps = [
      ...(vPhoto != null ? [{ label: 'Anchor · face photo', imageType: 'tl_step', versionIndex: vPhoto }] : []),
      ...(vAvatar != null ? [{ label: 'Anchor · avatar faces (top of 2×2)', imageType: 'tl_step', versionIndex: vAvatar }] : []),
      { label: `Top row · heads (final ${heads?.finalScore ?? '?'})`, imageType: 'tl_step', versionIndex: vTop },
      { label: `Bottom row · bodies (final ${bodies?.finalScore ?? '?'})`, imageType: 'tl_step', versionIndex: vBottom },
    ];
  } else {
    ({ verdict: evalResult } = await _internal.evaluateAvatarSheet(sheetForDisplay, {
      pass: 2, facePhoto, realisticSheet: realistic, artStyle,
      declaredAge: params.declaredAge ?? null, model, promptOverride,
    }));
  }

  // Persist the scored sheet as a test version so the lab renders it next to the
  // eval report (ResultCard shows any result with imageType + versionIndex).
  const scoreForBadge = evalResult?.finalScore != null ? Math.round(evalResult.finalScore) : null;
  const evalVersionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, sheetForDisplay, experimentId, scoreForBadge);
  return {
    character: character.name, source: 'storedSheet', pass, styled: pass === 2, model, artStyle,
    imageType: 'tl_avatar', versionIndex: evalVersionIndex,
    ...(realisticVersionIndex != null ? { realisticVersionIndex } : {}),
    ...(splitSteps ? { steps: splitSteps } : {}),
    ...(splitPromptUsed ? { promptUsed: splitPromptUsed } : {}),
    ...(splitPrompts ? { prompts: splitPrompts } : {}),
    sheetSource: { array: 'styledAvatarGeneration', entryIndex: chosen.i, slot },
    elapsedMs: Date.now() - t0, report: evalResult,
  };
}

/**
 * EMPTY-SCENE ADHERENCE — measures what the empty-scene stage actually buys us.
 *
 * Per page, three questions (owner, 2026-08-11):
 *   1. background_correspondence 0-10 — how much of the empty scene's
 *      composition/background survives in the FINAL active image (0 = the
 *      empty scene was useless, final is a different place; 10 = same scene
 *      with figures added).
 *   2. action_space 0-10 — does the EMPTY scene leave usable ground/space for
 *      the story action (figures), or is it composition-blocked (e.g. the
 *      subject fills the frame, no stage for actors)?
 *   3. landmark_fidelity 0-10|null — when a landmark reference photo exists:
 *      is the landmark recognizable in the final image (structure/geometry;
 *      style elements added onto it are fine)?
 * Plus a $0 objective proxy: 32×32 grayscale correlation empty↔final.
 */
async function runEmptySceneAdherenceStage(ctx, { experimentId }) {
  const sharp = require('sharp');
  const r2Lib = require('./r2');
  const emptyScene = await loadEmptyScene(ctx.storyId, ctx.pageNumber);
  if (!emptyScene) throw new Error('no empty scene stored for this page');
  const finalImage = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const landmark = (ctx.landmarkPhotos || [])[0] || null;

  const toBuf = (d) => Buffer.from(r2Lib.stripDataUriPrefix(d), 'base64');
  // Objective proxy: normalized cross-correlation of 32×32 grayscale.
  const gray = async (d) => Array.from(await sharp(toBuf(d)).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer());
  const [a, b] = await Promise.all([gray(emptyScene), gray(finalImage)]);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const pixelCorrelation = +(num / Math.sqrt(Math.max(1, da * db))).toFixed(3);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const parts = [
    { text: 'IMAGE 1 — empty scene (background generated before the figures):' },
    { inlineData: { mimeType: 'image/jpeg', data: toBuf(emptyScene).toString('base64') } },
    { text: 'IMAGE 2 — final page (the shipped illustration):' },
    { inlineData: { mimeType: 'image/jpeg', data: toBuf(finalImage).toString('base64') } },
  ];
  if (landmark?.photoData) {
    parts.push({ text: `IMAGE 3 — reference photo of the real landmark (${landmark.name || 'landmark'}):` });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: toBuf(landmark.photoData).toString('base64') } });
  }
  parts.push({ text: `Answer JSON only:
{"background_correspondence": 0-10, "action_space": 0-10, "landmark_fidelity": ${landmark ? '0-10' : 'null'}, "notes": "<one sentence per score>"}
- background_correspondence: how much of IMAGE 1's setting/composition survives in IMAGE 2 (0 = different place entirely, IMAGE 1 was useless; 10 = same scene with figures added).
- action_space: judge IMAGE 1 alone — does it leave usable ground/space where story figures could act, or is it blocked (subject fills the frame, no stage)?
- landmark_fidelity${landmark ? ': is the landmark from IMAGE 3 structurally recognizable in IMAGE 2? Style elements or art-style rendering added onto it do NOT reduce this score — judge geometry/identity only.' : ': null (no landmark input).'}` });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } } }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Gemini judge HTTP ${res.status}`);
  const j = await res.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  let judged;
  try { judged = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text); } catch { throw new Error(`judge answer not JSON: ${text.slice(0, 120)}`); }

  return {
    hadLandmarkInput: !!landmark,
    landmarkName: landmark?.name || null,
    pixelCorrelation,
    ...judged,
    usage: j.usageMetadata ? { input_tokens: j.usageMetadata.promptTokenCount, output_tokens: j.usageMetadata.candidatesTokenCount } : null,
  };
}

/**
 * INVENTORY A/B — can ONE blind prompt deliver what TWO deliver?
 *
 * Two blind describers run on every page today: P1 (`image-visual-inventory`,
 * JSON, read by code) and three-stage Stage 1 (`image-vision-inventory`, prose,
 * read by the compliance judge). They were never a designed pair — P1 is the
 * surviving half of a two-pass eval deleted in Feb 2026, and the three-stage
 * rebuilt the same shape seven weeks later beside it.
 *
 * The open question is whether merging them costs accuracy: a prompt asking for
 * forty things may fill fewer of them than two prompts asking for twenty. This
 * stage measures that directly — same image, three arms, and a per-FIELD
 * delivery rate rather than a "did it answer" pass/fail. Repeats are the point,
 * not noise: eval judges are not deterministic even at temperature 0
 * (docs/decisions.md, experiments #403/#404), so one run per arm proves nothing.
 */

/** Every field the union of the two prompts is supposed to produce. */
const FIGURE_FIELDS = [
  ['label', /label|^\s*-\s*Label/im],
  ['zone', /zone/i],
  ['facing', /facing/i],
  ['hair', /hair(?!\s*:?\s*style\b)/i],
  ['clothing', /clothing|garment/i],
  ['eyewear', /eyewear|glasses/i],
  ['headwear', /headwear/i],
  ['facial_hair', /facial[_ ]hair/i],
  ['worn_carried', /worn|carried/i],
  ['action', /action|doing/i],
  ['items_held', /items?[_ ]held|in each hand|hold/i],
  ['expression', /expression/i],
  ['age_group', /age[_ ]group|age\b/i],
  ['standing_surface', /standing[_ ]surface|standing on|surface/i],
  ['body_bbox', /body[_ ]bbox/i],
  ['face_bbox', /face[_ ]bbox/i],
  ['height_fraction', /height[_ ]fraction/i],
  ['same_ground_plane', /same[_ ]ground[_ ]plane/i],
  ['clipped_by', /clipped[_ ]by/i],
  ['height_rank', /height[_ ]rank|shortest|tallest/i],
];

const DOC_FIELDS = [
  ['interactions', /interaction/i],
  ['objects', /object/i],
  ['setting', /setting/i],
  ['lettering', /letter/i],
  ['rendering', /rendering|physics/i],
  ['scene_summary', /scene[_ ]summary/i],
  ['main_action', /main[_ ]action/i],
];

/** Did this JSON figure actually answer the field? An empty string has not. */
function jsonHasField(fig, key) {
  const v = fig?.[key];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Prose arms are scored per figure BLOCK, so a field named once does not count for five figures. */
function proseFigureBlocks(text) {
  const all = String(text || '').split(/\r?\n/);
  // Objects, setting and lettering are bulleted in the same style as figures, so
  // counting the whole document inflated the figure count (13 "figures" on a
  // page with 8) and unfairly depressed the per-figure delivery rate. Take only
  // the human-figure section.
  const start = all.findIndex(l => /human figures?/i.test(l) && l.trim().length < 60);
  const rest = start >= 0 ? all.slice(start + 1) : all;
  const stop = rest.findIndex(l => /^[\s*#]*(notable\s+)?(object|animal|vehicle|setting|lettering|physics)/i.test(l) && l.trim().length < 70);
  const lines = stop >= 0 ? rest.slice(0, stop) : rest;
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    // A figure header is a NUMBERED or BULLETED line whose content is bold —
    // `1.  **The adult in the orange vest**`, `*   **Figure 2 (left child)**`.
    // Matching only on words like "figure"/"child" missed every one of them,
    // because the label rule made the headers descriptive instead.
    if (/^\s{0,4}(?:\d+[.)]|[-*•])\s+\*\*.+/.test(line)
        || /^\s{0,4}\*\*\s*figure\s*\d/i.test(line)) {
      cur = { header: line.trim(), body: '' };
      blocks.push(cur);
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  return blocks;
}

function scoreArm(armKey, parsed, rawText) {
  const isJson = parsed && Array.isArray(parsed.figures);
  const figureCount = isJson ? parsed.figures.length : proseFigureBlocks(rawText).length;
  const perField = {};

  if (isJson) {
    for (const [key] of FIGURE_FIELDS) {
      const n = parsed.figures.filter(f => jsonHasField(f, key)).length;
      perField[key] = figureCount ? n / figureCount : 0;
    }
    for (const [key] of DOC_FIELDS) {
      const v = parsed[key] ?? parsed[key === 'objects' ? 'object_matches' : key];
      perField[key] = (v == null) ? 0 : (Array.isArray(v) ? (v.length ? 1 : 0.5) : 1);
    }
  } else {
    const blocks = proseFigureBlocks(rawText);
    for (const [key, re] of FIGURE_FIELDS) {
      const n = blocks.filter(b => re.test(b.body)).length;
      perField[key] = blocks.length ? n / blocks.length : 0;
    }
    const tail = String(rawText || '');
    for (const [key, re] of DOC_FIELDS) perField[key] = re.test(tail) ? 1 : 0;
  }

  const all = [...FIGURE_FIELDS, ...DOC_FIELDS].map(([k]) => k);
  const delivered = all.filter(k => (perField[k] || 0) >= 0.999).length;
  const partial = all.filter(k => (perField[k] || 0) > 0 && (perField[k] || 0) < 0.999).length;

  return {
    arm: armKey,
    figureCount,
    fieldsFullyDelivered: delivered,
    fieldsPartial: partial,
    fieldsMissing: all.length - delivered - partial,
    fieldTotal: all.length,
    perField,
  };
}

/**
 * @param params.repeats  runs per arm (default 2 — a single run cannot separate
 *                        a prompt problem from run-to-run judge variance)
 */
async function runInventoryAbStage(ctx, { experimentId, params = {} }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { runVisualInventory } = require('./evalPipeline');
  const { MODEL_DEFAULTS } = require('../config/models');
  const r2 = require('./r2');

  const repeats = Math.max(1, Math.min(5, params.repeats || 2));
  const modelId = params.model || MODEL_DEFAULTS.qualityEval;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const imageDataUri = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  if (!imageDataUri) throw new Error(`No image for page ${ctx.pageNumber}`);
  // The image ALONE — every arm here is a blind describer.
  const parts = [{
    inline_data: {
      mime_type: imageDataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg',
      data: r2.stripDataUriPrefix(imageDataUri),
    },
  }];

  // EVERY arm asks for raw text. runVisualInventory's parsed return keeps only
  // {figures, objectMatches, rendering} — scoring that would have marked the
  // unified prompt as "dropping" interactions, setting and lettering when the
  // model had emitted all three and the plumbing discarded them.
  const ARMS = [
    { key: 'split_p1', label: 'P1 (image-visual-inventory)', template: PROMPT_TEMPLATES.imageVisualInventory, json: true },
    { key: 'split_stage1', label: 'Stage 1 (image-vision-inventory)', template: PROMPT_TEMPLATES.imageVisionInventory, json: false },
    { key: 'unified', label: 'Unified (image-inventory-unified)', template: params.unifiedPrompt || PROMPT_TEMPLATES.imageInventoryUnified, json: true },
  ];

  const t0 = Date.now();
  const runs = [];
  for (const arm of ARMS) {
    if (!arm.template) throw new Error(`Template missing for arm ${arm.key}`);
    for (let i = 0; i < repeats; i++) {
      const label = `testlab-exp${experimentId}-P${ctx.pageNumber}-${arm.key}-r${i + 1}`;
      let res = null;
      try {
        res = await runVisualInventory(parts, modelId, apiKey, label, {
          promptOverride: arm.template,
          raw: true,
        });
      } catch (e) {
        log.warn(`[INVENTORY-AB] ${label} failed: ${e.message}`);
      }
      if (!res) {
        runs.push({ arm: arm.key, armLabel: arm.label, repeat: i + 1, failed: true });
        continue;
      }
      const rawText = res.rawText;
      let parsed = null;
      if (arm.json) {
        try {
          parsed = require('./storyHelpers').extractJsonFromText(rawText);
        } catch (e) {
          log.warn(`[INVENTORY-AB] ${label} JSON parse failed: ${e.message}`);
        }
      }
      runs.push({
        arm: arm.key,
        armLabel: arm.label,
        repeat: i + 1,
        ...scoreArm(arm.key, parsed, rawText),
        inputTokens: res.inputTokens || 0,
        outputTokens: res.outputTokens || 0,
        jsonParsed: arm.json ? parsed != null : null,
        output: rawText,
      });
    }
  }

  // Per-arm means, and the split baseline: a field counts as delivered by the
  // SPLIT pair if either of its two prompts delivered it. That is the number the
  // unified arm actually has to beat.
  const byArm = {};
  for (const arm of ARMS) {
    const rs = runs.filter(r => r.arm === arm.key && !r.failed);
    if (!rs.length) { byArm[arm.key] = null; continue; }
    const mean = k => rs.reduce((s, r) => s + (r.perField[k] || 0), 0) / rs.length;
    const perField = {};
    for (const [k] of [...FIGURE_FIELDS, ...DOC_FIELDS]) perField[k] = mean(k);
    byArm[arm.key] = {
      label: arm.label,
      runs: rs.length,
      figureCounts: rs.map(r => r.figureCount),
      meanFieldsDelivered: rs.reduce((s, r) => s + r.fieldsFullyDelivered, 0) / rs.length,
      outputTokens: Math.round(rs.reduce((s, r) => s + r.outputTokens, 0) / rs.length),
      perField,
    };
  }

  const allKeys = [...FIGURE_FIELDS, ...DOC_FIELDS].map(([k]) => k);
  const splitBest = {};
  for (const k of allKeys) {
    splitBest[k] = Math.max(byArm.split_p1?.perField?.[k] ?? 0, byArm.split_stage1?.perField?.[k] ?? 0);
  }
  const uni = byArm.unified?.perField || {};
  const regressions = allKeys.filter(k => (splitBest[k] - (uni[k] ?? 0)) > 0.25);
  const gains = allKeys.filter(k => ((uni[k] ?? 0) - splitBest[k]) > 0.25);

  return {
    elapsedMs: Date.now() - t0,
    page: ctx.pageNumber,
    model: modelId,
    repeats,
    byArm,
    comparison: {
      splitBestPerField: splitBest,
      unifiedPerField: uni,
      // Fields the split pair delivers and the unified prompt drops — the
      // attention-splitting hypothesis, made countable.
      regressions,
      gains,
      verdict: regressions.length === 0
        ? 'unified matches or beats the split pair on every field'
        : `unified drops ${regressions.length} field(s) the split pair delivers: ${regressions.join(', ')}`,
    },
    runs,
  };
}

const STAGE_RUNNERS = {
  empty_scene_adherence: runEmptySceneAdherenceStage,
  image: runImageStage,
  empty_scene: runEmptySceneStage,
  quality_eval: runQualityEvalStage,
  eval_variance: runEvalVarianceStage,
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
  scene_composite: runSceneCompositeStage,
  scene_description: runSceneDescriptionStage,
  rewrite_blocked: runRewriteBlockedStage,
  repair_verify: runRepairVerifyStage,
  qwen_insert: runQwenInsertStage,
  garment_colour_fix: runGarmentColourFixStage,
  inventory_ab: runInventoryAbStage,
};

// Story-level stages: target {storyId} (+ coverType for cover). No page context.

/**
 * SCENE REVIEW REPLAY — the reviewer, and only the reviewer, on frozen input.
 *
 * Production runs the scene review once, inside a generation, over briefs that
 * were just written. That makes a reviewer-prompt change unmeasurable: rerun the
 * pipeline and the briefs differ, so any change in behaviour could be the new
 * briefs rather than the new prompt.
 *
 * This replays the review against a story's STORED briefs. The clothing check is
 * deterministic, so it regenerates byte-identical findings, and the only variable
 * is the prompt (or the model). Built for the question left open by
 * job_1786235099497_ytd5c7eek: three correct faults were handed to deepseek and
 * it rewrote nothing — does a mandatory framing change that, or does the fix path
 * have to stop being a request?
 *
 * params.reviewModel   — override the reviewer (comma-separated fans out)
 * promptOverride       — full replacement template, the usual Lab A/B lever
 */
// Parse a persisted "--- Page N ---\n<body>" artifact_text back into ordered
// page blocks, so a stored round's text can be fed as the next round's input
// (scene briefs and story text both persist in this shape — see the scoreOutput
// blocks below). This is what makes "＋ next round" chain: round N+1's input is
// round N's frozen output, not the story's original artifact.
function parsePageBlocks(text) {
  const out = [];
  const re = /---\s*Page\s+(\d+)\s*---\s*\n?([\s\S]*?)(?=\n---\s*Page\s+\d+\s*---|$)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push({ pageNumber: parseInt(m[1], 10), text: m[2].trim() });
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

async function runSceneReviewReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneReviewPrompt, parseRefinedText, extractSceneMetadata, parseBeats } = require('./storyHelpers');
  const { checkScenes, renderFindingsBlock } = require('./clothingCheck');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  // BRANCH MODE — "＋ next round": review a SELECTED round's stored briefs
  // (params.fromText) instead of the story's original ones, and persist as the
  // next round. Everything downstream (findings, prompt, review, score) is
  // unchanged; only the input briefs and the persisted round/label differ.
  const branchScenes = params.fromText
    ? parsePageBlocks(params.fromText).map(b => ({ pageNumber: b.pageNumber, brief: b.text }))
    : null;
  if (params.fromText && (!branchScenes || !branchScenes.length)) throw new Error('fromText has no parseable scene briefs');
  const fromRound = params.fromText ? (parseInt(params.fromRound, 10) || 1) : null;
  const scenes = branchScenes || (storyData.sceneImages || [])
    .filter(s => s.sceneDescription)
    .map(s => ({ pageNumber: s.pageNumber, brief: s.sceneDescription }));
  if (scenes.length === 0) throw new Error('story has no stored scene briefs to replay');

  // Findings from the STORED briefs — deterministic, so a rerun compares like
  // with like.
  const checkPages = scenes.map(x => {
    const stored = (storyData.sceneImages || []).find(s => s.pageNumber === x.pageNumber) || {};
    const meta = stored.sceneMetadata || extractSceneMetadata(x.brief) || {};
    return {
      pageNumber: x.pageNumber,
      prose: String(x.brief).split('---METADATA---')[0],
      cast: (stored.sceneCharacters || meta.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
      perCharClothing: stored.perCharClothing
        || (storyData.pageClothing?.pageClothing || {})[String(x.pageNumber)]
        || meta.characterClothing || {},
    };
  });
  const artifacts = (storyData.visualBible || {}).artifacts;
  const before = checkScenes(checkPages, storyData.clothingRequirements, { artifacts });
  const findingsBlock = renderFindingsBlock(before.byPage);

  // Beats for check 5, recovered from the stored outline's ---BEATS--- section
  // (the locked, post-review beats — see beatsPipeline rawOutline). Unified
  // stories have no such section; the builder renders "(no beat data)".
  const beatsSection = (String(storyData.outline || '')
    .match(/---\s*BEATS\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
  const outlineBeats = parseBeats(beatsSection).pages;

  const orig = PROMPT_TEMPLATES.sceneReview;
  if (promptOverride) PROMPT_TEMPLATES.sceneReview = promptOverride;
  let prompt;
  try {
    prompt = buildSceneReviewPrompt(storyData, scenes, { clothingFindings: findingsBlock, beats: outlineBeats });
  } finally {
    PROMPT_TEMPLATES.sceneReview = orig;
  }
  if (!prompt) throw new Error('scene-review template unavailable');

  // Mirror production: the scene review has its own model (sceneReviewModel),
  // it does not follow the beats reviewer.
  const models = String(params.reviewModel || MODEL_DEFAULTS.sceneReviewModel || MODEL_DEFAULTS.outlineReviewModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  const runs = [];
  for (const model of models) {
    // ONE ARM'S FAILURE MUST NOT DESTROY THE OTHERS. A multi-model fan-out is a
    // comparison: if a provider returns nothing for arm 3, arms 1-2 are still
    // valid measurements and arms 4-7 still have to run. Letting the throw
    // propagate discarded a whole 7-arm run (2026-08-15) over one empty
    // response, including the faults-in/faults-out numbers already computed.
    try {
    const t = Date.now();
    const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_scene_review_replay' });
    // AN EMPTY RESPONSE IS A FAILED CALL, NOT A CLEAN REVIEW. Run #450 came back
    // after 50s with input_tokens:0, output_tokens:0 on an 80k-char prompt — the
    // provider returned nothing — and this stage happily reported "0 faults
    // fixed, 0 pages rewritten", which is indistinguishable from a reviewer that
    // read everything and declined. Never publish that as a measurement.
    const outTok = res.usage?.output_tokens ?? null;
    if (!String(res.text || '').trim() || outTok === 0) {
      throw new Error(`reviewer ${model} returned an empty response (${outTok} output tokens, ${Math.round((res.usage?.elapsed_ms || 0) / 1000)}s) — provider failure, not a review`);
    }
    const parsed = parseRefinedText(res.text || '', scenes.map(x => x.pageNumber), 'SCENES');
    const byPage = new Map((parsed.pages || []).map(x => [x.pageNumber, x.text]));

    // Merge onto a COPY — the next model in the fan-out must see the same input.
    const merged = scenes.map(x => ({
      pageNumber: x.pageNumber,
      brief: (byPage.get(x.pageNumber) || '').trim() || x.brief,
    }));
    const diffs = merged
      .filter((m, i) => m.brief !== scenes[i].brief)
      .map(m => ({ pageNumber: m.pageNumber, before: scenes.find(x => x.pageNumber === m.pageNumber).brief, after: m.brief }));

    const afterPages = checkPages.map(cp => {
      const m = merged.find(x => x.pageNumber === cp.pageNumber);
      return { ...cp, prose: String(m.brief).split('---METADATA---')[0] };
    });
    const after = checkScenes(afterPages, storyData.clothingRequirements, { artifacts });
    const REVIEWABLE = new Set(['outfit_misattributed', 'removal_unstated']);
    const sentBefore = before.findings.filter(f => REVIEWABLE.has(f.type));
    const leftAfter = after.findings.filter(f => REVIEWABLE.has(f.type));

    // scoreOutput: the ONE evaluator grades this model's reviewed briefs (scene only).
    let scorecard = null;
    if (params.scoreOutput === true || params.scoreOutput === 'true') {
      const sceneText = merged.map(m => `--- Page ${m.pageNumber} ---\n${m.brief}`).join('\n\n');
      const chain = {
        reviewModel: model,
        ...(fromRound != null ? { fromRound } : {}),
        analysis: String(parsed.analysis || '').slice(0, 15000),
        rewrites: diffs.map(dd => ({ page: dd.pageNumber, before: String(dd.before).slice(0, 2000), after: String(dd.after).slice(0, 2000) })),
      };
      if (sceneText.trim()) scorecard = (await scoreArtifactsWithJudge({ scene: sceneText }, { model: params.judgeModel, evalVersion: params.evalVersion, persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'scene_review_replay', model, ...(fromRound != null ? { round: fromRound + 1, label: `from r${fromRound} · ${model}` } : {}), genCost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}), genMs: Date.now() - t, chain } })).scorecard;
    }

    runs.push({
      model,
      modelId: res.modelId,
      elapsedMs: Date.now() - t,
      cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
      usage: res.usage,
      analysis: parsed.analysis || '',
      changedPages: diffs.map(d => d.pageNumber),
      pages: diffs,
      scorecard,
      // The headline: faults in, faults out. Anything but 0 out means the
      // reviewer was handed a fact and declined to act on it.
      faultsBefore: sentBefore.length,
      faultsAfter: leftAfter.length,
      faultsFixed: sentBefore.length - leftAfter.length,
      unfixed: leftAfter,
    });
    } catch (err) {
      log.warn(`⚠️ [scene replay] arm ${model} failed: ${err.message}`);
      runs.push({ model, ok: false, error: err.message });
    }
  }

  return {
    storyId: target.storyId,
    pageCount: scenes.length,
    promptChars: prompt.length,
    prompt,
    clothingFindings: findingsBlock || null,
    findingsIn: before.findings,
    briefsIn: scenes,
    runs,
  };
}


/**
 * STORY SCORECARD — an LLM judge rates the four FINAL text artifacts (beats,
 * scene briefs, story text, visual bible) on a 4×5 dimension rubric so
 * different generation models can be compared. Reviewer-judged, final outputs
 * only; the rubric + extraction + math live in server/lib/storyScorecard.js so
 * the CLI (scripts/analysis/score-story.js) and this stage never diverge.
 *
 * params.model : a TEXT_MODELS key for the judge (default: outlineReviewModel).
 * promptOverride: swap the judge rubric prompt for an A/B.
 */
/**
 * THE ONE EVALUATOR. Scores a partial artifacts object ({beats?, scene?,
 * storyText?, visualBible?} of strings) with the versioned storyScorecard judge.
 * Used by story_scorecard (all four) AND every replay stage's scoreOutput (one
 * artifact), so a rerun's fresh output and a stored story are graded the same
 * way. The returned scorecard carries evaluatorVersion + evaluatorHash — scores
 * are only ever comparable within one evaluator.
 */
async function scoreArtifactsWithJudge(artifacts, { model, promptOverride = null, persist = null, evalVersion = null, context = null } = {}) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');
  const sc = require('./storyScorecard');

  // From version 2 on the evaluator version PINS the judge (2.1 Anna/Sonnet,
  // 2.2 Bruno/Grok, 2.3 Cora/Gemini), so a stored eval_version identifies both
  // the rubric and who scored it. When a caller names a judge instead (re-judging
  // a stored row), resolve the version that means "this prompt + that judge" so
  // the stamp can never claim a judge that did not produce the score.
  let ev = sc.resolveEvaluator(evalVersion);
  if (model && ev.judge && model !== ev.judge) {
    const match = sc.findEvaluatorForJudge(model, ev.promptKey);
    if (!match) throw new Error(`No evaluator version pins judge "${model}" for prompt ${ev.promptKey} — add one to EVALUATORS instead of mixing judge and version`);
    ev = sc.resolveEvaluator(match.version);
  }
  const judge = String(model || ev.judge || MODEL_DEFAULTS.scorecardJudge || MODEL_DEFAULTS.outlineReviewModel).trim();
  if (!TEXT_MODELS[judge]) throw new Error(`Unknown judge model "${judge}"`);
  const { version, promptKey, rubric } = ev;
  const template = promptOverride || PROMPT_TEMPLATES[promptKey];
  if (!template) throw new Error(`story-scorecard judge template unavailable for evaluator ${version}`);
  const input = sc.buildJudgeInputFromArtifacts(artifacts, context);
  if (!input.trim()) throw new Error('no artifacts to score');
  // The artifacts actually sent — the judge is graded on exactly these, never on
  // any zero-skeleton it echoes back for the ones it wasn't given.
  const requested = Object.keys(rubric).filter(k => artifacts[k] != null && String(artifacts[k]).trim());
  const partial = requested.length < Object.keys(rubric).length;

  const t = Date.now();
  // A judge draw can come back empty, truncated mid-object, or carrying a
  // dimension key that is not in the rubric — measured repeatedly on the
  // gemini-3.1-pro preview endpoint, at every output cap. Without a retry one
  // bad draw makes the judge score nothing at all, which reads as "this model
  // could not be scored" rather than "ask it again".
  let res = null;
  let scored = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await callTextModelStreaming(`${template}\n\n---\n\n${input}`, null, null, judge, { usageLabel: 'testlab_story_scorecard', temperature: 0 });
      if (!res || !res.text || !res.text.trim()) throw new Error('judge returned empty response');
      scored = sc.scoreFromDims(sc.parseJudgeJson(res.text), { partial, only: requested, rubric });
      break;
    } catch (err) {
      lastErr = err;
      log.warn(`⚠️ [SCORECARD] judge ${judge} attempt ${attempt}/3 unusable: ${err.message}`);
    }
  }
  if (!scored) throw new Error(`judge ${judge} returned nothing usable in 3 attempts: ${lastErr?.message}`);
  const scorecard = { ...scored, ...sc.evaluatorStamp(template, version), judgeModel: judge, scorerName: ev.name };
  const judgeMs = Date.now() - t;
  const judgeCost = res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {});

  // Persist to story_scores so this lands on the live scores page. `persist`
  // carries the story context + the GENERATING model (the comparison axis) +
  // source/label + an optional round (review pass). Fire-and-forget.
  if (persist && persist.storyId) {
    const { persistScore, upsertEvalVersion } = require('./scoreStore');
    upsertEvalVersion(version, scorecard.evaluatorHash, template); // archive the prompt for the drill-down
    const base = {
      storyId: persist.storyId, title: persist.title, language: persist.language, artStyle: persist.artStyle,
      model: persist.model || null, judgeModel: judge,
      evalVersion: scorecard.evaluatorVersion, evalHash: scorecard.evaluatorHash,
      source: persist.source || null, label: persist.label || null,
      round: typeof persist.round === 'number' ? persist.round : null,
      genCost: typeof persist.genCost === 'number' ? persist.genCost : null, // the model that produced/reviewed this artifact
      genMs: typeof persist.genMs === 'number' ? persist.genMs : null,
      judgeCost, judgeMs, // the scoring call
      chain: persist.chain || null, // full review chain (analysis + rewrites) that produced this round
    };
    for (const [artifact, a] of Object.entries(scorecard.artifacts)) {
      // freeze the exact text the judge read for this part (click a part → this)
      await persistScore({ ...base, artifact, score: a.score, dims: a.dims, notes: a.notes, artifactText: (artifacts[artifact] != null ? String(artifacts[artifact]).slice(0, 20000) : null) });
    }
    // a 'full' row only when all four artifacts were scored together
    if (Object.keys(scorecard.artifacts).length === Object.keys(sc.RUBRIC).length) {
      await persistScore({ ...base, artifact: 'full', score: scorecard.overall, dims: scorecard.artifacts, artifactText: input.slice(0, 20000) });
    }
  }

  return {
    scorecard,
    modelId: res.modelId,
    elapsedMs: judgeMs,
    cost: judgeCost,
    usage: res.usage,
  };
}

/**
 * SCORE RE-JUDGE — re-score an ALREADY-STORED round's frozen artifact text with a
 * DIFFERENT judge. Nothing is rewritten: this measures the JUDGE, not a reviewer,
 * so two judges' opinions of the identical text sit side by side on the Scores
 * page (the judge column tells them apart).
 *
 * params.scoreIds   : story_scores ids to re-judge (array or CSV)
 * params.judgeModel : the judge under test (required — the whole point)
 */
async function runScoreRejudgeStage(target, { params = {} }) {
  const { getScoresByIds } = require('./scoreStore');
  const { TEXT_MODELS } = require('../config/models');
  const judge = String(params.judgeModel || '').trim();
  if (!judge) throw new Error('params.judgeModel is required (the judge under test)');
  if (!TEXT_MODELS[judge]) throw new Error(`Unknown judge model "${judge}"`);
  const ids = (Array.isArray(params.scoreIds) ? params.scoreIds : String(params.scoreIds || '').split(','))
    .map(x => parseInt(String(x).trim(), 10)).filter(n => Number.isFinite(n));
  if (!ids.length) throw new Error('params.scoreIds is required');
  const rows = await getScoresByIds(ids);
  if (!rows.length) throw new Error('no story_scores rows found for those ids');

  const out = [];
  for (const row of rows) {
    // 'full' rows store the joined four-artifact input, not one artifact — a
    // single-artifact re-judge cannot represent them.
    if (row.artifact === 'full') { out.push({ id: row.id, error: "'full' rows cannot be re-judged as one artifact" }); continue; }
    if (!row.artifact_text) { out.push({ id: row.id, model: row.model, round: row.round, error: 'row has no stored artifact_text' }); continue; }
    // One flaky judge response must not abort the batch — a re-judge run is a
    // comparison across rows, so a failure is recorded per row and the rest
    // still get scored (a provider returning empty lost 3 of 5 rows once).
    try {
      const r = await scoreArtifactsWithJudge({ [row.artifact]: row.artifact_text }, {
        model: judge, evalVersion: params.evalVersion || row.eval_version,
        persist: {
          storyId: row.story_id, title: row.title, language: row.language, artStyle: row.art_style,
          source: 'score_rejudge', model: row.model, round: row.round,
          label: `${row.label || 'r' + row.round} · judged by ${judge}`,
        },
      });
      const a = r.scorecard.artifacts[row.artifact] || {};
      out.push({
        id: row.id, artifact: row.artifact, model: row.model, round: row.round, sourceLabel: row.label,
        previousJudge: row.judge_model, previousScore: row.score,
        newJudge: judge, newScore: a.score ?? null, dims: a.dims || null, notes: a.notes || '',
        judgeCost: r.cost, judgeMs: r.elapsedMs,
      });
    } catch (err) {
      out.push({ id: row.id, model: row.model, round: row.round, error: err.message });
    }
  }
  return { storyId: target.storyId, judge, count: out.length, rejudged: out };
}

async function runStoryScorecardStage(target, { params = {}, promptOverride = null }) {
  const sc = require('./storyScorecard');
  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  if (!(storyData.sceneDescriptions || []).length && !storyData.storyText) {
    throw new Error('story has no final artifacts to score (no sceneDescriptions / storyText)');
  }
  const r = await scoreArtifactsWithJudge(sc.extractArtifacts(storyData), {
    model: params.model, promptOverride, evalVersion: params.evalVersion,
    // The commission, so a judge does not report the requested premise as a fault.
    context: sc.buildBriefContext(storyData),
    persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'story_scorecard', model: sc.provenanceOf(storyData).writer },
  });
  return {
    storyId: target.storyId,
    scorecard: {
      ...r.scorecard,
      title: storyData.title || null,
      language: storyData.language || null,
      artStyle: storyData.artStyle || null,
      models: sc.provenanceOf(storyData),
    },
    modelId: r.modelId,
    elapsedMs: r.elapsedMs,
    cost: r.cost,
    usage: r.usage,
  };
}

/**
 * BEATS REVIEW REPLAY — re-run the beats review on a story's frozen beats, to
 * A/B the reviewer prompt (promptOverride) and models (params.reviewModel, CSV)
 * and measure how many PASSES it takes to converge (params.passes). Each pass
 * reviews the beats the previous pass rewrote. With params.scoreOutput, the ONE
 * evaluator scores the beats after each pass, so the coherence score is visible
 * pass-to-pass and comparable across models/prompts.
 */
/**
 * AN EMPTY RESPONSE IS A FAILED CALL, NOT A CLEAN REVIEW — the same rule the
 * scene replay already enforces. Without it the beats replay reported "0 pages
 * rewritten, converged" for a provider that returned nothing, which is
 * indistinguishable from a reviewer that read everything and declined. Three
 * candidates (2026-08-15) published non-reviews as converged results that way,
 * one of them after burning 983s. Never publish that as a measurement.
 */
function assertReviewerResponded(res, model) {
  const outTok = res?.usage?.output_tokens ?? null;
  if (!String(res?.text || '').trim() || outTok === 0) {
    throw new Error(`reviewer ${model} returned an empty response (${outTok} output tokens, ${Math.round((res?.usage?.elapsed_ms || 0) / 1000)}s) — provider failure, not a review`);
  }
}

async function runBeatsReviewReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, withTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');
  const { buildBeatsReviewPrompt, parseBeats } = require('./storyHelpers');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const beatsSection = (String(storyData.outline || '').match(/---\s*BEATS\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
  const beats0 = parseBeats(beatsSection).pages;
  if (!beats0.length) throw new Error('story has no beats to replay');
  // A replay reviews stored beats, so the arc comes from the run that produced
  // them. Stories planned before the arc stage existed have none — the review
  // prompt then says so rather than pretending one was committed.
  const storedArc = parseBeats(String(storyData.outline || '')).arc || storyData.beatsReviewReport?.arc || '';

  const models = String(params.reviewModel || params.model || MODEL_DEFAULTS.outlineReviewModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);
  const passCount = Math.min(Math.max(parseInt(params.passes, 10) || 1, 1), 3);
  const scoreOutput = params.scoreOutput === true || params.scoreOutput === 'true';

  // "## Page N" so a stored round's artifact_text round-trips back through parseBeats
  // (needed to branch a new round off a selected round — params.fromText below).
  const beatsToText = (bs) => bs.map(b => `## Page ${b.pageNumber}\nBEAT: ${b.beat}\nSCENE: ${b.scene}`).join('\n\n');

  // BRANCH MODE — continue a SPECIFIC round: review the selected round's stored
  // beats text (params.fromText) once with the chosen model, scoring it as the
  // next round. This is how "take DeepSeek round 2, rerun with Grok → round 3"
  // works from the page.
  if (params.fromText) {
    const model = models[0];
    const fromRound = parseInt(params.fromRound, 10) || 1;
    const inBeats = parseBeats(String(params.fromText)).pages;
    if (!inBeats.length) throw new Error('fromText has no parseable beats');
    const t = Date.now();
    // withTemplates, not a global swap: this window spans a model call, so a
    // concurrently running experiment would otherwise read this override (or
    // have its own dropped by the restore). The other override sites in this
    // file are synchronous and safe by construction; these replay windows are
    // the two that are not. See server/services/prompts.js.
    const res = await withTemplates({ storyBeatsReview: promptOverride }, () =>
      callTextModelStreaming(buildBeatsReviewPrompt(storyData, inBeats, storedArc, ''), null, null, model, { usageLabel: 'testlab_beats_branch', temperature: 0 }));
    assertReviewerResponded(res, model);
    const out = res.text || '';
    const marker = out.match(/---\s*BEATS\s*---/i);
    const branchAnalysis = (marker ? out.slice(0, marker.index) : out).trim();
    const rewritten = marker ? parseBeats(out.slice(marker.index)).pages : [];
    const byPage = new Map(rewritten.map(r => [r.pageNumber, r]));
    const nextBeats = inBeats.map(b => byPage.get(b.pageNumber) || b);
    const genCost = res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {});
    const genMs = Date.now() - t;
    const chain = {
      reviewModel: model,
      fromRound,
      analysis: branchAnalysis.slice(0, 15000),
      rewrites: inBeats.filter(b => byPage.has(b.pageNumber)).map(b => {
        const r = byPage.get(b.pageNumber);
        return { page: b.pageNumber, before: `BEAT: ${b.beat}\nSCENE: ${b.scene}`.slice(0, 2000), after: `BEAT: ${r.beat}\nSCENE: ${r.scene}`.slice(0, 2000) };
      }),
    };
    let scorecard = null;
    if (scoreOutput) {
      scorecard = (await scoreArtifactsWithJudge({ beats: beatsToText(nextBeats) }, {
        model: params.judgeModel, evalVersion: params.evalVersion,
        persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'beats_review_replay', model, label: `from r${fromRound} · ${model}`, round: fromRound + 1, genCost, genMs, chain },
      })).scorecard;
    }
    return { storyId: target.storyId, branch: { fromRound, toRound: fromRound + 1, model, rewrittenPages: [...byPage.keys()], score: scorecard?.artifacts?.beats?.score ?? null } };
  }
  const arms = [];
  // round 1 = the RAW beats (as generated, before any review), scored once.
  // Model-agnostic, so it's the shared baseline every reviewer arm builds on.
  let rawScorecard = null;
  if (scoreOutput) {
    try {
      rawScorecard = (await scoreArtifactsWithJudge({ beats: beatsToText(beats0) }, {
        model: params.judgeModel, evalVersion: params.evalVersion,
        persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'beats_review_replay', model: storyData.outlineModelId || 'writer', label: 'raw (as generated)', round: 1 },
      })).scorecard;
    } catch (e) { require('../utils/logger').log.warn(`[beats replay] round-1 raw score failed: ${e.message}`); }
  }

  for (const model of models) {
    // Per-arm isolation, same reason as the scene fan-out: one provider's
    // empty response must not discard the arms that already succeeded.
    try {
    let beats = beats0;
    const passes = [];
    let convergedAtPass = null;
    for (let p = 1; p <= passCount; p++) {
      // The override lives only around this synchronous build. It used to be
      // set on the shared registry for the whole replay — many minutes and
      // many awaits — which is one of the two windows that forced the Lab to
      // run one experiment at a time.
      const prompt = withTemplates({ storyBeatsReview: promptOverride }, () =>
        buildBeatsReviewPrompt(storyData, beats, storedArc, ''));
      const t = Date.now();
      const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_beats_review_replay', temperature: 0 });
      assertReviewerResponded(res, model);
      const out = res.text || '';
      const marker = out.match(/---\s*BEATS\s*---/i);
      const analysis = (marker ? out.slice(0, marker.index) : out).trim();
      const rewritten = marker ? parseBeats(out.slice(marker.index)).pages : [];
      const rewrittenPages = rewritten.map(r => r.pageNumber);
      const byPage = new Map(rewritten.map(r => [r.pageNumber, r]));
      // Full chain for this pass: the reviewer's complete analysis (all
      // checks) + exact before→after per rewritten page. This is what the
      // score row persists — a round must explain what produced it.
      const chain = {
        reviewModel: model,
        pass: p,
        analysis: analysis.slice(0, 15000),
        rewrites: beats.filter(b => byPage.has(b.pageNumber)).map(b => {
          const r = byPage.get(b.pageNumber);
          return { page: b.pageNumber, before: `BEAT: ${b.beat}\nSCENE: ${b.scene}`.slice(0, 2000), after: `BEAT: ${r.beat}\nSCENE: ${r.scene}`.slice(0, 2000) };
        }),
      };
      const entry = {
        pass: p,
        rewrittenPages,
        converged: rewrittenPages.length === 0,
        analysis: analysis.slice(0, 15000),
        check8: (analysis.match(/8\.\s*Loose threads[\s\S]*?(?=\n\d{1,2}\.\s|$)/i) || [''])[0].trim().slice(0, 800),
        cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
        elapsedMs: Date.now() - t,
      };
      beats = beats.map(b => byPage.get(b.pageNumber) || b); // fold rewrites forward
      if (scoreOutput) {
        const sr = await scoreArtifactsWithJudge({ beats: beatsToText(beats) }, {
          model: params.judgeModel, evalVersion: params.evalVersion,
          // round p+1: round 1 is the raw beats (scored below), so pass p → round p+1
          persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'beats_review_replay', model, label: `review pass ${p}`, round: p + 1, genCost: entry.cost, genMs: entry.elapsedMs, chain },
        });
        entry.scorecard = sr.scorecard;
        entry.cost += sr.cost;
      }
      passes.push(entry);
      if (entry.converged) { convergedAtPass = p; break; }
    }
    arms.push({ model, passes, convergedAtPass });
    } catch (err) {
      require('../utils/logger').log.warn(`⚠️ [beats replay] arm ${model} failed: ${err.message}`);
      arms.push({ model, ok: false, error: err.message, passes: [] });
    }
  }
  return { storyId: target.storyId, beatCount: beats0.length, passesRequested: passCount, rawScore: rawScorecard?.artifacts?.beats?.score ?? null, arms };
}


/**
 * STORY BIBLE REPLAY — re-derive the clothing contract for an EXISTING story.
 *
 * The costume descriptions are written once, in the story-bible stage, and every
 * later failure inherits them: an outfit whose identity rests on "a small white
 * feather tucked into the left fold" cannot be drawn consistently no matter how
 * good the renderer is. Changing those rules is therefore worth measuring on its
 * own, against a story whose old contract we can read side by side.
 *
 * Beats are reconstructed from the stored pages (page text = BEAT, the scene's
 * imageSummary = SCENE), so this needs nothing the story does not already carry.
 */
/**
 * The beats a story was ACTUALLY written from.
 *
 * Prefer beatsReviewReport.briefsIn — the one-line BEAT + SCENE pairs the beats
 * pipeline locked and fed to the bible, scene and text stages. Reconstructing
 * beats from the finished page text instead puts the answer in the question:
 * a text-replay arm handed the shipped prose as its "beat" simply copies it,
 * and three different models returned byte-identical pages (2026-08-11), which
 * measured transcription rather than writing.
 *
 * The prose fallback stays for pre-beats stories that have no briefsIn, but it
 * is flagged so a caller can tell a real comparison from a contaminated one.
 */
function resolveStoryBeats(storyData, helpers) {
  const { getPageText, extractSceneMetadata } = helpers;
  const briefs = storyData?.beatsReviewReport?.briefsIn;
  if (Array.isArray(briefs) && briefs.length > 0) {
    const parsed = briefs.map((b) => {
      const t = String(b.brief || '');
      const beat = (t.match(/BEAT:\s*([\s\S]*?)(?=\nSCENE:|$)/i) || [])[1] || '';
      const scene = (t.match(/SCENE:\s*([\s\S]*)$/i) || [])[1] || '';
      return { pageNumber: b.pageNumber, beat: beat.trim(), scene: scene.trim() };
    }).filter(b => b.beat || b.scene);
    if (parsed.length > 0) return { beats: parsed, source: 'briefsIn' };
  }
  const fullText = storyData.storyText || storyData.story || '';
  const beats = (storyData.sceneImages || []).map((sc) => {
    const meta = sc.sceneMetadata || extractSceneMetadata(sc.sceneDescription || '') || {};
    return {
      pageNumber: sc.pageNumber,
      beat: (getPageText(fullText, sc.pageNumber) || '').slice(0, 600),
      scene: (meta.sceneIntent || String(sc.sceneDescription || '').split('---METADATA---')[0].slice(0, 300)),
    };
  });
  return { beats, source: 'reconstructed-from-prose' };
}

async function runStoryBibleReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildStoryBibleFromBeatsPrompt, getPageText, extractSceneMetadata } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');
  const { UnifiedStoryParser } = require('./outlineParser/unified');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const fullText = storyData.storyText || storyData.story || '';
  const { beats, source: beatsSource } = resolveStoryBeats(storyData, { getPageText, extractSceneMetadata });
  if (beats.length === 0) throw new Error('story has no beats and no pages to rebuild them from');

  const orig = PROMPT_TEMPLATES.storyBibleFromBeats;
  if (promptOverride) PROMPT_TEMPLATES.storyBibleFromBeats = promptOverride;
  let prompt;
  try {
    prompt = buildStoryBibleFromBeatsPrompt(storyData, beats);
  } finally {
    PROMPT_TEMPLATES.storyBibleFromBeats = orig;
  }
  if (!prompt) throw new Error('story-bible-from-beats template unavailable');

  const model = params.bibleModel || params.model || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);
  // "＋ next round" on the bible is a RE-GENERATION from beats with the chosen
  // model, not a critique-of-prior — the repo has no general bible-critique
  // prompt (only the wardrobe-scoped clothingReview). The round is still
  // slotted so different models sit side by side; the label says what it is.
  const fromRound = params.fromText != null ? (parseInt(params.fromRound, 10) || 1) : null;

  const t = Date.now();
  const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_story_bible_replay' });
  if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) {
    throw new Error(`bible model ${model} returned an empty response — provider failure, not a result`);
  }
  const parser = new UnifiedStoryParser(res.text || '');
  let clothing = null;
  try { clothing = parser.extractClothingRequirements(); } catch (err) { clothing = { _parseError: err.message }; }

  // Side by side with what the story actually shipped — the whole point.
  const before = storyData.clothingRequirements || {};
  const summarise = (reqs) => Object.entries(reqs || {}).map(([name, r]) => {
    const used = Object.entries(r || {}).filter(([, v]) => v && typeof v === 'object' && v.used);
    return { name, categories: used.map(([k]) => k), description: (used[0]?.[1]?.description) || null };
  });

  // scoreOutput: the ONE evaluator grades the regenerated bible (visualBible only).
  let scorecard = null;
  if (params.scoreOutput === true || params.scoreOutput === 'true') {
    const visualBible = String(res.text || '').slice(0, 20000);
    if (visualBible.trim()) scorecard = (await scoreArtifactsWithJudge({ visualBible }, { model: params.judgeModel, evalVersion: params.evalVersion, persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'story_bible_replay', model, ...(fromRound != null ? { round: fromRound + 1, label: `regen (no critique) · ${model}` } : {}), genCost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}), genMs: Date.now() - t } })).scorecard;
  }

  return {
    storyId: target.storyId,
    beatsSource,
    model, modelId: res.modelId,
    elapsedMs: Date.now() - t,
    cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
    usage: res.usage,
    promptChars: prompt.length,
    prompt,
    rawResponse: (res.text || '').slice(0, 40000),
    scorecard,
    clothingBefore: summarise(before),
    clothingAfter: summarise(clothing),
  };
}

/**
 * Wardrobe review replay — runs the clothing review over a stored story's OWN
 * shipped contract, so the question it answers is exactly the production one:
 * given this wardrobe, does the reviewer catch what went wrong?
 *
 * The bandana that shipped in job_1786277779744_vorw1f7ve is the motivating
 * case, but the stage is worth running across several stories: a reviewer that
 * only ever fires on the one outfit that annoyed us is a reviewer tuned to
 * noise. Both the analysis and the applied rewrites come back, so a run that
 * "found" something but rewrote nothing is visible as such.
 */
async function runClothingReviewStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildClothingReviewPrompt, parseClothingReview, getPageText, extractSceneMetadata } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const before = JSON.parse(JSON.stringify(storyData.clothingRequirements || {}));
  if (Object.keys(before).length === 0) throw new Error('story has no clothingRequirements to review');

  const orig = PROMPT_TEMPLATES.clothingReview;
  if (promptOverride) PROMPT_TEMPLATES.clothingReview = promptOverride;
  let prompt;
  try {
    // Same beats production sees — check 9 (coverage) is unanswerable without them.
    const { beats: reviewBeats } = resolveStoryBeats(storyData, { getPageText, extractSceneMetadata });
    prompt = buildClothingReviewPrompt(storyData, before, reviewBeats);
  } finally {
    PROMPT_TEMPLATES.clothingReview = orig;
  }
  if (!prompt) throw new Error('clothing-review template unavailable, or no used outfit in this story');

  const model = params.reviewModel || MODEL_DEFAULTS.outlineReview || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);

  const t = Date.now();
  const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_clothing_review' });
  if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) {
    throw new Error(`review model ${model} returned an empty response — provider failure, not a result`);
  }
  const parsed = parseClothingReview(res.text || '');

  // Apply exactly as the pipeline does, so a rewrite that production would drop
  // (unused category, unknown name) is dropped here too.
  const after = JSON.parse(JSON.stringify(before));
  const changed = [], stray = [];
  for (const fix of parsed.entries) {
    const name = Object.keys(after).find(n => n.toLowerCase() === fix.name.toLowerCase());
    let entry = name ? after[name]?.[fix.category] : null;
    // Mirror production: check 9 may ADD costumed:<name> for a beat-driven
    // transformation the bible missed.
    if (name && fix.category === 'costumed' && fix.costume && (!entry || !entry.used)) {
      entry = after[name].costumed = { ...(after[name].costumed || {}), used: true, costume: fix.costume };
    }
    if (!entry || !entry.used) { stray.push(`${fix.name}/${fix.category}`); continue; }
    if ((entry.description || '') === fix.description) continue;
    changed.push({ name, category: fix.costume ? `costumed:${fix.costume}` : fix.category, before: entry.description || '', after: fix.description });
    entry.description = fix.description;
  }

  return {
    storyId: target.storyId,
    model, modelId: res.modelId,
    elapsedMs: Date.now() - t,
    cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
    usage: res.usage,
    promptChars: prompt.length,
    prompt,
    analysis: parsed.analysis,
    rawResponse: (res.text || '').slice(0, 40000),
    changed,
    stray,
    outfitsIn: Object.entries(before).flatMap(([n, cats]) =>
      Object.entries(cats || {})
        .filter(([, v]) => v && v.used && v.description)
        .map(([c, v]) => ({ name: n, category: c, costume: v.costume || null, description: v.description }))),
  };
}

/**
 * Page-text replay — the last untested Sonnet stage.
 *
 * beats_scenes covers plan + scene expansion and story_bible_replay covers the
 * bible, but nothing replayed beats_story_text, so ~19% of the writer spend
 * could not be A/B'd against a cheaper model. Beats are reconstructed from the
 * stored pages exactly as the bible replay does, so the two stages compare
 * like for like.
 *
 * params.textModel : writer under test (default MODEL_DEFAULTS.outline)
 */
async function runStoryTextReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildStoryTextFromBeatsPrompt, parseRefinedText, getPageText, extractSceneMetadata, parseBeats } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const fullText = storyData.storyText || storyData.story || '';

  // BRANCH MODE — "＋ next round": refine a SELECTED round's stored text
  // (params.fromText) one more pass with the chosen model, persisting as the
  // next round. Uses the production refine loop (textRefine.js) so a Lab round
  // and a shipped refine pass are the same operation. Scene intent/brief come
  // from the story (read-only guardrails); the prose refined is the prior round.
  if (params.fromText) {
    const { refineStoryText, extractRefinablePages } = require('./textRefine');
    const model = params.textModel || params.model || params.reviewModel || MODEL_DEFAULTS.outlineReviewModel;
    if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);
    const fromRound = parseInt(params.fromRound, 10) || 1;
    const prior = parsePageBlocks(params.fromText);
    if (!prior.length) throw new Error('fromText has no parseable pages');
    const priorBy = new Map(prior.map(p => [p.pageNumber, p.text]));
    const basePages = extractRefinablePages(storyData.sceneImages || []);
    const pages = (basePages.length ? basePages : prior.map(p => ({ pageNumber: p.pageNumber, text: p.text, sceneIntent: '', sceneBrief: '' })))
      .map(p => ({ ...p, text: priorBy.get(p.pageNumber) || p.text }));
    const t = Date.now();
    const rr = await refineStoryText(storyData, pages, { rounds: 1, model, usageLabel: 'testlab_text_branch' });
    const genMs = Date.now() - t;
    const genCost = (rr.rounds || []).reduce((s, r) => s + (r.cost || 0), 0);
    const storyText = rr.pages.map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
    let scorecard = null;
    if (params.scoreOutput === true || params.scoreOutput === 'true') {
      const round0 = (rr.rounds || [])[0] || {};
      const chain = {
        reviewModel: model,
        fromRound,
        analysis: String(round0.analysis || '').slice(0, 15000),
        rewrites: (round0.pages || []).filter(p => p.before !== p.after).map(p => ({ page: p.pageNumber, before: String(p.before).slice(0, 2000), after: String(p.after).slice(0, 2000) })),
      };
      scorecard = (await scoreArtifactsWithJudge({ storyText }, { model: params.judgeModel, evalVersion: params.evalVersion, persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'story_text_replay', model, label: `from r${fromRound} · ${model}`, round: fromRound + 1, genCost, genMs, chain } })).scorecard;
    }
    return { storyId: target.storyId, branch: { fromRound, toRound: fromRound + 1, model, changedPages: rr.changed, score: scorecard?.artifacts?.storyText?.score ?? null } };
  }

  const { beats, source: beatsSource } = resolveStoryBeats(storyData, { getPageText, extractSceneMetadata });
  if (beats.length === 0) throw new Error('story has no beats and no pages to rebuild them from');

  const orig = PROMPT_TEMPLATES.storyTextFromBeats;
  if (promptOverride) PROMPT_TEMPLATES.storyTextFromBeats = promptOverride;
  let prompt;
  try { prompt = buildStoryTextFromBeatsPrompt(storyData, beats, [], parseBeats(String(storyData.outline || '')).arc || ''); }
  finally { PROMPT_TEMPLATES.storyTextFromBeats = orig; }
  if (!prompt) throw new Error('story-text-from-beats template unavailable');

  const model = params.textModel || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);

  const t = Date.now();
  const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_story_text_replay' });
  if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) {
    throw new Error(`writer ${model} returned an empty response — provider failure, not a result`);
  }
  const parsed = parseRefinedText(res.text || '');

  // scoreOutput: the ONE evaluator grades the regenerated text (storyText only).
  let scorecard = null;
  if (params.scoreOutput === true || params.scoreOutput === 'true') {
    const storyText = (parsed.pages || []).map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
    if (storyText.trim()) scorecard = (await scoreArtifactsWithJudge({ storyText }, { model: params.judgeModel, evalVersion: params.evalVersion, persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'story_text_replay', model, genCost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}), genMs: Date.now() - t } })).scorecard;
  }

  return {
    storyId: target.storyId,
    beatsSource,
    model, modelId: res.modelId,
    elapsedMs: Date.now() - t,
    cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
    usage: res.usage,
    promptChars: prompt.length,
    prompt,
    title: parsed.title || null,
    analysis: parsed.analysis || '',
    rawResponse: (res.text || '').slice(0, 40000),
    scorecard,
    // Side by side with the text that shipped — the whole point.
    pages: (parsed.pages || []).map(p => ({
      pageNumber: p.pageNumber,
      text: p.text,
      shipped: getPageText(fullText, p.pageNumber) || '',
    })),
    pageCount: (parsed.pages || []).length,
    expectedPages: beats.length,
  };
}

/**
 * writer_compare — every writer model x every writer stage, one experiment.
 * See server/lib/testlabWriterCompare.js for why this is a stage, not a script.
 */
async function runWriterCompareStage(target, { params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const SH = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');
  const { UnifiedStoryParser } = require('./outlineParser/unified');
  const WC = require('./testlabWriterCompare');

  const models = Array.isArray(params.models) && params.models.length
    ? params.models : ['deepseek-v4-pro', 'deepseek-v4-flash'];
  const stages = Array.isArray(params.stages) && params.stages.length
    ? params.stages.filter(s => WC.ALL_STAGES.includes(s)) : WC.ALL_STAGES;
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const fullText = storyData.storyText || storyData.story || '';
  const shippedScenes = storyData.sceneImages || [];
  const expectedPages = shippedScenes.length;
  if (expectedPages === 0) throw new Error('story has no pages');
  const expectedChars = (storyData.characters || []).length || Object.keys(storyData.clothingRequirements || {}).length;

  // Beats reconstructed from the stored pages — identical to the bible/text
  // replays, so every arm is fed the same input.
  const { beats, source: beatsSource } = resolveStoryBeats(storyData, {
    getPageText: SH.getPageText, extractSceneMetadata: SH.extractSceneMetadata,
  });

  const call = async (prompt, model, label) => {
    const t = Date.now();
    const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: `testlab_writer_${label}` });
    const text = String(res.text || '');
    if (!text.trim() || res.usage?.output_tokens === 0) throw new Error(`${model} returned nothing for ${label}`);
    return {
      text, elapsedMs: Date.now() - t,
      cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
      usage: res.usage, modelId: res.modelId,
    };
  };

  const arms = [];

  // The free baseline: what the story already shipped with. Never re-run.
  if (params.baseline !== false) {
    const b = { model: 'shipped (Sonnet)', free: true, stages: {} };
    if (stages.includes('plan')) b.stages.plan = { ...WC.scorePlan(beats, expectedPages), cost: 0, elapsedMs: 0 };
    if (stages.includes('bible')) {
      b.stages.bible = { ...WC.scoreBible(storyData.clothingRequirements, storyData.visualBible, expectedChars), cost: 0, elapsedMs: 0 };
    }
    if (stages.includes('scenes')) {
      b.stages.scenes = { ...WC.scoreScenes(shippedScenes.map(s => s.sceneDescription || '')), cost: 0, elapsedMs: 0 };
    }
    if (stages.includes('text')) {
      const pages = shippedScenes.map(s => ({ pageNumber: s.pageNumber, text: SH.getPageText(fullText, s.pageNumber) || '' }));
      b.stages.text = { ...WC.scoreText(pages, expectedPages, storyData.language), cost: 0, elapsedMs: 0 };
    }
    arms.push(b);
  }

  for (const model of models) {
    const arm = { model, free: false, stages: {} };
    for (const stage of stages) {
      try {
        if (stage === 'plan') {
          const r = await call(SH.buildBeatsPrompt(storyData, expectedPages), model, 'plan');
          const parsed = SH.parseBeats(r.text, []);
          arm.stages.plan = { ...WC.scorePlan(parsed.pages || [], expectedPages), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'bible') {
          const r = await call(SH.buildStoryBibleFromBeatsPrompt(storyData, beats), model, 'bible');
          const p = new UnifiedStoryParser(r.text);
          arm.stages.bible = { ...WC.scoreBible(p.extractClothingRequirements(), p.extractVisualBible(), expectedChars), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'scenes') {
          const r = await call(SH.buildSceneExpansionAllPrompt(storyData, beats, {}), model, 'scenes');
          const briefs = String(r.text).split(/^##\s*(?:Page|Seite)\s*\d+/im).slice(1);
          arm.stages.scenes = { ...WC.scoreScenes(briefs), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'text') {
          const r = await call(SH.buildStoryTextFromBeatsPrompt(storyData, beats, [], SH.parseBeats(String(storyData.outline || '')).arc || ''), model, 'text');
          const parsed = SH.parseRefinedText(r.text);
          arm.stages.text = { ...WC.scoreText(parsed.pages || [], expectedPages, storyData.language), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        }
      } catch (err) {
        // A failed arm is a RESULT, not a crash: "this model cannot do this
        // stage" is exactly what the comparison is for.
        arm.stages[stage] = { score: 0, error: err.message, cost: 0, elapsedMs: 0 };
      }
    }
    arms.push(arm);
  }

  for (const a of arms) {
    const ss = Object.values(a.stages).map(s => s.score || 0);
    a.overall = WC.avg(ss);
    a.totalCost = Object.values(a.stages).reduce((s, x) => s + (x.cost || 0), 0);
    a.totalMs = Object.values(a.stages).reduce((s, x) => s + (x.elapsedMs || 0), 0);
  }

  return {
    storyId: target.storyId,
    beatsSource,
    title: storyData.title || null,
    language: storyData.language || null,
    expectedPages, expectedChars,
    stages, models,
    arms,
    // Ranked once here so the UI and any later reader agree on the order.
    ranking: [...arms].sort((a, b) => (b.overall - a.overall) || (a.totalCost - b.totalCost))
      .map(a => ({ model: a.model, overall: a.overall, cost: Number(a.totalCost.toFixed(4)), secs: Math.round(a.totalMs / 1000) })),
  };
}

/**
 * ARC ROUNDS — plan the arc alone, then review it repeatedly, scoring after
 * every round.
 *
 * The arc is ~15 lines where a beats plan is a whole book, so one review round
 * costs cents instead of francs. That is what makes the two open questions
 * answerable at all: does a second, third or fourth review round still add
 * anything, and does rotating the reviewer model beat repeating one? At the
 * BEATS level extra passes measured negative five times out of five, so the
 * answer is not assumed here — it is measured, round by round.
 *
 * params.storyDetails : plan from a different idea than the story's own
 * params.rounds       : review rounds (default 3, capped at 5)
 * params.reviewModels : CSV, one per round, cycled — rotation is the variable
 * params.judgeModels  : CSV of judges scoring every round (default all three)
 * params.planModel    : arc planner (default MODEL_DEFAULTS.outline)
 * params.variants     : ask the planner for N arcs in ONE call, score each, then
 *   a final call that takes the best and grafts what the others did better.
 *   Compare against sequential rounds: N drafts in one call cost roughly one
 *   draft's input tokens, where N review rounds pay the input twice per round.
 */
async function runArcRoundsStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { PROMPT_TEMPLATES } = require('../services/prompts');
  const { buildBeatsPrompt, buildArcReviewPrompt, parseArcReview, parseBeats } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');
  const sc = require('./storyScorecard');

  const { storyData: loaded } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const storyData = params.storyDetails ? { ...loaded, storyDetails: String(params.storyDetails) } : loaded;
  const pageCount = parseInt(params.pages, 10) || (storyData.sceneImages || []).length || storyData.pages || 10;

  const planModel = params.planModel || MODEL_DEFAULTS.outline;
  const reviewModels = String(params.reviewModels || MODEL_DEFAULTS.outlineReviewModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  const judgeModels = String(params.judgeModels || 'claude-sonnet,grok-4.6,gemini-3.1-pro')
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of [planModel, ...reviewModels, ...judgeModels]) {
    if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);
  }
  // 0 is a legitimate setting — best-of-N with no sequential review is one of
  // the two arms being compared, and `|| 3` would silently turn it into three.
  const _r = parseInt(params.rounds, 10);
  const rounds = Math.min(Math.max(Number.isFinite(_r) ? _r : 3, 0), 5);
  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});

  const { ARC_RUBRIC } = sc;
  const judgeTemplate = PROMPT_TEMPLATES.storyArcJudge;
  if (!judgeTemplate) throw new Error('story-arc-judge template unavailable');
  const context = sc.buildBriefContext({ ...storyData, pages: pageCount });

  // A judge draw can be empty, truncated, or carry a key outside the rubric —
  // one bad draw must not read as "this round could not be scored".
  // The judges are independent of each other, so they go concurrently — serial
  // judging made a run 18 sequential model calls and dominated its wall clock.
  const judgeOnce = async (judge, arcText) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const input = `# BRIEF (the commission — context only, not scored)\n${context}\n\n===\n\n# ARC\n${arcText}`;
        const r = await callTextModelStreaming(`${judgeTemplate}\n\n---\n\n${input}`, null, null, judge, { usageLabel: 'testlab_arc_judge' });
        const parsed = sc.parseJudgeJson(r.text);
        const dims = parsed?.arc?.dims || {};
        // 1-10 only: a judge echoing the prompt's zero-filled skeleton must not
        // average in as a real score.
        const keys = ARC_RUBRIC.arc.filter(k => { const n = Number(dims[k]); return Number.isFinite(n) && n >= 1 && n <= 10; });
        if (keys.length < ARC_RUBRIC.arc.length) throw new Error(`missing dims: ${ARC_RUBRIC.arc.filter(k => !keys.includes(k)).join(',')}`);
        const score = Math.round((keys.reduce((s, k) => s + Number(dims[k]), 0) / keys.length) * 10) / 10;
        return { score, dims, notes: String(parsed.arc.notes || ''), cost: costOf(r) };
      } catch (err) {
        log.warn(`⚠️ [ARC] judge ${judge} attempt ${attempt}/3 unusable: ${err.message}`);
      }
    }
    return { score: null, error: 'no usable response in 3 attempts' };
  };
  const scoreArc = async (arcText) => {
    const results = await Promise.all(judgeModels.map(j => judgeOnce(j, arcText)));
    const per = Object.fromEntries(judgeModels.map((j, i) => [j, results[i]]));
    const nums = results.map(x => x.score).filter(x => x != null);
    return { per, mean: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null };
  };

  // Round 0 — the arc as planned. The planner owns every arc rule already, so
  // this asks the same prompt for its ARC block alone rather than duplicating
  // those rules into a second template that would then drift.
  let planPrompt = buildBeatsPrompt(storyData, pageCount);
  if (!planPrompt) throw new Error('story-beats template unavailable');
  if (promptOverride) planPrompt = promptOverride;
  planPrompt += '\n\nOutput the ---ARC--- block only. Omit the ---BEATS--- block entirely.';

  const variantCount = Math.min(Math.max(parseInt(params.variants, 10) || 0, 0), 4);
  const trail = [];
  let arc = null;

  if (params.fromArc) {
    // Continue a specific arc instead of planning a new one. The only way to ask
    // what round N adds is to start every arm from the identical round N-1 text —
    // re-planning would change the thing being reviewed as well as the reviewer.
    arc = String(params.fromArc).trim();
    const s = await scoreArc(arc);
    trail.push({
      round: 0, kind: 'given', model: null, elapsedMs: 0, cost: 0,
      arc, changed: null, analysis: null, scores: s.per, mean: s.mean,
    });
    log.info(`🧭 [ARC] given arc: mean ${s.mean ?? '—'}`);
  } else if (variantCount >= 2) {
    // N arcs in ONE call: same brief and rules, different takes, so the input is
    // paid once. Lettered blocks because the parser needs to split them.
    const multiPrompt = `${planPrompt}\n\nProduce ${variantCount} different arcs for this same book, not variations of one idea — a different shape, a different thing going wrong, a different character carrying the change. Head each with ---ARC A---, ---ARC B--- and so on, in that order, and output nothing else.`;
    const t0 = Date.now();
    const multiRes = await callTextModelStreaming(multiPrompt, null, null, planModel, { usageLabel: 'testlab_arc_variants' });
    const raw = multiRes.text || '';
    const marks = [...raw.matchAll(/---\s*ARC\s+([A-Z])\s*---/gi)];
    const variants = marks.map((m, i) => ({
      letter: m[1].toUpperCase(),
      arc: raw.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : raw.length).trim(),
    })).filter(v => v.arc);
    if (!variants.length) throw new Error('planner returned no parseable arc variants');

    // Variants are independent too: score all of them at once.
    const variantScores = await Promise.all(variants.map(v => scoreArc(v.arc)));
    variants.forEach((v, i) => {
      const s = variantScores[i];
      trail.push({
        round: 0, kind: `variant ${v.letter}`, model: multiRes.modelId || planModel,
        elapsedMs: Date.now() - t0, cost: i === 0 ? costOf(multiRes) : 0,
        arc: v.arc, changed: null, analysis: null, scores: s.per, mean: s.mean,
      });
      log.info(`🧭 [ARC] variant ${v.letter}: mean ${s.mean ?? '—'}`);
    });
    const ranked = [...trail].filter(x => x.mean != null).sort((a, b) => b.mean - a.mean);
    const winner = ranked[0] || trail[0];
    arc = winner.arc;

    // The final call: keep the winner's shape, take from the others only what
    // they did better. Scored like any other round so "did merging help" is a
    // number and not a claim.
    const others = trail.filter(x => x !== winner).map((x, i) => `--- OTHER ${i + 1} ---\n${x.arc}`).join('\n\n');
    const tf = Date.now();
    const finalRes = await callTextModelStreaming(
      `${planPrompt}\n\nHere is the arc to ship:\n\n${arc}\n\nHere are the other arcs written for the same book:\n\n${others}\n\nKeep the shipping arc's shape. Take from the others only what they do better — a sharper reversal, a real cost, a blocker with its own want, a character change that is a change rather than a restatement — and fold it in. Change nothing that is already working. Output the ---ARC--- block only.`,
      null, null, planModel, { usageLabel: 'testlab_arc_merge' });
    const merged = parseBeats(finalRes.text || '').arc || String(finalRes.text || '').trim();
    if (merged) {
      const s = await scoreArc(merged);
      trail.push({
        round: 0.5, kind: `merge (from ${winner.kind})`, model: finalRes.modelId || planModel,
        elapsedMs: Date.now() - tf, cost: costOf(finalRes),
        arc: merged, changed: merged !== arc, analysis: null, scores: s.per, mean: s.mean,
      });
      log.info(`🧭 [ARC] merge: mean ${s.mean ?? '—'} (winner was ${winner.kind} at ${winner.mean})`);
      // Only carry the merge forward if it did not lose ground.
      if (s.mean != null && winner.mean != null && s.mean >= winner.mean) arc = merged;
    }
  } else {
    const t0 = Date.now();
    const planRes = await callTextModelStreaming(planPrompt, null, null, planModel, { usageLabel: 'testlab_arc_plan' });
    const planned = parseBeats(planRes.text || '').arc || String(planRes.text || '').trim();
    if (!planned) throw new Error('planner returned no arc');
    const planScore = await scoreArc(planned);
    trail.push({
      round: 0, kind: 'plan', model: planRes.modelId || planModel,
      elapsedMs: Date.now() - t0, cost: costOf(planRes),
      arc: planned, changed: null, analysis: null,
      scores: planScore.per, mean: planScore.mean,
    });
    arc = planned;
  }
  for (let r = 1; r <= rounds; r++) {
    const model = reviewModels[(r - 1) % reviewModels.length];
    const prompt = buildArcReviewPrompt({ ...storyData, pages: pageCount }, arc);
    if (!prompt) throw new Error('story-arc-review template unavailable');
    const t = Date.now();
    let res;
    try {
      res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_arc_review' });
    } catch (err) {
      trail.push({ round: r, kind: 'review', model, error: err.message });
      continue;
    }
    const { analysis, arc: revised } = parseArcReview(res.text || '');
    const next = revised && revised.trim() ? revised.trim() : arc;
    const changed = next !== arc;
    arc = next;
    const s = await scoreArc(arc);
    trail.push({
      round: r, kind: 'review', model: res.modelId || model,
      elapsedMs: Date.now() - t, cost: costOf(res),
      arc, changed, analysis: analysis.slice(0, 8000),
      scores: s.per, mean: s.mean,
    });
    log.info(`🧭 [ARC] round ${r} by ${model}: mean ${s.mean ?? '—'} (${changed ? 'rewritten' : 'unchanged'})`);
  }

  const means = trail.map(x => x.mean).filter(x => x != null);
  const best = trail.reduce((b, x) => (x.mean != null && (!b || x.mean > b.mean) ? x : b), null);
  return {
    stageKind: 'arc_rounds',
    storyId: target.storyId,
    title: storyData.title || null,
    language: storyData.language || null,
    pageCount,
    planModel, reviewModels, judgeModels, rounds,
    ideaUsed: params.storyDetails ? String(params.storyDetails) : null,
    trail,
    // The whole point of the stage: where the curve stops paying.
    trajectory: means,
    bestRound: best ? best.round : null,
    totalCost: Number(trail.reduce((s, x) => s + (x.cost || 0), 0).toFixed(4)),
  };
}

const STORY_STAGES = {
  arc_rounds: runArcRoundsStage,
  cover: runCoverStage,
  cover_title_paintin: runCoverTitlePaintinStage,
  style_check: runStyleCheckStage,
  book_audit: runBookAuditStage,
  audit_replay: runAuditReplayStage,
  style_repair: runStyleRepairStage,
  outline_review: runOutlineReviewStage,
  text_refine: runTextRefineStage,
  beats_scenes: runBeatsScenesStage,
  scene_review_replay: runSceneReviewReplayStage,
  story_bible_replay: runStoryBibleReplayStage,
  story_text_replay: runStoryTextReplayStage,
  writer_compare: runWriterCompareStage,
  clothing_review: runClothingReviewStage,
  story_scorecard: runStoryScorecardStage,
  score_rejudge: runScoreRejudgeStage,
  beats_review_replay: runBeatsReviewReplayStage,
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
  // Capture every log line emitted while THIS stage runs and persist it on
  // the entry — faults (silent fallbacks, gate skips, cold-service retries)
  // must be visible in the lab UI, not only in Railway. Concurrent runs
  // (3 parallel redos) may interleave lines into each other's capture;
  // acceptable for a debugging aid. warn/error stored in full, info capped.
  const { addLogListener, removeLogListener } = require('../utils/logger');
  const captured = [];
  const listener = (level, line) => {
    if (captured.length >= 400) return;
    captured.push({ level, line: line.slice(0, 400) });
  };
  addLogListener(listener);
  // Capture every prompt this stage sends, at the text/image chokepoints, so no
  // stage has to remember to stash its own (promptCapture.js). The collector
  // lives outside the try so a THROWN stage still reports what it sent — that is
  // exactly when the prompt matters most.
  const { runWithPromptCapture } = require('./promptCapture');
  let sentPrompts = [];
  let result;
  try {
    const captureRun = await runWithPromptCapture(async () => {
      if (AVATAR_STAGES[stage]) {
        if (!target.character) throw new Error(`${stage} requires target.character`);
        return await AVATAR_STAGES[stage](target, opts);
      }
      if (STORY_STAGES[stage]) {
        if (!target.storyId) throw new Error(`${stage} requires target.storyId`);
        return await STORY_STAGES[stage](target, opts);
      }
      const runner = STAGE_RUNNERS[stage];
      if (!runner) throw new Error(`Unknown stage: ${stage}. Valid: ${[...Object.keys(STAGE_RUNNERS), ...Object.keys(AVATAR_STAGES), ...Object.keys(STORY_STAGES)].join(', ')}`);
      const ctx = await loadSceneContext(target.storyId, target.pageNumber);
      // The target itself, so a stage can read target-level fields that are not
      // scene context (e.g. eval_variance's pinned versionIndex). It lives on
      // the target rather than in params because a set's UNIQUE key is the
      // target JSON — that is what lets two versions of ONE page be two
      // separate members of the same set.
      ctx.target = target;
      return await runner(ctx, opts);
    });
    result = captureRun.result;
    sentPrompts = captureRun.prompts;
  } catch (err) {
    // Failed runs need the log MOST — attach it to the partial result the
    // route stores with the failure entry.
    removeLogListener(listener);
    err.partialResult = {
      ...(err.partialResult || {}),
      ...buildStageLog(captured),
      ...(err.capturedPrompts?.length ? { sentPrompts: err.capturedPrompts } : {}),
    };
    throw err;
  }
  removeLogListener(listener);
  return { ...result, ...buildStageLog(captured), ...(sentPrompts.length ? { sentPrompts } : {}) };
}

function buildStageLog(captured) {
  const warnings = captured.filter(l => l.level === 'warn' || l.level === 'error').map(l => `[${l.level}] ${l.line}`);
  const infos = captured.filter(l => l.level === 'info').map(l => l.line);
  // Full info log capped from the END (the tail is where failures happen).
  const lines = infos.length > 150 ? [`… ${infos.length - 150} earlier lines omitted`, ...infos.slice(-150)] : infos;
  return {
    logWarnings: warnings.length ? warnings.slice(0, 80) : undefined,
    logLines: lines.length ? lines : undefined,
  };
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
  resolveReplayParams,
  loadActivePageImage,
  checkRuleGenericity,
  // The scorecard judge itself. Every stage runner in this file already calls
  // it; exporting it lets a measurement score an arbitrary artifact (the text
  // after each refine round, a candidate rewrite) through the SAME evaluator
  // resolution and rubric as a stored scorecard, instead of a second copy of
  // the judge wiring drifting alongside it.
  scoreArtifactsWithJudge,
};
