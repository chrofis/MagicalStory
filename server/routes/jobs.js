/**
 * Job Management Routes — Extracted from server.js
 *
 * Contains: story job creation, status polling, cancellation,
 * checkpoint inspection, and my-jobs listing.
 */

const express = require('express');
const router = express.Router();

// Middleware
const { authenticateToken } = require('../middleware/auth');
const { storyGenerationLimiter, jobStatusLimiter } = require('../middleware/rateLimit');
const { validateBody, schemas, sanitizeString, sanitizeInteger } = require('../middleware/validation');

// Config
const { CREDIT_CONFIG } = require('../config/credits');

// Services
const { log } = require('../utils/logger');
const { getPool } = require('../services/database');

function getDbPool() { return getPool(); }

// STORAGE_MODE from environment
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' && process.env.DATABASE_URL)
  ? 'database' : 'file';

// Server.js-local dependencies received via init()
let deps = {};

function initJobRoutes(serverDeps) {
  deps = serverDeps;
}

// Clean up old completed/failed jobs and their checkpoints
async function cleanupOldCompletedJobs() {
  if (STORAGE_MODE !== 'database') return;
  const pool = getDbPool();
  if (!pool) return;

  try {
    const cpResult = await pool.query(`
      DELETE FROM story_job_checkpoints
      WHERE job_id IN (
        SELECT id FROM story_jobs
        WHERE status IN ('completed', 'failed')
        AND updated_at < NOW() - INTERVAL '1 hour'
      )
    `);

    const jobResult = await pool.query(`
      DELETE FROM story_jobs
      WHERE status IN ('completed', 'failed')
      AND updated_at < NOW() - INTERVAL '1 hour'
    `);

    if (cpResult.rowCount > 0 || jobResult.rowCount > 0) {
      log.info(`🧹 Cleanup: deleted ${cpResult.rowCount} old checkpoints, ${jobResult.rowCount} old jobs`);
    }
  } catch (err) {
    log.error(`❌ Failed to cleanup old jobs:`, err.message);
  }
}

