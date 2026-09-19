import { describe, it, beforeAll, expect } from 'vitest';

const { buildArcCreatePrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

/**
 * The arc-create prompt for staging job_1789759147125_p08djwhbl set the peril
 * level three times and three ways:
 *
 *   STORY SHAPE          "Nothing frightening beyond a moment."
 *   MINI HERO'S JOURNEY  "Humour and mild peril. A chase, a close call, a
 *                         night out in the cold are fine."
 *   RULES OF THE TELLING "Frightening is the right level" (+ no death, nobody
 *                         monstrous, everyone reunited)
 *
 * A night out in the cold was explicitly fine and over the cap at once. The
 * reading-level line governs how hard the CHALLENGES are; the telling rules own
 * how frightening the book may get, and say so once.
 */
describe('peril has one ceiling', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const simplest = {
    pages: 10, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
    characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
  };

  it('the reading-level line no longer rules on fear', () => {
    const p = buildArcCreatePrompt(simplest, 10, {});
    expect(p).not.toContain('Nothing frightening beyond a moment');
    // What it does own — challenge difficulty — survives.
    expect(p).toContain('every challenge is one a small child solves by trying, asking or noticing');
  });

  it('the telling rules still state the ceiling', () => {
    const p = buildArcCreatePrompt(simplest, 10, {});
    expect(p).toContain('Frightening is the right level');
    expect(p).toContain('could lead to death');
  });

  it('the band and the ceiling agree rather than contradict', () => {
    const p = buildArcCreatePrompt(simplest, 10, {});
    if (p.includes('Humour and mild peril')) {
      expect(p).toContain('a night out in the cold are fine');
      expect(p).not.toContain('Nothing frightening beyond a moment');
    }
  });
});
