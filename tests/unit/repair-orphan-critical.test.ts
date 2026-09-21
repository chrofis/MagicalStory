/**
 * A CRITICAL NO REPAIR METHOD OWNS (staging job_1789853503332_riqncqg1i, 2026-09-20).
 *
 * p15 shipped at 50 carrying a CRITICAL `character_identity` on Silvan, a
 * secondary the STORY invented: visual-bible CHR001, no uploaded roster entry,
 * so no avatar and no face photo. Gate 2 never saw the finding (it came from the
 * quality judge, not the entity report), char-fix declined for the missing
 * reference, and `character_identity` is un-inpaintable, so the consolidator
 * dropped it and the round's instruction carried only the MODERATE pose note.
 * Nothing logged that the defect had been orphaned.
 *
 * Pinned here: the orphan routes to iterate when the round has nothing else to
 * execute, and does NOT steal a round from an executable finding. Both halves
 * are load-bearing — p10's own round inpainted a MAJOR scale fault and took the
 * page 15 → 70.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideRepairMethod } = require('../../server/lib/repairLogic');

const ROSTER = [{ name: 'Max' }, { name: 'Kiaan' }];
const SCORES = { scoreBreakdown: { visual: { score: 50 }, semantic: { score: 70 } }, finalScore: 50 };
const ORPHAN = {
  type: 'character_identity', severity: 'CRITICAL', character: 'Silvan',
  description: 'Figure 3 does not match Silvan — wrong age, wrong clothing, wrong build',
};

describe('orphan CRITICAL routing', () => {
  it('routes to iterate when no other finding is executable', () => {
    const d = decideRepairMethod(15, { ...SCORES, fixableIssues: [ORPHAN] }, null, { characters: ROSTER });
    expect(d.method).toBe('iterate');
    expect(d.reason).toMatch(/Silvan/);
  });

  it('leaves the round to an executable finding when there is one', () => {
    const d = decideRepairMethod(15, {
      ...SCORES,
      fixableIssues: [ORPHAN, { type: 'action_interaction', severity: 'CRITICAL', character: 'Kiaan', description: 'Kiaan is not holding the egg out toward Max' }],
    }, null, { characters: ROSTER });
    expect(d.method).toBe('inpaint');
  });

  it('does not fire for a character the roster holds — char-fix owns that one', () => {
    const d = decideRepairMethod(15, {
      ...SCORES,
      fixableIssues: [{ ...ORPHAN, character: 'Max' }],
    }, null, { characters: ROSTER });
    expect(d.method).not.toBe('iterate');
  });

  it('does not fire on a MAJOR — the 2026-09-04 unrepaired-MAJOR ruling stands', () => {
    const d = decideRepairMethod(15, {
      ...SCORES,
      fixableIssues: [{ ...ORPHAN, severity: 'MAJOR' }],
    }, null, { characters: ROSTER });
    expect(d.method).not.toBe('iterate');
  });

  it('has no opinion when the caller carries no roster', () => {
    const d = decideRepairMethod(15, { ...SCORES, fixableIssues: [ORPHAN] }, null, {});
    expect(d.method).not.toBe('iterate');
  });

  it('never claims a cover', () => {
    const d = decideRepairMethod(-1, { ...SCORES, fixableIssues: [ORPHAN] }, null, { characters: ROSTER });
    expect(d.method).not.toBe('iterate');
  });
});
