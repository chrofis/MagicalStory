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

describe('the floors are tiered, so a short book is not asked for a long book spread', () => {
  it('a trial-length book owes one close-up and no angle at all', () => {
    const f = shotFloors(8);
    expect(f.floors).toEqual({ 'close-up': 1 });
    expect(f.requiredPositions).toBe(0);
  });

  it.each([
    [8, { 'close-up': 1 }, 0],
    [9, { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 1 }, 2],
    [13, { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 1 }, 2],
    [14, { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 2 }, 3],
    [18, { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 2 }, 3],
    [24, { 'close-up': 2, 'ultra-wide': 1, 'over-the-shoulder': 2 }, 4],
  ])('%i pages: the tier boundary holds', (n, floors, positions) => {
    const f = shotFloors(n as number);
    expect(f.floors).toEqual(floors);
    // Removing the aerial floor (owner, 2026-09-23) must not remove angled
    // pages: the position total per tier is exactly what it was.
    expect(f.requiredPositions).toBe(positions);
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
