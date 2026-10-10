/**
 * Styled sheets reach character rows by character ID. Three "Sarah"s (ages 36, 25, 30) on one account all
 * pointed at one sheet because the job's write-back matched rows by name.
 */
import { describe, it, expect } from 'vitest';
const styled = require('../../server/lib/styledAvatars.js');

describe('styled sheets are written back by character id', () => {
  it('the story has one Sarah; only the row with her id gets the sheet', async () => {
    await styled.runInCacheScope('test-sheets-by-id', async () => {
      const storyChars = [{ id: 1787422700342, name: 'Sarah', age: 25 }];
      styled.setStyledAvatar(storyChars[0], 'standard', 'anime', 'data:image/jpeg;base64,STORY_SARAH');
      const rowChars = [
        { id: 1778709155880, name: 'Sarah', age: 36 },
        { id: 1787422700342, name: 'Sarah', age: 25 },
        { id: 1789226690816, name: 'Sarah', age: 30 },
      ] as any[];
      const byId = styled.exportStyledAvatarsForPersistence(storyChars, 'anime', styled.characterIdKey);
      expect(styled.applyStyledAvatarsById(rowChars, byId, 'anime')).toBe(1);
      expect(rowChars[0].avatars).toBeUndefined();
      expect(rowChars[1].avatars.styledAvatars.anime.standard).toContain('STORY_SARAH');
      expect(rowChars[2].avatars).toBeUndefined();
      styled.clearStyledAvatarCache();
    });
  });
  it('a character without an id is refused loudly', () => {
    expect(() => styled.characterIdKey({ name: 'Sarah' })).toThrow(/no id/);
  });
});

describe('the in-run sheet cache is keyed by character id, not name', () => {
  const sarahA = { id: 11, name: 'Sarah', age: 36 };
  const sarahB = { id: 22, name: 'Sarah', age: 25 };
  it('two same-name characters in one run each get their own sheet', async () => {
    await styled.runInCacheScope('test-same-name-own-sheets', async () => {
      styled.setStyledAvatar(sarahA, 'standard', 'anime', 'data:image/jpeg;base64,SHEET_A');
      styled.setStyledAvatar(sarahB, 'standard', 'anime', 'data:image/jpeg;base64,SHEET_B');
      expect(styled.getStyledAvatar(sarahA, 'standard', 'anime')).toContain('SHEET_A');
      expect(styled.getStyledAvatar(sarahB, 'standard', 'anime')).toContain('SHEET_B');
      // a photo detail carries the character id and finds the same sheet
      expect(styled.getStyledAvatar({ id: 22, name: 'Sarah' }, 'standard', 'anime')).toContain('SHEET_B');
      expect(styled.hasStyledAvatar({ id: 33, name: 'Sarah' }, 'standard', 'anime')).toBe(false);
      const byId = styled.exportStyledAvatarsForPersistence([sarahA, sarahB], 'anime', styled.characterIdKey);
      expect(byId.get('11').standard).toContain('SHEET_A');
      expect(byId.get('22').standard).toContain('SHEET_B');
      styled.clearStyledAvatarCache();
    });
  });
  it('applyStyledAvatars gives each same-name photo its own sheet', async () => {
    await styled.runInCacheScope('test-same-name-apply', async () => {
      styled.setStyledAvatar(sarahA, 'standard', 'anime', 'data:image/jpeg;base64,SHEET_A');
      styled.setStyledAvatar(sarahB, 'standard', 'anime', 'data:image/jpeg;base64,SHEET_B');
      const out = styled.applyStyledAvatars([
        { id: 11, name: 'Sarah', clothingCategory: 'standard', photoUrl: 'raw-a' },
        { id: 22, name: 'Sarah', clothingCategory: 'standard', photoUrl: 'raw-b' },
      ], 'anime');
      expect(out[0].photoUrl).toContain('SHEET_A');
      expect(out[1].photoUrl).toContain('SHEET_B');
      styled.clearStyledAvatarCache();
    });
  });
});
