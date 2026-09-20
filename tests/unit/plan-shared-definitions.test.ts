import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: '1st-grade', storyDetails: 'x',
  characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});
const planner = () => pb.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
const checker = () => pb.buildPlanCheckPrompt(
  input(), [{ pageNumber: 1, planLine: 'medium — Levin — he waits — nothing' }],
  '1. A story.', 'Page 1: medium — Levin — he waits — nothing');

/**
 * story-beats.txt states each page rule as an imperative and plan-check.txt
 * audits the same rule as a question — the generator/critic pair for page
 * division. The framing is deliberately different; the DEFINITION inside each
 * was written out twice by hand. A definition that drifts between the rule and
 * the audit is a generator that cannot satisfy the judge grading it.
 */
describe('planner and checker share one definition, not two copies', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  for (const name of ['DEED_AND_EFFECT_DEF', 'TWO_HEIGHTS_DEF', 'NAMING_DEF', 'ENDING_EVENT_DEF']) {
    it(`${name} reaches BOTH prompts, verbatim`, () => {
      const def = pb[name];
      expect(def, `${name} is not exported`).toBeTruthy();
      expect(planner(), `${name} missing from the planner`).toContain(def);
      expect(checker(), `${name} missing from the checker`).toContain(def);
    });
  }

  it('WANTED_PICTURE_DEF reaches the checker; the planner asks it as a planning question', () => {
    expect(checker()).toContain(pb.WANTED_PICTURE_DEF);
    expect(planner()).toContain('which picture does a child most want to see there');
  });

  /**
   * 455704f89 factored TWO_HEIGHTS_DEF out of story-beats.txt and left the
   * hand-written tail sentence behind, so the built prompt stated the whole-cast
   * clause twice, twenty words apart.
   */
  it('the definition is stated once in the built prompt, not once per copy', () => {
    const p = planner();
    for (const sentence of pb.TWO_HEIGHTS_DEF.split(/(?<=\.)\s+/).filter((x: string) => x.length > 25)) {
      expect(p.split(sentence).length - 1, `duplicated: ${sentence}`).toBe(1);
    }
  });

  it('neither prompt ships an unfilled placeholder', () => {
    expect(planner().match(/\{[A-Z_]+\}/g) || []).toEqual([]);
    expect(checker().match(/\{[A-Z_]+\}/g) || []).toEqual([]);
  });

  it('each side keeps its own framing — the rule commands, the audit asks', () => {
    expect(planner()).toContain('- One action per page.');
    expect(checker()).toContain('9. Deed and effect. Name every page');
    // The article differs by site and both wordings are pinned elsewhere.
    expect(planner()).toContain("A character's first page stages their arrival");
    expect(checker()).toContain('That page stages an arrival');
  });
});

/**
 * "A character in frame on a page is in frame on the next one unless a plan line
 * says where they went" contradicted "the others come and go in different
 * combinations". Measured on job_1789759147125_p08djwhbl: 10 of 17 transitions
 * drop a named character and no plan line says where anyone went — the planner
 * obeyed the variety rule and ignored this one. Owner, 2026-09-19: delete it.
 */
describe('the dead-letter continuity sentence is gone', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('no longer demands a departure clause on every page turn', () => {
    expect(planner()).not.toContain('is in frame on the next one unless a plan line says where they went');
  });

  it('keeps the THING-continuity half, which nothing contradicted', () => {
    expect(planner()).toContain('What a page establishes about a thing — stuck, heavy, hidden, out of reach — stays true');
  });

  it('keeps the variety rule it was fighting', () => {
    expect(planner()).toContain('come and go in different combinations');
  });
});
