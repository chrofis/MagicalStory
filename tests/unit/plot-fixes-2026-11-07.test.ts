/**
 * Plot fixes F2 / F3 (owner, 2026-11-07; docs/decisions.md 2026-11-07 "Arc re-tell: cut, don't add",
 * "Writer must-say"). F1 (idea main-character act) was removed the same day: no measured effect, clashed with the idea contract. Each constant is pinned on every BUILT prompt that should
 * carry it: both age bands, the full and the trial siblings.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests-only';
const PB = require('../../server/lib/promptBuilders');
const co = require('../../server/lib/ideaCoherence');
const trialCheck = require('../../server/lib/trialIdeaCheck');
const { loadPromptTemplates } = require('../../server/services/prompts');
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const input = (age: number) => ({
  language: 'de-ch', languageLevel: age <= 4 ? '1st-grade' : 'standard', storyCategory: 'adventure', storyTheme: 'pirate',
  storyDetails: 'Kinder suchen einen Schatz.', pages: 10,
  characters: [{ id: 'a', name: 'Anna', age, gender: 'female' }, { id: 'b', name: 'Ben', age, gender: 'male' }],
  mainCharacters: ['a', 'b'],
});

beforeAll(async () => { await loadPromptTemplates(); });

describe('idea templates', () => {
  it('both wizard idea templates take the shared idea rule through {IDEA_COHERENCE}', () => {
    for (const f of ['prompts/generate-story-idea-single.txt', 'prompts/generate-story-ideas.txt']) expect(read(f)).toContain('{IDEA_COHERENCE}');
  });
});

describe('F2 arc re-tell: cut, don\'t add', () => {
  const rule: string = PB.ARC_CUT_NOT_ADD_RULE;
  for (const age of [7, 3]) {
    it(`reaches the creator, the re-teller and the principles (age ${age})`, () => {
      const data = input(age);
      expect(PB.arcPrinciples(data, 10)).toContain(rule);
      expect(PB.buildArcCreatePrompt(data, 10)).toContain(rule);
      const retell = PB.buildArcRetellPrompt(data, 10, 'ARC: x', '1. [MAJOR] (s2) x — "y"');
      // the principles and the task bullet: twice in the re-telling
      expect(retell.split(rule).length - 1).toBe(2);
    });
  }
  const logic = (rules: string[]) => ({ rules, facts: rules });
  it('a re-telling that grew the rules past the cap is a failure; one that did not is not', () => {
    expect(PB.retellRuleOvershoot(logic(['a', 'b']), logic(['a', 'b', 'c']))).toEqual({ count: 3, prior: 2, max: 2 });
    expect(PB.retellRuleOvershoot(logic(['a']), logic(['a', 'b']))).toBeNull();
    // already over before the re-telling: the creator's, not the re-telling's
    expect(PB.retellRuleOvershoot(logic(['a', 'b', 'c']), logic(['a', 'b', 'c']))).toBeNull();
    expect(PB.retellRuleOvershoot(logic(['a', 'b', 'c']), logic(['a', 'b']))).toBeNull();
  });
  it('the refusal fed back repeats the same constant', () => {
    expect(PB.arcRetellRulesFeedback({ count: 3, prior: 2, max: 2 })).toContain(rule);
  });
  const block = (extra: string) => `STORY LOGIC:\nWant and stakes: x\nOpposition: y\nFacts:\n- Ana (commissioned) — none\n- Rule one\n- Rule two\n${extra}Motives:\n- Ana: wants → acts\nCentral figure: none\nEvents: 3\nChain:\n- because a\n- but b\n- because c\n`;
  it('the world, way-in and way-back lines are outside the two-rule cap (counting by the prescribed labels)', () => {
    const l = PB.parseStoryLogic(block('- World: a make-believe island\n- Way in: they step through the gate\n- Way back: the gate opens\n'));
    expect(l.facts.length).toBe(5);
    expect(l.rules.length).toBe(2);
    const counts = PB.arcShapeCounts({ sentences: 8, logic: l, inputData: input(7), pageCount: 10 });
    expect(counts.worldRules).toBe(2);
    expect(counts.worldRulesOver).toBe(false);
    const three = PB.parseStoryLogic(block('- Rule three\n'));
    expect(PB.arcShapeCounts({ sentences: 8, logic: three, inputData: input(7), pageCount: 10 }).worldRulesOver).toBe(true);
  });
  it('the logic spec prescribes exactly those three labels', () => {
    const spec = PB.arcLogicSpec(input(7), 10);
    for (const label of ['"World:"', '"Way in:"', '"Way back:"']) expect(spec).toContain(label);
  });
  it('production and the Lab both refuse an over-cap re-telling, through the same functions', () => {
    for (const f of ['server/lib/beatsPipeline.js', 'server/lib/testlab.js']) {
      const src = read(f);
      expect(src).toContain('retellRuleOvershoot');
      expect(src).toContain('arcRetellRulesFeedback');
    }
  });
});

describe('F3 writer must-say', () => {
  const logicBody = [
    'Want and stakes: Anna wants to reach the island before the tide; if she fails the treasure is gone for good.',
    'Opposition: the tide, which rises on its own.',
    'Facts:',
    '- Anna (commissioned) — none',
    '- Ben (commissioned) — none',
    '- Moss (new) — none',
    'Motives:',
    '- Anna: wants the treasure → rows out',
    '- Moss: is lonely and wants company → follows the boat',
    'Central figure: Moss',
    'Events: 3',
    'Chain:',
    '- because a',
    '- but b',
    '- because c',
  ].join('\n');
  it('buildMustSay holds the stakes line and the motive of each (new) figure, not a commissioned one', () => {
    const m: string = PB.buildMustSay(logicBody);
    expect(m).toContain('treasure is gone for good');
    expect(m).toContain('Why Moss acts: is lonely and wants company');
    expect(m).not.toContain('Why Anna acts');
    expect(m).toContain(PB.MUST_SAY_RULE);
  });
  it('is empty when there is no logic', () => {
    expect(PB.buildMustSay('')).toBe('');
  });
  for (const age of [7, 3]) {
    it(`reaches the writer, the audit and the refine (age ${age})`, () => {
      const data = input(age);
      const writer = PB.buildStoryTextFromBeatsPrompt(data, [{ pageNumber: 1, planLine: 'x' }], [], 'An arc.', { storyLogic: logicBody });
      const audit = PB.buildTextAuditPrompt(data, [{ pageNumber: 1, text: 'A page.', planLine: 'x' }], 'An arc.', { storyLogic: logicBody });
      const refine = PB.buildTextRefinePrompt(data, [{ pageNumber: 1, text: 'A page.', planLine: 'x' }], 'FAULT[X]: p1 — y', 'An arc.', { storyLogic: logicBody });
      for (const p of [writer, audit, refine]) {
        expect(p).toContain('MUST SAY:');
        expect(p).toContain('Why Moss acts');
        expect(p).toContain(PB.MUST_SAY_RULE);
      }
      expect(audit).toMatch(/A MUST SAY line that no page says in plain words is a fault/);
    });
    it(`reaches the trial pages writer (age ${age})`, () => {
      expect(PB.buildTrialPagesPrompt(input(age), 6, 'PAGE 1: x')).toContain(PB.MUST_SAY_TRIAL_RULE);
    });
  }
  it('the load-bearing rule no longer calls the stakes optional', () => {
    expect(PB.LOAD_BEARING_RULE).not.toMatch(/motives, causes, stakes/);
    expect(PB.LOAD_BEARING_RULE).toContain('MUST SAY');
  });
});
