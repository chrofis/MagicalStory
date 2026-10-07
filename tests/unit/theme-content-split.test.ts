/**
 * Theme-page content is one JSON file per theme, loaded on demand.
 *
 * The catalogue used to be a single 1.6 MB module imported by ThemePage, so every
 * theme page shipped all 181 themes (ThemePage chunk 1,650 kB / 550 kB gzipped,
 * 4x the next-largest file of the build). A theme page needs one entry: the
 * prerender injects it (window.__INITIAL_DATA__.seoData.themeContent), client
 * navigation loads the theme's own ~5 kB chunk. These checks keep the catalogue
 * out of the browser bundle and the split complete.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CLIENT_SRC = path.resolve(__dirname, '../../client/src');
const CONTENT_DIR = path.join(CLIENT_SRC, 'constants/themeContent');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const THEME_ID = /^[a-z0-9-]+$/;
const LANGS = ['en', 'de', 'fr', 'it'];

describe('theme content split', () => {
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.json'));

  it('has one well-formed JSON file per theme', () => {
    expect(files.length).toBeGreaterThan(150);
    for (const file of files) {
      expect(path.basename(file, '.json')).toMatch(THEME_ID);
      const content = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf-8'));
      for (const key of ['description', 'longDescription', 'skills']) {
        for (const lang of LANGS) expect(typeof content[key][lang], `${file} ${key}.${lang}`).toBe('string');
      }
      expect(typeof content.ageRecommendation).toBe('string');
      expect(Array.isArray(content.faq)).toBe(true);
    }
  });

  it('covers every theme the theme pages enumerate', async () => {
    // The same lists ThemePage.findTheme() reads.
    const { storyTypes, lifeChallenges, educationalTopics, historicalEvents } = await import('../../client/src/constants/storyTypes');
    const ids = [...storyTypes, ...lifeChallenges, ...educationalTopics, ...historicalEvents].map((t) => t.id).filter((id) => id !== 'custom');
    expect(ids.length).toBeGreaterThan(100);
    const have = new Set(files.map((f) => path.basename(f, '.json')));
    // 'spelling-name' had no entry in the one-file catalogue either (found by this
    // test, 2026-10-07): its page renders without description/FAQ. Content is the
    // owner's to write; the gap is listed so a second one cannot hide behind it.
    const KNOWN_GAPS = ['spelling-name'];
    const missing = ids.filter((id) => !have.has(id));
    expect(missing).toEqual(KNOWN_GAPS);
  });

  it('only the SSR entry imports the eager catalogue', () => {
    const importers = walk(CLIENT_SRC)
      .filter((f) => /from '[^']*themeContentAll'/.test(fs.readFileSync(f, 'utf-8')))
      .map((f) => path.relative(CLIENT_SRC, f));
    expect(importers).toEqual(['entry-server.tsx']);
  });

  it('the client loads theme content lazily and nothing imports the JSON statically', () => {
    const loader = fs.readFileSync(path.join(CLIENT_SRC, 'constants/themeContent.ts'), 'utf-8');
    expect(loader).toMatch(/import\.meta\.glob<ThemeContent>\('\.\/themeContent\/\*\.json', \{ import: 'default' \}\)/);
    const themePage = fs.readFileSync(path.join(CLIENT_SRC, 'pages/ThemePage.tsx'), 'utf-8');
    expect(themePage).toContain("from '@/hooks/useThemeContent'");
    expect(themePage).not.toMatch(/import \{ themeContent \}/);
    const staticJsonImporters = walk(CLIENT_SRC).filter((f) => /from '[^']*themeContent\/[a-z0-9-]+\.json'/.test(fs.readFileSync(f, 'utf-8')));
    expect(staticJsonImporters).toEqual([]);
  });

  it('the prerender injects the one entry a theme route needs', () => {
    const prerender = fs.readFileSync(path.resolve(__dirname, '../../scripts/prerender.mjs'), 'utf-8');
    expect(prerender).toContain('themeContentForRoute(route)');
    const entry = fs.readFileSync(path.join(CLIENT_SRC, 'entry-server.tsx'), 'utf-8');
    expect(entry).toContain("export { themeContentForRoute } from './constants/themeContentAll'");
  });
});
