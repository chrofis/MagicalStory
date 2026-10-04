/**
 * When does a Gelato order_status_updated event mean "the parcel is on its way"?
 *
 * Prod order 99 (2026-10-01): Gelato went uploading -> processing -> printing ->
 * printed and never sent a 'shipped' event, yet the 'printed' event already
 * carried the carrier trackingCode. The handler only emailed on
 * fulfillmentStatus === 'shipped', so the customer never got a tracking mail.
 * The signal is the tracking code, not the status name.
 */

// Statuses at which a tracking code means the parcel has left (or is leaving)
// the printer. 'delivered' is excluded: a "your order shipped" mail after
// delivery is noise.
const SHIPPABLE_STATUSES = new Set(['printed', 'shipped']);

function extractTracking(items) {
  const f = items?.[0]?.fulfillments?.[0];
  return { trackingNumber: f?.trackingCode || null, trackingUrl: f?.trackingUrl || null };
}

function shouldSendShippedEmail({ fulfillmentStatus, trackingNumber }) {
  return Boolean(trackingNumber) && SHIPPABLE_STATUSES.has(fulfillmentStatus);
}

module.exports = { extractTracking, shouldSendShippedEmail, SHIPPABLE_STATUSES };
