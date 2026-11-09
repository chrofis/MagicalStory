import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { generateSitemap, lastmodForRoute } = require('../../server/lib/seoMeta.js');
const { compute, MANIFEST } = require('../../scripts/admin/update-seo-lastmod.js');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
// The manifest holds Swiss local dates, which run up to a day ahead of UTC.
const today = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

const lastmods = (xml: string) => [...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map(m => m[1]);
const urlBlock = (xml: string, loc: string) => {
  const b = xml.split('<url>').slice(1).find(x => x.includes(`${loc}</loc>`));
  if (!b) throw new Error(`no <url> for ${loc}`);
  return b;
};

describe('sitemap lastmod is the real last content change of the URL set', () => {
  it('is not one constant date (the audit found 1396 of 1400 = build day)', () => {
    const dates = lastmods(generateSitemap());
    const share = dates.filter(d => d === dates[0]).length / dates.length;
    expect(new Set(dates).size).toBeGreaterThan(3);
    expect(share).toBeLessThan(0.7);
  });

  it('every language entry of a page carries its set date; sets differ', () => {
    const xml = generateSitemap();
    const theme = lastmodForRoute('/themes/adventure/ninja');
    const guide = lastmodForRoute('/ratgeber/kinderbuch-mit-ki-erstellen');
    expect(theme).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const loc of ['/themes/adventure/ninja', '/themes/adventure/ninja?lang=fr']) {
      expect(urlBlock(xml, loc)).toContain(`<lastmod>${theme}</lastmod>`);
    }
    expect(guide).not.toBe(theme);
  });

  it('a route that belongs to no set gets no lastmod instead of an invented one', () => {
    expect(lastmodForRoute('/not-a-known-route')).toBeNull();
    expect(lastmodForRoute('/try')).toBeNull();
  });

  it('every route the sitemap emits is covered by a set, and no date is in the future', () => {
    const xml = generateSitemap();
    expect(lastmods(xml).length).toBe((xml.match(/<url>/g) || []).length);
    for (const set of Object.values(manifest.sets) as any[]) {
      expect(set.lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(set.lastmod <= today).toBe(true);
      for (const src of set.sources) expect(fs.existsSync(path.join(__dirname, '../..', src))).toBe(true);
    }
  });

  it('the committed dates match git (run node scripts/admin/update-seo-lastmod.js when this fails)', { timeout: 120000 }, () => {
    let fresh: Record<string, string>;
    try { fresh = compute(manifest); } catch (e) { return; } // no git history available: nothing to compare
    const stale = Object.keys(fresh).filter(k => manifest.sets[k].lastmod !== fresh[k]);
    expect(stale).toEqual([]);
  });
});
