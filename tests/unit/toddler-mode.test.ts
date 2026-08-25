import { describe, it, expect, beforeAll } from 'vitest';

import { createRequire } from 'node:module';

// Both modules are loaded through node's CJS registry, not vitest's ESM graph:
// promptBuilders reaches the template store with a plain require(), and an
// `import` here would hand the test a SECOND copy of it whose loaded templates
// promptBuilders never sees.
const require_ = createRequire(import.meta.url);
const { loadPromptTemplates } = require_('../../server/services/prompts');
const {
  resolveAgeMode,
  pickMainCharacters,
  buildToddlerModeSection,
  buildStoryShapeSection,
} = require_('../../server/lib/promptBuilders');

const char = (id: number, name: string, age: number, isMain: boolean) =>
  ({ id, name, age: String(age), gender: 'male', isMain });

/**
 * Owner rule (2026-08-25): the OLDEST MAIN character decides the age mode, and
 * secondary characters never do. See tasks/toddler-mode-2026-08-25.md.
 */
describe('resolveAgeMode', () => {
  it('is toddler for a single main aged 3 or under', () => {
    expect(resolveAgeMode({ characters: [char(1, 'A', 1, true)], mainCharacters: [1] })).toBe('toddler');
    expect(resolveAgeMode({ characters: [char(1, 'A', 3, true)], mainCharacters: [1] })).toBe('toddler');
  });

  it('is standard from age 4 up', () => {
    expect(resolveAgeMode({ characters: [char(1, 'A', 4, true)], mainCharacters: [1] })).toBe('standard');
    expect(resolveAgeMode({ characters: [char(1, 'A', 5, true)], mainCharacters: [1] })).toBe('standard');
  });

  it('lets the OLDEST main decide when two mains span the boundary', () => {
    expect(resolveAgeMode({
      characters: [char(1, 'A', 5, true), char(2, 'B', 1, true)],
      mainCharacters: [1, 2],
    })).toBe('standard');
  });

  it('ignores an older SECONDARY character', () => {
    expect(resolveAgeMode({
      characters: [char(1, 'A', 1, true), char(2, 'B', 5, false)],
      mainCharacters: [1],
    })).toBe('toddler');
  });

  it('reads isMain flags when no mainCharacters id array is given (idea-generation payload)', () => {
    expect(resolveAgeMode({ characters: [char(1, 'A', 5, true), char(2, 'B', 1, true)] })).toBe('standard');
    expect(resolveAgeMode({ characters: [char(1, 'A', 1, true), char(2, 'B', 5, false)] })).toBe('toddler');
  });

  it('reads isMainCharacter, the flag the story pipeline stamps on its objects', () => {
    const pipelineChar = (id: number, name: string, age: number, main: boolean) =>
      ({ id, name, age: String(age), gender: 'male', role: main ? 'main' : 'secondary', isMainCharacter: main });
    expect(resolveAgeMode({ characters: [pipelineChar(1, 'A', 1, true), pipelineChar(2, 'B', 5, false)] })).toBe('toddler');
    expect(resolveAgeMode({ characters: [pipelineChar(1, 'A', 5, true), pipelineChar(2, 'B', 1, false)] })).toBe('standard');
  });

  it('falls back to standard when the age is missing or the cast is empty', () => {
    expect(resolveAgeMode({ characters: [{ id: 1, name: 'A', isMain: true }], mainCharacters: [1] })).toBe('standard');
    expect(resolveAgeMode({ characters: [] })).toBe('standard');
    expect(resolveAgeMode({})).toBe('standard');
  });
});

describe('pickMainCharacters', () => {
  it('sorts mains oldest first, so the focus IS the oldest main', () => {
    // A two-character cast caps mains at one (half the cast), so the younger
    // main drops out entirely and the older one is the focus.
    const { mains, focus } = pickMainCharacters({
      characters: [char(1, 'A', 1, true), char(2, 'B', 5, true)],
      mainCharacters: [1, 2],
    });
    expect(mains.map((c: { name: string }) => c.name)).toEqual(['B']);
    expect(focus.name).toBe('B');
  });

  it('caps mains at two and puts the rest in others', () => {
    const { mains, others } = pickMainCharacters({
      characters: [char(1, 'A', 9, true), char(2, 'B', 8, true), char(3, 'C', 7, true), char(4, 'D', 6, false)],
      mainCharacters: [1, 2, 3],
    });
    expect(mains).toHaveLength(2);
    expect(others.map((c: { name: string }) => c.name)).toEqual(['C', 'D']);
  });
});

describe('buildToddlerModeSection', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('returns the content rules only in toddler mode', () => {
    const toddler = buildToddlerModeSection({ characters: [char(1, 'A', 2, true)], mainCharacters: [1] });
    expect(toddler).toContain('TODDLER MODE');
    expect(buildToddlerModeSection({ characters: [char(1, 'A', 6, true)], mainCharacters: [1] })).toBe('');
  });

  it('never prescribes a text length — that belongs to the reading level', () => {
    const toddler = buildToddlerModeSection({ characters: [char(1, 'A', 2, true)], mainCharacters: [1] });
    expect(toddler).not.toMatch(/words? per page|sentences per page|\d+\s*[-–]\s*\d+\s*words/i);
  });
});

describe('buildStoryShapeSection', () => {
  it('asks for one small setback and a range of feelings, not the computed challenge budget', () => {
    const shape = buildStoryShapeSection({
      characters: [char(1, 'A', 1, true)], mainCharacters: [1], storyTheme: 'pirate',
    }, 6);
    // One small thing goes wrong and comes right (owner, 2026-08-25) — NOT the
    // multi-challenge page budget, which prices work a toddler cannot do.
    expect(shape).toMatch(/Challenges: one, small/);
    expect(shape).toMatch(/Feelings: three different ones/);
    expect(shape).not.toMatch(/major challenge/);
    expect(shape).toMatch(/6 distinct events/);
  });

  // Traits are optional (owner, 2026-08-25): "it can be that we do not have any
  // child traits... if we have traits we use them. If not we take something
  // generic. Both must work."
  const shapeFor = (traits: unknown) => buildStoryShapeSection(
    { characters: [{ ...char(1, 'A', 1, true), traits }], mainCharacters: [1] }, 6);

  it('makes the traits the page plan when the character has any', () => {
    expect(shapeFor({ strengths: ['Mutig'], flaws: [], challenges: [], specialDetails: '' }))
      .toMatch(/traits are the page plan/);
    expect(shapeFor(['Fröhlich'])).toMatch(/traits are the page plan/);
    expect(shapeFor({ strengths: [], specialDetails: 'Liebt Hunde' })).toMatch(/traits are the page plan/);
  });

  it('falls back to generic toddler feelings when there are none', () => {
    // The structured-but-empty shape is truthy — a naive check would pass it.
    expect(shapeFor({ strengths: [], flaws: [], challenges: [], specialDetails: '' }))
      .toMatch(/every small child is: hungry, sleepy, curious, delighted, grumpy/);
    expect(shapeFor(undefined)).toMatch(/every small child is/);
    expect(shapeFor(['', '  '])).toMatch(/every small child is/);
  });

  it('keeps the computed challenge budget at every other age', () => {
    const shape = buildStoryShapeSection({
      characters: [char(1, 'A', 5, true)], mainCharacters: [1], storyTheme: 'pirate',
    }, 6);
    expect(shape).toContain('Challenges: exactly 2');
    expect(shape).toContain('major challenge');
  });
});
