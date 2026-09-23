/**
 * THE TRIAL FRONT COVER IS RENDERED ON A PEOPLE-FREE PLATE, NEVER ON THE RAW
 * LANDMARK PHOTOGRAPH.
 *
 * Prod trial job_1790169018278_n57xpnufo: the cover's packed slot 0 was the
 * raw Wikimedia photo of its landmark (a silhouette artist cutting a
 * customer's profile) and the cover painted those two men beside the child.
 * The trial cover handed the photo to generateImageOnly with no plate, and
 * packReferences promotes landmarkPhotos[0] to the scene slot whenever there
 * is no plate. Trial pages and the full-account cover always sent a plate.
 *
 * Fix: the trial cover goes through buildCoverReferences (the full-account
 * helper) with the trial pages' plate for its location, and requirePlate —
 * a landmark with no plate throws instead of reaching the render.
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
const { packReferences } = require_('../../server/lib/grok.js');
const sharp = require_('sharp');
const { loadPromptTemplates } = require_('../../server/services/prompts.js');

beforeAll(async () => { await loadPromptTemplates(); });

const LANDMARK = { name: 'Cathedral square', photoData: 'data:image/jpeg;base64,RAWPHOTO', photoType: 'exterior' };
const PLATE = 'data:image/jpeg;base64,PAGEPLATE';
const VB = { locations: [{ id: 'LOC001', name: 'Cathedral square', isRealLandmark: true, pages: [1, 2] }] };
// Real trial cover-scene shape (prompts/story-trial.txt COVER SCENE).
const COVER_SCENE = {
  imageSummary: 'Mia stands proudly in the middle of the square.',
  setting: {
    location: 'Cathedral square [LOC001]',
    indoorOutdoor: 'outdoor',
    description: 'Wide cobbled square before the twin-towered facade',
    lighting: 'golden afternoon light',
    weather: 'clear',
    camera: 'wide',
    depthLayers: 'cobbles foreground; Mia in the middle holding the lantern; facade background',
  },
  characters: [{ id: null, name: 'Mia', position: 'center', action: 'waving', clothing: 'costumed' }],
  objects: [{ id: 'LOC001', name: 'Cathedral square', position: 'background' }],
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

function stubRefs({ plateResult }: { plateResult: any }) {
  const plateCalls: any[] = [];
  patch(storyHelpers, 'getLandmarkPhotosForScene', async () => [LANDMARK]);
  patch(referenceSheets, 'buildEmptySceneVbGrid', async () => null);
  patch(referenceSheets, 'buildVisualBibleGrid', async () => null);
  patch(images, 'generateImageOnly', async (prompt: string, photos: any[], opts: any) => {
    plateCalls.push({ prompt, photos, opts });
    if (plateResult instanceof Error) throw plateResult;
    return plateResult;
  });
  return plateCalls;
}

const baseArgs = {
  coverKey: 'frontCover',
  visualBible: VB,
  artStyle: 'watercolor',
  sceneDescription: '```json\n' + JSON.stringify(COVER_SCENE) + '\n```',
  coverHint: { objects: ['LOC001'], characters: ['Mia'] },
  sceneMetadata: { objects: COVER_SCENE.objects, fullData: COVER_SCENE, characters: COVER_SCENE.characters },
  emptyScenePromptOverride: coverIterate.trialCoverPlateDescription(COVER_SCENE),
  requirePlate: true,
};

describe('buildCoverReferences with a trial plate', () => {
  it('reuses the given page plate and renders no second plate', async () => {
    const calls = stubRefs({ plateResult: { imageData: 'data:image/jpeg;base64,NEW' } });
    const refs = await coverIterate.buildCoverReferences({ ...baseArgs, sceneBackground: PLATE });
    expect(refs.sceneBackground).toBe(PLATE);
    expect(calls).toHaveLength(0);
    expect(refs.landmarkPhotos).toEqual([LANDMARK]);
  });

  it('renders a people-free cover plate from the landmark when no page plate exists', async () => {
    const calls = stubRefs({ plateResult: { imageData: 'data:image/jpeg;base64,COVERPLATE' } });
    const refs = await coverIterate.buildCoverReferences({ ...baseArgs, sceneBackground: null });
    expect(refs.sceneBackground).toBe('data:image/jpeg;base64,COVERPLATE');
    expect(calls).toHaveLength(1);
    expect(calls[0].photos).toEqual([]); // no character refs on a plate
    expect(calls[0].opts.landmarkPhotos).toEqual([LANDMARK]);
    expect(calls[0].prompt).not.toContain('Mia');
  });

  it('plates even when singlePassScene is on', async () => {
    patch(MODEL_DEFAULTS, 'singlePassScene', true);
    const calls = stubRefs({ plateResult: { imageData: 'data:image/jpeg;base64,COVERPLATE' } });
    const refs = await coverIterate.buildCoverReferences({ ...baseArgs, sceneBackground: null });
    expect(calls).toHaveLength(1);
    expect(refs.sceneBackground).toBe('data:image/jpeg;base64,COVERPLATE');
  });

  it('throws instead of handing back the raw photo when the plate fails', async () => {
    stubRefs({ plateResult: new Error('grok 500') });
    await expect(coverIterate.buildCoverReferences({ ...baseArgs, sceneBackground: null }))
      .rejects.toThrow(/no people-free plate/);
  });

  it('without requirePlate a failed plate still returns (full-account behaviour unchanged)', async () => {
    stubRefs({ plateResult: new Error('grok 500') });
    const refs = await coverIterate.buildCoverReferences({ ...baseArgs, sceneBackground: null, requirePlate: false });
    expect(refs.sceneBackground).toBeNull();
  });
});

describe('trial cover scene helpers', () => {
  it('finds the cover LOC in setting.location, then objects', () => {
    expect(coverIterate.trialCoverLocationId(COVER_SCENE)).toBe('LOC001');
    expect(coverIterate.trialCoverLocationId({ setting: { location: 'Somewhere' }, objects: [{ id: 'loc002' }] })).toBe('LOC002');
    expect(coverIterate.trialCoverLocationId({ objects: ['Old bridge [LOC003]'] })).toBe('LOC003');
    expect(coverIterate.trialCoverLocationId({ setting: {}, objects: [{ id: 'ART001' }] })).toBeNull();
  });

  it('the plate description is the setting only — no figure, no summary', () => {
    const d = coverIterate.trialCoverPlateDescription(COVER_SCENE);
    expect(d).toContain('Wide cobbled square');
    expect(d).toContain('golden afternoon light');
    expect(d).not.toContain('Mia');
    expect(d).not.toContain('waving');
    expect(d).not.toContain('lantern'); // depthLayers places the figures
  });
});

describe('what reaches Grok', () => {
  it('with a plate, slot 0 is the plate and the landmark photo is not packed', async () => {
    const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 0, b: 0 } } }).jpeg().toBuffer();
    const blue = await sharp({ create: { width: 80, height: 45, channels: 3, background: { r: 0, g: 0, b: 255 } } }).jpeg().toBuffer();
    const slots = await packReferences(
      { sceneBackground: `data:image/jpeg;base64,${red.toString('base64')}`, landmarkPhotos: [{ name: 'x', photoData: `data:image/jpeg;base64,${blue.toString('base64')}` }] },
      { aspectRatio: '3:4' },
    );
    expect(slots).toHaveLength(1);
    const { data } = await sharp(Buffer.from(slots[0].split(',')[1], 'base64')).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(data[2]); // red plate, not the blue photo
  });
});

describe('the trial cover call site', () => {
  const pipeline = fs.readFileSync(path.join(process.cwd(), 'storyJobPipeline.js'), 'utf8');
  const start = pipeline.indexOf('onCoverScene: (coverData) => {');
  const end = pipeline.indexOf('onCoverHints:', start);
  const site = pipeline.slice(start, end);

  it('uses the shared cover helper with the page plate and requirePlate', () => {
    expect(site).toContain('buildCoverReferences: buildTrialCoverReferences');
    expect(site).toContain('trialPlatesByLoc.get(coverLocId)');
    expect(site).toContain('sceneBackground: reusedPlate');
    expect(site).toContain('requirePlate: true');
    expect(site).toContain('sceneBackground: coverSceneBackground');
  });

  it('no longer resolves the raw landmark photo itself', () => {
    expect(site).not.toContain('getLandmarkPhotosForScene(');
  });
});
