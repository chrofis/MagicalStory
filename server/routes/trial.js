/**
 * Trial Routes - /api/trial/*
 *
 * Endpoints for the anonymous trial story flow:
 *   - Photo analysis (unauthenticated)
 *   - Story idea generation (unauthenticated)
 *   - Trial registration (email + Google)
 *   - Account claiming
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { log } = require('../utils/logger');

// Server.js-local dependencies received via initTrialRoutes()
let deps = {};

function initTrialRoutes(serverDeps) {
  deps = serverDeps;
}

// Rate limiters for unauthenticated trial endpoints
const trialPhotoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many photo uploads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const trialIdeasLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many idea generations. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const trialRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Task A: Trial Photo Analysis ────────────────────────────────────────────

/**
 * POST /api/trial/analyze-photo
 *
 * Analyze a photo via the Python Flask service (face detection, body crop, bg removal).
 * Same as the authenticated endpoint in avatars.js but does NOT save to the database.
 * Returns analysis results directly to the frontend.
 */
router.post('/analyze-photo', trialPhotoLimiter, async (req, res) => {
  try {
    const { imageData, selectedFaceId, cachedFaces } = req.body;

    if (!imageData) {
      log.debug('[TRIAL] [PHOTO] Missing imageData in request');
      return res.status(400).json({ error: 'Missing imageData' });
    }

    const imageSize = imageData.length;
    const imageType = imageData.substring(0, 30);
    log.debug(`[TRIAL] [PHOTO] Received image: ${imageSize} bytes, type: ${imageType}..., selectedFaceId: ${selectedFaceId}, cachedFaces: ${cachedFaces ? cachedFaces.length : 'none'}`);

    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`[TRIAL] [PHOTO] Calling Python service at: ${photoAnalyzerUrl}/analyze`);

    const startTime = Date.now();

    try {
      // Call Python service with optional selectedFaceId and cachedFaces
      // cachedFaces prevents re-detection (face IDs are unstable between calls)
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageData,
          selected_face_id: selectedFaceId !== undefined ? selectedFaceId : null,
          cached_faces: cachedFaces || null
        }),
        signal: AbortSignal.timeout(30000)
      });
      const analyzerData = await analyzerResponse.json();

      const duration = Date.now() - startTime;

      log.debug(`[TRIAL] [PHOTO] Analysis complete in ${duration}ms:`, {
        pythonSuccess: analyzerData.success,
        hasError: !!analyzerData.error,
        error: analyzerData.error || null,
        multipleFacesDetected: analyzerData.multiple_faces_detected,
        faceCount: analyzerData.face_count,
        hasFaceThumbnail: !!analyzerData.faceThumbnail || !!analyzerData.face_thumbnail,
        hasBodyCrop: !!analyzerData.bodyCrop || !!analyzerData.body_crop,
        hasBodyNoBg: !!analyzerData.bodyNoBg || !!analyzerData.body_no_bg,
        traceback: analyzerData.traceback ? analyzerData.traceback.substring(0, 500) : null
      });

      if (!analyzerData.success) {
        if (analyzerData.error === 'no_face_detected') {
          log.warn('[TRIAL] [PHOTO] No face detected in photo');
          return res.json({
            success: false,
            error: 'no_face_detected'
          });
        }
        log.error('[TRIAL] [PHOTO] Python analysis failed:', analyzerData.error, analyzerData.traceback);
        return res.status(500).json({
          error: 'Photo analysis failed',
          details: analyzerData.error || 'Unknown error',
          traceback: analyzerData.traceback
        });
      }

      // Handle multi-face response - return faces for selection
      if (analyzerData.multiple_faces_detected && analyzerData.faces) {
        log.info(`[TRIAL] [PHOTO] Multiple faces detected (${analyzerData.face_count}), returning for selection`);

        // Convert faces to camelCase (handle both old snake_case and new camelCase from Python)
        const faces = analyzerData.faces.map(face => ({
          id: face.id,
          confidence: face.confidence,
          faceBox: face.faceBox || face.face_box,
          thumbnail: face.thumbnail
        }));

        // Build cachedFaces in the flat format Python expects internally
        // (x, y, width, height at top level, not nested under faceBox)
        const cachedFaces = analyzerData.faces.map(face => ({
          id: face.id,
          confidence: face.confidence,
          x: face.faceBox?.x ?? face.face_box?.x ?? face.x,
          y: face.faceBox?.y ?? face.face_box?.y ?? face.y,
          width: face.faceBox?.width ?? face.face_box?.width ?? face.width,
          height: face.faceBox?.height ?? face.face_box?.height ?? face.height,
        }));

        return res.json({
          success: true,
          multipleFacesDetected: true,
          faceCount: analyzerData.face_count,
          faces: faces,
          cachedFaces
        });
      }

      // Single face or face selected - return analysis results directly (no DB save)
      const faceThumbnail = analyzerData.face_thumbnail || analyzerData.faceThumbnail;
      const bodyCrop = analyzerData.body_crop || analyzerData.bodyCrop;
      const bodyNoBg = analyzerData.body_no_bg || analyzerData.bodyNoBg;

      const response = {
        success: analyzerData.success,
        multipleFacesDetected: false,
        faceCount: analyzerData.face_count,
        selectedFaceId: analyzerData.selected_face_id,
        faceThumbnail: faceThumbnail,
        bodyCrop: bodyCrop,
        bodyNoBg: bodyNoBg,
        faceBox: analyzerData.face_box || analyzerData.faceBox,
        bodyBox: analyzerData.body_box || analyzerData.bodyBox
      };

      log.debug('[TRIAL] [PHOTO] Sending response (face/body detection)');
      res.json(response);

    } catch (fetchErr) {
      log.error('[TRIAL] Photo analyzer service error:', fetchErr.message);

      if (fetchErr.cause?.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'Photo analysis service unavailable',
          details: 'The photo analysis service is not running. Please contact support.',
          fallback: true
        });
      }

      throw fetchErr;
    }

  } catch (err) {
    log.error('[TRIAL] Error analyzing photo:', err);
    res.status(500).json({
      error: 'Failed to analyze photo',
      details: err.message,
      fallback: true
    });
  }
});

