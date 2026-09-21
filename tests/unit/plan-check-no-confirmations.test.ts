/**
 * A13 — the plan check reports FAULTS, never confirmations.
 *
 * Round 0 of job_1789853503332_riqncqg1i returned 29 numbered lines, of which
 * 13 confirmed nothing was wrong: 11 under check 7 ("… pays off on page 17;
 * that payoff has the earlier plant"), plus "No peopleless pages." and "No page
 * places two named characters at different heights." parsePlanCheck turns every
 * numbered line into a finding — correctly, since classification belongs to the
 * prompt and a parser may never read a finding's prose — so every confirmation
 * inflated the replan's ALSO NOTED block and the finding counts.
 *
 * The fix is prompt-side: check 7 now asks for the UNPAIRED plants and payoffs
 * only, and the output contract says a line confirming a check found nothing is
 * itself wrong. This file pins both halves — the contract in the built prompt,
 * and the parser's deliberately prose-blind behaviour, which must NOT change.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const inputData: any = {
  characters: [{ id: 'c1', name: 'Mara', age: 7, gender: 'female' }],
  mainCharacters: ['c1'], language: 'en', pages: 2, storyCategory: 'adventure',
};
const BEATS = [
  { pageNumber: 1, planLine: 'wide — Mara — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'close — Mara — she cups the flame — the flame holds' },
];
const PAGE_PLAN = BEATS.map(b => `Page ${b.pageNumber}: ${b.planLine}`).join('\n');

describe('the plan check asks for faults only', () => {
  let prompt: string;
  beforeAll(async () => {
    await loadPromptTemplates();
    prompt = PB.buildPlanCheckPrompt(inputData, BEATS, 'The lamp must be lit.', PAGE_PLAN);
  });

  it('check 7 asks for the unpaired plants and payoffs, not every pair', () => {
    const q7 = prompt.split('# YOUR TASK')[1].split(/^8\./m)[0].split(/^7\./m)[1];
    expect(q7).toBeTruthy();
    // BEHAVIOUR, not wording: the check must state that a paired plant is not
    // reported. Enumerating every pair is what produced 11 confirmations.
    expect(q7).toMatch(/not a finding|no line/i);
    expect(q7).not.toMatch(/Name every object or flaw a page plants and the later page/i);
  });

  it('the output contract forbids a line that confirms a check found nothing', () => {
    const out = prompt.split('# OUTPUT FORMAT')[1];
    expect(out).toMatch(/When a check finds nothing, write no line/i);
    expect(out).toMatch(/is itself wrong/i);
  });
});

describe('parsePlanCheck stays blind to a finding\'s prose', () => {
  it('keeps every numbered line, including one that reads as a confirmation', () => {
    // The parser may only read the leading check number. Teaching it to detect
    // "has the earlier plant" would be pattern-matching prose in code — exactly
    // what the eval-logic rule forbids. Confirmations are removed by the PROMPT.
    const parsed = PB.parsePlanCheck([
      '7 The warm egg planted on page 2 pays off on page 17; that payoff has the earlier plant.',
      '7 The cold wind planted on page 1 has no later payoff.',
      '6 No peopleless pages.',
    ].join('\n'));
    expect(parsed).toHaveLength(3);
    expect(parsed.map((f: any) => f.check)).toEqual([7, 7, 6]);
  });

  it('returns nothing for a clean reply', () => {
    expect(PB.parsePlanCheck('NONE')).toHaveLength(0);
  });
});
