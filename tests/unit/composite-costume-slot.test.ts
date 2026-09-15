import { describe, it, expect } from 'vitest';

const { resolveStyledSheetSlot } = require('../../server/lib/compositeCastBuilder');

/**
 * clothingResolve.js collapses `costumed:<x>` to a bare `costumed` label before
 * the composite cast builder sees it. Reading that bare label as a non-costume
 * returned the whole `costumed` MAP as if it were a sheet: the cached sheet was
 * missed, a fresh 2x4 sheet was paid for, and the map was then overwritten with
 * a string so every later pickCostumed came back undefined.
 */
describe('composite cast: styled sheet slot for a costume label', () => {
  const styled = {
    standard: 'https://r2/standard.png',
    costumed: { 'pirate-captain': 'https://r2/pirate.png' },
  };

  it('a bare `costumed` label reads the costumed map, not the map itself', () => {
    const r = resolveStyledSheetSlot(styled, 'costumed', 'Pirate Captain');
    expect(r.isCostumed).toBe(true);
    expect(r.costumeKey).toBe('pirate-captain');
    expect(r.cachedSheet).toBe('https://r2/pirate.png');
  });

  it('a `costumed:<x>` label resolves the same slot and the same key', () => {
    const r = resolveStyledSheetSlot(styled, 'costumed:pirate captain', null);
    expect(r.costumeKey).toBe('pirate-captain');
    expect(r.cachedSheet).toBe('https://r2/pirate.png');
  });

  it('a bare costume with no story costume name still finds the one stored costume', () => {
    const r = resolveStyledSheetSlot(styled, 'costumed', null);
    expect(r.costumeKey).toBe('default');
    expect(r.cachedSheet).toBe('https://r2/pirate.png');
  });

  it('never returns the costumed map as a sheet', () => {
    for (const label of ['costumed', 'costumed:anything']) {
      const r = resolveStyledSheetSlot({ costumed: {} }, label, null);
      expect(typeof r.cachedSheet === 'object' && r.cachedSheet !== null).toBe(false);
    }
  });

  it('a non-costume label reads its own slot and has no costume key', () => {
    const r = resolveStyledSheetSlot(styled, 'standard', null);
    expect(r).toEqual({ isCostumed: false, costumeKey: null, cachedSheet: 'https://r2/standard.png' });
  });

  it('missing styled avatars are not a crash', () => {
    expect(resolveStyledSheetSlot(undefined, 'costumed', null).cachedSheet).toBeUndefined();
    expect(resolveStyledSheetSlot({}, 'winter', null).cachedSheet).toBeUndefined();
  });
});
