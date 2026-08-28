-- How CLOSE the shot is, which decides whether a scene can happen at the place.
--
-- draw_score says the place is worth using and photo_score says the picture is
-- good, but neither says whether a child fits in the frame. Most stories put
-- the action AT the landmark — inside the castle courtyard, on the bridge — and
-- for that the building has to fill the frame with room around it. A technically
-- excellent photograph of a castle as a speck on a distant ridge scores well on
-- both existing axes and is still unusable for the scene the story wants.
--
-- A few stories do want the far view (arriving, seeing it from the valley), so
-- wide and aerial shots are kept and ranked below, never discarded.
--
--   medium  — the place fills most of the frame, you could stand there. BEST.
--   closeup — a detail fills the frame: a doorway, a carving, one tower.
--   wide    — the place sits small inside a landscape.
--   aerial  — from above or very far; reads like a map.
--   interior— inside the building.
ALTER TABLE landmark_photo_scores ADD COLUMN IF NOT EXISTS framing VARCHAR(16);

-- Selection reads "best usable photo for a scene at this place", so framing
-- participates in the lookup alongside the score.
CREATE INDEX IF NOT EXISTS idx_landmark_photo_scores_framing
  ON landmark_photo_scores (landmark_id, framing, photo_score DESC);
