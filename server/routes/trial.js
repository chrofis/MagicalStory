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
const sharp = require('sharp');
const { log } = require('../utils/logger');

// Server.js-local dependencies received via initTrialRoutes()
let deps = {};

function initTrialRoutes(serverDeps) {
  deps = serverDeps;
}

// Trait-extraction cache. The trial flow calls extractTraitsWithGemini twice
// for the same photo — once in generate-preview-avatar, once in
// create-anonymous-account — which adds ~5-7s to the user-visible "Next"
// wait. Caching by photo hash collapses the second call to a synchronous
// lookup. Entries expire after 10 minutes (long enough for a user to fill
// the form, short enough not to leak memory).
const TRAIT_CACHE_TTL_MS = 10 * 60 * 1000;
const traitCache = new Map(); // hash -> { traits, expiresAt }
function _hashPhoto(photoStr) {
  // First 8KB is enough to fingerprint — same photo always hashes to same key.
  const sample = String(photoStr || '').slice(0, 8192);
  return crypto.createHash('sha256').update(sample).digest('hex');
}
function cacheTraits(photoStr, traits) {
  if (!photoStr || !traits) return;
  const hash = _hashPhoto(photoStr);
  traitCache.set(hash, { traits, expiresAt: Date.now() + TRAIT_CACHE_TTL_MS });
  // Opportunistic GC: prune expired entries when the map gets large.
  if (traitCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of traitCache) {
      if (v.expiresAt < now) traitCache.delete(k);
    }
  }
}
function getCachedTraits(photoStr) {
  if (!photoStr) return null;
  const entry = traitCache.get(_hashPhoto(photoStr));
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.traits;
}

// Rate limiters for unauthenticated trial endpoints
// Explicit MemoryStore refs so admin can call resetAll()
const { MemoryStore } = rateLimit;
const trialPhotoStore = new MemoryStore();
const trialPhotoLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  store: trialPhotoStore,
  message: { error: 'Too many photo uploads. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const trialIdeasStore = new MemoryStore();
const trialIdeasLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: trialIdeasStore,
  message: { error: 'Too many idea generations. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const titlePageStore = new MemoryStore();
const titlePageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  store: titlePageStore,
  message: { error: 'Too many title page requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registry of in-flight title-page generation promises, keyed by userId.
// The trial /start route awaits these so styled avatars are persisted before
// the story job reads the character DB — avoiding duplicate avatar styling.
const inFlightTitlePagePromises = new Map(); // userId -> Promise

// ─── Admin bypass: admins can test the trial flow repeatedly ─────────────────
// Checks for an adminToken in req.body — if it decodes to a valid admin JWT,
// returns true so the caller can skip turnstile/fingerprint/quota checks.
// Admin bypass uses a short-lived HMAC token instead of the primary JWT.
// The frontend creates this via /api/trial/admin-bypass-token (authenticated),
// and the trial endpoint verifies the HMAC without ever seeing the admin JWT.
const BYPASS_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isAdminRequest(req) {
  const token = req.body?.adminToken;
  if (!token) return false;
  try {
    const crypto = require('crypto');
    const secret = process.env.JWT_SECRET;
    if (!secret) return false;
    // Token format: "timestamp:hmac"
    const [ts, sig] = token.split(':');
    if (!ts || !sig) return false;
    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp) || Date.now() - timestamp > BYPASS_TTL_MS) return false;
    const expected = crypto.createHmac('sha256', secret).update(`trial-bypass:${ts}`).digest('hex');
    // Constant-time comparison. The old `sig === expected` short-circuits
    // on the first mismatched byte, leaking timing information that lets a
    // network-positioned attacker brute-force the HMAC one byte at a time.
    // Both buffers must be the same length for timingSafeEqual; if not,
    // bail out fast (the length itself is not secret).
    const sigBuf = Buffer.from(sig, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch { return false; }
}

// Authenticated endpoint: admin gets a short-lived HMAC token for trial bypass.
// This token is NOT the JWT — it's a purpose-scoped, 5-minute HMAC.
const { authenticateToken } = require('../middleware/auth');
router.get('/admin-bypass-token', authenticateToken, (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const hmac = require('crypto');
  const ts = Date.now().toString();
  const sig = hmac.createHmac('sha256', process.env.JWT_SECRET).update(`trial-bypass:${ts}`).digest('hex');
  res.json({ token: `${ts}:${sig}` });
});

// ─── Abuse Prevention: Turnstile + Fingerprint + Daily Cap ──────────────────

const { trialAvatarLimiter, jobStatusLimiter } = require('../middleware/rateLimit');

// Global daily trial counter — in-memory cache backed by DB persistence
// In-memory for fast cap checks, synced to DB for history across deploys
const dailyTrialCounter = {
  count: 0,
  date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
  avatarCount: 0,
  loaded: false, // true once we've loaded from DB
};
const DAILY_TRIAL_STORY_CAP = 50;
const DAILY_TRIAL_AVATAR_CAP = 100; // Avatars are cheaper ($0.04 each)

/** Load today's counters from DB on startup (call once after DB init) */
async function loadTrialCountersFromDb() {
  try {
    const { getPool } = require('../services/database');
    const pool = getPool();
    if (!pool) return;
    const today = new Date().toISOString().slice(0, 10);
    const result = await pool.query(
      'SELECT stories_generated, avatars_generated FROM trial_daily_stats WHERE date = $1',
      [today]
    );
    if (result.rows.length > 0) {
      dailyTrialCounter.count = result.rows[0].stories_generated;
      dailyTrialCounter.avatarCount = result.rows[0].avatars_generated;
      dailyTrialCounter.date = today;
      log.info(`[TRIAL CAP] Loaded from DB: ${dailyTrialCounter.count} stories, ${dailyTrialCounter.avatarCount} avatars for ${today}`);
    }
    dailyTrialCounter.loaded = true;
  } catch (err) {
    log.warn(`[TRIAL CAP] Failed to load from DB: ${err.message}`);
  }
}

/** Persist current counters to DB (fire-and-forget) */
function syncTrialCountersToDb() {
  try {
    const { getPool } = require('../services/database');
    const pool = getPool();
    if (!pool) return;
    pool.query(
      `INSERT INTO trial_daily_stats (date, stories_generated, avatars_generated, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (date) DO UPDATE SET
         stories_generated = $2, avatars_generated = $3, updated_at = NOW()`,
      [dailyTrialCounter.date, dailyTrialCounter.count, dailyTrialCounter.avatarCount]
    ).catch(err => log.warn(`[TRIAL CAP] DB sync failed: ${err.message}`));
  } catch (err) {
    log.warn(`[TRIAL CAP] DB sync error: ${err.message}`);
  }
}

function checkAndIncrementTrialCap(type = 'story') {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyTrialCounter.date !== today) {
    // New day — reset counters
    dailyTrialCounter.count = 0;
    dailyTrialCounter.avatarCount = 0;
    dailyTrialCounter.date = today;
  }

  if (type === 'avatar') {
    if (dailyTrialCounter.avatarCount >= DAILY_TRIAL_AVATAR_CAP) {
      log.warn(`[TRIAL CAP] Daily avatar cap reached (${dailyTrialCounter.avatarCount}/${DAILY_TRIAL_AVATAR_CAP})`);
      return false;
    }
    dailyTrialCounter.avatarCount++;
    syncTrialCountersToDb();
    return true;
  }

  if (dailyTrialCounter.count >= DAILY_TRIAL_STORY_CAP) {
    log.warn(`[TRIAL CAP] Daily story cap reached (${dailyTrialCounter.count}/${DAILY_TRIAL_STORY_CAP})`);
    return false;
  }
  dailyTrialCounter.count++;
  syncTrialCountersToDb();
  return true;
}

/** Get current trial stats for admin dashboard */
function getTrialStats() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyTrialCounter.date !== today) {
    return { date: today, storiesGenerated: 0, storyCap: DAILY_TRIAL_STORY_CAP, avatarsGenerated: 0, avatarCap: DAILY_TRIAL_AVATAR_CAP };
  }
  return {
    date: dailyTrialCounter.date,
    storiesGenerated: dailyTrialCounter.count,
    storyCap: DAILY_TRIAL_STORY_CAP,
    avatarsGenerated: dailyTrialCounter.avatarCount,
    avatarCap: DAILY_TRIAL_AVATAR_CAP,
  };
}

