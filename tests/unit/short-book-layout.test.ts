/**
 * THE BOOK PRODUCT MODEL (owner 2026-10-27, replaces v3 'customer picks'): mini square facing book, A4 main product, hidden facing exception.
 *
 * Gelato's minimum is 28 pages. A story whose one-page A4 layout leaves 4 or more empty pages (below 24 scenes) is the
 * MINI book: facing pages, SQUARE, the only option, no surcharge. Every other book is A4, one page per scene; facing pages
 * (square, priced on its own page count) is the exception, up to 60 scenes. The format follows the layout (computeBookPageInfo.bookFormat).
 * Plan: tasks/short-book-layout-2026-10-26.md, tasks/strip-edge-by-picture-2026-10-27.md (Part B v4)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const {
  computeBookPageInfo, countBookContentPages, buildPrintedPageSequence, chooseBookLayout, FACING_PAGES_MAX_SCENES,
  isBlankPagesAckMissing,
} = require('../../server/lib/gelato.js');

const story = (n: number) => ({
  storyText: Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\nText ${i + 1}`).join('\n'),
});
const SKU28 = {
  product_uid: 'photobooks-hardcover_pf_210x280-mm-portrait_pt_170-gsm',
  product_name: 'Hardcover A4', min_pages: 28, max_pages: 200, available_page_counts: null,
};
const SQUARE28 = {
  product_uid: 'photobooks-hardcover_pf_200x200-mm-square_pt_170-gsm',
  product_name: 'Hardcover square', min_pages: 28, max_pages: 200, available_page_counts: null,
};
// SKU28 stands for "the catalogue": the A4 row plus the square row (the format follows the layout).
// tierTop = top of pricing_tiers (owner 2026-11-11: square not offered above it).
const info = (stories: any[], rows: any[] = [SKU28], options: any = {}, tierTop = 100) =>
  computeBookPageInfo({ query: async (sql: string) => ({ rows: /pricing_tiers/.test(sql) ? [{ max_pages: tierTop }] : [...rows, SQUARE28] }) }, stories, 'hardcover', options);
const { CREDIT_CONFIG } = require('../../server/config/credits.js');

describe('layout availability (customer picks; 28-page minimum, 4-blank rule, 60-scene facing cap)', () => {
  // [scenes, single available, single blank, spread available, spread printed]
  const table: [number, boolean, number, boolean, number][] = [
    [6, false, 21, true, 28],     // single 7/28 = 21 blank
    [15, false, 12, true, 32],    // order 101
    [23, false, 4, true, 48],     // 24 content -> 28: 4 blank, the first greyed-out size
    [24, true, 3, true, 50],      // 25 content -> 26 -> 28: 3 blank, text in picture available
    [25, true, 2, true, 52],      // single-story cap
  ];
  for (const [scenes, singleOk, singleBlank, spreadOk, spreadPrinted] of table) {
    it(`${scenes} scenes: text-in-picture ${singleOk ? 'available' : 'greyed'} (${singleBlank} blank), facing ${spreadOk ? 'available' : 'greyed'} (${spreadPrinted} printed)`, async () => {
      const r = await info([story(scenes)]);
      expect(r.layouts.single.available).toBe(singleOk);
      expect(r.layouts.single.blankPages).toBe(singleBlank);
      expect(r.layouts.spread.available).toBe(spreadOk);
      expect(r.layouts.spread.printedPages).toBe(spreadPrinted);
      if (!singleOk) expect(r.layouts.single.reason).toEqual({ code: 'TOO_FEW_PAGES', emptyPages: singleBlank });
      else expect(r.layouts.single.reason).toBeNull();
    });
  }

  it('60 scenes in 3 books: facing needs 126 pages, the 200-page SKU takes it when the price tiers reach that far', async () => {
    const r = await info([story(25), story(25), story(10)], [SKU28], { layout: 'spread' }, 200);
    expect(FACING_PAGES_MAX_SCENES).toBe(60);
    expect(r.layouts.single.available).toBe(true);
    expect(r.layouts.spread.available).toBe(true);
    expect(r.layout).toBe('spread');
    expect(r.printedPages).toBe(126);   // 1 + 120 + 2x2 (title + dedication of stories 2 and 3) = 125 -> 126
    expect(r.blankPages).toBe(1);
    const capped = await info([story(25), story(25), story(10)]);
    expect(capped.layouts.spread.available).toBe(false);
    expect(capped.layouts.spread.reason).toMatchObject({ code: 'TOO_MANY_PAGES', maxPages: 100 });
  });
  it('61 scenes: facing greyed with the printed-page reason (more than 120), one-page layout still works', async () => {
    const stories = [story(25), story(25), story(11)];
    const r = await info(stories, [SKU28], {}, 200);
    expect(r.layouts.spread.available).toBe(false);
    expect(r.layouts.spread.reason).toMatchObject({ code: 'TOO_MANY_PAGES', maxPages: 120 });
    expect(r.layouts.spread.reason.printedPages).toBeGreaterThan(120);
    expect(r.layout).toBe('single');
    await expect(info(stories, [SKU28], { layout: 'spread' })).rejects.toThrow(/not available/);
  });

  it('default = text in the picture when available, else facing pages', async () => {
    expect((await info([story(25)])).layout).toBe('single');
    expect((await info([story(15)])).layout).toBe('spread');
  });
  it('the requested layout is honoured when available', async () => {
    const r = await info([story(25)], [SKU28], { layout: 'spread' });
    expect(r.layout).toBe('spread');
    expect(r.printedPages).toBe(52);
    expect(r.sequence.filter((x: any) => x.kind === 'storyImage').length).toBe(25);
    const s = await info([story(25)], [SKU28], { layout: 'single' });
    expect(s.layout).toBe('single');
    expect(s.printedPages).toBe(28);
  });
  it('an unavailable request THROWS, no silent downgrade; an unknown one throws too', async () => {
    await expect(info([story(15)], [SKU28], { layout: 'single' })).rejects.toThrow(/not available/);
    await expect(info([story(15)], [SKU28], { layout: 'bogus' as any })).rejects.toThrow(/Unknown book layout/);
    try { await info([story(15)], [SKU28], { layout: 'single' }); } catch (e: any) { expect(e.code).toBe('BOOK_LAYOUT_UNAVAILABLE'); }
  });
  it('chooseBookLayout is pure over describeLayouts', () => {
    const both = { single: { available: true }, spread: { available: true } };
    expect(chooseBookLayout(both)).toBe('single');
    expect(chooseBookLayout(both, 'spread')).toBe('spread');
    expect(chooseBookLayout({ single: { available: false, reason: {} }, spread: { available: true } })).toBe('spread');
    expect(() => chooseBookLayout({ single: { available: false, reason: {} }, spread: { available: false, reason: {} } })).toThrow();
  });

  it('a spread book of 15 scenes needs no blank-page acknowledgement once it is nearly full', async () => {
    const r = await info([story(15)]);
    expect(isBlankPagesAckMissing(r.blankPages, undefined)).toBe(false);
  });
});

describe('the format follows the layout (never picked by the customer)', () => {
  it('6 and 15 scenes: spread, square, the only option, surcharge 0', async () => {
    for (const n of [6, 15]) {
      const r = await info([story(n)]);
      expect(r.layout).toBe('spread');
      expect(r.bookFormat).toBe('square');
      expect(r.productUid).toBe(SQUARE28.product_uid);
      expect(r.layouts.single.available).toBe(false);
    }
  });
  it('25 scenes: single A4 by default; spread on request is square, its price tier read from its own two-pages-per-scene count', async () => {
    const d = await info([story(25)]);
    expect(d.layout).toBe('single');
    expect(d.bookFormat).toBe('A4');
    expect(d.productUid).toBe(SKU28.product_uid);
    expect(d.contentPages).toBe(26);
    const s = await info([story(25)], [SKU28], { layout: 'spread' });
    expect(s.bookFormat).toBe('square');
    expect(s.productUid).toBe(SQUARE28.product_uid);
    expect(s.contentPages).toBe(51);
  });
  it('61 scenes: no spread, A4', async () => {
    const r = await info([story(25), story(25), story(11)]);
    expect(r.layouts.spread.available).toBe(false);
    expect(r.bookFormat).toBe('A4');
  });
  it('a client-sent format is ignored', async () => {
    const r = await (computeBookPageInfo as any)({ query: async (sql: string) => ({ rows: /pricing_tiers/.test(sql) ? [{ max_pages: 100 }] : [SKU28, SQUARE28] }) }, [story(25)], 'hardcover', 'square');
    expect(r.bookFormat).toBe('A4');
    expect(r.layout).toBe('single');
  });
});

describe('price: the tier is read from the chosen layout own content page count, no surcharge (decisions.md 2026-11-11)', () => {
  it('the CHF 5 surcharge constant and the surcharge helpers are gone', () => {
    expect(CREDIT_CONFIG.BOOK_LAYOUT_SURCHARGE_CHF).toBeUndefined();
    const g = require('../../server/lib/gelato.js');
    for (const k of ['facingSurchargeApplies', 'facingSurchargeIfChosenChf', 'layoutSurchargeChf']) expect(g[k]).toBeUndefined();
  });
  it('6- and 15-scene books: facing is the only layout; the tier is read from its own two-pages-per-scene count', async () => {
    for (const n of [6, 15]) {
      const r = await info([story(n)]);
      expect(r.layout).toBe('spread');
      expect(r.contentPages).toBe(2 * n + 1);
      expect(r.layouts.single.contentPages).toBe(n + 1);
    }
  });
  it('25-scene book: each layout is billed on its own count (square 51, A4 26)', async () => {
    const f = await info([story(25)], [SKU28], { layout: 'spread' });
    expect(f.contentPages).toBe(51);
    expect(f.layouts.single.contentPages).toBe(26);
    const s = await info([story(25)], [SKU28], { layout: 'single' });
    expect(s.contentPages).toBe(26);
  });
  it('countBookContentPages defaults to single and doubles scenes for spread', () => {
    expect(countBookContentPages([story(6), story(6)])).toBe(1 + 6 + 2 + 6);
    expect(countBookContentPages([story(6), story(6)], 'spread')).toBe(1 + 12 + 2 + 12);
  });
  it('voucher coupon covers the whole list price except the hardcover surcharge (no layout surcharge any more)', () => {
    const { bookCouponCents } = require('../../server/lib/vouchers.js');
    expect(bookCouponCents({ listTotalCents: 5100, hardcover: false })).toBe(5100);
    expect(bookCouponCents({ listTotalCents: 6100, hardcover: true })).toBe(5100);
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

describe('the layout travels builder -> page info -> checkout -> order -> PDF', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../..', ...p), 'utf8');
  it('both checkouts validate the requested layout and put bookLayout in the Stripe metadata', () => {
    for (const f of ['server/routes/print.js', 'server/routes/vouchers.js']) {
      const src = read(f);
      expect(src).toContain('{ layout: req.body.layout }');
      expect(src).toContain('bookLayout: pageInfo.layout');
      expect(src).not.toMatch(/layoutSurcharge/);
      expect(src).toContain('pageInfo.contentPages');
      expect(src).toContain("err.name === 'BookLayoutError'");
    }
  });
  it('the format is derived from the layout: no client format reaches the page info, the checkouts or the metadata', () => {
    for (const f of ['server/routes/print.js', 'server/routes/vouchers.js']) {
      const src = read(f);
      expect(src).toContain('bookFormat: pageInfo.bookFormat');
      expect(src).not.toMatch(/computeBookPageInfo\([^)]*bookFormat/);
    }
    expect(read('server/lib/gelato.js')).not.toMatch(/metadata\?\.bookFormat/);
    for (const f of ['client/src/pages/BookBuilder.tsx', 'client/src/pages/VoucherBookCheckout.tsx']) {
      expect(read(f)).not.toMatch(/bookFormat/);
    }
  });
  it('the webhook and the resume path hand the session layout to processBookOrder', () => {
    expect(read('server/lib/gelato.js')).toContain('fullSession.metadata?.bookLayout');
    expect(read('server/lib/gelato.js')).toContain('inp.quantity, inp.layout');
    expect(read('server.js')).toContain('orderQuantity, orderLayout');
  });
  it('clients bill the content count of the chosen layout, show the format cards and carry no surcharge', () => {
    const b = read('client/src/pages/BookBuilder.tsx');
    expect(b).toContain('pageInfo?.contentPages');
    expect(b).not.toMatch(/layoutSurcharge|contentPagesSingle/);
    expect(b).toContain('<BookFormatChoice');
    expect(read('client/src/pages/VoucherBookCheckout.tsx')).toContain('<BookFormatChoice');
    expect(read('client/src/pages/VoucherBookCheckout.tsx')).not.toMatch(/layoutSurcharge|contentPagesSingle/);
  });
  it('both blank-page warnings carry the add-story action', () => {
    expect(read('client/src/pages/BookBuilder.tsx')).toContain('<AddStoryNudge');
    expect(read('client/src/pages/VoucherBookCheckout.tsx')).toContain('<AddStoryNudge');
  });
});

describe('facing text page font size (owner 2026-10-27: 22pt read like a large-print book)', () => {
  it('starts at the reading-level size, not a fixed large size', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../server/lib/pdf.js'), 'utf8');
    expect(src).not.toMatch(/SPREAD_START_FONT/);
    expect(src).toMatch(/let fontSize = require\('\.\.\/config\/textRegion'\)\.requiredFontPt\(storyData\.languageLevel\)/);
  });
});
