/**
 * SHORT BOOKS PRINT AS A SPREAD (owner decision 2026-10-26, orders 98-101).
 *
 * Gelato's minimum is 28 pages; a 6-15 page story left 14-23 of them white. Below a
 * threshold the book is printed with the scene image on the left page and its text on the
 * facing right page. ONE pure function (gelato.chooseBookLayout) decides; the price stays
 * on the single-layout content count.
 * Plan: tasks/short-book-layout-2026-10-26.md
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const {
  computeBookPageInfo, countBookContentPages, buildPrintedPageSequence, chooseBookLayout,
  isBlankPagesAckMissing,
} = require('../../server/lib/gelato.js');

const story = (n: number) => ({
  storyText: Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\nText ${i + 1}`).join('\n'),
});
const SKU28 = {
  product_uid: 'photobooks-hardcover_pf_210x280-mm-portrait_pt_170-gsm',
  product_name: 'Hardcover A4', min_pages: 28, max_pages: 200, available_page_counts: null,
};
const info = (stories: any[], rows: any[] = [SKU28]) =>
  computeBookPageInfo({ query: async () => ({ rows }) }, stories, 'hardcover', 'A4');

describe('layout threshold (28-page minimum)', () => {
  // [story pages, layout, printed, blank]
  const table: [number, string, number, number][] = [
    [6, 'spread', 28, 15],   // single 7/28 = 21 blank
    [9, 'spread', 28, 9],    // order 98: single 20 blank
    [10, 'spread', 28, 7],
    [15, 'spread', 32, 1],   // order 101: single 12 blank
    [20, 'spread', 42, 1],   // single 7 blank
    [25, 'single', 28, 2],   // 2 blank: below the ack threshold, stays single
    [27, 'single', 28, 0],
  ];
  for (const [pages, layout, printed, blank] of table) {
    it(`${pages} story pages -> ${layout}, ${printed} printed, ${blank} blank`, async () => {
      const r = await info([story(pages)]);
      expect(r.layout).toBe(layout);
      expect(r.printedPages).toBe(printed);
      expect(r.blankPages).toBe(blank);
      expect(r.sequence.length).toBe(printed + 3);
      expect(r.sequence.filter((s: any) => s.kind === 'filler').length).toBe(blank);
    });
  }

  it('chooseBookLayout needs >= 4 single blanks AND fewer spread blanks', () => {
    expect(chooseBookLayout({ blankPages: 3 }, { blankPages: 0 })).toBe('single');
    expect(chooseBookLayout({ blankPages: 4 }, { blankPages: 3 })).toBe('spread');
    expect(chooseBookLayout({ blankPages: 8 }, { blankPages: 8 })).toBe('single');
    expect(chooseBookLayout({ blankPages: 8 }, { blankPages: 12 })).toBe('single');
  });

  it('no SKU -> single (only a parity blank, nothing to improve)', async () => {
    expect((await info([story(10)], [])).layout).toBe('single');
  });

  it('a spread book needs no blank-page acknowledgement once it is nearly full', async () => {
    const r = await info([story(15)]);
    expect(isBlankPagesAckMissing(r.blankPages, undefined)).toBe(false);
  });
});

describe('price stays on the single-layout count', () => {
  it('contentPagesSingle equals countBookContentPages(single) whatever layout is printed', async () => {
    for (const n of [6, 15, 20, 25]) {
      const r = await info([story(n)]);
      expect(r.contentPagesSingle).toBe(countBookContentPages([story(n)]));
      expect(r.contentPagesSingle).toBe(n + 1);
    }
    const spread = await info([story(15)]);
    expect(spread.layout).toBe('spread');
    expect(spread.contentPages).toBe(31);
  });
  it('countBookContentPages defaults to single and doubles scenes for spread', () => {
    expect(countBookContentPages([story(6), story(6)])).toBe(1 + 6 + 2 + 6);
    expect(countBookContentPages([story(6), story(6)], 'spread')).toBe(1 + 12 + 2 + 12);
  });
});

describe('spread sequence', () => {
  it('emits image then text per scene, image on a LEFT (even) book page', () => {
    const seq = buildPrintedPageSequence([story(3)], 14, 'spread');
    expect(seq.map((s: any) => s.kind).slice(0, 9)).toEqual([
      'cover', 'insideFront', 'dedication', 'storyImage', 'storyText', 'storyImage', 'storyText', 'storyImage', 'storyText',
    ]);
    // book page n = sequence index - 1 (cover is not a book page, insideFront is page 0)
    seq.forEach((s: any, i: number) => {
      if (s.kind === 'storyImage') expect((i - 1) % 2).toBe(0);
      if (s.kind === 'storyText') expect((i - 1) % 2).toBe(1);
    });
  });
  it('multi-story spread keeps every story image on a left page', () => {
    const seq = buildPrintedPageSequence([story(2), story(2)], 20, 'spread');
    seq.forEach((s: any, i: number) => {
      if (s.kind === 'storyImage') expect((i - 1) % 2).toBe(0);
    });
  });
});
