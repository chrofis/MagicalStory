-- Per-IMAGE judging, split into independent components that are recomputed
-- into a ranking rather than baked into one verdict.
--
-- WHY PER IMAGE, NOT PER LANDMARK: story_score judged only photo_url, the
-- Wikipedia lead image, and only for the row that metadata already ranked top.
-- Both halves were wrong. "Top" was decided by fame_pageviews — the proxy that
-- puts a building site above a castle — so the castle was never looked at; and
-- a good landmark whose lead image is poor (Lenzburg, 35: a close crop of bare
-- wall) was rejected outright while four usable photos of it sat unjudged in
-- photo_url_2..6.
--
-- WHY TWO SCORES: a single number cannot express the three ways a candidate
-- fails, and they need different remedies.
--   draw_score  — is this PLACE a scene a small child can be in? The birthplace
--                 of a famous person is just a house; fame does not redeem it.
--                 Low draw_score means drop the landmark.
--   photo_score — does THIS PICTURE show the place well? A great castle shot
--                 from 2km in fog scores low here while draw_score stays high.
--                 Low photo_score means try another slot, not another landmark.
-- Fame stays where it is (fame_pageviews / fame_sitelinks) and breaks ties
-- between candidates that are already drawable — a bridge, a tower and a church
-- are all fine settings, so the famous one wins.
--
-- Storing the components means the ranking formula can be retuned later without
-- re-judging 16,907 images.
CREATE TABLE IF NOT EXISTS landmark_photo_scores (
  landmark_id  INTEGER NOT NULL REFERENCES landmark_index(id) ON DELETE CASCADE,
  -- 1 = photo_url, 2..6 = photo_url_2..photo_url_6
  slot         SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 6),
  draw_score   SMALLINT CHECK (draw_score BETWEEN 0 AND 100),
  photo_score  SMALLINT CHECK (photo_score BETWEEN 0 AND 100),
  reason       TEXT,
  judged_at    TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (landmark_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_landmark_photo_scores_landmark
  ON landmark_photo_scores (landmark_id);

-- Ranking reads "the best usable photo of this landmark", so the lookup is by
-- score, not by landmark.
CREATE INDEX IF NOT EXISTS idx_landmark_photo_scores_best
  ON landmark_photo_scores (landmark_id, photo_score DESC);
