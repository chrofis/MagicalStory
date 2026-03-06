/**
 * Health & Utility Routes - /api/health, /api/check-ip, /api/log-error
 *
 * Server health checks and debugging utilities
 */

const express = require('express');
const router = express.Router();
const { errorLoggingLimiter } = require('../middleware/rateLimit');
const { validateBody, schemas } = require('../middleware/validation');

// GET /api/health - Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/debug-landmarks/:city - Temporary debug endpoint for landmarks
const { getPool } = require('../services/database');
router.get('/debug-landmarks/:city', async (req, res) => {
  try {
    const city = req.params.city.toLowerCase();
    const pool = getPool();
    const result = await pool.query(
      "SELECT location_key, city, country, landmarks, landmark_count, created_at FROM discovered_landmarks WHERE LOWER(city) = $1",
      [city]
    );
    const formatted = result.rows.map(row => ({
      location_key: row.location_key,
      city: row.city,
      country: row.country,
      landmark_count: row.landmark_count,
      created_at: row.created_at,
      landmarks: typeof row.landmarks === 'string' ? JSON.parse(row.landmarks) : row.landmarks
    }));
    res.json({ count: result.rowCount, entries: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/check-ip - Shows Railway's outgoing IP for debugging
router.get('/check-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({
      railwayOutgoingIp: data.ip,
      requestIp: req.ip,
      forwardedFor: req.headers['x-forwarded-for'],
      message: 'Railway outgoing IP address for debugging'
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// POST /api/log-error - Browser error logging endpoint
// Rate limited to prevent DoS via log flooding
router.post('/log-error', errorLoggingLimiter, validateBody(schemas.logError), (req, res) => {
  try {
    const { message, stack, url, line, column, userAgent, userId, timestamp, errorType } = req.body;

    // Log to console with emoji for visibility in Railway logs
    console.error('🔴 BROWSER ERROR:', {
      type: errorType || 'JavaScript Error',
      message,
      url,
      location: line && column ? `Line ${line}, Column ${column}` : 'Unknown',
      user: userId || 'Anonymous',
      userAgent: userAgent || 'Unknown',
      timestamp: timestamp || new Date().toISOString(),
      stack: stack ? stack.substring(0, 500) : 'No stack trace' // Limit stack trace length
    });

    res.json({ success: true, message: 'Error logged' });
  } catch (err) {
    console.error('Error logging browser error:', err);
    res.status(500).json({ success: false, error: 'Failed to log error' });
  }
});

module.exports = router;
