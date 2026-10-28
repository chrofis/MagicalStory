/**
/**
 * Print page strip fill (server/lib/pageFill.js, decisions.md 2026-10-26): the strip under
 * the picture is the mirrored, blurred, lightened lower half of the picture. No board:
 * the text outline is drawn by pdf.js.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');

const W = 425, H = 550, IH = 400;

// Picture: a vertical colour gradient plus noise-free blocks, solid dark or bright.
async function picture(kind: 'dark' | 'bright') {
  const base = kind === 'dark' ? { r: 0, g: 0, b: 0 } : { r: 235, g: 225, b: 200 };
  return sharp({ create: { width: 600, height: 560, channels: 3, background: base } })
    .composite([{ input: Buffer.from('<svg width="200" height="200"><rect width="200" height="200" fill="#c03030"/></svg>'), left: 200, top: 340 }])
    .png().toBuffer();
}

async function raw(buf: Buffer) {
  const r = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return r;
}
const lum = (d: Buffer, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

describe('buildFilledPageBackground', () => {
  it('returns a raster with exactly the page size', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    const meta = await sharp(r.buffer).metadata();
    expect([meta.width, meta.height]).toEqual([W, H]);
  });

  it('fills the strip with picture colour, not white (not white)', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    const { data } = await raw(r.buffer);
    // bottom-left corner of the strip, corner of the strip
    const l = lum(data, ((H - 4) * W + 4) * 3);
    expect(l).toBeLessThan(0.6);
    expect(l).toBeGreaterThan(0.2); // lightened towards white, not black
  });

  it('feathers the seam: no hard step between picture and strip', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    const { data } = await raw(r.buffer);
    let maxStep = 0;
    for (let y = IH - 40; y < IH + 40; y++) {
      const a = lum(data, (y * W + 5) * 3), b = lum(data, ((y + 1) * W + 5) * 3);
      maxStep = Math.max(maxStep, Math.abs(a - b));
    }
    expect(maxStep).toBeLessThan(0.03);
  });

  it('draws nothing on the strip: no white board under where the text goes', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    const { data } = await raw(r.buffer);
    // centre of the strip on a black picture stays the lightened dark fill (35% towards white), far from white
    const l = lum(data, (475 * W + 400) * 3);
    expect(l).toBeLessThan(0.5);
    expect(l).toBeGreaterThan(0.2);
  });

  it('returns only the raster', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('bright'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' });
    expect(Object.keys(r)).toEqual(['buffer']);
  });

  it('throws instead of falling back when the picture is unreadable or the strip is missing', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: Buffer.from('not an image'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'mirror' })).rejects.toThrow();
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: H, fillMethod: 'mirror' })).rejects.toThrow(/no strip/);
  });
});

// ---------------------------------------------------------------------------------------------
// Grok fill (decisions.md 2026-10-26, "Print PDF strip is outpainted by Grok"). The Grok call is
// stubbed through options.editFn: no network, no cost.
// ---------------------------------------------------------------------------------------------
import { beforeAll, afterEach, vi } from 'vitest';
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');

// A model answer whose UPPER area is red garbage (the model redraws the whole frame) and whose strip is green.
const seen: { opts?: any } = {};
function redTopGreenStrip(ih: number) {
  return async (_prompt: string, refs: string[], opts: any) => {
    const meta = await sharp(Buffer.from(refs[0].split(',')[1], 'base64')).metadata();
    const w = meta.width, h = meta.height, hih = Math.round(ih * h / H);
    const png = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 0, b: 0 } } })
      .composite([{ input: { create: { width: w, height: h - hih, channels: 3, background: { r: 0, g: 200, b: 0 } } }, left: 0, top: hih }])
      .png().toBuffer();
    seen.opts = opts;
    return { imageData: 'data:image/png;base64,' + png.toString('base64') };
  };
}

describe('buildFilledPageBackground, fillMethod grok', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('keeps the original picture on top, takes only the model strip, and feathers the seam', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'grok', editFn: redTopGreenStrip(IH) });
    expect(r.usedGrok).toBe(true);
    const { data, info } = await raw(r.buffer);
    expect(info.width).toBe(W); expect(info.height).toBe(H);
    const px = (x: number, y: number) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
    // upper area = the original dark picture, not the model's red
    expect(px(50, 50)[0]).toBeLessThan(25);
    // the model's strip (green) well below the seam
    const strip = px(50, H - 40);
    expect(strip[1]).toBeGreaterThan(150); expect(strip[0]).toBeLessThan(40);
    // seam: the feather is 30 reference px = 15 rows at this width; above it is still the original, mid-feather is a mixture, the last row is mostly the strip
    // (the feather blends the original with the model's own frame rows, red here, so the red channel shows it)
    expect(px(50, IH - 20)[0]).toBeLessThan(25);
    const mid = px(50, IH - 8)[0];
    expect(mid).toBeGreaterThan(30); expect(mid).toBeLessThan(170);
    expect(px(50, IH - 1)[0]).toBeGreaterThan(mid);
  });

  it('calls the model with the pinned model, aspect and no output crop', async () => {
    await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'grok', editFn: redTopGreenStrip(IH) });
    expect(seen.opts.model).toBe('grok-imagine-image');
    expect(seen.opts.skipOutputCrop).toBe(true);
    expect(seen.opts.aspectRatio).toBe('3:4');
  });

  it('throws when the Grok call throws (no mirror fallback)', async () => {
    const editFn = async () => { throw new Error('xai 503'); };
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'grok', editFn })).rejects.toThrow(/xai 503/);
  });

  it('requires fillMethod: no silent default', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH } as any)).rejects.toThrow(/fillMethod/);
    await expect(buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'other' } as any)).rejects.toThrow(/fillMethod/);
  });
});

// ---------------------------------------------------------------------------------------------
// pdf.js routing: view/trial PDFs stay on the mirror, the order PDF takes the Grok fill with throttled starts, all in flight together.
// ---------------------------------------------------------------------------------------------
describe('pdf.js strip fill routing', () => {
  const pageFill = cjs('../../server/lib/pageFill.js');
  const { generateViewPdf, generatePrintPdf } = cjs('../../server/lib/pdf.js');
  afterEach(() => vi.restoreAllMocks());

  async function story(pages: number) {
    const scene = 'data:image/png;base64,' + (await sharp({ create: { width: 800, height: 800, channels: 3, background: '#80a0c0' } }).png().toBuffer()).toString('base64');
    const cover = 'data:image/png;base64,' + (await sharp({ create: { width: 800, height: 1067, channels: 3, background: '#c08080' } }).png().toBuffer()).toString('base64');
    return {
      title: 'T', languageLevel: 'standard',
      storyText: Array.from({ length: pages }, (_, i) => `--- Page ${i + 1} ---\n\nText of page ${i + 1} in the strip.`).join('\n\n'),
      coverImages: { frontCover: cover, initialPage: cover, backCover: cover },
      sceneImages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, imageData: scene, textInImage: false })),
    };
  }

  it('generateViewPdf never takes the grok path', async () => {
    const real = pageFill.buildFilledPageBackground;
    const spy = vi.spyOn(pageFill, 'buildFilledPageBackground').mockImplementation((a: any) => real(a));
    const grok = cjs('../../server/lib/grok.js');
    const edit = vi.spyOn(grok, 'editWithGrok');
    await generateViewPdf(await story(2), 'A4', { trialLayout: true });
    await generateViewPdf(await story(2), 'A4');
    expect(spy).toHaveBeenCalled();
    for (const [a] of spy.mock.calls) expect((a as any).fillMethod).toBe('mirror');
    expect(edit).not.toHaveBeenCalled();
  }, 60000);

  it('generatePrintPdf requires options.fillMethod', async () => {
    await expect(generatePrintPdf(await story(1), 'A4', {})).rejects.toThrow(/fillMethod/);
  });

  it('grok: one call per picture page, calls overlap (no small pool), calls are counted', async () => {
    const real = pageFill.buildFilledPageBackground;
    let inflight = 0, peak = 0;
    vi.spyOn(pageFill, 'buildFilledPageBackground').mockImplementation(async (a: any) => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 450));   // longer than the 200 ms start interval, so calls overlap
      inflight--;
      const out = await real({ ...a, fillMethod: 'mirror' });
      return { buffer: out.buffer, usedGrok: true };
    });
    const fillStats = { grokCalls: 0 };
    const { pageCount } = await generatePrintPdf(await story(9), 'A4', { fillMethod: 'grok', fillStats });
    expect(fillStats.grokCalls).toBe(9);
    expect(peak).toBeGreaterThan(2);
    expect(pageCount).toBeGreaterThan(9);
  }, 60000);

  it('grok: a failing call fails the whole PDF and stops starting new calls', async () => {
    let calls = 0;
    vi.spyOn(pageFill, 'buildFilledPageBackground').mockImplementation(async () => { calls++; await new Promise(r => setTimeout(r, 20)); throw new Error('xai down'); });
    await expect(generatePrintPdf(await story(12), 'A4', { fillMethod: 'grok', fillStats: { grokCalls: 0 } })).rejects.toThrow(/xai down/);
    expect(calls).toBeLessThan(12);
  }, 60000);
});

describe('Grok fill, edge top', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  it('sends an upright canvas with the hint above, keeps the original picture below, prompt says upward', async () => {
    let prompt = '';
    const editFn = async (p: string, refs: string[]) => {
      prompt = p;
      const meta = await sharp(Buffer.from(refs[0].split(',')[1], 'base64')).metadata();
      const png = await sharp({ create: { width: meta.width, height: meta.height, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer();
      return { imageData: 'data:image/png;base64,' + png.toString('base64') };
    };
    const r = await buildFilledPageBackground({ imageBuffer: await picture('dark'), pageWidthPx: W, pageHeightPx: H, imageHeightPx: IH, fillMethod: 'grok', edge: 'top', editFn });
    expect(prompt).toContain('upward');
    expect(prompt).not.toContain('{DIRECTION}');
    const { data } = await raw(r.buffer);
    const px = (x: number, y: number) => { const i = (y * W + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
    expect(px(50, 20)[1]).toBeGreaterThan(150);          // the model's strip, at the top
    expect(px(50, H - 40)[0]).toBeLessThan(25);          // original dark picture at the bottom
  });
});
