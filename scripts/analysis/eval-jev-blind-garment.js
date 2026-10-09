/**
 * Jev + code vs the blind compliance judge: the garment-vs-contract comparison.
 * Inputs: evals/runs/2026-10-09_jev-blind-eval/{raw,sample,labels}.json
 * (see jev-blind-extract.js / jev-blind-rows.js / jev-blind-pick.js; labels are hand-read, see labels-notes in the run folder).
 *   node scripts/analysis/eval-jev-blind-garment.js run     # paid: Jev calls, cached in garment-answers.json
 *   node scripts/analysis/eval-jev-blind-garment.js score   # free: metrics from the cache
 */
require('dotenv').config();
const fs = require('fs');
const { callJev } = require('../../server/lib/jevAudit');
const D = 'evals/runs/2026-10-09_jev-blind-eval/';
const raw = JSON.parse(fs.readFileSync(D + 'raw.json', 'utf8'));
const sample = JSON.parse(fs.readFileSync(D + 'sample.json', 'utf8'));
const labels = JSON.parse(fs.readFileSync(D + 'labels.json', 'utf8')); // {n: 'o' | 'M' | 'R:C' | 'U'}
const CACHE = D + 'garment-answers.json';
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const castContracts = r => { const v = raw.find(x => x.story === r.story && x.page === r.page && x.ver === r.ver); return (v ? v.contract : []).filter(c => c.outfit); };

// ---- (a) code-only exact compare: colour family per garment slot ----
const FAM = { blue: 'blue', navy: 'blue', cobalt: 'blue', 'sky-blue': 'blue', denim: 'blue', jeans: 'blue', grey: 'grey', gray: 'grey', charcoal: 'grey', brown: 'brown', tan: 'brown', beige: 'brown', khaki: 'brown', rust: 'orange', 'burnt-orange': 'orange', orange: 'orange', mustard: 'yellow', yellow: 'yellow', 'sunshine-yellow': 'yellow', golden: 'yellow', red: 'red', 'brick-red': 'red', maroon: 'red', 'deep-red': 'red', green: 'green', 'forest-green': 'green', olive: 'green', purple: 'purple', black: 'black', white: 'white', pink: 'pink' };
const UP = /(hoodie|sweatshirt|sweater|pullover|jacket|anorak|coat|gilet|vest|body warmer|shirt|blouse|t-shirt|top|cardigan|fleece|windbreaker|puffer|cloak|corset|turtleneck|dress)/;
const LOW = /(trousers|pants|jeans|shorts|skirt|corduroys?|dungarees?|overalls?|joggers|chinos|leggings|tights)/;
const FOOT = /(boots?|sneakers?|trainers?|shoes?|sandals?|wellingtons?)/;
function codeSlots(text) {
  const t = clean(text).toLowerCase().replace(/[;,.()]/g, ' , ');
  const out = { up: new Set(), low: new Set(), foot: new Set() };
  for (const p of t.split(/ , | and | over | under /)) {
    const cols = (p.match(/[a-z-]+/g) || []).map(w => FAM[w]).filter(Boolean);
    if (!cols.length) continue;
    const slot = LOW.test(p) ? 'low' : FOOT.test(p) ? 'foot' : UP.test(p) ? 'up' : null;
    if (slot) cols.forEach(c => out[slot].add(c));
  }
  return out;
}
function codeMismatch(contract, desc) {
  const a = codeSlots(contract), b = codeSlots(desc);
  let n = 0, bad = 0;
  for (const s of ['up', 'low', 'foot']) {
    if (!a[s].size || !b[s].size) continue; n++;
    if (![...b[s]].some(c => a[s].has(c))) bad++;
  }
  return { bad, n };
}

