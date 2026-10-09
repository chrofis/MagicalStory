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
 *   state          per page and cited element with more than one look: a choice
 *                  over its looks, each option the look's own name and delta
 *                  (3 calls averaged) → code writes the dotted cite, and each
 *                  state's pages follow from the cites (applyVbPages)
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
const { TIMES_OF_DAY, CLOCK_HOURS, isSkylessLight, isSkyHidden, WEATHERS, JEV_TIME_CRITERIA, JEV_WEATHER_CRITERIA, JEV_SUBMERGED_CRITERIA } = require('./sceneLight');
const G = require('./gazeTargets');
const { EMOTIONS, EMOTION_MOOD } = require('./emotionVocabulary');
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
  light: { reps: 1, indoorAt: 0.5, newDayAt: 0.5 },
  lightSource: { reps: 1, at: 0.5 }, // which cited element lights a dark page (owner, 2026-10-06)
  vb: { reps: 1, creature: 0.7, vehicle: 0.5, secondary: 0.5, object: 0.7, objectBand: 0.5 },
  aboard: { reps: 1, at: 0.5 },     // 9/10 on the one ship book
  reads: { at: 0.5 },               // rides the vb call; 7/7 true on 674 stored plan lines (2026-09-28)
  population: { reps: 1, publicAt: 0.5, crowdAt: 0.5, creatureCrowdAt: 0.5, wildlifeAt: 0.4, sparseAt: 0.5 }, // wildlifeAt 0.4: a reef's fish read 0.44-0.56 on the two sea books (replay 2026-10-06), a land place 0.26-0.31; 13/13 for crowd/ambient/cast_only; the creature and sparse questions only ever read a place that was cast_only
  gaze: { reps: 3 },                // G2 128/139 averaged (owner: 3 calls for this field)
  state: { reps: 3 },               // a choice, averaged as gaze is (owner, 2026-09-28)
  outfit: { reps: 1, statedAt: 0.3 }, // outfit stated in the prose: P(s0) below 0.3 = not stated. 90/90 missing caught, 9/48 stated flagged on 138 read pages (decisions.md 2026-10-09 "clothing check to Jev")
  emotions: { reps: 1 },            // ONE call per story for every figure of every page (E10: 158/211 = 74.9%; a single call flips ~3%)
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

/**
 * ONE plan line, judged alone (the typed-plan questions and the plan check's Q17): the line without field 0, so the
 * question never sees the shot it may choose. Moved here from typedPlan.js when plan-check Q17 became Jev's.
 */
const LOCAL_PLAN_LINE_HEAD = 'A picture plan line (who is in frame — the instant the picture shows — what is true after):';
const localLineState = planLine => `${LOCAL_PLAN_LINE_HEAD}\n${planParts(planLine).slice(1).join(' — ')}`;

/**
 * The paired form (owner 2026-10-06): a `virtue` statement and its inverse `fault`, one noul each. The score is the
 * FAULT probability, so a model that says yes to both is pulled to 0.5 instead of agreeing with itself.
 */
const faultScore = (pVirtue, pFault) => +(((1 - pVirtue) + pFault) / 2).toFixed(3);

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
 * C of the outage policy, for ONE Jev request: retry with backoff until it
 * answers or `JEV_OUTAGE.waitMs` has passed since its first failure, then throw
 * JevDecisionError. A missing OPENROUTER_API_KEY is never retried. Shared by the
 * decision pool below and by the two Jev auditors (jevAudit runJevTextSource,
 * jevCastBeatVoice — 2026-09-30: they used to fail on the first error while the
 * decisions waited, so a short outage silently dropped their findings).
 *
 * @param {Function} call  (req) => Promise<{answers, cost, usage, model}>
 * @param {{key?:string, state:string, questions:Object}} rq
 * @param {{retryDelayMs?:number, shouldStop?:Function, onFailure?:Function}} opts
 */
