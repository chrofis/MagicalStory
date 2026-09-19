import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';

const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '../..');

const { parseExplicitSequence } = require_('../../server/lib/coverComposite.js');
/**
 * One resolver decides which character a name refers to. A raw lower-cased
 * equality match sees neither a short form ("Rossa" for "Kapitaenin Rossa") nor
 * a differently spelled diacritic, and the miss is silent: the character drops
 * out of the ordered cover sequence with nothing in the log.
 */
describe('cover hint names resolve through the cast resolver', () => {
  const characters = [
    { name: 'Kapitänin Rossa', id: 'c1' },
    { name: 'Emma', id: 'c2' },
  ];

  it('a short form still resolves to its character', () => {
    const ordered = parseExplicitSequence(
      { characters: ['Rossa (left foreground)', 'Emma (right foreground)'] },
      characters
    );
    expect(ordered?.map((c: any) => c.id)).toEqual(['c1', 'c2']);
  });

  it('an exact name resolves as before', () => {
    const ordered = parseExplicitSequence(
      { characters: ['Emma (left)', 'Kapitänin Rossa (right)'] },
      characters
    );
    expect(ordered?.map((c: any) => c.id)).toEqual(['c2', 'c1']);
  });

  it('a name matching nobody drops the sequence rather than inventing a cast', () => {
    expect(parseExplicitSequence(
      { characters: ['Nobody (left)', 'Noone (right)'] },
      characters
    )).toBeNull();
  });
});

/**
 * Source scan: these sites used to hand-roll `find(c => c.name.toLowerCase()
 * === x.toLowerCase())`. The resolver is the only permitted spelling.
 */
describe('no hand-rolled name matching at the cast sites', () => {
  for (const rel of [
    'server/lib/coverComposite.js',
    'server/lib/compositeCastBuilder.js',
    'server/lib/styledAvatars.js',
    'server/lib/identityAgreement.js',
  ]) {
    it(`${rel} resolves names through castResolver`, () => {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src).toMatch(/require\('\.\/castResolver'\)|require\("\.\/castResolver"\)/);
      // no `.name...toLowerCase() === ...toLowerCase()` character lookups
      expect(src).not.toMatch(/\.name\??\.toLowerCase\(\)\s*===\s*[^;\n]*\.toLowerCase\(\)/);
    });
  }
});
