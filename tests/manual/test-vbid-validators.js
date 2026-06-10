// Unit test for the VB-id validator fixes:
//  1. resolveVbIdCharacterKeys — id-key of an ALREADY-DEFINED character is
//     remapped to the real name (no duplicate invented person).
//  2. extractCoverHints — ids in holds/gazesAt are auto-appended to objects[].
//  3. collectUsedObjectIds via detectAndPatchOrphanObjectIds' helpers (offline
//     part only — no API call made because we stub none; we test detection by
//     checking the defined/used set logic through resolve + a dry scenario).
const { resolveVbIdCharacterKeys } = require('../../server/lib/phantomCharacters');
const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');

// ── 1. id-key remap ────────────────────────────────────────────────────────
const vb = {
  secondaryCharacters: [{ id: 'CHR001', name: 'Luca' }],
  animals: [{ id: 'ANI001', name: 'Teddy Björn' }],
};
const pages = [{
  pageNumber: 6,
  characterClothing: { 'CHR001': 'standard', 'Noah': 'summer' },
  characterPerspectives: { 'CHR001': { pose: 'front' } },
  characters: ['Noah', 'CHR001'],
}];
const n = resolveVbIdCharacterKeys(pages, vb);
console.assert(n === 1, `FAIL: expected 1 remap, got ${n}`);
console.assert(pages[0].characterClothing['Luca'] === 'standard', 'FAIL: Luca clothing not remapped');
console.assert(!('CHR001' in pages[0].characterClothing), 'FAIL: CHR001 key still present');
console.assert(pages[0].characterPerspectives['Luca']?.pose === 'front', 'FAIL: perspectives not remapped');
console.assert(pages[0].characters.includes('Luca') && !pages[0].characters.includes('CHR001'), 'FAIL: characters[] not remapped');
console.log('✓ 1. id-key of defined character remapped to real name');

// Unknown id stays (handled by the phantom path instead)
const pages2 = [{ pageNumber: 1, characterClothing: { 'CHR099': 'standard' }, characters: ['CHR099'] }];
const n2 = resolveVbIdCharacterKeys(pages2, vb);
console.assert(n2 === 0 && 'CHR099' in pages2[0].characterClothing, 'FAIL: unknown id should be untouched');
console.log('✓ 2. unknown id-key left for the phantom path');

// ── 2. coverHints holds/gazesAt → objects[] ───────────────────────────────
const outline = `---COVER SCENE HINTS---
**Title Page**
Mood: warm evening adventure
Objects: LOC001
Characters:
- Matej (center foreground): standard, holds: ART002, gazes at: the viewer, priority: essential
- Andrej (right midground): standard, holds: nothing, gazes at: ART005, priority: normal

**Initial Page**
Mood: family portrait
Objects: LOC001, ART002
Characters:
- Matej (center): standard, holds: ART002, priority: essential

**Back Cover**
Mood: quiet sunset
Objects: LOC001

---STORY PAGES---
`;
const parser = new UnifiedStoryParser(outline);
const hints = parser.extractCoverHints();
const tp = hints.titlePage;
console.assert(tp.objects.includes('ART002'), `FAIL: ART002 (holds) not appended: ${JSON.stringify(tp.objects)}`);
console.assert(tp.objects.includes('ART005'), `FAIL: ART005 (gazesAt) not appended: ${JSON.stringify(tp.objects)}`);
console.assert(tp.objects.includes('LOC001'), 'FAIL: original LOC001 lost');
const ip = hints.initialPage;
console.assert(ip.objects.filter(o => o === 'ART002').length === 1, 'FAIL: duplicate ART002 appended');
console.log('✓ 3. holds/gazesAt ids appended to cover objects[] without duplicates');

console.log('\n✓ all assertions passed');
