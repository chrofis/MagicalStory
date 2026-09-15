/**
 * Creature-tone block resolution by focus age (free, no API calls).
 *   node tests/manual/test-creature-tone.js
 */
const pb = require('../../server/lib/promptBuilders');

const cases = [1, 3, 4, 5, 6, 7, 8, null];

for (const age of cases) {
  const inputData = {
    characters: [
      { id: 'c1', name: 'Focus', age: age === null ? undefined : String(age) },
      { id: 'c2', name: 'Sibling', age: '3' },
    ],
    mainCharacters: ['c1'],
    languageLevel: '1st-grade',
  };
  const band = pb.resolveAgeBand(inputData);
  const tone = pb.buildCreatureToneSection(inputData);
  console.log(`\n=== ${age === null ? '(missing age)' : `age ${age}`} ===`);
  console.log(`age=${age === null ? '(missing)' : age}  band=${band}  tone=${tone ? `${tone.length} chars` : '(EMPTY — no instruction)'}`);
  if (tone) console.log(`    ${tone}`);
}
