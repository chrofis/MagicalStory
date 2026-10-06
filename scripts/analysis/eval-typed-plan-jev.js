#!/usr/bin/env node
/**
 * Jev calibration of the typed plan's per-page questions (docs/decisions.md 2026-10-06
 * "Typed plan: Jev calibration"; dataset evals/datasets/typed-plan-jev-v1.json, built by
 * scripts/analysis/typed-plan-collect.js).
 *
 * Two stages:
 *   score   every applicable (page, question) of every stored shipped plan, in the PAIRED form,
 *           rep 1 on all plans and rep 2 on the plans named by --rep2=<n> (the flip rate).
 *           Writes <run>/scores.json and one cost line. ~$0.00004 per Jev call.
 *   report  joins scores.json with <run>/labels.json (agent labels) and the weak labels read from
 *           the stored luna findings (dataset.weak), and prints / writes per question: n, AUC
 *           (agent and weak labels), the threshold with precision >= 0.7, flip rate, kept/dropped.
 *
 *   node scripts/analysis/eval-typed-plan-jev.js score  --run=evals/runs/2026-10-06_typed-plan-jev [--plans=N] [--rep2=N]
 *   node scripts/analysis/eval-typed-plan-jev.js report --run=evals/runs/2026-10-06_typed-plan-jev
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tp = require('../../server/lib/typedPlan');

const [, , cmd, ...rest] = process.argv;
const arg = (k, d = null) => { const a = rest.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const RUN = path.resolve(arg('run', 'evals/runs/2026-10-06_typed-plan-jev'));
const DATASET = path.resolve('evals/datasets/typed-plan-jev-v1.json');

const planOf = (plan) => {
  const present = new Map(plan.luna.map(r => [r.pageNumber, r.names]));
  const rows = tp.rowsOfUntypedPlan(plan.pages, present, { commissionedNames: plan.commissioned, arcNames: plan.arcNames });
  return { rows, listed: plan.commissioned };
};

async function score() {
  const data = require(DATASET);
  const nPlans = parseInt(arg('plans', String(data.plans.length)), 10);
  const rep2 = parseInt(arg('rep2', '0'), 10);
  fs.mkdirSync(RUN, { recursive: true });
  const outFile = path.join(RUN, 'scores.json');
  const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : { dataset: data.version, plans: {}, cost: 0, calls: 0 };
  const plans = data.plans.slice(0, nPlans);
  for (const [i, plan] of plans.entries()) {
    const have = out.plans[plan.storyId] || { rep1: null, rep2: null };
    const { rows, listed } = planOf(plan);
    for (const rep of ['rep1', 'rep2']) {
      if (have[rep]) continue;
      if (rep === 'rep2' && i >= rep2) continue;
      const r = await tp.judgePlanPages({ arc: plan.arc, pages: plan.pages, rows, listed }, { calibration: {} });
      have[rep] = Object.fromEntries(Object.entries(r.pages).map(([n, o]) => [n, o.scores]));
      out.cost += r.stats.costUsd; out.calls += r.stats.calls;
      fs.writeFileSync(outFile, JSON.stringify({ ...out, plans: { ...out.plans, [plan.storyId]: have } }));
      console.log(`${plan.storyId} ${rep}: ${r.stats.calls} calls $${r.stats.costUsd} (total $${out.cost.toFixed(4)})`);
    }
    out.plans[plan.storyId] = have;
  }
  fs.writeFileSync(outFile, JSON.stringify(out));
  console.log(`done: ${out.calls} calls, $${out.cost.toFixed(4)}`);
}

// ---- items for the agent labellers: ~N per question, stratified by rep-1 score, scores NOT shown ----
function items() {
  const N = parseInt(arg('n', '40'), 10);
  const data = require(DATASET);
  const scores = JSON.parse(fs.readFileSync(path.join(RUN, 'scores.json'), 'utf8'));
  const byId = Object.fromEntries(data.plans.map(p => [p.storyId, p]));
  let seed = 20261006;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const out = {};
  for (const id of Object.keys(tp.PLAN_QUESTIONS)) {
    const all = [];
    for (const [storyId, p] of Object.entries(scores.plans)) for (const [page, qs] of Object.entries(p.rep1 || {})) if (id in qs) all.push({ storyId, page: Number(page), score: qs[id] });
    // five equal-width score bins over the observed range; take N / 5 from each (fewer where a bin is short, the rest filled from the other bins)
    const lo = Math.min(...all.map(a => a.score)); const hi = Math.max(...all.map(a => a.score));
    const bins = Array.from({ length: 5 }, () => []);
    for (const a of all) bins[Math.min(4, Math.floor(((a.score - lo) / ((hi - lo) || 1)) * 5))].push(a);
    const pick = [];
    const shuffled = bins.map(b => b.map(x => [rnd(), x]).sort((x, y) => x[0] - y[0]).map(x => x[1]));
    for (let k = 0; pick.length < Math.min(N, all.length) && k < 1000; k++) for (const b of shuffled) if (pick.length < N && b[k]) pick.push(b[k]);
    out[id] = pick;
  }
  const q = tp.PLAN_QUESTIONS;
  const itemOf = (id, a) => {
    const plan = byId[a.storyId];
    const line = plan.pages.find(p => p.pageNumber === a.page).planLine;
    const base = { key: `${a.storyId}|${a.page}|${id}`, planLine: line.replace(/^[^—]*—\s*/, '') };
    if (id === 'WEIGHT') base.storyArc = plan.arc;
    return base;
  };
  fs.mkdirSync(path.join(RUN, 'label-input'), { recursive: true });
  for (const id of Object.keys(q)) {
    fs.writeFileSync(path.join(RUN, 'label-input', `${id}.json`), JSON.stringify({
      question: id, faultStatement: q[id].fault, virtueStatement: q[id].virtue,
      instruction: 'For each item, decide whether the FAULT statement is true of the plan line (label true) or the VIRTUE statement is (label false). Judge the line itself, from its wording; do not guess what a model would say.',
      items: out[id].map(a => itemOf(id, a)),
    }, null, 1));
  }
  // The selection with scores stays with the scorer: used by the report, never shown to a labeller.
  fs.writeFileSync(path.join(RUN, 'label-selection.json'), JSON.stringify(Object.fromEntries(Object.entries(out).map(([id, v]) => [id, v.map(a => ({ key: `${a.storyId}|${a.page}|${id}`, score: a.score }))])), null, 1));
  console.log(Object.fromEntries(Object.entries(out).map(([id, v]) => [id, v.length])));
}

