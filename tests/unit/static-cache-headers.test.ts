/**
 * Cache-Control for files served out of dist/ (server/lib/staticCacheHeaders.js,
 * wired into express.static in server.js). Hashed bundles cache forever, fonts a
 * month, the unhashed city/try images a day, HTML revalidates every time.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cacheControlFor } = require('../../server/lib/staticCacheHeaders.js');

const dist = (...parts: string[]) => path.join(path.sep, 'app', 'dist', ...parts);

describe('cacheControlFor', () => {
  it('hashed Vite assets are immutable for a year', () => {
    expect(cacheControlFor(dist('assets', 'index-CyQkhrkt.js'))).toBe('public, max-age=31536000, immutable');
    expect(cacheControlFor(dist('assets', 'index-DpyeYlmo.css'))).toBe('public, max-age=31536000, immutable');
  });

  it('self-hosted fonts cache for 30 days', () => {
    expect(cacheControlFor(dist('fonts', 'cinzel-400-latin.woff2'))).toBe('public, max-age=2592000');
  });

  it('unhashed images cache for a day', () => {
    expect(cacheControlFor(dist('images', 'cities', 'aarau', 'aarau-book-knight.jpg'))).toBe('public, max-age=86400');
    expect(cacheControlFor(dist('images', 'try', 'step1-photo.webp'))).toBe('public, max-age=86400');
    expect(cacheControlFor(dist('images', 'landing-local.webp'))).toBe('public, max-age=86400');
  });

  it('HTML, the manifest and the prerendered pages keep the revalidating default', () => {
    expect(cacheControlFor(dist('index.html'))).toBeNull();
    expect(cacheControlFor(dist('manifest.json'))).toBeNull();
    expect(cacheControlFor(dist('prerendered', 'index.de.html'))).toBeNull();
    expect(cacheControlFor(dist('og-image.png'))).toBeNull();
  });

  it('matches whole path segments only', () => {
    expect(cacheControlFor(dist('my-assets-notes.html'))).toBeNull();
    expect(cacheControlFor(dist('images-index.html'))).toBeNull();
  });
});
