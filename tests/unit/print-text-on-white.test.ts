/**
 * Long text (advanced) prints on plain white under a whole square picture: no strip fill, no Grok
 * call, no cut text. Short and medium keep the filled strip. docs/decisions.md 2026-11-02.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const pdfLib = cjs('../../server/lib/pdf.js');
const pageFill = cjs('../../server/lib/pageFill.js');
const { printsTextOnWhite } = cjs('../../server/lib/layout.js');

async function story(level: string, wordsPerPage: number, pages = 2) {
  const png = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#7a9a60' } }).png().toBuffer();
  const imageData = `data:image/png;base64,${png.toString('base64')}`;
  const words = Array.from({ length: wordsPerPage }, (_, i) => `Wort${i}`).join(' ');
  const storyText = Array.from({ length: pages }, (_, i) => `--- Page ${i + 1} ---\n${words}`).join('\n');
  return {
    title: 'T', languageLevel: level, storyText,
    sceneImages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, imageData })),
    coverImages: {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe('printsTextOnWhite', () => {
  it('is true only for the long level', () => {
    expect(printsTextOnWhite('advanced')).toBe(true);
    expect(printsTextOnWhite('standard')).toBe(false);
    expect(printsTextOnWhite('1st-grade')).toBe(false);
    expect(printsTextOnWhite(undefined)).toBe(false);
  });
});

describe('A4 single layout by reading level', () => {
  it('advanced: no strip fill and no Grok call even with fillMethod grok', async () => {
    const spy = vi.spyOn(pageFill, 'buildFilledPageBackground');
    const s = await story('advanced', 200);
    const { pdfBuffer } = await pdfLib.generatePrintPdf(s, 'A4', { fillMethod: 'grok', fillStats: {} });
    expect(pdfBuffer.length).toBeGreaterThan(1000);
    expect(spy).not.toHaveBeenCalled();
  }, 60000);

  it('standard: still schedules one strip fill per page', async () => {
    const real = pageFill.buildFilledPageBackground;
    const spy = vi.spyOn(pageFill, 'buildFilledPageBackground')
      .mockImplementation((a: any) => real({ ...a, fillMethod: 'mirror' }));
    const s = await story('standard', 60);
    await pdfLib.generatePrintPdf(s, 'A4', { fillMethod: 'grok', fillStats: {} });
    expect(spy).toHaveBeenCalledTimes(2);
  }, 60000);

  it('1st-grade: still fills the strip (mirror, via the view PDF)', async () => {
    const spy = vi.spyOn(pageFill, 'buildFilledPageBackground');
    const s = await story('1st-grade', 30);
    await pdfLib.generateViewPdf(s, 'A4');
    expect(spy).toHaveBeenCalledTimes(2);
  }, 60000);

  it('advanced in the trial layout keeps the strip (it pins its own geometry)', async () => {
    const spy = vi.spyOn(pageFill, 'buildFilledPageBackground');
    const s = await story('advanced', 60);
    await pdfLib.generateViewPdf(s, 'A4', { trialLayout: true });
    expect(spy).toHaveBeenCalledTimes(2);
  }, 60000);

  it('advanced: text too long for any allowed picture size throws instead of being cut', async () => {
    const s = await story('advanced', 2500, 1);
    await expect(pdfLib.generateViewPdf(s, 'A4')).rejects.toThrow(/under the 40% floor/);
  }, 60000);

  it('advanced: the story text under the picture is top-left aligned (prose, like the square text pages)', async () => {
    const PDFDocument = cjs('pdfkit');
    const spy = vi.spyOn(PDFDocument.prototype, 'text');
    const s = await story('advanced', 120, 2);
    // Page 2 much shorter than page 1: top alignment puts both at the same y, centring would not.
    s.storyText = s.storyText.replace(/(--- Page 2 ---\n)[\s\S]*$/, '$1Wort0 Wort1 Wort2');
    await pdfLib.generateViewPdf(s, 'A4');
    const bodyCalls = spy.mock.calls.filter((c: any[]) => typeof c[0] === 'string' && c[0].includes('Wort0'));
    expect(bodyCalls.length).toBe(2);
    for (const c of bodyCalls) {
      const opts = c.find((a: any) => a && typeof a === 'object' && 'align' in a);
      expect(opts.align).toBe('left');
      // Paragraph gap reduced for text on white (owner 2026-11-02): 0.2 x font size, below the strips' 0.5.
      // The strips' 0.5 x font is at least 5 pt (10 pt floor); 0.2 x at most 12 pt is 2.4 pt.
      expect(opts.paragraphGap).toBeGreaterThan(0);
      expect(opts.paragraphGap).toBeLessThanOrEqual(2.4 + 1e-9);
    }
    expect(bodyCalls[1][2]).toBeCloseTo(bodyCalls[0][2], 3);
  }, 60000);

  it('advanced: a long page shrinks the picture for the whole book and still renders', async () => {
    const s = await story('advanced', 700, 2);
    const buf = await pdfLib.generateViewPdf(s, 'A4');
    expect(buf.length).toBeGreaterThan(1000);
  }, 60000);
});

describe('whiteTextRatio (one picture size per book)', () => {
  const PDFDocument = cjs('pdfkit');
  const f = pdfLib.BOOK_FORMATS.A4;
  const pages = (n: number) => [Array.from({ length: n }, (_, i) => `Wort${i}`).join(' ')];
  const side = (ratio: number, bleed: number) => f.pageHeight * (1 - ratio) + bleed; // picture side = imageBottom
  const doc = () => new PDFDocument({ size: [f.pageWidth, f.pageHeight] });

  it('keeps the full interior width when the text fits (order-story case)', () => {
    const bleed = f.bleed;
    const r = pdfLib.whiteTextRatio(doc(), pages(150), f.pageWidth, f.pageHeight, bleed);
    expect(side(r, bleed)).toBeCloseTo(f.pageWidth + 2 * bleed, 3);
  });

  it('shrinks the square (whole, never wider than the page) when the text does not fit at full width', () => {
    const bleed = f.bleed;
    const r = pdfLib.whiteTextRatio(doc(), pages(500), f.pageWidth, f.pageHeight, bleed);
    const s = side(r, bleed);
    expect(s).toBeLessThan(f.pageWidth + 2 * bleed);
    expect(s).toBeGreaterThan((f.pageHeight + 2 * bleed) * 0.4);
  });

  it('throws when even the minimum picture cannot fit', () => {
    expect(() => pdfLib.whiteTextRatio(doc(), pages(2500), f.pageWidth, f.pageHeight, f.bleed)).toThrow(/floor/);
  });
});
