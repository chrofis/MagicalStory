/**
 * Cast actions, 2026-10-12 (tasks/cast-landmarks-2026-10-12.md C1-C3; owner: "No new
 * rules — check why the existing one was not followed").
 *
 *   C1  the arc critics receive the SAME EVERY_CHILD_ACTS_RULE constant the arc writer
 *       does, so an unanswered want or an adult with no real act can be filed
 *   C2  the plan keeps its own spec: (a) a CAST block that gives a character another
 *       character's deed page as "also on" is asked for again, (b) a cast-out refused
 *       by the page floor tells the next round the character takes a share of the action
 *   C3  an adult's act must change what happens next; a permission, a warning or only
 *       watching does not count by itself
 */
import { describe, it, beforeAll, expect } from 'vitest';
import fs from 'fs';

const PB = require('../../server/lib/promptBuilders');
const CC = require('../../server/lib/castCoverage');
const { loadPromptTemplates } = require('../../server/services/prompts');

const input = (extra: any = {}) => ({
  pages: 18, language: 'en', languageLevel: 'standard', storyCategory: 'adventure', storyTheme: 'dragon',
  storyDetails: 'Four children find an egg.',
  characters: ['Anna', 'Ben', 'Cleo', 'Dan'].map((name, i) => ({ id: String(i), name, age: 7 - (i % 2) })),
  mainCharacters: ['0', '1'],
  ...extra,
});
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('C3: an adult\'s own act changes what happens next', () => {
  it('the constant no longer lets "comfort, permit or watch" count', () => {
    expect(PB.EVERY_CHILD_ACTS_RULE).not.toMatch(/comfort, permit or watch/);
    expect(PB.EVERY_CHILD_ACTS_RULE).toMatch(/changes what happens next/);
    expect(PB.EVERY_CHILD_ACTS_RULE).toMatch(/permission, a warning or only watching does not count by itself/);
  });
  it('the other half of the constant stays', () => {
    expect(PB.EVERY_CHILD_ACTS_RULE).toMatch(/Every child on the character list does at least one thing of their own/);
    expect(PB.EVERY_CHILD_ACTS_RULE).toMatch(/A want or quarrel a figure is given before the middle is answered by the ending/);
  });
});

describe('C1: the critics read the writer\'s constant', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the creator\'s critique spec carries it (so arc-create and arc-retell both check it)', () => {
    expect(PB.arcCritiqueSpec({ inputData: input() })).toContain(PB.EVERY_CHILD_ACTS_RULE);
    expect(PB.arcCritiqueSpec({ retell: true, inputData: input() })).toContain(PB.EVERY_CHILD_ACTS_RULE);
  });

  it('the creator and the re-teller state it twice (principle + critique check), the panel once (CAST lens)', () => {
    const create = PB.buildArcCreatePrompt(input(), 18);
    const retell = PB.buildArcRetellPrompt(input(), 18, 'STORY LOGIC: x', '1. fix');
    const panel = PB.buildArcPanelPrompt(input(), 'ARC: a committed arc');
    expect(count(create, PB.EVERY_CHILD_ACTS_RULE)).toBe(2);
    expect(count(retell, PB.EVERY_CHILD_ACTS_RULE)).toBe(2);
    expect(count(panel, PB.EVERY_CHILD_ACTS_RULE)).toBe(1);
    expect(panel).toMatch(/- CAST — the rule: /);
    expect(panel).not.toMatch(/\{[A-Z][A-Z_]+\}/);
  });

  it('REGRESSION: before 2026-10-12 the panel never saw the rule', () => {
    // the template names the lens; the builder fills it from the one constant
    expect(fs.readFileSync('prompts/arc-panel.txt', 'utf8')).toContain('{ARC_CAST_RULE}');
  });

  it('a figure with no act and a want never answered are MAJOR, so the existing re-tell gate runs on them', () => {
    expect(PB.ARC_SEVERITY_DEF).toMatch(/\[MAJOR\][^;]*a figure on the character list with no act of their own, a want or quarrel given and never answered/);
    const panel = [{ letter: 'A', findings: [{ severity: 'MAJOR', text: '1. [MAJOR] (s2) CAST: Dan only watches — "x"', lens: 'CAST', sentences: [2] }] }];
    const g = PB.arcRepairFindings({ critique: 'Faults: none', reviewedArc: 'ARC: 1. a', panel });
    expect(g.retell).toBe(true);
  });
});

