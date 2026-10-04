#!/usr/bin/env node
/**
 * Can Jev pick the challenge ideas and landmarks that FIT a story, instead of a random draw /
 * a fame rank? (owner, 2026-09-27: "We inject ideas from the 200+ list, as well as landmarks.
 * Now we just select randomly which ones. Could we ask Jev to select the ones that fit the story?")
 *
 * Today (traced at origin/staging bfb55bea6):
 *   - CHALLENGES: drawChallengeIdeas (promptBuilders.js) draws 25 at random from the age-banded
 *     catalogue (prompts/challenge-catalogue.txt, 395 entries), category-spread, minus the ids this
 *     account's earlier books were offered. It feeds arc-create + arc-retell only (beats pipeline).
 *     Idea generation lost it on 2026-09-21; the trial never had it.
 *   - LANDMARKS: resolveAvailableLandmarks (landmarkPhotos.js) = fame-ranked town list, limit 20.
 *     Story pipeline shuffles it (arc/AD see all 20; the TRIAL story slices the first 3). The wizard
 *     idea prompt takes the first 2 UNshuffled (fame rank); the trial idea prompt takes
 *     getIndexedLandmarks(loc, 3) (fame rank).
 *
 * Designs measured (Jev = typesafe/jev-1.13 decisions API, text only):
 *   CA   one CHOICE over the eligible pool (chunked: the API caps a choice at 255 options, and
 *        every pool here is 256-336) → per-option probability → rank
 *   CB1  one NOUL per challenge, setup-only state (what the idea stage knows)
 *   CB2  one NOUL per challenge, setup + premise state (what the arc stage knows)
 *   LB1  one NOUL per landmark, setup-only (the idea stage)
 *   LB2  one NOUL per landmark, setup + premise (the story stage)
 *   LC   one CHOICE "the one landmark to anchor this story", setup-only
 *
 *   node scripts/analysis/eval-jev-selection.js extract [--dotenv=…]   # staging only
 *   node scripts/analysis/eval-jev-selection.js dump [--setup=S1]       # pools, for labelling
 *   node scripts/analysis/eval-jev-selection.js run [--reps=3] [--only=CA,CB1] [--capUsd=0.30]
 *   node scripts/analysis/eval-jev-selection.js score
 *
 * Reading labels (evals/datasets/jev-selection-v1/reading_labels.json: G good / N neutral / B bad per
 * catalogue id and per landmark name) were written from the setup + premise BEFORE any Jev call.
 * items.jsonl (premise text) and answers are gitignored.
 * see docs/decisions.md 2026-09-27 "Jev picks the challenges and landmarks that fit"
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const envPath = argv.dotenv || [path.join(ROOT, '.env'), path.join(ROOT, '../../../.env')].find(p => fs.existsSync(p));
require('dotenv').config({ path: envPath });

const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-selection-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const LABELS = path.join(DATASET_DIR, 'reading_labels.json');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-selection');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const METRICS = path.join(RUN_DIR, 'metrics.json');
const mode = process.argv[2];

// The staging books (stories.id suffix). S1-S6 carry a stored draw + the ids the arc re-telling
// reported taking (challengeTakenIds); S7-S11 are the other distinct setups of the last 45 days.
const SETUPS = {
  S1: 'dka3jpog9', S2: 'z3fw660ie', S3: 'fcmlfa8kn', S4: 'vnx5l8iy7', S5: '1nitlympp',
  S6: 'y3n0euk3z', S7: 'p3dh87hsv', S8: 'xqmtk2gcs', S9: 'd7472jys3', S10: 'rur4nskfv', S11: 'bfgznq960',
};
const DRAWS_FOR_POOL = 400; // (15/16)^400 ≈ 6e-12: the union of 400 real draws IS the eligible pool
const CHOICE_MAX = 255;

// ───────────────────────── extract ─────────────────────────

function catalogue() {
  const lines = fs.readFileSync(path.join(ROOT, 'prompts/challenge-catalogue.txt'), 'utf8').replace(/\r/g, '').split('\n');
  const out = {};
  for (const l of lines) {
    if (!l || l.startsWith('#')) continue;
    const f = l.split('|');
    if (f.length < 6) continue;
    out[Number(f[0])] = { id: Number(f[0]), cat: f[1], text: f[2], tests: f[3], band: f[4], peril: f[5].trim() };
  }
  return out;
}

/** The eligible pool and each id's inclusion rate, from the REAL builder (drawChallengeIdeas). */
function realDrawStats(inputData) {
  const { drawChallengeIdeas } = require('../../server/lib/promptBuilders');
  const freq = {};
  let n = 0;
  for (let i = 0; i < DRAWS_FOR_POOL; i++) {
    const d = drawChallengeIdeas(inputData, { count: 25 });
    if (!d.ids.length) break;
    n++;
    for (const id of d.ids) freq[id] = (freq[id] || 0) + 1;
  }
  return { pool: Object.keys(freq).map(Number).sort((a, b) => a - b), rate: Object.fromEntries(Object.entries(freq).map(([k, v]) => [k, v / Math.max(n, 1)])), draws: n };
}

