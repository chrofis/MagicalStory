import { describe, it, beforeAll, expect } from 'vitest';

const { buildBeatsPrompt, buildPlanCheckPrompt, replanRank } = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'Vier Buben finden ein Ei.',
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});

/**
 * 2026-09-13 retired the hardcoded CAST_OVER_3 counter — "one counter, one
 * number, read from config" — and reframed the scene reviewer's twin check from
 * a hardcoded three to the configured cap as a composition recommendation. The
 * beats planner was not reframed with them, so for six days the prompt said "At
 * most three named characters in frame… at most one whole-cast page" while the
 * code enforced 6 and nothing enforced the one-page budget at all.
 */
describe('the planner reads the configured cap, like the rest of the pipeline', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('states the ceiling as the configured cap, not a literal three', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('Two or three named characters carry a page best');
    expect(p).toMatch(/\d+ is the ceiling the image model can hold/);
    expect(p).not.toContain('At most three named characters in frame');
    expect(p).not.toContain('at most one whole-cast page');
    expect(p).not.toContain('{MAX_CHARACTERS_PER_SCENE}');
  });

  it('keeps every STAGING rule the old sentence carried — only the count moved', () => {
    const p = buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('a named animal that acts in the story counts as one of them');
    expect(p).toContain('wide or distant');
    expect(p).toContain('never a row of figures facing the viewer');
    expect(p).toContain('Add no unnamed figures');
  });
});

/**
 * The checker read p8 of job_1789759147125_p08djwhbl as two named characters —
 * its own roster line said `people = Max, Nia; covers = Levin, Julian, Kiaan`,
 * and check 3 counted the who column alone. Five named, flagged as two.
 */
describe('check 3 counts the cast a covers field expands', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('tells the checker to count covers, not the who column alone', () => {
    const p = buildPlanCheckPrompt(input(), [{ pageNumber: 1, planLine: 'medium — Levin — he waits — nothing' }], '1. A story.', 'Page 1: medium — Levin — he waits — nothing');
    expect(p).toContain("counting the names that page's ROSTER line expands under `covers`");
    expect(p).toContain('never the who column alone');
  });
});

/**
 * The planner is told "At least one page in the book earns this"; the counter
 * reports when none does. As an "also noted" line the re-plan was never obliged
 * to act, so on job_1789759147125_p08djwhbl it was raised in BOTH rounds and
 * shipped unfixed.
 */
describe('a requirement nothing is obliged to answer is not a requirement', () => {
  it('NO_PEOPLELESS_PAGE is must-fix, so a re-plan has to spend a round on it', () => {
    expect(replanRank({ kind: 'counter', code: 'NO_PEOPLELESS_PAGE' })).toBe('must');
  });

  it('the codes that were already must-fix stay must-fix', () => {
    for (const code of ['NO_FOCAL_PAGE', 'UNDER_COVERED_CHARACTER', 'MAIN_UNDER_HALF',
      'NO_COMMISSIONED_ON_PAGE', 'PEOPLELESS_ON_INTERACTION_PAGE']) {
      expect(replanRank({ kind: 'counter', code })).toBe('must');
    }
  });

  it('an unranked counter is still only also-noted', () => {
    expect(replanRank({ kind: 'counter', code: 'CONSECUTIVE_SAME_SHOT_CAST' })).toBe('also');
  });
});
