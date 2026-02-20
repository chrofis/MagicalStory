import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import { normalizeCoverValue, getCoverData, buildStoryMetadata } from '../../server/services/database.js';

describe('normalizeCoverValue', () => {
  it('returns null for null input', () => {
    expect(normalizeCoverValue(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizeCoverValue(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeCoverValue('')).toBeNull();
  });

  it('converts a base64 string to object format', () => {
    const result = normalizeCoverValue('data:image/png;base64,abc123');
    expect(result).toEqual({ imageData: 'data:image/png;base64,abc123' });
  });

  it('converts a plain string to object format', () => {
    const result = normalizeCoverValue('some-image-data');
    expect(result).toEqual({ imageData: 'some-image-data' });
  });

  it('passes through an object unchanged', () => {
    const cover = { imageData: 'data:image/png;base64,xyz', qualityScore: 8.5, prompt: 'test' };
    const result = normalizeCoverValue(cover);
    expect(result).toBe(cover); // Same reference
    expect(result.qualityScore).toBe(8.5);
    expect(result.prompt).toBe('test');
  });

  it('passes through an object with no imageData', () => {
    const cover = { stripped: true, hasImage: true };
    const result = normalizeCoverValue(cover);
    expect(result).toBe(cover);
  });

  it('passes through an object with imageVersions', () => {
    const cover = {
      imageData: 'data:image/png;base64,main',
      imageVersions: [
        { imageData: 'v1', qualityScore: 7 },
        { imageData: 'v2', qualityScore: 9 }
      ]
    };
    const result = normalizeCoverValue(cover);
    expect(result).toBe(cover);
    expect(result.imageVersions).toHaveLength(2);
  });
});

describe('getCoverData', () => {
  it('returns null for null input', () => {
    expect(getCoverData(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(getCoverData(undefined)).toBeNull();
  });

  it('returns imageData from object', () => {
    expect(getCoverData({ imageData: 'data:image/png;base64,abc' })).toBe('data:image/png;base64,abc');
  });

  it('returns null for object without imageData', () => {
    expect(getCoverData({ stripped: true })).toBeNull();
  });

  it('returns null for object with empty imageData', () => {
    expect(getCoverData({ imageData: '' })).toBeNull();
  });

  it('returns null for object with null imageData', () => {
    expect(getCoverData({ imageData: null })).toBeNull();
  });
});

describe('buildStoryMetadata', () => {
  const baseStory = {
    id: 'story-123',
    title: 'Test Story',
    createdAt: '2025-01-01',
    updatedAt: '2025-01-02',
    pages: 10,
    language: 'en',
    languageLevel: 'B1',
    generatedPages: 10,
    totalPages: 10,
    characters: [
      { id: 'char-1', name: 'Alice', role: 'protagonist' },
      { id: 'char-2', name: 'Bob', role: 'friend' }
    ],
    sceneImages: [{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }],
    coverImages: {
      frontCover: { imageData: 'data:image/png;base64,abc' },
      initialPage: null,
      backCover: null
    }
  };

  it('extracts basic metadata fields', () => {
    const meta = buildStoryMetadata(baseStory);
    expect(meta.id).toBe('story-123');
    expect(meta.title).toBe('Test Story');
    expect(meta.language).toBe('en');
    expect(meta.pages).toBe(10);
  });

  it('counts scene images', () => {
    const meta = buildStoryMetadata(baseStory);
    expect(meta.sceneCount).toBe(3);
  });

  it('handles missing sceneImages', () => {
    const meta = buildStoryMetadata({ ...baseStory, sceneImages: undefined });
    expect(meta.sceneCount).toBe(0);
  });

  it('detects thumbnail from frontCover with imageData', () => {
    const meta = buildStoryMetadata(baseStory);
    expect(meta.hasThumbnail).toBe(true);
  });

  it('detects thumbnail from frontCover with hasImage flag', () => {
    const story = {
      ...baseStory,
      coverImages: { frontCover: { hasImage: true }, initialPage: null, backCover: null }
    };
    const meta = buildStoryMetadata(story);
    expect(meta.hasThumbnail).toBe(true);
  });

  it('detects thumbnail from story.thumbnail fallback', () => {
    const story = {
      ...baseStory,
      coverImages: { frontCover: null, initialPage: null, backCover: null },
      thumbnail: 'data:image/png;base64,thumb'
    };
    const meta = buildStoryMetadata(story);
    expect(meta.hasThumbnail).toBe(true);
  });

  it('reports no thumbnail when nothing available', () => {
    const story = {
      ...baseStory,
      coverImages: { frontCover: null, initialPage: null, backCover: null }
    };
    const meta = buildStoryMetadata(story);
    expect(meta.hasThumbnail).toBe(false);
  });

  it('strips characters to id and name only', () => {
    const meta = buildStoryMetadata(baseStory);
    expect(meta.characters).toEqual([
      { id: 'char-1', name: 'Alice' },
      { id: 'char-2', name: 'Bob' }
    ]);
  });

  it('handles missing characters', () => {
    const meta = buildStoryMetadata({ ...baseStory, characters: undefined });
    expect(meta.characters).toEqual([]);
  });

  it('defaults isPartial to false', () => {
    const meta = buildStoryMetadata(baseStory);
    expect(meta.isPartial).toBe(false);
  });

  it('preserves isPartial when true', () => {
    const meta = buildStoryMetadata({ ...baseStory, isPartial: true });
    expect(meta.isPartial).toBe(true);
  });
});
