-- Story metrics framework (docs/plans/story-stats-page.md).
-- One row per completed non-test story: extracted scores (A), change-magnitude
-- metrics (B), runtime counters (C), judge scores (D, nullable until judges ship).
-- Written by server/lib/storyMetrics.js at job completion; backfilled by
-- scripts/admin/backfill-story-metrics.js. Rows are UPSERTed — re-collection is safe.

CREATE TABLE IF NOT EXISTS story_metrics (
  story_id VARCHAR(255) PRIMARY KEY,
  created_at TIMESTAMP,                -- story creation (UTC, naive — repo convention)
  collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  environment VARCHAR(32),             -- production | staging | local
  pipeline_mode VARCHAR(32),           -- beats | unified
  art_style VARCHAR(64),
  language VARCHAR(8),
  pages INTEGER,

  -- A: extracted scores
  duration_s INTEGER,
  cost_usd NUMERIC(10,4),
  mean_page_score NUMERIC(6,2),
  min_page_score NUMERIC(6,2),
  pages_below_80 INTEGER,
  findings_by_category JSONB,
  repair_rate NUMERIC(5,4),
  versions_per_page_mean NUMERIC(6,2),
  consistency_mean NUMERIC(6,2),
  outline_fix_count INTEGER,
  outline_fixes_by_category JSONB,
  cover_scores JSONB,
  avatar_fallback_count INTEGER,

  -- B: change magnitude ("tiny touch vs complete redo")
  text_churn_pct NUMERIC(5,2),
  scene_churn_pct NUMERIC(5,2),
  beats_churn_pct NUMERIC(5,2),
  repair_delta_mean NUMERIC(6,2),
  repair_pixel_change_pct NUMERIC(5,2),

  -- C: runtime counters (flushed from stories.data.runMetrics)
  counters JSONB,

  -- D: judge scores (NULL until judges are enabled)
  title_score NUMERIC(5,2),
  text_score NUMERIC(5,2),

  detail JSONB
);

CREATE INDEX IF NOT EXISTS idx_story_metrics_created ON story_metrics (created_at);
CREATE INDEX IF NOT EXISTS idx_story_metrics_env_created ON story_metrics (environment, created_at);
