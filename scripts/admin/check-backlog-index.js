#!/usr/bin/env node
/**
 * Pre-push check (WARN ONLY, never blocks): open work added to a doc should be
 * reachable from tasks/BACKLOG.md.
 *
 * WHY THIS EXISTS
 * A sweep on 2026-08-20 found ~184 live open items scattered across ~40 files,
 * plus ~240 more in superseded ones. Nothing was lost by malice — each session
 * wrote its open items into whatever document it was already editing, and no
 * index tied them together. Finding out what was open cost a full agent sweep.
 * BACKLOG.md is now the index; this check notices when a push adds open items
 * to a file the index does not point at.
 *
 * HOW IT JUDGES — deliberately loose
 * For each `- [ ]` line ADDED by this push in a watched file, it asks one
 * question: does BACKLOG.md mention that file's basename anywhere? That is a
 * per-FILE check, not a per-ITEM one. Ticking off individual lines would need
 * text matching between an index entry and its source, which drifts the moment
 * anyone rewords either — and a check that cries wolf gets ignored, which is
 * worse than no check.
 *
 * HONEST LIMITS, so nobody mistakes this for more than it is:
 *   - It cannot tell whether the index entry is accurate, current, or even
 *     about the same item. A single pointer to the file satisfies it.
 *   - It therefore catches "a whole file of open work nobody indexed", not
 *     "this one new bullet is missing".
 *   - It NEVER blocks. Exit code is always 0. It prints and gets out of the way.
 *
 * Usage:
 *   node scripts/admin/check-backlog-index.js         # as run by the hook
 *   node scripts/admin/check-backlog-index.js --all   # audit the whole tree,
 *                                                     # ignoring the push range
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = 'tasks/BACKLOG.md';

// Where open work legitimately lives. Everything else either has no tasks in it
// or has them for reasons that are not project work.
const WATCHED = [/^docs\/.*\.(md|html)$/, /^tasks\/.*\.md$/];

// Checkbox-bearing files that are NOT task lists:
//   docs/archive/  — superseded by definition (see its README)
//   .claude/skills/, prompts/ — checklist TEMPLATES and LLM output formats
//   biz/, requirements — long-horizon plans, indexed as a whole not per line
const IGNORED = [
  /^docs\/archive\//,
  /^\.claude\/skills\//,
  /^prompts\//,
  /^biz\//,
  /requirements-2025-01\//,
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Same range resolution as check-doc-coupling.js: judge what is being PUSHED,
// falling back through upstream -> staging -> master when there is no upstream.
function pushedRange() {
  const candidates = [];
  try {
    candidates.push(`${git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])}...HEAD`);
  } catch { /* no upstream configured */ }
  candidates.push('origin/staging...HEAD', 'origin/master...HEAD');
  for (const range of candidates) {
    try {
      git(['rev-parse', range.split('...')[0]]);
      return range;
    } catch { /* that ref does not exist here */ }
  }
  return null;
}

function watched(file) {
  if (IGNORED.some(re => re.test(file))) return false;
  return WATCHED.some(re => re.test(file));
}

/** Files that gained at least one `- [ ]` line in this push. */
function filesWithNewOpenItems(range) {
  const out = new Map();
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', range, '--', 'docs', 'tasks'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return out;
  }
  let current = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) { current = header[1]; continue; }
    if (!current || !watched(current)) continue;
    // An added line (not the +++ header) carrying an unchecked checkbox.
    if (line.startsWith('+') && !line.startsWith('+++') && /^\+\s*[-*]\s*\[ \]/.test(line)) {
      out.set(current, (out.get(current) || 0) + 1);
    }
  }
  return out;
}

/** Every watched file currently holding at least one `- [ ]`. */
function filesWithAnyOpenItems() {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!watched(rel)) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const n = (text.match(/^\s*[-*]\s*\[ \]/gm) || []).length;
      if (n) out.set(rel, n);
    }
  };
  for (const top of ['docs', 'tasks']) {
    if (fs.existsSync(path.join(ROOT, top))) walk(top);
  }
  return out;
}

function main() {
  const all = process.argv.includes('--all');

  const indexPath = path.join(ROOT, INDEX);
  if (!fs.existsSync(indexPath)) {
    console.log(`ℹ️  ${INDEX} is missing — skipping the backlog-index check.`);
    return;
  }
  const index = fs.readFileSync(indexPath, 'utf8');

  let candidates;
  if (all) {
    candidates = filesWithAnyOpenItems();
  } else {
    const range = pushedRange();
    if (!range) return;
    candidates = filesWithNewOpenItems(range);
  }

  const unindexed = [...candidates.entries()]
    .filter(([file]) => file !== INDEX)
    // The index points at files by path or basename; either counts.
    .filter(([file]) => !index.includes(file) && !index.includes(path.basename(file)));

  if (!unindexed.length) return;

  console.log('');
  console.log(`⚠️  Open items in ${unindexed.length} file(s) that ${INDEX} does not point at:`);
  for (const [file, n] of unindexed) {
    console.log(`      ${file} — ${n} unchecked item(s)`);
  }
  console.log(`   Add a line per item to ${INDEX} with a "-> file:line" pointer,`);
  console.log('   so the next session finds it without sweeping the repo.');
  console.log('   (This is a warning. The push continues.)');
  console.log('');
}

try {
  main();
} catch (e) {
  // A task-hygiene warning must never be the reason a push fails.
  console.log(`ℹ️  backlog-index check skipped: ${e.message}`);
}
process.exit(0);
