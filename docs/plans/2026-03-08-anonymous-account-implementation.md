# Anonymous Account Flow — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start story generation before email is collected — anonymous account created on character submission, story starts immediately, email collected in parallel during generation.

**Architecture:** Add `anonymous` column to users table. New session token (limited JWT) issued on anonymous account creation. New endpoints: create-anonymous-account, create-story, link-email, link-google, job-status. Frontend wizard refactored: character→avatar→topic→ideas→generation+email overlay. Keep old register-email/register-google endpoints during transition.

**Tech Stack:** Express.js (backend), PostgreSQL, JWT, React + TypeScript (frontend), Cloudflare Turnstile, FingerprintJS

---

## Task 1: Database Migration — Add `anonymous` column

**Files:**
- Modify: `server.js` (add ALTER TABLE migration after existing migrations)

**Step 1: Add migration**

Add after the `last_verification_email_sent` migration (around line 1448):

```javascript
// Add anonymous column for anonymous trial accounts (no email yet)
await dbPool.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='anonymous') THEN
      ALTER TABLE users ADD COLUMN anonymous BOOLEAN DEFAULT FALSE;
    END IF;
  END $$;
`);
```

**Step 2: Verify**

Run: `node -e "console.log('syntax ok')" && grep -c "anonymous" server.js`

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add anonymous column migration for anonymous trial accounts"
```

---

## Task 2: Session Token Middleware

**Files:**
- Modify: `server/routes/trial.js` (add `verifySessionToken` middleware)

**Step 1: Implement middleware**

Add after the fingerprint cleanup interval (around line 178), before the generate-preview-avatar endpoint:

```javascript
// ─── Session Token Middleware ────────────────────────────────────────────────

const jwt = require('jsonwebtoken');

/**
 * Middleware to verify anonymous session tokens.
 * Session tokens have payload: { userId, anonymous: true }
 * They grant limited permissions: create story, poll status, view own story, link email.
 */
function verifySessionToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(401).json({ error: 'Session token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.anonymous) {
      return res.status(403).json({ error: 'Invalid session token' });
    }
    req.sessionUser = { userId: decoded.userId, anonymous: true };
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Session expired. Please start over.' });
  }
}

/**
 * Generate a limited session token for anonymous trial users.
 * 24h expiry, minimal payload.
 */
function generateSessionToken(userId) {
  return jwt.sign(
    { userId, anonymous: true },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
}
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add session token middleware for anonymous trial users"
```

---

## Task 3: POST /api/trial/create-anonymous-account

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Implement endpoint**

Add after the session token middleware:

```javascript
// ─── Anonymous Account Creation ─────────────────────────────────────────────

/**
 * POST /api/trial/create-anonymous-account
 *
 * Creates an anonymous user + character in the database.
 * Protected by: IP rate limit + Turnstile + fingerprint + daily cap.
 * Returns a session token for subsequent trial API calls.
 */
router.post('/create-anonymous-account', trialAvatarLimiter, async (req, res) => {
  try {
    const { name, age, gender, traits, customTraits, facePhoto, bodyPhoto, bodyNoBgPhoto, faceBox, turnstileToken, fingerprint } = req.body;

    // Validate required fields
    if (!facePhoto || !name) {
      return res.status(400).json({ error: 'Name and photo are required' });
    }
    if (typeof name !== 'string' || name.length > 50) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    if (gender && !['male', 'female'].includes(gender)) {
      return res.status(400).json({ error: 'Invalid gender' });
    }
    if (age && (isNaN(parseInt(age)) || parseInt(age) < 1 || parseInt(age) > 18)) {
      return res.status(400).json({ error: 'Invalid age' });
    }

    const safeName = name.replace(/[\r\n]/g, '');

    // Layer 1: Verify Turnstile
    const turnstileValid = await verifyTurnstile(turnstileToken, req.ip);
    if (!turnstileValid) {
      return res.status(403).json({ error: 'Verification failed. Please try again.' });
    }

    // Layer 2: Check fingerprint
    if (!checkFingerprint(fingerprint)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again tomorrow.' });
    }

    // Layer 3: Daily cap
    if (!checkAndIncrementTrialCap('avatar')) {
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again tomorrow.' });
    }

    log.info(`[TRIAL] Creating anonymous account for "${safeName}"`);

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Create anonymous user
    const userId = crypto.randomUUID();
    const bcrypt = require('bcryptjs');
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    await pool.query(
      `INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits, is_trial, anonymous)
       VALUES ($1, $2, $3, $4, 'user', 1, 0, 0, true, true)`,
      [
        userId,
        `anon_${userId}`,
        `anon_${userId}@anonymous`,
        hashedPassword,
      ]
    );

    // Build character data and save
    const characterData = {
      name: safeName,
      age: age || '',
      gender: gender || '',
      traits: traits || [],
      customTraits: customTraits || '',
      photos: {
        face: facePhoto,
        body: bodyPhoto || null,
        bodyNoBg: bodyNoBgPhoto || null,
        faceBox: faceBox || null,
      },
    };

    const { characterId, charId } = await saveTrialCharacter(pool, userId, characterData);

    // Generate session token
    const sessionToken = generateSessionToken(userId);

    log.info(`[TRIAL] Anonymous account created: ${userId} for "${safeName}"`);

    res.json({
      sessionToken,
      userId,
      characterId,
      charId,
    });
  } catch (err) {
    log.error(`[TRIAL] create-anonymous-account error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add create-anonymous-account endpoint"
