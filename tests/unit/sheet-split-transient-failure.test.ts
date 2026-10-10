import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const sharp = require('sharp');
const { _internal, POSE_CELL } = require('../../server/lib/sceneComposite');
const { cropSheetCell, sheetSplitCalls, resetSheetCaches } = _internal;

// A sheet that cannot be cut (no figures) throws, and the failure is not cached: the same sheet is cut again on the next ask
// (code review 2026-10 C5, kept through the move from the analyzer split to the figure cutter, docs/decisions.md 2026-10-10).
describe('a failed sheet cut is not cached', () => {
  beforeEach(() => resetSheetCaches());
  afterEach(() => resetSheetCaches());

  it('throws on a sheet without figures (no fixed-grid fallback) and cuts again on the next call', async () => {
    const blank = await sharp({ create: { width: 256, height: 192, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer();
    await expect(cropSheetCell(Buffer.from(blank), POSE_CELL.front)).rejects.toThrow(/no figure/);
    expect(sheetSplitCalls()).toBe(1);
    await expect(cropSheetCell(Buffer.from(blank), POSE_CELL.front)).rejects.toThrow(/no figure/);
    expect(sheetSplitCalls()).toBe(2);
  });
});
