#!/usr/bin/env node
/**
 * Can Jev pick each page's SHOT when code holds the budget? (owner, 2026-09-27)
 *
 * "Jev can also do the shot size (over the shoulder, extra-wide etc.). Just
 * think how you ask Jev. It gets the budget how many shots of each type, and
 * per shot it can rank which shots are best. Or just per shot rank which shot
 * type is best and then pick per code. Try 3-4 things to see what works."
 *
 * The earlier shot tests asked Jev to CLASSIFY a plan line's shot (❌ twice).
 * This asks which shot SERVES the page, and lets code do the budgeted
 * assignment (shotVocabulary floors, the medium/wide cap, the group rule, no
 * same shot twice in a row). Approaches, all on the FIRST plan (briefsIn) of
 * every staging beats story, the plan line's own shot token stripped:
 *
 *   A1 fit      per page, one noul per shot: "a <shot> (definition) serves
 *               this page's instant best" → score(page, shot); code assigns
 *   A2 rank     per story and shot, a choice over the book's pages: "which
 *               page is the best <shot> of this book" → P(page | shot); code
 *               takes the top pages per quota, then assigns
 *   A3 choice   per page, one choice over the eight shots → P(shot | page)
 *   A4 nature   per page, nouls about the MOMENT (a feeling on one face / the
 *               place and its size / two figures facing across a distance /
 *               a height or something big looked up at / the ground seen from
 *               above / a whole-body action) → code maps nature → shot
 *
 * Extra fields on the four books whose briefs carry them (the decision layer's
 * "untested J" row): population per LOCATION, looksAt, depth, aboard,
 * storyRelevant — against the Art Director and the reading.
 *
 *   node scripts/analysis/eval-jev-shot-budget.js extract
 *   node scripts/analysis/eval-jev-shot-budget.js dump          # plan lines for labelling
 *   node scripts/analysis/eval-jev-shot-budget.js labels --from=<local labels file>
 *   node scripts/analysis/eval-jev-shot-budget.js run  [--reps=3] [--only=shot|fields|A1,A3,...] [--capUsd=0.4]
 *   node scripts/analysis/eval-jev-shot-budget.js score [--dump=A1|A2|A3|A4|CODE] [--readingGroup]
 *
 * --readingGroup replaces the eval's own who-column name count with the
 * reading's group flag (a head count that also reads "all four boys", as
 * planCounters' `present` does); it prints and does not write metrics.json.
 *
 * Reading labels (evals/datasets/jev-shot-budget-v1/reading_labels.json,
 * hashed keys, no story text) were written from the plan line + arc BEFORE any
 * Jev call. Items and answers are gitignored; metrics.json is committed.
 * see docs/decisions.md 2026-09-27 "Jev picks the shot, code holds the budget"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const SV = require('../../server/lib/shotVocabulary');
const { parsePlanLine, rosterOf } = require('./eval-jev-decision-layer');

const mode = process.argv[2];
const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-shot-budget-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const LABELS = path.join(DATASET_DIR, 'reading_labels.json');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-shot-budget');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/** The plan line without its shot token: the question may not see the answer. */
function stripShot(raw) {
  const parts = String(raw || '').split(/\s+—\s+/);
  if (parts.length > 1 && SV.resolveShotId(parts[0]) && parts[0].split(/\s+/).length <= 4) parts.shift();
  return parts.join(' — ');
}

// ───────────────────────── extract ─────────────────────────

