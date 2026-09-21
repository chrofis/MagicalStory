-- 039: the idea funnel — what the wizard offered, and what the customer clicked.
--
-- WHY (owner, 2026-09-21). The story-idea quality series (docs/decisions.md,
-- "Story-idea premise contract: five rating rounds…") spent eight rounds
-- optimising a RATER's proxy for "would a parent buy this", and a blind re-rate
-- showed the proxy is unreliable: the same premise scored 3.4 and 4.3 depending
-- on which round it was shown in. The real signal was already happening in
-- production and was not recorded anywhere — the customer sees two ideas, and
-- either picks one or presses regenerate. A pick is a buy vote; a regeneration
-- is a rejection of BOTH arms.
--
-- Nothing recorded any of it before this table. What existed:
--   - stories.idea_source / idea_original / idea_used (migration 027) — the
--     provenance of a story that WAS created. It cannot see a regeneration,
--     because a regenerated-away idea never becomes a story.
--   - stories.data.ideaWorld — the world of the chosen arm, but not WHICH arm,
--     and not the premise shape it was built on.
--   - trial_events (migration 024) — has 'ideas_generated' and 'idea_selected',
--     but it is visit-scoped with a UNIQUE (visit_id, step) index, so it records
--     at most ONE idea generation per visit by construction. It cannot count
--     regenerations, and it does not cover the authenticated wizard at all.
-- There is no generic `activity_log` table in this database despite CLAUDE.md
-- naming one; the two event logs that exist are trial_events and failure_log,
-- and neither can hold this. Hence a table.
--
-- occurred_at is TIMESTAMPTZ deliberately — naive TIMESTAMP columns are parsed
-- by node-pg as LOCAL time and have caused real damage in this repo (two live
-- Test Lab runs reaped by bad age arithmetic). See migrations/022_failure_log.sql.
--
-- Columns for everything the funnel groups by, JSONB only for the per-arm
-- detail (two worlds, two shapes) that has no fixed width. NEVER image bytes.
CREATE TABLE IF NOT EXISTS idea_events (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment   VARCHAR(32),
  -- Stable slug, never free text: 'idea_generated' | 'idea_picked'.
  event         VARCHAR(40) NOT NULL,
  user_id       VARCHAR(100),
  -- idea_picked only: the job/story the pick turned into.
  story_id      VARCHAR(100),

  -- The request shape. These are what a pick rate is sliced by.
  category      VARCHAR(60),
  topic         VARCHAR(120),
  theme         VARCHAR(120),
  language      VARCHAR(10),
  pages         INTEGER,
  cast_size     INTEGER,
  youngest_age  INTEGER,
  world_mode    VARCHAR(20),

  -- 1 = the first ideas this wizard session asked for; >1 = a regeneration,
  -- i.e. the customer looked at the previous pair and rejected BOTH.
  attempt       INTEGER,
  regenerated   BOOLEAN,

  -- idea_picked: which card was clicked (0 or 1). NULL = the customer wrote or
  -- pasted their own premise, which is its own verdict on the pair.
  arm_index     INTEGER,
  -- idea_generated: both arms, in order. idea_picked: the chosen one.
  --   worlds -> ['location','fantasy'] | {world,theme,location}
  --   shapes -> [{id,name}, {id,name}] | {id,name}
  worlds        JSONB,
  shapes        JSONB,

  model         VARCHAR(80),
  cost_usd      NUMERIC(10,6),
  -- Small bounded context only (tokens, streaming flag). Never image bytes.
  detail        JSONB
);

-- The two queries that exist: "the funnel over a date range" and "this event
-- kind over a date range".
CREATE INDEX IF NOT EXISTS idx_idea_events_recent ON idea_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_idea_events_kind   ON idea_events (event, occurred_at DESC);
