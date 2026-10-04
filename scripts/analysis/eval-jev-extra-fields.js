#!/usr/bin/env node
/**
 * Gaze, depth and story relevance — asked the way that won the shot (owner, 2026-09-27):
 * "redo the gaze, depth and story relevant; think of a better way to ask the question to Jev."
 *
 * The first test (eval-jev-shot-budget.js, extra-fields table) asked Jev to CLASSIFY each field
 * directly (❌ for all three). The shot lesson: ask what SERVES the moment — one yes/no per option,
 * graded — and let code pick under constraints. Designs per field (all on the SAME 70 pages of the
 * four books whose briefs carry the fields; the state is the previous one: the whole story text with
 * the page marked + the page's plan line, shot token stripped):
 *
 *   GAZE (looksAt), candidates enumerated in code: every other character on the page, every VB
 *   element the page cites (clothing excluded), the page's place, and "away".
 *     G0  choice, the previous wording (baseline repeat, coarse options)
 *     G1  noul per candidate "attention is on <target>: what they deal with, react to or reach for"
 *         → code: argmax
 *     G2  one choice over the SAME candidates "what are X's eyes and hands on in this instant"
 *     G3  two-stage in one call: noul "attention on a person or creature, not a thing or place",
 *         + a choice among the beings + a choice among the things → code picks the stage, then the choice
 *     G4  noul per candidate, the shot's "serves" framing: "the picture of this moment is best told
 *         with X looking at <target>" → code: argmax
 *
 *   DEPTH
 *     D0  pure code: shot + the plan's who column (first-named = focal)
 *     D1  nouls FOCUS "the one this moment is about" + APART "set apart from the others: far off,
 *         behind, waiting" → code maps with the shot
 *     D2  choice, the previous wording (baseline repeat)
 *     D3  three nouls "best told with X in the foreground / midground / background" → argmax
 *
 *   STORY RELEVANCE (per interaction row, i.e. per object acted on)
 *     R0  noul, the previous wording (baseline repeat)
 *     R1  counterfactual "the moment would still make sense if <object> were not in the picture" (inverted)
 *     R2  role "<object> is used, held, sought, or the cause of what happens on this page"
 *     R3  continuity "<object> matters later because of what happens to it on this page"
 *     combos in code (reported: mean, R2 OR ¬R1, …)
 *
 *   node scripts/analysis/eval-jev-extra-fields.js extract [--dotenv=…]
 *   node scripts/analysis/eval-jev-extra-fields.js dump                 # page + candidates, for labelling
 *   node scripts/analysis/eval-jev-extra-fields.js labels --from=<local labels file>
 *   node scripts/analysis/eval-jev-extra-fields.js run [--reps=3] [--only=B,G1,G23,G4,D,R] [--capUsd=0.35]
 *   node scripts/analysis/eval-jev-extra-fields.js score [--dump]      # --dump prints every gaze miss
 *
 * Reading labels (evals/datasets/jev-extra-fields-v1/reading_labels.json, hashed keys, no story text)
 * were written from the story text + plan line BEFORE any Jev call of this run. Relevance reuses the 73
 * labels of jev-shot-budget-v1 and adds the 8 rows that had none. Items and answers are gitignored.
 * see docs/decisions.md 2026-09-27 "Gaze, depth, story relevance asked as fit"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const { parsePlanLine } = require('./eval-jev-decision-layer');
const { stripShot } = require('./eval-jev-shot-budget');

const mode = process.argv[2];
const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-extra-fields-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const LABELS = path.join(DATASET_DIR, 'reading_labels.json');
const OLD_LABELS = path.join(ROOT, 'evals/datasets/jev-shot-budget-v1/reading_labels.json');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-extra-fields');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const STORIES = ['5herh01j7', 'vnx5l8iy7', 'z3fw660ie', 'dka3jpog9']; // the four books whose briefs carry the fields
const baseId = id => String(id || '').split('.')[0];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namedIn = (name, text) => new RegExp(`(^|[^\\p{L}])${esc(name)}($|[^\\p{L}])`, 'iu').test(text);

// ───────────────────────── extract ─────────────────────────

function vbIndex(vb) {
  const out = {};
  const kinds = { animals: 'creature', secondaryCharacters: 'figure', artifacts: 'thing', genericObjects: 'thing', vehicles: 'vehicle', locations: 'place' };
  for (const [k, kind] of Object.entries(kinds)) {
    for (const e of vb?.[k] || []) {
      if (!e?.id) continue;
      const name = e.properName || e.name || e.label || e.id;
      const desc = String(e.description || [e.species, e.coloring, e.features, e.setting].filter(Boolean).join(', ')).replace(/\s+/g, ' ').slice(0, 160);
      out[e.id] = { id: e.id, kind, name, desc };
      for (const v of e.vantages || []) out[v.id] = { id: e.id, kind, name, desc, vantage: v.name };
    }
  }
  return out;
}

async function extract() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const items = [];
  for (const sid of STORIES) {
    const { rows: [r] } = await pool.query(`SELECT id, data->'beatsReviewReport' b, data->'sceneImages' si, data->'visualBible' vb, data->>'language' lang FROM stories WHERE id LIKE $1`, [`%${sid}`]);
    const vbi = vbIndex(r.vb);
    const pages = (r.si || []).filter(p => p?.sceneMetadata?.fullData?.timeOfDay).sort((a, c) => a.pageNumber - c.pageNumber);
    const texts = pages.map(p => ({ page: p.pageNumber, text: String(p.text || '').trim() }));
    for (const p of pages) {
      const f = p.sceneMetadata.fullData;
      const pl = parsePlanLine(p.outlineExtract || '');
      // Elements the page cites (clothing is the wearer's, never a gaze target or an interaction object here).
      const cited = [...new Set([...(f.objects || []), ...(f.interactions || []).map(x => x.object)].filter(o => o && !/^CLO/.test(o)).map(baseId))];
      const elements = cited.map(id => vbi[id] ? { id, kind: vbi[id].kind, name: vbi[id].name, desc: vbi[id].desc } : null).filter(Boolean);
      const objName = o => { const e = vbi[o] || vbi[baseId(o)]; return e ? (e.vantage ? `${e.name} (${e.vantage})` : e.name) : String(o); };
      // Beings the plan line names but the page does not cite (a creature met across the page) are gaze
      // targets too: code reads the name off the plan line.
      const named = Object.values(vbi).filter(e => (e.kind === 'creature' || e.kind === 'figure') && !e.vantage && !cited.includes(e.id)
        && namedIn(e.name, pl.raw)).map(e => ({ id: e.id, kind: e.kind, name: e.name, desc: e.desc }));
      items.push({ id: `${sid}#p${p.pageNumber}`, story: sid, page: p.pageNumber, lang: r.lang, arc: String(r.b?.arc || ''),
        planLine: pl.raw, who: pl.who, shot: f.shot || null, texts, elements, named,
        ad: { characters: (f.characters || []).map(c => ({ name: c.name, depth: c.depth || null, looksAt: c.looksAt || null, position: c.position || null })),
          interactions: (f.interactions || []).map(x => ({ character: x.character, action: x.action, object: x.object, objectName: objName(x.object), where: x.where, storyRelevant: !!x.storyRelevant })),
          sceneIntent: f.sceneIntent || '' } });
    }
  }
  await pool.end();
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`${items.length} pages, ${items.reduce((n, i) => n + i.ad.characters.length, 0)} characters, ${items.reduce((n, i) => n + i.ad.interactions.length, 0)} interaction rows`);
}

function loadItems() { return fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse); }

/** Gaze candidates, enumerated in code: key → { label, target } (target = a name, an element id, or 'away'). */
function gazeCandidates(it, c) {
  const out = [];
  it.ad.characters.filter(o => o.name !== c.name).forEach(o => out.push({ target: o.name, label: o.name }));
  const roster = new Set(it.ad.characters.map(o => o.name));
  [...it.elements, ...(it.named || [])].filter(e => !roster.has(e.name)).forEach(e => out.push({ target: e.id, label: e.kind === 'place' ? `the place itself: ${e.name}` : `${e.name} (${e.desc.slice(0, 80)})` }));
  out.push({ target: 'away', label: 'nothing in the picture: away, into the distance, or at nothing in particular' });
  return out;
}

