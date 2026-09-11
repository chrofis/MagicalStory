/**
 * D8 — a page cannot be CRITICAL and 85 at the same time.
 *
 * Evidence: job_1789147573901_m3uam0nxi p13 and p17. The stored shipping
 * version of p13 carried ONE defect, reported by three evaluators:
 *
 *   quality  fixableIssues     CRITICAL object_presence  "A complete green
 *                                                         dragon is depicted…"
 *   semantic semanticIssues    MAJOR    object_presence  (same defect)
 *   consolidated deduped_issues severity "major",
 *                               severities {semantic: MAJOR, compliance: CRITICAL}
 *
 * Two defects followed, and this file pins both fixes:
 *
 * 1. THE MERGE TOOK THE LOWER. `medianSeverity` merged CRITICAL + MAJOR to
 *    MAJOR (15 points), so the page scored 100 − 15 = 85 — the exact number
 *    stored. The defect was real: a whole phantom dragon drawn where the
 *    story's central prop should have been (the page D1's assignment trim
 *    broke). Owner reversed the 2026-07-30 "pure median, no lone escalation"
 *    ruling on 2026-09-11: a CRITICAL vote wins.
 *
 * 2. THE SCORE AND THE REPAIR QUEUE READ DIFFERENT FIELDS. `composeDeductions`
 *    empties the raw quality/semantic/compliance buckets whenever a
 *    consolidated plan exists, so a defect three evaluators reported is charged
 *    once at its MERGED severity. `collectCriticalFindings` read the raw pools
 *    the scorer had just emptied, and found the untouched CRITICAL. Same
 *    finding, same version, two answers.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import consolidator from '../../server/lib/feedbackConsolidator.js';
const { medianSeverity } = consolidator as any;
// @ts-ignore — CommonJS lib
import repairLogic from '../../server/lib/repairLogic.js';
const { collectCriticalFindings } = repairLogic as any;

describe('medianSeverity — a CRITICAL vote wins (owner 2026-09-11)', () => {
  it('the measured p13 votes merge to CRITICAL, not MAJOR', () => {
    expect(medianSeverity({ semantic: 'MAJOR', compliance: 'CRITICAL' })).toBe('CRITICAL');
  });

  it('a lone CRITICAL among three witnesses still wins', () => {
    expect(medianSeverity({ a: 'CRITICAL', b: 'MINOR', c: 'MINOR' })).toBe('CRITICAL');
  });

  it('CATASTROPHIC escalates the same way', () => {
    expect(medianSeverity({ a: 'CATASTROPHIC', b: 'MINOR' })).toBe('CATASTROPHIC');
  });

  it('BELOW critical the median still stands — that is where the false alarms live', () => {
    expect(medianSeverity({ a: 'MAJOR', b: 'MODERATE' })).toBe('MODERATE');
    expect(medianSeverity({ a: 'MINOR', b: 'MAJOR', c: 'MAJOR' })).toBe('MAJOR');
    expect(medianSeverity({ a: 'MODERATE' })).toBe('MODERATE');
  });

  it('junk votes are ignored, not counted', () => {
    expect(medianSeverity({ a: 'CRITICAL', b: 'nonsense' })).toBe('CRITICAL');
    expect(medianSeverity({ a: 'nonsense' })).toBeNull();
    expect(medianSeverity(null)).toBeNull();
  });
});

describe('collectCriticalFindings — one source of truth with the score', () => {
  // The p13 shape as actually stored: raw CRITICAL, consolidated merged.
  const withConsolidation = (mergedSeverity: string) => ({
    fixableIssues: [{ severity: 'CRITICAL', type: 'object_presence', description: 'a phantom creature stands in the frame' }],
    semanticResult: { semanticIssues: [{ severity: 'MAJOR', type: 'object_presence', description: 'a phantom creature stands in the frame' }] },
    consolidatedPlan: {
      deduped_issues: [{
        severity: mergedSeverity,
        type: 'object_presence',
        description: 'a phantom creature stands in the frame',
        severities: { semantic: 'MAJOR', compliance: 'CRITICAL' },
      }],
    },
  });

  it('reads ONLY the merged list when the page was consolidated', () => {
    // The old bug: the raw CRITICAL was found while the score charged MAJOR.
    const merged = collectCriticalFindings(withConsolidation('MAJOR'));
    expect(merged).toEqual([]);
  });

  it('with the merge fixed, the CRITICAL is reported once, from the merged list', () => {
    const merged = collectCriticalFindings(withConsolidation(medianSeverity({ semantic: 'MAJOR', compliance: 'CRITICAL' })));
    expect(merged).toHaveLength(1);
    expect(merged[0].pool).toBe('consolidated');
    expect(merged[0].type).toBe('object_presence');
  });

  it('falls back to the raw pools when the page was never consolidated', () => {
    const raw = collectCriticalFindings({
      fixableIssues: [{ severity: 'CRITICAL', type: 'anatomy', description: 'a limb is malformed' }],
    });
    expect(raw).toHaveLength(1);
    expect(raw[0].pool).toBe('quality');
  });

  it('an EMPTY consolidated list is not a consolidation — the raw pools still count', () => {
    const raw = collectCriticalFindings({
      fixableIssues: [{ severity: 'CRITICAL', type: 'anatomy', description: 'a limb is malformed' }],
      consolidatedPlan: { deduped_issues: [] },
    });
    expect(raw).toHaveLength(1);
  });

  it('the same defect is never counted twice', () => {
    const merged = collectCriticalFindings(withConsolidation('CRITICAL'));
    expect(merged).toHaveLength(1);
  });
});
