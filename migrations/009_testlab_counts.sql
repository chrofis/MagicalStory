-- Test Lab experiment list: stop detoasting `results` just to count it.
--
-- The list endpoint selected metadata only, but computed
--   jsonb_array_length(results) AS done_count
-- and jsonb_array_length() has to detoast the WHOLE jsonb value to count its
-- elements. `results` averages ~50 kB per experiment with one row at 12 MB, so
-- a 100-row list pulled ~17 MB off disk — on every poll while an experiment
-- runs. That is the read volume filling the page cache Railway bills as memory
-- (staging Postgres sat at 1.21 GB against production's 0.24 GB with a SMALLER
-- database), and it is also why the list felt slow.
--
-- Keeping the counts as plain integers means the list touches only the small
-- fixed-width columns and never the TOAST table at all.

ALTER TABLE testlab_experiments
  ADD COLUMN IF NOT EXISTS target_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS results_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from the existing jsonb. This detoasts every row once, which is
-- exactly what we are removing from the hot path — one-off is fine.
UPDATE testlab_experiments
   SET target_count  = COALESCE(jsonb_array_length(targets), 0),
       results_count = COALESCE(jsonb_array_length(results), 0)
 WHERE target_count = 0 AND results_count = 0;

-- No index needed: idx_testlab_experiments_created is already
-- btree (created_at DESC), which serves both the ORDER BY and the new
-- created_at window filter. An earlier draft of this migration added a second
-- identical index — duplicates cost write time and disk and buy nothing.
