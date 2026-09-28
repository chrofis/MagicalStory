/**
 * D6 — the scene review's per-page rows no longer duplicate the pre-review
 * brief.
 *
 * Measured on job_1789853503332_riqncqg1i: all 17 rows of
 * `sceneReviewReport.pages[].before` were byte-identical to the same page's
 * `briefsIn` entry — 34,520 characters of JSONB, half the block, written twice
 * per story. `briefsIn` is the snapshot of EVERY brief as sent, so it is the
 * one source; readers resolve a row's before from it.
 *
 * Rows stored before 2026-09-21 still carry their own copy and must keep
 * rendering — that is stored data in an old shape, not a second code path.
 * The scene review itself is deleted (2026-09-28); its stored reports keep
 * their churn.
 */
import { describe, it, expect } from 'vitest';

const { computeMetrics } = require("../../server/lib/storyMetrics");

describe('churn is computed from briefsIn', () => {
  const metricsFor = (report: any) => computeMetrics({
    // isBeats is decided by the presence of a beats report / BEATS section.
    beatsReviewReport: { pages: [] },
    sceneImages: [{ pageNumber: 1 }, { pageNumber: 2 }],
    sceneReviewReport: report,
  });

  it('counts a rewritten page when the row carries no `before`', () => {
    const m = metricsFor({
      briefsIn: [{ pageNumber: 1, brief: 'A child lifts the lantern.' }, { pageNumber: 2, brief: 'The flame holds.' }],
      pages: [{ pageNumber: 1, after: 'A child lifts the lit lantern high.' }],
    });
    expect(m.scene_churn_pct).toBe(50);
  });

  it('counts nothing when the rewrite is a no-op', () => {
    const m = metricsFor({
      briefsIn: [{ pageNumber: 1, brief: 'A child lifts the lantern.' }],
      pages: [{ pageNumber: 1, after: 'A child lifts the lantern.' }],
    });
    expect(m.scene_churn_pct).toBe(0);
  });

  it('still reads a legacy row that carries its own `before`', () => {
    const m = metricsFor({
      pages: [{ pageNumber: 1, before: 'A child lifts the lantern.', after: 'A child lifts the lit lantern high.' }],
    });
    expect(m.scene_churn_pct).toBe(50);
  });
});
