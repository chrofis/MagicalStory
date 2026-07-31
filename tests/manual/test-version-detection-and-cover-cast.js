/**
 * Unit tests for two cover-parity fixes (owner directives 2026-07-31):
 *
 *   1. detectionForVersion (server/lib/images.js) — "detection is part of
 *      every image version": the single resolution rule every version-entry
 *      writer uses. A detection stamped directly on the version (computed on
 *      its own bytes — fresh-bbox refresh, regen/iterate results) wins over
 *      the eval-time detection; eval-time detection is the fallback; honest
 *      null otherwise.
 *
 *   2. narrowCoverCastToMains (server/lib/coverIterate.js) — "cover reference
 *      packing must include EVERY hint-listed character's avatar": the
 *      main-only narrowing filters apply ONLY to fallback-derived casts,
 *      never to hint-derived casts (the title page previously dropped a
 *      hint-listed second protagonist, so their avatar never went along).
 *
 * Deterministic, no network / DB / native deps needed beyond what the repo
 * modules import (bare-module misses are stubbed).
 *
 * Run: node tests/manual/test-version-detection-and-cover-cast.js
 */

const assert = require('assert');

// Stub bare modules that may be missing in a bare checkout (sharp, p-limit, …).
const Module = require('module');
const origLoad = Module._load;
const makeStub = () => new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'default' ? makeStub() : makeStub()),
  apply: () => makeStub(),
  construct: () => makeStub(),
});
Module._load = function (request, parent, isMain) {
  const isBare = !request.startsWith('.') && !request.startsWith('/');
  try {
    return origLoad.call(this, request, parent, isMain);
  } catch (err) {
    if (isBare && err.code === 'MODULE_NOT_FOUND') return makeStub();
    throw err;
  }
};

const { detectionForVersion } = require('../../server/lib/images');
const { narrowCoverCastToMains, filterBackCoverToMainCharacters } = require('../../server/lib/coverIterate');
Module._load = origLoad;

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// ─── 1. detectionForVersion ─────────────────────────────────────────────────
console.log('detectionForVersion: per-version detection resolution');
{
  const own = { figures: [{ name: 'A' }], sourceImageFp: 'fp-own' };
  const evalDet = { figures: [{ name: 'B' }], sourceImageFp: 'fp-eval' };

  assert.strictEqual(detectionForVersion({ bboxDetection: own, evaluation: { bboxDetection: evalDet } }), own);
  ok('version-stamped detection wins over eval-time detection');

  assert.strictEqual(detectionForVersion({ evaluation: { bboxDetection: evalDet } }), evalDet);
  ok('falls back to the eval-time detection');

  assert.strictEqual(detectionForVersion({ evaluation: {} }), null);
  assert.strictEqual(detectionForVersion({}), null);
  assert.strictEqual(detectionForVersion(null), null);
  ok('honest null when the version never had a detection');
}

// ─── 2. narrowCoverCastToMains ──────────────────────────────────────────────
console.log('narrowCoverCastToMains: hint-derived casts are authoritative');
const main = { id: 1, name: 'MainChar', isMainCharacter: true };
const primary = { id: 2, name: 'SecondChar', isMainCharacter: false };
const extra = { id: 3, name: 'ThirdChar', isMainCharacter: false };

{
  // Hint-derived cast: main + hint-listed primary — NOTHING is dropped.
  const out = narrowCoverCastToMains([main, primary], { castFromHint: true, mainIds: [1] });
  assert.deepStrictEqual(out.characters.map(c => c.name), ['MainChar', 'SecondChar']);
  assert.deepStrictEqual(out.dropped, []);
  assert.strictEqual(out.applied, false);
  ok('hint-derived cast keeps EVERY hint-listed character (second protagonist packed)');
}
{
  // Fallback cast (scene-text matching): main-only narrowing applies.
  const out = narrowCoverCastToMains([main, primary, extra], { castFromHint: false, mainIds: [1] });
  assert.deepStrictEqual(out.characters.map(c => c.name), ['MainChar']);
  assert.deepStrictEqual(out.dropped.sort(), ['SecondChar', 'ThirdChar']);
  assert.strictEqual(out.applied, true);
  ok('fallback-derived cast still narrows to main characters');
}
{
  // Fallback cast with no main present: safety — never empty the cover.
  const out = narrowCoverCastToMains([primary, extra], { castFromHint: false, mainIds: [] });
  assert.deepStrictEqual(out.characters.map(c => c.name), ['SecondChar', 'ThirdChar']);
  assert.strictEqual(out.applied, false);
  ok('fallback cast with zero mains is left intact (never an empty cover)');
}
{
  // mainIds-array main detection (isMainCharacter flag absent).
  const m2 = { id: 7, name: 'IdMain' };
  const out = narrowCoverCastToMains([m2, primary], { castFromHint: false, mainIds: [7] });
  assert.deepStrictEqual(out.characters.map(c => c.name), ['IdMain']);
  ok('mains resolved via storyData.mainCharacters ids, not only the flag');
}
{
  // Underlying filter unchanged for its direct callers.
  const out = filterBackCoverToMainCharacters([main, primary], [1]);
  assert.deepStrictEqual(out.characters.map(c => c.name), ['MainChar']);
  assert.deepStrictEqual(out.dropped, ['SecondChar']);
  ok('filterBackCoverToMainCharacters behavior unchanged');
}

console.log(`\nAll ${passed} assertions passed.`);
process.exit(0); // transitively-loaded modules may hold open handles
