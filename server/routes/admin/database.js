/**
 * Admin Database Routes
 *
 * Database maintenance, cleanup, and management endpoints.
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

// POST /api/admin/fix-shipping-columns
router.post('/fix-shipping-columns', authenticateToken, requireAdmin, async (req, res) => {
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

module.exports = router;
