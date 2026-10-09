/**
 * An outfit's garment colour is a TYPED field the wardrobe author writes
 * (`garments: [{slot, name, colour}]`), not a colour word scanned out of the
 * description (docs/decisions.md, 2026-10-09). `clothingCheck.colourBefore`
 * returned no colour on 25 of 90 sampled garment mentions (colour after the
 * noun, a material between, a shade outside the list).
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const W = require('../../server/lib/wornItems');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { repairGarmentPhrase } = require('../../server/lib/repairLogic');
const clothingCheck = require('../../server/lib/clothingCheck');
const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified.js');

describe('the colour word scan is gone', () => {
  it('clothingCheck no longer exports colourBefore', () => {
    expect(clothingCheck.colourBefore).toBeUndefined();
  });
});

describe('normaliseGarments', () => {
  it('keeps a valid row and lower-cases the colour', () => {
    expect(W.normaliseGarments([{ slot: 'top', name: 'anorak', colour: 'Blue' }], 't')).toEqual([{ slot: 'top', name: 'anorak', colour: 'blue' }]);
  });
  it('drops a row with an unknown slot or no name; an unknown colour word becomes null', () => {
    const out = W.normaliseGarments([{ slot: 'neck', name: 'scarf' }, { slot: 'top', name: '' }, { slot: 'top', name: 'tee', colour: 'navy' }], 't');
    expect(out).toEqual([{ slot: 'top', name: 'tee', colour: null }]);
  });
  it('returns null for an absent or empty list', () => {
    expect(W.normaliseGarments(undefined, 't')).toBeNull();
    expect(W.normaliseGarments([], 't')).toBeNull();
  });
});

describe('repairGarmentPhrase reads the typed colour', () => {
  // The description puts the colour AFTER the noun and a material between: the word scan found none.
  const REQS: any = {
    Max: {
      standard: {
        used: true,
        description: 'Max wears an anorak in blue, a wool jumper, and boots of brown leather.',
        garments: [
          { slot: 'outer layer', name: 'anorak', colour: 'blue' },
          { slot: 'top', name: 'wool jumper', colour: 'green' },
          { slot: 'footwear', name: 'leather boots', colour: 'brown' },
        ],
      },
      costumed: { used: true, costume: 'pirate', description: 'x', garments: [{ slot: 'headwear', name: 'tricorn hat', colour: null }] },
    },
  };
  const phrase = (extra: any = {}) => repairGarmentPhrase({ character: { name: 'Max' }, category: 'standard', clothingRequirements: REQS, pageNumber: 3, ...extra });

  it('names the outer layer first, with the colour from the field', () => {
    expect(phrase()).toBe('blue anorak');
  });
  it('skips a slot the page takes off', () => {
    const vb = { clothing: [{ id: 'CLO001', name: 'blue anorak', slot: 'outer layer', wornBy: 'Max' }] };
    const meta = { wornItems: [{ id: 'CLO001', owner: 'Max', state: 'off', location: 'on the bench' }] };
    expect(phrase({ visualBible: vb, sceneMetadata: meta })).toBe('green wool jumper');
  });
  it('a costumed category reads the costumed list; a garment with no colour is named bare', () => {
    expect(phrase({ category: 'costumed:pirate' })).toBe('tricorn hat');
  });
  it('an outfit with no garment list yields no garment, not a guess from its prose', () => {
    const old = { Max: { standard: { used: true, description: 'Max wears a blue anorak.' } } };
    expect(repairGarmentPhrase({ character: { name: 'Max' }, category: 'standard', clothingRequirements: old, pageNumber: 3 })).toBeNull();
  });
});

describe('the reviewer carries the list with every rewrite', () => {
  const REPLY = `---ANALYSIS---
fine
---CLOTHING---
## Max / standard
Max wears a red hooded anorak and grey trousers.
GARMENTS: [{"slot": "outer layer", "name": "hooded anorak", "colour": "red"},
 {"slot": "bottom", "name": "trousers", "colour": "grey"}]
`;
  it('parseClothingReview splits the GARMENTS line off the description', () => {
    const { entries } = PB.parseClothingReview(REPLY);
    expect(entries).toHaveLength(1);
    expect(entries[0].description).toBe('Max wears a red hooded anorak and grey trousers.');
    expect(entries[0].garments).toEqual([{ slot: 'outer layer', name: 'hooded anorak', colour: 'red' }, { slot: 'bottom', name: 'trousers', colour: 'grey' }]);
  });
  it('applyClothingFix replaces description and list together', () => {
    const entry: any = { used: true, description: 'old', garments: [{ slot: 'top', name: 'old', colour: 'red' }] };
    const [fix] = PB.parseClothingReview(REPLY).entries;
    PB.applyClothingFix(entry, fix, 'Max/standard');
    expect(entry.description).toBe(fix.description);
    expect(entry.garments).toHaveLength(2);
  });
  it('a rewrite without a usable list leaves NO list (the old one described the replaced outfit)', () => {
    const entry: any = { used: true, description: 'old', garments: [{ slot: 'top', name: 'old', colour: 'red' }] };
    PB.applyClothingFix(entry, { description: 'new outfit', garments: null }, 'Max/standard');
    expect(entry.description).toBe('new outfit');
    expect(entry.garments).toBeUndefined();
  });
});

describe('the bible parser validates the list as it reads it', () => {
  it('keeps clean rows, and removes the field from a used outfit that has none', () => {
    const json = JSON.stringify({ clothingRequirements: {
      Max: { standard: { used: true, description: 'a', garments: [{ slot: 'top', name: 'tee', colour: 'red' }] }, winter: { used: false } },
      Eva: { standard: { used: true, description: 'b' } },
    } });
    const reqs = new UnifiedStoryParser('---CLOTHING REQUIREMENTS---\n```json\n' + json + '\n```\n').extractClothingRequirements();
    expect(reqs.Max.standard.garments).toEqual([{ slot: 'top', name: 'tee', colour: 'red' }]);
    expect(reqs.Eva.standard.garments).toBeUndefined();
  });
});

describe('both authoring prompts carry the list rule from one constant', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const inputData: any = { characters: [{ name: 'Pim', age: 3, gender: 'male' }], language: 'en', pages: 2, storyCategory: 'adventure', artStyle: 'watercolor' };
  const beats = [{ pageNumber: 1, planLine: 'wide - the main character - she walks - home' }];
  const REQS: any = { Pim: { standard: { used: true, description: 'Pim wears a red top.' } } };
  it('bible writer and reviewer', () => {
    for (const p of [PB.buildStoryBibleFromBeatsPrompt(inputData, beats), PB.buildClothingReviewPrompt(inputData, REQS, beats)]) {
      expect(p).toContain(W.GARMENT_LIST_RULE);
      expect(p).not.toContain('{GARMENT_LIST}');
    }
  });
  it('the colour words the wardrobe rule lists are the typed colour set', () => {
    expect(PB.buildStoryBibleFromBeatsPrompt(inputData, beats)).toContain(W.WARDROBE_COLOURS.join(', '));
  });
});
