/**
 * The verification registry's one engine: load a stored run, judge entries
 * against it, and write verdicts back into the registry object.
 *
 * Used by scripts/admin/verify-run.js (CLI: --write, --pull, --mark,
 * --unrecorded) and by server/lib/verifyAutoCheck.js (the staging server judges
 * every story it completes). One module so the two can never disagree about
 * what a verdict means. No dotenv, no pool creation, no git: callers pass those
 * in, so the server (no .git in the container) can require it.
 *
 * WRITE-BACK RULES (applyVerdicts):
 *   CONFIRMED    appended to evidence[]; status -> confirmed
 *   FAILED       appended to evidence[]; status -> failed (add a BACKLOG line)
 *   HUMAN        lastChecked overwritten; status unchanged (stays pending) —
 *                a person looks, then --mark records the verdict
 *   NOT COVERED  lastChecked overwritten; status unchanged
 * STATUS IS THE WORST ACROSS RUNS (2026-10-09): a failed entry stays failed
 * when a later run, automated or human, passes — one passing run among
 * several failing ones proves nothing about the failures (a passing run
 * overwrote three failed ones). Only an explicit --mark=<id>:fixed --note=...
 * (HUMAN-FIXED evidence) returns it to confirmed, after the fix is deployed.
 * A FAILED on a confirmed entry is a regression: evidence + status -> failed.
 * Every judged run is logged once in registry.runs[] (story, env, build,
 * counts). evidence[] is append-only and never takes the same story+result
 * twice; lastChecked is a pointer, not history, so the file stays bounded.
 */
'use strict';

const { checks, evalRunShape } = require('./verify-checks');
const { fromPgNaive } = require('../lib/chTime');

const RESULTS = ['FAILED', 'CONFIRMED', 'HUMAN', 'NOT COVERED'];
const NOTE_MAX = 1500;

/** Status after one more verdict: a failure always wins, a pass never clears a failure (see header). */
function nextStatus(current, passed) {
  if (!passed) return 'failed';
  return current === 'failed' ? 'failed' : 'confirmed';
}

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

/** Every commit taken as present — for a caller without git (the server). --pull re-checks with git. */
const ASSUME_CONTAINED = () => true;

/**
 * A server-stored report re-read with git: a verdict for an entry whose commit
 * the run's build lacks becomes NOT COVERED — the server cannot tell, git can.
 * Entries the report does not hold (registered after that build) are skipped:
 * their commits cannot be in it. Returns [{ e, v }] like judgeAll + verdictOf.
 */
