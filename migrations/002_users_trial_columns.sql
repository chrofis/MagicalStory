-- Add missing user columns that runtime code references but neither old
-- init function actually creates. Prod had these from hand-applied
-- migrations; fresh DBs (staging) didn't, so verify-email crashed with
-- "column is_trial does not exist" and returned the generic 500.
--
-- Each ADD COLUMN IF NOT EXISTS is a no-op on prod.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trial          BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_data        JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at  TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_set_password  BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid      VARCHAR(255);
