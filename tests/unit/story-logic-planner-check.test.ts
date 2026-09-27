/**
 * THE STORY LOGIC reaches the page planner, the re-plan and the plan check
 * (owner, 2026-09-26) — one section from one builder, and the checker's
 * question 18 is the critic half of the planner's "every page keeps to these
 * facts".
 *
 * Pins behaviour on the BUILT prompts, never wording: the same section text
 * arrives in all three, nothing arrives when there is no logic, the check's
 * question list still counts true, and production passes the logic at every
 * call site. Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const inputData: any = {
  title: 'T', characters: [{ id: 'c1', name: 'Ana', age: 7, gender: 'female' }, { id: 'c2', name: 'Ben', age: 8, gender: 'male' }],
  mainCharacters: ['c1'], language: 'en', languageLevel: '1st-grade', pages: 4,
  storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
};
const ARC = '1. They find a map.\n2. They sail.\n3. The rope snaps.\n4. They climb.';
const FACT = 'every old rope aboard is brittle, and only the tarred line holds a weight';
const LOGIC = `Want and stakes: the main character wants the chest.\nFacts:\n- ${FACT}.\nCentral figure: none`;
const BEATS = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: `medium — Ana — she acts ${n} — a change ${n}` }));

describe('the story logic reaches the planner and its checker', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('one section, the same text in the first division, the re-plan and the check', () => {
    const section = PB.buildStoryLogicSection(LOGIC);
    expect(section).toContain(FACT);
    expect(section).toContain(PB.STORY_LOGIC_FACT_RULE);
    const plan = PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC, storyLogic: LOGIC });
    const replan = PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC, storyLogic: LOGIC, replan: '# RE-DIVIDE\npage 3' });
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '', { storyLogic: LOGIC });
    for (const p of [plan, replan, check]) {
      expect(p).toContain(section);
      expect(p).not.toMatch(/\{[A-Z_]{3,}\}/);
    }
  });

  it('no logic, no section — and no stray heading', () => {
    expect(PB.buildStoryLogicSection('')).toBe('');
    expect(PB.buildStoryLogicSection('   ')).toBe('');
    const plan = PB.buildBeatsPrompt(inputData, 4, { finalArc: ARC });
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '');
    for (const p of [plan, check]) {
      expect(p).not.toContain(PB.STORY_LOGIC_FACT_RULE);
      expect(p).not.toMatch(/\{[A-Z_]{3,}\}/);
    }
  });

  it('the check asks a question about the story logic, and the rule the planner keeps is the one it judges by', () => {
    const check = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, '', { storyLogic: LOGIC });
    const task = check.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0];
    const q18 = (task.match(/^18\.\s+(.+)$/m) || [])[1] || '';
    expect(q18).toMatch(/STORY LOGIC/);
    // The last question is 18: nothing was appended past it without a count.
    expect(task).not.toMatch(/^19\./m);
  });

  it('a story-logic finding is advisory: it does not join the must-fix checks', () => {
    // Severity is the owner's call; until they rank it, Q18 is a visible,
    // noted finding (replanRank 'also').
    expect(PB.replanRank({ check: 18, text: 'Page 3 uses a brittle rope as a load line.' })).toBe('also');
  });

  it('production passes the logic at the planner, the re-plan and the check', () => {
    const src = readFileSync(join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    expect(src).toContain('buildBeatsPrompt(inputData, pageCount, { finalArc: approvedArc, arcHints, storyLogic: arcStoryLogic,');
    expect(src).toMatch(/buildPlanCheckPrompt\([^)]*storyLogic: arcStoryLogic/);
    const replanCall = (src.match(/const replanPrompt = buildBeatsPrompt\(inputData, pageCount, \{[\s\S]*?\}\);/) || [])[0] || '';
    expect(replanCall).toContain('storyLogic: arcStoryLogic');
    expect(src).toContain('arcStoryLogic = currentLogic.text;');
  });
});
