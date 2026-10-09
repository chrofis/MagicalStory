// Round 3: code compare AND Jev score AND "not explained by another cast member" (V4). Free: reads the cache.
const fs = require('fs'); const D = 'evals/runs/2026-10-09_jev-blind-eval/';
const c = JSON.parse(fs.readFileSync(D + 'garment-answers.json')); const s = JSON.parse(fs.readFileSync(D + 'sample.json')); const L = JSON.parse(fs.readFileSync(D + 'labels.json'));
const raw = JSON.parse(fs.readFileSync(D + 'raw.json'));
const rows = s.filter(r => L[r.n] !== 'U' && c[r.n] && c[r.n].V4 && c[r.n].V1b);
const other = r => { const p = c[r.n].V4.probabilities; let m = 0; c[r.n].V4.names.forEach((n, i) => { if (n !== r.name) m = Math.max(m, p['c' + i] || 0); }); return m; };
const own = r => c[r.n].V4.probabilities['c' + c[r.n].V4.names.indexOf(r.name)] ?? 0;
const colourBad = r => 1 - Math.min(...['V3g', 'V3i'].map(k => c[r.n].V3r2[k].noul));
const colourBad1 = r => 1 - Math.min(...['V3b', 'V3d'].map(k => c[r.n].V3[k].noul));
const sys = {
  'V2>=2 & other<.5': r => (4 - c[r.n].V2.score) >= 2 && other(r) < 0.5,
  'V2>=2 & own<.5 & other<.5': r => (4 - c[r.n].V2.score) >= 2 && own(r) < 0.5 && other(r) < 0.5,
  'colour(R2)>=.5 & V2>=2 & other<.5': r => colourBad(r) >= 0.5 && (4 - c[r.n].V2.score) >= 2 && other(r) < 0.5,
  'colour(R1)>=.7 & V2>=2 & other<.5': r => colourBad1(r) >= 0.7 && (4 - c[r.n].V2.score) >= 2 && other(r) < 0.5,
  'V2b>=2 & other<.5': r => (4 - c[r.n].V2b.score) >= 2 && other(r) < 0.5,
  'V2b>=1.5 & other<.5': r => (4 - c[r.n].V2b.score) >= 1.5 && other(r) < 0.5,
  'V2b>=1 & other<.5': r => (4 - c[r.n].V2b.score) >= 1 && other(r) < 0.5,
};
const out = [];
for (const [k, f] of Object.entries(sys)) {
  const fl = rows.filter(f);
  out.push({ system: k, flagged: fl.length, realTP: fl.filter(r => /^R/.test(L[r.n])).length, fpOnO: fl.filter(r => L[r.n] === 'o').length, fpOnM: fl.filter(r => L[r.n] === 'M').length, missedReal: rows.filter(r => /^R/.test(L[r.n]) && !f(r)).length });
}
console.table(out);
const f = sys['V2b>=1.5 & other<.5']; for (const r of rows.filter(f).slice(0, 12)) console.log('#' + r.n, L[r.n], (4 - c[r.n].V2b.score).toFixed(2), '|', r.inv.clothing.slice(0, 80), '| own', own(r).toFixed(2), 'other', other(r).toFixed(2));
