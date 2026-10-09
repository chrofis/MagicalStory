// E10: ONE Jev call per STORY for all (page, figure) emotions (instruction names the page), and trial wall-clock:
// the 6 per-page E1 calls in parallel vs the single story call. Run: node scripts/analysis/jev-brief-metadata-story-call.js
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const { stripPlanShot } = require('../../server/lib/jevDecisions');
const { items, requests, MOOD } = require('./eval-jev-brief-metadata');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-brief-metadata');
(async () => {
  const S = JSON.parse(fs.readFileSync(path.join(RUN, 'stories.json'), 'utf8'));
  const its = items();
  const by = {}; for (const it of its) (by[it.sid] = by[it.sid] || []).push(it);
  const out = []; const res = { full: [0, 0], trial: [0, 0] }; let cost = 0;
  for (const [sid, list] of Object.entries(by)) {
    const s = S.find(x => x.sid === sid); const kind = list[0].kind;
    const text = s.pages.filter(x => x.n > 0).map(x => `--- Page ${x.n} ---\n${String(x.text).trim()}${kind === 'full' ? `\nPLAN: ${stripPlanShot(x.plan)}` : ''}`).join('\n\n');
    const qs = {}; const idx = [];
    for (const it of list) it.figs.forEach((f, i) => { const q = `Q${idx.length}`; idx.push({ it, f }); qs[q] = { type: 'choice', instructions: `The feeling ${f.name} has at the moment of page ${it.page}, as the story tells it.`, criteria: MOOD }; });
    // single story call
    let t0 = Date.now(); const r = await J.callJev({ state: `THE STORY TEXT:\n${text}`, questions: qs }); const msStory = Date.now() - t0; cost += r.cost;
    idx.forEach((x, k) => { res[kind][1]++; if (r.answers[`Q${k}`].choice === x.f.label) res[kind][0]++; });
    // parallel per-page E1 wall clock
    t0 = Date.now(); const rs = await Promise.all(list.map(it => { const rq = requests(it).find(q => q.variant === 'E1'); return J.callJev({ state: rq.state, questions: rq.questions }); })); const msPar = Date.now() - t0; cost += rs.reduce((a, b) => a + b.cost, 0);
    out.push({ sid, kind, pages: list.length, questions: idx.length, msStoryCall: msStory, msParallelPages: msPar });
  }
  console.table(out);
  console.log('E10 single call per story acc:', JSON.stringify({ full: `${res.full[0]}/${res.full[1]}`, trial: `${res.trial[0]}/${res.trial[1]}` }), `cost $${cost.toFixed(5)}`);
})().catch(e => { console.error(e); process.exit(1); });
