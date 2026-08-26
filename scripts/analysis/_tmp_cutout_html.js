// Build per-figure SAM-cutout HTML from Lab experiment #46's stored cutout sheets.
// Slices each sheet by replaying createCutoutSheetImage's layout math
// (CELL_H 760, HEAD_H 54, GAP 14, PAD 10, MAXW 3400) against the persisted
// figure list, then groups tiles by character name.
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = 'https://magicalstory.ch';
const SID = 'job_1787262655143_s9zb960muni';
const EXP = Number(process.env.EXP_ID || 46);
const OUT = path.resolve(process.env.OUT_DIR || '.', 'sam-cutouts');
const CELL_H = 760, HEAD_H = 54, GAP = 14, PAD = 10, MAXW = 3400;

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo-b-hnecf@magicalstory.ch', password: 'DemoStory2026!' }) });
  if (!r.ok) throw new Error('login ' + r.status);
  return (await r.json()).token;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const token = await login();
  const H = { Authorization: `Bearer ${token}` };

  const expRes = await fetch(`${BASE}/api/admin/testlab/experiments/${EXP}`, { headers: H });
  if (!expRes.ok) throw new Error('experiment fetch ' + expRes.status);
  const expJson = await expRes.json();
  const exp = expJson.experiment || expJson;
  const entries = exp.results || expJson.results || exp.entries || [];
  console.log('experiment', EXP, exp.status, 'entries:', entries.length);

  // Persisted detections (for figure order + boxes + stats)
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const q = await pool.query(`select data->'sceneImages' as si, data->'coverImages' as ci from stories where id=$1`, [SID]);
  await pool.end();
  const scenes = q.rows[0].si || [];
  const covers = q.rows[0].ci || {};
  const coverPage = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
  const detFor = (p) => p > 0
    ? scenes.find(s => s.pageNumber === p)?.bboxDetection
    : covers[coverPage[String(p)]]?.bboxDetection;

  const perFigure = {};  // name -> [{page, file, stat}]
  const pageRows = [];

  for (const e of entries) {
    const page = e.pageNumber ?? e.target?.pageNumber;
    const res = e.result || e;
    const steps = res.steps || [];
    const sheetStep = steps.find(s => /CUT-OUTS/i.test(s.label || ''));
    if (!sheetStep) { console.log(`p${page}: no cutout sheet step`); continue; }
    const url = `${BASE}/api/admin/testlab/test-image/${SID}/${sheetStep.imageType}/${page}/${sheetStep.versionIndex}`;
    const ir = await fetch(url, { headers: H });
    if (!ir.ok) { console.log(`p${page}: sheet fetch ${ir.status}`); continue; }
    let body = Buffer.from(await ir.arrayBuffer());
    // endpoint may return JSON {imageData: dataURI}
    if (body[0] === 0x7b) {
      const j = JSON.parse(body.toString());
      const d = j.imageData || j.image_data || j.imageUrl || j.image_url;
      if (/^https?:/.test(d)) body = Buffer.from(await (await fetch(d)).arrayBuffer());
      else body = Buffer.from(String(d).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }
    const sheetFile = `sheet-p${page}.png`;
    fs.writeFileSync(path.join(OUT, sheetFile), body);
    const sheetMeta = await sharp(body).metadata();

    // Persisted det for stats; Lab result figures for order (matches sheet build).
    const det = detFor(page);
    const statFor = (name) => {
      const f = (det?.figures || []).find(x => x.name === name);
      return f ? `${(f.maskPx || 0).toLocaleString()} px · seeds ${f.garmentSeeds ?? '–'} · ${f.maskVerdict || ''}` : '';
    };
    const labFigs = (res.figures || []).filter(f => f.samApplied);

    // IMAGE-DRIVEN slicing: tiles are separated by columns of untouched
    // background in the top row region. Replaying sharp's resize rounding
    // drifted (p8: 406px), so read the gaps from the pixels instead.
    const { data, info } = await sharp(body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const Ws = info.width, Hs = info.height, ch = info.channels;
    const bg = [data[0], data[1], data[2], data[3]]; // top-left corner = ground
    const scanTop = 2, scanBot = Math.max(3, Hs - HEAD_H - 4); // exclude label text rows
    const isBgCol = (x) => {
      for (let y = scanTop; y < scanBot; y += 2) {
        const i = (y * Ws + x) * ch;
        if (Math.abs(data[i] - bg[0]) > 6 || Math.abs(data[i+1] - bg[1]) > 6 || Math.abs(data[i+2] - bg[2]) > 6 || Math.abs(data[i+3] - bg[3]) > 6) return false;
      }
      return true;
    };
    const runs = [];
    let start = null;
    for (let x = 0; x < Ws; x++) {
      const b2 = isBgCol(x);
      if (!b2 && start === null) start = x;
      if (b2 && start !== null) { runs.push([start, x]); start = null; }
    }
    if (start !== null) runs.push([start, Ws]);
    // merge runs separated by < 8 bg columns (holes inside one figure)
    const tiles2 = [];
    for (const r of runs) {
      if (tiles2.length && r[0] - tiles2[tiles2.length-1][1] < 8) tiles2[tiles2.length-1][1] = r[1];
      else tiles2.push([...r]);
    }
    const wide = tiles2.filter(t => t[1] - t[0] >= 25);
    if (wide.length !== labFigs.length) console.log(`p${page}: WARN found ${wide.length} tiles for ${labFigs.length} figures`);

    const pageTiles = [];
    for (let i = 0; i < Math.min(wide.length, labFigs.length); i++) {
      const [x0, x1] = wide[i];
      const left = Math.max(0, x0 - 4);
      const width = Math.min(Ws - left, (x1 - x0) + 8);
      const slice = await sharp(body).extract({ left, top: 0, width, height: Hs }).png().toBuffer();
      const name = labFigs[i].name || 'UNKNOWN';
      const fname = `fig-p${page}-${name.replace(/[^a-z0-9]/gi, '_')}-${i}.png`;
      fs.writeFileSync(path.join(OUT, fname), slice);
      (perFigure[name] ||= []).push({ page, file: fname, stat: statFor(name) });
      pageTiles.push({ name, file: fname });
    }
    pageRows.push({ page, sheetFile, names: pageTiles.map(x => x.name).join(', ') });
    console.log(`p${page}: sliced ${pageTiles.length} figures `);
  }

  const pageLabel = (p) => p > 0 ? `Page ${p}` : ({ '-1': 'Front cover', '-2': 'Initial page', '-3': 'Back cover' })[String(p)];
  const order = ['Levin', 'Julian', 'Max', 'Kiaan'];
  const names = Object.keys(perFigure).sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0 ? 1 : 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0 ? 1 : 0)));
  let html = `<!doctype html><meta charset="utf-8"><title>SAM cutouts — s9zb960muni</title>
<style>body{font-family:system-ui;background:#1c1e22;color:#eee;margin:20px}
h1{font-size:22px}h2{font-size:19px;border-bottom:1px solid #444;padding-bottom:4px;margin-top:36px}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.cell{background:#26282e;border-radius:6px;padding:6px;text-align:center}
.cell img{max-height:400px;display:block;margin:auto}
.cap{font-size:12px;color:#aaa;margin-top:4px}.cap b{color:#eee}
.sheet img{max-width:100%;margin-top:6px}</style>
<h1>SAM cutouts — ${SID} (Lab experiment #${EXP}, final state)</h1>
<p>Every tile is the actual mask-applied cutout the eval/repair pipeline consumes, sliced from the Lab's per-page cutout sheets.</p>`;
  for (const n of names) {
    const items = perFigure[n].sort((a, b) => (a.page > 0 ? a.page : 100 - a.page) - (b.page > 0 ? b.page : 100 - b.page));
    html += `<h2>${n} — ${items.length} cutouts</h2><div class="row">`;
    for (const it of items) html += `<div class="cell"><img src="${it.file}"><div class="cap"><b>${pageLabel(it.page)}</b><br>${it.stat}</div></div>`;
    html += `</div>`;
  }
  html += `<h2>Per-page sheets (originals)</h2>`;
  for (const r of pageRows.sort((a, b) => (a.page > 0 ? a.page : 100 - a.page) - (b.page > 0 ? b.page : 100 - b.page)))
    html += `<div class="sheet"><b>${pageLabel(r.page)}</b> — ${r.names}<br><img src="${r.sheetFile}"></div>`;
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log('HTML:', path.join(OUT, 'index.html'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
