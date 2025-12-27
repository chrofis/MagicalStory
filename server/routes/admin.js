/**
 * Admin Routes - /api/admin/*
 *
 * Admin dashboard operations, user management, system stats, etc.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const { dbQuery, getPool } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Get JWT secret from environment
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Helper to check if using database mode
const isDatabaseMode = () => {
  return process.env.STORAGE_MODE === 'database' && getPool();
};

// Helper to log activity
async function logActivity(userId, username, action, details) {
  try {
    if (isDatabaseMode()) {
      await dbQuery(
        'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
        [userId, username, action, JSON.stringify(details)]
      );
    }
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// =============================================
// USER MANAGEMENT
// =============================================

// GET /api/admin/users - List all users
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
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
      ORDER BY u.created_at ASC
    `;
    const rows = await dbQuery(selectQuery, []);

    const safeUsers = rows.map(user => ({
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

    res.json(safeUsers);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /api/admin/users/:userId/quota - Update user credits
router.post('/users/:userId/quota', authenticateToken, requireAdmin, async (req, res) => {
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
router.post('/users/:userId/email-verified', authenticateToken, requireAdmin, async (req, res) => {
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

    log.debug(`🔧 [ADMIN] Email verification for user ${user.username} changed: ${previousStatus} -> ${emailVerified}`);

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

// POST /api/admin/users/:userId/photo-consent - Toggle photo consent status
router.post('/users/:userId/photo-consent', authenticateToken, requireAdmin, async (req, res) => {
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
      // Set consent to current timestamp
      await dbQuery('UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE id = $1', [userId]);
    } else {
      // Remove consent (set to NULL)
      await dbQuery('UPDATE users SET photo_consent_at = NULL WHERE id = $1', [userId]);
    }

    // Fetch the updated value
    const updatedRows = await dbQuery('SELECT photo_consent_at FROM users WHERE id = $1', [userId]);
    const photoConsentAt = updatedRows[0]?.photo_consent_at || null;

    log.debug(`🔧 [ADMIN] Photo consent for user ${user.username} changed: ${previousStatus} -> ${hasConsent}`);

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
router.get('/users/:userId/credits', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const limit = parseInt(req.query.limit) || 50;

    log.info(`💳 [ADMIN] GET /api/admin/users/${targetUserId}/credits - Admin: ${req.user.username}`);

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
router.get('/users/:userId/details', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    log.info(`👤 [ADMIN] GET /api/admin/users/${targetUserId}/details - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'User details requires database mode' });
    }

    // Get user info
    const userResult = await dbQuery(
      'SELECT id, username, email, role, credits, story_quota, stories_generated, created_at, last_login FROM users WHERE id = $1',
      [targetUserId]
    );
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult[0];

    // Get story count and list
    const storiesResult = await dbQuery(
      `SELECT id, data, created_at FROM stories WHERE user_id = $1 ORDER BY created_at DESC`,
      [targetUserId]
    );

    // Count characters from the characters table for this user (matches main dashboard)
    const characterDataResult = await dbQuery('SELECT data FROM characters WHERE user_id = $1', [targetUserId]);
    let totalCharacters = 0;
    for (const row of characterDataResult) {
      try {
        const charData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        if (charData.characters && Array.isArray(charData.characters)) {
          totalCharacters += charData.characters.length;
        }
      } catch (err) {
        // Skip malformed character data
      }
    }

    // Calculate totals
    let totalImages = 0;
    const totalTokens = {
      anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
    };

    const stories = storiesResult.map(s => {
      try {
        const storyData = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
        // Calculate page count:
        // - Picture book (1st-grade): 1 scene = 1 page (image with text below)
        // - Standard/Advanced: 1 scene = 2 pages (text page + image page)
        // - Plus 3 cover pages (front, back, initial/dedication)
        const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
        const isPictureBook = storyData?.languageLevel === '1st-grade';
        const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
        const pageCount = sceneCount > 0 ? storyPages + 3 : 0;
        const sceneImageCount = storyData?.sceneImages?.length || 0;
        const coverImageCount = storyData?.coverImages ?
          (storyData.coverImages.frontCover ? 1 : 0) +
          (storyData.coverImages.backCover ? 1 : 0) +
          (storyData.coverImages.spine ? 1 : 0) : 0;
        const imageCount = sceneImageCount + coverImageCount;
        totalImages += imageCount;

        // Aggregate token usage
        if (storyData?.tokenUsage) {
          const tu = storyData.tokenUsage;
          for (const provider of ['anthropic', 'gemini_text', 'gemini_image', 'gemini_quality']) {
            if (tu[provider]) {
              totalTokens[provider].input_tokens += tu[provider].input_tokens || 0;
              totalTokens[provider].output_tokens += tu[provider].output_tokens || 0;
              totalTokens[provider].calls += tu[provider].calls || 0;
            }
          }
        }

        return {
          id: s.id,
          title: storyData?.title || storyData?.storyTitle || 'Untitled',
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

    // Get purchase history
    const ordersResult = await dbQuery(
      `SELECT id, story_id, amount_total, currency, payment_status, gelato_order_id, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [targetUserId]
    );
    const purchases = ordersResult.map(o => ({
      id: o.id,
      storyId: o.story_id,
      amount: o.amount_total,
      currency: o.currency,
      status: o.payment_status,
      gelatoOrderId: o.gelato_order_id,
      createdAt: o.created_at
    }));

    // Get credit transactions
    const creditsResult = await dbQuery(
      `SELECT id, amount, balance_after, transaction_type, description, created_at
       FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [targetUserId]
    );
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
router.get('/users/:userId/stories', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`📚 [ADMIN] GET /api/admin/users/${targetUserId}/stories - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const userResult = await dbQuery('SELECT username FROM users WHERE id = $1', [targetUserId]);
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const targetUsername = userResult[0].username;

    const selectQuery = 'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC';
    const rows = await dbQuery(selectQuery, [targetUserId]);

    const userStories = rows.map(row => {
      const story = JSON.parse(row.data);
      // Calculate page count:
      // - Picture book (1st-grade): 1 scene = 1 page (image with text below)
      // - Standard/Advanced: 1 scene = 2 pages (text page + image page)
      // - Plus 3 cover pages (front, back, initial/dedication)
      const sceneCount = story.sceneImages?.length || 0;
      const isPictureBook = story.languageLevel === '1st-grade';
      const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
      const pageCount = sceneCount > 0 ? storyPages + 3 : 0;
      return {
        id: story.id,
        title: story.title,
        createdAt: story.createdAt,
        updatedAt: story.updatedAt,
        pages: story.pages,
        language: story.language,
        languageLevel: story.languageLevel,
        characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
        pageCount,
        thumbnail: (story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null)
      };
    });

    log.info(`📚 [ADMIN] Found ${userStories.length} stories for user ${targetUsername} (ID: ${targetUserId})`);
    res.json({ userId: targetUserId, username: targetUsername, stories: userStories });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching user stories:', err);
    res.status(500).json({ error: 'Failed to fetch user stories', details: err.message });
  }
});

// GET /api/admin/users/:userId/stories/:storyId - Get specific story
router.get('/users/:userId/stories/:storyId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const storyId = req.params.storyId;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`📖 [ADMIN] GET /api/admin/users/${targetUserId}/stories/${storyId} - Admin: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const selectQuery = 'SELECT data FROM stories WHERE id = $1 AND user_id = $2';
    const rows = await dbQuery(selectQuery, [storyId, targetUserId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = JSON.parse(rows[0].data);
    log.info(`📖 [ADMIN] Returning story "${story.title}" for user ${targetUserId}`);
    res.json(story);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching story:', err);
    res.status(500).json({ error: 'Failed to fetch story', details: err.message });
  }
});

// DELETE /api/admin/users/:userId - Delete user and all data
router.delete('/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
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
    log.info(`🗑️ [ADMIN] Deleting user ${user.username} (${user.email}) and all their data...`);

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

    log.info(`✅ [ADMIN] Successfully deleted user ${user.username} and all associated data`);

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
    console.error('❌ [ADMIN] Error deleting user:', err);
    res.status(500).json({ error: err.message });
  }
});

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

// =============================================
// PRINT PRODUCTS
// =============================================

// GET /api/admin/print-products
router.get('/print-products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const selectQuery = 'SELECT * FROM gelato_products ORDER BY created_at DESC';
    const products = await dbQuery(selectQuery, []);

    res.json({ products });
  } catch (err) {
    console.error('Error fetching print provider products:', err);
    res.status(500).json({ error: 'Failed to fetch print provider products' });
  }
});

// POST /api/admin/print-products
router.post('/print-products', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const {
      product_uid,
      product_name,
      description,
      size,
      cover_type,
      min_pages,
      max_pages,
      available_page_counts,
      is_active
    } = req.body;

    if (!product_uid || !product_name || min_pages === undefined || max_pages === undefined) {
      return res.status(400).json({ error: 'Missing required fields: product_uid, product_name, min_pages, max_pages' });
    }

    let pageCounts;
    try {
      pageCounts = typeof available_page_counts === 'string'
        ? JSON.parse(available_page_counts)
        : available_page_counts;
      if (!Array.isArray(pageCounts)) {
        throw new Error('Must be an array');
      }
    } catch (err) {
      return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
    }

    const insertQuery = `INSERT INTO gelato_products
         (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`;

    const pageCountsJson = JSON.stringify(pageCounts);
    const params = [
      product_uid,
      product_name,
      description || null,
      size || null,
      cover_type || null,
      min_pages,
      max_pages,
      pageCountsJson,
      is_active !== false
    ];

    const result = await dbQuery(insertQuery, params);
    const newProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_CREATED', {
      productId: newProduct.id,
      productName: product_name
    });

    res.json({ product: newProduct, message: 'Product created successfully' });
  } catch (err) {
    console.error('Error creating print provider product:', err);
    res.status(500).json({ error: 'Failed to create print provider product' });
  }
});

// PUT /api/admin/print-products/:id
router.put('/print-products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const updates = req.body;

    const allowedFields = ['product_uid', 'product_name', 'description', 'size', 'cover_type', 'min_pages', 'max_pages', 'available_page_counts', 'is_active'];
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        let value = updates[field];

        if (field === 'available_page_counts') {
          try {
            const pageCounts = typeof value === 'string' ? JSON.parse(value) : value;
            if (!Array.isArray(pageCounts)) {
              throw new Error('Must be an array');
            }
            value = JSON.stringify(pageCounts);
          } catch (err) {
            return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
          }
        }

        setClauses.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const updateQuery = `UPDATE gelato_products SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await dbQuery(updateQuery, params);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_UPDATED', {
      productId: id,
      productName: updatedProduct.product_name
    });

    res.json({ product: updatedProduct, message: 'Product updated successfully' });
  } catch (err) {
    console.error('Error updating print provider product:', err);
    res.status(500).json({ error: 'Failed to update print provider product' });
  }
});

// PUT /api/admin/print-products/:id/toggle
router.put('/print-products/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const { is_active } = req.body;

    const updateQuery = 'UPDATE gelato_products SET is_active = $1 WHERE id = $2 RETURNING *';

    const result = await dbQuery(updateQuery, [!is_active, id]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_TOGGLED', {
      productId: id,
      isActive: !is_active
    });

    res.json({ product: updatedProduct, message: 'Product status updated successfully' });
  } catch (err) {
    console.error('Error toggling print provider product status:', err);
    res.status(500).json({ error: 'Failed to toggle product status' });
  }
});

// DELETE /api/admin/print-products/:id
router.delete('/print-products/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;

    const selectQuery = 'SELECT product_name FROM gelato_products WHERE id = $1';
    const rows = await dbQuery(selectQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productName = rows[0].product_name;

    const deleteQuery = 'DELETE FROM gelato_products WHERE id = $1';
    await dbQuery(deleteQuery, [id]);

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_DELETED', {
      productId: id,
      productName: productName
    });

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error('Error deleting print provider product:', err);
    res.status(500).json({ error: 'Failed to delete print provider product' });
  }
});

// =============================================
// ORDERS
// =============================================

// GET /api/admin/orders
router.get('/orders', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Orders are only available in database mode' });
    }

    console.log('📦 [ADMIN] Fetching all orders...');

    const pool = getPool();
    const orders = await pool.query(`
      SELECT
        o.id,
        o.user_id,
        u.email as user_email,
        o.story_id,
        o.stripe_session_id,
        o.stripe_payment_intent_id,
        o.customer_name,
        o.customer_email,
        o.shipping_name,
        o.shipping_address_line1,
        o.shipping_city,
        o.shipping_postal_code,
        o.shipping_country,
        o.amount_total,
        o.currency,
        o.payment_status,
        o.gelato_order_id,
        o.gelato_status,
        o.created_at,
        o.updated_at,
        CASE
          WHEN o.payment_status = 'paid' AND o.gelato_order_id IS NULL THEN true
          ELSE false
        END as has_issue
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `);

    const totalOrders = orders.rows.length;
    const failedOrders = orders.rows.filter(o => o.has_issue);

    log.info(`✅ [ADMIN] Found ${totalOrders} orders, ${failedOrders.length} with issues`);

    res.json({
      success: true,
      totalOrders,
      failedOrdersCount: failedOrders.length,
      orders: orders.rows
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// STATISTICS & MONITORING
// =============================================

// GET /api/admin/stats
router.get('/stats', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Admin stats are only available in database mode' });
    }

    console.log('📊 [ADMIN] Fetching dashboard statistics...');

    const pool = getPool();
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const storyCountResult = await pool.query('SELECT COUNT(*) as count FROM stories');
    const fileCountResult = await pool.query('SELECT COUNT(*) as count FROM files');

    // Count individual characters
    const characterDataResult = await pool.query('SELECT data FROM characters');
    let totalCharacters = 0;
    for (const row of characterDataResult.rows) {
      try {
        const charData = JSON.parse(row.data);
        if (charData.characters && Array.isArray(charData.characters)) {
          totalCharacters += charData.characters.length;
        }
      } catch (err) {
        console.warn('⚠️ Skipping malformed character data');
      }
    }

    // Get orphaned files
    const orphanedFilesResult = await pool.query(`
      SELECT f.id, f.story_id, f.file_type, f.file_size, f.filename, f.created_at
      FROM files f
      WHERE f.story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = f.story_id
        )
      ORDER BY f.created_at DESC
      LIMIT 100
    `);

    // Count images in files table
    const imageFilesResult = await pool.query(
      "SELECT COUNT(*) as count FROM files WHERE file_type = 'image' OR mime_type LIKE 'image/%'"
    );

    // Count images embedded in story data
    const storiesWithData = await pool.query('SELECT data FROM stories');
    let embeddedImagesCount = 0;

    for (const row of storiesWithData.rows) {
      try {
        const storyData = JSON.parse(row.data);
        if (storyData.sceneImages && Array.isArray(storyData.sceneImages)) {
          embeddedImagesCount += storyData.sceneImages.length;
        }
      } catch (err) {
        console.warn('⚠️ Skipping malformed story data');
      }
    }

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
    const tableSizes = await pool.query(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);

    const rowCountMap = {};
    for (const table of tableSizes.rows) {
      try {
        const result = await pool.query(`SELECT COUNT(*) as row_count FROM ${table.tablename}`);
        rowCountMap[table.tablename] = parseInt(result.rows[0].row_count);
      } catch (err) {
        log.warn(`Could not get row count for table ${table.tablename}:`, err.message);
        rowCountMap[table.tablename] = 0;
      }
    }

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
        row_count: rowCountMap[row.tablename] || 0
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

// =============================================
// CLEANUP & MAINTENANCE
// =============================================

// POST /api/admin/fix-shipping-columns
router.post('/fix-shipping-columns', async (req, res) => {
  try {
    const results = [];
    const columns = [
      { name: 'shipping_first_name', type: 'VARCHAR(255)' },
      { name: 'shipping_last_name', type: 'VARCHAR(255)' },
      { name: 'shipping_address_line1', type: 'VARCHAR(500)' },
      { name: 'shipping_city', type: 'VARCHAR(255)' },
      { name: 'shipping_post_code', type: 'VARCHAR(50)' },
      { name: 'shipping_country', type: 'VARCHAR(2)' },
      { name: 'shipping_email', type: 'VARCHAR(255)' }
    ];

    for (const col of columns) {
      try {
        await dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.push({ column: col.name, status: 'OK' });
      } catch (err) {
        results.push({ column: col.name, status: 'ERROR', error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned-data
router.post('/cleanup-orphaned-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned data...');

    const orphanedCharsResult = await dbQuery(
      `SELECT COUNT(*) as count FROM characters WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedCharsCount = parseInt(orphanedCharsResult[0].count);

    const orphanedStoriesResult = await dbQuery(
      `SELECT COUNT(*) as count FROM stories WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedStoriesCount = parseInt(orphanedStoriesResult[0].count);

    console.log(`Found ${orphanedCharsCount} orphaned characters, ${orphanedStoriesCount} orphaned stories`);

    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned data...');

      let deletedChars = 0;
      let deletedStories = 0;

      if (orphanedCharsCount > 0) {
        const deleteCharsResult = await dbQuery(
          `DELETE FROM characters WHERE user_id IS NULL OR user_id = ''`
        );
        deletedChars = deleteCharsResult.rowCount;
        console.log(`✓ Deleted ${deletedChars} orphaned characters`);
      }

      if (orphanedStoriesCount > 0) {
        const deleteStoriesResult = await dbQuery(
          `DELETE FROM stories WHERE user_id IS NULL OR user_id = ''`
        );
        deletedStories = deleteStoriesResult.rowCount;
        console.log(`✓ Deleted ${deletedStories} orphaned stories`);
      }

      res.json({
        success: true,
        action: 'deleted',
        deleted: {
          characters: deletedChars,
          stories: deletedStories
        }
      });
    } else {
      res.json({
        success: true,
        action: 'check',
        found: {
          characters: orphanedCharsCount,
          stories: orphanedStoriesCount
        },
        message: 'Use action=delete to remove orphaned data'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned data:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned-jobs
router.post('/cleanup-orphaned-jobs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned story_jobs...');

    const pool = getPool();
    const orphanedJobsResult = await pool.query(`
      SELECT sj.id, sj.user_id, sj.status, sj.created_at, sj.updated_at,
             sj.progress, sj.progress_message, u.username
      FROM story_jobs sj
      LEFT JOIN users u ON sj.user_id = u.id
      WHERE NOT EXISTS (
        SELECT 1 FROM stories s WHERE s.id = sj.id
      )
      ORDER BY sj.created_at DESC
      LIMIT 100
    `);

    const orphanedJobs = orphanedJobsResult.rows;
    console.log(`Found ${orphanedJobs.length} orphaned story_jobs`);

    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned story_jobs...');

      const deleteResult = await pool.query(`
        DELETE FROM story_jobs
        WHERE NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_jobs.id
        )
      `);

      console.log(`✓ Deleted ${deleteResult.rowCount} orphaned story_jobs`);

      res.json({
        success: true,
        action: 'deleted',
        deleted: deleteResult.rowCount
      });
    } else {
      res.json({
        success: true,
        action: 'check',
        count: orphanedJobs.length,
        jobs: orphanedJobs.map(j => ({
          id: j.id,
          userId: j.user_id,
          username: j.username,
          status: j.status,
          progress: j.progress,
          progressMessage: j.progress_message,
          createdAt: j.created_at,
          updatedAt: j.updated_at
        })),
        message: 'Use action=delete to remove orphaned jobs'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned
router.post('/cleanup-orphaned', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'File cleanup is only available in database mode' });
    }

    console.log('🗑️ [ADMIN] Cleaning all orphaned files...');

    const pool = getPool();
    const result = await pool.query(`
      DELETE FROM files
      WHERE story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_id
        )
    `);

    const cleaned = result.rowCount || 0;
    log.info(`✅ [ADMIN] Cleaned ${cleaned} orphaned files`);

    res.json({ cleaned });
  } catch (err) {
    console.error('❌ [ADMIN] Error cleaning orphaned files:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/clear-cache
router.post('/clear-cache', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🧹 [ADMIN] Clearing all caches...');
    // Cache clearing would need to be implemented at application level
    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (err) {
    console.error('❌ [ADMIN] Error clearing cache:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/orphaned-files
router.delete('/orphaned-files', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'File deletion is only available in database mode' });
    }

    const { fileId } = req.body;

    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required (use "all" to delete all orphaned files)' });
    }

    const pool = getPool();
    let deletedCount = 0;

    if (fileId === 'all') {
      console.log('🗑️ [ADMIN] Deleting all orphaned files...');

      const result = await pool.query(`
        DELETE FROM files
        WHERE story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = files.story_id
          )
      `);

      deletedCount = result.rowCount;
      log.info(`✅ [ADMIN] Deleted ${deletedCount} orphaned files`);
    } else {
      console.log(`🗑️ [ADMIN] Deleting orphaned file: ${fileId}`);

      const checkResult = await pool.query(`
        SELECT f.id, f.story_id
        FROM files f
        WHERE f.id = $1
          AND f.story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = f.story_id
          )
      `, [fileId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'File not found or not orphaned' });
      }

      await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
      deletedCount = 1;
      log.info(`✅ [ADMIN] Deleted orphaned file: ${fileId}`);
    }

    res.json({
      success: true,
      deletedCount,
      message: `Successfully deleted ${deletedCount} orphaned file(s)`
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error deleting orphaned files:', err);
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
router.get('/token-usage', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('📊 [ADMIN] Fetching token usage statistics...');

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
      ORDER BY s.created_at DESC
    `);

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
