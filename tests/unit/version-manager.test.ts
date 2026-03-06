import { describe, it, expect } from 'vitest';

// @ts-expect-error - JS module without types
import {
  arrayToDbIndex,
  dbToArrayIndex,
  getActiveIndexAfterPush,
  isCoverType,
  COVER_TYPES
} from '../../server/lib/versionManager.js';

describe('versionManager', () => {
  describe('isCoverType', () => {
    it('identifies frontCover as cover type', () => {
      expect(isCoverType('frontCover')).toBe(true);
    });

    it('identifies initialPage as cover type', () => {
      expect(isCoverType('initialPage')).toBe(true);
    });

    it('identifies backCover as cover type', () => {
      expect(isCoverType('backCover')).toBe(true);
    });

    it('rejects scene as cover type', () => {
      expect(isCoverType('scene')).toBe(false);
    });

    it('rejects arbitrary strings', () => {
      expect(isCoverType('page')).toBe(false);
      expect(isCoverType('')).toBe(false);
      expect(isCoverType('cover')).toBe(false);
    });
  });

  describe('arrayToDbIndex', () => {
    it('scenes: array index 0 → DB index 1', () => {
      expect(arrayToDbIndex(0, 'scene')).toBe(1);
    });

    it('scenes: array index 5 → DB index 6', () => {
      expect(arrayToDbIndex(5, 'scene')).toBe(6);
    });

    it('covers: array index 0 → DB index 0 (no offset)', () => {
      expect(arrayToDbIndex(0, 'frontCover')).toBe(0);
      expect(arrayToDbIndex(0, 'initialPage')).toBe(0);
      expect(arrayToDbIndex(0, 'backCover')).toBe(0);
    });

    it('covers: array index 3 → DB index 3', () => {
      expect(arrayToDbIndex(3, 'frontCover')).toBe(3);
    });
  });

  describe('dbToArrayIndex', () => {
    it('scenes: DB index 1 → array index 0', () => {
      expect(dbToArrayIndex(1, 'scene')).toBe(0);
    });

    it('scenes: DB index 6 → array index 5', () => {
      expect(dbToArrayIndex(6, 'scene')).toBe(5);
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

    it('scene with 1 version → DB index 1', () => {
      expect(getActiveIndexAfterPush([{ imageData: 'data1' }], 'scene')).toBe(1);
    });

    it('scene with 3 versions → DB index 3', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }, { imageData: 'v3' }];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(3);
    });

    it('cover with 1 version → DB index 0', () => {
      expect(getActiveIndexAfterPush([{ imageData: 'data1' }], 'frontCover')).toBe(0);
    });

    it('cover with 3 versions → DB index 2', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }, { imageData: 'v3' }];
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(2);
    });

    it('consistent across all cover types', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }];
      const expected = 1; // arrayToDbIndex(1, cover) = 1
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(expected);
      expect(getActiveIndexAfterPush(versions, 'initialPage')).toBe(expected);
      expect(getActiveIndexAfterPush(versions, 'backCover')).toBe(expected);
    });
  });

  describe('COVER_TYPES', () => {
    it('is a Set with exactly 3 entries', () => {
      expect(COVER_TYPES.size).toBe(3);
    });

    it('contains the three cover types', () => {
      expect(COVER_TYPES.has('frontCover')).toBe(true);
      expect(COVER_TYPES.has('initialPage')).toBe(true);
      expect(COVER_TYPES.has('backCover')).toBe(true);
    });
  });
});