async function extract() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const since = argv.since || '2026-09-03';
  const rows = await pool.query(`SELECT id, data->'beatsReviewReport' b, data->'sceneImages' si, data->'visualBible' vb, data->>'language' lang
    FROM stories WHERE created_at > $1 AND data ? 'beatsReviewReport' ORDER BY created_at`, [since]);
  const items = [];
  const commOf = b => (b?.cast?.commissioned || []).filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
  // The most recent N full books (default 17, the decision layer's dataset size).
  const eligible = rows.rows.filter(({ b }) => b && commOf(b).length && Array.isArray(b.briefsIn) && b.briefsIn.length >= 8).slice(-Number(argv.last || 17));
  for (const { id, b, si, vb, lang } of eligible) {
    const comm = commOf(b);
    const sid = id.slice(-9);
    const creatures = [...(vb?.animals || []), ...(vb?.secondaryCharacters || [])].map(e => e?.name).filter(Boolean);
    const castAll = [...new Set([...comm, ...creatures])].filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
    const plan = b.briefsIn.map(x => ({ page: x.pageNumber, ...parsePlanLine(x.brief) })).sort((a, c) => a.page - c.page);
    const ad = new Map((si || []).filter(p => p?.sceneMetadata?.fullData).map(p => [p.pageNumber, { shot: p.sceneMetadata.fullData.shot || null, finalLine: parsePlanLine(p.outlineExtract || '').raw }]));
    items.push({ kind: 'story', id: sid, lang, arc: String(b.arc || ''), pageCount: plan.length,
      pages: plan.map(p => ({ page: p.page, line: stripShot(p.raw), planShot: SV.resolveShotId(p.shot), planShotRaw: p.shot,
        roster: rosterOf(p.who, castAll), adShot: SV.resolveShotId(ad.get(p.page)?.shot), adSameLine: ad.get(p.page)?.finalLine === p.raw })) });

    // The four books whose briefs carry the metadata fields.
    const pages = (si || []).filter(p => p?.sceneMetadata?.fullData?.timeOfDay).sort((a, c) => a.pageNumber - c.pageNumber);
    if (!pages.length) continue;
    const texts = pages.map(p => ({ page: p.pageNumber, text: String(p.text || '').trim() }));
    const locs = (vb?.locations || []).map(l => ({ id: l.id, name: l.name, desc: String(l.description || '').slice(0, 240), setting: l.setting || '',
      pages: (l.pages || []).filter(n => n > 0) }));
    // Every vehicle of the book is asked on every page: whether the camera is
    // aboard is the question, so no page may be pre-filtered by a mention.
    const vehicles = (vb?.vehicles || []).map(v => ({ id: v.id, name: v.properName || v.label || v.name || v.id, desc: String(v.description || '').slice(0, 200) }));
    for (const p of pages) {
      const f = p.sceneMetadata.fullData;
      const locIds = [...new Set((f.objects || []).filter(o => /^LOC\d+/.test(o)).map(o => o.split('.')[0]))];
      items.push({ kind: 'fields', id: `${sid}#p${p.pageNumber}`, story: sid, page: p.pageNumber, lang,
        planLine: parsePlanLine(p.outlineExtract || '').raw, texts, locIds,
        vehicles,
        ad: { population: f.population || null, aboard: f.aboard || null,
          characters: (f.characters || []).map(c => ({ name: c.name, depth: c.depth || null, looksAt: c.looksAt || null })),
          interactions: (f.interactions || []).map(x => ({ character: x.character, action: x.action, object: x.object, where: x.where, storyRelevant: !!x.storyRelevant, priority: x.priority || null })),
          objects: f.objects || [] } });
    }
    for (const l of locs) {
      if (!l.pages.length) continue;
      const adPop = pages.filter(p => (p.sceneMetadata.fullData.objects || []).some(o => o.split('.')[0] === l.id)).map(p => ({ page: p.pageNumber, pop: p.sceneMetadata.fullData.population || 'cast_only' }));
      items.push({ kind: 'location', id: `${sid}#${l.id}`, story: sid, loc: l, arc: String(b.arc || ''),
        planLines: plan.filter(p => l.pages.includes(p.page)).map(p => `Page ${p.page}: ${stripShot(p.raw)}`), adPop });
    }
  }
  await pool.end();
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const count = k => items.filter(x => x.kind === k).length;
  console.log(`stories ${count('story')} (${items.filter(x => x.kind === 'story').reduce((n, s) => n + s.pageCount, 0)} pages), fields ${count('fields')}, locations ${count('location')}`);
}

function loadItems() { return fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse); }

