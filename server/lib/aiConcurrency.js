/**
 * Server-side AI provider concurrency limits.
 *
 * Per the 2026-05-22 codebase-audit decision, upstream pLimit(50) values in
 * server.js / useRepairWorkflow.ts stay as-is — the client / pipeline can
 * fan out as wide as they like. Provider calls then queue against these
 * smaller per-provider limits so we don't slam Google/Anthropic/xAI/Runware
 * with 50 simultaneous requests and trigger rate-limit errors.
 *
 * Each function returns a wrapped promise that runs inside the right limit.
 * Usage:
 *
 *     const { withGemini } = require('./aiConcurrency');
 *     const result = await withGemini(() => fetch(GEMINI_URL, { ... }));
 *
 * Tune the constants based on Railway plan + provider rate limits.
 * Conservative defaults — increase if you observe queueing under load and
 * provider rate-limit responses stay rare.
 */

const pLimit = require('p-limit');

// Per-provider limits. Picked conservatively:
//   Gemini  6 — generous quota but page-eval bursts can hit 4-6 concurrent
//   Claude  4 — Anthropic rate limits are tighter, esp. on Sonnet
//   Grok    6 — xAI tolerates parallel edit calls well
//   Runware 4 — moderate (FLUX models are GPU-bound on their side)
const GEMINI_LIMIT = parseInt(process.env.GEMINI_CONCURRENCY || '6', 10);
const ANTHROPIC_LIMIT = parseInt(process.env.ANTHROPIC_CONCURRENCY || '4', 10);
const GROK_LIMIT = parseInt(process.env.GROK_CONCURRENCY || '6', 10);
const RUNWARE_LIMIT = parseInt(process.env.RUNWARE_CONCURRENCY || '4', 10);

const _gemini = pLimit(GEMINI_LIMIT);
const _anthropic = pLimit(ANTHROPIC_LIMIT);
const _grok = pLimit(GROK_LIMIT);
const _runware = pLimit(RUNWARE_LIMIT);

const withGemini = (fn) => _gemini(fn);
const withAnthropic = (fn) => _anthropic(fn);
const withGrok = (fn) => _grok(fn);
const withRunware = (fn) => _runware(fn);

// Expose limit state for diagnostics / dev-panel rendering.
function getConcurrencyStatus() {
  return {
    gemini:    { limit: GEMINI_LIMIT,    activeCount: _gemini.activeCount,    pendingCount: _gemini.pendingCount },
    anthropic: { limit: ANTHROPIC_LIMIT, activeCount: _anthropic.activeCount, pendingCount: _anthropic.pendingCount },
    grok:      { limit: GROK_LIMIT,      activeCount: _grok.activeCount,      pendingCount: _grok.pendingCount },
    runware:   { limit: RUNWARE_LIMIT,   activeCount: _runware.activeCount,   pendingCount: _runware.pendingCount },
  };
}

module.exports = { withGemini, withAnthropic, withGrok, withRunware, getConcurrencyStatus };
