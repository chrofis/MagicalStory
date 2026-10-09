/**
 * Measure the idea Jev rubric (server/lib/ideaJevRubric.js) against stored trial cards.
 *
 *   node scripts/analysis/eval-jev-idea-rubric.js collect    # Jev calls -> evals/runs/2026-10-09_jev-idea-rubric/answers.jsonl (resumable)
 *   node scripts/analysis/eval-jev-idea-rubric.js analyze    # metrics, combined score, pick, gate (no calls)
 *   node scripts/analysis/eval-jev-idea-rubric.js latency    # production-shaped call with the adopted set, per card, parallel
 *
 * Eval sets (docs/decisions.md 2026-10-09 "Jev idea rubric"):
 *   real        102 final trial cards (the 2026-10-09 coherence run, 3 arms, + the owner's 2 cards of that day); labels:
 *               forced/follows (hand, existing) and enjoy/buy/charcon/agency/agefit/topic/theme (hand, blind, rubric.md)
 *   mechanical  the 100 FIRST cards of that run with the generator's own CHECK verdict (JS-verified quote check) as the label
 *   control     cards changed on purpose (wrong topic / theme / age, a remark spliced in, sentence 2 or 3 from another card):
 *               the label is true by construction, the unchanged card is the clean negative
 * Cost: ~USD 0.00005 per call.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'evals/runs/2026-10-09_jev-idea-rubric');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_trial-idea-coherence');
const R = require(path.join(ROOT, 'server/lib/ideaJevRubric'));
const { callJev } = require(path.join(ROOT, 'server/lib/jevAudit'));

const ANSWERS = path.join(DIR, 'answers.jsonl');
const LABEL_KEYS = ['enjoy', 'buy', 'charcon', 'agency', 'agefit', 'topic', 'theme'];
const sentences = t => String(t).split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const shuffle = a => a.map(x => [rnd(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

// ───────── sets ─────────
function loadReal() {
  const pool = JSON.parse(fs.readFileSync(path.join(DIR, 'pool.json'), 'utf8'));
  const hol = {};
  for (const l of fs.readFileSync(path.join(DIR, 'labels-holistic.txt'), 'utf8').split('\n')) {
    const m = l.match(/^(b\d+) (\S{7})$/); if (!m) continue;
    hol[m[1]] = Object.fromEntries(LABEL_KEYS.map((k, i) => [k, m[2][i] === '-' ? null : +m[2][i]]));
  }
  return pool.map(p => ({
    set: 'real', id: p.id, blind: p.blind, cellId: p.cellId, world: p.world, arm: p.arm, text: p.text,
    ctx: { age: p.cell.age, topic: p.cell.category === 'life-challenge' ? p.cell.topic : '', theme: p.cell.theme || '', lang: p.cell.language.slice(0, 2) },
    lab: { ...hol[p.blind], forced: p.lab && p.lab.forced !== null ? +p.lab.forced : null, follows: p.lab && p.lab.follows !== null ? +p.lab.follows : null },
  }));
}
function loadMechanical() {
  const out = [];
  for (const arm of ['before', 'after', 'ruleonly']) {
    const o = JSON.parse(fs.readFileSync(path.join(RUN, `trial-${arm}`, 'out.json'), 'utf8'));
    for (const r of o.rows) for (const w of Object.keys(r.cards)) {
      const f = r.cards[w].first; if (!f || !f.idea) continue;
      out.push({ set: 'mechanical', id: `mech.${arm}.${r.cell.id}.${w}`, cellId: r.cell.id, text: f.idea, failure: f.ok ? null : f.failure,
        ctx: { age: r.cell.age, topic: r.cell.category === 'life-challenge' ? r.cell.topic : '', theme: r.cell.theme || '', lang: r.cell.language.slice(0, 2) } });
    }
  }
  return out;
}
const COMMENT = { de: 'Das ist zu verworren; hier die neue Idee:', fr: "Ce brouillon est faux; voici l'idée corrigée :" };
function buildControls(real) {
  const out = []; const N = 30;
  const good = (c, ...ks) => ks.every(k => c.lab[k] === 1);
  const pick = (pred) => shuffle(real.filter(pred)).slice(0, N);
  const topics = [...new Set(real.map(c => c.ctx.topic).filter(Boolean))];
  const themes = [...new Set(real.map(c => c.ctx.theme).filter(Boolean))];
  for (const c of pick(c => c.ctx.topic && good(c, 'topic', 'forced'))) {
    const other = topics.filter(t => t !== c.ctx.topic); const t = other[Math.floor(rnd() * other.length)];
    out.push({ ...c, set: 'control', kind: 'topic', id: `ctl.topic.${c.id}`, ctx: { ...c.ctx, topic: t }, lab: {} });
  }
  for (const c of pick(c => c.ctx.theme && good(c, 'theme'))) {
    const other = themes.filter(t => t !== c.ctx.theme); const t = other[Math.floor(rnd() * other.length)];
    out.push({ ...c, set: 'control', kind: 'theme', id: `ctl.theme.${c.id}`, ctx: { ...c.ctx, theme: t }, lab: {} });
  }
  for (const c of pick(c => good(c, 'agefit'))) {
    const a = c.ctx.age <= 5 ? 12 : 3;
    out.push({ ...c, set: 'control', kind: 'age', id: `ctl.age.${c.id}`, ctx: { ...c.ctx, age: a }, lab: {} });
  }
  for (const c of pick(c => good(c, 'enjoy', 'buy') && sentences(c.text).length >= 2)) {
    const s = sentences(c.text); const txt = [s[0], '', COMMENT[c.ctx.lang] || COMMENT.de, '', ...s.slice(1)].join('\n');
    out.push({ ...c, set: 'control', kind: 'commentary', id: `ctl.comment.${c.id}`, text: txt, lab: {} });
  }
  const three = real.filter(c => sentences(c.text).length === 3);
  for (const kind of ['slot2', 'slot3']) {
    const idx = kind === 'slot2' ? 1 : 2;
    for (const c of shuffle(three.filter(c => c.lab.follows === 1 && c.lab.agency === 1)).slice(0, N)) {
      const donors = three.filter(d => d.ctx.lang === c.ctx.lang && d.cellId !== c.cellId);
      const d = donors[Math.floor(rnd() * donors.length)];
      const s = sentences(c.text); s[idx] = sentences(d.text)[idx];
      out.push({ ...c, set: 'control', kind, id: `ctl.${kind}.${c.id}`, text: s.join(' '), lab: {} });
    }
  }
  return out;
}

// ───────── collect ─────────
function readAnswers() {
  const m = new Map();
  if (fs.existsSync(ANSWERS)) for (const l of fs.readFileSync(ANSWERS, 'utf8').split('\n')) if (l.trim()) { const r = JSON.parse(l); m.set(r.id, r); }
  return m;
}
const ALL_SEL = () => {
  // every phrasing of every question: ID__K for each defined K
  const sel = [];
  for (const [id, def] of Object.entries(R.RUBRIC)) for (const k of ['A', 'B', 'S', 'C']) if (def[k]) sel.push([id, k]);
  return sel;
};
function requestAll(card) {
  const questions = {}; const keys = [];
  for (const [id, k] of ALL_SEL()) {
    if (!R.applicableIds(card.ctx, [id]).length) continue;
    const q = R.RUBRIC[id][k].q(card.ctx);
    questions[`${id}__${k}`] = typeof q === 'string' ? { type: 'noul', instructions: q } : q;
    keys.push({ key: `${id}__${k}`, id, ph: k });
  }
  return { state: R.buildRubricState(card.text, card.ctx), questions, keys };
}
async function collect() {
  const real = loadReal();
  const cards = [...real, ...loadMechanical(), ...buildControls(real)];
  fs.writeFileSync(path.join(DIR, 'cards.json'), JSON.stringify(cards, null, 1));
  const have = readAnswers();
  const todo = cards.filter(c => !have.has(c.id));
  console.log(`cards ${cards.length}, to ask ${todo.length}`);
  let spend = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const c = todo[i++]; const rq = requestAll(c); const t0 = Date.now();
      const r = await callJev({ state: rq.state, questions: rq.questions });
      spend += r.cost;
      fs.appendFileSync(ANSWERS, JSON.stringify({ id: c.id, ms: Date.now() - t0, cost: r.cost, nq: rq.keys.length, p: R.readRubricAnswers(r.answers, rq.keys) }) + '\n');
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`done, spend USD ${spend.toFixed(4)}`);
}

// ───────── metrics ─────────
function auc(pos, neg) { if (!pos.length || !neg.length) return NaN; let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return s / (pos.length * neg.length); }
const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function prf(rows, thr) { // flag = score < thr; positives of interest = bad (good===0)
  const fl = rows.filter(r => r.p < thr); const bad = rows.filter(r => !r.good);
  const tp = fl.filter(r => !r.good).length;
  return { flagged: fl.length, rate: fl.length / rows.length, precision: fl.length ? tp / fl.length : NaN, recall: bad.length ? tp / bad.length : NaN };
}
function bestF1(rows) {
  let best = { f: -1 };
  for (let t = 0.05; t <= 0.96; t += 0.025) { const m = prf(rows, t); const f = m.precision + m.recall ? 2 * m.precision * m.recall / (m.precision + m.recall) : 0; if (f > best.f) best = { f, t: +t.toFixed(3), ...m }; }
  return best;
}

function analyze() {
  const cards = JSON.parse(fs.readFileSync(path.join(DIR, 'cards.json'), 'utf8'));
  const ans = readAnswers();
  const byId = new Map(cards.map(c => [c.id, c]));
  const P = (id, key) => { const a = ans.get(id); return a ? a.p[key] : undefined; };
  const real = cards.filter(c => c.set === 'real');
  const results = []; // per question/phrasing/label
  const add = (q, ph, label, rows, extra = {}) => {
    const pos = rows.filter(r => r.good).map(r => r.p), neg = rows.filter(r => !r.good).map(r => r.p);
    if (pos.length < 3 || neg.length < 3) { results.push({ q, ph, label, nGood: pos.length, nBad: neg.length, auc: null, ...extra }); return; }
    const b = bestF1(rows);
    results.push({ q, ph, label, nGood: pos.length, nBad: neg.length, auc: +auc(pos, neg).toFixed(3), bestT: b.t, precision: +b.precision.toFixed(2), recall: +b.recall.toFixed(2), ...extra });
  };
  const phs = id => ['A', 'B', 'S', 'C'].filter(k => R.RUBRIC[id][k]);
  // which label tests which question
  const realLabel = { FORCED: 'forced', FOLLOWS: 'follows', TOPIC_ACT: 'topic', THEME: 'theme', AGE_FIT: 'agefit', AGENCY: 'agency', CHAR_CONSISTENT: 'charcon', KID_ENJOY: 'enjoy', PARENT_BUY: 'buy' };
  for (const [q, lab] of Object.entries(realLabel)) for (const ph of phs(q)) {
    const rows = real.filter(c => c.lab[lab] !== null && c.lab[lab] !== undefined && P(c.id, `${q}__${ph}`) !== undefined).map(c => ({ p: P(c.id, `${q}__${ph}`), good: c.lab[lab] }));
    add(q, ph, `real:${lab}`, rows);
  }
  // quality-of-card target for the holistic questions that have no own label
  for (const q of ['WANT_EVENT', 'ACT_ON_EVENT', 'SETTLES', 'NAMED_IN_1', 'CHALLENGE', 'KID_ENJOY', 'PARENT_BUY', 'CHAR_CONSISTENT', 'AGENCY', 'FOLLOWS', 'FORCED']) for (const ph of phs(q)) {
    const rows = real.filter(c => P(c.id, `${q}__${ph}`) !== undefined).map(c => ({ p: P(c.id, `${q}__${ph}`), good: +isGood(c) }));
    add(q, ph, 'real:card-good', rows);
  }
  // mechanical
  for (const q of ['NAMED_IN_1', 'ACT_ON_EVENT', 'WANT_EVENT', 'SETTLES']) for (const ph of phs(q)) {
    const mech = cards.filter(c => c.set === 'mechanical');
    const bad = q === 'NAMED_IN_1' ? f => f === 'uses-not-in-slot-1' : q === 'ACT_ON_EVENT' ? f => /act/.test(f || '') : q === 'WANT_EVENT' ? f => /event|want/.test(f || '') : f => /result/.test(f || '');
    const rows = mech.filter(c => P(c.id, `${q}__${ph}`) !== undefined).map(c => ({ p: P(c.id, `${q}__${ph}`), good: bad(c.failure) ? 0 : 1 }));
    add(q, ph, 'mechanical:check-failure', rows);
  }
  // controls: control card = bad, the unchanged card = good
  const ctlTarget = { topic: ['TOPIC_ACT', 'FORCED'], theme: ['THEME'], age: ['AGE_FIT'], commentary: ['NO_COMMENTARY'], slot2: ['ACT_ON_EVENT', 'NAMED_IN_1', 'FOLLOWS'], slot3: ['SETTLES'] };
  for (const [kind, qs] of Object.entries(ctlTarget)) for (const q of qs) for (const ph of phs(q)) {
    const ctl = cards.filter(c => c.set === 'control' && c.kind === kind);
    const rows = [];
    for (const c of ctl) {
      const base = byId.get(c.id.replace(/^ctl\.[a-z0-9]+\./, ''));
      const pc = P(c.id, `${q}__${ph}`), pb = base && P(base.id, `${q}__${ph}`);
      if (pc === undefined || pb === undefined) continue;
      rows.push({ p: pc, good: 0 }, { p: pb, good: 1 });
    }
    add(q, ph, `control:${kind}`, rows);
  }
  fs.writeFileSync(path.join(DIR, 'per-question.json'), JSON.stringify(results, null, 1));
  const fmt = r => `${r.q.padEnd(16)} ${r.ph} ${r.label.padEnd(26)} good ${String(r.nGood).padStart(3)} bad ${String(r.nBad).padStart(3)}  AUC ${r.auc === null ? '  - ' : r.auc.toFixed(2)}  P/R@best ${r.auc === null ? '' : `${r.precision}/${r.recall} t=${r.bestT}`}`;
  console.log(results.map(fmt).join('\n'));
  base = { cards, ans, byId, P, real };
  return results;
}
let base;

// the card is "good" when none of the hand labels fails (topic/theme/forced only where they apply)
function isGood(c) {
  const L = c.lab;
  return ['forced', 'follows', 'enjoy', 'buy', 'charcon', 'agency', 'agefit', 'topic', 'theme'].every(k => L[k] === null || L[k] === undefined || L[k] === 1);
}

// ───────── combined card score: fit on half the cells, test on the other half ─────────
const LABELS_FOR_QUALITY = ['forced', 'follows', 'enjoy', 'buy', 'charcon', 'agency', 'agefit', 'topic', 'theme'];
const failures = c => LABELS_FOR_QUALITY.filter(k => c.lab[k] === 0).length;
// AGE_FIT / THEME / NO_COMMENTARY have no failing card in the real set (all hand labels 1), so they cannot be weighted: they are tripwires (control-calibrated).
const VARIANTS = {
  all: ['FORCED', 'FOLLOWS', 'TOPIC_ACT', 'KID_ENJOY', 'PARENT_BUY', 'CHAR_CONSISTENT', 'AGENCY', 'CHALLENGE', 'ACT_ON_EVENT', 'NAMED_IN_1', 'WANT_EVENT'], // SETTLES left out: owner scope, an idea may stay open
  withSettles: ['FORCED', 'FOLLOWS', 'TOPIC_ACT', 'KID_ENJOY', 'PARENT_BUY', 'CHAR_CONSISTENT', 'AGENCY', 'CHALLENGE', 'SETTLES', 'ACT_ON_EVENT', 'NAMED_IN_1', 'WANT_EVENT'],
  holisticOnly: ['KID_ENJOY', 'PARENT_BUY', 'CHAR_CONSISTENT'],
  noCoherence: ['TOPIC_ACT', 'KID_ENJOY', 'PARENT_BUY', 'CHAR_CONSISTENT', 'AGENCY', 'CHALLENGE', 'SETTLES', 'ACT_ON_EVENT', 'NAMED_IN_1', 'WANT_EVENT'],
};
let QS = VARIANTS.all;

/** On a training set: per question the phrasing with the best AUC for "card good"; keep AUC >= minAuc; weight = AUC - 0.5. */
function fitWeights(train, P, minAuc = 0.62) {
  const w = {}; const ph = {};
  for (const q of QS) {
    let best = null;
    for (const k of ['A', 'B', 'S', 'C'].filter(k => R.RUBRIC[q][k])) {
      const rows = train.map(c => ({ p: P(c.id, `${q}__${k}`), good: isGood(c) })).filter(r => r.p !== undefined);
      const pos = rows.filter(r => r.good).map(r => r.p), neg = rows.filter(r => !r.good).map(r => r.p);
      if (pos.length < 5 || neg.length < 5) continue;
      const a = auc(pos, neg); if (!best || a > best.a) best = { k, a };
    }
    if (best && best.a >= minAuc) { w[q] = best.a - 0.5; ph[q] = best.k; }
  }
  return { w, ph };
}
function scoreOf(c, fit, P) {
  const p = {};
  for (const q of Object.keys(fit.w)) { const v = P(c.id, `${q}__${fit.ph[q]}`); if (v !== undefined) p[q] = v; }
  return R.cardScore(p, fit.w);
}
function pairsOf(cards) {
  const m = new Map();
  for (const c of cards) { const k = `${c.arm}.${c.cellId}`; (m.get(k) || m.set(k, []).get(k)).push(c); }
  return [...m.values()].filter(v => v.length === 2 && failures(v[0]) !== failures(v[1]));
}
function combine() {
  for (const [name, qs] of Object.entries(VARIANTS)) { QS = qs; console.log(`
=== variant ${name}: ${qs.join(', ')}`); combineOne(); }
  QS = VARIANTS.all;
}
function combineOne() {
  const cards = JSON.parse(fs.readFileSync(path.join(DIR, 'cards.json'), 'utf8'));
  const ans = readAnswers();
  const P = (id, key) => { const a = ans.get(id); return a ? a.p[key] : undefined; };
  const real = cards.filter(c => c.set === 'real' && ans.has(c.id));
  const cells = [...new Set(real.map(c => c.cellId))];
  const out = { splits: 0, auc: [], pick: [], pickBase: [], pickCoh: [], gate: {}, cardsBad: real.filter(c => !isGood(c)).length, cards: real.length };
  const fracs = [0.1, 0.15, 0.2, 0.3];
  for (const f of fracs) out.gate[f] = { precision: [], recall: [], rate: [] };
  const cohFit = { w: { FORCED: 1, FOLLOWS: 1 }, ph: { FORCED: 'A', FOLLOWS: 'A' } }; // production wording of the two coherence questions
  for (let s = 0; s < 200; s++) {
    seed = 1000 + s;
    const half = new Set(shuffle(cells).slice(0, Math.floor(cells.length / 2)));
    const train = real.filter(c => half.has(c.cellId)), test = real.filter(c => !half.has(c.cellId));
    const fit = fitWeights(train, P);
    if (!Object.keys(fit.w).length) continue;
    const tr = train.map(c => ({ p: scoreOf(c, fit, P), good: +isGood(c) }));
    const te = test.map(c => ({ c, p: scoreOf(c, fit, P), good: +isGood(c) }));
    if (!te.some(r => !r.good) || !te.some(r => r.good)) continue;
    out.splits++;
    out.auc.push(auc(te.filter(r => r.good).map(r => r.p), te.filter(r => !r.good).map(r => r.p)));
    const ch = test.map(c => ({ p: scoreOf(c, cohFit, P), good: +isGood(c) }));
    (out.aucCoh = out.aucCoh || []).push(auc(ch.filter(r => r.good).map(r => r.p), ch.filter(r => !r.good).map(r => r.p)));
    // pick
    const sc = new Map(te.map(r => [r.c.id, r.p]));
    const coh = new Map(test.map(c => [c.id, scoreOf(c, cohFit, P)]));
    for (const [a, b] of pairsOf(test)) {
      const better = failures(a) < failures(b) ? a : b, worse = better === a ? b : a;
      out.pick.push(sc.get(better.id) > sc.get(worse.id) ? 1 : sc.get(better.id) === sc.get(worse.id) ? 0.5 : 0);
      out.pickCoh.push(coh.get(better.id) > coh.get(worse.id) ? 1 : coh.get(better.id) === coh.get(worse.id) ? 0.5 : 0);
    }
    // gate at a flag budget set on TRAIN scores
    const sortedTr = tr.map(r => r.p).sort((x, y) => x - y);
    for (const f of fracs) {
      const thr = sortedTr[Math.max(0, Math.floor(f * sortedTr.length) - 1)];
      const rows = te.map(r => ({ p: r.p, good: r.good })); const m = prf(rows, thr + 1e-9);
      if (!Number.isNaN(m.precision)) out.gate[f].precision.push(m.precision);
      out.gate[f].recall.push(m.recall); out.gate[f].rate.push(m.rate);
    }
  }
  const mm = a => `${mean(a).toFixed(2)} (sd ${Math.sqrt(mean(a.map(x => (x - mean(a)) ** 2))).toFixed(2)})`;
  console.log(`splits ${out.splits}, cards ${out.cards}, bad ${out.cardsBad} (${(100 * out.cardsBad / out.cards).toFixed(0)}%)`);
  console.log(`held-out AUC card-good: ${mm(out.auc)}   (forced+follows prod wording alone: ${mm(out.aucCoh)})`);
  console.log(`PICK (pairs whose labels differ; n over splits ${out.pick.length}): combined ${mean(out.pick).toFixed(2)}, forced+follows prod wording ${mean(out.pickCoh).toFixed(2)}, chance 0.50`);
  for (const f of fracs) console.log(`GATE flag lowest ${f * 100}% (train threshold): test rerun rate ${mm(out.gate[f].rate)}, precision ${mm(out.gate[f].precision)}, recall ${mm(out.gate[f].recall)}`);
  // all-data fit (in-sample; these are the module's defaults)
  const full = fitWeights(real, P);
  console.log('ALL-DATA fit (in-sample):', JSON.stringify(full));
  const allRows = real.map(c => ({ p: scoreOf(c, full, P), good: +isGood(c) }));
  console.log('in-sample AUC', auc(allRows.filter(r => r.good).map(r => r.p), allRows.filter(r => !r.good).map(r => r.p)).toFixed(2));
  const pr = pairsOf(real); const scAll = new Map(real.map((c, i) => [c.id, allRows[i].p]));
  console.log('in-sample pick', mean(pr.map(([a, b]) => { const g = failures(a) < failures(b) ? a : b, w = g === a ? b : a; return scAll.get(g.id) > scAll.get(w.id) ? 1 : 0; })).toFixed(2), 'pairs', pr.length);
  if (QS === VARIANTS.all) { const g = real.filter(c => P(c.id, 'FORCED__A') !== undefined || c.ctx.topic === ''); const prod = real.map(c => ({ p: (P(c.id, 'FORCED__A') === undefined || P(c.id, 'FORCED__A') >= 0.8) && P(c.id, 'FOLLOWS__A') >= 0.6 ? 1 : 0, good: +isGood(c) })); const m = prf(prod, 0.5); console.log('production Jev gate (forced<0.8 or follows<0.6) on these 102 cards:', JSON.stringify(m)); }
  fs.writeFileSync(path.join(DIR, `combine-${Object.keys(VARIANTS).find(k => VARIANTS[k] === QS)}.json`), JSON.stringify({ ...out, full, allSortedScores: allRows.map(r => r.p).sort((a, b) => a - b) }, null, 1));
}

