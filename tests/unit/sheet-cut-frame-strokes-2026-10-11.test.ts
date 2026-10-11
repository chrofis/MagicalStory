/**
 * Regression (staging job_1791700480532_ul7f67gii): the model drew a thin grey frame (1-3 px, edge mean ~188 against paper ~252)
 * round the whole standard sheet; the cut cells at the sheet edge kept it, and a divider two px inside a window survived too.
 * Fails before sheetCut.trimStrokes.
 */
import { describe, it, expect } from 'vitest';
const sharp = require('sharp');
const { cutSheet, trimStrokes } = require('../../server/lib/sheetCut');

const figure = (x: number, y: number, w: number, h: number) => ({ input: { create: { width: w, height: h, channels: 3, background: { r: 30, g: 80, b: 160 } } }, left: x, top: y });
const grey = (x: number, y: number, w: number, h: number) => ({ input: { create: { width: w, height: h, channels: 3, background: { r: 190, g: 190, b: 190 } } }, left: x, top: y });
const figs = () => { const f: any[] = []; for (let c = 0; c < 4; c++) { f.push(figure(c * 100 + 30, 120, 40, 60)); f.push(figure(c * 100 + 30, 220, 40, 150)); } return f; };
const sheet = (extra: any[]) => sharp({ create: { width: 400, height: 400, channels: 3, background: '#fcfcf4' } }).composite([...figs(), ...extra]).png().toBuffer();

async function greyEdgeLines(cell: Buffer) {
  const { data, info } = await sharp(cell).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const isGrey = (v: number) => v > 150 && v < 225;
  let n = 0;
  for (let k = 0; k < 6; k++) {
    let l = 0, r = 0, t = 0, b = 0;
    for (let y = 0; y < H; y++) { if (isGrey(data[y * W + k])) l++; if (isGrey(data[y * W + W - 1 - k])) r++; }
    for (let x = 0; x < W; x++) { if (isGrey(data[k * W + x])) t++; if (isGrey(data[(H - 1 - k) * W + x])) b++; }
    if (l > H * 0.8 || r > H * 0.8 || t > W * 0.8 || b > W * 0.8) n++;
  }
  return n;
}

describe('cutSheet leaves no frame or divider stroke on a cell', () => {
  it('a 2 px frame round the sheet, and a 2 px divider inset from a quarter line, are not in any cell', async () => {
    const frame = [grey(0, 0, 400, 2), grey(0, 398, 400, 2), grey(0, 0, 2, 400), grey(398, 0, 2, 400), grey(103, 0, 2, 400)];
    const cells = await cutSheet(await sheet(frame));
    expect(cells).toHaveLength(8);
    for (const c of cells) expect(await greyEdgeLines(c)).toBe(0);
  });
  it('trimStrokes keeps a clipped figure: an edge line that is mostly paper is not a stroke', () => {
    const W = 40, H = 40, rgb = Buffer.alloc(W * H * 3, 252);
    for (let y = 0; y < H; y++) for (let x = 0; x < 4; x++) { const i = 3 * (y * W + x); rgb[i] = 30; rgb[i + 1] = 80; rgb[i + 2] = 160; }
    for (let y = 0; y < 8; y++) { const i = 3 * (y * W + 30); rgb[i] = 30; } // a speck on another side
    const r = trimStrokes(rgb, W, [252, 252, 252], { left: 0, top: 0, right: W, bottom: H });
    expect(r.left).toBe(4);               // a full-length painted line IS peeled
    expect(r.width).toBe(36);
    const r2 = trimStrokes(rgb, W, [252, 252, 252], { left: 5, top: 0, right: W, bottom: H });
    expect(r2.left).toBe(5);              // paper edge untouched
  });
});
