// Scores action_interaction precision/recall of judge runs against hand labels.
// Usage: node scripts/analysis/action-judge-score.js <labels.json> <runs.json> [<runs2.json> ...]
// Page-level truth: label.realPage (a real action defect visible in the picture). A page is "flagged" when a run files
// an action_interaction finding at MAJOR or CRITICAL (the severities that cost score / trigger repair); "any" counts MINOR/MODERATE too.
// Gaze findings are told apart for REPORTING ONLY (description starts "<name> is declared looking" - the gaze-check's fixed wording).
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
const onlyArg = argv.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
const [labelsFile, ...runFiles] = argv.filter(a => !a.startsWith('--'));
const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')).pages;
const byId = Object.fromEntries(labels.map(p => [p.id, p]));
const sev = s => String(s || '').toLowerCase();
const isGaze = f => /is declared looking|\bgaze\b|\beyes? (is|are)\b|looking at the viewer|looks? (at|toward)/i.test(f.description || '');
const SERIOUS = new Set(['major', 'critical']);

function perRun(runs, runNo) {
  const rs = runs.filter(r => r.run === runNo && !r.error);
  const out = {};
  for (const r of rs) out[r.id] = r;
  return out;
}
const GAZE_CMP = /is declared looking/i;
// finding-level hit: a serious finding on a real page that names the real defect (analysis-only keyword match, see labels note)
const hitsReal = (p, f) => p.realPage && !GAZE_CMP.test(f.description || '') && (p.realMatch || []).some(k => (f.description || '').toLowerCase().includes(k));
function metrics(map, { borderlineIsReal = false, gazeOnly = null, only = null } = {}) {
  let tp = 0, fp = 0, fn = 0, tn = 0, noiseCrit = 0, critPages = 0, findings = 0, realFound = 0, fHit = 0;
  for (const p of labels) {
    if (only && !only.has(p.id)) continue;
    const r = map[p.id]; if (!r) continue;
    let ai = r.findings.filter(f => f.type === 'action_interaction' && SERIOUS.has(sev(f.severity)));
    if (gazeOnly === true) ai = ai.filter(isGaze); if (gazeOnly === false) ai = ai.filter(f => !isGaze(f));
    const real = p.realPage || (borderlineIsReal && p.storedFindings.some(f => f.borderline));
    const flagged = ai.length > 0;
    findings += ai.length; fHit += ai.filter(f => hitsReal(p, f)).length; if (ai.some(f => hitsReal(p, f))) realFound++;
    if (flagged && real) tp++; else if (flagged && !real) fp++; else if (!flagged && real) fn++; else tn++;
    if (ai.some(f => sev(f.severity) === 'critical')) { critPages++; if (!real) noiseCrit++; }
  }
  const prec = tp + fp ? tp / (tp + fp) : NaN, rec = tp + fn ? tp / (tp + fn) : NaN;
  const nReal = labels.filter(p => p.realPage && (!only || only.has(p.id)) && map[p.id]).length;
  return { pages: tp + fp + fn + tn, flaggedPages: tp + fp, pagePrecision: +prec.toFixed(2), findings, realFindingsHit: fHit, findingPrecision: findings ? +(fHit / findings).toFixed(2) : NaN, realPagesHit: realFound, realPages: nReal, recall: nReal ? +(realFound / nReal).toFixed(2) : NaN, critPages, noiseCritPages: noiseCrit };
}
for (const f of runFiles) {
  const runs = JSON.parse(fs.readFileSync(f, 'utf8')).runs;
  console.log(`\n=== ${f}  (${runs.length} evals, ${runs.filter(r => r.error).length} errors)`);
  const m1 = perRun(runs, 1), m2 = perRun(runs, 2);
  for (const [name, m] of [['run1', m1], ['run2', m2]]) {
    if (!Object.keys(m).length) continue;
    console.log(name, 'MAJOR+:', JSON.stringify(metrics(m, { only: ONLY })));
    console.log(name, '  gaze-only:', JSON.stringify(metrics(m, { gazeOnly: true, only: ONLY })), ' non-gaze:', JSON.stringify(metrics(m, { gazeOnly: false, only: ONLY })));
    console.log(name, '  borderline-as-real:', JSON.stringify(metrics(m, { borderlineIsReal: true, only: ONLY })));
  }
  // flip rate between runs (pages present in both)
  const both = labels.filter(p => m1[p.id] && m2[p.id] && (!ONLY || ONLY.has(p.id)));
  if (both.length) {
    const fl = p => r => r.findings.some(x => x.type === 'action_interaction' && SERIOUS.has(sev(x.severity)));
    const flips = both.filter(p => fl()(m1[p.id]) !== fl()(m2[p.id]));
    const realFlips = flips.filter(p => p.realPage);
    console.log(`flip rate (action MAJOR+ flagged differs run1 vs run2): ${flips.length}/${both.length} = ${(flips.length / both.length).toFixed(2)}; on real pages ${realFlips.length}/${both.filter(p => p.realPage).length}`);
  }
  // other finding types, summed over runs, per-run average
  const types = {};
  const nRuns = [m1, m2].filter(m => Object.keys(m).length).length || 1;
  for (const r of runs.filter(r => !r.error && (!ONLY || ONLY.has(r.id)))) for (const x of r.findings) { const k = `${x.type}/${sev(x.severity)}`; types[k] = (types[k] || 0) + 1; }
  const avg = Object.fromEntries(Object.entries(types).map(([k, v]) => [k, +(v / nRuns).toFixed(1)]));
  fs.writeFileSync(f.replace(/\.json$/, '.types.json'), JSON.stringify(avg, null, 1));
  const cost = runs.reduce((a, r) => a + (r.usage ? (r.usage.input_tokens * 0.30 + (r.usage.output_tokens) * 2.5) / 1e6 : 0), 0);
  console.log('approx judge spend USD (gemini-2.5-flash list price, tokens in/out):', cost.toFixed(2));
}
