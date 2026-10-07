import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { generateSitemap } = require('../../server/lib/seoMeta.js');

let dir: string;
const BUILT = new Date('2026-09-30T10:00:00Z');

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-'));
  // Two prerendered pages, "built" on a fixed day; everything else absent.
  for (const slug of ['/index', '/themes/adventure/pirate']) {
    const f = path.join(dir, `${slug}.de.html`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '<html></html>');
    fs.utimesSync(f, BUILT, BUILT);
  }
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const urlBlock = (xml: string, locSuffix: string) => {
  const blocks = xml.split('<url>').slice(1);
  const b = blocks.find(x => x.includes(`<loc>${locSuffix}</loc>`) || x.includes(`${locSuffix}</loc>`));
  if (!b) throw new Error(`no <url> for ${locSuffix}`);
  return b;
};

describe('sitemap lastmod is the prerendered file build date, never the request date', () => {
  it('a prerendered page carries its file date, in every language entry', () => {
    const xml = generateSitemap({ prerenderDir: dir });
    for (const suffix of ['/themes/adventure/pirate', '/themes/adventure/pirate?lang=en']) {
      expect(urlBlock(xml, suffix)).toContain('<lastmod>2026-09-30</lastmod>');
    }
    expect(xml).not.toContain(`<lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>`);
  });

  it('a URL without a prerendered page (the /try wizard) has no lastmod at all', () => {
    const xml = generateSitemap({ prerenderDir: dir });
    expect(urlBlock(xml, '/try')).not.toContain('<lastmod>');
    expect(urlBlock(xml, '/pricing')).not.toContain('<lastmod>');
  });

  it('refuses to run without the prerender directory instead of inventing dates', () => {
    expect(() => generateSitemap()).toThrow(/prerenderDir/);
  });
});
