import { describe, it, expect, beforeAll } from 'vitest';

const B = require('../../server/lib/promptBuilders');
const { getLanguageInstruction } = require('../../server/lib/languages');

const story = (age: number) => ({
  characters: [{ name: 'Mara', age, isMain: true }],
  language: 'de',
  pages: 10,
});

// Owner ruling 2026-09-15 (generator↔critic gap audit, rows 2/13/14/15/16/17/
// 18/26/27/28). story-text-audit.txt asks twelve questions the writer was never
// given. The systemic cause the audit named — the ANALYSIS stub in the unified
// writer — is moot: both unified writers were deleted 2026-09-15, so the live
// writers are the beats text writer and the trial writer. Asserted on the BUILT
// prompt.
describe('the text audit\'s questions reach the writer', () => {
  let prompt: string;

  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
    prompt = B.buildStoryTextFromBeatsPrompt(story(7), [{ pageNumber: 1, planLine: 'wide — Mara — Mara pulls the rope — the sail is up' }], [], 'An arc.');
  });

  it('Q1 ASSUMED — a character knows only what a page gave them', () => {
    expect(prompt).toContain('A character knows only what an earlier page or picture gave them');
  });

  it('Q6 ENTRANCE — a stated cause places a character at their first appearance', () => {
    expect(prompt).toContain("A character's first appearance carries the stated cause that puts them there");
  });

  it('Q3 DEVICE — a device earns its meaning where it first appears', () => {
    expect(prompt).toContain('earns its meaning on the page it first appears');
  });

  it('Q8 LIMIT — the limit the plot leans on is stated and never broken', () => {
    expect(prompt).toContain('A limit the plot leans on');
    expect(prompt).toContain('no later page breaks it');
  });

  it('Q9 PAYOFF — a promise is answered, a price leaves a mark', () => {
    expect(prompt).toContain('is shown answered on a later page, and every price paid leaves a mark a later page shows');
  });

  it('Q4 TRANSITION — a change of company or possession carries its path', () => {
    expect(prompt).toContain('A change of place, of what someone holds, or of the company they are among carries its path on the page.');
  });

  it('Q7 LANGUAGE — the adjacent-sentence echo', () => {
    expect(prompt).toContain('No phrase is repeated from a neighbouring sentence.');
  });

  it('Q12 LOADBEARING was already delivered', () => {
    expect(prompt).toContain('never genericized');
  });
});

// Row 17's other half — quotation nesting and closure, stated once for every
// language rather than in each per-language instruction.
describe('quotation hygiene rides on every language instruction', () => {
  it('reaches every language', () => {
    for (const code of ['de-ch', 'fr', 'en', 'it']) {
      expect(getLanguageInstruction(code)).toContain('never open one of a kind inside another of the same kind, and never leave one unclosed');
    }
  });
});

// Rows 16 + 28 — one constant, every consumer of the story shape.
describe('the causal coherence rule carries the idle and unforced clauses', () => {
  it('extends the prop half to plans, warnings and promises, and closes the easier option', () => {
    const shape = B.buildStoryShapeSection(story(9), 10);
    expect(shape).toContain('never an action, a plan, a warning or a promise no later page acts on');
    expect(shape).toContain('No consequence falls while an easier option stands open');
  });
});

// Owner ruling C — PULL is scoped to the bands whose books are one arc.
describe('the PULL question is age-band aware', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });

  const audit = (age: number) => B.buildTextAuditPrompt(
    story(age),
    [{ pageNumber: 1, text: 'A page.', planLine: 'wide — Mara — Mara pulls the rope — the sail is up' }],
    'An arc.',
  );

  it('asks it of a journey-band book', () => {
    const p = audit(9);
    expect(p).toContain('10. PULL: does anything remain open at the end of the page that the next page answers?');
  });

  it('exempts a simple-band book', () => {
    for (const age of [1, 2, 3]) {
      const p = audit(age);
      expect(p).toContain('10. PULL: skip this question');
      expect(p).not.toContain('does anything remain open at the end of the page');
    }
  });

  it('leaves no placeholder behind on either path', () => {
    for (const age of [2, 9]) expect(audit(age)).not.toContain('{PULL_QUESTION}');
  });
});

// The abandon-then-reclaim rule (staging job_1789584708605_rts4wqupm, 2026-09-17).
// A character called the story's object worthless, set it down and rode off on
// p13; on p17 he blocked the path demanding it back. Neither auditor flagged it
// and neither had a question that named the class. It is NOT a new fault type:
// it rides on CAUSE in the arc-informed audit (the question about uncaused
// states) and on CONTRADICTION in the blind one (the question about a page
// saying otherwise), and the matching rule reaches both live writers. Asserted
// on the BUILT prompts.
describe('a reversed decision is a rule on both sides', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });

  const beats = () => B.buildStoryTextFromBeatsPrompt(
    story(7), [{ pageNumber: 1, planLine: 'wide \u2014 Mara \u2014 Mara pulls the rope \u2014 the sail is up' }], [], 'An arc.',
  );
  const trial = () => B.buildTrialStoryPrompt({
    trialMode: true, language: 'de', storyTheme: 'realistic',
    storyDetails: 'a kite caught in a tree',
    characters: [{ name: 'Mia', age: 6, gender: 'female', isMain: true }],
  }, 5);
  const sighted = () => B.buildTextAuditPrompt(
    story(7), [{ pageNumber: 1, text: 'A page.', planLine: 'wide \u2014 Mara \u2014 Mara pulls the rope \u2014 the sail is up' }], 'An arc.',
  );
  const blind = () => B.buildTextAuditBlindPrompt(story(7), [{ pageNumber: 1, text: 'A page.' }]);

  it('the beats writer is told it', () => {
    expect(beats()).toContain('stays done with it; where a later page has them want it back or take it up again, that page says what changed');
  });

  it('the trial writer is told it', () => {
    expect(trial()).toContain('stays done with it; where a later scene has them want it back or take it up again, that scene says what changed');
  });

  it('the arc-informed auditor asks it under CAUSE, not under a new type', () => {
    const p = sighted();
    expect(p).toContain('takes back, demands or acts on a thing they had refused, given up or discarded');
    expect(p.match(/^\d+\. [A-Z]+:/gm)).toHaveLength(12);
  });

  it('the blind auditor asks it under CONTRADICTION, not under a new type', () => {
    const p = blind();
    expect(p).toContain('acting against a decision an earlier page had them state or carry out');
    expect(p.match(/^\d+\. [A-Z]+:/gm)).toHaveLength(5);
  });

  it('no auditor gained a fault type the writer was never given', () => {
    const types = (p: string) => (p.match(/^\d+\. ([A-Z]+):/gm) || []).map(m => m.replace(/^\d+\. /, '').replace(':', ''));
    expect(types(sighted())).toEqual([
      'ASSUMED', 'UNFORCED', 'DEVICE', 'TRANSITION', 'CAUSE', 'ENTRANCE',
      'LANGUAGE', 'LIMIT', 'PAYOFF', 'PULL', 'INFERRED', 'LOADBEARING',
    ]);
    expect(types(blind())).toEqual(['CONFUSION', 'CONTRADICTION', 'IDLE', 'TRANSITION', 'PAYOFF']);
  });
});
