/**
 * Portrait cover / dedication pictures on a square page are extended SIDEWAYS, never cropped
 * (server/lib/pageFill.js edge 'sides' + pdf.js drawFittedPicture, decisions.md 2026-10-27).
 * Regression: the mini square book used cover-fit and cut the title off the front cover.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const { buildFilledPageBackground } = cjs('../../server/lib/pageFill.js');
const { drawFittedPicture } = cjs('../../server/lib/pdf.js');

// 3:4 portrait: red top rows (the "title"), blue middle, green bottom rows (the "dedication").
async function portrait() {
  const svg = '<svg width="600" height="800"><rect width="600" height="800" fill="#2040c0"/>'
    + '<rect width="600" height="60" fill="#d02020"/><rect y="740" width="600" height="60" fill="#20b040"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
async function rgb(buf: Buffer) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const px = (d: any, x: number, y: number) => { const i = (y * d.w + x) * 3; return [d.data[i], d.data[i + 1], d.data[i + 2]]; };

describe("pageFill edge 'sides'", () => {
  it('keeps the whole picture: first and last rows inside, bands on both sides', async () => {
    const r = await buildFilledPageBackground({ imageBuffer: await portrait(), pageWidthPx: 1000, pageHeightPx: 1000, imageHeightPx: 0, fillMethod: 'mirror', edge: 'sides' });
    expect(r.pictureWidthPx).toBe(750);            // 1000 * 3/4: fitted by height
    expect(r.pictureLeftPx).toBe(125);             // centred, a band each side
    const d = await rgb(r.buffer);
    expect([d.w, d.h]).toEqual([1000, 1000]);
    const mid = 500;
    expect(px(d, mid, 10)[0]).toBeGreaterThan(150);          // title rows present at the very top
    expect(px(d, mid, 990)[1]).toBeGreaterThan(130);         // dedication rows present at the very bottom
    expect(px(d, mid, 500)[2]).toBeGreaterThan(150);         // blue body
    // both side bands are filled with the picture's colours (blue body), not white
    for (const x of [5, 995]) {
      const c = px(d, x, 500);
      expect(c[2]).toBeGreaterThan(120);
      expect(c[0]).toBeLessThan(120);
    }
    // the band keeps the top/bottom structure of the edge it continues (red on top, green at bottom)
    expect(px(d, 5, 10)[0]).toBeGreaterThan(120);
    expect(px(d, 5, 990)[1]).toBeGreaterThan(110);
  });

  it('grok: one call, 1:1 canvas, original picture pixels kept in the middle', async () => {
    const calls: any[] = [];
    const editFn = async (prompt: string, imgs: string[], opts: any) => {
      calls.push({ prompt, opts });
      const flat = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#ff00ff' } }).png().toBuffer();
      return { imageData: 'data:image/png;base64,' + flat.toString('base64') };
    };
    const { PROMPT_TEMPLATES } = cjs('../../server/services/prompts');
    PROMPT_TEMPLATES.stripOutpaint = PROMPT_TEMPLATES.stripOutpaint || 'Extend {DIRECTION}.';
    const r = await buildFilledPageBackground({ imageBuffer: await portrait(), pageWidthPx: 1000, pageHeightPx: 1000, imageHeightPx: 0, fillMethod: 'grok', edge: 'sides', editFn });
    expect(r.usedGrok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.aspectRatio).toBe('1:1');
    expect(calls[0].prompt).toContain('sideways');
    const d = await rgb(r.buffer);
    expect(px(d, 500, 10)[0]).toBeGreaterThan(150);   // original title row, not magenta-blue
    expect(px(d, 500, 10)[1]).toBeLessThan(80);
    expect(px(d, 5, 500)[0]).toBeGreaterThan(200);    // band is the model's (magenta)
    expect(px(d, 5, 500)[2]).toBeGreaterThan(200);
  });

  it('throws when the page is not wider than the picture', async () => {
    await expect(buildFilledPageBackground({ imageBuffer: await portrait(), pageWidthPx: 750, pageHeightPx: 1000, imageHeightPx: 0, fillMethod: 'mirror', edge: 'sides' })).rejects.toThrow(/no side bands/);
  });
});

function fakeDoc() {
  const log: string[] = [];
  const doc: any = {
    log, images: [] as any[],
    save() { log.push('save'); return doc; }, restore() { log.push('restore'); return doc; },
    rect() { log.push('rect'); return doc; }, clip() { log.push('clip'); return doc; },
    image(buf: Buffer, x: number, y: number, o: any) { doc.images.push({ buf, x, y, o }); return doc; },
  };
  return doc;
}

describe('drawFittedPicture (regression: square mini book cropped the cover title)', () => {
  it('square box + portrait picture: no cover-fit crop, the filled raster covers the box', async () => {
    const doc = fakeDoc();
    const src = await portrait();
    await drawFittedPicture(doc, src, 0, 0, 595, 595, { fillMethod: 'mirror' });
    expect(doc.log).not.toContain('clip');            // drawImageCovering always clips to the box
    expect(doc.images).toHaveLength(1);
    expect(doc.images[0].o).toEqual({ width: 595, height: 595 });
    const meta = await sharp(doc.images[0].buf).metadata();
    expect(meta.width / meta.height).toBeCloseTo(1, 2);
  });

  it('box about as narrow as the picture (A4): unchanged cover-fit', async () => {
    const doc = fakeDoc();
    await drawFittedPicture(doc, await portrait(), 0, 0, 612, 812, { fillMethod: 'mirror' });
    expect(doc.log).toContain('clip');
  });

  it('requires an explicit fillMethod', async () => {
    await expect(drawFittedPicture(fakeDoc(), await portrait(), 0, 0, 595, 595, {})).rejects.toThrow(/fillMethod/);
  });
});
