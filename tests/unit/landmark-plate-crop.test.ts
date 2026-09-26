/**
 * A landmark photo that a PLATE renders from (landmarkScene 'plate') is
 * centre-cropped to the plate aspect: no magenta padding, no magenta prefix
 * (owner, 2026-09-26, reversing decisions.md 2026-06-16 for landmark plates).
 * The prefix's "pixel-faithful centre" made plates trace the photo, strangers
 * and signs included (Lab 1485-1487, 1507-1511).
 *
 * Magenta extension stays for every other slot-0 scene input: a page render
 * editing onto a plate or a previous image, and a cast-0 page anchored on its
 * landmark photo.
 *
 * Only the network boundary is stubbed. No paid call is made.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require_ = createRequire(import.meta.url);
// Read at grok.js module load.
process.env.XAI_API_KEY = process.env.XAI_API_KEY || 'test-key-not-a-real-credential';

const grok = require_('../../server/lib/grok');
const realEdit = grok.editWithGrok;
const realPack = grok.packReferences;

// images.js destructures these at require time: stub them first to capture
// what the dispatcher threads through.
const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let packCalls: any[] = [];
let editCalls: any[] = [];
grok.isGrokConfigured = () => true;
grok.packReferences = async (refs: any, opts: any) => { packCalls.push({ refs, opts }); return [PX]; };
grok.generateWithGrok = async () => { throw new Error('generate not expected'); };
grok.editWithGrok = async (p: string, refs: any, opts: any) => { editCalls.push({ prompt: p, opts }); return { imageData: PX, modelId: 'grok-imagine-image', usage: {} }; };

const images = require_('../../server/lib/images');
const { emptyScenePlateRouting } = require_('../../server/config/models');

async function jpeg(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
}
async function dims(uri: string) {
  const m = await sharp(Buffer.from(uri.replace(/^data:image\/\w+;base64,/, ''), 'base64')).metadata();
  return { w: m.width, h: m.height };
}
const photo = async (w: number, h: number) => [{ name: 'Old Bridge', photoData: `data:image/jpeg;base64,${(await jpeg(w, h)).toString('base64')}` }];

describe('packReferences: a plate call centre-crops its landmark photo', () => {
  it('a wide photo is cropped to a square page: no pad', async () => {
    const slots = await realPack({ landmarkPhotos: await photo(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1' });
    expect(slots).toHaveLength(1);
    expect(await dims(slots[0])).toEqual({ w: 900, h: 900 });
  }, 30000);

  it('a tall photo is cropped to 3:4', async () => {
    const slots = await realPack({ landmarkPhotos: await photo(900, 1600), landmarkScene: 'plate' }, { aspectRatio: '3:4' });
    // resized to height 1024 first: 576x1024 → crop height to 576/0.75 = 768
    expect(await dims(slots[0])).toEqual({ w: 576, h: 768 });
  }, 30000);

  it('a plate call with the magenta extension on is refused', async () => {
    await expect(realPack({ landmarkPhotos: await photo(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1', padInputWithExtension: true }))
      .rejects.toThrow(/never magenta-extended/);
  }, 30000);

  it('a cast-0 page keeps its landmark photo at native aspect for the magenta extension', async () => {
    const slots = await realPack({ landmarkPhotos: await photo(1600, 900), landmarkScene: 'castless' }, { aspectRatio: '1:1', padInputWithExtension: true });
    expect(await dims(slots[0])).toEqual({ w: 1600, h: 900 });
  }, 30000);
});

describe('pack + edit: a cropped plate photo reaches Grok with no magenta prefix', () => {
  let sentPrompt = '';
  beforeEach(async () => {
    const out = (await jpeg(1024, 1024)).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sentPrompt = JSON.parse(init.body).prompt;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: out }] }), text: async () => '' };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the prompt sent is the prompt given', async () => {
    const slots = await realPack({ landmarkPhotos: await photo(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1' });
    await realEdit('BODY', slots, { aspectRatio: '1:1', padInputWithExtension: false });
    expect(sentPrompt).toBe('BODY');
  }, 30000);

  it('a padded slot 0 (every other scene input) still gets the magenta prefix', async () => {
    const wide = `data:image/jpeg;base64,${(await jpeg(1600, 900)).toString('base64')}`;
    await realEdit('BODY', [wide], { aspectRatio: '1:1', padInputWithExtension: true });
    expect(sentPrompt).toContain('SOLID BRIGHT MAGENTA');
    expect(sentPrompt).toContain('The non-magenta center region must remain pixel-faithful');
    expect(sentPrompt.endsWith('BODY')).toBe(true);
  }, 30000);
});

describe('the dispatcher', () => {
  beforeAll(() => { process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'; });
  beforeEach(() => { packCalls = []; editCalls = []; });

  it('a landmark plate: no magenta extension to packReferences or editWithGrok', async () => {
    await images.generateImageOnly('**ART STYLE:** Watercolor.\n\nAn empty square.', [], {
      ...emptyScenePlateRouting(),
      landmarkPhotos: [{ name: 'Old Bridge', photoData: PX }],
      pageNumber: 1, skipCache: true, stripBorder: false,
    });
    expect(packCalls[0].refs.landmarkScene).toBe('plate');
    expect(packCalls[0].opts.padInputWithExtension).toBe(false);
    expect(editCalls[0].opts.padInputWithExtension).toBe(false);
  }, 30000);

  it('a page render on a plate keeps the magenta extension', async () => {
    await images.generateImageOnly('**THIS IMAGE DEPICTS:** A child on a bridge.', [], {
      imageBackendOverride: 'grok', sceneBackground: PX, pageNumber: 2, skipCache: true, stripBorder: false,
    });
    expect(packCalls[0].opts.padInputWithExtension).toBe(true);
    expect(editCalls[0].opts.padInputWithExtension).toBe(true);
  }, 30000);

  it('a cast-0 page on its landmark photo keeps the magenta extension', async () => {
    await images.generateImageOnly('**THIS IMAGE DEPICTS:** An empty bridge at dusk.', [], {
      imageBackendOverride: 'grok', landmarkScene: 'castless',
      landmarkPhotos: [{ name: 'Old Bridge', photoData: PX }],
      pageNumber: 3, skipCache: true, stripBorder: false,
    });
    expect(packCalls[0].opts.padInputWithExtension).toBe(true);
    expect(editCalls[0].opts.padInputWithExtension).toBe(true);
  }, 30000);
});