/** Get trial stats history for admin dashboard */
async function getTrialStatsHistory(days = 30) {
  try {
    const { getPool } = require('../services/database');
    const pool = getPool();
    if (!pool) return [];
    const result = await pool.query(
      `SELECT date, stories_generated, avatars_generated
       FROM trial_daily_stats
       ORDER BY date DESC
       LIMIT $1`,
      [days]
    );
    return result.rows;
  } catch (err) {
    log.warn(`[TRIAL CAP] Failed to load history: ${err.message}`);
    return [];
  }
}

/**
 * Get trial funnel stats for admin dashboard.
 *
 * Returns conversion-funnel metrics for OPEN trial accounts only — i.e. users
 * with `is_trial = true`. On successful claim the trial route flips `is_trial`
 * to FALSE, so this snapshot captures un-claimed trials. The `claimed` count is
 * therefore expected to be 0 in steady state; it's kept in the response to make
 * the funnel shape explicit and to catch any future flow changes.
 *
 * @param {number} days - lookback window in days for unclaimed list (default 30)
 * @returns {Promise<object>}
 */
async function getTrialFunnel(days = 30) {
  try {
    const { getPool } = require('../services/database');
    const pool = getPool();
    if (!pool) {
      return {
        totalTrials: 0,
        trialStoryGenerated: 0,
        trialClaimed: 0,
        trialLoggedInAtLeastOnce: 0,
        trialMultiStory: 0,
        unclaimed: [],
      };
    }

    const since = `${days} days`;

    const countsResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE u.is_trial = true)                                                                    AS total_trials,
         COUNT(*) FILTER (WHERE u.is_trial = true AND EXISTS (SELECT 1 FROM stories s WHERE s.user_id = u.id))        AS trial_story_generated,
         COUNT(*) FILTER (WHERE u.is_trial = true AND u.has_set_password = true)                                       AS trial_claimed,
         COUNT(*) FILTER (WHERE u.is_trial = true AND u.last_login IS NOT NULL)                                        AS trial_logged_in_at_least_once,
         COUNT(*) FILTER (WHERE u.is_trial = true AND u.stories_generated >= 2)                                        AS trial_multi_story
       FROM users u
       WHERE u.is_trial = true
          OR (u.created_at >= NOW() - $1::INTERVAL AND u.is_trial = true)`,
      [since]
    );

    const row = countsResult.rows[0] || {};

    const unclaimedResult = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.username,
         u.created_at,
         u.claim_token_expires
       FROM users u
       WHERE u.is_trial = true
         AND u.claim_token IS NOT NULL
         AND u.claim_token_expires > NOW()
         AND u.created_at >= NOW() - $1::INTERVAL
       ORDER BY u.created_at DESC
       LIMIT 100`,
      [since]
    );

    const now = Date.now();
    const unclaimed = unclaimedResult.rows.map((r) => {
      const expires = r.claim_token_expires ? new Date(r.claim_token_expires) : null;
      const daysUntilExpiry = expires ? Math.max(0, Math.ceil((expires.getTime() - now) / (1000 * 60 * 60 * 24))) : null;
      return {
        id: r.id,
        email: r.email,
        username: r.username,
        createdAt: r.created_at,
        claimTokenExpires: r.claim_token_expires,
        daysUntilExpiry,
      };
    });

    return {
      totalTrials: parseInt(row.total_trials, 10) || 0,
      trialStoryGenerated: parseInt(row.trial_story_generated, 10) || 0,
      trialClaimed: parseInt(row.trial_claimed, 10) || 0,
      trialLoggedInAtLeastOnce: parseInt(row.trial_logged_in_at_least_once, 10) || 0,
      trialMultiStory: parseInt(row.trial_multi_story, 10) || 0,
      unclaimed,
    };
  } catch (err) {
    log.warn(`[TRIAL FUNNEL] Failed to compute funnel: ${err.message}`);
    return {
      totalTrials: 0,
      trialStoryGenerated: 0,
      trialClaimed: 0,
      trialLoggedInAtLeastOnce: 0,
      trialMultiStory: 0,
      unclaimed: [],
    };
  }
}

/**
 * Verify Cloudflare Turnstile token server-side.
 * Returns true if valid, false if invalid or Turnstile unavailable (graceful fallback).
 */
async function verifyTurnstile(token, remoteip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    log.warn('[TURNSTILE] No TURNSTILE_SECRET_KEY configured, skipping verification');
    return true; // Graceful fallback — don't block if not configured
  }
  if (!token) {
    log.warn('[TURNSTILE] No token provided');
    return false;
  }
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip }),
    });
    const data = await response.json();
    if (!data.success) {
      log.warn(`[TURNSTILE] Verification failed: ${JSON.stringify(data['error-codes'] || [])}`);
    }
    return data.success === true;
  } catch (err) {
    log.warn(`[TURNSTILE] Verification error: ${err.message}`);
    return true; // Graceful fallback — don't block if Turnstile is down
  }
}

// In-memory fingerprint tracker (resets on deploy, acceptable — single Railway instance)
const fingerprintTracker = new Map(); // fingerprint -> { count, firstSeen }
const FINGERPRINT_MAX = 1;
const FINGERPRINT_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
const FINGERPRINT_MAX_ENTRIES = 50000; // Memory cap to prevent DoS

function checkFingerprint(fingerprint) {
  if (!fingerprint) return true; // No fingerprint provided, allow (other layers protect)

  // Memory cap — if the map is huge, something is wrong; allow (IP limiter handles it)
  if (fingerprintTracker.size >= FINGERPRINT_MAX_ENTRIES) {
    log.warn(`[FINGERPRINT] Tracker at capacity (${fingerprintTracker.size}), skipping check`);
    return true;
  }

  const now = Date.now();
  const record = fingerprintTracker.get(fingerprint);

  if (!record || (now - record.firstSeen) > FINGERPRINT_WINDOW) {
    fingerprintTracker.set(fingerprint, { count: 1, firstSeen: now });
    return true;
  }

  if (record.count >= FINGERPRINT_MAX) {
    log.warn(`[FINGERPRINT] Blocked: ${fingerprint.substring(0, 8)}... (${record.count} attempts)`);
    return false;
  }

  record.count++;
  return true;
}

// Cleanup stale fingerprint entries every hour (.unref() so it doesn't keep process alive in tests)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [fp, record] of fingerprintTracker) {
    if ((now - record.firstSeen) > FINGERPRINT_WINDOW) {
      fingerprintTracker.delete(fp);
      cleaned++;
    }
  }
  if (cleaned > 0) log.debug(`[FINGERPRINT] Cleaned ${cleaned} stale entries`);
}, 60 * 60 * 1000).unref();

const { verifyToken, signToken } = require('../middleware/auth');

// ─── Session Token for Anonymous Trial Users ─────────────────────────────────

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
    const decoded = verifyToken(token);
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
  return signToken(
    { userId, anonymous: true },
    '24h'
  );
}

// ─── Task 0: Trial Preview Avatar Generation ────────────────────────────────

/**
 * POST /api/trial/generate-preview-avatar
 *
 * Generate a single preview avatar for the "Meet [Name]!" celebration screen.
 * Protected by: IP rate limit + Turnstile + fingerprint.
 * Does NOT create a user account or store anything in the database.
 */
