import { describe, it, expect } from 'vitest';

// Owner, 2026-09-24: "We should take the correct landmark photo. For ultra wide
// a different one than for a normal image. If we have landmark variants that
// match. If not we use the same one."
//
// Staging job_1790100385959_1nitlympp served one photo (the terrace square,
// judged `medium`) on all 17 Lindenhof pages — ultra-wide, aerial and
// eye-level alike — while the index held two photos the judge had framed
// `wide`. docs/decisions.md 2026-09-24 ("the page's shot picks the photo's
// framing").
//
// Contracts pinned: the page's shot picks a photo whose judged framing fits;
// no fitting photo -> the photo a medium page gets; the page's shot wins over
// its vantage's; an unclassified photo_type takes its kind from the framing.

import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const landmarkPhotos: any = nodeRequire('../../server/lib/landmarkPhotos.js');
const { pickVariantForView, variantsFromIndexRow, photoFramingsForShot } = landmarkPhotos;
landmarkPhotos.loadLandmarkPhotoVariant = async (_vb: any, _id: string, n: number) =>
  ({ photoData: 'data:image/jpeg;base64,AAA', attribution: 'x', variantNumber: n });
const { getLandmarkPhotosForScene } = nodeRequire('../../server/lib/storyHelpers.js');
const { resolveShotId } = nodeRequire('../../server/lib/shotVocabulary.js');

const v = (n: number, kind: string, framing: string | null, photoScore: number | null = null) =>
  ({ variantNumber: n, kind, framing, photoScore, url: `https://x/${n}.jpg` });
const loc = (variants: any[], extra: any = {}) => ({
  id: 'LOC002', name: 'A Hilltop Square', isRealLandmark: true, photoVariants: variants, ...extra,
});

// The shape of the stored run: a medium 80, a wide 45, a wide 72.
const square = loc([v(1, 'exterior', 'medium', 80), v(2, 'exterior', 'wide', 45), v(3, 'exterior', 'wide', 72)]);

describe('the page shot picks the landmark photo by its judged framing', () => {
  it('REGRESSION: an ultra-wide page gets a wide-framed photo, a medium page the medium one', () => {
    expect(pickVariantForView(square, null, 'ultra-wide')).toBe(3);
    expect(pickVariantForView(square, null, 'medium')).toBe(1);
  });

  it('a medium page takes the medium photo even when a wide one is judged higher', () => {
    const l = loc([v(1, 'exterior', 'wide', 90), v(2, 'exterior', 'medium', 60)]);
    expect(pickVariantForView(l, null, 'medium')).toBe(2);
  });

  it('aerial prefers an aerial photo, then a wide one', () => {
    const both = loc([v(1, 'exterior', 'medium', 80), v(2, 'exterior', 'wide', 90), v(3, 'distant', 'aerial', 50)]);
    expect(pickVariantForView(both, null, 'aerial')).toBe(3);
    expect(pickVariantForView(square, null, 'aerial')).toBe(3);
  });

  it('a close-up is close to a figure, not the place: it keeps the normal photo', () => {
    const l = loc([v(1, 'exterior', 'medium', 80), v(2, 'close', 'closeup', 85)]);
    expect(pickVariantForView(l, null, 'close-up')).toBe(1);
  });

  it('OWNER RULE: no photo fits the framing -> the same photo a medium page gets', () => {
    const noFar = loc([v(1, 'exterior', 'medium', 80), v(2, 'exterior', 'closeup', 70)]);
    const normal = pickVariantForView(noFar, null, 'medium');
    expect(pickVariantForView(noFar, null, 'ultra-wide')).toBe(normal);
    expect(pickVariantForView(noFar, null, 'aerial')).toBe(normal);
  });

  it('a camera position, a `wide` page and no shot all get the normal photo', () => {
    for (const shot of ['close-up', 'high-angle', 'low-angle', 'over-the-shoulder', 'wide', null]) {
      expect(pickVariantForView(square, null, shot)).toBe(1);
    }
  });

  it('a fitting photo judged below the serving cutoff is never used', () => {
    const l = loc([v(1, 'exterior', 'medium', 80), v(2, 'exterior', 'wide', 35)]);
    expect(pickVariantForView(l, null, 'ultra-wide')).toBe(1);
  });

  it('the view still decides the kind: an interior page never gets an exterior wide shot', () => {
    const l = loc([v(1, 'exterior', 'wide', 80), v(4, 'interior', 'interior', 60)]);
    expect(pickVariantForView(l, 'interior', 'ultra-wide')).toBe(4);
    expect(pickVariantForView(l, 'none', 'ultra-wide')).toBeNull();
  });

  it('shot words resolve through the shot vocabulary', () => {
    expect(resolveShotId('ultra-wide')).toBe('ultra-wide');
    expect(resolveShotId('extreme wide establishing')).toBe('ultra-wide');
    expect(resolveShotId('wide')).toBe('wide');
    expect(photoFramingsForShot("bird's-eye")).toEqual(['aerial', 'wide']);
    expect(photoFramingsForShot('something else')).toEqual(['medium']);
  });
});

