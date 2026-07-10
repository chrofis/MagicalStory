import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import {
  arrayToDbIndex,
  dbToArrayIndex,
  getActiveIndexAfterPush
} from '../../server/lib/versionManager.js';

describe('versionManager', () => {
  describe('arrayToDbIndex', () => {
    it('scenes: array index 0 → DB index 0 (unified, no offset)', () => {
      expect(arrayToDbIndex(0, 'scene')).toBe(0);
    });

    it('scenes: array index 5 → DB index 5', () => {
      expect(arrayToDbIndex(5, 'scene')).toBe(5);
    });

    it('covers: array index 0 → DB index 0', () => {
      expect(arrayToDbIndex(0, 'frontCover')).toBe(0);
      expect(arrayToDbIndex(0, 'initialPage')).toBe(0);
      expect(arrayToDbIndex(0, 'backCover')).toBe(0);
    });

    it('covers: array index 3 → DB index 3', () => {
      expect(arrayToDbIndex(3, 'frontCover')).toBe(3);
    });

    it('identity: arrayToDbIndex(i) === i for all types', () => {
      for (let i = 0; i < 10; i++) {
        expect(arrayToDbIndex(i, 'scene')).toBe(i);
        expect(arrayToDbIndex(i, 'frontCover')).toBe(i);
      }
    });
  });

  describe('dbToArrayIndex', () => {
    it('scenes: DB index 0 → array index 0', () => {
      expect(dbToArrayIndex(0, 'scene')).toBe(0);
    });

    it('scenes: DB index 5 → array index 5', () => {
      expect(dbToArrayIndex(5, 'scene')).toBe(5);
    });

    it('covers: DB index 0 → array index 0', () => {
      expect(dbToArrayIndex(0, 'frontCover')).toBe(0);
      expect(dbToArrayIndex(0, 'backCover')).toBe(0);
    });

    it('covers: DB index 3 → array index 3', () => {
      expect(dbToArrayIndex(3, 'initialPage')).toBe(3);
    });

    it('roundtrips correctly for scenes', () => {
      for (let i = 0; i < 10; i++) {
        expect(dbToArrayIndex(arrayToDbIndex(i, 'scene'), 'scene')).toBe(i);
      }
    });

    it('roundtrips correctly for covers', () => {
      for (let i = 0; i < 10; i++) {
        expect(dbToArrayIndex(arrayToDbIndex(i, 'frontCover'), 'frontCover')).toBe(i);
      }
    });
  });

  describe('getActiveIndexAfterPush', () => {
    it('returns 0 for empty array', () => {
      expect(getActiveIndexAfterPush([], 'scene')).toBe(0);
      expect(getActiveIndexAfterPush(null, 'scene')).toBe(0);
      expect(getActiveIndexAfterPush(undefined, 'scene')).toBe(0);
    });

    it('all versions unscored → falls back to newest', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }, { imageData: 'v3' }];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(2);
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(2);
    });

    // The whole point of this helper (54d3c14d): the BEST-scoring version
    // wins, not the LAST-pushed one. These cases guard the score-based path
    // the old suite never exercised (its fixtures were all unscored, so the
    // newest-fallback made "length - 1" look like the contract).
    it('best-scored version wins over a newer, lower-scored push', () => {
      const versions = [
        { imageData: 'v1', finalScore: 9 },
        { imageData: 'v2', finalScore: 6 },
        { imageData: 'v3', finalScore: 7 },
      ];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(0);
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(0);
    });

    it('newest wins when it is also the best', () => {
      const versions = [
        { imageData: 'v1', finalScore: 6 },
        { imageData: 'v2', finalScore: 9 },
      ];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(1);
    });

    it('scored version beats unscored newer push', () => {
      const versions = [
        { imageData: 'v1', finalScore: 8 },
        { imageData: 'v2' }, // just pushed, not yet evaluated
      ];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(0);
    });

    it('explicit dbVersionIndex stamp wins over identity mapping', () => {
      // Lazy-migrated story: blob array has 2 entries but the DB already
      // held rows 0..3, so the regen wrote the new version at index 4 and
      // stamped it. The active pointer must target the stamped DB row, not
      // the array position.
      const versions = [
        { imageData: 'v1' },
        { imageData: 'v2', dbVersionIndex: 4 },
      ];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(4);
    });

    it('stamped + scored: best version reports its stamped DB index', () => {
      const versions = [
        { imageData: 'v1', finalScore: 5 },
        { imageData: 'v2', finalScore: 9, dbVersionIndex: 7 },
      ];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(7);
    });
  });
});