router.post('/generate-preview-avatar', trialAvatarLimiter, async (req, res) => {
  try {
    const { name, age, gender, facePhoto, turnstileToken, fingerprint } = req.body;

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

    // Sanitize name for logging (strip newlines to prevent log injection)
    const safeName = name.replace(/[\r\n]/g, '');

    // Fingerprint + Turnstile verified at account creation instead —
    // preview avatars are non-critical and already rate-limited by trialAvatarLimiter.

    // Check daily cap
    if (!checkAndIncrementTrialCap('avatar')) {
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again tomorrow.' });
    }

    log.info(`[TRIAL AVATAR] Generating preview avatar for "${safeName}" (age: ${age}, gender: ${gender})`);

    // Resize face photo for Gemini
    const base64Input = facePhoto.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Input, 'base64');
    const resizedBuffer = await sharp(inputBuffer)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const resizedBase64 = resizedBuffer.toString('base64');

    // Build avatar prompt using standard clothing from the main avatar prompt template
    const isFemale = gender === 'female';
    const ageNum = parseInt(age) || 7;
    const ageGroup = ageNum <= 5 ? 'toddler' : ageNum <= 8 ? 'young child' : ageNum <= 12 ? 'child' : 'teenager';
    const genderWord = isFemale ? 'girl' : 'boy';

    // Use the same "standard" clothing style as the real avatar generation
    const { getClothingStylePrompt, extractTraitsWithGemini } = require('./avatars');
    const standardClothing = getClothingStylePrompt('standard', isFemale);

    // Extract physical traits from photo (especially hair) for consistent avatar generation
    let hairDescription = '';
    let extractedTraits = null;
    try {
      // Cache hits avoid a second ~5-7s Gemini call when create-anonymous-account
      // runs against the same photo a moment later.
      const cached = getCachedTraits(facePhoto);
      if (cached) {
        extractedTraits = cached;
        log.debug('[TRIAL AVATAR] Trait cache hit');
      } else {
        const photoDataUri = `data:image/jpeg;base64,${resizedBase64}`;
        const traitsResult = await extractTraitsWithGemini(photoDataUri);
        if (traitsResult?.traits) {
          extractedTraits = traitsResult.traits;
          cacheTraits(facePhoto, extractedTraits);
        }
      }
      if (extractedTraits) {
        const { buildHairDescription } = require('../lib/storyHelpers');
        hairDescription = buildHairDescription(extractedTraits);
        if (hairDescription) {
          log.info(`[TRIAL AVATAR] Extracted hair traits: "${hairDescription}"`);
        }
      }
    } catch (traitErr) {
      log.debug(`[TRIAL AVATAR] Trait extraction failed (non-critical): ${traitErr.message}`);
    }

    const hairInstruction = hairDescription
      ? `\n- HAIR: ${hairDescription}. Reproduce this EXACTLY — do not change length, color, or style.`
      : '';

    const prompt = `Create a full-body watercolor illustration of this ${ageGroup} ${genderWord} as a children's book character.

REFERENCE: The attached photo shows the child's face. Match their facial features, skin tone, eye color, and hair color/style EXACTLY.
- Biometric precision: The face must not be averaged or replaced.
- Hair and face must be fully visible. Avoid hats and hoods.
- Ultra-sharp focus on facial features.${hairInstruction}

STYLE: Soft watercolor illustration style for a children's storybook. Warm, friendly, age-appropriate.

POSE: Standing naturally, facing slightly toward the viewer, with a warm smile. Full body visible from head to feet.

CLOTHING: ${standardClothing}

BACKGROUND: Simple, clean white or very light watercolor wash background.

OUTPUT: A single character illustration. No text, no borders, no additional elements.`;

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      log.error('[TRIAL AVATAR] No GEMINI_API_KEY configured');
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    const requestBody = {
      contents: [{
        parts: [
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: resizedBase64
            }
          },
          { text: prompt }
        ]
      }],
      generationConfig: {
        temperature: 0.3,
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: { aspectRatio: '9:16' }
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
      ]
    };

    // Try Gemini with one retry on 503, then fall back to Grok
    let avatarImage = null;
    let safetyBlocked = false;
    let data = null;
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`;

    for (let attempt = 0; attempt < 2 && !avatarImage; attempt++) {
      try {
        if (attempt > 0) {
          log.info(`[TRIAL AVATAR] Retry ${attempt} after 5s delay...`);
          await new Promise(r => setTimeout(r, 5000));
        }
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          log.error(`[TRIAL AVATAR] Gemini API error ${response.status} (attempt ${attempt + 1}): ${errorText.substring(0, 200)}`);
          if (response.status !== 503 && response.status !== 429) break; // Only retry on transient errors
          continue;
        }

        data = await response.json();
        if (data.promptFeedback?.blockReason) {
          log.warn(`[TRIAL AVATAR] Blocked by safety: ${data.promptFeedback.blockReason}`);
          safetyBlocked = true;
          break;
        }

        if (data.candidates?.[0]?.content?.parts) {
          for (const part of data.candidates[0].content.parts) {
            if (part.inlineData?.mimeType?.startsWith('image/')) {
              avatarImage = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
              break;
            }
          }
        }
      } catch (fetchErr) {
        log.error(`[TRIAL AVATAR] Gemini fetch error (attempt ${attempt + 1}): ${fetchErr.message}`);
      }
    }

    if (safetyBlocked) {
      return res.status(422).json({ error: 'Photo could not be processed. Please try a different photo.' });
    }

    // Fallback to Grok if Gemini failed
    if (!avatarImage) {
      try {
        const { generateImageOnly } = require('../lib/images');
        const { isGrokConfigured } = require('../lib/grok');
        if (isGrokConfigured()) {
          log.info('[TRIAL AVATAR] Gemini failed — falling back to Grok');
          const faceDataUri = `data:image/jpeg;base64,${resizedBase64}`;
          const grokResult = await generateImageOnly(prompt, [{ name: `${safeName}_face`, data: faceDataUri }], {
            imageModelOverride: 'grok-imagine',
            imageBackendOverride: 'grok',
            aspectRatio: '9:16',
            skipCache: true
          });
          if (grokResult?.imageData) {
            avatarImage = grokResult.imageData;
            log.info('[TRIAL AVATAR] Grok fallback succeeded');
          }
        }
      } catch (grokErr) {
        log.error(`[TRIAL AVATAR] Grok fallback failed: ${grokErr.message}`);
      }
    }

    if (!avatarImage) {
      log.error('[TRIAL AVATAR] All avatar generation attempts failed');
      return res.status(502).json({ error: 'Avatar generation failed. Please try again.' });
    }

    // Compress to JPEG
    const { compressImageToJPEG } = require('../lib/images');
    const compressed = await compressImageToJPEG(avatarImage, 85, 768);
    const finalImage = compressed || avatarImage;

    const inputTokens = data?.usageMetadata?.promptTokenCount || 0;
    const outputTokens = data?.usageMetadata?.candidatesTokenCount || 0;
    log.info(`[TRIAL AVATAR] ✅ Generated preview avatar for "${safeName}" (${inputTokens} in / ${outputTokens} out)`);

    // If session token provided, save avatar to character in DB
    const authHeader = req.headers['authorization'];
    const sessionTokenStr = authHeader && authHeader.split(' ')[1];
    if (sessionTokenStr && req.body.characterId) {
      try {
        const decoded = verifyToken(sessionTokenStr);
        if (decoded.anonymous && decoded.userId) {
          const { getPool } = require('../services/database');
          const pool = getPool();
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
              // Save extracted physical traits for story generation pipeline
              if (extractedTraits) {
                const physical = charData.characters[0].physical || {};
                if (extractedTraits.hairColor) physical.hairColor = extractedTraits.hairColor;
                if (extractedTraits.eyeColor) physical.eyeColor = extractedTraits.eyeColor;
                if (extractedTraits.skinTone) physical.skinTone = extractedTraits.skinTone;
                if (extractedTraits.apparentAge) physical.apparentAge = extractedTraits.apparentAge;
                if (extractedTraits.detailedHairAnalysis) physical.detailedHairAnalysis = extractedTraits.detailedHairAnalysis;
                charData.characters[0].physical = physical;
              }
              await pool.query(
                'UPDATE characters SET data = $1 WHERE id = $2',
                [JSON.stringify(charData), req.body.characterId]
              );
              log.debug(`[TRIAL AVATAR] Saved avatar${extractedTraits ? ' + physical traits' : ''} to character ${req.body.characterId}`);
            }
          }
        }
      } catch (saveErr) {
        log.warn(`[TRIAL AVATAR] Failed to save avatar to DB: ${saveErr.message}`);
      }
    }

    res.json({ avatarImage: finalImage });

  } catch (err) {
    log.error(`[TRIAL AVATAR] Error: ${err.message}`);
    res.status(500).json({ error: 'Avatar generation failed. Please try again.' });
  }
});

// ─── Anonymous Account Endpoints ────────────────────────────────────────────

/**
 * POST /api/trial/create-anonymous-account
 *
 * Creates an anonymous user + character in the database.
 * Protected by: IP rate limit + Turnstile + fingerprint + daily cap.
 * Returns a session token for subsequent trial API calls.
 */
router.post('/create-anonymous-account', trialAvatarLimiter, async (req, res) => {
  try {
    const { name, age, gender, traits, customTraits, facePhoto, bodyPhoto, bodyNoBgPhoto, faceBox, previewAvatar, turnstileToken, fingerprint } = req.body;

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
    const adminBypass = isAdminRequest(req);

    // Layer 1: Verify Turnstile (skipped for admin testing)
    if (!adminBypass) {
      const turnstileValid = await verifyTurnstile(turnstileToken, req.ip);
      if (!turnstileValid) {
        return res.status(403).json({ error: 'Verification failed. Please try again.' });
      }
    }

    // Layer 2: Check fingerprint (skipped for admin testing)
    if (!adminBypass && !checkFingerprint(fingerprint)) {
      return res.status(429).json({ error: 'Too many attempts. Please try again tomorrow.' });
    }

    log.info(`[TRIAL] Creating anonymous account for "${safeName}"`);

    const { getPool } = require('../services/database');
    const pool = getPool();

    const userId = crypto.randomUUID();
    const bcrypt = require('bcryptjs');
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const hashedPassword = await bcrypt.hash(randomPassword, 10);

    // Consent: the trial wizard requires two consent checkboxes before the photo
    // upload runs (TrialCharacterStep.tsx). By the time we reach account creation
    // the user has explicitly ticked both AND uploaded a photo. Persist the
    // consent timestamp now — there was no user row before this point to bind it
    // to. If they later claim/sign-in with this account, no re-prompt needed.
    await pool.query(
      `INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits, is_trial, anonymous, has_set_password, photo_consent_at)
       VALUES ($1, $2, $3, $4, 'user', 1, 0, 0, true, true, false, CURRENT_TIMESTAMP)`,
      [userId, `anon_${userId}`, `anon_${userId}@anonymous`, hashedPassword]
    );

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

    // Save preview avatar + extract physical traits from face photo
    // Physical traits (hair, eyes, skin tone) are needed for styled avatar prompts
    {
      try {
        const charResult = await pool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
        if (charResult.rows.length > 0) {
          const charData = typeof charResult.rows[0].data === 'string'
            ? JSON.parse(charResult.rows[0].data) : charResult.rows[0].data;
          if (charData.characters && charData.characters[0]) {
            // Save preview avatar if already generated (background generation)
            if (previewAvatar && typeof previewAvatar === 'string' && previewAvatar.startsWith('data:image/')) {
              charData.characters[0].previewAvatar = previewAvatar;
            }
            // Extract physical traits from face photo (non-blocking, best-effort).
            // generate-preview-avatar usually ran first and seeded the cache,
            // saving ~5-7s on the user-visible "Next" wait. Fall back to a
            // fresh extraction if not cached.
            try {
              let t = getCachedTraits(facePhoto);
              if (t) {
                log.debug('[TRIAL] Trait cache hit — skipping second Gemini extraction');
              } else {
                const { extractTraitsWithGemini } = require('./avatars');
                const photoDataUri = facePhoto.startsWith('data:') ? facePhoto : `data:image/jpeg;base64,${facePhoto}`;
                const traitsResult = await extractTraitsWithGemini(photoDataUri);
                if (traitsResult?.traits) {
                  t = traitsResult.traits;
                  cacheTraits(facePhoto, t);
                }
              }
              if (t) {
                const physical = charData.characters[0].physical || {};
                if (t.hairColor) physical.hairColor = t.hairColor;
                if (t.eyeColor) physical.eyeColor = t.eyeColor;
                if (t.skinTone) physical.skinTone = t.skinTone;
                if (t.apparentAge) physical.apparentAge = t.apparentAge;
                if (t.detailedHairAnalysis) physical.detailedHairAnalysis = t.detailedHairAnalysis;
                charData.characters[0].physical = physical;
                log.debug(`[TRIAL] Physical traits set: hair=${physical.hairColor}, eyes=${physical.eyeColor}, skin=${physical.skinTone}`);
              }
            } catch (traitErr) {
              log.debug(`[TRIAL] Physical trait extraction failed (non-critical): ${traitErr.message}`);
            }
            await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
          }
        }
      } catch (saveErr) {
        log.warn(`[TRIAL] Failed to save avatar/traits: ${saveErr.message}`);
      }
    }

    const sessionToken = generateSessionToken(userId);

    log.info(`[TRIAL] Anonymous account created: ${userId} for "${safeName}"`);

    res.json({ sessionToken, userId, characterId, charId });
  } catch (err) {
    log.error(`[TRIAL] create-anonymous-account error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create account. Please try again.' });
  }
});

