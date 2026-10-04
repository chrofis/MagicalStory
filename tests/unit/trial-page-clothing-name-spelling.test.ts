import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { reconcilePageClothingWithRequirements } = require('../../server/lib/clothingCategories.js');
const { buildSceneClothingRequirements, getCharacterPhotoDetails } = require('../../server/lib/clothingResolve.js');

// Fixture shape from prod trial job_1790769860433_2bhhj0pyi: the wizard character
// is "LUNA", the outline keyed its per-page clothing "Luna". The trial page path
// looked the category up by exact key, got nothing, defaulted to 'standard' and
// rendered every page in the standard avatar.
const TRIAL_REQS = {
  LUNA: {
    costumed: { used: true, costume: 'wizard', description: 'a starry indigo wizard robe' },
    standard: { used: true, signature: 'none' },
  },
};
const luna = { id: 1, name: 'LUNA', avatars: { standard: 'data:standard', costumed: { wizard: 'data:costume' } } };

// The trial page step: reconcile, then the shared builder.
function trialPageClothing(pageClothing: Record<string, string>) {
  const clothing = reconcilePageClothingWithRequirements(pageClothing, TRIAL_REQS).clothing;
  return buildSceneClothingRequirements([luna], clothing, TRIAL_REQS);
}

describe('trial page clothing resolves a differently-spelled character name', () => {
  it('"Luna" in the page map resolves costumed for character "LUNA"', () => {
    const reqs = trialPageClothing({ Luna: 'costumed' });
    expect(reqs.LUNA._currentClothing).toBe('costumed');
    // the contract (costume + description) survives under the character's own key
    expect(reqs.LUNA.costumed.description).toBe('a starry indigo wizard robe');
    const [photo] = getCharacterPhotoDetails([luna], 'standard', null, reqs);
    expect(photo.requestedClothingCategory).toBe('costumed');
  });

  it('the same page map still resolves standard when the page says standard', () => {
    const reqs = trialPageClothing({ Luna: 'standard' });
    expect(reqs.LUNA._currentClothing).toBe('standard');
  });

  it('does not mutate the story-level contract', () => {
    const before = JSON.stringify(TRIAL_REQS);
    trialPageClothing({ Luna: 'costumed' });
    expect(JSON.stringify(TRIAL_REQS)).toBe(before);
  });

  it('a character with no page entry and no unambiguous outfit fails loudly instead of defaulting to standard', () => {
    expect(() => buildSceneClothingRequirements([luna], {}, TRIAL_REQS)).not.toThrow(); // costumed story
    const mixed = { LUNA: { standard: { used: true }, winter: { used: true } } };
    expect(() => buildSceneClothingRequirements([luna], {}, mixed)).toThrow(/Refusing to default/);
  });

  it('a contract keyed under another spelling keeps its costume under the character key', () => {
    const reqs = buildSceneClothingRequirements([luna], { LUNA: 'costumed' }, { Luna: TRIAL_REQS.LUNA });
    expect(reqs.LUNA.costumed.description).toBe('a starry indigo wizard robe');
  });
});

describe('trial page path uses the shared builder', () => {
  it('storyJobPipeline has no hand-rolled exact-key clothing default', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/perCharClothing\[char\.name\]\s*\|\|\s*'standard'/);
  });
});
