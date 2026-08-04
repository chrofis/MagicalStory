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

// GET /api/health/memory - Live memory breakdown for this container.
//
// Railway bills resident memory per MB per MINUTE, so what this process HOLDS
// is the bill. Railway's own metrics are container-total at 5-minute
// resolution, which can't separate Node from the Python analyzer and is too
// coarse to see whether memory is released after a story generation.
//
// The number that matters is `external` vs `rss`: page images move through Node
// as large Buffers, which live OUTSIDE the V8 heap in malloc'd memory. When
// those are freed, glibc can keep the pages in per-thread arenas instead of
// returning them to the OS — that retention is why RSS used to climb to a peak
// and stay there until a redeploy. If rss stays high while heapUsed and
// external have fallen back, the allocator is holding freed pages, not the app.
router.get('/health/memory', async (req, res) => {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;

  // The Python analyzer is a separate process in the same container, so it is
  // billed with us but invisible to process.memoryUsage(). Fetch it so the two
  // add up to what Railway charges for. Never fail the endpoint over it.
  let python = null;
  try {
    const url = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    python = { rss_mb: j.rss_mb, rembg_loaded: j.rembg_loaded, mobilesam_loaded: j.mobilesam_loaded, groundingdino_loaded: j.groundingdino_loaded, boot_rss: j.boot_rss };
  } catch (err) {
    python = { error: err.message };
  }

  res.json({
    timestamp: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    node: {
      rss_mb: mb(m.rss),
      heapUsed_mb: mb(m.heapUsed),
      heapTotal_mb: mb(m.heapTotal),
      external_mb: mb(m.external),
      arrayBuffers_mb: mb(m.arrayBuffers),
      heapLimit_mb: mb(require('v8').getHeapStatistics().heap_size_limit),
    },
    python,
    env: {
      mallocArenaMax: process.env.MALLOC_ARENA_MAX || '(unset)',
      railwayEnv: process.env.RAILWAY_ENVIRONMENT_NAME || '(unset)',
    },
    container_total_mb: python && python.rss_mb ? Math.round(mb(m.rss) + python.rss_mb) : null,
  });
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
