import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getMetaForRoute, THEMES } = require('../../server/lib/seoMeta.js');

const LANGS = ['de', 'fr', 'it', 'en'];
const routes: string[] = [];
for (const c of Object.keys(THEMES)) for (const t of Object.keys(THEMES[c])) routes.push(`/themes/${c}/${t}`);

describe('theme page titles', () => {
  it('covers every theme', () => expect(routes.length).toBeGreaterThan(150));

  for (const lang of LANGS) {
    describe(lang, () => {
      const titles = routes.map(r => ({ r, title: getMetaForRoute(r, lang).title as string }));

      it('never glues the theme name into a grammatical slot (the broken "Personalisiertes Geheimer Ninja-Kinderbuch")', () => {
        for (const { r, title } of titles) {
          expect(title, r).not.toMatch(/^Personalisiertes /);
          expect(title, r).not.toMatch(/-Kinderbuch/);
          expect(title, r).not.toMatch(/^Personalized .* Story \|/);
          expect(title, r).not.toMatch(/\bStory Story\b/);
          expect(title, r).not.toMatch(/^(Livre|Libro) personnalisé|^Libro personalizzato/);
        }
      });

      it('has the brand MagicalStory.ch, the "<theme> – <product>" shape, and no duplicates', () => {
        for (const { r, title } of titles) expect(title, r).toMatch(/^.+ – .+ \| MagicalStory\.ch$/);
        expect(new Set(titles.map(t => t.title)).size).toBe(titles.length);
      });

      it('stays near the display limit', () => {
        const lens = titles.map(t => t.title.length);
        expect(Math.max(...lens)).toBeLessThanOrEqual(72);
        expect(lens.filter(l => l <= 62).length / lens.length).toBeGreaterThan(0.85);
      });
    });
  }

  it('gives the examples from the audit a grammatical title', () => {
    const all = routes.map(r => getMetaForRoute(r, 'de').title as string);
    expect(all).toContain('Geheimer Ninja – personalisiertes Kinderbuch | MagicalStory.ch');
    expect(all.some(t => t.startsWith('Cowboys und Indianer – '))).toBe(true);
  });
});
