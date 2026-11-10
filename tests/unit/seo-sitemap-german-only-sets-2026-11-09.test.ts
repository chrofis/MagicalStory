/**
 * The sitemap lists only the German URL of the templated theme, city, occasion and gift pages
 * (owner decision 2026-11-09, after a Search Console audit found 860 pages "crawled - currently
 * not indexed", mostly their ?lang= copies). Life-challenge themes, comparisons, guides and static
 * pages keep all four languages. Every entry still names all language alternates.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { generateSitemap } = req('../../server/lib/seoMeta');

const xml: string = generateSitemap();
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&').replace(/^https?:\/\/[^/]+/, '')); // host differs per env
const listed = (prefix: RegExp) => locs.filter((l) => prefix.test(l));

describe('sitemap language copies', () => {
  it('lists no ?lang= copy of city, occasion and gift pages, but every German one', () => {
    for (const seg of ['stadt', 'anlass', 'geschenk']) {
      expect(listed(new RegExp(`/${seg}/[^?]+\\?lang=`))).toEqual([]);
      expect(listed(new RegExp(`/${seg}/[^?]+$`)).length).toBeGreaterThan(5);
    }
  });
  it('lists ?lang= copies only for life-challenge themes', () => {
    const copies = listed(/\/themes\/[^?]+\?lang=/);
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter((l) => !l.includes('/themes/life-challenges'))).toEqual([]);
    expect(listed(/\/themes\/(?!life-challenges)[^?]+$/).length).toBeGreaterThan(50);
  });
  it('keeps all four languages for comparisons, guides and static pages', () => {
    for (const lang of ['en', 'fr', 'it']) {
      expect(listed(new RegExp(`/pricing\\?lang=${lang}$`)).length).toBe(1);
      expect(listed(new RegExp(`/vergleich/[^?]+\\?lang=${lang}$`)).length).toBeGreaterThan(0);
      expect(listed(new RegExp(`/ratgeber/[^?]+\\?lang=${lang}$`)).length).toBeGreaterThan(0);
    }
  });
  it('still names the language alternates on a German-only entry', () => {
    const entry = xml.split('<url>').find((e) => /<loc>[^<]*\/stadt\/[^<?]+<\/loc>/.test(e))!;
    expect(entry).toMatch(/hreflang="fr-CH" href="[^"]+\?lang=fr"/);
    expect(entry).toMatch(/hreflang="it-CH" href="[^"]+\?lang=it"/);
  });
  it('shrinks the sitemap to roughly 620 URLs', () => {
    expect(locs.length).toBeGreaterThan(560);
    expect(locs.length).toBeLessThan(700);
  });
});
