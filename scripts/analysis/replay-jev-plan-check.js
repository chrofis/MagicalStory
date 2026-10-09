#!/usr/bin/env node
/**
 * Replay server/lib/jevPlanCheck.js (plan-check Q10 heights, Q17 whole cast) on STORED plan divisions and set its
 * findings beside what the LLM checker filed for the same divisions (docs/decisions.md 2026-10-09 "Jev stays an
 * added reviewer; only plan-check Q10 and Q17 move to Jev"). Real Jev calls, about USD 0.0000x each.
 *
 *   node scripts/analysis/replay-jev-plan-check.js <divisionId> [<divisionId> ...]
 *   e.g. 1791040103540:check1 1791222889407:check1 1790508305061:disc2
 *
 * Reads evals/runs/2026-10-09_jev-review/plan_divs.json (story text: gitignored). The checker's own Q10 / Q17
 * lines are the stored `findings`; the roster that gates Q17 is the stored one.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const JPC = require('../../server/lib/jevPlanCheck');
const PB = require('../../server/lib/promptBuilders');

const divs = JSON.parse(fs.readFileSync(path.join(__dirname, '../../evals/runs/2026-10-09_jev-review/plan_divs.json'), 'utf8'));
(async () => {
  for (const id of process.argv.slice(2)) {
    const d = divs.find(x => x.id === id);
    if (!d) { console.error('no division', id); process.exit(1); }
    const nums = Object.keys(d.lines).map(Number).sort((a, b) => a - b);
    const pages = nums.map(n => ({ pageNumber: n, planLine: d.lines[n].raw }));
    const roster = new Map(Object.entries(d.roster).map(([n, r]) => [Number(n), r]));
    const t0 = Date.now();
    const scores = await JPC.askPlanCheckJev({ pages, commissionedNames: d.commissioned });
    const ms = Date.now() - t0;
    const { findings } = JPC.planCheckJevFindings({ scores, roster, commissionedNames: d.commissioned });
    const pagesOf = (check, list) => list.filter(f => f.check === check).flatMap(f => (f.pages && f.pages.length ? f.pages : PB.findingPages(f.text)));
    const checker = d.findings;
    console.log(`\n== ${id}: ${nums.length} pages, commissioned ${d.commissioned.join('/')}; Jev ${scores.stats.calls} calls, $${scores.stats.costUsd}, ${ms} ms wall`);
    for (const check of [10, 17]) {
      const jev = [...new Set(pagesOf(check, findings))].sort((a, b) => a - b);
      const llm = [...new Set(pagesOf(check, checker))].sort((a, b) => a - b);
      const near = (check === 10 ? scores.heights : scores.whole);
      const top = [...near.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, v]) => `p${n} ${v.toFixed(2)}`).join(', ');
      console.log(`Q${check}: Jev files pages [${jev.join(', ')}]   checker filed pages [${llm.join(', ')}]   (Jev top scores: ${top})`);
    }
    for (const f of checker.filter(x => x.check === 10 || x.check === 17)) console.log(`   checker Q${f.check}: ${String(f.text).slice(0, 150)}`);
    for (const f of findings) console.log(`   jev     Q${f.check} (${f.jev.score.toFixed(2)}): ${f.text.slice(0, 150)}`);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