// ───────── tripwires: hard-fail questions calibrated on the controls, false-alarm rate read on the real cards ─────────
function tripwires() {
  const cards = JSON.parse(fs.readFileSync(path.join(DIR, 'cards.json'), 'utf8'));
  const ans = readAnswers();
  const P = (id, k) => ans.get(id).p[k];
  const real = cards.filter(c => c.set === 'real');
  for (const [q, ph, kind] of [['NO_COMMENTARY', 'A', 'commentary'], ['NO_COMMENTARY', 'B', 'commentary'], ['AGE_FIT', 'A', 'age'], ['AGE_FIT', 'S', 'age'], ['THEME', 'A', 'theme'], ['THEME', 'B', 'theme'], ['SETTLES', 'B', 'slot3'], ['SETTLES', 'A', 'slot3']]) {
    const ctl = cards.filter(c => c.set === 'control' && c.kind === kind); const k = `${q}__${ph}`;
    for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const rec = ctl.filter(c => P(c.id, k) < t).length / ctl.length;
      const rf = real.filter(c => (q !== 'THEME' || c.ctx.theme) && P(c.id, k) < t);
      console.log(`${q} ${ph} <${t}: control recall ${rec.toFixed(2)}; real cards flagged ${rf.length}/${real.length} ${rf.slice(0, 5).map(c => c.blind).join(',')}`);
    }
  }
}

