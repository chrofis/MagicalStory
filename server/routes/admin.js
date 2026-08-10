/**
 * Admin Routes - /api/admin/*
 *
 * Main admin router that aggregates all admin submodules.
 * Impersonation routes are kept here as they require token signing.
 */

const express = require('express');
const router = express.Router();

const fs = require('fs').promises;
const path = require('path');

const { getPool, isDatabaseMode, logActivity } = require('../services/database');
const { authenticateToken, requireAdmin, verifyToken, signToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

function getDbPool() { return getPool(); }

// Server.js-local dependencies received via init()
let deps = {};

function initAdminRoutes(serverDeps) {
  deps = serverDeps;
  // Thread server deps into submodules that need them. The jobs submodule's
  // Test Lab text-only rerun endpoint needs processStoryJob to start jobs.
  // (require() here returns the same cached instance admin/index.js mounted.)
  try {
    require('./admin/jobs').initJobsRoutes(serverDeps);
  } catch (e) {
    log.error('Failed to init admin/jobs routes with deps:', e.message);
  }
}

// Legacy file-based storage helpers
const CONFIG_FILE = path.join(__dirname, '../../data/config.json');
async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// Import aggregated admin routes from submodules
const adminSubroutes = require('./admin/index');

// requireAdmin is now imported from ../middleware/auth

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
    await logActivity(req.user.id, req.user.username, 'ADMIN_IMPERSONATE_START', {
      targetUserId: targetUser.id,
      targetUsername: targetUser.username,
    }, req.user);

    const impersonationToken = signToken(
      {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role,
        emailVerified: targetUser.email_verified,
        impersonating: true,
        originalAdminId: req.user.id,
        originalAdminUsername: req.user.username,
        originalAdminRole: 'admin',
        impersonationStartedAt: Date.now()
      },
      '2h'
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

    // Verify the token was issued to an actual admin
    if (req.user.originalAdminRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required to stop impersonation' });
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

    // Double-check the original admin is still an admin in the database
    if (adminUser.role !== 'admin') {
      return res.status(403).json({ error: 'Original user is no longer an admin' });
    }

    log.info(`👤 [ADMIN] ${req.user.originalAdminUsername} stopped impersonating ${req.user.username}`);
    await logActivity(originalAdminId, req.user.originalAdminUsername, 'ADMIN_IMPERSONATE_STOP', {
      targetUserId: req.user.id,
      targetUsername: req.user.username,
    });

    const adminToken = signToken(
      {
        id: adminUser.id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role,
        emailVerified: adminUser.email_verified
      },
      '7d'
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
    await logActivity(req.user.id, req.user.username, 'API_KEYS_UPDATED', {}, req.user);

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

    await logActivity(req.user.id, req.user.username, 'TOKEN_PROMO_UPDATED', { multiplier }, req.user);
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
    const hasValidSecret = process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;

    if (!hasValidSecret) {
      // Try JWT auth
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const token = authHeader.split(' ')[1];
        const decoded = verifyToken(token);
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
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
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
       FROM landmark_index WHERE LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñ', 'uuaaaooeeeeiicn')) = LOWER(translate($1, 'üùäàâöôéèêëîïçñ', 'uuaaaooeeeeiicn'))
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
    if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
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

// =============================================
// TRIAL RATE LIMIT RESET
// =============================================

// POST /api/admin/reset-rate-limits — reset all in-memory trial rate limiters
router.post('/reset-rate-limits', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { resetTrialRateLimits } = require('./trial');
    const { resetTrialMiddlewareStores } = require('../middleware/rateLimit');

    // Reset trial.js local limiters + fingerprint + daily counters
    const trialResult = resetTrialRateLimits();

    // Reset middleware rate limiters (trialAvatarLimiter)
    resetTrialMiddlewareStores();

    log.info(`[ADMIN] Rate limits reset by ${req.user.username}`);

    res.json({
      success: true,
      message: 'All trial rate limits reset',
      details: {
        fingerprintsCleared: trialResult.fingerprintsCleared,
        limitersReset: ['trialPhoto', 'trialIdeas', 'trialRegister', 'trialAvatar', 'fingerprint', 'dailyCounters'],
      },
    });
  } catch (err) {
    log.error('[ADMIN] Error resetting rate limits:', err);
    res.status(500).json({ error: 'Failed to reset rate limits' });
  }
});

// Mount all submodule routes
router.use('/', adminSubroutes);

module.exports = { adminRoutes: router, initAdminRoutes };

// ── Admin drafts ────────────────────────────────────────────────────────────
// A story generated while impersonating belongs to the target user but stays
// invisible to them (list, detail and share link all filter it out) until an
// admin publishes it here. That is what makes one persistent account per family
// workable: generate, look, regenerate, publish only the good one.

// List every unpublished draft, newest first, across all users.
router.get('/drafts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT s.id, s.user_id, s.created_at, s.metadata, u.email, u.username
         FROM stories s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.admin_draft = true
        ORDER BY s.created_at DESC LIMIT 100`
    );
    res.json({
      drafts: rows.map(r => {
        const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
        return {
          id: r.id,
          title: meta.title || null,
          createdAt: r.created_at,
          user: { id: r.user_id, email: r.email, username: r.username },
        };
      }),
    });
  } catch (err) {
    log.error('❌ [ADMIN] Failed to list drafts:', err.message);
    res.status(500).json({ error: 'Failed to list drafts' });
  }
});

// Publish one draft — the story becomes visible to its owner from this moment.
router.post('/stories/:storyId/publish', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { storyId } = req.params;
    const { rows } = await getPool().query(
      `UPDATE stories SET admin_draft = false
        WHERE id = $1 AND admin_draft = true
        RETURNING id, user_id`,
      [storyId]
    );
    if (rows.length === 0) {
      // Either it does not exist or it was already published. Say which, so a
      // double-click reads as a no-op instead of a failure.
      const exists = await getPool().query('SELECT admin_draft FROM stories WHERE id = $1', [storyId]);
      if (exists.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
      return res.json({ success: true, alreadyPublished: true, storyId });
    }
    log.info(`📖 [ADMIN] ${req.user.username} published draft ${storyId} to user ${rows[0].user_id}`);
    await logActivity(req.user.id, req.user.username, 'ADMIN_PUBLISH_DRAFT', {
      storyId, targetUserId: rows[0].user_id,
    }, req.user);
    res.json({ success: true, storyId, userId: rows[0].user_id });
  } catch (err) {
    log.error('❌ [ADMIN] Failed to publish draft:', err.message);
    res.status(500).json({ error: 'Failed to publish draft' });
  }
});

// Unpublish — pull a story back out of the owner's library.
router.post('/stories/:storyId/unpublish', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { storyId } = req.params;
    const { rows } = await getPool().query(
      `UPDATE stories SET admin_draft = true WHERE id = $1 RETURNING id, user_id`,
      [storyId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    log.info(`📕 [ADMIN] ${req.user.username} unpublished story ${storyId} (user ${rows[0].user_id})`);
    await logActivity(req.user.id, req.user.username, 'ADMIN_UNPUBLISH_STORY', {
      storyId, targetUserId: rows[0].user_id,
    }, req.user);
    res.json({ success: true, storyId, userId: rows[0].user_id });
  } catch (err) {
    log.error('❌ [ADMIN] Failed to unpublish story:', err.message);
    res.status(500).json({ error: 'Failed to unpublish story' });
  }
});
