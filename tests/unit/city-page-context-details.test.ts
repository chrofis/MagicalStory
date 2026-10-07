import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// The per-idea historical context on /stadt/:cityId (~600 words a city) was rendered inside a
// `hidden` div behind a button - in the DOM, never read as page content. It is now a native
// <details>/<summary> with the existing localised contextLabel as the summary (2026-10-07).
const ROOT = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'pages', 'CityPage.tsx'), 'utf-8');

describe('CityPage historical context is a native disclosure', () => {
  it('uses <details>/<summary> with the localised label', () => {
    expect(src).toMatch(/<details\s/);
    expect(src).toMatch(/<summary[^>]*>[\s\S]*?\{t\.contextLabel\}[\s\S]*?<\/summary>/);
    expect(src).toMatch(/<\/summary>[\s\S]*?\{loc\(idea\.context\)\}[\s\S]*?<\/details>/);
  });

  it('no longer hides the context with a class toggle', () => {
    expect(src).not.toMatch(/isOpen \? '' : 'hidden'/);
    expect(src).not.toContain("'hidden'");
  });

  it('the summary label exists in every language the page supports', () => {
    for (const lang of ['en', 'de', 'fr', 'it']) {
      const block = src.match(new RegExp(`^  ${lang}: \\{[\\s\\S]*?^  \\},`, 'm'));
      expect(block, lang).toBeTruthy();
      expect(block![0]).toMatch(/contextLabel: '[^']+'/);
    }
  });
});
