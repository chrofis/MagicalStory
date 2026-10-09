#!/usr/bin/env node
/**
 * Runs the shipped jevDecisions.decideOutfitsStated over the Art Director briefs the brief check sees
 * (cases from jev-outfit-briefs-extract.js) and lists, beside clothingCheck.checkPage's outfit_missing verdict,
 * the P(contract outfit stated) per brief x character. Labels: scripts/analysis/jev-outfit-briefs-labels.json.
 *   node scripts/analysis/eval-jev-outfit-briefs.js [--capUsd=0.05]
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { decideOutfitsStated } = require('../../server/lib/jevDecisions');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-outfit-briefs');
const cap = Number((process.argv.find(a => a.startsWith('--capUsd=')) || '--capUsd=0.05').split('=')[1]);
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(RUN, 'cases.json'), 'utf8'));
  const pages = new Map();
  cases.forEach((c, i) => { c.i = i; const k = `${c.sid}:${c.page}`; if (!pages.has(k)) pages.set(k, []); pages.get(k).push(c); });
  const f = path.join(RUN, 'jev.json'); let done = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; let cost = 0;
  for (const [k, figs] of pages) {
    if (figs.every(c => done[c.i] != null)) continue;
    if (cost > cap) { console.error('cap reached'); break; }
    const r = await decideOutfitsStated({ prose: figs[0].prose, figures: figs.map(c => ({ name: c.name, outfit: c.outfit })) });
    cost += r.stats.costUsd; for (const c of figs) done[c.i] = r.stated[c.name];
    fs.writeFileSync(f, JSON.stringify(done));
  }
  const missing = cases.filter(c => done[c.i] < 0.3);
  console.log(`cases ${cases.length}; cost USD ${cost.toFixed(5)}; Jev says not stated: ${missing.length}; old outfit_missing: ${cases.filter(c => c.old).length}`);
})().catch(e => { console.error(e); process.exit(1); });
