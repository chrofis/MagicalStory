#!/usr/bin/env node
/**
 * Judge one stored story run against the verification registry (tasks/verify.json).
 *
 * WHY (owner, 2026-09-24): "we do 20 changes that need a new story. When we
 * rerun it we should ensure if all 20 are tested or not." Before this, "which
 * shipped changes did that run actually prove?" was answered by re-reading
 * commits. Now each change that needs a run is a registry entry with a claim,
 * the run shape that can exercise it and a check, and this script answers per
 * entry:
 *
 *   CONFIRMED    the stored run shows the claim holding
 *   FAILED       the stored run shows it NOT holding (loud)
 *   HUMAN        the data cannot decide alone — what to look at, with page URLs
 *   NOT COVERED  the run could not exercise it: its build lacks the commit, or
 *                the run shape is absent (no OTS page, no iterate repair, ...).
 *                Never counted as a pass.
 *
 * THE RULE (owner, 2026-09-27): after EVERY verification story run, run this
 * with --write and commit tasks/verify.json. The pre-push hook warns (never
 * blocks) while a staging run since 2026-09-24 has not been recorded
 * (--unrecorded). What --write records is defined once in verify-core.js
 * applyVerdicts: CONFIRMED / FAILED append evidence and set the status;
 * HUMAN / NOT COVERED only move the entry's lastChecked pointer (it stays
 * pending); the run is logged in registry.runs[].
 *
 * BUILD, NOT DATE. A run is only evidence for a commit its build CONTAINS:
 * stories.data.analytics.build.commitFull (recorded since 2026-09-14) must have
 * every entry commit as an ancestor (`git merge-base --is-ancestor`). A run with
 * no recorded build is NOT COVERED — never guessed from timestamps. For an entry
 * the build lacks, the check still runs and is printed as "old code:" so a
 * pre-change run shows the check can see the old state.
 *
 * Usage:
 *   node scripts/admin/verify-run.js <storyId> [--env=staging|prod] [--write] [--all]
 *   node scripts/admin/verify-run.js <storyId> --mark=<entryId>:confirmed|failed|fixed --note="what you saw" [--by=claude|owner] [--env=...]
 *   node scripts/admin/verify-run.js <storyId> --apply=<verdicts.json> [--env=...]  # verdicts from the review page (verify-review.js)
 *   node scripts/admin/verify-run.js --pull [--all] [--story=<id>[,<id>]]  # write the reports the staging server stored (--story re-pulls recorded runs)
 *   node scripts/admin/verify-run.js --unrecorded       # staging runs not yet judged into the registry (warns)
 *   node scripts/admin/verify-run.js --list
 *
 * AUTO-CHECK (2026-09-27): the staging server judges every story it completes
 * (server/lib/verifyAutoCheck.js, same engine) into story_verify_reports. It
 * has no git, so --pull re-checks each entry's commits against the run's build
 * before writing — a report verdict for a commit the build lacks is NOT COVERED.
 *
 *   --write  record the verdicts (rules above).
 *   --all    also judge entries that are already confirmed or failed (regression read).
 *   --pull judges pending entries, and ALSO confirmed/failed ones but records only a FAILED there
 *            (a regression on a confirmed entry); --story=<id> re-pulls an already recorded run.
 *   status is the worst across runs: a pass never clears a failed entry; `--mark=<id>:fixed` does.
 *   --mark   record a person's verdict for one entry on this run (writes).
 *
 * Reads: stories (data, image_version_meta, idea columns), story_images
 * (urls only, never image_data), story_jobs (status/timestamps). No model call.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { ch, fromPgNaive } = require('../lib/chTime');
const core = require('./verify-core');

const REGISTRY = path.join(ROOT, 'tasks', 'verify.json');
// The registry started judging runs on this day; older runs predate every entry.
const REGISTRY_SINCE = '2026-09-24';

function arg(name) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

function loadRegistry() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (!Array.isArray(reg.entries)) throw new Error('tasks/verify.json has no entries[]');
  return reg;
}

function saveRegistry(reg) {
  fs.writeFileSync(REGISTRY, `${JSON.stringify(reg, null, 2)}\n`);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** true / false, or null when git cannot say (commit unknown locally). */
