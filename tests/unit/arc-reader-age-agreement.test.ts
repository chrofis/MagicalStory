import { describe, it, beforeAll, expect } from 'vitest';

const { buildArcCreatePrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

/**
 * The arc-create prompt for staging job_1789759147125_p08djwhbl named the
 * reader's age three ways: "MINI HERO'S JOURNEY (age 5)" and "The child this
 * book is for is five" from the band tokens, "read aloud to a 3-5 year old"
 * from a band→label map, over a cast aged 5, 3, 3, 3. It then told the creator
 * to pitch the props at "someone that age" without saying which.
 *
 * Owner, 2026-09-19: the age is the OLDEST main character — the child who
 * carries the book — and every line names it.
 */
describe('one reader age, named the same way everywhere', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  const input = (characters: any[], mainCharacters: string[]) => ({
    pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
    characters, mainCharacters,
  });

  it('names the oldest main character, not the youngest and not a range', () => {
    const p = buildArcCreatePrompt(input([
      { id: 'a', name: 'Levin', age: 5 },
      { id: 'b', name: 'Julian', age: 3 },
      { id: 'c', name: 'Max', age: 3 },
    ], ['a', 'b']), 18, {});
    expect(p).toContain("MINI HERO'S JOURNEY (age 5)");
    expect(p).toContain('The child this book is for is five.');
    expect(p).toContain('read aloud to a five-year-old');
    expect(p).not.toContain('read aloud to a 3-5 year old');
  });

  it('scales with the cast — an older main moves every line together', () => {
    const p = buildArcCreatePrompt(input([
      { id: 'a', name: 'Nora', age: 8 },
      { id: 'b', name: 'Tim', age: 4 },
    ], ['a', 'b']), 18, {});
    expect(p).toContain('The child this book is for is eight.');
    expect(p).toContain('read aloud to an eight-year-old');
  });

  it('falls back to the band range only when no age is recorded', () => {
    const p = buildArcCreatePrompt(input([{ id: 'a', name: 'Levin' }], ['a']), 18, {});
    expect(p).toContain('read aloud to a 3-5 year old');
  });
});
