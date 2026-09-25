/**
 * RC5 Lab arms for landmark plates (2026-09-25): how the landmark photo reaches
 * Grok. The pixel-faithful magenta prefix copies the photo's strangers and signs
 * into the plate (Lindenhof chess players on 4 plates across 3 stories), so the
 * Lab can compare two alternatives against production:
 *  - plateExtensionPrefix 'structure_only': the prefix drops the pixel-faithful
 *    clause and says the photo gives structure only;
 *  - plateRefFit 'crop': the photo is centre-cropped to the page aspect, so no
 *    pad and no prefix reach Grok.
 * Production passes neither and must stay byte-identical.
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
grok.editWithGrok = async (p: string, refs: any, opts: any) => { editCalls.push(opts); return { imageData: PX, modelId: 'grok-imagine-image', usage: {} }; };

const images = require_('../../server/lib/images');
const { emptyScenePlateRouting } = require_('../../server/config/models');

async function jpeg(w: number, h: number) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toBuffer();
}
async function dims(uri: string) {
  const m = await sharp(Buffer.from(uri.replace(/^data:image\/\w+;base64,/, ''), 'base64')).metadata();
  return { w: m.width, h: m.height };
}

describe('buildMagentaExtensionPrefix variants', () => {
  const pad = { top: 133, bottom: 134, left: 0, right: 0 };

  it('default keeps the pixel-faithful clause (production wording unchanged)', () => {
    const p = grok.buildMagentaExtensionPrefix(pad);
    expect(p).toBe(grok.buildMagentaExtensionPrefix(pad, 'default'));
    expect(p).toContain('The non-magenta center region must remain pixel-faithful in composition and geometry.');
    expect(p).toContain('133px at the TOP, 134px at the BOTTOM');
  });

  it('structure_only drops the pixel-faithful clause and says the photo gives structure only', () => {
    const p = grok.buildMagentaExtensionPrefix(pad, 'structure_only');
    expect(p).not.toContain('pixel-faithful');
    expect(p).toContain('the photo gives structure only');
    expect(p).toContain('Repaint the whole frame in the ART STYLE');
    expect(p).toContain('NO visible padding boundary');
  });

  it('an unknown variant throws', () => {
    expect(() => grok.buildMagentaExtensionPrefix(pad, 'nope')).toThrow(/unknown magenta-extension prefix variant/);
  });

  it('MAX_MAGENTA_EXTENSION_PREFIX_LENGTH covers the longest variant', () => {
    for (const v of ['default', 'structure_only']) {
      for (const p of [{ top: 99999, bottom: 99999, left: 0, right: 0 }, { top: 0, bottom: 0, left: 99999, right: 99999 }]) {
        expect(grok.buildMagentaExtensionPrefix(p, v).length).toBeLessThanOrEqual(grok.MAX_MAGENTA_EXTENSION_PREFIX_LENGTH);
      }
    }
    // The Lab variant is shorter than production's, so the plate-fit reserve
    // (and with it production plate fitting) is unchanged.
    expect(grok.MAX_MAGENTA_EXTENSION_PREFIX_LENGTH)
      .toBe(grok.buildMagentaExtensionPrefix({ top: 99999, bottom: 99999, left: 0, right: 0 }, 'default').length);
  });
});

describe('editWithGrok sends the chosen prefix', () => {
  let sentPrompt = '';
  beforeEach(async () => {
    const out = (await jpeg(1024, 1024)).toString('base64');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sentPrompt = JSON.parse(init.body).prompt;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: out }] }), text: async () => '' };
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const wide = async () => `data:image/jpeg;base64,${(await jpeg(1600, 900)).toString('base64')}`;

  it('default: the pixel-faithful prefix', async () => {
    await realEdit('BODY', [await wide()], { aspectRatio: '1:1', padInputWithExtension: true });
    expect(sentPrompt).toContain('pixel-faithful');
    expect(sentPrompt.endsWith('BODY')).toBe(true);
  }, 30000);

  it("extensionPrefix 'structure_only': the structure-only prefix", async () => {
    await realEdit('BODY', [await wide()], { aspectRatio: '1:1', padInputWithExtension: true, extensionPrefix: 'structure_only' });
    expect(sentPrompt).not.toContain('pixel-faithful');
    expect(sentPrompt).toContain('the photo gives structure only');
  }, 30000);
});

describe("packReferences plateSourceFit 'crop'", () => {
  const lm = async (w: number, h: number) => [{ name: 'Old Bridge', photoData: `data:image/jpeg;base64,${(await jpeg(w, h)).toString('base64')}` }];

  it('centre-crops a wide plate photo to the page aspect: no pad', async () => {
    const slots = await realPack({ landmarkPhotos: await lm(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1', plateSourceFit: 'crop' });
    expect(slots).toHaveLength(1);
    expect(await dims(slots[0])).toEqual({ w: 900, h: 900 });
  }, 30000);

  it('centre-crops a tall plate photo to 3:4', async () => {
    const slots = await realPack({ landmarkPhotos: await lm(900, 1600), landmarkScene: 'plate' }, { aspectRatio: '3:4', plateSourceFit: 'crop' });
    // resized to height 1024 first: 576x1024 → crop height to 576/0.75 = 768
    expect(await dims(slots[0])).toEqual({ w: 576, h: 768 });
  }, 30000);

  it('default (production) keeps the native photo for the magenta extension', async () => {
    const slots = await realPack({ landmarkPhotos: await lm(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1', padInputWithExtension: true });
    expect(await dims(slots[0])).toEqual({ w: 1600, h: 900 });
  }, 30000);

  it('crop is refused off a plate call or together with the magenta extension', async () => {
    await expect(realPack({ landmarkPhotos: await lm(1600, 900), landmarkScene: 'castless' }, { aspectRatio: '1:1', plateSourceFit: 'crop' })).rejects.toThrow(/plateSourceFit 'crop'/);
    await expect(realPack({ landmarkPhotos: await lm(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1', plateSourceFit: 'crop', padInputWithExtension: true })).rejects.toThrow(/plateSourceFit 'crop'/);
    await expect(realPack({ landmarkPhotos: await lm(1600, 900), landmarkScene: 'plate' }, { aspectRatio: '1:1', plateSourceFit: 'fit' })).rejects.toThrow(/unknown plateSourceFit/);
  }, 30000);
});

describe('the dispatcher threads the plate options to Grok', () => {
  beforeAll(() => { process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key'; });
  beforeEach(() => { packCalls = []; editCalls = []; });

  const renderPlate = (extra: any = {}) => images.generateImageOnly('**ART STYLE:** Watercolor.\n\nAn empty square.', [], {
    ...emptyScenePlateRouting(),
    landmarkPhotos: [{ name: 'Old Bridge', photoData: PX }],
    pageNumber: 1, skipCache: true, stripBorder: false, ...extra,
  });

  it('production default: magenta extension with the default prefix, pad fit', async () => {
    await renderPlate();
    expect(packCalls[0].opts).toMatchObject({ padInputWithExtension: true, plateSourceFit: 'pad' });
    expect(editCalls[0]).toMatchObject({ padInputWithExtension: true, extensionPrefix: 'default' });
  }, 30000);

  it("plateExtensionPrefix 'structure_only' reaches editWithGrok", async () => {
    await renderPlate({ plateExtensionPrefix: 'structure_only' });
    expect(packCalls[0].opts).toMatchObject({ padInputWithExtension: true, plateSourceFit: 'pad' });
    expect(editCalls[0]).toMatchObject({ padInputWithExtension: true, extensionPrefix: 'structure_only' });
  }, 30000);

  it("plateRefFit 'crop': no magenta extension, crop fit", async () => {
    await renderPlate({ plateRefFit: 'crop' });
    expect(packCalls[0].opts).toMatchObject({ padInputWithExtension: false, plateSourceFit: 'crop' });
    expect(editCalls[0]).toMatchObject({ padInputWithExtension: false, extensionPrefix: 'default' });
  }, 30000);

  it('a non-plate call with either option throws before any provider call', async () => {
    await expect(images.generateImageOnly('An empty meadow.', [], { imageBackendOverride: 'grok', pageNumber: 2, skipCache: true, plateRefFit: 'crop' }))
      .rejects.toThrow(/landmark plate calls only/);
    await expect(images.generateImageOnly('An empty meadow.', [], { imageBackendOverride: 'grok', pageNumber: 2, skipCache: true, plateExtensionPrefix: 'structure_only' }))
      .rejects.toThrow(/landmark plate calls only/);
    expect(packCalls).toHaveLength(0);
  }, 30000);

  it('the two arms cannot be combined, and unknown values throw', async () => {
    await expect(renderPlate({ plateRefFit: 'crop', plateExtensionPrefix: 'structure_only' })).rejects.toThrow(/would be ignored/);
    await expect(renderPlate({ plateRefFit: 'stretch' })).rejects.toThrow(/unknown plateRefFit/);
    await expect(renderPlate({ plateExtensionPrefix: 'loose' })).rejects.toThrow(/unknown plateExtensionPrefix/);
  }, 30000);
});
