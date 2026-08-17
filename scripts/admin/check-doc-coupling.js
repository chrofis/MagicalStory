#!/usr/bin/env node
/**
 * Pre-push gate: a push that changes how the system BEHAVES must touch a doc.
 *
 * The companion to check-doc-drift.js. That one verifies claims a document
 * already makes; this one notices the change nobody wrote down at all — the
 * case where the docs are not wrong, just silent, and a future session has to
 * reconstruct the decision from a diff.
 *
 * WATCHED means "changing this changes behaviour a reader cannot infer from the
 * code alone": defaults and thresholds (server/config), the prompts, the
 * migrations, and the pipeline modules whose contracts other modules depend on.
 * Deliberately NOT watched: routes, client code, tests, scripts — those are read
 * where they live.
 *
 * DOC means anything under docs/, plus CLAUDE.md. docs/decisions.md is the usual
 * answer; a Context/Decision/Rationale/Touched entry there costs a minute.
 *
 * HONEST LIMITS, stated so nobody mistakes this for more than it is:
 *   - It cannot tell whether the doc you touched is the RIGHT doc, or says
 *     anything true. Touching any doc satisfies it.
 *   - It therefore catches "I forgot entirely", not "I wrote it badly".
 *   - A gate that fires on changes genuinely needing no docs trains people to
 *     bypass it, and a bypassed gate is worse than none. So it is deliberately
 *     narrow, and `git push --no-verify` remains the escape hatch for the rare
 *     honest exception (a pure rename, a typo in a comment).
 *
 * Usage:
 *   node scripts/admin/check-doc-coupling.js         # gate
 *   node scripts/admin/check-doc-coupling.js --list  # what it sees in this push
 */

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

const WATCHED = [
  /^server\/config\/.*\.js$/,        // defaults, thresholds, model routing
  /^prompts\/.*\.txt$/,              // every prompt is a behaviour contract
  /^migrations\/.*\.sql$/,           // schema changes
  /^server\/lib\/figureDetection\.js$/,
  /^server\/lib\/bboxDetection\.js$/,
  /^server\/lib\/evalPipeline\.js$/,
  /^server\/lib\/scoring\.js$/,
  /^storyJobPipeline\.js$/,
  /^photo_analyzer\.py$/,   // the analyzer IS behaviour: detection, masks, warmup
];

const DOCS = [/^docs\//, /^CLAUDE\.md$/];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

// Same range resolution as check-no-undef.js: judge what is being PUSHED.
function pushedFiles() {
  const candidates = [];
  try { candidates.push(`${git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])}...HEAD`); } catch { /* no upstream */ }
  candidates.push('origin/staging...HEAD', 'origin/master...HEAD');
  for (const range of candidates) {
    let out;
    try { out = git(['diff', '--name-only', '--diff-filter=ACMR', range]); } catch { continue; }
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }
  return null;
}

const files = pushedFiles();
if (files === null) {
  console.log('check-doc-coupling: push range undeterminable — SKIPPING');
  process.exit(0);
}

const behaviour = files.filter(f => WATCHED.some(re => re.test(f)));
const docs = files.filter(f => DOCS.some(re => re.test(f)));

if (process.argv.includes('--list')) {
  console.log(`files in push: ${files.length}`);
  console.log(`behaviour-changing: ${behaviour.join(', ') || '(none)'}`);
  console.log(`docs touched: ${docs.join(', ') || '(none)'}`);
  process.exit(0);
}

if (behaviour.length && !docs.length) {
  console.error('\ncheck-doc-coupling: behaviour changed, nothing documented\n');
  for (const f of behaviour) console.error(`    ${f}`);
  console.error('\n  These change how the system behaves in ways the code alone does not explain.');
  console.error('  Add a docs/decisions.md entry (Context / Decision / Rationale / Touched), or');
  console.error('  update the doc that describes this area.\n');
  console.error('  Genuinely nothing to say (pure rename, comment typo)? git push --no-verify\n');
  process.exit(1);
}

console.log(`check-doc-coupling: OK (${behaviour.length} behaviour file(s), ${docs.length} doc file(s))`);
