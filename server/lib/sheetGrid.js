/**
 * Sheet grid detection — find the REAL cell rectangles of a generated
 * reference sheet from its pixels, instead of trusting the requested count.
 *
 * Why this exists (staging story job_1788641639919_mpjwlzkf1, 2026-09-06):
 * a 3-element VB character batch was prompted as a "single vertical column
 * with three cells stacked top-to-bottom". The image model returned a 2x2
 * grid with FOUR cells. Both splitters downstream took the requested count
 * as fact — the analyzer's /split-reference-sheet asks _detect_separators
 * for exactly (rows-1) horizontal lines, and the sharp fallback divides
 * height by 3 — so the sheet was cut into three horizontal bands across a
 * 2x2 layout. Every cut was misaligned: the first element came out as two
 * figures side by side, the second as a band straddling the mid-row divider
 * (two different figures), the third as a strip of legs and shoes. Those
 * became the per-element references fed to page generation.
 *
 * The detector is deliberately count-free: it locates the gutter bands (thin
 * near-uniform lines, black or white, running the full span) and derives the
 * grid from them. The caller compares the detected count with what it asked
 * for and only then decides whether an identification call is needed.
 *
 * Pure sharp + JS on purpose: it must work when the Python analyzer service
 * is unreachable, and it is the one place unit tests can drive synthetic
 * sheets through. The analyzer's _detect_separators is NOT a second copy of
 * this — it answers a different question (a KNOWN number of dividers, e.g.
 * the single head/body row divider of a 2x4 character sheet) and is left
 * alone.
 */

const sharp = require('sharp');

// A gutter line is near-uniform along its whole span. The threshold is
// ADAPTIVE, not absolute: on a pale watercolour sheet the plain background
// rows sit around std 13, so a fixed cutoff of 14 swallowed the real 3px
// black divider into a 500px "uniform" run and the band was then rejected as
// too thick (measured on the story's batch-1 sheet, divider at y=511-513).
// A fraction of the sheet's median line-std separates a drawn line from calm
// paint at any exposure.
const UNIFORM_STD_FRACTION = 0.3;
const UNIFORM_STD_FLOOR = 1.5;
const UNIFORM_STD_CEILING = 12;
// ...and thin. A pale margin or a flat sky is uniform too, but wide.
const MAX_BAND_FRAC = 0.045;        // band thickness as a fraction of the dimension
// A cell has to be a cell, not a sliver.
const MIN_CELL_FRAC = 0.12;
// The band must stand out against what surrounds it, otherwise any calm
// stripe inside a watercolour wash reads as a divider.
const NEIGHBOUR_STD_MIN = 10;       // absolute std of the flanking content
const NEIGHBOUR_STD_RATIO = 2.0;    // and it must be this much noisier than the band
// A drawn gutter is a different TONE from the picture beside it — a black
// line on paint, or a white gutter between two pictures. A calm stripe the
// same brightness as its surroundings is paint, not a divider.
const MEAN_CONTRAST_MIN = 20;       // 0-255

/**
 * Per-line mean and standard deviation along one axis.
 * @param {Buffer|Uint8Array} data greyscale bytes, width*height
 * @returns {{ mean: Float64Array, std: Float64Array }} one entry per line
 */
function lineStats(data, width, height, axis) {
  const n = axis === 'h' ? height : width;
  const span = axis === 'h' ? width : height;
  const mean = new Float64Array(n);
  const std = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < span; j++) {
      const v = axis === 'h' ? data[i * width + j] : data[j * width + i];
      sum += v;
      sumSq += v * v;
    }
    const m = sum / span;
    mean[i] = m;
    std[i] = Math.sqrt(Math.max(0, sumSq / span - m * m));
  }
  return { mean, std };
}

function avg(arr, from, to) {
  if (to < from) return 0;
  let s = 0;
  for (let i = from; i <= to; i++) s += arr[i];
  return s / (to - from + 1);
}

/**
 * Locate gutter bands along one axis.
 *
 * Returns bands as { start, end, centre } in pixels, sorted, EXCLUDING bands
 * that touch an edge — those are the sheet's outer frame or padding, not an
 * internal divider.
 */
