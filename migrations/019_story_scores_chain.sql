-- 019: persist the full review chain per scored round.
-- chain JSONB carries what produced this round's artifact: the reviewer's full
-- analysis (all checks), the exact per-page rewrites (before -> after), and the
-- prompt reference — so a score row explains itself without re-running anything.
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS chain JSONB;
