// Trial writer: when the costume starts (page 1 in role vs a shown change of clothes) and
// the language of scene hints (docs/decisions.md 2026-10-09 "trial costume page 1").
import { describe, it, expect, beforeAll } from 'vitest';
import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (extra: any = {}) => ({
  language: 'de', pages: 6, storyCategory: 'adventure', storyTheme: 'knight',
  characters: [{ name: 'Emma', age: '6', gender: 'female', isMainCharacter: true }],
  ...extra,
});

describe('trial writer costume rule', () => {
  let costumed = '';
  let plain = '';
  beforeAll(async () => {
    await loadPromptTemplates();
    costumed = trialWriterPrompt(input());
    plain = trialWriterPrompt(input({ storyTheme: 'nothing-configured' }));
  });

  it('a story that opens in role is costumed from page 1; the old "except the very first" rule is gone', () => {
    expect(costumed).toContain('is `costumed` from page 1');
    expect(costumed).not.toContain('except the very first');
  });
  it('a change of clothes is shown in the text of the first costumed page, as an action', () => {
    expect(costumed).toContain('shows that change in the TEXT of the first `costumed` page, as an action');
    expect(costumed).toContain('Self-check before the output');
  });
  it('the majority-costumed rule is kept', () => {
    expect(costumed).toContain('The MAJORITY of scenes (at least 4 out of 6) MUST use `costumed`');
  });
  it('a story with no costume gets neither the costume rule nor the self-check', () => {
    expect(plain).not.toContain('Self-check before the output');
    expect(plain).toContain('always `standard`');
  });
  it('the wording is generic: no story-specific names', () => {
    for (const w of ['Emma', 'Rohan', 'Tobias', 'Rüebli']) expect(costumed.split('Self-check before the output')[1].split('\n')[0]).not.toContain(w);
  });
});

describe('trial scene hints are written in English', () => {
  it('every trial prompt carries the English-hint rule (the full path\'s "all output in English")', async () => {
    await loadPromptTemplates();
    for (const p of [trialWriterPrompt(input()), trialWriterPrompt(input({ language: 'fr' }))]) {
      expect(p).toContain('Every field of a scene hint is written in English, whatever the story language');
    }
  });
});