// ---- report ----
const auc = (pos, neg) => {
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
/** Lowest score s such that, over labelled items with score >= s, precision >= target (and at least minN items). */
function thresholdAt(items, target = 0.7, minN = 5) {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  let best = null; let tp_ = 0;
  sorted.forEach((it, k) => {
    if (it.label) tp_++;
    if (k + 1 >= minN && tp_ / (k + 1) >= target) best = { at: it.score, n: k + 1, precision: +(tp_ / (k + 1)).toFixed(3), recall: null };
  });
  if (best) { const P = items.filter(i => i.label).length; best.recall = P ? +(items.filter(i => i.label && i.score >= best.at).length / P).toFixed(3) : null; }
  return best;
}

function report() {
  const scores = JSON.parse(fs.readFileSync(path.join(RUN, 'scores.json'), 'utf8'));
  const labelsFile = path.join(RUN, 'labels.json');
  const agent = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8')) : {};
  // Weak labels: the plan check (luna) found a fault of this kind on the page of the SHIPPED division.
  // Check number -> question (prompts/plan-check.txt); SIMPLE has no luna analogue.
  const CHECK_TO_Q = { 1: 'FELT', 3: 'THIRD', 5: 'ACTION', 6: 'WEIGHT', 9: 'DEED', 10: 'HEIGHTS', 11: 'OBSTACLE', 17: 'WHOLE' };
  const weakQs = new Set(Object.values(CHECK_TO_Q));
  const lunaPos = new Set();
  for (const pl of require(DATASET).plans) for (const f of pl.lunaFindings || []) if (CHECK_TO_Q[f.check]) lunaPos.add(`${pl.storyId}|${f.page}|${CHECK_TO_Q[f.check]}`);
  const weak = new Proxy({}, { has: (_, k) => weakQs.has(String(k).split('|')[2]), get: (_, k) => lunaPos.has(String(k)) });
  const byQ = {};
  for (const [storyId, p] of Object.entries(scores.plans)) {
    for (const [page, qs] of Object.entries(p.rep1 || {})) {
      for (const [id, v] of Object.entries(qs)) {
        const key = `${storyId}|${page}|${id}`;
        const r2 = p.rep2 && p.rep2[page] && p.rep2[page][id];
        (byQ[id] = byQ[id] || []).push({ key, score: v, score2: typeof r2 === 'number' ? r2 : null, agent: key in agent ? agent[key] : null, weak: key in weak ? weak[key] : null });
      }
    }
  }
  const table = [];
  for (const id of Object.keys(tp.PLAN_QUESTIONS)) {
    const items = byQ[id] || [];
    const ag = items.filter(i => i.agent !== null).map(i => ({ score: i.score, label: !!i.agent }));
    const wk = items.filter(i => i.weak !== null).map(i => ({ score: i.score, label: !!i.weak }));
    const aucAgent = auc(ag.filter(x => x.label).map(x => x.score), ag.filter(x => !x.label).map(x => x.score));
    const aucWeak = auc(wk.filter(x => x.label).map(x => x.score), wk.filter(x => !x.label).map(x => x.score));
    const th = thresholdAt(ag);
    const pairs = items.filter(i => i.score2 !== null);
    const flip = (at) => (pairs.length && at != null ? +(pairs.filter(i => (i.score >= at) !== (i.score2 >= at)).length / pairs.length).toFixed(3) : null);
    const noise = pairs.length ? +(pairs.reduce((a, i) => a + Math.abs(i.score - i.score2), 0) / pairs.length).toFixed(3) : null;
    const kept = aucAgent !== null && aucAgent >= 0.75 && !!th;
    table.push({
      question: id, n: items.length, agentLabelled: ag.length, agentPositives: ag.filter(x => x.label).length,
      aucAgent: aucAgent === null ? null : +aucAgent.toFixed(3), weakLabelled: wk.length, weakPositives: wk.filter(x => x.label).length, aucWeak: aucWeak === null ? null : +aucWeak.toFixed(3),
      threshold: th ? th.at : null, precision: th ? th.precision : null, recall: th ? th.recall : null, flipRateAtThreshold: flip(th ? th.at : null), meanAbsDiffRep: noise, repPairs: pairs.length, kept,
    });
  }
  fs.writeFileSync(path.join(RUN, 'calibration.json'), JSON.stringify({ dataset: scores.dataset, table }, null, 1));
  console.table(table.map(t => ({ q: t.question, n: t.n, 'agent n/pos': `${t.agentLabelled}/${t.agentPositives}`, 'AUC agent': t.aucAgent, 'weak n/pos': `${t.weakLabelled}/${t.weakPositives}`, 'AUC weak': t.aucWeak, thr: t.threshold, prec: t.precision, rec: t.recall, flip: t.flipRateAtThreshold, noise: t.meanAbsDiffRep, kept: t.kept })));
}

(cmd === 'score' ? score() : cmd === 'items' ? Promise.resolve(items()) : cmd === 'report' ? Promise.resolve(report()) : Promise.reject(new Error('usage: score|report'))).catch((e) => { console.error(e); process.exit(1); });
