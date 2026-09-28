/**
 * A PAGE'S TEXT COUNTS ONLY WHOM ITS PICTURE HOLDS (owner, 2026-09-28).
 * Staging job_1790539784661_6mjcny1c7 p10: "alle vier" beside a picture of
 * three boys. One constant, PICTURE_COUNT_RULE, for the two writers (beats,
 * trial), the rewriter (text-refine) and the arc-informed audit's COUNT
 * question, which judges against the same plan lines. Pins the contract — the
 * constant reaches every built prompt, filled — and that the rule names kinds
 * of words, never one language's.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');

const input = (extra: Record<string, unknown> = {}) => ({
  language: 'de',
  readingLevel: '2nd-grade',
  storyCategory: 'adventure',
  storyTheme: 'adventure',
  storyDetails: 'a kite caught in a tree',
  characters: [{ id: 'c1', name: 'Mia', age: 8, gender: 'female', isMain: true }, { id: 'c2', name: 'Tom', age: 6, gender: 'male' }],
  mainCharacters: ['c1'],
  ...extra,
});
const beats = [
  { pageNumber: 1, planLine: 'wide — Mia and Tom — they run to the tree — the kite is stuck' },
  { pageNumber: 2, planLine: 'close-up — Mia — she pulls the string — the kite is free' },
];
const pages = beats.map(b => ({ pageNumber: b.pageNumber, planLine: b.planLine, text: 'Text.' }));
const unfilled = (s: string) => [...new Set(String(s).match(/\{[A-Z][A-Z0-9_]*\}/g) || [])];

let built: Record<string, string>;
beforeAll(async () => {
  await loadPromptTemplates();
  built = {
    beats: String(PB.buildStoryTextFromBeatsPrompt(input(), beats, [], 'ARC', { arcHints: '' })),
    trial: String(PB.buildTrialStoryPrompt(input({ trialMode: true }), 5)),
    refine: String(PB.buildTextRefinePrompt(input(), pages, 'FAULT[COUNT]: p2 — counts both', 'ARC')),
    audit: String(PB.buildTextAuditPrompt(input(), pages, 'ARC')),
  };
});

describe('the picture-count rule reaches every writer, the rewriter and the audit', () => {
  it.each(['beats', 'trial', 'refine', 'audit'])('%s carries it, filled', (name) => {
    expect(built[name]).toContain(PB.PICTURE_COUNT_RULE);
    expect(unfilled(built[name]).filter(p => p === '{PICTURE_COUNT}')).toEqual([]);
  });

  it('the audit asks it as its own COUNT question, answered against the plan lines it shows', () => {
    expect(built.audit).toMatch(/15\. COUNT: /);
    expect(built.audit).toContain(beats[0].planLine);
  });

  it('names kinds of words (a number, all, both, every) and no language\'s own words', () => {
    expect(PB.PICTURE_COUNT_RULE).toMatch(/no number/);
    expect(PB.PICTURE_COUNT_RULE).toMatch(/all, both or every/);
    expect(PB.PICTURE_COUNT_RULE).toMatch(/in whatever language/);
    expect(PB.PICTURE_COUNT_RULE).not.toMatch(/alle|beide|tous|vier/i);
  });
});
