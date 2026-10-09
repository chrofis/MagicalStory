// Round 3 (free): average the probabilities of stored E1 (choice) and E3 (score) answers, per figure; report accuracy vs labels.
const path = require('path'); const fs = require('fs');
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-brief-metadata');
const { items } = require('./eval-jev-brief-metadata');
const { EMOTIONS } = require('../../server/lib/emotionVocabulary');
const its = new Map(items().map(x => [x.id, x]));
const rows = fs.readFileSync(path.join(RUN, 'emotion_answers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.rep === 0);
const by = {}; for (const r of rows) (by[r.id] = by[r.id] || {})[r.variant] = r.answers;
const probs = (v, a, i) => (v === 'E3' ? Object.fromEntries(EMOTIONS.map((e, k) => [e, a[`EMO${i}`].probabilities[k]])) : a[`EMO${i}`].probabilities);
for (const combo of [['E1'], ['E3'], ['E1', 'E3'], ['E1', 'E2', 'E3']]) {
  const out = { full: [0, 0], trial: [0, 0] };
  for (const [id, a] of Object.entries(by)) { const it = its.get(id); if (!it) continue;
    it.figs.forEach((f, i) => { const s = {}; for (const v of combo) { const p = probs(v, a[v], i); for (const e of EMOTIONS) s[e] = (s[e] || 0) + (Number(p[e]) || 0); }
      const top = Object.entries(s).sort((x, y) => y[1] - x[1])[0][0]; out[it.kind][1]++; if (top === f.label) out[it.kind][0]++; }); }
  console.log(combo.join('+').padEnd(10), `full ${out.full[0]}/${out.full[1]} = ${(100 * out.full[0] / out.full[1]).toFixed(1)}%  trial ${out.trial[0]}/${out.trial[1]} = ${(100 * out.trial[0] / out.trial[1]).toFixed(1)}%`);
}