function buildContains(commit, build) {
  try { git(['merge-base', '--is-ancestor', commit, build]); return true; } catch (e) {
    if (e.status === 1) return false;
    return null;
  }
}

function openPool(env) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const url = env === 'prod'
    ? (process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL)
    : process.env.STAGING_DATABASE_URL;
  if (!url) throw new Error(env === 'prod' ? 'DATABASE_URL not set' : 'STAGING_DATABASE_URL not set');
  const { Pool } = require('pg');
  return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2, connectionTimeoutMillis: 8000 });
}

function printRow(e, v) {
  console.log(`${v.result.padEnd(11)} ${e.id}  — ${e.title}`);
  if (v.why) console.log(`            ${v.why}`);
  if (v.result === 'NOT COVERED') {
    if (v.oldCode && v.detail) console.log(`            old code: ${v.detail}`);
    return;
  }
  if (v.detail) console.log(`            ${v.detail}`);
  if (v.human) console.log(`            LOOK: ${v.human}`);
}

/** "old code:" reading for a build that lacks the commit — PASS / FAIL / undecided. */
function oldCodeDetail(j) {
  if (!j.oldCode || !j.r) return null;
  const verdict = j.r.covered === false ? 'not exercised' : j.r.pass === true ? 'PASS' : j.r.pass === false ? 'FAIL' : 'undecided';
  return `${verdict} — ${j.r.detail}`;
}

/** Staging stories since REGISTRY_SINCE that carry a build and are not yet judged into the registry. */
async function unrecorded(pool, reg) {
  const r = await pool.query(
    `SELECT id, created_at, data->'analytics'->'build'->>'commitFull' AS build, (data->>'trialMode') AS trial
       FROM stories
      WHERE created_at >= $1
        AND data->'analytics'->'build'->>'commitFull' IS NOT NULL
        AND COALESCE(data->>'isPartial', 'false') <> 'true'
      ORDER BY created_at`, [REGISTRY_SINCE]);
  const seen = core.recordedStoryIds(reg);
  return r.rows.filter(x => !seen.has(`staging:${x.id}`));
}

/**
 * --pull: write the reports the staging server stored (story_verify_reports,
 * server/lib/verifyAutoCheck.js) for every run the registry has not recorded.
 * Containment is re-checked here with git — the server cannot.
 */
async function pull(env) {
  const reg = loadRegistry();
  const pool = openPool(env);
  let rows;
  try {
    rows = (await pool.query('SELECT story_id, build, report, created_at FROM story_verify_reports ORDER BY created_at')).rows;
  } finally { await pool.end(); }
  const seen = core.recordedStoryIds(reg);
  const only = arg('story') && arg('story') !== true ? new Set(String(arg('story')).split(',')) : null;
  const fresh = rows.filter(r => only ? only.has(r.story_id) : !seen.has(`${env}:${r.story_id}`));
  if (!fresh.length) { console.log(`verify-run --pull: all ${rows.length} stored ${env} report(s) are already recorded in tasks/verify.json`); return; }
  const checkedAt = ch(new Date());
  const allFailed = [];
  for (const r of fresh) {
    const report = typeof r.report === 'string' ? JSON.parse(r.report) : r.report;
    const targets = reg.entries.filter(e => ['pending', 'confirmed', 'failed'].includes(e.status));
    const verdicts = core.verdictsFromReport(report, targets, buildContains)
      .filter(({ e, v }) => e.status === 'pending' || arg('all') || v.result === 'FAILED');
    const run = { storyId: r.story_id, env, build: report.build || null, runDate: report.runAt ? ch(new Date(report.runAt)) : null };
    console.log(`\n${r.story_id} (${env}) — run ${run.runDate || '?'}, build ${run.build ? run.build.slice(0, 9) : 'UNRECORDED'}`);
    for (const { e, v } of verdicts) if (v.result !== 'NOT COVERED') printRow(e, v);
    const { counts, flipped } = core.applyVerdicts(reg, run, verdicts, { checkedAt, via: 'pull' });
    console.log(`  ${counts.CONFIRMED} CONFIRMED, ${counts.FAILED} FAILED, ${counts.HUMAN} HUMAN, ${counts['NOT COVERED']} NOT COVERED`
      + `${flipped.length ? ` — status changed: ${flipped.map(f => `${f.id} ${f.from}->${f.to}`).join(', ')}` : ''}`);
    for (const { e, v } of verdicts) if (v.result === 'FAILED') allFailed.push(`${e.id} on ${r.story_id}`);
  }
  saveRegistry(reg);
  if (allFailed.length) {
    console.log(`\n!!! ${allFailed.length} FAILED: ${allFailed.join(', ')}`);
    console.log('!!! Investigate each, and add a tasks/BACKLOG.md line for it.');
  }
  console.log(`\n${fresh.length} run(s) written to tasks/verify.json. Next: review the HUMAN entries (verify-review.js <storyId>), then`);
  console.log('commit it: git commit -m "chore(verify): verdicts from <storyIds>" -- tasks/verify.json');
}

