#!/usr/bin/env node
/**
 * Do we need the beats planner, or can Jev + code turn the arc into pages?
 * (owner, 2026-09-27)
 *
 * "Do we even need the beats? Or can we feed the arc to Jev directly? Ask arc
 * to output all actions as a list. Should easily be below the 256 limit of
 * Jev. Then ask Jev picture one: which action is in it, which shot, which
 * character and artifact."
 *
 * Measured on stored staging beats books (arc + the planner's first plan):
 *
 *   limits   the real API limits (choice options, questions per call, state)
 *   extract  arc sentences, STORY LOGIC, cast, first/final plan, page text,
 *            the planner stage's stored cost and time
 *   actions  one cheap LLM call per story: the arc as an ordered ACTION list
 *            (a proxy for "the arc model outputs it" — the arc model itself is
 *            Opus and was not re-run); a second cheap call maps each planner
 *            page to the action(s) its picture shows (for the comparison only)
 *   dump     action lists for reading labels
 *   labels   --from=<local file> → hashed reading_labels.json
 *   run      Jev: (a) per action PIC / TURN / CLIMAX / OWN nouls, one call per
 *            story with every action as a question; (b) per page slot, one
 *            choice over the whole action list; then per assigned picture the
 *            shot (A1 form of eval-jev-shot-budget) and who is in frame
 *   score    code assigns actions to pages (ordered DP: pacing, opening,
 *            ending, climax, cast focal floor), compares with the planner and
 *            the reading; --split=<story> shows the page-text split (step 5)
 *
 *   node scripts/analysis/eval-jev-arc-direct.js limits
 *   node scripts/analysis/eval-jev-arc-direct.js extract --stories=dka3jpog9,z3fw660ie,...
 *   node scripts/analysis/eval-jev-arc-direct.js actions [--model=google/gemini-3.7-flash]
 *   node scripts/analysis/eval-jev-arc-direct.js run [--reps=3] [--only=a,b,page] [--capUsd=0.3]
 *   node scripts/analysis/eval-jev-arc-direct.js score [--split=<id>] [--blind]
 *
 * Reads STAGING_DATABASE_URL and OPENROUTER_API_KEY (--dotenv=<path>). Items
 * and answers are gitignored (story text); metrics.json and the hashed reading
 * labels are committed. see docs/decisions.md 2026-09-27 "Arc → Jev + code
 * instead of the beats planner"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const J = require('../../server/lib/jevAudit');
const SV = require('../../server/lib/shotVocabulary');
const { castCoverage, groupPageBudget } = require('../../server/lib/castCoverage');
const { assign: assignShots, violations: shotViolations } = require('./eval-jev-shot-budget');
const { parsePlanLine } = require('./eval-jev-decision-layer');

const mode = process.argv[2];
const DATASET_DIR = path.join(ROOT, 'evals/datasets/jev-arc-direct-v1');
const ITEMS = path.join(DATASET_DIR, 'items.jsonl');
const LABELS = path.join(DATASET_DIR, 'reading_labels.json');
const RUN_DIR = path.join(ROOT, 'evals/runs', argv.run || '2026-09-27_jev-arc-direct');
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const LLM_LOG = path.join(RUN_DIR, 'llm.jsonl');
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const words = s => String(s || '').split(/\s+/).filter(Boolean).length;

function loadItems() { return fs.readFileSync(ITEMS, 'utf8').trim().split('\n').map(JSON.parse); }
function saveItems(items) { fs.mkdirSync(DATASET_DIR, { recursive: true }); fs.writeFileSync(ITEMS, items.map(x => JSON.stringify(x)).join('\n') + '\n'); }

// ───────────────────────── limits ─────────────────────────

/** Probe the decision endpoint's real limits with tiny synthetic states (~$0.005). */
async function limits() {
  const call = async body => {
    const r = await fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'typesafe/jev-1.13', ...body }) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { /* keep text */ }
    return { status: r.status, detail: j.error?.message || '', usage: j.usage, n: Object.keys(j.answers || {}).length };
  };
  const filler = n => 'The fox walked along the river and looked at the stones. '.repeat(Math.ceil(n / 58)).slice(0, n);
  const choice = n => ({ Q: { type: 'choice', instructions: 'Which option describes the story?', criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `The fox ${i === 7 ? 'sleeps' : 'runs'} near stone ${i}.`])) } });
  const nouls = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`Q${i}`, { type: 'noul', instructions: `The fox sleeps near stone ${i}.` }]));
  const rows = [];
  for (const n of [255, 256]) rows.push({ probe: `choice with ${n} options`, ...(await call({ state: 'A fox sleeps near stone 7.', questions: choice(n) })) });
  for (const n of [256, 1000]) rows.push({ probe: `${n} noul questions in one call`, ...(await call({ state: 'A fox sleeps near stone 7.', questions: nouls(n) })) });
  for (const n of [155000, 170000]) rows.push({ probe: `state of ${n} chars`, ...(await call({ state: filler(n) + ' At the end the fox sleeps near stone 7.', questions: nouls(1) })) });
  for (const n of [100000, 140000]) rows.push({ probe: `state of ${n} chars + one 255-option choice`, ...(await call({ state: filler(n), questions: choice(255) })) });
  for (const r of rows) console.log(`${r.probe.padEnd(44)} HTTP ${r.status} answers=${r.n} in=${r.usage?.input_tokens ?? '-'} ${r.detail.slice(0, 120)}`);
}

