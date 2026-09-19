import { describe, it, expect } from 'vitest';

const { removeWornItemFromOutfit } = require('../../server/lib/wornItems');

// The real stored contract of Emma on staging job_1789420511893_zly5rcdej
// (stories.data.clothingRequirements.Emma.costumed.description, identical to
// referencePhotos[0].clothingDescription on every page). Semicolon-delimited,
// and its headwear clause names a garment word qualified by its slot noun.
const EMMA = 'A black felt tricorn hat with a red cockade; a red long-sleeved cotton pirate shirt with a gathered neckline and full sleeves; black cotton breeches ending just below the knee and gathered at the hem; a white linen sash tied at the waist; white knee-length cotton stockings; black leather buckle shoes.';

describe('removeWornItemFromOutfit — semicolon contracts and slot-noun pairs', () => {
  it('strips the tricorn clause out of the real stored contract', () => {
    const res = removeWornItemFromOutfit(EMMA, 'headwear', 'black tricorn hat');
    expect(res.removed).toBe(true);
    expect(res.reason).toBe('slot-clause');
    expect(res.text).not.toMatch(/tricorn|cockade/i);
    // Every other garment survives, and the semicolon shape is kept.
    for (const keep of ['pirate shirt', 'breeches', 'sash', 'stockings', 'buckle shoes']) {
      expect(res.text).toContain(keep);
    }
    expect(res.text.split(';').length).toBe(5);
    expect(res.text.startsWith('A red long-sleeved')).toBe(true);
  });

  it('cause 1: a semicolon contract is more than one clause', () => {
    // Before the fix this returned {removed:false, reason:'single-clause-outfit'}.
    expect(removeWornItemFromOutfit(EMMA, 'footwear', 'black leather buckle shoes').removed).toBe(true);
  });

  it('cause 2: "tricorn hat" is ONE garment, not a shared clause', () => {
    const one = 'a woolly beanie, a black felt tricorn hat with a red cockade, blue jeans';
    const res = removeWornItemFromOutfit(one, 'headwear', 'black tricorn hat');
    expect(res.removed).toBe(true);
    expect(res.text).toContain('woolly beanie');
    expect(res.text).not.toMatch(/tricorn/i);
  });

  it('other slot-noun pairs collapse the same way', () => {
    const boots = removeWornItemFromOutfit('a green tunic; knee-high leather boots', 'footwear', 'knee-high leather boots');
    expect(boots.removed).toBe(true);
    expect(boots.text).toBe('A green tunic');
    const cap = removeWornItemFromOutfit("a captain's cap; a grey shirt", 'headwear', "captain's cap");
    expect(cap.removed).toBe(true);
    expect(cap.text).toBe('A grey shirt');
  });

  it('a GENUINE two-garment clause is still refused (the guard still guards)', () => {
    // Two different garments of the same slot, no layering connective.
    const shared = 'a red hoodie and a blue t-shirt; blue jeans; white trainers';
    const res = removeWornItemFromOutfit(shared, 'top', 'red hoodie');
    expect(res.removed).toBe(false);
    expect(res.reason).toBe('slot-clause-carries-another-garment');
    // Two garments of DIFFERENT slots sharing one clause: same refusal.
    const mixed = 'a woollen hat and a scarf; a green jumper';
    expect(removeWornItemFromOutfit(mixed, 'headwear', 'woollen hat').removed).toBe(false);
  });

  it('a layered clause still keeps the other garment', () => {
    const layered = 'a red hoodie worn over a blue pullover; blue jeans';
    const res = removeWornItemFromOutfit(layered, 'top', 'red hoodie');
    expect(res.removed).toBe(true);
    expect(res.reason).toBe('slot-clause-layer');
    expect(res.text).toContain('blue pullover');
    expect(res.text).not.toMatch(/hoodie/i);
  });
});
