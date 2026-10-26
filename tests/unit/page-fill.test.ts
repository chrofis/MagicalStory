/**
 * Print page strip fill (server/lib/pageFill.js, decisions.md 2026-10-26): the strip under
 * the picture is the mirrored, blurred lower half of the picture; the text sits on a
 * translucent white board whose opacity rises until the text zone is bright enough.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');

const W = 425, H = 550, IH = 400;
const TEXT_BOX = { x: 30, y: 440, w: 365, h: 70 };

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

function meanLumBox(d: Buffer, w: number, b: { x: number; y: number; w: number; h: number }) {
  let s = 0, n = 0;
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { s += lum(d, (y * w + x) * 3); n++; }
  return s / n;
}

describe('buildFilledPageBackground', () => {
  it('returns a raster with exactly the page size', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX });
    const meta = await sharp(r.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it('fills the strip with picture colour, not white (outside the board)', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX });
    const { data } = await raw(r.buffer);
    // bottom-left corner of the strip, far from the board
    const l = lum(data, ((H - 4) * W + 4) * 3);
    expect(l).toBeLessThan(0.6);
    expect(l).toBeGreaterThan(0.2); // lightened towards white, not black
  });

  it('feathers the seam: no hard step between picture and strip', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX });
    const { data } = await raw(r.buffer);
    let maxStep = 0;
    for (let y = IH - 40; y < IH + 40; y++) {
      const a = lum(data, (y * W + 5) * 3), b = lum(data, ((y + 1) * W + 5) * 3);
      maxStep = Math.max(maxStep, Math.abs(a - b));
    }
    expect(maxStep).toBeLessThan(0.03);
  });

  it('keeps the text zone readable on a dark picture and raises the board opacity', async () => {
    // A tiny text block: the feathered board never reaches full strength inside it, so the
    // starting opacity is not enough on black and must be raised in 5% steps.
    const box = { x: 380, y: 470, w: 24, h: 8 };
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: box });
    expect(r.boardOpacity).toBeGreaterThan(0.7);
    expect(r.textZoneLuminance).toBeGreaterThanOrEqual(0.8);
    const { data } = await raw(r.buffer);
    expect(meanLumBox(data, W, box)).toBeGreaterThanOrEqual(0.78); // JPEG round trip tolerance
  });

  it('a normal text block on a dark picture reaches the target', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX });
    expect(r.textZoneLuminance).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps the text zone readable on a bright picture at the starting opacity', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX });
    expect(r.boardOpacity).toBe(0.7);
    expect(r.textZoneLuminance).toBeGreaterThanOrEqual(0.8);
  });

  it('draws no board for an empty text box', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: { x: 0, y: 0, w: 0, h: 0 } });
    expect(r.boardOpacity).toBe(0);
    expect(r.textZoneLuminance).toBeNull();
  });

  it('throws instead of falling back when the picture is unreadable or the strip is missing', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: Buffer.from('not an image'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, textBox: TEXT_BOX })).rejects.toThrow();
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: H, textBox: TEXT_BOX })).rejects.toThrow(/no strip/);
  });
});
