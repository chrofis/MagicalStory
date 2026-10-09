/**
 * The body-part keyword spec-conflict check was deleted (owner, 2026-10-09):
 * it read prose meaning in code and fired on 0 of 257 stored pairs. Spec
 * conflicts now come only from the consolidator model's own `spec_conflicts`.
 */
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const consolidator = require('../../server/lib/feedbackConsolidator');

describe('no deterministic spec-conflict check', () => {
  it('feedbackConsolidator no longer exports detectDeclaredSpecConflicts', () => {
    expect((consolidator as any).detectDeclaredSpecConflicts).toBeUndefined();
  });
  it('nothing in the consolidator tags a conflict as declared-spec-check', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/feedbackConsolidator.js'), 'utf8');
    expect(src).not.toContain('declared-spec-check');
    expect(src).not.toContain('SPEC_BODY_PARTS');
  });
});
