import { describe, it, expect } from 'vitest';

// Trial used to render ONE backdrop plate PER PAGE (6 calls / $0.12 on a 6-page
// trial, 17-23% of the whole trial cost) while measurement across 12 trials
// found only 1-3 DISTINCT vantages per trial. groupTrialPlatePagesByVantage is
// what buys trial the same plate reuse full mode has: it synthesizes the
// minimal page shape groupPagesByVantage reads (there is no pageDataArray yet
// at outline-stream time) and reuses the real grouper.
//
// Pinned here, as behaviour rather than wording:
//   1. Pages in one LOC share ONE plate.
//   2. Distinct LOCs get distinct plates.
//   3. A page in no LOC still gets a plate — as its own group, never dropped.
//   4. When a group spans two backgrounds[] entries, the FIRST page's prose is
//      the plate description (same representative-page rule the full-mode
//      vantage path uses).
//   5. Every page named by backgrounds[] is covered exactly once.
const { groupTrialPlatePagesByVantage } = require('../../server/lib/sceneMetadata');

type Group = { vantageId: string | null; pages: number[]; description: string };

const coveredPages = (groups: Group[]) => groups.flatMap(g => g.pages).sort((a, b) => a - b);

describe('groupTrialPlatePagesByVantage', () => {
  it('renders ONE plate when every page stands in the same location', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Village square', pages: [1, 2, 3, 4, 5, 6] }],
      backgrounds: [
        { pages: [1, 2, 3], description: 'Sun-drenched cobblestone square.' },
        { pages: [4, 5, 6], description: 'The same square at dusk.' },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].pages).toEqual([1, 2, 3, 4, 5, 6]);
    expect(groups[0].vantageId).toBe('LOC001.1');
  });

  it('renders one plate per distinct location', () => {
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
    expect(orphan.pages).toEqual([6]);
    expect(orphan.description).toContain('hilltop');
  });

  it('uses the FIRST page prose when a group spans two backgrounds entries', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1, 2, 3, 4] }],
      backgrounds: [
        { pages: [1, 2], description: 'FIRST ENTRY — square by day.' },
        { pages: [3, 4], description: 'SECOND ENTRY — square by night.' },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].description).toContain('FIRST ENTRY');
  });

  it('falls back to one plate per page when the bible has no locations', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      backgrounds: [
        { pages: [1, 2], description: 'A.' },
        { pages: [3], description: 'B.' },
      ],
    });
    expect(groups).toHaveLength(3);
    expect(groups.every(g => g.vantageId === null && g.pages.length === 1)).toBe(true);
    expect(coveredPages(groups)).toEqual([1, 2, 3]);
  });

  it('covers a page named by two backgrounds entries exactly once', () => {
    const groups: Group[] = groupTrialPlatePagesByVantage({
      locations: [{ id: 'LOC001', name: 'Square', pages: [1, 2] }],
      backgrounds: [
        { pages: [1, 2], description: 'A.' },
        { pages: [2], description: 'B (duplicate page 2).' },
      ],
    });
    expect(coveredPages(groups)).toEqual([1, 2]);
  });

  it('ignores backgrounds entries with no description or no pages', () => {
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