describe('variantsFromIndexRow carries the judged framing', () => {
  const row = (types: any, framings: any) => ({
    id: 1, name: 'x',
    photo_url: 'https://x/1.jpg', photo_url_2: 'https://x/2.jpg', photo_url_5: 'https://x/5.jpg',
    photo_type: types[0], photo_type_2: types[1], photo_type_5: types[2],
    photo_scores: { 1: 80, 2: 70, 5: 60 },
    photo_framings: framings,
  });

  it('each variant gets its own slot\'s framing; unjudged is null', () => {
    const vs = variantsFromIndexRow(row(['exterior', 'exterior', 'interior'], { 1: 'medium', 2: 'wide' }));
    expect(vs.map((x: any) => [x.variantNumber, x.framing])).toEqual([[1, 'medium'], [2, 'wide'], [5, null]]);
  });

  it('an unclassified photo takes its kind from the framing, not the slot guess', () => {
    const vs = variantsFromIndexRow(row([null, null, null], { 1: 'medium', 2: 'interior', 5: 'medium' }));
    expect(vs.map((x: any) => [x.variantNumber, x.kind])).toEqual([[1, 'exterior'], [2, 'interior'], [5, 'exterior']]);
  });

  it('a classified photo_type keeps its own kind', () => {
    const vs = variantsFromIndexRow(row(['exterior', 'exterior', 'interior'], { 1: 'medium', 2: 'interior', 5: 'medium' }));
    expect(vs.map((x: any) => x.kind)).toEqual(['exterior', 'exterior', 'interior']);
  });
});

describe('getLandmarkPhotosForScene matches the page camera', () => {
  const withVantages = loc(square.photoVariants, {
    pages: [2, 3, 18],
    vantages: [{ id: 'LOC002.1', shot: 'ultra-wide', pages: [2] }, { id: 'LOC002.2', shot: 'medium', pages: [3, 18] }],
  });
  const served = async (meta: any, pageNumber?: number) =>
    (await getLandmarkPhotosForScene({ locations: [withVantages] }, meta, pageNumber ? { pageNumber } : {}))
      .map((p: any) => p.variantNumber);

  it('the page\'s own shot wins over its vantage\'s', async () => {
    expect(await served({ objects: ['LOC002.1'], fullData: { shot: 'medium' } }, 2)).toEqual([1]);
    expect(await served({ objects: ['LOC002.2'], fullData: { shot: 'ultra-wide' } }, 3)).toEqual([3]);
    // Iterate metadata carries it top-level.
    expect(await served({ objects: ['LOC002.2'], shot: 'ultra-wide' }, 3)).toEqual([3]);
  });

  it('a page with no shot takes the cited vantage\'s, then the vantage naming the page', async () => {
    expect(await served({ objects: ['LOC002.1'] }, 2)).toEqual([3]);
    expect(await served({ objects: ['A Hilltop Square [LOC002]'] }, 2)).toEqual([3]);
    expect(await served({ objects: ['LOC002'] }, 18)).toEqual([1]);
  });

  it('a cover states its camera in setting.camera', async () => {
    expect(await served({ objects: ['LOC002'], setting: { camera: 'ultra-wide' } })).toEqual([3]);
    expect(await served({ objects: ['LOC002'] })).toEqual([1]);
  });
});