function dump() {
  const L = fs.existsSync(OLD_LABELS) ? JSON.parse(fs.readFileSync(OLD_LABELS, 'utf8')) : {};
  let cur = null;
  for (const it of loadItems()) {
    if (it.story !== cur) { cur = it.story; console.log(`\n\n######## ${it.story} ARC:\n${it.arc.slice(0, Number(argv.arcChars || 2500))}`); }
    console.log(`\n=== ${it.id} [${it.shot}] PLAN: ${it.planLine}\n  TEXT: ${it.texts.find(t => t.page === it.page)?.text.replace(/\s+/g, ' ')}`);
    console.log(`  ELEMENTS: ${it.elements.map(e => `${e.id}=${e.name}`).join('; ')}${it.named?.length ? ` | NAMED: ${it.named.map(e => `${e.id}=${e.name}`).join('; ')}` : ''}`);
    if (argv.ad) console.log(`  AD: ${it.ad.characters.map(c => `${c.name}(${c.depth}, ${c.looksAt})`).join('; ')}`);
    else console.log(`  CHARS: ${it.ad.characters.map(c => c.name).join(', ')}`);
    it.ad.interactions.forEach((x, k) => {
      const old = L[hash(`fld:${it.id}:rel:${k}`)];
      console.log(`  #${k} ${x.character} | ${x.action} | ${x.objectName} [${x.object}] | ${x.where}${argv.ad ? ` [AD ${x.storyRelevant ? 'REL' : '-'}]` : ''} old=${old === undefined ? 'NONE' : old}`);
    });
  }
}

