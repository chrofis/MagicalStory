#!/usr/bin/env node
/**
 * Analyse answers.jsonl of eval-jev-idea-review.js against the stored labels.
 *   node scripts/analysis/analyse-jev-idea-review.js
 * Labels
 *   PAIR   final vs draft of the same idea (the writer's own REVIEW rewrote the draft into the final)
 *   BUY    blind buy score of the FINAL (existing blind sets; mean over the sets that scored it); bad <=2, good >=4
 *   DVF    round-7 draft/final pairs scored blind on buy and contract
 *   R25    defects the owner-session read in round 25 finals (tests/manual/story-idea-rounds/round-25-defects.md)
 */
const fs = require('fs');
const path = require('path');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const ideas = Object.fromEntries(fs.readFileSync(RUN + 'ideas.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(x => [x.id, x]));
const rows = fs.readFileSync(RUN + 'answers.jsonl', 'utf8').split('\n').filter(Boolean).map(JSON.parse);

// feature table: feat[id][which][qid] = number (noul P(yes) or expected score 0..4)
const feat = {};
for (const r of rows) {
  const f = ((feat[r.id] = feat[r.id] || {})[r.which] = feat[r.id][r.which] || {});
  for (const [q, a] of Object.entries(r.answers)) f[q] = a.type === 'score' ? a.score : a.noul;
}
const auc = (pos, neg) => { // P(score_pos > score_neg), ties .5
  if (!pos.length || !neg.length) return NaN;
  let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
};
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);

// "good direction" sign: G_* and S_* high = good; B_* high = defect (flip so high = good)
const goodness = (q, v) => (q.startsWith('B_') ? 1 - v : q.startsWith('S_') ? v / 4 : v);
const QIDS = [...new Set(rows.flatMap(r => Object.keys(r.answers)))].filter(q => !q.startsWith('G_STAKE_'));
// per-idea stake aggregate: min over names
function value(id, which, q) {
  const f = feat[id]?.[which]; if (!f) return undefined;
  if (q === 'G_STAKE_MIN') { const v = Object.entries(f).filter(([k]) => k.startsWith('G_STAKE_')).map(([, x]) => x); return v.length ? Math.min(...v) : undefined; }
  return f[q] === undefined ? undefined : goodness(q, f[q]);
}
const ALLQ = [...QIDS, 'G_STAKE_MIN'];
const ids = Object.keys(feat).filter(id => feat[id].draft && feat[id].final);

// ---- PAIR
console.log(`\n== PAIR: ${ids.length} ideas; goodness(final) > goodness(draft)`);
const pair = {};
for (const q of ALLQ) {
  let w = 0, n = 0; const dd = [];
  for (const id of ids) { const a = value(id, 'draft', q), b = value(id, 'final', q); if (a === undefined || b === undefined) continue; n++; w += b > a ? 1 : b === a ? 0.5 : 0; dd.push(b - a); }
  pair[q] = { n, win: w / n, meanDraft: mean(ids.map(i => value(i, 'draft', q)).filter(x => x !== undefined)), meanFinal: mean(ids.map(i => value(i, 'final', q)).filter(x => x !== undefined)) };
}
for (const q of ALLQ) console.log(q.padEnd(16), `n=${pair[q].n}`.padEnd(7), 'final wins', pair[q].win.toFixed(2), ' mean draft', pair[q].meanDraft.toFixed(2), ' final', pair[q].meanFinal.toFixed(2));

// ---- BUY (final text)
const buy = {};
for (const id of ids) { const b = ideas[id].blind; if (b && b.length) buy[id] = mean(b.map(x => x.score)); }
const bad = Object.keys(buy).filter(i => buy[i] <= 2.0), good = Object.keys(buy).filter(i => buy[i] >= 4);
console.log(`\n== BUY on FINALs: ${Object.keys(buy).length} scored, bad(<=2) ${bad.length}, good(>=4) ${good.length}. AUC(good>bad) of goodness`);
const buyAuc = {};
for (const q of ALLQ) {
  const g = good.map(i => value(i, 'final', q)).filter(x => x !== undefined), b = bad.map(i => value(i, 'final', q)).filter(x => x !== undefined);
  buyAuc[q] = auc(g, b);
}
for (const q of ALLQ) console.log(q.padEnd(16), buyAuc[q].toFixed(2));

// ---- DVF
console.log('\n== DVF (round-7 pairs: blind scores of BOTH draft and final)');
for (const id of ids) if (ideas[id].dvf) {
  const d = ideas[id].dvf;
  console.log(id.padEnd(10), 'draft buy/contract', d.draft.buy + '/' + d.draft.contract, ' final', d.final.buy + '/' + d.final.contract);
}

// ---- R25 defects on finals
const R25 = {
  cast_join: ['R25/c1/a1', 'R25/c7/a2'],
  act_holds: ['R25/c4/a2', 'R25/c9/a2'],
  named_feeling: ['R25/c10/a1'],
  peril: ['R25/c1/a1', 'R25/c6/a1'],
  leak_middle: ['R25/c2/a1', 'R25/c3/a1', 'R25/c4/a1', 'R25/c5/a2', 'R25/c6/a2', 'R25/c8/a1', 'R25/c8/a2', 'R25/c9/a1', 'R25/c9/a2', 'R25/c10/a1', 'R25/c1/a1'],
};
const r25 = ids.filter(i => i.startsWith('R25/'));
console.log(`\n== R25 owner-session defects on ${r25.length} finals: AUC (clean > defective) per question, by defect`);
for (const [d, list] of Object.entries(R25)) {
  const pos = list.filter(i => r25.includes(i)), neg = r25.filter(i => !list.includes(i));
  const line = ALLQ.map(q => ({ q, a: auc(neg.map(i => value(i, 'final', q)).filter(x => x !== undefined), pos.map(i => value(i, 'final', q)).filter(x => x !== undefined)) }))
    .filter(o => !Number.isNaN(o.a)).sort((x, y) => y.a - x.a).slice(0, 4).map(o => `${o.q} ${o.a.toFixed(2)}`).join(', ');
  console.log(d.padEnd(14), `defective ${pos.length}/${r25.length}`.padEnd(18), 'best:', line);
}
fs.writeFileSync(RUN + 'metrics-per-question.json', JSON.stringify({ pair, buyAuc }, null, 1));

// ---- DVF accuracy: does Jev order draft/final like the blind buy score did? (round-7 pairs, 20)
{
  const d = ids.filter(i => ideas[i].dvf);
  const diffs = d.map(i => ideas[i].dvf.final.buy - ideas[i].dvf.draft.buy);
  const comp = (id, which, set) => mean(ALLQ.filter(q => q.startsWith(set)).map(q => value(id, which, q)).filter(x => x !== undefined));
  const act = d.filter((_, k) => diffs[k] !== 0);
  console.log(`\n== DVF: ${d.length} pairs; final buy better ${diffs.filter(x => x > 0).length}, equal ${diffs.filter(x => x === 0).length}, worse ${diffs.filter(x => x < 0).length}`);
  const acc = (f) => { let w = 0, n = 0; for (const i of act) { const a = f(i, 'draft'), b = f(i, 'final'); if (a === undefined || b === undefined) continue; const truth = ideas[i].dvf.final.buy - ideas[i].dvf.draft.buy; n++; w += (b - a) * truth > 0 ? 1 : b === a ? 0.5 : 0; } return `${(w / n).toFixed(2)} (n=${n})`; };
  for (const q of ALLQ) console.log(q.padEnd(16), acc((i, w) => value(i, w, q)));
  console.log('MEAN_G'.padEnd(16), acc((i, w) => comp(i, w, 'G_')));
  console.log('MEAN_B'.padEnd(16), acc((i, w) => comp(i, w, 'B_')));
  console.log('MEAN_S'.padEnd(16), acc((i, w) => comp(i, w, 'S_')));
  console.log('MEAN_ALL'.padEnd(16), acc((i, w) => mean(['G_', 'B_', 'S_'].map(s => comp(i, w, s)))));
}
