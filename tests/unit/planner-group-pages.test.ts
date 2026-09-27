/**
 * THE PLANNER CARRIES SMALL CASTS (owner, 2026-09-27).
 *
 * The planner was told "Two or three named characters carry a page best" and
 * nothing counted it; over 17 staging books 27 of 241 plan pages held more than
 * three, and those pages score worst. Pins behaviour, offline and free:
 *   - castCoverage.groupPageBudget: one page in six, at least one, raised only
 *     when the coverage floor cannot be met on pages of three;
 *   - the planner (first division AND re-plan) is told that budget and the Art
 *     Director's group-staging rule, from the same constants;
 *   - planCounters GROUP_PAGES_OVER_BUDGET counts against the same budget and
 *     is answered by casting out, as a must-fix finding the round guard counts
 *     (owner, 2026-09-27).
 */
import { describe, it, beforeAll, expect } from 'vitest';

const { castCoverage, groupPageBudget, groupPageRule } = require('../../server/lib/castCoverage');
const { runPlanCounters, replanChangeDirection } = require('../../server/lib/planCounters');
const { GROUP_STAGING_RULE, GROUP_STAGING_MAX } = require('../../server/lib/shotVocabulary');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');

describe('groupPageBudget', () => {
  it('is one page in six, at least one', () => {
    expect(groupPageBudget({ pageCount: 18, castCount: 4, maxCharactersPerScene: 6 }).max).toBe(3);
    expect(groupPageBudget({ pageCount: 16, castCount: 5, maxCharactersPerScene: 6 }).max).toBe(3);
    expect(groupPageBudget({ pageCount: 12, castCount: 4, maxCharactersPerScene: 6 }).max).toBe(2);
    expect(groupPageBudget({ pageCount: 4, castCount: 5, maxCharactersPerScene: 6 }).max).toBe(1);
  });

  it('has no budget when the image model cannot hold a group at all', () => {
    expect(groupPageBudget({ pageCount: 18, castCount: 4, maxCharactersPerScene: 3 })).toBeNull();
    expect(groupPageRule(null)).toBe('');
  });

  it('never fights the coverage floor: pages of three plus the budget always hold it', () => {
    for (let P = 2; P <= 30; P++) {
      for (let C = 1; C <= 14; C++) {
        for (const ceiling of [4, 5, 6]) {
          const b = groupPageBudget({ pageCount: P, castCount: C, maxCharactersPerScene: ceiling });
          const cov = castCoverage({ pageCount: P, castCount: C });
          if (!cov || C === 1) continue;
          const need = Math.ceil(P / 2) + (C - 1) * cov.appearances.min;
          const capacity = GROUP_STAGING_MAX * (P - 1 - Math.min(b.max, P - 1)) + ceiling * Math.min(b.max, P - 1);
          expect(capacity, `P=${P} C=${C} ceiling=${ceiling}`).toBeGreaterThanOrEqual(Math.min(need, ceiling * (P - 1)));
        }
      }
    }
  });

  it('rises only where the floor needs it: a large cast in a short book', () => {
    const b = groupPageBudget({ pageCount: 4, castCount: 12, maxCharactersPerScene: 6 });
    expect(b.forced).toBeGreaterThan(b.base);
    expect(b.max).toBe(b.forced);
  });
});

