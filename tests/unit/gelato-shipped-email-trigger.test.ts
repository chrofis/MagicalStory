import { describe, it, expect } from 'vitest';
const { extractTracking, shouldSendShippedEmail } = require('../../server/lib/gelatoShipment');

describe('gelato shipped-email trigger (prod order 99: tracking arrived on "printed")', () => {
  const items = [{ fulfillments: [{ trackingCode: '996008154400058714', trackingUrl: 'https://t/x' }] }];
  it('extracts tracking from the first fulfillment', () => {
    expect(extractTracking(items)).toEqual({ trackingNumber: '996008154400058714', trackingUrl: 'https://t/x' });
    expect(extractTracking([])).toEqual({ trackingNumber: null, trackingUrl: null });
  });
  it('sends when printed carries a tracking code', () => {
    expect(shouldSendShippedEmail({ fulfillmentStatus: 'printed', trackingNumber: '996' })).toBe(true);
  });
  it('sends on shipped with tracking', () => {
    expect(shouldSendShippedEmail({ fulfillmentStatus: 'shipped', trackingNumber: '996' })).toBe(true);
  });
  it('never sends without a tracking code', () => {
    expect(shouldSendShippedEmail({ fulfillmentStatus: 'printed', trackingNumber: null })).toBe(false);
    expect(shouldSendShippedEmail({ fulfillmentStatus: 'shipped', trackingNumber: null })).toBe(false);
  });
  it('does not send for early or late statuses', () => {
    for (const s of ['created', 'passed', 'in_production', 'delivered', 'canceled'])
      expect(shouldSendShippedEmail({ fulfillmentStatus: s, trackingNumber: '996' })).toBe(false);
  });
});
