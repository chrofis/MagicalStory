/**
 * THE CAST TABLE (owner, 2026-09-25, on Lab #1495/#1496). The planner writes,
 * before its plan lines, each commissioned character's deed page and the pages
 * they are in frame on, and the last page's cast; the counters hold every plan
 * line to it (CAST_PROMISE_BROKEN) and a re-plan is shown it.
 *
 * Pins behaviour: the parse (and that it fails loudly), the counter finding on
 * a broken promise, the built prompts carrying the block spec once, and the
 * main character read from the story's declared main. Offline and free.
 */
import { describe, it, beforeAll, expect } from 'vitest';

const CC = require('../../server/lib/castCoverage');
const { runPlanCounters } = require('../../server/lib/planCounters');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

const LISTED = ['Levin', 'Julian', 'Max', 'Kiaan'];

const REPLY = [
  '---CAST---',
  'Levin — deed page 3: holds the egg up and says it must be kept warm, alone — also on pages 1, 8',
  'Julian — deed page 14: rolls the warm stone into the hole, alone — also on pages 1, 7',
  'Max — deed page 8: pushes one arm into the dark hole, with Levin — also on pages 1, 12',
  'Kiaan — deed page 12: holds up the round stone he found, with Max — also on pages 1, 6',
  'Ending page 8: Levin, Julian, Max and Kiaan',
  '---PAGE PLAN---',
  'Page 1: wide — Levin, Julian, Max, Kiaan — the four kick a ball — the place is set',
].join('\n');

describe('parsePlanCastBlock', () => {
  it('reads each character line and the ending line', () => {
    const t = CC.parsePlanCastBlock(REPLY, { listed: LISTED });
    expect(t.characters.map((c: any) => [c.name, c.deedPage, c.alsoOn])).toEqual([
      ['Levin', 3, [1, 8]], ['Julian', 14, [1, 7]], ['Max', 8, [1, 12]], ['Kiaan', 12, [1, 6]],
    ]);
    expect(t.characters[3].deed).toBe('holds up the round stone he found, with Max');
    expect(t.ending).toEqual({ page: 8, names: ['Levin', 'Julian', 'Max', 'Kiaan'] });
    expect(t.raw).not.toContain('Page 1:');
  });
  it('fails loudly: no block, no ending line, a character without a line', () => {
    expect(() => CC.parsePlanCastBlock('---PAGE PLAN---\nPage 1: x', { listed: LISTED })).toThrow(/no ---CAST--- block/);
    expect(() => CC.parsePlanCastBlock(REPLY.replace(/Ending page 8:[^\n]*\n/, ''), { listed: LISTED })).toThrow(/Ending page/);
    expect(() => CC.parsePlanCastBlock(REPLY.replace(/Kiaan — deed[^\n]*\n/, ''), { listed: LISTED })).toThrow(/Kiaan/);
  });
});

describe('CAST_PROMISE_BROKEN: the counters hold each plan line to the table', () => {
  // Eight pages; the plan keeps every promise except Kiaan's deed page (page 12
  // does not exist here, so the table is re-pointed to page 6 below) and the ending.
  const WHO: Record<number, string[]> = {
    1: ['Levin', 'Julian', 'Max', 'Kiaan'], 2: [], 3: ['Levin'], 4: ['Julian'],
    5: ['Kiaan', 'Max'], 6: ['Max', 'Kiaan'], 7: ['Julian', 'Levin'], 8: ['Levin', 'Max'],
  };
  const pages = Object.entries(WHO).map(([n, who]) => ({
    pageNumber: Number(n),
    planLine: `${Number(n) % 2 ? 'medium' : 'wide'} — ${who.join(', ') || 'the old tree'} — something is done — something changes`,
  }));
  const roster = new Map(pages.map(p => [p.pageNumber, { people: WHO[p.pageNumber], things: [], covers: [] }]));
  const table = {
    raw: '',
    characters: [
      { name: 'Levin', deedPage: 3, deed: '', alsoOn: [1, 8] },
      { name: 'Julian', deedPage: 4, deed: '', alsoOn: [1, 7] },
      { name: 'Max', deedPage: 5, deed: '', alsoOn: [1, 8] },
      // Promised page 6 as Kiaan's deed page; the check finds Max's action there
      // and Kiaan's on page 5.
      { name: 'Kiaan', deedPage: 6, deed: '', alsoOn: [1, 5] },
    ],
    ending: { page: 8, names: ['Levin', 'Julian', 'Max', 'Kiaan'] },
  };
  const actions = [
    { key: 'Levin', sentence: 3, page: 3 }, { key: 'Julian', sentence: 4, page: 4 },
    { key: 'Max', sentence: 6, page: 6 }, { key: 'Kiaan', sentence: 5, page: 5 },
  ];
  const run = (extra: any = {}) => runPlanCounters({ pages, roster, commissionedNames: LISTED, listedNames: LISTED, mainName: 'Levin', castTable: table, actions, ...extra });

  it('names the page whose instant is another character\'s', () => {
    const lines = run().lines.filter((l: string) => l.startsWith('PLAN[CAST_PROMISE_BROKEN]'));
    expect(lines).toContain("PLAN[CAST_PROMISE_BROKEN] page 6: the CAST block promises Kiaan page 6 as their deed page, but page 6's instant is Max's (the check finds it on page 5)");
    // Max's own promise breaks the same way, page 5 being Kiaan's instant.
    expect(lines.some((l: string) => l.startsWith('PLAN[CAST_PROMISE_BROKEN] page 5: the CAST block promises Max page 5'))).toBe(true);
    // The ending leaves out Julian and Kiaan.
    expect(lines).toContain('PLAN[CAST_PROMISE_BROKEN] page 8: the CAST block keeps Levin, Julian, Max, Kiaan together on page 8, but page 8\'s who column leaves out Julian, Kiaan');
    // Kept promises file nothing: Levin's deed page 3 and his pages 1 and 8.
    expect(lines.some((l: string) => /promises Levin/.test(l))).toBe(false);
  });

  it('is must-fix and counts toward convergence', () => {
    const f = { kind: 'counter', code: 'CAST_PROMISE_BROKEN', line: 'PLAN[CAST_PROMISE_BROKEN] page 6: x' };
    expect(PB.replanRank(f)).toBe('must');
    expect(PB.countsTowardConvergence(f)).toBe(true);
  });

  it('a character the check gave no ACTION line is unanswered, never broken', () => {
    const r = run({ actions: actions.filter(a => a.key !== 'Kiaan') });
    expect(r.stats.castTable.unanswered).toContain('Kiaan');
    expect(r.lines.some((l: string) => /promises Kiaan page 6/.test(l))).toBe(false);
  });

  it('no table, no counter', () => {
    const r = run({ castTable: null });
    expect(r.findings.map((f: any) => f.code)).not.toContain('CAST_PROMISE_BROKEN');
    expect(r.stats.castTable).toBeNull();
  });
});

