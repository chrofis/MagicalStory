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

const { log } = require('./server/lib/serverLog');
const pLimit = require('p-limit');
const email = require('./email');
const { upsertStory, saveStoryImage, rehydrateStoryImages } = require('./server/services/database');
const { PROMPT_TEMPLATES, fillTemplate, buildEmptyScenePrompt } = require('./server/services/prompts');
const { generateViewPdf } = require('./server/lib/pdf');
const { generateImageOnly } = require('./server/lib/images');
const { generateReferenceSheet, buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./server/lib/referenceSheets');
const { runUnifiedRepairPipeline } = require('./server/lib/repairPipeline');
const {
  prepareStyledAvatars,
  applyStyledAvatars,
  collectAvatarRequirements,
  setStyledAvatar,
  runInCacheScope,
  clearStyledAvatarCache,
  getStyledAvatarCacheStats,
  exportStyledAvatarsForPersistence,
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog
} = require('./server/lib/styledAvatars');
const { reconcileCoverClothingWithRequirements } = require('./server/lib/clothingCategories');
const {
  getCostumedAvatarGenerationLog,
  clearCostumedAvatarGenerationLog
} = require('./server/routes/avatars');
const {
  MODEL_DEFAULTS,
  callTextModelStreaming
} = require('./server/lib/textModels');
const {
  MODEL_PRICING,
  IMAGE_MODELS,
  REPAIR_DEFAULTS
} = require('./server/config/models');
const {
  filterMainCharactersFromVisualBible,
  initializeVisualBibleMainCharacters,
  buildFullVisualBiblePrompt,
  linkPreDiscoveredLandmarks,
  injectHistoricalLocations,
  getElementReferenceImagesForPage,
  getElementReferenceImagesByIds,
  dedupeSecondaryCharacterIds
} = require('./server/lib/visualBible');
const {
  prefetchLandmarkPhotos,
  getIndexedLandmarks,
  loadLandmarkPhotoDescriptions
} = require('./server/lib/landmarkPhotos');
const {
  getCharactersInScene,
  getCharacterPhotoDetails,
  buildCharacterReferenceList,
  extractPageClothing,
  buildSceneExpansionPrompt,
  buildImagePrompt,
  buildUnifiedStoryPrompt,
  buildOutlineReviewPrompt,
  buildTrialStoryPrompt,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForScene,
  extractSceneMetadata,
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
const { createJobHeartbeat } = require('./server/lib/jobHeartbeat');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require('./server/lib/generationLogger');
const { stripDataUriPrefix } = require('./server/lib/r2');
const { COVER_PAGE_NUMBERS } = require('./server/lib/coverKeys');

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
    let fullStoryText = '';
    const sceneDescMap = new Map();
    let sceneImages = [];
    let storyTextPrompts = [];
    let visualBible = null;
    let coverImages = {};
    let pageClothingData = null;
    const lang = inputData?.language || 'en';
    const pageWord = lang.startsWith('de') ? 'Seite' : lang.startsWith('fr') ? 'Page' : 'Page';

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
        if (data.imageData) {
          sceneImages.push({ pageNumber: pageNum, imageData: data.imageData, description: sceneDesc, prompt: data.prompt || data.imagePrompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, totalAttempts: data.totalAttempts, retryHistory: data.retryHistory, wasRegenerated: data.wasRegenerated, originalImage: data.originalImage, originalScore: data.originalScore, originalReasoning: data.originalReasoning, modelId: data.modelId || null, referencePhotos: data.referencePhotos || null, imageAspect: inputData?.layout?.imageAspect || data.imageAspect, textInImage: inputData?.layout?.textInImage ?? data.textInImage });
        }
      } else if (cp.step_name === 'cover' || cp.step_name === 'partial_cover') {
        if (data.imageData && data.type) {
          coverImages[data.type] = { imageData: data.imageData, description: data.description || '', prompt: data.prompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, modelId: data.modelId || null };
        }
      }
    }

    const sceneDescriptions = Array.from(sceneDescMap.entries()).map(([pageNumber, description]) => ({ pageNumber, description })).sort((a, b) => a.pageNumber - b.pageNumber);
    const hasContent = outline || fullStoryText || sceneImages.length > 0;
    if (!hasContent) return;

    const storyTitle = inputData?.title || `Partial Story (${new Date().toLocaleDateString()})`;
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
async function processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableFullRepair = true, checkCancellation = async () => {}) {
  const timingStart = Date.now();
  log.debug(`📖 [UNIFIED] Starting unified story generation for job ${jobId}`);

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

  // Token usage tracker - same structure as other modes
  const tokenUsage = {
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // OpenRouter-hosted Qwen/DeepSeek (A/B) — token-based like Claude/Gemini.
    // direct_cost carries OpenRouter's ACTUAL charge (usage.cost) when it reports
    // one — throughput-sorted routing can pick a pricier upstream than
    // MODEL_PRICING assumes, so the reported figure beats the estimate.
    openrouter: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0 },
    // Runware/Grok use direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    grok: { direct_cost: 0, calls: 0 },
    byFunction: {
      unified_story: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_expansion: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_iterate: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_expansion: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      phantom_patch: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Avatar generation tracking
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Consistency check tracking
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      // Scene rewrite tracking (when safety blocks trigger rewrites)
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Fallback pricing by provider (uses centralized MODEL_PRICING from server/config/models.js)
  // Note: gemini_image uses per-image pricing, not token pricing - see calculateImageCost
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  // Helper to calculate image generation cost (per-image pricing, not token-based)
  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) {
      return pricing.perImage * imageCount;
    }
    // Fallback to default Gemini image pricing
    return 0.04 * imageCount;
  };

  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    // Idempotency guard: the text chokepoint records every callTextModel result;
    // if a caller ALSO hands the same usage object here, count it once. Marks the
    // object (non-enumerable) so a second add of the identical reference no-ops.
    if (usage && usage.__accounted) return;
    if (usage && typeof usage === 'object') {
      try { Object.defineProperty(usage, '__accounted', { value: true, configurable: true, enumerable: false }); } catch { /* frozen usage — skip guard */ }
    }
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage[provider].calls += 1;
      // Accumulate direct_cost for providers that use it (Grok, Runware)
      if (usage.direct_cost != null && tokenUsage[provider].direct_cost !== undefined) {
        tokenUsage[provider].direct_cost += usage.direct_cost;
      }
    }
    if (functionName) {
      // Auto-create the bucket so a label the chokepoint emits (e.g. text_check,
      // vb_chr_dedup) is never silently dropped from the breakdown.
      if (!tokenUsage.byFunction[functionName]) {
        tokenUsage.byFunction[functionName] = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, elapsed_ms: 0, provider: null, models: new Set() };
      }
      tokenUsage.byFunction[functionName].input_tokens += usage?.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage?.output_tokens || 0;
      tokenUsage.byFunction[functionName].thinking_tokens += usage?.thinking_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      // Summed wall-clock across this function's calls. Stamped by the text
      // chokepoint (textModels.js), so a function is timed without timing itself.
      tokenUsage.byFunction[functionName].elapsed_ms = (tokenUsage.byFunction[functionName].elapsed_ms || 0) + (usage?.elapsed_ms || 0);
      tokenUsage.byFunction[functionName].provider = provider;
      // Coerce to a string id — a mis-wired caller can pass a model OBJECT,
      // which otherwise renders as "[object Object]" in the api_usage log.
      if (modelName) tokenUsage.byFunction[functionName].models.add(typeof modelName === 'string' ? modelName : (modelName.modelId || modelName.model || String(modelName)));
      // Accumulate direct_cost on byFunction entries that support it
      if (usage?.direct_cost != null && tokenUsage.byFunction[functionName].direct_cost !== undefined) {
        tokenUsage.byFunction[functionName].direct_cost += usage.direct_cost;
      }
    }
  };
  // Register addUsage as the text-usage sink for this job's async context, so
  // every callTextModel/callTextModelStreaming records automatically (the
  // chokepoint is the single source of truth — see usageContext.js).
  require('./server/lib/usageContext').setUsageSink(addUsage);

  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
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
  // 'advanced' → square + text-below. Others → A4 + text-overlay.
  const { resolveLayout } = require('./server/lib/layout');
  const layout = resolveLayout(inputData.languageLevel, inputData.layoutOverride);
  inputData.layout = layout;
  log.debug(`📖 [UNIFIED] Input: ${inputData.pages} pages, level: ${inputData.languageLevel} → ${sceneCount} scenes, layout: ${layout.mode} (${layout.imageAspect}, textInImage=${layout.textInImage})`);
  const { getLanguageNameEnglish } = require('./server/lib/languages');
  const langText = getLanguageNameEnglish(lang);

  try {
    // PHASE 1: Generate complete story with unified prompt
    await checkCancellation();
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [1, 'Starting story generation...', jobId]
    );

    // Beats-first pipeline (admin/env gated). When on, the unified writer call
    // and the outline review are both replaced by the five staged beats calls
    // in server/lib/beatsPipeline.js. Everything downstream of the parse
    // (images, repair, text_refine, covers) runs unchanged.
    const pipelineMode = resolvePipelineMode(inputData);
    const beatsMode = pipelineMode === 'beats';
    if (beatsMode) log.info(`🪜 [PIPELINE] pipelineMode=beats — unified writer + outline review are skipped`);

    const unifiedPrompt = inputData.trialMode
      ? buildTrialStoryPrompt(inputData, sceneCount)
      : buildUnifiedStoryPrompt(inputData, sceneCount);
    log.debug(`📖 [UNIFIED] Prompt length: ${unifiedPrompt.length} chars, requesting ${sceneCount} pages${inputData.trialMode ? ' (trial mode)' : ''}`);

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

    // Track parallel tasks started during streaming
    const streamingSceneExpansionPromises = new Map(); // pageNum -> promise
    const streamingCoverPromises = new Map(); // coverType -> promise
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

    // TRIAL MODE: Start avatar styling immediately using pre-defined costumes
    // This runs in parallel with story generation (no need to wait for outline clothing)
    if (inputData.trialMode && !skipImages && artStyle !== 'realistic') {
      const { getTrialCostume } = require('./server/config/trialCostumes');
      const mainChar = (inputData.characters || [])[0];
      // For life-challenge: storyTheme has the adventure type (pirate), storyTopic has the challenge (cleaning-up)
      // For adventure: storyTheme has the theme, storyTopic may be empty
      // For historical: storyTopic has the event ID
      const lookupCategory = inputData.storyCategory === 'historical' ? 'historical' : 'adventure';
      const lookupTopic = inputData.storyCategory === 'historical'
        ? (inputData.storyTopic || '')
        : (inputData.storyTheme || inputData.storyTopic || '');
      const costume = getTrialCostume(
        lookupTopic,
        lookupCategory,
        mainChar?.gender || ''
      );

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

      // Trial policy: when a costume is configured, generate ONLY the
      // costumed 2×4 sheet. The 'standard' look is seeded from the cheap
      // preview avatar generated during the wizard (see trial.js:2056
      // _seedStandardFromPreview) and lives in the styled-avatar cache as
      // the 'standard' entry — applyStyledAvatars finds it without us
      // having to spend another ~30s + Grok call on a standard 2×4 sheet
      // that's only used on rare non-costumed scenes anyway. The previous
      // code requested BOTH 'standard' AND 'costumed:X' here, contradicting
      // the prepare-title intent (trial.js builds only costumed in its own
      // requirements list) and producing a Lukas-watercolor-standard log
      // entry the user explicitly objected to. Only fall back to 'standard'
      // when no costume is configured (rare in trial, but supported).
      const trialAvatarRequirements = (inputData.characters || []).flatMap(char => {
        const cats = costume ? [`costumed:${costume.costumeType}`] : ['standard'];
        return cats.map(cat => ({
          pageNumber: 'pre-cover',
          clothingCategory: cat,
          characterNames: [char.name]
        }));
      });

      // Seed cache with pre-generated styled avatars from prepare-title (avoid re-generating)
      const preGenAvatars = (inputData.characters || [])[0]?.preGeneratedStyledAvatars;
      if (preGenAvatars) {
        let seeded = 0;
        for (const [charName, avatars] of Object.entries(preGenAvatars)) {
          for (const [category, imageData] of Object.entries(avatars)) {
            if (category === 'costumed' && typeof avatars.costumed === 'object') {
              for (const [costumeType, img] of Object.entries(avatars.costumed)) {
                setStyledAvatar(charName, `costumed:${costumeType}`, artStyle, img);
                seeded++;
              }
            } else if (category !== 'costumed') {
              setStyledAvatar(charName, category, artStyle, imageData);
              seeded++;
            }
          }
        }
        if (seeded > 0) log.info(`♻️ [TRIAL] Seeded ${seeded} styled avatars from prepare-title cache`);
      }

      log.info(`🎨 [TRIAL] Starting immediate avatar styling (${trialAvatarRequirements.length} variants)...`);
      streamingAvatarStylingPromise = (async () => {
        try {
          await prepareStyledAvatars(inputData.characters || [], artStyle, trialAvatarRequirements, trialClothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
          earlyAvatarStylingSucceeded = getStyledAvatarCacheStats().size > 0;
          log.info(`✅ [TRIAL] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.warn(`⚠️ [TRIAL] Early avatar styling failed: ${error.message}`);
        }
      })();
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

        // 1. Characters from outline's characters[] array (primary — foreground/center)
        if (page.characters && page.characters.length > 0) {
          for (const parsed of page.characters) {
            const parsedLower = parsed.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
            const match = allChars.find(char => {
              if (!char.name) return false;
              const nameLower = char.name.toLowerCase().trim();
              const firstName = nameLower.split(' ')[0];
              return parsedLower === nameLower || parsedLower === firstName;
            });
            if (match && !sceneCharacters.some(sc => sc.name === match.name)) {
              sceneCharacters.push(match);
            }
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
          const bgText = (hintParsed.background || '').toLowerCase();
          if (bgText) {
            for (const char of allChars) {
              if (char.name && bgText.includes(char.name.toLowerCase()) && !sceneCharacters.some(sc => sc.name === char.name)) {
                sceneCharacters.push(char);
                backgroundMentionAdded.push(char.name);
              }
            }
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
          if (page.characterClothing) {
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
              referencePhotos: expansionPagePhotos
            }
          );

          // Heartbeat keeps story_jobs.updated_at fresh during scene expansion streaming.
          // 24 parallel scene expansions can each take 30-60s; without heartbeating,
          // the row would only get updated when the first one finishes.
          const expansionHeartbeat = createJobHeartbeat(jobId, dbPool);
          expansionResult = await callTextModelStreaming(expansionPrompt, 10000, () => expansionHeartbeat(), modelOverrides.sceneDescriptionModel, { usageLabel: 'scene_expansion' });
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
                  addUsage('runware', { cost: validationResult.usage.previewCost }, 'scene_validation_preview');
                }
                if (validationResult.usage.visionCost || validationResult.usage.comparisonCost) {
                  addUsage('gemini_text', {
                    promptTokenCount: (validationResult.usage.visionTokens || 0) + (validationResult.usage.comparisonTokens || 0),
                    candidatesTokenCount: 0
                  }, 'scene_validation_analysis');
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

          // Build per-character clothing for this page.
          // Honour Claude's per-page clothing choices — including narrative
          // arcs that put the main character in standard clothes for some
          // pages and costume for others. The previous force-costumed
          // override here was reverted (user direction): the story should
          // dictate the wardrobe, not the trial theme. Same fallback as
          // pre-override: only if Claude emits no clothing at all do we
          // default the main character to 'costumed' so the page has
          // something to render.
          const perCharClothing = page.characterClothing || {};
          if (inputData._trialCostumeType && Object.keys(perCharClothing).length === 0) {
            const mainCharIds = inputData.mainCharacters || [];
            for (const char of (inputData.characters || [])) {
              const isMain = char.isMainCharacter === true || mainCharIds.includes(char.id);
              if (isMain) {
                perCharClothing[char.name] = 'costumed';
              }
            }
          }

          // Determine which characters appear in this scene
          const sceneCharacters = getCharactersInScene(
            (page.sceneHint || '') + '\n' + (page.text || ''),
            inputData.characters
          );

          // Build clothing requirements with _currentClothing per character.
          // Clone the character entry before writing — sharing the nested
          // object with inputData._trialClothingRequirements lets a per-scene
          // value pollute the global requirements and leak into later pages.
          const sceneClothingRequirements = { ...(inputData._trialClothingRequirements || {}) };
          for (const char of sceneCharacters) {
            const charClothing = perCharClothing[char.name] || 'standard';
            sceneClothingRequirements[char.name] = {
              ...(sceneClothingRequirements[char.name] || {}),
              _currentClothing: charClothing
            };
          }

          // Get character photos with styled avatars applied
          let pagePhotos = getCharacterPhotoDetails(sceneCharacters, 'standard', inputData.artStyle, sceneClothingRequirements);
          pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
          // Phase 7: cell-crop refs from the story-scoped 2×4 sheet when one
          // exists. Mutates pagePhotos in place; characters without a story
          // sheet keep the styled-avatar URL produced above.
          {
            const sav = require('./server/lib/storyAvatars');
            const storyAvatars = sav.projectStoryCharacterAvatars(inputData.characters || [], inputData.artStyle || 'pixar');
            await sav.applyStoryCellRefs(pagePhotos, storyAvatars, sceneCharacters);
          }

          // Build the image prompt — trial uses rich scene hint as scene description
          const sceneDescription = page.sceneHint || page.text || '';
          const pageImageModel = MODEL_DEFAULTS.simplePageImage;
          const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
          const isGrokImage = pageImageBackend === 'grok';

          const imagePrompt = buildImagePrompt(
            sceneDescription, inputData, sceneCharacters, streamingVisualBible,
            page.pageNumber, pagePhotos, { skipVisualBible: isGrokImage }
          );

          // Resolve landmarks and VB grid for Grok reference slots
          const sceneMetadata = extractSceneMetadata(sceneDescription);
          const pageLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, sceneMetadata);
          // Wait for the parallel ref-sheet generation (started in onVisualBible
          // alongside empty scenes + costumed avatars) before reading element
          // refs — otherwise getElementReferenceImagesForPage returns an empty
          // array because referenceImageUrl hasn't been populated on each VB
          // entry yet. The promise typically resolves well before page render
          // since costumed avatar gen takes ~30s and ref sheets ~15-20s; this
          // await is usually a no-op by the time we hit it. Falls through on
          // failure (ref sheets are an enhancement, not a hard requirement).
          if (trialReferenceSheetPromise) {
            try { await trialReferenceSheetPromise; } catch { /* logged in the catch in onVisualBible */ }
          }
          let elementRefs = getElementReferenceImagesForPage(streamingVisualBible, page.pageNumber, 6);
          // Also match by IDs from scene hint (same as Phase 5a)
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
              const idBasedRefs = getElementReferenceImagesByIds(streamingVisualBible, sceneIds);
              const existingIds = new Set(elementRefs.map(r => r.id));
              const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
              if (newRefs.length > 0) elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
            }
          }
          const secondaryLandmarks = pageLandmarkPhotos.slice(1);
          let trialVbGrid = null;
          if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
            trialVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
          }

          log.info(`⚡ [TRIAL-STREAM] Page ${page.pageNumber} image generation starting (parallel with streaming)${pageLandmarkPhotos.length ? ` [${pageLandmarkPhotos.length} landmark(s)]` : ''}${trialVbGrid ? ' [VB grid]' : ''}`);
          const startTime = Date.now();

          const genResult = await generateImageOnly(imagePrompt, pagePhotos, {
            aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
            imageModelOverride: pageImageModel,
            imageBackendOverride: pageImageBackend,
            pageNumber: page.pageNumber,
            landmarkPhotos: pageLandmarkPhotos,
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
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: page.pageNumber,
              text: page.text,
              sceneDescription,
              imageData: genResult.imageData,
              modelId: genResult.modelId
            }, page.pageNumber);
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
            prompt: imagePrompt,
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
    const startCoverGeneration = (coverType, hint) => {
      if (streamingCoverPromises.has(coverType) || skipImages) return;
      if (inputData.titlePageOnly && coverType !== 'titlePage') return;
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

          if (coverType === 'titlePage') {
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

        // The FRONT cover (coverType 'titlePage' → stored as frontCover) is a
        // main-characters-only portrait — but ONLY for FALLBACK casts (scene-
        // text matching). Hint-derived casts pass through untouched; the
        // narrowing exists to stop the whole cast flooding a fallback cover,
        // not to veto characters the outline explicitly placed on the cover.
        // The BACK cover is deliberately a full-cast group portrait (see
        // story-unified.txt Back Cover spec) — do NOT drop non-mains there.
        if (coverType === 'titlePage' && coverCharacters.length > 0 && !castFromHint) {
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
        if (coverCharacters.length === 0 && coverType === 'titlePage') {
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
            coverClothingRequirements[charName] = { _currentClothing: clothing };
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

        // Default clothing category (used if no per-character clothing specified)
        const defaultClothingCategory = 'standard';

        // Cap characters at 5 — more than 5 almost always produces bad results
        // Main characters appear on ALL covers, non-main are split across initial/back
        const MAX_COVER_CHARACTERS = 5;
        let charactersForCover;
        if (coverCharacters.length > 0) {
          // Scene description contained character names - use exactly those
          charactersForCover = coverCharacters.length > MAX_COVER_CHARACTERS
            ? coverCharacters.slice(0, MAX_COVER_CHARACTERS)
            : coverCharacters;
        } else if (coverType !== 'titlePage') {
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
        // Phase 7: cell-crop refs from story sheets. For covers we use front
        // pose by default (head-on shot) — no per-page scene metadata at this point.
        {
          const sav = require('./server/lib/storyAvatars');
          const storyAvatars = sav.projectStoryCharacterAvatars(inputData.characters || [], artStyle || 'pixar');
          const fakeMeta = charactersForCover.map(c => ({ name: c.name, pose: 'front', flip: false }));
          await sav.applyStoryCellRefs(coverPhotos, storyAvatars, fakeMeta);
        }

        // Cover prompt setup — routed model/backend determined after scene expansion.
        // KEY STORY ELEMENTS filtered to the hint's objects ∪ holds, and the
        // worn-vs-held contradiction resolved before the CLOTHING block is
        // built (same helpers the iterate path uses — single source of truth).
        const { collectCoverHintElementIds, applyCoverWornHeldDedupe } = require('./server/lib/coverIterate');
        const hintElementIds = collectCoverHintElementIds(hint);
        const { photos: clothingDedupedPhotos, excludeElementIds } =
          applyCoverWornHeldDedupe(coverPhotos, hint, streamingVisualBible);
        const visualBibleText = streamingVisualBible
          ? buildFullVisualBiblePrompt(streamingVisualBible, {
              skipMainCharacters: true,
              allowedElementIds: hintElementIds,
              excludeElementIds,
            })
          : '';
        let characterRefList = buildCharacterReferenceList(clothingDedupedPhotos, inputData.characters, { includeClothing: true });

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
        const { buildCoverSceneFromHint } = require('./server/lib/coverIterate');
        sceneDescription = buildCoverSceneFromHint(hint, streamingVisualBible, charactersForCover, { language: inputData.language || 'en' });
        const coverExpandedMetadata = null; // No metadata block — structured hint IS the metadata.

        const coverLabel = coverType === 'titlePage' ? 'FRONT COVER' : coverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';

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
        const textlessCovers = MODEL_DEFAULTS.appSideCoverType;
        let coverPrompt;
        if (coverType === 'titlePage') {
          // Front cover: include title for text rendering (skipped when textless)
          const storyTitle = streamingTitle || inputData.title || 'My Story';
          coverPrompt = fillTemplate(textlessCovers ? PROMPT_TEMPLATES.frontCoverTextless : PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: characterRefList,
            VISUAL_BIBLE: visualBibleText
          });
        } else if (coverType === 'initialPage') {
          // Initial page: with or without dedication (textless → always the no-text scene).
          // Group-composition boilerplate is conditional on the actual cast size —
          // for 1-2 characters it would contradict the hint's explicit positions.
          const { buildInitialPageComposition } = require('./server/lib/coverIterate');
          const groupComposition = buildInitialPageComposition(coverPhotos.length);
          coverPrompt = (!textlessCovers && inputData.dedication && inputData.dedication.trim())
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                DEDICATION: inputData.dedication,
                CHARACTER_REFERENCE_LIST: characterRefList,
                GROUP_COMPOSITION: groupComposition,
                VISUAL_BIBLE: visualBibleText
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: characterRefList,
                GROUP_COMPOSITION: groupComposition,
                VISUAL_BIBLE: visualBibleText
              });
        } else {
          // Back cover
          coverPrompt = fillTemplate(textlessCovers ? PROMPT_TEMPLATES.backCoverTextless : PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: characterRefList,
            VISUAL_BIBLE: visualBibleText
          });
        }

        // Final chokepoint — same VB-id protection buildImagePrompt gives
        // pages. buildCoverSceneFromHint falls back to the bare id when a
        // character's `holds` references an id missing from hint.objects
        // ("holds the ART002"), and the image model paints unknown ids as
        // literal signs. Resolve or drop them before the prompt ships.
        {
          const { sanitizeVbIdsInPrompt } = require('./server/lib/storyHelpers');
          const coverPageNum = coverType === 'titlePage' ? -1 : coverType === 'initialPage' ? -2 : -3;
          coverPrompt = sanitizeVbIdsInPrompt(coverPrompt, streamingVisualBible, coverPageNum);
        }

        // Build cover references via the shared helper — same one iterate uses,
        // so v0 / iterate / legacy streaming all share one source of truth.
        const { buildCoverReferences } = require('./server/lib/coverIterate');
        const coverKeyForRefs = coverType === 'titlePage' ? 'frontCover' : coverType;
        const skipEmptyScene = (typeof modelOverrides.singlePassScene === 'boolean'
          ? modelOverrides.singlePassScene
          : MODEL_DEFAULTS.singlePassScene === true)
          || modelOverrides.generateEmptyScenes === false;
        const coverRefs = await buildCoverReferences({
          coverKey: coverKeyForRefs,
          visualBible: streamingVisualBible,
          artStyle: inputData.artStyle,
          sceneDescription,
          coverHint: hint, // hint.objects carries LOC + ART IDs from the unified prompt
          sceneMetadata: coverExpandedMetadata, // pre-computed by scene expansion
          imageModel: skipEmptyScene ? null : coverImageModel,
          imageBackend: skipEmptyScene ? null : coverImageBackend,
          emptyScenePromptOverride: coverExpandedMetadata?.emptyScenePrompt || null,
          usageTracker: skipEmptyScene ? null : (usage, modelId) => {
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
          imageModelOverride: coverImageModel,
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
        const coverKey = coverType === 'titlePage' ? 'frontCover' : coverType;
        const checkpointData = {
          type: coverKey,
          imageData: coverResult.imageData,
          description: sceneDescription,
          modelId: coverResult.modelId
        };
        // Include title for frontCover so UI can transition to story display
        if (coverType === 'titlePage' && streamingTitle) {
          checkpointData.storyTitle = streamingTitle;
        }
        const checkpointIndex = coverType === 'titlePage' ? 0 : coverType === 'initialPage' ? 1 : 2;
        await saveCheckpoint(jobId, 'partial_cover', checkpointData, checkpointIndex);
        log.debug(`💾 [UNIFIED] Saved ${coverKey} for progressive display`);

        return {
          type: coverType,
          imageData: coverResult.imageData,
          description: sceneDescription,
          // Exact sent text when the provider reports it (post-truncation /
          // post-sanitize), falling back to the built prompt — same as pages.
          prompt: coverResult.prompt || coverPrompt,
          referencePhotos: coverPhotos,
          landmarkPhotos: coverLandmarkPhotos,
          emptySceneImage: coverSceneBackground || null,
          modelId: coverResult.modelId,
          grokRefImages: coverResult.grokRefImages || null
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
              const basicRequirements = (inputData.characters || []).flatMap(char => {
                const charNameTrimmed = char.name?.trim();
                const charNameLower = charNameTrimmed?.toLowerCase();
                const charReqs = requirements?.[char.name] ||
                                 requirements?.[charNameTrimmed] ||
                                 requirements?.[charNameLower] ||
                                 (requirements && Object.entries(requirements)
                                   .find(([k]) => k.trim().toLowerCase() === charNameLower)?.[1]);

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
              await prepareStyledAvatars(inputData.characters || [], artStyle, basicRequirements, requirements, addUsage, modelOverrides.storyAvatarModel || null);
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
            maxElements: 6,  // trial cap — story-trial.txt limits to max 2 secondaries + 2 artifacts + 2 locations
            storyId: jobId,
          }).catch(err => {
            log.warn(`⚠️ [TRIAL] Early VB reference sheet generation failed: ${err.message}`);
            return { generated: 0, failed: 0, elements: [] };
          });
          log.info(`📚 [TRIAL] Early VB reference-sheet generation started (parallel with empty scenes + costumed avatars)`);
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
          const pageLandmarkLookup = {};
          for (const loc of (vb.locations || [])) {
            if (!loc.isRealLandmark || !loc.pages?.length) continue;
            if (!(loc.referencePhotoUrl || loc.referencePhotoData) || loc.photoFetchStatus !== 'success') continue;
            for (const pn of loc.pages) {
              if (!pageLandmarkLookup[pn]) {
                pageLandmarkLookup[pn] = {
                  name: loc.name,
                  photoUrl: loc.referencePhotoUrl || null,
                  photoData: loc.referencePhotoData || null,
                  attribution: loc.photoAttribution,
                  source: loc.photoSource,
                };
              }
            }
          }

          for (const bg of vb.backgrounds) {
            if (!bg.description || !bg.pages?.length) continue;
            // Pick the first landmark whose `pages` array overlaps this bg's
            // pages — typically there's only one. Plumbing the photo into the
            // empty-scene render is the only way to anchor the building's
            // shape; the scene description alone doesn't carry visual identity.
            const bgLandmark = bg.pages.map(pn => pageLandmarkLookup[pn]).find(Boolean);
            const emptySceneLandmarkPhotos = bgLandmark ? [bgLandmark] : [];
            // Strong landmark-fidelity block — only included when a landmark
            // is actually attached. Shared builder (storyHelpers) anchors the
            // photo by NAME so Grok knows which building it's looking at and
            // preserves its silhouette; '' when no landmark.
            const { buildLandmarkFidelityBlock } = require('./server/lib/storyHelpers');
            const landmarkFidelityBlock = buildLandmarkFidelityBlock(bgLandmark);
            for (const pageNum of bg.pages) {
              bgPromises.push(bgLimit(async () => {
                try {
                  const emptyPrompt = buildEmptyScenePrompt({
                    style: artStyleDesc,
                    description: bg.description,
                    landmarkFidelity: landmarkFidelityBlock,
                  });
                  const result = await generateImageOnly(emptyPrompt, [], {
                    landmarkPhotos: emptySceneLandmarkPhotos,
                    skipCache: true
                  });
                  if (result?.imageData) {
                    sceneBackgrounds[pageNum] = { imageData: result.imageData, prompt: emptyPrompt };
                    log.info(`🎬 [TRIAL] Empty scene for page ${pageNum} generated (${Math.round(result.imageData.length / 1024)}KB)`);
                    if (result.usage) {
                      const isGrok = result.modelId?.startsWith('grok-imagine');
                      addUsage(isGrok ? 'grok' : 'gemini_image', result.usage, 'trial_empty_scene', result.modelId);
                    }
                  }
                } catch (err) {
                  log.warn(`⚠️ [TRIAL] Empty scene for page ${pageNum} failed: ${err.message}`);
                }
              }));
            }
          }
          // Don't await — let them run in background while outline continues streaming
          Promise.all(bgPromises).then(() => {
            log.info(`🎬 [TRIAL] All ${Object.keys(sceneBackgrounds).length} empty scenes ready`);
          }).catch(() => {});
        }
      },
      onCoverScene: (coverData) => {
        // TRIAL MODE: Generate title page from the structured cover scene JSON
        if (!inputData.trialMode) return;
        if (streamingCoverPromises.has('titlePage') || skipImages || skipCovers) return;

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

            // Build scene description from the cover hint JSON
            const sceneDescription = '```json\n' + JSON.stringify(coverScene, null, 2) + '\n```';

            // Determine which characters appear in the cover scene
            let coverCharacters = [];
            if (coverScene.characters?.length > 0) {
              const sceneCharNames = coverScene.characters.map(c => c.name?.toLowerCase());
              coverCharacters = (inputData.characters || []).filter(c =>
                sceneCharNames.includes(c.name?.toLowerCase())
              );
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
                    ...(coverClothingReqs[sc.name] || {}),
                    _currentClothing: sc.clothing
                  };
                }
              }
            }
            // Fallback: apply trial costume type for characters without explicit clothing.
            // Clone the entry before assigning so we don't pollute inputData._trialClothingRequirements.
            if (inputData._trialCostumeType) {
              for (const char of coverCharacters) {
                if (!coverClothingReqs[char.name]?._currentClothing) {
                  coverClothingReqs[char.name] = {
                    ...(coverClothingReqs[char.name] || {}),
                    _currentClothing: 'costumed'
                  };
                }
              }
            }

            // Get character photos with styled avatars
            let coverPhotos = getCharacterPhotoDetails(coverCharacters, 'standard', artStyle, coverClothingReqs);
            coverPhotos = applyStyledAvatars(coverPhotos, artStyle);

            // Build prompt components
            const pageImageModel = MODEL_DEFAULTS.simplePageImage;
            const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
            const styleDescription = resolveArtStyle(artStyle, pageImageBackend) || resolveArtStyle('pixar');
            const characterRefList = buildCharacterReferenceList(coverPhotos, inputData.characters, { includeClothing: true });
            // KEY STORY ELEMENTS filtered to the cover hint's declared ids
            // (same fix as the full-account cover paths — without it every VB
            // artifact got dumped into the prompt and strays got painted).
            const trialCoverIds = (coverScene.objects || [])
              .map(obj => typeof obj === 'string' ? obj.match(/((?:ART|ANI|VEH|CHR|LOC)\d+)/i)?.[1]?.toUpperCase() : (obj?.id ? String(obj.id).toUpperCase() : null))
              .filter(Boolean);
            const visualBibleText = buildFullVisualBiblePrompt(streamingVisualBible, {
              skipMainCharacters: true,
              allowedElementIds: trialCoverIds.length > 0 ? trialCoverIds : null,
            });

            // Textless when covers are typeset app-side — same rule the
            // full-account cover path applies (line ~1480). This path ignored
            // the flag, so the model painted the title into the art AND
            // bakeCoverTypographyPostPersist stamped a second one over it
            // (job_1786815617426: two titles on the trial cover).
            let coverPrompt = fillTemplate(
              MODEL_DEFAULTS.appSideCoverType ? PROMPT_TEMPLATES.frontCoverTextless : PROMPT_TEMPLATES.frontCover,
              {
                TITLE_PAGE_SCENE: sceneDescription,
                STORY_TITLE: coverTitle,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: characterRefList,
                VISUAL_BIBLE: visualBibleText
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
            const coverLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, sceneMetadata);

            // Build VB grid (page number -1 = front cover convention)
            let elementRefs = getElementReferenceImagesForPage(streamingVisualBible, -1, 6);
            // Also match by IDs from cover scene objects
            if (coverScene.objects?.length > 0) {
              const sceneIds = coverScene.objects
                .map(obj => typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH|LOC)\d+)/i)?.[1] : null)
                .filter(Boolean);
              if (sceneIds.length > 0) {
                const idBasedRefs = getElementReferenceImagesByIds(streamingVisualBible, sceneIds.filter(id => !id.startsWith('LOC')));
                const existingIds = new Set(elementRefs.map(r => r.id));
                const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
                if (newRefs.length > 0) elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
              }
            }
            const secondaryLandmarks = coverLandmarkPhotos.slice(1);
            let coverVbGrid = null;
            if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
              coverVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
            }

            log.info(`[TRIAL-COVER] Starting title page generation (title: "${coverTitle}", ${coverCharacters.length} chars, ${coverLandmarkPhotos.length} landmarks${coverVbGrid ? ', VB grid' : ''})`);
            const startTime = Date.now();

            // Generate the image using simplePageImage model (same as trial pages)
            const result = await generateImageOnly(coverPrompt, coverPhotos, {
              imageModelOverride: pageImageModel,
              imageBackendOverride: pageImageBackend,
              landmarkPhotos: coverLandmarkPhotos,
              visualBibleGrid: coverVbGrid,
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
              await saveCheckpoint(jobId, 'partial_cover', {
                type: 'frontCover',
                imageData: result.imageData,
                storyTitle: coverTitle
              }, 0);
              log.debug(`[TRIAL-COVER] Saved partial_cover checkpoint`);
            }

            return {
              type: 'titlePage',
              imageData: result.imageData,
              description: sceneDescription,
              prompt: coverPrompt,
              modelId: result.modelId,
              referencePhotos: coverPhotos,
              landmarkPhotos: coverLandmarkPhotos,
              grokRefImages: result.grokRefImages || null
            };
          } catch (err) {
            log.warn(`[TRIAL-COVER] Title page generation failed: ${err.message}`);
            return null;
          }
        })();

        coverPromise.catch(err => log.warn(`[TRIAL-COVER] Promise failed (will be handled when awaited): ${err.message}`));
        streamingCoverPromises.set('titlePage', coverPromise);
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
        let progress = 1;
        if (type === 'arcs') progress = 2;                   // arrives first
        else if (type === 'title') progress = 3;             // arrives second
        else if (type === 'clothing') progress = 4;          // arrives third
        else if (type === 'plot') progress = 5;              // arrives fourth
        else if (type === 'visualBible') progress = 6;       // arrives fifth
        else if (type === 'covers') progress = 7;            // cover hints
        else if (type === 'page') progress = 7;              // pages streaming (same phase)

        // Enhance message to show parallel work
        let enhancedMessage = message;
        const scenesInProgress = streamingSceneExpansionPromises.size;
        if (scenesInProgress > 0) {
          enhancedMessage = `${message} (${scenesInProgress} scenes in progress)`;
        }

        try {
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
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
    let unifiedResponse;
    let unifiedModelId;
    let unifiedUsage;
    // beatsResult carries the parsed pages + already-expanded scenes when the
    // beats pipeline ran; null on the unified path.
    let beatsResult = null;
    if (beatsMode) {
      beatsResult = await generateStoryViaBeats(inputData, {
        jobId,
        genLog,
        checkCancellation,
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
        onStage: async (pct, msg) => {
          try {
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
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
    } else {
      const unifiedResult = await callTextModelStreaming(unifiedPrompt, 64000, (chunk, fullText) => {
        progressiveParser.processChunk(chunk, fullText);
        unifiedHeartbeat();  // throttled — fires at most every 30s
      }, modelOverrides.outlineModel, { usageLabel: 'unified_story' });
      unifiedResponse = unifiedResult.text;
      unifiedModelId = unifiedResult.modelId;
      unifiedUsage = unifiedResult.usage || { input_tokens: 0, output_tokens: 0 };
    }
    timing.storyGenEnd = Date.now();
    // Determine provider from model ID since streaming doesn't return provider
    const isGeminiModel = unifiedModelId?.startsWith('gemini') || false;
    const unifiedProvider = isGeminiModel ? 'gemini_text' : 'anthropic';
    log.debug(`📊 [UNIFIED] Story usage - model: ${unifiedModelId}, provider: ${unifiedProvider}, input: ${unifiedUsage.input_tokens}, output: ${unifiedUsage.output_tokens}`);
    // Usage recorded by the callTextModelStreaming chokepoint (usageLabel above).
    log.debug(`⏱️ [UNIFIED] Story generation: ${((timing.storyGenEnd - timing.storyGenStart) / 1000).toFixed(1)}s`);

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
          knownCharacterNames: (inputData.characters || []).map(c => c.name)
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
            const reviewResult = await callTextModelStreaming(reviewPrompt, 32000, () => {
              unifiedHeartbeat(); // keep story_jobs.updated_at fresh during the review
            }, reviewModel, { usageLabel: 'outline_review' });
            const t = reviewResult.text || '';
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
    const title = (beatsMode ? beatsResult.title : parser.extractTitle()) || streamingTitle || inputData.storyType || 'Untitled Story';
    const titleCandidates = parser.extractTitleCandidates();
    const clothingRequirements = inputData.trialMode
      ? inputData._trialClothingRequirements
      : (parser.extractClothingRequirements() || streamingClothingRequirements);
    const visualBible = parser.extractVisualBible() || streamingVisualBible || {};
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
    const coverHints = parser.extractCoverHints();

    // Reconcile cover hint clothing against the story's clothingRequirements.
    // Claude can write a cover hint that asks for a clothing category that the
    // character did NOT mark used (e.g. back cover wants Sophie:standard but
    // Sophie's only used category is costumed:zauberlehrling). Generating a
    // never-otherwise-needed avatar would be wasted work AND a silent fallback
    // to the raw face photo would degrade quality. Override the cover hint to
    // use what the character actually has — mutates coverHints in place.
    const reconcileResult = reconcileCoverClothingWithRequirements(coverHints, clothingRequirements, log);
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

    // Deterministic scene metadata ↔ scene design consistency check on the
    // FINAL pages (draft + reviewer patches merged). Mechanical string/set
    // parity only — semantic scene consistency is the outline reviewer's job
    // (see docs/decisions.md). Surfaced three ways: compact log lines, a
    // generationLog event, and finalChecksReport.sceneConsistency (dev panel).
    // Skipped in beats mode: the check compares page metadata against the
    // unified outline's SCENE DESIGN blocks, which a beats transcript has not
    // got — the scene review is the equivalent gate there.
    let sceneConsistencyResult = null;
    if (!beatsMode) {
      try {
        sceneConsistencyResult = checkSceneConsistency(storyPages, unifiedResponse, {
          knownCharacterNames: (inputData.characters || []).map(c => c.name)
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
        modelId: MODEL_DEFAULTS.sceneIteration || 'claude-haiku-4-5',
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
        modelId: MODEL_DEFAULTS.sceneIteration || 'claude-haiku-4-5',
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
    // This enables scene description AI to intelligently select which photo variant to use
    await loadLandmarkPhotoDescriptions(visualBible);

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
      log.info(`🌍 [UNIFIED] Starting background fetch for ${nonVariantLandmarks.length} non-variant landmark photo(s)`);
      landmarkFetchPromise = prefetchLandmarkPhotos(visualBible);
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
      [8, `Story complete: "${title}" (${scenesStarted} scenes in parallel)`, jobId]  // 8 = text complete
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
          const basicCoverRequirements = (inputData.characters || []).flatMap(char => {
            const charNameLower = char.name?.toLowerCase();
            const charReqs = clothingRequirements?.[char.name] ||
                             clothingRequirements?.[charNameLower] ||
                             (clothingRequirements && Object.entries(clothingRequirements)
                               .find(([k]) => k.toLowerCase() === charNameLower)?.[1]);

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
          await prepareStyledAvatars(inputData.characters || [], artStyle, basicCoverRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
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
      [9, `Preparing styled avatars...`, jobId]  // 9 = avatar styling
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
      await prepareStyledAvatars(inputData.characters, artStyle, avatarRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
    }

    // Start cover generation NOW that avatars are ready (covers need avatars as reference photos)
    if (!skipImages && !skipCovers) {
      const coverTypes = inputData.titlePageOnly
        ? ['titlePage']
        : ['titlePage', 'initialPage', 'backCover'];
      for (const coverType of coverTypes) {
        if (streamingCoverPromises.has(coverType)) continue;
        const hint = coverHints?.[coverType];
        if (hint) {
          startCoverGeneration(coverType, hint);
        } else if (coverType === 'titlePage') {
          // Trial mode: Claude may not output cover hints — use a default hint
          const mainCharNames = inputData.characters
            ?.filter(c => c.isMainCharacter)
            .map(c => c.name)
            .join(', ') || inputData.characters?.map(c => c.name).slice(0, 3).join(', ') || 'the main character';
          const theme = inputData.storyTopic || inputData.storyTheme || 'adventure';
          const defaultHint = {
            hint: `A magical, eye-catching front cover scene featuring ${mainCharNames} in a ${theme}-themed setting. The main characters are prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`,
            characterClothing: {}
          };
          if (inputData._trialCostumeType) {
            for (const char of (inputData.characters || [])) {
              defaultHint.characterClothing[char.name] = 'costumed';
            }
          }
          startCoverGeneration(coverType, defaultHint);
        }
      }
      log.debug(`⚡ [UNIFIED] Started ${streamingCoverPromises.size} cover generations (avatars ready)`);
    }

    // PHASE 3: Scene descriptions
    let expandedScenes;

    if (beatsMode) {
      // Beats mode: scenes were expanded AND reviewed inside generateStoryViaBeats
      // (steps 3 + 4), so there is nothing left to expand here.
      expandedScenes = beatsResult.scenes;
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
        [10, `Finalizing ${streamingSceneExpansionPromises.size} scene expansions...`, jobId]  // 10 = scenes expanded
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

    // Create allSceneDescriptions array for storage compatibility
    const allSceneDescriptions = expandedScenes.map(scene => {
      // Extract translatedSummary and imageSummary for edit modal display
      const sceneMetadata = extractSceneMetadata(scene.sceneDescription);
      return {
        pageNumber: scene.pageNumber,
        description: scene.sceneDescription,
        characterClothing: scene.characterClothing || {},
        outlineExtract: scene.outlineExtract || scene.sceneHint || '',
        // Dev mode: Art Director prompt and model used
        scenePrompt: scene.sceneDescriptionPrompt,
        textModelId: scene.sceneDescriptionModelId,
        // Pre-extracted summaries for edit modal (avoids JSON parsing on frontend)
        translatedSummary: sceneMetadata?.translatedSummary || null,
        imageSummary: sceneMetadata?.imageSummary || null
      };
    });

    // Batch-translate scene summaries to story language (separate from scene expansion)
    // One cheap Haiku call with all summaries — ~1-2s, ~$0.001
    if (lang !== 'en') {
      try {
        const summaries = allSceneDescriptions
          .map(s => `Page ${s.pageNumber}: ${s.imageSummary || ''}`)
          .filter(s => s.includes(': ') && s.split(': ')[1].trim())
          .join('\n');
        if (summaries) {
          const { getLanguageInstruction } = require('./server/lib/languages');
          const langInstruction = getLanguageInstruction(lang);
          const translationPrompt = `Translate each scene summary below to the target language. Output ONLY the translations, one per line, in the same order. Keep it concise (1-2 sentences each).\n\nTarget language: ${langInstruction}\n\n${summaries}`;
          const { callTextModelStreaming } = require('./server/lib/textModels');
          const transResult = await callTextModelStreaming(translationPrompt, 2000, null, 'claude-haiku-4-5-20251001', { usageLabel: 'scene_translation' });
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
      coverAwaitPromise = Promise.all(
        Array.from(streamingCoverPromises.values())
      ).then(coverResults => {
        timing.coversEnd = Date.now();
        // Map results to coverImages object
        for (const result of coverResults) {
          if (result?.imageData) {
            // Map coverType to frontend expected keys
            const storageKey = result.type === 'titlePage' ? 'frontCover' : result.type;
            coverImages[storageKey] = {
              imageData: result.imageData,
              description: result.description,
              prompt: result.prompt,
              qualityScore: result.qualityScore,
              qualityReasoning: result.qualityReasoning,
              wasRegenerated: result.wasRegenerated,
              totalAttempts: result.totalAttempts,
              retryHistory: result.retryHistory,
              referencePhotos: result.referencePhotos,
              landmarkPhotos: result.landmarkPhotos,
              grokRefImages: result.grokRefImages || null,
              modelId: result.modelId,
              generatedAt: new Date().toISOString()
            };
          }
        }
        log.debug(`✅ [UNIFIED] All ${Object.keys(coverImages).length} cover images complete`);
        log.debug(`⏱️ [UNIFIED] Cover images: ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
      }).catch(err => {
        timing.coversEnd = Date.now();
        log.error(`❌ [UNIFIED] Cover generation failed: ${err.message}`);
      });
    } else {
      log.debug(`📖 [UNIFIED] No cover images to generate (skipCovers=${skipCovers})`);
    }

    // Wait for landmark photos before generating page images
    if (landmarkFetchPromise) {
      await landmarkFetchPromise;
      const successCount = (visualBible.locations || []).filter(l => l.photoFetchStatus === 'success').length;
      log.info(`🌍 [UNIFIED] Landmark photos ready: ${successCount}/${landmarkCount} fetched successfully`);
    }

    // Wait for reference sheet generation (for secondary element consistency)
    let referenceSheetSourceGrids = null;
    let referenceSheetBatchMeta = null;
    if (referenceSheetPromise) {
      const refResult = await referenceSheetPromise;
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

    // PHASE 5: Generate page images
    // Sequential mode when incremental consistency is enabled, parallel otherwise
    await checkCancellation();
    genLog.setStage('images');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [11, 'Generating page illustrations...', jobId]  // 11 = images start
    );

    timing.pagesStart = Date.now();

    // ── TEXT REFINEMENT, IN PARALLEL WITH IMAGES ──────────────────────────
    // Scenes are locked at this point, so image generation and prose polishing
    // are independent: the refiner receives the scene outlines READ-ONLY and may
    // only rewrite page prose, never events. Running it here costs no wall-clock
    // — images take ~25 min on a 10-page story, refinement ~2-4 min — whereas a
    // pass after images would add its full duration to the total.
    // Never blocks and never throws: a failed refinement leaves the original
    // text in place (startBackgroundRefine swallows and logs).
    // TRIAL SKIPS REFINEMENT (owner 2026-08-15). The "costs no wall-clock"
    // premise above holds only when images take minutes: a trial renders all 5
    // pages in ~15s (Grok, no eval, no repair), so a ~184s polish pass can
    // never finish behind them. Measured on both staging trials: refinement hit
    // the 90s join cap every time and the refined text was DISCARDED — 90s of a
    // ~230s run, plus two rounds of tokens, for nothing.
    const refineEnabled = process.env.TEXT_REFINE !== 'false' && !inputData.trialMode;
    let textRefinePromise = null;
    // Per-page before/after, filled at the join so dev mode can show WHAT the
    // refiner changed rather than only that it ran.
    let textRefineReport = null;
    // The other two review stages' before/after (beats mode only). Same shape,
    // captured inside generateStoryViaBeats at each rewrite; null on the
    // unified path, which has no beats or scene review.
    const beatsReviewReport = beatsResult?.beatsReviewReport || null;
    const clothingReviewReport = beatsResult?.clothingReviewReport || null;
    const sceneReviewReport = beatsResult?.sceneReviewReport || null;
    if (refineEnabled) {
      const { extractRefinablePages, startBackgroundRefine } = require('./server/lib/textRefine');
      const refinablePages = extractRefinablePages(expandedScenes);
      if (refinablePages.length > 0) {
        genLog.info('text_refine_start', `Refining text for ${refinablePages.length} page(s) in parallel with images`);
        textRefinePromise = startBackgroundRefine(inputData, refinablePages, {
          rounds: parseInt(process.env.TEXT_REFINE_ROUNDS || '2', 10),
          usageLabel: 'text_refine',
        });
      }
    }

    let allImages;
    let pipelineEntityReport = null;
    let pipelineEntityHistory = null;
    let pipelineCharFixDetails = null;
    let pipelineStyleConsistency = null;

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

        const sceneCharacters = getCharactersInScene(scene.sceneDescription, inputData.characters);
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
          sceneMetadata
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
        if (sceneMetadata?.framingPattern === 'over-the-shoulder' && pagePhotos.length > 1) {
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
        const pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata);
        let elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
        // Drop location elements when an empty scene background exists — the location
        // is already painted into the background, so a VB grid cell showing the same
        // location is redundant and wastes a reference slot.
        if (sceneBackgrounds[pageNum]) {
          elementReferences = elementReferences.filter(e => e.type !== 'location');
        }
        // Fallback: also match by IDs found in scene hint (covers page mismatch between VB and scene)
        if (sceneMetadata?.fullData) {
          const sceneIds = [];
          // Extract CHR IDs from characters
          for (const char of sceneMetadata.fullData.characters || []) {
            if (char.id && char.id !== 'null') sceneIds.push(char.id);
          }
          // Extract ART/OBJ IDs from objects
          for (const obj of sceneMetadata.fullData.objects || []) {
            const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
            if (id && !id.startsWith('LOC')) sceneIds.push(id);
          }
          if (sceneIds.length > 0) {
            const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds);
            const existingIds = new Set(elementReferences.map(r => r.id));
            const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
            if (newRefs.length > 0) {
              log.info(`🔗 [VB-MATCH] Page ${pageNum}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
              elementReferences = [...elementReferences, ...newRefs].slice(0, 6);
            }
          }
        }
        const secondaryLandmarks = pageLandmarkPhotos.slice(1);
        let visualBibleGrid = null;
        if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
          visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
        }
        // Determine per-page image model based on scene complexity
        const sceneComplexity = sceneMetadata?.sceneComplexity || 'simple';
        const sceneRouting = modelOverrides.sceneRouting || 'auto';
        let pageImageModel, pageImageBackend;

        if (sceneRouting === 'auto') {
          pageImageModel = sceneComplexity === 'complex'
            ? MODEL_DEFAULTS.complexPageImage
            : MODEL_DEFAULTS.simplePageImage;
          pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'gemini';
          log.info(`🎯 [ROUTING] Page ${pageNum}: ${sceneComplexity} → ${pageImageModel} (${pageImageBackend})`);
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

        // Skip Visual Bible text when using Grok (8000 char limit; VB grid sent as reference image)
        const imageModelConfig = IMAGE_MODELS[pageImageModel];
        const isGrokImage = imageModelConfig?.backend === 'grok';
        const imagePrompt = buildImagePrompt(
          scene.sceneDescription, inputData, sceneCharacters, visualBible, pageNum, pagePhotos, { skipVisualBible: isGrokImage }
        );
        // Extract emptyScenePrompt from outline hint (Sonnet-generated, high quality)
        // Falls back to scene expansion's emptyScenePrompt via sceneMetadata
        let outlineEmptyScenePrompt = null;
        try {
          const hintJson = scene.sceneHint || scene.outlineExtract || '';
          if (hintJson.includes('{')) {
            const parsed = JSON.parse(hintJson.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
            outlineEmptyScenePrompt = parsed?.emptyScenePrompt || null;
          }
        } catch { /* not valid JSON — fine */ }

        return {
          pageNumber: pageNum,
          index,
          scene,
          prompt: imagePrompt,
          characterPhotos: pagePhotos,
          landmarkPhotos: pageLandmarkPhotos,
          visualBibleGrid,
          sceneCharacters,
          sceneMetadata,
          perCharClothing,
          pageImageModel,
          pageImageBackend,
          sceneComplexity,
          // Outline-level emptyScenePrompt (from Sonnet) — used if scene expansion doesn't produce one
          emptyScenePrompt: outlineEmptyScenePrompt,
        };
      };

      // Phase 5a: Prepare all page data
      log.info(`📸 [UNIFIED] Phase 5a: Preparing ${expandedScenes.length} pages for image generation...`);
      const pageDataArray = await Promise.all(
        expandedScenes.map((scene, index) => preparePageData(scene, index))
      );

      // Reference-mode + single-pass flags resolved once for the run. Per-page
      // overrides (test-models / iterate) are read in the call sites.
      const runReferenceMode = modelOverrides.referenceMode || MODEL_DEFAULTS.referenceMode || 'strict';
      // Explicit false from the wizard must beat MODEL_DEFAULTS.singlePassScene=true.
      const runSinglePassScene = typeof modelOverrides.singlePassScene === 'boolean'
        ? modelOverrides.singlePassScene
        : MODEL_DEFAULTS.singlePassScene === true;
      log.info(`🎛️ [UNIFIED] referenceMode=${runReferenceMode} singlePassScene=${runSinglePassScene}`);

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
        const { groupPagesByVantage, enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./server/lib/storyHelpers');
        const groups = groupPagesByVantage(pageDataArray, visualBible);
        const realGroups = Array.from(groups.entries()).filter(([key]) => key !== '__unassigned__');
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
            const v = group.vantage;
            // Pull a representative page so we can inherit aspect / model / landmark refs.
            const repPageNum = group.pageNumbers[0];
            const repPageData = pageDataArray.find(pd => pd.pageNumber === repPageNum);
            if (!repPageData) return;
            const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', repPageData.pageImageBackend) || '';
            const layoutAspect = inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect;
            // Vantage canvas is GENERIC — no character-space hints (the canvas
            // serves multiple pages with different cast/positions), no calm-zone
            // (text overlay zone differs per page via spread rule). The per-page
            // image render handles those.
            const eraGuard = buildEraGuard(repPageData.sceneMetadata?.era || null);
            const shotPrefix = v.shot ? `**SHOT:** ${v.shot}\n\n` : '';
            // English-only empty-scene reference: the bare VB location name is
            // story-language and carries no visual info — emit it with the
            // entry's English visual fields inlined (same rule as covers /
            // sanitizeVbIdsInPrompt; docs/decisions.md 2026-07-31).
            const { englishLocationRef } = require('./server/lib/visualBible');
            const locationRef = englishLocationRef(v.location) || v.locationName || '';
            const emptySceneDesc = `${shotPrefix}**LOCATION:** ${locationRef}\n**VANTAGE:** ${v.name || ''}\n\n${v.description || ''}`;
            const characterSpace = `Render this as an empty location backdrop. Foreground, midground and background bands all show the scene's natural ground/floor/water surface continuing unbroken — characters will be composited into them later. No figures, no animals.`;
            // Pull landmark photos for the LOC if real — used as a strict
            // visual reference for the Wikimedia-photo case.
            const landmarkPhotos = (v.location?.isRealLandmark && v.location?.referencePhotoData)
              ? [{ name: v.location.name, photoData: v.location.referencePhotoData, attribution: v.location.photoAttribution, source: v.location.photoSource }]
              : (repPageData.landmarkPhotos || []);
            const { buildLandmarkFidelityBlock } = require('./server/lib/storyHelpers');
            const emptyPrompt = buildEmptyScenePrompt({
              style: artStyleDesc,
              description: emptySceneDesc,
              characterSpace,
              eraGuard,
              // Named fidelity block whenever a landmark photo is attached
              // below — '' otherwise (was trial-only; paid stories shipped
              // the generic unnamed plate prompt).
              landmarkFidelity: buildLandmarkFidelityBlock(landmarkPhotos[0]),
            });
            try {
              const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, repPageNum, landmarkPhotos);
              const emptySceneVbGridDataUrl = emptySceneVbGrid
                ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
                : null;
              const result = await generateImageOnly(emptyPrompt, [], {
                aspectRatio: layoutAspect,
                imageModelOverride: repPageData.pageImageModel,
                imageBackendOverride: repPageData.pageImageBackend,
                landmarkPhotos,
                visualBibleGrid: emptySceneVbGrid,
                pageNumber: repPageNum,
                skipCache: true,
                pageContext: `vantage-${vantageId}`,
              });
              if (result?.usage) {
                const isRunware = result.modelId?.startsWith('runware:');
                const isGrok = result.modelId?.startsWith('grok-imagine');
                const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
                addUsage(provider, result.usage, 'page_images', result.modelId);
              }
              imageGenHeartbeat();  // per-plate heartbeat — keeps the phase alive
              if (!result?.imageData) {
                log.warn(`⚠️ [VANTAGE] ${vantageId} (${v.locationName} – ${v.name}) produced no image`);
                return;
              }
              // Fan out the same canvas to every page in the group.
              for (const pn of group.pageNumbers) {
                if (sceneBackgrounds[pn]) continue; // pre-populated (e.g. trial mode)
                sceneBackgrounds[pn] = {
                  imageData: result.imageData,
                  prompt: emptyPrompt,
                  textAreaMask: null,
                  emptySceneVbGrid: emptySceneVbGridDataUrl,
                  vantageId,
                  vantageName: v.name,
                  locationName: v.locationName,
                };
              }
              log.info(`🏛️ [VANTAGE] ${vantageId} ${v.locationName} – ${v.name}: 1 canvas → pages [${group.pageNumbers.join(',')}]`);
            } catch (err) {
              log.warn(`⚠️ [VANTAGE] ${vantageId} failed: ${err.message}`);
            }
          })));
          const vElapsed = ((Date.now() - vStart) / 1000).toFixed(1);
          const covered = Object.keys(sceneBackgrounds).length;
          log.info(`🏛️ [UNIFIED] Phase 5a-pre-vantage: ${realGroups.length} canvases → ${covered} pages covered in ${vElapsed}s (saved ${Math.max(0, covered - realGroups.length)} redundant generations)`);
        }
      }

      // Phase 5a-pre: Generate empty scene backgrounds (no characters) for style anchoring
      // Note: sceneBackgrounds may already have entries from trial mode early generation
      // OR from Phase 5a-pre-vantage above (vantage canvas covers most pages).
      if (modelOverrides.generateEmptyScenes !== false && !runSinglePassScene) {
        log.info(`🎨 [UNIFIED] Phase 5a-pre: Generating ${pageDataArray.length} empty scene backgrounds...`);
        const bgStartTime = Date.now();
        const bgLimit = pLimit(50);

        const emptyScenes = await Promise.all(
          pageDataArray.map(pageData => bgLimit(async () => {
            await checkCancellation();
            // Skip if already generated (e.g., trial mode early generation from visual bible)
            if (sceneBackgrounds[pageData.pageNumber]) return null;
            const sceneMetadata = pageData.sceneMetadata;
            const settingDesc = sceneMetadata?.setting?.description || sceneMetadata?.imageSummary || '';
            // emptyScenePrompt lives on pageData (from scene expansion), not on sceneMetadata
            const expandedEmptyPrompt = pageData.emptyScenePrompt || sceneMetadata?.emptyScenePrompt || '';
            if (!settingDesc && !expandedEmptyPrompt) return null;

            const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', pageData.pageImageBackend) || '';
            const camera = sceneMetadata?.setting?.camera || 'wide shot';
            const lighting = sceneMetadata?.setting?.lighting || '';
            const weather = sceneMetadata?.setting?.weather || '';

            // Use rich emptyScenePrompt from scene expansion if available, fallback to metadata fields.
            // Prepend a **SHOT:** line — the template ends with "Use the exact camera angle and
            // perspective described above" but Sonnet's emptyScenePrompt prose usually omits shot,
            // so without this prefix the "above" reference is dead text and Grok picks its own
            // angle (often disagreeing with the populated-page angle that uses the same background).
            const shotForCamera = (sceneMetadata?.fullData?.shot || camera || '').trim();
            const shotPrefix = shotForCamera ? `**SHOT:** ${shotForCamera}\n\n` : '';
            const emptySceneDesc = shotPrefix + (expandedEmptyPrompt
              || `**SETTING:** ${settingDesc}\n**CAMERA:** ${camera}${lighting ? `\n**LIGHTING:** ${lighting}` : ''}${weather ? `\n**WEATHER:** ${weather}` : ''}`);

            // Classify each character by depth AND lateral side so the empty scene leaves
            // room in the right band. "Leave space for 2 figures in the far background" is
            // useless when the two figures need to be at opposite edges — Grok will paint
            // buildings flanking both sides and the characters get jammed together later.
            const characters = sceneMetadata?.fullData?.characters || [];
            const buckets = { fgLeft: 0, fgRight: 0, fgCenter: 0, mgLeft: 0, mgRight: 0, mgCenter: 0, bgLeft: 0, bgRight: 0, bgCenter: 0 };
            for (const char of characters) {
              const depth = (char.depth || '').toLowerCase();
              const pos = (char.position || '').toLowerCase();
              const isBg = depth === 'background' || pos.includes('far background') || pos.includes('tiny figure') || pos.includes('background');
              const isMg = !isBg && (depth === 'midground' || pos.includes('midground'));
              const depthKey = isBg ? 'bg' : isMg ? 'mg' : 'fg';
              // Parse lateral side — normalise "center-left"/"left-center" to just "left" etc.
              const isLeft = /\bfar[-\s]?left|\bleft\b/.test(pos) && !/right/.test(pos);
              const isRight = /\bfar[-\s]?right|\bright\b/.test(pos) && !/left/.test(pos);
              const sideKey = isLeft ? 'Left' : isRight ? 'Right' : 'Center';
              buckets[depthKey + sideKey]++;
            }
            const total = (depth) => buckets[depth + 'Left'] + buckets[depth + 'Right'] + buckets[depth + 'Center'];
            let characterSpace = '';
            if (total('fg') + total('mg') + total('bg') > 0) {
              const parts = [];
              const describe = (depth, label) => {
                const L = buckets[depth + 'Left'], R = buckets[depth + 'Right'], C = buckets[depth + 'Center'];
                const t = L + R + C;
                if (t === 0) return;
                const sides = [];
                if (L > 0) sides.push(`${L} on the left`);
                if (R > 0) sides.push(`${R} on the right`);
                if (C > 0) sides.push(`${C} in the center`);
                parts.push(`${t} character${t > 1 ? 's' : ''} in the ${label}${sides.length > 0 ? ` (${sides.join(', ')})` : ''}`);
              };
              describe('fg', 'foreground');
              describe('mg', 'midground');
              describe('bg', 'far background');
              // Frame these bands as scene material that continues unbroken — NOT as
              // "open space" or "leave room", which Grok reads as render-less and
              // resolves with blank patches or half-finished building fragments.
              // The figure will be composited on top later; until then the band must
              // give it FOOTING. "Natural surface" was the old wording — on a river
              // panorama the natural surface at a background band is open water, the
              // plate complied, and the composited figure floated on it.
              characterSpace = `${parts.join(' and ').replace(/^./, c => c.toUpperCase())} will be composited into this scene later. Each of those bands must give its figures FOOTING — a standable surface at that depth (ground, path, bank, floor, deck, walkway, jetty — whatever structure the setting offers) rendered continuing through unbroken. Open water, air, or a drop may fill a figure band only when the scene's figures are in the water or airborne. Lighting and surface texture must continue across the bands. They hold no props, signage, vehicles, or extra structures, but they ARE part of the scene — never blank, white, or unfinished patches, never abrupt building cutoffs.`;

              // If any depth band needs both-sides placement, spell it out so Grok doesn't
              // wall the frame with buildings on left and right.
              const bothSides = ['fg', 'mg', 'bg'].find(d => buckets[d + 'Left'] > 0 && buckets[d + 'Right'] > 0);
              if (bothSides) {
                const label = { fg: 'foreground', mg: 'midground', bg: 'far background' }[bothSides];
                characterSpace += ` Both the far-left and far-right ${label} render as flat continuous ground — no building walls, props, or barriers between the two sides.`;
              }

              // For close-up/medium shots, add explicit space guidance so the empty scene
              // doesn't fill the frame with just furniture (e.g. table surface only)
              const shotType = (sceneMetadata?.fullData?.shot || camera || '').toLowerCase();
              if (shotType.includes('close') || shotType.includes('medium')) {
                characterSpace += ` This is a ${shotType.includes('close') ? 'close-up' : 'medium'} shot — characters will be composited into this scene later. The frame must include enough space for character bodies to be placed naturally.`;
              }
            }

            // Build text area instruction from scene metadata (keeps text area calm in empty scene too)
            // Enforce spread rule: odd pages = left side, even = right side
            const { enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./server/lib/storyHelpers');
            const sonnetTextPos = sceneMetadata?.textPosition || null;
            const textPos = enforceSpreadTextPosition(sonnetTextPos, pageData.pageNumber);
            // If spread rule flipped Sonnet's left/right, Sonnet's textZoneDescription
            // was written for the wrong side — discard it and let the code-generated
            // fallback (generic saturated-surface wording) drive the instruction.
            const sideFlipped = sonnetTextPos && textPos && sonnetTextPos !== textPos;
            const textZoneDesc = sideFlipped ? null : (sceneMetadata?.textZoneDescription || null);
            if (sideFlipped) {
              log.warn(`⚠️ [UNIFIED] Page ${pageData.pageNumber}: Sonnet picked ${sonnetTextPos} against spread rule → flipped to ${textPos}, discarding textZoneDescription`);
            }
            const langLevel = inputData.languageLevel || 'standard';
            // textInImage drives whether we ask the model to keep a calm zone for
            // text overlay AND whether we attach the visual mask reference. When
            // text is rendered below the image (advanced layout), neither is needed.
            const layoutTextInImage = inputData?.layout?.textInImage !== false;
            const layoutAspect = inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect;
            // Load pre-built text area mask (black=text zone ~20%, white=scene ~80%).
            // Sent as a reference slot so the model sees the shape directly.
            const { getTextAreaMask } = require('./server/lib/textMasks');
            const textAreaMask = layoutTextInImage ? getTextAreaMask(textPos, langLevel) : null;

            // Calm-zone instruction for the empty-scene generator. Story text is
            // WHITE and overlaid at textPos, so the zone must render as a saturated,
            // high-contrast surface. Sonnet picks the corner + surface; the code
            // owns wording + spread-rule enforcement.
            const emptyAreaPct = langLevel === '1st-grade' ? '10%' : langLevel === 'advanced' ? '40%' : '30%';
            const emptyTextAreaInstr = (layoutTextInImage && textPos)
              ? buildTextZoneInstruction(textPos, textZoneDesc, emptyAreaPct, { isEmptyScene: true })
              : '';

            const eraGuard = buildEraGuard(sceneMetadata?.era || null);
            // Named fidelity block whenever this page attaches a landmark
            // photo — '' otherwise (was trial-only).
            const { buildLandmarkFidelityBlock } = require('./server/lib/storyHelpers');
            const pageLandmarkFidelity = buildLandmarkFidelityBlock(pageData.landmarkPhotos?.[0]);

            const emptyPrompt = buildEmptyScenePrompt({
              style: artStyleDesc,
              description: emptySceneDesc,
              characterSpace,
              textAreaInstruction: emptyTextAreaInstr,
              eraGuard,
              landmarkFidelity: pageLandmarkFidelity,
            });

            try {
              // Build a FILTERED VB grid for empty-scene generation: vehicles + non-landmark
              // locations only. Characters, animals, and artifacts are excluded — they should
              // appear in the populated page, not in the background, and including them caused
              // doubling (e.g. an artifact rendered both in the empty scene and in the
              // character's hand on the page).
              const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, pageData.pageNumber, pageData.landmarkPhotos || []);
              // Persist the filtered grid as a data URL so the dev UI can show what
              // was actually attached to the empty-scene call (main-scene VB grid is
              // different; before this, the UI was displaying the wrong one).
              const emptySceneVbGridDataUrl = emptySceneVbGrid
                ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
                : null;

              const result = await generateImageOnly(emptyPrompt, [], {
                aspectRatio: layoutAspect,
                imageModelOverride: pageData.pageImageModel,
                imageBackendOverride: pageData.pageImageBackend,
                landmarkPhotos: pageData.landmarkPhotos,
                visualBibleGrid: emptySceneVbGrid,
                textAreaMask,
                pageNumber: pageData.pageNumber,
                skipCache: true
              });
              // Track empty scene token usage
              if (result?.usage) {
                const isRunware = result.modelId?.startsWith('runware:');
                const isGrok = result.modelId?.startsWith('grok-imagine');
                const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
                addUsage(provider, result.usage, 'page_images', result.modelId);
              }
              imageGenHeartbeat();  // per-page heartbeat — keeps the phase alive

              // Validate the empty scene before using it as a background.
              // Phase 1: pixel analysis (white boxes, too dark, text area calmness) — <50ms, free
              // Phase 2: Gemini Flash-lite vision (people, landmark, artifacts) — ~2s, cheap
              // Skipped entirely when layout has no text-in-image: the calm-zone QC
              // checks don't apply, and we save the vision call cost on those pages.
              if (result?.imageData && layoutTextInImage) {
                const { validateEmptyScene } = require('./server/lib/images');
                const textPos = enforceSpreadTextPosition(sceneMetadata?.textPosition || null, pageData.pageNumber);
                // Pass the outline's declared character positions so the vision check
                // can verify each has usable flat ground in the rendered empty scene.
                const placements = (sceneMetadata?.fullData?.characters || [])
                  .filter(c => c?.name && c?.position)
                  .map(c => ({ name: c.name, position: c.position, depth: c.depth }));
                // Derive story era for the anachronism check. Any character marked
                // as costumed with a specific costume type is a strong period signal
                // (e.g. "mittelalterlich" → medieval, "1920s" → early 20th century).
                // Fallback to storyTheme/Topic/Type. If nothing indicates an era,
                // leave null — the vision check will then skip the anachronism gate
                // rather than false-flag a legitimate present-day scene.
                let storyEra = null;
                const costumedTypes = Object.values(streamingClothingRequirements || {})
                  .map(r => r?.costumed?.used && r?.costumed?.costume)
                  .filter(Boolean);
                if (costumedTypes.length > 0) {
                  const themeBits = [inputData.storyTheme, inputData.storyTopic, inputData.storyType].filter(Boolean).join(' / ');
                  storyEra = themeBits ? `${costumedTypes[0]} (${themeBits})` : costumedTypes[0];
                }
                const qc = await validateEmptyScene(result.imageData, textPos, `P${pageData.pageNumber}`, {
                  sceneDescription: emptySceneDesc,
                  characterPlacements: placements.length > 0 ? placements : null,
                  mainScenePrompt: pageData.scene?.sceneDescription || null,
                  storyEra,
                });
                if (!qc.pass) {
                  // Retry with Gemini's feedback appended to the description.
                  // The text-area instruction is rebuilt with the SAME shared
                  // builder and parameters as the first attempt — only the
                  // fixHint differs between the two prompts. (An earlier
                  // comment claimed the retry "softens" the instruction; it
                  // never did.)
                  const fixHint = qc.visionFeedback
                    ? `\n\nIMPORTANT: The previous attempt had this problem: ${qc.visionFeedback}. Fix this in the new version.`
                    : '';
                  const retryTextInstr = textPos
                    ? buildTextZoneInstruction(textPos, textZoneDesc, emptyAreaPct, { isEmptyScene: true })
                    : '';
                  log.info(`🔄 [EMPTY SCENE] P${pageData.pageNumber} failed QC (${qc.issues.join(', ')}), retrying with feedback...`);
                  const retryPrompt = buildEmptyScenePrompt({
                    style: artStyleDesc,
                    description: emptySceneDesc + fixHint,
                    characterSpace,
                    textAreaInstruction: retryTextInstr,
                    eraGuard,
                    landmarkFidelity: pageLandmarkFidelity,
                  });
                  const retryResult = await generateImageOnly(retryPrompt, [], {
                    aspectRatio: layoutAspect,
                    imageModelOverride: pageData.pageImageModel,
                    imageBackendOverride: pageData.pageImageBackend,
                    visualBibleGrid: emptySceneVbGrid,
                    landmarkPhotos: pageData.landmarkPhotos,
                    textAreaMask,
                    pageContext: `empty-P${pageData.pageNumber}-retry`,
                  });
                  if (retryResult?.imageData) {
                    // Validate retry (pixel only — skip vision to avoid double API cost)
                    const retryQc = await validateEmptyScene(retryResult.imageData, textPos, `P${pageData.pageNumber}-retry`, { skipVision: true });
                    if (retryQc.pass) {
                      log.info(`✅ [EMPTY SCENE] P${pageData.pageNumber} retry passed QC`);
                      // Return both versions so they can be compared in dev mode
                      return { pageNumber: pageData.pageNumber, imageData: retryResult.imageData, prompt: retryPrompt, v1ImageData: result.imageData, v1Issues: qc.issues, visionFeedback: qc.visionFeedback, retryPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
                    }
                    log.warn(`⚠️ [EMPTY SCENE] P${pageData.pageNumber} retry also failed pixel QC — picking best of v1/v2`);
                    // Pick whichever version has fewer issues
                    const bestImage = retryQc.issues.length < qc.issues.length ? retryResult.imageData : result.imageData;
                    return { pageNumber: pageData.pageNumber, imageData: bestImage, prompt: retryPrompt, v1ImageData: result.imageData, v1Issues: qc.issues, visionFeedback: qc.visionFeedback, retryPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
                  }
                }
              }

              return { pageNumber: pageData.pageNumber, imageData: result?.imageData || null, prompt: emptyPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
            } catch (err) {
              log.warn(`⚠️ [EMPTY SCENE] Page ${pageData.pageNumber} failed: ${err.message}`);
              return null;
            }
          }))
        );

        for (const bg of emptyScenes) {
          if (bg?.imageData) {
            sceneBackgrounds[bg.pageNumber] = {
              imageData: bg.imageData,
              prompt: bg.prompt,
              textAreaMask: bg.textAreaMask || null,
              emptySceneVbGrid: bg.emptySceneVbGrid || null,
              // Store QC data for dev mode comparison (v1 failed, v2 retry)
              ...(bg.v1ImageData ? {
                v1ImageData: bg.v1ImageData,
                v1Issues: bg.v1Issues,
                visionFeedback: bg.visionFeedback || null,
                retryPrompt: bg.retryPrompt || null,
              } : {}),
            };
          }
        }
        const bgElapsed = ((Date.now() - bgStartTime) / 1000).toFixed(1);
        log.info(`🎨 [UNIFIED] Phase 5a-pre: ${Object.keys(sceneBackgrounds).length}/${pageDataArray.length} empty scenes in ${bgElapsed}s`);
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

      // Liveness heartbeat. progress/updated_at only move as a page STARTS, and
      // all pages start at once — so updated_at freezes for the whole first
      // pass and the status endpoint's 10-minute heartbeat check (jobs.js)
      // declares a perfectly healthy job dead. Observed: a 14-page run killed at
      // 28% while the analyzer was burning 5,776 CPU-seconds of real work.
      // Touching updated_at on a timer says "alive" without faking progress.
      // Progress tracked on COMPLETION, not on start. Every page starts at once,
      // so the old per-start update drove the bar straight to its ceiling (28%)
      // and then sat there for the entire pass — looking hung to the user and to
      // the watchdog. Counting finished pages makes the bar actually move.
      let pagesDone = 0;
      const bumpProgress = () => {
        pagesDone++;
        const pct = 11 + Math.min(19, Math.floor((pagesDone / expandedScenes.length) * 19));
        dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND status = $4',
          [pct, `Illustration ${pagesDone}/${expandedScenes.length} done...`, jobId, 'processing']
        ).catch(err => log.debug(`[PROGRESS] job ${jobId}: ${err.message}`));
      };

      const heartbeat = setInterval(() => {
        dbPool.query('UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = $2', [jobId, 'processing'])
          .catch(err => log.debug(`[HEARTBEAT] job ${jobId}: ${err.message}`));
      }, 60_000);
      heartbeat.unref?.();

      let rawImages;
      try {
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
                emptyScenePrompt: null,
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
            const { decidePageRoute } = require('./server/lib/imageRouter');
            const route = decidePageRoute(pageData, inputData, MODEL_DEFAULTS);
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
            const genResult = await generateImageOnly(
              pageData.prompt,
              refApplied.characterPhotos,
              {
                aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
                imageModelOverride: pageData.pageImageModel,
                imageBackendOverride: pageData.pageImageBackend,
                landmarkPhotos: refApplied.landmarkPhotos,
                visualBibleGrid: refApplied.visualBibleGrid,
                pageNumber: pageData.pageNumber,
                sceneBackground: refApplied.sceneBackground,
                // Text-zone mask only attached when text is overlaid on image
                // (textInImage=true). For square+below layout this is null —
                // the model is free to fill the whole frame.
                textAreaMask: (inputData?.layout?.textInImage !== false)
                  ? (sceneBackgrounds[pageData.pageNumber]?.textAreaMask || null)
                  : null
              }
            );

            // Track usage
            if (genResult.usage) {
              const isRunware = genResult.modelId && genResult.modelId.startsWith('runware:');
              const isGrok = genResult.modelId && genResult.modelId.startsWith('grok-imagine');
              const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, genResult.usage, 'page_images', genResult.modelId);
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
            if (genResult.imageData && pageData.sceneMetadata) {
              try {
                const { needsScaleRepair, runScaleRepair } = require('./server/lib/scaleRepair');
                if (needsScaleRepair(pageData.sceneMetadata)) {
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
                  });
                  if (!compositeCast || !compositeCast.length) {
                    throw new Error('composite cast empty — falling back to the rendered page');
                  }
                  const { backCast, frontCast } = splitCastByStratum(compositeCast);
                  const fdMeta = pageData.sceneMetadata?.fullData || pageData.sceneMetadata || {};
                  const compRes = await generateSceneComposite({
                    compositeStrategy: 'uniform',
                    cast: compositeCast, frontCast, backCast,
                    scene: {
                      description: String(fdMeta.description || pageData.sceneDescription || ''),
                      artStyle: inputData.artStyle || 'watercolor',
                      pageBrief: String(fdMeta.pageBrief || pageData.sceneDescription || ''),
                      interactions: fdMeta.interactions || [],
                      // Per-character expression + attention target, the two
                      // things a pasted avatar cut-out cannot supply (it is
                      // blank-faced and looking at the camera). The page's own
                      // generation prompt is deliberately NOT sent — measured
                      // across nine Lab variants, its staging sections make the
                      // model re-arrange the scene it was asked to preserve.
                      ...buildBlendMetadata(fdMeta, pageData),
                    },
                    cleanBackgroundPrompt: String(pageData.emptyScenePrompt || fdMeta.emptyScenePrompt || ''),
                    aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
                    // Labelled portrait grid as Image 2 — the blend prompt calls it
                    // the authoritative face/clothing reference, and this path was
                    // passing nothing, leaving identity to the pasted pixels alone.
                    visualBibleGridImage: pageData.visualBibleGrid || null,
                    usageTracker: addUsage,
                  });
                  scaleRepairResult = compRes?.imageData
                    ? { imageData: compRes.imageData, modelId: 'scene-composite', prompt: compRes.debug?.populatedPlatePrompt || null, grokRefImages: null, debug: compRes.debug || null }
                    : null;
                }
              } catch (e) {
                log.warn(`⚠️ [SCALE-REPAIR] Page ${pageData.pageNumber} failed: ${e.message}`);
              }
            }

            // Promote the scale-repaired image to the active version when it succeeded.
            // The pre-repair image is preserved as a separate version on the scene.
            const activeImageData = scaleRepairResult?.imageData || genResult.imageData;
            const activeModelId = scaleRepairResult?.modelId || genResult.modelId;

            // Save checkpoint for progressive display
            if (activeImageData) {
              await saveCheckpoint(jobId, 'partial_page', {
                pageNumber: pageData.pageNumber,
                text: pageData.scene.text,
                sceneDescription: pageData.scene.sceneDescription,
                imageData: activeImageData,
                modelId: activeModelId
              }, pageData.pageNumber);
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
              thinkingText: genResult.thinkingText || null,
              usage: genResult.usage,
              prompt: pageData.prompt,
              characterPhotos: pageData.characterPhotos,
              landmarkPhotos: pageData.landmarkPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              grokRefImages: genResult.grokRefImages || null,
              emptySceneImage: emptySceneData?.imageData || null,
              emptyScenePrompt: emptySceneData?.prompt || null,
              textAreaMask: emptySceneData?.textAreaMask || null,
              emptySceneVbGrid: emptySceneData?.emptySceneVbGrid || null,
              emptySceneQc: emptySceneData?.v1Issues ? {
                v1ImageData: emptySceneData.v1ImageData,
                v1Issues: emptySceneData.v1Issues,
                visionFeedback: emptySceneData.visionFeedback || null,
                retryPrompt: emptySceneData.retryPrompt || null,
              } : null,
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene,
              calmRegion,
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
      } finally {
        // Stop the liveness heartbeat whether generation succeeded or threw.
        clearInterval(heartbeat);
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
        const { COVER_HINT_KEY } = require('./server/lib/coverKeys');
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
            const textMode = MODEL_DEFAULTS.appSideCoverType ? 'appOverlay' : 'painted';
            let expectedText = null;
            if (textMode === 'painted') {
              if (coverKey === 'frontCover') {
                expectedText = title || inputData.title || inputData.storyTitle || null;
              } else if (coverKey === 'initialPage') {
                expectedText = coverData.dedication || inputData.dedication || null;
              } else if (coverKey === 'backCover') {
                expectedText = 'magicalstory.ch';
              }
            }
            // Synthetic sceneMetadata from the outline's structured cover hint,
            // so the shared Phase 5b-pre detection and eval enrich see expected
            // character positions + objects exactly like pages do.
            const coverHint = coverHints?.[COVER_HINT_KEY[coverKey]] || null;
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
              prompt: coverData.prompt,
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
      const skipQualityEval = inputData.skipQualityEval === true;

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
        await Promise.all(scenePages.map(async (img) => {
          const preferred = enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber);

          // Caller-supplied retry image generator. Wraps generateImageOnly so
          // ensureCalmZone doesn't import images.js (would be circular).
          const generateImage = (repairPrompt, opts) => generateImageOnly(repairPrompt, img.characterPhotos || [], {
            imageModelOverride: img.sceneMetadata?.pageImageModel || null,
            imageBackendOverride: img.sceneMetadata?.pageImageBackend || null,
            landmarkPhotos: img.landmarkPhotos || [],
            visualBibleGrid: img.visualBibleGrid || null,
            previousImage: opts.previousImage,
            textAreaMask: opts.textAreaMask,
            pageNumber: img.pageNumber,
            skipCache: true,
            aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
          });

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
        }));
        const passed = Object.entries(textRegionResults).filter(([, r]) => r.report.passed).length;
        const repaired = Object.entries(textRegionResults).filter(([, r]) => r.report.retriesUsed > 0).length;
        log.info(`📝 [TEXT-REGION] Processed ${scenePages.length} pages, ${passed} passed, ${repaired} repaired for text space`);
      } catch (trErr) {
        log.warn(`⚠️ [TEXT-REGION] Detection failed: ${trErr.message} — using original images`);
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
          // + objects[].id + landmarkVariants the page render actually used.
          // Without persisting it, the dev panel + downstream consumers had
          // to re-run extractSceneMetadata to recover the per-page VB tags,
          // and the UI showed empty for every trial page even though the
          // JSON description had the IDs all along.
          sceneMetadata: img.sceneMetadata || null,
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          thinkingText: img.thinkingText || null,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid || null,
          grokRefImages: img.grokRefImages || null,
          emptySceneImage: img.emptySceneImage || null,
          emptyScenePrompt: img.emptyScenePrompt || null,
          emptySceneQc: img.emptySceneQc || (sceneBackgrounds[img.pageNumber]?.v1Issues ? {
            v1ImageData: sceneBackgrounds[img.pageNumber]?.v1ImageData || null,
            v1Issues: sceneBackgrounds[img.pageNumber]?.v1Issues || null,
            visionFeedback: sceneBackgrounds[img.pageNumber]?.visionFeedback || null,
            retryPrompt: sceneBackgrounds[img.pageNumber]?.retryPrompt || null,
          } : null),
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
            const { buildClothingDescription } = require('./server/lib/entityConsistency');
            const expectedCharacters = (img.sceneCharacters || []).map(c => {
              const name = c.name || c;
              if (typeof c !== 'object') return { name, description: '' };
              let clothingText = '';
              const category = clothingByName[name];
              if (category) {
                try {
                  clothingText = buildClothingDescription(c, category, artStyle, clothingRequirements || null) || '';
                } catch (e) {
                  log.warn(`⚠️ [BBOX-SHARED] P${img.pageNumber} ${name}: clothing "${category}" did not resolve (${e.message}) — identity line goes without it`);
                }
              }
              return { name, description: c.description || buildCastIdentityDescription(c, clothingText) };
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
            const expectedObjects = Array.isArray(sceneMetadata.objects)
              ? sceneMetadata.objects.filter(o => typeof o === 'string')
              : [];
            img.sharedBboxDetection = await detectAllBoundingBoxes(img.imageData, {
              expectedCharacters,
              expectedObjects,
              sceneContext: img.sceneDescription || null,
              pageContext: `PAGE ${img.pageNumber}`,
              artStyle,
            });
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
          sceneDescriptions: expandedScenes,
          story: fullStoryText,
          storyText: fullStoryText,
          visualBible,
          artStyle: inputData.artStyle,
          language: inputData.language,
          clothingRequirements: clothingRequirements,
          pageClothing: pageClothingData,
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
          coverImages,  // Needed by iterateCover when pipeline redoes low-scoring covers
          coverHints,   // Needed by iterateCover for per-character clothing on covers
          title,
          dedication: inputData.dedication || '',
        };

        const { results: pipelineResult, charFixDetails, styleConsistency } = await runUnifiedRepairPipeline(rawImages, {
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
          qualityModelOverride: modelOverrides.qualityModel,
          useIteratePage: true  // Use iterate (re-expansion) for better redo quality
        });

        // Hoist pipeline data for use outside this block (finalChecksReport)
        pipelineEntityReport = pipelineResult[0]?.entityReport || null;
        pipelineEntityHistory = pipelineResult[0]?.entityHistory || null;
        pipelineCharFixDetails = charFixDetails;
        pipelineStyleConsistency = styleConsistency || null;

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
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          qualityScore: img.qualityScore,
          // The canonical single score (picked version's finalScore). This
          // whitelist mapping predated the scoring unification and silently
          // dropped it — every stored scene had finalScore undefined while
          // qualityScore carried legacy junk.
          finalScore: img.finalScore ?? null,
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
          emptyScenePrompt: img.emptyScenePrompt || null,
          emptySceneQc: img.emptySceneQc || (sceneBackgrounds[img.pageNumber]?.v1Issues ? {
            v1ImageData: sceneBackgrounds[img.pageNumber]?.v1ImageData || null,
            v1Issues: sceneBackgrounds[img.pageNumber]?.v1Issues || null,
            visionFeedback: sceneBackgrounds[img.pageNumber]?.visionFeedback || null,
            retryPrompt: sceneBackgrounds[img.pageNumber]?.retryPrompt || null,
          } : null),
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
          entityReport: img.entityReport || null,
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
          compositeDebug: img.compositeDebug || rawByPage.get(img.pageNumber)?.compositeDebug || null
        }));

        // Extract covers from pipeline results back into coverImages (updated with eval data)
        const COVER_TYPE_MAP = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
        allImages = allImages.filter(img => {
          if (img.pageNumber < 0) {
            const coverKey = COVER_TYPE_MAP[String(img.pageNumber)];
            if (coverKey && coverImages[coverKey]) {
              // Update cover with pipeline eval results
              coverImages[coverKey].qualityScore = img.qualityScore;
              // Covers get the same canonical mirror as scenes (see the
              // sceneImages mapping above). This whitelist dropped finalScore,
              // so every stored cover root had finalScore undefined and
              // database.js fell back to qualityScore — covers and pages
              // ended up carrying different fields for "the score".
              coverImages[coverKey].finalScore = img.finalScore ?? null;
              coverImages[coverKey].qualityReasoning = img.qualityReasoning;
              coverImages[coverKey].fixTargets = img.fixTargets;
              coverImages[coverKey].fixableIssues = img.fixableIssues;
              coverImages[coverKey].semanticResult = img.semanticResult;
              coverImages[coverKey].semanticScore = img.semanticScore;
              coverImages[coverKey].issuesSummary = img.issuesSummary;
              coverImages[coverKey].bboxDetection = img.bboxDetection;
              coverImages[coverKey].bboxOverlayImage = img.bboxOverlayImage;
              // Copy imageVersions if pipeline produced new ones (regen, character fix, or first time)
              if (img.wasRegenerated || img.wasCharacterFixed || !coverImages[coverKey].imageVersions?.length ||
                  (img.imageVersions?.length > (coverImages[coverKey].imageVersions?.length || 0))) {
                coverImages[coverKey].imageVersions = img.imageVersions;
              }
              if (img.imageData) coverImages[coverKey].imageData = img.imageData;
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
    log.debug(`⏱️ [UNIFIED] Page images: ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s, repair phase: ${repairSecs}s`);
    genLog.info('images_complete', `${imgSuccess}/${allImages.length} pages: generation ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s, repair phase (detection/evals/entity/rounds/covers) ${repairSecs}s`);

    // ── JOIN THE PARALLEL TEXT REFINEMENT ─────────────────────────────────
    // Started back at pagesStart; on a normal run it finished long ago and this
    // await returns immediately. Resolves to null on any failure — the original
    // text simply stays.
    //
    // BOUNDED (2026-08-10). This await used to be open-ended, resting on
    // "on a normal run it finished long ago" — an assumption, not a guarantee.
    // The stage already fails safe (null → original text kept) but had no guard
    // against being SLOW: a stalled provider or a retrying round would hold the
    // whole story here, after every image is finished, with a user waiting.
    // Measured normal cost is ~184s against a ~25-min image phase, so anything
    // still running at this point is anomalous. Refinement is a polish pass —
    // shipping the unrefined text is always better than not shipping.
    if (textRefinePromise) {
      const JOIN_TIMEOUT_MS = Number(process.env.TEXT_REFINE_JOIN_TIMEOUT_MS) || 90000;
      const TIMED_OUT = Symbol('text-refine-join-timeout');
      let joinTimer = null;
      const refined = await Promise.race([
        textRefinePromise,
        // NOT unref'd on purpose: an unref'd timer does not keep the loop
        // alive, so if this ever ran somewhere the loop could drain, the race
        // would never settle. `clearTimeout` in the finally below is what stops
        // it leaking, and that runs on both branches.
        new Promise((resolve) => { joinTimer = setTimeout(() => resolve(TIMED_OUT), JOIN_TIMEOUT_MS); }),
      ]).finally(() => { if (joinTimer) clearTimeout(joinTimer); });
      if (refined === TIMED_OUT) {
        log.warn(`⚠️ [TEXT-REFINE] still running ${(JOIN_TIMEOUT_MS / 1000).toFixed(0)}s after images completed — shipping the ORIGINAL text`);
        genLog.warn('text_refine_join_timeout', `Text refinement did not finish within ${(JOIN_TIMEOUT_MS / 1000).toFixed(0)}s of images completing — original text kept`);
      } else if (refined?.changed?.length) {
        // Capture the pre-refine prose BEFORE the overwrite below — it is the
        // only moment both versions exist. Without it the refiner's work is
        // invisible: the story ships the rewritten text with no record of what
        // changed, and 10 of 14 pages were rewritten on the first real run.
        textRefineReport = {
          rounds: refined.rounds.length,
          changedPages: refined.changed,
          durationMs: refined.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0),
          model: refined.rounds[0]?.modelId || refined.rounds[0]?.modelKey || null,
          pages: refined.pages
            .filter(p => refined.changed.includes(p.pageNumber))
            .map(p => ({
              pageNumber: p.pageNumber,
              before: expandedScenes.find(sc => sc.pageNumber === p.pageNumber)?.text || '',
              after: p.text,
            })),
        };
        // BOTH arrays: allImages[].text is a COPY taken when the page was
        // prepared, so updating only the scene would leave the saved story on
        // the pre-refinement prose.
        const byPage = new Map(refined.pages.map(p => [p.pageNumber, p.text]));
        for (const scene of expandedScenes) {
          const t = byPage.get(scene.pageNumber);
          if (t) scene.text = t;
        }
        for (const img of allImages) {
          const t = byPage.get(img.pageNumber);
          if (t) img.text = t;
        }
        const totalMs = refined.rounds.reduce((n, r) => n + (r.elapsedMs || 0), 0);
        genLog.info(
          'text_refine_complete',
          `Text refined in ${refined.rounds.length} round(s), ${(totalMs / 1000).toFixed(1)}s — rewrote page(s) ${refined.changed.join(', ')}`,
          null,
          { rounds: refined.rounds.length, changedPages: refined.changed, durationMs: totalMs }
        );
      } else if (refined) {
        genLog.info('text_refine_complete', 'Text refinement found nothing to rewrite');
      }
    }

    // Wait for cover images if still running (they ran parallel with page images)
    if (coverAwaitPromise) {
      if (!timing.coversEnd) {
        genLog.setStage('covers');
        log.debug(`⏳ [UNIFIED] Waiting for cover images to finish (page images done first)...`);
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [31, 'Finishing cover images...', jobId]  // 31 = covers finishing
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

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiTextCost = calculateCost('gemini_text', tokenUsage.gemini_text.input_tokens, tokenUsage.gemini_text.output_tokens, tokenUsage.gemini_text.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    // Calculate image costs using per-image pricing (not token-based)
    const byFunc = tokenUsage.byFunction;
    const getModels = (func) => Array.from(func.models).join(', ') || func.provider || 'unknown';
    const getCostModel = (func) => func.models?.size > 0 ? Array.from(func.models)[0] : (func.provider || 'anthropic');
    // Per-function cost — the SAME logic the api_usage events use, so the
    // headline totalCost is exactly the sum of the per-call breakdown. The old
    // formula summed provider aggregates + a hardcoded 4-bucket imageCost and
    // dropped every Grok direct-cost bucket (composite, scale_repair, char_fix)
    // — under-reporting the true cost.
    const IMAGE_FN = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed'];
    const functionCost = (funcName, func) => {
      if (!(func?.calls > 0)) return 0;
      if ((func.direct_cost || 0) > 0) return func.direct_cost;
      if (IMAGE_FN.includes(funcName)) return calculateImageCost(getModels(func), func.calls);
      return calculateCost(getCostModel(func), func.input_tokens, func.output_tokens, func.thinking_tokens).total;
    };
    const imageCost = IMAGE_FN.reduce((sum, fn) => sum + (byFunc[fn]?.calls > 0 ? calculateImageCost(getModels(byFunc[fn]), byFunc[fn].calls) : 0), 0);
    const grokDirectCost = tokenUsage.grok?.direct_cost || 0;
    const runwareDirectCost = tokenUsage.runware?.direct_cost || 0;
    // Authoritative total = sum of every per-function cost (== sum of the
    // api_usage events emitted below).
    //
    // Stamp each function's own cost back onto the ledger as `cost`. Without
    // this the value is computed, summed into the headline, and thrown away:
    // `direct_cost` is only set by providers that return a price (Grok,
    // OpenRouter), so every Anthropic and Gemini row persisted as $0 and the
    // "Models used" panel under-reported a 14-page story by $1.10 of $2.60 —
    // Gemini's 740k eval input tokens showed as free. Kept separate from
    // `direct_cost` so "the provider billed us" stays distinguishable from
    // "we computed it from tokens".
    const totalCost = Object.entries(byFunc).reduce((sum, [fn, fd]) => {
      const c = functionCost(fn, fd);
      if (fd && fd.calls > 0) fd.cost = c;
      return sum + c;
    }, 0);

    log.debug(`📊 [UNIFIED] Token usage & cost summary:`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` + ${tokenUsage.anthropic.thinking_tokens.toLocaleString()} think` : '';
    const thinkingTextStr = tokenUsage.gemini_text.thinking_tokens > 0 ? ` + ${tokenUsage.gemini_text.thinking_tokens.toLocaleString()} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` + ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString()} think` : '';
    log.debug(`   Anthropic:      ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr}  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Text:    ${tokenUsage.gemini_text.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_text.output_tokens.toLocaleString().padStart(8)} out${thinkingTextStr}  $${geminiTextCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:   ${tokenUsage.gemini_image.calls} images  $${imageCost.toFixed(4)}`);
    log.debug(`   Gemini Quality: ${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr}  $${geminiQualityCost.total.toFixed(4)}`);
    if (grokDirectCost > 0) {
      log.debug(`   Grok:           ${tokenUsage.grok.calls} images  $${grokDirectCost.toFixed(4)}`);
    }
    if (runwareDirectCost > 0) {
      log.debug(`   Runware:        ${tokenUsage.runware.calls} images  $${runwareDirectCost.toFixed(4)}`);
    }

    // Log by function
    log.debug(`   BY FUNCTION:`);
    // getCostModel + functionCost defined above (shared with totalCost).

    if (byFunc.unified_story?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.unified_story), byFunc.unified_story.input_tokens, byFunc.unified_story.output_tokens, byFunc.unified_story.thinking_tokens);
      const thinkStr = byFunc.unified_story.thinking_tokens > 0 ? ` + ${byFunc.unified_story.thinking_tokens.toLocaleString()} think` : '';
      log.debug(`   Unified Story: ${byFunc.unified_story.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.unified_story.output_tokens.toLocaleString().padStart(8)} out${thinkStr} (${byFunc.unified_story.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.unified_story)}]`);
    }
    if (byFunc.scene_expansion?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_expansion), byFunc.scene_expansion.input_tokens, byFunc.scene_expansion.output_tokens, byFunc.scene_expansion.thinking_tokens);
      log.debug(`   Scene Expand:  ${byFunc.scene_expansion.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_expansion.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_expansion.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_expansion)}]`);
    }
    if (byFunc.scene_iterate?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_iterate), byFunc.scene_iterate.input_tokens, byFunc.scene_iterate.output_tokens, byFunc.scene_iterate.thinking_tokens);
      log.debug(`   Scene Iterate:${byFunc.scene_iterate.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_iterate.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_iterate.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_iterate)}]`);
    }
    if (byFunc.cover_expansion?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_expansion), byFunc.cover_expansion.input_tokens, byFunc.cover_expansion.output_tokens, byFunc.cover_expansion.thinking_tokens);
      log.debug(`   Cover Expand: ${byFunc.cover_expansion.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_expansion.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_expansion.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_expansion)}]`);
    }
    if (byFunc.phantom_patch?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.phantom_patch), byFunc.phantom_patch.input_tokens, byFunc.phantom_patch.output_tokens, byFunc.phantom_patch.thinking_tokens);
      log.debug(`   Phantom Patch:${byFunc.phantom_patch.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.phantom_patch.output_tokens.toLocaleString().padStart(8)} out (${byFunc.phantom_patch.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.phantom_patch)}]`);
    }
    if (byFunc.cover_images?.calls > 0) {
      const model = getModels(byFunc.cover_images);
      const cost = calculateImageCost(model, byFunc.cover_images.calls);
      log.debug(`   Cover Images:  ${byFunc.cover_images.calls} images  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.cover_quality?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images?.calls > 0) {
      const model = getModels(byFunc.page_images);
      const cost = calculateImageCost(model, byFunc.page_images.calls);
      log.debug(`   Page Images:   ${byFunc.page_images.calls} images  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.page_quality?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    if (byFunc.inpaint?.calls > 0) {
      // Grok/Runware bill per-image and report cost as direct_cost, not as tokens.
      // Use direct_cost when present; fall back to token-based for Gemini.
      const directCost = byFunc.inpaint.direct_cost || 0;
      const cost = directCost > 0
        ? { total: directCost }
        : calculateCost(getCostModel(byFunc.inpaint), byFunc.inpaint.input_tokens, byFunc.inpaint.output_tokens, byFunc.inpaint.thinking_tokens);
      log.debug(`   Inpaint:       ${byFunc.inpaint.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.inpaint.output_tokens.toLocaleString().padStart(8)} out (${byFunc.inpaint.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.inpaint)}]`);
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
      [73, 'Finalizing story...', jobId]  // 73 = finalizing
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

    let originalStoryText = null;

    // Log API usage to generationLog BEFORE saving story (so it's included in the saved data)
    genLog.setStage('finalize');
    log.debug(`📊 [UNIFIED] Logging API usage to generationLog. Functions with calls:`);
    let emittedCostSum = 0;
    for (const [funcName, funcData] of Object.entries(byFunc)) {
      log.debug(`   - ${funcName}: ${funcData.calls} calls, ${funcData.input_tokens} in, ${funcData.output_tokens} out, thinking: ${funcData.thinking_tokens || 0}`);
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

    // Compute quality aggregates for analytics
    const qualityScores = allImages
      .map(img => img.qualityScore)
      .filter(s => s != null && !isNaN(s));
    const avgQualityScore = qualityScores.length > 0
      ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
      : null;
    const minQualityScore = qualityScores.length > 0 ? Math.min(...qualityScores) : null;
    const maxQualityScore = qualityScores.length > 0 ? Math.max(...qualityScores) : null;
    const firstAttemptPassRate = allImages.length > 0
      ? Math.round(allImages.filter(img => !img.totalAttempts || img.totalAttempts <= 1).length / allImages.length * 100)
      : null;
    const totalRetries = allImages.reduce((sum, img) => sum + Math.max(0, (img.totalAttempts || 1) - 1), 0);
    const pagesWithIssues = qualityScores.filter(s => s < 70).length;
    const contentBlocked = allImages.reduce((sum, img) =>
      sum + (img.retryHistory?.filter(r => r.blocked)?.length || 0), 0);

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: title,
      titleCandidates: titleCandidates || null, // Full list the model produced; null if legacy single-line TITLE
      storyType: inputData.storyType || '',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
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
      storyTextPrompts: [], // Not used in unified mode (single prompt generates all)
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
      originalStory: originalStoryText || fullStoryText, // Store original AI text for dev mode
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      coverHints: coverHints, // Cover scene hints with per-character clothing from outline
      pageClothing: pageClothingData, // Clothing per page
      clothingRequirements: clothingRequirements, // Per-character clothing requirements
      tokenUsage: JSON.parse(JSON.stringify(tokenUsage, (k, v) => v instanceof Set ? [...v] : v)), // Token usage (Sets to Arrays)
      generationLog: genLog.getEntries(), // Generation log for dev mode
      textRefineReport, // per-page before/after from the parallel refine pass
      beatsReviewReport, // per-page before/after from the beats review (beats mode)
      clothingReviewReport, // per-outfit before/after from the wardrobe review (beats mode)
      sceneReviewReport, // per-page before/after from the scene review (beats mode)
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
        // Quality
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
        pipelineConfig: {
          enableFullRepair,
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
    if (inputData.characters) {
      try {
        const styledAvatarsMap = exportStyledAvatarsForPersistence(inputData.characters, artStyle);
        if (styledAvatarsMap.size > 0) {
          log.debug(`💾 [UNIFIED] Persisting ${styledAvatarsMap.size} styled avatar sets...`);

          // 1. Save to story data (inputData.characters) - IMPORTANT for repair workflow
          for (const char of inputData.characters) {
            const styledAvatars = styledAvatarsMap.get(char.name) || styledAvatarsMap.get(char.name?.trim());
            if (styledAvatars) {
              if (!char.avatars) char.avatars = {};
              if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
              char.avatars.styledAvatars[artStyle] = styledAvatars;
              log.debug(`   ✓ Story data: ${Object.keys(styledAvatars).length} ${artStyle} avatars for "${char.name}"`);
            }
          }

          // 2. Also save to characters table (for character editor)
          const characterId = `characters_${userId}`;
          const charResult = await dbPool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
          if (charResult.rows.length > 0) {
            // Handle both TEXT and JSONB column types
            const rawData = charResult.rows[0].data;
            const charData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
            const chars = charData.characters || [];
            let updatedCount = 0;
            for (const dbChar of chars) {
              // Match by name (trim to handle trailing spaces)
              const styledAvatars = styledAvatarsMap.get(dbChar.name) || styledAvatarsMap.get(dbChar.name?.trim());
              if (styledAvatars) {
                if (!dbChar.avatars) dbChar.avatars = {};
                if (!dbChar.avatars.styledAvatars) dbChar.avatars.styledAvatars = {};
                dbChar.avatars.styledAvatars[artStyle] = styledAvatars;
                updatedCount++;
              }
            }
            if (updatedCount > 0) {
              charData.characters = chars;
              await dbPool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
              log.debug(`💾 [UNIFIED] Updated ${updatedCount} characters in database with ${artStyle} styled avatars`);
            }
          }
        }
      } catch (persistErr) {
        log.error('❌ [UNIFIED] Failed to persist styled avatars:', persistErr.message);
        // Non-fatal - story generation continues
      }
    }

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
        await bakeCoverTypographyPostPersist(storyId, storyData, {
          title: storyData.title || '',
          dedication: storyData.dedication || inputData.dedication || '',
          seed: jobId,
          trial: !!inputData.skipQualityEval,
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
      storyTextPrompts: [], // Not used in unified mode
      story: fullStoryText,  // Frontend expects 'story' not 'storyText'
      visualBible,
      styledAvatarGeneration: getStyledAvatarGenerationLog(),
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(),
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages,
      tokenUsage,
      estimatedCost: totalCost,
      generationMode: 'unified',
      generationLog: genLog.getEntries(),
      finalChecksReport: finalChecksReport || null
    };

    // Mark job as completed
    // Strip ALL base64 image data from result_data to keep it lightweight
    // Images are already saved in story_images table via upsertStory
    // The client only needs metadata from result_data to navigate to the story
    const stripImageData = (img) => {
      if (!img) return img;
      const { imageData, referencePhotos, visualBibleGrid, bboxOverlayImage, ...metadata } = img;
      // Keep referencePhotos metadata but strip actual photo data (rebuild from character avatars on demand)
      const strippedRefPhotos = referencePhotos?.map(p => ({
        name: p.name, photoType: p.photoType, clothingCategory: p.clothingCategory,
        clothingDescription: p.clothingDescription, hasPhoto: !!(p.photoUrl || p.photoData)
      }));
      // landmarkPhotos: bytes are dropped by dropInlineBase64 below (hasPhoto
      // flag set → client lazy-loads from stories.data, which holds R2 URLs).
      // No image bytes are stored in the database — R2 is the only byte store.
      const stripped = { ...metadata, hasImage: !!imageData, hasVisualBibleGrid: !!visualBibleGrid, referencePhotos: strippedRefPhotos };
      // Strip imageData from imageVersions
      if (stripped.imageVersions) {
        stripped.imageVersions = stripped.imageVersions.map(v => {
          const { imageData: vData, ...vMeta } = v;
          return { ...vMeta, hasImage: !!vData };
        });
      }
      // Strip imageData from retryHistory
      if (stripped.retryHistory) {
        stripped.retryHistory = stripped.retryHistory.map(r => {
          const { imageData: rData, ...rMeta } = r;
          return { ...rMeta, hasImage: !!rData };
        });
      }
      return stripped;
    };
    // Strip photo data from visualBible locations
    const strippedVisualBible = resultData.visualBible ? {
      ...resultData.visualBible,
      locations: (resultData.visualBible.locations || []).map(loc => {
        const { referencePhotoData, ...locMeta } = loc;
        return { ...locMeta, hasPhoto: !!referencePhotoData };
      })
    } : resultData.visualBible;
    const resultDataForStorage = {
      ...resultData,
      visualBible: strippedVisualBible,
      sceneImages: allImages.map(stripImageData),
      coverImages: coverImages ? {
        frontCover: stripImageData(coverImages.frontCover),
        initialPage: stripImageData(coverImages.initialPage),
        backCover: stripImageData(coverImages.backCover),
      } : coverImages,
    };
    log.debug(`📊 [UNIFIED] resultData generationLog has ${resultData.generationLog?.length || 0} entries`);
    // Belt-and-suspenders: stripImageData above is an allow-list that only drops
    // imageData — it leaves per-version debug base64 (charRepair*, grokRefImages,
    // inpaintReferenceImages, bboxOverlayImage…) inline. On a repair-heavy story
    // (dozens of repaired versions) that overflows PG's 256MB jsonb array cap on
    // the result_data UPDATE below. result_data is navigation metadata only — no
    // image bytes are needed (they live in story_images) — so drop ANY remaining
    // inline base64 outright.
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
    }

    // Clean up checkpoints immediately - story is saved, no longer needed
    await deleteJobCheckpoints(jobId);

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

    // Send story completion email to customer
    try {
      const userResult = await dbPool.query(
        'SELECT email, username, shipping_first_name, preferred_language, is_trial, claim_token, (trial_data IS NOT NULL) AS has_trial_data FROM users WHERE id = $1',
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

        const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
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
            // Generate a claim token if user doesn't have one
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

    // Try to refund credits on failure. Atomic-claim pattern: zero out
    // credits_reserved in one UPDATE-RETURNING so a later refund attempt
    // (e.g. the outer _processStoryJobImpl catch) reads 0 and short-circuits.
    // The previous SELECT-then-UPDATE chain could double-refund if the
    // status update raced or the SET credits_reserved=0 failed after the
    // user-credits write succeeded.
    try {
      // RETURNING the OLD reserved amount: `RETURNING credits_reserved` after
      // `SET credits_reserved = 0` returns the post-update value (0), so the
      // refund guard `refunded > 0` never fired and refunds silently no-op'd
      // since the atomic-claim refactor. Read the pre-update value via a
      // self-join subquery (snapshot-stable, single statement, still atomic).
      const claim = await dbPool.query(
        `UPDATE story_jobs s
         SET credits_reserved = 0
         FROM (SELECT credits_reserved AS prev, user_id AS uid FROM story_jobs WHERE id = $1) old
         WHERE s.id = $1 AND s.credits_reserved > 0
         RETURNING old.prev AS refunded, s.user_id`,
        [jobId]
      );
      if (claim.rows.length > 0) {
        const { refunded, user_id: refundUserId } = claim.rows[0];
        if (refundUserId && refunded > 0) {
          const upd = await dbPool.query(
            'UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits <> -1 RETURNING credits',
            [refunded, refundUserId]
          );
          if (upd.rows.length > 0) {
            await dbPool.query(
              `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [refundUserId, refunded, upd.rows[0].credits, 'story_refund', jobId, `Full refund: ${refunded} credits - story generation failed`]
            );
            log.info(`💳 [UNIFIED] Refunded ${refunded} credits for failed job ${jobId}`);
          }
        }
      }
    } catch (refundErr) {
      log.error('❌ [UNIFIED] Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [error.message, jobId]
    );

    throw error;
  }
}

