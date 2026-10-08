/**
 * The repair descriptor's place clause (Fiona rerun, staging job_1791450210539_nwi88y9lr p4).
 * The inpaint text read "eyes fixed on the 24-year-old woman in the white shirt, fourth from the
 * left's back" on a page of two cast figures: the detector had also filed three distant
 * passers-by as UNKNOWN and the ordinal ranked among them, and the possessive 's landed on the
 * trailing place clause.
 */
import { describe, it, expect } from 'vitest';

const { describeFigureForRepair, buildRepairNameMap, nameRepairText } = require('../../server/lib/repairLogic');

const CAST = [
  { name: 'Ada', age: 24, gender: 'female' },
  { name: 'Bram', age: 50, gender: 'male' },
];
const CLOTHING = { Ada: 'standard', Bram: 'standard' };
// two cast figures and three tiny background walkers the detector could not name
const FIGURES = [
  { name: 'Ada', bodyBox: [0.19, 0.54, 0.97, 0.80] },
  { name: 'Bram', bodyBox: [0.17, 0.08, 0.90, 0.50] },
  { name: 'UNKNOWN', bodyBox: [0.49, 0.81, 0.59, 0.84] },
  { name: 'UNKNOWN', bodyBox: [0.50, 0.04, 0.58, 0.07] },
  { name: 'UNKNOWN', bodyBox: [0.48, 0.08, 0.60, 0.12] },
];

describe('describeFigureForRepair: place', () => {
  it('ranks only identified figures, so passers-by do not shift the ordinal', () => {
    const out = describeFigureForRepair({ name: 'Ada', characters: CAST, characterClothing: CLOTHING, detectedFigures: FIGURES });
    expect(out).toMatch(/on the far right$/);
    expect(out).not.toMatch(/fourth|third|second/);
  });

  it('says nothing about place when the page has one identified figure', () => {
    const out = describeFigureForRepair({ name: 'Ada', characters: CAST, characterClothing: CLOTHING, detectedFigures: [FIGURES[0], FIGURES[3]] });
    expect(out).not.toMatch(/left|right/);
  });

  it('placeless drops the place clause and nothing else', () => {
    const full = describeFigureForRepair({ name: 'Ada', characters: CAST, characterClothing: CLOTHING, detectedFigures: FIGURES });
    const bare = describeFigureForRepair({ name: 'Ada', characters: CAST, characterClothing: CLOTHING, detectedFigures: FIGURES, placeless: true });
    expect(full).toBe(`${bare}, on the far right`);
  });
});

describe('nameRepairText: possessive', () => {
  const map = buildRepairNameMap({ characters: CAST, characterClothing: CLOTHING, detectedFigures: FIGURES });

  it("puts the 's on the descriptor's noun phrase, not on its place clause", () => {
    const out = nameRepairText("Eyes fixed on Ada's back.", map);
    expect(out).not.toMatch(/right's/);
    expect(out).toMatch(/woman[^,]*'s back\.$/);
  });

  it('keeps the place clause for a non-possessive mention', () => {
    expect(nameRepairText('Eyes fixed on Ada.', map)).toMatch(/on the far right\.$/);
  });
});
