import { describe, it, expect } from 'vitest';

const {
  removeWornItemFromOutfit, resolveOutfitForPage, resolveGeneratedOutfit,
  applyWornItemsToOutfit, stripOffItemsFromOutfit,
} = require('../../server/lib/wornItems');

/**
 * Two ways a worn-item resolution used to eat a garment the page never declared
 * off. Both reproduced 2026-09-18 by replaying the real stored inputs of two
 * staging stories through extractSceneMetadata → resolveWornItemsForPage →
 * resolveOutfitForPage; every string below is copied from stories.data.
 *
 * A — splitClauses cut INSIDE a clause. Every comma was a clause boundary, so a
 *     garment described as "<colour>, <garment>, <fit>" became three clauses,
 *     only the middle one carried the slot noun, and taking the garment off left
 *     the colour and the fit standing in the outfit as free-floating garments.
 *
 * B — applyWornItemsToOutfit swapped a contract clause for a declared item it
 *     could not prove the contract did not already name. The premise of that
 *     branch is "the contract's clause for this slot names a DIFFERENT garment",
 *     and the only test for "different" is the slot's closed noun vocabulary —
 *     which says nothing at all when the declared item's own name carries none
 *     of those nouns. It swapped anyway, deleting a real garment.
 */

// ── A: staging job_1789506283204_3kxqshifx ────────────────────────────────────
// stories.data.clothingRequirements.Levin.standard.description. Semicolon
// contract; the headwear clause carries its colour before the noun and its fit
// after it, both separated by commas.
const LEVIN_CAP_CONTRACT = 'a solid red, visibly hand-knitted wool cap with a small rolled-up brim around the bottom edge, shaped slightly oversized and wide; a forest-green zip-up fleece jacket with a front zip and two patch pockets at the hips, roomy enough to hold an egg pressed against the chest; dark blue corduroy trousers with a straight leg; brown lace-up ankle boots with a rubber sole.';

const CAP_BIBLE = {
  artifacts: [{
    id: 'ART004',
    name: 'hand-knitted wool cap',
    type: 'headwear',
    wornAs: 'Levin.headwear',
    description: 'a solid red, visibly hand-knitted wool cap with a small rolled-up brim around the bottom edge, shaped slightly oversized and wide',
  }],
};
// The p8 row, verbatim from the stored brief's METADATA.
const CAP_OFF_META = {
  characters: ['Levin'],
  wornItems: [{ id: 'ART004', owner: 'Levin', state: 'off', location: 'pushed under the egg' }],
};

// ── B: staging job_1789584708605_rts4wqupm ────────────────────────────────────
// stories.data.clothingRequirements.Levin.standard.description. Comma contract,
// with the fleece's own trim detail and its layering phrase after a comma.
const LEVIN_FLEECE_CONTRACT = 'red fleece fabric garment with a full front zipper, ribbed cuffs and hem — worn over a white long-sleeve shirt, dark blue corduroy trousers, and brown lace-up ankle boots.';

// The writer linked a JACKET into the `top` slot, so the slot's vocabulary
// (shirt / blouse / jumper / …) contains no noun of the item's own name.
const FLEECE_BIBLE = {
  artifacts: [{
    id: 'ART004',
    name: 'fleece jacket',
    type: 'outer layer',
    wornAs: 'Levin.top',
    description: 'red fleece fabric garment with a full front zipper',
  }],
};
const FLEECE_WORN_META = {
  characters: ['Levin', 'Julian'],
  wornItems: [{ id: 'ART004', owner: 'Levin', state: 'worn' }],
};

