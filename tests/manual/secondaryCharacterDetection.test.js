/**
 * Story-invented characters must reach figure detection.
 *
 * WHY THIS EXISTS
 * `stories.data.characters[]` is the user's photo-backed cast — every entry has
 * uploaded photos and generated avatars. A character the writer invents (a
 * mermaid, a guard, a shopkeeper) has neither, so it lives ONLY in
 * `visualBible.secondaryCharacters`. Every path that built the detector's
 * expected-character list from the cast alone dropped it.
 *
 * Measured on staging story job_1786737619634_d66c7bg9g page 4 (Emma, Noah and
 * Lira, an invented mermaid): bboxDetection.expectedCharacters was
 * [Emma, Noah] while sceneMetadata.characters / characterClothing /
 * outlineCharacters all named Lira. With 3 badges and 2 names the
 * Set-of-Mark prompt takes its LENIENT branch ("assign rather than unknown")
 * and answered {A:"Emma", B:"unknown", C:"Noah"} — badge A was the mermaid, so
 * a green-eyed teal-haired adult got the preschooler's name and the real Emma
 * came back unknown. Reproduced on job_1786571353564_0sgrd0f4g page 4.
 *
 * promptBuilders.js and sceneMetadata.js are pure builders and safe to require;
 * images.js is NOT (it initialises services and hangs), so the two call sites
 * are asserted at source level.
 *
 * Run: node tests/manual/secondaryCharacterDetection.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { buildSecondaryCharacterDescriptions, buildCharacterDescriptionsForBbox } = require('../../server/lib/promptBuilders');
const { collectSceneCharacterNames } = require('../../server/lib/sceneMetadata');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));
const eq = (d, actual, expected) =>
  check(d, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const t = (name, fn) => { try { fn(); } catch (e) { failed++; console.log(`FAIL  ${name} threw: ${e.message}`); } };

// The real page-4 shapes, trimmed. Lira = visualBible.secondaryCharacters[0].
const LIRA = {
  id: 'CHR001',
  name: 'Lira',
  age: 'appears young adult',
  build: 'slender, tall upper body, long mermaid tail replacing legs from the hips down',
  hair: 'long, loose, flowing to waist, deep teal-green colour',
  face: 'large luminous green eyes, light skin with a faint iridescent shimmer, softly pointed chin, high cheekbones',
  clothing: 'fitted teal-green swim top with a scooped neckline',
  signatureLook: 'iridescent silver-and-teal mermaid tail with large overlapping scales',
  pages: [4, 9],
};
const VB = { secondaryCharacters: [LIRA], animals: [] };
const SCENE_META = {
  characters: ['Emma', 'Noah', 'Lira'],
  characterPositions: { Emma: 'center-left', Lira: 'center-right', Noah: 'right' },
  characterClothing: { Emma: 'summer', Lira: 'costumed', Noah: 'summer' },
};
const CAST = ['Emma', 'Noah'];

t('scene name collection', () => {
  eq('all three carriers merge, first spelling wins',
    collectSceneCharacterNames(SCENE_META), ['Emma', 'Noah', 'Lira']);
  eq('object-shaped characters entries are read by .name',
    collectSceneCharacterNames({ characters: [{ name: 'Emma' }, { name: 'Lira' }] }), ['Emma', 'Lira']);
  eq('clothing-only metadata still yields the cast',
    collectSceneCharacterNames({ characterClothing: { Lira: 'costumed' } }), ['Lira']);
  eq('outlineCharacters are merged in',
    collectSceneCharacterNames({ characters: ['Emma'] }, ['Lira']), ['Emma', 'Lira']);
  eq('null metadata is empty, not a throw', collectSceneCharacterNames(null), []);
  eq('blank names dropped', collectSceneCharacterNames({ characters: ['', '  ', null] }), []);
});

t('secondary resolution', () => {
  const out = buildSecondaryCharacterDescriptions(VB, collectSceneCharacterNames(SCENE_META), CAST, 'PAGE 4 ');
  eq('only the secondary is added — the photo-backed cast is not duplicated',
    Object.keys(out), ['Lira']);
  check('the description is non-empty and names the character',
    typeof out.Lira.richDescription === 'string' && out.Lira.richDescription.startsWith('Lira (secondary character).'),
    out.Lira.richDescription);
  for (const cue of ['young adult', 'teal-green', 'luminous green eyes']) {
    check(`description carries the distinguishing cue "${cue}"`, out.Lira.richDescription.includes(cue));
  }
  check('a VB entry with an explicit description prefers it',
    buildSecondaryCharacterDescriptions({ secondaryCharacters: [{ name: 'Ida', description: 'a tall guard in mail' }] },
      ['Ida'], []).Ida.richDescription === 'Ida (secondary character). a tall guard in mail');
  check('a VB-id reference resolves and keys by the id the scene used',
    !!buildSecondaryCharacterDescriptions(VB, ['CHR001'], []).CHR001);
  // REVERSED 2026-08-19 (owner): animals are NOT expected characters. DINO
  // detects `person`, so an animal in the expected list is a guaranteed
  // "missing person" — it fires the undercount, routes the page to the Gemini
  // second opinion, and hands the identity call a name no person badge can
  // carry. Animals stay detectable through the OBJECT pass instead. This
  // assertion is inverted on purpose; restoring it would restore that bug.
  check('tracked animals are NOT resolved as characters (object pass owns them)',
    buildSecondaryCharacterDescriptions({ animals: [{ name: 'Floh', species: 'terrier' }] }, ['Floh'], [])
      .Floh === undefined);
});

t('scope — never invent, never dump the whole Visual Bible', () => {
  const page9only = { secondaryCharacters: [LIRA, { id: 'CHR002', name: 'Bo', description: 'a ferryman' }] };
  eq('a secondary the scene does not reference is not added',
    Object.keys(buildSecondaryCharacterDescriptions(page9only, collectSceneCharacterNames(SCENE_META), CAST)), ['Lira']);
  eq('a scene with no secondaries is a no-op',
    buildSecondaryCharacterDescriptions(VB, ['Emma', 'Noah'], CAST), {});
  eq('a cast name matching a VB entry is never re-added (case-insensitive)',
    buildSecondaryCharacterDescriptions(VB, ['lira'], ['LIRA']), {});
  eq('a referenced name with no VB entry is skipped (logged, stays a missingCharacters signal)',
    buildSecondaryCharacterDescriptions(VB, ['Ghost'], CAST), {});
});

t('malformed Visual Bible never throws', () => {
  const names = collectSceneCharacterNames(SCENE_META);
  eq('visualBible absent', buildSecondaryCharacterDescriptions(null, names, CAST), {});
  eq('secondaryCharacters absent', buildSecondaryCharacterDescriptions({}, names, CAST), {});
  eq('secondaryCharacters empty', buildSecondaryCharacterDescriptions({ secondaryCharacters: [] }, names, CAST), {});
  eq('secondaryCharacters is an object, not an array',
    buildSecondaryCharacterDescriptions({ secondaryCharacters: { CHR001: LIRA } }, names, CAST), {});
  eq('sceneNames absent', buildSecondaryCharacterDescriptions(VB, null, CAST), {});
  eq('knownNames absent still resolves', Object.keys(buildSecondaryCharacterDescriptions(VB, ['Lira'])), ['Lira']);
});

t('buildCharacterDescriptionsForBbox — cast first, unchanged', () => {
  const storyData = {
    characters: [{ name: 'Emma', gender: 'female', apparentAge: 'preschooler' }, { name: 'Noah', gender: 'male' }],
    visualBible: VB,
  };
  const out = buildCharacterDescriptionsForBbox(storyData, SCENE_META.characterPositions);
  eq('photo-backed cast comes first, secondary appended', Object.keys(out), ['Emma', 'Noah', 'Lira']);
  check('cast entries keep their rich description + grounding prompt',
    typeof out.Emma.richDescription === 'string' && out.Emma.richDescription.includes('Emma')
    && typeof out.Emma.gdinoIdentity === 'string' && !!out.Emma.clothingDescriptions);
  check('the secondary carries a description, not a bare name',
    out.Lira.richDescription.length > 40);
  const noVb = buildCharacterDescriptionsForBbox({ characters: storyData.characters }, SCENE_META.characterPositions);
  eq('no Visual Bible → cast only, byte-identical to before',
    JSON.stringify(noVb), JSON.stringify({ Emma: out.Emma, Noah: out.Noah }));
});

t('call sites wired (source-level — images.js hangs if required)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf-8');
  const pipeline = read('storyJobPipeline.js');
  const images = read('server/lib/images.js');
  const repair = read('server/lib/repairPipeline.js');
  // The three sites that build expectedCharacters straight from sceneCharacters
  // and hand it to detectAllBoundingBoxes — the shared pre-detection is the one
  // whose list actually reached SoM on the measured pages (its result is reused
  // by enrichWithBoundingBoxes as sharedBboxDetection).
  check('shared pre-detection appends secondaries',
    /expectedCharacters\.push\(\.\.\.buildSecondaryExpectedCharacters\(/.test(pipeline));
  // The storyHelpers handle is reached either through getStoryHelpers() or a
  // hoisted local alias (`sh`). What matters is that the site appends
  // secondaries at all, not how it names the module.
  check('repair round re-detect appends secondaries',
    /expectedCharacters\.push\(\.\.\.(?:getStoryHelpers\(\)|sh|shBbox)\.buildSecondaryExpectedCharacters\(/.test(repair));
  check('iterate path appends secondaries',
    /iterExpectedCharacters\.push\(\.\.\.(?:getStoryHelpers\(\)|sh|shBbox)\.buildSecondaryExpectedCharacters\(/.test(images));
  check('batch eval merges secondaries into characterDescriptions',
    images.includes('buildSecondaryCharacterDescriptions(')
    && images.includes('Object.assign(characterDescriptions, sceneOnly)'));
  check('secondaries are NOT added to the photo-backed cast array',
    !/(storyData|inputData|data)\.characters\.push\(/.test(pipeline + images + repair));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
