-- Admin drafts: a story generated FOR a user, invisible to them until published.
--
-- Lets one persistent account per family be reused for smoke runs, showcases and
-- "regenerate until it's good" instead of a fresh dummy account per attempt, and
-- keeps every Miller story together on the Miller account.
--
-- Set when the story is created while an admin is impersonating the owner
-- (server/routes/jobs.js). Cleared by POST /api/admin/stories/:id/publish.
-- Existing stories are all published by definition, which is what the DEFAULT
-- false backfill gives us.

ALTER TABLE stories ADD COLUMN IF NOT EXISTS admin_draft BOOLEAN NOT NULL DEFAULT false;

-- Every owner-facing read filters on (user_id, admin_draft); the admin views
-- select drafts across users.
CREATE INDEX IF NOT EXISTS idx_stories_user_draft ON stories (user_id, admin_draft);
CREATE INDEX IF NOT EXISTS idx_stories_admin_draft ON stories (admin_draft) WHERE admin_draft = true;
