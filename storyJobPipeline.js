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
const { upsertStory } = require('./server/services/database');
const { extractPageClothing } = require('./server/lib/storyHelpers');

// --- Injected by initStoryJobPipeline(), called from server.js after the DB
// --- pool is created. Defaults mirror server.js's file-mode fallbacks so the
// --- checkpoint guards early-return safely if init never runs (file mode).
let dbPool = null;
let STORAGE_MODE = 'file';
let userLandmarkCache = new Map();
let LANDMARK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week (overridden by init)

function initStoryJobPipeline(deps) {
  dbPool = deps.dbPool;
  STORAGE_MODE = deps.STORAGE_MODE;
  userLandmarkCache = deps.userLandmarkCache;
  LANDMARK_CACHE_TTL = deps.LANDMARK_CACHE_TTL;
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

module.exports = {
  initStoryJobPipeline,
  saveCheckpoint,
  getCheckpoint,
  getAllCheckpoints,
  deleteJobCheckpoints,
  savePartialStoryFromCheckpoints,
};
