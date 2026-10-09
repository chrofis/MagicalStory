#!/usr/bin/env node
/**
 * FOOTING per figure (FOOTING_VALUES: ground | swimming | aboard | airborne) decided by Jev instead of the Art Director,
 * on the 5 stored full staging stories that carry the field (98 figures). Reading labels (evaluator, before any Jev call):
 * every figure `ground` except t0t8qpebu p4-p10,p12 `swimming` (children with a fin in the sea) and nwi88y9lr p7-p13
 * `aboard` (on the ship: the AD wrote ground on p13 where the text has Facundo at the ship's rail).
 *   node scripts/analysis/eval-jev-brief-footing.js run|score
 * Variants: F1 CHOICE over the four values; F2 SCORE over the four; F3 decomposed nouls per value (argmax).
 * see docs/decisions.md 2026-10-09 "Jev decides the brief metadata?"
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const { FOOTING_VALUES } = require('../../server/lib/shotVocabulary');
const { stripPlanShot } = require('../../server/lib/jevDecisions');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-brief-metadata');
const ANS = path.join(RUN, 'footing_answers.jsonl');
const DEF = { ground: 'on solid ground: any standable surface such as a bank, sand, floor, ice, stair or rock', swimming: 'swimming: in the water with no footing', aboard: 'aboard: on a vessel, vehicle or mount', airborne: 'airborne: flying, leaping or falling' };
const labelOf = (sid, n) => (sid === 't0t8qpebu' && ((n >= 4 && n <= 10) || n === 12)) ? 'swimming' : (sid === 'nwi88y9lr' && n >= 7 && n <= 13) ? 'aboard' : 'ground';
function items() {
  const S = JSON.parse(fs.readFileSync(path.join(RUN, 'stories.json'), 'utf8'));
  const out = [];
  for (const s of S) for (const p of s.pages) {
    const f = p.fd; if (!f || !(f.characters || []).some(c => c.footing)) continue;
    const story = s.pages.filter(x => x.n > 0).map(x => `--- Page ${x.n}${x.n === p.n ? ' (PAGE TO JUDGE)' : ''} ---\n${String(x.text).trim()}`).join('\n\n');
    out.push({ id: `${s.sid}#p${p.n}`, sid: s.sid, page: p.n, figs: f.characters.map(c => ({ name: c.name, ad: c.footing, label: labelOf(s.sid, p.n) })),
      state: `THE STORY TEXT:\n${story}\n\nTHE PICTURE PLAN OF THE PAGE TO JUDGE (who is in frame — the instant the picture shows — what is true after):\nPage ${p.n}: ${stripPlanShot(p.plan)}` });
  }
  return out;
}
const when = 'in the instant of the page to judge';
function requests(it) {
  const qs = (k) => Object.fromEntries(it.figs.map((f, i) => [`F${i}`, k === 'F1' ? { type: 'choice', instructions: `What ${f.name} is on ${when}.`, criteria: DEF }
    : { type: 'score', instructions: `What ${f.name} is on ${when}.`, criteria: FOOTING_VALUES.map(v => DEF[v]) }]));
  const f3 = {}; it.figs.forEach((f, i) => FOOTING_VALUES.forEach(v => { f3[`F${i}_${v}`] = { type: 'noul', instructions: `${f.name} is ${DEF[v]} ${when}.` }; }));
  return [{ variant: 'F1', state: it.state, questions: qs('F1') }, { variant: 'F2', state: it.state, questions: qs('F2') }, { variant: 'F3', state: it.state, questions: f3 }];
}
async function run() {
  const tasks = items().flatMap(it => requests(it).map(rq => ({ it, rq })));
  let i = 0, spent = 0;
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < tasks.length) { const { it, rq } = tasks[i++]; const t0 = Date.now(); const r = await J.callJev({ state: rq.state, questions: rq.questions }); spent += r.cost;
    fs.appendFileSync(ANS, JSON.stringify({ id: it.id, variant: rq.variant, ms: Date.now() - t0, cost: r.cost, answers: r.answers }) + '\n'); } }));
  console.log(`${tasks.length} calls $${spent.toFixed(4)}`);
}
function pick(v, a, i) {
  if (v === 'F1') return a[`F${i}`].choice;
  if (v === 'F2') { const p = a[`F${i}`].probabilities; return FOOTING_VALUES[Object.keys(p).sort((x, y) => p[y] - p[x])[0]]; }
  return FOOTING_VALUES.map(x => [x, a[`F${i}_${x}`].noul]).sort((x, y) => y[1] - x[1])[0][0];
}
function score() {
  const its = new Map(items().map(x => [x.id, x]));
  const rows = fs.readFileSync(ANS, 'utf8').trim().split('\n').map(JSON.parse);
  let adHit = 0, n = 0; for (const it of its.values()) for (const f of it.figs) { n++; if (f.ad === f.label) adHit++; }
  console.log(`AD ${adHit}/${n}`);
  for (const v of ['F1', 'F2', 'F3']) { let h = 0, m = 0; const miss = []; const ms = [];
    for (const r of rows.filter(r => r.variant === v)) { const it = its.get(r.id); ms.push(r.ms); it.figs.forEach((f, i) => { m++; const p = pick(v, r.answers, i); if (p === f.label) h++; else miss.push(`${r.id}:${f.name} ${f.label}->${p}`); }); }
    ms.sort((a, b) => a - b); console.log(v, `${h}/${m}`, `p50 ${ms[Math.floor(ms.length / 2)]}ms`, miss.slice(0, 12).join(' | ')); }
}
module.exports = { items };
if (require.main === module) ({ run, score }[process.argv[2]] || (() => console.log('run|score')))();
