/**
 * Regression for production order 102 (2026-11-02): Gelato refused a 28-page softcover because
 * page 1 was 428.38 mm wide; it requires exactly 428.72. The cover-dimensions API reads
 * ?pageCount=N. We sent ?pagesCount=N, it answered for its 32-page default, and we scaled the
 * spine down. The mocked responses below are the live API answers measured that day.
 */
import { describe, it, expect, afterEach } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCoverDimensions } = require('../../server/lib/gelato.js');

const UID = 'photobooks-softcover_pf_210x280-mm-8x11-inch_test';
const realFetch = global.fetch;
const realKey = process.env.GELATO_API_KEY;
afterEach(() => { global.fetch = realFetch; process.env.GELATO_API_KEY = realKey; });

// Live answers, 21x28 softcover: ?pageCount=28 and ?pageCount=84 (pagesCount includes the 4 cover pages).
const LIVE: Record<string, any> = {
  28: { pagesCount: 32, spineSize: { width: 2.72, height: 280, left: 213, top: 3 }, bleedSize: { width: 428.72, height: 286 },
    contentBackSize: { width: 210, height: 280, left: 3, top: 3 }, contentFrontSize: { width: 210, height: 280, left: 215.72, top: 3 } },
  84: { pagesCount: 88, spineSize: { width: 7.06, height: 280, left: 213, top: 3 }, bleedSize: { width: 433.06, height: 286 },
    contentBackSize: { width: 210, height: 280, left: 3, top: 3 }, contentFrontSize: { width: 210, height: 280, left: 220.06, top: 3 } },
};

function mockGelato(urls: string[]) {
  process.env.GELATO_API_KEY = 'test-key';
  global.fetch = (async (url: string) => {
    urls.push(url);
    const n = new URL(url).searchParams.get('pageCount');
    const body = n && LIVE[n] ? LIVE[n] : LIVE[28]; // the API's 32-page default when pageCount is missing
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as any;
}

describe('getCoverDimensions', () => {
  it('asks for ?pageCount and uses Gelato\'s cover size unchanged (order 102: 28 pages = 428.72 mm)', async () => {
    const urls: string[] = [];
    mockGelato(urls);
    const d = await getCoverDimensions(UID, 28);
    expect(new URL(urls[0]).searchParams.get('pageCount')).toBe('28');
    expect(d.coverPageWidth).toBe(428.72);
    expect(d.coverPageHeight).toBe(286);
    expect(d.spineWidth).toBe(2.72);
    expect(d.contentFront.left).toBe(215.72);
  });

  it('a thick book gets Gelato\'s wider spine, not a scaled guess', async () => {
    mockGelato([]);
    const d = await getCoverDimensions(UID, 84);
    expect(d.coverPageWidth).toBe(433.06);
    expect(d.spineWidth).toBe(7.06);
    expect(d.contentFront.left).toBe(220.06);
  });

  it('fails loudly instead of returning nothing (a guessed cover is refused after payment)', async () => {
    process.env.GELATO_API_KEY = 'test-key';
    global.fetch = (async () => ({ ok: false, status: 503, text: async () => 'down' })) as any;
    await expect(getCoverDimensions(UID, 28)).rejects.toThrow(/503/);
    global.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ pagesCount: 32 }) })) as any;
    await expect(getCoverDimensions(UID, 28)).rejects.toThrow(/bleedSize|spineSize/);
    delete process.env.GELATO_API_KEY;
    await expect(getCoverDimensions(UID, 28)).rejects.toThrow(/GELATO_API_KEY/);
  });
});
