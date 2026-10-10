/**
 * THE cutter of every character sheet: a 2x4 sheet (head row over body row) or a 1x4 body row into single figures.
 *
 * Until 2026-10-10 a sheet was cut at separators found by minimum row/column VARIANCE (the analyzer's /split-reference-sheet,
 * with a fixed-grid fallback). Variance is not where the figures are: a blank band above the heads is as uniform as a gutter, so
 * 9 of 71 stored staging sheets were cut across the heads (head cell blank, body cell the rest of the column), and the trial
 * slides showed wide empty images with a tiny figure in a corner (owner, 2026-10-10: "the grid must be sliced correctly").
 *
 * This cutter measures PAINT against the sheet's paper tone. Our own code composes the sheet as four equal columns with the head
 * row over the body row, so each boundary has a known place and is only refined to the least painted line near it:
 *   row boundary     the least painted row near the seam of the two rows (a 2x4 sheet only);
 *   column boundary  the least painted column near each quarter of the width (figures may touch, so no gap is required);
 *   cell             the paint inside one row x column window, trimmed to its bounding box plus a margin.
 * Hairline gutters (the seam, the column dividers) are not paint. A window with no figure in it throws: that sheet truly does
 * not hold the figures to cut, and the caller reports it instead of showing an empty image.
 * See docs/decisions.md 2026-10-10 "One figure-based sheet cutter".
 */
const sharp = require('sharp');

const INK_DELTA = 30;          // per-channel distance from the paper tone that counts as paint
const MIN_INK_SHARE = 0.01;    // share of a profile line that must be painted to count as content
const MIN_RUN = 6;             // a stretch of content shorter than this (px) is a hairline or speckle
const HAIRLINE_MAX = 5;        // a gutter line is at most this many px thick
const ROW_SEAM_WINDOW = [0.28, 0.62]; // where the seam between head row and body row may sit (share of the height)
const COLUMN_WINDOW = 0.08;    // a column boundary is searched this share of the width either side of its quarter
const SEAM_SMOOTH = 3;

/** Pure: the paper tone of an interleaved RGB buffer: the centre of the most populated 16-level colour bin (the ground is the biggest single colour of a sheet). */
function paperTone(rgb) {
  const bins = new Uint32Array(4096);
  for (let i = 0; i < rgb.length; i += 3) bins[((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4)]++;
  let best = 0;
  for (let b = 1; b < bins.length; b++) if (bins[b] > bins[best]) best = b;
  return [((best >> 8) << 4) + 8, (((best >> 4) & 15) << 4) + 8, ((best & 15) << 4) + 8];
}

/** Pure: 0/1 paint mask of an RGB buffer, with the hairline gutters (thin, nearly full-length lines) removed. */
function paintMask(rgb, W, H) {
  const tone = paperTone(rgb);
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < mask.length; i++) {
    const d = Math.max(Math.abs(rgb[3 * i] - tone[0]), Math.abs(rgb[3 * i + 1] - tone[1]), Math.abs(rgb[3 * i + 2] - tone[2]));
    mask[i] = d > INK_DELTA ? 1 : 0;
  }
  // Hairlines: a line of at most HAIRLINE_MAX px that is painted over most of its length (a divider), never a figure.
  const clear = (lineShare, runs, length, wipe) => {
    let start = -1;
    for (let i = 0; i <= length; i++) {
      const on = i < length && lineShare(i) >= 0.8;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { if (i - start <= HAIRLINE_MAX) for (let k = start; k < i; k++) wipe(k); start = -1; }
    }
  };
  const colShare = (x) => { let c = 0; for (let y = 0; y < H; y++) c += mask[y * W + x]; return c / H; };
  const rowShare = (y) => { let c = 0; for (let x = 0; x < W; x++) c += mask[y * W + x]; return c / W; };
  const cols = [], rows = [];
  clear(colShare, null, W, (x) => cols.push(x));
  clear(rowShare, null, H, (y) => rows.push(y));
  for (const x of cols) for (let y = 0; y < H; y++) mask[y * W + x] = 0;
  for (const y of rows) for (let x = 0; x < W; x++) mask[y * W + x] = 0;
  return mask;
}

// Smoothed copy of a profile (a boundary must not hang on a single speckle).
function smoothed(profile, r = SEAM_SMOOTH) {
  const out = new Float32Array(profile.length);
  for (let i = 0; i < profile.length; i++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(profile.length - 1, i + r); k++) { s += profile[k]; n++; }
    out[i] = s / n;
  }
  return out;
}

