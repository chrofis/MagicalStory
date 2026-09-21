/**
 * EMAIL SEND RECORDS + RESEND EVENT INGEST.
 *
 * WHY THIS EXISTS (owner, 2026-09-21): every email this product sends was
 * fire-and-forget. email.js called resend.emails.send(), printed the returned
 * message id to stdout, and threw it away. There was no email_sends table, no
 * tags on any outgoing send, and no Resend webhook — so "did the story-complete
 * mail reach this customer, and did they open it" was unanswerable from
 * anything but Railway log scrollback, which rotates. See migrations/040.
 *
 * Two deliberate differences from the telemetry modules this file is otherwise
 * modelled on (server/lib/ideaEvents.js, server/lib/failureLog.js):
 *
 *   1. The insert IS awaited. Those modules describe a customer request that is
 *      still in flight and must never be slowed by telemetry. An email send is
 *      already off the request path, and here the record is the deliverable —
 *      a send whose row is missing is exactly the blind spot being closed.
 *
 *   2. A failed RECORD never fails the SEND, and never retries it. The mail is
 *      already gone; throwing here would, at several call sites, be caught as
 *      "send failed" and produce a duplicate mail to a real customer. So a
 *      record failure is logged at error level — loudly, per CLAUDE.md — and
 *      the send result is returned untouched. That is not a fallback path: the
 *      send has exactly one implementation and there is no second one.
 *
 * Correlation is by Resend message id (data.email_id on every email.* webhook
 * payload), never by tags. Tags are attached to outgoing sends so the Resend
 * dashboard can be sliced by type/story, but an id equality join is exact and
 * a tag match is not.
 */

'use strict';

const { log } = require('../utils/logger');

/** Resend rejects a tag name/value containing anything but these. */
const TAG_SAFE = /[^A-Za-z0-9_-]/g;

/** Events Resend can deliver for an email. Anything else is stored, not mapped. */
const EMAIL_EVENT_TYPES = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.complained',
  'email.bounced',
  'email.opened',
  'email.clicked',
  'email.failed',
]);

/**
 * Which event moves email_sends.status, and to what. 'opened' and 'clicked'
 * are deliberately absent: an open does not change what happened to the
 * message, it is a rollup. Ordering is enforced so a late-arriving
 * 'email.sent' cannot demote a row that already bounced.
 */
const STATUS_RANK = {
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  complained: 4,
  bounced: 5,
  failed: 6,
  send_failed: 7,
};

function _env() {
  return process.env.RAILWAY_ENVIRONMENT_NAME || 'local';
}

