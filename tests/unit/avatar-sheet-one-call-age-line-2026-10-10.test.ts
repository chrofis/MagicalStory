import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
const { headFractionNorm, ageProportionsLine, buildOneCallSheetPrompt } = require('../../server/lib/character2x4Sheet.js');

// Lab-only one-call sheet (avatar_sheet_variant 'oneCall'): the explicit head-to-height line and the one norm table the
// Lab measurement reads too (docs/decisions.md 2026-10-10 "Trial costume sheet: two fast options measured").
describe('head-to-height norms', () => {
  it.each([[2, 4], [3, 4], [4, 4.5], [5, 5], [6, 5], [8, 5.5], [10, 6], [12, 6.5], [16, 7], [25, 7.25], [68, 7.25]])('age %i -> 1/%d', (age, n) => {
    expect(headFractionNorm(age)).toBe(n);
  });
  it('no age -> null, so no line is invented', () => {
    expect(headFractionNorm(undefined)).toBeNull();
    expect(ageProportionsLine({ name: 'A' })).toBe('');
  });
});

describe('one-call prompt age line', () => {
  const base = { costumeDescription: 'a blue robe', styleLine: 'watercolour' };
  it('child: states 1/N of standing height, long legs, not chibi', () => {
    const line = ageProportionsLine({ age: 5 });
    expect(line).toContain('1/5');
    expect(line).toContain('long legs');
    expect(line).toContain('not chibi');
    expect(line).toContain('child of that age');
  });
  it('adult wording says adult', () => {
    expect(ageProportionsLine({ age: 38 })).toContain('real adult');
  });
  it('the line is only in the prompt when asked (the earlier Lab runs stay reproducible)', () => {
    const off = buildOneCallSheetPrompt({ age: 5 }, base);
    const on = buildOneCallSheetPrompt({ age: 5 }, { ...base, ageLine: true });
    expect(off).not.toContain('of the figure\'s standing height');
    expect(on).toContain('1/5 of the figure\'s standing height');
    expect(on.replace(ageProportionsLine({ age: 5 }), '')).toBe(off);
  });
});
