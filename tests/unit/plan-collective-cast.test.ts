import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
import planCounters from '../../server/lib/planCounters.js';
const { runPlanCounters, coveredNames, resolveCast } = planCounters as any;
const { parsePlanCheckRoster } = require('../../server/lib/promptBuilders');

const ROOT = path.resolve(__dirname, '../..');
const PLAN_CHECK = fs.readFileSync(path.join(ROOT, 'prompts/plan-check.txt'), 'utf8');

/**
 * A PLAN LINE MAY CARRY THE CAST WITHOUT NAMING IT.
 *
 * Fixtures are the plan lines of staging job_1789681157795_wkt20ckod ("Das Ei
 * im Lindenhof", 2026-09-17), verbatim from `beatsReviewReport.briefsIn`. The
 * counters matched literal names only, so `NO_COMMISSIONED_ON_PAGE` — a
 * must-fix code — named pages 8, 12, 16 and 18, and two of those four were
 * false: page 12 ("all four boys braced shoulder to shoulder") and page 18
 * ("the four boys sitting together") hold the whole commissioned cast, referred
 * to as a group. The re-plan answered 16 and 18 by deleting the story's
 * antagonist, which cost three CRITICAL image faults.
 *
 * The plan check's model now answers the language question on the ROSTER line
 * (`covers`), and the counters do arithmetic on the answer.
 */
const COMMISSIONED = ['Levin', 'Julian', 'Max', 'Kiaan'];
const MAX_CAST = 6; // IMAGE_MODELS[...].maxCharactersPerScene in production

const PAGES = [
  { pageNumber: 8, planLine: "medium — Tobias striding up, hands red from cold, reaching for the egg on the rim — Tobias's hands close around the egg — Tobias has taken the egg and Kiaan stands opposite him" },
  { pageNumber: 12, planLine: 'ultra-wide — all four boys braced shoulder to shoulder against the big wedged stone in the gap, feet dug into the earth — the stone does not move — the stone is stuck fast and Julian stands frozen at the end of the line, not pushing' },
  { pageNumber: 16, planLine: "medium — Tobias sitting on the wedged stone in the dark, tin box under his arm, shouting — the Lindenhof is dark behind him — Tobias blocks the stone and the others cannot reach the gap; Zünsli lies still in Julian's hands" },
  { pageNumber: 17, planLine: 'close-up — Levin gripping a fallen branch, eyes on the earth below the stone, Max and Kiaan already digging beside him with bare hands — the branch biting into the soil — Levin has chosen and the digging has begun' },
  { pageNumber: 18, planLine: "wide — Tobias stumbling back into the leaves, the stone tipped sideways, a large eye blinking in the open gap, the four boys sitting together in the leaf-scattered dark — Zünsli's tail disappearing into the warm dark of the hill — the gap is open, Zünsli is home, and the four boys sit together on the Lindenhof" },
];

/**
 * The roster the check's model returns for those pages: `people` is what each
 * who column NAMES, `covers` what it reaches without naming. Declared here, the
 * way a test states its own intent — in production the model answers it.
 */
const ROSTER_NAMES_ONLY = new Map<number, any>([
  [8, { people: ['Tobias'], things: [], covers: [] }],
  [12, { people: [], things: [], covers: [] }],
  [16, { people: ['Tobias'], things: [], covers: [] }],
  [17, { people: ['Levin', 'Max', 'Kiaan'], things: [], covers: [] }],
  [18, { people: ['Tobias'], things: [], covers: [] }],
]);

const withCovers = (covers: Record<number, string[]>) => {
  const out = new Map<number, any>();
  for (const [page, row] of ROSTER_NAMES_ONLY) out.set(page, { ...row, covers: covers[page] || [] });
  return out;
};

/** The roster the new spec asks for on this story. */
const ROSTER_WITH_COVERS = withCovers({ 12: COMMISSIONED, 18: COMMISSIONED });

const run = (roster: Map<number, any>) => runPlanCounters({
  pages: PAGES, commissionedNames: COMMISSIONED, maxCharactersPerScene: MAX_CAST, roster,
});

const pagesOf = (res: any, code: string) =>
  (res.findings.filter((f: any) => f.code === code)[0] || { pages: [] }).pages;

const castOn = (res: any, page: number) =>
  (res.stats.castPerPage.find((r: any) => r.pageNumber === page) || {}).names;

