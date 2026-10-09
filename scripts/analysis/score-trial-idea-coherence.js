/**
 * Scores a run of eval-trial-idea-coherence.js against hand labels, and (with --jev)
 * runs the shared Jev coherence check over its final ideas to compare Jev with the labels.
 *   node scripts/analysis/score-trial-idea-coherence.js <out.json> <labels.json> [--jev]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const [outFile, labelFile] = process.argv.slice(2);
const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
const labels = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
const withJev = process.argv.includes('--jev');

(async () => {
  const { judgeCoherence } = require(path.join(ROOT, 'server/lib/ideaCoherence'));
  const rows = [];
  for (const r of out.rows) for (const arm of Object.keys(r.cards)) {
    const id = `${r.cell.id}.${arm}`;
    const idea = r.cards[arm].final;
    const lab = labels[id];
    if (!idea || !lab) continue;
    let jev = null;
    if (withJev) jev = await judgeCoherence(idea, { topic: r.cell.category === 'life-challenge' ? r.cell.topic : '', theme: r.cell.theme });
    rows.push({ id, idea, lab, jev });
  }
  const rate = (f) => { const xs = rows.filter(f.where || (() => true)); const n = xs.filter(f.pass).length; return `${n}/${xs.length}`; };
  console.log('forced   yes:', rate({ where: x => x.lab.forced !== null, pass: x => x.lab.forced }));
  console.log('follows  yes:', rate({ pass: x => x.lab.follows }));
  console.log('both ok     :', rate({ pass: x => x.lab.follows && x.lab.forced !== false }));
  if (withJev) {
    for (const q of ['forced', 'follows']) {
      const xs = rows.filter(x => x.jev && x.jev[q] !== undefined && x.lab[q] !== null);
      const pts = xs.map(x => ({ p: x.jev[q], good: x.lab[q] }));
      console.log(`\nJev ${q}: P(yes) of good vs bad labels`);
      console.log(' good:', pts.filter(x => x.good).map(x => x.p.toFixed(2)).join(' '));
      console.log(' bad :', pts.filter(x => !x.good).map(x => x.p.toFixed(2)).join(' '));
      for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
        const flagged = pts.filter(x => x.p < t); const tp = flagged.filter(x => !x.good).length;
        const bad = pts.filter(x => !x.good).length;
        console.log(` t=${t}: flags ${flagged.length}, precision ${flagged.length ? (tp / flagged.length).toFixed(2) : '-'}, recall ${bad ? (tp / bad).toFixed(2) : '-'}`);
      }
    }
    console.log('\ncost', rows.reduce((s, x) => s + x.jev.cost, 0), 'mean ms', Math.round(rows.reduce((s, x) => s + x.jev.ms, 0) / rows.length));
    fs.writeFileSync(outFile.replace(/out\.json$/, 'jev-scores.json'), JSON.stringify(rows.map(x => ({ id: x.id, lab: x.lab, jev: x.jev })), null, 1));
  }
})().catch(e => { console.error(e); process.exit(1); });