/**
 * GET /api/trial/check-status
 *
 * Check if this trial user has already used their free story.
 * Returns { trialUsed: boolean }
 */
router.get('/check-status', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { getPool } = require('../services/database');
    const pool = getPool();

    const result = await pool.query(
      'SELECT stories_generated, story_quota, email_verified, email FROM users WHERE id = $1 AND is_trial = true',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = result.rows[0];
    // Mirror the staging bypass from /trial/create-job — on staging we let the
    // same trial user generate multiple stories, so check-status must never
    // report trialUsed=true there or the client refuses to start a new run.
    const isStaging = !!process.env.STAGING_AUTH_PASSWORD;
    const trialUsed = isStaging ? false : (user.stories_generated >= user.story_quota);

    // If trial is used, find their story so we can link to it
    let storyId = null;
    if (trialUsed) {
      const storyResult = await pool.query(
        'SELECT id FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (storyResult.rows.length > 0) {
        storyId = storyResult.rows[0].id;
      }
    }

    // Look up characterId so frontend can restore it for returning users
    let characterId = null;
    const charResult = await pool.query(
      'SELECT id FROM characters WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (charResult.rows.length > 0) {
      characterId = charResult.rows[0].id;
    }

    res.json({
      trialUsed,
      emailVerified: user.email_verified === true,
      hasEmail: !!user.email,
      ...(storyId ? { storyId } : {}),
      ...(characterId ? { characterId } : {}),
    });
  } catch (err) {
    log.error(`[TRIAL] Check status error: ${err.message}`);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

/**
 * POST /api/trial/claim-session
 *
 * Exchange a trial session token for a full JWT auth token.
 * Only works if the user's email has been verified.
 */
router.post('/claim-session', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { getPool } = require('../services/database');
    const pool = getPool();

    const result = await pool.query(
      'SELECT id, username, email, role, email_verified FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const user = result.rows[0];
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email not yet verified' });
    }

    const { generateToken } = require('../middleware/auth');
    const token = generateToken(user);

    log.info(`[TRIAL] Session claimed for user ${userId} (${user.email})`);
    res.json({ token });
  } catch (err) {
    log.error(`[TRIAL] Claim session error: ${err.message}`);
    res.status(500).json({ error: 'Failed to claim session' });
  }
});

/**
 * POST /api/trial/create-story
 *
 * Start story generation for an anonymous trial user.
 * Protected by: session token + 1 story per account + daily cap.
 */
