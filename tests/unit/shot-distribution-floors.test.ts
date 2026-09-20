/**
 * THE SHOT SPREAD IS ONE TABLE: THE PLANNER IS ASKED FOR IT, THE COUNTERS
 * ENFORCE IT, AND A RE-PLAN IS OBLIGED TO ANSWER.
 *
 * MEASURED, 11 staging books / 180 pages over the 14 days to 2026-09-20:
 * medium 76 (42%), wide 54 (30%), close-up 37 (21%), ultra-wide 10 (5.6%),
 * high-angle 2, over-the-shoulder 1, aerial 0. Medium plus wide was 72% of
 * every page shipped and a camera position appeared on 3 pages in 180.
 *
 * The planner was COMPLYING: prompts/story-beats.txt asked for "about two
 * close-ups and two ultra-wides, the rest medium or wide", which on an 18-page
 * book is an explicit request for ~78% medium-or-wide. So the fix is the prompt
 * first (it now states the table) and the counters second (they measure the same
 * table), and on job_1789853503332_riqncqg1i the two shot findings were raised
 * in BOTH plan-check rounds and shipped unfixed because nothing was obliged to
 * answer them.
 *
 * Behaviour is pinned here, never the wording of any prompt.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { shotFloors, shotDistributionPhrase, POSITION_SHOTS, MAX_MEDIUM_WIDE_SHARE, PEOPLELESS_SHARED_SHOT } =
  require_('../../server/lib/shotVocabulary');
const { runPlanCounters } = require_('../../server/lib/planCounters');
const { replanRank } = require_('../../server/lib/promptBuilders');

const CAST = ['Ana'];
const pagesFrom = (shots: string[]) => shots.map((shot, i) => ({
  pageNumber: i + 1,
  planLine: `${shot} — Ana — something happens — something is now true`,
  beat: 'a beat',
}));
const rosterFor = (pages: any[]) =>
  new Map(pages.map(p => [Number(p.pageNumber), { people: ['Ana'], things: [] as string[] }]));
const codesFor = (shots: string[]) => {
  const pages = pagesFrom(shots);
  return runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: CAST })
    .findings.map((f: any) => f.code);
};
const fill = (n: number, shot: string) => Array(n).fill(shot);

describe('the medium/wide cap is a ratio, so it scales to any book length', () => {
  it.each([8, 12, 18, 24])('fires above half the book at %i pages', (n) => {
    const over = Math.floor(n / 2) + 1;
    expect(codesFor([...fill(over, 'medium'), ...fill(n - over, 'close-up')]))
      .toContain('SHOT_MEDIUM_WIDE_EXCESS');
  });

  it.each([8, 12, 18, 24])('is silent at exactly half the book at %i pages', (n) => {
    const half = Math.floor(n / 2);
    expect(codesFor([...fill(half, 'medium'), ...fill(n - half, 'close-up')]))
      .not.toContain('SHOT_MEDIUM_WIDE_EXCESS');
  });

  it('counts medium and wide together, not each on its own', () => {
    // 5 medium + 5 wide over 18 pages: neither word is half the book, the two
    // together are past it.
    const shots = [...fill(5, 'medium'), ...fill(5, 'wide'), ...fill(8, 'close-up')];
    expect(codesFor(shots)).toContain('SHOT_MEDIUM_WIDE_EXCESS');
  });

  it('reports the count and the ceiling, so a re-plan knows how far it is out', () => {
    const pages = pagesFrom([...fill(10, 'medium'), ...fill(8, 'close-up')]);
    const f = runPlanCounters({ roster: rosterFor(pages), pages, commissionedNames: CAST })
      .findings.find((x: any) => x.code === 'SHOT_MEDIUM_WIDE_EXCESS');
    expect(f.detail).toContain('10/18');
    expect(f.detail).toContain('9');
    expect(f.pages).toEqual([]);
  });

  it('the share itself is the declared one', () => {
    expect(MAX_MEDIUM_WIDE_SHARE).toBe(0.5);
    expect(shotFloors(18).maxMediumWide).toBe(9);
    expect(shotFloors(9).maxMediumWide).toBe(4);
  });
});

describe('the floors are tiered, so a short book is not asked for a long book spread', () => {
  it('a trial-length book owes one close-up and no angle at all', () => {
    const f = shotFloors(8);
    expect(f.floors).toEqual({ 'close-up': 1 });
    expect(f.requiredPositions).toBe(0);
  });

  it.each([
    [8, { 'close-up': 1 }, 0],
    [9, { 'close-up': 2, 'ultra-wide': 1, aerial: 1, 'over-the-shoulder': 1 }, 2],
    [13, { 'close-up': 2, 'ultra-wide': 1, aerial: 1, 'over-the-shoulder': 1 }, 2],
    [14, { 'close-up': 2, 'ultra-wide': 1, aerial: 1, 'over-the-shoulder': 2 }, 3],
    [18, { 'close-up': 2, 'ultra-wide': 1, aerial: 1, 'over-the-shoulder': 2 }, 3],
    [24, { 'close-up': 2, 'ultra-wide': 1, aerial: 1, 'over-the-shoulder': 2 }, 4],
  ])('%i pages: the tier boundary holds', (n, floors, positions) => {
    const f = shotFloors(n as number);
    expect(f.floors).toEqual(floors);
    expect(f.requiredPositions).toBe(positions);
  });

  it('the positions total scales at one in six pages', () => {
    expect(shotFloors(18).positionsTotal).toBe(3);
    expect(shotFloors(19).positionsTotal).toBe(4);
    expect(shotFloors(30).positionsTotal).toBe(5);
  });

  it('no length asks for more than the book holds, nor contradicts the cap', () => {
    for (let n = 4; n <= 40; n++) {
      const p = shotFloors(n);
      const positionFloorSum = POSITION_SHOTS.reduce((a: number, id: string) => a + (p.floors[id] || 0), 0);
      const mandated = Object.values(p.floors).reduce((a: number, b: any) => a + Number(b), 0)
        + Math.max(0, p.positionsTotal - positionFloorSum);
      // One arithmetic, not two: shotFloors reports it so no caller re-derives.
      expect(p.mandatedPages, `${n} pages: mandatedPages disagrees with the floors`).toBe(mandated);
      expect(mandated, `${n} pages: floors exceed the book`).toBeLessThanOrEqual(n);
      expect(mandated + p.maxMediumWide, `${n} pages: floors and the medium/wide cap contradict`)
        .toBeLessThanOrEqual(n);
      expect(p.slack, `${n} pages: slack disagrees`).toBe(n - mandated - p.maxMediumWide);
      expect(p.slack, `${n} pages: UNSATISFIABLE`).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * THE PEOPLELESS PAGE MAY BE THE ULTRA-WIDE PAGE (owner, 2026-09-20: "books of
 * 10 page allow a bit of freedom, for example put ultra-wide and no person
 * together as 1, so only 5 or so are spoken for").
 *
 * The arithmetic that forced it. `NO_PEOPLELESS_PAGE` is must-fix and demands a
 * page with no cast on it, on top of the shot floors. Counted as a SEPARATE
 * page it made two lengths impossible:
 *
 *   pages | mandated shots | +peopleless | medium/wide ceiling | total vs pages
 *       9 |              5 |           6 |                   4 | 10 > 9   IMPOSSIBLE
 *      10 |              5 |           6 |                   5 | 11 > 10  IMPOSSIBLE
 *      11 |              5 |           6 |                   5 | 11 = 11  zero slack
 *      18 |              6 |           7 |                   9 | 16 < 18
 *
 * Riding it on the ultra-wide page takes 9 and 10 back to exactly satisfiable
 * and gives every longer length a page back.
 */
