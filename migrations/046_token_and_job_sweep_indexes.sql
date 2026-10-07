-- 046: partial indexes for the three users token lookups and a composite index for the
-- story_jobs sweeps (DB review 2026-10-07).
--
-- WHY. /api/auth/verify-email/:token, the password-reset route and the trial claim route
-- each look a user up by a token column that is NULL on nearly every row; without an
-- index each lookup is a seq scan of users. A partial index covers only the rows that
-- hold a token, so it stays a few KB. story_jobs is swept by status + updated_at
-- (cleanupOldCompletedJobs, the stall sweeper, the status watchdog) and only had a
-- single-column status index.
--
-- Plain CREATE INDEX (no concurrent build): migrate.js runs each file in a transaction, and
-- users / story_jobs are small enough that the lock is a moment. Idempotent.

CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users (email_verification_token) WHERE email_verification_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token
  ON users (password_reset_token) WHERE password_reset_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_claim_token
  ON users (claim_token) WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_story_jobs_status_updated_at
  ON story_jobs (status, updated_at);
