import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const cats: any = nodeRequire('../../server/lib/clothingCategories.js');
const resolve: any = nodeRequire('../../server/lib/clothingResolve.js');

const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');

// docs/decisions.md 2026-10-10: winter and summer base sheets are no longer generated; a stored
// story that asked for summer still reads the sheet its character holds, and errors when it is gone.
describe('winter/summer base sheets are stored-only', () => {
  it('generates the standard slot only, reads all three', () => {
    expect([...cats.AVATAR_SLOTS]).toEqual(['standard']);
    expect([...cats.STORED_AVATAR_SLOTS]).toEqual(['standard', 'winter', 'summer']);
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

  const withSummer = { id: 'c1', name: 'Emma', avatars: { standard: IMG + 'STD', summer: IMG + 'SUM' } };
  const standardOnly = { id: 'c2', name: 'Noah', avatars: { standard: IMG + 'STD' } };
  const reqs = (cat: string) => ({ Emma: { _currentClothing: cat }, Noah: { _currentClothing: cat } });

  it('a stored summer story reads the stored summer sheet', () => {
    const [d] = resolve.getCharacterPhotoDetails([withSummer], 'summer', null, reqs('summer'));
    expect(d.photoType).toBe('clothing-summer');
    expect(d.photoUrl).toBe(IMG + 'SUM');
    expect(resolve.getCharacterPhotos([withSummer], 'summer')).toEqual([IMG + 'SUM']);
  });

  it('a missing stored summer sheet is an error, never the standard sheet', () => {
    expect(() => resolve.getCharacterPhotoDetails([standardOnly], 'summer', null, reqs('summer'))).toThrow(/no stored summer sheet/);
    expect(() => resolve.getCharacterPhotos([standardOnly], 'summer')).toThrow(/no stored summer sheet/);
  });

  it('standard no longer borrows a winter/summer sheet', () => {
    const summerOnly = { id: 'c3', name: 'Mia', avatars: { summer: IMG + 'SUM' }, photos: { face: IMG + 'FACE' } };
    const [d] = resolve.getCharacterPhotoDetails([summerOnly], 'standard', null, { Mia: { _currentClothing: 'standard' } });
    expect(d.photoType).not.toBe('clothing-summer');
    expect(d.photoUrl).not.toBe(IMG + 'SUM');
  });
});
