import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5 }];
const input = () => ({
  pages: 4, season: 'autumn', language: 'de-CH', languageLevel: '1st-grade',
  storyDetails: 'x', characters: chars, mainCharacters: ['a'],
});
const allPages = () => pb.buildSceneExpansionAllPrompt(
  input(), [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing' }],
  { maxCharactersPerScene: 6, finalArc: '1.' });
const perPage = () => String(pb.buildSceneExpansionPrompt(
  1, { beat: 'x', planLine: 'medium — Levin — waits — nothing' }, chars, 'de-CH', null, '', {}) || '');

/**
 * 8f asks every page citing an element beside a figure to state that element's
 * size as a RATIO against the figure, and its worked example was "the creature
 * stands three times the height of the character beside it" — exactly what the
 * creature-tone rule forbids on two of its three bands:
 *
 *   cute (<=4)         "never as a multiple of a child and never with the child
 *                       dwarfed beside it"
 *   not-menacing (5-6) "state its size in metres, not as a multiple of a child"
 *   formidable (7+)    "its size may be stated against a child"
 *
 * So on any creature page of a book for a reader of six or under, the rule and
 * its own example pointed one way and the band rule the other.
 *
 * Measured on job_1789759147125_p08djwhbl (age 5, not-menacing): this did NOT
 * explain 8f being widely ignored — creature pages carried a size anchor on 2 of
 * 8, non-creature pages on 0 of 7. That is a separate finding; this one is the
 * contradiction on its own terms.
 */
describe('8f no longer demands the thing the creature bands forbid', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the child-multiple example is gone from the rule', () => {
    expect(pb.TRUE_RELATIVE_SIZE_RULE).not.toContain('three times the height of the character');
    expect(pb.TRUE_RELATIVE_SIZE_RULE).not.toMatch(/creature.{0,40}times the height/);
  });

  it('a creature is named as the exception, and told where its size comes from', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    // Merged into the "Nothing else takes a ratio" clause when 8f was scoped
    // (A6) — the creature case was being stated twice.
    expect(r).toContain('a CREATURE by the creature rule above');
    expect(r).toContain('in metres or against a familiar room for a young reader');
    expect(r).toContain('a ratio against a child is what makes a creature loom over one');
    expect((r.match(/creature rule/g) || []).length, 'the creature case is stated once').toBe(1);
  });

  it('keeps the ratio demand for everything that is NOT a creature', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    expect(r).toContain('names its size as a ratio against a figure in the prose');
    expect(r).toContain('the mast rises five times her height');
    expect(r).toContain('An adjective is not a ratio');
  });

  it('keeps every other clause the hand-written rule carried', () => {
    const r = pb.TRUE_RELATIVE_SIZE_RULE;
    expect(r).toContain('Two entries of one kind that differ in size each carry their own ratio');
    expect(r).toContain('`scaleClass` band states on every page it appears on');
    expect(r).toContain('measured against nothing at all on a page where it is alone');
    expect(r).toContain('write that relation into the prose on every page the two share');
  });
});

/**
 * The rule was hand-copied byte-identically into both Art Director templates.
 * The per-page template DECLARED the new placeholder while its builder did not
 * fill it — and fillTemplate drops a declared placeholder nobody supplies,
 * silently. The assertion is therefore on the BUILT prompt, never the template.
 */
describe('one constant, and it reaches both BUILT Art Director prompts', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('both templates cite the placeholder rather than spelling the rule', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion']) {
      const t = String(PROMPT_TEMPLATES[k] || '');
      expect(t, k).toContain('{TRUE_RELATIVE_SIZE}');
      expect(t, `${k} still hand-copies the rule`).not.toContain('A vessel, building, vehicle or creature holds');
    }
  });

  it('and BOTH built prompts actually carry it — a declared placeholder is not a filled one', () => {
    for (const [name, built] of [['all-pages', allPages()], ['per-page', perPage()]] as const) {
      expect(built, `${name} did not fill the rule`).toContain(pb.TRUE_RELATIVE_SIZE_RULE);
      expect(built.match(/\{[A-Z_]+\}/g) || [], `${name} left a placeholder unfilled`).toEqual([]);
    }
  });
});
