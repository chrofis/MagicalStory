#!/usr/bin/env node
/**
 * Jev as the decider of the per-figure brief metadata the Art Director still authors (owner, 2026-10-09:
 * "Metadata and review should come from Jev where possible"). EMOTION per figure, several ways of asking,
 * against reading labels written BEFORE any Jev call (scripts/analysis/jev-brief-metadata-labels-{full,trial}.txt),
 * on stored staging stories (full beats stories with an AD emotion; trial stories, whose scene hints come from the
 * single trial writer call and carry no emotion field at all).
 *
 *   node scripts/analysis/jev-brief-metadata-extract.js          # stories.json into the run folder
 *   node scripts/analysis/eval-jev-brief-metadata.js run [--reps=1] [--only=E1,E3] [--capUsd=0.30]
 *   node scripts/analysis/eval-jev-brief-metadata.js score
 *
 * Variants (state = the story text with the page marked, + the page's plan line on full stories):
 *   E1 one CHOICE per figure, the "as the story tells it" wording with described moods        (memory: the yellow phrasing)
 *   E2 same CHOICE, state = the page's own text + plan only
 *   E3 SCORE (criteria array = the seven moods), argmax of the level probabilities
 *   E4 DECOMPOSED nouls, one per figure per mood, argmax; neutral when no mood reaches 0.5
 *   E5 GATED: noul "a clear feeling other than calm" + a CHOICE among the six feelings; neutral when the gate < 0.5
 * see docs/decisions.md 2026-10-09 "Jev decides the brief metadata?"
 */
const path = require('path'); const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const { EMOTIONS, EMOTION_TONE } = require('../../server/lib/emotionVocabulary');
const { stripPlanShot } = require('../../server/lib/jevDecisions');
const RUN = path.join(ROOT, 'evals/runs/2026-10-09_jev-brief-metadata');
const ANS = path.join(RUN, 'emotion_answers.jsonl');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

const MOOD = {
  happy: 'happy, glad, excited, proud',
  sad: 'sad, disappointed, lonely, worried about a loss',
  angry: 'angry, cross, defiant',
  afraid: 'afraid, scared, nervous, worried about danger',
  surprised: 'surprised, amazed, startled',
  disgusted: 'disgusted',
  neutral: 'neutral: calm, attentive, concentrating, no strong feeling',
};

function readLabels(file) {
  const L = {}; let sid;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim() || l[0] === '#') continue;
    if (l[0] === '@') { sid = l.slice(1); continue; }
    const m = l.match(/^(\d+) (.+)$/);
    for (const kv of m[2].split(';')) { const [n, e] = kv.trim().split('='); L[`${sid}|${m[1]}|${n}`] = e; }
  }
  return L;
}

function items() {
  const S = JSON.parse(fs.readFileSync(path.join(RUN, 'stories.json'), 'utf8'));
  const lab = { full: readLabels(path.join(__dirname, 'jev-brief-metadata-labels-full.txt')), trial: readLabels(path.join(__dirname, 'jev-brief-metadata-labels-trial.txt')) };
  const out = [];
  for (const s of S) {
    const kind = s.pages.some(p => p.fd && (p.fd.characters || []).some(c => c.emotion)) ? 'full' : 'trial';
    for (const p of s.pages) {
      const f = p.fd; if (!f) continue;
      const figs = (f.characters || []).map(c => ({ name: c.name, ad: c.emotion || null, label: lab[kind][`${s.sid}|${p.n}|${c.name}`] || null })).filter(c => c.label);
      if (!figs.length) continue;
      const plan = kind === 'full' ? stripPlanShot(p.plan) : '';
      const story = s.pages.filter(x => x.n > 0).map(x => `--- Page ${x.n}${x.n === p.n ? ' (PAGE TO JUDGE)' : ''} ---\n${String(x.text).trim()}`).join('\n\n');
      const planTxt = plan ? `\n\nTHE PICTURE PLAN OF THE PAGE TO JUDGE (who is in frame — the instant the picture shows — what is true after):\nPage ${p.n}: ${plan}` : '';
      out.push({ id: `${s.sid}#p${p.n}`, kind, sid: s.sid, page: p.n, figs,
        stateFull: `THE STORY TEXT:\n${story}${planTxt}`,
        statePage: `THE PAGE TO JUDGE:\n${String(p.text).trim()}${planTxt}` });
    }
  }
  return out;
}

