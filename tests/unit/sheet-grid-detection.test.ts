/**
 * Sheet grid detection — the count-free gutter-line detector and the
 * label→element mapping parser.
 *
 * Regression origin: staging story job_1788641639919_mpjwlzkf1. A 3-element
 * VB character batch was prompted as a 1x3 column; the image model drew a 2x2
 * sheet with four figures. Both splitters trusted the requested count and cut
 * the sheet into three horizontal bands, so every per-element reference was a
 * misaligned crop (two figures side by side, a band straddling the mid-row
 * divider, a strip of legs). The detector must report what is ACTUALLY drawn.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

const {
  detectSheetGrid,
  parseCellIdentification,
  cellLabel,
  labelToIndex,
} = require('../../server/lib/sheetGrid');

/**
 * Build a synthetic sheet: `cols` x `rows` cells of noisy content separated by
 * gutter lines of the given thickness and tone. Content must be NOISY — a flat
 * cell is indistinguishable from a gutter, and real sheets are painted.
 */
async function makeSheet(opts: {
  cols: number;
  rows: number;
  width?: number;
  height?: number;
  gutter?: number;          // thickness in px
  gutterTone?: number;      // 0 = black, 255 = white
  colBounds?: number[];     // explicit gutter centres, for uneven layouts
  rowBounds?: number[];
}): Promise<Buffer> {
  const width = opts.width ?? 600;
  const height = opts.height ?? 600;
  const gutter = opts.gutter ?? 4;
  const tone = opts.gutterTone ?? 0;

  const data = Buffer.alloc(width * height);
  // Noisy painted content, deterministic.
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = 90 + (seed % 120);
  }

  const centres = (n: number, size: number, explicit?: number[]) =>
    explicit ?? Array.from({ length: n - 1 }, (_, i) => Math.round((size * (i + 1)) / n));

  for (const y of centres(opts.rows, height, opts.rowBounds)) {
    for (let dy = -Math.floor(gutter / 2); dy <= Math.floor(gutter / 2); dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let x = 0; x < width; x++) data[yy * width + x] = tone;
    }
  }
  for (const x of centres(opts.cols, width, opts.colBounds)) {
    for (let dx = -Math.floor(gutter / 2); dx <= Math.floor(gutter / 2); dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width) continue;
      for (let y = 0; y < height; y++) data[y * width + xx] = tone;
    }
  }

  return sharp(data, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

describe('detectSheetGrid — cell count from pixels', () => {
  it('reads a 1x3 column as three cells', async () => {
    const grid = await detectSheetGrid(await makeSheet({ cols: 1, rows: 3 }));
    expect(grid.count).toBe(3);
    expect(grid.cols).toBe(1);
    expect(grid.rows).toBe(3);
  });

  it('reads a 2x2 sheet as FOUR cells even though three were requested', async () => {
    // The exact production failure: requested 3, model drew 2x2.
    const grid = await detectSheetGrid(await makeSheet({ cols: 2, rows: 2 }));
    expect(grid.count).toBe(4);
    expect(grid.cols).toBe(2);
    expect(grid.rows).toBe(2);
  });

  it('finds WHITE gutters, not just black ones', async () => {
    const grid = await detectSheetGrid(await makeSheet({ cols: 2, rows: 2, gutterTone: 255, gutter: 6 }));
    expect(grid.count).toBe(4);
  });

  it('handles uneven gutters — cells of different sizes', async () => {
    // Rows split at 30% and 75% instead of thirds.
    const grid = await detectSheetGrid(await makeSheet({
      cols: 1, rows: 3, height: 800, rowBounds: [240, 600],
    }));
    expect(grid.count).toBe(3);
    const heights = grid.cells.map((c: any) => c.height);
    // First cell ~240, second ~360, third ~200 — genuinely unequal.
    expect(heights[0]).toBeLessThan(heights[1]);
    expect(heights[2]).toBeLessThan(heights[1]);
    // A blind height/3 split would have put every boundary at ~267/533.
    expect(grid.separators.horizontal[0]).toBeGreaterThan(230);
    expect(grid.separators.horizontal[0]).toBeLessThan(250);
  });

  it('reports one cell for an ungridded single render', async () => {
    const grid = await detectSheetGrid(await makeSheet({ cols: 1, rows: 1 }));
    expect(grid.count).toBe(1);
  });

  it('cell rectangles stay inside the sheet and never span a gutter', async () => {
    const buf = await makeSheet({ cols: 2, rows: 2, width: 640, height: 640 });
    const grid = await detectSheetGrid(buf);
    for (const cell of grid.cells) {
      expect(cell.left).toBeGreaterThanOrEqual(0);
      expect(cell.top).toBeGreaterThanOrEqual(0);
      expect(cell.left + cell.width).toBeLessThanOrEqual(grid.width);
      expect(cell.top + cell.height).toBeLessThanOrEqual(grid.height);
    }
    const sepY = grid.separators.horizontal[0];
    for (const cell of grid.cells) {
      const spansDivider = cell.top < sepY && cell.top + cell.height > sepY;
      expect(spansDivider).toBe(false);
    }
  });
});

describe('cellLabel / labelToIndex', () => {
  it('round-trips letters', () => {
    for (const i of [0, 1, 25, 26, 27, 51, 52]) {
      expect(labelToIndex(cellLabel(i))).toBe(i);
    }
    expect(cellLabel(0)).toBe('A');
    expect(cellLabel(3)).toBe('D');
    expect(cellLabel(26)).toBe('AA');
  });

  it('rejects non-letters', () => {
    expect(labelToIndex(null)).toBe(-1);
    // Letters-only no-match words must not decode as base-26 cell indices.
    expect(labelToIndex('none')).toBe(-1);
    expect(labelToIndex('NONE')).toBe(-1);
    expect(labelToIndex('empty')).toBe(-1);
    expect(labelToIndex('3')).toBe(-1);
    expect(labelToIndex('')).toBe(-1);
  });
});

describe('parseCellIdentification', () => {
  it('maps elements to cells and reports the unused ones', () => {
    const reply = '{"assignments":[{"element":1,"label":"B"},{"element":2,"label":"C"},{"element":3,"label":"D"}],"empty":["A"]}';
    const { map, missing, unused } = parseCellIdentification(reply, 3, 4);
    expect(map).toEqual([1, 2, 3]);
    expect(missing).toEqual([]);
    expect(unused).toEqual([0]);
  });

  it('reports an element with no cell as missing', () => {
    const reply = '{"assignments":[{"element":1,"label":"A"},{"element":2,"label":null},{"element":3,"label":"C"}]}';
    const { map, missing } = parseCellIdentification(reply, 3, 4);
    expect(map).toEqual([0, null, 2]);
    expect(missing).toEqual([1]);
  });

  it('never hands the same cell to two elements', () => {
    const reply = '{"assignments":[{"element":1,"label":"A"},{"element":2,"label":"A"}]}';
    const { map, missing } = parseCellIdentification(reply, 2, 3);
    expect(map).toEqual([0, null]);
    expect(missing).toEqual([1]);
  });

  it('ignores labels beyond the detected cell count', () => {
    const reply = '{"assignments":[{"element":1,"label":"Z"}]}';
    const { map, missing } = parseCellIdentification(reply, 1, 4);
    expect(map).toEqual([null]);
    expect(missing).toEqual([0]);
  });

  it('ignores out-of-range element numbers', () => {
    const reply = '{"assignments":[{"element":0,"label":"A"},{"element":9,"label":"B"},{"element":1,"label":"C"}]}';
    const { map } = parseCellIdentification(reply, 2, 4);
    expect(map).toEqual([2, null]);
  });

  it('unwraps a fenced reply', () => {
    const reply = 'Here you go:\n```json\n{"assignments":[{"element":1,"label":"D"}]}\n```';
    const { map } = parseCellIdentification(reply, 1, 4);
    expect(map).toEqual([3]);
  });

  it('throws when the reply carries no JSON at all', () => {
    expect(() => parseCellIdentification('I cannot tell.', 2, 4)).toThrow(/no JSON object/);
  });

  it('throws on malformed JSON rather than silently mapping nothing', () => {
    expect(() => parseCellIdentification('{"assignments": [oops]}', 2, 4)).toThrow(/not valid JSON/);
    // An unclosed object still throws; since the tolerant extractor (2026-09-14)
    // it is reported as bad JSON rather than as "no JSON object" — the
    // behaviour pinned here is the throw, not the wording.
    expect(() => parseCellIdentification('{"assignments":[{', 2, 4)).toThrow();
  });

  it('treats a missing assignments array as everything unmatched', () => {
    const { map, missing } = parseCellIdentification('{"empty":["A","B"]}', 2, 2);
    expect(map).toEqual([null, null]);
    expect(missing).toEqual([0, 1]);
  });
});

/**
 * Staging job_1791560888615_uaivmr21o (Lina) and 10 more single-character
 * sheets in stored data (replayed over 698 stored sheets, 71 single-element:
 * 17 were split in two, 6 still are after this fix): ONE full-height figure on
 * pale paper had a single quiet row, the quietest row of one soft wash, that
 * passed every wide-window test and split a one-cell sheet into two cells.
 * A real gutter steps away from the rows beside it, in texture or in tone.
 */
describe('detectSheetGrid: a quiet row inside one wash is not a gutter', () => {
  // Rows of a two-level pattern: 40% of the width at `level`, the rest at 230.
  // std = |230 - level| * sqrt(0.4 * 0.6), mean = 230 - 0.4 * (230 - level).
  async function figureSheet(quietRowLevel: number): Promise<Buffer> {
    const w = 200, h = 400;
    const data = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      const level = y === 200 ? quietRowLevel
        : (y >= 190 && y <= 210) ? 203   // std 13: the calm wash around the quiet row
          : 100;                          // std 64: the figure
      for (let x = 0; x < w; x++) data[y * w + x] = x < w * 0.4 ? level : 230;
    }
    return sharp(data, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
  }

  it('a single figure with one quiet row stays ONE cell', async () => {
    const grid = await detectSheetGrid(await figureSheet(207));   // std 11, mean 221 vs 219
    expect(grid.count).toBe(1);
  });
});

describe('parseCellIdentification: a degenerate tail does not void the answer', () => {
  // Real reply shape (staging job_1789337873076_qf2at21ui, 8 of 8 reruns): the
  // assignments are complete, then the unused `empty` list degenerates into
  // repeated letters and raw newlines, so the whole object is invalid JSON.
  const reply = '{"assignments": [{"element": 1, "label": "A"}], "empty": ["B", "C", "F]}\n"E", "F"]}\n", "E", "F", "G", "N",';
  it('reads the complete assignments array', () => {
    expect(parseCellIdentification(reply, 1, 3).map).toEqual([0]);
  });
});
