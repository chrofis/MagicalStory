/**
 * API health tracking — persists rate-limit / overload responses from the AI
 * providers (Anthropic, xAI, Gemini) so they can surface in the daily summary.
 * Previously these errors only threw + retried and were never recorded, so a
 * sustained Anthropic limit-hit was invisible. Recording is best-effort and
 * fire-and-forget: it must never break or slow down generation.
 */
'use strict';

const { getPool } = require('../services/database');

let ensured = false;
async function ensure(pool) {
  if (ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS api_health_events (
    id SERIAL PRIMARY KEY,
    provider TEXT,
    status INTEGER,
    message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_api_health_created ON api_health_events(created_at)`);
  ensured = true;
}

function providerFrom(msg) {
  if (/anthropic/i.test(msg)) return 'Anthropic';
  if (/xai/i.test(msg)) return 'xAI';
  if (/gemini/i.test(msg)) return 'Gemini';
  if (/runware/i.test(msg)) return 'Runware';
  return 'unknown';
}

// True for the responses that mean "we hit a usage/rate limit or the provider
// is overloaded" — 429 (rate limit), 529 (overloaded), or a matching message.
function isLimitError(err) {
  const s = err && err.status;
  const m = (err && err.message) || '';
  return s === 429 || s === 529 || /overloaded|rate.?limit|usage limit|quota/i.test(m);
}

// Fire-and-forget. Never throws.
function recordApiError(err) {
  (async () => {
    try {
      const pool = getPool();
      await ensure(pool);
      await pool.query(
        'INSERT INTO api_health_events (provider, status, message) VALUES ($1, $2, $3)',
        [providerFrom((err && err.message) || ''), (err && err.status) || null, String((err && err.message) || '').slice(0, 300)]
      );
    } catch { /* monitoring must never break generation */ }
  })();
}

// [{ provider, status, count, last }] for the window, busiest first.
async function getApiHealth(pool, hours = 24) {
  try {
    await ensure(pool);
    const r = await pool.query(
      `SELECT provider, status, COUNT(*)::int AS n, MAX(created_at) AS last
         FROM api_health_events
        WHERE created_at > NOW() - make_interval(hours => $1::int)
        GROUP BY provider, status ORDER BY n DESC`,
      [hours]
    );
    return r.rows.map(x => ({ provider: x.provider, status: x.status, count: x.n, last: x.last }));
  } catch { return []; }
}

module.exports = { recordApiError, getApiHealth, isLimitError };
