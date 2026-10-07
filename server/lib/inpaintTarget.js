/**
 * The TARGET of a page inpaint, as pixels (owner, 2026-10-07; docs/decisions.md
 * "Inpaint is pasted back to its target box").
 *
 * An inpaint is a whole-frame Grok edit with no mask (SETTLED: the API has no
 * region parameter). Measured over 194 stored inpaints at 384px: the median edit
 * moves 14% of the frame's 16px cells by more than 20 grey levels, the 90th
 * percentile 45% — far more than any single fix covers. When every fix of the
 * plan names a figure we hold a box for, the edit is confined to that box: the
 * original's pixels come back everywhere outside the dilated, feathered box.
 * A plan with a scene-wide fix (relight, remove an object) has no box and skips
 * this entirely. Pure pixel mechanics: no judge, no prose.
 *
 * Boxes are [ymin, xmin, ymax, xmax] normalised, the repair-box convention.
 */
const sharp = require('sharp');

const MEASURE_W = 384;       // same grid the stored-evidence measurements used
const CELL = 16;
const CELL_CHANGED = 20;     // mean abs grey-level diff that makes a cell "changed"
const NOOP_MAX_MAD = 3;      // inside the target, below this AND no changed cell = no-op
const DILATE = 0.15;         // box grown by this fraction of its size on each side
const FEATHER_FRAC = 0.06;   // feather radius as a fraction of the box's smaller side

const toBuffer = (data) => Buffer.from(String(data).replace(/^data:image\/[a-z+.-]+;base64,/i, ''), 'base64');

function dilateBox(b, grow = DILATE) {
  const h = b[2] - b[0], w = b[3] - b[1];
  return [Math.max(0, b[0] - h * grow), Math.max(0, b[1] - w * grow), Math.min(1, b[2] + h * grow), Math.min(1, b[3] + w * grow)];
}

const validBox = (b) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];

/** Mean abs diff and changed-cell count of the pixels inside / outside the boxes. */
async function measureChange(beforeData, afterData, boxes, { dilate = DILATE } = {}) {
  const grid = async (d) => sharp(toBuffer(d)).resize(MEASURE_W, MEASURE_W, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [a, b] = await Promise.all([grid(beforeData), grid(afterData)]);
  const inside = new Uint8Array(MEASURE_W * MEASURE_W);
  for (const raw of boxes) {
    const d = dilateBox(raw, dilate);
    for (let y = Math.floor(d[0] * MEASURE_W); y < Math.ceil(d[2] * MEASURE_W); y++) {
      for (let x = Math.floor(d[1] * MEASURE_W); x < Math.ceil(d[3] * MEASURE_W); x++) inside[y * MEASURE_W + x] = 1;
    }
  }
  const n = MEASURE_W / CELL;
  const acc = { in: { sum: 0, px: 0, changed: 0, cells: 0 }, out: { sum: 0, px: 0, changed: 0, cells: 0 } };
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    let s = 0, inPx = 0;
    for (let y = cy * CELL; y < (cy + 1) * CELL; y++) for (let x = cx * CELL; x < (cx + 1) * CELL; x++) {
      const i = y * MEASURE_W + x, j = i * 3;
      const d = (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2])) / 3;
      s += d; if (inside[i]) inPx++;
    }
    const side = inPx * 2 >= CELL * CELL ? 'in' : 'out';
    acc[side].sum += s; acc[side].px += CELL * CELL; acc[side].cells++;
    if (s / (CELL * CELL) > CELL_CHANGED) acc[side].changed++;
  }
  const mad = (o) => (o.px ? o.sum / o.px : 0);
  return {
    insideMad: mad(acc.in), insideChangedCells: acc.in.changed, insideCells: acc.in.cells,
    outsideMad: mad(acc.out), outsideChangedCells: acc.out.changed, outsideCells: acc.out.cells,
  };
}

/** True when the edit left its own target region as it was. */
function isNoop(m) {
  return m.insideCells > 0 && m.insideMad < NOOP_MAX_MAD && m.insideChangedCells === 0;
}

/**
 * The edited image inside the dilated, feathered boxes; the original everywhere
 * else. Returns a data URI in the edited image's format, or null when the two
 * frames are not the same shape (an edit that changed the aspect cannot be
 * overlaid honestly — the caller keeps the edit and logs).
 */
async function pasteBackOutside(beforeData, afterData, boxes, { dilate = DILATE } = {}) {
  const afterBuf = toBuffer(afterData);
  const am = await sharp(afterBuf).metadata();
  const bm = await sharp(toBuffer(beforeData)).metadata();
  if (Math.abs(am.width / am.height - bm.width / bm.height) > 0.02) return null;
  const W = am.width, H = am.height;
  const before = await sharp(toBuffer(beforeData)).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const after = await sharp(afterBuf).removeAlpha().raw().toBuffer();
  const alpha = Buffer.alloc(W * H);
  let minSide = Infinity;
  for (const raw of boxes) {
    const d = dilateBox(raw, dilate);
    minSide = Math.min(minSide, (d[2] - d[0]) * H, (d[3] - d[1]) * W);
    for (let y = Math.floor(d[0] * H); y < Math.ceil(d[2] * H); y++) {
      for (let x = Math.floor(d[1] * W); x < Math.ceil(d[3] * W); x++) alpha[y * W + x] = 255;
    }
  }
  const sigma = Math.max(1.5, minSide * FEATHER_FRAC);
  const soft = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const t = soft[i] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(after[i * 3 + c] * t + before[i * 3 + c] * (1 - t));
  }
  const jpeg = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/**
 * The boxes of a plan's fixes, or null when any fix is not box-addressable.
 * `fixes` = [{ characterName }] for the per-figure items that survived the gates;
 * `hasSceneFix` = the plan also carries a scene-wide instruction.
 */
function targetBoxesForFixes({ fixes, hasSceneFix, figures }) {
  if (hasSceneFix || !Array.isArray(fixes) || !fixes.length) return null;
  const { canonicalName } = require('./castResolver');
  const boxes = [];
  for (const f of fixes) {
    const fig = (Array.isArray(figures) ? figures : []).find(x => x?.name && f?.characterName && canonicalName(x.name) === canonicalName(f.characterName));
    const box = fig?.bodyBox || fig?.faceBox;
    if (!validBox(box)) return null;       // one unaddressable fix makes the whole edit global
    boxes.push(box);
  }
  return boxes;
}

module.exports = { measureChange, isNoop, pasteBackOutside, targetBoxesForFixes, dilateBox, DILATE, NOOP_MAX_MAD };