describe('the people-free page rides the ultra-wide page', () => {
  it('is the ultra-wide page — a distance, so it is on the axis a landscape wants', () => {
    expect(PEOPLELESS_SHARED_SHOT).toBe('ultra-wide');
  });

  it('every length 4-40 is satisfiable WITH the people-free page counted in', () => {
    for (let n = 4; n <= 40; n++) {
      const p = shotFloors(n);
      // It costs nothing wherever ultra-wide is floored; where it is not
      // floored (the trial tier) it is one page out of ample slack.
      const extra = p.floors[PEOPLELESS_SHARED_SHOT] ? 0 : 1;
      expect(p.slack - extra, `${n} pages: unsatisfiable once the people-free page is counted`)
        .toBeGreaterThanOrEqual(0);
    }
  });

  it('the two lengths that were impossible are now exactly satisfiable', () => {
    for (const n of [9, 10]) {
      expect(shotFloors(n).slack, `${n} pages`).toBe(0);
      expect(shotFloors(n).floors[PEOPLELESS_SHARED_SHOT]).toBe(1);
    }
  });

  it('APPLIES AT EVERY LENGTH, not below a threshold — it is a permission, not a quota', () => {
    // Only 9-10 NEED it. A permission legal at ten pages and illegal at
    // eighteen would be an arbitrary number with nothing behind it, so the
    // planner is told it wherever the shot it rides is floored at all.
    for (const n of [9, 10, 13, 18, 24, 40]) {
      expect(shotDistributionPhrase(n), `${n} pages`).toContain(`may BE the ${PEOPLELESS_SHARED_SHOT} page`);
    }
  });

  it('a short book that owes no ultra-wide is not told to put its cast-free page on one', () => {
    expect(shotFloors(6).floors['ultra-wide']).toBeUndefined();
    expect(shotDistributionPhrase(6)).not.toContain('may BE the');
  });

  it('only the CAST property combines — two shot words never share a page', () => {
    // `shot` is one-of. Nothing added here may let aerial/OTS/close-up/
    // ultra-wide satisfy each other, and the phrase says so out loud.
    expect(shotDistributionPhrase(18)).toContain('No two shot words ever share a page');
    const f18 = shotFloors(18);
    expect(f18.mandatedPages).toBe(
      Object.values(f18.floors).reduce((a: number, b: any) => a + Number(b), 0));
  });
});

