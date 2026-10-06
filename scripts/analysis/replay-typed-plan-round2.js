#!/usr/bin/env node
/**
 * Free replay (no model call) of the SECOND re-plan round's scope over the stored FINAL plans of the Lab runs
 * (evals/runs/2026-10-06_typed-plan/full-*rv3/rv4*.json): which code findings are still unmet after round 1 and which
 * pages the round-2 scope (code findings only, jevMax 0) would send back. docs/decisions.md 2026-10-06
 * "Typed plan: second re-plan round".
 *   node scripts/analysis/replay-typed-plan-round2.js
 */
const fs = require('fs');
const path = require('path');
const tp = require('../../server/lib/typedPlan');
const PC = require('../../server/lib/planCounters');
const { typedPlanTargets } = require('../../server/lib/castCoverage');
const dir = path.join(__dirname, '../../evals/runs/2026-10-06_typed-plan');
for (const f of fs.readdirSync(dir).filter(x => /^full-.*rv[34]/.test(x))) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).results[0].typed;
  const listed = (t.firstPlan.prompt.match(/Commissioned characters: ([^\n]+)/) || [])[1].split(',').map(s => s.trim());
  const arcNames = ['Rubina', 'Herr Keller'];
  // the plan standing after round 1: the first plan with the kept pages of the re-plan reply (final.plan carries shots, not types)
  const kept = new Set((t.replan.decisions || []).filter(d => d.keep).map(d => d.pageNumber));
  const replyLine = n => (t.replan.reply.match(new RegExp(String.raw`^\s*(?:\*\*)?Page ${n}\s*:\s*(.+)$`, 'm')) || [])[1];
  const pages = t.first.plan.map(p => (kept.has(p.pageNumber) ? { pageNumber: p.pageNumber, planLine: replyLine(p.pageNumber).trim() } : p));
  const c = PC.typedPlanCounters({ pages, listedNames: listed, commissionedNames: listed, arcNames, mainName: listed[0], maxCharactersPerScene: 6 });
  const targets = typedPlanTargets({ pageCount: pages.length, listed, maxCharactersPerScene: 6 });
  const jevPages = Object.fromEntries(Object.entries(t.final.jev).map(([n, o]) => [n, { scores: o.scores, flags: tp.flagsOf(o.scores, tp.CALIBRATION) }]));
  const scope = tp.replanScope({ rows: c.rows, findings: c.findings, jevPages, castTable: t.castTable, targets, commissionedNames: listed, arcNames, jevMax: 0 });
  if (process.argv.includes('-v')) {
    console.log(c.findings.map(x => `${x.code} ${(x.detail || '').slice(0, 90)}`).join('\n'));
    console.log(c.rows.map(r => `${r.pageNumber} ${r.type} ${r.names.join('/')}`).join('\n'));
  }
  console.log(`${f}:${c.findings.map(x => x.code).join(',') || 'no code finding'}; round-2 scope: ${[...scope.entries()].map(([n, o]) => `${n}${o.adds.length ? '+' + o.adds.join('/') : ''}`).join(' ') || '-'}`);
}