// ---- (b) Jev variants ----
const st = (contract, desc) => `CONTRACT (the outfit this character must wear): ${clean(contract)}\nDESCRIPTION (what a blind reader saw on the figure): ${clean(desc)}`;
const Q = {
  V1: { type: 'noul', instructions: 'The DESCRIPTION shows a different outfit from the CONTRACT: at least one garment is a different kind of garment, or a different main colour. Fabric, trim, fit and small details do not count.' },
  V2: { type: 'score', instructions: 'How well does the DESCRIPTION match the CONTRACT outfit, judged by the kind and the main colour of each garment? Fabric, trim, fit and small details are ignored.', criteria: ['a different outfit', 'most garments differ', 'about half of the garments differ', 'one garment differs in kind or main colour', 'the same outfit'] },
  V3a: { type: 'noul', instructions: "The upper-body garment the DESCRIPTION names is the same kind of garment as the CONTRACT's upper-body garment." },
  V3b: { type: 'noul', instructions: "The upper-body garment the DESCRIPTION names has the same main colour as the CONTRACT's upper-body garment." },
  V3c: { type: 'noul', instructions: "The lower-body garment the DESCRIPTION names is the same kind of garment as the CONTRACT's lower-body garment." },
  V3d: { type: 'noul', instructions: "The lower-body garment the DESCRIPTION names has the same main colour as the CONTRACT's lower-body garment." },
  V3e: { type: 'noul', instructions: "The footwear the DESCRIPTION names has the same main colour as the CONTRACT's footwear." },
};
// ROUND 2: only garments BOTH texts name are compared; a garment named by one text only is never a difference
const BOTH = ' Only garments that both the CONTRACT and the DESCRIPTION name are compared; a garment named by one text only is not a difference.';
const Q2 = {
  V1b: { type: 'noul', instructions: 'A garment that both texts name is a different kind of garment, or a different main colour, in the DESCRIPTION than in the CONTRACT. Fabric, trim, fit and small details do not count.' + BOTH },
  V2b: { type: 'score', instructions: 'How well do the garments that both texts name agree, by kind and by main colour? Fabric, trim, fit and small details are ignored.' + BOTH, criteria: ['every shared garment differs', 'most shared garments differ', 'about half of the shared garments differ', 'one shared garment differs in kind or main colour', 'all shared garments agree'] },
  V3f: { type: 'noul', instructions: "The upper-body garment (top, jacket or coat) the DESCRIPTION names is the same kind of garment as the CONTRACT's, or one of the two texts names no upper-body garment." },
  V3g: { type: 'noul', instructions: "The upper-body garment the DESCRIPTION names has the same main colour as the CONTRACT's, or one of the two texts names no upper-body garment." },
  V3h: { type: 'noul', instructions: "The lower-body garment the DESCRIPTION names is the same kind of garment as the CONTRACT's, or one of the two texts names no lower-body garment." },
  V3i: { type: 'noul', instructions: "The lower-body garment the DESCRIPTION names has the same main colour as the CONTRACT's, or one of the two texts names no lower-body garment." },
};
function castChoice(r) {
  const cs = castContracts(r);
  const crit = {}; cs.forEach((c, i) => { crit['c' + i] = c.name; }); crit.none = 'none of them';
  const state = cs.map(c => `OUTFIT OF ${c.name}: ${clean(c.outfit).slice(0, 600)}`).join('\n') + `\nDESCRIPTION (what a blind reader saw on one figure): ${clean(r.inv.clothing)}`;
  return { state, names: cs.map(c => c.name), q: { WHO: { type: 'choice', instructions: 'Whose contract outfit does the figure in the DESCRIPTION wear? Judge by the kind and main colour of the garments.', criteria: crit } } };
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { await fn(items[i++]); } })); }
async function run() {
  let cost = 0, calls = 0; const lat = [];
  const rows = sample.filter(r => labels[r.n] && labels[r.n] !== 'U');
  await pool(rows, 6, async r => {
    const key = String(r.n); cache[key] ||= {};
    const s = st(r.outfit, r.inv.clothing);
    for (const id of ['V1', 'V2']) if (!cache[key][id]) { const t = Date.now(); const a = await callJev({ state: s, questions: { [id]: Q[id] } }); lat.push(Date.now() - t); cost += a.cost; calls++; cache[key][id] = a.answers[id]; }
    if (!cache[key].V3) { const qs = {}; for (const k of ['V3a', 'V3b', 'V3c', 'V3d', 'V3e']) qs[k] = Q[k]; const t = Date.now(); const a = await callJev({ state: s, questions: qs }); lat.push(Date.now() - t); cost += a.cost; calls++; cache[key].V3 = a.answers; }
    if (!cache[key].V4) { const c = castChoice(r); if (c.names.length) { const t = Date.now(); const a = await callJev({ state: c.state, questions: c.q }); lat.push(Date.now() - t); cost += a.cost; calls++; cache[key].V4 = { ...a.answers.WHO, names: c.names }; } }
  });
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  lat.sort((a, b) => a - b);
  console.log({ calls, cost: +cost.toFixed(5), p50ms: lat[Math.floor(lat.length / 2)], p95ms: lat[Math.floor(lat.length * 0.95)] });
}
async function run2() {
  let cost = 0, calls = 0;
  const rows = sample.filter(r => labels[r.n] && labels[r.n] !== 'U');
  await pool(rows, 6, async r => {
    const key = String(r.n); cache[key] ||= {}; const s = st(r.outfit, r.inv.clothing);
    for (const id of ['V1b', 'V2b']) if (!cache[key][id]) { const a = await callJev({ state: s, questions: { [id]: Q2[id] } }); cost += a.cost; calls++; cache[key][id] = a.answers[id]; }
    if (!cache[key].V3r2) { const qs = {}; for (const k of ['V3f', 'V3g', 'V3h', 'V3i']) qs[k] = Q2[k]; const a = await callJev({ state: s, questions: qs }); cost += a.cost; calls++; cache[key].V3r2 = a.answers; }
  });
  fs.writeFileSync(CACHE, JSON.stringify(cache)); console.log({ calls, cost: +cost.toFixed(5) });
}
// ---- metrics ----
const auc = (pos, neg) => { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return pos.length && neg.length ? w / (pos.length * neg.length) : NaN; };
const pr = (items, thr) => { let tp = 0, fp = 0, fn = 0; for (const [s, y] of items) { const f = s >= thr; if (f && y) tp++; else if (f && !y) fp++; else if (!f && y) fn++; } return { tp, fp, fn, prec: +(tp / (tp + fp || 1)).toFixed(2), rec: +(tp / (tp + fn || 1)).toFixed(2) }; };
function score() {
  const rows = sample.filter(r => labels[r.n] && labels[r.n] !== 'U');
  const textMis = r => (labels[r.n] === 'o' ? 0 : 1);
  const realMis = r => (/^R/.test(labels[r.n]) ? 1 : 0);
  const have = rows.filter(r => cache[r.n] && cache[r.n].V3 && cache[r.n].V4 && cache[r.n].V1b);
  console.log('rows', rows.length, 'with answers', have.length, 'o', have.filter(r => labels[r.n] === 'o').length, 'M', have.filter(r => labels[r.n] === 'M').length, 'R', have.filter(r => /^R/.test(labels[r.n])).length);
  const V = {
    code: r => codeMismatch(r.outfit, r.inv.clothing).bad,
    V1_noul: r => cache[r.n].V1.noul,
    V2_score: r => 4 - cache[r.n].V2.score,
    V3_decomp_all: r => 1 - Math.min(...['V3a', 'V3b', 'V3c', 'V3d', 'V3e'].map(k => cache[r.n].V3[k].noul)),
    V3_decomp_nofoot: r => 1 - Math.min(...['V3a', 'V3b', 'V3c', 'V3d'].map(k => cache[r.n].V3[k].noul)),
    V3_colour_only: r => 1 - Math.min(...['V3b', 'V3d'].map(k => cache[r.n].V3[k].noul)),
    R2_V1b: r => cache[r.n].V1b.noul,
    R2_V2b_score: r => 4 - cache[r.n].V2b.score,
    R2_V3_decomp: r => 1 - Math.min(...['V3f', 'V3g', 'V3h', 'V3i'].map(k => cache[r.n].V3r2[k].noul)),
    R2_V3_colour: r => 1 - Math.min(...['V3g', 'V3i'].map(k => cache[r.n].V3r2[k].noul)),
    R2_V3_kind: r => 1 - Math.min(...['V3f', 'V3h'].map(k => cache[r.n].V3r2[k].noul)),
    R2_code_and_V2b: r => (codeMismatch(r.outfit, r.inv.clothing).bad > 0 ? 1 : 0) * (4 - cache[r.n].V2b.score),
    V4_not_own: r => 1 - (cache[r.n].V4.probabilities['c' + cache[r.n].V4.names.indexOf(r.name)] ?? 0),
  };
  const thrs = { code: 1, V2_score: 2, R2_V2b_score: 2, R2_code_and_V2b: 2 };
  const out = {};
  for (const [k, f] of Object.entries(V)) {
    const s = have.map(r => [f(r), textMis(r)]);
    out[k] = { aucText: +auc(s.filter(x => x[1]).map(x => x[0]), s.filter(x => !x[1]).map(x => x[0])).toFixed(3), thr: thrs[k] ?? 0.5, ...pr(s, thrs[k] ?? 0.5) };
  }
  console.log('TEXT-level mismatch (o=0, M and R=1)'); console.table(out);
  for (const base of ['V1_noul', 'V3_decomp_nofoot']) for (const noneThr of [0.2, 0.35, 0.5]) {
    const fl = have.map(r => { const pn = cache[r.n].V4.probabilities.none || 0; return [V[base](r) >= 0.5 && pn >= noneThr ? 1 : 0, realMis(r), labels[r.n]]; });
    const tp = fl.filter(x => x[0] && x[1]).length, fp = fl.filter(x => x[0] && !x[1]).length, fn = fl.filter(x => !x[0] && x[1]).length;
    console.log('pairing-aware flag', base, 'noneThr', noneThr, { flagged: tp + fp, realFlagged: tp, fp, missedReal: fn, fpOnO: fl.filter(x => x[0] && x[2] === 'o').length, fpOnM: fl.filter(x => x[0] && x[2] === 'M').length });
  }
  const G = new Set(['clothing', 'garment_colour', 'clothing_detail']);
  const jf = have.map(r => [r.blind.some(b => G.has(b.type)) ? 1 : 0, realMis(r), labels[r.n]]);
  const tp = jf.filter(x => x[0] && x[1]).length, fp = jf.filter(x => x[0] && !x[1]).length, fn = jf.filter(x => !x[0] && x[1]).length;
  console.log('blind judge garment findings vs REAL', { flagged: tp + fp, tp, fp, fn, fpOnO: jf.filter(x => x[0] && x[2] === 'o').length, fpOnM: jf.filter(x => x[0] && x[2] === 'M').length });
  console.log('blind judge vs TEXT-mismatch', pr(have.map(r => [r.blind.some(b => G.has(b.type)) ? 1 : 0, textMis(r)]), 1));
}
({ run, run2, score })[process.argv[2]]?.() || console.log('usage: run | score');
