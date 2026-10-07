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
const crypto = require('crypto');
const { log } = require('../utils/logger');
const { getPool, withTransaction, offloadJsonbImages, inlineOffloadPrefix } = require('../services/database');
const email = require('../../email');
const { normalizeCharacterName } = require('../lib/characterName');
const { CHARACTERS_MAX, TOO_MANY_CHARACTERS } = require('../lib/requestGuards');
const { settleJobWithRefund, JOB_SAVING_PROGRESS } = require('../lib/jobCredits');

function getDbPool() { return getPool(); }

// STORAGE_MODE from environment
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' && process.env.DATABASE_URL)
  ? 'database' : 'file';

// Server.js-local dependencies received via init()
let deps = {};

function initJobRoutes(serverDeps) {
  deps = serverDeps;
}

// Clean up old completed jobs and their checkpoints.
// FAILED/CANCELLED jobs and their checkpoints are NEVER auto-deleted (owner
// 2026-08-23): they are the only forensic record of what a dead run produced,
// 99% of stories succeed so the residue is tiny, and the 1-hour purge once
// covered up that checkpoints weren't being written at all. They are also
// salvaged into a partial story here. Completed jobs already deleted their
// checkpoints at finalize; the 1-hour row cleanup below only catches strays.
async function cleanupOldCompletedJobs() {
  if (STORAGE_MODE !== 'database') return;
  const pool = getDbPool();
  if (!pool) return;

  try {
    // Salvage before any checkpoint of a dead job can age out: rebuild a
    // partial story from whatever the run left behind. Idempotent — the
    // partial-save skips stories that already have a full save, and jobs
    // whose checkpoints were already salvaged+deleted simply match nothing.
    if (typeof deps.savePartialStoryFromCheckpoints === 'function') {
      const dead = await pool.query(`
        SELECT DISTINCT j.id FROM story_jobs j
        JOIN story_job_checkpoints c ON c.job_id = j.id
        WHERE j.status IN ('failed', 'cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM stories s
            WHERE s.id = j.id AND COALESCE(s.data->>'title', '') <> ''
          )
      `);
      for (const row of dead.rows) {
        try {
          await deps.savePartialStoryFromCheckpoints(row.id, 'Salvaged from checkpoints before cleanup');
        } catch (err) {
          log.warn(`🛟 Checkpoint salvage failed for ${row.id}: ${err.message}`);
        }
      }
    }

    const cpResult = await pool.query(`
      DELETE FROM story_job_checkpoints
      WHERE job_id IN (
        SELECT id FROM story_jobs
        WHERE status = 'completed' AND updated_at < NOW() - INTERVAL '1 hour'
      )
    `);

    const jobResult = await pool.query(`
      DELETE FROM story_jobs
      WHERE status = 'completed' AND updated_at < NOW() - INTERVAL '1 hour'
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

    // A story is starting. Its first minutes are Claude calls for outline and
    // text — nothing touches the analyzer until page images exist — so this is
    // the ideal runway to load the models.
    // Fire-and-forget: never let warming delay or fail story creation.
    //
    // face ONLY (2026-09-06). This used to take the default and spawn torch too,
    // then sessionBegin pinned it for the whole job — ~430MB resident through
    // 20-25 minutes in which nothing touches the analyzer at all. The first mask
    // call is in the repair phase, which force-warms torch itself
    // (storyJobPipeline.js). photos.js reasons the identical argument for the
    // upload path; it simply was not carried over to here.
    require('../lib/analyzerClient').ensureWarm('story-start', { workers: ['face'] });

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
    // The wizard sends whole character objects from client state, which can
    // still hold the raw "LUNA" the user typed; normalise here so the title,
    // avatar maps and clothing lookups all see one spelling.
    if (Array.isArray(inputData.characters)) {
      inputData.characters = inputData.characters.map(c => (c && typeof c.name === 'string' ? { ...c, name: normalizeCharacterName(c.name) } : c));
    }
    // At most CHARACTERS_MAX characters IN the story (the wizard sends only included ones).
    // Refused before credits are reserved; the cast, the avatar sheets and every scene brief scale with it.
    if (Array.isArray(inputData.characters) && inputData.characters.length > CHARACTERS_MAX) {
      log.warn(`🚫 [CREATE-STORY] ${req.user.username} sent ${inputData.characters.length} characters (max ${CHARACTERS_MAX})`);
      return res.status(400).json({
        error: `A story can have at most ${CHARACTERS_MAX} characters`,
        code: TOO_MANY_CHARACTERS,
        max: CHARACTERS_MAX,
      });
    }
    // Remove idempotencyKey from input_data as it's stored separately
    delete inputData.idempotencyKey;

    // A story generated while impersonating is an ADMIN DRAFT: it belongs to the
    // target user (the token's id IS theirs, so it lands in their library with
    // their characters) but stays invisible to them until an admin publishes it.
    // That is what lets one persistent account per family be reused — generate,
    // look, regenerate, publish only the good one — instead of a fresh dummy
    // account per attempt. Set AFTER the req.body spread so a client cannot
    // choose its own value.
    const isAdminDraft = req.user.impersonating === true;
    inputData.adminDraft = isAdminDraft;

    // This payload DID come from a request body, so it is never server-authored.
    // Forced here (after the spread, same reason as adminDraft above) so a
    // client cannot set the marker that exempts a job from the pipeline's
    // non-admin developer-field strip.
    inputData.serverAuthoredInput = false;

    // Characters must belong to the caller. The wizard sends whole character
    // objects from client state, and that state survives an account switch, so
    // `job_1786309527338_4zwhrn08y` was submitted under the smoke account
    // carrying another account's character ids — the story generated with five
    // strangers in it. Worse, those payloads carry thumbnail URLs that
    // characterPhotos.js will happily fetch as identity references, so an
    // unchecked payload is a cross-account image leak, not just a wrong book.
    // Refuse here, in the wizard, before credits are reserved and 30 minutes
    // are spent. Impersonation passes this naturally: req.user.id is the target.
    const requestedCharacterIds = (req.body.characters || []).map(c => c?.id).filter(v => v !== undefined && v !== null);
    if (requestedCharacterIds.length > 0 && STORAGE_MODE === 'database') {
      const ownRow = await getDbPool().query('SELECT data FROM characters WHERE id = $1', [`characters_${userId}`]);
      const ownData = ownRow.rows[0]?.data;
      const parsed = typeof ownData === 'string' ? JSON.parse(ownData) : ownData;
      const ownChars = Array.isArray(parsed) ? parsed : (parsed?.characters || []);
      // String comparison: a JSON round-trip can turn a numeric id into a
      // string, and that is type drift, not someone else's character.
      const ownIds = new Set(ownChars.map(c => String(c.id)));
      const foreign = requestedCharacterIds.filter(id => !ownIds.has(String(id)));
      if (foreign.length > 0) {
        log.warn(`🚫 [CREATE-STORY] ${req.user.username} requested character(s) ${foreign.join(', ')} that are not on their account${isAdminDraft ? ' (impersonating)' : ''}`);
        return res.status(403).json({
          error: 'Characters not found on this account',
          missingCharacterIds: foreign,
          message: 'Some selected characters do not belong to this account. Reload the page and pick the characters again.'
        });
      }
    }

    log.debug(`📝 Creating story job ${jobId} for user ${req.user.username}${idempotencyKey ? ` (idempotency: ${idempotencyKey})` : ''}`);
    log.debug(`📝 [JOB INPUT] pages: ${req.body.pages} → ${inputData.pages}${req.body.pages !== inputData.pages ? ' (clamped!)' : ''}, level: ${inputData.languageLevel}`);
    log.debug(`📝 [JOB INPUT] language: ${req.body.language} → ${inputData.language}`);
    log.debug(`📝 [JOB INPUT] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"${inputData.customThemeText ? `, customThemeText: "${inputData.customThemeText.substring(0, 100)}..."` : ''}`);
    if (inputData.ideaGeneration) {
      log.debug(`📝 [JOB INPUT] ideaGeneration: model=${inputData.ideaGeneration.model}, selectedIndex=${inputData.ideaGeneration.selectedIndex}, ideas=${inputData.ideaGeneration.output?.length || 0}`);
    }

    // The idea funnel's second half: WHICH of the two cards the customer clicked.
    // The pick is the buy vote the rating series was proxying for (owner,
    // 2026-09-21) — see server/lib/ideaEvents.js and migrations/039.
    // armIndex null means they wrote or pasted their own premise instead, which
    // is its own verdict on the pair, so the event is recorded either way as
    // long as ideas were actually offered.
    if (inputData.ideaGeneration || inputData.ideaPick) {
      const pick = inputData.ideaPick || null;
      const armIndex = pick ? pick.index : inputData.ideaGeneration?.selectedIndex;
      require('../lib/ideaEvents').recordIdeaEvent({
        event: 'idea_picked',
        userId,
        storyId: jobId,
        category: inputData.storyCategory,
        topic: inputData.storyTopic,
        theme: inputData.storyTheme,
        language: inputData.language,
        pages: inputData.pages,
        characters: inputData.characters,
        worldMode: pick?.worldMode,
        attempt: pick?.attempt,
        armIndex: armIndex === null || armIndex === undefined ? null : armIndex,
        worlds: pick?.world || inputData.ideaWorld || null,
        shapes: pick?.shape || null,
        model: inputData.ideaGeneration?.model,
        detail: { ideasOffered: inputData.ideaGeneration?.output?.length || 0 },
      });
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
            'SELECT id, username, email, preferred_language FROM users WHERE id = $1',
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

            const verifyUrl = `${process.env.FRONTEND_URL || process.env.BASE_URL || 'https://magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
            console.log(`📧 Attempting to send verification email to: ${user.email}`);
            const result = await email.sendEmailVerificationEmail(user.email, user.username, verifyUrl, user.preferred_language);
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

        // Two detectors (owner ruling 2026-09-04, evidence job_1788551692337_bc479p945):
        // 1. Heartbeat staleness (10 min) — the REAL stall detector. The worker
        //    arms a WHOLE-JOB 60s heartbeat for the lifetime of the job
        //    (startJobHeartbeat, server/lib/jobHeartbeat.js), so a dead or
        //    wedged process goes stale within minutes of dying while no live
        //    phase can ever be outside the heartbeat. Phase-local timers used
        //    to be the only writers and every silent phase between them killed
        //    healthy runs.
        // 2. Total age (180 min) — runaway BACKSTOP only. The old 60-min cap
        //    predated the beats pipeline and killed a healthy 18-page run at 89%;
        //    a legitimate run must never hit this, only a job that heartbeats
        //    forever without finishing.
        const TOTAL_TIMEOUT_MINUTES = 180;
        const HEARTBEAT_TIMEOUT_MINUTES = 10;

        const isStale = jobAgeMinutes > TOTAL_TIMEOUT_MINUTES ||
          minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES;

        if (isStale) {
          const reason = minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES ? 'no progress' : 'timeout';
          log.info(`🧹 Auto-cancelling stale job ${activeJob.id} (${reason}, age: ${Math.round(jobAgeMinutes)}min, last update: ${Math.round(minutesSinceUpdate)}min ago)`);

          // Fail + refund in one transaction (settleJobWithRefund): the refund and the
          // status flip commit together, and a job that finished meanwhile is untouched.
          // Mark as failed with appropriate message based on failure reason
          const errorMessage = minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES
            ? `Job stopped responding (no progress for ${Math.round(minutesSinceUpdate)} minutes)`
            : `Job timed out after ${Math.round(jobAgeMinutes)} minutes`;
          try {
            const settled = await settleJobWithRefund(getDbPool(), activeJob.id, {
              status: 'failed',
              errorMessage,
              statusIn: ['pending', 'processing'],
              describe: ({ progress }) => `Auto-refund: stale job timed out after ${Math.round(jobAgeMinutes)} min (progress: ${progress}%)`,
            });
            if (settled.refunded > 0) log.info(`💳 Auto-refunded ${settled.refunded} credits for stale job ${activeJob.id}`);
          } catch (refundErr) {
            log.error(`❌ Failed to fail/refund stale job ${activeJob.id}:`, refundErr.message);
          }
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

      // Skip credit check for unlimited credits (-1), admins, and admin drafts.
      // A draft is generated FOR the user, not BY them — charging their balance
      // for attempts they never asked for is exactly what we do not want.
      if (userCredits !== -1 && req.user.role !== 'admin' && !isAdminDraft) {
        if (userCredits < creditsNeeded) {
          return res.status(402).json({
            error: 'Insufficient credits',
            creditsNeeded: creditsNeeded,
            creditsAvailable: userCredits,
            message: `This story requires ${creditsNeeded} credits (${pages} pages x ${CREDIT_CONFIG.COSTS.PER_PAGE} credits), but you only have ${userCredits} credits.`
          });
        }

        // (credit reservation happens inside the transaction below)
      }

      // Reserve credits (if applicable) + create the job row atomically. If the
      // job INSERT fails — e.g. a concurrent double-submit hits the idempotency
      // unique index — the whole transaction rolls back, so a debit can never
      // stick without a story_jobs row to refund it from later.
      // IRON RULE: no image bytes in JSONB. `inputData.characters` is the
      // client's wizard state — avatars, styled sheets, photos and the
      // `*Url` fields that have historically held data URIs — and it is
      // written verbatim. Measured 2026-09-21, this column held 40.9 MB of
      // base64 on staging. Offload before the INSERT, never after.
      await offloadJsonbImages(
        inlineOffloadPrefix('story_jobs', 'input_data', userId, jobId),
        `story_jobs.input_data/${jobId}`, inputData);

      let insufficientRace = false;
      let activeJobRace = null;
      try {
        await withTransaction(async (txClient) => {
          // One-job-at-a-time, atomically (review 2026-10-04 R3): the SELECT above and
          // this INSERT were separate statements, so two requests with different
          // idempotency keys both passed. A per-user advisory lock serialises them and
          // the re-check below sees the winner's committed row. (A partial unique index
          // was rejected: admin reruns legitimately run several jobs on one account.)
          await txClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`story_job_create:${userId}`]);
          const raced = await txClient.query(
            `SELECT id, status FROM story_jobs WHERE user_id = $1 AND status IN ('pending', 'processing') LIMIT 1`,
            [userId]
          );
          if (raced.rows.length > 0) {
            activeJobRace = raced.rows[0];
            throw new Error('ACTIVE_JOB_RACE');
          }
          if (userCredits !== -1 && req.user.role !== 'admin' && !isAdminDraft) {
            // The UPDATE only succeeds if credits >= creditsNeeded (no overdraw)
            const updateResult = await txClient.query(
              'UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits',
              [creditsNeeded, userId]
            );
            if (updateResult.rows.length === 0) {
              insufficientRace = true;
              throw new Error('INSUFFICIENT_CREDITS_RACE');
            }
            const newBalance = updateResult.rows[0].credits;
            await txClient.query(
              `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [userId, -creditsNeeded, newBalance, 'story_reserve', jobId, `Reserved ${creditsNeeded} credits for ${pages}-page story`]
            );
            log.debug(`💳 Reserved ${creditsNeeded} credits for job ${jobId} (user balance: ${userCredits} -> ${newBalance})`);
          }

          await txClient.query(
            `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...', (userCredits === -1 || req.user.role === 'admin' || isAdminDraft) ? 0 : creditsNeeded, idempotencyKey]
          );
        });
      } catch (txErr) {
        if (activeJobRace) {
          log.warn(`User ${req.user.username} raced a second create-story past the active-job check (active: ${activeJobRace.id})`);
          return res.status(409).json({
            error: 'Story generation already in progress',
            activeJobId: activeJobRace.id,
            activeJobStatus: activeJobRace.status,
            message: 'Please wait for your current story to finish before starting a new one.'
          });
        }
        if (insufficientRace) {
          return res.status(402).json({
            error: 'Insufficient credits',
            creditsNeeded: creditsNeeded,
            message: 'Credits were used by another request. Please try again.'
          });
        }
        // Job INSERT failed (rolled back with the debit). The most likely cause
        // is a concurrent submit with the same idempotency key → a job already
        // exists, so report it as a duplicate rather than a lost charge.
        log.error(`Failed to reserve credits / create job ${jobId} (rolled back): ${txErr.message}`);
        return res.status(409).json({ error: 'A story is already being generated for this request', code: 'DUPLICATE_JOB' });
      }

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

    // Bandwidth optimization: client may send ?knownPages=1,3,4 listing page numbers whose
    // images it already holds. We omit those pages' (large) base64 payloads from the response.
    // Absent/empty param => full payload (backward-compatible with older clients).
    const knownPages = new Set(
      String(req.query.knownPages || '')
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n))
    );

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

        // Two detectors (owner ruling 2026-09-04, evidence job_1788551692337_bc479p945):
        // 1. Heartbeat staleness (10 min) — the REAL stall detector; the worker's
        //    whole-job 60s heartbeat (startJobHeartbeat, server/lib/jobHeartbeat.js)
        //    runs for the lifetime of the job, so a dead process (crash, server
        //    restart, wedge) goes stale within minutes and a live one never does.
        // 2. Total age (180 min) — runaway BACKSTOP only. The old 60-min cap killed
        //    a healthy 18-page beats run at 89% while the pipeline kept working;
        //    the old 120-min 'abandoned' branch was the same age-based false kill.
        const TOTAL_TIMEOUT_MINUTES = 180;
        const HEARTBEAT_TIMEOUT_MINUTES = 10;

        let errorMessage = null;

        if (minutesSinceUpdate > HEARTBEAT_TIMEOUT_MINUTES) {
          // Job stopped making progress - something is stuck
          errorMessage = `Job stopped responding (no progress for ${Math.round(minutesSinceUpdate)} minutes) - please try again`;
          log.warn(`💔 [STATUS] Job ${jobId} heartbeat timeout: no progress for ${Math.round(minutesSinceUpdate)} minutes (last progress: ${job.progress}%)`);
        } else if (jobAgeMinutes > TOTAL_TIMEOUT_MINUTES) {
          // Job running too long overall
          errorMessage = `Job timed out after ${Math.round(jobAgeMinutes)} minutes - please try again`;
          log.warn(`⏰ [STATUS] Job ${jobId} total timeout: ${Math.round(jobAgeMinutes)} minutes`);
        }

        if (errorMessage) {
          // Same fail+refund transaction as every other failure path (was a bare status
          // write: the reservation stayed on the row and was deleted with it).
          const settled = await settleJobWithRefund(getDbPool(), jobId, {
            status: 'failed',
            errorMessage,
            statusIn: ['pending', 'processing'],
            describe: ({ progress }) => `Auto-refund: job timed out (progress: ${progress}%)`,
          });
          if (settled.refunded > 0) log.info(`💳 [STATUS] Auto-refunded ${settled.refunded} credits for timed-out job ${jobId}`);

          // Rescue whatever finished. Every OTHER path that declares a job dead
          // (worker throw, zombie recovery, stall sweeper) saves a [PARTIAL]
          // story from the checkpoints; this one did not, so a job killed here
          // left its completed pages stranded on disk and the user saw nothing
          // in their library. Never let the rescue break the status response.
          if (deps.savePartialStoryFromCheckpoints) {
            try {
              await deps.savePartialStoryFromCheckpoints(jobId, errorMessage);
            } catch (rescueErr) {
              log.warn(`[STATUS] partial rescue failed for ${jobId}: ${rescueErr.message}`);
            }
          }

          // Update local job object to return correct status
          job.status = 'failed';
          job.error_message = errorMessage;
        }
      }

      // Fetch user's current credits once the job is terminal: completed (the
      // final charge) and failed/cancelled (the refund). The wizard showed the
      // reserved amount as deducted from job creation on, so a failure that
      // carried no balance left the header stale under "your credits were not
      // charged" until the next full page load.
      let currentCredits = null;
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
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
        // Fetch partial pages (also for failed jobs to allow data recovery).
        // Pages the client already rendered (knownPages) are excluded IN SQL: a
        // partial_page checkpoint's step_index IS its pageNumber (both
        // saveCheckpoint call sites in storyJobPipeline.js pass page.pageNumber as
        // the index), so a known page's base64 is never read off disk, let alone
        // shipped to node, on every poll. Pages NOT in knownPages are returned
        // unchanged (full pageNumber/text/imageData).
        const partialPagesResult = await getDbPool().query(
          `SELECT step_index, step_data
           FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_page'
             AND NOT (step_index = ANY($2::int[]))
           ORDER BY step_index ASC`,
          [jobId, [...knownPages]]
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

    if (job.status === 'cancelled') {
      return res.json({ success: true, message: 'Job already cancelled', jobId, creditsRefunded: 0 });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return res.status(400).json({
        error: 'Job already finished',
        status: job.status,
        message: `Cannot cancel a job that is already ${job.status}`
      });
    }

    // Cancel + refund in ONE transaction, guarded on the job still running: a job that
    // finished (or is already saving its story: progress >= 99, see the saving marker in
    // processUnifiedStoryJob) is neither refunded nor flipped from 'completed' to
    // 'cancelled'. 'cancelled' is a distinct status so the pipeline's
    // checkCancellation() can tell a user cancel from a transient 'failed'.
    const settled = await settleJobWithRefund(getDbPool(), jobId, {
      status: 'cancelled',
      errorMessage: 'Cancelled by user',
      statusIn: ['pending', 'processing'],
      progressBelow: JOB_SAVING_PROGRESS,
      describe: ({ progress }) => `Refund: job cancelled by user (progress: ${progress}%)`,
    });
    if (!settled.changed) {
      return res.status(409).json({
        error: 'Job already finished',
        message: 'This story is already being saved or has finished and can no longer be cancelled'
      });
    }
    const creditsRefunded = settled.refunded;
    if (creditsRefunded > 0) log.info(`💳 Refunded ${creditsRefunded} credits for cancelled job ${jobId}`);

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
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

    if (STORAGE_MODE === 'database') {
      const pool = getDbPool();

      // Mark stale processing/pending jobs as failed before returning.
      // Without this, the client restores a stale job and shows a permanent spinner.
      // Key on updated_at (no heartbeat for 15 min = the worker died — OOM/crash/
      // restart), NOT created_at: a legitimately long job keeps bumping updated_at
      // via progress writes, so it's spared; a dead one stops writing and is caught
      // within minutes instead of the old 2-hour created_at window (which left
      // OOM-killed jobs spinning for hours). See sweepStaleJobs() for the proactive
      // server-side sweep — this per-request pass is the backstop.
      const staleJobs = await pool.query(
        `SELECT id FROM story_jobs
         WHERE user_id = $1
           AND status IN ('pending', 'processing')
           AND updated_at < NOW() - INTERVAL '15 minutes'`,
        [userId]
      );
      for (const stale of staleJobs.rows) {
        try {
          // Fail + refund in one transaction; the idle guard re-checks staleness on the
          // locked row so a job that just wrote progress is left alone.
          await settleJobWithRefund(pool, stale.id, {
            status: 'failed',
            errorMessage: 'Job stalled — no progress for 15 min (worker died: OOM/crash/restart)',
            statusIn: ['pending', 'processing'],
            idleForMinutes: 15,
            describe: ({ progress }) => `Auto-refund: stale job (progress ${progress}%)`,
          });
        } catch (staleErr) {
          log.error(`[MY-JOBS] stale-job settle failed for ${stale.id}: ${staleErr.message}`);
        }
      }

      const result = await pool.query(
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

    if (jobResult.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
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

    if (jobResult.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
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