// Create a new story generation job
router.post('/create-story', authenticateToken, storyGenerationLimiter, validateBody(schemas.createStory), async (req, res) => {
  try {
    const userId = req.user.id;

    // Extract and validate idempotency key (optional but recommended)
    const idempotencyKey = req.body.idempotencyKey ? sanitizeString(req.body.idempotencyKey, 100) : null;

    // If idempotency key provided, check for existing job first
    if (idempotencyKey && STORAGE_MODE === 'database') {
      const existingJob = await getDbPool().query(
        `SELECT id, status, progress, progress_message, created_at
         FROM story_jobs
         WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );

      if (existingJob.rows.length > 0) {
        const job = existingJob.rows[0];
        log.debug(`🔄 Returning existing job ${job.id} for idempotency key ${idempotencyKey}`);
        return res.json({
          success: true,
          jobId: job.id,
          existing: true,
          status: job.status,
          message: 'Story generation already started with this request.'
        });
      }
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Sanitize and validate input data using centralized config
    const inputData = {
      ...req.body,
      pages: sanitizeInteger(req.body.pages, CREDIT_CONFIG.STORY_PAGES.DEFAULT, CREDIT_CONFIG.STORY_PAGES.MIN, CREDIT_CONFIG.STORY_PAGES.MAX),
      language: sanitizeString(req.body.language || 'en', 50),
      languageLevel: sanitizeString(req.body.languageLevel || 'standard', 50),
      storyType: sanitizeString(req.body.storyType || '', 100),
      artStyle: sanitizeString(req.body.artStyle || 'pixar', 50),
      storyDetails: sanitizeString(req.body.storyDetails || '', 10000),
      dedication: sanitizeString(req.body.dedication || '', 500)
    };
    // Remove idempotencyKey from input_data as it's stored separately
    delete inputData.idempotencyKey;

    log.debug(`📝 Creating story job ${jobId} for user ${req.user.username}${idempotencyKey ? ` (idempotency: ${idempotencyKey})` : ''}`);
    log.debug(`📝 [JOB INPUT] pages: ${req.body.pages} → ${inputData.pages}${req.body.pages !== inputData.pages ? ' (clamped!)' : ''}, level: ${inputData.languageLevel}`);
    log.debug(`📝 [JOB INPUT] language: ${req.body.language} → ${inputData.language}`);
    log.debug(`📝 [JOB INPUT] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"`);
    if (inputData.ideaGeneration) {
      log.debug(`📝 [JOB INPUT] ideaGeneration: model=${inputData.ideaGeneration.model}, selectedIndex=${inputData.ideaGeneration.selectedIndex}, ideas=${inputData.ideaGeneration.output?.length || 0}`);
    }

    // Check email verification (skip for admins and impersonating admins)
    const isImpersonating = req.user.impersonating === true;
    if (req.user.role !== 'admin' && !isImpersonating && STORAGE_MODE === 'database') {
      const emailCheckResult = await getDbPool().query(
        'SELECT email_verified FROM users WHERE id = $1',
        [userId]
      );

      // Check if email is NOT verified (NULL or FALSE both require verification, only TRUE passes)
      if (emailCheckResult.rows.length > 0 && emailCheckResult.rows[0].email_verified !== true) {
        log.warn(`User ${req.user.username} attempted story generation without verified email (value: ${emailCheckResult.rows[0].email_verified})`);

        // Send/resend verification email
        let emailSent = false;
        try {
          const userResult = await getDbPool().query(
            'SELECT id, username, email FROM users WHERE id = $1',
            [userId]
          );
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            const verificationToken = crypto.randomBytes(32).toString('hex');
            const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await getDbPool().query(
              'UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3',
              [verificationToken, verificationExpires, user.id]
            );

            const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
            console.log(`📧 Attempting to send verification email to: ${user.email}`);
            const result = await email.sendEmailVerificationEmail(user.email, user.username, verifyUrl);
            if (result) {
              console.log(`📧 ✓ Verification email sent successfully to: ${user.email}`);
              emailSent = true;
            } else {
              console.error(`📧 ✗ Verification email failed for: ${user.email} (no result returned)`);
            }
          }
        } catch (emailErr) {
          console.error('📧 ✗ Failed to send verification email:', emailErr.message);
        }

        return res.status(403).json({
          error: 'Email verification required',
          code: 'EMAIL_NOT_VERIFIED',
          emailSent: emailSent,
          message: emailSent
            ? 'Please verify your email first. We just sent you a verification link - story generation will start as soon as you verify your email.'
            : 'Email verification required. Please check your email for a verification link, or contact support if you did not receive one.'
        });
      }
    }

    // Check if user already has a story generation in progress
    if (STORAGE_MODE === 'database') {
      const activeJobResult = await getDbPool().query(
        `SELECT id, status, created_at, updated_at, progress FROM story_jobs
         WHERE user_id = $1 AND status IN ('pending', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (activeJobResult.rows.length > 0) {
        const activeJob = activeJobResult.rows[0];
        const jobAgeMinutes = (Date.now() - new Date(activeJob.created_at).getTime()) / (1000 * 60);
        const minutesSinceUpdate = activeJob.updated_at
          ? (Date.now() - new Date(activeJob.updated_at).getTime()) / (1000 * 60)
          : jobAgeMinutes;

        // Two failure modes:
        // 1. Total timeout: Job running for more than 60 minutes total
        // 2. Heartbeat timeout: No progress update for 15 minutes (something is stuck)
        const TOTAL_TIMEOUT_MINUTES = 60;
        const HEARTBEAT_TIMEOUT_MINUTES = 15;

        const isStale = jobAgeMinutes > TOTAL_TIMEOUT_MINUTES ||
          minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES;

        if (isStale) {
          const reason = jobAgeMinutes > 120 ? 'abandoned' :
            minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES ? 'no progress' : 'timeout';
          log.info(`🧹 Auto-cancelling stale job ${activeJob.id} (${reason}, age: ${Math.round(jobAgeMinutes)}min, last update: ${Math.round(minutesSinceUpdate)}min ago)`);

          // Refund reserved credits for stale job
          try {
            const staleJobResult = await getDbPool().query(
              'SELECT credits_reserved, progress FROM story_jobs WHERE id = $1',
              [activeJob.id]
            );
            if (staleJobResult.rows.length > 0 && staleJobResult.rows[0].credits_reserved > 0) {
              const creditsToRefund = staleJobResult.rows[0].credits_reserved;
              const progressPercent = staleJobResult.rows[0].progress || 0;

              // Get current user balance
              const userBalanceResult = await getDbPool().query(
                'SELECT credits FROM users WHERE id = $1',
                [userId]
              );

              if (userBalanceResult.rows.length > 0 && userBalanceResult.rows[0].credits !== -1) {
                const currentBalance = userBalanceResult.rows[0].credits;
                const newBalance = currentBalance + creditsToRefund;

                // Refund credits
                await getDbPool().query('UPDATE users SET credits = $1 WHERE id = $2', [newBalance, userId]);

                // Log refund transaction
                await getDbPool().query(
                  `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
                   VALUES ($1, $2, $3, $4, $5, $6)`,
                  [userId, creditsToRefund, newBalance, 'story_refund', activeJob.id,
                   `Auto-refund: stale job timed out after ${Math.round(jobAgeMinutes)} min (progress: ${progressPercent}%)`]
                );

                log.info(`💳 Auto-refunded ${creditsToRefund} credits for stale job ${activeJob.id}`);
              }

              // Reset credits_reserved to prevent double refunds
              await getDbPool().query('UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1', [activeJob.id]);
            }
          } catch (refundErr) {
            log.error(`❌ Failed to refund credits for stale job ${activeJob.id}:`, refundErr.message);
          }

          // Mark as failed with appropriate message based on failure reason
          const errorMessage = jobAgeMinutes > 120
            ? 'Job was abandoned (cleaned up automatically)'
            : minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES
              ? `Job stopped responding (no progress for ${Math.round(minutesSinceUpdate)} minutes)`
              : `Job timed out after ${Math.round(jobAgeMinutes)} minutes`;

          await getDbPool().query(
            `UPDATE story_jobs
             SET status = 'failed',
                 error_message = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [activeJob.id, errorMessage]
          );
          // Continue with creating new job
        } else {
          log.warn(`User ${req.user.username} already has active job ${activeJob.id} (status: ${activeJob.status}, age: ${Math.round(jobAgeMinutes)} min)`);
          return res.status(409).json({
            error: 'Story generation already in progress',
            activeJobId: activeJob.id,
            activeJobStatus: activeJob.status,
            jobAgeMinutes: Math.round(jobAgeMinutes),
            message: 'Please wait for your current story to finish before starting a new one.'
          });
        }
      }
    }

    // Check for missing clothing avatars (warn but don't block - graceful fallback to regular photos)
    const characters = inputData.characters || [];
    const charsWithoutAvatars = characters.filter(char => {
      const avatars = char.avatars || char.clothingAvatars || {};
      // Only check actual avatar URLs (winter, standard, summer, formal), not metadata like status/stale/faceMatch
      const hasAnyAvatar = Object.values(avatars).some(url => typeof url === 'string' && url.startsWith('data:image'));
      return !hasAnyAvatar && (char.photoUrl || char.bodyPhotoUrl); // Has photo but no avatars
    });
    if (charsWithoutAvatars.length > 0) {
      log.warn(`⚠️ [AVATAR CHECK] ${charsWithoutAvatars.length} character(s) missing clothing avatars: ${charsWithoutAvatars.map(c => c.name).join(', ')}. Using fallback photos.`);
    }

    if (STORAGE_MODE === 'database') {
      // Calculate credits needed using centralized config
      const pages = inputData.pages || CREDIT_CONFIG.STORY_PAGES.DEFAULT;
      const creditsNeeded = pages * CREDIT_CONFIG.COSTS.PER_PAGE;

      // Check user's credits
      const userResult = await getDbPool().query(
        'SELECT credits FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        console.log(`❌ User not found in database: userId=${userId}, username=${req.user.username}, email=${req.user.email}`);
        return res.status(404).json({ error: 'User not found' });
      }

      let userCredits = userResult.rows[0].credits;

      // Handle null credits - set default based on role (this shouldn't happen after migration)
      if (userCredits === null || userCredits === undefined) {
        log.warn(`User ${userId} has null credits, defaulting based on role`);
        userCredits = req.user.role === 'admin' ? -1 : 1000;
      }

      // Skip credit check if user has unlimited credits (-1) OR is admin
      if (userCredits !== -1 && req.user.role !== 'admin') {
        if (userCredits < creditsNeeded) {
          return res.status(402).json({
            error: 'Insufficient credits',
            creditsNeeded: creditsNeeded,
            creditsAvailable: userCredits,
            message: `This story requires ${creditsNeeded} credits (${pages} pages x ${CREDIT_CONFIG.COSTS.PER_PAGE} credits), but you only have ${userCredits} credits.`
          });
        }

        // Reserve credits atomically - this prevents race conditions
        // The UPDATE only succeeds if credits >= creditsNeeded, preventing overdraw
        const updateResult = await getDbPool().query(
          'UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits',
          [creditsNeeded, userId]
        );

        if (updateResult.rows.length === 0) {
          // Race condition occurred - another request already used the credits
          return res.status(402).json({
            error: 'Insufficient credits',
            creditsNeeded: creditsNeeded,
            message: 'Credits were used by another request. Please try again.'
          });
        }

        const newBalance = updateResult.rows[0].credits;

        // Create transaction record for credit reservation
        await getDbPool().query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, -creditsNeeded, newBalance, 'story_reserve', jobId, `Reserved ${creditsNeeded} credits for ${pages}-page story`]
        );

        log.debug(`💳 Reserved ${creditsNeeded} credits for job ${jobId} (user balance: ${userCredits} -> ${newBalance})`);
      }

      await getDbPool().query(
        `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...', (userCredits === -1 || req.user.role === 'admin') ? 0 : creditsNeeded, idempotencyKey]
      );

      // Clean up old completed/failed jobs in background (don't await)
      cleanupOldCompletedJobs().catch(err => log.error('Cleanup error:', err.message));

      // Update user's preferred language based on their story language choice
      if (inputData.language) {
        await getDbPool().query(
          'UPDATE users SET preferred_language = $1 WHERE id = $2',
          [inputData.language, userId]
        );
        log.debug(`🌐 Updated preferred language for user ${userId}: ${inputData.language}`);
      }
    } else {
      // File mode fallback - not supported for background jobs
      return res.status(503).json({
        error: 'Background jobs require database mode. Please use manual generation instead.'
      });
    }

    // Start processing the job asynchronously (don't await)
    deps.processStoryJob(jobId).catch(err => {
      log.error(`❌ Job ${jobId} failed:`, err);
    });

    // Get current credits to return to frontend
    const creditsResult = await getDbPool().query('SELECT credits FROM users WHERE id = $1', [userId]);
    const creditsRemaining = creditsResult.rows[0]?.credits ?? null;

    res.json({
      success: true,
      jobId,
      message: 'Story generation started. This will take approximately 10 minutes.',
      creditsRemaining  // Return updated credits so frontend can update immediately
    });
  } catch (err) {
    log.error('Error creating story job:', err);
    res.status(500).json({ error: 'Failed to create story job' });
  }
});

// Get job status (uses permissive rate limiter for frequent polling)
router.get('/:jobId/status', jobStatusLimiter, authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    if (STORAGE_MODE === 'database') {
      const result = await getDbPool().query(
        `SELECT id, status, progress, progress_message, result_data, error_message, created_at, completed_at, updated_at
         FROM story_jobs
         WHERE id = $1 AND user_id = $2`,
        [jobId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const job = result.rows[0];

      // Detect stale/stuck jobs during polling
      if (job.status === 'processing' || job.status === 'pending') {
        const jobAgeMinutes = (Date.now() - new Date(job.created_at).getTime()) / (1000 * 60);
        const minutesSinceUpdate = job.updated_at
          ? (Date.now() - new Date(job.updated_at).getTime()) / (1000 * 60)
          : jobAgeMinutes;

        // Two failure modes:
        // 1. Total timeout: Job running for more than 60 minutes total
        // 2. Heartbeat timeout: No progress update for 15 minutes (something is stuck)
        const TOTAL_TIMEOUT_MINUTES = 60;
        const HEARTBEAT_TIMEOUT_MINUTES = 15;

        let errorMessage = null;

        if (jobAgeMinutes > 120) {
          // Very old job - was abandoned (server restart, browser closed, etc.)
          errorMessage = 'Job was abandoned (server may have restarted)';
          log.info(`🧹 [STATUS] Job ${jobId} is abandoned (${Math.round(jobAgeMinutes)} minutes old), cleaning up`);
        } else if (minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES) {
          // Job stopped making progress - something is stuck
          errorMessage = `Job stopped responding (no progress for ${Math.round(minutesSinceUpdate)} minutes) - please try again`;
          log.warn(`💔 [STATUS] Job ${jobId} heartbeat timeout: no progress for ${Math.round(minutesSinceUpdate)} minutes (last progress: ${job.progress}%)`);
        } else if (jobAgeMinutes > TOTAL_TIMEOUT_MINUTES) {
          // Job running too long overall
          errorMessage = `Job timed out after ${Math.round(jobAgeMinutes)} minutes - please try again`;
          log.warn(`⏰ [STATUS] Job ${jobId} total timeout: ${Math.round(jobAgeMinutes)} minutes`);
        }

        if (errorMessage) {
          await getDbPool().query(
            `UPDATE story_jobs SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1`,
            [jobId, errorMessage]
          );

          // Update local job object to return correct status
          job.status = 'failed';
          job.error_message = errorMessage;
        }
      }

      // Fetch user's current credits when job is completed
      let currentCredits = null;
      if (job.status === 'completed') {
        const creditsResult = await getDbPool().query(
          'SELECT credits FROM users WHERE id = $1',
          [userId]
        );
        if (creditsResult.rows.length > 0) {
          currentCredits = creditsResult.rows[0].credits;
        }
      }

      // Fetch partial results (completed pages, covers, and story text) if job is still processing
      let partialPages = [];
      let partialCovers = {};
      let storyText = null;
      if (job.status === 'processing' || job.status === 'failed') {
        // Fetch partial pages (also for failed jobs to allow data recovery)
        const partialPagesResult = await getDbPool().query(
          `SELECT step_index, step_data
           FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_page'
           ORDER BY step_index ASC`,
          [jobId]
        );
        partialPages = partialPagesResult.rows.map(row => row.step_data);

        // Fetch partial covers (generated during streaming)
        const partialCoversResult = await getDbPool().query(
          `SELECT step_index, step_data
           FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_cover'
           ORDER BY step_index ASC`,
          [jobId]
        );
        // Convert to object: { frontCover: {...}, initialPage: {...}, backCover: {...} }
        partialCoversResult.rows.forEach(row => {
          const coverData = row.step_data;
          if (coverData && coverData.type) {
            partialCovers[coverData.type] = coverData;
          }
        });

        // Fetch story text checkpoint (contains page texts for progressive display)
        const storyTextResult = await getDbPool().query(
          `SELECT step_data
           FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'story_text'
           LIMIT 1`,
          [jobId]
        );
        if (storyTextResult.rows.length > 0) {
          storyText = storyTextResult.rows[0].step_data;
        }
      }

      res.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progress_message,
        result: job.result_data,  // Frontend expects 'result' not 'resultData'
        errorMessage: job.error_message,
        createdAt: job.created_at,
        completedAt: job.completed_at,
        partialPages: partialPages,  // Array of completed pages with text + image
        partialCovers: Object.keys(partialCovers).length > 0 ? partialCovers : undefined,  // Partial cover images
        storyText: storyText,  // Story text with page texts for progressive display
        currentCredits: currentCredits  // User's updated credits balance after completion
      });
    } else {
      return res.status(503).json({ error: 'Background jobs require database mode' });
    }
  } catch (err) {
    log.error('Error fetching job status:', err);
    res.status(500).json({ error: 'Failed to fetch job status' });
  }
});

// Cancel a running job
router.post('/:jobId/cancel', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    if (STORAGE_MODE !== 'database') {
      return res.status(503).json({ error: 'Background jobs require database mode' });
    }

    // Verify job belongs to user and is cancellable
    const result = await getDbPool().query(
      `SELECT id, status, created_at FROM story_jobs
       WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];

    if (job.status === 'completed' || job.status === 'failed') {
      return res.status(400).json({
        error: 'Job already finished',
        status: job.status,
        message: `Cannot cancel a job that is already ${job.status}`
      });
    }

    // Refund reserved credits before cancelling
    let creditsRefunded = 0;
    try {
      const jobCreditsResult = await getDbPool().query(
        'SELECT credits_reserved, progress FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobCreditsResult.rows.length > 0 && jobCreditsResult.rows[0].credits_reserved > 0) {
        const creditsToRefund = jobCreditsResult.rows[0].credits_reserved;
        const progressPercent = jobCreditsResult.rows[0].progress || 0;

        // Get current user balance
        const userBalanceResult = await getDbPool().query(
          'SELECT credits FROM users WHERE id = $1',
          [userId]
        );

        if (userBalanceResult.rows.length > 0 && userBalanceResult.rows[0].credits !== -1) {
          const currentBalance = userBalanceResult.rows[0].credits;
          const newBalance = currentBalance + creditsToRefund;

          // Refund credits
          await getDbPool().query('UPDATE users SET credits = $1 WHERE id = $2', [newBalance, userId]);

          // Log refund transaction
          await getDbPool().query(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [userId, creditsToRefund, newBalance, 'story_refund', jobId,
             `Refund: job cancelled by user (progress: ${progressPercent}%)`]
          );

          creditsRefunded = creditsToRefund;
          log.info(`💳 Refunded ${creditsToRefund} credits for cancelled job ${jobId}`);
        }

        // Reset credits_reserved to prevent double refunds
        await getDbPool().query('UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1', [jobId]);
      }
    } catch (refundErr) {
      log.error(`❌ Failed to refund credits for cancelled job ${jobId}:`, refundErr.message);
    }

    // Mark job as failed (cancelled)
    await getDbPool().query(
      `UPDATE story_jobs
       SET status = 'failed',
           error_message = 'Cancelled by user',
           updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );

    log.debug(`🛑 Job ${jobId} cancelled by user ${req.user.username}`);

    res.json({
      success: true,
      message: 'Job cancelled successfully',
      jobId: jobId,
      creditsRefunded
    });
  } catch (err) {
    log.error('Error cancelling job:', err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// Get user's story jobs
router.get('/my-jobs', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    if (STORAGE_MODE === 'database') {
      const result = await getDbPool().query(
        `SELECT id, status, progress, progress_message, created_at, completed_at
         FROM story_jobs
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );

      res.json({ jobs: result.rows });
    } else {
      return res.status(503).json({ error: 'Background jobs require database mode' });
    }
  } catch (err) {
    log.error('Error fetching user jobs:', err);
    res.status(500).json({ error: 'Failed to fetch jobs' });
  }
});
// Get checkpoints for a job (for debugging/admin)
router.get('/:jobId/checkpoints', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    // Verify user owns this job or is admin
    const jobResult = await getDbPool().query(
      'SELECT user_id FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (jobResult.rows[0].user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const checkpoints = await deps.getAllCheckpoints(jobId);

    res.json({
      jobId,
      checkpoints: checkpoints.map(cp => ({
        stepName: cp.step_name,
        stepIndex: cp.step_index,
        createdAt: cp.created_at,
        // Don't include full step_data to avoid huge responses
        dataKeys: Object.keys(cp.step_data || {})
      }))
    });

  } catch (err) {
    log.error('Error getting checkpoints:', err);
    res.status(500).json({ error: 'Failed to get checkpoints: ' + err.message });
  }
});

// Get specific checkpoint data
router.get('/:jobId/checkpoints/:stepName', authenticateToken, async (req, res) => {
  try {
    const { jobId, stepName } = req.params;
    const stepIndex = parseInt(req.query.index) || 0;

    // Verify user owns this job or is admin
    const jobResult = await getDbPool().query(
      'SELECT user_id FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (jobResult.rows[0].user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const checkpoint = await deps.getCheckpoint(jobId, stepName, stepIndex);

    if (!checkpoint) {
      return res.status(404).json({ error: 'Checkpoint not found' });
    }

    res.json({
      jobId,
      stepName,
      stepIndex,
      data: checkpoint
    });

  } catch (err) {
    log.error('Error getting checkpoint:', err);
    res.status(500).json({ error: 'Failed to get checkpoint: ' + err.message });
  }
});


module.exports = { jobRoutes: router, initJobRoutes };
