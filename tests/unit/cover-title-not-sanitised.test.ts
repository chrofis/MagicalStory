import { describe, it, expect } from 'vitest';

// The bug this file locks down: `sanitizeVbIdsInPrompt` swaps every prop NAME
// for the entry's `type` so a model cannot letter the name onto the prop
// (decisions.md 2026-08-24). It also ran over the baked cover TITLE — the one
// string on a cover that must be lettered verbatim. Staging trial
// job_1788684429841_0flr66gs8: story "Noah and the Crackers at the Zoo", bible
// ART002 named "Crackers" with type "food prop", cover painted
// "Noah and the food prop at the Zoo".

// @ts-expect-error - JS module without types
import { sanitizeVbIdsInPrompt } from '../../server/lib/promptBuilders.js';

const visualBible = {
  mainCharacters: [{ id: 'CHR001', name: 'Noah' }],
  animals: [],
  artifacts: [
    { id: 'ART001', name: 'Pirate hat', type: 'costume hat', description: 'A child-sized black felt pirate hat.' },
    { id: 'ART002', name: 'Crackers', type: 'food prop', description: 'Small square plain crackers, pale golden-beige.' },
  ],
  locations: [],
  vehicles: [],
  clothing: [],
};

const TITLE_LINE = 'Paint "Noah and the Crackers at the Zoo" in the upper third of the canvas as three-dimensional letters that sit as physical objects in the scene.';

describe('sanitizeVbIdsInPrompt: baked cover title is never rewritten', () => {
  it('keeps the quoted title and the prose verbatim', () => {
    const prompt = [
      'Noah holds a sleeve of Crackers, his Pirate hat tipped forward.',
      '**TITLE:**',
      TITLE_LINE,
    ].join('\n');
    const out = sanitizeVbIdsInPrompt(prompt, visualBible, -1);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Noah holds a sleeve of Crackers, his Pirate hat tipped forward.');
    expect(lines[2]).toBe(TITLE_LINE);
    expect(out).not.toContain('BAKED-TITLE');
  });

  it('a title line with no prop name in it is untouched', () => {
    const line = 'Paint "Noah at the Zoo" in the upper third of the canvas as letters.';
    expect(sanitizeVbIdsInPrompt(line, visualBible, -1)).toBe(line);
  });
});
