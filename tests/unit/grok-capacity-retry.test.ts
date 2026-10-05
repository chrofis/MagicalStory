import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const grok: any = nodeRequire('../../server/lib/grok.js');

const httpErr = (statusCode: number, message: string, moderated = false) =>
  Object.assign(new Error(message), { statusCode, moderated });
const noSleep = () => { const waits: number[] = []; return { waits, sleep: async (ms: number) => { waits.push(ms); } }; };

// staging job_1791222889407_ypl33vk8u: a 429 "at capacity" killed Emma's costumed sheet after one try.
describe('Grok transient capacity errors wait and retry', () => {
  it('a 429 is retried with doubling waits and then succeeds', async () => {
    let calls = 0;
    const { waits, sleep } = noSleep();
    const out = await grok.fetchGrokWithRetry(async () => {
      if (++calls < 4) throw httpErr(429, 'Grok edit API error (429): The service is temporarily at capacity');
      return 'ok';
    }, 'edit', { sleep });
    expect(out).toBe('ok');
    expect(calls).toBe(4);
    expect(waits).toEqual([5000, 10000, 20000]);
  });
  it('a moderation refusal is never retried', async () => {
    let calls = 0;
    const { sleep } = noSleep();
    await expect(grok.fetchGrokWithRetry(async () => { calls++; throw httpErr(400, 'content-moderated', true); }, 'edit', { sleep })).rejects.toThrow(/moderated/);
    expect(calls).toBe(1);
  });
  it('credit exhaustion on a 429 is not waited out', async () => {
    let calls = 0;
    const { sleep } = noSleep();
    await expect(grok.fetchGrokWithRetry(async () => { calls++; throw httpErr(429, 'spending limit reached'); }, 'edit', { sleep })).rejects.toThrow(/spending/);
    expect(calls).toBe(1);
  });
  it('gives up loudly once the wait budget is spent', async () => {
    let calls = 0;
    const { waits, sleep } = noSleep();
    await expect(grok.fetchGrokWithRetry(async () => { calls++; throw httpErr(429, 'at capacity'); }, 'edit', { sleep, wait: { baseMs: 1000, maxBackoffMs: 4000, totalMs: 10000 } })).rejects.toThrow(/capacity/);
    expect(waits.reduce((a: number, b: number) => a + b, 0)).toBe(10000);
    expect(calls).toBe(waits.length + 1);
  });
  it('a 500 keeps its single quick retry', async () => {
    let calls = 0;
    const { waits, sleep } = noSleep();
    await expect(grok.fetchGrokWithRetry(async () => { calls++; throw httpErr(500, 'internal'); }, 'edit', { sleep })).rejects.toThrow(/internal/);
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });
});
