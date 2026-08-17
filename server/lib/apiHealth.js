/**
 * API health tracking — persists rate-limit / overload responses from the AI
 * providers (Anthropic, xAI, Gemini, Runware) so they can surface in the daily
 * summary. Previously these errors only threw + retried and were never recorded,
 * so a sustained Anthropic limit-hit was invisible.
 *
 * STORAGE MOVED 2026-08-17: rows live in `failure_log` as kind='provider_limit',
 * not in a table of their own. This file used to own `api_health_events`, whose
 * shape (provider + HTTP status) could describe exactly this one failure family
 * and nothing else — a rejected face repair has neither. Rather than keep two
 * half-logs and grow a third, there is now ONE failure log and this module keeps
 * what is genuinely its own: which provider an error came from, and whether the
 * error means "limit/overload" at all. Migration 022 moved the history and
 * dropped the old table.
 *
 * Recording is best-effort and fire-and-forget: it must never break or slow down
 * generation.
 */
'use strict';

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

/**
 * Record a provider limit/overload response. INTERNAL severity: the call is
 * retried, so a customer only feels it if the retries also fail — and that
 * failure records itself, where it happens, as its own kind.
 */
function recordApiError(err) {
  const message = String((err && err.message) || '').slice(0, 300);
  const provider = providerFrom(message);
  require('./failureLog').recordFailure({
    kind: 'provider_limit',
    severity: 'internal',
    // Grouped per provider+status: "Anthropic 429" is one line however many
    // times it fires, which is the only useful shape in a daily digest.
    fingerprint: `${provider}${(err && err.status) ? ` ${err.status}` : ''}`,
    summary: message || 'provider limit',
    detail: { status: (err && err.status) || null, provider },
  });
}

/**
 * [{ provider, status, count, last }] for the window, busiest first.
 * Shape preserved for adminActivity's daily summary — only the source changed.
 */
async function getApiHealth(pool, hours = 24) {
  try {
    const r = await pool.query(
      `SELECT fingerprint,
              (detail->>'provider')          AS provider,
              (detail->>'status')::int       AS status,
              COUNT(*)::int                  AS n,
              MAX(occurred_at)               AS last
         FROM failure_log
        WHERE kind = 'provider_limit'
          AND occurred_at > NOW() - make_interval(hours => $1::int)
        GROUP BY fingerprint, provider, status
        ORDER BY n DESC`,
      [hours]
    );
    return r.rows.map(x => ({
      provider: x.provider || x.fingerprint || 'unknown',
      status: x.status,
      count: x.n,
      last: x.last,
    }));
  } catch { return []; }
}

module.exports = { recordApiError, getApiHealth, isLimitError, providerFrom };
