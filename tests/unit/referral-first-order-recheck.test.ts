/**
 * The webhook re-checks the first-time-buyer rule before paying referral cashback. Until
 * 2026-10-07 that re-check looked for payment_status = 'paid' only - a status every earlier
 * order leaves within seconds (processBookOrder: processing -> completed, or failed) - so a
 * buyer who completed another checkout between claiming the code and paying still earned
 * the referrer CHF 10. Same status set as hasPaidOrder now, minus the session being completed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const database = require('../../server/services/database');
database.getPool = () => ({});
const { hasOtherPaidOrder, hasPaidOrder, PAID_STATUSES } = require('../../server/lib/orders.js');

const ROOT = path.resolve(__dirname, '../..');

// Fake orders table: the earlier order of the buyer is already 'completed'.
const orders = [
  { user_id: 'u1', stripe_session_id: 'cs_old', payment_status: 'completed' },
  { user_id: 'u1', stripe_session_id: 'cs_new', payment_status: 'paid' },
];
function client() {
  return {
    query: async (sql: string, p: any[]) => {
      const statuses = [...sql.matchAll(/'(\w+)'/g)].map(m => m[1]);
      const excl = sql.includes('stripe_session_id !=') ? p[1] : null;
      const rows = orders.filter(o => o.user_id === p[0] && statuses.includes(o.payment_status) && o.stripe_session_id !== excl);
      return { rows: rows.slice(0, 1) };
    },
  };
}

describe('first-time-buyer re-check at the webhook', () => {
  it('sees an earlier order that has already moved past paid', async () => {
    expect(await hasOtherPaidOrder(client(), 'u1', 'cs_new')).toBe(true);
  });
  it('does not count the session being completed itself', async () => {
    const only = { query: async (sql: string, p: any[]) => ({ rows: orders.filter(o => o.stripe_session_id === 'cs_new' && o.stripe_session_id !== p[1] && sql.includes('paid')) }) };
    expect(await hasOtherPaidOrder(only, 'u1', 'cs_new')).toBe(false);
  });
  it('uses the same status set as the checkout-time gate', async () => {
    expect(PAID_STATUSES).toEqual(['paid', 'processing', 'completed', 'failed']);
    expect(await hasPaidOrder('u1', client())).toBe(true);
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(src).not.toMatch(/payment_status = 'paid'\s+AND stripe_session_id !=/);
    expect(src).toContain('hasOtherPaidOrder(client, userId, fullSession.id)');
  });
});
