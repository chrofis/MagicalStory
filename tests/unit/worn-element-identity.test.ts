import { describe, it, expect } from 'vitest';

const {
  elementIdentityTerms, indexOfElementAmong, splitClauses,
  removeWornItemFromOutfit, resolveWornItemsForPage, resolveOutfitForPage,
  resolveGeneratedOutfit, stripOffItemsFromOutfit, SLOT_NOUNS,
} = require('../../server/lib/wornItems');

/**
 * A declared-off garment is identified by its VISUAL BIBLE ELEMENT, not by a
 * closed vocabulary of English garment nouns.
 *
 * THE DEFECT (staging job_1789584708605_rts4wqupm, Levin, p15/p17/p18). The
 * writer linked ART004 — *named* "fleece jacket" — as `Levin.top`, and Levin's
 * stored contract describes that same jacket as "red fleece fabric garment with
 * a full front zipper … worn over a white long-sleeve shirt". Not one word of
 * "red fleece fabric garment" is in SLOT_NOUNS, so:
 *   - `countGarments` saw ONE garment in that clause (the shirt), concluded the
 *     clause was only about the declared item, and dropped it whole. Levin lost
 *     the white long-sleeve shirt on all three pages as well as the jacket he
 *     had actually taken off;
 *   - and had the vocabulary been asked WHICH half to cut, the only `top` noun
 *     in the clause is "shirt" — so it would have cut the shirt and kept the
 *     jacket, the exact opposite of the declaration.
 *
 * Every string below is copied from stories.data on staging.
 */

// stories.data.visualBible.artifacts[3], verbatim (reference-image fields cut).
const ART004 = {
  id: 'ART004',
  name: 'fleece jacket',
  type: 'outer layer',
  label: 'red jacket',
  pages: [7, 9, 10, 15, 16, 17, 18],
  wornAs: 'Levin.top',
  scaleClass: 'forearm-sized',
  description: 'red fleece fabric garment with a full front zipper',
  appearsInPages: [7, 9, 10, 15, 16, 17, 18],
};
const FLEECE_BIBLE = { artifacts: [ART004] };

// stories.data.clothingRequirements.Levin.standard.description, verbatim.
const LEVIN = 'red fleece fabric garment with a full front zipper, ribbed cuffs and hem — worn over a white long-sleeve shirt, dark blue corduroy trousers, and brown lace-up ankle boots.';

// What p15/p17/p18 must resolve to: the jacket gone, everything else intact.
const LEVIN_WITHOUT_JACKET = 'A white long-sleeve shirt, dark blue corduroy trousers, and brown lace-up ankle boots.';

// The three pages' own brief METADATA and cast, verbatim.
const OFF_PAGES = [
  { pageNumber: 15, cast: ['Levin'], location: 'wrapped around the egg' },
  { pageNumber: 17, cast: ['Levin', 'Ramon'], location: "carried as a bundle in Levin's arms" },
  { pageNumber: 18, cast: ['Max', 'Julian', 'Kiaan', 'Levin'], location: 'lies empty on the ground beside the roots' },
];
const metaFor = (p: typeof OFF_PAGES[number]) => ({
  characters: p.cast,
  pageNumber: p.pageNumber,
  wornItems: [{ id: 'ART004', owner: 'Levin', state: 'off', location: p.location }],
});

