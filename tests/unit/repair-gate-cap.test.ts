import { describe, it, expect } from 'vitest';

// Repair admission gate, 2026-09-09 (owner). Three changes locked down here:
//
//   1) The score floor is back to 60 (superseding ONLY the 60 -> 50 rider in the
//      2026-08-09 decisions.md entry). Motivating case:
//      job_1788903616404_iqvhj4l8m page 3 — finalScore 55, three MAJOR findings,
//      ZERO repair attempts, because 55 cleared the 50 floor.
//   2) TYPE RESCUE: a page above the floor is still admitted when it carries a
//      MAJOR-or-worse finding of a type local repair handles well. Entity-sourced
//      findings are NEVER admitted this way (2026-09-04 ruling stands).
//   3) A PER-ROUND CAP on how many pages a round may repair: 50% of the story in
//      round 1, 30% later, worst first, capped-out pages deferred not dropped.
//      Measured: 19 of 53 staging stories repaired more than half their pages, and
//      one 14-page story repaired all 14 in round 2 AND all 14 again in round 3.

// @ts-expect-error - JS module without types
import { findBadPages, applyRoundCap, SAFE_REPAIRABLE_TYPES } from '../../server/lib/repairLogic.js';
// @ts-expect-error - JS module without types
import { REPAIR_DEFAULTS } from '../../server/config/models.js';

const page = (finalScore: number, fixableIssues: any[] = []) => ({
  evaluated: true,
  finalScore,
  fixableIssues,
});

describe('score floor', () => {
  it('is 60 on the server config', () => {
    expect(REPAIR_DEFAULTS.scoreThreshold).toBe(60);
  });

  it('admits job_1788903616404_iqvhj4l8m page 3 (finalScore 55, three MAJOR, no CRITICAL)', () => {
    const p3 = page(55, [
      { type: 'clothing', severity: 'MAJOR', description: 'wrong outfit' },
      { type: 'action_interaction', severity: 'MAJOR', description: 'not performing the declared action' },
      { type: 'missing_element', severity: 'MAJOR', description: 'declared prop absent' },
    ]);
    expect(findBadPages({ 3: p3 })).toEqual([3]);
    // Two independent doors now open for this page. The FLOOR alone admits it:
    // strip the rescuable type and 55 < 60 is still enough...
    const floorOnly = page(55, p3.fixableIssues.filter((i: any) => i.type !== 'missing_element'));
    expect(findBadPages({ 3: floorOnly })).toEqual([3]);
    // ...whereas under the old floor of 50 that page was refused outright — which
    // is exactly how it shipped with three MAJOR findings and zero repair attempts.
    expect(findBadPages({ 3: floorOnly }, { scoreThreshold: 50 })).toEqual([]);
    // The TYPE RESCUE is the second door: it would have caught this page even at 50.
    expect(findBadPages({ 3: p3 }, { scoreThreshold: 50 })).toEqual([3]);
  });

  it('still leaves a clean page at 65 alone', () => {
    expect(findBadPages({ 4: page(65) })).toEqual([]);
  });
});

describe('type rescue', () => {
  it('admits a MAJOR missing_element above the floor', () => {
    const p = page(78, [{ type: 'missing_element', severity: 'MAJOR', description: 'the basket is absent' }]);
    expect(findBadPages({ 7: p })).toEqual([7]);
  });

  it('admits a MAJOR object_count from the semantic pool', () => {
    const p = {
      evaluated: true,
      finalScore: 82,
      semanticResult: { issues: [{ type: 'object_count', severity: 'major', description: 'three instead of five' }] },
    };
    expect(findBadPages({ 9: p })).toEqual([9]);
  });

  it('refuses a MODERATE finding of a rescuable type', () => {
    const p = page(78, [{ type: 'missing_element', severity: 'MODERATE', description: 'small prop absent' }]);
    expect(findBadPages({ 7: p })).toEqual([]);
  });

  it('refuses a MAJOR finding of a type inpaint cannot do (clothing / hair)', () => {
    expect(findBadPages({ 7: page(78, [{ type: 'clothing', severity: 'MAJOR', description: 'x' }]) })).toEqual([]);
    expect(findBadPages({ 7: page(78, [{ type: 'hair', severity: 'MAJOR', description: 'x' }]) })).toEqual([]);
    for (const t of SAFE_REPAIRABLE_TYPES) {
      expect(['clothing', 'hair', 'age_shift', 'skin_tone', 'scale']).not.toContain(t);
    }
  });

  it('refuses an ENTITY-SOURCED MAJOR of an otherwise rescuable type (2026-09-04 ruling)', () => {
    const p = {
      evaluated: true,
      finalScore: 78,
      consolidatedPlan: {
        deduped_issues: [
          { type: 'missing_element', severity: 'MAJOR', description: 'accessory absent', sources: ['entity'] },
        ],
      },
    };
    expect(findBadPages({ 11: p })).toEqual([]);
  });
});

