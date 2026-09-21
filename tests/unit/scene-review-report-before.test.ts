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
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { computeMetrics } = require("../../server/lib/storyMetrics");

const BEATS_SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf-8');

describe('the scene review report stores each brief once', () => {
  it('strips `before` from the stored rows', () => {
    // The rows keep `before` in memory (the cast-removal diff reads it); it is
    // dropped where the report is assembled.
    expect(BEATS_SRC).toContain('pages: sceneDiffs.map(({ before, ...row }) => row)');
    expect(BEATS_SRC).not.toContain('pages: sceneDiffs,');
  });
});

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
