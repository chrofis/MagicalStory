/**
/**
 * Print page strip fill (server/lib/pageFill.js, decisions.md 2026-10-26): the strip under
 * the picture is the mirrored, blurred, lightened lower half of the picture. No board:
 * the text outline is drawn by pdf.js.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');

const W = 425, H = 550, IH = 400;

// Picture: a vertical colour gradient plus noise-free blocks, solid dark or bright.
async function picture(kind: 'dark' | 'bright') {
  const base = kind === 'dark' ? { r: 0, g: 0, b: 0 } : { r: 235, g: 225, b: 200 };
  return sharp({ create: { width: 600, height: 560, channels: 3, background: base } })
    .composite([{ input: Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="#c03030"/></svg>'), left: 200, top: 340 }])
    .png().toBuffer();
}

async function raw(buf: Buffer) {
  const r = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return r;
}
const lum = (d: Buffer, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

describe('buildFilledPageBackground', () => {
  it('returns a raster with exactly the page size', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    const meta = await sharp(r.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it('fills the strip with picture colour, not white (not white)', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    const { data } = await raw(r.buffer);
    // bottom-left corner of the strip, corner of the strip
    const l = lum(data, ((H - 4) * W + 4) * 3);
    expect(l).toBeLessThan(0.6);
    expect(l).toBeGreaterThan(0.2); // lightened towards white, not black
  });

  it('feathers the seam: no hard step between picture and strip', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    const { data } = await raw(r.buffer);
    let maxStep = 0;
    for (let y = IH - 40; y < IH + 40; y++) {
      const a = lum(data, (y * W + 5) * 3), b = lum(data, ((y + 1) * W + 5) * 3);
      maxStep = Math.max(maxStep, Math.abs(a - b));
    }
    expect(maxStep).toBeLessThan(0.03);
  });

  it('draws nothing on the strip: no white board under where the text goes', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    const { data } = await raw(r.buffer);
    // centre of the strip on a black picture stays the lightened dark fill (35% towards white), far from white
    const l = lum(data, (475 * W + 400) * 3);
    expect(l).toBeLessThan(0.5);
    expect(l).toBeGreaterThan(0.2);
  });

  it('returns only the raster', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH });
    expect(Object.keys(r)).toEqual(['buffer']);
  });

  it('throws instead of falling back when the picture is unreadable or the strip is missing', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: Buffer.from('not an image'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH })).rejects.toThrow();
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: H })).rejects.toThrow(/no strip/);
  });
});
