/** P10 (code review 2026-10-04): the unauthenticated order-status endpoint must not leak the order row. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const database = require('../../server/services/database');
database.getPool = () => ({});
const { orderStatusView } = require('../../server/lib/orders.js');

const row = {
  id: 9, user_id: 'u1', stripe_session_id: 'cs_1', stripe_payment_intent_id: 'pi_1',
  customer_name: 'A B', customer_email: 'a@b.ch', shipping_name: 'A B',
  shipping_address_line1: 'Street 1', shipping_city: 'Baden', shipping_postal_code: '5400', shipping_country: 'CH',
  amount_total: 4900, currency: 'chf', tokens_credited: 150, gelato_order_id: 'g1',
};

describe('orderStatusView', () => {
  it('anonymous viewers get only amount, currency and tokens', () => {
    expect(orderStatusView(row, null)).toEqual({ amount_total: 4900, currency: 'chf', tokens_credited: 150 });
  });
  it('a different logged-in user gets no recipient details', () => {
    expect(orderStatusView(row, 'u2')).not.toHaveProperty('customer_email');
  });
  it('the owner gets the recipient details but never internal ids', () => {
    const v = orderStatusView(row, 'u1');
    expect(v.customer_email).toBe('a@b.ch');
    expect(v.shipping_city).toBe('Baden');
    expect(v).not.toHaveProperty('stripe_payment_intent_id');
    expect(v).not.toHaveProperty('gelato_order_id');
  });
});