describe('each floored shot has its own code, so a re-plan is told which one is missing', () => {
  const eighteen = (extra: string[] = []) =>
    codesFor([...extra, ...fill(18 - extra.length, 'close-up')]);

  it('an 18-page book of close-ups is short of ultra-wide, aerial and over-the-shoulder', () => {
    const codes = eighteen();
    expect(codes).toContain('SHOT_ULTRAWIDE_COUNT');
    expect(codes).toContain('SHOT_AERIAL_COUNT');
    expect(codes).toContain('SHOT_OTS_COUNT');
    expect(codes).toContain('SHOT_NO_CAMERA_POSITION');
    expect(codes).not.toContain('SHOT_CLOSEUP_COUNT');
  });

  it('ultra-wide is a DISTANCE and aerial a POSITION — one never satisfies the other', () => {
    const withAerials = eighteen(['aerial', 'aerial', 'aerial']);
    expect(withAerials).not.toContain('SHOT_AERIAL_COUNT');
    expect(withAerials).toContain('SHOT_ULTRAWIDE_COUNT');

    const withUltraWides = eighteen(['ultra-wide', 'ultra-wide']);
    expect(withUltraWides).not.toContain('SHOT_ULTRAWIDE_COUNT');
    expect(withUltraWides).toContain('SHOT_AERIAL_COUNT');
  });

  it('the ultra-wide floor is one, not two — a floor enforced beats a floor ignored', () => {
    expect(shotFloors(18).floors['ultra-wide']).toBe(1);
    expect(eighteen(['ultra-wide'])).not.toContain('SHOT_ULTRAWIDE_COUNT');
  });

  it('a book meeting every floor raises no shot finding', () => {
    const shots = [
      ...fill(3, 'close-up'), 'ultra-wide', 'aerial', 'over-the-shoulder', 'over-the-shoulder',
      'high-angle', ...fill(5, 'medium'), ...fill(4, 'wide'), 'low-angle',
    ];
    expect(shots).toHaveLength(18);
    const codes = codesFor(shots);
    for (const c of ['SHOT_MEDIUM_WIDE_EXCESS', 'SHOT_CLOSEUP_COUNT', 'SHOT_ULTRAWIDE_COUNT',
      'SHOT_AERIAL_COUNT', 'SHOT_OTS_COUNT', 'SHOT_NO_CAMERA_POSITION', 'SHOT_VARIETY']) {
      expect(codes, c).not.toContain(c);
    }
  });

  it('a six-page trial of close-ups and mediums is asked for no angle', () => {
    const codes = codesFor([...fill(3, 'medium'), ...fill(3, 'close-up')]);
    expect(codes).not.toContain('SHOT_NO_CAMERA_POSITION');
    expect(codes).not.toContain('SHOT_OTS_COUNT');
    expect(codes).not.toContain('SHOT_AERIAL_COUNT');
    expect(codes).not.toContain('SHOT_ULTRAWIDE_COUNT');
    expect(codes).not.toContain('SHOT_CLOSEUP_COUNT');
  });

  it('a long book short of the positions TOTAL is told so even with each angle present', () => {
    // 24 pages owe 4 positions; aerial 1 + over-the-shoulder 2 is only 3.
    const shots = [...fill(2, 'close-up'), 'ultra-wide', 'aerial',
      'over-the-shoulder', 'over-the-shoulder', ...fill(12, 'medium'), ...fill(6, 'wide')];
    expect(shots).toHaveLength(24);
    const codes = codesFor(shots);
    expect(codes).toContain('SHOT_NO_CAMERA_POSITION');
    expect(codes).not.toContain('SHOT_OTS_COUNT');
    expect(codes).not.toContain('SHOT_AERIAL_COUNT');
  });
});