describe('MAIN_UNDER_HALF holds the story\'s declared main, not the first name on the list', () => {
  // Staging job_1789207854566_l43qgl34w: characters Sarah, Saira, Facundo,
  // Fiona, Lorena; mainCharacters = [Fiona's id]. Lab #1496 filed
  // "Sarah is in frame on 3/16 pages — the main character belongs in at least half".
  const input = {
    characters: ['Sarah', 'Saira', 'Facundo', 'Fiona', 'Lorena'].map((name, i) => ({ id: i + 1, name, age: 8 })),
    mainCharacters: [4],
  };
  it('pickMainCharacters names Fiona, and the counter holds Fiona', () => {
    const mainName = PB.pickMainCharacters(input).focus.name;
    expect(mainName).toBe('Fiona');
    const pages = [1, 2, 3, 4].map(n => ({ pageNumber: n, planLine: `medium — ${n <= 3 ? 'Fiona' : 'Sarah'} — acts — changes` }));
    const roster = new Map(pages.map(p => [p.pageNumber, { people: [p.pageNumber <= 3 ? 'Fiona' : 'Sarah'], things: [], covers: [] }]));
    const names = input.characters.map(c => c.name);
    const r = runPlanCounters({ pages, roster, commissionedNames: names, listedNames: names, mainName });
    expect(r.findings.map((f: any) => f.code)).not.toContain('MAIN_UNDER_HALF');
    expect(r.stats.mainCharacter).toBe('Fiona');
  });
});

describe('the built prompts carry the table', () => {
  const inputData: any = {
    title: 'T', characters: LISTED.map((name, i) => ({ id: `c${i}`, name, age: 6, gender: 'male' })),
    mainCharacters: ['c0'], language: 'en', languageLevel: 'standard', pages: 18,
    storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
  };
  const cov = CC.castCoverage({ pageCount: 18, castCount: 4 });
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the first division asks for the block once, with the floor\'s page count filled from code', () => {
    const p = PB.buildBeatsPrompt(inputData, 18, { finalArc: '1. A thing happens.' });
    expect(count(p, CC.castTableSpec(cov, 18))).toBe(1);
    expect(count(p, CC.castTableFormat(cov, 18))).toBe(1);
    expect(count(p, '---CAST---')).toBe(1);
    // Floor 3 → the deed page plus two more.
    expect(CC.castTableSpec(cov, 18)).toContain('2 more pages');
    expect(CC.castTableFormat(cov, 18)).toContain('also on pages <N>, <N>');
    expect(CC.castTableFormat(cov, 18)).toContain('Ending page 18:');
    expect(p).not.toMatch(/\{CAST_TABLE\}|\{CAST_FORMAT\}/);
  });

  it('a re-plan is shown the table under RE-DIVIDE and asked for no new one', () => {
    const table = CC.parsePlanCastBlock(REPLY, { listed: LISTED });
    const replan = PB.buildReplanSection('Page 1: wide — Levin — acts — changes', [{ kind: 'counter', code: 'CAST_PROMISE_BROKEN', line: 'PLAN[CAST_PROMISE_BROKEN] page 1: x' }], { pageCount: 18, castTable: table });
    const p = PB.buildBeatsPrompt(inputData, 18, { finalArc: '1. A thing happens.', replan, castTable: table });
    expect(count(p, '---CAST---')).toBe(1);
    expect(count(p, CC.castTableBlock(table))).toBe(1);
    expect(p).not.toContain(CC.castTableFormat(cov, 18));
    expect(p).toContain(CC.castTableSpec(cov, 18, { replan: true, table }));
  });

  it('the plan check reads the block once, and nothing when there is none', () => {
    const table = CC.parsePlanCastBlock(REPLY, { listed: LISTED });
    const beats = Array.from({ length: 18 }, (_, i) => ({ pageNumber: i + 1, planLine: 'wide — Levin — acts — changes' }));
    const withTable = PB.buildPlanCheckPrompt(inputData, beats, '1. A thing happens.', '', { castTable: table });
    expect(count(withTable, CC.castTableBlock(table))).toBe(1);
    const without = PB.buildPlanCheckPrompt(inputData, beats, '1. A thing happens.', '');
    expect(without).not.toContain('---CAST---');
    expect(without).not.toContain('{CAST_TABLE_SECTION}');
  });
});
