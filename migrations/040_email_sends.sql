-- 040: what we actually sent, and what the recipient did with it.
--
-- WHY (owner, 2026-09-21). Three blind spots were verified read-only before
-- this migration was written:
--   (a) no per-story view instrumentation anywhere;
--   (b) no persisted record of any email send — email.js printed the Resend
--       message id to stdout and threw it away, so "did the story-complete
--       mail go out" was answerable only from Railway log scrollback that
--       rotates;
--   (c) no open/click signal at all — no tracking pixel, no link wrapper, and
--       no Resend webhook endpoint (the only webhooks wired were Stripe and
--       Gelato).
-- (a) needs no table: the prod activity table `logs` already exists and
-- logActivity() is the house convention, so story views land there. (b) and
-- (c) need storage, which is this file.
--
-- TWO tables, not one. A send is a row we create; an event is something Resend
-- tells us later, arrives out of order, and can repeat (a recipient opens the
-- same mail five times). Folding them into one row would either lose the
-- per-event detail or force a read-modify-write race on every webhook. The
-- send row therefore carries cheap ROLLUPS (first_opened_at, open_count, …)
-- for the dashboard query, and email_events keeps the full history.
--
-- Correlation key is the Resend message id (`data.email_id` on every email.*
-- webhook payload), NOT the tags. Tags are set on outgoing sends as well, but
-- only as a human-readable slice in the Resend dashboard — an id equality join
-- is exact and a tag is not.
--
-- occurred_at / sent_at are TIMESTAMPTZ deliberately: naive TIMESTAMP columns
-- are parsed by node-pg as LOCAL time and have caused real damage in this repo
-- (two live Test Lab runs reaped by bad age arithmetic). Same call as
-- migrations/022_failure_log.sql and 039_idea_events.sql.

CREATE TABLE IF NOT EXISTS email_sends (
  id                BIGSERIAL PRIMARY KEY,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment       VARCHAR(32),

  -- Stable template/type slug, never free text: 'story-complete',
  -- 'trial-reminder', 'order-confirmation', 'admin-daily-summary', …
  email_type        VARCHAR(60) NOT NULL,
  recipient         VARCHAR(320) NOT NULL,
  subject           TEXT,
  language          VARCHAR(20),

  -- Where applicable. A password-reset mail has neither; a story-complete mail
  -- has both.
  story_id          VARCHAR(100),
  user_id           VARCHAR(100),

  -- The Resend message id. UNIQUE so the webhook join is unambiguous and a
  -- double-record of the same send is impossible. NULL only for a send that
  -- FAILED before Resend issued an id — those rows are kept on purpose: a mail
  -- that never went out is the most interesting row in the table.
  resend_message_id VARCHAR(100) UNIQUE,

  -- 'sent' the moment Resend accepted it; later moved by webhook events to
  -- 'delivered' | 'bounced' | 'complained' | 'delivery_delayed' | 'failed'.
  -- 'send_failed' means the API call itself errored (error_message says how).
  status            VARCHAR(30) NOT NULL DEFAULT 'sent',
  error_message     TEXT,

  -- Rollups maintained by the webhook ingest. The full history is in
  -- email_events; these exist so the dashboard needs no aggregate.
  delivered_at      TIMESTAMPTZ,
  first_opened_at   TIMESTAMPTZ,
  open_count        INTEGER NOT NULL DEFAULT 0,
  first_clicked_at  TIMESTAMPTZ,
  click_count       INTEGER NOT NULL DEFAULT 0,
  bounced_at        TIMESTAMPTZ,

  -- Small bounded context only (tag list, attachment flag). Never image bytes.
  detail            JSONB
);

CREATE INDEX IF NOT EXISTS idx_email_sends_recent    ON email_sends (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_type      ON email_sends (email_type, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_recipient ON email_sends (recipient, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_sends_story     ON email_sends (story_id) WHERE story_id IS NOT NULL;

-- One row per webhook delivery from Resend.
CREATE TABLE IF NOT EXISTS email_events (
  id                BIGSERIAL PRIMARY KEY,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Resend's own `created_at` for the event, which is NOT when we received it.
  occurred_at       TIMESTAMPTZ,

  -- Svix message id from the svix-id header. UNIQUE = the idempotency key:
  -- Svix retries a delivery until it gets a 2xx, and a retry must not double
  -- the open_count. ON CONFLICT DO NOTHING on this column is what makes the
  -- ingest safe to replay.
  svix_id           VARCHAR(120) UNIQUE,

  -- Resend event type verbatim: 'email.sent' | 'email.delivered' |
  -- 'email.delivery_delayed' | 'email.complained' | 'email.bounced' |
  -- 'email.opened' | 'email.clicked' | 'email.failed'.
  event_type        VARCHAR(60) NOT NULL,

  -- data.email_id. Not a foreign key on purpose: an event for a send this
  -- database never recorded (a mail sent from the Resend dashboard, or from
  -- the other environment sharing the same Resend account) must still be
  -- stored rather than rejected. send_id is filled in when the join succeeds.
  resend_message_id VARCHAR(100),
  send_id           BIGINT REFERENCES email_sends(id) ON DELETE SET NULL,

  recipient         VARCHAR(320),
  -- email.clicked only.
  link_url          TEXT,
  payload           JSONB
);

CREATE INDEX IF NOT EXISTS idx_email_events_recent  ON email_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_message ON email_events (resend_message_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_events_kind    ON email_events (event_type, received_at DESC);
