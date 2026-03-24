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

    it('scene with 1 version → DB index 0', () => {
      expect(getActiveIndexAfterPush([{ imageData: 'data1' }], 'scene')).toBe(0);
    });

    it('scene with 3 versions → DB index 2', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }, { imageData: 'v3' }];
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(2);
    });

    it('cover with 1 version → DB index 0', () => {
      expect(getActiveIndexAfterPush([{ imageData: 'data1' }], 'frontCover')).toBe(0);
    });

    it('cover with 3 versions → DB index 2', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }, { imageData: 'v3' }];
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(2);
    });

    it('consistent across all types (scenes and covers)', () => {
      const versions = [{ imageData: 'v1' }, { imageData: 'v2' }];
      const expected = 1; // length - 1
      expect(getActiveIndexAfterPush(versions, 'scene')).toBe(expected);
      expect(getActiveIndexAfterPush(versions, 'frontCover')).toBe(expected);
      expect(getActiveIndexAfterPush(versions, 'initialPage')).toBe(expected);
      expect(getActiveIndexAfterPush(versions, 'backCover')).toBe(expected);
    });
  });
});