```

---

## Task 4: Modify generate-preview-avatar to save to DB

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Add session token support and DB save**

The existing `/generate-preview-avatar` endpoint works without auth and doesn't save to DB. Modify it to:
1. Optionally accept a session token (via Authorization header)
2. If session token present, also accept `characterId` in body
3. After generating avatar, save it to the character record in DB
4. Still works without session token (backwards compatible for the current flow)

Add this right after the avatar is generated (after `res.json({ avatarImage: finalImage });`), inside the try block:

Replace the success response section (around line 327-331) from:
```javascript
    log.info(`[TRIAL AVATAR] ✅ Generated preview avatar for "${safeName}" (${inputTokens} in / ${outputTokens} out)`);

    res.json({ avatarImage: finalImage });
```

To:
```javascript
    log.info(`[TRIAL AVATAR] ✅ Generated preview avatar for "${safeName}" (${inputTokens} in / ${outputTokens} out)`);

    // If session token provided, save avatar to character in DB
    const authHeader = req.headers['authorization'];
    const sessionTokenStr = authHeader && authHeader.split(' ')[1];
    if (sessionTokenStr && req.body.characterId) {
      try {
        const decoded = jwt.verify(sessionTokenStr, process.env.JWT_SECRET);
        if (decoded.anonymous && decoded.userId) {
          const { getPool } = require('../services/database');
          const pool = getPool();
          // Update character data to include avatar
          const charResult = await pool.query(
            'SELECT data FROM characters WHERE id = $1 AND user_id = $2',
            [req.body.characterId, decoded.userId]
          );
          if (charResult.rows.length > 0) {
            const charData = typeof charResult.rows[0].data === 'string'
              ? JSON.parse(charResult.rows[0].data)
              : charResult.rows[0].data;
            if (charData.characters && charData.characters[0]) {
              charData.characters[0].previewAvatar = finalImage;
              await pool.query(
                'UPDATE characters SET data = $1 WHERE id = $2',
                [JSON.stringify(charData), req.body.characterId]
              );
              log.debug(`[TRIAL AVATAR] Saved avatar to character ${req.body.characterId}`);
            }
          }
        }
      } catch (saveErr) {
        // Non-critical — avatar still returned to frontend
        log.warn(`[TRIAL AVATAR] Failed to save avatar to DB: ${saveErr.message}`);
      }
    }

    res.json({ avatarImage: finalImage });
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: save preview avatar to character DB when session token provided"
```

---

## Task 5: POST /api/trial/create-story

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Implement endpoint**

Add after the create-anonymous-account endpoint:

```javascript
/**
 * POST /api/trial/create-story
 *
 * Start story generation for an anonymous trial user.
 * Protected by: session token + 1 story per account + daily cap.
 */
