'use strict';

/**
 * BOOK-REVIEW RERUN — the Test Lab stage `book_review_rerun`.
 *
 * Takes one STORED finished story and runs what a fresh production story does
 * after its pictures are drawn: runUnifiedRepairPipeline in pageJudgeMode
 * 'book_review' (the Opus whole-book review and its repair rounds,
 * bookReview.runBookReviewRounds), starting from the ORIGINAL pictures (version
 * 0 of every page, the textless art of version 0 of every cover) — not from the
 * repaired picks the old judges shipped. The owner compares cost and quality
 * with what those judges produced on the same story.
 *
 * It drives the REAL pipeline. The two inputs the story run assembles inline are
 * built by the same code: the pipeline's storyData (repairStoryData.
 * buildRepairStoryData) and each cover's pseudo-page (buildCoverRepairEntry).
 * The page pseudo-pages are the inverse of the story run's save whitelist (the
 * stored record -> the in-flight object), see buildPageRepairEntry.
 *
 * Safety:
 *  - STAGING ONLY. assertStaging refuses any other environment, loudly, before
 *    anything is read, so a customer's row can never be touched.
 *  - Repair versions are written as Lab test versions (is_test rows with the next
 *    free version_index), never over versions 0..N of the copy; the copy's active
 *    versions are not changed.
 *  - No email. Nothing in this call path sends one (email.js is reachable from the
 *    story job and the routes only); tests/unit/book-review-rerun.test.ts spies on
 *    every send and asserts none is called.
 *
 * Dependencies are injected (`deps`) so the logic is unit-testable without a
 * database or a paid call; server/lib/testlab.js wires the real ones.
 */

const { COVER_PAGE_NUMBERS, COVER_KEYS } = require('./coverKeys');
const { buildRepairStoryData, buildCoverRepairEntry } = require('./repairStoryData');

const STAGING = 'staging';
const COVER_KEY_BY_PAGE = Object.freeze(Object.fromEntries(Object.entries(COVER_PAGE_NUMBERS).map(([k, n]) => [n, k])));

/** Throw unless this process is the staging environment. */
function assertStaging(env) {
  const name = env === undefined ? require('../config/runtime').environmentName() : env;
  if (name !== STAGING) {
    throw new Error(`book_review_rerun refuses to run in environment "${name}": it repairs a copy of a story and only the staging environment may do that (a customer's real row must never be touched)`);
  }
}

const present = (...vals) => vals.find(v => v !== undefined && v !== null);

/**
 * The pseudo-page the story run hands the pipeline for one page, rebuilt from the
 * stored record and its ORIGINAL version (imageVersions[0]). Every field the run
 * whitelists into the stored record maps back to the in-flight name it came from
 * (referencePhotos -> characterPhotos, sceneCharacterClothing -> perCharClothing,
 * bboxDetection -> sharedBboxDetection). Version 0's own fields win over the
 * record root, which describes the version that shipped.
 */
function buildPageRepairEntry(rec, imageData) {
  const v0 = (Array.isArray(rec.imageVersions) && rec.imageVersions[0]) || {};
  return {
    pageNumber: rec.pageNumber,
    text: rec.text || '',
    imageData,
    modelId: present(v0.modelId, rec.modelId) || null,
    thinkingText: rec.thinkingText || null,
    prompt: present(v0.prompt, rec.prompt),
    compressedScene: present(v0.compressedScene, rec.compressedScene) || null,
    sceneDescription: present(v0.description, rec.description, rec.sceneDescription) || '',
    sceneMetadata: present(v0.sceneMetadata, rec.sceneMetadata) || null,
    sceneCharacters: present(v0.sceneCharacters, rec.sceneCharacters) || null,
    perCharClothing: rec.sceneCharacterClothing || null,
    characterPhotos: present(v0.referencePhotos, rec.referencePhotos) || [],
    referencePhotos: present(v0.referencePhotos, rec.referencePhotos) || [],
    landmarkPhotos: present(v0.landmarkPhotos, rec.landmarkPhotos) || [],
    visualBibleGrid: present(v0.visualBibleGrid, rec.visualBibleGrid) || null,
    grokRefImages: present(v0.grokRefImages, rec.grokRefImages) || null,
    emptySceneImage: rec.emptySceneImage || null,
    emptyScenePrompt: rec.emptyScenePrompt || null,
    emptySceneQc: rec.emptySceneQc || null,
    emptySceneVbGrid: rec.emptySceneVbGrid || null,
    textAreaMask: rec.textAreaMask || null,
    textCoverageReport: rec.textCoverageReport || null,
    calmRegion: rec.calmRegion || null,
    vantageId: rec.vantageId || null,
    plateDerivedFor: rec.plateDerivedFor || null,
    compositeDebug: rec.compositeDebug || null,
    compositeOutcome: rec.compositeOutcome || null,
    // The detection of the ORIGINAL pixels; null makes the pipeline re-detect (as when the run's detection failed).
    sharedBboxDetection: v0.bboxDetection || null,
    scene: {
      jevFixed: rec.jevFixed || null,
      outlineCharacters: rec.outlineCharacters || null,
      outlineExtract: rec.outlineExtract || '',
      sceneDescriptionModelId: rec.sceneDescriptionModelId,
    },
  };
}

