/**
 * Job heartbeat helper.
 *
 * Background: the `/api/jobs/:id/status` endpoint marks a job as failed when
 * `story_jobs.updated_at` has been stale for more than 5 minutes (heartbeat
 * timeout). The pipeline normally bumps `updated_at` whenever it writes a new
 * progress value — but during long synchronous phases (e.g. a 15-minute
 * Sonnet streaming response) no progress writes happen, so the row goes
 * stale and any concurrent frontend poll triggers a false-positive failure.
 *
 * `createJobHeartbeat()` returns a throttled function that callers fire from
 * inside their streaming chunk callback. It updates `updated_at` at most
 * once per `intervalMs` (default 30 s) — cheap, non-blocking, idempotent.
 *
 * Usage:
 *   const heartbeat = createJobHeartbeat(jobId, getDbPool());
 *   await callTextModelStreaming(prompt, maxTokens, (chunk, fullText) => {
 *     myParser.processChunk(chunk, fullText);
 *     heartbeat();  // throttled — fires at most every 30s
 *   });
 */

const { log } = require('../utils/logger');

const DEFAULT_INTERVAL_MS = 30 * 1000;

/**
 * @param {string} jobId - The story_jobs row id to heartbeat
 * @param {{ query: Function }} dbPool - PostgreSQL pool (injected so this
 *   module stays decoupled from the database service init order)
 * @param {number} [intervalMs] - Minimum gap between writes (default 30s)
 * @returns {() => Promise<void>} Throttled heartbeat function
 */
function createJobHeartbeat(jobId, dbPool, intervalMs = DEFAULT_INTERVAL_MS) {
  if (!jobId || !dbPool) {
    // No-op if we don't have what we need — caller should not crash on this.
    return async () => {};
  }

  let lastBeatAt = 0;
  let inFlight = false;

  return async function beat() {
    const now = Date.now();
    if (inFlight) return;
    if (now - lastBeatAt < intervalMs) return;
    lastBeatAt = now;
    inFlight = true;
    try {
      await dbPool.query(
        'UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [jobId]
      );
    } catch (err) {
      // Heartbeat failures are non-fatal — the worst case is the same false
      // positive we're trying to prevent. Log so we can see it if it happens.
      log.warn(`💓 [HEARTBEAT] Failed to update job ${jobId}: ${err.message}`);
    } finally {
      inFlight = false;
    }
  };
}

module.exports = { createJobHeartbeat };
