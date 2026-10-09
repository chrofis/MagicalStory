// confusion matrices + paired comparison vs the AD for the emotion run (see eval-jev-brief-metadata.js)
const path = require('path'); const fs = require('fs');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-brief-metadata');
const { items, pickE } = require('./eval-jev-brief-metadata');
const its = new Map(items().map(x => [x.id, x]));
const rows = fs.readFileSync(path.join(RUN, 'emotion_answers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.rep === 0);
const variant = process.argv[2] || 'E1', kind = process.argv[3] || 'full';
const conf = {}; let both = 0, jevOnly = 0, adOnly = 0, neither = 0;
for (const r of rows.filter(r => r.variant === variant && r.kind === kind)) {
  const it = its.get(r.id); const picks = pickE(variant, it, r.answers);
  it.figs.forEach((f, i) => {
    const k = `${f.label}->${picks[i]}`; conf[k] = (conf[k] || 0) + 1;
    if (f.ad) { const j = picks[i] === f.label, a = f.ad === f.label; if (j && a) both++; else if (j) jevOnly++; else if (a) adOnly++; else neither++; }
  });
}
console.log(variant, kind, 'misses:', Object.entries(conf).filter(([k]) => k.split('->')[0] !== k.split('->')[1]).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('paired vs AD: both right', both, 'Jev only', jevOnly, 'AD only', adOnly, 'neither', neither);
// AD confusion
const adc = {}; let adOpp = 0;
const T = { happy: 'p', sad: 'n', angry: 'n', afraid: 'n', disgusted: 'n' };
for (const it of its.values()) if (it.kind === 'full') for (const f of it.figs) { if (f.ad !== f.label) { const k = `${f.label}->${f.ad}`; adc[k] = (adc[k] || 0) + 1; if (T[f.ad] && T[f.label] && T[f.ad] !== T[f.label]) adOpp++; } }
console.log('AD misses:', Object.entries(adc).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '), 'AD opposite-tone', adOpp);
