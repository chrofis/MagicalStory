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
const { MODEL_PRICING } = require('../../config/models');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Stats cache to avoid expensive queries on every request
let statsCache = null;
let statsCacheTime = 0;
const STATS_CACHE_TTL = 60000; // 1 minute cache

// GET /api/admin/stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Admin stats are only available in database mode' });
    }

    // Return cached stats if still valid
    const now = Date.now();
    if (statsCache && (now - statsCacheTime) < STATS_CACHE_TTL) {
      console.log('📊 [ADMIN] Returning cached stats');
      return res.json(statsCache);
    }

    console.log('📊 [ADMIN] Fetching dashboard statistics...');
    const startTime = Date.now();

    const pool = getPool();

    // Run fast queries in parallel (avoid expensive JSON aggregation)
    const [
      userCountResult,
      storyCountResult,
      fileCountResult,
      orphanedFilesResult,
      imageFilesResult,
      dbSizeResult
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM users'),
      pool.query('SELECT COUNT(*) as count FROM stories'),
      pool.query('SELECT COUNT(*) as count FROM files'),
      // Get orphaned files count (fast query with EXISTS)
      pool.query(`
        SELECT COUNT(*) as count
        FROM files f
        WHERE f.story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = f.story_id
          )
      `),
      // Count images in files table
      pool.query(
        "SELECT COUNT(*) as count FROM files WHERE file_type = 'image' OR mime_type LIKE 'image/%'"
      ),
      // Get database size
      pool.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as total_size
      `).catch(() => ({ rows: [{ total_size: 'N/A' }] }))
    ]);

    // Estimate total images (10 per story average) instead of expensive JSON scan
    const storyCount = parseInt(storyCountResult.rows[0].count);
    const estimatedEmbeddedImages = storyCount * 10;

    // Estimate characters (5 per character record average)
    const characterCountResult = await pool.query('SELECT COUNT(*) as count FROM characters');
    const estimatedCharacters = parseInt(characterCountResult.rows[0].count) * 5;

    const stats = {
      totalUsers: parseInt(userCountResult.rows[0].count),
      totalStories: storyCount,
      totalCharacters: estimatedCharacters,
      totalImages: estimatedEmbeddedImages + parseInt(imageFilesResult.rows[0].count),
      orphanedFiles: parseInt(orphanedFilesResult.rows[0].count),
      databaseSize: dbSizeResult.rows[0].total_size
    };

    // Cache the stats
    statsCache = stats;
    statsCacheTime = now;

    const duration = Date.now() - startTime;
    log.info(`✅ [ADMIN] Stats in ${duration}ms: ${stats.totalUsers} users, ${stats.totalStories} stories, ~${stats.totalCharacters} characters, ~${stats.totalImages} images, ${stats.orphanedFiles} orphaned, DB: ${stats.databaseSize}`);

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
    // Only extract tokenUsage and metadata - NOT full story data (which includes images)
    // This prevents OOM crashes when loading 1000+ stories
    const storiesResult = await pool.query(`
      SELECT
        s.id,
        s.user_id,
        s.data::jsonb->'tokenUsage' as token_usage,
        s.data::jsonb->>'storyType' as story_type,
        s.data::jsonb->>'title' as title,
        s.created_at,
        u.email as user_email,
        u.username as user_name
      FROM stories s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.created_at >= NOW() - ($2 * INTERVAL '1 day')
      ORDER BY s.created_at DESC
      LIMIT $1
    `, [limit, days]);

    // Query avatar token usage from characters (stored per-character when avatars are generated)
    const avatarUsageResult = await pool.query(`
      SELECT
        c.user_id,
        u.email as user_email,
        u.username as user_name,
        jsonb_array_elements(c.data->'characters') as char_data
      FROM characters c
      LEFT JOIN users u ON c.user_id = u.id
    `);

    // Extract avatar token usage from all characters (per model)
    const avatarByModel = {};  // { 'gemini-2.5-flash-image': { input_tokens, output_tokens, calls }, ... }
    const avatarUsageByUser = {};  // { email: { byModel: {...} } }

    for (const row of avatarUsageResult.rows) {
      const charData = row.char_data;
      const userKey = row.user_email || row.user_id || 'unknown';

      // Handle new byModel structure
      if (charData?.avatarTokenUsage?.byModel) {
        for (const [modelId, usage] of Object.entries(charData.avatarTokenUsage.byModel)) {
          // Aggregate by model (global)
          if (!avatarByModel[modelId]) {
            avatarByModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
          }
          avatarByModel[modelId].input_tokens += usage.input_tokens || 0;
          avatarByModel[modelId].output_tokens += usage.output_tokens || 0;
          avatarByModel[modelId].calls += usage.calls || 0;

          // Aggregate by user and model
          if (!avatarUsageByUser[userKey]) {
            avatarUsageByUser[userKey] = { byModel: {} };
          }
          if (!avatarUsageByUser[userKey].byModel[modelId]) {
            avatarUsageByUser[userKey].byModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
          }
          avatarUsageByUser[userKey].byModel[modelId].input_tokens += usage.input_tokens || 0;
          avatarUsageByUser[userKey].byModel[modelId].output_tokens += usage.output_tokens || 0;
          avatarUsageByUser[userKey].byModel[modelId].calls += usage.calls || 0;
        }
      }
      // Handle legacy gemini_image structure (for backwards compatibility)
      else if (charData?.avatarTokenUsage?.gemini_image) {
        const usage = charData.avatarTokenUsage.gemini_image;
        const modelId = 'gemini-2.5-flash-image';  // Default legacy model

        if (!avatarByModel[modelId]) {
          avatarByModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
        }
        avatarByModel[modelId].input_tokens += usage.input_tokens || 0;
        avatarByModel[modelId].output_tokens += usage.output_tokens || 0;
        avatarByModel[modelId].calls += usage.calls || 0;

        if (!avatarUsageByUser[userKey]) {
          avatarUsageByUser[userKey] = { byModel: {} };
        }
        if (!avatarUsageByUser[userKey].byModel[modelId]) {
          avatarUsageByUser[userKey].byModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
        }
        avatarUsageByUser[userKey].byModel[modelId].input_tokens += usage.input_tokens || 0;
        avatarUsageByUser[userKey].byModel[modelId].output_tokens += usage.output_tokens || 0;
        avatarUsageByUser[userKey].byModel[modelId].calls += usage.calls || 0;
      }
    }

    // Log avatar usage summary
    const avatarModels = Object.keys(avatarByModel);
    if (avatarModels.length > 0) {
      console.log(`📊 [ADMIN] Avatar generation by model:`);
      for (const [modelId, usage] of Object.entries(avatarByModel)) {
        console.log(`   ${modelId}: ${usage.input_tokens} in / ${usage.output_tokens} out (${usage.calls} calls)`);
      }
    }

    // Aggregate token usage (including thinking tokens for Gemini 2.5)
    const totals = {
      anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
      runware: { direct_cost: 0, calls: 0 },
      // Per-model tracking for avatars
      avatarByModel: avatarByModel,
      // Per-model tracking for story images (page_images, cover_images)
      imageByModel: {}
    };

    const byUser = {};
    const byStoryType = {};
    const byMonth = {};
    const byDay = {};
    const storiesWithUsage = [];
    let storiesWithTokenData = 0;

    for (const row of storiesResult.rows) {
      try {
        // token_usage is already extracted by PostgreSQL JSONB operator
        const tokenUsage = typeof row.token_usage === 'string' ? JSON.parse(row.token_usage) : row.token_usage;

        if (tokenUsage) {
          storiesWithTokenData++;

          // Add to totals
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              if (provider === 'runware') {
                totals.runware.direct_cost += tokenUsage[provider].direct_cost || 0;
                totals.runware.calls += tokenUsage[provider].calls || 0;
              } else {
                totals[provider].input_tokens += tokenUsage[provider].input_tokens || 0;
                totals[provider].output_tokens += tokenUsage[provider].output_tokens || 0;
                totals[provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
                totals[provider].calls += tokenUsage[provider].calls || 0;
              }
            }
          }

          // Extract per-model image costs from byFunction data
          if (tokenUsage.byFunction) {
            const imageTypes = ['page_images', 'cover_images'];
            for (const imageType of imageTypes) {
              const funcData = tokenUsage.byFunction[imageType];
              if (funcData && funcData.calls > 0) {
                // Get the model used (models is now an array after serialization fix)
                const models = funcData.models || [];
                const modelId = models[0] || (imageType === 'cover_images' ? 'gemini-3-pro-image-preview' : 'gemini-2.5-flash-image');

                if (!totals.imageByModel[modelId]) {
                  totals.imageByModel[modelId] = { calls: 0, input_tokens: 0, output_tokens: 0 };
                }
                totals.imageByModel[modelId].calls += funcData.calls;
                totals.imageByModel[modelId].input_tokens += funcData.input_tokens || 0;
                totals.imageByModel[modelId].output_tokens += funcData.output_tokens || 0;
              }
            }
          }

          // We no longer have pages info without loading full story data
          // Use a reasonable estimate or skip book pages calculation
          const bookPages = 20; // Default estimate

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
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              avatarByModel: {},  // Per-model avatar usage
              runware: { direct_cost: 0, calls: 0 }
            };
          }
          byUser[userKey].storyCount++;
          byUser[userKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              if (provider === 'runware') {
                byUser[userKey].runware.direct_cost += tokenUsage[provider].direct_cost || 0;
                byUser[userKey].runware.calls += tokenUsage[provider].calls || 0;
              } else {
                byUser[userKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
                byUser[userKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
                byUser[userKey][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
                byUser[userKey][provider].calls += tokenUsage[provider].calls || 0;
              }
            }
          }

          // Aggregate by story type
          const storyType = row.story_type || 'unknown';
          if (!byStoryType[storyType]) {
            byStoryType[storyType] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              runware: { direct_cost: 0, calls: 0 }
            };
          }
          byStoryType[storyType].storyCount++;
          byStoryType[storyType].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              if (provider === 'runware') {
                byStoryType[storyType].runware.direct_cost += tokenUsage[provider].direct_cost || 0;
                byStoryType[storyType].runware.calls += tokenUsage[provider].calls || 0;
              } else {
                byStoryType[storyType][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
                byStoryType[storyType][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
                byStoryType[storyType][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
                byStoryType[storyType][provider].calls += tokenUsage[provider].calls || 0;
              }
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
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              runware: { direct_cost: 0, calls: 0 }
            };
          }
          byMonth[monthKey].storyCount++;
          byMonth[monthKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              if (provider === 'runware') {
                byMonth[monthKey].runware.direct_cost += tokenUsage[provider].direct_cost || 0;
                byMonth[monthKey].runware.calls += tokenUsage[provider].calls || 0;
              } else {
                byMonth[monthKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
                byMonth[monthKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
                byMonth[monthKey][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
                byMonth[monthKey][provider].calls += tokenUsage[provider].calls || 0;
              }
            }
          }

          // Aggregate by day
          const dayKey = row.created_at ? new Date(row.created_at).toISOString().substring(0, 10) : 'unknown';
          if (!byDay[dayKey]) {
            byDay[dayKey] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
              runware: { direct_cost: 0, calls: 0 }
            };
          }
          byDay[dayKey].storyCount++;
          byDay[dayKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              if (provider === 'runware') {
                byDay[dayKey].runware.direct_cost += tokenUsage[provider].direct_cost || 0;
                byDay[dayKey].runware.calls += tokenUsage[provider].calls || 0;
              } else {
                byDay[dayKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
                byDay[dayKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
                byDay[dayKey][provider].thinking_tokens += tokenUsage[provider].thinking_tokens || 0;
                byDay[dayKey][provider].calls += tokenUsage[provider].calls || 0;
              }
            }
          }

          // Add to detailed list (last 50)
          if (storiesWithUsage.length < 50) {
            storiesWithUsage.push({
              id: row.id,
              title: row.title,
              storyType: row.story_type,
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

    // Merge avatar usage into byUser (per model)
    for (const [userKey, avatarUsage] of Object.entries(avatarUsageByUser)) {
      if (!byUser[userKey]) {
        // User has avatar usage but no stories - create entry
        byUser[userKey] = {
          userId: null,
          email: userKey,
          name: null,
          storyCount: 0,
          totalBookPages: 0,
          anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
          gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
          gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
          gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
          avatarByModel: {},
          runware: { direct_cost: 0, calls: 0 }
        };
      }
      // Merge per-model avatar usage
      for (const [modelId, usage] of Object.entries(avatarUsage.byModel || {})) {
        if (!byUser[userKey].avatarByModel[modelId]) {
          byUser[userKey].avatarByModel[modelId] = { input_tokens: 0, output_tokens: 0, calls: 0 };
        }
        byUser[userKey].avatarByModel[modelId].input_tokens += usage.input_tokens;
        byUser[userKey].avatarByModel[modelId].output_tokens += usage.output_tokens;
        byUser[userKey].avatarByModel[modelId].calls += usage.calls;
      }
    }

    // Calculate costs - pricing per 1M tokens (updated Jan 2026)
    // Source: https://ai.google.dev/gemini-api/docs/pricing
    // Claude: $3 input / $15 output per 1M tokens
    // Gemini 2.5 Flash (text): $0.30 input / $2.50 output per 1M tokens
    // Gemini image gen: ~$0.065 per image weighted avg (not token-based)
    // Gemini 2.0 Flash (quality): $0.10 input / $0.40 output per 1M tokens
    const costs = {
      anthropic: {
        input: (totals.anthropic.input_tokens / 1000000) * 3.00,
        output: (totals.anthropic.output_tokens / 1000000) * 15.00,
        thinking: (totals.anthropic.thinking_tokens / 1000000) * 15.00,
        total: 0
      },
      gemini_text: {
        // Gemini 2.5 Flash for text
        input: (totals.gemini_text.input_tokens / 1000000) * 0.30,
        output: (totals.gemini_text.output_tokens / 1000000) * 2.50,
        thinking: (totals.gemini_text.thinking_tokens / 1000000) * 2.50,
        total: 0
      },
      gemini_image: {
        // Image generation - cost is per-image, calculated per model from byFunction data
        input: (totals.gemini_image.input_tokens / 1000000) * 0.30,
        output: (totals.gemini_image.output_tokens / 1000000) * 2.50,
        thinking: (totals.gemini_image.thinking_tokens / 1000000) * 2.50,
        // Calculate per-model cost using MODEL_PRICING
        imageEstimate: Object.entries(totals.imageByModel || {}).reduce((sum, [modelId, usage]) => {
          const pricing = MODEL_PRICING[modelId];
          const perImage = pricing?.perImage || 0.04; // Default to flash pricing
          return sum + (usage.calls * perImage);
        }, 0) || (totals.gemini_image.calls * 0.065), // Fallback if no byFunction data
        byModel: totals.imageByModel,
        total: 0
      },
      gemini_quality: {
        // Gemini 2.0 Flash for quality eval
        input: (totals.gemini_quality.input_tokens / 1000000) * 0.10,
        output: (totals.gemini_quality.output_tokens / 1000000) * 0.40,
        thinking: (totals.gemini_quality.thinking_tokens / 1000000) * 0.40,
        total: 0
      },
      runware: {
        total: totals.runware.direct_cost // Runware charges directly, no token calculation
      },
      // Per-model avatar costs
      avatarByModel: {}
    };

    // Calculate per-model avatar costs using MODEL_PRICING
    let totalAvatarCost = 0;
    for (const [modelId, usage] of Object.entries(totals.avatarByModel || {})) {
      const pricing = MODEL_PRICING[modelId] || { input: 0.30, output: 2.50 };  // Default to flash pricing

      // For image generation models, cost is typically per-image
      // Check if model has perImage pricing (image generation models)
      const isImageModel = modelId.includes('image') || pricing.perImage;
      let modelCost;

      if (isImageModel && pricing.perImage) {
        // Per-image pricing
        modelCost = usage.calls * pricing.perImage;
      } else {
        // Token-based pricing (fallback)
        const inputCost = (usage.input_tokens / 1000000) * (pricing.input || 0.30);
        const outputCost = (usage.output_tokens / 1000000) * (pricing.output || 2.50);
        modelCost = inputCost + outputCost;

        // If very low, use per-image estimate
        if (modelCost < 0.001 && usage.calls > 0) {
          modelCost = usage.calls * (MODEL_PRICING['gemini-2.5-flash-image']?.perImage || 0.04);  // Fallback per-image cost
        }
      }

      costs.avatarByModel[modelId] = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        calls: usage.calls,
        cost: modelCost
      };
      totalAvatarCost += modelCost;
    }

    costs.anthropic.total = costs.anthropic.input + costs.anthropic.output + costs.anthropic.thinking;
    costs.gemini_text.total = costs.gemini_text.input + costs.gemini_text.output + costs.gemini_text.thinking;
    // For image generation, use the per-image estimate as primary cost
    costs.gemini_image.total = costs.gemini_image.imageEstimate || (costs.gemini_image.input + costs.gemini_image.output + costs.gemini_image.thinking);
    costs.gemini_quality.total = costs.gemini_quality.input + costs.gemini_quality.output + costs.gemini_quality.thinking;
    costs.totalAvatarCost = totalAvatarCost;
    costs.grandTotal = costs.anthropic.total + costs.gemini_text.total + costs.gemini_image.total + costs.gemini_quality.total + totalAvatarCost + costs.runware.total;

    const totalBookPages = Object.values(byUser).reduce((sum, u) => sum + u.totalBookPages, 0);

    // Helper to calculate cost for a day/month entry (using same pricing as totals)
    const calculateEntryCost = (entry) => {
      // Claude: $3 input / $15 output per 1M tokens
      const anthropicCost = ((entry.anthropic?.input_tokens || 0) / 1000000) * 3.00 +
                           ((entry.anthropic?.output_tokens || 0) / 1000000) * 15.00 +
                           ((entry.anthropic?.thinking_tokens || 0) / 1000000) * 15.00;
      // Gemini 2.5 Flash (text): $0.30 input / $2.50 output per 1M tokens
      const geminiTextCost = ((entry.gemini_text?.input_tokens || 0) / 1000000) * 0.30 +
                            ((entry.gemini_text?.output_tokens || 0) / 1000000) * 2.50 +
                            ((entry.gemini_text?.thinking_tokens || 0) / 1000000) * 2.50;
      // Gemini image gen: ~$0.065 per image weighted avg (estimate based on call count)
      const geminiImageCost = (entry.gemini_image?.calls || 0) * 0.065;
      // Gemini 2.0 Flash (quality): $0.10 input / $0.40 output per 1M tokens
      const geminiQualityCost = ((entry.gemini_quality?.input_tokens || 0) / 1000000) * 0.10 +
                               ((entry.gemini_quality?.output_tokens || 0) / 1000000) * 0.40 +
                               ((entry.gemini_quality?.thinking_tokens || 0) / 1000000) * 0.40;
      const runwareCost = entry.runware?.direct_cost || 0;
      return anthropicCost + geminiTextCost + geminiImageCost + geminiQualityCost + runwareCost;
    };

    // Add cost to each day entry
    const byDayWithCosts = Object.entries(byDay)
      .map(([date, data]) => ({
        date,
        ...data,
        totalCost: calculateEntryCost(data)
      }))
      .sort((a, b) => b.date.localeCompare(a.date)); // Most recent first

    // Add cost to each month entry
    const byMonthWithCosts = Object.entries(byMonth)
      .map(([month, data]) => ({
        month,
        ...data,
        totalCost: calculateEntryCost(data)
      }))
      .sort((a, b) => b.month.localeCompare(a.month)); // Most recent first

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
      byDay: byDayWithCosts,
      byMonth: byMonthWithCosts,
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
