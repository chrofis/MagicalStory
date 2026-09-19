import { describe, it, expect } from 'vitest';

const {
  splitClauses, splitClausesDetailed, removeWornItemFromOutfit, stripOffItemsFromOutfit,
} = require('../../server/lib/wornItems');

/**
 * A dependent segment belongs to the clause before it, and leaves with it.
 *
 * Measured on staging job_1789759147125_p08djwhbl: stripping Levin's green
 * fleece left "worn open in scenes where the jacket becomes the egg's bed"
 * standing in the outfit, dangling off the cap beside it and still describing
 * the garment that had just been removed.
 */

// The stored contract of that story, verbatim.
const LEVIN = "A chunky-knit red wool pull-on cap with a folded cuff; a forest-green zip-up fleece jacket "
  + "with a wide body and two front pockets, worn open in scenes where the jacket becomes the egg's bed; "
  + 'a long-sleeved white cotton shirt underneath; straight-leg dark navy corduroy trousers; '
  + 'lace-up brown leather ankle boots.';

const CLO002 = {
  id: 'CLO002', name: 'green fleece jacket', label: 'green fleece',
  description: 'a forest-green zip-up fleece jacket with a wide body and two front pockets',
};
const CLO001 = {
  id: 'CLO001', name: 'red wool cap', label: 'red cap',
  description: 'a chunky-knit red wool pull-on cap with a folded ribbed cuff',
};

describe('a dependent segment is part of its clause, not a clause of its own', () => {
  it('attaches the dependent to the garment it describes', () => {
    const det = splitClausesDetailed(LEVIN);
    expect(det.map(c => c.head)).toEqual([
      'A chunky-knit red wool pull-on cap with a folded cuff',
      'a forest-green zip-up fleece jacket with a wide body and two front pockets',
      'a long-sleeved white cotton shirt underneath',
      'straight-leg dark navy corduroy trousers',
      'lace-up brown leather ankle boots.',
    ]);
    expect(det[1].text).toBe(
      'a forest-green zip-up fleece jacket with a wide body and two front pockets, '
      + "worn open in scenes where the jacket becomes the egg's bed",
    );
    expect(det).toHaveLength(5);
  });

  it('the measured case leaves no dangling fragment', () => {
    const res = removeWornItemFromOutfit(LEVIN, 'outer layer', 'green fleece jacket', CLO002);
    expect(res.removed).toBe(true);
    expect(res.text).toBe(
      'A chunky-knit red wool pull-on cap with a folded cuff; a long-sleeved white cotton shirt underneath; '
      + 'straight-leg dark navy corduroy trousers; lace-up brown leather ankle boots.',
    );
    // The fragment is gone, and so is every mention of the garment taken off.
    expect(res.text).not.toMatch(/worn open/i);
    expect(res.text).not.toMatch(/jacket|fleece/i);
  });

  it('a dependent does not survive a strip of a DIFFERENT garment either', () => {
    // Taking the cap off must not promote the jacket's tail to a sentence opener.
    const res = removeWornItemFromOutfit(LEVIN, 'headwear', 'red wool cap', CLO001);
    expect(res.removed).toBe(true);
    expect(res.text.startsWith('A forest-green zip-up fleece jacket')).toBe(true);
    expect(res.text).toContain("worn open in scenes where the jacket becomes the egg's bed");
  });
});

describe('what a dependent may not do is bring another garment quietly', () => {
  const COAT = 'A brick-red wool duffle coat with large wooden toggle fastenings down the front and a small '
    + 'standing collar, worn over a white crew-neck long-sleeve top; dark navy cotton trousers; brown boots.';

  it('a layering dependent goes through the layer split, and the garment under it survives', () => {
    const res = removeWornItemFromOutfit(COAT, 'outer layer', 'duffle coat', {
      name: 'brick-red duffle coat', description: 'a brick-red wool duffle coat with large wooden toggles',
    });
    expect(res.removed).toBe(true);
    expect(res.text).toBe('A white crew-neck long-sleeve top; dark navy cotton trousers; brown boots.');
  });

  it('a list conjunction still opens a list ITEM, not a tail', () => {
    const src = 'A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, '
      + 'brown lace-up ankle boots, and a very long rust-orange woven scarf wound loosely around the neck.';
    expect(splitClauses(src)).toHaveLength(4);
    const row = [{
      id: 'ART008', name: 'rust-orange woven scarf', owner: 'C', wearer: 'C',
      handedOver: false, slot: 'accessories', state: 'off', location: 'set down nearby',
    }];
    expect(stripOffItemsFromOutfit(src, row, 'C').text).toBe(
      'A chunky oversized purple knit turtleneck sweater, dark brown wide-leg corduroy trousers, '
      + 'brown lace-up ankle boots.',
    );
  });
});

describe('a contract with no dependent segment is untouched', () => {
  // Two stored contracts from the same story, neither carrying a dependent.
  const MAX = 'A burnt-orange quilted hooded gilet worn over a long-sleeved grey cotton shirt; '
    + 'straight-leg mid-blue denim jeans; white canvas low-top sneakers.';
  const KIAAN = 'A purple crew-neck wool sweater with dropped shoulders and a plain knit texture; '
    + 'dark brown straight-leg cotton chinos rolled once at the ankle; dark grey lace-up leather sneakers.';

  it('splits exactly as before, head === text everywhere', () => {
    for (const src of [MAX, KIAAN]) {
      for (const c of splitClausesDetailed(src)) expect(c.head).toBe(c.text);
    }
    expect(splitClauses(KIAAN)).toEqual([
      'A purple crew-neck wool sweater with dropped shoulders and a plain knit texture',
      'dark brown straight-leg cotton chinos rolled once at the ankle',
      'dark grey lace-up leather sneakers.',
    ]);
  });

  it('strips exactly as before', () => {
    const res = removeWornItemFromOutfit(KIAAN, 'footwear', 'grey leather sneakers', {
      name: 'dark grey leather sneakers', description: 'dark grey lace-up leather sneakers',
    });
    expect(res.text).toBe(
      'A purple crew-neck wool sweater with dropped shoulders and a plain knit texture; '
      + 'dark brown straight-leg cotton chinos rolled once at the ankle.',
    );
    // A layered clause inside ONE segment is still split on its connective.
    const gilet = removeWornItemFromOutfit(MAX, 'outer layer', 'quilted gilet', {
      name: 'burnt-orange quilted gilet', description: 'a burnt-orange quilted hooded gilet',
    });
    expect(gilet.text).toBe('A long-sleeved grey cotton shirt; straight-leg mid-blue denim jeans; '
      + 'white canvas low-top sneakers.');
  });
});
