import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { getMetaForRoute, generateSitemap, injectMeta } = require('../../server/lib/seoMeta.js');
const LANGS = ['de', 'fr', 'it', 'en'];

describe('/try (the wizard, 0 words of body) is not offered to Google', () => {
  it('is noindex in every language, still routable, and not in the sitemap', () => {
    for (const lang of LANGS) {
      const meta = getMetaForRoute('/try', lang);
      expect(meta.noindex).toBe(true);
      expect(meta.hreflang).toEqual([]);
      expect(injectMeta('<html><head><meta name="robots" content="index, follow" /></head></html>', meta, lang))
        .toContain('content="noindex, nofollow"');
    }
    const xml = generateSitemap();
    expect(xml).not.toMatch(/<loc>[^<]*\/try(\?[^<]*)?<\/loc>/);
  });

  it('robots.txt does not block it (a blocked page could never show its noindex)', () => {
    const robots = fs.readFileSync(path.join(__dirname, '../../client/public/robots.txt'), 'utf8');
    expect(robots).not.toMatch(/^Disallow:\s*\/try\s*$/m);
  });
});

describe('gift page titles are unique per language', () => {
  const slugs = [...generateSitemap().matchAll(/<loc>[^<]*\/geschenk\/([^<?]+)<\/loc>/g)].map(m => m[1]);
  it.each(LANGS)('%s', (lang) => {
    const uniq = [...new Set(slugs)];
    expect(uniq.length).toBeGreaterThan(10);
    const titles = uniq.map(s => getMetaForRoute(`/geschenk/${s}`, lang).title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('roundup pages are not described as "Magical Story vs <roundup name>"', () => {
  it.each(LANGS)('%s', (lang) => {
    for (const slug of ['beste-ki-kinderbuch-generatoren', 'beste-personalisierte-kinderbuecher']) {
      const d = getMetaForRoute(`/vergleich/${slug}`, lang).description as string;
      expect(d).not.toMatch(/Magical Story vs /);
      expect(d).not.toMatch(/Beste (KI-Generatoren|Kinderbücher)/);
      expect(d.length).toBeLessThanOrEqual(170);
    }
  });
  it('real competitor pages keep the vs description', () => {
    expect(getMetaForRoute('/vergleich/wonderbly', 'de').description).toContain('Magical Story vs Wonderbly');
  });
});

describe('homepage image alt texts are localised through the page translations', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../client/src/pages/LandingPage.tsx'), 'utf8');
  it('no hardcoded English alt literal remains', () => {
    const literal = [...src.matchAll(/\balt="([^"]+)"/g)].map(m => m[1]);
    expect(literal).toEqual([]);
  });
  it('yourPicture / yourCharacter exist in all four languages', () => {
    for (const key of ['yourPicture', 'yourCharacter']) {
      expect((src.match(new RegExp(`^\\s+${key}: `, 'gm')) || []).length).toBe(4);
    }
  });
});