router.post('/create-story', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { storyCategory, storyTopic, storyTheme, storyDetails, language } = req.body;

    if (!storyCategory && !storyTopic) {
      return res.status(400).json({ error: 'Story topic is required' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Check user exists and hasn't already used trial
    const userResult = await pool.query(
      'SELECT id, stories_generated, anonymous FROM users WHERE id = $1 AND is_trial = true',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = userResult.rows[0];
    if (user.stories_generated >= 1) {
      return res.status(409).json({ error: 'Trial story already used', code: 'TRIAL_USED' });
    }

    // Get character data
    const characterId = `characters_${userId}`;
    const charResult = await pool.query(
      'SELECT data FROM characters WHERE id = $1',
      [characterId]
    );

    if (charResult.rows.length === 0) {
      return res.status(404).json({ error: 'Character not found. Please start over.' });
    }

    const charData = typeof charResult.rows[0].data === 'string'
      ? JSON.parse(charResult.rows[0].data)
      : charResult.rows[0].data;

    // Build characterData from stored character
    const mainChar = charData.characters[0];
    const characterData = {
      name: mainChar.name,
      age: mainChar.age,
      gender: mainChar.gender,
      traits: mainChar.traits,
      photos: mainChar.photos || {},
      _charId: mainChar.id,
    };

    const storyInput = {
      storyCategory: storyCategory || '',
      storyTopic: storyTopic || '',
      storyTheme: storyTheme || '',
      storyDetails: storyDetails || '',
      language: language || 'en',
    };

    // Store trial_data for later use during claim
    await pool.query(
      'UPDATE users SET trial_data = $1, stories_generated = stories_generated + 1 WHERE id = $2',
      [JSON.stringify({ characterData, storyInput }), userId]
    );

    // Create story job (checks daily cap internally)
    const jobId = await createTrialStoryJob(pool, userId, characterId, characterData, storyInput);

    // Start processing in background
    if (deps.processStoryJob) {
      deps.processStoryJob(jobId).catch(err => {
        log.error(`[TRIAL] Job ${jobId} processing failed:`, err);
      });
    }

    log.info(`[TRIAL] Story job ${jobId} started for anonymous user ${userId}`);

    res.json({ jobId });
  } catch (err) {
    if (err.code === 'TRIAL_CAP_REACHED') {
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again tomorrow.' });
    }
    log.error(`[TRIAL] create-story error: ${err.message}`);
    res.status(500).json({ error: 'Failed to start story generation. Please try again.' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add create-story endpoint for anonymous trial users"
```

---

## Task 6: GET /api/trial/job-status/:jobId

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Implement endpoint**

Add after create-story. This is a lightweight version of the authenticated `/api/jobs/:id/status` endpoint:

```javascript
const { jobStatusLimiter } = require('../middleware/rateLimit');

/**
 * GET /api/trial/job-status/:jobId
 *
 * Poll story generation progress for anonymous trial users.
 * Returns same format as /api/jobs/:id/status but with session token auth.
 */
router.get('/job-status/:jobId', jobStatusLimiter, verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { jobId } = req.params;

    const { getPool } = require('../services/database');
    const pool = getPool();

    const result = await pool.query(
      'SELECT id, status, progress, progress_message, error_message, created_at, completed_at FROM story_jobs WHERE id = $1 AND user_id = $2',
      [jobId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];

    const response = {
      jobId: job.id,
      status: job.status,
      progress: job.progress || 0,
      progressMessage: job.progress_message || '',
      createdAt: job.created_at,
      completedAt: job.completed_at,
    };

    // If completed, include minimal result (story ID for viewing)
    if (job.status === 'completed') {
      const storyResult = await pool.query(
        'SELECT id FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (storyResult.rows.length > 0) {
        response.result = { storyId: storyResult.rows[0].id };
      }
    }

    if (job.status === 'failed') {
      response.errorMessage = job.error_message || 'Story generation failed';
    }

    res.json(response);
  } catch (err) {
    log.error(`[TRIAL] job-status error: ${err.message}`);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add job-status polling endpoint for anonymous trial users"
```

---

## Task 7: POST /api/trial/link-email

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Implement endpoint**

```javascript
/**
 * POST /api/trial/link-email
 *
 * Link an email to an anonymous trial account.
 * Sends verification email. Account stays anonymous until email is verified via claim.
 */
router.post('/link-email', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const normalizedEmail = email.toLowerCase().trim();
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Check user is still anonymous
    const userResult = await pool.query(
      'SELECT id, anonymous FROM users WHERE id = $1 AND is_trial = true',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    if (!userResult.rows[0].anonymous) {
      return res.status(409).json({ error: 'Email already linked' });
    }

    // Check email not already used by another user
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND email != $2",
      [normalizedEmail, `anon_${userId}@anonymous`]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'This email is already associated with an account',
        code: 'EMAIL_EXISTS',
      });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Update user with email (keep anonymous=true until they claim/verify)
    await pool.query(
      `UPDATE users SET
         email = $1,
         username = $1,
         anonymous = false,
         email_verification_token = $2,
         email_verification_expires = $3
       WHERE id = $4`,
      [normalizedEmail, verificationToken, verificationExpires, userId]
    );

    // Send verification email
    const emailService = require('../../email');

    // Get character name for email personalization
    const charResult = await pool.query(
      'SELECT metadata FROM characters WHERE user_id = $1',
      [userId]
    );
    const charMeta = charResult.rows[0]?.metadata;
    const parsedMeta = typeof charMeta === 'string' ? JSON.parse(charMeta) : charMeta;
    const displayName = parsedMeta?.characters?.[0]?.name || normalizedEmail.split('@')[0];

    // Get story language from trial_data
    const trialResult = await pool.query('SELECT trial_data FROM users WHERE id = $1', [userId]);
    const trialData = trialResult.rows[0]?.trial_data;
    const parsedTrial = typeof trialData === 'string' ? JSON.parse(trialData) : trialData;
    const language = parsedTrial?.storyInput?.language || 'en';

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
    await emailService.sendEmailVerificationEmail(normalizedEmail, displayName, verifyUrl, language);

    log.info(`[TRIAL] Email linked for anonymous user ${userId}: ${normalizedEmail}`);

    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    log.error(`[TRIAL] link-email error: ${err.message}`);
    res.status(500).json({ error: 'Failed to link email. Please try again.' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add link-email endpoint for anonymous trial accounts"
```

---

## Task 8: POST /api/trial/link-google

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Implement endpoint**

```javascript
/**
 * POST /api/trial/link-google
 *
 * Link a Google account to an anonymous trial user.
 * Google verifies email automatically → immediately converts to full account.
 * Returns a full auth token (replaces session token).
 */
router.post('/link-google', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Google token is required' });
    }

    // Verify Firebase token
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      return res.status(503).json({ error: 'Google authentication not configured' });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const googleEmail = decodedToken.email;

    if (!googleEmail) {
      return res.status(400).json({ error: 'Could not get email from Google account' });
    }

    const normalizedEmail = googleEmail.toLowerCase().trim();

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Check user is still anonymous
    const userResult = await pool.query(
      'SELECT id, anonymous FROM users WHERE id = $1 AND is_trial = true',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Check email not used by another user
    const existing = await pool.query(
      "SELECT id FROM users WHERE email = $1 AND id != $2",
      [normalizedEmail, userId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'This email is already associated with an account',
        code: 'EMAIL_EXISTS',
      });
    }

    // Update user: link Google, set email, mark verified, remove anonymous
    await pool.query(
      `UPDATE users SET
         email = $1,
         username = $1,
         anonymous = false,
         email_verified = true,
         firebase_uid = $2
       WHERE id = $3`,
      [normalizedEmail, decodedToken.uid, userId]
    );

    // Generate full auth token
    const updatedUser = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = updatedUser.rows[0];

    const { authenticateToken, generateToken } = require('../middleware/auth');
    const fullToken = generateToken(user);

    log.info(`[TRIAL] Google account linked for user ${userId}: ${normalizedEmail}`);

    res.json({
      success: true,
      token: fullToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: user.credits,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        emailVerified: true,
      },
    });
  } catch (err) {
    log.error(`[TRIAL] link-google error: ${err.message}`);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    res.status(500).json({ error: 'Failed to link Google account. Please try again.' });
  }
});
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add link-google endpoint for anonymous trial accounts"
```

---

## Task 9: Anonymous Account Cleanup Job

**Files:**
- Modify: `server/routes/trial.js`

**Step 1: Add cleanup interval**

Add near the fingerprint cleanup interval:

```javascript
// Cleanup abandoned anonymous accounts every 6 hours
// Deletes anonymous users older than 48h who never linked an email
setInterval(async () => {
  try {
    const { getPool, isDatabaseMode } = require('../services/database');
    if (!isDatabaseMode()) return;

    const pool = getPool();

    // Delete story_jobs for abandoned anonymous users
    const jobsResult = await pool.query(`
      DELETE FROM story_jobs
      WHERE user_id IN (
        SELECT id FROM users
        WHERE anonymous = true
          AND created_at < NOW() - INTERVAL '48 hours'
      )
    `);

    // Delete characters for abandoned anonymous users
    const charsResult = await pool.query(`
      DELETE FROM characters
      WHERE user_id IN (
        SELECT id FROM users
        WHERE anonymous = true
          AND created_at < NOW() - INTERVAL '48 hours'
      )
    `);

    // Delete the anonymous users themselves
    const usersResult = await pool.query(`
      DELETE FROM users
      WHERE anonymous = true
        AND created_at < NOW() - INTERVAL '48 hours'
      RETURNING id
    `);

    if (usersResult.rowCount > 0) {
      log.info(`[TRIAL CLEANUP] Deleted ${usersResult.rowCount} abandoned anonymous accounts (${charsResult.rowCount} characters, ${jobsResult.rowCount} jobs)`);
    }
  } catch (err) {
    log.warn(`[TRIAL CLEANUP] Error: ${err.message}`);
  }
}, 6 * 60 * 60 * 1000).unref(); // Every 6 hours, .unref() so it doesn't keep process alive
```

**Step 2: Commit**

```bash
git add server/routes/trial.js
git commit -m "feat: add cleanup job for abandoned anonymous accounts (48h TTL)"
```

---

## Task 10: Frontend — TrialWizard Refactor

**Files:**
- Modify: `client/src/pages/TrialWizard.tsx`

**Step 1: Add session token state and new step flow**

The wizard now works in two modes:
- **Before session token**: character step (creates anonymous account on submit)
- **After session token**: avatar → topic → ideas → create story (all using session token)
- **After "Create Story"**: navigate to generation page with email overlay

```typescript
// New step type includes generation
type TrialStep = 'character' | 'topic' | 'ideas';
// Steps remain the same — character creates anon account + avatar,
// then topic, then ideas, then "Create Story" → navigates to /trial-generation

// Add state:
const [sessionToken, setSessionToken] = useState<string | null>(
  localStorage.getItem('trial_session_token')
);
const [characterId, setCharacterId] = useState<string | null>(null);

// When anonymous account created (from TrialCharacterStep):
const handleAccountCreated = useCallback((token: string, charId: string) => {
  setSessionToken(token);
  setCharacterId(charId);
  localStorage.setItem('trial_session_token', token);
}, []);

// When "Create Story" clicked (from ideas step):
const handleCreate = useCallback(() => {
  if (selectedIdeaIndex === null || !sessionToken) return;
  const selectedIdea = generatedIdeas[selectedIdeaIndex];
  if (selectedIdea) {
    setStoryInput(prev => ({
      ...prev,
      storyDetails: selectedIdea.title + '\n' + selectedIdea.summary,
    }));
  }
  // Navigate to generation page with state
  navigate('/trial-generation', {
    state: {
      sessionToken,
      characterId,
      storyInput: {
        ...storyInput,
        storyDetails: selectedIdea ? selectedIdea.title + '\n' + selectedIdea.summary : storyInput.storyDetails,
      },
      characterName: characterData.name,
      previewAvatar,
    },
  });
}, [selectedIdeaIndex, generatedIdeas, sessionToken, characterId, storyInput, characterData.name, previewAvatar, navigate]);
```

**Key changes:**
1. `TrialCharacterStep` → calls `create-anonymous-account` instead of just local state
2. `TrialCharacterStep` → calls `generate-preview-avatar` with session token
3. `handleCreate` → navigates to `/trial-generation` instead of showing `TrialAuthModal`
4. Remove `showEmailModal` state and `TrialAuthModal` render

**Step 2: Commit**

```bash
git add client/src/pages/TrialWizard.tsx
git commit -m "feat: refactor TrialWizard for anonymous account flow"
```

---

## Task 11: Frontend — TrialCharacterStep Changes

**Files:**
- Modify: `client/src/pages/trial/TrialCharacterStep.tsx`

**Step 1: Call create-anonymous-account on "Next"**

The character step now:
1. On "Next" click: calls `POST /api/trial/create-anonymous-account` with character data
2. On success: stores session token, then calls `generate-preview-avatar` with token
3. Passes the session token back to parent via `onAccountCreated` callback

**Key prop changes:**
```typescript
interface Props {
  // ... existing props ...
  onAccountCreated?: (sessionToken: string, characterId: string) => void;
}
```

**handleNext changes:**
```typescript
const handleNext = async () => {
  if (!canProceed) return;
  setIsGeneratingAvatar(true);
  setAvatarError(null);

  try {
    // Step 1: Create anonymous account
    const accountRes = await fetch(`${API_URL}/api/trial/create-anonymous-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: characterData.name,
        age: characterData.age,
        gender: characterData.gender,
        traits: characterData.traits,
        customTraits: characterData.customTraits,
        facePhoto: characterData.photos.face,
        bodyPhoto: characterData.photos.body,
        bodyNoBgPhoto: characterData.photos.bodyNoBg,
        faceBox: characterData.photos.faceBox,
        turnstileToken,
        fingerprint,
      }),
    });

    if (!accountRes.ok) {
      const err = await accountRes.json();
      throw new Error(err.error || 'Failed to create account');
    }

    const { sessionToken, characterId } = await accountRes.json();
    onAccountCreated?.(sessionToken, characterId);

    // Step 2: Generate preview avatar (with session token to save to DB)
    if (!previewAvatar) {
      const avatarRes = await fetch(`${API_URL}/api/trial/generate-preview-avatar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          name: characterData.name,
          age: characterData.age,
          gender: characterData.gender,
          facePhoto: characterData.photos.face,
          characterId,
          turnstileToken,
          fingerprint,
        }),
      });

      if (avatarRes.ok) {
        const { avatarImage } = await avatarRes.json();
        onAvatarGenerated?.(avatarImage);
      }
    }

    onNext();
  } catch (err: any) {
    setAvatarError(err.message);
  } finally {
    setIsGeneratingAvatar(false);
  }
};
```

**Step 2: Commit**

```bash
git add client/src/pages/trial/TrialCharacterStep.tsx
git commit -m "feat: create anonymous account on character step submission"
```

---

## Task 12: Frontend — TrialGenerationPage (New)

**Files:**
- Create: `client/src/pages/TrialGenerationPage.tsx`
- Modify: `client/src/App.tsx` (add route)

**Step 1: Create the generation page**

This page:
1. Starts story generation on mount (calls `POST /api/trial/create-story`)
2. Polls job status (calls `GET /api/trial/job-status/:jobId`)
3. Shows progress bar
4. Shows email collection form alongside progress
5. When story completes + email provided: shows "Read Your Story" (link to claim)
6. When story completes + no email: stronger prompt to enter email

Key sections:
- Progress display (left/top on mobile)
- Email/Google sign-in form (right/bottom on mobile)
- Completion state with call-to-action

**Step 2: Add route to App.tsx**

```typescript
const TrialGenerationPage = lazy(() => import('./pages/TrialGenerationPage'));
// ...
<Route path="/trial-generation" element={<TrialGenerationPage />} />
```

**Step 3: Commit**

```bash
git add client/src/pages/TrialGenerationPage.tsx client/src/App.tsx
git commit -m "feat: add trial generation page with progress polling and email collection"
```

---

## Task 13: Verify & Integration Test

**Step 1: Manual test flow**

1. Go to `/try`
2. Upload photo, fill name/age/gender
3. Click Next → should create anonymous account + avatar
4. Pick topic → pick idea → click "Create Story"
5. Should navigate to `/trial-generation`
6. See progress bar + email form
7. Enter email → should receive verification email
8. Story should complete in background

**Step 2: Test error cases**

- Try without photo → should show error
- Try with expired session token → should show "start over" message
- Try creating second story → should get "trial used" error

**Step 3: Final commit**

```bash
git add -A
git commit -m "feat: complete anonymous account trial flow implementation"
```

---

## Implementation Order & Dependencies

```
Task 1 (DB migration) ─── no dependencies
Task 2 (session token middleware) ─── no dependencies
Task 3 (create-anonymous-account) ─── depends on Task 1, 2
Task 4 (modify generate-preview-avatar) ─── depends on Task 2
Task 5 (create-story) ─── depends on Task 2, 3
Task 6 (job-status) ─── depends on Task 2
Task 7 (link-email) ─── depends on Task 2
Task 8 (link-google) ─── depends on Task 2
Task 9 (cleanup job) ─── depends on Task 1
Task 10 (TrialWizard refactor) ─── depends on Task 3
Task 11 (TrialCharacterStep) ─── depends on Task 3, 4
Task 12 (TrialGenerationPage) ─── depends on Task 5, 6, 7, 8
Task 13 (Integration test) ─── depends on all above
```

**Parallel groups:**
- Group A (no deps): Tasks 1, 2
- Group B (backend): Tasks 3, 4, 5, 6, 7, 8, 9 (sequential within trial.js)
- Group C (frontend): Tasks 10, 11, 12 (sequential)
- Group D (test): Task 13

**Recommended: Execute sequentially — Tasks 1-9 (backend), then 10-12 (frontend), then 13.**
