/**
 * Admin Analytics Routes
 *
 * Statistics, monitoring, and analytics endpoints.
 * Extracted from admin.js for better code organization.
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool, isDatabaseMode } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Admin stats are only available in database mode' });
    }

    console.log('📊 [ADMIN] Fetching dashboard statistics...');

    const pool = getPool();

    // Run all stats queries in parallel for better performance
    const [
      userCountResult,
      storyCountResult,
      fileCountResult,
      characterCountResult,
      orphanedFilesResult,
      imageFilesResult,
      embeddedImagesResult
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM stories'),
      pool.query('SELECT COUNT(*) as count FROM files'),
      // Count individual characters using database aggregation
      pool.query(`
        SELECT COALESCE(SUM(
          CASE
            WHEN data::jsonb -> 'characters' IS NOT NULL
            THEN jsonb_array_length(data::jsonb -> 'characters')
            ELSE 0
          END
        ), 0) as total_characters
        FROM characters
      `),
      // Get orphaned files
      pool.query(`
        SELECT f.id, f.story_id, f.file_type, f.file_size, f.filename, f.created_at
        FROM files f
        WHERE f.story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = f.story_id
          )
        ORDER BY f.created_at DESC
        LIMIT 100
      `),
      // Count images in files table
      pool.query(
        "SELECT COUNT(*) as count FROM files WHERE file_type = 'image' OR mime_type LIKE 'image/%'"
      ),
      // Count images embedded in story data using database aggregation
      pool.query(`
        SELECT COALESCE(SUM(
          CASE
            WHEN data::jsonb -> 'sceneImages' IS NOT NULL
            THEN jsonb_array_length(data::jsonb -> 'sceneImages')
            ELSE 0
          END
        ), 0) as embedded_images
        FROM stories
      `)
    ]);

    const totalCharacters = parseInt(characterCountResult.rows[0].total_characters) || 0;
    const embeddedImagesCount = parseInt(embeddedImagesResult.rows[0].embedded_images) || 0;

    // Get database size
    let databaseSize = 'N/A';
    try {
      const dbSizeResult = await pool.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as total_size
      `);
      databaseSize = dbSizeResult.rows[0].total_size;
    } catch (dbSizeErr) {
      console.warn('⚠️ Could not get database size:', dbSizeErr.message);
    }

    const stats = {
      totalUsers: parseInt(userCountResult.rows[0].count),
      totalStories: parseInt(storyCountResult.rows[0].count),
      totalCharacters: totalCharacters,
      totalImages: embeddedImagesCount + parseInt(imageFilesResult.rows[0].count),
      orphanedFiles: orphanedFilesResult.rows.length,
      databaseSize: databaseSize
    };

    log.info(`✅ [ADMIN] Stats: ${stats.totalUsers} users, ${stats.totalStories} stories, ${stats.totalCharacters} characters, ${stats.totalImages} total images, ${stats.orphanedFiles} orphaned files, DB size: ${stats.databaseSize}`);

    res.json(stats);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/database-size
router.get('/database-size', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Database size check is only available in database mode' });
    }

    const pool = getPool();

    // Use a single query to get table sizes AND row counts (using pg_stat_user_tables for efficiency)
    // This avoids N+1 queries by getting all stats in one query
    const tableSizes = await pool.query(`
      SELECT
        t.schemaname,
        t.tablename,
        pg_size_pretty(pg_total_relation_size(t.schemaname||'.'||t.tablename)) AS size,
        pg_total_relation_size(t.schemaname||'.'||t.tablename) AS size_bytes,
        COALESCE(s.n_live_tup, 0) AS row_count
      FROM pg_tables t
      LEFT JOIN pg_stat_user_tables s ON t.tablename = s.relname AND t.schemaname = s.schemaname
      WHERE t.schemaname = 'public'
      ORDER BY pg_total_relation_size(t.schemaname||'.'||t.tablename) DESC
    `);

    const dbSize = await pool.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as total_size,
             pg_database_size(current_database()) as total_size_bytes
    `);

    res.json({
      totalSize: dbSize.rows[0].total_size,
      totalSizeBytes: parseInt(dbSize.rows[0].total_size_bytes),
      tables: tableSizes.rows.map(row => ({
        tablename: row.tablename,
        size: row.size,
        size_bytes: parseInt(row.size_bytes),
        row_count: parseInt(row.row_count) || 0
      }))
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching database size:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/user-storage
router.get('/user-storage', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'User storage check is only available in database mode' });
    }

    const pool = getPool();
    const userStorage = await pool.query(`
      WITH user_data AS (
        SELECT
          u.id,
          u.username,
          u.email,
          u.role,
          u.created_at,
          COALESCE(SUM(LENGTH(s.data::text)), 0) as stories_size,
          COUNT(DISTINCT s.id) as story_count,
          COALESCE(SUM(LENGTH(f.file_data)), 0) as files_size,
          COUNT(DISTINCT f.id) as file_count,
          COUNT(DISTINCT c.id) as character_count
        FROM users u
        LEFT JOIN stories s ON u.id = s.user_id
        LEFT JOIN files f ON u.id = f.user_id
        LEFT JOIN characters c ON u.id = c.user_id
        GROUP BY u.id, u.username, u.email, u.role, u.created_at
      )
      SELECT
        id,
        username,
        email,
        role,
        created_at,
        stories_size,
        story_count,
        files_size,
        file_count,
        character_count,
        (stories_size + files_size) as total_size
      FROM user_data
      ORDER BY total_size DESC
    `);

    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const users = userStorage.rows.map(row => ({
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      storyCount: parseInt(row.story_count),
      fileCount: parseInt(row.file_count),
      characterCount: parseInt(row.character_count),
      storiesSize: formatSize(parseInt(row.stories_size)),
      storiesSizeBytes: parseInt(row.stories_size),
      filesSize: formatSize(parseInt(row.files_size)),
      filesSizeBytes: parseInt(row.files_size),
      totalSize: formatSize(parseInt(row.total_size)),
      totalSizeBytes: parseInt(row.total_size)
    }));

    res.json({ users });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching user storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/config
router.get('/config', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Return minimal config info - detailed config like TEXT_MODELS would need to be passed from server.js
    res.json({
      storageMode: process.env.STORAGE_MODE,
      apiKeys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY
      }
    });
  } catch (err) {
    console.error('Error fetching config:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// GET /api/admin/token-usage - Token usage statistics
// Query params: days (default 30), limit (default 1000)
router.get('/token-usage', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30; // Default to last 30 days
    const limit = Math.min(parseInt(req.query.limit) || 1000, 5000); // Default 1000, max 5000
    console.log(`📊 [ADMIN] Fetching token usage statistics (last ${days} days, limit ${limit})...`);

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Token usage requires database mode' });
    }

    const pool = getPool();
    const storiesResult = await pool.query(`
      SELECT
        s.id,
        s.user_id,
        s.data,
        s.created_at,
        u.email as user_email,
        u.username as user_name
      FROM stories s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= NOW() - ($2 * INTERVAL '1 day')
      ORDER BY s.created_at DESC
      LIMIT $1
    `, [limit, days]);

    // Aggregate token usage (including thinking tokens for Gemini 2.5)
    const totals = {
      anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 }
    };

    const byUser = {};
    const byStoryType = {};
    const byMonth = {};
    const storiesWithUsage = [];
    let storiesWithTokenData = 0;

    for (const row of storiesResult.rows) {
      try {
        const storyData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        const tokenUsage = storyData.tokenUsage;

        if (tokenUsage) {
          storiesWithTokenData++;

          // Add to totals
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              totals[provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              totals[provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              totals[provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
              totals[provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          const storyPages = storyData.pages || 0;
          const bookPages = storyPages + 3;

          // Aggregate by user
          const userKey = row.user_email || row.user_id || 'unknown';
          if (!byUser[userKey]) {
            byUser[userKey] = {
              userId: row.user_id,
              email: row.user_email,
              name: row.user_name,
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 }
            };
          }
          byUser[userKey].storyCount++;
          byUser[userKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byUser[userKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byUser[userKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byUser[userKey][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
              byUser[userKey][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Aggregate by story type
          const storyType = storyData.storyType || 'unknown';
          if (!byStoryType[storyType]) {
            byStoryType[storyType] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 }
            };
          }
          byStoryType[storyType].storyCount++;
          byStoryType[storyType].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byStoryType[storyType][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byStoryType[storyType][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byStoryType[storyType][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
              byStoryType[storyType][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Aggregate by month
          const monthKey = row.created_at ? new Date(row.created_at).toISOString().substring(0, 7) : 'unknown';
          if (!byMonth[monthKey]) {
            byMonth[monthKey] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 }
            };
          }
          byMonth[monthKey].storyCount++;
          byMonth[monthKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byMonth[monthKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byMonth[monthKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byMonth[monthKey][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
              byMonth[monthKey][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Add to detailed list (last 50)
          if (storiesWithUsage.length < 50) {
            storiesWithUsage.push({
              id: row.id,
              title: storyData.title,
              storyType: storyData.storyType,
              storyPages: storyPages,
              bookPages: bookPages,
              userId: row.user_id,
              userEmail: row.user_email,
              createdAt: row.created_at,
              tokenUsage
            });
          }
        }
      } catch (parseErr) {
        console.warn('⚠️ [ADMIN] Error parsing story data:', parseErr.message);
      }
    }

    // Calculate costs (approximate) - thinking tokens billed at output rate for Gemini
    const costs = {
      anthropic: {
        input: (totals.anthropic.input_tokens / 1000000) * 3,
        output: (totals.anthropic.output_tokens / 1000000) * 15,
        thinking: 0, // Anthropic doesn't have separate thinking tokens
        total: 0
      },
      gemini_text: {
        input: (totals.gemini_text.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_text.output_tokens / 1000000) * 0.30,
        thinking: (totals.gemini_text.thinking_tokens / 1000000) * 0.30,
        total: 0
      },
      gemini_image: {
        input: (totals.gemini_image.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_image.output_tokens / 1000000) * 0.30,
        thinking: (totals.gemini_image.thinking_tokens / 1000000) * 0.30,
        total: 0
      },
      gemini_quality: {
        input: (totals.gemini_quality.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_quality.output_tokens / 1000000) * 0.30,
        thinking: (totals.gemini_quality.thinking_tokens / 1000000) * 0.30,
        total: 0
      }
    };
    costs.anthropic.total = costs.anthropic.input + costs.anthropic.output;
    costs.gemini_text.total = costs.gemini_text.input + costs.gemini_text.output + costs.gemini_text.thinking;
    costs.gemini_image.total = costs.gemini_image.input + costs.gemini_image.output + costs.gemini_image.thinking;
    costs.gemini_quality.total = costs.gemini_quality.input + costs.gemini_quality.output + costs.gemini_quality.thinking;
    costs.grandTotal = costs.anthropic.total + costs.gemini_text.total + costs.gemini_image.total + costs.gemini_quality.total;

    const totalBookPages = Object.values(byUser).reduce((sum, u) => sum + u.totalBookPages, 0);

    const response = {
      summary: {
        totalStories: storiesResult.rows.length,
        storiesWithTokenData,
        storiesWithoutTokenData: storiesResult.rows.length - storiesWithTokenData,
        totalBookPages
      },
      totals,
      costs,
      byUser: Object.values(byUser).sort((a, b) =>
        (b.anthropic.input_tokens + b.anthropic.output_tokens) -
        (a.anthropic.input_tokens + a.anthropic.output_tokens)
      ),
      byStoryType,
      byMonth,
      recentStories: storiesWithUsage
    };

    log.info(`✅ [ADMIN] Token usage: ${storiesWithTokenData}/${storiesResult.rows.length} stories have token data`);

    res.json(response);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching token usage:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
