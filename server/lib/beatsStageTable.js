'use strict';

/**
 * The beats text phase's progress checkpoints: ONE table, read by
 * server/lib/beatsPipeline.js (`stage(...BEATS_STAGES.x)`) and pinned by
 * tests/unit/beats-stage-table.test.ts.
 *
 * pct  = where the bar stands when the stage starts. It is proportional to the
 *        MEASURED wall-clock of the stages before it (docs/decisions.md
 *        2026-11-01 "Progress bar recalibrated").
 * next = the pct of the stage that follows; the job heartbeat eases the bar from
 *        pct toward next over `ms` and never passes it.
 * ms   = at least the measured median of the stage, so the bar keeps moving for
 *        the whole call instead of freezing at `next` (the 2026-11-01 bug: the
 *        arc machine took 8-21 minutes against 90 s hints and owned 1-3 points).
 *
 * The text phase spans TEXT_PHASE_START_PCT..TEXT_PHASE_END_PCT. The end is the
 * value storyJobPipeline.js writes when the text is complete (57); the image
 * phase starts at 60 there. Change them together (the unit test reads both).
 *
 * `seconds` = the share basis (expected duration per stage, from 74 completed
 * beats stories, prod + staging, medians). arcCreate uses the post-budget Lab
 * estimate (about 250 s, commit dbab0d576), not the inflated pre-budget 401 s
 * median, which `ms` still uses (the safer, slower interpolation).
 */
const TEXT_PHASE_START_PCT = 1;
const TEXT_PHASE_END_PCT = 57;

const BEATS_STAGES = {
  arcCreate:  { pct: 1,  next: 9,  ms: 400000, seconds: 250 },
  arcPanel:   { pct: 9,  next: 17, ms: 250000, seconds: 246 },
  arcRetell:  { pct: 17, next: 27, ms: 310000, seconds: 307 },
  plan:       { pct: 27, next: 28, ms: 35000,  seconds: 29 },
  planCheck:  { pct: 28, next: 36, ms: 255000, seconds: 254 },
  // Inside planCheck: a re-division round restarts the easing from its midpoint.
  replan:     { pct: 32, next: 36, ms: 120000, seconds: 0 },
  wardrobe:   { pct: 36, next: 39, ms: 90000,  seconds: 86 },
  visualBible:{ pct: 39, next: 43, ms: 130000, seconds: 130 },
  briefs:     { pct: 43, next: 45, ms: 140000, seconds: 57 },
  pageText:   { pct: 45, next: 57, ms: 380000, seconds: 376 },
};

/** Arguments for `stage(pct, msg, hint)`: `stage(...stageArgs('arcCreate', 'msg'))`. */
function stageArgs(key, message) {
  const s = BEATS_STAGES[key];
  if (!s) throw new Error(`Unknown beats stage "${key}"`);
  return [s.pct, message, { next: s.next, ms: s.ms }];
}

module.exports = { BEATS_STAGES, stageArgs, TEXT_PHASE_START_PCT, TEXT_PHASE_END_PCT };
