#!/usr/bin/env node
/**
 * Jev as the decider of "is this roster member actually DRAWN on this page, or only named in the brief"
 * (bug garment-owner-name-enters-page-cast, owner 2026-11-04: "Do a Jev review of the page to check this").
 * Cases from scripts/analysis/extract-garment-owner-cases.js; labels come from the typed fields
 * (metadata characters[] / plan who column), the state is the brief PROSE only.
 *
 *   node --max-old-space-size=1024 scripts/analysis/eval-jev-page-presence.js run   [--capUsd=0.10]
 *   node --max-old-space-size=1024 scripts/analysis/eval-jev-page-presence.js score
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const RUN = path.join(ROOT, 'evals/runs/2026-11-04_garment-owner-jev');
const ANS = path.join(RUN, 'answers.jsonl');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

// Phrasings. Generic: the name is filled in at run time.
const PHRASINGS = {
  A: (n) => `${n} is drawn in the picture this description gives: a figure of ${n} is visible in the image.`,
  B: (n) => require('../../server/lib/jevPagePresence').presenceQuestion(n).instructions, // the shipped wording
  C: (n) => `The illustration shows ${n} as one of the figures in the frame.`,
};

function seeded(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

function buildSet() {
  const all = JSON.parse(fs.readFileSync(path.join(RUN, 'cases.json'), 'utf8'));
  const reliable = (c) => c.inMetadata || c.inPlanWho || c.trigger === false || /^PLAN:/i.test(c.plan);
  // a negative needs a reliable label: the metadata list was present (not trigger) or the plan line has a who column
  const negs = all.filter(c => !c.drawn && (!c.trigger || /^PLAN:/i.test(c.plan)));
  const posAll = all.filter(c => c.drawn);
  const rnd = seeded(20261104);
  const trigPos = posAll.filter(c => c.trigger);
  const rest = posAll.filter(c => !c.trigger).map(c => [rnd(), c]).sort((a, b) => a[0] - b[0]).slice(0, 70).map(x => x[1]);
  const dedup = new Map();
  for (const c of [...negs, ...trigPos, ...rest]) dedup.set(`${c.story}#${c.page}#${c.name}`, c);
  return [...dedup.entries()].map(([id, c]) => ({ id, label: c.drawn ? 1 : 0, trigger: c.trigger, name: c.name, prose: c.prose }));
}

async function run() {
  const cap = Number(argv.capUsd || 0.1);
  const set = buildSet();
  const done = new Set(fs.existsSync(ANS) ? fs.readFileSync(ANS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  let spent = 0;
  for (const c of set) {
    if (done.has(c.id)) continue;
    if (spent >= cap) { console.log('CAP reached', spent); break; }
    const questions = Object.fromEntries(Object.entries(PHRASINGS).map(([k, f]) => [k, { type: 'noul', instructions: f(c.name) }]));
    const r = await J.callJev({ state: `ONE ILLUSTRATION'S DESCRIPTION:\n${c.prose}`, questions });
    spent += r.cost;
    fs.appendFileSync(ANS, JSON.stringify({ id: c.id, label: c.label, trigger: c.trigger, p: Object.fromEntries(Object.keys(PHRASINGS).map(k => [k, J.yesProb(r.answers[k])])), cost: r.cost }) + '\n');
  }
  console.log('cases', set.length, 'spent this run USD', spent.toFixed(5));
}

function auc(rows, k) {
  const pos = rows.filter(r => r.label === 1).map(r => r.p[k]); const neg = rows.filter(r => r.label === 0).map(r => r.p[k]);
  let w = 0; for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
function score() {
  const rows = fs.readFileSync(ANS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const n1 = rows.filter(r => r.label === 1).length, n0 = rows.length - n1;
  const out = { cases: rows.length, positives: n1, negatives: n0, usd: rows.reduce((s, r) => s + r.cost, 0), phrasings: {} };
  for (const k of Object.keys(PHRASINGS)) {
    const o = { auc: +auc(rows, k).toFixed(3), thresholds: {} };
    for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]) {
      const kept = rows.filter(r => r.p[k] >= t);   // Jev says "drawn"
      const tp = kept.filter(r => r.label === 1).length;
      o.thresholds[t] = { recall: +(tp / n1).toFixed(3), droppedReal: n1 - tp, negRejected: n0 - kept.filter(r => r.label === 0).length, precisionOfKept: +(tp / (kept.length || 1)).toFixed(3) };
    }
    out.phrasings[k] = o;
  }
  console.log(JSON.stringify(out, null, 1));
  return out;
}
if (process.argv[2] === 'run') run().catch(e => { console.error(e.message); process.exit(1); });
else if (process.argv[2] === 'score') score();
else console.log('usage: run|score');
