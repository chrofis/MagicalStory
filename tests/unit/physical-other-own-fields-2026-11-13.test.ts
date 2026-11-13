/**
 * Production read 2026-11-13: photo analyses had written glasses, facial hair, face shape and a smile into the
 * free-text `physical.other`, which every page and avatar prompt prints verbatim (a customer who set
 * glasses = none still got glasses). prompts/character-analysis.txt now keeps "distinctive markings" to marks
 * with no field of their own, and scripts/admin/clean-physical-other.js re-reads the stored photo with it.
 * docs/decisions.md 2026-11-13.
 */
import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');
const { buildChange, costOf } = require('../../scripts/admin/clean-physical-other');

const line = (file: string, key: string) =>
  fs.readFileSync(path.join(__dirname, '../../prompts', file), 'utf8').split('\n').find((l: string) => l.trimStart().startsWith(`"${key}"`)) || '';

describe('photo analysis keeps other to marks without a field', () => {
  it('character-analysis markings line excludes the typed facts', () => {
    const m = line('character-analysis.txt', 'distinctive markings');
    for (const w of ['Never glasses', 'Facial hair is NOT listed', 'face shape', 'expression']) expect(m).toContain(w);
  });
  it('character-analysis glasses line records nothing for glasses off the face', () => {
    expect(line('character-analysis.txt', 'glasses')).toMatch(/hanging from the neck/);
  });
  it('avatar-evaluation other line carries the same exclusion', () => {
    const o = line('avatar-evaluation.txt', 'other');
    for (const w of ['Never glasses', 'facial hair', 'face shape']) expect(o).toContain(w);
  });
});

describe('clean-physical-other buildChange', () => {
  const traits = (m: string, extra = {}) => ({ 'distinctive markings': m, glasses: 'none', facialHair: 'none', ...extra });

  it('takes the new markings as the new other', () => {
    const c = buildChange({ other: 'oval face with glasses and stubble', glasses: 'none' }, {}, traits('a mole on the cheek'));
    expect(c.newOther).toBe('a mole on the cheek');
    expect(c.oldOther).toBe('oval face with glasses and stubble');
  });
  it("writes 'none' when the new reading lists no mark", () => {
    expect(buildChange({ other: 'oval face with a slight smile' }, {}, traits('none')).newOther).toBe('none');
    expect(buildChange({ other: 'oval face' }, {}, traits('')).newOther).toBe('none');
  });
  it('fills facialHair only where the stored value is absent, and never fills glasses (the customer switch decides)', () => {
    const c = buildChange({ other: 'wears glasses' }, {}, traits('none', { glasses: 'round black glasses', facialHair: 'stubble' }));
    expect(c.set).toEqual({ facialHair: 'stubble' });
    const kept = buildChange({ other: 'wears glasses', glasses: 'none', facialHair: 'none' }, {}, traits('none', { glasses: 'round glasses', facialHair: 'stubble' }));
    expect(kept.set).toEqual({});
  });
  it('never overrides a field the customer typed, and skips a typed other', () => {
    expect(buildChange({ other: 'x' }, { glasses: 'user' }, traits('none', { glasses: 'round glasses' })).set).not.toHaveProperty('glasses');
    expect(buildChange({ other: 'freckles' }, { other: 'user' }, traits('none')).skip).toBeTruthy();
  });
  it('skips an empty other, an unchanged value and a reading without the field', () => {
    expect(buildChange({ other: 'none' }, {}, traits('x')).skip).toBeTruthy();
    expect(buildChange({ other: 'freckles', glasses: 'none', facialHair: 'none' }, {}, traits('freckles')).skip).toBe('unchanged');
    expect(buildChange({ other: 'freckles' }, {}, { glasses: 'none' }).skip).toBeTruthy();
  });
  it('finds a stored character whose id is a number from the text id in the plan', () => {
    const { findCharIndex } = require('../../scripts/admin/clean-physical-other.js');
    expect(findCharIndex([{ id: 1 }, { id: 1781304374465 }], '1781304374465')).toBe(1);
    expect(findCharIndex([{ id: '4' }], '4')).toBe(0);
    expect(findCharIndex([{ id: 5 }], '4')).toBe(-1);
  });
  it('prices a call from its token usage', () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0, thinkingTokens: 0 })).toBeCloseTo(0.3);
    expect(costOf({ inputTokens: 0, outputTokens: 500_000, thinkingTokens: 500_000 })).toBeCloseTo(2.5);
    expect(costOf(undefined)).toBe(0);
  });
});
