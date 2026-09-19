/**
 * A CRITICAL that survived repair must be reported WITH the methods that were
 * tried on it (owner, 2026-09-14 — report only, no routing change).
 *
 * Evidence: job_1789337998754_apslnsq1z p8. A CRITICAL `missing_character`
 * routed to iterate (every critical does), the re-roll scored -82, an inpaint
 * round recovered the page to 53, and the page shipped ABOVE the threshold with
 * the CRITICAL still recorded. Nothing in the run said which methods had been
 * spent, which is the data a future routing decision would need.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import repairLogic from '../../server/lib/repairLogic.js';
const { collectSurvivingCriticals, collectShippedDefective } = repairLogic as any;

const critical = (type: string) => ({ type, severity: 'CRITICAL', description: `${type} on this page` });

// p8 ships at 53 — ABOVE a threshold of 50 — still carrying its CRITICAL.
const RESULTS = [
  { pageNumber: 8, finalScore: 53, unrepairedCritical: [critical('missing_character')] },
  { pageNumber: 5, finalScore: 45, unrepairedCritical: [critical('scene_location')] },
  { pageNumber: 1, finalScore: 85, unrepairedCritical: null },
  { pageNumber: 2, finalScore: 40, unrepairedCritical: [] },
];

// What summarizeRepairRound produced for those rounds.
const ROUNDS = [
  { round: 1, pages: [{ page: 8, method: 'iterate-round-1', outcome: 'regressed', delta: -97 }] },
  { round: 2, pages: [{ page: 8, method: 'inpaint-round-2', outcome: 'improved', delta: 135 }] },
];

describe('collectSurvivingCriticals', () => {
  it('captures a page that ships ABOVE the threshold with a CRITICAL', () => {
    const out = collectSurvivingCriticals(RESULTS, ROUNDS, 50);
    const p8 = out.pages.find((p: any) => p.pageNumber === 8);
    expect(p8).toBeTruthy();
    expect(p8.finalScore).toBe(53);
    expect(p8.aboveThreshold).toBe(true);
    expect(p8.findings[0].type).toBe('missing_character');
    expect(out.aboveThresholdCount).toBe(1);
  });

  it('records the repair methods that were attempted, in round order', () => {
    const out = collectSurvivingCriticals(RESULTS, ROUNDS, 50);
    const p8 = out.pages.find((p: any) => p.pageNumber === 8);
    expect(p8.methodsAttempted).toEqual(['iterate-round-1', 'inpaint-round-2']);
    expect(p8.roundsAttempted).toBe(2);
    expect(p8.attempts.map((a: any) => a.outcome)).toEqual(['regressed', 'improved']);
    // Bucketed on the BARE method so a method's rounds are comparable.
    expect(out.byMethod.iterate).toBe(1);
    expect(out.byMethod.inpaint).toBe(1);
  });

  it('buckets a page no repair ever reached as "none"', () => {
    const out = collectSurvivingCriticals(RESULTS, ROUNDS, 50);
    const p5 = out.pages.find((p: any) => p.pageNumber === 5);
    expect(p5.methodsAttempted).toEqual([]);
    expect(p5.aboveThreshold).toBe(false);
    expect(out.byMethod.none).toBe(1);
  });

  it('counts findings by declared type and rolls the totals up', () => {
    const out = collectSurvivingCriticals(RESULTS, ROUNDS, 50);
    expect(out.pageCount).toBe(2);
    expect(out.findingCount).toBe(2);
    expect(out.byType.missing_character).toBe(1);
    expect(out.byType.scene_location).toBe(1);
  });

  it('sorts worst first and puts an unscored page last, never as a 0', () => {
    const out = collectSurvivingCriticals([
      { pageNumber: 3, finalScore: null, unrepairedCritical: [critical('object_presence')] },
      ...RESULTS,
    ], ROUNDS, 50);
    expect(out.pages.map((p: any) => p.pageNumber)).toEqual([5, 8, 3]);
    expect(out.pages[2].finalScore).toBeNull();
    expect(out.pages[2].aboveThreshold).toBe(false);
  });

  it('returns null when nothing survived — never an empty husk', () => {
    expect(collectSurvivingCriticals([{ pageNumber: 1, finalScore: 85, unrepairedCritical: null }], [], 50)).toBeNull();
    expect(collectSurvivingCriticals(null, null, 50)).toBeNull();
  });

  it('is the same page set as shippedDefective for a carried CRITICAL, plus the methods', () => {
    // The two records overlap by construction; this pins that the
    // above-threshold page is in BOTH, and that only this one knows the route.
    const defective = collectShippedDefective(RESULTS, 50);
    const surviving = collectSurvivingCriticals(RESULTS, ROUNDS, 50);
    expect(defective.map((p: any) => p.pageNumber)).toContain(8);
    expect(surviving.pages.map((p: any) => p.pageNumber)).toContain(8);
    expect(defective.find((p: any) => p.pageNumber === 8).methodsAttempted).toBeUndefined();
  });
});
