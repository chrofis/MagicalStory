/** Age check: code-only numeric compare vs Jev noul/score vs the blind judge (character_identity/scale findings that name age).
 *  node scripts/analysis/eval-jev-blind-age.js run|score   (run is paid, ~$0.01) */
require('dotenv').config();
const fs = require('fs'); const { callJev } = require('../../server/lib/jevAudit');
const D = 'evals/runs/2026-10-09_jev-blind-eval/';
const s = JSON.parse(fs.readFileSync(D + 'sample.json')); const L = JSON.parse(fs.readFileSync(D + 'labels.json')); const AGE = new Set(JSON.parse(fs.readFileSync(D + 'labels-age.json')));
const CACHE = D + 'age-answers.json'; const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE)) : {};
const rows = s.filter(r => L[r.n] !== 'M' && L[r.n] !== 'U' && r.expAge != null && r.inv.apparent_age != null && r.inv.apparent_age !== 'cannot tell');
const num = v => { const m = String(v).match(/(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/); return m ? (m[2] ? (+m[1] + +m[2]) / 2 : +m[1]) : NaN; };
const state = r => `EXPECTED AGE of ${r.name}: ${r.expAge} years old.\nAGE ESTIMATE of the figure (blind, from proportions): ${r.inv.age_group}, about ${r.inv.apparent_age} years.`;
const Q = {
  A1: { type: 'noul', instructions: 'The age estimate is far from the expected age: a child estimated as an adult or teenager, an adult estimated as a child, or an estimate more than about twice the expected age. A difference of a few years is not far.' },
  A2: { type: 'score', instructions: 'How far is the age estimate from the expected age, as a reader of the picture would see it?', criteria: ['the same age or within a year or two', 'a few years off', 'clearly a different age band', 'a child where an adult is expected, or the reverse'] },
};
const code = r => { const a = num(r.inv.apparent_age), e = r.expAge; const grp = /adult|elderly|teen/.test(r.inv.age_group) && e < 13; return grp || (Math.abs(a - e) >= 4 && (a / e >= 1.8 || e / a >= 1.8)); };
async function run() { let cost = 0, calls = 0; for (const r of rows) { cache[r.n] ||= {}; for (const id of ['A1', 'A2']) if (!cache[r.n][id]) { const a = await callJev({ state: state(r), questions: { [id]: Q[id] } }); cost += a.cost; calls++; cache[r.n][id] = a.answers[id]; } } fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log({ calls, cost }); }
function score() {
  const y = r => AGE.has(r.n);
  const rep = (name, f) => { const fl = rows.filter(f); console.log(name, { flagged: fl.length, tp: fl.filter(y).length, fp: fl.filter(r => !y(r)).length, fn: rows.filter(r => y(r) && !f(r)).length }); return fl; };
  console.log('rows', rows.length, 'real age', rows.filter(y).length);
  const fl = rep('code', code); fl.filter(r => !y(r)).forEach(r => console.log('  code FP #' + r.n, r.name, 'exp', r.expAge, r.inv.age_group, r.inv.apparent_age));
  rep('jev A1>=.5', r => cache[r.n].A1.noul >= 0.5); rep('jev A1>=.8', r => cache[r.n].A1.noul >= 0.8);
  rep('jev A2>=1.5', r => cache[r.n].A2.score >= 1.5); rep('jev A2>=2', r => cache[r.n].A2.score >= 2);
  const jf = r => r.blind.some(b => (b.type === 'scale' || b.type === 'character_identity') && /\bage|year|teen|adult|child/i.test(b.d)); rep('blind judge (identity|scale naming age)', jf);
  const auc = (f) => { let w = 0, n = 0; for (const p of rows.filter(y)) for (const q of rows.filter(r => !y(r))) { n++; w += f(p) > f(q) ? 1 : f(p) === f(q) ? .5 : 0; } return +(w / n).toFixed(3); };
  console.log('AUC A1', auc(r => cache[r.n].A1.noul), 'A2', auc(r => cache[r.n].A2.score), 'code(|a-e|/e)', auc(r => Math.abs(num(r.inv.apparent_age) - r.expAge) / r.expAge));
}
({ run, score })[process.argv[2]]?.() || console.log('usage: run|score');