describe('the declared element cuts its own garment — job_1789584708605_rts4wqupm', () => {
  it('pins WHY the closed vocabulary cannot do it: the slot holds the shirt, not the jacket', () => {
    // The writer put a jacket in the `top` slot, so the slot's vocabulary is the
    // vocabulary of a garment that is not this one.
    expect(SLOT_NOUNS.top).toContain('shirt');
    for (const noun of SLOT_NOUNS.top) expect(ART004.name).not.toContain(noun);
    // And the contract names the jacket in words the whole vocabulary lacks.
    const all = Object.values(SLOT_NOUNS).flat() as string[];
    for (const word of ['fleece', 'fabric', 'garment', 'zipper']) expect(all).not.toContain(word);
  });

  for (const page of OFF_PAGES) {
    it(`p${page.pageNumber} — the jacket is cut and the white long-sleeve shirt survives`, () => {
      const resolved = resolveWornItemsForPage(FLEECE_BIBLE, page.cast, metaFor(page), { pageNumber: page.pageNumber });
      expect(resolved.map((r: any) => `${r.id}:${r.state}:${r.slot}`)).toEqual(['ART004:off:top']);

      const { text, removals } = resolveOutfitForPage(LEVIN, resolved, 'Levin');
      expect(removals).toEqual([{ id: 'ART004', slot: 'top', removed: true, reason: 'slot-clause-layer' }]);
      expect(text).toBe(LEVIN_WITHOUT_JACKET);
      // Not a refusal dressed up as a fix, and not a whole-clause drop:
      expect(text).toContain('white long-sleeve shirt');
      expect(text).not.toMatch(/fleece|zipper/i);
    });

    it(`p${page.pageNumber} — the eval-side recompute reaches the same string`, () => {
      // evalPipeline.buildEvalClothingContract, the entity grid and all three
      // character-repair entry points come through here.
      expect(resolveGeneratedOutfit(LEVIN, 'Levin', {
        visualBible: FLEECE_BIBLE, sceneMetadata: metaFor(page), pageNumber: page.pageNumber,
      })).toBe(LEVIN_WITHOUT_JACKET);
    });
  }

  it('without the element the old vocabulary route still eats the shirt', () => {
    // The regression sentinel: this is exactly the call the resolver used to
    // make, and it is the element argument — nothing else — that fixes it.
    const blind = removeWornItemFromOutfit(LEVIN, 'top', 'fleece jacket');
    expect(blind.removed).toBe(true);
    expect(blind.reason).toBe('slot-clause');
    expect(blind.text).toBe('Dark blue corduroy trousers, and brown lace-up ankle boots.');

    const seeing = removeWornItemFromOutfit(LEVIN, 'top', 'fleece jacket', ART004);
    expect(seeing.reason).toBe('slot-clause-layer');
    expect(seeing.text).toBe(LEVIN_WITHOUT_JACKET);
  });

  it('a `worn` page is still left completely alone', () => {
    const meta = { characters: ['Levin'], pageNumber: 7, wornItems: [{ id: 'ART004', owner: 'Levin', state: 'worn' }] };
    expect(resolveGeneratedOutfit(LEVIN, 'Levin', { visualBible: FLEECE_BIBLE, sceneMetadata: meta, pageNumber: 7 })).toBe(LEVIN);
  });
});

describe('elementIdentityTerms — the element\'s own declared fields, nothing else', () => {
  it('reads name, label, aliases and description', () => {
    const terms = elementIdentityTerms({
      name: 'fleece jacket', label: 'red jacket', aliases: ['anorak'],
      description: 'red fleece fabric garment with a full front zipper',
    });
    for (const w of ['fleece', 'jacket', 'red', 'anorak', 'fabric', 'garment', 'full', 'front', 'zipper']) {
      expect(terms).toContain(w);
    }
  });

  it('drops function words and anything under three letters', () => {
    const terms = elementIdentityTerms({ description: 'a hat with the brim up and its band on it' });
    for (const w of ['a', 'up', 'on', 'it', 'the', 'with', 'and', 'its']) expect(terms).not.toContain(w);
    expect(terms).toEqual(expect.arrayContaining(['hat', 'brim', 'band']));
  });

  it('reads no outfit prose — a null or empty element identifies nothing', () => {
    expect(elementIdentityTerms(null)).toEqual([]);
    expect(elementIdentityTerms({})).toEqual([]);
    expect(elementIdentityTerms('fleece jacket')).toEqual([]);
  });
});

