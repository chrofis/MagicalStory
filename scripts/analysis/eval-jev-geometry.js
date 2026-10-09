#!/usr/bin/env node
/**
 * Jev vs the code filter (sceneGeometry.isClean + ELIDED_SUBJECT_RE) for "does this clause of scene prose mention a
 * figure". Labels were written by reading each unit (FIGURE = a person, a creature, someone's body or clothing, a
 * pronoun for them, or what a figure does; amb = excluded). Units: jev-geometry-units.js.
 *   node scripts/analysis/eval-jev-geometry.js [--capUsd=0.20]
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { callJev } = require('../../server/lib/jevAudit');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-geometry');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.20').split('=')[1]);
const FIGURE = new Set([0,2,3,4,5,6,7,12,13,14,15,16,20,21,22,23,24,25,31,33,34,35,36,41,42,46,47,48,49,50,51,52,54,55,56,57,58,59,60,61,63,65,67,69,70,72,75,77,78,79,84,86,87,88,89,90,91,92,93,94,95,96,98,99,101,102,103,106,108,110,111,112,113,114,115,116]);
const AMB = new Set([120]);
const STATE = {
  J1: u => u.unit,
  J2: u => u.pageProse,
};
const Q = {
  J1: () => 'This text mentions a person, a creature, someone\'s body or clothing, or something a person does.',
  J2: u => `This passage of the text mentions a person, a creature, someone's body or clothing, or something a person does: "${u.unit}"`,
};
function auc(pos, neg) { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); }
(async () => {
  const units = JSON.parse(fs.readFileSync(path.join(RUN, 'units.json'), 'utf8')).filter(u => !AMB.has(u.id));
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing/cases.json'), 'utf8'));
  const prose = new Map(cases.map(c => [`${c.sid}:${c.page}`, c.prose]));
  units.forEach(u => { u.pageProse = prose.get(`${u.sid}:${u.page}`); u.fig = FIGURE.has(u.id) ? 1 : 0; });
  const ansFile = path.join(RUN, 'answers.jsonl'); const have = new Map();
  if (fs.existsSync(ansFile)) for (const l of fs.readFileSync(ansFile, 'utf8').split('\n').filter(Boolean)) { const o = JSON.parse(l); have.set(o.id + '|' + o.v, o.p); }
  let cost = 0;
  for (const u of units) for (const v of Object.keys(Q)) {
    if (have.has(u.id + '|' + v)) continue;
    if (cost > cap) { console.error('cap reached'); process.exit(2); }
    const r = await callJev({ state: STATE[v](u), questions: { q: { type: 'noul', instructions: Q[v](u) } } });
    cost += r.cost; have.set(u.id + '|' + v, r.answers.q.noul);
    fs.appendFileSync(ansFile, JSON.stringify({ id: u.id, v, p: r.answers.q.noul }) + '\n');
  }
  console.log('cost this run USD', cost.toFixed(5));
  const fig = units.filter(u => u.fig), free = units.filter(u => !u.fig);
  console.log(`units ${units.length}: figure-bearing ${fig.length}, people-free ${free.length}`);
  // code says "people-free" = codeClean. LEAK = figure unit passed as clean; LOSS = people-free unit dropped.
  console.log(`CODE: leak ${fig.filter(u => u.codeClean).length}/${fig.length}, loss ${free.filter(u => !u.codeClean).length}/${free.length}`);
  for (const v of Object.keys(Q)) {
    const a = auc(fig.map(u => have.get(u.id + '|' + v)), free.map(u => have.get(u.id + '|' + v)));
    const row = [0.1, 0.2, 0.3, 0.5].map(t => `P>=${t}: leak ${fig.filter(u => have.get(u.id + '|' + v) < t).length}/${fig.length} loss ${free.filter(u => have.get(u.id + '|' + v) >= t).length}/${free.length}`);
    console.log(`${v}: AUC ${a.toFixed(3)} | ${row.join(' | ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
