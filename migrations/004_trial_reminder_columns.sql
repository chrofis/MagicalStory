-- Trial reminder email tracking.
--
-- Two separate timestamps so we can tell which reminder went out and
-- avoid double-sending either one. Day-5 fires 5 days after trial
-- signup; day-25 fires 5 days before claim_token_expires.
--
-- See server/lib/trialReminders.js (the sweep) and email.js
-- (sendTrialReminderEmail).

ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_5d_sent_at  TIMESTAMP NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_25d_sent_at TIMESTAMP NULL;
