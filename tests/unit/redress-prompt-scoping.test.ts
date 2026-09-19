import { describe, it, expect } from 'vitest';

const { shortGarmentLabel, headIsUnderLayer, splitClausesDetailed } = require('../../server/lib/wornItems');
const { buildRedressPrompt } = require('../../server/lib/character2x4Sheet');

/**
 * A redress instruction NAMES the garments that stay and DESCRIBES only the one
 * that changes.
 *
 * Measured on staging job_1789759147125_p08djwhbl: the first version repeated
 * the full contract text for every staying garment, and the provider repainted
 * them to the words — a smooth flat-woven cap came back knitted ("chunky-knit"),
 * denim trousers came back with wales ("corduroy"). These tests pin the
 * BEHAVIOUR (which words may and may not reach the provider), never the wording.
 */

// The stored contract of that story with the jacket already stripped out.
const STRIPPED = 'A chunky-knit red wool pull-on cap with a folded cuff; '
  + 'a long-sleeved white cotton shirt underneath; straight-leg dark navy corduroy trousers; '
  + 'lace-up brown leather ankle boots.';

const OFF = ['forest-green fleece jacket'];

describe('shortGarmentLabel — colour + garment noun, derived structurally', () => {
  it('reduces a described garment to what a person would call it', () => {
    expect(shortGarmentLabel('A chunky-knit red wool pull-on cap with a folded cuff'))
      .toEqual({ label: 'the red cap', derived: true });
    expect(shortGarmentLabel('straight-leg dark navy corduroy trousers'))
      .toEqual({ label: 'the navy trousers', derived: true });
    expect(shortGarmentLabel('lace-up brown leather ankle boots.'))
      .toEqual({ label: 'the brown boots', derived: true });
  });

  it('keeps a hyphenated compound colour whole', () => {
    expect(shortGarmentLabel('a forest-green zip-up fleece jacket with two front pockets').label)
      .toBe('the forest-green jacket');
  });

  it('names the garment alone when the clause states no colour', () => {
    expect(shortGarmentLabel('a woollen scarf, hand-knitted').label).toBe('the scarf');
  });

  it('hands back the head verbatim, and says so, when no garment noun is there', () => {
    expect(shortGarmentLabel('a woven grass basket'))
      .toEqual({ label: 'a woven grass basket', derived: false });
  });
});

describe('headIsUnderLayer', () => {
  it('finds the clause that declares itself the under-layer', () => {
    const heads = splitClausesDetailed(STRIPPED).map((c: any) => c.head);
    const under = heads.filter((h: string) => headIsUnderLayer(h));
    expect(under).toHaveLength(1);
    expect(under[0]).toContain('shirt');
  });
});

describe('buildRedressPrompt', () => {
  const prompt = buildRedressPrompt(STRIPPED, OFF);

  it('names every staying garment', () => {
    for (const label of ['the red cap', 'the navy trousers', 'the brown boots']) {
      expect(prompt).toContain(label);
    }
  });

  it('sends no descriptive adjective of a staying garment', () => {
    // These are exactly the words that invited the repaint.
    for (const word of ['chunky-knit', 'corduroy', 'folded cuff', 'lace-up', 'straight-leg', 'wool ', 'leather']) {
      expect(prompt.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('describes the newly-visible garment in full — it has to be drawn', () => {
    expect(prompt).toContain('long-sleeved white cotton shirt');
  });

  it('keeps the front-vs-back instruction', () => {
    expect(prompt).toMatch(/facing the viewer/i);
    expect(prompt).toMatch(/turned away/i);
    expect(prompt).toMatch(/rather than uncover/i);
  });

  it('keeps the removal line whole', () => {
    expect(prompt).toContain(OFF[0]);
    expect(prompt).toMatch(/no replacement garment/i);
    expect(prompt).toMatch(/nowhere else in the sheet/i);
  });

  it('keeps the invariants', () => {
    for (const inv of ['same face', 'same hair', 'same body', 'same poses', 'same cell layout', 'same art style']) {
      expect(prompt.toLowerCase()).toContain(inv);
    }
  });

  it('omits the under-layer line when no clause declares one, and still labels everything', () => {
    const p = buildRedressPrompt('a red cap; navy trousers; brown boots.', ['green jacket']);
    expect(p).toContain('the red cap');
    expect(p).toContain('the navy trousers');
    expect(p).not.toMatch(/the garment under it/i);
  });
});
