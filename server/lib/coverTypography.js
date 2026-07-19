// App-side cover typography — renders the title / dedication / branding onto TEXTLESS cover art.
//
// Ported from the approved prototype (scratchpad titletest/render2.cjs). Rendering is done with
// @resvg/resvg-js (loads the bundled OFL fonts explicitly, works on Windows dev + Linux prod), then
// sharp composites the transparent overlay onto the art. Figure placement uses the per-cover
// bboxDetection.figures[].bodyBox that detectBboxOnCovers already computes — no SAM/YOLO needed.
//
// Entry point: composeCover({ artBuffer, kind, title, dedication, seed, figures }) -> { buffer, spec }.

const path = require('path');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');

const FONT_DIR = path.join(__dirname, '..', '..', 'fonts');
const FONT_FILES = [
  'Fredoka-SemiBold.ttf', 'Baloo2-ExtraBold.ttf', 'LuckiestGuy-Regular.ttf', 'Bungee-Regular.ttf',
  'TitanOne-Regular.ttf', 'LilitaOne-Regular.ttf', 'Chewy-Regular.ttf', 'Shrikhand-Regular.ttf',
  'Pacifico-Regular.ttf', 'Caveat-SemiBold.ttf', 'Kalam-Regular.ttf', 'PatrickHand-Regular.ttf',
  'GochiHand-Regular.ttf', 'EBGaramond-Italic.ttf', 'Poppins-SemiBold.ttf',
].map(f => path.join(FONT_DIR, f));

