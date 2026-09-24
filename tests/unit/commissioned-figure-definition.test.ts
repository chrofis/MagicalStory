/**
 * The arc and the plan counters count ONE set of invented figures (2026-09-23).
 *
 * Staging job_1790100385959_1nitlympp: the arc applied its own budget rule —
 * "Not counted: anyone the commission named … a figure given no name" — to a dog
 * named in a character's saved details and to an unnamed mother, and the
 * counters charged both anyway (ARC_INVENTED_UNDECLARED, OVER_ALLOWANCE 4 vs 2).
 * The arc side (COMMISSIONED_CAST_DEF on the "Premise figures:" list) puts the
 * dog on the list the counters read; this pins the counter side: the list is
 * read through castCoverage.commissionedCast, and the unnamed-figure exemption
 * is one string (UNNAMED_FIGURE_EXEMPT) the arc budget states and the counter
 * applies. Offline and free.
 */
import { describe, it, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const { runPlanCounters, isNamedFigure } = require('../../server/lib/planCounters');
const { commissionedCast } = require('../../server/lib/castCoverage');

const input = () => ({
  title: 'T', characters: [{ id: 'c1', name: 'Ana', age: 5, gender: 'female' }, { id: 'c2', name: 'Ben', age: 6, gender: 'male' }],
  mainCharacters: ['c1'], language: 'en', languageLevel: '1st-grade', pages: 18,
  storyCategory: 'adventure', storyType: 'adventure', artStyle: 'watercolor',
});

describe('the arc states the exemption the counter applies', () => {
  // Since 2026-09-24 the counting rule is the FACTS spec of the STORY LOGIC.
  it('UNNAMED_FIGURE_EXEMPT reaches the FACTS spec of both arc prompts', () => {
    expect(PB.arcLogicSpec(input(), 18)).toContain(PB.UNNAMED_FIGURE_EXEMPT);
  });
});

describe('the counters follow the arc counting rule', () => {
  it('an unnamed figure is never a named invented figure', () => {
    expect(isNamedFigure('their mother')).toBe(false);
    expect(isNamedFigure('a guard')).toBe(false);
    expect(isNamedFigure('Mama')).toBe(true);
  });

  it('neither a supplied pet nor an unnamed one-page parent is charged against the allowance', () => {
    const pages = [
      { pageNumber: 1, planLine: 'medium — Ana, Ben, their mother — she hands over the bag — they may go' },
      { pageNumber: 2, planLine: 'wide — Ana, Rex — the dog digs — the box is found' },
      { pageNumber: 3, planLine: 'medium — Ana, Pip — the dragon lands — Pip has arrived' },
    ];
    const roster = new Map([
      [1, { people: ['Ana', 'Ben', 'their mother'], things: [], covers: [] }],
      [2, { people: ['Ana', 'Rex'], things: [], covers: [] }],
      [3, { people: ['Ana', 'Pip'], things: [], covers: [] }],
    ]);
    const commission = commissionedCast(input(), ['Rex']);
    const r = runPlanCounters({ pages, roster, commissionedNames: commission.all, listedNames: commission.listed, declaredInvented: ['Pip'], inventedAllowance: 1 });
    const codes = r.findings.map((f: any) => f.code);
    expect(codes).not.toContain('ARC_INVENTED_UNDECLARED');
    expect(codes).not.toContain('ARC_INVENTED_OVER_ALLOWANCE');
  });
});
