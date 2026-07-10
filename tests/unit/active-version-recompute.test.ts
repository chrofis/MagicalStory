import { describe, it, expect, vi, beforeEach } from 'vitest';

// scoring.js destructures setActiveVersion/getActiveVersionMeta from the
// database module at load time (CJS require), and that require chain runs in
// Node's native CJS registry — vi.mock and vitest's ESM imports don't reach
// it. Load both modules through createRequire (same native cache), replace
// the two functions on database's module.exports FIRST, then load scoring so
// its destructure picks up the mocks.
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const setActiveVersion = vi.fn();
const getActiveVersionMeta = vi.fn();
const db: any = nodeRequire('../../server/services/database.js');
db.setActiveVersion = setActiveVersion;
db.getActiveVersionMeta = getActiveVersionMeta;

const { recomputeActiveVersion, recomputeAllActiveVersions, pickBestVersionIndex } =
  nodeRequire('../../server/lib/scoring.js');

beforeEach(() => {
  setActiveVersion.mockReset();
  getActiveVersionMeta.mockReset();
  getActiveVersionMeta.mockResolvedValue({});
});

describe('recomputeActiveVersion — pin semantics', () => {
  const scored = [
    { finalScore: 9 },
    { finalScore: 6 },
  ];

  it('picks the best-scored version and persists it when unpinned', async () => {
    const r = await recomputeActiveVersion('story1', 3, scored, 'scene', { metaEntry: null });
    expect(r).toEqual({ activeIndex: 0, finalScore: 9 });
    expect(setActiveVersion).toHaveBeenCalledWith('story1', 3, 0);
  });

  it('skips a pinned key (explicit user choice wins over scoring)', async () => {
    const r = await recomputeActiveVersion('story1', 3, scored, 'scene', {
      metaEntry: { activeVersion: 1, pinned: true },
    });
    expect(r).toBeNull();
    expect(setActiveVersion).not.toHaveBeenCalled();
  });

  it('fetches the meta entry itself when the caller did not pass one', async () => {
    getActiveVersionMeta.mockResolvedValue({ '3': { activeVersion: 1, pinned: true } });
    const r = await recomputeActiveVersion('story1', 3, scored, 'scene');
    expect(r).toBeNull();
    expect(setActiveVersion).not.toHaveBeenCalled();
  });

  it('leaves everything alone when no version is scored', async () => {
    const r = await recomputeActiveVersion('story1', 3, [{}, {}], 'scene', { metaEntry: null });
    expect(r).toBeNull();
    expect(setActiveVersion).not.toHaveBeenCalled();
  });

  it('prefers an explicit dbVersionIndex stamp over the identity mapping', async () => {
    const versions = [
      { finalScore: 5 },
      { finalScore: 9, dbVersionIndex: 7 }, // lazy-migrated: array idx 1, DB row 7
    ];
    const r = await recomputeActiveVersion('story1', 3, versions, 'scene', { metaEntry: null });
    expect(r?.activeIndex).toBe(1);
    expect(setActiveVersion).toHaveBeenCalledWith('story1', 3, 7);
  });
});

describe('recomputeAllActiveVersions — blob mirror', () => {
  it('mirrors the picked activeVersion onto unpinned scenes and covers', async () => {
    const storyData: any = {
      sceneImages: [
        { pageNumber: 1, imageVersions: [{ finalScore: 4 }, { finalScore: 8 }] },
      ],
      coverImages: {
        frontCover: { imageVersions: [{ finalScore: 7 }, { finalScore: 3 }] },
      },
    };
    const summary = await recomputeAllActiveVersions('story1', storyData);
    expect(summary.switches).toBe(2);
    expect(storyData.sceneImages[0].activeVersion).toBe(1);
    expect(storyData.coverImages.frontCover.activeVersion).toBe(0);
  });

  it('leaves pinned keys untouched and mirrors the PINNED choice onto the blob', async () => {
    getActiveVersionMeta.mockResolvedValue({
      '1': { activeVersion: 0, pinned: true },  // user picked v0; v1 scores higher
    });
    const storyData: any = {
      sceneImages: [
        { pageNumber: 1, imageVersions: [{ finalScore: 4 }, { finalScore: 8 }] },
      ],
    };
    const summary = await recomputeAllActiveVersions('story1', storyData);
    expect(summary.switches).toBe(0);
    expect(setActiveVersion).not.toHaveBeenCalled();
    // Blob mirror must reflect the pinned version, not the best-scored one.
    expect(storyData.sceneImages[0].activeVersion).toBe(0);
  });

  it('maps a pinned DB index back through a dbVersionIndex stamp', async () => {
    getActiveVersionMeta.mockResolvedValue({
      '1': { activeVersion: 7, pinned: true },
    });
    const storyData: any = {
      sceneImages: [
        { pageNumber: 1, imageVersions: [{ finalScore: 4 }, { dbVersionIndex: 7 }] },
      ],
    };
    await recomputeAllActiveVersions('story1', storyData);
    expect(storyData.sceneImages[0].activeVersion).toBe(1);
  });
});

describe('pickBestVersionIndex — sanity anchors', () => {
  it('best score wins regardless of position', () => {
    expect(pickBestVersionIndex([{ finalScore: 2 }, { finalScore: 9 }, { finalScore: 5 }])).toBe(1);
  });
  it('returns -1 when nothing is scored', () => {
    expect(pickBestVersionIndex([{}, {}])).toBe(-1);
  });
});
