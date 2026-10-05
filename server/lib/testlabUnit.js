'use strict';

/**
 * ONE Test Lab unit's target and stage params — shared by the experiment run
 * and the redo (routes/admin/testlab.js). A redo that rebuilt its own copy
 * re-measured a different case: the set member's params and a pinned version
 * were dropped (code review 2026-10-04 L2).
 */

/**
 * `baseParams` is the experiment's params with the chain keys removed;
 * `variantParams` the variant's own. Order: base, member (set run, on
 * target._params), variant. A target-level versionIndex is a pin: the stage
 * reads params.versionIndex, so it is copied there unless a param set it.
 * @returns {{ target: object, unitParams: object }} the CLEAN target (no _params)
 */
function unitFor(baseParams, rawTarget, variantParams) {
  const { _params: memberParams, ...target } = rawTarget;
  const unitParams = { ...baseParams, ...(memberParams || {}), ...(variantParams || {}) };
  if (target.versionIndex != null && unitParams.versionIndex == null) unitParams.versionIndex = target.versionIndex;
  return { target, unitParams };
}

/**
 * The target a stored result entry was run on, read from the experiment's own
 * targets (the pin and a set member's params live there, not on the entry — the
 * result's versionIndex overwrites the target's when the entry is spread).
 * Entries written since 2026-10-05 carry `targetIndex`. Older entries are
 * matched by story and page, and only when that identifies ONE target: stored
 * data in the old shape cannot be told apart otherwise, so it is refused.
 */
function originalTargetOf(exp, entry) {
  const targets = Array.isArray(exp.targets) ? exp.targets : [];
  if (Number.isInteger(entry.targetIndex) && targets[entry.targetIndex]) return targets[entry.targetIndex];
  const same = targets.filter(t => t && String(t.storyId) === String(entry.storyId) && t.pageNumber === entry.pageNumber);
  if (same.length === 1) return same[0];
  throw new Error(`cannot identify the original target of the result for story ${entry.storyId} page ${entry.pageNumber} (${same.length} candidates, no targetIndex on the entry) — rerun the experiment instead of redoing this result`);
}

module.exports = { unitFor, originalTargetOf };