// ---------------------------------------------------------------------------
// colour helpers (verbatim from prototype)
// ---------------------------------------------------------------------------
function hash(str, salt) { let h = 2166136261 ^ salt; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rgb2hsl(r, g, b) { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h, s, l = (mx + mn) / 2; if (mx === mn) h = s = 0; else { const d = mx - mn; s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; } return [h * 360, s, l]; }
function hsl(h, s, l) { h = ((h % 360) + 360) % 360 / 360; let r, g, b; if (s === 0) r = g = b = l; else { const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < .5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); } const x = v => Math.round(v * 255).toString(16).padStart(2, '0'); return '#' + x(r) + x(g) + x(b); }
function relLumRGB(r, g, b) { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); }
function relLumHex(hex) { return relLumRGB(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)); }
function wcag(l1, l2) { return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
function hex2rgb(h) { return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) }; }
function rgb2lab(r, g, b) { r /= 255; g /= 255; b /= 255;[r, g, b] = [r, g, b].map(v => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92); let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, y = r * 0.2126 + g * 0.7152 + b * 0.0722, z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;[x, y, z] = [x, y, z].map(v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116); return [116 * y - 16, 500 * (x - y), 200 * (y - z)]; }
function deltaE(c1, c2) { const a = rgb2lab(c1.r, c1.g, c1.b), b = rgb2lab(c2.r, c2.g, c2.b); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function warmth(h) { const H = ((h % 360) + 360) % 360; if (H <= 60 || H >= 330) return 1; if (H >= 180 && H <= 280) return -1; return 0; }
function imageTemp(pal) { let w = 0; for (const c of pal) { const [h, s] = rgb2hsl(c.r, c.g, c.b); w += warmth(h) * s * c.w; } return w; }
function hueRepresented(pal, hue) { for (const c of pal) { const [h, s] = rgb2hsl(c.r, c.g, c.b); if (s < 0.10 || c.w < 0.06) continue; let d = Math.abs(h - hue); d = Math.min(d, 360 - d); if (d < 42) return true; } return false; }
// Only genuinely MUDDY brown (dark + dull warm) is discouraged. Vivid golds (high sat) and
// lighter tans / skin tones (l >= 0.42) are allowed — they often make a good, matching title colour.
function isBrown(h, s, l) { return h >= 14 && h <= 42 && s < 0.55 && l < 0.42; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---------------------------------------------------------------------------
// fonts (open-license, bundled in fonts/) — family names must match the TTF name tables
// ---------------------------------------------------------------------------
const FONTS = {
  fredoka:   { family: 'Fredoka',      weight: 600, upper: false, adv: 0.56, depth: 6, sw: 8 },
  baloo:     { family: 'Baloo 2',      weight: 800, upper: false, adv: 0.58, depth: 6, sw: 8 },
  luckiest:  { family: 'Luckiest Guy', weight: 400, upper: true,  adv: 0.60, depth: 6, sw: 8 },
  bungee:    { family: 'Bungee',       weight: 400, upper: true,  adv: 0.62, depth: 6, sw: 8 },
  titan:     { family: 'Titan One',    weight: 400, upper: false, adv: 0.60, depth: 6, sw: 9 },
  lilita:    { family: 'Lilita One',   weight: 400, upper: true,  adv: 0.50, depth: 6, sw: 8 },
  chewy:     { family: 'Chewy',        weight: 400, upper: false, adv: 0.56, depth: 7, sw: 9 },
  shrikhand: { family: 'Shrikhand',    weight: 400, upper: false, adv: 0.58, depth: 7, sw: 9 },
  pacifico:  { family: 'Pacifico',     weight: 400, upper: false, adv: 0.52, depth: 7, sw: 9 },
};
const DEAL = [
  ['fredoka', 'arch'], ['baloo', 'tilt'], ['luckiest', 'straight'], ['bungee', 'straight'],
  ['titan', 'archdown'], ['lilita', 'tilt'], ['chewy', 'arch'], ['shrikhand', 'straight'], ['pacifico', 'tilt'],
];
// dedication fonts — varied scripts / hands / elegant italic
const WFONTS = [
  { family: 'Caveat', weight: 600, style: 'normal' },
  { family: 'Kalam', weight: 400, style: 'normal' },
  { family: 'Patrick Hand', weight: 400, style: 'normal' },
  { family: 'Gochi Hand', weight: 400, style: 'normal' },
  { family: 'EB Garamond', weight: 400, style: 'italic' },
];
const BFONT = 'Poppins'; // branding
const BRAND_TEXT = 'magicalstory.ch';

// ---------------------------------------------------------------------------
// image sampling (sharp) — accept a Buffer
// ---------------------------------------------------------------------------
async function palette(input) {
  const N = 180;
  const { data } = await sharp(input).resize(N, N, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Map();
  for (let i = 0; i < data.length; i += 3) { const r = data[i], g = data[i + 1], b = data[i + 2]; const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); let e = bins.get(k); if (!e) { e = { r: 0, g: 0, b: 0, n: 0 }; bins.set(k, e); } e.r += r; e.g += g; e.b += b; e.n++; }
  let arr = [...bins.values()].map(e => ({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, w: e.n / (N * N) }));
  arr.sort((a, b) => b.w - a.w);
  const out = [];
  for (const c of arr) { const near = out.find(o => Math.hypot(o.r - c.r, o.g - c.g, o.b - c.b) < 20); if (near) { near.w += c.w; continue; } if (out.length < 14) out.push({ ...c }); }
  return out;
}
async function boxDominant(input, x0, y0, x1, y1) {
  const m = await sharp(input).metadata();
  const L = Math.max(0, Math.round(x0 * m.width)), T = Math.max(0, Math.round(y0 * m.height));
  const Wd = Math.max(4, Math.min(m.width - L, Math.round((x1 - x0) * m.width))), Ht = Math.max(4, Math.min(m.height - T, Math.round((y1 - y0) * m.height)));
  const st = await sharp(input).extract({ left: L, top: T, width: Wd, height: Ht }).stats();
  return st.dominant;
}
// hero garment colours: sample cover pixels inside the main character's bodyBox, drop skin + greys
async function garmentColors(input, box) {
  if (!box) return [];
  const m = await sharp(input).metadata();
  const L = Math.max(0, Math.round(box[1] * m.width)), T = Math.max(0, Math.round(box[0] * m.height));
  const Wd = Math.max(4, Math.min(m.width - L, Math.round((box[3] - box[1]) * m.width))), Ht = Math.max(4, Math.min(m.height - T, Math.round((box[2] - box[0]) * m.height)));
  const { data } = await sharp(input).extract({ left: L, top: T, width: Wd, height: Ht }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Map();
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2]; const [h, s, l] = rgb2hsl(r, g, b);
    if (h >= 7 && h <= 50 && s >= 0.15 && s <= 0.65 && l >= 0.35 && l <= 0.88) continue; // skin
    if (s < 0.12) continue; // grey / white
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); let e = bins.get(k); if (!e) { e = { r: 0, g: 0, b: 0, n: 0 }; bins.set(k, e); } e.r += r; e.g += g; e.b += b; e.n++;
  }
  let arr = [...bins.values()].map(e => ({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n }));
  arr.sort((a, b) => b.n - a.n);
  const kept = arr.slice(0, 8); const tot = kept.reduce((a, c) => a + c.n, 0) || 1;
  return kept.map(c => { const [h, s] = rgb2hsl(c.r, c.g, c.b); return { r: c.r, g: c.g, b: c.b, hue: h, sat: s, w: c.n / tot }; });
}

