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
const { assessSceneReview, assertReviewedArtifactUsable, pickReviewedBrief } = require('./sceneReviewGuard');
// Production's arguments for the beats writer/Art-Director calls, resolved from
// a stored story. Every replay stage builds its inputs through these so a
// divergent, thinner expression cannot be written a fourth time.
const { buildReplayTextArgs, buildReplaySceneOptions, resolveReplayArc, resolveReplayArcHints, resolveReplayCentralFigure } = require('./beatsReplayInputs');
// Production's evalOptions for evaluateImageQuality, resolved from a stored
// story. Same rule as above: every eval stage builds its options through this
// so a thinner, silently-check-disabling expression cannot be written again.
const { buildEvalReplayOptions } = require('./evalReplayInputs');

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
    // SCENE_HINT for evals — Lab/prod parity with repairPipeline (2026-08-31):
    // the AD brief the image was actually generated from, not the beats-scene
    // outlineExtract the render never saw.
    outlineHint: scene.description || scene.sceneDescription || scene.outlineExtract || scene.sceneHint || null,
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

/**
 * Which stored version a target pins, or null for "the active one".
 *
 * ONE definition, because the obvious spelling is wrong: `Number(null)` is 0,
 * so `Number.isFinite(Number(versionIndex))` turns the DEFAULT into a pin on
 * v0. Every site that reads a pin goes through here.
 */
function pinnedVersionIndex(versionIndex) {
  if (versionIndex === null || versionIndex === undefined || versionIndex === '') return null;
  const n = Number(versionIndex);
  return Number.isFinite(n) ? n : null;
}

