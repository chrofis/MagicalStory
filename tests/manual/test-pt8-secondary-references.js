/**
 * Secondary-character identity fix.
 *
 * Owner rule (2026-07-26): EVERY secondary character must be in the visual bible
 * with its own reference image even when it appears in a SINGLE scene — the old
 * "2+ scenes" gate is what left single-scene secondaries with no reference, so
 * they inherited the primary's face. There is NO name/identity filter: any entry
 * the story put in `secondaryCharacters` gets its own face.
 *
 * Verifies getElementsNeedingReferenceImages:
 *   - INCLUDES a secondary that appears on only ONE page (Sofia),
 *   - INCLUDES a secondary described with an article ("a guard") — a single
 *     individual that previously (and wrongly) got filtered out,
 *   - INCLUDES a group entry ("villagers") — the story chose to put it in the VB,
 *     so it gets its own reference and doesn't borrow the primary's face,
 *   - EXCLUDES a secondary that already has a reference,
 *   - EXCLUDES a secondary with no pages (can't be placed),
 *   - keeps the 2-page gate for LOCATIONS (a one-page place needs no reference),
 *   - applies the SAME single-page rule in trial mode.
 *
 * Deterministic, no network / DB.
 * Run: node tests/manual/test-pt8-secondary-references.js
 */
const assert = require('assert');

// This environment has no node_modules (p-limit, sharp, @anthropic, …). The
// functions under test are pure JS that never touch those deps at runtime, so
// stub any *bare* module specifier that fails to resolve with a permissive
// Proxy. Relative/absolute requires (the repo's own files) resolve normally.
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

const { getElementsNeedingReferenceImages } = require('../../server/lib/visualBible');
Module._load = origLoad;

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
};

// ── getElementsNeedingReferenceImages integration ───────────────────────────
console.log('getElementsNeedingReferenceImages (every secondary, single scene):');
const vb = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'Sofia', appearsInPages: [4], referenceImageGenerated: false },      // 1-page → include
    { id: 'CHR002', name: 'a guard', appearsInPages: [3], referenceImageGenerated: false },     // 1-page article-role → include (was wrongly filtered before)
    { id: 'CHR003', name: 'villagers', appearsInPages: [2], referenceImageGenerated: false },   // group entry the story put in VB → include (own ref, not primary's face)
    { id: 'CHR004', name: 'Otto', appearsInPages: [1], referenceImageGenerated: true },         // already has ref → exclude
    { id: 'CHR005', name: 'Grandpa Max', appearsInPages: [], referenceImageGenerated: false },  // no page → exclude (can't place)
  ],
  artifacts: [],
  animals: [],
  vehicles: [],
  locations: [
    { id: 'LOC001', name: 'Cave', appearsInPages: [7], isRealLandmark: false, referenceImageGenerated: false },       // 1-page location → exclude (2-page gate)
    { id: 'LOC002', name: 'Castle', appearsInPages: [1, 8], isRealLandmark: false, referenceImageGenerated: false },   // 2-page location → include
  ],
};

const result = getElementsNeedingReferenceImages(vb); // defaults: minAppearances=2, characterMinAppearances=1
const names = result.map(e => `${e.name}:${e.type}`);
console.log('  returned:', JSON.stringify(names));

check('1-page secondary "Sofia" IS included', names.includes('Sofia:character'));
check('1-page article-role "a guard" IS included (no name filter)', names.includes('a guard:character'));
check('group entry "villagers" IS included (gets its own reference)', names.includes('villagers:character'));
check('already-referenced "Otto" is EXCLUDED', !names.some(n => n.startsWith('Otto')));
check('no-page "Grandpa Max" is EXCLUDED', !names.some(n => n.startsWith('Grandpa Max')));
check('1-page LOCATION "Cave" is EXCLUDED (locations keep 2-page gate)', !names.some(n => n.startsWith('Cave')));
check('2-page LOCATION "Castle" IS included', names.includes('Castle:location'));

// ── trial mode uses the SAME single-page rule ───────────────────────────────
console.log('trial mode (characterMinAppearances=1, same as full):');
const trialResult = getElementsNeedingReferenceImages(vb, 2, 1).map(e => e.name);
check('trial INCLUDES 1-page "Sofia"', trialResult.includes('Sofia'));
check('trial INCLUDES 1-page "a guard"', trialResult.includes('a guard'));
check('trial still EXCLUDES 1-page location "Cave"', !trialResult.includes('Cave'));

console.log(`\nALL ${passed} CHECKS PASSED`);
