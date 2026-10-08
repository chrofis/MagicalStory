/**
 * A reply that is only the model's end-of-sequence token is an EMPTY reply, and
 * an empty arc-hint reply is a failed call that is retried once and then
 * reported (2026-10-09, job_1791497309909_6quecrr9t: grok-4.6 spent 11,622
 * reasoning tokens and returned "<|eos|>"; the story ran hintless).
 */
import { describe, it, expect } from 'vitest';
const G = require('../../server/lib/textReplyGuard');

describe('stripControlTokens', () => {
  it('turns an eos-only reply into the empty string, which assessTextReply flags', () => {
    expect(G.stripControlTokens('<|eos|>')).toBe('');
    expect(G.assessTextReply({ text: G.stripControlTokens('<|eos|>'), stop_reason: 'stop' }).reason).toBe('empty');
  });
  it('leaves real content alone, and removes a trailing token', () => {
    expect(G.stripControlTokens('ISSUE → CHANGE')).toBe('ISSUE → CHANGE');
    expect(G.stripControlTokens('hint one<|eos|>')).toBe('hint one');
  });
  it('does not touch ordinary angle brackets', () => {
    expect(G.stripControlTokens('a <b> c | d')).toBe('a <b> c | d');
  });
});

describe('the arc hint pass', () => {
  const src = require('fs').readFileSync('server/lib/beatsPipeline.js', 'utf8');
  it('retries once and records a second failure in the report instead of proceeding silently', () => {
    expect(src).toContain('attempt <= 2 && !arcHints');
    expect(src).toContain("gl.error('arc_hints_failed'");
    expect(src).toContain('hintsFailure,');
  });
});