/** Pure: the index in [from, to) with the least paint; the position nearest `nominal` wins a tie. */
function leastPainted(profile, from, to, nominal) {
  const p = smoothed(profile);
  let best = Math.round(nominal), bestScore = Infinity;
  for (let i = Math.max(0, from); i < Math.min(profile.length, to); i++) {
    const score = p[i] + Math.abs(i - nominal) / profile.length * 0.05;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Pure: first and last stretch bounds of a profile's content (stretches >= MIN_RUN), or null. */
function contentSpan(profile) {
  let first = -1, last = -1, start = -1;
  const close = (end) => { if (end - start >= MIN_RUN) { if (first < 0) first = start; last = end; } start = -1; };
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= MIN_INK_SHARE) { if (start < 0) start = i; } else if (start >= 0) close(i);
  }
  if (start >= 0) close(profile.length);
  return first < 0 ? null : { start: first, end: last };
}

function boxOf(mask, W, x0, x1, y0, y1) {
  const colInk = new Float32Array(x1 - x0), rowInk = new Float32Array(y1 - y0);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (mask[y * W + x]) { colInk[x - x0]++; rowInk[y - y0]++; }
  for (let i = 0; i < colInk.length; i++) colInk[i] /= (y1 - y0);
  for (let i = 0; i < rowInk.length; i++) rowInk[i] /= (x1 - x0);
  const cx = contentSpan(colInk), cy = contentSpan(rowInk);
  if (!cx || !cy) return null;
  return { x: [x0 + cx.start, x0 + cx.end], y: [y0 + cy.start, y0 + cy.end] };
}

/**
 * The single figures of a sheet image, row-major (head row first): rows 1 (a body row) or 2 (head row over body row), `cols`
 * columns.
 * @returns {Promise<Buffer[]>} PNG buffers
 */
async function cutSheet(sheetBuf, { rows = 2, cols = 4 } = {}) {
  const { data, info } = await sharp(sheetBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const mask = paintMask(data, W, H);

  const rowInk = new Float32Array(H);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) c += mask[y * W + x]; rowInk[y] = c / W; }
  const rowEdges = [0];
  if (rows === 2) {
    const content = contentSpan(rowInk);
    if (!content) throw new Error('sheet cut: the image holds no figures');
    // The seam: the least painted row in the window where the two rows meet, never inside the headroom above the heads.
    const lo = Math.max(Math.floor(H * ROW_SEAM_WINDOW[0]), content.start + Math.round((content.end - content.start) * 0.15));
    const hi = Math.min(Math.ceil(H * ROW_SEAM_WINDOW[1]), content.end - Math.round((content.end - content.start) * 0.15));
    rowEdges.push(leastPainted(rowInk, lo, hi, (lo + hi) / 2));
  } else if (rows !== 1) throw new Error(`sheet cut: ${rows} rows are not supported`);
  rowEdges.push(H);

  const boxes = [];
  for (let r = 0; r < rows; r++) {
    const [y0, y1] = [rowEdges[r], rowEdges[r + 1]];
    const colInk = new Float32Array(W);
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) if (mask[y * W + x]) colInk[x]++;
    for (let x = 0; x < W; x++) colInk[x] /= (y1 - y0);
    const colEdges = [0];
    for (let c = 1; c < cols; c++) colEdges.push(leastPainted(colInk, Math.round(W * (c / cols - COLUMN_WINDOW)), Math.round(W * (c / cols + COLUMN_WINDOW)), W * c / cols));
    colEdges.push(W);
    for (let c = 0; c < cols; c++) {
      const label = `${rows === 1 || r === 1 ? 'body' : 'head'} row, figure ${c + 1}`;
      const box = boxOf(mask, W, colEdges[c], colEdges[c + 1], y0, y1);
      if (!box) throw new Error(`sheet cut: ${label} holds no figure`);
      const size = Math.max(box.x[1] - box.x[0], box.y[1] - box.y[0]);
      const margin = Math.max(12, Math.round(0.06 * size));
      // The margin never leaves the figure's own window: no neighbour, no gutter line.
      const left = Math.max(colEdges[c], box.x[0] - margin), right = Math.min(colEdges[c + 1], box.x[1] + margin);
      const top = Math.max(y0, box.y[0] - margin), bottom = Math.min(y1, box.y[1] + margin);
      boxes.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return Promise.all(boxes.map(b => sharp(sheetBuf).extract(b).png().toBuffer()));
}

module.exports = { cutSheet, paintMask, contentSpan, leastPainted, paperTone };
