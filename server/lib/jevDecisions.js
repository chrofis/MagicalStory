/**
 * THE JEV DECISION LAYER — Jev decides, code verifies and writes, the LLM only
 * executes (owner, 2026-09-27: "All of it should be in Jev … then give to
 * replanner the Jev output").
 *
 * Jev (`typesafe/jev-1.13`, OpenRouter /api/alpha/decisions, `jevAudit.callJev`)
 * answers yes/no (`noul`) and choice questions over a text state and generates
 * nothing. Each decision below was measured before it was built; the question
 * WORDING, the thresholds and the assignment code are the evaluated ones,
 * taken verbatim from scripts/analysis/eval-jev-decision-layer.js and
 * eval-jev-shot-budget.js (the assignment code lives HERE now and the eval
 * script imports it — one copy):
 *
 *   shots          per page, 8 nouls "best told as a <shot> shot …" (A1) →
 *                  code assigns under shotFloors / the group rule / the caps /
 *                  the consecutive rule (Hungarian + local repair)
 *                  → code writes field 0 of every plan line
 *   group cuts     TOGETHER per group page, ranked inside the budget; NEEDED per
 *                  character on the pages to reduce → code cuts < 0.5 and puts
 *                  back what the constraints need → code writes the who column
 *   light          per page: TIME (choice), INDOOR (noul), WEATHER (choice,
 *                  advisory) → code: enums, a clock that never runs backwards
 *   VB citations   per page and element: "X is in the picture …" → creatures
 *                  0.7, vehicles 0.5, secondaries 0.5, objects 0.7 (0.5–0.7 only
 *                  when the Art Director cited it, the measured band) → code:
 *                  known ids, the page's state, the element budget
 *   aboard         per page and vehicle, 0.5
 *   population     per LOCATION: PUBLIC / CROWD nouls → code maps
 *   gaze           per character: a choice over code-listed targets "what are X's
 *                  eyes and hands on?" (3 calls averaged) → code writes looksAt
 *
 * State: the arc and the plan (the page text does not exist when these run —
 * it is written after the scene review), the page marked.
 *
 * OUTAGES (owner, 2026-09-27 — an explicit exception to NO FALLBACKS): a
 * failing call waits and retries for up to 5 minutes (JEV_OUTAGE), then throws
 * JevDecisionError; beatsPipeline then runs that step and every later one on
 * the backup — today's setup before the layer — once per story, logged at
 * error level and stored as `jevFallback`. A pre-start probe (probeJev) sends a
 * whole story to the backup when Jev is down before it begins.
 *
 * see DECISIONS: docs/decisions.md 2026-09-27 "Jev decision layer wired"
 */

const J = require('./jevAudit');
const SV = require('./shotVocabulary');
const { TIMES_OF_DAY, WEATHERS } = require('./sceneLight');
const { openRouterUsage } = require('./providerUsage');
const { recordTextUsage } = require('./usageContext');
const { log } = require('../utils/logger');

class JevDecisionError extends Error {
  constructor(message) { super(message); this.name = 'JevDecisionError'; }
}

/** Calls in flight at once. */
const JEV_DECISION_CONCURRENCY = 8;

/**
 * Thresholds and repetitions, from the 2026-09-27 evaluations.
 * `reps` averages that many calls: Jev has no temperature, and the cut
 * decisions flipped 3–5% between single calls; every other decision here is
 * one call (owner: "1 call, not averaged" for shots and the time of day).
 */
const JEV_DECISIONS = {
  together: { reps: 3 },            // ranking only, never a fixed threshold (AUC 0.90, 7/7 in budget)
  needed: { reps: 3, cutBelow: 0.5 }, // AUC 0.98, 51 cuts 0 wrong
  shot: { reps: 1 },                // A1 0.918 acceptable, 0 rule violations
  light: { reps: 1, indoorAt: 0.5 },
  vb: { reps: 1, creature: 0.7, vehicle: 0.5, secondary: 0.5, object: 0.7, objectBand: 0.5 },
  aboard: { reps: 1, at: 0.5 },     // 9/10 on the one ship book
  population: { reps: 1, publicAt: 0.5, crowdAt: 0.5 }, // 13/13
  gaze: { reps: 3 },                // G2 128/139 averaged (owner: 3 calls for this field)
};

// ───────────────────────── the plan line ─────────────────────────

const SEGMENT = /\s+[—–]\s+/;

/** Field 0 of a plan line before code writes it (story-beats.txt). */
const PLAN_SHOT_PLACEHOLDER = SV.PLAN_SHOT_PLACEHOLDER;

/**
 * The plan line without its field 0 — the shot placeholder, or a shot word
 * (the eval's `stripShot`: a word the vocabulary resolves, at most 4 words).
 * The questions may never see the shot they are choosing.
 */
function stripPlanShot(raw) {
  const parts = String(raw || '').replace(/^\s*PLAN:\s*/i, '').trim().split(/\s+—\s+/);
  if (parts.length > 1 && (parts[0].trim() === PLAN_SHOT_PLACEHOLDER
    || (SV.resolveShotId(parts[0]) && parts[0].split(/\s+/).length <= 4))) parts.shift();
  return parts.join(' — ');
}

/** The plan line's segments (field 0 kept). */
function planParts(raw) {
  return String(raw || '').replace(/^\s*PLAN:\s*/i, '').trim().split(SEGMENT);
}

/** Field 0 replaced by `shot` (a line with fewer than four fields gets it prepended). */
function withShot(raw, shot) {
  const parts = planParts(raw);
  if (parts.length >= 4) parts[0] = shot;
  else parts.unshift(shot);
  return parts.join(' — ');
}

/** Names as an English who column: "A", "A and B", "A, B and C". */
function whoText(names) {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** Field 1 (who) replaced; the line must carry four fields. */
function withWho(raw, names) {
  const parts = planParts(raw);
  if (parts.length < 4) throw new JevDecisionError(`plan line has ${parts.length} field(s), not four — cannot write its who column: "${String(raw).slice(0, 120)}"`);
  parts[1] = whoText(names);
  return parts.join(' — ');
}

// ───────────────────────── states (eval-jev-shot-budget.js) ─────────────────────────

const PLAN_HEAD = 'THE PAGE PLAN (each line: who is in frame — the instant the picture shows — what is true after):';

function planBlock(pages) {
  return pages.map(p => `Page ${p.pageNumber}: ${stripPlanShot(p.planLine)}`).join('\n');
}

/** The arc + the whole plan (shot stripped), the page marked — the A1 state. */
function pageState(arc, pages, page) {
  return `THE STORY, beat by beat:\n${String(arc || '').trim() || '(no arc stored)'}\n\n${PLAN_HEAD}\n${planBlock(pages)}\n\nPAGE TO JUDGE: Page ${page.pageNumber} — ${stripPlanShot(page.planLine)}`;
}

// ───────────────────────── the call pool ─────────────────────────

/**
 * THE OUTAGE POLICY (owner, 2026-09-27: B + C + A).
 *   B  before a beats story starts, `probeJev` asks one tiny question; Jev down
 *      → the whole story runs the backup (today's setup before the layer).
 *   C  mid-story, a failing call is retried with backoff (2 s, 4 s, … capped at
 *      60 s) for up to `waitMs` (5 min) from its first failure — the step waits
 *      and resumes where it stood; the story is never restarted. A missing
 *      OPENROUTER_API_KEY is configuration, not an outage: never retried.
 *   A  a call still failing after the wait throws JevDecisionError; the caller
 *      (beatsPipeline) switches THAT STEP AND EVERY LATER ONE to the backup,
 *      once per story, logged at error level and stored as `jevFallback`.
 * Every call also has a hard timeout (`callTimeoutMs`), counted as a failure.
 * Mutable only so tests can shorten the wait.
 */
const JEV_OUTAGE = { waitMs: 5 * 60 * 1000, maxBackoffMs: 60 * 1000, callTimeoutMs: 60 * 1000, probeTimeoutMs: 20 * 1000 };
const NOT_AN_OUTAGE = /OPENROUTER_API_KEY is not set|network call blocked in unit tests/;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); }),
  ]);
}

