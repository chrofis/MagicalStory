/**
 * extractInlineImagesToR2 — one upload per distinct image, semantic key wins.
 *
 * The function has two phases that both see the SAME base64 string: an
 * explicit per-field walker that mints semantic keys
 * (`stories/{id}/debug/p1/landmark-0.jpg`) and a generic "Phase 1.5" sweep
 * that catches anything the walker missed under an opaque `/aux/` key.
 *
 * The sweep runs before any apply() has landed, so the bytes are still in the
 * tree and it re-queued them: every explicitly-walked field was uploaded
 * TWICE, and because the /aux/ task is queued later its apply() usually lands
 * last — so the stored URL was the opaque one and the semantic key was
 * cosmetic. This pins the intended behaviour.
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

const keysUploaded = () => (r2.uploadImage as any).mock.calls.map((c: any[]) => c[1] as string);

describe('extractInlineImagesToR2 — explicit walker vs generic sweep', () => {
  it('uploads an explicitly-walked field exactly once, under its semantic key', async () => {
    const data: any = {
      sceneImages: [{
        pageNumber: 1,
        landmarkPhotos: [{ photoData: bytes('A') }],
      }],
    };

    await extractInlineImagesToR2('story_1', data);

    expect(keysUploaded()).toHaveLength(1);
    expect(keysUploaded()[0]).not.toContain('/aux/');
    expect(data.sceneImages[0].photoData).toBeUndefined();
    expect(data.sceneImages[0].landmarkPhotos[0].photoUrl).toBe(
      `https://r2.example/${keysUploaded()[0]}`
    );
    expect(data.sceneImages[0].landmarkPhotos[0].photoUrl).not.toContain('/aux/');
  });

  it('keeps the plate-diagnostic key for empty-scene refs (c936e1d06)', async () => {
    const data: any = {
      sceneImages: [{ pageNumber: 3, emptySceneGrokRefImages: [bytes('B'), bytes('C')] }],
    };

    await extractInlineImagesToR2('story_2', data);

    expect(keysUploaded().sort()).toEqual([
      'stories/story_2/debug/p3/empty-scene-ref-0.jpg',
      'stories/story_2/debug/p3/empty-scene-ref-1.jpg',
    ]);
    expect(data.sceneImages[0].emptySceneGrokRefImages).toEqual([
      'https://r2.example/stories/story_2/debug/p3/empty-scene-ref-0.jpg',
      'https://r2.example/stories/story_2/debug/p3/empty-scene-ref-1.jpg',
    ]);
  });

  it('still sweeps fields the explicit walker does not know about', async () => {
    const data: any = {
      someNewFeature: { snapshots: [{ imageData: bytes('D') }] },
    };

    await extractInlineImagesToR2('story_3', data);

    expect(keysUploaded()).toHaveLength(1);
    expect(keysUploaded()[0]).toContain('/aux/');
    expect(data.someNewFeature.snapshots[0].imageData).toBe(
      `https://r2.example/${keysUploaded()[0]}`
    );
  });

  it('gives a second field holding the SAME bytes the same URL, not stale base64', async () => {
    // The identical avatar reference legitimately appears in an explicitly
    // walked slot and in an unknown one. Dedupe must not leave the second
    // slot holding base64 — the strip that runs next would drop it entirely.
    const shared = bytes('E');
    const data: any = {
      sceneImages: [{ pageNumber: 1, landmarkPhotos: [{ photoData: shared }] }],
      someNewFeature: { copyOfTheSamePhoto: shared },
    };

    await extractInlineImagesToR2('story_4', data);

    expect(keysUploaded()).toHaveLength(1);
    const url = `https://r2.example/${keysUploaded()[0]}`;
    expect(url).not.toContain('/aux/');
    expect(data.sceneImages[0].landmarkPhotos[0].photoUrl).toBe(url);
    expect(data.someNewFeature.copyOfTheSamePhoto).toBe(url);
  });

  it('uploads two DIFFERENT images in unknown fields separately', async () => {
    const data: any = { a: { x: bytes('F') }, b: { y: bytes('G') } };

    await extractInlineImagesToR2('story_5', data);

    expect(keysUploaded()).toHaveLength(2);
    expect(new Set(keysUploaded()).size).toBe(2);
    expect(data.a.x).not.toBe(data.b.y);
    expect(data.a.x).toMatch(/^https:\/\/r2\.example\//);
    expect(data.b.y).toMatch(/^https:\/\/r2\.example\//);
  });
});
