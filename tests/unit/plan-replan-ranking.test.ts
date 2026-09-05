import { describe, it, expect, beforeAll } from 'vitest';

const { highActionPageBudget, highActionPagesPhrase, runPlanCounters } = require('../../server/lib/planCounters');
const { parsePlanCheck, buildReplanSection, replanRank, buildBeatsPrompt } = require('../../server/lib/promptBuilders');

describe('high-action page budget', () => {
  it('scales with the book: 1 short, 2 normal, 3 long', () => {
    expect(highActionPageBudget(6)).toBe(1);
    expect(highActionPageBudget(8)).toBe(1);
    expect(highActionPageBudget(9)).toBe(2);
    expect(highActionPageBudget(16)).toBe(2);
    expect(highActionPageBudget(17)).toBe(3);
    expect(highActionPageBudget(24)).toBe(3);
  });

  it('falls back to the short-book budget on a junk page count', () => {
    expect(highActionPageBudget(undefined as any)).toBe(1);
    expect(highActionPagesPhrase(18)).toBe('three pages');
    expect(highActionPagesPhrase(12)).toBe('two pages');
    expect(highActionPagesPhrase(4)).toBe('one page');
  });
});

describe('counters stay consistent with the allowance', () => {
  const pages = [
    { pageNumber: 1, planLine: 'close-up — Mara — Mara grips the rail — she has decided' },
    { pageNumber: 2, planLine: 'wide — Mara and the creature — the creature lifts Mara off the ground — they are together' },
  ];
  it('carries the budget into the stats and raises no finding against a high-action page', () => {
    const res = runPlanCounters({ pages, commissionedNames: ['Mara'], highActionPages: 2 });
    expect(res.stats.highActionAllowance).toBe(2);
    // Nothing here counts interlocking, elevation or creatures; only NAMES.
    expect(res.findings.some((f: any) => f.code === 'CAST_OVER_3')).toBe(false);
    expect(res.findings.some((f: any) => f.code === 'CAST_OVER_CEILING')).toBe(false);
  });
  it('defaults the allowance from the page count when the caller omits it', () => {
    expect(runPlanCounters({ pages }).stats.highActionAllowance).toBe(1);
  });
});

describe('parsePlanCheck keeps the check number', () => {
  it('returns {check, text} per finding', () => {
    const out = parsePlanCheck('4. Page 17 does not stage the reunion.\n2. Page 3 names nobody.');
    expect(out).toEqual([
      { check: 4, text: 'Page 17 does not stage the reunion.' },
      { check: 2, text: 'Page 3 names nobody.' },
    ]);
  });
  it('reads NONE as a clean verdict', () => {
    expect(parsePlanCheck('NONE')).toEqual([]);
    expect(parsePlanCheck('')).toEqual([]);
  });
});

describe('re-plan ranking', () => {
  it('ranks the wanted picture and the last page above the counters', () => {
    expect(replanRank({ kind: 'check', check: 4 })).toBe('must');
    expect(replanRank({ kind: 'check', check: 8 })).toBe('must');
    expect(replanRank({ kind: 'check', check: 5 })).toBe('also');
    expect(replanRank({ kind: 'counter', code: 'NO_FOCAL_PAGE' })).toBe('must');
    expect(replanRank({ kind: 'counter', code: 'SHOT_VARIETY' })).toBe('also');
    expect(replanRank('a legacy string')).toBe('also');
  });

  it('splits the section into MUST FIX and ALSO NOTED and says which wins', () => {
    const section = buildReplanSection('Page 1: wide — ...', [
      { kind: 'counter', code: 'SHOT_VARIETY', line: 'PLAN[SHOT_VARIETY]: only two shot types' },
      { kind: 'check', check: 4, line: 'CHECK[4]: page 17 never stages the reunion' },
      { kind: 'counter', code: 'NO_FOCAL_PAGE', line: 'PLAN[NO_FOCAL_PAGE]: a character has no focal page' },
    ]);
    expect(section).toContain('## MUST FIX');
    expect(section).toContain('## ALSO NOTED');
    expect(section.indexOf('## MUST FIX')).toBeLessThan(section.indexOf('## ALSO NOTED'));
    expect(section.indexOf('CHECK[4]')).toBeLessThan(section.indexOf('SHOT_VARIETY'));
    expect(section).toContain('the must-fix wins');
    // Every finding survives the ranking — nothing is dropped.
    expect(section).toContain('NO_FOCAL_PAGE');
    expect(section).toContain('SHOT_VARIETY');
  });

  it('is empty with no findings, and tolerates legacy plain strings', () => {
    expect(buildReplanSection('Page 1: ...', [])).toBe('');
    const legacy = buildReplanSection('Page 1: ...', ['PLAN[SHOT_VARIETY]: only two shot types']);
    expect(legacy).toContain('## ALSO NOTED');
    expect(legacy).not.toContain('## MUST FIX');
  });
});

describe('the planner prompt carries the injected budget', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });

  it('fills {HIGH_ACTION_PAGES} and leaves no placeholder behind', () => {
    const prompt = buildBeatsPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', pages: 18 },
      18,
      { finalArc: 'An arc.' },
    );
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain('{HIGH_ACTION_PAGES}');
    expect(prompt).toContain('Up to three pages in the book may stage a high-action instant');
    expect(prompt).toContain('the reunion outranks the bystander');
  });
});
