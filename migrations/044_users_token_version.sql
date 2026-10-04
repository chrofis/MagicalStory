-- 044: users.token_version — server-side session revocation (owner decision 2026-10-04,
-- code review S1/S5).
--
-- WHY. A session JWT lived 7 days and nothing could revoke it: a password reset did not
-- log out an attacker who had pre-registered the victim's email (S1), and a demoted admin
-- kept admin rights until the token expired (S5). The JWT now carries the user's
-- token_version and authenticateToken compares it with this column (middleware/auth.js).
-- The column is bumped on password reset, password change, role change and a Google
-- sign-in that merges into an account whose email was never verified.
--
-- Existing tokens carry no version and count as 0, which is the default, so every live
-- session stays valid until the first bump. Idempotent; safe to run on a populated table.

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
