/**
 * THE VOTES ARE CLAMPED TO WHAT EACH SOURCE SAID (2026-09-24).
 *
 * The consolidator transcribes each evaluator's vote into `severities`, and the
 * median trusted the transcription. Prod job_1790107559778_fcmlfa8kn p6 v3: the
 * reader said MAJOR, the transcribed vote was CATASTROPHIC, and the median of
 * one vote is that vote. Behaviour pinned here: a vote never exceeds the
 * highest severity its source showed on the page; a vote for a source that
 * showed nothing is dropped; the CRITICAL-wins rule (owner, 2026-09-11) still
 * fires on a CRITICAL a source really gave. Code reads severities and source
 * names only.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const FC = require_('../../server/lib/feedbackConsolidator.js');

describe('sourceSeverityCeilings — what each source showed on this page', () => {
  it('takes the highest shown severity per source, with each section default', () => {
    const c = FC.sourceSeverityCeilings({
      fixableIssues: [{ severity: 'MINOR' }, {}],        // quality default MODERATE
      semanticIssues: [{}],                               // semantic default MAJOR
      readerFindings: [{ severity: 'MAJOR', line: 'x' }],
    });
    expect(c).toEqual({ quality: 'MODERATE', semantic: 'MAJOR', reader: 'MAJOR' });
  });
  it('a source that showed nothing has no ceiling; an unreadable severity leaves it unknown', () => {
    const c = FC.sourceSeverityCeilings({ entityIssues: [{ characterName: 'A', description: 'd' }] });
    expect(c).toEqual({ entity: null });
    expect('compliance' in c).toBe(false);
  });
});

describe('resolveEntrySeverity — the median of the clamped votes', () => {
  it('the p6 v3 shape: a reader MAJOR transcribed as CATASTROPHIC scores MAJOR', () => {
    const ceil = { semantic: 'CRITICAL', entity: 'MINOR', reader: 'MAJOR' };
    expect(FC.resolveEntrySeverity('CATASTROPHIC', { reader: 'CATASTROPHIC' }, ceil)).toBe('MAJOR');
  });
  it('a real CRITICAL still wins (owner reversal 2026-09-11 is kept)', () => {
    const ceil = { quality: 'CRITICAL', semantic: 'MAJOR' };
    expect(FC.resolveEntrySeverity('MAJOR', { quality: 'CRITICAL', semantic: 'MAJOR' }, ceil)).toBe('CRITICAL');
  });
  it('a fabricated CRITICAL no longer wins', () => {
    const ceil = { quality: 'MAJOR', semantic: 'MAJOR' };
    expect(FC.resolveEntrySeverity('CRITICAL', { quality: 'CRITICAL', semantic: 'MAJOR' }, ceil)).toBe('MAJOR');
  });
  it('drops a vote for a source that flagged nothing here', () => {
    expect(FC.clampVotesToSources({ quality: 'MAJOR', compliance: 'CRITICAL' }, { quality: 'MAJOR' }))
      .toEqual({ quality: 'MAJOR' });
  });
  it('an unknown ceiling leaves the vote as transcribed', () => {
    expect(FC.resolveEntrySeverity('MAJOR', { entity: 'CRITICAL' }, { entity: null })).toBe('CRITICAL');
  });
  it('no surviving vote: the model pick is held to the page maximum', () => {
    expect(FC.resolveEntrySeverity('CATASTROPHIC', { compliance: 'CATASTROPHIC' }, { quality: 'MODERATE' })).toBe('MODERATE');
    expect(FC.resolveEntrySeverity('MINOR', { compliance: 'MAJOR' }, { quality: 'MODERATE' })).toBe('MINOR');
  });
  it('never raises a vote', () => {
    expect(FC.resolveEntrySeverity('MINOR', { quality: 'MINOR' }, { quality: 'CRITICAL' })).toBe('MINOR');
  });
});

describe('the consolidator input renders reader lines with their type', () => {
  it('carries the reader type in the same (type) shape as an evaluator line', () => {
    const input = FC.buildFeedbackInput({
      sceneDescription: 's',
      readerFindings: [{ severity: 'MAJOR', type: 'action_interaction', line: 'FAULT[IMG][MAJOR][action_interaction]: p3 — x' }],
    });
    expect(input).toContain('- [MAJOR] (action_interaction) FAULT[IMG]');
  });
});
