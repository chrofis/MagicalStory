/**
 * findCastMissingFromMetadata — the Art Director contradicting itself.
 *
 * WHY THIS EXISTS
 * The scene expansion emits prose plus a ---METADATA--- block. The image model
 * renders the PROSE; figure naming, the entity grid, clothing validation and
 * garment repair all supervise metadata `characters`. On staging story
 * job_1786397108357_q1fjbdzbx page 14 the prose describes five people in full
 * detail and `characters` lists three — the two extra were routed into
 * `objects[]` as CHR ids although both are main cast with avatars. They were
 * rendered, then never named, cropped, clothing-checked or repaired. The
 * emitted metadata equals the parsed metadata, so the parser is not at fault.
 *
 * The check WARNS, it never repairs. A cast name in prose does not prove the
 * person is in the frame: of the six pages the original sweep flagged, four
 * were possessives naming a place or a prop ("<Name>'s attic",
 * "<Name>'s torch") with the person absent from the picture entirely.
 *
 * server/lib/sceneMetadata.js is pure parsing and safe to require (images.js,
 * figureDetection.js, repairPipeline.js and entityConsistency.js are not).
 *
 * Run: node tests/manual/sceneCastConsistency.test.js
 */
'use strict';

const { findCastMissingFromMetadata } = require('../../server/lib/sceneMetadata');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));
const eq = (d, actual, expected) =>
  check(d, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

/** Build a scene description in the real prose + ---METADATA--- shape. */
const scene = (prose, listed, objects = []) => `${prose}\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'One moment.',
  characters: listed.map(name => ({ name, clothing: 'standard', position: 'center', depth: 'foreground', expression: 'calm, faint smile' })),
  objects,
  interactions: [],
  textPosition: 'bottom-left',
  emptyScenePrompt: 'An empty room.',
})}`;

const CAST = ['Aria', 'Bruno', 'Cato', 'Dora'];

console.log('\n── A described character missing from the list is detected ──');
{
  const s = scene('Aria reaches for the chest while Bruno leans over it. Cato stands as a smaller figure in the background on the left.', ['Aria', 'Bruno']);
  eq('the background figure is reported', findCastMissingFromMetadata(s, CAST), ['Cato']);
}
{
  const s = scene('Aria holds the letter up. Cato and Dora stand behind her, both back view.', ['Aria']);
  eq('two dropped characters come back in cast order', findCastMissingFromMetadata(s, CAST), ['Cato', 'Dora']);
}
{
  // The real shape of the p14 defect: the dropped pair sits in objects[] as
  // CHR ids. Declaring them as secondary characters does not excuse the
  // omission — they are cast members with avatars.
  const s = scene('Aria holds the letter toward Bruno. Cato and Dora stand as smaller figures in the background.', ['Aria', 'Bruno'], ['LOC006', 'CHR003', 'CHR004']);
  eq('a CHR id in objects[] does not excuse the omission', findCastMissingFromMetadata(s, CAST), ['Cato', 'Dora']);
}

console.log('\n── A character correctly present is never flagged ──');
{
  const s = scene('Aria reaches for the chest while Bruno leans over it.', ['Aria', 'Bruno']);
  eq('every described character listed → nothing', findCastMissingFromMetadata(s, CAST), []);
}
{
  const s = scene('Aria reaches for the chest.', ['Aria', 'Bruno']);
  eq('listed but not described → nothing (that is a different question)', findCastMissingFromMetadata(s, CAST), []);
}
{
  const s = scene('aria reaches for the chest while Bruno leans over it.', ['ARIA', 'bruno']);
  eq('the listed/cast comparison is case-insensitive', findCastMissingFromMetadata(s, CAST), []);
}

console.log('\n── Substring names do not false-positive ──');
{
  const s = scene('Anna kneels beside the open chest, both hands on the lid.', ['Anna']);
  eq('cast member "Ann" does not match "Anna"', findCastMissingFromMetadata(s, ['Ann', 'Anna']), []);
}
{
  const s = scene('Anna kneels beside the open chest while Ann watches from the doorway.', ['Anna']);
  eq('"Ann" as its own word is still caught', findCastMissingFromMetadata(s, ['Ann', 'Anna']), ['Ann']);
}
{
  const s = scene('Bruno walks past the Ariadne fountain in the square.', ['Bruno']);
  eq('a longer word starting with the name does not match', findCastMissingFromMetadata(s, ['Aria']), []);
}

console.log('\n── Possessives name places and props, not people ──');
{
  const s = scene("Bruno kneels on the dusty floorboards of Aria's attic, leaning over an open chest.", ['Bruno']);
  eq('"<Name>\'s attic" alone does not put the person in the frame', findCastMissingFromMetadata(s, CAST), []);
}
{
  const s = scene("At the cave entrance behind Bruno, Cato's phone torch throws a cone of white light.", ['Bruno']);
  eq('"<Name>\'s torch" alone does not either', findCastMissingFromMetadata(s, CAST), []);
}
{
  const s = scene("Bruno stands in Aria's attic while Aria pushes the shutter open.", ['Bruno']);
  eq('one bare mention alongside a possessive still counts', findCastMissingFromMetadata(s, CAST), ['Aria']);
}
{
  const s = scene("Bruno kneels on the floorboards of Aria’s attic.", ['Bruno']);
  eq('typographic apostrophe behaves like the straight one', findCastMissingFromMetadata(s, CAST), []);
}

console.log('\n── The metadata block itself is not searched ──');
{
  // Cato appears only inside the JSON (as a CHR id label), never in the prose.
  const s = `Aria reaches for the chest.\n\n---METADATA---\n${JSON.stringify({ characters: [{ name: 'Aria' }], objects: ['Cato figurine'] })}`;
  eq('a name that occurs only after ---METADATA--- is ignored', findCastMissingFromMetadata(s, CAST), []);
}

console.log('\n── Empty / missing input does not crash ──');
{
  eq('null description', findCastMissingFromMetadata(null, CAST), []);
  eq('empty description', findCastMissingFromMetadata('', CAST), []);
  eq('non-string description', findCastMissingFromMetadata({}, CAST), []);
  eq('no metadata block at all', findCastMissingFromMetadata('Aria reaches for the chest.', CAST), []);
  eq('metadata block present but unparseable', findCastMissingFromMetadata('Aria reaches.\n\n---METADATA---\n{not json', CAST), []);
  eq('no cast', findCastMissingFromMetadata(scene('Aria reaches.', []), []), []);
  eq('null cast', findCastMissingFromMetadata(scene('Aria reaches.', []), null), []);
  eq('cast with blank entries', findCastMissingFromMetadata(scene('Aria reaches.', []), ['', null, undefined]), []);
  eq('an empty characters list still reports', findCastMissingFromMetadata(scene('Aria reaches.', []), CAST), ['Aria']);
  const preParsed = { characters: ['Aria'] };
  eq('a caller-supplied metadata object is used as-is',
    findCastMissingFromMetadata('Aria reaches for the chest while Bruno leans over it.', CAST, preParsed), ['Bruno']);
  eq('caller-supplied metadata without a characters array is ignored',
    findCastMissingFromMetadata('Aria reaches.', CAST, { objects: [] }), []);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
