#!/usr/bin/env node
/**
 * Manually send order confirmation email for a specific order.
 * Usage: node scripts/admin/send-order-email.js <orderId>
 */
require('dotenv').config();
const { Pool } = require('pg');
const email = require('../../email');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.log('Usage: node scripts/admin/send-order-email.js <orderId>');
    process.exit(1);
  }

  const result = await pool.query(
    `SELECT id, customer_name, customer_email, user_id, gelato_order_id,
            amount_total, currency, confirmation_email_sent,
            delivery_estimate_min, delivery_estimate_max,
            shipping_address_line1, shipping_address_line2, shipping_city,
            shipping_state, shipping_postal_code, shipping_country
     FROM orders WHERE id = $1`,
    [orderId]
  );

  if (result.rows.length === 0) {
    console.log('Order not found:', orderId);
    process.exit(1);
  }

  const order = result.rows[0];
  console.log('Order:', order.id, order.customer_name, order.customer_email);
  console.log('Already sent:', order.confirmation_email_sent);

  // Get user language
  let language = 'English';
  if (order.user_id) {
    const userResult = await pool.query(
      'SELECT preferred_language FROM users WHERE id = $1',
      [order.user_id]
    );
    if (userResult.rows[0]?.preferred_language) {
      language = userResult.rows[0].preferred_language;
    }
  }
  console.log('Language:', language);

  const shippingAddress = {
    line1: order.shipping_address_line1,
    line2: order.shipping_address_line2,
    city: order.shipping_city,
    state: order.shipping_state,
    postal_code: order.shipping_postal_code,
    country: order.shipping_country
  };
  console.log('Shipping:', shippingAddress);

  const gelatoId = order.gelato_order_id || String(order.id);
  const sent = await email.sendOrderConfirmationEmail(
    order.customer_email,
    order.customer_name,
    {
      orderId: gelatoId.substring(0, 8).toUpperCase(),
      amount: order.amount_total ? (order.amount_total / 100).toFixed(2) : '0.00',
      currency: (order.currency || 'CHF').toUpperCase(),
      shippingAddress,
      deliveryEstimateMin: order.delivery_estimate_min,
      deliveryEstimateMax: order.delivery_estimate_max
    },
    language
  );

  if (sent) {
    await pool.query('UPDATE orders SET confirmation_email_sent = TRUE WHERE id = $1', [orderId]);
    console.log('✅ Email sent and flag updated');
  } else {
    console.log('❌ Email failed to send');
  }

  pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