describe('indexOfElementAmong — positive evidence, and it refuses on conflict', () => {
  const JACKET = { name: 'fleece jacket', label: 'red jacket' };

  it('picks the text its declared words single out', () => {
    expect(indexOfElementAmong(['red fleece fabric garment with a zipper', 'a white long-sleeve shirt'], JACKET)).toBe(0);
    expect(indexOfElementAmong(['a white long-sleeve shirt', 'red fleece fabric garment with a zipper'], JACKET)).toBe(1);
  });

  it('a word both texts share discriminates nothing, and the rest still decides', () => {
    // "red" is in both, so it is neutral; "fleece" is only in one.
    expect(indexOfElementAmong(['a red fleece garment', 'a red cotton shirt'], {
      name: 'fleece jacket', description: 'a red fleece garment',
    })).toBe(0);
  });

  it('refuses when the element\'s own words point two ways', () => {
    // "brown" lands on the coat, "boots" on the boots — no answer.
    expect(indexOfElementAmong(['a brown coat', 'black boots'], { name: 'brown boots' })).toBe(-1);
  });

  it('one coincidental word is not evidence', () => {
    // Only "red" discriminates. A colour shared between two garment
    // descriptions is a coincidence, not an identification.
    expect(indexOfElementAmong(['a red shirt', 'blue trousers'], { name: 'red jacket' })).toBe(-1);
    // A single-word name can therefore never answer at all.
    expect(indexOfElementAmong(['a red hat', 'blue trousers'], { name: 'hat' })).toBe(-1);
  });

  it('needs at least two texts and a non-empty element', () => {
    expect(indexOfElementAmong(['a red fleece jacket'], JACKET)).toBe(-1);
    expect(indexOfElementAmong(['a red fleece jacket', 'a white shirt'], null)).toBe(-1);
  });
});

describe('the element is asked first, but never overrules into a deletion', () => {
  it('drops the whole clause when nothing beside the item is a garment', () => {
    // The rest of the clause is where the item sits, not a second garment.
    const res = removeWornItemFromOutfit(
      'a red woollen hat worn over her plaited hair, brown leather boots',
      'headwear', 'red woollen hat',
      { name: 'red woollen hat', description: 'a soft red woollen hat' },
    );
    expect(res.removed).toBe(true);
    expect(res.text).toBe('Brown leather boots');
  });

  it('refuses when a clause carries a second garment and no connective separates them', () => {
    // staging job_1789163494908_kc2joi4ax p8, verbatim: the anorak and a
    // pullover in one clause, joined by nothing the code can cut at.
    const src = 'A purple anorak-style pullover windbreaker with a front kangaroo pocket and drawstring hood resting down the back, black trousers, and dark grey sneakers.';
    const res = removeWornItemFromOutfit(src, 'outer layer', "Kiaan's Anorak", {
      name: "Kiaan's Anorak", type: 'garment',
      description: 'A purple anorak-style pullover windbreaker with a front kangaroo pocket and a drawstring hood.',
    });
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('slot-clause-carries-another-garment');
    expect(res.text).toBe(src);
  });

  it('falls back to the vocabulary when the element describes both garments', () => {
    // staging job_1789348171785_9oxos7dwv p8, verbatim. The element's own
    // description says "made of thick cotton" and the trousers are cotton too,
    // so its declared words point two ways and identity declines — and the
    // vocabulary route, which is right here, is untouched.
    const src = 'A red zip-up hoodie sweatshirt worn over a white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.';
    const element = {
      name: 'red zip-up hoodie', label: 'red hoodie',
      description: 'A red zip-up hoodie sweatshirt with long sleeves and a soft hood, made of thick cotton.',
    };
    expect(indexOfElementAmong(splitClauses(src), element)).toBe(-1);
    expect(removeWornItemFromOutfit(src, 'top', 'red zip-up hoodie', element).text)
      .toBe('A white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.');
  });

  it('a row with nothing but a name behaves exactly as it did before', () => {
    // stripOffItemsFromOutfit passes `{ name }` when no bible entry is attached.
    const src = 'A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, brown lace-up ankle boots, oval reddish-brown-framed glasses, and a very long rust-orange woven scarf with fringed ends wound loosely around the neck and shoulders.';
    const row = [{
      id: 'ART008', name: 'rust-orange woven scarf', owner: 'C', wearer: 'C',
      handedOver: false, slot: 'accessories', state: 'off', location: 'set down nearby',
    }];
    expect(stripOffItemsFromOutfit(src, row, 'C').text)
      .toBe('A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, brown lace-up ankle boots, oval reddish-brown-framed glasses.');
  });
});
