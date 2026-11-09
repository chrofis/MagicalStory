/**
 * A long dedication starts below the lowest face and shrinks to fit (owner, 2026-11-09: a
 * ten-line dedication started at the child's chin and covered both figures, prod
 * job_1794231161354_l3n2o3afm). Before: the band was fixed at 0.50-0.96 whatever the figures.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';
const nodeRequire = createRequire(import.meta.url);
const { dedicationBand, composeDedication } = nodeRequire('../../server/lib/coverTypography.js');

const TEN_ROWS = 11;
const figures = [
  { faceBox: [0.38, 0.30, 0.47, 0.45], bodyBox: [0.30, 0.18, 0.96, 0.52] }, // child: face ends at 0.47
  { faceBox: [0.08, 0.55, 0.26, 0.72], bodyBox: [0.06, 0.48, 0.97, 0.82] },
];

describe('dedicationBand', () => {
  it('starts below the lowest face', () => {
    const b = dedicationBand(TEN_ROWS, figures);
    expect(b.y0).toBeGreaterThanOrEqual(0.47 + 0.03 - 1e-9);
    expect(b.y1).toBe(0.96);
  });
  it('without faces keeps the old band', () => {
    expect(dedicationBand(TEN_ROWS, []).y0).toBe(0.5);
    expect(dedicationBand(4, []).y0).toBeCloseTo(0.62, 5);
  });
  it('faces near the bottom leave the minimum band (and overlap)', () => {
    const b = dedicationBand(TEN_ROWS, [{ faceBox: [0.7, 0.4, 0.85, 0.6] }]);
    expect(b.y1 - b.y0).toBeCloseTo(0.22, 5);
  });
});

describe('composeDedication', () => {
  it('prints no ink above the band on a plain page', async () => {
    const W = 600, H = 800;
    const art = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 90, g: 110, b: 140 } } }).jpeg().toBuffer();
    const text = Array.from({ length: 10 }, (_, i) => `Line number ${i + 1} of a long dedication text`).join('\n');
    const { buffer, spec } = await composeDedication(art, text, figures, 'seed', null);
    expect(spec.place.y0).toBeGreaterThanOrEqual(0.5);
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const top = Math.floor(spec.place.y0 * H) - 4;
    let changed = 0;
    for (let y = 0; y < top; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * info.channels;
      if (Math.abs(data[i] - 90) + Math.abs(data[i + 1] - 110) + Math.abs(data[i + 2] - 140) > 60) changed++;
    }
    expect(changed).toBe(0);
  });
});
