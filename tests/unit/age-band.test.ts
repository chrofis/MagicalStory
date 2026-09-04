import { describe, it, expect, beforeAll } from 'vitest';

import { createRequire } from 'node:module';

// Both modules are loaded through node's CJS registry, not vitest's ESM graph:
// promptBuilders reaches the template store with a plain require(), and an
// `import` here would hand the test a SECOND copy of it whose loaded templates
// promptBuilders never sees.
const require_ = createRequire(import.meta.url);
const { loadPromptTemplates } = require_('../../server/services/prompts');
const {
  resolveAgeBand,
  pickMainCharacters,
  buildAgeModeSection,
  buildStoryShapeSection,
  challengeCatalogueBands,
} = require_('../../server/lib/promptBuilders');

const char = (id: number, name: string, age: number, isMain: boolean) =>
  ({ id, name, age: String(age), gender: 'male', isMain });

const solo = (age: number) => ({ characters: [char(1, 'A', age, true)], mainCharacters: [1] });

/**
 * Owner rules: five whole-year plot bands below six (2026-09-04), decided by
 * the OLDEST MAIN character and never by a secondary (2026-08-25, retained).
 * See docs/decisions.md.
 */
describe('resolveAgeBand', () => {
  it('maps every whole year 0..7 to its band', () => {
    expect(resolveAgeBand(solo(0))).toBe('routine');
    expect(resolveAgeBand(solo(1))).toBe('routine');
    expect(resolveAgeBand(solo(2))).toBe('quest');
    expect(resolveAgeBand(solo(3))).toBe('tries');
    expect(resolveAgeBand(solo(4))).toBe('fear-choice');
    expect(resolveAgeBand(solo(5))).toBe('journey');
    expect(resolveAgeBand(solo(6))).toBe('standard');
    expect(resolveAgeBand(solo(7))).toBe('standard');
  });

  it('lets the OLDEST main decide when two mains span two bands', () => {
    expect(resolveAgeBand({
      characters: [char(1, 'A', 5, true), char(2, 'B', 1, true)],
      mainCharacters: [1, 2],
    })).toBe('journey');
  });

  it('ignores an older SECONDARY character', () => {
    expect(resolveAgeBand({
      characters: [char(1, 'A', 1, true), char(2, 'B', 8, false)],
      mainCharacters: [1],
    })).toBe('routine');
  });

  it('reads isMain flags when no mainCharacters id array is given (idea-generation payload)', () => {
    expect(resolveAgeBand({ characters: [char(1, 'A', 8, true), char(2, 'B', 1, true)] })).toBe('standard');
    expect(resolveAgeBand({ characters: [char(1, 'A', 2, true), char(2, 'B', 5, false)] })).toBe('quest');
  });

  it('reads isMainCharacter, the flag the story pipeline stamps on its objects', () => {
    const pipelineChar = (id: number, name: string, age: number, main: boolean) =>
      ({ id, name, age: String(age), gender: 'male', role: main ? 'main' : 'secondary', isMainCharacter: main });
    expect(resolveAgeBand({ characters: [pipelineChar(1, 'A', 3, true), pipelineChar(2, 'B', 9, false)] })).toBe('tries');
    expect(resolveAgeBand({ characters: [pipelineChar(1, 'A', 9, true), pipelineChar(2, 'B', 1, false)] })).toBe('standard');
  });

  it('falls back to standard when the age is missing or the cast is empty', () => {
    expect(resolveAgeBand({ characters: [{ id: 1, name: 'A', isMain: true }], mainCharacters: [1] })).toBe('standard');
    expect(resolveAgeBand({ characters: [] })).toBe('standard');
    expect(resolveAgeBand({})).toBe('standard');
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

describe('buildAgeModeSection', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('returns the band-specific content rules below six', () => {
    expect(buildAgeModeSection(solo(1))).toContain('# ROUTINE BOOK');
    expect(buildAgeModeSection(solo(2))).toContain('# REPETITION QUEST');
    expect(buildAgeModeSection(solo(3))).toContain('# THREE TRIES');
    expect(buildAgeModeSection(solo(4))).toContain('# FEAR AND CHOICE');
    expect(buildAgeModeSection(solo(5))).toContain("# MINI HERO'S JOURNEY");
  });

  it('is empty from age six up and when the age is unknown', () => {
    expect(buildAgeModeSection(solo(6))).toBe('');
    expect(buildAgeModeSection(solo(9))).toBe('');
    expect(buildAgeModeSection({ characters: [{ id: 1, name: 'A', isMain: true }] })).toBe('');
  });

  it('never prescribes a text length — that belongs to the reading level', () => {
    for (const age of [0, 1, 2, 3, 4, 5]) {
      expect(buildAgeModeSection(solo(age)))
        .not.toMatch(/words? per page|sentences per page|\d+\s*[-–]\s*\d+\s*words/i);
    }
  });

  it('keeps the safety rules in the two youngest bands', () => {
    for (const age of [1, 2]) {
      const section = buildAgeModeSection(solo(age));
      expect(section).toMatch(/cannot chew or swallow safely/);
      expect(section).toMatch(/Nothing appears from nowhere/);
      expect(section).toMatch(/opens and closes where the child really is/);
    }
  });
});

describe('buildStoryShapeSection', () => {
  const shapeAt = (age: number, pages = 6) => buildStoryShapeSection(
    { characters: [char(1, 'A', age, true)], mainCharacters: [1], storyTheme: 'pirate' }, pages);

  it('gives the routine band one small setback and a range of feelings, not a challenge budget', () => {
    const shape = shapeAt(1);
    expect(shape).toMatch(/Challenges: one, small/);
    expect(shape).toMatch(/Feelings: three different ones/);
    expect(shape).not.toMatch(/major challenge/);
    expect(shape).toMatch(/6 distinct events/);
  });

  it('gives the quest band one tiny goal and a repeated search', () => {
    const shape = shapeAt(2);
    expect(shape).toMatch(/Goal: one tiny thing/);
    expect(shape).toMatch(/one place per page/);
    expect(shape).not.toMatch(/major challenge/);
  });

  it('gives the tries band one challenge met three times', () => {
    const shape = shapeAt(3);
    expect(shape).toMatch(/Challenges: one, met three times/);
    expect(shape).toMatch(/two tries fail, the third succeeds/);
    expect(shape).not.toMatch(/major challenge/);
  });

  it('keeps the computed challenge budget for fear-choice and adds its resolution rule', () => {
    const shape = shapeAt(4);
    expect(shape).toContain('Challenges: exactly 2');
    expect(shape).toContain('major challenge');
    expect(shape).toMatch(/resolve through the main character's own choice/);
  });

  it('requires a real low point in the journey band', () => {
    const shape = shapeAt(5);
    expect(shape).toContain('Challenges: exactly 2');
    expect(shape).toMatch(/A real low point before the end is required/);
  });

  it('carries the band difficulty rule into the lean arc variant too', () => {
    const arc = buildStoryShapeSection(
      { characters: [char(1, 'A', 5, true)], mainCharacters: [1] }, 6, { arc: true });
    expect(arc).toMatch(/A real low point before the end is required/);
    expect(arc).not.toMatch(/Page budget/);
  });

  it('leaves age six and up on the standard shape with no band rule and no soften line', () => {
    const shape = shapeAt(6, 24);
    expect(shape).toContain('major challenge');
    expect(shape).toMatch(/Challenges: exactly \d/);
    expect(shape).not.toMatch(/low point before the end/);
    expect(shape).not.toMatch(/own choice/);
    // The old blanket "the focus character is very young" soften is gone.
    expect(shape).not.toMatch(/focus character is very young/);
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

  it('falls back to generic small-child feelings when there are none', () => {
    // The structured-but-empty shape is truthy — a naive check would pass it.
    expect(shapeFor({ strengths: [], flaws: [], challenges: [], specialDetails: '' }))
      .toMatch(/every small child is: hungry, sleepy, curious, delighted, grumpy/);
    expect(shapeFor(undefined)).toMatch(/every small child is/);
    expect(shapeFor(['', '  '])).toMatch(/every small child is/);
  });
});

describe('challengeCatalogueBands', () => {
  it('gives the three simple bands no catalogue at all', () => {
    expect(challengeCatalogueBands(solo(0))).toEqual([]);
    expect(challengeCatalogueBands(solo(2))).toEqual([]);
    expect(challengeCatalogueBands(solo(3))).toEqual([]);
  });

  it('gives fear-choice the youngest band and journey the two youngest', () => {
    expect(challengeCatalogueBands(solo(4))).toEqual(['3']);
    expect(challengeCatalogueBands(solo(5))).toEqual(['3', '6']);
  });

  it('keeps the youngest-cast-member logic from age six up', () => {
    // The YOUNGEST cast member picks the bands in standard mode, main or not.
    expect(challengeCatalogueBands({
      characters: [char(1, 'A', 8, true), char(2, 'B', 4, false)], mainCharacters: [1],
    })).toEqual(['3']);
    expect(challengeCatalogueBands(solo(8))).toEqual(['3', '6']);
    expect(challengeCatalogueBands(solo(12))).toEqual(['6', '9']);
  });

  it('treats an unknown age as standard with the default youngest of eight', () => {
    expect(challengeCatalogueBands({ characters: [{ id: 1, name: 'A', isMain: true }] })).toEqual(['3', '6']);
  });
});
