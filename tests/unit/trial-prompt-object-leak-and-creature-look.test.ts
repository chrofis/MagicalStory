import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const require = createRequire(import.meta.url);
const { loadPromptTemplates } = require('../../server/services/prompts.js');

// Staging trial job_1791450270543_n1iu8ipsu: the stored outlinePrompt read
// "hair detail: [object Object]" (detailedHairAnalysis is an object on trial
// photos), and the creature-tone block, unmarked, was written into page 1.

const input = (age: number) => ({
  trialMode: true,
  language: 'en',
  storyTheme: 'realistic',
  storyDetails: 'a lost duckling',
  characters: [{
    name: 'Omar', age, gender: 'male', isMain: true,
    physical: {
      hairColor: 'brown', eyeColor: 'brown', skinTone: 'light',
      detailedHairAnalysis: { type: 'wavy', lengthTop: 'short', density: 'thick' },
    },
  }],
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('trial writer prompt', () => {
  it('renders structured hair detail as prose, never [object Object]', () => {
    const p = trialWriterPrompt(input(3), 6);
    expect(p).not.toContain('[object Object]');
    expect(p).toMatch(/hair detail: brown, wavy/);
  });

  it('marks the creature look picture-only, before the tone text', () => {
    const p = trialWriterPrompt(input(3), 6);
    const at = p.indexOf('# Creature look (picture only)');
    expect(at).toBeGreaterThan(-1);
    expect(p.slice(at)).toMatch(/never for the story text/);
    expect(p.indexOf('a closed, rounded mouth')).toBeGreaterThan(at);
  });

  it('adds no label when the cast has no readable age', () => {
    const i = input(3);
    i.characters[0].age = undefined as any;
    expect(trialWriterPrompt(i, 6)).not.toContain('Creature look (picture only)');
  });
});
