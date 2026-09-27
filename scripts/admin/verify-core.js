/**
 * The verification registry's one engine: load a stored run, judge entries
 * against it, and write verdicts back into the registry object.
 *
 * Used by scripts/admin/verify-run.js (CLI: --write, --mark, --unrecorded).
 * No dotenv, no pool creation, no git: callers pass those in.
 *
 * WRITE-BACK RULES (applyVerdicts):
 *   CONFIRMED    appended to evidence[]; status -> confirmed
 *   FAILED       appended to evidence[]; status -> failed (add a BACKLOG line)
 *   HUMAN        lastChecked overwritten; status unchanged (stays pending) —
 *                a person looks, then --mark records the verdict
 *   NOT COVERED  lastChecked overwritten; status unchanged
 * Every judged run is logged once in registry.runs[] (story, env, build,
 * counts). evidence[] is append-only and never takes the same story+result
 * twice; lastChecked is a pointer, not history, so the file stays bounded.
 */
'use strict';

const { checks, evalRunShape } = require('./verify-checks');
const { fromPgNaive } = require('../lib/chTime');

const RESULTS = ['FAILED', 'CONFIRMED', 'HUMAN', 'NOT COVERED'];
const NOTE_MAX = 1500;

/** The stored run as the checks read it. `pool` is any pg-compatible { query }. */
async function loadRun(pool, storyId, env) {
  const s = await pool.query(
    'SELECT id, data, image_version_meta, idea_source, idea_original, idea_used, created_at FROM stories WHERE id = $1',
    [storyId]);
  if (!s.rows[0]) throw new Error(`story ${storyId} not found on ${env}`);
  const images = await pool.query(
    'SELECT image_type, page_number, version_index, image_url FROM story_images WHERE story_id = $1',
    [storyId]);
  let job = null;
  try {
    const j = await pool.query('SELECT status, created_at, completed_at FROM story_jobs WHERE id = $1', [storyId]);
    job = j.rows[0] || null;
  } catch { /* story_jobs rows are reaped over time — the story row is the evidence */ }
  const row = s.rows[0];
  let data = row.data || {};
  if (typeof data === 'string') data = JSON.parse(data);
  return {
    storyId, env,
    data,
    versionMeta: row.image_version_meta || {},
    row: { idea_source: row.idea_source, idea_original: row.idea_original, idea_used: row.idea_used },
    createdAt: fromPgNaive(row.created_at),
    job: job ? { status: job.status, createdAt: fromPgNaive(job.created_at), completedAt: job.completed_at ? fromPgNaive(job.completed_at) : null } : null,
    images: images.rows,
    build: data?.analytics?.build?.commitFull || null,
  };
}

/**
 * Judge one entry against one run. Pure given `contains` (commit, build -> bool|null),
 * so the classification rules are unit-testable without git or a database.
 */
function judge(entry, ctx, contains) {
  const run = () => {
    if (entry.check?.kind === 'auto') {
      const fn = checks[entry.check.fn];
      if (!fn) return { covered: true, pass: null, detail: `no check function "${entry.check.fn}" in verify-checks.js` };
      try { return fn(ctx); } catch (e) { return { covered: true, pass: null, detail: `check threw: ${e.message}` }; }
    }
    return { covered: true, pass: null, detail: 'human check', human: entry.check?.what || '(no instruction)' };
  };

  if (!ctx.build) return { result: 'NOT COVERED', why: 'run has no recorded build commit', r: null };
  const missing = [];
  for (const c of entry.commits || []) {
    const has = contains(c, ctx.build);
    if (has === null) return { result: 'NOT COVERED', why: `cannot resolve ${c} or build ${ctx.build.slice(0, 9)} locally (git fetch?)`, r: null };
    if (!has) missing.push(c);
  }
  if (missing.length) {
    return { result: 'NOT COVERED', why: `build ${ctx.build.slice(0, 9)} lacks ${missing.join(', ')}`, r: run(), oldCode: true };
  }
  const shape = evalRunShape(entry.runShape, ctx);
  if (!shape.ok) return { result: 'NOT COVERED', why: shape.why, r: null };
  const r = run();
  if (!r.covered) return { result: 'NOT COVERED', why: r.detail, r };
  if (r.pass === false) return { result: 'FAILED', r };
  if (r.pass === true && !r.human) return { result: 'CONFIRMED', r };
  return { result: 'HUMAN', r };
}

