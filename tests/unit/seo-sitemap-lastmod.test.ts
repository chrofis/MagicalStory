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
  // Each page carries ITS SET's date from the manifest (git's last content change), never the build day.
  // Asserting that sets "differ" was a calendar assumption: a site-wide text pass (2026-11-13) legitimately
  // gives every set the same date. The 'committed dates match git' test below keeps the dates honest.
  it('every page carries its set date from the manifest', () => {
    const xml = generateSitemap();
    let checked = 0;
    for (const set of Object.values(manifest.sets) as any[]) {
      for (const route of set.routes.filter((r: string) => !/[*:]/.test(r))) {
        expect(lastmodForRoute(route), route).toBe(set.lastmod);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    const theme = lastmodForRoute('/themes/life-challenges/first-steps');
    expect(theme).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const loc of ['/themes/life-challenges/first-steps', '/themes/life-challenges/first-steps?lang=fr']) { // only life-challenge themes keep ?lang= entries (2026-11-09)
      expect(urlBlock(xml, loc)).toContain(`<lastmod>${theme}</lastmod>`);
    }
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
