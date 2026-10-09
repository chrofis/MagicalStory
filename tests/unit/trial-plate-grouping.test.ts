import { describe, it, expect } from 'vitest';

// Trial plates: ONE per `backgrounds[]` entry the writer declared. They used to
// be grouped by LOCATION (the 2026-09-13 cost cut from one plate per page), which
// collapsed every story set at one landmark to a single backdrop: 18 of 43 stored
// staging trials, all pages on one picture (docs/decisions.md 2026-10-09 "Trial
// backgrounds"). Pinned here, as behaviour rather than wording:
//   1. Two entries in ONE location are two plates (the regression).
//   2. Entries in different locations are different plates, labelled LOC00N.k.
//   3. A page in no location still gets its entry's plate (vantageId null).
//   4. A page named by two entries belongs to the first; an entry with nothing
//      left to render is dropped.
//   5. Every page named by backgrounds[] is covered exactly once.
//   6. An entry's own landmarkPhoto citation rides on its group.
const { groupTrialPlatePagesByVantage } = require('../../server/lib/sceneMetadata');

type Group = { vantageId: string | null; pages: number[]; description: string; landmarkPhoto?: unknown };

const coveredPages = (groups: Group[]) => groups.flatMap(g => g.pages).sort((a, b) => a - b);

describe('groupTrialPlatePagesByVantage', () => {
  it('REGRESSION: two backgrounds in ONE location are two plates', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1, 2, 3, 4, 5, 6] }],
      backgrounds: [
        { pages: [1, 2], description: 'The square, wide view.' },
        { pages: [3, 4], description: 'The fountain, close.' },
        { pages: [5, 6], description: 'A side street off the square.' },
      ],
    });
    expect(groups).toHaveLength(3);
    expect(groups.map(g => g.vantageId)).toEqual(['LOC001.1', 'LOC001.2', 'LOC001.3']);
    expect(coveredPages(groups)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('entries in different locations are different plates', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [
        { id: 'LOC001', name: 'Square', pages: [1, 2] },
        { id: 'LOC002', name: 'Cave', pages: [3, 4] },
        { id: 'LOC003', name: 'Meadow', pages: [5, 6] },
      ],
      backgrounds: [
        { pages: [1, 2], description: 'Square.' },
        { pages: [3, 4], description: 'Cave.' },
        { pages: [5, 6], description: 'Meadow.' },
      ],
    });
    expect(groups.map(g => g.vantageId)).toEqual(['LOC001.1', 'LOC002.1', 'LOC003.1']);
    expect(coveredPages(groups)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('still gives a plate to a page that belongs to no location', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1, 2, 3, 4, 5] }],
      backgrounds: [
        { pages: [1, 2, 3, 4, 5], description: 'Square.' },
        { pages: [6], description: 'A hilltop mapped to no LOC.' },
      ],
    });
    expect(coveredPages(groups)).toEqual([1, 2, 3, 4, 5, 6]);
    const orphan = groups.find(g => g.pages.includes(6))!;
    expect(orphan.vantageId).toBeNull();
    expect(orphan.description).toContain('hilltop');
  });

  it('a page named by two entries belongs to the first; an exhausted entry is dropped', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1, 2] }],
      backgrounds: [
        { pages: [1, 2], description: 'A.' },
        { pages: [2], description: 'B (duplicate page 2).' },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(coveredPages(groups)).toEqual([1, 2]);
  });

  it('works with no locations at all: one plate per entry', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      backgrounds: [
        { pages: [1, 2], description: 'A.' },
        { pages: [3], description: 'B.' },
      ],
    });
    expect(groups).toHaveLength(2);
    expect(groups.every(g => g.vantageId === null)).toBe(true);
    expect(coveredPages(groups)).toEqual([1, 2, 3]);
  });

  it("carries an entry's own landmarkPhoto citation", () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Bridge', pages: [1, 2, 3, 4], isRealLandmark: true }],
      backgrounds: [
        { pages: [1, 2], description: 'Front.', landmarkPhoto: 1 },
        { pages: [3, 4], description: 'Side.', landmarkPhoto: 2 },
      ],
    });
    expect(groups.map(g => g.landmarkPhoto)).toEqual([1, 2]);
  });

  it('ignores entries with no description or no pages', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1] }],
      backgrounds: [
        { pages: [1], description: 'A.' },
        { pages: [2] },
        { description: 'no pages' },
      ],
    });
    expect(coveredPages(groups)).toEqual([1]);
  });

  it('returns nothing when there are no backgrounds at all', () => {
    expect(groupTrialPlatePagesByVantage({})).toEqual([]);
    expect(groupTrialPlatePagesByVantage({ backgrounds: [] })).toEqual([]);
  });
});
