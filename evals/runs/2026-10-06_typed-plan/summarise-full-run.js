// Summarise a typed full-flow run: code targets, calibrated Jev flags vs the noise margin, cost.
const fs = require('fs');
const WT = 'C:/Users/roger/MagicalStory/.claude/worktrees/planner-apply';
const TP = require(WT + '/server/lib/typedPlan');
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const r = j.results && j.results[0];
  if (!r) { console.log(f, 'no result', j.status, j.error); continue; }
  const t = r.typed || {};
  const fin = t.final || {};
  const first = t.first || {};
  console.log('==', f.split(/[\\/]/).pop(), 'status', j.status, 'ok', r.ok, 'cost', r.cost, 'textCost', r.textCost, 'elapsedMs', r.elapsedMs);
  console.log('first code findings:', (first.findings || []).length, (first.findings || []).map(x => x.slice(0, 110)));
  console.log('replan: scope', t.replan ? JSON.stringify(Object.keys(t.replan.scope || {})) : 'none', 'kept', t.pagesReplanned, 'of', t.pagesReturned, t.replan && t.replan.guards && t.replan.guards.discarded ? 'DISCARDED ' + t.replan.guards.discarded : '');
  console.log('FINAL code findings:', (fin.findings || []).length);
  for (const x of fin.findings || []) console.log('   ', x.slice(0, 220));
  const cal = TP.CALIBRATION;
  const flagged = []; const beyond = [];
  for (const [n, o] of Object.entries(fin.jev || {})) {
    for (const [id, v] of Object.entries(o.scores || {})) {
      const c = cal[id]; if (!c || !c.calibrated) continue;
      if (v >= c.at) flagged.push(`p${n} ${id} ${v} (at ${c.at})`);
      if (v >= c.at + c.noise) beyond.push(`p${n} ${id} ${v} (at ${c.at}+${c.noise})`);
    }
  }
  console.log('calibrated Jev flags at/above threshold:', flagged.length, flagged);
  console.log('calibrated Jev flags beyond threshold + noise:', beyond.length, beyond);
  console.log('unmet:', JSON.stringify(fin.unmet || []).slice(0, 600));
  const m = fin.metrics || {};
  console.log('metrics:', JSON.stringify({ typeCounts: m.typeCounts, coverage: m.coverage, simplicity: m.simplicityMean || m.simplicity }).slice(0, 500));
  const pages = (fin.plan || []).map(p => p.planLine).map(l => l.split(' — ')[0] + ' | ' + l.split(' — ')[1]);
  console.log('types/who:', pages.join(' ;; ').slice(0, 900));
  const words = (fin.plan || []).map(p => { const s = p.planLine.split(' — '); return s.slice(2, -1).join(' ').split(/\s+/).length; });
  console.log('instant words per page:', words.join(','));
}
