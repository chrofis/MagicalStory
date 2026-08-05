-- Title sets (Test Lab)
--
-- Named, reusable collections of COVERS to re-run the cover title paint-in over
-- as a batch, so a new prompt / crop margin / recolour setting can be tested
-- against the SAME set of images instead of a fresh random pick each time.
-- Mirrors avatar_sheet_sets but keyed by (story, coverType) — a cover is one
-- image per story, so there is no page number.

CREATE TABLE IF NOT EXISTS title_sets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_by VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS title_set_members (
  id SERIAL PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES title_sets(id) ON DELETE CASCADE,
  story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  cover_type TEXT NOT NULL DEFAULT 'frontCover',
  label TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (set_id, story_id, cover_type)
);

CREATE INDEX IF NOT EXISTS idx_title_set_members_set ON title_set_members(set_id);
