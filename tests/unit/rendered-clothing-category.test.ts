import { describe, it, expect } from 'vitest';

// A character repair must paint back the outfit the character was RENDERED in,
// and its clothing text and its reference sheet must come from that one
// category. Covers have no sceneCharacterClothing; the Lab stage and the manual
// repair route read only that and fell to 'standard', so on staging
// job_1790446348343_z3fw660ie initialPage (Lab 1554) the prompt described the
// everyday tunic and jeans while the avatar sent was the pirate costume.
// resolveRenderedClothingCategory is the one resolver every repair entry point
// now uses.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveRenderedClothingCategory } = require('../../server/lib/clothingCategories');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildClothingDescription } = require('../../server/lib/entityConsistency');

const COSTUME = 'A white loose-weave cotton pirate blouse, a weathered dark grey wool pirate coat';
const FIONA = {
  name: 'Fiona',
  avatars: { clothing: { standard: 'white and light blue tunic, dark blue jeans', costumed: { pirate: COSTUME } } },
};
const REQS = {
  Fiona: { standard: { used: false }, summer: { used: false }, winter: { used: false }, costumed: { used: true, costume: 'pirate', description: COSTUME } },
};

describe('resolveRenderedClothingCategory', () => {
  it('a cover briefed as a page: the cover record\'s perCharClothing, not standard (the Lab 1554 case)', () => {
    const cover = { briefedAsPage: true, perCharClothing: { Fiona: 'costumed:pirate' } };
    const story = { coverImages: { initialPage: cover }, pageClothing: { primaryClothing: 'costumed' }, clothingRequirements: REQS, characters: [FIONA] };
    const cat = resolveRenderedClothingCategory(story, -2, 'Fiona', cover);
    expect(cat).toBe('costumed');
    // …and the text built from it describes the costume the reference shows.
    expect(buildClothingDescription(FIONA, cat, 'watercolor', REQS)).toBe(COSTUME);
    expect(buildClothingDescription(FIONA, cat, 'watercolor', REQS)).not.toMatch(/tunic|jeans/);
  });

  it('a Lab-shaped story stub (cover record only, no stored story) resolves the same', () => {
    const cover = { briefedAsPage: true, perCharClothing: { Fiona: 'costumed:pirate' } };
    const stub = { pageClothing: null, coverHints: null, coverImages: { initialPage: cover }, characters: [FIONA] };
    expect(resolveRenderedClothingCategory(stub, -2, 'fiona', cover)).toBe('costumed');
  });

  it('a trial (hint-made) cover: the cover hint\'s characterClothing', () => {
    const cover = { description: 'cover' };
    const story = { coverImages: { frontCover: cover }, coverHints: { frontCover: { characterClothing: { Fiona: 'winter' } } }, pageClothing: { primaryClothing: 'standard' } };
    expect(resolveRenderedClothingCategory(story, -1, 'Fiona', cover)).toBe('winter');
  });

  it('a cover with neither brief nor hint entry: the story primary category', () => {
    const story = { coverImages: { backCover: {} }, pageClothing: { primaryClothing: 'costumed' } };
    expect(resolveRenderedClothingCategory(story, -3, 'Fiona', {})).toBe('costumed');
  });

  it('a page: its persisted sceneCharacterClothing wins over pageClothing', () => {
    const page = { sceneCharacterClothing: { Fiona: 'summer' } };
    const story = { pageClothing: { primaryClothing: 'standard', pageClothing: { 4: { Fiona: 'winter' } } } };
    expect(resolveRenderedClothingCategory(story, 4, 'Fiona', page)).toBe('summer');
  });

  it('an in-run pipeline image: perCharClothing', () => {
    const img = { perCharClothing: { Fiona: 'costumed:pirate' } };
    expect(resolveRenderedClothingCategory({}, 7, 'Fiona', img)).toBe('costumed');
  });

  it('a page without a per-page entry for the character: pageClothing', () => {
    const page = { sceneCharacterClothing: { Someone: 'summer' } };
    const story = { pageClothing: { primaryClothing: 'standard', pageClothing: { 4: { Fiona: 'winter' } } } };
    expect(resolveRenderedClothingCategory(story, 4, 'Fiona', page)).toBe('winter');
  });

  it('nothing known: null (callers refuse — never a guessed standard)', () => {
    expect(resolveRenderedClothingCategory({}, 4, 'Fiona', {})).toBeNull();
    expect(resolveRenderedClothingCategory({ coverImages: {} }, -2, 'Fiona', {})).toBeNull();
  });
});
