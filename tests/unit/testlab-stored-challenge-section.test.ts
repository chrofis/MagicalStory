/**
 * arc_effort `challengesFromStory` lifts the story's own challenge draw out of
 * its stored create prompt. Stories drawn before the [C###] ids list bare
 * "- <challenge>" lines; Lab #1468 threw on one (job_1789420511893_zly5rcdej).
 * Both stored shapes are read; a prompt with no section still fails loudly.
 */
import { describe, it, expect } from 'vitest';

const { storedChallengeSection } = require('../../server/lib/testlab');
const { CHALLENGE_IDEAS_HEADING } = require('../../server/lib/promptBuilders');

const story = (section: string) => ({ arcReviewReport: { createPrompt: `# THE COMMISSION\nx\n\n${section}\n\n# BUDGETS\n- at most 5-8 events.` } });

describe('storedChallengeSection', () => {
  it('re-heads a draw with [C###] ids under today\'s heading', () => {
    const out = storedChallengeSection(story('# CHALLENGE IDEAS (old heading)\nold line\n\n- [C012] A door is too small\n- [C040] A bridge is out'));
    expect(out).toBe([...CHALLENGE_IDEAS_HEADING, '', '- [C012] A door is too small', '- [C040] A bridge is out'].join('\n'));
  });

  it('reuses an id-less draw as it stands, without the tag line', () => {
    const out = storedChallengeSection(story('# CHALLENGE IDEAS (drawn at random)\nBuild from about three.\n\n- Bring fruit out of season (tests: resourcefulness)\n- The doorway is the wrong size (tests: adaptation)'));
    expect(out.split('\n').slice(-2)).toEqual(['- Bring fruit out of season (tests: resourcefulness)', '- The doorway is the wrong size (tests: adaptation)']);
    expect(out).not.toContain('[C###]');
    expect(out).not.toContain('at most 5-8 events');
    expect(out.startsWith(CHALLENGE_IDEAS_HEADING[0])).toBe(true);
  });

  it('fails loudly with no section, or a section with no entries', () => {
    expect(() => storedChallengeSection(story('# OTHER\n- a line'))).toThrow(/has no # CHALLENGE IDEAS section/);
    expect(() => storedChallengeSection(story('# CHALLENGE IDEAS\nnothing listed'))).toThrow(/lists no challenge entries/);
  });
});