async function loadActivePageImage(storyId, pageNumber, versionIndex = null, imageType = null) {
  _lastPageLoad = null;
  const { getActiveVersion, getStoryImage } = require('../services/database');
  const coverKey = pageNumber < 0 ? COVER_KEY_BY_PAGE[String(pageNumber)] : null;
  // null/undefined/'' mean "load the ACTIVE version". Number(null) is 0, so
  // the old isFinite(Number(versionIndex)) turned the DEFAULT into pinned v0:
  // every unpinned Lab load silently detected on v0, which is both the
  // loadedFrom={unrecorded} symptom AND the 2026-08-19 "detected on v0
  // although activeVersion=2" mystery (bug lab-unpinned-loads-v0).
  const pinned = pinnedVersionIndex(versionIndex);
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
/**
 * The one place that decides whether a brief override is real.
 *
 * `||` alone is not enough: a whitespace-only override is truthy, and passing it
 * through hands the judge a BLANK commission to score against. runSceneComposite
 * already guarded with .trim(); the eval contract did not, so the same input was
 * an override on one path and not on the other.
 */
function briefOverrideOf(params) {
  const v = params?.sceneDescriptionOverride;
  return typeof v === 'string' && v.trim() ? v : null;
}

function evalSceneDescription(ctx, params = null) {
  // A/B runs with sceneDescriptionOverride generate FROM the override — the
  // eval contract must be the same override, or the judge deducts for lacking
  // exactly the defects the override removed (observed: three P6 A/B renders
  // scored sem=0 against the stored brief's "gap in the railing"/"ankle-deep").
  return `${briefOverrideOf(params) || ctx.scene.sceneDescription || ''}`;
}

/**
 * SCENE_HINT for evals — the sibling of evalSceneDescription, and it must follow
 * the same override.
 *
 * The judge reads TWO copies of the commission: the eval contract (above) and
 * SCENE_HINT, which its own prompt calls authoritative. Threading an override
 * into one and not the other makes the judge score the new image against the
 * brief the override was written to REPLACE. Measured 2026-09-20: six page-10
 * A/B arms came back with issues of the form "the authoritative SCENE_HINT
 * states Julian should be clutching the egg against his chest" — the staging
 * that had just been deliberately removed. Two arms that rendered the
 * commissioned event scored -130 and 0 for it.
 */
function evalSceneHint(ctx, params = null) {
  return briefOverrideOf(params) || ctx.outlineHint || null;
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

  // THE PLATE AND THE GRID ARE RESOLVED BEFORE THE PROMPT (2026-09-18), because
  // the prompt has to know which references the call actually carries. This is
  // the same ordering production settled on 2026-09-15 (storyJobPipeline.js
  // `makeImagePrompt` + the 5a-pre-grid rebuild) and that images.js `iterate`
  // already had: build the grid, then build the prompt from the cells that are
  // in it. Nothing else moved — the reference-photo knobs (avatarSheets,
  // refCrop) still run after the prompt, exactly as before, because they change
  // the PIXELS of a character card and nothing the prompt reads.

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
  // background drops plate-borne elements and landmarks).
  let visualBibleGrid = null;
  let genLandmarkPhotos = ctx.landmarkPhotos;
  if (ctx.visualBible) {
    try {
      const refs = await buildPageCompositeRefs(ctx.visualBible, ctx.pageNumber, ctx.landmarkPhotos, {
        hasBackground: !!emptyScene,
        logTag: 'TESTLAB',
        // aboardOverride is the empty_scene stage's knob for stories whose
        // stored metadata predates the field; honour it here too so a Lab page
        // render matches production's grid exactly.
        aboardId: params.aboardOverride ?? ctx.scene?.sceneMetadata?.aboard ?? null,
        sceneMetadata: ctx.scene?.sceneMetadata ?? null,
      });
      visualBibleGrid = refs.visualBibleGrid;
      genLandmarkPhotos = refs.landmarkPhotos;
    } catch (err) {
      log.warn(`[TESTLAB] VB grid build failed (continuing without): ${err.message}`);
    }
  }

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
      {
        textPositionOverride: ctx.textPosition || undefined,
        skipVisualBible: isGrokImage,
        // THE ELEMENTS WHOSE REFERENCE RENDER RIDES WITH THIS CALL — the cells
        // the grid above actually holds, and nothing else. `rawElements` is set
        // by buildVisualBibleGrid from the cells whose bytes loaded, so an
        // element that was selected but has no usable render is correctly
        // absent. Without this the Lab's REQUIRED OBJECTS block claimed no
        // attached reference for any element while production's named them
        // ("The attached reference images include a rough image of X — match
        // its look"), so every Lab measurement of that block was made against a
        // prompt production never sends. Empty grid → empty set, which is the
        // honest answer, not a missing argument.
        vbRefElementIds: (visualBibleGrid?.rawElements || []).map(e => e.id).filter(Boolean),
      }
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
  // WARDROBE STATE AND THE LAB (2026-09-19). The default Lab path REPLAYS the
  // page's stored `referencePhotos`, which already carry whatever cell
  // production cropped — the `--off:` variant included — so the Lab measures the
  // same sheet production rendered against, by construction. The two knobs below
  // deliberately resolve a sheet themselves and are costumed-only experiments;
  // neither consults a `styled-` key, so neither can pick a wardrobe-state
  // variant, and that is the intent rather than an oversight.
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

  // refScale (TEST LAB ONLY — the VB cell-geometry experiment, 2026-09-19).
  // Varies how LARGE an element is DRAWN inside its reference cell relative to
  // the character card beside it, and nothing else: same prompt, same cells,
  // same contents. Nothing is added to a cell — padding is the cell's own
  // background, so the settled "no scale referent inside a cell" rule holds.
  //   elementIds + elementFrac: white-pad those elements' reference bytes by
  //     1/elementFrac, so `fit: contain` draws the object that much smaller.
  //   charFrac: white-pad each character reference VERTICALLY by 1/charFrac,
  //     so the card's figure is drawn that much smaller (and the leftover
  //     width hands the element column more room).
  if (params.refScale && typeof params.refScale === 'object') {
    const sharpLib = require('sharp');
    const padTo = async (b64, wMul, hMul) => {
      const buf = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const m = await sharpLib(buf).metadata();
      const W = Math.round(m.width * wMul);
      const H = Math.round(m.height * hMul);
      const out = await sharpLib({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
        .composite([{ input: buf, left: Math.round((W - m.width) / 2), top: Math.round((H - m.height) / 2) }])
        .jpeg({ quality: 92 }).toBuffer();
      return 'data:image/jpeg;base64,' + out.toString('base64');
    };
    const ef = Number(params.refScale.elementFrac);
    const ids = (params.refScale.elementIds || []).map(x => String(x).toUpperCase());
    if (ef > 0 && ef < 1 && ids.length && Array.isArray(visualBibleGrid?.rawElements)) {
      for (const el of visualBibleGrid.rawElements) {
        if (!ids.includes(String(el.id || '').toUpperCase()) || !el.imageData) continue;
        el.imageData = await padTo(el.imageData, 1 / ef, 1 / ef);
        log.info(`[TESTLAB] refScale: ${el.id} drawn at ${ef} of its cell`);
      }
    }
    const cf = Number(params.refScale.charFrac);
    if (cf > 0 && cf < 1) {
      for (const ph of ctx.referencePhotos) {
        const src = ph.photoUrl || ph.photoData;
        if (!src) continue;
        ph.photoUrl = await padTo(src, 1, 1 / cf);
        ph.photoData = undefined;
      }
      log.info(`[TESTLAB] refScale: character cards drawn at ${cf} of their height`);
    }
  }

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, ctx.referencePhotos, {
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    // params.imageModel: A/B the page render model (grok-imagine vs
    // gemini-2.5-flash-image) — style-adherence routing tests. Null = prod default.
    imageModelOverride: params.imageModel || null,
    landmarkPhotos: genLandmarkPhotos,
    // Plate or fail, as in production: only a cast-0 page may render on its
    // landmark photo; any other landmark page needs the plate (emptyScene).
    landmarkScene: require('./landmarkScene').pageLandmarkScene({ sceneMetadata: ctx.scene?.sceneMetadata || null }),
    visualBibleGrid,
    artStyle,
    sceneBackground: emptyScene,
    textAreaMask,
    pageNumber: ctx.pageNumber,
    skipCache: true,
    // maxRefSlots: raise Grok's reference-slot budget above the production
    // default of 3 (xAI's documented edit cap is 5, re-verified 2026-09-02) —
    // e.g. give each of 4 characters their own slot instead of pairing 2-per-slot.
    maxRefSlots: params.maxRefSlots || null,
    // vbColumnFraction: the ONE variable of the 2026-09-19 cell-geometry
    // experiment - how wide the VB element column is, i.e. how large an
    // element is DRAWN. Character cards are height-limited and narrower than
    // either column width, so they render identically in both arms.
    vbColumnFraction: params.vbColumnFraction || null,
  });
  const elapsedMs = Date.now() - t0;
  if (!result?.imageData) throw new Error('Image generation returned no image');

  let scores = null;
  if (autoEval) {
    try {
      const { evaluateImageQuality } = require('./images');
      // PRODUCTION'S OPTION SET, one resolver (buildEvalReplayOptions). This
      // site used to pass five keys; without visualBible the judge's CLOTHING
      // CONTRACT still named a garment the page declared `off`, and without
      // artStyle every style-dependent rule skipped. See evalReplayInputs.js.
      // No figure count: these are FRESH bytes and no detector runs in this
      // stage, so the stored detection belongs to a different image. Null makes
      // the roster decline to judge the count rather than judge it against the
      // wrong picture.
      const replay = buildEvalReplayOptions(ctx, {
        detectedFigures: null,
        // The A/B renders in params.artStyleOverride when set — the judge must
        // be told the style it is actually looking at, not the story's.
        artStyleKey: params.artStyleOverride || undefined,
      });
      const evalRes = await evaluateImageQuality(
        result.imageData, evalSceneDescription(ctx, params), evalReferencePhotos(ctx), replay.evaluationType,
        null, `testlab-exp${experimentId}-P${ctx.pageNumber}`,
        ctx.scene.text || null, evalSceneHint(ctx, params), ctx.scene.sceneCharacters || null,
        replay.options
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

  // saveRefs: store the reference slots the call actually carried, so a
  // geometry experiment can be READ off the inputs instead of assumed.
  const steps = [];
  if (params.saveRefs && Array.isArray(result.packedRefs)) {
    for (let i = 0; i < result.packedRefs.length; i++) {
      const v = await saveTestVersion(ctx.storyId, 'tl_step', null, result.packedRefs[i], experimentId);
      steps.push({ label: `reference slot ${i + 1}`, imageType: 'tl_step', versionIndex: v });
    }
  }

  return { imageType: 'scene', versionIndex, promptUsed: prompt, modelId: result.modelId || null, elapsedMs, scores, artStyle: params.artStyleOverride || undefined, ...(steps.length ? { steps } : {}) };
}

async function runEmptySceneStage(ctx, { promptOverride, experimentId, params = {} }) {
  const { loadPromptTemplates, buildEmptyScenePrompt } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildTextZoneInstruction, buildEraGuard, buildLandmarkFidelityBlock, resolveArtStyle } = require('./storyHelpers');
  const { generateImageOnly } = require('./images');
  const { getTextAreaMask } = require('./textMasks');
  const { MODEL_DEFAULTS, emptyScenePlateRouting } = require('../config/models');

  const meta = ctx.scene.sceneMetadata || {};
  // descriptionOverride: test a corrected empty-scene brief (e.g. fixing a
  // contradictory exterior/interior description, or a stair-direction) without
  // regenerating the whole story. Falls back to the stored per-page description.
  const description = params.descriptionOverride || meta.emptyScenePrompt || ctx.scene.emptyScenePrompt || ctx.scene.sceneDescription;
  if (!description) throw new Error('No empty-scene description available for this page');

  // Text zone only when this story overlays text on the image AND the scene
  // has a position — production omits it for text-below layouts.
  const wantsTextZone = ctx.layout?.textInImage !== false && !!ctx.textPosition;
  // aboardOverride: test the aboard fix on a story whose stored AD metadata
  // predates the `aboard` field.
  const aboardId = params.aboardOverride ?? meta.aboard ?? null;
  // Production attaches the VB element grid to every plate call
  // (buildEmptySceneVbGrid); the Lab stage did not, so a plate rendered here
  // saw only the text channel and a prompt change that fixes the image channel
  // was invisible to the Lab. Same helper, same aboard filter.
  // Built BEFORE the prompt: which reference family is attached decides the
  // REFERENCE line (referenceKind below), exactly as at the production call
  // sites (storyJobPipeline.js Phase 5a-pre-vantage and the trial plate).
  const { buildEmptySceneVbGrid } = require('./referenceSheets');
  const emptySceneVbGrid = await buildEmptySceneVbGrid(
    ctx.visualBible, ctx.pageNumber, ctx.landmarkPhotos, aboardId, meta.objects || null
  );

  // One style string for the plate prompt and its QC, and the SAME one
  // production sends: the book's full style (storyJobPipeline.js plate call
  // sites use resolveArtStyle). The stripped "empty-scene" variant collapsed
  // pixar to "Never photographic." and dropped "watercolor" (2026-09-25).
  const plateStyle = resolveArtStyle(params.artStyleOverride || ctx.artStyle || 'pixar') || '';
  const prompt = buildEmptyScenePrompt({
    template: promptOverride || undefined,
    style: plateStyle,
    description,
    characterSpace: meta.characterSpace || '',
    textAreaInstruction: wantsTextZone
      ? buildTextZoneInstruction(ctx.textPosition, meta.textZoneDescription || null, 'a quarter of the frame', { isEmptyScene: true })
      : '',
    eraGuard: buildEraGuard(meta.era),
    landmarkFidelity: buildLandmarkFidelityBlock(ctx.landmarkPhotos[0] || null, { era: meta.era }),
    // Tells the model what the attached reference IS. Without it the Lab tested
    // a DIFFERENT prompt than production, which passes it at every plate call
    // site (storyJobPipeline.js vantage plate + retry, the per-page 5a-pre path,
    // and the trial plate — every one of them passes it).
    referenceKind: (ctx.landmarkPhotos?.length > 0) ? 'landmark' : (emptySceneVbGrid ? 'element' : null),
    visualBible: ctx.visualBible,
    pageNumber: ctx.pageNumber ?? null,
    aboardId,
    // AD objects[] gates which vehicles enter the plate prompt + grid — same
    // gate production runs (AD is the authority on vehicle presence).
    sceneObjects: meta.objects || null,
    // The page's declared time of day and weather — the plate's LIGHT line, as
    // at every production plate call site (sceneLight.js).
    light: require('./sceneLight').declaredLight(meta),
    // The geometry facts the plate is GRADED on (validateEmptyScene reads the
    // same scene prose). Production passes these at every page/vantage plate
    // call site; without them the Lab renders a plate blind to the geometry and
    // measures a different prompt than production runs.
    mainScenePrompt: ctx.scene.sceneDescription || null,
    castNames: (meta.fullData?.characters || meta.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
  });

  const t0 = Date.now();
  const result = await generateImageOnly(prompt, [], {
    // Plates stay on the plate tier regardless of the page tier — same pinned
    // routing as every production plate call site (docs/image-routing.md).
    ...emptyScenePlateRouting(),
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    landmarkPhotos: ctx.landmarkPhotos,
    visualBibleGrid: emptySceneVbGrid,
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
      artStyle: plateStyle,
      shot: (meta.fullData?.shot || meta.shot || '').trim() || null,
      landmarkPhoto: ctx.landmarkPhotos?.[0] || null,
      light: require('./sceneLight').declaredLight(meta),
    });
    qc = { pass: qcRes.pass, issues: qcRes.issues || [], findings: qcRes.findings || [], visionFeedback: qcRes.visionFeedback || null };
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

  // A pinned target evaluates THAT version (2026-09-12). Without this the stage
  // always judged the active one, so two versions of a page — an original and
  // the repair that replaced it — could not be scored against each other.
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, ctx.versionIndex ?? null);
  const t0 = Date.now();
  // PRODUCTION'S OPTION SET (buildEvalReplayOptions) + this stage's explicit
  // A/B knobs. The baseline must equal production; the overrides are the point
  // of the experiment. visualBible / clothingRequirements / storyData were all
  // missing here, which is why every clothing finding this stage has ever
  // produced was judged against the unstripped story-level outfit.
  const replay = buildEvalReplayOptions(ctx, {
    // The stored detection was made on the ACTIVE version's bytes. When a
    // different version is pinned it describes a different picture, so the
    // count is withheld rather than guessed.
    detectedFigures: (ctx.versionIndex ?? null) === null
      ? (ctx.scene.bboxDetection?.figures || null) : null,
    overrides: {
      evalTemplateOverride: promptOverride || null,
      // Stage-2 compliance A/B: swap the model (default qwen-plus) and/or its
      // template to test the over-strict-CRITICAL problem.
      complianceModelOverride: params.complianceModel || null,
      compliancePromptOverride: params.compliancePrompt || null,
      // THE COMPLIANCE JUDGE IS OFF IN PRODUCTION (2026-09-19,
      // MODEL_DEFAULTS.promptComplianceJudge). This stage's baseline must equal
      // production, so it follows the flag by default rather than forcing the
      // judge on — otherwise every image_eval run would score against a judge
      // prod never consults. Two ways to measure it anyway:
      //   - `complianceJudge: true` asks for it outright (how experiment 1333
      //     would be re-run);
      //   - setting `complianceModel` or `compliancePrompt` IS asking for it —
      //     an A/B on the judge's model or template is meaningless with the
      //     judge off, so either one implies it.
      complianceJudgeOverride: params.complianceJudge != null
        ? !!params.complianceJudge
        : ((params.complianceModel || params.compliancePrompt) ? true : null),
    },
  });
  const result = await evaluateImageQuality(
    imageData, evalSceneDescription(ctx), evalReferencePhotos(ctx), replay.evaluationType,
    // Quality-judge A/B (2026-09-08): params.model swaps the P2 judge (and,
    // because an override wins there too, the P1 inventory) for one experiment.
    params.model || null, `testlab-exp${experimentId}-P${ctx.pageNumber}`,
    ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
    replay.options
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
    // THE JUDGE'S OWN INVENTORY, raw. `figures` above is the DETECTION list and
    // carries name/match/issues; the judge returns its OWN figure objects —
    // zone, hair, clothing, action, view, items_held — inside `reasoning`, and
    // that is the only place a newly added schema field can be read back.
    // Measured 2026-09-21: a `gaze` field added to the figure schema came back
    // through `figures` as `{}` on all 13 figures, so the experiment could not
    // be scored in either direction. Same reason complianceRaw exists below.
    reasoning: result.reasoning || null,
    // The judge's parsed output as returned, BEFORE the fixable_issues mapper
    // and gates. Without it a rule the judge ignores and a finding a gate
    // dropped are indistinguishable in the Lab (2026-09-08, experiment 1057:
    // the inventory said `complete: false`, the prompt carried the rule, and
    // nothing arrived — no way to tell which side lost it).
    complianceRaw: result.threeStageResult?.complianceResult || null,
    // What RAN, not what was asked: the judge key and the per-stage token
    // counts (a model's input-token signature is how a swap is verified).
    modelId: params.model || require('../config/models').MODEL_DEFAULTS.qualityEval,
    usage: { ...(result.threeStageResult?.usage || {}), quality_input_tokens: result.usage?.input_tokens ?? null, quality_output_tokens: result.usage?.output_tokens ?? null },
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
  const versionIndex = pinnedVersionIndex(ctx.target?.versionIndex);
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, versionIndex);

  // Frozen inputs, resolved ONCE and reused by every repeat — re-deriving them
  // per run would let an input drift and be mistaken for judge variance.
  const sceneDescription = evalSceneDescription(ctx);
  const referencePhotos = evalReferencePhotos(ctx);
  // Production's option set, frozen with everything else. Measuring the judge's
  // variance against a THINNER input set than production's measures a different
  // judge: a missing visualBible turns the clothing contract into the
  // unstripped story-level outfit, and worn-item findings then flip on every
  // repeat for a reason that has nothing to do with judge stability.
  const replay = buildEvalReplayOptions(ctx, {
    // Frozen with the other inputs: a count that changed between repeats would
    // be read as judge variance. Withheld when a version is pinned (the stored
    // detection is the active version's).
    detectedFigures: versionIndex === null
      ? (ctx.scene.bboxDetection?.figures || null) : null,
  });

  const runs = [];
  for (let i = 1; i <= repeats; i++) {
    const t0 = Date.now();
    let evalResult = null;
    let error = null;
    try {
      evalResult = await evaluateImageQuality(
        imageData, sceneDescription, referencePhotos, replay.evaluationType,
        null, `testlab-var${experimentId}-P${ctx.pageNumber}-r${i}`,
        ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
        replay.options
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
          visualBible: ctx.visualBible || null,
          landmarkPhotos: ctx.scene?.landmarkPhotos || null,
          era: require('./landmarkProtection').resolveSceneEra(ctx.scene?.sceneMetadata),
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

  // A pinned target evaluates THAT version, as quality_eval and inventory_ab
  // already do — judging the active version instead makes an original-vs-repair
  // comparison compare the repair with itself.
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, ctx.versionIndex ?? null);
  const storyText = ctx.scene.text || null;
  if (!storyText) throw new Error('Scene has no story text — semantic eval needs it');

  // THE SIXTH ARGUMENT. Production never calls evaluateSemanticFidelity bare —
  // evalPipeline.js hands it the art style, the CLOTHING CONTRACT and the
  // EXPECTED CAST roster it built for all three judges. This stage passed none
  // of them, so its judge saw no outfit contract at all (clothing findings
  // suppressed outright) and no kind labels to keep an `(animal)` entry out of
  // the named-character count. Same three inputs, same builders.
  const replay = buildEvalReplayOptions(ctx, {
    detectedFigures: ctx.scene.bboxDetection?.figures || null,
  });
  const { buildExpectedCastBlock, buildEvalClothingContract } = require('./evalPipeline');
  const semanticOpts = {
    artStyle: replay.options.artStyle,
    clothingContract: buildEvalClothingContract({
      sceneCharacters: ctx.scene.sceneCharacters || null,
      referenceImages: evalReferencePhotos(ctx),
      artStyle: replay.options.artStyle,
      visualBible: replay.options.visualBible,
      clothingRequirements: replay.options.clothingRequirements,
      sceneMetadata: replay.options.sceneMetadata,
      sceneHint: ctx.outlineHint,
      originalPrompt: ctx.scene.sceneDescription || '',
    }).block,
    expectedCast: buildExpectedCastBlock({
      sceneCharacters: ctx.scene.sceneCharacters || null,
      sceneHint: ctx.outlineHint,
      originalPrompt: ctx.scene.sceneDescription || '',
      visualBible: replay.options.visualBible,
      evaluationType: replay.evaluationType,
      detectedFigureCount: Array.isArray(replay.options.detectedFigures)
        ? require('./bboxDetection').countRealFigures(replay.options.detectedFigures) : null,
      pageLabel: `testlab-exp${experimentId}-P${ctx.pageNumber} `,
      sceneMetadata: replay.options.sceneMetadata,
      storyData: replay.options.storyData,
      pageNumber: replay.options.pageNumber,
    }).block,
    // THE LANDMARK BLOCK — the fourth input production hands this judge since
    // 2026-09-18. Built from the replay's own landmarkPhotos + era, by the same
    // builder evalPipeline uses, so a Lab arm judges the page production judges.
    landmarkContext: require('./landmarkProtection').buildLandmarkContextBlock(
      require('./landmarkProtection').computeLandmarkProtection({
        landmarkPhotos: replay.options.landmarkPhotos,
        era: replay.options.era,
      })),
  };

  const t0 = Date.now();
  const result = await evaluateSemanticFidelity(
    imageData, storyText, ctx.scene.sceneDescription,
    ctx.outlineHint, promptOverride || null, semanticOpts
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
  const _pinnedParam = pinnedVersionIndex(params.versionIndex);
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
 * THE THIRD WITNESS, ALONE, ON A STORED CONTESTED PAGE — one VLM call, no DINO.
 *
 * `reconcileIdentityWithSecondWitness` (4ef21cc6c) asks a second model who is
 * who when the evaluator and the detector disagree, and lets that answer VETO
 * the detector's rename. The plumbing is proven byte-identical under every
 * stubbed witness; what was never measured is whether the REAL witness ever
 * contradicts the detector — it answers the same question, from the same badged
 * image, under the same prompt, so it is drawn from the detector's own
 * distribution and confirmation is the expected failure mode.
 *
 * This stage measures exactly that, and nothing else. It replays the vote over
 * ONE stored version: the page image as it was, the stored
 * `bboxDetection.figures[]` and `expectedCharacters`, and the evaluator's OWN
 * names (un-renamed via `evaluatorReference`). The `bbox` stage cannot answer
 * the question — it would re-run DINO + SAM + the primary Gemini identity call,
 * so the boxes, the conflict and the witness would all move at once.
 *
 * Both outcomes are computed on the same inputs: `reconcileIdentity` with no
 * witness (what ships today) and `reconcileIdentityWithSecondWitness` with the
 * real one. `renamesWithheld` is the difference, which is the only thing the
 * veto can ever do.
 *
 * COSTS one OpenRouter Qwen2.5-VL-72B call per target (the tier below the
 * `gemini-full` that answered every stored page), plus one local composite.
 * THE WITNESS IS NOT GUARANTEED TO BE QWEN: the SoM chain falls through on a
 * failure, and 3 of 19 targets in experiment 1325 met `Qwen-VL HTTP 429` and
 * were answered by `haiku-full` instead — so `witnessModel` is reported per
 * entry rather than assumed, and a run's model mix is part of its result.
 *
 * params.groundTruth  'detector' | 'evaluator' — a PIXEL-JUDGED verdict for
 *                     this version, carried as data on the target rather than
 *                     baked into this file. Lab set 66 / experiment 1324
 *                     downloaded and eyeballed four such pages. With it the
 *                     entry classifies itself: a withheld rename on a
 *                     detector-right page is a FALSE veto, on an
 *                     evaluator-right page a TRUE one.
 */
async function runIdentitySecondOpinionStage(ctx, { params = {} }) {
  const { reconcileIdentity, reconcileIdentityWithSecondWitness } = require('./identityAgreement');
  const { secondOpinionIdentity } = require('./figureDetection');

  // A PIN IS MANDATORY HERE. The vote is a property of ONE stored version — the
  // active version of a page is routinely the one whose conflict was already
  // resolved, so an unpinned run would measure a different page than the one
  // named. Fail loudly rather than answer a question nobody asked.
  const versionIndex = ctx.versionIndex != null ? ctx.versionIndex : pinnedVersionIndex(params.versionIndex);
  if (versionIndex == null) {
    throw new Error('identity_second_opinion requires a pinned versionIndex — the contested conflict belongs to one stored version, not to whatever won pick-best');
  }
  const versions = Array.isArray(ctx.scene.imageVersions) ? ctx.scene.imageVersions : [];
  const version = versions[versionIndex];
  if (!version) throw new Error(`No stored imageVersions[${versionIndex}] for ${ctx.storyId} p${ctx.pageNumber} (page has ${versions.length})`);

  const figures = JSON.parse(JSON.stringify(version.bboxDetection?.figures || []));
  const expectedCharacters = JSON.parse(JSON.stringify(version.bboxDetection?.expectedCharacters || []));
  if (figures.length === 0) throw new Error(`v${versionIndex} has no bboxDetection.figures — there is nothing to re-badge`);
  if (expectedCharacters.length === 0) throw new Error(`v${versionIndex} has no bboxDetection.expectedCharacters — the witness would have no cast to choose from`);

  // WHAT THE EVALUATOR SAID, not what the page ended up storing. A stored match
  // whose name the detector overwrote carries the detector's name in
  // `reference` and the evaluator's in `evaluatorReference`; replaying against
  // the rewritten names would hand the witness a page the two sides agree on.
  const evaluatorMatches = (version.matches || []).map(m => ({ ...m, reference: (m && m.evaluatorReference) || (m && m.reference) }));
  const evalLikeOf = () => ({
    matches: JSON.parse(JSON.stringify(evaluatorMatches)),
    fixableIssues: JSON.parse(JSON.stringify(version.fixableIssues || [])),
    fixTargets: [],
  });

  // Which model answered the PRIMARY identity pass, so the witness is not that
  // model asked twice — production reads the same field.
  const primaryModel = version.bboxDetection?.gdinoDiag?.identity?.model || null;

  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber, versionIndex);

  // THE COUNTERFACTUAL, ON THE SAME INPUTS. Without it the entry can say what
  // the witness answered but not whether that answer changed anything, and the
  // veto's only possible effect is a difference in renames.
  const baseline = reconcileIdentity(evalLikeOf(), JSON.parse(JSON.stringify(figures)), {});

  let witnessRaw = null;
  let witnessError = null;
  const t0 = Date.now();
  const report = await reconcileIdentityWithSecondWitness(evalLikeOf(), figures, {
    secondOpinion: async () => {
      try {
        witnessRaw = await secondOpinionIdentity(
          imageData, figures, expectedCharacters, `PAGE ${ctx.pageNumber} v${versionIndex}: `,
          { excludeModel: primaryModel },
        );
      } catch (err) {
        witnessError = err.message;
        throw err;
      }
      return witnessRaw;
    },
  });
  const elapsedMs = Date.now() - t0;

  const conflicts = (report?.conflicts || []).map(c => ({
    evaluator: c.evaluator, detector: c.detector, on: c.on,
    centreDistance: c.centreDistance, detIndex: c.detIndex,
  }));
  const votes = report?.secondWitness?.votes || [];
  const vetoed = report?.secondWitness?.vetoed || 0;
  const renamesWithheld = (baseline?.renamed || 0) - (report?.renamed || 0);

  // The witness's WHOLE answer, not only the contested figures — a witness that
  // renamed every figure on the page is a different finding from one that
  // disagreed about two, and the votes alone cannot tell them apart.
  const witnessByFigure = [];
  if (witnessRaw?.nameByFigure) {
    for (const [figIdx, name] of witnessRaw.nameByFigure) {
      witnessByFigure.push({ figureIndex: figIdx, detector: figures[figIdx]?.name || null, witness: name });
    }
    witnessByFigure.sort((a, b) => a.figureIndex - b.figureIndex);
  }

  // SELF-CLASSIFYING AGAINST A PIXEL VERDICT. A veto is only good or bad
  // relative to who was actually right, and an agreement rate on its own
  // cannot distinguish the two.
  const groundTruth = params.groundTruth || null;
  let vetoClass = null;
  if (groundTruth === 'detector') vetoClass = renamesWithheld > 0 ? 'false-veto' : 'correct-no-veto';
  else if (groundTruth === 'evaluator') vetoClass = renamesWithheld > 0 ? 'true-veto' : 'missed-veto';

  const witnessModel = report?.secondWitness?.model || witnessRaw?.model || null;
  const pairs = conflicts.map(c => `${c.evaluator}→${c.detector}`).join(', ');
  const said = votes.length
    ? votes.map(v => `${v.witness || '—'} (${v.verdict})`).join(', ')
    : (witnessError ? `call failed: ${witnessError}` : 'no answer');
  const note = [
    `p${ctx.pageNumber} v${versionIndex} · conflict ${pairs || '(none)'}`,
    `witness ${witnessModel || 'none'} said ${said}`,
    `veto ${vetoed}/${conflicts.length}`,
    `renames ${baseline?.renamed || 0} → ${report?.renamed || 0}${renamesWithheld > 0 ? ` (WITHHELD ${renamesWithheld})` : ''}`,
    groundTruth ? `pixel truth: ${groundTruth}-right → ${vetoClass}` : 'no pixel truth',
  ].join(' · ');
  // Into the captured run log, which is what the Lab card renders today.
  log.info(`🗳️ [TESTLAB] identity_second_opinion ${ctx.storyId} ${note}`);
  for (const w of witnessByFigure) {
    log.info(`🗳️ [TESTLAB]   figure ${w.figureIndex}: detector=${w.detector} witness=${w.witness}`);
  }

  return {
    elapsedMs,
    note,
    versionIndex,
    primaryIdentityModel: primaryModel,
    witnessModel,
    witnessAnswered: !!report?.secondWitness?.answered,
    witnessReason: report?.secondWitness?.reason || null,
    witnessError,
    witnessAttempts: witnessRaw?.attempts || [],
    expectedCharacters: expectedCharacters.map(c => c.name),
    detectorFigures: figures.map((f, i) => ({ figureIndex: i, name: f.name })),
    evaluatorMatches: evaluatorMatches.map(m => m.reference),
    conflicts,
    witnessByFigure,
    votes,
    vetoed,
    renamesWithheld,
    withoutWitness: { renamed: baseline?.renamed || 0, uncorrectable: !!baseline?.uncorrectable, uncorrectableReason: baseline?.uncorrectableReason || null },
    withWitness: { renamed: report?.renamed || 0, uncorrectable: !!report?.uncorrectable, uncorrectableReason: report?.uncorrectableReason || null },
    groundTruth,
    vetoClass,
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

// The repair name map for a Lab page context — the production builder
// (repairLogic.buildPageRepairNameMap), fed from the fields the context loads.
function labRepairNames(ctx) {
  return require('./repairLogic').buildPageRepairNameMap({
    storyData: { characters: ctx.characters, visualBible: ctx.visualBible, clothingRequirements: ctx.clothingRequirements, artStyle: ctx.artStyle },
    sceneDescription: ctx.scene?.sceneDescription || ctx.scene?.description || '',
    detectedFigures: ctx.scene?.bboxDetection?.figures || null,
    pageNumber: ctx.pageNumber,
  });
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
  const pinnedVersion = pinnedVersionIndex(ctx.target?.versionIndex);
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
    defectTypes: Array.isArray(params.issueTypes) ? params.issueTypes : null,
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
      // sourceImageFp along for the ride: fp-guarded mask rows refuse an
      // unstamped lookup (migration 034), and the Lab must reuse exactly what
      // production reuses or its result is not evidence about production.
      charName, { figures: ctx.scene.bboxDetection?.figures || [], sourceImageFp: ctx.scene.bboxDetection?.sourceImageFp || null },
      { storyId: ctx.storyId, pageNumber: ctx.pageNumber },
    ),
    protectedFaces,
    protectedBodies,
    textPosition: ctx.textPosition,
    includeDebug: true,
    // SAME AS PRODUCTION: pose lines name other figures by sight.
    repairNames: labRepairNames(ctx),
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
        issues.push({ name, severity: sev, points: pts, pages: [...pages].sort((x, y) => x - y), description: require('./scoring').findingText(issue) });
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
    characterAge: character.age ?? null,
    promptOverride: promptOverride || null,
  });
  if (!result?.imageData) throw new Error('style transfer returned no image');
  const versionIndex = await saveTestVersion(target.storyId, 'tl_avatar', null, result.imageData, experimentId,
    result.finalScore != null ? Math.round(result.finalScore) : null);
  return {
    character: character.name, imageType: 'tl_avatar', versionIndex,
    pass: 2, artStyle, realisticVersionIndex,
    finalScore: result.finalScore ?? null,
    // Production ships this sheet only when shippable (identity and solo
    // passed); the Lab keeps it either way so a rejected output can be seen.
    shippable: result.shippable, styleJudgeValid: result.valid,
    elapsedMs: Date.now() - t0,
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
  // Same split as production (plan covers-as-pages Q1/Q7, 2026-09-24): a
  // full-story cover is a page and renders through the page path; a trial
  // cover through iterateCover; a pre-change full-story cover is refused.
  const { coverIteratePath } = require('./coverBeats');
  if (coverIteratePath(storyData, coverKey) === 'page') {
    if (params.composite === true || promptOverride || params.skipTypography === true) {
      throw new Error('cover stage: composite / promptOverride / skipTypography are trial-cover (iterateCover) levers — a full-story cover renders through the page path');
    }
    const { mergeFreshAvatars } = require('./characterPhotos');
    storyData.characters = mergeFreshAvatars(storyData.characters || [], freshCharacters, storyData.artStyle || 'pixar');
    const pageResult = await require('./coverRender').iterateFullStoryCover(coverKey, storyData, {
      modelOverrides: params.imageModel ? { imageModel: params.imageModel } : {},
    });
    const elapsed = Date.now() - t0;
    if (!pageResult?.imageData) throw new Error('Cover render returned no image');
    const vIdx = await saveTestVersion(
      target.storyId, coverKey, null, pageResult.imageData, experimentId,
      pageResult.score != null ? Math.round(pageResult.score) : null
    );
    return {
      imageType: coverKey, coverType: coverKey, versionIndex: vIdx,
      promptUsed: pageResult.prompt || null, modelId: pageResult.modelId || null, elapsedMs: elapsed,
      scores: { final: pageResult.score ?? null },
      issuesSummary: pageResult.reasoning || null,
      sceneUsed: pageResult.newScene || null,
    };
  }
  const result = await iterateCover(coverKey, storyData, {
    // params.imageModel: A/B the cover render model (e.g. grok-imagine vs
    // gemini-2.5-flash-image) — style-adherence routing tests. Defaults to prod.
    imageModel: params.imageModel || MODEL_DEFAULTS.coverImage,
    // params.skipTypography: don't stamp the app-side title over the render —
    // required when the prompt under test bakes the title into the image.
    skipTypography: params.skipTypography === true,
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
        generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
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
  const { calculateTextCost } = require('../config/models');
  const { storyData } = await loadStoryDataFull(target.storyId);
  const t0 = Date.now();
  // Same collector every other paid Lab stage uses. Without a tracker
  // bookAudit's `if (usageTracker …)` branch never fires, so a Lab audit spent
  // real money and recorded nothing.
  const usage = [];
  // withTemplates, not a global assignment: the override must be visible only
  // inside this run's async tree so two concurrent experiments cannot read each
  // other's prompt.
  const audit = await withTemplates({ bookAudit: promptOverride }, () => auditStoryBook(storyData, {
    storyId: target.storyId,
    modelId: params.modelId || undefined,
    // Gemini 3 thinking level ('low'|'medium'|'high'). Lab-only: when the param
    // is absent nothing is sent and the model keeps its own default, so a
    // production audit is unchanged.
    thinkingLevel: params.thinkingLevel || undefined,
    // OpenRouter reports billed dollars (cost_usd); Gemini native reports tokens
    // only, so those are priced with the same table production uses.
    usageTracker: (provider, u, fnName, mid) => usage.push({
      provider, fn: fnName, modelId: mid,
      cost: u?.cost_usd ?? calculateTextCost(mid || '', u || {}),
    }),
  }));
  const modelCalls = usage.length;
  const cost = usage.reduce((a, u) => a + (u.cost || 0), 0);
  if (!audit) return { ok: false, elapsedMs: Date.now() - t0, faults: 0, byRoute: { IMG: [], TEXT: [] }, logLines: [], modelCalls, cost };
  return {
    ok: true,
    elapsedMs: Date.now() - t0,
    modelCalls,
    cost,
    modelId: audit.modelId,
    thinkingLevel: audit.thinkingLevel || null,
    usage: audit.usage,
    chunkUsage: audit.chunkUsage,
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
 * params.level  : 'arc' | 'text' | 'text-blind' (required). 'text-blind' is the
 *                 second production text auditor (owner ruling 2026-09-03):
 *                 the pages and nothing else. 'beats' was retired 2026-09-01
 *                 along with the rest of the beats-review/audit machinery —
 *                 the production beats layer no longer runs a reviewer or
 *                 auditor (see planCheck in promptBuilders.js).
 * params.fromWriterText : text levels — audit data.writerText (the draft the
 *                 production audits read) instead of the shipped text
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
  if (level === 'beats') throw new Error('audit_replay level=beats retired 2026-09-01 — the beats review/audit machinery was deleted (docs/decisions.md)');
  if (!['arc', 'text', 'text-blind'].includes(level)) throw new Error(`params.level must be arc | text | text-blind, got "${params.level}"`);
  const defaultModel = level === 'text'
    ? (MODEL_DEFAULTS.textAuditModel || MODEL_DEFAULTS.arcReviewModel)
    : level === 'text-blind'
      ? MODEL_DEFAULTS.textAuditBlindModel
      : (MODEL_DEFAULTS.arcAuditModel || MODEL_DEFAULTS.arcReviewModel);
  const models = String(params.models || params.model || defaultModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const outline = String(storyData.outline || '');
  let prompt = null;
  let templateKey = null;
  // The arc, for both branches. The text branch used to omit it from
  // buildTextAuditPrompt's third argument, so the replay's STORY_ARC read
  // "(no story was recorded)" while production (textRefine.js) passes the arc —
  // the LOADBEARING question could not fire in the Lab and fault counts came
  // out lower for reasons that had nothing to do with the prompt under test.
  const arc = H.parseBeats(outline).arc || storyData.beatsReviewReport?.arc || '';
  if (level === 'arc') {
    templateKey = 'storyArcAudit';
    if (!arc.trim()) throw new Error('story has no stored arc to audit');
    prompt = H.buildArcAuditPrompt(storyData, arc);
  } else {
    const blind = level === 'text-blind';
    templateKey = blind ? 'storyTextAuditBlind' : 'storyTextAudit';
    // Production's own page extractor, so the replay's THE PICTURE SHOWS and
    // PLAN_LINES come from the same sources by the same code. The hand-built
    // copy this replaced carried the untrimmed brief and no plan line, so the
    // replay audited against a longer spec and "(no page plan was recorded)".
    const { extractRefinablePages } = require('./textRefine');
    const pages = extractRefinablePages(storyData.sceneImages || [], { visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });
    if (!pages.length) throw new Error('story has no page text to audit');
    // params.fromExperiment (2026-09-23): audit the page text a stored Lab
    // writer run produced (story_text_replay's results[i].pages) instead of the
    // story's shipped text — so an audit prompt change is measured on the exact
    // writer output whose faults motivated it. Briefs and plan lines stay the
    // story's own; only the prose is swapped.
    if (params.fromExperiment) {
      const { dbQuery } = require('../services/database');
      const expId = Number(params.fromExperiment);
      const idx = Number(params.fromResultIndex || 0);
      const rows = await dbQuery('SELECT results FROM testlab_experiments WHERE id = $1', [expId]);
      const src = rows[0]?.results?.[idx];
      if (!src) throw new Error(`fromExperiment: experiment #${expId} has no result #${idx}`);
      if (src.storyId !== target.storyId) throw new Error(`fromExperiment: result #${idx} of #${expId} is story ${src.storyId}, not ${target.storyId}`);
      const textOf = new Map((src.pages || []).filter(p => String(p?.text || '').trim()).map(p => [p.pageNumber, String(p.text)]));
      if (!textOf.size) throw new Error(`fromExperiment: result #${idx} of #${expId} stored no page text`);
      const missing = pages.filter(p => !textOf.has(p.pageNumber)).map(p => p.pageNumber);
      if (missing.length) throw new Error(`fromExperiment: #${expId} has no text for page(s) ${missing.join(', ')}`);
      for (const p of pages) p.text = textOf.get(p.pageNumber);
    }
    // params.fromWriterText (2026-09-24): audit the writer's draft
    // (data.writerText, frozen since 2026-08-25) — the text the production
    // audits actually read, before the refine, diff and lector changed it.
    // The shipped text is post-refine, so replaying an audit on it measures
    // recall on faults the chain has already removed.
    if (params.fromWriterText === true || params.fromWriterText === 'true') {
      if (params.fromExperiment) throw new Error('fromWriterText and fromExperiment are exclusive — pick one text source');
      const draft = H.parseStoryPages(String(storyData.writerText || ''));
      if (!draft.length) throw new Error(`story ${target.storyId} has no stored writerText`);
      const textOf = new Map(draft.map(d => [d.pageNumber, d.content]));
      const missing = pages.filter(p => !textOf.has(p.pageNumber)).map(p => p.pageNumber);
      if (missing.length) throw new Error(`fromWriterText: writerText has no page(s) ${missing.join(', ')}`);
      for (const p of pages) p.text = textOf.get(p.pageNumber);
    }
    prompt = blind
      ? H.buildTextAuditBlindPrompt(storyData, pages)
      : H.buildTextAuditPrompt(storyData, pages, arc, { arcHints: resolveReplayArcHints(storyData) });
  }
  if (!prompt) throw new Error(`${templateKey} template unavailable`);

  const t0 = Date.now();
  const runs = await Promise.all(models.map(async (model) => {
    const t = Date.now();
    try {
      const res = await withTemplates({ [templateKey]: promptOverride }, () =>
        callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_audit_replay', temperature: 0 }));
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
 * Scene hazard count — the MEASUREMENT for the hazard-reduction loop. Target:
 * {storyId}. A judge reads a book's Art Director briefs (all pages at once, so
 * per-page hazards are counted against one frozen artifact) and emits one
 * HAZARD[<CLASS>] line per finding plus a total. Report only: nothing is
 * written back to the story, no image is produced.
 *
 * The artifact is frozen and temperature is 0, so the only variable is the
 * model (or an overridden prompt) — same shape as audit_replay. Run it before
 * and after a scene-expansion prompt change to see whether the hazard count
 * actually moved.
 *
 * params.models : comma list of TEXT_MODELS keys (default sceneReviewModel)
 * params.source : 'briefs' (default, data.sceneImages[].sceneDescription)
 *                 | 'beats' (PLAN lines from the stored outline's ---BEATS---; legacy SCENE lines parse the same)
 */
const HAZARD_CLASSES = ['CROWD', 'MULTIACT', 'GAZE', 'CONTACT', 'FORCE', 'ELEV', 'UNHELD', 'NEG', 'SCALE', 'TEMPORAL', 'LOC', 'SHOT'];

async function runSceneHazardCountStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
  await loadPromptTemplates();
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');
  const { parseBeats } = require('./storyHelpers');

  const source = String(params.source || 'briefs').toLowerCase();
  if (!['briefs', 'beats'].includes(source)) throw new Error(`params.source must be briefs | beats, got "${params.source}"`);
  const models = String(params.models || params.model || MODEL_DEFAULTS.sceneReviewModel || MODEL_DEFAULTS.outlineReviewModel)
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  let pages;
  let storyTitle = null;
  if (params.fromExperiment) {
    // A/B leg: count a beats_scenes regeneration's output instead of the
    // stored story — same judge, same template, only the artifact differs.
    const { dbQuery } = require('../services/database');
    const expId = parseInt(params.fromExperiment, 10);
    // dbQuery returns the rows array itself (database.js).
    const rows = await dbQuery('SELECT results FROM testlab_experiments WHERE id = $1', [expId]);
    if (!rows.length) throw new Error(`fromExperiment ${expId}: not found`);
    const out = (rows[0].results || [])[0] || {};
    storyTitle = out.title || null;
    if (source === 'beats') {
      pages = (out.finalBeats || [])
        .filter(p => String(p.planLine || p.scene || '').trim())
        .map(p => ({ pageNumber: p.pageNumber, brief: p.planLine || p.scene }));
      if (!pages.length) throw new Error(`fromExperiment ${expId}: no finalBeats PLAN lines in result`);
    } else {
      // fromBeats = the raw expansion; reviewedBrief = after the scene review
      // rewrote it. params.artifact picks the measurement: 'raw' isolates the
      // Art Director, 'reviewed' (default) measures the AD+reviewer chain.
      // params.reviewer = '<TEXT_MODELS key>' picks ONE reviewer's rewrites out
      // of a multi-reviewer fan-out (reviewedBriefs[modelKey]); a reviewer that
      // is absent or failed is refused, never swapped for the primary. A failed
      // primary review refuses 'reviewed' outright: measuring fromBeats as
      // "reviewed" is how experiments 1109/1121/1122/1124 were misjudged.
      const useRaw = String(params.artifact || 'reviewed') === 'raw';
      const reviewer = params.reviewer ? String(params.reviewer).trim() : null;
      if (!useRaw && !reviewer) assertReviewedArtifactUsable(out, expId);
      pages = (out.sceneExpansions || [])
        .map(x => ({ pageNumber: x.pageNumber, brief: useRaw ? x.fromBeats : pickReviewedBrief(x, out, reviewer, expId) }))
        .filter(x => String(x.brief || '').trim());
      if (!pages.length) throw new Error(`fromExperiment ${expId}: no sceneExpansions in result`);
    }
  } else {
    const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
    storyTitle = storyData.title || null;
    if (source === 'beats') {
      const beatsSection = (String(storyData.outline || '')
        .match(/---\s*BEATS\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
      pages = parseBeats(beatsSection).pages
        .filter(p => String(p.planLine || '').trim())
        .map(p => ({ pageNumber: p.pageNumber, brief: p.planLine }));
      if (!pages.length) throw new Error('story has no stored beat PLAN lines to audit');
    } else {
      pages = (storyData.sceneImages || [])
        .filter(s => String(s.sceneDescription || '').trim())
        .map(s => ({ pageNumber: s.pageNumber, brief: s.sceneDescription }));
      if (!pages.length) throw new Error('story has no stored scene briefs to audit');
    }
  }

  // One prompt over ALL pages: a hazard count is only comparable when the judge
  // sees the same book each run. Each brief is capped so a long book cannot
  // push the call past the context the cheapest arm can take.
  const briefs = pages
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map(p => `## Page ${p.pageNumber}\n${String(p.brief).slice(0, 2000)}`)
    .join('\n\n');
  const template = promptOverride || PROMPT_TEMPLATES.sceneHazardAudit;
  if (!template) throw new Error('scene-hazard-audit template unavailable');
  const prompt = fillTemplate(template, { PAGE_COUNT: pages.length, BRIEFS: briefs });

  const t0 = Date.now();
  const runs = await Promise.all(models.map(async (model) => {
    const t = Date.now();
    try {
      const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_scene_hazard_count', temperature: 0 });
      const raw = String(res.text || '').trim();
      const lines = raw.split('\n').map(l => l.trim()).filter(l => /^HAZARD\[/.test(l));
      const byClass = {};
      for (const c of HAZARD_CLASSES) byClass[c] = 0;
      for (const l of lines) {
        const cls = (l.match(/^HAZARD\[([A-Z]+)\]/) || [])[1];
        if (cls) byClass[cls] = (byClass[cls] || 0) + 1;
      }
      // The judge's own total is advisory; the line count is what a rerun
      // compares, so a miscounted footer never moves the metric.
      const declared = parseInt((raw.match(/^HAZARDS:\s*(\d+)/mi) || [])[1], 10);
      return {
        model,
        modelId: res.modelId || TEXT_MODELS[model].modelId,
        ok: raw.length > 0,
        hazards: lines.length,
        declaredHazards: Number.isFinite(declared) ? declared : null,
        byClass,
        lines,
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
    stageKind: 'scene_hazard_count',
    storyId: target.storyId,
    title: storyTitle,
    source,
    pageCount: pages.length,
    elapsedMs: Date.now() - t0,
    promptChars: prompt.length,
    runs,
    totalCost: Number(runs.reduce((s, r) => s + (r.cost || 0), 0).toFixed(4)),
    logLines: runs.flatMap(r => [
      `— ${r.model}: ${r.ok
        ? `${r.hazards} hazard(s) over ${pages.length} pages [${Object.entries(r.byClass).filter(([, n]) => n > 0).map(([c, n]) => `${c}:${n}`).join(' ') || 'none'}], ${Math.round(r.elapsedMs / 1000)}s, $${(r.cost || 0).toFixed(3)}`
        : `FAILED ${r.error || 'empty output'}`}`,
      ...(r.lines || []),
    ]),
  };
}

/**
 * RETIRED 2026-09-13 — the outline_review stage is gone.
 *
 * It forced splitOutlineReview:true and measured buildUnifiedStoryPrompt +
 * buildOutlineReviewPrompt. storyJobPipeline gates that branch behind
 * "not beatsMode, not trialMode, splitOutlineReviewEnabled", and runtime.js sets
 * pipelineMode:'beats' in every environment — so production never makes either
 * call. The stage measured a configuration that cannot ship, and its beats
 * analogues are their own stages (arc_review, text_refine, scene_review).
 *
 * Stored experiments keep rendering: the result renderer keys off
 * result.stageKind === 'outline_review', which is untouched.
 */


/**
 * TEXT REFINEMENT — iterative, full text in / full text out.
 *
 * Distinct from the retired outline_review stage's `iterate` mode on purpose.
 * There, every round
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
 * Step 2 (the fast structural review) was retired 2026-09-01 along with the
 * rest of the beats-review/audit machinery — this stage now only plans
 * (Step 1) and expands scenes (Steps 3-4); `review`/`beatsReview` on the
 * result is always null for new runs (historical rows that have one still
 * display). `params.useStoredBeats` (the carry A/B harness) is retired too.
 *
 * params.beatsModel  : planner (default MODEL_DEFAULTS.outline)
 * params.pages       : page count (default: the story's own)
 * params.storyDetails : replace the story's own idea text. The idea is an input
 *   to the plan, so a change to the idea GENERATOR can only be measured by
 *   planning the same cast and setting from a different idea.
 */
/**
 * Land reviewer rewrites on the expansions. The FIRST reviewer is primary and
 * fills `reviewedBrief` / `reviewRewrote` (unchanged single-reviewer behaviour);
 * every OTHER reviewer that passed the truncation guard stores its rewrite in
 * `reviewedBriefs[modelKey]` so a multi-reviewer fan-out can be judged per
 * reviewer (scene_hazard_count params.reviewer). A failed reviewer stores
 * nothing — its pages must never read as reviewed. Pure; unit-tested.
 */
function applyReviewerPages(sceneExpansions, sceneReviews) {
  sceneReviews.forEach((r, i) => {
    if (!r || r.ok === false || !Array.isArray(r._pages)) return;
    const byPage = new Map(r._pages.map(x => [x.pageNumber, x.text]));
    for (const x of sceneExpansions) {
      const reviewed = byPage.get(x.pageNumber);
      if (!reviewed) continue;
      // Production's rule (beatsPipeline keepDeclaredWornRows): a reviewed
      // brief keeps every worn-state row the raw expansion declared.
      const carry = require('./wornItems').carryForwardWornItemsInBrief(reviewed, x.fromBeats);
      const fixed = carry ? carry.brief : reviewed;
      if (i === 0) { x.reviewedBrief = fixed; x.reviewRewrote = true; }
      else { (x.reviewedBriefs = x.reviewedBriefs || {})[r.modelKey] = fixed; }
    }
  });
  for (const r of sceneReviews) if (r) delete r._pages;
}

/**
 * The all-pages scene expansion, with production's recovery.
 *
 * WHY THIS EXISTS - Test Lab experiment 1275 (`beats_scenes`, 16 pages): the Art
 * Director's all-pages reply was cut mid-JSON inside page 9. The stage took every
 * `## Page N` chunk verbatim, so it reported sixteen expansions of which seven
 * were empty and one was half a spec - and the run still read as a success.
 * An experiment that reports 16 and measured 9 produces conclusions nobody can
 * trust. Production never had that hole: `beatsPipeline.js` refuses a brief that
 * fails the scene-brief contract, retries the batch once, and re-expands whatever
 * is still missing page by page. This is those three guards, calling the SAME
 * contract helper (`iterateBriefGuard.partitionSceneBriefs`), not a second copy.
 *
 * It is dependency-injected - the batch call, the parser, the per-page fallback -
 * because the stage around it needs a story, a DB and paid models, and the
 * recovery decisions must be pinnable without any of those.
 *
 * @param {object} o
 * @param {Array<{pageNumber:number}>} o.expected  pages the batch owes
 * @param {function():Promise<object>} o.callBatch  one paid all-pages call
 * @param {function(object):Array<{pageNumber:number,text:string}>} o.parsePages
 * @param {function(object):Promise<object>} o.expandOnePage  per-page fallback
 * @param {function(object):void} [o.onAttempt]  each reply, before parsing
 * @param {function(object):number} [o.costOf]
 * @param {number} [o.attempts=2]  batch attempts, production's number
 * @returns {Promise<{byPage:Map, recovered:Array, cost:number, lastRes:object|null, attemptsMade:number}>}
 */
async function collectAllPagesBriefs(o) {
  const { partitionSceneBriefs, describeSceneBrief } = require('./iterateBriefGuard');
  const expected = o.expected || [];
  const attempts = o.attempts || 2;
  const costOfRes = o.costOf || (() => 0);
  // First attempt's pages win, so a retry can only FILL gaps, never rewrite a
  // page already parsed.
  const byPage = new Map();
  let lastRes = null;
  let cost = 0;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    attemptsMade = attempt;
    try {
      res = await o.callBatch(attempt);
    } catch (err) {
      log.error(`\u{1F6A8} [TESTLAB] beats_scenes: all-pages attempt ${attempt} failed (${err.message}) - falling back to per-page expansion`);
      break;
    }
    lastRes = res;
    cost += costOfRes(res) || 0;
    if (o.onAttempt) o.onAttempt(res);
    const { whole, cut, formatWide } = partitionSceneBriefs(o.parsePages(res) || []);
    for (const p of (formatWide ? cut : whole)) {
      if (!byPage.has(p.pageNumber)) byPage.set(p.pageNumber, { text: p.text, res });
    }
    if (formatWide) {
      // Not one page meets the contract: the reply is in a shape the parser does
      // not know rather than a truncated one, and re-expanding a whole book page
      // by page would spend a paid call each to get the same shape back.
      log.error(`\u{1F6A8} [TESTLAB] beats_scenes attempt ${attempt}: not one of the ${cut.length} brief(s) meets the brief contract (${describeSceneBrief(cut[0].verdict)}) - accepting them as written rather than re-expanding the whole book`);
    } else if (cut.length > 0) {
      log.error(`\u{1F6A8} [TESTLAB] beats_scenes attempt ${attempt}: incomplete brief(s) - ${cut.map(p => `p${p.pageNumber} (${describeSceneBrief(p.verdict)})`).join('; ')} - treating them as NOT delivered`);
    }
    if (byPage.size >= expected.length) break;
    if (attempt < attempts) {
      const missingNow = expected.filter(b => !byPage.has(b.pageNumber)).map(b => b.pageNumber);
      log.error(`\u{1F6A8} [TESTLAB] beats_scenes: all-pages call returned ${byPage.size}/${expected.length} briefs, missing page(s) ${missingNow.join(', ')} - retrying the batch ONCE at full cap`);
    }
  }

  // Per-page fallback for whatever the batch still owes. A page that fails here
  // too stays a NON-result: ok:false and no brief text, so neither the scene
  // review nor the comparison can mistake half a spec for a measurement.
  let recovered = [];
  const stillMissing = expected.filter(b => !byPage.has(b.pageNumber));
  if (stillMissing.length > 0) {
    log.error(`\u{1F6A8} [TESTLAB] beats_scenes: ${byPage.size}/${expected.length} briefs after ${attemptsMade} batch attempt(s) - re-expanding page(s) ${stillMissing.map(b => b.pageNumber).join(', ')} per-page`);
    recovered = await Promise.all(stillMissing.map(b => o.expandOnePage(b)));
    for (const r of recovered) r.recoveredBy = 'per-page fallback';
    const okAgain = recovered.filter(r => r.ok).map(r => r.pageNumber);
    const lost = recovered.filter(r => !r.ok).map(r => r.pageNumber);
    log.error(`\u{1F6A8} [TESTLAB] beats_scenes: per-page fallback recovered page(s) ${okAgain.length ? okAgain.join(', ') : 'none'}; still missing ${lost.length ? lost.join(', ') : 'none'}`);
  }
  return { byPage, recovered, cost, lastRes, attemptsMade };
}

/**
 * "N of M pages measured" - the marker a partial beats_scenes run announces
 * itself with. Null when every page has a brief.
 */
function summarizeSceneExpansions(sceneExpansions) {
  const entries = (sceneExpansions || []).filter(Boolean);
  const measured = entries.filter(x => x.ok).map(x => x.pageNumber);
  const missingPages = entries.filter(x => !x.ok).map(x => x.pageNumber);
  if (missingPages.length === 0) return null;
  return {
    measured: measured.length,
    expected: entries.length,
    missingPages,
    message: `${measured.length} of ${entries.length} pages measured - no brief for page(s) ${missingPages.join(', ')} after the batch retry and the per-page fallback. Any conclusion from this run covers only the measured pages.`,
  };
}

async function runBeatsScenesStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildBeatsPrompt, parseBeats, parsePlanResponse } = require('./storyHelpers');
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
  if (!TEXT_MODELS[beatsModel]) throw new Error(`Unknown model "${beatsModel}"`);

  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});
  const lockStart = Date.now();
  let plainStoredBeats = null;

  // START FROM THE STORED BEATS (owner, 2026-08-25). The stage normally plans
  // and reviews beats from scratch, which measures the planner. To ask the
  // different question — can the Art Director and the text writer repair what
  // the plan left behind — the plan lines have to be the ones that actually
  // shipped, not a fresh draft. Every page keeps its own plan line in
  // `outlineExtract` ("PLAN: …"), so the shipped set is recoverable without
  // re-running anything. A story stored before 2026-09-02 keeps beat prose
  // there instead; that shape is not read (owner ruling: no legacy bridge) and
  // this stage refuses the story by name rather than replaying half of it.
  if (params.useStoredBeats || params.plainStoredBeats) {
    const stored = (storyData.sceneImages || [])
      .map((s) => {
        const planLine = (String(s.outlineExtract || '').match(/(?:^|\n)\s*PLAN:\s*([\s\S]*)$/i) || [, ''])[1].trim();
        return planLine ? { pageNumber: s.pageNumber, planLine } : null;
      })
      .filter(Boolean);
    if (stored.length === 0) throw new Error(`stored beats: no page of story ${target?.storyId || '(unknown)'} carries an outlineExtract PLAN line — a pre-2026-09-02 story cannot be replayed`);
    // plainStoredBeats: hold the beats constant and fall through to the NORMAL
    // step-3 expansion + scene review — the Art Director bake-off path.
    if (params.useStoredBeats) {
      // stored_beats_carry_ab retired 2026-09-01 along with the beats-review/
      // audit machinery it carried (docs/decisions.md) — past experiment rows
      // with result.mode === 'stored_beats_carry_ab' still load and display;
      // no new run can be launched.
      throw new Error('stored_beats_carry_ab retired 2026-09-01 — the beats review/audit machinery was deleted (docs/decisions.md)');
    }
    plainStoredBeats = stored;
  }

  // ── Step 1: plan ────────────────────────────────────────────────────────
  // plainStoredBeats skips planning and review — the beats are the frozen input.
  let plannerPrompt = null;
  let planRes = null;
  let planMs = 0;
  let planParsed = null;
  if (!plainStoredBeats) {
    // The planner divides a finished story (2026-08-31): feed it the stored
    // story's arc so the Lab measures the production shape.
    // Production also passes `arcHints` alongside the arc (beatsPipeline.js:935)
    // — the "FIX WHILE DIVIDING" block. It was missing here.
    plannerPrompt = buildBeatsPrompt(storyData, pageCount, {
      finalArc: resolveReplayArc(storyData, { parseBeats }),
      arcHints: resolveReplayArcHints(storyData),
      centralFigure: resolveReplayCentralFigure(storyData),
    });
    if (!plannerPrompt) throw new Error('story-beats template unavailable');
    if (promptOverride) plannerPrompt = promptOverride;

    const t0 = Date.now();
    planRes = await callTextModelStreaming(plannerPrompt, null, null, beatsModel, { usageLabel: 'testlab_beats' });
    planMs = Date.now() - t0;
    planParsed = parsePlanResponse(planRes.text || '', expected);
    if (planParsed.pages.length === 0) throw new Error('Planner returned no parseable plan lines');
  }

  const plan = plainStoredBeats ? { source: 'stored-beats', pages: plainStoredBeats } : {
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

  // Step 2 (fast structural review) retired 2026-09-01 along with the rest of
  // the beats-review/audit machinery — buildBeatsReviewPrompt is deleted, so
  // `review` is always null now. `finalBeats` is just the planned beats;
  // BeatsScenesView (client) already renders `review` conditionally, so
  // historical experiment rows with a populated review still display.
  let review = null;
  let finalBeats = plainStoredBeats || planParsed.pages;

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
  let authoredBible = null;
  let timeToScenesMs = null;
  // All-pages batch: dollars across BOTH attempts (a retry that fills no gap
  // still costs money and must show up somewhere), and the model that answered.
  let allPagesCost = null;
  let allPagesModelId = null;
  if (params.expandScenes !== false) {
    const { buildSceneExpansionPrompt, buildAvailableAvatarsForPrompt } = require('./storyHelpers');
    const { callTextModelStreaming: callStream } = require('./textModels');
    const { IMAGE_MODELS } = require('../config/models');

    const expandLimit = parseInt(params.expandPages, 10) || finalBeats.length;
    // THE COVER PAGES ride with the story pages, exactly as in production
    // (beatsPipeline: covers are pages the Art Director briefs from code-written
    // beats, 2026-09-24). `params.coverBeats: false` measures the story pages alone.
    const { buildCoverBeats } = require('./coverBeats');
    const { coverTypesFor } = require('./coverKeys');
    // The front cover names the arc's central figure, as in production: the
    // stored one (arcReviewReport.centralFigure), or `params.centralFigure`
    // (names array) for a story stored before the arc recorded it.
    const { resolveReplayCentralFigure } = require('./beatsReplayInputs');
    const labCentralFigure = Array.isArray(params.centralFigure) ? params.centralFigure : resolveReplayCentralFigure(storyData);
    const labCoverBeats = params.coverBeats === false ? [] : buildCoverBeats(storyData, {
      coverTypes: coverTypesFor(storyData), clothingRequirements: storyData.clothingRequirements || null,
      centralFigure: labCentralFigure,
    });
    const toExpand = [...finalBeats.slice(0, expandLimit), ...labCoverBeats];
    const lang = storyData.language || 'en';
    const imgModelConfig = IMAGE_MODELS[storyData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageRenderImage];
    const availableAvatars = buildAvailableAvatarsForPrompt
      ? buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
      : '';
    const storedByPage = new Map((storyData.sceneImages || []).map(s => [s.pageNumber, s.sceneDescription || '']));

    // ONE resolver for BOTH Art-Director call shapes in this stage — the
    // all-pages builder below and the per-page `expandOnePage` fallback. That
    // is why buildReplaySceneOptions exists: the all-pages sibling was routed
    // through it and the per-page one was not, so the two measured different
    // inputs from the same stored story (no clothing contract at all on the
    // per-page side).
    const replayScene = buildReplaySceneOptions(storyData, {
      availableAvatars,
      maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
      parseBeats,
    });

    // THE BIBLE THIS RUN AUTHORED, parsed ONCE and read by every consumer in
    // this stage. Production adopts `adBible.visualBible` before the per-page
    // fallback runs, "so a recovered page is expanded against the same bible
    // the batch wrote" (beatsPipeline.js). The Lab had the parse in exactly one
    // place — the brief pre-check — so the per-page expansion and the pre-check
    // read different bibles, and the stored one is a different id space
    // (Lab #1195: findings naming ART002 as an egg while the new bible's ART002
    // was a coin). The stored bible stays the fallback for a run that authored
    // none (`params.perPageExpansion`, where no batch call happens at all).
    //
    // Declared HERE, above the batch call, on purpose: `expandOnePage` runs as
    // the batch's recovery callback, so a `let` further down would still be in
    // its temporal dead zone when the first recovered page asks for the bible.
    let _runVb;
    function runVisualBible() {
      if (_runVb !== undefined) return _runVb;
      _runVb = storyData.visualBible || null;
      if (authoredBible?.body) {
        try {
          const { UnifiedStoryParser } = require('./outlineParser/unified');
          const parsed = new UnifiedStoryParser(authoredBible.body).extractVisualBible();
          if (parsed) _runVb = parsed;
        } catch (vbErr) {
          log.warn(`[TESTLAB] beats_scenes: authored bible did not parse (${vbErr.message}) — falling back to the stored bible`);
        }
      }
      return _runVb;
    }

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
      const { buildSceneExpansionAllPrompt, parseRefinedText: parseAll, BRIEF_TRAILING_MARKERS } = require('./storyHelpers');
      const allPrompt = buildSceneExpansionAllPrompt(
        { ...storyData, characters: storyData.characters || [], pageClothing: null },
        toExpand.map(b => ({ pageNumber: b.pageNumber, planLine: b.planLine })),
        // No visualBible: the Art Director AUTHORS it now (2026-09-11), ahead
        // of page 1. The stage still measures the page briefs — parseAll
        // reads the `## Page N` blocks and ignores the leading sections.
        //
        // finalArc comes through the shared resolver: production passes
        // `finalArc: approvedArc` (beatsPipeline.js:1511) and this stage passed
        // nothing, so FINAL_ARC rendered as "(no arc was recorded for this
        // story)" on every run while production's Art Director staged each page
        // with the whole arc in view. It is the SAME arc the stage already hands
        // its own planner above — one expression for both, now.
        replayScene
      );
      if (allPrompt) {
        const tAll = Date.now();
        // TRUNCATION RECOVERY - production's three guards, in the Lab.
        const collected = await collectAllPagesBriefs({
          expected: toExpand,
          callBatch: () => callStream(allPrompt, null, null, params.sceneModel || MODEL_DEFAULTS.sceneDescription, {
            usageLabel: 'testlab_beats_scene_expansion_all',
            ...(params.sceneNoReasoning ? { reasoning: { enabled: false } } : {}),
          }),
          parsePages: (res) => (parseAll(res.text || '', toExpand.map(b => b.pageNumber), 'SCENES', BRIEF_TRAILING_MARKERS).pages || []),
          costOf,
          // The bible this call AUTHORS, kept on the result. Without it the stage
          // measures page briefs written against a bible nobody can read back,
          // and a bible fault in a Lab run is invisible. The first attempt that
          // carries one wins, exactly as production's `adBible` does.
          onAttempt: (res) => {
            if (authoredBible) return;
            try {
              const { extractBibleSections, AD_BIBLE_MARKERS } = require('./beatsPipeline');
              authoredBible = extractBibleSections(res.text || '', AD_BIBLE_MARKERS) || null;
            } catch (err) {
              log.warn(`[TESTLAB] beats_scenes: could not extract the authored bible (${err.message})`);
            }
          },
          expandOnePage,
        });
        sceneExpansions = toExpand
          .filter(b => collected.byPage.has(b.pageNumber))
          .map(b => {
            const hit = collected.byPage.get(b.pageNumber);
            return {
              pageNumber: b.pageNumber,
              ok: true,
              elapsedMs: Date.now() - tAll,
              modelId: hit.res.modelId,
              provider: hit.res.provider || null,
              usage: hit.res.usage,
              cost: costOf(hit.res),
              promptChars: allPrompt.length,
              prompt: allPrompt,
              fromBeats: String(hit.text || '').slice(0, 20000),
              storedProduction: (storedByPage.get(b.pageNumber) || '').slice(0, 20000),
            };
          })
          .concat(collected.recovered.map(r => ({
            ...r,
            storedProduction: (storedByPage.get(r.pageNumber) || '').slice(0, 20000),
          })))
          .sort((a, b) => a.pageNumber - b.pageNumber);
        allPagesCost = collected.cost;
        allPagesModelId = collected.lastRes?.modelId || null;
        timeToScenesMs = Date.now() - lockStart;
      }
    }

    // Per-page expansion. TWO callers: the historical per-page comparison
    // (params.perPageExpansion) and the all-pages RECOVERY above — production
    // re-expands a missing page exactly this way (beatsPipeline.js
    // `expandOnePage`), so the Lab's fallback is the same call, not a copy of a
    // different one. A function DECLARATION so the block above can call it.
    async function expandOnePage(b) {
      // BEAT + PLAN line stands in for page.text. No rawOutlineContext: in a
      // beats-first run there is no outline block yet, so this measures the
      // Art Director working from the plan alone.
      const pageContent = `PLAN: ${b.planLine || ''}`;
      const prompt = buildSceneExpansionPrompt(
        b.pageNumber, pageContent, storyData.characters || [], lang,
        runVisualBible(), replayScene.availableAvatars, null,
        {
          maxCharactersPerScene: replayScene.maxCharactersPerScene,
          artStyleId: storyData.artStyle,
          imageBackend: imgModelConfig?.backend,
          // THE TWO OPTIONS PRODUCTION PASSES AND THIS CALL DID NOT
          // (beatsPipeline.js `expandOnePage`). Both are measurable in the
          // built prompt, on every page:
          //   - `clothingRequirements` — the per-page fallback attaches no
          //     referencePhotos, so the contract is the ONLY outfit source.
          //     Without it every character's CHARACTER DETAILS line ended at
          //     its face and carried no `Wearing:` clause at all.
          //   - `story` — decides the book's SEASON and whether the text-zone
          //     rule family is asked for. With neither, `seasonLabel` fell back
          //     to TODAY's date (a summer story replayed in September was told
          //     "the season is Autumn on every page") and the text-zone rules
          //     were always on, where 94 of 118 recent stories gate them off.
          clothingRequirements: replayScene.clothingRequirements,
          story: storyData,
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
    }

    if (!sceneExpansions) sceneExpansions = await Promise.all(toExpand.map(expandOnePage));
    // ── Step 4: ONE review over ALL scene briefs ──────────────────────────
    // Repetition between pages, visual arc and continuity are invisible to a
    // per-scene reviewer — they only exist across the set — so every brief goes
    // into a single call. Reviews whatever model wrote the scenes, so Sonnet vs
    // DeepSeek can be compared as REVIEWER independently of who generated.
    const okScenes = sceneExpansions.filter(x => x.ok);
    if (params.reviewScenes !== false && okScenes.length > 0) {
      const { buildSceneReviewPrompt, parseRefinedText, BRIEF_TRAILING_MARKERS } = require('./storyHelpers');
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
      // CHECK THE BIBLE THIS RUN AUTHORED, not the one the story shipped with
      // (2026-09-12). The Art Director writes a fresh bible ahead of page 1, so
      // the stored one is a different id space: on Lab #1195 the findings named
      // "The Dragon Egg (ART002)" while the new bible's ART002 was a coin, no
      // finding could name it by an id that meant the same thing in both
      // bibles, and the reviewer was told to drop an element by an id that
      // meant something else in its own bible. Declared out here so the
      // scene-review prompt below gets the SAME bible the pre-check read —
      // production passes it (beatsPipeline.js) and a Lab that did not would
      // stop reproducing the review it is measuring. `runVisualBible` is the
      // one parse, shared with the per-page expansion above.
      const vb = runVisualBible();
      try {
        const { checkScenes: checkBriefs, renderFindingsBlock: renderBriefBlock } = require('./sceneBriefCheck');
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
      const srPrompt = buildSceneReviewPrompt(storyData, okScenes.map(x => ({ pageNumber: x.pageNumber, brief: x.fromBeats })), { beats: toExpand, briefFindings, visualBible: vb, clothingRequirements: storyData.clothingRequirements || null });
      if (srPrompt) {
        const reviewOnce = async (srModel) => {
          const t2 = Date.now();
          try {
            // null = model max, exactly as production (beatsPipeline.js). The
            // former 16000 cap silently truncated 6 of 8 reviews in the
            // 2026-09-10 AD redo (1107-1124) — no error, briefs kept as raw.
            const srRes = await callStream(srPrompt, null, null, srModel, { usageLabel: 'testlab_scene_review' });
            const parsed = parseRefinedText(srRes.text || '', expectedPages, 'SCENES', BRIEF_TRAILING_MARKERS);
            const outTok = srRes.usage?.output_tokens ?? null;
            const capInForce = TEXT_MODELS[srModel]?.maxOutputTokens ?? null;
            const verdict = assessSceneReview({
              text: srRes.text, outputTokens: outTok, stopReason: srRes.stop_reason || null,
              capInForce, parsedPageCount: parsed.pages.length,
            });
            if (!verdict.ok) {
              log.warn(`⚠️ [TESTLAB] beats_scenes scene review FAILED (story ${target.storyId}, reviewer ${srModel} → ${srRes.modelId || '?'} via ${srRes.provider || '?'}, out ${outTok ?? '?'} tok, cap ${capInForce ?? '?'}): ${verdict.error}`);
            }
            return {
              modelKey: srModel,
              modelId: srRes.modelId,
              provider: srRes.provider || null,
              ok: verdict.ok,
              error: verdict.error,
              elapsedMs: Date.now() - t2,
              ttftMs: srRes.ttft ?? null,
              usage: srRes.usage,
              stopReason: srRes.stop_reason || null,
              capInForce,
              cost: costOf(srRes),
              promptChars: srPrompt.length,
              prompt: srPrompt,
              // Storage clip only (dev-panel display) — not a model truncation.
              rawResponse: (srRes.text || '').slice(0, 40000),
              analysis: (parsed.analysis || '').slice(0, 40000),
              rewrotePages: verdict.ok ? parsed.pages.map(x => x.pageNumber) : [],
              _pages: verdict.ok ? parsed.pages : [],
            };
          } catch (err) {
            return { modelKey: srModel, ok: false, elapsedMs: Date.now() - t2, error: err.message };
          }
        };
        sceneReviews = await Promise.all(srModels.map(reviewOnce));
        applyReviewerPages(sceneExpansions, sceneReviews);
        sceneReview = sceneReviews[0] || null;
      }
    }
    // Parallel, as production runs them — so this is wall-clock, not the sum.
    timeToScenesMs = timeToLockMs + (Date.now() - expStart);
  }

  // "N of M pages measured", impossible to miss. The stage's own `ok` is set by
  // the runner (a stage that returns is a stage that ran), so a partial result
  // announces itself HERE instead - the panel renders it as a red banner above
  // everything else. Silent partial success is the defect this closes:
  // experiment 1275 reported 16 pages and had measured 9.
  const sceneExpansionIncomplete = summarizeSceneExpansions(sceneExpansions);
  if (sceneExpansionIncomplete) {
    log.error(`\u{1F6A8} [TESTLAB] beats_scenes INCOMPLETE: ${sceneExpansionIncomplete.message}`);
  }

  return {
    stageKind: 'beats_scenes',
    sceneExpansions,
    sceneExpansionIncomplete,
    allPagesCost,
    allPagesModelId,
    sceneReview,
    sceneReviews,
    authoredBible,
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
  const pages = extractRefinablePages(storyData.sceneImages || [], { visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });
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
    arc: storyData.arcReviewReport?.finalArc || storyData.beatsReviewReport?.arc || '',
    arcHints: resolveReplayArcHints(storyData),
    model: params.model,
    auditModel: params.auditModel,
    blindAuditModel: params.blindAuditModel,
    proofreadModel: params.proofreadModel,
    promptOverride,
    usageLabel: 'testlab_text_refine',
  });

  return {
    stageKind: 'text_refine',
    storyId: target.storyId,
    title: storyData.title || null,
    language: storyData.language || null,
    pageCount: pages.length,
    // The two parallel audits and the merged list the single repair answered —
    // the owner has to see every step of the chain, not only its output.
    refineAudits: res.audits,
    refineMerged: res.mergedFindings,
    refineMergeStats: res.mergeStats,
    // NOT `rounds` — the retired outline_review stage's iterate mode returns
    // that key with a different shape in STORED rows, and both land in the same
    // ExperimentResult.
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
  // PLATE OR FAIL: a landmark page's repair re-render carries its stored plate, never the raw photo (server/lib/landmarkScene.js).
  const generateImage = async (repairPrompt, opts) => {
    const { resolveRepairScene } = require('./landmarkScene');
    const repairScene = await resolveRepairScene({
      page: { sceneMetadata: ctx.scene?.sceneMetadata || null }, landmarkPhotos: ctx.landmarkPhotos,
      storyId: ctx.storyId, pageNumber: ctx.pageNumber, label: 'LAB TEXT-ZONE',
    });
    return generateImageOnly(repairPrompt, ctx.referencePhotos, {
      landmarkPhotos: ctx.landmarkPhotos,
      landmarkScene: repairScene.landmarkScene,
      sceneBackground: repairScene.sceneBackground,
      previousImage: opts.previousImage,
      textAreaMask: opts.textAreaMask,
      pageNumber: ctx.pageNumber,
      skipCache: true,
      aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    });
  };

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
    // Era-aware landmark protection (2026-09-05) — the page's stored landmark
    // refs + its scene era, so Lab repair stages reproduce production.
    visualBible: ctx.visualBible || null,
    landmarkPhotos: ctx.scene.landmarkPhotos || null,
    era: require('./landmarkProtection').resolveSceneEra(ctx.scene.sceneMetadata),
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

  // inpaintPage takes the consolidated plan as an INPUT (2026-09-21, B2): in
  // production it is produced once where the evaluation is scored. The Lab
  // stage starts from a stored eval, so it produces the plan here — one
  // consolidator call, exactly as before, just made visible at the call site.
  const { consolidateEvaluation } = require('./feedbackConsolidator');
  const consolidated = await consolidateEvaluation({
    evalResult: evaluation,
    sceneDescription: ctx.scene.sceneDescription || '',
    characters: storyData.characters || [],
    storyId: ctx.storyId,
    pageNumber: ctx.pageNumber,
    visualBible: ctx.visualBible,
    landmarkPhotos: ctx.scene.landmarkPhotos || null,
    era: require('./landmarkProtection').resolveSceneEra(ctx.scene.sceneMetadata),
  });

  const coverTextContract = buildEvalReplayOptions(ctx, { detectedFigures: null }).options;
  const t0 = Date.now();
  const result = await inpaintPage(imageData, evaluation, {
    consolidatedPlan: params.consolidatedPlan || consolidated.plan || null,
    detectedFigures: ctx.scene?.bboxDetection?.figures || null,
    visualBible: ctx.visualBible,
    characters: storyData.characters || [],
    pageNumber: ctx.pageNumber,
    sceneDescription: ctx.scene.sceneDescription || '',
    artStyle: ctx.artStyle,
    clothingRequirements: storyData.clothingRequirements || null,
    storyId: ctx.storyId,
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    // Era-aware landmark protection (2026-09-05) — the page's stored landmark
    // refs + its scene era, so Lab repair stages reproduce production.
    landmarkPhotos: ctx.scene.landmarkPhotos || null,
    era: require('./landmarkProtection').resolveSceneEra(ctx.scene.sceneMetadata),
    sceneMetadata: ctx.scene.sceneMetadata || null,
    // A cover target's text contract, from the same resolver the Lab evals use,
    // so a baked title is kept through the edit exactly as in production.
    expectedText: coverTextContract.expectedText,
    textMode: coverTextContract.textMode,
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

  // Lab-only: composite a NEW brief (e.g. a fresh Art-Director output) without a
  // story rerun — the same knob the image stage has. The override replaces the
  // stored brief and its metadata; everything else on the page stays as stored.
  let scene = ctx.scene || {};
  const compositeOverride = briefOverrideOf(params);
  if (compositeOverride) {
    const { extractSceneMetadata } = require('./storyHelpers');
    const meta = extractSceneMetadata(compositeOverride);
    scene = { ...scene, sceneDescription: compositeOverride, sceneMetadata: meta,
      sceneCharacters: meta?.fullData?.characters || meta?.characters || scene.sceneCharacters,
      emptyScenePrompt: meta?.emptyScenePrompt || meta?.fullData?.emptyScenePrompt || scene.emptyScenePrompt,
      compositeBrief: null };
    log.info('[TESTLAB] composite: staging from sceneDescriptionOverride, not the stored brief');
  }
  const fd = scene.sceneMetadata?.fullData || scene.sceneMetadata || {};
  const strategy = params.strategy === 'stratified' ? 'stratified' : 'uniform';
  const facing = params.facing === 'derive' ? 'derive' : 'threeQuarter';
  const wantBlend = params.blend !== false;
  // 'paste' composites cut-outs and blends; 'charRepair' hands each silhouette
  // to the production character-repair call instead.
  // 'inPlace' renders each figure over its silhouette on the original plate,
  // cuts it out with DINO+SAM and pastes it (no blend).
  const figureMethod = ['charRepair', 'inPlace'].includes(params.figureMethod) ? params.figureMethod : 'paste';
  // inPlace only: Image 2 is the whole 2x4 sheet ('sheet', production) or the
  // one cell matching the cast entry's pose ('cell', owner's design 2026-09-11).
  const refMode = params.refMode === 'cell' ? 'cell' : 'sheet';
  // A secondary character staged on the page but without a bible reference
  // image cannot be cast (nothing to render it from) and is not an animal, so
  // production paints it nowhere. 'plate' hands it to the plate's creature
  // block, painted from its description. Default 'omit' = production parity.
  const unreferencedSecondaries = params.unreferencedSecondaries === 'plate' ? 'plate' : 'omit';

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
  // Lab-only: replace a character's silhouette action text ({ "Name": "seated in the rowing boat" }).
  // The silhouette line is built from cast[].action; this is how "in the boat" reaches the plate.
  if (params.castActionOverrides && typeof params.castActionOverrides === 'object') {
    for (const c of cast) {
      const o = Object.entries(params.castActionOverrides).find(([n]) => String(n).toLowerCase() === String(c.name || '').toLowerCase());
      if (o) { c.action = String(o[1]); log.info(`[TESTLAB] composite cast action override: ${c.name} -> "${c.action}"`); }
    }
  }

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
      {
        skipVisualBible: true,
        // EMPTY ON PURPOSE, not omitted (2026-09-18). `vbRefElementIds` names
        // the elements whose reference render rides with the call, and this
        // prompt is handed to the blend pass, whose only images are the pasted
        // canvas and — where one exists — `ctx.visualBibleGrid`, which
        // loadSceneContext never sets. Nothing element-shaped is attached, so
        // the REQUIRED OBJECTS block must not claim a reference for anything.
        vbRefElementIds: [],
      },
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
  // Lab-only knob (2026-09-10): a plate description to build the silhouette
  // plate from, instead of the page's stored emptyScenePrompt. A page that
  // shared another page's vantage canvas stores THAT page's plate prompt,
  // so "run the composite on the correct world" needs the correct words
  // handed in. Production behaviour is untouched.
  const rawBg = String(params.plateDescriptionOverride || scene.emptyScenePrompt || fd.emptyScenePrompt || scene.sceneDescription || '');
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
      // Production's option set (buildEvalReplayOptions). A replayed paste
      // canvas has no detection for its bytes, so the figure count is withheld.
      // This arm feeds the evaluator's findings straight into a PAID repair
      // call, so a finding invented against an unstripped clothing contract is
      // an order to repaint a garment the brief deliberately removed.
      const replay = buildEvalReplayOptions(ctx, { detectedFigures: null });
      const ev = await evaluateImageQuality(
        img.imageData, evalSceneDescription(ctx), evalReferencePhotos(ctx), replay.evaluationType,
        null, `testlab-exp${experimentId}-P${ctx.pageNumber}-composite`,
        ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
        replay.options,
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
    // In-place intermediates survive an all-or-nothing abort too: exp 1156
    // placed 2/4 and left no trace of WHY the other two were refused - warn
    // lines are not in logLines, and the renders were never saved.
    const saveAborted = async (uri, label) => {
      if (typeof uri !== 'string' || !uri.startsWith('data:image')) return;
      try {
        const v = await saveTestVersion(ctx.storyId, 'tl_step', ctx.pageNumber, uri, experimentId);
        aborted.push({ label, imageType: 'tl_step', versionIndex: v });
      } catch (e) { log.warn(`[TESTLAB] abort step "${label}" not saved: ${e.message}`); }
    };
    for (const [name, v] of Object.entries(adbg.inPlaceRefs || {})) await saveAborted(v?.ref, `· reference sent for ${name} (${v?.kind || 'unknown'})`);
    for (const [name, v] of Object.entries(adbg.inPlaceRenders || {})) {
      for (const a of (Array.isArray(v?.attempts) ? v.attempts : [])) {
        const rz = a.residue ? `, unchanged ${Math.round(a.residue.unchanged * 100)}%, flat ${Math.round(a.residue.flatSaturated * 100)}%${a.residue.rejected ? ', PLACEHOLDER UNPAINTED' : ''}` : '';
        await saveAborted(a.render, `· in-place render for ${name}, attempt ${a.attempt} (height ${a.ratio}x, IoU ${a.iou}${rz}${a.ok ? ', accepted' : ''})`);
      }
    }
    for (const [name, uri] of Object.entries(adbg.cutouts || {})) await saveAborted(uri, `· cut-out used for ${name}`);
    err.partialResult = {
      ...(err.partialResult || {}),
      steps: aborted,
      aborted: true,
      inPlaceLog: adbg.inPlaceLog || null,
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
    // The bible, so the blend prompt can name what a finding cites instead of leaking an id.
    visualBible: storyData.visualBible || null,
    // Lab-only: per-figure phantom-pose render (a seated silhouette gets a seated figure,
    // not a standing cell). Production never passes it; the builder's default false stands.
    phantomPoseRender: params.phantomPoseRender === true,
    cleanBackgroundPrompt,
    aspectRatio: ctx.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
    skipBlend: !wantBlend,
    figureMethod,
    // figureMethod 'charRepair' runs the character-repair prompt: pose lines name others by sight.
    repairNames: labRepairNames(ctx),
    // Same creature resolution production uses — the Lab has to reproduce the
    // plate the pipeline would build, or a composite bug shows up in one and
    // not the other.
    sceneCreatures: require('./visualBible')
      .resolveSceneCreatures(storyData.visualBible, fd.objects || [], ctx.pageNumber)
      .concat(unreferencedSecondaries === 'plate'
        ? require('./compositeCastBuilder').unreferencedSecondaryCreatures(fd, storyData.visualBible || null)
        : []),
    refMode,
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
      : figureMethod === 'inPlace'
        ? '3 · figures rendered in place, cut and pasted'
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
    await saveStep(v?.phantomCrop, `· phantom crop sent for ${name}`);
    await saveStep(v?.output, `· phantom-pose render for ${name}`);
  }
  // In-place: the reference actually sent as Image 2 (whole sheet, one cell, or a bible image).
  for (const [name, v] of Object.entries(dbg.inPlaceRefs || {})) {
    await saveStep(v?.ref, `· reference sent for ${name} (${v?.kind || 'unknown'})`);
  }
  // In-place renders (figureMethod 'inPlace'): the full plate with one figure painted.
  for (const [name, v] of Object.entries(dbg.inPlaceRenders || {})) {
    // Every attempt, not only the kept one: a re-render is a judgement to check.
    const tries = Array.isArray(v?.attempts) && v.attempts.length > 1 ? v.attempts : null;
    if (tries) {
      for (const a of tries) await saveStep(a.render, `· in-place render for ${name}, attempt ${a.attempt} (height ${a.ratio}x, IoU ${a.iou}${a.residue ? `, unchanged ${Math.round(a.residue.unchanged * 100)}%, flat ${Math.round(a.residue.flatSaturated * 100)}%${a.residue.rejected ? ', PLACEHOLDER UNPAINTED' : ''}` : ''}${a.ok ? ', accepted' : ''})`);
    } else {
      const a = Array.isArray(v?.attempts) ? v.attempts[0] : null;
      await saveStep(v?.render, `· in-place render for ${name}${a?.residue ? ` (unchanged ${Math.round(a.residue.unchanged * 100)}%, flat ${Math.round(a.residue.flatSaturated * 100)}%${a.residue.rejected ? ', PLACEHOLDER UNPAINTED' : ''})` : ''}`);
    }
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
    refMode: figureMethod === 'inPlace' ? refMode : undefined,
    unreferencedSecondaries,
    detector: (res.debug || {}).detector || null,
    blended: figureMethod === 'paste' ? wantBlend : false,
    charRepairLog: (res.debug || {}).charRepairLog || null,
    inPlaceLog: (res.debug || {}).inPlaceLog || null,
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
    // Production's option set (buildEvalReplayOptions). This site passed the
    // three thinnest keys of all five, so the eval that decides the repair
    // ROUTE ran with no bible, no wardrobe, no cast index, no art style and no
    // landmark protection — a decision-reliability run measured a decision
    // production never makes. The stored detection belongs to the ACTIVE image,
    // which is what is being evaluated here.
    const replay = buildEvalReplayOptions(ctx, {
      detectedFigures: ctx.scene.bboxDetection?.figures || null,
    });
    const fresh = await evaluateImageQuality(
      imageData, evalSceneDescription(ctx), evalReferencePhotos(ctx), replay.evaluationType,
      null, `testlab-exp${experimentId}-P${ctx.pageNumber}-decide`,
      ctx.scene.text || null, ctx.outlineHint, ctx.scene.sceneCharacters || null,
      replay.options
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
        visualBible: ctx.visualBible || null,
        landmarkPhotos: ctx.scene.landmarkPhotos || null,
        era: require('./landmarkProtection').resolveSceneEra(ctx.scene.sceneMetadata),
      });
      if (cons?.plan) fresh.consolidatedPlan = cons.plan;
    } catch (cErr) {
      log.warn(`[TESTLAB] fresh-eval consolidation failed (continuing): ${cErr.message}`);
    }
    latestEval = fresh;
  }
  const entityReport = params.entityReport || storyData.finalChecksReport?.entity || null;
  // The page's DECLARED cast, as production passes it: a name the page does
  // not hold is never char-fixed.
  const decision = decideRepairMethod(ctx.pageNumber, latestEval, entityReport, {
    expectedCast: require('./repairLogic').resolveDeclaredCast(ctx.scene.sceneCharacters),
  });

  const base = { decision: { method: decision.method, reason: decision.reason, charName: decision.charName || null, targetFigure: decision.targetFigure ?? null } };
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
    // A figure-targeted decision (presence MIXED case) paints THAT figure into
    // the missing character — same box resolver production uses.
    let figureBox = {};
    if (decision.targetFigure != null) {
      const fb = require('./charRepairTarget').resolveFigureBbox(decision.targetFigure, { bestEval: latestEval });
      if (!fb.bodyBbox && !fb.faceBbox) throw new Error(`char-fix targets figure ${decision.targetFigure}, but the evaluation carries no box for it`);
      figureBox = { bbox: fb.bodyBbox || fb.faceBbox, faceBbox: fb.faceBbox || null, whiteoutTarget: 'body' };
    }
    const r = await runCharRepairStage(ctx, {
      experimentId,
      params: { ...params, ...figureBox, characterName: decision.charName, repairMode: 'auto' },
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
  const { MODEL_DEFAULTS } = require('../config/models');

  const instruction = params.instruction || promptOverride;
  if (!instruction) throw new Error('edit_image requires params.instruction (or a prompt override) — the edit text');
  // params.source='empty_scene' edits the page's stored background plate
  // exactly as the plate-derive step does in production (storyJobPipeline.js,
  // "AN ANGLED PAGE TAKES A PLATE DERIVED FROM THIS ONE"): the plate model and
  // the book's art style (since 2026-09-23). Pick the page that carries the vantage's BASE plate.
  // params.source='derive_base' edits the BASE plate a derived page's plate
  // was edited from (its one stored plate reference), so a production derive
  // is replayed on the exact input it had. Only a page with a derived plate
  // has one.
  const onDeriveBase = params.source === 'derive_base';
  const onPlate = params.source === 'empty_scene' || onDeriveBase;
  let imageData;
  if (onDeriveBase) {
    const baseRef = ctx.scene?.plateDerivedFor ? (ctx.scene.emptySceneGrokRefImages || [])[0] : null;
    if (!baseRef) throw new Error(`p${ctx.pageNumber} has no derived plate, so no base plate to edit (source=derive_base)`);
    imageData = await bytesFor(typeof baseRef === 'string' ? { imageUrl: /^data:/.test(baseRef) ? null : baseRef, imageData: /^data:/.test(baseRef) ? baseRef : null } : baseRef);
  } else {
    imageData = onPlate
      ? await loadEmptyScene(ctx.storyId, ctx.pageNumber)
      : await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  }
  if (!imageData) throw new Error(`no ${onDeriveBase ? 'derive base plate' : onPlate ? 'empty_scene plate' : 'page image'} for p${ctx.pageNumber}`);

  const t0 = Date.now();
  const result = onPlate
    ? await editImageWithPrompt(imageData, instruction, MODEL_DEFAULTS.emptyScenePlateModel, [], ctx.artStyle, null, { plateDerive: true })
    : await editImageWithPrompt(imageData, instruction, null, [], ctx.artStyle);
  const elapsedMs = Date.now() - t0;
  const edited = result?.imageData || null;
  if (!edited) throw new Error('edit produced no image');

  const imageType = onPlate ? 'empty_scene' : 'scene';
  const versionIndex = await saveTestVersion(ctx.storyId, imageType, ctx.pageNumber, edited, experimentId);
  // editImageWithPrompt reports the model at usage.model (no top-level modelId).
  return { imageType, versionIndex, elapsedMs, modelId: result.usage?.model || null, promptUsed: instruction };
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
  // THE CAST LIST, as both production sites pass it. Without it the trigger
  // counts figures the composite cannot draw — a Visual Bible secondary the
  // scene reviewer promoted into characters[] passes the count and then resolves
  // to nothing — so the Lab answered a different question from production.
  const castable = ctx.characters || [];
  if (!needsScaleRepair(sceneMetadata, castable)) {
    throw new Error('Scene does not need scale repair (no depth=background characters in metadata)');
  }
  const imageData = await loadActivePageImage(ctx.storyId, ctx.pageNumber);
  const t0 = Date.now();
  const result = await runScaleRepair(imageData, sceneMetadata, { pageNumber: ctx.pageNumber, castableCharacters: castable });
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
  const result = await callTextModel(prompt, null, null, { usageLabel: 'testlab_scene_expansion' });
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
    callTextModel(promptA, null, null, { usageLabel: 'testlab_scene_expansion_ab' }),
    callTextModel(promptB, null, null, { usageLabel: 'testlab_scene_expansion_ab' }),
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
  const res = await callTextModel(prompt, null, null, { usageLabel: 'testlab_scene_variant' });
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

  // THE PAGE'S PLAN LINE. Ten positional arguments left `rawOutlineContext`
  // (the 11th) on its default, and images.js:3884 names exactly what that
  // costs: "with a null, buildSceneDescriptionPrompt fills the authoritative
  // SCENE_SUMMARY slot from the previous brief's own imageSummary, and the
  // rewrite has no narrative anchor outside the artefact it is rewriting."
  // The endpoint this stage replays passes `planLine ? { planLine } : null`
  // (regeneration.js), through the same resolver.
  const storedScene = (storyData.sceneDescriptions || []).find(sc => sc.pageNumber === ctx.pageNumber) || null;
  const storedImage = (storyData.sceneImages || []).find(si => si.pageNumber === ctx.pageNumber) || null;
  const { resolvePlanLine } = require('./iterateBeat');
  const planLine = resolvePlanLine(storedScene, storedImage);
  if (!planLine) {
    log.warn(`[TESTLAB] scene_description P${ctx.pageNumber}: no stored plan line — the rewrite runs on the previous brief alone, exactly as the endpoint warns`);
  }

  let prompt;
  const orig = PROMPT_TEMPLATES.sceneDescriptions;
  if (promptOverride) PROMPT_TEMPLATES.sceneDescriptions = promptOverride;
  try {
    prompt = buildSceneDescriptionPrompt(
      ctx.pageNumber, ctx.scene.text || '', storyData.characters || [], '',
      ctx.language, ctx.visualBible, [], 'standard', '', availableAvatars,
      planLine ? { planLine } : null,
      null,
      // clothingRequirements so each character's CHARACTER DETAILS line carries
      // its outfit TEXT. Without it the block ends at the face and every
      // `Wearing:` clause is gone — the same omission the all-pages Art
      // Director builder was fixed for.
      { clothingRequirements: storyData.clothingRequirements || null }
    );
  } finally {
    PROMPT_TEMPLATES.sceneDescriptions = orig;
  }

  const t0 = Date.now();
  const result = await callClaudeAPI(prompt, null, resolveSceneIterationModel(), {
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
      bodyActionContext = buildActionContext(ctx.scene.sceneDescription || ctx.scene.text || '', ref.name, null, labRepairNames(ctx)) || '';
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
      ? await require('./grok').editWithGrok(prompt, qwenRefs, { aspectRatio: params._grokAspect || '3:4', resolution: '1k', skipOutputCrop: true })
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
  const result = await callTextModel(prompt, null, null, { usageLabel: 'testlab_scene_rewrite' });
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
 * promptOverride A/Bs ONE judge's prompt text — params.evalPrompt names which
 * (heads | bodies | identity on pass 1, style on pass 2), the same key the
 * Lab's "Load current template" reads. Production runs four different judge
 * templates; one override replacing two of them (the pre-2026-09-23 wiring)
 * measured nothing production does. Both are eval-only — no image is
 * generated, so this never spends generation credits.
 */
async function runAvatarEvalStage(target, { experimentId, promptOverride, params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { _internal, resolveFacePhoto } = require('./character2x4Sheet');
  const { character, costume } = await loadCharacterContext(target.storyId, target.character);
  const model = params.model || 'gemini-2.5-flash';
  // Production judges against the character's declared age; so does the Lab
  // unless an experiment sets one.
  const declaredAge = params.declaredAge ?? character.age ?? null;
  if (promptOverride && !params.evalPrompt) {
    throw new Error('avatar_eval promptOverride needs params.evalPrompt (heads | bodies | identity | style) — it replaces that one judge');
  }
  const promptOverrides = promptOverride ? { [params.evalPrompt]: promptOverride } : {};
  const t0 = Date.now();

  const versionIndex = params.versionIndex ?? target.versionIndex;
  if (versionIndex != null) {
    // Lab test-version path (a sheet generated by avatar_realistic/avatar_style).
    const sheet = await loadTestImage(target.storyId, 'tl_avatar', null, versionIndex);
    if (!sheet?.imageData) throw new Error(`tl_avatar v${versionIndex} not found`);
    const facePhoto = await resolveFacePhoto(character);
    // Same single-source evaluator production calls — never a lab-only judge.
    let evalResult;
    if (params.styled) {
      const realisticVersionIndex = params.realisticVersionIndex;
      if (realisticVersionIndex == null) throw new Error('styled avatar_eval requires realisticVersionIndex');
      const anchor = await loadTestImage(target.storyId, 'tl_avatar', null, realisticVersionIndex);
      if (!anchor?.imageData) throw new Error(`realistic anchor v${realisticVersionIndex} not found`);
      ({ verdict: evalResult } = await _internal.evaluateAvatarSheet(sheet.imageData, {
        pass: 2, facePhoto, realisticSheet: anchor.imageData,
        artStyle: params.artStyle || target.artStyle || 'pixar',
        declaredAge, model, promptOverrides,
      }));
    } else {
      const { split } = await _internal.evaluateAvatarSheet(sheet.imageData, {
        pass: 1, facePhoto,
        costumeDescription: costume.description || 'standard outfit',
        declaredAge, model, promptOverrides,
      });
      evalResult = { split: true, splitY: split.splitY, model, heads: split.heads, bodies: split.bodies, identity: split.identity, finalScore: split.verdict.finalScore, valid: split.verdict.valid };
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
      declaredAge, model, promptOverrides,
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
      // No costumeDescription: pass 2 is a style transfer and its judge does
      // not score the outfit (that axis lives on pass 1).
      pass: 2, facePhoto, realisticSheet: realistic, artStyle,
      declaredAge, model, promptOverrides,
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
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
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

  // A pinned target version is the case: comparing describers on a page whose
  // active version is a repaired render answers a different question.
  //
  // `params.imageType` reaches loadTestImage, which is the only path that can
  // see an `is_test` row — every Lab-produced render is one, and getStoryImage
  // filters them out. Without it a repaired version cannot be described at all
  // ("No version 3 for ... page 6"), which is exactly the question a repair
  // experiment needs answered. Same shape as the detection stage at ~1405.
  const pinnedVersion = params.versionIndex ?? ctx.versionIndex ?? null;
  const imageDataUri = await loadActivePageImage(
    ctx.storyId, ctx.pageNumber, pinnedVersion,
    pinnedVersion != null ? (params.imageType || 'scene') : null);
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
          // params.reasoning measures what thinking costs on a describe-only pass.
          ...(params.reasoning ? { reasoning: params.reasoning } : {}),
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
        // The model that ANSWERED, not the one the experiment asked for. The
        // inventory falls back to gemini-2.5-flash on any OpenRouter failure,
        // so without this an arm can silently be the fallback and the row still
        // reads as the requested model (#1241).
        servedByModel: res.servedByModel || modelId,
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
  identity_second_opinion: runIdentitySecondOpinionStage,
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
  // `-?`: a cover page (-1/-2/-3) is a page block too since 2026-09-24.
  const re = /---\s*Page\s+(-?\d+)\s*---\s*\n?([\s\S]*?)(?=\n---\s*Page\s+-?\d+\s*---|$)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push({ pageNumber: parseInt(m[1], 10), text: m[2].trim() });
  return out.sort((a, b) => a.pageNumber - b.pageNumber);
}

async function runSceneReviewReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildSceneReviewPrompt, parseRefinedText, BRIEF_TRAILING_MARKERS, extractSceneMetadata, parseBeats } = require('./storyHelpers');
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
      prose: require('./sceneMetadata').splitBrief(x.brief).prose,
      cast: (stored.sceneCharacters || meta.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
      perCharClothing: stored.perCharClothing
        || (storyData.pageClothing?.pageClothing || {})[String(x.pageNumber)]
        || meta.characterClothing || {},
      // Production's inputs (beatsPipeline): without the rows and the bible,
      // removal_unstated — the one SENT clothing type — can never fire here.
      wornItems: meta.wornItems || [],
    };
  });
  const artifacts = (storyData.visualBible || {}).artifacts;
  const before = checkScenes(checkPages, storyData.clothingRequirements, { artifacts, visualBible: storyData.visualBible });
  const findingsBlock = renderFindingsBlock(before.byPage);

  // Beats for check 5, recovered from the stored outline's ---BEATS--- section
  // (the locked, post-review beats — see beatsPipeline rawOutline). Unified
  // stories have no such section; the builder renders "(no beat data)".
  const beatsSection = (String(storyData.outline || '')
    .match(/---\s*BEATS\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]+---|$)/i) || [])[1] || '';
  const outlineBeats = parseBeats(beatsSection).pages;

  // BRIEF CONTRADICTIONS — the fourth option production passes, and the last
  // one this stage was missing (the bible half was closed a day earlier in
  // e1430bb99; clothing and beats were already here). Deterministic, so a
  // replay regenerates the same block production computed: prose against the
  // brief's own metadata, the cast (roster + bible secondaries) and the bible,
  // with the plan line carrying the element-coverage check. Without it
  // {BRIEF_FINDINGS} filled empty and the replay could not reproduce a single
  // cast_unlisted / vb_state_* / vb_page_uncited rewrite the production run
  // made — the stage measures the reviewer, and it was measuring it on less
  // than the reviewer is given.
  let briefFindingsBlock = '';
  try {
    const { checkScenes: checkBriefs, renderFindingsBlock: renderBriefBlock } = require('./sceneBriefCheck');
    const { textZoneRulesActive } = require('../config/runtime');
    const planLineOf = (pageNumber) => (outlineBeats.find(b => b && b.pageNumber === pageNumber) || {}).planLine || '';
    // Same cast list as beatsPipeline: the uploaded roster PLUS the bible's
    // secondaries, or a figure the story invented can never trigger cast_unlisted.
    const secondaryList = Array.isArray(storyData.visualBible?.secondaryCharacters)
      ? storyData.visualBible.secondaryCharacters
      : Object.values(storyData.visualBible?.secondaryCharacters || {});
    const seenCast = new Set();
    const castNames = [
      ...(storyData.characters || []).map(c => c && c.name),
      ...secondaryList.map(c => c && c.name),
    ].filter(Boolean).filter((n) => {
      const k = String(n).trim().toLowerCase();
      if (!k || seenCast.has(k)) return false;
      seenCast.add(k);
      return true;
    });
    const briefRes = checkBriefs(
      scenes.map(x => ({ pageNumber: x.pageNumber, brief: x.brief, planLine: planLineOf(x.pageNumber) })),
      castNames,
      storyData.visualBible,
      { textZoneRules: textZoneRulesActive(storyData) }
    );
    briefFindingsBlock = renderBriefBlock(briefRes.byPage);
  } catch (bcErr) {
    log.warn(`⚠️ [TESTLAB] scene-review replay: brief check failed (${bcErr.message}) — the replay runs without brief findings, unlike production`);
  }

  const orig = PROMPT_TEMPLATES.sceneReview;
  if (promptOverride) PROMPT_TEMPLATES.sceneReview = promptOverride;
  let prompt;
  try {
    // ALL FOUR options production passes (beatsPipeline.js `{ clothingFindings,
    // briefFindings, beats, visualBible }`). The bible feeds check 9f (a stated
    // object's state page ranges); omitted, buildSceneReviewPrompt emitted NO
    // `# VISUAL BIBLE — STATED OBJECTS` block at all, so a replay could never
    // see a state's page range, never emit a corrected entry, and check 9f
    // under-reported against the production run it is meant to mirror. The
    // brief findings are the same shape of gap, closed above.
    prompt = buildSceneReviewPrompt(storyData, scenes, {
      clothingFindings: findingsBlock,
      briefFindings: briefFindingsBlock,
      beats: outlineBeats,
      visualBible: storyData.visualBible,
      clothingRequirements: storyData.clothingRequirements || null,
    });
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
    const parsed = parseRefinedText(res.text || '', scenes.map(x => x.pageNumber), 'SCENES', BRIEF_TRAILING_MARKERS);
    const byPage = new Map((parsed.pages || []).map(x => [x.pageNumber, x.text]));

    // Merge onto a COPY — the next model in the fan-out must see the same input.
    // A reviewed brief keeps every worn-state row the stored brief declared —
    // production's rule (beatsPipeline keepDeclaredWornRows).
    const merged = scenes.map((x) => {
      const reviewed = (byPage.get(x.pageNumber) || '').trim();
      if (!reviewed) return { pageNumber: x.pageNumber, brief: x.brief };
      const carry = require('./wornItems').carryForwardWornItemsInBrief(reviewed, x.brief);
      return { pageNumber: x.pageNumber, brief: carry ? carry.brief : reviewed };
    });
    const diffs = merged
      .filter((m, i) => m.brief !== scenes[i].brief)
      .map(m => ({ pageNumber: m.pageNumber, before: scenes.find(x => x.pageNumber === m.pageNumber).brief, after: m.brief }));

    const afterPages = checkPages.map(cp => {
      const m = merged.find(x => x.pageNumber === cp.pageNumber);
      const mMeta = extractSceneMetadata(m.brief) || {};
      return { ...cp, prose: require('./sceneMetadata').splitBrief(m.brief).prose, wornItems: mMeta.wornItems || [] };
    });
    const after = checkScenes(afterPages, storyData.clothingRequirements, { artifacts, visualBible: storyData.visualBible });
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
  const { extractSceneMetadata } = helpers;
  const briefs = storyData?.beatsReviewReport?.briefsIn;
  if (Array.isArray(briefs) && briefs.length > 0) {
    const parsed = briefs.map((b) => ({
      pageNumber: b.pageNumber,
      planLine: ((String(b.brief || '').match(/(?:^|\n)\s*PLAN:\s*([\s\S]*)$/i) || [])[1] || '').trim(),
    })).filter(b => b.planLine);
    if (parsed.length > 0) return { beats: parsed, source: 'briefsIn' };
  }
  const beats = (storyData.sceneImages || []).map((sc) => {
    const meta = sc.sceneMetadata || extractSceneMetadata(sc.sceneDescription || '') || {};
    return {
      pageNumber: sc.pageNumber,
      planLine: (meta.sceneIntent || require('./sceneMetadata').splitBrief(sc.sceneDescription || '').prose.slice(0, 300)),
    };
  });
  return { beats, source: 'reconstructed-from-prose' };
}

async function runStoryBibleReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildStoryBibleFromBeatsPrompt, getPageText, extractSceneMetadata, parseBeats } = require('./storyHelpers');
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
    // Same arc production hands the wardrobe writer (beatsPipeline: approvedArc).
    prompt = buildStoryBibleFromBeatsPrompt(storyData, beats, { arc: resolveReplayArc(storyData, { parseBeats }) });
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

  // Production's reviewer (beatsPipeline: MODEL_DEFAULTS.clothingReviewModel),
  // not the outline reviewer — a replay on a different model measures nothing.
  const model = params.reviewModel || MODEL_DEFAULTS.clothingReviewModel;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);

  const t = Date.now();
  // Production's reasoning setting too (MODEL_DEFAULTS.clothingReviewReasoning,
  // off since 2026-09-24, Lab 1425/1427) — one value, both call sites.
  const res = await callTextModelStreaming(prompt, null, null, model, {
    usageLabel: 'testlab_clothing_review',
    reasoning: MODEL_DEFAULTS.clothingReviewReasoning,
  });
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
    reasoning: MODEL_DEFAULTS.clothingReviewReasoning,
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
    const basePages = extractRefinablePages(storyData.sceneImages || [], { visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });
    const pages = (basePages.length ? basePages : prior.map(p => ({ pageNumber: p.pageNumber, text: p.text, sceneIntent: '', sceneBrief: '' })))
      .map(p => ({ ...p, text: priorBy.get(p.pageNumber) || p.text }));
    const t = Date.now();
    const rr = await refineStoryText(storyData, pages, { rounds: 1, model, usageLabel: 'testlab_text_branch', arc: storyData.arcReviewReport?.finalArc || storyData.beatsReviewReport?.arc || '', arcHints: resolveReplayArcHints(storyData) });
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

  // PRODUCTION ARGUMENTS (beatsPipeline.js:2327). The stage used to pass
  // `expansions = []` and no arcHints, which is the state production warns
  // about by name — "text is being written blind to the illustrations … the OLD
  // sibling behaviour" (beatsPipeline.js:2321-2326). Every writer A/B run this
  // way measured a task production never sets. `params.blindToBriefs` keeps
  // that arm reachable, but as an explicit override, never as the baseline.
  const textArgs = buildReplayTextArgs(storyData, beats, {
    parseBeats,
    overrides: {
      expansions: (params.blindToBriefs === true || params.blindToBriefs === 'true') ? [] : undefined,
    },
  });
  const orig = PROMPT_TEMPLATES.storyTextFromBeats;
  if (promptOverride) PROMPT_TEMPLATES.storyTextFromBeats = promptOverride;
  let prompt;
  try {
    prompt = buildStoryTextFromBeatsPrompt(
      storyData, textArgs.beats, textArgs.expansions, textArgs.arc, { arcHints: textArgs.arcHints, visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements });
  } finally { PROMPT_TEMPLATES.storyTextFromBeats = orig; }
  if (!prompt) throw new Error('story-text-from-beats template unavailable');

  const model = params.textModel || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);

  const t = Date.now();
  const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_story_text_replay' });
  if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) {
    throw new Error(`writer ${model} returned an empty response — provider failure, not a result`);
  }
  // Parsed exactly as production parses the same response
  // (beatsPipeline.js:3126): the expected page numbers, and TITLE named as a
  // trailing marker. Without the marker the final page's text swallowed the
  // whole ---TITLE--- block and `title` came back null, so every replay's last
  // page carried the candidate list and the pick line as if it were prose.
  const parsed = parseRefinedText(
    res.text || '', textArgs.beats.map(b => b.pageNumber), 'STORY TEXT', ['TITLE']);
  // parseRefinedText only STOPS the last page at the title block; reading the
  // block is parseTitleBlock's job, and production runs both (beatsPipeline.js).
  const titleBlock = require('./promptBuilders').parseTitleBlock(res.text || '');

  // scoreOutput: the ONE evaluator grades the regenerated text (storyText only).
  let scorecard = null;
  if (params.scoreOutput === true || params.scoreOutput === 'true') {
    const storyText = (parsed.pages || []).map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
    if (storyText.trim()) scorecard = (await scoreArtifactsWithJudge({ storyText }, { model: params.judgeModel, evalVersion: params.evalVersion, persist: { storyId: target.storyId, title: storyData.title, language: storyData.language, artStyle: storyData.artStyle, source: 'story_text_replay', model, genCost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}), genMs: Date.now() - t } })).scorecard;
  }

  return {
    storyId: target.storyId,
    beatsSource,
    // Visible in the result so a reader can tell a production-faithful run from
    // an override arm without re-reading the prompt.
    briefsSeen: textArgs.expansions.length,
    arcChars: textArgs.arc.length,
    arcHintsChars: textArgs.arcHints.length,
    overridden: textArgs.overridden,
    model, modelId: res.modelId,
    elapsedMs: Date.now() - t,
    cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
    usage: res.usage,
    promptChars: prompt.length,
    prompt,
    title: titleBlock.title || null,
    titleCandidates: titleBlock.titleCandidates,
    titlePick: titleBlock.titleJudge ? titleBlock.titleJudge.pick : null,
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
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost, IMAGE_MODELS } = require('../config/models');
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

  // The arguments production hands each of these calls, resolved once from the
  // stored story (server/lib/beatsReplayInputs.js). Every arm below is a MODEL
  // comparison — the inputs must be production's, or the ranking is a ranking
  // of models at a task nobody ships.
  const textArgs = buildReplayTextArgs(storyData, beats, { parseBeats: SH.parseBeats });
  const sceneOptions = buildReplaySceneOptions(storyData, {
    availableAvatars: SH.buildAvailableAvatarsForPrompt
      ? SH.buildAvailableAvatarsForPrompt(storyData.characters || [], storyData.clothingRequirements || null)
      : '',
    maxCharactersPerScene: IMAGE_MODELS[storyData.modelOverrides?.imageModel || MODEL_DEFAULTS.pageRenderImage]?.maxCharactersPerScene || 3,
    parseBeats: SH.parseBeats,
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
          // Production: buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints })
          // — beatsPipeline.js:935. arcHints was missing here.
          const r = await call(SH.buildBeatsPrompt(storyData, expectedPages, { finalArc: textArgs.arc, arcHints: textArgs.arcHints, centralFigure: textArgs.centralFigure }), model, 'plan');
          const parsed = SH.parsePlanResponse(r.text, []);
          arm.stages.plan = { ...WC.scorePlan(parsed.pages || [], expectedPages), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'bible') {
          const r = await call(SH.buildStoryBibleFromBeatsPrompt(storyData, beats, { arc: textArgs.arc }), model, 'bible');
          const p = new UnifiedStoryParser(r.text);
          arm.stages.bible = { ...WC.scoreBible(p.extractClothingRequirements(), p.extractVisualBible(), expectedChars), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'scenes') {
          // Production: buildSceneExpansionAllPrompt(inputData, beats, { availableAvatars,
          // maxCharactersPerScene, finalArc, clothingRequirements }) — beatsPipeline.js:1511.
          // `{}` gave the Art Director no avatars, no cast cap, no wardrobe and
          // FINAL_ARC = "(no arc was recorded for this story)".
          const r = await call(SH.buildSceneExpansionAllPrompt(storyData, beats, sceneOptions), model, 'scenes');
          const briefs = String(r.text).split(/^##\s*(?:Page|Seite)\s*\d+/im).slice(1);
          arm.stages.scenes = { ...WC.scoreScenes(briefs), cost: r.cost, elapsedMs: r.elapsedMs, outTok: r.usage?.output_tokens };
        } else if (stage === 'text') {
          // Production: buildStoryTextFromBeatsPrompt(inputData, beats, finalExpansions,
          // approvedArc, { arcHints }) — beatsPipeline.js:2327.
          const r = await call(SH.buildStoryTextFromBeatsPrompt(
            storyData, beats, textArgs.expansions, textArgs.arc, { arcHints: textArgs.arcHints, visualBible: storyData.visualBible, clothingRequirements: storyData.clothingRequirements }), model, 'text');
          // Same parse production uses (beatsPipeline.js:3126). Without TITLE
          // named as a trailing marker the last page swallows the whole
          // ---TITLE--- block, and every arm was scored on a final page
          // carrying the candidate list and the pick line.
          const parsed = SH.parseRefinedText(r.text, expectedPages, 'STORY TEXT', ['TITLE']);
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
/**
 * arc_effort — does the arc still hold at medium or low effort?
 *
 * Every Anthropic call in this codebase sends `{model, max_tokens, messages}`
 * and nothing else. On Claude Opus 5 that means adaptive thinking runs BY
 * DEFAULT at effort `high`, thinking is billed inside output_tokens whatever
 * `display` says, and display defaults to "omitted" — so it is paid for and
 * never returned. Measured over 40 stories: arc_create bills 30,674 output
 * tokens against ~4,000 tokens of visible text, and the arc machine is $1.33 of
 * a $4.57 story. Effort is the only lever on that half.
 *
 * This runs the SAME create prompt at each effort, commits the same way
 * production does (parseArcCreate), and scores each committed arc with the
 * same judges arc_rounds uses. Cost and quality land side by side.
 *
 * params: { efforts, model, judgeModels, stage, promptFrom, challengesFromStory, baselineFromStory }
 *   target: { storyId }
 *
 * params.stage      'create' (default) sweeps params.efforts over the create
 *   call. 'pipeline' runs production's arc machine once: create at
 *   params.createEffort, production's panel on THAT committed arc, then
 *   production's re-tell gate (arcRepairFindings, 2026-09-25): with no quoted
 *   MAJOR or CRITICAL finding no re-telling runs and the result carries
 *   `retellSkipped: 'no MAJOR'`; otherwise one re-telling per
 *   params.retellEfforts against the identical MAJOR/CRITICAL findings, each
 *   committed arc (created and re-told) scored by the same judges.
 * params.promptFrom a Lab experiment id: reuse the create prompt that run
 *   SENT (its sentPrompts) instead of building a fresh one. A fresh build draws
 *   the challenge ideas anew, so this is the only way a later model's arms see
 *   the identical draw — and identical template text — as an earlier sweep.
 *   Throws once the template has changed since that run (by design).
 * params.challengesFromStory  build the prompt fresh from TODAY's template but
 *   with the story's own stored challenge draw, lifted verbatim from
 *   arcReviewReport.createPrompt — so a new arc format sees the SAME draw the
 *   stored arc did, and the comparison has one variable (2026-09-24).
 * params.baselineFromStory  also score the story's stored arcs — the committed
 *   create arc and arcReviewReport.finalArc — with the same judges and the same
 *   judge context, as arms `baseline-create` / `baseline-final` (no model call
 *   beyond the judges), so old and new are read with one ruler (2026-09-24).
 */
async function runArcEffortStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildArcCreatePrompt, buildArcPanelPrompt, buildArcRetellPrompt, parseArcCreate, parseArcRetell, filterPanelFindings, arcRepairFindings, splitCommittedBlock, arcShapeCounts, drawChallengeIdeas } = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');
  const sc = require('./storyScorecard');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const pageCount = (storyData.sceneImages || []).length || storyData.pages || 10;
  // Every level Opus 5 takes. xhigh and max cost MORE than the current default
  // (`high`), so the sweep prices both directions: what medium/low save, and
  // what the top of the range would cost if the arc turns out to want it.
  const efforts = String(params.efforts || 'low,medium,high,xhigh,max').split(',').map(s => s.trim()).filter(Boolean);
  // The arc CREATOR, not the reviewer — production reads MODEL_DEFAULTS.arcCreatorModel
  // (beatsPipeline.js:833), and the whole point of this stage is that model's thinking bill.
  // 'claude-opus' is the TEXT_MODELS KEY; 'claude-opus-5' is the model id it
  // resolves to and is not addressable here (the arc_amend default got this
  // wrong and burned a run).
  const model = params.model || MODEL_DEFAULTS.arcCreatorModel || 'claude-opus';
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);
  const judges = String(params.judgeModels || 'claude-sonnet,grok-4.6')
    .split(',').map(s => s.trim()).filter(Boolean);
  for (const j of judges) if (!TEXT_MODELS[j]) throw new Error(`Unknown judge "${j}"`);

  // Production draws the challenge ideas fresh and passes the section through
  // (beatsPipeline.js:889/947); omitting it would build a prompt production
  // never sends. Drawn ONCE so every effort arm sees the identical prompt —
  // the arms differ in effort and nothing else.
  const stage = params.stage || 'create';
  if (!['create', 'pipeline'].includes(stage)) throw new Error(`Unknown stage "${stage}" (create | pipeline)`);
  let prompt;
  let promptSource;
  // The drawn section itself — the pipeline's re-telling must be handed the
  // SAME draw the creator saw (production passes one `challengeIdeas` to both).
  let challengeIdeas;
  const flag = v => v === true || v === 'true';
  if (params.promptFrom && flag(params.challengesFromStory)) throw new Error('promptFrom and challengesFromStory are exclusive');
  if (params.promptFrom) {
    if (promptOverride) throw new Error('promptFrom and promptOverride are exclusive');
    const { dbQuery } = require('../services/database');
    const expId = parseInt(params.promptFrom, 10);
    const rows = await dbQuery('SELECT stage, results FROM testlab_experiments WHERE id = $1', [expId]);
    if (!rows.length) throw new Error(`promptFrom ${expId}: not found`);
    if (rows[0].stage !== 'arc_effort') throw new Error(`promptFrom ${expId}: stage is ${rows[0].stage}, not arc_effort`);
    const out = (rows[0].results || []).find(r => r.storyId === target.storyId);
    if (!out) throw new Error(`promptFrom ${expId}: no result for ${target.storyId}`);
    const sent = (out.sentPrompts || []).filter(sp => sp.label === 'testlab_arc_effort' && !sp.truncated && sp.text);
    if (!sent.length) throw new Error(`promptFrom ${expId}: no untruncated create prompt stored`);
    if (new Set(sent.map(sp => sp.text)).size !== 1) throw new Error(`promptFrom ${expId}: its arms sent different prompts`);
    prompt = sent[0].text;
    promptSource = `create prompt sent by Lab #${expId}, verbatim`;
    // Recover that run's draw: the create template's text up to
    // {CHALLENGE_IDEAS} is fixed, and the section ends where the template's
    // next fixed text begins. Both anchors must match or this throws.
    const SENTINEL = '@@CHALLENGE_IDEAS_SENTINEL@@';
    const [pre, post] = buildArcCreatePrompt(storyData, pageCount, { challengeIdeas: SENTINEL }).split(SENTINEL);
    if (!prompt.startsWith(pre)) throw new Error(`promptFrom ${expId}: the text ahead of the challenge section no longer matches today's template — cannot recover its draw`);
    const end = prompt.indexOf(post.slice(0, 300), pre.length);
    if (end < 0) throw new Error(`promptFrom ${expId}: the text after the challenge section no longer matches today's template — cannot recover its draw`);
    challengeIdeas = prompt.slice(pre.length, end);
  } else {
    if (flag(params.challengesFromStory)) {
      challengeIdeas = storedChallengeSection(storyData);
      promptSource = 'built fresh from today\'s template, with the story\'s stored challenge draw';
    } else {
      challengeIdeas = drawChallengeIdeas(storyData, {}).section;
      promptSource = 'built fresh (new challenge draw)';
    }
    // withTemplates, not `PROMPT_TEMPLATES.x = override` + finally: that global
    // mutation is what kept the Lab single-flight, because a second experiment's
    // override is what this builder would read (prompts.js, 2026-08-25).
    const { withTemplates } = require('../services/prompts');
    prompt = withTemplates(
      { arcCreate: promptOverride },
      () => buildArcCreatePrompt(storyData, pageCount, { challengeIdeas }),
    );
  }
  if (!prompt) throw new Error('arc-create prompt could not be built');

  const judgeTemplate = PROMPT_TEMPLATES.storyArcJudge;
  if (!judgeTemplate) throw new Error('story-arc-judge template unavailable');
  const context = sc.buildBriefContext({ ...storyData, pages: pageCount }, { arc: true });
  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});

  const scoreArc = async (arcText) => {
    const input = `# BRIEF (the commission — context only, not scored)\n${context}\n\n===\n\n# ARC\n${arcText}`;
    const draws = await Promise.all(judges.map(async (j) => {
      try {
        const r = await callTextModelStreaming(`${judgeTemplate}\n\n---\n\n${input}`, null, null, j, { usageLabel: 'testlab_arc_effort_judge' });
        const dims = sc.parseJudgeJson(r.text)?.arc?.dims || {};
        const keys = sc.ARC_RUBRIC.arc.filter(k => { const n = Number(dims[k]); return Number.isFinite(n) && n >= 1 && n <= 10; });
        return keys.length
          ? { judge: j, score: keys.reduce((s, k) => s + Number(dims[k]), 0) / keys.length, dims, cost: costOf(r) }
          : { judge: j, score: null, cost: costOf(r) };
      } catch (e) { return { judge: j, score: null, error: String(e.message || e) }; }
    }));
    const ok = draws.filter(d => Number.isFinite(d.score));
    return { draws, mean: ok.length ? ok.reduce((s, d) => s + d.score, 0) / ok.length : null };
  };

  // One arc call at one effort, committed the way production commits that
  // phase (parseArcCreate for a create, parseArcRetell's FINAL ARC for a
  // re-telling), then scored. A failed arm is recorded, never thrown.
  const runArm = async (phase, armPrompt, effort) => {
    const t = Date.now();
    try {
      const res = await callTextModelStreaming(armPrompt, null, null, model, { usageLabel: phase === 'retell' ? 'testlab_arc_effort_retell' : 'testlab_arc_effort', effort });
      const visible = String(res.text || '');
      let commit = null, parseError = null;
      try { commit = phase === 'retell' ? parseArcRetell(visible) : parseArcCreate(visible); } catch (e) { parseError = String(e.message || e); }
      const arcText = phase === 'retell' ? (commit?.finalArc || visible) : (commit?.arc || visible);
      const scored = commit ? await scoreArc(arcText) : { draws: [], mean: null };
      const out = res.usage?.output_tokens || 0;
      // The gap IS the finding: billed output minus what came back as text.
      const visibleTokens = Math.round(visible.length / 3.5);
      return {
        arm: {
          phase, effort, ok: true, parseError,
          // The advisory task budget this call carried (models.js
          // taskBudgetAtEffort; Opus 5.5 at max, 2026-09-25), or null.
          taskBudget: TEXT_MODELS[model].taskBudgetAtEffort?.[effort] ?? null,
          cost: costOf(res), elapsedMs: Date.now() - t,
          inputTokens: res.usage?.input_tokens || 0,
          outputTokens: out,
          visibleChars: visible.length,
          visibleTokensApprox: visibleTokens,
          invisibleShare: out ? Number((1 - visibleTokens / out).toFixed(2)) : null,
          score: scored.mean,
          judgeDraws: scored.draws,
          judgeCost: scored.draws.reduce((s, d) => s + (d.cost || 0), 0),
          arc: arcText,
          // The story logic, the critique and the code counts production logs
          // (arcShapeCounts), so a reader can set logic against arc.
          logic: commit?.logic?.text || null,
          critique: commit?.critique || null,
          counts: commit ? arcShapeCounts({ sentences: commit.sentences, logic: commit.logic, inputData: storyData, pageCount }) : null,
        },
        commit,
      };
    } catch (err) {
      return { arm: { phase, effort, ok: false, error: String(err.message || err), elapsedMs: Date.now() - t }, commit: null };
    }
  };

  // Serial: these are large Opus calls and the point is a clean per-arm cost.
  const arms = [];
  let panel = null;
  // The re-tell gate's verdict (pipeline stage only): what it passed, or why
  // no re-telling ran.
  let gate = null;
  let retellSkipped = null;
  if (flag(params.baselineFromStory)) {
    const report = storyData.arcReviewReport || {};
    const baselines = [
      ['baseline-create', storedCommittedArc(report)],
      ['baseline-final', String(report.finalArc || '').trim()],
    ];
    for (const [phase, arcText] of baselines) {
      if (!arcText) throw new Error(`baselineFromStory: the story stores no ${phase === 'baseline-final' ? 'arcReviewReport.finalArc' : 'committed create arc'}`);
      const scored = await scoreArc(arcText);
      arms.push({
        phase, effort: null, ok: true, cost: 0,
        score: scored.mean, judgeDraws: scored.draws,
        judgeCost: scored.draws.reduce((s, d) => s + (d.cost || 0), 0),
        arc: arcText,
      });
    }
  }
  if (stage === 'create') {
    for (const effort of efforts) arms.push((await runArm('create', prompt, effort)).arm);
  } else {
    // PIPELINE: one create at params.createEffort, then production's panel on
    // THAT committed arc, then one re-telling per params.retellEfforts — every
    // re-telling answers the identical panel output, so they differ in effort
    // alone. Same panel models, temperature and letter labels as production
    // (beatsPipeline.js, PANEL + RE-TELL).
    const createEffort = params.createEffort || 'high';
    const retellEfforts = String(params.retellEfforts || 'high,low').split(',').map(s => s.trim()).filter(Boolean);
    const created = await runArm('create', prompt, createEffort);
    arms.push(created.arm);
    if (!created.commit) throw new Error(`create at ${createEffort} did not commit: ${created.arm.parseError || created.arm.error}`);
    const panelPrompt = buildArcPanelPrompt(storyData, created.commit.committed);
    if (!panelPrompt) throw new Error('arc-panel template unavailable');
    const panelModels = MODEL_DEFAULTS.arcPanelModels || [];
    const tempFor = (m, temp) => (temp == null || TEXT_MODELS[m]?.provider === 'anthropic') ? {} : { temperature: temp };
    const settled = await Promise.allSettled(panelModels.map(async (m) => {
      const res = await callTextModelStreaming(panelPrompt, null, null, m, { usageLabel: 'testlab_arc_effort_panel', ...tempFor(m, MODEL_DEFAULTS.arcPanelTemperature) });
      const text = String(res?.text || '').trim();
      if (!text) throw new Error('empty panel response');
      // Production's filter (beatsPipeline PANEL): an unquoted or untagged
      // finding never reaches the re-telling.
      const f = filterPanelFindings(text, created.commit.committed);
      return { model: res.modelId || m, raw: text, text: f.text, findings: f.findings, keptFindings: f.kept.length, droppedFindings: f.dropped, untaggedFindings: f.untagged, cost: costOf(res) };
    }));
    panel = settled.map((r, i) => (r.status === 'fulfilled'
      ? { ok: true, ...r.value }
      : { ok: false, model: panelModels[i], error: String(r.reason?.message || r.reason) }));
    const voices = panel.filter(p => p.ok);
    if (!voices.length) throw new Error('every panelist failed — nothing to re-tell against');
    voices.forEach((p, i) => { p.letter = String.fromCharCode(65 + i); });
    // Production's re-tell gate (beatsPipeline, sibling set arc-retell-gate).
    const { arcBlock, critique } = splitCommittedBlock(created.commit.committed);
    gate = arcRepairFindings({ critique, reviewedArc: arcBlock, panel: voices });
    if (!gate.retell) {
      retellSkipped = gate.skipReason;
    } else {
      const retellPrompt = buildArcRetellPrompt(storyData, pageCount, arcBlock, gate.text, { challengeIdeas });
      if (!retellPrompt) throw new Error('arc-retell template unavailable');
      for (const effort of retellEfforts) arms.push((await runArm('retell', retellPrompt, effort)).arm);
    }
  }

  const panelCost = (panel || []).reduce((s, p) => s + (p.cost || 0), 0);
  const base = arms.find(a => a.phase === 'create' && a.effort === 'high' && a.ok);
  return {
    storyId: target.storyId, model, stage, promptSource, judges, pageCount, promptChars: prompt.length,
    arms,
    panel,
    retellSkipped,
    gate: gate && { repair: gate.count, critiqueRepair: gate.critiqueRepair, panelRepair: gate.panelRepair, critiqueDropped: gate.critique.dropped, critiqueUntagged: gate.critique.untagged },
    totalCost: Number((arms.reduce((s, a) => s + (a.cost || 0) + (a.judgeCost || 0), 0) + panelCost).toFixed(4)),
    summary: [
      ...arms.map(a => (a.ok && a.phase.startsWith('baseline')
        ? `${a.phase}: score ${a.score == null ? 'n/a' : a.score.toFixed(2)} (stored arc, judges only)`
        : a.ok
        ? `${a.phase} ${a.effort}: $${a.cost.toFixed(4)} | out ${a.outputTokens} tok (${a.invisibleShare != null ? Math.round(a.invisibleShare * 100) : '?'}% not returned) | score ${a.score == null ? 'n/a' : a.score.toFixed(2)}`
          + (stage === 'create' && base && a !== base ? ` | ${(((a.cost - base.cost) / base.cost) * 100).toFixed(0)}% cost vs high` : '')
          + (a.parseError ? ` | PARSE FAILED: ${a.parseError}` : '')
        : `${a.phase} ${a.effort}: FAILED ${a.error}`)),
      ...(panel ? [`panel: ${panel.filter(p => p.ok).length}/${panel.length} voices, $${panelCost.toFixed(4)}`] : []),
      ...(gate ? [retellSkipped
        ? `re-telling skipped: ${retellSkipped} (no quoted MAJOR/CRITICAL finding) — the created arc is final`
        : `re-tell gate: ${gate.count} MAJOR/CRITICAL finding(s) passed`] : []),
    ],
  };
}
/**
 * The story's own stored challenge draw: the "# CHALLENGE IDEAS" section of
 * arcReviewReport.createPrompt, verbatim up to the next top-level heading.
 * Throws when the prompt or the section is missing — a fresh draw would be a
 * second variable, never a stand-in.
 */
function storedChallengeSection(storyData) {
  const prompt = String(storyData?.arcReviewReport?.createPrompt || '');
  if (!prompt) throw new Error('challengesFromStory: the story stores no arcReviewReport.createPrompt');
  const start = prompt.search(/^# CHALLENGE IDEAS/m);
  if (start < 0) throw new Error('challengesFromStory: the stored create prompt has no # CHALLENGE IDEAS section');
  const rest = prompt.slice(start);
  const next = rest.slice(1).search(/^# /m);
  const section = (next >= 0 ? rest.slice(0, next + 1) : rest).trimEnd();
  // The draw is its entries; the heading is template text. A stored heading
  // may carry a challenge count today's arc no longer states (2026-09-25), so
  // the entries are re-headed with today's heading — one variable, the arc.
  const { CHALLENGE_IDEAS_HEADING } = require('./promptBuilders');
  const lines = section.split('\n');
  const entries = lines.filter(l => /^\s*-\s*\[C\d+\]/.test(l));
  if (entries.length) return [...CHALLENGE_IDEAS_HEADING, '', ...entries].join('\n');
  // READ-COMPAT: stories drawn before the [C###] ids (2026-09-20) list their
  // challenges as bare "- <challenge>" lines (Lab #1468 failed on
  // job_1789420511893_zly5rcdej). They are the same draw, reused as they
  // stand; the heading's tag line is left out, since these entries carry none.
  const legacy = lines.filter(l => /^\s*-\s+\S/.test(l));
  if (!legacy.length) throw new Error('challengesFromStory: the stored # CHALLENGE IDEAS section lists no challenge entries');
  return [...CHALLENGE_IDEAS_HEADING.filter(l => !l.includes('[C###]')), '', ...legacy].join('\n');
}

/**
 * The committed create arc of a stored story, without its critique.
 *
 * READ-COMPAT, NOT A FALLBACK: stories written before 2026-09-24 store the
 * two-arc shape (`committed` = "ARC N:" + critique + the "Stronger:" line) and
 * cannot be migrated; newer ones store "STORY LOGIC:" + "ARC:" + "CRITIQUE:".
 * Both are data at rest; the live pipeline writes only the new one.
 */
function storedCommittedArc(report = {}) {
  const committed = String(report.committed || '');
  if (!committed.trim()) return '';
  if (/^\s*(?:\*\*|#+\s*)?STORY LOGIC/mi.test(committed)) {
    return require('./storyHelpers').parseArcCreate(committed).arc;
  }
  const crit = committed.search(/^\s*(?:\*\*|#+\s*)?CRITIQUE\s*:?/mi);
  return (crit >= 0 ? committed.slice(0, crit) : committed)
    .replace(/^\s*(?:\*\*|#+\s*)?ARC\s*\d\s*:?\**\s*/i, '')
    .trim();
}

/**
 * arc_amend — the bake-off for repairing the arc in place.
 *
 * Today's hint pass emits a DIRECTIVE against a frozen arc: the planner obeys
 * it, the arc keeps asserting the opposite, and nobody can diff what changed.
 * The amend pass returns the repaired BEAT instead, which is boundable
 * (server/lib/arcAmend.js). Whether a cheap model may rewrite a beat an Opus
 * call wrote is the open question, so every model runs the same prompt on the
 * same stored arc and each repair is judged improved / neutral / damaged.
 *
 * The judge is the half that matters: a model can execute a WRONG instruction
 * faithfully, and guards alone would pass it. `issueWasReal: false` is the
 * signal to watch — it means the model invented a problem and edited a good
 * beat to "fix" it.
 *
 * params: { models, judgeModel }   target: { storyId }
 */
async function runArcAmendStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildArcAmendPrompt } = require('./promptBuilders');
  const { extractJsonFromText } = require('./storyHelpers');
  const { parseArcAmend, checkAmendGuards, applyArcAmendment, splitArcBeats } = require('./arcAmend');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const arc = resolveReplayArc(storyData);
  if (!arc) throw new Error('story has no stored arc to amend');

  // TEXT_MODELS keys, not model ids: 'claude-sonnet' is the key,
  // 'claude-sonnet-4-6' is what it resolves to and is not addressable here.
  const models = String(params.models || 'grok-4.6,deepseek-v4-pro,gpt-5.6-luna-pro,claude-sonnet')
    .split(',').map(s => s.trim()).filter(Boolean);
  const judgeModel = params.judgeModel || 'claude-sonnet';
  for (const m of [...models, judgeModel]) {
    if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);
  }

  if (!promptOverride && !PROMPT_TEMPLATES.arcAmend) throw new Error('arc-amend template unavailable');
  // withTemplates, not a global assign + finally — see the note in arc_effort.
  const { withTemplates } = require('../services/prompts');
  const prompt = withTemplates(
    { arcAmend: promptOverride },
    () => buildArcAmendPrompt(storyData, arc),
  );
  if (!prompt) throw new Error('arc-amend prompt could not be built');

  const judgeTemplate = PROMPT_TEMPLATES.arcAmendJudge;
  if (!judgeTemplate) throw new Error('arc-amend-judge template unavailable');
  const beforeByNumber = new Map(splitArcBeats(arc).map(b => [b.n, b.text]));
  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});

  const judgeOne = async (issue, n, after) => {
    const input = fillTemplate(judgeTemplate, {
      FINAL_ARC: arc,
      ISSUE: issue ? `${issue.issue} → ${issue.change}` : '(the model named no issue for this beat)',
      BEAT_BEFORE: beforeByNumber.get(n) || '(beat not found)',
      BEAT_AFTER: after,
    });
    const r = await callTextModelStreaming(input, null, null, judgeModel, { usageLabel: 'testlab_arc_amend_judge' });
    let v = null;
    try { v = extractJsonFromText(r.text); } catch { /* a bad draw is not a verdict */ }
    return { verdict: v, cost: costOf(r) };
  };

  // The arms are independent, so they go concurrently.
  const arms = await Promise.all(models.map(async (model) => {
    const t = Date.now();
    try {
      const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_arc_amend' });
      const parsed = parseArcAmend(res.text || '');
      const guard = checkAmendGuards(arc, parsed);
      const applied = applyArcAmendment(arc, parsed);
      const issueFor = n => parsed.issues.find(i => (i.beats || []).includes(n)) || null;
      const judged = [];
      let judgeCost = 0;
      for (const [n, after] of parsed.beats) {
        if (!beforeByNumber.has(n)) continue;
        const j = await judgeOne(issueFor(n), n, after);
        judgeCost += j.cost;
        judged.push({
          beat: n,
          before: beforeByNumber.get(n),
          after,
          issue: issueFor(n),
          ...(j.verdict || { verdict: 'unjudged' }),
        });
      }
      const tally = judged.reduce((acc, j) => {
        acc[j.verdict] = (acc[j.verdict] || 0) + 1;
        if (j.issueWasReal === false) acc.inventedIssue = (acc.inventedIssue || 0) + 1;
        return acc;
      }, {});
      return {
        model, modelId: res.modelId, ok: true,
        issues: parsed.issues,
        beatsRewritten: [...parsed.beats.keys()],
        guardOk: guard.ok,
        violations: guard.violations,
        judged, tally,
        amendedArc: applied.arc,
        cost: costOf(res), judgeCost,
        elapsedMs: Date.now() - t,
        outTok: res.usage?.output_tokens,
      };
    } catch (err) {
      return { model, ok: false, error: String(err.message || err), elapsedMs: Date.now() - t };
    }
  }));

  return {
    storyId: target.storyId,
    judgeModel,
    beatCount: beforeByNumber.size,
    arcChars: arc.length,
    promptChars: prompt.length,
    arms,
    // One line per arm, so a reader can rank without opening every arm.
    summary: arms.map(a => a.ok
      ? `${a.model}: beats ${a.beatsRewritten.join(',') || '-'} | ${JSON.stringify(a.tally)} | guards ${a.guardOk ? 'ok' : a.violations.join('; ')} | $${(a.cost + a.judgeCost).toFixed(4)}`
      : `${a.model}: FAILED ${a.error}`),
  };
}

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
  const context = sc.buildBriefContext({ ...storyData, pages: pageCount }, { arc: true });

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
        return { score, dims, notes: sc.flattenNotes(parsed.arc.notes), cost: costOf(r) };
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

  // Round 0 — the arc as created. The arc rules live in arc-create (the beats
  // template divides a finished story and authors none), so the authoring
  // rounds build on that template and ask for one ---ARC--- block.
  const { buildArcCreatePrompt } = require('./storyHelpers');
  let planPrompt = buildArcCreatePrompt(storyData, pageCount);
  if (!planPrompt) throw new Error('story-beats template unavailable');
  if (promptOverride) planPrompt = promptOverride;
  planPrompt += '\n\nInstead of the output contract above: write ONE arc and output it as an ---ARC--- block only — no critique, no commitment line.';

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

/**
 * ARC PANEL REPLAY — the panel, and only the panel, on a frozen committed arc.
 *
 * Production runs the panel once inside a generation, over an arc the creator
 * has only just written. That makes a panel-prompt change unmeasurable: rerun
 * the pipeline and the arc differs, so any change in what the panel finds could
 * be the new arc rather than the new prompt.
 *
 * This replays the panel against a story's STORED committed arc block
 * (arcReviewReport.committed = the committed arc plus the creator's own
 * critique — byte-identical to what production sent). The only variable is the
 * prompt, or the models.
 *
 * params.panelModels — comma-separated override of the panel (default: the
 *                      production arcPanelModels)
 * params.retell      — also run the re-telling on the new panel output, so the
 *                      question is answered end to end and not just at the panel.
 *                      Production's re-tell gate applies (arcRepairFindings,
 *                      2026-09-25): with no quoted MAJOR or CRITICAL finding
 *                      the re-telling is not run and `retell.skipped` says why.
 * promptOverride     — full replacement arc-panel template, the usual Lab lever
 */
async function runArcPanelReplayStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const H = require('./storyHelpers');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const report = storyData.arcReviewReport || {};
  // The committed block is what production handed the panel, verbatim. Without
  // it there is nothing to replay against and a reconstruction would not be the
  // same input, so this fails rather than approximating. Stories from before
  // 2026-09-24 store the two-arc block (no STORY LOGIC); it replays as stored,
  // and the re-telling writes a logic block of its own.
  const committed = String(report.committed || '').trim();
  if (!committed) throw new Error('story has no stored arcReviewReport.committed block to replay');

  const orig = PROMPT_TEMPLATES.arcPanel;
  if (promptOverride) PROMPT_TEMPLATES.arcPanel = promptOverride;
  let prompt;
  try {
    prompt = H.buildArcPanelPrompt(storyData, committed);
  } finally {
    PROMPT_TEMPLATES.arcPanel = orig;
  }
  if (!prompt) throw new Error('arc-panel template unavailable');

  const models = String(params.panelModels || params.models || (MODEL_DEFAULTS.arcPanelModels || []).join(','))
    .split(',').map(x => x.trim()).filter(Boolean);
  if (!models.length) throw new Error('no panel models resolved');
  for (const m of models) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);
  const tempFor = (model, temp) =>
    (temp == null || TEXT_MODELS[model]?.provider === 'anthropic') ? {} : { temperature: temp };

  const runs = [];
  for (const model of models) {
    // One arm's failure must not destroy the others — a fan-out is a comparison.
    try {
      const t = Date.now();
      const res = await callTextModelStreaming(prompt, null, null, model, {
        usageLabel: 'testlab_arc_panel_replay', ...tempFor(model, MODEL_DEFAULTS.arcPanelTemperature),
      });
      const text = String(res.text || '').trim();
      const outTok = res.usage?.output_tokens ?? null;
      // An empty response is a failed call, not a panel that found nothing.
      if (!text || outTok === 0) {
        throw new Error(`panelist ${model} returned an empty response (${outTok} output tokens) — provider failure, not a review`);
      }
      // Production's filter (beatsPipeline PANEL): the re-telling below reads
      // only the tagged findings that quote the arc; the raw reply ships beside them.
      const f = H.filterPanelFindings(text, committed);
      runs.push({
        model, modelId: res.modelId, ok: true,
        elapsedMs: Date.now() - t,
        cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
        usage: res.usage,
        raw: text,
        text: f.text,
        findings: f.findings,
        keptFindings: f.kept.length,
        droppedFindings: f.dropped,
        untaggedFindings: f.untagged,
      });
    } catch (err) {
      log.warn(`⚠️ [arc panel replay] arm ${model} failed: ${err.message}`);
      runs.push({ model, ok: false, error: err.message });
    }
  }

  // Optional second half: does the new panel output change the re-telling? Same
  // creator and temperature as production, so only the panel input differs.
  let retell = null;
  if (params.retell === true || params.retell === 'true') {
    // THE PANEL IS ALREADY PAID FOR. A re-telling that cannot start must not
    // discard three completed panel calls — run 989 threw on the model lookup
    // and lost $0.12 of good panel output that was already in `runs`.
    try {
      const panel = runs.filter(r => r.ok);
      if (!panel.length) throw new Error('every panelist failed — nothing to re-tell against');
      panel.forEach((p, i) => { p.letter = String.fromCharCode(65 + i); });
      // Production's re-tell gate (beatsPipeline, sibling set arc-retell-gate):
      // no quoted MAJOR or CRITICAL finding, no re-telling.
      const { arcBlock, critique } = H.splitCommittedBlock(committed);
      const gate = H.arcRepairFindings({ critique, reviewedArc: arcBlock, panel });
      const gateReport = { repair: gate.count, critiqueRepair: gate.critiqueRepair, panelRepair: gate.panelRepair, critiqueDropped: gate.critique.dropped, critiqueUntagged: gate.critique.untagged };
      if (!gate.retell) {
        retell = { ok: true, skipped: gate.skipReason, gate: gateReport };
      } else {
        const pageCount = (storyData.sceneImages || []).length || parseInt(storyData.pages, 10) || 14;
        const retellPrompt = H.buildArcRetellPrompt(storyData, pageCount, arcBlock, gate.text);
        if (!retellPrompt) throw new Error('arc-retell template unavailable');
        // `arcReviewReport.creatorModel` is the RESOLVED model id the provider
        // returned ("claude-opus-5"), not the TEXT_MODELS config key the caller
        // needs ("claude-opus"). Only honour it when it is also a valid key.
        const retellModel = String(
          params.retellModel
          || (TEXT_MODELS[report.creatorModel] ? report.creatorModel : null)
          || MODEL_DEFAULTS.arcCreatorModel
        );
        if (!TEXT_MODELS[retellModel]) throw new Error(`Unknown model "${retellModel}"`);
        const t = Date.now();
        const res = await callTextModelStreaming(retellPrompt, null, null, retellModel, {
          usageLabel: 'testlab_arc_retell_replay', ...tempFor(retellModel, MODEL_DEFAULTS.arcRetellTemperature),
          // Production's re-tell effort, so the replay reproduces the shipped call.
          ...(MODEL_DEFAULTS.arcRetellEffort ? { effort: MODEL_DEFAULTS.arcRetellEffort } : {}),
        });
        const parsed = H.parseArcRetell(res.text || '');
        retell = {
          ok: true,
          model: retellModel, modelId: res.modelId,
          elapsedMs: Date.now() - t,
          cost: res.usage?.direct_cost ?? calculateTextCost(res.modelId || '', res.usage || {}),
          fixing: parsed.fixing, keeping: parsed.keeping, used: parsed.used,
          logic: parsed.logic.text,
          finalArc: parsed.finalArc, critique: parsed.critique,
          maxSeverity: H.critiqueMaxSeverity(parsed.critique),
          gate: gateReport,
        };
      }
    } catch (err) {
      log.warn(`⚠️ [arc panel replay] re-tell failed: ${err.message} — panel output stands`);
      retell = { ok: false, error: err.message };
    }
  }

  return {
    stageKind: 'arc_panel_replay',
    storyId: target.storyId,
    title: storyData.title || null,
    creatorModel: report.creatorModel || null,
    productionPanel: report.panelModels || null,
    // The frozen input, so a reader can see the panel was handed the same arc.
    committed,
    promptChars: prompt.length,
    prompt,
    runs,
    retell,
    totalCost: Number([...runs.map(r => r.cost || 0), retell?.cost || 0].reduce((a, b) => a + b, 0).toFixed(4)),
  };
}

/**
 * VB ELEMENT CELL — render one Visual Bible element's reference cell(s) the
 * way generateReferenceSheet does (kind sentence, solo call, page aspect for
 * non-characters, `text` → typography tier) and ask the cell gate the same
 * question production asks. Target {storyId}; params.elementId required.
 *
 * Verdict only: the Lab shows what the gate said; the pipeline owns the one
 * re-render. Built 2026-09-11 for the dish-instead-of-scale cell of
 * job_1789078732136_622wecmhj.
 *
 * params.elementId   — bare id (ART001 / CHR001 / VEH002); a stated object renders every state
 * params.gateOnly    — judge the STORED cell(s), no image call
 * params.model       — IMAGE_MODELS key (default: text → vbTextCellModel, else pageImage)
 * params.text        — readable words for the element (overrides the entry's `text`)
 * params.description — description override
 * promptOverride     — replaces the reference-sheet template
 */
async function runVbElementCellStage(target, { experimentId, promptOverride = null, params = {} }) {
  const { loadPromptTemplates, withTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const refSheets = require('./referenceSheets');
  const { resolveArtStyle } = require('./promptBuilders');
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
  const { loadVbReferenceBytes } = require('./characterPhotos');
  const { objectStates } = require('./visualBible');
  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const vb = storyData.visualBible;
  if (!vb) throw new Error('Story has no visualBible');
  const elementId = String(params.elementId || '').trim().toUpperCase();
  if (!elementId) throw new Error('params.elementId is required (e.g. ART001)');
  // Locations have no reference cell in production (owner, 2026-09-24): an
  // invented location is built from its bible text, a real one from its photo.
  if ((vb.locations || []).some(e => String(e.id || '').toUpperCase() === elementId)) {
    throw new Error(`${elementId} is a location — locations have no reference cell (the plate is built from the bible text)`);
  }
  const POOLS = { secondaryCharacters: 'character', artifacts: 'artifact', animals: 'animal', vehicles: 'vehicle' };
  let entry = null;
  let type = null;
  for (const [pool, t] of Object.entries(POOLS)) {
    const hit = (vb[pool] || []).find(e => String(e.id || '').toUpperCase() === elementId);
    if (hit) { entry = hit; type = t; break; }
  }
  if (!entry) throw new Error(`${elementId} is not in this story's visual bible`);
  // Same shape getElementsNeedingReferenceImages hands the sheet: pool on
  // `type`, the bible's free-text type on `kind`.
  const el = { ...entry, kind: typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : null, type, pageCount: (entry.appearsInPages || []).length };
  if (params.text !== undefined) el.text = String(params.text || '').trim() || null;
  if (params.description) el.description = String(params.description);
  const cells = refSheets.expandElementStateCells(el);
  const textCell = cells.length === 1 && String(cells[0].text || '').trim();
  const modelKey = params.model || (textCell ? MODEL_DEFAULTS.vbTextCellModel : MODEL_DEFAULTS.pageImage);
  if (!IMAGE_MODELS[modelKey]) throw new Error(`Unknown model "${modelKey}" — not an IMAGE_MODELS key`);
  const styleDescription = resolveArtStyle(storyData.artStyle, IMAGE_MODELS[modelKey].backend) || resolveArtStyle('pixar');
  const aspect = type === 'character' ? null : (storyData.layout?.imageAspect || MODEL_DEFAULTS.pageAspect);
  const steps = [];
  const addStep = async (label, dataUri) => {
    const v = await saveTestVersion(target.storyId, 'tl_step', null, dataUri, experimentId);
    steps.push({ label, imageType: 'tl_step', versionIndex: v });
    return v;
  };
  const t0 = Date.now();
  let prompt = null;
  let modelId = null;
  let cellsB64 = [];
  if (params.gateOnly) {
    for (const c of cells) {
      const src = cells.length > 1 ? (objectStates(entry).find(s => s.id === c.id) || null) : entry;
      const buf = src ? await loadVbReferenceBytes(src) : null;
      if (!buf) throw new Error(`No stored reference for ${c.id}`);
      // loadVbReferenceBytes contracts a base64 STRING (characterPhotos
      // _getOrFetch); re-encoding it double-encoded the cell (exps 1171-1174).
      cellsB64.push(typeof buf === 'string' ? buf : Buffer.from(buf).toString('base64'));
    }
  } else {
    prompt = withTemplates({ referenceSheet: promptOverride }, () => refSheets.buildReferenceSheetPrompt(cells, styleDescription, vb));
    const { callGeminiAPIForImage } = require('./images');
    const result = await callGeminiAPIForImage(prompt, [], null, 'avatar', null, modelKey, null, '', null, [], 0, null, null, null, null, aspect);
    if (!result?.imageData) throw new Error('render returned no image');
    modelId = result.modelId || modelKey;
    const gridB64 = require('./r2').stripDataUriPrefix(result.imageData);
    if (cells.length > 1) await addStep(`rendered sheet (${cells.length} state cells) — ${modelId}`, result.imageData);
    cellsB64 = await refSheets.splitGridIntoReferences(gridB64, cells.length, cells);
  }
  let firstV = null;
  for (let i = 0; i < cells.length; i++) {
    if (!cellsB64[i]) continue;
    const v = await addStep(`${params.gateOnly ? 'stored' : 'rendered'} cell ${cells[i].id}${cells[i].stateName ? ` — ${cells[i].stateName}` : ''}`, `data:image/png;base64,${cellsB64[i]}`);
    if (firstV == null) firstV = v;
  }
  const gates = [];
  if (cells.length > 1 && cellsB64.every(Boolean)) {
    const parent = { ...cells[0], name: cells[0].displayName, description: cells[0].baseDescription };
    const question = refSheets.stateCellsGatePrompt(parent, cells);
    const v = await refSheets.checkStateCellsConsistency(cellsB64, parent, cells);
    gates.push({ gate: 'state_cells', cellIds: cells.map(c => c.id), ...v, question });
  }
  for (let i = 0; i < cells.length; i++) {
    if (!cellsB64[i]) continue;
    if (type === 'character') {
      const question = refSheets.cellGatePrompt(styleDescription, cells[i].age || null, cells[i].build || null);
      const v = await refSheets.checkCharacterCellRender(cellsB64[i], styleDescription, cells[i].age || null, cells[i].build || null);
      gates.push({ gate: 'character_cell', cellId: cells[i].id, ok: v.natural, reason: v.reason, question });
    } else {
      const question = refSheets.elementCellGatePrompt(cells[i], styleDescription);
      const v = await refSheets.checkElementCellRender(cellsB64[i], cells[i], styleDescription);
      gates.push({ gate: 'element_cell', cellId: cells[i].id, ...v, question });
    }
  }
  return {
    imageType: 'tl_step', versionIndex: firstV, pageNumber: null, steps,
    elementId, elementName: entry.name, elementType: type, text: el.text || null,
    modelId: modelId || (params.gateOnly ? 'stored cell' : modelKey), aspect, styleDescription, prompt,
    cellLine: refSheets.elementCellText(cells[0]),
    gates,
    allOk: gates.every(g => g.ok),
    issuesSummary: gates.filter(g => !g.ok).map(g => `${g.gate}: ${g.reason}`).join(' | ') || null,
    elapsedMs: Date.now() - t0,
  };
}

// ─── Trial variety stages ───────────────────────────────────────────────────
// Two showcase runs of ONE rotation entry came back as near-identical chestnut
// stories. That had a harness cause (the showcase never called the idea
// endpoint, so storyDetails was empty and buildTrialStoryPrompt fell back to the
// literal 'A fun adventure'), fixed elsewhere. It left two variety questions
// nobody had measured, and these are the two stages that measure them.

// Words that carry no subject. Deliberately small and multilingual-ish: the
// grouping below is an eyeballing aid, not a similarity metric.
const IDEA_STOPWORDS = new Set([
  'the', 'and', 'with', 'that', 'this', 'from', 'into', 'their', 'there', 'them', 'they', 'when', 'while',
  'where', 'what', 'which', 'would', 'could', 'must', 'have', 'has', 'her', 'his', 'she', 'him', 'its',
  'for', 'but', 'not', 'are', 'was', 'were', 'been', 'will', 'then', 'than', 'all', 'one', 'two', 'out',
  'about', 'after', 'before', 'again', 'just', 'only', 'even', 'more', 'most', 'every', 'each', 'own',
  'der', 'die', 'das', 'und', 'mit', 'ein', 'eine', 'einen', 'einem', 'einer', 'sich', 'ist', 'sie', 'ihr',
  'ihre', 'ihren', 'als', 'auf', 'aus', 'den', 'dem', 'des', 'für', 'von', 'zum', 'zur', 'nicht', 'aber',
  'les', 'des', 'une', 'dans', 'pour', 'avec', 'que', 'qui', 'son', 'sur', 'elle', 'est', 'pas', 'plus',
]);

/** Content words of an idea, lowercased and deduped — the grouping key material. */
function ideaSubjectWords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !IDEA_STOPWORDS.has(w))
  );
}

/**
 * Compound-aware word equality. German ideas compound freely — "Herbstblätter"
 * and "Blätter", "Laubhaufen" and "Haufen" are the same premise slot written two
 * ways, and exact string equality scores them as different subjects. Containment
 * (with a length floor so "sein" does not swallow half the vocabulary) catches
 * that without a stemmer.
 */
function ideaWordsMatch(a, b) {
  if (a === b) return true;
  return a.length >= 5 && b.length >= 5 && (a.includes(b) || b.includes(a));
}

/** How many draws in `sigs` contain a word matching `word`. */
function ideaWordDrawCount(sigs, word) {
  return sigs.reduce((n, s) => n + (s.some(w => ideaWordsMatch(w, word)) ? 1 : 0), 0);
}

/**
 * The PREMISE SKELETON of a set of ideas: the content words that recur across
 * most of them, compound-deduped. This is what a human reads as "the same idea
 * again" — an animal, an obstacle, and the resolving action, restated with
 * different nouns each draw.
 *
 * Returned as a plain array, largest-recurrence first, empty when the ideas
 * share no recurring frame.
 */
function ideaPremiseSkeleton(sigs, presenceRatio = 0.6, constantWords = []) {
  if (sigs.length < 2) return [];
  const need = Math.max(2, Math.ceil(presenceRatio * sigs.length));
  // Words the experiment HOLDS CONSTANT — the child's name, the town, the
  // landmark names — recur in every draw by construction and say nothing about
  // the premise. Counting them inflates the skeleton of any arm and made a set
  // of five genuinely different wants look like one repeated idea.
  const vocab = [...new Set(sigs.flat())].filter(w => !constantWords.some(c => ideaWordsMatch(c, w)));
  const scored = vocab
    .map(w => ({ w, n: ideaWordDrawCount(sigs, w) }))
    .filter(x => x.n >= need)
    .sort((a, b) => b.n - a.n || b.w.length - a.w.length);
  const skeleton = [];
  for (const { w } of scored) if (!skeleton.some(k => ideaWordsMatch(k, w))) skeleton.push(w);
  return skeleton;
}

/**
 * Group ideas by PREMISE, not by raw text similarity.
 *
 * Why not Jaccard over the full word set (what this did until 2026-09-14, and
 * what made it anti-correlated with the truth): two ~30-word ideas that restate
 * one premise with a different animal and a different obstacle overlap ~0.15-0.4
 * in raw words, so no threshold separates them from genuinely different ideas —
 * measured on experiment 1273, where a human read all five draws of an arm as
 * one premise and the old metric reported `distinctSubjects: 5, repeatCount: 0`.
 * On that data the pairwise Jaccard floor was 0.18 and its ceiling 0.52; there is
 * no line to draw.
 *
 * What separates instead is the RECURRING FRAME. Extract the skeleton (words
 * present in ≥`presenceRatio` of the ideas), then ask each idea how much of that
 * skeleton it carries. Ideas carrying ≥`coverage` of it are restatements of one
 * premise. Leftovers are re-skeletonised, so a set with two competing premises
 * yields two groups; when nothing recurs, every idea stands alone.
 *
 * LIMITS, stated plainly: this is lexical. It sees that the same frame is being
 * reused; it cannot see that "Igel" and "Eichhörnchen" are both small woodland
 * animals, so a set that swaps EVERY word while keeping the premise will still
 * read as distinct. It is a convergence detector, not a semantic one — the owner
 * still reads the ideas. Guards against the opposite failure (calling everything
 * a repeat): the skeleton must have ≥`minSkeleton` words AND be ≥`minShare` of a
 * typical idea, otherwise no group forms at all.
 */
function groupIdeasByPremise(ideas, opts = {}) {
  const { coverage = 0.6, presenceRatio = 0.6, minSkeleton = 4, minShare = 0.3, constantWords = [] } = opts;
  const entries = ideas.map(idea => ({ idea, sig: [...ideaSubjectWords(idea.text)] }));
  const groups = [];
  let pool = entries;

  while (pool.length > 1) {
    const sigs = pool.map(e => e.sig);
    const sizes = sigs.map(s => s.length).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] || 1;

    // Look for the LARGEST subset that shares a frame, not only a frame the
    // whole pool shares: a couple of unrelated ideas mixed in otherwise dilute
    // the skeleton below the guards and hide a real repeat. Walk the required
    // presence down from "all of them" and take the first level that yields a
    // group at least that large. The guards below are what keep the low levels
    // honest — they do not loosen as the level drops.
    let best = null;
    for (let need = pool.length; need >= Math.max(2, Math.ceil(0.4 * pool.length)); need--) {
      const skeleton = ideaPremiseSkeleton(sigs, need / pool.length, constantWords);
      if (skeleton.length < minSkeleton || skeleton.length / median < minShare) continue;
      const covered = pool.filter(e =>
        skeleton.filter(k => e.sig.some(w => ideaWordsMatch(w, k))).length / skeleton.length >= coverage);
      if (covered.length >= Math.max(2, need)) { best = { covered, skeleton }; break; }
    }
    if (!best) break;

    groups.push({ members: best.covered, premiseWords: best.skeleton });
    pool = pool.filter(e => !best.covered.includes(e));
  }
  for (const e of pool) groups.push({ members: [e], premiseWords: [] });

  return groups
    .map(g => ({
      size: g.members.length,
      members: g.members.map(m => m.idea),
      // The recurring frame these ideas share — empty for a group of one.
      premiseWords: g.premiseWords.slice(0, 25),
      // TRUE intersection: words every member actually contains. The old field
      // called this `sharedWords` while accumulating the UNION, so it listed
      // words only one member had.
      wordsInAllMembers: g.members.length < 2 ? [] : g.members[0].sig
        .filter(w => g.members.every(m => m.sig.some(x => ideaWordsMatch(x, w))))
        .slice(0, 25),
    }))
    .sort((a, b) => b.size - a.size);
}

/**
 * TRIAL IDEA VARIETY — draw the SAME idea pair N times and look at the list.
 *
 * The trial hands the visitor two ideas that must differ in KIND: one grounded
 * in the child's real town, one make-believe entered from home
 * (server/routes/trial.js, POST /generate-ideas-stream). Whether that generator
 * proposes the same premise every time has never been measured, and it is the
 * variety question that survives the showcase-harness fix.
 *
 * MIRROR WARNING: the prompt assembly below duplicates the route's, because the
 * route builds it inline inside an SSE handler and exports nothing. Every shared
 * piece — the template, the costume instructions, the season note, the age-mode
 * block, the landmark lookup, the two branch sentences — is taken from the
 * production module, so only the glue is copied. The branch sentences are pinned
 * against trial.js by tests/unit/testlab-trial-variety-stages.test.ts, so a
 * production edit that this stage does not follow fails the suite.
 *
 * params.draws     — how many PAIRS to generate (default 5, max 20)
 * params.model     — idea model (default claude-sonnet, as production)
 * params.name / age / gender / traits — override the story's main character
 * params.town / language / storyCategory / storyTopic / storyTheme — override the rest
 * params.landmarks — 'false' skips the landmark lookup (ideas then name no real place)
 * params.overlap   — premise-skeleton coverage an idea needs to join a repeat
 *                    group (default 0.6; see groupIdeasByPremise)
 */
async function runTrialIdeaVarietyStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildTrialIdeaPrompts, getTeachingGuide } = require('./promptBuilders');
  const { parseIdeaSelfCheck, stripIdeaSelfCheck } = require('./trialIdeaCheck');
  const { buildSeasonInstruction } = require('./season');
  const { getLanguageInstruction } = require('./languages');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });

  const draws = Math.min(Math.max(parseInt(params.draws, 10) || 5, 1), 20);
  const model = params.model || 'claude-sonnet';
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);
  const overlap = Number.isFinite(Number(params.overlap)) ? Number(params.overlap) : 0.6;

  // The inputs, held identical across every draw — that is the whole experiment.
  const storedChar = (storyData.characters || [])[0] || {};
  const mainChar = {
    name: params.name || storedChar.name || 'the child',
    age: params.age !== undefined ? params.age : storedChar.age,
    gender: params.gender || storedChar.gender || 'male',
    traits: params.traits ? String(params.traits).split(',').map(s => s.trim()).filter(Boolean)
      : (Array.isArray(storedChar.traits) ? storedChar.traits : []),
  };
  const storyCategory = params.storyCategory || storyData.storyCategory || 'adventure';
  const storyTopic = params.storyTopic !== undefined ? params.storyTopic : (storyData.storyTopic || '');
  const storyTheme = params.storyTheme !== undefined ? params.storyTheme : (storyData.storyTheme || '');
  const language = params.language || storyData.language || 'en';
  const userLocation = params.town
    ? { ...(storyData.userLocation || {}), city: String(params.town) }
    : (storyData.userLocation || null);

  // ── route mirror: character line ──
  const charDesc = `${mainChar.name}${mainChar.age ? `, ${mainChar.age} years old` : ''}${mainChar.gender ? `, ${mainChar.gender}` : ''}${mainChar.traits?.length ? ` (${mainChar.traits.join(', ')})` : ''}`;

  // ── route mirror: category context ──
  let categoryContext = '';
  if (storyCategory === 'life-challenge') {
    const { buildThemePlaySentence } = require('../config/storyThemes');
    const themeSentence = buildThemePlaySentence(storyTheme);
    const guide = getTeachingGuide('life-challenge', storyTopic);
    categoryContext = `This is a life skills story about "${storyTopic}". What stands in the way is a person, a creature or a thing that answers back, and the idea says what it costs them.${themeSentence ? ` ${themeSentence}` : ''}${guide ? `\nGuidance for this topic:\n${String(guide).trim()}` : ''}`;
  } else if (storyCategory === 'historical') {
    categoryContext = `This is a historical story about "${storyTopic}". Keep it age-appropriate and educational.`;
  } else if (storyCategory === 'swiss-stories') {
    const { getSwissCityById } = require('./swissStories');
    const cityId = (storyTopic || '').replace(/-\d+$/, '');
    const cityMeta = getSwissCityById(cityId);
    categoryContext = `This is a Swiss local story set in ${cityMeta?.name?.en || cityId}. Use real local landmarks and cultural elements from this city. Keep it age-appropriate and engaging.`;
  } else {
    categoryContext = `This is a ${storyTheme || 'adventure'} story${storyTopic ? ` about "${storyTopic}"` : ''}. Make it exciting and appropriate for children.`;
  }

  // ── route mirror: landmarks ──
  let landmarksText = '';
  const landmarkNames = [];
  if (params.landmarks !== 'false' && params.landmarks !== false && userLocation?.city && storyCategory !== 'historical') {
    try {
      const { getIndexedLandmarks } = require('./landmarkPhotos');
      const landmarks = await getIndexedLandmarks(userLocation, 3);
      if (landmarks.length > 0) {
        landmarkNames.push(...landmarks.map(l => l.name));
        landmarksText = 'At least one scene must take place at one of these real local landmarks: ' + landmarkNames.join(', ') + '.';
      }
    } catch (err) {
      log.debug(`[TESTLAB] idea-variety landmark lookup failed: ${err.message}`);
    }
  }

  const { getTrialTitle } = require('../config/trialTitles');
  const trialTitle = getTrialTitle(storyTopic, storyCategory, mainChar.gender, language);
  const { getTrialCostumeForStory } = require('../config/trialCostumes');
  const ideaCostume = getTrialCostumeForStory({ storyCategory, storyTheme, storyTopic, gender: mainChar.gender });
  const seasonInstruction = storyCategory === 'historical' ? '' : buildSeasonInstruction({});

  const townName = userLocation?.city || '';
  // The route and this stage share ONE assembly (buildTrialIdeaPrompts) — a
  // hand-copied mirror measures a prompt production does not send. The variety
  // axis rotates per arm, so the prompts are rebuilt inside the draw loop.
  const ideaArgs = {
    template: promptOverride || null,
    characters: [mainChar],
    charDesc,
    categoryContext,
    landmarksText,
    townName,
    storyTheme,
    trialTitle,
    langInstruction: getLanguageInstruction(language),
    seasonInstruction,
    ideaCostume,
  };
  let promptLocal = '';
  let promptFantasy = '';

  const t0 = Date.now();
  const usage = [];
  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});
  const pairs = [];
  for (let i = 1; i <= draws; i++) {
    // Both ideas of a pair in parallel, as the route does. One flaky response
    // must not lose the whole run — the draw records its error and the rest
    // still get generated (score_rejudge takes the same line).
    const drawPrompts = buildTrialIdeaPrompts(ideaArgs);
    if (i === 1) { promptLocal = drawPrompts.local; promptFantasy = drawPrompts.fantasy; }
    const [localRes, fantasyRes] = await Promise.all([
      callTextModelStreaming(drawPrompts.local, null, null, model, { usageLabel: 'testlab_trial_idea_variety' }).catch(err => ({ error: err.message })),
      callTextModelStreaming(drawPrompts.fantasy, null, null, model, { usageLabel: 'testlab_trial_idea_variety' }).catch(err => ({ error: err.message })),
    ]);
    for (const r of [localRes, fantasyRes]) if (!r.error) usage.push({ cost: costOf(r), modelId: r.modelId, usage: r.usage });
    // Every card now ends with its own CHECK block (server/lib/trialIdeaCheck.js).
    // It is not part of the idea: left in, it would feed the premise-grouping
    // word frequencies. This stage measures the RAW draw, so it strips and
    // RECORDS the verdict and does not rerun — the rerun is the /try route's
    // job, and a stage that reran would stop measuring what the prompt produces.
    const readCard = (r) => {
      if (r.error) return { text: null, selfCheck: null };
      const raw = String(r.text || '');
      try {
        const parsed = parseIdeaSelfCheck(raw);
        return { text: parsed.idea, selfCheck: { ok: parsed.ok, failure: parsed.failure, event: parsed.event, act: parsed.act } };
      } catch (err) {
        return { text: stripIdeaSelfCheck(raw) || null, selfCheck: { ok: false, failure: 'malformed', error: err.message } };
      }
    };
    const localCard = readCard(localRes);
    const fantasyCard = readCard(fantasyRes);
    pairs.push({
      draw: i,
      axes: { local: drawPrompts.axes.local.want, fantasy: drawPrompts.axes.fantasy.want },
      local: localCard.text,
      fantasy: fantasyCard.text,
      selfCheck: { local: localCard.selfCheck, fantasy: fantasyCard.selfCheck },
      errors: [localRes.error, fantasyRes.error].filter(Boolean),
    });
  }

  // Held constant across every draw by the experiment's own design, so they are
  // no evidence of a repeated premise (see ideaPremiseSkeleton).
  const constantWords = [...ideaSubjectWords(
    [mainChar.name, townName, landmarkNames.join(' '), trialTitle, storyTopic].filter(Boolean).join(' '))];

  // Repeats are counted WITHIN an arm: the two arms are required to differ in
  // kind, so pooling them would report the design as repetition.
  const arms = {};
  for (const arm of ['local', 'fantasy']) {
    const ideas = pairs.filter(p => p[arm]).map(p => ({ draw: p.draw, text: p[arm] }));
    const groups = groupIdeasByPremise(ideas, { coverage: overlap, constantWords });
    const repeated = groups.filter(g => g.size > 1);
    // Raw word frequency across the arm — the cheapest "is it always chestnuts?"
    // read there is, and it needs no grouping decision to be trusted.
    const freq = new Map();
    for (const idea of ideas) for (const w of ideaSubjectWords(idea.text)) freq.set(w, (freq.get(w) || 0) + 1);
    arms[arm] = {
      drawsWithIdea: ideas.length,
      distinctSubjects: groups.length,
      repeatedGroups: repeated.length,
      // "How many draws landed on a subject some other draw also landed on."
      repeatCount: repeated.reduce((s, g) => s + g.size, 0),
      groups: groups.map(g => ({ size: g.size, draws: g.members.map(m => m.draw), ideas: g.members.map(m => m.text), premiseWords: g.premiseWords, wordsInAllMembers: g.wordsInAllMembers })),
      wordsInEveryDraw: [...freq.entries()].filter(([, n]) => n === ideas.length && ideas.length > 1).map(([w]) => w).sort(),
      topWords: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w, n]) => `${w} ×${n}`),
    };
  }

  return {
    storyId: target.storyId,
    model,
    modelId: usage[0]?.modelId || null,
    draws,
    premiseCoverageThreshold: overlap,
    premiseConstantWords: constantWords,
    elapsedMs: Date.now() - t0,
    modelCalls: usage.length,
    cost: usage.reduce((a, u) => a + (u.cost || 0), 0),
    usage: usage.reduce((a, u) => ({
      input_tokens: (a.input_tokens || 0) + (u.usage?.input_tokens || 0),
      output_tokens: (a.output_tokens || 0) + (u.usage?.output_tokens || 0),
    }), {}),
    inputs: { character: charDesc, storyCategory, storyTopic, storyTheme, language, town: townName || null, landmarks: landmarkNames, title: trialTitle || null, costume: ideaCostume?.description || null },
    promptChars: promptLocal.length,
    prompts: { local: promptLocal, fantasy: promptFantasy },
    pairs,
    arms,
    failures: pairs.flatMap(p => p.errors),
  };
}

/**
 * TRIAL CHALLENGE DRAW — the random catalogue draw, with and without.
 *
 * buildChallengeIdeasSection() draws 25 age-banded challenges from
 * prompts/challenge-catalogue.txt and injects them as prompt text (no model
 * call, no cost). It reaches arc-create.txt through the beats pipeline, which
 * draws once and persists the draw as `challengeDraw`. buildTrialStoryPrompt
 * never receives it — the trial writes its whole story in ONE call from
 * story-trial.txt.
 *
 * This stage writes a trial-shaped story twice from the same inputs, once with
 * the draw appended and once without, so the owner can read both. The injection
 * is LAB-ONLY: it appends the section to the prompt this stage built. Nothing is
 * wired into buildTrialStoryPrompt, so a real trial is unaffected.
 *
 * Two things the result states outright:
 *  - BAND SHAPE. `challengeCatalogueBands` returns nothing for the three simple
 *    bands (routine / quest / tries), so at age 3 production draws NO challenges
 *    at all — the catalogue is age-banded but not band-shape-aware, and the
 *    `tries` band wants one problem met three times, which a list of separate
 *    trials does not describe. The stage reports the resolved band, the
 *    band's own plot-shape text, and every drawn entry with the trait it tests,
 *    so the fit is judged on the entries rather than on a heuristic.
 *  - `params.forceBands` draws anyway for a simple-band story (Lab-only; it
 *    mirrors the production filter so the entries are the real catalogue ones).
 *
 * params.withDraw   — 'true' / 'false' runs ONE arm; omitted runs both
 * params.drawCount  — entries to draw (default 25, production's count)
 * params.forceBands — comma-separated catalogue bands ('3', '6', '9') for a
 *                     story whose band suppresses the draw
 * params.model      — writer (default MODEL_DEFAULTS.outline, as the trial's own call)
 * params.pages      — scene count (default 5, the trial shape)
 * params.storyDetails — override the commission (an empty one is the bug that
 *                     started this; the stage refuses to run blind by accident)
 */
function labForcedChallengeDraw(inputData, count, bands) {
  // Lab-only mirror of buildChallengeIdeasSection's catalogue filter, for the
  // simple bands where production deliberately draws nothing. Same file, same
  // fields, same peril rule — only the band filter is the caller's.
  const lines = require('fs').readFileSync(
    require('path').join(__dirname, '../../prompts/challenge-catalogue.txt'), 'utf-8').split('\n');
  const ages = (inputData?.characters || []).map(c => parseInt(c.age, 10)).filter(Number.isFinite);
  const youngest = ages.length ? Math.min(...ages) : 8;
  const entries = lines
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('|'))
    .filter(f => f.length >= 6)
    .filter(f => bands.some(b => f[4].startsWith(b)))
    .filter(f => youngest > 5 || f[5].trim() !== '1');
  const picked = [];
  const pool = [...entries];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  if (!picked.length) return '';
  return [
    '# CHALLENGE IDEAS (drawn at random from a catalogue of classic trials)',
    'Build the story\'s challenges from one or two of these — the ones that fit the commission and its world, adapted freely. Ignore the rest. A challenge the commission itself sets always stands.',
    '',
    ...picked.map(f => `- ${f[2]} (tests: ${f[3]})`),
  ].join('\n');
}

async function runTrialChallengeDrawStage(target, { params = {}, promptOverride = null }) {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
  await loadPromptTemplates();
  const { buildTrialStoryPrompt, buildChallengeIdeasSection, resolveAgeBand, buildAgeModeSection } = require('./promptBuilders');
  const { callTextModelStreaming } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });
  const pageCount = parseInt(params.pages, 10) || 5;
  const model = params.model || MODEL_DEFAULTS.outline;
  if (!TEXT_MODELS[model]) throw new Error(`Unknown model "${model}"`);

  // Trial-shaped inputs from the stored story. storyDetails is the commission —
  // an empty one is exactly the showcase bug, so it is stated in the result
  // rather than silently falling through to the template's 'A fun adventure'.
  const inputData = {
    ...storyData,
    trialMode: true,
    pages: pageCount,
    storyDetails: params.storyDetails !== undefined ? String(params.storyDetails) : (storyData.storyDetails || ''),
  };
  if (params.age !== undefined) {
    inputData.characters = (storyData.characters || []).map((c, i) => (i === 0 ? { ...c, age: params.age } : c));
  }

  const band = resolveAgeBand(inputData);
  // The band's OWN plot-shape text, through the production resolver — the rules
  // the drawn challenges have to sit inside (for `tries`: one problem met three
  // times). Read next to challengeDraw, it is the fit question, unheuristic.
  const bandShapeText = buildAgeModeSection(inputData);

  const drawCount = parseInt(params.drawCount, 10) || 25;
  const forceBands = String(params.forceBands || '').split(',').map(s => s.trim()).filter(Boolean);
  let drawSection = buildChallengeIdeasSection(inputData, drawCount);
  let drawSource = drawSection ? 'production' : 'none (band draws no challenges)';
  if (!drawSection && forceBands.length) {
    drawSection = labForcedChallengeDraw(inputData, drawCount, forceBands);
    drawSource = `lab-forced (bands ${forceBands.join(',')})`;
  }
  // Same extraction the beats pipeline persists as `challengeDraw`
  // (beatsPipeline.js:780), so a Lab row and a story record are read the same way.
  const challengeDraw = drawSection.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));

  const wantWith = params.withDraw === undefined || params.withDraw === true || params.withDraw === 'true';
  const wantWithout = params.withDraw === undefined || params.withDraw === false || params.withDraw === 'false';
  if (wantWith && !challengeDraw.length) {
    throw new Error(`no challenges drawn: band "${band}" draws none (SIMPLE_BANDS) — pass params.forceBands=3 (or 6/9) to draw anyway, or run withDraw=false`);
  }

  const orig = PROMPT_TEMPLATES.storyTrial;
  if (promptOverride) PROMPT_TEMPLATES.storyTrial = promptOverride;
  let basePrompt;
  try {
    basePrompt = buildTrialStoryPrompt(inputData, pageCount);
  } finally {
    PROMPT_TEMPLATES.storyTrial = orig;
  }
  if (!basePrompt) throw new Error('story-trial template unavailable');

  const usage = [];
  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});
  const runArm = async (label, prompt) => {
    const t = Date.now();
    const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'testlab_trial_challenge_draw' });
    if (!String(res.text || '').trim() || res.usage?.output_tokens === 0) {
      throw new Error(`writer ${model} returned an empty response on the "${label}" arm — provider failure, not a result`);
    }
    usage.push({ cost: costOf(res), modelId: res.modelId, usage: res.usage });
    const body = String(res.text || '');
    const pagesSection = body.includes('---STORY PAGES---') ? body.split('---STORY PAGES---').slice(1).join('---STORY PAGES---') : body;
    return {
      arm: label,
      modelId: res.modelId,
      elapsedMs: Date.now() - t,
      cost: costOf(res),
      usage: res.usage,
      promptChars: prompt.length,
      prompt,
      title: (body.match(/TITLE:\s*(.+)/) || [, ''])[1].trim() || null,
      pages: parsePageBlocks(pagesSection).map(p => ({ pageNumber: p.pageNumber, text: p.text.split('SCENE HINT:')[0].replace(/^TEXT:\s*/i, '').trim() })),
      rawResponse: body.slice(0, 40000),
    };
  };

  const armsOut = [];
  // Sequential: two writer calls of a whole story, and a failure on the second
  // must still leave the first readable.
  if (wantWithout) armsOut.push(await runArm('without-draw', basePrompt));
  if (wantWith) armsOut.push(await runArm('with-draw', `${basePrompt}\n\n${drawSection}`));

  return {
    storyId: target.storyId,
    model,
    modelId: usage[0]?.modelId || null,
    pages: pageCount,
    commission: inputData.storyDetails || null,
    commissionEmpty: !String(inputData.storyDetails || '').trim(),
    // The band question, stated rather than inferred.
    ageBand: band,
    bandDrawsChallenges: drawSource === 'production',
    drawSource,
    bandShapeText: bandShapeText.slice(0, 4000),
    challengeDraw,
    challengeDrawCount: challengeDraw.length,
    drawSection,
    modelCalls: usage.length,
    cost: usage.reduce((a, u) => a + (u.cost || 0), 0),
    usage: usage.reduce((a, u) => ({
      input_tokens: (a.input_tokens || 0) + (u.usage?.input_tokens || 0),
      output_tokens: (a.output_tokens || 0) + (u.usage?.output_tokens || 0),
    }), {}),
    arms: armsOut,
  };
}

