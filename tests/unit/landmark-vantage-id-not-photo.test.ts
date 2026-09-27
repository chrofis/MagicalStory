import { describe, it, expect } from 'vitest';

// The bug this file locks down (staging job_1790100385959_1nitlympp): a brief
// cites a real landmark by its Visual Bible VANTAGE id (`LOC002.3` — a camera
// position the plate is grouped by), and getLandmarkPhotosForScene read the
// `.3` as index photo slot 3. Six pages set on a hilltop square were served
// slot 3 — a riverside promenade — and `.4` / `.5` (no such slot) were quietly
// answered with slot 1 by the loader's cross-slot substitution.
// docs/decisions.md 2026-09-24.
//
// Since 2026-09-26 the dotted id does one thing for the photo: it names the
// vantage whose `landmarkPhoto` citation is served (docs/decisions.md
// 2026-09-26, "The Art Director cites the landmark photo"). Contracts pinned:
// the vantage NUMBER is never read as a slot; the served slot is exactly the
// vantage's citation; a slot the location does not have is never substituted.

import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const landmarkPhotos: any = nodeRequire('../../server/lib/landmarkPhotos.js');
const realLoadVariant = landmarkPhotos.loadLandmarkPhotoVariant;
const { servablePhotos, variantsFromIndexRow } = landmarkPhotos;

// storyHelpers destructures loadLandmarkPhotoVariant at load time (CJS), so the
// stub goes in before storyHelpers loads. It records which slot was requested.
const requested: number[] = [];
landmarkPhotos.loadLandmarkPhotoVariant = async (_vb: any, _id: string, n: number) => {
  requested.push(n);
  return { photoData: 'data:image/jpeg;base64,AAA', attribution: 'x', variantNumber: n };
};
const { getLandmarkPhotosForScene, extractSceneMetadata } = nodeRequire('../../server/lib/storyHelpers.js');

const square = (variants: any[], cites: Record<string, any> = { 'LOC002.2': 2, 'LOC002.3': 1, 'LOC002.4': 1 }) => ({
  id: 'LOC002', name: 'A Hilltop Square', isRealLandmark: true, pages: [3, 6, 12],
  vantages: [
    { id: 'LOC002.2', pages: [3], landmarkPhoto: cites['LOC002.2'] },
    { id: 'LOC002.3', pages: [6], landmarkPhoto: cites['LOC002.3'] },
    { id: 'LOC002.4', pages: [12], landmarkPhoto: cites['LOC002.4'] },
  ],
  photoVariants: variants,
});
const v = (n: number, kind: string, photoScore: number | null = null) =>
  ({ variantNumber: n, kind, photoScore, url: `https://x/${n}.jpg` });

async function servedSlot(loc: any, meta: any, pageNumber: number) {
  requested.length = 0;
  const photos = await getLandmarkPhotosForScene({ locations: [loc] }, meta, { pageNumber });
  return photos.map((p: any) => p.variantNumber);
}

describe('a dotted vantage id never picks the landmark photo by its number', () => {
  const loc = square([v(1, 'exterior', 80), v(2, 'exterior', 45), v(3, 'exterior', 72)]);

  it('REGRESSION: LOC002.3 serves the photo vantage .3 cites (1), not slot 3', async () => {
    expect(await servedSlot(loc, { objects: ['LOC002.3'] }, 6)).toEqual([1]);
    expect(requested).toEqual([1]);
  });

  it('a vantage number with no matching slot is not a photo request either', async () => {
    expect(await servedSlot(loc, { objects: ['LOC002.4'] }, 12)).toEqual([1]);
  });

  it('the bracketed form in setting.location (trial writer) is read the same way', async () => {
    const meta = extractSceneMetadata(JSON.stringify({
      scene: { setting: { location: 'A Hilltop Square [LOC002.3]' }, characters: [{ name: 'Mia' }] },
    }));
    expect(meta).not.toHaveProperty('landmarkVariants');
    expect(await servedSlot(loc, meta, 6)).toEqual([1]);
  });

  it('a page view word is ignored: the citation is the whole selection', async () => {
    expect(await servedSlot(loc, { objects: ['LOC002.2'], landmarkView: 'interior' }, 3)).toEqual([2]);
  });

  it('`none` attaches nothing — the old `.0` has no meaning any more', async () => {
    const noneLoc = square([v(1, 'exterior', 80)], { 'LOC002.2': 1, 'LOC002.3': 'none', 'LOC002.4': 1 });
    expect(await servedSlot(noneLoc, { objects: ['LOC002.0'] }, 6)).toEqual([]);
  });
});

describe('servablePhotos — the one set a citation is answered from', () => {
  it('drops a photo judged below the usable cutoff, a bad one and one with no URL; keeps unjudged', () => {
    const list = servablePhotos([
      v(3, 'exterior', 72), v(1, 'exterior', 30), v(2, 'bad', 90),
      { variantNumber: 4, kind: 'interior', photoScore: null, url: null }, v(5, 'distant'),
    ]);
    expect(list.map((x: any) => x.variantNumber)).toEqual([3, 5]);
  });

  it('orders by slot, so the number shown is the slot cited', () => {
    expect(servablePhotos([v(3, 'exterior', 50), v(1, 'exterior', 90)]).map((x: any) => x.variantNumber)).toEqual([1, 3]);
  });
});

describe('variantsFromIndexRow — each slot carries its own judged score', () => {
  it('reads photo_scores by slot; an unjudged slot is null', () => {
    const vs = variantsFromIndexRow({
      id: 1,
      photo_url: 'https://x/1.jpg', photo_type: 'exterior',
      photo_url_3: 'https://x/3.jpg', photo_type_3: 'interior',
      photo_scores: { 1: 80 },
    });
    expect(vs.map((x: any) => [x.variantNumber, x.photoScore])).toEqual([[1, 80], [3, null]]);
  });
});

describe('loadLandmarkPhotoVariant — no substitute slot', () => {
  it('a slot the location does not have returns null, never another photo', async () => {
    const vb = { locations: [square([v(1, 'exterior', 80)])] };
    expect(await realLoadVariant(vb, 'LOC002', 4)).toBeNull();
  });
});
