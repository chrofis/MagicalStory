/**
 * COSTUME OR FAIL on the trial's streamed renders.
 *
 * The trial starts its costumed sheet early (storyJobPipeline.js, the
 * `streamingAvatarStylingPromise` block) and SWALLOWS a failure there; the
 * final coverage pass (prepareStyledAvatars before the page loop) retries and
 * throws MissingRequiredCostumeSheetError if the sheet is still missing. But
 * the trial's pages and covers stream before that pass: getCharacterPhotoDetails
 * falls through to the standard avatar when the styled costumed sheet is
 * missing, and applyStyledAvatars keeps that photo on a costumed cache miss (it
 * logs an error and returns the photo). The page rendered the hero in modern
 * clothes and the page loop then REUSED that image even when the retry had
 * produced the sheet. The streamed render must refuse instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-costumed-ref';
const ROOT = path.resolve(__dirname, '..', '..');
const styledAvatars = require('../../server/lib/styledAvatars.js');
const { getCharacterPhotoDetails, buildSceneClothingRequirements } = require('../../server/lib/clothingResolve.js');

const hero = {
  id: 'c1', name: 'LUNA', isMainCharacter: true,
  avatars: { standard: 'data:image/jpeg;base64,STANDARD' },
};
const reqs = {
  LUNA: {
    standard: { used: true, signature: 'none' },
    costumed: { used: true, costume: 'astronaut', description: 'a white spacesuit' },
  },
};

describe('missingCostumedRefs', () => {
  it('flags a costumed request that fell through to the standard avatar (the failure path)', async () => {
    const sceneReqs = buildSceneClothingRequirements([hero], { Luna: 'costumed' }, reqs);
    let photos = getCharacterPhotoDetails([hero], 'standard', 'watercolor', sceneReqs);
    photos = await styledAvatars.runInCacheScope('trial-test-miss', async () => styledAvatars.applyStyledAvatars(photos, 'watercolor'));
    // Premise: with no costumed sheet the photo IS the standard avatar.
    expect(photos[0].photoUrl).toBe('data:image/jpeg;base64,STANDARD');
    expect(photos[0].requestedClothingCategory).toBe('costumed');
    expect(styledAvatars.missingCostumedRefs(photos)).toEqual(['LUNA']);
  });

  it('passes a costumed ref resolved from the character sheet', () => {
    const dressed = { ...hero, avatars: { ...hero.avatars, styledAvatars: { watercolor: { costumed: { astronaut: 'data:image/jpeg;base64,SUIT' } } } } };
    const sceneReqs = buildSceneClothingRequirements([dressed], { LUNA: 'costumed' }, reqs);
    const photos = getCharacterPhotoDetails([dressed], 'standard', 'watercolor', sceneReqs);
    expect(photos[0].photoType).toBe('costumed-astronaut');
    expect(styledAvatars.missingCostumedRefs(photos)).toEqual([]);
  });

  it('passes a costumed ref served from the styled cache', () => {
    expect(styledAvatars.missingCostumedRefs([{ name: 'LUNA', photoType: 'clothing-standard', isStyled: true, requestedClothingCategory: 'costumed' }])).toEqual([]);
  });

  it('ignores standard / seasonal requests', () => {
    expect(styledAvatars.missingCostumedRefs([
      { name: 'A', photoType: 'clothing-standard', requestedClothingCategory: 'standard' },
      { name: 'B', photoType: 'clothing-winter', requestedClothingCategory: 'winter' },
    ])).toEqual([]);
  });
});

describe('the trial render sites refuse a bare costumed ref', () => {
  const src = fs.readFileSync(path.join(ROOT, 'storyJobPipeline.js'), 'utf8');

  it('streamed page, front cover and back cover each check after applyStyledAvatars', () => {
    const sites = src.split('= applyStyledAvatars(').slice(1);
    // 4 call sites: trial page, trial back cover, trial front cover, full-mode page
    expect(sites.length).toBe(4);
    const guarded = sites.filter(s => s.slice(0, 1200).includes('missingCostumedRefs('));
    expect(guarded.length).toBe(3);
    // the full-mode page renders after the coverage pass that throws; no guard there
    const fullMode = sites.find(s => s.startsWith('pagePhotos, inputData.artStyle);') && !s.slice(0, 1200).includes('missingCostumedRefs('));
    expect(fullMode).toBeTruthy();
  });

  it('the early styling failure is logged as an error, not a warning', () => {
    expect(src).toMatch(/log\.error\(`❌ \[TRIAL\] Early \$\{label\} avatar styling failed/);
    expect(src).not.toMatch(/log\.warn\(`⚠️ \[TRIAL\] Early (\$\{label\} )?avatar styling failed/);
  });
});
