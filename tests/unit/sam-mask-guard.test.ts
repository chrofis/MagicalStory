/**
 * SAM mask acceptance rule (_cleanMaskAndCheck in server/lib/images.js).
 *
 * The mask decides each figure's bodyBox, and a bad accept silently replaces a
 * correct GroundingDINO box with garbage. Geometry here is taken verbatim from
 * staging story job_1785767208189_x6lyay5fr (1024x1024 pages), which ran while
 * the analyzer was serving SAM masks that did not belong to the prompted box
 * (fixed in ff1ed9aa), plus the healthy re-run of the same pages (Test Lab
 * experiment #314).
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _cleanMaskAndCheck } = require('../../server/lib/images.js');

const W = 1024;
const H = 1024;

/** Build a mask whose set pixels are the union of the given [x0,y0,x1,y1] rects. */
function maskOf(rects: number[][]) {
  const alpha = new Uint8Array(W * H);
  let area = 0;
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!alpha[y * W + x]) { alpha[y * W + x] = 1; area++; }
      }
    }
    if (x0 < minx) minx = x0;
    if (y0 < miny) miny = y0;
    if (x1 > maxx) maxx = x1;
    if (y1 > maxy) maxy = y1;
  }
  return { alpha, width: W, height: H, area, bbox: [minx, miny, maxx, maxy] };
}

describe('_cleanMaskAndCheck', () => {
  it('accepts a real silhouette and returns its bounds', async () => {
    // p10 Lukas (exp #314): DINO box x 57-481, y 166-982; the mask fills it.
    const box = [57, 166, 481, 982];
    const mask = maskOf([[70, 175, 470, 975]]);
    const { keptBox, coverage } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).not.toBeNull();
    expect(coverage).toBeGreaterThan(0.9);
  });

  it('accepts an occluded figure split into pieces inside the box', async () => {
    // Occlusion is not an error: several components, all inside, together
    // covering enough of the box.
    const box = [200, 100, 600, 900];
    const mask = maskOf([[220, 120, 580, 400], [230, 500, 570, 880]]);
    const { keptBox, coverage } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).not.toBeNull();
    expect(coverage).toBeGreaterThan(0.8);
  });

  it('rejects the p4 pumpkin — a prop beside the figure, outside the box in x', async () => {
    // p4 Lukas: DINO box x 211-464, y 228-961 (253 x 733 px). The pumpkin at
    // x 474-544 sits entirely outside in x, yet became Lukas's bodyBox: the
    // tolerance derived from max(w,h) gave 88 px of horizontal slack instead
    // of 30, so the pumpkin read as "inside".
    const box = [211, 228, 464, 961];
    const mask = maskOf([[474, 336, 544, 391]]);
    const { keptBox } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).toBeNull();
  });

  it('rejects a beside-the-figure prop big enough to clear the coverage floor', async () => {
    // Isolates the per-axis tolerance from the coverage floor: same tall narrow
    // box, but a component covering 57% of it — the floor would let this
    // through. It sits outside the box in x (x0 = 470 > x1 = 464); with the old
    // max(w,h) tolerance 55% of it fell in the tolerated band (>= 0.5 → kept),
    // with per-axis tolerance only 16% does.
    const box = [211, 228, 464, 961];
    const mask = maskOf([[470, 200, 620, 900]]);
    const { keptBox, coverage } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).toBeNull();
    expect(coverage).toBe(0);   // dropped by the inside test, not by the floor
  });

  it('rejects a fragment that is inside the box but far too small to be the figure', async () => {
    // p2 Roger: DINO box x 343-833, y 96-1020. SAM returned a sliver of the
    // vest fringe — inside the box, ~1.7% of it — and it was accepted as
    // `mask-ok`, collapsing his bodyBox onto the sliver.
    const box = [343, 96, 833, 1020];
    const mask = maskOf([[500, 400, 530, 650]]);
    const { keptBox, coverage } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).toBeNull();
    expect(coverage).toBeGreaterThan(0);       // distinguishes it from all-outside
    expect(coverage).toBeLessThan(0.25);
  });

  it('reports zero coverage when every component is outside the box', async () => {
    const box = [200, 200, 400, 400];
    const mask = maskOf([[700, 700, 900, 900]]);
    const { keptBox, coverage } = await _cleanMaskAndCheck(mask, box);
    expect(keptBox).toBeNull();
    expect(coverage).toBe(0);
  });
});
