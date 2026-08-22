#!/usr/bin/env node
/**
 * Top-N and bottom-N by EACH backend, side by side, with the faces.
 *
 * The point is to judge the two rankings against each other by eye: where they
 * agree, and which one is wrong where they don't. Every card shows both scores,
 * so a face in ONNX's bottom 10 also shows what DeepFace thought of it.
 *
 *   node scripts/analysis/build-top-bottom.js [--n=10]
 */

const fs = require('fs');
const path = require('path');
const { ch } = require('../lib/chTime');

const N = parseInt((process.argv.find(a => a.startsWith('--n=')) || '--n=10').split('=')[1], 10);
const DIR = path.join(__dirname, 'test-output');
const OUT = path.join(DIR, 'top-bottom-both.html');

const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).filter(r => r.sheet?.best != null);
const df = load('avatar-likeness-all.json');
const ox = load('avatar-likeness-onnx.json');
const oxByUrl = new Map(ox.map(r => [r.sheetUrl, r]));

const rows = df.filter(r => oxByUrl.has(r.sheetUrl)).map(r => {
  const o = oxByUrl.get(r.sheetUrl);
  return {
    name: r.name.trim(), isDemo: r.isDemo, llm: r.llm,
    df: r.sheet.best, ox: o.sheet.best,
    src: o.sheet.srcCrop,
    crop: (o.sheet.cells.find(c => c.q === o.sheet.bestQuadrant) || {}).crop,
  };
});

const card = (r, primary) => `
  <div class="card">
    <div class="pair">
      <figure><img src="${r.src}"><figcaption>photo</figcaption></figure>
      <figure><img src="${r.crop}"><figcaption>avatar</figcaption></figure>
    </div>
    <b>${r.name}</b>${r.isDemo ? ' <small>[showcase]</small>' : ''}
    <table>
      <tr class="${primary === 'ox' ? 'hi' : ''}"><td>ONNX</td><td>${r.ox.toFixed(3)}</td></tr>
      <tr class="${primary === 'df' ? 'hi' : ''}"><td>DeepFace</td><td>${r.df.toFixed(3)}</td></tr>
      <tr class="dim"><td>judge</td><td>${r.llm ?? '—'}/10</td></tr>
    </table>
  </div>`;

const section = (title, note, list, primary) =>
  `<h2>${title}</h2><div class="note">${note}</div><div class="grid">${list.map(r => card(r, primary)).join('')}</div>`;

const byOx = [...rows].sort((a, b) => b.ox - a.ox);
const byDf = [...rows].sort((a, b) => b.df - a.df);

fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8"><title>Top / bottom by each backend</title>
<style>
 body{font:14px/1.6 system-ui;margin:26px;background:#fafafa;color:#1f2937}
 h1{font-size:21px;margin-bottom:2px} h2{font-size:16px;margin:28px 0 4px}
 .note{color:#6b7280;font-size:13px;margin-bottom:10px}
 .grid{display:flex;gap:12px;flex-wrap:wrap}
 .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:9px;width:190px}
 .pair{display:flex;gap:6px;margin-bottom:7px}
 figure{margin:0;flex:1} figcaption{font-size:10px;color:#9ca3af;text-align:center}
 img{width:100%;height:auto;border-radius:5px;display:block;background:#f3f4f6}
 table{width:100%;font-size:12px;border-collapse:collapse;margin-top:3px}
 td{padding:0} td:last-child{text-align:right;font-variant-numeric:tabular-nums}
 tr.hi{font-weight:700;color:#3730a3} tr.dim{color:#9ca3af}
 .legend{background:#fff;border-left:3px solid #6366f1;padding:12px 16px;margin-bottom:18px;font-size:13px}
</style>
<h1>Top ${N} and bottom ${N} — both backends</h1>
<div class="note">${rows.length} avatars · ${ch(new Date())}</div>
<div class="legend">
 Both scores are shown on every card; the <b>bold</b> row is the one that section is ranked by.
 Where a face sits in one backend's bottom ${N} but scores well on the other, one of the two is wrong —
 those are the cards worth looking at hardest. Both are ArcFace but different trained checkpoints
 (DeepFace vs insightface buffalo_l), so absolute values are not comparable between backends; only
 the ordering within a column is.
</div>
${section(`ONNX — top ${N}`, 'Highest by the deployable backend.', byOx.slice(0, N), 'ox')}
${section(`ONNX — bottom ${N}`, 'Lowest by the deployable backend. These are the ones a gate on ONNX would regenerate.', byOx.slice(-N).reverse(), 'ox')}
${section(`DeepFace — top ${N}`, 'Highest by the validated backend.', byDf.slice(0, N), 'df')}
${section(`DeepFace — bottom ${N}`, 'Lowest by the validated backend.', byDf.slice(-N).reverse(), 'df')}
`);

console.log(`Wrote ${OUT}\n`);
const line = (r) => `  ${r.name.padEnd(13)}${(r.isDemo ? '[demo]' : '').padEnd(7)} onnx ${r.ox.toFixed(3).padStart(6)}  deepface ${r.df.toFixed(3).padStart(6)}  judge ${r.llm ?? '-'}/10`;
console.log(`ONNX bottom ${N}:`); byOx.slice(-N).reverse().forEach(r => console.log(line(r)));
console.log(`\nDeepFace bottom ${N}:`); byDf.slice(-N).reverse().forEach(r => console.log(line(r)));
console.log(`\nONNX top 5:`); byOx.slice(0, 5).forEach(r => console.log(line(r)));
console.log(`\nDeepFace top 5:`); byDf.slice(0, 5).forEach(r => console.log(line(r)));
