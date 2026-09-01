/**
 * Figure-registration math (computeFigureRegistration / transformBox / boxIou
 * in server/lib/samBlend.js).
 *
 * Grok Imagine re-renders the whole scene in box mode, so the repainted figure
 * routinely comes back scaled or shifted even when it is the right figure in
 * the right place. The registration aligns the new silhouette's bbox onto the
 * old one (uniform scale from the HEIGHT ratio, feet-anchored dy, centre-
 * aligned dx) BEFORE the IoU gate judges it. Geometry mirrors the owner's
 * failing repair (job_1788215224103_avu132n7je p16: draws ~1.3-1.6x oversized,
 * 12/12 rejected before this existed).
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeFigureRegistration, transformBox, boxIou } = require('../../server/lib/samBlend.js');

describe('computeFigureRegistration', () => {
  it('shrinks an oversized in-place redraw back onto the old silhouette (p16 shape)', () => {
    // Old Lorena: 230x600 standing figure; redraw ~1.5x larger, roughly centred on her.
    const oldBox = [470, 120, 700, 720];
    const newBox = [400, 40, 745, 940]; // 345x900
    const reg = computeFigureRegistration({ oldBox, newBox });
    expect(reg).not.toBeNull();
    expect(reg.scale).toBeCloseTo(600 / 900, 2);
    const tb = transformBox(newBox, reg);
    // Bottom anchored to the old feet, centres aligned.
    expect(tb[3]).toBeCloseTo(oldBox[3], 0);
    expect((tb[0] + tb[2]) / 2).toBeCloseTo((oldBox[0] + oldBox[2]) / 2, 0);
    // Alignment must improve dramatically.
    expect(boxIou(oldBox, tb)).toBeGreaterThan(boxIou(oldBox, newBox) + 0.2);
  });

  it('is a near-no-op for an aligned redraw', () => {
    const oldBox = [100, 100, 300, 600];
    const newBox = [102, 104, 302, 604];
    const reg = computeFigureRegistration({ oldBox, newBox });
    expect(reg.scale).toBeCloseTo(1, 2);
    expect(Math.abs(reg.dx)).toBeLessThanOrEqual(3);
    expect(Math.abs(reg.dy)).toBeLessThanOrEqual(5);
  });

  it('clamps a wild SAM box so the paste cannot explode or vanish', () => {
    const oldBox = [0, 0, 200, 800];
    const tiny = computeFigureRegistration({ oldBox, newBox: [0, 0, 40, 60] });
    expect(tiny.scale).toBeLessThanOrEqual(1.45);
    const huge = computeFigureRegistration({ oldBox, newBox: [0, 0, 900, 4000] });
    expect(huge.scale).toBeGreaterThanOrEqual(0.6);
  });

  it('refuses degenerate silhouettes', () => {
    expect(computeFigureRegistration({ oldBox: [0, 0, 10, 5], newBox: [0, 0, 100, 200] })).toBeNull();
    expect(computeFigureRegistration({ oldBox: null, newBox: [0, 0, 100, 200] })).toBeNull();
  });

  it('uses the height ratio, not width — a pose that widens the arms is not squashed', () => {
    const oldBox = [100, 100, 300, 700];   // 200 wide, 600 tall
    const newBox = [50, 100, 450, 700];    // arms out: 400 wide, same height
    const reg = computeFigureRegistration({ oldBox, newBox });
    expect(reg.scale).toBeCloseTo(1, 2);
  });
});

describe('boxIou', () => {
  it('identity is 1, disjoint is 0', () => {
    expect(boxIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(boxIou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
  });
});