/**
 * Run a list of Jev requests with bounded concurrency. Every answer is kept;
 * a request still failing after the outage wait (C) throws JevDecisionError,
 * the other workers stop, and nothing partial is returned.
 *
 * @param {Array<{key:string, state:string, questions:Object}>} requests
 * @param {{callImpl?:Function, concurrency?:number, usageLabel?:string, stats?:Object, retryDelayMs?:number}} opts
 * @returns {Promise<Map<string, Object[]>>} key → the answers of each rep
 */
async function runJevRequests(requests, { callImpl, concurrency = JEV_DECISION_CONCURRENCY, usageLabel = 'jev_decisions', stats = newStats(), retryDelayMs = 2000 } = {}) {
  // Resolved per call, never captured at require time: tests stub jevAudit.callJev.
  const call = callImpl || ((req) => J.callJev(req));
  const out = new Map();
  let next = 0;
  let failed = null;
  const one = async (rq) => {
    let firstFailAt = null;
    for (let attempt = 1; ; attempt++) {
      if (failed) throw failed;
      const t0 = Date.now();
      try {
        const r = await withTimeout(call({ state: rq.state, questions: rq.questions }), JEV_OUTAGE.callTimeoutMs, 'Jev call');
        const ms = Date.now() - t0;
        stats.calls++; stats.cost += Number(r.cost || 0); stats.ms.push(ms);
        recordTextUsage('openrouter', { ...openRouterUsage(r.usage), direct_cost: Number(r.cost || 0), elapsed_ms: ms }, usageLabel, r.model || J.JEV_MODEL);
        return r.answers;
      } catch (e) {
        if (e instanceof JevDecisionError && e === failed) throw e;
        const msg = String(e.message || e);
        stats.errors.push({ key: rq.key, attempt, error: msg.slice(0, 300) });
        firstFailAt = firstFailAt || Date.now();
        const waited = Date.now() - firstFailAt;
        if (NOT_AN_OUTAGE.test(msg) || waited >= JEV_OUTAGE.waitMs) {
          stats.failed++;
          throw new JevDecisionError(`Jev decision "${rq.key}" failed after ${attempt} attempt(s) over ${Math.round(waited / 1000)} s: ${msg}`);
        }
        stats.retries++;
        if (attempt === 1) log.warn(`⏳ [JEV] "${rq.key}" failed (${msg.slice(0, 160)}) — waiting and retrying for up to ${Math.round(JEV_OUTAGE.waitMs / 1000)} s`);
        const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), JEV_OUTAGE.maxBackoffMs, Math.max(0, JEV_OUTAGE.waitMs - waited));
        await new Promise(res => setTimeout(res, delay));
      }
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    while (next < requests.length && !failed) {
      const rq = requests[next++];
      try {
        const answers = await one(rq);
        if (!out.has(rq.key)) out.set(rq.key, []);
        out.get(rq.key).push(answers);
      } catch (e) {
        failed = failed || e;
        throw failed;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * B — the pre-start health check: one tiny question. Never throws.
 * @returns {Promise<{ok:boolean, ms:number, error?:string}>}
 */
async function probeJev({ callImpl } = {}) {
  const call = callImpl || ((req) => J.callJev(req));
  const t0 = Date.now();
  try {
    const r = await withTimeout(call({ state: 'A picture book page: a child holds a red kite on a hill.', questions: { PROBE: { type: 'noul', instructions: 'The page shows a kite.' } } }), JEV_OUTAGE.probeTimeoutMs, 'Jev probe');
    J.yesProb(r.answers.PROBE);
    recordTextUsage('openrouter', { ...openRouterUsage(r.usage), direct_cost: Number(r.cost || 0), elapsed_ms: Date.now() - t0 }, 'jev_decisions_probe', r.model || J.JEV_MODEL);
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 300) };
  }
}

function newStats() { return { calls: 0, cost: 0, ms: [], retries: 0, failed: 0, errors: [] }; }

/** Repeat each request `reps` times under one key. */
const repeat = (rq, reps) => Array.from({ length: reps }, () => rq);

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function meanNoul(repAnswers, id) {
  const ps = (repAnswers || []).map(a => J.yesProb(a[id]));
  return mean(ps);
}
function modalChoice(repAnswers, id) {
  const c = {};
  for (const a of repAnswers || []) {
    const ch = a[id] && a[id].choice;
    if (ch == null) throw new JevDecisionError(`Jev choice answer ${id} carries no choice: ${JSON.stringify(a[id])}`);
    c[ch] = (c[ch] || 0) + 1;
  }
  return Object.entries(c).sort((x, y) => y[1] - x[1])[0][0];
}

function summarise(stats) {
  const ms = [...stats.ms].sort((a, b) => a - b);
  return {
    calls: stats.calls, costUsd: +stats.cost.toFixed(6), retries: stats.retries, failed: stats.failed,
    p50ms: ms.length ? ms[Math.floor(ms.length / 2)] : null, maxMs: ms.length ? ms[ms.length - 1] : null,
    errors: stats.errors.slice(0, 20),
  };
}

// ───────────────────────── SHOTS (A1 + assign) ─────────────────────────
// Verbatim from scripts/analysis/eval-jev-shot-budget.js.

const IDS = SV.SHOT_TYPES; // close-up, medium, wide, ultra-wide, over-the-shoulder, high-angle, low-angle, aerial
const ART = id => (/^[aeiou]/.test(id) ? 'an' : 'a');
const DEF = Object.fromEntries(SV.SHOTS.map(s => [s.id, s.id === 'over-the-shoulder' ? `${s.definition} ${SV.OTS_NO_CONTACT_RULE}` : s.definition]));

/** A1: one noul per shot, the vocabulary's own definitions. */
function shotFitQuestions() {
  return Object.fromEntries(IDS.map((sh, k) => [`S${k}`, { type: 'noul',
    instructions: `The picture of the page to judge is best told as ${ART(sh)} ${sh} shot, better than by any other camera shot. ${DEF[sh]}` }]));
}

/** Rectangular assignment, n rows ≤ m columns, minimising cost (Hungarian, potentials). */
function hungarian(cost) {
  const n = cost.length; const m = cost[0].length; const INF = 1e18;
  const u = new Array(n + 1).fill(0); const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); const way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(INF); const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = INF; let j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta; }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

/** The book's quotas: the shotVocabulary floors, plus the caps this assignment adds. */
function budgetOf(P) {
  const f = SV.shotFloors(P);
  const positionFloors = SV.POSITION_SHOTS.reduce((n, id) => n + (f.floors[id] || 0), 0);
  return {
    floors: f.floors, requiredPositions: f.requiredPositions, maxMediumWide: f.maxMediumWide,
    // "keep the angled pages few enough that an angle still reads as one"
    caps: { 'close-up': Math.ceil(P / 3), 'ultra-wide': (f.floors['ultra-wide'] || 0) + 1, aerial: 1 },
    positionsCap: f.requiredPositions + 1,
    positionPool: Math.max(0, f.requiredPositions - positionFloors),
  };
}

// `groupOverride` stands in for a head count that also reads collective
// who-columns (the eval's --readingGroup); production passes `roster` = the
// planCounters `present` list, which already does.
const isGroup = p => (p.groupOverride != null ? p.groupOverride : p.roster.length > SV.GROUP_STAGING_MAX);
const allowedShot = (p, s) => !isGroup(p) || SV.GROUP_WIDER_SHOTS.includes(s);

/** The shot rules an assignment must hold; returns the broken ones. */
function violations(pages, shots) {
  const b = budgetOf(pages.length); const out = [];
  const count = s => shots.filter(x => x === s).length;
  for (const [s, n] of Object.entries(b.floors)) if (count(s) < n) out.push(`floor:${s}`);
  if (shots.filter(s => SV.POSITION_SHOTS.includes(s)).length < b.requiredPositions) out.push('floor:positions');
  if (count('medium') + count('wide') > b.maxMediumWide) out.push('cap:medium+wide');
  pages.forEach((p, i) => { if (!allowedShot(p, shots[i])) out.push(`group:p${p.page}`); });
  for (let i = 1; i < pages.length; i++) {
    if (shots[i] === shots[i - 1] && pages[i].roster.length === pages[i - 1].roster.length) out.push(`consecutive:p${pages[i].page}`);
  }
  return out;
}
/** The caps the assignment itself keeps. */
function capBreaks(pages, shots) {
  const b = budgetOf(pages.length); const out = [];
  for (const [s, n] of Object.entries(b.caps)) if (shots.filter(x => x === s).length > n) out.push(`cap:${s}`);
  if (shots.filter(s => SV.POSITION_SHOTS.includes(s)).length > b.positionsCap) out.push('cap:positions');
  return out;
}

