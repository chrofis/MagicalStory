import { describe, it, expect, beforeAll } from 'vitest';

// Owner rule, 2026-11-07: the obstacle the story logic names is removed by the
// main character's own deciding act at the climax. ONE constant, carried by the
// arc creator, the re-teller, their critique, the panel's STAKES lens and the
// trial writers; ARC_SEVERITY_DEF makes a break MAJOR so the re-tell gate opens.
import { trialWriterPrompt } from './helpers/trialWriterPrompt';
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (age = 7) => ({
  language: 'de-ch', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'pirate',
  storyDetails: 'Kinder suchen einen Schatz.',
  characters: [{ id: 'a', name: 'Anna', age, gender: 'female' }, { id: 'b', name: 'Ben', age, gender: 'male' }],
  mainCharacters: ['a', 'b'],
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('OBSTACLE_REMOVED_BY_CLIMAX_RULE', () => {
  const rule: string = PB.OBSTACLE_REMOVED_BY_CLIMAX_RULE;

  it('states the three faults and the one-problem condition, generically', () => {
    expect(rule).toMatch(/answers a different problem/);
    expect(rule).toMatch(/open to them all along/);
    expect(rule).toMatch(/chance event/);
    expect(rule).toMatch(/simply stopping with no act of the main character/);
    // narrowed 2026-11-07: an Opposition that yields because of the climax act is not a break
    expect(rule).toMatch(/yields, relents or is overcome because of the act of the main character does not break it/);
  });

  for (const age of [7, 3]) {
    it(`reaches creator, re-teller, critique and panel (age ${age})`, () => {
      const data = input(age);
      expect(PB.arcStakesRules(data)).toContain(rule);
      expect(PB.buildTellingRulesSection(data)).toContain(rule);
      expect(PB.buildArcCreatePrompt(data, 16)).toContain(rule);
      expect(PB.buildArcRetellPrompt(data, 16, 'ARC: x', '1. [MAJOR] (s2) x — "y"')).toContain(rule);
      expect(PB.arcCritiqueSpec({ inputData: data })).toContain(rule);
      expect(PB.arcCritiqueSpec({ retell: true, inputData: data })).toContain(rule);
      expect(PB.buildArcPanelPrompt(data, 'ARC: x')).toContain(rule);
    });
  }

  it('the rule is stated once per prompt, never duplicated', () => {
    const data = input(7);
    const create = PB.buildArcCreatePrompt(data, 16);
    // creator prompt: once in TELLING_RULES and once in its own critique spec
    expect(create.split(rule).length - 1).toBeLessThanOrEqual(2);
    expect(PB.buildArcPanelPrompt(data, 'ARC: x').split(rule).length - 1).toBe(1);
  });

  it('ARC_SEVERITY_DEF lists a missed obstacle removal in the MAJOR class', () => {
    const def: string = PB.ARC_SEVERITY_DEF;
    const major = def.slice(def.indexOf('[MAJOR]'), def.indexOf('[MINOR]'));
    expect(major).toMatch(/obstacle that the climax act of the main character does not remove/);
  });

  it('reaches the trial writer built by the real builder, with no literal placeholder left', () => {
    const data = { ...input(7), trialMode: true };
    const trial: string = trialWriterPrompt(data, 6);
    expect(trial).toContain(rule);
    expect(trial).not.toContain('{ARC_OBSTACLE_REMOVED}');
  });
});