function detectGutterBands(data, width, height, axis) {
  const n = axis === 'h' ? height : width;
  const { mean, std } = lineStats(data, width, height, axis);
  const maxBand = Math.max(1, Math.round(n * MAX_BAND_FRAC));
  const minCell = Math.round(n * MIN_CELL_FRAC);

  const sorted = Array.from(std).sort((a, b) => a - b);
  const medianStd = sorted[Math.floor(sorted.length / 2)] || 0;
  const uniformMax = Math.min(
    UNIFORM_STD_CEILING,
    Math.max(UNIFORM_STD_FLOOR, medianStd * UNIFORM_STD_FRACTION)
  );

  // Contiguous runs of near-uniform lines.
  const runs = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    const uniform = std[i] <= uniformMax;
    if (uniform && start < 0) start = i;
    if (start >= 0 && (!uniform || i === n - 1)) {
      runs.push({ start, end: uniform ? i : i - 1 });
      start = -1;
    }
  }

  const bands = [];
  for (const run of runs) {
    const thickness = run.end - run.start + 1;
    // Outer frame / padding: a run that reaches an edge is never a divider.
    if (run.start === 0 || run.end === n - 1) continue;
    // Wide uniform field (a pale margin, a flat sky) — not a gutter.
    if (thickness > maxBand) continue;
    // Must leave a real cell on each side.
    if (run.start < minCell || run.end > n - 1 - minCell) continue;
    // Must contrast with the content flanking it.
    const bandStd = avg(std, run.start, run.end);
    const before = avg(std, Math.max(0, run.start - maxBand * 3), run.start - 1);
    const after = avg(std, run.end + 1, Math.min(n - 1, run.end + maxBand * 3));
    const neighbour = Math.max(before, after);
    if (neighbour < NEIGHBOUR_STD_MIN) continue;
    if (neighbour < bandStd * NEIGHBOUR_STD_RATIO) continue;
    // Tone contrast against the paint on at least one side.
    const bandMean = avg(mean, run.start, run.end);
    const meanBefore = avg(mean, Math.max(0, run.start - maxBand * 3), run.start - 1);
    const meanAfter = avg(mean, run.end + 1, Math.min(n - 1, run.end + maxBand * 3));
    const contrast = Math.max(Math.abs(bandMean - meanBefore), Math.abs(bandMean - meanAfter));
    if (contrast < MEAN_CONTRAST_MIN) continue;
    bands.push({ start: run.start, end: run.end, centre: Math.round((run.start + run.end) / 2) });
  }

  // Merge bands closer together than a cell — one thick gutter whose middle
  // rows failed the uniformity test and split it into two runs.
  const merged = [];
  for (const b of bands) {
    const prev = merged[merged.length - 1];
    if (prev && b.start - prev.end < minCell) {
      prev.end = b.end;
      prev.centre = Math.round((prev.start + prev.end) / 2);
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

/**
 * Turn gutter bands into cell extents along one axis. Content outside the
 * outermost band is kept; the outer frame is trimmed by `trim`.
 */
function bandsToExtents(bands, size, trim) {
  const extents = [];
  let cursor = trim;
  for (const b of bands) {
    extents.push([cursor, b.start - 1]);
    cursor = b.end + 1;
  }
  extents.push([cursor, size - 1 - trim]);
  return extents.filter(([a, b]) => b - a + 1 >= Math.round(size * MIN_CELL_FRAC));
}

/**
 * Detect the grid of a reference sheet from its pixels.
 *
 * @param {Buffer} buffer encoded image bytes
 * @returns {Promise<object>} { width, height, cols, rows, count, cells[], separators }
 *          cells are row-major: { index, row, col, left, top, width, height }
 */
async function detectSheetGrid(buffer) {
  const { data, info } = await sharp(buffer)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const hBands = detectGutterBands(data, width, height, 'h');
  const vBands = detectGutterBands(data, width, height, 'v');

  // Trim the outer frame: 0.5% of the smaller dimension, so a 1-2px border
  // line never bleeds into a cell.
  const trim = Math.max(1, Math.round(Math.min(width, height) * 0.005));

  const rowExtents = bandsToExtents(hBands, height, trim);
  const colExtents = bandsToExtents(vBands, width, trim);

  const cells = [];
  for (let r = 0; r < rowExtents.length; r++) {
    for (let c = 0; c < colExtents.length; c++) {
      const [top, bottom] = rowExtents[r];
      const [left, right] = colExtents[c];
      cells.push({
        index: cells.length,
        row: r,
        col: c,
        left,
        top,
        width: right - left + 1,
        height: bottom - top + 1,
      });
    }
  }

  return {
    width,
    height,
    cols: colExtents.length,
    rows: rowExtents.length,
    count: cells.length,
    cells,
    separators: {
      horizontal: hBands.map(b => b.centre),
      vertical: vBands.map(b => b.centre),
    },
  };
}

/** Crop the detected cells out of the sheet. Returns base64 PNGs, row-major. */
async function cropCells(buffer, cells) {
  return Promise.all(cells.map(async (cell) => {
    const out = await sharp(buffer)
      .extract({ left: cell.left, top: cell.top, width: cell.width, height: cell.height })
      .png()
      .toBuffer();
    return out.toString('base64');
  }));
}

/** 0 -> "A", 1 -> "B", ... 25 -> "Z", 26 -> "AA". */
function cellLabel(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * "A" -> 0, "B" -> 1, ... Returns -1 for anything unrecognised.
 *
 * The no-match words are rejected explicitly: the prompt asks for null, but
 * models write "none"/"NONE"/"empty" instead, and those are letters-only —
 * "NONE" would otherwise decode to cell 262,415.
 */
const NO_MATCH_WORDS = new Set(['NONE', 'NULL', 'EMPTY', 'NA', 'N/A', 'NO', 'NOT FOUND', 'MISSING']);
function labelToIndex(label) {
  const s = String(label || '').trim().toUpperCase();
  if (NO_MATCH_WORDS.has(s)) return -1;
  if (!/^[A-Z]+$/.test(s)) return -1;
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Draw a large label (A, B, C…) in the top-left of each detected cell, so one
 * vision call can say which cell holds which element. Returns a PNG buffer.
 */
async function labelCells(buffer, cells) {
  const meta = await sharp(buffer).metadata();
  const size = Math.max(28, Math.round(Math.min(meta.width, meta.height) * 0.07));
  const box = Math.round(size * 1.35);
  const overlays = cells.map((cell) => {
    const svg = '<svg width="' + box + '" height="' + box + '" xmlns="http://www.w3.org/2000/svg">'
      + '<rect x="0" y="0" width="' + box + '" height="' + box + '" fill="#000000" fill-opacity="0.75"/>'
      + '<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle"'
      + ' font-family="sans-serif" font-weight="bold" font-size="' + size + '" fill="#ffffff">'
      + cellLabel(cell.index) + '</text></svg>';
    return {
      input: Buffer.from(svg),
      left: cell.left + Math.round(cell.width * 0.02),
      top: cell.top + Math.round(cell.height * 0.02),
    };
  });
  return sharp(buffer).composite(overlays).png().toBuffer();
}

/**
 * Parse the identification model's reply into element-index -> cell-index.
 *
 * Expected shape: {"assignments":[{"element":1,"label":"C"},…]}.
 * `element` is the 1-based position in the requested list. A label of null,
 * "none" or an unknown letter means the element was not found.
 *
 * @returns {{ map: Array<number|null>, missing: number[], unused: number[] }}
 *          map[i] = cell index for element i, or null when unmatched
 */
function parseCellIdentification(text, elementCount, cellCount) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const objMatch = body.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('identification reply contained no JSON object');

  let parsed;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch (err) {
    throw new Error('identification reply is not valid JSON: ' + err.message);
  }

  const map = new Array(elementCount).fill(null);
  const taken = new Set();
  for (const a of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const elementNo = Number(a && a.element);
    if (!Number.isInteger(elementNo) || elementNo < 1 || elementNo > elementCount) continue;
    const cellIdx = labelToIndex(a && a.label);
    if (cellIdx < 0 || cellIdx >= cellCount) continue;   // null / "none" / out of range
    // First claim wins — never hand the same cell to two elements.
    if (taken.has(cellIdx)) continue;
    if (map[elementNo - 1] !== null) continue;
    map[elementNo - 1] = cellIdx;
    taken.add(cellIdx);
  }

  const missing = [];
  for (let i = 0; i < elementCount; i++) if (map[i] === null) missing.push(i);
  const unused = [];
  for (let i = 0; i < cellCount; i++) if (!taken.has(i)) unused.push(i);
  return { map, missing, unused };
}

/**
 * Drop assignments whose cell is not a single panel.
 *
 * When the model draws a different grid than asked for, the detector can merge
 * several drawn panels into one "cell" (staging job_1789147573901_m3uam0nxi:
 * a sheet of three stacked panels plus a blank margin column was detected as
 * 2x1, and the identification call named one of those two cells for a single
 * element — the stored reference then showed three different objects). A crop
 * that re-detects as more than one cell is such a merge: it cannot be trusted
 * as one element's reference, so the element gets NO reference instead of a
 * wrong one. A missing reference degrades; a three-object reference poisons
 * every prompt it reaches.
 *
 * Pure, so the mapping is testable without an image or a model call.
 *
 * @param {Array<number|null>} map element index -> cell index (or null)
 * @param {Array<number>} panelCounts per cell index, panels detected INSIDE it
 * @returns {{ map: Array<number|null>, dropped: Array<{element:number, cell:number, panels:number}> }}
 */
function rejectMultiPanelAssignments(map, panelCounts) {
  const out = map.slice();
  const dropped = [];
  for (let i = 0; i < out.length; i++) {
    const cell = out[i];
    if (cell === null || cell === undefined) continue;
    const panels = Number(panelCounts[cell]) || 1;
    if (panels > 1) {
      dropped.push({ element: i, cell, panels });
      out[i] = null;
    }
  }
  return { map: out, dropped };
}

module.exports = {
  detectSheetGrid,
  detectGutterBands,
  bandsToExtents,
  cropCells,
  labelCells,
  cellLabel,
  labelToIndex,
  parseCellIdentification,
  rejectMultiPanelAssignments,
  lineStats,
};
