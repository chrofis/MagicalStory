/**
 * PLATE OR FAIL FOR STORY PAGES (owner, 2026-09-24).
 *
 * A raw landmark photo is never a render's scene. The only renders allowed to
 * take it with no plate declare a role (server/lib/landmarkScene.js):
 *   'plate'     — the plate render itself (emptyScenePlateRouting marks it),
 *   'castless'  — a page with no named cast (the 2026-09-02 exemption, kept),
 *   'composite' — the composite cover route (left as it was).
 * Every other landmark page renders on its plate — in every mode, singlePassScene
 * included — and its first render, its retry, iterate and the repair / regenerate
 * paths reuse the stored plate, render one when there is none, and fail loudly
 * when that fails too. packReferences no longer promotes the photo on its own.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const landmarkScene = require_('../../server/lib/landmarkScene.js');
const images = require_('../../server/lib/images.js');
const { packReferences } = require_('../../server/lib/grok.js');
const { emptyScenePlateRouting } = require_('../../server/config/models.js');
const sharp = require_('sharp');

const LM = [{ name: 'Old town square', photoData: 'data:image/jpeg;base64,RAW' }];
const CAST = { sceneMetadata: { fullData: { characters: [{ name: 'Mia' }] } } };
const CASTLESS = { sceneMetadata: { fullData: { characters: [] } } };

const saved: Array<[any, string, any]> = [];
function patch(obj: any, key: string, value: any) { saved.push([obj, key, obj[key]]); obj[key] = value; }
afterEach(() => { while (saved.length) { const [o, k, v] = saved.pop()!; o[k] = v; } });

describe('the named cast-0 exemption', () => {
  it('a page with no named cast renders on its photo; any other landmark page needs a plate', () => {
    expect(landmarkScene.landmarkPhotoIsPageScene(CASTLESS)).toBe(true);
    expect(landmarkScene.landmarkPhotoIsPageScene(CAST)).toBe(false);
    expect(landmarkScene.pageNeedsPlate(CAST, LM)).toBe(true);
    expect(landmarkScene.pageNeedsPlate(CASTLESS, LM)).toBe(false);
    expect(landmarkScene.pageNeedsPlate(CAST, [])).toBe(false);
    expect(landmarkScene.pageLandmarkScene(CASTLESS)).toBe('castless');
    expect(landmarkScene.pageLandmarkScene(CAST)).toBeNull();
  });
});

describe('assertLandmarkScene — the one check every dispatch runs', () => {
  it('refuses a landmark photo with no plate and no role', () => {
    expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: LM, sceneBackground: null }))
      .toThrow(landmarkScene.PlateRequiredError);
  });
  it('a raw base64 "plate" is not a plate (it would never be sent)', () => {
    expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: LM, sceneBackground: 'QUJD' })).toThrow();
  });
  it('allows a plate, or one of the three declared roles', () => {
    expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: LM, sceneBackground: 'data:image/jpeg;base64,P' })).not.toThrow();
    for (const role of ['plate', 'castless', 'composite']) {
      expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: LM, landmarkScene: role })).not.toThrow();
    }
    expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: [], sceneBackground: null })).not.toThrow();
  });
  it('an unknown role is refused', () => {
    expect(() => landmarkScene.assertLandmarkScene({ landmarkPhotos: LM, landmarkScene: 'maybe' })).toThrow(/unknown landmarkScene/);
  });
  it('every plate call is marked as the plate role by its routing', () => {
    expect(emptyScenePlateRouting().landmarkScene).toBe('plate');
  });
});

describe('generateImageOnly refuses before any provider or cache', () => {
  it('a landmark page with no plate and no role throws PlateRequiredError', async () => {
    let fetched = 0;
    patch(globalThis as any, 'fetch', async () => { fetched++; throw new Error('no network in this test'); });
    await expect(images.generateImageOnly('draw', [], { landmarkPhotos: LM, pageNumber: 3 }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
    expect(fetched).toBe(0);
  });
});

describe('packReferences no longer promotes the photo on its own', () => {
  const img = async (r: number, g: number, b: number) =>
    `data:image/jpeg;base64,${(await sharp({ create: { width: 48, height: 48, channels: 3, background: { r, g, b } } }).jpeg().toBuffer()).toString('base64')}`;
  it('photo + no plate + no role → refused', async () => {
    await expect(packReferences({ landmarkPhotos: [{ name: 'x', photoData: await img(0, 0, 255) }] }, { aspectRatio: '1:1' }))
      .rejects.toThrow(/no plate and no declared role/);
  });
  it('photo + cast-0 role → the photo is the scene slot', async () => {
    const slots = await packReferences({ landmarkPhotos: [{ name: 'x', photoData: await img(0, 0, 255) }], landmarkScene: 'castless' }, { aspectRatio: '1:1' });
    expect(slots).toHaveLength(1);
  });
  it('photo + plate → only the plate', async () => {
    const slots = await packReferences({ landmarkPhotos: [{ name: 'x', photoData: await img(0, 0, 255) }], sceneBackground: await img(255, 0, 0) }, { aspectRatio: '1:1' });
    expect(slots).toHaveLength(1);
    const { data } = await sharp(Buffer.from(slots[0].split(',')[1], 'base64')).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(data[2]);
  });
});

describe('stored-page renders reuse the plate, render one, or fail', () => {
  it('ensureStoryPagePlate reuses the stored plate', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => 'data:image/jpeg;base64,STORED');
    const r = await images.ensureStoryPagePlate({ storyId: 's', storyData: {}, visualBible: null, pageNumber: 4, sceneMetadata: CAST.sceneMetadata, landmarkPhotos: LM });
    expect(r).toEqual({ sceneBackground: 'data:image/jpeg;base64,STORED', landmarkScene: null });
  });
  it('ensureStoryPagePlate fails loudly when there is no stored plate and none can be rendered', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(images.ensureStoryPagePlate({ storyId: 's', storyData: {}, visualBible: null, pageNumber: 4, sceneMetadata: CAST.sceneMetadata, landmarkPhotos: LM }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
  });
  it('a cast-0 page keeps its exemption and loads nothing', async () => {
    let loads = 0;
    patch(landmarkScene, 'loadStoredPagePlate', async () => { loads++; return null; });
    const r = await images.ensureStoryPagePlate({ storyId: 's', storyData: {}, visualBible: null, pageNumber: 4, sceneMetadata: CASTLESS.sceneMetadata, landmarkPhotos: LM });
    expect(r).toEqual({ sceneBackground: null, landmarkScene: 'castless' });
    expect(loads).toBe(0);
  });
  it('resolveRepairScene hands the page its own plate, and fails without one', async () => {
    patch(landmarkScene, 'loadStoredPagePlate', async () => null);
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: LM, plate: 'data:image/jpeg;base64,MINE' }))
      .resolves.toEqual({ sceneBackground: 'data:image/jpeg;base64,MINE', landmarkScene: null });
    await expect(landmarkScene.resolveRepairScene({ page: CAST, landmarkPhotos: LM, storyId: 's', pageNumber: 2 }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
    await expect(landmarkScene.resolveRepairScene({ page: CASTLESS, landmarkPhotos: LM }))
      .resolves.toEqual({ sceneBackground: null, landmarkScene: 'castless' });
  });
});

describe('resolveIteratePlate (iteratePageCore)', () => {
  const base = { pageNumber: 5, storyData: {}, visualBible: null, iterateSceneMetadata: CAST.sceneMetadata, pageLandmarkPhotos: LM };
  it('reuses the stored plate even under singlePassScene, with no plate render', async () => {
    let fetched = 0;
    patch(globalThis as any, 'fetch', async () => { fetched++; throw new Error('no network'); });
    const r = await images.resolveIteratePlate({
      ...base, effectiveSinglePass: true,
      emptySceneCallbacks: { load: async () => 'U1RPUkVE' /* raw base64, as the DB row holds it */ },
    });
    expect(r.sceneBackground).toBe('data:image/jpeg;base64,U1RPUkVE');
    expect(fetched).toBe(0);
  });
  it('throws when there is no plate and none can be rendered', async () => {
    await expect(images.resolveIteratePlate({ ...base, emptySceneCallbacks: { load: async () => null } }))
      .rejects.toThrow(landmarkScene.PlateRequiredError);
  });
  it('a non-landmark page keeps the single-pass behaviour', async () => {
    const r = await images.resolveIteratePlate({ ...base, pageLandmarkPhotos: [], effectiveSinglePass: true, sceneBackgroundIn: 'data:image/jpeg;base64,X' });
    expect(r.sceneBackground).toBeNull();
  });
  it('a cast-0 landmark page keeps its exemption', async () => {
    const r = await images.resolveIteratePlate({ ...base, iterateSceneMetadata: CASTLESS.sceneMetadata, effectiveSinglePass: true });
    expect(r.sceneBackground).toBeNull();
    expect(landmarkScene.pageLandmarkScene(r.iteratePageRef)).toBe('castless');
  });
});

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the pipeline page paths', () => {
  const src = read('storyJobPipeline.js');
  it('landmark pages are plated in every mode; one plate renderer serves 5a-pre and the retry', () => {
    expect(src).toContain('const platePageData = pageDataArray.filter(pd => platesOn || pageNeedsPlate(pd, pd.landmarkPhotos));');
    expect(src).toContain('return renderPagePlate(pageData);');
    expect(src).toContain('const renderedPlate = await renderPagePlate(pageData);');
  });
  it('the first render fails without a plate; the render and the retry declare the cast-0 role', () => {
    expect(src).toContain('if (pageNeedsPlate(pageData, refApplied.landmarkPhotos) && !refApplied.sceneBackground) {');
    expect((src.match(/landmarkScene: pageLandmarkScene\(pageData\),/g) || []).length).toBe(2);
  });
  it('every calm-zone repair wrapper resolves its plate (pipeline, repair pipeline, Lab mirror)', () => {
    for (const f of ['storyJobPipeline.js', 'server/lib/repairPipeline.js', 'server/lib/testlab.js']) {
      expect(read(f), f).toMatch(/const repairScene = await resolveRepairScene\(/);
    }
  });
});

describe('iterate and the regeneration routes', () => {
  const imgSrc = read('server/lib/images.js');
  it('iteratePageCore: a landmark page ignores singlePassScene, reuses or renders, else throws', () => {
    expect(imgSrc).toContain('if (effectiveSinglePass && !iterateNeedsPlate) {');
    expect(imgSrc).toContain("throw new PlateRequiredError(`ITERATE page ${pageNumber}: landmark page has no plate and none could be rendered`);");
    expect(imgSrc).toContain('landmarkScene: pageLandmarkScene(iteratePageRef),');
  });
  it('page regenerate, test-models and style-lab all go through ensureStoryPagePlate', () => {
    const r = read('server/routes/regeneration.js');
    expect((r.match(/await ensureStoryPagePlate\(/g) || []).length).toBe(3);
  });
});
