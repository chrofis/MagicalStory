/**
 * SQUARE COVERS for square books (docs/decisions.md 2026-10-28 "Square covers").
 * Pins: the bar validator (clean square passes; white bar, magenta bar and non-square fail), the PDF square
 * path (draws the square versions, throws when one is missing, A4 untouched), and ensureSquareCovers
 * (reuses a stored square, calls Grok only for the missing ones, rejects a result with bars, no fallback).
 * Grok and R2 are mocked: no paid call, no network.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const cjs = createRequire(import.meta.url);
const SC = cjs('../../server/lib/squareCovers.js');
const r2 = cjs('../../server/lib/r2.js');
const pdf = cjs('../../server/lib/pdf.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = cjs('../../server/services/prompts.js');

const solid = (w: number, h: number, c: any) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
// A picture with some texture so it is not all one colour: a blue-green gradient look made of two bands.
async function art(size: number) {
  const left = await solid(size, size, { r: 40, g: 110, b: 160 });
  const patch = await solid(Math.round(size / 2), Math.round(size / 2), { r: 200, g: 120, b: 40 });
  return sharp(left).composite([{ input: patch, left: Math.round(size / 4), top: Math.round(size / 4) }]).png().toBuffer();
}
async function withBar(side: 'left' | 'top', colour: any, size = 400) {
  const bar = await solid(side === 'left' ? 60 : size, side === 'left' ? size : 60, colour);
  return sharp(await art(size)).composite([{ input: bar, left: 0, top: 0 }]).png().toBuffer();
}
const uri = (b: Buffer) => 'data:image/png;base64,' + b.toString('base64');

describe('measureSquareCover', () => {
  it('passes a clean square', async () => {
    expect((await SC.measureSquareCover(await art(400))).ok).toBe(true);
  });
  it('fails a white bar', async () => {
    const m = await SC.measureSquareCover(await withBar('left', { r: 255, g: 255, b: 255 }));
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/left.*white/);
  });
  it('fails a magenta bar', async () => {
    const m = await SC.measureSquareCover(await withBar('top', { r: 255, g: 0, b: 255 }));
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/magenta/);
  });
  it('fails a picture that is not square', async () => {
    const m = await SC.measureSquareCover(await solid(300, 400, { r: 40, g: 110, b: 160 }));
    expect(m.ok).toBe(false);
    expect(m.reason).toMatch(/not square/);
  });
  it('assertSquareCoverClean throws loudly on bars', async () => {
    await expect(SC.assertSquareCoverClean(await withBar('left', { r: 255, g: 255, b: 255 }), 'x')).rejects.toThrow(/rejected/);
  });
});

describe('pdf.js square cover path', () => {
  afterEach(() => vi.restoreAllMocks());
  async function story(pages: number, squareCovers?: Record<string, string>) {
    const scene = uri(await solid(800, 800, { r: 128, g: 160, b: 192 }));
    const cover = uri(await solid(800, 1067, { r: 192, g: 128, b: 128 }));
    return {
      id: 's1', title: 'T', languageLevel: 'standard',
      storyText: Array.from({ length: pages }, (_, i) => `--- Page ${i + 1} ---\n\nText of page ${i + 1}.`).join('\n\n'),
      coverImages: { frontCover: cover, initialPage: cover, backCover: cover },
      sceneImages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, imageData: scene, textInImage: false })),
      ...(squareCovers ? { squareCovers } : {}),
    };
  }

  it('printCoverSource: square book takes the square version, A4 the original', async () => {
    const s: any = await story(1, { frontCover: 'SQ-FRONT' });
    expect(pdf.printCoverSource(s, 'frontCover', 'square')).toBe('SQ-FRONT');
    expect(pdf.printCoverSource(s, 'frontCover', 'A4')).toBe(s.coverImages.frontCover);
  });
  it('printCoverSource: square book without the square version throws, no crop fallback', async () => {
    const s: any = await story(1, { frontCover: 'SQ-FRONT' });
    expect(() => pdf.printCoverSource(s, 'backCover', 'square')).toThrow(/square backCover/);
  });
  it('printCoverSource: a story without that cover is not an error', async () => {
    const s: any = await story(1);
    delete s.coverImages.initialPage;
    expect(pdf.printCoverSource(s, 'initialPage', 'square')).toBeUndefined();
  });

  it('generatePrintPdf square: fetches and draws the square versions, never the portrait originals', async () => {
    const sqBuf = await art(600);
    const urls = { frontCover: 'https://img.test/f.jpg', backCover: 'https://img.test/b.jpg', initialPage: 'https://img.test/d.jpg' };
    const s: any = await story(2, urls);
    vi.spyOn(r2, 'keyFromPublicUrl').mockImplementation((u: string) => (String(u).startsWith('https://img.test/') ? 'k' : null));
    const fetched = vi.spyOn(r2, 'fetchImageBytes').mockResolvedValue(sqBuf);
    const { pdfBuffer } = await pdf.generatePrintPdf(s, 'square', { fillMethod: 'mirror' });
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    expect(fetched.mock.calls.map(c => c[0]).sort()).toEqual(Object.values(urls).sort());
  }, 60000);

  it('generatePrintPdf square: throws when a square cover is missing', async () => {
    const sq = uri(await art(600));
    const s: any = await story(2, { frontCover: sq, initialPage: sq });
    await expect(pdf.generatePrintPdf(s, 'square', { fillMethod: 'mirror' })).rejects.toThrow(/square backCover/);
  }, 60000);

  it('generatePrintPdf A4: unchanged, needs no square covers', async () => {
    const s: any = await story(2);
    const { pdfBuffer } = await pdf.generatePrintPdf(s, 'A4', { fillMethod: 'mirror' });
    expect(pdfBuffer.length).toBeGreaterThan(1000);
  }, 60000);

  it('generateCombinedBookPdf square: throws when a square cover is missing, passes when present', async () => {
    const sq = uri(await art(600));
    const a: any = await story(2, { frontCover: sq, backCover: sq, initialPage: sq });
    const b: any = await story(2, { frontCover: sq, initialPage: sq });
    await expect(pdf.generateCombinedBookPdf([{ id: 'a', data: a }, { id: 'b', data: b }], 'square', { fillMethod: 'mirror' })).rejects.toThrow(/square backCover/);
    b.squareCovers.backCover = sq;
    const out = await pdf.generateCombinedBookPdf([{ id: 'a', data: a }, { id: 'b', data: b }], 'square', { fillMethod: 'mirror' });
    expect(out.pdfBuffer.length).toBeGreaterThan(1000);
  }, 60000);
});

describe('ensureSquareCovers', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  afterEach(() => vi.restoreAllMocks());

  async function setup(existingKeys: (key: string) => boolean = () => false) {
    const portrait = uri(await solid(300, 400, { r: 90, g: 90, b: 160 }));
    const coverImages = { frontCover: portrait, backCover: uri(await solid(300, 400, { r: 90, g: 160, b: 90 })), initialPage: uri(await solid(300, 400, { r: 160, g: 90, b: 90 })) };
    vi.spyOn(r2, 'publicUrlForKey').mockImplementation((k: string) => `https://img.test/${k}`);
    vi.spyOn(r2, 'objectExists').mockImplementation(async (k: string) => existingKeys(k));
    const uploads: string[] = [];
    vi.spyOn(r2, 'uploadImage').mockImplementation(async (_b: any, k: string) => { uploads.push(k); return `https://img.test/${k}`; });
    return { coverImages, uploads };
  }

  it('loads the square-cover prompt through prompts.js', () => {
    expect(PROMPT_TEMPLATES.squareCover).toMatch(/Redraw this picture as a square picture/);
  });

  it('makes all three with the measured Grok options when none is stored', async () => {
    const { coverImages, uploads } = await setup();
    const clean = uri(await art(400));
    const calls: any[] = [];
    const editWithGrok = async (prompt: string, refs: string[], opts: any) => { calls.push({ prompt, refs, opts }); return { imageData: clean, usage: { cost: 0.02 } }; };
    const out = await SC.ensureSquareCovers('story1', coverImages, { editWithGrok, model: 'grok-imagine-image' });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.opts).toMatchObject({ aspectRatio: '1:1', padInputWithExtension: true, model: 'grok-imagine-image' });
      expect(c.opts.padInput).toBeUndefined();   // plain white padding failed 10 of 16 covers
      expect(c.prompt).toBe(PROMPT_TEMPLATES.squareCover);
    }
    expect(out.made).toBe(3);
    expect(out.cost).toBeCloseTo(0.06);
    expect(Object.keys(out.urls).sort()).toEqual(['backCover', 'frontCover', 'initialPage']);
    expect(uploads).toHaveLength(3);
    expect(uploads.every(k => k.startsWith('stories/story1/squareCover/'))).toBe(true);
  });

  it('reuses a stored square and calls Grok only for the missing ones', async () => {
    const first = await setup();
    const clean = uri(await art(400));
    let n = 0;
    const editWithGrok = async () => { n++; return { imageData: clean, usage: { cost: 0.02 } }; };
    // Learn the front cover's key, then pretend only that one is stored.
    await SC.ensureSquareCovers('story1', first.coverImages, { editWithGrok, model: 'm' });
    const frontKey = first.uploads.find(k => k.includes('/frontCover-'))!;
    vi.restoreAllMocks();
    const second = await setup(k => k === frontKey);
    n = 0;
    const out = await SC.ensureSquareCovers('story1', first.coverImages, { editWithGrok, model: 'm' });
    expect(n).toBe(2);
    expect(out.reused).toBe(1);
    expect(second.uploads.some(k => k.includes('/frontCover-'))).toBe(false);
  });

  it('a regenerated cover (different bytes) gets a different key, so the old square is not reused', async () => {
    const { coverImages, uploads } = await setup();
    const editWithGrok = async () => ({ imageData: uri(await art(400)), usage: { cost: 0.02 } });
    await SC.ensureSquareCovers('story1', { frontCover: coverImages.frontCover }, { editWithGrok, model: 'm' });
    const changed = uri(await solid(300, 400, { r: 1, g: 2, b: 3 }));
    await SC.ensureSquareCovers('story1', { frontCover: changed }, { editWithGrok, model: 'm' });
    expect(new Set(uploads).size).toBe(2);
  });

  it('rejects a Grok result with a white bar: throws, stores nothing, no crop fallback', async () => {
    const { coverImages, uploads } = await setup();
    const bad = uri(await withBar('left', { r: 255, g: 255, b: 255 }));
    const editWithGrok = async () => ({ imageData: bad, usage: { cost: 0.02 } });
    await expect(SC.ensureSquareCovers('story1', { frontCover: coverImages.frontCover }, { editWithGrok, model: 'm' })).rejects.toThrow(/rejected.*white/);
    expect(uploads).toHaveLength(0);
  });

  it('a Grok failure propagates', async () => {
    const { coverImages } = await setup();
    const editWithGrok = async () => { throw new Error('xai 503'); };
    await expect(SC.ensureSquareCovers('story1', { frontCover: coverImages.frontCover }, { editWithGrok, model: 'm' })).rejects.toThrow(/xai 503/);
  });
});
