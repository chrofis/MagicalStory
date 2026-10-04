import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const sharp = require('sharp');
const { _internal, POSE_CELL } = require('../../server/lib/sceneComposite');
const { cropSheetCell, sheetSplitCalls, resetSheetCaches } = _internal;

// Code review 2026-10 C5: a transient analyzer failure must not pin the sheet
// to the fixed-grid crop for the life of the process.
describe('transient /split-reference-sheet failure is not cached', () => {
  let analyzerUp = false;
  let sheet: Buffer;
  beforeEach(async () => {
    resetSheetCaches();
    analyzerUp = false;
    sheet = await sharp({ create: { width: 256, height: 192, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    const cell = (await sharp({ create: { width: 64, height: 96, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer()).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async () => (analyzerUp
      ? { ok: true, status: 200, json: async () => ({ success: true, cells: Array(8).fill(cell) }) }
      : { ok: false, status: 503, json: async () => ({}) }) as any));
  });
  afterEach(() => { vi.unstubAllGlobals(); resetSheetCaches(); });

  it('asks the analyzer again after it recovers', async () => {
    await cropSheetCell(Buffer.from(sheet), POSE_CELL.front); // analyzer down -> fixed grid
    expect(sheetSplitCalls()).toBe(1);
    analyzerUp = true;
    await cropSheetCell(Buffer.from(sheet), POSE_CELL.front);
    expect(sheetSplitCalls()).toBe(2);
  });
});
