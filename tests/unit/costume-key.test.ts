/**
 * One costume, one key. `costumed:<x>` labels are produced in two casings
 * (clothingCategories lower-cases, clothingResolve preserves case) and were
 * looked up case-sensitively in the `costumed: { <key>: … }` maps. These pin
 * that every writer and reader resolves to the same slot.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS module without types
import { slugifyCostume, costumeSubKey, pickCostumed } from '../../server/utils/costumeKey.js';

describe('costumeSubKey — the one key a costume lives under', () => {
  it('slugifies the colon part whatever its casing or spacing', () => {
    expect(costumeSubKey('costumed:Zauberlehrling')).toBe('zauberlehrling');
    expect(costumeSubKey('costumed:zauberlehrling')).toBe('zauberlehrling');
    expect(costumeSubKey('costumed:1889 Belle Epoque')).toBe('1889-belle-epoque');
  });

  it('falls back to the story costume name for a bare label, then to default', () => {
    expect(costumeSubKey('costumed', 'Pirate Captain')).toBe('pirate-captain');
    expect(costumeSubKey('costumed', null)).toBe('default');
    expect(costumeSubKey(null, null)).toBe('default');
  });

  it('agrees with slugifyCostume, which the composite cast builder already keys by', () => {
    expect(costumeSubKey('costumed:Ritter Rost')).toBe(slugifyCostume('Ritter Rost'));
  });
});

describe('pickCostumed — reads a map however its key was written', () => {
  it('finds the slot under the canonical slug', () => {
    expect(pickCostumed({ zauberlehrling: 'A' }, 'costumed:Zauberlehrling')).toBe('A');
  });

  it('still finds a slot stored under the raw colon part (data written before the slug was enforced)', () => {
    expect(pickCostumed({ Zauberlehrling: 'A' }, 'costumed:Zauberlehrling')).toBe('A');
  });

  it('prefers the canonical slot when both exist', () => {
    expect(pickCostumed({ Zauberlehrling: 'old', zauberlehrling: 'new' }, 'costumed:Zauberlehrling')).toBe('new');
  });

  it('one costume per character: a bare label or a miss takes the first entry', () => {
    expect(pickCostumed({ pirate: 'P' }, 'costumed')).toBe('P');
    expect(pickCostumed({ pirate: 'P' }, 'costumed:wizard')).toBe('P');
  });

  it('returns undefined for a missing or non-object map so callers keep their fallbacks', () => {
    expect(pickCostumed(null, 'costumed:x')).toBeUndefined();
    expect(pickCostumed('a string', 'costumed:x')).toBeUndefined();
    expect(pickCostumed({}, 'costumed:x')).toBeUndefined();
  });
});
