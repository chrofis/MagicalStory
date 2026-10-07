import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { withLang, langSuffix, DEFAULT_LANGUAGE } from '../../client/src/utils/langPath';

// Language variants are ?lang= query URLs; German is the default and is written bare. The hreflang
// table in server/lib/seoMeta.js (buildHreflang) is the contract: de → `${p}`, fr/it/en → `${p}?lang=xx`.
// Before 2026-10-07 only GuideHub, GuidePage and the Footer appended the suffix; every other content
// page linked the German URL from its fr/it/en variant.
const ROOT = path.resolve(__dirname, '../..');

describe('langPath: default-language URLs stay bare', () => {
  it('German is the default and gets no parameter', () => {
    expect(DEFAULT_LANGUAGE).toBe('de');
    expect(langSuffix('de')).toBe('');
    expect(withLang('/stadt/bern', 'de')).toBe('/stadt/bern');
    expect(withLang('/try?category=adventure&topic=pirates', 'de')).toBe('/try?category=adventure&topic=pirates');
  });

  it('empty / unknown language is treated as the default', () => {
    expect(langSuffix('')).toBe('');
    expect(langSuffix(null)).toBe('');
    expect(langSuffix(undefined)).toBe('');
    expect(withLang('/anlass', undefined)).toBe('/anlass');
  });

  it('matches the hreflang contract in seoMeta.js for de', () => {
    const seo = fs.readFileSync(path.join(ROOT, 'server', 'lib', 'seoMeta.js'), 'utf-8');
    // de is the bare path (no ?lang=de anywhere in the hreflang builder)
    expect(seo).toMatch(/\{ lang: 'de', href: `\$\{BASE_URL\}\$\{p\}` \}/);
    expect(seo).not.toContain('?lang=de');
  });
});

describe('langPath: non-default languages carry ?lang=', () => {
  it.each(['fr', 'it', 'en'])('%s suffix', (lang) => {
    expect(langSuffix(lang)).toBe(`?lang=${lang}`);
    expect(withLang('/stadt/bern', lang)).toBe(`/stadt/bern?lang=${lang}`);
    expect(withLang('/', lang)).toBe(`/?lang=${lang}`);
  });

  it('joins with & when the path already has a query', () => {
    expect(withLang('/try?category=life-challenge&topic=moving-house', 'fr'))
      .toBe('/try?category=life-challenge&topic=moving-house&lang=fr');
  });

  it('keeps a hash last', () => {
    expect(withLang('/faq#delivery', 'it')).toBe('/faq?lang=it#delivery');
    expect(withLang('/try?x=1#top', 'en')).toBe('/try?x=1&lang=en#top');
  });
});

describe('langPath: every content page routes its internal links through the helper', () => {
  const pages = [
    'CityPage', 'ThemePage', 'ThemeCategory', 'Themes', 'OccasionPage', 'Occasions', 'GiftPage', 'GiftHub',
    'CityListing', 'Comparisons', 'ComparisonPage', 'LandingPage', 'GuideHub', 'GuidePage',
  ];
  it.each(pages)('%s has no bare internal <Link to="/…"> or <Navigate to="/…">', (name) => {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'pages', `${name}.tsx`), 'utf-8');
    expect(src).toContain("useLangPath");
    const bare = src.match(/\bto=(?:"\/[^"]*"|\{`\/[^`]*`\})/g) || [];
    expect(bare).toEqual([]);
  });

  it('the Footer uses the same helper (one implementation, no inline suffix)', () => {
    for (const f of ['components/common/Footer.tsx', 'pages/GuideHub.tsx', 'pages/GuidePage.tsx']) {
      const src = fs.readFileSync(path.join(ROOT, 'client', 'src', f), 'utf-8');
      expect(src).toContain('useLangPath');
      expect(src).not.toMatch(/\?lang=\$\{/);
    }
  });
});
