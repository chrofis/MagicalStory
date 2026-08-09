/**
 * Per-job runtime metrics recorder (stats framework — docs/plans/story-stats-page.md).
 *
 * Pipeline code increments named counters as it runs:
 *     require('./runMetrics').forJob(jobId).count('dino_box_fail');
 * The counter bag is merged into stories.data.runMetrics at persist time (see
 * getSnapshot), and the collector copies it into story_metrics.counters.
 *
 * Contract: NEVER throws, NEVER blocks — a metrics failure must not touch a
 * story. Unknown jobId is fine (no-op recorder). Memory-bounded: bags are
 * dropped on flush or after MAX_AGE.
 */
'use strict';

const bags = new Map(); // jobId -> { counts: {name: n}, startedAt }
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // orphan cleanup: 6h

function sweep() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, bag] of bags) if (bag.startedAt < cutoff) bags.delete(id);
}

const NOOP = { count: () => {}, add: () => {} };

function forJob(jobId) {
  try {
    if (!jobId) return NOOP;
    if (!bags.has(jobId)) {
      if (bags.size > 200) sweep();
      bags.set(jobId, { counts: {}, startedAt: Date.now() });
    }
    const bag = bags.get(jobId);
    return {
      /** Increment a named counter by 1 (or n). */
      count(name, n = 1) {
        try { bag.counts[name] = (bag.counts[name] || 0) + n; } catch { /* never throw */ }
      },
      /** Alias for count with explicit n. */
      add(name, n) { this.count(name, n); },
    };
  } catch {
    return NOOP;
  }
}

/** Current counter bag for a job ({} if none). Does not clear. */
function getSnapshot(jobId) {
  try {
    return { ...(bags.get(jobId)?.counts || {}) };
  } catch {
    return {};
  }
}

/** Drop a job's bag after final persist. */
function release(jobId) {
  try { bags.delete(jobId); } catch { /* never throw */ }
}

module.exports = { forJob, getSnapshot, release };
