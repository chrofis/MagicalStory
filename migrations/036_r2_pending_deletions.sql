-- Pending R2 deletions — the recovery log for a prune that did not finish.
--
-- Why: a DB delete must never be blocked by R2 being down (a user's "delete my
-- story" has to succeed), so every prune call site deletes the row first and
-- prunes the bucket afterwards, best-effort. `r2.deleteByPrefix` /
-- `r2.deleteObject` log a failure and return a count rather than throwing, so
-- until now a failed prune was SILENT: the row was gone, nothing in the system
-- knew which keys it had owned, and the objects were unreachable forever
-- (that is what scripts/admin/delete-r2-dead-cohorts.js --report-only counts).
--
-- This table is the missing anchor. A prune that fails records the prefix (or
-- key) it was going to remove, and the daily housekeeping routine retries it.
-- The DB delete still wins; the failure is now RECORDED instead of lost.
--
-- kind: 'prefix' (deleteByPrefix, target ends with '/') | 'object' (one key).
-- A row is never deleted on success — `deleted_at` is stamped, so the table is
-- also the audit trail of every prune that had to be retried.
CREATE TABLE IF NOT EXISTS r2_pending_deletions (
  id              SERIAL PRIMARY KEY,
  kind            VARCHAR(10) NOT NULL,
  target          TEXT NOT NULL,
  reason          TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_attempt_at TIMESTAMP,
  deleted_at      TIMESTAMP
);

-- One OPEN row per target: re-recording the same failed prune bumps attempts
-- instead of piling up duplicates. Settled rows (deleted_at set) are exempt so
-- the history is kept.
CREATE UNIQUE INDEX IF NOT EXISTS idx_r2_pending_open
  ON r2_pending_deletions (kind, target)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_r2_pending_open_created
  ON r2_pending_deletions (created_at)
  WHERE deleted_at IS NULL;