/**
 * Everything runUnifiedRepairPipeline needs, from a stored story and its version-0
 * pictures. `loadOriginal(pageNumber)` resolves to {imageData, layer?} for a page
 * (negative numbers are the covers) and must be strict: version 0 or an error.
 *
 * @returns {Promise<{rawImages: object[], storyData: object, inputData: object, coverLayers: Object<string,string>, warnings: string[]}>}
 */
async function buildRerunInputs(stored, loadOriginal) {
  if (!Array.isArray(stored.sceneImages) || stored.sceneImages.length === 0) throw new Error('book_review_rerun: the story has no stored pages');
  const warnings = [];
  const inputData = {
    characters: stored.characters || [],
    // The declared main character(s): the review names "the main character" from them (finding 3, 2026-11-13).
    mainCharacters: stored.mainCharacters,
    layout: stored.layout,
    artStyle: stored.artStyle,
    language: stored.language,
    season: stored.season,
    createdAt: stored.createdAt,
    trialMode: false,
    dedication: stored.dedication || '',
    title: stored.title,
    storyTitle: stored.title,
  };
  const pages = [...stored.sceneImages].filter(r => typeof r.pageNumber === 'number' && r.pageNumber > 0).sort((a, b) => a.pageNumber - b.pageNumber);
  const rawImages = [];
  for (const rec of pages) {
    const { imageData } = await loadOriginal(rec.pageNumber);
    if (!imageData) throw new Error(`book_review_rerun: page ${rec.pageNumber} has no original (version 0) picture`);
    rawImages.push(buildPageRepairEntry(rec, imageData));
  }
  const coverLayers = {};
  for (const coverKey of COVER_KEYS) {
    const coverData = stored.coverImages?.[coverKey];
    if (!coverData || typeof coverData !== 'object') continue;
    const { imageData, layer } = await loadOriginal(COVER_PAGE_NUMBERS[coverKey]);
    if (!imageData) throw new Error(`book_review_rerun: ${coverKey} has no original (version 0) picture`);
    coverLayers[coverKey] = layer || null;
    rawImages.push(buildCoverRepairEntry(coverKey, { ...coverData, imageData }, { title: stored.title, inputData, coverHints: stored.coverHints }));
  }
  const recByPage = new Map(pages.map(r => [r.pageNumber, r]));
  const textInImage = stored.layout?.textInImage !== false;
  const storyData = buildRepairStoryData({
    inputData,
    characterAvatars: stored.characterAvatars,
    sceneDescriptions: stored.sceneDescriptions || [],
    fullStoryText: stored.story || stored.storyText || '',
    writerText: stored.writerText,
    visualBible: stored.visualBible,
    clothingRequirements: stored.clothingRequirements,
    pageClothing: stored.pageClothing,
    coverHints: stored.coverHints,
    rawImages,
    textPositionOf: (r) => (textInImage ? (recByPage.get(r.pageNumber)?.textPosition || null) : null),
    coverImages: stored.coverImages || {},
    title: stored.title,
  });
  return { rawImages, storyData, inputData, coverLayers, warnings };
}