// ─── Task B: Trial Idea Generation (Streaming) ──────────────────────────────

/**
 * POST /api/trial/generate-ideas-stream
 *
 * SSE streaming endpoint for story idea generation in the trial flow.
 * Uses the same parallel streaming pattern as the authenticated endpoint
 * in storyIdeas.js but with simplified params (no location, no landmarks,
 * languageLevel='standard') and no auth required.
 */
router.post('/generate-ideas-stream', trialIdeasLimiter, async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  try {
    const { storyCategory, storyTopic, storyTheme, language, characters } = req.body;

    log.debug(`[TRIAL] [STREAM] Generating story ideas (unauthenticated)`);
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme}, Language: ${language}`);

    const { callTextModelStreaming } = require('../lib/textModels');
    const { getLanguageInstruction } = require('../lib/languages');
    const modelToUse = 'claude-haiku';

    log.debug(`  Using model: ${modelToUse}`);

    // Build a simple character description
    const mainChar = characters?.[0];
    const charDesc = mainChar
      ? `${mainChar.name}${mainChar.age ? `, ${mainChar.age} years old` : ''}${mainChar.gender ? `, ${mainChar.gender}` : ''}${mainChar.traits?.length ? ` (${mainChar.traits.join(', ')})` : ''}`
      : 'a child';

    // Determine category context
    let categoryContext = '';
    if (storyCategory === 'life-challenge') {
      categoryContext = `This is a life skills story about "${storyTopic}". The story should help children understand and cope with this topic.${storyTheme && storyTheme !== 'realistic' ? ` Set in a ${storyTheme} adventure context.` : ''}`;
    } else if (storyCategory === 'historical') {
      categoryContext = `This is a historical story about "${storyTopic}". Keep it age-appropriate and educational.`;
    } else {
      categoryContext = `This is a ${storyTheme || 'adventure'} story${storyTopic ? ` about "${storyTopic}"` : ''}. Make it exciting and appropriate for children.`;
    }

    const langInstruction = getLanguageInstruction(language);

    // Minimal prompt — just title + short summary
    const buildTrialPrompt = (variant) => `Generate a children's story idea for a SHORT 5-scene story. Character: ${charDesc}. ${categoryContext} ${variant}

Keep the plot simple: one clear conflict, one resolution. No subplots.

Plain text only, no markdown. Line 1: title. Then a 100-200 word story summary describing the plot arc.
${langInstruction} Write EVERYTHING in that language.`;

    const prompt1 = buildTrialPrompt('Make it engaging and fun.');
    const prompt2 = buildTrialPrompt('Create a DIFFERENT story — different setting, different conflict.');

    // Send initial event
    res.write(`data: ${JSON.stringify({ status: 'generating', model: modelToUse })}\n\n`);

    // Track state for both stories
    let fullResponse1 = '';
    let fullResponse2 = '';
    let lastStory1Length = 0;
    let lastStory2Length = 0;
    let story1Started = false;
    let story2Started = false;

    log.debug('  Starting parallel story generation...');

    // Stream Story 1 (500 max tokens — title + 100-200 word summary)
    const streamStory1 = callTextModelStreaming(prompt1, 500, (delta, fullText) => {
      fullResponse1 = fullText;
      if (fullText.length > 30 && fullText.length > lastStory1Length + 30) {
        res.write(`data: ${JSON.stringify({ story1: fullText.trim() })}\n\n`);
        lastStory1Length = fullText.length;
        if (!story1Started) {
          log.debug('  Story 1 streaming started');
          story1Started = true;
        }
      }
    }, modelToUse).then(() => {
      const finalContent = fullResponse1.trim();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ story1: finalContent, isFinal: true })}\n\n`);
        log.debug(`  Story 1 final (${finalContent.length} chars)`);
      }
    }).catch(err => {
      log.error('  Story 1 generation failed:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate first story idea' })}\n\n`);
    });

    // Stream Story 2 (500 max tokens — title + 100-200 word summary)
    const streamStory2 = callTextModelStreaming(prompt2, 500, (delta, fullText) => {
      fullResponse2 = fullText;
      if (fullText.length > 30 && fullText.length > lastStory2Length + 30) {
        res.write(`data: ${JSON.stringify({ story2: fullText.trim() })}\n\n`);
        lastStory2Length = fullText.length;
        if (!story2Started) {
          log.debug('  Story 2 streaming started');
          story2Started = true;
        }
      }
    }, modelToUse).then(() => {
      const finalContent = fullResponse2.trim();
      if (finalContent) {
        res.write(`data: ${JSON.stringify({ story2: finalContent, isFinal: true })}\n\n`);
        log.debug(`  Story 2 final (${finalContent.length} chars)`);
      }
    }).catch(err => {
      log.error('  Story 2 generation failed:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to generate second story idea' })}\n\n`);
    });

    // Wait for both to complete
    await Promise.all([streamStory1, streamStory2]);
    log.debug('  Both stories complete, sending done event...');

    // Send completion event
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    log.debug('  Done event sent, closing stream');
    // Small delay before closing to let HTTP/2 proxy flush the final event
    await new Promise(resolve => setTimeout(resolve, 500));
    res.end();

  } catch (err) {
    log.error('[TRIAL] Generate ideas stream error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message || 'Failed to generate story ideas' })}\n\n`);
    res.end();
  }
});

