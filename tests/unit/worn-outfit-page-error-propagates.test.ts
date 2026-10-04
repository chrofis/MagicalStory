import { describe, it, expect } from 'vitest';
const { resolveOutfitForStoryPage } = require('../../server/lib/wornItems');

// Code review 2026-10 A10: a bare catch returned the story-level outfit and hid code bugs.
describe('resolveOutfitForStoryPage', () => {
  it('returns the outfit untouched when the page has no brief', () => {
    expect(resolveOutfitForStoryPage('a red coat', 'Mia', { sceneImages: [] }, 3)).toBe('a red coat');
  });
  it('lets an unexpected error propagate instead of returning the story-level outfit', () => {
    const storyData = {
      sceneImages: [{ pageNumber: 1, sceneDescription: 'Mia runs.' }],
      get visualBible() { throw new Error('boom'); },
    };
    expect(() => resolveOutfitForStoryPage('a red coat', 'Mia', storyData, 1)).toThrow('boom');
  });
});