// ---------------------------------------------------------------------------
// colour selection (verbatim from prototype)
// ---------------------------------------------------------------------------
function colorCandidates(chars, bg, pal) {
  const bgH = rgb2hsl(bg.r, bg.g, bg.b)[0];
  const it = imageTemp(pal);
  const out = [];
  const add = (h, s, l, rgb, hero, w) => {
    if (s < 0.14) return;
    if (hero) { const ht = warmth(h); if (((it > 0.10 && ht < 0) || (it < -0.10 && ht > 0)) && !hueRepresented(pal, h)) return; }
    const de = deltaE(rgb, bg) / 100;
    const hd = Math.min(Math.abs(h - bgH), 360 - Math.abs(h - bgH)) / 180;
    const base = de * 0.5 + hd * 0.35 + Math.min(s, 0.9) * 1.0 - (isBrown(h, s, l) ? 0.4 : 0) + (hero ? 0.5 : 0) + Math.min(w, 0.25) * 0.7;
    out.push({ h, s, hero, base });
  };
  for (const c of (chars || [])) if (c.w >= 0.06) { const [h, s, l] = rgb2hsl(c.r, c.g, c.b); add(h, s, l, c, true, c.w); }
  for (const c of pal) { const [h, s, l] = rgb2hsl(c.r, c.g, c.b); add(h, s, l, c, false, c.w); }
  out.sort((a, b) => b.base - a.base);
  const uniq = [];
  for (const c of out) { if (!uniq.some(u => Math.min(Math.abs(u.h - c.h), 360 - Math.abs(u.h - c.h)) < 28)) uniq.push(c); }
  if (!uniq.length) { const [h] = rgb2hsl(bg.r, bg.g, bg.b); uniq.push({ h: (h + 180) % 360, s: 0.6, hero: false, base: 0 }); }
  return uniq.slice(0, 6);
}
function accentColor(pal, bg) {
  const bgH = rgb2hsl(bg.r, bg.g, bg.b)[0];
  let best = null;
  for (const c of pal) { const [h, s] = rgb2hsl(c.r, c.g, c.b); if (s < 0.32 || c.w < 0.004) continue; let hd = Math.min(Math.abs(h - bgH), 360 - Math.abs(h - bgH)); if (hd < 30) continue; const score = s * 1.0 + Math.min(c.w, 0.15) * 2.5 + hd / 360 * 0.5; if (!best || score > best.score) best = { score, h, s: Math.max(s, 0.75) }; }
  return best;
}
function finalizeColor(h, s, src, bg) {
  const [bh, bs, bl] = rgb2hsl(bg.r, bg.g, bg.b);
  s = Math.min(0.95, Math.max(0.62, s + 0.08));
  let l = bl > 0.5 ? 0.30 : 0.66;
  const dir = bl > 0.5 ? -1 : 1;
  for (let i = 0; i < 24; i++) { if (deltaE(hex2rgb(hsl(h, s, l)), bg) >= 42) break; const nl = l + dir * 0.035; if (nl < 0.06 || nl > 0.95) break; l = nl; }
  l = Math.max(0.06, Math.min(0.95, l));
  if (deltaE(hex2rgb(hsl(h, s, l)), bg) < 40) { s = 0.42; l = bl > 0.5 ? 0.12 : 0.92; }
  const sideL = l > 0.5 ? Math.max(0.14, l - 0.36) : Math.min(0.80, l + 0.36);
  const face = hsl(h, s, l), side = hsl(h, Math.min(0.78, s), sideL);
  const bgLum = relLumRGB(bg.r, bg.g, bg.b), faceLum = relLumHex(face);
  const outline = bgLum > 0.42 ? '#14110d' : '#f7efdc';
  const needOutline = wcag(faceLum, bgLum) < 4.0;
  return { face, side, outline, needOutline, lightFace: l > 0.5, hue: h, src, dE: +deltaE(hex2rgb(face), bg).toFixed(0) };
}
// small-text colour: pure black/white vs the local bg, with a thin opposite halo
function bottomColor(bg) { const L = relLumRGB(bg.r, bg.g, bg.b); return L < 0.42 ? { face: '#ffffff', outline: '#000000' } : { face: '#111111', outline: '#ffffff' }; }

