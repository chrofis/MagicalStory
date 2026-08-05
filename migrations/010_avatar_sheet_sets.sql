-- Avatar sheet sets (Test Lab)
--
-- Named, reusable collections of 2×4 avatar sheets to re-run avatar_eval over as
-- a batch (e.g. a "failed sheets" set). Mirrors benchmark_scenes but keyed by
-- (story, character, pass) instead of (story, page). Running a set fires ONE
-- avatar_eval experiment with every member as a target; each member carries its
-- own pass (1 = realistic anchor, 2 = styled sheet).

CREATE TABLE IF NOT EXISTS avatar_sheet_sets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_by VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS avatar_sheet_set_members (
  id SERIAL PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES avatar_sheet_sets(id) ON DELETE CASCADE,
  story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  character TEXT NOT NULL,
  pass INTEGER NOT NULL DEFAULT 1,
  entry_index INTEGER,
  label TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (set_id, story_id, character, pass)
);

CREATE INDEX IF NOT EXISTS idx_avatar_sheet_set_members_set ON avatar_sheet_set_members(set_id);