async function main() {
  if (process.argv.includes('--list')) {
    const reg = loadRegistry();
    for (const e of reg.entries) {
      console.log(`${(e.status || '?').padEnd(10)} ${(e.check?.kind || '?').padEnd(5)} ${e.id}  [${(e.runShape || []).join(', ')}]  ${e.title}`);
    }
    return;
  }

  if (process.argv.includes('--unrecorded')) {
    // Pre-push warning: never blocks, never throws past this point. The registry
    // is read from the COMMITTED HEAD of the tree being pushed (the hook runs the
    // main clone's copy of this script, possibly for another worktree), so an
    // uncommitted --write does not silence the warning.
    let pool;
    try {
      const reg = JSON.parse(execFileSync('git', ['show', 'HEAD:tasks/verify.json'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
      pool = openPool('staging');
      const rows = await unrecorded(pool, reg);
      if (!rows.length) { console.log('verify-registry: every staging run since 2026-09-24 is recorded in tasks/verify.json'); return; }
      console.log('');
      console.log(`verify-registry: WARNING — ${rows.length} staging run(s) not yet judged into tasks/verify.json:`);
      for (const x of rows) console.log(`  ${x.id}  ${ch(fromPgNaive(x.created_at))}  build ${String(x.build).slice(0, 9)}${x.trial === 'true' ? '  (trial)' : ''}`);
      console.log('  Record them: node scripts/admin/verify-run.js --pull (the reports the staging server stored)');
      console.log('           or: node scripts/admin/verify-run.js <storyId> --write — then commit tasks/verify.json');
      console.log('  (a warning only — this does not block the push)');
    } catch (e) {
      console.log(`verify-registry: unrecorded-run check skipped (${e.message})`);
    } finally {
      if (pool) await pool.end().catch(() => {});
    }
    return;
  }

  if (process.argv.includes('--pull')) {
    await pull(arg('env') || 'staging');
    return;
  }

  const storyId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!storyId) {
    console.error('Usage: node scripts/admin/verify-run.js <storyId> [--env=staging|prod] [--write] [--all] | --mark=<id>:confirmed|failed|fixed --note="..." | --unrecorded | --list');
    process.exit(2);
  }
  const env = arg('env') || 'staging';
  if (!['staging', 'prod'].includes(env)) throw new Error(`--env must be staging or prod, got ${env}`);
  const write = !!arg('write');
  const mark = arg('mark');

  const reg = loadRegistry();
  const pool = openPool(env);
  let ctx;
  try { ctx = await core.loadRun(pool, storyId, env); } finally { await pool.end(); }
  const checkedAt = ch(new Date());
  const run = { storyId, env, build: ctx.build, runDate: ch(ctx.job?.createdAt || ctx.createdAt) };

  console.log(`\nverify-run: ${storyId} (${env}) — run ${run.runDate}, build ${ctx.build ? ctx.build.slice(0, 9) : 'UNRECORDED'}, `
    + `${ctx.data.trialMode ? 'trial' : 'full story'}, ${(ctx.data.sceneImages || []).length} pages, job ${ctx.job?.status || 'row gone'}\n`);

  if (mark) {
    const [id, verdict] = String(mark).split(':');
    const note = arg('note');
    const by = arg('by');
    const marked = core.markVerdict(reg, run, { id, verdict, note: note === true ? '' : note, by: by === true ? null : by }, { checkedAt });
    if (verdict === 'confirmed' && marked.status === 'failed') console.log(`${id} stays FAILED (a pass does not clear a failure) — once the fix is deployed: --mark=${id}:fixed --note="..."`);
    saveRegistry(reg);
    console.log(`marked ${id} ${verdict} on ${storyId}`);
    return;
  }

  const apply = arg('apply');
  if (apply) {
    if (apply === true) throw new Error('--apply needs a file: --apply=<verify-verdicts-<storyId>.json>');
    const file = JSON.parse(fs.readFileSync(apply, 'utf8'));
    const { marked, skipped } = core.applyVerdictsFile(reg, run, file, { checkedAt });
    saveRegistry(reg);
    console.log(`applied ${marked.length} verdict(s): ${marked.join(', ') || 'none'}${skipped.length ? `; not decided: ${skipped.join(', ')}` : ''}`);
    console.log('Commit it: git commit -m "chore(verify): review verdicts on <storyId>" -- tasks/verify.json');
    return;
  }

  const targets = reg.entries.filter(e => e.status === 'pending' || (arg('all') && ['confirmed', 'failed'].includes(e.status)));
  const judged = core.judgeAll(targets, ctx, buildContains).map(({ e, j }) => {
    const v = core.verdictOf(e, j);
    const old = oldCodeDetail(j);
    if (old) v.detail = old;
    return { e, v };
  });
  for (const { e, v } of judged) printRow(e, v);

  const counts = { CONFIRMED: 0, FAILED: 0, HUMAN: 0, 'NOT COVERED': 0 };
  for (const { v } of judged) counts[v.result] += 1;
  const failed = judged.filter(x => x.v.result === 'FAILED').map(x => x.e.id);
  const skipped = reg.entries.length - targets.length;
  console.log(`\n${targets.length} entr${targets.length === 1 ? 'y' : 'ies'} judged (${skipped} not judged${arg('all') ? '' : '; --all re-judges confirmed/failed'}): `
    + `${counts.CONFIRMED} CONFIRMED, ${counts.FAILED} FAILED, ${counts.HUMAN} HUMAN, ${counts['NOT COVERED']} NOT COVERED`);
  if (failed.length) {
    console.log(`\n!!! ${failed.length} FAILED on a run whose build contains the change: ${failed.join(', ')}`);
    console.log('!!! The change did not do what it claims on this run. Investigate, and add a tasks/BACKLOG.md line for each.');
  }
  if (write) {
    const { flipped } = core.applyVerdicts(reg, run, judged, { checkedAt, via: 'write' });
    saveRegistry(reg);
    console.log(`\nverdicts written to tasks/verify.json${flipped.length ? ` — status changed: ${flipped.map(f => `${f.id} ${f.from}->${f.to}`).join(', ')}` : ''}`);
    console.log('Commit it: git commit -m "chore(verify): ..." -- tasks/verify.json');
  } else if (targets.length) {
    console.log('\n(dry run — add --write to record the verdicts; --mark=<id>:confirmed --note="..." records a human verdict)');
  }
}

// judge lives in verify-core.js; re-exported for callers that imported it from here.
module.exports = { judge: core.judge };

if (require.main === module) {
  main().catch(e => { console.error(`verify-run: ${e.message}`); process.exit(1); });
}
