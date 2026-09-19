import { describe, it, expect } from 'vitest';

/**
 * Fixtures are VERBATIM figures from job_1789207854566_l43qgl34w (staging),
 * not invented shapes. Boxes are normalised [x1,y1,x2,y2].
 */
const { isMicroFigure, countRealFigures } = require('../../server/lib/bboxDetection');

// The four micro-figures that inflated the count on p6 / p7 / p8 / p12 / p15.
// Every one: no face, no sam points, confidence low, 0.37%-0.64% of frame,
// and score ~0.48-0.59 — which is why figureDetection's own <0.45 prune kept
// them.
const MICRO = [
  { name: 'UNKNOWN', page: 6, score: 0.594, confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.0732421875, 0.62109375, 0.2119140625, 0.6669921875] },
  { name: 'UNKNOWN', page: 7, score: 0.521, confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.0498046875, 0.6025390625, 0.1865234375, 0.6494140625] },
  { name: 'UNKNOWN', page: 8, score: 0.483, confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.0537109375, 0.8203125, 0.1552734375, 0.8564453125] },
  { name: 'UNKNOWN', page: 12, score: 0.507, confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.0498046875, 0.61328125, 0.1845703125, 0.6591796875] },
  { name: 'UNKNOWN', page: 15, score: 0.523, confidence: 'low', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.0654296875, 0.5048828125, 0.189453125, 0.5478515625] },
];

// p5 is a five-figure BACK-VIEW page. Four genuine cast members have faceBox
// null, facePoint null and samPoints empty — the same three conjuncts as the
// micro-figures. They survive on AREA alone. This is the case that forbids
// keying the filter on "has no face".
const BACK_VIEW_CAST = [
  { name: 'Saira', score: 0.685, confidence: 'high', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.3876953125, 0.5830078125, 0.9140625, 0.75390625] },
  { name: 'Fiona', score: 0.684, confidence: 'high', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.3955078125, 0.05859375, 0.9169921875, 0.23828125] },
  { name: 'Sarah', score: 0.677, confidence: 'high', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.3994140625, 0.4228515625, 0.90625, 0.5849609375] },
  { name: 'Facundo', score: 0.674, confidence: 'high', faceBox: null, facePoint: null, samPoints: [], gdinoBox: [0.34765625, 0.2265625, 0.9052734375, 0.4306640625] },
];

const area = (b: number[]) => Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);

describe('isMicroFigure', () => {
  it('drops every micro-figure measured on the story', () => {
    for (const f of MICRO) expect(isMicroFigure(f), `p${f.page}`).toBe(true);
  });

  it('keeps every genuine back-view cast figure on the faceless page', () => {
    for (const f of BACK_VIEW_CAST) expect(isMicroFigure(f), f.name).toBe(false);
  });

  it('the measured margin is wide, not marginal', () => {
    const largestMicro = Math.max(...MICRO.map(f => area(f.gdinoBox)));
    const smallestReal = Math.min(...BACK_VIEW_CAST.map(f => area(f.gdinoBox)));
    expect(largestMicro).toBeLessThan(0.0065);
    expect(smallestReal).toBeGreaterThan(0.04);
    expect(smallestReal / largestMicro).toBeGreaterThan(6);
  });

  it('a face box alone saves a tiny figure', () => {
    const tinyWithFace = { ...MICRO[0], faceBox: [0.08, 0.63, 0.1, 0.64] };
    expect(isMicroFigure(tinyWithFace)).toBe(false);
  });

  it('a face point alone saves a tiny figure', () => {
    expect(isMicroFigure({ ...MICRO[0], facePoint: [0.09, 0.63] })).toBe(false);
  });

  it('a SAM seed alone saves a tiny figure', () => {
    expect(isMicroFigure({ ...MICRO[0], samPoints: [[0.09, 0.63]] })).toBe(false);
  });

  it('a non-low confidence alone saves a tiny figure', () => {
    expect(isMicroFigure({ ...MICRO[0], confidence: 'medium' })).toBe(false);
  });

  it('area at or above 1% of frame is kept', () => {
    expect(isMicroFigure({ ...MICRO[0], gdinoBox: [0, 0, 0.1, 0.1] })).toBe(false);
    expect(isMicroFigure({ ...MICRO[0], gdinoBox: [0, 0, 0.1, 0.099] })).toBe(true);
  });

  it('falls back to `box` when there is no gdinoBox', () => {
    const { gdinoBox, ...rest } = MICRO[1] as any;
    expect(isMicroFigure({ ...rest, box: gdinoBox })).toBe(true);
  });

  it('refuses to judge a pixel-space box — fails safe, keeps the figure', () => {
    expect(isMicroFigure({ ...MICRO[0], gdinoBox: [50, 600, 210, 660] })).toBe(false);
  });

  it('tolerates junk input', () => {
    for (const junk of [null, undefined, {}, 'x', 7, { gdinoBox: [1, 2] }]) {
      expect(isMicroFigure(junk as any)).toBe(false);
    }
  });
});

describe('countRealFigures', () => {
  it('returns null for a missing figures array — absent is not zero', () => {
    expect(countRealFigures(undefined)).toBeNull();
    expect(countRealFigures(null)).toBeNull();
  });

  it('counts zero for an empty page', () => {
    expect(countRealFigures([])).toBe(0);
  });

  it('p7: 6 detected figures count as 5', () => {
    const p7 = [
      { name: 'Fiona', confidence: 'high', faceBox: [0], facePoint: [0], samPoints: [1, 2, 3, 4], gdinoBox: [0.204, 0.763, 0.958, 0.969] },
      { name: 'UNKNOWN', confidence: 'low', faceBox: [0], facePoint: [0], samPoints: [1, 2, 3, 4], gdinoBox: [0.159, 0.047, 0.931, 0.238] },
      { name: 'Sarah', confidence: 'high', faceBox: [0], facePoint: [0], samPoints: [1], gdinoBox: [0.236, 0.599, 0.875, 0.780] },
      { name: 'Saira', confidence: 'high', faceBox: [0], facePoint: [0], samPoints: [1], gdinoBox: [0.232, 0.397, 0.829, 0.578] },
      { name: 'Facundo', confidence: 'high', faceBox: [0], facePoint: [0], samPoints: [1], gdinoBox: [0.166, 0.204, 0.857, 0.408] },
      MICRO[1],
    ];
    expect(countRealFigures(p7)).toBe(5);
  });

  it('p5: all five back-view figures count', () => {
    const lorena = { name: 'Lorena', confidence: 'high', faceBox: [0], facePoint: [0], samPoints: [1], gdinoBox: [0.388, 0.753, 0.916, 0.941] };
    expect(countRealFigures([lorena, ...BACK_VIEW_CAST])).toBe(5);
  });

  it('does not mutate the array it is given', () => {
    const figs = [...BACK_VIEW_CAST, MICRO[0]];
    const before = figs.length;
    countRealFigures(figs);
    expect(figs.length).toBe(before);
    expect(figs[figs.length - 1]).toBe(MICRO[0]);
  });
});
