#!/usr/bin/env node
/**
 * Pre-push gate: a behaviour change names how a story run will prove it.
 *
 * WHY (owner, 2026-09-24): "we do 20 changes that need a new story. When we
 * rerun it we should ensure if all 20 are tested or not." Changes that need a
 * run to be proven used to live only in commit messages, and "which of them did
 * that run exercise?" meant re-reading history. tasks/verify.json is now the
 * list, scripts/admin/verify-run.js judges a stored run against it, and this
 * gate keeps the list from silently falling behind.
 *
 * RULE — for each commit in the push range that changes a WATCHED behaviour file
 * (the same list as check-doc-coupling.js, imported, never copied), one of:
 *   1. the push range adds or changes a registry ENTRY in tasks/verify.json
 *      (id, claim, commits, runShape or check; appending evidence does not
 *      count — that is a run being recorded, not a change being registered);
 *   2. the commit message carries `Verify: <entry-id>` naming an entry that
 *      exists — an existing claim already covers this change;
 *   3. the commit message carries `Verify: none (<reason>)` — the change needs
 *      no run (a refactor with identical output, a test-only prompt fixture).
 *      The reason is mandatory; it is the record of why.
 *
 * HISTORY IS NOT JUDGED. Commits that are ancestors of the commit that
 * introduced this gate were written before it existed and are skipped, so a
 * push carrying older unpushed work from another session is not blocked
 * retroactively. Only the push range (upstream..HEAD) is ever read.
 *
 * FAIL CLOSED on its own errors (unreadable registry, unresolvable range), like
 * check-sibling-paths.js: a gate that waves a push through on its own failure is
 * a gate nobody can rely on.
 *
 * Usage:
 *   node scripts/admin/check-verify-coupling.js               # gate: the push range
 *   node scripts/admin/check-verify-coupling.js --range A..B  # judge any range
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { WATCHED } = require('./check-doc-coupling');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = 'tasks/verify.json';
const SELF_PATH = 'scripts/admin/check-verify-coupling.js';

// `Verify: none (<reason>)` or `Verify: <entry-id>` — one trailer line.
const TRAILER = /^[ \t]*Verify:[ \t]*(.+?)[ \t]*$/gmi;
const NONE = /^none\s*\((.*\S.*)\)$/i;
const ENTRY_KEYS = ['id', 'title', 'claim', 'commits', 'runShape', 'check'];

function die(msg) {
  console.error('');
  console.error(`check-verify-coupling: ${msg}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The registry's entries as {id -> comparable signature}; {} when the file does not exist. */
function entrySignatures(json) {
  const out = {};
  if (!json) return out;
  const reg = JSON.parse(json);
  for (const e of Array.isArray(reg.entries) ? reg.entries : []) {
    if (!e || !e.id) continue;
    out[e.id] = JSON.stringify(ENTRY_KEYS.map(k => e[k] ?? null));
  }
  return out;
}

/** Entry ids added or changed between two registry texts (evidence/status changes ignored). */
function changedEntries(beforeJson, afterJson) {
  const before = entrySignatures(beforeJson);
  const after = entrySignatures(afterJson);
  return Object.keys(after).filter(id => before[id] !== after[id]);
}

/** Parse the Verify trailers of one message: { none: [reasons], ids: [ids], bad: [raw] }. */
function parseTrailers(message) {
  const r = { none: [], ids: [], bad: [] };
  TRAILER.lastIndex = 0;
  let m;
  while ((m = TRAILER.exec(String(message || ''))) !== null) {
    const v = m[1].trim();
    const n = NONE.exec(v);
    if (n) r.none.push(n[1].trim());
    else if (/^none\b/i.test(v)) r.bad.push(v);
    else if (/^[a-z0-9][a-z0-9-]*$/i.test(v)) r.ids.push(v);
    else r.bad.push(v);
  }
  return r;
}

/**
 * Pure decision core — no git, no filesystem.
 * @param commits  [{ sha, message, files }] oldest first, already filtered to judged commits
 * @param opts     { watched: RegExp[], registryChanged: string[], knownIds: Set<string> }
 * @returns        { blocks: [{sha, subject, files, why}], passes: [{sha, how}] }
 */
function analyze(commits, { watched, registryChanged, knownIds }) {
  const blocks = [];
  const passes = [];
  for (const c of commits) {
    const behaviour = (c.files || []).filter(f => watched.some(re => re.test(f)));
    if (!behaviour.length) continue;
    const subject = String(c.message || '').split('\n')[0];
    const t = parseTrailers(c.message);
    const unknown = t.ids.filter(id => !knownIds.has(id));
    if (t.bad.length || unknown.length) {
      blocks.push({
        sha: c.sha, subject, files: behaviour,
        why: t.bad.length
          ? `malformed trailer "Verify: ${t.bad[0]}" — use "Verify: none (<reason>)" or "Verify: <entry-id>"`
          : `"Verify: ${unknown[0]}" names no entry in ${REGISTRY_PATH}`,
      });
      continue;
    }
    if (t.none.length) { passes.push({ sha: c.sha, how: `Verify: none (${t.none[0]})` }); continue; }
    if (t.ids.length) { passes.push({ sha: c.sha, how: `Verify: ${t.ids.join(', ')}` }); continue; }
    if (registryChanged.length) { passes.push({ sha: c.sha, how: `registry entries in this push: ${registryChanged.join(', ')}` }); continue; }
    blocks.push({ sha: c.sha, subject, files: behaviour, why: 'no registry entry in this push and no Verify trailer' });
  }
  return { blocks, passes };
}

