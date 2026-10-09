#!/usr/bin/env node
/**
 * Replays the SHIPPED jevDecisions.decideOutfitsStated over the hand-labelled stored pages
 * (jev-clothing-labels.json + evals/runs/2026-10-09_jev-clothing/cases.json): one call per page with
 * ALL its figures, exactly as buildImagePrompt asks. Reports caught / false alarms at the shipped threshold.
 *   node scripts/analysis/replay-jev-outfit-stated.js [--capUsd=0.05]
 * Paid: about 100 Jev calls, USD ~0.003.
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { decideOutfitsStated } = require('../../server/lib/jevDecisions');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'evals/runs/2026-10-09_jev-clothing/cases.json'), 'utf8'));
  const labels = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, 'jev-clothing-labels.json'), 'utf8')).map(l => [l.key, l.label]));
  const pages = new Map();
  for (const c of cases) { const k = `${c.sid}:${c.page}`; if (!pages.has(k)) pages.set(k, []); pages.get(k).push(c); }
  let cost = 0, tp = 0, fn = 0, fp = 0, tn = 0, calls = 0; const wrong = [];
  for (const [k, figs] of pages) {
    if (!figs.some(c => labels.has(`${c.sid}:${c.page}:${c.name}`))) continue;
    if (cost > cap) { console.error(`cap USD ${cap} reached`); break; }
    const r = await decideOutfitsStated({ prose: figs[0].prose, figures: figs.map(c => ({ name: c.name, outfit: c.outfit })) });
    cost += r.stats.costUsd; calls += r.stats.calls;
    for (const c of figs) {
      const key = `${c.sid}:${c.page}:${c.name}`; if (!labels.has(key)) continue;
      const flagged = r.missing.includes(c.name), missing = labels.get(key) === 1;
      if (missing) flagged ? tp++ : (fn++, wrong.push('MISS ' + key)); else flagged ? (fp++, wrong.push('FALSE ' + key)) : tn++;
    }
  }
  console.log(`pages ${calls} calls, cost USD ${cost.toFixed(5)}; outfit missing: caught ${tp}/${tp + fn}; outfit stated: flagged ${fp}/${fp + tn}`);
  console.log(wrong.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
