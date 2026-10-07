/**
 * The waiting page's rotating captions are in the visitor's language on EVERY
 * arrival, with no invented name.
 *
 * The resume paths - the wizard's "View your story" button and the storage
 * recovery after a Google redirect - navigate with storyInput {} and no
 * character name. The slideshow fell back to 'de' and to the English
 * placeholder 'Your hero', so a French or Italian visitor saw German
 * captions, and a German one read "Your hero macht sich bereit für das grosse
 * Abenteuer". Now: the UI language, and only the caption lines without a
 * {name} slot when the name is unknown.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'client', 'src', 'pages', 'TrialGenerationPage.tsx'),
  'utf8'
).split('\r\n').join('\n');

const LANGS = ['en', 'de', 'fr', 'it'] as const;

/** The funnyMessages rows, as { en, de, fr, it } strings. */
function funnyRows(): Record<(typeof LANGS)[number], string>[] {
  const block = PAGE.slice(PAGE.indexOf('const funnyMessages = ['), PAGE.indexOf('];', PAGE.indexOf('const funnyMessages = [')));
  // eslint-disable-next-line no-new-func
  return new Function(`return [${block.slice(block.indexOf('[') + 1)}];`)();
}

describe('waiting-page captions on a resume without a name', () => {
  it('fall back to the UI language, not to German', () => {
    expect(PAGE).toContain("(state?.storyInput?.language || language).split('-')[0]");
    expect(PAGE).not.toContain("storyInput?.language || 'de'");
  });

  it('use no placeholder name: the pool is the lines without a {name} slot', () => {
    expect(PAGE).not.toContain("'Your hero'");
    expect(PAGE).toContain("const funnyPool = characterName ? funnyMessages : funnyMessages.filter(m => !m.en.includes('{name}'));");
    expect(PAGE).toContain('const msg = funnyPool[');
  });

  it('enough nameless lines exist, in every language, for the four funny slots of the intro rotation', () => {
    const rows = funnyRows();
    expect(rows.length).toBeGreaterThan(20);
    const nameless = rows.filter(r => !r.en.includes('{name}'));
    expect(nameless.length).toBeGreaterThanOrEqual(4);
    for (const r of nameless) for (const l of LANGS) expect(r[l], `${l}: ${r.en}`).not.toContain('{name}');
  });

  it('every caption line and every page string exists in all four languages', () => {
    for (const r of funnyRows()) for (const l of LANGS) expect(typeof r[l], r.en).toBe('string');
    const keys = (lang: string) => {
      const start = PAGE.indexOf(`  ${lang}: {`, PAGE.indexOf('const translations = {'));
      const block = PAGE.slice(start, PAGE.indexOf('\n  },', start));
      return (block.match(/^    (\w+):/gm) || []).map(k => k.trim().replace(':', '')).sort();
    };
    for (const l of LANGS.slice(1)) expect(keys(l), l).toEqual(keys('en'));
  });
});
