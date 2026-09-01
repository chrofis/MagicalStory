/**
 * story_scores persistence — the durable store behind the live /admin/scorecards
 * page. Every scoring path (story_scorecard stage, replay scoreOutput, CLI,
 * auto-score hook) calls persistScore so a rerun with a different
 * model/prompt lands next to the others, comparable within one evaluator
 * version. See migrations/016_story_scores.sql. (beats_review_replay was one
 * such source before it was retired 2026-09-01 — its historical rows,
 * source: 'beats_review_replay', are still read here unchanged.)
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
    // round: explicit if the caller knows it (a review pass), else the next
    // number for this (story, part, model, version). Computed in a SEPARATE
    // query, then inserted as a plain value — reusing params across the INSERT
    // values and a subquery makes Postgres deduce inconsistent parameter types.
    let round = typeof row.round === 'number' ? row.round : null;
    if (round == null) {
      const nx = await dbQuery(
        `SELECT COALESCE(MAX(round),0)+1 AS n FROM story_scores
         WHERE story_id=$1 AND artifact=$2 AND model IS NOT DISTINCT FROM $3 AND eval_version=$4`,
        [row.storyId, row.artifact, row.model ?? null, row.evalVersion ?? '?']
      );
      round = Number(nx[0]?.n) || 1;
    }
    await dbQuery(
      `INSERT INTO story_scores
         (story_id, title, language, art_style, artifact, model, judge_model, eval_version, eval_hash, score, dims, notes, artifact_text, source, label, round, gen_cost_usd, gen_ms, judge_cost_usd, judge_ms, chain)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
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
        row.notes ?? null,
        row.artifactText ?? null,
        row.source ?? null,
        row.label ?? null,
        round,
        typeof row.genCost === 'number' ? row.genCost : null,
        typeof row.genMs === 'number' ? row.genMs : null,
        typeof row.judgeCost === 'number' ? row.judgeCost : null,
        typeof row.judgeMs === 'number' ? row.judgeMs : null,
        // the full review chain that produced this round's artifact:
        // {reviewModel, analysis, rewrites:[{page,before,after}], rawResponse?}
        row.chain ? JSON.stringify(row.chain) : null,
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
  const m = model ?? scorecard.models?.writer ?? null;
  await persistScore({ ...stamp, artifact: 'full', model: m, score: scorecard.overall, dims: scorecard.artifacts });
  for (const [artifact, a] of Object.entries(scorecard.artifacts || {})) {
    await persistScore({ ...stamp, artifact, model: m, score: a.score, dims: a.dims, notes: a.notes });
  }
}

/** All rows for the page, newest first; optional storyId filter. */
async function queryScores({ storyId = null, limit = 2000 } = {}) {
  const where = storyId ? 'WHERE story_id = $1' : '';
  const params = storyId ? [storyId, limit] : [limit];
  const rows = await dbQuery(
    `SELECT id, story_id, title, language, art_style, artifact, model, judge_model,
            eval_version, eval_hash, score, dims, notes, artifact_text, round, source, label,
            gen_cost_usd, gen_ms, judge_cost_usd, judge_ms, chain, created_at
     FROM story_scores ${where} ORDER BY created_at DESC LIMIT $${storyId ? 2 : 1}`,
    params
  );
  return rows;
}

/** Specific rows by id — used to re-judge a stored round's frozen artifact text. */
async function getScoresByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  return dbQuery(
    `SELECT id, story_id, title, language, art_style, artifact, model, judge_model,
            eval_version, score, artifact_text, round, label
     FROM story_scores WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids]
  );
}

/** Archive a judge prompt for a version so the page can show it (click a version). */
async function upsertEvalVersion(version, hash, promptText) {
  try {
    if (!version) return null;
    await dbQuery(
      `INSERT INTO eval_versions (version, hash, prompt_text) VALUES ($1,$2,$3)
       ON CONFLICT (version) DO UPDATE SET hash = EXCLUDED.hash, prompt_text = EXCLUDED.prompt_text`,
      [version, hash ?? null, promptText ?? null]
    );
    return true;
  } catch (err) {
    log.warn(`⚠️ [SCORE-STORE] eval_versions upsert failed (non-fatal): ${err.message}`);
    return null;
  }
}

/** The archived prompt for a version (for the drill-down). */
async function getEvalVersion(version) {
  const rows = await dbQuery('SELECT version, hash, prompt_text, created_at FROM eval_versions WHERE version = $1', [version]);
  return rows[0] || null;
}

module.exports = { persistScore, persistScorecard, queryScores, getScoresByIds, upsertEvalVersion, getEvalVersion };