async function extract() {
  // The landmark resolver reads DATABASE_URL through server/services/database.js: point it at STAGING.
  process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  require('../../server/services/database').initializePool();
  const { resolveAvailableLandmarks, getIndexedLandmarks } = require('../../server/lib/landmarkPhotos');
  const items = [];
  for (const [sid, suffix] of Object.entries(SETUPS)) {
    const { rows: [r] } = await pool.query(`SELECT id, data FROM stories WHERE id LIKE $1`, [`%${suffix}`]);
    const d = r.data;
    const inputData = {
      characters: (d.characters || []).map(c => ({ name: c.name, age: c.age, gender: c.gender, isMain: c.isMain })),
      storyCategory: d.storyCategory, storyTopic: d.storyTopic, storyTheme: d.storyTheme, storyType: d.storyType,
      language: d.language, userLocation: d.userLocation, mainCharacters: d.mainCharacters,
    };
    const stats = realDrawStats(inputData);
    let landmarks = [];
    let trialIdea = [];
    if (d.userLocation?.city && d.storyCategory !== 'historical') {
      landmarks = (await resolveAvailableLandmarks(d.userLocation, { limit: 20, language: d.language })).map(l => ({
        name: l.name, type: l.type || null, desc: String(l.wikipediaExtract || l.photoDescription || '').replace(/\s+/g, ' ').slice(0, 220),
      }));
      trialIdea = (await getIndexedLandmarks(d.userLocation, 3)).map(l => l.name);
    }
    items.push({
      setup: sid, story: r.id, language: d.language, city: d.userLocation?.city || null,
      category: d.storyCategory || null, topic: d.storyTopic || null, theme: d.storyTheme || null,
      cast: inputData.characters.map(c => ({ age: c.age, gender: c.gender })),
      premise: String(d.storyDetails || '').trim(),
      challenge: { pool: stats.pool, rate: stats.rate, draws: stats.draws, storedDraw: d.challengeDrawIds || null, taken: d.challengeTakenIds || null },
      landmarks, landmarksWizardIdea: landmarks.slice(0, 2).map(l => l.name), landmarksTrialIdea: trialIdea,
    });
    console.log(`${sid} ${r.id}: pool ${stats.pool.length} (${stats.draws} draws), stored draw ${d.challengeDrawIds?.length || 0}, taken ${d.challengeTakenIds?.length || 0}, landmarks ${landmarks.length}`);
  }
  await pool.end();
  try { await require('../../server/services/database').getPool()?.end(); } catch (_) { /* resolver pool */ }
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n');
}

function loadItems() { return fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse); }

// The questions and states are production's (server/lib/jevSelection.js): one copy.
const { castLine, setupState, premiseState, chLabel, lmLabel, Q } = require('../../server/lib/jevSelection');

