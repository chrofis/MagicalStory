import { describe, it, beforeAll, expect } from 'vitest';

const { drawChallengeIdeas, buildChallengeIdeasSection, buildArcCreatePrompt } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const inputData = {
  pages: 18,
  characters: [{ name: 'Levin', age: 5 }, { name: 'Julian', age: 3 }],
};

/**
 * Variety used to be an INSTRUCTION: the arc prompt carried "This reader's
 * earlier books used these challenges — this story uses different ones" plus
 * prose lifted from those books' arcs. On staging job_1789759147125_p08djwhbl
 * that block told the creator to avoid the very premise the family had
 * commissioned, and carried three other stories' characters by name.
 * It is now a SELECTION rule applied to the draw.
 */
describe('the draw excludes what earlier books were offered', () => {
  it('returns the catalogue ids it drew, one per offered line', () => {
    const draw = drawChallengeIdeas(inputData, { count: 15 });
    const lines = draw.section.split('\n').filter((l: string) => l.startsWith('- '));
    expect(draw.ids.length).toBe(lines.length);
    expect(draw.ids.every((id: number) => Number.isInteger(id))).toBe(true);
    expect(new Set(draw.ids).size).toBe(draw.ids.length);
  });

  it('never draws an excluded id', () => {
    const first = drawChallengeIdeas(inputData, { count: 15 });
    const second = drawChallengeIdeas(inputData, { count: 15, excludeIds: first.ids });
    expect(second.ids.length).toBeGreaterThan(0);
    for (const id of second.ids) expect(first.ids).not.toContain(id);
  });

  it('drops the exclusions rather than draw from a starved pool', () => {
    // Every id in the band excluded: a thin, spread-less draw is worse for the
    // story than a repeat, so the draw falls back to the full band.
    const all = Array.from({ length: 400 }, (_, i) => i + 1);
    const draw = drawChallengeIdeas(inputData, { count: 15, excludeIds: all });
    expect(draw.ids.length).toBeGreaterThan(0);
  });

  it('tolerates junk in the exclusion list', () => {
    const draw = drawChallengeIdeas(inputData, { count: 15, excludeIds: [null, 'x', NaN, undefined] as any });
    expect(draw.ids.length).toBeGreaterThan(0);
  });
});

describe('no prompt mentions a previous story', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the arc-create prompt carries no earlier-book block', () => {
    const prompt = buildArcCreatePrompt(
      { ...inputData, storyDetails: 'Vier Buben finden ein Ei.', language: 'de-CH', title: 'Das Ei' }, 18, {});
    expect(prompt).toBeTruthy();
    expect(prompt).not.toMatch(/earlier books/i);
    expect(prompt).not.toMatch(/this reader's/i);
    expect(prompt).not.toContain('{PRIOR_CHALLENGES}');
  });

  it('buildChallengeIdeasSection still returns the section alone', () => {
    const s = buildChallengeIdeasSection(inputData);
    expect(typeof s).toBe('string');
    expect(s).toContain('# CHALLENGE IDEAS');
  });
});
