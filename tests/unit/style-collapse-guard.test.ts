import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import {
  batchCells,
  recutBatches,
  voidCollapsedBatches,
  CHUNK,
  // @ts-expect-error - JS module without types
} from '../../server/lib/styleConsistency.js';

// @ts-expect-error - JS module without types
import { pickBestVersionIndex } from '../../server/lib/scoring.js';

// The evidence story: 3 covers (-1,-2,-3) + 18 pages = 21 audited cells,
// batched into grids of CHUNK=9 → [-1,-2,-3,1..6], [7..15], [16,17,18].
const EVIDENCE_CELLS = [-1, -2, -3, ...Array.from({ length: 18 }, (_, i) => i + 1)];

/** every unordered pair of cells that shares a batch */
function pairsIn(batches: number[][]): Set<string> {
  const pairs = new Set<string>();
  for (const b of batches) {
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < b.length; j++) pairs.add([b[i], b[j]].sort((x, y) => x - y).join('|'));
    }
  }
  return pairs;
}

describe('style-consistency confirmation: re-cut grids', () => {
  it('keeps the same batch sizes as the first pass (same call count, same cost)', () => {
    const first = batchCells(EVIDENCE_CELLS, CHUNK);
    const second = recutBatches(EVIDENCE_CELLS, CHUNK);
    expect(first.map((b: number[]) => b.length)).toEqual([9, 9, 3]);
    expect(second.map((b: number[]) => b.length)).toEqual(first.map((b: number[]) => b.length));
  });

  it('re-cut batches are a permutation of the same cells — nothing lost or duplicated', () => {
    const flat = recutBatches(EVIDENCE_CELLS, CHUNK).flat();
    expect([...flat].sort((a: number, b: number) => a - b)).toEqual([...EVIDENCE_CELLS].sort((a, b) => a - b));
  });

  it('MINIMISES first-pass carry-over to the arithmetic floor for 21 cells / CHUNK 9', () => {
    // Zero overlap is impossible here and the code says so: 21 cells sit in
    // b = 3 first-pass grids, so any 9-cell second-pass grid must contain at
    // least ceil(9/3) = 3 cells from one of them (pigeonhole). What the re-cut
    // guarantees instead is that the carry-over lands at the floor.
    const first = pairsIn(batchCells(EVIDENCE_CELLS, CHUNK));
    const second = pairsIn(recutBatches(EVIDENCE_CELLS, CHUNK));
    const survived = [...second].filter(p => first.has(p));

    expect(first.size).toBe(75);                 // 36 + 36 + 3
    // ACHIEVED BOUND: 24 of the 75 first-pass pairs survive the re-cut (32%),
    // i.e. 68% of every cell's first-pass neighbourhood is new. 24 is the
    // minimum reachable with batch sizes [9,9,3]: the best possible spread is
    // 4+4+1 / 4+4+1 / 1+1+1 cells per source grid → 6+6+0 + 6+6+0 + 0 = 24.
    expect(survived.length).toBe(24);

    // And per cell: nobody keeps more than half of their ≤8 first-pass mates.
    for (const cell of EVIDENCE_CELLS) {
      const kept = survived.filter(p => p.split('|').map(Number).includes(cell)).length;
      expect(kept).toBeLessThanOrEqual(4);
    }
  });

  it('a single full grid (9 cells, one batch) is returned unchanged', () => {
    const cells = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(recutBatches(cells, CHUNK)).toEqual([cells]);
  });
});

