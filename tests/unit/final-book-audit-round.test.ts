import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// FINAL-BOOK AUDIT → ONE EXTRA REPAIR ROUND (owner, 2026-09-13).
//
// Evidence: production story job_1789227389389_z18dmvnt6 ran three repair
// rounds. Its round-2 audit recorded 37 faults {CATASTROPHIC:1, CRITICAL:5,
// MAJOR:25, MINOR:6}; the FINAL round's output was never audited because the
// audit was gated on `round < maxRegenAttempts`. A later Lab audit of the
// SHIPPED book (experiment #1229) found 21 faults, 3 of them CRITICAL — all
// shipped to a paying customer.
//
// These tests pin BEHAVIOUR, never prompt wording:
//   - the final round is audited
//   - a CRITICAL/CATASTROPHIC IMG fault admits its page to exactly one extra round
//   - a MAJOR/MINOR fault does not
//   - the grant can happen at most once per story
//   - an audit that fails never fails the story

// @ts-expect-error - JS module without types
import { planBookAuditRound, admitPagesFromAudit, AUDIT_ADMIT_SEVERITIES } from '../../server/lib/repairLogic.js';

describe('planBookAuditRound', () => {
  it('audits the FINAL round — the book that actually ships gets read', () => {
    const plan = planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false });
    expect(plan.runAudit).toBe(true);
    expect(plan.mayGrantExtraRound).toBe(true);
  });

  it('audits mid-loop rounds but they may not grant an extra round', () => {
    const plan = planBookAuditRound({ round: 1, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false });
    expect(plan.runAudit).toBe(true);
    expect(plan.mayGrantExtraRound).toBe(false);
  });

  it('keeps the spend guard: a byte-identical book is not re-audited', () => {
    const plan = planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: true, extraRoundUsed: false });
    expect(plan.runAudit).toBe(false);
    expect(plan.mayGrantExtraRound).toBe(false);
  });

  it('grants the extra round AT MOST ONCE — the extra round cannot buy another', () => {
    // Round 3 of 3 grants -> roundLimit becomes 4, extraRoundUsed true.
    const first = planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false });
    expect(first.mayGrantExtraRound).toBe(true);
    // The extra round itself is still audited (outcome record) but grants nothing.
    const second = planBookAuditRound({ round: 4, roundLimit: 4, bookUnchanged: false, extraRoundUsed: true });
    expect(second.runAudit).toBe(true);
    expect(second.mayGrantExtraRound).toBe(false);
  });

  it('a single-round story still gets its shipping book audited', () => {
    const plan = planBookAuditRound({ round: 1, roundLimit: 1, bookUnchanged: false, extraRoundUsed: false });
    expect(plan.runAudit).toBe(true);
    expect(plan.mayGrantExtraRound).toBe(true);
  });
});

describe('admitPagesFromAudit', () => {
  it('admits pages carrying a CRITICAL or CATASTROPHIC IMG fault', () => {
    const pages = admitPagesFromAudit([
      { page: 3, severity: 'CRITICAL', line: 'the picture shows a model of a boat, the text says a photograph' },
      { page: 6, severity: 'CATASTROPHIC', line: 'two named characters are entirely absent' },
    ]);
    expect(pages).toEqual([3, 6]);
  });

  it('does NOT admit a MAJOR or MINOR fault', () => {
    const pages = admitPagesFromAudit([
      { page: 4, severity: 'MAJOR', line: 'a detail disagrees' },
      { page: 5, severity: 'MINOR', line: 'a smaller detail disagrees' },
      { page: 9, severity: null, line: 'unsevered' },
    ]);
    expect(pages).toEqual([]);
  });

  it('ignores faults with no page — a fix target is always per page', () => {
    expect(admitPagesFromAudit([{ page: null, severity: 'CRITICAL', line: 'book-wide' }])).toEqual([]);
  });

  it('de-duplicates: several CRITICALs on one page admit it once', () => {
    expect(admitPagesFromAudit([
      { page: 10, severity: 'critical', line: 'a' },
      { page: 10, severity: 'CRITICAL', line: 'b' },
    ])).toEqual([10]);
  });

  it('tolerates a missing/garbled fault list instead of throwing', () => {
    expect(admitPagesFromAudit(null as any)).toEqual([]);
    expect(admitPagesFromAudit([null, undefined, {}] as any)).toEqual([]);
  });

  it('severity is the ONLY thing code reads — admission, never a fix instruction', () => {
    expect([...AUDIT_ADMIT_SEVERITIES].sort()).toEqual(['CATASTROPHIC', 'CRITICAL']);
  });
});

