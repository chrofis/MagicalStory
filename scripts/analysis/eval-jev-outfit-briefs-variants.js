#!/usr/bin/env node
/**
 * Question variants on the hand-labelled Art Director briefs (characters described without their name):
 * is the contract outfit stated? Labels read 2026-10-09 from the 38 briefs the shipped question flagged
 * (M = outfit missing, S = outfit stated; ambiguous ones left out).
 *   node scripts/analysis/eval-jev-outfit-briefs-variants.js [--capUsd=0.05]
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { callJev } = require('../../server/lib/jevAudit');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-outfit-briefs');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);
const M = [186, 187, 194, 195, 199, 200, 201];
const S = [9, 13, 14, 15, 90, 92, 96, 101, 102, 103, 112, 114, 124, 133, 137, 138, 139, 148, 150, 151, 152, 165, 197];
const V = {
  E: c => ({ type: 'choice', instructions: `What the text says ${c.name} wears.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'clothing that differs from that outfit', s2: 'nothing, the text does not say' } }),
  E3: c => ({ type: 'choice', instructions: 'What the text says about the clothing of the people in it.', criteria: { s0: `somebody wears this outfit: ${c.outfit}`, s1: 'the people wear other clothing than that outfit', s2: 'the text gives no clothing for anybody' } }),
  D: c => ({ type: 'noul', instructions: `Someone in the text is dressed in: ${c.outfit}` }),
};
const read = (v, a) => (v === 'D' ? a.noul : a.probabilities.s0);
const auc = (p, n) => { let w = 0; for (const x of p) for (const y of n) w += x > y ? 1 : x === y ? 0.5 : 0; return w / (p.length * n.length); };
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(RUN, 'cases.json'), 'utf8'));
  let cost = 0; const res = {};
  for (const i of [...M, ...S]) for (const v of Object.keys(V)) {
    if (cost > cap) throw new Error('cap');
    const c = cases[i]; const r = await callJev({ state: c.prose, questions: { q: V[v](c) } });
    cost += r.cost; (res[v] = res[v] || {})[i] = read(v, r.answers.q);
  }
  console.log('cost USD', cost.toFixed(5));
  for (const v of Object.keys(V)) {
    const t = [0.1, 0.3, 0.5].map(th => `<${th}: caught ${M.filter(i => res[v][i] < th).length}/${M.length}, false ${S.filter(i => res[v][i] < th).length}/${S.length}`);
    console.log(`${v}: AUC(missing=low) ${auc(S.map(i => res[v][i]), M.map(i => res[v][i])).toFixed(3)} | ${t.join(' | ')}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