describe('the planner is told the budget and the group rule, first division and re-plan', () => {
  const inputData: any = {
    title: 'T', characters: ['Ana', 'Ben', 'Cara', 'Dev'].map((name, i) => ({ id: `c${i}`, name, age: 6, gender: 'female' })),
    mainCharacters: ['c0'], language: 'en', languageLevel: 'standard', pages: 18,
    storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
  };
  beforeAll(async () => { await loadPromptTemplates(); });

  it('both built prompts carry the same sentences the counter and the Art Director read', () => {
    const rule = groupPageRule(groupPageBudget({ pageCount: 18, castCount: 4, maxCharactersPerScene: 6 }));
    expect(rule).toContain('At most 3 pages');
    const first = PB.buildBeatsPrompt(inputData, 18, { finalArc: '1. A thing happens.' });
    const replan = PB.buildBeatsPrompt(inputData, 18, {
      finalArc: '1. A thing happens.',
      replan: PB.buildReplanSection('Page 1: wide — Ana — she acts — something changes', [], { pageCount: 18 }),
    });
    for (const [site, p] of [['first', first], ['replan', replan]] as const) {
      expect(p, site).toContain(rule);
      expect(p, site).toContain(GROUP_STAGING_RULE);
      expect(p, site).not.toMatch(/\{GROUP_PAGE_BUDGET\}|\{GROUP_STAGING\}/);
    }
  });
});

describe('GROUP_PAGES_OVER_BUDGET', () => {
  const names = ['Ana', 'Ben', 'Cara', 'Dev'];
  // 18 pages: `groups` of them hold all four, the rest hold two.
  const plan = (groups: number[]) => {
    const pages = Array.from({ length: 18 }, (_, i) => {
      const n = i + 1;
      const who = groups.includes(n) ? names.join(', ') : `Ana, ${names[1 + (n % 3)]}`;
      return { pageNumber: n, planLine: `${n % 2 ? 'medium' : 'wide'} — ${who} — they act — something changes` };
    });
    const roster = new Map(pages.map(p => [p.pageNumber, { people: p.planLine.split(' — ')[1].split(', '), things: [], covers: [] }]));
    return runPlanCounters({ pages, roster, commissionedNames: names, listedNames: names, maxCharactersPerScene: 6 });
  };

  it('stays silent at the budget', () => {
    const r = plan([1, 12, 18]);
    expect(r.findings.some((f: any) => f.code === 'GROUP_PAGES_OVER_BUDGET')).toBe(false);
    expect(r.stats.groupPages).toEqual({ pages: [1, 12, 18], budget: 3 });
  });

  it('names every group page once the book is over it, and is answered by casting out', () => {
    const r = plan([1, 6, 8, 12, 18]);
    const f = r.findings.find((x: any) => x.code === 'GROUP_PAGES_OVER_BUDGET');
    expect(f.pages).toEqual([1, 6, 8, 12, 18]);
    expect(f.detail).toContain('at most 3');
    expect(replanChangeDirection({ code: 'GROUP_PAGES_OVER_BUDGET' })).toBe('fewer');
  });

  it('is must-fix and counts toward convergence (owner, 2026-09-27)', () => {
    const f = { code: 'GROUP_PAGES_OVER_BUDGET', pages: [1, 6, 8, 12, 18], line: 'PLAN[GROUP_PAGES_OVER_BUDGET] ...' };
    expect(PB.replanRank(f)).toBe('must');
    expect(PB.countsTowardConvergence(f)).toBe(true);
    // It reaches the RE-DIVIDE block under MUST FIX.
    const section = PB.buildReplanSection('Page 1: wide — Ana — x — y', [f], { pageCount: 18 });
    expect(section.indexOf(f.line)).toBeGreaterThan(section.indexOf('## MUST FIX'));
  });

  it('the round guard discards a round that leaves more group pages over the budget', () => {
    const over = (pages: number[]) => ({ findings: [{ code: 'GROUP_PAGES_OVER_BUDGET', pages }] });
    // Kept: the recheck is within budget.
    const kept = PB.replanRoundRegressed(over([1, 6, 8, 12, 18]), { findings: [] }, [6, 8]);
    expect(kept).toMatchObject({ before: 1, after: 0, regressed: false, discard: false });
    // Discarded: a round that pushes a book within budget over it.
    const worse = PB.replanRoundRegressed({ findings: [] }, over([1, 6, 8, 12]), [6]);
    expect(worse).toMatchObject({ before: 0, after: 1, regressed: true, discard: true });
  });
});
