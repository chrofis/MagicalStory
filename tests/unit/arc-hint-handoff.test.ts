import { describe, it, beforeAll, expect } from 'vitest';

const { buildBeatsPrompt, buildStoryTextFromBeatsPrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const HINTS = [
  'ISSUE: Nia vanishes after the tree. → CHANGE: Keep Nia on a short leash beside Max through every later beat.',
  'ISSUE: The four never exchange names. → CHANGE: Let them say their names while they first lift the jacket together.',
].join('\n');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});

/**
 * The hint pass reviews the ARC and has never seen the planner's picture rules;
 * its own brief is a story one. Measured over the 42 CHANGE lines stored across
 * 14 staging runs: 16 mandate a figure's continued presence ("keep X beside Y
 * through every later beat") against a cap of three named characters in frame,
 * and 10 mandate simultaneity ("while they lift the jacket") against "two
 * characters given different actions at one instant lose one of them".
 *
 * The planner's heading was a bare imperative — "apply these while dividing the
 * pages" — so it honoured the hint and broke the rule. The escape already
 * existed on the other side and only the planner was not told.
 */
describe('an arc hint is a story change, not a licence to break a picture rule', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the planner is told a hint yields to the picture rules', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: HINTS });
    expect(p).toContain('# FIX WHILE DIVIDING — apply these where the division can carry them');
    expect(p).toContain('Never break a rule below to honour a hint.');
    expect(p).not.toContain('apply these while dividing the pages');
  });

  it('it names the two collisions the measurement found, so the rule is actionable', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: HINTS });
    expect(p).toContain('a figure kept in frame past the cast limit');
    expect(p).toContain('two actions at one instant');
  });

  it('the hand-off is a contract: what the planner drops, the text picks up', () => {
    // The planner defers TO the text…
    const plan = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: HINTS });
    expect(plan).toContain('leave it to the text, which is told to apply what the division has not');
    // …and the text is in fact told exactly that. If this half ever changes, a
    // hint the planner could not draw is lost by both stages.
    const text = buildStoryTextFromBeatsPrompt(input(), [], [], '1. A story.', { arcHints: HINTS });
    expect(text).toBeTruthy();
    expect(text).toContain('# HINTS — apply these in the text where the beats have not');
  });

  it('the hint block still carries the hints themselves, verbatim', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: HINTS });
    expect(p).toContain('Keep Nia on a short leash beside Max through every later beat.');
  });

  it('no hints, no block and no orphan clause', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).not.toContain('FIX WHILE DIVIDING');
    expect(p).not.toContain('Never break a rule below to honour a hint.');
  });
});
