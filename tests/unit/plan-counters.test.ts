import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
const { runPlanCounters, classifyShot, planSegments, resolveCast } = planCounters as any;

/** A well-formed plan line: shot — who — instant — change. */
const line = (shot: string, who: string, instant = 'something happens', change = 'something is now true') =>
  `${shot} — ${who} — ${instant} — ${change}`;

const page = (n: number, planLine: string, beat = 'a beat') => ({ pageNumber: n, planLine, beat });

const CAST = ['Ana', 'Ben', 'Cara'];

describe('planSegments / classifyShot', () => {
  it('splits on em-dash and reports incompleteness by segment count', () => {
    expect(planSegments(line('wide', 'Ana'))).toHaveLength(4);
    expect(planSegments('wide — Ana')).toHaveLength(2);
  });

  it('prefers ultra-wide over wide and close-up over close', () => {
    expect(classifyShot('ultra-wide')).toBe('ultra-wide');
    expect(classifyShot('wide')).toBe('wide');
    expect(classifyShot('close-up')).toBe('close-up');
    expect(classifyShot('medium')).toBe('medium');
    expect(classifyShot('worm-eye')).toBe('other');
  });
});

describe('resolveCast', () => {
  it('reads names from plan lines only, so a non-English beat cannot invent cast', () => {
    const pages = [
      { pageNumber: 1, planLine: line('wide', 'Ana and Rook'), beat: 'Die Karte liegt auf dem Kartentisch.' },
    ];
    const cast = resolveCast(pages, CAST);
    // German nouns in the beat are capitalised; none may become characters.
    expect(cast.invented).not.toContain('Karte');
    expect(cast.invented).not.toContain('Kartentisch');
  });

  it('treats a titled commissioned name as that character, not a second one', () => {
    const pages = [{ pageNumber: 1, planLine: line('wide', 'Captain Ana stands at the rail'), beat: '' }];
    expect(resolveCast(pages, CAST).invented).toHaveLength(0);
  });
});

