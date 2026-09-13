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

  it('the round budget can only be extended by the audit grant', () => {
    // Exactly one site raises roundLimit, and it sits under the grant guard.
    const raises = src.match(/roundLimit = round \+ 1;/g) || [];
    expect(raises.length).toBe(1);
    expect(src).toContain('if (auditPlan.mayGrantExtraRound)');
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