describe('C2a: the CAST block keeps its own spec (refused at the parse)', () => {
  const block = (lines: string[]) => ['---CAST---', ...lines, 'Ending page 10: Anna, Ben, Cleo', '---PAGE PLAN---'].join('\n');
  const listed = ['Anna', 'Ben', 'Cleo'];
  const clean = block([
    'Anna — deed page 2: lifts the egg, alone — also on pages 1, 5',
    'Ben — deed page 3: rings the bell, alone — also on pages 4, 6',
    'Cleo — deed page 7: opens the gate, alone — also on pages 8, 9',
  ]);
  const offending = block([
    'Anna — deed page 2: lifts the egg, alone — also on pages 1, 5',
    'Ben — deed page 3: rings the bell, alone — also on pages 2, 6',
    'Cleo — deed page 7: opens the gate, alone — also on pages 3, 9',
  ]);

  it('a clean table rejects nothing and keeps its text', () => {
    const t = CC.parsePlanCastBlock(clean, { listed, leadEach: true });
    expect(t.rejected).toEqual([]);
    expect(t.raw).toContain('Ben — deed page 3: rings the bell, alone — also on pages 4, 6');
  });

  it('an "also on" page that is another character\'s deed page is refused, named, and leaves the block both later stages read', () => {
    const t = CC.parsePlanCastBlock(offending, { listed, leadEach: true });
    expect(t.rejected).toEqual([{ name: 'Ben', page: 2, lead: 'Anna' }, { name: 'Cleo', page: 3, lead: 'Ben' }]);
    expect(t.characters.find((c: any) => c.name === 'Ben').alsoOn).toEqual([6]);
    expect(t.characters.find((c: any) => c.name === 'Cleo').alsoOn).toEqual([9]);
    expect(t.raw).toContain('Ben — deed page 3: rings the bell, alone — also on pages 6');
    expect(t.raw).toContain('Cleo — deed page 7: opens the gate, alone — also on pages 9');
    expect(t.raw).not.toMatch(/also on pages 2, 6|also on pages 3, 9/);
    expect(CC.castTableBlock(t)).not.toContain('pages 2, 6');
  });

  it('a character whose only also-on pages are refused loses the clause', () => {
    const t = CC.parsePlanCastBlock(block([
      'Anna — deed page 2: x, alone — also on pages 1',
      'Ben — deed page 3: y, alone — also on pages 2',
      'Cleo — deed page 7: z, alone',
    ]), { listed, leadEach: true });
    expect(t.raw).toContain('Ben — deed page 3: y, alone');
    expect(t.raw).not.toMatch(/Ben.*also on/);
  });

  it('where the lead rule does not hold nothing is refused', () => {
    const t = CC.parsePlanCastBlock(offending, { listed });
    expect(t.rejected).toEqual([]);
    expect(t.raw).toContain('also on pages 2, 6');
  });

  it('the production planner step refuses at the parse, logs it, and makes no second planner call (source: beatsPipeline)', () => {
    const src = fs.readFileSync('server/lib/beatsPipeline.js', 'utf8');
    expect(src).toContain('beats_cast_table_also_on_rejected');
    expect(src).toContain('leadEach: !!(castCov && castCov.leadEach)');
    expect(src).not.toContain('castTableConflictNote');
    expect(count(src, "usageLabel: 'beats_plan'")).toBe(1);
  });
});

describe('C2b: a cast-out refused by the page floor tells the next round what to do with the character', () => {
  const PLAN = 'Page 1: wide — Anna, Ben — they look — nothing\nPage 2: wide — Anna, Ben, Cleo — they run — nothing';
  const findings = [{ check: 12, line: 'Page 2 holds three.', pages: [2] }];
  const section = (refused: any[]) => PB.buildReplanSection(PLAN, findings, { pageCount: 2, refused });

  it('a span refusal adds the sentence, from the typed rule id', () => {
    const s = section([{ pageNumber: 2, rule: 'span', detail: 'Cleo 2→1 page(s)', line: 'Page 2: cast out Cleo' }]);
    expect(s).toContain(CC.FLOOR_REFUSED_ONLOOKER_RULE);
    expect(s).toContain('## UNDONE LAST ROUND');
  });

  it('other refusals, and no refusal, do not', () => {
    expect(section([{ pageNumber: 2, rule: 'action', detail: 'stages their action', line: 'Page 2: cast out Cleo' }])).not.toContain(CC.FLOOR_REFUSED_ONLOOKER_RULE);
    expect(section([])).not.toContain(CC.FLOOR_REFUSED_ONLOOKER_RULE);
  });
});