/**
 * One shot per page, maximising the summed score under the budget.
 *
 * Slots: each floored shot's mandatory slots, the position pool the tier's
 * total still owes (any camera position), then optional slots up to the caps —
 * medium and wide share one pool of maxMediumWide. Mandatory slots carry a
 * bonus so they always fill. A group page (> GROUP_STAGING_MAX in frame) may
 * only take a GROUP_WIDER_SHOTS shot. Hungarian assignment of pages to slots is
 * exact for all of that. The consecutive rule (same shot and same cast count on
 * neighbours) is not a quota, so a local repair runs after: the cheapest single
 * change or swap that clears it and breaks nothing else; the aerial cap is
 * enforced the same way.
 *
 * @param {Array<{page:number, roster:string[]}>} pages
 * @param {Array<Object<string,number>>} S  S[i][shot] = fit score
 */
function assign(pages, S) {
  const P = pages.length; const b = budgetOf(P); const BIG = 10;
  const slots = [];
  const add = (n, types, mandatory) => { for (let i = 0; i < n; i++) slots.push({ types, mandatory }); };
  for (const [s, n] of Object.entries(b.floors)) add(n, [s], true);
  add(b.positionPool, SV.POSITION_SHOTS, true);
  add(b.maxMediumWide, ['medium', 'wide'], false);
  add(Math.max(0, b.caps['close-up'] - (b.floors['close-up'] || 0)), ['close-up'], false);
  add(Math.max(0, b.caps['ultra-wide'] - (b.floors['ultra-wide'] || 0)), ['ultra-wide'], false);
  add(Math.max(0, b.positionsCap - b.requiredPositions), SV.POSITION_SHOTS, false);
  if (slots.length < P) throw new Error(`assign: ${slots.length} slots for ${P} pages`);
  const pick = (i, sl) => { let best = null; for (const s of sl.types) if (allowedShot(pages[i], s) && (best == null || S[i][s] > S[i][best])) best = s; return best; };
  const cost = pages.map((_, i) => slots.map(sl => { const s = pick(i, sl); return s == null ? 1e6 : -(S[i][s] + (sl.mandatory ? BIG : 0)); }));
  let shots = hungarian(cost).map((j, i) => pick(i, slots[j]));
  const total = sh => sh.reduce((n, s, i) => n + S[i][s], 0);
  const hard = sh => violations(pages, sh).filter(v => !v.startsWith('consecutive')).length + capBreaks(pages, sh).length;
  const soft = sh => violations(pages, sh).filter(v => v.startsWith('consecutive')).length + capBreaks(pages, sh).length;
  for (let guard = 0; guard < 3 * P; guard++) {
    const now = soft(shots);
    if (!now) break;
    const cands = [];
    for (let j = 0; j < P; j++) {
      for (const s of IDS) if (s !== shots[j]) { const t = shots.slice(); t[j] = s; cands.push(t); }
      for (let k = j + 1; k < P; k++) if (shots[k] !== shots[j]) { const t = shots.slice(); [t[j], t[k]] = [t[k], t[j]]; cands.push(t); }
    }
    const better = cands.filter(t => !violations(pages, t).some(v => !v.startsWith('consecutive')) && soft(t) < now).sort((a, c) => total(c) - total(a));
    if (!better.length) break;
    shots = better[0];
  }
  if (hard(shots)) shots.unmet = violations(pages, shots);
  return shots;
}

/**
 * THE SHOT OF EVERY PAGE. Jev scores each shot's fit per page (A1, one call),
 * code assigns under the budget.
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>, present:Map<number,string[]>}} input
 *   `present` is planCounters' per-page `present` of the division that ships
 *   (the who column plus the roster's `covers`) — never a name regex.
 * @returns {Promise<{shots:string[], pages:Array, violations:string[], unmet:string[]|null, stats:Object}>}
 */
async function decideShots({ arc, pages, present }, opts = {}) {
  if (!pages || !pages.length) throw new JevDecisionError('decideShots: no pages');
  const missing = pages.filter(p => !present || !present.has(Number(p.pageNumber))).map(p => p.pageNumber);
  if (missing.length) throw new JevDecisionError(`decideShots: no head count for page(s) ${missing.join(', ')} — the plan check's roster did not cover them, so the group rule cannot be applied`);
  const stats = newStats();
  const reqs = pages.flatMap(p => repeat({ key: `shot:p${p.pageNumber}`, state: pageState(arc, pages, p), questions: shotFitQuestions() }, JEV_DECISIONS.shot.reps));
  const ans = await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_shot', stats });
  const S = pages.map(p => Object.fromEntries(IDS.map((id, k) => [id, meanNoul(ans.get(`shot:p${p.pageNumber}`), `S${k}`)])));
  const rows = pages.map(p => ({ page: Number(p.pageNumber), roster: present.get(Number(p.pageNumber)) || [] }));
  const shots = assign(rows, S);
  const out = {
    shots: [...shots],
    pages: pages.map((p, i) => ({ pageNumber: Number(p.pageNumber), shot: shots[i], headCount: rows[i].roster.length,
      scores: Object.fromEntries(IDS.map(id => [id, +S[i][id].toFixed(3)])) })),
    violations: violations(rows, shots),
    unmet: shots.unmet || null,
    stats: summarise(stats),
  };
  if (out.unmet) log.error(`❌ [JEV/shot] the assignment could not meet ${out.unmet.join(', ')} — the budget cannot hold on this plan`);
  log.info(`🎬 [JEV/shot] ${out.shots.map((s, i) => `p${pages[i].pageNumber}:${s}`).join(' ')} (${out.stats.calls} calls, $${out.stats.costUsd})`);
  return out;
}

/** Code writes field 0 of every plan line. */
function applyShots(pages, shots) {
  return pages.map((p, i) => ({ ...p, planLine: withShot(p.planLine, shots[i]) }));
}

// ───────────────────────── GROUP-PAGE CAST CUTS ─────────────────────────
// Wording verbatim from scripts/analysis/eval-jev-decision-layer.js.

/**
 * THE CAST-OUT ARE STILL IN THE STORY (2026-09-27, Lab 1577 p6). A cut takes a
 * character out of the PICTURE, never out of the story: the story may still
 * have them at the moment, just outside the frame. The dragon run's rewrite
 * said the kept boy stepped onto the path ALONE while the story has all four
 * step onto it, and the recheck filed CHECK[18]. One sentence, in the CAST CUT
 * line and the RE-DIVIDE rule.
 */
const CUT_STILL_IN_STORY = 'The characters it casts out are still part of the story at this moment, only outside the picture: the instant never says they are absent, gone or left behind, and never calls a kept character alone or the only one.';

const TOGETHER_Q = 'The page to judge is one where the story brings the whole group together: the opening gathering, the climax, or the ending.';
const NEEDED_DEF = n => `${n} is needed in the picture of the page to judge: its instant gives ${n} something of their own to do, or acts on, speaks to or works against ${n}. A character who only stands by, follows, watches or is listed with the others is not needed.`;

