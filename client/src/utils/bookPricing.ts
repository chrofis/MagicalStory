// Book price facts shared by the pricing page and the book builder. Pure data + one lookup,
// no React, so a unit test can hold them against the server (tests/unit/book-price-quote).
//
// The page count that picks a tier is the PRINTED CONTENT page count the server bills on
// (countBookContentPages in server/lib/gelato.js: dedication + story pages + per extra
// story title/dedication/back cover/separator), which POST /api/book-page-info returns as
// `contentPages`. It is NOT the scene count the story list shows (+3 cover pages per story).

export interface PricingTier {
  maxPages: number;
  label: string;
  softcover: number;
  hardcover: number;
}

// Fallback pricing tiers (used while loading or if API fails).
// Prices are PER BOOK, shipping (CHF 10) is added once at checkout.
// Mirrors the seed in server/services/database.js; the DB row is the truth.
export const fallbackPricingTiers: PricingTier[] = [
  { maxPages: 30, label: '1-30', softcover: 29, hardcover: 37 },
  { maxPages: 40, label: '31-40', softcover: 35, hardcover: 43 },
  { maxPages: 50, label: '41-50', softcover: 41, hardcover: 49 },
  { maxPages: 60, label: '51-60', softcover: 47, hardcover: 55 },
  { maxPages: 70, label: '61-70', softcover: 52, hardcover: 60 },
  { maxPages: 80, label: '71-80', softcover: 58, hardcover: 66 },
  { maxPages: 90, label: '81-90', softcover: 64, hardcover: 72 },
  { maxPages: 100, label: '91-100', softcover: 69, hardcover: 77 },
];

// Flat shipping cost per order (Switzerland), regardless of quantity.
// Mirrors SHIPPING_COST_CHF in server/routes/print.js create-checkout-session.
export const SHIPPING_COST_CHF = 10;

export const MAX_BOOK_PAGES = 100;

/** Book price for a billed page count; null when it exceeds the last tier. */
export function getPriceForPages(pageCount: number, isHardcover: boolean, tiers?: PricingTier[]): number | null {
  const pricingTiers = tiers || fallbackPricingTiers;
  const tier = pricingTiers.find(t => pageCount <= t.maxPages);
  if (!tier) return null; // Exceeds maximum
  return isHardcover ? tier.hardcover : tier.softcover;
}
