/**
 * Two regressions found on job_1788614817116_vxnu60yjg (Uetliberg dragon egg,
 * de-ch, 18 pages, staging):
 *
 *  1. The job carried `season: ""`. Every consumer wrote
 *     `inputData.season ? ... : null`, so the empty string removed the Season
 *     line from the story brief entirely — nothing downstream stated a season,
 *     the UI showed "Jahreszeit: Nicht angegeben", and page 6 rendered
 *     autumn-orange foliage while pages 1 and 3 stayed green.
 *  2. The style/visual-flow audit reported `declared: null` for all 21 cells,
 *     although 13 of the 18 briefs name an hour outright. The extractor was
 *     never the problem: the CALLER handed it pages projected down to
 *     `{pageNumber, imageData}`, so it read `undefined` every time.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSeason, normalizeSeason, seasonForDate, seasonLabel, buildSeasonNote } = require('../../server/lib/season.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractDeclaredLight } = require('../../server/lib/styleConsistency.js');

describe('season resolver', () => {
  it('honours an explicit season', () => {
    expect(resolveSeason({ season: 'winter' }, { now: '2026-07-15' })).toBe('winter');
  });

  it('treats the empty string as absent and derives from the story date', () => {
    // The exact shape of job_1788614817116_vxnu60yjg: season "" + a Sept date.
    expect(resolveSeason({ season: '' }, { now: '2026-09-05T11:26:57Z' })).toBe('autumn');
    expect(resolveSeason({}, { now: '2026-07-01' })).toBe('summer');
    expect(resolveSeason({ season: null }, { now: '2026-01-09' })).toBe('winter');
  });

  it('uses the same month boundaries as the wizard default', () => {
    expect(seasonForDate('2026-03-01')).toBe('spring');
    expect(seasonForDate('2026-05-31')).toBe('spring');
    expect(seasonForDate('2026-06-01')).toBe('summer');
    expect(seasonForDate('2026-08-31')).toBe('summer');
    expect(seasonForDate('2026-09-01')).toBe('autumn');
    expect(seasonForDate('2026-11-30')).toBe('autumn');
    expect(seasonForDate('2026-12-01')).toBe('winter');
    expect(seasonForDate('2026-02-28')).toBe('winter');
  });

  it('normalises the aliases a launcher or an older row may carry', () => {
    expect(normalizeSeason('Fall')).toBe('autumn');
    expect(normalizeSeason(' Sommer ')).toBe('summer');
    expect(normalizeSeason('Herbst')).toBe('autumn');
    expect(normalizeSeason('nonsense')).toBeNull();
    expect(normalizeSeason('')).toBeNull();
  });

  it('always yields a prompt label and a non-empty image note', () => {
    expect(seasonLabel({ season: '' }, { now: '2026-07-04' })).toBe('Summer');
    const note = buildSeasonNote({ season: 'summer' });
    expect(note).toContain('**SEASON:** Summer');
    // The book-wide continuity clause and the landmark-photo override are the
    // two things this note exists for.
    expect(note).toMatch(/page to page/i);
    expect(note).toMatch(/reference photo/i);
  });
});

describe('extractDeclaredLight — the vocabulary the briefs actually use', () => {
  // Verbatim sentences from job_1788614817116_vxnu60yjg.
  const cases: Array<[number, string, string | null]> = [
    [6, 'Warm golden morning light filters through the beech and oak canopy onto the grey-brown compacted earth path.', 'morning'],
    [10, 'The sun sits noticeably low and orange directly above the dark green forest treeline in a pale warm sky, casting long late-afternoon shadows across the clearing.', 'afternoon'],
    [13, 'In the deep background, the sun sits directly on the jagged dark blue-grey Alpine ridge, casting long amber evening shadows across the platform boards.', 'evening'],
    [16, 'Below the platform, the unseen valley falls away into complete darkness under the deep blue-black night sky.', 'night'],
    // p5 states no hour — null is the correct answer, not a miss.
    [5, 'A preschooler of average build with short tousled wavy light blonde hair and green eyes, wearing a red short-sleeved cotton T-shirt.', null],
  ];

  for (const [page, brief, token] of cases) {
    it(`p${page} → ${token ?? 'null'}`, () => {
      expect(extractDeclaredLight(brief).token).toBe(token);
    });
  }

  it('an absent brief is what made the whole pass inert — it must stay null, never throw', () => {
    expect(extractDeclaredLight(undefined).token).toBeNull();
    expect(extractDeclaredLight(undefined).text).toBe('');
  });

  it('does not key on "light blonde" / "dark red" hair and clothing', () => {
    expect(extractDeclaredLight('A boy with light blonde hair in a dark red jacket.').token).toBeNull();
  });

  it('reads the brief only, never the METADATA block', () => {
    const brief = 'A boy stands on the path.\n---METADATA---\n{"sceneIntent":"night sky over the valley"}';
    expect(extractDeclaredLight(brief).token).toBeNull();
  });
});
