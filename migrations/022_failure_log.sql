-- ONE place every failure lands, so the daily report is assembled from data
-- instead of from whoever happened to read Railway that morning.
--
-- WHY: a customer pressed "repair face", nothing happened, and the reason existed
-- only in a log line that had rolled out of the buffer by the time anyone asked.
-- That is one of hundreds of possible failures, and none of them were counted.
-- Railway's log window is hours; the question is asked days later.
--
-- This SUPERSEDES api_health_events, which recorded exactly one failure family
-- (provider 429/529 rate-limit and overload responses) in a shape that could not
-- describe any other: provider + HTTP status, no story, no page, no severity. A
-- rejected face repair has neither a provider nor a status. Rather than leave two
-- half-logs and grow a third, its rows move here as kind='provider_limit' and the
-- table goes. server/lib/apiHealth.js keeps its provider classification and its
-- isLimitError predicate — only the storage moves.
--
-- occurred_at is TIMESTAMPTZ deliberately. Naive TIMESTAMP columns in this repo
-- are parsed by node-pg as LOCAL time and have twice caused real damage (two live
-- Test Lab runs reaped by bad age arithmetic). With tz, age maths is safe here.
CREATE TABLE IF NOT EXISTS failure_log (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment   VARCHAR(32),
  -- What kind of failure: a stable slug, NOT free text, so 24h of rows group.
  kind          VARCHAR(64) NOT NULL,
  -- 'customer' = someone waiting on it saw nothing or saw it break.
  -- 'internal'  = degraded silently, recovered, or only we care.
  severity      VARCHAR(16) NOT NULL DEFAULT 'internal',
  -- Grouping key within a kind (e.g. the gate that rejected, or the provider).
  -- Normalised by the caller so "IoU 34%" and "IoU 51%" collapse into one line.
  fingerprint   VARCHAR(200),
  story_id      VARCHAR(100),
  page_number   INTEGER,
  character_name VARCHAR(100),
  user_id       UUID,
  summary       TEXT NOT NULL,
  -- Bounded context. NEVER image bytes (the iron rule) — recordFailure strips
  -- data URIs and truncates before writing.
  detail        JSONB
);

-- The two queries that exist: "what failed in the last 24h, grouped" and
-- "everything about this story".
CREATE INDEX IF NOT EXISTS idx_failure_log_recent ON failure_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_failure_log_kind ON failure_log (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_failure_log_story ON failure_log (story_id) WHERE story_id IS NOT NULL;

-- Carry the history over before the table goes, so the 24h/7d windows do not
-- develop a hole at the migration boundary.
INSERT INTO failure_log (occurred_at, kind, severity, fingerprint, summary, detail)
SELECT created_at,
       'provider_limit',
       'internal',
       COALESCE(provider, 'unknown'),
       COALESCE(message, 'provider limit'),
       jsonb_build_object('status', status, 'migratedFrom', 'api_health_events')
  FROM api_health_events
 WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_health_events');

DROP TABLE IF EXISTS api_health_events;