// ───────────────────────── extract ─────────────────────────

/** The arc's numbered story sentences (the "Challenges taken" list after them is not story). */
function arcSentences(arc) {
  const out = [];
  for (const line of String(arc || '').split('\n')) {
    if (/^\s*(Challenges taken|Challenges|Events|STORY LOGIC)\b/i.test(line)) break;
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m) out.push({ n: Number(m[1]), text: m[2].trim() });
  }
  return out;
}

async function extract() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const ids = String(argv.stories || '').split(',').filter(Boolean);
  const prior = fs.existsSync(ITEMS) ? loadItems() : [];
  const items = [];
  for (const sfx of ids) {
    const { rows } = await pool.query('SELECT id, data FROM stories WHERE id LIKE $1', [`%${sfx}`]);
    if (rows.length !== 1) throw new Error(`${sfx}: ${rows.length} rows`);
    const d = rows[0].data; const b = d.beatsReviewReport; const a = d.arcReviewReport;
    const arc = a?.finalArc || b?.arc;
    if (!arc || !b?.briefsIn) throw new Error(`${sfx}: no arc or first plan`);
    const fn = d.tokenUsage?.byFunction || {};
    const stage = k => (fn[k] ? { cost: +Number(fn[k].cost || 0).toFixed(4), calls: fn[k].calls, ms: fn[k].elapsed_ms, models: fn[k].models } : null);
    const old = prior.find(p => p.id === sfx) || {};
    items.push({
      id: sfx, lang: d.language, level: d.languageLevel, pageCount: b.briefsIn.length,
      sentences: arcSentences(arc), logic: String(a?.logic || ''), centralFigure: a?.centralFigure || [],
      cast: b.cast?.commissioned || [], castAll: b.cast?.all || [], mainCharacter: b.counterStats?.mainCharacter || null,
      firstPlan: b.briefsIn.map(x => ({ page: x.pageNumber, ...parsePlanLine(x.brief) })).sort((x, y) => x.page - y.page),
      finalPlan: (d.sceneImages || []).map(p => ({ page: p.pageNumber, ...parsePlanLine(p.outlineExtract || '') })).sort((x, y) => x.page - y.page),
      pageText: (d.sceneImages || []).map(p => ({ page: p.pageNumber, words: words(p.text), text: String(p.text || '').trim() })).sort((x, y) => x.page - y.page),
      finalCounters: b.counterStats || null, wanted: b.wanted || null, deeds: b.actions || null,
      planner: { durationMs: b.durationMs, plan: stage('beats_plan'), check: stage('plan_check'), replan: stage('beats_replan'), recheck: stage('plan_recheck'), recheck2: stage('plan_recheck_r2'), rounds: (b.replanReplies || []).length, discarded: (b.discardedRounds || []).length },
      actions: old.actions || null, plannerMap: old.plannerMap || null,
    });
  }
  await pool.end();
  saveItems(items);
  for (const it of items) console.log(`${it.id} ${it.lang} ${it.level} pages ${it.pageCount} sentences ${it.sentences.length} cast ${it.cast.join('/')} planner ${Math.round(it.planner.durationMs / 1000)}s`);
}

// ───────────────────────── actions (cheap LLM) ─────────────────────────

const ACTIONS_PROMPT = `Below is the finished story of a children's picture book, as numbered sentences, and its story logic.

List every ACTION of the story, in story order. An action is one thing that happens and could be drawn as one instant: a character does something, says something, finds or loses something, or something happens to them or in their world. A sentence that holds several actions gives several lines. Never merge two actions into one line. Never add anything the story does not say. Keep every action, the small ones too.

One line per action, exactly this format:
A<n> | s<sentence number> | <who acts> | <what happens, one short clause> | <where> | <object or creature it involves, or -> | <who else is there, or ->

Use the names the story uses. Write in English. Output only the lines.

THE STORY:
{STORY}

STORY LOGIC:
{LOGIC}`;