describe('the ROSTER contract', () => {
  it('declares the three fields the parser reads', () => {
    const line = PLAN_CHECK.split('\n').find(l => l.startsWith('ROSTER <page>:')) || '';
    expect(line).toContain('people = ');
    expect(line).toContain('things = ');
    expect(line).toContain('covers = ');
  });

  it('parses covers as a third field', () => {
    const r = parsePlanCheckRoster('ROSTER 4: people = A, B; things = the lamp; covers = C, D');
    expect(r.get(4)).toEqual({ people: ['A', 'B'], things: ['lamp'], covers: ['C', 'D'] });
  });

  it('reads a line without covers exactly as before', () => {
    const r = parsePlanCheckRoster('ROSTER 4: people = A, B; things = the lamp');
    expect(r.get(4)).toEqual({ people: ['A', 'B'], things: ['lamp'], covers: [] });
  });

  it('reads "none" in any field as nobody', () => {
    const r = parsePlanCheckRoster('ROSTER 7: people = none; things = none; covers = none');
    expect(r.get(7)).toEqual({ people: [], things: [], covers: [] });
  });

  it('leaves a things value carrying its own semicolon whole, with and without covers', () => {
    const bare = parsePlanCheckRoster('ROSTER 2: people = A; things = the lamp; the railing');
    expect(bare.get(2).things).toEqual(['lamp; the railing']);
    const both = parsePlanCheckRoster('ROSTER 2: people = A; things = the lamp; the railing; covers = B');
    expect(both.get(2).things).toEqual(['lamp; the railing']);
    expect(both.get(2).covers).toEqual(['B']);
  });

  it('keeps a page whose line it cannot read out of the map, so the caller still sees it as missing', () => {
    expect(parsePlanCheckRoster('ROSTER 3: nobody at all').size).toBe(0);
  });
});

describe('NO_COMMISSIONED_ON_PAGE on the motivating story', () => {
  it('names all four pages while the roster answers names only — the measured behaviour', () => {
    expect(pagesOf(run(ROSTER_NAMES_ONLY), 'NO_COMMISSIONED_ON_PAGE')).toEqual([8, 12, 16, 18]);
  });

  it('drops the two collective pages once the roster says who they cover', () => {
    expect(pagesOf(run(ROSTER_WITH_COVERS), 'NO_COMMISSIONED_ON_PAGE')).toEqual([8, 16]);
  });

  it('still flags the two pages that genuinely hold no commissioned character', () => {
    const res = run(ROSTER_WITH_COVERS);
    expect(castOn(res, 8)).toEqual(['Tobias']);
    expect(castOn(res, 16)).toEqual(['Tobias']);
  });

  it('puts the covered cast in frame beside the figure the page does name', () => {
    const res = run(ROSTER_WITH_COVERS);
    expect(castOn(res, 12)).toEqual(['Levin', 'Julian', 'Max', 'Kiaan']);
    expect(castOn(res, 18)).toEqual(['Tobias', 'Levin', 'Julian', 'Max', 'Kiaan']);
  });

  it('does not push a whole-cast page past the image model ceiling', () => {
    expect(pagesOf(run(ROSTER_WITH_COVERS), 'CAST_OVER_CEILING')).toEqual([]);
  });
});

describe('a covers list is re-counted, never trusted', () => {
  const cast = resolveCast(PAGES, COMMISSIONED, [], ROSTER_NAMES_ONLY);

  it('credits nobody for a claim that enumerates nobody', () => {
    expect(coveredNames({ covers: ['the whole cast'] }, cast)).toEqual([]);
    expect(coveredNames({ covers: ['all four of them', 'the group'] }, cast)).toEqual([]);
  });

  it('drops a covered name this book does not have', () => {
    expect(coveredNames({ covers: ['Levin', 'Someone Else'] }, cast)).toEqual(['Levin']);
  });

  it('reads a roster row with no covers field at all as covering nobody', () => {
    expect(coveredNames({ people: ['Levin'], things: [] }, cast)).toEqual([]);
    expect(coveredNames(undefined, cast)).toEqual([]);
  });

  it('never counts the same character twice', () => {
    const res = run(withCovers({ 17: ['Levin', 'Max'], 12: COMMISSIONED, 18: COMMISSIONED }));
    expect(castOn(res, 17)).toEqual(['Levin', 'Max', 'Kiaan']);
  });

  it('a claim that enumerates nobody leaves the finding standing', () => {
    expect(pagesOf(run(withCovers({ 12: ['the four of them'] })), 'NO_COMMISSIONED_ON_PAGE'))
      .toEqual([8, 12, 16, 18]);
  });
});

describe('covers is presence, and nothing else', () => {
  it('never puts a name into the cast: the invented list is the same either way', () => {
    const named = run(ROSTER_NAMES_ONLY);
    const covered = run(withCovers({ 12: [...COMMISSIONED, 'Tobias'], 18: COMMISSIONED }));
    expect(named.cast).toEqual(covered.cast);
    expect(covered.cast.invented).toEqual(['Tobias']);
  });

  it('reaches every counter that asks who is on a page, not only this one', () => {
    // Levin is NAMED on one page of five; the two collective pages hold him too.
    expect(run(ROSTER_NAMES_ONLY).findings.map((f: any) => f.code)).toContain('MAIN_UNDER_HALF');
    expect(run(ROSTER_WITH_COVERS).findings.map((f: any) => f.code)).not.toContain('MAIN_UNDER_HALF');
  });

  it('records the covered names on the page, so a stored report says the field was used', () => {
    const rows = run(ROSTER_WITH_COVERS).stats.castPerPage;
    expect(rows.find((r: any) => r.pageNumber === 12).covered).toEqual(COMMISSIONED);
    expect(rows.find((r: any) => r.pageNumber === 8)).not.toHaveProperty('covered');
    const before = run(ROSTER_NAMES_ONLY).stats.castPerPage;
    expect(before.every((r: any) => !('covered' in r))).toBe(true);
  });
});