async function callJevWaiting(call, rq, { retryDelayMs = 2000, shouldStop = () => null, onFailure = () => {} } = {}) {
  let firstFailAt = null;
  for (let attempt = 1; ; attempt++) {
    const stop = shouldStop();
    if (stop) throw stop;
    try {
      return await withTimeout(call({ state: rq.state, questions: rq.questions }), JEV_OUTAGE.callTimeoutMs, 'Jev call');
    } catch (e) {
      const stopNow = shouldStop();
      if (stopNow && e === stopNow) throw e;
      const msg = String(e.message || e);
      firstFailAt = firstFailAt || Date.now();
      const waited = Date.now() - firstFailAt;
      const final = NOT_AN_OUTAGE.test(msg) || waited >= JEV_OUTAGE.waitMs;
      onFailure({ attempt, msg, final });
      if (final) throw new JevDecisionError(`Jev ${rq.key ? `decision "${rq.key}"` : 'call'} failed after ${attempt} attempt(s) over ${Math.round(waited / 1000)} s: ${msg}`);
      if (attempt === 1) log.warn(`⏳ [JEV] ${rq.key ? `"${rq.key}"` : 'call'} failed (${msg.slice(0, 160)}) — waiting and retrying for up to ${Math.round(JEV_OUTAGE.waitMs / 1000)} s`);
      const delay = Math.min(retryDelayMs * 2 ** (attempt - 1), JEV_OUTAGE.maxBackoffMs, Math.max(0, JEV_OUTAGE.waitMs - waited));
      await new Promise(res => setTimeout(res, delay));
    }
  }
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
    const t0 = Date.now();
    const r = await callJevWaiting(call, rq, {
      retryDelayMs,
      shouldStop: () => failed,
      onFailure: ({ attempt, msg, final }) => {
        stats.errors.push({ key: rq.key, attempt, error: msg.slice(0, 300) });
        if (final) stats.failed++; else stats.retries++;
      },
    });
    const ms = Date.now() - t0;
    stats.calls++; stats.cost += Number(r.cost || 0); stats.ms.push(ms);
    recordTextUsage('openrouter', { ...openRouterUsage(r.usage), direct_cost: Number(r.cost || 0), elapsed_ms: ms }, usageLabel, r.model || J.JEV_MODEL);
    return r.answers;
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

/**
 * THE JEV-OUTAGE BACKUP (owner, 2026-09-27: "Can we keep today's setup as
 * backup if Jev is down?" — an explicit exception to NO FALLBACKS).
 *
 * `jevReport.fallback` is the one switch. It is set once per story, at the
 * pre-start probe (step 'start': the whole story runs today's setup before the
 * layer — the planner authors shots, cuts and the Art Director its fields) or
 * at the first step whose Jev calls still fail after the 5-minute wait
 * (JEV_OUTAGE): that step and every later one run the backup. Logged at error
 * level (`jev_fallback`) and stored on the story. The beats pipeline and the
 * trial's landmark selection (jevSelection.js) flip the same switch.
 */
function jevActive(jevReport) { return !(jevReport && jevReport.fallback); }

function jevFallBack(jevReport, step, err, gl) {
  if (!jevReport) throw err;
  if (jevReport.fallback) return;
  jevReport.fallback = { step, reason: String((err && err.message) || err).slice(0, 500), at: new Date().toISOString() };
  log.error(`🚨 [JEV] BACKUP PATH from step "${step}" — the Jev decision layer is unavailable (${jevReport.fallback.reason}); this step and every later decision run today's setup before the layer`);
  if (gl) gl.error('jev_fallback', `Jev unavailable from step "${step}": this story runs the backup path (the planner / Art Director author the decisions) — ${jevReport.fallback.reason}`, null, jevReport.fallback);
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

/**
 * The book's quotas: the shotVocabulary floors, plus the caps this assignment adds.
 * `quotas: false` is the typed page plan's budget (Lab experiment, 2026-10-05):
 * the floors became the planner's targets, so the assignment holds none of them
 * and only picks the best-fitting shot per page inside its type.
 */
function budgetOf(P, quotas = true) {
  if (!quotas) return { floors: {}, requiredPositions: 0, maxMediumWide: P, caps: {}, positionsCap: P, positionPool: 0 };
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
const groupAllows = (p, s) => !isGroup(p) || SV.GROUP_WIDER_SHOTS.includes(s);
// OVER-THE-SHOULDER NEEDS A NEAR FIGURE AND SOMEONE IT FACES (owner,
// 2026-09-28, shotVocabulary.OTS_MIN_IN_FRAME): a page with fewer in frame
// never takes it, so a floor slot moves to an eligible page — or stays empty
// and is reported unmet (violations → `unmet`), never forced onto a lone figure.
const otsAllows = (p, s) => s !== 'over-the-shoulder' || p.roster.length >= SV.OTS_MIN_IN_FRAME;
// A typed page (`allow`: the shots its picture type lists, shotVocabulary.PLAN_TYPES) takes only those.
const typeAllows = (p, s) => !p.allow || p.allow.includes(s);
const allowedShot = (p, s) => typeAllows(p, s) && groupAllows(p, s) && otsAllows(p, s);

/** The shot rules an assignment must hold; returns the broken ones. */
function violations(pages, shots, quotas = true) {
  const b = budgetOf(pages.length, quotas); const out = [];
  const count = s => shots.filter(x => x === s).length;
  for (const [s, n] of Object.entries(b.floors)) if (count(s) < n) out.push(`floor:${s}`);
  if (shots.filter(s => SV.POSITION_SHOTS.includes(s)).length < b.requiredPositions) out.push('floor:positions');
  if (count('medium') + count('wide') > b.maxMediumWide) out.push('cap:medium+wide');
  pages.forEach((p, i) => {
    if (!typeAllows(p, shots[i])) out.push(`type:p${p.page}`);
    if (!groupAllows(p, shots[i])) out.push(`group:p${p.page}`);
    if (!otsAllows(p, shots[i])) out.push(`ots:p${p.page}`);
  });
  for (let i = 1; i < pages.length; i++) {
    if (shots[i] === shots[i - 1] && pages[i].roster.length === pages[i - 1].roster.length) out.push(`consecutive:p${pages[i].page}`);
  }
  return out;
}
/** The caps the assignment itself keeps. */
function capBreaks(pages, shots, quotas = true) {
  if (!quotas) return [];
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
 * only take a GROUP_WIDER_SHOTS shot, and a page with fewer than
 * OTS_MIN_IN_FRAME in frame never takes over-the-shoulder — a mandatory slot
 * no page may take stays empty and its floor is reported unmet. Hungarian assignment of pages to slots is
 * exact for all of that. The consecutive rule (same shot and same cast count on
 * neighbours) is not a quota, so a local repair runs after: the cheapest single
 * change or swap that clears it and breaks nothing else; the aerial cap is
 * enforced the same way.
 *
 * @param {Array<{page:number, roster:string[]}>} pages
 * @param {Array<Object<string,number>>} S  S[i][shot] = fit score
 */
function assign(pages, S, { quotas = true } = {}) {
  const P = pages.length; const b = budgetOf(P, quotas); const BIG = 10;
  const slots = [];
  const add = (n, types, mandatory) => { for (let i = 0; i < n; i++) slots.push({ types, mandatory }); };
  if (!quotas) {
    // One free slot per page: each page takes its best allowed shot.
    add(P, IDS, false);
  } else {
    for (const [s, n] of Object.entries(b.floors)) add(n, [s], true);
    add(b.positionPool, SV.POSITION_SHOTS, true);
    add(b.maxMediumWide, ['medium', 'wide'], false);
    add(Math.max(0, b.caps['close-up'] - (b.floors['close-up'] || 0)), ['close-up'], false);
    add(Math.max(0, b.caps['ultra-wide'] - (b.floors['ultra-wide'] || 0)), ['ultra-wide'], false);
    add(Math.max(0, b.positionsCap - b.requiredPositions), SV.POSITION_SHOTS, false);
  }
  if (slots.length < P) throw new Error(`assign: ${slots.length} slots for ${P} pages`);
  const pick = (i, sl) => { let best = null; for (const s of sl.types) if (allowedShot(pages[i], s) && (best == null || S[i][s] > S[i][best])) best = s; return best; };
  const cost = pages.map((_, i) => slots.map(sl => { const s = pick(i, sl); return s == null ? 1e6 : -(S[i][s] + (sl.mandatory ? BIG : 0)); }));
  let shots = hungarian(cost).map((j, i) => pick(i, slots[j]));
  const total = sh => sh.reduce((n, s, i) => n + S[i][s], 0);
  const hard = sh => violations(pages, sh, quotas).filter(v => !v.startsWith('consecutive')).length + capBreaks(pages, sh, quotas).length;
  const soft = sh => violations(pages, sh, quotas).filter(v => v.startsWith('consecutive')).length + capBreaks(pages, sh, quotas).length;
  for (let guard = 0; guard < 3 * P; guard++) {
    const now = soft(shots);
    if (!now) break;
    const cands = [];
    for (let j = 0; j < P; j++) {
      for (const s of IDS) if (s !== shots[j]) { const t = shots.slice(); t[j] = s; cands.push(t); }
      for (let k = j + 1; k < P; k++) if (shots[k] !== shots[j]) { const t = shots.slice(); [t[j], t[k]] = [t[k], t[j]]; cands.push(t); }
    }
    const better = cands.filter(t => !violations(pages, t, quotas).some(v => !v.startsWith('consecutive')) && soft(t) < now).sort((a, c) => total(c) - total(a));
    if (!better.length) break;
    shots = better[0];
  }
  if (hard(shots)) shots.unmet = violations(pages, shots, quotas);
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

// What Jev is told each value means comes from the light table (sceneLight.LIGHTS / JEV_WEATHER_CRITERIA): one
// table, no hand-kept copy here (owner, 2026-10-06).
function lightQuestions() {
  return {
    TIME: { type: 'choice', instructions: 'The time of day in the picture of the page to judge, following the story\'s clock: it holds from page to page until the story moves it. A page set beneath the water, or in a place no daylight reaches (ink, a cave, a ship\'s hold), takes one of the underwater or dark options whatever the hour; the story\'s clock goes on around it. Judge the light at the place the camera stands: outside a dark structure (the outer hull of a wreck, a cave mouth) the camera is in the open water or the open air and the light is that open place\'s own; only a camera inside the structure has its dark.', criteria: JEV_TIME_CRITERIA },
    WEATHER: { type: 'choice', instructions: 'The weather visible in the picture of the page to judge. `none` when the scene is indoors, where the sky is not seen. Weather holds from page to page until the story changes it.', criteria: JEV_WEATHER_CRITERIA },
    INDOOR: { type: 'noul', instructions: 'The picture of the page to judge is set indoors: inside a building, a room, a cave or an enclosed vehicle.' },
    NEWDAY: { type: 'noul', instructions: 'The picture of the page to judge is on a LATER DAY than the page before it: the story has moved to the next day or beyond (a night slept through, "the next morning", "days later"), so its hour may be earlier than that of the page before.' },
  };
}

/** Hours at the day's end: after them, an earlier hour is the next day. */
const DAY_END = new Set(['evening', 'dusk', 'night']);
const DAY_START = new Set(['dawn', 'morning', 'midday']);

/**
 * THE CLOCK NEVER RUNS BACKWARDS. Page by page, an hour earlier than the one
 * before is a new day only when the page before ended the day (evening, dusk,
 * night) and this one starts one (dawn, morning, midday), or when Jev said the
 * page is on a later day (`newDays[i]`, the NEWDAY question: afternoon to the
 * next morning is allowed); any other earlier hour holds the previous page's
 * hour. Pure; returns the corrected list and what it held.
 */
function forwardClock(times, newDays = []) {
  const idx = t => CLOCK_HOURS.indexOf(t);
  const out = []; const held = [];
  // A skyless page (underwater, dark) is not an hour: it passes through as it is and the clock is
  // read against the last page that had an hour, so a dark page between two evenings moves nothing.
  let lastHour = null;
  for (let i = 0; i < times.length; i++) {
    const cur = times[i];
    if (isSkylessLight(cur)) { out.push(cur); continue; }
    if (lastHour && idx(cur) < idx(lastHour) && !(DAY_END.has(lastHour) && DAY_START.has(cur)) && !newDays[i]) {
      out.push(lastHour); held.push({ index: i, jev: cur, held: lastHour });
    } else { out.push(cur); lastHour = cur; }
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
    const newDayP = meanNoul(a, 'NEWDAY');
    // `indoor` is Jev's own INDOOR answer. A skyless light hides the sky too, but that is isSkyHidden's to say (weather
    // `none`, no outdoor light for a cover's dominant hour); folding it into this flag made an underwater page read
    // indoor with indoorP 0.01 (staging job_1791315635053_t0t8qpebu p4).
    const tp = (a && a[0] && a[0].TIME && a[0].TIME.probabilities) || {};
    const timeTop = Object.entries(tp).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${(+v).toFixed(2)}`);
    return { pageNumber: Number(p.pageNumber), jevTime: time, timeTop, weatherAdvice: weather, newDayP: +newDayP.toFixed(3), indoorP: +indoorP.toFixed(3), indoor: indoorP >= JEV_DECISIONS.light.indoorAt };
  });
  const clockHeld = applyClock(raw);
  for (const h of clockHeld) log.warn(`🌗 [JEV/light] page ${h.pageNumber}: Jev said ${h.jev} after ${h.held} — the clock never runs backwards, held at ${h.held}`);
  log.info(`🌗 [JEV/light] ${raw.map(r => `p${r.pageNumber}:${r.timeOfDay}${r.indoor ? '/in' : ''}`).join(' ')} (${stats.calls} calls)`);
  return { pages: raw, clockHeld, stats: summarise(stats) };
}

/**
 * THE CLOCK OVER DECIDED LIGHT ROWS: `timeOfDay` of every row from its `jevTime` and `newDayP`, the clock held
 * forward. One place for decideLight and for a re-decision (decideSubmergedLight) that changes a row's `jevTime`.
 * Mutates the rows; returns what was held.
 */
function applyClock(rows) {
  const clock = forwardClock(rows.map(r => r.jevTime), rows.map(r => r.newDayP >= JEV_DECISIONS.light.newDayAt));
  rows.forEach((r, i) => { r.timeOfDay = clock.times[i]; });
  return clock.held.map(h => ({ pageNumber: rows[h.index].pageNumber, jev: h.jev, held: h.held }));
}

/**
 * THE LIGHT OF A PAGE AT OR ABOARD A SUBMERGED PLACE (owner, 2026-10-07). The Visual Bible carries `submerged`
 * once per location or vehicle (jevBriefFields.submergedPages); the light is decided before the bible exists, so
 * the first answer, an hour for the inside of a sunken wreck (staging job_1791315635053_t0t8qpebu p9-p11:
 * evening, so a night sky, a lantern and a dry room), is replaced here: Jev is asked TIME again with its options
 * restricted to the lights beneath the surface (sceneLight.JEV_SUBMERGED_CRITERIA), and the clock is re-held.
 * Only the rows named in `pageNumbers` are asked; `jevTimeFirst` keeps the first answer for the record.
 *
 * @param {{arc:string, pages:Array, light:{pages:Array, clockHeld:Array}, pageNumbers:number[]}} input - `light` is decideLight's result, mutated
 * @returns {Promise<{asked:number[], changed:Array<{pageNumber:number, from:string, to:string}>, clockHeld:Array, stats:Object}>}
 */
async function decideSubmergedLight({ arc, pages, light, pageNumbers }, opts = {}) {
  const stats = newStats();
  const want = new Set((pageNumbers || []).map(Number));
  const asked = pages.filter(p => want.has(Number(p.pageNumber)));
  if (!asked.length) return { asked: [], changed: [], clockHeld: light.clockHeld || [], stats: summarise(stats) };
  const questions = { TIME: { type: 'choice', instructions: 'The light in the picture of the page to judge. The place of this page lies beneath the surface of the water, so the picture is beneath it too. Judge the light at the place the camera stands: outside a dark structure (the outer hull of a wreck) the camera is in open water and the light is that water\'s own; only a camera inside the structure has its dark.', criteria: JEV_SUBMERGED_CRITERIA } };
  const reqs = asked.map(p => ({ key: `submerged:p${p.pageNumber}`, state: pageState(arc, pages, p), questions }));
  const ans = await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_light_submerged', stats });
  for (const p of asked) {
    const row = light.pages.find(r => Number(r.pageNumber) === Number(p.pageNumber));
    const answers = ans.get(`submerged:p${p.pageNumber}`);
    const time = modalChoice(answers, 'TIME');
    if (!Object.prototype.hasOwnProperty.call(JEV_SUBMERGED_CRITERIA, time)) throw new JevDecisionError(`Jev TIME answer "${time}" on submerged page ${p.pageNumber} is outside ${Object.keys(JEV_SUBMERGED_CRITERIA).join('|')}`);
    const tp = (answers[0].TIME && answers[0].TIME.probabilities) || {};
    row.submerged = true;
    row.jevTimeFirst = row.jevTime;
    row.timeTop = Object.entries(tp).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${(+v).toFixed(2)}`);
    row.jevTime = time;
  }
  const before = new Map(light.pages.map(r => [Number(r.pageNumber), r.timeOfDay]));
  light.clockHeld = applyClock(light.pages);
  for (const h of light.clockHeld) log.warn(`🌗 [JEV/light] page ${h.pageNumber}: Jev said ${h.jev} after ${h.held} — the clock never runs backwards, held at ${h.held}`);
  const changed = light.pages.filter(r => r.timeOfDay !== before.get(Number(r.pageNumber))).map(r => ({ pageNumber: Number(r.pageNumber), from: before.get(Number(r.pageNumber)), to: r.timeOfDay }));
  log.info(`🌗 [JEV/light] submerged pages ${asked.map(p => p.pageNumber).join(', ')} re-asked beneath the surface: ${changed.map(c => `p${c.pageNumber} ${c.from}→${c.to}`).join(' ') || 'no change'} (${stats.calls} calls)`);
  return { asked: asked.map(p => Number(p.pageNumber)), changed, clockHeld: light.clockHeld, stats: summarise(stats) };
}

/**
 * WHAT LIGHTS A DARK PAGE (owner, 2026-10-06). On a page whose light is too dim to see by (night, dark,
 * deep or night water, ink) the picture needs a light source in it, and the cited elements say which: a
 * lantern, a glow-fish. Per such page and cited element (clothing excluded) one noul: it is lit or glowing
 * in its cited look and part of what lights the scene. Jev decides; code never reads a glow out of a
 * description (SETTLED: an object's own glow is a Visual Bible state, drawn from its state's reference
 * cell; this only names which lit element the page is lit by).
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>,
 *          perPage:Array<{pageNumber:number, elements:Array<{id:string, name:string, desc:string, look:string}>}>}} input
 * @returns {Promise<{byPage: Map<number, Array<{id:string, name:string, p:number}>>, stats:Object}>}
 */
async function decideLightSources({ arc, pages, perPage }, opts = {}) {
  const stats = newStats();
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const plans = perPage.filter(p => p.elements && p.elements.length && byNum.has(Number(p.pageNumber)));
  const reqs = plans.map((p) => {
    const qs = {};
    p.elements.forEach((e, i) => {
      qs[`LIT${i}`] = { type: 'noul', instructions: `${e.name}${e.look ? ` (${e.look})` : e.desc ? ` (${e.desc.slice(0, 100)})` : ''} is lit or glowing in the picture of the page to judge, and its light is part of what lights the scene.` };
    });
    return { key: `lit:p${p.pageNumber}`, state: pageState(arc, pages, byNum.get(Number(p.pageNumber))), questions: qs };
  }).flatMap(rq => repeat(rq, JEV_DECISIONS.lightSource.reps));
  const ans = reqs.length ? await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_light_sources', stats }) : new Map();
  const byPage = new Map();
  for (const p of plans) {
    const a = ans.get(`lit:p${p.pageNumber}`);
    byPage.set(Number(p.pageNumber), p.elements.map((e, i) => ({ id: e.id, name: e.name, p: +meanNoul(a, `LIT${i}`).toFixed(3) }))
      .filter(x => x.p >= JEV_DECISIONS.lightSource.at).sort((x, y) => y.p - x.p));
  }
  log.info(`💡 [JEV/lightSources] ${[...byPage].map(([n, xs]) => `p${n}:[${xs.map(x => x.name).join(',')}]`).join(' ')} (${stats.calls} calls)`);
  return { byPage, stats: summarise(stats) };
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
 * A CREATURE THE CAST RIDES OR SITS INSIDE (owner, 2026-10-06; staging ypl33 p4: children gripping a turtle's
 * shell, `aboard` null). Asked per creature beside the vehicles' aboard question; the page's `aboard` is the
 * highest of both sets. The creature stays in the picture, drawn from its own cell, as the ground the cast is on.
 */
function rideQuestion(c) {
  return `In the picture of the page to judge, the cast ride on ${c.name}${c.species ? `, the ${c.species}` : ''} (${c.desc.slice(0, 120)}), grip it or sit inside its body: its body is what they stand on, hold or sit in, so the camera is on it or in it.`;
}

/**
 * THE LOOK A PAGE SHOWS IS JEV'S (owner, 2026-09-28).
 *
 * An element whose `states[]` lists more than one look is cited on a page by
 * the dotted id of ONE of them. Code used to pick it from the Art Director's
 * state page lists — the state whose `pages` held the page, else "the latest
 * state begun before it". Staging job_1790539784661_6mjcny1c7 p3: the plan line
 * says the creature by the wall is grey now instead of red, the page sat in no
 * state's list, and the inference cited the red look. Jev now picks the look
 * from the same state as every other decision (the arc and the plan, the page
 * marked): one choice per cited element, each option that look's own name and
 * delta, 3 calls averaged. Code writes the dotted cite and rebuilds every
 * state's `pages` from the picks (applyVbPages). The Art Director authors the
 * looks, never which page shows which; the Jev-outage backup keeps its own
 * citations.
 *
 * see docs/decisions.md 2026-09-28 "Jev picks the look of a stated element"
 */
function stateId(entry, s, i) {
  return s && s.id && String(s.id).includes('.') ? String(s.id).toUpperCase() : `${baseId(entry.id)}.${i + 1}`;
}

/** An element's looks as the choice lists them, in the order the story reaches them: { id, label }. */
function stateOptions(entry) {
  const states = Array.isArray(entry?.states) ? entry.states.filter(Boolean) : [];
  return states.map((s, i) => ({
    id: stateId(entry, s, i),
    label: [s.name, s.delta].map(x => String(x || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(': ') || stateId(entry, s, i),
  }));
}

function stateQuestion(e) {
  const what = e.type === 'creature' || e.type === 'secondary'
    ? `${e.name}${e.species ? `, the ${e.species}` : ''}`
    : `the ${e.label || e.name}`;
  return `In the instant of the page to judge, which look does ${what} show? Its looks are listed in the order the story reaches them.`;
}

/**
 * Per page, the look each cited element with more than one state shows. One
 * call per page carries every such element; `JEV_DECISIONS.state.reps` calls
 * with the choice probabilities averaged; code takes the top look. An element
 * with one state is cited by it, one with none by its base id — neither asked.
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>,
 *          perPage:Array<{pageNumber:number, elements:Array}>}} input
 *   `elements` — the page's cited vbElements() rows (each carries its `entry`).
 * @returns {Promise<{byPage: Map<number, Map<string, {cite:string, p:number|null, looks?:Object}>>, stats:Object}>}
 */
async function decideStates({ arc, pages, perPage }, opts = {}) {
  const stats = opts.stats || newStats();
  const byNum = new Map(pages.map(p => [Number(p.pageNumber), p]));
  const plans = perPage.filter(p => byNum.has(Number(p.pageNumber))).map(p => ({
    pageNumber: Number(p.pageNumber),
    elements: p.elements,
    asked: p.elements.map(e => ({ e, looks: stateOptions(e.entry) })).filter(x => x.looks.length > 1),
  }));
  const reqs = plans.filter(p => p.asked.length).flatMap((p) => {
    const qs = {};
    p.asked.forEach((x, i) => {
      qs[`STATE${i}`] = { type: 'choice', instructions: stateQuestion(x.e), criteria: Object.fromEntries(x.looks.map((k, j) => [`s${j}`, k.label])) };
    });
    return repeat({ key: `state:p${p.pageNumber}`, state: pageState(arc, pages, byNum.get(p.pageNumber)), questions: qs }, JEV_DECISIONS.state.reps);
  });
  const ans = reqs.length ? await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_state', stats }) : new Map();
  const byPage = new Map();
  for (const p of plans) {
    const a = ans.get(`state:p${p.pageNumber}`) || [];
    const picks = new Map();
    for (const e of p.elements) {
      const i = p.asked.findIndex(x => x.e === e);
      if (i < 0) { const only = stateOptions(e.entry)[0]; picks.set(e.id, { cite: only ? only.id : e.id, p: null }); continue; }
      const looks = p.asked[i].looks;
      if (!a.length) throw new JevDecisionError(`Jev state decision for ${e.id} on page ${p.pageNumber} has no answers`);
      const probs = looks.map((k, j) => mean(a.map((x) => {
        const q = x[`STATE${i}`];
        if (!q || !q.probabilities) throw new JevDecisionError(`Jev state answer STATE${i} on page ${p.pageNumber} carries no probabilities`);
        return Number(q.probabilities[`s${j}`] || 0);
      })));
      const top = probs.indexOf(Math.max(...probs));
      picks.set(e.id, { cite: looks[top].id, p: +probs[top].toFixed(3), looks: Object.fromEntries(looks.map((k, j) => [k.id, +probs[j].toFixed(3)])) });
    }
    byPage.set(p.pageNumber, picks);
  }
  return { byPage, stats: summarise(stats) };
}

/**
 * The page asks the reader to READ lettering in the picture (owner, 2026-09-28:
 * "Text should also get its own check"). Plan lines never quote the string —
 * the quote heuristic found 0 of the reading pages in 674 stored plan lines —
 * so the question is asked of the moment. Measured on those 674 lines
 * (staging + prod): P ≥ 0.5 on 7 pages, all 7 reading pages (an alphabet
 * lesson, a name spelled out, a sign read aloud). It feeds the brief check
 * `required_text_undeclared` (sceneBriefCheck).
 */
const READ_TEXT_Q = 'In the picture of the page to judge, someone reads, spells out, traces or points at specific written letters, numbers or words, and the reader of the book must be able to read them in the picture.';

/**
 * Per page, which Visual Bible elements are in the picture, whether the
 * camera is aboard a vehicle, and whether the page has lettering the reader
 * must read. One call per page (all elements, all vehicles' aboard nouls and
 * the READ noul in it).
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine:string}>, visualBible:Object,
 *          commissionedNames:string[], adCited:Map<number,Set<string>>}} input
 *   `adCited` — the base ids each page's brief cited (the 0.5–0.7 object band).
 */
async function decideVbAndAboard({ arc, pages, visualBible, commissionedNames = [], adCited = new Map() }, opts = {}) {
  const { VB_ELEMENT_BUDGET } = require('./vbElementBudget');
  const els = vbElements(visualBible, commissionedNames);
  const vehicles = els.filter(e => e.type === 'vehicle');
  const creatures = els.filter(e => e.type === 'creature');
  const stats = newStats();
  const reqs = pages.flatMap(p => {
    const qs = { READ: { type: 'noul', instructions: READ_TEXT_Q } };
    els.forEach((e, i) => { qs[`E${i}`] = { type: 'noul', instructions: vbQuestion(e) }; });
    vehicles.forEach((v, i) => { qs[`ABOARD${i}`] = { type: 'noul', instructions: aboardQuestion(v) }; });
    creatures.forEach((c, i) => { qs[`RIDE${i}`] = { type: 'noul', instructions: rideQuestion(c) }; });
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
    const aboardScores = [...vehicles.map((v, i) => ({ id: v.id, p: meanNoul(a, `ABOARD${i}`) })),
      ...creatures.map((c, i) => ({ id: c.id, p: meanNoul(a, `RIDE${i}`) }))].sort((x, y) => y.p - x.p);
    const aboard = aboardScores.length && aboardScores[0].p >= JEV_DECISIONS.aboard.at ? aboardScores[0].id : null;
    const readP = meanNoul(a, 'READ');
    return {
      pageNumber: n, kept, overBudget, aboard, readsText: readP >= JEV_DECISIONS.reads.at, readP: +readP.toFixed(3),
      scores: Object.fromEntries(scored.map(({ e, p: P }) => [e.id, +P.toFixed(3)])),
      aboardScores: Object.fromEntries(aboardScores.map(x => [x.id, +x.p.toFixed(3)])),
    };
  });
  // The look each element in the picture shows: a second round, on what the
  // first one kept.
  const looks = await decideStates({ arc, pages, perPage: out.map(r => ({ pageNumber: r.pageNumber, elements: r.kept.map(k => k.e) })) }, { ...opts, stats });
  for (const r of out) {
    const picks = looks.byPage.get(r.pageNumber) || new Map();
    r.elements = r.kept.map(({ e, p: P }) => {
      const pick = picks.get(e.id);
      if (!pick) throw new JevDecisionError(`no look decided for ${e.id} on page ${r.pageNumber}`);
      return { id: e.id, cite: pick.cite, type: e.type, p: +P.toFixed(3), ...(pick.looks ? { stateP: pick.p, looks: pick.looks } : {}) };
    });
    delete r.kept;
  }
  for (const r of out) if (r.overBudget.length) log.warn(`🧱 [JEV/vb] page ${r.pageNumber}: ${r.elements.length + r.overBudget.length} elements in the picture, budget ${VB_ELEMENT_BUDGET} — left out (lowest P): ${r.overBudget.join(', ')}`);
  log.info(`🧩 [JEV/vb] ${out.map(r => `p${r.pageNumber}:[${r.elements.map(e => e.cite).join(',')}]${r.aboard ? `@${r.aboard}` : ''}${r.readsText ? ' reads' : ''}`).join(' ')} (${stats.calls} calls)`);
  return { pages: out, stats: summarise(stats) };
}

const POP_PUBLIC_Q = 'This place is one the public can walk into: a street, a square, a park, a bridge, a station, a shop, a museum hall.';
const POP_CROWD_Q = 'The story sets this place around a crowd: a market, a fair, a parade, a packed hall — many people are part of the scene.';
// The wider levels (owner, 2026-10-06): asked beside the two above, read only for a place they would leave `cast_only`.
const POP_CREATURE_CROWD_Q = 'The story sets this place around a crowd of unnamed creatures, not people: a shoal of fish, a swarm, a stampede, a flock filling the sky — a great many of them are part of the scene.';
const POP_WILDLIFE_Q = 'Unnamed animals belong in this place as part of its setting, not people: fish on a reef, a flock in a meadow, a herd on a plain, birds on a cliff.';
const POP_SPARSE_Q = 'One or two unnamed people may be far off in this place, tiny in the distance: a lone fisherman on a far pier, a figure on a distant hillside.';

/**
 * Population is a property of the PLACE (per page it was ❌). Per location the
 * pages set there: PUBLIC and CROWD nouls → crowd ≥ 0.5 → `crowd`, else
 * public ≥ 0.5 → `ambient`; a place that would be `cast_only` is then read by three more nouls:
 * `creature_crowd`, `wildlife`, `sparse` (in that order), else `cast_only`. The new levels never move a
 * place the two old questions already placed.
 *
 * @param {{arc:string, pages:Array, visualBible:Object, locOf:Map<number,string>}} input
 *   `locOf` — page → the base LOC id its brief cites. A cover beat (page number
 *   below 1) takes part like a page: the covers' places no story page stands on
 *   (offered landmarks) are decided from the cover's own plan line.
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
    // A cover (page number below 1) is a picture of this place too: a landmark no story page stands on is judged from its cover beats.
    const planLines = pages.filter(p => nums.includes(Number(p.pageNumber))).map(p => `${Number(p.pageNumber) > 0 ? `Page ${p.pageNumber}` : 'A cover'}: ${stripPlanShot(p.planLine)}`);
    const desc = String(l.description || '').slice(0, 240);
    const st = `A PLACE IN A CHILDREN'S PICTURE BOOK: ${l.name}${l.setting ? ` (${l.setting})` : ''} — ${desc}\n\nTHE STORY, beat by beat:\n${String(arc || '').trim()}\n\nTHE PAGES SET THERE (who is in frame — the instant — what is true after):\n${planLines.join('\n')}`;
    reqs.push(...repeat({ key: `pop:${id}`, state: st, questions: { PUBLIC: { type: 'noul', instructions: POP_PUBLIC_Q }, CROWD: { type: 'noul', instructions: POP_CROWD_Q }, CREATURE_CROWD: { type: 'noul', instructions: POP_CREATURE_CROWD_Q }, WILDLIFE: { type: 'noul', instructions: POP_WILDLIFE_Q }, SPARSE: { type: 'noul', instructions: POP_SPARSE_Q } } }, JEV_DECISIONS.population.reps));
  }
  const ans = reqs.length ? await runJevRequests(reqs, { ...opts, usageLabel: 'jev_decisions_population', stats }) : new Map();
  const byLoc = {};
  for (const [id] of pagesAt) {
    const a = ans.get(`pop:${id}`);
    if (!a) continue;
    const pub = meanNoul(a, 'PUBLIC'); const crowd = meanNoul(a, 'CROWD');
    const P = JEV_DECISIONS.population;
    const cc = meanNoul(a, 'CREATURE_CROWD'); const wl = meanNoul(a, 'WILDLIFE'); const sp = meanNoul(a, 'SPARSE');
    const population = crowd >= P.crowdAt ? 'crowd' : pub >= P.publicAt ? 'ambient'
      : cc >= P.creatureCrowdAt ? 'creature_crowd' : wl >= P.wildlifeAt ? 'wildlife' : sp >= P.sparseAt ? 'sparse' : 'cast_only';
    byLoc[id] = { population, publicP: +pub.toFixed(3), crowdP: +crowd.toFixed(3), creatureCrowdP: +cc.toFixed(3), wildlifeP: +wl.toFixed(3), sparseP: +sp.toFixed(3), pages: pagesAt.get(id).sort((x, y) => x - y) };
  }
  log.info(`🏙️ [JEV/population] ${Object.entries(byLoc).map(([id, v]) => `${id}:${v.population}`).join(' ') || 'no located page'} (${stats.calls} calls)`);
  return { byLocation: byLoc, stats: summarise(stats) };
}

// ───────────────────────── GAZE (looksAt) ─────────────────────────
// Wording and candidate builder verbatim from scripts/analysis/eval-jev-extra-fields.js
// (G2, "Gaze, depth, story relevance asked as fit", e3c329da1).

// The gaze words (down, up, ahead, distance, away, outside, held) are ONE table: gazeTargets.js.
// Owner, 2026-10-06: a missing option forces Jev onto a wrong answer, so the list is wide. A page's own
// place is no longer a target (vbIdGuard.gazeTarget blanks a looksAt naming the place the page stands in:
// 7 of 153 stored decisions wrote no eyes line); the figure looks down, up, ahead or into the distance.

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
  // Uncited items the plan line names are targets too (a held or mentioned thing, a vehicle), not only creatures and figures.
  const named = Object.values(index).filter(e => ['creature', 'figure', 'thing', 'vehicle'].includes(e.kind) && !/^CLO/i.test(String(e.id)) && !e.vantage && !cited.includes(e.id)
    && namedIn(e.name, stripPlanShot(planLine))).map(e => ({ id: e.id, kind: e.kind, name: e.name, desc: e.desc }));
  return { elements, named };
}

/**
 * Gaze candidates, enumerated in code: { target, label } (target = a name, an element id, or a gaze word).
 * `offFrame`: the commissioned characters the plan line names who are not in the picture; when there are
 * any, `outside` is offered (its label names them for Jev only; the stored value never carries a name).
 */
function gazeCandidates({ roster, elements, named, offFrame }, name) {
  const out = [];
  roster.filter(o => o !== name).forEach(o => out.push({ target: o, label: o }));
  const rosterSet = new Set(roster);
  // Never the figure itself: an Art Director roster entry can be a secondary
  // character's id (smoke story job_1790529840433_ar4u7qry3 p3: "CHR001" was
  // offered CHR001 and looked at itself).
  const self = String(name || '').trim().toUpperCase();
  [...elements, ...(named || [])].filter(e => e.kind !== 'place' && !rosterSet.has(e.name) && baseId(e.id) !== baseId(self) && String(e.name || '').trim().toUpperCase() !== self)
    .forEach(e => out.push({ target: e.id, label: `${e.name} (${e.desc.slice(0, 80)})` }));
  const off = (offFrame || []).filter(n => n !== name);
  // `held` is for a held thing the page does not list: when a thing or vehicle is listed, the eyes on it name it (replay 2026-10-06: `held` took 8 listed targets at P 0.7-1.0).
  const listsThing = out.some(k => /^(ART|VEH|GEN|OBJ)/i.test(String(k.target)) || (k.target !== name && [...elements, ...(named || [])].some(e => e.id === k.target && (e.kind === 'thing' || e.kind === 'vehicle'))));
  for (const t of G.GAZE_TARGETS) {
    if (t.id === 'held' && listsThing) continue;
    if (t.id === 'outside') { if (off.length) out.push({ target: t.id, label: `${t.jev}: ${whoText(off)}` }); continue; }
    out.push({ target: t.id, label: t.jev });
  }
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
      qs[`EYES${i}`] = { type: 'choice', instructions: `In the instant of the page to judge, what are ${n}'s eyes and hands on? When they are on a listed person or thing, that is the answer; the direction options are for eyes on nothing listed.`,
        criteria: Object.fromEntries(p.cands[i].map((k, j) => [`t${j}`, k.label])) };
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

// ───────────────────────── EMOTION (characters[].emotion, creatures[].emotion) ─────────────────────────

/**
 * The state of the one story-level emotion call: the arc and the whole plan
 * (shot stripped), exactly as the other decisions read them — the page TEXT does
 * not exist yet when the briefs are written (page text follows the final
 * briefs, beatsPipeline step 6). Trials and any caller that holds the prose pass
 * `text` per page instead and get the measured text state.
 */
function emotionState(arc, pages) {
  if (pages.some(p => p.text)) {
    const block = p => `--- Page ${p.pageNumber} ---\n${String(p.text || '').trim()}${p.planLine ? `\nPLAN: ${stripPlanShot(p.planLine)}` : ''}`;
    return `THE STORY TEXT:\n${pages.map(block).join('\n\n')}`;
  }
  return `THE STORY, beat by beat:\n${String(arc || '').trim() || '(no arc stored)'}\n\n${PLAN_HEAD}\n${planBlock(pages)}`;
}

/**
 * Each figure's emotion (owner, 2026-10-09, "Metadata and review should come
 * from Jev where possible"): ONE CHOICE over the closed list
 * (emotionVocabulary.EMOTIONS, described by EMOTION_MOOD) per figure per page,
 * every question of the story in ONE call (variant E10; docs/decisions.md
 * 2026-10-09 "Jev decides each figure's emotion before the briefs"). The
 * question wording is the measured one — "as the story tells it"; the "face
 * shows" wording defaults to neutral. Code writes the answer into `emotion`
 * (pinBrief); the Art Director draws `expression` to show it.
 *
 * @param {{arc:string, pages:Array<{pageNumber:number, planLine?:string, text?:string}>,
 *          perPage:Array<{pageNumber:number, figures:Array<{key:string, label:string}>}>}} input
 *   `key` is what the answer is stored under (a character's name, a creature's id), `label` how the question names it.
 * @returns {Promise<{byPage:Object<number,Object<string,string>>, stats:Object}>}
 */
async function decideEmotions({ arc, pages, perPage }, opts = {}) {
  const stats = newStats();
  const known = new Set(pages.map(p => Number(p.pageNumber)));
  const asked = [];
  const questions = {};
  for (const p of perPage) {
    if (!known.has(Number(p.pageNumber))) continue;
    for (const f of p.figures || []) {
      const id = `Q${asked.length}`;
      asked.push({ id, pageNumber: Number(p.pageNumber), key: f.key });
      questions[id] = { type: 'choice', instructions: `The feeling ${f.label} has at the moment of page ${p.pageNumber}, as the story tells it.`, criteria: EMOTION_MOOD };
    }
  }
  const byPage = {};
  if (asked.length) {
    const ans = await runJevRequests(repeat({ key: 'emotions', state: emotionState(arc, pages), questions }, JEV_DECISIONS.emotions.reps), { ...opts, usageLabel: 'jev_decisions_emotions', stats });
    const reps = ans.get('emotions') || [];
    for (const q of asked) {
      const emotion = modalChoice(reps, q.id);
      if (!EMOTIONS.includes(emotion)) throw new JevDecisionError(`Jev emotion answer "${emotion}" for ${q.key} on page ${q.pageNumber} is outside ${EMOTIONS.join('|')}`);
      (byPage[q.pageNumber] = byPage[q.pageNumber] || {})[q.key] = emotion;
    }
  }
  log.info(`🙂 [JEV/emotions] ${Object.entries(byPage).map(([n, m]) => `p${n}:${Object.entries(m).map(([k, e]) => `${k}=${e}`).join(',')}`).join(' ')} (${stats.calls} call(s))`);
  return { byPage, stats: summarise(stats) };
}

// ───────────────────────── is the outfit in the prose ─────────────────────────

/**
 * Per figure: does the scene prose dress this character in the outfit of their
 * wardrobe contract? One choice per figure over the SAME state (the prose):
 * the contract outfit / other clothing / nothing said. P(first option) is the
 * answer; below JEV_DECISIONS.outfit.statedAt the outfit is not stated.
 * Replaces clothingCheck.missingGarments, a token match that was blind for
 * every comma-list costume (an accessory word dropped the whole costume) and
 * flagged a third of the pages that did state their outfit.
 * see docs/decisions.md 2026-10-09 "The clothing check goes to Jev".
 *
 * @param {{prose:string, figures:Array<{name:string, outfit:string, upperOnly?:boolean}>}} input
 * @returns {Promise<{missing:string[], stated:Object<string,number>, stats:Object}>}
 */
async function decideOutfitsStated({ prose, figures }, opts = {}) {
  const stats = newStats();
  if (!String(prose || '').trim() || !(figures || []).length) return { missing: [], stated: {}, stats: summarise(stats) };
  const questions = {};
  figures.forEach((f, i) => {
    questions[`Q${i}`] = {
      type: 'choice',
      instructions: `What the text says ${f.name} wears.`,
      criteria: {
        s0: f.upperOnly ? `the upper garment of this outfit: ${f.outfit}` : `the clothing of this outfit: ${f.outfit}`,
        s1: 'clothing that differs from that outfit',
        s2: 'nothing, the text does not say',
      },
    };
  });
  const ans = await runJevRequests([{ key: 'outfit', state: prose, questions }], { ...opts, usageLabel: 'jev_decisions_clothing', stats });
  const answers = (ans.get('outfit') || [])[0] || {};
  const stated = {};
  const missing = [];
  figures.forEach((f, i) => {
    const a = answers[`Q${i}`];
    const p = a && a.probabilities && a.probabilities.s0;
    if (typeof p !== 'number') throw new JevDecisionError(`Jev outfit answer for ${f.name} carries no probability for the contract outfit: ${JSON.stringify(a)}`);
    stated[f.name] = p;
    if (p < JEV_DECISIONS.outfit.statedAt) missing.push(f.name);
  });
  return { missing, stated, stats: summarise(stats) };
}

// ───────────────────────── the FIXED fields in the brief ─────────────────────────

/**
 * The fields the decision layer owns, stated once to every brief author of the
 * page-brief call (all-pages and per-page) and the re-ask. Every decided field
 * reaches the Art Director as the page's FIXED block, so the prose stays
 * consistent with it, and the Art Director does NOT write it: code merges it
 * into the brief's METADATA (pinBrief, via jevBriefFields.assembleBriefs).
 * Owner, 2026-10-05: "Why ask Gemini to output the same fields code decides?"
 * — on stored replies ~25% of the briefs output was copied fixed data
 * (decisions.md 2026-10-05, which supersedes 2026-09-27 point 5).
 *
 * The `shot` is field 0 of the plan line the Art Director reads; on the Jev
 * path a rule that would change the shot — a close-up widened for below-waist
 * staging, a gap action reframed, a group pulled wider — applies to the
 * staging inside it, never to the field (owner, 2026-09-28).
 */
/**
 * What a FIXED `population` line asks of the prose when people are present.
 * The standing rule (scene-briefs-all.txt / scene-expansion.txt, "Background
 * people ... are dressed apart from the cast") sits ~70k characters into the
 * Art Director prompt, far from the page it governs: on staging
 * job_1791497309909_6quecrr9t all four `ambient` pages named no extras, so the
 * image model invented them in the cast's own colours. The ask now rides on the
 * page's own FIXED line, where the author reads the population.
 */
function populationExtrasNote(population) {
  return (population === 'ambient' || population === 'crowd')
    ? ' — the prose places unnamed people in the setting, each named with a garment kind and a colour no cast member wears'
    : '';
}

const JEV_FIXED_FIELDS_RULE = "A story page's FIXED block holds the fields decided before you write: its `shot`, `timeOfDay` and indoors, the Visual Bible ids its `objects[]` cites — its location or vantage, and for an element with looks the dotted id of the look it shows — its `aboard`, its `population`, each listed character's `looksAt` and each listed figure's `emotion`. A cover's FIXED block holds its `shot`, its light (`timeOfDay` and `weather`), its location, its `population`, its `era` and the gaze of every figure (the viewer). Code writes each into the page's METADATA: you never write a field the FIXED block lists (a field it does not list is yours — a cover's `aboard`, a `looksAt` or an `emotion` for a story-page figure it leaves out, an `objects[]` id it does not list such as a garment). Write the prose so the picture shows each: every cited element staged, even where only part of it is in frame, and no Visual Bible element staged that the FIXED `objects` leaves out. No other rule changes a fixed field; a rule that would change one applies to the staging inside it. A story page's `weather` stays yours — `none` indoors, never `none` outdoors. A cover's FIXED location is the vantage code writes first in `objects[]`, and the cover is seen as that vantage shows it.";

/**
 * Which shot a vantage holds, as the Visual Bible call is told it (owner,
 * 2026-09-28, "Jev first"): on the Jev path every story page's shot is already
 * field 0 of its plan line, so a vantage is written to hold its pages' shots.
 */
function vantageShotRule(jevBackup = false) {
  return jevBackup
    ? `A plan line whose first field is still the word ${SV.PLAN_SHOT_PLACEHOLDER} gets its shot with its brief: put such a page on a vantage whose plate holds the framing its plan line needs.`
    : 'Each story page\'s shot is the first field of its plan line and is fixed: a vantage holds only pages whose shot its plate can hold, so a page whose shot a shared plate cannot hold takes a vantage of its own.';
}

/**
 * The rule as a brief author / the review is given it. On the Jev-outage
 * backup nothing is decided upstream; the one thing left to say is who picks a
 * shot the plan still carries as the placeholder (a story that fell back after
 * its plan was written).
 */
const JEV_BACKUP_SHOT_RULE = `A plan line whose first field is still the word ${SV.PLAN_SHOT_PLACEHOLDER} leaves that page's camera shot to you.`;
function fixedFieldsRule(jevBackup = false) { return jevBackup ? JEV_BACKUP_SHOT_RULE : JEV_FIXED_FIELDS_RULE; }

/** How a FIXED line says where the page's light comes from: no sky, indoors, or outdoors. */
function fixedLightPlace(f, outdoors = 'outdoors') {
  if (isSkylessLight(f.timeOfDay)) return 'no sky (weather none)';
  return f.indoor ? 'indoors (weather none)' : outdoors;
}

/** The FIXED line under a page's PLAN line in the Art Director's plan block. */
function fixedLine(fixed) {
  if (!fixed || !fixed.timeOfDay) return '';
  return `FIXED: timeOfDay ${fixed.timeOfDay}; ${fixedLightPlace(fixed)}`;
}

/**
 * THE FIXED BLOCK under a story page's PLAN line in the page-brief call (owner,
 * 2026-09-28, "Jev first"): every field the decision layer decided, in the
 * words the brief's METADATA uses, each id with its label so the prose can
 * stage it. A page with no `jevFixed` (a cover, the Jev-outage backup, the
 * Visual Bible call before any element decision) carries only its light line,
 * if any. `labels`: id → display label (name, and the look for a dotted id).
 */
function fixedBlock(page) {
  const f = page && page.jevFixed;
  if (!f) return fixedLine(page && page.fixed);
  const label = id => (f.labels && f.labels[id] ? `${id} (${f.labels[id]})` : id);
  // A COVER'S FIXED BLOCK never lists `objects` (2026-10-04): that line reads as
  // the page's whole element list, and the cover would lose its central figure
  // and the elements its beat asks for. Since 2026-10-05 it also holds the
  // fields code owns on a cover (jevBriefFields.coverFacts): shot, light,
  // population, era and the gaze.
  if (f.coverPlace) {
    // The Jev-outage backup states no FIXED block anywhere (its templates carry no FIXED rule); the pin still runs.
    if (f.quiet) return '';
    const lines = ['FIXED — code writes each into METADATA (write none of them); the prose shows each:'];
    if (f.shot) lines.push(`- shot: ${f.shot}`);
    if (f.timeOfDay) lines.push(`- timeOfDay: ${f.timeOfDay}; ${fixedLightPlace(f, `outdoors, weather ${f.weather || 'yours to write'}`)}`);
    if (f.location) lines.push(`- location: ${label(f.location)} — code puts it first in objects[]; write the cover's other ids after it, following its beat`);
    if (f.population) lines.push(`- population: ${f.population}${populationExtrasNote(f.population)}`);
    if (f.era) lines.push(`- era: ${f.era}`);
    if (f.looksAtAll) lines.push(`- looksAt: every figure → ${f.looksAtAll} (the reader)`);
    return lines.length > 1 ? lines.join('\n') : '';
  }
  const lines = ['FIXED — code writes each into METADATA (write none of them); the prose shows each:'];
  if (f.shot) lines.push(`- shot: ${f.shot}`);
  if (f.timeOfDay) lines.push(`- timeOfDay: ${f.timeOfDay}; ${fixedLightPlace(f)}`);
  if (f.lightSources && f.lightSources.length) lines.push(`- lightSources: ${f.lightSources.join('; ')} (lit and glowing: the light the page is lit by)`);
  const objects = [...(f.location ? [f.location] : []), ...(f.cites || [])];
  lines.push(`- objects: ${objects.length ? objects.map(label).join('; ') : 'none'}`);
  lines.push(`- aboard: ${f.aboard ? label(f.aboard) : 'none'}${f.aboard && f.aboardFromGround ? ' — the figures stand on its deck; the location line is the view they have from it' : ''}`);
  if (f.population) lines.push(`- population: ${f.population}${populationExtrasNote(f.population)}`);
  const gaze = Object.entries(f.looksAt || {});
  if (gaze.length) lines.push(`- looksAt: ${gaze.map(([n, t]) => `${n} → ${G.gazeToken(t) ? `${t} (${G.gazeTokenRow(t).phrase})` : label(t)}`).join('; ')}`);
  const feelings = Object.entries(f.emotions || {});
  if (feelings.length) lines.push(`- emotion: ${feelings.map(([n, e]) => `${n} → ${e}`).join('; ')} (the feeling each face shows: draw its expression to show it)`);
  return lines.join('\n');
}

/**
 * Merge the decided fields into one brief's metadata (owner, 2026-10-05: the
 * Art Director no longer writes them, so on the page-brief call this is the
 * assembly of the final brief, not a restore). A change reported for the two
 * authors that still write the whole object — the iterate rewrite — is a field
 * the rewriter moved. Pure: returns the new brief and what changed. `fixed`:
 *   shot                           — the page's plan-line shot (Jev's)
 *   timeOfDay, indoor              — the light (weather: `none` indoors; an
 *                                    outdoor `none` is reported, never guessed)
 *   cites, decidedIds              — the element citations Jev decided and the
 *                                    base ids it was asked about: any decided id
 *                                    not in `cites` leaves objects[]; everything
 *                                    else (locations, undecided ids) stays
 *   population                     — the page's location's value
 *   aboard, aboardIds              — the vehicle or ridden creature the camera is on (or null); an
 *                                    `aboard` outside `aboardIds` (a structure) stays
 *   looksAt                        — { characterName: target }
   looksAtAll                     — one target for EVERY character row (a cover: `viewer`)
   emotions                       — { characterName | creatureId: emotion } (decideEmotions), the figures it lists
   weather, era                   — written as given (a cover's; a story page's weather stays the Art Director's)
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
  // THE SHOT IS JEV'S (owner, 2026-09-28): staging job_1790539784661_6mjcny1c7
  // p15 — Jev assigned over-the-shoulder, the Art Director wrote `medium`, and
  // only a console line (refreshPlanShot) recorded it. Pinned like the rest.
  if (fixed.shot) set('shot', fixed.shot);
  if (fixed.timeOfDay) set('timeOfDay', fixed.timeOfDay);
  // The names of the lit elements of a dark page (decideLightSources); [] clears a stale list.
  if (Array.isArray(fixed.lightSources)) set('lightSources', fixed.lightSources.length ? fixed.lightSources : null);
  // A cover's weather is code's (coverFacts); a story page's stays the Art Director's.
  if (fixed.weather) set('weather', fixed.weather);
  if (isSkyHidden(fixed)) set('weather', 'none');
  else if (fixed.indoor === false && (!m.weather || m.weather === 'none')) changes.push({ field: 'weather', from: m.weather || null, to: null, problem: 'outdoors' });
  if (Array.isArray(fixed.cites)) {
    const decided = new Set((fixed.decidedIds || []).map(baseId));
    const before = Array.isArray(m.objects) ? m.objects.map(String) : [];
    const kept = before.filter(o => !decided.has(baseId(o)));
    // Location first (the vantage a page stands on leads objects[]), then the decided
    // cites in the FIXED block's own order — what a well-behaved author used to copy —
    // then the ids the Art Director wrote itself (a garment, a generic).
    const keptLoc = kept.filter(o => /^LOC\d+/i.test(o));
    const next = [...keptLoc, ...fixed.cites.filter(c => !kept.some(k => baseId(k) === baseId(c))), ...kept.filter(o => !keptLoc.includes(o))];
    const added = fixed.cites.filter(c => !before.includes(c));
    const removed = before.filter(o => decided.has(baseId(o)) && !fixed.cites.includes(o));
    if (added.length || removed.length) { m.objects = next; changes.push({ field: 'objects', from: before, to: next, added, removed }); }
  }
  // THE LOCATION IS CODE'S (owner, 2026-09-28, Q8): the page's location or
  // vantage id, read from the Visual Bible's own page tables. Any other LOC
  // cite leaves objects[]; the decided one stands first.
  if (fixed.location) {
    const before = Array.isArray(m.objects) ? m.objects.map(String) : [];
    const isLoc = o => /^LOC\d+/i.test(String(o));
    const next = [fixed.location, ...before.filter(o => !isLoc(o))];
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      const removed = before.filter(o => isLoc(o) && o !== fixed.location);
      m.objects = next;
      changes.push({ field: 'location', from: before.filter(isLoc), to: fixed.location, removed });
    }
  }
  if (fixed.population) set('population', fixed.population);
  if (fixed.era) set('era', fixed.era);
  if (fixed.aboard !== undefined) {
    const own = new Set((fixed.aboardIds || []).map(baseId));
    const cur = m.aboard ? String(m.aboard) : null;
    if (fixed.aboard) set('aboard', fixed.aboard);
    else if (cur && own.has(baseId(cur))) set('aboard', null);
  }
  if (fixed.looksAtAll && Array.isArray(m.characters)) {
    m.characters = m.characters.map((c) => {
      if (!c || typeof c !== 'object' || c.looksAt === fixed.looksAtAll) return c;
      changes.push({ field: 'looksAt', name: c.name, from: c.looksAt ?? null, to: fixed.looksAtAll });
      return { ...c, looksAt: fixed.looksAtAll };
    });
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
  // EACH FIGURE'S EMOTION IS JEV'S (decideEmotions): a character row by name, a creature row by id.
  if (fixed.emotions) {
    const pinRows = (key, idOf) => {
      if (!Array.isArray(m[key])) return;
      m[key] = m[key].map((c) => {
        const id = c && typeof c === 'object' ? idOf(c) : null;
        if (!id || !Object.prototype.hasOwnProperty.call(fixed.emotions, id)) return c;
        const to = fixed.emotions[id];
        if (c.emotion === to) return c;
        changes.push({ field: 'emotion', name: id, from: c.emotion ?? null, to });
        return { ...c, emotion: to };
      });
    };
    pinRows('characters', c => c.name);
    pinRows('creatures', c => c.id);
  }
  if (!changes.some(c => !c.problem)) return { brief, changes };
  return { brief: `${parsed.prose}\n\n---METADATA---\n${JSON.stringify(m, null, 2)}`, changes };
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
  READ_TEXT_Q,
  JEV_OUTAGE,
  probeJev,
  jevActive,
  jevFallBack,
  newStats,
  summarise,
  meanNoul,
  JEV_FIXED_FIELDS_RULE,
  JEV_BACKUP_SHOT_RULE,
  fixedFieldsRule,
  fixedLine,
  fixedBlock,
  vantageShotRule,
  pinBrief,
  applyVbPages,
  gazeIndex,
  gazePageMaterial,
  gazeCandidates,
  decideGaze,
  decideEmotions,
  decideOutfitsStated,
  emotionState,
  namedIn,
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
  LOCAL_PLAN_LINE_HEAD,
  localLineState,
  faultScore,
  withShot,
  withWho,
  whoText,
  pageState,
  runJevRequests,
  callJevWaiting,
  shotFitQuestions,
  hungarian,
  budgetOf,
  allowedShot,
  violations,
  assign,
  decideShots,
  applyShots,
  decideGroupCuts,
  castCutFindings,
  lightQuestions,
  forwardClock,
  decideLight,
  decideSubmergedLight,
  applyClock,
  decideLightSources,
  vbElements,
  vbQuestion,
  aboardQuestion,
  rideQuestion,
  stateOptions,
  stateQuestion,
  decideStates,
  decideVbAndAboard,
  decidePopulation,
};
