#!/usr/bin/env node
// Story-level Jev questions on stored STAGING TRIAL stories (6 pages, no arc panel), with injected controls and latency.
// Part of the 2026-10-09 arc-panel measurement. Data: evals/runs/2026-10-09_jev-arc-panel/trials.json (gitignored story text).
require('dotenv').config();
const fs = require('fs'), path = require('path');
const E = require('./eval-jev-arc-panel'); const J = require('../../server/lib/jevAudit');
const OUT = path.join(E.RUN, 'trial_answers.jsonl');
const trials = JSON.parse(fs.readFileSync(path.join(E.RUN, 'trials.json')));
const pagesOf = t => t.tx.split(/--- Page \d+ ---\n/).map(s => s.trim()).filter(Boolean);
const mk = pages => pages.map((p, i) => `[Page ${i + 1}]\n${p}`).join('\n\n');
const Q = {
  ESC: 'The problem gets harder before it gets solved.',
  OWN: 'The main character solves the problem by their own act, not by luck or by someone else.',
  PAYOFF: 'Every object, ability or rule the story sets up is used again later in the story.',
  END: 'The story ends with the problem from the start solved.',
  STALL: 'Two pages in a row show the same moment again without anything new happening.',
  ACTS: 'The main character does something on every page.',
  LOGICHOLE: 'At some point in the story something happens that the story itself has made impossible.',
};
async function run() {
  const tasks = [];
  trials.forEach((t, i) => {
    const pg = pagesOf(t); const other = pagesOf(trials[(i + 7) % trials.length]);
    tasks.push({ kind: 'real', i, state: mk(pg) });
    tasks.push({ kind: 'trunc', i, state: mk(pg.slice(0, 4)) });
    tasks.push({ kind: 'rev', i, state: mk([pg[0], ...pg.slice(1, -1).reverse(), pg.at(-1)]) });
    tasks.push({ kind: 'wrongend', i, state: mk([...pg.slice(0, -1), other.at(-1)]) });
  });
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return a.kind + '|' + a.i; }) : []);
  const qs = Object.fromEntries(Object.entries(Q).map(([k, v]) => [k, { type: 'noul', instructions: v }]));
  let cost = 0; const todo = tasks.filter(t => !done.has(t.kind + '|' + t.i)); let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (n < todo.length) { const t = todo[n++]; const t0 = Date.now(); try { const r = await J.callJev({ state: t.state, questions: qs }); cost += r.cost; fs.appendFileSync(OUT, JSON.stringify({ kind: t.kind, i: t.i, ms: Date.now() - t0, cost: r.cost, tokens: r.usage.input_tokens, answers: r.answers }) + '\n'); } catch (e) { console.error('fail', e.message.slice(0, 100)); } } }));
  console.log('calls', todo.length, 'cost', cost.toFixed(4));
}
const auc = (p, n) => { let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? .5 : 0; return w / (p.length * n.length); };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
function score() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse);
  const g = (kind, k) => rows.filter(r => r.kind === kind).map(r => r.answers[k].noul);
  console.log('trials', trials.length, 'stories; mean P real | trunc4 | rev | wrongend ; AUC real>control');
  for (const k of Object.keys(Q)) console.log(k.padEnd(10), mean(g('real', k)).toFixed(2), mean(g('trunc', k)).toFixed(2), mean(g('rev', k)).toFixed(2), mean(g('wrongend', k)).toFixed(2), '| AUC trunc', auc(g('real', k), g('trunc', k)).toFixed(2), 'rev', auc(g('real', k), g('rev', k)).toFixed(2), 'wrongend', auc(g('real', k), g('wrongend', k)).toFixed(2), '| real min', Math.min(...g('real', k)).toFixed(2), 'lowest 3 real:', rows.filter(r => r.kind === 'real').sort((a, b) => a.answers[k].noul - b.answers[k].noul).slice(0, 3).map(r => 'T' + r.i + '=' + r.answers[k].noul.toFixed(2)).join(' '));
  const ms = rows.filter(r => r.kind === 'real').map(r => r.ms).sort((a, b) => a - b); console.log('real-story call latency ms p50', ms[ms.length >> 1], 'p90', ms[Math.floor(ms.length * .9)], 'max', ms.at(-1), 'mean input tokens', Math.round(mean(rows.filter(r => r.kind === 'real').map(r => r.tokens))), 'cost/call', mean(rows.map(r => r.cost)).toFixed(6));
}
if (process.argv[2] === 'run') run(); else score();
