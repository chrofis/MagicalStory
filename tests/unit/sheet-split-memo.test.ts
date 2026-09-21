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
async function cellPng() {
  return sharp({ create: { width: CELL_W, height: CELL_H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
}
async function sheetPng() {
  return sharp({ create: { width: CELL_W * 4, height: CELL_H * 2, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
}

describe('2×4 sheet split is memoised per sheet, not per Buffer object', () => {
  let splitCalls = 0;
  let sheetGets: string[] = [];
  let sheetBytes: Buffer;

  beforeEach(async () => {
    resetSheetCaches();
    splitCalls = 0;
    sheetGets = [];
    sheetBytes = await sheetPng();
    const cellB64 = (await cellPng()).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/split-reference-sheet')) {
        splitCalls++;
        return { ok: true, status: 200, json: async () => ({ success: true, cells: Array(8).fill(cellB64) }) } as any;
      }
      sheetGets.push(u);
      // A fresh Buffer every time — exactly what the old identity key tripped on.
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from(sheetBytes).buffer } as any;
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); resetSheetCaches(); });

  it('4 sheets × 18 pages: the analyzer is called 4 times and each sheet is fetched once', async () => {
    const { cropAvatarCell } = require('../../server/lib/sceneComposite');
    const urls = [1, 2, 3, 4].map(i => `https://images.magicalstory.ch/story-sheets/char${i}.png`);
    for (let page = 0; page < 18; page++) {
      for (const url of urls) {
        await cropAvatarCell(url, { pose: 'threeQuarter', includeFace: true });
      }
    }
    expect(splitCalls).toBe(4);
    expect(sheetSplitCalls()).toBe(4);
    expect(new Set(sheetGets).size).toBe(4);
    expect(sheetGets.length).toBe(4);
  });

  it('two distinct Buffers with identical bytes share one split', async () => {
    await cropSheetCell(Buffer.from(sheetBytes), POSE_CELL.front);
    await cropSheetCell(Buffer.from(sheetBytes), POSE_CELL.profile);
    expect(splitCalls).toBe(1);
  });

  it('a different sheet is a different key', async () => {
    const other = await sharp({ create: { width: CELL_W * 4, height: CELL_H * 2, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    expect(sheetKeyOf(sheetBytes)).not.toBe(sheetKeyOf(other));
    await cropSheetCell(sheetBytes, 1);
    await cropSheetCell(other, 1);
    expect(splitCalls).toBe(2);
  });
});
