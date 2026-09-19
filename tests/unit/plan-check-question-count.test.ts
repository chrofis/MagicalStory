/**
 * The plan check's question list and its own declared count agree — asserted on
 * the BUILT prompt.
 *
 * Two failures this pins, both of which had already happened:
 *
 *   1. `plan-check.txt` announced "only the eight points below" and "Answer only
 *      these eight" while TEN questions stood. Q9 and Q10 were appended without
 *      touching either header, and the prompt that ran on
 *      job_1789681157795_wkt20ckod carried the mismatch — a model told to answer
 *      eight is instructed to ignore the rest. Q11 made it eleven, and the count
 *      is now checked rather than remembered.
 *
 *   2. `fillTemplate` drops an undeclared key silently, so a question can be
 *      present in the template and absent from the built string.
 *
 * These pin BEHAVIOUR — that the questions arrive and that the prompt's own
 * count is true — never the wording of any question. Rewording a check freely
 * is fine; losing one, or appending one without correcting the header, is not.
 *
 * Offline and free: no API call, no database.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates, PROMPT_TEMPLATES: TEMPLATES } = require('../../server/services/prompts');

const CHARACTERS = [
  { id: 'c1', name: 'Mara', age: 7, gender: 'female' },
  { id: 'c2', name: 'Tomas', age: 9, gender: 'male' },
];

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: CHARACTERS,
  mainCharacters: ['c1'],
  language: 'en',
  languageLevel: 'medium',
  pages: 3,
  storyCategory: 'adventure',
  storyType: 'adventure',
  artStyle: 'watercolor',
};

const ARC = 'The keeper must relight the lamp before the tide turns.';
const PAGE_PLAN = [
  'Page 1: wide — Mara on the pier — she lifts the lantern — the lamp is lit',
  'Page 2: close — Mara — she cups the flame — the flame holds',
  'Page 3: wide — Mara, Tomas — he pulls the rope taut — the boat is moored',
].join('\n');
const BEATS = [
  { pageNumber: 1, planLine: 'wide — Mara on the pier — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'close — Mara — she cups the flame — the flame holds' },
  { pageNumber: 3, planLine: 'wide — Mara, Tomas — he pulls the rope taut — the boat is moored' },
];

/** The questions are the numbered lines between the task heading and the output format. */
const taskSection = (prompt: string) => prompt.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0];
const questionNumbers = (prompt: string) =>
  [...taskSection(prompt).matchAll(/^(\d+)\.\s+\S/gm)].map(m => Number(m[1]));

/** The prompt states its own count twice, in words. */
const NUMBER_WORDS: Record<string, number> = {
  three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
};
const declaredCounts = (prompt: string) => {
  const intro = prompt.match(/only on the (\w+) points below/);
  const task = prompt.match(/Answer only these (\w+):/);
  return { intro: intro && NUMBER_WORDS[intro[1]], task: task && NUMBER_WORDS[task[1]] };
};

describe('the plan check asks every question it says it asks', () => {
  let prompt: string;

  beforeAll(async () => {
    await loadPromptTemplates();
    prompt = PB.buildPlanCheckPrompt(inputData, BEATS, ARC, PAGE_PLAN);
    expect(prompt, 'the plan check template must load').toBeTruthy();
  });

  it('numbers its questions 1..N with no gap and no repeat', () => {
    const nums = questionNumbers(prompt);
    expect(nums.length).toBeGreaterThan(0);
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
  });

  it('declares its own count truthfully, in both headers', () => {
    const nums = questionNumbers(prompt);
    const declared = declaredCounts(prompt);
    // Both sentences are read by the model; either one lying tells it to stop early.
    expect(declared.intro, 'the intro states a count').not.toBeNull();
    expect(declared.task, 'the task heading states a count').not.toBeNull();
    expect(declared.intro).toBe(nums.length);
    expect(declared.task).toBe(nums.length);
  });

  it('carries the obstacle question (11) into the built string', () => {
    // Presence by NUMBER, not by wording — the question may be rephrased.
    expect(questionNumbers(prompt)).toContain(11);
  });

  it('leaves no unfilled placeholder behind', () => {
    expect(prompt).not.toMatch(/\{[A-Z_]{3,}\}/);
  });

  it('carries its inputs — the arc and the page plan both arrive', () => {
    expect(prompt).toContain(ARC);
    expect(prompt).toContain('he pulls the rope taut');
  });
});

/**
 * The counter findings are NOT an input to this prompt and cannot be
 * (2026-09-11, df1eb1ff3): the counters do arithmetic on the ROSTER this call
 * returns, so they run after it. A fifth argument and a `COUNTER_FINDINGS:`
 * fill outlived that inversion for eight days, filling a key no template
 * declares — which `fillTemplate` drops without a word.
 *
 * Pinned as CONTRACT, not wording: the template declares no counter
 * placeholder, and no counter text reaches the model however it is passed.
 */
describe('the plan check is never handed the counter findings', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the template declares no counter placeholder', () => {
    const t = String(TEMPLATES.planCheck || '');
    expect(t).toBeTruthy();
    expect(t).not.toContain('{COUNTER_FINDINGS}');
  });

  it('a caller that passes counter lines anyway cannot smuggle them in', () => {
    // Belt and braces: extra arguments are legal JavaScript, so the guarantee
    // has to be that the built string carries none of it.
    const smuggled = 'MAIN_UNDER_HALF: the main character is in frame on 3 of 18 pages';
    const prompt = (PB.buildPlanCheckPrompt as any)(inputData, BEATS, ARC, PAGE_PLAN, [smuggled]);
    expect(prompt).not.toContain(smuggled);
    expect(prompt).not.toContain('MAIN_UNDER_HALF');
    expect(prompt).not.toMatch(/\{[A-Z_]{3,}\}/);
  });
});

describe('a question-11 finding is advisory', () => {
  it('parses as check 11 and ranks "also", never "must"', () => {
    // The re-plan promotes only REPLAN_MUST_FIX_CHECKS = {4, 8}. A must-fix that
    // over-fires is what put an unplanned figure on a page in the first place.
    const parsed = PB.parsePlanCheck('11. Page 17 — the obstacle holder is not named in the plan line.');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].check).toBe(11);
    expect(PB.replanRank({ kind: 'check', check: 11 })).toBe('also');
  });
});
