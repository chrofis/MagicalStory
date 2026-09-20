import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { PAGE_CHANGE_DEF, DEED_AND_EFFECT_DEF } = require('../../server/lib/promptBuilders');

// The plan line's third and fourth fields are different KINDS of statement:
//
//   field 3  the instant the picture shows          pictorial, one drawable moment
//   field 4  what is true after this page that      narrative, the story-state
//            was not before                          change the page delivers
//
// plan-check.txt check 9 already owned the boundary ("The instant shows one, and
// what follows it belongs in what is true after") but audited only the instant.
// Nothing said what the FOURTH field owes, and nothing measured it — so a line
// could satisfy every stated rule while saying one thing twice.
//
// Measured 2026-09-20 over 34 staging stories / 485 stored plan lines: 73 (15.1%)
// have a fourth field that only restates the instant. story-beats.txt already
// calls a page with no change filler; this gives that rule something to bite on.
//
// Owner ruling the same day: the instant MAY stage an aftermath. So this is not
// about which moment the picture takes — only about the fourth field owing a
// change the picture does not already show.
//
// These pin the CONTRACT and its delivery to both stages, never the wording.

const P = (f: string) => path.join(__dirname, '..', '..', 'prompts', f);
const read = (f: string) => fs.readFileSync(P(f), 'utf8');

describe('the fourth field owes a change, not the picture again', () => {
  it('names what a change is', () => {
    expect(PAGE_CHANGE_DEF).toMatch(/change in the story/i);
    expect(PAGE_CHANGE_DEF).toMatch(/was not true before/i);
  });

  it('rules out restating the instant', () => {
    expect(PAGE_CHANGE_DEF).toMatch(/not the instant in other words/i);
    expect(PAGE_CHANGE_DEF).toMatch(/states no change/i);
  });

  it('stays separate from the deed-and-effect definition it sits beside', () => {
    expect(PAGE_CHANGE_DEF).not.toBe(DEED_AND_EFFECT_DEF);
  });

  it('names no story, character or plot', () => {
    expect(PAGE_CHANGE_DEF).not.toMatch(/Silvan|Julian|Levin|Kiaan|Lindenhof|Zippi|dragon|egg/i);
  });

  it('states the rule without banners or justification', () => {
    expect(PAGE_CHANGE_DEF).not.toMatch(/CRITICAL|MUST NEVER|LOCKED|IMPORTANT:/);
    expect(PAGE_CHANGE_DEF).not.toMatch(/\bbecause\b/i);
  });
});

describe('both stages consume it', () => {
  it('the planner carries the placeholder, beside its own filler rule', () => {
    const beats = read('story-beats.txt');
    expect(beats).toContain('{PAGE_CHANGE}');
    expect(beats).toMatch(/nothing is true that was not before is filler/i);
  });

  it('the checker carries it inside the check that owns the field boundary', () => {
    const check = read('plan-check.txt');
    expect(check).toContain('{PAGE_CHANGE}');
    expect(check).toMatch(/Name every page whose what-is-true-after states no change/i);
  });

  it('reaches the BUILT planner prompt exactly once', async () => {
    const pb = require('../../server/lib/promptBuilders');
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const built = pb.buildBeatsPrompt(
      { pages: 18, language: 'de-CH', characters: [{ id: 'a', name: 'Alpha', age: 5 }], mainCharacters: ['a'] },
      18, { finalArc: '1. A story.' });
    expect(built).toContain(PAGE_CHANGE_DEF);
    expect(built.split('not the instant in other words').length - 1).toBe(1);
  });

  it('reaches the BUILT checker prompt exactly once', async () => {
    const pb = require('../../server/lib/promptBuilders');
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const built = pb.buildPlanCheckPrompt(
      { pages: 4, language: 'de-CH', characters: [{ id: 'a', name: 'Alpha', age: 5 }], mainCharacters: ['a'] },
      [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }, { pageNumber: 4 }],
      'An arc.', 'Page 1: wide — Alpha — something happens — something is true.');
    expect(built).toContain(PAGE_CHANGE_DEF);
    expect(built.split('not the instant in other words').length - 1).toBe(1);
  });

  it('neither built prompt ships an unfilled brace for it', async () => {
    const pb = require('../../server/lib/promptBuilders');
    const { loadPromptTemplates } = require('../../server/services/prompts');
    await loadPromptTemplates();
    const beats = pb.buildBeatsPrompt(
      { pages: 18, language: 'de-CH', characters: [{ id: 'a', name: 'Alpha', age: 5 }], mainCharacters: ['a'] },
      18, { finalArc: '1. A story.' });
    const check = pb.buildPlanCheckPrompt(
      { pages: 4, language: 'de-CH', characters: [{ id: 'a', name: 'Alpha', age: 5 }], mainCharacters: ['a'] },
      [{ pageNumber: 1 }], 'An arc.', 'Page 1: wide — Alpha — x — y.');
    for (const built of [beats, check]) expect(built).not.toContain('{PAGE_CHANGE}');
  });
});
