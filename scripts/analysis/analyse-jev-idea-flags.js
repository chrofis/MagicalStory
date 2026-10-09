// Rewrite rate + precision/recall of the Jev review set (REVIEW_SET thresholds of eval-jev-idea-writer.js) on stored ideas.
const fs = require('fs'); const path = require('path');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const SET = { B_LEAK_END: 0.7, B_FEEL: 0.5, B_OPEN_STATES: 0.5, B_NEW_COMPANION: 0.8, B_ACT_HOLD: 0.6 };
const inj = fs.readFileSync(RUN + 'injection.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.v === 'ORIG');
const ans = fs.readFileSync(RUN + 'answers.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const flagsOf = a => Object.entries(SET).filter(([q, t]) => a[q] && a[q].noul >= t).map(([q]) => q);
const fin = Object.fromEntries(inj.map(r => [r.id, flagsOf(r.answers)]));
const dr = {}; for (const r of ans) if (r.set === 'B' && r.which === 'draft') dr[r.id] = flagsOf(r.answers);
const fr = {}; for (const r of ans) if (r.set === 'B' && r.which === 'final') fr[r.id] = flagsOf(r.answers);
const n = o => Object.keys(o).length, any = o => Object.values(o).filter(x => x.length).length;
console.log(`finals (ORIG): ${any(fin)}/${n(fin)} flagged = rewrite rate ${(100 * any(fin) / n(fin)).toFixed(1)}%`);
console.log(`finals (answers B): ${any(fr)}/${n(fr)} = ${(100 * any(fr) / n(fr)).toFixed(1)}%;  drafts: ${any(dr)}/${n(dr)} = ${(100 * any(dr) / n(dr)).toFixed(1)}%`);
const per = {}; for (const f of Object.values(fr)) for (const q of f) per[q] = (per[q] || 0) + 1; console.log('finals flags per question', per);
const perD = {}; for (const f of Object.values(dr)) for (const q of f) perD[q] = (perD[q] || 0) + 1; console.log('drafts flags per question', perD);
// draft flagged and final clean ("review fixed it") vs draft clean and final flagged ("review broke it")
let fixed = 0, broke = 0, both = 0, neither = 0;
for (const id of Object.keys(dr)) { const d = dr[id].length > 0, f = (fr[id] || []).length > 0; if (d && !f) fixed++; else if (!d && f) broke++; else if (d && f) both++; else neither++; }
console.log({ draftFlaggedFinalClean: fixed, draftCleanFinalFlagged: broke, both, neither });
// R25 owner-session defects (finals) covered by this set
const own = { 'R25/c1/a1': 'cast_join', 'R25/c7/a2': 'cast_join', 'R25/c4/a2': 'act_holds', 'R25/c9/a2': 'act_holds', 'R25/c10/a1': 'named_feeling' };
for (const [id, k] of Object.entries(own)) console.log(id.padEnd(10), k.padEnd(14), 'Jev flags on final:', JSON.stringify(fr[id]));
const r25clean = Object.keys(fr).filter(i => i.startsWith('R25/') && !own[i]); console.log('R25 other finals flagged:', r25clean.filter(i => fr[i].length).map(i => i + ':' + fr[i].join('+')).join(' '));
