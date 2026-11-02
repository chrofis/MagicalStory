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

  it('advanced: text that cannot fit the white area throws instead of being cut', async () => {
    const s = await story('advanced', 900, 1);
    await expect(pdfLib.generateViewPdf(s, 'A4')).rejects.toThrow(/too long|white area/);
  }, 60000);
});