describe('worst-first ordering', () => {
  it('orders by ascending score, CRITICAL-carrying pages first', () => {
    const pages = {
      1: page(58),
      2: page(20),
      3: page(45),
      4: page(70, [{ type: 'object_presence', severity: 'CRITICAL', description: 'x' }]),
      5: page(95),
    };
    // page 4 carries a CRITICAL (outranks a low score, 2026-09-04 item 15);
    // the rest follow worst-score-first; page 5 is clean and absent.
    expect(findBadPages(pages)).toEqual([4, 2, 3, 1]);
  });
});

describe('per-round cap', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);

  it('gives 10 in round 1 and 6 in later rounds on a 20-page story', () => {
    expect(applyRoundCap(twenty, { round: 1, totalPages: 20 }).cap).toBe(10);
    expect(applyRoundCap(twenty, { round: 2, totalPages: 20 }).cap).toBe(6);
    expect(applyRoundCap(twenty, { round: 3, totalPages: 20 }).cap).toBe(6);
  });

  it('admits the WORST pages first and defers the rest', () => {
    const worstFirst = [7, 2, 9, 4, 1, 8, 3];
    const { admitted, deferred } = applyRoundCap(worstFirst, { round: 2, totalPages: 10 });
    expect(admitted).toEqual([7, 2, 9]);
    expect(deferred).toEqual([4, 1, 8, 3]);
  });

  it('a deferred page is still eligible next round (deferral, not a drop)', () => {
    const worstFirst = [7, 2, 9, 4, 1, 8, 3];
    const r2 = applyRoundCap(worstFirst, { round: 2, totalPages: 10 });
    // Next round findBadPages returns the survivors — the deferred pages are
    // still bad, and now they are at the front.
    const r3 = applyRoundCap(r2.deferred, { round: 3, totalPages: 10 });
    expect(r3.admitted).toEqual([4, 1, 8]);
    expect(r3.deferred).toEqual([3]);
  });

  it('never blocks a short story: the floor is 3 pages (or all bad pages, if fewer)', () => {
    expect(applyRoundCap([1, 2, 3, 4], { round: 2, totalPages: 4 }).admitted).toEqual([1, 2, 3]);
    expect(applyRoundCap([1, 2], { round: 3, totalPages: 4 }).admitted).toEqual([1, 2]);
    expect(applyRoundCap([1, 2, 3, 4, 5, 6], { round: 1, totalPages: 6 }).admitted).toEqual([1, 2, 3]);
  });

  it('is a no-op when the story is already under the cap', () => {
    const r = applyRoundCap([4, 9], { round: 1, totalPages: 14 });
    expect(r.admitted).toEqual([4, 9]);
    expect(r.deferred).toEqual([]);
  });

  it('bounds the measured runaway: 14 pages bad on a 14-page story', () => {
    const all = Array.from({ length: 14 }, (_, i) => i + 1);
    expect(applyRoundCap(all, { round: 1, totalPages: 14 }).admitted).toHaveLength(7);
    expect(applyRoundCap(all, { round: 2, totalPages: 14 }).admitted).toHaveLength(4);
    expect(applyRoundCap(all, { round: 3, totalPages: 14 }).admitted).toHaveLength(4);
  });
});
