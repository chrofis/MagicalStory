#!/usr/bin/env node
// Scores the sentence-level Jev lenses against the reading labels of the real panel findings.
require('dotenv').config();
const fs = require('fs'), path = require('path');
const E = require('./eval-jev-arc-panel');
const L = JSON.parse(fs.readFileSync(path.join(E.RUN, 'labels.json')));
const rows = fs.readFileSync(path.join(E.RUN, 'sent_answers.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const books = E.books;
// cluster -> cited sentences
const clusters = [];   // {book, ids, sents:Set, models:Set}
books.forEach((b, bi) => {
  const fm = {};
  b.report.rounds[0].panel.forEach((p, k) => p.findings.forEach(f => { fm[String.fromCharCode(65 + k) + f.rank] = f.sentences; }));
  (L.realClusters[bi] || []).forEach(ids => clusters.push({ book: bi, ids, sents: new Set(ids.flatMap(i => fm[i])), models: new Set(ids.map(i => i[0])) }));
});
const nSent = books.map(b => E.splitArc(b).sents.length);
const pos = books.map((b, bi) => new Set(clusters.filter(c => c.book === bi).flatMap(c => [...c.sents])));
const auc = (p, n) => { if (!p.length || !n.length) return null; let w = 0; for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0; return w / (p.length * n.length); };
// per (variant, rep, lens) -> map book|n -> score
function scores(v, rep, lens) {
  const m = {};
  rows.filter(r => r.v === v && r.rep === rep).forEach(r => {
    const a = r.answers; let s;
    if (v === 'V3') { const pr = a.SC.probabilities; s = (pr['1'] || 0) * 0.5 + (pr['2'] || 0); if (lens === 'p2') s = pr['2'] || 0; }
    else s = a[lens]?.noul;
    if (s != null) m[`${r.book}|${r.n}`] = s;
  });
  return m;
}
function poolAuc(m) { const P = [], N = []; Object.entries(m).forEach(([k, s]) => { const [b, n] = k.split('|').map(Number); (pos[b].has(n) ? P : N).push(s); }); return auc(P, N); }
// within-book AUC mean (removes the book-level offset)
function bookAuc(m) { const xs = []; books.forEach((b, bi) => { const P = [], N = []; Object.entries(m).forEach(([k, s]) => { const [bb, n] = k.split('|').map(Number); if (bb !== bi) return; (pos[bi].has(n) ? P : N).push(s); }); const a = auc(P, N); if (a != null) xs.push(a); }); return xs.length ? xs.reduce((a, b) => a + b) / xs.length : null; }
function maxOf(v, rep, lenses) { const ms = lenses.map(l => scores(v, rep, l)); const out = {}; Object.keys(ms[0]).forEach(k => { out[k] = Math.max(...ms.map(m => m[k] ?? 0)); }); return out; }
const lensSets = { V1: Object.keys(E.V1), V2: Object.keys(E.V2) };
const flat = (a) => a.flat();
console.log('clusters', clusters.length, 'positive sentences', pos.reduce((a, s) => a + s.size, 0), 'of', nSent.reduce((a, b) => a + b, 0), '(base rate', (pos.reduce((a, s) => a + s.size, 0) / nSent.reduce((a, b) => a + b, 0)).toFixed(2) + ')');
const res = {};
for (const v of ['V1', 'V2']) {
  for (const l of lensSets[v]) { const m = scores(v, 0, l); const m2 = scores(v, 1, l); res[`${v}.${l}`] = { auc: poolAuc(m), bookAuc: bookAuc(m), flip05: flipRate(m, m2) }; }
  const m = maxOf(v, 0, lensSets[v]); res[`${v}.MAX`] = { auc: poolAuc(m), bookAuc: bookAuc(m), flip05: flipRate(m, maxOf(v, 1, lensSets[v])) };
}
const m3 = scores('V3', 0, 'mix'), m3b = scores('V3', 0, 'p2'); res['V3.score'] = { auc: poolAuc(m3), bookAuc: bookAuc(m3), flip05: null }; res['V3.p2'] = { auc: poolAuc(m3b), bookAuc: bookAuc(m3b), flip05: null };
const mAll = {}; const a1 = maxOf('V1', 0, lensSets.V1), a2 = maxOf('V2', 0, lensSets.V2); Object.keys(a1).forEach(k => { mAll[k] = Math.max(a1[k], a2[k]); }); res['V1+V2.MAX'] = { auc: poolAuc(mAll), bookAuc: bookAuc(mAll) };
function flipRate(m, m2, t = 0.5) { const ks = Object.keys(m).filter(k => k in m2); return ks.filter(k => (m[k] >= t) !== (m2[k] >= t)).length / ks.length; }
console.log('variant.lens'.padEnd(18), 'pooledAUC withinBookAUC flip@0.5');
Object.entries(res).forEach(([k, r]) => console.log(k.padEnd(18), (r.auc ?? NaN).toFixed(3), (r.bookAuc ?? NaN).toFixed(3), r.flip05 == null ? '-' : r.flip05.toFixed(3)));

// top-k per book (k=3, like one panelist): cluster recall + finding precision vs random
function topk(m, k = 3) { const hit = new Set(); let flags = 0, flagHit = 0; books.forEach((b, bi) => { const arr = Object.entries(m).filter(([kk]) => kk.startsWith(bi + '|')).map(([kk, s]) => [+kk.split('|')[1], s]).sort((x, y) => y[1] - x[1]).slice(0, k); arr.forEach(([n]) => { flags++; const cs = clusters.filter(c => c.book === bi && c.sents.has(n)); if (cs.length) flagHit++; cs.forEach(c => hit.add(c)); }); }); return { recall: hit.size / clusters.length, prec: flagHit / flags, hit }; }
function randomTopk(k = 3, N = 2000) { let r = 0, p = 0; for (let t = 0; t < N; t++) { const hit = new Set(); let fl = 0, fh = 0; books.forEach((b, bi) => { const idx = [...Array(nSent[bi]).keys()].map(i => i + 1).sort(() => Math.random() - .5).slice(0, k); idx.forEach(n => { fl++; const cs = clusters.filter(c => c.book === bi && c.sents.has(n)); if (cs.length) fh++; cs.forEach(c => hit.add(c)); }); }); r += hit.size / clusters.length; p += fh / fl; } return { recall: r / N, prec: p / N }; }
console.log('\ntop-3 sentences per book (lenient sentence-overlap match):');
const rnd = randomTopk(); console.log('random'.padEnd(14), 'cluster recall', rnd.recall.toFixed(2), 'flag precision', rnd.prec.toFixed(2));
for (const [name, m] of [['V1.MAX', maxOf('V1', 0, lensSets.V1)], ['V2.MAX', maxOf('V2', 0, lensSets.V2)], ['V1+V2.MAX', mAll], ['V3.score', m3]]) { const t = topk(m); console.log(name.padEnd(14), 'cluster recall', t.recall.toFixed(2), `(${t.hit.size}/${clusters.length})`, 'flag precision', t.prec.toFixed(2)); }
// the panelists themselves (strict: finding is in a real cluster)
['A', 'B', 'C'].forEach(L2 => { const n = clusters.filter(c => c.models.has(L2)).length; console.log(`panelist ${L2}`, 'real clusters found', n, '/', clusters.length); });
module.exports = { clusters, pos, nSent, scores, maxOf, topk, lensSets, mAll };
