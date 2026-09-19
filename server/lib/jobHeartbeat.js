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
const WHOLE_JOB_INTERVAL_MS = 60 * 1000;

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

/**
 * WHOLE-JOB liveness heartbeat.
 *
 * `createJobHeartbeat()` above is a PULL heartbeat: it only fires when the
 * caller calls it, so it covers a phase that emits chunks and nothing else.
 * The watchdog in `server/routes/jobs.js` (HEARTBEAT_TIMEOUT_MINUTES) kills a
 * job whose `updated_at` has been still for 10 minutes, and the pipeline has
 * repeatedly grown long phases with no natural write in them — Phase 5a image
 * generation (fixed 2026-08), then the whole post-generation tail after it
 * (missing-page retry, text regions, shared bbox detection on the separate
 * analyzer service, quality/semantic/entity evals, repair rounds). Each
 * incident was fixed by arming another phase-local interval, and the next
 * silent phase killed the next healthy run (job_1789506283204_3kxqshifx: an
 * 18-page run failed at 64% with all 18 pages and 3 covers already rendered).
 *
 * This is the PUSH heartbeat, and it is armed ONCE for the lifetime of the
 * job by the single worker entry point, so no phase can be outside it. It
 * writes only while the row is still `processing`, so it never touches a job
 * that has already reached a terminal state, and it is unref'd so it can
 * never hold the process open.
 *
 * What it deliberately does NOT prove: that the pipeline is making progress.
 * It proves the worker PROCESS is alive — which is exactly what the watchdog
 * is for (crash, container restart, wedged worker). The runaway backstop
 * (TOTAL_TIMEOUT_MINUTES) is what bounds a job that is alive but useless.
 *
 * @param {string} jobId
 * @param {{ query: Function }} dbPool
 * @param {number} [intervalMs] - default 60s (watchdog window is 10 min)
 * @returns {{ stop: () => void }} `stop()` is idempotent.
 */
function startJobHeartbeat(jobId, dbPool, intervalMs = WHOLE_JOB_INTERVAL_MS) {
  if (!jobId || !dbPool) return { stop() {} };

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    Promise.resolve(
      dbPool.query(
        "UPDATE story_jobs SET updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing'",
        [jobId]
      )
    ).catch(err => log.debug(`[HEARTBEAT] job ${jobId}: ${err.message}`));
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { createJobHeartbeat, startJobHeartbeat };
