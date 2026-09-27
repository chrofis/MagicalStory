/**
 * THE ART DIRECTOR CITES THE LANDMARK PHOTO (owner-approved design,
 * docs/decisions.md 2026-09-26).
 *
 * The landmark photo used to be picked by metadata only — the page's view
 * word, its shot mapped to a judged framing, then the score — and the photo's
 * CONTENT played no part. 23% of full-story briefs staged a structure or view
 * no photo shows, and 12% got a wrong-subject photo. Now each plate's author
 * cites one photo from a numbered list (`landmarkPhoto: <n> | "none"`) and the
 * server serves exactly that slot.
 *
 * Pinned here (behaviour, not prompt wording):
 *   - which plate's citation a page / cover / vantage plate reads;
 *   - the served slot IS the citation; "none" serves nothing; a missing or
 *     unlisted citation is an error, a miss, and no photo — nothing picks one;
 *   - the Art Director sees EVERY servable photo, numbered, its description
 *     whole (it was cut at 110 chars and merged by framing);
 *   - the one citation rule reaches every author and the scene review;
 *   - the scene review's correction is adopted only when it is servable.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const landmarkPhotos: any = nodeRequire('../../server/lib/landmarkPhotos.js');
const requested: number[] = [];
landmarkPhotos.loadLandmarkPhotoVariant = async (_vb: any, _id: string, n: number) => {
  requested.push(n);
  return { photoData: 'data:image/jpeg;base64,AAA', attribution: 'x', variantNumber: n };
};
const SH = nodeRequire('../../server/lib/storyHelpers.js');
const PB = nodeRequire('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');
const { applyReviewBibleCorrections } = nodeRequire('../../server/lib/beatsPipeline.js');

const LONG_DESC = '[whole, autumn, day] A broad terrace square under old trees, a low stone wall along its far edge, '
  + 'benches in a row, a chess board painted on the gravel, and beyond the wall the roofs of the old town '
  + 'falling toward a river with a church tower rising on the opposite bank against a pale sky.';
const photo = (n: number, over: any = {}) => ({
  variantNumber: n, kind: 'exterior', framing: 'medium', photoScore: 70,
  url: `https://x/${n}.jpg`, description: `photo ${n} description`, ...over,
});
const landmark = (over: any = {}) => ({
  id: 'LOC001', name: 'A Terrace Square', isRealLandmark: true, landmarkQuery: 'A Terrace Square',
  pages: [-1, 1, 2, 3], isSwissPreIndexed: true, photoFetchStatus: 'pending_lazy',
  photoVariants: [photo(1, { description: LONG_DESC }), photo(2, { framing: 'wide' }), photo(3, { framing: 'wide' })],
  vantages: [
    { id: 'LOC001.1', name: 'stairs up', pages: [1], landmarkPhoto: 'none' },
    { id: 'LOC001.2', name: 'square wide', pages: [-1, 2], landmarkPhoto: 1 },
    { id: 'LOC001.3', name: 'far view', pages: [3], landmarkPhoto: 2 },
  ],
  ...over,
});
const served = async (vb: any, meta: any, opts: any) => {
  requested.length = 0;
  const misses: any[] = [];
  const photos = await SH.getLandmarkPhotosForScene(vb, meta, { ...opts, misses });
  return { slots: photos.map((p: any) => p.variantNumber), misses };
};

describe('the page takes the photo its plate cites', () => {
  const vb = { locations: [landmark()] };
  it('a page on a vantage gets exactly that vantage\'s cited slot', async () => {
    expect((await served(vb, { objects: ['LOC001'] }, { pageNumber: 2 })).slots).toEqual([1]);
    expect((await served(vb, { objects: ['LOC001'] }, { pageNumber: 3 })).slots).toEqual([2]);
    expect(requested).toEqual([2]);
  });
  it('a vantage citing "none" serves no photo and is not a miss', async () => {
    const r = await served(vb, { objects: ['LOC001'] }, { pageNumber: 1 });
    expect(r.slots).toEqual([]);
    expect(r.misses).toEqual([]);
  });
  it('the vantage plate path names its vantage, which wins over page membership', async () => {
    expect((await served(vb, { objects: ['LOC001'] }, { pageNumber: 2, vantageId: 'LOC001.3' })).slots).toEqual([2]);
  });
  it('a cover finds the vantage whose pages name its negative page number', async () => {
    expect((await served(vb, { objects: ['LOC001'] }, { pageNumber: -1 })).slots).toEqual([1]);
  });
  it('a location with no vantages carries its own citation', async () => {
    const one = { locations: [landmark({ vantages: undefined, landmarkPhoto: 3 })] };
    expect((await served(one, { objects: ['LOC001'] }, { pageNumber: 2 })).slots).toEqual([3]);
  });
  it('a page\'s own citation (an iterate rewrite with a fresh plate) wins for its primary location', async () => {
    expect((await served(vb, { objects: ['LOC001'], landmarkPhoto: 3 }, { pageNumber: 2 })).slots).toEqual([3]);
  });
});

describe('NO FALLBACK: a missing or unlisted citation serves nothing, loudly', () => {
  it('no citation (a stored story from before 2026-09-26) → no photo, a miss naming the reason', async () => {
    const stored = { locations: [landmark({ vantages: [{ id: 'LOC001.1', pages: [1, 2, 3] }] })] };
    const r = await served(stored, { objects: ['LOC001'] }, { pageNumber: 2 });
    expect(r.slots).toEqual([]);
    expect(requested).toEqual([]);
    expect(r.misses[0].reason).toMatch(/no landmarkPhoto cited/);
  });
  it('a number that is not one of its servable photos → no photo, a miss', async () => {
    const bad = { locations: [landmark({ vantages: [{ id: 'LOC001.1', pages: [2], landmarkPhoto: 5 }] })] };
    const r = await served(bad, { objects: ['LOC001'] }, { pageNumber: 2 });
    expect(r.slots).toEqual([]);
    expect(r.misses[0].reason).toMatch(/not one of its photos \(1,2,3\)/);
  });
  it('a photo judged below the cutoff is not servable, so citing it is an error', async () => {
    const low = { locations: [landmark({ photoVariants: [photo(1), photo(2, { photoScore: 20 })],
      vantages: [{ id: 'LOC001.1', pages: [2], landmarkPhoto: 2 }] })] };
    expect((await served(low, { objects: ['LOC001'] }, { pageNumber: 2 })).misses).toHaveLength(1);
  });
  it('no vantage names the page → no photo, a miss', async () => {
    const r = await served({ locations: [landmark({ pages: [9] , vantages: [{ id: 'LOC001.1', pages: [1], landmarkPhoto: 1 }] })] },
      { objects: ['LOC001'] }, { pageNumber: 9 });
    expect(r.slots).toEqual([]);
    expect(r.misses).toHaveLength(1);
  });
  it('landmarkPhotoCitationFaults lists every uncited or unlisted plate', () => {
    const faults = SH.landmarkPhotoCitationFaults({ locations: [landmark({
      vantages: [{ id: 'LOC001.1', landmarkPhoto: 1 }, { id: 'LOC001.2' }, { id: 'LOC001.3', landmarkPhoto: 9 }, { id: 'LOC001.4', landmarkPhoto: 'none' }],
    })] });
    expect(faults.map((f: any) => f.plateId)).toEqual(['LOC001.2', 'LOC001.3']);
  });
});

describe('the Art Director sees every photo, numbered and whole', () => {
  const avail = [{ name: 'A Terrace Square', type: 'Square', photoVariants: landmark().photoVariants }];
  it('every servable photo, by slot number, with its framing, description uncut', () => {
    const s = PB.buildAvailableLandmarksSection(avail, '', { forArtDirector: true });
    for (const n of [1, 2, 3]) expect(s).toContain(`Photo ${n} (exterior`);
    expect(s).toContain(LONG_DESC);
    expect(s).toContain('framed wide');
    expect(s).toContain(PB.LANDMARK_PHOTO_CITE_RULE);
  });
  it('the writers keep their one short PHOTOS line and are not given the citation rule', () => {
    const s = PB.buildAvailableLandmarksSection(avail, '');
    expect(s).not.toContain(PB.LANDMARK_PHOTO_CITE_RULE);
    expect(s).not.toContain(LONG_DESC);
  });
  it('servedLandmark lists two photos of the same framing (they were merged to one)', () => {
    const row: any = {
      id: 7, name: 'A Terrace Square', photo_url: 'https://x/1.jpg', photo_description: 'one',
      photo_url_2: 'https://x/2.jpg', photo_description_2: 'two', photo_url_3: 'https://x/3.jpg', photo_description_3: 'three',
      photo_url_4: 'https://x/4.jpg', photo_description_4: 'four',
    };
    const judged = { primary: 1, byFraming: [], scores: { 1: 80, 2: 45, 3: 72, 4: 10 }, framings: { 1: 'medium', 2: 'wide', 3: 'wide', 4: 'wide' } };
    const l = landmarkPhotos.servedLandmark(row, judged);
    expect(l.photoVariants.map((v: any) => [v.variantNumber, v.framing])).toEqual([[1, 'medium'], [2, 'wide'], [3, 'wide']]);
  });
});

describe('one citation rule reaches every author and the critic', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const vb = { locations: [{ ...landmark(), emptyScenePrompt: undefined,
    vantages: landmark().vantages.map((v: any) => ({ ...v, emptyScenePrompt: 'a plate', shot: 'wide' })) }] };

  it('the scene review is given the rule, each plate\'s citation and the numbered photos', () => {
    const p = PB.buildSceneReviewPrompt({ characters: [], language: 'en' }, [{ pageNumber: 2, brief: 'A brief.' }], { visualBible: vb });
    expect(p).toContain(PB.LANDMARK_PHOTO_CITE_RULE);
    expect(p).toMatch(/LOC001\.3[^\n]*landmarkPhoto: 2/);
    expect(p).toMatch(/LOC001\.1[^\n]*landmarkPhoto: "none"/);
    expect(p).toContain(LONG_DESC);
    expect(p).not.toMatch(/\{LANDMARK_PHOTO_CITE\}/);
  });
  it('the trial writer lists the numbered photos and gets the rule', () => {
    const p = PB.buildTrialStoryPrompt({
      characters: [{ name: 'Mia', age: 6, isMainCharacter: true }], mainCharacters: [], language: 'en',
      storyDetails: 'A day out.', userLocation: { city: 'A Town' },
      availableLandmarks: [{ name: 'A Terrace Square', photoVariants: landmark().photoVariants }],
    }, 4);
    expect(p).toContain(LONG_DESC);
    expect(p).toContain(PB.LANDMARK_PHOTO_CITE_RULE);
    expect(p).not.toMatch(/landmarkView/);
  });
  it('the per-page Art Director and the rewrite list the photos and the plate citations, no dotted photo ids', () => {
    const text = PB.buildSceneExpansionPrompt(2, 'text', [], 'en', vb, '', null, {});
    expect(text).toContain('Photo 3 (exterior');
    expect(text).toMatch(/LOC001\.3 "far view" → Photo 2/);
    expect(text).not.toMatch(/\[LOC001\.\d\] \((?:exterior|interior)\)/);
  });
});

describe('the scene review corrects a citation only to a servable photo', () => {
  const review = (json: any) => `analysis\n---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
  it('a vantage row sets that vantage\'s landmarkPhoto', () => {
    const vb: any = { locations: [landmark()] };
    const out = applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001', vantages: [{ id: 'LOC001.1', landmarkPhoto: 3 }] }] }), vb, 3);
    expect(vb.locations[0].vantages[0].landmarkPhoto).toBe(3);
    expect(out.applied).toHaveLength(1);
    expect(out.rejected).toEqual([]);
  });
  it('a top-level dotted row is the same correction', () => {
    const vb: any = { locations: [landmark()] };
    applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001.3', landmarkPhoto: 'none' }] }), vb, 3);
    expect(vb.locations[0].vantages[2].landmarkPhoto).toBe('none');
  });
  it('an unlisted photo is rejected and the authored citation stands', () => {
    const vb: any = { locations: [landmark()] };
    const out = applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001', vantages: [{ id: 'LOC001.2', landmarkPhoto: 7 }] }] }), vb, 3);
    expect(vb.locations[0].vantages[1].landmarkPhoto).toBe(1);
    expect(out.rejected).toHaveLength(1);
  });
});
