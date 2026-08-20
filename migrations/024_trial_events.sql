-- Per-step trial funnel events: exactly how far a visitor gets in /try.
--
-- WHY: before this table the trial funnel had two measurable ends and a blind
-- middle. GA4 fired `trial_landing` on /try mount and `trial_completed` at the
-- end; server-side we had trial_daily_stats (avatars/stories per day, a cap
-- counter) and getTrialFunnel() (post-story: claimed, logged in, multi-story).
-- Nothing recorded the intro screen, the consent tick, the photo upload, the
-- face-selection modal or the character form — which is precisely where the
-- 2026-06-17 cross-browser probe located the friction. 79 paid clicks in June
-- produced 0 trial conversions and we could not say at which click they left.
--
-- Server-side rather than GA4-only, deliberately: GA4 is lost to ad blockers
-- and consent denial exactly among the bouncing visitors we most need to count,
-- and its events cannot be joined to the users/stories rows.
--
-- visit_id is minted client-side (crypto.randomUUID, localStorage) on /try load,
-- long before an anonymous account exists. user_id is back-filled onto the
-- visit's rows once create-anonymous-account returns, which is what joins the
-- pre-account trail to the real user and their story.
--
-- created_at is TIMESTAMPTZ deliberately — naive TIMESTAMP columns are parsed by
-- node-pg as LOCAL time and have caused real damage in this repo (two live Test
-- Lab runs reaped by bad age arithmetic). See migrations/022_failure_log.sql.
CREATE TABLE IF NOT EXISTS trial_events (
  id           BIGSERIAL PRIMARY KEY,
  visit_id     UUID NOT NULL,
  -- A stable slug from the whitelist in server/routes/trial.js (TRIAL_FUNNEL_STEPS).
  -- Never free text: the funnel groups on it.
  step         VARCHAR(40) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Landing attribution, captured from the URL on the first ('landing') event and
  -- carried by the client on every later event of the same visit. This is what
  -- lets the funnel answer "how far do PAID visitors get" specifically.
  utm_source   VARCHAR(60),
  utm_medium   VARCHAR(60),
  utm_campaign VARCHAR(80),
  referrer     TEXT,
  language     VARCHAR(10),
  device       VARCHAR(20),
  -- Back-filled at character_saved; NULL for visits that quit before the account.
  user_id      VARCHAR(100),
  -- Small, bounded context only (never image bytes — the iron rule).
  meta         JSONB
);

-- One row per step per visit. Re-entering a step (back button, remount, a retried
-- photo upload) must not inflate that step's count, so the insert is
-- ON CONFLICT DO NOTHING against this index rather than deduped at read time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_events_visit_step ON trial_events (visit_id, step);

-- The two queries that exist: "the funnel over the last N days" and
-- "the whole trail for this one visit".
CREATE INDEX IF NOT EXISTS idx_trial_events_recent ON trial_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trial_events_visit ON trial_events (visit_id, created_at);
