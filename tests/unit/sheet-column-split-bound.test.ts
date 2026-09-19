/**
 * The 2×4 sheet cell splitter must reject a detection it cannot trust.
 *
 * Regression origin: staging story job_1789759147125_p08djwhbl. The analyzer's
 * variance separator search put Kiaan's first column boundary at x=365 on a
 * 1024px sheet (true gutter ≈273, only 3px wide between two saturated
 * sweaters), so his columns came out [365, 164, 226, 269]. Column 0 — the cell
 * every cover reference uses, because covers hardcode pose 'front' — was 365px
 * of Kiaan PLUS a vertical slice of the boy in the next column: a second face,
 * torso and shoe went to the front cover, the initial page and the back cover.
 * The remaining 164px column was the rest of that boy.
 *
 * The bound is calibrated on 119 stored staging sheets (all 1024×1024): 115
 * good splits deviate 0-19.1% from the 256px nominal, the four broken ones sit
 * at 41.8 / 42.6 / 51.6 / 56.2%. The real column sets below are taken from that
 * measurement — no network, no analyzer, no images.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// sceneComposite reads the analyzer URL once, at module load. Point it at a
// closed loopback port BEFORE requiring it: the fallback test must exercise the
// fixed grid without reaching any service, including a dev analyzer that
// happens to be running on the default port.
process.env.PHOTO_ANALYZER_URL = 'http://127.0.0.1:1';

const require_ = createRequire(import.meta.url);
const { _internal } = require_('../../server/lib/sceneComposite');
const { judgeSheetColumnSplit, SHEET_COLUMN_WIDTH_TOLERANCE } = _internal;

// Measured column widths, deployed detector, 1024×1024 sheets.
const GOOD: Record<string, number[]> = {
  'Levin (the widest good split in the sample bar one)': [277, 244, 248, 255],
  Julian: [263, 255, 248, 258],
  Max: [257, 252, 268, 247],
  'a perfect grid': [256, 256, 256, 256],
  'the worst deviation any good split showed (19.1%)': [254, 305, 208, 257],
};
const BROKEN: Record<string, number[]> = {
  'Kiaan — the cell that shipped on three covers': [365, 164, 226, 269],
  'Hans, costumed': [363, 159, 259, 243],
  'Max, another story': [154, 388, 214, 268],
  'Noah': [400, 262, 192, 170],
};

describe('judgeSheetColumnSplit', () => {
  it('accepts every column set a good split produced', () => {
    for (const [label, widths] of Object.entries(GOOD)) {
      const v = judgeSheetColumnSplit(widths);
      expect(v.ok, `${label} ${JSON.stringify(widths)} — ${v.reason}`).toBe(true);
    }
  });

  it('rejects a set with one outlier column, naming the offender', () => {
    for (const [label, widths] of Object.entries(BROKEN)) {
      const v = judgeSheetColumnSplit(widths);
      expect(v.ok, `${label} ${JSON.stringify(widths)} should have been rejected`).toBe(false);
      expect(v.reason).toMatch(/column \d is \d+px against a \d+px nominal/);
    }
  });

  it('separates the two populations with room on both sides', () => {
    // The bound is not tuned to one sheet: it clears the worst good split and
    // the best broken one by a real margin in both directions.
    const worstGood = Math.max(...Object.values(GOOD).map(w => judgeSheetColumnSplit(w).maxDeviation));
    const bestBroken = Math.min(...Object.values(BROKEN).map(w => judgeSheetColumnSplit(w).maxDeviation));
    expect(worstGood).toBeLessThan(SHEET_COLUMN_WIDTH_TOLERANCE);
    expect(bestBroken).toBeGreaterThan(SHEET_COLUMN_WIDTH_TOLERANCE);
    expect(SHEET_COLUMN_WIDTH_TOLERANCE / worstGood).toBeGreaterThan(1.2);
    expect(bestBroken / SHEET_COLUMN_WIDTH_TOLERANCE).toBeGreaterThan(1.5);
  });

  it('measures each column against the nominal width, not against its neighbour', () => {
    // Two narrow columns and two wide ones: no single neighbour pair is far
    // apart, but half the sheet is in the wrong cell.
    expect(judgeSheetColumnSplit([350, 350, 162, 162]).ok).toBe(false);
  });

  it('is symmetric — a too-NARROW column is as fatal as a too-wide one', () => {
    expect(judgeSheetColumnSplit([160, 288, 288, 288]).ok).toBe(false);
    expect(judgeSheetColumnSplit([352, 224, 224, 224]).ok).toBe(false);
  });

  it('rejects a malformed width list instead of dividing by zero', () => {
    expect(judgeSheetColumnSplit([]).ok).toBe(false);
    expect(judgeSheetColumnSplit([256, 256, 256]).ok).toBe(false);
    expect(judgeSheetColumnSplit([256, 0, 256, 512]).ok).toBe(false);
    expect(judgeSheetColumnSplit([256, NaN, 256, 256]).ok).toBe(false);
    expect(judgeSheetColumnSplit(null).ok).toBe(false);
  });

  it('honours an explicit tolerance and column count', () => {
    expect(judgeSheetColumnSplit([365, 164, 226, 269], { tolerance: 0.6 }).ok).toBe(true);
    expect(judgeSheetColumnSplit([277, 244, 248, 255], { tolerance: 0.05 }).ok).toBe(false);
    expect(judgeSheetColumnSplit([300, 300], { cols: 2 }).ok).toBe(true);
    expect(judgeSheetColumnSplit([300, 300], { cols: 4 }).ok).toBe(false);
  });

  it('keeps the shipped tolerance at the calibrated value', () => {
    // Moving this number is a decision, not a tweak — docs/decisions.md
    // 2026-09-19 carries the calibration it came from.
    expect(SHEET_COLUMN_WIDTH_TOLERANCE).toBe(0.25);
  });
});

describe('the fixed-grid fallback', () => {
  it('cuts four equal columns', async () => {
    const sharp = require_('sharp');
    // A synthetic 2×4 sheet: noisy painted cells, no usable gutters at all, so
    // nothing here depends on a detector finding anything.
    const width = 1024;
    const height = 1024;
    const raw = Buffer.alloc(width * height);
    let seed = 987654321;
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[i] = 40 + (seed % 180);
    }
    const sheet = await sharp(raw, { raw: { width, height, channels: 1 } }).png().toBuffer();

    // cropSheetCell falls back to the fixed grid whenever the split is
    // unavailable — here the analyzer URL points at a closed local port, so the
    // fetch is refused without leaving the machine.
    const cells = await Promise.all(
      [1, 2, 3, 4].map((idx) => _internal.cropSheetCell(sheet, idx))
    );
    const widths = await Promise.all(cells.map(async (c: Buffer) => (await sharp(c).metadata()).width));
    expect(widths).toEqual([256, 256, 256, 256]);
    expect(judgeSheetColumnSplit(widths).ok).toBe(true);
  });
});
