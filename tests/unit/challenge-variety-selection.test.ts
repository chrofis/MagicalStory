import { describe, it, beforeAll, expect } from 'vitest';

const { drawChallengeIdeas, buildChallengeIdeasSection, buildArcCreatePrompt, parseArcRetell } = require('../../server/lib/promptBuilders');
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
    // Every id in the band excluded: a draw that cannot be filled at all is a
    // broken input, so the exclusion is abandoned rather than shipped thin.
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

/**
 * OLDEST-FIRST SHEDDING (2026-09-20).
 *
 * The valve this replaced was all-or-nothing: one book of memory too many and
 * the ENTIRE exclusion list was discarded, so the draw ran completely
 * unfiltered — the reader most likely to notice a repeat (the one who just
 * finished a book) got no protection at all. The memory is now trimmed from
 * the OLD end until the pool fits, and the newest book never pays for the
 * oldest one.
 *
 * These pin the SHEDDING BEHAVIOUR, not the floor's numeric value: each case
 * builds an exclusion whose size is derived from the band's real pool.
 */
describe('oldest-first shedding of the exclusion memory', () => {
  // The band the fixture resolves to (youngest is 3), measured from the real
  // catalogue via an unfiltered draw's own view of what it may draw.
  const eligibleIds = (): number[] => {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) {
      for (const id of drawChallengeIdeas(inputData, { count: 25 }).ids) seen.add(id);
    }
    return [...seen];
  };

  it('honours every book when the pool stays above the floor', () => {
    // Three books of five ids each: trivially affordable in any band.
    const books = [[11, 12, 13, 14, 15], [21, 22, 23, 24, 25], [31, 32, 33, 34, 35]];
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: books });
    expect(draw.offeredStories).toBe(3);
    expect(draw.effectiveStories).toBe(3);
    for (const id of draw.ids) expect(books.flat()).not.toContain(id);
  });

  it('sheds the OLDEST book first and always keeps the newest excluded', () => {
    const pool = eligibleIds();
    // Two books that between them starve the pool, but either one alone does
    // not. Split the band so each half is far below the floor when combined.
    const half = Math.ceil(pool.length / 2);
    const newest = pool.slice(0, half);
    const oldest = pool.slice(half);
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [newest, oldest] });
    expect(draw.offeredStories).toBe(2);
    // Both together starve it, so exactly one book of memory survives...
    expect(draw.effectiveStories).toBe(1);
    // ...and it is the NEWEST, never the oldest.
    for (const id of draw.ids) expect(newest).not.toContain(id);
    expect(draw.ids.some((id: number) => oldest.includes(id))).toBe(true);
  });

  it('sheds one book at a time rather than discarding the whole list', () => {
    const pool = eligibleIds();
    // One affordable recent book, then many old books that together bust the
    // floor. The old end goes; the recent one must not go with it.
    const newest = pool.slice(0, 4);
    const old = [];
    for (let i = 4; i < pool.length; i += 6) old.push(pool.slice(i, i + 6));
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [newest, ...old] });
    expect(draw.effectiveStories).toBeGreaterThanOrEqual(1);
    expect(draw.effectiveStories).toBeLessThan(draw.offeredStories);
    for (const id of draw.ids) expect(newest).not.toContain(id);
  });

  it('abandons the exclusion only when even the newest book alone cannot be paid for', () => {
    const pool = eligibleIds();
    // A single book holding almost the whole band: nothing left to draw from.
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [pool.slice(0, pool.length - 3)] });
    expect(draw.offeredStories).toBe(1);
    expect(draw.effectiveStories).toBe(0);
    // A full draw still ships — an unfillable draw would be the worse failure.
    expect(draw.ids.length).toBeGreaterThan(0);
  });

  it('reads a flat exclusion array as one book', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25, excludeIds: [11, 12, 13] });
    expect(draw.offeredStories).toBe(1);
    expect(draw.effectiveStories).toBe(1);
    for (const id of draw.ids) expect([11, 12, 13]).not.toContain(id);
  });

  it('counts no memory when there is none to offer', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25 });
    expect(draw.offeredStories).toBe(0);
    expect(draw.effectiveStories).toBe(0);
  });
});

describe('the draw is auditable back to the catalogue', () => {
  it('tags every offered line with its catalogue id', () => {
    const draw = drawChallengeIdeas(inputData, { count: 25 });
    const lines = draw.section.split('\n').filter((l: string) => l.startsWith('- '));
    expect(lines.length).toBe(draw.ids.length);
    lines.forEach((l: string, i: number) => {
      expect(l.startsWith(`- [C${draw.ids[i]}] `)).toBe(true);
    });
  });
});

describe('parseArcRetell records which drawn challenges the arc took', () => {
  const retell = (taken: string) => [
    'STORY LOGIC:',
    'Want and stakes: get home.',
    'Opposition: the river.',
    'Facts:',
    '- Levin (commissioned) — can swim; cannot row',
    'Central figure: none',
    'Chain:',
    '- because the bridge is down, they build a raft',
    'Fixing: the orphaned payoff.',
    'Keeping: the rescue.',
    'Challenges taken:',
    taken,
    'Used: Panelist A',
    'FINAL ARC:',
    '1. A child sets out.',
    '2. A child comes home.',
    'CRITIQUE:',
    '1. [MINOR] thin middle.',
  ].join('\n');

  it('pulls the catalogue ids off the taken lines', () => {
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [C7] the locked door'));
    expect(r.takenIds).toEqual([42, 7]);
  });

  it('counts an arc-invented challenge as taken from no catalogue entry', () => {
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [own] the promise she made'));
    expect(r.takenIds).toEqual([42]);
  });

  it('keeps the reference tags out of the arc text that travels downstream', () => {
    // The final arc reaches the beats planner, the text writer and the image
    // prompts; a stray [C###] there reads as a cell reference.
    const r = parseArcRetell(retell('1. [C42] crossing the water\n2. [own] the promise'));
    expect(r.finalArc).not.toMatch(/\[C\d+\]/);
    expect(r.finalArc).not.toMatch(/\[own\]/i);
    expect(r.finalArc).toContain('crossing the water');
  });

  it('yields no ids when the telling ignores the tag contract', () => {
    const r = parseArcRetell(retell('1. crossing the water\n2. the locked door'));
    expect(r.takenIds).toEqual([]);
  });
});
