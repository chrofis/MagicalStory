import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS module without types
import { anchorVerdict } from '../../server/lib/samBlend.js';

// The IoU floor (0.55) refuses repairs whose job is to change the silhouette
// (identity_swap hair, age_shift, body_build). anchorVerdict judges them on
// where the figure stands.
const W = 200, H = 300;
function rect(x0: number, y0: number, x1: number, y1: number) {
  const m = Buffer.alloc(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 255;
  return m;
}
const old = rect(60, 40, 140, 280);

describe('anchorVerdict', () => {
  it('passes a taller-hair repaint that keeps centroid and feet (low IoU, same anchor)', () => {
    // wider + taller head, narrower body: IoU well below 0.55, anchor intact
    const nw = rect(50, 10, 150, 280);
    expect(anchorVerdict({ oldBin: old, newBin: nw, w: W, h: H }).ok).toBe(true);
  });
  it('refuses a figure that moved sideways', () => {
    const nw = rect(110, 40, 190, 280);
    const v = anchorVerdict({ oldBin: old, newBin: nw, w: W, h: H });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/centroid/);
  });
  it('refuses a figure whose feet moved', () => {
    const nw = rect(60, 40, 140, 190);
    const v = anchorVerdict({ oldBin: old, newBin: nw, w: W, h: H });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/feet/);
  });
  it('refuses a figure grown into a protected neighbour', () => {
    const nw = rect(60, 40, 190, 280);
    const v = anchorVerdict({ oldBin: old, newBin: nw, w: W, h: H, protectedBoxes: [[140, 40, 200, 280]] });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/neighbour/);
  });
  it('refuses an empty mask', () => {
    expect(anchorVerdict({ oldBin: old, newBin: Buffer.alloc(W * H), w: W, h: H }).ok).toBe(false);
  });
});
