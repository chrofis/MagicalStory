import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import { validateCoverHintCast } from '../../server/lib/coverIterate.js';

const cast = [
  { id: 'c1', name: 'Lily', isMainCharacter: true },
  { id: 'c2', name: 'Ethan', isMainCharacter: true },
  { id: 'c3', name: 'James' },
  { id: 'c4', name: 'Rachel' },
  { id: 'c5', name: 'Margaret' },
];

const hintWith = (names: string[]) => ({
  characters: names,
  characterClothing: Object.fromEntries(names.map(n => [n.replace(/\s*\([^)]*\)\s*$/, '').trim(), 'standard'])),
  characterPerspectives: Object.fromEntries(names.map(n => [n.replace(/\s*\([^)]*\)\s*$/, '').trim(), { priority: 'normal' }])),
  characterDetails: Object.fromEntries(names.map(n => {
    const base = n.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return [base, { name: base, position: '', clothing: 'standard', holds: 'nothing', gazesAt: '', priority: 'normal' }];
  })),
});

describe('validateCoverHintCast', () => {
  it('drops a phantom and backfills the missing real character', () => {
    const hints = {
      backCover: hintWith(['Lily', 'Ethan', 'James', 'Rachel', 'The smallest girl (centre front, facing viewer)']),
    };
    const res = validateCoverHintCast(hints, cast, { mainIds: ['c1', 'c2'] });
    expect(res.dropped.map((d: any) => d.name)).toEqual(['The smallest girl']);
    expect(res.backfilled.map((d: any) => d.name)).toEqual(['Margaret']);
    const h: any = hints.backCover;
    expect(h.characters).toEqual(['Lily', 'Ethan', 'James', 'Rachel', 'Margaret']);
    for (const key of ['characterDetails', 'characterClothing', 'characterPerspectives']) {
      expect(Object.keys(h[key]).some(k => /smallest/i.test(k))).toBe(false);
    }
    expect(h.characterDetails.Margaret.name).toBe('Margaret');
  });

  it('leaves a valid cast untouched', () => {
    const hints = { backCover: hintWith(['Lily', 'Ethan', 'James', 'Rachel', 'Margaret']) };
    const res = validateCoverHintCast(hints, cast, { mainIds: ['c1', 'c2'] });
    expect(res.dropped).toEqual([]);
    expect(res.backfilled).toEqual([]);
    expect((hints.backCover as any).characters).toHaveLength(5);
  });

  it('does not backfill past the 5-character cap', () => {
    const bigCast = [...cast, { id: 'c6', name: 'Noah' }];
    const hints = { backCover: hintWith(['Lily', 'Ethan', 'James', 'Rachel', 'Margaret']) };
    const res = validateCoverHintCast(hints, bigCast, { mainIds: ['c1', 'c2'] });
    expect(res.backfilled).toEqual([]);
  });

  it('title page backfills mains only', () => {
    const hints = { frontCover: hintWith(['Lily']) };
    const res = validateCoverHintCast(hints, cast, { mainIds: ['c1', 'c2'] });
    expect(res.backfilled.map((d: any) => d.name)).toEqual(['Ethan']);
    expect((hints.frontCover as any).characters).toEqual(['Lily', 'Ethan']);
  });

  it('resolves a hint name that carries an honorific', () => {
    const hints = { backCover: hintWith(['Grossvater James', 'Lily', 'Ethan']) };
    const res = validateCoverHintCast(hints, cast, { mainIds: ['c1', 'c2'] });
    expect(res.dropped).toEqual([]);
    expect(res.backfilled.map((d: any) => d.name)).toEqual(['Rachel', 'Margaret']);
  });

  it('seeds backfilled clothing from clothingRequirements', () => {
    const hints = { backCover: hintWith(['Lily', 'Ethan']) };
    validateCoverHintCast(hints, cast, {
      mainIds: ['c1', 'c2'],
      clothingRequirements: { Margaret: { winter: { used: true } } },
    });
    expect((hints.backCover as any).characterClothing.Margaret).toBe('winter');
  });

  it('is a no-op without a cast', () => {
    const hints = { backCover: hintWith(['Whoever']) };
    const res = validateCoverHintCast(hints, [], {});
    expect(res.dropped).toEqual([]);
    expect((hints.backCover as any).characters).toEqual(['Whoever']);
  });
});
