/**
 * STAGE 2 — every commissioned character gets their scene, an exciting start,
 * a happy ending (owner, 2026-09-25, on Lab #1494).
 *
 * #1494 (dragon, staging job_1790277448294_5herh01j7, 18 pages, four boys,
 * floor 3 pages each) raised UNDER_COVERED_CHARACTER and NO_FOCAL_PAGE for
 * Kiaan. Both were already must-fix; the re-plan still left Kiaan on 2 pages,
 * took Max 3 -> 2 and poured Levin into every page (8 -> 14). Causes pinned:
 *
 *   1. The review's `span` floor was two pages for every figure, while the
 *      book's floor for the character list is castCoverage appearances.min.
 *   2. The cast finding lines stated a count and no fix.
 *   3. "Kept pages change only for a must-fix finding that names them": a
 *      cast finding names the pages the child is ON, so the ending's page and
 *      every WANTED/ACTION page were shut to the child it asked for.
 *   4. The must-fix list ran in counter order, shot counts first.
 *
 * And the two page-plan rules the stage split owed: EXCITING_START_DEF and
 * HAPPY_ENDING_DEF, one sentence each in the planner and the checker, both
 * must-fix questions.
 *
 * Behaviour, not wording. Offline and free.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');
const CC = require('../../server/lib/castCoverage');
const { loadPromptTemplates } = require('../../server/services/prompts');

const BOYS = ['Levin', 'Julian', 'Max', 'Kiaan'];
const input = () => ({
  pages: 18, language: 'de-CH', languageLevel: 'standard', storyDetails: 'x',
  characters: BOYS.map((name, i) => ({ id: String(i), name, age: 7 })), mainCharacters: ['0', '1'],
});

// #1494's standing pages for the one change that minted UNDER_COVERED Max.
const STANDING = [
  { pageNumber: 1, planLine: 'ultra-wide — Levin, Julian, Max, Kiaan — the four boys kick a ball — the group is established' },
  { pageNumber: 8, planLine: 'medium — Max, Levin — Max kneels at the burrow hole with his arm pushed in — the egg stays beyond reach' },
  { pageNumber: 12, planLine: 'medium — Kiaan, Max, Rubina — Kiaan holds up a round stone; Max reaches out to take it — the stone is in hand' },
];
const RETURNED = [
  STANDING[0], STANDING[1],
  { pageNumber: 12, planLine: 'medium — Kiaan, Levin — Kiaan holds up a round stone toward Levin — the stone is in hand' },
];
const CAST_OUT_MAX = [{ pageNumber: 12, kind: 'cast_out', subject: 'Max', answers: { code: 'NO_FOCAL_PAGE' }, answersText: 'PLAN[NO_FOCAL_PAGE]', line: 'Page 12: cast out Max — PLAN[NO_FOCAL_PAGE]' }];
const review = (castFloor: any, names = [...BOYS, 'Rubina']) => PC.reviewPlanChanges({
  changes: CAST_OUT_MAX, standing: STANDING, returned: RETURNED, castNames: names, maxCast: 6, castFloor, rankOf: PB.replanRank,
});

describe('the review holds the character list to the book\'s floor', () => {
  it('refuses a cast out that takes a commissioned character below the floor (#1494: Max 3 -> 2)', () => {
    const r = review({ names: BOYS, min: 3 });
    expect(r.refusals.map((x: any) => [x.pageNumber, x.rule])).toEqual([[12, 'span']]);
  });

  it('holds an invented figure to two pages, as before', () => {
    // Rubina is not on the character list: 1 -> 0 pages was never a span refusal (she had fewer than two).
    const r = PC.reviewPlanChanges({
      changes: [{ ...CAST_OUT_MAX[0], subject: 'Rubina', line: 'Page 12: cast out Rubina' }],
      standing: STANDING, returned: RETURNED, castNames: [...BOYS, 'Rubina'], maxCast: 6, castFloor: { names: BOYS, min: 3 }, rankOf: PB.replanRank,
    });
    expect(r.refusals.filter((x: any) => x.rule === 'span')).toEqual([]);
  });

  it('without a floor the two-page rule stands (the change passes on 3 -> 2)', () => {
    expect(review(null).refusals.filter((x: any) => x.rule === 'span')).toEqual([]);
  });

  it('never refuses below two for a small floor (a big cast\'s floor of 1)', () => {
    expect(review({ names: BOYS, min: 1 }).refusals.filter((x: any) => x.rule === 'span')).toEqual([]);
  });
});

describe('a cast finding says how it is answered', () => {
  const CAST = ['Ana', 'Ben', 'Cara'];
  const page = (n: number, shot: string, who: string[]) => ({ pageNumber: n, planLine: `${shot} — ${who.join(', ')} — something happens — something is now true` });
  // The roster is declared, not derived (as in plan-counters.test.ts).
  const rosterOf = (pages: any[]) => new Map(pages.map((p: any) => [p.pageNumber, { people: p.planLine.split(' — ')[1].split(', '), things: [] }]));
  const linesOf = (pages: any[]) => {
    const c = PC.runPlanCounters({ roster: rosterOf(pages), pages, commissionedNames: CAST });
    return (code: string) => c.findings.map((f: any, i: number) => (f.code === code ? c.lines[i] : null)).filter(Boolean);
  };

  it('UNDER_COVERED_CHARACTER carries the fix: cast the child in, never below another child\'s floor', () => {
    const pages = [page(1, 'close-up', ['Ana']), page(2, 'wide', ['Ana', 'Ben']), page(3, 'medium', ['Ana', 'Ben']), page(4, 'ultra-wide', ['Cara'])];
    const floor = CC.castCoverage({ pageCount: 4, castCount: 3 }).appearances.min;
    const under = linesOf(pages)('UNDER_COVERED_CHARACTER');
    expect(under).toHaveLength(1);
    expect(under[0]).toContain(CC.underCoveredFix('Cara', floor));
  });

  it('NO_FOCAL_PAGE carries the fix: the child\'s own action on a page of their own', () => {
    const pages = [page(1, 'wide', ['Ana', 'Ben', 'Cara']), page(2, 'wide', ['Ana', 'Ben', 'Cara']), page(3, 'close-up', ['Ana']), page(4, 'medium', ['Ana', 'Ben'])];
    const noFocal = linesOf(pages)('NO_FOCAL_PAGE');
    expect(noFocal).toHaveLength(1);
    expect(noFocal[0]).toContain(CC.noFocalFix('Cara'));
  });

  it('the fix sentences forbid taking from another commissioned character', () => {
    expect(CC.underCoveredFix('Kiaan', 3)).toMatch(/never by casting out another commissioned character who would fall below 3 pages/);
    expect(CC.noFocalFix('Kiaan')).toMatch(/never by taking another character's only focal page/);
  });
});

describe('the re-plan section', () => {
  const findings = [
    { kind: 'counter', code: 'SHOT_MEDIUM_WIDE_EXCESS', line: 'PLAN[SHOT_MEDIUM_WIDE_EXCESS]: 10/18' },
    { kind: 'counter', code: 'UNDER_COVERED_CHARACTER', line: 'PLAN[UNDER_COVERED_CHARACTER] page 1, 12: Kiaan' },
    { kind: 'check', check: 9, line: 'CHECK[9]: page 5' },
  ];
  const plan = Array.from({ length: 18 }, (_, i) => `Page ${i + 1}: medium — Levin — x — y`).join('\n');
  const keep = [{ page: 18, why: "the last page, the ending's event" }];

  it('puts the cast finding before the shot count under MUST FIX', () => {
    const s = PB.buildReplanSection(plan, findings, { pageCount: 18, keep, castFloor: 3 });
    const must = s.split('## MUST FIX')[1].split('## ALSO NOTED')[0];
    expect(must.indexOf('UNDER_COVERED_CHARACTER')).toBeLessThan(must.indexOf('SHOT_MEDIUM_WIDE_EXCESS'));
    expect(s.split('## ALSO NOTED')[1]).toContain('CHECK[9]');
  });

  it('states the commissioned floor the review enforces, and only when it exceeds two', () => {
    expect(PB.buildReplanSection(plan, findings, { pageCount: 18, castFloor: 3 })).toMatch(/fewer than two pages in the book — for a commissioned character, fewer than 3\./);
    expect(PB.buildReplanSection(plan, findings, { pageCount: 18, castFloor: 2 })).toMatch(/fewer than two pages in the book\./);
    expect(PB.buildReplanSection(plan, findings, { pageCount: 18 })).toMatch(/fewer than two pages in the book\./);
  });

  it('lets a kept page take a commissioned character a cast finding asks for, and says who a page gains', () => {
    const s = PB.buildReplanSection(plan, findings, { pageCount: 18, keep, castFloor: 3 });
    expect(s).toMatch(/a commissioned character a cast finding asks for may join one: page 18/);
    expect(s).toMatch(/gains one a cast finding names/);
  });

  it('matches the review: a cast in on a kept page for a cast finding is not refused', () => {
    const standing = [{ pageNumber: 18, planLine: 'wide — Levin, Julian — they walk home — the adventure is over' }];
    const returned = [{ pageNumber: 18, planLine: 'wide — Levin, Julian, Max, Kiaan — they walk home — the adventure is over' }];
    const r = PC.reviewPlanChanges({
      changes: [{ pageNumber: 18, kind: 'cast_in', subject: 'Kiaan', answers: { code: 'UNDER_COVERED_CHARACTER' }, answersText: 'PLAN[UNDER_COVERED_CHARACTER]', line: 'Page 18: cast in Kiaan' }],
      standing, returned, castNames: BOYS, maxCast: 6, protectedPages: new Map([[18, 'the last page']]), rankOf: PB.replanRank,
      castFloor: { names: BOYS, min: 3 },
    });
    expect(r.refusals).toEqual([]);
  });
});

describe('the exciting start and the happy ending: one sentence each, planner and checker, must-fix', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const count = (s: string, sub: string) => s.split(sub).length - 1;

  it('reach the planner (first plan and re-plan) and the checker once each', () => {
    const planner = PB.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.' });
    const replanner = PB.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', replan: '# RE-DIVIDE' });
    const checker = PB.buildPlanCheckPrompt(input(), [{ pageNumber: 1, planLine: 'wide — Levin — x — y' }], '1. A story.', 'Page 1: wide — Levin — x — y');
    for (const def of [PB.EXCITING_START_DEF, PB.HAPPY_ENDING_DEF]) {
      expect(def).toBeTruthy();
      expect(count(planner, def)).toBe(1);
      expect(count(replanner, def)).toBe(1);
      expect(count(checker, def)).toBe(1);
    }
  });

  it('their check findings are must-fix, like the last page (Q8)', () => {
    for (const check of [15, 16]) expect(PB.replanRank({ kind: 'check', check, line: `CHECK[${check}]: x` })).toBe('must');
    expect(PB.replanRank({ kind: 'check', check: 9, line: 'CHECK[9]: x' })).toBe('also');
  });

  it('the checker asks them as questions 15 and 16', () => {
    const checker = PB.buildPlanCheckPrompt(input(), [{ pageNumber: 1, planLine: 'wide — Levin — x — y' }], '1. A story.', 'Page 1: wide — Levin — x — y');
    const task = checker.split('# YOUR TASK')[1].split('# OUTPUT FORMAT')[0];
    expect(task).toMatch(new RegExp(`^15\\. [^\\n]*${PB.EXCITING_START_DEF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
    expect(task).toMatch(new RegExp(`^16\\. [^\\n]*${PB.HAPPY_ENDING_DEF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
  });
});

describe('production and the Lab mirror pass the same re-plan floor', () => {
  const fs = require('fs');
  const path = require('path');
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '../../server/lib', f), 'utf8');
  for (const f of ['beatsPipeline.js', 'testlab.js']) {
    it(`${f} hands castFloor to buildReplanSection and to the review`, () => {
      const s = src(f);
      expect(s).toMatch(/buildReplanSection\([^)]*castFloor: coverageRule \? coverageRule\.appearances\.min : null/);
      expect(s).toMatch(/castFloor(?:: coverageRule \? \{ names: commission\.listed, min: coverageRule\.appearances\.min \} : null|,)/);
    });
  }
});
