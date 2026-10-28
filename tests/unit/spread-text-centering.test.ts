/**
 * Facing-pages book (layout 'spread'): the text page's block is centred up/down (owner 2026-10-28:
 * "The text must be centered up down"). It used to start 20% down the page. Regression: the gap above
 * the laid-out block equals the gap below it, for short and longer texts.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const PDFDocument = require('pdfkit');
const { addSpreadPages } = require('../../server/lib/pdf.js');

const MM = 72 / 25.4;

async function drawAndMeasure(texts: string[]) {
  const pageWidth = 200 * MM, pageHeight = 200 * MM, bleed = 3 * MM;
  const doc = new PDFDocument({ autoFirstPage: false, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  doc.on('data', () => {});
  const draws: { y: number; h: number }[] = [];
  const origText = doc.text.bind(doc);
  doc.text = (t: string, x: number, y: number, o: any) => {
    draws.push({ y, h: doc.heightOfString(t, { width: o.width, align: o.align, lineGap: o.lineGap, paragraphGap: o.paragraphGap }) });
    return origText(t, x, y, o);
  };
  await addSpreadPages(doc, { title: 't', languageLevel: '1st-grade', sceneImages: [] }, texts, pageWidth, pageHeight, bleed);
  doc.end();
  return { draws, interiorH: pageHeight + 2 * bleed };
}

describe('addSpreadPages vertical centring of the text page', () => {
  it('short and longer texts have equal gap above and below the block', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} of a longer page that wraps over several lines.`).join(' ');
    const { draws, interiorH } = await drawAndMeasure(['A short page.', 'Two lines of text here.\nSecond paragraph.', long]);
    expect(draws).toHaveLength(3);
    for (const d of draws) {
      const top = d.y, bottom = interiorH - (d.y + d.h);
      expect(Math.abs(top - bottom)).toBeLessThan(1);
    }
    // a short text sits near the middle, not in the upper fifth
    expect(draws[0].y).toBeGreaterThan(interiorH * 0.35);
  });
});