/**
 * WHICH GROUP PAGES KEEP THEIR GROUP, AND WHO LEAVES THE OTHERS.
 *
 * Code finds the pages (the check's `present`, > GROUP_STAGING_MAX) and the
 * budget (castCoverage.groupPageBudget). Jev ranks them by TOGETHER; code keeps
 * the top `budget`. On each page to reduce Jev scores NEEDED per character; code
 * cuts every name below 0.5, then keeps whoever a constraint needs:
 *   - the character the page's instant works against (the check's OBSTACLES line);
 *   - a character this cut would leave under the coverage floor;
 *   - the main character where the cut would leave them in frame on fewer than
 *     half the pages, and the central figure where it would leave a third of
 *     the book without it;
 *   - any name on a page that is one of that character's focal pages;
 *   - the highest-scored name when every name scored below 0.5 (a cut never
 *     empties a page).
 * Then trims the lowest-P non-required names until ≤ GROUP_STAGING_MAX remain.
 * A page whose REQUIRED names alone exceed it keeps its group, reported — no loop.
 *
 * @param {Object} input
 * @param {string} input.arc
 * @param {Array<{pageNumber:number, planLine:string}>} input.pages   the division that stands
 * @param {Map<number,string[]>} input.present                        per page, who is in frame
 * @param {number[]} input.groupPages
 * @param {number} input.budget
 * @param {Map<number,string[]>} [input.obstacles]
 * @param {Object<string,number[]>} [input.focalPages]
 * @param {string[]} [input.listed]      the character list (coverage floor applies)
 * @param {number} [input.floor]         castCoverage().appearances.min
 * @param {string|null} [input.mainName]
 * @param {string[]|null} [input.centralFigure]
 * @param {number[]|null} [input.centralPages]
 * @param {Object|null} [input.castTable] the planner's CAST block (castCoverage.parsePlanCastBlock):
 *   a character it promises on a page — deed page, `also on`, the ending's cast —
 *   is never cut from that page (the promise is the plan's structured fact).
 * @param {Function} [input.sameName]    (a, b) → true when two strings name one character
 */