describe('A — a clause is never cut at a comma inside it', () => {
  it('takes the whole cap clause out, colour and fit included', () => {
    const res = removeWornItemFromOutfit(LEVIN_CAP_CONTRACT, 'headwear', 'hand-knitted wool cap');
    expect(res.removed).toBe(true);
    expect(res.reason).toBe('slot-clause');
    expect(res.text).toBe('A forest-green zip-up fleece jacket with a front zip and two patch pockets at the hips, roomy enough to hold an egg pressed against the chest; dark blue corduroy trousers with a straight leg; brown lace-up ankle boots with a rubber sole.');
  });

  it('leaves no orphan fragment standing in as a garment', () => {
    const { text } = resolveOutfitForPage(
      LEVIN_CAP_CONTRACT,
      [{ id: 'ART004', name: 'hand-knitted wool cap', owner: 'Levin', wearer: 'Levin', handedOver: false, slot: 'headwear', state: 'off', location: 'pushed under the egg', entry: CAP_BIBLE.artifacts[0] }],
      'Levin',
    );
    // The stored damage: "A solid red; shaped slightly oversized and wide; …"
    expect(text).not.toMatch(/^A solid red\b/);
    expect(text).not.toContain('shaped slightly oversized and wide');
    // …and the comma inside the jacket clause is still a comma, not a semicolon.
    expect(text).toContain('at the hips, roomy enough to hold an egg');
  });

  it('the eval-side contract reaches the same string as the generator', () => {
    const contract = resolveGeneratedOutfit(LEVIN_CAP_CONTRACT, 'Levin', {
      visualBible: CAP_BIBLE, sceneMetadata: CAP_OFF_META, pageNumber: 8,
    });
    expect(contract).not.toContain('A solid red;');
    expect(contract).not.toMatch(/\bcap\b/i);
    expect(contract).toContain('forest-green zip-up fleece jacket');
    expect(contract).toContain('dark blue corduroy trousers');
    expect(contract).toContain('brown lace-up ankle boots');
  });

  it('a semicolon is a boundary even between two fragments that name no garment', () => {
    const res = removeWornItemFromOutfit('a red woollen hat; short sandy hair', 'headwear', 'red woollen hat');
    expect(res.removed).toBe(true);
    expect(res.text).toBe('Short sandy hair');
  });

  it('a comma is a boundary only between two texts that each name a garment', () => {
    // Colour in front, fit behind — one hat, one clause, nothing left over.
    const one = removeWornItemFromOutfit('a deep blue, wide-brimmed felt hat, cut generously, and brown leather boots', 'headwear', 'felt hat');
    expect(one.removed).toBe(true);
    expect(one.text).toBe('Brown leather boots');
    // Two garments either side of the comma: still two clauses.
    const two = removeWornItemFromOutfit('a red woollen hat, brown leather boots', 'headwear', 'red woollen hat');
    expect(two.removed).toBe(true);
    expect(two.text).toBe('Brown leather boots');
  });
});

describe('B — no evidence of disagreement, no swap', () => {
  it('does not swap when the declared item\'s name carries no noun of its slot', () => {
    const resolved = [{ id: 'ART004', name: 'fleece jacket', owner: 'Levin', wearer: 'Levin', handedOver: false, slot: 'top', state: 'worn', location: null, entry: FLEECE_BIBLE.artifacts[0] }];
    const { text, swaps } = applyWornItemsToOutfit(LEVIN_FLEECE_CONTRACT, resolved, 'Levin');
    expect(text).toBe(LEVIN_FLEECE_CONTRACT);
    expect(swaps).toEqual([{ id: 'ART004', slot: 'top', applied: false, reason: 'item-name-carries-no-slot-noun' }]);
  });

  it('keeps the white long-sleeve shirt the swap used to delete', () => {
    const { text } = resolveOutfitForPage(
      LEVIN_FLEECE_CONTRACT,
      [{ id: 'ART004', name: 'fleece jacket', owner: 'Levin', wearer: 'Levin', handedOver: false, slot: 'top', state: 'worn', location: null, entry: FLEECE_BIBLE.artifacts[0] }],
      'Levin',
    );
    expect(text).toContain('white long-sleeve shirt');
    // …and the jacket is not appended a second time.
    expect(text.match(/fleece/gi)?.length).toBe(1);
  });

  it('the judge is handed the contract, not the mangled copy', () => {
    const contract = resolveGeneratedOutfit(LEVIN_FLEECE_CONTRACT, 'Levin', {
      visualBible: FLEECE_BIBLE, sceneMetadata: FLEECE_WORN_META, pageNumber: 1,
    });
    expect(contract).toBe(LEVIN_FLEECE_CONTRACT);
  });

  it('still swaps when the disagreement IS provable', () => {
    // The precedent the branch was built for: staging job_1789420511893_zly5rcdej
    // p13 — the page declares a cap worn, the contract's headwear clause is a
    // tricorn. Both names carry a headwear noun, so "different" is provable.
    const contract = 'A black felt tricorn hat with a red cockade; a red long-sleeved cotton pirate shirt; black leather buckle shoes.';
    const resolved = [{ id: 'ART002', name: "navy-blue captain's cap", owner: 'Emma', wearer: 'Emma', handedOver: false, slot: 'headwear', state: 'worn', location: null, entry: { name: "navy-blue captain's cap", description: 'stiff black visor, flat crown, gold anchor emblem' } }];
    const { text, swaps } = applyWornItemsToOutfit(contract, resolved, 'Emma');
    expect(swaps).toEqual([{ id: 'ART002', slot: 'headwear', applied: true, reason: 'slot-conflict-resolved' }]);
    expect(text).not.toMatch(/tricorn/i);
    expect(text).toContain("navy-blue captain's cap — stiff black visor, flat crown, gold anchor emblem");
  });

  it('a contract that already names the declared item is left alone', () => {
    const contract = "A navy-blue captain's cap with a gold anchor; a grey shirt.";
    const resolved = [{ id: 'ART002', name: "navy-blue captain's cap", owner: 'Emma', wearer: 'Emma', handedOver: false, slot: 'headwear', state: 'worn', location: null, entry: { name: "navy-blue captain's cap" } }];
    const { text, swaps } = applyWornItemsToOutfit(contract, resolved, 'Emma');
    expect(text).toBe(contract);
    expect(swaps).toEqual([]);
  });
});

