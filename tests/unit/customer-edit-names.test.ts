/**
 * A customer's page/cover edit names characters by descriptor (prod jobs
 * job_1793893086454_ao77wh9j5 / job_1793959308869_fre2mb4d0: ten edits of "polina ist
 * kleiner als melodi", the image model could not tell which girl was Polina).
 * docs/decisions.md 2026-11-06.
 */
import { describe, it, expect } from 'vitest';

const { buildRepairNameMap, nameRepairText, nameCustomerEditText, describeFigureForRepair, repairGarmentPhrase } = require('../../server/lib/repairLogic');
const { stripCharacterNames } = require('../../server/lib/imageCompositing');

const CAST = [
  { name: 'Polina', age: 5, gender: 'female' },
  { name: 'Melodi', age: 5, gender: 'female' },
];
const REQS = {
  Polina: { standard: { used: true, garments: [
    { name: 'puffer jacket', slot: 'outer layer', colour: 'green' },
    { name: 'jump rope looped over her shoulder', slot: 'accessories', colour: 'yellow' },
  ] } },
  Melodi: { standard: { used: true, garments: [{ name: 'rain jacket', slot: 'outer layer', colour: 'blue' }] } },
};
const VB = {
  artifacts: [{ id: 'ART003', name: 'yellow skipping rope', slot: 'accessories', label: 'yellow jump rope', wornAs: 'Polina.accessories' }],
};
const story = (extra = {}) => ({ characters: CAST, clothingRequirements: REQS, visualBible: VB, ...extra });
const CLOTHING = { Polina: 'standard', Melodi: 'standard' };

describe('case-insensitive names (customer text only)', () => {
  const map = buildRepairNameMap({ characters: CAST, characterClothing: CLOTHING, clothingRequirements: REQS });

  it('pipeline text stays case-sensitive by default', () => {
    expect(nameRepairText('polina is small', map)).toBe('polina is small');
    expect(nameRepairText('Polina is small', map)).toMatch(/^the 5-year-old girl in the green puffer jacket is small$/);
  });

  it('caseSensitive:false replaces a lowercase name, and a possessive', () => {
    const out = nameRepairText("polina ist kleiner als MELODI, melodi's arm", map, { caseSensitive: false });
    expect(out).not.toMatch(/polina|melodi/i);
    expect(out).toMatch(/blue rain jacket's arm/);
  });

  it('stripCharacterNames defaults to case-sensitive', () => {
    const opts = { names: ['Rose'], fallbackByName: new Map([['rose', 'the girl']]) };
    expect(stripCharacterNames('a rose in the Rose garden', opts)).toBe('a rose in the the girl garden');
    expect(stripCharacterNames('a rose in the Rose garden', { ...opts, caseSensitive: false })).toBe('a the girl in the the girl garden');
  });
});

describe('garment before accessory', () => {
  const base = { character: CAST[0], category: 'standard', clothingRequirements: REQS, visualBible: VB, sceneMetadata: {}, pageNumber: 6 };

  it('names the jacket, not the tracked jump rope', () => {
    expect(repairGarmentPhrase(base)).toBe('green puffer jacket');
  });

  it('falls back to the tracked accessory only when no garment is available', () => {
    const onlyRope = { Polina: { standard: { used: true, garments: [{ name: 'rope', slot: 'accessories', colour: 'yellow' }] } } };
    // the outfit still has an accessory row; with no garment slot the tracked item is the last resort
    expect(repairGarmentPhrase({ ...base, clothingRequirements: onlyRope })).toBeTruthy();
    expect(repairGarmentPhrase({ ...base, category: null })).toBe('yellow jump rope');
  });

  it('a tracked GARMENT (a cape handed to her) still wins over the outfit', () => {
    const vb = { artifacts: [{ id: 'ART009', name: 'red cape', slot: 'outer layer', label: 'red cape', wornAs: 'Polina.outer layer' }] };
    expect(repairGarmentPhrase({ ...base, visualBible: vb })).toBe('red cape');
  });
});

describe('nameCustomerEditText (what both customer edit routes call)', () => {
  it('turns lowercase names into garment descriptors', () => {
    const out = nameCustomerEditText('polina ist kleiner als melodi', { storyData: story(), pageNumber: 6, characterClothing: CLOTHING });
    expect(out).toBe('the 5-year-old girl in the green puffer jacket ist kleiner als the 5-year-old girl in the blue rain jacket');
  });

  it('a cover passes its typed clothing and gets garments too', () => {
    const noClothing = nameCustomerEditText('polina', { storyData: story(), pageNumber: -2 });
    expect(noClothing).not.toMatch(/green puffer jacket/);   // no clothing category: only the tracked item is known
    const withClothing = nameCustomerEditText('polina', { storyData: story(), pageNumber: -2, characterClothing: CLOTHING });
    expect(withClothing).toMatch(/green puffer jacket/);
  });

  it('both edit routes call it', () => {
    const src = require('fs').readFileSync(require('path').resolve('server/routes/regeneration.js'), 'utf8');
    expect(src).toMatch(/editImageWithPrompt\(currentImage\.imageData, namedEditPrompt\)/);
    expect(src).toMatch(/editImageWithPrompt\(editBaseSrc, namedEditPrompt\)/);
    expect(src.match(/nameCustomerEditText\(editPrompt/g)?.length).toBe(2);
  });
});

describe('customer edit descriptor carries the hair (decisions.md 2026-11-06, hair)', () => {
  const hairy = [
    { ...CAST[0], physical: { hairColor: 'brown', detailedHairAnalysis: { type: 'wavy', lengthTop: 'mid-back', styling: 'loose', bangsEndAt: 'no bangs' } } },
    { ...CAST[1], physical: { hairColor: 'dark brown', detailedHairAnalysis: { type: 'straight', lengthTop: 'shoulder-length', styling: 'ponytail', bangsEndAt: 'no bangs' } } },
  ];
  const s = story({ characters: hairy });

  it('puts colour, texture, length and style between the noun and the garment', () => {
    const out = nameCustomerEditText('polina ist kleiner als melodi', { storyData: s, pageNumber: 6, characterClothing: CLOTHING });
    expect(out).toBe('the 5-year-old girl with brown wavy mid-back loose hair in the green puffer jacket ist kleiner als the 5-year-old girl with dark brown straight shoulder-length ponytail hair in the blue rain jacket');
  });

  it('a character with no stored hair gets no hair clause', () => {
    const out = nameCustomerEditText('polina', { storyData: story(), pageNumber: 6, characterClothing: CLOTHING });
    expect(out).toBe('the 5-year-old girl in the green puffer jacket');
  });

  it('pipeline repair descriptors stay hair-free', () => {
    const map = buildRepairNameMap({ characters: hairy, characterClothing: CLOTHING, clothingRequirements: REQS });
    expect(nameRepairText('Polina is small', map)).toBe('the 5-year-old girl in the green puffer jacket is small');
  });
});