function dump() {
  const cat = catalogue();
  for (const it of loadItems()) {
    if (argv.setup && argv.setup !== it.setup) continue;
    console.log(`\n######## ${it.setup} (${it.story}) ${it.language} — ${castLine(it)}; ${it.category}/${it.theme}/${it.topic}; ${it.city}`);
    console.log(`PREMISE: ${it.premise.replace(/\s+/g, ' ')}`);
    if (!argv.landmarks) for (const id of it.challenge.pool) console.log(`C${id} [${cat[id].cat}] ${cat[id].text} (tests: ${cat[id].tests})`);
    if (!argv.challenges) it.landmarks.forEach((l, i) => console.log(`L${i + 1} ${l.name}${l.type ? ` [${l.type}]` : ''}: ${l.desc.slice(0, 160)}`));
  }
}

// ───────────────────────── run ─────────────────────────


function chunks(ids) {
  const n = Math.ceil(ids.length / CHOICE_MAX);
  const size = Math.ceil(ids.length / n);
  return Array.from({ length: n }, (_, i) => ids.slice(i * size, (i + 1) * size));
}

function requests(it) {
  const cat = catalogue();
  const out = [];
  const pool = it.challenge.pool;
  if (pool.length) {
    out.push({ id: it.setup, variant: 'CB1', state: setupState(it), questions: Object.fromEntries(pool.map(id => [`c${id}`, { type: 'noul', instructions: Q.CB(cat[id]) }])) });
    out.push({ id: it.setup, variant: 'CB2', state: premiseState(it), questions: Object.fromEntries(pool.map(id => [`c${id}`, { type: 'noul', instructions: Q.CB(cat[id]) }])) });
    chunks(pool).forEach((ch, k) => out.push({ id: `${it.setup}#${k}`, variant: 'CA', state: premiseState(it), questions: {
      PICK: { type: 'choice', instructions: 'Which one of these trials fits this book best: it can happen naturally in its world and to its cast, and it serves the kind of story it is?', criteria: Object.fromEntries(ch.map(id => [`c${id}`, chLabel(cat[id])])) },
    } }));
  }
  if (it.landmarks.length) {
    const lq = () => Object.fromEntries(it.landmarks.map((l, i) => [`l${i}`, { type: 'noul', instructions: Q.LB(l) }]));
    out.push({ id: it.setup, variant: 'LB1', state: setupState(it), questions: lq() });
    out.push({ id: it.setup, variant: 'LB2', state: premiseState(it), questions: lq() });
    out.push({ id: it.setup, variant: 'LC', state: setupState(it), questions: {
      ANCHOR: { type: 'choice', instructions: 'Which one of these real places should this story be anchored at: the one where a story of this kind, with this cast, would most naturally happen?', criteria: Object.fromEntries(it.landmarks.map((l, i) => [`l${i}`, lmLabel(l)])) },
    } });
  }
  return out;
}

async function callWithRetry(req) {
  const J = require('../../server/lib/jevAudit');
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    try { const r = await J.callJev(req); r.ms = Date.now() - t0; return r; } catch (e) {
      if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message) || attempt >= 3) throw e;
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
}

async function run() {
  if (!fs.existsSync(LABELS)) throw new Error('reading labels first: the labels are written before any Jev call');
  const items = loadItems();
  const reps = Number(argv.reps || 3);
  const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const capUsd = Number(argv.capUsd || 0.30);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const prior = fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Set(prior.map(a => `${a.id}|${a.variant}|${a.rep}`));
  let cost = prior.reduce((s, a) => s + (a.cost || 0), 0);
  let tasks = [];
  for (const it of items) for (const rq of requests(it)) {
    if (only && !only.has(rq.variant)) continue;
    for (let rep = 0; rep < reps; rep++) if (!done.has(`${rq.id}|${rq.variant}|${rep}`)) tasks.push({ rq, rep });
  }
  if (argv.limit) tasks = tasks.slice(0, Number(argv.limit));
  console.log(`${tasks.length} calls to make (spent so far $${cost.toFixed(5)}, cap $${capUsd})`);
  const out = fs.createWriteStream(ANSWERS, { flags: 'a' });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Number(argv.conc || 6), tasks.length) }, async () => {
    while (next < tasks.length) {
      if (cost > capUsd) throw new Error(`cap $${capUsd} reached`);
      const { rq, rep } = tasks[next++];
      const r = await callWithRetry({ state: rq.state, questions: rq.questions });
      cost += r.cost;
      out.write(JSON.stringify({ id: rq.id, variant: rq.variant, rep, answers: r.answers, cost: r.cost, ms: r.ms, nq: Object.keys(rq.questions).length }) + '\n');
    }
  }));
  out.end();
  console.log(`done, total $${cost.toFixed(5)}`);
}