function verdictsFromReport(report, entries, contains) {
  const byId = new Map((report?.verdicts || []).map(v => [v.id, v]));
  const out = [];
  for (const e of entries) {
    const v = byId.get(e.id);
    if (!v) continue;
    if (!report.build) { out.push({ e, v: { id: e.id, result: 'NOT COVERED', why: 'run has no recorded build commit' } }); continue; }
    const missing = [];
    let unknown = null;
    for (const c of e.commits || []) {
      const has = contains(c, report.build);
      if (has === null) { unknown = c; break; }
      if (!has) missing.push(c);
    }
    if (unknown) out.push({ e, v: { id: e.id, result: 'NOT COVERED', why: `cannot resolve ${unknown} or build ${report.build.slice(0, 9)} locally (git fetch?)` } });
    else if (missing.length) out.push({ e, v: { id: e.id, result: 'NOT COVERED', why: `build ${report.build.slice(0, 9)} lacks ${missing.join(', ')}`, oldCode: true, detail: v.detail } });
    else out.push({ e, v });
  }
  return out.sort((a, b) => RESULTS.indexOf(a.v.result) - RESULTS.indexOf(b.v.result));
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
/**
 * A FAILED on a run whose build is an ANCESTOR of a build already CONFIRMED for
 * this entry is old code speaking: later code passed, so the failure is history,
 * not a regression (2026-10-09: a 09-28 report first pulled on 10-09 flipped two
 * entries that 10-03 and 10-09 builds had confirmed). `buildContains(commit,
 * build)` is the caller's git check (true / false / null = unknown); unknown is
 * never superseded, the failure stands.
 */
function supersededByNewerPass(e, run, buildContains) {
  if (typeof buildContains !== 'function' || !run.build) return false;
  return (e.evidence || []).some(x => /CONFIRMED$/.test(String(x.result)) && x.build && x.build !== run.build
    && buildContains(run.build, x.build) === true);
}

function applyVerdicts(reg, run, verdicts, { checkedAt, via, buildContains }) {
  const counts = { CONFIRMED: 0, FAILED: 0, HUMAN: 0, 'NOT COVERED': 0 };
  const flipped = [];
  const stamp = { storyId: run.storyId, env: run.env, build: run.build, runDate: run.runDate, checkedAt };
  for (const { e, v } of verdicts) {
    counts[v.result] += 1;
    if (v.result === 'CONFIRMED' || v.result === 'FAILED') {
      e.evidence = Array.isArray(e.evidence) ? e.evidence : [];
      const dup = e.evidence.some(x => x.storyId === run.storyId && x.env === run.env && x.result === v.result);
      const superseded = v.result === 'FAILED' && supersededByNewerPass(e, run, buildContains);
      if (!dup) e.evidence.push({ ...stamp, result: v.result, ...(superseded ? { superseded: true } : {}), note: noteOf(v) });
      if (superseded) continue; // history only: the status follows the newest build
      const to =nextStatus(e.status, v.result === 'CONFIRMED');
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
  if (!['confirmed', 'failed', 'fixed'].includes(verdict)) throw new Error(`verdict for ${id} must be confirmed, failed or fixed, got "${verdict}"`);
  if (!note || typeof note !== 'string' || !note.trim()) throw new Error(`verdict for ${id} needs a note saying what was looked at and seen`);
  e.evidence = Array.isArray(e.evidence) ? e.evidence : [];
  e.evidence.push({
    storyId: run.storyId, env: run.env, build: run.build, runDate: run.runDate, checkedAt,
    result: `HUMAN-${verdict.toUpperCase()}`, ...(by ? { by } : {}), note: note.trim(),
  });
  e.status = verdict === 'fixed' ? 'confirmed' : nextStatus(e.status, verdict === 'confirmed');
  return e;
}

/**
 * Apply a verdicts file from the review page (scripts/admin/verify-review.js):
 * every confirmed / failed item becomes a markVerdict; undecided items are
 * left alone. Throws on a file for another story, before writing anything.
 * @returns {{ marked: string[], skipped: string[] }}
 */
function applyVerdictsFile(reg, run, file, { checkedAt }) {
  if (!file || file.storyId !== run.storyId) throw new Error(`verdicts file is for ${file?.storyId}, not ${run.storyId}`);
  if (file.env && file.env !== run.env) throw new Error(`verdicts file is for ${file.env}, not ${run.env}`);
  const marked = [];
  const skipped = [];
  const decided = (file.verdicts || []).filter(v => v.verdict === 'confirmed' || v.verdict === 'failed');
  for (const v of decided) {
    if (!reg.entries.some(e => e.id === v.id)) throw new Error(`no entry "${v.id}"`);
    if (!v.note || !String(v.note).trim()) throw new Error(`verdict for ${v.id} needs a note`);
  }
  for (const v of file.verdicts || []) {
    if (v.verdict === 'confirmed' || v.verdict === 'failed') {
      markVerdict(reg, run, { id: v.id, verdict: v.verdict, note: String(v.note), by: v.by || 'owner' }, { checkedAt });
      marked.push(`${v.id}:${v.verdict}`);
    } else skipped.push(v.id);
  }
  return { marked, skipped };
}

// ---------------------------------------------------------------------------
// Images for a human look (scripts/admin/verify-review.js)
// ---------------------------------------------------------------------------

/**
 * Image kinds an entry's check can name in check.images:
 *   pages     the version the book shows, per page
 *   versions  every stored version of each page that has more than one
 *   plates    the empty_scene plate of each page
 *   covers    front cover, dedication page, back cover (latest version)
 *   sheets    each styled avatar sheet generated in the run
 */
const IMAGE_KINDS = ['pages', 'versions', 'plates', 'covers', 'sheets'];

function latestRow(rows, type, pn) {
  return rows.filter(r => r.image_type === type && (pn == null || Number(r.page_number) === pn))
    .sort((a, b) => b.version_index - a.version_index)[0] || null;
}

/** [{ label, url }] for the named kinds; an unknown kind throws (a typo must not show nothing). */
function imagesFor(kinds, ctx) {
  const rows = ctx.images || [];
  const meta = ctx.versionMeta || {};
  const pageNums = [...new Set(rows.filter(r => r.image_type === 'scene' && Number(r.page_number) > 0).map(r => Number(r.page_number)))].sort((a, b) => a - b);
  const out = [];
  for (const k of kinds || []) {
    if (!IMAGE_KINDS.includes(k)) throw new Error(`unknown image kind "${k}" (known: ${IMAGE_KINDS.join(', ')})`);
    if (k === 'pages') {
      for (const pn of pageNums) {
        const active = meta[String(pn)]?.activeVersion;
        const r = active != null
          ? rows.find(x => x.image_type === 'scene' && Number(x.page_number) === pn && Number(x.version_index) === Number(active))
          : latestRow(rows, 'scene', pn);
        if (r) out.push({ label: `p${pn}${active != null ? ` v${active}` : ''}`, url: r.image_url });
      }
    } else if (k === 'versions') {
      for (const pn of pageNums) {
        const vs = rows.filter(r => r.image_type === 'scene' && Number(r.page_number) === pn).sort((a, b) => a.version_index - b.version_index);
        if (vs.length > 1) for (const r of vs) out.push({ label: `p${pn} v${r.version_index}`, url: r.image_url });
      }
    } else if (k === 'plates') {
      for (const pn of pageNums) { const r = latestRow(rows, 'empty_scene', pn); if (r) out.push({ label: `p${pn} plate`, url: r.image_url }); }
    } else if (k === 'covers') {
      for (const t of ['frontCover', 'initialPage', 'backCover']) { const r = latestRow(rows, t, null); if (r) out.push({ label: t, url: r.image_url }); }
    } else if (k === 'sheets') {
      for (const s of ctx.data?.styledAvatarGeneration || []) {
        const url = s?.output?.imageUrl;
        if (url) out.push({ label: `${s.characterName || '?'} sheet${s.clothingCategory ? ` (${s.clothingCategory})` : ''}`, url });
      }
    }
  }
  return out;
}

/** Image URLs a check put in its human instruction. */
function urlsIn(text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s|,)]+?\.(?:jpe?g|png|webp)/gi) || [])];
}

module.exports = {
  RESULTS, ASSUME_CONTAINED, IMAGE_KINDS,
  loadRun, judge, verdictOf, judgeAll, verdictsFromReport, applyVerdicts, recordedStoryIds, nextStatus, markVerdict, noteOf,
  applyVerdictsFile, imagesFor, urlsIn,
};