async function decideGroupCuts(input, opts = {}) {
  const { arc, pages, present, groupPages = [], budget } = input;
  const sameName = input.sameName || ((a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase());
  const stats = newStats();
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const gp = groupPages.map(Number).filter(n => byNum.has(n));
  if (!(budget >= 0)) throw new JevDecisionError('decideGroupCuts: no budget');
  const togetherReqs = gp.flatMap(n => repeat({ key: `together:p${n}`, state: pageState(arc, pages, byNum.get(n)), questions: { TOGETHER: { type: 'noul', instructions: TOGETHER_Q } } }, JEV_DECISIONS.together.reps));
  const tog = await runJevRequests(togetherReqs, { ...opts, usageLabel: 'jev_decisions_cast', stats });
  const ranked = gp.map(n => ({ pageNumber: n, together: meanNoul(tog.get(`together:p${n}`), 'TOGETHER') }))
    .sort((a, b) => b.together - a.together || a.pageNumber - b.pageNumber);
  const keepGroup = new Set(ranked.slice(0, budget).map(r => r.pageNumber));
  const reduce = ranked.filter(r => !keepGroup.has(r.pageNumber)).map(r => r.pageNumber).sort((a, b) => a - b);

  const neededReqs = reduce.flatMap(n => (present.get(n) || []).flatMap((name, i) =>
    repeat({ key: `needed:p${n}:${i}`, state: pageState(arc, pages, byNum.get(n)), questions: { NEEDED: { type: 'noul', instructions: NEEDED_DEF(name) } } }, JEV_DECISIONS.needed.reps)));
  const need = neededReqs.length ? await runJevRequests(neededReqs, { ...opts, usageLabel: 'jev_decisions_cast', stats }) : new Map();

  // Running tallies the constraints read; each cut updates them.
  const inFrame = new Map(); // name → Set(page)
  for (const [n, names] of present) for (const name of names) {
    if (!inFrame.has(name)) inFrame.set(name, new Set());
    inFrame.get(name).add(Number(n));
  }
  const pageCount = pages.length;
  const listed = input.listed || [];
  const floor = Number(input.floor) || 0;
  const isListed = name => listed.some(l => sameName(l, name));
  const isMain = name => input.mainName && sameName(input.mainName, name);
  const central = (input.centralFigure || []).filter(Boolean);
  const isCentral = name => central.some(c => sameName(c, name));
  const thirds = (() => { const a = Math.round(pageCount / 3), b = Math.round(2 * pageCount / 3); return [[1, a], [a + 1, b], [b + 1, pageCount]]; })();
  const thirdOf = n => thirds.find(([lo, hi]) => n >= lo && n <= hi);

  // THE CAST TABLE'S PROMISES ARE KEPT (2026-09-27, Lab 1577): a cut that
  // took a promised character off a page broke CAST_PROMISE_BROKEN on the
  // recheck. Structured, from the table the planner wrote before its lines.
  const promisedOn = (n) => {
    const t = input.castTable;
    if (!t) return [];
    const out = [];
    for (const c of t.characters || []) if (Number(c.deedPage) === n || (c.alsoOn || []).map(Number).includes(n)) out.push(c.name);
    if (t.ending && Number(t.ending.page) === n) out.push(...(t.ending.names || []));
    return out;
  };
  const decisions = [];
  for (const r of ranked) {
    if (keepGroup.has(r.pageNumber)) decisions.push({ pageNumber: r.pageNumber, together: +r.together.toFixed(3), keepsGroup: true, cast: present.get(r.pageNumber) || [] });
  }
  for (const n of reduce) {
    const names = present.get(n) || [];
    const scores = Object.fromEntries(names.map((name, i) => [name, +meanNoul(need.get(`needed:p${n}:${i}`), 'NEEDED').toFixed(3)]));
    const required = {};
    for (const name of names) {
      const why = [];
      if ((input.obstacles?.get(n) || []).some(o => sameName(o, name))) why.push('the instant works against them');
      if (promisedOn(n).some(p => sameName(p, name))) why.push('the CAST block promises them on this page');
      const pagesIn = inFrame.get(name) || new Set();
      if (isListed(name) && floor > 0 && pagesIn.size - 1 < floor) why.push(`would fall below ${floor} page(s) in frame`);
      if (isMain(name) && (pagesIn.size - 1) * 2 < pageCount) why.push('the main character would be in frame on fewer than half the pages');
      if (isCentral(name) && Array.isArray(input.centralPages)) {
        const [lo, hi] = thirdOf(n) || [n, n];
        const others = input.centralPages.map(Number).filter(p => p !== n && p >= lo && p <= hi);
        if (others.length === 0) why.push('the central figure\'s only page in this third');
      }
      const focal = Object.entries(input.focalPages || {}).find(([k]) => sameName(k, name));
      if (focal && (focal[1] || []).map(Number).includes(n)) why.push('one of their focal pages');
      if (why.length) required[name] = why.join('; ');
    }
    // A cut never empties a page: the instant was staged with people, and a
    // people-free page is its own decision (NO_PEOPLELESS_PAGE), never a
    // by-product of this one. The highest-P name stays.
    if (names.length && !names.some(name => scores[name] >= JEV_DECISIONS.needed.cutBelow || required[name])) {
      const top = [...names].sort((a, b) => scores[b] - scores[a])[0];
      required[top] = 'a cut never empties a page — the highest-scored name stays';
    }
    let keep = names.filter(name => scores[name] >= JEV_DECISIONS.needed.cutBelow || required[name]);
    // Trim to the staging maximum: lowest P first, never a required name.
    while (keep.length > SV.GROUP_STAGING_MAX) {
      const drop = keep.filter(k => !required[k]).sort((a, b) => scores[a] - scores[b])[0];
      if (!drop) break;
      keep = keep.filter(k => k !== drop);
    }
    const row = { pageNumber: n, together: +(ranked.find(x => x.pageNumber === n).together).toFixed(3), keepsGroup: false, cast: names, scores, required };
    if (keep.length > SV.GROUP_STAGING_MAX) {
      row.unsatisfiable = `${keep.length} names are required on this page (${Object.entries(required).map(([k, v]) => `${k}: ${v}`).join('; ')}) — it keeps its group`;
      log.error(`❌ [JEV/cast] page ${n}: ${row.unsatisfiable}`);
      decisions.push(row);
      continue;
    }
    row.keep = keep;
    row.remove = names.filter(name => !keep.includes(name));
    for (const name of row.remove) inFrame.get(name)?.delete(n);
    decisions.push(row);
  }
  decisions.sort((a, b) => a.pageNumber - b.pageNumber);
  const cuts = decisions.filter(d => d.remove && d.remove.length);
  log.info(`👥 [JEV/cast] ${gp.length} group page(s), budget ${budget}: keep ${[...keepGroup].sort((a, b) => a - b).join(', ') || 'none'}; ${cuts.map(d => `p${d.pageNumber} −${d.remove.join(', ')}`).join('; ') || 'no cut'} (${stats.calls} calls)`);
  return { budget, groupPages: gp, keepGroup: [...keepGroup].sort((a, b) => a - b), decisions, stats: summarise(stats) };
}

/** One must-fix instruction per cut page, in the re-plan's finding shape. */
function castCutFindings(cutDecision) {
  return (cutDecision?.decisions || []).filter(d => d.remove && d.remove.length).map(d => ({
    kind: 'counter',
    code: 'GROUP_PAGES_OVER_BUDGET',
    pages: [d.pageNumber],
    castCut: { keep: d.keep, remove: d.remove },
    line: `PLAN[GROUP_PAGES_OVER_BUDGET] page ${d.pageNumber}: CAST CUT — this page keeps ${whoText(d.keep) || 'nobody'} in frame and casts out ${whoText(d.remove)}; code writes its who column as "${whoText(d.keep)}". Rewrite only this page's instant and what is true after, for ${whoText(d.keep) || 'the page with no one in frame'}: name no one it casts out, alone, as part of a group or by a count. ${CUT_STILL_IN_STORY}`,
  }));
}

// ───────────────────────── LIGHT (TIME / INDOOR / WEATHER) ─────────────────────────
// Wording verbatim from eval-jev-decision-layer.js (meta items).

function lightQuestions() {
  return {
    TIME: { type: 'choice', instructions: 'The time of day in the picture of the page to judge, following the story\'s clock: it holds from page to page until the story moves it.', criteria: Object.fromEntries(TIMES_OF_DAY.map(t => [t, t])) },
    WEATHER: { type: 'choice', instructions: 'The weather visible in the picture of the page to judge. `none` when the scene is indoors, where the sky is not seen. Weather holds from page to page until the story changes it.', criteria: { clear: 'clear sky', overcast: 'overcast, grey clouds', rain: 'rain', snow: 'snow', fog: 'fog or mist', storm: 'storm, strong wind', none: 'none: the scene is indoors' } },
    INDOOR: { type: 'noul', instructions: 'The picture of the page to judge is set indoors: inside a building, a room, a cave or an enclosed vehicle.' },
  };
}

/** Hours at the day's end: after them, an earlier hour is the next day. */
const DAY_END = new Set(['evening', 'dusk', 'night']);
const DAY_START = new Set(['dawn', 'morning', 'midday']);

/**
 * THE CLOCK NEVER RUNS BACKWARDS. Page by page, an hour earlier than the one
 * before is a new day only when the page before ended the day (evening, dusk,
 * night) and this one starts one (dawn, morning, midday); any other earlier
 * hour holds the previous page's hour. Pure; returns the corrected list and
 * what it held.
 */
function forwardClock(times) {
  const idx = t => TIMES_OF_DAY.indexOf(t);
  const out = []; const held = [];
  for (let i = 0; i < times.length; i++) {
    const cur = times[i];
    const prev = out[i - 1];
    if (i > 0 && idx(cur) < idx(prev) && !(DAY_END.has(prev) && DAY_START.has(cur))) {
      out.push(prev); held.push({ index: i, jev: cur, held: prev });
    } else out.push(cur);
  }
  return { times: out, held };
}

/**
 * Per page: timeOfDay (enum, clock forward), indoor, and Jev's weather as an
 * ADVICE the Art Director's own `weather` is compared against (logged).
 */
async function decideLight({ arc, pages }, opts = {}) {
  const stats = newStats();
  const reqs = pages.flatMap(p => repeat({ key: `light:p${p.pageNumber}`, state: pageState(arc, pages, p), questions: lightQuestions() }, JEV_DECISIONS.light.reps));
  const ans = await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_light', stats });
  const raw = pages.map(p => {
    const a = ans.get(`light:p${p.pageNumber}`);
    const time = modalChoice(a, 'TIME');
    const weather = modalChoice(a, 'WEATHER');
    if (!TIMES_OF_DAY.includes(time)) throw new JevDecisionError(`Jev TIME answer "${time}" is outside ${TIMES_OF_DAY.join('|')}`);
    if (!WEATHERS.includes(weather)) throw new JevDecisionError(`Jev WEATHER answer "${weather}" is outside ${WEATHERS.join('|')}`);
    const indoorP = meanNoul(a, 'INDOOR');
    return { pageNumber: Number(p.pageNumber), jevTime: time, weatherAdvice: weather, indoorP: +indoorP.toFixed(3), indoor: indoorP >= JEV_DECISIONS.light.indoorAt };
  });
  const clock = forwardClock(raw.map(r => r.jevTime));
  raw.forEach((r, i) => { r.timeOfDay = clock.times[i]; });
  for (const h of clock.held) log.warn(`🌗 [JEV/light] page ${raw[h.index].pageNumber}: Jev said ${h.jev} after ${h.held} — the clock never runs backwards, held at ${h.held}`);
  log.info(`🌗 [JEV/light] ${raw.map(r => `p${r.pageNumber}:${r.timeOfDay}${r.indoor ? '/in' : ''}`).join(' ')} (${stats.calls} calls)`);
  return { pages: raw, clockHeld: clock.held.map(h => ({ pageNumber: raw[h.index].pageNumber, jev: h.jev, held: h.held })), stats: summarise(stats) };
}

// ───────────────────────── VB CITATIONS, ABOARD, POPULATION ─────────────────────────

const baseId = id => String(id || '').trim().toUpperCase().split('.')[0];

/** The Visual Bible elements Jev decides, as the eval listed them. Clothing and locations are not among them. */
function vbElements(visualBible, commissionedNames = []) {
  const out = [];
  const comm = new Set(commissionedNames.map(n => String(n || '').trim().toLowerCase()));
  const add = (type, list) => {
    for (const e of (Array.isArray(list) ? list : Object.values(list || {}))) {
      if (!e || !e.id || e.generic === true) continue;
      if (type === 'secondary' && comm.has(String(e.name || '').trim().toLowerCase())) continue;
      const desc = String(e.description || [e.species, e.coloring, e.features].filter(Boolean).join(', ') || '').replace(/\s+/g, ' ').slice(0, 220);
      out.push({ type, id: baseId(e.id), name: e.name || e.label || e.id, label: e.label || '', species: e.species || '', desc, entry: e });
    }
  };
  add('creature', visualBible?.animals);
  add('secondary', visualBible?.secondaryCharacters);
  add('object', visualBible?.artifacts);
  add('vehicle', visualBible?.vehicles);
  return out;
}

function vbQuestion(e) {
  const what = e.type === 'creature' || e.type === 'secondary'
    ? `${e.name}${e.species ? `, the ${e.species}` : ''} (${e.desc.slice(0, 140)})`
    : `the ${e.label || e.name} (${e.desc.slice(0, 140)})`;
  return `${what} is in the picture of the page to judge, wholly or in part: the page's text or its picture plan puts it in the scene at that moment.`;
}

function aboardQuestion(v) {
  const name = v.entry.properName || v.label || v.name || v.id;
  const desc = String(v.entry.description || '').slice(0, 200);
  return `The camera of the picture of the page to judge stands on or inside ${name} (${desc.slice(0, 120)}): its deck, floor or interior is the ground the picture is taken from.`;
}

/**
 * The dotted state id an element with `states[]` is cited by on a page: the
 * state whose `pages` include it, else the latest state begun before it, else
 * the first (the pages before an object's first change are its first state).
 */
function stateIdFor(entry, pageNumber) {
  const states = Array.isArray(entry?.states) ? entry.states.filter(Boolean) : [];
  if (!states.length) return { id: baseId(entry.id), addPage: false };
  const n = Number(pageNumber);
  const pagesOf = s => (Array.isArray(s.pages) ? s.pages : []).map(Number);
  const idOf = (s, i) => (s.id && String(s.id).includes('.') ? String(s.id).toUpperCase() : `${baseId(entry.id)}.${i + 1}`);
  const hit = states.findIndex(s => pagesOf(s).includes(n));
  if (hit >= 0) return { id: idOf(states[hit], hit), addPage: false, stateIndex: hit };
  let best = 0; let bestStart = -Infinity;
  states.forEach((s, i) => { const lo = Math.min(...pagesOf(s)); if (Number.isFinite(lo) && lo <= n && lo > bestStart) { best = i; bestStart = lo; } });
  return { id: idOf(states[best], best), addPage: true, stateIndex: best };
}

/**
 * Per page, which Visual Bible elements are in the picture, and whether the
 * camera is aboard a vehicle. One call per page (all elements + all vehicles'
 * aboard nouls in it).
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>, visualBible:Object,
 *          commissionedNames:string[], adCited:Map<number,Set<string>>}} input
 *   `adCited` — the base ids each page's brief cited (the 0.5–0.7 object band).
 */
async function decideVbAndAboard({ arc, pages, visualBible, commissionedNames = [], adCited = new Map() }, opts = {}) {
  const { VB_ELEMENT_BUDGET } = require('./vbElementBudget');
  const els = vbElements(visualBible, commissionedNames);
  const vehicles = els.filter(e => e.type === 'vehicle');
  const stats = newStats();
  if (!els.length) return { pages: pages.map(p => ({ pageNumber: Number(p.pageNumber), elements: [], aboard: null, scores: {} })), stats: summarise(stats) };
  const reqs = pages.flatMap(p => {
    const qs = {};
    els.forEach((e, i) => { qs[`E${i}`] = { type: 'noul', instructions: vbQuestion(e) }; });
    vehicles.forEach((v, i) => { qs[`ABOARD${i}`] = { type: 'noul', instructions: aboardQuestion(v) }; });
    return repeat({ key: `vb:p${p.pageNumber}`, state: pageState(arc, pages, p), questions: qs }, JEV_DECISIONS.vb.reps);
  });
  const ans = await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_vb', stats });
  const T = JEV_DECISIONS.vb;
  const out = pages.map(p => {
    const n = Number(p.pageNumber);
    const a = ans.get(`vb:p${n}`);
    const cited = adCited.get(n) || new Set();
    const scored = els.map((e, i) => ({ e, p: meanNoul(a, `E${i}`) }));
    const inPicture = scored.filter(({ e, p: P }) => {
      if (e.type === 'object') return P >= T.object || (P >= T.objectBand && cited.has(e.id));
      return P >= T[e.type];
    }).sort((x, y) => y.p - x.p);
    const overBudget = inPicture.slice(VB_ELEMENT_BUDGET).map(x => x.e.id);
    const kept = inPicture.slice(0, VB_ELEMENT_BUDGET);
    const elements = kept.map(({ e, p: P }) => { const st = stateIdFor(e.entry, n); return { id: e.id, cite: st.id, addStatePage: st.addPage, stateIndex: st.stateIndex, type: e.type, p: +P.toFixed(3) }; });
    const aboardScores = vehicles.map((v, i) => ({ id: v.id, p: meanNoul(a, `ABOARD${i}`) })).sort((x, y) => y.p - x.p);
    const aboard = aboardScores.length && aboardScores[0].p >= JEV_DECISIONS.aboard.at ? aboardScores[0].id : null;
    return {
      pageNumber: n, elements, overBudget, aboard,
      scores: Object.fromEntries(scored.map(({ e, p: P }) => [e.id, +P.toFixed(3)])),
      aboardScores: Object.fromEntries(aboardScores.map(x => [x.id, +x.p.toFixed(3)])),
    };
  });
  for (const r of out) if (r.overBudget.length) log.warn(`🧱 [JEV/vb] page ${r.pageNumber}: ${r.elements.length + r.overBudget.length} elements in the picture, budget ${VB_ELEMENT_BUDGET} — left out (lowest P): ${r.overBudget.join(', ')}`);
  log.info(`🧩 [JEV/vb] ${out.map(r => `p${r.pageNumber}:[${r.elements.map(e => e.cite).join(',')}]${r.aboard ? `@${r.aboard}` : ''}`).join(' ')} (${stats.calls} calls)`);
  return { pages: out, stats: summarise(stats) };
}

const POP_PUBLIC_Q = 'This place is one the public can walk into: a street, a square, a park, a bridge, a station, a shop, a museum hall.';
const POP_CROWD_Q = 'The story sets this place around a crowd: a market, a fair, a parade, a packed hall — many people are part of the scene.';

/**
 * Population is a property of the PLACE (per page it was ❌). Per location the
 * pages set there: PUBLIC and CROWD nouls → crowd ≥ 0.5 → `crowd`, else
 * public ≥ 0.5 → `ambient`, else `cast_only`.
 *
 * @param {{arc:string, pages:Array, visualBible:Object, locOf:Map<number,string>}} input
 *   `locOf` — page → the base LOC id its brief cites.
 */
async function decidePopulation({ arc, pages, visualBible, locOf }, opts = {}) {
  const stats = newStats();
  const locs = (visualBible?.locations || []).filter(l => l && l.id);
  const pagesAt = new Map();
  for (const [n, id] of locOf) { if (!pagesAt.has(id)) pagesAt.set(id, []); pagesAt.get(id).push(n); }
  const reqs = [];
  for (const [id, nums] of pagesAt) {
    const l = locs.find(x => baseId(x.id) === id);
    if (!l) continue;
    const planLines = pages.filter(p => nums.includes(Number(p.pageNumber))).map(p => `Page ${p.pageNumber}: ${stripPlanShot(p.planLine)}`);
    const desc = String(l.description || '').slice(0, 240);
    const st = `A PLACE IN A CHILDREN'S PICTURE BOOK: ${l.name}${l.setting ? ` (${l.setting})` : ''} — ${desc}\n\nTHE STORY, beat by beat:\n${String(arc || '').trim()}\n\nTHE PAGES SET THERE (who is in frame — the instant — what is true after):\n${planLines.join('\n')}`;
    reqs.push(...repeat({ key: `pop:${id}`, state: st, questions: { PUBLIC: { type: 'noul', instructions: POP_PUBLIC_Q }, CROWD: { type: 'noul', instructions: POP_CROWD_Q } } }, JEV_DECISIONS.population.reps));
  }
  const ans = reqs.length ? await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_population', stats }) : new Map();
  const byLoc = {};
  for (const [id] of pagesAt) {
    const a = ans.get(`pop:${id}`);
    if (!a) continue;
    const pub = meanNoul(a, 'PUBLIC'); const crowd = meanNoul(a, 'CROWD');
    const P = JEV_DECISIONS.population;
    byLoc[id] = { population: crowd >= P.crowdAt ? 'crowd' : pub >= P.publicAt ? 'ambient' : 'cast_only', publicP: +pub.toFixed(3), crowdP: +crowd.toFixed(3), pages: pagesAt.get(id).sort((x, y) => x - y) };
  }
  log.info(`🏙️ [JEV/population] ${Object.entries(byLoc).map(([id, v]) => `${id}:${v.population}`).join(' ') || 'no located page'} (${stats.calls} calls)`);
  return { byLocation: byLoc, stats: summarise(stats) };
}

// ───────────────────────── GAZE (looksAt) ─────────────────────────
// Wording and candidate builder verbatim from scripts/analysis/eval-jev-extra-fields.js
// (G2, "Gaze, depth, story relevance asked as fit", e3c329da1).

const GAZE_AWAY = 'away';
const GAZE_AWAY_LABEL = 'nothing in the picture: away, into the distance, or at nothing in particular';
const GAZE_AWAY_OPTION = 'nothing in the picture: away, into the distance';

/**
 * The page's gaze targets as the eval indexed the Visual Bible: kind + name +
 * short description per id, a vantage id carrying its vantage name.
 */
function gazeIndex(visualBible) {
  const out = {};
  const kinds = { animals: 'creature', secondaryCharacters: 'figure', artifacts: 'thing', genericObjects: 'thing', vehicles: 'vehicle', locations: 'place', clothing: 'thing' };
  for (const [k, kind] of Object.entries(kinds)) {
    for (const e of (Array.isArray(visualBible?.[k]) ? visualBible[k] : Object.values(visualBible?.[k] || {}))) {
      if (!e?.id) continue;
      const name = e.properName || e.name || e.label || e.id;
      const desc = String(e.description || [e.species, e.coloring, e.features, e.setting].filter(Boolean).join(', ')).replace(/\s+/g, ' ').slice(0, 160);
      out[e.id] = { id: e.id, kind, name, desc };
      for (const v of e.vantages || []) if (v && v.id) out[v.id] = { id: e.id, kind, name, desc, vantage: v.name };
    }
  }
  return out;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namedIn = (name, text) => new RegExp(`(^|[^\\p{L}])${esc(name)}($|[^\\p{L}])`, 'iu').test(text);

/**
 * The page's gaze candidates' raw material (the eval's extract): the elements
 * the page cites — objects[] and the interaction rows' objects, clothing
 * excluded as in the eval EXCEPT a garment an interaction row acts on (build
 * note) — and the creatures / figures the plan line names that the page does
 * not cite.
 */
function gazePageMaterial({ objects = [], interactions = [], planLine = '', index }) {
  const clothingActedOn = interactions.map(x => x && x.object).filter(o => o && /^CLO/i.test(String(o)));
  const cited = [...new Set([...objects, ...interactions.map(x => x && x.object)].filter(o => o && !/^CLO/i.test(String(o))).map(baseId))];
  const elements = [...cited, ...new Set(clothingActedOn.map(baseId))].map(id => (index[id] ? { id, kind: index[id].kind, name: index[id].name, desc: index[id].desc } : null)).filter(Boolean);
  const named = Object.values(index).filter(e => (e.kind === 'creature' || e.kind === 'figure') && !e.vantage && !cited.includes(e.id)
    && namedIn(e.name, stripPlanShot(planLine))).map(e => ({ id: e.id, kind: e.kind, name: e.name, desc: e.desc }));
  return { elements, named };
}

/** Gaze candidates, enumerated in code: { target, label } (target = a name, an element id, or 'away'). */
function gazeCandidates({ roster, elements, named }, name) {
  const out = [];
  roster.filter(o => o !== name).forEach(o => out.push({ target: o, label: o }));
  const rosterSet = new Set(roster);
  // Never the figure itself: an Art Director roster entry can be a secondary
  // character's id (smoke story job_1790529840433_ar4u7qry3 p3: "CHR001" was
  // offered CHR001 and looked at itself).
  const self = String(name || '').trim().toUpperCase();
  [...elements, ...(named || [])].filter(e => !rosterSet.has(e.name) && baseId(e.id) !== baseId(self) && String(e.name || '').trim().toUpperCase() !== self)
    .forEach(e => out.push({ target: e.id, label: e.kind === 'place' ? `the place itself: ${e.name}` : `${e.name} (${e.desc.slice(0, 80)})` }));
  out.push({ target: GAZE_AWAY, label: GAZE_AWAY_LABEL });
  return out;
}

/**
 * Per page, what each character's eyes and hands are on: one choice per
 * character over the code-listed candidates, one call per page carrying every
 * character, 3 calls with the choice probabilities averaged (owner). Code
 * writes the top candidate into `looksAt`.
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>,
 *          perPage:Array<{pageNumber:number, roster:string[], elements:Array, named:Array}>}} input
 */
async function decideGaze({ arc, pages, perPage }, opts = {}) {
  const stats = newStats();
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const plans = perPage.filter(p => p.roster && p.roster.length && byNum.has(Number(p.pageNumber))).map(p => ({
    ...p, cands: p.roster.map(n => gazeCandidates(p, n)),
  }));
  const reqs = plans.flatMap(p => {
    const qs = {};
    p.roster.forEach((n, i) => {
      qs[`EYES${i}`] = { type: 'choice', instructions: `In the instant of the page to judge, what are ${n}'s eyes and hands on?`,
        criteria: Object.fromEntries(p.cands[i].map((k, j) => [`t${j}`, k.target === GAZE_AWAY ? GAZE_AWAY_OPTION : k.label])) };
    });
    return repeat({ key: `gaze:p${p.pageNumber}`, state: pageState(arc, pages, byNum.get(Number(p.pageNumber))), questions: qs }, JEV_DECISIONS.gaze.reps);
  });
  const ans = reqs.length ? await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_gaze', stats }) : new Map();
  const out = plans.map(p => {
    const a = ans.get(`gaze:p${p.pageNumber}`) || [];
    const characters = p.roster.map((n, i) => {
      const cand = p.cands[i];
      const probs = cand.map((k, j) => mean(a.map(x => {
        const q = x[`EYES${i}`];
        if (!q || !q.probabilities) throw new JevDecisionError(`Jev gaze answer EYES${i} on page ${p.pageNumber} carries no probabilities`);
        return Number(q.probabilities[`t${j}`] || 0);
      })));
      const top = probs.indexOf(Math.max(...probs));
      return { name: n, looksAt: cand[top].target, p: +probs[top].toFixed(3),
        candidates: Object.fromEntries(cand.map((k, j) => [k.target, +probs[j].toFixed(3)])) };
    });
    return { pageNumber: Number(p.pageNumber), characters };
  });
  log.info(`👀 [JEV/gaze] ${out.map(r => `p${r.pageNumber}:${r.characters.map(c => `${c.name}→${c.looksAt}`).join(',')}`).join(' ')} (${stats.calls} calls)`);
  return { pages: out, stats: summarise(stats) };
}

// ───────────────────────── the FIXED fields in the brief ─────────────────────────

/**
 * The fields the decision layer owns, stated once to every brief author and to
 * the scene review (generator ↔ critic from one constant). `timeOfDay` and
 * indoors reach the Art Director as the page's FIXED line; the cited elements,
 * `population`, `aboard` and `looksAt` are written by code after the Art
 * Director and handed to the review as `jev_fixed_field` lines.
 */
const JEV_FIXED_FIELDS_RULE = 'Fields decided upstream are FIXED: a page whose plan carries a FIXED line takes its `timeOfDay` from it exactly, and its `weather` is `none` when the line says indoors and never `none` when it says outdoors. After the briefs are written, code sets each story page\'s cited Visual Bible elements in `objects[]` (locations excepted), its `population`, its `aboard` and every character\'s `looksAt`; the prose renders those values and no rewrite changes them.';

/**
 * The rule as a brief author / the review is given it. On the Jev-outage
 * backup nothing is decided upstream; the one thing left to say is who picks a
 * shot the plan still carries as the placeholder (a story that fell back after
 * its plan was written).
 */
const JEV_BACKUP_SHOT_RULE = `A plan line whose first field is still the word ${SV.PLAN_SHOT_PLACEHOLDER} leaves that page's camera shot to you.`;
function fixedFieldsRule(jevBackup = false) { return jevBackup ? JEV_BACKUP_SHOT_RULE : JEV_FIXED_FIELDS_RULE; }

/** The FIXED line under a page's PLAN line in the Art Director's plan block. */
function fixedLine(fixed) {
  if (!fixed || !fixed.timeOfDay) return '';
  return `FIXED: timeOfDay ${fixed.timeOfDay}; ${fixed.indoor ? 'indoors (weather none)' : 'outdoors'}`;
}

/**
 * Write the decided fields into one brief's metadata. Pure: returns the new
 * brief and what changed. `fixed`:
 *   timeOfDay, indoor              — the light (weather: `none` indoors; an
 *                                    outdoor `none` is reported, never guessed)
 *   cites, decidedIds              — the element citations Jev decided and the
 *                                    base ids it was asked about: any decided id
 *                                    not in `cites` leaves objects[]; everything
 *                                    else (locations, undecided ids) stays
 *   population                     — the page's location's value
 *   aboard, aboardIds              — the vehicle the camera is on (or null); an
 *                                    `aboard` outside `aboardIds` (a structure) stays
 *   looksAt                        — { characterName: target }
 */
function pinBrief(brief, fixed) {
  const { parseProseMetadataFormat } = require('./sceneMetadata');
  const parsed = parseProseMetadataFormat(String(brief || ''));
  if (!parsed) return { brief, changes: [], unparsed: true };
  const m = { ...parsed.metadata };
  const changes = [];
  const set = (field, to, extra = {}) => {
    const from = m[field] === undefined ? null : m[field];
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    if (to === null) delete m[field]; else m[field] = to;
    changes.push({ field, from, to, ...extra });
  };
  if (fixed.timeOfDay) set('timeOfDay', fixed.timeOfDay);
  if (fixed.indoor === true) set('weather', 'none');
  else if (fixed.indoor === false && (!m.weather || m.weather === 'none')) changes.push({ field: 'weather', from: m.weather || null, to: null, problem: 'outdoors' });
  if (Array.isArray(fixed.cites)) {
    const decided = new Set((fixed.decidedIds || []).map(baseId));
    const before = Array.isArray(m.objects) ? m.objects.map(String) : [];
    const kept = before.filter(o => !decided.has(baseId(o)));
    const next = [...kept, ...fixed.cites.filter(c => !kept.some(k => baseId(k) === baseId(c)))];
    const added = fixed.cites.filter(c => !before.includes(c));
    const removed = before.filter(o => decided.has(baseId(o)) && !fixed.cites.includes(o));
    if (added.length || removed.length) { m.objects = next; changes.push({ field: 'objects', from: before, to: next, added, removed }); }
  }
  if (fixed.population) set('population', fixed.population);
  if (fixed.aboard !== undefined) {
    const own = new Set((fixed.aboardIds || []).map(baseId));
    const cur = m.aboard ? String(m.aboard) : null;
    if (fixed.aboard) set('aboard', fixed.aboard);
    else if (cur && own.has(baseId(cur))) set('aboard', null);
  }
  if (fixed.looksAt && Array.isArray(m.characters)) {
    m.characters = m.characters.map((c) => {
      if (!c || typeof c !== 'object' || !(c.name in fixed.looksAt)) return c;
      const to = fixed.looksAt[c.name];
      if (c.looksAt === to) return c;
      changes.push({ field: 'looksAt', name: c.name, from: c.looksAt ?? null, to });
      return { ...c, looksAt: to };
    });
  }
  if (!changes.some(c => !c.problem)) return { brief, changes };
  return { brief: `${parsed.prose}\n\n---METADATA---\n${JSON.stringify(m, null, 2)}`, changes };
}

/**
 * The review line for a page whose fixed fields differ from what its brief
 * was written with: what code set, so the prose can follow. Null when nothing
 * the prose must follow changed.
 */
function fixedFieldFinding(pageNumber, changes, labelOf = id => id) {
  const parts = [];
  for (const c of changes) {
    if (c.field === 'objects') {
      if (c.added.length) parts.push(`objects[] now cites ${c.added.map(id => `${id} (${labelOf(id)})`).join(', ')} — stage ${c.added.length > 1 ? 'them' : 'it'} in the prose, even where only part is in frame`);
      if (c.removed.length) parts.push(`objects[] no longer cites ${c.removed.map(id => `${id} (${labelOf(id)})`).join(', ')} — take ${c.removed.length > 1 ? 'them' : 'it'} out of the prose`);
    } else if (c.field === 'timeOfDay') parts.push(`timeOfDay is ${c.to} — the prose's light is that hour's`);
    else if (c.field === 'weather' && c.problem === 'outdoors') parts.push('the page is outdoors — `weather` is one of the outdoor values, never `none`; choose the story\'s sky and write it into the prose');
    else if (c.field === 'weather') parts.push('the page is indoors — `weather` is `none` and the prose shows no sky weather except through a window');
    else if (c.field === 'population') parts.push(`population is ${c.to} — ${c.to === 'cast_only' ? 'no one but the listed figures is in the prose' : c.to === 'crowd' ? 'the prose is written around unnamed background people' : 'the prose shows a few distant, unnamed passers-by'}`);
    else if (c.field === 'aboard') parts.push(c.to ? `the camera is aboard ${c.to} (${labelOf(c.to)}) — its deck, floor or interior is the ground the picture is taken from (rule 11d)` : `the camera is not aboard ${c.from} — it is seen from outside`);
    else if (c.field === 'looksAt') parts.push(`${c.name} looks at ${c.to === GAZE_AWAY ? 'nothing in particular (away)' : `${c.to}${c.to !== labelOf(c.to) ? ` (${labelOf(c.to)})` : ''}`}`);
  }
  if (!parts.length) return null;
  return { pageNumber, type: 'jev_fixed_field', detail: `Code set this page's fixed fields; rewrite the prose to render them and leave the fields as they are: ${parts.join('; ')}.` };
}

/**
 * The Visual Bible's page table for the elements Jev decided, made to agree
 * with the briefs' citations (story pages only; a cover's negative page stays),
 * and each state's pages made to agree with the pages cited IN that state.
 *
 * The parsed bible keeps an element's pages in `appearsInPages` (the parser
 * renames the authored `pages`; syncVisualBibleSection projects it back) —
 * writing `pages` changed nothing any reader saw (smoke story
 * job_1790529840433_ar4u7qry3: the review was sent vb_page_uncited for a state
 * Jev had already dropped, and the transcript sync reported no change).
 */
function applyVbPages(visualBible, citesByPage, decidedIds) {
  const decided = new Set(decidedIds.map(baseId));
  const cols = ['animals', 'secondaryCharacters', 'artifacts', 'vehicles'];
  let changed = 0;
  for (const k of cols) {
    for (const e of (Array.isArray(visualBible?.[k]) ? visualBible[k] : [])) {
      if (!e || !decided.has(baseId(e.id))) continue;
      const own = [...citesByPage.entries()].filter(([, cs]) => cs.some(c => baseId(c) === baseId(e.id))).map(([n]) => n).sort((a, b) => a - b);
      const field = Array.isArray(e.appearsInPages) || !Array.isArray(e.pages) ? 'appearsInPages' : 'pages';
      const before = Array.isArray(e[field]) ? e[field].map(Number) : [];
      const next = [...before.filter(n => n <= 0), ...own];
      if (JSON.stringify(next) !== JSON.stringify(before)) { e[field] = next; changed++; }
      if (Array.isArray(e.states)) {
        e.states.forEach((st, i) => {
          if (!st) return;
          const stateId = st.id && String(st.id).includes('.') ? String(st.id).toUpperCase() : `${baseId(e.id)}.${i + 1}`;
          const stOwn = [...citesByPage.entries()].filter(([, cs]) => cs.some(c => String(c).toUpperCase() === stateId)).map(([n]) => n).sort((a, b) => a - b);
          const stBefore = Array.isArray(st.pages) ? st.pages.map(Number) : [];
          const stNext = [...stBefore.filter(n => n <= 0), ...stOwn];
          if (JSON.stringify(stNext) !== JSON.stringify(stBefore)) { st.pages = stNext; changed++; }
        });
      }
    }
  }
  return changed;
}

module.exports = {
  JevDecisionError,
  JEV_OUTAGE,
  probeJev,
  JEV_FIXED_FIELDS_RULE,
  JEV_BACKUP_SHOT_RULE,
  fixedFieldsRule,
  fixedLine,
  pinBrief,
  fixedFieldFinding,
  applyVbPages,
  gazeIndex,
  gazePageMaterial,
  gazeCandidates,
  decideGaze,
  GAZE_AWAY,
  JEV_DECISIONS,
  JEV_DECISION_CONCURRENCY,
  PLAN_SHOT_PLACEHOLDER,
  PLAN_HEAD,
  TOGETHER_Q,
  CUT_STILL_IN_STORY,
  NEEDED_DEF,
  POP_PUBLIC_Q,
  POP_CROWD_Q,
  stripPlanShot,
  planParts,
  withShot,
  withWho,
  whoText,
  pageState,
  runJevRequests,
  shotFitQuestions,
  hungarian,
  budgetOf,
  violations,
  assign,
  decideShots,
  applyShots,
  decideGroupCuts,
  castCutFindings,
  lightQuestions,
  forwardClock,
  decideLight,
  vbElements,
  vbQuestion,
  aboardQuestion,
  stateIdFor,
  decideVbAndAboard,
  decidePopulation,
};
