import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { getMetaForRoute } = require('../../server/lib/seoMeta.js');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const OCCASIONS = [
  'geburtstag', 'weihnachten', 'ostern', 'taufe', 'einschulung', 'geschwisterchen',
  'muttertag', 'vatertag', 'nikolaus', 'advent', 'umzug', 'kindergartenstart',
];

describe('occasion page meta description: full prepositional phrase per occasion', () => {
  const DE_PHRASE = /^Das perfekte Geschenk (zum|zur|zu) [A-ZÄÖÜ][\wäöüÄÖÜ]+:/;
  it.each(OCCASIONS)('%s reads correctly in German and English', (slug) => {
    const de = getMetaForRoute(`/anlass/${slug}`, 'de').description as string;
    const en = getMetaForRoute(`/anlass/${slug}`, 'en').description as string;
    expect(de).toMatch(DE_PHRASE);
    expect(en).toMatch(/^The perfect gift for (a |an |the )?[\w .'’]+:/);
    expect(de).not.toMatch(/undefined/);
    expect(en).not.toMatch(/undefined/);
  });
  it('uses the grammatically right German preposition for feminine and plural-only nouns', () => {
    expect(getMetaForRoute('/anlass/taufe', 'de').description).toContain('Geschenk zur Taufe:');
    expect(getMetaForRoute('/anlass/einschulung', 'de').description).toContain('Geschenk zur Einschulung:');
    expect(getMetaForRoute('/anlass/weihnachten', 'de').description).toContain('Geschenk zu Weihnachten:');
    expect(getMetaForRoute('/anlass/ostern', 'de').description).toContain('Geschenk zu Ostern:');
    expect(getMetaForRoute('/anlass/geburtstag', 'de').description).toContain('Geschenk zum Geburtstag:');
  });
  it('English gets an article where the noun needs one', () => {
    expect(getMetaForRoute('/anlass/geburtstag', 'en').description).toContain('gift for a birthday:');
    expect(getMetaForRoute('/anlass/taufe', 'en').description).toContain('gift for a baptism:');
    expect(getMetaForRoute('/anlass/geschwisterchen', 'en').description).toContain('gift for a new sibling:');
  });
});

describe('CityPage copy never glues a possessive onto the city name', () => {
  // "Davos" + "s" and "Davos's" are both wrong for the ~21 names ending in s/z/x;
  // the copy uses "von {city}" / "of {city}" which works for every name.
  const src = read('client/src/pages/CityPage.tsx');
  it('has no {city}s or {city}\'s constructions', () => {
    expect(src).not.toMatch(/\{city\}s\b/);
    expect(src).not.toMatch(/\{city\}\\?'s\b/);
  });
  it('German uses the "von {city}" form', () => {
    expect(src).toContain('Geschichte von {city}');
  });
});

describe('book prices follow the production pricing tiers (owner decision 2026-10-05)', () => {
  const files = [
    ...walk(path.join(ROOT, 'client/src')),
    path.join(ROOT, 'server/lib/seoMeta.js'),
    path.join(ROOT, 'emails-src/i18n.ts'),
  ];
  it('no client/seo string states the obsolete CHF 33 / CHF 28 / CHF 43 / 33-48 book prices', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const s = fs.readFileSync(f, 'utf8');
      for (const re of [/CHF ?33\b(?![-–]\d)/, /CHF ?28\b/, /CHF ?43 (für|for|en|per) /i, /33[–-]48/, /CHF ?30[–-]53/]) {
        if (re.test(s)) offenders.push(`${path.relative(ROOT, f)} ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
  it('the client fallback tiers (utils/bookPricing.ts) equal the tiers seeded into pricing_tiers', () => {
    const parse = (s: string, re: RegExp) =>
      [...s.matchAll(re)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
    const fallback = parse(
      read('client/src/utils/bookPricing.ts').split('fallbackPricingTiers')[1].split('];')[0],
      /maxPages: (\d+), label: '[^']+', softcover: (\d+), hardcover: (\d+)/g,
    );
    const seeded = parse(
      read('server/services/database.js').split('const defaultTiers = [')[1].split('];')[0],
      /maxPages: (\d+),\s*label: '[^']+',\s*softcover: (\d+),\s*hardcover: (\d+)/g,
    );
    expect(fallback.length).toBe(8);
    expect(fallback).toEqual(seeded);
  });
});

describe('facts that must agree across every page', () => {
  const texts = [read('client/src/constants/giftData.ts'), read('client/src/constants/occasionData.ts'), read('server/lib/seoMeta.js')].join('\n');
  it('delivery is always stated in business days', () => {
    expect(texts).not.toMatch(/5[–-]7 (Tagen?|days|giorni)\b(?! lavorativi| business)/);
    expect(texts).not.toMatch(/5 à 7 jours(?! ouvrables)/);
  });
  it('the Swiss city count matches swiss-cities.json', () => {
    const count = JSON.parse(read('server/data/swiss-cities.json')).cities.length;
    const m = [...read('server/lib/seoMeta.js').matchAll(/(\d+) (Schweizer Städten|Swiss cities|villes suisses|città svizzere)/g)];
    expect(m.length).toBeGreaterThan(0);
    for (const x of m) expect(Number(x[1])).toBe(count);
  });
});
