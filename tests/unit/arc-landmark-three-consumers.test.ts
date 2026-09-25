/**
 * A14 — the REAL LANDMARKS block is ONE constant with THREE consumers.
 *
 * The arc CREATE prompt carried the list (and the photo-vantage rule); the
 * PANEL and the RE-TELL did not. The re-tell was nevertheless told to keep
 * landmarks "inside the commission's world", and duly introduced a real place
 * that was never on the list; the panel, the only independent reader of the
 * arc, could not catch it because it had never seen the list either.
 *
 * Pins BEHAVIOUR (the landmark input reaching all three prompts), never wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const landmarks = [
  {
    name: 'Probelinde', type: 'Square', wikipediaExtract: 'A hilltop square with lime trees.',
    photoVariants: [{ kind: 'exterior', description: 'Gravel square seen from the street' }],
  },
];
const inputData: any = {
  language: 'de-ch', languageLevel: 'grade1',
  characters: [{ id: 'c1', name: 'Levin', age: 7, gender: 'male', personality: 'curious' }],
  mainCharacters: ['c1'],
  availableLandmarks: landmarks,
};

const build = (data: any) => ({
  create: PB.buildArcCreatePrompt(data, 18),
  panel: PB.buildArcPanelPrompt(data, 'ARC: a committed arc'),
  retell: PB.buildArcRetellPrompt(data, 18, 'ARC: a committed arc', 'SOLUTION: one'),
});

describe('arc machine: landmark list reaches create, panel and retell', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('every consumer carries the landmark and its photo-vantage rule', () => {
    const built = build(inputData);
    for (const [stage, prompt] of Object.entries(built)) {
      expect(prompt, `${stage} built`).toBeTruthy();
      expect(prompt, `${stage} names the landmark`).toContain('- Probelinde [Square]');
      expect(prompt, `${stage} carries the photo-vantage rule`).toContain('one of its photos shows');
      expect(prompt, `${stage} has no unfilled placeholder`).not.toMatch(/\{AVAILABLE_LANDMARKS_SECTION\}/);
    }
  });

  it('negative control: no landmarks in, no landmark name out', () => {
    const built = build({ ...inputData, availableLandmarks: [] });
    for (const [stage, prompt] of Object.entries(built)) {
      expect(prompt, `${stage}`).not.toContain('Probelinde');
      expect(prompt, `${stage}`).not.toMatch(/\{AVAILABLE_LANDMARKS_SECTION\}/);
    }
  });

  it('the panel probes the arc against the list', () => {
    expect(build(inputData).panel).toMatch(/^- LANDMARK — /m);
  });
});
