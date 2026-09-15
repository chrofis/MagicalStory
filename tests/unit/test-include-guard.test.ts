/**
 * No test-shaped file may sit outside the vitest include pattern.
 *
 * WHY THIS EXISTS — 2026-09-15. vitest.config.ts includes only
 * `tests/unit/**\/*.test.ts`, and three `.test.js` files had been sitting in
 * tests/unit for months never running once. One of them (scoring.test.js) was
 * the only thing pinning the scoring.js severity tables, and six of its
 * assertions had gone stale against deleted code without anyone noticing —
 * a test that never runs is worse than no test, because it reads as coverage.
 *
 * The guard is the file listing itself: a test file in a tests directory must
 * match an include pattern, or it is invisible.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SCANNED = ['tests/unit', 'tests/api'];
const INVISIBLE = /\.test\.(js|mjs|cjs|jsx|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
  }
  return out;
}

describe('vitest include coverage', () => {
  it('no test file in tests/unit or tests/api is outside the include pattern', () => {
    const stranded = SCANNED.flatMap(d => walk(path.join(ROOT, d))).filter(f => INVISIBLE.test(f));
    expect(
      stranded,
      'vitest.config.ts includes only **/*.test.ts — these files never run. Convert them to .test.ts (real vitest suites, not process.exit scripts), or move them to tests/manual/.'
    ).toEqual([]);
  });
});
