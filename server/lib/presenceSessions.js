'use strict';

/**
 * Presence-driven analyzer sessions — "the user being there IS the session".
 *
 * Owner direction (2026-08-23): a first photo upload must never pay a worker
 * cold start. As soon as a user lands on the trial wizard or the create-story
 * wizard, the analyzer's face+rembg workers are spawned and warmed, so by the
 * time a photo arrives (consent + form-filling later) analysis is instant.
 * The session closes when the user leaves or has been inactive for ~5 minutes
 * — that window is the owner's explicit spec, not an arbitrary threshold.
 *
 * Mechanics: the client sends anonymous heartbeats (a random token per tab)
 * while its surface is visible and the user recently active. The FIRST beat of
 * a token opens one analyzer session (+ warmup); a sweeper expires tokens that
 * have not beaten for PRESENCE_TTL_MS and closes their session. Job sessions
 * (story / avatar / Lab) are separate refcounts on the same counter, so a user
 * closing the tab mid-generation never kills the workers the story is using.
 */

const { log } = require('../utils/logger');
const { sessionBegin, sessionEnd, analyzerFetch } = require('./analyzerClient');

// Owner's spec: "inactive for 5 min or so".
const PRESENCE_TTL_MS = Number(process.env.PRESENCE_TTL_MS || 5 * 60 * 1000);
const SWEEP_INTERVAL_MS = 30 * 1000;

// token -> { lastBeat, surface }
const tokens = new Map();

// Hard cap on concurrently tracked tokens. Each open token holds one analyzer
// session; without a cap, a scripted flood of random tokens would pin the
// worker fleet permanently. Beyond the cap new tokens still get warm workers
// (their beat spawns nothing extra — workers are shared) but no NEW session.
const MAX_TOKENS = 50;

function beat(token, surface = 'unknown') {
  if (!token || typeof token !== 'string' || token.length > 64) {
    return { ok: false, error: 'bad token' };
  }
  const existing = tokens.get(token);
  if (existing) {
    existing.lastBeat = Date.now();
    return { ok: true, active: tokens.size, new: false };
  }
  if (tokens.size >= MAX_TOKENS) {
    log.warn(`[PRESENCE] token cap (${MAX_TOKENS}) reached — beat accepted without a new session`);
    return { ok: true, active: tokens.size, new: false, capped: true };
  }
  tokens.set(token, { lastBeat: Date.now(), surface });
  log.debug(`[PRESENCE] ${surface} arrived (${tokens.size} present) — opening analyzer session + warm`);
  sessionBegin(`presence:${surface}`);
  // Warm the photo-upload path only: face (mediapipe) + rembg. DINO's 1.9GB
  // stays out of it — the story pipeline warms torch at story start, which is
  // 20+ minutes before the repair phase needs it.
  analyzerFetch('/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dino: false }),
    signal: AbortSignal.timeout(8000),
  }, { retries: 1, retryDelayMs: 3000 }).catch(() => {});
  return { ok: true, active: tokens.size, new: true };
}

/** Explicit goodbye (pagehide). Best-effort — the sweeper is the guarantee. */
function leave(token) {
  const entry = tokens.get(token);
  if (!entry) return { ok: true, active: tokens.size };
  tokens.delete(token);
  log.debug(`[PRESENCE] ${entry.surface} left (${tokens.size} present) — closing analyzer session`);
  sessionEnd(`presence:${entry.surface}`);
  return { ok: true, active: tokens.size };
}

function _sweep() {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (now - entry.lastBeat > PRESENCE_TTL_MS) {
      tokens.delete(token);
      log.debug(`[PRESENCE] ${entry.surface} expired after ${Math.round((now - entry.lastBeat) / 1000)}s idle — closing analyzer session`);
      sessionEnd(`presence-expired:${entry.surface}`);
    }
  }
}

const sweeper = setInterval(_sweep, SWEEP_INTERVAL_MS);
sweeper.unref?.();

module.exports = { beat, leave, PRESENCE_TTL_MS };