// ───────────────────────── labels ─────────────────────────

/** Local labels file → hashed reading_labels.json. Lines: "@<story>" then "<page> g|d <Name> = json", "<page> e <ELID> = bool", "<page> r <row> = bool". */
function labels() {
  const out = {};
  let story = null; let n = 0;
  for (const line of fs.readFileSync(argv.from, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    if (line.startsWith('@')) { story = line.slice(1); continue; }
    const m = line.match(/^(\d+)\s+([gder])\s+(.+?)\s+=\s+(.+)$/);
    if (!m) throw new Error(`bad label line: ${line}`);
    const id = `${story}#p${m[1]}`;
    const key = { g: `gaze:${id}:${m[3]}`, d: `depth:${id}:${m[3]}`, e: `el:${id}:${m[3]}`, r: `rel:${id}:${m[3]}` }[m[2]];
    out[hash(key)] = JSON.parse(m[4]); n++;
  }
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(LABELS, JSON.stringify(out) + '\n');
  console.log(`${n} labels → ${path.relative(ROOT, LABELS)}`);
}

// ───────────────────────── questions ─────────────────────────
// Generic wording only: names come from the page's roster and the VB, never from a test story.

function fieldState(it) {
  const story = it.texts.map(p => `--- Page ${p.page}${p.page === it.page ? ' (PAGE TO JUDGE)' : ''} ---\n${p.text}`).join('\n\n');
  return `THE STORY TEXT:\n${story}\n\nTHE PICTURE PLAN OF THE PAGE TO JUDGE (who is in frame — the instant the picture shows — what is true after):\nPage ${it.page}: ${stripShot(it.planLine)}`;
}

const PLANES = {
  foreground: 'nearest the camera, large in the frame',
  midground: 'in the middle distance, whole figures inside the setting',
  background: 'far from the camera, small, behind the others',
};
const AWAY = 'away';
/** A being (person or creature) vs a thing or place — the G3 split. */
const isBeing = (it, target) => it.ad.characters.some(c => c.name === target) || [...it.elements, ...(it.named || [])].some(e => e.id === target && (e.kind === 'creature' || e.kind === 'figure'));
const nameOf = (it, x) => [...it.elements, ...(it.named || [])].find(e => e.id === x)?.name || x;
const rowText = (it, x) => `${String(x.character).split(/\s*\+\s*/).map(c => nameOf(it, c)).join(' and ')} ${x.where || `${x.action} ${x.objectName}`}`;

function requests(it) {
  const out = [];
  const st = fieldState(it);
  const chars = it.ad.characters;
  const add = (variant, questions) => { if (Object.keys(questions).length) out.push({ id: it.id, variant, state: st, questions }); };
  const G0 = {}; const G1 = {}; const G23 = {}; const G4 = {}; const D = {}; const R = {};
  chars.forEach((c, i) => {
    const N = c.name;
    const others = chars.filter(o => o.name !== N).map(o => o.name);
    // Baselines: the first test's exact wording.
    G0[`LOOK${i}`] = { type: 'choice', instructions: `What ${N} looks at in the picture of the page to judge.`,
      criteria: { ...Object.fromEntries(others.map((n, k) => [`c${k}`, n])), thing: 'the thing, creature or place the instant is about (not one of the named characters)', viewer: 'the viewer', away: 'nothing in particular: away, down or ahead' } };
    G0[`DEPTH${i}`] = { type: 'choice', instructions: `How near the camera ${N} stands in the picture of the page to judge.`,
      criteria: { foreground: 'foreground: nearest the camera, large', midground: 'midground: in the middle of the picture', background: 'background: far from the camera, small' } };
    const cand = gazeCandidates(it, c);
    cand.forEach((k, j) => {
      const on = k.target === AWAY ? `nothing in the picture: ${N} looks away, into the distance, or at nothing in particular` : `${k.label}: what ${N} is dealing with, reacting to, or reaching for`;
      G1[`C${i}_${j}`] = { type: 'noul', instructions: `In the instant of the page to judge, ${N}'s attention is on ${on}.` };
      const look = k.target === AWAY ? 'looking away from everyone and everything in the picture, into the distance' : `looking at ${k.label}`;
      G4[`C${i}_${j}`] = { type: 'noul', instructions: `The picture of the page to judge is best told with ${N} ${look}, better than with ${N} looking anywhere else.` };
    });
    G23[`EYES${i}`] = { type: 'choice', instructions: `In the instant of the page to judge, what are ${N}'s eyes and hands on?`,
      criteria: Object.fromEntries(cand.map((k, j) => [`t${j}`, k.target === AWAY ? 'nothing in the picture: away, into the distance' : k.label])) };
    const beings = cand.map((k, j) => [k, j]).filter(([k]) => k.target !== AWAY && isBeing(it, k.target));
    const things = cand.map((k, j) => [k, j]).filter(([k]) => k.target === AWAY || !isBeing(it, k.target));
    G23[`BEING${i}`] = { type: 'noul', instructions: `In the instant of the page to judge, ${N}'s attention is on another person or creature, not on a thing or a place.` };
    if (beings.length > 1) G23[`WHO${i}`] = { type: 'choice', instructions: `Which person or creature is ${N}'s attention on in the instant of the page to judge?`, criteria: Object.fromEntries(beings.map(([k, j]) => [`t${j}`, k.label])) };
    if (things.length > 1) G23[`WHAT${i}`] = { type: 'choice', instructions: `Which thing or place is ${N}'s attention on in the instant of the page to judge?`, criteria: Object.fromEntries(things.map(([k, j]) => [`t${j}`, k.target === AWAY ? 'nothing in the picture: away, into the distance' : k.label])) };
    // Depth: what code cannot know (D1), and the "serves" framing per plane (D3).
    D[`FOCUS${i}`] = { type: 'noul', instructions: `${N} is the one the instant of the page to judge is about.` };
    D[`APART${i}`] = { type: 'noul', instructions: `In the instant of the page to judge, ${N} is set apart from the others: far off, behind them, left waiting, or watching from a distance.` };
    for (const [pl, desc] of Object.entries(PLANES)) D[`${pl.slice(0, 2).toUpperCase()}${i}`] = { type: 'noul', instructions: `The picture of the page to judge is best told with ${N} in the ${pl}: ${desc}.` };
  });
  // Relevance, per interaction row (the AD's field) and per cited element.
  it.ad.interactions.forEach((x, i) => {
    const act = rowText(it, x);
    R[`R0_${i}`] = { type: 'noul', instructions: `In the picture of the page to judge, "${x.character} ${x.action} ${x.object}" is part of what the page's story moment is about, not just background business.` };
    R[`R1_${i}`] = { type: 'noul', instructions: `The instant of the page to judge would still make sense if the picture did not show this: ${act}.` };
    R[`R2_${i}`] = { type: 'noul', instructions: `In the instant of the page to judge, ${x.objectName} is used, held, sought, or is the cause of what happens.` };
    R[`R3_${i}`] = { type: 'noul', instructions: `${x.objectName} matters later in the story because of what happens to it or with it on the page to judge.` };
  });
  it.elements.forEach(e => {
    const nm = e.kind === 'place' ? `the place ${e.name}` : e.name;
    R[`E1_${e.id}`] = { type: 'noul', instructions: `The instant of the page to judge would still make sense if ${nm} were not in the picture.` };
    R[`E2_${e.id}`] = { type: 'noul', instructions: `In the instant of the page to judge, ${nm} is used, held, sought, or is the cause of what happens.` };
    R[`E3_${e.id}`] = { type: 'noul', instructions: `${nm} matters later in the story because of what happens to it or with it on the page to judge.` };
  });
  add('B', G0); add('G1', G1); add('G23', G23); add('G4', G4); add('D', D); add('R', R);
  return out;
}

async function callWithRetry(req) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    try { const r = await J.callJev(req); r.ms = Date.now() - t0; return r; } catch (e) {
      if (!/HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message) || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function run() {
  const items = loadItems();
  const reps = Number(argv.reps || 3);
  const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const capUsd = Number(argv.capUsd || 0.35);
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
  await Promise.all(Array.from({ length: Math.min(Number(argv.conc || 8), tasks.length) }, async () => {
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
const argmaxKey = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];
const WIDE = new Set(['wide', 'ultra-wide', 'aerial']);

/** The AD's looksAt → a gaze target in the candidates' terms (a roster name, a base element id, away, viewer). */
function adGaze(it, v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (it.ad.characters.some(c => c.name === s)) return s;
  const els = [...it.elements, ...(it.named || [])];
  const byId = els.find(e => e.id === baseId(s)) || (/^[A-Z]{3}\d+/.test(s) ? { id: baseId(s), name: null } : null);
  if (byId) return it.ad.characters.some(c => c.name === byId.name) ? byId.name : byId.id;
  if (/^(away|ahead|down|forward|off|nothing|distance|into the)/i.test(s)) return AWAY;
  if (/viewer|camera|reader/i.test(s)) return 'viewer';
  const byName = els.find(e => s.toLowerCase().includes(String(e.name).toLowerCase()));
  return byName ? (it.ad.characters.some(c => c.name === byName.name) ? byName.name : byName.id) : `other:${s}`;
}

/** D0 — pure code: the shot and the who column's order. */
function depthByCode(it) {
  const order = it.ad.characters.map(c => ({ n: c.name, at: it.who.toLowerCase().indexOf(c.name.toLowerCase()) }));
  const listed = order.filter(o => o.at >= 0).sort((a, b) => a.at - b.at).map(o => o.n);
  const focal = listed[0] || it.ad.characters[0]?.name;
  const shot = String(it.shot || '').replace(/‑/g, '-');
  return Object.fromEntries(it.ad.characters.map(c => {
    if (WIDE.has(shot)) return [c.name, 'midground'];
    if (shot === 'close-up' && it.ad.characters.length <= 2) return [c.name, 'foreground'];
    return [c.name, c.name === focal ? 'foreground' : 'midground'];
  }));
}

/** D1 — Jev's FOCUS / APART nouls, placed by code with the shot. */
function depthByFocus(it, F, A) {
  const shot = String(it.shot || '').replace(/‑/g, '-');
  const names = it.ad.characters.map(c => c.name);
  const top = names.reduce((a, n) => (F[n] > F[a] ? n : a), names[0]);
  return Object.fromEntries(names.map(n => {
    if (A[n] >= 0.5 && names.length > 1) return [n, 'background'];
    if (WIDE.has(shot)) return [n, 'midground'];
    if (shot === 'close-up' && names.length <= 2) return [n, 'foreground'];
    return [n, n === top || F[n] >= 0.5 ? 'foreground' : 'midground'];
  }));
}

function score() {
  const items = loadItems();
  const answers = fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').map(JSON.parse);
  const L = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const OLD = JSON.parse(fs.readFileSync(OLD_LABELS, 'utf8'));
  const lab = k => L[hash(k)];
  const by = new Map(answers.map(a => [`${a.id}|${a.variant}|${a.rep}`, a]));
  const reps = (id, v) => [0, 1, 2].map(r => by.get(`${id}|${v}|${r}`)).filter(Boolean);
  const M = { run: path.basename(RUN_DIR), calls: answers.length, costUsd: +answers.reduce((s, a) => s + (a.cost || 0), 0).toFixed(5),
    costPerCallUsd: +(answers.reduce((s, a) => s + (a.cost || 0), 0) / answers.length).toFixed(6),
    msP50: answers.map(a => a.ms).sort((a, b) => a - b)[Math.floor(answers.length / 2)] };
  const byVariantCost = {}; for (const a of answers) byVariantCost[a.variant] = +((byVariantCost[a.variant] || 0) + a.cost).toFixed(5);
  M.costByVariant = byVariantCost;

  // ── gaze ──
  const G = { n: 0 }; const gT = {}; const gAuc = { G1: [[], []], G4: [[], []] };
  const tallyG = (k, pick, ok, flip) => { gT[k] = gT[k] || { right: 0, n: 0, flips: 0, coarseRight: 0, coarseN: 0 }; gT[k].n++; if (ok) gT[k].right++; if (flip) gT[k].flips++; };
  const coarse = (it, t) => (t == null ? null : it.ad.characters.some(c => c.name === t) ? t : t === AWAY || t === 'viewer' ? t : 'thing');
  const gazeRows = [];
  for (const it of items) {
    const b = reps(it.id, 'B'); const g1 = reps(it.id, 'G1'); const g23 = reps(it.id, 'G23'); const g4 = reps(it.id, 'G4');
    it.ad.characters.forEach((c, i) => {
      const truth = lab(`gaze:${it.id}:${c.name}`); if (!truth) return;
      G.n++;
      const cand = gazeCandidates(it, c);
      const picks = {};
      // graded designs: mean over reps → argmax; flips = single-call argmax differs across reps
      for (const [v, R] of [['G1', g1], ['G4', g4]]) {
        const per = R.map(a => cand.map((k, j) => a.answers[`C${i}_${j}`]?.noul ?? 0));
        const avg = cand.map((k, j) => mean(per.map(p => p[j])));
        picks[v] = cand[avg.indexOf(Math.max(...avg))].target;
        picks[`${v}:1call`] = per[0] ? cand[per[0].indexOf(Math.max(...per[0]))].target : null;
        picks[`${v}:flip`] = new Set(per.map(p => cand[p.indexOf(Math.max(...p))].target)).size > 1;
        cand.forEach((k, j) => gAuc[v][truth.includes(k.target) ? 0 : 1].push(avg[j]));
      }
      // G2: choice probabilities averaged
      const p2 = cand.map((k, j) => mean(g23.map(a => a.answers[`EYES${i}`]?.probabilities?.[`t${j}`] ?? 0)));
      picks.G2 = cand[p2.indexOf(Math.max(...p2))].target;
      picks['G2:flip'] = new Set(g23.map(a => a.answers[`EYES${i}`]?.choice)).size > 1;
      const ch1 = g23[0]?.answers[`EYES${i}`]?.choice; picks['G2:1call'] = ch1 ? cand[Number(ch1.slice(1))].target : null;
      // G3: being noul → the matching choice
      const g3pick = a => {
        const being = a.answers[`BEING${i}`]?.noul ?? 0;
        const q = being >= 0.5 && a.answers[`WHO${i}`] ? `WHO${i}` : a.answers[`WHAT${i}`] ? `WHAT${i}` : `WHO${i}`;
        const ch = a.answers[q]?.choice;
        if (ch) return cand[Number(ch.slice(1))].target;
        // one-member side: the question was not asked, its only member is the answer
        const side = cand.filter(k => (being >= 0.5) === (k.target !== AWAY && isBeing(it, k.target)));
        return (side[0] || cand[0]).target;
      };
      const g3s = g23.map(g3pick);
      const cnt = {}; g3s.forEach(t => { cnt[t] = (cnt[t] || 0) + 1; });
      picks.G3 = argmaxKey(cnt); picks['G3:flip'] = new Set(g3s).size > 1;
      // G0 baseline (coarse options)
      const others = it.ad.characters.filter(o => o.name !== c.name).map(o => o.name);
      const g0 = b.map(a => { const ch = a.answers[`LOOK${i}`]?.choice; return /^c\d+$/.test(ch || '') ? others[Number(ch.slice(1))] : ch; });
      const c0 = {}; g0.forEach(t => { c0[t] = (c0[t] || 0) + 1; });
      picks.G0 = argmaxKey(c0); picks['G0:flip'] = new Set(g0).size > 1;
      const ad = adGaze(it, c.looksAt);
      const oldTruth = OLD[hash(`fld:${it.id}:look:${c.name}`)];
      for (const v of ['G1', 'G2', 'G3', 'G4']) {
        tallyG(v, picks[v], truth.includes(picks[v]), picks[`${v}:flip`]);
        if (oldTruth) { gT[v].coarseN++; if (oldTruth.includes(coarse(it, picks[v]))) gT[v].coarseRight++; }
      }
      tallyG('G1:1call', picks['G1:1call'], truth.includes(picks['G1:1call']), false);
      tallyG('G2:1call', picks['G2:1call'], truth.includes(picks['G2:1call']), false);
      tallyG('G4:1call', picks['G4:1call'], truth.includes(picks['G4:1call']), false);
      tallyG('AD', ad, truth.includes(ad), false);
      if (oldTruth) { gT.AD.coarseN++; if (oldTruth.includes(coarse(it, ad))) gT.AD.coarseRight++; }
      // G0 has only coarse picks: scored on the coarse reading (old labels) and on the fine reading coarsened
      tallyG('G0', picks.G0, truth.map(t => coarse(it, t)).includes(picks.G0), picks['G0:flip']);
      if (oldTruth) { gT.G0.coarseN++; if (oldTruth.includes(picks.G0)) gT.G0.coarseRight++; }
      gazeRows.push({ id: it.id, name: c.name, truth, ad, ...Object.fromEntries(['G1', 'G2', 'G3', 'G4'].map(v => [v, picks[v]])) });
    });
  }
  M.gaze = { n: G.n, designs: Object.fromEntries(Object.entries(gT).map(([k, t]) => [k, { right: t.right, n: t.n, acc: +(t.right / t.n).toFixed(3), flips: t.flips, coarse: t.coarseN ? `${t.coarseRight}/${t.coarseN}` : null }])),
    aucCandidate: { G1: auc(...gAuc.G1), G4: auc(...gAuc.G4) } };
  M.gaze.adWrongJevRight = gazeRows.filter(r => !r.truth.includes(r.ad) && r.truth.includes(r.G1)).length;
  M.gaze.jevWrongAdRight = gazeRows.filter(r => r.truth.includes(r.ad) && !r.truth.includes(r.G1)).length;

  // ── depth ──
  const dT = {}; const dAuc = { FG: [[], []] };
  const tallyD = (k, ok, flip) => { dT[k] = dT[k] || { right: 0, n: 0, flips: 0 }; dT[k].n++; if (ok) dT[k].right++; if (flip) dT[k].flips++; };
  for (const it of items) {
    const b = reps(it.id, 'B'); const d = reps(it.id, 'D');
    if (!it.ad.characters.length || !d.length) continue;
    const code = depthByCode(it);
    const perRep = d.map(a => {
      const F = {}; const A = {}; it.ad.characters.forEach((c, i) => { F[c.name] = a.answers[`FOCUS${i}`].noul; A[c.name] = a.answers[`APART${i}`].noul; });
      return { F, A };
    });
    const Fm = {}; const Am = {};
    it.ad.characters.forEach(c => { Fm[c.name] = mean(perRep.map(r => r.F[c.name])); Am[c.name] = mean(perRep.map(r => r.A[c.name])); });
    const d1 = depthByFocus(it, Fm, Am);
    const d1reps = perRep.map(r => depthByFocus(it, r.F, r.A));
    it.ad.characters.forEach((c, i) => {
      const truth = lab(`depth:${it.id}:${c.name}`); if (!truth) return;
      const d3s = d.map(a => argmaxKey({ foreground: a.answers[`FO${i}`].noul, midground: a.answers[`MI${i}`].noul, background: a.answers[`BA${i}`].noul }));
      const d3 = argmaxKey(Object.fromEntries(Object.keys(PLANES).map(pl => [pl, mean(d.map(a => a.answers[`${pl.slice(0, 2).toUpperCase()}${i}`].noul))])));
      const d2s = b.map(a => a.answers[`DEPTH${i}`]?.choice);
      const c2 = {}; d2s.forEach(t => { c2[t] = (c2[t] || 0) + 1; });
      tallyD('D0 code', truth.includes(code[c.name]), false);
      tallyD('D1 focus/apart+code', truth.includes(d1[c.name]), new Set(d1reps.map(x => x[c.name])).size > 1);
      tallyD('D2 choice (old)', truth.includes(argmaxKey(c2)), new Set(d2s).size > 1);
      tallyD('D3 plane nouls', truth.includes(d3), new Set(d3s).size > 1);
      tallyD('AD', truth.includes(c.depth), false);
      dAuc.FG[truth.includes('foreground') ? 0 : 1].push(Fm[c.name]);
    });
  }
  M.depth = { designs: Object.fromEntries(Object.entries(dT).map(([k, t]) => [k, { right: t.right, n: t.n, acc: +(t.right / t.n).toFixed(3), flips: t.flips }])), focusAucForeground: auc(...dAuc.FG) };

  // ── relevance ──
  const relSets = { rows: [], elements: [], elementsNoPlace: [] };
  for (const it of items) {
    const r = reps(it.id, 'R'); if (!r.length) continue;
    const q = k => mean(r.map(a => a.answers[k]?.noul).filter(v => typeof v === 'number'));
    const flip = k => new Set(r.map(a => a.answers[k]?.noul >= 0.5)).size > 1;
    it.ad.interactions.forEach((x, i) => {
      const truth = OLD[hash(`fld:${it.id}:rel:${i}`)] ?? lab(`rel:${it.id}:${i}`);
      if (typeof truth !== 'boolean') return;
      relSets.rows.push({ y: truth, ad: x.storyRelevant, isNew: OLD[hash(`fld:${it.id}:rel:${i}`)] === undefined,
        s: { R0: q(`R0_${i}`), R1: 1 - q(`R1_${i}`), R2: q(`R2_${i}`), R3: q(`R3_${i}`) },
        f: { R0: flip(`R0_${i}`), R1: flip(`R1_${i}`), R2: flip(`R2_${i}`), R3: flip(`R3_${i}`) } });
    });
    it.elements.forEach(e => {
      const truth = lab(`el:${it.id}:${e.id}`); if (typeof truth !== 'boolean') return;
      // AD proxy per element: the element is the object of an interaction row the AD marked storyRelevant.
      const ad = it.ad.interactions.some(x => x.storyRelevant && (baseId(x.object) === e.id || String(x.character).split(/\s*\+\s*/).includes(e.id)));
      const row = { y: truth, ad, kind: e.kind, s: { R1: 1 - q(`E1_${e.id}`), R2: q(`E2_${e.id}`), R3: q(`E3_${e.id}`) }, f: { R1: flip(`E1_${e.id}`), R2: flip(`E2_${e.id}`), R3: flip(`E3_${e.id}`) } };
      relSets.elements.push(row); if (e.kind !== 'place') relSets.elementsNoPlace.push(row);
    });
  }
  const combos = {
    'mean(¬R1,R2)': s => (s.R1 + s.R2) / 2,
    'mean(¬R1,R2,R3)': s => (s.R1 + s.R2 + s.R3) / 3,
    'max(¬R1,R2)': s => Math.max(s.R1, s.R2),
    'min(¬R1,R2)': s => Math.min(s.R1, s.R2),
  };
  const evalSet = rows => {
    const out = { n: rows.length, positives: rows.filter(r => r.y).length, majority: +(Math.max(rows.filter(r => r.y).length, rows.filter(r => !r.y).length) / rows.length).toFixed(3),
      AD: { acc: +(rows.filter(r => r.ad === r.y).length / rows.length).toFixed(3), right: rows.filter(r => r.ad === r.y).length } };
    const keys = Object.keys(rows[0].s);
    for (const k of keys) {
      const ok = rows.filter(r => (r.s[k] >= 0.5) === r.y).length;
      out[k] = { acc: +(ok / rows.length).toFixed(3), right: ok, auc: auc(rows.filter(r => r.y).map(r => r.s[k]), rows.filter(r => !r.y).map(r => r.s[k])), flips: rows.filter(r => r.f[k]).length };
    }
    if (keys.includes('R1') && keys.includes('R2')) for (const [name, fn] of Object.entries(combos)) {
      if (name.includes('R3') && !keys.includes('R3')) continue;
      const sc = rows.map(r => fn(r.s)); const ok = rows.filter((r, j) => (sc[j] >= 0.5) === r.y).length;
      out[name] = { acc: +(ok / rows.length).toFixed(3), right: ok, auc: auc(sc.filter((_, j) => rows[j].y), sc.filter((_, j) => !rows[j].y)) };
    }
    return out;
  };
  M.relevance = { rows: evalSet(relSets.rows), elements: evalSet(relSets.elements), elementsNoPlace: evalSet(relSets.elementsNoPlace),
    places: evalSet(relSets.elements.filter(r => r.kind === 'place')) };
  if (argv.dump) for (const r of gazeRows.filter(r => [r.G1, r.G2, r.ad].some(x => !r.truth.includes(x)))) console.log(JSON.stringify(r));
  fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), JSON.stringify(M, null, 2) + '\n');
  console.log(JSON.stringify(M, null, 2));
}

module.exports = { gazeCandidates, vbIndex, requests, depthByCode, depthByFocus };

if (require.main === module) {
  const fn = ({ extract, dump, labels, run, score })[mode] || (() => console.log('usage: extract | dump | labels | run | score'));
  Promise.resolve().then(fn).catch(e => { console.error(e); process.exit(1); });
}
