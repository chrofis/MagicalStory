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
const { extractDeclaredLight, buildStyleAuditInput, pageBriefMap } = require('../../server/lib/styleConsistency.js');

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

/**
 * SECOND fix for the same bug (job_1788641639919_mpjwlzkf1, 17 cells, all
 * `declared: null` / `declaredText: ""`). The first fix carried
 * `sceneDescription` into the style-audit projection — but the pipeline's own
 * story data names the page brief `description`
 * (`storyJobPipeline.js`: `sceneImages: rawImages.map(r => ({ pageNumber,
 * imageData, description: r.sceneDescription, ... }))`), so the lookup missed
 * on every page and the audit input carried no fallback array either.
 *
 * These tests feed the EXACT pipeline projection shape through the real input
 * builder — no re-implementation of it here, or the next rename slips through
 * again.
 */
describe("buildStyleAuditInput — the repair pipeline's style-audit projection", () => {
  // Verbatim from job_1788641639919_mpjwlzkf1.
  const P7 = 'Soft orange and pale grey dusk light fills the evening sky above the heavy tree canopies.';
  const P13 = 'The dense horse chestnut tree canopy above blocks out the night sky, casting deep shadows over the cobbles.';
  const P1 = 'Margaret — an elderly woman of average build, wearing a soft purple long-line wool cardigan.';

  // Exactly what storyJobPipeline hands the repair pipeline: page rows keyed
  // `description`, plus the Art Director's expandedScenes as sceneDescriptions.
  const pipelineStoryData = {
    sceneImages: [
      { pageNumber: 1, imageData: 'x', description: P1 },
      { pageNumber: 7, imageData: 'x', description: P7 },
      { pageNumber: 13, imageData: 'x', description: P13 },
    ],
    sceneDescriptions: [
      { pageNumber: 1, description: P1 },
      { pageNumber: 7, description: P7 },
      { pageNumber: 13, description: P13 },
    ],
    coverImages: { frontCover: { imageData: 'cover' } },
    artStyle: 'watercolor',
  };
  // finalBestPerPage holds image VERSION objects — pixels + scores, no brief.
  const bestByPage = new Map<number, any>([
    [1, { imageData: 'p1' }],
    [7, { imageData: 'p7' }],
    [13, { imageData: 'p13' }],
    [-1, { imageData: 'front' }],
  ]);

  it("resolves a brief for every page from the pipeline's `description` key", () => {
    const input = buildStyleAuditInput(pipelineStoryData, bestByPage);
    expect(input.sceneImages.map((s: any) => s.pageNumber)).toEqual([1, 7, 13]);
    expect(input.sceneImages.every((s: any) => !!s.sceneDescription)).toBe(true);
    // The bug in one assertion: dusk must be declared, not null.
    const p7 = input.sceneImages.find((s: any) => s.pageNumber === 7);
    expect(extractDeclaredLight(p7.sceneDescription).token).toBe('evening');
    expect(extractDeclaredLight(p7.sceneDescription).text).toContain('dusk');
    const p13 = input.sceneImages.find((s: any) => s.pageNumber === 13);
    expect(extractDeclaredLight(p13.sceneDescription).token).toBe('night');
  });

  it('carries the picked-best pixels, never the input page rows', () => {
    const input = buildStyleAuditInput(pipelineStoryData, bestByPage);
    expect(input.sceneImages.map((s: any) => s.imageData)).toEqual(['p1', 'p7', 'p13']);
  });

  it("passes the expandedScenes array through so the audit's own fallback is not empty", () => {
    const input = buildStyleAuditInput(pipelineStoryData, bestByPage);
    expect(input.sceneDescriptions).toHaveLength(3);
    expect(input.artStyle).toBe('watercolor');
  });

  it('covers join at their negative page numbers, pipeline pixels preferred', () => {
    const input = buildStyleAuditInput(pipelineStoryData, bestByPage);
    // frontCover was repaired in this run -> picked-best pixels win.
    expect(input.coverImages.frontCover.imageData).toBe('front');
    // A cover this run never touched still joins from the input story data.
    const input2 = buildStyleAuditInput(
      { ...pipelineStoryData, coverImages: { frontCover: { imageData: 'stored' }, backCover: { imageData: 'storedBack' } } },
      new Map([[1, { imageData: 'p1' }]])
    );
    expect(input2.coverImages.frontCover.imageData).toBe('stored');
    expect(input2.coverImages.backCover.imageData).toBe('storedBack');
  });

  it('pageBriefMap reads all three historical key names, canonical winning', () => {
    expect(pageBriefMap({ sceneImages: [{ pageNumber: 2, description: 'A' }] }).get(2)).toBe('A');
    expect(pageBriefMap({ sceneImages: [{ pageNumber: 2, sceneDescription: 'B' }] }).get(2)).toBe('B');
    expect(pageBriefMap({
      sceneImages: [{ pageNumber: 2, description: 'page-row copy' }],
      sceneDescriptions: [{ pageNumber: 2, description: 'canonical' }],
    }).get(2)).toBe('canonical');
    expect(pageBriefMap({}).size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// I9 — the season block STATES that foliage is identical page to page for the
// same place (e920e1d4f); nothing measured it. The style audit now carries a
// season axis alongside the time-of-day one: the grid judge returns a
// `renderedSeason` per cell, code compares it against the commissioned season
// and against the other cells standing in the same VB location.
//
// GUIDELINE semantics, mirroring timeFlow exactly: findings are reported and
// stored; nothing here enters the outlier list, changes a score, or triggers a
// repaint.
// ────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractSceneLocationIds, compareSeasons, SEASON_BUCKETS } = require('../../server/lib/styleConsistency.js');

describe('extractSceneLocationIds', () => {
  // The real shape: the Art Director writes the LOC ids into the brief's
  // METADATA block (job_1788641639919_mpjwlzkf1, p6).
  const BRIEF = 'A boy of about ten stands on the left side of the stone-paved square.\n'
    + '--- METADATA ---\n'
    + '{"shot": "medium", "landmarkView": "exterior", "objects": ["LOC003"], "interactions": []}';

  it('reads the metadata objects array', () => {
    expect(extractSceneLocationIds(BRIEF)).toEqual(['LOC003']);
  });

  it('collapses vantage variants onto their base place', () => {
    const b = '--- METADATA ---\n{"objects": ["LOC001.1", "LOC001", "ART007"]}';
    expect(extractSceneLocationIds(b)).toEqual(['LOC001']);
  });

  it('falls back to any LOC token when the metadata is shaped differently', () => {
    expect(extractSceneLocationIds('the square at LOC003, seen from LOC002.1')).toEqual(['LOC003', 'LOC002']);
  });

  it('an absent or LOC-less brief yields nothing, never a throw', () => {
    expect(extractSceneLocationIds('')).toEqual([]);
    expect(extractSceneLocationIds(null)).toEqual([]);
    expect(extractSceneLocationIds('a kitchen with a kettle')).toEqual([]);
  });
});

describe('compareSeasons — synthetic judge output', () => {
  const cell = (page: number, renderedSeason: string | null, locationIds: string[] = [], declaredSeason: string | null = 'autumn') =>
    ({ page, declaredSeason, renderedSeason, locationIds });

  it('the vocabulary is the five buckets the judge is given', () => {
    expect(SEASON_BUCKETS.split('|')).toEqual(['spring', 'summer', 'autumn', 'winter', 'indeterminate']);
  });

  it('a cell rendering against the commissioned season is a finding', () => {
    const f = compareSeasons([cell(1, 'autumn', ['LOC001']), cell(2, 'summer', ['LOC004'])]);
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('SEASON_DECLARED_MISMATCH');
    expect(f[0].pages).toEqual([2]);
    expect(f[0].detail).toBe('declared autumn, rendered summer');
  });

  it('cells sharing a VB location that disagree are a finding on their own', () => {
    // Neither cell contradicts the declaration; they contradict each other.
    const f = compareSeasons([
      cell(3, 'autumn', ['LOC003']),
      cell(5, 'autumn', ['LOC003']),
      cell(6, 'winter', ['LOC003'], 'winter'),
    ]);
    const conflict = f.find((x: any) => x.code === 'SEASON_LOCATION_CONFLICT');
    expect(conflict).toBeTruthy();
    expect(conflict.pages).toEqual([3, 5, 6]);
    expect(conflict.detail).toContain('LOC003');
    expect(conflict.detail).toContain('p6=winter');
  });

  it('different places may legitimately differ — only the same place must agree', () => {
    expect(compareSeasons([cell(1, 'autumn', ['LOC001']), cell(2, 'winter', ['LOC002'], 'winter')]))
      .toEqual([]);
  });

  it('a page standing in two locations is counted under both', () => {
    const f = compareSeasons([
      cell(1, 'autumn', ['LOC001', 'LOC002']),
      cell(2, 'winter', ['LOC002'], 'winter'),
    ]);
    expect(f.map((x: any) => x.code)).toEqual(['SEASON_LOCATION_CONFLICT']);
    expect(f[0].detail).toContain('LOC002');
  });

  it('"indeterminate" and a missing verdict contradict nothing', () => {
    // An interior, a night frame or a close-up carries no season. Treating that
    // as a contradiction would flag most books.
    expect(compareSeasons([
      cell(1, 'autumn', ['LOC003']),
      cell(2, 'indeterminate', ['LOC003']),
      cell(3, null, ['LOC003']),
    ])).toEqual([]);
  });

  it('cover cells (no declaration, no location) contribute nothing', () => {
    expect(compareSeasons([
      { page: -1, declaredSeason: null, renderedSeason: 'summer', locationIds: [] },
      { page: -3, declaredSeason: null, renderedSeason: 'winter', locationIds: [] },
    ])).toEqual([]);
  });

  it('is pure and total — no rows, junk rows, no throw', () => {
    expect(compareSeasons()).toEqual([]);
    expect(compareSeasons([null as any, undefined as any])).toEqual([]);
  });
});

describe('buildStyleAuditInput carries the season declaration', () => {
  it('projects season and createdAt so the axis is never inert', () => {
    const out = buildStyleAuditInput(
      { season: 'autumn', createdAt: '2026-09-05T21:38:00Z', artStyle: 'watercolour', sceneImages: [], sceneDescriptions: [] },
      new Map([[1, { imageData: 'x' }]]),
    );
    expect(out.season).toBe('autumn');
    expect(out.createdAt).toBe('2026-09-05T21:38:00Z');
  });
});
