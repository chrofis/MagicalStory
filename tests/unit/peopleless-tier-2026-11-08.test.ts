import { describe, it, beforeAll, expect } from 'vitest';

// The people-free page by book size, and a friend's focal page with the main character in frame
// (owner, 2026-11-08; docs/decisions.md "People-free page by book size"; Lab test F,
// evals/runs/2026-11-08_quality-tests-F/).
const CC = require('../../server/lib/castCoverage');
const PC = require('../../server/lib/planCounters');
const PB = require('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require('../../server/services/prompts');
const { runtime } = require('../../server/config/runtime');

const line = (shot: string, who: string, instant = 'something happens', change = 'something is now true') => `${shot} — ${who} — ${instant} — ${change}`;
const page = (n: number, planLine: string) => ({ pageNumber: n, planLine, beat: 'a beat' });
const rosterOf = (pages: any[], things: string[] = []) => new Map(pages.map((p: any) => {
  const who = String(p.planLine).split(' — ')[1];
  const names = /nobody|alone/i.test(who) ? [] : who.split(/, | and /).map((s: string) => s.trim()).filter(Boolean);
  return [p.pageNumber, { people: names.filter((n: string) => !things.includes(n)), things: names.filter((n: string) => things.includes(n)), covers: [] }];
}));
const CAST = ['Ana', 'Ben', 'Cara'];
/** n peopled pages, then optionally one people-free page as the last. */
const book = (n: number, withEmpty: boolean) => {
  const pages = Array.from({ length: n }, (_, i) => page(i + 1, line('medium', i % 3 === 0 ? 'Ana' : i % 3 === 1 ? 'Ana and Ben' : 'Cara and Ana', `they move on, step ${i}`)));
  if (withEmpty) pages[n - 1] = page(n, line('ultra-wide', 'the lantern on the rock', 'the lantern glows above the water', 'the night is clear'));
  return pages;
};
const run = (pages: any[], extra: any = {}) => PC.runPlanCounters({
  pages, roster: rosterOf(pages, ['the lantern on the rock']), commissionedNames: CAST, mainNames: ['Ana'], ...extra,
});
const codes = (r: any) => r.findings.map((f: any) => f.code);

describe('peoplelessTier: the one function', () => {
  it('thresholds live in runtime config', () => {
    expect([runtime('peoplelessRequiredMinPages'), runtime('peoplelessRequiredPagesPerCast'), runtime('peoplelessOptionalMinPages')]).toEqual([18, 4, 14]);
  });
  it('required from 18 pages and 4 pages per listed character', () => {
    expect(CC.peoplelessTier({ pageCount: 18, castCount: 4 })).toBe('required');
    expect(CC.peoplelessTier({ pageCount: 24, castCount: 6 })).toBe('required');
    expect(CC.peoplelessTier({ pageCount: 18, castCount: 5 })).toBe('optional'); // 18 < 4 x 5
    expect(CC.peoplelessTier({ pageCount: 17, castCount: 1 })).toBe('optional'); // below 18
  });
  it('optional from 14 pages, none below', () => {
    expect(CC.peoplelessTier({ pageCount: 14, castCount: 3 })).toBe('optional');
    expect(CC.peoplelessTier({ pageCount: 13, castCount: 1 })).toBe('none');
    expect(CC.peoplelessTier({ pageCount: 10, castCount: 4 })).toBe('none'); // "4 char and 10 pages"
  });
  it('an absent cast counts as one', () => {
    expect(CC.peoplelessTier({ pageCount: 18, castCount: 0 })).toBe('required');
  });
  it('castCoverage carries the tier and assumes a people-free page (P-1) only when it is owed', () => {
    expect(CC.castCoverage({ pageCount: 10, castCount: 4 }).peoplelessTier).toBe('none');
    expect(CC.castCoverage({ pageCount: 20, castCount: 4 }).peoplelessTier).toBe('required');
    // C=2, P=7 gives max 4 either way; find a case where the peopled count decides: C=5, P=10 -> slots 20 vs 18
    const none = CC.castCoverage({ pageCount: 10, castCount: 5 }).appearances;  // peopled 10: floor((20-5)/4)=3
    expect(none.max).toBe(3);
    const req = CC.castCoverage({ pageCount: 20, castCount: 5 }).appearances;   // peopled 19: floor((38-10)/4)=7 -> capped at 4
    expect(req.max).toBe(4);
  });
  it('typed targets owe a scenery page only in a required book', () => {
    expect(CC.typedPlanTargets({ pageCount: 20, listed: CAST, maxCharactersPerScene: 6 }).sceneryMin).toBe(1);
    expect(CC.typedPlanTargets({ pageCount: 16, listed: CAST, maxCharactersPerScene: 6 }).sceneryMin).toBe(0);
    expect(CC.typedTargetsRule(CC.typedPlanTargets({ pageCount: 20, listed: CAST, maxCharactersPerScene: 6 }), ['Ana'])).toContain('landscape or object');
    expect(CC.typedTargetsRule(CC.typedPlanTargets({ pageCount: 10, listed: CAST, maxCharactersPerScene: 6 }), ['Ana'])).not.toContain('landscape or object');
  });
});

describe('NO_PEOPLELESS_PAGE and PEOPLELESS_IN_SHORT_BOOK follow the tier', () => {
  it('required (20 pages, 3 characters): a book with no people-free page is must-fix', () => {
    const r = run(book(20, false));
    expect(codes(r)).toContain('NO_PEOPLELESS_PAGE');
    expect(PB.replanRank({ code: 'NO_PEOPLELESS_PAGE' })).toBe('must');
  });
  it('required: a people-free page satisfies it, nothing is noted', () => {
    const r = run(book(20, true));
    expect(codes(r)).not.toContain('NO_PEOPLELESS_PAGE');
    expect(codes(r)).not.toContain('PEOPLELESS_IN_SHORT_BOOK');
  });
  it('optional (15 pages): neither finding, with or without a people-free page', () => {
    for (const withEmpty of [false, true]) {
      const c = codes(run(book(15, withEmpty)));
      expect(c).not.toContain('NO_PEOPLELESS_PAGE');
      expect(c).not.toContain('PEOPLELESS_IN_SHORT_BOOK');
    }
  });
  it('none (10 pages): no people-free page is not a finding', () => {
    const c = codes(run(book(10, false)));
    expect(c).not.toContain('NO_PEOPLELESS_PAGE');
    expect(c).not.toContain('PEOPLELESS_IN_SHORT_BOOK');
  });
  it('none: a people-free page is noted, never required, and ranks as noted with direction "more"', () => {
    const r = run(book(10, true));
    const f = r.findings.find((x: any) => x.code === 'PEOPLELESS_IN_SHORT_BOOK');
    expect(f).toBeTruthy();
    expect(f.pages).toEqual([10]);
    expect(codes(r)).not.toContain('NO_PEOPLELESS_PAGE');
    expect(PB.replanRank({ code: 'PEOPLELESS_IN_SHORT_BOOK' })).toBe('also');
    expect(PC.replanChangeDirection({ code: 'PEOPLELESS_IN_SHORT_BOOK' })).toBe('more');
  });
});

describe('a friend focal page may hold the main character', () => {
  it('isFocalPage: the main character is not counted against a friend', () => {
    const mains = ['Ana'];
    expect(PC.isFocalPage(['Ana', 'Ben'], 'Ben', mains)).toBe(true);
    expect(PC.isFocalPage(['Ana', 'Ben', 'Cara'], 'Ben', mains)).toBe(true); // Ben + one companion, hero in frame
    expect(PC.isFocalPage(['Ben', 'Cara', 'Dora'], 'Ben', mains)).toBe(false);
    expect(PC.isFocalPage(['Ana', 'Ben', 'Cara', 'Dora'], 'Ben', mains)).toBe(false); // two companions besides the hero
    expect(PC.isFocalPage(['Ana', 'Ben', 'Cara'], 'Ana', mains)).toBe(false); // the main character's own page stays at two
    expect(PC.isFocalPage(['Ben'], 'Ana', mains)).toBe(false); // not in frame
  });
  it('runPlanCounters: Ben has a focal page with the hero in frame, and not without the exception', () => {
    const pages = [
      page(1, line('medium', 'Ana')), page(2, line('medium', 'Ana, Ben, Cara')), page(3, line('medium', 'Ana, Ben, Cara')),
      page(4, line('medium', 'Ana and Cara')), page(5, line('medium', 'Ana and Ben')), page(6, line('medium', 'Cara')),
    ];
    // Ben is on p2, p3 (with Ana and Cara) and p5: with Ana excluded, p2 and p3 are Ben + one companion.
    const withMain = run(pages);
    expect(withMain.stats.focalPages.Ben).toEqual(expect.arrayContaining([2, 3]));
    // Without naming a main character the old reading (at most two in frame) applies.
    const noMain = run(pages, { mainNames: [] });
    expect(noMain.stats.focalPages.Ben).not.toContain(2);
  });
  it('typed counters count the same focal page', () => {
    const pages = [
      { pageNumber: 1, planLine: line('face', 'Ana') }, { pageNumber: 2, planLine: line('medium', 'Ana, Ben, Cara') },
      { pageNumber: 3, planLine: line('medium', 'Ben, Cara') }, { pageNumber: 4, planLine: line('medium', 'Ana, Cara') },
    ];
    const r = PC.typedPlanCounters({ pages, listedNames: CAST, commissionedNames: CAST, mainNames: ['Ana'], maxCharactersPerScene: 6 });
    expect(r.stats.focalPages.Ben).toContain(2);
  });
  it('the CAST block promise "alone or with one companion" holds with the hero in frame', () => {
    // a page after it: the last page is the exception (test J), so the deed page is not the last
    const rows = [{ pageNumber: 2, present: ['Ana', 'Ben', 'Cara'] }, { pageNumber: 3, present: ['Ana'] }];
    const table = { characters: [{ name: 'Ben', deedPage: 2, deed: '', alsoOn: [] }], ending: null };
    const args = { rows, castTable: table, actions: [{ key: 'Ben', page: 2 }], cast: { all: CAST, aliases: {} }, focalEach: true, leadEach: false };
    expect(PC.castTablePromises({ ...args, mains: ['Ana'] }).broken).toEqual([]);
    expect(PC.castTablePromises({ ...args, mains: [] }).broken.map((b: any) => b.promise)).toEqual(['focal']);
  });
  it('reviewPlanChanges reads a friend focal page the same way', () => {
    // Removing Cara from p2 would leave Ben without a focal page only if the hero counted: with mainNames it does not.
    const standing = [{ pageNumber: 2, planLine: line('medium', 'Ana, Ben, Cara') }];
    const returned = [{ pageNumber: 2, planLine: line('medium', 'Ana, Ben') }];
    const r = PC.reviewPlanChanges({ changes: [], standing, returned, castNames: CAST, mainNames: ['Ana'], focalNames: CAST });
    expect(r.refusals).toEqual([]);
  });
});

describe('prompt placeholders per tier', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input = (pages: number, n: number) => ({
    pages, language: 'en', languageLevel: 'standard', storyDetails: 'x',
    characters: CAST.slice(0, n).map((name, i) => ({ id: `c${i}`, name, age: 6 })), mainCharacters: ['c0'],
  });
  const planner = (pages: number, n = 3) => PB.buildBeatsPrompt(input(pages, n), pages, { finalArc: '1. A story.' });
  const checker = (pages: number, n = 3) => PB.buildPlanCheckPrompt(
    input(pages, n), Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, planLine: 'medium — Ana — she waits — nothing' })), '1. A story.', 'Page 1: medium — Ana — she waits — nothing');

  it('required keeps today\'s question and adds the main-character sentence', () => {
    const p = planner(20);
    expect(p).toContain('At least one page in the book earns this.');
    expect(p).toContain('The people-free page is never a page where the main character acts, decides or feels.');
    expect(p).toContain('<names, or the word nobody>');
    expect(p).not.toMatch(/\{[A-Z_]+\}/);
  });
  it('optional allows one page on a moment no commissioned character owns', () => {
    const p = planner(15);
    expect(p).toContain('This book need not have such a page.');
    expect(p).not.toContain('At least one page in the book earns this.');
    expect(p).toContain('<names, or the word nobody>');
  });
  it('none asks for no people-free page and drops "nobody" from the who column', () => {
    const p = planner(10);
    expect(p).toContain('too short to spare a page with no people in frame');
    expect(p).not.toContain('At least one page in the book earns this.');
    expect(p).not.toContain('or the word nobody');
    expect(p).toContain('— <names> —');
  });
  it('a long book with a large cast is optional, not required (18 pages, 5 characters)', () => {
    const p = PB.buildBeatsPrompt({ ...input(18, 3), characters: ['A', 'B', 'C', 'D', 'E'].map((name, i) => ({ id: `c${i}`, name, age: 6 })) }, 18, { finalArc: '1. A story.' });
    expect(p).toContain('This book need not have such a page.');
  });
  it('the focal sentence lets the main character stand in a friend\'s page, in the planner and the cast rule', () => {
    expect(planner(20)).toContain(CC.MAIN_IN_FRAME_CLAUSE);
    expect(CC.castActionRule(CC.castCoverage({ pageCount: 20, castCount: 3 }))).toContain(CC.MAIN_IN_FRAME_CLAUSE);
    expect(CC.castTableSpec(CC.castCoverage({ pageCount: 20, castCount: 3 }), 20)).toContain(CC.MAIN_IN_FRAME_CLAUSE);
  });
  it('plan-check Q6 asks for the PEOPLELESS nomination only in a required book', () => {
    const req = checker(20);
    expect(req).toContain('When no page is people-free, nominate the one page best suited to give up its cast');
    expect(req).toContain('PEOPLELESS <page>: ');
    for (const pages of [15, 10]) {
      const c = checker(pages);
      expect(c).not.toContain('nominate the one page best suited');
      expect(c).not.toContain('PEOPLELESS <page>');
      expect(c).toContain('Then one line per act, in story order:');
      expect(c).not.toMatch(/\{[A-Z_]+\}/);
    }
  });
});
