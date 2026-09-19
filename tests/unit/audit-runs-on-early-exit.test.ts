import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');
const { planBookAuditRound } = require_('../../server/lib/repairLogic.js');

/**
 * The repair round loop has three exits: the round limit, "no bad pages left"
 * and "nothing actionable". Only the first used to reach the book audit, so a
 * run that converged in round 2 of 3 shipped a book no reader's-eye pass had
 * ever read — and the one-extra-round grant, whose whole job is to rescue a
 * CRITICAL the per-page judges missed, could not fire on it.
 */
describe('planBookAuditRound: the caller says which book is final', () => {
  it('an early exit before the round limit may still grant the extra round', () => {
    const plan = planBookAuditRound({
      round: 2, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false, finalRound: true,
    });
    expect(plan).toEqual({ runAudit: true, mayGrantExtraRound: true });
  });

  it('a mid-loop round is not final and grants nothing', () => {
    expect(planBookAuditRound({
      round: 2, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false, finalRound: false,
    }).mayGrantExtraRound).toBe(false);
  });

  it('without finalRound it falls back to the round-limit derivation', () => {
    expect(planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false }).mayGrantExtraRound).toBe(true);
    expect(planBookAuditRound({ round: 2, roundLimit: 3, bookUnchanged: false, extraRoundUsed: false }).mayGrantExtraRound).toBe(false);
  });

  it('the grant is once per run, and an unchanged book is not re-audited', () => {
    expect(planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: false, extraRoundUsed: true, finalRound: true }).mayGrantExtraRound).toBe(false);
    expect(planBookAuditRound({ round: 3, roundLimit: 3, bookUnchanged: true, extraRoundUsed: false, finalRound: true }))
      .toEqual({ runAudit: false, mayGrantExtraRound: false });
  });
});

describe('the pipeline audits the book on every exit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/lib/repairPipeline.js'), 'utf8');

  it('the audit is one extracted routine, not an inline tail of the loop', () => {
    expect(src).toMatch(/const runBookAuditRound = async \(/);
  });

  it('both early exits audit with finalRound: true before breaking', () => {
    for (const marker of ['No bad pages, stopping repair loop', 'nothing actionable, stopping repair loop']) {
      const at = src.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      const after = src.slice(at, at + 700);
      expect(after, marker).toMatch(/await runBookAuditRound\(\{[^}]*finalRound: true/s);
      // and the break happens after the audit, not before it
      expect(after.indexOf('runBookAuditRound'), marker).toBeLessThan(after.indexOf('break;'));
    }
  });

  it('an extra round granted at an early exit continues the loop instead of breaking', () => {
    expect(src).toMatch(/if \(auditAdmittedNums\.length > 0\) continue;/);
  });
});