const toPlainBucket = (b) => ({ ...b, ...(b.models instanceof Set ? { models: [...b.models] } : {}) });

/** tokenUsage.byFunction as stored on a story: only the buckets that saw a call, Sets as arrays. */
function costByFunction(tokenUsage) {
  const out = {};
  for (const [fn, b] of Object.entries(tokenUsage.byFunction || {})) {
    if (b && b.calls > 0) out[fn] = toPlainBucket(b);
  }
  return out;
}

const faultRow = (f) => ({ page: f.page, severity: f.severity, type: f.type, route: f.route, line: f.line });

/** One entry per review round: the faults with their route tags and, after a repair, the BETTER verdicts. */
function summariseRounds(bookAuditRounds) {
  return (bookAuditRounds || []).map(r => ({
    round: r.round,
    modelId: r.modelId,
    finalRound: !!r.finalRound,
    pagesRead: r.pagesRead,
    imgFaults: (r.imgFaults || []).map(faultRow),
    textFaults: (r.textFaults || []).map(f => f.line),
    repairedPages: r.repairedPages || [],
    betterVerdicts: r.betterVerdicts || {},
  }));
}

const labelOf = (pageNumber) => COVER_KEY_BY_PAGE[pageNumber] || `page ${pageNumber}`;

/**
 * The comparison view of what the pipeline returned. `savedIndex` maps
 * pageNumber -> { pipelineVersionIndex -> Lab version_index }, for the repair
 * versions that were stored. The pipeline's version 0 is the original, already
 * stored as version 0 of the copy.
 */
function summarisePages(results, repairRounds, savedIndex) {
  const attempts = new Map();
  for (const rr of repairRounds || []) {
    for (const p of rr.pages || []) {
      if (!attempts.has(p.page)) attempts.set(p.page, []);
      attempts.get(p.page).push({ round: rr.round, method: p.method, outcome: p.outcome, error: p.error || null, before: p.before ?? null, after: p.after ?? null });
    }
  }
  return (results || []).map(r => {
    const versions = r.imageVersions || [];
    const finalIdx = versions.findIndex(v => v.imageData && v.imageData === r.imageData);
    const saved = savedIndex.get(r.pageNumber) || {};
    return {
      pageNumber: r.pageNumber,
      label: labelOf(r.pageNumber),
      repairs: attempts.get(r.pageNumber) || [],
      versions: versions.map((v, k) => ({ pipelineIndex: k, source: v.source, method: v.method || null, finalScore: v.finalScore ?? null, labVersionIndex: k === 0 ? 0 : (saved[k] ?? null) })),
      bestSource: r.bestSource || 'original',
      finalPipelineIndex: finalIdx >= 0 ? finalIdx : null,
      finalLabVersionIndex: finalIdx === 0 ? 0 : (finalIdx > 0 ? (saved[finalIdx] ?? null) : null),
      keptOriginal: finalIdx === 0,
    };
  });
}

/**
 * Run the stage. deps:
 *   environment            string | undefined (undefined = this process's)
 *   loadStory(storyId)     -> stored story data (not rehydrated)
 *   loadOriginal(storyId, pageNumber) -> {imageData, layer?} at version 0
 *   runPipeline(rawImages, context, options) -> runUnifiedRepairPipeline's result
 *   newTokenUsage, recordCall, inferLegacyUsageArgs, ledgerTotal     (costLedger)
 *   runWithUsageSink(addUsage, fn)                                    (usageContext)
 *   latestCoverArtVersion(storyId, coverKey) -> highest non-test art version_index | null
 *   saveVersion(storyId, pageNumber, imageData, experimentId) -> Lab version_index
 *   saveCoverVersion(storyId, coverKey, art, layer, stored) -> {versionIndex, stampFailed?}
 *   maxPasses              the production value of options.maxRegenAttempts
 */
