import { describe, it, expect, vi, afterEach } from 'vitest';
import { avatarFailureMessage, photoAnalysisFailureMessage, errorStatusOf } from '../../client/src/utils/avatarErrors';
import { buildOrderDetailLines } from '../../client/src/utils/orderDetails';

describe('W10 / W5 localised avatar and photo failures', () => {
  it('429 maps to the daily-limit text, other errors to the plain failure, in all four languages', () => {
    for (const lang of ['de', 'en', 'fr', 'it']) {
      const limit = avatarFailureMessage(lang, 429);
      const plain = avatarFailureMessage(lang, 500);
      expect(limit).not.toBe(plain);
      expect(limit).not.toMatch(/Error:|undefined/);
      expect(photoAnalysisFailureMessage(lang).length).toBeGreaterThan(5);
    }
    expect(avatarFailureMessage('de', 429)).toMatch(/Tageslimit/);
    expect(avatarFailureMessage('de', 429)).not.toContain('ß');
  });
  it('reads the HTTP status off errors thrown by api.ts', () => {
    expect(errorStatusOf(Object.assign(new Error('x'), { status: 429 }))).toBe(429);
    expect(errorStatusOf(new Error('x'))).toBeUndefined();
    expect(errorStatusOf(null)).toBeUndefined();
  });
});

describe('D7 order dialog lines', () => {
  it('omits withheld customer/shipping fields instead of printing "undefined"', () => {
    const lines = buildOrderDetailLines({ amount_total: 4950 }, 'de');
    expect(lines).toEqual(['Betrag: CHF 49.50']);
    expect(lines.join('\n')).not.toMatch(/undefined|null/);
  });
  it('prints everything when present, skips a half-present city line cleanly', () => {
    const lines = buildOrderDetailLines({
      amount_total: 1000, customer_name: 'A B', customer_email: 'a@b.ch', shipping_name: 'A B',
      shipping_address_line1: 'Weg 1', shipping_postal_code: '5400', shipping_city: undefined, shipping_country: 'CH',
    }, 'en', 5);
    expect(lines).toContain('Credits earned: 5');
    expect(lines).toContain('5400');
    expect(lines.join('\n')).not.toMatch(/undefined/);
  });
});

describe('W3 idea stream that closes without done/error', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const streamOf = (chunks: string[]) => {
    const enc = new TextEncoder();
    return new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(enc.encode(x))); c.close(); } });
  };
  async function run(chunks: string[]) {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, body: streamOf(chunks) })));
    const { storyService } = await import('../../client/src/services/storyService');
    const onError = vi.fn(); const onDone = vi.fn();
    storyService.generateStoryIdeasStream({} as any, { onError, onDone });
    await new Promise(r => setTimeout(r, 50));
    return { onError, onDone };
  }
  it('calls onError when the stream ends silently', async () => {
    const { onError, onDone } = await run(['data: {"status":"working"}\n']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });
  it('does not call onError after a done event', async () => {
    const { onError, onDone } = await run(['data: {"done":true}\n']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
  it('reports an error event exactly once', async () => {
    const { onError } = await run(['data: {"error":"boom"}\n']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
