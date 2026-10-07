/**
 * Page-plan review defects from staging job_1791315635053_t0t8qpebu (2026-10-07).
 * Behaviour only: which finding code a broken promise files under, which way it
 * moves a page's cast, and which changes the review refuses.
 */
import { describe, it, expect } from 'vitest';

const PB = require('../../server/lib/promptBuilders');
const PC = require('../../server/lib/planCounters');
const { parsePlanChanges } = PB;
const { reviewPlanChanges, replanChangeDirection, castTablePromises } = PC;

const CAST = ['Emma', 'Noah', 'Berta'];
const row = (n: number, present: string[]) => ({ pageNumber: n, present });

describe('a focal-promise break is answered by taking a figure out', () => {
  const table = { characters: [{ name: 'Noah', deedPage: 5, deed: 'swims', alsoOn: [] }], ending: null };
  const actions = [{ key: 'Noah', page: 5, sentence: 5 }];
  const rows = [row(5, ['Noah', 'Emma', 'Berta'])];
  const cast = { all: CAST, aliases: {} };

  it('castTablePromises reports it as the focal variant', () => {
    const r = castTablePromises({ rows, castTable: table, actions, cast, focalEach: true });
    expect(r.broken.map((b: any) => b.promise)).toEqual(['focal']);
  });

  it('REGRESSION: the review accepts `cast out` on a page under the cast ceiling', () => {
    expect(replanChangeDirection({ code: 'CAST_PROMISE_FOCAL_BROKEN' })).toBe('fewer');
    expect(replanChangeDirection({ code: 'CAST_PROMISE_BROKEN' })).toBe('more');
    const standing = [{ pageNumber: 5, planLine: 'wide — Noah, Emma, Berta — Noah swims, Emma follows, Berta arcs — after' }];
    const returned = [{ pageNumber: 5, planLine: 'wide — Noah, Emma — Noah swims, Emma follows — after' }];
    const r = reviewPlanChanges({
      changes: parsePlanChanges('---CHANGES---\nPage 5: cast out Berta — PLAN[CAST_PROMISE_FOCAL_BROKEN] — deed page holds only him and one companion\nChanges: 1').changes,
      standing, returned, castNames: CAST, maxCast: 6,
    });
    expect(r.refusals).toEqual([]);
  });

  it('is must-fix and counts toward convergence', () => {
    const f = { kind: 'counter', code: 'CAST_PROMISE_FOCAL_BROKEN' };
    expect(PB.replanRank(f)).toBe('must');
    expect(PB.countsTowardConvergence(f)).toBe(true);
  });
});

describe('an arc-fact contradiction is not blocked by protection', () => {
  const standing = [{ pageNumber: 5, planLine: 'wide — Noah, Berta — Noah swims while Berta swims her long arc — after' }];
  const returned = [{ pageNumber: 5, planLine: 'wide — Noah, Berta — Noah swims while Berta waits on the sand — after' }];
  const changes = (tag: string) => parsePlanChanges(`---CHANGES---\nPage 5: action out Berta swims her long arc — ${tag} — Berta cannot slide into the sea yet\nChanges: 1`).changes;
  const protectedPages = new Map([[5, "Noah's own action"]]);
  const rankOf = PB.replanRank;

  it('REGRESSION: CHECK[18] changes a protected page', () => {
    const r = reviewPlanChanges({ changes: changes('CHECK[18]'), standing, returned, castNames: CAST, maxCast: 6, protectedPages, rankOf });
    expect(r.refusals).toEqual([]);
  });

  it('another noted finding is still refused on a protected page', () => {
    const r = reviewPlanChanges({ changes: changes('CHECK[9]'), standing, returned, castNames: CAST, maxCast: 6, protectedPages, rankOf });
    expect(r.refusals.map((x: any) => x.rule)).toEqual(['protected']);
  });
});

describe('the lead rule: a page leads with one character', () => {
  const LISTED = ['Emma', 'Noah', 'Daniel', 'Sarah'];
  const pages = [
    { pageNumber: 1, planLine: 'wide — Emma, Noah — Emma and Noah swim — after' },
    { pageNumber: 2, planLine: 'wide — Daniel, Sarah — Daniel and Sarah spread the blanket — after' },
    { pageNumber: 3, planLine: 'wide — Emma, Noah, Daniel, Sarah — all wave — after' },
    { pageNumber: 4, planLine: 'wide — Emma, Daniel, Sarah — they sit — after' },
    ...[5, 6, 7, 8].map(n => ({ pageNumber: n, planLine: 'wide — Emma, Noah, Daniel — they walk — after' })),
  ];
  const roster = new Map(pages.map((p: any) => [p.pageNumber, { people: p.planLine.split(' — ')[1].split(', '), things: [], covers: [] }]));
  const run = (actions: any) => PC.runPlanCounters({ pages, roster, commissionedNames: LISTED, listedNames: LISTED, mainName: 'Emma', actions });
  const noFocal = (r: any) => r.findings.filter((f: any) => f.code === 'NO_FOCAL_PAGE').map((f: any) => f.detail.split(' ')[0]);

  it('a small page that stages another character\'s action is not the companion\'s lead page', () => {
    // p2 is Daniel's action page; Sarah shares it but never leads one.
    const r = run([{ key: 'Emma', page: 1 }, { key: 'Noah', page: 1 }, { key: 'Daniel', page: 2 }, { key: 'Sarah', page: 3 }]);
    expect(noFocal(r)).toEqual(expect.arrayContaining(['Sarah']));
  });

  it('without ACTION lines the old presence reading stands', () => {
    expect(noFocal(run(null))).toEqual([]);
  });

  it('an "also on" page another character leads files no promise', () => {
    const table = { characters: [{ name: 'Daniel', deedPage: 2, deed: '', alsoOn: [] }, { name: 'Emma', deedPage: 1, deed: '', alsoOn: [2] }], ending: null };
    const r = castTablePromises({
      rows: [row(1, ['Emma']), row(2, ['Daniel', 'Sarah'])], castTable: table,
      actions: [{ key: 'Daniel', page: 2 }, { key: 'Emma', page: 1 }], cast: { all: LISTED, aliases: {} }, focalEach: true, leadEach: true,
    });
    expect(r.broken).toEqual([]);
    expect(r.leadWins).toEqual([{ page: 2, name: 'Emma', lead: 'Daniel' }]);
  });
});

describe('an idea card\'s invented figure is new, a customer-written premise figure is commissioned', () => {
  const base = { characters: [{ age: '7' }, { age: '6' }], languageLevel: 'standard' };
  it('the arc is shown the card definition only for a picked idea card', () => {
    const user = PB.arcLogicSpec(base, 18);
    const card = PB.arcLogicSpec({ ...base, ideaPick: { index: 1 } }, 18);
    expect(user).toContain(PB.COMMISSIONED_CAST_DEF);
    expect(card).toContain(PB.COMMISSIONED_CAST_DEF_CARD);
    expect(card).not.toContain(PB.COMMISSIONED_CAST_DEF);
    expect(PB.premiseIsIdeaCard({ ideaGeneration: { selectedIndex: 0 } })).toBe(true);
    expect(PB.premiseIsIdeaCard(base)).toBe(false);
  });
});