function pushRange() {
  const i = process.argv.indexOf('--range');
  if (i !== -1) {
    if (!process.argv[i + 1]) die('--range needs an argument, e.g. --range origin/staging..HEAD');
    return process.argv[i + 1];
  }
  const candidates = [];
  try { candidates.push(`${git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])}..HEAD`); } catch { /* no upstream */ }
  candidates.push('origin/staging..HEAD', 'origin/master..HEAD');
  for (const r of candidates) {
    try { git(['rev-list', '--max-count=1', r]); return r; } catch { /* next */ }
  }
  die('no push range could be resolved (no upstream, no origin/staging, no origin/master).');
}

/** The commit that introduced this gate; commits before it are history, not judged. */
function gateIntroduction() {
  try {
    const out = git(['log', '--diff-filter=A', '--format=%H', '--', SELF_PATH]);
    const lines = out.split('\n').filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null; // oldest add
  } catch { return null; }
}

function isAncestor(a, b) {
  try { git(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}

function main() {
  const range = pushRange();
  const shas = git(['rev-list', '--reverse', '--no-merges', range]).split('\n').map(s => s.trim()).filter(Boolean);
  if (!shas.length) { console.log(`check-verify-coupling: no commits in ${range} — nothing to check.`); return; }

  // Not yet committed (the gate is being introduced in this very push, or runs
  // from a working tree): nothing in the range predates it.
  const intro = gateIntroduction();
  const judged = shas.filter(sha => !(intro && sha !== intro && isAncestor(sha, intro)));
  const skipped = shas.length - judged.length;

  // The registry as it stood where this push departs from the remote — the merge
  // base, so an entry another session pushed meanwhile is not read as ours.
  const from = range.includes('..') ? range.split('..')[0] : `${range}^`;
  const base = git(['merge-base', from, 'HEAD']);
  let beforeJson = null; let afterJson = null;
  try { beforeJson = git(['show', `${base}:${REGISTRY_PATH}`]); } catch { beforeJson = null; }
  try { afterJson = git(['show', `HEAD:${REGISTRY_PATH}`]); } catch { afterJson = null; }
  let registryChanged; let knownIds;
  try {
    registryChanged = changedEntries(beforeJson, afterJson);
    knownIds = new Set(Object.keys(entrySignatures(afterJson)));
  } catch (e) {
    die(`${REGISTRY_PATH} at HEAD is not valid JSON (${e.message}) — fix it; the gate cannot judge a push without it.`);
  }

  const commits = judged.map(sha => ({
    sha,
    message: git(['log', '-1', '--format=%B', sha]),
    files: git(['show', '--pretty=format:', '--name-only', '--diff-filter=ACMRD', sha]).split('\n').map(s => s.trim()).filter(Boolean),
  }));
  const { blocks, passes } = analyze(commits, { watched: WATCHED, registryChanged, knownIds });

  if (!blocks.length) {
    console.log(`check-verify-coupling: OK (${judged.length} commit(s) judged${skipped ? `, ${skipped} predate the gate` : ''}; ${passes.length} behaviour commit(s) accounted for)`);
    return;
  }
  console.error('');
  console.error(`check-verify-coupling: BLOCKED — ${blocks.length} behaviour commit(s) say nothing about how a run will prove them.`);
  console.error('');
  for (const b of blocks) {
    console.error(`  ✗ ${b.sha.slice(0, 9)}  ${b.subject}`);
    console.error(`      ${b.files.join(', ')}`);
    console.error(`      ${b.why}`);
  }
  console.error('');
  console.error('  Pick one, in this push:');
  console.error(`    - add an entry to ${REGISTRY_PATH} (claim, runShape, check) — the change needs a run;`);
  console.error('    - trailer  Verify: <entry-id>        an existing entry already covers it;');
  console.error('    - trailer  Verify: none (<reason>)   it needs no run (say why).');
  console.error('  A trailer belongs on the commit itself; without rewriting history, registering');
  console.error('  an entry in a later commit of the same push satisfies the gate.');
  console.error('  Then judge runs with: node scripts/admin/verify-run.js <storyId> --write');
  process.exit(1);
}

module.exports = { analyze, parseTrailers, changedEntries };

if (require.main === module) {
  try { main(); } catch (e) {
    die(`unexpected error, refusing the push rather than failing open: ${e && e.stack ? e.stack : e}`);
  }
}
