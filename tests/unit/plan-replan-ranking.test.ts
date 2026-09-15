import { describe, it, expect, beforeAll } from 'vitest';

const { runPlanCounters } = require('../../server/lib/planCounters');
const { parsePlanCheck, buildReplanSection, replanRank, findingPages, buildBeatsPrompt } = require('../../server/lib/promptBuilders');

// Owner ruling 2026-09-15: the high-action grant is GONE. plan-check.txt
// checks 9 and 10 (deed-and-effect, two heights) are now universally true, so
// the planner may no longer buy its way out of them, and no budget, phrase or
// stat survives.
describe('the high-action grant is gone', () => {
  it('exports no budget helper', () => {
    const pc = require('../../server/lib/planCounters');
    expect(pc.highActionPageBudget).toBeUndefined();
    expect(pc.highActionPagesPhrase).toBeUndefined();
  });

  it('reports no allowance in the stats', () => {
    const pages = [
      { pageNumber: 1, planLine: 'close-up — Mara — Mara grips the rail — she has decided' },
      { pageNumber: 2, planLine: 'wide — Mara — Mara pulls the rope — the sail is up' },
    ];
    const roster = new Map<number, { people: string[]; things: string[] }>([
      [1, { people: ['Mara'], things: [] }],
      [2, { people: ['Mara'], things: [] }],
    ]);
    const res = runPlanCounters({ pages, roster, commissionedNames: ['Mara'] });
    expect(res.stats).not.toHaveProperty('highActionAllowance');
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
    // Q5 stays advisory: it bundles presence-only and after-state instants, and
    // ranking all of it must-fix churned every page and cost the Q4/Q8 pictures.
    expect(replanRank({ kind: 'check', check: 5 })).toBe('also');
    // Q9 detects the deed-and-effect page reliably, but the planner answers a
    // named climax page by destroying it rather than splitting it, so advisory.
    expect(replanRank({ kind: 'check', check: 9 })).toBe('also');
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
  // Owner, 2026-09-15: PEOPLELESS_ON_INTERACTION_PAGE is must-fix, not advisory.
  // A people-free page is a feature, but not on the page whose drama is between
  // people — the re-plan resolves it rather than noting it.
  it('treats a peopleless interaction page exactly like the other must-fix codes', () => {
    const finding = {
      kind: 'counter',
      code: 'PEOPLELESS_ON_INTERACTION_PAGE',
      pages: [12],
      line: 'PLAN[PEOPLELESS_ON_INTERACTION_PAGE]: page 12 puts no one in frame',
    };
    expect(replanRank(finding)).toBe('must');
    // The round loop counts must-fix findings with exactly this predicate
    // (beatsPipeline.js mustFixCount / stillMustFix): an unresolved one keeps
    // the round alive and blocks a discard, just like NO_FOCAL_PAGE.
    const mustFixCount = (findings: any[]) => findings.filter(f => replanRank(f) === 'must').length;
    expect(mustFixCount([finding, { kind: 'counter', code: 'SHOT_VARIETY' }])).toBe(1);
    expect(mustFixCount([finding])).toBe(mustFixCount([{ kind: 'counter', code: 'NO_FOCAL_PAGE' }]));
    // It names its page structurally, so the re-plan's restore-merge can ask
    // for that page back.
    expect(findingPages(finding)).toEqual([12]);
    const section = buildReplanSection('Page 12: wide — ...', [finding]);
    expect(section).toContain('## MUST FIX');
    expect(section).toContain('PEOPLELESS_ON_INTERACTION_PAGE');
    expect(section).not.toContain('## ALSO NOTED');
  });
});

describe('the planner prompt', () => {
  beforeAll(async () => {
    await require('../../server/services/prompts').loadPromptTemplates();
  });

  it('grants no high-action exemption and leaves no placeholder behind', () => {
    const prompt = buildBeatsPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', pages: 18 },
      18,
      { finalArc: 'An arc.' },
    );
    expect(prompt).toBeTruthy();
    expect(prompt).not.toContain('{HIGH_ACTION_PAGES}');
    expect(prompt).not.toContain('high-action instant');
    expect(prompt).toContain('the reunion outranks the bystander');
  });

  // Owner decision 2026-09-15: a people-free page is a feature, but not on a
  // page whose drama is between people. The counter
  // PEOPLELESS_ON_INTERACTION_PAGE is the mechanical half; this is the rule the
  // planner is actually given. Asserted on the BUILT prompt, not the template.
  it('tells the planner which page may be people-free', () => {
    const prompt = buildBeatsPrompt(
      { characters: [{ name: 'Mara', age: 7 }], language: 'de', pages: 18 },
      18,
      { finalArc: 'An arc.' },
    );
    expect(prompt).toContain('At least one page in the book earns this.');
    expect(prompt).toContain('never a page whose drama is between people');
  });
});
