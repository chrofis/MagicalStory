-- Idea provenance: did the customer use OUR generated idea, edit it, or write
-- their own? (owner, 2026-08-25)
--
-- The question this answers: when a story comes out strange, was the premise
-- ours or theirs? A story built on our own idea has to be good; a story built
-- on a premise the customer introduced is a different conversation.
--
-- The wizard has always SENT the raw material (`ideaGeneration.output` +
-- `selectedIndex` on the create-story payload) but nothing persisted it —
-- server/routes/jobs.js only log.debug'd it, and story_jobs rows are pruned.
--
-- Columns, not JSONB, because the point is to answer this across the whole
-- table at a glance (owner's choice, 2026-08-25).
--
--   idea_source   'ours-unchanged' | 'ours-edited' | 'user-written' | NULL (pre-migration stories)
--   idea_original the generated idea the customer started from (NULL when they wrote their own)
--   idea_used     the idea the story was actually generated from
--
-- 'ours-edited' is decided by an EXACT string compare against the selected
-- idea (owner's choice): any difference at all counts as edited. No similarity
-- threshold — a typo fix and a rewrite both read as edited.

ALTER TABLE stories ADD COLUMN IF NOT EXISTS idea_source   VARCHAR(20);
ALTER TABLE stories ADD COLUMN IF NOT EXISTS idea_original TEXT;
ALTER TABLE stories ADD COLUMN IF NOT EXISTS idea_used     TEXT;

-- Partial index: the analytics question is always "which stories did the
-- customer change the idea on", never "list the NULLs".
CREATE INDEX IF NOT EXISTS idx_stories_idea_source
  ON stories (idea_source)
  WHERE idea_source IS NOT NULL;