const when = 'at this moment of the page to judge, as the story tells it';
function requests(it) {
  const out = [];
  const choiceQs = () => Object.fromEntries(it.figs.map((f, i) => [`EMO${i}`, { type: 'choice', instructions: `The feeling ${f.name} has ${when}.`, criteria: MOOD }]));
  out.push({ variant: 'E1', state: it.stateFull, questions: choiceQs() });
  out.push({ variant: 'E2', state: it.statePage, questions: choiceQs() });
  out.push({ variant: 'E3', state: it.stateFull, questions: Object.fromEntries(it.figs.map((f, i) => [`EMO${i}`, { type: 'score', instructions: `Which feeling does ${f.name} have ${when}?`, criteria: EMOTIONS.map(e => MOOD[e]) }])) });
  const e4 = {};
  it.figs.forEach((f, i) => EMOTIONS.filter(e => e !== 'neutral').forEach(e => { e4[`EMO${i}_${e}`] = { type: 'noul', instructions: `${f.name} feels ${MOOD[e]} ${when}.` }; }));
  out.push({ variant: 'E4', state: it.stateFull, questions: e4 });
  const e5 = {};
  const six = Object.fromEntries(EMOTIONS.filter(e => e !== 'neutral').map(e => [e, MOOD[e]]));
  it.figs.forEach((f, i) => {
    e5[`GATE${i}`] = { type: 'noul', instructions: `${f.name} has a clear feeling ${when}: not merely calm, attentive, busy or concentrating.` };
    e5[`WHICH${i}`] = { type: 'choice', instructions: `The feeling ${f.name} has ${when}.`, criteria: six };
  });
  out.push({ variant: 'E5', state: it.stateFull, questions: e5 });
  // Round 2. E7: E1 plus the neutral default stated (E1's dominant miss was neutral->happy/afraid). E8: the shot lesson, a
  // 'best told as' noul per mood including neutral, argmax. Both informed by round 1's error pattern.
  const NEUTRAL_RULE = ' When the page only has the figure act, stand by or watch, and neither the text nor the plan gives a feeling, the answer is neutral.';
  out.push({ variant: 'E7', state: it.stateFull, questions: Object.fromEntries(it.figs.map((f, i) => [`EMO${i}`, { type: 'choice', instructions: `The feeling ${f.name} has ${when}.${NEUTRAL_RULE}`, criteria: MOOD }])) });
  const e8 = {};
  it.figs.forEach((f, i) => EMOTIONS.forEach(e => { e8[`EMO${i}_${e}`] = { type: 'noul', instructions: `${f.name} is best described as feeling ${MOOD[e]} ${when}, better than by any other feeling.` }; }));
  out.push({ variant: 'E8', state: it.stateFull, questions: e8 });
  return out;
}

async function run() {
  const its = items();
  const reps = Number(argv.reps || 1); const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const cap = Number(argv.capUsd || 0.3);
  const done = new Set(fs.existsSync(ANS) ? fs.readFileSync(ANS, 'utf8').trim().split('\n').filter(Boolean).map(l => { const a = JSON.parse(l); return `${a.id}|${a.variant}|${a.rep}`; }) : []);
  const tasks = [];
  for (const it of its) for (const rq of requests(it)) { if (only && !only.has(rq.variant)) continue; for (let r = 0; r < reps; r++) if (!done.has(`${it.id}|${rq.variant}|${r}`)) tasks.push({ it, rq, r }); }
  let spent = 0; let i = 0;
  console.log(`${its.length} pages (${its.filter(x => x.kind === 'full').length} full, ${its.filter(x => x.kind === 'trial').length} trial), ${tasks.length} calls to run`);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < tasks.length && spent < cap) {
      const { it, rq, r } = tasks[i++];
      const t0 = Date.now();
      const res = await J.callJev({ state: rq.state, questions: rq.questions });
      spent += res.cost;
      fs.appendFileSync(ANS, JSON.stringify({ id: it.id, kind: it.kind, variant: rq.variant, rep: r, ms: Date.now() - t0, cost: res.cost, answers: res.answers }) + '\n');
    }
  }));
  console.log(`spent $${spent.toFixed(4)}`);
}