describe('runPlanCounters', () => {
  it('flags a plan line missing its instant and change', () => {
    const r = runPlanCounters({ pages: [page(1, 'wide — Ana')], commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('PLAN_LINE_INCOMPLETE');
  });

  it('flags a book using only two shot types', () => {
    const pages = [1, 2, 3, 4].map(n => page(n, line(n % 2 ? 'wide' : 'medium', 'Ana')));
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('SHOT_VARIETY');
  });

  it('flags a page with more than three named characters', () => {
    const pages = [page(1, line('wide', 'Ana, Ben, Cara and Rook arrive'))];
    const r = runPlanCounters({ pages, commissionedNames: [...CAST, 'Rook'] });
    const codes = r.findings.map((f: any) => f.code);
    expect(codes).toContain('CAST_OVER_3');
    expect(codes).toContain('CAST_OVER_CEILING');
  });

  it('flags consecutive pages carried by invented characters, and pages with no commissioned cast', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('medium', 'Rook walks alone')),
      page(3, line('close-up', 'Rook turns away')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const codes = r.findings.map((f: any) => f.code);
    expect(r.cast.invented).toContain('Rook');
    expect(codes).toContain('INVENTED_DOMINANT_CONSECUTIVE');
    expect(codes).toContain('NO_COMMISSIONED_ON_PAGE');
    const consecutive = r.findings.find((f: any) => f.code === 'INVENTED_DOMINANT_CONSECUTIVE');
    expect(consecutive.pages).toEqual([2, 3]);
  });

  it('flags a commissioned character who never gets a focal page', () => {
    // Focal needn't be solo (owner, 2026-09-04): in frame with at most ONE
    // companion satisfies it. Ben only ever appears with two companions.
    const pages = [
      page(1, line('close-up', 'Ana')),
      page(2, line('wide', 'Ana, Ben and Cara walk')),
      page(3, line('medium', 'Ana and Cara talk')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const noFocal = r.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE').map((f: any) => f.detail);
    expect(noFocal.join(' ')).toContain('Ben');
    // Cara's two-person page 3 is focal for BOTH people on it.
    expect(noFocal.join(' ')).not.toContain('Cara');
    expect(noFocal.join(' ')).not.toContain('Ana never');
    expect(r.stats.focalPages['Cara']).toEqual([3]);
    expect(r.stats.focalPages['Ben']).toEqual([]);
  });

  it('flags a commissioned character in frame on fewer than two pages', () => {
    const pages = [
      page(1, line('close-up', 'Ana')),
      page(2, line('wide', 'Ana and Ben walk')),
      page(3, line('medium', 'Ana and Ben talk')),
      page(4, line('ultra-wide', 'Cara stands alone')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const under = r.findings.filter((f: any) => f.code === 'UNDER_COVERED_CHARACTER');
    expect(under.map((f: any) => f.detail).join(' ')).toContain('Cara');
    expect(under.map((f: any) => f.detail).join(' ')).not.toContain('Ben');
    expect(r.stats.coveragePages.Ben).toEqual([2, 3]);
  });

  it('flags consecutive pages sharing shot and cast count, and lets either alone differ', () => {
    const pages = [
      page(1, line('wide', 'Ana and Ben')),
      page(2, line('wide', 'Ana and Cara')),   // same shot, same count -> finding
      page(3, line('wide', 'Ana')),            // same shot, different count -> clean
      page(4, line('close-up', 'Ben')),        // different shot, same count -> clean
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    const same = r.findings.filter((f: any) => f.code === 'CONSECUTIVE_SAME_SHOT_CAST');
    expect(same).toHaveLength(1);
    expect(same[0].pages).toEqual([1, 2]);
  });

  it('never compares a pair whose plan line is incomplete or whose shot did not classify', () => {
    const incomplete = runPlanCounters({
      pages: [page(1, 'wide — Ana'), page(2, 'wide — Ben')],
      commissionedNames: CAST,
    });
    expect(incomplete.findings.map((f: any) => f.code)).not.toContain('CONSECUTIVE_SAME_SHOT_CAST');
    const unclassified = runPlanCounters({
      pages: [page(1, line('worm-eye', 'Ana')), page(2, line('worm-eye', 'Ben'))],
      commissionedNames: CAST,
    });
    expect(unclassified.findings.map((f: any) => f.code)).not.toContain('CONSECUTIVE_SAME_SHOT_CAST');
  });

  it('flags a main character present on under half the pages', () => {
    const pages = [
      page(1, line('wide', 'Ana')),
      page(2, line('wide', 'Ben')),
      page(3, line('wide', 'Ben')),
      page(4, line('wide', 'Cara')),
    ];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.findings.map((f: any) => f.code)).toContain('MAIN_UNDER_HALF');
  });

  it('flags a book with no peopleless page and no solo page', () => {
    const pages = [1, 2].map(n => page(n, line('wide', 'Ana and Ben')));
    const codes = runPlanCounters({ pages, commissionedNames: CAST }).findings.map((f: any) => f.code);
    expect(codes).toContain('NO_SOLO_PAGE');
    expect(codes).toContain('NO_PEOPLELESS_PAGE');
  });

  it('counts a page naming no people as peopleless', () => {
    const pages = [page(1, line('wide', 'the empty harbour at dawn'))];
    const r = runPlanCounters({ pages, commissionedNames: CAST });
    expect(r.stats.peoplelessPages).toEqual([1]);
  });

  it('renders every finding as one PLAN[CODE] line', () => {
    const r = runPlanCounters({ pages: [page(1, 'wide — Ana')], commissionedNames: CAST });
    expect(r.lines.length).toBe(r.findings.length);
    for (const l of r.lines) expect(l).toMatch(/^PLAN\[[A-Z_0-9]+\]/);
  });
});
