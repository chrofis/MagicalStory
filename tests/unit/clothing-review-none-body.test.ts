/**
 * BUG clothing-review-none-body-erases-outfit (2026-09-28). Staging
 * job_1790529840433_ar4u7qry3: the wardrobe review wrote a heading for Noah
 * and then NONE under it. The parser read that as a rewrite whose outfit is
 * the word "NONE", the merge wrote it into the contract, and the Art Director
 * was handed "Noah … Wearing: NONE" — three pages then described Noah
 * "wearing no clothing".
 *
 * Pins: a heading whose body is only the no-change marker is not a rewrite;
 * a real rewrite in the same reply still parses; and the outfit guard names a
 * character whose used category has no outfit.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { parseClothingReview } = req('../../server/lib/promptBuilders');
const { outfitAbsent } = req('../../server/lib/clothingCheck');

// The stored reply's CLOTHING section, verbatim.
const STORED = `---ANALYSIS---
1. Costume recognisability — Emma lacks a pirate headpiece.
---CLOTHING---
## Emma / costumed (costume: pirate)
red and white striped cotton long-sleeve undershirt with a round neck; black cotton calf-length trousers with ragged cut-off hems; brown leather ankle boots with a single strap buckle; red cotton bandana folded into a triangle and tied over the head, knot at the nape

## Noah / costumed (costume: pirate)
NONE`;

describe('parseClothingReview — a heading answered NONE is not a rewrite', () => {
  it('keeps Emma\'s rewrite and drops Noah\'s NONE (the stored reply)', () => {
    const { entries } = parseClothingReview(STORED);
    expect(entries.map((e: any) => e.name)).toEqual(['Emma']);
    expect(entries[0].description).toMatch(/^red and white striped/);
  });

  it('drops the marker in any case, with trailing punctuation', () => {
    for (const body of ['none', 'NONE.', '  None  ']) {
      const { entries } = parseClothingReview(`---CLOTHING---\n## Noah / standard\n${body}\n`);
      expect(entries).toEqual([]);
    }
  });

  it('keeps an outfit that merely contains the word none', () => {
    const { entries } = parseClothingReview('---CLOTHING---\n## Noah / standard\nblue shirt with none of the buttons done up; brown trousers; black boots\n');
    expect(entries).toHaveLength(1);
  });
});

describe('outfitAbsent — the input guard before the Art Director', () => {
  it('names a character whose only used category carries no outfit', () => {
    const reqs = {
      Emma: { costumed: { used: true, costume: 'pirate', description: 'red shirt; black trousers; brown boots' } },
      Noah: { costumed: { used: true, costume: 'pirate', description: 'NONE' }, standard: { used: false } },
      Hans: { standard: { used: true, description: '' } },
    };
    expect(outfitAbsent(reqs, ['Emma', 'Noah', 'Hans'])).toEqual(['Noah', 'Hans']);
  });

  it('names a listed character missing from the contract, and nobody when all are dressed', () => {
    const reqs = { Emma: { standard: { used: true, description: 'red shirt; blue jeans; white sneakers' } } };
    expect(outfitAbsent(reqs, ['Emma', 'Max'])).toEqual(['Max']);
    expect(outfitAbsent(reqs, ['Emma'])).toEqual([]);
  });
});
