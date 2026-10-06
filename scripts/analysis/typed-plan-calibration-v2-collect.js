#!/usr/bin/env node
/**
 * Calibration v2 dataset for the typed plan's Jev questions (docs/decisions.md 2026-10-06 "Typed plan: fix plan
 * applied"). Collects every DISTINCT typed first-plan line from the stored Lab runs (evals/runs/2026-10-06_typed-plan),
 * with the arc and the commission, so the questions are calibrated on the format they judge (the v1 labels were
 * stored production lines). Writes evals/datasets/typed-plan-jev-v2.json. Free: no model call.
 *   node scripts/analysis/typed-plan-calibration-v2-collect.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const dir = path.join(root, 'evals/runs/2026-10-06_typed-plan');
const PC = require(path.join(root, 'server/lib/planCounters'));

const out = { version: 'typed-plan-jev-v2', collectedFrom: 'evals/runs/2026-10-06_typed-plan/{first,full}-*.json first typed plans', items: [] };
const seen = new Set();
for (const f of fs.readdirSync(dir).sort()) {
  if (!/^(first|full)-/.test(f)) continue;
  const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const t = run.results[0].typed;
  const prompt = t.firstPlan.prompt;
  const arc = prompt.slice(prompt.indexOf('# THE STORY'), prompt.indexOf('Challenges taken')).split('\n').slice(1).join('\n').trim();
  const names = (prompt.match(/Commissioned characters: ([^\n]+)/) || [])[1];
  const listed = names ? names.split(',').map(s => s.trim()).filter(Boolean) : [];
  const storyId = run.storyId;
  const plan = t.first.plan;
  const rows = PC.typedPlanCounters({ pages: plan, listedNames: listed, commissionedNames: listed, mainName: listed[0], maxCharactersPerScene: 6 }).rows;
  for (const p of plan) {
    const key = `${storyId}|${p.planLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = rows.find(x => x.pageNumber === p.pageNumber);
    out.items.push({ id: `${storyId.slice(-9)}|${f.replace(/\.json$/, '')}|p${p.pageNumber}`, storyId, from: f, pageNumber: p.pageNumber, planLine: p.planLine, type: r.type, names: r.names, arc, listed, context: plan.filter(x => Math.abs(x.pageNumber - p.pageNumber) <= 2).map(x => `Page ${x.pageNumber}: ${x.planLine}`), plan });
  }
}
// FELT and WEIGHT apply to few typed pages (13 face, 13 scenery), so the stored production plans of dataset v1 add
// face pages (one figure, close-up) and truly people-free pages (the plan check's head count AND the code's who
// reading both empty), spread over the plans, ROUND-ROBIN, at most STORED_MAX of each. They are relabelled under the
// v2 wording; their v1 labels are never reused (the definitions changed).
const STORED_MAX = { face: 30, free: 40 };
const TP = require(path.join(root, 'server/lib/typedPlan'));
const v1 = require(path.join(root, 'evals/datasets/typed-plan-jev-v1.json'));
const pools = { face: [], free: [] };
for (const plan of v1.plans) {
  const present = new Map(plan.luna.map(r => [r.pageNumber, r.names]));
  const rows = TP.rowsOfUntypedPlan(plan.pages, present, { commissionedNames: plan.commissioned, arcNames: plan.arcNames });
  const mine = { face: [], free: [] };
  for (const r of rows) {
    const luna = present.get(r.pageNumber) || [];
    if (r.type === 'face' && r.names.length === 1 && luna.length === 1) mine.face.push(r);
    if (r.names.length === 0 && luna.length === 0) mine.free.push(r);
  }
  for (const k of ['face', 'free']) pools[k].push({ plan, rows: mine[k] });
}
for (const k of ['face', 'free']) {
  let taken = 0;
  for (let round = 0; taken < STORED_MAX[k]; round++) {
    let any = false;
    for (const { plan, rows } of pools[k]) {
      if (taken >= STORED_MAX[k]) break;
      const r = rows[round];
      if (!r) continue;
      any = true; taken++;
      out.items.push({
        id: `${plan.storyId.slice(-9)}|stored|p${r.pageNumber}`, source: 'stored', storyId: plan.storyId, pageNumber: r.pageNumber, planLine: r.planLine,
        type: k === 'face' ? 'face' : 'scenery', names: r.names, arc: plan.arc, listed: plan.commissioned,
        context: plan.pages.filter(x => Math.abs(x.pageNumber - r.pageNumber) <= 2).map(x => `Page ${x.pageNumber}: ${x.planLine}`),
        plan: plan.pages,
      });
    }
    if (!any) break;
  }
}
for (const i of out.items) if (!i.source) i.source = 'typed';
fs.writeFileSync(path.join(root, 'evals/datasets/typed-plan-jev-v2.json'), JSON.stringify(out, null, 1));
const by = {};
for (const i of out.items) { const k = `${i.source}:${i.type}`; by[k] = (by[k] || 0) + 1; }
console.log(out.items.length, 'items', by);
