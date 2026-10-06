#!/usr/bin/env node
/**
 * One-line numbers of a stored typed-plan Lab run (evals/runs/2026-10-06_typed-plan/<file>.json):
 * rounds, kept pages, code findings left, counted Jev flags, main-character pages, cost.
 *   node scripts/analysis/summarize-typed-plan-run.js <file>...
 */
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = (e.results || [])[0] || {};
  const t = r.typed || {};
  const fin = t.final || {};
  const m = fin.metrics || {};
  const rounds = t.replanRounds || (t.replan ? [t.replan] : []);
  console.log(JSON.stringify({
    file: f.split(/[\\/]/).pop(),
    id: e.id,
    status: e.status,
    rounds: rounds.length,
    kept: rounds.map(x => (x.decisions || []).filter(d => d.keep).map(d => d.pageNumber)),
    returned: rounds.map(x => x.returnedPages),
    codeFindingsFirst: (t.first && t.first.findings || []).map(x => x.slice(0, 40)),
    codeFindingsLeft: m.codeFindings || [],
    flagCount: m.flagCount,
    flagsByQuestion: m.flagsByQuestion,
    main: m.mainShare,
    coverage: m.coverage,
    cost: r.cost,
  }));
}
