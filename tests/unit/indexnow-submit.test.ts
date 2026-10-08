import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { parseSitemapUrls, batchUrls, validateKey, verifyKeyFile, buildPayload, parseArgs } =
  require_('../../scripts/seo/indexnow-submit');

const KEY = 'abcd1234-EFGH';
const resp = (status: number, body: string) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });

describe('parseSitemapUrls', () => {
  it('extracts, unescapes and dedupes <loc> entries', () => {
    const xml = `<urlset><url><loc>https://x.ch/a?b=1&amp;c=2</loc></url><url><loc> https://x.ch/b </loc></url><url><loc>https://x.ch/b</loc></url></urlset>`;
    expect(parseSitemapUrls(xml)).toEqual(['https://x.ch/a?b=1&c=2', 'https://x.ch/b']);
  });
  it('returns [] for no locs', () => expect(parseSitemapUrls('<urlset/>')).toEqual([]));
});

describe('batchUrls', () => {
  it('splits at the size limit', () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://x.ch/${i}`);
    expect(batchUrls(urls, 10).map(x => x.length)).toEqual([10, 10, 5]);
  });
  it('defaults to the protocol 10000 limit', () => {
    const urls = Array.from({ length: 10001 }, (_, i) => `https://x.ch/${i}`);
    expect(batchUrls(urls).map(x => x.length)).toEqual([10000, 1]);
  });
  it('empty in, empty out', () => expect(batchUrls([])).toEqual([]));
});

describe('validateKey', () => {
  it('accepts protocol-valid keys', () => expect(validateKey(KEY)).toBe(KEY));
  it('rejects unset, short, long and bad chars', () => {
    expect(() => validateKey(undefined)).toThrow(/not set/);
    expect(() => validateKey('short')).toThrow();
    expect(() => validateKey('a'.repeat(129))).toThrow();
    expect(() => validateKey('abcd_1234')).toThrow();
  });
});

describe('verifyKeyFile', () => {
  it('passes when the file contains the key (trailing newline ok)', async () => {
    await expect(verifyKeyFile('https://x.ch', KEY, resp(200, KEY + '\n'))).resolves.toBeUndefined();
  });
  it('fails on 404', async () => {
    await expect(verifyKeyFile('https://x.ch', KEY, resp(404, ''))).rejects.toThrow(/HTTP 404/);
  });
  it('fails on wrong content (e.g. SPA html fallback)', async () => {
    await expect(verifyKeyFile('https://x.ch', KEY, resp(200, '<html>'))).rejects.toThrow(/does not contain/);
  });
});

describe('buildPayload / parseArgs', () => {
  it('builds the protocol body', () => {
    expect(buildPayload('x.ch', KEY, ['https://x.ch/a'])).toEqual({ host: 'x.ch', key: KEY, urlList: ['https://x.ch/a'] });
  });
  it('parses flags', () => {
    expect(parseArgs(['--dry-run', '--base=https://s.x.ch/', '--urls=https://a,https://b'])).toEqual({
      dryRun: true, base: 'https://s.x.ch', urls: ['https://a', 'https://b'],
    });
    expect(parseArgs([])).toEqual({ dryRun: false, base: 'https://magicalstory.ch', urls: null });
  });
});
