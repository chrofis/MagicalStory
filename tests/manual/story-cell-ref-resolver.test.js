/**
 * resolveSheetForRef — the SINGLE resolver behind all three cell-crop sites
 * (applyStoryCellRefs, the iterate path in images.js, the regeneration route).
 *
 * Pins the behaviour that matters: a missing sheet falls back to the costumed
 * one, but NEVER silently — the ref's clothingCategory is corrected to what was
 * actually sent. A silent fallback rendered `standard` pages in costume for
 * three runs before it was caught (job_1786826686448 p1, job_1786868241158 p1+p6).
 *
 *   node tests/manual/story-cell-ref-resolver.test.js
 */
const {
  projectStoryCharacterAvatars,
  resolveSheetForRef,
} = require('../../server/lib/storyAvatars');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const both = projectStoryCharacterAvatars([{
  name: 'Emma',
  avatars: { styledAvatars: { watercolor: {
    costumed: { wizard: 'data:image/jpeg;base64,COSTUMED' },
    standard: 'data:image/jpeg;base64,STANDARD',
  } } },
}], 'watercolor').Emma;

check('projects both slots', both.costumed === 'data:image/jpeg;base64,COSTUMED'
  && both['styled-standard'] === 'data:image/jpeg;base64,STANDARD');

const rStd = resolveSheetForRef(both, { name: 'Emma', clothingCategory: 'standard' });
check('standard resolves to the standard sheet', rStd.uri === 'data:image/jpeg;base64,STANDARD');
check('standard slot key', rStd.slotKey === 'styled-standard', rStd.slotKey);

const rCos = resolveSheetForRef(both, { name: 'Emma', clothingCategory: 'costumed:wizard' });
check('costumed:<type> resolves to the costumed sheet', rCos.uri === 'data:image/jpeg;base64,COSTUMED');

// No standard sheet → falls back, and SAYS so on the ref.
const costumedOnly = projectStoryCharacterAvatars([{
  name: 'Emma',
  avatars: { styledAvatars: { watercolor: { costumed: { wizard: 'data:image/jpeg;base64,COSTUMED' } } } },
}], 'watercolor').Emma;
const refFallback = { name: 'Emma', clothingCategory: 'standard' };
const rFall = resolveSheetForRef(costumedOnly, refFallback);
check('missing standard falls back to costumed', rFall.uri === 'data:image/jpeg;base64,COSTUMED');
check('fallback corrects the ref label (no silent swap)', refFallback.clothingCategory === 'costumed');
check('fallback reports the slot it actually used', rFall.slotKey === 'costumed', rFall.slotKey);

// Nothing stored at all → null, caller keeps its existing ref.
check('no sheets → null', resolveSheetForRef({}, { name: 'Emma', clothingCategory: 'standard' }) === null);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
