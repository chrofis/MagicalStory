#!/usr/bin/env node
/**
 * Send a test email to verify template styling.
 * Usage: node scripts/admin/test-email.js <email> [template]
 * Templates: story-complete, order-confirmation, email-verification, password-reset,
 *            order-shipped, order-failed, story-failed
 */
require('dotenv').config();
const email = require('../../email');

async function main() {
  const to = process.argv[2];
  const template = process.argv[3] || 'story-complete';

  if (!to) {
    console.log('Usage: node scripts/admin/test-email.js <email> [template]');
    console.log('Templates: story-complete, order-confirmation, email-verification,');
    console.log('           password-reset, order-shipped, order-failed, story-failed');
    process.exit(1);
  }

  if (!email.isEmailConfigured()) {
    console.error('RESEND_API_KEY not configured in .env');
    process.exit(1);
  }

  console.log(`Sending "${template}" test email to ${to}...`);

  let result;
  switch (template) {
    case 'story-complete':
      result = await email.sendStoryCompleteEmail(to, 'Roger', 'The Magic Forest Adventure', 'test-123', 'English');
      break;
    case 'order-confirmation':
      result = await email.sendOrderConfirmationEmail(to, 'Roger Fischer', {
        orderId: 'TEST1234',
        amount: '49.90',
        currency: 'CHF',
        shippingAddress: { line1: 'Musterstrasse 1', city: 'Zurich', postal_code: '8000', country: 'CH' },
        deliveryEstimateMin: new Date(Date.now() + 7 * 86400000),
        deliveryEstimateMax: new Date(Date.now() + 14 * 86400000),
      }, 'English');
      break;
    case 'email-verification':
      result = await email.sendEmailVerificationEmail(to, 'Roger', 'https://www.magicalstory.ch/verify?token=test123', 'English');
      if (result) result = result.data; // structured result
      break;
    case 'password-reset':
      result = await email.sendPasswordResetEmail(to, 'Roger', 'https://www.magicalstory.ch/reset?token=test123', 'English');
      if (result) result = result.data;
      break;
    case 'order-shipped':
      result = await email.sendOrderShippedEmail(to, 'Roger Fischer', {
        orderId: 'TEST1234',
        trackingNumber: 'CH123456789',
        trackingUrl: 'https://tracking.example.com/CH123456789',
      }, 'English');
      break;
    case 'order-failed':
      result = await email.sendOrderFailedEmail(to, 'Roger Fischer', 'Test error message', 'English');
      break;
    case 'story-failed':
      result = await email.sendStoryFailedEmail(to, 'Roger', 'English');
      break;
    default:
      console.error(`Unknown template: ${template}`);
      process.exit(1);
  }

  if (result) {
    console.log('Email sent successfully:', result);
  } else {
    console.error('Email send failed');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