function dump() {
  for (const it of loadItems()) {
    if (it.kind === 'story' && (!argv.kind || argv.kind === 'story')) {
      console.log(`\n=== ${it.id} (${it.lang}, ${it.pageCount}p) ARC:\n${it.arc.slice(0, Number(argv.arcChars || 1500))}`);
      for (const p of it.pages) console.log(`p${p.page} [${p.roster.length}] ${p.line}`);
    }
    if (it.kind === 'location' && argv.kind === 'location') {
      console.log(`\n${it.id} ${it.loc.name} — ${it.loc.desc} | ${it.loc.setting} | AD: ${it.adPop.map(x => `p${x.page}:${x.pop}`).join(' ')}\n  ${it.planLines.join('\n  ')}`);
    }
    if (it.kind === 'fields' && argv.kind === 'fields') {
      console.log(`\n${it.id} ${it.planLine}\n  TEXT: ${it.texts.find(t => t.page === it.page)?.text.replace(/\s+/g, ' ')}\n  aboard=${it.ad.aboard} veh=[${it.vehicles.map(v => `${v.id}:${v.name}`).join(', ')}]\n  chars: ${it.ad.characters.map(c => `${c.name}(${c.depth}, looks ${c.looksAt})`).join('; ')}\n  inter: ${it.ad.interactions.map((x, k) => `#${k} ${x.character} ${x.action} ${x.object} [${x.storyRelevant ? 'REL' : '-'}]`).join('; ')}`);
    }
  }
}

// ───────────────────────── questions ─────────────────────────
// Generic wording only — no names or plots from a test story. A1 reads the
// vocabulary's own definitions (the constants the planner is shown), so the
// question and the planner can never describe a shot differently.

const IDS = SV.SHOT_TYPES; // close-up, medium, wide, ultra-wide, over-the-shoulder, high-angle, low-angle, aerial
const ART = id => (/^[aeiou]/.test(id) ? 'an' : 'a');
const DEF = Object.fromEntries(SV.SHOTS.map(s => [s.id, s.id === 'over-the-shoulder' ? `${s.definition} ${SV.OTS_NO_CONTACT_RULE}` : s.definition]));

/** What each shot LOOKS like, one line each — the A2/A3 option texts. */
const LOOK = {
  'close-up': 'close-up: one or two figures from the waist up, their faces, or their hands and what they hold, large in the frame',
  medium: 'medium: one to three whole figures and their full action, with some of the setting around them',
  wide: 'wide: the full setting, with the figures whole inside it',
  'ultra-wide': 'ultra-wide: the whole place from a distance, the figures small within it',
  'over-the-shoulder': 'over-the-shoulder: from behind one figure, cropped at the shoulder, toward what that figure faces, small and far across the frame; never when that figure touches what it faces',
  'high-angle': 'high-angle: looking down on the figures from above head height, the ground behind them',
  'low-angle': 'low-angle: looking up from below at something tall or high, the sky or ceiling behind it; never up at a grown-up or a creature standing over a child',
  aerial: "aerial: straight down from far above, a bird's-eye view of the whole place",
};

/** A4: what the MOMENT is about. Code maps these to shots (NATURE_TO_SHOT). */
const NATURE = {
  FACE: 'The instant of the page to judge is about a feeling on one or two faces, a few words spoken close, or a small thing in someone\'s hands — something the reader must see near.',
  PLACE: 'The instant of the page to judge is about a place and its size: the setting itself, a way across it, a distance between two things, or figures small inside it.',
  FACING: 'The instant of the page to judge is one figure facing another figure, creature or thing across a gap — a meeting, a stand-off, a demand, a call — without touching it.',
  UP: 'The instant of the page to judge is about something high: a tree, a tower, the sky, something flying, or a figure climbing, that the reader should look up at.',
  DOWN: 'The instant of the page to judge is about something low: a thing on the ground, a figure fallen, crawling, sitting defeated or small at the bottom, or a look down steps or into a hollow.',
  OVERVIEW: 'The instant of the page to judge shows a whole place from far above: a flight over it, or the ground laid out like a map.',
  BODY: 'The instant of the page to judge is a whole-body action: running, climbing, lifting, pulling, falling, or several figures working together.',
};
const NATURE_TO_SHOT = n => ({
  'close-up': n.FACE, medium: n.BODY, wide: (n.PLACE + n.BODY) / 2, 'ultra-wide': n.PLACE,
  'over-the-shoulder': n.FACING, 'high-angle': n.DOWN, 'low-angle': n.UP, aerial: n.OVERVIEW,
});

const PLAN_HEAD = 'THE PAGE PLAN (each line: who is in frame — the instant the picture shows — what is true after):';
const planBlock = st => st.pages.map(p => `Page ${p.page}: ${p.line}`).join('\n');
const pageState = (st, p) => `THE STORY, beat by beat:\n${st.arc || '(no arc stored)'}\n\n${PLAN_HEAD}\n${planBlock(st)}\n\nPAGE TO JUDGE: Page ${p.page} — ${p.line}`;
const bookState = st => `THE STORY, beat by beat:\n${st.arc || '(no arc stored)'}\n\n${PLAN_HEAD}\n${planBlock(st)}`;

function shotRequests(st) {
  const out = [];
  for (const p of st.pages) {
    const s1 = pageState(st, p);
    const id = `${st.id}#p${p.page}`;
    out.push({ id, variant: 'A1', state: s1, questions: Object.fromEntries(IDS.map((sh, k) => [`S${k}`, { type: 'noul',
      instructions: `The picture of the page to judge is best told as ${ART(sh)} ${sh} shot, better than by any other camera shot. ${DEF[sh]}` }])) });
    out.push({ id, variant: 'A3', state: s1, questions: { SHOT: { type: 'choice',
      instructions: 'Which camera shot tells the instant of the page to judge best?', criteria: Object.fromEntries(IDS.map((sh, k) => [`S${k}`, LOOK[sh]])) } } });
    out.push({ id, variant: 'A4', state: s1, questions: Object.fromEntries(Object.entries(NATURE).map(([k, v]) => [k, { type: 'noul', instructions: v }])) });
  }
  const bs = bookState(st);
  IDS.forEach((sh, k) => out.push({ id: `${st.id}#S${k}`, variant: 'A2', state: bs, questions: { PAGE: { type: 'choice',
    instructions: `Which page of this book is the best one to draw as ${ART(sh)} ${LOOK[sh]}?`,
    criteria: Object.fromEntries(st.pages.map(p => [`p${p.page}`, `Page ${p.page}: ${p.line.slice(0, 160)}`])) } } }));
  return out;
}

// ───────────────────────── extra fields ─────────────────────────

function fieldState(it) {
  const story = it.texts.map(p => `--- Page ${p.page}${p.page === it.page ? ' (PAGE TO JUDGE)' : ''} ---\n${p.text}`).join('\n\n');
  return `THE STORY TEXT:\n${story}\n\nTHE PICTURE PLAN OF THE PAGE TO JUDGE (who is in frame — the instant the picture shows — what is true after):\nPage ${it.page}: ${stripShot(it.planLine)}`;
}

function fieldRequests(it) {
  const qs = {};
  const chars = it.ad.characters;
  chars.forEach((c, i) => {
    const others = chars.filter(o => o.name !== c.name).map(o => o.name);
    qs[`LOOK${i}`] = { type: 'choice', instructions: `What ${c.name} looks at in the picture of the page to judge.`,
      criteria: { ...Object.fromEntries(others.map((n, k) => [`c${k}`, n])), thing: 'the thing, creature or place the instant is about (not one of the named characters)', viewer: 'the viewer', away: 'nothing in particular: away, down or ahead' } };
    qs[`DEPTH${i}`] = { type: 'choice', instructions: `How near the camera ${c.name} stands in the picture of the page to judge.`,
      criteria: { foreground: 'foreground: nearest the camera, large', midground: 'midground: in the middle of the picture', background: 'background: far from the camera, small' } };
  });
  it.ad.interactions.forEach((x, i) => {
    qs[`REL${i}`] = { type: 'noul', instructions: `In the picture of the page to judge, "${x.character} ${x.action} ${x.object}" is part of what the page's story moment is about, not just background business.` };
  });
  it.vehicles.forEach((v, i) => {
    qs[`ABOARD${i}`] = { type: 'noul', instructions: `The camera of the picture of the page to judge stands on or inside ${v.name} (${v.desc.slice(0, 120)}): its deck, floor or interior is the ground the picture is taken from.` };
  });
  return Object.keys(qs).length ? [{ id: it.id, variant: 'F', state: fieldState(it), questions: qs }] : [];
}

function locationRequests(it) {
  const st = `A PLACE IN A CHILDREN'S PICTURE BOOK: ${it.loc.name}${it.loc.setting ? ` (${it.loc.setting})` : ''} — ${it.loc.desc}\n\nTHE STORY, beat by beat:\n${it.arc}\n\nTHE PAGES SET THERE (who is in frame — the instant — what is true after):\n${it.planLines.join('\n')}`;
  return [{ id: it.id, variant: 'LOC', state: st, questions: {
    PUBLIC: { type: 'noul', instructions: 'This place is one the public can walk into: a street, a square, a park, a bridge, a station, a shop, a museum hall.' },
    CROWD: { type: 'noul', instructions: 'The story sets this place around a crowd: a market, a fair, a parade, a packed hall — many people are part of the scene.' },
    POP: { type: 'choice', instructions: 'How populated this place is in the story\'s pictures, beyond the named characters.', criteria: { cast_only: 'cast_only: a private or remote place with nobody else', ambient: 'ambient: a public place with a few distant passers-by', crowd: 'crowd: a busy place full of people' } },
  } }];
}

/** --only takes variants (A1,A2,A3,A4,F,LOC) or groups (shot = A1-A4, fields = F,LOC). */
function allRequests(items, only) {
  const want = v => !only || only.has(v) || (only.has('shot') && /^A\d$/.test(v)) || (only.has('fields') && (v === 'F' || v === 'LOC'));
  const out = [];
  for (const it of items) {
    if (it.kind === 'story') out.push(...shotRequests(it));
    if (it.kind === 'fields') out.push(...fieldRequests(it));
    if (it.kind === 'location') out.push(...locationRequests(it));
  }
  return out.filter(r => want(r.variant));
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
  const capUsd = Number(argv.capUsd || 0.4);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const prior = fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Set(prior.map(a => `${a.id}|${a.variant}|${a.rep}`));
  let cost = prior.reduce((s, a) => s + (a.cost || 0), 0);
  let tasks = [];
  for (const rq of allRequests(items, only)) for (let rep = 0; rep < reps; rep++) {
    if (!done.has(`${rq.id}|${rq.variant}|${rep}`)) tasks.push({ rq, rep });
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
      out.write(JSON.stringify({ id: rq.id, variant: rq.variant, rep, answers: r.answers, cost: r.cost, ms: r.ms, stateChars: rq.state.length }) + '\n');
    }
  }));
  out.end();
  console.log(`done, total $${cost.toFixed(5)}`);
}

