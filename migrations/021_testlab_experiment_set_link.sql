-- Link an experiment back to the SET it was run from.
--
-- Without this the only connection is the auto-generated label ("Set: Hard to
-- segment (6)"), and that label is overwritten the moment a run is given a
-- custom one — which is what every iteration does. Three months later the
-- question "where is the run that shows this working?" has no answer short of
-- remembering an experiment number.
--
-- The SET is the durable handle: it names the cases, survives every rerun, and
-- grows when a new failing page is pinned to it. This column makes its run
-- history reachable from it.
ALTER TABLE testlab_experiments ADD COLUMN IF NOT EXISTS set_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_testlab_experiments_set ON testlab_experiments (set_id, created_at DESC);
