/**
 * Regression: the trial's seeded preview avatar is served as a FULL image, and
 * a real 2×4 sheet is still cropped into cells.
 *
 * Two bugs this pins:
 *  1. setStyledAvatar() writes only the module cache, but the reference path
 *     reads char.avatars.styledAvatars[artStyle].standard — so seeding the
 *     cache alone left `standard` pages taking the costumed fallback
 *     (job_1786868241158 p1 + p6: Emma in the wizard robe in her bedroom).
 *  2. cropAvatarCell slices a 4-column grid. The preview avatar is a single
 *     full-body illustration, so cropping a "cell" out of it would hand the
 *     model a vertical quarter-slice.
 *
 *   node tests/manual/trial-standard-fullimage-ref.test.js
 */
const {
  projectStoryCharacterAvatars,
  resolveSheetForRef,
  applyStoryCellRefs,
} = require('../../server/lib/storyAvatars');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// A trial character: costumed 2×4 sheet + preview avatar seeded as standard.
const characters = [{
  name: 'Emma',
  avatars: {
    styledAvatars: {
      watercolor: {
        costumed: { wizard: 'data:image/jpeg;base64,SHEET' },
        standard: { imageData: 'data:image/jpeg;base64,PREVIEW', isSheet: false },
      },
    },
  },
}];

const projected = projectStoryCharacterAvatars(characters, 'watercolor');
const emma = projected.Emma;
check('projection exposes styled-standard', emma['styled-standard'] === 'data:image/jpeg;base64,PREVIEW');
check('projection keeps the costumed sheet a plain string', emma.costumed === 'data:image/jpeg;base64,SHEET');
check('projection marks the seeded slot non-sheet', JSON.stringify(emma.nonSheetSlots) === '["styled-standard"]', JSON.stringify(emma.nonSheetSlots));

// Resolver: standard → preview, flagged not-a-sheet, label untouched.
const refStd = { name: 'Emma', clothingCategory: 'standard' };
const rStd = resolveSheetForRef(emma, refStd);
check('standard resolves to the preview', rStd.uri === 'data:image/jpeg;base64,PREVIEW');
check('standard is flagged not-a-sheet', rStd.isSheet === false);
check('standard keeps its label (no silent swap)', refStd.clothingCategory === 'standard');

// Resolver: costumed → sheet, still a sheet.
const rCos = resolveSheetForRef(emma, { name: 'Emma', clothingCategory: 'costumed:wizard' });
check('costumed resolves to the sheet', rCos.uri === 'data:image/jpeg;base64,SHEET');
check('costumed is still a sheet (gets cropped)', rCos.isSheet === true);

// Fallback still fires — and still corrects the label — when nothing is seeded.
const noStd = projectStoryCharacterAvatars([{
  name: 'Emma',
  avatars: { styledAvatars: { watercolor: { costumed: { wizard: 'data:image/jpeg;base64,SHEET' } } } },
}], 'watercolor').Emma;
const refFallback = { name: 'Emma', clothingCategory: 'standard' };
const rFall = resolveSheetForRef(noStd, refFallback);
check('missing standard falls back to costumed', rFall.uri === 'data:image/jpeg;base64,SHEET');
check('fallback corrects the ref label', refFallback.clothingCategory === 'costumed');

// End to end: applyStoryCellRefs sends the preview whole, no crop attempted.
(async () => {
  const refs = [{ name: 'Emma', clothingCategory: 'standard', photoUrl: 'ORIGINAL' }];
  await applyStoryCellRefs(refs, projected, [{ name: 'Emma', pose: 'threeQuarter', depth: 'foreground' }]);
  check('full image is sent as the ref', refs[0].photoUrl === 'data:image/jpeg;base64,PREVIEW', refs[0].photoUrl.slice(0, 40));
  check('photoType says full-avatar', refs[0].photoType === 'full-avatar', refs[0].photoType);
  check('crop was skipped, not failed', refs[0].cellSkipped === 'not-a-sheet');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
