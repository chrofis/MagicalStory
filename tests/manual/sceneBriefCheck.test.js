/**
 * sceneBriefCheck — the two deterministic brief contradictions handed to the
 * scene review before any image is generated.
 *
 * WHY THIS EXISTS
 * A scene brief is written in two halves by one call: prose the image model
 * renders, and a JSON block every downstream supervisor reads. Nothing
 * reconciles them. On staging story job_1786397108357_q1fjbdzbx page 14 the
 * prose describes five people and `characters[]` lists three, while `objects[]`
 * carries CHR003/CHR004 — ids no visual-bible entry has, because main
 * characters use numeric ids and `secondaryCharacters` was empty. The two
 * missing people were rendered with no avatar reference, and figure naming then
 * stamped "Hans" on Daniel.
 *
 * The module REPORTS. It never invents a `characters[]` entry or a visual-bible
 * figure — the reviewer wrote both halves and resolves the contradiction.
 *
 * server/lib/sceneBriefCheck.js requires only sceneMetadata.js (pure parsing).
 * images.js, figureDetection.js, repairPipeline.js and entityConsistency.js
 * hang on require and are never pulled in.
 *
 * Run: node tests/manual/sceneBriefCheck.test.js
 */
'use strict';

const { checkPage, checkScenes, renderFindingsBlock, knownIds, REVIEWABLE } = require('../../server/lib/sceneBriefCheck');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));
const eq = (d, actual, expected) =>
  check(d, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

/** A brief in the real prose + ---METADATA--- shape. */
const brief = (prose, listed, objects = []) => `${prose}\n\n---METADATA---\n${JSON.stringify({
  sceneIntent: 'One moment.',
  characters: listed.map(name => ({ name, clothing: 'standard', position: 'center', depth: 'foreground', expression: 'calm, faint smile' })),
  objects,
  interactions: [],
  textPosition: 'bottom-left',
  emptyScenePrompt: 'An empty room.',
})}`;

const CAST = ['Aria', 'Bruno', 'Cato', 'Dora'];
const VB = {
  mainCharacters: [{ id: 1786395553134, name: 'Aria' }, { id: 1786395601679, name: 'Bruno' }],
  secondaryCharacters: [],
  animals: [],
  artifacts: [{ id: 'ART001', name: 'A brass key' }, { id: 'ART002', name: 'A lantern' }],
  locations: [{ id: 'LOC001', name: 'The attic' }, { id: 'LOC003', name: 'The market square' }],
  vehicles: [],
  clothing: [{ id: 'CLO001', name: 'A striped shirt' }],
};

const types = (findings) => findings.map(f => f.type);

console.log('\n── Check A: cast in the prose, absent from characters[] ──');
{
  const p = { pageNumber: 14, brief: brief('Aria reaches for the chest while Bruno leans over it. Cato stands smaller in the background.', ['Aria', 'Bruno']) };
  const f = checkPage(p, CAST, VB);
  eq('the unlisted figure is reported once', types(f), ['cast_unlisted']);
  eq('it names who the prose describes', f[0].names, ['Cato']);
  check('the detail states both halves', /prose names Cato/.test(f[0].detail) && /characters\[\] lists Aria, Bruno/.test(f[0].detail), f[0].detail);
  check('the detail is not an order', !/MUST|CRITICAL|do not/i.test(f[0].detail), f[0].detail);
}
{
  const p = { pageNumber: 3, brief: brief("The lantern hangs in Aria's attic; Bruno's torch lies beside it. Aria and Bruno crouch over the map.", ['Aria', 'Bruno']) };
  eq('possessives naming a place or a prop put nobody in the frame', types(checkPage(p, CAST, VB)), []);
}
{
  const p = { pageNumber: 4, brief: brief('Aria reaches for the chest while Bruno leans over it.', ['Aria', 'Bruno']) };
  eq('a brief whose halves agree produces nothing', types(checkPage(p, CAST, VB)), []);
}

console.log('\n── Check B: ids in objects[] that resolve to nothing ──');
{
  const p = { pageNumber: 14, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['LOC001', 'ART001', 'CLO001']) };
  eq('every id resolving means no finding', types(checkPage(p, CAST, VB)), []);
}
{
  const p = { pageNumber: 14, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['LOC001', 'CHR003', 'CHR004']) };
  const f = checkPage(p, CAST, VB);
  eq('dangling CHR ids are reported as their own type', types(f), ['cast_id_unresolved']);
  eq('both ids are named', f[0].ids, ['CHR003', 'CHR004']);
}
{
  const p = { pageNumber: 5, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['ART001', 'ART016']) };
  const f = checkPage(p, CAST, VB);
  eq('a dangling non-character id is a separate type', types(f), ['object_id_unresolved']);
  eq('only the unresolved id is named', f[0].ids, ['ART016']);
}
{
  const p = { pageNumber: 6, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['CHR003', 'ART016']) };
  eq('the two id findings are independent', types(checkPage(p, CAST, VB)), ['cast_id_unresolved', 'object_id_unresolved']);
}
{
  const p = { pageNumber: 7, brief: brief('Aria and Bruno cross the square.', ['Aria', 'Bruno'], ['LOC003.1', 'LOC003.2']) };
  eq('a landmark variant resolves to its base id', types(checkPage(p, CAST, VB)), []);
}
{
  const p = { pageNumber: 8, brief: brief('Aria and Bruno cross the square.', ['Aria', 'Bruno'], ['LOC009.1']) };
  eq('a variant of an unknown base is still reported', checkPage(p, CAST, VB)[0].ids, ['LOC009.1']);
}
{
  const p = { pageNumber: 9, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['a brass key', 'the attic door']) };
  eq('free text in objects[] is not an id claim', types(checkPage(p, CAST, VB)), []);
}
{
  const p = { pageNumber: 10, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['chr003', 'art016']) };
  eq('lower-case ids resolve the same way', types(checkPage(p, CAST, VB)), ['cast_id_unresolved', 'object_id_unresolved']);
}
{
  // A main character carries a numeric id, so CHR ids never resolve against it.
  const p = { pageNumber: 11, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno'], ['CHR001']) };
  eq('mainCharacters is not an id namespace', types(checkPage(p, CAST, VB)), ['cast_id_unresolved']);
  const vb2 = { ...VB, secondaryCharacters: [{ id: 'CHR001', name: 'A market trader' }] };
  eq('a secondary character with that id resolves it', types(checkPage(p, CAST, vb2)), []);
}

console.log('\n── Empty / missing input does not crash ──');
{
  const noObjects = { pageNumber: 1, brief: brief('Aria and Bruno crouch over the map.', ['Aria', 'Bruno']) };
  eq('missing objects[]', types(checkPage(noObjects, CAST, VB)), []);
  const nullObjects = { pageNumber: 1, brief: 'Aria and Bruno crouch.\n\n---METADATA---\n{"characters":[{"name":"Aria"},{"name":"Bruno"}],"objects":null}' };
  eq('objects[] null', types(checkPage(nullObjects, CAST, VB)), []);
  const mixed = { pageNumber: 1, brief: brief('Aria and Bruno crouch.', ['Aria', 'Bruno'], [null, 42, { id: 'ART016' }, 'CHR003']) };
  eq('non-string entries are skipped', types(checkPage(mixed, CAST, VB)), ['cast_id_unresolved']);
  eq('no brief', types(checkPage({ pageNumber: 1, brief: '' }, CAST, VB)), []);
  eq('no page at all', types(checkPage(null, CAST, VB)), []);
  eq('no metadata block', types(checkPage({ pageNumber: 1, brief: 'Aria and Bruno crouch.' }, CAST, VB)), []);
  eq('unparseable metadata', types(checkPage({ pageNumber: 1, brief: 'Aria crouches.\n\n---METADATA---\n{not json' }, CAST, VB)), []);
  eq('no cast', types(checkPage({ pageNumber: 1, brief: brief('Aria crouches.', [], ['CHR003']) }, [], VB)), ['cast_id_unresolved']);
  eq('no visual bible at all flags every id', checkPage({ pageNumber: 1, brief: brief('Aria and Bruno crouch.', ['Aria', 'Bruno'], ['ART001']) }, CAST, null)[0].ids, ['ART001']);
  eq('an empty visual bible has no known ids', knownIds({}).size, 0);
  eq('a visual bible whose collections are not arrays', knownIds({ artifacts: 'nope', locations: null }).size, 0);
}

console.log('\n── checkScenes indexes by page and survives a bad page ──');
{
  const pages = [
    { pageNumber: 1, brief: brief('Aria crouches.', ['Aria']) },
    { pageNumber: 2, brief: brief('Aria reaches while Cato watches.', ['Aria'], ['CHR003']) },
    null,
    { pageNumber: 4, brief: brief('Aria crouches.', ['Aria'], ['ART016']) },
  ];
  const res = checkScenes(pages, CAST, VB);
  eq('findings from every good page', types(res.findings), ['cast_unlisted', 'cast_id_unresolved', 'object_id_unresolved']);
  eq('indexed by page number', [...res.byPage.keys()], [2, 4]);
  eq('null pages are skipped, not fatal', res.byPage.get(4).length, 1);
  eq('empty input', checkScenes([], CAST, VB).findings.length, 0);
  eq('null input', checkScenes(null, CAST, VB).findings.length, 0);
}

console.log('\n── Rendering: only the reviewable types reach the prompt ──');
{
  eq('nothing found renders nothing', renderFindingsBlock(new Map()), '');
  eq('a null index renders nothing', renderFindingsBlock(null), '');
  const diagnosticOnly = checkScenes([{ pageNumber: 4, brief: brief('Aria crouches.', ['Aria'], ['ART016']) }], CAST, VB);
  eq('a page carrying only a diagnostic type renders nothing', renderFindingsBlock(diagnosticOnly.byPage), '');

  const res = checkScenes([
    { pageNumber: 4, brief: brief('Aria crouches.', ['Aria'], ['ART016']) },
    { pageNumber: 14, brief: brief('Aria reaches while Cato watches.', ['Aria'], ['CHR003']) },
    { pageNumber: 2, brief: brief('Aria reaches while Dora watches.', ['Aria']) },
  ], CAST, VB);
  const block = renderFindingsBlock(res.byPage);
  check('the block is headed', block.startsWith('# BRIEF CONTRADICTIONS'), block.slice(0, 40));
  check('pages are listed in order', block.indexOf('- Page 2:') < block.indexOf('- Page 14:'), block);
  check('the diagnostic-only page is absent', !block.includes('- Page 4:') && !block.includes('ART016'), block);
  check('each line carries its type tag', block.includes('[cast_unlisted]') && block.includes('[cast_id_unresolved]'), block);
  check('the reviewer is allowed to decline', /judge each one/.test(block), block);
  check('no MUST/CRITICAL banner', !/\bMUST\b|CRITICAL/.test(block), block);

  eq('the sent types are exactly the two', [...REVIEWABLE].sort(), ['cast_id_unresolved', 'cast_unlisted']);
  check('object_id_unresolved is computed but withheld', !REVIEWABLE.has('object_id_unresolved'));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
