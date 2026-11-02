/**
 * A 5xx or no answer on Gelato order create does not prove nothing was ordered: order 102
 * (2026-11-02) got a 504 while Gelato created draft c723c52d, and our row was marked failed.
 * createGelatoOrder looks the order up by its orderReferenceId before counting the create as failed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const cjs = createRequire(import.meta.url);
const { createGelatoOrder } = cjs('../../server/lib/gelato.js');

const payload = { orderType: 'draft', orderReferenceId: 'story-job_x-1', items: [] };
const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body),
});

/** A fake fetch: `create` answers the POST /v4/orders, `searches` answer orders:search in turn. */
function fakeFetch(create: any, searches: any[] = []) {
  const calls: { url: string; body: any }[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith('/v4/orders')) { if (create instanceof Error) throw create; return create; }
    const next = searches.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

beforeEach(() => { process.env.GELATO_API_KEY = 'test-key'; });

describe('createGelatoOrder', () => {
  it('returns the created order on success without searching', async () => {
    const f = fakeFetch(json(200, { id: 'new-1' }));
    expect((await createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 })).id).toBe('new-1');
    expect(f.calls).toHaveLength(1);
  });

  it('a 4xx is a refusal: throws at once with status and details, no lookup', async () => {
    const f = fakeFetch(json(400, { message: 'bad file' }));
    await expect(createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 }))
      .rejects.toMatchObject({ status: 400, details: { message: 'bad file' } });
    expect(f.calls).toHaveLength(1);
  });

  it('order 102 regression: a 504 while Gelato created the order returns that order', async () => {
    const f = fakeFetch(json(504, 'gateway timeout'), [json(200, { orders: [] }), json(200, { orders: [{ id: 'c723c52d' }] })]);
    expect((await createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 })).id).toBe('c723c52d');
    expect(f.calls[1].url).toMatch(/\/v4\/orders:search$/);
    expect(f.calls[1].body.orderReferenceIds).toEqual(['story-job_x-1']);
  });

  it('no answer at all (network error) is looked up the same way', async () => {
    const f = fakeFetch(new Error('fetch failed'), [json(200, { orders: [{ id: 'found' }] })]);
    expect((await createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 })).id).toBe('found');
  });

  it('a 5xx with no such order after every lookup throws the create error', async () => {
    const empty = () => json(200, { orders: [] });
    const f = fakeFetch(json(503, 'down'), [empty(), empty(), empty()]);
    await expect(createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 }))
      .rejects.toMatchObject({ status: 503, message: expect.stringMatching(/after 3 lookups/) });
    expect(f.calls).toHaveLength(4);
  });

  it('a failing lookup throws and says to check Gelato before ordering again', async () => {
    const f = fakeFetch(json(504, 'x'), [json(500, 'search down')]);
    await expect(createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 }))
      .rejects.toThrow(/check Gelato for reference story-job_x-1 before ordering again/);
  });

  it('two orders with one reference is an error, never a guess', async () => {
    const f = fakeFetch(json(504, 'x'), [json(200, { orders: [{ id: 'a' }, { id: 'b' }] })]);
    await expect(createGelatoOrder(payload, { fetchImpl: f.fn, waitMs: 0 })).rejects.toThrow(/looking the order up failed/);
  });

  it('every Gelato order create goes through createGelatoOrder', () => {
    for (const file of ['server/lib/gelato.js', 'server/routes/print.js']) {
      const src = fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const direct = src.match(/gelatoapis\.com\/v4\/orders'/g) || [];
      expect(direct.length, file).toBe(file === 'server/lib/gelato.js' ? 1 : 0); // the one inside createGelatoOrder
    }
  });
});
