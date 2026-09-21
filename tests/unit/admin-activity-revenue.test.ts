import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Revenue in the daily Tagesbericht (server/lib/adminActivity.js →
 * email.js sendAdminDailySummary).
 *
 * Two things must never blur: a PAID credit pack and a FREE credit grant
 * (signup bonus, referral, admin) both write a positive `credit_transactions`
 * row, and only the first one is money. And amounts are per currency — cents of
 * different currencies are never summed, because no conversion rate exists here.
 */

vi.mock('../../server/lib/apiHealth', () => ({ getApiHealth: async () => [] }));
vi.mock('../../server/lib/failureLog', () => ({
  summariseFailures: async () => ({ totals: { customer: 0, internal: 0 }, customer: [], internal: [] }),
}));

const { buildActivityFeed } = require('../../server/lib/adminActivity');

const TS = new Date('2026-09-20T09:00:00Z');

/** Fake pool: routes each query to the right fixture rows by table name. */
function poolWith({ orders = [] as any[], credits = [] as any[] }) {
  return {
    query: async (sql: string) => {
      if (/FROM orders/.test(sql)) return { rows: orders };
      if (/FROM credit_transactions/.test(sql)) return { rows: credits };
      return { rows: [] };
    },
  };
}

const order = (o: any) => ({
  id: 1, created_at: TS, payment_status: 'paid', amount_total: 4990,
  currency: 'chf', quantity: 1, story_id: 'story_1', email: 'buyer@example.com', ...o,
});
const creditRow = (c: any) => ({
  created_at: TS, amount: 350, transaction_type: 'purchase',
  description: 'Purchased 350 credits via Stripe (CHF 10.00)',
  price_cents: 1000, email: 'buyer@example.com', ...c,
});

describe('buildActivityFeed revenue', () => {
  it('sums paid orders and credit purchases into one CHF total', async () => {
    const feed = await buildActivityFeed(poolWith({
      orders: [order({}), order({ id: 2, amount_total: 2500 })],
      credits: [creditRow({})],
    }) as any, 24);
    expect(feed.summary.revenueCents).toBe(4990 + 2500 + 1000);
    expect(feed.summary.revenueCurrency).toBe('CHF');
    expect(feed.summary.revenueByCurrency).toEqual({ CHF: 8490 });
    expect(feed.summary.purchases).toBe(3);
    expect(feed.summary.orders).toBe(2);
    expect(feed.summary.creditPurchases).toBe(1);
  });

  it('gives a bought pack its own event type and leaves free grants as credits', async () => {
    const feed = await buildActivityFeed(poolWith({
      credits: [
        creditRow({}),
        creditRow({ amount: 50, transaction_type: 'signup_bonus', description: 'Welcome bonus', price_cents: null }),
        creditRow({ amount: 350, transaction_type: 'referral', description: 'Referral reward', price_cents: null }),
      ],
    }) as any, 24);
    const types = feed.events.map((e: any) => e.type).sort();
    expect(types).toEqual(['credit_purchase', 'credits', 'credits']);
    expect(feed.summary.creditPurchases).toBe(1);
    expect(feed.summary.creditTopUps).toBe(2);
    // A free grant must contribute nothing to revenue.
    expect(feed.summary.revenueCents).toBe(1000);
  });

  it('does not count a failed order as revenue, but still lists it', async () => {
    const feed = await buildActivityFeed(poolWith({
      orders: [order({ payment_status: 'failed' })],
    }) as any, 24);
    expect(feed.summary.revenueCents).toBe(0);
    expect(feed.summary.orders).toBe(1);
  });

  // 'completed' is prod's most common state: print.js sets it once the paid
  // order reaches Gelato. 64 of 92 production orders carry it.
  it('counts a completed (fulfilled) order as revenue', async () => {
    const feed = await buildActivityFeed(poolWith({
      orders: [order({ payment_status: 'completed' })],
    }) as any, 24);
    expect(feed.summary.revenueCents).toBe(4990);
  });

  it('keeps currencies separate instead of summing them', async () => {
    const feed = await buildActivityFeed(poolWith({
      orders: [order({}), order({ id: 2, currency: 'eur', amount_total: 3000 })],
    }) as any, 24);
    expect(feed.summary.revenueByCurrency).toEqual({ CHF: 4990, EUR: 3000 });
    expect(feed.summary.revenueCents).toBeNull();
    expect(feed.summary.revenueCurrency).toBeNull();
  });

  it('reports a missing amount as unknown rather than as zero revenue', async () => {
    const feed = await buildActivityFeed(poolWith({
      orders: [order({ amount_total: null })],
      credits: [creditRow({ price_cents: null })],
    }) as any, 24);
    expect(feed.summary.revenueUnknownCount).toBe(2);
    expect(feed.summary.revenueByCurrency).toEqual({});
    const labels = feed.events.map((e: any) => e.label).join(' | ');
    expect(labels).toContain('CHF ?');
  });

  it('puts the charged amount in the order label', async () => {
    const feed = await buildActivityFeed(poolWith({ orders: [order({ quantity: 2 })] }) as any, 24);
    expect(feed.events[0].label).toContain('CHF 49.90');
    expect(feed.events[0].label).toContain('2×');
    expect(feed.events[0].amountCents).toBe(4990);
    expect(feed.events[0].currency).toBe('CHF');
  });
});
