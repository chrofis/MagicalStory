# Trial Story Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow anonymous visitors to create one free story without logging in — upload a photo, pick a topic, choose from 2 ideas, then provide email (verified) or Google auth to start generation.

**Architecture:** New `/try` route with a simplified 3-step frontend wizard. New `server/routes/trial.js` backend with unauthenticated endpoints for photo analysis and idea generation (IP rate-limited), plus registration endpoints that create a user, save the character, and trigger story generation. Story completion email sends a PDF attachment + claim link.

**Tech Stack:** React + TypeScript (frontend), Express.js (backend), PostgreSQL, Resend (email), Firebase (Google auth), pdfkit (PDF generation)

---

## Overview of the Flow

```
Landing Page → "Try Free Story" → /try

Step 1: Upload photo + enter name, age, gender, traits (1 character)
Step 2: Pick story category + topic/theme
Step 3: See 2 generated ideas → pick one → click "Create My Story"
         → Popup modal:
           ├─ "Continue with Google" → auto-verified, job starts immediately
           └─ "Enter your email" → verification email sent → click link → job starts

Story generates in background → Email arrives with:
  - PDF of the story attached
  - Link to view online: /claim?token=xxx
  - "Set a password" prompt to keep their account
```

## Defaults (hardcoded for trial)

| Setting | Value | Notes |
|---------|-------|-------|
| Pages | 10 | Default |
| Art style | pixar | Default |
| Language level | standard | Default |
| Language | Browser language | `navigator.language` → map to supported |
| Location | None | Skipped |
| Season | None | Skipped |
| Dedication | None | Skipped |
| Characters | 1 (main) | No supporting characters |

## Database Changes

Add columns to `users` table:
- `is_trial` BOOLEAN DEFAULT FALSE — marks trial-created accounts
- `trial_data` JSONB DEFAULT NULL — stores character + story input until verified
- `claim_token` VARCHAR(64) DEFAULT NULL — token for account claim link
- `claim_token_expires` TIMESTAMP DEFAULT NULL

---

## Phase 1: Backend

### Task 1: Database migration — add trial columns

**Files:**
- Create: `scripts/admin/add-trial-columns.js`

**Step 1: Write migration script**

```javascript
// scripts/admin/add-trial-columns.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add trial columns to users table
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_data JSONB DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token VARCHAR(64) DEFAULT NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS claim_token_expires TIMESTAMP DEFAULT NULL;
    `);

    await client.query('COMMIT');
    console.log('Migration complete: trial columns added');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
```

**Step 2: Run migration**

```bash
node scripts/admin/add-trial-columns.js
```

**Step 3: Commit**

```bash
git add scripts/admin/add-trial-columns.js
git commit -m "feat(trial): add trial columns to users table"
```

---

### Task 2: Create trial routes file with rate limiters

**Files:**
- Create: `server/routes/trial.js`
- Modify: `server.js` (mount routes)

**Step 1: Create the route file skeleton with rate limiters**

```javascript
// server/routes/trial.js
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { getDbPool } = require('../db');
const { log } = require('../utils/logger');

