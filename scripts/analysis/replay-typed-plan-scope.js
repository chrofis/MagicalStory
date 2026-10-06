#!/usr/bin/env node
/**
 * Free replay (no model call) of the typed re-plan SCOPE over the stored first plans of the Lab runs
 * (evals/runs/2026-10-06_typed-plan/full-*.json): which pages the current replanScope would send back, with the
 * stored Jev scores re-flagged under the current CALIBRATION. Used to check that the main-character floor is
 * reachable (docs/decisions.md 2026-10-06 "Typed plan: fix plan applied").
 *   node scripts/analysis/replay-typed-plan-scope.js
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const tp = require('../../server/lib/typedPlan');
const PC = require('../../server/lib/planCounters');
const { typedPlanTargets } = require('../../server/lib/castCoverage');
const dir = path.join(root, 'evals/runs/2026-10-06_typed-plan');
for (const f of fs.readdirSync(dir).filter(x => /^full-/.test(x))) {
  const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).results[0].typed;
  const prompt = t.firstPlan.prompt;
  const listed = (prompt.match(/Commissioned characters: ([^\n]+)/) || [])[1].split(',').map(s => s.trim());
  const arcNames = ['Rubina', 'Herr Keller'];
  const mainName = listed[0];
  const pages = t.first.plan;
  const c = PC.typedPlanCounters({ pages, listedNames: listed, commissionedNames: listed, arcNames, mainName, maxCharactersPerScene: 6 });
  const targets = typedPlanTargets({ pageCount: pages.length, listed, maxCharactersPerScene: 6 });
  const jevPages = Object.fromEntries(Object.entries(t.first.jev).map(([n, o]) => [n, { scores: o.scores, flags: tp.flagsOf(o.scores, tp.CALIBRATION) }]));
  const scope = tp.replanScope({ rows: c.rows, findings: c.findings, jevPages, castTable: t.castTable, targets, commissionedNames: listed, arcNames });
  const mainAsked = [...scope.entries()].filter(([, o]) => o.adds.includes(mainName)).map(([n]) => n);
  console.log(`${f}: main ${c.stats.mainCharacter.pages.length}/${targets.mainMin}; scope pages ${[...scope.keys()].join(',')}; asked to add ${mainName}: ${mainAsked.join(',') || '-'} (need ${Math.max(0, targets.mainMin - c.stats.mainCharacter.pages.length) + 1})`);
}