// Background worker function to process a story generation job
// NEW STREAMING ARCHITECTURE: Generate images as story batches complete
async function processStoryJob(jobId) {
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
    try {
      return await _processStoryJobImpl(jobId);
    } finally {
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

async function _processStoryJobImpl(jobId) {
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

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility) - includes thinking_tokens for Gemini 2.5
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // OpenRouter-hosted Qwen/DeepSeek (A/B) — token-based.
    // direct_cost carries OpenRouter's ACTUAL charge (usage.cost) when it reports
    // one — throughput-sorted routing can pick a pricier upstream than
    // MODEL_PRICING assumes, so the reported figure beats the estimate.
    openrouter: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0 },
    // Runware/Grok use direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    grok: { direct_cost: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Avatar generation tracking
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Consistency check tracking
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      // Scene rewrite tracking (when safety blocks trigger rewrites)
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Fallback pricing by provider (uses centralized MODEL_PRICING from server/config/models.js)
  // Note: gemini_image uses per-image pricing, not token pricing - see calculateImageCost
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  // Helper to calculate image generation cost (per-image pricing, not token-based)
  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) {
      return pricing.perImage * imageCount;
    }
    // Fallback to default Gemini image pricing
    return 0.04 * imageCount;
  };

  // Helper to add usage - now supports function-level tracking with model names, thinking tokens, and direct costs
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    // Idempotency guard — see the create-story pipeline's addUsage for rationale.
    if (usage && usage.__accounted) return;
    if (usage && typeof usage === 'object') {
      try { Object.defineProperty(usage, '__accounted', { value: true, configurable: true, enumerable: false }); } catch { /* frozen — skip */ }
    }
    if (usage && tokenUsage[provider]) {
      // Handle Runware/Grok (direct cost) vs token-based providers
      if (provider === 'runware' || provider === 'grok') {
        tokenUsage[provider].direct_cost += usage.direct_cost || usage.cost || 0;
        tokenUsage[provider].calls += 1;
      } else {
        tokenUsage[provider].input_tokens += usage.input_tokens || 0;
        tokenUsage[provider].output_tokens += usage.output_tokens || 0;
        tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
        tokenUsage[provider].calls += 1;
      }
    }
    // Also track by function if specified. Auto-create the bucket so any label
    // the text chokepoint emits is captured (never silently dropped).
    if (functionName) {
      if (!tokenUsage.byFunction[functionName]) {
        tokenUsage.byFunction[functionName] = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, elapsed_ms: 0, provider: null, models: new Set() };
      }
      const func = tokenUsage.byFunction[functionName];
      func.input_tokens += usage.input_tokens || 0;
      func.output_tokens += usage.output_tokens || 0;
      func.thinking_tokens += usage.thinking_tokens || 0;
      func.direct_cost = (func.direct_cost || 0) + (usage.direct_cost || 0);
      func.calls += 1;
      // Summed wall-clock, stamped by the text chokepoint (textModels.js).
      func.elapsed_ms = (func.elapsed_ms || 0) + (usage?.elapsed_ms || 0);
      func.provider = provider; // Track actual provider used
      // Coerce to a string id (a mis-wired caller can pass a model object).
      if (modelName) {
        func.models.add(typeof modelName === 'string' ? modelName : (modelName.modelId || modelName.model || String(modelName)));
      }
    }
  };
  // Register this job's sink so every text call records automatically.
  require('./server/lib/usageContext').setUsageSink(addUsage);

  // Helper to calculate cost - uses model-specific pricing if available
  // Thinking tokens are billed at output rate for Gemini 2.5 models
  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    // Try model-specific pricing first, then fall back to provider pricing
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output; // Thinking billed at output rate
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

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
    // truth. Advanced stories → square image + text-below strip; standard
    // and 1st-grade → A4 image + overlay. Without this, buildImagePrompt
    // falls through to its default (textInImage=true) regardless of level.
    try {
      const { resolveLayout } = require('./server/lib/layout');
      inputData.layout = resolveLayout(inputData.languageLevel);
      log.info(`📐 [PROCESS] Layout for level=${inputData.languageLevel}: mode=${inputData.layout.mode}, aspect=${inputData.layout.imageAspect}, textInImage=${inputData.layout.textInImage}`);
    } catch (e) {
      log.warn(`📐 [PROCESS] resolveLayout failed: ${e.message} — layout not stamped`);
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

    // Inject pre-discovered landmarks if available for this user's location.
    // Shared resolver: landmark_index (proximity fallback) -> shared in-memory
    // cache. No live discovery at job start (would block 15s); shuffled so the
    // writer doesn't keep reaching for the same top-scored entries.
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    if (inputData.userLocation?.city && inputData.storyCategory !== 'historical') {
      const { resolveAvailableLandmarks } = require('./server/lib/landmarkPhotos');
      const landmarks = await resolveAvailableLandmarks(inputData.userLocation, {
        limit: 30, discoverOnMiss: false, language: inputData.language, shuffle: true,
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
    if (!isAdmin) {
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
      imageModel: MODEL_DEFAULTS.pageImage,
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
    return await processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableFullRepair, checkCancellation);

  } catch (error) {
    // Clear styled avatar cache on error too
    clearStyledAvatarCache();

    log.error(`❌ Job ${jobId} failed:`, error);

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

    // Full refund if story is not 100% complete. Atomic-claim pattern so a
    // sibling refund path (the inner processUnifiedStoryJob catch above)
    // can't double-refund — whoever zeros credits_reserved first wins.
    try {
      const claim = await dbPool.query(
        `UPDATE story_jobs s
         SET credits_reserved = 0
         FROM (SELECT credits_reserved AS prev, user_id AS uid FROM story_jobs WHERE id = $1) old
         WHERE s.id = $1 AND s.credits_reserved > 0 AND COALESCE(s.progress, 0) < 100
         RETURNING old.prev AS refunded, s.user_id, COALESCE(s.progress, 0) AS progress_percent`,
        [jobId]
      );
      if (claim.rows.length > 0) {
        const { refunded, user_id: refundUserId, progress_percent: progressPercent } = claim.rows[0];
        if (refundUserId && refunded > 0) {
          const upd = await dbPool.query(
            'UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits <> -1 RETURNING credits',
            [refunded, refundUserId]
          );
          if (upd.rows.length > 0) {
            const newBalance = upd.rows[0].credits;
            const description = `Full refund: ${refunded} credits - story generation failed at ${progressPercent}%`;
            await dbPool.query(
              `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [refundUserId, refunded, newBalance, 'story_refund', jobId, description]
            );
            log.info(`💳 Refunded ${refunded} credits for failed job ${jobId} (failed at ${progressPercent}%)`);
          }
        }
      }
    } catch (refundErr) {
      log.error('❌ Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      ['failed', error.message, jobId]
    );

    // Send failure notifications
    try {
      const jobResult = await dbPool.query('SELECT user_id FROM story_jobs WHERE id = $1', [jobId]);
      if (jobResult.rows.length > 0) {
        const userId = jobResult.rows[0].user_id;
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
            const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
            // Prefer story language over DB default (DB defaults to 'English' for trial users)
            const emailLanguage = user.preferred_language || 'en';
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
};
