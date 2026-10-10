/**
 * The figure-based sheet cutter (server/lib/sheetCut.js, docs/decisions.md 2026-10-10 "One figure-based sheet cutter").
 * Regression: the stored costumed sheet of staging trial 6912628b (a tall blank band above the heads) was cut at y=174 of 1024 by
 * the variance separator: the head cell was blank paper and the body cell held the rest of the column. 9 of 44 sheets of the
 * last 15 trials had the same fault.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const sharp = require('sharp');
const { cutSheet } = require('../../server/lib/sheetCut');

const fixture = fs.readFileSync(path.resolve(__dirname, 'fixtures/costumed-sheet-blank-headroom-2026-10-10.jpg'));

describe('cutSheet on the stored costumed sheet with a blank band above the heads', () => {
  it('gives 8 cells; every head cell is a head with its shoulders, every body cell is one whole body', async () => {
    const cells = await cutSheet(fixture);
    expect(cells).toHaveLength(8);
    const meta = await Promise.all(cells.map((c: Buffer) => sharp(c).metadata()));
    for (const m of meta) expect(m.width).toBeLessThan(512 * 0.35);                  // one column, never a row
    for (const m of meta.slice(0, 4)) { expect(m.height).toBeGreaterThan(60); expect(m.height).toBeLessThan(512 * 0.5); } // head cells, not the blank band
    for (const m of meta.slice(4)) expect(m.height).toBeGreaterThan(512 * 0.4);       // body cells: head to toe
    // a head cell is mostly figure, not paper: its middle is painted
    const { data, info } = await sharp(cells[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
    expect(Math.min(data[mid], data[mid + 1], data[mid + 2])).toBeLessThan(215);
  });
});

describe('cutSheet on synthetic sheets', () => {
  const figure = (x: number, y: number, w: number, h: number) => ({ input: { create: { width: w, height: h, channels: 3, background: { r: 30, g: 80, b: 160 } } }, left: x, top: y });
  const sheet = (figs: any[], lines: any[] = []) => sharp({ create: { width: 400, height: 400, channels: 3, background: '#faf8f0' } }).composite([...figs, ...lines]).png().toBuffer();
  const eight = () => { const f: any[] = []; for (let c = 0; c < 4; c++) { f.push(figure(c * 100 + 30, 120, 40, 60)); f.push(figure(c * 100 + 30, 220, 40, 150)); } return f; };

  it('cuts one figure per cell; the margin stays inside its own window and off the gutter lines', async () => {
    const hairlines = [100, 200, 300].map(x => figure(x, 0, 2, 400)).concat([figure(0, 200, 400, 2)]);
    const cells = await cutSheet(await sheet(eight(), hairlines));
    expect(cells).toHaveLength(8);
    const [h0, b0] = await Promise.all([sharp(cells[0]).metadata(), sharp(cells[4]).metadata()]);
    expect(h0.width).toBeGreaterThanOrEqual(40);
    expect(h0.width).toBeLessThanOrEqual(80);
    expect(b0.height).toBeGreaterThanOrEqual(150);
    expect(b0.height).toBeLessThanOrEqual(190);
    const { data, info } = await sharp(cells[4]).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    let edgePainted = 0;
    for (let y = 0; y < info.height; y++) if (data[y * info.width + info.width - 1] < 150) edgePainted++;
    expect(edgePainted).toBeLessThan(info.height * 0.5);   // no hairline gutter at the cell edge
  });
  it('a figure that drifts off its quarter column is still cut whole', async () => {
    const f = eight().map((x, i) => (i === 2 ? figure(100 + 52, 120, 40, 60) : x)); // column 2 head figure sits off-centre
    const cells = await cutSheet(await sheet(f));
    const m = await sharp(cells[1]).metadata();
    expect(m.width).toBeGreaterThanOrEqual(40);
  });
  it('a row with no figure throws instead of returning an empty cell', async () => {
    const f = eight().filter((_, i) => i !== 0);   // head row, column 1: nothing drawn
    await expect(cutSheet(await sheet(f))).rejects.toThrow(/head row, figure 1 holds no figure/);
  });
});
