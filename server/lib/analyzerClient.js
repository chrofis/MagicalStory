/**
 * Client for the Python photo analyzer, with two jobs:
 *
 *  1. Survive a restart. The analyzer is a separate Railway service since
 *     2026-09-04, so it redeploys and restarts independently of Node, and
 *     nothing is listening on port 5000 while it does. Repair calls fall back to
 *     Gemini, but photo upload has NO fallback: a user would just see their
 *     upload fail. Retrying a refused connection closes that window, which no
 *     amount of scheduling can fully close on its own.
 *
 *     (This used to say the analyzer "exits itself when idle and bloated". That
 *     mechanism was deleted on 2026-08-23 — memory now comes back by killing
 *     whole workers when the session count reaches zero. The retry policy is
 *     still right; only the stated reason had gone stale.)
 *
 *  2. Warm it while the user is active, so models load during the wizard or
 *     during the story's opening Claude calls, instead of costing ~570MB and
 *     several seconds inside the character-repair loop.
 */

'use strict';

const { log } = require('../utils/logger');
const { photoAnalyzerUrl } = require('./photoAnalyzerClient');

const BASE = () =>photoAnalyzerUrl();

// Connection-level failures only. A 500 from the analyzer is a real answer and
// must NOT be retried — retrying real errors hides bugs and multiplies load.
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'ECONNABORTED', 'EAI_AGAIN']);

function isRetryable(err) {
  const code = err?.cause?.code || err?.code || '';
  return RETRYABLE.has(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() against the analyzer that rides out a restart.
 * Defaults cover ~12s of downtime, comfortably more than the ~10s boot.
 */
async function analyzerFetch(path, options = {}, { retries = 3, retryDelayMs = 4000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(`${BASE()}${path}`, options);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) break;
      log.warn(
        `[ANALYZER] ${path} unreachable (${err?.cause?.code || err.code}) — ` +
        `likely mid-restart, retry ${attempt + 1}/${retries} in ${retryDelayMs}ms`
      );
      await sleep(retryDelayMs);
    }
  }
  throw lastErr;
}

// Debounce: "user is active" fires on lots of requests, but warming is only
// worth doing occasionally. The analyzer's own get_*() are idempotent, so the
// only cost of a redundant call is noise.
let lastWarmMs = 0;
const WARM_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Tell the analyzer to preload its models because a user is active.
 * Fire-and-forget: never block or fail a user request over warming.
 */
function ensureWarm(reason = 'user-active', { force = false, workers = null } = {}) {
  const now = Date.now();
  // force bypasses the debounce for a known-critical moment (e.g. the repair
  // phase is about to run detection after a long text/image phase that let the
  // models idle-unload). The debounce is shared across stories, so without
  // force a concurrent story's recent warm could skip the one that matters.
  if (!force && now - lastWarmMs < WARM_INTERVAL_MS) return;
  lastWarmMs = now;
  // WHICH models to preload is the CALLER's answer, not the analyzer's guess
  // (owner, 2026-08-17). The analyzer used to decide from its own
  // FIGURE_DETECTION_BACKEND env var, which meant two places had to agree; when
  // the Node default flipped to grounding-dino the analyzer's copy still said
  // "empty" and skipped loading DINO, so the ~90s load landed on the first real
  // detection call. Since behaviour now lives in server/config/runtime.js and
  // runtime() has no env override, that env var is dead on this side — the
  // analyzer cannot read the truth even in principle. So we send it.
  const wantDino = require('../config/runtime').runtime('figureDetectionBackend') === 'grounding-dino';
  // `workers` names the worker PROCESSES to spawn; the model flags only say
  // what each preloads once it exists. Needed because `dino` selects a model
  // INSIDE the torch worker and so could never express "don't spawn torch" —
  // and torch owns MobileSAM too, so overloading `dino` for that would be
  // wrong. Omitted -> the analyzer's historical default (face + torch).
  const payload = { dino: wantDino };
  if (Array.isArray(workers) && workers.length) payload.workers = workers;
  analyzerFetch('/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  }, { retries: 1, retryDelayMs: 3000 })
    .then(() => log.debug(`[ANALYZER] warmup requested (${reason})`))
    .catch((err) => log.debug(`[ANALYZER] warmup skipped: ${err.message}`));
}

// ── Session lifecycle ───────────────────────────────────────────────────────
// The analyzer's heavy models live in worker processes that are killed when the
// active-session count reaches zero — that is its ONLY memory management (the
// RSS-threshold recycler and idle reapers were deleted 2026-08-23; owner:
// "if a story is done everything should be freed again, no arbitrary
// recycling"). Node brackets real work with these calls:
//
//   sessionBegin()  at story start / avatar-job start / Lab experiment start
//   sessionEnd()    in the matching finally — completion AND failure paths
//   sessionReset()  once at server boot: a restarted Node cannot know how many
//                   sessions its predecessor left open, so the only correct
//                   count is zero (kills any leftover workers with it)
//
// All fire-and-forget: a session miss never blocks or fails user work. The
// cost of a missed END is bounded — workers linger until the next session
// closes or the next sessionless request completes, not forever.

function _sessionCall(path, reason, body) {
  return analyzerFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  }, { retries: 1, retryDelayMs: 2000 })
    .then((r) => r.json().catch(() => null))
    .then((j) => {
      log.debug(`[ANALYZER] ${path} (${reason}) -> active=${j?.active ?? '?'}`);
      return j;
    })
    .catch((err) => {
      log.debug(`[ANALYZER] ${path} (${reason}) skipped: ${err.message}`);
      return null;
    });
}

// SESSIONS ARE IDENTIFIED, NOT COUNTED (2026-09-06).
//
// These calls are fire-and-forget with connection-only retry, so a begin CAN be
// lost — during an analyzer restart, most obviously. Under the old bare refcount
// a lost increment became a stolen decrement: story A's end took story B's count
// to zero and reaped B's workers mid-repair. An id the analyzer never registered
// is simply absent, so ending it is a no-op instead of somebody else's loss.
//
// `id` defaults to `reason`, which every caller already makes unique per job
// (`story:${jobId}`, `avatar:${jobId}`, `testlab:${experimentId}`). Presence is
// the exception — two tabs share a surface — so it passes the tab token.
const sessionBegin = (reason = 'work', { id = reason } = {}) =>
  _sessionCall('/session/begin', reason, { id, label: reason });
const sessionEnd = (reason = 'work', { id = reason } = {}) =>
  _sessionCall('/session/end', reason, { id });
const sessionReset = () => _sessionCall('/session/reset', 'node-boot');

module.exports = { analyzerFetch, ensureWarm, sessionBegin, sessionEnd, sessionReset };
