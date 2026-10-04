#!/usr/bin/env node
/**
 * Can Jev be the DECISION layer of the page plan? (owner, 2026-09-27)
 *
 * Target design (owner): Jev decides, the re-planner and the Art Director only
 * execute. This measures, on stored staging beats stories, each decision such a
 * layer would make:
 *
 *   grouppage  per page holding more than GROUP_STAGING_MAX named characters:
 *              "does this instant need every one of them?" (noul, 2 phrasings)
 *              + per story "which group page needs its group least?" (choice)
 *   chardrop   per (group page, character): "is X needed for this instant?"
 *              + per page "which character does the instant need least?"
 *   meta       per page, the Art Director's closed-enum fields: timeOfDay,
 *              weather, indoor, population, and emotion per character
 *   shot       per page, the shot bin from the plan line with its shot token
 *              stripped (re-test of the brief-text ❌), vs the planner's own
 *              token and the AD's `shot`; plus the $0 group rule
 *   vbentity   per (page, Visual Bible creature / secondary character / object
 *              / vehicle / clothing element): "does it belong in this page's
 *              picture?" — the AD cites ids in `objects`; a creature it writes
 *              into the prose but never cites gets no reference and no size line
 *
 *   node scripts/analysis/eval-jev-decision-layer.js extract [--days=24]
 *   node scripts/analysis/eval-jev-decision-layer.js run     [--reps=3] [--only=meta,vbentity,...]
 *   node scripts/analysis/eval-jev-decision-layer.js score   [--dump]
 *
 * Reading labels (evals/datasets/jev-decision-layer-v1/reading_labels.json,
 * committed, hashed keys, no story text) are the evaluator's own reading of
 * the plan line + arc + page text, written before the Jev scores of the
 * labelled kind were looked at, except for the meta/vbentity DISAGREEMENT
 * adjudication, which by construction reads the disputed items.
 *
 * Reads STAGING_DATABASE_URL and OPENROUTER_API_KEY (--dotenv=<path>). Items
 * and answers are gitignored (story text); metrics.json is committed.
 * see docs/decisions.md 2026-09-27 "Jev as the plan's decision layer"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const { groupPageBudget } = require('../../server/lib/castCoverage');
const { GROUP_STAGING_MAX, GROUP_WIDER_SHOTS } = require('../../server/lib/shotVocabulary');
const { EMOTIONS } = require('../../server/lib/emotionVocabulary');

const mode = process.argv[2];
const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-decision-layer-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const LABELS = path.join(DATASET_DIR, 'reading_labels.json');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-decision-layer');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const IMAGE_CEILING = 6; // the planner's stated per-scene ceiling (planCounters 8c comment)

const TIMES_OF_DAY = ['dawn', 'morning', 'midday', 'afternoon', 'evening', 'dusk', 'night'];
const WEATHERS = ['clear', 'overcast', 'rain', 'snow', 'fog', 'storm', 'none'];
const POPULATIONS = ['cast_only', 'ambient', 'crowd'];

// ───────────────────────── parsing ─────────────────────────

/** "PLAN: shot — who — instant — after" → parts. */
function parsePlanLine(line) {
  const s = String(line || '').replace(/^PLAN:\s*/, '').trim();
  const parts = s.split(/\s+—\s+/);
  return { raw: s, shot: parts[0] || '', who: parts[1] || '', instant: parts[2] || '', after: parts.slice(3).join(' — ') };
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function rosterOf(who, names) {
  return names.filter(n => new RegExp(`(^|[^\\p{L}])${esc(n)}($|[^\\p{L}])`, 'iu').test(who));
}

function vbEntities(vb) {
  const out = [];
  const add = (type, list) => {
    for (const e of list || []) {
      if (!e || !e.id) continue;
      const desc = String(e.description || [e.species, e.coloring, e.features].filter(Boolean).join(', ') || '').replace(/\s+/g, ' ').slice(0, 220);
      out.push({ type, id: String(e.id), name: e.name || e.label || e.id, label: e.label || '', species: e.species || '', desc, pages: (e.pages || e.appearsInPages || []).filter(p => p > 0) });
    }
  };
  add('creature', vb?.animals);
  add('secondary', vb?.secondaryCharacters);
  add('object', vb?.artifacts);
  add('object', vb?.genericObjects);
  add('vehicle', vb?.vehicles);
  add('clothing', vb?.clothing);
  return out;
}

const baseId = id => String(id || '').split('.')[0];

// ───────────────────────── extract ─────────────────────────

async function extract() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const days = Number(argv.days || 24);
  const rows = await pool.query(`SELECT id, data->'beatsReviewReport' b, data->'sceneImages' si, data->'visualBible' vb, data->>'language' lang
    FROM stories WHERE created_at > now() - ($1 || ' days')::interval AND data ? 'beatsReviewReport' ORDER BY created_at`, [String(days)]);
  const items = [];
  const byStory = new Map(); // story id → { arc, ents }: the Lab rows store neither
  for (const { id, b, vb } of rows.rows) byStory.set(id, { arc: String(b?.arc || ''), ents: vbEntities(vb) });
  for (const { id, b, si, vb, lang } of rows.rows) {
    const sid = id.slice(-9);
    const comm = (b?.cast?.commissioned || []).filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
    if (!b || !comm.length || !Array.isArray(b.briefsIn)) continue;
    const ents = vbEntities(vb);
    // cast.all of older rows also holds places and props the invented-name
    // scan picked up; the named characters are the commission plus the
    // bible's creatures and secondary characters.
    const castAll = [...new Set([...comm, ...ents.filter(e => e.type === 'creature' || e.type === 'secondary').map(e => e.name)])]
      .filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
    const plan = b.briefsIn.map(x => ({ pageNumber: x.pageNumber, ...parsePlanLine(x.brief) })).sort((a, c) => a.pageNumber - c.pageNumber);
    const P = plan.length;
    const budget = groupPageBudget({ pageCount: P, castCount: comm.length, maxCharactersPerScene: IMAGE_CEILING });
    const planText = plan.map(p => `Page ${p.pageNumber}: ${p.raw}`).join('\n');
    const arc = String(b.arc || '');
    const groups = plan.map(p => ({ ...p, roster: rosterOf(p.who, castAll) })).filter(p => p.roster.length > GROUP_STAGING_MAX);
    const overBudget = !!budget && groups.length > budget.max;
    for (const g of groups) {
      items.push({ kind: 'grouppage', id: `${sid}#p${g.pageNumber}`, story: sid, page: g.pageNumber, pageCount: P, planLine: g.raw, roster: g.roster, arc, planText, overBudget, budget: budget?.max ?? null, groupPages: groups.map(x => x.pageNumber) });
      for (const n of g.roster) {
        items.push({ kind: 'chardrop', id: `${sid}#p${g.pageNumber}#${n}`, story: sid, page: g.pageNumber, name: n, planLine: g.raw, roster: g.roster, arc, planText, source: 'plan' });
      }
    }
    if (groups.length >= 2) items.push({ kind: 'grouppick', id: `${sid}#pick`, story: sid, pages: groups.map(g => ({ page: g.pageNumber, planLine: g.raw, roster: g.roster })), arc, planText, overBudget, budget: budget?.max ?? null });

    // Per-page metadata (only pages the AD wrote with the light fields).
    const pages = (si || []).filter(p => p && p.sceneMetadata?.fullData).sort((a, c) => a.pageNumber - c.pageNumber);
    if (!pages.some(p => p.sceneMetadata.fullData.timeOfDay)) continue;
    const texts = pages.map(p => ({ pageNumber: p.pageNumber, text: String(p.text || '').trim() }));
    for (const p of pages) {
      const f = p.sceneMetadata.fullData;
      const pl = parsePlanLine(p.outlineExtract || '');
      const common = { story: sid, page: p.pageNumber, lang, planLine: pl.raw, planShot: pl.shot, arc, texts };
      items.push({ kind: 'meta', id: `${sid}#p${p.pageNumber}#meta`, ...common,
        ad: { timeOfDay: f.timeOfDay || null, weather: f.weather || null, population: f.population || 'cast_only', shot: f.shot || null,
          characters: (f.characters || []).map(c => ({ name: c.name, emotion: c.emotion || null, depth: c.depth || null, looksAt: c.looksAt || null, perspective: c.perspective || null })) } });
      const cited = new Set((f.objects || []).map(baseId));
      const pageEnts = ents.filter(e => e.type !== 'secondary' || !comm.includes(e.name));
      if (pageEnts.length) {
        items.push({ kind: 'vbentity', id: `${sid}#p${p.pageNumber}#vb`, ...common,
          ents: pageEnts.map(e => ({ ...e, adCited: cited.has(e.id), vbPages: e.pages.includes(p.pageNumber), adCharacter: (f.characters || []).some(c => c.name === e.name) })) });
      }
    }
  }

  // Observed drops: a Lab re-plan that took a name out of a page's who column.
  const labs = await pool.query(`SELECT id, results FROM testlab_experiments
    WHERE stage = 'beats_replan' AND status = 'completed' AND created_at > now() - ($1 || ' days')::interval ORDER BY id`, [String(days)]);
  for (const { id: expId, results } of labs.rows) {
    for (const res of results || []) {
      if (!res?.standingPlan || !res?.appliedPlan) continue;
      const comm = (res.cast?.commissioned || []).filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
      const castAll = [...new Set([...comm, ...(byStory.get(res.storyId)?.ents || []).filter(e => e.type === 'creature' || e.type === 'secondary').map(e => e.name), ...(res.cast?.invented || []).filter(n => /^[A-ZÄÖÜ]/.test(n) && n.split(' ').length === 1)])].filter(n => /^[\p{L}][\p{L}' -]*$/u.test(n) && n.length < 30);
      const after = new Map(res.appliedPlan.map(p => [p.pageNumber, parsePlanLine(p.planLine)]));
      const planText = res.standingPlan.map(p => `Page ${p.pageNumber}: ${parsePlanLine(p.planLine).raw}`).join('\n');
      for (const sp of res.standingPlan) {
        const before = parsePlanLine(sp.planLine);
        const a = after.get(sp.pageNumber);
        if (!a) continue;
        const rb = rosterOf(before.who, castAll); const ra = rosterOf(a.who, castAll);
        const removed = rb.filter(n => !ra.includes(n));
        if (!removed.length || rb.length < 3) continue;
        for (const n of rb) {
          items.push({ kind: 'chardrop', id: `lab${expId}:${String(res.storyId || '').slice(-9)}#p${sp.pageNumber}#${n}`, story: `lab${expId}`, page: sp.pageNumber, name: n, planLine: before.raw, afterLine: a.raw, roster: rb, arc: byStory.get(res.storyId)?.arc || '', planText, source: 'lab', labRemoved: removed.includes(n) });
        }
      }
    }
  }
  await pool.end();
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n');
  const count = k => items.filter(x => x.kind === k).length;
  console.log(`items: ${['grouppage', 'grouppick', 'chardrop', 'meta', 'vbentity'].map(k => `${k} ${count(k)}`).join(', ')} → ${path.relative(ROOT, ITEMS)}`);
}

// ───────────────────────── questions ─────────────────────────
// Generic wording only — no names or plots from a test story.

const PLAN_HEAD = 'THE PAGE PLAN (each line: shot — who is in frame — the instant the picture shows — what is true after):';

function planState(it, page) {
  return `THE STORY, beat by beat:\n${it.arc || '(no arc stored)'}\n\n${PLAN_HEAD}\n${it.planText}\n\nPAGE TO JUDGE: Page ${page}`;
}

function textState(it) {
  const story = it.texts.map(p => `--- Page ${p.pageNumber}${p.pageNumber === it.page ? ' (PAGE TO JUDGE)' : ''} ---\n${p.text}`).join('\n\n');
  const s = `THE STORY TEXT:\n${story}\n\nTHE PICTURE PLAN OF THE PAGE TO JUDGE (shot — who is in frame — the instant the picture shows — what is true after):\nPage ${it.page}: ${it.planLine}`;
  const withArc = `THE STORY, beat by beat:\n${it.arc}\n\n${s}`;
  return withArc.length < 30000 ? withArc : s;
}

const NEEDED_DEF = n => `${n} is needed in the picture of the page to judge: its instant gives ${n} something of their own to do, or acts on, speaks to or works against ${n}. A character who only stands by, follows, watches or is listed with the others is not needed.`;

function requests(it) {
  if (it.kind === 'grouppage') {
    const st = planState(it, it.page);
    return [{ variant: 'q', state: st, questions: {
      NEED_ALL: { type: 'noul', instructions: `The instant of the page to judge needs every one of these characters in the picture: ${it.roster.join(', ')}. A character is needed when the instant gives them something of their own to do, or acts on or works against them; one who only stands by, follows or watches is not.` },
      TOGETHER: { type: 'noul', instructions: 'The page to judge is one where the story brings the whole group together: the opening gathering, the climax, or the ending.' },
    } }];
  }
  if (it.kind === 'grouppick') {
    const st = `THE STORY, beat by beat:\n${it.arc}\n\n${PLAN_HEAD}\n${it.planText}`;
    const criteria = Object.fromEntries(it.pages.map(p => [`p${p.page}`, `Page ${p.page}: ${p.planLine}`]));
    return [{ variant: 'q', state: st, questions: { LEAST: { type: 'choice', instructions: 'Of these pages, which one needs its whole group in the picture least — the one where the fewest of its characters have something of their own to do?', criteria } } }];
  }
  if (it.kind === 'chardrop') {
    const st = planState(it, it.page);
    const qs = { NEEDED: { type: 'noul', instructions: NEEDED_DEF(it.name) } };
    // one choice per page, asked on the first character's item only
    if (it.roster[0] === it.name) qs.LEAST = { type: 'choice', instructions: 'Which character does the instant of the page to judge need least in its picture?', criteria: Object.fromEntries(it.roster.map(n => [n, n])) };
    return [{ variant: 'q', state: st, questions: qs }];
  }
  if (it.kind === 'meta') {
    const st = textState(it);
    const qs = {
      TIME: { type: 'choice', instructions: 'The time of day in the picture of the page to judge, following the story\'s clock: it holds from page to page until the story moves it.', criteria: Object.fromEntries(TIMES_OF_DAY.map(t => [t, t])) },
      WEATHER: { type: 'choice', instructions: 'The weather visible in the picture of the page to judge. `none` when the scene is indoors, where the sky is not seen. Weather holds from page to page until the story changes it.', criteria: { clear: 'clear sky', overcast: 'overcast, grey clouds', rain: 'rain', snow: 'snow', fog: 'fog or mist', storm: 'storm, strong wind', none: 'none: the scene is indoors' } },
      INDOOR: { type: 'noul', instructions: 'The picture of the page to judge is set indoors: inside a building, a room, a cave or an enclosed vehicle.' },
      POP: { type: 'choice', instructions: 'How populated the setting of the page to judge is, beyond the named characters.', criteria: { cast_only: 'cast_only: a private or remote place with nobody else, such as a home, a forest, a cave', ambient: 'ambient: a public place with a few distant passers-by, such as a street, a square, a park', crowd: 'crowd: a busy place full of people, such as a market, a fair, a station' } },
    };
    it.ad.characters.forEach((c, i) => {
      qs[`EMO${i}`] = { type: 'choice', instructions: `The one feeling ${c.name}'s face shows in the picture of the page to judge. A calm or attentive face is neutral.`, criteria: Object.fromEntries(EMOTIONS.map(e => [e, e])) };
    });
    const shotState = `A picture plan line (who is in frame — the instant the picture shows — what is true after):\n${J.planLineForJev(it.planLine)}`;
    // Second emotion phrasing: the feeling the story gives, not what a face shows
    // (the face phrasing defaulted to neutral on 40 of 55 AD disagreements).
    const emo2 = {};
    it.ad.characters.forEach((c, i) => {
      emo2[`EMO${i}`] = { type: 'choice', instructions: `The feeling ${c.name} has at this moment of the page to judge, as the story tells it.`, criteria: { happy: 'happy, glad, excited, proud', sad: 'sad, disappointed, worried about a loss', angry: 'angry, cross, defiant', afraid: 'afraid, scared, nervous, worried about danger', surprised: 'surprised, amazed, startled', disgusted: 'disgusted', neutral: 'neutral: calm, attentive, concentrating, no strong feeling' } };
    });
    return [
      ...(it.ad.characters.length ? [{ variant: 'emo2', state: st, questions: emo2 }] : []),
      { variant: 'q', state: st, questions: qs },
      { variant: 'shot', state: shotState, questions: { SHOT: J.buildShotQuestion().SHOT_TYPE } },
    ];
  }
  if (it.kind === 'vbentity') {
    const st = textState(it);
    const qs = {};
    it.ents.forEach((e, i) => {
      const what = e.type === 'creature' || e.type === 'secondary'
        ? `${e.name}${e.species ? `, the ${e.species}` : ''} (${e.desc.slice(0, 140)})`
        : `the ${e.label || e.name} (${e.desc.slice(0, 140)})`;
      qs[`E${i}`] = { type: 'noul', instructions: `${what} is in the picture of the page to judge, wholly or in part: the page's text or its picture plan puts it in the scene at that moment.` };
    });
    return [{ variant: 'q', state: st, questions: qs }];
  }
  throw new Error(`unknown kind ${it.kind}`);
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
  const items = fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse);
  const reps = Number(argv.reps || 3);
  const only = argv.only ? new Set(String(argv.only).split(',')) : null;
  const capUsd = Number(argv.capUsd || 0.5);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const prior = fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Set(prior.map(a => `${a.id}|${a.variant}|${a.rep}`));
  let cost = prior.reduce((s, a) => s + (a.cost || 0), 0);
  const tasks = [];
  for (const it of items) {
    if (only && !only.has(it.kind)) continue;
    for (const rq of requests(it)) for (let rep = 0; rep < reps; rep++) {
      if (!done.has(`${it.id}|${rq.variant}|${rep}`)) tasks.push({ it, rq, rep });
    }
  }
  console.log(`${tasks.length} calls to make (spent so far $${cost.toFixed(5)})`);
  const out = fs.createWriteStream(ANSWERS, { flags: 'a' });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Number(argv.conc || 8), tasks.length) }, async () => {
    while (next < tasks.length) {
      if (cost > capUsd) throw new Error(`cap $${capUsd} reached`);
      const { it, rq, rep } = tasks[next++];
      const r = await callWithRetry({ state: rq.state, questions: rq.questions });
      cost += r.cost;
      out.write(JSON.stringify({ id: it.id, kind: it.kind, variant: rq.variant, rep, answers: r.answers, cost: r.cost, ms: r.ms, stateChars: rq.state.length }) + '\n');
    }
  }));
  out.end();
  console.log(`done, total $${cost.toFixed(5)}`);
}