// ─── Helper: Save trial character to DB ─────────────────────────────────────

/**
 * Create a character record from trial data.
 * Matches the existing characters table schema (id, user_id, data, metadata).
 *
 * @param {Pool} pool - Database connection pool
 * @param {string} userId - User ID
 * @param {object} characterData - { name, age, gender, traits, photos }
 * @returns {string} characterId
 */
async function saveTrialCharacter(pool, userId, characterData) {
  const characterId = `characters_${userId}`;

  // Build the character object matching the format used by characters.js
  const charId = Date.now();
  const character = {
    id: charId,
    name: characterData.name || 'Child',
    age: characterData.age || '',
    gender: characterData.gender || '',
    traits: characterData.traits || [],
    role: 'main',
    isMainCharacter: true,
    photos: characterData.photos || {},
    // Photos stored as top-level fields too (used by story pipeline)
    photoUrl: characterData.photos?.face || null,
    bodyPhotoUrl: characterData.photos?.body || null,
    bodyNoBgUrl: characterData.photos?.bodyNoBg || null,
  };

  const data = {
    characters: [character],
    relationships: {},
  };

  // Lightweight metadata for list queries (strip heavy base64 photos)
  const metadata = {
    characters: [{
      name: character.name,
      age: character.age,
      gender: character.gender,
      traits: character.traits,
      role: character.role,
    }],
    relationships: {},
  };

  await pool.query(
    `INSERT INTO characters (id, user_id, data, metadata, created_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       data = EXCLUDED.data,
       metadata = EXCLUDED.metadata,
       created_at = CURRENT_TIMESTAMP`,
    [characterId, userId, JSON.stringify(data), JSON.stringify(metadata)]
  );

  log.debug(`[TRIAL] Saved character for user ${userId}: ${character.name}`);
  return { characterId, charId };
}

