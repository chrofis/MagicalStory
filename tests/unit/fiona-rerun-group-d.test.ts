/**
 * Fiona rerun 2026-10-08, group D (text stages). These pin BEHAVIOUR: a rule
 * reaches every prompt that has to carry it, and the lector and the grammar
 * check stay parity siblings. They do not pin the wording of a rule.
 */
import { describe, it, expect, beforeAll } from 'vitest';

import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input: any = {
  characters: [
    { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'curious' },
    { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy' },
  ],
  mainCharacters: ['c1'],
  language: 'de-ch',
  languageLevel: 'standard',
  pages: 4,
  storyCategory: 'adventure',
  storyTopic: 'pirates',
  artStyle: 'watercolor',
};

const built: Record<string, string> = {};
beforeAll(async () => {
  await loadPromptTemplates();
  built.beats = PB.buildBeatsPrompt(input, 4, { finalArc: '1. A story.' });
  built.check = PB.buildPlanCheckPrompt(input, [{ pageNumber: 1 }], '1. A story.', 'Page 1: wide — Mira — x — y');
  built.writer = PB.buildStoryTextFromBeatsPrompt(input, [{ pageNumber: 1, planLine: 'wide — Mira — x — y' }], [], '1. A story.', { arcHints: '' });
  built.lector = PB.buildTextProofreadPrompt(input, [{ pageNumber: 1, text: 'Mira ging.' }]);
  built.diff = PB.buildTextDiffPrompt(input, [{ pageNumber: 1, before: 'Mira ging.', after: 'Mira lief.', findings: [] }]);
  built.arc = PB.buildArcCreatePrompt(input, 4);
  built.trial = trialWriterPrompt(input, 6);
});

describe('#18 who does what: the planner, its checker and both writers read one rule', () => {
  it.each(['beats', 'check', 'writer', 'trial'])('%s carries it and leaves no placeholder', (name) => {
    expect(built[name]).toContain(PB.WHO_DOES_WHAT_RULE);
    expect(built[name].match(/\{[A-Z][A-Z0-9_]*\}/g) || []).toEqual([]);
  });
});

describe('#18 a promise beyond the ending is named only where the story set it up', () => {
  it('reaches the arc creator through the one given-rule the panel also judges', () => {
    expect(built.arc).toContain(PB.ARC_GIVEN_RULE);
    expect(PB.ARC_GIVEN_RULE).toMatch(/after the ending/);
  });
});

describe('#16 the lector and the grammar check carry the same scope for a correction', () => {
  it('both name the story language variety and what a correction keeps', () => {
    for (const name of ['lector', 'diff']) {
      expect(built[name], name).toContain('Swiss Standard German');
      expect(built[name], name).toMatch(/variety of Swiss Standard German/);
      expect(built[name], name).toMatch(/in which direction/);
      expect(built[name].match(/\{[A-Z][A-Z0-9_]*\}/g) || [], name).toEqual([]);
    }
  });
});