/**
 * BEATS RE-PLAN PLUMBING — does the planner emit the blocks the parsers read?
 *
 * Commits 981fcb27a + 7ed94f65c made the re-plan DECLARE its structural changes
 * under `---CHANGES---` and the plan check answer its obstacle question as
 * `OBSTACLES <page>: <name>` data. The merge then enforces the rule that gives
 * the design its teeth: **a change you do not declare is undone**.
 *
 * Every result behind that design so far is a REPLAY over stored rows, and no
 * stored row carries either block — neither existed before 2026-09-18. So the
 * load-bearing question was untested: if the planner does not emit a parseable
 * change block (wrong marker, markdown fence, renamed, omitted), then every
 * change it made reads as undeclared, every one is restored, and the round is a
 * silent NO-OP. On a paid run that is invisible — no error, no warning, a book
 * that ships round one's division while the log says the plan was re-divided.
 *
 * This stage answers that and only that. It is a PLUMBING check, not an
 * accuracy measurement: it asks whether the two blocks arrive in the shape
 * `parsePlanChanges` and `parsePlanCheckObstacles` expect, not whether the
 * re-plan's judgement was good.
 *
 * WHAT IT RUNS. Round one's division is the story's OWN first division, frozen
 * (`beatsReviewReport.briefsIn`, written before any re-plan touched it), so no
 * paid planner call is spent re-deriving a division that is already stored.
 * Two paid text calls follow, in production's order and with production's
 * arguments: the plan check, then the re-plan. The merge, the review and the
 * restore are then replayed by `analyzeReplanCompliance` below.
 *
 * WHAT IT CANNOT SEE. A replay has no arc-machine commit, so `declaredInvented`
 * and `inventedAllowance` are null and the premise figures are absent from
 * `commissionedNames` — the INVENTED_* counters may therefore differ from the
 * ones this story drew when it ran. The cast-per-page counters, which are what
 * a re-plan's removals are judged against, are unaffected.
 */