describe('style-consistency structural collapse guard', () => {
  const flagged = (page: number, differences: string[]) => ({ page, severity: 'major', differences });

  it('voids a grid that flags 100% of its own cells with one shared rationale', () => {
    const shared = ['no brushstrokes', 'no paper texture'];
    const batch = {
      pages: [1, 2, 3],
      outliers: [flagged(1, shared), flagged(2, shared), flagged(3, shared)],
      dominantStyleVerdict: 'wrong_medium',
      requestedStyleDifferences: ['photographic'],
    };
    const { results, voided } = voidCollapsedBatches([batch]);
    expect(voided).toEqual([{ pages: [1, 2, 3], flagged: 3, distinctRationales: 1 }]);
    expect(results[0].outliers).toEqual([]);
    expect(results[0].collapsed).toBe(true);
    // the batch's book-level medium verdict came from the same call — voided too
    expect(results[0].dominantStyleVerdict).toBe('matches');
    expect(results[0].requestedStyleDifferences).toEqual([]);
  });

  it('voids grid 0 of the evidence story job_1788614817116_vxnu60yjg', () => {
    // Replayed from the stored finalChecksReport.styleConsistency: 9/9 cells
    // flagged, eight rationale arrays byte-identical and one differing in a
    // single trailing string → 2 distinct arrays.
    const common = [
      'Lack of prominent visible brushstrokes and wet-on-wet washes',
      'No pigment pooling, granulating, or rough cold-press paper texture',
      'Sharp, defined edges instead of dissolving into the paper',
    ];
    const A = [...common, 'Faces lack loose washes with visible brushstroke texture, appearing digitally smooth'];
    const B = [...common, 'Overall rendering is digitally smooth, not painted by hand'];
    const pages = [-1, -2, -3, 1, 2, 3, 4, 5, 6];
    const grid0 = {
      pages,
      outliers: pages.map(p => flagged(p, p === 4 ? B : A)),
      dominantStyleVerdict: 'wrong_medium',
      requestedStyleDifferences: common,
    };
    const grid1 = { pages: [7, 8, 9, 10, 11, 12, 13, 14, 15], outliers: [], dominantStyleVerdict: 'matches', requestedStyleDifferences: [] };
    const grid2 = { pages: [16, 17, 18], outliers: [], dominantStyleVerdict: 'matches', requestedStyleDifferences: [] };

    const { results, voided } = voidCollapsedBatches([grid0, grid1, grid2]);
    expect(voided).toHaveLength(1);
    expect(voided[0]).toEqual({ pages, flagged: 9, distinctRationales: 2 });
    // Nothing survives to be intersected, confirmed, or repainted: the 9 Grok
    // repaints this story ran never get queued.
    expect(results.flatMap((r: any) => r.outliers)).toEqual([]);
  });

  it('does NOT void a grid with three or more distinct rationale arrays', () => {
    const batch = {
      pages: [1, 2, 3],
      outliers: [flagged(1, ['a']), flagged(2, ['b']), flagged(3, ['c'])],
    };
    const { results, voided } = voidCollapsedBatches([batch]);
    expect(voided).toEqual([]);
    expect(results[0].outliers).toHaveLength(3);
  });

  it('does NOT void a grid that flagged only some of its cells, however uniform', () => {
    const shared = ['no brushstrokes'];
    const batch = { pages: [1, 2, 3], outliers: [flagged(1, shared), flagged(2, shared)] };
    const { results, voided } = voidCollapsedBatches([batch]);
    expect(voided).toEqual([]);
    expect(results[0].outliers).toHaveLength(2);
  });

  it('never voids a single-cell grid — a grid of one cannot collapse', () => {
    const batch = { pages: [4], outliers: [flagged(4, ['photographic skin'])] };
    const { results, voided } = voidCollapsedBatches([batch]);
    expect(voided).toEqual([]);
    expect(results[0].outliers).toHaveLength(1);
  });

  it('is structural: it counts distinct rationale arrays, it never reads them', () => {
    // Same shape, nonsense words, different language — the guard fires
    // identically. Nothing in it matches on "brushstroke", "photographic" or
    // any other term.
    const shared = ['zzz qqq', 'lorem ipsum dolor'];
    const a = voidCollapsedBatches([{ pages: [1, 2], outliers: [flagged(1, shared), flagged(2, shared)] }]);
    const shared2 = ['keine Pinselstriche', 'kein Papierkorn'];
    const b = voidCollapsedBatches([{ pages: [1, 2], outliers: [flagged(1, shared2), flagged(2, shared2)] }]);
    expect(a.voided).toHaveLength(1);
    expect(b.voided).toHaveLength(1);
  });

  it('leaves clean batches untouched (intersect semantics still hold)', () => {
    const pass1 = [{ pages: [1, 2, 3], outliers: [flagged(2, ['photo skin']), flagged(3, ['photo skin, sharp'])] }];
    const pass2 = [{ pages: [3, 1, 2], outliers: [flagged(3, ['photo skin'])] }];
    const p1 = new Set(voidCollapsedBatches(pass1).results.flatMap((r: any) => r.outliers).map((o: any) => o.page));
    const p2 = new Set(voidCollapsedBatches(pass2).results.flatMap((r: any) => r.outliers).map((o: any) => o.page));
    // only the intersection survives
    expect([...p1].filter(p => p2.has(p))).toEqual([3]);
  });
});

describe('style repaint version selection (pipeline tieBreak: earliest)', () => {
  const v = (source: string, finalScore: number | null) => ({ source, finalScore, pageNumber: 6 });

  it('a repaint carrying the previous best score can NEVER win — the bug', () => {
    // What the pipeline used to push: score: prevBest.score. Reproduces
    // job_1788614817116_vxnu60yjg page 6 and the initial page.
    const versions = [v('original', 55), v('iterate-round-1', 70), v('style-repair-grok', 70)];
    expect(pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(1);
  });

  it('a repaint scored on its own bytes can win', () => {
    const versions = [v('original', 55), v('iterate-round-1', 70), v('style-repair-grok', 78)];
    expect(pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(2);
  });

  it('a repaint scored on its own bytes can also honestly lose', () => {
    const versions = [v('original', 55), v('iterate-round-1', 70), v('style-repair-grok', 61)];
    expect(pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(1);
  });

  it('an unscored repaint cannot win — which is why it is never pushed', () => {
    const versions = [v('original', 55), v('style-repair-grok', null)];
    expect(pickBestVersionIndex(versions, { tieBreak: 'earliest' })).toBe(0);
  });
});
