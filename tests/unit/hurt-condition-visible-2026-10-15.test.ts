/**
 * Prod job_1792078014622_uh8tj6ht1 (2026-10-15): a plot-relevant hurt wing was specified by SIDE ("the left wing
 * hangs limp"), drawn on the other side, failed twice by the cell gate and chased by the page judges; the story's
 * "cannot fly" gull was staged leaping mid-air. Three owner-approved changes, pinned here by which shared
 * constant reaches which built prompt (never by wording): ONE_SIDED_FEATURE_RULE, BODY_CONDITION_MARKER_RULE,
 * DECLARED_CONDITION_DEF (plan-check Q20, must-fix).
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const RS = require('../../server/lib/referenceSheets');
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = require('../../server/services/prompts');

const chars = [{ id: 'a', name: 'Levin', age: 5, isMainCharacter: true }, { id: 'b', name: 'Mira', age: 8, isMainCharacter: true }];
const input = () => ({ pages: 4, season: 'autumn', language: 'en', storyDetails: 'x', characters: chars, mainCharacters: ['a', 'b'], storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor', languageLevel: 'standard' });
const beats = [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing', fixed: { timeOfDay: 'dusk', indoor: false } }];

beforeAll(async () => { await loadPromptTemplates(); });

const RULE = () => PB.ONE_SIDED_FEATURE_RULE;
const MARK = () => PB.BODY_CONDITION_MARKER_RULE;

describe('1. a one-sided feature is relational: one sentence, writers and judges', () => {
  it('the rule names no side as a value and no example from a test story', () => {
    expect(RULE()).toMatch(/never stated as left or right/);
    expect(RULE()).not.toMatch(/gull|wing|Spaghetti/i);
    expect(MARK()).not.toMatch(/gull|wing|Spaghetti/i);
    expect(PB.DECLARED_CONDITION_DEF).not.toMatch(/gull|wing|fly|Spaghetti/i);
  });

  it('both Visual Bible writers are given it', () => {
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(RULE());
    expect(PB.buildTrialArcPrompt(input(), 4)).toContain(RULE());
  });

  it('both Visual Bible cell gates carry it (regression: neither said anything about sides)', () => {
    expect(RS.cellGatePrompt('watercolor', null, null, 'a hurt fox')).toContain(RULE());
    expect(RS.elementCellGatePrompt({ kind: 'animal', description: 'a bird, one limb hangs limp' }, 'watercolor')).toContain(RULE());
  });

  it('the three page judges carry it', () => {
    expect(buildEvaluationPrompt({ originalPrompt: 'x' })).toContain(RULE());
    for (const t of ['image-semantic', 'image-prompt-compliance']) {
      expect(fs.readFileSync(`prompts/${t}.txt`, 'utf8')).toContain('{ONE_SIDED_FEATURE}');
    }
    // the fill sites (semantic: sceneValidator, compliance: evalPipeline) pass the same constant
    expect(fs.readFileSync('server/lib/sceneValidator.js', 'utf8')).toMatch(/ONE_SIDED_FEATURE: require\('\.\/promptBuilders'\)\.ONE_SIDED_FEATURE_RULE/);
    expect(fs.readFileSync('server/lib/evalPipeline.js', 'utf8')).toMatch(/ONE_SIDED_FEATURE: require\('\.\/promptBuilders'\)\.ONE_SIDED_FEATURE_RULE/);
  });
});

describe('2. a plot-relevant body condition carries a visible marker in the arc, the text and the bible', () => {
  it('the arc sentence rule (arc-create and arc-retell) carries it', () => {
    expect(PB.ARC_SENTENCE_RULE).toContain(MARK());
    expect(PB.buildArcCreatePrompt(input(), 4)).toContain(MARK());
  });

  it('both text writers carry it', () => {
    expect(PB.buildStoryTextFromBeatsPrompt(input(), [], [], '1. A story.')).toContain(MARK());
    expect(PB.buildTrialPagesPrompt(input(), 4, 'arc')).toContain(MARK());
  });

  it('both Visual Bible writers carry it', () => {
    expect(PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' })).toContain(MARK());
    expect(PB.buildTrialArcPrompt(input(), 4)).toContain(MARK());
  });

  it('no built prompt leaves a placeholder unfilled', () => {
    const built = [
      PB.buildVisualBibleCallPrompt(input(), beats, { maxCharactersPerScene: 6, finalArc: '1.' }),
      PB.buildTrialArcPrompt(input(), 4), PB.buildTrialPagesPrompt(input(), 4, 'arc'),
      PB.buildStoryTextFromBeatsPrompt(input(), [], [], '1. A story.'), buildEvaluationPrompt({ originalPrompt: 'x' }),
      PB.buildBeatsPrompt(input(), 4, { finalArc: '1. A story.' }),
    ];
    for (const p of built) for (const k of ['ONE_SIDED_FEATURE', 'BODY_CONDITION_MARKER', 'DECLARED_CONDITION_DEF']) expect(p).not.toContain(`{${k}}`);
  });
});

describe('3. plan check Q20: a figure staged doing what the story says it cannot do', () => {
  const planText = 'Page 1: wide — Levin — waits — nothing';
  const nums = (p: string) => [...p.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0].matchAll(/^(\d+)\.\s+\S/gm)].map(m => Number(m[1]));

  it('the checker is asked it, with the shared definition, and the count word agrees', () => {
    const prompt = PB.buildPlanCheckPrompt(input(), beats, 'An arc.', planText);
    expect(nums(prompt)).toContain(20);
    expect(prompt).toContain(PB.DECLARED_CONDITION_DEF);
    expect(prompt).toMatch(/Answer only these sixteen:/);
  });

  it('the planner is told the same definition (generator/critic sync)', () => {
    expect(PB.buildBeatsPrompt(input(), 4, { finalArc: '1. A story.' })).toContain(PB.DECLARED_CONDITION_DEF);
  });

  it('Q20 is must-fix: the re-plan is obliged to answer it', () => {
    expect(PB.replanRank({ check: 20 })).toBe('must');
    expect(PB.replanRank({ check: 18 })).not.toBe('must');
  });
});
