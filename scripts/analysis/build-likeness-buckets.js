#!/usr/bin/env node
/**
 * Curated view of an avatar-likeness audit: the N best, N mid, and N worst
 * characters side by side, so likeness can be judged by eye against the number.
 *
 * Reads the JSON written by audit-avatar-likeness.js — no ArcFace re-run.
 *
 * Crops are cut with sharp at their true pixel geometry and written to disk.
 * An earlier version painted the cell as a CSS background at 200%/200% inside a
 * square box: each cell is 360x640, so it was squashed ~2x horizontally and the
 * comparison was worthless.
 *
 *   node scripts/analysis/build-likeness-buckets.js [--n=3]
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { ch } = require('../lib/chTime');

const N = parseInt((process.argv.find(a => a.startsWith('--n=')) || '--n=3').split('=')[1], 10);
const DIR = path.join(__dirname, 'test-output');
const IN = path.join(DIR, 'avatar-likeness-audit.json');
const CROPS = path.join(DIR, 'likeness-crops');
const OUT = path.join(DIR, 'avatar-likeness-buckets.html');

const QUAD_INDEX = { 'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1] };

const band = (s) => (s >= 0.60 ? 'strong' : s >= 0.45 ? 'good' : s >= 0.30 ? 'weak' : 'poor');
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

async function fetchBuf(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 60)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Cut one cell out of the 2x2 sheet at its real geometry. */
async function cropCell(sheetUrl, quadrant, outFile) {
  const buf = await fetchBuf(sheetUrl);
  const img = sharp(buf);
  const { width, height } = await img.metadata();
  const [cx, cy] = QUAD_INDEX[quadrant] || [0, 0];
  const w = Math.floor(width / 2);
  const h = Math.floor(height / 2);
  await sharp(buf).extract({ left: cx * w, top: cy * h, width: w, height: h }).toFile(outFile);
  return { w, h };
}

(async () => {
  const all = JSON.parse(fs.readFileSync(IN, 'utf8'))
    .filter(r => r.sheet?.best != null)
    .sort((a, b) => b.sheet.best - a.sheet.best);

  if (all.length < N * 3) {
    console.error(`Need at least ${N * 3} scored characters, have ${all.length}.`);
    process.exit(1);
  }

  fs.mkdirSync(CROPS, { recursive: true });
  const mid = Math.floor(all.length / 2);
  const buckets = [
    { title: `Best ${N}`, note: 'Strongest head-view match.', rows: all.slice(0, N) },
    { title: `Middle ${N}`, note: 'The median experience.', rows: all.slice(mid - Math.floor(N / 2), mid - Math.floor(N / 2) + N) },
    { title: `Worst ${N}`, note: 'Weakest match — the ones a parent would call "fehlende Ähnlichkeit".', rows: all.slice(-N).reverse() },
  ];

  for (const b of buckets) {
    for (const r of b.rows) {
      try {
        const f = path.join(CROPS, `${slug(r.name)}-${r.sheet.bestQuadrant}.jpg`);
        const dim = await cropCell(r.sheetUrl, r.sheet.bestQuadrant, f);
        r._crop = path.relative(DIR, f).replace(/\\/g, '/');
        r._dim = dim;
        const pf = path.join(CROPS, `${slug(r.name)}-photo.jpg`);
        fs.writeFileSync(pf, await fetchBuf(r.photoUrl));
        r._photo = path.relative(DIR, pf).replace(/\\/g, '/');
      } catch (e) {
        console.error(`  crop failed for ${r.name}: ${e.message}`);
      }
    }
  }

  const card = (r) => `
  <div class="card ${band(r.sheet.best)}">
    <div class="pair">
      <figure><img src="${r._photo || r.photoUrl}"><figcaption>source photo</figcaption></figure>
      <figure><img src="${r._crop || ''}"><figcaption>avatar · ${r.sheet.bestQuadrant}</figcaption></figure>
    </div>
    <div class="meta">
      <b>${r.name}</b>
      <div class="scores">
        <span class="arc">ArcFace <b>${r.sheet.best.toFixed(3)}</b></span>
        <span class="llm">judge ${r.llm ?? '—'}/10</span>
      </div>
      <small>other head view ${r.sheet.second?.toFixed(3) ?? '—'} · ${ch(new Date(r.createdAt))}</small>
    </div>
  </div>`;

  fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8">
<title>Avatar likeness — best / average / worst</title>
<style>
 body{font:14px/1.6 system-ui;margin:28px;color:#1f2937;background:#fafafa}
 h1{font-size:22px;margin-bottom:4px} h2{font-size:17px;margin:30px 0 4px}
 .sub{color:#6b7280;margin-bottom:20px}
 .note{color:#6b7280;margin-bottom:12px;font-size:13px}
 .grid{display:flex;gap:16px;flex-wrap:wrap}
 .card{border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:12px;width:330px}
 .card.strong{border-top:4px solid #16a34a}.card.good{border-top:4px solid #84cc16}
 .card.weak{border-top:4px solid #f59e0b}.card.poor{border-top:4px solid #dc2626}
 .pair{display:flex;gap:10px;align-items:flex-start}
 figure{margin:0;flex:1}
 figcaption{font-size:11px;color:#9ca3af;text-align:center;margin-top:4px}
 /* height:auto — never force an aspect ratio onto either image */
 img{width:100%;height:auto;border-radius:6px;display:block;background:#f3f4f6}
 .meta{margin-top:10px}
 .scores{display:flex;gap:8px;margin:4px 0}
 .arc{background:#eef2ff;color:#3730a3;padding:1px 8px;border-radius:20px;font-size:12px}
 .llm{background:#f3f4f6;color:#4b5563;padding:1px 8px;border-radius:20px;font-size:12px}
 small{color:#9ca3af;font-size:11px}
 .legend{background:#fff;border-left:3px solid #6366f1;padding:12px 16px;margin-bottom:22px;font-size:13px}
</style>
<h1>Avatar likeness — best, average, worst</h1>
<div class="sub">${all.length} real user characters (demo accounts excluded) · ${ch(new Date())}</div>
<div class="legend">
 Only the two <b>head</b> cells of the sheet are compared. The bottom row is full-body: the head
 is a small part of a 360×640 crop, and the profile view cannot be embedded by a frontal model at
 all — comparing those was measuring torso and background, not identity.
 Both images below are cut at their true pixel geometry and shown unstretched.
 Bands: strong ≥0.60, good ≥0.45, weak ≥0.30, poor below.
</div>
${buckets.map(b => `<h2>${b.title}</h2><div class="note">${b.note}</div><div class="grid">${b.rows.map(card).join('')}</div>`).join('')}
`);

  console.log(`Wrote ${OUT}`);
  buckets.forEach(b => {
    console.log(`\n${b.title}:`);
    b.rows.forEach(r => console.log(`  ${String(r.name).padEnd(14)} arcface ${r.sheet.best.toFixed(3)}  judge ${r.llm ?? '-'}/10  (${r.sheet.bestQuadrant} ${r._dim ? r._dim.w + 'x' + r._dim.h : '?'})`));
  });
})();
