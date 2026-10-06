#!/usr/bin/env node
/**
 * Calibration v2 of the typed plan's per-page Jev questions, on TYPED-format lines (docs/decisions.md 2026-10-06
 * "Typed plan: fix plan applied"; dataset evals/datasets/typed-plan-jev-v2.json from
 * typed-plan-calibration-v2-collect.js). v1 was calibrated on stored production lines, which the review showed
 * does not carry over (DEED AUC 0.56 on typed lines; FELT calibrated on mis-read pages).
 *
 *   score   every (item, question) of the dataset, paired form, one rep. ~$0.00004 per Jev call.
 *   report  joins scores with the blind rater labels (<run>/labels-rater1.json, labels-rater2.json; a question
 *           label is the raters' agreement, a disagreement goes to <run>/labels-resolved.json) and prints per
 *           question: n, positives, AUC, and the lowest FLAG LEVEL whose precision is >= PRECISION_MIN with at least
 *           MIN_FLAGGED flags. No such level = the question is scored, never counted (calibrated: false).
 *
 *   node scripts/analysis/typed-plan-calibration-v2.js score  [--run=evals/runs/2026-10-06_typed-plan-jev-v2]
 *   node scripts/analysis/typed-plan-calibration-v2.js report [--run=...]
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
// the repo's .env lives in the main checkout when this runs from a worktree
for (const p of [path.join(root, '.env'), path.join(root, '../../../.env')]) if (fs.existsSync(p)) { require('dotenv').config({ path: p }); break; }
const tp = require('../../server/lib/typedPlan');

const [, , cmd, ...rest] = process.argv;
const arg = (k, d = null) => { const a = rest.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const RUN = path.resolve(root, arg('run', 'evals/runs/2026-10-06_typed-plan-jev-v2'));
const DATASET = require(path.join(root, 'evals/datasets/typed-plan-jev-v2.json'));
const PRECISION_MIN = 0.8;
const MIN_FLAGGED = 4;
const NOISE = 0.05;

const lc = s => String(s).toLowerCase();
/** Which questions an item is labelled (and so scored) for. One list for the rater packets and the scoring. */
const QUESTIONS_OF = (i) => {
  const out = [];
  if (i.source === 'typed') out.push('SIMPLE');
  if (i.source === 'typed' && i.type !== 'face' && i.names.length > 0) out.push('ACTION');
  if (i.source === 'typed' && i.names.length > 0) out.push('OBSTACLE');
  if (i.source === 'typed' && i.listed.length > 1 && i.listed.every(n => i.names.some(x => lc(x) === lc(n)))) out.push('WHOLE');
  if (i.type === 'face') out.push('FELT');
  if ((i.source === 'stored' && i.type === 'scenery') || (i.source === 'typed' && (i.type === 'landscape' || i.type === 'object'))) out.push('WEIGHT');
  return out;
};

async function score() {
  fs.mkdirSync(RUN, { recursive: true });
  const outFile = path.join(RUN, 'scores.json');
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { dataset: DATASET.version, scores: {}, cost: 0, calls: 0 };
  for (const i of DATASET.items) {
    const qs = QUESTIONS_OF(i);
    if (!qs.length || out.scores[i.id]) continue;
    const pages = i.plan.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine }));
    const r = await tp.judgePlanPages({ arc: i.arc, pages, rows: [{ pageNumber: i.pageNumber, type: i.type, names: i.names }], listed: i.listed, only: [i.pageNumber], questions: qs }, { calibration: {} });
    out.scores[i.id] = r.pages[i.pageNumber].scores;
    out.cost += r.stats.costUsd; out.calls += r.stats.calls;
    fs.writeFileSync(outFile, JSON.stringify(out));
  }
  console.log(`done: ${out.calls} calls, $${out.cost.toFixed(4)}`);
}

const auc = (pos, neg) => {
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return +(w / (pos.length * neg.length)).toFixed(3);
};
const wilson = (k, n) => {
  if (!n) return [0, 0];
  const z = 1.96; const p = k / n; const d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [+(c - h).toFixed(2), +(c + h).toFixed(2)];
};

function report() {
  const scores = require(path.join(RUN, 'scores.json')).scores;
  const lab = (f) => (fs.existsSync(path.join(RUN, f)) ? JSON.parse(fs.readFileSync(path.join(RUN, f), 'utf8')) : {});
  const a = lab('labels-rater1.json'); const b = lab('labels-rater2.json'); const resolved = lab('labels-resolved.json');
  const labels = {}; const disagree = [];
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue;
    if (a[k] === b[k]) labels[k] = a[k]; else if (k in resolved) labels[k] = resolved[k]; else disagree.push(k);
  }
  const perQ = {};
  const agreeStats = {};
  for (const k of Object.keys(a)) { const q = k.split('|').pop(); (agreeStats[q] = agreeStats[q] || { n: 0, same: 0 }).n++; if (a[k] === b[k]) agreeStats[q].same++; }
  const calibration = {};
  for (const q of Object.keys(tp.PLAN_QUESTIONS)) {
    const items = [];
    for (const [k, y] of Object.entries(labels)) {
      if (!k.endsWith(`|${q}`)) continue;
      const id = k.slice(0, -(q.length + 1));
      const s = scores[id] && scores[id][q];
      if (typeof s === 'number') items.push({ id, s, y });
    }
    if (!items.length) continue;
    const pos = items.filter(x => x.y).map(x => x.s); const neg = items.filter(x => !x.y).map(x => x.s);
    let pick = null;
    for (const L of [...new Set(items.map(x => x.s))].sort((x, y) => x - y)) {
      const fl = items.filter(x => x.s >= L); const tpc = fl.filter(x => x.y).length;
      if (fl.length >= MIN_FLAGGED && tpc / fl.length >= PRECISION_MIN) { pick = { level: L, flagged: fl.length, tp: tpc, precision: +(tpc / fl.length).toFixed(2), ci: wilson(tpc, fl.length) }; break; }
    }
    perQ[q] = { n: items.length, positives: pos.length, auc: auc(pos, neg), agreement: agreeStats[q] ? +(agreeStats[q].same / agreeStats[q].n).toFixed(2) : null, pick };
    calibration[q] = pick ? { at: +(pick.level - NOISE).toFixed(3), noise: NOISE, calibrated: true, flagLevel: pick.level, precision: pick.precision, ci: pick.ci, flagged: pick.flagged, n: items.length, positives: pos.length, auc: perQ[q].auc }
      : { at: 1, noise: NOISE, calibrated: false, n: items.length, positives: pos.length, auc: perQ[q].auc };
  }
  fs.writeFileSync(path.join(RUN, 'calibration.json'), JSON.stringify({ dataset: DATASET.version, precisionMin: PRECISION_MIN, minFlagged: MIN_FLAGGED, perQuestion: perQ, calibration, disagreements: disagree }, null, 1));
  console.log(JSON.stringify(perQ, null, 1));
  console.log(`disagreements still unresolved: ${disagree.length}`);
}

if (cmd === 'score') score().catch(e => { console.error(e); process.exit(1); });
else if (cmd === 'report') report();
else { console.error('usage: score | report'); process.exit(1); }
module.exports = { QUESTIONS_OF };
