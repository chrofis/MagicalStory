#!/usr/bin/env node
// Figure-level (deed per figure) and story-level questions on the stored arcs, with injected controls.
// Part of the 2026-10-09 "can Jev do the arc panel's job" measurement (evals/runs/2026-10-09_jev-arc-panel).
require('dotenv').config();
const fs = require('fs'), path = require('path');
const E = require('./eval-jev-arc-panel'); const J = require('../../server/lib/jevAudit');
const L = JSON.parse(fs.readFileSync(path.join(E.RUN, 'labels.json')));
const OUT = path.join(E.RUN, 'fig_answers.jsonl');
const arcOnly = (b, drop) => { const { head, sents } = E.splitArc(b); return `${head}\n\nARC:\n${sents.filter(s => !(drop && drop(s))).map(s => `${s.n}. ${s.text}`).join('\n')}`; };
const first = n => n.replace(/^(the|das|der|die|kapitän|herr)\s+/i, '').split(/[\s/]/)[0];
const D = {
  D1: n => ({ type: 'noul', instructions: `In this story arc, ${n} does something that changes what happens in the story.` }),
  D2: n => ({ type: 'noul', instructions: `${n} does an act of their own in the arc that changes what happens next. This is false if ${n} only watches, waits, gives an order or a rule, comforts, is present or is named.` }),
  D3: n => ({ type: 'score', instructions: `What does ${n} contribute to the arc?`, criteria: [`${n} is not in the arc, or is only named, present, watching or waiting`, `${n} acts, but nothing that follows depends on the act`, `${n} does an act on which what happens next depends`] }),
  D5: n => ({ type: 'noul', instructions: `The arc would go differently if ${n} were taken out of it.` }),
  D6: n => ({ type: 'noul', instructions: `${n} has a want in the story logic, and the arc shows ${n} acting on that want.` }),
};
const S = {
  ESC: 'The danger or the cost for the main characters gets worse step by step before the turning point.',
  CAUSE: 'The turning point is caused by an act of the main characters themselves, not by luck or by someone else.',
  PAYOFF: 'Every object, rule, promise or ability the arc sets up is used or paid off later.',
  END: 'The last sentences give the characters what they wanted at the start.',
  ESC2: 'The stakes rise from the start to the low point.',
  CAUSE2: 'The characters solve the problem by their own act.',
  PAYOFF2: 'Nothing the arc sets up is left unused.',
  END2: 'The want stated in the story logic is fulfilled by the end of the arc.',
};
async function pool(tasks, fn) { let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < tasks.length) await fn(tasks[i++]); })); }
async function run() {
  const tasks = [], figs = [];
  E.books.forEach((b, bi) => {
    const fl = E.figures(b); const { sents } = E.splitArc(b); const state = arcOnly(b);
    const zero = new Set(L.deedZero[bi] || []);
    fl.forEach(f => {
      const label = zero.has(f.name) ? 0 : 1; figs.push({ book: bi, name: f.name, label });
      const qs = {}; Object.entries(D).forEach(([k, fn]) => { qs[k] = fn(f.name); });
      tasks.push({ kind: 'fig', book: bi, name: f.name, state, qs });
      const key = first(f.name).toLowerCase();
      const cut = arcOnly(b, s => s.text.toLowerCase().includes(key), l => l.toLowerCase().includes(key));
      if (cut !== state) tasks.push({ kind: 'figcut2', book: bi, name: f.name, state: cut, qs });
      sents.filter(s => s.text.toLowerCase().includes(key)).forEach(s => tasks.push({ kind: 'sent', book: bi, name: f.name, n: s.n, state: E.stateFor(b, s.n), qs: { D4: { type: 'noul', instructions: `In the marked sentence ${f.name} does something of their own that moves the story forward (not only present, named, spoken to or watching).` } } }));
    });
    const qs = Object.fromEntries(Object.entries(S).map(([k, v]) => [k, { type: 'noul', instructions: v }]));
    tasks.push({ kind: 'story', book: bi, state, qs });
    tasks.push({ kind: 'storyTrunc', book: bi, state: arcOnly(b, s => s.n > sents.length - 2), qs });
    const mid = sents.slice(1, -1).reverse(); const re = [sents[0], ...mid, sents.at(-1)];
    tasks.push({ kind: 'storyRev', book: bi, state: `${E.splitArc(b).head}\n\nARC:\n${re.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}`, qs });
  });
  fs.writeFileSync(path.join(E.RUN, 'figs.json'), JSON.stringify(figs));
  let cost = 0;
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return [a.kind, a.book, a.name, a.n].join('|'); }) : []);
  await pool(tasks.filter(t => !done.has([t.kind, t.book, t.name, t.n].join('|'))), async t => { const t0 = Date.now(); try { const r = await J.callJev({ state: t.state, questions: t.qs }); cost += r.cost; fs.appendFileSync(OUT, JSON.stringify({ kind: t.kind, book: t.book, name: t.name, n: t.n, ms: Date.now() - t0, answers: r.answers }) + '\n'); } catch (e) { console.error('fail', t.kind, t.book, e.message.slice(0, 100)); } });
  console.log('tasks', tasks.length, 'cost', cost.toFixed(4));
}
const val = a => a.type === 'score' ? (a.probabilities['1'] || 0) * 0.5 + (a.probabilities['2'] || 0) : a.noul;
const auc = (p, n) => { if (!p.length || !n.length) return NaN; let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? .5 : 0; return w / (p.length * n.length); };
function score() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse); const figs = JSON.parse(fs.readFileSync(path.join(E.RUN, 'figs.json')));
  const lab = Object.fromEntries(figs.map(f => [f.book + '|' + f.name, f.label]));
  const fr = rows.filter(r => r.kind === 'fig');
  console.log('FIGURES', figs.length, 'deed=0:', figs.filter(f => !f.label).length);
  for (const k of Object.keys(D)) {
    const P = fr.filter(r => lab[r.book + '|' + r.name] === 1).map(r => val(r.answers[k])), N = fr.filter(r => lab[r.book + '|' + r.name] === 0).map(r => val(r.answers[k]));
    let best = null; for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) { const tp = N.filter(x => x < t).length, fp = P.filter(x => x < t).length; const rec = tp / N.length, pr = tp / Math.max(1, tp + fp); if (!best || rec * pr > best.rec * best.pr) best = { t, rec, pr, tp, fp }; }
    const cut = rows.filter(r => r.kind === 'figcut2').map(r => val(r.answers[k])); const cutHigh = cut.filter(x => x >= 0.5).length;
    console.log(k.padEnd(3), 'AUC(deed=1 above deed=0)', auc(P, N).toFixed(3), `best low-flag t<${best.t}: recall ${best.tp}/${N.length} precision ${best.pr.toFixed(2)} (fp ${best.fp})`, `| injected removal still >=0.5: ${cutHigh}/${cut.length}`);
  }
  for (const k of ['D1','D3','D4']) { if (k==='D4') continue; const P = fr.filter(r => lab[r.book + '|' + r.name] === 1).map(r => val(r.answers[k])), N = fr.filter(r => lab[r.book + '|' + r.name] === 0).map(r => val(r.answers[k])); console.log(k, [0.2,0.35,0.5,0.65,0.8].map(t => `t<${t}: ${N.filter(x=>x<t).length}/${N.length} caught, ${P.filter(x=>x<t).length} false`).join(' | ')); }
  const m = {}; rows.filter(r => r.kind === 'sent').forEach(r => { const key = r.book + '|' + r.name; m[key] = Math.max(m[key] ?? 0, r.answers.D4.noul); });
  const P4 = [], N4 = []; figs.forEach(f => { const v = m[f.book + '|' + f.name] ?? 0; (f.label ? P4 : N4).push(v); });
  console.log('D4 max-over-sentences AUC', auc(P4, N4).toFixed(3), 'deed0 mean', (N4.reduce((a, b) => a + b, 0) / N4.length).toFixed(2), 'deed1 mean', (P4.reduce((a, b) => a + b, 0) / P4.length).toFixed(2));
  console.log('\nSTORY-level mean P (real / truncated last 2 / middle reversed); payoff=0 books', L.payoffZero.join(','));
  for (const k of Object.keys(S)) {
    const g = kind => rows.filter(r => r.kind === kind).map(r => r.answers[k].noul); const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const real = rows.filter(r => r.kind === 'story'); const pz = real.filter(r => L.payoffZero.includes(r.book)).map(r => r.answers[k].noul), po = real.filter(r => !L.payoffZero.includes(r.book)).map(r => r.answers[k].noul);
    console.log(k.padEnd(8), mean(g('story')).toFixed(2), mean(g('storyTrunc')).toFixed(2), mean(g('storyRev')).toFixed(2), '| payoff0 books', pz.map(x => x.toFixed(2)).join(','), 'others mean', mean(po).toFixed(2), '| AUC real>trunc', auc(g('story'), g('storyTrunc')).toFixed(2), 'real>rev', auc(g('story'), g('storyRev')).toFixed(2));
  }
  const ms = rows.map(r => r.ms); console.log('\ncalls', rows.length, 'p50 ms', ms.sort((a, b) => a - b)[ms.length >> 1]);
}
if (process.argv[2] === 'run') run(); else score();
