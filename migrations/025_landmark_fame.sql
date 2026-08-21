-- Wikipedia fame signals for landmark selection.
--
-- WHY: landmark_index.score is dominated by type-based boost_amount (+100 for
-- Church/Tower/Bridge), which is anti-correlated with actual fame. Measured:
-- Zürich Hauptbahnhof (score 85, sitelinks 33) ranks below Zunfthaus zur Haue
-- (score 135, sitelinks 4). Grossmünster (score 0, sitelinks 30) ranks 599 of
-- 600 candidates in Zurich. Adding Wikipedia sitelinks and pageviews lets the
-- story writer's landmark picker (ORDER BY score DESC LIMIT 30) see the most
-- famous sites first without changing score or breaking live story behaviour.
--
-- These columns are nullable and additive only. Score-based selection is
-- untouched; fame_* is purely observational until consumed by the UI or a
-- new query path.
--
ALTER TABLE landmark_index
  ADD COLUMN IF NOT EXISTS fame_sitelinks INTEGER,
  ADD COLUMN IF NOT EXISTS fame_pageviews INTEGER,
  ADD COLUMN IF NOT EXISTS fame_updated_at TIMESTAMP;

COMMENT ON COLUMN landmark_index.fame_sitelinks IS 'Number of Wikipedia language editions (Wikidata sitelinks)';
COMMENT ON COLUMN landmark_index.fame_pageviews IS 'Monthly average pageviews, Wikimedia REST API';
COMMENT ON COLUMN landmark_index.fame_updated_at IS 'When fame_* was last backfilled';
