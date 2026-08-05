-- Generic Test Lab sets — supersede the avatar-only avatar_sheet_sets (migration
-- 010) with one stage-typed mechanism usable by ANY stage (avatar_eval,
-- char_repair, cover, image, …). A set has a name + stage + default params;
-- each member stores that stage's target (storyId + page / character / coverType)
-- and per-member params. "Run set" fires ONE experiment of the set's stage over
-- every member, merging {set.params, member.params}.
--
-- Drops the earlier per-stage tables (avatar_sheet_sets; and title_sets if a
-- reverted draft left them behind) so all envs converge on the generic tables.

DROP TABLE IF EXISTS avatar_sheet_set_members;
DROP TABLE IF EXISTS avatar_sheet_sets;
DROP TABLE IF EXISTS title_set_members;
DROP TABLE IF EXISTS title_sets;

CREATE TABLE IF NOT EXISTS testlab_sets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  stage VARCHAR(50) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (name, stage)
);

CREATE TABLE IF NOT EXISTS testlab_set_members (
  id SERIAL PRIMARY KEY,
  set_id INTEGER NOT NULL REFERENCES testlab_sets(id) ON DELETE CASCADE,
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_key TEXT NOT NULL,
  label TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (set_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_testlab_set_members_set ON testlab_set_members(set_id);
