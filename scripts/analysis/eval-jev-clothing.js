#!/usr/bin/env node
/**
 * Jev vs the code check for "does the scene prose dress this character in the contract outfit"
 * (the deleted clothingCheck.missingGarments). Reads the labelled stored pages (jev-clothing-labels.json, labels written by
 * reading, 2026-10-09; cases.json from jev-clothing-extract.js) and asks Jev several phrasings per page.
 *   node scripts/analysis/eval-jev-clothing.js [--capUsd=0.30] [--only=A,B]
 * Paid: ~140 Jev calls per run, USD ~0.006.
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { callJev } = require('../../server/lib/jevAudit');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.30').split('=')[1]);
const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];

// Each variant: the Jev question and how its answer becomes P(the outfit is stated).
const noul = (fn, flip = false) => ({ q: fn, read: a => (flip ? 1 - a.noul : a.noul) });
const VARIANTS = {
  A: noul(c => ({ type: 'noul', instructions: `In this text, ${c.name} is described wearing this outfit: ${c.outfit}` })),
  B: noul(c => ({ type: 'noul', instructions: `The text says what ${c.name} wears, and it is the same clothing as: ${c.outfit}` })),
  C: noul(c => ({ type: 'noul', instructions: `The text describes the clothing that ${c.name} wears.` })),
  D: noul(c => ({ type: 'noul', instructions: `Someone in the text is dressed in: ${c.outfit}` })),
  F: noul(c => ({ type: 'noul', instructions: `The text does not mention any clothing of ${c.name}.` }), true),
  G: noul(c => ({ type: 'noul', instructions: `A reader of the text alone could draw what ${c.name} wears.` })),
  H: noul(c => ({ type: 'noul', instructions: `The text says ${c.name} is in a costume or a named outfit.` })),
  // E3: the same choice without relying on the name (briefs often describe a character without naming them)
  E3: { q: c => ({ type: 'choice', instructions: 'What the text says about the clothing of the people in it.', criteria: { s0: `somebody wears this outfit: ${c.outfit}`, s1: 'the people wear other clothing than that outfit', s2: 'the text gives no clothing for anybody' } }), read: a => a.probabilities.s0 },
  // E4: E with a note that the text may not use the name
  E4: { q: c => ({ type: 'choice', instructions: `What the text says ${c.name} wears. The text may describe ${c.name} without using the name.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'clothing that differs from that outfit', s2: 'nothing, the text does not say' } }), read: a => a.probabilities.s0 },
  // E2: as E, with a separate option for a costume named but not described garment by garment
  E2: { q: c => ({ type: 'choice', instructions: `What the text says ${c.name} wears.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'a costume or outfit by name, without listing its garments', s2: 'clothing that differs from that outfit', s3: 'nothing, the text does not say' } }), read: a => a.probabilities.s0 + a.probabilities.s1 },
  // E: a choice over what the text says the character wears
  E: { q: c => ({ type: 'choice', instructions: `What the text says ${c.name} wears.`, criteria: { s0: `the clothing of this outfit: ${c.outfit}`, s1: 'clothing that differs from that outfit', s2: 'nothing, the text does not say' } }), read: a => a.probabilities.s0 },
};

function auc(pos, neg) { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); }

(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(RUN, 'cases.json'), 'utf8'));
  const labels = JSON.parse(fs.readFileSync(path.join(__dirname, 'jev-clothing-labels.json'), 'utf8'));
  const byKey = new Map(cases.map(c => [`${c.sid}:${c.page}:${c.name}`, c]));
  const rows = labels.map(l => ({ ...l, c: byKey.get(l.key) })).filter(r => r.c);
  const ids = Object.keys(VARIANTS).filter(v => !only || only.split(',').includes(v));
  const ansFile = path.join(RUN, 'answers.jsonl');
  const have = new Map();
  if (fs.existsSync(ansFile)) for (const l of fs.readFileSync(ansFile, 'utf8').split('\n').filter(Boolean)) { const o = JSON.parse(l); have.set(o.key + '|' + o.v, o); }
  let cost = 0;
  for (const r of rows) {
    for (const v of ids) {
      const k = r.key + '|' + v;
      if (have.has(k)) continue;
      if (cost > cap) { console.error('cap reached', cost); process.exit(2); }
      const res = await callJev({ state: r.c.prose, questions: { q: VARIANTS[v].q(r.c) } });
      cost += res.cost;
      const o = { key: r.key, v, p: VARIANTS[v].read(res.answers.q) };
      fs.appendFileSync(ansFile, JSON.stringify(o) + '\n'); have.set(k, o);
    }
  }
  console.log('cost this run USD', cost.toFixed(5));
  const pos = rows.filter(r => r.label === 1), neg = rows.filter(r => r.label === 0);
  console.log(`labelled: ${pos.length} missing, ${neg.length} stated.`);
  if (rows.every(r => Array.isArray(r.c.old))) {
    const oldPosHit = pos.filter(r => r.c.old.length).length, oldNegFire = neg.filter(r => r.c.old.length).length;
    console.log(`OLD missingGarments (deleted): caught ${oldPosHit}/${pos.length}, false alarms ${oldNegFire}/${neg.length}`);
  }
  for (const v of ids) {
    const sc = r => 1 - have.get(r.key + '|' + v).p; // higher = more likely missing
    const a = auc(pos.map(sc), neg.map(sc));
    let best = null;
    for (let t = 0.05; t < 1; t += 0.05) {
      const tp = pos.filter(r => sc(r) >= t).length, fp = neg.filter(r => sc(r) >= t).length;
      const acc = (tp + neg.length - fp) / rows.length;
      if (!best || acc > best.acc) best = { t: +t.toFixed(2), tp, fp, acc };
    }
    console.log(`${v}: AUC ${a.toFixed(3)}  best threshold P(dressed)<=${(1 - best.t).toFixed(2)}: caught ${best.tp}/${pos.length}, false alarms ${best.fp}/${neg.length}, acc ${(100 * best.acc).toFixed(1)}%`);
  }
})().catch(e => { console.error(e); process.exit(1); });
