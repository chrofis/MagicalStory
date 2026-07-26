/**
 * Pt 8 — Secondary-character identity fix.
 *
 * Verifies getElementsNeedingReferenceImages now returns a NAMED secondary
 * character that appears on only ONE page (so it gets its own face reference
 * and can't inherit the primary's identity), while still:
 *   - excluding a generic / crowd secondary ("villagers", "a guard"),
 *   - excluding a 1-page LOCATION (non-character elements keep the 2-page gate),
 *   - excluding a secondary that already has a reference,
 *   - keeping the old behaviour for a 2-page location.
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

const {
  getElementsNeedingReferenceImages,
  isNamedIndividualCharacter,
} = require('../../server/lib/visualBible');
Module._load = origLoad;

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
};

// ── isNamedIndividualCharacter unit checks ──────────────────────────────────
console.log('isNamedIndividualCharacter:');
check('proper name "Sofia" is a named individual', isNamedIndividualCharacter('Sofia') === true);
check('two-word name "Frau Müller" is a named individual', isNamedIndividualCharacter('Frau Müller') === true);
check('singular role "Innkeeper" is a named individual', isNamedIndividualCharacter('Innkeeper') === true);
check('placeholder "Soldier1" is a named individual', isNamedIndividualCharacter('Soldier1') === true);
check('article-prefixed "a guard" is NOT a named individual', isNamedIndividualCharacter('a guard') === false);
check('article-prefixed "The Innkeeper" is NOT a named individual', isNamedIndividualCharacter('The Innkeeper') === false);
check('collective "villagers" is NOT a named individual', isNamedIndividualCharacter('villagers') === false);
check('collective "Soldiers" is NOT a named individual', isNamedIndividualCharacter('Soldiers') === false);
check('empty name is NOT a named individual', isNamedIndividualCharacter('') === false);
check('null name is NOT a named individual', isNamedIndividualCharacter(null) === false);

// ── getElementsNeedingReferenceImages integration ───────────────────────────
console.log('getElementsNeedingReferenceImages:');
const vb = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'Sofia', appearsInPages: [4], referenceImageGenerated: false }, // 1-page NAMED → include
    { id: 'CHR002', name: 'villagers', appearsInPages: [2, 5], referenceImageGenerated: false }, // generic crowd → exclude even at 2 pages
    { id: 'CHR003', name: 'a guard', appearsInPages: [3], referenceImageGenerated: false }, // article generic → exclude
    { id: 'CHR004', name: 'Otto', appearsInPages: [1], referenceImageGenerated: true }, // already has ref → exclude
    { id: 'CHR005', name: 'Grandpa Max', appearsInPages: [], referenceImageGenerated: false }, // no page → exclude (can't place)
  ],
  artifacts: [],
  animals: [],
  vehicles: [],
  locations: [
    { id: 'LOC001', name: 'Cave', appearsInPages: [7], isRealLandmark: false, referenceImageGenerated: false }, // 1-page location → exclude (2-page gate)
    { id: 'LOC002', name: 'Castle', appearsInPages: [1, 8], isRealLandmark: false, referenceImageGenerated: false }, // 2-page location → include
  ],
};

const result = getElementsNeedingReferenceImages(vb); // defaults: minAppearances=2, characterMinAppearances=1
const names = result.map(e => `${e.name}:${e.type}`);
console.log('  returned:', JSON.stringify(names));

check('1-page NAMED secondary "Sofia" IS included', names.includes('Sofia:character'));
check('generic 2-page "villagers" is EXCLUDED', !names.some(n => n.startsWith('villagers')));
check('article-generic "a guard" is EXCLUDED', !names.some(n => n.startsWith('a guard')));
check('already-referenced "Otto" is EXCLUDED', !names.some(n => n.startsWith('Otto')));
check('no-page "Grandpa Max" is EXCLUDED', !names.some(n => n.startsWith('Grandpa Max')));
check('1-page LOCATION "Cave" is EXCLUDED', !names.some(n => n.startsWith('Cave')));
check('2-page LOCATION "Castle" IS included', names.includes('Castle:location'));

// ── trial-mode gate (characterMinAppearances=2) preserves old behaviour ──────
console.log('trial gate (characterMinAppearances=2):');
const trialResult = getElementsNeedingReferenceImages(vb, 2, 2).map(e => e.name);
check('trial gate EXCLUDES 1-page "Sofia"', !trialResult.includes('Sofia'));
check('trial gate still includes 2-page "Castle"', trialResult.includes('Castle'));

console.log(`\nALL ${passed} CHECKS PASSED`);
