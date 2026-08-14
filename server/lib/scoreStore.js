/**
 * story_scores persistence — the durable store behind the live /admin/scorecards
 * page. Every scoring path (story_scorecard stage, replay scoreOutput,
 * beats_review_replay, CLI, auto-score hook) calls persistScore so a rerun with
 * a different model/prompt lands next to the others, comparable within one
 * evaluator version. See migrations/016_story_scores.sql.
 */
const { dbQuery } = require('../services/database');
const { log } = require('../utils/logger');

/**
 * Write one score row. Fire-and-forget: a DB failure logs and returns null,
 * never throws, so it cannot break the scoring path that called it.
 * @param {Object} row
 * @param {string} row.storyId
 * @param {string} row.artifact  'full' | 'beats' | 'scene' | 'storyText' | 'visualBible'
 * @param {number} row.score
 * @param {string} row.evalVersion
 */
async function persistScore(row) {
  try {
    if (!row || !row.storyId || !row.artifact) throw new Error('storyId + artifact required');
    await dbQuery(
      `INSERT INTO story_scores
         (story_id, title, language, art_style, artifact, model, judge_model, eval_version, eval_hash, score, dims, source, label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        row.storyId,
        row.title ?? null,
        row.language ?? null,
        row.artStyle ?? null,
        row.artifact,
        row.model ?? null,
        row.judgeModel ?? null,
        row.evalVersion ?? '?',
        row.evalHash ?? null,
        typeof row.score === 'number' ? row.score : null,
        row.dims ? JSON.stringify(row.dims) : null,
        row.source ?? null,
        row.label ?? null,
      ]
    );
    return true;
  } catch (err) {
    log.warn(`⚠️ [SCORE-STORE] persist failed (non-fatal): ${err.message}`);
    return null;
  }
}

/** Persist a full-story scorecard as one 'full' row + one row per artifact. */
async function persistScorecard(storyId, meta, scorecard, { source, model, label } = {}) {
  const stamp = {
    storyId,
    title: meta.title, language: meta.language, artStyle: meta.artStyle,
    judgeModel: scorecard.judgeModel,
    evalVersion: scorecard.evaluatorVersion, evalHash: scorecard.evaluatorHash,
    source, label,
  };
  await persistScore({ ...stamp, artifact: 'full', model: model ?? scorecard.models?.writer ?? null, score: scorecard.overall, dims: scorecard.artifacts });
  for (const [artifact, a] of Object.entries(scorecard.artifacts || {})) {
    await persistScore({ ...stamp, artifact, model: model ?? scorecard.models?.writer ?? null, score: a.score, dims: a.dims, });
  }
}

/** All rows for the page, newest first; optional storyId filter. */
async function queryScores({ storyId = null, limit = 2000 } = {}) {
  const where = storyId ? 'WHERE story_id = $1' : '';
  const params = storyId ? [storyId, limit] : [limit];
  const rows = await dbQuery(
    `SELECT id, story_id, title, language, art_style, artifact, model, judge_model,
            eval_version, eval_hash, score, dims, source, label, created_at
     FROM story_scores ${where} ORDER BY created_at DESC LIMIT $${storyId ? 2 : 1}`,
    params
  );
  return rows;
}

module.exports = { persistScore, persistScorecard, queryScores };
