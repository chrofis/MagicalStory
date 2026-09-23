import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import { validateCoverHintCast } from '../../server/lib/coverIterate.js';

// The cover cast is the Art Director's (owner, 2026-09-23): a phantom the hint
// declares is dropped, and nobody the AD did not place is ever added. The
// refill that padded every cover up to MAX_COVER_CHARACTERS is deleted
// (docs/audits/prompt-audit-2026-09-23/09-covers.md C4).

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
  it('drops a phantom from every hint container and adds nobody in its place', () => {
    const hints = {
      backCover: hintWith(['Lily', 'Ethan', 'James', 'Rachel', 'The smallest girl (centre front, facing viewer)']),
    };
    const res = validateCoverHintCast(hints, cast, {});
    expect(res.dropped.map((d: any) => d.name)).toEqual(['The smallest girl']);
    expect(res).not.toHaveProperty('backfilled');
    const h: any = hints.backCover;
    expect(h.characters).toEqual(['Lily', 'Ethan', 'James', 'Rachel']);
    for (const key of ['characterDetails', 'characterClothing', 'characterPerspectives']) {
      expect(Object.keys(h[key]).some(k => /smallest/i.test(k))).toBe(false);
      expect(Object.keys(h[key])).not.toContain('Margaret');
    }
  });

  it('leaves a valid cast untouched', () => {
    const hints = { backCover: hintWith(['Lily', 'Ethan', 'James', 'Rachel', 'Margaret']) };
    const res = validateCoverHintCast(hints, cast, {});
    expect(res.dropped).toEqual([]);
    expect((hints.backCover as any).characters).toHaveLength(5);
  });

  it('keeps a two-character cover at two — the AD cast is not padded to the cap', () => {
    // The shape of staging job_1790100385959_1nitlympp's title page: two
    // children cast by the AD, three more in the story.
    const hints = { initialPage: hintWith(['Lily (center)', 'James (right foreground)']) };
    const res = validateCoverHintCast(hints, cast, {});
    expect(res.dropped).toEqual([]);
    expect((hints.initialPage as any).characters).toEqual(['Lily (center)', 'James (right foreground)']);
    expect(Object.keys((hints.initialPage as any).characterDetails)).toEqual(['Lily', 'James']);
  });

  it('a front cover missing a main character is not given one', () => {
    const hints = { frontCover: hintWith(['Lily']) };
    validateCoverHintCast(hints, cast, {});
    expect((hints.frontCover as any).characters).toEqual(['Lily']);
  });

  it('resolves a hint name that carries an honorific', () => {
    const hints = { backCover: hintWith(['Grossvater James', 'Lily', 'Ethan']) };
    const res = validateCoverHintCast(hints, cast, {});
    expect(res.dropped).toEqual([]);
    expect((hints.backCover as any).characters).toEqual(['Grossvater James', 'Lily', 'Ethan']);
  });

  it('a hint that names nobody real is an ERROR, and stays empty', () => {
    const errors: string[] = [];
    const logger = { error: (m: string) => errors.push(m), warn: () => {} };
    const hints = { backCover: hintWith(['The smallest girl', 'A tall stranger']) };
    const res = validateCoverHintCast(hints, cast, { logger });
    expect(res.dropped).toHaveLength(2);
    expect((hints.backCover as any).characters).toEqual([]);
    expect(errors.length).toBe(1);
  });

  it('is a no-op without a cast', () => {
    const hints = { backCover: hintWith(['Whoever']) };
    const res = validateCoverHintCast(hints, [], {});
    expect(res.dropped).toEqual([]);
    expect((hints.backCover as any).characters).toEqual(['Whoever']);
  });
});
