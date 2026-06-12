-- Deferred trial-completion email dedupe marker.
--
-- server/lib/trialEmail.js gates the deferred story-complete email on this
-- column. The feature (commit c97974fb) added the column to the DEAD inline
-- ensure-columns list in database.js initializeDatabase() — which migration
-- 001 replaced — so it never reached prod/staging. Every claim-triggered
-- trial email threw "column trial_completion_email_sent_at does not exist"
-- (observed in prod logs 2026-06-10). Applied manually to prod + staging on
-- 2026-06-13; this migration makes fresh environments consistent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_completion_email_sent_at TIMESTAMP;