const MAP_PROMPT = `Below is the action list of a children's picture book and a plan of its pages. Each page's picture shows one instant. For every page, name the action whose instant the picture shows. When the picture shows two actions at once, name the main one first.

Answer one line per page, exactly: Page <n>: A<k>[, A<j>]
Output only those lines.

ACTIONS:
{ACTIONS}

PAGE PLAN (each line: shot — who is in frame — the instant — what is true after):
{PLAN}`;

async function llm(prompt, model) {
  const t0 = Date.now();
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 65536, temperature: 0, usage: { include: true } }) });
  const t = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 300)}`);
  const j = JSON.parse(t);
  const text = j.choices?.[0]?.message?.content || '';
  if (!text.trim()) throw new Error('LLM: empty reply');
  return { text, cost: Number(j.usage?.cost || 0), ms: Date.now() - t0, usage: j.usage };
}

function parseActions(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const p = line.split('|').map(s => s.trim());
    const m = p[0]?.match(/^A(\d+)$/); const s = p[1]?.match(/^s(\d+)$/);
    if (!m || !s || p.length < 7) continue;
    const dash = v => (v === '-' || !v ? '' : v);
    out.push({ id: `A${m[1]}`, sentence: Number(s[1]), who: p[2], what: p[3], where: dash(p[4]), object: dash(p[5]), others: dash(p[6]) });
  }
  return out;
}

const actionLine = a => `${a.id} (s${a.sentence}): ${a.who} — ${a.what}${a.where ? ` — at ${a.where}` : ''}${a.object ? ` — ${a.object}` : ''}${a.others ? ` — also there: ${a.others}` : ''}`;

async function actions() {
  const items = loadItems();
  const model = argv.model || 'google/gemini-3.7-flash';
  fs.mkdirSync(RUN_DIR, { recursive: true });
  for (const it of items) {
    if (!it.actions || argv.force) {
      const r = await llm(ACTIONS_PROMPT.replace('{STORY}', it.sentences.map(s => `${s.n}. ${s.text}`).join('\n')).replace('{LOGIC}', it.logic), model);
      it.actions = parseActions(r.text);
      if (it.actions.length < it.sentences.length) throw new Error(`${it.id}: ${it.actions.length} actions parsed`);
      fs.appendFileSync(LLM_LOG, JSON.stringify({ id: it.id, kind: 'actions', model, cost: r.cost, ms: r.ms, usage: r.usage }) + '\n');
      console.log(`${it.id}: ${it.actions.length} actions ($${r.cost.toFixed(4)}, ${r.ms} ms)`);
    }
    if (!it.plannerMap || argv.force) {
      const r = await llm(MAP_PROMPT.replace('{ACTIONS}', it.actions.map(actionLine).join('\n')).replace('{PLAN}', it.firstPlan.map(p => `Page ${p.page}: ${p.raw}`).join('\n')), model);
      it.plannerMap = {};
      for (const line of r.text.split('\n')) {
        const m = line.match(/Page\s+(\d+):\s*(.+)$/);
        if (m) it.plannerMap[m[1]] = (m[2].match(/A\d+/g) || []);
      }
      fs.appendFileSync(LLM_LOG, JSON.stringify({ id: it.id, kind: 'map', model, cost: r.cost, ms: r.ms, usage: r.usage }) + '\n');
      console.log(`${it.id}: planner map ${Object.keys(it.plannerMap).length} pages ($${r.cost.toFixed(4)})`);
    }
  }
  saveItems(items);
}

function dump() {
  for (const it of loadItems()) {
    if (argv.id && it.id !== argv.id) continue;
    console.log(`\n=== ${it.id} (${it.lang}, ${it.level}, ${it.pageCount}p, ${it.actions?.length} actions) cast ${it.cast.join(', ')} | central ${it.centralFigure.join(', ')}`);
    for (const a of it.actions || []) console.log(actionLine(a));
    if (argv.plan) for (const p of it.firstPlan) console.log(`p${p.page} [${(it.plannerMap?.[p.page] || []).join(',')}] ${p.raw}`);
  }
}

/** Local labels file → hashed JSON. Lines: `<story>` then `pic: A1 A3 ...`, `must: ...`, `climax: A40`. */
function labels() {
  const out = {}; let story = null;
  for (const line of fs.readFileSync(argv.from, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    const m = line.match(/^(pic|must|climax|opening|ending):\s*(.*)$/);
    if (m && story) { out[hash(`${story}:${m[1]}`)] = m[2].match(/A\d+/g) || []; continue; }
    story = line;
  }
  fs.mkdirSync(DATASET_DIR, { recursive: true });
  fs.writeFileSync(LABELS, JSON.stringify(out) + '\n');
  console.log(`${Object.keys(out).length} label rows → ${path.relative(ROOT, LABELS)}`);
}

// ───────────────────────── Jev questions ─────────────────────────
// Generic wording: no names or plots of a test story.

const storyState = it => `THE STORY, sentence by sentence:\n${it.sentences.map(s => `${s.n}. ${s.text}`).join('\n')}\n\nTHE STORY'S ACTIONS, in order:\n${it.actions.map(actionLine).join('\n')}`;

