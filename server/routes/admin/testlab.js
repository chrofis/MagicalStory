/**
 * Test Lab admin routes — /api/admin/testlab/*
 *
 * Prompt-regression tooling: cross-user story browser, benchmark scene set,
 * per-stage rerun experiments (A/B prompt variants), sandboxed test image
 * versions (story_images.is_test) with an explicit promote action.
 *
 * All endpoints require an admin token. Experiments run in-process,
 * sequentially per experiment (bounded cost, no queue infra); progress is
 * persisted per-target so the UI can poll GET /experiments/:id.
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, setActiveVersion } = require('../../services/database');
const { authenticateToken, requireAdmin } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

const requireDb = (req, res, next) => {
  if (!isDatabaseMode()) return res.status(501).json({ error: 'Database mode required' });
  next();
};

router.use(authenticateToken, requireAdmin, requireDb);

// ─────────────────────────────────────────────────────────────────────
// Recent stories (cross-user)
// ─────────────────────────────────────────────────────────────────────

// GET /api/admin/testlab/stories?page=&limit=&artStyle=&storyType=&language=&search=&days=
router.get('/stories', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];
    // Every '?' in a clause maps to the SAME parameter (postgres allows $n reuse).
    const add = (clause, value) => { params.push(value); where.push(clause.split('?').join(`$${params.length}`)); };

    if (req.query.artStyle) add(`s.data->>'artStyle' = ?`, req.query.artStyle);
    if (req.query.storyType) add(`s.data->>'storyType' = ?`, req.query.storyType);
    if (req.query.language) add(`s.data->>'language' = ?`, req.query.language);
    if (req.query.days) add(`s.created_at > NOW() - (? || ' days')::interval`, String(parseInt(req.query.days) || 30));
    if (req.query.search) add(`(s.data->>'title' ILIKE ? OR u.email ILIKE ?)`, `%${req.query.search.trim()}%`);
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRows = await dbQuery(
      `SELECT COUNT(*) AS total FROM stories s LEFT JOIN users u ON u.id = s.user_id ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0].total);

    const rows = await dbQuery(
      `SELECT s.id, s.user_id, s.created_at,
              s.data->>'title' AS title,
              s.data->>'artStyle' AS art_style,
              s.data->>'storyType' AS story_type,
              s.data->>'language' AS language,
              s.data->>'languageLevel' AS language_level,
              jsonb_array_length(COALESCE(s.data->'sceneImages', '[]'::jsonb)) AS pages,
              u.email, u.username,
              EXISTS(SELECT 1 FROM benchmark_scenes b WHERE b.story_id = s.id) AS has_benchmark
       FROM stories s
       LEFT JOIN users u ON u.id = s.user_id
       ${whereClause}
       ORDER BY s.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      stories: rows.map(r => ({
        id: r.id,
        title: r.title,
        artStyle: r.art_style,
        storyType: r.story_type,
        language: r.language,
        languageLevel: r.language_level,
        pages: r.pages,
        userEmail: r.email,
        username: r.username,
        createdAt: r.created_at,
        hasBenchmark: r.has_benchmark,
      })),
      pagination: {
        page,
        limit,
        totalStories: total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    log.error(`[TESTLAB] stories list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to list stories', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Prompt templates (for override prefill)
// ─────────────────────────────────────────────────────────────────────

const STAGE_TEMPLATE_KEYS = {
  image: 'imageGeneration',
  empty_scene: 'emptyScene',
  quality_eval: 'imageEvaluation',
  semantic_eval: 'imageSemantic',
};

// GET /api/admin/testlab/templates — current template text per overridable stage
router.get('/templates', async (req, res) => {
  try {
    const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../services/prompts');
    await loadPromptTemplates();
    const templates = {};
    for (const [stage, key] of Object.entries(STAGE_TEMPLATE_KEYS)) {
      templates[stage] = PROMPT_TEMPLATES[key] || null;
    }
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load templates', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Benchmark scenes
// ─────────────────────────────────────────────────────────────────────

// GET /api/admin/testlab/benchmark
router.get('/benchmark', async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT b.*, s.data->>'title' AS story_title,
              (s.id IS NULL) AS story_deleted
       FROM benchmark_scenes b LEFT JOIN stories s ON s.id = b.story_id
       ORDER BY b.created_at DESC`
    );
    res.json({
      benchmarks: rows.map(r => ({
        id: r.id,
        storyId: r.story_id,
        pageNumber: r.page_number,
        label: r.label,
        tags: r.tags,
        snapshot: r.snapshot,
        storyTitle: r.story_title,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list benchmarks', details: err.message });
  }
});

// POST /api/admin/testlab/benchmark { storyId, pageNumber, label? }
router.post('/benchmark', async (req, res) => {
  try {
    const { storyId, pageNumber, label } = req.body;
    if (!storyId || !pageNumber) return res.status(400).json({ error: 'storyId and pageNumber required' });

    const { loadSceneContext } = require('../../lib/testlab');
    const ctx = await loadSceneContext(storyId, parseInt(pageNumber, 10));

    const tags = {
      artStyle: ctx.artStyle,
      storyType: ctx.storyType,
      language: ctx.language,
      characterCount: (ctx.scene.sceneCharacters || ctx.referencePhotos || []).length,
      hasLandmark: ctx.landmarkPhotos.length > 0,
    };
    const snapshot = {
      title: ctx.title,
      sceneDescription: ctx.scene.sceneDescription,
      sceneText: ctx.scene.text || null,
      textPosition: ctx.textPosition,
      sceneMetadata: ctx.scene.sceneMetadata || null,
      characterNames: (ctx.scene.sceneCharacters || []).map(c => c.name).filter(Boolean),
      snapshotAt: new Date().toISOString(),
    };

    const rows = await dbQuery(
      `INSERT INTO benchmark_scenes (story_id, page_number, label, tags, snapshot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (story_id, page_number)
       DO UPDATE SET label = COALESCE(EXCLUDED.label, benchmark_scenes.label), tags = EXCLUDED.tags, snapshot = EXCLUDED.snapshot
       RETURNING id`,
      [storyId, pageNumber, label || null, JSON.stringify(tags), JSON.stringify(snapshot)]
    );
    log.info(`[TESTLAB] Benchmark added: ${storyId} P${pageNumber} (id ${rows[0].id})`);
    res.json({ id: rows[0].id, tags, snapshot });
  } catch (err) {
    log.error(`[TESTLAB] add benchmark failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to add benchmark', details: err.message });
  }
});

// DELETE /api/admin/testlab/benchmark/:id
router.delete('/benchmark/:id', async (req, res) => {
  try {
    await dbQuery('DELETE FROM benchmark_scenes WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete benchmark', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Experiments
// ─────────────────────────────────────────────────────────────────────

// In-process guard: one experiment at a time (bounded cost; template swaps stay serialized).
let experimentRunning = false;

async function executeExperiment(experimentId, stage, targets, opts) {
  const { runStageOnTarget } = require('../../lib/testlab');
  experimentRunning = true;
  try {
    for (const target of targets) {
      let entry;
      const startedAt = new Date().toISOString();
      try {
        const result = await runStageOnTarget(stage, target, { ...opts, experimentId });
        entry = { ...target, ok: true, startedAt, ...result };
      } catch (err) {
        log.warn(`[TESTLAB] exp ${experimentId} ${target.storyId} P${target.pageNumber} failed: ${err.message}`);
        entry = { ...target, ok: false, startedAt, error: err.message };
      }
      // Cap stored prompt size so results stay listable.
      if (entry.promptUsed && entry.promptUsed.length > 30000) {
        entry.promptUsed = entry.promptUsed.slice(0, 30000) + '\n…[truncated]';
      }
      await dbQuery(
        `UPDATE testlab_experiments SET results = results || $2::jsonb WHERE id = $1`,
        [experimentId, JSON.stringify([entry])]
      );
    }
    await dbQuery(
      `UPDATE testlab_experiments SET status = 'completed', completed_at = NOW() WHERE id = $1`,
      [experimentId]
    );
    log.info(`[TESTLAB] Experiment ${experimentId} completed (${targets.length} targets)`);
  } catch (err) {
    log.error(`[TESTLAB] Experiment ${experimentId} aborted: ${err.message}`);
    await dbQuery(
      `UPDATE testlab_experiments SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [experimentId, err.message]
    ).catch(() => {});
  } finally {
    experimentRunning = false;
  }
}

// POST /api/admin/testlab/experiments
// body: { stage, label?, promptOverride?, params?, targets?: [{storyId,pageNumber}], benchmarkIds?: [id] }
router.post('/experiments', async (req, res) => {
  try {
    const { stage, label, promptOverride, params, benchmarkIds } = req.body;
    const { STAGES } = require('../../lib/testlab');
    if (!STAGES.includes(stage)) {
      return res.status(400).json({ error: `Invalid stage. Valid: ${STAGES.join(', ')}` });
    }
    if (experimentRunning) {
      return res.status(409).json({ error: 'Another experiment is already running — wait for it to finish' });
    }

    let targets = Array.isArray(req.body.targets) ? req.body.targets : [];
    if (Array.isArray(benchmarkIds) && benchmarkIds.length > 0) {
      const rows = await dbQuery(
        `SELECT story_id, page_number FROM benchmark_scenes WHERE id = ANY($1::int[]) ORDER BY id`,
        [benchmarkIds.map(Number)]
      );
      targets = targets.concat(rows.map(r => ({ storyId: r.story_id, pageNumber: r.page_number })));
    }
    targets = targets
      .map(t => ({ storyId: String(t.storyId), pageNumber: parseInt(t.pageNumber, 10) }))
      .filter(t => t.storyId && Number.isFinite(t.pageNumber));
    if (targets.length === 0) return res.status(400).json({ error: 'No valid targets' });
    if (targets.length > 25) return res.status(400).json({ error: 'Max 25 targets per experiment' });

    const rows = await dbQuery(
      `INSERT INTO testlab_experiments (stage, label, prompt_override, params, status, targets, created_by)
       VALUES ($1, $2, $3, $4, 'running', $5, $6) RETURNING id`,
      [stage, label || null, promptOverride || null, JSON.stringify(params || {}), JSON.stringify(targets), req.user.username || String(req.user.id)]
    );
    const experimentId = rows[0].id;

    // Fire and forget — client polls GET /experiments/:id.
    executeExperiment(experimentId, stage, targets, {
      promptOverride: promptOverride || null,
      params: params || {},
      autoEval: params?.autoEval !== false,
    });

    log.info(`[TESTLAB] Experiment ${experimentId} started: stage=${stage}, targets=${targets.length}, override=${promptOverride ? 'yes' : 'no'}`);
    res.json({ id: experimentId, stage, targets });
  } catch (err) {
    log.error(`[TESTLAB] create experiment failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to create experiment', details: err.message });
  }
});

// GET /api/admin/testlab/experiments
router.get('/experiments', async (req, res) => {
  try {
    const rows = await dbQuery(
      `SELECT id, stage, label, status, created_by, created_at, completed_at,
              (prompt_override IS NOT NULL) AS has_override,
              jsonb_array_length(targets) AS target_count,
              jsonb_array_length(results) AS done_count
       FROM testlab_experiments ORDER BY created_at DESC LIMIT 100`
    );
    res.json({
      experiments: rows.map(r => ({
        id: r.id,
        stage: r.stage,
        label: r.label,
        status: r.status,
        hasOverride: r.has_override,
        targetCount: r.target_count,
        doneCount: r.done_count,
        createdBy: r.created_by,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list experiments', details: err.message });
  }
});

// GET /api/admin/testlab/experiments/:id
router.get('/experiments/:id', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT * FROM testlab_experiments WHERE id = $1', [parseInt(req.params.id, 10)]);
    if (rows.length === 0) return res.status(404).json({ error: 'Experiment not found' });
    const r = rows[0];
    res.json({
      id: r.id,
      stage: r.stage,
      label: r.label,
      status: r.status,
      promptOverride: r.prompt_override,
      params: r.params,
      targets: r.targets,
      results: r.results,
      error: r.error,
      createdBy: r.created_by,
      createdAt: r.created_at,
      completedAt: r.completed_at,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load experiment', details: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Test image serving + promote
// ─────────────────────────────────────────────────────────────────────

// GET /api/admin/testlab/test-image/:storyId/:imageType/:pageNumber/:versionIndex
router.get('/test-image/:storyId/:imageType/:pageNumber/:versionIndex', async (req, res) => {
  try {
    const { loadTestImage } = require('../../lib/testlab');
    const { storyId, imageType } = req.params;
    const pageNumber = parseInt(req.params.pageNumber, 10);
    const versionIndex = parseInt(req.params.versionIndex, 10);
    const img = await loadTestImage(storyId, imageType, Number.isFinite(pageNumber) ? pageNumber : null, versionIndex);
    if (!img || !img.imageData) return res.status(404).json({ error: 'Image not found' });
    res.json({ imageData: img.imageData, isTest: img.isTest, experimentId: img.experimentId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load image', details: err.message });
  }
});

// GET /api/admin/testlab/baseline-image/:storyId/:pageNumber — active user-visible version
router.get('/baseline-image/:storyId/:pageNumber', async (req, res) => {
  try {
    const { loadActivePageImage } = require('../../lib/testlab');
    const imageData = await loadActivePageImage(req.params.storyId, parseInt(req.params.pageNumber, 10));
    res.json({ imageData });
  } catch (err) {
    res.status(404).json({ error: 'Baseline image not found', details: err.message });
  }
});

// POST /api/admin/testlab/promote { storyId, pageNumber, versionIndex, setActive? }
// Flips is_test → the version enters the user-visible version list; optionally
// pins it as the active version (explicit choice ⇒ pinned, per version contract).
router.post('/promote', async (req, res) => {
  try {
    const { storyId, pageNumber, versionIndex, setActive = true } = req.body;
    const pageNum = parseInt(pageNumber, 10);
    const vIdx = parseInt(versionIndex, 10);
    if (!storyId || !Number.isFinite(pageNum) || !Number.isFinite(vIdx)) {
      return res.status(400).json({ error: 'storyId, pageNumber, versionIndex required' });
    }

    const updated = await dbQuery(
      `UPDATE story_images SET is_test = FALSE
       WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3 AND is_test
       RETURNING version_index`,
      [storyId, pageNum, vIdx]
    );
    if (updated.length === 0) return res.status(404).json({ error: 'Test version not found (already promoted?)' });

    // Append a version-metadata entry to the scene's imageVersions in the data
    // blob so the version picker shows provenance. dbVersionIndex stamps the
    // real DB index (never array-position mapping).
    const entry = {
      dbVersionIndex: vIdx,
      versionIndex: vIdx,
      type: 'edit',
      description: 'Promoted from Test Lab',
      createdAt: new Date().toISOString(),
      _alreadySaved: true,
    };
    await dbQuery(
      `UPDATE stories SET data = jsonb_set(
         data,
         ARRAY['sceneImages', s.idx::text, 'imageVersions'],
         COALESCE(data->'sceneImages'->(s.idx::int)->'imageVersions', '[]'::jsonb) || $3::jsonb
       )
       FROM (
         SELECT (ord - 1)::int AS idx
         FROM stories, jsonb_array_elements(data->'sceneImages') WITH ORDINALITY arr(scene, ord)
         WHERE id = $1 AND (scene->>'pageNumber')::int = $2
       ) s
       WHERE id = $1`,
      [storyId, pageNum, JSON.stringify([entry])]
    );

    if (setActive) {
      await setActiveVersion(storyId, pageNum, vIdx, { pinned: true });
    }

    log.info(`[TESTLAB] Promoted ${storyId} P${pageNum} v${vIdx} (setActive=${setActive})`);
    res.json({ success: true, versionIndex: vIdx, setActive });
  } catch (err) {
    log.error(`[TESTLAB] promote failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to promote', details: err.message });
  }
});

module.exports = router;
