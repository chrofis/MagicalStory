import { describe, it, expect, beforeAll } from 'vitest';

// The pure half of the landmark-photo R2 store (migration 035): which URL the
// pipeline is handed for a slot, how the Commons thumbnail URL is formed, and
// the content-stable R2 key that lets slot compaction move a column without
// re-keying its object.

beforeAll(() => {
  process.env.R2_PUBLIC_URL = 'https://images.example.test/';
});

// @ts-expect-error - JS module without types
import { servedPhotoUrl, commonsThumbUrl, colName } from '../../server/lib/landmarkPhotoStore.js';
// @ts-expect-error - JS module without types
import { keyForLandmarkIndexPhoto, keyFromPublicUrl, publicUrlForKey } from '../../server/lib/r2.js';

describe('colName', () => {
  it('slot 1 is unsuffixed, others carry _N', () => {
    expect(colName('photo_r2_url', 1)).toBe('photo_r2_url');
    expect(colName('photo_r2_url', 4)).toBe('photo_r2_url_4');
  });
});

describe('servedPhotoUrl', () => {
  const row = {
    photo_url: 'https://upload.wikimedia.org/a.jpg', photo_r2_url: 'https://images.example.test/landmarks/index/7/abc.jpg',
    photo_url_2: 'https://upload.wikimedia.org/b.jpg', photo_r2_url_2: null,
    photo_url_3: null, photo_r2_url_3: null,
  };
  it('prefers the R2 copy when stored', () => {
    expect(servedPhotoUrl(row, 1)).toBe('https://images.example.test/landmarks/index/7/abc.jpg');
  });
  it('falls back to the Commons source when no copy is stored', () => {
    expect(servedPhotoUrl(row, 2)).toBe('https://upload.wikimedia.org/b.jpg');
  });
  it('is null for an empty slot or a missing row', () => {
    expect(servedPhotoUrl(row, 3)).toBeNull();
    expect(servedPhotoUrl(null, 1)).toBeNull();
  });
});

describe('commonsThumbUrl', () => {
  it('rewrites a Commons master URL to a width-limited Special:FilePath rendering', () => {
    expect(commonsThumbUrl('https://upload.wikimedia.org/wikipedia/commons/3/3f/Schloss_X.jpg'))
      .toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Schloss_X.jpg?width=1280');
  });
  it('unwraps an existing thumb URL to the original filename', () => {
    expect(commonsThumbUrl('https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Schloss_X.jpg/800px-Schloss_X.jpg', 640))
      .toBe('https://commons.wikimedia.org/wiki/Special:FilePath/Schloss_X.jpg?width=640');
  });
  it('passes non-Commons URLs through unchanged', () => {
    expect(commonsThumbUrl('https://example.com/photo.jpg')).toBe('https://example.com/photo.jpg');
    expect(commonsThumbUrl(null)).toBeNull();
  });
});

describe('keyForLandmarkIndexPhoto', () => {
  it('is deterministic and depends on landmark + source, never on the slot', () => {
    const a = keyForLandmarkIndexPhoto(42, 'https://upload.wikimedia.org/x.jpg');
    expect(a).toBe(keyForLandmarkIndexPhoto(42, 'https://upload.wikimedia.org/x.jpg'));
    expect(a).toMatch(/^landmarks\/index\/42\/[0-9a-f]{12}\.jpg$/);
    expect(keyForLandmarkIndexPhoto(42, 'https://upload.wikimedia.org/y.jpg')).not.toBe(a);
    expect(keyForLandmarkIndexPhoto(43, 'https://upload.wikimedia.org/x.jpg')).not.toBe(a);
  });
  it('round-trips through the public URL', () => {
    const key = keyForLandmarkIndexPhoto(42, 'https://upload.wikimedia.org/x.jpg');
    expect(keyFromPublicUrl(publicUrlForKey(key))).toBe(key);
    expect(keyFromPublicUrl('https://upload.wikimedia.org/x.jpg')).toBeNull();
  });
});
