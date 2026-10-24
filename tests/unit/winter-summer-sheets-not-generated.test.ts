import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const cats: any = nodeRequire('../../server/lib/clothingCategories.js');
const resolve: any = nodeRequire('../../server/lib/clothingResolve.js');
const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');

const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');

// docs/decisions.md 2026-10-10 (second entry): winter and summer are not clothing categories at all.
// A season word is prose. A stored page that asked for the category cannot be repaired.
describe('winter/summer are not clothing categories', () => {
  it('one base slot, three category buckets (nightwear added 2026-10-24, docs/decisions.md; a season is still prose)', () => {
    expect([...cats.AVATAR_SLOTS]).toEqual(['standard']);
    expect([...cats.CANONICAL]).toEqual(['standard', 'costumed', 'nightwear']);
    expect(cats.STORED_AVATAR_SLOTS).toBeUndefined();
  });

  it('the prompts no longer offer or style winter/summer', () => {
    for (const f of ['avatar-main-prompt.txt', 'avatar-ace-prompt.txt']) {
      expect(read(f)).not.toMatch(/\[(WINTER|SUMMER)_(FE)?MALE\]/);
    }
    expect(read('story-bible-from-beats.txt')).not.toMatch(/"(winter|summer)"/);
    for (const f of ['scene-briefs-all.txt', 'scene-expansion.txt', 'scene-iteration.txt', 'scene-iteration-free.txt']) {
      expect(read(f)).not.toMatch(/`(winter|summer)`|"clothing": "(winter|summer)"/);
    }
  });

  it('text with a season word resolves by the normal rules and never throws', () => {
    for (const t of ['winter jacket', 'a warm winter coat', 'summer dress', 'Sommer', 'wintertime', 'Winter', 'summer']) {
      expect(cats.normalizeClothingCategory(t)).toBe('standard');
    }
    expect(cats.normalizeClothingCategory('costumed:winter wizard')).toBe('costumed');
    expect(() => resolve.parseClothingCategory('Clothing: a winter jacket')).not.toThrow();
    expect(resolve.parseClothingCategory('Clothing: a winter jacket')).not.toBe('winter');
    expect(resolve.parseClothingCategory('**Clothing:** summer')).not.toBe('summer');
  });

  it('a brief whose metadata says "winter jacket" or "summer" parses to standard/costumed', () => {
    const brief = (clothing: string) => `Ana stands on the quay.\n\n---METADATA---\n${JSON.stringify({
      sceneIntent: 'Ana stands.', shot: 'medium', timeOfDay: 'dusk',
      characters: [{ name: 'Ana', clothing, position: 'center', depth: 'foreground' }],
    })}`;
    for (const c of ['winter jacket', 'summer', 'winter', 'costumed:winter knight', 'standard']) {
      const m = extractSceneMetadata(brief(c));
      const got = m?.characterClothing?.Ana;
      expect(['standard', 'costumed', 'costumed:winter knight', undefined]).toContain(got);
      expect(String(got)).not.toMatch(/^(winter|summer)$/);
    }
  });

  const standardOnly = { id: 'c2', name: 'Noah', avatars: { standard: IMG + 'STD' }, photos: { face: IMG + 'F' } };

  it('a stored page that asked for the removed category errors clearly: no fallback, no repair', () => {
    for (const c of ['summer', 'winter']) {
      expect(() => resolve.getCharacterPhotoDetails([standardOnly], c, null, { Noah: { _currentClothing: c } })).toThrow(/no longer exists/);
      expect(() => resolve.getCharacterPhotos([standardOnly], c)).toThrow(/no longer exists/);
    }
  });

  it('standard and costumed requests are untouched', () => {
    const [d] = resolve.getCharacterPhotoDetails([standardOnly], 'standard', null, { Noah: { _currentClothing: 'standard' } });
    expect(d.photoType).toBe('clothing-standard');
    expect(resolve.getCharacterPhotos([standardOnly], 'standard')).toEqual([IMG + 'STD']);
  });
});
