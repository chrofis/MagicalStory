/**
 * In-process abort requests for running Test Lab experiments.
 *
 * An experiment is a loop in THIS process (executeExperiment, routes/admin/
 * testlab.js), so an abort is a flag that loop reads between units: the unit
 * in flight finishes (a paid call is never half-cancelled), every unit after
 * it is skipped, and the row closes as 'aborted' with the count it reached.
 * Before 2026-10-07 there was no such flag — firing an N-target set committed
 * the whole spend (exp 815: clearly losing by result 4 of 14, 9 more ran).
 *
 * The registry is in-process on purpose: a row this process is not running
 * (a stale row from a dead container) belongs to the reaper, not to an abort.
 */
const running = new Set();
const requested = new Map();

function markRunning(experimentId) {
  running.add(experimentId);
}

function markDone(experimentId) {
  running.delete(experimentId);
  requested.delete(experimentId);
}

function isRunningHere(experimentId) {
  return running.has(experimentId);
}

/** Flags a running experiment; returns false when this process does not run it. */
function requestAbort(experimentId, by) {
  if (!running.has(experimentId)) return false;
  if (!requested.has(experimentId)) requested.set(experimentId, { by: by || 'admin', at: new Date().toISOString() });
  return true;
}

/** `{ by, at }` when an abort was requested, else null. */
function abortRequested(experimentId) {
  return requested.get(experimentId) || null;
}

class ExperimentAborted extends Error {
  constructor(experimentId, { by, done, total }) {
    super(`aborted by ${by} after ${done} of ${total} results`);
    this.name = 'ExperimentAborted';
    this.experimentId = experimentId;
  }
}

module.exports = { markRunning, markDone, isRunningHere, requestAbort, abortRequested, ExperimentAborted };
