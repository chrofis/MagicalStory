/**
 * Health & Utility Routes - /api/health, /api/check-ip, /api/log-error
 *
 * Server health checks and debugging utilities
 */

const express = require('express');
const router = express.Router();
const { errorLoggingLimiter } = require('../middleware/rateLimit');
const { validateBody, schemas } = require('../middleware/validation');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

// GET /api/health - Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/health/config — what behaviour is this environment actually running?
//
// Exists because there was no way to answer that question from outside. Every
// behavioural setting was a Railway env var, one dashboard per environment, so
// staging and production silently disagreed about the generation pipeline for
// weeks and nobody could see it. Diffing the two environments is now:
//   curl https://magicalstory.ch/api/health/config
//   curl https://staging.magicalstory.ch/api/health/config
//
// Reports the resolved values from server/config/runtime.js only. It must NEVER
// include secrets, keys or connection strings — that invariant is what lets it
// stay unauthenticated, which is what makes it actually get used.
router.get('/health/config', (req, res) => {
  const { runtimeSnapshot } = require('../config/runtime');
  const { ARCFACE_MIN } = require('../lib/faceIdentity');
  res.json({
    ...runtimeSnapshot(),
    // The ArcFace avatar gate FAILS OPEN by design: if the Python service or the
    // weights are missing, avatars still generate and the second opinion simply
    // does nothing. That is the right behaviour and the wrong thing to have to
    // discover by generating a paid avatar and finding no score. Reporting the
    // threshold here makes "is the gate deployed at all" a free GET.
    arcfaceGate: ARCFACE_MIN,
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8) || '(unset)',
  });
});

// POST /api/health/release-memory - reclaim RAM now, without a restart.
//
// The Python idle reapers only fire after 10-15 min of no use. That is correct
// for normal running but leaves no way to reclaim memory on demand, or to prove
// that the release works, without redeploying — and a redeploy restarts the
// container, which resets RSS and destroys whatever you were measuring.
//
// ?unload=true also drops the lazily-loaded models (rembg / MobileSAM /
// GroundingDINO); they reload on next use in a few seconds.
// Admin-only: this evicts models and briefly slows the next request.
router.post('/health/release-memory', authenticateToken, requireAdmin, async (req, res) => {
  const url = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const unload = req.query.unload === 'true' ? '?unload=true' : '';
  const nodeBefore = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  try {
    const r = await fetch(`${url}/release-memory${unload}`, { method: 'POST', signal: AbortSignal.timeout(30000) });
    const python = await r.json();
    // Node's own heap too, when the runtime exposes it (--expose-gc).
    if (typeof global.gc === 'function') global.gc();
    const nodeAfter = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    res.json({ success: true, python, node: { rss_before_mb: nodeBefore, rss_after_mb: nodeAfter, gc_available: typeof global.gc === 'function' } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
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
    python = { rss_mb: j.rss_mb, rembg_loaded: j.rembg_loaded, mobilesam_loaded: j.mobilesam_loaded, groundingdino_loaded: j.groundingdino_loaded, boot_rss: j.boot_rss, cpu: j.cpu };
  } catch (err) {
    python = { error: err.message };
  }

  // Railway bills per vCPU-minute, so CPU-SECONDS is the billable figure —
  // wall-clock over-states it badly (most of the images stage is network wait
  // on the image model). Both numbers are cumulative since process start:
  // read the endpoint before and after a story and subtract to get that
  // story's true CPU cost, Node and analyzer separately.
  const cpu = process.cpuUsage();
  res.json({
    timestamp: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    node: {
      cpu_seconds: Math.round((cpu.user + cpu.system) / 1000) / 1000,
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
