/**
 * THE FAILURE LOG — one place every failure lands.
 *
 * WHY THIS EXISTS (owner, 2026-08-17): a customer pressed "repair face" on p6 of
 * job_1786917840874_rur4nskfv and nothing happened. The reason (a blend gate
 * rejecting a re-posed figure at 34% overlap) existed only in a Railway log line,
 * and by the time it was asked about, the buffer had rolled — it had to be
 * reproduced with a paid call to recover a sentence we already had. That is ONE
 * of hundreds of possible failures, and none of them were counted anywhere.
 *
 * THE RULE: a failure a customer can feel gets recorded here with
 * severity 'customer'. Everything else that went wrong but recovered gets
 * 'internal'. The daily report is then assembled from data, not from whoever
 * happened to read the logs that morning.
 *
 * Design constraints, all learned the hard way:
 *   - NEVER throws, NEVER blocks. A logging failure must not fail the request
 *     it is describing. Every path is fire-and-forget and swallows its own error.
 *   - NEVER writes image bytes. `detail` is stripped of data URIs and truncated
 *     (the iron rule: no images in JSONB).
 *   - Deduped in-process. A loop that fails 400 times writes a handful of rows,
 *     not 400 — otherwise the first bad deploy makes the table useless.
 */

const { log } = require('../utils/logger');

const DEDUPE_WINDOW_MS = 10 * 60 * 1000;   // same fingerprint within 10 min → one row
const MAX_ROWS_PER_HOUR = 200;             // hard backstop against a runaway loop
const MAX_DETAIL_CHARS = 4000;

const _recent = new Map();                 // fingerprint → last written ms
let _hourStart = 0;
let _hourCount = 0;

/** Bytes never reach the table: data URIs out, long strings clipped. */
function sanitizeDetail(detail) {
  if (detail == null) return null;
  let json;
  try {
    json = JSON.stringify(detail, (key, value) => {
      if (typeof value !== 'string') return value;
      if (/^data:image\/\w+;base64,/.test(value)) return `[image ${Math.round(value.length / 1365)}KB omitted]`;
      if (/^https?:\/\//.test(value) && value.length > 200) return value.slice(0, 200) + '…';
      return value.length > 600 ? value.slice(0, 600) + '…' : value;
    });
  } catch { return null; }
  if (json.length > MAX_DETAIL_CHARS) json = json.slice(0, MAX_DETAIL_CHARS - 20) + '","_truncated":true}';
  try { return JSON.parse(json); } catch { return { _unserializable: true }; }
}

function _allowed(fingerprint) {
  const now = Date.now();
  if (now - _hourStart > 3600_000) { _hourStart = now; _hourCount = 0; }
  if (_hourCount >= MAX_ROWS_PER_HOUR) return false;
  const key = fingerprint || 'unkeyed';
  const last = _recent.get(key);
  if (last && now - last < DEDUPE_WINDOW_MS) return false;
  _recent.set(key, now);
  if (_recent.size > 500) {                // bounded map; drop the oldest half
    const entries = [..._recent.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, 250)) _recent.delete(k);
  }
  _hourCount++;
  return true;
}

/**
 * Record a failure. Fire-and-forget: returns immediately, never rejects.
 *
 * @param {object} f
 * @param {string} f.kind        stable slug, e.g. 'char_repair_rejected'
 * @param {string} f.summary     one line, human-readable, no stack traces
 * @param {'customer'|'internal'} [f.severity='internal']
 * @param {string} [f.fingerprint]  grouping key within the kind; defaults to kind
 * @param {string} [f.storyId] @param {number} [f.pageNumber]
 * @param {string} [f.character] @param {string} [f.userId]
 * @param {object} [f.detail]    bounded context (sanitised before writing)
 */
