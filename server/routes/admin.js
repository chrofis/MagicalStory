/**
 * Admin Routes - /api/admin/*
 *
 * Main admin router that aggregates all admin submodules.
 * Impersonation routes are kept here as they require JWT_SECRET.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const fs = require('fs').promises;
const path = require('path');

const { getPool, isDatabaseMode, logActivity } = require('../services/database');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');
const { log } = require('../utils/logger');

function getDbPool() { return getPool(); }

// Server.js-local dependencies received via init()
let deps = {};

function initAdminRoutes(serverDeps) {
  deps = serverDeps;
}

// Legacy file-based storage helpers
const CONFIG_FILE = path.join(__dirname, '../../data/config.json');
async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

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

// =============================================
// CONFIG, LANDMARKS, JOB ADMIN (from server.js)
// =============================================

// API Key management (admin only)
router.post('/config', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { anthropicApiKey, geminiApiKey } = req.body;
    const config = {
      anthropicApiKey: anthropicApiKey || '',
      geminiApiKey: geminiApiKey || ''
    };

    await writeJSON(CONFIG_FILE, config);
    await logActivity(req.user.id, req.user.username, 'API_KEYS_UPDATED', {});

    res.json({ message: 'API keys updated successfully' });
  } catch (err) {
    log.error('Config update error:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Token promotion config (admin only)
router.get('/config/token-promo', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const result = await getDbPool().query("SELECT config_value FROM config WHERE config_key = 'token_promo_multiplier'");
    const multiplier = result.rows[0]?.config_value ? parseInt(result.rows[0].config_value) : 1;
    res.json({ multiplier, isPromoActive: multiplier > 1 });
  } catch (err) {
    log.error('Token promo config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch token promo config' });
  }
});

router.post('/config/token-promo', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { multiplier } = req.body;
    if (!multiplier || ![1, 2].includes(multiplier)) {
      return res.status(400).json({ error: 'Multiplier must be 1 or 2' });
    }

    await getDbPool().query(`
      INSERT INTO config (config_key, config_value) VALUES ('token_promo_multiplier', $1)
      ON CONFLICT (config_key) DO UPDATE SET config_value = $1
    `, [multiplier.toString()]);

    await logActivity(req.user.id, req.user.username, 'TOKEN_PROMO_UPDATED', { multiplier });
    log.info(`🎁 [ADMIN] Token promo multiplier set to ${multiplier}x by ${req.user.username}`);

    res.json({ success: true, multiplier });
  } catch (err) {
    log.error('Token promo config update error:', err);
    res.status(500).json({ error: 'Failed to update token promo config' });
  }
});

// NOTE: AI proxy endpoints moved to server/routes/ai-proxy.js
// - POST /api/claude
// - POST /api/gemini

// Admin endpoint to clear landmarks cache (forces re-discovery with new scoring)
// Supports either JWT auth (admin role) or secret key via query param
router.delete('/landmarks-cache', async (req, res) => {
  try {
    const { city, secret } = req.query;

    // Check auth: either valid admin JWT or secret key
    const secretKey = process.env.ADMIN_SECRET || 'clear-landmarks-2026';
    const hasValidSecret = secret === secretKey;

    if (!hasValidSecret) {
      // Try JWT auth
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.role !== 'admin') {
          return res.status(403).json({ error: 'Admin access required' });
        }
      } catch (jwtErr) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }
    let result;

    if (city) {
      // Clear specific city from landmark_index
      const cacheKey = city.toLowerCase().replace(/\s+/g, '_');
      result = await getDbPool().query(
        'DELETE FROM landmark_index WHERE LOWER(nearest_city) LIKE $1',
        [`%${cacheKey}%`]
      );
      // Also clear in-memory cache
      for (const key of deps.userLandmarkCache.keys()) {
        if (key.includes(cacheKey)) {
          deps.userLandmarkCache.delete(key);
        }
      }
      log.info(`[ADMIN] Cleared landmarks for "${city}" (${result.rowCount} rows from landmark_index)`);
    } else {
      // Clear all from landmark_index
      result = await getDbPool().query('DELETE FROM landmark_index');
      deps.userLandmarkCache.clear();
      log.info(`[ADMIN] Cleared all landmarks (${result.rowCount} rows from landmark_index)`);
    }

    res.json({
      message: city ? `Cleared cache for "${city}"` : 'Cleared all landmarks cache',
      rowsDeleted: result.rowCount
    });
  } catch (err) {
    log.error('Clear landmarks cache error:', err);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Admin endpoint to get landmark photos for a city (for debugging/review)
router.get('/landmarks-photos', async (req, res) => {
  try {
    const { city, secret } = req.query;
    const secretKey = process.env.ADMIN_SECRET || 'clear-landmarks-2026';
    if (secret !== secretKey) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
    if (!city) {
      return res.status(400).json({ error: 'city parameter required' });
    }

    // Query from landmark_index table
    const result = await getDbPool().query(
      `SELECT id, name, type, nearest_city, country,
              photo_url, photo_description, photo_attribution,
              photo_url_2, photo_description_2,
              photo_url_3, photo_description_3,
              photo_url_4, photo_description_4,
              photo_url_5, photo_description_5,
              photo_url_6, photo_description_6
       FROM landmark_index WHERE LOWER(nearest_city) = LOWER($1)
       ORDER BY score DESC`,
      [city]
    );

    const landmarks = result.rows.map(l => ({
      id: l.id,
      name: l.name,
      type: l.type,
      city: l.nearest_city,
      country: l.country,
      photos: [
        l.photo_url ? { url: l.photo_url, description: l.photo_description } : null,
        l.photo_url_2 ? { url: l.photo_url_2, description: l.photo_description_2 } : null,
        l.photo_url_3 ? { url: l.photo_url_3, description: l.photo_description_3 } : null,
        l.photo_url_4 ? { url: l.photo_url_4, description: l.photo_description_4 } : null,
        l.photo_url_5 ? { url: l.photo_url_5, description: l.photo_description_5 } : null,
        l.photo_url_6 ? { url: l.photo_url_6, description: l.photo_description_6 } : null
      ].filter(Boolean)
    }));

    res.json({ city, count: landmarks.length, landmarks });
  } catch (err) {
    log.error('Error getting landmark photos:', err);
    res.status(500).json({ error: 'Failed to get landmark photos', details: err.message, code: err.code });
  }
});

// Admin endpoint to get job input data (for debugging failed jobs)
router.get('/job-input', async (req, res) => {
  try {
    const { jobId, secret } = req.query;
    const secretKey = process.env.ADMIN_SECRET || 'clear-landmarks-2026';
    if (secret !== secretKey) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
    if (!jobId) {
      return res.status(400).json({ error: 'jobId parameter required' });
    }

    const result = await getDbPool().query(
      `SELECT id, status, created_at, updated_at, progress, progress_message,
              input_data, error_message, result_data
       FROM story_jobs WHERE id = $1`,
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];
    res.json({
      id: job.id,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      progress: job.progress,
      progress_message: job.progress_message,
      error_message: job.error_message,
      input_data: job.input_data,
      result_data: job.result_data
    });
  } catch (err) {
    log.error('Error getting job input:', err);
    res.status(500).json({ error: 'Failed to get job input', details: err.message });
  }
});

// Admin endpoint to start processing a job (used after retry creates the job)
router.post('/jobs/:jobId/start', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { jobId } = req.params;

    // Verify job exists and is pending
    const jobResult = await getDbPool().query(
      'SELECT id, status, user_id FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobResult.rows[0];
    if (job.status !== 'pending') {
      return res.status(400).json({
        error: 'Can only start pending jobs',
        currentStatus: job.status
      });
    }

    // Start processing the job asynchronously
    log.info(`[ADMIN] Starting job ${jobId} for user ${job.user_id}`);
    deps.processStoryJob(jobId).catch(err => {
      log.error(`❌ Admin-started job ${jobId} failed:`, err);
    });

    res.json({
      success: true,
      jobId,
      message: 'Job processing started'
    });
  } catch (err) {
    log.error('Error starting job:', err);
    res.status(500).json({ error: 'Failed to start job', details: err.message });
  }
});

// Mount all submodule routes
router.use('/', adminSubroutes);

module.exports = { adminRoutes: router, initAdminRoutes };