async function runBookReviewRerun(target, { experimentId } = {}, deps) {
  assertStaging(deps.environment);
  const storyId = target.storyId;
  const t0 = Date.now();
  const stored = await deps.loadStory(storyId);
  const inputs = await buildRerunInputs(stored, (pageNumber) => deps.loadOriginal(storyId, pageNumber));
  const tokenUsage = deps.newTokenUsage();
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    try { deps.recordCall(tokenUsage, provider, usage, functionName, modelName); } catch { /* accounting is best-effort, as in the story run */ }
  };

  let out;
  try {
    out = await deps.runWithUsageSink(addUsage, () => deps.runPipeline(inputs.rawImages, {
      characters: inputs.inputData.characters,
      modelOverrides: {},
      usageTracker: (provider, usage, funcName, modelId) => {
        ({ provider, funcName } = deps.inferLegacyUsageArgs(provider, usage, funcName, modelId));
        return addUsage(provider, usage, funcName, modelId);
      },
      visualBible: stored.visualBible,
      artStyle: stored.artStyle,
      jobId: storyId,
      dbPool: null,
      storyData: inputs.storyData,
    }, {
      maxRegenAttempts: deps.maxPasses,
      evalConcurrency: 500,
      qualityModelOverride: null,
      useIteratePage: true,
    }));
  } catch (err) {
    // The paid calls up to the throw are real money: keep the ledger on the failure.
    err.partialResult = { ...(err.partialResult || {}), cost: { total: deps.ledgerTotal(tokenUsage), byFunction: costByFunction(tokenUsage) }, elapsedMs: Date.now() - t0 };
    throw err;
  }

  const warnings = [...inputs.warnings];
  // A cover touch-up (inpaint) reads the LATEST non-test art row of the story from the database
  // (repairPipeline.js), not version 0. On a copy whose cover was repaired in its original run that is
  // not the picture this stage started from; production behaviour is unchanged, so say so.
  for (const coverKey of Object.keys(inputs.coverLayers)) {
    const latest = await deps.latestCoverArtVersion(storyId, coverKey);
    if (latest != null && latest > 0) warnings.push(`${coverKey}: the copy's latest art row is version ${latest}, not 0 - a touch-up (inpaint) of this cover starts from that picture, not from the original`);
  }
  // Store the repair versions as Lab test versions (the next free version_index). The originals stay as they are.
  const savedIndex = new Map();
  for (const r of out.results) {
    const slots = {};
    const versions = r.imageVersions || [];
    for (let k = 1; k < versions.length; k++) {
      if (!versions[k].imageData) continue;
      if (r.pageNumber < 0) {
        const coverKey = COVER_KEY_BY_PAGE[r.pageNumber];
        const res = await deps.saveCoverVersion(storyId, coverKey, versions[k].imageData, inputs.coverLayers[coverKey], stored, experimentId);
        slots[k] = res.versionIndex;
        if (res.stampFailed) warnings.push(`${coverKey} v${res.versionIndex}: the title stamp failed (${res.stampFailed}); the textless art is stored as the served image`);
      } else {
        slots[k] = await deps.saveVersion(storyId, r.pageNumber, versions[k].imageData, experimentId);
      }
    }
    savedIndex.set(r.pageNumber, slots);
  }

  const pages = summarisePages(out.results, out.repairRounds, savedIndex);
  return {
    stageKind: 'book_review_rerun',
    storyId,
    title: stored.title || null,
    environment: deps.environment === undefined ? require('../config/runtime').environmentName() : deps.environment,
    startedFrom: 'version 0 of every page and the textless art of version 0 of every cover',
    bookReviewRepairRounds: deps.bookReviewRepairRounds,
    rounds: summariseRounds(out.bookAuditRounds),
    repairRounds: out.repairRounds || [],
    pages,
    shippedDefective: out.shippedDefective || [],
    survivingCriticals: out.survivingCriticals || null,
    notEvaluated: out.notEvaluated || null,
    warnings,
    cost: { total: deps.ledgerTotal(tokenUsage), byFunction: costByFunction(tokenUsage) },
    elapsedMs: Date.now() - t0,
  };
}

module.exports = { assertStaging, buildPageRepairEntry, buildRerunInputs, costByFunction, summariseRounds, summarisePages, runBookReviewRerun };