describe('a re-plan is OBLIGED to answer the spread', () => {
  it.each([
    'SHOT_MEDIUM_WIDE_EXCESS', 'SHOT_ULTRAWIDE_COUNT', 'SHOT_AERIAL_COUNT',
    'SHOT_OTS_COUNT', 'SHOT_CLOSEUP_COUNT', 'SHOT_NO_CAMERA_POSITION',
  ])('%s ranks must-fix', (code) => {
    expect(replanRank({ code })).toBe('must');
  });

  it('SHOT_VARIETY stays advisory — it is subsumed by the cap and the floors', () => {
    expect(replanRank({ code: 'SHOT_VARIETY' })).toBe('also');
  });
});

describe('the planner is asked for the same table the counters measure', () => {
  it('the phrase states the cap, the floors and the positions total', () => {
    const phrase = shotDistributionPhrase(18);
    expect(phrase).toContain('at most 9');
    expect(phrase).toContain('2 close-up pages');
    expect(phrase).toContain('1 ultra-wide page');
    expect(phrase).toContain('2 over-the-shoulder pages');
    expect(phrase).toContain('1 aerial page');
    expect(phrase).toContain('3 pages in total leave eye level');
  });

  it('a trial-length phrase mandates no angle and no ultra-wide, but still offers the words', () => {
    const phrase = shotDistributionPhrase(6);
    expect(phrase).toContain('at most 3');
    expect(phrase).toContain('1 close-up page');
    expect(phrase).not.toContain('in total leave eye level');
    expect(phrase).not.toContain('ultra-wide page');
    // A short book owes no angle; the page that earns one may still take it.
    expect(phrase).toContain('may leave eye level for a camera position');
    for (const id of POSITION_SHOTS) expect(phrase).toContain(id);
  });
});
