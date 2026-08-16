#!/usr/bin/env node
/**
 * Pre-push crash gate: refuse to push server code that references variables
 * which do not exist.
 *
 * WHY THIS EXISTS — three production-path crashes shipped in a single day
 * (2026-08-15/16), all the same class, all invisible in review:
 *   - `hasFaceIssue`   (regeneration.js) — every manual character repair died
 *   - `previousImage`  (regeneration.js) — cover iterate died in blackout mode
 *   - `verdict`        (character2x4Sheet.js) — Pass-2 style transfer threw
 *                       AFTER paying for the image, and the outer catch
 *                       downgraded it to "ship the unstyled sheet", so every
 *                       full story silently lost its art-style conversion
 * Each was a leftover reader of a variable whose declaration had been removed
 * by an edit elsewhere in the same function. Each was wrapped in a try/catch
 * that turned a hard crash into a plausible-looking degraded result — which is
 * exactly why none were noticed. `no-undef` finds all three in about a second.
 *
 * ONE rule, no style opinions: everything it reports is a real ReferenceError
 * waiting to execute. If it fires, fix the variable — do not add a disable.
 *
 * SCOPE — the committed content of files this push actually changes, read via
 * `git show`, NOT the working tree. Two reasons: a pre-push hook must judge
 * what is being pushed, and this repo runs concurrent agent sessions whose
 * half-finished edits to unrelated files would otherwise block every push
 * (observed immediately: another session mid-refactor in figureDetection.js).
 * The gate's job is "do not ADD a crash", not "the whole repo is clean".
 *
 * Usage:
 *   node scripts/admin/check-no-undef.js          # gate: files in the push range
 *   node scripts/admin/check-no-undef.js --all    # full sweep of server code
 *   node scripts/admin/check-no-undef.js --list   # print what it would lint
 *
 * eslint lives in client/node_modules (the root has no lint dep). If it is not
 * installed the gate SKIPS with a warning rather than blocking the push — a
 * missing dev dependency must never stop a deploy.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

// The code that actually runs in production. Client code has its own eslint
// setup in client/; tests and scripts are not on the request path.
const TARGETS = [
  'server',
  'server.js',
  'storyJobPipeline.js',
  'email.js',
].map(p => path.join(ROOT, p)).filter(p => fs.existsSync(p));

const IN_SCOPE = /^(server\/.*\.js|server\.js|storyJobPipeline\.js|email\.js)$/;

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/**
 * Files this push adds or changes, as repo-relative paths. Falls back to the
 * full target list when the range can't be determined (no upstream, first push
 * of a branch) — better to over-check than to wave a push through.
 */
function pushedFiles() {
  const candidates = [];
  try { candidates.push(`${git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])}...HEAD`); } catch { /* no upstream */ }
  candidates.push('origin/staging...HEAD', 'origin/master...HEAD');

  for (const range of candidates) {
    let out;
    // A range that does not resolve THROWS; one that resolves to nothing
    // returns ''. Those are different answers — "nothing to check" is a valid
    // result and must not fall through to the next (much wider) candidate.
    try { out = git(['diff', '--name-only', '--diff-filter=ACMR', range]); } catch { continue; }
    return out.split('\n').map(s => s.trim()).filter(f => IN_SCOPE.test(f));
  }
  return null; // caller falls back to the full sweep
}

function resolveESLint() {
  for (const base of ['client/node_modules/eslint', 'node_modules/eslint']) {
    try {
      return require(path.join(ROOT, base));
    } catch { /* try the next location */ }
  }
  return null;
}

(async () => {
  const mod = resolveESLint();
  if (!mod || !mod.ESLint) {
    console.warn('check-no-undef: eslint not installed (client/node_modules) — SKIPPING the crash gate.');
    console.warn('  Run `cd client && npm install` to enable it.');
    process.exit(0);
  }

  const eslint = new mod.ESLint({
    cwd: ROOT,
    overrideConfigFile: path.join(__dirname, 'eslint-node.config.mjs'),
    errorOnUnmatchedPattern: false,
  });

  const fullSweep = process.argv.includes('--all');
  const changed = fullSweep ? null : pushedFiles();

  if (process.argv.includes('--list')) {
    const list = changed || TARGETS.map(t => path.relative(ROOT, t));
    console.log(list.length ? list.join('\n') : '(nothing in scope)');
    process.exit(0);
  }

  const t0 = Date.now();
  let results;
  let scopeLabel;
  if (changed && changed.length === 0) {
    console.log('check-no-undef: no server files in this push — OK');
    process.exit(0);
  } else if (changed) {
    // Lint the COMMITTED content, so a concurrent session's working-tree edits
    // to other files (or to these) can neither block nor mask this push.
    scopeLabel = `${changed.length} pushed file(s)`;
    results = [];
    for (const rel of changed) {
      let code;
      try { code = git(['show', `HEAD:${rel}`]); } catch { continue; } // deleted in HEAD
      results.push(...await eslint.lintText(code, { filePath: path.join(ROOT, rel) }));
    }
  } else {
    scopeLabel = 'full sweep';
    results = await eslint.lintFiles(TARGETS);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const offenders = results.filter(r => r.errorCount > 0);
  if (offenders.length === 0) {
    console.log(`check-no-undef: OK (${scopeLabel}, ${elapsed}s)`);
    process.exit(0);
  }

  console.error('\n❌ check-no-undef: undefined variable(s) — these are ReferenceErrors waiting to run.\n');
  for (const r of offenders) {
    console.error(`  ${path.relative(ROOT, r.filePath)}`);
    for (const m of r.messages) {
      if (m.severity !== 2) continue;
      console.error(`    ${m.line}:${m.column}  ${m.message}`);
    }
  }
  const total = offenders.reduce((n, r) => n + r.errorCount, 0);
  console.error(`\n  ${total} error(s) in ${offenders.length} file(s) (${elapsed}s).`);
  console.error('  Fix the variable. A try/catch around it does not make it safe — it just');
  console.error('  hides the crash as a degraded result (see the header of this script).\n');
  process.exit(1);
})().catch(err => {
  // The gate itself must never be the reason a push fails.
  console.warn(`check-no-undef: gate errored (${err.message}) — skipping rather than blocking.`);
  process.exit(0);
});
