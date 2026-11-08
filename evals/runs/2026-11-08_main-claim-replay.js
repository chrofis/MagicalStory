// Replay of the CHANGED planCounters section 6c over the stored plan-check replies of 2026-11-08_quality-tests-A.
// Free, no model call. Per story: CAST_NOT_IN_WHO_COLUMN names with mainNames=[] (old behaviour) vs real mainNames (new).
const PB = require('C:/Users/roger/MagicalStory/server/lib/promptBuilders');
const PC = require('C:/Users/roger/MagicalStory/server/lib/planCounters');
const all = require('./2026-11-08_quality-tests-A/data/stories.json');
const mains = require('./2026-11-08_quality-tests-A/data/mains.json');
const k = id => id.split('_')[2];
const seen = new Set(); let total = 0, stories = 0; const out = [];
for (const r of all) {
  if (!r.checkreply) continue; const key = k(r.id); if (seen.has(key)) continue; seen.add(key);
  const m = mains[`${r.env}:${r.id}`] || mains[Object.keys(mains).find(x => x.endsWith(r.id))]; if (!m) { console.log('no mains for', r.id); continue; }
  const plan = {}; String(r.plannerreply || r.plan).split('\n').forEach(l => { const x = l.match(/^Page (\d+):\s*(.*)$/); if (x) plan[+x[1]] = x[2]; });
  const pages = Object.keys(plan).map(p => ({ pageNumber: +p, planLine: plan[p] }));
  const roster = PB.parsePlanCheckRoster(r.checkreply);
  const run = mn => { const res = PC.runPlanCounters({ pages, roster, commissionedNames: m.chars, mainNames: mn }); const f = res.findings.find(x => x.code === 'CAST_NOT_IN_WHO_COLUMN'); return f ? f.pages.join(',') + ' | ' + (f.line || f.text || f.detail || '') : ''; };
  const before = run([]), after = run(m.main);
  if (before !== after) { stories++; out.push(`${key} main=[${m.main}]\n  OLD: ${before || '(none)'}\n  NEW: ${after}`); }
}
console.log(`stories replayed ${seen.size}; stories where new main-claim findings appear: ${stories}`);
console.log(out.join('\n'));
