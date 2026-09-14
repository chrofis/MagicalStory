/**
 * Boundary guard: a prompt must never reach a model with an unfilled
 * `{PLACEHOLDER}` token in it.
 *
 * Regression origin (2026-09-14): `evaluateSheetRow` called `fillTemplate`
 * only on its `which === 'bodies'` branch, so the head-row garment judge was
 * handed the literal string `{REQUESTED_OUTFIT}` and had nothing to compare
 * against — a rule shipped the day before could never fire. `fillTemplate`'s
 * own warn-then-strip could not catch it, because that caller never called
 * `fillTemplate` at all.
 */
import { describe, it, expect } from 'vitest';

const {
  assertPromptFilled,
  guardPromptString,
  PLACEHOLDER_EXEMPT,
} = require('../../server/services/prompts');

describe('assertPromptFilled', () => {
  it('throws in test mode on a surviving placeholder, naming the token and the caller', () => {
    expect(() => assertPromptFilled('Compare it to {REQUESTED_OUTFIT}.', 'evaluateSheetRow'))
      .toThrow(/REQUESTED_OUTFIT/);
    expect(() => assertPromptFilled('Compare it to {REQUESTED_OUTFIT}.', 'evaluateSheetRow'))
      .toThrow(/evaluateSheetRow/);
  });

  it('names every distinct token once', () => {
    try {
      assertPromptFilled('{A_ONE} then {B_TWO} then {A_ONE}', 'ctx');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('PROMPT_UNFILLED_PLACEHOLDER');
      expect(e.tokens).toEqual(['{A_ONE}', '{B_TWO}']);
    }
  });

  it('passes a fully filled prompt', () => {
    expect(assertPromptFilled('Compare it to a red raincoat.', 'ctx')).toEqual([]);
  });

  it('passes JSON braces, lowercase and mixed-case braces', () => {
    const p = 'Reply as {"assignments": [{"element": 1}]} — not {lowercase} nor {MixedCase} nor {}.';
    expect(assertPromptFilled(p, 'ctx')).toEqual([]);
  });

  it('scans Gemini parts arrays and ignores inline image data', () => {
    const parts = [
      { inline_data: { mime_type: 'image/png', data: 'AAAABBBB' } },
      { text: 'Judge the sheet against {REQUESTED_OUTFIT}.' },
    ];
    expect(() => assertPromptFilled(parts, 'callSheetJudge')).toThrow(/REQUESTED_OUTFIT/);
  });

  it('scans OpenAI-style message arrays', () => {
    const messages = [{ role: 'user', content: 'Outfit: {EXPECTED_CLOTHING}' }];
    expect(() => assertPromptFilled(messages, 'callOpenRouterVisionAPI')).toThrow(/EXPECTED_CLOTHING/);
  });

  it('ignores a null/empty prompt', () => {
    expect(assertPromptFilled(null, 'ctx')).toEqual([]);
    expect(assertPromptFilled('', 'ctx')).toEqual([]);
  });

  it('honours the named exemption list', () => {
    PLACEHOLDER_EXEMPT.add('{EXAMPLE_TOKEN}');
    try {
      expect(assertPromptFilled('Show me {EXAMPLE_TOKEN}.', 'ctx')).toEqual([]);
    } finally {
      PLACEHOLDER_EXEMPT.delete('{EXAMPLE_TOKEN}');
    }
  });
});

describe('guardPromptString', () => {
  it('returns a clean prompt unchanged', () => {
    expect(guardPromptString('all filled in', 'ctx')).toBe('all filled in');
  });

  it('throws in test mode rather than silently stripping', () => {
    expect(() => guardPromptString('hole: {MISSING_ONE}', 'ctx')).toThrow(/MISSING_ONE/);
  });

  it('passes through non-strings untouched', () => {
    expect(guardPromptString(undefined as any, 'ctx')).toBe(undefined);
  });
});

describe('the evaluateSheetRow heads-branch regression', () => {
  it('catches a prompt built the way the heads branch used to build it', () => {
    // The bodies branch filled the template; the heads branch passed the raw
    // template straight through. Both prompts are built here the two old ways.
    const template = 'Does every head wear {REQUESTED_OUTFIT}? Answer yes or no.';
    const bodies = template.replace('{REQUESTED_OUTFIT}', 'a red raincoat');
    const heads = template; // the bug: no fillTemplate call at all

    expect(assertPromptFilled(bodies, 'evaluateSheetRow:bodies')).toEqual([]);
    expect(() => assertPromptFilled(heads, 'evaluateSheetRow:heads'))
      .toThrow(/REQUESTED_OUTFIT/);
  });
});
