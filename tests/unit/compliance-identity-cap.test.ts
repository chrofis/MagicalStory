/**
 * The compliance judge's identity-absence cap reads the finding TYPE, never its description
 * (owner, 2026-10-09: "Code reading a metadata finding is fine. Code reading text is not.").
 *
 * The description regex that used to sit beside the type test capped 8 of 42 stored findings
 * (scripts/analysis/replay-identity-cap.js over staging): a real CRITICAL clothing finding whose
 * text said "absent from matches", and action_interaction findings that said "an unidentified animal".
 */
import { describe, it, expect } from 'vitest';

const { capComplianceIdentitySeverity } = require('../../server/lib/evalPipeline');

describe('capComplianceIdentitySeverity reads the finding TYPE, never its description', () => {
  it('caps a missing_character CRITICAL to MAJOR', () => {
    const issues = [{ description: 'x', severity: 'CRITICAL', type: 'missing_character' }];
    capComplianceIdentitySeverity(issues);
    expect(issues[0].severity).toBe('MAJOR');
    expect((issues[0] as any).severityCapped).toBe('identity-input');
  });

  it('leaves a real clothing CRITICAL alone even when its text says "absent from matches" (stored case)', () => {
    const issues = [
      { description: 'Sarah is absent from matches; inventory Figure 3 wears orange wide-leg cropped pants', severity: 'CRITICAL', type: 'clothing' },
      { description: 'Levin watches Fünkli; currently interacting with an unidentified animal', severity: 'CRITICAL', type: 'action_interaction' },
    ];
    capComplianceIdentitySeverity(issues);
    expect(issues.map(i => i.severity)).toEqual(['CRITICAL', 'CRITICAL']);
  });
});
