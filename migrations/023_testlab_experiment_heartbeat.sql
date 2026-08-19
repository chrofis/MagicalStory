-- Test Lab experiment heartbeat — so a dead run stops blocking every push.
--
-- WHY: experiments run as an in-process loop with no story_jobs row. A container
-- restart (deploy, Railway idle-shutdown, crash) kills the loop and leaves
-- status='running' forever. The idleShutdown busy probe counts those rows, so
-- GET /api/health/busy reports busy and the pre-push hook refuses EVERY push —
-- to staging AND production — until a 2-hour bound expires.
--
-- Observed 2026-08-19: experiment 747 (story_scorecard, 1 target, 0 results) sat
-- 'running' for over an hour and blocked all pushes, while a LATER experiment
-- started and completed normally around it — which is what proved it was dead.
--
-- The 2h bound was the only defence and it is both too slow (an hour of blocked
-- pushes) and unsound (a genuine 2h+ run gets reaped out from under itself).
-- A heartbeat answers the real question — is a process still working on this? —
-- in seconds instead of hours, and never reaps a live run however long it takes.
--
-- Nullable, so rows written before this migration keep working: readers treat a
-- NULL heartbeat as "fall back to created_at", which is the old behaviour.

ALTER TABLE testlab_experiments ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMP;

-- The busy probe and the reaper both filter on (status, heartbeat_at).
CREATE INDEX IF NOT EXISTS idx_testlab_experiments_running
  ON testlab_experiments (status, heartbeat_at)
  WHERE status = 'running';