const ACTION_Q = {
  PIC: id => `Action ${id} is a moment a child would want to see drawn in this picture book: one clear, visible instant — not a thought, a summary or a feeling alone.`,
  TURN: id => `Action ${id} is a turning point: after it, what the heroes want, what stands in their way, or what they can do is different.`,
  CLIMAX: id => `Action ${id} is the climax of the story: the one decisive act the whole story builds toward, where the problem is finally overcome.`,
  OWN: id => `Action ${id} needs a picture of its own: telling it only in the words of a page whose picture shows a neighbouring action would lose something the reader must see.`,
};

function requests(it) {
  const out = [];
  const S = storyState(it);
  const qa = {};
  for (const a of it.actions) for (const [k, f] of Object.entries(ACTION_Q)) qa[`${k}_${a.id}`] = { type: 'noul', instructions: f(a.id) };
  out.push({ id: `${it.id}#a`, variant: 'a', state: S, questions: qa });
  const opts = Object.fromEntries(it.actions.map(a => [a.id, actionLine(a).slice(0, 200)]));
  for (let p = 1; p <= it.pageCount; p++) {
    out.push({ id: `${it.id}#b${p}`, variant: 'b', state: S, questions: { PICK: { type: 'choice',
      instructions: `The book tells this whole story on ${it.pageCount} pages, in story order, one picture per page, each picture showing one action. Which action does the picture of page ${p} of ${it.pageCount} show?`, criteria: opts } } });
  }
  return out;
}

/** Per assigned picture: shot (the A1 form measured in eval-jev-shot-budget) and who is in frame. */
const DEF = Object.fromEntries(SV.SHOTS.map(s => [s.id, s.id === 'over-the-shoulder' ? `${s.definition} ${SV.OTS_NO_CONTACT_RULE}` : s.definition]));
const ART = id => (/^[aeiou]/.test(id) ? 'an' : 'a');
function pageRequests(it, picks) {
  const out = [];
  const byId = new Map(it.actions.map(a => [a.id, a]));
  const planBlock = picks.map((id, i) => `Page ${i + 1}: ${actionLine(byId.get(id))}`).join('\n');
  const who = [...new Set([...it.cast, ...it.centralFigure])];
  picks.forEach((id, i) => {
    const state = `THE STORY, sentence by sentence:\n${it.sentences.map(s => `${s.n}. ${s.text}`).join('\n')}\n\nTHE PAGES, one action per picture:\n${planBlock}\n\nPAGE TO JUDGE: Page ${i + 1} — ${actionLine(byId.get(id))}`;
    const qs = {};
    SV.SHOT_TYPES.forEach((sh, k) => { qs[`S${k}`] = { type: 'noul', instructions: `The picture of the page to judge is best told as ${ART(sh)} ${sh} shot, better than by any other camera shot. ${DEF[sh]}` }; });
    who.forEach((n, k) => { qs[`W${k}`] = { type: 'noul', instructions: `${n} is needed in the picture of the page to judge: the instant cannot be told without ${n} in the frame.` }; });
    out.push({ id: `${it.id}#p${i + 1}`, variant: 'page', state, questions: qs, meta: { action: id } });
  });
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

function loadAnswers() { return fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }

async function run() {
  const items = loadItems();
  const reps = Number(argv.reps || 3);
  const only = new Set(String(argv.only || 'a,b').split(','));
  const capUsd = Number(argv.capUsd || 0.3);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const prior = loadAnswers();
  const done = new Set(prior.map(a => `${a.id}|${a.variant}|${a.rep}`));
  let cost = prior.reduce((s, a) => s + (a.cost || 0), 0);
  const all = [];
  for (const it of items) {
    all.push(...requests(it));
    if (only.has('page')) {
      const res = assemble(it, prior, 'a');
      all.push(...pageRequests(it, res.picks));
    }
  }
  const tasks = [];
  for (const rq of all.filter(r => only.has(r.variant))) for (let rep = 0; rep < reps; rep++) if (!done.has(`${rq.id}|${rq.variant}|${rep}`)) tasks.push({ rq, rep });
  console.log(`${tasks.length} calls (spent so far $${cost.toFixed(5)}, cap $${capUsd})`);
  const out = fs.createWriteStream(ANSWERS, { flags: 'a' });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Number(argv.conc || 8), tasks.length) }, async () => {
    while (next < tasks.length) {
      if (cost > capUsd) throw new Error(`cap $${capUsd} reached`);
      const { rq, rep } = tasks[next++];
      const r = await callWithRetry({ state: rq.state, questions: rq.questions });
      cost += r.cost;
      out.write(JSON.stringify({ id: rq.id, variant: rq.variant, rep, answers: r.answers, meta: rq.meta || null, cost: r.cost, ms: r.ms, stateChars: rq.state.length, nq: Object.keys(rq.questions).length }) + '\n');
    }
  }));
  out.end();
  console.log(`done, total $${cost.toFixed(5)}`);
}

