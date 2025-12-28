/**
 * Auth Routes - /api/auth/*
 *
 * Authentication endpoints: register, login, password reset, email verification
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { dbQuery, isDatabaseMode, logActivity, getPool } = require('../services/database');
const { authenticateToken, generateToken, JWT_SECRET } = require('../middleware/auth');
const { authLimiter, registerLimiter, passwordResetLimiter } = require('../middleware/rateLimit');
const { validateBody, schemas, sanitizeString } = require('../middleware/validation');
const { log } = require('../utils/logger');

// Firebase Admin SDK - import if available
let firebaseAdmin = null;
try {
  firebaseAdmin = require('firebase-admin');
} catch (e) {
  console.warn('Firebase Admin SDK not available');
}

// Email service
let emailService = null;
try {
  emailService = require('../../email');
} catch (e) {
  console.warn('Email service not available');
}

// POST /api/auth/register
router.post('/register', registerLimiter, validateBody(schemas.register), async (req, res) => {
  try {
    // Bot protection: honeypot field (should be empty)
    if (req.body.website || req.body.url || req.body.homepage) {
      log.warn(`🤖 Bot detected: honeypot field filled from IP ${req.ip}`);
      // Return success to confuse bots, but don't actually register
      return res.json({ success: true, message: 'Registration successful' });
    }

    // Bot protection: form submission time check (too fast = bot)
    const formStartTime = parseInt(req.body._formStartTime) || 0;
    if (formStartTime > 0) {
      const submissionTime = Date.now() - formStartTime;
      if (submissionTime < 3000) { // Less than 3 seconds = likely bot
        log.warn(`🤖 Bot detected: form submitted too fast (${submissionTime}ms) from IP ${req.ip}`);
        return res.json({ success: true, message: 'Registration successful' });
      }
    }

    const username = sanitizeString(req.body.username, 30);
    const password = req.body.password; // Don't sanitize password
    const email = sanitizeString(req.body.email, 254).toLowerCase();

    const hashedPassword = await bcrypt.hash(password, 10);
    let newUser;

    if (isDatabaseMode()) {
      // Check if user already exists
      const existing = await dbQuery('SELECT id FROM users WHERE username = $1', [username]);
      if (existing.length > 0) {
        return res.status(400).json({ error: 'This email is already registered' });
      }

      // Check if first user (will be admin)
      const userCount = await dbQuery('SELECT COUNT(*) as count FROM users', []);
      const isFirstUser = parseInt(userCount[0].count) === 0;

      const userId = Date.now().toString();
      const role = isFirstUser ? 'admin' : 'user';
      const storyQuota = isFirstUser ? -1 : 2;
      const initialCredits = isFirstUser ? -1 : 500;

      await dbQuery(
        'INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [userId, username, username, hashedPassword, role, storyQuota, 0, initialCredits]
      );

      // Create initial credit transaction
      if (initialCredits > 0) {
        await dbQuery(
          'INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description) VALUES ($1, $2, $3, $4, $5)',
          [userId, initialCredits, initialCredits, 'initial', 'Welcome credits for new account']
        );
      }

      newUser = { id: userId, username, email: username, role, storyQuota, storiesGenerated: 0, credits: initialCredits };

      // Auto-verify admins, regular users will be prompted to verify when they try to generate a story
      if (role === 'admin') {
        await dbQuery('UPDATE users SET email_verified = TRUE WHERE id = $1', [userId]);
      }
      // Note: Verification email is NOT sent on registration - it will be sent when user tries to generate a story
      // This provides better UX (less spam) and users can browse/upload photos first
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(newUser.id, username, 'USER_REGISTERED', { email });

    const token = generateToken(newUser);

    console.log(`✅ User registered: ${newUser.username} (role: ${newUser.role})`);

    res.json({
      token,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        role: newUser.role,
        storyQuota: newUser.storyQuota,
        storiesGenerated: newUser.storiesGenerated,
        credits: newUser.credits
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    let user;

    if (isDatabaseMode()) {
      const rows = await dbQuery('SELECT * FROM users WHERE username = $1', [username]);
      if (rows.length === 0) {
        return res.status(401).json({ error: 'Email not registered', code: 'EMAIL_NOT_REGISTERED' });
      }

      const dbUser = rows[0];
      user = {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        password: dbUser.password,
        role: dbUser.role,
        storyQuota: dbUser.story_quota,
        storiesGenerated: dbUser.stories_generated,
        credits: dbUser.credits !== undefined ? dbUser.credits : 500,
        preferredLanguage: dbUser.preferred_language || 'English',
        emailVerified: dbUser.email_verified !== false,
        photoConsentAt: dbUser.photo_consent_at || null
      };
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await logActivity(user.id, username, 'USER_LOGIN', {});
    await dbQuery('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    const token = generateToken(user);

    console.log(`✅ User logged in: ${user.username} (role: ${user.role})`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 2,
        storiesGenerated: user.storiesGenerated || 0,
        credits: user.credits != null ? user.credits : 500,
        preferredLanguage: user.preferredLanguage || 'English',
        emailVerified: user.emailVerified !== false,
        photoConsentAt: user.photoConsentAt || null
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me - Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (isDatabaseMode()) {
      const rows = await dbQuery('SELECT * FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const dbUser = rows[0];
      console.log(`[AUTH /me] User ${dbUser.username}: email_verified in DB = ${dbUser.email_verified} (type: ${typeof dbUser.email_verified})`);
      const emailVerifiedResult = dbUser.email_verified !== false;
      console.log(`[AUTH /me] Returning emailVerified = ${emailVerifiedResult}`);
      res.json({
        user: {
          id: dbUser.id,
          username: dbUser.username,
          email: dbUser.email,
          role: dbUser.role,
          storyQuota: dbUser.story_quota !== undefined ? dbUser.story_quota : 2,
          storiesGenerated: dbUser.stories_generated || 0,
          credits: dbUser.credits != null ? dbUser.credits : 500,
          preferredLanguage: dbUser.preferred_language || 'English',
          emailVerified: emailVerifiedResult,
          photoConsentAt: dbUser.photo_consent_at || null
        }
      });
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// POST /api/auth/firebase - Firebase authentication (Google, Apple)
router.post('/firebase', authLimiter, async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'ID token required' });
    }

    if (!firebaseAdmin || !firebaseAdmin.apps.length) {
      return res.status(500).json({ error: 'Firebase authentication not configured on server' });
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
    const { uid, email: firebaseEmail, name } = decodedToken;
    const username = firebaseEmail || `firebase_${uid}`;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Firebase auth requires database mode' });
    }

    const existingUser = await dbQuery('SELECT * FROM users WHERE username = $1', [username]);
    let user;

    if (existingUser.length > 0) {
      user = existingUser[0];
      // Firebase/Google users are already verified by Google - ensure email_verified is TRUE
      if (user.email_verified !== true) {
        await dbQuery('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);
        user.email_verified = true;
      }
      await logActivity(user.id, username, 'USER_LOGIN_FIREBASE', { provider: decodedToken.firebase?.sign_in_provider });
    } else {
      // Create new user
      const userCount = await dbQuery('SELECT COUNT(*) as count FROM users', []);
      const isFirstUser = parseInt(userCount[0].count) === 0;
      const role = isFirstUser ? 'admin' : 'user';
      const storyQuota = isFirstUser ? 999 : 2;
      const initialCredits = isFirstUser ? -1 : 500;

      const randomPassword = crypto.randomBytes(32).toString('hex');
      const hashedPassword = await bcrypt.hash(randomPassword, 10);

      const result = await dbQuery(
        'INSERT INTO users (username, email, password, role, story_quota, stories_generated, credits, email_verified) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE) RETURNING *',
        [username, firebaseEmail, hashedPassword, role, storyQuota, 0, initialCredits]
      );
      user = result[0];

      if (initialCredits > 0) {
        await dbQuery(
          'INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description) VALUES ($1, $2, $3, $4, $5)',
          [user.id, initialCredits, initialCredits, 'initial', 'Welcome credits for new account']
        );
      }

      await logActivity(user.id, username, 'USER_REGISTERED_FIREBASE', { provider: decodedToken.firebase?.sign_in_provider });
      console.log(`✅ New Firebase user registered: ${username} (role: ${role})`);
    }

    await dbQuery('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

    const token = generateToken(user);

    console.log(`✅ Firebase user authenticated: ${username}`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email || firebaseEmail,
        role: user.role,
        storyQuota: user.story_quota !== undefined ? user.story_quota : 2,
        storiesGenerated: user.stories_generated || 0,
        credits: user.credits != null ? user.credits : 500,
        preferredLanguage: user.preferred_language || 'English',
        emailVerified: true,
        photoConsentAt: user.photo_consent_at || null
      }
    });
  } catch (err) {
    console.error('Firebase auth error:', err);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    res.status(500).json({ error: 'Firebase authentication failed' });
  }
});

// POST /api/auth/reset-password - Request password reset
router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Password reset requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, username, email FROM users WHERE email = $1 OR username = $1',
      [email.toLowerCase()]
    );

    // Always return success to prevent email enumeration
    if (result.rows.length === 0) {
      return res.json({ success: true, message: 'If this email exists, a reset link has been sent' });
    }

    const user = result.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
      [resetToken, resetExpires, user.id]
    );

    if (emailService) {
      const resetUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/reset-password/${resetToken}`;
      const emailResult = await emailService.sendPasswordResetEmail(user.email, user.username, resetUrl);
      if (emailResult.success) {
        console.log(`✅ Password reset email sent to ${user.email}`);
      } else {
        // Log error but don't expose to user (prevent email enumeration)
        console.error(`❌ Password reset email failed for ${user.email}:`, emailResult.error);
      }
    }

    res.json({ success: true, message: 'If this email exists, a reset link has been sent' });
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(500).json({ error: 'Failed to process password reset' });
  }
});

// POST /api/auth/reset-password/confirm - Confirm password reset
// Uses consistent password validation (min 8 chars) via schema
router.post('/reset-password/confirm', passwordResetLimiter, validateBody(schemas.resetPasswordConfirm), async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Password reset requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, email FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = result.rows[0];
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      'UPDATE users SET password = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2',
      [hashedPassword, user.id]
    );

    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (err) {
    console.error('Password reset confirm error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// POST /api/auth/change-password - Change password (authenticated)
// Uses consistent password validation (min 8 chars) via schema
router.post('/change-password', authenticateToken, validateBody(schemas.changePassword), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Password change requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query('SELECT id, password, firebase_uid FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (user.firebase_uid && !user.password) {
      return res.status(400).json({ error: 'Cannot change password for Google accounts.' });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// POST /api/auth/send-verification - Send email verification
// Rate limited: 60 seconds between emails
const VERIFICATION_EMAIL_COOLDOWN_SECONDS = 60;

router.post('/send-verification', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Email verification requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, username, email, email_verified, email_verification_expires, last_verification_email_sent FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    if (user.email_verified) {
      return res.json({ success: true, message: 'Email already verified' });
    }

    // Check cooldown - prevent spamming verification emails
    if (user.last_verification_email_sent) {
      const lastSent = new Date(user.last_verification_email_sent);
      const secondsSinceLastSent = (Date.now() - lastSent.getTime()) / 1000;
      const remainingCooldown = Math.ceil(VERIFICATION_EMAIL_COOLDOWN_SECONDS - secondsSinceLastSent);

      if (remainingCooldown > 0) {
        return res.status(429).json({
          error: 'Please wait before requesting another verification email',
          retryAfter: remainingCooldown
        });
      }
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      'UPDATE users SET email_verification_token = $1, email_verification_expires = $2, last_verification_email_sent = NOW() WHERE id = $3',
      [verificationToken, verificationExpires, user.id]
    );

    if (!emailService) {
      console.error('❌ Email service not available - cannot send verification email');
      return res.status(500).json({ error: 'Email service not configured. Please contact support.' });
    }

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
    console.log(`📧 Sending verification email to: ${user.email}, URL: ${verifyUrl}`);

    const emailResult = await emailService.sendEmailVerificationEmail(user.email, user.username, verifyUrl);

    if (!emailResult.success) {
      console.error(`❌ Failed to send verification email to ${user.email}:`, emailResult.error);
      // Distinguish between retryable and permanent errors
      const statusCode = emailResult.error?.isRetryable ? 503 : 500;
      return res.status(statusCode).json({
        error: emailResult.error?.isRetryable
          ? 'Email service temporarily unavailable. Please try again later.'
          : 'Failed to send verification email.'
      });
    }

    console.log(`✅ Verification email sent successfully to ${user.email}`);
    res.json({ success: true, message: 'Verification email sent', cooldown: VERIFICATION_EMAIL_COOLDOWN_SECONDS });
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// GET /api/auth/verify-email/:token - Verify email
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Email verification requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, email FROM users WHERE email_verification_token = $1 AND email_verification_expires > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    const user = result.rows[0];

    await pool.query(
      'UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1',
      [user.id]
    );

    res.redirect(`${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/email-verified`);
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// POST /api/auth/change-email - Change email (requires password)
router.post('/change-email', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { newEmail, password } = req.body;

    if (!newEmail || !password) {
      return res.status(400).json({ error: 'New email and current password are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Email change requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query('SELECT id, username, email, password FROM users WHERE id = $1', [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const existingEmail = await pool.query(
      'SELECT id FROM users WHERE (email = $1 OR username = $1) AND id != $2',
      [newEmail.toLowerCase(), userId]
    );

    if (existingEmail.rows.length > 0) {
      return res.status(400).json({ error: 'This email is already registered' });
    }

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.query(
      `UPDATE users SET email = $1, username = $1, email_verified = FALSE, email_verification_token = $2, email_verification_expires = $3 WHERE id = $4`,
      [newEmail.toLowerCase(), verificationToken, verificationExpires, userId]
    );

    if (emailService) {
      const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
      const emailResult = await emailService.sendEmailVerificationEmail(newEmail, user.username, verifyUrl);
      if (!emailResult.success) {
        console.error(`❌ Failed to send verification email for email change:`, emailResult.error);
        // Email was already changed in DB, but verification email failed
        // Still return success but log the error
      }
    }

    res.json({
      success: true,
      message: 'Email changed. Please verify your new email address.',
      newEmail: newEmail.toLowerCase()
    });
  } catch (err) {
    console.error('Change email error:', err);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

// GET /api/auth/verification-status - Check email verification status
router.get('/verification-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (isDatabaseMode()) {
      const pool = getPool();
      const result = await pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ emailVerified: result.rows[0].email_verified });
    } else {
      res.json({ emailVerified: true });
    }
  } catch (err) {
    console.error('Verification status error:', err);
    res.status(500).json({ error: 'Failed to check verification status' });
  }
});

// POST /api/auth/refresh - Refresh JWT token
router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Token refresh requires database mode' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT id, username, email, role, credits, preferred_language, email_verified, photo_consent_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    // Generate new token with same 7-day expiry
    const newToken = generateToken(user);

    // Log the refresh
    await logActivity(userId, user.username, 'TOKEN_REFRESHED', {});

    res.json({
      token: newToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: user.credits,
        preferredLanguage: user.preferred_language,
        emailVerified: user.email_verified,
        photoConsentAt: user.photo_consent_at || null,
      },
    });
  } catch (err) {
    console.error('Token refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh token' });
  }
});

// POST /api/auth/photo-consent - Record user's photo upload consent
router.post('/photo-consent', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'Photo consent requires database mode' });
    }

    const pool = getPool();

    // Check if already consented
    const existing = await pool.query('SELECT photo_consent_at FROM users WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (existing.rows[0].photo_consent_at) {
      // Already consented, just return the existing timestamp
      return res.json({
        success: true,
        photoConsentAt: existing.rows[0].photo_consent_at,
        message: 'Consent already recorded'
      });
    }

    // Record consent
    const result = await pool.query(
      'UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING photo_consent_at',
      [userId]
    );

    await logActivity(userId, req.user.username, 'PHOTO_CONSENT_GIVEN', {});
    console.log(`✅ Photo consent recorded for user: ${req.user.username}`);

    res.json({
      success: true,
      photoConsentAt: result.rows[0].photo_consent_at,
      message: 'Consent recorded successfully'
    });
  } catch (err) {
    console.error('Photo consent error:', err);
    res.status(500).json({ error: 'Failed to record consent' });
  }
});

// POST /api/auth/logout - Logout and invalidate token (best effort)
// Note: Full token blacklisting would require Redis or similar
// This endpoint logs the logout for audit purposes
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const username = req.user.username;

    // Log the logout
    await logActivity(userId, username, 'LOGOUT', {});

    log.info(`User ${username} logged out`);

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    // Even if logging fails, consider logout successful
    console.error('Logout logging error:', err);
    res.json({ success: true, message: 'Logged out' });
  }
});

module.exports = router;
