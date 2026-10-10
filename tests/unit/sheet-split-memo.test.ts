import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const sharp = require('sharp');

const { _internal, POSE_CELL } = require('../../server/lib/sceneComposite');
const { cropSheetCell, sheetKeyOf, sheetSplitCalls, resetSheetCaches } = _internal;

/**
 * B4: the split memo was a WeakMap keyed on the Buffer object, while every
 * caller re-fetched its own Buffer from the sheet's R2 URL — so the key never
 * matched and a 4-character 18-page story split the same 4 sheets ~50 times
 * (~50 analyzer round-trips + ~50 × 392 KB of R2 traffic). The memo is now
 * keyed on the sheet's CONTENT/URL, and the URL→bytes fetch is memoised too.
 *
 * Pins behaviour with counters, not wording: N sheets → N splits and N GETs,
 * however many pages ask for cells.
 */
const CELL_W = 64, CELL_H = 96;
// A sheet with a figure in each of its 8 cells (the figure cutter reads paint; a blank sheet has nothing to cut).
async function sheetPng(shade = 40) {
  const figures = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) figures.push({ input: { create: { width: 24, height: 60, channels: 3, background: { r: shade, g: 90, b: 160 } } }, left: c * CELL_W + 20, top: r * CELL_H + 14 });
  return sharp({ create: { width: CELL_W * 4, height: CELL_H * 2, channels: 3, background: { r: 250, g: 250, b: 250 } } }).composite(figures).png().toBuffer();
}

describe('2×4 sheet split is memoised per sheet, not per Buffer object', () => {
  let sheetGets: string[] = [];
  let sheetBytes: Buffer;

  beforeEach(async () => {
    resetSheetCaches();
    sheetGets = [];
    sheetBytes = await sheetPng();
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      sheetGets.push(u);
      // A fresh Buffer every time — exactly what the old identity key tripped on.
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => { const b = Buffer.from(sheetBytes); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } as any;
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); resetSheetCaches(); });

  it('4 sheets × 18 pages: the figure cutter runs 4 times and each sheet is fetched once', async () => {
    const { cropAvatarCell } = require('../../server/lib/sceneComposite');
    const urls = [1, 2, 3, 4].map(i => `https://images.magicalstory.ch/story-sheets/char${i}.png`);
    for (let page = 0; page < 18; page++) {
      for (const url of urls) {
        await cropAvatarCell(url, { pose: 'threeQuarter', includeFace: true });
      }
    }
    expect(sheetSplitCalls()).toBe(4);
    expect(new Set(sheetGets).size).toBe(4);
    expect(sheetGets.length).toBe(4);
  });

  it('two distinct Buffers with identical bytes share one split', async () => {
    await cropSheetCell(Buffer.from(sheetBytes), POSE_CELL.front);
    await cropSheetCell(Buffer.from(sheetBytes), POSE_CELL.profile);
    expect(sheetSplitCalls()).toBe(1);
  });

  it('a different sheet is a different key', async () => {
    const other = await sheetPng(200);
    expect(sheetKeyOf(sheetBytes)).not.toBe(sheetKeyOf(other));
    await cropSheetCell(sheetBytes, 1);
    await cropSheetCell(other, 1);
    expect(sheetSplitCalls()).toBe(2);
  });
});