// ───────────────────────── the assignment (code) ─────────────────────────

/**
 * Ordered selection of pageCount actions (pictures) from the action list.
 * Page j's TEXT tells the actions after picture j-1 up to picture j (the last
 * page also the tail). Maximises the summed per-action value minus a pacing
 * penalty on each page's text load (in arc words) and a stronger one on a
 * page that tells nothing new before its picture. Hard: page 1 shows one of
 * the first actions of sentence 1-2, the last page one of the last sentence's
 * actions, the climax action is a picture. Cast floor: every commissioned
 * character is the actor of ≥ focalPagesNeeded pictures — enforced by raising
 * that character's actions' value until met (at most 8 rounds).
 */
function selectPictures(it, value, { climax = null, lambda = 0.6 } = {}) {
  const A = it.actions; const K = A.length; const N = it.pageCount;
  const load = A.map(a => Math.max(1, words(a.what) + (a.object ? 1 : 0)));
  const totalLoad = load.reduce((s, x) => s + x, 0);
  const target = totalLoad / N;
  const lastSentence = Math.max(...A.map(a => a.sentence));
  const firstOK = i => A[i].sentence <= 2;
  const lastOK = i => A[i].sentence === lastSentence;
  const cov = castCoverage({ pageCount: N, castCount: it.cast.length });
  const need = cov ? cov.focalPagesNeeded : 1;
  const actsOf = (name, i) => new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'iu').test(A[i].who);
  let bonus = new Array(K).fill(0);
  let best = null;
  for (let round = 0; round < 8; round++) {
    const v = A.map((_, i) => value[i] + bonus[i] + (climax != null && i === climax ? 100 : 0));
    // dp[j][i]: best score with picture j (0-based) on action i
    const NEG = -1e18;
    const dp = Array.from({ length: N }, () => new Array(K).fill(NEG));
    const bp = Array.from({ length: N }, () => new Array(K).fill(-1));
    const segLoad = (from, to) => { let s = 0; for (let x = from; x <= to; x++) s += load[x]; return s; };
    const pen = l => lambda * ((l - target) / target) ** 2;
    for (let i = 0; i < K; i++) if (firstOK(i)) dp[0][i] = v[i] - pen(segLoad(0, i));
    for (let j = 1; j < N; j++) {
      for (let i = j; i < K; i++) {
        for (let h = j - 1; h < i; h++) {
          if (dp[j - 1][h] === NEG) continue;
          let l = segLoad(h + 1, i);
          if (j === N - 1) l += (i + 1 < K ? segLoad(i + 1, K - 1) : 0);
          const s = dp[j - 1][h] + v[i] - pen(l);
          if (s > dp[j][i]) { dp[j][i] = s; bp[j][i] = h; }
        }
      }
    }
    let end = -1;
    for (let i = 0; i < K; i++) if (lastOK(i) && dp[N - 1][i] > NEG && (end < 0 || dp[N - 1][i] > dp[N - 1][end])) end = i;
    if (end < 0) throw new Error(`${it.id}: no feasible selection`);
    const idx = new Array(N); idx[N - 1] = end;
    for (let j = N - 1; j > 0; j--) idx[j - 1] = bp[j][idx[j]];
    best = idx;
    const short = it.cast.filter(n => idx.filter(i => actsOf(n, i)).length < need);
    if (!short.length) break;
    for (const n of short) A.forEach((_, i) => { if (actsOf(n, i)) bonus[i] += 0.25; });
    if (round === 7) best.unmetFocal = short;
  }
  // page loads (arc-word proxy) for the text split
  const loads = best.map((i, j) => {
    const from = j === 0 ? 0 : best[j - 1] + 1; const to = j === N - 1 ? K - 1 : i;
    let s = 0; for (let x = from; x <= to; x++) s += load[x]; return s;
  });
  best.loads = loads;
  return best;
}