// ───────────────────────── the budgeted assignment (code) ─────────────────────────

// The assignment (hungarian, budgetOf, violations, assign) moved VERBATIM into
// server/lib/jevDecisions.js on 2026-09-27 when production adopted it — one
// copy, so the eval measures the code that ships.
const { hungarian, budgetOf, violations, assign } = require('../../server/lib/jevDecisions');

// ───────────────────────── score ─────────────────────────

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return +(s / (pos.length * neg.length)).toFixed(3);
}
const CODE = { C: 'close-up', M: 'medium', W: 'wide', U: 'ultra-wide', O: 'over-the-shoulder', H: 'high-angle', L: 'low-angle', A: 'aerial' };

/** A local labels file (evaluator's reading, story ids + codes) → hashed reading_labels.json. */
function labels() {
  const src = fs.readFileSync(argv.from, 'utf8');
  const out = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {};
  let story = null; let n = 0;
  for (const line of src.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    const m = line.match(/^(\d+)\s+([A-Z])\|([A-Z]+)(\s+g)?$/);
    if (m) { out[hash(`shot:${story}:${m[1]}`)] = { best: CODE[m[2]], ok: [...m[3]].map(c => CODE[c]), group: !!m[4] }; n++; continue; }
    const f = line.match(/^(\S+)\s+=\s+(.+)$/); // field label: key = json value
    if (f) { out[hash(f[1])] = JSON.parse(f[2]); n++; continue; }
    story = line;
  }
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(LABELS, JSON.stringify(out) + '\n');
  console.log(`${n} labels → ${path.relative(ROOT, LABELS)} (${Object.keys(out).length} total)`);
}

