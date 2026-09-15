import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { largestInteriorUniformFraction } = require('../../server/lib/evalPipeline.js');

const ROWS = 40;
const COLS = 40;
const THRESHOLD = 0.08;

function blank(): Uint8Array {
  return new Uint8Array(ROWS * COLS);
}

/** A uniform band of `t` blocks hugging all four edges — a paper border / deckle edge. */
function perimeterBand(t: number): Uint8Array {
  const m = blank();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (r < t || r >= ROWS - t || c < t || c >= COLS - t) m[r * COLS + c] = 1;
    }
  }
  return m;
}

/** A contiguous rectangle sitting in the interior — a real AI box artifact. */
function interiorPatch(h: number, w: number): Uint8Array {
  const m = blank();
  const r0 = Math.floor((ROWS - h) / 2);
  const c0 = Math.floor((COLS - w) / 2);
  for (let r = r0; r < r0 + h; r++) {
    for (let c = c0; c < c0 + w; c++) m[r * COLS + c] = 1;
  }
  return m;
}

describe('uniform-patch artifact detection: interior contiguity vs perimeter band', () => {
  // The mask is tone-agnostic — the white and black checks feed the SAME
  // function, so each case is asserted for both twins via the shared helper.

  it('a uniform WHITE perimeter band of realistic thickness does not raise the artifact issue', () => {
    // 3 blocks of 40 per side = 42% of blocks uniform, far past the raw 8%
    // count the old check used — but it is a border, not a box.
    const band = perimeterBand(3);
    const rawCount = band.reduce((a, b) => a + b, 0) / (ROWS * COLS);
    expect(rawCount).toBeGreaterThan(THRESHOLD); // old heuristic would have fired
    expect(largestInteriorUniformFraction(band, ROWS, COLS)).toBe(0);
  });

  it('a uniform BLACK perimeter band of realistic thickness does not raise the artifact issue', () => {
    // Identical shape; the black twin must be fixed alongside the white one.
    expect(largestInteriorUniformFraction(perimeterBand(2), ROWS, COLS)).toBe(0);
    expect(largestInteriorUniformFraction(perimeterBand(5), ROWS, COLS)).toBe(0);
  });

  it('a contiguous INTERIOR patch above the threshold still raises it (sensitivity control)', () => {
    // 15x10 = 150/1600 = 9.4%, just over the 8% gate. Sensitivity must not drop.
    const patch = interiorPatch(15, 10);
    const frac = largestInteriorUniformFraction(patch, ROWS, COLS);
    expect(frac).toBeCloseTo(150 / 1600, 5);
    expect(frac).toBeGreaterThan(THRESHOLD);

    // And one that touches an edge without spanning it is still caught.
    const edgeTouching = blank();
    for (let r = 10; r < 25; r++) for (let c = 0; c < 10; c++) edgeTouching[r * COLS + c] = 1;
    expect(largestInteriorUniformFraction(edgeTouching, ROWS, COLS)).toBeGreaterThan(THRESHOLD);
  });

  it('an entirely uniform image still raises it (a blank/broken frame must never pass)', () => {
    const all = new Uint8Array(ROWS * COLS).fill(1);
    // Peeling is capped at 15% per side, so a large interior survives.
    expect(largestInteriorUniformFraction(all, ROWS, COLS)).toBeGreaterThan(0.4);
  });
});