/** The `---CHANGES---` segment exactly as the model wrote it, marker included. */
function rawChangesBlock(text) {
  const m = String(text || '').match(/---\s*CHANGES\s*---([\s\S]*?)(?=\n---\s*[A-Z][A-Z ]*---|$)/i);
  return m ? m[0] : '';
}

/** Every line that LOOKS like an obstacle declaration, before any parsing. */
function rawObstacleLines(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim().replace(/\*\*/g, '').trim())
    .filter(l => /^OBSTACLES?\s+\d+\s*:/i.test(l));
}

/**
 * The verdict on one re-plan response: are the two blocks there, do the
 * production parsers read them without loss, and — the headline — would the
 * round have been a no-op?
 *
 * The parsers, the reviewer and the restore are the PRODUCTION functions
 * (`parsePlanChanges`, `parsePlanCheckObstacles`, `reviewPlanChanges`,
 * `castLostByReplan`). The merge around them is replayed from
 * beatsPipeline.js's re-plan round (the loop is inline there, so it cannot be
 * called) and must be kept in step with it — the guards below are that loop's
 * duplicate-line and page-count guards in the same order.
 *
 * Pure: no model, no database, no clock. Canned text in, verdict out.
 */
function analyzeReplanCompliance({
  replanText = '', checkText = '', standing = [], findings = [],
  castNames = [], aliases = {}, maxCast = 3,
  focalNames = [], keep = [],
} = {}) {
  const { parsePlanResponse, parsePlanChanges, parsePlanCheckObstacles, parsePlanCheckActions, findingPages, replanRank } = require('./promptBuilders');
  const { reviewPlanChanges, castLostByReplan } = require('./planCounters');

  const standingBy = new Map(standing.map(b => [Number(b.pageNumber), b]));
  const parsed = parsePlanResponse(String(replanText || ''), [...standingBy.keys()]);
  const declared = parsePlanChanges(String(replanText || ''));
  const obstacles = parsePlanCheckObstacles(String(checkText || ''));

  // ── the merge, as beatsPipeline runs it ───────────────────────────────────
  const namedPages = new Set();
  for (const f of findings || []) for (const n of findingPages(f)) namedPages.add(Number(n));
  const declaredPages = new Set();
  for (const c of declared.changes) {
    if (Number.isFinite(c.pageNumber)) declaredPages.add(Number(c.pageNumber));
    if (Number.isFinite(c.toPage)) declaredPages.add(Number(c.toPage));
    if (Number.isFinite(c.fromPage)) declaredPages.add(Number(c.fromPage));
  }
  const scopeAll = namedPages.size === 0;
  const inScope = n => namedPages.has(Number(n)) || declaredPages.has(Number(n));
  let merged = [];
  for (const pg of parsed.pages) {
    const n = Number(pg.pageNumber);
    merged.push(scopeAll || inScope(n) || !standingBy.has(n) ? pg : standingBy.get(n));
  }
  for (const [num, pg] of standingBy) if (!merged.some(k => Number(k.pageNumber) === num)) merged.push(pg);
  merged.sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber));
  const overridden = scopeAll ? [] : parsed.pages
    .map(pg => Number(pg.pageNumber))
    .filter(n => !inScope(n) && standingBy.has(n));

  // ── review, then apply ────────────────────────────────────────────────────
  const restore = (nums) => {
    const want = new Set(nums.map(Number));
    merged = merged.map(pg => (want.has(Number(pg.pageNumber)) && standingBy.has(Number(pg.pageNumber))
      ? standingBy.get(Number(pg.pageNumber))
      : pg));
  };
  // Production's review arguments (beatsPipeline): the pages the round was
  // told to keep, the ACTION lines of the check that raised the findings, the
  // characters that owe a focal page, and the must-fix ranking.
  const review = reviewPlanChanges({
    changes: declared.changes, standing, returned: merged, castNames, aliases, maxCast, obstacles,
    focalNames,
    protectedPages: new Map((keep || []).map(k => [Number(k.page), k.why])),
    actions: parsePlanCheckActions(String(checkText || '')),
    rankOf: replanRank,
  });
  restore(review.refusals.map(r => r.pageNumber));
  const lost = castLostByReplan(standing, merged, castNames, aliases, review.declaredOut);
  restore(lost.map(l => l.pageNumber));

  // ── the round-level guards, in beatsPipeline's order ──────────────────────
  const instants = merged.map(pg => String(pg.planLine || '').toLowerCase().replace(/\s+/g, ' ').trim());
  const duplicate = instants.find((t, k) => t && instants.indexOf(t) !== k) || null;
  const discardReason = duplicate
    ? `two pages returned with an identical plan line: "${duplicate.slice(0, 120)}"`
    : (merged.length !== standing.length
      ? `returned ${merged.length} page(s) for a ${standing.length}-page book`
      : null);

  // ── what actually changed ─────────────────────────────────────────────────
  const lineOf = (pg) => String((pg && pg.planLine) || '').trim();
  const changedRaw = parsed.pages
    .filter(pg => standingBy.has(Number(pg.pageNumber)) && lineOf(standingBy.get(Number(pg.pageNumber))) !== lineOf(pg))
    .map(pg => Number(pg.pageNumber));
  const changedApplied = discardReason ? [] : merged
    .filter(pg => standingBy.has(Number(pg.pageNumber)) && lineOf(standingBy.get(Number(pg.pageNumber))) !== lineOf(pg))
    .map(pg => Number(pg.pageNumber));
  const restoredPages = changedRaw.filter(n => !changedApplied.includes(n));

  // ── the plumbing checks ───────────────────────────────────────────────────
  const norm = s => String(s || '').trim().replace(/\*\*/g, '').trim();
  const isCountLine = l => /^changes?\s*:\s*\d+\s*$/i.test(l);
  const blockRaw = rawChangesBlock(replanText);
  const blockLines = blockRaw ? blockRaw.split('\n').slice(1).map(norm).filter(Boolean) : [];
  const consumed = new Set(declared.changes.map(c => norm(c.line)));
  const unparsedLines = blockLines.filter(l => !consumed.has(l) && !isCountLine(l));
  const countMatches = declared.declaredCount != null && declared.declaredCount === declared.counted;
  const unreadableVerbs = declared.changes.filter(c => c.kind === 'other');
  const untagged = declared.changes.filter(c => !c.answers);
  const reasonless = declared.changes.filter(c => !String(c.reason || '').trim());
  const outsidePlan = parsed.pages.map(pg => Number(pg.pageNumber)).filter(n => !standingBy.has(n));
  const obstacleLines = rawObstacleLines(checkText);
  // A line whose names column is empty or "none" declares no obstacle, so the
  // parser skipping it is correct — not a line it failed to read.
  const namedObstacleLines = obstacleLines.filter(l => !/:\s*(none)?\s*$/i.test(l));

  const check = (id, pass, detail, extra = {}) => ({ id, pass: !!pass, detail, ...extra });
  const checks = [
    check(1, declared.present,
      declared.present
        ? `a ---CHANGES--- block is present and carries ${declared.counted} change line(s)`
        : 'NO ---CHANGES--- block in the response — every structural change reads as undeclared'),
    check(2, declared.present && unparsedLines.length === 0 && countMatches,
      `${unparsedLines.length} block line(s) the parser did not read; declared count ${declared.declaredCount == null ? '(absent)' : declared.declaredCount} vs ${declared.counted} enumerated`,
      { unparsedLines, declaredCount: declared.declaredCount, counted: declared.counted, countMatches }),
    check(3, declared.present && unreadableVerbs.length === 0,
      `${unreadableVerbs.length} change line(s) outside the declared vocabulary`,
      { unreadable: unreadableVerbs.map(c => c.line), kinds: declared.changes.map(c => c.kind) }),
    check(4, declared.present && untagged.length === 0 && reasonless.length === 0,
      `${untagged.length} change line(s) carry no PLAN[CODE]/CHECK[n] tag, ${reasonless.length} carry no reason`,
      { untagged: untagged.map(c => c.line), reasonless: reasonless.map(c => c.line) }),
    check(5, lost.length === 0,
      `${lost.length} page(s) lost cast the round never declared`,
      { undeclaredRemovals: lost }),
    check(6, outsidePlan.length === 0,
      outsidePlan.length ? `returned page number(s) not in the plan: ${outsidePlan.join(', ')}` : 'every returned page number is already in the plan',
      { outsidePlan }),
    check(7, obstacleLines.length > 0,
      `${obstacleLines.length} OBSTACLES line(s) in the plan-check response`),
    // Read, not merely present: a line naming somebody must arrive in the map.
    // A response with no lines at all fails here as well as at check 7 — there
    // is nothing for the parser to hand the review.
    check(8, obstacleLines.length > 0 && obstacles.size === namedObstacleLines.length,
      `parsePlanCheckObstacles read ${obstacles.size} page(s) from ${namedObstacleLines.length} line(s) naming somebody (${obstacleLines.length} raw)`,
      { parsedPages: [...obstacles.keys()].sort((a, b) => a - b) }),
    // ONE LINE, ONE CHANGE. The parser reads a packed line correctly rather
    // than mis-reading it, so this check costs the round nothing — it is the
    // measurement of how often the planner keeps the contract, which is what
    // decides whether an escalation is ever worth a paid re-ask.
    check(9, declared.present && declared.violations.length === 0,
      `${declared.violations.length} format violation(s) across ${declared.lines} change line(s): ${
        declared.violations.length
          ? [...new Set(declared.violations.map(v => v.rule))].join(', ')
          : 'one change per line, every cast subject a bare name'}`,
      { formatViolations: declared.violations, changeLines: declared.lines }),
  ];

  return {
    checks,
    passed: checks.filter(c => c.pass).length,
    failed: checks.filter(c => !c.pass).map(c => c.id),
    // The raw blocks, line by line, so a reader sees what the model wrote
    // rather than a verdict about it.
    changesBlockLines: blockRaw ? blockRaw.split('\n') : [],
    obstaclesLines: obstacleLines,
    declaredChanges: declared.changes.map(c => ({
      page: c.pageNumber, kind: c.kind, subject: c.subject, answers: c.answersText, reason: c.reason,
    })),
    // How many CHANGES the block declared, over how many lines, and every way
    // the format was broken — the violation rate an escalation decision needs.
    declaredCount: declared.declaredCount,
    changesParsed: declared.counted,
    changeLines: declared.lines,
    formatViolations: declared.violations,
    refusals: review.refusals,
    reviewNotes: review.notes,
    undeclaredRemovals: lost,
    undeclaredRemovalCount: lost.length,
    // THE HEADLINE. A round whose applied division equals the standing one
    // changed nothing the book will ever see.
    noOp: changedApplied.length === 0,
    discardReason,
    changedPagesReturned: changedRaw,
    changedPagesApplied: changedApplied,
    restoredPages,
    restoredOnlyDifference: changedApplied.length > 0 && restoredPages.length > 0,
    pagesTheMergeOverrode: overridden,
    returnedPages: parsed.pages.map(pg => Number(pg.pageNumber)),
    appliedPlan: merged.map(pg => ({ pageNumber: Number(pg.pageNumber), planLine: lineOf(pg) })),
  };
}