const argmax = x => IDS.reduce((a, c) => (x[c] > x[a] ? c : a), IDS[0]);

function score() {
  const items = loadItems();
  const answers = fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').map(JSON.parse);
  const L = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const lab = k => L[hash(k)];
  const by = new Map(answers.map(a => [`${a.id}|${a.variant}|${a.rep}`, a]));
  const get = (id, v, rep) => by.get(`${id}|${v}|${rep}`);
  const stories = items.filter(i => i.kind === 'story');
  if (argv.readingGroup) for (const st of stories) for (const p of st.pages) { const l = lab(`shot:${st.id}:${p.page}`); if (l) p.groupOverride = l.group; }
  const REPS = [0, 1, 2];
  const M = { run: path.basename(RUN_DIR), calls: answers.length, costUsd: +answers.reduce((s, a) => s + (a.cost || 0), 0).toFixed(5), methods: {} };

  // Per method and rep: S[page][shot] for one story.
  const matrix = {
    A1: (st, rep) => st.pages.map(p => { const a = get(`${st.id}#p${p.page}`, 'A1', rep); return a && Object.fromEntries(IDS.map((id, k) => [id, a.answers[`S${k}`].noul])); }),
    A2: (st, rep) => {
      const cols = IDS.map((id, k) => {
        const a = get(`${st.id}#S${k}`, 'A2', rep); if (!a) return null;
        const pr = a.answers.PAGE.probabilities || {};
        const mx = Math.max(...st.pages.map(p => pr[`p${p.page}`] || 0)) || 1;
        return st.pages.map(p => (pr[`p${p.page}`] || 0) / mx);
      });
      if (cols.some(c => !c)) return st.pages.map(() => null);
      return st.pages.map((_, i) => Object.fromEntries(IDS.map((id, k) => [id, cols[k][i]])));
    },
    A3: (st, rep) => st.pages.map(p => { const a = get(`${st.id}#p${p.page}`, 'A3', rep); return a && Object.fromEntries(IDS.map((id, k) => [id, a.answers.SHOT.probabilities?.[`S${k}`] ?? 0])); }),
    A4: (st, rep) => st.pages.map(p => { const a = get(`${st.id}#p${p.page}`, 'A4', rep); return a && NATURE_TO_SHOT(Object.fromEntries(Object.keys(NATURE).map(k => [k, a.answers[k].noul]))); }),
    // A1 and A3 averaged (no extra calls: both are already asked per page).
    'A1+A3': (st, rep) => { const a = matrix.A1(st, rep); const b = matrix.A3(st, rep); return a.map((x, i) => (x && b[i] ? Object.fromEntries(IDS.map(id => [id, (x[id] + b[i][id]) / 2])) : null)); },
    // $0 baseline, rules only: the who column's head count and the page's place in the book.
    CODE: st => st.pages.map((p, i) => {
      const n = p.roster.length; const S = Object.fromEntries(IDS.map(id => [id, 0.1]));
      if (n > SV.GROUP_STAGING_MAX) S.wide = 1;
      else if (n === 0) { S['ultra-wide'] = 0.8; S.wide = 0.6; }
      else if (n === 1) { S['close-up'] = 0.6; S.medium = 0.5; }
      else if (n === 2) { S.medium = 0.6; S['over-the-shoulder'] = 0.4; S['close-up'] = 0.4; }
      else { S.medium = 0.6; S.wide = 0.5; }
      if (i === 0 || i === st.pages.length - 1) S.wide = Math.max(S.wide, 0.9);
      return S;
    }),
  };
  const avgMatrix = (fn, st) => {
    const ms = REPS.map(r => fn(st, r));
    return st.pages.map((_, i) => (ms.some(m => !m[i]) ? null : Object.fromEntries(IDS.map(id => [id, mean(ms.map(m => m[i][id]))]))));
  };

  const rowsOf = (st, shots) => st.pages.map((p, i) => ({ l: lab(`shot:${st.id}:${p.page}`), s: shots[i] }));
  const kindOf = v => { const [a, b] = v.split(':'); return /^p\d+$/.test(b) ? a : `${a}:${b}`; };
  function summarise(rows, perStory, distinct) {
    const lr = rows.filter(r => r.l && r.s);
    const mix = {}; for (const r of lr) mix[r.s] = (mix[r.s] || 0) + 1;
    return {
      pages: lr.length,
      acceptable: +(lr.filter(r => r.l.ok.includes(r.s)).length / lr.length).toFixed(3),
      best: +(lr.filter(r => r.l.best === r.s).length / lr.length).toFixed(3),
      readingGroupPagesNotWider: `${lr.filter(r => r.l.group && !SV.GROUP_WIDER_SHOTS.includes(r.s)).length}/${lr.filter(r => r.l.group).length}`,
      ruleViolations: perStory.reduce((n, v) => n + v.length, 0),
      ruleViolationKinds: perStory.flat().reduce((acc, v) => { acc[kindOf(v)] = (acc[kindOf(v)] || 0) + 1; return acc; }, {}),
      booksMeetingAllRules: `${perStory.filter(v => !v.length).length}/${perStory.length}`,
      distinctShotsPerBook: distinct ? +mean(distinct).toFixed(1) : null,
      shotMix: mix,
    };
  }

  // References: the planner's own first-plan shot, and the Art Director's.
  {
    const rows = []; const per = []; const distinct = [];
    for (const st of stories) { const sh = st.pages.map(p => p.planShot); rows.push(...rowsOf(st, sh)); per.push(violations(st.pages, sh)); distinct.push(new Set(sh).size); }
    M.methods.planner = summarise(rows, per, distinct);
    const ad = stories.flatMap(st => rowsOf(st, st.pages.map(p => (p.adSameLine ? p.adShot : null)))).filter(r => r.l && r.s);
    M.methods.artDirector = { pages: ad.length, note: 'pages whose final plan line equals the first only', acceptable: +(ad.filter(r => r.l.ok.includes(r.s)).length / (ad.length || 1)).toFixed(3), best: +(ad.filter(r => r.l.best === r.s).length / (ad.length || 1)).toFixed(3) };
  }

  const shape = repFn => {
    const rows = []; const per = []; const raw = []; const distinct = []; let unmet = 0;
    for (const st of stories) {
      const S = repFn(st);
      if (S.some(x => !x)) continue;
      const shots = assign(st.pages, S);
      if (shots.unmet) unmet++;
      rows.push(...rowsOf(st, shots)); per.push(violations(st.pages, shots)); distinct.push(new Set(shots).size);
      raw.push(...rowsOf(st, S.map(argmax)));
    }
    if (!rows.length) return null;
    const lr = raw.filter(r => r.l);
    return { assigned: { ...summarise(rows, per, distinct), booksWithUnmetHardRule: unmet },
      rawArgmax: { acceptable: +(lr.filter(r => r.l.ok.includes(r.s)).length / lr.length).toFixed(3), best: +(lr.filter(r => r.l.best === r.s).length / lr.length).toFixed(3), readingGroupPagesNotWider: lr.filter(r => r.l.group && !SV.GROUP_WIDER_SHOTS.includes(r.s)).length } };
  };

  for (const [name, fn] of Object.entries(matrix)) {
    if (name === 'CODE') { M.methods.CODE = shape(st => fn(st)); continue; }
    if (!name.split('+').every(v => answers.some(a => a.variant === v))) continue;
    const o = { mean3: shape(st => avgMatrix(fn, st)), oneCall: shape(st => fn(st, 0)) };
    const pos = []; const neg = []; const posB = []; const negB = []; const perShot = Object.fromEntries(IDS.map(id => [id, [[], []]]));
    for (const st of stories) {
      const S = avgMatrix(fn, st);
      st.pages.forEach((p, i) => {
        const l = lab(`shot:${st.id}:${p.page}`); if (!l || !S[i]) return;
        for (const id of IDS) { const ok = l.ok.includes(id); (ok ? pos : neg).push(S[i][id]); (l.best === id ? posB : negB).push(S[i][id]); perShot[id][ok ? 0 : 1].push(S[i][id]); }
      });
    }
    o.aucAcceptable = auc(pos, neg); o.aucBest = auc(posB, negB);
    o.aucPerShot = Object.fromEntries(IDS.map(id => [id, auc(...perShot[id])]));
    let pagesN = 0; let flips = 0; let rawFlips = 0;
    for (const st of stories) {
      const per = REPS.map(r => fn(st, r)); if (per.some(m => m.some(x => !x))) continue;
      const asg = per.map(S => assign(st.pages, S)); const arg = per.map(S => S.map(argmax));
      st.pages.forEach((_, i) => { pagesN++; if (new Set(asg.map(a => a[i])).size > 1) flips++; if (new Set(arg.map(a => a[i])).size > 1) rawFlips++; });
    }
    o.flipRate = { assigned: +(flips / (pagesN || 1)).toFixed(3), rawArgmax: +(rawFlips / (pagesN || 1)).toFixed(3), pages: pagesN };
    // Where the assignment and the planner disagree: whose shot the reading accepts.
    {
      let n = 0; let jevOk = 0; let planOk = 0; let bothOk = 0;
      for (const st of stories) {
        const S = avgMatrix(fn, st); if (S.some(x => !x)) continue;
        const shots = assign(st.pages, S);
        st.pages.forEach((p, i) => {
          const l = lab(`shot:${st.id}:${p.page}`); if (!l || !p.planShot || p.planShot === shots[i]) return;
          n++; const j = l.ok.includes(shots[i]); const pl = l.ok.includes(p.planShot);
          if (j && pl) bothOk++; else if (j) jevOk++; else if (pl) planOk++;
        });
      }
      o.vsPlanner = { disagreements: n, onlyJevAcceptable: jevOk, onlyPlannerAcceptable: planOk, bothAcceptable: bothOk, neither: n - jevOk - planOk - bothOk };
    }
    // The six books planned under the current eight-word vocabulary and floors.
    {
      const cur = stories.filter(st => st.pages.some(p => SV.POSITION_SHOTS.includes(p.planShot)));
      const per = []; const perPlan = []; const rows = []; const rowsPlan = [];
      for (const st of cur) {
        const S = avgMatrix(fn, st); if (S.some(x => !x)) continue;
        const shots = assign(st.pages, S);
        per.push(violations(st.pages, shots)); rows.push(...rowsOf(st, shots));
        const ps = st.pages.map(p => p.planShot); perPlan.push(violations(st.pages, ps)); rowsPlan.push(...rowsOf(st, ps));
      }
      const acc = rs => { const lr = rs.filter(r => r.l && r.s); return +(lr.filter(r => r.l.ok.includes(r.s)).length / lr.length).toFixed(3); };
      o.currentVocabularyBooks = { books: cur.map(s => s.id).join(','), jev: { acceptable: acc(rows), ruleViolations: per.flat().length }, planner: { acceptable: acc(rowsPlan), ruleViolations: perPlan.flat().length, kinds: perPlan.flat().map(kindOf).reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {}) } };
    }
    const vs = name.split('+');
    const va = answers.filter(a => vs.includes(a.variant) && a.rep === 0);
    const ms = answers.filter(a => vs.includes(a.variant)).map(a => a.ms).sort((a, b) => a - b);
    o.perStoryOneRep = { calls: +(va.length / stories.length).toFixed(1), usd: +(va.reduce((s, a) => s + a.cost, 0) / stories.length).toFixed(5), p50ms: ms[Math.floor(ms.length / 2)], p90ms: ms[Math.floor(ms.length * 0.9)] };
    M.methods[name] = o;
  }
  const ls = stories.flatMap(st => st.pages.map(p => lab(`shot:${st.id}:${p.page}`)).filter(Boolean));
  M.labels = { pages: ls.length, meanAcceptable: +mean(ls.map(l => l.ok.length)).toFixed(2), groupPages: ls.filter(l => l.group).length,
    chanceAcceptable: +mean(ls.map(l => l.ok.length / IDS.length)).toFixed(3),
    bestMix: ls.reduce((a, l) => { a[l.best] = (a[l.best] || 0) + 1; return a; }, {}) };
  if (argv.dump) {
    const fn = matrix[argv.dump] || matrix.A1;
    for (const st of stories) {
      const S = argv.dump === 'CODE' ? fn(st) : avgMatrix(fn, st); if (S.some(x => !x)) continue;
      const shots = assign(st.pages, S);
      console.log(`\n${st.id} ${violations(st.pages, shots).join(' ')}`);
      st.pages.forEach((p, i) => { const l = lab(`shot:${st.id}:${p.page}`); console.log(`p${p.page} [${p.roster.length}] plan=${p.planShot} got=${shots[i]} read=${l?.best}|${l?.ok.join(',')} ${l?.ok.includes(shots[i]) ? '' : 'X'} :: ${IDS.map(id => `${id.slice(0, 4)} ${S[i][id].toFixed(2)}`).join(' ')}`); });
    }
    return;
  }
  M.fields = scoreFields(items, get, lab);
  if (!argv.readingGroup) fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), JSON.stringify(M, null, 2) + '\n');
  console.log(JSON.stringify(M, null, 2));
}

