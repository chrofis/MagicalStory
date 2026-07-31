/**
 * Deterministic scene metadata ↔ scene design consistency validator — unit test.
 *
 * Synthetic pages with seeded mismatches must produce EXACTLY the expected
 * issue types; a clean page must produce none. Mechanical parity only — the
 * validator must never emit semantic judgments (facing, shared actions, poses);
 * those belong to the external outline reviewer (docs/decisions.md).
 *
 * Deterministic, no network / DB. Run:
 *   node tests/manual/test-scene-consistency-check.js
 */
const assert = require('assert');
const {
  checkSceneConsistency,
  formatSceneConsistencySummary,
  extractSceneSequenceCasts,
} = require('../../server/lib/sceneConsistencyCheck');

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
};

const KNOWN = ['Mira', 'Jonas'];

const meta = (obj) => JSON.stringify(obj);

// ─── 1. Clean page → zero issues ────────────────────────────────────────────

console.log('Clean page');
const cleanPage = {
  pageNumber: 1,
  sceneProse: 'Mira stands at the frosted window pressing both hands on the glass while Jonas watches from the doorway behind her.',
  sceneHint: meta({
    sceneIntent: 'Mira presses her hands on the window while Jonas watches.',
    characters: [
      { name: 'Mira', position: 'right foreground', depth: 'foreground', clothing: 'standard' },
      { name: 'Jonas', position: 'left midground', depth: 'midground', clothing: 'standard' }
    ],
    objects: [],
    interactions: [{ character: 'Mira', object: 'window', where: 'presses both hands on the window' }],
    background: 'bedroom, falling snow through window',
    emptyScenePrompt: 'Bedroom at dawn, tall frosted window on the right, doorway on the left.'
  })
};
const cleanResult = checkSceneConsistency([cleanPage], null, { knownCharacterNames: KNOWN });
check('clean page produces zero issues', cleanResult.length === 0);
check('summary of clean result is empty', formatSceneConsistencySummary(cleanResult).length === 0);

// ─── 2. Seeded mismatches → exact issue types ───────────────────────────────

console.log('Seeded mismatches');

// (b) metadata char absent from prose + prose char absent from metadata
const pageB = {
  pageNumber: 2,
  sceneProse: 'Jonas trudges alone across the snowy garden, arms out for balance.',
  sceneHint: meta({
    characters: [{ name: 'Mira', position: 'center midground', depth: 'midground', clothing: 'winter' }],
    objects: [],
    interactions: [],
    background: 'snowy garden',
    emptyScenePrompt: 'Snow-covered garden path.'
  })
};
const rB = checkSceneConsistency([pageB], null, { knownCharacterNames: KNOWN });
const typesB = rB[0].issues.map(i => i.type).sort();
check('metadata char absent from prose detected', typesB.includes('metadata_char_absent_from_prose'));
check('prose char absent from metadata detected', typesB.includes('prose_char_absent_from_metadata'));
check('exactly the two expected issue types on page 2', JSON.stringify(typesB) === JSON.stringify(['metadata_char_absent_from_prose', 'prose_char_absent_from_metadata']));
check('summary line format matches [SCENE-CONSISTENCY] P2: …', formatSceneConsistencySummary(rB).every(l => l.startsWith('[SCENE-CONSISTENCY] P2: ')));
check("detail names the missing char: \"metadata char 'Mira' absent from prose\"", rB[0].issues.some(i => i.detail === "metadata char 'Mira' absent from prose"));

// (c) interaction refs: unknown character, unknown target character, unanchored object
const pageC = {
  pageNumber: 3,
  sceneProse: 'Mira kneels beside the sled in the courtyard.',
  sceneHint: meta({
    characters: [{ name: 'Mira', position: 'left foreground', depth: 'foreground', clothing: 'winter' }],
    objects: ['sled'],
    interactions: [
      { character: 'Theo', object: 'sled', where: 'pulls the sled' },              // Theo not in characters[]
      { character: 'Mira', object: 'Jonas', where: 'waves to Jonas' },             // target char not in characters[]
      { character: 'Mira', object: 'golden trumpet', where: 'lifts the trumpet' }, // object anchored nowhere
      { character: 'Mira', object: 'sled', where: 'kneels beside the sled' }       // fine — in objects[] and prose
    ],
    background: 'castle courtyard',
    emptyScenePrompt: 'Snowy castle courtyard with a wooden sled near the gate.'
  })
};
const rC = checkSceneConsistency([pageC], null, { knownCharacterNames: KNOWN });
const typesC = rC[0].issues.map(i => i.type).sort();
check('interaction character not in characters[] detected', typesC.includes('interaction_char_unknown'));
check('interaction target character not in characters[] detected', typesC.includes('interaction_target_char_unknown'));
check('unanchored interaction object detected', typesC.includes('interaction_object_unanchored'));
check('valid interaction (sled) produced no issue', rC[0].issues.filter(i => i.detail.includes("'sled'")).length === 0);

// (d) position-phrase depth word vs depth field
const pageD = {
  pageNumber: 4,
  sceneProse: 'Mira stands tiny on the far ridge.',
  sceneHint: meta({
    characters: [{ name: 'Mira', position: 'far left foreground', depth: 'background', clothing: 'winter' }],
    objects: [],
    interactions: [],
    background: 'mountain ridge',
    emptyScenePrompt: 'Wide mountain ridge under a pale sky.'
  })
};
const rD = checkSceneConsistency([pageD], null, { knownCharacterNames: KNOWN });
check('position/depth mismatch detected', rD[0].issues.some(i => i.type === 'position_depth_mismatch'));
check('position/depth detail names both words', rD[0].issues.some(i => i.detail.includes("'foreground'") && i.detail.includes("depth='background'")));

