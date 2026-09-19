import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const { pinnedVersionIndex } = require_('../../server/lib/testlab.js');

/**
 * `Number(null)` is 0, so `Number.isFinite(Number(versionIndex))` turns "no pin"
 * into a pin on v0 — the loadedFrom={unrecorded} symptom and the 2026-08-19
 * "detected on v0 although activeVersion=2" mystery. The loader learned the
 * guard; three other readers of the same field kept the broken spelling.
 */
describe('pinnedVersionIndex', () => {
  it('no pin stays no pin', () => {
    for (const v of [null, undefined, '']) expect(pinnedVersionIndex(v)).toBeNull();
  });

  it('a real pin survives, as a number, zero included', () => {
    expect(pinnedVersionIndex(0)).toBe(0);
    expect(pinnedVersionIndex(2)).toBe(2);
    expect(pinnedVersionIndex('3')).toBe(3);
  });

  it('an unreadable pin is no pin, not NaN', () => {
    expect(pinnedVersionIndex('later')).toBeNull();
    expect(pinnedVersionIndex({})).toBeNull();
  });
});

describe('every version-pin reader uses the one helper', () => {
  const SRC = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');

  it('no hand-rolled isFinite(Number(versionIndex)) is left in code', () => {
    const code = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
    expect(code).not.toMatch(/Number\.isFinite\(Number\([^)]*versionIndex\)\)/);
  });

  it('the semantic eval stage honours the pinned target', () => {
    const at = SRC.indexOf('async function runSemanticEvalStage');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 1200)).toMatch(/loadActivePageImage\(ctx\.storyId, ctx\.pageNumber, ctx\.versionIndex \?\? null\)/);
  });
});
