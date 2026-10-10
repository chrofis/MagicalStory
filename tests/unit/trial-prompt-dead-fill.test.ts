/**
 * The trial writer's fill hands `fillTemplate` only keys its template reads.
 *
 * `buildTrialStoryPrompt` (now the arc and pages builders) used to pass `LANGUAGE_NOTE` although
 * `prompts/story-trial-*.txt` carry no `{LANGUAGE_NOTE}` — a dead fill: the
 * value was computed and dropped on every trial, and a reader of the builder
 * believed the note reached the writer (BACKLOG 2026-09-19, undeclared-keys
 * list, `storyTrial` entry, since replaced by storyTrialArc/Pages). `fillTemplate` substitutes every key it is
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

describe('the trial writer prompt builders — no dead fill keys', () => {
  const keys = ['storyTrialArc', 'storyTrialPages'] as const;
  const real: Record<string, string> = {};
  beforeAll(async () => {
    await loadPromptTemplates();
    for (const k of keys) real[k] = PROMPT_TEMPLATES[k];
  });
  afterAll(() => { for (const k of keys) PROMPT_TEMPLATES[k] = real[k]; });

  it.each(keys)('the %s template reads no {LANGUAGE_NOTE}', (k) => {
    expect(real[k]).not.toContain('{LANGUAGE_NOTE}');
  });

  it('the builders pass no LANGUAGE_NOTE', () => {
    PROMPT_TEMPLATES.storyTrialArc = '{LANGUAGE_NOTE}';
    expect(PB.buildTrialArcPrompt(inputData, 4)).toBe('');
    PROMPT_TEMPLATES.storyTrialPages = '{LANGUAGE_NOTE}';
    expect(PB.buildTrialPagesPrompt(inputData, 4, 'arc')).toBe('');
  });
});