/**
 * The four other stored contracts the resolver modifies somewhere in staging or
 * prod. Replaying all 3,203 stored (page, character) pairs over 236 stories,
 * these are the only outfits besides the two above that the resolver rewrites at
 * all — and the fix must leave every one of them byte-identical.
 */
describe('the fix changes nothing that was already right', () => {
  const OFF = (name: string, slot: string) => ([{
    id: 'ART001', name, owner: 'C', wearer: 'C', handedOver: false,
    slot, state: 'off', location: 'set down nearby', entry: { name },
  }]);

  it('job_1789078732136_622wecmhj p15 — pullover off, dog lead kept', () => {
    const src = 'A green crew-neck pullover, dark grey straight-leg trousers, blue lace-up sneakers; an orange dog lead looped around one wrist.';
    expect(stripOffItemsFromOutfit(src, OFF('green crew-neck pullover', 'top'), 'C').text)
      .toBe('Dark grey straight-leg trousers; blue lace-up sneakers; an orange dog lead looped around one wrist.');
  });

  it('job_1789227389389_z18dmvnt6 p15 — scarf off, glasses kept', () => {
    const src = 'A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, brown lace-up ankle boots, oval reddish-brown-framed glasses, and a very long rust-orange woven scarf with fringed ends wound loosely around the neck and shoulders.';
    expect(stripOffItemsFromOutfit(src, OFF('rust-orange woven scarf', 'accessories'), 'C').text)
      .toBe('A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, brown lace-up ankle boots, oval reddish-brown-framed glasses.');
  });

  it('job_1789343124794_z2c779f7i p7 — rain jacket off, the t-shirt under it stays', () => {
    const src = 'An orange hooded rain jacket with press-stud front closure and two patch pockets over a plain white short-sleeve t-shirt, brown corduroy trousers, and red rubber boots.';
    expect(stripOffItemsFromOutfit(src, OFF('orange hooded rain jacket', 'outer layer'), 'C').text)
      .toBe('A plain white short-sleeve t-shirt, brown corduroy trousers, and red rubber boots.');
  });

  it('job_1789348171785_9oxos7dwv p8 — hoodie off, the pullover under it stays', () => {
    const src = 'A red zip-up hoodie sweatshirt worn over a white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.';
    expect(stripOffItemsFromOutfit(src, OFF('red zip-up hoodie', 'top'), 'C').text)
      .toBe('A white long-sleeve pullover, dark grey cotton straight-leg trousers, and brown leather lace-up ankle boots.');
  });
});