// ---------------------------------------------------------------------------
// occupancy + placement (verbatim geometry; occupancy now from figure boxes)
// ---------------------------------------------------------------------------
function boxArea(b) { return b ? (b[2] - b[0]) * (b[3] - b[1]) : 0; }
// figures: [{ bodyBox:[ymin,xmin,ymax,xmax] (0..1) }] -> {grid,gw,gh}
function occupancyFromFigures(figures, gw = 48, gh = 48) {
  const grid = Array.from({ length: gh }, () => new Array(gw).fill(0));
  for (const f of figures || []) {
    const b = f.bodyBox || f.faceBox; if (!b) continue;
    const [ymin, xmin, ymax, xmax] = b;
    for (let gy = 0; gy < gh; gy++) { const cy = (gy + 0.5) / gh; if (cy < ymin || cy > ymax) continue; for (let gx = 0; gx < gw; gx++) { const cx = (gx + 0.5) / gw; if (cx >= xmin && cx <= xmax) grid[gy][gx] = 1; } }
  }
  return { grid, gw, gh };
}
function splitLinesN(title, n) { const words = String(title).split(/\s+/); n = Math.max(1, Math.min(n, words.length)); if (n <= 1) return [title]; const total = words.reduce((a, w) => a + w.length, 0) + words.length - 1, target = total / n; const lines = []; let cur = [], len = 0; for (let i = 0; i < words.length; i++) { cur.push(words[i]); len += words[i].length + 1; const remW = words.length - 1 - i, remL = n - lines.length - 1; if (remL > 0 && (len >= target || remW <= remL)) { lines.push(cur.join(' ')); cur = []; len = 0; } } if (cur.length) lines.push(cur.join(' ')); return lines.length ? lines : [title]; }
function dilate(grid, gw, gh, r) { const g = grid.map(row => row.slice()); for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (grid[y][x]) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const ny = y + dy, nx = x + dx; if (ny >= 0 && ny < gh && nx >= 0 && nx < gw) g[ny][nx] = 1; } return g; }
const MARGIN = 0.045, MIN_FS_FRAC = 0.050, HCAP = 0.24;
function bestRect(occ, gw, gh, W, H, C, adv) {
  const grid = dilate(occ, gw, gh, 1), heights = new Array(gw).fill(0);
  const MIN_FS = H * MIN_FS_FRAC;
  let best = null;
  const consider = (l, r, topRow, hc) => {
    let x0 = Math.max(l / gw, MARGIN), x1 = Math.min((r + 1) / gw, 1 - MARGIN);
    let y0 = Math.max(topRow / gh, MARGIN), y1 = Math.min((topRow + hc) / gh, 1 - MARGIN);
    const wpx = (x1 - x0) * W, hpxAvail = (y1 - y0) * H, hpx = Math.min(hpxAvail, HCAP * H);
    if (wpx < W * 0.18 || hpxAvail < H * 0.05) return;
    let fs = 0, bestN = 1;
    for (let N = 1; N <= 3; N++) { const per = Math.max(1, Math.ceil(C / N)); const f = Math.min(wpx * 0.96 / (per * adv), hpx / (N * 1.16)); if (f > fs + 1e-6) { fs = f; bestN = N; } }
    if (fs < MIN_FS) return;
    const cy = (y0 + y1) / 2, cx = (x0 + x1) / 2;
    const score = fs / H - cy * 0.004 + (x1 - x0) * 0.003 - Math.abs(cx - 0.5) * 0.004;
    const usedY1 = Math.min(y1, y0 + fs * bestN * 1.16 / H);
    if (!best || score > best.score) best = { score, fs, N: bestN, x0, x1, y0, y1: usedY1 };
  };
  for (let y = 0; y < gh; y++) { for (let x = 0; x < gw; x++) heights[x] = grid[y][x] ? 0 : heights[x] + 1; const st = []; for (let x = 0; x <= gw; x++) { const cur = x < gw ? heights[x] : 0; while (st.length && heights[st[st.length - 1]] >= cur) { const hh = heights[st.pop()]; const l = st.length ? st[st.length - 1] + 1 : 0; consider(l, x - 1, y - hh + 1, hh); } st.push(x); } }
  return best;
}
function bottomRect(occ, gw, gh, W, H, C, adv, Nwant, hcap) {
  const grid = dilate(occ, gw, gh, 1), heights = new Array(gw).fill(0);
  let best = null;
  const consider = (l, r, topRow, hc) => {
    let x0 = Math.max(l / gw, MARGIN), x1 = Math.min((r + 1) / gw, 1 - MARGIN);
    let y0 = Math.max(topRow / gh, MARGIN), y1 = Math.min((topRow + hc) / gh, 1 - MARGIN);
    const cy = (y0 + y1) / 2; if (cy < 0.52) return;
    const wpx = (x1 - x0) * W, hpx = Math.min((y1 - y0) * H, hcap * H);
    if (wpx < W * 0.22) return;
    const per = Math.max(1, Math.ceil(C / Nwant));
    const fs = Math.min(wpx * 0.96 / (per * adv), hpx / (Nwant * 1.25));
    if (fs < H * 0.020) return;
    const cx = (x0 + x1) / 2, usedH = fs * Nwant * 1.25 / H;
    const score = fs / H - Math.abs(cx - 0.5) * 0.02 + cy * 0.012 + (x1 - x0) * 0.006;
    if (!best || score > best.score) best = { score, fs, N: Nwant, x0, x1, y0: Math.max(y0, y1 - usedH), y1 };
  };
  for (let y = 0; y < gh; y++) { for (let x = 0; x < gw; x++) heights[x] = grid[y][x] ? 0 : heights[x] + 1; const st = []; for (let x = 0; x <= gw; x++) { const cur = x < gw ? heights[x] : 0; while (st.length && heights[st[st.length - 1]] >= cur) { const hh = heights[st.pop()]; const l = st.length ? st[st.length - 1] + 1 : 0; consider(l, x - 1, y - hh + 1, hh); } st.push(x); } }
  if (!best) best = { fs: H * 0.03, N: Nwant, x0: 0.10, x1: 0.90, y0: 0.93 - 0.055 * Nwant, y1: 0.955 };
  return best;
}
const BRAND_INSET = 0.08;                                       // brand stays ≥8% from every page border
function brandSlot(grid, gw, gh, boxW, boxH) {
  const yb = 1 - BRAND_INSET, yt = yb - boxH;
  let best = null;
  for (const cx of [BRAND_INSET + boxW / 2, 1 - BRAND_INSET - boxW / 2]) { // left / right corner, 8% inset
    const x0 = cx - boxW / 2, x1 = cx + boxW / 2;
    let occ = 0, n = 0;
    for (let gy = Math.floor(yt * gh); gy < Math.ceil(yb * gh); gy++) for (let gx = Math.floor(x0 * gw); gx < Math.ceil(x1 * gw); gx++) { if (gy < 0 || gy >= gh || gx < 0 || gx >= gw) continue; occ += grid[gy][gx] ? 1 : 0; n++; }
    const score = -(n ? occ / n : 1);
    if (!best || score > best.score) best = { score, x0, x1, y0: yt, y1: yb };
  }
  return best || { x0: 1 - BRAND_INSET - boxW, x1: 1 - BRAND_INSET, y0: yt, y1: yb };
}