// Rate limiters for unauthenticated trial endpoints
const trialPhotoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 photo analyses per IP per hour
  message: { error: 'Too many photo uploads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const trialIdeasLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 idea generations per IP per hour
  message: { error: 'Too many idea generations. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const trialRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 registrations per IP per hour
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Endpoints will be added in subsequent tasks

module.exports = router;
```

**Step 2: Mount in server.js**

Find where other routes are mounted (search for `app.use('/api/`)`) and add:

```javascript
const trialRoutes = require('./server/routes/trial');
app.use('/api/trial', trialRoutes);
```

**Step 3: Commit**

```bash
git add server/routes/trial.js server.js
git commit -m "feat(trial): create trial routes skeleton with rate limiters"
```

---

### Task 3: Trial photo analysis endpoint

**Files:**
- Modify: `server/routes/trial.js`

This endpoint calls the Python photo analyzer service but does NOT save to DB. Returns face/body data to the frontend to hold in state.

**Step 1: Add photo analysis endpoint**

The existing `POST /api/analyze-photo` in `server/routes/avatars.js` (line ~1875) calls the Python service AND saves to DB. We need to extract the Python service call portion.

Look at how `avatars.js` calls the Python service (the `fetch` to `PHOTO_ANALYZER_URL`). Replicate just that call:

```javascript
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

router.post('/analyze-photo', trialPhotoLimiter, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo provided' });
    }

    const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    // Forward to Python service for face detection
    const FormData = (await import('form-data')).default;
    const formData = new FormData();
    formData.append('photo', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    const response = await fetch(`${PHOTO_ANALYZER_URL}/analyze`, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('[TRIAL] Photo analysis failed:', errorText);
      return res.status(500).json({ error: 'Photo analysis failed' });
    }

    const analysisResult = await response.json();

    // Return analysis data WITHOUT saving to DB
    // Frontend holds this in state
    res.json({
      success: true,
      ...analysisResult
    });
  } catch (err) {
    log.error('[TRIAL] Photo analysis error:', err);
    res.status(500).json({ error: 'Photo analysis failed' });
  }
});
```

**Important:** Check the exact Python service API by reading the existing call in `server/routes/avatars.js` around line 1875. Match the request format exactly.

**Step 2: Test manually**

```bash
curl -X POST http://localhost:3000/api/trial/analyze-photo \
  -F "photo=@test-photo.jpg"
```

Expected: JSON with face detection data, no DB writes.

**Step 3: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat(trial): add unauthenticated photo analysis endpoint"
```

---

### Task 4: Trial idea generation endpoint (streaming)

**Files:**
- Modify: `server/routes/trial.js`

Reuse the core idea generation logic from `server/routes/storyIdeas.js`. The streaming endpoint (line 331+) is what we need. Extract the shared logic or call it directly.

**Step 1: Add streaming idea generation endpoint**

```javascript
router.post('/generate-ideas-stream', trialIdeasLimiter, async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const { storyCategory, storyTopic, storyTheme, characters, language, pages = 10 } = req.body;

    // Validate minimal input
    if (!storyCategory || !characters?.length) {
      res.write(`data: ${JSON.stringify({ error: 'Missing required fields' })}\n\n`);
      res.end();
      return;
    }

    // Reuse the same idea generation logic as storyIdeas.js
    // but with trial defaults (no location, no landmarks, standard level)
    // See storyIdeas.js lines 240-282 for prompt construction

    // ... (copy/adapt the prompt construction from storyIdeas.js)
    // Key differences:
    // - No userLocation (skip landmarks)
    // - languageLevel = 'standard'
    // - No ideaModel override (always use default)
    // - No req.user (log by IP instead)

    // Call the same text model streaming function
    // ... (copy/adapt streaming logic from storyIdeas.js lines 331+)

  } catch (err) {
    log.error('[TRIAL] Idea generation error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate ideas' })}\n\n`);
    res.end();
  }
});
```

**Implementation note:** Rather than copying 200+ lines, extract a shared function `generateIdeasCore(params)` from `storyIdeas.js` that both the authenticated and trial endpoints call. The trial endpoint just passes `languageLevel: 'standard'`, no location, and no model override.

**Step 2: Test manually**

```bash
curl -N -X POST http://localhost:3000/api/trial/generate-ideas-stream \
  -H "Content-Type: application/json" \
  -d '{"storyCategory":"adventure","storyTheme":"pirates","characters":[{"name":"Max","age":5,"gender":"boy","isMain":true}],"language":"en"}'
```

Expected: SSE stream with two story ideas.

**Step 3: Commit**

```bash
git add server/routes/trial.js server/routes/storyIdeas.js
git commit -m "feat(trial): add unauthenticated idea generation endpoint"
```

---

### Task 5: Trial email registration endpoint

**Files:**
- Modify: `server/routes/trial.js`
- Uses: `email.js` (sendEmailVerificationEmail)

When user enters email and clicks submit:
1. Check if email already has an account → "Please log in instead"
2. Create user with `is_trial=true`, `email_verified=false`, no password
3. Store all trial data (character + story input) in `trial_data` JSONB
4. Give trial user enough credits for 1 story (10 pages)
5. Send verification email
6. Return success

```javascript
router.post('/register-email', trialRegisterLimiter, async (req, res) => {
  try {
    const { email: userEmail, characterData, storyInput } = req.body;

    if (!userEmail || !characterData || !storyInput) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(userEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const pool = getDbPool();

    // Check if email already exists
    const existing = await pool.query(
      'SELECT id, is_trial, email_verified FROM users WHERE email = $1',
      [userEmail.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      // If it's an existing non-trial user, tell them to log in
      if (!user.is_trial) {
        return res.status(409).json({
          error: 'Account already exists',
          code: 'ACCOUNT_EXISTS',
          message: 'This email already has an account. Please log in instead.'
        });
      }
      // If it's an existing trial user who hasn't verified, update their trial_data
      // and resend verification email (allows retry)
      if (!user.email_verified) {
        // Update trial data and resend verification
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await pool.query(
          `UPDATE users SET
            trial_data = $1,
            email_verification_token = $2,
            email_verification_expires = $3,
            updated_at = NOW()
          WHERE id = $4`,
          [JSON.stringify({ characterData, storyInput }), verificationToken, verificationExpires, user.id]
        );

        const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
        const emailModule = require('../../email');
        await emailModule.sendEmailVerificationEmail(userEmail, characterData.name || 'there', verifyUrl);

        return res.json({ success: true, message: 'Verification email sent' });
      }
      // If trial user already verified, they already have a story
      return res.status(409).json({
        error: 'Trial already used',
        code: 'TRIAL_USED',
        message: 'You already created a free trial story with this email.'
      });
    }

    // Create new trial user
    const userId = crypto.randomUUID();
    const username = characterData.name || userEmail.split('@')[0];
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Calculate credits needed for 10-page story
    const { CREDIT_CONFIG } = require('../config/credits');
    const creditsNeeded = CREDIT_CONFIG.STORY_PAGES.DEFAULT * CREDIT_CONFIG.COSTS.PER_PAGE;

    await pool.query(
      `INSERT INTO users (id, username, email, email_verified, role, credits, is_trial,
        trial_data, email_verification_token, email_verification_expires, created_at)
      VALUES ($1, $2, $3, FALSE, 'user', $4, TRUE, $5, $6, $7, NOW())`,
      [
        userId,
        username,
        userEmail.toLowerCase(),
        creditsNeeded,
        JSON.stringify({ characterData, storyInput }),
        verificationToken,
        verificationExpires
      ]
    );

    // Send verification email
    const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
    const emailModule = require('../../email');
    await emailModule.sendEmailVerificationEmail(userEmail, username, verifyUrl);

    log.info(`[TRIAL] Created trial user ${userId} for ${userEmail}, verification sent`);

    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    log.error('[TRIAL] Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat(trial): add email registration with verification"
```

---

### Task 6: Trial Google registration endpoint

**Files:**
- Modify: `server/routes/trial.js`
- Uses: Firebase Admin SDK (already configured in `server/routes/auth.js`)

Google auth = auto-verified. Create user + character + story job immediately.

```javascript
router.post('/register-google', trialRegisterLimiter, async (req, res) => {
  try {
    const { firebaseToken, characterData, storyInput } = req.body;

    if (!firebaseToken || !characterData || !storyInput) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify Firebase token (reuse admin SDK from auth.js)
    const admin = require('firebase-admin');
    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    const { email: userEmail, uid: firebaseUid } = decodedToken;

    if (!userEmail) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    const pool = getDbPool();

    // Check if email already exists
    const existing = await pool.query(
      'SELECT id, is_trial FROM users WHERE email = $1',
      [userEmail.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      const user = existing.rows[0];
      if (!user.is_trial) {
        return res.status(409).json({
          error: 'Account already exists',
          code: 'ACCOUNT_EXISTS',
          message: 'This email already has an account. Please log in to create stories.'
        });
      }
      // Existing trial user - check if they already have a story
      const existingStory = await pool.query(
        'SELECT id FROM story_jobs WHERE user_id = $1 LIMIT 1',
        [user.id]
      );
      if (existingStory.rows.length > 0) {
        return res.status(409).json({
          error: 'Trial already used',
          code: 'TRIAL_USED',
          message: 'You already created a free trial story.'
        });
      }
    }

    // Create user (or get existing trial user ID)
    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await pool.query(
        `UPDATE users SET email_verified = TRUE, firebase_uid = $1, updated_at = NOW() WHERE id = $2`,
        [firebaseUid, userId]
      );
    } else {
      userId = crypto.randomUUID();
      const username = decodedToken.name || userEmail.split('@')[0];
      const { CREDIT_CONFIG } = require('../config/credits');
      const creditsNeeded = CREDIT_CONFIG.STORY_PAGES.DEFAULT * CREDIT_CONFIG.COSTS.PER_PAGE;

      await pool.query(
        `INSERT INTO users (id, username, email, email_verified, role, credits, is_trial, firebase_uid, created_at)
        VALUES ($1, $2, $3, TRUE, 'user', $4, TRUE, $5, NOW())`,
        [userId, username, userEmail.toLowerCase(), creditsNeeded, firebaseUid]
      );
    }

    // Save character to DB
    const characterId = await saveTrialCharacter(pool, userId, characterData);

    // Create story job (reuse existing job creation logic)
    const jobId = await createTrialStoryJob(pool, userId, characterId, characterData, storyInput);

    // Generate JWT so frontend can poll job status
    const { generateToken } = require('../middleware/auth');
    const token = generateToken({ id: userId, username: userEmail.split('@')[0], role: 'user', email: userEmail, email_verified: true });

    log.info(`[TRIAL] Google user ${userId} registered, job ${jobId} created`);

    res.json({ success: true, jobId, token });
  } catch (err) {
    log.error('[TRIAL] Google registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});
```

**Helper functions** (add to same file):

```javascript
// Save character from trial data to database
async function saveTrialCharacter(pool, userId, characterData) {
  const characterId = crypto.randomUUID();
  // Structure matches existing character format
  const data = {
    characters: [{
      id: 1,
      name: characterData.name,
      age: characterData.age,
      gender: characterData.gender,
      isMain: true,
      traits: characterData.traits || [],
      photos: characterData.photos || {},
      // No avatars for trial (uses photos directly)
    }]
  };

  await pool.query(
    `INSERT INTO characters (id, user_id, data, created_at, updated_at)
    VALUES ($1, $2, $3, NOW(), NOW())`,
    [characterId, userId, JSON.stringify(data)]
  );

  return characterId;
}

// Create story job from trial data
async function createTrialStoryJob(pool, userId, characterId, characterData, storyInput) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  const inputData = {
    pages: 10,
    language: storyInput.language || 'en',
    languageLevel: 'standard',
    storyCategory: storyInput.storyCategory,
    storyTopic: storyInput.storyTopic || '',
    storyTheme: storyInput.storyTheme || '',
    storyType: storyInput.storyTheme || storyInput.storyTopic || '',
    artStyle: 'pixar',
    storyDetails: storyInput.storyDetails,
    dedication: '',
    characters: [{
      id: 1,
      name: characterData.name,
      age: characterData.age,
      gender: characterData.gender,
      isMain: true,
      traits: characterData.traits || [],
      photos: characterData.photos || {},
    }],
    isTrial: true,
  };

  // Reserve credits
  const { CREDIT_CONFIG } = require('../config/credits');
  const creditCost = inputData.pages * CREDIT_CONFIG.COSTS.PER_PAGE;

  await pool.query(
    `UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1`,
    [creditCost, userId]
  );

  await pool.query(
    `INSERT INTO story_jobs (id, user_id, status, input_data, progress, credits_reserved, created_at, updated_at)
    VALUES ($1, $2, 'pending', $3, 0, $4, NOW(), NOW())`,
    [jobId, userId, JSON.stringify(inputData), creditCost]
  );

  // Trigger the background job (same mechanism as existing flow)
  // The job processor in server.js picks up 'pending' jobs automatically
  return jobId;
}
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat(trial): add Google registration with immediate job creation"
```

---

### Task 7: Modify email verification to auto-start trial jobs

**Files:**
- Modify: `server/routes/auth.js` (verify-email handler, ~line 528)

When a trial user clicks their verification link, we need to:
1. Mark email as verified (existing behavior)
2. Check if user `is_trial` and has `trial_data`
3. If yes, create character + story job from `trial_data`
4. Clear `trial_data`
5. Redirect to a "story started" page instead of `/email-verified`

**Step 1: Modify verification handler**

In `server/routes/auth.js`, find `GET /verify-email/:token` (~line 528). After the `email_verified = TRUE` update:

```javascript
// After existing verification logic...

// Check if this is a trial user with pending story
if (userRow.is_trial && userRow.trial_data) {
  try {
    const trialData = typeof userRow.trial_data === 'string'
      ? JSON.parse(userRow.trial_data)
      : userRow.trial_data;

    const { saveTrialCharacter, createTrialStoryJob } = require('./trial');
    const characterId = await saveTrialCharacter(pool, userRow.id, trialData.characterData);
    const jobId = await createTrialStoryJob(pool, userRow.id, characterId, trialData.characterData, trialData.storyInput);

    // Clear trial_data now that job is created
    await pool.query(
      'UPDATE users SET trial_data = NULL WHERE id = $1',
      [userRow.id]
    );

    log.info(`[TRIAL] Verification triggered job ${jobId} for trial user ${userRow.id}`);

    // Redirect to trial confirmation page
    return res.redirect('/trial-started');
  } catch (trialErr) {
    log.error('[TRIAL] Failed to create trial job after verification:', trialErr);
    // Fall through to normal redirect
  }
}

// Existing redirect for non-trial users
res.redirect('/email-verified');
```

**Important:** The verify-email handler needs to SELECT `is_trial` and `trial_data` in its query. Update the SELECT to include these columns.

**Step 2: Export helper functions from trial.js**

Make sure `saveTrialCharacter` and `createTrialStoryJob` are exported:

```javascript
module.exports = router;
module.exports.saveTrialCharacter = saveTrialCharacter;
module.exports.createTrialStoryJob = createTrialStoryJob;
```

**Step 3: Commit**

```bash
git add server/routes/auth.js server/routes/trial.js
git commit -m "feat(trial): auto-create story job on email verification"
```

---

### Task 8: Add PDF attachment to story completion email

**Files:**
- Modify: `email.js` (sendStoryCompleteEmail)
- Modify: `server.js` (~line 3886, where completion email is sent)

**Step 1: Modify `sendStoryCompleteEmail` to accept optional attachment**

In `email.js`, update the function signature and Resend call:

```javascript
async function sendStoryCompleteEmail(userEmail, firstName, storyTitle, storyId, language = 'English', options = {}) {
  // ... existing code up to the resend.emails.send call ...

  const emailPayload = {
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: userEmail,
    subject: fillTemplate(template.subject, values),
    text: fillTemplate(template.text, values),
    html: fillTemplate(template.html, values),
  };

  // Add PDF attachment if provided
  if (options.pdfBuffer) {
    emailPayload.attachments = [{
      filename: options.pdfFilename || `${storyTitle || 'story'}.pdf`,
      content: options.pdfBuffer.toString('base64'),
    }];
  }

  // Add claim URL to template values if provided
  if (options.claimUrl) {
    values.claimUrl = options.claimUrl;
  }

  const { data, error } = await resend.emails.send(emailPayload);
  // ... rest of existing error handling ...
}
```

**Step 2: Generate and attach PDF on story completion**

In `server.js` (~line 3878), where the story completion email is sent, add PDF generation for trial users:

```javascript
// After story completion, send email
try {
  const userResult = await getDbPool().query(
    'SELECT email, username, shipping_first_name, preferred_language, is_trial, claim_token FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length > 0 && userResult.rows[0].email) {
    const user = userResult.rows[0];
    const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
    const emailLanguage = user.preferred_language || inputData.language || 'English';

    const emailOptions = {};

    // For trial users, generate and attach PDF + include claim link
    if (user.is_trial) {
      try {
        // Generate view PDF
        const storyData = /* get story data from result */;
        const pdfBuffer = await generateViewPdf(storyData);
        emailOptions.pdfBuffer = pdfBuffer;
        emailOptions.pdfFilename = `${title || 'Your Story'}.pdf`;

        // Generate claim token if not exists
        if (!user.claim_token) {
          const claimToken = crypto.randomBytes(32).toString('hex');
          const claimExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
          await getDbPool().query(
            'UPDATE users SET claim_token = $1, claim_token_expires = $2 WHERE id = $3',
            [claimToken, claimExpires, userId]
          );
          emailOptions.claimUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/claim?token=${claimToken}`;
        }
      } catch (pdfErr) {
        log.error('[TRIAL] Failed to generate PDF for email:', pdfErr);
        // Continue without PDF - link still works
      }
    }

    await email.sendStoryCompleteEmail(user.email, firstName, title, storyId, emailLanguage, emailOptions);
  }
}
```

**Step 3: Commit**

```bash
git add email.js server.js
git commit -m "feat(trial): attach PDF to story completion email for trial users"
```

---

### Task 9: Account claim endpoint

**Files:**
- Modify: `server/routes/trial.js`

Users click the link in their story email to set a password and claim their account.

```javascript
// Get claim page data (validates token, returns user info)
router.get('/claim/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const pool = getDbPool();

    const result = await pool.query(
      `SELECT id, email, username, is_trial, claim_token_expires FROM users
       WHERE claim_token = $1 AND claim_token_expires > NOW()`,
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
    log.error('[TRIAL] Claim lookup error:', err);
    res.status(500).json({ error: 'Failed to look up claim' });
  }
});