// ───────── production-shaped call: the adopted set only, one call per card, two cards at a time (the pair offered to a visitor) ─────────
async function prodRun() {
  const cards = JSON.parse(fs.readFileSync(path.join(DIR, 'cards.json'), 'utf8')).filter(c => c.set === 'real');
  const file = path.join(DIR, 'prod-answers.jsonl');
  const have = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  const todo = cards.filter(c => !have.has(c.id)); let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const c = todo[i++]; const rq = R.buildAdoptedRequest(c.text, c.ctx); const t0 = Date.now();
      const r = await callJev({ state: rq.state, questions: rq.questions });
      fs.appendFileSync(file, JSON.stringify({ id: c.id, ms: Date.now() - t0, cost: r.cost, nq: rq.keys.length, answers: r.answers, keys: rq.keys }) + '\n');
    }
  };
  await Promise.all(Array.from({ length: 2 }, worker));
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const ms = rows.map(r => r.ms).sort((a, b) => a - b);
  const ev = new Map(rows.map(r => [r.id, R.evaluateAdopted(r.answers, r.keys)]));
  const scored = cards.map(c => ({ c, ...ev.get(c.id), good: +isGood(c) }));
  console.log(`calls ${rows.length}, questions per call ${rows[0].nq}, latency p50 ${ms[ms.length >> 1]} ms, p90 ${ms[Math.floor(ms.length * 0.9)]} ms, max ${ms[ms.length - 1]} ms, cost/card USD ${mean(rows.map(r => r.cost)).toFixed(6)}`);
  console.log(`in-sample AUC (adopted weights, production-shaped call): ${auc(scored.filter(r => r.good).map(r => r.score), scored.filter(r => !r.good).map(r => r.score)).toFixed(2)}`);
  const sorted = scored.map(r => r.score).sort((a, b) => a - b);
  for (const f of [0.1, 0.15, 0.2, 0.3]) {
    const thr = sorted[Math.floor(f * sorted.length)];
    const m = prf(scored.map(r => ({ p: r.score, good: r.good })), thr);
    console.log(`flag score < ${thr.toFixed(3)} (lowest ${f * 100}%): rerun rate ${m.rate.toFixed(2)}, precision ${m.precision.toFixed(2)}, recall ${m.recall.toFixed(2)}  [in-sample]`);
  }
  console.log('tripwires tripped on real cards:', JSON.stringify(scored.filter(r => r.tripped.length).map(r => [r.c.blind, r.tripped])));
  const sc = new Map(scored.map(r => [r.c.id, r.score]));
  const pairs = pairsOf(scored.map(r => r.c));
  console.log('in-sample pick', mean(pairs.map(([a, b]) => { const g = failures(a) < failures(b) ? a : b, w = g === a ? b : a; return sc.get(g.id) > sc.get(w.id) ? 1 : sc.get(g.id) === sc.get(w.id) ? 0.5 : 0; })).toFixed(2), 'pairs', pairs.length);
  console.log('owner day cards (staging idea_events, user 880b53c1):', scored.filter(r => r.c.arm === 'owner').map(r => `${r.c.id} score ${r.score.toFixed(2)} tripped ${r.tripped.join(',') || '-'}`).join(' | '));
}

if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'collect') await collect();
    else if (cmd === 'analyze') analyze();
    else if (cmd === 'combine') combine();
    else if (cmd === 'tripwires') tripwires();
    else if (cmd === 'prod') await prodRun();
    else throw new Error('usage: collect | analyze | combine');
  })().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { loadReal, isGood };