/**
 * ONE plan check + ONE re-plan against a stored story's first division, then
 * the compliance verdict. Text only — no image spend, no story run.
 *
 * params.planModel  — the re-planner (default: production's outline model)
 * params.checkModel — the plan checker (default: production's planCheckModel)
 */
async function runBeatsReplanStage(target, { params = {} }) {
  const { loadPromptTemplates } = require('../services/prompts');
  await loadPromptTemplates();
  const {
    buildBeatsPrompt, buildPlanCheckPrompt, parsePlanCheck, parsePlanCheckRoster,
    parsePlanCheckObstacles, buildReplanSection, getHistoricalLocations, getHistoricalObjects,
    parsePlanCheckWanted, parsePlanCheckActions, replanKeepPages, replanRoundRegressed,
  } = require('./promptBuilders');
  const { parseBeats } = require('./storyHelpers');
  const { runPlanCounters, collectPlaceNames } = require('./planCounters');
  const { callTextModelStreaming } = require('./textModels');
  const { MODEL_DEFAULTS, IMAGE_MODELS, TEXT_MODELS, calculateTextCost } = require('../config/models');

  const { storyData } = await loadStoryDataFull(target.storyId, { rehydrate: false });

  // ROUND ONE'S DIVISION, FROZEN. `briefsIn` is written from `plan.pages` — the
  // FIRST division, before any re-plan round touched it — so the findings this
  // stage raises are findings against the same division the story's own check
  // saw. `pagePlan` on the report is the SHIPPED division and is deliberately
  // not used: re-checking the post-re-plan division would measure a different
  // round from the one the stored findings describe.
  const briefsIn = storyData?.beatsReviewReport?.briefsIn || [];
  const standing = briefsIn
    .filter(b => b && b.pageNumber != null)
    .map(b => ({ pageNumber: Number(b.pageNumber), planLine: String(b.brief || '').replace(/^\s*PLAN:\s*/i, '').trim() }))
    .filter(b => b.planLine)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  if (standing.length === 0) {
    throw new Error(`story ${target.storyId} carries no beatsReviewReport.briefsIn plan lines — nothing to re-divide`);
  }
  const pagePlan = standing.map(pg => `Page ${pg.pageNumber}: ${pg.planLine}`).join('\n');
  const pageCount = standing.length;

  const approvedArc = resolveReplayArc(storyData, { parseBeats });
  const arcHints = resolveReplayArcHints(storyData);
  const centralFigure = resolveReplayCentralFigure(storyData);

  const checkModel = params.checkModel || MODEL_DEFAULTS.planCheckModel;
  const planModel = params.planModel || MODEL_DEFAULTS.outline;
  for (const m of [checkModel, planModel]) if (!TEXT_MODELS[m]) throw new Error(`Unknown model "${m}"`);

  // Production's counter inputs, as far as a stored story carries them (see the
  // header: the arc machine's premise figures and invented allowance do not
  // survive into the row).
  const commission = require('./castCoverage').commissionedCast(storyData);
  const commissionedNames = commission.all;
  const placeNames = collectPlaceNames(storyData, [
    ...(storyData?.storyCategory === 'historical'
      ? [...getHistoricalLocations(storyData.storyTopic), ...getHistoricalObjects(storyData.storyTopic)].map(e => e && e.name)
      : []),
  ]);
  const maxCast = IMAGE_MODELS[storyData?.modelOverrides?.imageModel || MODEL_DEFAULTS.pageImage]?.maxCharactersPerScene || 3;

  const costOf = r => r.usage?.direct_cost ?? calculateTextCost(r.modelId || '', r.usage || {});

  // ── the plan check ────────────────────────────────────────────────────────
  // One helper for the check and the recheck, shaped as beatsPipeline's
  // runCheck: the model call, its roster, the counters on that roster, and the
  // findings structured the way the re-plan and the round guard read them.
  const runCheckOn = async (pages, planText, usageLabel) => {
    const prompt = buildPlanCheckPrompt(storyData, pages, approvedArc, planText, { arcHints, centralFigure });
    if (!prompt) throw new Error('plan-check template unavailable');
    const res = await callTextModelStreaming(prompt, null, null, checkModel, {
      usageLabel,
      ...(TEXT_MODELS[checkModel]?.provider === 'anthropic' ? {} : { temperature: 0 }),
    });
    if (!String(res.text || '').trim()) throw new Error(`plan checker ${checkModel} returned an empty response — provider failure, not a result`);
    const modelFindings = parsePlanCheck(res.text || '');
    const roster = parsePlanCheckRoster(res.text || '');
    const counters = runPlanCounters({
      pages, commissionedNames, listedNames: commission.listed, placeNames, maxCharactersPerScene: maxCast, roster, centralFigure,
    });
    return {
      prompt, res, roster, counters,
      findings: [
        ...counters.findings.map((f, i) => ({ kind: 'counter', code: f.code, line: counters.lines[i] })),
        ...modelFindings.map(f => ({ kind: 'check', check: f.check, line: `CHECK[${f.check}]: ${f.text}` })),
      ],
    };
  };
  let t = Date.now();
  const firstCheck = await runCheckOn(standing, pagePlan, 'testlab_beats_replan_check');
  const checkMs = Date.now() - t;
  const { prompt: checkPrompt, res: checkRes, roster, counters, findings } = firstCheck;
  const obstacles = parsePlanCheckObstacles(checkRes.text || '');
  if (findings.length === 0) {
    throw new Error('the plan check raised no finding against this division — there is nothing for a re-plan to answer, so pick a story whose check fires');
  }

  // ── the re-plan ───────────────────────────────────────────────────────────
  const keep = replanKeepPages({
    pageCount,
    wanted: parsePlanCheckWanted(checkRes.text || ''),
    actions: parsePlanCheckActions(checkRes.text || ''),
    focalPages: (counters.stats && counters.stats.focalPages) || {},
  });
  const coverageRule = require('./castCoverage').castCoverage({ pageCount, castCount: commission.listed.length });
  const replanSection = buildReplanSection(pagePlan, findings, { pageCount, keep });
  const replanPrompt = buildBeatsPrompt(storyData, pageCount, { finalArc: approvedArc, arcHints, centralFigure, replan: replanSection });
  if (!replanPrompt) throw new Error('story-beats template unavailable');
  t = Date.now();
  const rpRes = await callTextModelStreaming(replanPrompt, null, null, planModel, { usageLabel: 'testlab_beats_replan' });
  if (!String(rpRes.text || '').trim()) throw new Error(`planner ${planModel} returned an empty response — provider failure, not a result`);
  const replanMs = Date.now() - t;

  const verdict = analyzeReplanCompliance({
    replanText: rpRes.text || '',
    checkText: checkRes.text || '',
    standing,
    findings,
    castNames: (counters.cast && counters.cast.all) || commissionedNames,
    aliases: (counters.cast && counters.cast.aliases) || {},
    maxCast,
    focalNames: coverageRule && coverageRule.focalEach ? commission.listed : [],
    keep,
  });

  // ── the recheck and the round guard, as beatsPipeline runs them ───────────
  // Production rechecks every round the corruption guards let through and
  // discards one that raises the cast/focal must-fix count
  // (`replanRoundRegressed`, round 1 semantics — this stage is one round). A
  // round the guards already discarded, or one that changed nothing, is never
  // rechecked there, so it is not rechecked here.
  let recheck = null;
  let guard = null;
  let recheckMs = 0;
  if (!verdict.discardReason && verdict.changedPagesApplied.length > 0) {
    const appliedText = verdict.appliedPlan.map(pg => `Page ${pg.pageNumber}: ${pg.planLine}`).join('\n');
    t = Date.now();
    recheck = await runCheckOn(verdict.appliedPlan, appliedText, 'testlab_beats_replan_recheck');
    recheckMs = Date.now() - t;
    const g = replanRoundRegressed({ findings }, { findings: recheck.findings }, verdict.changedPagesApplied, { round: 1 });
    guard = {
      before: g.before, after: g.after, noise: g.noise.map(f => f.line),
      kept: !g.discard,
      discardReason: g.discard ? `raised the cast/focal must-fix count (${g.before} → ${g.after})` : null,
    };
  }

  const { appliedPlan, ...reportFields } = verdict;
  const calls = [checkRes, rpRes, ...(recheck ? [recheck.res] : [])];

  return {
    storyId: target.storyId,
    pages: pageCount,
    models: { checkModel, checkModelId: checkRes.modelId || checkModel, planModel, planModelId: rpRes.modelId || planModel },
    elapsedMs: checkMs + replanMs + recheckMs,
    cost: calls.reduce((a, r) => a + costOf(r), 0),
    usage: {
      input_tokens: calls.reduce((a, r) => a + (r.usage?.input_tokens || 0), 0),
      output_tokens: calls.reduce((a, r) => a + (r.usage?.output_tokens || 0), 0),
    },
    note: `${verdict.passed}/${verdict.checks.length} plumbing checks pass — ${verdict.changesParsed} change(s) on ${verdict.changeLines} line(s), ${verdict.formatViolations.length} format violation(s), ${verdict.refusals.length} refusal(s) — ${verdict.noOp ? 'the round WOULD have been a no-op' : `${verdict.changedPagesApplied.length} page(s) survive to the book`}${verdict.discardReason ? ` (round discarded: ${verdict.discardReason})` : ''}${guard ? ` — guard: cast/focal must-fix ${guard.before} → ${guard.after}, round ${guard.kept ? 'KEPT' : 'DISCARDED'}` : ''}`,
    // `report` is what the Lab renders for this stage (client TestLab.tsx).
    // The applied division travels beside it rather than inside: the rendered
    // block stays the verdict, not a second copy of the page plan.
    report: { ...reportFields, guard, recheckFindings: recheck ? recheck.findings.map(f => f.line) : null },
    appliedPlan,
    standingPlan: standing,
    findings: findings.map(f => f.line),
    counterStats: counters.stats,
    cast: counters.cast,
    rosterPages: roster ? roster.size : 0,
    obstaclePages: [...obstacles.keys()].sort((a, b) => a - b),
    replanSection,
    checkPrompt,
    replanPrompt,
    checkRawResponse: (checkRes.text || '').slice(0, 40000),
    recheckRawResponse: recheck ? (recheck.res.text || '').slice(0, 40000) : null,
    replanRawResponse: (rpRes.text || '').slice(0, 40000),
  };
}