function recordFailure(f = {}) {
  try {
    if (!f.kind || !f.summary) return;
    const fingerprint = String(f.fingerprint || f.kind).slice(0, 200);
    if (!_allowed(`${f.kind}|${fingerprint}`)) return;
    // getPool() returns falsy when STORAGE_MODE is not 'database', which is the
    // only "database mode" test this module needs.
    const { getPool } = require('../services/database');
    const pool = getPool && getPool();
    if (!pool) return;
    // Deliberately not awaited: the caller is reporting a failure, not waiting
    // on one. A rejected insert must never surface as a second failure.
    pool.query(
      `INSERT INTO failure_log
         (environment, kind, severity, fingerprint, story_id, page_number, character_name, user_id, summary, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        process.env.RAILWAY_ENVIRONMENT_NAME || 'local',
        String(f.kind).slice(0, 64),
        f.severity === 'customer' ? 'customer' : 'internal',
        fingerprint,
        f.storyId ? String(f.storyId).slice(0, 100) : null,
        Number.isFinite(f.pageNumber) ? f.pageNumber : null,
        f.character ? String(f.character).slice(0, 100) : null,
        // UUID column: a non-uuid string would throw, and this must not throw.
        /^[0-9a-f-]{36}$/i.test(String(f.userId || '')) ? f.userId : null,
        String(f.summary).slice(0, 2000),
        sanitizeDetail(f.detail),
      ]
    ).catch(err => log.debug(`[FAILURE-LOG] insert skipped: ${err.message}`));
  } catch (err) {
    log.debug(`[FAILURE-LOG] record skipped: ${err.message}`);
  }
}

/**
 * What failed in a window, grouped — the shape the daily report needs.
 * Customer-visible first, because that is the part that matters to a human.
 */
async function summariseFailures({ hours = 24 } = {}) {
  const { getPool } = require('../services/database');
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT kind, severity, fingerprint,
            COUNT(*)::int          AS occurrences,
            COUNT(DISTINCT story_id)::int AS stories,
            MAX(occurred_at)       AS last_seen,
            (ARRAY_AGG(summary ORDER BY occurred_at DESC))[1] AS example,
            (ARRAY_AGG(story_id  ORDER BY occurred_at DESC))[1] AS example_story,
            (ARRAY_AGG(page_number ORDER BY occurred_at DESC))[1] AS example_page
       FROM failure_log
      WHERE occurred_at > NOW() - ($1 || ' hours')::interval
      GROUP BY kind, severity, fingerprint
      ORDER BY (severity = 'customer') DESC, occurrences DESC`,
    [String(hours)]
  );
  const customer = rows.filter(r => r.severity === 'customer');
  const internal = rows.filter(r => r.severity !== 'customer');
  return {
    hours,
    totals: {
      customer: customer.reduce((n, r) => n + r.occurrences, 0),
      internal: internal.reduce((n, r) => n + r.occurrences, 0),
      distinct: rows.length,
    },
    customer,
    internal,
  };
}

/** Plain-text block for the daily email. Empty string when nothing failed. */
function formatFailureReport(summary) {
  if (!summary || !summary.totals.distinct) return '';
  const { ch } = require('../../scripts/lib/chTime');
  const line = (r) => `  ${String(r.occurrences).padStart(4)}×  ${r.kind}${r.fingerprint && r.fingerprint !== r.kind ? ` / ${r.fingerprint}` : ''}`
    + `\n        ${r.example}`
    + `\n        last ${ch(new Date(r.last_seen))}${r.example_story ? `, e.g. ${r.example_story}${r.example_page != null ? ` p${r.example_page}` : ''}` : ''}`;
  const out = [`FAILURES — last ${summary.hours}h (${summary.totals.customer} customer-visible, ${summary.totals.internal} internal)`];
  if (summary.customer.length) {
    out.push('', 'CUSTOMER-VISIBLE (someone was waiting on this):', ...summary.customer.map(line));
  }
  if (summary.internal.length) {
    out.push('', 'INTERNAL (degraded or recovered):', ...summary.internal.slice(0, 15).map(line));
    if (summary.internal.length > 15) out.push(`  … and ${summary.internal.length - 15} more kinds`);
  }
  return out.join('\n');
}

module.exports = { recordFailure, summariseFailures, formatFailureReport, sanitizeDetail };