describe('repair pipeline wiring', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server/lib/repairPipeline.js'), 'utf8');

  it('no longer gates the audit on there being a further round to feed', () => {
    expect(src).not.toContain('if (round < maxRegenAttempts && !bookUnchanged)');
  });

  it('the round budget can only be extended by the audit grant, and never past the cap', () => {
    // Exactly one site raises roundLimit, it sits under the grant guard, and
    // it is clamped to the configured budget (2026-09-17): staging runs
    // repairMaxPasses=1 and the unclamped grant gave it a second full round.
    const raises = src.match(/roundLimit = Math\.min\(round \+ 1, maxRegenAttempts\);/g) || [];
    expect(raises.length).toBe(1);
    expect(src).not.toMatch(/roundLimit = round \+ 1;/);
    expect(src).toContain('if (auditPlan.mayGrantExtraRound)');
    expect(src).toContain('maxPasses: maxRegenAttempts');
  });

  it('an audit failure is swallowed — a paid run always finishes', () => {
    expect(src).toContain('catch (auditErr)');
  });

  it('records the outcome on bookAuditRounds, a field with a live consumer', () => {
    expect(src).toContain('record.extraRoundGranted');
    const pipeline = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8');
    expect(pipeline).toContain('finalChecksReport.bookAuditRounds = pipelineBookAuditRounds');
  });
});

// @ts-ignore — CommonJS lib
const { applyRoundCap: cap, AUDIT_ADMIT_MAX } = require('../../server/lib/repairLogic.js');

/**
 * THE DEFECT THIS PINS (staging job_1789348171785_9oxos7dwv and
 * job_1789343124794_z2c779f7i, the first two stories to run with the grant).
 *
 * Admitted pages were appended to badPageNums BEFORE applyRoundCap. The cap
 * keeps 30% of bad pages ranked WORST-FIRST BY SCORE, and an audit-admitted
 * page is by definition not low-scoring — its score is exactly what failed to
 * notice the fault. Six of seven admitted pages were dropped: p16 ("the dragon
 * is already hatched while the text has it still tapping inside the shell")
 * scored 80, p12 ("the picture shows page 11's scene") scored 85.
 *
 * The pipeline now caps the score-ranked pages first and appends admitted pages
 * afterwards, bounded by AUDIT_ADMIT_MAX. These tests pin the ordering contract
 * the pipeline relies on, and the allowance itself.
 */
describe('audit-admitted pages are exempt from the round cap', () => {
  // The pipeline's sequence, extracted so the contract is testable without a run.
  const selectRoundPages = (ranked: number[], admitted: number[], opts: any) => {
    const capped = cap(ranked, opts).admitted;
    const already = new Set(capped);
    return [...capped, ...admitted.filter(p => !already.has(p)).slice(0, AUDIT_ADMIT_MAX)];
  };

  it('THE REGRESSION: a high-scoring admitted page survives a cap that would have dropped it', () => {
    // 18 pages, round 2 → cap keeps ~30%. p16 is admitted but ranks last by score.
    const ranked = [5, 7, 11, 15, 2, 8, 10, 13];
    const out = selectRoundPages(ranked, [16, 6], { round: 2, totalPages: 18 });
    expect(out).toContain(16);
    expect(out).toContain(6);
  });

  it('the allowance is RESERVED, not a share of the round budget', () => {
    const ranked = [5, 7, 11, 15, 2, 8, 10, 13];
    const capped = cap(ranked, { round: 2, totalPages: 18 }).admitted;
    const out = selectRoundPages(ranked, [16, 6], { round: 2, totalPages: 18 });
    // Nothing the cap chose was displaced to make room.
    for (const p of capped) expect(out).toContain(p);
    expect(out.length).toBe(capped.length + 2);
  });

  it('is bounded at AUDIT_ADMIT_MAX so a noisy audit cannot regenerate the book', () => {
    const out = selectRoundPages([1, 2], [10, 11, 12, 13, 14, 15, 16], { round: 2, totalPages: 18 });
    const extras = out.filter(p => p >= 10);
    expect(extras).toHaveLength(AUDIT_ADMIT_MAX);
    expect(AUDIT_ADMIT_MAX).toBe(5);
  });

  it('an admitted page the cap already kept is not added twice', () => {
    const out = selectRoundPages([5, 7, 11], [7], { round: 2, totalPages: 18 });
    expect(out.filter(p => p === 7)).toHaveLength(1);
  });

  it('admitted pages keep their place AFTER the score-ranked ones (worst-first preserved)', () => {
    const out = selectRoundPages([5, 7, 11], [16], { round: 2, totalPages: 18 });
    expect(out[out.length - 1]).toBe(16);
  });

  it('no admitted pages leaves the capped selection exactly as it was', () => {
    const ranked = [5, 7, 11, 15, 2];
    expect(selectRoundPages(ranked, [], { round: 2, totalPages: 18 }))
      .toEqual(cap(ranked, { round: 2, totalPages: 18 }).admitted);
  });
});
