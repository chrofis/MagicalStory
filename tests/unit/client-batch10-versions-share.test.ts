import { describe, it, expect, vi } from 'vitest';
import {
  findVersionByIndex, iterateErrorMessage, regenerationErrorKind, setSharingOnServer,
  titleRepaintFailedMessage, shareFailedMessage,
} from '../../client/src/utils/imageVersions';

describe('D2 version lookup by versionIndex', () => {
  const sparse = [
    { versionIndex: 0, imageData: 'a' },
    { versionIndex: 2, imageData: 'c' },
    { versionIndex: 3, imageData: 'd' },
  ];
  it('picks the entry carrying the index, not the array position', () => {
    expect(findVersionByIndex(sparse, 2)?.imageData).toBe('c');
    expect(findVersionByIndex(sparse, 3)?.imageData).toBe('d');
  });
  it('returns undefined for a gap instead of guessing another picture', () => {
    expect(findVersionByIndex(sparse, 1)).toBeUndefined();
  });
  it('falls back to array position only for legacy entries without versionIndex, and logs it', () => {
    const legacy = [{ imageData: 'x' }, { imageData: 'y' }];
    const log = vi.fn();
    expect(findVersionByIndex(legacy as any, 1, log)?.imageData).toBe('y');
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('handles missing arrays', () => {
    expect(findVersionByIndex(undefined, 0)).toBeUndefined();
  });
});

describe('D1 iterate error mapping', () => {
  it('maps 402 / 429 / other to distinct localised texts in all languages', () => {
    expect(regenerationErrorKind(402)).toBe('insufficient_credits');
    expect(regenerationErrorKind(429)).toBe('rate_limited');
    expect(regenerationErrorKind(500)).toBe('other');
    expect(regenerationErrorKind(undefined)).toBe('other');
    for (const lang of ['de', 'en', 'fr', 'it']) {
      const set = new Set([402, 429, 500].map(s => iterateErrorMessage(lang, s)));
      expect(set.size).toBe(3);
    }
    expect(iterateErrorMessage('de', 402)).not.toContain('ß');
  });
  it('has title and share failure texts in every language', () => {
    for (const lang of ['de', 'en', 'fr', 'it']) {
      expect(titleRepaintFailedMessage(lang).length).toBeGreaterThan(10);
      expect(shareFailedMessage(lang).length).toBeGreaterThan(10);
    }
  });
});

describe('D3 sharing toggle only reports success the server confirmed', () => {
  const headers = {};
  it('returns the new state on res.ok', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    expect(await setSharingOnServer(f, 's1', false, headers)).toBe(false);
    expect(f).toHaveBeenCalledWith('/api/stories/s1/share', { method: 'DELETE', headers });
    expect(await setSharingOnServer(f, 's1', true, headers)).toBe(true);
  });
  it('returns null on a non-ok response (failed DELETE must not show private)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false });
    expect(await setSharingOnServer(f, 's1', false, headers)).toBeNull();
  });
  it('returns null on a network error', async () => {
    const f = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await setSharingOnServer(f, 's1', true, headers)).toBeNull();
  });
});
