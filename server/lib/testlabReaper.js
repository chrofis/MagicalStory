/**
 * ORPHANED TEST LAB EXPERIMENTS — one reconciler, three callers.
 *
 * A Test Lab experiment is an in-process loop with a `status = 'running'` row
 * and a 30s heartbeat (routes/admin/testlab.js). The single-flight flag lives in
 * the process, so a container restart leaves the ROW saying 'running' forever
 * while nothing is running.
 *
 * Two readers then disagree, which is the bug this module closes:
 *   - the Test Lab UI lists the row as running;
 *   - the push gate's `/api/health/busy` probe counts only rows whose heartbeat
 *     is FRESH (5 minutes), so it stops seeing the row minutes after the death
 *     and reports the environment idle.
 * Measured 2026-09-11: experiments 1160 and 1163 sat at `status='running'` after
 * a deploy killed them, and `GET /api/health/busy` returned
 * `{"busy":false,"reasons":[]}`.
 *
 * Reaping used to live inline in `GET /experiments`, so it only ran when a human
 * opened the Test Lab — an orphan could outlive the restart by hours. It runs at
 * BOOT and inside the BUSY PROBE now, so the row is reconciled before anyone
 * asks, and the two readers cannot drift apart.
 *
 * The 5-minute freshness rule is NOT loosened. Widening it back to the old
 * blanket 2h is what held every push, staging and production, for an hour
 * (exp747, 2026-08-19). A live run beats every 30s; a quiet row is a dead row.
 * Rows predating the heartbeat column carry NULL and keep the 2h rule, so a
 * pre-migration run is never mistaken for dead.
 */
'use strict';

const { log } = require('../utils/logger');

/** Matches routes/admin/testlab.js — a live run beats every 30s. */
const HEARTBEAT_STALE = '5 minutes';

/**
 * Mark every 'running' row whose heartbeat has gone quiet as failed.
 *
 * Never throws: this runs at boot, and inside a probe whose exceptions count as
 * BUSY. A reaper that threw would pin the container up and block every push —
 * the exact failure the gate exists to prevent, but permanent.
 *
 * @param {string} reason  stored in `error`, so the row says why it ended
 * @returns {Promise<number>} rows reconciled (0 on any failure)
 */
async function reapOrphanedExperiments(reason = 'server restarted mid-run') {
  try {
    const { dbQuery } = require('../services/database');
    // to_regclass keeps a fresh DB with no table from throwing.
    const rows = await dbQuery(
      `UPDATE testlab_experiments SET status = 'failed', error = $1, completed_at = NOW()
        WHERE status = 'running'
          AND (heartbeat_at < NOW() - INTERVAL '${HEARTBEAT_STALE}'
            OR (heartbeat_at IS NULL AND created_at < NOW() - INTERVAL '2 hours'))
          AND to_regclass('public.testlab_experiments') IS NOT NULL
        RETURNING id`,
      [reason]
    );
    const n = Array.isArray(rows) ? rows.length : 0;
    if (n > 0) {
      log.warn(`🧹 [TESTLAB-REAP] ${n} orphaned experiment(s) marked failed (${reason}): ${rows.map(r => r.id).join(', ')}`);
    }
    return n;
  } catch (err) {
    // undefined_column (42703) = migrations/023 not applied here; anything else
    // is a real fault. Either way the caller carries on.
    log.warn(`[TESTLAB-REAP] reap skipped (${err.code || ''} ${err.message})`);
    return 0;
  }
}

/**
 * Rows that say 'running' but have not beaten inside the freshness window.
 *
 * The probe calls this AFTER reaping, so a non-zero answer means reconciliation
 * itself failed — the DB and the gate would otherwise silently disagree again.
 * Counting, never writing.
 *
 * @returns {Promise<number>} stale-but-running rows, 0 when the check cannot run
 */
async function countStaleRunning() {
  try {
    const { dbQuery } = require('../services/database');
    const r = await dbQuery(
      `SELECT COUNT(*)::int AS n FROM testlab_experiments
        WHERE status = 'running'
          AND (heartbeat_at < NOW() - INTERVAL '${HEARTBEAT_STALE}'
            OR (heartbeat_at IS NULL AND created_at < NOW() - INTERVAL '2 hours'))
          AND to_regclass('public.testlab_experiments') IS NOT NULL`
    );
    return r[0]?.n || 0;
  } catch {
    return 0;
  }
}

module.exports = { reapOrphanedExperiments, countStaleRunning, HEARTBEAT_STALE };
