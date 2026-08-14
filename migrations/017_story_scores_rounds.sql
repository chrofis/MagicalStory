-- Redesigned scores page: round tracking, drill-down data, versioned-prompt archive.
-- Additive to 016_story_scores.sql. Idempotent.

ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS notes         TEXT;          -- judge's per-artifact feedback (click a score → this)
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS artifact_text TEXT;          -- the exact text the judge read (click a part → this), frozen at score time
ALTER TABLE story_scores ADD COLUMN IF NOT EXISTS round         INT NOT NULL DEFAULT 1;  -- review/refine pass: 1 = as generated, N = after N-1 passes

-- Recoverable judge prompt per evaluator version (click a version → its prompt).
CREATE TABLE IF NOT EXISTS eval_versions (
  version     TEXT PRIMARY KEY,
  hash        TEXT,
  prompt_text TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- final = max(round) per (story, part, model, version) — computed at display; this
-- index serves both that grouping and the per-row round-increment subquery.
CREATE INDEX IF NOT EXISTS idx_story_scores_rounds ON story_scores (story_id, artifact, model, eval_version, round DESC);
