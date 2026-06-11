/**
 * Admin Activity Routes
 *
 * Chronological feed of platform activity (new users, logins, stories,
 * trials, failed jobs, orders, credit top-ups) derived from existing
 * tables — same data the daily summary email uses.
 */

const express = require('express');
const router = express.Router();

const { getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');
const { buildActivityFeed } = require('../../lib/adminActivity');

const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/activity?hours=24
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }
    const feed = await buildActivityFeed(getPool(), req.query.hours);
    res.json(feed);
  } catch (err) {
    log.error('[ADMIN ACTIVITY] failed:', err.message);
    res.status(500).json({ error: 'Failed to build activity feed' });
  }
});

module.exports = router;
