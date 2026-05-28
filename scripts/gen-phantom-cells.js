// Generate phantom 2x4 sheets per age tier. Each cell generated individually
// (equal sizing by construction). Front/¾/profile head cells are head-only
// generations; the REAR head is CUT from the rear full-body (Grok reliably
// draws the back of the head on a full body but not on a head-only prompt).
// All views face RIGHT. Bodies carry small facial features.
//   node scripts/gen-phantom-cells.js all          # all tiers
//   node scripts/gen-phantom-cells.js child         # one tier
require('dotenv').config();
const fs = require('fs'); const sharp = require('sharp');
const { generateWithGrok } = require('../server/lib/grok');

const W = 1408, H = 768, COLW = 352, ROWH = 384, BODY_BASELINE = 752, HEAD_H = 220, BODY_H = 330;

const RATIOS = {
  toddler: 'a chubby toddler about 2 years old with a LARGE ROUND head about one quarter of the standing height, short stubby arms and legs and a soft rounded body — cute and friendly',
  child:   'a slim child about 7 to 9 years old, the head about one fifth of the standing height, balanced child build',
  teen:    'a lanky adolescent about 14 years old with NARROW shoulders and a thin slim build, the head about one seventh of the standing height — noticeably shorter and less developed than an adult',
  adult:   'a fully grown adult, the TALLEST figure, with BROAD shoulders and a mature developed muscular build, the head only about one eighth of the standing height (small head, long legs)',
};
// Per-tier head shape — the toddler must read as a cute round baby head, not an
// elongated adult oval (which looked uncanny).
const HEAD_SHAPE = {
  toddler: 'a large round chubby baby head with soft rounded cheeks, cute and friendly — round, never elongated',
  child:   'a softly rounded child head',
  teen:    'a smooth oval adolescent head',
  adult:   'a smooth oval adult head',
};
const FACE = {
  front: 'viewed straight from the front, facing the viewer',
  tq:    'viewed from a three-quarter angle, turned about 40 degrees toward the RIGHT',
  prof:  'viewed from a full side profile facing RIGHT (nose pointing to the right)',
  rear:  'seen from BEHIND so we see ONLY the back of the head and back — the face is completely hidden and NOT visible (no eyes, nose, or mouth shown), turned just ~25 degrees to the right so one ear barely shows at the edge',
};
const order = ['front', 'tq', 'prof', 'rear'];

const headPrompt = (f, tier) => `A simple bald wooden artist-mannequin head and neck ONLY — no shoulders, no torso. ${HEAD_SHAPE[tier]}, NO hair, with two tiny dot eyes, a small nose, two short thin dark eyebrows, and a mouth as one thin straight black line. The head is ${FACE[f]}. Centered with white space around it. Pure white background, simple flat style. No frame, grid, lines, text, or numbers.`;
const bodyPrompt = (f, ratio) => `A bald wooden artist posing mannequin, FULL BODY from the top of the head down to the feet, no hair, ${ratio}. Its face has two tiny dot eyes, a small nose, two short thin dark eyebrows, and a mouth as one thin straight black line (clearly visible when the face shows). The whole figure is ${FACE[f]}. Standing upright, centered, full figure visible with white space above the head and below the feet. Show EXACTLY ONE single mannequin and nothing else — no second figure, no extra small figure, no size-comparison figure. Pure white background, simple flat style. No frame, grid, lines, text, or numbers.`;

const gen = async (prompt, aspect) => {
  const r = await generateWithGrok(prompt, { aspectRatio: aspect });
  return Buffer.from(r.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
};

// Detect + crop the head region from a (trimmed) figure buffer via neck detection.
async function cropHead(buf) {
  const t = await sharp(buf).trim({ threshold: 12 }).png().toBuffer();
  const { data, info } = await sharp(t).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels: ch } = info;
  const ink = (x, y) => { const o = (y * width + x) * ch; return !(data[o] > 242 && data[o + 1] > 242 && data[o + 2] > 242); };
  const widths = [], lefts = [], rights = [];
  for (let y = 0; y < height; y++) { let l = -1, r = -1; for (let x = 0; x < width; x++) if (ink(x, y)) { if (l < 0) l = x; r = x; } widths.push(r < 0 ? 0 : r - l + 1); lefts.push(l); rights.push(r); }
  let peakRow = 0, peak = 0; const lim = Math.round(height * 0.35);
  for (let y = 0; y <= lim; y++) if (widths[y] > peak) { peak = widths[y]; peakRow = y; }
  let neckRow = peakRow, minW = peak; const win = Math.round(peak * 1.0);
  for (let y = peakRow; y <= Math.min(height - 1, peakRow + win); y++) if (widths[y] < minW) { minW = widths[y]; neckRow = y; }
  const top = 0, bottom = Math.min(height, neckRow + 6);
  let minX = width, maxX = 0; for (let y = top; y < bottom; y++) if (lefts[y] >= 0) { if (lefts[y] < minX) minX = lefts[y]; if (rights[y] > maxX) maxX = rights[y]; }
  const left = Math.max(0, minX - 4), right = Math.min(width, maxX + 4);
  return sharp(t).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
}

async function buildTier(tier) {
  const ratio = RATIOS[tier];
  const comp = [];
  for (let c = 0; c < 4; c++) {
    const f = order[c];
    const bodyRaw = await gen(bodyPrompt(f, ratio), '9:16');
    let head;
    if (f === 'rear') {
      head = await cropHead(bodyRaw);                  // cut the back-of-head from the full body
    } else {
      head = await gen(headPrompt(f, tier), '1:1');
    }
    head = await sharp(head).trim({ threshold: 12 }).resize({ height: HEAD_H }).png().toBuffer();
    let m = await sharp(head).metadata();
    comp.push({ input: head, left: Math.round(c * COLW + (COLW - m.width) / 2), top: Math.round((ROWH - m.height) / 2) });
    const body = await sharp(bodyRaw).trim({ threshold: 12 }).resize({ height: BODY_H }).png().toBuffer();
    m = await sharp(body).metadata();
    comp.push({ input: body, left: Math.round(c * COLW + (COLW - m.width) / 2), top: Math.round(BODY_BASELINE - m.height) });
    console.log('  ', tier, f, 'done');
  }
  const grid = Buffer.from('<svg width="' + W + '" height="' + H + '"><rect x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" fill="none" stroke="#cccccc" stroke-width="2"/><line x1="352" y1="0" x2="352" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="704" y1="0" x2="704" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="1056" y1="0" x2="1056" y2="768" stroke="#cccccc" stroke-width="2"/><line x1="0" y1="384" x2="1408" y2="384" stroke="#cccccc" stroke-width="2"/></svg>');
  comp.push({ input: grid, left: 0, top: 0 });
  const out = 'drafts/phantoms/phantom_' + tier + '_set_' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16) + '.png';
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite(comp).png().toFile(out);
  console.log('saved', out);
  return out;
}

(async () => {
  const arg = process.argv[2] || 'all';
  const tiers = arg === 'all' ? ['toddler', 'child', 'teen', 'adult'] : [arg];
  for (const t of tiers) { console.log('=== ' + t + ' ==='); await buildTier(t); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
