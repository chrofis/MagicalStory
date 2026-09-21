/**
 * A7 — the text-refine stage judges by ITS OWN criteria, for its own inputs.
 *
 * The criteria used to be sliced out of outline-analysis-imagefirst.txt, a
 * checklist written for the OUTLINE REVIEWER. On every beats run the refiner
 * was therefore told to read `---STORY DRAFT---` / `---SCENE PAGES---` blocks
 * it is never sent, to emit `FIXES REQUIRED` entries and SCENE/METADATA fix
 * lines it cannot return, and to check a `characters[]` / `background` JSON it
 * never receives.
 *
 * A15 — the plan line is deliberately NOT re-derived after the refine (the
 * picture is already drawn from it), so the disagreement it can leave behind is
 * measured for free instead.
 *
 * Pins BEHAVIOUR — which inputs reach the prompt and which contracts it may
 * not carry — never the prompt's wording.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { computePlanTextDrift } = require('../../server/lib/textRefine');
const { loadPromptTemplates } = require('../../server/services/prompts');

const storyData: any = {
  language: 'de-ch',
  languageLevel: '1st-grade',
  mainCharacters: ['c1'],
  characters: [
    { id: 'c1', name: 'Levin', age: 7, gender: 'male', personality: 'curious' },
    { id: 'c2', name: 'Julian', age: 5, gender: 'male', personality: 'shy' },
  ],
  visualBible: {
    secondaryCharacters: [
      { id: 'CHR001', name: 'Silvan', age: 8, pages: [7, 9, 10], description: '8. a boy. Signature: always slightly scowling. Clothing: a blue jacket.' },
    ],
  },
};
const pages = [
  { pageNumber: 1, text: 'Levin rennt zum Brunnen.', sceneIntent: 'boy at a fountain', sceneBrief: 'A boy runs to a fountain.', planLine: 'wide — Levin, Julian — the boys reach the fountain — they are there now' },
  { pageNumber: 2, text: 'Silvan nimmt Julian den Ball weg.', sceneIntent: 'a boy takes a ball', sceneBrief: 'A boy takes a ball.', planLine: 'mid — Silvan, Julian — the ball is taken — Julian has lost it' },
];

describe('text-refine carries its own criteria (A7)', () => {
  let prompt: string;
  beforeAll(async () => {
    await loadPromptTemplates();
    prompt = PB.buildTextRefinePrompt(storyData, pages, 'FAULT[LENGTH]: p1 — too long', 'The arc.');
  });

  it('builds, with every placeholder filled', () => {
    expect(prompt).toBeTruthy();
    expect(prompt.match(/\{[A-Z_]+\}/g)).toBeNull();
  });

  it('never names a block this stage is not sent', () => {
    for (const dead of ['---STORY DRAFT---', '---SCENE PAGES---', 'FIXES REQUIRED']) {
      expect(prompt, dead).not.toContain(dead);
    }
  });

  it('never asks for an output shape this stage cannot return', () => {
    // the stage returns rewritten pages; fix lines and scene/metadata edits are
    // the outline reviewer's answer, not this one's.
    expect(prompt).not.toMatch(/SCENE\/METADATA fix/i);
    expect(prompt).not.toMatch(/emit a (TEXT )?fix in/i);
  });

  it('names the sections it actually sends in the output contract', () => {
    const contract = prompt.slice(prompt.indexOf('---ANALYSIS---'));
    for (const sec of ['**A. ', '**B. ', '**C. ', '**D. ', '**E. ']) {
      expect(prompt, sec).toContain(sec);
    }
    expect(contract).toContain('A, B, C, D and E');
  });

  it('probes the cast the PAGES carry, not only the commissioned roster', () => {
    expect(prompt).toContain('Levin, Julian, Silvan');
    expect(prompt).toContain('**Silvan**');
    expect(prompt).toContain('On page(s): 7, 9, 10');
    // psychological only — the pictures already lock appearance
    expect(prompt).not.toContain('a blue jacket');
  });

  it('negative control: no invented secondaries, no invented names', () => {
    const p2 = PB.buildTextRefinePrompt({ ...storyData, visualBible: {} }, pages, '', '');
    // the page TEXT still names him — it is the CAST LINE and the details
    // block that must not invent him.
    expect(p2).toContain('For EACH of Levin, Julian write');
    expect(p2).not.toContain('**Silvan**');
  });

  it('scopes the rewrite set to the pages the audit findings name', () => {
    expect(prompt).toContain('AUDIT FINDINGS names it');
  });

  it('leaves sentence rhythm to the reading level alone', () => {
    // 1st grade's own PACING asks for short sentences; the refiner used to
    // carry a blanket "merge runs of short sentences" trigger over the top.
    expect(prompt).not.toContain('several short sentences run in a row');
    expect(prompt).toContain('keep sentences short, one idea each');
  });
});

describe('plan/text drift is measured, never re-planned (A15)', () => {
  const original = pages;

  it('flags a page whose refined text dropped a character the plan stages', () => {
    const current = [
      { pageNumber: 1, text: 'Levin und Julian rennen zum Brunnen.' },
      { pageNumber: 2, text: 'Der Ball ist weg.' },   // Silvan and Julian both gone
    ];
    const drift = computePlanTextDrift(storyData, original, current);
    expect(drift).toHaveLength(1);
    expect(drift[0].pageNumber).toBe(2);
    expect(drift[0].dropped.sort()).toEqual(['Julian', 'Silvan']);
  });

  it('says nothing about a page the refiner left alone', () => {
    const current = original.map(p => ({ pageNumber: p.pageNumber, text: p.text }));
    expect(computePlanTextDrift(storyData, original, current)).toEqual([]);
  });

  it('says nothing when a rewrite keeps the staged cast', () => {
    const current = [
      { pageNumber: 1, text: 'Levin rennt los, und Julian folgt ihm zum Brunnen.' },
      { pageNumber: 2, text: 'Silvan nimmt Julian den Ball einfach weg.' },
    ];
    expect(computePlanTextDrift(storyData, original, current)).toEqual([]);
  });

  it('never fires where the plan and the prose never agreed in the first place', () => {
    // Silvan is staged on p2 but was absent from the ORIGINAL text too: the
    // refine did not cause it, so it is not this check's finding.
    const before = [{ ...original[1], text: 'Der Ball rollt weg.' }];
    const current = [{ pageNumber: 2, text: 'Der Ball rollt den Hang hinunter.' }];
    expect(computePlanTextDrift(storyData, before, current)).toEqual([]);
  });

  it('is inert on a unified-mode story, which has no plan lines', () => {
    const before = [{ pageNumber: 1, text: 'Levin rennt.', planLine: '' }];
    const current = [{ pageNumber: 1, text: 'Er rennt.' }];
    expect(computePlanTextDrift(storyData, before, current)).toEqual([]);
  });
});
