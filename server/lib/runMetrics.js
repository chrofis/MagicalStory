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

/**
 * The ambient scope of a full-mode story pipeline run. The styled-avatar cache
 * scope IS the jobId (== storyId) inside one, and undefined outside it — the
 * same handle figureDetection/faceRepair/samBlend already use as their metrics
 * id.
 */
function ambientJobId() {
  try {
    // Read it out of the require cache rather than require()-ing it: styledAvatars
    // top-level-requires ./images and pulls the whole provider graph, which would
    // turn a stray metrics call in a unit test or an admin script into a very
    // expensive import. Inside a pipeline run the module is loaded by definition;
    // if it is not loaded, we are not in a run.
    const mod = require.cache[require.resolve('./styledAvatars')];
    return mod?.exports?._cacheContext?.getStore?.() || null;
  } catch { return null; }
}

// A DROPPED COUNTER MUST ANNOUNCE ITSELF (2026-09-13). `forJob(null)` used to
// return the NOOP recorder silently, so a counter whose call site never received
// the job id simply did not exist — and nothing said so. Measured: staging run
// job_1789304198359_y3n0euk3z stored 12 counters and no `presence_*` key at all,
// though the presence derivation ran on 23 page-version evals and authored 3
// findings; `eval_matches_missing` had been dead the same way for far longer.
// Both keyed off an evaluateImageBatch `storyId` no caller passed.
//
// Two behaviours, in this order:
//   1. RESCUE — if we are demonstrably inside a pipeline run (ambient scope set)
//      the counter still lands, and the first use of each counter name WARNs
//      that the id did not reach the call site. Once per name per process: a
//      rescued counter fires hundreds of times, the plumbing bug is one line.
//   2. Outside a run (admin tools, Test Lab, unit tests) there is no id by
//      design — stay silent and no-op, unless RUN_METRICS_STRICT=1, which throws
//      so a test can assert the drop.
const warnedUnscoped = new Set();

function noopRecorder(reason) {
  const drop = (name) => {
    if (process.env.RUN_METRICS_STRICT === '1') {
      throw new Error(`[METRICS] counter '${name}' recorded with no job id in scope (${reason})`);
    }
  };
  return { count: (name) => drop(name), add: (name) => drop(name) };
}

const NOOP = { count: () => {}, add: () => {} };

function forJob(jobId) {
  try {
    if (!jobId) {
      const ambient = ambientJobId();
      if (!ambient) return noopRecorder('no ambient run scope either');
      const inner = forJob(ambient);
      return {
        count(name, n = 1) {
          if (!warnedUnscoped.has(name)) {
            warnedUnscoped.add(name);
            try {
              console.warn(`⚠️ [METRICS] counter '${name}' was recorded WITHOUT a job id — rescued from the ambient run scope (${ambient}). Thread the story/job id to that call site.`);
            } catch { /* never throw */ }
          }
          inner.count(name, n);
        },
        add(name, n) { this.count(name, n); },
      };
    }
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

module.exports = { forJob, getSnapshot, release, ambientJobId, _resetWarned: () => warnedUnscoped.clear() };
