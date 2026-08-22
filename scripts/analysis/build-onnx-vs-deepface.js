#!/usr/bin/env node
/**
 * Side-by-side: the same avatar scored by both ArcFace backends.
 *
 * DeepFace (TensorFlow) is the validated one but cannot be deployed — TF>=2.16
 * needs protobuf>=5.28 while the pinned mediapipe==0.10.9 needs protobuf<4.
 * ONNX (onnxruntime) is deployable but currently skips the 5-point landmark
 * alignment DeepFace does internally, and the two rank characters differently
 * (Spearman 0.258). This page shows WHERE they disagree, with the faces, so the
 * disagreement can be judged by eye instead of argued from summary statistics.
 *
 *   node scripts/analysis/build-onnx-vs-deepface.js
 */

const fs = require('fs');
const path = require('path');
const { ch } = require('../lib/chTime');

const DIR = path.join(__dirname, 'test-output');
const OUT = path.join(DIR, 'onnx-vs-deepface.html');

const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).filter(r => r.sheet?.best != null);
const df = load('avatar-likeness-all.json');
const ox = load('avatar-likeness-onnx.json');

const byUrl = new Map(ox.map(r => [r.sheetUrl, r]));
const pairs = df.filter(r => byUrl.has(r.sheetUrl)).map(r => {
  const o = byUrl.get(r.sheetUrl);
  return {
    name: r.name, isDemo: r.isDemo, llm: r.llm,
    df: r.sheet.best, ox: o.sheet.best, diff: r.sheet.best - o.sheet.best,
    src: o.sheet.srcCrop, crop: (o.sheet.cells.find(c => c.q === o.sheet.bestQuadrant) || {}).crop,
  };
});

const band = (s) => (s >= 0.60 ? 'strong' : s >= 0.45 ? 'good' : s >= 0.30 ? 'weak' : 'poor');
const bySpread = [...pairs].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
const groups = [
  { title: 'Biggest disagreements', note: 'Where the deployable backend most contradicts the validated one. These are the cases that make the ONNX numbers untrustworthy until landmark alignment is added.', rows: bySpread.slice(0, 8) },
  { title: 'Closest agreement', note: 'Where both backends agree — what the whole set should look like once alignment is fixed.', rows: [...bySpread].reverse().slice(0, 8) },
  { title: 'Worst by DeepFace (the validated ranking)', note: 'The current 0.45 gate is set against this column. Manuel is the genuine failure — a teenager rendered as an adult.', rows: [...pairs].sort((a, b) => a.df - b.df).slice(0, 8) },
];

const card = (p) => `
  <div class="card">
    <div class="pair">
      <figure><img src="${p.src}"><figcaption>source</figcaption></figure>
      <figure><img src="${p.crop}"><figcaption>avatar</figcaption></figure>
    </div>
    <b>${p.name}</b>${p.isDemo ? ' <small>[showcase]</small>' : ''}
    <table>
      <tr><td>DeepFace</td><td class="${band(p.df)}"><b>${p.df.toFixed(3)}</b></td></tr>
      <tr><td>ONNX</td><td class="${band(p.ox)}"><b>${p.ox.toFixed(3)}</b></td></tr>
      <tr><td>judge</td><td>${p.llm ?? '—'}/10</td></tr>
    </table>
    <small class="diff ${Math.abs(p.diff) > 0.25 ? 'big' : ''}">Δ ${p.diff >= 0 ? '+' : ''}${p.diff.toFixed(3)}</small>
  </div>`;

const stat = (v) => { const s = [...v].sort((a, b) => a - b); return `min ${s[0].toFixed(3)} · median ${s[Math.floor(s.length / 2)].toFixed(3)} · max ${s[s.length - 1].toFixed(3)}`; };

fs.writeFileSync(OUT, `<!doctype html><meta charset="utf-8"><title>ONNX vs DeepFace — ArcFace backends</title>
<style>
 body{font:14px/1.6 system-ui;margin:26px;background:#fafafa;color:#1f2937}
 h1{font-size:21px;margin-bottom:2px} h2{font-size:16px;margin:26px 0 4px}
 .note{color:#6b7280;font-size:13px;margin-bottom:12px}
 .grid{display:flex;gap:14px;flex-wrap:wrap}
 .card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px;width:210px}
 .pair{display:flex;gap:8px;margin-bottom:8px}
 figure{margin:0;flex:1} figcaption{font-size:10px;color:#9ca3af;text-align:center}
 img{width:100%;height:auto;border-radius:6px;display:block;background:#f3f4f6}
 table{width:100%;font-size:12px;margin-top:4px;border-collapse:collapse}
 td{padding:1px 0} td:last-child{text-align:right}
 .strong{color:#15803d}.good{color:#65a30d}.weak{color:#b45309}.poor{color:#b91c1c}
 .diff{color:#9ca3af;font-size:11px}.diff.big{color:#b91c1c;font-weight:700}
 .legend{background:#fff;border-left:3px solid #6366f1;padding:12px 16px;margin-bottom:20px;font-size:13px}
 code{background:#f3f4f6;padding:1px 4px;border-radius:3px}
</style>
<h1>ArcFace backends — validated vs deployable</h1>
<div class="note">${pairs.length} avatars scored by both · ${ch(new Date())}</div>
<div class="legend">
 <b>DeepFace (TensorFlow)</b> — ${stat(pairs.map(p => p.df))}. Validated: it catches the real failure
 and, with alignment, rescued a good avatar from a false 0.027. <b>Cannot be deployed</b>: TF≥2.16 needs
 protobuf≥5.28, the pinned <code>mediapipe==0.10.9</code> needs protobuf&lt;4.<br>
 <b>ONNX (onnxruntime)</b> — ${stat(pairs.map(p => p.ox))}. Deployable today, no framework, no conflict.
 But it currently skips the 5-point landmark alignment DeepFace does internally, and the two orderings
 correlate at only <b>0.258</b> (Spearman) — a scale shift would be ~0.95. So this is a different
 measurement, not a rescaled one, and <b>0.45 cannot simply be moved</b> onto it.
</div>
${groups.map(g => `<h2>${g.title}</h2><div class="note">${g.note}</div><div class="grid">${g.rows.map(card).join('')}</div>`).join('')}
`);

console.log(`Wrote ${OUT}`);
console.log(`DeepFace: ${stat(pairs.map(p => p.df))}`);
console.log(`ONNX    : ${stat(pairs.map(p => p.ox))}`);
