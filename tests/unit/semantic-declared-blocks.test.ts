import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// A critic judges against the source its generator was given (docs/decisions.md
// 2026-09-26 "Every critic judges against the source the generator was given,
// uncut"). The semantic judge's DECLARED INTERACTIONS and PAGE ELEMENTS blocks
// were read from the image prompt, which on every pipeline eval is the prose
// with its METADATA stripped, and no bible was passed: 80 of 80 stored staging
// semantic prompts carried "(none declared)" / "(none)". They are read from the
// brief now, with the bible, the same source order the quality judge uses.

const BRIEF = [
  'Levin kneels in the grass beside the egg while the small dragon watches.',
  '',
  '```json',
  JSON.stringify({
    objects: ['ART003', 'ANI002'],
    interactions: [{ character: 'Levin', object: 'ART003', where: 'both hands cupped under the egg' }],
    characters: [{ name: 'Levin', looksAt: 'ANI002' }],
    timeOfDay: 'dusk',
    weather: 'clear',
  }),
  '```',
].join('\n');
const STRIPPED = 'Levin kneels in the grass beside the egg while the small dragon watches.';
const VB = {
  artifacts: [{ id: 'ART003', name: 'dragon egg', label: 'dragon egg' }],
  animals: [{ id: 'ANI002', name: 'Nebla', label: 'Nebla' }],
};

let blocks: any;
beforeAll(async () => {
  await require_('../../server/services/prompts.js').loadPromptTemplates();
  blocks = require_('../../server/lib/sceneValidator.js').semanticDeclaredBlocks;
});

describe('semantic judge — DECLARED blocks come from the brief', () => {
  it('reads interactions and elements from the brief when the image prompt is the stripped prose', () => {
    const b = blocks({ sceneHint: BRIEF, imagePrompt: STRIPPED, visualBible: VB });
    expect(b.interactionsBlock).toContain('Levin');
    expect(b.interactionsBlock).toContain('both hands cupped under the egg');
    expect(b.interactionsBlock).not.toContain('ART003');
    expect(b.elementsBlock).toContain('ART003 — dragon egg');
    expect(b.elementsBlock).toContain('ANI002 — Nebla');
    expect(b.declaredLightLine).toMatch(/dusk/);
  });

  it('declares nothing only when the brief declares nothing', () => {
    const b = blocks({ sceneHint: STRIPPED, imagePrompt: STRIPPED, visualBible: VB });
    expect(b.interactionsBlock).toBe('(none declared)');
    expect(b.elementsBlock).toBe('(none)');
  });
});
