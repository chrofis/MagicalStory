/**
 * Admin Job Management Routes
 *
 * View and retry failed story generation jobs
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

// GET /api/admin/jobs/failed - List failed story jobs from last 7 days
router.get('/failed', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const pool = getPool();
    const result = await pool.query(`
      SELECT
        j.id,
        j.status,
        j.created_at,
        j.updated_at,
        j.progress,
        j.progress_message,
        j.error_message,
        j.user_id,
        u.username,
        u.email,
        j.input_data->>'storyType' as story_type,
        j.input_data->>'storyCategory' as story_category,
        j.input_data->>'storyTheme' as story_theme,
        j.input_data->>'pages' as pages,
        j.input_data->>'language' as language,
        j.input_data->>'artStyle' as art_style,
        LEFT(j.input_data->>'storyDetails', 200) as story_preview,
        j.input_data->>'dedication' as dedication
      FROM story_jobs j
      LEFT JOIN users u ON j.user_id = u.id
      WHERE j.status = 'failed'
      AND j.created_at > NOW() - INTERVAL '7 days'
      ORDER BY j.created_at DESC
      LIMIT 100
    `);

    log.debug(`[ADMIN] Retrieved ${result.rows.length} failed jobs`);
    res.json({ jobs: result.rows });
  } catch (err) {
    log.error('Error getting failed jobs:', err);
    res.status(500).json({ error: 'Failed to get failed jobs', details: err.message });
  }
});

// POST /api/admin/jobs/:jobId/retry - Create a new job from failed job's input data
router.post('/:jobId/retry', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    // Get original job data
    const jobResult = await pool.query(
      'SELECT * FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const originalJob = jobResult.rows[0];

    // Only allow retry of failed jobs
    if (originalJob.status !== 'failed') {
      return res.status(400).json({
        error: 'Can only retry failed jobs',
        currentStatus: originalJob.status
      });
    }

    const inputData = originalJob.input_data;
    const userId = originalJob.user_id;

    // Create new job ID
    const newJobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    // Insert new job with same input data (no credit charge for admin retry)
    await pool.query(
      `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
       VALUES ($1, $2, 'pending', $3, 0, 'Admin retry - waiting to start...', 0)`,
      [newJobId, userId, JSON.stringify(inputData)]
    );

    log.info(`[ADMIN] Created retry job ${newJobId} from failed job ${jobId} (user: ${userId})`);

    // Return the new job ID - the caller will need to trigger processing
    // We export this so server.js can call processStoryJob
    res.json({
      success: true,
      newJobId,
      originalJobId: jobId,
      userId,
      message: `Created retry job ${newJobId} from failed job ${jobId}`
    });
  } catch (err) {
    log.error('Error retrying job:', err);
    res.status(500).json({ error: 'Failed to retry job', details: err.message });
  }
});

// GET /api/admin/jobs/:jobId - Get full job details including input_data
router.get('/:jobId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'Database mode required' });
    }

    const { jobId } = req.params;
    const pool = getPool();

    const result = await pool.query(
      `SELECT
        j.*,
        u.username,
        u.email
       FROM story_jobs j
       LEFT JOIN users u ON j.user_id = u.id
       WHERE j.id = $1`,
      [jobId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];

    // Remove character photos from input_data to reduce response size
    if (job.input_data?.characters) {
      job.input_data.characters = job.input_data.characters.map(c => ({
        ...c,
        photos: c.photos ? {
          hasBody: !!c.photos.body,
          hasFace: !!c.photos.face
        } : null
      }));
    }

    res.json({ job });
  } catch (err) {
    log.error('Error getting job details:', err);
    res.status(500).json({ error: 'Failed to get job details', details: err.message });
  }
});

module.exports = router;