// ───────────────────────── score ─────────────────────────

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return +(s / (pos.length * neg.length)).toFixed(3);
}
function prf(rows, thr) {
  const tp = rows.filter(r => r.p >= thr && r.y).length;
  const fp = rows.filter(r => r.p >= thr && !r.y).length;
  const fn = rows.filter(r => r.p < thr && r.y).length;
  return { thr, tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null };
}
function shotBin(s) {
  const t = String(s || '').toLowerCase();
  if (/ultra|aerial|high-angle|establish|wide/.test(t)) return 'wide';
  if (/close|over-the-shoulder|detail|insert/.test(t)) return 'closeup';
  if (/medium|mid|two-shot|low-angle/.test(t)) return 'medium';
  return null;
}

function score() {
  const items = fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse);
  const answers = fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').map(JSON.parse);
  const labels = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {};
  const lab = k => labels[hash(k)];
  const by = new Map();
  for (const a of answers) { const k = `${a.id}|${a.variant}`; if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
  const reps = (id, v = 'q') => by.get(`${id}|${v}`) || [];
  const noul = (id, q, v) => { const as = reps(id, v).map(a => a.answers[q]?.noul).filter(x => typeof x === 'number'); return as.length ? mean(as) : null; };
  const noulFlip = (id, q, v) => new Set(reps(id, v).map(a => a.answers[q]?.noul >= 0.5)).size > 1;
  const choices = (id, q, v) => reps(id, v).map(a => a.answers[q]?.choice).filter(Boolean);
  const modal = xs => { const c = {}; for (const x of xs) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
  const probOf = (id, q, key, v) => mean(reps(id, v).map(a => a.answers[q]?.probabilities?.[key] ?? 0));
  const dump = !!argv.dump;
  const M = { run: path.basename(RUN_DIR), calls: answers.length, costUsd: +answers.reduce((s, a) => s + (a.cost || 0), 0).toFixed(5),
    latencyMs: (() => { const ms = answers.map(a => a.ms).filter(Boolean).sort((a, b) => a - b); return { p50: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1] }; })(),
    kinds: {} };

  // grouppage: truth = reading label keep(true)/cut(false)
  {
    const its = items.filter(i => i.kind === 'grouppage');
    const rows = its.map(i => ({ i, y: lab(`gp:${i.story}:${i.page}`), need: noul(i.id, 'NEED_ALL'), tog: noul(i.id, 'TOGETHER') })).filter(r => typeof r.y === 'boolean' && r.need != null);
    const out = { n: rows.length, keep: rows.filter(r => r.y).length, cut: rows.filter(r => !r.y).length };
    for (const q of ['need', 'tog']) {
      out[q] = { auc: auc(rows.filter(r => r.y).map(r => r[q]), rows.filter(r => !r.y).map(r => r[q])),
        // a binding CUT instruction: P(keep) below thr → cut; precision of the cut call
        cutAt: [0.2, 0.3, 0.4, 0.5].map(t => prf(rows.map(r => ({ p: 1 - r[q], y: !r.y })), 1 - t)),
        flips: its.filter(i => noulFlip(i.id, q === 'need' ? 'NEED_ALL' : 'TOGETHER')).length };
    }
    // $0 baseline: keep the group on the first and last page only
    out.positional = prf(rows.map(r => ({ p: (r.i.page === 1 || r.i.page === r.i.pageCount) ? 0 : 1, y: !r.y })), 0.5);
    // ranking within an over-budget story: cut the (groupPages - budget) pages
    // with the lowest TOGETHER; how many of them the reading also cuts
    const stories = [...new Set(its.filter(i => i.overBudget).map(i => i.story))];
    out.budgetPick = stories.map(s => {
      const all = its.filter(i => i.story === s); const k = all.length - all[0].budget;
      const lowest = all.map(i => ({ i, tog: noul(i.id, 'TOGETHER'), y: lab(`gp:${i.story}:${i.page}`) })).sort((a, b) => a.tog - b.tog).slice(0, k);
      return { story: s, groupPages: all.length, budget: all[0].budget, mustCut: k, jevCuts: lowest.map(r => `p${r.i.page}:${r.y === false ? 'reading-cut' : r.y === true ? 'reading-KEEP' : 'unlabelled'}`) };
    });
    if (dump) out.rows = rows.map(r => ({ id: r.i.id, y: r.y, need: +r.need.toFixed(2), tog: +r.tog.toFixed(2), line: r.i.planLine.slice(0, 160) }));
    M.kinds.grouppage = out;
  }
  // grouppick
  {
    const its = items.filter(i => i.kind === 'grouppick');
    const rows = its.map(i => { const cs = choices(i.id, 'LEAST'); const m = modal(cs); const pg = m ? Number(m.slice(1)) : null;
      return { id: i.id, pick: pg, flip: new Set(cs).size > 1, y: pg == null ? null : lab(`gp:${i.story}:${pg}`) }; });
    M.kinds.grouppick = { n: rows.length, pickedReadingCut: rows.filter(r => r.y === false).length, pickedReadingKeep: rows.filter(r => r.y === true).length, unlabelled: rows.filter(r => r.y == null).length, flips: rows.filter(r => r.flip).length, ...(dump ? { rows } : {}) };
  }
  // chardrop: truth = reading label needed(true)/not(false)
  {
    const its = items.filter(i => i.kind === 'chardrop');
    const rows = its.map(i => ({ i, y: lab(`cd:${i.story}:${i.page}:${i.name}`), p: noul(i.id, 'NEEDED') })).filter(r => typeof r.y === 'boolean' && r.p != null);
    const out = { n: rows.length, needed: rows.filter(r => r.y).length, notNeeded: rows.filter(r => !r.y).length,
      auc: auc(rows.filter(r => r.y).map(r => r.p), rows.filter(r => !r.y).map(r => r.p)),
      dropAt: [0.1, 0.2, 0.3, 0.4, 0.5].map(t => prf(rows.map(r => ({ p: 1 - r.p, y: !r.y })), 1 - t)),
      flips: its.filter(i => noulFlip(i.id, 'NEEDED')).length, groups: its.length };
    const lab_ = rows.filter(r => r.i.source === 'lab');
    out.labObserved = { n: lab_.length, removedByReplanner: lab_.filter(r => r.i.labRemoved).length,
      jevLowestIsRemoved: null };
    // per page LEAST choice vs reading least-needed set
    const pages = its.filter(i => i.roster[0] === i.name);
    const pr = pages.map(i => { const cs = choices(i.id, 'LEAST'); const m = modal(cs); return { id: i.id, m, flip: new Set(cs).size > 1, y: m ? lab(`cd:${i.story}:${i.page}:${m}`) : null }; });
    out.least = { pages: pr.length, pickNotNeeded: pr.filter(r => r.y === false).length, pickNeeded: pr.filter(r => r.y === true).length, unlabelled: pr.filter(r => r.y == null).length, flips: pr.filter(r => r.flip).length };
    if (dump) out.rows = rows.map(r => ({ id: r.i.id, y: r.y, p: +r.p.toFixed(2), src: r.i.source, rm: r.i.labRemoved }));
    M.kinds.chardrop = out;
  }
  // meta
  {
    const its = items.filter(i => i.kind === 'meta');
    const fields = {};
    const add = (f, o) => { (fields[f] = fields[f] || []).push(o); };
    for (const i of its) {
      if (!reps(i.id).length) continue;
      const tj = modal(choices(i.id, 'TIME')); add('timeOfDay', { id: i.id, jev: tj, ad: i.ad.timeOfDay, flip: new Set(choices(i.id, 'TIME')).size > 1, read: lab(`md:${i.id}:timeOfDay`) });
      const wj = modal(choices(i.id, 'WEATHER')); add('weather', { id: i.id, jev: wj, ad: i.ad.weather, flip: new Set(choices(i.id, 'WEATHER')).size > 1, read: lab(`md:${i.id}:weather`) });
      const ij = noul(i.id, 'INDOOR'); add('indoor', { id: i.id, jev: ij >= 0.5 ? 'indoor' : 'outdoor', p: ij, ad: i.ad.weather ? (i.ad.weather === 'none' ? 'indoor' : 'outdoor') : null, flip: noulFlip(i.id, 'INDOOR'), read: lab(`md:${i.id}:indoor`) });
      const pj = modal(choices(i.id, 'POP')); add('population', { id: i.id, jev: pj, ad: i.ad.population, flip: new Set(choices(i.id, 'POP')).size > 1, read: lab(`md:${i.id}:population`) });
      i.ad.characters.forEach((c, k) => { const cs = choices(i.id, `EMO${k}`); add('emotion', { id: `${i.id}:${c.name}`, jev: modal(cs), ad: c.emotion, flip: new Set(cs).size > 1, read: lab(`md:${i.id}:emotion:${c.name}`) }); });
      if (reps(i.id, 'emo2').length) i.ad.characters.forEach((c, k) => { const cs = choices(i.id, `EMO${k}`, 'emo2'); add('emotionStory', { id: `${i.id}:${c.name}`, jev: modal(cs), ad: c.emotion, flip: new Set(cs).size > 1, read: lab(`md:${i.id}:emotion:${c.name}`) }); });
      const sc = choices(i.id, 'SHOT', 'shot');
      add('shot', { id: i.id, jev: modal(sc), ad: shotBin(i.ad.shot), planner: shotBin(i.planShot), flip: new Set(sc).size > 1, nChars: i.ad.characters.length, adShot: i.ad.shot, planShot: i.planShot });
    }
    const out = {};
    for (const [f, rs] of Object.entries(fields)) {
      const withAd = rs.filter(r => r.ad);
      const conf = {}; for (const r of withAd) if (r.jev !== r.ad) { const k = `ad:${r.ad}→jev:${r.jev}`; conf[k] = (conf[k] || 0) + 1; }
      const read = rs.filter(r => r.read != null);
      const o = { n: rs.length, agreeAd: +(withAd.filter(r => r.jev === r.ad).length / (withAd.length || 1)).toFixed(3), flips: rs.filter(r => r.flip).length,
        disagreements: Object.fromEntries(Object.entries(conf).sort((a, b) => b[1] - a[1])) };
      if (read.length) {
        // read = the value(s) the reading accepts (string or array)
        const ok = (v, r) => (Array.isArray(r.read) ? r.read.includes(v) : r.read === v);
        o.reading = { n: read.length, jevRight: read.filter(r => ok(r.jev, r)).length, adRight: read.filter(r => ok(r.ad, r)).length };
      }
      if (f === 'shot') {
        o.agreePlanner = +(rs.filter(r => r.planner && r.jev === r.planner).length / (rs.filter(r => r.planner).length || 1)).toFixed(3);
        const maj = modal(rs.map(r => r.planner).filter(Boolean)); o.plannerMajority = { bin: maj, share: +(rs.filter(r => r.planner === maj).length / rs.length).toFixed(3) };
        o.plannerVsAd = +(rs.filter(r => r.planner && r.planner === r.ad).length / rs.length).toFixed(3);
        const grp = rs.filter(r => r.nChars > GROUP_STAGING_MAX);
        o.groupRule = { pagesOver3: grp.length, adShotNotWider: grp.filter(r => !GROUP_WIDER_SHOTS.some(w => String(r.adShot).toLowerCase() === w)).map(r => `${r.id}:${r.adShot}`), planShotNotWider: grp.filter(r => !GROUP_WIDER_SHOTS.some(w => String(r.planShot).toLowerCase() === w)).map(r => `${r.id}:${r.planShot}`) };
      }
      if (dump) o.rows = rs.filter(r => r.jev !== r.ad || r.read != null);
      out[f] = o;
    }
    M.kinds.meta = out;
  }
  // vbentity: truth = reading label where present, else AD-cited∧VB-pages agreement
  {
    const its = items.filter(i => i.kind === 'vbentity');
    const rows = [];
    for (const i of its) {
      if (!reps(i.id).length) continue;
      i.ents.forEach((e, k) => {
        const p = noul(i.id, `E${k}`);
        const read = lab(`vb:${i.id}:${e.id}`);
        rows.push({ id: `${i.id}:${e.id}`, type: e.type, name: e.name, p, flip: noulFlip(i.id, `E${k}`), ad: e.adCited, vbPages: e.vbPages, read });
      });
    }
    const out = { n: rows.length, labelled: rows.filter(r => typeof r.read === 'boolean').length, byType: {} };
    for (const t of ['creature', 'secondary', 'object', 'vehicle', 'clothing']) {
      const rs = rows.filter(r => r.type === t && typeof r.read === 'boolean');
      if (!rs.length) continue;
      out.byType[t] = { n: rs.length, present: rs.filter(r => r.read).length,
        auc: auc(rs.filter(r => r.read).map(r => r.p), rs.filter(r => !r.read).map(r => r.p)),
        at: [0.3, 0.5, 0.7, 0.85].map(th => prf(rs.map(r => ({ p: r.p, y: r.read })), th)),
        ad: prf(rs.map(r => ({ p: r.ad ? 1 : 0, y: r.read })), 0.5),
        vbPages: prf(rs.map(r => ({ p: r.vbPages ? 1 : 0, y: r.read })), 0.5),
        flips: rows.filter(r => r.type === t && r.flip).length, all: rows.filter(r => r.type === t).length };
    }
    if (dump) out.rows = rows.map(r => ({ ...r, p: r.p == null ? null : +r.p.toFixed(2) }));
    M.kinds.vbentity = out;
  }
  // per-story call count and cost for a production layer (one rep)
  const perStory = {};
  for (const a of answers.filter(x => x.rep === 0)) { const s = a.id.split('#')[0]; perStory[s] = perStory[s] || { calls: 0, usd: 0 }; perStory[s].calls++; perStory[s].usd += a.cost; }
  M.perStoryOneRep = Object.fromEntries(Object.entries(perStory).map(([k, v]) => [k, { calls: v.calls, usd: +v.usd.toFixed(5) }]));
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (!dump) fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), JSON.stringify(M, null, 2) + '\n');
  console.log(JSON.stringify(M, null, 2));
}

if (require.main === module) {
  const fn = ({ extract, run, score })[mode];
  if (!fn) console.log('usage: extract | run | score');
  else Promise.resolve().then(fn).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parsePlanLine, rosterOf, requests };
