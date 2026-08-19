#!/usr/bin/env node
/**
 * Pre-push gate: a reported bug is FIXED, not shipped around.
 *
 * WHY THIS EXISTS (owner, 2026-08-19): CLAUDE.md has said "when given a bug
 * report: just fix it" since the beginning, and it kept not happening — clear,
 * owner-reported bugs were filed as backlog tasks while unrelated work shipped
 * on top of them. A rule nobody enforces is a suggestion. This gate enforces
 * it the same way check-settled enforces settled verdicts: the push fails.
 *
 * MECHANISM: tasks/bugs.json is the clear-bug registry. The moment a bug is
 * confirmed (owner-reported, or reproduced from stored evidence) it gets an
 * entry with status "open". While ANY entry is open, every push is blocked —
 * fixing the bug (and flipping its entry to "fixed" in the same commit) is
 * what unblocks the tree. ONLY clear bugs belong in the registry: reproduced
 * defects, not design questions, not improvements, not hunches.
 *
 * Escape hatch, deliberate and visible:
 *   PUSH_WITH_OPEN_BUGS=1 git push
 * for the genuine emergency (hotfix for a worse outage). Using it leaves the
 * bugs open and the next push blocked again — it defers, never dismisses.
 *
 * Usage:
 *   node scripts/admin/check-open-bugs.js          # gate
 *   node scripts/admin/check-open-bugs.js --list   # show the registry
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'tasks', 'bugs.json');

let reg;
try {
  reg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  // No registry (or unparseable): nothing to enforce. A missing file must not
  // block pushes on checkouts that predate this gate.
  console.log(`check-open-bugs: no readable registry (${e.code || e.message}) — OK`);
  process.exit(0);
}

const bugs = Array.isArray(reg.bugs) ? reg.bugs : [];
const open = bugs.filter(b => b && b.status === 'open');

if (process.argv.includes('--list')) {
  for (const b of bugs) console.log(`${(b.status || '?').padEnd(6)} ${b.id}  ${b.title}`);
  process.exit(0);
}

if (open.length === 0) {
  console.log(`check-open-bugs: OK (${bugs.length} tracked, 0 open)`);
  process.exit(0);
}

if (process.env.PUSH_WITH_OPEN_BUGS === '1') {
  console.warn(`check-open-bugs: ${open.length} OPEN bug(s) — push allowed by PUSH_WITH_OPEN_BUGS=1. They remain open; the next push is blocked again.`);
  process.exit(0);
}

console.error(`\ncheck-open-bugs: ${open.length} reported bug(s) still OPEN — fix them before shipping anything else\n`);
for (const b of open) {
  console.error(`  • ${b.id}`);
  console.error(`      ${b.title}`);
  console.error(`      reported ${b.reportedAt} — ${b.source}${b.task ? ` (task #${b.task})` : ''}`);
}
console.error(`\n  A reported bug is fixed immediately (CLAUDE.md), not pushed around.`);
console.error(`  Fix it and set its entry to "fixed" (with the commit hash) in the same commit.`);
console.error(`  Genuine emergency only: PUSH_WITH_OPEN_BUGS=1 git push\n`);
process.exit(1);