/**
 * The untested decision-layer fields, against the reading and the Art Director.
 * The AD's looksAt is a name, an element id or a word; it is mapped onto the
 * question's options: a character on the page → that name; away/ahead/down →
 * away; viewer/camera → viewer; anything else (an id, an object) → thing.
 */
function scoreFields(items, get, lab) {
  const REPS = [0, 1, 2];
  const modal = xs => { const c = {}; for (const x of xs) if (x != null) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
  const out = {};
  const tally = () => ({ n: 0, agreeAd: 0, withAd: 0, read: 0, jevRight: 0, adRight: 0, flips: 0, conf: {} });
  const T = { looksAt: tally(), depth: tally(), storyRelevant: tally(), aboard: tally() };
  const relRows = [];
  const add = (t, jev, ad, read, flip) => {
    t.n++; if (flip) t.flips++;
    if (ad != null) { t.withAd++; if (jev === ad) t.agreeAd++; else { const k = `ad:${ad}→jev:${jev}`; t.conf[k] = (t.conf[k] || 0) + 1; } }
    if (read != null) { const ok = v => (Array.isArray(read) ? read.includes(v) : read === v); t.read++; if (ok(jev)) t.jevRight++; if (ok(ad)) t.adRight++; }
  };
  for (const it of items.filter(i => i.kind === 'fields')) {
    const reps = REPS.map(r => get(it.id, 'F', r)).filter(Boolean);
    if (!reps.length) continue;
    const names = it.ad.characters.map(c => c.name);
    it.ad.characters.forEach((c, i) => {
      const others = names.filter(n => n !== c.name);
      const lk = reps.map(a => { const ch = a.answers[`LOOK${i}`]?.choice; return /^c\d+$/.test(ch || '') ? others[Number(ch.slice(1))] : ch; });
      const adL = c.looksAt == null ? null : names.includes(c.looksAt) ? c.looksAt : /^(away|ahead|down|forward|off|nothing)/i.test(c.looksAt) ? 'away' : /viewer|camera|reader/i.test(c.looksAt) ? 'viewer' : 'thing';
      add(T.looksAt, modal(lk), adL, lab(`fld:${it.id}:look:${c.name}`) ?? null, new Set(lk).size > 1);
      const dp = reps.map(a => a.answers[`DEPTH${i}`]?.choice);
      add(T.depth, modal(dp), c.depth, lab(`fld:${it.id}:depth:${c.name}`) ?? null, new Set(dp).size > 1);
    });
    it.ad.interactions.forEach((x, i) => {
      const ps = reps.map(a => a.answers[`REL${i}`]?.noul).filter(v => typeof v === 'number');
      const p = mean(ps); const read = lab(`fld:${it.id}:rel:${i}`);
      add(T.storyRelevant, p >= 0.5, x.storyRelevant, read ?? null, new Set(ps.map(v => v >= 0.5)).size > 1);
      if (typeof read === 'boolean') relRows.push({ p, y: read, ad: x.storyRelevant });
    });
    it.vehicles.forEach((v, i) => {
      const ps = reps.map(a => a.answers[`ABOARD${i}`]?.noul).filter(n => typeof n === 'number');
      add(T.aboard, mean(ps) >= 0.5, it.ad.aboard === v.id, lab(`fld:${it.id}:aboard:${v.id}`) ?? null, new Set(ps.map(n => n >= 0.5)).size > 1);
    });
  }
  for (const [k, t] of Object.entries(T)) out[k] = { n: t.n, agreeAd: +(t.agreeAd / (t.withAd || 1)).toFixed(3), flips: t.flips, reading: { n: t.read, jevRight: t.jevRight, adRight: t.adRight }, disagreements: t.conf };
  out.storyRelevant.aucVsReading = auc(relRows.filter(r => r.y).map(r => r.p), relRows.filter(r => !r.y).map(r => r.p));
  // population per LOCATION: the choice, and the two nouls mapped in code
  const locs = [];
  for (const it of items.filter(i => i.kind === 'location')) {
    const reps = REPS.map(r => get(it.id, 'LOC', r)).filter(Boolean); if (!reps.length) continue;
    const pop = reps.map(a => a.answers.POP.choice);
    const pub = mean(reps.map(a => a.answers.PUBLIC.noul)); const crowd = mean(reps.map(a => a.answers.CROWD.noul));
    const mapped = crowd >= 0.5 ? 'crowd' : pub >= 0.5 ? 'ambient' : 'cast_only';
    const adVals = it.adPop.map(x => x.pop); const adModal = modal(adVals);
    locs.push({ id: it.id, read: lab(`loc:${it.id}`), choice: modal(pop), choiceFlip: new Set(pop).size > 1, mapped, publicP: +pub.toFixed(2), crowdP: +crowd.toFixed(2), adModal, adPagesDisagreeing: adVals.filter(v => v !== adModal).length, adPages: adVals.length, adValues: adVals });
  }
  const ok = (v, r) => Array.isArray(r) && r.includes(v);
  out.populationPerLocation = { n: locs.length,
    choiceRight: locs.filter(l => ok(l.choice, l.read)).length, mappedRight: locs.filter(l => ok(l.mapped, l.read)).length, adModalRight: locs.filter(l => ok(l.adModal, l.read)).length,
    adPagesRight: `${locs.reduce((n, l) => n + l.adValues.filter(v => ok(v, l.read)).length, 0)}/${locs.reduce((n, l) => n + l.adPages, 0)}`,
    choiceFlips: locs.filter(l => l.choiceFlip).length, rows: locs };
  return out;
}

module.exports = { stripShot, assign, violations, budgetOf, hungarian, shotRequests };

if (require.main === module) {
  const fn = ({ extract, dump, labels, run, score })[mode] || (() => console.log('usage: extract | dump | labels | run | score'));
  Promise.resolve().then(fn).catch(e => { console.error(e); process.exit(1); });
}

