/**
 * Styled sheets reach character rows by character ID. Three "Sarah"s (ages 36, 25, 30) on one account all
 * pointed at one sheet because the job's write-back matched rows by name.
 */
import { describe, it, expect } from 'vitest';
const styled = require('../../server/lib/styledAvatars.js');

describe('styled sheets are written back by character id', () => {
  it('the story has one Sarah; only the row with her id gets the sheet', async () => {
    await styled.runInCacheScope('test-sheets-by-id', async () => {
      styled.setStyledAvatar('Sarah', 'standard', 'anime', 'data:image/jpeg;base64,STORY_SARAH');
      const storyChars = [{ id: 1787422700342, name: 'Sarah', age: 25 }];
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
