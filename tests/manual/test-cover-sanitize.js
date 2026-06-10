// Sanity test: cover plate description stripping + VB-id sanitizing,
// reproducing story job_1781086474294_tg9acidkv's initial page exactly.
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const { sanitizeVbIdsInPrompt } = require('../../server/lib/storyHelpers');

// stripCharacterSentences isn't exported — replicate via the module under test
const coverIterate = require('../../server/lib/coverIterate');

const sceneDescription =
  'Warm family adventure. A wide group portrait set before Feuerwehrstation. ' +
  'Matej, 4-year-old male, stands in the center foreground, eyes on the viewer. ' +
  'Andrej, 7-year-old male, stands in the right midground, holds the ART002, eyes on the viewer. ' +
  'Mama Sanja, 40-year-old female, stands in the left midground, eyes on the viewer. ' +
  'Tata Miko, 40-year-old male, stands in the right background, holds the ART005, eyes on the viewer.';

const visualBible = {
  artifacts: [
    { id: 'ART002', name: 'Wasserwerfer-Hebel' },
    { id: 'ART005', name: 'Feuerwehrhelm' },
  ],
  mainCharacters: [{ id: 'CHR001', name: 'Matej' }],
  secondaryCharacters: [
    { id: 'CHR002', name: 'Andrej' },
    { id: 'CHR003', name: 'Tata Miko' },
    { id: 'CHR004', name: 'Mama Sanja' },
  ],
  locations: [], vehicles: [], animals: [], clothing: [],
};

// 1. Final cover prompt sanitize: raw ids resolve to names
const promptIn = `**SCENE:**\n${sceneDescription}`;
const promptOut = sanitizeVbIdsInPrompt(promptIn, visualBible, -2);
console.log('--- final prompt after sanitize ---');
console.log(promptOut);
console.assert(!/ART\d+/.test(promptOut), 'FAIL: raw ART id survived in final prompt');
console.assert(promptOut.includes('Wasserwerfer-Hebel'), 'FAIL: ART002 not resolved to name');
console.assert(promptOut.includes('Feuerwehrhelm'), 'FAIL: ART005 not resolved to name');

// 2. Orphan id: line is dropped with a WARN
const orphanOut = sanitizeVbIdsInPrompt('keep this line\nAndrej holds the ART099.\nkeep this too', visualBible, -2);
console.assert(!orphanOut.includes('ART099'), 'FAIL: orphan id survived');
console.assert(orphanOut.includes('keep this line') && orphanOut.includes('keep this too'), 'FAIL: dropped wrong lines');

// 3. Plate description: character sentences stripped, setting survives,
//    composition starters rewritten to setting-only views
const { buildPlateDescription } = coverIterate;
const names = ['Matej', 'Andrej', 'Tata Miko', 'Mama Sanja'];
const plateRaw = `**SETTING:** ${sceneDescription}\n**CAMERA:** wide shot`;
const plateOut = buildPlateDescription(plateRaw, names, visualBible, -2);
console.log('\n--- plate description after strip + sanitize ---');
console.log(plateOut);
console.assert(!/Matej|Andrej|Tata Miko|Mama Sanja/.test(plateOut), 'FAIL: character name survived in plate');
console.assert(!/ART\d+/.test(plateOut), 'FAIL: raw ART id survived in plate');
console.assert(plateOut.includes('Feuerwehrstation'), 'FAIL: setting/landmark stripped from plate');
console.assert(plateOut.includes('**CAMERA:** wide shot'), 'FAIL: camera line lost');
console.assert(!/group portrait|portrait of/i.test(plateOut), 'FAIL: people-composition phrase survived in plate');

// 4. Starter variants for 1- and 2-character covers
const two = buildPlateDescription(
  'A portrait of two characters set before Munot. Only these two people appear; no other figures, no crowd. Matej stands left.',
  ['Matej'], visualBible, -1);
console.assert(!/portrait|two people|Matej/i.test(two) && two.includes('Munot'), `FAIL: two-char starter: "${two}"`);
const one = buildPlateDescription(
  'A portrait of a single character set before Munot. Only this one person appears; no other figures, no crowd.',
  ['Matej'], visualBible, -1);
console.assert(!/portrait|one person/i.test(one) && one.includes('Munot'), `FAIL: one-char starter: "${one}"`);

console.log('\n✓ all assertions passed');
