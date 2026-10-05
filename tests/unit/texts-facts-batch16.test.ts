// Owner decisions 2026-10-05 (docs/decisions.md): A4 print size, Switzerland-only shipping,
// 10-character cap per story, two-word brand "Magical Story" in customer-visible text.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { localizedApiError } from '../../client/src/utils/apiErrors';
import { MAX_CHARACTERS_PER_STORY } from '../../client/src/utils/mainCharacters';

const require = createRequire(import.meta.url);
const guards = require('../../server/lib/requestGuards.js');
const printConfig = require('../../server/config/print.js');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js)$/.test(e.name)) out.push(rel);
  }
  return out;
}

// Files whose strings customers read (pages, constants, SEO meta, emails).
const CUSTOMER_TEXT_FILES = [
  ...walk('client/src/pages'),
  ...walk('client/src/constants'),
  'server/lib/seoMeta.js',
  'emails-src/i18n.ts',
  'email.js',
];

describe('print size: A4, never the legacy 20x20 square, in customer text', () => {
  it.each(CUSTOMER_TEXT_FILES)('%s states no 20x20 book size', (f) => {
    expect(read(f)).not.toMatch(/20 ?(x|×) ?20/);
  });
});

describe('shipping: Switzerland only', () => {
  it('the shared country list is CH and the checkout uses it', () => {
    expect(printConfig.PRINT_SHIPPING_COUNTRIES).toEqual(['CH']);
    const src = read('server/routes/print.js');
    expect(src).toContain('allowed_countries: PRINT_SHIPPING_COUNTRIES');
    expect(src).not.toMatch(/allowed_countries:\s*\[/);
  });
  it('the FAQ makes no international shipping claim in any language', () => {
    expect(read('client/src/pages/FAQ.tsx')).not.toMatch(/International shipping|Internationaler Versand|livraison internationale|spedizione internazionale/i);
  });
});

describe('10 characters per story', () => {
  it('server and client share the same cap', () => {
    expect(guards.CHARACTERS_MAX).toBe(10);
    expect(MAX_CHARACTERS_PER_STORY).toBe(guards.CHARACTERS_MAX);
  });
  it('characterListError accepts 10 and refuses 11', () => {
    const cast = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, age: 5, gender: 'female' }));
    expect(guards.characterListError(cast(10))).toBeNull();
    expect(guards.characterListError(cast(11))).toMatch(/too many characters/);
  });
  it('the create-story route answers 400 with the stable code', () => {
    const src = read('server/routes/jobs.js');
    expect(src).toMatch(/characters\.length > CHARACTERS_MAX[\s\S]{0,400}status\(400\)[\s\S]{0,200}code: TOO_MANY_CHARACTERS/);
    expect(guards.TOO_MANY_CHARACTERS).toBe('TOO_MANY_CHARACTERS');
  });
  it('the code is explained in all four languages, naming the cap', () => {
    const en = localizedApiError({ code: 'TOO_MANY_CHARACTERS' }, 'en');
    expect(en).toContain('10');
    for (const l of ['de', 'fr', 'it']) {
      const txt = localizedApiError({ code: 'TOO_MANY_CHARACTERS' }, l);
      expect(txt).toContain('10');
      expect(txt).not.toBe(en);
    }
  });
  it('no customer text says "up to 3 characters"', () => {
    for (const f of ['client/src/constants/giftData.ts', 'client/src/constants/occasionData.ts']) {
      expect(read(f)).not.toMatch(/up to 3 characters|bis zu 3 Charaktere|jusqu.à 3 personnages|fino a 3 personaggi/);
    }
  });
});

describe('brand: "Magical Story" in two words in customer text', () => {
  // Identifiers stay one word: user agents (MagicalStory/1.0), domain (MagicalStory.ch), handles.
  const ONE_WORD = /(?<![\w./@#-])MagicalStory(?![\w/@])(?!\.ch)/;
  it.each([...CUSTOMER_TEXT_FILES, 'client/public/manifest.json', 'server/routes/sharing.js', 'emails-src/components/Footer.tsx'])(
    '%s has no one-word brand in visible text', (f) => {
      expect(read(f)).not.toMatch(ONE_WORD);
    });
});
