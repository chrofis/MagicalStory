import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const B = require('../../server/lib/promptBuilders');

// Owner, 2026-09-23 (dragon run 6, staging job_1790100385959_1nitlympp, Lab 1422).
// ONE style rulebook for every pass that writes page prose. The lector, which
// had no copy, split a sentence into a paired negation; the writer and the
// repair each held a hand-kept copy that had already drifted. Asserted on the
// BUILT prompts.

const inputData = {
  language: 'de-ch',
  languageLevel: 'standard',
  characters: [{ id: 1, name: 'Mara', age: 7, gender: 'female', isMain: true }],
  mainCharacters: [1],
  pages: 4,
};
const PLAN = 'wide — Mara — Mara pulls the rope — the sail is up';
const PAGES = [{ pageNumber: 1, text: 'Mara zog am Seil.', planLine: PLAN, sceneBrief: 'Mara pulls a rope on a small boat.' }];

describe('the style rulebook reaches every prose-writing pass', () => {
  let built: Record<string, string>;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    built = {
      writer: B.buildStoryTextFromBeatsPrompt(inputData, [{ pageNumber: 1, planLine: PLAN }], [], 'An arc.'),
      trialWriter: B.buildTrialStoryPrompt({ trialMode: true, language: 'de', storyTheme: 'realistic', storyDetails: 'a kite caught in a tree', characters: [{ name: 'Mia', age: 6, gender: 'female', isMain: true }] }, 5),
      repair: B.buildTextRefinePrompt(inputData, PAGES, 'FAULT[CAUSE]: p1 — something', 'An arc.'),
      diff: B.buildTextDiffPrompt(inputData, [{ pageNumber: 1, before: 'Niemand antwortete ihm oder widersprach ihm.', after: 'Keiner antwortete. Keiner widersprach ihm.' }]),
      lector: B.buildTextProofreadPrompt(inputData, PAGES),
    };
  });

  it('is one non-empty constant', () => {
    expect(typeof B.STYLE_RULEBOOK).toBe('string');
    expect(B.STYLE_RULEBOOK.split('\n').length).toBeGreaterThanOrEqual(6);
  });

  for (const pass of ['writer', 'trialWriter', 'repair', 'diff', 'lector']) {
    it(`${pass}: carries the rulebook exactly once and no unfilled placeholder`, () => {
      const p = built[pass];
      expect(p.split(B.STYLE_RULEBOOK).length - 1).toBe(1);
      expect(p).not.toContain('{STYLE_RULEBOOK}');
    });
  }

  it('no template keeps a hand copy of a rulebook rule', () => {
    const dir = path.join(__dirname, '../../prompts');
    for (const f of ['story-text-from-beats.txt', 'story-trial.txt', 'text-refine.txt', 'story-text-diff.txt', 'story-text-proofread.txt']) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(t, f).not.toMatch(/paired negation/i);
      expect(t, f).not.toMatch(/bare fragment/i);
      expect(t, f).not.toMatch(/solemn sentences/i);
    }
  });

  it('the motive-at-the-act rule reaches both writers and the repair', () => {
    for (const pass of ['writer', 'trialWriter', 'repair']) {
      expect(built[pass]).toContain(B.MOTIVE_AT_THE_ACT_RULE);
      expect(built[pass]).not.toContain('{MOTIVE_AT_THE_ACT}');
    }
  });

  it("the writer's analysis step checks each later-revealed motive and each stated size or look", () => {
    // Lab 1426 (rule alone): no glimpse at the p10 refusal. Lab 1428 (rule + this
    // analysis step): the writer named the refusal and placed a glimpse at it.
    const step1 = built.writer.split(/\r?\n/).find(l => l.startsWith('Step 1')) || '';
    expect(step1).toMatch(/refusal, demand, flight or lie whose reason the story gives only later/);
    expect(step1).toMatch(/each size or look a page states and what in the plot turns on it/);
  });

  it("the writer's and the repair's specific-form rule excludes sizes and looks", () => {
    for (const pass of ['writer', 'repair']) {
      const sentence = built[pass].split('\n').find(l => l.includes('in its specific form')) || '';
      expect(sentence).toMatch(/a size or a look is not such a fact/);
    }
  });
});

describe('the arc-informed audit carries the ending check and the widened INFERRED', () => {
  let audit: string;
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    audit = B.buildTextAuditPrompt(inputData, PAGES, 'An arc.');
  });

  const question = (name: string) => (audit.match(new RegExp(`^\\d+\\. ${name}:[^\\n]*`, 'm')) || [''])[0];

  it('has an ENDING question that faults a summing-up close', () => {
    expect(question('ENDING')).toMatch(/sums up what the story meant/);
  });

  it('INFERRED reaches any act whose reason comes later, not only the ending', () => {
    const q = question('INFERRED');
    expect(q).toMatch(/refuses, demands, flees, hides or lies/);
    expect(q).toMatch(/fault on the page of the act/);
  });

  it('PAYOFF catches an unanswered demand', () => {
    expect(question('PAYOFF')).toMatch(/demand or order go unanswered/);
  });

  it('LOADBEARING never counts an unused size or look as a dropped fact', () => {
    expect(question('LOADBEARING')).toMatch(/a size, a colour, a look\W+is never load-bearing, and a page that leaves it out drops nothing/);
  });
});
