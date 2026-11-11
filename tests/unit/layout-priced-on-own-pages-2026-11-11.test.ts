/**
 * Owner 2026-11-11 ("We have a price per pages of books.. Just use that"): there is NO square surcharge. Each layout is
 * priced with the pricing tiers on ITS OWN content page count (square = spread count, A4 = single count); every pricing
 * path reads the same number. docs/decisions.md "Price per layout from the page tiers".
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import { getPriceForPages, fallbackPricingTiers } from '../../client/src/utils/bookPricing';

const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const gelato = require('../../server/lib/gelato.js');
const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '../..', ...p), 'utf8');

const story = (n: number) => ({ storyText: Array.from({ length: n }, (_, i) => `--- Page ${i + 1} ---\nT`).join('\n') });
const rows = [
  { product_uid: 'photobooks-softcover_pf_210x280-mm', min_pages: 28, max_pages: 200, available_page_counts: null },
  { product_uid: 'photobooks-softcover_pf_200x200-mm', min_pages: 28, max_pages: 200, available_page_counts: null },
];
const pool = { query: async (sql: string) => ({ rows: /pricing_tiers/.test(sql) ? [{ max_pages: 100 }] : rows }) };

describe('each layout is billed on its own content page count', () => {
  it('3 ten-page stories: A4 count 35 (tier 31-40), square count 65 (tier 61-70)', async () => {
    const a4 = await gelato.computeBookPageInfo(pool, [story(10), story(10), story(10)], 'softcover', { layout: 'single' });
    const sq = await gelato.computeBookPageInfo(pool, [story(10), story(10), story(10)], 'softcover', { layout: 'spread' });
    expect(a4.contentPages).toBe(35);
    expect(sq.contentPages).toBe(65);
    // both quotes carry both counts, so the page can show both prices
    expect(sq.layouts.single.contentPages).toBe(35);
    expect(a4.layouts.spread.contentPages).toBe(65);
    expect(getPriceForPages(a4.contentPages, false)).toBe(35);
    expect(getPriceForPages(sq.contentPages, false)).toBe(52);
  });
  it('the page info carries no surcharge field', async () => {
    const info = await gelato.computeBookPageInfo(pool, [story(10), story(10), story(10)], 'softcover');
    expect(info).not.toHaveProperty('layoutSurchargeChf');
    expect(info).not.toHaveProperty('contentPagesSingle');
    expect(info.layouts.spread).not.toHaveProperty('surchargeChf');
  });
  it('fallback tier table is the one the client prices with', () => {
    expect(fallbackPricingTiers.length).toBeGreaterThan(0);
  });
});

describe('every pricing path prices from the one rule (pageInfo.contentPages -> tier), no surcharge anywhere', () => {
  const files = ['server/config/credits.js', 'server/lib/gelato.js', 'server/lib/vouchers.js', 'server/routes/print.js', 'server/routes/vouchers.js',
    'client/src/pages/BookBuilder.tsx', 'client/src/pages/VoucherBookCheckout.tsx', 'client/src/services/storyService.ts'];
  it('no surcharge name survives in any pricing path', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/BOOK_LAYOUT_SURCHARGE|layoutSurcharge|facingSurcharge|contentPagesSingle/i);
    }
  });
  it('book-page-info, Stripe checkout and voucher checkout read the tier from pageInfo.contentPages', () => {
    const print = read('server/routes/print.js');
    const vouchers = read('server/routes/vouchers.js');
    expect(print).toMatch(/const totalPages = pageInfo\.contentPages;[\s\S]*?await getPriceForPages\(totalPages, isHardcover\)/);
    expect(vouchers).toMatch(/const totalPages = pageInfo\.contentPages;[\s\S]*?await getPriceForPages\(totalPages, isHardcover\)/);
    expect(print).not.toMatch(/countBookContentPages\(stories/);
    expect(vouchers).not.toMatch(/countBookContentPages/);
    expect(print).toMatch(/layouts: info\.layouts/);
  });
  it('the order page and the voucher page read the same server count', () => {
    expect(read('client/src/pages/BookBuilder.tsx')).toMatch(/const billedPages = pageInfo\?\.contentPages \?\? null;/);
    expect(read('client/src/pages/VoucherBookCheckout.tsx')).toMatch(/pageInfo\?\.contentPages \?\? listedPages/);
  });
  it('the voucher coupon covers everything except the hardcover surcharge', () => {
    const { bookCouponCents } = require('../../server/lib/vouchers.js');
    expect(bookCouponCents({ listTotalCents: 6200, hardcover: false })).toBe(6200);
    expect(bookCouponCents({ listTotalCents: 7200, hardcover: true })).toBe(6200);
  });
});

describe('two equal format cards', () => {
  const card = read('client/src/components/book/BookFormatChoice.tsx');
  it('reuses ChoiceCard (no second card) and shows only when both layouts are available', () => {
    expect(card).toContain("import { ChoiceCard } from '@/components/book/BlankPagesChoice'");
    expect(card).not.toMatch(/<button/);
    expect(card).toMatch(/layouts\.single\.available && layouts\.spread\.available/);
    expect(card).toMatch(/if \(!hasFormatChoice\(layouts\)\) return null/);
  });
  it('sizes come from the shared constants; 4 languages; Swiss ss; A4 first and the default', () => {
    expect(card).toContain('Quadratisch ${SQUARE_BOOK_SIZE_LABEL}: Bild links, Text rechts');
    expect(card).toContain('A4 ${A4_BOOK_SIZE_LABEL}: Text unter dem Bild');
    expect(card).not.toMatch(/20 × 20|21 × 28|ß/);
    expect((card.match(/pages: n =>/g) || []).length).toBe(4);
    expect(gelato.chooseBookLayout({ single: { available: true }, spread: { available: true } })).toBe('single');
  });
  it('each card shows its printed pages and its own full price; the page prices each from its own count', () => {
    expect(card).toMatch(/t\.pages\(single\.printedPages\)/);
    expect(card).toMatch(/t\.pages\(spread\.printedPages\)/);
    expect(card).toMatch(/prices\?\.single/);
    expect(card).toMatch(/prices\?\.spread/);
    expect(read('client/src/pages/BookBuilder.tsx')).toMatch(/layouts\[l\]\.contentPages/);
  });
  it('the hidden more-options link is gone from both pages', () => {
    expect(fs.existsSync(path.resolve(__dirname, '../../client/src/components/book/BookFacingOption.tsx'))).toBe(false);
    for (const f of ['client/src/pages/BookBuilder.tsx', 'client/src/pages/VoucherBookCheckout.tsx']) {
      expect(read(f)).toContain('<BookFormatChoice');
      expect(read(f)).not.toMatch(/BookFacingOption|book-more-options/);
    }
  });
});

// The printed-book strip (and its cover-pair helper) was removed the same day (owner: page too long);
// book-builder-blank-ack-hint-2026-11-11.test.ts checks it stays gone.
