/**
 * Admin Routes - /api/admin/*
 *
 * Main admin router that aggregates all admin submodules.
 * Impersonation routes are kept here as they require JWT_SECRET.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const { getPool, isDatabaseMode } = require('../services/database');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Import aggregated admin routes from submodules
const adminSubroutes = require('./admin/index');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// =============================================
// IMPERSONATION
// =============================================

// POST /api/admin/impersonate/:userId
router.post('/impersonate/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (req.user.impersonating) {
      return res.status(400).json({ error: 'Cannot impersonate while already impersonating. Stop current impersonation first.' });
    }

    const targetUserId = req.params.userId;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const result = await pool.query('SELECT id, username, email, role, email_verified FROM users WHERE id = $1', [targetUserId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const targetUser = result.rows[0];

    if (String(targetUser.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot impersonate yourself' });
    }

    log.info(`👤 [ADMIN] ${req.user.username} is impersonating user ${targetUser.username}`);
    log.info(`👤 [ADMIN] [DEBUG] Impersonation token user ID: "${targetUser.id}" (type: ${typeof targetUser.id})`);

    const impersonationToken = jwt.sign(
      {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role,
        emailVerified: targetUser.email_verified,
        impersonating: true,
        originalAdminId: req.user.id,
        originalAdminUsername: req.user.username,
        originalAdminRole: 'admin'
      },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({
      token: impersonationToken,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role
      },
      impersonating: true,
      originalAdmin: {
        id: req.user.id,
        username: req.user.username
      }
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error impersonating user:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/stop-impersonate
router.post('/stop-impersonate', authenticateToken, async (req, res) => {
  try {
    if (!req.user.impersonating || !req.user.originalAdminId) {
      return res.status(400).json({ error: 'Not currently impersonating anyone' });
    }

    const originalAdminId = req.user.originalAdminId;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const result = await pool.query('SELECT id, username, email, role, credits, email_verified FROM users WHERE id = $1', [originalAdminId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Original admin user not found' });
    }
    const adminUser = result.rows[0];

    log.info(`👤 [ADMIN] ${req.user.originalAdminUsername} stopped impersonating ${req.user.username}`);

    const adminToken = jwt.sign(
      {
        id: adminUser.id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role,
        emailVerified: adminUser.email_verified
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token: adminToken,
      user: {
        id: adminUser.id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role,
        credits: adminUser.credits
      },
      impersonating: false
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error stopping impersonation:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/landmarks/:city - Query landmarks for a city
router.get('/landmarks/:city', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const city = req.params.city.toLowerCase();
    const pool = getPool();
    const result = await pool.query(
      "SELECT city, country, language, landmarks, created_at FROM landmarks_discovery WHERE LOWER(city) = $1 ORDER BY language",
      [city]
    );

    const formatted = result.rows.map(row => {
      let landmarks = row.landmarks;
      if (typeof landmarks === 'string') {
        landmarks = JSON.parse(landmarks);
      }
      return {
        city: row.city,
        country: row.country,
        language: row.language,
        created_at: row.created_at,
        landmarks: landmarks
      };
    });

    res.json({ count: result.rowCount, entries: formatted });
  } catch (err) {
    console.error('Error querying landmarks:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mount all submodule routes
router.use('/', adminSubroutes);

module.exports = router;
