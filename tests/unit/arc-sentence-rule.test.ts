/**
 * Opus arc review E1/E5 (2026-10-06): the arc sentence rule shares ONE
 * definition of "owed" with the text stages, and the cast-beat check asks
 * children only (the generator rule, EVERY_CHILD_ACTS_RULE, is about children).
 * Pins which shared string reaches which built prompt and who is asked to act,
 * never the wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { commissionedCast } = require('../../server/lib/castCoverage');
const { loadPromptTemplates } = require('../../server/services/prompts');

const data: any = {
  title: 'T', characters: [{ id: 'c0', name: 'Ana', age: 7, gender: 'female' }, { id: 'c1', name: 'Papa', age: 38, gender: 'male' }, { id: 'c2', name: 'Kid', gender: 'male' }],
  mainCharacters: ['c0'], language: 'en', languageLevel: 'standard', pages: 12,
  storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
};

describe('ARC_SENTENCE_RULE shares the owed definition', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the arc sentence rule reads the shared OWED_FACT_DEF', () => {
    expect(PB.ARC_SENTENCE_RULE).toContain(PB.OWED_FACT_DEF);
  });

  it('arc-create and arc-retell carry the rule; no placeholder is left', () => {
    const create = PB.buildArcCreatePrompt(data, 12);
    const retell = PB.buildArcRetellPrompt(data, 12, 'STORY LOGIC:\nx\nARC:\n1. a.', '## PANELIST A\nx');
    for (const p of [create, retell]) {
      expect(p).toContain(PB.ARC_SENTENCE_RULE);
      expect(p).not.toMatch(/\{[A-Z][A-Z_]+\}/);
    }
  });

  it('the telling rules no longer ask each sentence to say why', () => {
    expect(PB.buildTellingRulesSection(data)).not.toMatch(/what happens and why/);
  });
});

describe('commissionedCast.children', () => {
  it('lists children only: a listed adult may watch; no readable age counts as a child', () => {
    const c = commissionedCast(data);
    expect(c.listed).toEqual(['Ana', 'Papa', 'Kid']);
    expect(c.children).toEqual(['Ana', 'Kid']);
  });
});
