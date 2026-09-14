import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  RISK_FRAMING_RULE,
  buildTellingRulesSection,
  buildTrialStoryPrompt,
  buildUnifiedStoryPrompt,
} = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

// The risk-FRAMING rule is one constant with four consumers: {TELLING_RULES}
// (arc-create / arc-retell) and the {RISK_FRAMING} placeholder in the three
// templates that never receive that block. These tests pin the CONTRACT — the
// rule reaches every writer prompt, byte-identical — not its wording, which is
// read from the exported constant.

const input = (extra: Record<string, unknown> = {}) => ({
  language: 'en',
  readingLevel: '2nd-grade',
  storyCategory: 'adventure',
  storyTheme: 'adventure',
  storyDetails: 'a kite caught in a tree',
  characters: [{ name: 'Mia', age: 8, gender: 'female', isMain: true }],
  ...extra,
});

beforeAll(async () => {
  await loadPromptTemplates();
});

describe('risk-framing rule reaches every stage that writes story prose', () => {
  it('rides in the arc prompts\' shared telling-rules block', () => {
    expect(buildTellingRulesSection(input())).toContain(RISK_FRAMING_RULE);
  });

  it('reaches the trial writer, which runs no review stage', () => {
    expect(buildTrialStoryPrompt(input({ trialMode: true }), 5)).toContain(RISK_FRAMING_RULE);
  });

  it('reaches both unified variants — image-first (default) and text-first', () => {
    for (const storyPromptVariant of ['imageFirst', 'textFirst']) {
      const prompt = buildUnifiedStoryPrompt(input({ storyPromptVariant }), 12);
      expect(prompt, storyPromptVariant).toContain(RISK_FRAMING_RULE);
    }
  });

  it('sits beside the peril rule without replacing it', () => {
    const rules = buildTellingRulesSection(input());
    expect(rules).toContain('could lead to death');
    expect(rules.indexOf(RISK_FRAMING_RULE)).toBeGreaterThan(rules.indexOf('could lead to death'));
  });

  it('leaves no unfilled placeholder in any writer prompt', () => {
    const built = [
      buildTrialStoryPrompt(input({ trialMode: true }), 5),
      buildUnifiedStoryPrompt(input({ storyPromptVariant: 'imageFirst' }), 12),
      buildUnifiedStoryPrompt(input({ storyPromptVariant: 'textFirst' }), 12),
    ];
    for (const prompt of built) expect(prompt).not.toContain('{RISK_FRAMING}');
  });
});