// ---------------------------------------------------------------------------
// SVG builders (title = 3D block; bottom = flat high-contrast) — pure SVG strings
// ---------------------------------------------------------------------------
function buildTitleGroup(lines, font, layout, colors, place, W, H) {
  const { face, side, outline } = colors;
  const DEPTH = font.depth, SX = 0.72, SY = 0.86, SW = font.sw;
  const faceSep = colors.needOutline
    ? `fill="${face}" stroke="${outline}" stroke-width="${SW}" paint-order="stroke" stroke-linejoin="round"`
    : `fill="${face}"`;
  const boxW = (place.x1 - place.x0) * W, targetW = boxW * 0.96;
  const longest = Math.max(...lines.map(l => (font.upper ? l.toUpperCase() : l).length));
  const maxFS = (place.hFrac * H / lines.length) * 1.02;
  let FS = Math.min(maxFS, targetW / (longest * font.adv));
  FS = Math.max(FS, H * 0.055);
  const gap = FS * 1.14, dip = H * 0.085, topPx = Math.max(place.yt * H, H * 0.03);
  const ax = (place.x0 + place.x1) / 2 * W;
  let inner = '';
  lines.forEach((ln, k) => {
    const txt = esc(font.upper ? ln.toUpperCase() : ln);
    if (layout === 'arch' || layout === 'archdown') {
      const down = layout === 'archdown', ctrl = down ? +dip : -dip;
      const peakY = topPx + FS * 0.98 + k * gap + (down ? dip * 0.6 : 0), id = `p${k}`;
      const common = `font-family="${font.family}" font-weight="${font.weight}" font-size="${FS}" text-anchor="middle"`;
      let ex = ''; for (let i = DEPTH; i >= 1; i--) ex += `<g transform="translate(${i * SX},${i * SY})"><text ${common} fill="${side}" stroke="${side}" stroke-width="${SW * 0.6}" stroke-linejoin="round"><textPath href="#${id}" startOffset="50%">${txt}</textPath></text></g>`;
      inner += `<defs><path id="${id}" d="M${place.x0 * W},${peakY} Q${(place.x0 + place.x1) / 2 * W},${peakY + ctrl} ${place.x1 * W},${peakY}" fill="none"/></defs>` + ex + `<text ${common} ${faceSep}><textPath href="#${id}" startOffset="50%">${txt}</textPath></text>`;
    } else {
      const y = topPx + FS * 0.9 + k * gap;
      const common = `x="${ax}" text-anchor="middle" font-family="${font.family}" font-weight="${font.weight}" font-size="${FS}"`;
      let ex = ''; for (let i = DEPTH; i >= 1; i--) ex += `<text ${common} y="${y}" transform="translate(${i * SX},${i * SY})" fill="${side}" stroke="${side}" stroke-width="${SW * 0.6}" stroke-linejoin="round">${txt}</text>`;
      inner += ex + `<text ${common} y="${y}" ${faceSep}>${txt}</text>`;
    }
  });
  if (layout === 'tilt') { const a = ((hash(lines.join(''), 5) % 2) ? 1 : -1) * (3 + hash(lines.join(''), 9) % 3); inner = `<g transform="rotate(${a} ${ax} ${topPx + FS})">${inner}</g>`; }
  return inner;
}
function buildBottomGroup(lines, colors, place, W, H, fontFam, weight, style) {
  const { face, outline } = colors;
  const FS = H * 0.05, gap = FS * 1.28;
  const cx = (place.x0 + place.x1) / 2 * W, top = place.y0 * H;
  let inner = '';
  lines.forEach((ln, k) => {
    const y = top + FS * 0.9 + k * gap, t = esc(ln);
    inner += `<text x="${cx}" y="${y}" text-anchor="middle" font-family="${fontFam}" font-weight="${weight}" font-style="${style || 'normal'}" font-size="${FS}" `
      + `fill="${face}" stroke="${outline}" stroke-width="${FS * 0.10}" paint-order="stroke" stroke-linejoin="round">${t}</text>`;
  });
  return inner;
}

