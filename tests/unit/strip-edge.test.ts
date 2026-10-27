/**
 * Text strip on the calmer edge of the picture (decisions.md 2026-10-27, plan
 * tasks/strip-edge-by-picture-2026-10-27.md): chooseStripEdge picks top or bottom from the
 * picture's own pixels, the fill and the text zone follow, and the old position cycle is gone.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { chooseStripEdge, pickFullWidthPosition, blockCalmness } = cjs('../../server/lib/textRegion.js');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');

const S = 640;
// Deterministic busy texture: pseudo-random grey rows (LCG), no Math.random.
function busyRows(width: number, rows: number, seed: number) {
  const buf = Buffer.alloc(width * rows * 3);
  let x = seed;
  for (let i = 0; i < width * rows; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    const v = x >>> 24;
    buf[i * 3] = v; buf[i * 3 + 1] = v; buf[i * 3 + 2] = v;
  }
  return buf;
}
/** Flat grey picture with a busy band (25% of the height) at 'top' | 'bottom' | 'both' | 'none'. */
async function pic(busy: 'top' | 'bottom' | 'both' | 'none') {
  const bh = S / 4;
  const layers: any[] = [];
  const band = (top: number) => ({ input: busyRows(S, bh, 7 + top), raw: { width: S, height: bh, channels: 3 }, left: 0, top });
  if (busy === 'top' || busy === 'both') layers.push(band(0));
  if (busy === 'bottom' || busy === 'both') layers.push(band(S - bh));
  return sharp({ create: { width: S, height: S, channels: 3, background: { r: 120, g: 130, b: 140 } } })
    .composite(layers).png().toBuffer();
}

describe('chooseStripEdge', () => {
  it('busy bottom -> the strip goes on the calm top, whatever the page parity', async () => {
    for (const pageNumber of [1, 2, 3, 4]) {
      const r = await chooseStripEdge(await pic('bottom'), { pageNumber, bandFraction: 0.25 });
      expect(r.edge).toBe('top');
      expect(r.top).toBeGreaterThan(r.bottom);
    }
  });
  it('busy top -> bottom, whatever the page parity (regression: the parity lock forced 1,3 top and 2,4 bottom)', async () => {
    for (const pageNumber of [1, 2, 3, 4]) {
      expect((await chooseStripEdge(await pic('top'), { pageNumber, bandFraction: 0.25 })).edge).toBe('bottom');
    }
  });
  it('tie (flat picture, or both edges equally busy): odd page -> bottom, even page -> top', async () => {
    for (const kind of ['none', 'both'] as const) {
      const buf = await pic(kind);
      expect((await chooseStripEdge(buf, { pageNumber: 1 })).edge).toBe('bottom');
      expect((await chooseStripEdge(buf, { pageNumber: 2 })).edge).toBe('top');
      expect((await chooseStripEdge(buf, { pageNumber: 3 })).edge).toBe('bottom');
    }
  });
  it('is deterministic and pure', async () => {
    const buf = await pic('bottom');
    expect(await chooseStripEdge(buf, { pageNumber: 5 })).toEqual(await chooseStripEdge(buf, { pageNumber: 5 }));
  });
  it('bandFraction is clamped: a huge band still compares only the outer half', async () => {
    const buf = await pic('bottom');
    expect((await chooseStripEdge(buf, { pageNumber: 1, bandFraction: 5 })).edge).toBe('top');
  });
  it('throws on a missing buffer, a bad page number and a tiny picture (no fallback)', async () => {
    await expect(chooseStripEdge(Buffer.alloc(0), { pageNumber: 1 })).rejects.toThrow(/imageBuffer/);
    await expect(chooseStripEdge(await pic('none'), { pageNumber: 0 })).rejects.toThrow(/pageNumber/);
    const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#888' } }).png().toBuffer();
    await expect(chooseStripEdge(tiny, { pageNumber: 1 })).rejects.toThrow(/too small/);
  });
  it('pickFullWidthPosition returns top-full / bottom-full', async () => {
    expect(await pickFullWidthPosition(await pic('bottom'), 1)).toBe('top-full');
    expect(await pickFullWidthPosition(await pic('top'), 1)).toBe('bottom-full');
  });
  it('blockCalmness is the single formula: flat blocks are calmer than noisy ones', () => {
    const w = 64, h = 32; // 4x2 blocks: left half flat, right half noisy
    const g = Buffer.alloc(w * h);
    let x = 3;
    for (let y = 0; y < h; y++) for (let c = 0; c < w; c++) { x = (x * 1664525 + 1013904223) >>> 0; g[y * w + c] = c < 32 ? 100 : x >>> 24; }
    const cal = blockCalmness(g, w, 2, 4);
    expect(cal[0]).toBeGreaterThan(cal[3]);
  });
});

describe('buildFilledPageBackground edge', () => {
  const W = 425, H = 550, IH = 400;
  // picture: red top half, blue bottom half
  async function split() {
    return sharp({ create: { width: 600, height: 560, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .composite([{ input: { create: { width: 600, height: 280, channels: 3, background: { r: 255, g: 0, b: 0 } } }, left: 0, top: 0 }])
      .png().toBuffer();
  }
  const px = async (buf: Buffer, x: number, y: number) => {
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]];
  };
  it('edge top: picture pinned to the bottom (upright), strip above mirrors the picture TOP half', async () => {
    const { buffer } = await buildFilledPageBackground({ imageBuffer: await split(), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror', edge: 'top' });
    const STRIP = H - IH;
    const redPx = await px(buffer, 200, STRIP + 20);
    const bluePx = await px(buffer, 200, H - 20);
    expect(redPx[0]).toBeGreaterThan(200); expect(redPx[2]).toBeLessThan(60);
    expect(bluePx[2]).toBeGreaterThan(200); expect(bluePx[0]).toBeLessThan(60);
    const stripPx = await px(buffer, 200, 40);
    expect(stripPx[0]).toBeGreaterThan(stripPx[2] + 80);
  });
  it('edge bottom (default) is unchanged: picture on top, strip mirrors the bottom (blue) half', async () => {
    const { buffer } = await buildFilledPageBackground({ imageBuffer: await split(), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    const stripPx = await px(buffer, 200, H - 40);
    expect(stripPx[2]).toBeGreaterThan(stripPx[0] + 80);
    expect((await px(buffer, 200, 20))[0]).toBeGreaterThan(200);
  });
  it('rejects an unknown edge', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: await split(), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror', edge: 'left' })).rejects.toThrow(/edge/);
  });
});

describe('the six-step position cycle is gone', () => {
  const root = path.resolve(__dirname, '../..');
  it('no OVERLAY_POSITIONS / POSITION_CYCLE in pdf.js or the client', () => {
    expect(fs.readFileSync(path.join(root, 'server/lib/pdf.js'), 'utf8')).not.toContain('OVERLAY_POSITIONS');
    expect(fs.readFileSync(path.join(root, 'client/src/utils/textOverlay.ts'), 'utf8')).not.toContain('POSITION_CYCLE');
  });
  it('the text-overlay routes pick the edge from the picture when no position is stored', () => {
    for (const f of ['server/routes/stories.js', 'server/routes/sharing.js']) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src).toContain('pickFullWidthPosition');
      expect(src).not.toContain("textPosition || 'bottom-left'");
    }
  });
});
