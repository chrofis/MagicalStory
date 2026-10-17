#!/usr/bin/env node
/**
 * Jev measurement of the "object description names a support" rate (docs/decisions.md 2026-10-17).
 * One noul per stored Visual Bible object description, judged against the hand labels in
 * evals/runs/2026-10-17_vb-object-not-placed/labels.json. Measurement only: no pipeline check is built from it.
 *   node scripts/analysis/eval-jev-object-placement.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { callJev } = require('../../server/lib/jevAudit');
const RUN = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-10-17_vb-object-not-placed');
const Q = 'This description says where the object is or what separate thing it rests on, leans against, hangs from or points toward, rather than only what the object looks like.';

async function main() {
  const labels = JSON.parse(fs.readFileSync(path.join(RUN, 'labels.json'), 'utf8'));
  const descs = labels.allUnique;
  const scores = {};
  let cost = 0, next = 0;
  async function worker() {
    while (next < descs.length) {
      const d = descs[next++];
      const r = await callJev({ state: `Description of one object in a children's picture book: ${d}`, questions: { PLACED: { type: 'noul', instructions: Q } } });
      scores[d] = r.answers.PLACED.noul; cost += r.cost;
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  fs.writeFileSync(path.join(RUN, 'jev-scores.json'), JSON.stringify({ question: Q, cost, scores }, null, 1));
  console.log('calls', descs.length, 'cost', cost.toFixed(5));
}
main().then(() => process.exit(0)).catch(e => { console.error('FAILED', e.message); process.exit(1); });