/** The storable form of one judgement: { id, result, why?, detail?, human? } — plain JSON. */
function verdictOf(entry, j) {
  const v = { id: entry.id, result: j.result };
  if (j.why) v.why = j.why;
  if (j.r?.detail) v.detail = String(j.r.detail).slice(0, NOTE_MAX);
  if (j.r?.human) v.human = String(j.r.human).slice(0, NOTE_MAX);
  if (j.oldCode) v.oldCode = true;
  return v;
}

/** Judge every entry of `entries` against `ctx`; sorted FAILED, CONFIRMED, HUMAN, NOT COVERED. */
function judgeAll(entries, ctx, contains) {
  return entries
    .map(e => ({ e, j: judge(e, ctx, contains) }))
    .sort((a, b) => RESULTS.indexOf(a.j.result) - RESULTS.indexOf(b.j.result));
}

function noteOf(v) {
  return [v.why, v.detail, v.human ? `LOOK: ${v.human}` : null].filter(Boolean).join(' | ').slice(0, NOTE_MAX);
}

/**
 * Write verdicts for one run into the registry object (mutates `reg`).
 * @param run      { storyId, env, build, runDate }
 * @param verdicts [{ e: entry (object inside reg.entries), v: verdictOf(...) }]
 * @param opts     { checkedAt, via: 'write' | 'pull' }
 * @returns        { counts, flipped: [{id, from, to}] }
 */
function applyVerdicts(reg, run, verdicts, { checkedAt, via }) {
  const counts = { CONFIRMED: 0, FAILED: 0, HUMAN: 0, 'NOT COVERED': 0 };
  const flipped = [];
  const stamp = { storyId: run.storyId, env: run.env, build: run.build, runDate: run.runDate, checkedAt };
  for (const { e, v } of verdicts) {
    counts[v.result] += 1;
    if (v.result === 'CONFIRMED' || v.result === 'FAILED') {
      e.evidence = Array.isArray(e.evidence) ? e.evidence : [];
      const dup = e.evidence.some(x => x.storyId === run.storyId && x.env === run.env && x.result === v.result);
      if (!dup) e.evidence.push({ ...stamp, result: v.result, note: noteOf(v) });
      const to = v.result === 'CONFIRMED' ? 'confirmed' : 'failed';
      if (e.status !== to) { flipped.push({ id: e.id, from: e.status, to }); e.status = to; }
    } else {
      e.lastChecked = { ...stamp, result: v.result, note: noteOf(v).slice(0, 400) };
    }
  }
  reg.runs = Array.isArray(reg.runs) ? reg.runs.filter(r => !(r.storyId === run.storyId && r.env === run.env)) : [];
  reg.runs.push({ ...stamp, via, counts });
  return { counts, flipped };
}

/** Every "<env>:<storyId>" the registry has already judged (runs log, evidence, lastChecked). */
function recordedStoryIds(reg) {
  const ids = new Set();
  for (const r of reg.runs || []) ids.add(`${r.env}:${r.storyId}`);
  for (const e of reg.entries || []) {
    for (const x of e.evidence || []) ids.add(`${x.env}:${x.storyId}`);
    if (e.lastChecked) ids.add(`${e.lastChecked.env}:${e.lastChecked.storyId}`);
  }
  return ids;
}

/**
 * Record a person's verdict (Claude or the owner) on one entry for one run.
 * `verdict` is confirmed | failed; `by` names who looked. Appends HUMAN-<VERDICT> evidence.
 */
function markVerdict(reg, run, { id, verdict, note, by }, { checkedAt }) {
  const e = reg.entries.find(x => x.id === id);
  if (!e) throw new Error(`no entry "${id}"`);
  if (!['confirmed', 'failed'].includes(verdict)) throw new Error(`verdict for ${id} must be confirmed or failed, got "${verdict}"`);
  if (!note || typeof note !== 'string' || !note.trim()) throw new Error(`verdict for ${id} needs a note saying what was looked at and seen`);
  e.evidence = Array.isArray(e.evidence) ? e.evidence : [];
  e.evidence.push({
    storyId: run.storyId, env: run.env, build: run.build, runDate: run.runDate, checkedAt,
    result: `HUMAN-${verdict.toUpperCase()}`, ...(by ? { by } : {}), note: note.trim(),
  });
  e.status = verdict;
  return e;
}

module.exports = {
  RESULTS,
  loadRun, judge, verdictOf, judgeAll, applyVerdicts, recordedStoryIds, markVerdict, noteOf,
};
