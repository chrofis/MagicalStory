/**
 * White-hole coverage guard (measureWhiteHole, server/lib/samBlend.js).
 *
 * Owner ruling 2026-09-02: the whiteout/crosshatch region must come back
 * covered — by the redrawn figure's cut or by real painted background — or the
 * attempt is rejected BEFORE compositing. Evidence: G7 p16 v2-f1-s5.png shipped
 * a white rectangle because Grok redrew the figure elsewhere and left part of
 * the treated silhouette near-white; the white-card gate averages over the
 * whole union so the partial hole slipped under its 22%.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { measureWhiteHole } = require('../../server/lib/samBlend.js');

// 10x10 crop helpers
const N = 100;
const mask = (pred: (i: number) => boolean) => {
  const b = Buffer.alloc(N);
  for (let i = 0; i < N; i++) b[i] = pred(i) ? 255 : 0;
  return b;
};
const rgb = (pxColor: (i: number) => [number, number, number]) => {
  const b = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) {
    const [r, g, bl] = pxColor(i);
    b[i * 3] = r; b[i * 3 + 1] = g; b[i * 3 + 2] = bl;
  }
  return b;
};

describe('measureWhiteHole — treated-region coverage', () => {
  it('fully covered old silhouette → zero hole', () => {
    const oldA = mask((i) => i < 40);
    const newDil = mask((i) => i < 50); // new figure covers old entirely
    const candRaw = rgb(() => [255, 255, 255]); // even a white candidate is fine when covered
    const r = measureWhiteHole({ oldA, sOld: 1, newDil, candRaw, n: N });
    expect(r.oldCnt).toBe(40);
    expect(r.uncoveredWhite).toBe(0);
    expect(r.frac).toBe(0);
  });

  it('uncovered old region with near-white candidate content = a hole', () => {
    const oldA = mask((i) => i < 40);
    const newDil = mask((i) => i < 20); // figure moved: half the old silhouette uncovered
    const candRaw = rgb((i) => (i >= 20 && i < 40 ? [250, 250, 250] : [120, 90, 60]));
    const r = measureWhiteHole({ oldA, sOld: 1, newDil, candRaw, n: N });
    expect(r.uncoveredWhite).toBe(20);
    expect(r.frac).toBeCloseTo(0.5);
  });

  it('uncovered old region filled with painted background is NOT a hole (legit shrink repair)', () => {
    const oldA = mask((i) => i < 40);
    const newDil = mask((i) => i < 20);
    const candRaw = rgb(() => [214, 190, 150]); // sand — model painted real background
    const r = measureWhiteHole({ oldA, sOld: 1, newDil, candRaw, n: N });
    expect(r.uncoveredWhite).toBe(0);
    expect(r.frac).toBe(0);
  });

  it('near-white threshold matches the white-card gate (243 on all channels)', () => {
    const oldA = mask((i) => i < 10);
    const newDil = mask(() => false);
    const at243 = measureWhiteHole({ oldA, sOld: 1, newDil, candRaw: rgb(() => [243, 243, 243]), n: N });
    const below = measureWhiteHole({ oldA, sOld: 1, newDil, candRaw: rgb(() => [242, 243, 243]), n: N });
    expect(at243.uncoveredWhite).toBe(10);
    expect(below.uncoveredWhite).toBe(0);
  });

  it('handles a strided old alpha buffer (sOld > 1)', () => {
    const oldStrided = Buffer.alloc(N * 3);
    for (let i = 0; i < 30; i++) oldStrided[i * 3] = 255; // every 3rd byte is the alpha
    const newDil = mask(() => false);
    const candRaw = rgb(() => [255, 255, 255]);
    const r = measureWhiteHole({ oldA: oldStrided, sOld: 3, newDil, candRaw, n: N });
    expect(r.oldCnt).toBe(30);
    expect(r.uncoveredWhite).toBe(30);
  });

  it('empty old mask → frac 0, no division blowup', () => {
    const r = measureWhiteHole({ oldA: mask(() => false), sOld: 1, newDil: mask(() => false), candRaw: rgb(() => [255, 255, 255]), n: N });
    expect(r.oldCnt).toBe(0);
    expect(r.frac).toBe(0);
  });
});