// ───────────────────────── score ─────────────────────────

function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return +(s / (pos.length * neg.length)).toFixed(3);
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r3 = x => (Number.isFinite(x) ? +x.toFixed(3) : null);
const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); const i = [...A].filter(x => B.has(x)).length; return i / (A.size + B.size - i); };
const pct = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

/** Per-option score for one variant: mean over reps. CA: chunk probability × chunk size (odds vs uniform). */
function scores(answers, it, variant) {
  const per = {};
  const rows = answers.filter(a => a.variant === variant && (a.id === it.setup || a.id.startsWith(`${it.setup}#`)));
  const reps = [...new Set(rows.map(a => a.rep))];
  const byRep = reps.map(rep => {
    const o = {};
    for (const a of rows.filter(x => x.rep === rep)) {
      for (const [q, ans] of Object.entries(a.answers)) {
        if (ans.probabilities) { const n = Object.keys(ans.probabilities).length; for (const [k, p] of Object.entries(ans.probabilities)) o[k] = p * n; } else o[q] = ans.noul;
      }
    }
    return o;
  });
  for (const k of Object.keys(byRep[0] || {})) per[k] = mean(byRep.map(o => o[k] ?? 0));
  return { per, byRep, ms: rows.map(a => a.ms), cost: rows.reduce((s, a) => s + (a.cost || 0), 0), calls: rows.length };
}
const topK = (per, k) => Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key]) => key);

