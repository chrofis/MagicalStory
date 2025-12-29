/**
 * Admin Orders Routes
 *
 * Order management and viewing endpoints.
 * Extracted from admin.js for better code organization.
 */

const express = require('express');
const router = express.Router();

const { getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/orders
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Orders are only available in database mode' });
    }

    console.log('📦 [ADMIN] Fetching all orders...');

    const pool = getPool();
    const orders = await pool.query(`
      SELECT
        o.id,
        o.user_id,
        u.email as user_email,
        o.story_id,
        o.stripe_session_id,
        o.stripe_payment_intent_id,
        o.customer_name,
        o.customer_email,
        o.shipping_name,
        o.shipping_address_line1,
        o.shipping_city,
        o.shipping_postal_code,
        o.shipping_country,
        o.amount_total,
        o.currency,
        o.payment_status,
        o.gelato_order_id,
        o.gelato_status,
        o.created_at,
        o.updated_at,
        CASE
          WHEN o.payment_status = 'paid' AND o.gelato_order_id IS NULL THEN true
          ELSE false
        END as has_issue
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `);

    const totalOrders = orders.rows.length;
    const failedOrders = orders.rows.filter(o => o.has_issue);

    log.info(`✅ [ADMIN] Found ${totalOrders} orders, ${failedOrders.length} with issues`);

    res.json({
      success: true,
      totalOrders,
      failedOrdersCount: failedOrders.length,
      orders: orders.rows
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching orders:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
