#!/usr/bin/env node
/**
 * Guard for machine-checkable settled verdicts (docs/SETTLED.md).
 * Runs in .githooks/pre-push before the idle gate; exits 1 with the violating
 * file:line when a push would reintroduce a deliberately-removed pattern.
 *
 * Add a check here when a settled verdict is string-detectable. Keep patterns
 * precise — a false positive blocks pushes and erodes trust in the gate.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const CHECKS = [
  {
    name: 'Text zone: calm, never "for white text"',
    dirs: ['prompts'], ext: ['.txt'],
    pattern: /for white text/i,
    verdict: 'Text-overlay zone is CALM, never dark (docs/SETTLED.md)',
  },
  {
    name: '"No hats" rules were removed deliberately',
    dirs: ['prompts'], ext: ['.txt'],
    // Instruction-like bans only; "no hat where the contract names one" (eval
    // absence language) is legitimate.
    pattern: /(?:never|don't|do not|avoid)\s+(?:add|draw|include|render|wear|put)\w*\s+(?:a\s+|any\s+)?hats?\b|\bno hats\b/i,
    verdict: 'The no-hats rules are gone, 2026-08-09 (docs/SETTLED.md)',
  },
  {
    name: 'Prompts stay generic - no test-story names',
    dirs: ['prompts'], ext: ['.txt'],
    // Content guides legitimately tell the Tell saga; the genericity rule
    // targets pipeline templates.
    exclude: ['historical-guides.txt', 'swiss-sagen-guides.txt'],
    pattern: /\b(Gessler|Altdorf|Wilhelm Tell|Lukas|Manuel|Franziska|Matthias)\b/,
    verdict: 'Prompts use archetypes only, never test-story names (docs/SETTLED.md)',
  },
  {
    name: 'Swiss orthography: ss, never eszett',
    dirs: ['prompts', path.join('client', 'src')], ext: ['.txt', '.ts', '.tsx', '.js', '.jsx', '.json'],
    pattern: /ß/,
    verdict: 'Every German string uses Swiss ss, never ß (docs/SETTLED.md)',
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

let violations = 0;
for (const check of CHECKS) {
  for (const dir of check.dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (!check.ext.includes(path.extname(file))) continue;
      if (check.exclude && check.exclude.includes(path.basename(file))) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (check.pattern.test(line)) {
          violations++;
          console.error(`SETTLED VIOLATION [${check.name}]`);
          console.error(`  ${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
          console.error(`  Verdict: ${check.verdict}\n`);
        }
      });
    }
  }
}

if (violations > 0) {
  console.error(`${violations} settled-verdict violation(s). Read docs/SETTLED.md - reversing a settled verdict needs user sign-off + evidence + a superseding docs/decisions.md entry. Bypass once with --no-verify ONLY after that protocol.`);
  process.exit(1);
}
console.log('check-settled: OK');