/** Trim to a column's width, or NULL for empty. */
function _trim(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function _pool() {
  const { getPool } = require('../services/database');
  return (getPool && getPool()) || null;
}

/**
 * Resend tag values accept only [A-Za-z0-9_-] and are capped at 256 chars.
 * A value that sanitises to nothing yields null, and a null tag is dropped
 * rather than sent as an empty string — Resend rejects the whole send on an
 * invalid tag, which would turn telemetry into an outage.
 */
function sanitizeTagValue(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(TAG_SAFE, '_').slice(0, 256);
  return s.replace(/^_+|_+$/g, '') ? s : null;
}

/**
 * The tags every outgoing send carries. Correlation does not depend on them
 * (see the header) — they exist so the Resend dashboard can be filtered.
 * @param {{emailType: string, storyId?: string, userId?: string, environment?: string}} meta
 */
function buildTags(meta = {}) {
  const candidates = [
    ['email_type', meta.emailType],
    ['environment', meta.environment || _env()],
    ['story_id', meta.storyId],
    ['user_id', meta.userId],
  ];
  const tags = [];
  for (const [name, raw] of candidates) {
    const value = sanitizeTagValue(raw);
    if (value) tags.push({ name, value });
  }
  return tags;
}

/**
 * Persist one send. Returns the new row id, or null if it could not be written.
 */
async function recordEmailSend(row = {}) {
  const pool = _pool();
  if (!pool) {
    log.error('❌ [EMAIL SENDS] no database pool — send not recorded');
    return null;
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO email_sends
         (environment, email_type, recipient, subject, language,
          story_id, user_id, resend_message_id, status, error_message, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (resend_message_id) DO NOTHING
       RETURNING id`,
      [
        _env(),
        _trim(row.emailType, 60) || 'unknown',
        _trim(row.recipient, 320) || 'unknown',
        row.subject == null ? null : String(row.subject),
        _trim(row.language, 20),
        _trim(row.storyId, 100),
        _trim(row.userId, 100),
        _trim(row.resendMessageId, 100),
        _trim(row.status, 30) || 'sent',
        row.errorMessage == null ? null : String(row.errorMessage),
        row.detail == null ? null : JSON.stringify(row.detail),
      ]
    );
    return rows[0] ? rows[0].id : null;
  } catch (err) {
    log.error(`❌ [EMAIL SENDS] could not record ${row.emailType} to ${row.recipient}: ${err.message}`);
    return null;
  }
}

/**
 * Send one email through Resend AND record it. Every send site in email.js
 * goes through here; resend.emails.send is not called directly anywhere else.
 *
 * Returns Resend's own { data, error } verbatim so call sites keep their
 * existing error handling.
 *
 * @param {object} resend      an initialised Resend client
 * @param {string} emailType   stable slug, e.g. 'story-complete'
 * @param {object} payload     the Resend send payload (from/to/subject/…)
 * @param {object} [meta]      {storyId, userId, language, detail}
 */
async function sendTracked(resend, emailType, payload, meta = {}) {
  if (!resend) throw new Error('sendTracked called without a Resend client');
  if (!emailType) throw new Error('sendTracked called without an email type');

  const tags = buildTags({ emailType, storyId: meta.storyId, userId: meta.userId });
  // Additive: a caller that already set tags keeps them.
  const withTags = { ...payload, tags: [...(payload.tags || []), ...tags] };

  const recipient = Array.isArray(payload.to) ? payload.to[0] : payload.to;
  const detail = { ...(meta.detail || {}) };
  if (payload.attachments && payload.attachments.length) detail.attachments = payload.attachments.length;
  if (Array.isArray(payload.to) && payload.to.length > 1) detail.recipients = payload.to.length;

  const base = {
    emailType,
    recipient,
    subject: payload.subject,
    language: meta.language,
    storyId: meta.storyId,
    userId: meta.userId,
    detail,
  };

  let result;
  try {
    result = await resend.emails.send(withTags);
  } catch (err) {
    await recordEmailSend({ ...base, status: 'send_failed', errorMessage: err.message });
    throw err;
  }

  const data = result && result.data;
  const error = result && result.error;
  if (error) {
    await recordEmailSend({
      ...base,
      status: 'send_failed',
      errorMessage: typeof error === 'string' ? error : (error.message || JSON.stringify(error)),
    });
  } else {
    await recordEmailSend({ ...base, status: 'sent', resendMessageId: data && data.id });
  }
  return result;
}

/**
 * Ingest one VERIFIED Resend webhook delivery.
 *
 * Idempotency is the UNIQUE svix_id: Svix retries a delivery until it receives
 * a 2xx, and a retry must not double an open count. The INSERT … ON CONFLICT
 * DO NOTHING … RETURNING id returns no row on a replay, and the rollup update
 * is skipped on that path — so replaying the same delivery is a no-op.
 *
 * @param {{svixId: string, body: object}} args  body = the verified payload
 * @returns {Promise<{stored: boolean, duplicate: boolean, eventType: string}>}
 */
async function recordEmailEvent(args = {}) {
  const { svixId, body } = args;
  const pool = _pool();
  if (!pool) throw new Error('recordEmailEvent: no database pool');
  if (!body || typeof body !== 'object') throw new Error('recordEmailEvent: no payload');

  const eventType = _trim(body.type, 60);
  if (!eventType) throw new Error('recordEmailEvent: payload has no type');

  const data = body.data || {};
  const messageId = _trim(data.email_id, 100);
  const recipient = Array.isArray(data.to) ? _trim(data.to[0], 320) : _trim(data.to, 320);
  const occurredAt = body.created_at || data.created_at || null;
  // email.clicked carries the link under data.click.link.
  const linkUrl = data.click && data.click.link ? String(data.click.link) : null;

  const ins = await pool.query(
    `INSERT INTO email_events
       (svix_id, event_type, occurred_at, resend_message_id, send_id, recipient, link_url, payload)
     VALUES ($1,$2,$3,$4::varchar,
             (SELECT id FROM email_sends WHERE resend_message_id = $4::varchar),
             $5,$6,$7)
     ON CONFLICT (svix_id) DO NOTHING
     RETURNING id`,
    [_trim(svixId, 120), eventType, occurredAt, messageId, recipient, linkUrl, JSON.stringify(body)]
  );

  if (ins.rows.length === 0) {
    return { stored: false, duplicate: true, eventType };
  }

  if (messageId && EMAIL_EVENT_TYPES.has(eventType)) {
    await applyRollup(pool, eventType, messageId, occurredAt);
  }
  return { stored: true, duplicate: false, eventType };
}

/**
 * Move the send row's rollups for one event. Status only ever moves FORWARD
 * (STATUS_RANK), so an 'email.sent' that arrives after an 'email.bounced' —
 * which happens, webhook order is not guaranteed — cannot un-bounce the row.
 */
async function applyRollup(pool, eventType, messageId, occurredAt) {
  const ts = occurredAt || new Date().toISOString();
  const short = eventType.replace(/^email\./, '');

  if (short === 'opened') {
    await pool.query(
      `UPDATE email_sends
          SET open_count = open_count + 1,
              first_opened_at = COALESCE(first_opened_at, $2::timestamptz)
        WHERE resend_message_id = $1`,
      [messageId, ts]
    );
    return;
  }
  if (short === 'clicked') {
    await pool.query(
      `UPDATE email_sends
          SET click_count = click_count + 1,
              first_clicked_at = COALESCE(first_clicked_at, $2::timestamptz)
        WHERE resend_message_id = $1`,
      [messageId, ts]
    );
    return;
  }

  const rank = STATUS_RANK[short];
  if (!rank) return;
  await pool.query(
    `UPDATE email_sends
        SET status = $2::varchar,
            delivered_at = CASE WHEN $2::text = 'delivered'
                                THEN COALESCE(delivered_at, $3::timestamptz) ELSE delivered_at END,
            bounced_at   = CASE WHEN $2::text IN ('bounced','complained')
                                THEN COALESCE(bounced_at, $3::timestamptz) ELSE bounced_at END
      WHERE resend_message_id = $1
        AND COALESCE(($4::jsonb ->> status)::int, 0) < $5`,
    [messageId, short, ts, JSON.stringify(STATUS_RANK), rank]
  );
}

module.exports = {
  sendTracked,
  recordEmailSend,
  recordEmailEvent,
  buildTags,
  sanitizeTagValue,
  EMAIL_EVENT_TYPES,
  STATUS_RANK,
};
