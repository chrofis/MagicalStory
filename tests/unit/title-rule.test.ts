/**
 * The title rule is cast-size dependent (owner, 2026-08-25).
 *
 * "The title contains the main character's name" was written for the trial,
 * which always has exactly one child, and then applied to every cast: a
 * four-lead story came back titled after one of them, which reads as a
 * two-hander. See docs/decisions.md (2026-08-25) and
 * tasks/story-text-quality-2026-08-25.md → T14.
 */
import { describe, it, expect } from 'vitest';

const { buildTitleRule } = require('../../server/lib/promptBuilders');

const CAST = [
  { id: 1, name: 'Alex' },
  { id: 2, name: 'Robin' },
  { id: 3, name: 'Sam' },
  { id: 4, name: 'Kim' },
];
const withMains = (n: number) => ({
  mainCharacters: CAST.slice(0, n).map(c => c.id),
  characters: CAST,
});

describe('buildTitleRule', () => {
  it('requires the one name when there is a single main character (the trial case)', () => {
    const rule = buildTitleRule(withMains(1));
    expect(rule).toContain("Alex's name");
    expect(rule).not.toContain('optional');
  });

  it('requires BOTH names when there are exactly two main characters', () => {
    const rule = buildTitleRule(withMains(2));
    expect(rule).toContain('Alex');
    expect(rule).toContain('Robin');
    expect(rule).toContain('both names');
    expect(rule).not.toContain('optional');
  });

  it('makes a name optional past two main characters', () => {
    for (const n of [3, 4]) {
      const rule = buildTitleRule(withMains(n));
      expect(rule, `n=${n}`).toContain('optional');
      // No single child is singled out when the story has more than two leads.
      expect(rule, `n=${n}`).not.toContain("Alex's name");
    }
  });

  it('always states the language and no-spoiler constraints', () => {
    for (const n of [1, 2, 3, 4]) {
      const rule = buildTitleRule(withMains(n));
      expect(rule, `n=${n}`).toContain('story language');
      expect(rule, `n=${n}`).toContain('does not spoil the ending');
    }
  });

  it('falls back to the whole cast when no main characters are marked', () => {
    // Older jobs and mid-migration trials carry no mainCharacters array; the
    // count it stands in for is the cast size.
    expect(buildTitleRule({ mainCharacters: [], characters: [CAST[0]] })).toContain("Alex's name");
    expect(buildTitleRule({ mainCharacters: [], characters: CAST })).toContain('optional');
  });

  it('does not throw on an empty or absent cast', () => {
    expect(() => buildTitleRule({})).not.toThrow();
    expect(() => buildTitleRule({ characters: [] })).not.toThrow();
    // No names to require, so it must not claim a name is mandatory.
    expect(buildTitleRule({ characters: [] })).toContain('optional');
  });
});
