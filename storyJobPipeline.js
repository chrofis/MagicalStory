// =============================================================================
// storyJobPipeline.js — story-generation pipeline, extracted from server.js
// (pipeline split, waves 1-2 — see docs/plans/serverjs-pipeline-extraction.md).
// Lives at repo ROOT deliberately (D1): the moved bodies contain ~60 inline
// require('./server/lib/...') call sites; same-dir placement keeps every one
// of them verbatim-valid. Do NOT move this file without rewriting those paths.
// =============================================================================

/* global clothingRequirements -- pre-existing typeof-guarded free reference in
   savePartialStoryFromCheckpoints (always undefined at module scope, so the
   costume projection resolves to null); moved verbatim, not a new defect. */

const crypto = require('crypto');
const { log } = require('./server/lib/serverLog');
const { settleJobWithRefund, JOB_SAVING_PROGRESS } = require('./server/lib/jobCredits');
const pLimit = require('p-limit');
const { buildCastIndex, resolveEntity, entriesMentioned, lookupByName } = require('./server/lib/castResolver');
const email = require('./email');
const { upsertStory, saveStoryImage, rehydrateStoryImages } = require('./server/services/database');
const { PROMPT_TEMPLATES, fillTemplate, buildEmptyScenePrompt } = require('./server/services/prompts');
const { generateViewPdf } = require('./server/lib/pdf');
const { generateImageOnly } = require('./server/lib/images');
const { landmarkPhotoIsPageScene, pageNeedsPlate, pageLandmarkScene, resolveRepairScene } = require('./server/lib/landmarkScene');
const { generateReferenceSheet, buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./server/lib/referenceSheets');
const { runUnifiedRepairPipeline } = require('./server/lib/repairPipeline');
const {
  prepareStyledAvatars,
  applyStyledAvatars,
  missingCostumedRefs,
  collectAvatarRequirements,
  setStyledAvatar,
  runInCacheScope,
  clearStyledAvatarCache,
  getStyledAvatarCacheStats,
  getStyledAvatarsForCharacter,
  exportStyledAvatarsForPersistence,
  characterIdKey,
  applyStyledAvatarsById,
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog
} = require('./server/lib/styledAvatars');
const { reconcileCoverClothingWithRequirements, reconcilePageClothingWithRequirements, resolveCharacterReqs } = require('./server/lib/clothingCategories');
const {
  getCostumedAvatarGenerationLog,
  clearCostumedAvatarGenerationLog
} = require('./server/routes/avatars');
const {
  MODEL_DEFAULTS,
  callTextModelStreaming
} = require('./server/lib/textModels');
const {
  IMAGE_MODELS,
  REPAIR_DEFAULTS,
  emptyScenePlateRouting
} = require('./server/config/models');
const {
  filterMainCharactersFromVisualBible,
  initializeVisualBibleMainCharacters,
  linkPreDiscoveredLandmarks,
  injectHistoricalLocations,
  dedupeSecondaryCharacterIds,
  adoptReferenceRenders
} = require('./server/lib/visualBible');
const { rollUpScenePrompts, projectSceneCast } = require('./server/lib/storyShape');
const {
  prefetchLandmarkPhotos,
  getIndexedLandmarks,
  loadLandmarkPhotoDescriptions,
  isSwissCountry
} = require('./server/lib/landmarkPhotos');
const {
  getCharactersInScene,
  unionPageCast,
  getCharacterPhotoDetails,
  buildCharacterReferenceList,
  buildReferenceCardColours,
  buildCoverPrompt,
  extractPageClothing,
  buildSceneExpansionPrompt,
  buildOutlineReviewPrompt,
  buildTrialStoryPrompt,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForScene,
  ensureLandmarkPhotoBytes,
  extractSceneMetadata,
  describeDegradedSceneMetadata,
  findCastMissingFromMetadata,
  getHistoricalLocations,
  convertClothingToCurrentFormat,
  resolveArtStyle,
  enforceSpreadTextPosition,
  buildSceneClothingRequirements,
} = require('./server/lib/storyHelpers');
const { UnifiedStoryParser, ProgressiveUnifiedParser } = require('./server/lib/outlineParser');
const { checkSceneConsistency, formatSceneConsistencySummary } = require('./server/lib/sceneConsistencyCheck');
const { generateStoryViaBeats, resolvePipelineMode } = require('./server/lib/beatsPipeline');
const { createJobHeartbeat, startJobHeartbeat } = require('./server/lib/jobHeartbeat');
const { newTokenUsage, recordCall, ledgerTotal } = require('./server/lib/costLedger');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require('./server/lib/generationLogger');
const { stripDataUriPrefix } = require('./server/lib/r2');
const { COVER_PAGE_NUMBERS } = require('./server/lib/coverKeys');
const { applyCoverEvalMirror } = require('./server/lib/coverEvalMirror');

/**
 * The season the TRIAL's avatar sheet is drawn for; null on every other path.
 *
 * Trial-only by measurement, not by caution. A full story's outline writes a
 * real `clothingRequirements[...].description` — the canonical outfit
 * (docs/SETTLED.md:71) — and already dresses its cast for the season it is
 * given (0 summer-outfit cold-season stories across 34 stored ones). The trial
 * has no outline: its contract is `standard: { used: true, signature: 'none' }`,
 * which every resolver discards, so NO clothing text reaches any prompt and the
 * styled 2×4 sheet is the only thing that decides what the child wears. That
 * sheet was drawn from the creation-time photo with no season input at all, so a
 * child photographed in a t-shirt wore a t-shirt through an autumn book
 * (staging job_1789296188291_thezv15y1).
 *
 * `inputData.season` is stamped in `_processStoryJobImpl` (resolveSeason from
 * the job's own created_at) before the pipeline is entered.
 */
function trialSeasonOutfit(inputData = {}) {
  if (!inputData?.trialMode) return null;
  try {
    return require('./server/lib/season').seasonOutfitGuidance(inputData);
  } catch (e) {
    log.warn(`🍁 [TRIAL] seasonOutfitGuidance failed: ${e.message} — sheet drawn without a season`);
    return null;
  }
}

/**
 * TRIAL: wait for a prepare task that is still styling one of this visitor's avatar sheets
 * (/api/trial/prepare-title: the costumed sheet; /api/trial/prepare-standard-avatar: the standard sheet),
 * then read what it persisted. create-story used to hold the whole request for this (28 s on
 * job_1791490151653); now the job is created at once and only the avatar-styling task calls this, so the
 * writer runs meanwhile. Waiting (not styling again) is what avoids duplicate sheets.
 * Returns the sheets the job may seed (a standard sheet drawn for another age/gender is left out, loudly).
 * Throws on timeout or a missing row; the caller's early-styling catch logs it and styles the sheet
 * itself. No silent default. (docs/decisions.md 2026-10-08, 2026-10-09)
 */
const TRIAL_PREPARED_AVATARS_WAIT_MS = 120000; // a costumed sheet took 86 s, a standard one ~60 s, on staging
async function awaitPreparedAvatars(ready, { userId, characterId, what, timeoutMs = TRIAL_PREPARED_AVATARS_WAIT_MS, pool = dbPool }) {
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still styling avatars after ${timeoutMs}ms`)), timeoutMs);
  });
  const started = Date.now();
  log.info(`[TRIAL] Job awaits the in-flight ${what} for user ${userId} (avoid duplicate avatar styling)`);
  try {
    await Promise.race([ready, timedOut]);
  } finally {
    clearTimeout(timer);
  }
  const rowId = `characters_${userId}`;
  const res = await pool.query('SELECT data FROM characters WHERE id = $1', [rowId]);
  if (res.rows.length === 0) throw new Error(`awaitPreparedAvatars: no characters row ${rowId}`);
  const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
  const chars = Array.isArray(data) ? data : (data.characters || []);
  const main = chars.find(c => String(c.id) === String(characterId));
  if (!main) throw new Error(`awaitPreparedAvatars: character ${characterId} not in ${rowId}`);
  log.info(`[TRIAL] ${what} wait complete after ${Date.now() - started}ms`);
  return require('./server/lib/trialSheets').usablePreparedAvatars(main);
}

/**
 * TRIAL early avatar styling (docs/decisions.md 2026-10-09). Both sheets are PREPARED before the job:
 * the standard sheet by prepare-standard-avatar (the moment the form is filled), the costumed sheet by
 * prepare-title (when the ideas are shown). The job seeds what the row held at job start, awaits whichever
 * prepare call is still in flight and seeds its result, and styles only what is still missing
 * (the two variants are independent: neither waits for the other, so a slow costumed sheet never holds the
 * standard one, which was +53 s on every page and cover for Tobias). A failure of either variant is logged,
 * not rethrown: the coverage pass before the page loop retries and fails the book if a sheet is still missing.
 *
 * awaitPrepared(ready) resolves to the persisted sheets of the finished prepare call.
 */
function runTrialEarlyStyling({ requirements, titleAvatarsReady, standardAvatarsReady, awaitPrepared, jobStartAvatars, seed, style, onDone }) {
  const isCostumed = (r) => String(r.clothingCategory).startsWith('costumed');
  const standardReqs = requirements.filter(r => !isCostumed(r));
  const costumedReqs = requirements.filter(isCostumed);
  seed(jobStartAvatars); // what the row already held at job start (a finished sheet; no-op when null)
  const run = async (label, reqs, before) => {
    if (reqs.length === 0) return;
    try {
      // A late or failed prepare-title must not leave the costumed sheet
      // unstyled: the pages recover in the coverage pass, but the trial front
      // cover renders once, before it, and shipped without a cover
      // (staging job_1791554548909_kl0phznw2: prepare-title 78 s after job
      // start, 60 s wait). Style it here instead; seeding is only a shortcut.
      if (before) {
        try { await before(); } catch (waitError) {
          log.error(`❌ [TRIAL] Early ${label} avatar wait failed: ${waitError.message} — styling it in the job`);
        }
      }
      await style(reqs);
    } catch (error) {
      log.error(`❌ [TRIAL] Early ${label} avatar styling failed: ${error.message}`);
    }
  };
  return (async () => {
    await Promise.all([
      run('standard', standardReqs, standardAvatarsReady ? async () => seed(await awaitPrepared(standardAvatarsReady, 'prepare-standard-avatar')) : null),
      run('costumed', costumedReqs, titleAvatarsReady ? async () => seed(await awaitPrepared(titleAvatarsReady, 'prepare-title')) : null)
    ]);
    if (onDone) onDone();
  })();
}

/**
 * Progress a streaming checkpoint maps to, or null for a type this table does
 * not know. Numbered by ARRIVAL order: 1=start, 2=arcs, 3=title, 4=clothing,
 * 5=plot, 6=VB, 7=covers/pages. 'coverScene' was missing from the table and fell
 * through to a default of 1, so a trial's bar went 6% -> 1% -> 7% (2026-10-09);
 * the write is also GREATEST(progress, ...) so an out-of-order checkpoint can
 * never move the bar back.
 */
const STREAMING_PROGRESS = Object.freeze({
  arcs: 2, title: 3, clothing: 4, plot: 5, visualBible: 6, coverScene: 7, covers: 7, page: 7
});
function streamingProgressFor(type) {
  return Object.prototype.hasOwnProperty.call(STREAMING_PROGRESS, type) ? STREAMING_PROGRESS[type] : null;
}

// coverTypesFor lives in server/lib/coverKeys.js (the beats Art Director needs it too).
const { coverTypesFor } = require('./server/lib/coverKeys');

// Image generation mode: 'parallel' (fast) or 'sequential' (consistent - passes previous image)
const IMAGE_GEN_MODE = process.env.IMAGE_GEN_MODE || 'parallel';

// --- Injected by initStoryJobPipeline(), called from server.js after the DB
// --- pool is created. Defaults mirror server.js's file-mode fallbacks so the
// --- checkpoint guards early-return safely if init never runs (file mode).
let dbPool = null;
let STORAGE_MODE = 'file';
// Landmark cache: no longer injected — the pipeline uses the shared resolver
// (resolveAvailableLandmarks) whose cache lives in landmarkPhotos.js.

function initStoryJobPipeline(deps) {
  dbPool = deps.dbPool;
  STORAGE_MODE = deps.STORAGE_MODE;
}

// =============================================================================
// CHECKPOINT SYSTEM - Save intermediate pipeline state for fault tolerance
// =============================================================================

// Save a checkpoint for a specific step in the pipeline
async function saveCheckpoint(jobId, stepName, stepData, stepIndex = 0) {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    await dbPool.query(`
      INSERT INTO story_job_checkpoints (job_id, step_name, step_index, step_data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_id, step_name, step_index)
      DO UPDATE SET step_data = $4, created_at = CURRENT_TIMESTAMP
    `, [jobId, stepName, stepIndex, JSON.stringify(stepData)]);
    log.verbose(`💾 Checkpoint saved: ${stepName} (index: ${stepIndex}) for job ${jobId}`);
  } catch (err) {
    log.error(`❌ Failed to save checkpoint ${stepName}:`, err.message);
  }
}

// Progressive-display image checkpoints (partial_page / partial_cover): the image goes to R2 and the
// checkpoint keeps its URL (`imageUrl`), never the bytes - see server/lib/checkpointImages.js. An upload
// failure is logged as an error and THIS checkpoint is skipped; the render itself is unaffected.
async function saveImageCheckpoint(jobId, stepName, stepData, stepIndex, slug) {
  const { imageData, ...rest } = stepData;
  try {
    const imageUrl = await require('./server/lib/checkpointImages').uploadCheckpointImage(jobId, slug, imageData);
    await saveCheckpoint(jobId, stepName, { ...rest, imageUrl }, stepIndex);
  } catch (err) {
    log.error(`❌ [CHECKPOINT] ${stepName} ${slug} for ${jobId} not saved: ${err.message}`);
  }
}

// The bytes of a progressive-display checkpoint image (salvage path: a failed job saves its partial story,
// and stories store image bytes, not the preview URL).
async function checkpointImageData(data) {
  if (data.imageData) return data.imageData;
  if (!data.imageUrl) return null;
  const buf = await require('./server/lib/r2').bytesFromAnyImage(data.imageUrl);
  if (!buf) throw new Error(`checkpoint image ${data.imageUrl} could not be read back`);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// Get checkpoint for a step (returns null if not found)
async function getCheckpoint(jobId, stepName, stepIndex = 0) {
  if (STORAGE_MODE !== 'database' || !dbPool) return null;

  try {
    const result = await dbPool.query(`
      SELECT step_data FROM story_job_checkpoints
      WHERE job_id = $1 AND step_name = $2 AND step_index = $3
    `, [jobId, stepName, stepIndex]);

    if (result.rows.length > 0) {
      return result.rows[0].step_data;
    }
    return null;
  } catch (err) {
    log.error(`❌ Failed to get checkpoint ${stepName}:`, err.message);
    return null;
  }
}

// Get all checkpoints for a job
async function getAllCheckpoints(jobId) {
  if (STORAGE_MODE !== 'database' || !dbPool) return [];

  try {
    const result = await dbPool.query(`
      SELECT step_name, step_index, step_data, created_at
      FROM story_job_checkpoints
      WHERE job_id = $1
      ORDER BY created_at ASC
    `, [jobId]);
    return result.rows;
  } catch (err) {
    log.error(`❌ Failed to get checkpoints for job ${jobId}:`, err.message);
    return [];
  }
}

// Delete all checkpoints for a job (call after job completes)
async function deleteJobCheckpoints(jobId) {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    const result = await dbPool.query(
      'DELETE FROM story_job_checkpoints WHERE job_id = $1',
      [jobId]
    );
    if (result.rowCount > 0) {
      log.debug(`🧹 Deleted ${result.rowCount} checkpoints for job ${jobId}`);
    }
  } catch (err) {
    log.error(`❌ Failed to delete checkpoints for job ${jobId}:`, err.message);
  }
}

// Save partial story from checkpoints — used when a job fails or is found as a zombie after restart.
// Reads all checkpoints, reconstructs story data, and saves to the stories table with [PARTIAL] title.
async function savePartialStoryFromCheckpoints(jobId, failureReason = 'Unknown failure') {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    // GUARD: if the full story save (upsertStory at finalize) already
    // succeeded and only a LATER step failed (e.g. the result_data update),
    // overwriting stories.data with a checkpoint-reconstructed skeleton would
    // DESTROY the complete story. Skip the partial save when the stored story
    // already has scene images and isn't itself a previous partial.
    try {
      const existing = await dbPool.query(
        `SELECT jsonb_array_length(COALESCE(data->'sceneImages','[]'::jsonb)) AS pages,
                COALESCE(data->>'title','') AS title
         FROM stories WHERE id = $1`, [jobId]);
      if (existing.rows.length > 0
          && existing.rows[0].pages > 0
          && !existing.rows[0].title.includes('[PARTIAL]')) {
        log.info(`🛟 [PARTIAL] Story ${jobId} already has a full save (${existing.rows[0].pages} pages) — skipping partial overwrite`);
        return;
      }
    } catch { /* stories row absent or unreadable → proceed with partial save */ }

    const jobDataResult = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
    if (jobDataResult.rows.length === 0) return;

    const userId = jobDataResult.rows[0].user_id;
    const inputData = jobDataResult.rows[0].input_data;
    const checkpoints = await getAllCheckpoints(jobId);
    if (checkpoints.length === 0) return;

    let outline = '';
    let outlinePrompt = '';
    let outlineModelId = null;
    let outlineUsage = null;
    // The REAL generated title, when a checkpoint carries it (unified_story /
    // story_text store `title`, the front partial_cover stores `storyTitle`).
    // The dragon salvage (job_1788551692337_bc479p945) had "Fünkli findet den
    // Weg nach Hause" sitting in its checkpoints and still shipped a
    // "Partial Story (date)" placeholder row title.
    let checkpointTitle = '';
    let fullStoryText = '';
    const sceneDescMap = new Map();
    let sceneImages = [];
    let storyTextPrompts = [];
    let visualBible = null;
    let coverImages = {};
    let pageClothingData = null;
    const lang = inputData?.language || 'en';
    const pageWord = lang.startsWith('de') ? 'Seite' : lang.startsWith('it') ? 'Pagina' : lang.startsWith('fr') ? 'Page' : 'Page';

    for (const cp of checkpoints) {
      const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

      if (cp.step_name === 'outline') {
        outline = data.outline || '';
        outlinePrompt = data.outlinePrompt || '';
        outlineModelId = data.outlineModelId || null;
        outlineUsage = data.outlineUsage || null;
        if (outline) {
          try { pageClothingData = extractPageClothing(outline, inputData?.pages || 15); } catch { /* ignore */ }
        }
      } else if (cp.step_name === 'unified_story') {
        if (data.title && String(data.title).trim()) checkpointTitle = String(data.title).trim();
        if (data.storyPages?.length) {
          fullStoryText = data.storyPages.map(p => `## ${pageWord} ${p.pageNumber}\n\n${p.text}`).join('\n\n');
          for (const page of data.storyPages) {
            if (page.sceneHint) sceneDescMap.set(page.pageNumber, page.sceneHint);
          }
        }
        if (data.visualBible) visualBible = data.visualBible;
        if (data.clothingRequirements) pageClothingData = data.clothingRequirements;
        // Raw unified response → outline, so a failed job is diagnosable from
        // data.outline (matches what successful jobs store there).
        if (data.unifiedResponse && !outline) outline = data.unifiedResponse;
        if (data.unifiedPrompt) {
          outlinePrompt = data.unifiedPrompt;
          outlineModelId = data.unifiedModelId || null;
          outlineUsage = data.unifiedUsage || null;
        }
      } else if (cp.step_name === 'story_text') {
        if (!checkpointTitle && data.title && String(data.title).trim()) checkpointTitle = String(data.title).trim();
        if (!fullStoryText && data.pageTexts) {
          const pageNums = Object.keys(data.pageTexts).sort((a, b) => Number(a) - Number(b));
          fullStoryText = pageNums.map(n => `## ${pageWord} ${n}\n\n${data.pageTexts[n]}`).join('\n\n');
        }
        if (sceneDescMap.size === 0 && Array.isArray(data.sceneDescriptions)) {
          for (const sd of data.sceneDescriptions) {
            if (sd.description) sceneDescMap.set(sd.pageNumber, sd.description);
          }
        }
      } else if (cp.step_name === 'story_batch') {
        if (data.batchText) fullStoryText += (fullStoryText ? '\n\n' : '') + data.batchText;
        if (data.batchPrompt) storyTextPrompts.push({ batch: data.batchNum || storyTextPrompts.length + 1, startPage: data.startScene || 1, endPage: data.endScene || 15, prompt: data.batchPrompt });
      } else if (cp.step_name === 'partial_page') {
        const pageNum = cp.step_index;
        const sceneDesc = data.description || data.sceneDescription?.description || data.sceneDescription || '';
        if (sceneDesc && !sceneDescMap.has(pageNum)) sceneDescMap.set(pageNum, sceneDesc);
        const pageImage = await checkpointImageData(data);
        if (pageImage) {
          sceneImages.push({ pageNumber: pageNum, imageData: pageImage, description: sceneDesc, prompt: data.prompt || data.imagePrompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, totalAttempts: data.totalAttempts, retryHistory: data.retryHistory, wasRegenerated: data.wasRegenerated, originalImage: data.originalImage, originalScore: data.originalScore, originalReasoning: data.originalReasoning, modelId: data.modelId || null, referencePhotos: data.referencePhotos || null, imageAspect: inputData?.layout?.imageAspect || data.imageAspect, textInImage: inputData?.layout?.textInImage ?? data.textInImage });
        }
      } else if (cp.step_name === 'cover' || cp.step_name === 'partial_cover') {
        if (!checkpointTitle && data.storyTitle && String(data.storyTitle).trim()) checkpointTitle = String(data.storyTitle).trim();
        const coverImage = data.type ? await checkpointImageData(data) : null;
        if (coverImage) {
          // titleBaked travels with the render (checkpointed at generation) so
          // downstream consumers of a salvaged cover — eval textMode, the
          // post-persist typography skip — treat a baked-title cover correctly.
          coverImages[data.type] = { imageData: coverImage, description: data.description || '', prompt: data.prompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, modelId: data.modelId || null, titleBaked: data.titleBaked === true };
        }
      }
    }

    const sceneDescriptions = Array.from(sceneDescMap.entries()).map(([pageNumber, description]) => ({ pageNumber, description })).sort((a, b) => a.pageNumber - b.pageNumber);
    const hasContent = outline || fullStoryText || sceneImages.length > 0;
    if (!hasContent) return;

    // The generated title from the checkpoints wins — it is the story's real
    // name; the dated placeholder is only for a job that died before the writer
    // ever named it.
    const storyTitle = checkpointTitle || inputData?.title || `Partial Story (${new Date().toLocaleDateString()})`;
    const storyData = {
      id: jobId, title: storyTitle + ' [PARTIAL]',
      storyType: inputData?.storyType || 'unknown', storyTypeName: inputData?.storyTypeName || '',
      storyCategory: inputData?.storyCategory || '', storyTopic: inputData?.storyTopic || '',
      storyTheme: inputData?.storyTheme || '', storyDetails: inputData?.storyDetails || '',
      artStyle: inputData?.artStyle || 'pixar', language: lang,
      languageLevel: inputData?.languageLevel || 'standard',
      pages: inputData?.pages || sceneImages.length, dedication: inputData?.dedication || '',
      season: inputData?.season || '', userLocation: inputData?.userLocation || null,
      characters: inputData?.characters || [], mainCharacters: inputData?.mainCharacters || [],
      relationships: inputData?.relationships || {}, relationshipTexts: inputData?.relationshipTexts || {},
      outline, outlinePrompt, outlineModelId, outlineUsage,
      story: fullStoryText, originalStory: fullStoryText, storyTextPrompts,
      visualBible: (() => {
        const sav = require('./server/lib/storyAvatars');
        const reqs = (typeof clothingRequirements !== 'undefined' && clothingRequirements) || null;
        const costumes = reqs ? sav.projectStoryCostumeDescriptions(reqs) : {};
        if (Object.keys(costumes).length === 0) return visualBible;
        const vb = visualBible || {};
        vb.costumes = costumes;
        return vb;
      })(),
      pageClothing: pageClothingData, sceneDescriptions, sceneImages, coverImages,
      characterAvatars: require('./server/lib/storyAvatars').projectStoryCharacterAvatars(
        inputData?.characters || [], inputData?.artStyle || 'pixar'
      ),
      isPartial: true, failureReason, generatedPages: sceneImages.length,
      totalPages: inputData?.pages || 15,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    await upsertStory(jobId, userId, storyData, { adminDraft: inputData?.adminDraft === true });
    log.info(`📚 [PARTIAL SAVE] Saved partial story ${jobId} with ${sceneImages.length} images, ${sceneDescriptions.length} scene descriptions`);
  } catch (err) {
    log.error(`❌ [PARTIAL SAVE] Failed to save partial story ${jobId}: ${err.message}`);
  }
}
// ===================================
// BACKGROUND STORY GENERATION JOBS
// ===================================

// NOTE: Config and parser functions moved to server/lib/storyHelpers.js
// Exports: ART_STYLES, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage,
// extractCoverScenes, buildSceneDescriptionPrompt, parseStoryPages, extractShortSceneDescriptions

// ============================================================================
// UNIFIED STORY GENERATION
// Single prompt generates complete story, Art Director expands scenes, then images
// ============================================================================
async function processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableFullRepair = true, checkCancellation = async () => {}, titleAvatarsReady = null, standardAvatarsReady = null) {
  const timingStart = Date.now();
  log.debug(`📖 [UNIFIED] Starting unified story generation for job ${jobId}`);

  // Hoisted to function scope (2026-09-13): the eval/repair short-circuit reads
  // it in the images block, and the analytics block — far below, outside that
  // scope — must report "not measured" rather than a measured zero when it is
  // on. One declaration, both readers. See docs/decisions.md
  // "Unevaluated runs report not-measured, never a clean score".
  const skipQualityEval = inputData.skipQualityEval === true;
  // The trial's Jev switch (jevDecisions.jevFallBack): its one Jev step is the
  // landmark selection before the writer call. A beats story keeps its own
  // report inside generateStoryViaBeats.
  const trialJev = { probe: null, fallback: null };

  // The stories row exists from the FIRST moment (owner, 2026-08-15).
  // story_images.story_id references stories.id, so anything written during
  // generation — cover repairs, debug artifacts, per-page versions — needs the
  // parent row to already be there. It used to appear only at finalize, five
  // minutes after the cover repairs that wanted it. The row is empty; the
  // content arrives via upsertStory at the end. An unfinished story is kept out
  // of the library by joining story_jobs status, not by a flag on the row.
  //
  // This row is also the ANCHOR for every R2 object the job writes: they all
  // land under `stories/{jobId}/`, and that prefix is only reachable — for
  // serving, for erasure, for the orphan audit — through this row. Swallowing
  // a failure here used to mean a whole story's worth of objects written with
  // nothing pointing at them, unreachable forever. So: one retry, then fail
  // the job. Failing here costs nothing (no model call has happened yet) and
  // the run could not have been saved anyway — story_images has a foreign key
  // to this row.
  {
    const { ensureStoryRow } = require('./server/services/database');
    try {
      await ensureStoryRow(jobId, userId, { adminDraft: inputData?.adminDraft === true });
    } catch (err) {
      log.warn(`⚠️ [UNIFIED] Could not pre-create the story row for ${jobId}: ${err.message} — retrying once`);
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await ensureStoryRow(jobId, userId, { adminDraft: inputData?.adminDraft === true });
      } catch (err2) {
        throw new Error(
          `Cannot create the story row for ${jobId} (${err2.message}). Refusing to generate: ` +
          `every image would be written to R2 with no database row referencing it.`);
      }
    }
  }

  // Debug: Log inputData values at start of unified processing
  log.debug(`📝 [UNIFIED INPUT] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"`);
  log.debug(`📝 [UNIFIED INPUT] mainCharacters: ${JSON.stringify(inputData.mainCharacters)}, characters count: ${inputData.characters?.length || 0}`);

  // Normalize character names at intake. A trailing/leading space in a name
  // ("Lian ") survives into avatar keys, photo labels, and prompts, while
  // Sonnet's hints echo the trimmed form — exact-match selection then silently
  // drops the character (observed: cover rendered the other child twice
  // because only one reference photo survived the match).
  for (const c of (inputData.characters || [])) {
    if (typeof c?.name === 'string') c.name = c.name.trim();
  }
  if (Array.isArray(inputData.mainCharacters)) {
    inputData.mainCharacters = inputData.mainCharacters.map(m => (typeof m === 'string' ? m.trim() : m));
  }

  // Timing tracker for all stages
  const timing = {
    start: timingStart,
    storyGenStart: null,
    storyGenEnd: null,
    coversStart: null,
    coversEnd: null,
    pagesStart: null,
    pagesEnd: null,
    end: null
  };

  // Avatar generation logs are now per-cache-scope (keyed by runInCacheScope
  // wrapper). No clear-at-start needed — a fresh job's scope has an empty
  // bucket, and a trial job's scope intentionally inherits the entries that
  // /api/trial/prepare-title pushed. Cleanup happens in processStoryJob's
  // finally block.

  // Generation logger for debugging
  const genLog = new GenerationLogger();
  // Register so deep helpers (images.js, entityConsistency.js) can record
  // apiUsage without threading genLog through every signature.
  setCurrentLogger(genLog);
  genLog.setStage('outline');

  // Token usage tracker: the per-job cost ledger (server/lib/costLedger.js).
  // Every call is priced once, when it is recorded, with the model it ran on.
  const tokenUsage = newTokenUsage();

  // ── Per-job spend cap (owner ruling 2026-09-04, sibling of the 180-min age
  // backstop in server/routes/jobs.js). The heartbeat staleness check cannot
  // catch a loop that keeps making PAID calls — updated_at stays fresh while
  // money burns — so the job's live accumulated provider cost is capped at
  // ~3x a normal full run ($4.93 measured). The running total is the sum of the
  // very per-call costs the headline total and the api_usage events read, so the
  // cap and the report cannot disagree.
  const JOB_SPEND_CAP_USD = 15;
  let jobSpentUsd = 0;

  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    // Accounting is best-effort; it must never break a render.
    try {
      jobSpentUsd += recordCall(tokenUsage, provider, usage, functionName, modelName).cost;
    } catch (e) {
      log.error(`❌ [COST] could not record a ${provider}/${functionName} call: ${e.message}`);
    }
  };
  // Register addUsage as the text-usage sink for this job's async context, so
  // every callTextModel/callTextModelStreaming records automatically (the
  // chokepoint is the single source of truth — see usageContext.js).
  require('./server/lib/usageContext').setUsageSink(addUsage);

  // The hair text follows the approved avatar, read once per character and kept on the character row
  // (docs/decisions.md "Hair text follows the approved avatar"). Before anything reads hair: the writer's
  // cast, the Visual Bible, every sheet judge and every page prompt.
  // A trial has no avatar before its sheets (the preview portrait is gone, docs/decisions.md 2026-10-09): nothing to read.
  if (!inputData.trialMode) {
    await require('./server/lib/avatarHair').ensureAvatarDerivedHair(inputData.characters || [], { userId, usageTracker: addUsage });
  }

  // Spend guard shares the cancellation checkpoints: same call sites, same loud
  // failure path (the outer catch marks the job failed and refunds credits).
  const checkCancellationUpstream = checkCancellation;
  checkCancellation = async () => {
    await checkCancellationUpstream();
    if (jobSpentUsd > JOB_SPEND_CAP_USD) {
      throw new Error(`Job spend cap exceeded: ~$${jobSpentUsd.toFixed(2)} in provider calls (cap $${JOB_SPEND_CAP_USD}) — aborting a probable paid-call loop`);
    }
  };

  // Picture-book layout for all reading levels: 1 page = 1 scene
  // (image on top, text below). The reading level controls text density only.
  const sceneCount = inputData.pages;
  const lang = inputData.language || 'en';

  // Resolve page layout once at the top of the pipeline. Read from layout
  // throughout via inputData.layout — passing as a separate parameter would
  // require threading through many existing helpers. inputData is request-
  // local (sanitized in the route handler, not shared), so augmenting it here
  // is safe.
  // Every reading level → square + text-below (2026-09-05). A4 + text-overlay
  // is reachable only through inputData.layoutOverride.
  const { resolveLayout } = require('./server/lib/layout');
  const layout = resolveLayout(inputData.languageLevel, inputData.layoutOverride);
  inputData.layout = layout;
  log.debug(`📖 [UNIFIED] Input: ${inputData.pages} pages, level: ${inputData.languageLevel} → ${sceneCount} scenes, layout: ${layout.mode} (${layout.imageAspect}, textInImage=${layout.textInImage})`);
  const { getLanguageNameEnglish } = require('./server/lib/languages');
  const langText = getLanguageNameEnglish(lang);

  try {
    // PHASE 1: Generate complete story with unified prompt
    await checkCancellation();
    // GREATEST: the claim already wrote 5, and a visitor's bar never goes back.
    await dbPool.query(
      'UPDATE story_jobs SET progress = GREATEST(progress, $1), progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [1, 'Starting story generation...', jobId]
    );

    // Beats-first pipeline (admin/env gated). When on, the unified writer call
    // and the outline review are both replaced by the five staged beats calls
    // in server/lib/beatsPipeline.js. Everything downstream of the parse
    // (images, repair, text_refine, covers) runs unchanged.
    const pipelineMode = resolvePipelineMode(inputData);
    const beatsMode = pipelineMode === 'beats';
    if (beatsMode) log.info(`🪜 [PIPELINE] pipelineMode=beats — unified writer + outline review are skipped`);

    // The single-call writer is the TRIAL writer and nothing else. The
    // pre-beats unified writer (buildUnifiedStoryPrompt + story-unified*.txt)
    // was deleted 2026-09-15 — see docs/decisions.md. resolvePipelineMode
    // guarantees a non-trial job is always 'beats', so this stays null there.
    // The trial writer reads the first 3 landmarks: Jev picks them on the
    // chosen idea (LB2, 3 at random from the top 5, the premise-named place
    // pinned first). Probed first, as a beats story is; on the backup the
    // resolver's order stands (docs/decisions.md 2026-09-27 "Jev selection built").
    if (inputData.trialMode) {
      await require('./server/lib/jevSelection').selectStoryLandmarks(inputData, { jevReport: trialJev, gl: genLog, mode: 'trial', probe: true });
    }
    const unifiedPrompt = inputData.trialMode
      ? buildTrialStoryPrompt(inputData, sceneCount)
      : null;
    if (unifiedPrompt) log.debug(`📖 [TRIAL] Prompt length: ${unifiedPrompt.length} chars, requesting ${sceneCount} pages`);

    // Art style for avatar generation
    const artStyle = inputData.artStyle || 'pixar';

    // Track streaming progress and parallel tasks
    let streamingTitle = null;
    let streamingClothingRequirements = null;
    let streamingVisualBible = null;
    let streamEnded = false;  // set true after progressiveParser.finalize() so scene-expansion VB waits stop spinning once the authoritative parse has run
    let streamingCoverHints = null;
    let streamingPagesDetected = 0;
    let lastProgressUpdate = Date.now();
    let landmarkDescriptionsPromise = null; // Promise for loading landmark photo descriptions
    const sceneBackgrounds = {}; // Populated by trial mode early background generation OR Phase 5a-pre
    let streamingAvatarStylingPromise = null; // Promise for early avatar styling (started when clothing requirements ready)
    let earlyAvatarStylingSucceeded = false; // Track whether early styling actually cached avatars
    // Trial-only: kicked off inside onVisualBible callback so the same compute
    // we run anyway (post-finalize generateReferenceSheet at ~line 4443) lands
    // in time for trial page render. Awaited by startTrialPageImageGeneration
    // before reading element refs. Skipped for full mode (which has its own
    // scene-expansion + finalize-time gen path).
    let trialReferenceSheetPromise = null;
    // Trial-only: pageNumber -> the empty-scene plate promise for that page,
    // registered in onVisualBible (the VISUAL BIBLE section streams BEFORE
    // STORY PAGES, so every entry exists before any page renders) and awaited by
    // startTrialPageImageGeneration.
    //
    // Without this the plates were pure waste: they are kicked off
    // fire-and-forget, the page render read `sceneBackgrounds[n] || null`, found
    // nothing yet, and packReferences promoted the RAW landmark photograph into
    // the slot instead — so the page edited a real photo while the styled plate
    // it should have used finished moments later and was never looked at.
    // Measured on staging job_1787762276985_rog82sfh7: 6 plates generated
    // ($0.12), 0 used, 4 pages still carrying a raw landmark photo.
    const trialEmptyScenePromises = new Map();
    // LOC id → { promise, page } of the first trial plate rendered at that
    // location. The trial front cover reuses it as its people-free plate
    // instead of rendering on the raw landmark photograph.
    const trialPlatesByLoc = new Map();

    // Track parallel tasks started during streaming
    const streamingSceneExpansionPromises = new Map(); // pageNum -> promise
    const streamingCoverPromises = new Map(); // coverType -> promise
    // Settles once the outfit-version / wardrobe-variant sheets are stored (or
    // none are needed). A cover that wears an outfit version waits on it.
    let resolveWardrobeVersions = () => {};
    const wardrobeVersionsReady = new Promise(r => { resolveWardrobeVersions = r; });
    const streamingTrialPageImagePromises = new Map(); // pageNum -> promise (trial mode only)
    const streamingExpandedPages = new Map(); // pageNum -> page data (for scene expansion)
    let coversStartedDuringStreaming = false;

    // Landmark-photo barrier. Covers start during streaming (before the landmark
    // fetch is even kicked off) and resolve their backdrop via
    // getLandmarkPhotosForScene — which reads loc.photoFetchStatus. Without a
    // barrier they race ahead of prefetchLandmarkPhotos, see status still
    // pending, get 0 landmark photos, and the composite cover path silently
    // falls back to figures-on-white. Pages don't hit this because they only
    // start after the landmark fetch is awaited. Covers await this promise;
    // it's resolved once the fetch completes (or is skipped when there's
    // nothing to fetch). The main flow always reaches the landmark block, so
    // this never deadlocks.
    let resolveLandmarksReady;
    const landmarksReady = new Promise((r) => { resolveLandmarksReady = r; });

    // Same gate for VB ELEMENT REFERENCE SHEETS. Covers stream early (they only
    // waited for the Visual Bible TEXT and the landmark photos), while element
    // sheets are generated much later in the flow — so a cover built its VB grid
    // while entries still had no referenceImageUrl, and getElementReferenceImages*
    // silently dropped them for lack of a ref. The dragon on a dragon story's
    // cover therefore had only its TEXT description and came out a different
    // colour than on the pages, which do get the picture (job_1787001865052).
    // Resolved right after the sheets are awaited; the main flow always reaches
    // that block, so this cannot deadlock, and the covers are awaited later still.
    let resolveRefSheetsReady;
    const refSheetsReady = new Promise((r) => { resolveRefSheetsReady = r; });

    // TRIAL MODE: Start avatar styling immediately using pre-defined costumes
    // This runs in parallel with story generation (no need to wait for outline clothing)
    if (inputData.trialMode && !skipImages && artStyle !== 'realistic') {
      const { getTrialCostumeForStory } = require('./server/config/trialCostumes');
      const mainChar = (inputData.characters || [])[0];
      // Category/theme/topic -> costume mapping lives in trialCostumes.js, so the
      // avatar prewarm, this job and the idea generator cannot disagree about
      // whether this story has a costume at all.
      const costume = getTrialCostumeForStory({
        storyCategory: inputData.storyCategory,
        storyTheme: inputData.storyTheme,
        storyTopic: inputData.storyTopic,
        gender: mainChar?.gender || ''
      });

      // Build clothing requirements from config (not from outline)
      const trialClothingRequirements = {};
      for (const char of (inputData.characters || [])) {
        trialClothingRequirements[char.name] = {
          standard: { used: true, signature: 'none' },
          costumed: costume
            ? { used: true, costume: costume.costumeType, description: costume.description }
            : { used: false }
        };
      }

      // Store for later use (skip outline-generated clothing)
      inputData._trialClothingRequirements = trialClothingRequirements;
      inputData._trialCostumeType = costume?.costumeType || null;
      log.debug(`🎭 [TRIAL] _trialCostumeType set to: ${inputData._trialCostumeType} (costume: ${costume ? costume.costumeType : 'null'}, mainChar gender: ${mainChar?.gender})`);
      log.debug(`🎭 [TRIAL] Characters isMainCharacter: ${(inputData.characters || []).map(c => `${c.name}=${c.isMainCharacter}`).join(', ')}`);

      // Trial builds BOTH sheets, through the same 2-pass pipeline a full story
      // uses (Pass 1 realistic anchor → Pass 2 style transfer). A costumed-only
      // policy was tried and reverted (owner, 2026-08-16): the `standard` pages
      // it left behind had to fall back to something, and every stand-in was
      // worse than the real sheet — the costumed sheet (child in costume in
      // bed), or the raw preview avatar (a Pass-1 realistic anchor, so painted
      // photographs), or a separately-converted preview (a 3×3 grid, because
      // the style-transfer pass converts SHEETS). Both sheets are built here in
      // parallel, inside the ~100s outline window, so the wall-clock cost is
      // near zero — the saving was never worth a trial-only avatar path.
      const trialAvatarRequirements = (inputData.characters || []).flatMap(char => {
        const cats = costume ? [`costumed:${costume.costumeType}`, 'standard'] : ['standard'];
        return cats.map(cat => ({
          pageNumber: 'pre-cover',
          clothingCategory: cat,
          characterNames: [char.name]
        }));
      });

      // Seed cache with the sheets the prepare calls made (avoid re-generating): the standard sheet from
      // prepare-standard-avatar, the costumed one from prepare-title. Called from the styling task below, AFTER the
      // job has awaited whichever call is still in flight (create-story no longer does: docs/decisions.md 2026-10-08).
      // standardPrepared: the standard sheet came from a prepare call, so its slides are already stored.
      let standardPrepared = false;
      const seedPreGeneratedAvatars = (preGenAvatars) => {
        if (!preGenAvatars) return;
        let seeded = 0;
        // Seeding must write BOTH the module cache and the character object.
        // setStyledAvatar writes only the cache, and prepareStyledAvatars then
        // SKIPS an already-cached entry (`if (styledAvatarCache.has(cacheKey))
        // continue`), so its own write-back to char.avatars.styledAvatars never
        // ran for a seeded character. That object is the ONLY thing
        // projectStoryCharacterAvatars reads, so the story-avatar map came back
        // empty, applyStoryCellRefs bailed at `if (!story) continue`, and every
        // trial page shipped the WHOLE 2×4 sheet as its reference instead of the
        // one matching pose cell (verified on prod job_1787647410717_5dvfqu8jg
        // p2). Shape mirrors the write-back in styledAvatars.js exactly.
        const characterNamed = (charName) => (inputData.characters || []).find(c => c?.name === charName)
          || (inputData.characters || []).find(c => String(c?.name || '').toLowerCase() === String(charName).toLowerCase());
        const rememberOnCharacter = (charName, clothingCategory, imageData) => {
          const char = characterNamed(charName);
          if (!char || !imageData) return;
          if (!char.avatars) char.avatars = {};
          if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
          if (!char.avatars.styledAvatars[artStyle]) char.avatars.styledAvatars[artStyle] = {};
          if (clothingCategory.startsWith('costumed:')) {
            const costumeType = clothingCategory.split(':')[1] || 'default';
            if (!char.avatars.styledAvatars[artStyle].costumed) char.avatars.styledAvatars[artStyle].costumed = {};
            char.avatars.styledAvatars[artStyle].costumed[costumeType] = imageData;
          } else {
            char.avatars.styledAvatars[artStyle][clothingCategory] = imageData;
          }
        };
        for (const [charName, avatars] of Object.entries(preGenAvatars)) {
          for (const [category, imageData] of Object.entries(avatars)) {
            if (category === 'costumed' && typeof avatars.costumed === 'object') {
              for (const [costumeType, img] of Object.entries(avatars.costumed)) {
                setStyledAvatar(characterNamed(charName) || charName, `costumed:${costumeType}`, artStyle, img);
                rememberOnCharacter(charName, `costumed:${costumeType}`, img);
                seeded++;
              }
            } else if (category !== 'costumed') {
              setStyledAvatar(characterNamed(charName) || charName, category, artStyle, imageData);
              rememberOnCharacter(charName, category, imageData);
              if (category === 'standard') standardPrepared = true;
              seeded++;
            }
          }
        }
        if (seeded > 0) log.info(`♻️ [TRIAL] Seeded ${seeded} prepared styled avatars (cache + character object)`);
      };

      log.info(`🎨 [TRIAL] Starting immediate avatar styling (${trialAvatarRequirements.length} variants)...`);
      // Two tasks, not one (docs/decisions.md 2026-10-09). Both sheets are normally PREPARED before the job
      // (standard at the form, costumed with the ideas), so each task seeds its sheet from the row and awaits the
      // prepare call if it is still in flight; only a sheet nobody prepared is styled here. The two never wait for
      // each other: awaiting prepare-title before styling anything held every page and cover image behind
      // "Waiting for early avatar styling" (Tobias +53 s).
      // Trial skips the sheet reviews (owner 2026-08-15): skipQualityEval
      // reaches generateComposited2x4 as skipReview — 1 try per row, no
      // bodies/heads/identity/style eval. Measured on job_1786818831439:
      // 4 Gemini evals plus a body-row retry the trial cannot act on
      // anyway (no repair stage).
      streamingAvatarStylingPromise = runTrialEarlyStyling({
        requirements: trialAvatarRequirements,
        titleAvatarsReady,
        standardAvatarsReady,
        // The same-scope cache already holds the sheet, the DB row carries the
        // persisted copy the seeding reads.
        awaitPrepared: (ready, what) => awaitPreparedAvatars(ready, { userId, characterId: (inputData.characters || [])[0]?.id, what }),
        // What the row held when the job started (a finished prepare call): seeded first. A standard sheet
        // drawn for another age/gender than the row now says is left out, loudly (usablePreparedAvatars).
        jobStartAvatars: require('./server/lib/trialSheets').usablePreparedAvatars((inputData.characters || [])[0]),
        seed: seedPreGeneratedAvatars,
        style: (reqs) => prepareStyledAvatars(inputData.characters || [], artStyle, reqs, trialClothingRequirements, addUsage, modelOverrides.storyAvatarModel || null, { skipQualityEval: true, seasonOutfit: trialSeasonOutfit(inputData) }),
        onDone: () => {
          earlyAvatarStylingSucceeded = getStyledAvatarCacheStats().size > 0;
          log.info(`✅ [TRIAL] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
          // A standard sheet the job styled itself (no prepare call made it) is new to the waiting-page slideshow:
          // put its head and body cells next to the costumed ones. A prepared one is already in the stored slides,
          // cut by the prepare call (docs/decisions.md 2026-10-09).
          const main = (inputData.characters || [])[0];
          const styled = !standardPrepared && main && getStyledAvatarsForCharacter(main, artStyle);
          if (styled) {
            require('./server/lib/avatarSlides')
              .persistAvatarSlides({ characterId: `characters_${userId}`, userId, styledAvatars: styled })
              .then(n => log.info(`🎞️ [TRIAL] ${n} avatar slides stored for the waiting page`))
              .catch(err => log.error(`❌ [TRIAL] Avatar slides for the waiting page failed: ${err.message}`));
          }
        }
      });
    }

    // Rate limiters for streaming tasks (aggressive parallelism)
    const streamSceneLimit = pLimit(10);   // Scene expansions are text-only, can parallelize heavily
    const streamCoverLimit = pLimit(3);    // Only 3 covers total anyway

    // NOTE: Avatar generation removed from streaming. Avatars should exist before story starts.

    // Helper: Start scene expansion for a page
    const startSceneExpansion = (page) => {
      if (streamingSceneExpansionPromises.has(page.pageNumber)) return;

      // Need visual bible for scene expansion - queue if not available yet
      const expansionPromise = streamSceneLimit(async () => {
        // Wait for visual bible if not yet available (cap at 5 minutes), but
        // stop early once the stream has finished — at that point the
        // authoritative full parse has run and backfilled streamingVisualBible
        // (see finalize block below), so there's nothing more to wait for.
        // Spinning the full 5 minutes after stream-end is what produced the
        // heartbeat timeout on job_1781036274234 (2026-06-09).
        let vbWait = 0;
        while (!streamingVisualBible && !streamEnded && vbWait < 3000) {
          await new Promise(r => setTimeout(r, 100));
          vbWait++;
        }
        // Never return null here — a null scene crashes the page-sort
        // downstream. If the VB never materialised (streaming AND full parse
        // both missed it), proceed with an empty VB: the unified-prose path
        // uses page.sceneProse directly and only loses landmark / element-ref
        // enrichment. A degraded page beats a crashed story.
        if (!streamingVisualBible) {
          log.warn(`[STREAM] Visual Bible unavailable for page ${page.pageNumber} scene expansion — proceeding with empty VB (degraded, no landmark/element refs)`);
          streamingVisualBible = streamingVisualBible || {};
        }

        // Wait for landmark photo descriptions to be loaded (so variants are in the prompt)
        if (landmarkDescriptionsPromise) {
          await landmarkDescriptionsPromise;
        }

        // Build character list from OUTLINE HINT only (not page text).
        // The outline's characters[] array is authoritative — it specifies who is
        // VISIBLE in the illustration. The page text may mention other characters
        // (narration, dialogue) who should NOT be drawn.
        // Also scan the outline's background field for secondary characters.
        let sceneCharacters = [];
        const allChars = inputData.characters || [];
        const sceneCastIndex = buildCastIndex({ characters: allChars }, null);

        // 1. Characters from outline's characters[] array (primary — foreground/center)
        if (page.characters && page.characters.length > 0) {
          for (const parsed of page.characters) {
            const hit = resolveEntity(parsed, sceneCastIndex);
            if (hit && !sceneCharacters.includes(hit.entry)) sceneCharacters.push(hit.entry);
          }
        }

        // 2. Characters mentioned in outline's background text (secondary — visible but background)
        // Claude occasionally names a character in the background prose without
        // listing them in characters[]; pick them up here, and log a warning
        // so we can see how often the hint diverges from itself.
        const hintJson = page.sceneHint || '';
        const backgroundMentionAdded = [];
        try {
          const hintParsed = JSON.parse(hintJson.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
          for (const hit of entriesMentioned(hintParsed.background || '', sceneCastIndex)) {
            if (sceneCharacters.includes(hit.entry)) continue;
            sceneCharacters.push(hit.entry);
            backgroundMentionAdded.push(hit.name);
          }
        } catch { /* not valid JSON — skip background parsing */ }
        if (backgroundMentionAdded.length > 0) {
          const missing = backgroundMentionAdded.filter(n => !(page.characterClothing && page.characterClothing[n]));
          if (missing.length > 0) {
            log.warn(`[SCENE HINT] Page ${page.pageNumber}: characters named in background but missing from characters[]: ${missing.join(', ')} — falling back to global clothing requirements`);
          }
        }

        // 3. Fallback: if outline parsing found nothing, scan scene hint text only (not page text)
        if (sceneCharacters.length === 0) {
          sceneCharacters = getCharactersInScene(
            page.sceneHint || '',
            allChars
          );
        }

        // SIMPLE: Get raw outline blocks directly from parser (no parsing/reconstruction needed)
        // Previous pages = raw outline blocks for pages N-2 and N-1
        // Current page = raw outline block for page N
        const prevPageNumbers = [];
        for (let p = page.pageNumber - 2; p < page.pageNumber; p++) {
          if (p >= 1) prevPageNumbers.push(p);
        }
        const rawOutlineContext = {
          previousPages: progressiveParser.getRawPageBlocks(prevPageNumbers),
          currentPage: progressiveParser.getRawPageBlock(page.pageNumber)
        };

        log.debug(`⚡ [STREAM-SCENE] Page ${page.pageNumber} starting expansion (prev: ${prevPageNumbers.join(',') || 'none'})`);

        // Build available avatars string - only show clothing categories used in this story
        const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters, streamingClothingRequirements);

        // Initial expansion: simplified prompt, no preview feedback (fast/cheap)
        const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel];

        // Resolve per-scene reference photos so the scene expansion prompt can include
        // the actual avatar clothing descriptions for each character. This pre-resolves
        // what would otherwise be built later in the pipeline at image-prompt time.
        // Use per-page clothing from outline hint (page.characterClothing) to ensure
        // costumed characters get costume descriptions, not standard clothing.
        let expansionPagePhotos = null;
        try {
          // Merge per-page clothing into a copy of clothing requirements so
          // getCharacterPhotoDetails picks the correct avatar (costumed vs standard).
          // CRITICAL: must clone the nested character entry before writing
          // _currentClothing. A shallow spread shares nested references, so
          // mutating pageClothingReqs[charName]._currentClothing would write
          // straight through to streamingClothingRequirements[charName] and
          // leak that per-page value into every future page.
          const pageClothingReqs = { ...streamingClothingRequirements };
          // Same contract check the post-parse pages get — this path runs
          // BEFORE the full parse, so it cannot inherit that reconciliation.
          const streamingContract = inputData.trialMode
            ? inputData._trialClothingRequirements
            : streamingClothingRequirements;
          const reconciledPageClothing = reconcilePageClothingWithRequirements(
            page.characterClothing,
            streamingContract,
            { pageNumber: page.pageNumber, logger: log, label: 'PAGE CLOTHING/STREAM' }
          ).clothing;
          if (page.characterClothing) {
            page.characterClothing = reconciledPageClothing;
            for (const [charName, clothingCat] of Object.entries(page.characterClothing)) {
              pageClothingReqs[charName] = {
                ...(pageClothingReqs[charName] || {}),
                _currentClothing: clothingCat
              };
            }
          }
          // Fill gaps for background-mention characters (in sceneCharacters but
          // absent from page.characterClothing — Claude forgot to list them in
          // the hint's characters[] array). Mirrors the page-render path at
          // ~line 4596 so both paths resolve clothing the same way and the
          // safety net in getCharacterPhotoDetails never has to fire.
          for (const char of sceneCharacters) {
            if (pageClothingReqs[char.name]?._currentClothing) continue;
            const globalReqs = pageClothingReqs[char.name];
            const fallback = (globalReqs?.costumed?.used && globalReqs.costumed.costume)
              ? `costumed:${globalReqs.costumed.costume}`
              : 'standard';
            pageClothingReqs[char.name] = {
              ...(globalReqs || {}),
              _currentClothing: fallback
            };
          }
          expansionPagePhotos = getCharacterPhotoDetails(
            sceneCharacters,
            'standard',
            inputData.artStyle,
            pageClothingReqs
          );
        } catch (photoErr) {
          log.debug(`[SCENE EXPANSION] Could not pre-resolve photos for page ${page.pageNumber}: ${photoErr.message}`);
        }

        // Unified-scene-prose path: Sonnet wrote the ~300-word scene paragraph
        // directly in the unified pass (emitted as page.sceneProse alongside
        // page.sceneHint). When that field is present AND the feature flag is
        // on, skip the Haiku expansion call entirely — the prose goes straight
        // into sceneDescription. Haiku stays in its classifier roles (iterate
        // repair, feedback consolidator).
        const useUnifiedProse = MODEL_DEFAULTS.unifiedSceneProse === true && page.sceneProse && page.sceneProse.length > 50;

        let expansionPrompt = null;
        let expansionResult = null;
        let finalSceneDescription;

        if (useUnifiedProse) {
          // Build the "expansion prompt" only for dev-panel traceability — never call the model.
          // The sceneDescription we emit is Sonnet's prose concatenated with the METADATA JSON
          // block so downstream extractors (characters[], objects[], textPosition, interactions[])
          // still work via extractSceneMetadata().
          const metadataBlock = page.sceneHint ? `\n\n---METADATA---\n${page.sceneHint}` : '';
          finalSceneDescription = `${page.sceneProse}${metadataBlock}`;
          log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} scene prose from unified pass (${page.sceneProse.length} chars) — Haiku expansion skipped`);
          genLog.info('scene_expanded', `Page ${page.pageNumber} scene prose from Sonnet unified pass`, null, { pageNumber: page.pageNumber, source: 'unified' });
        } else {
          // Legacy path: Haiku scene-expansion.
          expansionPrompt = buildSceneExpansionPrompt(
            page.pageNumber,
            page.text,
            sceneCharacters,
            lang,
            streamingVisualBible,
            availableAvatars,
            rawOutlineContext, // pass raw outline blocks directly
            {
              maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
              artStyleId: inputData.artStyle,
              imageBackend: imgModelConfig?.backend,
              referencePhotos: expansionPagePhotos,
              // Decides whether the text-zone rule family is asked for at all.
              story: inputData,
              // This legacy per-page path has no decision layer: nothing is fixed upstream.
              jevBackup: true,
            }
          );

          // Heartbeat keeps story_jobs.updated_at fresh during scene expansion streaming.
          // 24 parallel scene expansions can each take 30-60s; without heartbeating,
          // the row would only get updated when the first one finishes.
          const expansionHeartbeat = createJobHeartbeat(jobId, dbPool);
          expansionResult = await callTextModelStreaming(expansionPrompt, null, () => expansionHeartbeat(), modelOverrides.sceneDescriptionModel, { usageLabel: 'scene_expansion' });
          // Usage recorded by the callTextModelStreaming chokepoint (usageLabel above).
          finalSceneDescription = expansionResult.text;

          log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} scene expanded (Haiku)`);
          genLog.info('scene_expanded', `Page ${page.pageNumber} scene expanded`, null, { pageNumber: page.pageNumber, model: expansionResult.modelId });
        }

        // Post-expansion validation: validate and repair scene composition (disabled — was enableSceneValidation)
        if (false) {
          try {
            const { validateAndRepairScene, isValidationAvailable } = require('./server/lib/sceneValidator');
            const { extractSceneMetadata } = require('./server/lib/storyHelpers');
            const sceneMetadata = extractSceneMetadata(expansionResult.text);

            if (sceneMetadata && isValidationAvailable()) {
              log.debug(`🔍 [STREAM-SCENE] Page ${page.pageNumber} running composition validation...`);
              const validationResult = await validateAndRepairScene(sceneMetadata);

              // Track validation costs
              if (validationResult.usage) {
                if (validationResult.usage.previewCost) {
                  addUsage('runware', { direct_cost: validationResult.usage.previewCost }, 'scene_validation_preview');
                }
                if (validationResult.usage.visionUsage || validationResult.usage.comparisonUsage) {
                  // Was a Gemini-shaped { promptTokenCount } object, which
                  // addUsage (reads input_tokens) booked as 0 tokens.
                  const { sumUsage } = require('./server/lib/providerUsage');
                  addUsage('gemini_text', sumUsage([validationResult.usage.visionUsage, validationResult.usage.comparisonUsage]), 'scene_validation_analysis', MODEL_DEFAULTS.qualityEval);
                }
                if (validationResult.repair?.usage) {
                  addUsage('anthropic', validationResult.repair.usage, 'scene_validation_repair');
                }
              }

              if (validationResult.wasRepaired) {
                log.info(`🔧 [STREAM-SCENE] Page ${page.pageNumber} scene repaired: ${validationResult.repair.fixes.length} fixes applied`);
                finalSceneDescription = JSON.stringify(validationResult.finalScene);
              } else if (!validationResult.validation.passesCompositionCheck) {
                log.warn(`⚠️  [STREAM-SCENE] Page ${page.pageNumber} has composition issues but repair failed`);
              } else {
                log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} passes composition check`);
              }
            }
          } catch (err) {
            log.warn(`⚠️  [STREAM-SCENE] Page ${page.pageNumber} validation failed: ${err.message}`);
            // Continue with original scene description
          }
        }

        return {
          pageNumber: page.pageNumber,
          text: page.text,
          sceneHint: page.sceneHint,
          sceneDescription: finalSceneDescription,
          sceneDescriptionPrompt: expansionPrompt,
          sceneDescriptionModelId: expansionResult ? expansionResult.modelId : 'claude-sonnet:unified',
          characterClothing: page.characterClothing,
          characters: page.characters,
          // Store outline's intended character list — eval uses this to distinguish
          // "outline-required" (penalty if missing) vs "scene-expansion-added" (no penalty)
          outlineCharacters: page.characters || []
        };
      });

      streamingSceneExpansionPromises.set(page.pageNumber, expansionPromise);
      log.debug(`⚡ [STREAM-SCENE] Started expansion for page ${page.pageNumber}`);
    };

    // Helper: Start trial page image generation as soon as a page completes streaming
    // For trial mode only — generates the page image in parallel with the rest of streaming.
    // Skips empty scene generation, ref sheets, and landmark photos (trial stories are simple).
    const startTrialPageImageGeneration = (page) => {
      if (!inputData.trialMode || skipImages) return;
      if (streamingTrialPageImagePromises.has(page.pageNumber)) return;

      const imagePromise = (async () => {
        try {
          // Wait for prerequisites: visual bible + early avatar styling (cap at 5 minutes)
          let vbWait = 0;
          while (!streamingVisualBible && vbWait < 3000) {
            await new Promise(r => setTimeout(r, 100));
            vbWait++;
          }
          if (!streamingVisualBible) {
            log.warn('[TRIAL-PAGE] Timed out waiting for Visual Bible — skipping page image');
            return null;
          }
          if (streamingAvatarStylingPromise) {
            await streamingAvatarStylingPromise;
          }
          // Wait for THIS page's styled background plate. The plate is the whole
          // point of generating it: without the await the page read
          // `sceneBackgrounds[n] || null`, found nothing yet, and packReferences
          // promoted the raw landmark PHOTOGRAPH into the slot instead — so the
          // page was an edit of a real photo while its styled plate landed
          // moments later, unused and paid for.
          // Whether a missing plate fails the page is decided below, once the
          // page's cast and landmark photos are known (plate or fail).
          const platePromise = trialEmptyScenePromises.get(page.pageNumber);
          if (platePromise) await platePromise;

          // Build per-character clothing for this page.
          // Honour Claude's per-page clothing choices — including narrative
          // arcs that put the main character in standard clothes for some
          // pages and costume for others. The previous force-costumed
          // override here was reverted (user direction): the story should
          // dictate the wardrobe, not the trial theme. Same fallback as
          // pre-override: only if Claude emits no clothing at all do we
          // default the main character to 'costumed' so the page has
          // something to render.
          const perCharClothing = reconcilePageClothingWithRequirements(
            page.characterClothing || {},
            inputData._trialClothingRequirements,
            { pageNumber: page.pageNumber, logger: log, label: 'PAGE CLOTHING/TRIAL' }
          ).clothing;
          page.characterClothing = perCharClothing;
          if (inputData._trialCostumeType && Object.keys(perCharClothing).length === 0) {
            const mainCharIds = inputData.mainCharacters || [];
            for (const char of (inputData.characters || [])) {
              const isMain = char.isMainCharacter === true || mainCharIds.includes(char.id);
              if (isMain) {
                perCharClothing[char.name] = 'costumed';
              }
            }
          }

          // Determine which characters appear in this scene. Same union rule as
          // the full-mode page cast (see unionPageCast): the hint's own
          // `characters[]` is commissioned cast even when the prose never names
          // them. Per-page clothing keys are deliberately NOT read — they are
          // populated for the whole cast on pages that commission nobody.
          const sceneCharacters = unionPageCast(
            (page.sceneHint || '') + '\n' + (page.text || ''),
            page.characters || [],
            inputData.characters
          );

          // Build clothing requirements with _currentClothing per character —
          // the SAME builder full mode uses: name-tolerant (outline "Luna" vs
          // character "LUNA"), clones the entry so a per-scene value never
          // pollutes inputData._trialClothingRequirements, and refuses to
          // default to 'standard'. Hand-rolling this here rendered a whole
          // trial in the standard avatar (prod job_1790769860433_2bhhj0pyi).
          const sceneClothingRequirements = buildSceneClothingRequirements(
            sceneCharacters, perCharClothing, inputData._trialClothingRequirements
          );

          // Get character photos with styled avatars applied
          let pagePhotos = getCharacterPhotoDetails(sceneCharacters, 'standard', inputData.artStyle, sceneClothingRequirements);
          pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
          // COSTUME OR FAIL. The early styling pass above swallows its error
          // (the final coverage pass retries and fails the book), but this page
          // streams BEFORE that pass: with the costumed sheet missing, the
          // photo above is the standard avatar / raw photo and the page would
          // render the hero in modern clothes, then be REUSED by the page loop
          // even when the retry produced the sheet. Fail the streamed page
          // instead; the page loop renders it after the coverage pass.
          {
            const bare = missingCostumedRefs(pagePhotos);
            if (bare.length > 0) {
              log.error(`❌ [TRIAL-PAGE] Page ${page.pageNumber}: costumed sheet missing for ${bare.join(', ')} — page not rendered on the standard avatar`);
              throw new Error(`page ${page.pageNumber}: costumed sheet missing for ${bare.join(', ')}`);
            }
          }

          // Build the image prompt — trial uses rich scene hint as scene description
          const sceneDescription = page.sceneHint || page.text || '';
          // Parsed BEFORE the cell crop: its characters carry pose/perspective,
          // and the crop needs them. `sceneCharacters` is the raw character
          // record list from getCharactersInScene, which has no pose at all, so
          // resolveCellPose fell through to 'threeQuarter' on every trial page —
          // including declared back-view figures. Same inputs full mode passes.
          const sceneMetadata = extractSceneMetadata(sceneDescription);
          // Phase 7: cell-crop refs from the story-scoped 2×4 sheet when one
          // exists. Mutates pagePhotos in place; characters without a story
          // sheet keep the styled-avatar URL produced above.
          {
            const sav = require('./server/lib/storyAvatars');
            const storyAvatars = sav.projectStoryCharacterAvatars(inputData.characters || [], inputData.artStyle || 'pixar');
            const metaChars = sceneMetadata?.fullData?.characters || sceneMetadata?.characters || sceneCharacters || [];
            await sav.applyStoryCellRefs(pagePhotos, storyAvatars, metaChars, {
              closeUp: sceneMetadata?.fullData?.shot === 'close-up',
            });
          }

          const pageImageModel = MODEL_DEFAULTS.simplePageImage;
          const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';

          // Resolve landmarks and VB grid for Grok reference slots
          // (sceneMetadata is parsed above, before the cell crop that needs it)
          // Same miss/downgrade contract as the full-mode pageData build: a
          // cited landmark whose photo can't be served renders prose-only,
          // loudly (fidelity blocks are built from landmarkPhotos[0], so no
          // "preserve exactly" ships without its photo).
          const trialLandmarkMisses = [];
          let pageLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, sceneMetadata, { pageNumber: page.pageNumber, misses: trialLandmarkMisses });
          pageLandmarkPhotos = await ensureLandmarkPhotoBytes(pageLandmarkPhotos, { misses: trialLandmarkMisses });
          // PLATE OR FAIL (server/lib/landmarkScene.js). A page whose plate
          // failed, or that carries a landmark photo with no plate, is not
          // rendered here: with no plate the raw photo would be the scene. It
          // fails like any other trial page (the catch below returns null and
          // the page goes through the normal page render, which plates it).
          // THE CAST-0 EXEMPTION: a page with no named cast renders on its
          // landmark photo (owner ruling 2026-09-02).
          const trialPageRef = { sceneMetadata, sceneCharacters };
          const trialPlate = sceneBackgrounds[page.pageNumber]?.imageData || null;
          if (!trialPlate && !landmarkPhotoIsPageScene(trialPageRef)) {
            if (platePromise) {
              log.error(`❌ [TRIAL-PAGE] Page ${page.pageNumber}: plate failed — page not rendered on the raw photo`);
              throw new Error(`page ${page.pageNumber} plate failed`);
            }
            if (pageLandmarkPhotos.length > 0) {
              log.error(`❌ [TRIAL-PAGE] Page ${page.pageNumber}: landmark "${pageLandmarkPhotos[0].name}" but no plate — page not rendered on the raw photo`);
              throw new Error(`page ${page.pageNumber} has a landmark photo and no plate`);
            }
          }
          if (trialPlate) log.info(`🎬 [TRIAL-PAGE] Page ${page.pageNumber}: plate ready`);
          if (trialLandmarkMisses.length > 0) {
            log.warn(`⚠️ [LANDMARK] Trial page ${page.pageNumber} renders WITHOUT its landmark reference photo (${trialLandmarkMisses.map(m => `${m.name}: ${m.reason}`).join('; ')}) — downgraded to prose description`);
          }
          // Wait for the parallel ref-sheet generation (started in onVisualBible
          // alongside empty scenes + costumed avatars) before reading element
          // refs — otherwise the page selector (pageRenderCall.buildPageVbGrid)
          // finds no usable cell because referenceImageUrl hasn't been
          // populated on each VB entry yet. The promise typically resolves well before page render
          // since costumed avatar gen takes ~30s and ref sheets ~15-20s; this
          // await is usually a no-op by the time we hit it. Falls through on
          // failure (ref sheets are an enhancement, not a hard requirement).
          if (trialReferenceSheetPromise) {
            try { await trialReferenceSheetPromise; } catch { /* logged in the catch in onVisualBible */ }
          }
          // The page's VB grid, selected, filtered and built by the ONE helper
          // the story run (Phase 5a / 5a-pre-grid), the Test Lab image stage
          // and the regenerate routes use (pageRenderCall.buildPageVbGrid):
          // the page's elements with the scene hint's objects[] and the ids it
          // cites, the physical cap VB_SLOT_MAX_ELEMENTS, the plate-borne
          // filter when a plate is sent, the camera's `aboard` element
          // withheld, and NEVER a landmark photo in the grid (owner, settled
          // 2026-08-18). Until 2026-10-07 the trial hand-rolled this selection
          // at cap 6 with no plate filter and with the secondary landmark
          // photos composited among the cells (decisions.md 2026-10-07).
          // The trial sends its plate straight to the render (no reference
          // mode), so "plate sent" is the plate itself; every reference mode
          // passes the plate through unchanged (clothingResolve.applyReferenceMode).
          const { kept, visualBibleGrid: trialVbGrid } = await require('./server/lib/pageRenderCall').buildPageVbGrid({
            visualBible: streamingVisualBible, pageNumber: page.pageNumber, sceneMetadata, hasPlate: !!trialPlate,
          });
          log.info(`🔲 [VB-GRID] Trial page ${page.pageNumber}: ${kept.length} cell(s)${kept.length ? ` — ${kept.map(e => e.id).join(', ')}` : ''} (${trialPlate ? 'plate sent, plate-borne vehicle/structure dropped' : 'no plate sent, vehicle/structure kept'})`);

          // Built AFTER the grid so the REQUIRED OBJECTS checklist can point
          // at the reference images that actually ride with this call — the
          // KEPT cells, as Phase 5a-pre-grid rebuilds its claim.
          // Through the ONE closure the story run and the Test Lab use
          // (pageRenderCall.makePageImagePrompt: the Grok VB-prose skip and the
          // reference claim), so an option added there reaches trial pages too.
          const imagePrompt = require('./server/lib/pageRenderCall').makePageImagePrompt({
            sceneDescription, inputData, sceneCharacters, visualBible: streamingVisualBible,
            pageNumber: page.pageNumber, characterPhotos: pagePhotos, pageImageModel,
          })(kept.map(e => e.id).filter(Boolean));

          log.info(`⚡ [TRIAL-STREAM] Page ${page.pageNumber} image generation starting (parallel with streaming)${pageLandmarkPhotos.length ? ` [${pageLandmarkPhotos.length} landmark(s)]` : ''}${trialVbGrid ? ' [VB grid]' : ''}`);
          const startTime = Date.now();

          const genResult = await generateImageOnly(imagePrompt, pagePhotos, {
            aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
            imageModelOverride: pageImageModel,
            imageBackendOverride: pageImageBackend,
            pageNumber: page.pageNumber,
            landmarkPhotos: pageLandmarkPhotos,
            landmarkScene: pageLandmarkScene(trialPageRef),
            visualBibleGrid: trialVbGrid,
            // Use the pre-rendered empty-scene plate as the background anchor.
            // The empty-scene block at line 3918 generates these in parallel
            // with outline streaming; if ready by the time this page renders,
            // they give the page a real scene + landmark anchor instead of a
            // text-prompt-only render. Without this the empty scenes get
            // generated and thrown away.
            sceneBackground: sceneBackgrounds[page.pageNumber]?.imageData || null,
          });

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log.info(`✅ [TRIAL-STREAM] Page ${page.pageNumber} image ready in ${elapsed}s`);

          // Track usage
          if (genResult.usage) {
            const isRunware = genResult.modelId?.startsWith('runware:');
            const isGrok = genResult.modelId?.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, genResult.usage, 'page_images', genResult.modelId);
          }

          // Save partial_page checkpoint for progressive display
          if (genResult.imageData) {
            await saveImageCheckpoint(jobId, 'partial_page', {
              pageNumber: page.pageNumber,
              text: page.text,
              sceneDescription,
              imageData: genResult.imageData,
              modelId: genResult.modelId
            }, page.pageNumber, `p${page.pageNumber}`);
          }

          // Detect calm region for text overlay (~30ms, non-blocking)
          let calmRegion = null;
          if (genResult.imageData) {
            try {
              const { detectCalmRegion } = require('./server/lib/calmRegion');
              const { enforceSpreadTextPosition } = require('./server/lib/storyHelpers');
              const textPos = enforceSpreadTextPosition(sceneMetadata?.textPosition || null, page.pageNumber);
              if (textPos) {
                const imgBuf = Buffer.from(stripDataUriPrefix(genResult.imageData), 'base64');
                calmRegion = await detectCalmRegion(imgBuf, textPos).catch(() => null);
              }
            } catch (e) { /* calm region detection is optional */ }
          }

          return {
            pageNumber: page.pageNumber,
            imageData: genResult.imageData,
            modelId: genResult.modelId,
            usage: genResult.usage,
            // Post-shrink sent text + sent scene block, like the unified page
            // path — the trial page record had the same pre-shrink bug.
            prompt: genResult.prompt || imagePrompt,
            compressedScene: genResult.compressedScene || null,
            characterPhotos: pagePhotos,
            grokRefImages: genResult.grokRefImages || null,
            sceneDescription,
            // Persist the parsed metadata so the UI / dev panel can show
            // which VB elements (CHR/ART/LOC IDs) each page references
            // and which landmark variant got picked. Without this, the
            // page row only has sceneDescription as a blob — every
            // downstream consumer had to re-run extractSceneMetadata
            // just to read it. Inspecting a completed story showed
            // empty sceneMetadata on every page even though the IDs
            // were emitted correctly in the description.
            sceneMetadata,
            text: page.text,
            sceneCharacters,
            perCharClothing,
            calmRegion,
          };
        } catch (err) {
          log.warn(`⚠️ [TRIAL-STREAM] Page ${page.pageNumber} image gen failed: ${err.message}`);
          return null;
        }
      })();

      streamingTrialPageImagePromises.set(page.pageNumber, imagePromise);
    };

    // Helper: Start cover generation
    // TRIAL-ONLY cover builder (owner, 2026-09-24 — plan covers-as-pages Q7/Q8):
    // the trial renders its covers from the writer's streamed cover JSON, fast.
    // A full story briefs its covers as pages (coverBeats.js) and never comes here.
    const startCoverGeneration = (coverType, hint) => {
      if (!inputData.trialMode) {
        throw new Error(`[COVER] ${coverType}: startCoverGeneration is the trial cover builder — a full-story cover is a page`);
      }
      if (streamingCoverPromises.has(coverType) || skipImages) return;
      if (!coverTypesFor(inputData).includes(coverType)) return;
      if (skipCovers) return;

      const coverPromise = streamCoverLimit(async () => {
        // Wait for visual bible if not yet available (cap at 5 minutes)
        let vbWait = 0;
        while (!streamingVisualBible && vbWait < 3000) {
          await new Promise(r => setTimeout(r, 100));
          vbWait++;
        }
        if (!streamingVisualBible) {
          log.warn('[STREAM-COVER] Timed out waiting for Visual Bible — skipping cover');
          return null;
        }

        // Wait for landmark photos before resolving the cover backdrop. See the
        // landmarksReady declaration: covers otherwise race the landmark fetch
        // and the composite path silently skips for lack of a landmark buffer.
        await landmarksReady;
        // …and for the element reference sheets, so a dominant VB element (a
        // creature, a vehicle, a secondary character) reaches the cover as a
        // PICTURE, not only as prose.
        await refSheetsReady;

        // Build per-character clothing requirements from hint.characterClothing
        // hint.characterClothing = { 'Manuel': 'winter', 'Sophie': 'standard', 'Roger': 'costumed:knight' }
        // Prose Hint: line is no longer emitted by Sonnet (covers are now a
        // STRUCTURED render spec per prompts/story-unified.txt §COVER SCENE
        // HINTS). Compose a scene description from the structured fields
        // (mood + characters with position/holds/gazes + first LOC backdrop).
        // Falls back to the legacy generic boilerplate only when the
        // structured fields are also missing (legacy stories or parser miss).
        let sceneDescription = hint.hint || hint.scene || '';
        if (!sceneDescription || sceneDescription.length < 20) {
          const vb = streamingVisualBible || {};
          const vbList = (kind) => Array.isArray(vb[kind]) ? vb[kind] : [];
          const resolveId = (id) => {
            const upper = String(id || '').toUpperCase();
            const all = [...vbList('locations'), ...vbList('artifacts'), ...vbList('characters'), ...vbList('animals'), ...vbList('vehicles')];
            return all.find(e => (e?.id || '').toUpperCase() === upper) || null;
          };
          const objects = Array.isArray(hint.objects) ? hint.objects : [];
          const backdropId = objects.find(id => /^LOC\d+/i.test(id || ''));
          const backdrop = backdropId ? resolveId(backdropId) : null;
          const details = hint.characterDetails || {};
          const charLines = (hint.characters || []).map(rawName => {
            const baseName = String(rawName).replace(/\s*\([^)]*\)\s*$/, '').trim();
            const d = details[baseName] || {};
            const pos = d.position ? ` (${d.position})` : '';
            const holdsRaw = (d.holds || '').toString().trim();
            let holdsPhrase = '';
            if (holdsRaw && !['nothing', 'none', '-'].includes(holdsRaw.toLowerCase())) {
              const holdsArt = holdsRaw.match(/(LOC|ART|ANI|VEH|CHR|CLO)\d+/i);
              const holdsName = holdsArt ? (resolveId(holdsArt[0])?.name || holdsRaw) : holdsRaw;
              holdsPhrase = ` holding ${holdsName}`;
            }
            // Cover gaze is code-owned (decision 2026-07-11): covers are
            // head-on portraits — every figure looks at the viewer. Any
            // parsed `gazes at:` value (old stored stories) is ignored.
            return `${baseName}${pos}${holdsPhrase}, gazing at the viewer`;
          }).filter(Boolean);
          if (charLines.length > 0) {
            const moodPhrase = hint.mood ? `, ${hint.mood} mood` : '';
            const backdropPhrase = backdrop
              ? ` at ${backdrop.name}${backdrop.description ? ` (${backdrop.description})` : ''}`
              : '';
            sceneDescription = `Cover scene${backdropPhrase}${moodPhrase}. ${charLines.join('. ')}.`;
            log.debug(`📕 [COVER] ${coverType}: Composed scene from structured hint (${sceneDescription.length} chars, ${charLines.length} chars, backdrop=${backdrop?.id || 'none'})`);
          }
        }

        // Last-resort fallback: structured fields were also empty (legacy
        // stories pre-structured-hints, or parser miss). Emit the generic
        // boilerplate so the cover render doesn't fail outright.
        if (!sceneDescription || sceneDescription.length < 20) {
          const mainCharNames = inputData.characters
            .filter(c => c.isMainCharacter)
            .map(c => c.name)
            .join(', ') || inputData.characters.map(c => c.name).slice(0, 3).join(', ');
          const theme = inputData.storyTheme || inputData.storyTopic || 'adventure';

          if (coverType === 'frontCover') {
            sceneDescription = `A magical, eye-catching front cover scene featuring ${mainCharNames} in a ${theme}-themed setting. The main characters are prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`;
          } else if (coverType === 'initialPage') {
            sceneDescription = `A warm, inviting introduction scene showing ${mainCharNames} at the beginning of their ${theme} story. A cozy atmosphere that welcomes readers into the adventure.`;
          } else {
            sceneDescription = `A satisfying conclusion scene showing ${mainCharNames} after their ${theme} adventure. They look happy and content, with visual elements reflecting how the story ended.`;
          }
          log.warn(`📕 [COVER] ${coverType}: structured hint composer produced nothing — using generic boilerplate fallback`);
        }

        // Inject explicit per-character holdings from the outline `holds` annotations.
        // Outline parser captures `- Lukas (center): standard, holds: book + Eli` into
        // hint.characterPerspectives[name].holds. Cap at 2 items per character (2 hands)
        // and append a structured "Items per character" block to the cover scene description
        // so the image model gets an unambiguous list (instead of relying on prose alone).
        const perspectives = hint.characterPerspectives || {};
        const itemLines = [];
        for (const [charName, ann] of Object.entries(perspectives)) {
          if (!ann.holds) continue;
          const holdsRaw = String(ann.holds).trim();
          if (!holdsRaw || holdsRaw.toLowerCase() === 'nothing' || holdsRaw.toLowerCase() === 'none' || holdsRaw === '-') continue;
          // Split on " + " or "&" or " and " (lightweight, just to count)
          const items = holdsRaw.split(/\s*\+\s*|\s*&\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
          if (items.length === 0) continue;
          const capped = items.slice(0, 2);
          if (items.length > 2) {
            log.warn(`📕 [COVER] ${coverType}: ${charName} had ${items.length} items in 'holds', capped to 2: ${capped.join(' + ')} (dropped: ${items.slice(2).join(', ')})`);
          }
          itemLines.push(`- ${charName}: ${capped.join(' + ')}`);
        }
        if (itemLines.length > 0) {
          sceneDescription += `\n\n**Items per character (max 2 per character — 2 hands):**\n${itemLines.join('\n')}`;
          log.info(`📕 [COVER] ${coverType}: Injected items for ${itemLines.length} character(s)`);
        }

        // Primary: use hint.characterClothing (authoritative — explicitly lists who should appear)
        // Fallback: match character names in scene text
        let coverCharacters = [];
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          const clothingCharNames = Object.keys(hint.characterClothing);
          coverCharacters = inputData.characters.filter(c =>
            clothingCharNames.some(name => name.trim().toLowerCase() === String(c.name || '').trim().toLowerCase())
          );
          if (coverCharacters.length > 0) {
            log.debug(`📕 [COVER] ${coverType}: Using ${coverCharacters.length} characters from hint.characterClothing: ${coverCharacters.map(c => c.name).join(', ')}`);
          }
        }

        // A cast that came from the hint's character list is AUTHORITATIVE —
        // every hint-listed character's avatar must be packed with the cover
        // render (owner rule 2026-07-31: the title page previously dropped a
        // hint-listed second protagonist because they weren't flagged "main",
        // so their styled avatar never went along as a reference).
        const castFromHint = coverCharacters.length > 0;

        // Fallback: if characterClothing didn't yield results, try scene text matching
        if (coverCharacters.length === 0) {
          coverCharacters = getCharactersInScene(sceneDescription, inputData.characters);
        }

        // The FRONT cover (coverType 'frontCover' → stored as frontCover) is a
        // main-characters-only portrait — but ONLY for FALLBACK casts (scene-
        // text matching). Hint-derived casts pass through untouched; the
        // narrowing exists to stop the whole cast flooding a fallback cover,
        // not to veto characters the outline explicitly placed on the cover.
        // The BACK cover is deliberately a full-cast group portrait (see
        // story-unified.txt Back Cover spec) — do NOT drop non-mains there.
        if (coverType === 'frontCover' && coverCharacters.length > 0 && !castFromHint) {
          const { narrowCoverCastToMains } = require('./server/lib/coverIterate');
          const narrowed = narrowCoverCastToMains(coverCharacters, {
            castFromHint: false,
            mainIds: inputData.mainCharacters,
          });
          if (narrowed.applied) {
            log.info(`📕 [COVER] ${coverType}: Dropping non-main characters (fallback cast): ${narrowed.dropped.join(', ')}`);
            coverCharacters = narrowed.characters;
          }
        }

        // Final fallback for title page: use main characters or all characters
        if (coverCharacters.length === 0 && coverType === 'frontCover') {
          // Try isMainCharacter property first
          let mainChars = inputData.characters.filter(c => c.isMainCharacter === true);

          // Fallback: use mainCharacters array of IDs from input (e.g., [1767791620341, 1767793922148])
          if (mainChars.length === 0 && inputData.mainCharacters && inputData.mainCharacters.length > 0) {
            mainChars = inputData.characters.filter(c => inputData.mainCharacters.includes(c.id));
            if (mainChars.length > 0) {
              log.debug(`📕 [COVER] ${coverType}: Found ${mainChars.length} main characters by ID lookup`);
            }
          }

          coverCharacters = mainChars.length > 0 ? mainChars : inputData.characters;
          log.debug(`📕 [COVER] ${coverType}: Using ${mainChars.length > 0 ? 'main' : 'all'} ${coverCharacters.length} characters (no names found in hint)`);
        }

        // Build coverClothingRequirements with _currentClothing for per-character lookup
        const coverClothingRequirements = {};
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          for (const [charName, clothing] of Object.entries(hint.characterClothing)) {
            // Keep the character's category definitions (trial stores the
            // costume + its description under `costumed`). Without them a bare
            // `_currentClothing: 'costumed'` names a category that carries no
            // costume, the styled-avatar lookup finds nothing and the cover
            // falls back to the standard avatar — the trial back cover shipped
            // the child in everyday clothes while the front cover wore the
            // costume (job_1786823576638). Same spread the trial's front-cover
            // path applies.
            coverClothingRequirements[charName] = {
              ...(resolveCharacterReqs(inputData._trialClothingRequirements, charName) || {}),
              _currentClothing: clothing,
            };
          }
          log.debug(`🎨 [COVER] ${coverType}: Using per-character clothing: ${JSON.stringify(hint.characterClothing)}`);
        }

        // Merge with streamingClothingRequirements (cover-specific takes precedence)
        // IMPORTANT: Convert streamingClothingRequirements to _currentClothing format for characters
        // not explicitly mentioned in cover hint, so they use the story's costume (not 'standard')
        const mergedClothingRequirements = convertClothingToCurrentFormat(streamingClothingRequirements);

        // Then overlay cover-specific clothing (takes precedence)
        for (const [charName, data] of Object.entries(coverClothingRequirements)) {
          if (!mergedClothingRequirements[charName]) {
            mergedClothingRequirements[charName] = data;
          } else {
            mergedClothingRequirements[charName] = { ...mergedClothingRequirements[charName], ...data };
          }
        }

        // TRIAL: every cover wears the story costume when the trial has one.
        // The front cover reaches this via its own streaming path; the back
        // cover came through here and rendered the everyday avatar because it
        // depended on the hint carrying characterClothing (job_1786825477481:
        // front costumed-wizard, back standard). Resolve it from the costume
        // itself instead of the hint shape.
        if (inputData.trialMode && inputData._trialCostumeType) {
          for (const c of (inputData.characters || [])) {
            mergedClothingRequirements[c.name] = {
              ...(resolveCharacterReqs(inputData._trialClothingRequirements, c.name) || {}),
              ...(mergedClothingRequirements[c.name] || {}),
              _currentClothing: 'costumed',
            };
          }
        }

        // Default clothing category (used if no per-character clothing specified)
        const defaultClothingCategory = 'standard';

        // Cap characters at 5 — more than 5 almost always produces bad results
        // Main characters appear on ALL covers, non-main are split across initial/back.
        // ONE constant with the iterate path and with the cover JUDGE
        // (server/lib/coverCastRoster.js).
        const { MAX_COVER_CHARACTERS } = require('./server/lib/coverCastRoster');
        let charactersForCover;
        if (coverCharacters.length > 0) {
          // Scene description contained character names - use exactly those
          charactersForCover = coverCharacters.length > MAX_COVER_CHARACTERS
            ? coverCharacters.slice(0, MAX_COVER_CHARACTERS)
            : coverCharacters;
        } else if (coverType !== 'frontCover') {
          // initialPage/backCover without scene-based characters: distribute across covers
          const allChars = inputData.characters || [];
          let mainChars = allChars.filter(c => c.isMainCharacter === true);
          // Fallback: use mainCharacters array of IDs (same as titlePage logic)
          if (mainChars.length === 0 && inputData.mainCharacters?.length > 0) {
            mainChars = allChars.filter(c => inputData.mainCharacters.includes(c.id));
          }
          const nonMainChars = mainChars.length > 0
            ? allChars.filter(c => !c.isMainCharacter)
            : allChars;
          const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
          const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
          const halfPoint = Math.ceil(nonMainChars.length / 2);
          let extras;
          if (coverType === 'initialPage') {
            extras = nonMainChars.slice(0, halfPoint).slice(0, extraSlots);
          } else {
            // backCover gets the second half
            extras = nonMainChars.slice(halfPoint).slice(0, extraSlots);
          }
          charactersForCover = [...mainCapped, ...extras];
          log.debug(`📕 [COVER] ${coverType}: ${charactersForCover.map(c => c.name).join(', ')} (${mainCapped.length} main + ${extras.length} extras, capped at ${MAX_COVER_CHARACTERS})`);
        } else {
          // titlePage without characters (shouldn't happen due to earlier fallbacks)
          charactersForCover = coverCharacters;
        }

        // Get character photos with clothing - per-character clothing from mergedClothingRequirements takes precedence
        let coverPhotos = getCharacterPhotoDetails(
          charactersForCover,
          defaultClothingCategory,
          artStyle,
          mergedClothingRequirements
        );
        coverPhotos = applyStyledAvatars(coverPhotos, artStyle);
        // COSTUME OR FAIL — same rule as the streamed trial page (see
        // startTrialPageImageGeneration): this cover renders before the final
        // coverage pass, so a missing costumed sheet fails the cover rather
        // than drawing the hero in the standard avatar.
        {
          const bare = missingCostumedRefs(coverPhotos);
          if (bare.length > 0) {
            log.error(`❌ [TRIAL-COVER] ${coverType}: costumed sheet missing for ${bare.join(', ')} — cover not rendered on the standard avatar`);
            throw new Error(`${coverType}: costumed sheet missing for ${bare.join(', ')}`);
          }
        }
        // Phase 7: cell-crop refs from story sheets. For covers we use front
        // pose by default (head-on shot) — no per-page scene metadata at this point.
        // OUTFIT VERSIONS follow the page rule (owner, 2026-09-24): a character
        // whose version garment the hint cites wears the version — its outfit
        // text and its sheet. Everyone else keeps the default.
        {
          const sav = require('./server/lib/storyAvatars');
          const { coverVersionRows } = require('./server/lib/wardrobeVariants');
          const { applyCoverOutfitVersions } = require('./server/lib/wornItems');
          const { collectCoverHintElementIds: coverHintIds } = require('./server/lib/coverIterate');
          const versionRows = coverVersionRows(streamingVisualBible, charactersForCover.map(c => c.name), coverHintIds(hint));
          if (versionRows.length > 0) {
            await wardrobeVersionsReady;
            applyCoverOutfitVersions(coverPhotos, versionRows);
          }
          const storyAvatars = sav.projectStoryCharacterAvatars(inputData.characters || [], artStyle || 'pixar');
          const fakeMeta = charactersForCover.map(c => ({ name: c.name, pose: 'front', flip: false }));
          await sav.applyStoryCellRefs(coverPhotos, storyAvatars, fakeMeta, { wornResolved: versionRows });
        }

        // Cover prompt setup — routed model/backend determined after scene expansion.
        // REQUIRED OBJECTS lists the hint's objects ∪ holds, and the
        // worn-vs-held contradiction resolved before the CLOTHING block is
        // built (same helpers the iterate path uses — single source of truth).
        const { collectCoverHintElementIds, applyCoverWornHeldDedupe } = require('./server/lib/coverIterate');
        const hintElementIds = collectCoverHintElementIds(hint);
        const { photos: clothingDedupedPhotos, excludeElementIds } =
          applyCoverWornHeldDedupe(coverPhotos, hint, streamingVisualBible);
        // The brief's objects are fixed AFTER the scene description below —
        // REQUIRED OBJECTS has to list every entity the assembled description
        // actually names (cover NAME invariant).
        // Same block as every other cover path and as pages: garment bound to
        // its wearer, plus the legend saying which framed card is whom.
        let characterRefList = buildCharacterReferenceList(clothingDedupedPhotos, inputData.characters, { includeClothing: true })
          + buildReferenceCardColours(
              (inputData.characters || []).filter(c => clothingDedupedPhotos.some(ph => ph.name === c.name)),
              clothingDedupedPhotos
            );

        // Run the cover hint through scene expansion (same as pages) so covers get
        // a structured description with emptyScenePrompt and objects metadata.
        // Wait for landmark photo descriptions so variants are in the prompt.
        if (landmarkDescriptionsPromise) {
          await landmarkDescriptionsPromise;
        }

        // No second LLM call for covers. The outline's structured coverHint
        // already contains everything needed to render: mood, objects (LOC +
        // ART), per-character details (position, clothing, holds, gazesAt,
        // priority). Build the image-prompt SCENE string deterministically
        // from those fields in code. One Sonnet call (outline) → JS templating
        // → one image-model call. Replaces the previous Haiku scene-expansion
        // round-trip which cost a call per cover and merged structured per-
        // character actions into atmospheric prose ("both face the viewer
        // with wide-eyed discovery"), losing the explicit holds: ART005 spec.
        const initialCoverModel = modelOverrides.coverImageModel || MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
        const initialCoverBackend = IMAGE_MODELS[initialCoverModel]?.backend || null;
        const { buildCoverSceneFromHint, reconcileCoverSceneEntities } = require('./server/lib/coverIterate');
        sceneDescription = buildCoverSceneFromHint(hint, streamingVisualBible, charactersForCover, { language: inputData.language || 'en' });
        // COVER NAME INVARIANT — buildCoverSceneFromHint pastes the outline's
        // per-character `position` free text verbatim, so any entity NAME the
        // writer put there arrives here. Either it is fully sent (definition
        // in REQUIRED OBJECTS + reference image in the VB grid, which
        // buildCoverReferences re-derives with the same matcher) or its name
        // is stripped. job_1788903616404_iqvhj4l8m front cover: the dog "Nia"
        // reached the model undefined and was painted as a phantom child.
        const coverNameFix = reconcileCoverSceneEntities({
          sceneDescription,
          visualBible: streamingVisualBible,
          elementIds: hintElementIds,
          label: `${coverType} FIRST-GEN`,
        });
        // The page brief's shape: prose + a METADATA block whose objects are
        // the cover's elements, so the page builder emits REQUIRED OBJECTS for
        // the cover exactly as for a page (coverBriefWithObjects).
        const { coverBriefWithObjects } = require('./server/lib/coverIterate');
        sceneDescription = coverBriefWithObjects(coverNameFix.sceneDescription,
          coverNameFix.elementIds || hintElementIds || [], excludeElementIds);
        const coverExpandedMetadata = null; // The hint IS the metadata; the brief carries its objects.

        const coverLabel = coverType === 'frontCover' ? 'FRONT COVER' : coverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';

        // Per-cover image model routing: covers always render at simple
        // complexity now (no depth/perspective allowed on covers — see story-
        // unified.txt COVER RULES). Composite render method handles its own
        // complexity decisions internally.
        const coverSceneComplexity = 'simple';
        const coverSceneRouting = modelOverrides.sceneRouting || 'auto';
        let coverImageModel, coverImageBackend;
        if (modelOverrides.coverImageModel) {
          // Explicit cover model override always wins
          coverImageModel = modelOverrides.coverImageModel;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || null;
        } else if (coverSceneRouting === 'auto') {
          coverImageModel = coverSceneComplexity === 'complex'
            ? MODEL_DEFAULTS.complexPageImage
            : MODEL_DEFAULTS.simplePageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'gemini';
          log.info(`🎯 [ROUTING] ${coverLabel}: ${coverSceneComplexity} → ${coverImageModel} (${coverImageBackend})`);
        } else if (coverSceneRouting === 'grok') {
          coverImageModel = MODEL_DEFAULTS.simplePageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'grok';
        } else if (coverSceneRouting === 'gemini') {
          coverImageModel = MODEL_DEFAULTS.complexPageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'gemini';
        } else {
          coverImageModel = MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || null;
        }
        // Build style description using the routed backend (same as pages at buildImagePrompt time)
        const styleDescription = resolveArtStyle(artStyle, coverImageBackend) || resolveArtStyle('pixar');

        // App-side cover typography: generate the art TEXTLESS (title / dedication /
        // branding are composited afterwards by server/lib/coverTypography.js).
        // Same builder as pages and as every other cover path (owner,
        // 2026-08-26). Art is generated textless; the title, dedication and
        // branding are composited afterwards by coverTypography.js.
        // `let`, not `const`: the VB-id sanitizer below REASSIGNS this. The
        // 2026-08-26 template retirement (c0d594a75) turned it into a const and
        // every cover then threw "Assignment to constant variable" ten lines
        // later — before the model was ever called, so three covers failed
        // identically on every run with no usage, no genLog entry and an empty
        // coverImages {} (job_1787959478282 and the six runs before it).
        // COVER TITLE MODE — same resolver iterateCover uses, so first
        // generation and every later repaint agree about which mode this
        // environment is in. 'baked' (staging) appends the TITLE block to the
        // cover prompt, routes the render to the typography-aware model below,
        // and suppresses the app-side typography pass post-persist. Front cover
        // only; 'composited' (production) leaves this path unchanged.
        const { resolveCoverTitleMode } = require('./server/lib/coverTypography');
        // Title source: `streamingTitle` (unified parser's onTitle, arrives long
        // before covers) falling back to the finalized `title` — which beats
        // mode sets, and which is always initialized by the time covers start
        // (startCoverGeneration is only ever called after the story text). Do
        // NOT reach for `storyData` here: it is declared much later in this same
        // function, so touching it from this closure is a TDZ ReferenceError.
        const coverTitleModeInfo = resolveCoverTitleMode(
          coverType,
          streamingTitle || title || inputData.title || inputData.storyTitle || '',
          { modeOverride: modelOverrides.coverTitleMode || null }
        );
        if (coverTitleModeInfo.baked) {
          log.info(`🅰️ [STREAM-COVER] ${coverLabel}: BAKED title mode — "${coverTitleModeInfo.bakeTitle}" rendered into the artwork on ${coverTitleModeInfo.bakedModel}, typography composite skipped`);
        }
        let coverPrompt = buildCoverPrompt(
          coverType === 'frontCover' ? 'front' : 'back',
          {
            sceneDescription,
            inputData,
            characters: (inputData.characters || []).filter(c => coverPhotos.some(ph => ph.name === c.name)),
            visualBible: streamingVisualBible,
            referencePhotos: coverPhotos,
            options: {
              customStyleDescription: styleDescription,
              characterReferenceListOverride: characterRefList,
              // Empty unless baked mode is on; buildCoverPrompt appends the TITLE block.
              bakeTitle: coverTitleModeInfo.bakeTitle,
            },
          }
        );

        // Final chokepoint — same VB-id protection buildImagePrompt gives
        // pages. buildCoverSceneFromHint falls back to the bare id when a
        // character's `holds` references an id missing from hint.objects
        // ("holds the ART002"), and the image model paints unknown ids as
        // literal signs. Resolve or drop them before the prompt ships.
        {
          const { sanitizeVbIdsInPrompt } = require('./server/lib/storyHelpers');
          const coverPageNum = coverType === 'frontCover' ? -1 : coverType === 'initialPage' ? -2 : -3;
          coverPrompt = sanitizeVbIdsInPrompt(coverPrompt, streamingVisualBible, coverPageNum);
        }

        // Build cover references via the shared helper — same one iterate uses,
        // so v0 / iterate / legacy streaming all share one source of truth.
        const { buildCoverReferences } = require('./server/lib/coverIterate');
        const coverKeyForRefs = coverType === 'frontCover' ? 'frontCover' : coverType;
        // A rendered cover is always plated (use 'render', the default): a
        // landmark photo with no plate throws and this cover fails, instead of
        // the raw photo becoming the scene. singlePassScene does not apply.
        if (coverKeyForRefs === 'frontCover') {
          // Title-named creature/character missing from the Title Page objects: WARN ONLY.
          require('./server/lib/coverIterate').warnTitleNamedEntitiesMissingFromCover({
            title: streamingTitle || title || inputData.title || inputData.storyTitle || '',
            objects: hint?.objects, visualBible: streamingVisualBible, label: coverLabel,
          });
        }
        const coverRefs = await buildCoverReferences({
          coverKey: coverKeyForRefs,
          visualBible: streamingVisualBible,
          artStyle: inputData.artStyle,
          sceneDescription,
          coverHint: hint, // hint.objects carries LOC + ART IDs from the unified prompt
          sceneMetadata: coverExpandedMetadata, // pre-computed by scene expansion
          emptyScenePromptOverride: coverExpandedMetadata?.emptyScenePrompt || null,
          usageTracker: (usage, modelId) => {
            const isRunware = modelId?.startsWith('runware:');
            const isGrok = modelId?.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, usage, 'cover_images', modelId);
          },
          logLabel: coverLabel,
        });
        const coverLandmarkPhotos = coverRefs.landmarkPhotos;
        const coverVbGrid = coverRefs.visualBibleGrid;
        const coverSceneBackground = coverRefs.sceneBackground;
        const coverSceneMetadata = coverRefs.sceneMetadata;
        if (coverLandmarkPhotos.length > 0) {
          log.info(`🌍 [COVER] ${coverLabel} has ${coverLandmarkPhotos.length} landmark(s): ${coverLandmarkPhotos.map(l => `${l.name}${l.variantNumber > 1 ? ` (v${l.variantNumber})` : ''}`).join(', ')}`);
        }

        // One pipeline: covers generate exactly like pages — generation only,
        // no gen-time eval/bbox/retry. Scoring + detection happen once for
        // covers in the shared repair pipeline (Step 1 evaluateImageBatch +
        // Phase 5b-pre detection), same as every story page.
        const coverResult = await generateImageOnly(coverPrompt, coverPhotos, {
          // Baked title wins over the routed cover model: only the
          // typography-aware model renders legible lettering (the standard model
          // produces flat outline type and breaks the full-bleed rule). Same
          // precedence iterateCover applies.
          imageModelOverride: coverTitleModeInfo.bakedModel || coverImageModel,
          landmarkPhotos: coverLandmarkPhotos,
          visualBibleGrid: coverVbGrid,
          sceneBackground: coverSceneBackground,
          pageNumber: COVER_PAGE_NUMBERS[coverKeyForRefs],
          artStyle: inputData.artStyle || null,
          // Explicit aspect — covers must never rely on evaluationType inference.
          aspectRatio: MODEL_DEFAULTS.coverAspect,
          captureLabel: 'image_cover'
        });
        // Usage: same provider-style bucket the gen-time tracker used (cover_images).
        if (coverResult?.usage) {
          const m = coverResult.modelId || '';
          const provider = m.startsWith('runware:') ? 'runware' : m.startsWith('grok-imagine') ? 'grok' : 'gemini_image';
          addUsage(provider, coverResult.usage, 'cover_images', coverResult.modelId);
        }
        log.debug(`✅ [STREAM-COVER] ${coverLabel} generated (model: ${coverResult.modelId})`);

        // Save partial_cover checkpoint for progressive display. Score-less by
        // design: the score arrives with the pipeline eval, like pages.
        const coverKey = coverType === 'frontCover' ? 'frontCover' : coverType;
        const checkpointData = {
          type: coverKey,
          imageData: coverResult.imageData,
          description: sceneDescription,
          modelId: coverResult.modelId,
          // What this render ACTUALLY did — the partial-save salvage reads it so
          // its post-persist typography stamp never double-titles a baked cover.
          titleBaked: coverTitleModeInfo.baked
        };
        // Include title for frontCover so UI can transition to story display
        if (coverType === 'frontCover' && streamingTitle) {
          checkpointData.storyTitle = streamingTitle;
        }
        const checkpointIndex = coverType === 'frontCover' ? 0 : coverType === 'initialPage' ? 1 : 2;
        await saveImageCheckpoint(jobId, 'partial_cover', checkpointData, checkpointIndex, coverKey);
        log.debug(`💾 [UNIFIED] Saved ${coverKey} for progressive display`);

        return {
          type: coverType,
          imageData: coverResult.imageData,
          description: sceneDescription,
          // Exact sent text when the provider reports it (post-truncation /
          // post-sanitize), falling back to the built prompt — same as pages.
          prompt: coverResult.prompt || coverPrompt,
          // Post-shrink scene block when this cover's prompt went over the
          // model's cap — same field the page path stamps. Null when it fit.
          compressedScene: coverResult.compressedScene || null,
          referencePhotos: coverPhotos,
          landmarkPhotos: coverLandmarkPhotos,
          emptySceneImage: coverSceneBackground || null,
          modelId: coverResult.modelId,
          grokRefImages: coverResult.grokRefImages || null,
          // Records what this render ACTUALLY did, not what the flag says now:
          // the persistence gates (eval textMode, post-persist typography) read
          // it, so a mode flip mid-job can never double-title a cover.
          titleBaked: coverTitleModeInfo.baked
        };
      });

      // Attach a no-op catch to prevent unhandled rejection if cover fails before being awaited
      coverPromise.catch(err => log.warn(`⚠️ [STREAM-COVER] ${coverType} failed (will be handled when awaited): ${err.message}`));
      streamingCoverPromises.set(coverType, coverPromise);
      log.debug(`⚡ [STREAM-COVER] Started generation for ${coverType}`);
    };

    // Clothing requirements are the ONLY input styled-avatar generation needs,
    // and styled avatars are the long pole in front of cover + page images. So
    // this runs the moment they exist, whatever produced them:
    //  - unified: the progressive parser's onClothingRequirements callback,
    //    mid-stream (behaviour unchanged — this is a verbatim extraction).
    //  - beats:   generateStoryViaBeats calls it as soon as the story-bible
    //    stage returns, so avatars overlap scene expansion + page text instead
    //    of waiting for the whole pipeline.
    // Idempotent: the `!streamingAvatarStylingPromise` guard means a second
    // caller is a no-op, and the awaits downstream (line ~4870) are unchanged.
    // The used-category derivation for a set of characters, in one place: the
    // early kickoff and the post-correction re-render must ask for the SAME
    // buckets or the second one renders a different avatar than it replaces.
    const avatarRequirementsFor = (chars, requirements) => (chars || []).flatMap(char => {
      const charReqs = lookupByName(requirements, char.name, buildCastIndex({ characters: chars }, null))?.value;
      let usedCategories = charReqs
        ? Object.entries(charReqs)
            .filter(([cat, config]) => config?.used)
            .map(([cat, config]) => cat === 'costumed' && config?.costume
              ? `costumed:${config.costume.toLowerCase()}`
              : cat)
        : ['standard'];
      if (usedCategories.length === 0) usedCategories = ['standard'];
      return usedCategories.map(cat => ({
        pageNumber: 'pre-cover',
        clothingCategory: cat,
        characterNames: [char.name],
      }));
    });

    const onClothingRequirementsReady = (requirements) => {
        streamingClothingRequirements = requirements;
        // Bug #13 fix: Log completeness check for clothing requirements
        const reqCharCount = Object.keys(requirements).length;
        const expectedCharCount = (inputData.characters || []).length;
        if (reqCharCount < expectedCharCount) {
          log.warn(`⚠️ [STREAM] Clothing requirements incomplete: ${reqCharCount}/${expectedCharCount} characters`);
        } else {
          log.debug(`✅ [STREAM] Clothing requirements complete: ${reqCharCount}/${expectedCharCount} characters`);
        }

        // START AVATAR STYLING EARLY - we have everything we need now
        // This saves ~3min by running in parallel with story text generation
        // Realistic is no longer excluded: prepareStyledAvatars decides
        // per-category (skips unchanged outfits, redresses changed ones so
        // the reference avatar matches the story's clothing text).
        if (!inputData.trialMode && !skipImages && !streamingAvatarStylingPromise) {
          log.debug(`🎨 [STREAM] Starting early avatar styling (${reqCharCount} characters, ${artStyle} style)...`);
          streamingAvatarStylingPromise = (async () => {
            try {
              const basicRequirements = avatarRequirementsFor(inputData.characters || [], requirements);

              await prepareStyledAvatars(inputData.characters || [], artStyle, basicRequirements, requirements, addUsage, modelOverrides.storyAvatarModel || null, { skipQualityEval: !!inputData.trialMode, seasonOutfit: trialSeasonOutfit(inputData), finalPass: false }); // the coverage top-up below is the final pass
              earlyAvatarStylingSucceeded = getStyledAvatarCacheStats().size > 0;
              log.debug(`✅ [STREAM] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
            } catch (error) {
              log.warn(`⚠️ [STREAM] Early avatar styling failed: ${error.message}`);
            }
          })();
        }
    };

    // Progressive parser with callbacks for streaming updates AND parallel task initiation
    const progressiveParser = new ProgressiveUnifiedParser({
      onTitle: (title) => {
        streamingTitle = title;
        // Trial cover generation moved to onCoverScene (richer structured data from Claude)
      },
      onClothingRequirements: onClothingRequirementsReady,
      onVisualBible: (vb) => {
        streamingVisualBible = vb;
        // Filter main characters from Visual Bible
        filterMainCharactersFromVisualBible(streamingVisualBible, inputData.characters);
        // Initialize main characters from inputData.characters
        initializeVisualBibleMainCharacters(streamingVisualBible, inputData.characters);

        // Inject historical locations into the STREAMING VB so cover gen and
        // page gen (which both read streamingVisualBible, not the finalize-time
        // visualBible) can resolve LOC ids to the curated photo. Without this,
        // covers/pages logged "[LANDMARK-SCENE] matched but has no photos
        // (variants=0, fetchStatus=none)" — the entry was in the streaming VB
        // (added by Sonnet) but the photo bytes only landed on the finalize-time
        // visualBible at line 4023, which is a separate object.
        if (inputData.storyCategory === 'historical' && inputData.storyTopic) {
          const historicalLocations = getHistoricalLocations(inputData.storyTopic, { aspect: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect });
          if (historicalLocations?.length > 0) {
            injectHistoricalLocations(streamingVisualBible, historicalLocations);
            log.info(`📍 [STREAM] Injected ${historicalLocations.length} pre-fetched historical location(s) into streaming VB`);
          }
        }

        // Link pre-discovered landmarks and load photo variant descriptions
        // This must happen BEFORE scene expansion so variants are available in the prompt
        if (inputData.availableLandmarks?.length > 0) {
          linkPreDiscoveredLandmarks(streamingVisualBible, inputData.availableLandmarks);
        }
        // Start async loading of photo descriptions (scene expansion will wait for this)
        landmarkDescriptionsPromise = loadLandmarkPhotoDescriptions(streamingVisualBible);

        log.debug(`⚡ [STREAM] Visual Bible ready - scene expansions can now proceed`);

        // Trial only: kick off VB reference-sheet generation IN PARALLEL with
        // empty scenes + costumed avatar styling. The full-mode path also runs
        // generateReferenceSheet (server.js ~line 4443) but that fires AFTER
        // the unified Sonnet stream finalizes, by which point trial pages have
        // already rendered. Result: VB element refs (CHR / ART illustrations)
        // landed on the row but were never sent to Grok at page-render time —
        // wasted compute. Run it here, await it in startTrialPageImageGeneration
        // before reading element refs, and skip the post-finalize call below to
        // avoid duplicate work.
        if (inputData.trialMode && !skipImages && artStyle !== 'realistic') {
          const refSheetModel = MODEL_DEFAULTS.pageImage; // PIPE-7: was MODEL_DEFAULTS.image (nonexistent → undefined → wrong style variant)
          const refSheetBackend = IMAGE_MODELS[refSheetModel]?.backend || null;
          const styleDescriptionForRefs = resolveArtStyle(artStyle, refSheetBackend) || resolveArtStyle('pixar');
          trialReferenceSheetPromise = generateReferenceSheet(streamingVisualBible, styleDescriptionForRefs, {
            minAppearances: 2,
            // Every secondary character is in the visual bible with its own
            // reference even on a single page (owner 2026-07-26) — same rule in
            // trial as full mode; the maxElements cap below still bounds total refs.
            characterMinAppearances: 1,
            maxPerBatch: 4,
            // No cell render gate on the trial, by design (docs/decisions.md
            // 2026-10-09 "Trial reference sheets: no render gate"). A full story
            // keeps it.
            renderGate: false,
            maxElements: 6,  // trial cap — story-trial.txt limits to max 2 secondaries + 2 artifacts + 2 locations
            storyId: jobId,
            // See the full-mode call site for why: non-character elements
            // should match the page aspect, not avatarAspect.
            elementAspect: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
          }).catch(err => {
            log.warn(`⚠️ [TRIAL] Early VB reference sheet generation failed: ${err.message}`);
            return { generated: 0, failed: 0, elements: [] };
          });
          log.info(`📚 [TRIAL] Early VB reference-sheet generation started (parallel with empty scenes + costumed avatars); cell render gate skipped by design`);
        }

        // Trial: empty scene generation re-enabled per user. The scene
        // consistency it provides outweighs the ~25s latency on the 5-page
        // taste-test. KNOWN ISSUE (to address): the rendered empty scene
        // deviates too much from the passed landmark photo — needs prompt
        // review so the landmark identity is preserved into the plate.
        if (inputData.trialMode && vb.backgrounds?.length > 0) {
          log.info(`🎬 [TRIAL] Starting early empty scene generation from ${vb.backgrounds.length} visual bible backgrounds`);
          const artStyleDesc = resolveArtStyle(inputData.artStyle || 'watercolor') || '';
          const bgLimit = pLimit(5);
          const bgPromises = [];

          // Build pages→landmark-photo lookup once, so each bg can pull its
          // landmark for the empty-scene render. Without this, empty scenes
          // get generated WITHOUT the landmark and the page render inherits a
          // landmark-free background plate.
          // Resolve each landmark's photo the SAME way pages do
          // (resolveLandmarkPhotoForLocation, shared with
          // getLandmarkPhotosForScene). This used to gate on
          // `photoFetchStatus === 'success'`, which a variant-backed Swiss
          // landmark NEVER reaches — those are excluded from
          // prefetchLandmarkPhotos by its `!l.photoVariants?.length` filter and
          // keep 'pending_lazy' forever. So no plate was ever built for the
          // normal modern landmark, and the page then edited the RAW photograph
          // (packReferences promotes it when there is no scene background),
          // shipping a photographic page in a watercolour book. Measured on
          // prod job_1787647410717_5dvfqu8jg p1 and staging
          // job_1787696601288_bfgznq960: both 'pending_lazy', both zero plates.
          // Photo resolution is async, and this callback is deliberately sync
          // (making it async would leave an un-awaited promise on the stream
          // handler). So resolve ONCE PER LOCATION into a promise here and await
          // it inside the plate task that already runs async below — the scene
          // view and the rest of that reasoning now live in the helper's doc.
          // The per-location resolution lives in trialPlateLandmarkPromisesByPage
          // — and it AWAITS landmarkDescriptionsPromise first. Without that the
          // resolver's sync policy half decided on a location whose
          // photoVariants had not been loaded yet (the descriptions query was
          // only started one line above, at 2047), so every variant-backed Swiss
          // landmark resolved to null: the plate rendered with no photo and,
          // since 286086573 derives both from the same variable, with neither
          // the REFERENCE line nor the fidelity block. Measured on staging
          // job_1789337873076_qf2at21ui p6 (Kirche Rohrdorf, 3 variants): the
          // page row carried the photo, the plate prompt carried neither block.
          // The page path (line ~887) and the cover path (line ~1706) have
          // always awaited it before resolving landmark photos; this was the
          // one sibling that did not.
          const { buildLandmarkFidelityBlock, trialPlateLandmarkPromisesByPage } = require('./server/lib/storyHelpers');

          // ONE plate per `backgrounds[]` entry the writer declared, fanned out to
          // that entry's pages. It used to be one plate per LOCATION (the 2026-09-13
          // cost cut from one plate per page), which put every page of a story set
          // at one landmark on a single backdrop (18 of 43 stored staging trials) —
          // docs/decisions.md 2026-10-09 "Trial backgrounds". The writer is told to
          // declare exactly 3 distinct ones (story-trial.txt), so 3 plates, rendered
          // in parallel. Pages in no location still get their entry's plate.
          const { groupTrialPlatePagesByVantage } = require('./server/lib/sceneMetadata');
          const plateGroups = groupTrialPlatePagesByVantage(vb);
          // Each plate's landmark photo is its own entry's citation, else its
          // location's — so one landmark with several photos backs several plates.
          const landmarkPromiseByPage = trialPlateLandmarkPromisesByPage(vb, plateGroups, {
            descriptionsPromise: landmarkDescriptionsPromise,
          });

          log.info(`🎬 [TRIAL] ${plateGroups.length} plate(s) for ${plateGroups.reduce((n, g) => n + g.pages.length, 0)} page(s): ${plateGroups.map(g => `${g.vantageId || 'unassigned'}→p${g.pages.join(',')}`).join('; ')}`);
          for (const plateGroup of plateGroups) {
            const bg = { description: plateGroup.description, pages: plateGroup.pages };
            // Representative page — the one whose landmark, log line and prompt
            // page-number the shared plate inherits. Same choice the full-mode
            // vantage path makes (`group.pageNumbers[0]`).
            const pageNum = plateGroup.pages[0];
            // Pick the first landmark whose `pages` array overlaps this group's
            // pages — typically there's only one. Plumbing the photo into the
            // empty-scene render is the only way to anchor the building's
            // shape; the scene description alone doesn't carry visual identity.
            const bgLandmarkPromise = bg.pages.map(pn => landmarkPromiseByPage[pn]).find(Boolean)
              || Promise.resolve(null);
            {
              const platePromise = bgLimit(async () => {
                try {
                  const bgLandmark = await bgLandmarkPromise;
                  const emptySceneLandmarkPhotos = bgLandmark ? [bgLandmark] : [];
                  // Strong landmark-fidelity block — only included when a
                  // landmark is actually attached. Shared builder anchors the
                  // photo by NAME so Grok knows which building it's looking at
                  // and preserves its silhouette; '' when no landmark.
                  const landmarkFidelityBlock = buildLandmarkFidelityBlock(bgLandmark);
                  log.info(`🎬 [TRIAL] Empty scene ${plateGroup.vantageId || 'unassigned'} (pages ${bg.pages.join(',')}, rep p${pageNum}): ${bgLandmark ? `landmark "${bgLandmark.name}" variant ${bgLandmark.variantNumber ?? '?'} attached` : 'no landmark photo'}`);
                  const emptyPrompt = buildEmptyScenePrompt({
                    style: artStyleDesc,
                    description: bg.description,
                    landmarkFidelity: landmarkFidelityBlock,
                    // Tells the model what the attached reference IS
                    // (prompts.js REFERENCE line). Same expression the full /
                    // vantage path uses — 'landmark' when a photo is attached,
                    // otherwise null. No VB element grid is built on the trial
                    // plate call, so the 'element' arm of that expression has
                    // no counterpart here. Without this the trial plate got the
                    // landmark photo as pixels but no line saying the place in
                    // the scene IS that photo.
                    referenceKind: emptySceneLandmarkPhotos.length > 0 ? 'landmark' : null,
                    visualBible: streamingVisualBible,
                    pageNumber: pageNum,
                  });
                  const result = await generateImageOnly(emptyPrompt, [], {
                    // Plates stay on the Standard tier regardless of the page
                    // tier. Was implicit (no override → the pageImage default);
                    // pinned so it cannot drift with a page-tier change.
                    ...emptyScenePlateRouting(),
                    landmarkPhotos: emptySceneLandmarkPhotos,
                    skipCache: true,
                    // The plate IS the page's scene slot, and Grok edit inherits
                    // its input's aspect — a portrait plate under a square page
                    // came back portrait and got padded (white bars / mirrored
                    // blur). Same resolution the page render uses.
                    aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
                  });
                  if (result?.imageData) {
                    // grokRefImages = what packReferences actually packed into
                    // the plate call (the landmark photo, here). Same field
                    // name every other image call in the pipeline stores its
                    // packed refs under; carried onto the page row below as
                    // emptySceneGrokRefImages so the plate call leaves a trace.
                    // Fan out the same canvas to every page in the group — same
                    // shape (and same per-page trace fields) the full-mode
                    // vantage fan-out writes. vantageId is null for a page that
                    // resolved to no LOC, exactly as the vantage path leaves it.
                    for (const pn of bg.pages) {
                      sceneBackgrounds[pn] = {
                        imageData: result.imageData,
                        prompt: emptyPrompt,
                        grokRefImages: result.grokRefImages || null,
                        vantageId: plateGroup.vantageId || null,
                      };
                    }
                    log.info(`🎬 [TRIAL] Empty scene for pages ${bg.pages.join(',')} generated from 1 plate (${Math.round(result.imageData.length / 1024)}KB)`);
                    if (result.usage) {
                      const isGrok = result.modelId?.startsWith('grok-imagine');
                      addUsage(isGrok ? 'grok' : 'gemini_image', result.usage, 'trial_empty_scene', result.modelId);
                    }
                  }
                } catch (err) {
                  log.warn(`⚠️ [TRIAL] Empty scene for pages ${bg.pages.join(',')} failed: ${err.message}`);
                }
              });
              // Registered BEFORE any page streams, so the page render can await
              // its own plate instead of racing it. Never rejects (the task
              // swallows its own errors), so an await here cannot break a page.
              // Every page in the group awaits the SAME promise — the one render
              // that fills all their slots.
              for (const pn of bg.pages) trialEmptyScenePromises.set(pn, platePromise);
              const plateLocId = String(plateGroup.vantageId || '').match(/^LOC\d+/i)?.[0]?.toUpperCase();
              if (plateLocId && !trialPlatesByLoc.has(plateLocId)) {
                trialPlatesByLoc.set(plateLocId, { promise: platePromise, page: pageNum });
              }
              bgPromises.push(platePromise);
            }
          }
          // Don't await — let them run in background while outline continues streaming
          Promise.all(bgPromises).then(() => {
            log.info(`🎬 [TRIAL] All ${Object.keys(sceneBackgrounds).length} empty scenes ready`);
          }).catch(() => {});
        }
      },
      onCoverScene: (coverData) => {
        // TRIAL ONLY: the trial front cover renders from the writer's streamed
        // cover JSON (fast, owner 2026-09-24). A full story's covers are pages.
        if (!inputData.trialMode) {
          throw new Error('[COVER] onCoverScene is the trial cover builder — a full-story cover is a page');
        }
        if (streamingCoverPromises.has('frontCover') || skipImages || skipCovers) return;

        const coverTitle = coverData.title || streamingTitle || 'My Story';
        const coverScene = coverData.scene || coverData;

        const coverPromise = (async () => {
          try {
            // Wait for prerequisites: visual bible + avatar styling (cap at 5 minutes)
            let vbWait = 0;
            while (!streamingVisualBible && vbWait < 3000) {
              await new Promise(r => setTimeout(r, 100));
              vbWait++;
            }
            if (!streamingVisualBible) {
              log.warn('[TRIAL-COVER] Timed out waiting for Visual Bible — skipping cover');
              return null;
            }
            if (streamingAvatarStylingPromise) {
              log.debug(`[TRIAL-COVER] Waiting for avatar styling...`);
              await streamingAvatarStylingPromise;
            }
            // The cover shows VB elements (a held toy, a pet) and must render
            // with their reference cells exactly as the trial pages do (they
            // await this same promise before building their grid). Without the
            // wait the cover was drawn before the sheet existed: the name
            // invariant below saw "no reference image" and the grid was empty
            // (job_1791500208126_at0wow7xa: a toy owl drawn as a live bird;
            // job_1791500011394_yvjd5robo: the parrot lost its forehead patch).
            // The sheet is one parallel batch started in onVisualBible, so the
            // wait is the remainder of that batch (~40 s in those logs). A
            // failed sheet already logged in its own catch; the cover then
            // renders without cells, as the pages do. docs/decisions.md 2026-10-09.
            if (trialReferenceSheetPromise) {
              await trialReferenceSheetPromise;
            }

            // Build scene description from the cover hint JSON
            // `let`: the cover NAME invariant may strip an unsendable entity
            // name from this blob (token-mode strip — JSON-safe).
            let sceneDescription = '```json\n' + JSON.stringify(coverScene, null, 2) + '\n```';

            // Determine which characters appear in the cover scene
            let coverCharacters = [];
            if (coverScene.characters?.length > 0) {
              const coverCastIndex = buildCastIndex({ characters: inputData.characters || [] }, null);
              const named = new Set(coverScene.characters.map(c => resolveEntity(c && c.name, coverCastIndex)).filter(Boolean).map(e => e.entry));
              coverCharacters = (inputData.characters || []).filter(c => named.has(c));
            }
            if (coverCharacters.length === 0) {
              coverCharacters = (inputData.characters || []).filter(c => c.isMainCharacter === true);
            }
            if (coverCharacters.length === 0) {
              coverCharacters = (inputData.characters || []).slice(0, 3);
            }

            // Build per-character clothing requirements
            const coverClothingReqs = { ...(inputData._trialClothingRequirements || {}) };
            if (coverScene.characters?.length > 0) {
              for (const sc of coverScene.characters) {
                if (sc.name && sc.clothing) {
                  coverClothingReqs[sc.name] = {
                    ...(resolveCharacterReqs(coverClothingReqs, sc.name) || {}),
                    _currentClothing: sc.clothing
                  };
                }
              }
            }
            // Fallback: apply trial costume type for characters without explicit clothing.
            // Clone the entry before assigning so we don't pollute inputData._trialClothingRequirements.
            if (inputData._trialCostumeType) {
              for (const char of coverCharacters) {
                if (!resolveCharacterReqs(coverClothingReqs, char.name)?._currentClothing) {
                  coverClothingReqs[char.name] = {
                    ...(resolveCharacterReqs(coverClothingReqs, char.name) || {}),
                    _currentClothing: 'costumed'
                  };
                }
              }
            }

            // Get character photos with styled avatars
            let coverPhotos = getCharacterPhotoDetails(coverCharacters, 'standard', artStyle, coverClothingReqs);
            coverPhotos = applyStyledAvatars(coverPhotos, artStyle);
            // COSTUME OR FAIL — same rule as the streamed trial page.
            {
              const bare = missingCostumedRefs(coverPhotos);
              if (bare.length > 0) {
                log.error(`❌ [TRIAL-COVER] frontCover: costumed sheet missing for ${bare.join(', ')} — cover not rendered on the standard avatar`);
                throw new Error(`frontCover: costumed sheet missing for ${bare.join(', ')}`);
              }
            }

            // Build prompt components
            const pageImageModel = MODEL_DEFAULTS.simplePageImage;
            const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
            const styleDescription = resolveArtStyle(artStyle, pageImageBackend) || resolveArtStyle('pixar');
            const characterRefList = buildCharacterReferenceList(coverPhotos, inputData.characters, { includeClothing: true })
              + buildReferenceCardColours(
                  (inputData.characters || []).filter(c => coverPhotos.some(ph => ph.name === c.name)),
                  coverPhotos
                );
            // The cover's declared element ids (its JSON objects[]), the input
            // to the cover NAME invariant below.
            const trialCoverIds = (coverScene.objects || [])
              .map(obj => typeof obj === 'string' ? obj.match(/((?:ART|ANI|VEH|CHR|LOC)\d+)/i)?.[1]?.toUpperCase() : (obj?.id ? String(obj.id).toUpperCase() : null))
              .filter(Boolean);
            // COVER NAME INVARIANT — same helper as the full-account cover
            // paths: an entity named in the trial cover's description is
            // fully sent or its name is stripped.
            const { reconcileCoverSceneEntities: reconcileTrialCoverEntities } = require('./server/lib/coverIterate');
            const trialNameFix = reconcileTrialCoverEntities({
              sceneDescription,
              visualBible: streamingVisualBible,
              elementIds: trialCoverIds.length > 0 ? trialCoverIds : null,
              label: 'TRIAL FRONT COVER',
              stripMode: 'token', // the trial cover description is a JSON blob
            });
            // An entity the invariant injected (named in the prose, fully
            // sendable) joins the JSON objects[], so REQUIRED OBJECTS lists it
            // exactly as a trial page's brief would.
            sceneDescription = require('./server/lib/coverIterate').withTrialCoverObjects(
              trialNameFix.sceneDescription, (trialNameFix.injected || []).map(h => h.id));
            // Title-named creature/character missing from objects: WARN ONLY.
            require('./server/lib/coverIterate').warnTitleNamedEntitiesMissingFromCover({
              title: coverTitle, objects: coverScene.objects, visualBible: streamingVisualBible, label: 'TRIAL FRONT COVER',
            });

            // Textless when covers are typeset app-side — same rule the
            // full-account cover path applies (line ~1480). This path ignored
            // the flag, so the model painted the title into the art AND
            // bakeCoverTypographyPostPersist stamped a second one over it
            // (job_1786815617426: two titles on the trial cover).
            // Same builder as pages and as every other cover path.
            // COVER TITLE MODE — same resolver as the full-account cover path
            // and iterateCover. In 'baked' mode (staging) the trial's front
            // cover also renders its title in one typography-aware call and
            // skips the app-side stamp; 'composited' leaves this unchanged.
            const { resolveCoverTitleMode: resolveTrialCoverTitleMode } = require('./server/lib/coverTypography');
            const trialCoverTitleMode = resolveTrialCoverTitleMode(
              'frontCover', coverTitle, { modeOverride: modelOverrides.coverTitleMode || null }
            );
            if (trialCoverTitleMode.baked) {
              log.info(`[TRIAL-COVER] BAKED title mode — "${trialCoverTitleMode.bakeTitle}" rendered into the artwork on ${trialCoverTitleMode.bakedModel}, typography composite skipped`);
            }
            let coverPrompt = buildCoverPrompt('front', {
              sceneDescription,
              inputData,
              characters: (inputData.characters || []).filter(c => coverPhotos.some(ph => ph.name === c.name)),
              visualBible: streamingVisualBible,
              referencePhotos: coverPhotos,
              options: {
                customStyleDescription: styleDescription,
                characterReferenceListOverride: characterRefList,
                // Empty unless baked mode is on; buildCoverPrompt appends the TITLE block.
                bakeTitle: trialCoverTitleMode.bakeTitle,
              },
            });

            // Final chokepoint — same VB-id protection the full-account cover
            // path applies (streaming cover + coverIterate). The code-fenced
            // cover-hint JSON above carries raw ART/CHR ids that the image
            // model paints as literal signs.
            {
              const { sanitizeVbIdsInPrompt } = require('./server/lib/storyHelpers');
              coverPrompt = sanitizeVbIdsInPrompt(coverPrompt, streamingVisualBible, -1);
            }

            // Build metadata directly — extractSceneMetadata can't parse our code-fenced JSON
            const sceneMetadata = {
              objects: coverScene.objects || [],
              fullData: coverScene,
              characters: coverScene.characters || [],
              setting: coverScene.setting || null,
            };
            // Landmark photos, people-free plate and VB grid come from the SAME
            // helper every full-account cover uses. The plate is the one the
            // trial pages already rendered for this location when there is one
            // (no extra call); otherwise the helper renders a cover plate from
            // the setting alone. A landmark photo never reaches this render
            // as its scene anchor: with no plate the helper throws — packReferences would promote it
            // and the cover became an edit of the photograph, strangers
            // included (prod job_1790169018278_n57xpnufo).
            const {
              buildCoverReferences: buildTrialCoverReferences,
              trialCoverLocationId,
              trialCoverPlateDescription,
            } = require('./server/lib/coverIterate');
            const coverLocId = trialCoverLocationId(coverScene);
            const pagePlate = coverLocId ? trialPlatesByLoc.get(coverLocId) : null;
            let reusedPlate = null;
            if (pagePlate) {
              await pagePlate.promise;
              reusedPlate = sceneBackgrounds[pagePlate.page]?.imageData || null;
              log.info(`🎬 [TRIAL-COVER] ${coverLocId}: ${reusedPlate ? `reusing the page ${pagePlate.page} plate` : `page ${pagePlate.page} plate unavailable — rendering a cover plate`}`);
            }
            const coverRefs = await buildTrialCoverReferences({
              coverKey: 'frontCover',
              visualBible: streamingVisualBible,
              artStyle,
              sceneDescription,
              coverHint: {
                objects: trialCoverIds,
                characters: coverCharacters.map(c => c.name).filter(Boolean),
              },
              sceneMetadata,
              emptyScenePromptOverride: trialCoverPlateDescription(coverScene),
              sceneBackground: reusedPlate,
              usageTracker: (usage, modelId) => {
                const isGrok = modelId?.startsWith('grok-imagine');
                addUsage(isGrok ? 'grok' : 'gemini_image', usage, 'trial_empty_scene', modelId);
              },
              logLabel: 'TRIAL FRONT COVER',
            });
            const coverLandmarkPhotos = coverRefs.landmarkPhotos;
            const coverVbGrid = coverRefs.visualBibleGrid;
            const coverSceneBackground = coverRefs.sceneBackground;

            log.info(`[TRIAL-COVER] Starting title page generation (title: "${coverTitle}", ${coverCharacters.length} chars, ${coverLandmarkPhotos.length} landmarks${coverSceneBackground ? ', plate' : ''}${coverVbGrid ? ', VB grid' : ''})`);
            const startTime = Date.now();

            // Generate the image using simplePageImage model (same as trial pages)
            const result = await generateImageOnly(coverPrompt, coverPhotos, {
              // Baked title wins over the page-tier model, and the backend is
              // left to the registry so it cannot disagree with that model.
              imageModelOverride: trialCoverTitleMode.bakedModel || pageImageModel,
              ...(trialCoverTitleMode.baked ? {} : { imageBackendOverride: pageImageBackend }),
              landmarkPhotos: coverLandmarkPhotos,
              visualBibleGrid: coverVbGrid,
              sceneBackground: coverSceneBackground,
              aspectRatio: MODEL_DEFAULTS.coverAspect,
              pageNumber: -1
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info(`[TRIAL-COVER] Title page image ready in ${elapsed}s`);

            // Track usage
            if (result.usage) {
              const isGrok = result.modelId?.startsWith('grok-imagine');
              const provider = isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, result.usage, 'cover_images', result.modelId);
            }

            // Save checkpoint for progressive display
            if (result.imageData) {
              await saveImageCheckpoint(jobId, 'partial_cover', {
                type: 'frontCover',
                imageData: result.imageData,
                storyTitle: coverTitle,
                titleBaked: trialCoverTitleMode.baked
              }, 0, 'frontCover');
              log.debug(`[TRIAL-COVER] Saved partial_cover checkpoint`);
            }

            return {
              type: 'frontCover',
              imageData: result.imageData,
              description: sceneDescription,
              // Sent text, not the build — same fix as the streaming cover.
              prompt: result.prompt || coverPrompt,
              // Post-shrink scene block when this cover's prompt went over the
              // model's cap — same field the page path stamps. Null when it fit.
              compressedScene: result.compressedScene || null,
              modelId: result.modelId,
              referencePhotos: coverPhotos,
              landmarkPhotos: coverLandmarkPhotos,
              emptySceneImage: coverSceneBackground || null,
              grokRefImages: result.grokRefImages || null,
              titleBaked: trialCoverTitleMode.baked
            };
          } catch (err) {
            // Rethrown: the cover-await allSettled logs it and writes it to the
            // stored genLog (cover_failed) — a swallowed null left no record.
            log.error(`[TRIAL-COVER] Title page generation failed: ${err.message}`);
            throw err;
          }
        })();

        coverPromise.catch(err => log.warn(`[TRIAL-COVER] Promise failed (will be handled when awaited): ${err.message}`));
        streamingCoverPromises.set('frontCover', coverPromise);
        log.info(`[TRIAL-COVER] Started cover generation from streaming cover scene`);
      },
      onCoverHints: () => {
        // Cover hints section complete - we'll start covers when we have individual hints
        // The parser doesn't provide individual hints in the callback, so we'll handle this differently
      },
      onPageComplete: (page) => {
        streamingPagesDetected = Math.max(streamingPagesDetected, page.pageNumber);
        genLog.info('page_streamed', `Page ${page.pageNumber} parsed from stream`, null, { pageNumber: page.pageNumber, textLength: page.text?.length || 0 });
        // Store page data for scene expansion
        streamingExpandedPages.set(page.pageNumber, page);
        if (inputData.trialMode) {
          // Trial mode: kick off page image generation immediately (parallel with rest of stream)
          startTrialPageImageGeneration(page);
        } else {
          // Normal mode: scene expansion (image gen happens in Phase 5a)
          startSceneExpansion(page);
        }
      },
      onProgress: async (type, message, pageNum) => {
        // Rate limit progress updates (max once per 500ms)
        const now = Date.now();
        if (now - lastProgressUpdate < 500) return;
        lastProgressUpdate = now;

        // Calculate progress based on parallel work happening
        // Checkpoints numbered by ARRIVAL ORDER (not logical order)
        // Streaming: arcs → title → clothing → plot → VB → covers → pages
        // 1=start, 2=arcs, 3=title, 4=clothing, 5=plot, 6=VB, 7=covers/pages
        // 8=text done, 9=avatars, 10=scenes, 11-30=images, 31+=repair, 73=finalize, 100=done
        const progress = streamingProgressFor(type);
        if (progress === null) {
          log.warn(`[PROGRESS] Unknown streaming progress type "${type}" — progress not written (add it to STREAMING_PROGRESS)`);
          return;
        }

        // Enhance message to show parallel work
        let enhancedMessage = message;
        const scenesInProgress = streamingSceneExpansionPromises.size;
        if (scenesInProgress > 0) {
          enhancedMessage = `${message} (${scenesInProgress} scenes in progress)`;
        }

        try {
          await dbPool.query(
            'UPDATE story_jobs SET progress = GREATEST(progress, $1), progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progress, enhancedMessage, jobId]
          );
        } catch (e) {
          // Ignore progress update errors
        }
      }
    }, { isTrial: !!inputData.trialMode });

    // Use streaming with progressive parsing and parallel task initiation
    // Use 64000 tokens to match Claude Sonnet's max output capacity for longer stories
    timing.storyGenStart = Date.now();
    // Heartbeat keeps story_jobs.updated_at fresh during the unified Sonnet
    // streaming phase. Without it, the status endpoint's 5-min stale check
    // would mark the job as failed mid-stream when the frontend polls — even
    // though the backend is happily streaming text. Long stories can take
    // 15+ minutes for the Sonnet response alone.
    const unifiedHeartbeat = createJobHeartbeat(jobId, dbPool);
    // WALL-CLOCK heartbeat for the whole text phase. The per-chunk heartbeat
    // only fires once tokens arrive: a provider that queues a request for 10+
    // minutes (two stories competing for the same model) emits nothing, so
    // updated_at goes stale and the status route's 10-minute watchdog fails a
    // perfectly healthy job mid-call (job_1786916653164, killed at 2% during
    // beats planning). The image phase already guards this way; the text phase
    // — the longest in the run — did not.
    // The same interval also INTERPOLATES the bar between stage checkpoints.
    // Stages here are single LLM calls of 25s-220s; without interpolation the
    // percent freezes on one number for minutes (measured: 6% held for 15 of a
    // 25-minute run). `textStage` is set by onStage below and carries the
    // measured budget for the running stage; progress eases toward the next
    // checkpoint and never passes it, so a slow stage stalls at the boundary
    // rather than lying about being finished.
    let textStage = null;
    const textPhaseHeartbeat = setInterval(() => {
      let sql = 'UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = $2';
      let params = [jobId, 'processing'];
      if (textStage && textStage.next > textStage.pct && textStage.ms > 0) {
        const frac = Math.min(1, (Date.now() - textStage.startedAt) / textStage.ms);
        const eased = Math.floor(textStage.pct + (textStage.next - textStage.pct) * frac);
        if (eased > textStage.pct) {
          sql = 'UPDATE story_jobs SET progress = GREATEST(progress, $3), updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = $2';
          params = [jobId, 'processing', eased];
        }
      }
      dbPool.query(sql, params)
        .catch(err => log.debug(`[HEARTBEAT] text phase job ${jobId}: ${err.message}`));
    }, 20000);
    let unifiedResponse;
    let unifiedModelId;
    let unifiedUsage;
    // beatsResult carries the parsed pages + already-expanded scenes when the
    // beats pipeline ran; null on the unified path.
    let beatsResult = null;
    // One writer invocation via the beats pipeline. Also the retry unit for the
    // hard landmark minimum below: a re-run repeats the paid text stages, so it
    // runs at most twice per job. Safe to call again — onClothingRequirementsReady
    // is idempotent (see its declaration), so avatars never double-start.
    const runBeatsWriter = async (writerOpts = {}) => {
      beatsResult = await generateStoryViaBeats(inputData, {
        jobId,
        genLog,
        checkCancellation,
        // Landmark guideline seam: attempt 1 passes a hook that aborts at the
        // bible stage on a shortfall, so the retry never burns the scene-brief
        // and page-text stages (see the landmark check below).
        onVisualBible: writerOpts.onVisualBible || null,
        pageCount: sceneCount,
        modelOverrides,
        heartbeat: unifiedHeartbeat,
        // Styled avatars are the long pole in front of every image. In beats
        // mode their only input (clothingRequirements) exists the moment the
        // story-bible stage returns — long before scene briefs or page text —
        // so kick them off there instead of after the whole pipeline. Same
        // trigger the unified stream uses; the awaits downstream are unchanged.
        onClothingRequirements: onClothingRequirementsReady,
        // Per-stage progress (2-7%): without it the bar sits at 1% for the
        // whole ~10-minute text phase; heartbeat never moves the percent.
        onStage: async (pct, msg, hint = null) => {
          // Record the running stage so the heartbeat can ease the bar toward
          // the next checkpoint while this call is in flight.
          textStage = hint ? { pct, next: hint.next ?? pct, ms: hint.ms ?? 0, startedAt: Date.now() } : null;
          try {
            await dbPool.query(
              'UPDATE story_jobs SET progress = GREATEST(progress, $1), progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [pct, msg, jobId]
            );
          } catch { /* progress only */ }
        },
      });
      // The beats transcript stands in for the raw writer response: it is what
      // data.outline stores and what the dev outline view renders.
      unifiedResponse = beatsResult.rawOutline;
      unifiedModelId = beatsResult.meta?.textModelId || modelOverrides.outlineModel;
      unifiedUsage = { input_tokens: 0, output_tokens: 0 };
    };

    // ── Landmark guideline (owner rulings 2026-09-04 / 2026-09-05) ──
    // When the reader's location is the BINDING setting (premiseNamedWorld=false)
    // and real landmarks were offered, the story should build in at least two of
    // them. Two is a strong guideline, NOT an iron rule: a shortfall retries the
    // writer ONCE with the failure fed back into the landmark section of its
    // prompts (a blind retry made the same choice again — dragon run
    // job_1788599801317_644e65uob staged 1 twice); a second shortfall SHIPS the
    // story with a loud warn and `landmarkMinimumShortfall` on the story data,
    // never fails the job. The attempt-1 check runs at the bible stage via
    // onVisualBible — the staging is fully knowable there (beats order:
    // arc → beats → bible → briefs → page text), so aborting saves the
    // scene-brief and page-text stages (~20 of ~30 min per attempt).
    // Beats mode only: the streaming path (trials) launches scene expansions
    // mid-stream, so a post-hoc rewrite could not retract them.
    let landmarkMinimumShortfall = null;
    const stagedRealLandmarks = (vb) =>
      ((vb || {}).locations || []).filter(l => l.isRealLandmark && (l.appearsInPages || []).length > 0);
    const describeStaged = (staged) => staged.length
      ? staged.map(l => `"${l.landmarkQuery || l.name}"`).join(', ')
      : 'none';
    const runBeatsWriterWithLandmarkGuideline = async () => {
      const guidelineActive = inputData.premiseNamedWorld === false && (inputData.availableLandmarks?.length || 0) > 0;
      if (!guidelineActive) { await runBeatsWriter(); return; }
      const offeredNames = inputData.availableLandmarks.map(l => l.name);
      class LandmarkShortfallAbort extends Error {}
      try {
        await runBeatsWriter({
          onVisualBible: async (vb) => {
            const staged = stagedRealLandmarks(vb);
            if (staged.length < 2) {
              const e = new LandmarkShortfallAbort(`staged ${staged.length}`);
              e.staged = staged;
              throw e;
            }
          },
        });
        return;
      } catch (err) {
        if (!(err instanceof LandmarkShortfallAbort)) throw err;
        const staged = err.staged || [];
        log.error(`🚨 [LANDMARK-MIN] Binding location offered ${offeredNames.length} landmark(s) but the bible staged only ${staged.length} (${describeStaged(staged)}; offered e.g. ${offeredNames.slice(0, 5).join(', ')}) — retrying the writer once with feedback`);
        genLog.warn('landmark_minimum', `Story staged ${staged.length} real landmark(s) (${describeStaged(staged)}); the binding location asks for at least 2 — retrying the writer with feedback`);
      }
      await checkCancellation();
      // Generic wording only — rides into the REAL LANDMARKS section of the
      // arc/beats/bible prompts via buildAvailableLandmarksSection.
      inputData.landmarkRetryNote = 'A previous attempt staged too few real landmarks from this list. Stage at least two, woven into the story\'s action.';
      try {
        await runBeatsWriter();  // no early abort: strike two ships
      } finally {
        delete inputData.landmarkRetryNote;
      }
    };
    try {
    if (beatsMode) {
      await runBeatsWriterWithLandmarkGuideline();
    } else {
      // Trial only (resolvePipelineMode returns 'unified' for trialMode alone).
      if (!unifiedPrompt) throw new Error('No writer prompt: a non-trial job reached the single-call branch');
      const unifiedResult = await callTextModelStreaming(unifiedPrompt, null, (chunk, fullText) => {
        progressiveParser.processChunk(chunk, fullText);
        unifiedHeartbeat();  // throttled — fires at most every 30s
      // The trial writer has its own effort (MODEL_DEFAULTS.trialStoryEffort): the
      // trial's product requirement is speed, and at the model default (`high`)
      // most of its output is thinking (decisions.md 2026-10-07).
      }, modelOverrides.outlineModel, { usageLabel: 'unified_story', effort: MODEL_DEFAULTS.trialStoryEffort });
      unifiedResponse = unifiedResult.text;
      unifiedModelId = unifiedResult.modelId;
      unifiedUsage = unifiedResult.usage || { input_tokens: 0, output_tokens: 0 };
    }
    } finally {
      clearInterval(textPhaseHeartbeat);
    }
    timing.storyGenEnd = Date.now();
    // Determine provider from model ID since streaming doesn't return provider
    const isGeminiModel = unifiedModelId?.startsWith('gemini') || false;
    const unifiedProvider = isGeminiModel ? 'gemini_text' : 'anthropic';
    log.debug(`📊 [UNIFIED] Story usage - model: ${unifiedModelId}, provider: ${unifiedProvider}, input: ${unifiedUsage.input_tokens}, output: ${unifiedUsage.output_tokens}`);
    // Usage recorded by the callTextModelStreaming chokepoint (usageLabel above).
    log.debug(`⏱️ [UNIFIED] Story generation: ${((timing.storyGenEnd - timing.storyGenStart) / 1000).toFixed(1)}s`);

    // ── Landmark guideline: final count on the shipped transcript ──
    // Counts VB locations with isRealLandmark and a non-empty page list (the
    // parser already drops real-landmark entries staged on no page). A
    // shortfall here NEVER fails the job (owner ruling 2026-09-05: "2 is a
    // strong guideline, not an iron rule") — it warns loudly, naming the
    // staged and offered landmarks, and stamps `landmarkMinimumShortfall` on
    // the story data so the shortfall is visible in rating. Read it with
    // `scripts/analysis/shipped-defects.js`.
    if (beatsMode && inputData.premiseNamedWorld === false && (inputData.availableLandmarks?.length || 0) > 0) {
      const staged = stagedRealLandmarks(new UnifiedStoryParser(unifiedResponse).extractVisualBible());
      if (staged.length >= 2) {
        log.info(`✅ [LANDMARK-MIN] Story staged ${staged.length} real landmark(s): ${describeStaged(staged)}`);
      } else {
        landmarkMinimumShortfall = staged.length;
        const offeredNames = inputData.availableLandmarks.map(l => l.name);
        log.warn(`⚠️ [LANDMARK-MIN] Story ships BELOW the landmark guideline: staged ${staged.length} (${describeStaged(staged)}) of minimum 2; offered ${offeredNames.length} (e.g. ${offeredNames.slice(0, 5).join(', ')})`);
        genLog.warn('landmark_minimum_shortfall', `Story ships with ${staged.length} real landmark(s) (${describeStaged(staged)}) — below the guideline of 2 after one fed-back writer retry`);
      }
    }

    // ── Split outline review (cross-model: writer drafted, reviewer critiques) ──
    // With MODEL_DEFAULTS.splitOutlineReview ON, call 1 (writer) skipped its
    // self-critique (ANALYSIS stub, no FIXES REQUIRED, bare ---STORY PAGES---
    // marker). A second model now receives the writer's full output + the same
    // analysis instructions and emits ---ANALYSIS--- + FIXES REQUIRED +
    // ---STORY PAGES--- patches. The CONCATENATION (writer + reviewer output)
    // is what the unchanged parsers consume. Streaming note: the progressive
    // parser consumed call 1's stream as usual (title/clothing/VB/cover hints
    // fired live); page emission waits for the review because the FIXES
    // REQUIRED list decides which pages are draft-final vs patched — the
    // reviewer output is handed to the progressive parser in ONE final chunk
    // (feeding it incrementally would let the parser lock onto a half-streamed
    // FIXES REQUIRED list and mis-classify still-unpatched pages as final).
    // Failure containment: reviewer failure after 1 retry → proceed with the
    // UNPATCHED draft + loud warning + generationLog event. Never blocks.
    // Per-job override first (rerun-text harness A/B seam via inputOverrides:
    // { splitOutlineReview: false }) — MUST mirror the buildUnifiedStoryPrompt
    // resolution so the writer's stub and the review call always agree.
    const splitOutlineReviewEnabled = inputData.splitOutlineReview !== undefined
      ? !!inputData.splitOutlineReview
      : !!MODEL_DEFAULTS.splitOutlineReview;
    // Review metadata persisted onto storyData/resultData so the dev outline
    // view can show WHO reviewed, how long it took, and how many fixes the
    // reviewer demanded. The reviewer's full text itself is appended to
    // unifiedResponse — which is what data.outline stores (see the storyData
    // assembly), so the Opus ANALYSIS is visible in the dev outline view.
    // Beats mode: the beats review + the scene review already ran inside
    // generateStoryViaBeats and replace this single outline critique.
    let outlineReviewMeta = null;
    if (!beatsMode && !inputData.trialMode && splitOutlineReviewEnabled) {
      await checkCancellation();
      const reviewModel = modelOverrides.outlineReviewModel || MODEL_DEFAULTS.outlineReviewModel;
      timing.outlineReviewStart = Date.now();

      // Deterministic scene-consistency pre-check on the draft → REVIEW HINTS
      // (mechanical string/set facts only; semantic verdicts are the reviewer's).
      let draftConsistencyIssues = [];
      try {
        const draftPages = new UnifiedStoryParser(unifiedResponse).extractPages();
        draftConsistencyIssues = checkSceneConsistency(draftPages, unifiedResponse, {
          knownCharacterNames: (inputData.characters || []).map(c => c.name),
          // No Visual Bible exists yet at the draft stage: the cast alone.
          castIndex: buildCastIndex({ characters: inputData.characters || [] }, null)
        });
        for (const line of formatSceneConsistencySummary(draftConsistencyIssues)) log.info(`${line} (pre-review draft)`);
      } catch (preErr) {
        log.warn(`⚠️ [OUTLINE-REVIEW] draft consistency pre-check failed (non-fatal): ${preErr.message}`);
      }

      const reviewPrompt = buildOutlineReviewPrompt(inputData, unifiedResponse, draftConsistencyIssues);
      if (!reviewPrompt) {
        log.warn('⚠️ [OUTLINE-REVIEW] review template unavailable — proceeding with UNPATCHED draft (no external critique ran)');
        genLog.warn('outline_review_failed', 'Review template unavailable — story shipped as unpatched draft');
      } else {
        log.info(`🧐 [OUTLINE-REVIEW] model=${reviewModel} split=true promptChars=${reviewPrompt.length} hints=${draftConsistencyIssues.reduce((n, e) => n + e.issues.length, 0)}`);
        let reviewText = null;
        let reviewModelId = null;
        for (let attempt = 1; attempt <= 2 && !reviewText; attempt++) {
          try {
            const reviewResult = await callTextModelStreaming(reviewPrompt, null, () => {
              unifiedHeartbeat(); // keep story_jobs.updated_at fresh during the review
            }, reviewModel, { usageLabel: 'outline_review' });
            const t = reviewResult.text || '';
            // A review cut at the ceiling carries a partial FIXES REQUIRED list
            // and no closing section — a failed attempt, never a shorter review
            // (textReplyGuard.js). The retry loop runs once more, then the
            // draft ships unpatched, exactly as on a shape failure.
            if (reviewResult.truncation?.suspected) {
              log.warn(`⚠️ [OUTLINE-REVIEW] attempt ${attempt}: reviewer reply ${require('./server/lib/textModels').describeTruncation(reviewResult.truncation)} — ${attempt < 2 ? 'retrying' : 'giving up'}`);
              continue;
            }
            // Minimal shape gate: without these markers the concatenation would
            // confuse the parsers — treat as a failed attempt.
            if (/---\s*ANALYSIS\s*---/i.test(t) && /FIXES\s+REQUIRED/i.test(t)) {
              reviewText = t;
              reviewModelId = reviewResult.modelId || reviewModel;
              log.info(`✅ [OUTLINE-REVIEW] model=${reviewResult.modelId} reviewed the draft (attempt ${attempt}, ${t.length} chars, ${((Date.now() - timing.outlineReviewStart) / 1000).toFixed(1)}s)`);
            } else {
              log.warn(`⚠️ [OUTLINE-REVIEW] attempt ${attempt}: reviewer output missing ANALYSIS/FIXES REQUIRED markers (${t.length} chars) — ${attempt < 2 ? 'retrying' : 'giving up'}`);
            }
          } catch (reviewErr) {
            log.warn(`⚠️ [OUTLINE-REVIEW] attempt ${attempt} failed: ${reviewErr.message} — ${attempt < 2 ? 'retrying' : 'giving up'}`);
          }
        }
        if (reviewText) {
          unifiedResponse = unifiedResponse + '\n\n' + reviewText;
          // Fix-count: the reviewer's FIXES REQUIRED lines (same "Pages N,M:"
          // line shape the progressive parser's patched-page detection reads).
          const reviewFixCount = (reviewText.match(/^[\s\-*•]*Pages?\s+[\d,\s\-–]+?\s*:/gim) || []).length;
          const reviewDurationMs = Date.now() - timing.outlineReviewStart;
          outlineReviewMeta = {
            model: reviewModel,
            modelId: reviewModelId,
            durationMs: reviewDurationMs,
            fixCount: reviewFixCount,
            reviewChars: reviewText.length,
            hintCount: draftConsistencyIssues.reduce((n, e) => n + e.issues.length, 0),
            reviewedAt: new Date().toISOString(),
          };
          genLog.info('outline_review', `External review by ${reviewModelId} applied: ${reviewFixCount} fix line(s) in ${(reviewDurationMs / 1000).toFixed(1)}s (${reviewText.length} chars)`, null, {
            reviewModel,
            reviewModelId,
            fixCount: reviewFixCount,
            durationMs: reviewDurationMs,
            hintCount: outlineReviewMeta.hintCount
          });
          // Hand the reviewer output to the progressive parser in one chunk so
          // its patched-page detection sees the COMPLETE FIXES REQUIRED list.
          progressiveParser.processChunk('', unifiedResponse);
        } else {
          log.warn('🚨 [OUTLINE-REVIEW] reviewer failed after 1 retry — proceeding with UNPATCHED draft (no critique applied to this story)');
          genLog.warn('outline_review_failed', `Reviewer ${reviewModel} failed after retry — story shipped as unpatched draft`);
        }
      }
      timing.outlineReviewEnd = Date.now();
    }

    // Finalize streaming parser (beats mode never fed it a stream)
    if (!beatsMode) progressiveParser.finalize();
    log.debug(`📖 [UNIFIED] Response length: ${unifiedResponse.length} chars, ${streamingPagesDetected} pages detected during streaming`);

    // Parse the unified response (full parse for complete data). Pass
    // isTrial so the parser doesn't warn about a missing draft section that
    // the trial prompt deliberately omits. See docs/decisions.md → "Trial
    // stories skip draft → analysis → revise".
    const parser = new UnifiedStoryParser(unifiedResponse, { isTrial: !!inputData.trialMode });
    let title = (beatsMode ? beatsResult.title : parser.extractTitle()) || streamingTitle || inputData.storyType || 'Untitled Story';
    const titleCandidates = parser.extractTitleCandidates();
    // TITLE PICK. Which candidate ships is decided BY THE WRITER that produced
    // the candidates — the beats page-text call, or the unified story call —
    // both of which already hold the candidates, the brief and the reader age.
    // It used to be a separate 300-token judge call here (usageLabel
    // 'title_judge', prompts/title-judge.txt); the owner's directive (2026-08-27)
    // was that the title can be judged inside another prompt rather than paying
    // for its own call. The stored shape is unchanged: `data.titleJudge =
    // {pick (array index), reason, candidates}`. Non-blocking — no parseable
    // TITLE_PICK leaves `title` on the deterministic hash pick, exactly like the
    // old judge's failure path.
    const titlePick = beatsMode ? (beatsResult.titleJudge || null) : parser.extractTitlePick();
    let titleJudge = null;
    if (titlePick && Array.isArray(titlePick.candidates) && titlePick.candidates.length > 1
      && titlePick.pick >= 0 && titlePick.pick < titlePick.candidates.length) {
      titleJudge = { pick: titlePick.pick, reason: String(titlePick.reason || '').trim(), candidates: titlePick.candidates };
      title = titlePick.candidates[titlePick.pick];
      log.info(`[TITLE-PICK] "${title}" (${titlePick.pick + 1}/${titlePick.candidates.length}) — ${titleJudge.reason || 'no reason given'}`);
    } else if (Array.isArray(titleCandidates) && titleCandidates.length > 1) {
      log.warn(`[TITLE-PICK] writer emitted no usable TITLE_PICK — keeping the hash pick "${title}"`);
    }
    const clothingRequirements = inputData.trialMode
      ? inputData._trialClothingRequirements
      : (parser.extractClothingRequirements() || streamingClothingRequirements);
    // Beats mode: the pipeline's own bible object, which its post-checks
    // (assignment trim, invented-peer age clamp) mutated and which the Art
    // Director used. A re-parse of the transcript is the FALLBACK only — until
    // 2026-09-11 it was the primary, and re-parsed the untrimmed JSON (the
    // transcript is now kept in step too; see beatsPipeline
    // syncVisualBibleSection and docs/decisions.md 2026-09-11 "trim not persisted").
    const visualBible = (beatsMode && beatsResult.visualBible) || parser.extractVisualBible() || streamingVisualBible || {};
    // The assignment-trim assertion that used to stand here is gone with the
    // trim itself (2026-09-11): page assignment is no longer guessed at bible
    // time, it is rebuilt from the FINAL scene briefs inside the beats pipeline
    // (`applyBriefUsage`), which is also what the element budget is measured
    // against downstream. Both `trimVbAssignments` and its `vbTrimLostPages`
    // tripwire were deleted the same day, once nothing called either.
    // Sonnet sometimes emits two secondaryCharacters entries that share the
    // same CHR id (the same person referenced by relation AND by attribute).
    // Resolve via Haiku before any downstream consumer sees the collision —
    // image prompts, VB grid, BBOX-enrich all assume unique ids.
    await dedupeSecondaryCharacterIds(visualBible, addUsage);
    // Backfill the streaming VB from the authoritative full parse. When the
    // streaming parser's stricter section detection missed the Visual Bible
    // (it diverged from the full parser's regex — the root cause of the
    // job_1781036274234 crash), any scene expansions still waiting on
    // streamingVisualBible now pick up the correct VB instead of timing out.
    // streamEnded then releases any expansion still in its wait loop.
    if (!streamingVisualBible && visualBible && Object.keys(visualBible).length > 0) {
      streamingVisualBible = visualBible;
      log.info('[STREAM] Backfilled streamingVisualBible from authoritative full parse (streaming detection had missed it)');
    }
    streamEnded = true;
    // COVER HINTS ARE THE TRIAL'S ONLY (2026-09-24). A full story's covers are
    // PAGES the Art Director briefs from code-written cover beats
    // (beatsResult.coverScenes, rendered through the page path below); the
    // outline carries no cover section any more. The trial keeps its own cover
    // builder (startCoverGeneration / onCoverScene) and the hints it reads.
    let coverHints = beatsMode ? null : parser.extractCoverHints();
    // The trial writer emits no cover-hints section (only the front cover's
    // COVER SCENE JSON), so every trial cover the parse left without a hint gets
    // its structured default here — before the cast, clothing and backdrop
    // checks below, which then treat it like any hint, and stored with them.
    // A cover already rendering (the front, from its streamed COVER SCENE
    // JSON via onCoverScene) keeps no default: it was not made from one.
    if (inputData.trialMode) {
      const { trialDefaultCoverHint } = require('./server/lib/coverIterate');
      for (const coverType of coverTypesFor(inputData)) {
        if (coverHints?.[coverType] || streamingCoverPromises.has(coverType)) continue;
        coverHints = coverHints || {};
        coverHints[coverType] = trialDefaultCoverHint(coverType, inputData);
      }
    }

    // Reconcile cover hint clothing against the story's clothingRequirements.
    // Claude can write a cover hint that asks for a clothing category that the
    // character did NOT mark used (e.g. back cover wants Sophie:standard but
    // Sophie's only used category is costumed:zauberlehrling). Generating a
    // never-otherwise-needed avatar would be wasted work AND a silent fallback
    // to the raw face photo would degrade quality. Override the cover hint to
    // use what the character actually has — mutates coverHints in place.
    // A hint may name a figure that is in no cast list at all (the beats bible
    // writer invented one and dropped a real primary to make room —
    // job_1788641639919_mpjwlzkf1). Drop the phantom from every hint container
    // BEFORE clothing reconciliation, so the declared cover cast — which the
    // prompt, the reference packing and the cover eval all read from here — is
    // real people. Nobody is added: the cover cast is the Art Director's
    // (owner, 2026-09-23 — the refill that padded covers to five is deleted).
    if (coverHints) {
      const { validateCoverHintCast } = require('./server/lib/coverIterate');
      validateCoverHintCast(coverHints, inputData.characters, { logger: log });
    }

    const reconcileResult = coverHints
      ? reconcileCoverClothingWithRequirements(coverHints, clothingRequirements, log)
      : { overrides: [] };
    if (reconcileResult.overrides.length > 0) {
      log.warn(`⚠️ [UNIFIED] Cover clothing reconciliation: ${reconcileResult.overrides.length} override(s) applied`);
    }

    // Debug: log cover hints character clothing (post-reconciliation)
    if (coverHints) {
      for (const [coverType, hint] of Object.entries(coverHints)) {
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          log.debug(`🎨 [UNIFIED] Cover ${coverType} character clothing: ${JSON.stringify(hint.characterClothing)}`);
        }
      }
    }
    // Beats mode assembled its own pages (text + beat scene line); the parser
    // has no ---STORY PAGES--- draft/patch structure to merge in that path.
    const storyPages = beatsMode ? beatsResult.pages : parser.extractPages();

    // Page-side sibling of the cover reconciliation above: a page may not ask
    // for an outfit the story's clothing contract says does not exist. Left
    // alone, the request resolves to no clothing description at all and the
    // garment reaches the render as a prop (see the helper's comment).
    for (const page of (storyPages || [])) {
      if (!page?.characterClothing || Object.keys(page.characterClothing).length === 0) continue;
      const { clothing } = reconcilePageClothingWithRequirements(
        page.characterClothing,
        clothingRequirements,
        { pageNumber: page.pageNumber, logger: log }
      );
      page.characterClothing = clothing;
    }

    // Deterministic scene metadata ↔ scene design consistency check on the
    // FINAL pages (draft + reviewer patches merged). Mechanical string/set
    // parity only — semantic scene consistency is the outline reviewer's job
    // (see docs/decisions.md). Surfaced three ways: compact log lines, a
    // generationLog event, and finalChecksReport.sceneConsistency (dev panel).
    // Skipped in beats mode: the check compares page metadata against the
    // unified outline's SCENE DESIGN blocks, which a beats transcript has not
    // got — the scene review is the equivalent gate there.
    // The story's cast index, built once from the final cast + Visual Bible and
    // shared by the consistency check below and the per-page cast check later.
    const storyCastIndex = buildCastIndex({ characters: inputData.characters || [] }, visualBible);
    let sceneConsistencyResult = null;
    if (!beatsMode) {
      try {
        sceneConsistencyResult = checkSceneConsistency(storyPages, unifiedResponse, {
          knownCharacterNames: (inputData.characters || []).map(c => c.name),
          castIndex: storyCastIndex
        });
        const issueCount = sceneConsistencyResult.reduce((n, e) => n + e.issues.length, 0);
        for (const line of formatSceneConsistencySummary(sceneConsistencyResult)) log.warn(line);
        genLog.info('scene_consistency', `Scene consistency check: ${issueCount} issue(s) across ${sceneConsistencyResult.length} page(s)`, null, {
          issueCount,
          pages: sceneConsistencyResult
        });
      } catch (scErr) {
        log.warn(`⚠️ [SCENE-CONSISTENCY] check failed (non-fatal): ${scErr.message}`);
      }
    }

    // Construct fullStoryText from parsed pages (for storage compatibility)
    // Use let so it can be modified by text consistency corrections
    let fullStoryText = storyPages.map(page =>
      `--- Page ${page.pageNumber} ---\n${page.text}`
    ).join('\n\n');

    // The writer's output, frozen (owner, 2026-08-25). Everything downstream
    // overwrites fullStoryText in place — text-consistency corrections, then
    // the refine pass — and BOTH data.storyText and data.originalStory ship the
    // refined prose (the rebuild at the refine join is deliberate: the Lab's
    // edit mode reads them and used to show pre-refine text under a refined
    // book). The consequence nobody wrote down is that the draft then survives
    // only inside textRefineReport.pages[].before, and only for the pages that
    // stage happened to change — recoverable by accident, one report-trimming
    // from gone. Keeping it verbatim makes every before/after measurement exact
    // and re-runnable over the whole history with a better counter later.
    // See docs/decisions.md (2026-08-25) and scripts/analysis/refine-damage-report.js.
    const writerText = fullStoryText;

    log.debug(`📖 [UNIFIED] Parsed: title="${title}", ${storyPages.length} pages, ${Object.keys(clothingRequirements || {}).length} clothing reqs`);
    genLog.info('story_parsed', `"${title}" - ${storyPages.length} pages, ${Object.keys(clothingRequirements || {}).length} clothing reqs`, null, { title, pageCount: storyPages.length });
    log.debug(`📖 [UNIFIED] Visual Bible: ${visualBible.secondaryCharacters?.length || 0} chars, ${visualBible.locations?.length || 0} locs, ${visualBible.animals?.length || 0} animals, ${visualBible.artifacts?.length || 0} artifacts`);

    // Text consistency check removed (now handled by unified repair pipeline)

    // Compare streaming vs final parse results
    if (!beatsMode && streamingPagesDetected !== storyPages.length) {
      log.warn(`⚠️ [UNIFIED] Page count mismatch: streaming detected ${streamingPagesDetected} pages, final parse found ${storyPages.length} pages`);
      log.warn(`⚠️ [UNIFIED] Pages from final parse: ${storyPages.map(p => p.pageNumber).join(', ')}`);
    }

    // Check if we got the requested number of pages
    if (storyPages.length !== sceneCount) {
      log.warn(`⚠️ [UNIFIED] Requested ${sceneCount} scenes but parsed ${storyPages.length} pages`);
    }

    // Filter main characters from Visual Bible (safety net)
    filterMainCharactersFromVisualBible(visualBible, inputData.characters);

    // Phantom character detection: any name in scene hints that isn't in
    // main characters or the Visual Bible. Without this, the image generator
    // invents a different person for the same name on every page.
    try {
      const { detectAndPatchPhantomCharacters, detectAndPatchOrphanObjectIds } = require('./server/lib/phantomCharacters');
      await detectAndPatchPhantomCharacters({
        storyPages,
        visualBible,
        inputCharacters: inputData.characters || [],
        modelId: MODEL_DEFAULTS.sceneIteration || 'claude-haiku-5-5',
      });
      // Usage recorded by the callClaudeAPI chokepoint inside the helper
      // (usageLabel 'phantom_patch'). The helper returns a COPY of the usage,
      // so re-adding it here would double-count.
      // Same repair for object ids (ART/ANI/VEH/LOC/CLO) referenced in page
      // metadata but never defined — the image-prompt sanitizer drops lines
      // with unresolved ids, so an orphan id silently erases scene content.
      await detectAndPatchOrphanObjectIds({
        storyPages,
        visualBible,
        modelId: MODEL_DEFAULTS.sceneIteration || 'claude-haiku-5-5',
      });
    } catch (err) {
      log.warn(`👻 [PHANTOM] Detection/patch failed (continuing): ${err.message}`);
    }

    // Initialize main characters from inputData.characters with their style analysis
    // This populates visualBible.mainCharacters for the dev panel display
    initializeVisualBibleMainCharacters(visualBible, inputData.characters);

    // Inject historical locations with pre-fetched photos (for historical stories)
    if (inputData.storyCategory === 'historical' && inputData.storyTopic) {
      const historicalLocations = getHistoricalLocations(inputData.storyTopic, { aspect: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect });
      if (historicalLocations?.length > 0) {
        injectHistoricalLocations(visualBible, historicalLocations);
        log.info(`📍 [UNIFIED] Injected ${historicalLocations.length} pre-fetched historical location(s)`);
      }
    }

    // Link pre-discovered landmarks (if available) to skip fetching later
    if (inputData.availableLandmarks?.length > 0) {
      linkPreDiscoveredLandmarks(visualBible, inputData.availableLandmarks);
    }

    // Cover-backdrop validation. Trust Sonnet's pick — it knows the story
    // and chose a location that fits. Don't substitute an unrelated VB
    // location just to get a photo (e.g. swapping the story's garden for a
    // Zürich landmark). The downstream cover-iterate path already routes:
    //   • picked LOC has a real-landmark photo → composite (pass-1 white +
    //     pass-2 landmark protection)
    //   • picked LOC is invented or photo-less → normal generation, using
    //     the LOC's prose description as the backdrop
    // We only step in when Sonnet picked a LOC id that doesn't resolve in
    // the VB at all — fall back to ANY VB location so the cover still has
    // a backdrop instead of empty `hint.objects`.
    if (coverHints && Array.isArray(visualBible?.locations)) {
      const anyVbLoc = visualBible.locations.find(l => l?.id) || null;
      for (const [coverType, hint] of Object.entries(coverHints)) {
        if (!hint || !Array.isArray(hint.objects)) continue;
        const locIds = hint.objects.filter(o => typeof o === 'string' && /^LOC\d+/i.test(o));
        const primary = locIds[0] || null;
        const picked = primary
          ? visualBible.locations.find(l => l.id && l.id.toUpperCase() === primary.toUpperCase())
          : null;
        if (picked) continue; // ✅ Sonnet's pick exists in VB — keep it
        if (!anyVbLoc) continue; // VB has no locations at all — nothing to substitute
        log.info(`[COVER-VALIDATE] ${coverType}: ${primary ? `${primary} not in VB` : 'no LOC picked'} — substituting with ${anyVbLoc.id} (${anyVbLoc.name})`);
        hint.objects = [anyVbLoc.id, ...(hint.objects || []).filter(o => o !== primary)];
      }
    }

    // Load photo variant descriptions for Swiss landmarks (descriptions only, no image data)
    // — the photos each location's `landmarkPhoto` citation is answered from.
    await loadLandmarkPhotoDescriptions(visualBible);
    // Every real-landmark plate's citation, checked once for the story (the
    // trial writer cites per location). A fault is logged and recorded here;
    // its pages then get no landmark photo (docs/decisions.md 2026-09-26).
    {
      const { landmarkPhotoCitationFaults } = require('./server/lib/storyHelpers');
      for (const f of landmarkPhotoCitationFaults(visualBible)) {
        log.error(`❌ [LANDMARK] Plate ${f.plateId} ("${f.locName}"): ${f.reason} — its pages get no landmark photo`);
        genLog.warn('landmark_photo_citation', `${f.plateId} (${f.locName}): ${f.reason}`, null, f);
      }
    }

    // Start background fetch for landmark reference photos (runs in parallel with avatar generation)
    // NOTE: For Swiss landmarks with photo variants, we'll load photos on-demand during image generation
    // This prefetch handles non-Swiss landmarks (historical events, Wikimedia search) that don't have variants
    let landmarkFetchPromise = null;
    let landmarkCount = 0;
    const nonVariantLandmarks = (visualBible.locations || []).filter(
      l => l.isRealLandmark && !l.photoVariants?.length && l.photoFetchStatus !== 'success'
    );
    if (nonVariantLandmarks.length > 0 && !skipImages) {
      landmarkCount = nonVariantLandmarks.length;
      // Source routing (owner, 2026-09-05): a Swiss story's landmarks come
      // STRICTLY from the landmark index — a VB landmark that didn't link
      // (linkPreDiscoveredLandmarks miss) is re-resolved against the index by
      // name and serves NOTHING on a miss. Only genuinely non-Swiss
      // locations use the free-form Wikipedia fetch routine.
      const swissIndexOnly = isSwissCountry(inputData.userLocation?.country);
      log.info(`🌍 [UNIFIED] Starting background fetch for ${nonVariantLandmarks.length} non-variant landmark photo(s)${swissIndexOnly ? ' (Swiss: index-only)' : ''}`);
      landmarkFetchPromise = prefetchLandmarkPhotos(visualBible, { swissIndexOnly });
      // Release the cover barrier once the fetch settles (success or failure) so
      // covers resolve their backdrop against fully-populated locations.
      landmarkFetchPromise.finally(() => resolveLandmarksReady());
    } else {
      // Nothing to fetch (all variants/curated/none) — covers can proceed now.
      resolveLandmarksReady();
    }

    // Start background reference sheet generation for secondary elements.
    // For TRIAL: this already ran early inside onVisualBible (trialReferenceSheetPromise)
    // so trial page render could actually consume the refs — we just reuse that
    // promise here rather than firing a duplicate finalize-time gen.
    // For FULL mode: this is the canonical kickoff point — scene expansion is
    // a separate second pass after streaming, so timing isn't an issue and the
    // wider element scope (maxElements: null) is the right default.
    let referenceSheetPromise = inputData.trialMode ? trialReferenceSheetPromise : null;
    if (!inputData.trialMode && !skipImages) {
      const refSheetModel = MODEL_DEFAULTS.pageImage; // PIPE-7: was MODEL_DEFAULTS.image (nonexistent)
      const refSheetBackend = IMAGE_MODELS[refSheetModel]?.backend || null;
      const styleDescription = resolveArtStyle(artStyle, refSheetBackend) || resolveArtStyle('pixar');
      referenceSheetPromise = generateReferenceSheet(visualBible, styleDescription, {
        minAppearances: 2, // Non-character elements (locations/artifacts/…) appearing on 2+ pages
        characterMinAppearances: 1, // Every secondary character gets its own face reference, even on a single page (owner)
        maxPerBatch: 4,    // Max 4 elements per grid for quality
        maxElements: null, // Generate reference sheets for all qualifying elements
        storyId: jobId,    // Phase 1d R2 dual-write: refs upload to stories/{jobId}/vb/{entryId}.jpg
        // Location/vehicle/artifact/animal elements render at the story's own
        // page aspect — not avatarAspect — so a single-element plate reference
        // (composeVbSlot) doesn't need heavy white pillar-padding to fit.
        elementAspect: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
      }).catch(err => {
        log.warn(`⚠️ [UNIFIED] Reference sheet generation failed: ${err.message}`);
        return { generated: 0, failed: 0, elements: [] };
      });
    }

    // Save checkpoint. Include the RAW unified response (unifiedResponse) so a
    // later failure's partial-save can persist it to data.outline — successful
    // jobs save the raw response there, but the partial-save path previously
    // had no source for it (only the prompt), which left failed jobs
    // un-diagnosable from the DB (the job_1781036274234 parse failure couldn't
    // be inspected because the raw response was nowhere).
    await saveCheckpoint(jobId, 'unified_story', {
      title,
      clothingRequirements,
      visualBible,
      coverHints,
      storyPages,
      unifiedPrompt,
      unifiedResponse,
      unifiedModelId,
      unifiedUsage
    });

    // Save story_text checkpoint for progressive display (UI can show text immediately)
    const pageTextMap = {};
    storyPages.forEach(page => {
      pageTextMap[page.pageNumber] = page.text;
    });
    // Picture-book layout for all reading levels: 1 scene = 1 print page
    const printPageCount = storyPages.length;

    // Frontend expects: { title, dedication, pageTexts, sceneDescriptions, totalPages, totalScenes }
    await saveCheckpoint(jobId, 'story_text', {
      title,
      dedication: inputData.dedication || '',
      pageTexts: pageTextMap,
      sceneDescriptions: storyPages.map(page => ({
        pageNumber: page.pageNumber,
        description: page.sceneHint || '',
        characterClothing: page.characterClothing || {}
      })),
      totalPages: printPageCount,  // Print page count (text + image pages)
      totalScenes: storyPages.length  // Scene count (= number of images to expect)
    });
    log.debug(`💾 [UNIFIED] Saved story text for progressive display (${storyPages.length} scenes = ${printPageCount} print pages)`);

    // Update progress: Story text complete
    const scenesStarted = streamingSceneExpansionPromises.size;
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [57, `Story complete: "${title}" (${scenesStarted} scenes in parallel)`, jobId]  // 57 = text complete (text phase = ~58% of wall clock)
    );

    // Wait for early avatar styling (started during streaming when clothing requirements detected)
    // This runs in parallel with story text generation, saving ~3min.
    // Realistic included — prepareStyledAvatars decides per-category.
    if (!skipImages) {
      if (streamingAvatarStylingPromise) {
        log.debug(`🎨 [UNIFIED] Waiting for early avatar styling to complete...`);
        await streamingAvatarStylingPromise;
        log.debug(`✅ [UNIFIED] Pre-cover styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
      } else {
        // Fallback: style avatars now if early styling didn't start
        log.debug(`🎨 [UNIFIED] Preparing styled avatars for covers (fallback)...`);
        try {
          const basicCoverCastIndex = buildCastIndex({ characters: inputData.characters || [] }, null);
          const basicCoverRequirements = (inputData.characters || []).flatMap(char => {
            const charReqs = lookupByName(clothingRequirements, char.name, basicCoverCastIndex)?.value;

            let usedCategories = charReqs
              ? Object.entries(charReqs)
                  .filter(([cat, config]) => config?.used)
                  .map(([cat, config]) => cat === 'costumed' && config?.costume
                    ? `costumed:${config.costume.toLowerCase()}`
                    : cat)
              : ['standard'];

            if (usedCategories.length === 0) {
              usedCategories = ['standard'];
            }

            return usedCategories.map(cat => ({
              pageNumber: 'pre-cover',
              clothingCategory: cat,
              characterNames: [char.name]
            }));
          });
          await prepareStyledAvatars(inputData.characters || [], artStyle, basicCoverRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null, { skipQualityEval: !!inputData.trialMode, seasonOutfit: trialSeasonOutfit(inputData), finalPass: false }); // the coverage top-up below is the final pass
          log.debug(`✅ [UNIFIED] Pre-cover styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.warn(`⚠️ [UNIFIED] Pre-cover styled avatar prep failed: ${error.message}`);
        }
      }
    }

    // NOTE: Avatar generation removed. Avatars should already exist from character creation.

    // PHASE 2: Prepare styled avatars
    await checkCancellation();
    genLog.setStage('avatars');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [58, `Preparing styled avatars...`, jobId]  // 58 = avatar styling
    );

    // Collect avatar requirements and prepare styled avatars
    const sceneDescriptions = storyPages.map(page => ({
      pageNumber: page.pageNumber || storyPages.indexOf(page) + 1,
      description: page.sceneHint || page.text || ''
    }));
    // Build pageClothing from per-character clothing data
    const pageClothing = {};
    storyPages.forEach((page, index) => {
      if (page.characterClothing && Object.keys(page.characterClothing).length > 0) {
        pageClothing[page.pageNumber || index + 1] = page.characterClothing;
      }
    });

    const avatarRequirements = collectAvatarRequirements(
      sceneDescriptions,
      inputData.characters || [],
      pageClothing,
      'standard',
      clothingRequirements
    );

    // A page the writer marks `standard` gets a real standard 2×4 sheet, built
    // by the SAME pipeline a full story uses. This used to be filtered out for
    // the trial (costumed-only, to save ~30-40s) with the raw preview avatar
    // standing in — but the preview is a Pass-1 realistic anchor, so those
    // pages rendered as painted photographs, and converting it separately just
    // produced a trial-only avatar path parallel to the working one (a 3×3
    // grid, since the style-transfer pass converts SHEETS). Owner call
    // 2026-08-16: no trial-only avatar path. See docs/decisions.md.

    // NOTE: Avatar generation removed from story processing.
    // Base avatars should already exist from character creation.
    // Costumed/signature avatars are produced by prepareStyledAvatars (below).

    // Prepare styled avatars (convert existing avatars to target art style).
    // Realistic runs too — prepareStyledAvatars decides per-category
    // (skips unchanged outfits, redresses changed ones + costumes).
    //
    // This ALWAYS runs when there are requirements — even after early streaming
    // styling succeeded. `avatarRequirements` (collectAvatarRequirements over
    // the actual scenes + a cover loop covering every character) is the
    // COMPLETE cast; the early streaming pass only covers the cast known at
    // clothing-requirements time and misses characters the outline later casts
    // into a scene (e.g. family members who only appear in a group/reunion
    // page). prepareStyledAvatars skips cache-hit avatars (styledAvatarCache),
    // so when early styling already ran this is a cheap COVERAGE TOP-UP that
    // only generates the gaps — no duplicate work. Previously this block was
    // skipped whenever early styling succeeded, leaving those late-cast
    // characters with no story avatar (text-only reference → worse likeness).
    if (avatarRequirements.length > 0) {
      // Validate that characters have base avatars
      const charactersWithoutAvatars = (inputData.characters || []).filter(c =>
        !c.avatars?.standard && !c.photoUrl && !c.bodyNoBgUrl
      );
      if (charactersWithoutAvatars.length > 0) {
        log.warn(`⚠️ [UNIFIED] Characters missing base avatars: ${charactersWithoutAvatars.map(c => c.name).join(', ')}`);
      }

      const mode = earlyAvatarStylingSucceeded
        ? `coverage top-up (${getStyledAvatarCacheStats().size} already cached)`
        : 'early styling did not run';
      log.debug(`🎨 [UNIFIED] Preparing ${avatarRequirements.length} styled-avatar reqs for ${artStyle} (${mode})`);
      await prepareStyledAvatars(inputData.characters, artStyle, avatarRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null, { skipQualityEval: !!inputData.trialMode, seasonOutfit: trialSeasonOutfit(inputData) });
    }

    // Start cover generation NOW that avatars are ready (covers need avatars as reference photos)
    // TRIAL ONLY: a full story's covers are pages (beatsResult.coverScenes).
    if (!skipImages && !skipCovers && inputData.trialMode) {
      const coverTypes = coverTypesFor(inputData);
      for (const coverType of coverTypes) {
        if (streamingCoverPromises.has(coverType)) continue;
        // Every trial cover has a hint by now: parsed, or its structured
        // default (trialDefaultCoverHint, set right after the parse). Covers
        // run concurrently (streamCoverLimit), so this adds no wall clock.
        const hint = coverHints?.[coverType];
        if (!hint) {
          log.error(`❌ [COVER] ${coverType}: no cover hint — the cover is not rendered`);
          continue;
        }
        startCoverGeneration(coverType, hint);
      }
      log.debug(`⚡ [UNIFIED] Started ${streamingCoverPromises.size} cover generations (avatars ready)`);
    }

    // PHASE 3: Scene descriptions
    let expandedScenes;
    // The full story's cover pages: briefed and reviewed with the story pages
    // by the Art Director (coverBeats.js), rendered through the page path below
    // with only their cover render options (coverRender.js), stored into
    // coverImages. Never part of expandedScenes: they carry no page text.
    let coverScenes = [];

    if (beatsMode) {
      // Beats mode: scenes were expanded AND reviewed inside generateStoryViaBeats
      // (steps 3 + 4), so there is nothing left to expand here.
      expandedScenes = beatsResult.scenes;
      coverScenes = skipCovers ? [] : (beatsResult.coverScenes || []);
      log.info(`⏭️ [BEATS] Using ${expandedScenes.length} scene brief(s) from the beats pipeline`);
      genLog.info('scenes_complete', `${expandedScenes.length} scene briefs from the beats pipeline`);
    } else if (inputData.trialMode) {
      // Trial mode: use enriched scene hints directly as scene descriptions
      log.info(`⏭️ [TRIAL] Skipping scene expansion — using rich scene hints directly`);
      expandedScenes = storyPages.map(page => ({
        pageNumber: page.pageNumber,
        text: page.text,
        sceneHint: page.sceneHint,
        sceneDescription: page.sceneHint,
        sceneDescriptionPrompt: null,
        sceneDescriptionModelId: null,
        characterClothing: page.characterClothing || {},
        characters: page.characters
      }));
    } else {
      // Normal flow: wait for scene expansions
      genLog.setStage('scenes');
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [59, `Finalizing ${streamingSceneExpansionPromises.size} scene expansions...`, jobId]  // 59 = scenes expanded
      );

      // Start any missing scene expansions
      for (const page of storyPages) {
        if (!streamingSceneExpansionPromises.has(page.pageNumber)) {
          log.debug(`⚡ [UNIFIED] Starting late scene expansion for page ${page.pageNumber}`);
          startSceneExpansion(page);
        }
      }

      // Wait for all scene expansions
      log.debug(`⏳ [UNIFIED] Waiting for ${streamingSceneExpansionPromises.size} scene expansions...`);
      const sceneResults = await Promise.all(
        Array.from(streamingSceneExpansionPromises.values())
      );

      // Sort by page number. filter(Boolean) first — a scene expansion can
      // resolve to null (its thunk threw, or the user skipped it); a null in
      // the sort comparator dereferences null.pageNumber and crashes the whole
      // job (the job_1781036274234 crash, 2026-06-09). Drop nulls and log how
      // many so a silent page loss is visible.
      const nullScenes = sceneResults.length - sceneResults.filter(Boolean).length;
      if (nullScenes > 0) {
        log.warn(`⚠️ [UNIFIED] ${nullScenes}/${sceneResults.length} scene expansion(s) returned null — dropped before sort (page(s) will be missing)`);
      }
      expandedScenes = sceneResults.filter(Boolean).sort((a, b) => a.pageNumber - b.pageNumber);
      log.debug(`✅ [UNIFIED] All ${expandedScenes.length} scene expansions complete`);
      genLog.info('scenes_complete', `All ${expandedScenes.length} scene expansions complete`);

      // FIX: Update characterClothing from full re-parse
      for (const scene of expandedScenes) {
        const fullParsePage = storyPages.find(p => p.pageNumber === scene.pageNumber);
        if (fullParsePage?.characterClothing && Object.keys(fullParsePage.characterClothing).length > 0) {
          const streamingClothing = scene.characterClothing || {};
          const fullClothing = fullParsePage.characterClothing;
          for (const [charName, fullValue] of Object.entries(fullClothing)) {
            const streamingValue = streamingClothing[charName];
            if (streamingValue && fullValue && streamingValue !== fullValue) {
              log.debug(`[CLOTHING FIX] Page ${scene.pageNumber} ${charName}: "${streamingValue}" -> "${fullValue}"`);
            }
          }
          scene.characterClothing = fullClothing;
        }
      }
    }

    // Log streaming efficiency (for non-trial)
    if (!inputData.trialMode) {
      const pagesFromStreaming = streamingExpandedPages.size;
      log.debug(`📊 [UNIFIED] Streaming efficiency: ${pagesFromStreaming}/${storyPages.length} pages started during streaming`);
    }

    // THE ART DIRECTOR PROMPT IS STORED ONCE (2026-09-21).
    //
    // The all-pages scene-expansion prompt is ~112 KB and identical for every
    // page of a book. Stored inline per page it was 4.25 MB — 49% of a
    // measured story row. It now lives once in `sceneExpansionReport.prompts[]`
    // and each page carries the index. One builder for every mode: beats (one
    // shared prompt), the per-page beats fallback and the unified streaming
    // path (one prompt each) all roll up through the same call.
    const { prompts: scenePromptTable, refByPage: scenePromptRefs } =
      rollUpScenePrompts(expandedScenes);

    // The stored `sceneDescriptions[]` shape (brief under `description`) —
    // one projection, also used for the repair pipeline's story data below.
    const { sceneDescriptionRecord } = require('./server/lib/sceneMetadata');
    const allSceneDescriptions = expandedScenes.map(scene => sceneDescriptionRecord(scene, scenePromptRefs));

    // WARDROBE-STATE AVATAR VARIANTS (owner ruling 2026-09-19) and OUTFIT
    // VERSIONS (owner ruling 2026-09-24).
    //
    // This is the earliest point the flip data exists. The avatar kickoff fires
    // at the story-bible stage, long before any scene brief, so `wornItems[]` —
    // the per-page declaration of which garment comes OFF, or which outfit
    // version a page wears — is simply not available there. So the derivation
    // runs here, once, on the all-pages Art Director output, and chains onto
    // the in-flight styling promise so the base sheets it redresses are
    // finished first.
    //
    // Covers: an off-state never reaches a cover (a cover has no `wornItems`),
    // so a cover takes the base sheet. An outfit VERSION follows the page rule
    // (owner, 2026-09-24): a cover whose hint cites the version garment wears
    // it, and waits on `wardrobeVersionsReady` for its sheet. See
    // docs/decisions.md.
    // Trials are out of scope — a trial has no Art Director brief to declare a
    // flip in, and `inputData.trialMode` skips avatar styling here anyway.
    let variantRenderStarted = false;
    if (!inputData.trialMode && !skipImages) {
      const { deriveWardrobeVariantRequirements } = require('./server/lib/wardrobeVariants');
      const vbForVariants = visualBible || streamingVisualBible;
      let variantRows = [];
      try {
        const scenesForVariants = expandedScenes.map(scene => ({
          pageNumber: scene.pageNumber,
          sceneMetadata: extractSceneMetadata(scene.sceneDescription),
        }));
        variantRows = deriveWardrobeVariantRequirements({
          visualBible: vbForVariants,
          scenes: scenesForVariants,
          clothingRequirements: streamingClothingRequirements,
          characters: inputData.characters || [],
        }).requirements;
      } catch (err) {
        log.warn(`👕 [WARDROBE-VARIANT] derivation failed: ${err.message} — every page keeps the worn sheet + the "leave it off" line`);
      }
      if (variantRows.length > 0) {
        variantRenderStarted = true;
        const prior = streamingAvatarStylingPromise || Promise.resolve();
        streamingAvatarStylingPromise = (async () => {
          try { await prior; } catch { /* the kickoff owns its own failure */ }
          try {
            const { prepareWardrobeVariantAvatars } = require('./server/lib/styledAvatars');
            await prepareWardrobeVariantAvatars(inputData.characters || [], artStyle, variantRows, {
              addUsage,
              skipQualityEval: false,
              backendOverride: modelOverrides.storyAvatarModel || null,
            });
          } catch (error) {
            log.warn(`👕 [WARDROBE-VARIANT] variant rendering failed: ${error.message} — every page keeps the worn sheet + the "leave it off" line`);
          } finally {
            resolveWardrobeVersions();
          }
        })();
      }
    }
    if (!variantRenderStarted) resolveWardrobeVersions();

    // Batch-translate scene summaries to story language (separate from scene expansion)
    // One cheap Haiku 5.5 call with all summaries — ~15-20s at effort low, ~$0.002
    if (lang !== 'en') {
      try {
        const built = require('./server/lib/promptBuilders').buildSceneTranslationPrompt(allSceneDescriptions, lang);
        if (built) {
          const { callTextModelStreaming } = require('./server/lib/textModels');
          const transResult = await callTextModelStreaming(built.prompt, null, null, 'claude-haiku-5-5', { usageLabel: 'scene_translation', effort: 'low' }); // see DECISIONS 2026-10-08 Haiku 5.5
          if (transResult?.text) {
            const translations = transResult.text.trim().split('\n').filter(l => l.trim());
            let tIdx = 0;
            for (const scene of allSceneDescriptions) {
              if (scene.imageSummary && tIdx < translations.length) {
                // Strip "Page N: " prefix if the model echoed it
                scene.translatedSummary = translations[tIdx].replace(/^Page\s+\d+:\s*/i, '').trim();
                tIdx++;
              }
            }
            addUsage('anthropic', transResult.usage, 'scene_translation', transResult.modelId);
            log.info(`🌐 [TRANSLATION] Batch-translated ${tIdx} scene summaries to ${lang} ($${(transResult.usage?.cost || 0).toFixed(4)})`);
          }
        }
      } catch (transErr) {
        log.warn(`⚠️ [TRANSLATION] Batch translation failed: ${transErr.message}`);
      }
    }

    // Update pageClothing for storage compatibility (per-character format)
    storyPages.forEach((page, index) => {
      if (page.characterClothing && Object.keys(page.characterClothing).length > 0) {
        pageClothing[index + 1] = page.characterClothing;
      }
    });
    // pageClothingData now stores per-character clothing objects.
    // primaryClothing = dominant category across all pages — it is a live
    // fallback in repair/regen paths, so a hardcoded 'standard' fed standard
    // avatars into repairs on winter-only stories.
    const categoryCounts = {};
    for (const entry of Object.values(pageClothing)) {
      for (const cat of Object.values(entry)) {
        const norm = require('./server/lib/clothingCategories').normalizeClothingCategory(cat);
        categoryCounts[norm] = (categoryCounts[norm] || 0) + 1;
      }
    }
    const primaryClothing = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'standard';
    const pageClothingData = {
      primaryClothing,
      pageClothing
    };

    // Skip image generation if requested
    if (skipImages) {
      log.debug(`📖 [UNIFIED] Skipping image generation (text-only mode)`);

      const textPages = expandedScenes.map(scene => ({
        pageNumber: scene.pageNumber,
        text: scene.text,
        sceneDescription: scene.sceneDescription,
        image: null
      }));

      const result = {
        title,
        pages: textPages,
        coverImages: {},
        visualBible,
        tokenUsage,
        generationMode: 'unified'
      };

      // Text-only jobs return HERE — they never reach the normal completion
      // UPDATE (~line 7160) that sets status='completed' + writes result_data.
      // Persist a LIGHTWEIGHT result_data (title + per-page text + sceneDescription,
      // no image bytes — there are none) and mark the job completed so the wizard
      // dev "text-only" flow and the Test Lab text harness both finish cleanly and
      // are pollable. Guard with `status = 'processing'` (mirroring the normal
      // completion write) so a watchdog/cancel that already flipped this job to
      // failed/cancelled isn't resurrected to 'completed'.
      const textResultData = {
        title,
        pages: textPages.map(p => ({
          pageNumber: p.pageNumber,
          text: p.text,
          sceneDescription: p.sceneDescription,
        })),
        generationMode: 'unified',
        textOnly: true,
      };
      const textResultJson = JSON.stringify(textResultData);

      const textOnlyCompletion = await dbPool.query(
        `UPDATE story_jobs
         SET status = $1, progress = $2, progress_message = $3, result_data = $4,
             credits_reserved = 0, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5 AND status = 'processing'
         RETURNING id`,
        ['completed', 100, 'Story generation complete (text only)', textResultJson, jobId]
      );
      if (textOnlyCompletion.rowCount === 0) {
        log.warn(`⚠️ [UNIFIED] Text-only job ${jobId} was no longer 'processing' at completion (cancelled/failed by watchdog?) — not marking completed.`);
      }

      return result;
    }

    // ── TEXT REFINEMENT — KICKED OFF THE MOMENT PAGE TEXT IS FINAL ────────
    // Its only inputs are `expandedScenes` (final at the beats return above —
    // nothing rewrites page text after it) and the Visual Bible. It used to be
    // started ~400 lines further down, AFTER the landmark-fetch race and the
    // `await referenceSheetPromise`, so the chain that the whole repair phase
    // later joins on began only once the reference sheet had finished:
    // measured on job_1789853503332_riqncqg1i, page text was final at 22:09:50
    // CH and `text_refine_start` fired at 22:10:49 — 59 s of the join's wait
    // bought nothing. The refiner needs neither landmark photos nor reference
    // sheets, so it starts here.
    // TRIAL SKIPS REFINEMENT (owner 2026-08-15): a trial renders all 5 pages in
    // ~15s and has no repair phase behind which the chain could run, so a
    // minutes-long polish pass would be added wholesale to a ~230s run.
    const refineEnabled = process.env.TEXT_REFINE !== 'false' && !inputData.trialMode;
    let textRefinePromise = null;
    // Per-page before/after, filled at the join so dev mode can show WHAT the
    // refiner changed rather than only that it ran.
    let textRefineReport = null;
    // Latest snapshot the refiner published (audit, then after each round).
    let textRefinePartial = null;
    if (refineEnabled) {
      const { extractRefinablePages, startBackgroundRefine } = require('./server/lib/textRefine');
      const refinablePages = extractRefinablePages(expandedScenes, { visualBible, clothingRequirements });
      if (refinablePages.length > 0) {
        genLog.info('text_refine_start', `Refining text for ${refinablePages.length} page(s) in parallel with images`);
        // THE BIBLE RIDES ALONG (A7, 2026-09-21). `inputData` is the job's
        // stored input: the commissioned roster and nothing the story invented.
        // The refiner's per-character checks and its plan/text drift check both
        // enumerate the cast through `refineCast`, which reads
        // `visualBible.secondaryCharacters` — the canonical home of a figure the
        // STORY created. Without this the live path probes the commissioned
        // names only, exactly the blind spot that let an invented character
        // carry nine pages unexamined. The Lab's own call sites pass a stored
        // story, which already carries the bible.
        textRefinePromise = startBackgroundRefine({ ...inputData, visualBible }, refinablePages, {
          // The whole story, read-only, for the refiner's judgment (beats mode
          // only — the unified path records no arc).
          arc: beatsResult?.arcReviewReport?.finalArc || beatsResult?.beatsReviewReport?.arc || '',
          // The hints the writer was told to apply — the critics read the story
          // with them applied.
          arcHints: beatsResult?.arcReviewReport?.arcHints || '',
          // The OWED list is read from the arc's STORY LOGIC (text-v3).
          storyLogic: beatsResult?.arcReviewReport?.logic || '',
          // No `rounds`: the chain is fixed at two parallel audits → one repair
          // → one lector (owner ruling 2026-09-03). There is no loop to bound.
          usageLabel: 'text_refine',
          // A story already on the Jev-outage backup does not ask Jev again.
          jevOptions: { jevFallback: beatsResult?.jevFallback || null },
          // Latest completed state, so the join below can salvage the audit and
          // any finished round if the chain FAILS partway. (It is no longer a
          // deadline fallback — the join has no deadline.)
          onProgress: (snap) => { textRefinePartial = snap; },
        });
      }
    }

    // PHASE 4: Start cover images await (runs PARALLEL with page images)
    // Covers and page images don't depend on each other - both need story/avatars but not each other
    const coverImages = {};
    let coverAwaitPromise = null;

    if (streamingCoverPromises.size > 0) {
      timing.coversStart = timing.coversStart || Date.now(); // May have started during streaming
      log.debug(`⏳ [UNIFIED] Cover generations in progress (${streamingCoverPromises.size} covers, running parallel with page images)...`);

      // Create promise but don't await yet - covers run parallel with page images.
      // IMPORTANT: .catch() here prevents unhandled rejection crash if a cover fails
      // before coverAwaitPromise is awaited at line ~4214. Without this, a Grok 500
      // error between promise creation and await crashes the Node process.
      // ONE BAD COVER MUST NOT DESTROY THE OTHERS (2026-08-28). This was
      // Promise.all: a single rejecting cover skipped the whole .then, so every
      // SUCCESSFUL cover was discarded too and the story shipped with
      // coverImages {} — no per-cover error, one line in the log, nothing to
      // diagnose from afterwards. Observed on job_1787867402809_z9bwoo3yp
      // (16 pages, skipCovers false, three cover hints, zero covers stored).
      // allSettled keeps the survivors and names the casualty.
      coverAwaitPromise = Promise.allSettled(
        Array.from(streamingCoverPromises.entries()).map(([type, promise]) =>
          promise.catch(err => { err._coverType = type; throw err; })
        )
      ).then(settled => {
        const coverResults = [];
        for (const s of settled) {
          if (s.status === 'fulfilled') { coverResults.push(s.value); continue; }
          const err = s.reason || {};
          log.error(`❌ [UNIFIED] Cover "${err._coverType || 'unknown'}" failed: ${err.message || err}`);
          if (err.stack) log.error(`   ${String(err.stack).split('\n').slice(1, 3).join(' | ')}`);
          // The per-cover reason belongs in the STORED log, not only in the
          // Railway console. Three covers failed identically on seven runs and
          // the only record was a console line that had rolled out of the
          // buffer by the time anyone looked — the stored genLog had zero
          // cover entries, which read as "covers never ran".
          genLog.error('cover_failed', `Cover ${err._coverType || 'unknown'} failed: ${err.message || err}`);
        }
        if (coverResults.length === 0 && settled.length > 0) {
          genLog.error('covers_all_failed', `All ${settled.length} cover generation(s) failed — story ships with no covers`);
        }
        return coverResults;
      }).then(coverResults => {
        timing.coversEnd = Date.now();
        // Map results to coverImages object
        for (const result of coverResults) {
          if (result?.imageData) {
            // Map coverType to frontend expected keys
            const storageKey = result.type === 'frontCover' ? 'frontCover' : result.type;
            coverImages[storageKey] = {
              imageData: result.imageData,
              description: result.description,
              prompt: result.prompt,
              // THE COVER RECORD IS THE SINGLE GATE ON WHAT REACHES
              // stories.data. `prompt` above is the pre-shrink build; this is
              // the scene block the model was actually handed when that build
              // went over the cap. Absent from this whitelist, the field died
              // here even once the generator returned it — measured on staging
              // job_1789584708605_rts4wqupm: absent on all three cover roots
              // and null on all three v0 versions, which resolve from the root.
              compressedScene: result.compressedScene || null,
              qualityScore: result.qualityScore,
              qualityReasoning: result.qualityReasoning,
              wasRegenerated: result.wasRegenerated,
              totalAttempts: result.totalAttempts,
              retryHistory: result.retryHistory,
              referencePhotos: result.referencePhotos,
              landmarkPhotos: result.landmarkPhotos,
              grokRefImages: result.grokRefImages || null,
              modelId: result.modelId,
              // Title rendered INTO the artwork (baked mode) — the app-side
              // typography pass must not stamp a second one.
              titleBaked: result.titleBaked === true,
              generatedAt: new Date().toISOString()
            };
          }
        }
        log.debug(`✅ [UNIFIED] All ${Object.keys(coverImages).length} cover images complete`);
        log.debug(`⏱️ [UNIFIED] Cover images: ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
      }).catch(err => {
        timing.coversEnd = Date.now();
        // Reached only if the assembly itself throws — a rejecting cover is
        // already reported per-cover above and no longer lands here.
        log.error(`❌ [UNIFIED] Cover assembly failed: ${err.message}`);
      });
    } else {
      log.debug(`📖 [UNIFIED] No cover images to generate (skipCovers=${skipCovers})`);
    }

    // Wait for landmark photos before generating page images — BOUNDED
    // (owner, 2026-09-05): a page whose scene uses a real landmark must not
    // render before its photo fetch resolves, but a hung fetch must not hang
    // the story either. On timeout the fetch keeps running in the background;
    // pages whose landmark is still unresolved are downgraded per-page below
    // (miss → WARN → prose-only, no fidelity block).
    if (landmarkFetchPromise) {
      const LANDMARK_FETCH_TIMEOUT_MS = 75_000;
      const timedOut = Symbol('landmark-fetch-timeout');
      let fetchTimer = null;
      const raced = await Promise.race([
        landmarkFetchPromise,
        new Promise((r) => { fetchTimer = setTimeout(() => r(timedOut), LANDMARK_FETCH_TIMEOUT_MS); fetchTimer.unref?.(); }),
      ]);
      if (fetchTimer) clearTimeout(fetchTimer);
      if (raced === timedOut) {
        log.warn(`⚠️ [UNIFIED] Landmark photo fetch still unresolved after ${LANDMARK_FETCH_TIMEOUT_MS / 1000}s — pages whose landmark has no photo yet render from their prose description only`);
      }
      const successCount = (visualBible.locations || []).filter(l => l.photoFetchStatus === 'success').length;
      log.info(`🌍 [UNIFIED] Landmark photos ready: ${successCount}/${landmarkCount} fetched successfully`);
    }

    // Wait for reference sheet generation (for secondary element consistency)
    let referenceSheetSourceGrids = null;
    let referenceSheetBatchMeta = null;
    if (referenceSheetPromise) {
      const refResult = await referenceSheetPromise;
      // TRIAL: the sheet was rendered onto the stream-time bible object; the page
      // phase below reads this finished parse. Carry the cells over (a full story
      // renders on `visualBible` itself, so there is nothing to carry).
      if (inputData.trialMode && streamingVisualBible && streamingVisualBible !== visualBible) {
        const carried = adoptReferenceRenders(streamingVisualBible, visualBible);
        log.info(`🖼️ [TRIAL] Carried ${carried} reference cell(s) from the stream-time bible onto the final parse`);
      }
      resolveRefSheetsReady();
      if (refResult.generated > 0) {
        log.info(`🖼️ [UNIFIED] Reference images ready: ${refResult.generated} generated for secondary elements`);
      }
      // Capture source grids + batch metadata. The image bytes go to
      // story_images (saved after upsert). The lightweight metadata
      // (element names per batch) goes into storyData so the dev panel can
      // label which cell corresponds to which element.
      referenceSheetSourceGrids = refResult.sourceGrids || null;
      if (referenceSheetSourceGrids) {
        referenceSheetBatchMeta = referenceSheetSourceGrids.map(g => ({
          batchIdx: g.batchIdx,
          elementNames: g.elementNames,
          elementIds: g.elementIds,
        }));
      }
    }
    // ALWAYS release the gate, including the no-sheets paths (nothing to
    // generate, generation failed, skipImages). A cover awaiting a promise that
    // never resolves would hang the whole job.
    resolveRefSheetsReady();

    // PHASE 5: Generate page images
    // Sequential mode when incremental consistency is enabled, parallel otherwise
    await checkCancellation();
    genLog.setStage('images');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [60, 'Generating page illustrations...', jobId]  // 60 = images start (images are only ~4% of wall clock)
    );

    timing.pagesStart = Date.now();

    // ── TEXT REFINEMENT, IN PARALLEL WITH IMAGES ──────────────────────────
    // Scenes are locked before the kickoff, so image generation and prose
    // polishing are independent: the refiner receives the scene outlines
    // READ-ONLY and may only rewrite page prose, never events. Starting it as
    // early as its inputs allow hides as much of its wall-clock as possible
    // behind the phases that follow, whereas a pass started after them would
    // add its full duration to the total.
    // WHAT THE NUMBERS ACTUALLY ARE (corrected 2026-09-14). An older version of
    // this comment — and the commit that moved the join, 2beda5425 — claimed
    // "images take ~25 min". They do not: PURE page generation is ~55s (Grok,
    // 18 pages, parallel). The ~25 minutes is the REPAIR phase, which starts
    // after the join. The refine chain measures 400-600s and up to ~880s, so it
    // is NOT hidden behind pure generation; the join waits for it.
    // Never blocks and never throws: a failed refinement leaves the original
    // text in place (startBackgroundRefine swallows and logs).
    // TRIAL SKIPS REFINEMENT (owner 2026-08-15). The "costs no wall-clock"
    // premise above holds only when images take minutes: a trial renders all 5
    // pages in ~15s (Grok, no eval, no repair) and has no repair phase behind
    // which the chain could run, so a minutes-long polish pass would be added
    // wholesale to a ~230s run. Measured on both staging trials when it was
    // still enabled: refinement hit the join cap every time and the refined
    // text was DISCARDED — the wait, plus two rounds of tokens, for nothing.
    // The cap is gone now, which makes the trial exclusion MORE important, not
    // less: without it the trial would wait out the whole chain.
    // (The chain itself is kicked off further up, the moment page text is
    // final — see "TEXT REFINEMENT — KICKED OFF THE MOMENT PAGE TEXT IS FINAL".)

    // ── TEXT-REFINE JOIN — RUNS ONCE, BEFORE ANYTHING READS THE PAGE TEXT ──
    // Idempotent: the first call joins the refiner and rewrites the page text
    // in `expandedScenes`, in `fullStoryText`, and in every page-object list
    // passed as `targets`; every later call is a no-op.
    //
    // ORDERING (owner, 2026-09-13). This used to run AFTER the repair
    // pipeline, which meant the mid-loop book audit inside that pipeline read
    // PRE-REFINE prose and routed IMG faults from it — image repairs driven by
    // a comparison against wording the book would not contain. Measured on 12
    // staging stories: the refiner rewrote 172 of 178 pages (97%), and 42% of
    // the shipped words on one book were absent from the text the audit read.
    // It is not only wording: the refiner merges dialogue, drops beats and
    // changes the depicted action, which is exactly what an IMG fault judges.
    let textRefineJoined = false;
    const joinTextRefinement = async (targets = []) => {
      if (textRefineJoined) return;
      textRefineJoined = true;
      // ── JOIN THE PARALLEL TEXT REFINEMENT ─────────────────────────────────
      // Started back at pagesStart. Resolves to null on any failure — the
      // original text simply stays.
      //
      // UNBOUNDED, AND THAT IS THE POINT (owner, 2026-09-14). This await was
      // bounded from 2026-08-10 on the premise that "images take ~25 min, so
      // anything still running here is anomalous". The premise was wrong, and
      // the commit that moved this join (2beda5425) repeated it: PURE page
      // generation is ~55s (Grok, 18 pages, parallel) — the ~25 minutes is the
      // REPAIR phase, which now runs AFTER this point. The refiner's headroom
      // went from ~1460s to ~99s and the race started losing every time: 3 of 3
      // staging stories after that commit, two of them with ZERO refine rounds.
      // Measured chains run 400-600s, with 743/770/841/878s inside one month.
      // Nothing cancels the chain when the race is lost, so the deadline never
      // saved a franc — it discarded ~$1.01 of paid work and the whole text
      // audit with it. The join therefore WAITS: the chain is never truncated,
      // and the book audit downstream reads the FINAL text.
      // It cannot wait forever — every model call in the chain is bounded by
      // textModels' streaming ceiling (>=1500s) and its 120s inactivity abort,
      // each audit by its own 900s hostage guard, and every step catches its
      // own failure. Slowness is reported, never acted on: see the warning
      // below. (docs/decisions.md, 2026-09-14.)
      if (textRefinePromise) {
        // HISTORY OF THE CAP THAT IS NOW GONE — kept so it is not re-derived.
        // 300s, not 90s (owner 2026-08-17). The cap existed so a slow refiner could not
        // add its full duration to a story, but 90s was shorter than the refiner's
        // own runtime: deepseek needs ~2-4 min for two rounds, so a fast image phase
        // meant the pass was DISCARDED after being paid for (staging
        // job_1786998860057_o6deqtv5s: $0.16 and 23k output tokens thrown away).
        // Worst case now adds up to 5 min on a run whose images finished early.
        // SCALED (2026-08-24). A flat 300s was measured on a stage that had no
        // blind audit in front of it — that landed 2026-08-23 and roughly doubled
        // the stage, so the budget no longer matched the work. It is also
        // reading-level sensitive: a `standard` book's audit emitted 2.3x the
        // output tokens of a `1st-grade` one (18.4k vs 7.9k on two runs the same
        // evening), and its single round outweighed a whole 1st-grade round. The
        // long-text levels got double the base, plus a per-page allowance beyond
        // ten pages. Salvage below is what makes overrunning cheap; this only
        // decides how long a user waits for the last round.
        // UNSPLIT (2026-09-14). The reading-level halves are gone — every book
        // gets the long base; the per-page allowance stays.
        // NO DEADLINE (owner, 2026-09-14). The budget above is now only the
        // point at which a still-running chain is worth a log line; the join
        // waits for the chain either way. See awaitTextRefineJoin.
        const {
          computeTextRefineJoinWarnMs, awaitTextRefineJoin, isTotalTextAuditLoss,
        } = require('./server/lib/textRefine');
        const JOIN_WARN_MS = computeTextRefineJoinWarnMs(
          expandedScenes?.length || 0,
          process.env.TEXT_REFINE_JOIN_WARN_MS,
        );
        const { usable, source, waitedMs, slow } = await awaitTextRefineJoin(
          textRefinePromise,
          () => textRefinePartial,
          {
            warnAfterMs: JOIN_WARN_MS,
            onSlow: (ms) => {
              const secs = (ms / 1000).toFixed(0);
              log.warn(`⚠️ [TEXT-REFINE] still running ${secs}s after images completed — waiting for it, the book audit downstream must read the final text`);
              genLog.warn('text_refine_join_slow', `Text refinement is still running ${secs}s after images completed — the pipeline waits for it rather than truncating the chain, because every stage below (the book audit first) must read the text that ships. The chain's own per-call ceilings bound this wait.`);
            },
          }
        );
        if (slow) {
          genLog.info('text_refine_join_slow_done', `Text refinement finished after a ${(waitedMs / 1000).toFixed(1)}s join wait (${source})`);
        }
        if (source === 'partial' || source === 'original' || source === 'failed') {
          // The chain FAILED — it was never cut short. Salvage whatever it
          // published, and rank the loss the way the gate's loss deserves.
          if (!isTotalTextAuditLoss(usable)) {
            log.warn(`⚠️ [TEXT-REFINE] the chain did not deliver a complete result — shipping ${usable.rounds.length} completed round(s)`);
            genLog.warn('text_refine_join_partial', `Text refinement failed before it finished — kept ${usable.rounds.length} completed round(s), rewrote page(s) ${usable.changed.join(', ')}; the unfinished step's share of the text audit did not apply, so those pages went unchecked for the faults it exists to catch, text/picture alignment among them`);
          } else {
            // TOTAL loss — ERROR, not warn (owner, 2026-09-14). Nothing landed:
            // the whole text-quality gate is gone, which is a bigger loss than
            // one styled avatar (avatar_guarantee_fallback, logged at error).
            // The old wording — "original text kept" — read like a benign
            // fallback and named nothing that was lost.
            log.error(`❌ [TEXT-REFINE] the chain failed with no round finished — the ENTIRE text audit is discarded, the unchecked text ships`);
            genLog.error('text_refine_join_failed', `Text refinement failed and no round landed — the text audit did not apply: nothing checked these pages for the faults its two auditors exist to catch, text/picture alignment among them; the unrefined text ships as written`);
          }
        }
        // STORE THE REPORT WHENEVER THE CHAIN PRODUCED ONE (2026-09-20).
        // This projection used to sit behind `usable?.changed?.length`, so a run
        // whose audits found faults and whose repair closed none of them stored
        // NOTHING — no ledger, no audits, no merge stats, no word budget, no
        // failed round. Staging's 94 stories carrying a report show 0 unresolved
        // findings and 0 quote-absent drops ever, which the guard alone would
        // explain: the runs that HAD them were the runs it discarded.
        //
        // "Ran and changed nothing" vs "did not run" is the `usable` object, not
        // the page count. We are inside `if (textRefinePromise)`, so the chain
        // started; `usable` is refineStoryText's return or the last snapshot it
        // published, and it is null only when the chain rejected before ever
        // publishing — nothing to project, and no empty husk is written.
        //
        // The projection itself moved to textRefine.projectTextRefineReport,
        // verbatim, so it can be replayed over a stored run in a test.
        if (usable) {
          const beforeByPage = new Map(
            (expandedScenes || []).map(sc => [sc.pageNumber, sc.text || ''])
          );
          const { projectTextRefineReport } = require('./server/lib/textRefine');
          textRefineReport = projectTextRefineReport(usable, beforeByPage);
        }
        if (usable?.changed?.length) {
          // BOTH arrays: allImages[].text is a COPY taken when the page was
          // prepared, so updating only the scene would leave the saved story on
          // the pre-refinement prose.
          const byPage = new Map(usable.pages.map(p => [p.pageNumber, p.text]));
          for (const scene of expandedScenes) {
            const t = byPage.get(scene.pageNumber);
            if (t) scene.text = t;
          }
          // Every page-object list the caller handed us: rawImages before the
          // repair pipeline, allImages on the late fallback call. Each is a COPY
          // of the page text taken when the page was prepared.
          for (const list of targets) {
            for (const img of list || []) {
              const t = byPage.get(img.pageNumber);
              if (t) img.text = t;
            }
          }
          // THIRD store: data.story / data.storyText are assembled from the
          // pre-refine pages and persisted as-is, and the Lab's edit mode reads
          // THEM — so without this rebuild the editor showed the original text
          // while the book showed the refined one (caught by the owner on p18 of
          // the first arc-pipeline run: "Das reicht." vs the refined ending).
          fullStoryText = storyPages.map(page =>
            `--- Page ${page.pageNumber} ---\n${byPage.get(page.pageNumber) || page.text}`
          ).join('\n\n');
          const totalMs = usable.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0);
          // A salvaged snapshot already logged text_refine_join_partial, which
          // says what was kept AND what was abandoned. Emitting "complete" here
          // too would read as a clean finish and hide the abandoned round.
          if (!usable.partial) {
            genLog.info(
              'text_refine_complete',
              `Text refined in ${usable.rounds.length} round(s), ${(totalMs / 1000).toFixed(1)}s — rewrote page(s) ${usable.changed.join(', ')}`,
              null,
              { rounds: usable.rounds.length, changedPages: usable.changed, durationMs: totalMs }
            );
          }
        } else if (usable && !usable.partial) {
          // "Nothing to rewrite" and "a round failed" are different outcomes — a
          // failed round means the ORIGINAL text ships unreviewed, which must be
          // visible in the log, not filed as a clean convergence.
          const failedRound = (usable.rounds || []).find(r => !r.ok);
          if (failedRound) {
            genLog.warn('text_refine_failed', `Text refinement round ${failedRound.round} failed (${failedRound.error}) — original text kept`);
          } else {
            genLog.info('text_refine_complete', 'Text refinement found nothing to rewrite');
          }
        }
      }
    };
    // The other two review stages' before/after (beats mode only). Same shape,
    // captured inside generateStoryViaBeats at each rewrite; null on the
    // unified path, which has no beats or scene review.
    const beatsReviewReport = beatsResult?.beatsReviewReport || null;
    // The Jev decision layer's report (2026-09-27): cast cuts, shots, light,
    // VB citations, aboard, population, gaze — every decision per page, so a
    // run can be replayed. docs/decisions.md "Jev decision layer wired".
    const jevDecisions = beatsResult?.jevDecisions || null;
    // Set when the Jev-outage backup ran (owner exception, 2026-09-27): {step, reason, at}.
    // A trial's only Jev step is its landmark selection (trialJev below).
    const jevFallback = beatsResult?.jevFallback || trialJev.fallback || null;
    // Drafted arc + the arc reviewer's analysis, so a shipped story can be read
    // back against the arc it promised.
    const arcReviewReport = beatsResult?.arcReviewReport || null;
    // The challenges from this account's earlier books that the arc planner was
    // told to avoid. Stored so a repeat can be audited against what was excluded.
    const challengeDrawIds = beatsResult?.challengeDrawIds || null;
    // Which drawn challenges the arc actually built on, by catalogue id — the
    // join that makes "was the draw used" a query rather than a prose read.
    const challengeTakenIds = beatsResult?.challengeTakenIds || null;
    const challengeDraw = beatsResult?.challengeDraw || null;
    const clothingReviewReport = beatsResult?.clothingReviewReport || null;
    // The wardrobe call's prompt + raw reply, and the wardrobe-vs-Visual-Bible
    // check's findings (adopt / conflict) — diagnostics, stored with the story.
    const storyBibleReport = beatsResult?.storyBibleReport || null;
    const wardrobeBibleReport = beatsResult?.wardrobeBibleReport || null;
    // The brief checks and their one re-ask (2026-09-28) — the scene review's
    // successor; before/after per re-asked page.
    const briefCheckReport = beatsResult?.briefCheckReport || null;
    // The prompt that WROTE the briefs, next to the one that reviewed them.
    // Beats contributes the timings and which pages fell back to a per-page
    // call; `prompts[]` is the story-wide prompt table every page references
    // (see the roll-up above) and is the ONLY copy of the Art Director prompt.
    const sceneExpansionReport = {
      ...(beatsResult?.sceneExpansionReport || {}),
      prompts: scenePromptTable,
    };
    // The page-text writer's own call (beats mode). storyTextPrompts is the
    // EXISTING home for "the prompt that wrote the pages + its raw reply" and
    // the dev-mode "Full API Output (Story Text)" panel already renders it —
    // beats mode just shipped it empty, so the writer's Step-1 ---ANALYSIS---
    // block (page-by-page continuity reasoning) was parsed and thrown away.
    // One entry: beats writes every page in a single call.
    const storyTextPrompts = beatsResult?.meta?.storyTextCall
      ? [{
        batch: 1,
        startPage: beatsResult.meta.storyTextCall.startPage,
        endPage: beatsResult.meta.storyTextCall.endPage,
        prompt: beatsResult.meta.storyTextCall.prompt,
        rawResponse: beatsResult.meta.storyTextCall.rawResponse,
        analysis: beatsResult.meta.storyTextCall.analysis,
        modelId: beatsResult.meta.storyTextCall.modelId,
        usage: beatsResult.meta.storyTextCall.usage,
      }]
      : [];
    let allImages;
    let pipelineEntityReport = null;
    let pipelineEntityHistory = null;
    let pipelineCharFixDetails = null;
    let pipelineStyleConsistency = null;
    // Compact record of each mid-loop book audit (one per repair round that had
    // a further round to feed). See the repair loop's MID-LOOP BOOK AUDIT block.
    let pipelineBookAuditRounds = null;
    let pipelineRepairRounds = null;
    // Dimensions that went UNJUDGED (2026-09-14) — rolled up from the picked
    // version of every page. See server/lib/notEvaluated.js.
    let pipelineNotEvaluated = null;
    // Pages that ship below the repair threshold or still carrying a CRITICAL
    // (D7): the run must say so somewhere a reader will find it.
    let pipelineShippedDefective = null;
    let pipelineSurvivingCriticals = null;

    {
      // =======================================================================
      // UNIFIED PIPELINE: Generate all → Evaluate → Repair (if enabled)
      // =======================================================================
      const _reqPasses = parseInt(inputData.maxRepairPasses, 10);
      const repairPasses = Number.isFinite(_reqPasses)
        ? Math.max(0, Math.min(REPAIR_DEFAULTS.maxPasses, _reqPasses))
        : REPAIR_DEFAULTS.maxPasses;
      log.info(`🚀 [UNIFIED] Using unified pipeline (fullRepair=${enableFullRepair}, repairPasses=${repairPasses})`);

      // Helper function to prepare page data without generation (for later use by pipeline)
      const preparePageData = async (scene, index) => {
        const pageNum = scene.pageNumber;
        // A full-story COVER page: the page path with its cover-only render
        // options (aspect, copy space always in the image, baked title, text
        // contract). null for every story page.
        const coverOpts = require('./server/lib/coverRender').coverRenderOptions(pageNum, {
          title: title || inputData.title || inputData.storyTitle || '',
          dedication: inputData.dedication || null,
          coverTitleMode: modelOverrides.coverTitleMode || null,
        });

        // Spread-parity flip: when Sonnet picks a textPosition on the wrong
        // side for the spread (odd=left / even=right), enforceSpreadTextPosition
        // flips the corner. The prose Sonnet wrote — character positions, path
        // direction, vanishing-point references, "upper-X corner" surfaces —
        // was anchored to the original side, so the empty scene and page image
        // would receive a calm-zone instruction on one side and geometry
        // pointing at the other. Mirror left↔right in the prose + emptyScene
        // prompt so both renderers see side-consistent geometry.
        //
        // mirrorLeftRight only swaps directional uses of left/right (compound
        // corners, positional-noun followers, prepositional, visual-verb
        // contexts, possessive + body-noun) — bare verb/idiom uses ("she left",
        // "what was left", "right away") are preserved.
        try {
          const { mirrorLeftRight } = require('./server/lib/storyHelpers');
          const sonnetMeta = extractSceneMetadata(scene.sceneDescription);
          const sonnetTP = sonnetMeta?.textPosition || null;
          const correctedTP = enforceSpreadTextPosition(sonnetTP, pageNum);
          if (sonnetTP && correctedTP && sonnetTP !== correctedTP) {
            log.warn(`🪞 [SIDE-MIRROR] Page ${pageNum}: textPosition ${sonnetTP} → ${correctedTP}; mirroring left↔right in scene prose + emptyScenePrompt`);
            scene.sceneDescription = mirrorLeftRight(scene.sceneDescription);
            // The mirror flips textPosition inside the metadata block too
            // (e.g. "top-left" → "top-right"). That's actually what we want
            // since the corrected value matches, but be defensive: stamp the
            // corrected value back in case the metadata had a different shape.
            scene.sceneDescription = scene.sceneDescription.replace(
              /("textPosition"\s*:\s*")(top-left|top-right|bottom-left|bottom-right|top-full|bottom-full)(")/g,
              `$1${correctedTP}$3`
            );
            if (scene.emptyScenePrompt) scene.emptyScenePrompt = mirrorLeftRight(scene.emptyScenePrompt);
            if (scene.sceneHint && typeof scene.sceneHint === 'string' && scene.sceneHint.includes('emptyScenePrompt')) {
              scene.sceneHint = mirrorLeftRight(scene.sceneHint).replace(
                /("textPosition"\s*:\s*")(top-left|top-right|bottom-left|bottom-right|top-full|bottom-full)(")/g,
                `$1${correctedTP}$3`
              );
            }
          }
        } catch (err) {
          log.warn(`[SIDE-MIRROR] Page ${pageNum}: mirror step failed, continuing without flip — ${err.message}`);
        }

        // UNION, never replacement (see unionPageCast). The brief prose and the
        // outline hint each drop cast the other keeps: a hint with an empty
        // `characters[]` scans down to whatever names happen to sit in its JSON
        // (garment owners), and prose that describes a figure without naming it
        // scans down to the named subset. This is the roster every presence
        // check downstream is measured against.
        //
        // The hint side is `characters[]` ONLY. Per-page `characterClothing` is
        // NOT a cast signal, and reading its keys was measured to be wrong: on
        // job_1789207854566_l43qgl34w p3 and p11 the outline commissioned no
        // people at all and still emitted a clothing entry for all five, which
        // put a cast of five onto two empty pages.
        const sceneCharacters = unionPageCast(
          scene.sceneDescription,
          scene.characters || [],
          inputData.characters
        );
        // Characters section takes priority over scene metadata JSON (may have stale costume data)
        const sceneMetadataForClothing = extractSceneMetadata(scene.sceneDescription);
        const perCharClothing = {
          ...(sceneMetadataForClothing?.characterClothing || {}),
          ...(scene.characterClothing || {})
        };
        // Warn when scene expansion metadata disagrees with outline clothing
        // (the outline wins via the spread operator above, but the prose may still
        // describe the wrong outfit — the prompt fix in scene-expansion.txt addresses this)
        const outlineClothing = scene.characterClothing || {};
        const sceneClothing = sceneMetadataForClothing?.characterClothing || {};
        for (const [name, outfitFromOutline] of Object.entries(outlineClothing)) {
          const outfitFromScene = sceneClothing[name];
          if (outfitFromScene && outfitFromScene !== outfitFromOutline) {
            log.warn(`⚠️ [CLOTHING MISMATCH] P${pageNum} ${name}: outline="${outfitFromOutline}" but scene expansion wrote "${outfitFromScene}" — using outline`);
          }
        }
        // Trial mode fallback: if parser didn't extract clothing from JSON scene hint,
        // use the trial costume type for main characters
        if (inputData.trialMode && inputData._trialCostumeType && Object.keys(perCharClothing).length === 0) {
          const mainCharIds = inputData.mainCharacters || [];
          for (const char of (inputData.characters || [])) {
            const isMain = char.isMainCharacter === true || mainCharIds.includes(char.id);
            if (isMain) {
              perCharClothing[char.name] = 'costumed';
              log.debug(`🎭 [TRIAL COSTUME] Page ${pageNum}: Fallback — no clothing parsed, using costumed for ${char.name}`);
            }
          }
        }
        const defaultClothing = 'standard';
        const sceneClothingRequirements = buildSceneClothingRequirements(
          sceneCharacters,
          perCharClothing,
          clothingRequirements
        );
        let pagePhotos = getCharacterPhotoDetails(sceneCharacters, defaultClothing, inputData.artStyle, sceneClothingRequirements);
        // applyStyledAvatars now skips costumed-* entries internally (see
        // styledAvatars.js), so it's safe to call on a mixed-clothing scene.
        pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
        let sceneMetadata = extractSceneMetadata(scene.sceneDescription);
        // The Art Director must not describe a cast member in the prose and
        // leave them out of metadata `characters` — the image model renders
        // the prose, every supervisor (figure naming, entity grid, clothing
        // validation, garment repair) reads the list, so an unlisted character
        // is drawn and never checked. Warn only, never repair: a name can be
        // present without the person being in the frame, and appending a figure
        // the picture may not contain is the worse failure.
        const castMissing = findCastMissingFromMetadata(
          scene.sceneDescription,
          (inputData.characters || []).map(c => c.name),
          sceneMetadata,
          [],
          storyCastIndex
        );
        if (castMissing.length > 0) {
          const listed = (sceneMetadata?.characters || []).join(', ') || 'none';
          log.warn(`⚠️ [SCENE CAST] P${pageNum}: prose describes ${castMissing.join(', ')} but metadata characters[] lists ${listed} — unlisted characters are rendered and never supervised`);
          if (sceneMetadata) sceneMetadata.castMissingFromMetadata = castMissing;
        }
        // Phase 7: cell-crop refs from story-scoped 2×4 sheets when present.
        {
          const sav = require('./server/lib/storyAvatars');
          const storyAvatars = sav.projectStoryCharacterAvatars(inputData.characters || [], inputData.artStyle || 'pixar');
          const metaChars = sceneMetadata?.fullData?.characters || sceneMetadata?.characters || sceneCharacters || [];
          await sav.applyStoryCellRefs(pagePhotos, storyAvatars, metaChars, {
            closeUp: sceneMetadata?.fullData?.shot === 'close-up',
            // Wardrobe state: a page that takes a garment OFF gets the cell
            // cropped from the `--off:` sheet when one exists, so the attached
            // reference agrees with the brief instead of contradicting it.
            wornResolved: sav.wornResolvedForPage(streamingVisualBible, sceneMetadata, metaChars, pageNum),
          });
        }
        // over-the-shoulder: drop refs ONLY for background-depth characters.
        // Original rule dropped ALL non-actor refs on the assumption "the target
        // is tiny, soft-focused, in the distance" — but OTS is also used with
        // midground subjects (e.g. character across a fence, holding an object).
        // Smoke #7 page 2 caught the regression: Noah was midground, ref got
        // dropped, Grok had only text → rendered Noah in wrong outfit (blue
        // button-up instead of olive sweatshirt + red backpack). Background
        // figures still need the drop — attaching their portrait forces Grok
        // to upsize them past "tiny in the distance".
        // ONE camera field (2026-09-19): over-the-shoulder is a `shot` value
        // like any other, not a second field beside it. framingPattern is gone.
        const pageShot = String(sceneMetadata?.fullData?.shot || sceneMetadata?.shot || '');
        if (pageShot === 'over-the-shoulder' && pagePhotos.length > 1) {
          const metaChars = sceneMetadata?.fullData?.characters || [];
          const isBackground = (name) => {
            const c = metaChars.find(mc => (mc.name || '').toLowerCase() === (name || '').toLowerCase());
            return (c?.depth || '').toLowerCase() === 'background';
          };
          const before = pagePhotos.length;
          // Always keep the actor (index 0); among the rest, drop only bg refs.
          pagePhotos = pagePhotos.filter((p, i) => i === 0 || !isBackground(p.name));
          if (pagePhotos.length < before) {
            log.info(`🎯 [FRAMING] Page ${pageNum} over-the-shoulder: kept actor + ${pagePhotos.length - 1} non-bg refs, dropped ${before - pagePhotos.length} background refs`);
          }
        }
        // Trial mode fallback: scene hints are plain text, so extract LOC IDs manually
        if (!sceneMetadata && scene.sceneDescription) {
          const locMatches = [...scene.sceneDescription.matchAll(/\[LOC(\d+)\]/gi)];
          const locNameMatches = [...scene.sceneDescription.matchAll(/([A-Za-zÀ-ÿ][\w\s()-]*?)\s*\[LOC\d+\]/gi)];
          if (locMatches.length > 0) {
            sceneMetadata = {
              objects: locMatches.map((m, i) => {
                const name = locNameMatches[i]?.[1]?.trim() || '';
                return name ? `${name} [LOC${m[1].padStart(3, '0')}]` : `LOC${m[1].padStart(3, '0')}`;
              }),
              setting: {},
              isJsonFormat: false,
            };
          }
        }
        // Misses = landmarks this scene cites that SHOULD have produced a
        // photo but couldn't (fetch failed / nothing servable). The page then
        // renders from its prose description only, and because every prompt
        // fidelity block is built from landmarkPhotos[0], no "preserve this
        // exact building / immediately recognisable" block ships without its
        // photo. ensureLandmarkPhotoBytes enforces the same invariant for
        // URL-only entries (block ⇔ bytes). Dragon run
        // job_1788551692337_bc479p945 rendered 5 landmark pages blind with
        // zero warnings; this makes that failure loud and the downgrade
        // deliberate.
        const landmarkPhotoMisses = [];
        let pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata, { pageNumber: pageNum, misses: landmarkPhotoMisses });
        pageLandmarkPhotos = await ensureLandmarkPhotoBytes(pageLandmarkPhotos, { misses: landmarkPhotoMisses });
        if (landmarkPhotoMisses.length > 0) {
          log.warn(`⚠️ [LANDMARK] Page ${pageNum} renders WITHOUT its landmark reference photo (${landmarkPhotoMisses.map(m => `${m.name}: ${m.reason}`).join('; ')}) — downgraded to prose description, no exact-building fidelity block`);
        }
        // The page prompt lists the scene's objects[] (the Art Director's pick);
        // pass the same ids so a prop the prompt describes brings its reference
        // image even when the VB filed it under a different page.
        // Cap 4, not 6 (owner, 2026-08-29). Census of staging
        // job_1787959478282_bz19gm36h: 10 of 14 pages sent 5-6 grid cells, and
        // every page also spent one of them on the ship and one or two on
        // locations the plate already paints. The grid shares ONE Grok
        // reference slot, so every extra cell shrinks all the others —
        // 6 cells is 4 elements' worth of unreadable.
        // Cap = the owner's brief-side VB element budget (2026-09-06): three, the
        // same number the Art Director is given and the pipeline truncates to.
        // The PHYSICAL grid bound, not the element budget (owner, 2026-09-11:
        // no code-side enforcement of the budget — it is a prompt rule for the
        // Art Director and a scene-review fault, nothing more). One Grok slot,
        // cell size 1/n, a face below VB_CELL_FLOOR_PX gets replaced by a prior.
        // Selection: the page's elements (objects[] + worn-item dedupe) plus the
        // ids the brief cites — the ONE selector the Test Lab image stage uses
        // too (server/lib/pageRenderCall.js).
        let elementReferences = require('./server/lib/pageRenderCall').selectPageElementRefs(visualBible, pageNum, sceneMetadata);
        // NOTE: the plate-aware filter does NOT live here. `sceneBackgrounds` is
        // populated by Phase 5a-pre / 5a-pre-vantage, both of which run AFTER
        // this pageData map (they iterate the pageDataArray it produces), so at
        // this point the map is `{}` on every non-trial story and a filter here
        // is structurally dead — which is exactly what shipped: all 14 pages of
        // job_1787959478282_bz19gm36h sent their locations AND the ship as grid
        // cards despite every page having a plate. Selection happens here;
        // filtering + grid construction happen in Phase 5a-pre-grid below, once
        // we know which pages actually got a plate.
        const secondaryLandmarks = pageLandmarkPhotos.slice(1);
        // The page model tier and the prompt closure — the ONE implementation the
        // Test Lab image stage calls too (server/lib/pageRenderCall.js).
        const pageRender = require('./server/lib/pageRenderCall');
        const { pageImageModel, pageImageBackend, sceneComplexity } = pageRender.pageRenderModel({
          sceneMetadata, modelOverrides, coverOpts, pageNumber: pageNum,
        });
        // ORDERING BUG, fixed 2026-09-15. `vbRefElementIds` decides whether the
        // prompt says "the attached reference images include a rough image of
        // <X>" (promptBuilders REQUIRED OBJECTS). It used to be computed HERE,
        // from the UNFILTERED selection, while Phase 5a-pre-grid drops cells
        // afterwards — so a page could be told to match a reference it was
        // never given. The prompt is now built through this closure and rebuilt
        // in 5a-pre-grid from the cells actually sent, which is what the trial
        // path (`trialVbGrid.rawElements`) and the iterate path (images.js)
        // already do.
        const makeImagePrompt = pageRender.makePageImagePrompt({
          sceneDescription: scene.sceneDescription, inputData, sceneCharacters, visualBible,
          pageNumber: pageNum, characterPhotos: pagePhotos, pageImageModel, coverOpts,
        });
        const imagePrompt = makeImagePrompt(elementReferences.map(r => r.id).filter(Boolean));
        // Extract emptyScenePrompt from outline hint (Sonnet-generated, high quality)
        // Falls back to scene expansion's emptyScenePrompt via sceneMetadata
        const outlineEmptyScenePrompt = require('./server/lib/platePipeline').outlineEmptyScenePromptOf(scene);

        return {
          pageNumber: pageNum,
          index,
          scene,
          prompt: imagePrompt,
          // Rebuilt in Phase 5a-pre-grid from the cells actually sent.
          makeImagePrompt,
          characterPhotos: pagePhotos,
          landmarkPhotos: pageLandmarkPhotos,
          // Landmarks this page cited but renders without (photo unavailable) —
          // names only, for logs/dev UI; the downgrade already happened above.
          landmarkPhotoMisses: landmarkPhotoMisses.map(m => m.name),
          // Built in Phase 5a-pre-grid, once the plates are known.
          visualBibleGrid: null,
          vbElementRefs: elementReferences,
          vbSecondaryLandmarks: secondaryLandmarks,
          sceneCharacters,
          sceneMetadata,
          perCharClothing,
          pageImageModel,
          pageImageBackend,
          sceneComplexity,
          // Outline-level emptyScenePrompt (from Sonnet) — used if scene expansion doesn't produce one
          emptyScenePrompt: outlineEmptyScenePrompt,
          // Cover pages only (null on story pages) — see coverRender.js.
          coverOpts,
          // The aspect and the copy-space switch this page renders with: a
          // cover's own (coverAspect; text always in the image), else the
          // book layout's.
          renderAspect: coverOpts ? coverOpts.aspectRatio : (inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect),
          textInImage: coverOpts ? true : (inputData?.layout?.textInImage !== false),
        };
      };

      // Join the avatar-styling chain before ANY page crops a cell from it.
      // Same await discipline as the three earlier joins (trial page, trial
      // cover, pre-cover styling): the promise is a rolling chain, and every
      // consumer of the sheets awaits whatever the chain holds at the moment it
      // needs them. The wardrobe-variant kickoff (Phase 4) REASSIGNS this
      // variable after the last of those joins, so without this one the
      // `--off:` sheets were consumed by `applyStoryCellRefs` below while they
      // were still rendering — the crop found no `styled-…--off:` key, warned
      // loudly, and served the WORN sheet (pre-feature behaviour). Only the
      // narrative work between the kickoff and here (translation, lector)
      // happened to buy enough time; nothing synchronised them.
      //
      // This is a join, not a move of the start point: variants still render
      // alongside that narrative work. It never blocks on SUCCESS either — the
      // kickoff swallows a refusal / eval rejection / provider error into a
      // warn, so a failed variant settles the chain promptly and the loud
      // worn-sheet fallback in resolveSheetForRef stays exactly as designed.
      if (!skipImages && streamingAvatarStylingPromise) {
        log.debug(`🎨 [UNIFIED] Phase 5a: waiting for avatar styling (incl. wardrobe variants) before page cell crops...`);
        try {
          await streamingAvatarStylingPromise;
        } catch (error) {
          log.warn(`🎨 [UNIFIED] avatar styling chain rejected: ${error.message} — pages fall back to the sheets that did land`);
        }
      }

      // Phase 5a: Prepare all page data
      log.info(`📸 [UNIFIED] Phase 5a: Preparing ${expandedScenes.length} pages${coverScenes.length ? ` + ${coverScenes.length} cover page(s)` : ''} for image generation...`);
      const pageDataArray = await Promise.all(
        [...expandedScenes, ...coverScenes].map((scene, index) => preparePageData(scene, index))
      );

      // Reference-mode + single-pass flags resolved once for the run. Per-page
      // overrides (test-models / iterate) are read in the call sites.
      const runReferenceMode = modelOverrides.referenceMode || MODEL_DEFAULTS.referenceMode || 'strict';
      // Explicit false from the wizard must beat MODEL_DEFAULTS.singlePassScene=true.
      const runSinglePassScene = typeof modelOverrides.singlePassScene === 'boolean'
        ? modelOverrides.singlePassScene
        : MODEL_DEFAULTS.singlePassScene === true;
      log.info(`🎛️ [UNIFIED] referenceMode=${runReferenceMode} singlePassScene=${runSinglePassScene}`);

      // Per-page route decided ONCE for the run and reused by every phase that
      // needs it (plate generation, the VB-grid filter, the page render). The
      // router is a pure function of pageData + inputData, but a single map
      // guarantees the grid filter and the render agree about what gets sent.
      const { decidePageRoute } = require('./server/lib/imageRouter');
      const pageRoutes = new Map(
        pageDataArray.map(pd => [pd.pageNumber, decidePageRoute(pd, inputData, MODEL_DEFAULTS)])
      );
      // A page with no named cast gets no empty-scene plate: the plate exists
      // to anchor character placement, and with nobody to place, the page
      // render IS the scene (owner ruling, 2026-09-02). A plate may still
      // exist for such a page when it shares a vantage with a cast>0 page —
      // that is fine, it just isn't generated FOR it.
      const platelessByRoute = (pageNumber) =>
        pageRoutes.get(pageNumber)?.emptyScene === 'skip';

      // Heartbeat the empty-scene phase: each plate generation bumps
      // story_jobs.updated_at (throttled to 30s) so the phase never looks
      // "stuck" to the status endpoint's heartbeat check, no matter how many
      // plates. Without this a slow batch of parallel image calls went silent
      // for >5 min and the job was failed mid-generation.
      const imageGenHeartbeat = createJobHeartbeat(jobId, dbPool);

      // Phase 5a-pre-vantage: render ONE backdrop canvas per Visual Bible
      // location vantage and reuse it across every page that uses that vantage.
      // Gated on !runSinglePassScene — when single-pass is on the page is
      // rendered prose-only, no backdrop reference attached, and generating
      // vantage canvases would waste budget. Previously this path ran
      // regardless of the flag and the canvases were attached to ref0 anyway
      // (per packReferences), partly defeating singlePassScene.
      if (modelOverrides.generateEmptyScenes !== false && !runSinglePassScene && visualBible?.locations?.length > 0) {
        const { groupPagesByVantage, resolvePagePlate, enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./server/lib/storyHelpers');
        // Covers never share a vantage plate: a vantage canvas is rendered at the
        // PAGE aspect with no copy space; a cover renders its own plate
        // (renderPagePlate) at the cover aspect with its textPosition mask.
        const groups = groupPagesByVantage(pageDataArray.filter(pd => !pd.coverOpts), visualBible);
        const allRealGroups = Array.from(groups.entries()).filter(([key]) => key !== '__unassigned__');
        // A vantage whose pages ALL have zero cast needs no canvas — nobody
        // will be placed on it, so the page render is the scene (owner ruling,
        // 2026-09-02). A mixed group still renders its canvas: the cast>0
        // pages need it, and the cast-0 page in the group simply rides along
        // on the shared plate.
        // A vantage whose pages ALREADY have a plate needs no canvas either:
        // the fan-out at the bottom of this block skips a pre-populated slot
        // (`if (sceneBackgrounds[pn]) continue;`), so rendering the canvas —
        // and running the QC vision call on it — produced an image that was
        // thrown away. Trial mode is the one populator today (it renders one
        // plate PER PAGE during outline streaming), and on a 6-page trial this
        // cost one whole extra plate generation + one QC vision call whose
        // result reached nothing. The condition is deliberately about the SLOTS
        // rather than `trialMode`: it is the same fact the discard at the
        // fan-out already tests, and the per-page path below (Phase 5a-pre)
        // already skips on exactly this ("Skip if already generated"). A group
        // where only SOME pages are pre-filled still renders — the unfilled
        // pages genuinely need the canvas. A non-trial run reaches this block
        // with `sceneBackgrounds` empty (it is declared empty and written only
        // here and in 5a-pre, both of which run after), so `every()` is false
        // for every group and nothing changes.
        const prefilledGroups = allRealGroups.filter(([, group]) =>
          group.pageNumbers.every(pn => sceneBackgrounds[pn]));
        if (prefilledGroups.length > 0) {
          log.info(`🏛️ [VANTAGE] Skipping ${prefilledGroups.length} canvas(es) — every page already has a plate: ${prefilledGroups.map(([vid, g]) => `${vid} (p${g.pageNumbers.join(',')})`).join('; ')}`);
        }
        const realGroups = allRealGroups.filter(([, group]) =>
          group.pageNumbers.some(pn => !platelessByRoute(pn))
          && !group.pageNumbers.every(pn => sceneBackgrounds[pn]));
        // Counted independently of the pre-filled skip above — a group can be
        // both castless and pre-filled, and subtracting both from the total
        // would under- (or negatively) report.
        const castlessSkipped = allRealGroups
          .filter(([, group]) => group.pageNumbers.every(pn => platelessByRoute(pn)))
          .map(([vid, group]) => `${vid} (p${group.pageNumbers.join(',')})`);
        if (castlessSkipped.length > 0) {
          log.info(`🏛️ [VANTAGE] Skipping ${castlessSkipped.length} canvas(es) — every page on them has cast=0: ${castlessSkipped.join('; ')}`);
        }
        // One canvas per VB vantage, reused across every page that uses it.
        // Sonnet assigns a distinct vantage (LOC###.N) whenever the same
        // location is shown from a fundamentally different viewpoint (a cellar
        // from the exterior threshold vs from inside), so pages that share a
        // vantage genuinely share the backdrop — the "which pages share a plate"
        // decision lives in the model, not a code-side text heuristic.
        if (realGroups.length > 0) {
          log.info(`🏛️ [UNIFIED] Phase 5a-pre-vantage: ${realGroups.length} location vantage(s) for ${pageDataArray.length} page(s)`);
          const vStart = Date.now();
          const vLimit = pLimit(20);
          const { getTextAreaMask } = require('./server/lib/textMasks');
          await Promise.all(realGroups.map(([vantageId, group]) => vLimit(async () => {
            await checkCancellation();
            const vantagePlates = await require('./server/lib/platePipeline').renderVantagePlates(vantageId, group, {
              visualBible, inputData, pageDataArray, addUsage, imageGenHeartbeat, genLog,
            });
            // Fan out the canvas to every page in the group — the base plate,
            // or the derived one where the page's own camera earned it.
            for (const [pn, plate] of vantagePlates) {
              if (sceneBackgrounds[pn]) continue; // pre-populated (e.g. trial mode)
              sceneBackgrounds[pn] = plate;
            }
          })));
          const vElapsed = ((Date.now() - vStart) / 1000).toFixed(1);
          const covered = Object.keys(sceneBackgrounds).length;
          log.info(`🏛️ [UNIFIED] Phase 5a-pre-vantage: ${realGroups.length} canvases → ${covered} pages covered in ${vElapsed}s (saved ${Math.max(0, covered - realGroups.length)} redundant generations)`);
        }
      }

      // ONE page's own empty-scene plate (render + QC + one fed-back retry).
      // Phase 5a-pre renders every uncovered page with it, and the page-image
      // retry below reuses it for a landmark page whose plate is missing —
      // one plate mechanism for both. Returns null on failure (logged).
      const renderPagePlate = (pageData) => require('./server/lib/platePipeline').renderPagePlate(pageData, {
        visualBible, inputData, addUsage, imageGenHeartbeat, genLog,
      });
      // Store a rendered plate in the page's slot (same shape for every caller).
      const storePagePlate = (bg) => {
        if (!bg?.imageData) return false;
        sceneBackgrounds[bg.pageNumber] = {
          imageData: bg.imageData,
          prompt: bg.prompt,
          // Refs packed into the plate call — same field name every other
          // image call stores its packed refs under.
          grokRefImages: bg.grokRefImages || null,
          textAreaMask: bg.textAreaMask || null,
          emptySceneVbGrid: bg.emptySceneVbGrid || null,
          // QC history of a retried plate: both attempts and which one shipped.
          ...(require('./server/lib/plateQc').emptySceneQcOf(bg) || {}),
        };
        return true;
      };

      // Phase 5a-pre: Generate empty scene backgrounds (no characters) for style anchoring
      // Note: sceneBackgrounds may already have entries from trial mode early generation
      // OR from Phase 5a-pre-vantage above (vantage canvas covers most pages).
      // PLATE OR FAIL: a landmark page is plated in EVERY mode — single-pass and
      // generateEmptyScenes=false only switch plates off for the other pages
      // (owner, 2026-09-24). Cast-0 pages never get one (the exemption).
      const platesOn = modelOverrides.generateEmptyScenes !== false && !runSinglePassScene;
      const platePageData = pageDataArray.filter(pd => platesOn || pageNeedsPlate(pd, pd.landmarkPhotos));
      if (platePageData.length > 0) {
        log.info(`🎨 [UNIFIED] Phase 5a-pre: Generating ${platePageData.length} empty scene backgrounds${platesOn ? '' : ' (landmark pages only — plates are off for the rest)'}...`);
        const bgStartTime = Date.now();
        const bgLimit = pLimit(50);

        const emptyScenes = await Promise.all(
          platePageData.map(pageData => bgLimit(async () => {
            await checkCancellation();
            // Skip if already generated (e.g., trial mode early generation from
            // visual bible, or a shared vantage canvas fanned out above).
            if (sceneBackgrounds[pageData.pageNumber]) return null;
            // Cast-0 page: no plate. The plate anchors character placement, and
            // with no characters the page render IS the scene (owner ruling,
            // 2026-09-02). Skipping it also lets the page keep its location /
            // vehicle VB grid cells (Phase 5a-pre-grid), which the plate would
            // otherwise displace.
            if (platelessByRoute(pageData.pageNumber)) {
              log.info(`🎨 [EMPTY SCENE] Page ${pageData.pageNumber}: cast=0 → no plate generated (the render is the scene)`);
              return null;
            }
            return renderPagePlate(pageData);
          }))
        );

        // Which pages ended up without a plate, and why, recorded once.
        // Cast-0 pages are excluded — they have no plate BY DESIGN (see the
        // skip above), and warning about a deliberate omission sends the next
        // reader hunting a bug that doesn't exist.
        const platelessPages = platePageData
          .map(pd => pd.pageNumber)
          .filter(pn => !platelessByRoute(pn))
          .filter(pn => !sceneBackgrounds[pn] && !emptyScenes.some(bg => bg?.pageNumber === pn && bg?.imageData));
        if (platelessPages.length > 0) {
          log.warn(`⚠️ [EMPTY SCENE] No background plate for page(s) ${platelessPages.join(', ')} — rendering without one`);
          genLog.warn('empty_scene_missing', `No background plate for page(s) ${platelessPages.join(', ')} — those pages render without one`);
        }

        for (const bg of emptyScenes) storePagePlate(bg);
        const bgElapsed = ((Date.now() - bgStartTime) / 1000).toFixed(1);
        log.info(`🎨 [UNIFIED] Phase 5a-pre: ${Object.keys(sceneBackgrounds).length}/${pageDataArray.length} empty scenes in ${bgElapsed}s`);
      }

      // Phase 5a-pre-grid: build each page's Visual Bible reference grid, NOW
      // that we know which pages actually got a background plate.
      //
      // This used to happen inside the pageData map above, where the filter
      // `if (sceneBackgrounds[pageNum]) drop locations` could never fire —
      // sceneBackgrounds is filled by 5a-pre-vantage and 5a-pre, both of which
      // consume the pageDataArray that map produces. So on every non-trial
      // story the map was `{}` and the filter was dead code. Measured on
      // staging job_1787959478282_bz19gm36h: 14/14 pages shipped their
      // locations and the ship as grid cards even though every one had a plate.
      //
      // Same rule as buildPageCompositeRefs (referenceSheets.js), which is the
      // documented single source of truth for these filters: a plate already
      // paints the setting AND the vehicle, so both drop out of the grid; the
      // grid is for props, animals and secondary characters the plate omits.
      //
      // "Got a plate" means the plate that is actually SENT to the render, not
      // one that merely exists in `sceneBackgrounds`. The page render runs the
      // plate through applyReferenceMode with the page's route refMode, so this
      // filter asks the same function the same question — otherwise a page
      // whose mode drops the plate loses its location/vehicle cells to a plate
      // nobody sees, and renders with no visual reference at all (page 1 of
      // staging job_1788295892348_l028ggiq7a: a cast-0 ship exterior that
      // attached zero references while a finished plate of the ship was built
      // and discarded).
      {
        const { applyReferenceMode } = require('./server/lib/storyHelpers');
        let filteredPages = 0;
        let droppedCells = 0;
        for (const pageData of pageDataArray) {
          const refs = pageData.vbElementRefs || [];
          const effectiveRefMode = pageRoutes.get(pageData.pageNumber)?.refMode || runReferenceMode;
          const hasPlate = !!applyReferenceMode({
            mode: effectiveRefMode,
            characterPhotos: [],
            visualBibleGrid: null,
            landmarkPhotos: [],
            sceneBackground: sceneBackgrounds[pageData.pageNumber]?.imageData || null,
            sceneMetadata: pageData.sceneMetadata,
          }).sceneBackground;
          // The element the camera stands on/inside never enters the page grid:
          // its render is an exterior three-quarter view, and an exterior image
          // on a deck-level page is exactly the channel that produced the
          // phantom second vessel (decisions.md 2026-09-02, `aboard`). The page
          // prompt still names it; only the image is withheld. When a plate is
          // sent this is already covered by the location/vehicle drop below —
          // it matters on the plateless cast-0 pages this phase now feeds.
          const aboardId = pageData.sceneMetadata?.aboard || null;
          // LARGE ELEMENTS BELONG TO THE PLATE (owner, 2026-09-15). Same
          // question as buildPageCompositeRefs asks: vehicles by TYPE (the
          // pre-2026-09-15 rule and the `scaleClass === null` fallback for
          // stored bibles), plus anything the bible classed at
          // vehicle, building or landscape scale — a building-scale ARTIFACT
          // belongs to the plate for the same reason a ship does.
          //
          // CONDITIONAL ON hasPlate, deliberately. A large element on a
          // plateless page KEEPS its cell rather than travelling on nothing:
          // page 1 of job_1788295892348_l028ggiq7a was a cast-0 ship exterior
          // that attached zero references while a finished plate of the ship
          // existed and was discarded.
          //
          // CONDITIONAL ON THE ELEMENT ACTUALLY REACHING THE PLATE too: the
          // plate admits a vehicle or a large element only when the AD brief's
          // objects[] names it, so the same brief gates the drop. Without this
          // the two gates disagree and the element is rendered with no
          // reference and no STRUCTURES line at all.
          // One filter, shared with the Test Lab image stage (pageRenderCall.js).
          const kept = require('./server/lib/pageRenderCall').keepPageGridElements(refs, { hasPlate, sceneMetadata: pageData.sceneMetadata });
          if (kept.length < refs.length) {
            filteredPages++;
            droppedCells += refs.length - kept.length;
          }
          // Secondary landmarks are NOT passed: "a landmark photo NEVER enters
          // the grid" (owner, settled 2026-08-18 — a real photograph composited
          // among style-rendered cells corrupts a stylised render). This inline
          // builder was still passing them while buildPageCompositeRefs, the
          // documented single source of truth, correctly passes [].
          pageData.visualBibleGrid = kept.length > 0
            ? await buildVisualBibleGrid(kept, [])
            : null;
          // Recompute the reference claim from the cells actually sent — the
          // prompt must never promise an image the call does not carry.
          if (typeof pageData.makeImagePrompt === 'function') {
            pageData.prompt = pageData.makeImagePrompt(kept.map(e => e.id).filter(Boolean));
          }
          log.info(`🔲 [VB-GRID] Page ${pageData.pageNumber}: ${kept.length}/${refs.length} cell(s) — ${hasPlate ? `plate sent, dropped plate-borne vehicle/structure` : `no plate sent, vehicle/structure kept`}${aboardId ? ` (aboard ${aboardId} withheld)` : ''}`);
        }
        if (filteredPages > 0) {
          log.info(`🔲 [UNIFIED] Phase 5a-pre-grid: dropped ${droppedCells} cell(s) across ${filteredPages} page(s) (plate-covered vehicle/structure + aboard elements)`);
        }
      }

      // Phase 5a continued: Generate ALL images (no evaluation)
      // Scene composite was killed 2026-05-16 — every page goes through the
      // direct path (see enableSceneComposite in config/models.js). The
      // composite cast-builder setup that used to be hoisted here was dead work
      // on every story and is gone; the composite pipeline itself survives only
      // in the admin test-models route (server/routes/regeneration.js).
      //
      // Per-character projected avatars, keyed for the iterate/repair cell-crop
      // path (pipelineStoryData.characterAvatars, Phase 7) — lets iterate crop a
      // single body cell per character at the scene pose instead of attaching
      // the full 2×4 sheet. Hoisted once; same data for all pages.
      const storyCharacterAvatars = require('./server/lib/storyAvatars')
        .projectStoryCharacterAvatars(inputData.characters || [], inputData.artStyle || 'pixar');

      log.info(`📸 [UNIFIED] Phase 5a: Generating all ${expandedScenes.length} images...`);
      const genStartTime = Date.now();
      const genLimit = pLimit(50);

      // Progress tracked on COMPLETION, not on start. Every page starts at once,
      // so the old per-start update drove the bar straight to its ceiling (28%)
      // and then sat there for the entire pass — looking hung to the user and to
      // the watchdog. Counting finished pages makes the bar actually move.
      let pagesDone = 0;
      const bumpProgress = () => {
        pagesDone++;
        const { pct, message } = require('./server/lib/illustrationProgress').illustrationProgress(pagesDone, pageDataArray.length);
        dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = $4',
          [pct, message, jobId, 'processing']
        ).catch(err => log.debug(`[PROGRESS] job ${jobId}: ${err.message}`));
      };

      // NO phase-local liveness interval here any more: the whole-job heartbeat
      // armed in processStoryJob covers this phase and every phase after it.
      let rawImages;
      rawImages = await Promise.all(
        pageDataArray.map(pageData => genLimit(async () => {
          await checkCancellation();

          // Trial mode: reuse pre-generated streaming image if available
          if (inputData.trialMode && streamingTrialPageImagePromises.has(pageData.pageNumber)) {
            const streamResult = await streamingTrialPageImagePromises.get(pageData.pageNumber);
            if (streamResult && streamResult.imageData) {
              log.info(`♻️ [TRIAL-STREAM] Page ${pageData.pageNumber}: reusing pre-generated streaming image`);
              return {
                pageNumber: pageData.pageNumber,
                imageData: streamResult.imageData,
                modelId: streamResult.modelId,
                thinkingText: null,
                usage: streamResult.usage,
                prompt: streamResult.prompt,
                characterPhotos: streamResult.characterPhotos,
                landmarkPhotos: pageData.landmarkPhotos,
                visualBibleGrid: pageData.visualBibleGrid,
                grokRefImages: streamResult.grokRefImages,
                emptySceneImage: null,
                // The trial plate was the ONLY image call in the pipeline that
                // left no trace: this branch hardcoded null, so every trial
                // page shipped with emptyScenePrompt null even though the
                // plate had been rendered from a real prompt during outline
                // streaming. Read it back off the slot the trial loop filled.
                emptyScenePrompt: sceneBackgrounds[pageData.pageNumber]?.prompt || null,
                emptySceneGrokRefImages: sceneBackgrounds[pageData.pageNumber]?.grokRefImages || null,
                vantageId: sceneBackgrounds[pageData.pageNumber]?.vantageId || null,
                plateDerivedFor: sceneBackgrounds[pageData.pageNumber]?.plateDerivedFor || null,
                sceneDescription: pageData.scene.sceneDescription,
                text: pageData.scene.text,
                sceneCharacters: pageData.sceneCharacters,
                sceneMetadata: pageData.sceneMetadata,
                perCharClothing: pageData.perCharClothing,
                scene: pageData.scene
              };
            }
          }

          try {
            // ── Per-page image-route dispatcher ──────────────────────────
            // decidePageRoute picks direct vs composite (plus phantom-pose
            // and refMode) based on cast size, sceneIntent, and per-story
            // overrides. See docs/image-generation-methods.html §7 and
            // server/lib/imageRouter.js for the decision table.
            // Same descriptor the plate and VB-grid phases used (pageRoutes,
            // decided once above) — the phases must not disagree about what
            // this page sends.
            const route = pageRoutes.get(pageData.pageNumber)
              || decidePageRoute(pageData, inputData, MODEL_DEFAULTS);
            log.info(`🧭 [ROUTE] P${pageData.pageNumber}: ${route.path} (cast=${route.cast}, refMode=${route.refMode}) — ${route.reason}`);
            // Apply reference-mode flag — strips refs/grid per the chosen mode.
            // Per-page route decision (from decidePageRoute) wins over the
            // run-level default. The router picks 'off' for 0-cast pages and
            // 'loose' for 1-3 cast pages.
            const effectiveRefMode = (route && route.refMode) || runReferenceMode;
            const refApplied = require('./server/lib/storyHelpers').applyReferenceMode({
              mode: effectiveRefMode,
              characterPhotos: pageData.characterPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              landmarkPhotos: pageData.landmarkPhotos,
              sceneBackground: sceneBackgrounds[pageData.pageNumber]?.imageData || null,
              sceneMetadata: pageData.sceneMetadata,
            });
            // PLATE OR FAIL (server/lib/landmarkScene.js): a landmark page with no
            // plate is not rendered on the raw photo. It fails here into the
            // catch below; the one page retry renders its plate first.
            if (pageNeedsPlate(pageData, refApplied.landmarkPhotos) && !refApplied.sceneBackground) {
              log.error(`❌ [UNIFIED] Page ${pageData.pageNumber}: landmark "${refApplied.landmarkPhotos[0]?.name || 'unknown'}" has no plate — not rendered on the raw photo`);
              throw new Error(`page ${pageData.pageNumber} has a landmark photo and no plate`);
            }
            // The render options — one builder, shared with the Test Lab image
            // stage (server/lib/pageRenderCall.js).
            const genResult = await generateImageOnly(
              pageData.prompt,
              refApplied.characterPhotos,
              require('./server/lib/pageRenderCall').pageRenderOptions({
                page: pageData,
                renderAspect: pageData.renderAspect,
                pageImageModel: pageData.pageImageModel,
                pageImageBackend: pageData.pageImageBackend,
                refApplied,
                textInImage: pageData.textInImage,
                plateTextAreaMask: sceneBackgrounds[pageData.pageNumber]?.textAreaMask || null,
                coverOpts: pageData.coverOpts,
              })
            );

            // Track usage
            if (genResult.usage) {
              const isRunware = genResult.modelId && genResult.modelId.startsWith('runware:');
              const isGrok = genResult.modelId && genResult.modelId.startsWith('grok-imagine');
              const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, genResult.usage, pageData.coverOpts ? pageData.coverOpts.usageLabel : 'page_images', genResult.modelId);
            }
            imageGenHeartbeat();  // per-page heartbeat — image done, keeps the phase alive

            // Scale-repair pass — UNCONDITIONAL on any page where the
            // outline declared one or more characters with depth=background
            // alongside foreground/midground characters. Grok consistently
            // fails to render the tiny-figure-in-distance composition; the
            // eval flags it but the regular repair workflow can't shrink
            // figures, only fix identity. This pass runs Grok edit on the
            // just-rendered image with a focused "shrink the bg figure"
            // prompt + the bg character's avatar attached.
            // No threshold, no eval — outline intent is the trigger.
            let scaleRepairResult = null;
            // Why the composite did or did not produce a page. An abort
            // leaves NO artefact, so "ran and bailed" and "never triggered"
            // looked identical in the database, and the only record was a
            // log line that had rolled out of the buffer within hours
            // (asked about job_1786829555599_rgzoyoprx, 2026-08-16, and the
            // answer had to be reconstructed from scene metadata).
            let compositeOutcome = null;
            // The composite's stage frames — populated plate, depopulated
            // plate, finished composite. `persistCompositeDebug` in
            // services/database.js already writes these to story_images as
            // composite_blocking / composite_clean_bg / composite_composited
            // and deletes the bytes off the blob, but this generation path
            // never attached them, so production held ZERO composite_* rows
            // for any story (measured 2026-08-24, both environments) — on
            // success as well as on abort.
            let compositeDebug = null;
            if (genResult.imageData && pageData.sceneMetadata) {
              try {
                // Only the trigger is used here — the composite replaced
                // runScaleRepair on this path (decisions.md 2026-08-15).
                const { needsScaleRepair } = require('./server/lib/scaleRepair');
                if (!require('./server/config/runtime').runtime('sceneCompositeEnabled')) {
                  compositeOutcome = { status: 'disabled', reason: 'runtime.sceneCompositeEnabled is false' };
                  // Count only figures the composite can cast: the scene
                  // reviewer now promotes Visual Bible secondaries into
                  // characters[] (scene-review rules 5/5a), and the composite
                  // renders photo-backed characters only.
                } else if (needsScaleRepair(pageData.sceneMetadata, inputData.characters || [])) {
                  compositeOutcome = { status: 'triggered' };
                  // Resolve avatar refs only for the background characters.
                  const helpers = require('./server/lib/storyHelpers');
                  const { applyStyledAvatars } = require('./server/lib/styledAvatars');
                  const allChars = pageData.sceneMetadata.fullData?.characters || [];
                  const bgNames = new Set(allChars
                    .filter(c => (c.depth || '').toLowerCase() === 'background')
                    .map(c => (c.name || '').toLowerCase()));
                  const bgCharObjs = (inputData.characters || []).filter(c =>
                    bgNames.has((c.name || '').toLowerCase()));
                  // Refs strategy:
                  //   - BACKGROUND characters (the ones being shrunk): NO avatar
                  //     attached. A face avatar tells Grok "render this person
                  //     identifiably" and the model upsizes the figure to fit a
                  //     recognisable face — directly contradicting "tiny in the
                  //     background". Description-only is enough.
                  //   - FOREGROUND / midground characters (kept at their current
                  //     position): avatars ATTACHED. Without them Grok was
                  //     drifting foreground identity while relocating the bg
                  //     figure ("repaint the whole scene, only differently"
                  //     failure mode). Attaching the fg avatars anchors the
                  //     identity Grok must preserve.
                  const clothingByName = new Map(allChars.map(c => [
                    (c.name || '').toLowerCase(),
                    c.clothing || null,
                  ]));
                  // Same per-page resolved view the page-gen path builds —
                  // story-level clothingRequirements (full outfit descriptions
                  // per category) merged with this page's per-character
                  // category labels (`perCharClothing`). Story-level alone
                  // doesn't know which category each character wears on this
                  // page (standard / costumed / etc.), so resolveClothingForPage
                  // can't pick the right description without `_currentClothing`.
                  const clothingReqs = buildSceneClothingRequirements(
                    pageData.sceneCharacters || [],
                    pageData.perCharClothing || {},
                    clothingRequirements
                  );
                  const bgDescriptions = bgCharObjs.map(c => {
                    const label = clothingByName.get((c.name || '').toLowerCase()) || null;
                    const override = helpers.resolveClothingForPage(c, label, clothingReqs);
                    return {
                      name: c.name,
                      description: helpers.buildCharacterPhysicalDescription(c, override) || '',
                    };
                  }).filter(x => x.description);
                  // Background characters that aren't user characters (VB
                  // secondaries like a story's antagonist) have no inputData
                  // entry — without a description the repair prompt says
                  // "move <name>" to a model that has no idea who that is,
                  // and the verification gate can't check them by signature.
                  // Fall back to the Visual Bible secondary-character entry.
                  const coveredBgNames = new Set(bgDescriptions.map(d => (d.name || '').toLowerCase()));
                  for (const bgName of bgNames) {
                    if (coveredBgNames.has(bgName)) continue;
                    const vbEntry = (visualBible?.secondaryCharacters || []).find(sc =>
                      (sc.name || '').toLowerCase() === bgName);
                    const vbDesc = vbEntry?.extractedDescription || vbEntry?.description;
                    if (vbDesc) bgDescriptions.push({ name: vbEntry.name, description: vbDesc });
                  }
                  // Foreground/midground avatar refs. Resolve per-character
                  // clothing the same way the main scene render does, then
                  // pull the corresponding styled avatar (2×4 sheet body cell
                  // is what the rest of the pipeline uses; for scale-repair
                  // the simpler full styled-avatar URL is fine — Grok only
                  // needs identity, not depth-specific framing).
                  const fgNames = new Set(allChars
                    .filter(c => (c.depth || '').toLowerCase() !== 'background')
                    .map(c => (c.name || '').toLowerCase()));
                  const fgCharObjs = (inputData.characters || []).filter(c =>
                    fgNames.has((c.name || '').toLowerCase()));
                  const fgRefs = [];
                  for (const c of fgCharObjs) {
                    const label = clothingByName.get((c.name || '').toLowerCase()) || null;
                    const override = helpers.resolveClothingForPage(c, label, clothingReqs);
                    const slotKey = override && override.startsWith('costumed') ? 'costumed' : (override || 'standard');
                    const avatarUrl = c.avatars?.styledAvatars?.[inputData.artStyle]?.[slotKey]
                      || c.avatars?.styledAvatars?.[inputData.artStyle]?.standard
                      || c.avatars?.[slotKey]
                      || c.avatars?.standard
                      || null;
                    if (avatarUrl) {
                      fgRefs.push({ name: c.name, photoUrl: avatarUrl });
                    }
                  }
                  // ── Scale repair replaced by the scene composite ──────────
                  // runScaleRepair edits the rendered page and asks Grok to
                  // shrink the background figure. Measured 2026-08-13: it
                  // triggers on 42 pages in 30 days and leaves no artefact on
                  // any of them — no stored prompt, no pre-repair image, and
                  // the oversized figures ship unchanged.
                  //
                  // The composite instead rebuilds the page from a silhouette
                  // plate whose figure heights come from a ground plane fitted
                  // to the adults actually painted, then blends once. On the
                  // same pages it produced correct depth where scale repair
                  // produced none. Three Grok calls (~$0.06) against one.
                  //
                  // The trigger is unchanged, so this fires exactly where
                  // scale repair fired. A throw leaves genResult untouched and
                  // the page ships as rendered.
                  const { buildCompositeCast, splitCastByStratum } = require('./server/lib/compositeCastBuilder');
                  const { generateSceneComposite, buildBlendMetadata } = require('./server/lib/sceneComposite');
                  const compositeCast = await buildCompositeCast(pageData, inputData, {
                    userId, log, storyCharacterAvatars,
                    // Secondary characters (a captain, a guard) have no avatar
                    // sheet — the cast builder falls back to their Visual Bible
                    // reference sheet instead of aborting the whole page.
                    visualBible,
                  });
                  if (!compositeCast || !compositeCast.length) {
                    throw new Error('composite cast empty — falling back to the rendered page');
                  }
                  const { backCast, frontCast } = splitCastByStratum(compositeCast);
                  const fdMeta = pageData.sceneMetadata?.fullData || pageData.sceneMetadata || {};
                  const compRes = await generateSceneComposite({
                    compositeStrategy: 'uniform',
                    // Per-figure pose render: the silhouette's pose (seated,
                    // kneeling, leaning) becomes the cut-out's pose. Without
                    // it a standing sheet cell is pasted into a seated
                    // silhouette (measured, Lab exp 1087). +$0.02 per figure.
                    phantomPoseRender: true,
                    // In-place figures (owner, 2026-09-10/11): each figure is
                    // rendered INTO the plate where its silhouette is and cut
                    // out with DINO+SAM. Measured on the two-level page 4 of
                    // job_1788983823620_csjcyp1q9: paste+phantom lost the pose
                    // 2/2 (exp 1106); in-place held pose and level on its last
                    // two runs (exp 1146, 1148). phantomPoseRender is unused
                    // on this path and stays for the paste fallback.
                    figureMethod: 'inPlace',
                    cast: compositeCast, frontCast, backCast,
                    // The brief and the plate prompt, from where this closure
                    // actually holds them: pageData.scene.sceneDescription and
                    // sceneBackgrounds / sceneMetadata.emptyScenePrompt.
                    // fdMeta.description, pageData.sceneDescription and
                    // pageData.emptyScenePrompt do not exist at this point, so
                    // every trigger since 2026-08-25 aborted with
                    // "cleanBackgroundPrompt or scene.description required"
                    // before the first paid call (44 of 49 staging outcomes;
                    // the composite never produced a production page).
                    scene: {
                      description: require('./server/lib/sceneMetadata').splitBrief(fdMeta.description || pageData.scene?.sceneDescription || pageData.sceneDescription || '').prose,
                      artStyle: inputData.artStyle || 'watercolor',
                      pageBrief: require('./server/lib/sceneMetadata').splitBrief(fdMeta.pageBrief || pageData.scene?.sceneDescription || pageData.sceneDescription || '').prose,
                      interactions: fdMeta.interactions || [],
                      // Per-character expression + attention target, the two
                      // things a pasted avatar cut-out cannot supply (it is
                      // blank-faced and looking at the camera). The page's own
                      // generation prompt is deliberately NOT sent — measured
                      // across nine Lab variants, its staging sections make the
                      // model re-arrange the scene it was asked to preserve.
                      ...buildBlendMetadata(fdMeta, pageData, inputData.clothingRequirements || inputData.outline?.clothingRequirements || null),
                    },
                    cleanBackgroundPrompt: String(sceneBackgrounds[pageData.pageNumber]?.prompt || pageData.sceneMetadata?.emptyScenePrompt || pageData.emptyScenePrompt || fdMeta.emptyScenePrompt || ''),
                    aspectRatio: pageData.renderAspect,
                    // Labelled portrait grid as Image 2 — the blend prompt calls it
                    // the authoritative face/clothing reference, and this path was
                    // passing nothing, leaving identity to the pasted pixels alone.
                    visualBibleGridImage: pageData.visualBibleGrid || null,
                    // For the blend prompt: ids in the brief's interactions become names, never leak.
                    visualBible,
                    // Creatures declared on this page. The paste step only
                    // places cast cut-outs, so a Visual Bible animal has no
                    // way into the page unless the plate paints it — measured
                    // 2026-08-23: a page declared a VB animal, the setting
                    // prose said "no animals", and it vanished from the
                    // finished image.
                    sceneCreatures: require('./server/lib/visualBible')
                      .resolveSceneCreatures(visualBible, fdMeta.objects || [], pageData.pageNumber),
                    usageTracker: addUsage,
                  });
                  scaleRepairResult = compRes?.imageData
                    ? { imageData: compRes.imageData, modelId: 'scene-composite', prompt: compRes.debug?.populatedPlatePrompt || null, grokRefImages: null, debug: compRes.debug || null }
                    : null;
                  compositeOutcome = scaleRepairResult
                    ? { status: 'composited', detector: compRes.debug?.detector || null, placed: compRes.placed ?? (compRes.debug?.placements || []).length }
                    : { status: 'no-image', reason: 'the composite returned no image' };
                  compositeDebug = compRes?.debug || null;
                }
              } catch (e) {
                compositeOutcome = { status: 'aborted', reason: String(e.message || e).slice(0, 300) };
                // Only the two designed gates carry debug; an unexpected throw
                // deliberately carries none, so a bug stays distinguishable
                // from a refusal.
                compositeDebug = e.compositeDebug || null;
                log.warn(`⚠️ [SCALE-REPAIR] Page ${pageData.pageNumber} failed: ${e.message}`);
              }
            }

            // Promote the scale-repaired image to the active version when it succeeded.
            // The pre-repair image is preserved as a separate version on the scene.
            const activeImageData = scaleRepairResult?.imageData || genResult.imageData;
            const activeModelId = scaleRepairResult?.modelId || genResult.modelId;

            // Save checkpoint for progressive display
            if (activeImageData && pageData.coverOpts) {
              // A cover's progressive display is the cover checkpoint (read by
              // routes/jobs.js and the salvage path), never a story page.
              await saveImageCheckpoint(jobId, 'partial_cover', {
                type: pageData.coverOpts.coverKey,
                imageData: activeImageData,
                description: pageData.scene.sceneDescription,
                modelId: activeModelId,
                titleBaked: pageData.coverOpts.titleBaked,
                ...(pageData.coverOpts.coverKey === 'frontCover' ? { storyTitle: title || inputData.title || '' } : {}),
              }, ['frontCover', 'initialPage', 'backCover'].indexOf(pageData.coverOpts.coverKey), pageData.coverOpts.coverKey);
            } else if (activeImageData) {
              await saveImageCheckpoint(jobId, 'partial_page', {
                pageNumber: pageData.pageNumber,
                text: pageData.scene.text,
                sceneDescription: pageData.scene.sceneDescription,
                imageData: activeImageData,
                modelId: activeModelId
              }, pageData.pageNumber, `p${pageData.pageNumber}`);
            }

            // Detect calm region for text overlay (~30ms, non-blocking)
            let calmRegion = null;
            if (activeImageData) {
              try {
                const { detectCalmRegion } = require('./server/lib/calmRegion');
                const textPos = enforceSpreadTextPosition(pageData.sceneMetadata?.textPosition || null, pageData.pageNumber);
                if (textPos) {
                  const imgBuf = Buffer.from(stripDataUriPrefix(activeImageData), 'base64');
                  calmRegion = await detectCalmRegion(imgBuf, textPos).catch(() => null);
                }
              } catch (e) { /* calm region detection is optional */ }
            }

            // Attach empty scene data for frontend display
            const emptySceneData = sceneBackgrounds[pageData.pageNumber] || null;

            return {
              pageNumber: pageData.pageNumber,
              imageData: activeImageData,
              modelId: activeModelId,
              // When scale-repair ran, the original image is preserved as a
              // pre-repair version so the version picker shows both.
              preScaleRepairImage: scaleRepairResult ? genResult.imageData : null,
              preScaleRepairModelId: scaleRepairResult ? genResult.modelId : null,
              scaleRepairPrompt: scaleRepairResult ? scaleRepairResult.prompt : null,
              scaleRepairGrokRefImages: scaleRepairResult ? scaleRepairResult.grokRefImages : null,
              compositeOutcome,
              compositeDebug,
              thinkingText: genResult.thinkingText || null,
              usage: genResult.usage,
              // The prompt the model ACTUALLY received, not the pre-shrink
              // build. generateImageOnly stamps the post-shrink string on
              // `genResult.prompt`; storing `pageData.prompt` threw it away, so
              // the dev panel and the batch eval's ORIGINAL_PROMPT fallback
              // read text the model never saw — staging
              // job_1789348171785_9oxos7dwv p7 stored 8,002 chars against
              // grok-imagine-image-2.0's 7,900 cap. Falls back to the build
              // for providers that report no sent text.
              prompt: genResult.prompt || pageData.prompt,
              // Set ONLY when the built prompt went over the image model's
              // character cap and shrinkPromptForModel changed the scene prose
              // (compressed, deduped or cut): the description the model
              // actually received. The batch
              // eval judges the render against it instead of the pre-shrink
              // `scene.sceneDescription`, which can name clauses the compressor
              // removed (sceneMetadata.resolveEvalSceneDescription). Undefined
              // on every under-cap page, so nothing extra is stored there.
              compressedScene: genResult.compressedScene || null,
              characterPhotos: pageData.characterPhotos,
              landmarkPhotos: pageData.landmarkPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              grokRefImages: genResult.grokRefImages || null,
              ...require('./server/lib/plateQc').pagePlateFields(emptySceneData),
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene,
              calmRegion,
              // A cover page's record carries what the cover judges and the
              // cover store read: the text contract, the cast it was drawn
              // with, and which cover it is. The page's own fields above stay.
              ...(pageData.coverOpts ? {
                coverKey: pageData.coverOpts.coverKey,
                evaluationType: 'cover',
                expectedText: pageData.coverOpts.expectedText,
                textMode: pageData.coverOpts.textMode,
                // The mark that this cover was briefed as a page — it switches
                // the undeclared-lettering check on for it (evalPipeline).
                coverIsPage: true,
                titleBaked: pageData.coverOpts.titleBaked,
                referencePhotos: pageData.characterPhotos,
                excludedCastNames: [],
              } : {}),
            };
          } catch (genError) {
            log.error(`❌ [UNIFIED] Page ${pageData.pageNumber} generation failed: ${genError.message}`);
            return {
              pageNumber: pageData.pageNumber,
              imageData: null,
              error: genError.message,
              prompt: pageData.prompt,
              characterPhotos: pageData.characterPhotos,
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene
            };
          }
        }).finally(bumpProgress))
      );

      // ── A PAGE WITH NO IMAGE IS A LOUD FAILURE (2026-08-29) ──────────────
      // The per-page catch above returns `imageData: null` and the story went
      // on to ship that page as an imageless version entry — no genLog entry,
      // no flag, the book audit silently skipped the page (job_1787959478282
      // shipped pages 1 and 3 with zero bytes and the only trace was a
      // "14/16" count). Record every casualty in the STORED log with its
      // error, then give each ONE more generation attempt before giving up.
      // Fail-safe: a failing retry is caught and never propagates.
      const pageDataByNumber = new Map(pageDataArray.map(pd => [pd.pageNumber, pd]));
      for (const raw of rawImages) {
        if (raw.imageData || raw.pageNumber == null) continue;
        genLog.error('page_image_missing', `Page ${raw.pageNumber} produced no image: ${raw.error || 'unknown error'} — retrying once`);
        const pageData = pageDataByNumber.get(raw.pageNumber);
        if (!pageData) continue;
        try {
          // PLATE OR FAIL: the retry reuses the page's plate, or renders one
          // with the same mechanism Phase 5a-pre uses — never the raw photo.
          // No plate after that → the throw lands in the catch below and the
          // page ships marked missing (page_image_retry_failed).
          if (pageNeedsPlate(pageData, pageData.landmarkPhotos) && !sceneBackgrounds[pageData.pageNumber]?.imageData) {
            log.info(`🎬 [UNIFIED] Page ${raw.pageNumber}: retry renders the missing plate first`);
            const renderedPlate = await renderPagePlate(pageData);
            if (!storePagePlate(renderedPlate)) {
              log.error(`❌ [UNIFIED] Page ${raw.pageNumber}: plate could not be rendered — page not rendered on the raw photo`);
              throw new Error(`page ${raw.pageNumber} has a landmark photo and its plate could not be rendered`);
            }
          }
          const retryResult = await generateImageOnly(
            pageData.prompt,
            pageData.characterPhotos,
            {
              aspectRatio: pageData.renderAspect,
              imageModelOverride: pageData.pageImageModel,
              imageBackendOverride: pageData.pageImageBackend,
              landmarkPhotos: pageData.landmarkPhotos,
              landmarkScene: pageLandmarkScene(pageData),
              visualBibleGrid: pageData.visualBibleGrid,
              pageNumber: pageData.pageNumber,
              sceneBackground: sceneBackgrounds[pageData.pageNumber]?.imageData || null,
              // Never serve the failed attempt back out of the gen-only cache.
              skipCache: true,
              textAreaMask: pageData.textInImage
                ? (sceneBackgrounds[pageData.pageNumber]?.textAreaMask || null)
                : null,
              ...(pageData.coverOpts ? { captureLabel: pageData.coverOpts.captureLabel } : {}),
            }
          );
          if (retryResult?.imageData) {
            raw.imageData = retryResult.imageData;
            raw.modelId = retryResult.modelId;
            raw.usage = retryResult.usage;
            raw.thinkingText = retryResult.thinkingText || null;
            raw.grokRefImages = retryResult.grokRefImages || null;
            // The retry is the render that survives, so its sent prompt and
            // scene block are the ones that describe the stored image.
            raw.prompt = retryResult.prompt || raw.prompt;
            raw.compressedScene = retryResult.compressedScene || null;
            raw.error = null;
            // The plate the retry rendered on (rendered above or already stored).
            Object.assign(raw, require('./server/lib/plateQc').pagePlateFields(sceneBackgrounds[pageData.pageNumber]));
            if (retryResult.usage) {
              const m = retryResult.modelId || '';
              const provider = m.startsWith('runware:') ? 'runware' : m.startsWith('grok-imagine') ? 'grok' : 'gemini_image';
              addUsage(provider, retryResult.usage, pageData.coverOpts ? pageData.coverOpts.usageLabel : 'page_images', retryResult.modelId);
            }
            genLog.info('page_image_recovered', `Page ${raw.pageNumber} recovered on retry (${retryResult.modelId})`);
            log.info(`♻️ [UNIFIED] Page ${raw.pageNumber} recovered on retry`);
          } else {
            genLog.error('page_image_retry_empty', `Page ${raw.pageNumber} retry returned no image`);
          }
        } catch (retryErr) {
          genLog.error('page_image_retry_failed', `Page ${raw.pageNumber} retry failed: ${retryErr.message}`);
          log.error(`❌ [UNIFIED] Page ${raw.pageNumber} retry failed: ${retryErr.message}`);
        }
      }

      // THE FULL STORY'S COVERS ARE STORED HERE, from their page records
      // (2026-09-24). Same `coverImages[key]` fields the client, the PDF, the
      // typography pass and the story loader read; plus the page brief fields
      // (sceneDescription, sceneMetadata, outlineExtract, plate) that make the
      // cover repairable exactly like a page. The record itself stays in
      // rawImages, so the repair pipeline evaluates and repairs it with the pages.
      if (!inputData.trialMode) {
        for (const raw of rawImages) {
          if (!raw || !raw.coverKey) continue;
          if (!raw.imageData) {
            genLog.error('cover_failed', `${raw.coverKey} produced no image: ${raw.error || 'unknown error'}`);
            continue;
          }
          coverImages[raw.coverKey] = {
            imageData: raw.imageData,
            description: raw.sceneDescription,
            sceneDescription: raw.sceneDescription,
            sceneMetadata: raw.sceneMetadata || null,
            outlineExtract: raw.scene?.outlineExtract || null,
            // The cover's decided place (2026-10-04): iteratePageCore re-pins it.
            jevFixed: raw.scene?.jevFixed || null,
            sceneCharacters: raw.sceneCharacters || null,
            perCharClothing: raw.perCharClothing || null,
            prompt: raw.prompt,
            compressedScene: raw.compressedScene || null,
            referencePhotos: raw.referencePhotos || raw.characterPhotos || [],
            landmarkPhotos: raw.landmarkPhotos || [],
            grokRefImages: raw.grokRefImages || null,
            emptySceneImage: raw.emptySceneImage || null,
            emptyScenePrompt: raw.emptyScenePrompt || null,
            modelId: raw.modelId,
            titleBaked: raw.titleBaked === true,
            // The mark coverIteratePath reads: this cover is a page, and it
            // iterates, regenerates and repairs through the page path.
            briefedAsPage: true,
            generatedAt: new Date().toISOString(),
          };
        }
      }

      const genDuration = ((Date.now() - genStartTime) / 1000).toFixed(1);
      const successCount = rawImages.filter(r => r.imageData).length;
      log.info(`✅ [UNIFIED] Phase 5a complete: ${successCount}/${rawImages.length} images generated in ${genDuration}s`);
      // PURE generation ends here (owner, 2026-08-10): everything below —
      // covers await, text region, detection, evals, entity, repair rounds —
      // is the repair phase. Stamping pagesEnd after the pipeline made
      // "Generated 14/14 page images in 1155s" span the whole repair phase
      // and hid where the time actually went.
      timing.pagesEnd = Date.now();
      genLog.info('generation_complete', `Generated ${successCount}/${rawImages.length} page images in ${genDuration}s (pure generation)`);
      genLog.setStage('repair');

      // JOIN THE TEXT REFINER HERE — before covers, before the repair
      // pipeline, before the book audit inside it. Pure generation is done, so
      // this is the same "after images completed" moment the join always had;
      // what changes is that every stage downstream now reads the FINAL text.
      await joinTextRefinement([rawImages]);

      // Await covers before repair pipeline so covers go through the same quality checks
      if (coverAwaitPromise) {
        if (!timing.coversEnd) {
          log.debug(`⏳ [UNIFIED] Waiting for covers before repair pipeline...`);
        }
        try {
          await Promise.race([
            coverAwaitPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Cover generation timed out')), 180000))
          ]);
        } catch (coverErr) {
          log.error(`❌ [UNIFIED] Cover await failed: ${coverErr.message}`);
        }
        // Add covers to rawImages with negative page numbers

        for (const [coverKey, coverData] of Object.entries(coverImages)) {
          if (coverData?.imageData && COVER_PAGE_NUMBERS[coverKey] != null) {
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
            const { textMode, expectedText } = require('./server/lib/coverTypography').resolveCoverTextContract(coverKey, {
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
            rawImages.push({
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
              excludedCastNames: require('./server/lib/coverCastRoster')
                .resolveCoverCastRoster(coverSceneCharacters, inputData.characters || []).excluded,
              scene: { outlineExtract: coverData.description },
              evaluationType: 'cover', // Use cover evaluation (includes text checks)
            });
            log.info(`📸 [UNIFIED] Added ${coverKey} (page ${COVER_PAGE_NUMBERS[coverKey]}) to repair pipeline`);
          }
        }
        coverAwaitPromise = null; // Mark as consumed
      }

      // Phases 5b-5g: Unified repair pipeline
      // Evaluate + entity consistency (parallel) → regen low-scoring (max 2) → pick best → character fix

      // ── Text-space gate + repair: count calm pixels INSIDE the polygon the
      // renderer will draw text into. If calmFound < calmNeeded for the page's
      // word count and font size, re-roll the image with a mask hint up to
      // REPAIR.maxRetries. All candidates are persisted as separate
      // imageVersions so the user can pick a different one in dev mode. One
      // helper, one rule, one source of truth.
      const { ensureCalmZone } = require('./server/lib/textSpaceRepair');
      const textRegionResults = {}; // pageNumber → { winnerImage, position, report }
      // Skip the entire phase for layouts where text isn't overlaid on the
      // image (advanced/square+below renders text in a separate strip), OR
      // when the global enableTextOverlay flag is false.
      const skipTextRegionPhase = MODEL_DEFAULTS.enableTextOverlay === false
        || inputData?.layout?.textInImage === false;
      try {
        if (skipTextRegionPhase) {
          log.info(`📝 [TEXT-REGION] Skipped (layout.textInImage=false — text rendered below image)`);
        }
        const scenePages = !skipTextRegionPhase ? rawImages.filter(img => img.pageNumber > 0 && img.imageData) : [];
        // Per-page try/catch is load-bearing, not politeness: these closures
        // mutate img.imageData IN PLACE. Without it, one page's rejection made
        // Promise.all reject while the sibling closures kept running and kept
        // writing bytes AFTER the pipeline had moved on — the eval phase could
        // score bytes that never shipped, and the outer catch claimed "using
        // original images" for pages that were already washed. A failed page
        // keeps its original bytes (logged with the reason); the aggregate
        // never rejects early, so every in-flight page finishes before the
        // pipeline continues.
        await Promise.all(scenePages.map(async (img) => {
          try {
            const preferred = enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber);

            // Caller-supplied retry image generator. Wraps generateImageOnly so
            // ensureCalmZone doesn't import images.js (would be circular).
            // PLATE OR FAIL: a landmark page's repair re-render carries its stored plate, never the raw photo (server/lib/landmarkScene.js).
            const generateImage = async (repairPrompt, opts) => {
              const repairScene = await resolveRepairScene({
                page: img, landmarkPhotos: img.landmarkPhotos, plate: img.emptySceneImage || null,
                storyId: jobId, pageNumber: img.pageNumber, label: 'CALM-ZONE',
              });
              return generateImageOnly(repairPrompt, img.characterPhotos || [], {
              imageModelOverride: opts.imageModelOverride,
              landmarkPhotos: img.landmarkPhotos || [],
              landmarkScene: repairScene.landmarkScene,
              sceneBackground: repairScene.sceneBackground,
              visualBibleGrid: img.visualBibleGrid || null,
              previousImage: opts.previousImage,
              textAreaMask: opts.textAreaMask,
              pageNumber: img.pageNumber,
              skipCache: true,
              aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
              });
            };

            const onUsage = (result) => {
              if (!result.usage) return;
              const isRunware = result.modelId?.startsWith('runware:');
              const isGrok = result.modelId?.startsWith('grok-imagine');
              const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, result.usage, 'page_images', result.modelId);
            };

            const result = await ensureCalmZone({
              imageData: img.imageData,
              text: img.text,
              textPosition: preferred,
              pageNumber: img.pageNumber,
              languageLevel: inputData?.languageLevel || 'standard',
              textAreaMask: img.textAreaMask,
              sceneDescription: img.sceneDescription || '',
              // img.sceneDescription still carries the ---METADATA--- block and
              // its VB ids, and this prompt goes to an image model.
              visualBible,
              generateImage,
              onUsage,
              label: 'TEXT-SPACE',
            });

            img.imageData = result.winnerImageData;
            // Persist all candidates so the dev viewer can show each attempt.
            // Candidate 0 inherits the original's Grok refs; repair candidates
            // carry their own captured by ensureCalmZone.
            img.textSpaceCandidates = result.candidates.length > 1
              ? result.candidates.map((c, i) => ({
                  imageData: c.imageData,
                  position: c.position,
                  rect: c.rect,
                  calmFoundPx: c.calmFoundPx,
                  areaPx: c.areaPx,
                  source: c.source,
                  prompt: c.prompt,
                  modelId: c.modelId || img.modelId || null,
                  grokRefImages: i === 0 ? (img.grokRefImages || null) : c.grokRefImages,
                  isWinner: i === result.winnerIndex,
                }))
              : null;
            img.textCoverageReport = result.report;
            textRegionResults[img.pageNumber] = {
              position: result.winnerCandidate.position,
              rect: result.winnerCandidate.rect,
              report: result.report,
            };
          } catch (pageErr) {
            // This page keeps its ORIGINAL bytes — img.imageData is only
            // reassigned after ensureCalmZone succeeds, so a mid-flight throw
            // leaves it untouched. No textRegionResults entry → downstream
            // falls back to the scene metadata's textPosition.
            log.warn(`⚠️ [TEXT-REGION] Page ${img.pageNumber}: text-space check failed (${pageErr.message}) — keeping original image`);
          }
        }));
        const passed = Object.entries(textRegionResults).filter(([, r]) => r.report.passed).length;
        const repaired = Object.entries(textRegionResults).filter(([, r]) => r.report.retriesUsed > 0).length;
        const failedPages = scenePages.length - Object.keys(textRegionResults).length;
        log.info(`📝 [TEXT-REGION] Processed ${scenePages.length} pages, ${passed} passed, ${repaired} repaired for text space${failedPages > 0 ? `, ${failedPages} FAILED (original bytes kept)` : ''}`);
      } catch (trErr) {
        // Per-page failures are caught above; reaching here means the phase
        // broke BEFORE/AROUND the page loop (require, filter, setup). The old
        // message said "using original images", which was false for pages a
        // rejected Promise.all had already washed — with per-page catches the
        // aggregate no longer rejects, so any page listed in textRegionResults
        // genuinely shipped its washed bytes.
        log.warn(`⚠️ [TEXT-REGION] Phase setup failed: ${trErr.message} — pages not yet processed keep their original images`);
      }

      if (skipQualityEval) {
        // Trial/lightweight mode: skip evaluation and repair entirely.
        // Drop the cover entries (pageNumber < 0 — added above so they
        // would have flowed through the eval pipeline) BEFORE mapping
        // into allImages — covers live on storyData.coverImages, not on
        // sceneImages. Without this filter the sharing-viewer treats
        // sceneImages.length as the page count, sees one entry with
        // pageNumber=-1, and emits a phantom hasImage=false page at
        // index N+1 — manifests as a "no image" placeholder past the
        // last real story page.
        log.info(`⏭️ [UNIFIED] Skipping quality evaluation and repair pipeline (skipQualityEval=true)`);
        allImages = rawImages
          .filter(img => img.pageNumber == null || img.pageNumber >= 0)
          .map(img => ({
          pageNumber: img.pageNumber,
          text: img.text,
          description: img.sceneDescription,
          sceneDescription: img.sceneDescription,  // alias for backward compat
          // sceneMetadata carries the parsed setting.location + characters[].id
          // + objects[].id the page render actually used.
          // Without persisting it, the dev panel + downstream consumers had
          // to re-run extractSceneMetadata to recover the per-page VB tags,
          // and the UI showed empty for every trial page even though the
          // JSON description had the IDs all along.
          sceneMetadata: img.sceneMetadata || null,
          // KNOWN-DEGRADED BRIEF (2026-09-15). The page's metadata came out of
          // the prose-only recovery path, so this page went to the image model
          // with no cast, no clothing contract, no props and no text placement.
          // This whitelist is the single gate on what reaches stories.data —
          // without this line the state exists only inside sceneMetadata and in
          // a log line. null = normally parsed brief. Recording only: it changes
          // no score, no severity and no repair route.
          degradedScene: describeDegradedSceneMetadata(img.sceneMetadata),
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          // The fields the Jev decision layer fixed for this page (2026-09-28):
          // an iterate rewrite re-pins them (images.js iteratePageCore). null
          // on a trial, a cover and the Jev-outage backup.
          jevFixed: img.scene?.jevFixed || null,
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          // Post-shrink scene block, when the prompt was over the model cap
          // (see the page-record comment above). Persisted so a repair rerun
          // from the stored story evaluates against the sent description too.
          compressedScene: img.compressedScene || null,
          // sceneDescriptionPrompt is NOT stored per page (2026-09-21). It was a
          // second inline copy of the ~112 KB Art Director prompt, with no reader
          // anywhere; the one copy lives in sceneExpansionReport.prompts[] and
          // sceneDescriptions[].scenePromptRef points at it.
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          thinkingText: img.thinkingText || null,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid || null,
          grokRefImages: img.grokRefImages || null,
          emptySceneImage: img.emptySceneImage || null,
          emptyScenePrompt: img.emptyScenePrompt || sceneBackgrounds[img.pageNumber]?.prompt || null,
          // Refs packed into the empty-scene plate call, and the vantage
          // group the plate belongs to. Both are whitelisted here or they
          // never reach stories.data. Base64 in emptySceneGrokRefImages is
          // offloaded to R2 by extractInlineImagesToR2 (explicit walker).
          emptySceneGrokRefImages: img.emptySceneGrokRefImages || sceneBackgrounds[img.pageNumber]?.grokRefImages || null,
          vantageId: img.vantageId || sceneBackgrounds[img.pageNumber]?.vantageId || null,
          plateDerivedFor: img.plateDerivedFor || sceneBackgrounds[img.pageNumber]?.plateDerivedFor || null,
          emptySceneQc: img.emptySceneQc || require('./server/lib/plateQc').emptySceneQcOf(sceneBackgrounds[img.pageNumber]),
          emptySceneVbGrid: img.emptySceneVbGrid || sceneBackgrounds[img.pageNumber]?.emptySceneVbGrid || null,
          // Mask sent to Grok during empty-scene generation (Pass 1). Persisted so the
          // dev-mode references panel can show the thumbnail of what was actually sent.
          textAreaMask: img.textAreaMask || sceneBackgrounds[img.pageNumber]?.textAreaMask || null,
          sceneCharacters: img.sceneCharacters,
          sceneCharacterClothing: img.perCharClothing,
          // textPosition is only meaningful for layouts that overlay text on
          // the image (1st-grade). For standard/advanced layouts the text is
          // rendered beside the image, so persisting a textPosition here would
          // leak calm-zone language into downstream prompts (inpaint, char
          // repair). Gate on the same flag the text-region phase uses so the
          // two stay in lock-step.
          textPosition: skipTextRegionPhase
            ? null
            : (textRegionResults[img.pageNumber]?.position || enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber)),
          textRect: textRegionResults[img.pageNumber]?.rect || null,
          textCoverageReport: textRegionResults[img.pageNumber]?.report || null,
          calmRegion: img.calmRegion || null,
          outlineCharacters: img.scene?.outlineCharacters || null,
          // Scene-composite intermediates from server/lib/sceneComposite.js.
          // Persisted to story_images by saveStoryData/Update so the dev panel
          // can show the BG → blocking → composited → final pipeline. Stripped
          // from the JSONB blob after save.
          compositeDebug: img.compositeDebug || null,
          // WHY the composite did or did not produce this page: 'triggered' /
          // 'composited' / 'no-image' / 'aborted' + the gate's own reason. A
          // few hundred bytes, no image data. Dropping it here meant three
          // separate stories had to be diagnosed by inference and one could not
          // be answered at all — the single field that says what happened was
          // the one the save threw away.
          compositeOutcome: img.compositeOutcome || null,
          imageVersions: [],
        }));
      } else {
        log.info(`🔧 [UNIFIED] Running unified repair pipeline...`);
        // Warm the analyzer's vision models NOW, at the start of the repair
        // phase. MobileSAM (repair masks, all backends) and GroundingDINO
        // (staging figure detection) idle-unload after ~15 min, and a story's
        // text+image phase can exceed that — so the first bbox detection below
        // would otherwise pay a cold model load mid-repair (observed as cold
        // "returned nothing" fallbacks). Fire-and-forget; the load overlaps the
        // eval that follows. force=true so the shared 5-min debounce can't skip it.
        require('./server/lib/analyzerClient').ensureWarm('repair-phase', { force: true });

        // Phase 5b-pre: Shared bbox detection — runs ONCE per image before quality eval
        // and entity consistency. Both consume the same result, avoiding redundant API calls.
        const { detectAllBoundingBoxes } = require('./server/lib/images');
        const { buildSecondaryExpectedCharacters, buildCastIdentityDescription, buildSecondaryExpectedForPage } = require('./server/lib/storyHelpers');
        const bboxLimit = pLimit(500); // match quality-eval concurrency; existing retry logic handles 503s
        const bboxStartTime = Date.now();
        log.info(`🔍 [UNIFIED] Phase 5b-pre: Shared bbox detection for ${rawImages.length} images...`);
        await Promise.all(rawImages.filter(img => img.imageData).map(img => bboxLimit(async () => {
          try {
            const sceneMetadata = img.sceneMetadata || {};
            // sceneCharacters entries have NO `description` key, so the old
            // `c.description || ''` sent the identity call bare names — see
            // buildCastIdentityDescription for the measured consequence.
            // CLOTHING COMES FROM THE PAGE, IDENTITY FROM THE CHARACTER.
            // sceneCharacterClothing holds a CATEGORY ('costumed:mermaid'), not a
            // garment, so it is resolved through buildClothingDescription —
            // clothingRequirements first, per the settled canonical-source rule.
            // This matters both ways: a bare tag would leak into the prompt, and
            // a STALE outfit is worse than none — bboxDetection records a page
            // where the detector was told to look for "Lukas wearing striped
            // hoodie" on a cowboy page and tagged every figure UNKNOWN.
            const clothingByName = img.sceneCharacterClothing || sceneMetadata.characterClothing || {};
            // The SHARED clothing chain, like every other identity-line builder
            // (owner, 2026-08-20 — smoke #2 caught this as the LAST unconverted
            // site). Covers have no sceneCharacterClothing, so the old
            // `if (category)` gate sent every cover figure to the detector
            // undressed: all cover seedTraces read "no garment colour in the
            // identity line" while the pages seeded fine. The chain falls back
            // hint -> clothingRequirements.used -> standard -> wardrobe and
            // ERRORs when a figure would go out naked.
            const shBbox = require('./server/lib/storyHelpers');
            const expectedCharacters = (img.sceneCharacters || []).map(c => {
              const name = c.name || c;
              if (typeof c !== 'object') return { name, description: '' };
              const clothingText = shBbox.buildIdentityClothingText(
                c, clothingByName[name], artStyle, clothingRequirements || null,
                { label: `P${img.pageNumber} ` });
              // `clothing` MUST ride along as its own field (bug som-identity-lines-
              // undressed, 2026-08-22): the SoM prompt builder STRIPS "Wearing:..."
              // from the description (Gemini safety measure) and rebuilds the
              // wardrobe from c.clothing — without this field every generation-time
              // identity line went out with no shirt colours at all, and four
              // near-identical face-prose lines were named by elimination
              // (measured: hpv76p0rokg p3 v0 — red kid named Julian in 4/4
              // gen-time calls, correct in 6/6 Lab calls whose builder sets it).
              // position: the scene plan's placement prose ("centre foreground") —
              // the SoM prompt uses it as a hint and the layout fallback derives
              // xTarget/depth from it. Was never passed (owner, 2026-08-22): on the
              // p1 crowd page the fallback ran with xTarget null and preferred
              // mid-depth pedestrians over the foreground kids.
              return { name, description: shBbox.buildIdentityLine(c, clothingText), clothing: clothingText,
                position: sceneMetadata?.characterPositions?.[name] || c.position || null };
            });
            // Story-invented characters live ONLY in the Visual Bible — never in
            // sceneCharacters, which is the user's photo-backed cast. Without them
            // the identity call gets N names for N+1 figures and the SoM prompt's
            // lenient branch assigns a cast name to the invented figure: staging
            // job_1786737619634_d66c7bg9g p4 answered {A:"Emma", B:"unknown",
            // C:"Noah"} where badge A was Lira the mermaid, so Emma's name landed
            // on her and the real Emma came back unknown (same on
            // job_1786571353564_0sgrd0f4g p4). Detection boundary only — they are
            // never added to storyData.characters, which needs photos + avatars.
            expectedCharacters.push(...buildSecondaryExpectedCharacters(
              visualBible, sceneMetadata, expectedCharacters.map(c => c.name),
              { pageLabel: `PAGE ${img.pageNumber} `, extraNames: img.scene?.outlineCharacters || [] }
            ));
            // …and any secondary that declares THIS page in its own `pages`.
            // On job_1786743927715_kcx0p939w p3 the scene metadata named only
            // [Emma, Noah] while Lira (pages [3,5,9]) was in the prose and the
            // image prompt — so the name-based collector above found nothing and
            // the identity call again had 2 names for 3 figures.
            expectedCharacters.push(...buildSecondaryExpectedForPage(
              visualBible, img.pageNumber, expectedCharacters.map(c => c.name)
            ));
            // ONE ROSTER (2026-09-13). The entries above keep their identity
            // prose — the detector needs it and the eval roster does not carry
            // it — but MEMBERSHIP is decided in one place, by
            // buildExpectedCastBlock, for every builder in the pipeline. Before
            // this the detector and the evaluator answered "who is on this page"
            // separately and disagreed (job_1789207854566_l43qgl34w p7: detector
            // Sarah/Saira/Facundo/Fiona, evaluator Sarah/Facundo/Frau Amrein).
            const { resolveExpectedCastNames, reconcileDetectorCast } = require('./server/lib/evalPipeline');
            const authoritativeCast = resolveExpectedCastNames({
              sceneCharacters: img.sceneCharacters || null,
              sceneHint: img.sceneHint || null,
              originalPrompt: img.sceneDescription || '',
              visualBible,
              evaluationType: img.evaluationType || 'scene',
              pageLabel: `PAGE ${img.pageNumber} `,
              sceneMetadata,
              pageNumber: img.pageNumber,
              extraNames: img.scene?.outlineCharacters || [],
              // The photo-backed cast, so the resolver's index knows the main
              // characters — without it every main name came back unresolved.
              storyData: { characters: inputData.characters || [], visualBible },
            });
            const reconciled = reconcileDetectorCast(expectedCharacters, authoritativeCast,
              { visualBible, pageLabel: `PAGE ${img.pageNumber} `,
                storyData: { characters: inputData.characters || [], visualBible } });
            const expectedObjects = Array.isArray(sceneMetadata.objects)
              ? sceneMetadata.objects.filter(o => typeof o === 'string')
              : [];
            img.sharedBboxDetection = await detectAllBoundingBoxes(img.imageData, {
              expectedCharacters: reconciled.entries,
              expectedObjects,
              sceneContext: img.sceneDescription || null,
              pageContext: `PAGE ${img.pageNumber}`,
              artStyle,
            });
            // The authoritative names ride ALONGSIDE expectedCharacters, never
            // instead of it: the arithmetic reads this, the SoM prompt reads
            // the described entries.
            if (img.sharedBboxDetection) img.sharedBboxDetection.expectedCastNames = reconciled.names;
            const figCount = img.sharedBboxDetection?.figures?.length || 0;
            const idCount = img.sharedBboxDetection?.figures?.filter(f => f.name && f.name !== 'UNKNOWN').length || 0;
            log.debug(`🔍 [BBOX-SHARED] P${img.pageNumber}: ${figCount} figures, ${idCount} identified`);
          } catch (err) {
            log.warn(`⚠️ [BBOX-SHARED] P${img.pageNumber}: Detection failed: ${err.message} — fallback will run`);
            img.sharedBboxDetection = null;
          }
        })));
        const bboxElapsed = ((Date.now() - bboxStartTime) / 1000).toFixed(1);
        const sharedCount = rawImages.filter(img => img.sharedBboxDetection).length;
        log.info(`🔍 [UNIFIED] Phase 5b-pre: ${sharedCount}/${rawImages.length} shared bbox detections in ${bboxElapsed}s`);

        // Build storyData for iterate (needs scene descriptions, characters, visual bible)
        const pipelineStoryData = {
          characters: inputData.characters,
          // Phase 7 cell-crop refs: iteratePageCore checks
          // storyData.characterAvatars to crop a single body cell per character
          // (matching the scene's pose) instead of attaching the full 2×4
          // sheet. Without this field present, the cell-crop branch silently
          // skips and Grok receives the full sheet as a reference — the model
          // then tries to recompose all 8 cells into the page.
          characterAvatars: storyCharacterAvatars,
          // The stored record shape (brief under `description`), projected NOW
          // from expandedScenes: a spread-side mirror rewrites a scene's brief
          // after allSceneDescriptions was built, and iterate must rewrite the
          // brief the page was rendered from.
          sceneDescriptions: expandedScenes.map(scene => sceneDescriptionRecord(scene, scenePromptRefs)),
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
          clothingRequirements: clothingRequirements,
          pageClothing: pageClothingData,
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
            textPosition: skipTextRegionPhase
              ? null
              : (textRegionResults[r.pageNumber]?.position
                || enforceSpreadTextPosition(r.sceneMetadata?.textPosition || null, r.pageNumber)),
          })),
          coverImages,  // a full-story cover's brief record — iteratePageCore reads it (covers are pages)
          trialMode: !!inputData.trialMode, // coverIteratePath: trial covers never reach the page path
          title,
          dedication: inputData.dedication || '',
        };

        const { results: pipelineResult, charFixDetails, styleConsistency, bookAuditRounds, repairRounds, shippedDefective, survivingCriticals, notEvaluated: pipelineNotEvaluatedRollup } = await runUnifiedRepairPipeline(rawImages, {
          characters: inputData.characters,
          modelOverrides,
          usageTracker: (provider, usage, funcName, modelId) => {
            // Some legacy call sites in images.js call this as (null, usage, null, modelId).
            // Infer provider + function name from the model so the tokens aren't lost.
            if (provider == null && usage && modelId) {
              const m = String(modelId).toLowerCase();
              if (m.includes('claude') || m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
                provider = 'anthropic';
                if (!funcName) funcName = 'scene_expansion';
              } else if (m.includes('gemini')) {
                // Default Gemini calls without a function name to quality eval
                provider = 'gemini_quality';
                if (!funcName) funcName = 'consistency_check';
              }
            }
            return addUsage(provider, usage, funcName, modelId);
          },
          visualBible,
          artStyle: inputData.artStyle,
          jobId,
          dbPool,
          storyData: pipelineStoryData
        }, {
          // 0 = evaluate only. A run may request FEWER passes than the
          // configured max: one round over all pages exercises the whole repair
          // path (eval -> redo -> re-eval) at a third of the time and image
          // spend, which is what measurement runs want. Rounds 2-3 cost 17.5 of
          // the 46 images-stage minutes on a 14-page story. Admin-gated above;
          // clamped so a request can never ask for MORE than configured.
          maxRegenAttempts: enableFullRepair ? repairPasses : 0,
          evalConcurrency: 500,
          // Only a dev-mode USER override reaches the eval as an override. The
          // resolved default (modelOverrides.qualityModel = MODEL_DEFAULTS.qualityEval)
          // used to be passed here, and runVisualInventory lets an override beat
          // `inventoryModel` — so the staging Qwen inventory never ran on a
          // story job (every stored stage-1 call carried 2.5 Flash's 1990-token
          // signature; bugs.json inventory-model-shadowed-by-default-override).
          qualityModelOverride: inputData.modelOverrides?.qualityModel || null,
          useIteratePage: true  // Use iterate (re-expansion) for better redo quality
        });

        // Hoist pipeline data for use outside this block (finalChecksReport)
        pipelineEntityReport = pipelineResult[0]?.entityReport || null;
        pipelineEntityHistory = pipelineResult[0]?.entityHistory || null;
        pipelineCharFixDetails = charFixDetails;
        pipelineStyleConsistency = styleConsistency || null;
        pipelineBookAuditRounds = (bookAuditRounds && bookAuditRounds.length) ? bookAuditRounds : null;
        pipelineRepairRounds = (repairRounds && repairRounds.length) ? repairRounds : null;
        pipelineShippedDefective = (shippedDefective && shippedDefective.length) ? shippedDefective : null;
        pipelineSurvivingCriticals = survivingCriticals || null;
        pipelineNotEvaluated = pipelineNotEvaluatedRollup || null;

        // ── THE BOOK AUDIT'S TEXT ROUTE, ANSWERED (A8, owner 2026-09-21) ─────
        //
        // The audit reads the book that ships — each page's final picture beside
        // its final text — and routes a fault to TEXT when different prose would
        // fix it. Nothing read that route: the refine chain runs before the
        // repair loop and joined long ago, so a TEXT fault was stored evidence
        // and nothing else (measured 2026-09-19: 527 IMG against ONE TEXT over
        // 13 staging stories, unauditable because only the count was kept).
        //
        // ONE call, and only when a TEXT fault exists — a clean book pays
        // nothing. Scoped to the pages the faults name, and the pictures are
        // final by now, so the round may not move a passage between pages
        // (runPostAuditTextRound's scope note and its code-side scope gate).
        if (pipelineBookAuditRounds) {
          const auditTextFaults = [];
          const seenFaultLines = new Set();
          for (const r of pipelineBookAuditRounds) {
            for (const f of r.textFaults || []) {
              const line = String(f?.line || '').trim();
              // The same fault can survive into a later round's audit; it is one
              // fault, and sending it twice would ask for the page twice.
              if (!line || seenFaultLines.has(line)) continue;
              seenFaultLines.add(line);
              auditTextFaults.push(f);
            }
          }
          if (auditTextFaults.length > 0) {
            const { extractRefinablePages, runPostAuditTextRound } = require('./server/lib/textRefine');
            // The pages as they SHIP: expandedScenes carries the refined text
            // (the join above wrote it there) and the scene briefs the refine
            // template reads.
            const finalPages = extractRefinablePages(expandedScenes, { visualBible, clothingRequirements });
            genLog.info('text_post_audit_start', `The book audit routed ${auditTextFaults.length} fault(s) to TEXT — one corrective text round on the pages they name`);
            const postAudit = await runPostAuditTextRound(
              { ...inputData, visualBible },
              finalPages,
              auditTextFaults,
              {
                arc: beatsResult?.arcReviewReport?.finalArc || beatsResult?.beatsReviewReport?.arc || '',
                arcHints: beatsResult?.arcReviewReport?.arcHints || '',
                storyLogic: beatsResult?.arcReviewReport?.logic || '',
                usageLabel: 'text_refine_post_audit',
              }
            );
            if (postAudit) {
              // The report carries the round even when it changed nothing or
              // failed: a TEXT fault that reached its fixer and was not closed
              // is exactly the record that was missing before.
              textRefineReport = { ...(textRefineReport || {}), postAuditRound: postAudit.entry };
              if (postAudit.entry.changedPages.length > 0) {
                const byPage = new Map(postAudit.pages.map(p => [p.pageNumber, p.text]));
                for (const scene of expandedScenes) {
                  const t = byPage.get(scene.pageNumber);
                  if (t) scene.text = t;
                }
                // The page objects the save path reads: rawImages is what the
                // repair pipeline was handed, pipelineResult what it returned
                // and what allImages is mapped from below.
                for (const list of [rawImages, pipelineResult]) {
                  for (const img of list || []) {
                    const t = byPage.get(img.pageNumber);
                    if (t) img.text = t;
                  }
                }
                // data.story / data.storyText, assembled from the page text and
                // persisted as-is (same third store as the refine join).
                fullStoryText = storyPages.map(page =>
                  `--- Page ${page.pageNumber} ---\n${byPage.get(page.pageNumber) || page.text}`
                ).join('\n\n');
                genLog.info('text_post_audit_complete', `The corrective text round rewrote page(s) ${postAudit.entry.changedPages.join(', ')} on ${auditTextFaults.length} audit TEXT fault(s)`, null, { changedPages: postAudit.entry.changedPages, faults: auditTextFaults.length });
              } else if (postAudit.entry.ok) {
                genLog.warn('text_post_audit_nochange', `The corrective text round rewrote nothing — ${auditTextFaults.length} audit TEXT fault(s) ship as they were found`);
              } else {
                genLog.error('text_post_audit_failed', `The corrective text round failed (${postAudit.entry.error}) — ${auditTextFaults.length} audit TEXT fault(s) ship unanswered`);
              }
            }
          }
        }


        // Map pipeline results to allImages format. Index rawImages by
        // pageNumber so per-page intermediates that the pipeline drops
        // (compositeDebug, etc.) can be re-attached from the original
        // generation result — otherwise the composite intermediates
        // (clean BG → blocking → composited) are lost before save.
        const rawByPage = new Map((rawImages || []).map(r => [r.pageNumber, r]));
        allImages = pipelineResult.map(img => ({
          pageNumber: img.pageNumber,
          text: img.text,
          description: img.sceneDescription,
          sceneDescription: img.sceneDescription,  // alias for backward compat
          // See trial-branch comment above — both branches were dropping
          // sceneMetadata from the saved row even though every generation
          // step computed it from the scene description.
          sceneMetadata: img.sceneMetadata || null,
          // KNOWN-DEGRADED BRIEF (2026-09-15). The page's metadata came out of
          // the prose-only recovery path, so this page went to the image model
          // with no cast, no clothing contract, no props and no text placement.
          // This whitelist is the single gate on what reaches stories.data —
          // without this line the state exists only inside sceneMetadata and in
          // a log line. null = normally parsed brief. Recording only: it changes
          // no score, no severity and no repair route.
          degradedScene: describeDegradedSceneMetadata(img.sceneMetadata),
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          // The fields the Jev decision layer fixed for this page (2026-09-28):
          // an iterate rewrite re-pins them (images.js iteratePageCore). null
          // on a trial, a cover and the Jev-outage backup.
          jevFixed: img.scene?.jevFixed || null,
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          // Post-shrink scene block, when the prompt was over the model cap
          // (see the page-record comment above). Persisted so a repair rerun
          // from the stored story evaluates against the sent description too.
          compressedScene: img.compressedScene || null,
          // sceneDescriptionPrompt is NOT stored per page (2026-09-21). It was a
          // second inline copy of the ~112 KB Art Director prompt, with no reader
          // anywhere; the one copy lives in sceneExpansionReport.prompts[] and
          // sceneDescriptions[].scenePromptRef points at it.
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          qualityScore: img.qualityScore,
          // The canonical single score (picked version's finalScore). This
          // whitelist mapping predated the scoring unification and silently
          // dropped it — every stored scene had finalScore undefined while
          // qualityScore carried legacy junk.
          finalScore: img.finalScore ?? null,
          // CRITICAL findings still on the shipped version after the repair
          // budget ran out. This whitelist is the single gate on what reaches
          // stories.data — without this line the marker exists only in logs.
          unrepairedCritical: img.unrepairedCritical || null,
          // Per-page record of which dimensions were never judged on the
          // shipped version (null = no evaluation ran at all).
          notEvaluated: img.notEvaluated || null,
          qualityReasoning: img.qualityReasoning,
          thinkingText: img.thinkingText || null,
          wasRegenerated: img.wasRegenerated,
          wasCharacterFixed: img.wasCharacterFixed,
          bestSource: img.bestSource,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid ? (typeof img.visualBibleGrid === 'string' ? img.visualBibleGrid : `data:image/jpeg;base64,${img.visualBibleGrid.toString('base64')}`) : null,
          grokRefImages: img.grokRefImages || null,
          emptySceneImage: img.emptySceneImage || null,
          emptyScenePrompt: img.emptyScenePrompt || sceneBackgrounds[img.pageNumber]?.prompt || null,
          // Refs packed into the empty-scene plate call, and the vantage
          // group the plate belongs to. Both are whitelisted here or they
          // never reach stories.data. Base64 in emptySceneGrokRefImages is
          // offloaded to R2 by extractInlineImagesToR2 (explicit walker).
          emptySceneGrokRefImages: img.emptySceneGrokRefImages || sceneBackgrounds[img.pageNumber]?.grokRefImages || null,
          vantageId: img.vantageId || sceneBackgrounds[img.pageNumber]?.vantageId || null,
          plateDerivedFor: img.plateDerivedFor || sceneBackgrounds[img.pageNumber]?.plateDerivedFor || null,
          emptySceneQc: img.emptySceneQc || require('./server/lib/plateQc').emptySceneQcOf(sceneBackgrounds[img.pageNumber]),
          emptySceneVbGrid: img.emptySceneVbGrid || sceneBackgrounds[img.pageNumber]?.emptySceneVbGrid || null,
          // Mask sent to Grok during empty-scene generation (Pass 1). Persisted so the
          // dev-mode references panel can show the thumbnail of what was actually sent.
          textAreaMask: img.textAreaMask || sceneBackgrounds[img.pageNumber]?.textAreaMask || null,
          sceneCharacters: img.sceneCharacters,
          sceneCharacterClothing: img.perCharClothing,
          bboxDetection: img.bboxDetection,
          bboxOverlayImage: img.bboxOverlayImage,
          fixTargets: img.fixTargets || [],
          fixableIssues: img.fixableIssues || [],
          semanticResult: img.semanticResult || null,
          semanticScore: img.semanticScore ?? null,
          // Three-stage evaluation: Stage 1 = vision inventory text, Stage 2 =
          // Sonnet compliance JSON. Persisted so the dev-mode version picker
          // can show what Gemini actually saw vs what Sonnet judged.
          threeStageResult: img.threeStageResult || null,
          // O7: verbatim quality-eval model output + eval-template hash, so a
          // stored score stays re-derivable after prompt-file edits.
          qualityRawOutput: img.qualityRawOutput || null,
          evalTemplateHash: img.evalTemplateHash || null,
          issuesSummary: img.issuesSummary || null,
          imageVersions: img.imageVersions || [],
          retryHistory: img.retryHistory || [],
          // entityReport is deliberately NOT stamped per page (owner, 2026-09-01):
          // the pipeline put the SAME story-level report object on every row, so
          // stories.data carried N copies of a report that already ships once as
          // finalChecksReport.entity (built from pipelineEntityReport below).
          // Readers tolerate both shapes for old stories (server/routes/stories.js
          // garment-colour route reads finalChecksReport.entity first, then falls
          // back to the first sceneImage carrying a copy).
          // Do the evaluator and the detector agree on WHO IS WHO. Computed in
          // evaluateImageBatch, carried on the page record — and dropped here
          // until this line existed: the whitelist above is the single gate on
          // what reaches stories.data, so the record was built on every page of
          // job_1787493968756_4fgr5nukroz and stored on none of them.
          identityAgreement: img.identityAgreement || null,
          // textPosition is only meaningful for layouts that overlay text on
          // the image (1st-grade). For standard/advanced layouts the text is
          // rendered beside the image, so persisting a textPosition here would
          // leak calm-zone language into downstream prompts (inpaint, char
          // repair). Gate on the same flag the text-region phase uses so the
          // two stay in lock-step.
          textPosition: skipTextRegionPhase
            ? null
            : (textRegionResults[img.pageNumber]?.position || enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber)),
          textRect: textRegionResults[img.pageNumber]?.rect || null,
          textCoverageReport: textRegionResults[img.pageNumber]?.report || null,
          calmRegion: img.calmRegion || null,
          outlineCharacters: img.scene?.outlineCharacters || null,
          // Scene-composite intermediates from server/lib/sceneComposite.js.
          // Persisted to story_images by saveStoryData/Update so the dev panel
          // can show the BG → blocking → composited → final pipeline. Fall
          // back to the original rawImages entry — the repair pipeline does
          // not propagate this field through, so without the fallback every
          // composite intermediate is silently dropped on save.
          compositeDebug: img.compositeDebug || rawByPage.get(img.pageNumber)?.compositeDebug || null,
          // Same story as compositeDebug: the repair pipeline does not carry
          // this through, so it needs the rawImages fallback or every abort
          // reason is lost on the branch that runs for real stories.
          compositeOutcome: img.compositeOutcome || rawByPage.get(img.pageNumber)?.compositeOutcome || null
        }));

        // Extract covers from pipeline results back into coverImages (updated with eval data)
        const COVER_TYPE_MAP = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
        allImages = allImages.filter(img => {
          if (img.pageNumber < 0) {
            const coverKey = COVER_TYPE_MAP[String(img.pageNumber)];
            if (coverKey && coverImages[coverKey]) {
              // Update cover with pipeline eval results.
              //
              // ONE mirror, shared and guarded (2026-09-14). This used to be a
              // hand-listed assignment block, and it went stale exactly the way
              // the finalScore line below it records: it dropped
              // `threeStageResult`, `qualityRawOutput`, `evalTemplateHash`,
              // `identityAgreement`, `unrepairedCritical` and `notEvaluated`.
              // Measured on staging: 61 stored cover roots carried a
              // threeStageResult 0 times, while 78 of 78 of the same covers'
              // VERSION records carried one — the compliance judge had been
              // running on covers since 2026-06-28 and only the root lost its
              // verdict. `img` here is the repair pipeline's page mapping, the
              // same record a scene page is stored from, so the mirror is a
              // field-for-field copy. See server/lib/coverEvalMirror.js.
              applyCoverEvalMirror(coverImages[coverKey], img);
              // Copy imageVersions if pipeline produced new ones (regen, character fix, or first time)
              if (img.wasRegenerated || img.wasCharacterFixed || !coverImages[coverKey].imageVersions?.length ||
                  (img.imageVersions?.length > (coverImages[coverKey].imageVersions?.length || 0))) {
                coverImages[coverKey].imageVersions = img.imageVersions;
              }
              if (img.imageData) coverImages[coverKey].imageData = img.imageData;
              // The scene contract of the version that SHIPPED, not of the one
              // this cover started as. A page gets this for free (its stored
              // record IS the pipeline mapping); a cover is copied back field
              // by field, so a repaired cover kept the original render's sent
              // prose while shipping a rewrite's pixels. `?? null` and never a
              // skip-if-absent, for the same reason the eval mirror gives:
              // a stale value is worse than none. Not in COVER_EVAL_MIRROR_FIELDS
              // because this is the scene contract, not an eval verdict — the
              // mirror's own docstring reserves those for the caller.
              coverImages[coverKey].compressedScene = img.compressedScene ?? null;
              // …AND ITS PROMPT, FOR THE SAME REASON (2026-09-19). The line
              // above moved `compressedScene` onto the shipped version while
              // `prompt` was left describing the FIRST render, so one cover
              // record narrated two different renders — measured on staging
              // job_1789759147125_p08djwhbl initialPage, where the root prompt
              // was the original's and the root compressedScene the iterate's.
              // Both now name the version that shipped (repairPipeline resolves
              // it via resolveVersionPrompt, which keeps the original-lineage
              // fallback: this field is a model input on the re-run path, so it
              // is never null while the cover rendered at all).
              coverImages[coverKey].prompt = img.prompt ?? coverImages[coverKey].prompt ?? null;
              // A FULL-STORY cover is a page (2026-09-24): its brief is its scene
              // contract, and an iterate rewrites it. The shipped version's brief
              // travels back like its prompt, so the next iterate / repair reads
              // the brief the shipped pixels were painted from.
              if (!inputData.trialMode) {
                coverImages[coverKey].sceneDescription = img.sceneDescription ?? coverImages[coverKey].sceneDescription ?? null;
                coverImages[coverKey].description = coverImages[coverKey].sceneDescription;
                coverImages[coverKey].sceneMetadata = img.sceneMetadata ?? coverImages[coverKey].sceneMetadata ?? null;
                coverImages[coverKey].sceneCharacters = img.sceneCharacters ?? coverImages[coverKey].sceneCharacters ?? null;
              }
              if (img.wasRegenerated) coverImages[coverKey].wasRegenerated = true;
              log.info(`📸 [UNIFIED] ${coverKey} pipeline result: score ${img.qualityScore}, ${img.wasRegenerated ? 'regenerated' : 'original'}`);
            }
            return false; // Remove from allImages (covers stored separately)
          }
          return true;
        });
      }

    }

    // pagesEnd was stamped at Phase 5a completion (pure generation); this is
    // the REPAIR phase boundary. Fall back for paths that skipped Phase 5a.
    if (!timing.pagesEnd) timing.pagesEnd = Date.now();
    timing.repairEnd = Date.now();
    const imgSuccess = allImages.filter(p => p.imageData).length;
    const repairSecs = ((timing.repairEnd - timing.pagesEnd) / 1000).toFixed(1);
    log.debug(`📖 [UNIFIED] Generated ${imgSuccess}/${allImages.length} page images`);
    // The phase label must say what the phase ACTUALLY did. With
    // skipQualityEval on there is no detection, no eval, no entity check and no
    // repair round — only the text-space pass and persistence run — so naming
    // those stages made a trial look like it had been graded.
    const repairPhaseLabel = skipQualityEval
      ? 'post-generation phase (text-space + persistence only, NO evals/repair)'
      : 'repair phase (detection/evals/entity/rounds/covers)';
    log.debug(`⏱️ [UNIFIED] Page images: ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s, ${repairPhaseLabel} ${repairSecs}s`);
    genLog.info('images_complete', `${imgSuccess}/${allImages.length} pages: generation ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s, ${repairPhaseLabel} ${repairSecs}s`);

    // The refiner was joined before the repair pipeline (see
    // joinTextRefinement). This call covers the paths that skipped Phase 5a and
    // is a no-op on every normal run.
    await joinTextRefinement([allImages]);

    // Wait for cover images if still running (they ran parallel with page images)
    if (coverAwaitPromise) {
      if (!timing.coversEnd) {
        genLog.setStage('covers');
        log.debug(`⏳ [UNIFIED] Waiting for cover images to finish (page images done first)...`);
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [97, 'Finishing cover images...', jobId]  // 97 = covers finishing (after repair, which ends at 96)
        );
      }
      const COVER_TIMEOUT_MS = 180000; // 3 minutes
      try {
        await Promise.race([
          coverAwaitPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cover generation timed out after 3 minutes')), COVER_TIMEOUT_MS))
        ]);

        // Cover bbox detection happens in the shared Phase 5b-pre pass (covers
        // are pipeline pages -1/-2/-3, detected WITH expected characters). On
        // this fallback path (pipeline didn't consume the covers) there is no
        // stored detection — downstream consumers (entity consistency,
        // typography placement) re-detect or degrade gracefully.

        // App-side cover typography is baked ONCE, post-persistence, by
        // bakeCoverTypographyPostPersist (after upsertStory below). The old
        // in-pipeline applyCoverTypography call was removed 2026-07-20: it
        // branded the in-memory cover JSONB here, so the persisted story_images
        // rows were ALREADY branded, and the post-persist baker then re-branded
        // them (saving the already-branded image as the "textless" ${key}Art) →
        // DOUBLE "magicalstory.ch" / double title. Single baker = single source
        // of truth; bbox detection above still feeds placement via storyData.
      } catch (coverErr) {
        log.error(`❌ [UNIFIED] Cover generation failed/timed out: ${coverErr.message}`);
        genLog.error('covers_failed', coverErr.message);
        // Continue without covers — story is still usable
      }
    }

    timing.end = Date.now();

    // Log timing summary
    log.debug(`⏱️ [UNIFIED] Timing summary:`);
    log.debug(`   Story generation: ${((timing.storyGenEnd - timing.storyGenStart) / 1000).toFixed(1)}s`);
    if (timing.coversEnd) {
      log.debug(`   Cover images:     ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
    }
    log.debug(`   Page images:      ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s`);
    log.debug(`   TOTAL:            ${((timing.end - timing.start) / 1000).toFixed(1)}s`);

    // Log token usage summary with costs. Every figure below is the sum of
    // per-call costs booked by the ledger (server/lib/costLedger.js): a bucket that
    // mixes models is priced per call, and the headline equals the sum of the rows.
    const providerKeys = Object.keys(tokenUsage).filter(k => k !== 'byFunction');
    const totalInputTokens = providerKeys.reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0);
    const totalOutputTokens = providerKeys.reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0);
    const totalThinkingTokens = providerKeys.reduce((sum, k) => sum + (tokenUsage[k].thinking_tokens || 0), 0);
    const byFunc = tokenUsage.byFunction;
    const getModels = (func) => Array.from(func.models).join(', ') || func.provider || 'unknown';
    const functionCost = (funcName, func) => (func?.calls > 0 ? (func.cost || 0) : 0);
    const totalCost = ledgerTotal(tokenUsage);
    const unpricedCalls = Object.values(byFunc).reduce((n, f) => n + (f.unpriced_calls || 0), 0);
    if (unpricedCalls > 0) log.error(`❌ [COST] ${unpricedCalls} call(s) had no price (no direct_cost, no MODEL_PRICING row) and are booked at $0 — the total is a lower bound`);

    log.debug(`📊 [UNIFIED] Token usage & cost summary:`);
    log.debug(`   BY PROVIDER:`);
    for (const prov of providerKeys) {
      const pt = tokenUsage[prov];
      if (!(pt.calls > 0)) continue;
      const thinkStr = pt.thinking_tokens > 0 ? ` + ${pt.thinking_tokens.toLocaleString()} think` : (pt.thinking_in_output ? ' (thinking inside out)' : '');
      log.debug(`   ${prov.padEnd(15)} ${(pt.input_tokens || 0).toLocaleString().padStart(8)} in / ${(pt.output_tokens || 0).toLocaleString().padStart(8)} out${thinkStr} (${pt.calls} calls)  $${(pt.cost || 0).toFixed(4)}`);
    }

    log.debug(`   BY FUNCTION:`);
    for (const [funcName, func] of Object.entries(byFunc)) {
      if (!(func.calls > 0)) continue;
      const thinkStr = func.thinking_tokens > 0 ? ` + ${func.thinking_tokens.toLocaleString()} think` : (func.thinking_in_output ? ' (thinking inside out)' : '');
      const cutStr = func.cut_calls ? ` [${func.cut_calls} cut]` : '';
      log.debug(`   ${funcName.padEnd(28)} ${(func.input_tokens || 0).toLocaleString().padStart(8)} in / ${(func.output_tokens || 0).toLocaleString().padStart(8)} out${thinkStr} (${func.calls} calls)  $${(func.cost || 0).toFixed(4)}${cutStr}  [${getModels(func)}]`);
    }

    const thinkingTotal = totalThinkingTokens > 0 ? ` + ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);

    // INTENTIONALLY no checkCancellation() here. By this point the pipeline
    // has fully completed — every image generated, every cost paid, the
    // ✅ [UNIFIED PIPELINE] Complete log line has fired. The remaining work
    // is just persistence (writing the finished story to the stories table).
    // Aborting here would discard the in-memory completed story without
    // ever saving it — which is what bricked job_1777312806388_aja96pys7
    // (cancel signal arrived 1ms after Pipeline Complete and the catch
    // block returned null without persisting). After Pipeline Complete the
    // user's intent to "stop work" no longer applies — work is done; saving
    // the result is what turns paid compute into a deliverable. Earlier
    // checkCancellation() calls (before each page generation, etc.) still
    // honour cancellation while there's expensive work left to skip.
    log.debug(`📝 [UNIFIED] Updating job status to 95% (finalizing)...`);
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [98, 'Finalizing story...', jobId]  // 98 = finalizing
    );

    // Extract entity report from unified pipeline results (same on every page)
    let finalChecksReport = pipelineEntityReport ? { entity: pipelineEntityReport } : null;

    // Persist the per-round entity history from the pipeline so the UI's round
    // selector can browse generation-time passes (round 0 = initial, rounds 1+
    // = repair-loop snapshots). Same shape as manual-run pushes in
    // regeneration.js so EntityConsistencyView works without branching.
    if (finalChecksReport && Array.isArray(pipelineEntityHistory) && pipelineEntityHistory.length > 0) {
      finalChecksReport.entityHistory = pipelineEntityHistory;
    }

    // Build entityRepairs from character fix data for StoryDisplay before/after visualization
    if (finalChecksReport?.entity && pipelineCharFixDetails && Object.keys(pipelineCharFixDetails).length > 0) {
      finalChecksReport.entityRepairs = {};
      for (const [charName, charData] of Object.entries(pipelineCharFixDetails)) {
        finalChecksReport.entityRepairs[charName] = {
          timestamp: new Date().toISOString(),
          pages: charData.pages,
          cellsRepaired: Object.keys(charData.pages).length
        };
      }
    }

    // Style consistency audit (Step 8) — surface the verdict on the same
    // finalChecksReport that the StoryDisplay reads, so the dev panel can
    // show the cross-page style cluster + outliers without a separate fetch.
    if (pipelineStyleConsistency) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.styleConsistency = pipelineStyleConsistency;
    }

    // Mid-loop book audits — one compact record per repair round that had a
    // further round to feed. Kept next to the final audit below so the dev
    // panel can read the whole reader's-eye history in one place.
    if (pipelineBookAuditRounds) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.bookAuditRounds = pipelineBookAuditRounds;

      // OBJECT SCALE — the cross-page prop-size check (2026-09-20). It reports
      // to a HUMAN and fires no repair, so a field nobody reads is the same as
      // a check that never ran. Surfaced from the LAST round that carries one,
      // beside the other final checks the dev panel already reads.
      const lastScale = [...pipelineBookAuditRounds].reverse().find(r => r && r.objectScale);
      if (lastScale) finalChecksReport.objectScale = lastScale.objectScale;
    }

    // Per-round, per-method repair effectiveness (owner, 2026-09-13): which
    // method improved pages, which regressed them, which failed outright.
    if (pipelineRepairRounds) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.repairRounds = pipelineRepairRounds;
    }

    // KNOWN-BROKEN PAGES (D7). Attached whenever the repair budget ran out with
    // a page still below threshold or still carrying a CRITICAL, so the stored
    // story carries the list instead of it living only in a log line.
    if (pipelineShippedDefective) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.shippedDefective = pipelineShippedDefective;
    }

    // CRITICALS THAT SURVIVED REPAIR, AND WHAT WAS TRIED ON THEM (2026-09-14).
    // The owner kept the existing routing (every critical goes to iterate) and
    // asked for the evidence instead: which methods a still-broken page
    // consumed, and whether it shipped above or below the threshold. Report
    // only — it changes no route, no severity and no score.
    if (pipelineSurvivingCriticals) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.survivingCriticals = pipelineSurvivingCriticals;
    }

    // UNJUDGED DIMENSIONS (2026-09-14). A check that could not run must say so
    // in its result, not only in a log line — three checks shipped blind for
    // months because "ran clean" and "could not run" looked identical. This is
    // where an analyst reading stories.data finds which dimensions were never
    // judged, on which pages. Recording only: it changes no score and no
    // repair routing (owner decision the same day — scoring left as-is).
    if (pipelineNotEvaluated) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.notEvaluated = pipelineNotEvaluated;
    }

    // PAGES THAT SHIPPED ON PROSE ALONE (2026-09-15). Same contract as
    // notEvaluated above: a page whose brief was stripped before it was sent
    // must say so in the stored run, not only in a log line. An analyst reading
    // finalChecksReport now sees "page N shipped on prose alone" next to that
    // page's findings, which is what makes the scoring question answerable on
    // evidence. Recording only — no score, severity or route changes.
    const degradedScenePages = (allImages || [])
      .filter(img => img && img.degradedScene)
      .map(img => ({
        pageNumber: img.pageNumber,
        emptyInputs: img.degradedScene.emptyInputs || []
      }));
    if (degradedScenePages.length > 0) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.degradedScenes = degradedScenePages;
      for (const p of degradedScenePages) {
        log.warn(`⚠️  [DEGRADED SCENE] page ${p.pageNumber} shipped on prose alone — no ${p.emptyInputs.join(', ')}. Every judge scored it against a stripped brief.`);
      }
    }

    // Deterministic scene metadata ↔ scene design consistency findings (see
    // check right after the final parse). Attached even when empty so the dev
    // panel can show "checked, clean" vs "not run".
    if (sceneConsistencyResult) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.sceneConsistency = {
        checkedAt: new Date().toISOString(),
        issueCount: sceneConsistencyResult.reduce((n, e) => n + e.issues.length, 0),
        pages: sceneConsistencyResult
      };
    }

    // The final post-repair book audit was REMOVED (owner ruling, 2026-09-01):
    // its findings wrote to sceneImages[].bookAuditFaults, a field with zero
    // consumers (client, server/routes, and the dev panel never read it), and
    // finalChecksReport.bookAudit / data.bookAuditReport had none either. The
    // MID-LOOP audits (repairPipeline.js, MID-LOOP BOOK AUDIT) are unaffected —
    // their findings are charged to the version each audit read (repairLogic.js
    // attributeReaderFindings) and they stay exactly as
    // they were. The capability itself is not gone: run it on demand via the
    // Test Lab "book_audit" stage (server/lib/testlab.js runBookAuditStage) on
    // any completed story. See docs/decisions.md 2026-09-01.

    let originalStoryText = null;

    // Log API usage to generationLog BEFORE saving story (so it's included in the saved data)
    genLog.setStage('finalize');
    log.debug(`📊 [UNIFIED] Logging API usage to generationLog. Functions with calls:`);
    let emittedCostSum = 0;
    for (const [funcName, funcData] of Object.entries(byFunc)) {
      log.debug(`   - ${funcName}: ${funcData.calls} calls, ${funcData.input_tokens} in, ${funcData.output_tokens} out, thinking: ${funcData.thinking_in_output ? 'inside output' : (funcData.thinking_tokens || 0)}`);
      if (funcData.calls > 0) {
        const model = getModels(funcData);
        const directCost = funcData.direct_cost || 0;
        // Same helper that computes totalCost — per-event cost and the headline
        // total are identical by construction.
        const cost = functionCost(funcName, funcData);
        emittedCostSum += cost;
        log.debug(`   >>> genLog.apiUsage('${funcName}', '${model}', {in: ${funcData.input_tokens}, out: ${funcData.output_tokens}}, cost: $${cost.toFixed(4)})`);
        genLog.apiUsage(funcName, model, {
          inputTokens: funcData.input_tokens,
          outputTokens: funcData.output_tokens,
          thinkingTokens: funcData.thinking_tokens,
          directCost: directCost,
          cachedInputTokens: funcData.cached_input_tokens || 0,
          cacheWriteTokens: funcData.cache_write_tokens || 0,
          thinkingInOutput: !!funcData.thinking_in_output,
          cutCalls: funcData.cut_calls || 0,
          unpricedCalls: funcData.unpriced_calls || 0,
          // Pass the real call count — the emission previously omitted it, so
          // every event defaulted to "1 call" even when a bucket aggregated 15+.
          calls: funcData.calls
        }, cost);
      }
    }
    // Reconciliation guard — surfaces future accounting drift instead of it
    // silently returning. (1) headline totalCost must equal the sum of the
    // emitted per-call costs; (2) each token provider's total must equal the
    // sum of its per-function buckets — a mismatch means a call recorded to a
    // provider total but not to any bucket (or vice-versa).
    if (Math.abs(jobSpentUsd - totalCost) > 0.001) {
      log.warn(`⚠️ [ACCOUNTING] spend-cap running total $${jobSpentUsd.toFixed(4)} != headline totalCost $${totalCost.toFixed(4)}`);
    }
    if (Math.abs(emittedCostSum - totalCost) > 0.001) {
      log.warn(`⚠️ [ACCOUNTING] totalCost $${totalCost.toFixed(4)} != sum of per-call costs $${emittedCostSum.toFixed(4)} — cost breakdown drift`);
    }
    for (const prov of ['anthropic', 'gemini_text', 'gemini_quality']) {
      const pt = tokenUsage[prov]; if (!pt) continue;
      let binp = 0, bout = 0;
      for (const fd of Object.values(byFunc)) {
        if (fd.provider === prov) { binp += fd.input_tokens || 0; bout += fd.output_tokens || 0; }
      }
      if (Math.abs(binp - (pt.input_tokens || 0)) > 1 || Math.abs(bout - (pt.output_tokens || 0)) > 1) {
        log.warn(`⚠️ [ACCOUNTING] ${prov}: provider total ${pt.input_tokens}/${pt.output_tokens} != bucket sum ${binp}/${bout} — a call escaped per-function tracking`);
      }
    }
    // Add total cost summary to generation log
    genLog.info('total_cost', `💰 Total API cost: $${totalCost.toFixed(4)}`, null, {
      totalCost: totalCost,
      totalInputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0),
      totalOutputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0),
      runwareCost: tokenUsage.runware?.direct_cost || 0
    });
    genLog.finalize();
    clearCurrentLogger();
    log.debug(`📊 [UNIFIED] genLog now has ${genLog.getEntries().length} entries (including API usage)`);

    // Quality aggregates — one implementation, in server/lib/storyMetrics.js,
    // so the "not measured vs measured zero" rule is pinned by unit tests and
    // cannot drift between this writer and the metrics collector that reads it.
    const { computeQualityAnalytics, getBuildInfo } = require('./server/lib/storyMetrics');
    const {
      qualityEvaluated, qualityEvalSkipReason, attemptsMeasured, attemptSource,
      avgQualityScore, minQualityScore, maxQualityScore,
      firstAttemptPassRate, totalRetries, pagesWithIssues, contentBlocked,
    } = computeQualityAnalytics(allImages, { skipQualityEval });

    // A page or cover that reaches persistence with no image bytes is a
    // SHIPPED DEFECT — the story must say so instead of looking complete
    // (2026-08-29). `missingImages` is a plain list; the matching genLog error
    // is written here, before generationLog is snapshotted into storyData
    // below. The reader is `scripts/analysis/shipped-defects.js` (added
    // 2026-09-21 — until then the promised "admin/audit surface" did not
    // exist and these markers were written for nobody).
    const missingImages = (allImages || [])
      .filter(img => img && img.pageNumber > 0 && !img.imageData)
      .map(img => img.pageNumber)
      .sort((a, b) => a - b);
    const missingCovers = (!skipImages && !skipCovers)
      ? coverTypesFor(inputData).filter(ct => !coverImages?.[ct]?.imageData)
      : [];
    if (missingImages.length > 0) {
      log.error(`❌ [UNIFIED] Shipping with ${missingImages.length} imageless page(s): ${missingImages.join(', ')}`);
      genLog.error('pages_missing_images', `Story ships with no image on page(s) ${missingImages.join(', ')}`);
    }
    if (missingCovers.length > 0) {
      log.error(`❌ [UNIFIED] Shipping without cover(s): ${missingCovers.join(', ')}`);
      genLog.error('covers_missing', `Story ships without cover(s): ${missingCovers.join(', ')}`);
    }

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: title,
      titleCandidates: titleCandidates || null, // Full list the model produced; null if legacy single-line TITLE
      titleJudge, // {pick (array index), reason, candidates} — null when the judge did not run or failed
      storyType: inputData.storyType || '',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
      // What the idea generator offered, so the save path can work out whether
      // the customer used our idea, edited it, or wrote their own. The wizard
      // has always sent this; nothing carried it this far before 2026-08-25.
      // See server/lib/ideaProvenance.js.
      ideaGeneration: inputData.ideaGeneration || null,
      // Which world the chosen idea plays in: {world: 'location'|'fantasy',
      // theme, location}. Server-resolved at idea time (resolveIdeaWorlds in
      // server/routes/storyIdeas.js); null for custom/user-written ideas or
      // categories without the split (historical). The pipeline uses this to
      // honor the chosen world ("named location is binding").
      ideaWorld: inputData.ideaWorld || null,
      // WHICH of the two offered ideas the customer clicked, beside the world
      // it plays in: { index, world, shape, worldMode, attempt }. index null =
      // they wrote their own premise. The same pick is written to idea_events
      // (server/lib/ideaEvents.js) at job creation; it lives HERE as well so the
      // buy signal is queryable straight off stories.data without a join, the
      // way ideaWorld already is. Owner, 2026-09-21: the production click is the
      // buy metric, the rater proxy is not.
      ideaPick: inputData.ideaPick || null,
      trialMode: !!inputData.trialMode,
      artStyle: inputData.artStyle || 'pixar',
      language: inputData.language || 'en',
      languageLevel: inputData.languageLevel || '1st-grade',
      // Persist layout on storyData so PDF / shared-viewer / re-iteration code
      // doesn't need to re-derive it from languageLevel. Computed upfront in
      // processStoryJob and carried through the pipeline via inputData.
      layout: inputData.layout || null,
      pages: inputData.pages || sceneCount,
      dedication: inputData.dedication || '',
      season: inputData.season || '', // Season when story takes place
      userLocation: inputData.userLocation || null, // User's location for personalization
      // Whether the premise names its own binding world (server/lib/premiseWorld.js).
      // Persisted so Test Lab replays rebuild the same commission block.
      premiseNamedWorld: inputData.premiseNamedWorld === true,
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      // Full unified response INCLUDING the appended reviewer output (split
      // outline review). unifiedResult.text is writer-only — storing it here
      // made the Opus ANALYSIS invisible in the dev outline view.
      outline: unifiedResponse,
      outlinePrompt: unifiedPrompt, // Prompt sent to API (dev mode)
      outlineModelId: unifiedModelId, // Model used (dev mode)
      outlineUsage: unifiedUsage, // Token usage (dev mode)
      outlineReview: outlineReviewMeta, // { model, modelId, durationMs, fixCount, reviewChars, hintCount } | null
      storyTextPrompts, // beats: the page-text writer's prompt + raw reply (incl. its ANALYSIS block); [] on the streaming path
      visualBible: (() => {
        // Phase 2: project per-character costume descriptions onto the visual
        // bible's `costumes` field so the story has a single source of truth
        // for "what does Emma's pirate outfit look like" — independent of
        // character.avatars.clothing.costumed.<subtype> on the character row.
        const sav = require('./server/lib/storyAvatars');
        const costumes = sav.projectStoryCostumeDescriptions(clothingRequirements);
        if (Object.keys(costumes).length === 0) return visualBible;
        const vb = visualBible || {};
        vb.costumes = costumes;
        return vb;
      })(),
      // Story-scoped character avatars (Phase 1: shadow write). Projected from
      // inputData.characters[*].avatars.styledAvatars[<artStyle>]. Later phases
      // make this the only source page generation reads from.
      characterAvatars: require('./server/lib/storyAvatars').projectStoryCharacterAvatars(
        inputData.characters || [],
        inputData.artStyle || 'pixar'
      ),
      styledAvatarGeneration: getStyledAvatarGenerationLog(), // Styled avatar generation log (dev mode)
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(), // Costumed avatar generation log (dev mode)
      story: fullStoryText, // Canonical field name — frontend reads 'story'
      storyText: fullStoryText, // Keep for backwards compatibility with existing blobs
      writerText, // The writer's draft, never overwritten — see the capture site
      originalStory: originalStoryText || fullStoryText, // Store original AI text for dev mode
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      // Visible defect flags — non-empty means the book shipped incomplete.
      missingImages: missingImages.length > 0 ? missingImages : null,
      missingCovers: missingCovers.length > 0 ? missingCovers : null,
      // Set (to the staged count) when the story shipped below the 2-real-
      // landmark guideline after one fed-back writer retry; null when met or
      // when the guideline didn't apply (premise-named world / no landmarks).
      landmarkMinimumShortfall,
      coverHints: coverHints, // Cover scene hints with per-character clothing from outline
      pageClothing: pageClothingData, // Clothing per page
      clothingRequirements: clothingRequirements, // Per-character clothing requirements
      tokenUsage: JSON.parse(JSON.stringify(tokenUsage, (k, v) => v instanceof Set ? [...v] : v)), // Token usage (Sets to Arrays)
      generationLog: genLog.getEntries(), // Generation log for dev mode
      textRefineReport, // per-page before/after from the parallel refine pass
      arcReviewReport,   // drafted arc + arc-review analysis (beats mode)
      // The catalogue ids this book was OFFERED — kept for audit: a repeat can
      // be read back against the whole menu the arc saw.
      challengeDrawIds,
      // The ids of those the shipped arc actually TOOK (a subset). THIS is what
      // the next book on this account excludes at draw time
      // (loadUsedChallengeIds; owner, 2026-09-21 / 2026-09-27) — the whole of
      // the cross-story variety rule: no prompt names a previous story. An empty
      // list with a non-empty draw raises `arc_challenges_taken_missing`.
      challengeTakenIds,
      challengeDraw, // the catalogue menu the arc plan was offered (beats mode)
      // How that menu was chosen (2026-09-27): Jev's score per eligible id, its
      // top 20 and the 12 drawn — or the random draw on the Jev backup.
      challengeSelection: beatsResult?.challengeSelection || null,
      // How the landmark list was ordered: Jev's LB2 score per place and the
      // order every writer read (the trial: the 3 it was given) — or today's.
      landmarkSelection: inputData.landmarkSelection || null,
      // What a Test Lab replay needs and the run held only in memory
      // (2026-09-27): the shuffled landmark list every writer prompt read, and
      // the run's model overrides. Text only. Read by beatsReplayInputs
      // .resolveReplayInputData, never as a top-level input of a later path.
      replayInputs: {
        availableLandmarks: require('./server/lib/beatsReplayInputs').landmarksForReplay(inputData.availableLandmarks),
        modelOverrides: modelOverrides || null,
      },
      beatsReviewReport, // per-page before/after from the beats review (beats mode)
      jevDecisions, // the Jev decision layer's per-page decisions (beats mode)
      jevFallback, // the Jev-outage backup ran from this step (null = Jev-authored)
      storyBibleReport, // wardrobe contract call: prompt + raw reply (beats mode)
      clothingReviewReport, // per-outfit before/after from the wardrobe review (beats mode)
      wardrobeBibleReport, // wardrobe contract vs Visual Bible: adopt / conflict findings (beats mode)
      // The Art Director's own prompt(s), rolled up by distinct prompt with the
      // pages each produced — so "what was this book's brief actually asked for"
      // is a query, not a worktree rebuild at the run's commit.
      sceneExpansionReport,
      briefCheckReport, // brief checks + the one Art Director re-ask: findings, verdicts, taken rewrites (beats mode)
      finalChecksReport: finalChecksReport || null, // Final consistency checks report (dev mode)
      analytics: {
        // Cost
        totalCost,
        // Timing (ms)
        totalDurationMs: timing.end - timing.start,
        storyGenDurationMs: timing.storyGenEnd - timing.storyGenStart,
        imagesDurationMs: timing.pagesEnd - timing.pagesStart,
        // Repair phase = pagesEnd (pure generation done) → repairEnd (pipeline
        // done): detection, evals, entity checks, repair rounds, cover checks.
        repairDurationMs: timing.repairEnd ? timing.repairEnd - timing.pagesEnd : null,
        coversDurationMs: timing.coversEnd ? timing.coversEnd - (timing.coversStart || timing.storyGenEnd) : null,
        // Quality.
        // `qualityEvaluated: false` marks every score/count below as NOT
        // MEASURED (all null) — the run skipped the eval + repair pipeline.
        // `true` means the numbers are real, including a truthful 0 / 100.
        qualityEvaluated,
        qualityEvalSkipReason: qualityEvaluated ? null : 'skipQualityEval',
        // `attemptsMeasured: false` marks firstAttemptPassRate/totalRetries as
        // NOT MEASURED — no page carried an attempt counter. They were
        // previously derived from `totalAttempts`, which no generation path
        // writes, so an evaluated run with 14 real retries reported 100 / 0
        // (staging job_1789348171785_9oxos7dwv). Counter source now:
        // retryHistory. `attemptSource` names it.
        attemptsMeasured,
        attemptSource,
        avgQualityScore,
        minQualityScore,
        maxQualityScore,
        firstAttemptPassRate,
        totalRetries,
        pagesWithIssues,
        contentBlocked,
        // Counts
        characterCount: (inputData.characters || []).length,
        sceneCount: allImages.length,
        coverCount: Object.keys(coverImages || {}).filter(k => coverImages[k]?.imageData || coverImages[k]?.hasImage).length,
        // Pipeline config
        // Which code produced this story. Same env var /api/health reports
        // (RAILWAY_GIT_COMMIT_SHA); null on a local run, never a throw. Without
        // it, "did that fix hold?" means reconstructing the deploy history from
        // timestamps — guesswork when a push lands minutes before a job starts.
        build: getBuildInfo(),
        pipelineConfig: {
          enableFullRepair,
          // The pipeline this run actually took (beats | unified).
          pipelineMode,
          // Recorded alongside it because repair is unreachable when eval is
          // skipped: without this the row could not be read back correctly.
          skipQualityEval,
        },
        // Models used
        models: (() => {
          const of = (fn) => (byFunc[fn]?.models ? Array.from(byFunc[fn].models) : []);
          const uniq = (a) => [...new Set(a.filter(Boolean))].sort();
          // `all` is derived from the usage ledger, not hand-picked. The four
          // buckets below name one stage each and between them missed the
          // reviewer (DeepSeek ran beat, wardrobe, scene review AND text
          // refine), both Qwen models (iterate, consolidation, semantic) and
          // grok-imagine (inpaint) — 5 of the 9 models a beats story uses.
          const all = uniq(Object.values(byFunc).flatMap(f => (f?.calls > 0 && f.models) ? Array.from(f.models) : []));
          return {
            text: unifiedModelId,
            image: of('page_images'),
            quality: of('page_quality'),
            // beats labels this stage beats_scene_expansion; reading only the
            // unified label reported an empty list on every beats run.
            sceneExpansion: uniq([...of('scene_expansion'), ...of('beats_scene_expansion')]),
            all,
          };
        })(),
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Attach reference sheet batch metadata so the dev panel can label cells.
    // The actual source grid images live in story_images (saved after upsert);
    // this is just the lightweight per-batch element list.
    if (referenceSheetBatchMeta) {
      storyData.referenceSheetBatches = referenceSheetBatchMeta;
    }

    // Debug: Log what's being saved for storyCategory/storyTheme in unified mode
    log.debug(`📝 [UNIFIED SAVE] storyCategory: "${storyData.storyCategory}", storyTopic: "${storyData.storyTopic}", storyTheme: "${storyData.storyTheme}"`);
    log.debug(`📝 [UNIFIED SAVE] mainCharacters: ${JSON.stringify(storyData.mainCharacters)}, characters count: ${storyData.characters?.length || 0}`);

    // Persist styled avatars to BOTH story data AND characters table.
    // MUST run BEFORE upsertStory: storyData.characters is the same array as
    // inputData.characters, so mutating it here is what puts styledAvatars into
    // the saved blob. This block used to run ~80 lines below the save, so the
    // stored story kept empty avatar shells ({styledAvatars:{}}) and every later
    // cover-Überarbeiten / page-iterate found no usable character avatars.
    // Realistic included — exports whatever was generated (redressed
    // categories + costumes); a zero-size map is a no-op.
    // A cancelled job must not persist into the user's account (styled avatars,
    // story row) or email them. The last cancellation check above sits in the
    // image phase, so a cancel landing during repair/covers used to sail
    // straight through save + email (observed 2026-08-23 on an admin rerun of
    // a customer's story — only a container restart stopped the mail).
    await checkCancellation();

    if (inputData.characters) {
      try {
        const styledAvatarsMap = exportStyledAvatarsForPersistence(inputData.characters, artStyle, characterIdKey);
        if (styledAvatarsMap.size > 0) {
          log.debug(`💾 [UNIFIED] Persisting ${styledAvatarsMap.size} styled avatar sets...`);

          // 1. Save to story data (inputData.characters) - IMPORTANT for repair workflow
          applyStyledAvatarsById(inputData.characters, styledAvatarsMap, artStyle);

          // 2. Also save to characters table (for character editor)
          const characterId = `characters_${userId}`;
          // styledAvatars come off the in-memory pipeline as data: URIs — this is the
          // authenticated-user twin of the trial prewarm leak and the likeliest source
          // of the base64 rows seen in prod. The slow R2 upload runs BEFORE the row
          // lock; the locked read-modify-write below only merges (review 2026-10 A4).
          const { offloadCharacterImages, modifyCharactersRow } = require('./server/services/database');
          await offloadCharacterImages(characterId, userId, { styledAvatars: [...styledAvatarsMap.values()] });
          let updatedCount = 0;
          await modifyCharactersRow(characterId, userId, (charData) => {
            // By character ID: same-name characters on one account must not share sheets.
            updatedCount = applyStyledAvatarsById(charData.characters, styledAvatarsMap, artStyle);
            return updatedCount > 0;
          });
          if (updatedCount > 0) {
            log.debug(`💾 [UNIFIED] Updated ${updatedCount} characters in database with ${artStyle} styled avatars`);
          }
        }
      } catch (persistErr) {
        log.error('❌ [UNIFIED] Failed to persist styled avatars:', persistErr.message);
        // Non-fatal - story generation continues
      }
    }

    // Saving marker: from here a user cancel is refused (server/routes/jobs.js guards on
    // progress < JOB_SAVING_PROGRESS), so a story is never both saved and refunded. The
    // write is guarded on status='processing': if the cancel won the race, abort before
    // the story row is written instead of saving a story for a refunded job.
    const savingMark = await dbPool.query(
      `UPDATE story_jobs SET progress = $2, progress_message = 'Saving story...', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'processing' RETURNING id`,
      [jobId, JOB_SAVING_PROGRESS]
    );
    if (savingMark.rowCount === 0) await checkCancellation();

    log.debug(`💾 [UNIFIED] Saving story to database... (generationLog has ${storyData.generationLog?.length || 0} entries)`);
    await upsertStory(storyId, userId, storyData, { adminDraft: inputData?.adminDraft === true });
    log.debug(`📚 [UNIFIED] Story ${storyId} saved to stories table`);

    // Post-persistence cover typography — the RELIABLE title/dedication baker.
    // The in-pipeline applyCoverTypography no-ops when the cover imageData was
    // already offloaded to R2 (null → its guard returns early), so bake onto the
    // SERVED cover rows here, after upsertStory has persisted them. Idempotent.
    if (MODEL_DEFAULTS.appSideCoverType) {
      try {
        const { bakeCoverTypographyPostPersist } = require('./server/lib/coverTypography');
        // A baked-title front cover carries its title in the pixels already —
        // stamping here would print a second one (the exact double-title bug of
        // Lab exps 957/958). The initial page and back cover have no baked text
        // and keep their app-side dedication / branding either way.
        const bakedCoverKeys = Object.entries(storyData.coverImages || {})
          .filter(([, c]) => c?.titleBaked === true)
          .map(([k]) => k);
        if (bakedCoverKeys.length) {
          log.info(`🅰️ [UNIFIED] Cover typography skipped for baked-title cover(s): ${bakedCoverKeys.join(', ')}`);
        }
        await bakeCoverTypographyPostPersist(storyId, storyData, {
          title: storyData.title || '',
          dedication: storyData.dedication || inputData.dedication || '',
          seed: jobId,
          trial: !!inputData.skipQualityEval,
          skipKeys: bakedCoverKeys,
          // The trial renders front and back only (docs/decisions.md, buildInitialPageComposition).
          notProducedKeys: inputData.trialMode ? ['initialPage'] : [],
        });
      } catch (e) {
        log.warn(`⚠️ [UNIFIED] Post-persist cover typography failed: ${e.message}`);
      }
    }

    // Phase 8: append per-character story-history log entries so the dev
    // UI can compare avatar consistency across stories. Best-effort; failure
    // doesn't block story completion.
    try {
      const sav = require('./server/lib/storyAvatars');
      const appended = await sav.appendStoryHistory(
        userId,
        inputData.characters || [],
        {
          storyId,
          artStyle: inputData.artStyle || 'pixar',
          language: inputData.language || 'en',
          title: storyData.title || null,
        },
        storyData.characterAvatars || {},
        storyData.visualBible?.costumes || {}
      );
      if (appended > 0) log.info(`📚 [STORY-AVATAR-HISTORY] appended ${appended} entries to character history`);
    } catch (histErr) {
      log.warn(`⚠️ [STORY-AVATAR-HISTORY] failed: ${histErr.message}`);
    }

    // Persist reference sheet source grids for the dev panel. Each batch
    // becomes a story_images row with image_type='ref_sheet_source' and
    // page_number=batchIdx. Element names are encoded into the quality_score
    // column as a JSON string... actually no — we use a separate metadata
    // mechanism. For now we just save the image with the batch index.
    if (referenceSheetSourceGrids && referenceSheetSourceGrids.length > 0) {
      try {
        for (const grid of referenceSheetSourceGrids) {
          await saveStoryImage(storyId, 'ref_sheet_source', grid.batchIdx, grid.imageData, {
            generatedAt: new Date().toISOString(),
          });
        }
        log.info(`💾 [UNIFIED] Saved ${referenceSheetSourceGrids.length} reference sheet source grid(s) for dev inspection`);
      } catch (refSheetSaveErr) {
        log.warn(`⚠️ [UNIFIED] Failed to persist reference sheet source grids: ${refSheetSaveErr.message}`);
      }
    }

    // Active versions are already set by recomputeAllActiveVersions() inside
    // upsertStory() (above) — the canonical pickBestVersionIndex/finalScore path,
    // the same one saveStoryData and the regen routes use.
    //
    // A manual override used to run HERE, AFTER upsertStory, and clobbered that
    // correct result: for scenes it fell back to the legacy `qualityScore` field
    // (which applyScore no longer writes → always null → picked the LAST version),
    // and for covers it unconditionally picked `imageVersions.length - 1` (the last
    // version, ignoring score). That left a lower-scoring version active on many
    // stories — e.g. a cover whose v3 scored 100 stuck showing v2 at 63. Removed;
    // upsertStory's recompute is the single source of truth.

    // Log credit completion (credits were already reserved at job creation)
    try {
      const jobResult = await dbPool.query(
        'SELECT credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const creditsUsed = jobResult.rows[0].credits_reserved;
        const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
        const currentBalance = userResult.rows[0]?.credits || 0;

        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, 0, currentBalance, 'story_complete', jobId, `Story completed - ${creditsUsed} credits used`]
        );
        log.info(`💳 [UNIFIED] Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ [UNIFIED] Failed to log credit completion:', creditErr.message);
    }

    // Fetch shareToken so the client can show "View Story" button immediately
    let shareToken = null;
    try {
      const stResult = await dbPool.query('SELECT share_token FROM stories WHERE id = $1', [storyId]);
      shareToken = stResult.rows[0]?.share_token || null;
    } catch { /* non-critical */ }

    // Build final result
    const resultData = {
      storyId,
      shareToken,
      title,
      outline: unifiedResponse, // writer + reviewer concatenation (matches data.outline)
      outlinePrompt: unifiedPrompt,
      outlineModelId: unifiedModelId,
      outlineUsage: unifiedUsage,
      outlineReview: outlineReviewMeta,
      storyTextPrompts, // beats: the page-text writer's prompt + raw reply (incl. its ANALYSIS block); [] on the streaming path
      story: fullStoryText,  // Frontend expects 'story' not 'storyText'
      visualBible,
      styledAvatarGeneration: getStyledAvatarGenerationLog(),
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(),
      sceneDescriptions: allSceneDescriptions,
      // The Art Director prompt table sceneDescriptions[].scenePromptRef
      // indexes into. One ~112 KB copy, not one per page.
      sceneExpansionReport,
      sceneImages: allImages,
      coverImages,
      tokenUsage,
      estimatedCost: totalCost,
      generationMode: 'unified',
      generationLog: genLog.getEntries(),
      finalChecksReport: finalChecksReport || null
    };

    // Mark job as completed.
    //
    // WHAT story_jobs.result_data IS FOR (2026-09-21).
    //
    // It is the payload of the job-status poll and nothing else. `stories.data`
    // is the story; this column is a PROJECTION of it, built from an explicit
    // allow-list so a new field on `resultData` cannot silently re-inflate it.
    //
    // The gate for "does anyone read it" is `storyService.getJobStatus()`'s
    // explicit field mapping — a field it does not copy is `undefined` in the
    // UI however faithfully we store it. Every name below has either a reader
    // in that mapping or a server-side reader:
    //   storyId / shareToken               StoryWizard nav, GenerationContext
    //   title, outline, outlinePrompt,     StoryWizard completion branch
    //   outlineModelId, outlineUsage,
    //   story, storyTextPrompts,
    //   visualBible, generationLog,
    //   styledAvatarGeneration,
    //   costumedAvatarGeneration,
    //   sceneExpansionReport
    //   estimatedCost                      server/lib/storyMetrics.js queries
    //                                      result_data->>'estimatedCost'
    //
    // DELIBERATELY NOT STORED (measured on job_1789853503332_riqncqg1i, the
    // four together were 7.74 MB of the 7.83 MB raw column):
    //   sceneImages (5.21 MB), sceneDescriptions (2.09 MB), coverImages
    //   (0.26 MB) — GET /api/stories/:id/metadata already builds all three
    //   from `stories.data` + `story_images`, including per-version dev
    //   metadata, and the wizard's completion branch loads them from there.
    //   Mid-generation page data comes from the `partial_page` /
    //   `partial_cover` / `story_text` checkpoints this same endpoint returns,
    //   never from a second copy of the book.
    //   finalChecksReport (0.18 MB) — no reader at all: getJobStatus() never
    //   copied it, so StoryWizard's `status.result.finalChecksReport` was
    //   always undefined. Its live value comes from the dev-metadata route.
    //   outlineReview / tokenUsage — same, live values via getStoryMetadata().
    //   generationMode — never forwarded.
    const RESULT_DATA_FIELDS = [
      'storyId', 'shareToken', 'title',
      'outline', 'outlinePrompt', 'outlineModelId', 'outlineUsage',
      'story', 'storyTextPrompts',
      'visualBible', 'styledAvatarGeneration', 'costumedAvatarGeneration',
      'generationLog', 'sceneExpansionReport',
      'estimatedCost',
    ];
    // Strip photo data from visualBible locations
    const strippedVisualBible = resultData.visualBible ? {
      ...resultData.visualBible,
      locations: (resultData.visualBible.locations || []).map(loc => {
        const { referencePhotoData, ...locMeta } = loc;
        return { ...locMeta, hasPhoto: !!referencePhotoData };
      })
    } : resultData.visualBible;
    const resultDataForStorage = {};
    for (const key of RESULT_DATA_FIELDS) {
      if (resultData[key] !== undefined) resultDataForStorage[key] = resultData[key];
    }
    if (resultDataForStorage.visualBible) resultDataForStorage.visualBible = strippedVisualBible;
    log.debug(`📊 [UNIFIED] resultData generationLog has ${resultData.generationLog?.length || 0} entries`);
    // Belt-and-suspenders: the allow-list above keeps whole objects, and some of
    // them can still carry inline base64 (visualBible location photos,
    // generationLog entries, avatar-generation records). No image bytes belong
    // in the database at all — R2 is the only byte store — and a repair-heavy
    // story used to overflow PG's 256MB jsonb array cap on the UPDATE below, so
    // drop ANY remaining inline base64 outright.
    const dropInlineBase64 = (node, seen = new WeakSet()) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      const isBytes = (s) => typeof s === 'string' && s.length > 1024
        && (s.startsWith('data:image/') || s.startsWith('/9j/') || s.startsWith('iVBORw0')
            || s.startsWith('R0lGOD') || s.startsWith('UklGR'));
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (isBytes(node[i])) node[i] = undefined; else dropInlineBase64(node[i], seen);
        }
        return;
      }
      for (const k of Object.keys(node)) {
        // landmarkPhotos: drop the bytes like everything else (no images in
        // the DB — R2 is the only byte store), but set hasPhoto so the client
        // lazy-loads them via getDevImage(...,'landmark'), which serves the
        // R2-backed copies from stories.data (ReferencePhotosDisplay:111).
        if (k === 'landmarkPhotos' && Array.isArray(node[k])) {
          for (const lp of node[k]) {
            if (lp && typeof lp === 'object' && isBytes(lp.photoData)) {
              lp.hasPhoto = true;
              lp.photoData = undefined;
            }
          }
          continue;
        }
        if (isBytes(node[k])) node[k] = undefined; else dropInlineBase64(node[k], seen);
      }
    };
    dropInlineBase64(resultDataForStorage);
    const resultJson = JSON.stringify(resultDataForStorage);
    log.debug(`📊 [UNIFIED] result_data size: ${(resultJson.length / 1024).toFixed(1)}KB (images stripped)`);
    // Guard the completion write with `status = 'processing'`: if the stale-job
    // watchdog or a cancel already flipped this job to 'failed'/'cancelled' (and
    // refunded credits_reserved), an unconditional UPDATE would resurrect it to
    // 'completed' — handing the user a refund AND a finished story. If no row
    // matches, the job was terminated out from under us; leave it as-is.
    const completionRes = await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           credits_reserved = 0, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND status = 'processing'
       RETURNING id`,
      ['completed', 100, 'Story generation complete!', resultJson, jobId]
    );
    if (completionRes.rowCount === 0) {
      log.warn(`⚠️ [UNIFIED] Job ${jobId} was no longer 'processing' at completion (cancelled/failed by watchdog?) — not marking completed. Story is saved; job status left unchanged.`);
    } else {
      // Story stats scorecard (docs/plans/story-stats-page.md) — fire-and-forget,
      // a metrics failure must never touch the completed story. This is the ONLY
      // path that marks a story-producing job 'completed'; the text-only early
      // return (~line 5219) also sets status='completed' but never saves a
      // stories row, so there is nothing for the collector to read there.
      // Trial + main + admin-rerun jobs all funnel through processUnifiedStoryJob
      // into this write.
      setImmediate(() => {
        try {
          const { collectStoryMetrics } = require('./server/lib/storyMetrics');
          collectStoryMetrics(storyId, { pool: dbPool }).catch(err =>
            log.warn(`⚠️ [METRICS] collection failed for ${storyId}: ${err.message}`));
        } catch (err) {
          log.warn(`⚠️ [METRICS] collector unavailable: ${err.message}`);
        }
      });
      // Verification registry auto-check (staging only, runtime verifyAutoCheck):
      // judges this story against tasks/verify.json and stores the verdicts in
      // story_verify_reports. Same fire-and-forget contract as the metrics above —
      // runVerifyAutoCheck never throws and logs its own failure.
      setImmediate(() => {
        try {
          require('./server/lib/verifyAutoCheck').runVerifyAutoCheck(storyId, { pool: dbPool });
        } catch (err) {
          log.error(`❌ [VERIFY] auto-check unavailable for ${storyId}: ${err.message}`);
        }
      });
    }

    // Clean up checkpoints ONLY when this run really flipped the job to
    // completed. A job cancelled/failed out from under us keeps them: they are
    // the forensic record, and deleting them here is exactly how a killed
    // run's evidence vanished on 2026-08-23 (the salvage-then-keep policy in
    // cleanupOldCompletedJobs owns their lifecycle from that point).
    if (completionRes.rowCount > 0) {
      await deleteJobCheckpoints(jobId);
    }

    // Clear styled avatar cache to free memory
    clearStyledAvatarCache();

    // Score-model mix telemetry: which fraction of versions ended up scored
    // by the consolidator prompt vs the math fallback? Makes the 60-threshold
    // tunable from logs alone instead of needing to query the DB.
    try {
      const { logScoreModelSummary } = require('./server/lib/scoring');
      const sceneVersions = (storyData?.sceneImages || []).flatMap(p => Array.isArray(p?.imageVersions) ? p.imageVersions : []);
      const coverVersions = ['frontCover', 'initialPage', 'backCover'].flatMap(k => {
        const c = storyData?.coverImages?.[k];
        return Array.isArray(c?.imageVersions) ? c.imageVersions : [];
      });
      logScoreModelSummary(jobId, [...sceneVersions, ...coverVersions]);
    } catch (err) {
      log.debug(`[SCORE-SUMMARY] skipped: ${err.message}`);
    }

    // Bbox cache hit-rate telemetry — high hit rate means the eval and
    // entity-consistency passes are reusing the same detection rather than
    // re-paying Gemini for each.
    try {
      const { getBboxCacheStats } = require('./server/lib/images');
      const s = getBboxCacheStats();
      const total = s.hits + s.misses;
      const hitPct = total > 0 ? Math.round((s.hits / total) * 100) : 0;
      log.info(`[BBOX-CACHE] story ${jobId}: ${s.hits} hits / ${s.misses} misses (${hitPct}%), size=${s.size}`);
    } catch (err) {
      log.debug(`[BBOX-CACHE-STATS] skipped: ${err.message}`);
    }

    log.info(`✅ [UNIFIED] Job ${jobId} completed successfully`);

    // Send story completion email to customer — ONLY when this run actually
    // flipped the job to 'completed'. If the guarded UPDATE above matched no
    // row the job was cancelled/failed out from under us, and mailing the
    // user "your story is ready" for a story that was never marked done is
    // wrong twice over. Admin reruns (rerun-full) never email: the recipient
    // would be the SOURCE story's owner — a real customer.
    try {
      if (completionRes.rowCount === 0) {
        log.info(`[UNIFIED] Job ${jobId} not marked completed — skipping story-complete email`);
        return resultData;
      }
      if (inputData.adminRerun) {
        log.info(`[UNIFIED] adminRerun job ${jobId} — skipping story-complete email`);
        return resultData;
      }
      const userResult = await dbPool.query(
        'SELECT email, username, shipping_first_name, preferred_language, is_trial, has_set_password, claim_token, (trial_data IS NOT NULL) AS has_trial_data FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];

        // Trial users start with a placeholder email (anon_<uuid>@anonymous) that
        // Resend rejects with a validation_error. Skip the send AND the PDF
        // generation — pointless work that ends in a failed email. The PDF will
        // be generated and sent when the user provides a real email (claim flow
        // hooks: trial/link-google for instant verification, verify-email for
        // typed-in email after clicking the verification link).
        if (/^anon_.+@anonymous$/i.test(user.email)) {
          log.info(`[UNIFIED] Deferring story-complete email for anonymous trial user ${userId} — will send on account claim`);
          return resultData;
        }

        const firstName = email.resolveGreetingName(user);
        // Prefer story language over DB default (DB defaults to 'English' for trial users)
        const emailLanguage = inputData.language || user.preferred_language || 'English';

        const emailOptions = {};
        if (shareToken) emailOptions.shareToken = shareToken;

        // Generate + attach the PDF when the story came from the trial flow,
        // even if the user has since converted to a full account (e.g. linked
        // Google or set a password mid-generation). is_trial flips to false on
        // conversion; trial_data stays populated, so it's the durable signal.
        // Without this OR, anyone who linked Google between job creation and
        // completion gets the regular story-complete email with no PDF
        // (observed for amandatavaresfo2@gmail.com on 2026-05-23).
        if (user.is_trial || user.has_trial_data) {
          try {
            // The claim link is gated on claim STATE, not on trial ORIGIN. All
            // four conversion routes (auth.js set-password, trial.js link-google,
            // claim/set-password, claim/link-google) clear is_trial, so
            // `is_trial AND NOT has_set_password` is the unclaimed account.
            // `password IS NOT NULL` is NOT a conversion signal — trial accounts
            // are created with a random placeholder password (trial.js).
            // The PDF stays gated on trial ORIGIN above: a user who converted
            // mid-generation still wants their trial PDF, just not a "claim your
            // account" link to an account they already own.
            if (user.is_trial === true && user.has_set_password !== true) {
              let claimToken = user.claim_token;
              if (!claimToken) {
                claimToken = crypto.randomBytes(32).toString('hex');
                const claimExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
                await dbPool.query(
                  'UPDATE users SET claim_token = $1, claim_token_expires = $2 WHERE id = $3',
                  [claimToken, claimExpires, userId]
                );
              }
              emailOptions.claimUrl = `${process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch'}/claim/${claimToken}`;
            }

            // Generate a view PDF to attach to the email
            // Fetch the full story data with images (rehydrate from story_images table)
            const pdfStoryResult = await dbPool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
            if (pdfStoryResult.rows.length > 0) {
              let pdfStoryData = typeof pdfStoryResult.rows[0].data === 'string'
                ? JSON.parse(pdfStoryResult.rows[0].data)
                : pdfStoryResult.rows[0].data;
              pdfStoryData = await rehydrateStoryImages(storyId, pdfStoryData);

              const pdfBuffer = await generateViewPdf(pdfStoryData, 'A4', { trialLayout: true });
              const pdfSizeMB = pdfBuffer.length / 1024 / 1024;
              log.info(`[UNIFIED] Generated trial PDF for email (${pdfSizeMB.toFixed(2)} MB)`);
              if (pdfSizeMB > 35) {
                log.warn(`[UNIFIED] Trial PDF too large for email (${pdfSizeMB.toFixed(2)} MB > 35MB) - sending without attachment`);
              } else {
                emailOptions.pdfBuffer = pdfBuffer;
                emailOptions.pdfFilename = `${title || 'story'}.pdf`;
              }
            }
          } catch (pdfErr) {
            log.error('[UNIFIED] Failed to generate trial PDF for email (sending without attachment):', pdfErr.message);
            // Continue sending email without PDF - better to send without attachment than not at all
          }
        }

        await email.sendStoryCompleteEmail(user.email, firstName, title, storyId, emailLanguage, emailOptions);
      }
    } catch (emailErr) {
      log.error('❌ [UNIFIED] Failed to send story complete email:', emailErr);
    }

    return resultData;

  } catch (error) {
    // If the job was cancelled by the user, don't treat it as a pipeline error
    if (error.name === 'JobCancelledError') {
      log.info(`🛑 [UNIFIED] Pipeline aborted for cancelled job ${jobId}`);
      // Credits already refunded by the cancel endpoint — just stop
      return null;
    }

    log.error(`❌ [UNIFIED] Error generating story:`, error.message);
    genLog.error('pipeline_error', error.message, null, { stage: genLog.currentStage, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });

    // Fail the job AND refund its reservation in ONE transaction (settleJobWithRefund):
    // claim, user credit and ledger row commit together. The guard (never overwrite
    // 'cancelled') is in the same UPDATE: an error that surfaces after a user cancel
    // must not turn 'cancelled' into 'failed' (review A3); the cancel already refunded.
    // The outer _processStoryJobImpl catch settles again — idempotent (reservation is 0).
    try {
      const settled = await settleJobWithRefund(dbPool, jobId, {
        status: 'failed',
        errorMessage: error.message,
        statusNotIn: ['cancelled'],
        describe: ({ refunded }) => `Full refund: ${refunded} credits - story generation failed`,
      });
      if (settled.refunded > 0) log.info(`💳 [UNIFIED] Refunded ${settled.refunded} credits for failed job ${jobId}`);
    } catch (refundErr) {
      log.error('❌ [UNIFIED] Failed to fail/refund job:', refundErr.message);
    }

    throw error;
  }
}

// Background worker function to process a story generation job
// NEW STREAMING ARCHITECTURE: Generate images as story batches complete
async function processStoryJob(jobId, opts = {}) {
  // Run entire job inside a cache scope so styled avatars + per-story dev
  // logs don't collide across concurrent jobs.
  // Trial mode uses `trial-${userId}` to match the scope `/api/trial/prepare-title`
  // pre-warms under — that way the trial job reuses the pre-warmed avatar
  // cache AND inherits the prepare-title styled-avatar log entries for the
  // dev panel. Full mode uses jobId (always unique).
  let scopeId = jobId;
  try {
    const preRow = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
    const row = preRow.rows[0];
    const inputData = row?.input_data
      ? (typeof row.input_data === 'string' ? JSON.parse(row.input_data) : row.input_data)
      : null;
    if (inputData?.trialMode && row?.user_id) {
      scopeId = `trial-${row.user_id}`;
    }
  } catch (e) {
    log.warn(`[processStoryJob] Could not pre-load input_data for scope decision: ${e.message} — falling back to jobId scope`);
  }
  return runInCacheScope(scopeId, async () => {
    // Analyzer session brackets the WHOLE job — the analyzer kills its model
    // workers when the count hits zero, which is its only memory management.
    // Begin/end are fire-and-forget; this finally runs on completion, failure
    // and cancellation alike, so a story can never leak a session.
    require('./server/lib/analyzerClient').sessionBegin(`story:${jobId}`);
    // WHOLE-JOB liveness heartbeat — armed here, the ONE entry point every
    // caller uses (jobs, trial, admin rerun, auth), so every phase of every
    // pipeline (unified, beats, trial) is inside it. Phase-local intervals
    // were the old shape and they left a blind window after every phase that
    // grew a new one; see server/lib/jobHeartbeat.js and docs/decisions.md
    // "Job liveness heartbeat spans the whole job". Cleared in the same
    // outermost finally as the analyzer session, so completion, failure,
    // cancellation and early return all disarm it exactly once.
    const jobHeartbeat = startJobHeartbeat(jobId, dbPool);
    try {
      return await _processStoryJobImpl(jobId, opts);
    } finally {
      jobHeartbeat.stop();
      require('./server/lib/analyzerClient').sessionEnd(`story:${jobId}`);
      // Free the per-scope avatar log buckets. The buckets were captured into
      // saved story data already; the dev panel reads from the DB, not from
      // these in-memory buckets. Both clears are scope-aware (only touch this
      // job's bucket, never another user's).
      try { clearStyledAvatarGenerationLog(); } catch (e) { log.warn(`[processStoryJob] styled-log cleanup failed: ${e.message}`); }
      try { clearCostumedAvatarGenerationLog(); } catch (e) { log.warn(`[processStoryJob] costumed-log cleanup failed: ${e.message}`); }
      try { clearCurrentLogger(); } catch (e) { log.warn(`[processStoryJob] generation-logger cleanup failed: ${e.message}`); }
    }
  });
}

async function _processStoryJobImpl(jobId, opts = {}) {
  log.info(`🎬 Starting processing for job ${jobId}`);

  // Cancellation check — query DB status before each major phase
  // Throws a special error that the outer catch can distinguish from real failures
  class JobCancelledError extends Error {
    constructor(jobId) { super(`Job ${jobId} was cancelled`); this.name = 'JobCancelledError'; }
  }
  async function checkCancellation() {
    const result = await dbPool.query('SELECT status FROM story_jobs WHERE id = $1', [jobId]);
    // Only fire on the explicit 'cancelled' status set by the user-driven
    // cancel endpoint. Previously this matched 'failed' too, which meant
    // any transient pipeline error in one branch would trip every other
    // in-flight pLimit slot via JobCancelledError and shadow the real
    // error in logs / refunds. Also treat the job-row-missing case as
    // cancelled (the row was deleted out from under us).
    if (result.rows.length === 0 || result.rows[0].status === 'cancelled') {
      log.info(`🛑 [PIPELINE] Job ${jobId} cancelled — aborting pipeline`);
      throw new JobCancelledError(jobId);
    }
  }

  // Generation logger for tracking API usage and debugging
  const genLog = new GenerationLogger();
  genLog.setStage('outline');

  // Avatar generation logs are per-cache-scope (see processStoryJob wrapper).
  // No clear-at-start needed — the wrapper's finally block clears once after
  // capture so a single bucket lives for the full job lifecycle.

  try {
    // Get job data
    const jobResult = await dbPool.query(
      'SELECT * FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      throw new Error('Job not found');
    }

    const job = jobResult.rows[0];
    const inputData = job.input_data;

    // Stamp the layout from languageLevel onto inputData so image generation,
    // scene expansion, and PDF rendering all read from the same source of
    // truth. Every reading level → square image + text-below strip since
    // 2026-09-05; A4 + overlay only on an explicit layoutOverride. Without
    // this, buildImagePrompt falls through to its default (textInImage=true)
    // regardless of level.
    try {
      const { resolveLayout } = require('./server/lib/layout');
      // The override must be passed: now that no level resolves to a4-overlay,
      // dropping it here would make the overlay layout unreachable on this path.
      inputData.layout = resolveLayout(inputData.languageLevel, inputData.layoutOverride);
      log.info(`📐 [PROCESS] Layout for level=${inputData.languageLevel}: mode=${inputData.layout.mode}, aspect=${inputData.layout.imageAspect}, textInImage=${inputData.layout.textInImage}`);
    } catch (e) {
      log.warn(`📐 [PROCESS] resolveLayout failed: ${e.message} — layout not stamped`);
    }

    // Stamp the resolved SEASON the same way, and for the same reason: every
    // consumer wrote `inputData.season ? ... : null`, so a launcher that sent
    // `season: ""` (an admin rerun copies the source job's input_data verbatim)
    // silently dropped the Season line from the story brief, left the Visual
    // Bible, every scene brief and every image prompt with nothing to say, and
    // showed "Jahreszeit: Nicht angegeben" in the UI. Resolving it ONCE here
    // means the writer, the bible, the Art Director, the image prompt AND the
    // stored story row (which reads inputData.season) all agree. Derived from
    // the job's own created_at, not from "now", so a repair run months later
    // resolves the season the pages were drawn in.
    try {
      const { resolveSeason } = require('./server/lib/season');
      const resolved = resolveSeason(inputData, { now: job.created_at });
      if (inputData.season !== resolved) {
        log.info(`🍁 [PROCESS] Season "${inputData.season || '(none)'}" → "${resolved}" (derived from job date)`);
      }
      inputData.season = resolved;
    } catch (e) {
      log.warn(`🍁 [PROCESS] resolveSeason failed: ${e.message} — season not stamped`);
    }

    // Debug: Log inputData values when job starts processing
    log.debug(`📝 [JOB PROCESS] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"`);
    log.debug(`📝 [JOB PROCESS] mainCharacters: ${JSON.stringify(inputData.mainCharacters)}, characters count: ${inputData.characters?.length || 0}`);

    // Fetch full character data from database (job stores stripped metadata)
    // This ensures processing has access to photos and avatar images
    // The job row carries STRIPPED characters — thumbnails and metadata, no face
    // photo, no body cutout, no avatar. Those bytes live on the characters row
    // and must be loaded here or every character in the book is drawn from its
    // text description alone.
    //
    // This is a HARD FAIL on any unresolved id (owner, 2026-08-10). It used to
    // skip quietly: `job_1786309527338_4zwhrn08y` was submitted under the smoke
    // account while the client still held ANOTHER account's character ids, none
    // of them resolved, and the story completed at 100% with five strangers in
    // it. A book with the wrong faces is worse than no book, and the only
    // symptom was an avatar warning pointing at the wrong subsystem.
    const requestedCharacterIds = (inputData.characters || []).map(c => c.id);
    if (requestedCharacterIds.length > 0 && job.user_id) {
      const characterRowId = `characters_${job.user_id}`;
      let allChars = null;
      try {
        const charResult = await dbPool.query(
          'SELECT data FROM characters WHERE id = $1',
          [characterRowId]
        );
        if (charResult.rows.length > 0 && charResult.rows[0].data) {
          const fullCharData = typeof charResult.rows[0].data === 'string'
            ? JSON.parse(charResult.rows[0].data)
            : charResult.rows[0].data;
          allChars = Array.isArray(fullCharData) ? fullCharData : (fullCharData.characters || []);
        }
      } catch (dbErr) {
        throw new Error(`[PROCESS] Could not read ${characterRowId}: ${dbErr.message} — refusing to generate a story whose characters have no reference photos`);
      }
      if (!allChars) {
        throw new Error(`[PROCESS] No characters row ${characterRowId} for this user, but the job requests ${requestedCharacterIds.length} character(s) — refusing to generate a story whose characters have no reference photos`);
      }

      // Compare ids as strings: a JSON round-trip can turn a numeric id into a
      // string, and that is type drift, not a different character. Failing the
      // job over it would be a false alarm.
      const byId = new Map(allChars.map(c => [String(c.id), c]));
      const missing = requestedCharacterIds.filter(id => !byId.has(String(id)));
      if (missing.length > 0) {
        // Name where they DID come from. The one real occurrence of this was a
        // cross-account reference, and without this line the error reads as
        // "characters vanished" instead of "wrong account".
        let owner = '';
        try {
          const found = await dbPool.query(
            `SELECT user_id FROM characters WHERE data::text LIKE $1 LIMIT 1`,
            [`%${String(missing[0])}%`]
          );
          if (found.rows.length > 0 && found.rows[0].user_id !== job.user_id) {
            owner = ` Character ${missing[0]} belongs to user ${found.rows[0].user_id}, not to this job's user ${job.user_id} — the request was made with another account's characters.`;
          }
        } catch { /* diagnostic only — never mask the real error */ }
        throw new Error(`[PROCESS] ${missing.length}/${requestedCharacterIds.length} requested character(s) are not in ${characterRowId}: ${missing.join(', ')}.${owner} Refusing to generate a story whose characters have no reference photos.`);
      }

      const fullCharacters = requestedCharacterIds.map(id => byId.get(String(id)));
      log.debug(`📸 [PROCESS] Loaded full character data for ${fullCharacters.length} characters`);
      // Clear styledAvatars - regenerate fresh per story for consistency
      for (const char of fullCharacters) {
        if (char.avatars) {
          char.avatars.styledAvatars = {};
        }
      }
      inputData.characters = fullCharacters;
    }

    // For swiss-stories, ALWAYS use the story's city for landmarks (not user's home city)
    // Swiss stories (including Sagen) are city-bound — landmarks must match the story location
    if (inputData.storyCategory === 'swiss-stories' && inputData.storyTopic) {
      let storyCity = null;

      // City-based stories: derive city from topic ID (e.g., "basel-3" → "Basel")
      if (!inputData.storyTopic.startsWith('sage-')) {
        const { getSwissCityById } = require('./server/lib/swissStories');
        const cityId = inputData.storyTopic.replace(/-\d+$/, '');
        const cityMeta = getSwissCityById(cityId);
        if (cityMeta) storyCity = cityMeta.name.en;
      } else {
        // Sagen: look up city from swiss-sagen.json
        try {
          const sagen = require('./server/data/swiss-sagen.json');
          const sage = sagen.find(s => s.id === inputData.storyTopic);
          if (sage?.city) storyCity = sage.city;
        } catch (e) { /* ignore */ }
      }

      if (storyCity) {
        if (inputData.userLocation?.city && inputData.userLocation.city.toLowerCase() !== storyCity.toLowerCase()) {
          log.info(`[SWISS] Overriding userLocation from ${inputData.userLocation.city} to ${storyCity} (story is set in ${storyCity})`);
        }
        inputData.userLocation = { city: storyCity, country: 'Switzerland' };
        log.debug(`[SWISS] Using story city ${storyCity} for landmark discovery (storyTopic: ${inputData.storyTopic})`);
      }
    }

    // Owner ruling (2026-08-31): a location the premise names is binding.
    // Stamp whether the premise names its own world BEFORE any prompt is
    // built — buildSettingLine in promptBuilders.js relabels the commission's
    // home-city line off this flag. After the swiss-stories override so the
    // comparison uses the final userLocation.
    const { stampPremiseWorld } = require('./server/lib/premiseWorld');
    await stampPremiseWorld(inputData);

    // Inject pre-discovered landmarks if available for this user's location.
    // Shared resolver: landmark_index (proximity fallback) -> shared in-memory
    // cache. No live discovery at job start (would block 15s). Shuffled: that
    // is the order a story on the Jev backup keeps; with Jev live the list is
    // re-ordered by its fit to the commissioned idea before any writer reads
    // it (jevSelection.selectStoryLandmarks — beats: generateStoryViaBeats;
    // trial: before the writer call in processUnifiedStoryJob).
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    if (inputData.userLocation?.city && inputData.storyCategory !== 'historical') {
      const { resolveAvailableLandmarks } = require('./server/lib/landmarkPhotos');
      const landmarks = await resolveAvailableLandmarks(inputData.userLocation, {
        // 20, the same number the ideas route offers (owner, 2026-09-19). The
        // pipeline asked for 30 and the arc prompt then carried 15.5k chars of
        // landmark listing — 41% of everything the arc creator read, most of it
        // guild houses and archives no children's story reaches for.
        // The trial idea route resolves the same list (jevSelection
        // .resolveTrialIdeaLandmarks), so an idea only names places the story has.
        limit: require('./server/lib/jevSelection').STORY_LANDMARK_LIMIT, discoverOnMiss: false, language: inputData.language, shuffle: true, jobId,
        // A landmark the family names in their idea is pinned first (after the
        // shuffle), so the writer's top-3 opens on it.
        premiseText: [inputData.storyDetails, inputData.title].filter(Boolean).join('\n'),
      });
      if (landmarks.length > 0) {
        inputData.availableLandmarks = landmarks;
      } else {
        log.debug(`[LANDMARK] No cached landmarks available for ${inputData.userLocation.city}`);
      }
    } else if (inputData.storyCategory === 'historical') {
      log.debug(`[LANDMARK] Skipping local landmarks for historical story (uses historical locations instead)`);
    }

    // Check if user is admin (developer-mode fields below are admin-only)
    const userResult = await dbPool.query('SELECT role FROM users WHERE id = $1', [job.user_id]);
    const isAdmin = userResult.rows.length > 0 && userResult.rows[0].role === 'admin';

    // SECURITY: developer-mode fields (model overrides, skip flags, layout
    // override) are honored for admins only. The client gate is cosmetic and
    // req.body was spread verbatim into input_data, so strip these for
    // non-admins here — before any reader (this function OR the pipeline's
    // resolveLayout) can pick them up — so a normal user can't pick expensive
    // models or silently degrade their own paid story.
    // `serverAuthoredInput` (set only by a server route that builds the whole
    // commission itself, and forced to false on the user-facing create-story
    // path after the req.body spread) means there is no client-supplied field
    // here to strip. Without this exemption the trial route's deliberate
    // `enableFullRepair: false` was deleted — trial users are not admins — and
    // every trial ran and recorded the default ON (2026-09-13).
    if (!isAdmin && inputData.serverAuthoredInput !== true) {
      delete inputData.modelOverrides;
      delete inputData.skipImages;
      delete inputData.skipCovers;
      delete inputData.layoutOverride;
      delete inputData.enableFullRepair; // fall back to default (ON)
      delete inputData.maxRepairPasses;   // fall back to REPAIR_DEFAULTS.maxPasses
      delete inputData.pipelineMode;      // fall back to PIPELINE_MODE env / 'unified'
    }

    const skipImages = inputData.skipImages === true; // Developer mode: text only
    const skipCovers = inputData.skipCovers === true; // Developer mode: skip cover generation
    const enableFullRepair = inputData.enableFullRepair !== false; // Full repair after generation (default: ON)

    log.info(`🔧 [PIPELINE] Settings: enableFullRepair=${enableFullRepair}, skipImages=${skipImages}, skipCovers=${skipCovers}, pipelineMode=${resolvePipelineMode(inputData)}${inputData.maxRepairPasses != null ? `, maxRepairPasses=${inputData.maxRepairPasses}` : ''}`);

    // Developer mode: model overrides (admin only — non-admin overrides were
    // stripped above). Use centralized MODEL_DEFAULTS from textModels.js.
    // Filter out null/undefined user overrides so they don't overwrite defaults
    const userOverrides = inputData.modelOverrides || {};
    const filteredUserOverrides = Object.fromEntries(
      Object.entries(userOverrides).filter(([_, v]) => v != null)
    );
    const modelOverrides = {
      outlineModel: MODEL_DEFAULTS.outline,
      textModel: MODEL_DEFAULTS.storyText,
      sceneDescriptionModel: MODEL_DEFAULTS.sceneDescription,
      sceneIterationModel: MODEL_DEFAULTS.sceneIteration,
      // The PAGE RENDER tier, not the edit/inpaint tier: this value is what the
      // repair loop hands to generateImageOnly / iteratePage when it redoes a
      // page, so a page must not change model mid-repair. Dev-mode user
      // overrides still win (filteredUserOverrides is spread last).
      imageModel: MODEL_DEFAULTS.pageRenderImage,
      coverImageModel: MODEL_DEFAULTS.coverImage,
      qualityModel: MODEL_DEFAULTS.qualityEval,
      bboxModel: MODEL_DEFAULTS.bboxDetection,
      imageBackend: MODEL_DEFAULTS.imageBackend,
      storyAvatarModel: null,  // null = use default (gemini-2.5-flash-image)
      sceneRouting: null,      // 'auto', 'grok', 'gemini', or null (= 'auto')
      generateEmptyScenes: MODEL_DEFAULTS.generateEmptyScenes ?? true,
      ...filteredUserOverrides  // Only non-null user overrides
    };
    // Trial mode: use Sonnet for story generation (best narrative quality)
    if (inputData.trialMode) {
      modelOverrides.outlineModel = 'claude-sonnet';
      log.info(`⚡ [TRIAL] Using Claude Sonnet for story generation (best quality)`);
    }
    // Always log model defaults being used
    log.debug(`🔧 [PIPELINE] Models: outline=${modelOverrides.outlineModel}, text=${modelOverrides.textModel}, scene=${modelOverrides.sceneDescriptionModel}, sceneIter=${modelOverrides.sceneIterationModel}, quality=${modelOverrides.qualityModel}`);
    if (Object.keys(filteredUserOverrides).length > 0) {
      log.debug(`🔧 [PIPELINE] User overrides applied: ${JSON.stringify(filteredUserOverrides)}`);
    }

    // Unified mode is the only generation pipeline. pictureBook / outlineAndText
    // were removed along with legacyPipelines.js — single prompt + Art Director
    // scene expansion is the canonical flow. Ignore any client-side
    // generationMode field; it's a no-op now.
    const generationMode = 'unified';

    // Get language for scene descriptions (use centralized config)
    const lang = inputData.language || 'en';
    const { getLanguageNameEnglish } = require('./server/lib/languages');
    const langText = getLanguageNameEnglish(lang);

    // Picture-book layout for all reading levels: 1 page = 1 scene
    const printPages = inputData.pages;  // Total pages when printed
    const sceneCount = printPages;
    log.debug(`📚 [PIPELINE] Print pages: ${printPages}, Mode: ${generationMode}, Scenes to generate: ${sceneCount}`);

    if (skipImages) {
      log.debug(`📝 [PIPELINE] Text-only mode enabled - skipping image generation`);
    }
    if (skipCovers) {
      log.debug(`📝 [PIPELINE] Skip covers enabled - skipping cover image generation`);
    }

    // Determine image generation mode: sequential (consistent) or parallel (fast)
    // Sequential passes previous image to next for better character consistency
    const imageGenMode = inputData.imageGenMode || IMAGE_GEN_MODE || 'parallel';
    log.debug(`🖼️  [PIPELINE] Image generation mode: ${imageGenMode.toUpperCase()}`);

    // Extract character photos for reference images (with names for labeling)
    // Use getCharacterPhotoDetails for labeled references
    const characterPhotos = getCharacterPhotoDetails(inputData.characters || []);
    log.debug(`📸 [PIPELINE] Found ${characterPhotos.length} labeled character photos for reference`);

    // Update status to processing
    await dbPool.query(
      'UPDATE story_jobs SET status = $1, progress = $2, progress_message = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      ['processing', 5, 'Starting story generation...', jobId]
    );

    log.debug(`📚 [PIPELINE] Unified mode - single prompt + Art Director scene expansion`);
    return await processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableFullRepair, checkCancellation, opts.titleAvatarsReady || null, opts.standardAvatarsReady || null);

  } catch (error) {
    // Clear styled avatar cache on error too
    clearStyledAvatarCache();

    log.error(`❌ Job ${jobId} failed:`, error);

    // Full refund if story is not 100% complete, and the failed status, in ONE
    // transaction (settleJobWithRefund). 'cancelled' is never overwritten (review A3).
    let failureSettled = null;
    try {
      failureSettled = await settleJobWithRefund(dbPool, jobId, {
        status: 'failed',
        errorMessage: error.message,
        statusNotIn: ['cancelled'],
        refundIfProgressBelow: 100,
        describe: ({ refunded, progress }) => `Full refund: ${refunded} credits - story generation failed at ${progress}%`,
      });
      if (failureSettled.refunded > 0) log.info(`💳 Refunded ${failureSettled.refunded} credits for failed job ${jobId} (failed at ${failureSettled.progress}%)`);
    } catch (refundErr) {
      log.error('❌ Failed to fail/refund job:', refundErr.message);
    }
    if (failureSettled && !failureSettled.changed) {
      log.info(`🛑 Job ${jobId} was cancelled by the user before this error surfaced — no failure notification sent`);
      return;
    }

    // Log all partial data for debugging
    try {
      log.debug('\n' + '='.repeat(80));
      log.error('📋 [DEBUG] PARTIAL DATA DUMP FOR FAILED JOB:', jobId);
      log.debug('='.repeat(80));

      // Get job input data
      const jobDataResult = await dbPool.query('SELECT input_data FROM story_jobs WHERE id = $1', [jobId]);
      if (jobDataResult.rows.length > 0) {
        const inputData = jobDataResult.rows[0].input_data;
        log.debug('\n📥 [INPUT DATA]:');
        log.debug('  Story Type:', inputData?.storyType);
        log.debug('  Story Type Name:', inputData?.storyTypeName);
        log.debug('  Art Style:', inputData?.artStyle);
        log.debug('  Language:', inputData?.language);
        log.debug('  Language Level:', inputData?.languageLevel);
        log.debug('  Pages:', inputData?.pages);
        log.debug('  Story Details:', inputData?.storyDetails?.substring(0, 200) + (inputData?.storyDetails?.length > 200 ? '...' : ''));
        log.debug('  Characters:', inputData?.characters?.map(c => `${c.name} (${c.gender}, ${c.age})`).join(', '));
        log.debug('  Main Characters:', inputData?.mainCharacters);
      }

      // Get all checkpoints
      const checkpoints = await getAllCheckpoints(jobId);
      log.debug(`\n💾 [CHECKPOINTS]: Found ${checkpoints.length} checkpoints`);

      for (const cp of checkpoints) {
        log.debug(`\n--- ${cp.step_name} (index: ${cp.step_index}) at ${cp.created_at} ---`);
        const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

        if (cp.step_name === 'outline') {
          log.debug('📜 [OUTLINE]:', data.outline?.substring(0, 500) + '...');
          if (data.outlinePrompt) {
            log.debug('📜 [OUTLINE PROMPT]:', data.outlinePrompt?.substring(0, 1000) + '...');
          }
        } else if (cp.step_name === 'scene_hints') {
          log.debug('🎬 [SCENE HINTS]:', JSON.stringify(data.shortSceneDescriptions, null, 2).substring(0, 500) + '...');
        } else if (cp.step_name === 'story_batch') {
          log.debug(`📖 [STORY BATCH ${data.batchNum}] Pages ${data.startScene}-${data.endScene}:`);
          log.debug('  Text preview:', data.batchText?.substring(0, 300) + '...');
          if (data.batchPrompt) {
            log.debug('  Batch prompt:', data.batchPrompt?.substring(0, 500) + '...');
          }
        } else if (cp.step_name === 'partial_page') {
          log.debug(`🖼️  [PAGE ${cp.step_index}]:`);
          log.debug('  Scene description:', (data.description || data.sceneDescription?.description)?.substring(0, 200) + '...');
          log.debug('  Image prompt:', (data.prompt || data.imagePrompt)?.substring(0, 200) + '...');
          log.debug('  Has image:', !!data.imageData);
          log.debug('  Quality score:', data.qualityScore || data.score);
        } else if (cp.step_name === 'cover') {
          log.debug(`🎨 [COVER ${data.type}]:`);
          log.debug('  Prompt:', data.prompt?.substring(0, 200) + '...');
        } else if (cp.step_name === 'storybook_combined') {
          log.debug('📚 [STORYBOOK COMBINED]:', data.response?.substring(0, 500) + '...');
        } else {
          log.debug('  Data keys:', Object.keys(data).join(', '));
        }
      }

      log.debug('\n' + '='.repeat(80));
      log.debug('📋 [DEBUG] END OF PARTIAL DATA DUMP');
      log.debug('='.repeat(80) + '\n');

      // SAVE PARTIAL RESULTS - reconstruct story from checkpoints and save to stories table
      await savePartialStoryFromCheckpoints(jobId, error.message);
    } catch (dumpErr) {
      log.error('❌ Failed to dump partial data:', dumpErr.message);
    }

    // Send failure notifications
    try {
      const jobResult = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
      if (jobResult.rows.length > 0) {
        const userId = jobResult.rows[0].user_id;
        const storyLanguage = jobResult.rows[0].input_data?.language;
        const userResult = await dbPool.query(
          'SELECT email, username, shipping_first_name, preferred_language FROM users WHERE id = $1',
          [userId]
        );
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          // Notify admin
          await email.sendAdminStoryFailureAlert(jobId, userId, user.username, user.email || 'N/A', error.message);
          // Notify customer
          if (user.email) {
            const firstName = email.resolveGreetingName(user);
            // Same choice as the story-complete mail: the story's own language
            // first, then the profile. The profile column defaults to 'English'
            // for trial users, so reading it first mailed a German story's
            // failure in English.
            const emailLanguage = storyLanguage || user.preferred_language || 'English';
            await email.sendStoryFailedEmail(user.email, firstName, emailLanguage);
          }
        }
      }
    } catch (emailErr) {
      log.error('❌ Failed to send failure notification emails:', emailErr);
    }
  }
}

// Helper functions for story generation

// Build base prompt with character/setting info for story text generation
// textPageCount: the actual number of text pages/scenes (not total PDF pages)
// NOTE: Prompt builder functions moved to server/lib/storyHelpers.js
// Exports: buildBasePrompt, parseSceneDescriptions,
// buildRelativeHeightDescription, buildImagePrompt



module.exports = {
  initStoryJobPipeline,
  saveCheckpoint,
  getCheckpoint,
  getAllCheckpoints,
  deleteJobCheckpoints,
  savePartialStoryFromCheckpoints,
  processStoryJob,
  awaitPreparedAvatars, // test seam
  runTrialEarlyStyling, // test seam
  streamingProgressFor, // test seam
};
