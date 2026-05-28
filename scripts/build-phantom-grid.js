// One-off: deterministically assemble a phantom 2x4 grid from a correct-facing
// source, normalizing head sizes (top row) and body sizes (bottom row) without
// any AI re-render (so facing/poses can't scramble). Whitens grey panels.
//   node scripts/build-phantom-grid.js <src.png> <out.png> [headH] [bodyH]
const sharp = require('sharp');
const SRC = process.argv[2];
const OUT = process.argv[3];
const TARGET_HEAD_H = parseInt(process.argv[4] || '210', 10);
const TARGET_BODY_H = parseInt(process.argv[5] || '330', 10);
const W = 1408, H = 768, COLW = 352, ROWH = 384, BODY_BASELINE = 752;

async function whiten(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 228 && data[i + 1] > 228 && data[i + 2] > 228) { data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
}
async function rowWidths(buf) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels: ch } = info;
  const ink = (x, y) => { const o = (y * width + x) * ch; return !(data[o] > 242 && data[o + 1] > 242 && data[o + 2] > 242); };
  let figTop = -1, figBot = -1; const widths = [], lefts = [], rights = [];
  for (let y = 0; y < height; y++) {
    let l = -1, r = -1; for (let x = 0; x < width; x++) if (ink(x, y)) { if (l < 0) l = x; r = x; }
    widths.push(r < 0 ? 0 : r - l + 1); lefts.push(l); rights.push(r);
    if (r >= 0) { if (figTop < 0) figTop = y; figBot = y; }
  }
  return { widths, lefts, rights, figTop, figBot, width, height };
}
async function headCrop(buf) {
  const rw = await rowWidths(buf);
  const { widths, figTop, figBot } = rw;
  const figH = figBot - figTop;
  let peakRow = figTop, peak = 0;
  for (let y = figTop; y <= figTop + Math.round(figH * 0.40); y++) if (widths[y] > peak) { peak = widths[y]; peakRow = y; }
  let neckRow = peakRow, minW = peak; const win = Math.round(peak * 0.9);
  for (let y = peakRow; y <= Math.min(figBot, peakRow + win); y++) if (widths[y] < minW) { minW = widths[y]; neckRow = y; }
  const top = Math.max(0, figTop - 4), bottom = Math.min(rw.height, neckRow + 6);
  let minX = rw.width, maxX = 0;
  for (let y = top; y < bottom; y++) if (rw.lefts[y] >= 0) { if (rw.lefts[y] < minX) minX = rw.lefts[y]; if (rw.rights[y] > maxX) maxX = rw.rights[y]; }
  const left = Math.max(0, minX - 4), right = Math.min(rw.width, maxX + 4);
  const head = await sharp(buf).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
  return sharp(head).resize({ height: TARGET_HEAD_H }).png().toBuffer();
}
(async () => {
  const comp = [];
  for (let c = 0; c < 4; c++) {
    let topCell = await sharp(SRC).extract({ left: c * COLW + 5, top: 5, width: COLW - 10, height: ROWH - 10 }).png().toBuffer();
    topCell = await whiten(topCell);
    const head = await headCrop(topCell);
    let m = await sharp(head).metadata();
    comp.push({ input: head, left: Math.round(c * COLW + (COLW - m.width) / 2), top: Math.round((ROWH - m.height) / 2) });

    let botCell = await sharp(SRC).extract({ left: c * COLW + 5, top: ROWH + 5, width: COLW - 10, height: ROWH - 10 }).png().toBuffer();
    botCell = await whiten(botCell);
    let body; try { body = await sharp(botCell).trim({ threshold: 8 }).resize({ height: TARGET_BODY_H }).png().toBuffer(); }
    catch (e) { body = await sharp(botCell).resize({ height: TARGET_BODY_H }).png().toBuffer(); }
    m = await sharp(body).metadata();
    comp.push({ input: body, left: Math.round(c * COLW + (COLW - m.width) / 2), top: Math.round(BODY_BASELINE - m.height) });
  }
  const grid = Buffer.from('<svg width="' + W + '" height="' + H + '"><rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" fill="none" stroke="#cccccc" stroke-width="2"/><line x1="352" y1="0" x2="352" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="704" y1="0" x2="704" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="1056" y1="0" x2="1056" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="0" y1="384" x2="1408" y2="384" stroke="#cccccc" stroke-width="2"/></svg>');
  comp.push({ input: grid, left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite(comp).png().toFile(OUT);
  console.log('saved', OUT);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