function score() {
  const items = loadItems();
  const L = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const answers = fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const M = { challenges: {}, landmarks: {}, cost: {}, latency: {} };
  const share = (keys, lab, v) => (keys.length ? keys.filter(k => lab[k] === v).length / keys.length : null);

  // ── challenges
  for (const variant of ['CB1', 'CB2', 'CA']) {
    const rowsOut = [];
    const tops = {};
    for (const it of items) {
      const lab = Object.fromEntries(Object.entries(L[it.setup]?.challenges || {}).map(([id, v]) => [`c${id}`, v]));
      if (!it.challenge.pool.length || !Object.keys(lab).length) continue;
      const s = scores(answers, it, variant);
      if (!s.calls) continue;
      const keys = Object.keys(s.per);
      const G = keys.filter(k => lab[k] === 'G').map(k => s.per[k]);
      const B = keys.filter(k => lab[k] === 'B').map(k => s.per[k]);
      const NB = keys.filter(k => lab[k] !== 'G').map(k => s.per[k]);
      // Random draw today: expected shares weighted by each id's real inclusion rate.
      const rate = it.challenge.rate;
      const w = Object.entries(rate).map(([id, r]) => [`c${id}`, r]);
      const randShare = v => w.reduce((a, [k, r]) => a + (lab[k] === v ? r : 0), 0) / w.reduce((a, [, r]) => a + r, 0);
      const row = {
        setup: it.setup, pool: keys.length, labelsG: keys.filter(k => lab[k] === 'G').length, labelsB: keys.filter(k => lab[k] === 'B').length,
        aucGvsB: auc(G, B), aucGvsRest: auc(G, NB),
        randomBad: r3(randShare('B')), randomGood: r3(randShare('G')),
      };
      for (const k of [25, 40, 60, 80]) {
        const t = topK(s.per, k);
        row[`top${k}Bad`] = r3(share(t, lab, 'B'));
        row[`top${k}Good`] = r3(share(t, lab, 'G'));
      }
      // Jev as a FILTER: drop the bottom half, then today's random draw runs on the rest.
      const half = topK(s.per, Math.ceil(keys.length / 2));
      row.keepHalfBad = r3(share(half, lab, 'B')); row.keepHalfGood = r3(share(half, lab, 'G'));
      row.droppedGood = r3(keys.filter(k => lab[k] === 'G' && !half.includes(k)).length / Math.max(1, keys.filter(k => lab[k] === 'G').length));
      // Stability: top-25 overlap between single calls.
      if (s.byRep.length > 1) row.repJaccard25 = r3(mean(s.byRep.slice(1).map(o => jaccard(topK(o, 25), topK(s.byRep[0], 25)))));
      // The ids the arc re-telling reported TAKING from the stored draw: their rank inside that draw.
      if (it.challenge.taken?.length && it.challenge.storedDraw?.length) {
        const drawn = it.challenge.storedDraw.map(id => `c${id}`).filter(k => k in s.per);
        const taken = it.challenge.taken.map(id => `c${id}`).filter(k => drawn.includes(k));
        row.takenAucInDraw = auc(taken.map(k => s.per[k]), drawn.filter(k => !taken.includes(k)).map(k => s.per[k]));
        row.takenLabels = taken.map(k => lab[k] || '?').join('');
        row.drawLabels = { G: drawn.filter(k => lab[k] === 'G').length, N: drawn.filter(k => lab[k] === 'N').length, B: drawn.filter(k => lab[k] === 'B').length };
      }
      tops[it.setup] = topK(s.per, 60);
      rowsOut.push(row);
      M.cost[variant] = (M.cost[variant] || 0) + s.cost;
      M.latency[variant] = [...(M.latency[variant] || []), ...s.ms];
    }
    // Diversity across the three dragon books (same cast/world, different premise) and across all.
    const dragon = ['S1', 'S4', 'S5'].filter(x => tops[x]);
    const div = {};
    if (dragon.length > 1) div.dragonTop25Jaccard = r3(mean(dragon.slice(1).map(x => jaccard(tops[x].slice(0, 25), tops[dragon[0]].slice(0, 25)))));
    const all = Object.values(tops).map(t => t.slice(0, 25));
    const freq = {};
    for (const t of all) for (const k of t) freq[k] = (freq[k] || 0) + 1;
    div.distinctInTop25 = Object.keys(freq).length;
    div.setups = all.length;
    div.idsInHalfOrMoreTop25 = Object.values(freq).filter(n => n >= all.length / 2).length;
    M.challenges[variant] = { rows: rowsOut, diversity: div, mean: {
      aucGvsB: r3(mean(rowsOut.map(r => r.aucGvsB).filter(x => x != null))),
      aucGvsRest: r3(mean(rowsOut.map(r => r.aucGvsRest).filter(x => x != null))),
      randomBad: r3(mean(rowsOut.map(r => r.randomBad))), randomGood: r3(mean(rowsOut.map(r => r.randomGood))),
      top25Bad: r3(mean(rowsOut.map(r => r.top25Bad))), top25Good: r3(mean(rowsOut.map(r => r.top25Good))),
      top60Bad: r3(mean(rowsOut.map(r => r.top60Bad))), top60Good: r3(mean(rowsOut.map(r => r.top60Good))),
      keepHalfBad: r3(mean(rowsOut.map(r => r.keepHalfBad))), keepHalfGood: r3(mean(rowsOut.map(r => r.keepHalfGood))),
      droppedGood: r3(mean(rowsOut.map(r => r.droppedGood))),
      repJaccard25: r3(mean(rowsOut.map(r => r.repJaccard25).filter(x => x != null))),
      takenAucInDraw: r3(mean(rowsOut.map(r => r.takenAucInDraw).filter(x => x != null))),
    } };
  }

  // ── landmarks
  for (const variant of ['LB1', 'LB2', 'LC']) {
    const rowsOut = [];
    for (const it of items) {
      const labByName = L[it.setup]?.landmarks || {};
      if (!it.landmarks.length || !Object.keys(labByName).length) continue;
      const lab = Object.fromEntries(it.landmarks.map((l, i) => [`l${i}`, labByName[l.name]]));
      const s = scores(answers, it, variant);
      if (!s.calls) continue;
      const keys = Object.keys(s.per);
      const keyOf = name => `l${it.landmarks.findIndex(l => l.name === name)}`;
      const G = keys.filter(k => lab[k] === 'G').map(k => s.per[k]);
      const B = keys.filter(k => lab[k] === 'B').map(k => s.per[k]);
      const row = {
        setup: it.setup, n: keys.length, labelsG: G.length, labelsB: B.length, aucGvsB: auc(G, B),
        fameTop2: it.landmarksWizardIdea.map(n => lab[keyOf(n)] || '?').join(''),
        trialIdeaTop3: it.landmarksTrialIdea.map(n => lab[keyOf(n)] || '?').join(''),
        random3Good: r3(share(keys, lab, 'G')), random3Bad: r3(share(keys, lab, 'B')),
        jevTop1: lab[topK(s.per, 1)[0]] || '?', jevTop2: topK(s.per, 2).map(k => lab[k] || '?').join(''), jevTop3: topK(s.per, 3).map(k => lab[k] || '?').join(''),
        top1Name: it.landmarks[Number(topK(s.per, 1)[0].slice(1))]?.name,
        // The proposed sampler: 2 drawn at random from Jev's top 5 → expected G / B share.
        top5Good: r3(share(topK(s.per, 5), lab, 'G')), top5Bad: r3(share(topK(s.per, 5), lab, 'B')),
        top5: topK(s.per, 5).map(k => it.landmarks[Number(k.slice(1))]?.name),
      };
      if (s.byRep.length > 1) row.top1Flip = new Set(s.byRep.map(o => topK(o, 1)[0])).size > 1;
      rowsOut.push(row);
      M.cost[variant] = (M.cost[variant] || 0) + s.cost;
      M.latency[variant] = [...(M.latency[variant] || []), ...s.ms];
    }
    const g = str => rowsOut.reduce((a, r) => a + [...r[str]].filter(c => c === 'G').length, 0);
    const b = str => rowsOut.reduce((a, r) => a + [...r[str]].filter(c => c === 'B').length, 0);
    M.landmarks[variant] = { rows: rowsOut, totals: {
      setups: rowsOut.length, aucGvsB: r3(mean(rowsOut.map(r => r.aucGvsB).filter(x => x != null))),
      fameTop2: `${g('fameTop2')}G/${b('fameTop2')}B of ${rowsOut.length * 2}`, jevTop2: `${g('jevTop2')}G/${b('jevTop2')}B of ${rowsOut.length * 2}`,
      trialIdeaTop3: `${g('trialIdeaTop3')}G/${b('trialIdeaTop3')}B`, jevTop3: `${g('jevTop3')}G/${b('jevTop3')}B of ${rowsOut.length * 3}`,
      random3: `${r3(mean(rowsOut.map(r => r.random3Good)))}G/${r3(mean(rowsOut.map(r => r.random3Bad)))}B share`,
      jevTop1: `${g('jevTop1')}G/${b('jevTop1')}B of ${rowsOut.length}`,
      top1Flips: rowsOut.filter(r => r.top1Flip).length,
      top5Good: r3(mean(rowsOut.map(r => r.top5Good))), top5Bad: r3(mean(rowsOut.map(r => r.top5Bad))),
    } };
  }
  for (const [v, ms] of Object.entries(M.latency)) M.latency[v] = { p50: pct(ms, 0.5), p90: pct(ms, 0.9), n: ms.length };
  for (const v of Object.keys(M.cost)) M.cost[v] = +M.cost[v].toFixed(5);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(METRICS, JSON.stringify(M, null, 2));
  for (const [v, x] of Object.entries(M.challenges)) {
    console.log(`\n== ${v} mean ${JSON.stringify(x.mean)}\n   diversity ${JSON.stringify(x.diversity)}`);
    for (const r of x.rows) console.log('  ', JSON.stringify(r));
  }
  for (const [v, x] of Object.entries(M.landmarks)) {
    console.log(`\n== ${v} ${JSON.stringify(x.totals)}`);
    for (const r of x.rows) console.log('  ', JSON.stringify(r));
  }
  console.log('\ncost', JSON.stringify(M.cost), '\nlatency', JSON.stringify(M.latency));
}

module.exports = { setupState, premiseState, requests, catalogue, chunks };

if (require.main === module) {
  const fn = { extract, dump, run, score }[mode];
  if (!fn) { console.error('mode: extract | dump | run | score'); process.exit(1); }
  Promise.resolve(fn()).catch(e => { console.error(e); process.exit(1); });
}
