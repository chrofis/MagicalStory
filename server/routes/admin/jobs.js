/**
 * Admin Job Management Routes
 *
 * View and retry failed story generation jobs, plus the Test Lab text-only
 * harness (rerun a job's inputs as TEXT ONLY, then LLM-judge the resulting text).
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');
const { judgeStoryText } = require('../../lib/textQualityJudge');

// Server.js-local dependencies received via initJobsRoutes() — same init pattern
// as trial.js / auth.js. `processStoryJob` is the fire-and-forget job runner;
// the rerun-text endpoint below needs it to kick off text-only generation.
let deps = {};
function initJobsRoutes(serverDeps) {
  deps = serverDeps;
}

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/jobs/failed - List failed story jobs from last 7 days
router.get('/failed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const result = await pool.query(`
      SELECT
        j.id,
        j.status,
        j.created_at,
        j.updated_at,
        j.progress,
        j.progress_message,
        j.error_message,
        j.user_id,
        u.username,
        u.email,
        j.input_data->>'storyType' as story_type,
        j.input_data->>'storyCategory' as story_category,
        j.input_data->>'storyTheme' as story_theme,
        j.input_data->>'pages' as pages,
        j.input_data->>'language' as language,
        j.input_data->>'artStyle' as art_style,
        LEFT(j.input_data->>'storyDetails', 200) as story_preview,
        j.input_data->>'dedication' as dedication
      FROM story_jobs j
      LEFT JOIN users u ON j.user_id = u.id
      WHERE j.status = 'failed'
      AND j.created_at > NOW() - INTERVAL '7 days'
      ORDER BY j.created_at DESC
      LIMIT 100
    `);

    log.debug(`[ADMIN] Retrieved ${result.rows.length} failed jobs`);
    res.json({ jobs: result.rows });
  } catch (err) {
    log.error('Error getting failed jobs:', err);
    res.status(500).json({ error: 'Failed to get failed jobs', details: err.message });
  }
});

// POST /api/admin/jobs/:jobId/retry - Create a new job from failed job's input data
router.post('/:jobId/retry', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    // Get original job data
    const jobResult = await pool.query(
      'SELECT * FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const originalJob = jobResult.rows[0];

    // Only allow retry of failed jobs
    if (originalJob.status !== 'failed') {
      return res.status(400).json({
        error: 'Can only retry failed jobs',
        currentStatus: originalJob.status
      });
    }

    const inputData = originalJob.input_data;
    const userId = originalJob.user_id;

    // Create new job ID
    const newJobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    // Insert new job with same input data (no credit charge for admin retry)
    await pool.query(
      `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
       VALUES ($1, $2, 'pending', $3, 0, 'Admin retry - waiting to start...', 0)`,
      [newJobId, userId, JSON.stringify(inputData)]
    );

    log.info(`[ADMIN] Created retry job ${newJobId} from failed job ${jobId} (user: ${userId})`);

    // Return the new job ID - the caller will need to trigger processing
    // We export this so server.js can call processStoryJob
    res.json({
      success: true,
      newJobId,
      originalJobId: jobId,
      userId,
      message: `Created retry job ${newJobId} from failed job ${jobId}`
    });
  } catch (err) {
    log.error('Error retrying job:', err);
    res.status(500).json({ error: 'Failed to retry job', details: err.message });
  }
});

// GET /api/admin/jobs/:jobId - Get full job details including input_data
router.get('/:jobId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    const result = await pool.query(
      `SELECT
        j.*,
        u.username,
        u.email
       FROM story_jobs j
       LEFT JOIN users u ON j.user_id = u.id
       WHERE j.id = $1`,
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];

    // Remove character photos from input_data to reduce response size
    if (job.input_data?.characters) {
      job.input_data.characters = job.input_data.characters.map(c => ({
        ...c,
        photos: c.photos ? {
          hasBody: !!c.photos.body,
          hasFace: !!c.photos.face
        } : null
      }));
    }

    res.json({ job });
  } catch (err) {
    log.error('Error getting job details:', err);
    res.status(500).json({ error: 'Failed to get job details', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Test Lab — text-only harness
//
// Rerun the SAME story inputs as TEXT ONLY (no image generation), then score
// the resulting text on 5 text-only quality criteria via a cross-model LLM
// judge. Generation and judging are SEPARATE endpoints on purpose:
//   - a slow judge never blocks the rerun,
//   - you can re-judge a run (or re-judge with a different model) without
//     regenerating the text.
// Full doc: docs/codebase-guide.md → "Test Lab — text-only story harness".
// ─────────────────────────────────────────────────────────────────────

// POST /api/admin/jobs/:jobId/rerun-text
// Clone a source job's input_data, force skipImages=true, and start N text-only
// runs. Works for ANY source job (not just failed ones, unlike /retry).
// Body (all optional):
//   runs           — number of text variants to generate (default 1, cap 5)
//   judgeModel     — reserved for the caller's bookkeeping; judging happens in
//                    the separate /judge-text endpoint (kept here so a UI can
//                    pass one object through). Not persisted.
//   inputOverrides — shallow-merge object applied over input_data BEFORE insert.
//                    This is the seam for a future outline single-vs-split A/B:
//                    swap a prompt-variant flag (e.g. { outlineMode: 'split' })
//                    WITHOUT needing a new endpoint. Shallow merge only.
router.post('/:jobId/rerun-text', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }
    if (typeof deps.processStoryJob !== 'function') {
      return res.status(500).json({ error: 'Job runner not wired (initJobsRoutes not called)' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    const jobResult = await pool.query('SELECT * FROM story_jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const sourceJob = jobResult.rows[0];

    // Clone input_data (input_data is JSONB → already a JS object from pg).
    const baseInput = { ...(sourceJob.input_data || {}) };

    // Shallow-merge caller overrides (the outline-A/B seam). Applied over the
    // clone so a future experiment can flip a prompt-variant flag with no new
    // endpoint. Shallow by design — nested objects are replaced wholesale.
    const overrides = (req.body && typeof req.body.inputOverrides === 'object' && req.body.inputOverrides)
      ? req.body.inputOverrides : {};
    const inputData = { ...baseInput, ...overrides };

    // Text-only: never generate images/covers.
    inputData.skipImages = true;
    // Strip idempotency so repeated reruns each create a distinct job.
    delete inputData.idempotencyKey;

    const userId = sourceJob.user_id; // reuse original user (matches /retry)

    const runs = Math.min(5, Math.max(1, parseInt(req.body?.runs, 10) || 1));

    const created = [];
    for (let i = 0; i < runs; i++) {
      const newJobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
      await pool.query(
        `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
         VALUES ($1, $2, 'pending', $3, 0, 'Test Lab text-only rerun', 0)`,
        [newJobId, userId, JSON.stringify(inputData)]
      );
      created.push({ jobId: newJobId });

      // Fire-and-forget (same pattern as admin.js /jobs/:jobId/start).
      deps.processStoryJob(newJobId).catch(err => {
        log.error(`❌ [TESTLAB] Text-only rerun job ${newJobId} failed:`, err);
      });
    }

    log.info(`[TESTLAB] Started ${runs} text-only rerun(s) from job ${jobId} (user: ${userId})`);
    res.json({ success: true, runs: created, sourceJobId: jobId });
  } catch (err) {
    log.error('Error starting text-only rerun:', err);
    res.status(500).json({ error: 'Failed to start text-only rerun', details: err.message });
  }
});

// POST /api/admin/jobs/:jobId/rerun-full
// Rerun a job through the WHOLE pipeline — text, images, covers and repair — from
// a source job's stored input. `/retry` refuses anything that is not `failed` and
// `/rerun-text` forces skipImages, so neither can re-run a COMPLETED story to see
// the effect of a prompt or model change end to end. Reuses the source user (the
// characters and avatars live on that account) and reserves 0 credits: this is an
// admin measurement, not a purchase.
// Body (all optional): { inputOverrides } — shallow-merged over the source input.
router.post('/:jobId/rerun-full', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) return res.status(501).json({ error: 'Database mode required' });
    if (typeof deps.processStoryJob !== 'function') {
      return res.status(500).json({ error: 'Job runner not wired (initJobsRoutes not called)' });
    }
    const { jobId } = req.params;
    const pool = getPool();
    const jobResult = await pool.query('SELECT * FROM story_jobs WHERE id = $1', [jobId]);

    // story_jobs is pruned (it keeps only recent rows) while `stories` is the
    // permanent record, so any story worth re-running is usually PAST its job
    // row. Rebuild the commission from the story itself in that case — every
    // field the pipeline reads survives there, and characters are hydrated from
    // the characters table by id anyway.
    let sourceJob;
    if (jobResult.rows.length > 0) {
      sourceJob = jobResult.rows[0];
    } else {
      const st = await pool.query('SELECT id, user_id, data FROM stories WHERE id = $1', [jobId]);
      if (st.rows.length === 0) return res.status(404).json({ error: 'Neither a job nor a story with that id' });
      const d = st.rows[0].data || {};
      sourceJob = {
        user_id: st.rows[0].user_id,
        input_data: {
          pages: d.pages || (d.sceneImages || []).length || undefined,
          language: d.language, languageLevel: d.languageLevel, artStyle: d.artStyle, season: d.season,
          storyType: d.storyType, storyTypeName: d.storyTypeName, storyCategory: d.storyCategory,
          storyTopic: d.storyTopic, storyTheme: d.storyTheme, storyDetails: d.storyDetails,
          dedication: d.dedication, mainCharacters: d.mainCharacters,
          characters: (d.characters || []).map(c => ({ id: c.id, name: c.name })),
          relationships: d.relationships, relationshipTexts: d.relationshipTexts,
          userLocation: d.userLocation,
        },
        _rebuiltFromStory: true,
      };
      log.info(`[ADMIN] Full rerun: job row for ${jobId} is gone — commission rebuilt from the story record`);
    }

    const overrides = (req.body && typeof req.body.inputOverrides === 'object' && req.body.inputOverrides)
      ? req.body.inputOverrides : {};
    const inputData = { ...(sourceJob.input_data || {}), ...overrides };
    delete inputData.idempotencyKey;
    // The point of this endpoint is the FULL pipeline, so the skip flags are
    // cleared even when the source job set them.
    inputData.skipImages = false;
    inputData.skipCovers = false;
    inputData.skipText = false;
    if (inputData.enableFullRepair === undefined) inputData.enableFullRepair = true;

    const newJobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    await pool.query(
      `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
       VALUES ($1, $2, 'pending', $3, 0, 'Admin full rerun', 0)`,
      [newJobId, sourceJob.user_id, JSON.stringify(inputData)]
    );
    deps.processStoryJob(newJobId).catch(err => {
      log.error(`❌ [ADMIN] Full rerun job ${newJobId} failed:`, err);
    });
    log.info(`[ADMIN] Full rerun ${newJobId} from ${jobId} (user ${sourceJob.user_id}, images+covers+repair on)`);
    res.json({ success: true, jobId: newJobId, sourceJobId: jobId, pages: inputData.pages, rebuiltFromStory: !!sourceJob._rebuiltFromStory });
  } catch (err) {
    log.error('Error starting full rerun:', err);
    res.status(500).json({ error: 'Failed to start full rerun', details: err.message });
  }
});

// POST /api/admin/jobs/:jobId/judge-text
// Load a COMPLETED text-only job's result_data (title + pages[].text), score the
// text via the cross-model judge, persist the score back into result_data, and
// return it. Body: { judgeModel? } to override the judge model for this call.
router.post('/:jobId/judge-text', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    const jobResult = await pool.query(
      'SELECT id, status, input_data, result_data FROM story_jobs WHERE id = $1',
      [jobId]
    );
    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    const job = jobResult.rows[0];

    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Job is not completed', currentStatus: job.status });
    }

    const resultData = job.result_data || {};
    const pages = Array.isArray(resultData.pages) ? resultData.pages : [];
    if (pages.length === 0) {
      return res.status(400).json({ error: 'Job result_data has no pages to judge' });
    }

    // Pull target reading level / age hints from the original inputs when present.
    const input = job.input_data || {};
    const language = resultData.language || input.language || null;
    const readingLevel = input.languageLevel || input.readingLevel || null;
    const ageRange = input.ageRange || null;

    const score = await judgeStoryText(
      { title: resultData.title, pages, language, readingLevel, ageRange },
      { judgeModel: req.body?.judgeModel }
    );

    if (!score.success) {
      return res.status(502).json({ error: 'Text judge failed', details: score.error, judgeModel: score.judgeModel });
    }

    // Persist the score back into result_data so it survives (re-judging just
    // overwrites it). jsonb_set on the whole textQualityScore key.
    try {
      await pool.query(
        `UPDATE story_jobs
         SET result_data = jsonb_set(COALESCE(result_data, '{}'::jsonb), '{textQualityScore}', $2::jsonb, true),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [jobId, JSON.stringify(score)]
      );
    } catch (persistErr) {
      // Non-fatal — return the score even if persistence fails.
      log.warn(`[TESTLAB] Could not persist textQualityScore for job ${jobId}: ${persistErr.message}`);
    }

    res.json({ success: true, jobId, ...score });
  } catch (err) {
    log.error('Error judging text:', err);
    res.status(500).json({ error: 'Failed to judge text', details: err.message });
  }
});

module.exports = router;
module.exports.initJobsRoutes = initJobsRoutes;
