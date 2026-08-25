-- How good a landmark is AS A SETTING IN A CHILDREN'S BOOK (2026-08-25).
--
-- WHY: every numeric proxy in the index ranks the wrong things. Measured on
-- Dübendorf's 30 rows:
--
--   fame_sitelinks   → A4 motorway (15), cyclocross championship (8), stations (6-7)
--   commons files    → Eawag institute (124), A4 motorway (115)
--   fame_pageviews   → Empa (1012), Eawag (511)
--   score            → parish churches in OTHER towns (135)
--
-- Lazariterkirche Gfenn — a medieval stepped-gable church in a meadow, and the
-- only genuinely storybook place in the town — sits at 18 Commons files, 2
-- sitelinks and score 130. Photo abundance measures how well DOCUMENTED a thing
-- is, not whether a small child would enjoy being there. A motorway is
-- extremely well documented.
--
-- LANDMARK_CLASS_SQL (landmarkPhotos.js) already filters junk well with its
-- backdrop allow-list; what it lacked was an ordering WITHIN class 2, where it
-- fell back to fame_sitelinks. `story_score` fills exactly that slot: 0-100,
-- judged from the landmark's own photo plus its name, type and Wikipedia
-- extract, by scripts/admin/score-landmarks-for-stories.js.
--
-- Nullable and additive: a NULL means "not judged yet" and the ranker falls
-- back to the previous behaviour, so nothing changes until a city is scored.

ALTER TABLE landmark_index
  ADD COLUMN IF NOT EXISTS story_score SMALLINT,
  ADD COLUMN IF NOT EXISTS story_score_reason TEXT,
  ADD COLUMN IF NOT EXISTS story_score_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_landmark_index_story_score
  ON landmark_index (story_score DESC)
  WHERE story_score IS NOT NULL;

COMMENT ON COLUMN landmark_index.story_score IS '0-100: how good this place is as a setting in a young child''s picture book. Judged from the photo + name + type + extract. NULL = not judged; ranker falls back to fame_sitelinks.';
