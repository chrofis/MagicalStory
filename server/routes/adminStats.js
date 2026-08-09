/**
 * Admin Story Metrics Routes
 *
 * Serves rows from the story_metrics table (migrations/014_story_metrics.sql)
 * for the AdminDashboard "Story Stats" tab (docs/plans/story-stats-page.md).
 *
 * NOTE: GET /api/admin/stats is already taken by the dashboard overview stats
 * (server/routes/admin/analytics.js), so this router uses /story-metrics.
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode } = require('../services/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/admin/story-metrics?days=90&env=staging&mode=beats
router.get('/story-metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Story metrics are only available in database mode' });
    }

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 3650);
    const params = [String(days)];
    const clauses = [`created_at > NOW() - ($1 || ' days')::interval`];

    if (req.query.env) {
      params.push(String(req.query.env));
      clauses.push(`environment = $${params.length}`);
    }
    if (req.query.mode) {
      params.push(String(req.query.mode));
      clauses.push(`pipeline_mode = $${params.length}`);
    }

    const rows = await dbQuery(
      `SELECT * FROM story_metrics WHERE ${clauses.join(' AND ')} ORDER BY created_at`,
      params
    );

    res.json({ rows });
  } catch (err) {
    log.error('[ADMIN] Error fetching story metrics:', err);
    res.status(500).json({ error: 'Failed to fetch story metrics' });
  }
});

module.exports = router;
