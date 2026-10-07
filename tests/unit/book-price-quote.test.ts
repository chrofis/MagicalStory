/**
 * The book builder's quote must come from the page count the checkout bills on.
 *
 * Until 2026-10-07 BookBuilder priced the sum of the story list's `pageCount` (scenes + 3
 * cover pages per story) while POST /api/stripe/create-checkout-session prices
 * countBookContentPages (dedication + scenes + title/dedication/back cover/separator per
 * extra story). The two straddle a tier boundary for real baskets: 5 eleven-page stories
 * are quoted CHF 52 + 10 and charged CHF 58 + 10.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getPriceForPages, fallbackPricingTiers, SHIPPING_COST_CHF } from '../../client/src/utils/bookPricing';
const require = createRequire(import.meta.url);

const database = require('../../server/services/database');
database.getPool = () => ({});
const { countBookContentPages } = require('../../server/lib/gelato.js');

const ROOT = path.resolve(__dirname, '../..');

/** A generated story with N scenes and a full cover set, as stories.data stores it. */
function story(scenes: number) {
  const storyText = Array.from({ length: scenes }, (_, i) => `--- Page ${i + 1} ---\nText ${i + 1}`).join('\n');
  return { storyText, coverImages: { frontCover: 'x', backCover: 'x' } };
}
/** What the story list sends the book builder for that story (server/routes/stories.js). */
const listPageCount = (scenes: number) => scenes + 3;

describe('book price quote vs charge', () => {
  it('the old scene-sum quote and the billed content pages fall into different tiers', () => {
    const basket = [11, 11, 11, 11, 11];
    const quotedPages = basket.reduce((s, n) => s + listPageCount(n), 0);
    const billedPages = countBookContentPages(basket.map(story));
    expect(quotedPages).toBe(70);
    expect(billedPages).toBe(71);
    expect(getPriceForPages(quotedPages, false)).toBe(52);
    expect(getPriceForPages(billedPages, false)).toBe(58);
    // and the other way round: two short stories are quoted a tier ABOVE what is charged
    const two = [12, 13];
    expect(getPriceForPages(two.reduce((s, n) => s + listPageCount(n), 0), false)).toBe(35);
    expect(getPriceForPages(countBookContentPages(two.map(story)), false)).toBe(29);
  });

  it('BookBuilder quotes from the server contentPages (what the checkout bills), never the scene sum', () => {
    const src = fs.readFileSync(path.join(ROOT, 'client/src/pages/BookBuilder.tsx'), 'utf8');
    expect(src).toMatch(/const billedPages = pageInfo\?\.contentPages \?\? null;/);
    expect(src).not.toMatch(/getPriceForPages\(totalPages/);
    // every price lookup on the page uses the billed count
    for (const m of src.matchAll(/getPriceForPages\((\w+)/g)) expect(m[1]).toBe('billedPages');
  });

  it('client fallback tiers and shipping mirror the server seed and checkout constant', () => {
    const seed = fs.readFileSync(path.join(ROOT, 'server/services/database.js'), 'utf8');
    for (const t of fallbackPricingTiers) {
      expect(seed).toContain(`{ maxPages: ${t.maxPages},`);
      expect(seed).toMatch(new RegExp(`maxPages: ${t.maxPages},\\s+label: '${t.label}',\\s+softcover: ${t.softcover}, hardcover: ${t.hardcover} }`));
    }
    const print = fs.readFileSync(path.join(ROOT, 'server/routes/print.js'), 'utf8');
    expect(print).toContain(`const SHIPPING_COST_CHF = ${SHIPPING_COST_CHF};`);
  });
});
