/**
 * Referral cash-out ordering (code review 2026-10-04 P1).
 *
 * An in-memory fake DB plays users + referral_payouts. Pinned behaviour: the balance is
 * debited BEFORE Stripe is called, a refused debit means NO refund is issued (two
 * concurrent cash-outs cannot both refund one balance), the refund carries an idempotency
 * key, and a failed refund restores the balance.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const db = { balance: 0, pending: 0, ledger: [] as any[], nextId: 1 };
function resetDb(balance: number) { db.balance = balance; db.pending = 0; db.ledger = []; db.nextId = 1; }

const client = {
  query: async (sql: string, params: any[] = []) => {
    const s = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return { rows: [] };
    if (s.includes('referral_balance_cents - $1') && s.includes('WHERE id = $2')) {
      if (db.balance - db.pending < params[0]) return { rows: [] };
      db.balance -= params[0];
      return { rows: [{ referral_balance_cents: db.balance, referral_pending_cents: db.pending }] };
    }
    if (s.includes('referral_balance_cents + $1')) {
      db.balance += params[0];
      return { rows: [{ referral_balance_cents: db.balance, referral_pending_cents: db.pending }] };
    }
    if (s.startsWith('INSERT INTO referral_payouts')) {
      const id = db.nextId++;
      db.ledger.push({ id, userId: params[0], amount: params[1], type: params[2], sessionId: params[5], refundId: params[6] });
      return { rows: [{ id }] };
    }
    if (s.startsWith('UPDATE referral_payouts')) {
      const row = db.ledger.find(r => r.id === params[0]);
      if (row) row.refundId = params[1];
      return { rows: [] };
    }
    throw new Error('unexpected query: ' + s.slice(0, 80));
  },
  release: () => {},
};
const pool = { connect: async () => client, query: client.query };

const database = require('../../server/services/database');
database.getPool = () => pool;
const referralBalance = require('../../server/lib/referralBalance.js');

const order = { orderId: 7, sessionId: 'cs_1', paymentIntentId: 'pi_1', refundableCents: 5000, stripeMode: 'test' };

describe('cashOutToCard', () => {
  beforeEach(() => resetDb(1000));

  it('debits the balance before calling Stripe and passes an idempotency key', async () => {
    let balanceAtStripeCall = -1;
    let opts: any = null;
    const stripe = { refunds: { create: async (_p: any, o: any) => { balanceAtStripeCall = db.balance; opts = o; return { id: 're_1' }; } } };
    const r = await referralBalance.cashOutToCard({ userId: 'u1', order, amountCents: 600, stripe });
    expect(r).toEqual({ ok: true, refundId: 're_1' });
    expect(balanceAtStripeCall).toBe(400);
    expect(opts.idempotencyKey).toMatch(/^referral-cashout-\d+$/);
    expect(db.ledger[0].refundId).toBe('re_1');
  });

  it('issues NO refund when the debit is refused (concurrent cash-out already took the balance)', async () => {
    let calls = 0;
    const stripe = { refunds: { create: async () => { calls++; return { id: 're_x' }; } } };
    resetDb(500);
    const r = await referralBalance.cashOutToCard({ userId: 'u1', order, amountCents: 600, stripe });
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
    expect(db.balance).toBe(500);
  });

  it('two concurrent cash-outs of the whole balance refund exactly once', async () => {
    let calls = 0;
    const stripe = { refunds: { create: async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { id: 're_' + calls }; } } };
    resetDb(1000);
    const [a, b] = await Promise.all([
      referralBalance.cashOutToCard({ userId: 'u1', order, amountCents: 1000, stripe }),
      referralBalance.cashOutToCard({ userId: 'u1', order, amountCents: 1000, stripe }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(db.balance).toBe(0);
  });

  it('restores the balance when the Stripe refund fails', async () => {
    const stripe = { refunds: { create: async () => { throw Object.assign(new Error('card closed'), { code: 'charge_already_refunded' }); } } };
    const r = await referralBalance.cashOutToCard({ userId: 'u1', order, amountCents: 600, stripe });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('charge_already_refunded');
    expect(db.balance).toBe(1000);
    expect(db.ledger.map(l => l.type)).toEqual(['spent_refund', 'restored']);
    expect(db.ledger[1].sessionId).toBeNull(); // must not look like a resolved checkout hold
  });
});
