/**
 * Admin User Management Routes
 *
 * User listing, credits management, email verification, photo consent
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool, isDatabaseMode, logActivity } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// GET /api/admin/users - List all users with optional pagination
// Query params: page (default: 1), limit (default: 50, max: 200), search (optional)
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    // Parse pagination params
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || '';

    const pool = getPool();

    // Build WHERE clause for search
    let whereClause = '';
    const queryParams = [];
    if (search) {
      whereClause = `WHERE u.username ILIKE $1 OR u.email ILIKE $1`;
      queryParams.push(`%${search}%`);
    }

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
    const countResult = await dbQuery(countQuery, queryParams);
    const totalUsers = parseInt(countResult[0].total);
    const totalPages = Math.ceil(totalUsers / limit);

    // Get paginated users
    const selectQuery = `
      SELECT
        u.id, u.username, u.email, u.role, u.story_quota, u.stories_generated, u.credits, u.created_at, u.last_login, u.email_verified, u.photo_consent_at,
        COALESCE(order_stats.total_orders, 0) as total_orders,
        COALESCE(order_stats.failed_orders, 0) as failed_orders
      FROM users u
      LEFT JOIN (
        SELECT
          user_id,
          COUNT(*) as total_orders,
          COUNT(*) FILTER (WHERE payment_status = 'paid' AND gelato_order_id IS NULL) as failed_orders
        FROM orders
        GROUP BY user_id
      ) order_stats ON u.id::text = order_stats.user_id
      ${whereClause}
      ORDER BY u.created_at ASC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;
    const rows = await dbQuery(selectQuery, [...queryParams, limit, offset]);

    const users = rows.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      storyQuota: user.story_quota,
      storiesGenerated: user.stories_generated,
      credits: user.credits != null ? user.credits : 500,
      createdAt: user.created_at,
      lastLogin: user.last_login,
      emailVerified: user.email_verified !== false,
      photoConsentAt: user.photo_consent_at || null,
      totalOrders: parseInt(user.total_orders) || 0,
      failedOrders: parseInt(user.failed_orders) || 0
    }));

    res.json({
      users,
      pagination: {
        page,
        limit,
        totalUsers,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/admin/users/:userId/quota - Update user credits
router.post('/:userId/quota', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { credits } = req.body;

    if (credits === undefined || (credits !== -1 && credits < 0)) {
      return res.status(400).json({ error: 'Invalid credits value. Use -1 for unlimited or a positive number.' });
    }

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const selectQuery = 'SELECT * FROM users WHERE id = $1';
    const rows = await dbQuery(selectQuery, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const previousCredits = rows[0].credits || 0;
    const creditDiff = credits - previousCredits;

    const updateQuery = 'UPDATE users SET credits = $1 WHERE id = $2';
    await dbQuery(updateQuery, [credits, userId]);

    // Create transaction record
    if (creditDiff !== 0) {
      const transactionType = creditDiff > 0 ? 'admin_add' : 'admin_deduct';
      const description = creditDiff > 0
        ? `Admin added ${creditDiff} credits`
        : `Admin deducted ${Math.abs(creditDiff)} credits`;

      await dbQuery(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, creditDiff, credits, transactionType, req.user.id, description]
      );
    }

    await logActivity(req.user.id, req.user.username, 'USER_CREDITS_UPDATED', {
      targetUserId: userId,
      targetUsername: rows[0].username,
      newCredits: credits
    });

    res.json({
      message: 'User credits updated successfully',
      user: {
        id: rows[0].id,
        username: rows[0].username,
        credits: credits
      }
    });
  } catch (err) {
    console.error('Error updating user credits:', err);
    res.status(500).json({ error: 'Failed to update user credits' });
  }
});

// POST /api/admin/users/:userId/email-verified - Toggle email verification
router.post('/:userId/email-verified', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { emailVerified } = req.body;

    if (typeof emailVerified !== 'boolean') {
      return res.status(400).json({ error: 'emailVerified must be a boolean' });
    }

    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'This feature requires database mode' });
    }

    const selectQuery = 'SELECT id, username, email_verified FROM users WHERE id = $1';
    const rows = await dbQuery(selectQuery, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    const previousStatus = user.email_verified;

    await dbQuery('UPDATE users SET email_verified = $1 WHERE id = $2', [emailVerified, userId]);

    log.debug(`[ADMIN] Email verification for user ${user.username} changed: ${previousStatus} -> ${emailVerified}`);

    res.json({
      message: 'Email verification status updated',
      user: {
        id: user.id,
        username: user.username,
        emailVerified: emailVerified,
        previousStatus: previousStatus
      }
    });
  } catch (err) {
    console.error('Error updating email verification status:', err);
    res.status(500).json({ error: 'Failed to update email verification status' });
  }
});

// POST /api/admin/users/:userId/role - Update user role
router.post('/:userId/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be "user" or "admin"' });
    }

    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'This feature requires database mode' });
    }

    const rows = await dbQuery('SELECT id, username, role FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    const previousRole = user.role;

    await dbQuery('UPDATE users SET role = $1 WHERE id = $2', [role, userId]);

    log.info(`[ADMIN] Role for user ${user.username} changed: ${previousRole} -> ${role} (by ${req.user.username})`);

    res.json({
      message: 'User role updated',
      user: { id: user.id, username: user.username, role, previousRole }
    });
  } catch (err) {
    console.error('Error updating user role:', err);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// POST /api/admin/users/:userId/photo-consent - Toggle photo consent status
router.post('/:userId/photo-consent', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { hasConsent } = req.body;

    if (typeof hasConsent !== 'boolean') {
      return res.status(400).json({ error: 'hasConsent must be a boolean' });
    }

    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'This feature requires database mode' });
    }

    const selectQuery = 'SELECT id, username, photo_consent_at FROM users WHERE id = $1';
    const rows = await dbQuery(selectQuery, [userId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = rows[0];
    const previousStatus = !!user.photo_consent_at;

    if (hasConsent) {
      await dbQuery('UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
    } else {
      await dbQuery('UPDATE users SET photo_consent_at = NULL WHERE id = $1', [userId]);
    }

    const updatedRows = await dbQuery('SELECT photo_consent_at FROM users WHERE id = $1', [userId]);
    const photoConsentAt = updatedRows[0]?.photo_consent_at || null;

    log.debug(`[ADMIN] Photo consent for user ${user.username} changed: ${previousStatus} -> ${hasConsent}`);

    res.json({
      message: 'Photo consent status updated',
      user: {
        id: user.id,
        username: user.username,
        photoConsentAt: photoConsentAt,
        previousStatus: previousStatus
      }
    });
  } catch (err) {
    console.error('Error updating photo consent status:', err);
    res.status(500).json({ error: 'Failed to update photo consent status' });
  }
});

// GET /api/admin/users/:userId/credits - Get credit history
router.get('/:userId/credits', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const limit = parseInt(req.query.limit) || 50;

    log.info(`[ADMIN] GET /api/admin/users/${targetUserId}/credits - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database mode required for credit history' });
    }

    const pool = getPool();
    const userResult = await pool.query(
      'SELECT username, email, credits FROM users WHERE id = $1',
      [targetUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    const transactionsResult = await pool.query(
      `SELECT id, amount, balance_after, transaction_type, reference_id, description, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [targetUserId, limit]
    );

    res.json({
      user: {
        id: targetUserId,
        username: user.username,
        email: user.email,
        currentCredits: user.credits
      },
      transactions: transactionsResult.rows.map(t => ({
        id: t.id,
        amount: t.amount,
        balanceAfter: t.balance_after,
        type: t.transaction_type,
        referenceId: t.reference_id,
        description: t.description,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    console.error('Error fetching credit history:', err);
    res.status(500).json({ error: 'Failed to fetch credit history' });
  }
});

// GET /api/admin/users/:userId/details - Get detailed user info
router.get('/:userId/details', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    log.info(`[ADMIN] GET /api/admin/users/${targetUserId}/details - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'User details requires database mode' });
    }

    // Get user info first
    const userResult = await dbQuery(
      'SELECT id, username, email, role, credits, story_quota, stories_generated, created_at, last_login FROM users WHERE id = $1',
      [targetUserId]
    );
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult[0];

    // Run remaining queries in parallel
    // Use metadata for stories to avoid loading huge base64 images
    const [storiesResult, characterCountResult, ordersResult, creditsResult] = await Promise.all([
      dbQuery(
        `SELECT id, metadata, created_at FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [targetUserId]
      ),
      dbQuery(`
        SELECT COALESCE(SUM(
          CASE
            WHEN data::jsonb -> 'characters' IS NOT NULL
            THEN jsonb_array_length(data::jsonb -> 'characters')
            ELSE 0
          END
        ), 0) as total_characters
        FROM characters
        WHERE user_id = $1
      `, [targetUserId]),
      dbQuery(
        `SELECT id, story_id, amount_total, currency, payment_status, gelato_order_id, created_at
         FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [targetUserId]
      ),
      dbQuery(
        `SELECT id, amount, balance_after, transaction_type, description, created_at
         FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [targetUserId]
      )
    ]);

    const totalCharacters = parseInt(characterCountResult[0]?.total_characters) || 0;

    let totalImages = 0;
    const totalTokens = {
      anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
    };

    const stories = storiesResult.map(s => {
      try {
        // Use metadata (lightweight) instead of full data (contains base64 images)
        const meta = s.metadata ?
          (typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata) :
          null;

        if (!meta) {
          return {
            id: s.id,
            title: 'Untitled',
            createdAt: s.created_at,
            pageCount: 0,
            imageCount: 0
          };
        }

        const sceneCount = meta.sceneCount || 0;
        const isPictureBook = meta.languageLevel === '1st-grade';
        const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
        const pageCount = sceneCount > 0 ? storyPages + 3 : 0;
        // Estimate image count: scenes + up to 3 cover images
        const imageCount = sceneCount + (meta.hasThumbnail ? 3 : 0);
        totalImages += imageCount;

        // Token usage from metadata if available
        if (meta.tokenUsage) {
          const tu = meta.tokenUsage;
          for (const provider of ['anthropic', 'gemini_text', 'gemini_image', 'gemini_quality']) {
            if (tu[provider]) {
              totalTokens[provider].input_tokens += tu[provider].input_tokens || 0;
              totalTokens[provider].output_tokens += tu[provider].output_tokens || 0;
              totalTokens[provider].calls += tu[provider].calls || 0;
            }
          }
        }

        return {
          id: meta.id || s.id,
          title: meta.title || 'Untitled',
          createdAt: s.created_at,
          pageCount,
          imageCount
        };
      } catch {
        return {
          id: s.id,
          title: 'Untitled',
          createdAt: s.created_at,
          pageCount: 0,
          imageCount: 0
        };
      }
    });

    const purchases = ordersResult.map(o => ({
      id: o.id,
      storyId: o.story_id,
      amount: o.amount_total,
      currency: o.currency,
      status: o.payment_status,
      gelatoOrderId: o.gelato_order_id,
      createdAt: o.created_at
    }));

    const creditHistory = creditsResult.map(t => ({
      id: t.id,
      amount: t.amount,
      balanceAfter: t.balance_after,
      type: t.transaction_type,
      description: t.description,
      createdAt: t.created_at
    }));

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: user.credits,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        createdAt: user.created_at,
        lastLogin: user.last_login
      },
      stats: {
        totalStories: stories.length,
        totalCharacters,
        totalImages,
        totalPurchases: purchases.filter(p => p.status === 'paid').length,
        totalSpent: purchases.filter(p => p.status === 'paid').reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0),
        tokenUsage: {
          ...totalTokens,
          totalInputTokens: Object.values(totalTokens).reduce((sum, p) => sum + p.input_tokens, 0),
          totalOutputTokens: Object.values(totalTokens).reduce((sum, p) => sum + p.output_tokens, 0),
          totalCalls: Object.values(totalTokens).reduce((sum, p) => sum + p.calls, 0)
        }
      },
      stories,
      purchases,
      creditHistory
    });
  } catch (err) {
    console.error('Error fetching user details:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// GET /api/admin/users/:userId/stories - Get user's stories
router.get('/:userId/stories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`[ADMIN] GET /api/admin/users/${targetUserId}/stories - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const userResult = await dbQuery('SELECT username FROM users WHERE id = $1', [targetUserId]);
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const targetUsername = userResult[0].username;

    // Use metadata column for fast queries, fallback to data if metadata is null
    const selectQuery = 'SELECT metadata, CASE WHEN metadata IS NULL THEN data ELSE NULL END as data FROM stories WHERE user_id = $1 ORDER BY created_at DESC';
    const rows = await dbQuery(selectQuery, [targetUserId]);

    const userStories = rows.map(row => {
      let meta;
      if (row.metadata) {
        meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      } else if (row.data) {
        // Fallback: parse full data
        const story = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        const sceneCount = story.sceneImages?.length || 0;
        meta = {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          languageLevel: story.languageLevel,
          sceneCount,
          hasThumbnail: !!(story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail),
          characters: (story.characters || []).map(c => ({ id: c.id, name: c.name })),
        };
      } else {
        return null;
      }

      const sceneCount = meta.sceneCount || 0;
      const isPictureBook = meta.languageLevel === '1st-grade';
      const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
      const pageCount = sceneCount > 0 ? storyPages + 3 : 0;

      return {
        id: meta.id,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        pages: meta.pages,
        language: meta.language,
        languageLevel: meta.languageLevel,
        characters: meta.characters || [],
        pageCount,
        hasThumbnail: meta.hasThumbnail || false
      };
    }).filter(Boolean);

    log.info(`[ADMIN] Found ${userStories.length} stories for user ${targetUsername} (ID: ${targetUserId})`);
    res.json({ userId: targetUserId, username: targetUsername, stories: userStories });
  } catch (err) {
    console.error('[ADMIN] Error fetching user stories:', err);
    res.status(500).json({ error: 'Failed to fetch user stories', details: err.message });
  }
});

// GET /api/admin/users/:userId/stories/:storyId - Get specific story
router.get('/:userId/stories/:storyId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const storyId = req.params.storyId;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`[ADMIN] GET /api/admin/users/${targetUserId}/stories/${storyId} - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const selectQuery = 'SELECT data FROM stories WHERE id = $1 AND user_id = $2';
    const rows = await dbQuery(selectQuery, [storyId, targetUserId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    log.info(`[ADMIN] Returning story "${story.title}" for user ${targetUserId}`);
    res.json(story);
  } catch (err) {
    console.error('[ADMIN] Error fetching story:', err);
    res.status(500).json({ error: 'Failed to fetch story', details: err.message });
  }
});

// DELETE /api/admin/users/:userId - Delete user and all data
router.delete('/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userIdToDelete = parseInt(req.params.userId);

    if (isNaN(userIdToDelete)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (userIdToDelete === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const userResult = await pool.query('SELECT username, email FROM users WHERE id = $1', [userIdToDelete]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    log.info(`[ADMIN] Deleting user ${user.username} (${user.email}) and all their data...`);

    // Delete in order due to foreign key constraints
    const deletedJobs = await pool.query('DELETE FROM story_jobs WHERE user_id = $1 RETURNING id', [userIdToDelete]);
    const deletedOrders = await pool.query('DELETE FROM orders WHERE user_id = $1 RETURNING id', [userIdToDelete]);
    const deletedStories = await pool.query('DELETE FROM stories WHERE user_id = $1 RETURNING id', [userIdToDelete]);
    const deletedCharacters = await pool.query('DELETE FROM characters WHERE user_id = $1 RETURNING id', [userIdToDelete]);
    const deletedFiles = await pool.query('DELETE FROM files WHERE user_id = $1 RETURNING id', [userIdToDelete]);

    let deletedLogsCount = 0;
    try {
      const deletedLogs = await pool.query('DELETE FROM activity_log WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      deletedLogsCount = deletedLogs.rows.length;
    } catch (err) {
      // Activity log table may not exist
    }

    await pool.query('DELETE FROM users WHERE id = $1', [userIdToDelete]);

    log.info(`[ADMIN] Successfully deleted user ${user.username} and all associated data`);

    res.json({
      success: true,
      message: `User ${user.username} and all associated data deleted successfully`,
      deletedCounts: {
        storyJobs: deletedJobs.rows.length,
        orders: deletedOrders.rows.length,
        stories: deletedStories.rows.length,
        characters: deletedCharacters.rows.length,
        files: deletedFiles.rows.length,
        activityLogs: deletedLogsCount
      }
    });
  } catch (err) {
    console.error('[ADMIN] Error deleting user:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
