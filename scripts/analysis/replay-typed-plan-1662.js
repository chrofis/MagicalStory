#!/usr/bin/env node
/**
 * Step-0 replay (free, offline): the stored Lab #1658-#1662 plans re-counted by the
 * CURRENT counters (who-classes, peopled-only no-commissioned count, commissioned face
 * page, one who reader) and the re-plan scope the CURRENT replanScope would send.
 *
 * #1662's Jev scores are in the OLD single-question form (P(yes) of the virtue for
 * SIMPLE/ACTION/FELT/THIRD/WEIGHT, of the fault for DEED/HEIGHTS/OBSTACLE, the fault for
 * WHOLE); they are converted to fault scores to feed replanScope. Which questions flag is
 * a PROVISIONAL calibration here (everything but DEED at 0.5), printed beside the same scope
 * with DEED included, so the size of the change is visible. Nothing is called.
 *
 *   node scripts/analysis/replay-typed-plan-1662.js
 */
const fs = require('fs');
const path = require('path');
const tp = require('../../server/lib/typedPlan');
const { typedPlanCounters, countPlanTargets } = require('../../server/lib/planCounters');
const { typedPlanTargets } = require('../../server/lib/castCoverage');

const RUNS = path.resolve(__dirname, '../../evals/runs/2026-10-06_typed-plan');
const data = require('../../evals/datasets/typed-plan-jev-v1.json');
const STORY = 'job_1791040103540_atbttop6w';
const story = data.plans.find(p => p.storyId === STORY);
const listed = story.commissioned;
const known = listed;
const arcNames = story.arcNames;
const mainName = 'Levin';
const maxCast = 5; // the page model's maxCharactersPerScene (group budget 3 of 18 as in #1662)

const typed = require(path.join(RUNS, 'typed_job_1791040103540_atbttop6w.json')).results[0];
const stored = require(path.join(RUNS, 'stored_job_1791040103540_atbttop6w.json')).results[0];
const targets = typedPlanTargets({ pageCount: 18, listed, maxCharactersPerScene: maxCast });

const show = (label, c) => {
  const st = c.stats;
  console.log(`\n== ${label}`);
  console.log(`  face (listed child) ${st.facePages.length} of ${st.facePagesAll.length} face pages | scenery ${st.sceneryPages.length} | peopled with only invented figures ${st.noCommissionedPages.length} ${JSON.stringify(st.noCommissionedPages)} | invented-figure pages ${JSON.stringify(st.inventedPages)}`);
  const cls = { commissioned: 0, arc: 0, invented: 0 };
  Object.values(st.whoClasses).forEach(m => Object.values(m).forEach(k => cls[k]++));
  console.log(`  figures by class ${JSON.stringify(cls)} | coverage ${JSON.stringify(Object.fromEntries(Object.entries(st.coveragePages).map(([k, v]) => [k, v.length])))} | group ${st.groupPages.length}/${st.groupBudget}`);
  console.log(`  findings: ${c.findings.map(f => f.code).join(', ') || 'none'}`);
};

// 1. the typed first plan and its shipped final, counted by the new counters
const firstPlan = typed.typed.first.plan;
// The shipped plan = the first plan with the two kept re-plan pages (14, 15) from the stored re-plan reply.
const kept = typed.typed.replan.decisions.filter(d => d.keep).map(d => d.pageNumber);
const replyLine = n => (typed.typed.replan.reply.match(new RegExp(String.raw`^\s*(?:\*\*)?Page ${n}\s*:\s*(.+)$`, 'm')) || [])[1];
const finalPlan = firstPlan.map(p => (kept.includes(p.pageNumber) && replyLine(p.pageNumber) ? { pageNumber: p.pageNumber, planLine: replyLine(p.pageNumber).trim() } : p));
const cFirst = typedPlanCounters({ pages: firstPlan, listedNames: listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast });
show('typed first plan (OLD counter said: 6 pages with no commissioned character: 2, 4, 7, 14, 16, 17)', cFirst);
show('typed shipped plan (OLD counter said: 5 pages: 2, 4, 7, 16, 17)', typedPlanCounters({ pages: finalPlan, listedNames: listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast }));

// 2. the stored shipped plan read by the SAME who reader; luna's head count only cross-checks
const present = new Map(story.luna.map(r => [r.pageNumber, r.names]));
const storedPages = stored.standingPlan.map(p => ({ pageNumber: p.pageNumber, planLine: p.planLine }));
const rows = tp.rowsOfUntypedPlan(storedPages, present, { commissionedNames: known, arcNames });
show('stored shipped plan, who column read by parseTypedWho', countPlanTargets({ rows, listedNames: listed, commissionedNames: known, arcNames, mainName, maxCharactersPerScene: maxCast }));
const cross = tp.crossCheckRows(rows);
console.log(`  luna cross-check: ${cross.length} page(s) differ from the code reading: ${cross.map(x => `p${x.page} code[${x.code}] luna[${x.luna}]${x.unreadable.length ? ` unreadable[${x.unreadable}]` : ''}`).join(' | ')}`);

// 3. the re-plan scope: old (16 pages) vs the current replanScope
const toFault = (id, v) => (['DEED', 'HEIGHTS', 'OBSTACLE', 'WHOLE'].includes(id) ? v : 1 - v);
const jevPages = {};
for (const [n, o] of Object.entries(typed.typed.first.jev)) jevPages[n] = { scores: Object.fromEntries(Object.entries(o.scores).filter(([id]) => id in tp.PLAN_QUESTIONS).map(([id, v]) => [id, +toFault(id, v).toFixed(3)])), flags: [] };
const castTable = typed.typed.castTable;
const scopeWith = (ids) => {
  const calibration = Object.fromEntries(ids.map(id => [id, { at: 0.5, noise: 0.1, calibrated: true }]));
  for (const o of Object.values(jevPages)) o.flags = tp.flagsOf(o.scores, calibration);
  return tp.replanScope({ rows: cFirst.rows, findings: cFirst.findings, jevPages, castTable, targets, calibration, commissionedNames: known, arcNames });
};
const oldPages = Object.keys(typed.typed.replan.scope).map(Number);
console.log(`\n== re-plan scope: OLD sent ${oldPages.length} pages ${JSON.stringify(oldPages)} (kept 2)`);
for (const [label, ids] of [['provisional calibration, DEED excluded', ['SIMPLE', 'ACTION', 'HEIGHTS', 'FELT', 'THIRD', 'OBSTACLE', 'WEIGHT', 'WHOLE']], ['same, DEED included', ['SIMPLE', 'ACTION', 'DEED', 'HEIGHTS', 'FELT', 'THIRD', 'OBSTACLE', 'WEIGHT', 'WHOLE']]]) {
  const scope = scopeWith(ids);
  console.log(`  NEW (${label}): ${scope.size} page(s) ${JSON.stringify([...scope.keys()].sort((a, b) => a - b))}`);
  if (ids.includes('DEED')) continue;
  for (const [pg, o] of [...scope.entries()].sort((a, b) => a[0] - b[0])) console.log(`    page ${pg}: ${o.reasons.map(r => r.slice(0, 110)).join(' || ')}\n      keep: ${o.keep.join('; ').slice(0, 140)}`);
}
