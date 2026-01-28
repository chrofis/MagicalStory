/**
 * User Routes - /api/user/*
 *
 * User profile, quota, shipping address, and orders
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, logActivity } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/user/location - Get user's location from IP (no auth required)
// Uses ip-api.com free service for geolocation
router.get('/location', async (req, res) => {
  try {
    // Get client IP (handle proxies like Railway, Cloudflare)
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;

    // Skip for localhost/private IPs
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return res.json({ city: null, region: null, country: null });
    }

    // Call ip-api.com (free, no API key needed, 45 req/min limit)
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
    const data = await response.json();

    if (data.status === 'fail') {
      log.debug(`📍 [LOCATION] IP lookup failed for ${ip}`);
      return res.json({ city: null, region: null, country: null });
    }

    log.debug(`📍 [LOCATION] Detected: ${data.city}, ${data.regionName}, ${data.country} (IP: ${ip})`);
    res.json({
      city: data.city || null,
      region: data.regionName || null,
      country: data.country || null
    });
  } catch (error) {
    log.error(`📍 [LOCATION] Error: ${error.message}`);
    res.json({ city: null, region: null, country: null });
  }
});

// GET /api/user/quota - Get user's credits and quota
router.get('/quota', authenticateToken, async (req, res) => {
  try {
    let credits;
    let preferredLanguage = 'English';
    let photoConsentAt = null;

    if (isDatabaseMode()) {
      const selectQuery = 'SELECT credits, preferred_language, photo_consent_at FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      credits = rows[0].credits !== undefined ? rows[0].credits : 500;
      preferredLanguage = rows[0].preferred_language || 'English';
      photoConsentAt = rows[0].photo_consent_at || null;
    } else {
      // File mode not supported in modular routes
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    res.json({
      credits: credits,
      unlimited: credits === -1,
      preferredLanguage: preferredLanguage,
      photoConsentAt: photoConsentAt
    });
  } catch (err) {
    console.error('Error fetching user credits:', err);
    res.status(500).json({ error: 'Failed to fetch user credits' });
  }
});

// GET /api/user/shipping-address - Get user's saved shipping address
router.get('/shipping-address', authenticateToken, async (req, res) => {
  try {
    if (isDatabaseMode()) {
      const selectQuery = 'SELECT shipping_first_name, shipping_last_name, shipping_address_line1, shipping_city, shipping_post_code, shipping_country, shipping_email FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length === 0) {
        return res.json(null);
      }

      const user = rows[0];
      if (!user.shipping_first_name) {
        return res.json(null);
      }

      res.json({
        firstName: user.shipping_first_name,
        lastName: user.shipping_last_name,
        addressLine1: user.shipping_address_line1,
        city: user.shipping_city,
        postCode: user.shipping_post_code,
        country: user.shipping_country,
        email: user.shipping_email
      });
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }
  } catch (err) {
    console.error('Error fetching shipping address:', err);
    res.status(500).json({ error: 'Failed to fetch shipping address' });
  }
});

// PUT /api/user/shipping-address - Save user's shipping address
router.put('/shipping-address', authenticateToken, async (req, res) => {
  try {
    let { firstName, lastName, addressLine1, city, postCode, country, email } = req.body;

    // Validate and normalize country code (must be 2-letter ISO code)
    if (!country || typeof country !== 'string') {
      return res.status(400).json({ error: 'Country code is required' });
    }

    country = country.trim().toUpperCase();

    if (country.length !== 2 || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: 'Country must be a valid 2-letter ISO code (e.g., US, DE, CH, FR)',
        hint: 'Please use the standard 2-letter country code'
      });
    }

    // Validate email format
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    email = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address',
        hint: 'Email format should be like: user@example.com'
      });
    }

    // Validate required fields
    if (!firstName || !lastName || !addressLine1 || !city || !postCode) {
      return res.status(400).json({ error: 'All address fields are required' });
    }

    if (isDatabaseMode()) {
      const updateQuery = 'UPDATE users SET shipping_first_name = $1, shipping_last_name = $2, shipping_address_line1 = $3, shipping_city = $4, shipping_post_code = $5, shipping_country = $6, shipping_email = $7 WHERE id = $8';
      await dbQuery(updateQuery, [firstName, lastName, addressLine1, city, postCode, country, email, req.user.id]);

      await logActivity(req.user.id, req.user.username, 'SHIPPING_ADDRESS_SAVED', { country });
      res.json({ success: true });
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }
  } catch (err) {
    console.error('Error saving shipping address:', err);
    res.status(500).json({ error: 'Failed to save shipping address' });
  }
});

// GET /api/user/orders - Get user's orders
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    log.debug(`📦 [USER] GET /api/user/orders - User: ${req.user.username}`);

    if (isDatabaseMode()) {
      const query = `
        SELECT
          o.id,
          o.story_id,
          o.gelato_order_id,
          o.customer_name,
          o.shipping_name,
          o.shipping_address_line1,
          o.shipping_city,
          o.shipping_postal_code,
          o.shipping_country,
          o.amount_total,
          o.currency,
          o.payment_status,
          o.gelato_status,
          o.tracking_number,
          o.tracking_url,
          o.created_at,
          o.shipped_at,
          o.delivered_at,
          s.data as story_data
        FROM orders o
        LEFT JOIN stories s ON o.story_id = s.id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
      `;
      const rows = await dbQuery(query, [req.user.id]);

      // Parse story data to get title and thumbnail
      const orders = rows.map(order => {
        let storyTitle = 'Untitled Story';
        let thumbnailUrl = null;
        if (order.story_data) {
          try {
            const storyData = typeof order.story_data === 'string'
              ? JSON.parse(order.story_data)
              : order.story_data;
            storyTitle = storyData.title || storyData.storyTitle || 'Untitled Story';
            // Check if story has cover images for thumbnail
            if (storyData.coverImages?.frontCover || storyData.sceneImages?.length > 0) {
              thumbnailUrl = `/api/stories/${order.story_id}/cover`;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }

        // Use first 5 chars of Gelato order ID for display (hides internal DB id)
        const displayOrderId = order.gelato_order_id
          ? order.gelato_order_id.substring(0, 8).toUpperCase()
          : `#${order.id}`;

        return {
          id: order.id,
          displayOrderId,
          storyId: order.story_id,
          storyTitle,
          thumbnailUrl,
          customerName: order.customer_name,
          shippingName: order.shipping_name,
          shippingAddress: {
            line1: order.shipping_address_line1,
            city: order.shipping_city,
            postalCode: order.shipping_postal_code,
            country: order.shipping_country
          },
          amount: order.amount_total,
          currency: order.currency,
          paymentStatus: order.payment_status,
          orderStatus: order.gelato_status || 'processing',
          trackingNumber: order.tracking_number,
          trackingUrl: order.tracking_url,
          createdAt: order.created_at,
          shippedAt: order.shipped_at,
          deliveredAt: order.delivered_at
        };
      });

      // Fetch credit purchases
      const creditPurchasesQuery = `
        SELECT id, amount, balance_after, reference_id, description, created_at
        FROM credit_transactions
        WHERE user_id = $1 AND transaction_type = 'purchase'
        ORDER BY created_at DESC
      `;
      const creditRows = await dbQuery(creditPurchasesQuery, [req.user.id]);

      // Map credit purchases to order-like format
      const creditOrders = creditRows.map(tx => ({
        id: `credit-${tx.id}`,
        type: 'credits',
        creditsAmount: tx.amount,
        balanceAfter: tx.balance_after,
        description: tx.description,
        amount: Math.round((tx.amount / 100) * 500), // CHF 5 per 100 credits
        currency: 'chf',
        paymentStatus: 'paid',
        orderStatus: 'completed',
        createdAt: tx.created_at
      }));

      // Add type to book orders and combine
      const typedOrders = orders.map(o => ({ ...o, type: 'book' }));
      const allOrders = [...typedOrders, ...creditOrders].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      log.debug(`📦 [USER] Found ${orders.length} book orders and ${creditOrders.length} credit purchases`);
      res.json({ orders: allOrders });
    } else {
      // File mode - not implemented for orders
      res.json({ orders: [] });
    }
  } catch (err) {
    console.error('Error fetching user orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// PUT /api/user/update-email - Update user's email address
router.put('/update-email', authenticateToken, async (req, res) => {
  try {
    const { newEmail } = req.body;

    if (!newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (isDatabaseMode()) {
      // Check if email already exists
      const checkQuery = 'SELECT id FROM users WHERE username = $1 AND id != $2';
      const existing = await dbQuery(checkQuery, [newEmail, req.user.id]);

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      const updateQuery = 'UPDATE users SET username = $1 WHERE id = $2';
      await dbQuery(updateQuery, [newEmail, req.user.id]);

      await logActivity(req.user.id, newEmail, 'EMAIL_UPDATED', { oldEmail: req.user.username });
      res.json({ success: true, username: newEmail });
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }
  } catch (err) {
    console.error('Error updating email:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

module.exports = router;
