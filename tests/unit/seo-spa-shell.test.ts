import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { getMetaForRoute, renderSpaShell, isAppRoute, NOINDEX_ROUTES, APP_ROUTES } =
  require('../../server/lib/seoMeta.js');

const ROOT = path.resolve(__dirname, '../..');
const shell = fs.readFileSync(path.join(ROOT, 'client/index.html'), 'utf8');
const robots = fs.readFileSync(path.join(ROOT, 'client/public/robots.txt'), 'utf8');
const appTsx = fs.readFileSync(path.join(ROOT, 'client/src/App.tsx'), 'utf8');
const ssrTsx = fs.readFileSync(path.join(ROOT, 'client/src/SSRApp.tsx'), 'utf8');

const routePaths = (src: string) =>
  [...src.matchAll(/<Route path="([^"]+)"/g)].map(m => m[1]).filter(p => p !== '*');

describe('SPA shell: a route without a prerendered page gets its own meta', () => {
  it('/try keeps its title, self-canonical and HowTo in every language', () => {
    for (const lang of ['de', 'en', 'fr', 'it']) {
      const { html, status } = renderSpaShell(shell, '/try', lang);
      expect(status).toBe(200);
      const meta = getMetaForRoute('/try', lang);
      expect(html).toContain(`<title>${meta.title}</title>`);
      expect(html).toContain(`<link rel="canonical" href="${meta.canonical}" />`);
      expect(html).toContain('"@type":"HowTo"');
      expect(html).not.toContain('noindex');
    }
    // BASE_URL comes from the environment, so compare the path part only.
    expect(getMetaForRoute('/try', 'en').canonical).toMatch(/\/try\?lang=en$/);
    expect(getMetaForRoute('/try', 'de').canonical).toMatch(/\/try$/);
  });

  it.each(NOINDEX_ROUTES)('%s answers 200 with noindex and no hreflang', (route) => {
    const { html, status } = renderSpaShell(shell, route, 'de');
    expect(status).toBe(200);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).not.toContain('hreflang=');
    expect(html).not.toContain('application/ld+json">{');
  });

  it('a nested app path (/create/step, /claim/<token>) is still an app route', () => {
    expect(isAppRoute('/create/characters')).toBe(true);
    expect(isAppRoute('/claim/abc123')).toBe(true);
    expect(isAppRoute('/reset-password/xyz/')).toBe(true);
    expect(isAppRoute('/account')).toBe(true);
  });

  it('a path nobody serves answers 404, noindex, without the homepage meta', () => {
    for (const route of ['/nonexistent', '/themes/adventure/does-not-exist', '/tryout']) {
      const { html, status } = renderSpaShell(shell, route, 'en');
      expect(status, route).toBe(404);
      expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
      expect(html).not.toContain('Your Child as the Hero');
    }
    // The retired /geschichten-aus town family keeps its meta (decisions.md
    // 2026-07-10) but has no page, so it is a 404 too.
    expect(renderSpaShell(shell, '/geschichten-aus/zuerich', 'de').status).toBe(404);
  });

  it('every client route is either an app route or an SEO route the prerender renders', () => {
    const ssrRoutes = new Set(routePaths(ssrTsx));
    for (const p of routePaths(appTsx)) {
      const ok = ssrRoutes.has(p) || isAppRoute(p.replace(/\/?(:[a-zA-Z]+|\*)$/, ''));
      expect(ok, `${p} would answer 404`).toBe(true);
    }
  });

  it('every noindex route is disallowed in robots.txt and APP_ROUTES covers it', () => {
    const disallowed = robots.split('\n').filter(l => l.startsWith('Disallow: ')).map(l => l.slice('Disallow: '.length));
    for (const r of NOINDEX_ROUTES) {
      expect(disallowed.some(d => d === r || d === `${r}/`), r).toBe(true);
      expect(APP_ROUTES).toContain(r);
    }
  });
});