router.post('/create-story', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { storyCategory, storyTopic, storyTheme, storyDetails, language, userLocation } = req.body;

    if (!storyCategory && !storyTopic) {
      return res.status(400).json({ error: 'Story topic is required' });
    }

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Staging bypasses the 1-trial-per-user cap so we can re-test the trial
    // flow without burning fresh accounts each time. Detection: staging is the
    // only environment where STAGING_AUTH_PASSWORD is set (prod leaves it null).
    const isStaging = !!process.env.STAGING_AUTH_PASSWORD;

    // Atomic check-and-increment to prevent race condition (two simultaneous requests).
    // On staging we still increment (so counters are accurate) but drop the < 1 cap.
    const capCondition = isStaging ? '' : 'AND stories_generated < 1';
    const userResult = await pool.query(
      `UPDATE users SET stories_generated = stories_generated + 1
       WHERE id = $1 AND is_trial = true ${capCondition}
       RETURNING id, stories_generated`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      // Either user doesn't exist or already used their trial
      const exists = await pool.query('SELECT id FROM users WHERE id = $1 AND is_trial = true', [userId]);
      if (exists.rows.length === 0) {
        return res.status(404).json({ error: 'Account not found' });
      }
      return res.status(409).json({ error: 'Trial story already used', code: 'TRIAL_USED' });
    }

    if (isStaging && userResult.rows[0].stories_generated > 1) {
      log.info(`[TRIAL] Staging bypass — user ${userId} now at stories_generated=${userResult.rows[0].stories_generated}`);
    }

    // If a prepare-title call is still in flight for this user, wait for it
    // (with a safety timeout) so preGeneratedStyledAvatars are persisted before
    // the trial story job reads the character DB. Avoids duplicate styling work.
    const inFlightTitlePromise = inFlightTitlePagePromises.get(userId);
    if (inFlightTitlePromise) {
      log.info(`[TRIAL] Awaiting in-flight prepare-title for user ${userId} (avoid duplicate avatar styling)`);
      const startWait = Date.now();
      await Promise.race([
        inFlightTitlePromise,
        new Promise(resolve => setTimeout(resolve, 60000)), // 60s max wait
      ]);
      log.info(`[TRIAL] prepare-title wait complete after ${Date.now() - startWait}ms`);
    }

    const characterId = `characters_${userId}`;
    const charResult = await pool.query('SELECT data FROM characters WHERE id = $1', [characterId]);

    if (charResult.rows.length === 0) {
      return res.status(404).json({ error: 'Character not found. Please start over.' });
    }

    const charData = typeof charResult.rows[0].data === 'string'
      ? JSON.parse(charResult.rows[0].data) : charResult.rows[0].data;

    const mainChar = charData.characters[0];
    const characterData = {
      name: mainChar.name,
      age: mainChar.age,
      gender: mainChar.gender,
      traits: mainChar.traits,
      customTraits: mainChar.traits?.specialDetails || '',
      physical: mainChar.physical || {},
      photos: mainChar.photos || {},
      _charId: mainChar.id,
      _preGeneratedStyledAvatars: mainChar.preGeneratedStyledAvatars || null,
      _previewAvatar: mainChar.previewAvatar || null,
    };

    const storyInput = {
      storyCategory: storyCategory || '',
      storyTopic: storyTopic || '',
      storyTheme: storyTheme || '',
      storyDetails: storyDetails || '',
      language: language || 'en',
    };

    // Server-side location fallback if client didn't provide it
    let resolvedLocation = userLocation || null;
    if (!resolvedLocation?.city) {
      try {
        const forwardedFor = req.headers['x-forwarded-for'];
        const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;
        if (ip && ip !== '::1' && ip !== '127.0.0.1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
          const geoResp = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
          const geoData = await geoResp.json();
          if (geoData.status !== 'fail' && geoData.city) {
            resolvedLocation = { city: geoData.city, region: geoData.regionName, country: geoData.country };
            log.info(`[TRIAL] 📍 Server-side location fallback: ${geoData.city}, ${geoData.country} (IP: ${ip})`);
          }
        }
      } catch (e) {
        log.debug(`[TRIAL] Location fallback failed: ${e.message}`);
      }
    } else {
      log.debug(`[TRIAL] Client provided location: ${resolvedLocation.city}, ${resolvedLocation.country || ''}`);
    }

    // Store trial data for later claim (stories_generated already incremented atomically above)
    // Also set preferred_language so emails (story complete, etc.) use the right language
    await pool.query(
      'UPDATE users SET trial_data = $1, preferred_language = $2 WHERE id = $3',
      [JSON.stringify({ characterData, storyInput }), storyInput.language || 'en', userId]
    );

    const jobId = await createTrialStoryJob(pool, userId, characterId, characterData, storyInput, resolvedLocation);

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

/**
 * GET /api/trial/job-status/:jobId
 *
 * Poll story generation progress for anonymous trial users.
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
      createdAt: job.created_at,
      completedAt: job.completed_at,
    };

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
      // Don't expose internal error details to trial users
      response.errorMessage = 'Story generation failed';
    }

    // Fetch page images from checkpoints (progressive display during generation)
    if (job.status !== 'failed') {
      try {
        const pageResult = await pool.query(
          `SELECT step_index, step_data FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_page'
           ORDER BY step_index ASC`,
          [jobId]
        );
        if (pageResult.rows.length > 0) {
          response.pageImages = pageResult.rows
            .filter(row => row.step_data?.imageData)
            .map(row => ({
              pageNumber: row.step_index,
              imageData: row.step_data.imageData
            }));
        }
      } catch (err) {
        log.debug(`[TRIAL] Page images checkpoint query failed: ${err.message}`);
      }
    }

    // Fetch title page from cover checkpoints
    if (req.query.needTitlePage === '1') {
      try {
        const coverResult = await pool.query(
          `SELECT step_data FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_cover' AND step_index = 0
           LIMIT 1`,
          [jobId]
        );
        if (coverResult.rows.length > 0 && coverResult.rows[0].step_data?.imageData) {
          response.titlePageImage = coverResult.rows[0].step_data.imageData;
          if (coverResult.rows[0].step_data?.storyTitle) {
            response.titlePageTitle = coverResult.rows[0].step_data.storyTitle;
          }
        }
      } catch (err) {
        log.debug(`[TRIAL] Cover checkpoint query failed: ${err.message}`);
      }

      // Avatar slides from character data (independent of title page)
      try {
        const charResult = await pool.query('SELECT data FROM characters WHERE id = $1', [`characters_${userId}`]);
        if (charResult.rows.length > 0) {
          const rawData = charResult.rows[0].data;
          const charData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
          const slides = charData?.characters?.[0]?.preGeneratedAvatarSlides;
          if (slides?.length) response.avatarSlides = slides;
        }
      } catch (err) {
        log.debug(`[TRIAL] Avatar slides query failed: ${err.message}`);
      }
    }

    res.json(response);
  } catch (err) {
    log.error(`[TRIAL] job-status error: ${err.message}`);
    res.status(500).json({ error: 'Failed to check job status' });
  }
});

// ─── Link Email to Anonymous Account ────────────────────────────────────────

/**
 * POST /api/trial/link-email
 *
 * Link an email to an anonymous trial account.
 * Sends verification email. Account transitions from anonymous to email-linked.
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

    // Check user exists and email not yet verified
    const userResult = await pool.query(
      'SELECT id, anonymous, email, email_verified FROM users WHERE id = $1 AND is_trial = true',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Allow re-submitting if email not yet verified (e.g. typo in email)
    if (userResult.rows[0].email_verified) {
      return res.status(409).json({ error: 'Email already verified' });
    }

    // Check email not already used by another user
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

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // Store email and verification token (keep anonymous until verified)
    await pool.query(
      `UPDATE users SET
         email = $1,
         username = $1,
         email_verification_token = $2,
         email_verification_expires = $3
       WHERE id = $4`,
      [normalizedEmail, verificationToken, verificationExpires, userId]
    );

    // Send verification email
    const emailService = require('../../email');

    // Get character name for personalization
    const charResult = await pool.query(
      'SELECT metadata FROM characters WHERE user_id = $1',
      [userId]
    );
    const charMeta = charResult.rows[0]?.metadata;
    const parsedMeta = typeof charMeta === 'string' ? JSON.parse(charMeta) : charMeta;
    const displayName = parsedMeta?.characters?.[0]?.name || normalizedEmail.split('@')[0];

    // Get story language
    const trialResult = await pool.query('SELECT trial_data FROM users WHERE id = $1', [userId]);
    const trialData = trialResult.rows[0]?.trial_data;
    const parsedTrial = typeof trialData === 'string' ? JSON.parse(trialData) : trialData;
    const language = parsedTrial?.storyInput?.language || 'en';

    const verifyUrl = `${process.env.FRONTEND_URL || process.env.BASE_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
    await emailService.sendEmailVerificationEmail(normalizedEmail, displayName, verifyUrl, language);

    log.info(`[TRIAL] Email linked for anonymous user ${userId}: ${normalizedEmail}`);
    res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    log.error(`[TRIAL] link-email error: ${err.message}`);
    res.status(500).json({ error: 'Failed to link email. Please try again.' });
  }
});

// ─── Link Google Account to Anonymous Account ───────────────────────────────

/**
 * POST /api/trial/link-google
 *
 * Link a Google account to an anonymous trial user.
 * Google verifies email automatically → converts to non-anonymous.
 * Returns a full auth token (replaces session token).
 */
router.post('/link-google', verifySessionToken, async (req, res) => {
  try {
    const { userId } = req.sessionUser;
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Google token is required' });
    }

    // Verify Google ID token
    const { OAuth2Client } = require('google-auth-library');
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google authentication not configured' });
    }
    const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const decodedToken = ticket.getPayload();
    const googleEmail = decodedToken.email;

    if (!googleEmail) {
      return res.status(400).json({ error: 'Could not get email from Google account' });
    }

    const normalizedEmail = googleEmail.toLowerCase().trim();

    const { getPool } = require('../services/database');
    const pool = getPool();

    // Check user exists and is trial
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

    // Upgrade trial to full account: link Google, give credits, mark verified
    const { CREDIT_CONFIG } = require('../config/credits');
    const fullCredits = CREDIT_CONFIG.LIMITS.INITIAL_USER;
    await pool.query(
      `UPDATE users SET
         email = $1,
         username = $1,
         anonymous = false,
         email_verified = true,
         has_set_password = true,
         is_trial = false,
         credits = $2,
         firebase_uid = $3
       WHERE id = $4`,
      [normalizedEmail, fullCredits, decodedToken.sub, userId]
    );

    // Log credit transaction
    await pool.query(
      'INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description) VALUES ($1, $2, $3, $4, $5)',
      [userId, fullCredits, fullCredits, 'initial', 'Welcome credits (Google sign-up)']
    );

    // Generate full auth token
    const { generateToken } = require('../middleware/auth');
    const updatedUser = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = updatedUser.rows[0];
    const fullToken = generateToken(user);

    log.info(`[TRIAL] Google account linked for user ${userId}: ${normalizedEmail} (${fullCredits} credits)`);

    // Fire the deferred trial-completion email (with PDF). Google verified the
    // email so we can send immediately. Idempotent.
    try {
      const { sendTrialCompletionEmailIfDeferred } = require('../lib/trialEmail');
      sendTrialCompletionEmailIfDeferred(userId).catch(() => {});
    } catch (e) { /* non-fatal */ }

    res.json({
      success: true,
      token: fullToken,
      credits: fullCredits,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: fullCredits,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        emailVerified: true,
        hasPassword: true,
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

// ─── Anonymous Account Cleanup ──────────────────────────────────────────────

// Cleanup abandoned anonymous accounts every 6 hours
// Deletes anonymous users older than 48h who never linked an email
setInterval(async () => {
  try {
    const { getPool, isDatabaseMode } = require('../services/database');
    if (!isDatabaseMode()) return;

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Delete story_jobs for abandoned anonymous users
      const jobsResult = await client.query(`
        DELETE FROM story_jobs
        WHERE user_id IN (
          SELECT id FROM users
          WHERE anonymous = true
            AND created_at < NOW() - INTERVAL '48 hours'
        )
      `);

      // Delete characters for abandoned anonymous users
      const charsResult = await client.query(`
        DELETE FROM characters
        WHERE user_id IN (
          SELECT id FROM users
          WHERE anonymous = true
            AND created_at < NOW() - INTERVAL '48 hours'
        )
      `);

      // Delete the anonymous users themselves
      const usersResult = await client.query(`
        DELETE FROM users
        WHERE anonymous = true
          AND created_at < NOW() - INTERVAL '48 hours'
        RETURNING id
      `);

      await client.query('COMMIT');

      if (usersResult.rowCount > 0) {
        log.info(`[TRIAL CLEANUP] Deleted ${usersResult.rowCount} abandoned anonymous accounts (${charsResult.rowCount} characters, ${jobsResult.rowCount} jobs)`);
      }
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    log.warn(`[TRIAL CLEANUP] Error: ${err.message}`);
  }
}, 6 * 60 * 60 * 1000).unref();

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
      if (!analyzerResponse.ok) {
        const text = await analyzerResponse.text().catch(() => '');
        log.error(`[TRIAL] [PHOTO] Python analyzer HTTP ${analyzerResponse.status}: ${text.substring(0, 200)}`);
        return res.status(502).json({ error: 'Photo analysis service error', details: `HTTP ${analyzerResponse.status}` });
      }
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
          details: analyzerData.error || 'Unknown error'
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
  // Set up SSE headers. Connection: keep-alive is forbidden in HTTP/2 — see
  // storyIdeas.js for the same fix.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  try {
    const { storyCategory, storyTopic, storyTheme, language, characters, userLocation: clientLocation } = req.body;

    log.debug(`[TRIAL] [STREAM] Generating story ideas (unauthenticated)`);
    log.debug(`  Category: ${storyCategory}, Topic: ${storyTopic}, Theme: ${storyTheme}, Language: ${language}`);

    const { callTextModelStreaming } = require('../lib/textModels');
    const { getLanguageInstruction } = require('../lib/languages');
    const modelToUse = 'claude-sonnet';

    log.debug(`  Using model: ${modelToUse}`);

    // Server-side location fallback if client didn't provide it
    let userLocation = clientLocation || null;
    if (!userLocation?.city) {
      try {
        const forwardedFor = req.headers['x-forwarded-for'];
        const ip = forwardedFor ? forwardedFor.split(',')[0].trim() : req.ip;
        if (ip && ip !== '::1' && ip !== '127.0.0.1' && !ip.startsWith('192.168.') && !ip.startsWith('10.')) {
          const geoResp = await fetch(`http://ip-api.com/json/${ip}?fields=status,city,regionName,country`);
          const geoData = await geoResp.json();
          if (geoData.status !== 'fail' && geoData.city) {
            userLocation = { city: geoData.city, region: geoData.regionName, country: geoData.country };
            log.info(`[TRIAL] 📍 Ideas: server-side location fallback: ${geoData.city} (IP: ${ip})`);
          }
        }
      } catch (e) {
        log.debug(`[TRIAL] Ideas location fallback failed: ${e.message}`);
      }
    }

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
    } else if (storyCategory === 'swiss-stories') {
      const { getSwissStoryResearch, getSwissCityById } = require('../lib/swissStories');
      const cityId = (storyTopic || '').replace(/-\d+$/, '');
      const cityMeta = getSwissCityById(cityId);
      const cityName = cityMeta?.name?.en || cityId;
      categoryContext = `This is a Swiss local story set in ${cityName}. Use real local landmarks and cultural elements from this city. Keep it age-appropriate and engaging.`;
    } else {
      categoryContext = `This is a ${storyTheme || 'adventure'} story${storyTopic ? ` about "${storyTopic}"` : ''}. Make it exciting and appropriate for children.`;
    }

    const langInstruction = getLanguageInstruction(language);

    // Look up landmarks if user location is available (best-effort, top 3)
    let landmarksText = '';
    if (userLocation?.city && storyCategory !== 'historical') {
      try {
        const { getIndexedLandmarks } = require('../lib/landmarkPhotos');
        const landmarks = await getIndexedLandmarks(userLocation, 3);
        if (landmarks.length > 0) {
          landmarksText = 'At least one scene must take place at one of these real local landmarks: ' + landmarks.map(l => l.name).join(', ') + '.';
          log.debug(`  [LANDMARK] Including ${landmarks.length} landmarks: ${landmarks.map(l => l.name).join(', ')}`);
        }
      } catch (err) {
        log.debug(`  [LANDMARK] Lookup failed: ${err.message}`);
      }
    }

    // Look up pre-defined title for this topic
    const { getTrialTitle } = require('../config/trialTitles');
    const mainGender = mainChar?.gender || 'male';
    const trialTitle = getTrialTitle(storyTopic, storyCategory, mainGender, language);

    // Load prompt template from prompts/trial-idea.txt
    const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

    const prompt1 = fillTemplate(PROMPT_TEMPLATES.trialIdea, {
      CHARACTER: charDesc,
      CATEGORY_CONTEXT: categoryContext,
      TITLE: trialTitle || '',
      LANDMARKS: landmarksText,
      LANG_INSTRUCTION: langInstruction,
    });
    const prompt2 = prompt1 + '\nGenerate a DIFFERENT idea than the first one — different conflict, different setting.';

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

    // Stream Story 1 (800 max tokens — 2-3 sentence idea)
    const streamStory1 = callTextModelStreaming(prompt1, 800, (delta, fullText) => {
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

    // Stream Story 2 (800 max tokens — 2-3 sentence idea)
    const streamStory2 = callTextModelStreaming(prompt2, 800, (delta, fullText) => {
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

// ─── Pre-generate Styled Avatars ────────────────────────────────────────────

/**
 * POST /api/trial/prepare-title
 *
 * Pre-generate costumed styled avatars while the user is picking a story idea.
 * Title page image generation has moved into the streaming story pipeline.
 * This is a non-critical optimization — failures return nulls gracefully.
 * Protected by: session token + rate limit.
 */
router.post('/prepare-title', titlePageLimiter, verifySessionToken, async (req, res) => {
  // Register an in-flight promise so /start can await avatar completion
  // (which persists preGeneratedStyledAvatars to DB) before reading character data.
  // Resolves when this handler returns — successfully or with error — guaranteeing
  // any DB writes have happened before /start reads the character row.
  const { userId } = req.sessionUser;
  let resolveInFlight;
  const inFlightPromise = new Promise(resolve => { resolveInFlight = resolve; });
  inFlightTitlePagePromises.set(userId, inFlightPromise);

  try {
    const { storyTopic, storyCategory, storyTheme } = req.body;

    if (!storyCategory || (!storyTopic && !storyTheme)) {
      return res.status(400).json({ error: 'storyCategory and storyTopic or storyTheme are required' });
    }

    // Resolve which topic/category to look up costumes from:
    // - adventure: storyTheme has the theme (pirate, knight, etc.), storyTopic is empty
    // - life-challenge: storyTopic has the challenge, storyTheme has the adventure theme → use storyTheme
    // - historical: storyTopic has the event ID → use storyTopic
    const lookupTopic = storyCategory === 'historical' ? storyTopic : (storyTheme || storyTopic);
    const lookupCategory = storyCategory === 'historical' ? 'historical' : 'adventure';

    log.info(`[TRIAL AVATARS] Preparing styled avatars for user ${userId} (topic: ${storyTopic}, category: ${storyCategory}, theme: ${storyTheme || 'none'}, lookup: ${lookupCategory}/${lookupTopic})`);

    // Load character from DB
    const { getPool } = require('../services/database');
    const pool = getPool();
    const characterId = `characters_${userId}`;

    const charResult = await pool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
    if (charResult.rows.length === 0) {
      log.warn(`[TRIAL AVATARS] No character found for user ${userId}`);
      return res.json({ costumeType: null, avatarSlides: [] });
    }

    const charData = typeof charResult.rows[0].data === 'string'
      ? JSON.parse(charResult.rows[0].data) : charResult.rows[0].data;
    const mainChar = charData.characters?.[0];
    if (!mainChar) {
      log.warn(`[TRIAL AVATARS] No main character in data for user ${userId}`);
      return res.json({ costumeType: null, avatarSlides: [] });
    }

    const gender = mainChar.gender || 'male';

    // Look up costume using the resolved lookup topic/category
    const { getTrialCostume } = require('../config/trialCostumes');
    const costume = getTrialCostume(lookupTopic, lookupCategory, gender);

    // Build character object for styled avatar pipeline
    const character = {
      name: mainChar.name,
      age: mainChar.age,
      gender: mainChar.gender,
      isMainCharacter: true,
      photos: mainChar.photos || {},
      avatars: { standard: mainChar.previewAvatar || null },
      physical: mainChar.physical || {},
    };
    const characters = [character];

    // Determine clothing requirements
    const costumeType = costume ? costume.costumeType : null;

    // Format for prepareStyledAvatars (needs standard/costumed config for on-demand generation)
    const avatarClothingRequirements = {
      [character.name]: {
        standard: { used: true, signature: 'none' },
        costumed: costume
          ? { used: true, costume: costume.costumeType, description: costume.description }
          : { used: false },
      },
    };

    // Build avatar requirements for prepareStyledAvatars
    const avatarRequirements = [
      { pageNumber: 'cover', clothingCategory: 'standard', characterNames: [character.name] },
    ];
    if (costume) {
      avatarRequirements.push({
        pageNumber: 'cover',
        clothingCategory: `costumed:${costume.costumeType}`,
        characterNames: [character.name],
      });
    }

    // Lazy require the styled avatar module
    const { runInCacheScope, prepareStyledAvatars, clearStyledAvatarCache, exportStyledAvatarsForPersistence } = require('../lib/styledAvatars');

    // Run avatar styling inside a cache scope to prevent cross-user collisions
    await runInCacheScope(`title-${userId}`, async () => {
      // Prepare styled avatars (standard + costumed)
      await prepareStyledAvatars(characters, 'watercolor', avatarRequirements, avatarClothingRequirements, null);
      log.info(`[TRIAL AVATARS] Avatar styling complete for "${character.name}"`);

      // Export styled avatars so the pipeline can reuse them (avoid regenerating)
      const styledAvatarExport = exportStyledAvatarsForPersistence(characters, 'watercolor');
      const styledAvatarsData = {};
      for (const [charName, avatars] of styledAvatarExport) {
        styledAvatarsData[charName] = avatars;
      }

      // Clear this scoped cache to free memory
      clearStyledAvatarCache();

      // Split styled avatars into individual front-view images for the generation slideshow
      // Uses cropToFrontColumn which detects the actual separator via Python variance analysis
      const { cropToFrontColumn } = require('../lib/grok');
      const avatarSlides = [];
      // bytesFromAnyImage handles data: URIs, raw base64, and R2 URLs uniformly.
      const r2 = require('../lib/r2');
      try {
        // styledAvatarsData is keyed by character name; each entry is
        //   { standard, winter, summer, costumed: { default: ... } }
        // Walk both levels (character → clothing) to reach the actual avatar
        // bytes. The previous one-level loop produced 0 slides every time
        // because it tried to crop the per-character object as if it were
        // an image — silently skipped via the `typeof !== 'string'` guard.
        const pushSlideFromAvatar = async (avatarValue) => {
          if (!avatarValue) return;
          // Avatar may be a string (data URI or URL) or an object with .imageData/.imageUrl
          let src = null;
          if (typeof avatarValue === 'string') src = avatarValue;
          else if (typeof avatarValue === 'object') src = avatarValue.imageData || avatarValue.imageUrl || avatarValue.url || null;
          if (!src || typeof src !== 'string') return;
          const buf = await r2.bytesFromAnyImage(src);
          if (!buf) return;
          const cropped = await cropToFrontColumn(buf);
          avatarSlides.push(`data:image/jpeg;base64,${cropped.toString('base64')}`);
        };
        for (const perCharAvatars of Object.values(styledAvatarsData)) {
          if (!perCharAvatars || typeof perCharAvatars !== 'object') continue;
          for (const [clothingKey, avatarValue] of Object.entries(perCharAvatars)) {
            // `costumed` is nested one more level (e.g. { default: ..., pirate: ... })
            if (clothingKey === 'costumed' && avatarValue && typeof avatarValue === 'object' && !avatarValue.imageData && !avatarValue.imageUrl) {
              for (const costumeAvatar of Object.values(avatarValue)) {
                await pushSlideFromAvatar(costumeAvatar);
              }
            } else {
              await pushSlideFromAvatar(avatarValue);
            }
          }
        }
        if (avatarSlides.length > 0) {
          log.info(`[TRIAL AVATARS] Split ${avatarSlides.length} styled avatars for slideshow`);
        }
      } catch (splitErr) {
        log.debug(`[TRIAL AVATARS] Avatar split failed (non-critical): ${splitErr.message}`);
      }

      // Store avatar data on character in DB
      try {
        charData.characters[0].preGeneratedCostumeType = costumeType;
        charData.characters[0].preGeneratedStyledAvatars = styledAvatarsData;
        if (avatarSlides.length > 0) charData.characters[0].preGeneratedAvatarSlides = avatarSlides;
        await pool.query(
          'UPDATE characters SET data = $1 WHERE id = $2',
          [JSON.stringify(charData), characterId]
        );
        log.debug(`[TRIAL AVATARS] Saved styled avatars to character ${characterId}`);
      } catch (dbErr) {
        log.warn(`[TRIAL AVATARS] Failed to save avatars to DB: ${dbErr.message}`);
      }

      log.info(`[TRIAL AVATARS] Avatars ready for "${character.name}" (costumeType: ${costumeType}, avatarSlides: ${avatarSlides.length})`);
      res.json({ costumeType, avatarSlides });
    });

  } catch (err) {
    log.error(`[TRIAL AVATARS] Error generating styled avatars: ${err.message}`);
    // Non-critical optimization — return nulls gracefully
    res.json({ costumeType: null, avatarSlides: [] });
  } finally {
    // Always resolve and clean up the in-flight registry, regardless of outcome.
    if (inFlightTitlePagePromises.get(userId) === inFlightPromise) {
      inFlightTitlePagePromises.delete(userId);
    }
    resolveInFlight();
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

  // Convert flat traits array to structured format expected by the wizard
  // Trial sends ['brave', 'curious'], wizard expects { strengths: [...], flaws: [], challenges: [], specialDetails: '...' }
  const rawTraits = characterData.traits || [];
  const structuredTraits = Array.isArray(rawTraits)
    ? { strengths: rawTraits, flaws: [], challenges: [], ...(characterData.customTraits ? { specialDetails: characterData.customTraits } : {}) }
    : rawTraits;

  const character = {
    id: charId,
    name: characterData.name || 'Child',
    age: characterData.age || '',
    gender: characterData.gender || '',
    traits: structuredTraits,
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
      id: charId,
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
async function createTrialStoryJob(pool, userId, characterId, characterData, storyInput, userLocation = null) {
  // Check daily trial story cap (spending safety net)
  if (!checkAndIncrementTrialCap('story')) {
    const err = new Error('Daily trial story limit reached. Please try again tomorrow.');
    err.code = 'TRIAL_CAP_REACHED';
    throw err;
  }

  // Trial generates 5 scenes (= 5 pages in picture-book layout). Previously
  // this was pages=10 with the implicit pages/2 conversion for non-1st-grade,
  // which is gone now — set the explicit scene count directly.
  const pages = 5;

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Build character object for inputData (full data reloaded from DB during processing,
  // but include physical/photos defensively so avatar styling works even without DB reload)
  const trialCharacter = {
    id: characterData._charId,
    name: characterData.name || 'Child',
    age: characterData.age || '',
    gender: characterData.gender || '',
    traits: characterData.traits || [],
    role: 'main',
    isMainCharacter: true,
    physical: characterData.physical || {},
    photos: characterData.photos || {},
    photoUrl: characterData.photos?.face || null,
    bodyPhotoUrl: characterData.photos?.body || null,
    bodyNoBgUrl: characterData.photos?.bodyNoBg || null,
    avatars: characterData._previewAvatar ? { standard: characterData._previewAvatar } : {},
    preGeneratedStyledAvatars: characterData._preGeneratedStyledAvatars || null,
  };

  // Build input_data matching the format expected by processStoryJob
  const inputData = {
    pages,
    language: storyInput.language || 'en',
    languageLevel: 'standard',
    artStyle: 'watercolor',
    storyCategory: storyInput.storyCategory || '',
    storyTopic: storyInput.storyTopic || '',
    storyTheme: storyInput.storyTheme || '',
    storyDetails: storyInput.storyDetails || '',
    characterId,
    characters: [trialCharacter],
    mainCharacters: [trialCharacter.id],
    skipCovers: false,
    titlePageOnly: true, // Only generate title page, skip initialPage and backCover
    enableFullRepair: false, // No repair workflow for trial stories
    skipQualityEval: true, // Skip quality evaluation to save cost
    trialMode: true, // Trial prompt with visual bible backgrounds for early empty scene streaming
    ...(userLocation?.city ? { userLocation } : {}), // IP-based location for landmark personalization
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

    const rowId = rows[0].id;
    const charData = rows[0].data || {};
    const characters = charData.characters || [];

    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];

      // Skip characters that already have avatars or are already generating
      const avatars = char.avatars;
      if (avatars?.standard || avatars?.winter || avatars?.summer || avatars?.hasFullAvatars) {
        log.debug(`[TRIAL] Character ${char.name} already has avatars - skipping`);
        continue;
      }
      if (avatars?.status === 'generating') {
        log.debug(`[TRIAL] Character ${char.name} already generating - skipping`);
        continue;
      }

      // Get face photo for avatar generation
      const facePhoto = getFacePhoto(char);
      if (!facePhoto) {
        log.debug(`[TRIAL] Character ${char.name} has no photo - skipping avatar generation`);
        continue;
      }

      // Mark avatar status as 'generating' in DB so frontend knows not to trigger a duplicate
      // and can show appropriate UI (spinner with "generating" message)
      // Also ensure character id is in metadata (trial saveCharacter didn't include it)
      const generatingStatus = JSON.stringify({ status: 'generating' });
      const charIdJson = JSON.stringify(char.id);
      await dbQuery(
        `UPDATE characters SET
           data = jsonb_set(data, '{characters,${i},avatars}', $1::jsonb, true),
           metadata = jsonb_set(
             jsonb_set(metadata, '{characters,${i},avatars}', $1::jsonb, true),
             '{characters,${i},id}', $3::jsonb, true
           )
         WHERE id = $2`,
        [generatingStatus, rowId, charIdJson]
      );
      log.debug(`[TRIAL] Marked ${char.name} avatars as 'generating' in DB`);

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
      processAvatarJobInBackground(jobId, bodyParams, user, geminiApiKey).catch(async (err) => {
        log.error(`[TRIAL] Avatar generation failed for ${char.name}: ${err.message}`);
        const job = avatarJobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.error = err.message;
        }
        // Mark as failed in DB so frontend can retry
        try {
          const failedStatus = JSON.stringify({ status: 'failed' });
          await dbQuery(
            `UPDATE characters SET
               data = jsonb_set(data, '{characters,${i},avatars}', $1::jsonb, true),
               metadata = jsonb_set(metadata, '{characters,${i},avatars}', $1::jsonb, true)
             WHERE id = $2`,
            [failedStatus, rowId]
          );
        } catch (dbErr) {
          log.error(`[TRIAL] Failed to mark avatar status as failed: ${dbErr.message}`);
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

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
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
    const fullCredits = CREDIT_CONFIG.LIMITS.INITIAL_USER;
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

    // Verify Google ID token
    const { OAuth2Client } = require('google-auth-library');
    const GOOGLE_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google authentication not configured on server' });
    }
    const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const decodedToken = ticket.getPayload();
    const { sub: googleSub, email: googleEmail } = decodedToken;

    if (!googleEmail) {
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
    if (user.email.toLowerCase() !== googleEmail.toLowerCase()) {
      return res.status(400).json({
        error: 'Google account email does not match the trial account email',
      });
    }

    // Link Google account and convert trial to full account with standard credits (500)
    const { CREDIT_CONFIG } = require('../config/credits');
    const fullCredits = CREDIT_CONFIG.LIMITS.INITIAL_USER;
    await pool.query(
      `UPDATE users SET
         firebase_uid = $1,
         is_trial = FALSE,
         credits = $2,
         claim_token = NULL,
         claim_token_expires = NULL
       WHERE id = $3`,
      [googleSub, fullCredits, user.id]
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

/** Reset all in-memory trial rate limiters (admin use) */
function resetTrialRateLimits() {
  // Reset express-rate-limit stores
  trialPhotoStore.resetAll();
  trialIdeasStore.resetAll();
  titlePageStore.resetAll();

  // Reset fingerprint tracker
  const fpCount = fingerprintTracker.size;
  fingerprintTracker.clear();

  // Reset daily counters (in-memory + DB)
  dailyTrialCounter.count = 0;
  dailyTrialCounter.avatarCount = 0;
  dailyTrialCounter.date = new Date().toISOString().slice(0, 10);
  syncTrialCountersToDb();

  log.info(`[TRIAL] Rate limits reset: fingerprints cleared (${fpCount}), daily counters zeroed`);
  return { fingerprintsCleared: fpCount };
}

module.exports = router;
module.exports.initTrialRoutes = initTrialRoutes;
module.exports.saveTrialCharacter = saveTrialCharacter;
module.exports.createTrialStoryJob = createTrialStoryJob;
module.exports.getTrialStats = getTrialStats;
module.exports.getTrialStatsHistory = getTrialStatsHistory;
module.exports.getTrialFunnel = getTrialFunnel;
module.exports.loadTrialCountersFromDb = loadTrialCountersFromDb;
module.exports.checkAndIncrementTrialCap = checkAndIncrementTrialCap;
module.exports.resetTrialRateLimits = resetTrialRateLimits;
module.exports.triggerAvatarGenerationForUser = triggerAvatarGenerationForUser;
