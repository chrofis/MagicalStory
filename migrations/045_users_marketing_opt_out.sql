-- 045: users.marketing_opt_out_at — the recipient said "no more reminders".
--
-- WHY (owner, 2026-10-07). The day-5 / day-25 trial reminders are promotional
-- mail (they sell the claim, not a thing the recipient asked for), and Swiss
-- UWG Art. 3 lit. o requires that such mail carries a working opt-out. There
-- was none: the only way to stop the sweep was to claim the account. The
-- unsubscribe link in every reminder (GET or one-click POST
-- /api/email/unsubscribe/:token, server/routes/email.js) stamps this column,
-- and server/lib/trialReminders.js selects only rows where it is NULL.
--
-- Transactional mail (verification, password reset, order, story complete)
-- is NOT gated on this column: it is owed to the recipient, not offered.
--
-- A timestamp rather than a boolean so the dashboard can say WHEN someone
-- opted out. TIMESTAMPTZ for the same reason as migrations 022/039/040.
-- Idempotent; safe to run on a populated table.

ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_out_at TIMESTAMPTZ;
