-- Eval-findings STATS SINK — one row per merged eval BUCKET-hit per page,
-- flattened so "what goes wrong per art style / per genre" is a plain GROUP BY.
--
-- WHY A NEW NAME. Two different things in this repo were both called
-- `eval_findings`:
--   1. The Lab's eval-findings REGISTRY (migrations/013_eval_findings.sql) —
--      curated, hand-authored rules: slug / title / category / rationale /
--      evidence. That is the name the CLAUDE.md contract refers to, and it
--      keeps the name.
--   2. This per-page statistics sink (story_id / page_number / bucket /
--      severity / …), declared only inside `initializeDatabase()` in
--      server/services/database.js — a function that has not been on the boot
--      path since server.js:1608 (`REMOVED_initializeDatabase_DEAD`). So this
--      table was NEVER CREATED in any environment.
--
-- Consequence, measured 2026-09-14: migration 013 owns the name in both
-- staging and production, so every INSERT from the stats writer targeted the
-- registry's schema and would fail on `column "story_id" does not exist`. The
-- writer probed once, disabled itself, and the sink recorded zero rows for its
-- entire lifetime. The registry is untouched by this file.
--
-- No FK on story_id: eval runs for trials and can run before the story row is
-- persisted.

CREATE TABLE IF NOT EXISTS eval_finding_stats (
  id SERIAL PRIMARY KEY,
  story_id VARCHAR(255),
  page_number INT,
  bucket VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  owner VARCHAR(20),
  agreement VARCHAR(10),
  eval_type VARCHAR(20),
  art_style VARCHAR(60),
  genre VARCHAR(60),
  language VARCHAR(10),
  char_count INT,
  judges VARCHAR(120),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eval_finding_stats_style_bucket ON eval_finding_stats(art_style, bucket);
CREATE INDEX IF NOT EXISTS idx_eval_finding_stats_story ON eval_finding_stats(story_id);
CREATE INDEX IF NOT EXISTS idx_eval_finding_stats_created ON eval_finding_stats(created_at);