// Set password and claim account
router.post('/claim/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const pool = getDbPool();
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `UPDATE users SET
        password = $1,
        is_trial = FALSE,
        claim_token = NULL,
        claim_token_expires = NULL,
        updated_at = NOW()
      WHERE claim_token = $2 AND claim_token_expires > NOW()
      RETURNING id, username, email, role, email_verified`,
      [hashedPassword, token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired claim link' });
    }

    const user = result.rows[0];
    const { generateToken } = require('../middleware/auth');
    const jwtToken = generateToken(user);

    log.info(`[TRIAL] User ${user.id} claimed account via password`);

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified,
      }
    });
  } catch (err) {
    log.error('[TRIAL] Claim error:', err);
    res.status(500).json({ error: 'Failed to claim account' });
  }
});

// Claim via Google (link Google to existing trial account)
router.post('/claim-google', async (req, res) => {
  try {
    const { firebaseToken, claimToken } = req.body;

    const admin = require('firebase-admin');
    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    const { email: googleEmail, uid: firebaseUid } = decodedToken;

    const pool = getDbPool();

    const result = await pool.query(
      `UPDATE users SET
        firebase_uid = $1,
        is_trial = FALSE,
        claim_token = NULL,
        claim_token_expires = NULL,
        updated_at = NOW()
      WHERE claim_token = $2 AND claim_token_expires > NOW() AND email = $3
      RETURNING id, username, email, role, email_verified`,
      [firebaseUid, claimToken, googleEmail.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Claim link does not match this Google account email' });
    }

    const user = result.rows[0];
    const { generateToken } = require('../middleware/auth');
    const jwtToken = generateToken(user);

    log.info(`[TRIAL] User ${user.id} claimed account via Google`);

    res.json({
      success: true,
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: user.email_verified,
      }
    });
  } catch (err) {
    log.error('[TRIAL] Google claim error:', err);
    res.status(500).json({ error: 'Failed to claim account' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat(trial): add account claim endpoints (password + Google)"
```

---

### Task 10: Trial story completion email template

**Files:**
- Create: `emails/trial-story-complete.html`

Create a variant of the story-complete email for trial users. Includes:
- "Your story is ready!" message
- PDF attached note
- Link to view story online
- "Create your account" CTA with claim link
- Multilingual (English, German, French)

**Step 1:** Copy `emails/story-complete.html`, modify to add claim CTA and PDF mention.

**Step 2: Commit**

```bash
git add emails/trial-story-complete.html
git commit -m "feat(trial): add trial story completion email template"
```

---

## Phase 2: Frontend

### Task 11: Create TrialWizard page skeleton

**Files:**
- Create: `client/src/pages/TrialWizard.tsx`
- Modify: `client/src/App.tsx` (add route)

**Step 1: Create the page component**

```typescript
// client/src/pages/TrialWizard.tsx
import { useState, useCallback } from 'react';
import { useLanguage } from '../hooks/useLanguage';

type TrialStep = 'character' | 'topic' | 'ideas';

interface CharacterData {
  name: string;
  age: string;
  gender: string;
  traits: string[];
  photos: {
    original?: string;
    face?: string;
    body?: string;
    bodyNoBg?: string;
    faceBox?: any;
  };
}

interface StoryInput {
  storyCategory: string;
  storyTopic: string;
  storyTheme: string;
  storyDetails: string;
  language: string;
}

export default function TrialWizard() {
  const { t, language } = useLanguage();
  const [step, setStep] = useState<TrialStep>('character');
  const [characterData, setCharacterData] = useState<CharacterData>({
    name: '', age: '', gender: '', traits: [], photos: {}
  });
  const [storyInput, setStoryInput] = useState<StoryInput>({
    storyCategory: '', storyTopic: '', storyTheme: '', storyDetails: '',
    language: navigator.language?.split('-')[0] || 'en'
  });
  const [generatedIdeas, setGeneratedIdeas] = useState<string[]>([]);
  const [selectedIdeaIndex, setSelectedIdeaIndex] = useState<number | null>(null);
  const [showEmailModal, setShowEmailModal] = useState(false);

  const handleCreateStory = () => {
    // Set storyDetails from selected idea
    if (selectedIdeaIndex !== null && generatedIdeas[selectedIdeaIndex]) {
      setStoryInput(prev => ({
        ...prev,
        storyDetails: generatedIdeas[selectedIdeaIndex]
      }));
    }
    setShowEmailModal(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50">
      {/* Progress bar */}
      <div className="flex justify-center gap-2 pt-6 pb-4">
        {(['character', 'topic', 'ideas'] as TrialStep[]).map((s, i) => (
          <div
            key={s}
            className={`h-2 w-20 rounded-full transition-colors ${
              step === s ? 'bg-indigo-600' :
              (['character', 'topic', 'ideas'].indexOf(step) > i ? 'bg-indigo-300' : 'bg-gray-200')
            }`}
          />
        ))}
      </div>

      {/* Step content */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        {step === 'character' && (
          <TrialCharacterStep
            characterData={characterData}
            onChange={setCharacterData}
            onNext={() => setStep('topic')}
          />
        )}
        {step === 'topic' && (
          <TrialTopicStep
            storyInput={storyInput}
            onChange={setStoryInput}
            onBack={() => setStep('character')}
            onNext={() => setStep('ideas')}
          />
        )}
        {step === 'ideas' && (
          <TrialIdeasStep
            characterData={characterData}
            storyInput={storyInput}
            generatedIdeas={generatedIdeas}
            onIdeasGenerated={setGeneratedIdeas}
            selectedIdeaIndex={selectedIdeaIndex}
            onSelectIdea={setSelectedIdeaIndex}
            onBack={() => setStep('topic')}
            onCreate={handleCreateStory}
          />
        )}
      </div>

      {/* Email/Google modal */}
      {showEmailModal && (
        <TrialAuthModal
          characterData={characterData}
          storyInput={storyInput}
          onClose={() => setShowEmailModal(false)}
        />
      )}
    </div>
  );
}
```

**Step 2: Add route in App.tsx**

```typescript
const TrialWizard = lazy(() => import('./pages/TrialWizard'));

// Inside <Routes>:
<Route path="/try" element={<TrialWizard />} />
```

**Step 3: Commit**

```bash
git add client/src/pages/TrialWizard.tsx client/src/App.tsx
git commit -m "feat(trial): add TrialWizard page skeleton with routing"
```

---

### Task 12: Trial character step component

**Files:**
- Create: `client/src/pages/trial/TrialCharacterStep.tsx`

Simplified character creation: photo upload + name + age + gender + 3-5 trait selections.

**Step 1: Create component**

Reuse the existing `PhotoUpload` component from `client/src/components/character/PhotoUpload.tsx` for the photo upload part. Keep trait selection simple (checkboxes from a predefined list).

```typescript
// client/src/pages/trial/TrialCharacterStep.tsx
import { useState } from 'react';
import { Camera, ArrowRight } from 'lucide-react';

// Reuse existing PhotoUpload component for photo handling
// But simplified — no consent modal for trial (include consent in terms link)

interface Props {
  characterData: CharacterData;
  onChange: (data: CharacterData) => void;
  onNext: () => void;
}

export function TrialCharacterStep({ characterData, onChange, onNext }: Props) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const handlePhotoUpload = async (file: File) => {
    setIsAnalyzing(true);
    try {
      const formData = new FormData();
      formData.append('photo', file);

      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/analyze-photo`, {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();

      if (result.success) {
        onChange({
          ...characterData,
          photos: {
            original: result.original,
            face: result.face,
            body: result.body,
            bodyNoBg: result.bodyNoBg,
            faceBox: result.faceBox,
          }
        });
      }
    } catch (err) {
      console.error('Photo analysis failed:', err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const canProceed = characterData.name && characterData.age &&
    characterData.gender && characterData.photos.face;

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-title text-center">Who is the hero?</h2>

      {/* Photo upload area */}
      {/* ... photo upload UI ... */}

      {/* Name, age, gender inputs */}
      {/* ... form fields ... */}

      {/* Simple trait checkboxes */}
      {/* e.g., Brave, Curious, Kind, Funny, Creative, Adventurous */}

      <button
        onClick={onNext}
        disabled={!canProceed}
        className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50"
      >
        Next <ArrowRight className="inline" size={20} />
      </button>
    </div>
  );
}
```

**Implementation note:** Check how the existing `PhotoUpload` component works and reuse as much as possible. The trial version skips the consent modal but should include a small "By uploading, you agree to our Terms" link.

**Step 2: Handle multi-face selection** — if the Python service detects multiple faces, show a simple face picker (can reuse `FaceSelectionModal` from `client/src/components/character/FaceSelectionModal.tsx`).

**Step 3: Commit**

```bash
git add client/src/pages/trial/TrialCharacterStep.tsx
git commit -m "feat(trial): add simplified character step"
```

---

### Task 13: Trial topic step component

**Files:**
- Create: `client/src/pages/trial/TrialTopicStep.tsx`

Reuse `StoryCategorySelector` from `client/src/components/story/StoryCategorySelector.tsx`.

**Step 1: Create component**

```typescript
// client/src/pages/trial/TrialTopicStep.tsx
import { ArrowLeft, ArrowRight } from 'lucide-react';
// Import existing StoryCategorySelector or replicate simplified version

interface Props {
  storyInput: StoryInput;
  onChange: (data: StoryInput) => void;
  onBack: () => void;
  onNext: () => void;
}

export function TrialTopicStep({ storyInput, onChange, onBack, onNext }: Props) {
  const canProceed = storyInput.storyCategory &&
    (storyInput.storyTheme || storyInput.storyTopic);

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-title text-center">What kind of story?</h2>

      {/* Reuse StoryCategorySelector component */}
      {/* It handles category + topic/theme selection */}

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 border py-3 rounded-xl">
          <ArrowLeft className="inline" size={20} /> Back
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50"
        >
          Next <ArrowRight className="inline" size={20} />
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add client/src/pages/trial/TrialTopicStep.tsx
git commit -m "feat(trial): add story topic selection step"
```

---

### Task 14: Trial ideas step component

**Files:**
- Create: `client/src/pages/trial/TrialIdeasStep.tsx`

Shows "Generate Ideas" button, displays 2 streaming ideas, user picks one, then "Create My Story" button.

**Step 1: Create component**

```typescript
// client/src/pages/trial/TrialIdeasStep.tsx

export function TrialIdeasStep({ characterData, storyInput, generatedIdeas, onIdeasGenerated, selectedIdeaIndex, onSelectIdea, onBack, onCreate }: Props) {
  const [isGenerating, setIsGenerating] = useState(false);

  const generateIdeas = async () => {
    setIsGenerating(true);
    onIdeasGenerated([]);
    onSelectIdea(null);

    try {
      // Call trial streaming endpoint
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/generate-ideas-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storyCategory: storyInput.storyCategory,
          storyTopic: storyInput.storyTopic,
          storyTheme: storyInput.storyTheme,
          language: storyInput.language,
          pages: 10,
          characters: [{
            name: characterData.name,
            age: characterData.age,
            gender: characterData.gender,
            isMain: true,
            traits: characterData.traits,
          }],
        }),
      });

      // Parse SSE stream (similar to existing storyService.generateStoryIdeasStream)
      // Update generatedIdeas as data arrives
      // ...

    } catch (err) {
      console.error('Idea generation failed:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  const canCreate = selectedIdeaIndex !== null && generatedIdeas[selectedIdeaIndex];

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-title text-center">Pick your story</h2>

      <button
        onClick={generateIdeas}
        disabled={isGenerating}
        className="w-full bg-indigo-500 text-white py-3 rounded-xl font-bold"
      >
        {isGenerating ? 'Generating...' : generatedIdeas.length ? 'Regenerate Ideas' : 'Generate Story Ideas'}
      </button>

      {/* Two idea cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {generatedIdeas.map((idea, i) => (
          <div
            key={i}
            onClick={() => onSelectIdea(i)}
            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
              selectedIdeaIndex === i ? 'border-indigo-600 bg-indigo-50' : 'border-gray-200 hover:border-indigo-300'
            }`}
          >
            <p className="text-sm">{idea}</p>
          </div>
        ))}
      </div>

      <div className="flex gap-4">
        <button onClick={onBack} className="flex-1 border py-3 rounded-xl">
          Back
        </button>
        <button
          onClick={onCreate}
          disabled={!canCreate}
          className="flex-1 bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50"
        >
          Create My Story
        </button>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add client/src/pages/trial/TrialIdeasStep.tsx
git commit -m "feat(trial): add idea generation and selection step"
```

---

### Task 15: Trial auth modal (email + Google popup)

**Files:**
- Create: `client/src/pages/trial/TrialAuthModal.tsx`

Modal that appears when user clicks "Create My Story". Two options:
1. Enter email → sends verification → shows "check your inbox" state
2. Continue with Google → immediate job creation → shows job status

```typescript
// client/src/pages/trial/TrialAuthModal.tsx
import { useState } from 'react';
import { X, Mail, Loader2 } from 'lucide-react';
import { signInWithGoogle } from '../../services/firebase';

type ModalState = 'input' | 'verifying' | 'generating' | 'error';

interface Props {
  characterData: CharacterData;
  storyInput: StoryInput;
  onClose: () => void;
}

export function TrialAuthModal({ characterData, storyInput, onClose }: Props) {
  const [state, setState] = useState<ModalState>('input');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');

  const handleEmailSubmit = async () => {
    if (!email) return;
    setError('');

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/register-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, characterData, storyInput }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || data.error);
        return;
      }

      setState('verifying');
    } catch (err) {
      setError('Something went wrong. Please try again.');
    }
  };

  const handleGoogleAuth = async () => {
    try {
      const firebaseUser = await signInWithGoogle();
      const firebaseToken = await firebaseUser.getIdToken();

      const response = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/trial/register-google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebaseToken, characterData, storyInput }),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.message || data.error);
        return;
      }

      // Store token for job polling
      localStorage.setItem('auth_token', data.token);
      setState('generating');

      // Could redirect to a status page or show inline progress
      // navigate(`/trial-status?jobId=${data.jobId}`);
    } catch (err) {
      setError('Google sign-in failed. Please try again.');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-md w-full p-6 relative">
        <button onClick={onClose} className="absolute top-4 right-4">
          <X size={20} />
        </button>

        {state === 'input' && (
          <>
            <h3 className="text-2xl font-title mb-2">Almost there!</h3>
            <p className="text-gray-600 mb-6">
              Where should we send your finished story?
            </p>

            {/* Google button */}
            <button
              onClick={handleGoogleAuth}
              className="w-full flex items-center justify-center gap-2 border py-3 rounded-xl mb-4 hover:bg-gray-50"
            >
              <img src="/images/google-icon.svg" alt="" className="w-5 h-5" />
              Continue with Google
            </button>

            <div className="text-center text-gray-400 text-sm mb-4">or</div>

            {/* Email input */}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full border rounded-xl px-4 py-3 mb-4"
              onKeyDown={(e) => e.key === 'Enter' && handleEmailSubmit()}
            />

            {error && <p className="text-red-500 text-sm mb-4">{error}</p>}

            <button
              onClick={handleEmailSubmit}
              disabled={!email}
              className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold disabled:opacity-50"
            >
              Send me my story
            </button>

            <p className="text-xs text-gray-400 mt-4 text-center">
              By continuing, you agree to our Terms of Service and Privacy Policy.
            </p>
          </>
        )}

        {state === 'verifying' && (
          <div className="text-center py-8">
            <Mail size={48} className="mx-auto mb-4 text-indigo-600" />
            <h3 className="text-2xl font-title mb-2">Check your inbox</h3>
            <p className="text-gray-600">
              We sent a verification link to <strong>{email}</strong>.
              Click it and we'll start creating your story right away!
            </p>
            <p className="text-sm text-gray-400 mt-4">
              Didn't receive it? Check your spam folder.
            </p>
          </div>
        )}

        {state === 'generating' && (
          <div className="text-center py-8">
            <Loader2 size={48} className="mx-auto mb-4 text-indigo-600 animate-spin" />
            <h3 className="text-2xl font-title mb-2">Creating your story!</h3>
            <p className="text-gray-600">
              This usually takes 5-10 minutes. We'll email you
              the finished story with a PDF you can print!
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add client/src/pages/trial/TrialAuthModal.tsx
git commit -m "feat(trial): add email/Google auth modal"
```

---

### Task 16: Trial started confirmation page

**Files:**
- Create: `client/src/pages/TrialStarted.tsx`
- Modify: `client/src/App.tsx` (add route)

Page shown after user clicks verification link. Simple "Your story is being created" message.

```typescript
// client/src/pages/TrialStarted.tsx
export default function TrialStarted() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-pink-50 to-blue-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 text-center max-w-md">
        <div className="text-6xl mb-4">✨</div>
        <h1 className="text-3xl font-title mb-4">Your story is being created!</h1>
        <p className="text-gray-600 mb-6">
          We'll email you the finished story with a PDF attachment
          in about 5-10 minutes. Keep an eye on your inbox!
        </p>
        <a href="/" className="text-indigo-600 hover:underline">
          Back to home
        </a>
      </div>
    </div>
  );
}
```

Add route: `<Route path="/trial-started" element={<TrialStarted />} />`

**Step 2: Commit**

```bash
git add client/src/pages/TrialStarted.tsx client/src/App.tsx
git commit -m "feat(trial): add trial-started confirmation page"
```

---

### Task 17: Account claim page

**Files:**
- Create: `client/src/pages/ClaimAccount.tsx`
- Modify: `client/src/App.tsx` (add route)

Page at `/claim?token=xxx`. Shows the story (if accessible) and a "Set password" form.

```typescript
// client/src/pages/ClaimAccount.tsx
// On load: GET /api/trial/claim/:token → shows email, username
// Form: password input → POST /api/trial/claim/:token → gets JWT → logged in
// Alternative: Google button → POST /api/trial/claim-google
// After claim: redirect to /stories
```

Add route: `<Route path="/claim" element={<ClaimAccount />} />`

**Step 2: Commit**

```bash
git add client/src/pages/ClaimAccount.tsx client/src/App.tsx
git commit -m "feat(trial): add account claim page"
```

---

## Phase 3: Landing Page

### Task 18: Update landing page buttons

**Files:**
- Modify: `client/src/pages/LandingPage.tsx`
- Modify: `client/src/constants/translations.ts`

**Step 1: Change "Start Your Adventure" button to link to `/try`**

In `LandingPage.tsx`, update `handleStartJourney` (line 194):

```typescript
const handleStartJourney = () => {
  navigate('/try');
};
```

Both buttons (line 303 and line 574) already use `handleStartJourney`, so they'll both update.

**Step 2: Update translations**

In `translations.ts`, change `startJourney`:
```typescript
en: { startJourney: 'Try a Free Story' }
de: { startJourney: 'Kostenlose Geschichte testen' }
fr: { startJourney: 'Essayer une histoire gratuite' }
```

**Step 3: Add a smaller "Log in" link**

In the hero section (after the main button, ~line 310):

```tsx
<div className="mt-4">
  <button
    onClick={() => setShowAuthModal(true)}
    className="text-indigo-600 hover:text-indigo-800 text-sm font-medium underline"
  >
    Already have an account? Log in
  </button>
</div>
```

**Step 4: Commit**

```bash
git add client/src/pages/LandingPage.tsx client/src/constants/translations.ts
git commit -m "feat(trial): update landing page CTA to trial flow"
```

---

## Phase 4: Integration & Testing

### Task 19: Add translations for trial flow

**Files:**
- Modify: `client/src/constants/translations.ts`

Add all trial-specific strings (step titles, button labels, modal text, etc.) in English, German, and French.

### Task 20: End-to-end testing

**Manual test checklist:**

1. **Happy path (email):** `/try` → upload photo → enter details → pick topic → generate ideas → pick idea → "Create" → enter email → check inbox → click verification → story starts → email arrives with PDF
2. **Happy path (Google):** Same steps but choose Google at modal → story starts immediately → email arrives
3. **Duplicate email:** Try registering with existing account email → shows "already exists" message
4. **Rate limiting:** Try 6+ photo uploads from same IP → blocked
5. **Claim account:** Click link in story email → set password → logged in → can see story in "My Stories"
6. **Mobile:** Full flow works on mobile viewport

### Task 21: Final review and commit

Review all changes, ensure no auth leaks (unauthenticated endpoints properly rate-limited), no OWASP issues.

```bash
git add -A
git commit -m "feat(trial): complete trial story creation flow"
```

---

## Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| Separate `/try` route | Keeps trial simple without touching complex StoryWizard |
| No DB writes until registration | Clean DB, no orphaned data |
| trial_data on users table | Simple, no new tables, cleared after job creation |
| Claim token (not password reset) | Dedicated flow, 30-day expiry, single-use |
| PDF in email via Resend | Under 40MB limit, great UX, no extra hosting |
| Rate limit per IP only | Simple, effective with email verification gate |
| Reuse existing job processor | Trial jobs are identical to regular jobs, just with defaults |

## Files Summary

**New files:**
- `scripts/admin/add-trial-columns.js` — DB migration
- `server/routes/trial.js` — All trial backend endpoints
- `emails/trial-story-complete.html` — Email template
- `client/src/pages/TrialWizard.tsx` — Main trial page
- `client/src/pages/trial/TrialCharacterStep.tsx` — Step 1
- `client/src/pages/trial/TrialTopicStep.tsx` — Step 2
- `client/src/pages/trial/TrialIdeasStep.tsx` — Step 3
- `client/src/pages/trial/TrialAuthModal.tsx` — Email/Google popup
- `client/src/pages/TrialStarted.tsx` — Post-verification page
- `client/src/pages/ClaimAccount.tsx` — Account claim page

**Modified files:**
- `server.js` — Mount trial routes + PDF in completion email
- `server/routes/auth.js` — Verification triggers trial job
- `email.js` — Support attachments in sendStoryCompleteEmail
- `server/routes/storyIdeas.js` — Extract shared idea generation logic
- `client/src/App.tsx` — Add routes (/try, /trial-started, /claim)
- `client/src/pages/LandingPage.tsx` — Update CTA button
- `client/src/constants/translations.ts` — Add trial translations