// (e) sceneIntent names ⊆ characters[]
const pageE = {
  pageNumber: 5,
  sceneProse: 'Mira reads the letter by the fire.',
  sceneHint: meta({
    sceneIntent: 'Mira reads the letter while Jonas warms his hands.',
    characters: [{ name: 'Mira', position: 'center foreground', depth: 'foreground', clothing: 'standard' }],
    objects: ['letter'],
    interactions: [{ character: 'Mira', object: 'letter', where: 'reads the letter' }],
    background: 'fireside room',
    emptyScenePrompt: 'Warm fireside room.'
  })
};
const rE = checkSceneConsistency([pageE], null, { knownCharacterNames: KNOWN });
check('sceneIntent naming an absent character detected', rE[0].issues.some(i => i.type === 'scene_intent_char_absent' && i.detail.includes("'Jonas'")));

// ─── 3. Locked SCENE SEQUENCE cast vs METADATA cast ─────────────────────────

console.log('Locked scene-sequence cast');
const RAW = `---SCENE SEQUENCE---
**Scene 6**
Setting: garden — midday — snowy
Cast: Mira (midground, leading), Jonas (midground, following)
Action: Mira glances back mid-stride
Shot: wide — side
Arc note: opens up

---SCENE SEQUENCE CRITIQUE---
1. Picturability: fine.

---STORY DRAFT---
`;
check('extractSceneSequenceCasts parses the Cast line', extractSceneSequenceCasts(RAW).get(6).includes('Jonas'));

const pageF = {
  pageNumber: 6,
  sceneProse: 'Mira leads the way along the path.',
  sceneHint: meta({
    characters: [{ name: 'Mira', position: 'center midground', depth: 'midground', clothing: 'winter' }],
    objects: [],
    interactions: [],
    background: 'garden path',
    emptyScenePrompt: 'Snowy garden path.'
  })
};
const rF = checkSceneConsistency([pageF], RAW, { knownCharacterNames: KNOWN });
check('locked cast member missing from metadata detected', rF[0].issues.some(i => i.type === 'cast_char_missing_from_metadata' && i.detail.includes("'Jonas'")));

// reverse: metadata has a character the locked cast does not name
const pageG = {
  pageNumber: 6,
  sceneProse: 'Mira and Jonas walk the path while a guard watches.',
  sceneHint: meta({
    characters: [
      { name: 'Mira', position: 'center midground', depth: 'midground', clothing: 'winter' },
      { name: 'Jonas', position: 'left midground', depth: 'midground', clothing: 'winter' }
    ],
    objects: [],
    interactions: [],
    background: 'garden path',
    emptyScenePrompt: 'Snowy garden path.'
  })
};
const RAW_SOLO = RAW.replace('Cast: Mira (midground, leading), Jonas (midground, following)', 'Cast: Mira (midground, alone on the path)');
const rG = checkSceneConsistency([pageG], RAW_SOLO, { knownCharacterNames: KNOWN });
check('metadata character absent from locked cast detected', rG[0].issues.some(i => i.type === 'metadata_char_not_in_cast' && i.detail.includes("'Jonas'")));
check('no cast checks without a Scene block for the page', checkSceneConsistency([{ ...pageF, pageNumber: 9 }], RAW, { knownCharacterNames: KNOWN })
  .every(e => e.issues.every(i => !i.type.startsWith('cast_') && i.type !== 'metadata_char_not_in_cast')));

// ─── 4. Robustness ──────────────────────────────────────────────────────────

console.log('Robustness');
const rBadJson = checkSceneConsistency([{ pageNumber: 7, sceneProse: 'x', sceneHint: '{broken json' }], null, { knownCharacterNames: KNOWN });
check('unparseable metadata reported, not thrown', rBadJson[0].issues.some(i => i.type === 'metadata_parse_failed'));
check('empty inputs return empty results', checkSceneConsistency([], null, {}).length === 0 && checkSceneConsistency(null, null).length === 0);
check('CHR ids in metadata characters[] are not required in prose',
  checkSceneConsistency([{
    pageNumber: 8,
    sceneProse: 'Mira faces the shopkeeper across the counter.',
    sceneHint: meta({
      characters: [
        { name: 'Mira', position: 'left foreground', depth: 'foreground', clothing: 'standard' },
        { name: 'CHR001', position: 'right midground', depth: 'midground', clothing: 'standard' }
      ],
      objects: [], interactions: [], background: 'shop', emptyScenePrompt: 'Shop interior with a wooden counter.'
    })
  }], null, { knownCharacterNames: KNOWN }).length === 0);
// The validator must stay mechanical: every emitted type must be on the
// closed mechanical-parity whitelist (no facing/gaze/pose/garment semantics).
const MECHANICAL_TYPES = new Set([
  'metadata_parse_failed',
  'cast_char_missing_from_metadata', 'metadata_char_not_in_cast',
  'metadata_char_absent_from_prose', 'prose_char_absent_from_metadata',
  'interaction_char_unknown', 'interaction_target_char_unknown', 'interaction_object_unanchored',
  'position_depth_mismatch', 'scene_intent_char_absent',
]);
const allTypes = [rB, rC, rD, rE, rF, rG, rBadJson].flatMap(r => r.flatMap(e => e.issues.map(i => i.type)));
check('only whitelisted mechanical issue types emitted (no semantic types)', allTypes.every(t => MECHANICAL_TYPES.has(t)));

console.log(`\nPASS: ${passed} checks — scene-consistency validator emits exact mechanical findings only.`);
