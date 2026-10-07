import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { getMetaForRoute } = require('../../server/lib/seoMeta.js');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ofType = (route: string, lang: string, type: string) =>
  getMetaForRoute(route, lang).jsonLd.find((j: { '@type': string }) => j['@type'] === type);

describe('JSON-LD states the facts the site charges (decisions.md 2026-10-05)', () => {
  it('a theme Product offer names the hardcover price CHF 37 in every language', () => {
    for (const lang of ['de', 'en', 'fr', 'it']) {
      const offer = ofType('/themes/adventure/pirate', lang, 'Product').offers.description as string;
      expect(offer, lang).toContain('CHF 37');
      expect(offer, lang).not.toContain('CHF 29');
    }
  });

  it('the AggregateOffer high price is the dearest fallback tier (utils/bookPricing.ts), not the migration seed', () => {
    const tiers = read('client/src/utils/bookPricing.ts'); // tiers moved out of Pricing.tsx (book-price-quote fix)
    const maxHardcover = Math.max(...[...tiers.matchAll(/hardcover: (\d+) \}/g)].map(m => Number(m[1])));
    expect(maxHardcover).toBe(77);
    for (const route of ['/', '/pricing', '/anlass/geburtstag', '/geschenk/fuer-enkel']) {
      expect(ofType(route, 'de', 'Product').offers.highPrice, route).toBe(String(maxHardcover));
    }
  });

  it('the Organization speaks of four languages, as the site has', () => {
    expect(ofType('/', 'de', 'Organization').description).toContain('4 languages');
  });
});

describe('index.html carries no fixed-language structured data', () => {
  const html = read('client/index.html');
  it('has no static JSON-LD block (seoMeta injects it per route and language)', () => {
    expect(html).not.toContain('application/ld+json');
  });
  it('lists Italian among the Open Graph alternate locales', () => {
    expect(html).toContain('<meta property="og:locale:alternate" content="it_CH" />');
  });
  it('the German homepage still gets Organization + Product + BreadcrumbList once injected', () => {
    const { injectMeta } = require('../../server/lib/seoMeta.js');
    const out = injectMeta(html, getMetaForRoute('/', 'de'), 'de');
    expect((out.match(/application\/ld\+json/g) || []).length).toBe(3);
    expect(out).not.toContain('WebApplication');
  });
});