// ---------------------------------------------------------------------------
// resvg render + measure-and-fit
// ---------------------------------------------------------------------------
function renderSvg(innerSvg, W, H) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${innerSvg}</svg>`;
  const r = new Resvg(svg, { font: { loadSystemFonts: false, fontFiles: FONT_FILES, defaultFontFamily: 'Poppins' }, background: 'rgba(0,0,0,0)' });
  return r.render().asPng();
}
async function inkBBox(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const a = data[(y * W + x) * C + (C - 1)]; if (a > 20) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } }
  if (maxx < 0) return null;
  return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, W, H };
}
// build group at nominal size, measure its ink, then scale-to-fill the target box and render final
async function fitRender(innerGroup, W, H, box, anchor) {
  const png1 = renderSvg(innerGroup, W, H);
  const bb = await inkBBox(png1);
  if (!bb) return null;
  const targetW = (box.x1 - box.x0) * W * 0.96, targetH = (box.y1 - box.y0) * H;
  const s = Math.min(targetW / bb.w, targetH / bb.h);
  const cx = (box.x0 + box.x1) / 2 * W;
  const tx = cx - (bb.x + bb.w / 2) * s;
  const ty = anchor === 'bottom' ? (box.y1 * H - (bb.y + bb.h) * s) : (Math.max(box.y0 * H, H * 0.03) - bb.y * s);
  return renderSvg(`<g transform="translate(${tx},${ty}) scale(${s})">${innerGroup}</g>`, W, H);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
async function composeFrontTitle(artBuffer, title, figures, seed) {
  const meta = await sharp(artBuffer).metadata(); const W = meta.width, H = meta.height;
  const occ = occupancyFromFigures(figures);
  const hero = (figures || []).slice().sort((a, b) => boxArea(b.bodyBox) - boxArea(a.bodyBox))[0];
  const chars = hero ? await garmentColors(artBuffer, hero.bodyBox) : [];
  const [fontId, layout] = DEAL[hash(seed || title, 7) % DEAL.length]; const font = FONTS[fontId];
  const C = String(title).length;
  const rect = bestRect(occ.grid, occ.gw, occ.gh, W, H, C, font.adv) || { x0: 0.06, x1: 0.94, y0: 0.05, y1: 0.26, N: C <= 22 ? 1 : 2 };
  const lines = splitLinesN(title, rect.N);
  const place = { align: 'center', x0: rect.x0, x1: rect.x1, yt: rect.y0, yb: rect.y1, hFrac: rect.y1 - rect.y0 };
  const bg = await boxDominant(artBuffer, place.x0, place.yt, place.x1, Math.min(0.95, place.yb));
  const pal = await palette(artBuffer);
  const cands = colorCandidates(chars, bg, pal);
  const [bhh, bss, bll] = rgb2hsl(bg.r, bg.g, bg.b);
  const lightWarm = bll > 0.5 && bss > 0.08 && (bhh < 70 || bhh >= 340);
  let col = { h: cands[0].h, s: cands[0].s };
  if (lightWarm) { const a = accentColor(pal, bg); if (a) col = { h: a.h, s: a.s }; }
  const colors = finalizeColor(col.h, col.s, 'title', bg);
  const group = buildTitleGroup(lines, font, layout, colors, place, W, H);
  const overlay = await fitRender(group, W, H, { x0: place.x0, x1: place.x1, y0: place.yt, y1: place.yb }, 'top');
  if (!overlay) return { buffer: artBuffer, spec: { skipped: 'no-ink' } };
  const buffer = await sharp(artBuffer).composite([{ input: overlay }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer, spec: { kind: 'front', fontId, layout, face: colors.face, lines, rect } };
}

async function composeDedication(artBuffer, dedication, figures, seed) {
  if (!dedication || !String(dedication).trim()) return { buffer: artBuffer, spec: { kind: 'initial', skipped: 'no-dedication' } };
  const meta = await sharp(artBuffer).metadata(); const W = meta.width, H = meta.height;
  const occ = occupancyFromFigures(figures);
  const wf = WFONTS[hash(seed || dedication, 33) % WFONTS.length];
  const text = String(dedication).trim();
  const words = text.split(/\s+/).length;
  let place, colors, lines;
  if (words <= 8) {
    // short dedication → clearest bottom pocket
    const br = bottomRect(occ.grid, occ.gw, occ.gh, W, H, text.length, 0.5, 1, 0.12);
    place = { x0: br.x0, x1: br.x1, y0: br.y0, y1: br.y1 };
    lines = [text];
  } else {
    // long dedication → fixed generous lower band
    place = { x0: 0.08, x1: 0.92, y0: 0.62, y1: 0.96 };
    lines = splitLinesN(text, Math.min(6, Math.max(2, Math.round(words / 6))));
  }
  const bg = await boxDominant(artBuffer, place.x0, place.y0, place.x1, Math.min(0.97, place.y1));
  colors = bottomColor(bg);
  const group = buildBottomGroup(lines, colors, place, W, H, wf.family, wf.weight, wf.style);
  const overlay = await fitRender(group, W, H, place, 'bottom');
  if (!overlay) return { buffer: artBuffer, spec: { kind: 'initial', skipped: 'no-ink' } };
  const buffer = await sharp(artBuffer).composite([{ input: overlay }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer, spec: { kind: 'initial', font: wf.family, lines } };
}

async function composeBrand(artBuffer, figures) {
  const meta = await sharp(artBuffer).metadata(); const W = meta.width, H = meta.height;
  const occ = occupancyFromFigures(figures);
  const slot = brandSlot(occ.grid, occ.gw, occ.gh, 0.30, 0.05);
  const bg = await boxDominant(artBuffer, slot.x0, slot.y0, slot.x1, Math.min(0.97, slot.y1));
  const colors = bottomColor(bg);
  const group = buildBottomGroup([BRAND_TEXT], colors, slot, W, H, BFONT, 700, 'normal');
  const overlay = await fitRender(group, W, H, slot, 'bottom');
  if (!overlay) return { buffer: artBuffer, spec: { kind: 'back', skipped: 'no-ink' } };
  const buffer = await sharp(artBuffer).composite([{ input: overlay }]).jpeg({ quality: 92 }).toBuffer();
  return { buffer, spec: { kind: 'back', slot } };
}

// dispatch: kind = 'front' | 'initial' | 'back'
async function composeCover({ artBuffer, kind, title, dedication, seed, figures }) {
  const figs = (figures || []).filter(f => f && (f.bodyBox || f.faceBox));
  if (kind === 'front') return composeFrontTitle(artBuffer, title || '', figs, seed);
  if (kind === 'initial') return composeDedication(artBuffer, dedication || '', figs, seed);
  if (kind === 'back') return composeBrand(artBuffer, figs);
  throw new Error(`composeCover: unknown kind ${kind}`);
}

// ---------------------------------------------------------------------------
// applyCoverTypography — bake the title/dedication/branding onto every cover so
// the SERVED image (imageVersions[active], which viewer/share/PDF/print all
// read) carries the text. The composited raster is the single source of truth;
// each version's textless source stays available via the top-level ${key}Art
// row so a title/dedication edit re-composites with no AI call.
// ---------------------------------------------------------------------------
async function applyCoverTypography(coverImages, { title, dedication, seed, trial = false } = {}) {
  if (!coverImages) return coverImages;
  const { log } = require('../utils/logger');
  const r2 = require('./r2');
  const JOBS = [['frontCover', 'front'], ['initialPage', 'initial'], ['backCover', 'back']];
  await Promise.all(JOBS.map(async ([key, kind]) => {
    const cover = coverImages[key];
    if (!cover || !cover.imageData || cover.artImageData) return; // missing, or already composited
    const figures = cover.bboxDetection?.figures || [];
    const ded = trial ? '' : (dedication || '');
    // Resolve to real bytes via bytesFromAnyImage — by this point the cover's
    // imageData is usually an R2 URL (streaming offloads the bytes and keeps only
    // the URL), so the old base64-decode produced garbage and composeCover threw
    // → the catch swallowed it and NO title was ever baked. bytesFromAnyImage
    // handles data-URI / raw base64 / https URL alike.
    const composite = async (src) => {
      const bytes = await r2.bytesFromAnyImage(src);
      if (!bytes) throw new Error('could not resolve cover image bytes');
      const { buffer, spec } = await composeCover({
        artBuffer: bytes, kind, title: title || '', dedication: ded, seed: seed || title, figures,
      });
      return { data: 'data:image/jpeg;base64,' + buffer.toString('base64'), spec };
    };
    try {
      const top = await composite(cover.imageData);
      cover.artImageData = cover.imageData;   // textless original (feeds ${key}Art)
      cover.imageData = top.data;             // titled top-level
      cover.typography = top.spec;
      if (Array.isArray(cover.imageVersions)) {
        for (const v of cover.imageVersions) {
          if (!v || !v.imageData || v.typography) continue; // missing or already titled
          try {
            const vt = await composite(v.imageData);
            v.imageData = vt.data;   // titled — this is what getActiveStoryImages serves
            v.typography = vt.spec;  // idempotency marker
          } catch (verr) {
            log.warn(`⚠️ [COVER TYPO] ${key} v: ${verr.message}`);
          }
        }
      }
      const spec = top.spec;
      log.info(`🅰️ [COVER TYPO] ${key}: baked title${ded ? '+dedication' : ''} (${spec.fontId || '?'}/${spec.layout || '?'})${spec.skipped ? ` (skipped: ${spec.skipped})` : ''}`);
    } catch (err) {
      log.warn(`⚠️ [COVER TYPO] ${key}: ${err.message}`);
    }
  }));
  return coverImages;
}

// ---------------------------------------------------------------------------
// bakeCoverTypographyPostPersist — the RELIABLE title/dedication baker.
// The in-pipeline applyCoverTypography silently no-ops because by the time it
// runs the cover's imageData has been offloaded to R2 (imageData === null), so
// its guard returns early. This runs AFTER persistence, reading each SERVED
// cover row straight from story_images (bytes definitely there), composites the
// title/dedication onto it, overwrites the served version row with the titled
// render, and keeps the textless original in ${key}Art so a later title/
// dedication edit re-composites with no AI call. Idempotent: skips a cover whose
// ${key}Art row already exists.
// ---------------------------------------------------------------------------
async function bakeCoverTypographyPostPersist(storyId, storyData, { title, dedication, seed, trial = false } = {}) {
  const { log } = require('../utils/logger');
  const r2 = require('./r2');
  const { saveStoryImage, dbQuery } = require('../services/database');
  const meta = ((await dbQuery('SELECT image_version_meta FROM stories WHERE id=$1', [storyId]))[0]?.image_version_meta) || {};
  const ded = trial ? '' : (dedication || '');
  for (const [key, kind] of [['frontCover', 'front'], ['initialPage', 'initial'], ['backCover', 'back']]) {
    try {
      const already = await dbQuery("SELECT 1 FROM story_images WHERE story_id=$1 AND image_type=$2 LIMIT 1", [storyId, `${key}Art`]);
      if (already.length) { log.debug(`[COVER TYPO POST] ${key}: already baked — skip`); continue; }
      const activeIdx = meta[key]?.activeVersion ?? 0;
      const rows = await dbQuery(
        "SELECT image_url, image_data FROM story_images WHERE story_id=$1 AND image_type=$2 AND version_index=$3 AND NOT is_test LIMIT 1",
        [storyId, key, activeIdx]);
      const row = rows[0];
      if (!row) { log.warn(`[COVER TYPO POST] ${key}: no served version v${activeIdx}`); continue; }
      const src = row.image_url || (row.image_data ? 'data:image/jpeg;base64,' + row.image_data.toString('base64') : null);
      const bytes = await r2.bytesFromAnyImage(src);
      if (!bytes) { log.warn(`[COVER TYPO POST] ${key}: could not resolve served bytes`); continue; }
      const figures = storyData?.coverImages?.[key]?.bboxDetection?.figures || [];
      const { buffer, spec } = await composeCover({ artBuffer: bytes, kind, title: title || '', dedication: ded, seed: seed || title, figures });
      // Textless original first (for no-AI re-edits), then overwrite the served
      // version row with the titled render.
      await saveStoryImage(storyId, `${key}Art`, null, 'data:image/jpeg;base64,' + bytes.toString('base64'), { versionIndex: 0 });
      await saveStoryImage(storyId, key, null, 'data:image/jpeg;base64,' + buffer.toString('base64'), { versionIndex: activeIdx });
      if (storyData?.coverImages?.[key]) storyData.coverImages[key].typography = spec;
      log.info(`🅰️ [COVER TYPO POST] ${key}: baked title${ded ? '+dedication' : ''} onto served v${activeIdx} (${spec.fontId || '?'}/${spec.layout || '?'})`);
    } catch (err) {
      log.warn(`[COVER TYPO POST] ${key}: ${err.message}`);
    }
  }
}

module.exports = {
  composeCover, composeFrontTitle, composeDedication, composeBrand, applyCoverTypography, bakeCoverTypographyPostPersist,
  // exported for the standalone verify CLI / tests
  _internals: { occupancyFromFigures, bestRect, colorCandidates, finalizeColor, palette, garmentColors, FONTS, DEAL, FONT_FILES, renderSvg, buildTitleGroup, fitRender },
};
