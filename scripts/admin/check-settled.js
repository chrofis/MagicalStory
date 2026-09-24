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
    // A VB cell's drawn AREA was measured inert for size (25x area bought 0-18%),
    // decisions.md 2026-09-19. The reintroduction shape this catches is a PROMPT
    // telling the model to read a reference cell's drawn size as the object's real
    // size. Scoped to prompts/ deliberately: the Lab's geometry knobs
    // (columnMaxFraction / vbColumnFraction / refScale, commit 7ec03fb1c) are
    // legitimate and must not be flagged.
    name: "A reference cell's drawn area is not the object's real-world size",
    dirs: ['prompts'], ext: ['.txt'],
    pattern: /(reference|vb|visual bible)[^.\n]{0,40}\b(cell|panel|tile)\b[^.\n]{0,60}\b(drawn|shown|rendered|sized|size|scale|bigger|larger)\b[^.\n]{0,60}\b(real[- ]?world|actual|true)\b/i,
    verdict: "A VB cell's drawn AREA is not the size lever - measured and killed 2026-09-19 (docs/SETTLED.md)",
  },
  {
    // The page render used to be told to copy the plate's light, so every page on a
    // shared plate took the representative page's weather (decisions.md 2026-09-24).
    name: "A page's light is its declared timeOfDay / weather, never the plate's",
    dirs: ['prompts'], ext: ['.txt'],
    pattern: /geography and light direction|split it too when its pages differ in time of day/i,
    verdict: "A page's time of day and weather are its brief's fields; a plate in another light is re-lit, never inherited (docs/SETTLED.md)",
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
