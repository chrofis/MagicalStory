#!/usr/bin/env node
/**
 * Replays the SHIPPED jevDecisions.decideEmotions over the stored, reading-labelled stories of the
 * 2026-10-09 measurement (scripts/analysis/eval-jev-brief-metadata.js items()), in the state production
 * has when it decides:
 *   full stories  arc + plan lines (page text does not exist when the briefs are written, beatsPipeline step 6)
 *   trial stories the page texts (the trial writer's single call has already returned them)
 * The measured E10 gave the call the page TEXT on full stories too; this checks the production state holds the
 * measured accuracy (docs/decisions.md 2026-10-09 "Jev decides each figure's emotion before the briefs").
 *   node scripts/analysis/replay-jev-emotions-production-state.js [--capUsd=0.05]
 * Paid: about 15 Jev calls, well under USD 0.01.
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { decideEmotions } = require('../../server/lib/jevDecisions');
const { items } = require('./eval-jev-brief-metadata');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-brief-metadata');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);

(async () => {
  const S = JSON.parse(fs.readFileSync(path.join(RUN, 'stories.json'), 'utf8'));
  const its = items();
  const bySid = {};
  for (const it of its) (bySid[it.sid] = bySid[it.sid] || []).push(it);
  const acc = { full: [0, 0, 0], trial: [0, 0, 0] }; // hit, n, ad-hit
  let cost = 0; const rows = [];
  for (const [sid, list] of Object.entries(bySid)) {
    if (cost > cap) { console.error(`cap USD ${cap} reached`); break; }
    const s = S.find(x => x.sid === sid); const kind = list[0].kind;
    const storyPages = s.pages.filter(p => p.n > 0);
    const pages = storyPages.map(p => (kind === 'full' ? { pageNumber: p.n, planLine: p.plan } : { pageNumber: p.n, text: p.text }));
    const perPage = list.map(it => ({ pageNumber: it.page, figures: it.figs.map(f => ({ key: f.name, label: f.name })) }));
    const t0 = Date.now();
    const d = await decideEmotions({ arc: s.arc, pages, perPage });
    const ms = Date.now() - t0; cost += d.stats.costUsd;
    for (const it of list) for (const f of it.figs) {
      acc[kind][1]++; if (d.byPage[it.page][f.name] === f.label) acc[kind][0]++; if (f.ad && f.ad === f.label) acc[kind][2]++;
    }
    rows.push({ sid, kind, pages: pages.length, questions: list.reduce((a, it) => a + it.figs.length, 0), calls: d.stats.calls, ms });
  }
  console.table(rows);
  const pct = (a, b) => `${a}/${b} = ${(100 * a / b).toFixed(1)}%`;
  console.log('production-state decideEmotions  full:', pct(acc.full[0], acc.full[1]), '(AD', pct(acc.full[2], acc.full[1]) + ')', ' trial:', pct(acc.trial[0], acc.trial[1]), ` cost USD ${cost.toFixed(5)}`);
})().catch(e => { console.error(e); process.exit(1); });
