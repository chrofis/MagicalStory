/**
 * SHORT BOOKS PRINT AS A SPREAD (owner decision 2026-10-26, orders 98-101).
 *
 * Up to 25 scenes the book prints with the scene image on the left page and its text on the
 * facing right page; ONE pure function (gelato.chooseBookLayout) decides and the price follows
 * the printed content count (owner 2026-10-27).
 * Plan: tasks/short-book-layout-2026-10-26.md, tasks/strip-edge-by-picture-2026-10-27.md
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const {
  computeBookPageInfo, countBookContentPages, buildPrintedPageSequence, chooseBookLayout, MAX_SPREAD_SCENES,
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

describe('layout by scene count (spread up to 25 scenes)', () => {
  // [scenes, layout, printed, blank]   owner 2026-10-27: facing pages whenever it fits
  const table: [number, string, number, number][] = [
    [6, 'spread', 28, 15],   // content 13 -> 14 -> 28 minimum
    [9, 'spread', 28, 9],
    [15, 'spread', 32, 1],   // 15 scenes -> a 30+ page square book, one side text, other side image
    [20, 'spread', 42, 1],
    [25, 'spread', 52, 1],   // the single-story cap still prints as a spread
    [26, 'single', 28, 1],   // 27 content pages -> 28
    [27, 'single', 28, 0],
  ];
  for (const [pages, layout, printed, blank] of table) {
    it(`${pages} scenes -> ${layout}, ${printed} printed, ${blank} blank`, async () => {
      const r = await info([story(pages)]);
      expect(r.layout).toBe(layout);
      expect(r.printedPages).toBe(printed);
      expect(r.blankPages).toBe(blank);
      expect(r.sequence.length).toBe(printed + 3);
      expect(r.sequence.filter((s: any) => s.kind === 'filler').length).toBe(blank);
    });
  }

  it('chooseBookLayout counts the scenes of ALL stories in the book', () => {
    expect(MAX_SPREAD_SCENES).toBe(25);
    expect(chooseBookLayout([story(25)])).toBe('spread');
    expect(chooseBookLayout([story(13), story(12)])).toBe('spread');
    expect(chooseBookLayout([story(13), story(13)])).toBe('single');
    expect(chooseBookLayout([story(26)])).toBe('single');
  });

  it('no SKU -> still the layout by scene count (nothing to snap)', async () => {
    expect((await info([story(10)], [])).layout).toBe('spread');
  });

  it('a spread book needs no blank-page acknowledgement once it is nearly full', async () => {
    const r = await info([story(15)]);
    expect(isBlankPagesAckMissing(r.blankPages, undefined)).toBe(false);
  });
});

describe('price follows the printed content count', () => {
  it('contentPages is the chosen layout count: 2 per scene when spread', async () => {
    for (const n of [6, 15, 20, 25]) {
      const r = await info([story(n)]);
      expect(r.layout).toBe('spread');
      expect(r.contentPages).toBe(countBookContentPages([story(n)], 'spread'));
      expect(r.contentPages).toBe(2 * n + 1);
    }
    const single = await info([story(26)]);
    expect(single.contentPages).toBe(27);
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

describe('clients bill the printed content count', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, '../../client/src/pages', f), 'utf8');
  it('BookBuilder and VoucherBookCheckout price server contentPages; no contentPagesSingle remains', () => {
    expect(src('BookBuilder.tsx')).toContain('pageInfo?.contentPages ?? null');
    expect(src('VoucherBookCheckout.tsx')).toContain('pageInfo?.contentPages ?? listedPages');
    expect(src('BookBuilder.tsx')).not.toContain('contentPagesSingle');
  });
  it('both checkouts take the price count from computeBookPageInfo', () => {
    const root = path.resolve(__dirname, '../../server/routes');
    expect(fs.readFileSync(path.join(root, 'print.js'), 'utf8')).toContain('const totalPages = pageInfo.contentPages;');
    expect(fs.readFileSync(path.join(root, 'vouchers.js'), 'utf8')).toContain('const totalPages = pageInfo.contentPages;');
  });
  it('both blank-page warnings carry the add-story action', () => {
    expect(src('BookBuilder.tsx')).toContain('<AddStoryNudge');
    expect(src('VoucherBookCheckout.tsx')).toContain('<AddStoryNudge');
  });
});
