/**
 * The printed book ships to the address the customer typed into Stripe's shipping form.
 *
 * stripe-node v20 (API 2025-11-17.clover) returns that address ONLY under
 * collected_information.shipping_details; the webhook, the admin retry and the stuck-order
 * resume read `session.shipping?.address || session.customer_details?.address` until
 * 2026-10-07, i.e. the BILLING address whenever the customer unticked "billing same as
 * shipping". The order-status fallback also asked Stripe to expand two non-expandable fields.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const database = require('../../server/services/database');
database.getPool = () => ({});
const { shippingFromSession, resolveBookOrderInputs } = require('../../server/lib/gelato.js');

const ROOT = path.resolve(__dirname, '../..');

// A paid book session as stripe-node v20 returns it: billing (customer_details) and shipping
// (collected_information) differ because the customer pays for a gift sent to grandma.
const session = {
  id: 'cs_live_1',
  payment_status: 'paid',
  customer_details: {
    name: 'Anna Buyer',
    email: 'anna@example.ch',
    address: { line1: 'Bahnhofstrasse 1', city: 'Zürich', postal_code: '8001', country: 'CH' },
  },
  collected_information: {
    shipping_details: {
      name: 'Oma Berta',
      address: { line1: 'Dorfweg 7', line2: null, city: 'Baden', postal_code: '5400', state: null, country: 'CH' },
    },
  },
  metadata: { userId: 'u1', storyIds: JSON.stringify(['s1']), coverType: 'hardcover', bookFormat: 'A4', quantity: '1' },
};

const pool = {
  query: async (sql: string) => {
    if (sql.includes('preferred_language')) return { rows: [{ preferred_language: 'German' }] };
    if (sql.includes('FROM stories')) return { rows: [{ id: 's1' }] };
    throw new Error('unexpected: ' + sql.slice(0, 40));
  },
};

describe('the installed Stripe SDK has no top-level shipping field on a Checkout Session', () => {
  it('Sessions.d.ts puts shipping_details under collected_information only', () => {
    const dts = fs.readFileSync(path.join(ROOT, 'node_modules/stripe/types/Checkout/Sessions.d.ts'), 'utf8');
    // Session members sit at 8 spaces; CollectedInformation members at 10.
    expect(dts).toMatch(/^ {8}collected_information: Session\.CollectedInformation \| null;/m);
    expect(dts).toMatch(/^ {10}shipping_details: CollectedInformation\.ShippingDetails \| null;/m);
    expect(dts).not.toMatch(/^ {8}shipping(_details)?[?]?:/m);
  });
  it('and no order-side reader asks for session.shipping or expands customer/shipping details any more', () => {
    for (const f of ['server.js', 'server/lib/gelato.js', 'server/routes/print.js']) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).not.toMatch(/Session\.shipping\?\./);
      expect(src, f).not.toMatch(/expand: \[[^\]]*shipping_details/);
    }
  });
});

describe('shippingFromSession', () => {
  it('returns the collected shipping recipient and address, never the billing address', () => {
    expect(shippingFromSession(session)).toEqual({
      name: 'Oma Berta',
      address: session.collected_information.shipping_details.address,
    });
  });
  it('is null when the session collected no shipping address', () => {
    expect(shippingFromSession({ customer_details: session.customer_details })).toBeNull();
    expect(shippingFromSession({ collected_information: { shipping_details: null } })).toBeNull();
    expect(shippingFromSession(undefined)).toBeNull();
  });
});

describe('resolveBookOrderInputs (webhook, admin retry and stuck-order resume all use it)', () => {
  it('ships to the collected address with the recipient name; the buyer stays the customer', async () => {
    const inp = await resolveBookOrderInputs(pool, session);
    expect(inp.address.line1).toBe('Dorfweg 7');
    expect(inp.address.city).toBe('Baden');
    expect(inp.customerInfo.shippingName).toBe('Oma Berta');
    expect(inp.customerInfo.name).toBe('Anna Buyer');
    expect(inp.customerInfo.email).toBe('anna@example.ch');
    expect(inp.customerInfo.language).toBe('German');
    expect(inp.validatedStoryIds).toEqual(['s1']);
  });
  it('refuses a paid session without a shipping address instead of shipping to the billing one', async () => {
    const noShipping = { ...session, collected_information: null };
    await expect(resolveBookOrderInputs(pool, noShipping)).rejects.toThrow(/no shipping address/);
  });
});