function pickE(variant, it, answers) {
  return it.figs.map((f, i) => {
    if (variant === 'E1' || variant === 'E2' || variant === 'E7') return answers[`EMO${i}`].choice;
    if (variant === 'E3') { const p = answers[`EMO${i}`].probabilities; return EMOTIONS[Object.keys(p).sort((a, b) => p[b] - p[a])[0]]; }
    if (variant === 'E4') {
      const sc = EMOTIONS.filter(e => e !== 'neutral').map(e => [e, answers[`EMO${i}_${e}`].noul]).sort((a, b) => b[1] - a[1])[0];
      return sc[1] >= 0.5 ? sc[0] : 'neutral';
    }
    if (variant === 'E8') return EMOTIONS.map(e => [e, answers[`EMO${i}_${e}`].noul]).sort((a, b) => b[1] - a[1])[0][0];
    if (variant === 'E5') return answers[`GATE${i}`].noul >= 0.5 ? answers[`WHICH${i}`].choice : 'neutral';
    return null;
  });
}

const tone = e => EMOTION_TONE[e] || 'none';
function score() {
  const its = new Map(items().map(x => [x.id, x]));
  const rows = fs.readFileSync(ANS, 'utf8').trim().split('\n').map(JSON.parse);
  const res = {};
  const add = (k, kind, o) => { const r = (res[`${k}|${kind}`] = res[`${k}|${kind}`] || { n: 0, hit: 0, adHit: 0, adN: 0, agreeAd: 0, opp: 0, ms: [], flips: 0, flipN: 0, neutralOverCall: 0, cost: 0, calls: 0 }); Object.entries(o).forEach(([a, b]) => { if (Array.isArray(r[a])) r[a].push(b); else r[a] += b; }); };
  const byKey = {};
  for (const r of rows) {
    const it = its.get(r.id); if (!it) continue;
    const picks = pickE(r.variant, it, r.answers);
    (byKey[`${r.id}|${r.variant}`] = byKey[`${r.id}|${r.variant}`] || []).push(picks);
    add(r.variant, r.kind, { ms: r.ms, cost: r.cost, calls: 1 });
    if (r.rep > 0) continue;
    it.figs.forEach((f, i) => {
      const p = picks[i];
      add(r.variant, r.kind, { n: 1, hit: p === f.label ? 1 : 0, opp: (tone(p) !== 'none' && tone(f.label) !== 'none' && tone(p) !== tone(f.label)) ? 1 : 0, neutralOverCall: (p === 'neutral' && f.label !== 'neutral') ? 1 : 0 });
      if (f.ad) add(r.variant, r.kind, { agreeAd: p === f.ad ? 1 : 0, adN: 1, adHit: f.ad === f.label ? 1 : 0 });
    });
  }
  for (const [k, picksList] of Object.entries(byKey)) {
    if (picksList.length < 2) continue;
    const [id, v] = k.split('|'); const it = its.get(id);
    it.figs.forEach((_, i) => { add(v, it.kind, { flipN: 1, flips: picksList[0][i] !== picksList[1][i] ? 1 : 0 }); });
  }
  const pct = (a, b) => (b ? `${a}/${b} = ${(100 * a / b).toFixed(1)}%` : 'n/a');
  const med = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  for (const [k, r] of Object.entries(res).sort()) {
    console.log(`${k.padEnd(10)} acc ${pct(r.hit, r.n).padEnd(16)} opposite-tone ${r.opp}  neutral-where-label-felt ${r.neutralOverCall}  ${r.adN ? `agree-AD ${pct(r.agreeAd, r.adN)}  AD-acc ${pct(r.adHit, r.adN)}  ` : ''}${r.flipN ? `flips ${r.flips}/${r.flipN}  ` : ''}p50 ${med(r.ms)}ms  calls ${r.calls}  $${r.cost.toFixed(5)}`);
  }
  for (const kind of ['full', 'trial']) {
    const d = {}; let n = 0;
    for (const it of its.values()) if (it.kind === kind) for (const f of it.figs) { d[f.label] = (d[f.label] || 0) + 1; n++; }
    const top = Object.entries(d).sort((a, b) => b[1] - a[1])[0];
    console.log(`${kind}: ${n} labelled figures, majority '${top[0]}' ${pct(top[1], n)}`, JSON.stringify(d));
  }
}

module.exports = { items, pickE, requests, MOOD };
if (require.main === module) ({ run, score }[process.argv[2]] || (() => { console.log('run | score'); }))();
