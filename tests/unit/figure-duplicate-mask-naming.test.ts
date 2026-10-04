/**
 * Code review 2026-10 C1: removing a duplicate mask must not shift the names
 * of the figures after it. nameByDet is keyed by the ORIGINAL person index.
 * C4: the depth-order tie-break used the area of an index (NaN).
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _dropDuplicateFigureDets } = require('../../server/lib/figureDetection.js');

const mask = (cells: number[]) => {
  const alpha = new Uint8Array(16);
  cells.forEach(c => { alpha[c] = 1; });
  return { width: 4, height: 4, alpha, area: cells.length };
};

describe('_dropDuplicateFigureDets', () => {
  it('persons [A,B,B2,C]: survivors keep their original index so C is still named C', () => {
    const dets = [
      { personIdx: 0, mask: mask([0, 1, 2, 3]) },        // A
      { personIdx: 1, mask: mask([4, 5, 6, 7]) },        // B
      { personIdx: 2, mask: mask([4, 5, 6, 7]) },        // B' (same figure as B)
      { personIdx: 3, mask: mask([12, 13, 14, 15]) },    // C
    ];
    const diag: any = { persons: [{}, {}, {}, {}] };
    _dropDuplicateFigureDets(dets, diag);
    expect(dets.map(d => d.personIdx)).toEqual([0, 1, 3]);
    expect(diag.persons[2].droppedDuplicateOf).toBe(1);
    // The assembly looks names up by personIdx, never by array position.
    const nameByDet = new Map([[0, 'A'], [1, 'B'], [3, 'C']]);
    expect(dets.map(d => nameByDet.get(d.personIdx))).toEqual(['A', 'B', 'C']);
  });
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _compareDepthFrontFirst } = require('../../server/lib/figureDetection.js');

describe('_compareDepthFrontFirst (C4)', () => {
  it('same-height boxes, neither containing the other: the smaller box is in front (not NaN)', () => {
    const boxes = [[0, 0, 400, 500], [300, 100, 380, 500]]; // same bottom; partial overlap only
    boxes[1] = [390, 100, 480, 500];
    const r = _compareDepthFrontFirst(0, 1, boxes, [null, null], null);
    expect(Number.isNaN(r)).toBe(false);
    expect(r).toBeGreaterThan(0); // 0 is larger -> behind 1
    expect(_compareDepthFrontFirst(1, 0, boxes, [null, null], null)).toBeLessThan(0);
  });
});