const STORY_STAGES = {
  trial_idea_variety: runTrialIdeaVarietyStage,
  trial_challenge_draw: runTrialChallengeDrawStage,
  vb_element_cell: runVbElementCellStage,
  arc_rounds: runArcRoundsStage,
  arc_amend: runArcAmendStage,
  arc_effort: runArcEffortStage,
  cover: runCoverStage,
  cover_title_paintin: runCoverTitlePaintinStage,
  style_check: runStyleCheckStage,
  book_audit: runBookAuditStage,
  audit_replay: runAuditReplayStage,
  scene_hazard_count: runSceneHazardCountStage,
  style_repair: runStyleRepairStage,
  // outline_review retired 2026-09-13 — see the note above runTextRefineStage.
  text_refine: runTextRefineStage,
  beats_scenes: runBeatsScenesStage,
  beats_replan: runBeatsReplanStage,
  scene_review_replay: runSceneReviewReplayStage,
  story_bible_replay: runStoryBibleReplayStage,
  story_text_replay: runStoryTextReplayStage,
  writer_compare: runWriterCompareStage,
  clothing_review: runClothingReviewStage,
  story_scorecard: runStoryScorecardStage,
  score_rejudge: runScoreRejudgeStage,
  arc_panel_replay: runArcPanelReplayStage,
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
      // A pinned version, resolved ONCE. Two stages read ctx.versionIndex, and
      // nothing ever set it — so both silently judged whatever version was
      // active. That is how the p9 face bake-off (#1209-#1216) compared the
      // repaired render against itself while reporting one arm as the original.
      ctx.versionIndex = pinnedVersionIndex(target.versionIndex);
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
      null, null, { usageLabel: 'testlab_genericity' }
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
  pinnedVersionIndex,
  applyReviewerPages,
  // beats_scenes truncation recovery — exported so the decisions can be pinned
  // without a story, a DB or a paid model (tests/unit/testlab-beats-scenes-recovery.test.ts)
  collectAllPagesBriefs,
  summarizeSceneExpansions,
  // The two copies of the commission the judge reads — exported so their
  // agreement under a brief override can be pinned without a paid render
  // (tests/unit/testlab-brief-override-reaches-judge.test.ts).
  evalSceneDescription,
  evalSceneHint,
  // exported for tests/unit/idea-premise-grouping.test.js
  groupIdeasByPremise,
  ideaPremiseSkeleton,
  ideaSubjectWords,
  STAGES: [...Object.keys(STAGE_RUNNERS), ...Object.keys(AVATAR_STAGES), ...Object.keys(STORY_STAGES)],
  STORY_STAGES: Object.keys(STORY_STAGES),
  AVATAR_STAGE_NAMES: Object.keys(AVATAR_STAGES),
  runStageOnTarget,
  loadSceneContext,
  loadCharacterContext,
  loadTestImage,
  resolveReplayParams,
  loadActivePageImage,
  // The identity-vote replay, exported so its arithmetic can be pinned without
  // a database, a story or a paid VLM call: what the witness said, whether the
  // vote withheld a rename, and how that classifies against a pixel-judged
  // verdict (tests/unit/testlab-identity-second-opinion.test.ts).
  runIdentitySecondOpinionStage,
  // The re-plan compliance verdict, exported so the plumbing checks and
  // the no-op comparison can be pinned on canned responses — no model, no
  // database (tests/unit/testlab-beats-replan.test.ts).
  analyzeReplanCompliance,
  checkRuleGenericity,
  // The scorecard judge itself. Every stage runner in this file already calls
  // it; exporting it lets a measurement score an arbitrary artifact (the text
  // after each refine round, a candidate rewrite) through the SAME evaluator
  // resolution and rubric as a stored scorecard, instead of a second copy of
  // the judge wiring drifting alongside it.
  scoreArtifactsWithJudge,
  // The stored challenge draw a create prompt carried, both stored shapes
  // (tests/unit/testlab-stored-challenge-section.test.ts).
  storedChallengeSection,
};