/** Monotone path through per-page choice probabilities (design b): max Σ log P(page j shows action i). */
function monotonePath(it, P) {
  const K = it.actions.length; const N = it.pageCount; const NEG = -1e18;
  const lp = P.map(row => row.map(p => Math.log(Math.max(p, 1e-4))));
  const dp = Array.from({ length: N }, () => new Array(K).fill(NEG));
  const bp = Array.from({ length: N }, () => new Array(K).fill(-1));
  for (let i = 0; i < K; i++) dp[0][i] = lp[0][i];
  for (let j = 1; j < N; j++) {
    let bestH = -1;
    for (let i = j; i < K; i++) {
      const h = i - 1;
      if (dp[j - 1][h] > NEG && (bestH < 0 || dp[j - 1][h] > dp[j - 1][bestH])) bestH = h;
      if (bestH >= 0) { dp[j][i] = dp[j - 1][bestH] + lp[j][i]; bp[j][i] = bestH; }
    }
  }
  let end = 0; for (let i = 0; i < K; i++) if (dp[N - 1][i] > dp[N - 1][end]) end = i;
  const idx = new Array(N); idx[N - 1] = end;
  for (let j = N - 1; j > 0; j--) idx[j - 1] = bp[j][idx[j]];
  return idx;
}

/** Averaged per-action scores from variant (a). */
function actionScores(it, answers) {
  const reps = answers.filter(a => a.id === `${it.id}#a` && a.variant === 'a');
  if (!reps.length) return null;
  const out = {};
  for (const k of Object.keys(ACTION_Q)) out[k] = it.actions.map(a => mean(reps.map(r => r.answers[`${k}_${a.id}`].noul)));
  out.reps = reps.length;
  return out;
}

const VALUE = S => S.PIC.map((_, i) => S.PIC[i] + S.OWN[i] + 0.5 * S.TURN[i]);

function assemble(it, answers, variant) {
  const S = actionScores(it, answers);
  if (!S) throw new Error(`${it.id}: no (a) answers yet`);
  const climax = S.CLIMAX.reduce((b, x, i) => (x > S.CLIMAX[b] ? i : b), 0);
  if (variant === 'a') {
    const idx = selectPictures(it, VALUE(S), { climax });
    return { idx, picks: idx.map(i => it.actions[i].id), climax, S };
  }
  const K = it.actions.length;
  const P = [];
  for (let p = 1; p <= it.pageCount; p++) {
    const reps = answers.filter(a => a.id === `${it.id}#b${p}`);
    if (!reps.length) return null;
    P.push(it.actions.map(a => mean(reps.map(r => r.answers.PICK.probabilities?.[a.id] ?? 0))));
  }
  const idx = monotonePath(it, P);
  return { idx, picks: idx.map(i => it.actions[i].id), climax, S, P, K };
}

// ───────────────────────── score ─────────────────────────

function focalOf(it, picks) {
  const byId = new Map(it.actions.map(a => [a.id, a]));
  return Object.fromEntries(it.cast.map(n => [n, picks.filter(id => new RegExp(`(^|[^\\p{L}])${n}($|[^\\p{L}])`, 'iu').test(byId.get(id)?.who || '')).length]));
}

