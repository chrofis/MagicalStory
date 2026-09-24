/**
 * A RAW LANDMARK PHOTO IS NEVER THE SCENE OF A RENDER (owner, 2026-09-24).
 *
 * Follow-up to trial-cover-sends-raw-landmark-photo (prod job_1790169018278_n57xpnufo).
 * Whenever a render has no plate, packReferences promotes landmarkPhotos[0]
 * into the scene slot and the model edits the photograph, people included.
 * The owner ruled: fail loudly everywhere, with two exceptions.
 *  - Every rendered cover (streaming, iterateCover from scratch, trial) is plated
 *    or fails; singlePassScene no longer applies to covers.
 *  - An EDIT of an existing cover is exempt from the plate, and sends no photo.
 *  - The COMPOSITE cover route is unchanged (plate unless singlePassScene, the
 *    raw photo stays its background input).
 *  - A trial page whose plate failed fails; it is not rendered on the photo.
 *  - Gemini's branch never attaches the raw photo beside a plate.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const coverIterate = require_('../../server/lib/coverIterate.js');
const storyHelpers = require_('../../server/lib/storyHelpers.js');
const images = require_('../../server/lib/images.js');
const referenceSheets = require_('../../server/lib/referenceSheets.js');
const { MODEL_DEFAULTS } = require_('../../server/config/models.js');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');
const sharp = require_('sharp');

beforeAll(async () => { await loadPromptTemplates(); });

const LANDMARK = { name: 'Old town square', photoData: 'data:image/jpeg;base64,RAWPHOTO', photoType: 'exterior' };
const VB = { locations: [{ id: 'LOC001', name: 'Old town square', isRealLandmark: true, pages: [1] }] };
const ARGS = {
  coverKey: 'frontCover',
  visualBible: VB,
  artStyle: 'watercolor',
  sceneDescription: 'A portrait of a single character set before Old town square.',
  coverHint: { objects: ['LOC001'] },
};

const saved: Array<[any, string, any]> = [];
function patch(obj: any, key: string, value: any) {
  saved.push([obj, key, obj[key]]);
  obj[key] = value;
}
afterEach(() => {
  while (saved.length) {
    const [obj, key, value] = saved.pop()!;
    obj[key] = value;
  }
});
function stub(plateResult: any) {
  const calls: any[] = [];
  patch(storyHelpers, 'getLandmarkPhotosForScene', async () => [LANDMARK]);
  patch(referenceSheets, 'buildEmptySceneVbGrid', async () => null);
  patch(referenceSheets, 'buildVisualBibleGrid', async (_els: any, lms: any[]) => (lms?.length ? Buffer.from('grid') : null));
  patch(images, 'generateImageOnly', async (...a: any[]) => {
    calls.push(a);
    if (plateResult instanceof Error) throw plateResult;
    return plateResult;
  });
  return calls;
}

describe('buildCoverReferences use modes', () => {
  it("'render' (the default) plates even with singlePassScene on", async () => {
    patch(MODEL_DEFAULTS, 'singlePassScene', true);
    const calls = stub({ imageData: 'data:image/jpeg;base64,PLATE' });
    const refs = await coverIterate.buildCoverReferences(ARGS);
    expect(calls).toHaveLength(1);
    expect(refs.sceneBackground).toBe('data:image/jpeg;base64,PLATE');
  });

  it("'render' with a failed plate throws — no raw-photo render", async () => {
    stub(new Error('grok 500'));
    await expect(coverIterate.buildCoverReferences(ARGS)).rejects.toThrow(/no people-free plate/);
  });

  it("'render' with no landmark and a failed plate still returns (no photo at stake)", async () => {
    stub(new Error('grok 500'));
    patch(storyHelpers, 'getLandmarkPhotosForScene', async () => []);
    const refs = await coverIterate.buildCoverReferences(ARGS);
    expect(refs.sceneBackground).toBeNull();
    expect(refs.landmarkPhotos).toEqual([]);
  });

  it("'edit' renders no plate and returns no landmark photo (not even a grid cell)", async () => {
    const calls = stub({ imageData: 'data:image/jpeg;base64,PLATE' });
    patch(storyHelpers, 'getLandmarkPhotosForScene', async () => [LANDMARK, { ...LANDMARK, name: 'Second' }]);
    const refs = await coverIterate.buildCoverReferences({ ...ARGS, use: 'edit' });
    expect(calls).toHaveLength(0);
    expect(refs.sceneBackground).toBeNull();
    expect(refs.landmarkPhotos).toEqual([]);
    expect(refs.visualBibleGrid).toBeNull();
  });

  it("'composite' keeps singlePassScene and the raw photo", async () => {
    patch(MODEL_DEFAULTS, 'singlePassScene', true);
    const calls = stub({ imageData: 'data:image/jpeg;base64,PLATE' });
    const refs = await coverIterate.buildCoverReferences({ ...ARGS, use: 'composite' });
    expect(calls).toHaveLength(0);
    expect(refs.sceneBackground).toBeNull();
    expect(refs.landmarkPhotos).toEqual([LANDMARK]);
  });

  it('an unknown use is refused', async () => {
    await expect(coverIterate.buildCoverReferences({ ...ARGS, use: 'maybe' })).rejects.toThrow(/unknown use/);
  });
});

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('every cover caller picks its use', () => {
  it('iterateCover: composite route → composite, an edit → edit, else render; the gate is decided first', () => {
    const src = read('server/lib/coverIterate.js');
    const gate = src.indexOf('const compositeOn = options.compositeCovers === false');
    const call = src.indexOf("use: compositeOn ? 'composite' : (previousImage ? 'edit' : 'render'),");
    expect(gate).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(gate);
  });

  it('the streaming cover renders (no singlePassScene skip, no use override)', () => {
    const src = read('storyJobPipeline.js');
    const start = src.indexOf('const startCoverGeneration = (coverType, hint) => {');
    const site = src.slice(start, src.indexOf('streamingCoverPromises.set(coverType, coverPromise);', start));
    expect(site).toContain('buildCoverReferences({');
    expect(site).not.toContain('skipEmptyScene');
    expect(site).not.toContain('use:');
    expect(site).toContain('sceneBackground: coverSceneBackground');
  });

  it("the regeneration scene-composite route is 'composite'", () => {
    const src = read('server/routes/regeneration.js');
    const at = src.indexOf('TEST-MODELS`,');
    expect(src.slice(at, at + 400)).toContain("use: 'composite'");
  });
});

describe('a trial page never renders on the raw photo', () => {
  const src = read('storyJobPipeline.js');
  it('the "rendering without it" path is gone', () => {
    expect(src).not.toContain('unavailable (rendering without it)');
  });
  it('a failed plate and a landmark-without-plate both throw', () => {
    expect(src).toContain('throw new Error(`page ${page.pageNumber} plate failed`)');
    expect(src).toContain('throw new Error(`page ${page.pageNumber} has a landmark photo and no plate`)');
  });
});

describe("Gemini's branch", () => {
  it('attaches no raw landmark photo beside a plate', async () => {
    const png = (await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer()).toString('base64');
    const bodies: any[] = [];
    patch(process.env as any, 'GEMINI_API_KEY', 'test-key');
    const realFetch = globalThis.fetch;
    patch(globalThis as any, 'fetch', async (url: any, init: any) => {
      if (String(url).includes('generativelanguage')) {
        bodies.push(JSON.parse(init.body));
        throw new Error('stop after capture');
      }
      return realFetch(url, init);
    });
    const run = (sceneBackground: string | null) => images.generateImageOnly('draw it', [], {
      imageModelOverride: 'gemini-2.5-flash-image',
      imageBackendOverride: 'gemini',
      landmarkPhotos: [{ name: 'Old town square', photoData: `data:image/png;base64,${png}` }],
      sceneBackground,
      skipCache: true,
      aspectRatio: '3:4',
      pageNumber: 1,
    }).catch(() => null);
    await run(`data:image/png;base64,${png}`);
    await run(null);
    const labels = (b: any) => (b?.contents?.[0]?.parts || []).map((p: any) => p.text).filter(Boolean).join('|');
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(labels(bodies[0])).toContain('[Background]');
    expect(labels(bodies[0])).not.toContain('(landmark)');
    expect(labels(bodies[bodies.length - 1])).toContain('(landmark)');
  });
});
