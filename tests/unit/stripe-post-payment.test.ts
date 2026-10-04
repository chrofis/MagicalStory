/**
 * Post-payment bookkeeping (code review 2026-10-04 P3, P7, P8, P2).
 * Fake DB / fake Stripe; pins WHAT HAPPENS: abandoned checkouts release the referral claim,
 * failed post-payment steps are recorded durably AND alerted, a stuck order is resumed only
 * when processing never started, and a resume follows the ORDER's stripe_mode.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const database = require('../../server/services/database');
database.getPool = () => ({});
const { releaseReferralClaim } = require('../../server/lib/referral.js');
const { recordPostPaymentFailure, bufferWebhookEvent } = require('../../server/lib/stripeWebhookRetry.js');
const { sweepStuckBookOrders, resumeBookOrder } = require('../../server/lib/gelato.js');

describe('releaseReferralClaim (P3)', () => {
  it('clears the claim for an unpaid session and reports it', async () => {
    let params: any[] = [];
    const pool = { query: async (_s: string, p: any[]) => { params = p; return { rowCount: 1 }; } };
    expect(await releaseReferralClaim(pool, { userId: 'u1', code: 'MagicA123', sessionId: 'cs_1' })).toBe(true);
    expect(params).toEqual(['u1', 'MagicA123', 'cs_1']);
  });
  it('reports false when the guard (order exists / other code) matched no row', async () => {
    const pool = { query: async () => ({ rowCount: 0 }) };
    expect(await releaseReferralClaim(pool, { userId: 'u1', code: 'X', sessionId: 'cs_1' })).toBe(false);
  });
  it('does nothing without a code or session', async () => {
    const pool = { query: async () => { throw new Error('must not query'); } };
    expect(await releaseReferralClaim(pool, { userId: 'u1', code: '', sessionId: 'cs_1' })).toBe(false);
  });
});

describe('recordPostPaymentFailure (P7)', () => {
  it('buffers the failed step under its own key and alerts the admin', async () => {
    const rows: any[][] = [];
    const pool = { query: async (_s: string, p: any[]) => { rows.push(p); return { rowCount: 1 }; } };
    const alerts: string[] = [];
    const ok = await recordPostPaymentFailure(pool, {
      event: { id: 'evt_1', type: 'checkout.session.completed' }, step: 'referral_cashback', sessionId: 'cs_1',
      error: new Error('db down'), sendAlert: async (subject: string) => { alerts.push(subject); },
    });
    expect(ok).toBe(true);
    expect(rows[0][0]).toBe('evt_1:referral_cashback');
    expect(alerts).toHaveLength(1);
  });
  it('still alerts when the buffer write itself fails', async () => {
    const pool = { query: async () => { throw new Error('buffer down'); } };
    const alerts: string[] = [];
    const ok = await recordPostPaymentFailure(pool, {
      event: { id: 'evt_2' }, step: 'confirm_pending_balance', sessionId: 'cs_2',
      error: new Error('x'), sendAlert: async (s: string) => { alerts.push(s); },
    });
    expect(ok).toBe(false);
    expect(alerts).toHaveLength(1);
  });
  it('bufferWebhookEvent reports failure instead of throwing', async () => {
    const pool = { query: async () => { throw new Error('nope'); } };
    expect(await bufferWebhookEvent(pool, { eventId: 'e', eventType: 't', payload: {}, error: new Error('x') })).toBe(false);
  });
});

describe('sweepStuckBookOrders (P8)', () => {
  function sweepPool(rows: any[], claimRowCount = 1) {
    const claims: any[] = [];
    return {
      claims,
      pool: {
        query: async (sql: string, p: any[]) => {
          if (sql.includes('SELECT id, user_id')) return { rows };
          if (sql.includes('UPDATE orders SET updated_at')) { claims.push(p[0]); return { rowCount: claimRowCount }; }
          throw new Error('unexpected: ' + sql.slice(0, 50));
        },
      },
    };
  }

  it("alerts once for an order stuck in 'processing' and never resumes it", async () => {
    const alerts: string[] = [];
    const { pool, claims } = sweepPool([{ id: 5, stripe_session_id: 'cs_5', payment_status: 'processing', customer_email: 'a@b.ch', updated_at: new Date() }]);
    const alerted = new Set<string>();
    const opts = { getStripeClientForOrder: () => { throw new Error('must not resume'); }, sendAlert: (s: string) => alerts.push(s), alerted };
    const r1 = await sweepStuckBookOrders(pool, opts);
    const r2 = await sweepStuckBookOrders(pool, opts);
    expect(r1.alerted).toEqual(['cs_5']);
    expect(r2.alerted).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(claims).toHaveLength(0);
  });

  it("claims and resumes an order still in 'paid' (processing never started)", async () => {
    const { pool, claims } = sweepPool([{ id: 6, stripe_session_id: 'cs_6', stripe_mode: 'live', payment_status: 'paid', customer_email: 'a@b.ch', updated_at: new Date() }]);
    let asked: any = null;
    const r = await sweepStuckBookOrders(pool, {
      getStripeClientForOrder: (o: any) => { asked = o; return null; }, // resume then fails (no client) -> alerted
      sendAlert: () => {}, alerted: new Set<string>(),
    });
    expect(r.resumed).toEqual(['cs_6']);
    expect(claims).toEqual([6]);
    expect(asked.id).toBe(6);
  });

  it('skips an order another instance already claimed', async () => {
    const { pool } = sweepPool([{ id: 7, stripe_session_id: 'cs_7', payment_status: 'paid', customer_email: 'a@b.ch', updated_at: new Date() }], 0);
    const r = await sweepStuckBookOrders(pool, { getStripeClientForOrder: () => null, sendAlert: () => {}, alerted: new Set<string>() });
    expect(r.resumed).toEqual([]);
  });
});

describe('resumeBookOrder (P2)', () => {
  const session = { id: 'cs_9', payment_status: 'paid', metadata: { userId: 'u1', storyIds: JSON.stringify(['s1', 's2']), coverType: 'hardcover', bookFormat: 'A4', quantity: '3' },
    customer_details: { name: 'A B', email: 'a@b.ch' }, shipping: { address: { line1: 'x' } } };
  const dbPool = { query: async (sql: string) => (sql.includes('FROM stories') ? { rows: [{ id: 's' }] } : { rows: [{ preferred_language: 'German' }] }) };
  const stripeFor = (s: any) => ({ checkout: { sessions: { retrieve: async () => s } } });
  const noop = async () => {};

  it('re-runs processBookOrder with the PAID stories, quantity, cover and the order stripe_mode', async () => {
    let args: any[] = [];
    const run = async (...a: any[]) => { args = a; };
    await resumeBookOrder(dbPool, { id: 1, stripe_session_id: 'cs_9', stripe_mode: 'live' }, stripeFor(session), { run });
    expect(args[3]).toEqual(['s1', 's2']);       // every paid story, not just the first
    expect(args[6]).toBe(false);                 // live order: real Gelato order, even when an admin triggered it
    expect([args[7], args[8], args[9]]).toEqual(['hardcover', 'A4', 3]);
    await resumeBookOrder(dbPool, { id: 2, stripe_session_id: 'cs_9', stripe_mode: 'test' }, stripeFor(session), { run });
    expect(args[6]).toBe(true);
  });
  it('refuses an order that already has a Gelato id (would order the book twice)', async () => {
    await expect(resumeBookOrder(dbPool, { id: 1, gelato_order_id: 'g1' }, stripeFor(session), { run: noop })).rejects.toThrow(/already has Gelato/);
  });
  it('refuses a session that is not paid', async () => {
    await expect(resumeBookOrder(dbPool, { id: 1, stripe_session_id: 'cs_9' }, stripeFor({ ...session, payment_status: 'unpaid' }), { run: noop })).rejects.toThrow(/not paid/);
  });
});