function score() {
  const items = loadItems();
  const answers = loadAnswers();
  const L = fs.existsSync(LABELS) ? JSON.parse(fs.readFileSync(LABELS, 'utf8')) : {};
  const lab = (st, k) => L[hash(`${st}:${k}`)];
  const M = { run: path.basename(RUN_DIR), jevCalls: answers.length, jevCostUsd: +answers.reduce((s, a) => s + (a.cost || 0), 0).toFixed(5),
    jevMsP50: null, llm: [], stories: {} };
  const ms = answers.map(a => a.ms).sort((x, y) => x - y); M.jevMsP50 = ms[Math.floor(ms.length / 2)] || null;
  if (fs.existsSync(LLM_LOG)) M.llm = fs.readFileSync(LLM_LOG, 'utf8').trim().split('\n').map(JSON.parse).map(x => ({ id: x.id, kind: x.kind, model: x.model, cost: x.cost, ms: x.ms }));
  for (const it of items) {
    const K = it.actions.length; const N = it.pageCount;
    const pic = new Set(lab(it.id, 'pic') || []); const must = new Set(lab(it.id, 'must') || []);
    const climaxSet = lab(it.id, 'climax') || []; const climaxL = climaxSet[0];
    const plannerPicks = it.firstPlan.map(p => (it.plannerMap?.[p.page] || [])[0]).filter(Boolean);
    const plannerAll = new Set(it.firstPlan.flatMap(p => it.plannerMap?.[p.page] || []));
    const ra = assemble(it, answers, 'a'); const rb = assemble(it, answers, 'b');
    const S = ra.S;
    const auc = (pos, neg) => { if (!pos.length || !neg.length) return null; let s = 0; for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0; return +(s / pos.length / neg.length).toFixed(3); };
    const idxOf = new Map(it.actions.map((a, i) => [a.id, i]));
    const aucOf = (arr, set) => auc(it.actions.filter(a => set.has(a.id)).map(a => arr[idxOf.get(a.id)]), it.actions.filter(a => !set.has(a.id)).map(a => arr[idxOf.get(a.id)]));
    const V = VALUE(S);
    const evalSeq = picks => {
      const set = new Set(picks);
      const pageOf = id => picks.indexOf(id) + 1;
      const fo = focalOf(it, picks);
      const cov = castCoverage({ pageCount: N, castCount: it.cast.length });
      return {
        mustCovered: must.size ? `${[...must].filter(x => set.has(x)).length}/${must.size}` : null,
        picInReading: pic.size ? `${picks.filter(x => pic.has(x)).length}/${picks.length}` : null,
        climaxPage: climaxL ? (climaxSet.some(x => set.has(x)) ? `${pageOf(climaxSet.find(x => set.has(x)))}/${N}` : 'missing') : null,
        agreeWithPlanner: `${picks.filter(x => plannerAll.has(x)).length}/${picks.length}`,
        focal: fo, focalShort: cov ? it.cast.filter(n => fo[n] < cov.focalPagesNeeded) : [],
        maxActionsPerPage: Math.max(...picks.map((id, j) => idxOf.get(id) - (j ? idxOf.get(picks[j - 1]) : -1))),
      };
    };
    const row = {
      pages: N, actions: K, sentences: it.sentences.length, actionsPerSentence: +(K / it.sentences.length).toFixed(2),
      planner: { ...it.planner },
      auc: { PIC_vs_readingPic: aucOf(S.PIC, pic), OWN_vs_readingPic: aucOf(S.OWN, pic), VALUE_vs_readingPic: aucOf(V, pic), VALUE_vs_must: aucOf(V, must) },
      jevClimax: it.actions[ra.climax].id, readingClimax: climaxSet, jevClimaxAcceptable: climaxSet.includes(it.actions[ra.climax].id), jevClimaxTop3: [...S.CLIMAX.keys()].sort((x, y) => S.CLIMAX[y] - S.CLIMAX[x]).slice(0, 3).map(i => it.actions[i].id),
      readingInPlanner: pic.size ? `${[...plannerAll].filter(x => pic.has(x)).length}/${plannerAll.size}` : null,
      // ORACLE: the same ordered DP fed the READING's value (must 2, pic 1) —
      // the ceiling of the code assignment, separating it from Jev's scores.
      seq: { planner: evalSeq(plannerPicks), a: evalSeq(ra.picks), b: rb ? evalSeq(rb.picks) : null,
        oracle: must.size ? evalSeq(selectPictures(it, it.actions.map(a => (must.has(a.id) ? 2 : pic.has(a.id) ? 1 : 0)), { climax: idxOf.get(climaxL) }).map(i => it.actions[i].id)) : null },
      picks: { planner: plannerPicks, a: ra.picks, b: rb?.picks || null },
      unmetFocal: ra.idx.unmetFocal || [],
      loads: ra.idx.loads,
    };
    // Shot + who on the (a) pictures, if asked.
    const pa = answers.filter(a => a.variant === 'page' && a.id.startsWith(`${it.id}#p`));
    if (pa.length) {
      const pages = ra.picks.map((id, i) => {
        const reps = pa.filter(a => a.id === `${it.id}#p${i + 1}`);
        const who = [...new Set([...it.cast, ...it.centralFigure])];
        const W = who.map((n, k) => [n, mean(reps.map(r => r.answers[`W${k}`].noul))]);
        return { page: i + 1, S: Object.fromEntries(SV.SHOT_TYPES.map((sh, k) => [sh, mean(reps.map(r => r.answers[`S${k}`].noul))])), roster: W.filter(([, p]) => p >= 0.5).map(([n]) => n) };
      });
      const shots = assignShots(pages, pages.map(p => p.S));
      row.pagesA = pages.map((p, i) => ({ page: p.page, action: ra.picks[i], shot: shots[i], who: p.roster }));
      row.shotViolations = shotViolations(pages, shots);
      const gp = groupPageBudget({ pageCount: N, castCount: it.cast.length, maxCharactersPerScene: 6 });
      row.groupPages = { used: pages.filter(p => p.roster.length > SV.GROUP_STAGING_MAX).length, budget: gp?.max };
      const inFrame = Object.fromEntries(it.cast.map(n => [n, pages.filter(p => p.roster.includes(n)).length]));
      row.appearances = inFrame;
    }
    M.stories[it.id] = row;
  }
  const out = JSON.stringify(M, null, 1);
  if (!argv.quiet) console.log(out);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), out + '\n');
  if (argv.split) splitView(items.find(i => i.id === argv.split), assemble(items.find(i => i.id === argv.split), answers, 'a'));
  if (argv.blind) blindView(items, answers);
}