/**
 * Create a story job for a trial user.
 * Matches the existing story_jobs schema from jobs.js.
 *
 * @param {Pool} pool - Database connection pool
 * @param {string} userId - User ID
 * @param {string} characterId - Character record ID
 * @param {object} characterData - { name, age, gender, traits, photos }
 * @param {object} storyInput - { storyCategory, storyTopic, storyTheme, storyDetails, language }
 * @returns {string} jobId
 */
async function createTrialStoryJob(pool, userId, characterId, characterData, storyInput) {
  const pages = 10;

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Build character object for inputData (stripped version - full data loaded from DB during processing)
  const trialCharacter = {
    id: characterData._charId,
    name: characterData.name || 'Child',
    age: characterData.age || '',
    gender: characterData.gender || '',
    traits: characterData.traits || [],
    role: 'main',
    isMainCharacter: true,
    photoUrl: characterData.photos?.face || null,
    bodyPhotoUrl: characterData.photos?.body || null,
    bodyNoBgUrl: characterData.photos?.bodyNoBg || null,
  };

  // Build input_data matching the format expected by processStoryJob
  const inputData = {
    pages,
    language: storyInput.language || 'English',
    languageLevel: 'standard',
    artStyle: 'anime',
    storyCategory: storyInput.storyCategory || '',
    storyTopic: storyInput.storyTopic || '',
    storyTheme: storyInput.storyTheme || '',
    storyDetails: storyInput.storyDetails || '',
    characterId,
    characters: [trialCharacter],
    mainCharacters: [trialCharacter.id],
    skipCovers: true, // Trial stories don't generate covers
    enableFullRepair: false, // No repair workflow for trial stories
    skipQualityEval: true, // Skip quality evaluation to save cost
    trialMode: true, // Use lightweight story prompt
  };

  // Trial stories are free — no credit deduction
  await pool.query(
    `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...', 0]
  );

  log.debug(`[TRIAL] Created story job ${jobId} for user ${userId} (free trial, no credits reserved)`);
  return jobId;
}

// ─── Task C: Trial Registration (Email) ─────────────────────────────────────

/**
 * POST /api/trial/register-email
 *
 * Register a trial user via email. Creates an unverified user account,
 * stores trial data (character + story input), and sends a verification email.
 * Story generation starts only after email verification (handled by Task 1D).
 */
router.post('/register-email', trialRegisterLimiter, async (req, res) => {
  try {
    const { email, characterData, storyInput } = req.body;

    // Validate required fields
    if (!email || !characterData || !storyInput) {
      return res.status(400).json({ error: 'Email, character data, and story input are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.toLowerCase().trim();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Guard against oversized payloads (base64 photos can be large)
    const trialDataStr = JSON.stringify({ characterData, storyInput });
    if (trialDataStr.length > 10 * 1024 * 1024) {
      return res.status(413).json({ error: 'Trial data too large' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Check if email already exists (check both email and username columns, since username=email)
    const existing = await pool.query(
      'SELECT id, is_trial, email_verified, role FROM users WHERE email = $1 OR username = $1',
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];

      // Non-trial user already exists → tell them to log in
      if (!existingUser.is_trial) {
        return res.status(409).json({
          error: 'Account already exists, please log in',
          code: 'ACCOUNT_EXISTS',
        });
      }

      // Trial user, already verified → trial already used
      if (existingUser.email_verified === true) {
        return res.status(409).json({
          error: 'Trial already used',
          code: 'TRIAL_USED',
        });
      }

      // Trial user, not yet verified → update their trial_data and resend verification
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

      await pool.query(
        `UPDATE users SET
           trial_data = $1,
           email_verification_token = $2,
           email_verification_expires = $3
         WHERE id = $4`,
        [
          JSON.stringify({ characterData, storyInput }),
          verificationToken,
          verificationExpires,
          existingUser.id,
        ]
      );

      // Send verification email
      const emailService = require('../../email');
      const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
      const language = storyInput.language || 'English';
      await emailService.sendEmailVerificationEmail(normalizedEmail, characterData.name || normalizedEmail, verifyUrl, language);

      log.info(`[TRIAL] Resent verification email to existing trial user: ${normalizedEmail}`);
      return res.json({ success: true, message: 'Verification email sent' });
    }

    // ── New trial user ──────────────────────────────────────────────────────

    const userId = crypto.randomUUID();
    const username = normalizedEmail; // username = email, matching auth.js pattern
    const displayName = characterData.name || normalizedEmail.split('@')[0];

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Generate a random password (trial users don't need to log in with password)
    const bcrypt = require('bcryptjs');
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    // Trial users start with 0 credits — trial story is free, full credits given on claim
    await pool.query(
      `INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits, email_verified, is_trial, trial_data, email_verification_token, email_verification_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        userId,
        username,
        normalizedEmail,
        hashedPassword,
        'user',
        1,  // trial users get 1 story
        0,
        0,  // no credits needed — trial story is free
        false,
        true, // is_trial
        JSON.stringify({ characterData, storyInput }),
        verificationToken,
        verificationExpires,
      ]
    );

    // Send verification email
    const emailService = require('../../email');
    const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
    const language = storyInput.language || 'English';
    const emailResult = await emailService.sendEmailVerificationEmail(normalizedEmail, displayName, verifyUrl, language);

    if (!emailResult.success) {
      log.error(`[TRIAL] Failed to send verification email to ${normalizedEmail}:`, emailResult.error);
      // User was created but email failed - still return success so they can retry
    }

    // Verify the token was actually stored
    const verifyInsert = await pool.query('SELECT email_verification_token FROM users WHERE id = $1', [userId]);
    const storedToken = verifyInsert.rows[0]?.email_verification_token;
    log.info(`[TRIAL] New trial user registered: ${normalizedEmail} (id: ${userId}, token stored: ${storedToken ? storedToken.substring(0, 8) + '...' : 'NULL!'})`);
    res.json({ success: true, message: 'Verification email sent' });

  } catch (err) {
    log.error('[TRIAL] register-email error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── Task D: Trial Registration (Google) ─────────────────────────────────────

/**
 * POST /api/trial/register-google
 *
 * Register a trial user via Google (Firebase). Since Google has already verified
 * the email, we can immediately create the user, save character data, create the
 * story job, and return a JWT token for polling.
 */
router.post('/register-google', trialRegisterLimiter, async (req, res) => {
  try {
    const { idToken, characterData, storyInput } = req.body;

    if (!idToken || !characterData || !storyInput) {
      return res.status(400).json({ error: 'ID token, character data, and story input are required' });
    }

    // Verify Firebase token (same pattern as auth.js)
    let firebaseAdmin = null;
    try {
      firebaseAdmin = require('firebase-admin');
    } catch (e) {
      // Firebase not available
    }

    if (!firebaseAdmin || !firebaseAdmin.apps.length) {
      return res.status(500).json({ error: 'Firebase authentication not configured on server' });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
    const { email: firebaseEmail } = decodedToken;

    if (!firebaseEmail) {
      return res.status(400).json({ error: 'Google account must have an email address' });
    }

    const normalizedEmail = firebaseEmail.toLowerCase();

    const { getPool } = require('../services/database');
    const { generateToken } = require('../middleware/auth');
    const pool = getPool();

    // Check if email already exists
    const existing = await pool.query(
      'SELECT id, is_trial, email_verified, role FROM users WHERE email = $1 OR username = $1',
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];

      // Non-trial user already exists
      if (!existingUser.is_trial) {
        return res.status(409).json({
          error: 'Account already exists, please log in',
          code: 'ACCOUNT_EXISTS',
        });
      }

      // Trial user, already verified
      if (existingUser.email_verified === true) {
        return res.status(409).json({
          error: 'Trial already used',
          code: 'TRIAL_USED',
        });
      }

      // Existing unverified trial user with Google → verify them and proceed
      await pool.query(
        `UPDATE users SET
           email_verified = TRUE,
           trial_data = $1
         WHERE id = $2`,
        [JSON.stringify({ characterData, storyInput }), existingUser.id]
      );

      // Save character and create job using existing user
      const { characterId, charId } = await saveTrialCharacter(pool, existingUser.id, characterData);
      characterData._charId = charId;
      const jobId = await createTrialStoryJob(pool, existingUser.id, characterId, characterData, storyInput);

      // Fetch full user for token generation
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [existingUser.id]);
      const user = userResult.rows[0];
      const token = generateToken(user);

      // Start job processing
      if (deps.processStoryJob) {
        deps.processStoryJob(jobId).catch(err => {
          log.error(`[TRIAL] Job ${jobId} processing failed:`, err);
        });
      }

      log.info(`[TRIAL] Google registration completed for existing trial user: ${normalizedEmail}`);
      return res.json({ success: true, jobId, token });
    }

    // ── New trial user via Google ───────────────────────────────────────────

    const userId = crypto.randomUUID();
    const username = normalizedEmail;

    // Google users don't need a real password
    const bcrypt = require('bcryptjs');
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    // Trial users start with 0 credits — trial story is free, full credits given on claim
    const result = await pool.query(
      `INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits, email_verified, is_trial, trial_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        userId,
        username,
        normalizedEmail,
        hashedPassword,
        'user',
        1,
        0,
        0,  // no credits needed — trial story is free
        true,  // Google-verified
        true,  // is_trial
        JSON.stringify({ characterData, storyInput }),
      ]
    );
    const newUser = result.rows[0];

    // Save character to characters table
    const { characterId, charId } = await saveTrialCharacter(pool, userId, characterData);
    characterData._charId = charId;

    // Create story job
    const jobId = await createTrialStoryJob(pool, userId, characterId, characterData, storyInput);

    // Generate JWT so frontend can poll job status
    const token = generateToken(newUser);

    // Start processing the job asynchronously (if init'd with processStoryJob)
    if (deps.processStoryJob) {
      deps.processStoryJob(jobId).catch(err => {
        log.error(`[TRIAL] Job ${jobId} failed:`, err);
      });
    } else {
      log.warn(`[TRIAL] processStoryJob not available - job ${jobId} created but not started`);
    }

    log.info(`[TRIAL] New Google trial user registered: ${normalizedEmail} (id: ${userId}, job: ${jobId})`);
    res.json({ success: true, jobId, token });

  } catch (err) {
    log.error('[TRIAL] register-google error:', err);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── Task E: Account Claim Endpoints ─────────────────────────────────────────

/**
 * Trigger background avatar generation for a user's characters that have photos but no avatars.
 * Called after account claim to give trial-turned-real users proper avatars/thumbnails.
 */
async function triggerAvatarGenerationForUser(userId) {
  try {
    const { dbQuery } = require('../services/database');
    const { getFacePhoto } = require('../lib/characterPhotos');
    const { avatarJobs, processAvatarJobInBackground } = require('./avatars');

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      log.warn('[TRIAL] No GEMINI_API_KEY - skipping avatar generation on claim');
      return;
    }

    // Load user's character data
    const rows = await dbQuery(
      'SELECT id, data FROM characters WHERE user_id = $1',
      [userId]
    );
    if (!rows || rows.length === 0) {
      log.debug('[TRIAL] No characters found for claimed user - skipping avatar generation');
      return;
    }

    const charData = rows[0].data || {};
    const characters = charData.characters || [];

    for (const char of characters) {
      // Skip characters that already have avatars
      const avatars = char.avatars;
      if (avatars?.standard || avatars?.winter || avatars?.summer || avatars?.hasFullAvatars) {
        log.debug(`[TRIAL] Character ${char.name} already has avatars - skipping`);
        continue;
      }

      // Get face photo for avatar generation
      const facePhoto = getFacePhoto(char);
      if (!facePhoto) {
        log.debug(`[TRIAL] Character ${char.name} has no photo - skipping avatar generation`);
        continue;
      }

      // Create a background avatar job
      const jobId = `avatar_claim_${crypto.randomBytes(8).toString('hex')}`;
      avatarJobs.set(jobId, {
        userId,
        characterId: char.id,
        characterName: char.name,
        status: 'pending',
        progress: 0,
        message: 'Starting avatar generation (account claim)...',
        createdAt: Date.now(),
        result: null,
        error: null,
      });

      const bodyParams = {
        characterId: char.id,
        facePhoto,
        name: char.name,
        age: char.age || '',
        gender: char.gender || '',
      };

      const user = { id: userId };

      log.info(`[TRIAL] Triggering background avatar generation for ${char.name} (job: ${jobId})`);
      processAvatarJobInBackground(jobId, bodyParams, user, geminiApiKey).catch(err => {
        log.error(`[TRIAL] Avatar generation failed for ${char.name}: ${err.message}`);
        const job = avatarJobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = err.message;
        }
      });
    }
  } catch (err) {
    // Non-fatal - account claim should succeed even if avatar generation fails
    log.error('[TRIAL] Error triggering avatar generation on claim:', err.message);
  }
}

const trialClaimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many claim attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/trial/claim/:token
 *
 * Validate a claim token and return user info for the claim page.
 * The frontend uses this to show the user's email and let them set a password.
 */
router.get('/claim/:token', trialClaimLimiter, async (req, res) => {
  try {
    const { token } = req.params;

    if (!token || token.length < 32) {
      return res.status(400).json({ error: 'Invalid claim token' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    const result = await pool.query(
      'SELECT email, username FROM users WHERE claim_token = $1 AND claim_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired claim link' });
    }

    const user = result.rows[0];
    res.json({
      email: user.email,
      username: user.username,
    });
  } catch (err) {
    log.error('[TRIAL] claim GET error:', err);
    res.status(500).json({ error: 'Failed to validate claim token' });
  }
});

/**
 * POST /api/trial/claim/:token
 *
 * Set a password and convert the trial account to a full account.
 * Returns a JWT token so the user is immediately logged in.
 */
router.post('/claim/:token', trialClaimLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!token || token.length < 32) {
      return res.status(400).json({ error: 'Invalid claim token' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const { getPool } = require('../services/database');
    const { generateToken } = require('../middleware/auth');
    const bcrypt = require('bcryptjs');
    const pool = getPool();

    // Look up user by claim token (must not be expired)
    const result = await pool.query(
      'SELECT id, email, username, role, credits, story_quota, stories_generated FROM users WHERE claim_token = $1 AND claim_token_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired claim link' });
    }

    const user = result.rows[0];

    // Hash the new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Convert trial account to full account with standard credits (500)
    const { CREDIT_CONFIG } = require('../config/credits');
    const fullCredits = CREDIT_CONFIG.LIMITS.INITIAL_USER; // 500
    await pool.query(
      `UPDATE users SET
         password = $1,
         is_trial = FALSE,
         credits = $2,
         claim_token = NULL,
         claim_token_expires = NULL
       WHERE id = $3`,
      [hashedPassword, fullCredits, user.id]
    );

    // Create credit transaction for the upgrade
    await pool.query(
      'INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description) VALUES ($1, $2, $3, $4, $5)',
      [user.id, fullCredits, fullCredits, 'initial', 'Welcome credits for claimed account']
    );

    // Generate JWT so user is immediately logged in
    const jwtToken = generateToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      email_verified: true, // Trial users verified their email already
    });

    log.info(`[TRIAL] Account claimed via password: ${user.email}`);

    // Trigger background avatar generation for trial characters (non-blocking)
    triggerAvatarGenerationForUser(user.id);

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: fullCredits,
        storyQuota: user.story_quota !== undefined ? user.story_quota : 1,
        storiesGenerated: user.stories_generated || 0,
        emailVerified: true,
      },
    });
  } catch (err) {
    log.error('[TRIAL] claim POST error:', err);
    res.status(500).json({ error: 'Failed to claim account' });
  }
});

/**
 * POST /api/trial/claim-google
 *
 * Link a Google account to the trial account via claim token.
 * Verifies the Firebase ID token and checks that the claim token matches
 * and the email matches the Google email.
 */
router.post('/claim-google', trialClaimLimiter, async (req, res) => {
  try {
    const { idToken, claimToken } = req.body;

    if (!idToken || !claimToken) {
      return res.status(400).json({ error: 'ID token and claim token are required' });
    }

    // Verify Firebase token
    let firebaseAdmin = null;
    try {
      firebaseAdmin = require('firebase-admin');
    } catch (e) {
      // Firebase not available
    }

    if (!firebaseAdmin || !firebaseAdmin.apps.length) {
      return res.status(500).json({ error: 'Firebase authentication not configured on server' });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
    const { uid: firebaseUid, email: firebaseEmail } = decodedToken;

    if (!firebaseEmail) {
      return res.status(400).json({ error: 'Google account must have an email address' });
    }

    const { getPool } = require('../services/database');
    const { generateToken } = require('../middleware/auth');
    const pool = getPool();

    // Look up user by claim token (must not be expired)
    const result = await pool.query(
      'SELECT id, email, username, role, credits, story_quota, stories_generated FROM users WHERE claim_token = $1 AND claim_token_expires > NOW()',
      [claimToken]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired claim link' });
    }

    const user = result.rows[0];

    // Verify the Google email matches the trial account email
    if (user.email.toLowerCase() !== firebaseEmail.toLowerCase()) {
      return res.status(400).json({
        error: 'Google account email does not match the trial account email',
      });
    }

    // Link Google account and convert trial to full account with standard credits (500)
    const { CREDIT_CONFIG } = require('../config/credits');
    const fullCredits = CREDIT_CONFIG.LIMITS.INITIAL_USER; // 500
    await pool.query(
      `UPDATE users SET
         firebase_uid = $1,
         is_trial = FALSE,
         credits = $2,
         claim_token = NULL,
         claim_token_expires = NULL
       WHERE id = $3`,
      [firebaseUid, fullCredits, user.id]
    );

    // Create credit transaction for the upgrade
    await pool.query(
      'INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description) VALUES ($1, $2, $3, $4, $5)',
      [user.id, fullCredits, fullCredits, 'initial', 'Welcome credits for claimed account']
    );

    // Generate JWT
    const jwtToken = generateToken({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      email_verified: true,
    });

    log.info(`[TRIAL] Account claimed via Google: ${user.email}`);

    // Trigger background avatar generation for trial characters (non-blocking)
    triggerAvatarGenerationForUser(user.id);

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: fullCredits,
        storyQuota: user.story_quota !== undefined ? user.story_quota : 1,
        storiesGenerated: user.stories_generated || 0,
        emailVerified: true,
      },
    });
  } catch (err) {
    log.error('[TRIAL] claim-google error:', err);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    res.status(500).json({ error: 'Failed to claim account' });
  }
});

module.exports = router;
module.exports.initTrialRoutes = initTrialRoutes;
module.exports.saveTrialCharacter = saveTrialCharacter;
module.exports.createTrialStoryJob = createTrialStoryJob;
