-- Model-comparison scores: one row per (story × part × generating-model × evaluator-version).
-- Populated by the story_scorecard stage, the replay stages' scoreOutput, the
-- beats_review_replay stage, the CLI, and the auto-score hook. The live
-- /admin/scorecards page pivots this table (rows = story/part, cols = model).
CREATE TABLE IF NOT EXISTS story_scores (
  id             BIGSERIAL PRIMARY KEY,
  story_id       VARCHAR(80) NOT NULL,
  title          TEXT,
  language       VARCHAR(16),
  art_style      VARCHAR(40),
  -- which PART was scored: 'full' | 'beats' | 'scene' | 'storyText' | 'visualBible'
  artifact       VARCHAR(24) NOT NULL,
  -- the model that GENERATED/reran this part (what you compare across)
  model          VARCHAR(80),
  judge_model    VARCHAR(80),
  eval_version   VARCHAR(16) NOT NULL,
  eval_hash      VARCHAR(24),
  score          NUMERIC(4,1),          -- this part's score (for 'full' = overall)
  dims           JSONB,                  -- per-dimension + notes (+ per-artifact for 'full')
  source         VARCHAR(40),            -- story_scorecard | beats_review_replay | *_replay | cli | auto
  label          TEXT,                   -- optional A/B label (e.g. prompt variant, pass N)
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_story_scores_story ON story_scores (story_id);
CREATE INDEX IF NOT EXISTS idx_story_scores_lookup ON story_scores (story_id, artifact, model, eval_version);
CREATE INDEX IF NOT EXISTS idx_story_scores_recent ON story_scores (created_at DESC);