/** Step 5: the page TEXT split the (a) pictures imply, vs the stored page text. */
function splitView(it, ra) {
  const byIdx = it.actions;
  const arcWords = it.sentences.reduce((s, x) => s + words(x.text), 0);
  const bookWords = it.pageText.reduce((s, x) => s + x.words, 0);
  console.log(`\n=== text split ${it.id} (${it.level}): arc ${arcWords} words → stored book ${bookWords} words (×${(bookWords / arcWords).toFixed(2)})`);
  const sentWords = new Map(it.sentences.map(s => [s.n, words(s.text)]));
  const perSentenceActions = new Map(); for (const a of byIdx) perSentenceActions.set(a.sentence, (perSentenceActions.get(a.sentence) || 0) + 1);
  ra.idx.forEach((i, j) => {
    const from = j === 0 ? 0 : ra.idx[j - 1] + 1; const to = j === ra.idx.length - 1 ? byIdx.length - 1 : i;
    const seg = byIdx.slice(from, to + 1);
    // arc words of the segment: each action carries its sentence's words / that sentence's action count
    const w = seg.reduce((s, a) => s + sentWords.get(a.sentence) / perSentenceActions.get(a.sentence), 0);
    const est = Math.round(w * bookWords / arcWords);
    console.log(`p${String(j + 1).padStart(2)} picture ${byIdx[i].id} | text ${seg[0].id}–${seg[seg.length - 1].id} (${seg.length} actions, s${seg[0].sentence}–s${seg[seg.length - 1].sentence}) ≈ ${est} words | stored p${j + 1}: ${it.pageText[j]?.words} words`);
    for (const a of seg) console.log(`      ${a.id === byIdx[i].id ? '▶' : ' '} ${actionLine(a)}`);
  });
}

/** Blind pairs: the planner's and the Jev+code picture sequence, same action wording, random side. */
function blindView(items, answers) {
  const out = []; const key = {};
  for (const it of items) {
    const byId = new Map(it.actions.map(a => [a.id, a]));
    const planner = it.firstPlan.map(p => (it.plannerMap?.[p.page] || [])[0]);
    const jev = assemble(it, answers, 'a').picks;
    const flip = parseInt(hash(it.id).slice(0, 2), 16) % 2 === 1;
    key[it.id] = flip ? { X: 'jev', Y: 'planner' } : { X: 'planner', Y: 'jev' };
    const [X, Y] = flip ? [jev, planner] : [planner, jev];
    const fmt = seq => seq.map((id, i) => `  Page ${i + 1}: ${id ? `${byId.get(id).who} — ${byId.get(id).what}` : '(no action)'}`).join('\n');
    out.push(`### Book ${it.id} (${it.pageCount} pages; cast ${it.cast.join(', ')})\nSTORY:\n${it.sentences.map(s => `${s.n}. ${s.text}`).join('\n')}\n\nSEQUENCE X:\n${fmt(X)}\n\nSEQUENCE Y:\n${fmt(Y)}\n`);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'blind.md'), out.join('\n'));
  fs.writeFileSync(path.join(RUN_DIR, 'blind-key.json'), JSON.stringify(key, null, 1));
  console.log(`blind pairs → ${path.relative(ROOT, path.join(RUN_DIR, 'blind.md'))} (key in blind-key.json)`);
}

module.exports = { arcSentences, parseActions, selectPictures, monotonePath };

if (require.main === module) {
  const fns = { limits, extract, actions, dump, labels, run, score };
  if (!fns[mode]) { console.error(`mode: ${Object.keys(fns).join('|')}`); process.exit(1); }
  Promise.resolve(fns[mode]()).catch(e => { console.error(e); process.exit(1); });
}
