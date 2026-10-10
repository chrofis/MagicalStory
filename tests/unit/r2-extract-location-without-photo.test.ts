/**
 * A Visual Bible location with no photo bytes (fetchStatus pending_lazy) must not crash the story save.
 *
 * The VB-reference key is named by content (r2.contentKey), so it can only be computed from bytes. The
 * location walker computed it for every location, hashed `undefined`, and every save of a story with a
 * photo-less location threw ERR_INVALID_ARG_TYPE (staging job_1791612491444_ezf1ksaku, 2026-10-10).
 *
 * r2 is stubbed; nothing touches the network or a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const r2 = require_('../../server/lib/r2');
const { extractInlineImagesToR2 } = require_('../../server/services/database');

const realIsConfigured = r2.isConfigured;
const realUploadImage = r2.uploadImage;
const bytes = (seed = 'A', n = 4000) => `data:image/jpeg;base64,${seed.repeat(n)}`;

beforeEach(() => {
  r2.isConfigured = vi.fn(() => true);
  r2.uploadImage = vi.fn(async (_input: string, key: string) => `https://r2.example/${key}`);
});
afterEach(() => {
  r2.isConfigured = realIsConfigured;
  r2.uploadImage = realUploadImage;
});

describe('extractInlineImagesToR2 — Visual Bible locations', () => {
  it('saves a story whose location has no photo, and still offloads the one that has', async () => {
    const data: any = {
      visualBible: {
        locations: [
          { id: 'LOC001', name: 'Old town', referencePhotoData: bytes('A') },
          { id: 'LOC002', name: 'Zoo', fetchStatus: 'pending_lazy' },
        ],
      },
    };

    await expect(extractInlineImagesToR2('story_1', data)).resolves.not.toThrow();

    const [withPhoto, without] = data.visualBible.locations;
    expect(withPhoto.referencePhotoUrl).toMatch(/^https:\/\/r2\.example\/stories\/story_1\/vb\/LOC001-[0-9a-f]{24}\.jpg$/);
    expect(withPhoto.referencePhotoData).toBeUndefined();
    expect(without.referencePhotoUrl).toBeUndefined();
  });
});
