#!/usr/bin/env node
/**
 * Judge one stored story run against the verification registry (tasks/verify.json).
 *
 * WHY (owner, 2026-09-24): "we do 20 changes that need a new story. When we rerun
 * it we should ensure if all 20 are tested or not." Before this, "which shipped
 * changes did that run actually prove?" was answered by re-reading commits. Now
 * each change that needs a run is a registry entry with a claim, the run shape
 * that can exercise it and a check, and this script answers per entry:
 *
 *   CONFIRMED    the stored run shows the claim holding
 *   FAILED       the stored run shows it NOT holding (loud; the entry stays pending)
 *   HUMAN        the data cannot decide alone — what to look at, with page URLs
 *   NOT COVERED  the run could not exercise it: its build lacks the commit, or
 *                the run shape is absent (no OTS page, no iterate repair, ...).
 *                Never counted as a pass.
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
 *   node scripts/admin/verify-run.js <storyId> --mark=<entryId>:confirmed|failed --note="what you saw" [--env=...]
 *   node scripts/admin/verify-run.js --list
 *
 *   --write  append evidence (CONFIRMED / FAILED / HUMAN results) to each entry and
 *            flip status to "confirmed" on an auto pass with no human part.
 *            A FAILED result never flips status; it is recorded and printed loudly.
 *   --all    also judge entries that are already confirmed (regression read).
 *   --mark   record a human verdict for one entry on this run (writes).
 *
 * Reads: stories (data, image_version_meta, idea columns), story_images
 * (urls only, never image_data), story_jobs (status/timestamps). No model call.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { ch, fromPgNaive } = require('../lib/chTime');
const { checks, evalRunShape } = require('./verify-checks');

const REGISTRY = path.join(ROOT, 'tasks', 'verify.json');

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

async function loadRun(storyId, env) {
  const url = env === 'prod'
    ? (process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL)
    : process.env.STAGING_DATABASE_URL;
  if (!url) throw new Error(env === 'prod' ? 'DATABASE_URL not set' : 'STAGING_DATABASE_URL not set');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  try {
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
    return {
      storyId, env,
      data: row.data || {},
      versionMeta: row.image_version_meta || {},
      row: { idea_source: row.idea_source, idea_original: row.idea_original, idea_used: row.idea_used },
      createdAt: fromPgNaive(row.created_at),
      job: job ? { status: job.status, createdAt: fromPgNaive(job.created_at), completedAt: job.completed_at ? fromPgNaive(job.completed_at) : null } : null,
      images: images.rows,
      build: row.data?.analytics?.build?.commitFull || null,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Judge one entry against one run. Pure given `contains` (commit -> bool|null),
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

function printRow(entry, j) {
  const tag = j.result.padEnd(11);
  console.log(`${tag} ${entry.id}  — ${entry.title}`);
  if (j.result === 'NOT COVERED') {
    console.log(`            ${j.why}`);
    if (j.oldCode && j.r) {
      const verdict = j.r.covered === false ? 'not exercised' : j.r.pass === true ? 'PASS' : j.r.pass === false ? 'FAIL' : 'undecided';
      console.log(`            old code: ${verdict} — ${j.r.detail}`);
    }
    return;
  }
  console.log(`            ${j.r.detail}`);
  if (j.r.human) console.log(`            LOOK: ${j.r.human}`);
}

async function main() {
  if (process.argv.includes('--list')) {
    const reg = loadRegistry();
    for (const e of reg.entries) {
      console.log(`${(e.status || '?').padEnd(10)} ${(e.check?.kind || '?').padEnd(5)} ${e.id}  [${(e.runShape || []).join(', ')}]  ${e.title}`);
    }
    return;
  }

  const storyId = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!storyId) {
    console.error('Usage: node scripts/admin/verify-run.js <storyId> [--env=staging|prod] [--write] [--all] | --mark=<id>:confirmed|failed --note="..."');
    process.exit(2);
  }
  const env = arg('env') || 'staging';
  if (!['staging', 'prod'].includes(env)) throw new Error(`--env must be staging or prod, got ${env}`);
  const write = !!arg('write');
  const mark = arg('mark');

  const reg = loadRegistry();
  const ctx = await loadRun(storyId, env);
  const now = ch(new Date());
  const runDate = ch(ctx.job?.createdAt || ctx.createdAt);

  console.log(`\nverify-run: ${storyId} (${env}) — run ${runDate}, build ${ctx.build ? ctx.build.slice(0, 9) : 'UNRECORDED'}, `
    + `${ctx.data.trialMode ? 'trial' : 'full story'}, ${(ctx.data.sceneImages || []).length} pages, job ${ctx.job?.status || 'row gone'}\n`);

  if (mark) {
    const [id, verdict] = String(mark).split(':');
    const e = reg.entries.find(x => x.id === id);
    if (!e) throw new Error(`no entry "${id}"`);
    if (!['confirmed', 'failed'].includes(verdict)) throw new Error('--mark takes <id>:confirmed or <id>:failed');
    const note = arg('note');
    if (!note || note === true) throw new Error('--mark needs --note="what you looked at and saw"');
    e.evidence = e.evidence || [];
    e.evidence.push({ storyId, env, build: ctx.build, runDate, checkedAt: now, result: `HUMAN-${verdict.toUpperCase()}`, note });
    e.status = verdict;
    saveRegistry(reg);
    console.log(`marked ${id} ${verdict} on ${storyId}`);
    return;
  }

  const counts = { CONFIRMED: 0, FAILED: 0, HUMAN: 0, 'NOT COVERED': 0 };
  const failed = [];
  const targets = reg.entries.filter(e => e.status === 'pending' || (arg('all') && e.status === 'confirmed'));
  const judged = targets.map(e => ({ e, j: judge(e, ctx, buildContains) }));
  const order = ['FAILED', 'CONFIRMED', 'HUMAN', 'NOT COVERED'];
  judged.sort((a, b) => order.indexOf(a.j.result) - order.indexOf(b.j.result));
  for (const { e, j } of judged) {
    counts[j.result] += 1;
    if (j.result === 'FAILED') failed.push(e.id);
    printRow(e, j);
    if (write && j.result !== 'NOT COVERED') {
      e.evidence = e.evidence || [];
      e.evidence.push({
        storyId, env, build: ctx.build, runDate, checkedAt: now,
        result: j.result, note: [j.r.detail, j.r.human ? `LOOK: ${j.r.human}` : null].filter(Boolean).join(' | ').slice(0, 1500),
      });
      if (j.result === 'CONFIRMED') e.status = 'confirmed';
    }
  }

  const skipped = reg.entries.length - targets.length;
  console.log(`\n${targets.length} entr${targets.length === 1 ? 'y' : 'ies'} judged (${skipped} confirmed/superseded/failed not judged${arg('all') ? '' : '; --all re-judges confirmed'}): `
    + `${counts.CONFIRMED} CONFIRMED, ${counts.FAILED} FAILED, ${counts.HUMAN} HUMAN, ${counts['NOT COVERED']} NOT COVERED`);
  if (failed.length) {
    console.log(`\n!!! ${failed.length} FAILED on a run whose build contains the change: ${failed.join(', ')}`);
    console.log('!!! The change did not do what it claims on this run. Investigate before building on it.');
  }
  if (write) { saveRegistry(reg); console.log('\nevidence written to tasks/verify.json'); } else if (targets.length) {
    console.log('\n(dry run — add --write to record evidence; --mark=<id>:confirmed --note="..." records a human verdict)');
  }
}

module.exports = { judge };

if (require.main === module) {
  main().catch(e => { console.error(`verify-run: ${e.message}`); process.exit(1); });
}
