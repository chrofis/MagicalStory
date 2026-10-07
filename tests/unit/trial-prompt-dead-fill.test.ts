/**
 * The trial writer's fill hands `fillTemplate` only keys its template reads.
 *
 * `buildTrialStoryPrompt` used to pass `LANGUAGE_NOTE` although
 * `prompts/story-trial.txt` carries no `{LANGUAGE_NOTE}` — a dead fill: the
 * value was computed and dropped on every trial, and a reader of the builder
 * believed the note reached the writer (BACKLOG 2026-09-19, undeclared-keys
 * list, `storyTrial` entry). `fillTemplate` substitutes every key it is
 * given, so a probe template made of the one placeholder shows whether the
 * builder still passes it: the note's text means it does, an empty string
 * means it does not.
 */
import { describe, it, beforeAll, afterAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

const inputData: any = {
  characters: [{ id: 'c1', name: 'Mia', age: 6, gender: 'girl' }],
  mainCharacters: ['c1'],
  language: 'de-de',
  storyCategory: 'adventure',
  storyTheme: 'pirates',
  storyDetails: 'A quiet afternoon.',
  artStyle: 'watercolor',
};

describe('buildTrialStoryPrompt — no dead fill keys', () => {
  let realTrial: string;
  beforeAll(async () => {
    await loadPromptTemplates();
    realTrial = PROMPT_TEMPLATES.storyTrial;
  });
  afterAll(() => { PROMPT_TEMPLATES.storyTrial = realTrial; });

  it('the template reads no {LANGUAGE_NOTE}', () => {
    expect(realTrial).not.toContain('{LANGUAGE_NOTE}');
  });

  it('the builder passes no LANGUAGE_NOTE', () => {
    PROMPT_TEMPLATES.storyTrial = '{LANGUAGE_NOTE}';
    expect(PB.buildTrialStoryPrompt(inputData, 4)).toBe('');
  });
});
