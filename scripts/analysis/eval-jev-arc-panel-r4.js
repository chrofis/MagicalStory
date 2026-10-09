#!/usr/bin/env node
// Round 4: TYPE-MATCHED narrow questions, prefix state (arc up to the sentence) so nothing later leaks in.
// Typed target sentences = the exact sentence where my reading says the real panel finding bites.
require('dotenv').config();
const fs = require('fs'), path = require('path');
const E = require('./eval-jev-arc-panel'); const J = require('../../server/lib/jevAudit');
const OUT = path.join(E.RUN, 'r4_answers.jsonl');
const TARGETS = {
  OBJ: [[0, 4], [1, 3], [2, 4], [8, 11], [12, 4], [3, 9]],
  SENSE: [[6, 2], [9, 4], [12, 4], [11, 4], [14, 10], [15, 7], [15, 15], [13, 9], [0, 3]],
  WHYNOT: [[2, 9], [3, 6], [4, 6], [14, 7], [0, 2], [8, 16]],
  PROMISE: [[7, 3], [5, 7], [5, 10], [13, 17], [5, 14], [6, 14], [5, 14]],
  GIVEWAY: [[4, 8], [9, 4], [7, 9]],
};
const Q = {
  OBJ: { a: 'The last sentence has a character use, wear, hold or give a thing that none of the earlier sentences or lines of the story logic has mentioned.',
         b: 'In the last sentence a thing appears in someone\'s hands that the reader has never been told they had.',
         c: 'Before the last sentence the reader did not know that this thing existed or that this character had it.' },
  SENSE: { a: 'The last sentence cannot happen as written, given a limit, a place or a fact stated earlier.',
           b: 'The last sentence contradicts a fact or a limit stated earlier about a character, a place, a creature or a rule of the world.',
           c: 'A character in the last sentence does what the story logic says the character cannot do, or stays where an earlier sentence already moved them away.' },
  WHYNOT: { a: 'A child would ask why, in the last sentence, the characters do not simply take an easier way than the one they take.',
            b: 'The last sentence leaves open an obvious simpler option that the story never rules out.',
            c: 'Nothing earlier explains why the characters cannot just do the thing the last sentence needs a harder way.' },
};
async function main() {
  const done = new Set(fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return a.book + '|' + a.n; }) : []);
  const tasks = [];
  E.books.forEach((b, bi) => { const { head, sents } = E.splitArc(b); sents.forEach(s => {
    if (done.has(bi + '|' + s.n)) return;
    const state = `${head}\n\nARC so far:\n${sents.filter(x => x.n <= s.n).map(x => `${x.n}. ${x.text}`).join('\n')}\n\n(The last sentence is number ${s.n}.)`;
    const qs = {}; for (const [t, vs] of Object.entries(Q)) for (const [k, v] of Object.entries(vs)) qs[`${t}_${k}`] = { type: 'noul', instructions: v };
    tasks.push({ book: bi, n: s.n, state, qs }); }); });
  let i = 0, cost = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < tasks.length) { const t = tasks[i++]; try { const r = await J.callJev({ state: t.state, questions: t.qs }); cost += r.cost; fs.appendFileSync(OUT, JSON.stringify({ book: t.book, n: t.n, answers: r.answers }) + '\n'); } catch (e) { console.error('fail', t.book, t.n, e.message.slice(0, 100)); } } }));
  console.log('calls', tasks.length, 'cost', cost.toFixed(4));
}
function score() {
  const rows = fs.readFileSync(OUT, 'utf8').trim().split('\n').map(JSON.parse);
  const auc = (p, n) => { let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? .5 : 0; return w / (p.length * n.length); };
  for (const t of Object.keys(Q)) for (const k of Object.keys(Q[t])) {
    const id = `${t}_${k}`, P = [], N = [], tg = new Set(TARGETS[t].map(([b, n]) => b + '|' + n)); const books = new Set(TARGETS[t].map(([b]) => b));
    rows.forEach(r => { if (!books.has(r.book)) return; (tg.has(r.book + '|' + r.n) ? P : N).push(r.answers[id].noul); });
    // rank of the target within its own book (1 = highest) averaged
    const ranks = []; TARGETS[t].forEach(([b, n]) => { const rs = rows.filter(r => r.book === b).map(r => [r.n, r.answers[id].noul]).sort((x, y) => y[1] - x[1]); ranks.push(rs.findIndex(x => x[0] === n) + 1 + '/' + rs.length); });
    console.log(id.padEnd(9), 'AUC', auc(P, N).toFixed(3), `targets ${P.length} others ${N.length}`, 'meanP target', (P.reduce((a, b) => a + b) / P.length).toFixed(2), 'others', (N.reduce((a, b) => a + b) / N.length).toFixed(2), 'ranks', ranks.join(' '));
  }
}
if (process.argv[2] === 'run') main(); else score();
