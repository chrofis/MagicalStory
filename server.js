// MagicalStory Backend Server v1.0.4
// Includes: User quota system, email authentication, admin panel, PostgreSQL database support
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const pLimit = require('p-limit');
const crypto = require('crypto');

// LOG_LEVEL controls verbosity: error < warn < info < debug < trace
// Defined early so it can be used throughout initialization
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.info;

const log = {
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  warn: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.warn && console.warn(`[WARN] ${msg}`, ...args),
  info: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.info && console.log(msg, ...args),
  debug: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args),
  trace: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.trace && console.log(`[TRACE] ${msg}`, ...args),
  verbose: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args)
};

// Credit costs for various operations (easy to configure)
const CREDIT_COSTS = {
  IMAGE_REGENERATION: 5,  // Cost to regenerate a single scene image (includes scene description)
};

// Initialize BOTH Stripe clients - test for admins/developers, live for regular users
const stripeTest = process.env.STRIPE_TEST_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_TEST_SECRET_KEY)
  : null;
const stripeLive = process.env.STRIPE_LIVE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_LIVE_SECRET_KEY)
  : null;

// Legacy fallback: if only old env var exists, use it as test
const stripeLegacy = (!stripeTest && process.env.STRIPE_TEST_API_KEY)
  ? require('stripe')(process.env.STRIPE_TEST_API_KEY)
  : null;

// Helper: Get appropriate Stripe client for user (admins get test mode)
function getStripeForUser(user) {
  const isTestMode = user?.role === 'admin';
  if (isTestMode) {
    return stripeTest || stripeLegacy;
  }
  return stripeLive || stripeTest || stripeLegacy; // fallback chain for live users
}

// Helper: Check if user should use test mode
function isUserTestMode(user) {
  return user?.role === 'admin';
}

// Log Stripe configuration on startup
console.log(`💳 Stripe Configuration:`);
console.log(`   - Test mode (for admins): ${stripeTest || stripeLegacy ? '✅ Configured' : '❌ Not configured'}`);
console.log(`   - Live mode (for users): ${stripeLive ? '✅ Configured' : '❌ Not configured'}`);
if (!stripeLive) {
  log.warn(`   ⚠️  Warning: STRIPE_LIVE_SECRET_KEY not set - all users will use test mode`);
}
const sharp = require('sharp');
const email = require('./email');
const admin = require('firebase-admin');

// Import modular routes and services
const { initializePool: initModularPool, logActivity, isDatabaseMode } = require('./server/services/database');
const { validateBody, schemas, sanitizeString, sanitizeInteger } = require('./server/middleware/validation');
const { PROMPT_TEMPLATES, loadPromptTemplates, fillTemplate } = require('./server/services/prompts');
const { generatePrintPdf, generateCombinedBookPdf } = require('./server/lib/pdf');
const { processBookOrder } = require('./server/lib/gelato');
const {
  hashImageData,
  generateImageCacheKey,
  evaluateImageQuality,
  callGeminiAPIForImage,
  editImageWithPrompt,
  generateImageWithQualityRetry,
  clearImageCache,
  deleteFromImageCache,
  compressImageToJPEG,
  autoRepairImage,
  autoRepairWithTargets,
  IMAGE_QUALITY_THRESHOLD
} = require('./server/lib/images');
const {
  TEXT_MODELS,
  MODEL_DEFAULTS,
  getActiveTextModel,
  getTextModelName,
  calculateOptimalBatchSize,
  callTextModel,
  callTextModelStreaming,
  callAnthropicAPI,
  callAnthropicAPIStreaming,
  callGeminiTextAPI,
  callClaudeAPI
} = require('./server/lib/textModels');
const {
  parseVisualBible,
  filterMainCharactersFromVisualBible,
  parseVisualBibleEntries,
  initializeVisualBibleMainCharacters,
  addVisualBibleChangeLog,
  updateMainCharacterOutfit,
  getVisualBibleEntriesForPage,
  buildVisualBiblePrompt,
  buildFullVisualBiblePrompt,
  analyzeVisualBibleElements,
  updateVisualBibleWithExtracted,
  getElementsNeedingAnalysis,
  formatVisualBibleForStoryText,
  parseNewVisualBibleEntries,
  mergeNewVisualBibleEntries,
  extractStoryTextFromOutput
} = require('./server/lib/visualBible');
const {
  ART_STYLES,
  LANGUAGE_LEVELS,
  getReadingLevel,
  getTokensPerPage,
  calculateStoryPageCount,
  getCharactersInScene,
  getCharacterPhotos,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildRelativeHeightDescription,
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  buildBasePrompt,
  buildStoryPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildSceneExpansionPrompt
} = require('./server/lib/storyHelpers');
const configRoutes = require('./server/routes/config');
const healthRoutes = require('./server/routes/health');
const authRoutes = require('./server/routes/auth');
const userRoutes = require('./server/routes/user');
const characterRoutes = require('./server/routes/characters');
const storyDraftRoutes = require('./server/routes/storyDraft');
const storiesRoutes = require('./server/routes/stories');
const filesRoutes = require('./server/routes/files');
const adminRoutes = require('./server/routes/admin');
const photosRoutes = require('./server/routes/photos');

// Initialize Firebase Admin SDK
// Supports: FIREBASE_SERVICE_ACCOUNT_BASE64 (base64), FIREBASE_SERVICE_ACCOUNT (JSON string), or FIREBASE_SERVICE_ACCOUNT_PATH (file path)
let firebaseInitialized = false;

// Try base64 encoded version first (most reliable for complex JSON)
if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    const serviceAccount = JSON.parse(jsonString);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    log.debug('🔥 Firebase Admin SDK initialized from base64 env var');
  } catch (err) {
    log.warn('⚠️  Firebase Admin SDK initialization from base64 failed:', err.message);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Fix newlines in private key if they got escaped
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    log.debug('🔥 Firebase Admin SDK initialized from JSON env var');
  } catch (err) {
    log.warn('⚠️  Firebase Admin SDK initialization failed:', err.message);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  try {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    log.debug('🔥 Firebase Admin SDK initialized from file:', process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } catch (err) {
    log.warn('⚠️  Firebase Admin SDK initialization from file failed:', err.message);
  }
} else {
  log.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not configured - Firebase auth disabled');
  log.warn('⚠️  Available env vars with FIREBASE:', Object.keys(process.env).filter(k => k.includes('FIREBASE')));
}

// NOTE: imageCache moved to server/lib/images.js

// Story Generation Batch Size Configuration
// Set to 0 or a number >= total pages to generate entire story in one API call
// Set to 5-10 for lower API tiers to stay under rate limits (e.g. 8K tokens/minute)
// Recommended values:
//   - Tier 1 (8K tokens/min): 5-8 pages per batch
//   - Tier 2+ (400K tokens/min): 0 (generate all at once)
const STORY_BATCH_SIZE = parseInt(process.env.STORY_BATCH_SIZE) || 0;  // 0 = no batching (generate all at once)

// Image generation mode: 'parallel' (fast) or 'sequential' (consistent - passes previous image)
const IMAGE_GEN_MODE = process.env.IMAGE_GEN_MODE || 'parallel';

// NOTE: IMAGE_QUALITY_THRESHOLD imported from server/lib/images.js

log.info(`📚 Story batch size: ${STORY_BATCH_SIZE === 0 ? 'DISABLED (generate all at once)' : STORY_BATCH_SIZE + ' pages per batch'}`);
log.info(`📊 Log level: ${LOG_LEVEL.toUpperCase()}`);

// =============================================================================
// TEXT MODEL CONFIGURATION
// Set TEXT_MODEL env var to switch between models (default: claude-sonnet)
// =============================================================================
// NOTE: TEXT_MODELS, TEXT_MODEL, activeTextModel imported from server/lib/textModels.js

// NOTE: calculateOptimalBatchSize imported from server/lib/textModels.js
/**
 * Calculate the actual page count for a story
 * Picture book (1st-grade): 1 scene = 1 page (text + image combined)
 * Standard book: 1 scene = 2 pages (text page + image page)
 * @param {Object} storyData - The story data object
 * @param {boolean} includeCoverPages - Whether to add 3 pages for covers (default: true)
 * @returns {number} Total page count
 */
// NOTE: Character helper functions moved to server/lib/storyHelpers.js
// Exports: calculateStoryPageCount, getCharactersInScene, getCharacterPhotos,
// parseClothingCategory, getCharacterPhotoDetails, buildCharacterPhysicalDescription



// NOTE: PROMPT_TEMPLATES, loadPromptTemplates, fillTemplate imported from server/services/prompts.js

const app = express();

// Trust first proxy (Railway, Heroku, etc.) - required for rate limiting to work correctly
// This allows Express to trust X-Forwarded-For headers for client IP detection
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// JWT_SECRET must be set in environment - no fallback for security
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set. Server cannot start securely.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// Database Configuration - PostgreSQL (Railway)
const DATABASE_URL = process.env.DATABASE_URL;

// Debug logging
console.log('🔍 Environment Check:');
log.debug(`  DATABASE_URL: ${DATABASE_URL ? 'SET (length: ' + DATABASE_URL.length + ')' : 'NOT SET'}`);
log.debug(`  STORAGE_MODE: ${process.env.STORAGE_MODE}`);
log.debug(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET (length: ' + process.env.GEMINI_API_KEY.length + ')' : 'NOT SET'}`);
log.debug(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NOT SET'}`);

// Default to file mode for safety - only use database if explicitly configured
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' && DATABASE_URL)
                     ? 'database'
                     : 'file';

log.debug(`📦 Storage mode: ${STORAGE_MODE}`);
if (STORAGE_MODE === 'database') {
  console.log(`🗄️  Database: PostgreSQL (Railway)`);
}

// Database connection pool (PostgreSQL - Railway)
let dbPool = null;
if (STORAGE_MODE === 'database') {
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  log.debug(`✓ PostgreSQL pool created (Railway)`);

  // Initialize the modular database service pool as well
  initModularPool();
  log.debug(`✓ Modular database pool initialized`);
}

// Middleware
// Configure CORS to allow requests from your domains
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or server-to-server)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'http://localhost:8000',
      'http://localhost:3000',
      'http://127.0.0.1:8000',
      'https://www.magicalstory.ch',
      'https://magicalstory.ch'
    ];

    // Also allow any Railway.app domain
    if (origin.includes('railway.app') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      log.warn('⚠️  CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Security headers with helmet
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP as it can interfere with inline scripts/styles
  crossOriginEmbedderPolicy: false, // Allow embedding external resources
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Required for Google OAuth popup
}));

// Rate limiting for authentication endpoints (prevent brute force attacks)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 attempts per window
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Max 5 registrations per hour per IP
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiter (more permissive)
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// AI proxy endpoints rate limiter (prevents abuse of direct AI API calls)
// Generous limit: 60 requests/minute per IP to allow legitimate use
// while preventing runaway costs from abuse
const aiProxyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute per IP
  message: { error: 'Too many AI API requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limit to all API routes
app.use('/api/', apiLimiter);

// Stripe webhook endpoint needs raw body for signature verification
// IMPORTANT: This MUST be defined BEFORE express.json() middleware
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Try both webhook secrets (test and live) to verify the signature
  const testWebhookSecret = process.env.STRIPE_TEST_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  const liveWebhookSecret = process.env.STRIPE_LIVE_WEBHOOK_SECRET;

  if (!testWebhookSecret && !liveWebhookSecret) {
    log.error('❌ [STRIPE WEBHOOK] No webhook secrets configured!');
    log.error('   Please add STRIPE_TEST_WEBHOOK_SECRET and/or STRIPE_LIVE_WEBHOOK_SECRET');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;
  let isTestPayment = false;
  let stripeClient = null;

  // Try to verify with live secret first (most common case for real users)
  if (liveWebhookSecret) {
    try {
      event = (stripeLive || stripeTest || stripeLegacy).webhooks.constructEvent(req.body, sig, liveWebhookSecret);
      stripeClient = stripeLive || stripeTest || stripeLegacy;
      isTestPayment = false;
      console.log('✅ [STRIPE WEBHOOK] Verified with LIVE webhook secret');
    } catch (err) {
      // Live verification failed, will try test secret
    }
  }

  // If live verification failed or no live secret, try test secret
  if (!event && testWebhookSecret) {
    try {
      event = (stripeTest || stripeLegacy || stripeLive).webhooks.constructEvent(req.body, sig, testWebhookSecret);
      stripeClient = stripeTest || stripeLegacy || stripeLive;
      isTestPayment = true;
      console.log('✅ [STRIPE WEBHOOK] Verified with TEST webhook secret');
    } catch (err) {
      log.error('❌ [STRIPE WEBHOOK] Signature verification failed with both secrets:', err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  if (!event) {
    log.error('❌ [STRIPE WEBHOOK] Could not verify webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Now handle the verified event
  try {
    log.debug('💳 [STRIPE WEBHOOK] Received verified event:', event.type);
    log.debug(`   Payment type: ${isTestPayment ? 'TEST (admin/developer)' : 'LIVE (real payment)'}`);

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      console.log('✅ [STRIPE WEBHOOK] Payment successful!');
      console.log('   Session ID:', session.id);
      console.log('   Payment Intent:', session.payment_intent);
      console.log('   Amount:', session.amount_total, session.currency);

      // Retrieve full session with customer details (use the same Stripe client that verified)
      try {
        const fullSession = await stripeClient.checkout.sessions.retrieve(session.id, {
          expand: ['customer', 'line_items']
        });

        // Extract customer information
        const customerInfo = {
          name: fullSession.customer_details?.name || fullSession.shipping?.name || 'N/A',
          email: fullSession.customer_details?.email || 'N/A',
          address: fullSession.shipping?.address || fullSession.customer_details?.address || {}
        };

        log.debug('📦 [STRIPE WEBHOOK] Customer Information:');
        log.debug('   Name:', customerInfo.name);
        console.log('   Email:', customerInfo.email);
        log.debug('   Address:', JSON.stringify(customerInfo.address, null, 2));
        log.debug('   Metadata:', JSON.stringify(fullSession.metadata, null, 2));

        // Check if this is a credits purchase
        if (fullSession.metadata?.type === 'credits') {
          log.debug('💰 [STRIPE WEBHOOK] Processing credits purchase');
          const userId = parseInt(fullSession.metadata?.userId);

          // SERVER-SIDE VALIDATION: Calculate credits from amount paid, don't trust metadata
          // Pricing: CHF 5 = 100 credits, CHF 10 = 200 credits, etc.
          const amountPaid = fullSession.amount_total || 0; // in cents
          const creditsToAdd = Math.floor(amountPaid / 5); // 5 cents = 1 credit (CHF 5 = 500 cents = 100 credits)

          // Sanity check - metadata credits should roughly match calculated credits (allow 10% variance)
          const metadataCredits = parseInt(fullSession.metadata?.credits) || 0;
          if (metadataCredits > 0 && Math.abs(metadataCredits - creditsToAdd) > creditsToAdd * 0.1) {
            log.warn(`⚠️ [STRIPE WEBHOOK] Credit mismatch! Metadata: ${metadataCredits}, Calculated: ${creditsToAdd}. Using calculated value.`);
          }

          if (!userId || isNaN(userId)) {
            log.error('❌ [STRIPE WEBHOOK] Invalid userId for credits purchase:', fullSession.metadata);
            throw new Error('Invalid userId in credits purchase metadata');
          }

          if (STORAGE_MODE === 'database') {
            // IDEMPOTENCY CHECK: Check if this credit purchase was already processed
            const existingTransaction = await dbPool.query(
              'SELECT id FROM credit_transactions WHERE reference_id = $1 AND transaction_type = $2',
              [fullSession.id, 'purchase']
            );

            if (existingTransaction.rows.length > 0) {
              log.warn('⚠️ [STRIPE WEBHOOK] Credits already added for this session, skipping duplicate:', fullSession.id);
              res.json({ received: true, type: 'credits', duplicate: true });
              return;
            }

            // Get current credits
            const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
            if (userResult.rows.length === 0) {
              throw new Error('User not found for credits purchase');
            }

            const currentCredits = userResult.rows[0].credits || 0;
            // Don't add to unlimited credits (-1)
            const newCredits = currentCredits === -1 ? -1 : currentCredits + creditsToAdd;

            // Update credits
            await dbPool.query('UPDATE users SET credits = $1 WHERE id = $2', [newCredits, userId]);

            console.log(`✅ [STRIPE WEBHOOK] Added ${creditsToAdd} credits to user ${userId}`);
            log.debug(`   Previous balance: ${currentCredits}, New balance: ${newCredits}`);

            // Create transaction record
            await dbPool.query(`
              INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
              VALUES ($1, $2, $3, 'purchase', $4, $5)
            `, [userId, creditsToAdd, newCredits, fullSession.id, `Purchased ${creditsToAdd} credits via Stripe (CHF ${(amountPaid / 100).toFixed(2)})`]);

            log.debug('💾 [STRIPE WEBHOOK] Credits transaction recorded');
          }

          res.json({ received: true, type: 'credits' });
          return;
        }

        // Store order in database (book purchase)
        if (STORAGE_MODE === 'database') {
          const userId = parseInt(fullSession.metadata?.userId);
          const address = fullSession.shipping?.address || fullSession.customer_details?.address || {};
          const orderCoverType = fullSession.metadata?.coverType || 'softcover';

          // Validate required metadata
          if (!userId || isNaN(userId)) {
            log.error('❌ [STRIPE WEBHOOK] Invalid or missing userId in metadata:', fullSession.metadata);
            throw new Error('Invalid userId in session metadata');
          }

          // Parse story IDs - support both new storyIds array and legacy storyId
          let allStoryIds = [];
          if (fullSession.metadata?.storyIds) {
            try {
              allStoryIds = JSON.parse(fullSession.metadata.storyIds);
            } catch (e) {
              log.error('❌ [STRIPE WEBHOOK] Failed to parse storyIds:', e);
            }
          }
          // Fallback to legacy single storyId
          if (allStoryIds.length === 0) {
            const storyIdRaw = fullSession.metadata?.storyId || fullSession.metadata?.story_id;
            if (storyIdRaw) {
              allStoryIds = [storyIdRaw];
            }
          }

          if (allStoryIds.length === 0) {
            log.error('❌ [STRIPE WEBHOOK] No story IDs in metadata:', fullSession.metadata);
            throw new Error('Missing story IDs in session metadata - cannot process book order');
          }

          log.debug(`📚 [STRIPE WEBHOOK] Processing order with ${allStoryIds.length} stories:`, allStoryIds);

          // Validate all stories exist
          const validatedStoryIds = [];
          for (const sid of allStoryIds) {
            const result = await dbPool.query('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
            if (result.rows.length > 0) {
              validatedStoryIds.push(sid);
            } else {
              log.warn(`⚠️ [STRIPE WEBHOOK] Story not found: ${sid}, skipping`);
            }
          }

          if (validatedStoryIds.length === 0) {
            log.error('❌ [STRIPE WEBHOOK] No valid stories found for IDs:', allStoryIds);
            log.error('❌ [STRIPE WEBHOOK] User ID:', userId);
            throw new Error('No valid stories found');
          }

          // Use first story ID as the primary for orders table (for backwards compatibility)
          const primaryStoryId = validatedStoryIds[0];

          // IDEMPOTENCY CHECK: Check if this order was already processed
          const existingOrder = await dbPool.query(
            'SELECT id FROM orders WHERE stripe_session_id = $1',
            [fullSession.id]
          );

          if (existingOrder.rows.length > 0) {
            log.warn('⚠️ [STRIPE WEBHOOK] Order already processed, skipping duplicate:', fullSession.id);
            res.json({ received: true, duplicate: true });
            return;
          }

          await dbPool.query(`
            INSERT INTO orders (
              user_id, story_id, stripe_session_id, stripe_payment_intent_id,
              customer_name, customer_email,
              shipping_name, shipping_address_line1, shipping_address_line2,
              shipping_city, shipping_state, shipping_postal_code, shipping_country,
              amount_total, currency, payment_status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
          `, [
            userId, primaryStoryId, fullSession.id, fullSession.payment_intent,
            customerInfo.name, customerInfo.email,
            fullSession.shipping?.name || customerInfo.name,
            address.line1, address.line2,
            address.city, address.state, address.postal_code, address.country,
            fullSession.amount_total, fullSession.currency, fullSession.payment_status
          ]);

          log.debug('💾 [STRIPE WEBHOOK] Order saved to database');
          log.debug('   User ID:', userId);
          log.debug('   Story IDs:', validatedStoryIds.join(', '));

          // Trigger background PDF generation and print provider order (don't await - fire and forget)
          // Pass isTestPayment so Gelato knows whether to create draft or real order
          // Now passing array of storyIds for combined book generation
          processBookOrder(dbPool, fullSession.id, userId, validatedStoryIds, customerInfo, address, isTestPayment, orderCoverType).catch(async (err) => {
            log.error('❌ [BACKGROUND] Error processing book order:', err);
            log.error('   Error stack:', err.stack);
            log.error('   Session ID:', fullSession.id);
            log.error('   User ID:', userId);
            log.error('   Story IDs:', validatedStoryIds.join(', '));
            log.error('   CRITICAL: Customer paid but book order failed! Check database for stripe_session_id:', fullSession.id);

            // Send critical admin alert
            await email.sendAdminOrderFailureAlert(
              fullSession.id,
              customerInfo.email,
              customerInfo.name,
              err.message
            );
          });

          // Send order confirmation email to customer
          // Get language for email localization - prefer user's preference, fall back to story language
          let orderEmailLanguage = 'English';
          try {
            // First try user's preferred language
            const userLangResult = await dbPool.query(
              'SELECT preferred_language FROM users WHERE id = $1',
              [userId]
            );
            if (userLangResult.rows.length > 0 && userLangResult.rows[0].preferred_language) {
              orderEmailLanguage = userLangResult.rows[0].preferred_language;
            } else {
              // Fall back to first story's language
              const storyLangResult = await dbPool.query('SELECT data FROM stories WHERE id = $1', [primaryStoryId]);
              if (storyLangResult.rows.length > 0) {
                const storyData = typeof storyLangResult.rows[0].data === 'string'
                  ? JSON.parse(storyLangResult.rows[0].data)
                  : storyLangResult.rows[0].data;
                orderEmailLanguage = storyData?.inputData?.language || storyData?.language || 'English';
              }
            }
          } catch (e) {
            log.warn('⚠️ Could not get language for order email:', e.message);
          }
          email.sendOrderConfirmationEmail(
            customerInfo.email,
            customerInfo.name,
            {
              orderId: fullSession.id.slice(-8).toUpperCase(),
              amount: (fullSession.amount_total / 100).toFixed(2),
              currency: fullSession.currency.toUpperCase(),
              shippingAddress: address
            },
            orderEmailLanguage
          ).catch(err => log.error('❌ Failed to send order confirmation email:', err));

          console.log('🚀 [STRIPE WEBHOOK] Background processing triggered - customer can leave');
        } else {
          log.warn('⚠️  [STRIPE WEBHOOK] Payment received but STORAGE_MODE is not "database" - order not processed!');
          log.warn('   Current STORAGE_MODE:', STORAGE_MODE);
          log.warn('   Session ID:', fullSession.id);
          log.warn('   Amount:', fullSession.amount_total, fullSession.currency);
          log.warn('   This payment succeeded but the customer will NOT receive their book!');
        }

      } catch (retrieveError) {
        log.error('❌ [STRIPE WEBHOOK] Error retrieving/storing session details:', retrieveError);
        log.error('   Error stack:', retrieveError.stack);
        log.error('   Session ID:', session.id);
        log.error('   This payment succeeded but order processing failed!');
      }
    }

    res.json({ received: true });
  } catch (err) {
    log.error('❌ [STRIPE WEBHOOK] Error processing webhook:', err);
    res.status(400).json({ error: 'Webhook error' });
  }
});

// Gelato webhook endpoint for order status updates
// IMPORTANT: This MUST be defined BEFORE express.json() middleware
app.post('/api/gelato/webhook', express.json(), async (req, res) => {
  try {
    // Verify webhook authorization - REQUIRED for security
    const webhookSecret = process.env.GELATO_WEBHOOK_SECRET;
    const receivedSecret = req.headers['x-gelato-webhook-secret'];

    // Webhook secret is now REQUIRED - reject if not configured
    if (!webhookSecret) {
      log.error('❌ [GELATO WEBHOOK] GELATO_WEBHOOK_SECRET not configured - rejecting webhook');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    if (receivedSecret !== webhookSecret) {
      log.warn('⚠️ [GELATO WEBHOOK] Invalid or missing authorization header');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body;

    log.debug('📦 [GELATO WEBHOOK] Received event:', event.event);
    log.debug('   Order ID:', event.orderId);
    log.debug('   Order Reference:', event.orderReferenceId);
    log.debug('   Status:', event.fulfillmentStatus);

    // Handle different event types
    if (event.event === 'order_status_updated') {
      const { orderId, orderReferenceId, fulfillmentStatus, items } = event;

      // Find the order in our database using Gelato order ID
      const orderResult = await dbPool.query(
        'SELECT id, user_id, customer_email, customer_name, story_id FROM orders WHERE gelato_order_id = $1',
        [orderId]
      );

      if (orderResult.rows.length === 0) {
        log.warn('⚠️ [GELATO WEBHOOK] Order not found for Gelato ID:', orderId);
        // Still return 200 to prevent retries
        return res.status(200).json({ received: true, warning: 'Order not found' });
      }

      const order = orderResult.rows[0];
      log.debug('   Found order ID:', order.id);
      log.debug('   Customer:', order.customer_email);

      // Map Gelato status to our status
      const statusMap = {
        'created': 'processing',
        'passed': 'processing',
        'in_production': 'printing',
        'printed': 'printed',
        'shipped': 'shipped',
        'delivered': 'delivered',
        'canceled': 'cancelled',
        'failed': 'failed'
      };

      const newStatus = statusMap[fulfillmentStatus] || fulfillmentStatus;

      // Extract tracking info if shipped
      let trackingNumber = null;
      let trackingUrl = null;

      if (items && items.length > 0 && items[0].fulfillments && items[0].fulfillments.length > 0) {
        const fulfillment = items[0].fulfillments[0];
        trackingNumber = fulfillment.trackingCode || null;
        trackingUrl = fulfillment.trackingUrl || null;
        log.debug('   Tracking:', trackingNumber);
        log.debug('   Tracking URL:', trackingUrl);
      }

      // Update order status in database
      if (trackingNumber) {
        await dbPool.query(`
          UPDATE orders
          SET gelato_status = $1,
              tracking_number = $2,
              tracking_url = $3,
              shipped_at = CASE WHEN $1 = 'shipped' AND shipped_at IS NULL THEN NOW() ELSE shipped_at END,
              delivered_at = CASE WHEN $1 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $4
        `, [newStatus, trackingNumber, trackingUrl, orderId]);
      } else {
        await dbPool.query(`
          UPDATE orders
          SET gelato_status = $1,
              delivered_at = CASE WHEN $1 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $2
        `, [newStatus, orderId]);
      }

      console.log('✅ [GELATO WEBHOOK] Order status updated to:', newStatus);

      // Send email notification for shipped orders
      if (fulfillmentStatus === 'shipped' && order.customer_email) {
        try {
          // Get user's preferred language
          let language = 'English';
          if (order.user_id) {
            const userResult = await dbPool.query(
              'SELECT preferred_language FROM users WHERE id = $1',
              [order.user_id]
            );
            if (userResult.rows.length > 0 && userResult.rows[0].preferred_language) {
              language = userResult.rows[0].preferred_language;
            }
          }

          await email.sendOrderShippedEmail(
            order.customer_email,
            order.customer_name,
            {
              orderId: order.id,
              trackingNumber,
              trackingUrl
            },
            language
          );
          console.log('📧 [GELATO WEBHOOK] Shipped notification sent to:', order.customer_email);
        } catch (emailErr) {
          log.error('❌ [GELATO WEBHOOK] Failed to send shipped email:', emailErr.message);
        }
      }

      // Log activity
      await logActivity(order.user_id, null, 'ORDER_STATUS_UPDATED', {
        orderId: order.id,
        gelatoOrderId: orderId,
        status: newStatus,
        trackingNumber
      });
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ received: true });

  } catch (err) {
    log.error('❌ [GELATO WEBHOOK] Error processing webhook:', err);
    // Still return 200 to prevent infinite retries
    res.status(200).json({ received: true, error: err.message });
  }
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Serve static files
// Priority: 1. Built React app (dist/), 2. Images folder, 3. Legacy HTML files
const distPath = path.join(__dirname, 'dist');
const hasDistFolder = require('fs').existsSync(distPath);

if (hasDistFolder) {
  // Serve the built React app from dist/
  app.use(express.static(distPath));
  log.debug('📦 Serving built React app from dist/');
} else {
  // Fallback to legacy: serve files from project root (index.html with Babel)
  app.use(express.static(__dirname));
  log.debug('📦 Serving legacy HTML files (no dist/ folder found)');
}

// Always serve images folder
app.use('/images', express.static(path.join(__dirname, 'images')));

// =============================================================================
// MODULAR ROUTES (migrated from this file)
// =============================================================================
app.use('/api/config', configRoutes);
app.use('/api', healthRoutes);  // /api/health, /api/check-ip, /api/log-error
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/characters', characterRoutes);
app.use('/api/story-draft', storyDraftRoutes);
app.use('/api/stories', storiesRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/photos', photosRoutes);

console.log('📦 Modular routes loaded: config, health, auth, user, characters, story-draft, stories, files, admin, photos');

// SPA fallback - serve index.html for client-side routing (only if dist exists)
// Must be placed AFTER API routes are defined
// This is handled at the end of the file

// File paths for simple file-based storage
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const LOGS_FILE = path.join(__dirname, 'data', 'logs.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const CHARACTERS_FILE = path.join(__dirname, 'data', 'characters.json');
const STORIES_FILE = path.join(__dirname, 'data', 'stories.json');
const STORY_DRAFTS_FILE = path.join(__dirname, 'data', 'story_drafts.json');

// Initialize data directory and files
async function initializeDataFiles() {
  const dataDir = path.join(__dirname, 'data');

  try {
    await fs.mkdir(dataDir, { recursive: true });
  } catch (err) {
    log.debug('Data directory already exists');
  }

  // Initialize users.json
  try {
    await fs.access(USERS_FILE);
  } catch {
    await fs.writeFile(USERS_FILE, JSON.stringify([], null, 2));
  }

  // Initialize logs.json
  try {
    await fs.access(LOGS_FILE);
  } catch {
    await fs.writeFile(LOGS_FILE, JSON.stringify([], null, 2));
  }

  // Initialize config.json
  try {
    await fs.access(CONFIG_FILE);
  } catch {
    await fs.writeFile(CONFIG_FILE, JSON.stringify({
      anthropicApiKey: '',
      geminiApiKey: ''
    }, null, 2));
  }

  // Initialize characters.json
  try {
    await fs.access(CHARACTERS_FILE);
  } catch {
    await fs.writeFile(CHARACTERS_FILE, JSON.stringify({}, null, 2));
  }

  // Initialize stories.json
  try {
    await fs.access(STORIES_FILE);
  } catch {
    await fs.writeFile(STORIES_FILE, JSON.stringify({}, null, 2));
  }

  // Initialize story_drafts.json
  try {
    await fs.access(STORY_DRAFTS_FILE);
  } catch {
    await fs.writeFile(STORY_DRAFTS_FILE, JSON.stringify({}, null, 2));
  }
}

// Database query wrapper - PostgreSQL
async function dbQuery(sql, params = []) {
  // PostgreSQL uses $1, $2, etc for parameters
  const result = await dbPool.query(sql, params);
  // Return rows with metadata for DELETE/UPDATE operations
  result.rows.rowCount = result.rowCount;
  result.rows.command = result.command;
  return result.rows;
}

// Initialize database tables
async function initializeDatabase() {
  if (!dbPool) {
    log.warn('⚠️  No database pool - skipping database initialization');
    return;
  }

  try {
    // Test connection first
    await dbPool.query('SELECT 1');
    console.log('✓ Database connection successful');

    // PostgreSQL table creation - includes all columns
    // Note: All migrations have been run, this is just for fresh database setup
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        story_quota INT DEFAULT 2,
        stories_generated INT DEFAULT 0,
        credits INT DEFAULT 500,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        preferred_language VARCHAR(20) DEFAULT 'English',
        email_verified BOOLEAN DEFAULT FALSE,
        email_verification_token VARCHAR(255),
        email_verification_expires TIMESTAMP,
        password_reset_token VARCHAR(255),
        password_reset_expires TIMESTAMP,
        photo_consent_at TIMESTAMP,
        last_verification_email_sent TIMESTAMP
      )
    `);

    // Add last_verification_email_sent column if missing (for existing databases)
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_verification_email_sent') THEN
          ALTER TABLE users ADD COLUMN last_verification_email_sent TIMESTAMP;
        END IF;
      END $$;
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(255) UNIQUE NOT NULL,
        config_value TEXT
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255),
        username VARCHAR(255),
        action VARCHAR(255),
        details TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS characters (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id)`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id)`);

    // Story drafts table - stores unsaved story settings (step 1 & 4 data)
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_drafts (
        user_id VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS files (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        file_type VARCHAR(50) NOT NULL,
        story_id VARCHAR(255),
        mime_type VARCHAR(100) NOT NULL,
        file_data BYTEA NOT NULL,
        file_size INT,
        filename VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_files_story_id ON files(story_id)`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS gelato_products (
        id SERIAL PRIMARY KEY,
        product_uid VARCHAR(500) UNIQUE NOT NULL,
        product_name VARCHAR(255) NOT NULL,
        description TEXT,
        size VARCHAR(100),
        cover_type VARCHAR(100),
        min_pages INT,
        max_pages INT,
        available_page_counts TEXT,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_gelato_products_active ON gelato_products(is_active)`);

    // Orders table for Stripe payments and book printing
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) REFERENCES users(id) ON DELETE CASCADE,
        story_id VARCHAR(255),
        stripe_session_id VARCHAR(255) UNIQUE NOT NULL,
        stripe_payment_intent_id VARCHAR(255),
        customer_name VARCHAR(255),
        customer_email VARCHAR(255),
        shipping_name VARCHAR(255),
        shipping_address_line1 VARCHAR(255),
        shipping_address_line2 VARCHAR(255),
        shipping_city VARCHAR(100),
        shipping_state VARCHAR(100),
        shipping_postal_code VARCHAR(20),
        shipping_country VARCHAR(2),
        amount_total INTEGER,
        currency VARCHAR(3),
        payment_status VARCHAR(50),
        gelato_order_id VARCHAR(255),
        gelato_status VARCHAR(50),
        tracking_number VARCHAR(255),
        tracking_url VARCHAR(500),
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_session_id ON orders(stripe_session_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_orders_gelato_order_id ON orders(gelato_order_id)`);
    // Migration: Add tracking columns to existing orders table
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);

    // Credit transactions table for tracking credit history
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount INT NOT NULL,
        balance_after INT NOT NULL,
        transaction_type VARCHAR(50) NOT NULL,
        reference_id VARCHAR(255),
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON credit_transactions(transaction_type)`);

    // Story generation jobs table for background processing
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_jobs (
        id VARCHAR(100) PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        input_data JSONB NOT NULL,
        result_data JSONB,
        error_message TEXT,
        progress INT DEFAULT 0,
        progress_message TEXT,
        credits_reserved INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_jobs_user ON story_jobs(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_jobs_status ON story_jobs(status)`);

    // Add credits_reserved column to existing story_jobs table if it doesn't exist
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='story_jobs' AND column_name='credits_reserved') THEN
          ALTER TABLE story_jobs ADD COLUMN credits_reserved INT DEFAULT 0;
        END IF;
      END $$;
    `);

    // Story job checkpoints for fault tolerance and intermediate data access
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_job_checkpoints (
        id SERIAL PRIMARY KEY,
        job_id VARCHAR(100) NOT NULL REFERENCES story_jobs(id) ON DELETE CASCADE,
        step_name VARCHAR(50) NOT NULL,
        step_index INT DEFAULT 0,
        step_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(job_id, step_name, step_index)
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_checkpoints_job ON story_job_checkpoints(job_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_checkpoints_step ON story_job_checkpoints(step_name)`);

    // Pricing tiers table - single source of truth for book pricing
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pricing_tiers (
        id SERIAL PRIMARY KEY,
        max_pages INT NOT NULL UNIQUE,
        label VARCHAR(20) NOT NULL,
        softcover_price INT NOT NULL,
        hardcover_price INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Seed default pricing tiers if table is empty
    const pricingCheck = await dbPool.query('SELECT COUNT(*) as count FROM pricing_tiers');
    if (parseInt(pricingCheck.rows[0].count) === 0) {
      const defaultTiers = [
        { maxPages: 30, label: '1-30', softcover: 38, hardcover: 53 },
        { maxPages: 40, label: '31-40', softcover: 45, hardcover: 60 },
        { maxPages: 50, label: '41-50', softcover: 51, hardcover: 66 },
        { maxPages: 60, label: '51-60', softcover: 57, hardcover: 72 },
        { maxPages: 70, label: '61-70', softcover: 63, hardcover: 78 },
        { maxPages: 80, label: '71-80', softcover: 69, hardcover: 84 },
        { maxPages: 90, label: '81-90', softcover: 75, hardcover: 90 },
        { maxPages: 100, label: '91-100', softcover: 81, hardcover: 96 },
      ];
      for (const tier of defaultTiers) {
        await dbPool.query(
          'INSERT INTO pricing_tiers (max_pages, label, softcover_price, hardcover_price) VALUES ($1, $2, $3, $4)',
          [tier.maxPages, tier.label, tier.softcover, tier.hardcover]
        );
      }
      console.log('✓ Default pricing tiers seeded');
    }

    console.log('✓ Database tables initialized');

    // Run database migrations
    try {
      const { runMigrations } = require('./run-migrations');
      await runMigrations(dbPool, 'postgresql');
    } catch (err) {
      log.error('⚠️  Migration warning:', err.message);
      // Don't fail initialization if migrations fail
    }

  } catch (err) {
    log.error('❌ Database initialization error:', err.message);
    log.error('Error code:', err.code);
    if (err.sql) log.error('SQL:', err.sql);
    throw err; // Re-throw to be caught by initialization
  }
}

// Helper functions for file operations
async function readJSON(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    log.error(`Error reading ${filePath}:`, err);
    return [];
  }
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// logActivity imported from ./server/services/database

// =============================================================================
// CHECKPOINT SYSTEM - Save intermediate pipeline state for fault tolerance
// =============================================================================

// Save a checkpoint for a specific step in the pipeline
async function saveCheckpoint(jobId, stepName, stepData, stepIndex = 0) {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    await dbPool.query(`
      INSERT INTO story_job_checkpoints (job_id, step_name, step_index, step_data)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (job_id, step_name, step_index)
      DO UPDATE SET step_data = $4, created_at = CURRENT_TIMESTAMP
    `, [jobId, stepName, stepIndex, JSON.stringify(stepData)]);
    log.verbose(`💾 Checkpoint saved: ${stepName} (index: ${stepIndex}) for job ${jobId}`);
  } catch (err) {
    log.error(`❌ Failed to save checkpoint ${stepName}:`, err.message);
  }
}

// Get checkpoint for a step (returns null if not found)
async function getCheckpoint(jobId, stepName, stepIndex = 0) {
  if (STORAGE_MODE !== 'database' || !dbPool) return null;

  try {
    const result = await dbPool.query(`
      SELECT step_data FROM story_job_checkpoints
      WHERE job_id = $1 AND step_name = $2 AND step_index = $3
    `, [jobId, stepName, stepIndex]);

    if (result.rows.length > 0) {
      return result.rows[0].step_data;
    }
    return null;
  } catch (err) {
    log.error(`❌ Failed to get checkpoint ${stepName}:`, err.message);
    return null;
  }
}

// Get all checkpoints for a job
async function getAllCheckpoints(jobId) {
  if (STORAGE_MODE !== 'database' || !dbPool) return [];

  try {
    const result = await dbPool.query(`
      SELECT step_name, step_index, step_data, created_at
      FROM story_job_checkpoints
      WHERE job_id = $1
      ORDER BY created_at ASC
    `, [jobId]);
    return result.rows;
  } catch (err) {
    log.error(`❌ Failed to get checkpoints for job ${jobId}:`, err.message);
    return [];
  }
}

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}


// API Key management (admin only) - KEEP: Uses writeJSON which is local to server.js
app.post('/api/admin/config', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { anthropicApiKey, geminiApiKey } = req.body;
    const config = {
      anthropicApiKey: anthropicApiKey || '',
      geminiApiKey: geminiApiKey || ''
    };

    await writeJSON(CONFIG_FILE, config);
    await logActivity(req.user.id, req.user.username, 'API_KEYS_UPDATED', {});

    res.json({ message: 'API keys updated successfully' });
  } catch (err) {
    log.error('Config update error:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Proxy endpoint for Claude API
app.post('/api/claude', aiProxyLimiter, authenticateToken, async (req, res) => {
  log.debug('📖 === CLAUDE/ANTHROPIC ENDPOINT CALLED ===');
  log.debug(`  User: ${req.user?.username || 'unknown'}`);
  log.debug(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    log.debug('🔑 Anthropic API key check:');
    log.debug(`  From env: ${anthropicApiKey ? 'SET (length: ' + anthropicApiKey.length + ', starts with: ' + anthropicApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!anthropicApiKey) {
      const config = await readJSON(CONFIG_FILE);
      anthropicApiKey = config.anthropicApiKey;
      log.debug(`  From config file: ${anthropicApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!anthropicApiKey) {
      log.debug('  ❌ No API key found!');
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    const { prompt, max_tokens } = req.body;

    await logActivity(req.user.id, req.user.username, 'CLAUDE_API_CALL', {
      promptLength: prompt?.length || 0,
      maxTokens: max_tokens
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: max_tokens || 8192,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      log.error('Claude API error response:', JSON.stringify(data, null, 2));
      const errorMsg = data.error?.message || data.error?.type || JSON.stringify(data.error) || 'Claude API request failed';
      throw new Error(errorMsg);
    }

    // Log token usage
    if (data.usage) {
      log.debug('📊 Token Usage:');
      log.debug(`  Input tokens:  ${data.usage.input_tokens.toLocaleString()}`);
      log.debug(`  Output tokens: ${data.usage.output_tokens.toLocaleString()}`);
      log.debug(`  Total tokens:  ${(data.usage.input_tokens + data.usage.output_tokens).toLocaleString()}`);
      log.debug(`  Max requested: ${max_tokens?.toLocaleString() || 'default'}`);

      // Warn if output limit was reached
      if (data.stop_reason === 'max_tokens') {
        log.warn('⚠️  WARNING: Output was truncated - max_tokens limit reached!');
      }
    }

    res.json(data);
  } catch (err) {
    log.error('Claude API error:', err.message);
    log.error('Full error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Claude API' });
  }
});

// Proxy endpoint for Gemini API
app.post('/api/gemini', aiProxyLimiter, authenticateToken, async (req, res) => {
  log.debug('🎨 === GEMINI ENDPOINT CALLED ===');
  log.debug(`  User: ${req.user?.username || 'unknown'}`);
  log.debug(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let geminiApiKey = process.env.GEMINI_API_KEY;

    log.debug('🔑 Gemini API key check:');
    console.log(`  From env: ${geminiApiKey ? 'SET (length: ' + geminiApiKey.length + ', starts with: ' + geminiApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!geminiApiKey) {
      const config = await readJSON(CONFIG_FILE);
      geminiApiKey = config.geminiApiKey;
      console.log(`  From config file: ${geminiApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!geminiApiKey) {
      log.debug('  ❌ No API key found!');
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const { model, contents, safetySettings, generationConfig } = req.body;

    await logActivity(req.user.id, req.user.username, 'GEMINI_API_CALL', {
      model: model || 'gemini-2.5-flash-image'
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash-image'}:generateContent?key=${geminiApiKey}`;

    const requestBody = { contents };
    if (safetySettings) {
      requestBody.safetySettings = safetySettings;
    }
    // Add generationConfig with aspectRatio if not provided (for image generation)
    if (generationConfig) {
      requestBody.generationConfig = generationConfig;
    } else {
      // Default config for image generation - ensures 1:1 aspect ratio
      requestBody.generationConfig = {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.5,
        imageConfig: {
          aspectRatio: "1:1"
        }
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      log.error('❌ Gemini API error response:');
      log.error('  Status:', response.status);
      log.error('  Response:', JSON.stringify(data, null, 2));
      log.error('  Request URL:', url.substring(0, 100) + '...');
      log.error('  Model:', model || 'gemini-2.5-flash-image');
      throw new Error(data.error?.message || `Gemini API request failed: ${response.status}`);
    }

    res.json(data);
  } catch (err) {
    log.error('Gemini API error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Gemini API' });
  }
});

// Generate story ideas endpoint - FREE, no credits
app.post('/api/generate-story-ideas', authenticateToken, async (req, res) => {
  try {
    const { storyType, storyTypeName, language, languageLevel, characters, relationships } = req.body;

    log.debug(`💡 Generating story ideas for user ${req.user.username}`);
    log.debug(`  Story type: ${storyTypeName}, Language: ${language}, Characters: ${characters?.length || 0}`);

    // Build character descriptions
    const characterDescriptions = characters.map(c => {
      const role = c.isMain ? 'main character' : 'side character';
      const traits = [];
      if (c.traits?.strengths?.length) traits.push(`strengths: ${c.traits.strengths.join(', ')}`);
      if (c.traits?.flaws?.length) traits.push(`flaws: ${c.traits.flaws.join(', ')}`);
      if (c.traits?.challenges?.length) traits.push(`challenges: ${c.traits.challenges.join(', ')}`);
      if (c.traits?.specialDetails) traits.push(`special: ${c.traits.specialDetails}`);
      const traitsStr = traits.length ? ` (${traits.join('; ')})` : '';
      return `- ${c.name}: ${c.age} years old, ${c.gender}, ${role}${traitsStr}`;
    }).join('\n');

    // Build relationship descriptions
    const relationshipDescriptions = relationships.map(r =>
      `- ${r.character1} and ${r.character2}: ${r.relationship}`
    ).join('\n');

    // Determine language for response
    const langInstructions = {
      'de': 'Antworte auf Deutsch.',
      'fr': 'Réponds en français.',
      'en': 'Respond in English.'
    };

    // Determine reading level description
    const readingLevelDescriptions = {
      '1st-grade': 'Early reader (simple sentences, 6-7 year olds)',
      'advanced': 'Advanced (older children 10+)',
      'standard': 'Standard (7-9 year olds)'
    };

    // Load prompt from file and replace placeholders
    const promptTemplate = await fs.readFile(path.join(__dirname, 'prompts', 'generate-story-ideas.txt'), 'utf-8');
    const prompt = promptTemplate
      .replace('{STORY_TYPE_NAME}', storyTypeName)
      .replace('{CHARACTER_DESCRIPTIONS}', characterDescriptions)
      .replace('{RELATIONSHIP_DESCRIPTIONS}', relationshipDescriptions || 'No specific relationships defined.')
      .replace('{READING_LEVEL_DESCRIPTION}', readingLevelDescriptions[languageLevel] || readingLevelDescriptions['standard'])
      .replace('{LANGUAGE_INSTRUCTION}', langInstructions[language] || langInstructions['en']);

    // Call the text model (using the imported function)
    const { callTextModel } = require('./server/lib/textModels');
    const result = await callTextModel(prompt, 500);

    res.json({ storyIdea: result.text.trim() });

  } catch (err) {
    log.error('Generate story ideas error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate story ideas' });
  }
});





// =============================================================================
// STORY REGENERATION ENDPOINTS - Regenerate individual components
// NOT MIGRATED - These remain active in server.js (AI generation dependencies)
// =============================================================================

// Regenerate scene description for a specific page (no credit cost - image regeneration covers it)
app.post('/api/stories/:id/regenerate/scene-description/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);

    log.debug(`🔄 Regenerating scene description for story ${id}, page ${pageNumber}`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Find the page text
    const pageText = getPageText(storyData.storyText, pageNumber);
    if (!pageText) {
      return res.status(404).json({ error: `Page ${pageNumber} not found in story` });
    }

    // Get characters from story data
    const characters = storyData.characters || [];

    // Get language from story data
    const language = storyData.language || 'English';

    // Get Visual Bible for recurring elements
    const visualBible = storyData.visualBible || null;

    // Get page clothing from outline (reliable source) or fall back to parsing scene descriptions
    const pageClothingData = storyData.pageClothing || null;

    // Build previous scenes context (last 2 pages)
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const previousScenes = [];
    for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
      if (prevPage >= 1) {
        const prevText = getPageText(storyData.storyText, prevPage);
        if (prevText) {
          // Get clothing from pageClothing (outline) first, then fall back to parsing scene description
          let prevClothing = pageClothingData?.pageClothing?.[prevPage] || null;
          if (!prevClothing) {
            const prevSceneDesc = sceneDescriptions.find(s => s.pageNumber === prevPage);
            prevClothing = prevSceneDesc ? parseClothingCategory(prevSceneDesc.description) : null;
          }
          previousScenes.push({
            pageNumber: prevPage,
            text: prevText,
            sceneHint: '',
            clothing: prevClothing
          });
        }
      }
    }

    // Log expected clothing for this page based on outline
    const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing || 'standard';
    log.debug(`🔄 [REGEN SCENE ${pageNumber}] Expected clothing from outline: ${expectedClothing}`)

    // Generate new scene description (includes Visual Bible recurring elements)
    const scenePrompt = buildSceneDescriptionPrompt(pageNumber, pageText, characters, '', language, visualBible, previousScenes);
    const sceneResult = await callClaudeAPI(scenePrompt, 2048);
    const newSceneDescription = sceneResult.text;

    // Update the scene description in story data (sceneDescriptions already loaded above)
    const existingIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);

    if (existingIndex >= 0) {
      sceneDescriptions[existingIndex].description = newSceneDescription;
    } else {
      sceneDescriptions.push({ pageNumber, description: newSceneDescription });
      sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Save updated story
    storyData.sceneDescriptions = sceneDescriptions;
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Scene description regenerated for story ${id}, page ${pageNumber}`);

    res.json({
      success: true,
      pageNumber,
      sceneDescription: newSceneDescription
    });

  } catch (err) {
    log.error('Error regenerating scene description:', err);
    res.status(500).json({ error: 'Failed to regenerate scene description: ' + err.message });
  }
});

// Regenerate image for a specific page (costs credits)
app.post('/api/stories/:id/regenerate/image/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { customPrompt, editedScene } = req.body;
    const pageNumber = parseInt(pageNum);
    const creditCost = CREDIT_COSTS.IMAGE_REGENERATION;

    // Check if admin is impersonating - they get free regenerations
    const isImpersonating = req.user.impersonating === true;
    if (isImpersonating) {
      log.info(`🔄 [IMPERSONATE] Admin regenerating image for story ${id}, page ${pageNumber} (FREE - impersonating)`);
    } else {
      log.debug(`🔄 Regenerating image for story ${id}, page ${pageNumber} (cost: ${creditCost} credits)${editedScene ? ' [EDITED SCENE]' : ''}`);
    }

    // Check user credits first (-1 means infinite/unlimited, impersonating admins also skip)
    const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userCredits = userResult.rows[0].credits || 0;
    const hasInfiniteCredits = userCredits === -1 || isImpersonating;
    if (!hasInfiniteCredits && userCredits < creditCost) {
      return res.status(402).json({
        error: 'Insufficient credits',
        required: creditCost,
        available: userCredits
      });
    }

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get scene description
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);

    if (!sceneDesc && !customPrompt) {
      return res.status(400).json({ error: 'No scene description found. Please provide customPrompt.' });
    }

    // Determine scene description to use
    const originalDescription = sceneDesc?.description || '';
    const inputDescription = editedScene || customPrompt || originalDescription;
    const sceneWasEdited = editedScene && editedScene !== originalDescription;

    // Log scene changes for dev mode visibility
    if (sceneWasEdited) {
      console.log(`📝 [REGEN] SCENE EDITED for page ${pageNumber}:`);
      console.log(`   Original: ${originalDescription.substring(0, 100)}${originalDescription.length > 100 ? '...' : ''}`);
      console.log(`   New:      ${inputDescription.substring(0, 100)}${inputDescription.length > 100 ? '...' : ''}`);
    }

    // Get visual bible from stored story (for recurring elements)
    const visualBible = storyData.visualBible || null;
    if (visualBible) {
      const relevantEntries = getVisualBibleEntriesForPage(visualBible, pageNumber);
      log.debug(`📖 [REGEN] Visual Bible: ${relevantEntries.length} entries relevant to page ${pageNumber}`);
    }

    // Detect which characters appear in this scene (from input description)
    const sceneCharacters = getCharactersInScene(inputDescription, storyData.characters || []);

    // Expand short scene summary to full Art Director format
    // This ensures regenerated images have the same detailed prompts as original generation
    let expandedDescription = inputDescription;
    const isShortSummary = inputDescription.length < 500 && !inputDescription.includes('**Setting');

    if (isShortSummary) {
      console.log(`📝 [REGEN] Expanding short scene summary (${inputDescription.length} chars) to full Art Director format...`);
      const language = storyData.language || 'English';
      const expansionPrompt = buildSceneExpansionPrompt(inputDescription, storyData, sceneCharacters, visualBible, language);

      try {
        const expansionResult = await callClaudeAPI(expansionPrompt, 2048);
        expandedDescription = expansionResult.text;
        console.log(`✅ [REGEN] Scene expanded to ${expandedDescription.length} chars`);
        log.debug(`📝 [REGEN] Expanded scene preview: ${expandedDescription.substring(0, 300)}...`);
      } catch (expansionError) {
        log.error(`⚠️  [REGEN] Scene expansion failed, using original summary:`, expansionError.message);
        // Continue with short summary if expansion fails
      }
    }

    // Get clothing category - prefer outline pageClothing, then parse from description
    const pageClothingData = storyData.pageClothing || null;
    let clothingCategory = pageClothingData?.pageClothing?.[pageNumber] || null;
    if (!clothingCategory) {
      clothingCategory = parseClothingCategory(expandedDescription) || pageClothingData?.primaryClothing || 'standard';
    }
    // Use detailed photo info (with names) for labeled reference images
    const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
    log.debug(`🔄 [REGEN] Scene has ${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory}${pageClothingData ? ' (from outline)' : ' (parsed)'}`);


    // Build image prompt with scene-specific characters and visual bible
    // Use isStorybook=true to include Visual Bible section in prompt
    const originalPrompt = originalDescription ? buildImagePrompt(originalDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true) : null;
    const imagePrompt = customPrompt || buildImagePrompt(expandedDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true);

    // Log prompt changes for debugging
    if (sceneWasEdited) {
      console.log(`📝 [REGEN] PROMPT BUILT for page ${pageNumber}:`);
      console.log(`   Prompt length: ${imagePrompt.length} chars`);
    }

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    if (deleteFromImageCache(cacheKey)) {
      log.debug(`[REGEN] Cleared cache for page ${pageNumber} to force new generation`);
    }

    // Get the current image before regenerating (to store as previous version)
    let sceneImages = storyData.sceneImages || [];
    const existingImage = sceneImages.find(img => img.pageNumber === pageNumber);
    const previousImageData = existingImage?.imageData || null;
    const previousScore = existingImage?.qualityScore || null;
    const previousReasoning = existingImage?.qualityReasoning || null;
    const previousPrompt = existingImage?.prompt || null;
    // Keep the true original if this was already regenerated before
    const trueOriginalImage = existingImage?.originalImage || previousImageData;
    const trueOriginalScore = existingImage?.originalScore || previousScore;
    const trueOriginalReasoning = existingImage?.originalReasoning || previousReasoning;

    log.debug(`📸 [REGEN] Capturing previous image (${previousImageData ? 'has data' : 'none'}, score: ${previousScore}, already regenerated: ${!!existingImage?.originalImage})`);

    // Generate new image with labeled character photos (name + photoUrl)
    // Use quality retry to regenerate if score is below threshold
    // User-initiated regenerations use Gemini 3 Pro for higher quality
    const imageResult = await generateImageWithQualityRetry(
      imagePrompt, referencePhotos, null, 'scene', null, null, null,
      { imageModel: 'gemini-3-pro-image-preview' }
    );

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: expandedDescription,  // Store the full expanded scene description
      prompt: imagePrompt,  // Store the prompt used for this regeneration
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning || null,
      qualityModelId: imageResult.qualityModelId || null,
      fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
      wasRegenerated: true,
      totalAttempts: imageResult.totalAttempts || 1,
      retryHistory: imageResult.retryHistory || [],
      // Store previous version (for undo/comparison)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      previousPrompt: previousPrompt,
      // Keep the true original across multiple regenerations
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      referencePhotos,
      modelId: imageResult.modelId || null,
      regeneratedAt: new Date().toISOString(),
      regenerationCount: (existingImage?.regenerationCount || 0) + 1
    };

    log.debug(`📸 [REGEN] New image generated - score: ${imageResult.score}, attempts: ${imageResult.totalAttempts}, model: ${imageResult.modelId}`);

    // Initialize imageVersions if not present (migrate existing image as first version)
    if (existingImage && !existingImage.imageVersions) {
      existingImage.imageVersions = [{
        imageData: existingImage.imageData,
        description: existingImage.description || originalDescription,  // Scene description for this version
        prompt: existingImage.prompt,
        modelId: existingImage.modelId,
        createdAt: storyData.createdAt || new Date().toISOString(),
        isActive: false  // Will become inactive when new image is added
      }];
    }

    // Create new version entry
    const newVersion = {
      imageData: imageResult.imageData,
      description: expandedDescription,  // Full expanded scene description used for this version
      prompt: imagePrompt,
      modelId: imageResult.modelId || null,
      createdAt: new Date().toISOString(),
      isActive: true
    };

    if (existingIndex >= 0) {
      // Set all existing versions to inactive
      if (sceneImages[existingIndex].imageVersions) {
        sceneImages[existingIndex].imageVersions.forEach(v => v.isActive = false);
        sceneImages[existingIndex].imageVersions.push(newVersion);
      } else {
        sceneImages[existingIndex].imageVersions = [newVersion];
      }
      // Update main fields
      Object.assign(sceneImages[existingIndex], newImageData);
    } else {
      newImageData.imageVersions = [newVersion];
      sceneImages.push(newImageData);
      sceneImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Update image prompts
    storyData.imagePrompts = storyData.imagePrompts || {};
    storyData.imagePrompts[pageNumber] = imagePrompt;

    // Save updated story
    storyData.sceneImages = sceneImages;
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    // Deduct credits after successful generation (skip for infinite credits or impersonating admin)
    let newCredits = hasInfiniteCredits ? -1 : userCredits - creditCost;
    if (!hasInfiniteCredits) {
      await dbPool.query(
        'UPDATE users SET credits = credits - $1 WHERE id = $2',
        [creditCost, req.user.id]
      );
      // Log credit transaction
      await dbPool.query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
         VALUES ($1, $2, $3, 'image_regeneration', $4)`,
        [req.user.id, -creditCost, newCredits, `Regenerate image for page ${pageNumber}`]
      );
      console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, cost: ${creditCost} credits, remaining: ${newCredits})`);
    } else if (isImpersonating) {
      console.log(`✅ [IMPERSONATE] Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, FREE - admin impersonating)`);
    } else {
      console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, unlimited credits)`);
    }

    // Get version count for response
    const versionCount = sceneImages.find(s => s.pageNumber === pageNumber)?.imageVersions?.length || 1;

    res.json({
      success: true,
      pageNumber,
      imageData: imageResult.imageData,
      prompt: imagePrompt,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning,
      fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: imageResult.modelId || null,
      totalAttempts: imageResult.totalAttempts || 1,
      retryHistory: imageResult.retryHistory || [],
      wasRegenerated: true,
      regenerationCount: newImageData.regenerationCount,
      // Version info
      versionCount,
      creditsUsed: creditCost,
      creditsRemaining: newCredits,
      // Previous version (immediate predecessor)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      // True original (from initial generation)
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      // Scene editing info (for dev mode)
      originalDescription,
      newDescription: expandedDescription,  // Full expanded description
      inputDescription,  // What user provided (before expansion)
      originalPrompt,
      newPrompt: imagePrompt,
      sceneWasEdited,
      sceneWasExpanded: isShortSummary,  // Flag if expansion was done
      // All image versions
      imageVersions: sceneImages.find(s => s.pageNumber === pageNumber)?.imageVersions || []
    });

  } catch (err) {
    log.error('Error regenerating image:', err);
    res.status(500).json({ error: 'Failed to regenerate image: ' + err.message });
  }
});

// Regenerate cover image (front, initialPage, or back)
app.post('/api/stories/:id/regenerate/cover/:coverType', authenticateToken, async (req, res) => {
  try {
    const { id, coverType } = req.params;
    const { customPrompt } = req.body;

    // Accept both 'initial' and 'initialPage' for backwards compatibility
    const normalizedCoverType = coverType === 'initial' ? 'initialPage' : coverType;
    if (!['front', 'initialPage', 'back'].includes(normalizedCoverType)) {
      return res.status(400).json({ error: 'Invalid cover type. Must be: front, initial/initialPage, or back' });
    }

    // Check if admin is impersonating - they get free regenerations
    const isImpersonating = req.user.impersonating === true;

    // Check user credits before proceeding
    const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userCredits = userResult.rows[0].credits || 0;
    const requiredCredits = CREDIT_COSTS.IMAGE_REGENERATION;
    const hasInfiniteCredits = userCredits === -1 || isImpersonating;

    if (!hasInfiniteCredits && userCredits < requiredCredits) {
      return res.status(402).json({
        error: 'Insufficient credits',
        required: requiredCredits,
        available: userCredits
      });
    }

    if (isImpersonating) {
      log.info(`🔄 [IMPERSONATE] Admin regenerating ${normalizedCoverType} cover for story ${id} (FREE - impersonating)`);
    } else {
      log.debug(`🔄 Regenerating ${normalizedCoverType} cover for story ${id} (user credits: ${hasInfiniteCredits ? 'unlimited' : userCredits})`);
    }

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get art style
    const artStyleId = storyData.artStyle || 'pixar';
    const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

    // Build character info with main character emphasis
    let characterInfo = '';
    if (storyData.characters && storyData.characters.length > 0) {
      const mainCharacterIds = storyData.mainCharacters || [];
      const mainChars = storyData.characters.filter(c => mainCharacterIds.includes(c.id));
      const supportingChars = storyData.characters.filter(c => !mainCharacterIds.includes(c.id));

      characterInfo = '\n\n**MAIN CHARACTER(S) - Must be prominently featured in the CENTER of the image:**\n';

      mainChars.forEach((char) => {
        const physicalDesc = buildCharacterPhysicalDescription(char);
        characterInfo += `⭐ MAIN: ${physicalDesc}\n`;
      });

      if (supportingChars.length > 0) {
        characterInfo += '\n**Supporting characters (can appear in background or sides):**\n';
        supportingChars.forEach((char) => {
          const physicalDesc = buildCharacterPhysicalDescription(char);
          characterInfo += `Supporting: ${physicalDesc}\n`;
        });
      }

      characterInfo += '\n**CRITICAL: Main character(s) must be the LARGEST and most CENTRAL figures in the composition.**\n';
    }

    // Build visual bible prompt for covers (shows recurring elements like pets, artifacts)
    const visualBible = storyData.visualBible || null;
    const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible) : '';

    // Helper to build character reference list for cover prompts
    const buildCharRefList = (photos, characters) => {
      if (!photos || photos.length === 0) return '';
      const charDescriptions = photos.map((photo, index) => {
        // Look up character info by name to get full physical description
        const char = characters?.find(c => c.name === photo.name);
        const age = char?.age ? `${char.age} years old` : '';
        const gender = char?.gender === 'male' ? 'boy/man' : char?.gender === 'female' ? 'girl/woman' : '';
        // Include physical traits with labels (excluding height - AI doesn't understand it for images)
        const physical = char?.physical;
        const physicalParts = [
          physical?.build ? `Build: ${physical.build}` : '',
          physical?.face ? `Face: ${physical.face}` : '',
          physical?.hair ? `Hair: ${physical.hair}` : '',
          physical?.other ? `Other: ${physical.other}` : ''
        ].filter(Boolean);
        const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
        const brief = [photo.name, age, gender, physicalDesc].filter(Boolean).join(', ');
        return `${index + 1}. ${brief}`;
      });
      return `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;
    };

    // Extract cover scenes with clothing info
    const coverScenes = extractCoverScenes(storyData.outline || '');
    const storyTitle = storyData.title || 'My Story';

    // Determine scene description and clothing for this cover type
    let sceneDescription;
    let coverClothing;
    if (normalizedCoverType === 'front') {
      sceneDescription = coverScenes.titlePage?.scene || 'A beautiful, magical title page featuring the main characters.';
      coverClothing = coverScenes.titlePage?.clothing || parseClothingCategory(sceneDescription) || 'standard';
    } else if (normalizedCoverType === 'initialPage') {
      sceneDescription = coverScenes.initialPage?.scene || 'A warm, inviting dedication/introduction page.';
      coverClothing = coverScenes.initialPage?.clothing || parseClothingCategory(sceneDescription) || 'standard';
    } else {
      sceneDescription = coverScenes.backCover?.scene || 'A satisfying, conclusive ending scene.';
      coverClothing = coverScenes.backCover?.clothing || parseClothingCategory(sceneDescription) || 'standard';
    }

    // Get character photos with correct clothing variant
    let coverCharacterPhotos;
    if (normalizedCoverType === 'front') {
      // Front cover: detect which characters appear in the scene
      const frontCoverCharacters = getCharactersInScene(sceneDescription, storyData.characters || []);
      coverCharacterPhotos = getCharacterPhotoDetails(frontCoverCharacters, coverClothing);
      log.debug(`📕 [COVER REGEN] Front cover: ${frontCoverCharacters.length} characters, clothing: ${coverClothing}`);
    } else {
      // Initial/Back covers: use ALL characters
      coverCharacterPhotos = getCharacterPhotoDetails(storyData.characters || [], coverClothing);
      log.debug(`📕 [COVER REGEN] ${normalizedCoverType}: ALL ${coverCharacterPhotos.length} characters, clothing: ${coverClothing}`);
    }

    // Build cover prompt
    let coverPrompt;
    if (customPrompt) {
      coverPrompt = customPrompt;
    } else {
      if (normalizedCoverType === 'front') {
        coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
          TITLE_PAGE_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          STORY_TITLE: storyTitle,
          CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        });
      } else if (normalizedCoverType === 'initialPage') {
        coverPrompt = storyData.dedication
          ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
              INITIAL_PAGE_SCENE: sceneDescription,
              STYLE_DESCRIPTION: styleDescription,
              DEDICATION: storyData.dedication,
              CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos, storyData.characters),
              VISUAL_BIBLE: visualBiblePrompt
            })
          : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
              INITIAL_PAGE_SCENE: sceneDescription,
              STYLE_DESCRIPTION: styleDescription,
              STORY_TITLE: storyTitle,
              CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos, storyData.characters),
              VISUAL_BIBLE: visualBiblePrompt
            });
      } else {
        coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
          BACK_COVER_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        });
      }
    }

    // Get the current cover image before regenerating (to store as previous version)
    storyData.coverImages = storyData.coverImages || {};
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' : normalizedCoverType === 'initialPage' ? 'initialPage' : 'backCover';
    const previousCover = storyData.coverImages[coverKey];
    const previousImageData = previousCover?.imageData || (typeof previousCover === 'string' ? previousCover : null);
    const previousScore = previousCover?.qualityScore || null;
    const previousReasoning = previousCover?.qualityReasoning || null;
    const previousPrompt = previousCover?.prompt || null;
    // Keep the true original if this was already regenerated before
    const trueOriginalImage = previousCover?.originalImage || previousImageData;
    const trueOriginalScore = previousCover?.originalScore || previousScore;
    const trueOriginalReasoning = previousCover?.originalReasoning || previousReasoning;

    log.debug(`📸 [COVER REGEN] Capturing previous ${normalizedCoverType} cover (${previousImageData ? 'has data' : 'none'}, score: ${previousScore}, already regenerated: ${!!previousCover?.originalImage})`);

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(coverPrompt, coverCharacterPhotos, null);
    if (deleteFromImageCache(cacheKey)) {
      log.debug(`[REGEN] Cleared cache for ${normalizedCoverType} cover to force new generation`);
    }

    // Generate new cover with quality retry (automatically retries on text errors)
    // User-initiated regenerations use Gemini 3 Pro for higher quality
    const coverResult = await generateImageWithQualityRetry(
      coverPrompt, coverCharacterPhotos, null, 'cover', null, null, null,
      { imageModel: 'gemini-3-pro-image-preview' }
    );

    // Update the cover in story data with new structure including quality, description, prompt, and previous version
    const coverData = {
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning || null,
      fixTargets: coverResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: coverResult.modelId || null,
      wasRegenerated: true,
      totalAttempts: coverResult.totalAttempts || 1,
      retryHistory: coverResult.retryHistory || [],
      // Store previous version (for undo/comparison)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      previousPrompt: previousPrompt,
      // Keep the true original across multiple regenerations
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      regeneratedAt: new Date().toISOString(),
      regenerationCount: (previousCover?.regenerationCount || 0) + 1
    };

    log.debug(`📸 [COVER REGEN] New ${normalizedCoverType} cover generated - score: ${coverResult.score}, attempts: ${coverResult.totalAttempts}, model: ${coverResult.modelId}`);

    if (normalizedCoverType === 'front') {
      storyData.coverImages.frontCover = coverData;
    } else if (normalizedCoverType === 'initialPage') {
      storyData.coverImages.initialPage = coverData;
    } else {
      storyData.coverImages.backCover = coverData;
    }

    // Save updated story
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    // Deduct credits and log transaction (skip for infinite credits or impersonating admin)
    let newCredits = hasInfiniteCredits ? -1 : userCredits - requiredCredits;
    if (!hasInfiniteCredits) {
      await dbPool.query('UPDATE users SET credits = $1 WHERE id = $2', [newCredits, req.user.id]);
      await dbPool.query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, -requiredCredits, newCredits, 'cover_regeneration', `Regenerated ${normalizedCoverType} cover for story ${id}`]
      );
      console.log(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, credits: ${requiredCredits} used, ${newCredits} remaining)`);
    } else if (isImpersonating) {
      console.log(`✅ [IMPERSONATE] ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, FREE - admin impersonating)`);
    } else {
      console.log(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, unlimited credits)`);
    }

    res.json({
      success: true,
      coverType: normalizedCoverType,
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning,
      fixTargets: coverResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: coverResult.modelId || null,
      totalAttempts: coverResult.totalAttempts || 1,
      retryHistory: coverResult.retryHistory || [],
      wasRegenerated: true,
      regenerationCount: coverData.regenerationCount,
      // Previous version (immediate predecessor)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      // True original (from initial generation)
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      // Credit info
      creditsUsed: requiredCredits,
      creditsRemaining: newCredits
    });

  } catch (err) {
    log.error('Error regenerating cover:', err);
    res.status(500).json({ error: 'Failed to regenerate cover: ' + err.message });
  }
});

// Edit scene image with a user prompt
app.post('/api/stories/:id/edit/image/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { editPrompt } = req.body;
    const pageNumber = parseInt(pageNum);

    if (!editPrompt || editPrompt.trim().length === 0) {
      return res.status(400).json({ error: 'editPrompt is required' });
    }

    log.debug(`✏️ Editing image for story ${id}, page ${pageNumber}`);
    log.debug(`✏️ Edit instruction: "${editPrompt}"`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get the current image
    const sceneImages = storyData.sceneImages || [];
    const currentImage = sceneImages.find(img => img.pageNumber === pageNumber);

    if (!currentImage || !currentImage.imageData) {
      return res.status(404).json({ error: 'No image found for this page' });
    }

    // Capture previous image info before editing
    const previousImageData = currentImage.imageData;
    const previousScore = currentImage.qualityScore || null;
    const previousReasoning = currentImage.qualityReasoning || null;
    log.debug(`📸 [EDIT] Capturing previous image (score: ${previousScore})`);

    // Edit the image (pure text/instruction based - no character photos to avoid regeneration artifacts)
    const editResult = await editImageWithPrompt(currentImage.imageData, editPrompt);

    if (!editResult || !editResult.imageData) {
      return res.status(500).json({ error: 'Failed to edit image - no result returned' });
    }

    // Evaluate the edited image quality
    log.debug(`⭐ [EDIT] Evaluating edited image quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'scene');
      qualityScore = evaluation.score;
      qualityReasoning = evaluation.reasoning;
      log.debug(`⭐ [EDIT] Edited image score: ${qualityScore}%`);
    } catch (evalErr) {
      log.error(`⚠️ [EDIT] Quality evaluation failed:`, evalErr.message);
    }

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);
    if (existingIndex >= 0) {
      sceneImages[existingIndex] = {
        ...sceneImages[existingIndex],
        imageData: editResult.imageData,
        qualityScore,
        qualityReasoning,
        wasEdited: true,
        lastEditPrompt: editPrompt,
        originalImage: previousImageData,
        originalScore: previousScore,
        originalReasoning: previousReasoning,
        editedAt: new Date().toISOString()
      };
    }

    // Save updated story
    storyData.sceneImages = sceneImages;
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Image edited for story ${id}, page ${pageNumber} (new score: ${qualityScore})`);

    res.json({
      success: true,
      pageNumber,
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning
    });

  } catch (err) {
    log.error('Error editing image:', err);
    res.status(500).json({ error: 'Failed to edit image: ' + err.message });
  }
});

// Auto-repair image (detect and fix physics errors) - DEV ONLY
app.post('/api/stories/:id/repair/image/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);

    // Admin-only endpoint (dev mode feature)
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    log.info(`🔧 [REPAIR] Starting auto-repair for story ${id}, page ${pageNumber}`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get the current image
    const sceneImages = storyData.sceneImages || [];
    const currentImage = sceneImages.find(img => img.pageNumber === pageNumber);

    if (!currentImage || !currentImage.imageData) {
      return res.status(404).json({ error: 'No image found for this page' });
    }

    // Run auto-repair - use pre-computed fix targets if available (saves API call)
    let repairResult;
    if (currentImage.fixTargets && currentImage.fixTargets.length > 0) {
      log.info(`🔄 [REPAIR] Using ${currentImage.fixTargets.length} pre-computed fix targets for story ${id}, page ${pageNumber}`);
      repairResult = await autoRepairWithTargets(currentImage.imageData, currentImage.fixTargets, 0);
    } else {
      log.info(`🔄 [REPAIR] No pre-computed targets, using inspection-based repair for story ${id}, page ${pageNumber}`);
      repairResult = await autoRepairImage(currentImage.imageData, 1);  // Only 1 repair cycle
    }

    if (!repairResult) {
      return res.status(500).json({ error: 'Auto-repair failed' });
    }

    // Update the image in story data if repaired
    if (repairResult.repaired) {
      const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);
      if (existingIndex >= 0) {
        sceneImages[existingIndex] = {
          ...sceneImages[existingIndex],
          imageData: repairResult.imageData,
          wasAutoRepaired: true,
          repairHistory: repairResult.repairHistory,
          repairedAt: new Date().toISOString()
        };
      }

      // Save updated story
      storyData.sceneImages = sceneImages;
      await dbPool.query(
        'UPDATE stories SET data = $1 WHERE id = $2',
        [JSON.stringify(storyData), id]
      );

      log.info(`✅ [REPAIR] Image repaired for story ${id}, page ${pageNumber}`);
    } else {
      log.info(`ℹ️ [REPAIR] No repairs needed for story ${id}, page ${pageNumber}`);
    }

    res.json({
      success: true,
      pageNumber,
      repaired: repairResult.repaired,
      noErrorsFound: repairResult.noErrorsFound,
      imageData: repairResult.imageData,
      repairHistory: repairResult.repairHistory
    });

  } catch (err) {
    log.error('Error in auto-repair:', err);
    res.status(500).json({ error: 'Failed to auto-repair image: ' + err.message });
  }
});

// Edit cover image with a user prompt
app.post('/api/stories/:id/edit/cover/:coverType', authenticateToken, async (req, res) => {
  try {
    const { id, coverType } = req.params;
    const { editPrompt } = req.body;

    // Accept both 'initial' and 'initialPage' for backwards compatibility
    const normalizedCoverType = coverType === 'initial' ? 'initialPage' : coverType;
    if (!['front', 'initialPage', 'back'].includes(normalizedCoverType)) {
      return res.status(400).json({ error: 'Invalid cover type. Must be: front, initial/initialPage, or back' });
    }

    if (!editPrompt || editPrompt.trim().length === 0) {
      return res.status(400).json({ error: 'editPrompt is required' });
    }

    log.debug(`✏️ Editing ${normalizedCoverType} cover for story ${id}`);
    log.debug(`✏️ Edit instruction: "${editPrompt}"`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get the current cover image
    const coverImages = storyData.coverImages || {};
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' :
                     normalizedCoverType === 'back' ? 'backCover' : 'initialPage';
    const currentCover = coverImages[coverKey];

    if (!currentCover) {
      return res.status(404).json({ error: 'No cover image found' });
    }

    // Get the image data (handle both string and object formats)
    const currentImageData = typeof currentCover === 'string' ? currentCover : currentCover.imageData;
    if (!currentImageData) {
      return res.status(404).json({ error: 'No cover image data found' });
    }

    // Capture previous image info before editing
    const previousImageData = currentImageData;
    const previousScore = typeof currentCover === 'object' ? currentCover.qualityScore || null : null;
    const previousReasoning = typeof currentCover === 'object' ? currentCover.qualityReasoning || null : null;
    log.debug(`📸 [COVER EDIT] Capturing previous image (score: ${previousScore})`);

    // Edit the cover image (pure text/instruction based - no character photos to avoid regeneration artifacts)
    const editResult = await editImageWithPrompt(currentImageData, editPrompt);

    if (!editResult || !editResult.imageData) {
      return res.status(500).json({ error: 'Failed to edit cover - no result returned' });
    }

    // Evaluate the edited cover quality
    log.debug(`⭐ [COVER EDIT] Evaluating edited cover quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'cover');
      qualityScore = evaluation.score;
      qualityReasoning = evaluation.reasoning;
      log.debug(`⭐ [COVER EDIT] Edited cover score: ${qualityScore}%`);
    } catch (evalErr) {
      log.error(`⚠️ [COVER EDIT] Quality evaluation failed:`, evalErr.message);
    }

    // Update the cover image in story data
    const updatedCover = {
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      wasEdited: true,
      lastEditPrompt: editPrompt,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning,
      editedAt: new Date().toISOString(),
      // Preserve other existing fields
      ...(typeof currentCover === 'object' ? {
        description: currentCover.description,
        prompt: currentCover.prompt
      } : {})
    };
    coverImages[coverKey] = updatedCover;

    // Save updated story
    storyData.coverImages = coverImages;
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Cover edited for story ${id}, type: ${normalizedCoverType} (new score: ${qualityScore})`);

    res.json({
      success: true,
      coverType: normalizedCoverType,
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning
    });

  } catch (err) {
    log.error('Error editing cover:', err);
    res.status(500).json({ error: 'Failed to edit cover: ' + err.message });
  }
});

// Edit page text or scene description directly
app.patch('/api/stories/:id/page/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { text, sceneDescription } = req.body;
    const pageNumber = parseInt(pageNum);

    if (!text && !sceneDescription) {
      return res.status(400).json({ error: 'Provide text or sceneDescription to update' });
    }

    log.debug(`📝 Editing page ${pageNumber} for story ${id}`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Update page text if provided
    if (text !== undefined) {
      storyData.storyText = updatePageText(storyData.storyText, pageNumber, text);
    }

    // Update scene description if provided
    if (sceneDescription !== undefined) {
      let sceneDescriptions = storyData.sceneDescriptions || [];
      const existingIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);

      if (existingIndex >= 0) {
        sceneDescriptions[existingIndex].description = sceneDescription;
      } else {
        sceneDescriptions.push({ pageNumber, description: sceneDescription });
        sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
      }
      storyData.sceneDescriptions = sceneDescriptions;
    }

    // Save updated story
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Page ${pageNumber} updated for story ${id}`);

    res.json({
      success: true,
      pageNumber,
      updated: { text: text !== undefined, sceneDescription: sceneDescription !== undefined }
    });

  } catch (err) {
    log.error('Error editing page:', err);
    res.status(500).json({ error: 'Failed to edit page: ' + err.message });
  }
});
// Get checkpoints for a job (for debugging/admin)
app.get('/api/jobs/:jobId/checkpoints', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;

    // Verify user owns this job or is admin
    const jobResult = await dbPool.query(
      'SELECT user_id FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (jobResult.rows[0].user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const checkpoints = await getAllCheckpoints(jobId);

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
app.get('/api/jobs/:jobId/checkpoints/:stepName', authenticateToken, async (req, res) => {
  try {
    const { jobId, stepName } = req.params;
    const stepIndex = parseInt(req.query.index) || 0;

    // Verify user owns this job or is admin
    const jobResult = await dbPool.query(
      'SELECT user_id FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (jobResult.rows[0].user_id !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const checkpoint = await getCheckpoint(jobId, stepName, stepIndex);

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

// Helper: Get text for a specific page from storyText
function getPageText(storyText, pageNumber) {
  if (!storyText) return null;

  // Match page markers like "--- Page X ---" or "## Page X"
  const pageRegex = new RegExp(`(?:---|##)\\s*Page\\s+${pageNumber}\\s*(?:---|\\n)([\\s\\S]*?)(?=(?:---|##)\\s*Page\\s+\\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  return match ? match[1].trim() : null;
}

// Helper: Update text for a specific page in storyText
function updatePageText(storyText, pageNumber, newText) {
  if (!storyText) return `--- Page ${pageNumber} ---\n${newText}\n`;

  const pageRegex = new RegExp(`((?:---|##)\\s*Page\\s+${pageNumber}\\s*(?:---|\\n))([\\s\\S]*?)(?=(?:---|##)\\s*Page\\s+\\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  if (match) {
    return storyText.replace(pageRegex, `$1\n${newText}\n`);
  } else {
    // Page doesn't exist, append it
    return storyText + `\n--- Page ${pageNumber} ---\n${newText}\n`;
  }
}

// Print Provider API - Create photobook order
app.post('/api/print-provider/order', authenticateToken, async (req, res) => {
  try {
    let { storyId, pdfUrl, shippingAddress, orderReference, productUid, pageCount } = req.body;

    // If storyId provided, look up story to get pdfUrl and pageCount
    if (storyId && !pdfUrl) {
      let storyData = null;
      if (STORAGE_MODE === 'database' && dbPool) {
        const rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [storyId, req.user.id]);
        if (rows.length > 0) {
          // Parse JSON data from database
          storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
        }
      } else {
        const allStories = await readJSON(STORIES_FILE);
        const userStories = allStories[req.user.id] || [];
        storyData = userStories.find(s => s.id === storyId);
      }

      if (!storyData) {
        return res.status(404).json({ error: 'Story not found' });
      }

      // Generate fresh PDF using the shared print function (same as Buy Book)
      log.debug(`🖨️ [PRINT] Generating fresh print PDF for story: ${storyId}`);
      try {
        const { pdfBuffer, pageCount: generatedPageCount } = await generatePrintPdf(storyData);
        pageCount = generatedPageCount;

        // Save PDF temporarily to database for Gelato to fetch
        const pdfFileId = `pdf-print-${storyId}-${Date.now()}`;
        const pdfBase64 = pdfBuffer.toString('base64');

        // Delete any existing print PDFs for this story first
        await dbQuery("DELETE FROM files WHERE story_id = $1 AND file_type = 'print_pdf'", [storyId]);

        await dbQuery(
          'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [pdfFileId, req.user.id, 'print_pdf', storyId, 'application/pdf', pdfBase64, pdfBuffer.length, `story-${storyId}-print.pdf`]
        );

        const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
        pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;
        log.debug(`🖨️ [PRINT] PDF generated and saved with URL: ${pdfUrl}, pageCount: ${pageCount}`);
      } catch (pdfErr) {
        log.error(`🖨️ [PRINT] Error generating PDF:`, pdfErr.message);
        return res.status(500).json({ error: 'Failed to generate print PDF', details: pdfErr.message });
      }
    }

    // Default productUid for hardcover photobook if not provided
    if (!productUid) {
      // Try to get an active product from the database that supports the page count
      if (STORAGE_MODE === 'database' && dbPool) {
        const productResult = await dbQuery(
          `SELECT product_uid FROM gelato_products
           WHERE is_active = true
           AND (min_pages IS NULL OR min_pages <= $1)
           AND (max_pages IS NULL OR max_pages >= $1)
           ORDER BY created_at DESC LIMIT 1`,
          [pageCount]
        );
        if (productResult.length > 0) {
          productUid = productResult[0].product_uid;
          console.log(`🖨️ [PRINT] Using product from database: ${productUid} for ${pageCount} pages`);
        }
      }

      // Fallback to environment variable or error if no database product found
      if (!productUid) {
        productUid = process.env.GELATO_PHOTOBOOK_UID;
        if (productUid) {
          console.log(`🖨️ [PRINT] Using environment fallback product`);
        } else {
          return res.status(500).json({ error: 'No active products configured. Please add products in admin dashboard.' });
        }
      }
    }

    if (!pdfUrl || !shippingAddress || !pageCount) {
      return res.status(400).json({ error: 'Missing required fields: pdfUrl (or storyId), shippingAddress, pageCount' });
    }

    // Validate and normalize shipping address
    if (!shippingAddress.country || typeof shippingAddress.country !== 'string') {
      return res.status(400).json({ error: 'Country code is required in shipping address' });
    }

    shippingAddress.country = shippingAddress.country.trim().toUpperCase();

    if (shippingAddress.country.length !== 2 || !/^[A-Z]{2}$/.test(shippingAddress.country)) {
      return res.status(400).json({
        error: 'Country must be a valid 2-letter ISO code (e.g., US, DE, CH, FR)',
        hint: 'Please update your shipping address with a valid country code'
      });
    }

    // Validate email
    if (!shippingAddress.email || typeof shippingAddress.email !== 'string') {
      return res.status(400).json({ error: 'Email is required in shipping address' });
    }

    shippingAddress.email = shippingAddress.email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(shippingAddress.email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address',
        hint: 'Email format should be like: user@example.com'
      });
    }

    const printApiKey = process.env.GELATO_API_KEY;
    // Use user role to determine Gelato order type: admin = draft, regular user = real order
    const orderType = isUserTestMode(req.user) ? 'draft' : 'order';

    if (!printApiKey || printApiKey === 'your_print_api_key_here') {
      return res.status(500).json({
        error: 'Print provider API not configured. Please add GELATO_API_KEY to .env file',
        setupUrl: 'https://dashboard.gelato.com/'
      });
    }

    log.debug(`📦 [GELATO] Creating ${orderType} (user role: ${req.user.role})`);

    // Prepare print provider order payload
    const orderPayload = {
      orderType: orderType, // 'draft' for preview only, 'order' for actual printing
      orderReferenceId: orderReference || `magical-story-${Date.now()}`,
      customerReferenceId: req.user.id,
      currency: 'CHF',
      items: [
        {
          itemReferenceId: `item-${Date.now()}`,
          productUid: productUid,
          pageCount: parseInt(pageCount), // Add page count as item attribute
          files: [
            {
              type: 'default',
              url: pdfUrl
            }
          ],
          quantity: 1
        }
      ],
      shipmentMethodUid: 'standard',
      shippingAddress: {
        firstName: shippingAddress.firstName,
        lastName: shippingAddress.lastName,
        addressLine1: shippingAddress.addressLine1,
        addressLine2: shippingAddress.addressLine2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state || '',
        postCode: shippingAddress.postCode,
        country: shippingAddress.country,
        email: shippingAddress.email,
        phone: shippingAddress.phone || ''
      }
    };

    // Call print provider API
    const printResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': printApiKey
      },
      body: JSON.stringify(orderPayload)
    });

    const printData = await printResponse.json();

    if (!printResponse.ok) {
      log.error('Print provider API error:', printData);
      return res.status(printResponse.status).json({
        error: 'Print provider order failed',
        details: printData
      });
    }

    await logActivity(req.user.id, req.user.username, 'PRINT_ORDER_CREATED', {
      orderId: printData.orderId || printData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType
    });

    // Extract preview URLs if available
    const previewUrls = [];
    if (printData.items && Array.isArray(printData.items)) {
      printData.items.forEach(item => {
        if (item.previews && Array.isArray(item.previews)) {
          item.previews.forEach(preview => {
            if (preview.url) {
              previewUrls.push({
                type: preview.type || 'preview',
                url: preview.url
              });
            }
          });
        }
      });
    }

    res.json({
      success: true,
      orderId: printData.orderId || printData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType,
      isDraft: orderType === 'draft',
      previewUrls: previewUrls,
      dashboardUrl: `https://dashboard.gelato.com/checkout/${printData.orderId || printData.id}/product`,
      data: printData
    });

  } catch (err) {
    log.error('Error creating print provider order:', err);
    res.status(500).json({ error: 'Failed to create print order', details: err.message });
  }
});

// Print Provider Product Management (Admin Only)

// Fetch products from print provider API
app.get('/api/admin/print-provider/fetch-products', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey || printApiKey === 'your_print_api_key_here') {
      return res.status(500).json({ error: 'Print provider API not configured' });
    }

    // Step 1: Fetch all available catalogs from print provider
    const catalogsResponse = await fetch('https://product.gelatoapis.com/v3/catalogs', {
      headers: {
        'X-API-KEY': printApiKey
      }
    });

    if (!catalogsResponse.ok) {
      const errorData = await catalogsResponse.json();
      return res.status(catalogsResponse.status).json({ error: 'Failed to fetch catalogs from print provider', details: errorData });
    }

    const catalogsData = await catalogsResponse.json();
    console.log('📁 Print provider catalogs RAW response:', JSON.stringify(catalogsData).substring(0, 500));

    // Try different possible response structures
    const catalogs = catalogsData.catalogs || catalogsData.data || catalogsData.results || catalogsData || [];
    const catalogArray = Array.isArray(catalogs) ? catalogs : (catalogs.items || []);

    console.log('📁 Print provider catalogs:', {
      count: catalogArray.length,
      catalogUids: catalogArray.slice(0, 5).map(c => c?.uid || c?.id || c?.catalogUid || 'unknown'),
      firstCatalog: catalogArray[0] || null
    });

    // Step 2: Search ONLY photobook catalogs
    let allPhotobooks = [];
    const photobookCatalogs = ['hard-cover-photobooks', 'soft-cover-photobooks'];

    log.debug(`📚 Targeting photobook catalogs: ${photobookCatalogs.join(', ')}`);

    for (const catalogUid of photobookCatalogs) {
      try {
        log.debug(`🔍 Searching photobook catalog: ${catalogUid}`);
        // Search for products in this catalog
        const searchResponse = await fetch(`https://product.gelatoapis.com/v3/catalogs/${catalogUid}/products:search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-KEY': printApiKey
          },
          body: JSON.stringify({
            limit: 100,
            offset: 0
          })
        });

        log.debug(`📡 Search response status: ${searchResponse.status}`);

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          log.error(`❌ Failed to search ${catalogUid}:`, errorText.substring(0, 200));
          continue;
        }

        const searchData = await searchResponse.json();
        log.debug(`📦 ${catalogUid} response:`, {
          hasProducts: !!searchData.products,
          productCount: searchData.products?.length || 0,
          responseKeys: Object.keys(searchData)
        });

        // Accept ALL products from photobook catalogs
        const photobooks = searchData.products || [];
        log.debug(`📚 ${catalogUid}: Found ${photobooks.length} products`);

        if (photobooks.length > 0) {
          log.debug(`📚 First 3 products from ${catalogUid}:`);
          photobooks.slice(0, 3).forEach((p, i) => {
            log.debug(`  ${i+1}. ${p.name || p.productName || 'Unnamed'} (UID: ${p.productUid || p.uid})`);
          });
        } else {
          log.warn(`No products found in ${catalogUid}!`);
        }

        allPhotobooks = allPhotobooks.concat(photobooks);
      } catch (err) {
        log.error(`❌ Error searching catalog ${catalogUid}:`, err.message);
        log.error('Error stack:', err.stack);
      }
    }

    // Remove duplicates based on productUid
    const uniquePhotobooks = Array.from(
      new Map(allPhotobooks.map(p => [p.productUid || p.uid, p])).values()
    );

    log.debug('📚 Total unique photobooks found:', uniquePhotobooks.length);

    res.json({
      success: true,
      count: uniquePhotobooks.length,
      products: uniquePhotobooks,
      catalogsSearched: photobookCatalogs.length,
      catalogs: photobookCatalogs
    });

  } catch (err) {
    log.error('Error fetching print provider products:', err);
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// Get all saved print provider products from database
app.get('/api/admin/print-provider/products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT * FROM gelato_products ORDER BY is_active DESC, created_at DESC';

      const rows = await dbQuery(selectQuery, []);
      res.json({ success: true, products: rows });
    } else {
      // File mode fallback
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        const products = JSON.parse(data);
        res.json({ success: true, products: Object.values(products) });
      } catch (err) {
        res.json({ success: true, products: [] });
      }
    }

  } catch (err) {
    log.error('Error getting products:', err);
    res.status(500).json({ error: 'Failed to get products', details: err.message });
  }
});

// Save/Update print provider product
app.post('/api/admin/print-provider/products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
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

    if (!product_uid || !product_name) {
      return res.status(400).json({ error: 'Missing required fields: product_uid, product_name' });
    }

    // Convert available_page_counts array to JSON string if needed
    const pageCountsStr = Array.isArray(available_page_counts)
      ? JSON.stringify(available_page_counts)
      : available_page_counts;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Try to insert, if exists, update
      const upsertQuery = `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
           ON CONFLICT (product_uid)
           DO UPDATE SET
             product_name = $2,
             description = $3,
             size = $4,
             cover_type = $5,
             min_pages = $6,
             max_pages = $7,
             available_page_counts = $8,
             is_active = $9,
             updated_at = CURRENT_TIMESTAMP`;

      await dbQuery(upsertQuery, [
        product_uid,
        product_name,
        description || null,
        size || null,
        cover_type || null,
        min_pages || null,
        max_pages || null,
        pageCountsStr || null,
        is_active !== false
      ]);
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      let products = {};
      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        products = JSON.parse(data);
      } catch (err) {
        // File doesn't exist yet
      }

      products[product_uid] = {
        product_uid,
        product_name,
        description: description || null,
        size: size || null,
        cover_type: cover_type || null,
        min_pages: min_pages || null,
        max_pages: max_pages || null,
        available_page_counts: pageCountsStr || null,
        is_active: is_active !== false,
        updated_at: new Date().toISOString()
      };

      await fs.writeFile(productsFile, JSON.stringify(products, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_SAVED', { product_uid });

    res.json({ success: true, message: 'Product saved successfully' });

  } catch (err) {
    log.error('Error saving product:', err);
    res.status(500).json({ error: 'Failed to save product', details: err.message });
  }
});

// Seed default products (Admin only)
app.post('/api/admin/print-provider/seed-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Default 20x20cm (8x8 inch) photobook product
    const defaultProduct = {
      product_uid: 'photobooks-softcover_pf_8x8-inch-200x200-mm_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_250-gsm-100-lb-cover-coated-silk_ver',
      product_name: '20x20cm Softcover Photobook',
      description: 'Square softcover photobook with matt lamination, 170gsm coated silk paper',
      size: '20x20cm (8x8 inch)',
      cover_type: 'softcover',
      min_pages: 24,
      max_pages: 200,
      available_page_counts: JSON.stringify([24, 30, 40, 50, 60, 80, 100, 120, 150, 200]),
      is_active: true
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      const upsertQuery = `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (product_uid)
           DO UPDATE SET
             product_name = $2,
             description = $3,
             size = $4,
             cover_type = $5,
             min_pages = $6,
             max_pages = $7,
             available_page_counts = $8,
             is_active = $9,
             updated_at = CURRENT_TIMESTAMP`;

      await dbQuery(upsertQuery, [
        defaultProduct.product_uid,
        defaultProduct.product_name,
        defaultProduct.description,
        defaultProduct.size,
        defaultProduct.cover_type,
        defaultProduct.min_pages,
        defaultProduct.max_pages,
        defaultProduct.available_page_counts,
        defaultProduct.is_active
      ]);

      res.json({ success: true, message: 'Default product seeded successfully' });
    } else {
      res.status(500).json({ error: 'Database mode required for seeding' });
    }

  } catch (err) {
    log.error('Error seeding products:', err);
    res.status(500).json({ error: 'Failed to seed products', details: err.message });
  }
});


app.get('/api/print-provider/products', async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = true ORDER BY product_name';

      const rows = await dbQuery(selectQuery, []);
      res.json({ success: true, products: rows });
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'print_products.json');

      try {
        const data = await fs.readFile(productsFile, 'utf-8');
        const allProducts = JSON.parse(data);
        const activeProducts = Object.values(allProducts).filter(p => p.is_active);
        res.json({ success: true, products: activeProducts });
      } catch (err) {
        res.json({ success: true, products: [] });
      }
    }

  } catch (err) {
    log.error('Error getting active products:', err);
    res.status(500).json({ error: 'Failed to get products', details: err.message });
  }
});

// NOTE: Photo analyzer status moved to server/routes/photos.js -> GET /api/photos/status

// Photo Analysis Endpoint (calls Python DeepFace service)
app.post('/api/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      log.debug('📸 [PHOTO] Missing imageData in request');
      return res.status(400).json({ error: 'Missing imageData' });
    }

    // Log image info
    const imageSize = imageData.length;
    const imageType = imageData.substring(0, 30);
    log.debug(`📸 [PHOTO] Received image: ${imageSize} bytes, type: ${imageType}...`);

    // Run Python analysis and Gemini trait extraction in parallel
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
    log.debug(`📸 [PHOTO] Calling Python service at: ${photoAnalyzerUrl}/analyze`);
    log.debug(`📸 [PHOTO] Calling Gemini for visual trait extraction...`);

    const startTime = Date.now();

    // Helper function for Gemini trait extraction
    const extractTraitsWithGemini = async () => {
      try {
        const geminiApiKey = process.env.GEMINI_API_KEY;
        if (!geminiApiKey) {
          log.debug('📸 [GEMINI] No API key, skipping trait extraction');
          return null;
        }

        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
          imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{
                parts: [
                  {
                    text: PROMPT_TEMPLATES.characterAnalysis || `Analyze this image of a person for a children's book illustration system. Return JSON with traits (age, gender, height, build, face, hair). Be specific about colors.`
                  },
                  {
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Data,
                    },
                  },
                ],
              }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 2048
              }
            }),
            signal: AbortSignal.timeout(20000) // 20 second timeout
          }
        );

        if (!response.ok) {
          log.error('📸 [GEMINI] API error:', response.status);
          return null;
        }

        const data = await response.json();

        // Extract and log token usage for character analysis
        const modelId = 'gemini-2.0-flash-exp';
        const inputTokens = data.usageMetadata?.promptTokenCount || 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        if (inputTokens > 0 || outputTokens > 0) {
          console.log(`📊 [CHARACTER ANALYSIS] Token usage - model: ${modelId}, input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
        }

        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          const text = data.candidates[0].content.parts[0].text;
          log.debug('📸 [GEMINI] Raw response length:', text.length);
          // Extract JSON from response (may have markdown wrapping)
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            // Handle nested traits format or flat format
            if (result.traits) {
              log.debug('📸 [GEMINI] Extracted traits:', result.traits);
              return result;
            } else {
              // Flat traits object - wrap in traits
              log.debug('📸 [GEMINI] Extracted traits (flat format):', result);
              return { traits: result };
            }
          } else {
            log.error('📸 [GEMINI] No JSON found in response:', text.substring(0, 200));
          }
        } else {
          log.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
        }
        return null;
      } catch (err) {
        log.error('📸 [GEMINI] Trait extraction error:', err.message);
        return null;
      }
    };

    // Helper function for Python analysis (face detection + background removal only)
    const analyzePython = async () => {
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData }),
        signal: AbortSignal.timeout(30000) // 30 second timeout (MediaPipe is fast, no heavy model downloads)
      });
      return analyzerResponse.json();
    };

    try {
      // Run both in parallel
      const [analyzerData, geminiTraits] = await Promise.all([
        analyzePython(),
        extractTraitsWithGemini()
      ]);

      const duration = Date.now() - startTime;

      // VERBOSE LOGGING
      log.debug(`📸 [PHOTO] Analysis complete in ${duration}ms:`, {
        pythonSuccess: analyzerData.success,
        hasError: !!analyzerData.error,
        error: analyzerData.error || null,
        hasFaceThumbnail: !!analyzerData.faceThumbnail || !!analyzerData.face_thumbnail,
        hasBodyCrop: !!analyzerData.bodyCrop || !!analyzerData.body_crop,
        hasBodyNoBg: !!analyzerData.bodyNoBg || !!analyzerData.body_no_bg,
        hasFaceBox: !!analyzerData.faceBox || !!analyzerData.face_box,
        hasBodyBox: !!analyzerData.bodyBox || !!analyzerData.body_box,
        pythonAttributes: analyzerData.attributes || null,
        geminiTraits: geminiTraits || null,
        traceback: analyzerData.traceback ? analyzerData.traceback.substring(0, 500) : null
      });

      if (!analyzerData.success) {
        // Check if this is an expected user error (no face detected) vs server error
        if (analyzerData.error === 'no_face_detected') {
          log.warn('📸 [PHOTO] No face detected in photo');
          // Return 200 with success: false for expected user errors
          // This allows the client to show a proper error message
          return res.json({
            success: false,
            error: 'no_face_detected'
          });
        }
        // Unexpected server error
        log.error('📸 [PHOTO] Python analysis failed:', analyzerData.error, analyzerData.traceback);
        return res.status(500).json({
          error: 'Photo analysis failed',
          details: analyzerData.error || 'Unknown error',
          traceback: analyzerData.traceback
        });
      }

      // Merge Gemini traits into attributes (only fill if not already set)
      const traits = geminiTraits?.traits || geminiTraits; // Handle both formats

      if (traits) {
        analyzerData.attributes = analyzerData.attributes || {};
        // Age, gender, height, build - only fill if blank
        if (traits.age && !analyzerData.attributes.age) {
          analyzerData.attributes.age = String(traits.age);
        }
        if (traits.gender && !analyzerData.attributes.gender) {
          analyzerData.attributes.gender = traits.gender.toLowerCase();
        }
        if (traits.height && !analyzerData.attributes.height) {
          analyzerData.attributes.height = traits.height;
        }
        if (traits.build && !analyzerData.attributes.build) {
          analyzerData.attributes.build = traits.build;
        }
        // Face description
        if (traits.face) {
          analyzerData.attributes.face = traits.face;
        }
        // Hair - always set from Gemini (more accurate)
        if (traits.hair) {
          analyzerData.attributes.hair_color = traits.hair;
        }
        // Distinctive markings (glasses, facial hair, scars, moles, jewelry, etc.)
        // Support both new "distinctive markings" field and legacy "other" field
        const distinctiveMarkings = traits["distinctive markings"] || traits.distinctiveMarkings || traits.other;
        if (distinctiveMarkings && distinctiveMarkings !== 'none') {
          analyzerData.attributes.other_features = distinctiveMarkings;
        }
        // Clothing description
        if (traits.clothing) {
          analyzerData.attributes.clothing = traits.clothing;
        }
        // Clothing style (colors + patterns - used for avatar style matching)
        if (traits.clothingStyle) {
          analyzerData.attributes.clothingStyle = traits.clothingStyle;
        } else if (traits.clothingColors) {
          // Backward compatibility
          analyzerData.attributes.clothingStyle = traits.clothingColors;
        }
      }

      await logActivity(req.user.id, req.user.username, 'PHOTO_ANALYZED', {
        age: analyzerData.attributes?.age,
        gender: analyzerData.attributes?.gender,
        hasFace: !!analyzerData.face_thumbnail || !!analyzerData.faceThumbnail,
        hasBody: !!analyzerData.body_crop || !!analyzerData.bodyCrop,
        hasGeminiTraits: !!geminiTraits
      });

      // Convert snake_case to camelCase for frontend compatibility
      const response = {
        success: analyzerData.success,
        faceThumbnail: analyzerData.face_thumbnail || analyzerData.faceThumbnail,
        bodyCrop: analyzerData.body_crop || analyzerData.bodyCrop,
        bodyNoBg: analyzerData.body_no_bg || analyzerData.bodyNoBg,
        faceBox: analyzerData.face_box || analyzerData.faceBox,
        bodyBox: analyzerData.body_box || analyzerData.bodyBox,
        attributes: analyzerData.attributes
      };

      log.debug('📸 [PHOTO] Sending response:', {
        hasAttributes: !!analyzerData.attributes,
        clothing: analyzerData.attributes?.clothing
      });
      res.json(response);

    } catch (fetchErr) {
      log.error('Photo analyzer service error:', fetchErr.message);

      // Return a helpful error when Python service is down
      if (fetchErr.cause?.code === 'ECONNREFUSED') {
        return res.status(503).json({
          error: 'Photo analysis service unavailable',
          details: 'The photo analysis service is not running. Please contact support.',
          fallback: true
        });
      }

      throw fetchErr; // Re-throw other errors to outer catch
    }

  } catch (err) {
    log.error('Error analyzing photo:', err);
    res.status(500).json({
      error: 'Failed to analyze photo',
      details: err.message,
      fallback: true
    });
  }
});


// Get avatar prompt for a given category and gender (for developer mode display)
app.get('/api/avatar-prompt', authenticateToken, async (req, res) => {
  try {
    const { category, gender } = req.query;
    const isFemale = gender === 'female';

    // Helper to extract clothing style from template
    const getClothingStylePrompt = (cat) => {
      const template = PROMPT_TEMPLATES.avatarMainPrompt || '';
      const styleSection = template.split('CLOTHING_STYLES:')[1] || '';

      let tag;
      if (cat === 'winter') {
        tag = isFemale ? '[WINTER_FEMALE]' : '[WINTER_MALE]';
      } else if (cat === 'standard') {
        tag = isFemale ? '[STANDARD_FEMALE]' : '[STANDARD_MALE]';
      } else if (cat === 'summer') {
        tag = isFemale ? '[SUMMER_FEMALE]' : '[SUMMER_MALE]';
      } else if (cat === 'formal') {
        tag = isFemale ? '[FORMAL_FEMALE]' : '[FORMAL_MALE]';
      } else {
        return 'Full outfit with shoes matching the style of the reference.';
      }

      const tagIndex = styleSection.indexOf(tag);
      if (tagIndex === -1) {
        return 'Full outfit with shoes matching the style of the reference.';
      }

      const afterTag = styleSection.substring(tagIndex + tag.length);
      const nextTagIndex = afterTag.search(/\n\[/);
      const styleText = nextTagIndex === -1 ? afterTag : afterTag.substring(0, nextTagIndex);
      return styleText.trim();
    };

    // Build the prompt from template
    const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
    const clothingStyle = getClothingStylePrompt(category);
    let avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingStyle,
      'BUILD': req.query.build || 'average'
    });

    // If physical traits are provided, append them (for "With Traits" display)
    if (req.query.withTraits === 'true') {
      const traitParts = [];
      if (req.query.hair) traitParts.push(`Hair: ${req.query.hair}`);
      if (req.query.face) traitParts.push(`Face: ${req.query.face}`);
      if (req.query.other) traitParts.push(`Distinctive features: ${req.query.other}`);
      if (req.query.height) traitParts.push(`Height: ${req.query.height}cm`);
      if (traitParts.length > 0) {
        avatarPrompt += `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
      }
    }

    res.json({ success: true, prompt: avatarPrompt });
  } catch (error) {
    log.error('Error getting avatar prompt:', error);
    res.status(500).json({ error: error.message });
  }
});


// Generate clothing avatars for a character (4 categories: winter, standard, summer, formal)
// This creates photorealistic avatars with different clothing for story illustration
// Prompts based on reference implementation - see prompts/clothing-avatars.txt
app.post('/api/generate-clothing-avatars', authenticateToken, async (req, res) => {
  try {
    const { characterId, facePhoto, physicalDescription, name, age, gender, build, physicalTraits } = req.body;

    if (!facePhoto) {
      return res.status(400).json({ error: 'Missing facePhoto' });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    // Build physical traits section if provided (for "Generate with Traits" mode)
    let physicalTraitsSection = '';
    if (physicalTraits) {
      const traitParts = [];
      if (physicalTraits.hair) traitParts.push(`Hair: ${physicalTraits.hair}`);
      if (physicalTraits.face) traitParts.push(`Face: ${physicalTraits.face}`);
      if (physicalTraits.other) traitParts.push(`Distinctive features: ${physicalTraits.other}`);
      if (physicalTraits.height) traitParts.push(`Height: ${physicalTraits.height}cm`);
      if (traitParts.length > 0) {
        physicalTraitsSection = `\n\nPHYSICAL CHARACTERISTICS (MUST INCLUDE):\n${traitParts.join('\n')}`;
      }
      log.debug(`👔 [CLOTHING AVATARS] Including physical traits: ${traitParts.join(', ')}`);
    }

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name} (id: ${characterId})${physicalTraits ? ' WITH TRAITS' : ''}`);

    // Parse clothing styles from the template file
    const isFemale = gender === 'female';

    const getClothingStylePrompt = (category) => {
      const template = PROMPT_TEMPLATES.avatarMainPrompt || '';
      const styleSection = template.split('CLOTHING_STYLES:')[1] || '';

      // Build the tag to look for based on category and gender
      let tag;
      if (category === 'winter') {
        tag = isFemale ? '[WINTER_FEMALE]' : '[WINTER_MALE]';
      } else if (category === 'standard') {
        tag = isFemale ? '[STANDARD_FEMALE]' : '[STANDARD_MALE]';
      } else if (category === 'summer') {
        tag = isFemale ? '[SUMMER_FEMALE]' : '[SUMMER_MALE]';
      } else if (category === 'formal') {
        tag = isFemale ? '[FORMAL_FEMALE]' : '[FORMAL_MALE]';
      } else {
        return 'Full outfit with shoes matching the style of the reference.';
      }

      // Extract the text between this tag and the next tag (or end)
      const tagIndex = styleSection.indexOf(tag);
      if (tagIndex === -1) {
        return 'Full outfit with shoes matching the style of the reference.';
      }

      const afterTag = styleSection.substring(tagIndex + tag.length);
      const nextTagIndex = afterTag.search(/\n\[/);
      const styleText = nextTagIndex === -1 ? afterTag : afterTag.substring(0, nextTagIndex);

      return styleText.trim();
    };

    // Define clothing categories
    const clothingCategories = {
      winter: { emoji: '❄️' },
      standard: { emoji: '👕' },
      summer: { emoji: '☀️' },
      formal: { emoji: '👔' }
    };

    const results = {
      status: 'generating',
      generatedAt: null
    };

    // Generate avatars sequentially to avoid rate limits
    for (const [category, config] of Object.entries(clothingCategories)) {
      try {
        log.debug(`${config.emoji} [CLOTHING AVATARS] Generating ${category} avatar for ${name} (${gender || 'unknown'})...`);

        // Build the prompt from template (use only the prompt part, not the CLOTHING_STYLES section)
        const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
        const clothingStyle = getClothingStylePrompt(category);
        log.debug(`   [CLOTHING] Style for ${category}: "${clothingStyle}"`);
        let avatarPrompt = fillTemplate(promptPart, {
          'CLOTHING_STYLE': clothingStyle,
          'BUILD': build || 'average'
        });
        // Append physical traits section if provided
        if (physicalTraitsSection) {
          avatarPrompt += physicalTraitsSection;
        }
        log.debug(`   [CLOTHING] Prompt includes: "Outfit: ${clothingStyle.substring(0, 50)}..."`);

        // Prepare the request with reference photo
        const base64Data = facePhoto.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = facePhoto.match(/^data:(image\/\w+);base64,/) ?
          facePhoto.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

        const requestBody = {
          systemInstruction: {
            parts: [{
              text: PROMPT_TEMPLATES.avatarSystemInstruction
            }]
          },
          contents: [{
            parts: [
              // Image first, then text prompt (matching reference implementation order)
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64Data
                }
              },
              { text: avatarPrompt }
            ]
          }],
          generationConfig: {
            temperature: 0.3,  // Low temperature for better face consistency
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: {
              aspectRatio: "9:16"  // Portrait aspect ratio for full body shots
            }
          },
          // Relaxed safety settings to avoid false positives on fashion photography
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
          ]
        };

        // Use gemini-2.5-flash-image for avatar generation
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          log.error(`❌ [CLOTHING AVATARS] ${category} generation failed:`, errorText);
          continue; // Skip this category, try next
        }

        let data = await response.json();

        // Extract and log token usage for avatar generation
        const avatarModelId = 'gemini-2.5-flash-image';
        const avatarInputTokens = data.usageMetadata?.promptTokenCount || 0;
        const avatarOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
        if (avatarInputTokens > 0 || avatarOutputTokens > 0) {
          console.log(`📊 [AVATAR GENERATION] ${category} - model: ${avatarModelId}, input: ${avatarInputTokens.toLocaleString()}, output: ${avatarOutputTokens.toLocaleString()}`);
        }

        // Check if blocked by safety filters - retry once with simplified prompt
        if (data.promptFeedback?.blockReason) {
          log.warn(`[CLOTHING AVATARS] ${category} blocked by safety filters:`, data.promptFeedback.blockReason);
          log.debug(`🔄 [CLOTHING AVATARS] Retrying ${category} with simplified prompt...`);

          // Simplified retry prompt from template
          const outfitDescription = category === 'winter' ? 'a winter coat' : category === 'summer' ? 'a casual T-shirt and shorts' : category === 'formal' ? 'formal attire' : 'casual clothes';
          const retryPrompt = fillTemplate(PROMPT_TEMPLATES.avatarRetryPrompt, {
            '{OUTFIT_DESCRIPTION}': outfitDescription
          });

          const retryRequestBody = {
            ...requestBody,
            contents: [{
              parts: [
                requestBody.contents[0].parts[0], // Keep the image
                { text: retryPrompt }
              ]
            }]
          };

          const retryResponse = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiApiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(retryRequestBody)
            }
          );

          if (retryResponse.ok) {
            data = await retryResponse.json();
            // Log token usage for retry attempt
            const retryInputTokens = data.usageMetadata?.promptTokenCount || 0;
            const retryOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
            if (retryInputTokens > 0 || retryOutputTokens > 0) {
              console.log(`📊 [AVATAR GENERATION] ${category} retry - model: ${avatarModelId}, input: ${retryInputTokens.toLocaleString()}, output: ${retryOutputTokens.toLocaleString()}`);
            }
            if (data.promptFeedback?.blockReason) {
              log.warn(`[CLOTHING AVATARS] ${category} retry also blocked:`, data.promptFeedback.blockReason);
              continue;
            }
          } else {
            log.error(`❌ [CLOTHING AVATARS] ${category} retry failed`);
            continue;
          }
        }

        // Extract image from response
        let imageData = null;
        if (data.candidates && data.candidates[0]?.content?.parts) {
          for (const part of data.candidates[0].content.parts) {
            if (part.inlineData) {
              imageData = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (imageData) {
          // Compress avatar to JPEG for smaller file size
          try {
            const originalSize = Math.round(imageData.length / 1024);
            const compressedImage = await compressImageToJPEG(imageData);
            const compressedSize = Math.round(compressedImage.length / 1024);
            results[category] = compressedImage;
            log.debug(`✅ [CLOTHING AVATARS] ${category} avatar generated and compressed (${originalSize}KB -> ${compressedSize}KB)`);
          } catch (compressErr) {
            // If compression fails, use original
            log.warn(`[CLOTHING AVATARS] Compression failed for ${category}, using original:`, compressErr.message);
            results[category] = imageData;
          }
        } else {
          log.warn(`[CLOTHING AVATARS] No image in ${category} response`);
        }

        // Small delay between generations to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));

      } catch (err) {
        log.error(`❌ [CLOTHING AVATARS] Error generating ${category}:`, err.message);
      }
    }

    // Check if at least one avatar was generated
    const generatedCount = ['winter', 'standard', 'summer', 'formal'].filter(c => results[c]).length;
    if (generatedCount === 0) {
      return res.status(500).json({ error: 'Failed to generate any avatars' });
    }

    results.status = 'complete';
    results.generatedAt = new Date().toISOString();

    log.debug(`✅ [CLOTHING AVATARS] Generated ${generatedCount}/4 avatars for ${name}`);
    res.json({ success: true, clothingAvatars: results });

  } catch (err) {
    log.error('Error generating clothing avatars:', err);
    res.status(500).json({ error: 'Failed to generate clothing avatars', details: err.message });
  }
});


// ========================================
// NOTE: generatePrintPdf and generateCombinedBookPdf moved to server/lib/pdf.js

// GET PDF for a story - for DOWNLOAD/VIEWING (different sequence than print)
// Sequence: Front cover, Initial page, Story pages, Back cover (all separate pages)
// This is for viewing/download, NOT for printing - no database storage
app.get('/api/stories/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const storyId = req.params.id;
    const userId = req.user.id;

    log.debug(`📄 [PDF DOWNLOAD] Generating viewable PDF for story: ${storyId}`);

    // Fetch story from database
    const storyResult = await dbPool.query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [storyId, userId]
    );

    if (storyResult.rows.length === 0) {
      log.debug(`📄 [PDF DOWNLOAD] Story not found: ${storyId}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = typeof storyResult.rows[0].data === 'string'
      ? JSON.parse(storyResult.rows[0].data)
      : storyResult.rows[0].data;
    log.debug(`📄 [PDF DOWNLOAD] Story found: ${storyData.title}`);

    // Parse story into pages
    const storyText = storyData.storyText || storyData.story || '';
    const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Seite|Page)\s+\d+)/i);
    const storyPages = pageMatches.slice(1).filter(p => p.trim().length > 0);

    if (storyPages.length === 0) {
      log.debug(`📄 [PDF DOWNLOAD] No story pages found. Story text preview: ${storyText.substring(0, 200)}`);
      return res.status(400).json({ error: 'No story pages found' });
    }

    const isPictureBook = storyData.languageLevel === '1st-grade';
    log.debug(`📄 [PDF DOWNLOAD] Generating PDF with ${storyPages.length} pages, layout: ${isPictureBook ? 'Picture Book' : 'Standard'}`);

    // Helper function to extract image data
    const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

    const PDFDocument = require('pdfkit');
    const mmToPoints = (mm) => mm * 2.83465;
    const pageSize = mmToPoints(200);

    // Create PDF document - start with square pages for viewing
    const doc = new PDFDocument({
      size: [pageSize, pageSize],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    const pdfPromise = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    // 1. FRONT COVER (first page)
    const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
    if (frontCoverImageData) {
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(frontCoverBuffer, 0, 0, { width: pageSize, height: pageSize });
      } catch (err) {
        log.error('Error adding front cover:', err.message);
      }
    }

    // 2. INITIAL PAGE (dedication/intro)
    const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
    if (initialPageImageData) {
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
      } catch (err) {
        log.error('Error adding initial page:', err.message);
      }
    }

    // 3. STORY PAGES
    if (isPictureBook) {
      // Picture Book: combined image + text on same page
      const textMarginMm = mmToPoints(3);
      const imageHeight = pageSize * 0.85;
      const textAreaHeight = pageSize * 0.15;
      const textWidth = pageSize - (textMarginMm * 2);
      const availableTextHeight = textAreaHeight - textMarginMm;
      const lineGap = -2;

      storyPages.forEach((pageText, index) => {
        const pageNumber = index + 1;
        const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
        const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        if (image && image.imageData) {
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            // Full-bleed image (no margin)
            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, imageHeight],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            log.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }

        // Add text with vertical centering in text area (text has margin)
        let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
        }

        const textY = imageHeight + (availableTextHeight - textHeight) / 2;
        doc.text(cleanText, textMarginMm, textY, { width: textWidth, align: 'center', lineGap });
      });
    } else {
      // Standard: separate text and image pages
      const margin = 28;
      const availableWidth = pageSize - (margin * 2);
      const availableHeight = pageSize - (margin * 2);
      const lineGap = -2;

      storyPages.forEach((pageText, index) => {
        const pageNumber = index + 1;
        const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
        const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

        // Text page with vertical centering (has margin)
        doc.addPage({ size: [pageSize, pageSize], margins: { top: margin, bottom: margin, left: margin, right: margin } });

        let fontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

        while (textHeight > availableHeight * 0.9 && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
        }

        // Vertically center text
        const yPosition = margin + (availableHeight - textHeight) / 2;
        doc.text(cleanText, margin, yPosition, { width: availableWidth, align: 'left', lineGap });

        // Image page (full-bleed, no margin)
        if (image && image.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, pageSize],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            log.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }
      });
    }

    // 4. BACK COVER (last page)
    const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
    if (backCoverImageData) {
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      try {
        const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(backCoverBuffer, 0, 0, { width: pageSize, height: pageSize });
      } catch (err) {
        log.error('Error adding back cover:', err.message);
      }
    }

    doc.end();
    const pdfBuffer = await pdfPromise;

    log.debug(`📄 [PDF DOWNLOAD] PDF generated successfully (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // NO database storage - just send directly to user
    res.setHeader('Content-Type', 'application/pdf');
    const safeFilename = (storyData.title || 'story')
      .replace(/[–—]/g, '-')
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-zA-Z0-9\s\-_.]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
  }
});

// GET PRINT PDF for a story - ADMIN ONLY - uses same format as Buy Book/Print Book
// This allows admins to preview the exact PDF that would be sent to Gelato for printing
app.get('/api/stories/:id/print-pdf', authenticateToken, async (req, res) => {
  try {
    // Admin only
    if (req.user.role !== 'admin') {
      log.debug(`🖨️ [ADMIN PRINT PDF] Access denied - user ${req.user.username} is not admin (role: ${req.user.role})`);
      return res.status(403).json({ error: 'Admin access required' });
    }

    const storyId = req.params.id;
    log.debug(`🖨️ [ADMIN PRINT PDF] Admin ${req.user.username} requesting print PDF for story: ${storyId}`);
    console.log(`🖨️ [ADMIN PRINT PDF] Storage mode: ${STORAGE_MODE}, dbPool exists: ${!!dbPool}`);

    // Fetch story from database (admin can access any story)
    let storyData = null;
    if (STORAGE_MODE === 'database' && dbPool) {
      const storyResult = await dbQuery('SELECT data FROM stories WHERE id = $1', [storyId]);
      if (storyResult.length > 0) {
        storyData = typeof storyResult[0].data === 'string'
          ? JSON.parse(storyResult[0].data)
          : storyResult[0].data;
      }
    } else {
      // File mode - search all users
      const allStories = await readJSON(STORIES_FILE);
      for (const userId in allStories) {
        const story = allStories[userId].find(s => s.id === storyId);
        if (story) {
          storyData = story;
          break;
        }
      }
    }

    if (!storyData) {
      log.debug(`🖨️ [ADMIN PRINT PDF] Story not found: ${storyId}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    log.debug(`🖨️ [ADMIN PRINT PDF] Story found: ${storyData.title}`);
    log.debug(`🖨️ [ADMIN PRINT PDF] Story has: coverImages=${!!storyData.coverImages}, sceneImages=${storyData.sceneImages?.length || 0}, storyText=${!!storyData.storyText || !!storyData.generatedStory}`);

    // Generate print PDF using the shared function (same as Buy Book / Print Book)
    const { pdfBuffer, pageCount } = await generatePrintPdf(storyData);

    log.info(`🖨️ [ADMIN PRINT PDF] PDF generated: ${pageCount} pages, ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Return PDF for download
    res.setHeader('Content-Type', 'application/pdf');
    const safeFilename = (storyData.title || 'story')
      .replace(/[–—]/g, '-')
      .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-zA-Z0-9\s\-_.]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}-print.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('Error generating print PDF:', err);
    res.status(500).json({ error: 'Failed to generate print PDF', details: err.message });
  }
});

// Generate PDF from story (POST - with data in body)
app.post('/api/generate-pdf', authenticateToken, async (req, res) => {
  try {
    const { storyId, storyTitle, storyPages, sceneImages, coverImages, languageLevel } = req.body;

    if (!storyPages || !Array.isArray(storyPages) || storyPages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyPages' });
    }

    // Determine layout based on languageLevel
    // '1st-grade' = Picture Book = combined layout (image + text on same page)
    // 'standard' or 'advanced' = separate pages for text and image
    const isPictureBook = languageLevel === '1st-grade';
    log.debug(`📄 [PDF] Generating PDF with layout: ${isPictureBook ? 'Picture Book (combined)' : 'Standard (separate pages)'}`);

    // Helper function to extract image data from cover images
    // Supports both old format (base64 string) and new format (object with imageData property)
    const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

    const PDFDocument = require('pdfkit');
    const stream = require('stream');

    // Convert mm to points (1mm = 2.83465 points)
    const mmToPoints = (mm) => mm * 2.83465;

    // Page dimensions for 20x20cm (8x8 inch) photobook
    const coverWidth = mmToPoints(416);      // Cover spread: 200mm back + ~16mm spine + 200mm front
    const coverHeight = mmToPoints(206);     // Cover height: 200mm + 6mm bleed
    const pageSize = mmToPoints(200);        // Interior pages: 200x200mm

    // Create PDF document - start with cover page
    const doc = new PDFDocument({
      size: [coverWidth, coverHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false  // We'll add pages manually
    });

    // Collect PDF data in a buffer
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Wait for PDF to finish
    const pdfPromise = new Promise((resolve, reject) => {
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', reject);
    });

    // PDF Page 1: Back Cover + Front Cover (spread, 416 x 206 mm for 20x20cm book)
    doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    const backCoverImageData = getCoverImageData(coverImages?.backCover);
    const frontCoverImageData = getCoverImageData(coverImages?.frontCover);

    if (backCoverImageData && frontCoverImageData) {
      // Add back cover on left half
      const backCoverData = backCoverImageData.replace(/^data:image\/\w+;base64,/, '');
      const backCoverBuffer = Buffer.from(backCoverData, 'base64');
      doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });

      // Add front cover on right half
      const frontCoverData = frontCoverImageData.replace(/^data:image\/\w+;base64,/, '');
      const frontCoverBuffer = Buffer.from(frontCoverData, 'base64');
      doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });

      // Note: Title is already part of the cover image, no overlay needed
    }

    // PDF Page 2: Initial Page (140 x 140 mm)
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    const initialPageImageData = getCoverImageData(coverImages?.initialPage);
    if (initialPageImageData) {
      const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
      const initialPageBuffer = Buffer.from(initialPageData, 'base64');
      doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
    }

    // Add content pages based on layout type
    if (isPictureBook) {
      // PICTURE BOOK LAYOUT: Combined image on top (~90%), text below (~10%)
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;

        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        // Layout: Image takes top 85%, text takes bottom 15%
        const imageHeight = pageSize * 0.85;
        const textAreaHeight = pageSize * 0.15;
        const textAreaY = imageHeight;

        // Add image at top if available (full-bleed, no margin)
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, imageHeight],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            log.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
          }
        }

        // Add text in bottom portion (small area for Picture Book)
        const textMargin = mmToPoints(3);  // Margin for text area only
        const availableTextWidth = pageSize - (textMargin * 2);
        const availableTextHeight = textAreaHeight - (textMargin);

        const startFontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
        let fontSize = startFontSize;
        let textHeight;

        doc.fontSize(fontSize).font('Helvetica');
        textHeight = doc.heightOfString(page.text, { width: availableTextWidth, align: 'center' });
        const initialHeight = textHeight;

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableTextWidth, align: 'center' });
        }

        if (fontSize < startFontSize) {
          log.debug(`📄 [PDF-PictureBook] Page ${index + 1}: Font reduced ${startFontSize}pt → ${fontSize}pt (text: ${page.text.length} chars, height: ${Math.round(initialHeight)} → ${Math.round(textHeight)}, available: ${Math.round(availableTextHeight)})`);
        }

        let textToRender = page.text;
        if (textHeight > availableTextHeight) {
          // Truncate text to fit
          log.warn(`[PDF-PictureBook] Page ${index + 1}: Text still too long at ${fontSize}pt, truncating...`);
          const words = page.text.split(' ');
          textToRender = '';
          for (let i = 0; i < words.length; i++) {
            const testText = textToRender + (textToRender ? ' ' : '') + words[i];
            const testHeight = doc.heightOfString(testText, { width: availableTextWidth, align: 'center' });
            if (testHeight <= availableTextHeight) {
              textToRender = testText;
            } else {
              break;
            }
          }
          textToRender += '...';
        }

        textHeight = doc.heightOfString(textToRender, { width: availableTextWidth, align: 'center' });
        const textY = textAreaY + (availableTextHeight - textHeight) / 2;

        doc.fillColor('#333333').text(textToRender, textMargin, textY, { width: availableTextWidth, align: 'center' });
      });
    } else {
      // STANDARD/ADVANCED LAYOUT: Separate pages for text and image
      // Margins: reduced top/bottom for more text space, keep left/right for binding
      const marginTopBottom = 15;  // ~5mm
      const marginLeftRight = 28;  // ~10mm

      const availableWidth = pageSize - (marginLeftRight * 2);
      const availableHeight = pageSize - (marginTopBottom * 2);
      // Add 10% safety margin to prevent overflow due to rendering differences
      const safeAvailableHeight = availableHeight * 0.9;

      // PRE-CHECK: Verify all pages fit before generating PDF
      // If any page would be truncated, abort with error
      const truncatedPages = [];
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;
        let fontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica');
        let textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });

        while (textHeight > safeAvailableHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        }

        if (textHeight > safeAvailableHeight) {
          truncatedPages.push(pageNumber);
          log.error(`❌ Page ${pageNumber}: Text too long even at minimum font size (${fontSize}pt) - would be truncated`);
        }
      });

      // Abort if any pages would be truncated
      if (truncatedPages.length > 0) {
        log.error(`❌ [PDF] Aborting: ${truncatedPages.length} pages have text too long for print`);
        return res.status(400).json({
          error: 'Text too long for print',
          message: `Pages ${truncatedPages.join(', ')} have too much text and would be truncated. Please shorten the text before printing.`,
          truncatedPages
        });
      }

      // All pages fit - proceed with PDF generation
      storyPages.forEach((page, index) => {
        const pageNumber = index + 1;

        // Add text page (square format)
        doc.addPage({ size: [pageSize, pageSize], margins: { top: marginTopBottom, bottom: marginTopBottom, left: marginLeftRight, right: marginLeftRight } });

        const startFontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
        let fontSize = startFontSize;
        let textHeight;

        doc.fontSize(fontSize).font('Helvetica');
        textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        const initialHeight = textHeight;

        while (textHeight > safeAvailableHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        }

        if (fontSize < startFontSize) {
          log.debug(`📄 [PDF] Page ${pageNumber}: Font reduced ${startFontSize}pt → ${fontSize}pt (text: ${page.text.length} chars, height: ${Math.round(initialHeight)} → ${Math.round(textHeight)}, available: ${Math.round(safeAvailableHeight)})`);
        }

        textHeight = doc.heightOfString(page.text, { width: availableWidth, align: 'left' });
        const yPosition = marginTopBottom + (safeAvailableHeight - textHeight) / 2;

        doc.fillColor('#333333').text(page.text, marginLeftRight, yPosition, { width: availableWidth, align: 'left' });

        // Add image page if available (full-bleed, no margin)
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            doc.image(imageBuffer, 0, 0, {
              fit: [pageSize, pageSize],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            log.error('Error adding image to PDF:', imgErr);
          }
        }
      });
    }

    // Finalize PDF
    doc.end();

    // Wait for PDF generation to complete
    const pdfBuffer = await pdfPromise;
    const fileSize = pdfBuffer.length;
    const fileId = `file-pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const filename = `${storyTitle || 'story'}.pdf`;

    // Store PDF in database
    if (STORAGE_MODE === 'database' && dbPool) {
      log.debug(`📄 [PDF SAVE] Saving PDF with story_id: ${storyId}, file_id: ${fileId}`);
      const insertQuery = 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

      await dbQuery(insertQuery, [
        fileId,
        req.user.id,
        'story_pdf',
        storyId || null,
        'application/pdf',
        pdfBuffer,
        fileSize,
        filename
      ]);
      log.debug(`📄 [PDF SAVE] PDF saved successfully`);
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const uploadsDir = path.join(__dirname, 'data', 'uploads');

      await fs.mkdir(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, fileId);
      await fs.writeFile(filePath, pdfBuffer);

      // Save metadata
      const metadataFile = path.join(__dirname, 'data', 'files.json');
      let metadata = {};
      try {
        const data = await fs.readFile(metadataFile, 'utf-8');
        metadata = JSON.parse(data);
      } catch (err) {
        // File doesn't exist yet
      }

      metadata[fileId] = {
        id: fileId,
        userId: req.user.id,
        fileType: 'story_pdf',
        storyId: storyId || null,
        mimeType: 'application/pdf',
        fileSize,
        filename,
        createdAt: new Date().toISOString()
      };

      await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'PDF_GENERATED', {
      fileId,
      storyId,
      fileSize
    });

    const fileUrl = `${req.protocol}://${req.get('host')}/api/files/${fileId}`;

    res.json({
      success: true,
      fileId,
      fileUrl,
      fileSize,
      filename
    });

  } catch (err) {
    log.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
  }
});

// Generate multi-story book PDF - combines multiple stories into one printable book
// Page order:
// - Story 1: Back cover + Front cover (combined spread), Introduction, Story pages
// - Story 2+: Front cover (title), Introduction, Story pages, Back cover, Blank page
// Page count starts from Story 1's first story page (covers/intro don't count)
app.post('/api/generate-book-pdf', authenticateToken, async (req, res) => {
  try {
    const { storyIds } = req.body;
    const userId = req.user.id;

    if (!storyIds || !Array.isArray(storyIds) || storyIds.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyIds array' });
    }

    log.debug(`📚 [BOOK PDF] Generating multi-story book with ${storyIds.length} stories`);

    // Fetch all stories from database
    const stories = [];
    for (const storyId of storyIds) {
      const storyResult = await dbPool.query(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [storyId, userId]
      );

      if (storyResult.rows.length === 0) {
        log.debug(`📚 [BOOK PDF] Story not found: ${storyId}`);
        return res.status(404).json({ error: `Story not found: ${storyId}` });
      }

      const storyData = typeof storyResult.rows[0].data === 'string'
        ? JSON.parse(storyResult.rows[0].data)
        : storyResult.rows[0].data;

      stories.push({ id: storyId, data: storyData });
    }

    log.debug(`📚 [BOOK PDF] Loaded ${stories.length} stories: ${stories.map(s => s.data.title).join(', ')}`);

    // Helper functions
    const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;
    const PDFDocument = require('pdfkit');
    const mmToPoints = (mm) => mm * 2.83465;
    const coverWidth = mmToPoints(416);     // 20x20cm cover spread
    const coverHeight = mmToPoints(206);    // 20x20cm cover height with bleed
    const pageSize = mmToPoints(200);       // Interior pages: 200x200mm

    // Create PDF document
    const doc = new PDFDocument({
      size: [coverWidth, coverHeight],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false
    });

    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    const pdfPromise = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);
    });

    let totalStoryPages = 0;

    // Helper: Parse story pages from story text
    const parseStoryPages = (storyData) => {
      const storyText = storyData.storyText || storyData.generatedStory || storyData.story || storyData.text || '';
      const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Seite|Page)\s+\d+)/i);
      return pageMatches.slice(1).filter(p => p.trim().length > 0);
    };

    // Helper: Add story content pages (text + images)
    const addStoryContentPages = (storyData, storyPages) => {
      const isPictureBook = storyData.languageLevel === '1st-grade';
      const textMargin = 28;
      const textMarginMm = mmToPoints(3);

      if (isPictureBook) {
        // Picture Book: combined image + text on same page
        const imageHeight = pageSize * 0.85;
        const textAreaHeight = pageSize * 0.15;
        const textWidth = pageSize - (textMarginMm * 2);
        const availableTextHeight = textAreaHeight - textMarginMm;
        const lineGap = -2;

        storyPages.forEach((pageText, index) => {
          const pageNumber = index + 1;
          const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
          const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;

          if (image && image.imageData) {
            try {
              const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
              // Full-bleed image (no margin)
              doc.image(imageBuffer, 0, 0, {
                fit: [pageSize, imageHeight],
                align: 'center',
                valign: 'center'
              });
            } catch (err) {
              log.error(`Error adding image for page ${pageNumber}:`, err.message);
            }
          }

          // Add text with vertical centering (text has margin)
          let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
          doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
          let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

          while (textHeight > availableTextHeight && fontSize > 6) {
            fontSize -= 0.5;
            doc.fontSize(fontSize);
            textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
          }

          const textY = imageHeight + (availableTextHeight - textHeight) / 2;
          doc.text(cleanText, textMarginMm, textY, { width: textWidth, align: 'center', lineGap });
        });
      } else {
        // Standard: separate text and image pages
        const availableWidth = pageSize - (textMargin * 2);
        const availableHeight = pageSize - (textMargin * 2);
        const lineGap = -2;

        storyPages.forEach((pageText, index) => {
          const pageNumber = index + 1;
          const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
          const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

          // Text page (has margin)
          doc.addPage({ size: [pageSize, pageSize], margins: { top: textMargin, bottom: textMargin, left: textMargin, right: textMargin } });
          totalStoryPages++;

          let fontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
          doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
          let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

          while (textHeight > availableHeight * 0.9 && fontSize > 6) {
            fontSize -= 0.5;
            doc.fontSize(fontSize);
            textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
          }

          const yPosition = textMargin + (availableHeight - textHeight) / 2;
          doc.text(cleanText, textMargin, yPosition, { width: availableWidth, align: 'left', lineGap });

          // Image page (full-bleed, no margin)
          if (image && image.imageData) {
            doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
            totalStoryPages++;
            try {
              const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
              doc.image(imageBuffer, 0, 0, {
                fit: [pageSize, pageSize],
                align: 'center',
                valign: 'center'
              });
            } catch (err) {
              log.error(`Error adding image for page ${pageNumber}:`, err.message);
            }
          }
        });
      }
    };

    // Process each story
    for (let storyIndex = 0; storyIndex < stories.length; storyIndex++) {
      const { data: storyData } = stories[storyIndex];
      const isFirstStory = storyIndex === 0;
      const storyPages = parseStoryPages(storyData);

      log.debug(`📚 [BOOK PDF] Processing story ${storyIndex + 1}: "${storyData.title}" with ${storyPages.length} pages`);

      if (isFirstStory) {
        // STORY 1: Back cover + Front cover (combined spread for book binding)
        doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
        const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

        if (backCoverImageData && frontCoverImageData) {
          const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });
          doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });
        }

        // Introduction page (doesn't count towards page total)
        const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
        if (initialPageImageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
        }

        // Story 1 content pages (page count starts here)
        addStoryContentPages(storyData, storyPages);
        // Story 1 does NOT get a back cover (that's the book's back cover)

      } else {
        // STORY 2+: Front cover (title page)
        const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);
        if (frontCoverImageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(frontCoverBuffer, 0, 0, { width: pageSize, height: pageSize });
        }

        // Introduction page
        const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
        if (initialPageImageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
        }

        // Story content pages
        addStoryContentPages(storyData, storyPages);

        // Back cover for this story
        const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
        if (backCoverImageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(backCoverBuffer, 0, 0, { width: pageSize, height: pageSize });
        }

        // Blank page between stories
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
      }
    }

    // Add blank pages if needed to reach even page count for printing
    if (totalStoryPages % 2 !== 0) {
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      totalStoryPages++;
      log.debug(`📚 [BOOK PDF] Added final blank page for even page count`);
    }

    doc.end();
    const pdfBuffer = await pdfPromise;

    console.log(`✅ [BOOK PDF] Generated book PDF (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${totalStoryPages} story pages`);

    // Send PDF
    res.setHeader('Content-Type', 'application/pdf');
    const bookTitle = stories.length > 1
      ? `Book_${stories.length}_Stories`
      : (stories[0].data.title || 'Book').replace(/[^a-zA-Z0-9\s\-_.]/g, '').replace(/\s+/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${bookTitle}.pdf"`);
    res.send(pdfBuffer);

  } catch (err) {
    log.error('📚 [BOOK PDF] Error:', err);
    res.status(500).json({ error: 'Failed to generate book PDF', details: err.message });
  }
});
// Admin - Retry failed print provider order
app.post('/api/admin/orders/:orderId/retry-print-order', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { orderId } = req.params;
    log.debug(`🔄 [ADMIN] Retrying print order for order ID: ${orderId}`);

    // Get order details
    const orderResult = await dbPool.query(`
      SELECT * FROM orders WHERE id = $1
    `, [orderId]);

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    // Check if order already has a print order
    if (order.gelato_order_id) {
      return res.status(400).json({ error: 'Order already has a print order ID', printOrderId: order.gelato_order_id });
    }

    // Find the PDF file for this story
    const pdfResult = await dbPool.query(`
      SELECT id FROM files WHERE story_id = $1 AND file_type = 'story_pdf' ORDER BY created_at DESC LIMIT 1
    `, [order.story_id]);

    if (pdfResult.rows.length === 0) {
      return res.status(400).json({ error: 'No PDF found for this story. PDF needs to be regenerated.' });
    }

    const pdfFileId = pdfResult.rows[0].id;
    const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
    const pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;

    // Get story data to determine page count
    const storyResult = await dbPool.query(`SELECT data FROM stories WHERE id = $1`, [order.story_id]);
    if (storyResult.rows.length === 0) {
      return res.status(400).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(storyResult.rows[0].data);
    const storyScenes = storyData.pages || storyData.sceneImages?.length || 15;
    const isPictureBook = storyData.languageLevel === '1st-grade';

    // Calculate interior pages (covers not counted)
    let interiorPages = isPictureBook ? storyScenes : storyScenes * 2;

    // Round up to even page count for Gelato (accepts any even number)
    const printPageCount = interiorPages % 2 === 0 ? interiorPages : interiorPages + 1;
    log.debug(`📄 [ADMIN RETRY] Story has ${storyScenes} scenes, layout=${isPictureBook ? 'Picture Book' : 'Standard'}, interior=${interiorPages}, printPageCount=${printPageCount}`);

    // Get print product UID - prefer softcover for retry (can be changed in admin UI)
    const productsResult = await dbPool.query(
      'SELECT product_uid, product_name, cover_type, min_pages, max_pages FROM gelato_products WHERE is_active = true ORDER BY cover_type ASC'
    );

    let printProductUid = null;
    if (productsResult.rows.length > 0) {
      // Find product matching the page count (prefer softcover)
      const matchingProduct = productsResult.rows.find(p =>
        printPageCount >= (p.min_pages || 0) && printPageCount <= (p.max_pages || 999)
      );
      if (matchingProduct) {
        printProductUid = matchingProduct.product_uid;
        log.debug(`📦 [ADMIN RETRY] Using product: ${matchingProduct.product_name} (${matchingProduct.cover_type})`);
      } else {
        // Use first product if no page count match
        printProductUid = productsResult.rows[0].product_uid;
        log.warn(`📦 [ADMIN RETRY] No product matches page count ${printPageCount}, using first: ${productsResult.rows[0].product_name}`);
      }
    }

    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      if (!printProductUid) {
        return res.status(500).json({ error: 'No active products configured. Please add products in admin dashboard.' });
      }
    }

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      return res.status(500).json({ error: 'GELATO_API_KEY not configured' });
    }

    // Admin retry: Use user role to determine Gelato order type
    // Admins get draft for testing, but can force real order if needed
    const orderType = isUserTestMode(req.user) ? 'draft' : 'order';
    log.debug(`📦 [GELATO] Retry: Creating ${orderType} (user role: ${req.user.role})`);

    const printOrderPayload = {
      orderType: orderType,
      orderReferenceId: `retry-${order.story_id}-${Date.now()}`,
      customerReferenceId: order.user_id,
      currency: 'CHF',
      items: [{
        itemReferenceId: `item-retry-${order.story_id}-${Date.now()}`,
        productUid: printProductUid,
        pageCount: printPageCount,
        files: [{
          type: 'default',
          url: pdfUrl
        }],
        quantity: 1
      }],
      shipmentMethodUid: 'standard',
      shippingAddress: {
        firstName: (order.shipping_name || order.customer_name || '').split(' ')[0] || 'Customer',
        lastName: (order.shipping_name || order.customer_name || '').split(' ').slice(1).join(' ') || '',
        addressLine1: order.shipping_address_line1 || '',
        addressLine2: order.shipping_address_line2 || '',
        city: order.shipping_city || '',
        postCode: order.shipping_postal_code || '',
        state: order.shipping_state || '',
        country: order.shipping_country || 'CH',
        email: order.customer_email,
        phone: ''
      }
    };

    log.debug(`📦 [ADMIN] Retry print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, pdfUrl=${pdfUrl}`);

    const printResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': printApiKey
      },
      body: JSON.stringify(printOrderPayload)
    });

    if (!printResponse.ok) {
      const errorText = await printResponse.text();
      log.error(`❌ [ADMIN] Print provider API error: ${printResponse.status} - ${errorText}`);
      return res.status(printResponse.status).json({
        error: 'Print provider order failed',
        details: errorText
      });
    }

    const printOrder = await printResponse.json();
    console.log('✅ [ADMIN] Print order created:', printOrder.orderId);

    // Update order with print order ID
    await dbPool.query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [printOrder.orderId, orderId]);

    res.json({
      success: true,
      message: 'Print order created successfully',
      printOrderId: printOrder.orderId
    });

  } catch (err) {
    log.error('❌ [ADMIN] Error retrying print order:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PRICING API - Single source of truth for book pricing
// ============================================================

// Get all pricing tiers (public endpoint)
app.get('/api/pricing', async (req, res) => {
  try {
    const tiers = await dbPool.query(
      'SELECT max_pages, label, softcover_price, hardcover_price FROM pricing_tiers ORDER BY max_pages ASC'
    );

    // Transform to frontend-friendly format
    const formattedTiers = tiers.rows.map(tier => ({
      maxPages: tier.max_pages,
      label: tier.label,
      softcover: tier.softcover_price,
      hardcover: tier.hardcover_price
    }));

    res.json({ tiers: formattedTiers, maxBookPages: 100 });
  } catch (err) {
    log.error('❌ Error fetching pricing tiers:', err);
    res.status(500).json({ error: 'Failed to fetch pricing' });
  }
});

// Helper function to get price for a given page count
async function getPriceForPages(pageCount, isHardcover) {
  const tiers = await dbPool.query(
    'SELECT softcover_price, hardcover_price FROM pricing_tiers WHERE max_pages >= $1 ORDER BY max_pages ASC LIMIT 1',
    [pageCount]
  );

  if (tiers.rows.length === 0) {
    // Exceeds maximum - use highest tier
    const maxTier = await dbPool.query(
      'SELECT softcover_price, hardcover_price FROM pricing_tiers ORDER BY max_pages DESC LIMIT 1'
    );
    if (maxTier.rows.length === 0) {
      throw new Error('No pricing tiers configured');
    }
    const tier = maxTier.rows[0];
    return isHardcover ? tier.hardcover_price : tier.softcover_price;
  }

  const tier = tiers.rows[0];
  return isHardcover ? tier.hardcover_price : tier.softcover_price;
}

// Create Stripe checkout session for book purchase
app.post('/api/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    // Support both single storyId and array of storyIds
    const { storyId, storyIds, coverType = 'softcover' } = req.body;
    const userId = req.user.id;

    // Normalize to array
    const allStoryIds = storyIds || (storyId ? [storyId] : []);
    if (allStoryIds.length === 0) {
      return res.status(400).json({ error: 'No stories provided' });
    }

    // Get the appropriate Stripe client for this user (test for admins, live for regular users)
    const userStripe = getStripeForUser(req.user);
    const isTestMode = isUserTestMode(req.user);

    if (!userStripe) {
      const keyNeeded = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY';
      return res.status(500).json({ error: `Stripe not configured. Please set ${keyNeeded}` });
    }

    console.log(`💳 Creating Stripe checkout session for user ${userId}, stories: ${allStoryIds.join(', ')}`);
    log.debug(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}, Cover: ${coverType}`);

    // Fetch all stories and calculate total pages
    const stories = [];
    let totalPages = 0;
    for (const sid of allStoryIds) {
      const storyResult = await dbPool.query('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
      if (storyResult.rows.length === 0) {
        return res.status(404).json({ error: `Story not found: ${sid}` });
      }
      const storyData = typeof storyResult.rows[0].data === 'string'
        ? JSON.parse(storyResult.rows[0].data)
        : storyResult.rows[0].data;
      stories.push({ id: sid, data: storyData });

      // Calculate pages for this story
      const isPictureBook = storyData.languageLevel === '1st-grade';
      const sceneCount = storyData.sceneImages?.length || storyData.pages || 5;
      totalPages += isPictureBook ? sceneCount : sceneCount * 2;
    }

    // Add 3 pages per story for covers and title page
    totalPages += stories.length * 3;

    // Calculate price based on pages and cover type (using database pricing)
    const isHardcover = coverType === 'hardcover';
    const priceInChf = await getPriceForPages(totalPages, isHardcover);
    const price = priceInChf * 100; // Convert CHF to cents for Stripe

    const firstStory = stories[0].data;
    const bookTitle = stories.length === 1
      ? firstStory.title
      : `${firstStory.title} + ${stories.length - 1} more`;

    // Create checkout session with user-appropriate Stripe client
    const session = await userStripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `Personalized Storybook: ${bookTitle}`,
            description: `${stories.length} ${stories.length === 1 ? 'story' : 'stories'}, ${totalPages} pages, ${coverType}`,
          },
          unit_amount: price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/stories?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/stories?payment=cancelled`,
      metadata: {
        userId: userId.toString(),
        storyIds: JSON.stringify(allStoryIds),
        storyCount: stories.length.toString(),
        totalPages: totalPages.toString(),
        coverType: coverType
      },
      shipping_address_collection: {
        allowed_countries: ['DE', 'AT', 'CH', 'FR', 'IT', 'NL', 'BE', 'LU']
      },
    });

    console.log(`✅ Checkout session created: ${session.id}`);
    log.debug(`   Stories: ${stories.length}, Pages: ${totalPages}, Price: CHF ${price / 100}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    log.error('❌ Error creating checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe checkout session for credits purchase
app.post('/api/stripe/create-credits-checkout', authenticateToken, async (req, res) => {
  try {
    const { credits = 100, amount = 500 } = req.body; // Default: 100 credits for CHF 5.00 (500 cents)
    const userId = req.user.id;

    // Get the appropriate Stripe client for this user
    const userStripe = getStripeForUser(req.user);
    const isTestMode = isUserTestMode(req.user);

    if (!userStripe) {
      const keyNeeded = isTestMode ? 'STRIPE_TEST_SECRET_KEY' : 'STRIPE_LIVE_SECRET_KEY';
      return res.status(500).json({ error: `Stripe not configured. Please set ${keyNeeded}` });
    }

    console.log(`💳 Creating credits checkout session for user ${userId}`);
    log.debug(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}`);
    log.debug(`   Credits: ${credits}, Amount: CHF ${(amount / 100).toFixed(2)}`);

    // Create checkout session
    const session = await userStripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `${credits} Story Credits`,
            description: `${credits} credits for creating personalized stories on MagicalStory`,
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/create?credits_payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/create?credits_payment=cancelled`,
      metadata: {
        type: 'credits',
        userId: userId.toString(),
        credits: credits.toString(),
      },
    });

    console.log(`✅ Credits checkout session created: ${session.id}`);
    console.log(`   URL: ${session.url}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    log.error('❌ Error creating credits checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Check payment/order status (no auth required - session ID is already secure)
app.get('/api/stripe/order-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    log.debug(`🔍 Checking order status for session: ${sessionId}`);

    // Check database for order with retries (webhook might still be processing)
    if (STORAGE_MODE === 'database') {
      const maxRetries = 5;
      const retryDelay = 1000; // 1 second between retries

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const order = await dbPool.query(
          'SELECT * FROM orders WHERE stripe_session_id = $1',
          [sessionId]
        );

        if (order.rows.length > 0) {
          console.log(`✅ Order found in database (attempt ${attempt}):`, order.rows[0].id);
          return res.json({
            status: 'completed',
            order: order.rows[0]
          });
        }

        if (attempt < maxRetries) {
          log.debug(`⏳ Order not found yet, waiting... (attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      log.warn(`Order not in database after ${maxRetries} attempts, checking Stripe directly`);
    }

    // If not in database yet, check Stripe and return full session data
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['customer_details', 'shipping_details']
    });
    log.debug(`📋 Stripe session status: ${session.payment_status}`);

    // If payment was successful, construct order-like response from Stripe data
    if (session.payment_status === 'paid') {
      const customerDetails = session.customer_details || {};
      const shippingDetails = session.shipping_details || {};
      const shippingAddress = shippingDetails.address || {};

      log.debug(`📦 Constructing order from Stripe session data`);
      return res.json({
        status: 'processing', // Webhook hasn't completed yet but payment succeeded
        order: {
          customer_name: customerDetails.name || 'Customer',
          customer_email: customerDetails.email || '',
          shipping_name: shippingDetails.name || customerDetails.name || 'Customer',
          shipping_address_line1: shippingAddress.line1 || '',
          shipping_city: shippingAddress.city || '',
          shipping_postal_code: shippingAddress.postal_code || '',
          shipping_country: shippingAddress.country || '',
          amount_total: session.amount_total,
          currency: session.currency
        }
      });
    }

    res.json({
      status: session.payment_status,
      session: {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency
      }
    });
  } catch (err) {
    log.error('❌ Error checking order status:', err);
    res.status(500).json({ error: 'Failed to check order status' });
  }
});

// Background function to process book orders after payment
// isTestPayment: true = admin/developer (Gelato draft), false = real user (Gelato real order)
// coverType: 'softcover' or 'hardcover' - determines which product to use
// NOTE: processBookOrder moved to server/lib/gelato.js

// ===================================
// BACKGROUND STORY GENERATION JOBS
// ===================================

// NOTE: Config and parser functions moved to server/lib/storyHelpers.js
// Exports: ART_STYLES, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage,
// extractCoverScenes, buildSceneDescriptionPrompt, parseStoryPages, extractShortSceneDescriptions

// =============================================================================
// PROGRESSIVE STREAMING PARSERS
// These classes detect complete sections during Claude API streaming and trigger
// callbacks to start image generation early (before the full response is received)
// =============================================================================

/**
 * Progressive cover parser for streaming storybook generation
 * Detects Visual Bible and cover scenes as text streams in
 * and triggers callbacks to start cover image generation early
 */
class ProgressiveCoverParser {
  constructor(onVisualBibleComplete, onCoverSceneComplete) {
    this.onVisualBibleComplete = onVisualBibleComplete;
    this.onCoverSceneComplete = onCoverSceneComplete;
    this.fullText = '';
    this.visualBibleEmitted = false;
    this.emittedCovers = new Set();  // 'titlePage', 'initialPage', 'backCover'
  }

  /**
   * Process new text chunk and emit Visual Bible and cover scenes as they complete
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Check for Visual Bible completion
    // Visual Bible is complete when we see ---TITLE PAGE--- after ---VISUAL BIBLE---
    if (!this.visualBibleEmitted && fullText.includes('---VISUAL BIBLE---') && fullText.includes('---TITLE PAGE---')) {
      const visualBibleMatch = fullText.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---TITLE PAGE---|$)/i);
      if (visualBibleMatch) {
        this.visualBibleEmitted = true;
        const visualBibleSection = visualBibleMatch[1].trim();
        log.debug(`🌊 [STREAM-COVER] Visual Bible section complete (${visualBibleSection.length} chars)`);
        if (this.onVisualBibleComplete) {
          const parsedVB = parseVisualBible('## Visual Bible\n' + visualBibleSection);
          this.onVisualBibleComplete(parsedVB, visualBibleSection);
        }
      }
    }

    // Check for Title Page scene completion
    // Title Page is complete when we see ---INITIAL PAGE--- after ---TITLE PAGE---
    if (!this.emittedCovers.has('titlePage') && fullText.includes('---TITLE PAGE---') && fullText.includes('---INITIAL PAGE---')) {
      const titlePageMatch = fullText.match(/---TITLE PAGE---\s*([\s\S]*?)(?=---INITIAL PAGE---|$)/i);
      if (titlePageMatch) {
        const titlePageBlock = titlePageMatch[1];
        const sceneMatch = titlePageBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('titlePage');
          const scene = sceneMatch[1].trim();
          // Extract title from the streaming text for progressive display
          let extractedTitle = null;
          const titleMatch = fullText.match(/TITLE:\s*(.+)/i);
          if (titleMatch) {
            extractedTitle = titleMatch[1].trim();
          }
          log.debug(`🌊 [STREAM-COVER] Title Page scene complete: ${scene.substring(0, 80)}...${extractedTitle ? ` (title: ${extractedTitle})` : ''}`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('titlePage', scene, titlePageBlock, extractedTitle);
          }
        }
      }
    }

    // Check for Initial Page scene completion
    // Initial Page is complete when we see ---BACK COVER--- after ---INITIAL PAGE---
    if (!this.emittedCovers.has('initialPage') && fullText.includes('---INITIAL PAGE---') && fullText.includes('---BACK COVER---')) {
      const initialPageMatch = fullText.match(/---INITIAL PAGE---\s*([\s\S]*?)(?=---BACK COVER---|$)/i);
      if (initialPageMatch) {
        const initialPageBlock = initialPageMatch[1];
        const sceneMatch = initialPageBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('initialPage');
          const scene = sceneMatch[1].trim();
          log.debug(`🌊 [STREAM-COVER] Initial Page scene complete: ${scene.substring(0, 80)}...`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('initialPage', scene, initialPageBlock);
          }
        }
      }
    }

    // Check for Back Cover scene completion
    // Back Cover is complete when we see ---PAGE 1--- after ---BACK COVER---
    if (!this.emittedCovers.has('backCover') && fullText.includes('---BACK COVER---') && fullText.includes('---PAGE 1---')) {
      const backCoverMatch = fullText.match(/---BACK COVER---\s*([\s\S]*?)(?=---PAGE 1---|$)/i);
      if (backCoverMatch) {
        const backCoverBlock = backCoverMatch[1];
        const sceneMatch = backCoverBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('backCover');
          const scene = sceneMatch[1].trim();
          log.debug(`🌊 [STREAM-COVER] Back Cover scene complete: ${scene.substring(0, 80)}...`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('backCover', scene, backCoverBlock);
          }
        }
      }
    }
  }

  /**
   * Check if all cover scenes have been emitted
   */
  allCoversEmitted() {
    return this.emittedCovers.size === 3;
  }
}

/**
 * Progressive scene parser for streaming story generation
 * Detects complete scenes as text streams in and triggers callbacks
 */
class ProgressiveSceneParser {
  constructor(onSceneComplete) {
    this.onSceneComplete = onSceneComplete;
    this.fullText = '';
    this.completedScenes = new Set();
    this.scenePattern = /---PAGE\s+(\d+)---\s*([\s\S]*?)(?=---PAGE\s+\d+---|---BACK COVER---|$)/gi;
  }

  /**
   * Process new text chunk and emit any newly completed scenes
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Find all complete scenes in the current text
    const matches = [...fullText.matchAll(this.scenePattern)];

    for (const match of matches) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      // Only emit if this scene hasn't been emitted yet and appears complete
      // A scene is complete if there's another scene after it or we've seen ---BACK COVER---
      const hasNextScene = fullText.includes(`---PAGE ${pageNum + 1}---`);
      const hasBackCover = fullText.includes('---BACK COVER---');
      const isComplete = hasNextScene || hasBackCover;

      if (isComplete && !this.completedScenes.has(pageNum)) {
        this.completedScenes.add(pageNum);

        // Extract TEXT and SCENE from the page content
        const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
        const sceneMatch = content.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);

        const pageText = textMatch ? textMatch[1].trim() : '';
        const sceneDesc = sceneMatch ? sceneMatch[1].trim() : '';

        log.debug(`🌊 [STREAM-PARSE] Scene ${pageNum} complete, emitting...`);

        if (this.onSceneComplete) {
          this.onSceneComplete({
            pageNumber: pageNum,
            text: pageText,
            sceneDescription: sceneDesc
          });
        }
      }
    }
  }

  /**
   * Get all parsed scenes (for final processing)
   */
  getAllScenes() {
    const scenes = [];
    const matches = [...this.fullText.matchAll(this.scenePattern)];

    for (const match of matches) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
      const sceneMatch = content.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);

      scenes.push({
        pageNumber: pageNum,
        text: textMatch ? textMatch[1].trim() : '',
        sceneDescription: sceneMatch ? sceneMatch[1].trim() : ''
      });
    }

    return scenes.sort((a, b) => a.pageNumber - b.pageNumber);
  }
}

/**
 * Progressive page parser for streaming normal story text generation
 * Detects complete pages as text streams in (format: "--- Page X ---")
 * and triggers callbacks to start image generation early
 */
class ProgressiveStoryPageParser {
  constructor(onPageComplete) {
    this.onPageComplete = onPageComplete;
    this.fullText = '';
    this.emittedPages = new Set();
    // Pattern matches "--- Page X ---" with flexible spacing
    this.pagePattern = /---\s*Page\s+(\d+)\s*---/gi;
  }

  /**
   * Process new text chunk and emit any newly completed pages
   * A page is complete when we see the start of the next page
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Find all page markers in the text
    const markers = [];
    let match;
    const patternCopy = new RegExp(this.pagePattern.source, 'gi');
    while ((match = patternCopy.exec(fullText)) !== null) {
      markers.push({
        pageNumber: parseInt(match[1], 10),
        startIndex: match.index,
        markerEnd: match.index + match[0].length
      });
    }

    // For each page marker (except the last), extract and emit if not already done
    for (let i = 0; i < markers.length - 1; i++) {
      const current = markers[i];
      const next = markers[i + 1];
      const pageNum = current.pageNumber;

      if (!this.emittedPages.has(pageNum)) {
        // Extract content between this marker and the next
        const content = fullText.substring(current.markerEnd, next.startIndex).trim();

        if (content.length > 0) {
          this.emittedPages.add(pageNum);
          log.debug(`🌊 [STREAM-PAGE] Page ${pageNum} complete (${content.length} chars), emitting...`);

          if (this.onPageComplete) {
            this.onPageComplete({
              pageNumber: pageNum,
              content: content
            });
          }
        }
      }
    }
  }

  /**
   * Finalize parsing - emit the last page when stream ends
   * @param {string} fullText - Final complete text
   */
  finalize(fullText) {
    this.fullText = fullText;

    // Find the last page marker
    const markers = [];
    let match;
    const patternCopy = new RegExp(this.pagePattern.source, 'gi');
    while ((match = patternCopy.exec(fullText)) !== null) {
      markers.push({
        pageNumber: parseInt(match[1], 10),
        startIndex: match.index,
        markerEnd: match.index + match[0].length
      });
    }

    if (markers.length > 0) {
      const lastMarker = markers[markers.length - 1];
      const pageNum = lastMarker.pageNumber;

      if (!this.emittedPages.has(pageNum)) {
        // Extract content from last marker to end of text
        const content = fullText.substring(lastMarker.markerEnd).trim();

        if (content.length > 0) {
          this.emittedPages.add(pageNum);
          log.debug(`🌊 [STREAM-PAGE] Final page ${pageNum} complete (${content.length} chars), emitting...`);

          if (this.onPageComplete) {
            this.onPageComplete({
              pageNumber: pageNum,
              content: content
            });
          }
        }
      }
    }

    return this.emittedPages.size;
  }

  /**
   * Get set of emitted page numbers
   */
  getEmittedPages() {
    return new Set(this.emittedPages);
  }
}


// Process picture book (storybook) job - simplified flow with combined text+scene generation
async function processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}) {
  log.debug(`📖 [STORYBOOK] Starting picture book generation for job ${jobId}`);

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility) - includes thinking_tokens for Gemini 2.5
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() }
    }
  };

  // Pricing per million tokens by model (as of Dec 2025)
  const MODEL_PRICING = {
    // Anthropic models
    'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
    'claude-opus-4-5': { input: 5.00, output: 25.00 },
    // Gemini text models
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    // Gemini image models
    'gemini-2.5-flash-image': { input: 0.30, output: 30.00 },
    'gemini-3-pro-image-preview': { input: 2.00, output: 120.00 },
    'gemini-2.0-flash-exp-image-generation': { input: 0.10, output: 0.40 }  // Image editing
  };

  // Fallback pricing by provider (if model not found)
  const PROVIDER_PRICING = {
    anthropic: { input: 3.00, output: 15.00 },
    gemini_image: { input: 0.30, output: 30.00 },
    gemini_quality: { input: 0.10, output: 0.40 },
    gemini_text: { input: 0.30, output: 2.50 }
  };

  // Helper to add usage - now supports function-level tracking with model names and thinking tokens
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage[provider].calls += 1;
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage.output_tokens || 0;
      tokenUsage.byFunction[functionName].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      tokenUsage.byFunction[functionName].provider = provider; // Track actual provider used
      if (modelName) {
        tokenUsage.byFunction[functionName].models.add(modelName);
      }
    }
  };

  // Helper to calculate cost - uses model-specific pricing if available
  // Thinking tokens are billed at output rate for Gemini 2.5 models
  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    // Try model-specific pricing first, then fall back to provider pricing
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output; // Thinking billed at output rate
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  // For Picture Book: pages = scenes (each page has image + text)
  // inputData.pages is the actual print page count, which equals scene count in picture book mode
  const sceneCount = inputData.pages;

  try {
    // Build character descriptions
    const characterDescriptions = (inputData.characters || []).map(char => {
      const isMain = (inputData.mainCharacters || []).includes(char.id) ? ' (MAIN CHARACTER)' : '';
      let desc = `${char.name}${isMain} (${char.gender}, ${char.age} years old)`;
      const details = [];
      if (char.strengths && char.strengths.length > 0) {
        details.push(`Strengths: ${char.strengths.join(', ')}`);
      }
      if (char.weaknesses && char.weaknesses.length > 0) {
        details.push(`Weaknesses: ${char.weaknesses.join(', ')}`);
      }
      if (char.specialDetails) {
        details.push(`Details: ${char.specialDetails}`);
      }
      if (details.length > 0) {
        desc += `: ${details.join(', ')}`;
      }
      return desc;
    }).join('\n');

    // Build relationship descriptions
    const relationshipDescriptions = Object.entries(inputData.relationships || {})
      .filter(([key, type]) => type !== 'Not Known to' && type !== 'kennt nicht' && type !== 'ne connaît pas')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = (inputData.characters || []).find(c => c.id === char1Id);
        const char2 = (inputData.characters || []).find(c => c.id === char2Id);
        return `${char1?.name} is ${type} ${char2?.name}`;
      }).join('\n');

    const storyTypeName = inputData.storyType || 'adventure';
    const middlePage = Math.ceil(sceneCount / 2);
    const lang = inputData.language || 'en';
    const langText = lang === 'de' ? 'German (use ä, ö, ü normally. Do not use ß, use ss instead)' : lang === 'fr' ? 'French' : 'English';

    // Build list of main character names for Visual Bible exclusion
    const mainCharacterNames = (inputData.characters || []).map(c => c.name).join(', ');

    // Build the storybook combined prompt using template file
    const storybookPrompt = fillTemplate(PROMPT_TEMPLATES.storybookCombined, {
      TITLE: storyTypeName,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: sceneCount,
      LANGUAGE: langText,
      STORY_TYPE: storyTypeName,
      STORY_DETAILS: inputData.storyDetails || '',
      DEDICATION: inputData.dedication || '',
      CHARACTERS: characterDescriptions,
      RELATIONSHIPS: relationshipDescriptions || '',
      MIDDLE_PAGE: middlePage,
      MIDDLE_PAGE_PLUS_1: middlePage + 1,
      MAIN_CHARACTER_NAMES: mainCharacterNames || 'None'
    });

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Generating picture book story and scenes...', jobId]
    );

    // STREAMING APPROACH: Generate text with streaming, start image generation as scenes complete
    log.debug(`📖 [STORYBOOK] Calling Claude API with STREAMING for combined generation (${sceneCount} scenes)...`);
    log.debug(`📖 [STORYBOOK] Prompt length: ${storybookPrompt.length} chars`);

    let fullStoryText = '';
    let streamingTextModelId = null;  // Track which model was used for streaming text generation
    const allSceneDescriptions = [];  // Only story pages (1, 2, 3...), NOT cover pages
    const allImages = [];
    const imagePrompts = {};

    // Track image generation promises (started during streaming)
    const streamingImagePromises = [];
    const completedSceneNumbers = new Set();
    const imageGenMode = inputData.imageGenMode || IMAGE_GEN_MODE || 'parallel';
    const MAX_RETRIES = 2;

    // Rate limiter for parallel image generation during streaming
    const streamLimit = pLimit(3);  // Limit concurrent image generation during streaming

    // Track completed pages for partial results (text -> sceneText mapping)
    const pageTexts = {};

    // Helper function to generate image for a scene (used during streaming)
    const generateImageForScene = async (pageNum, sceneDesc, pageText = null, vBible = null) => {
      try {
        // DEBUG: Log available characters before filtering
        const allCharacters = inputData.characters || [];
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Total available characters: ${allCharacters.length}`);
        allCharacters.forEach(char => {
          const hasPhoto = char.photoUrl?.startsWith('data:image');
          const hasBody = char.bodyPhotoUrl?.startsWith('data:image');
          const hasBodyNoBg = char.bodyNoBgUrl?.startsWith('data:image');
          const hasClothing = char.clothingAvatars ? Object.keys(char.clothingAvatars).filter(k => char.clothingAvatars[k]?.startsWith('data:image')).join(',') : 'none';
          log.debug(`   - ${char.name}: face=${hasPhoto}, body=${hasBody}, bodyNoBg=${hasBodyNoBg}, clothing=[${hasClothing}]`);
        });

        const sceneCharacters = getCharactersInScene(sceneDesc, inputData.characters || []);
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Characters found in scene: ${sceneCharacters.map(c => c.name).join(', ') || 'NONE'}`);

        // Parse clothing category from scene description
        const clothingCategory = parseClothingCategory(sceneDesc) || 'standard';
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Clothing category: ${clothingCategory}`);

        // Use detailed photo info (with names) for labeled reference images
        const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Reference photos selected: ${referencePhotos.map(p => `${p.name}:${p.photoType}:${p.photoHash}`).join(', ') || 'NONE'}`);

        // Log with visual bible info if available
        if (vBible) {
          const relevantEntries = getVisualBibleEntriesForPage(vBible, pageNum);
          log.debug(`📸 [STREAM-IMG] Generating image for page ${pageNum} (${sceneCharacters.length} chars, ${relevantEntries.length} visual bible entries)...`);
        } else {
          log.debug(`📸 [STREAM-IMG] Generating image for page ${pageNum} (${sceneCharacters.length} characters)...`);
        }

        const imagePrompt = buildImagePrompt(sceneDesc, inputData, sceneCharacters, false, vBible, pageNum, true); // isStorybook = true
        imagePrompts[pageNum] = imagePrompt;

        let imageResult = null;
        let retries = 0;
        const pageTextContent = pageText || pageTexts[pageNum] || '';

        // Callback for immediate display - saves image before quality evaluation completes
        const onImageReady = async (imgData, modelId) => {
          const partialData = {
            pageNumber: pageNum,
            imageData: imgData,
            description: sceneDesc,
            prompt: imagePrompt,
            text: pageTextContent,
            qualityScore: null,  // Not yet evaluated
            qualityReasoning: null,
            wasRegenerated: false,
            totalAttempts: 1,
            retryHistory: [],
            referencePhotos,
            modelId: modelId || null
          };
          await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
          log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
        };

        // Usage tracker for page images
        const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'page_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
        };

        while (retries <= MAX_RETRIES && !imageResult) {
          try {
            // Use quality retry with labeled character photos (name + photoUrl)
            const sceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
            imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker, null, sceneModelOverrides);
          } catch (error) {
            retries++;
            log.error(`❌ [STREAM-IMG] Page ${pageNum} attempt ${retries} failed:`, error.message);
            if (retries > MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          }
        }

        console.log(`✅ [STREAM-IMG] Page ${pageNum} image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

        const pageData = {
          pageNumber: pageNum,
          imageData: imageResult.imageData,
          description: sceneDesc,
          prompt: imagePrompt,
          text: pageTextContent,
          qualityScore: imageResult.score,
          qualityReasoning: imageResult.reasoning || null,
          qualityModelId: imageResult.qualityModelId || null,  // Model used for quality eval
          fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
          wasRegenerated: imageResult.wasRegenerated || false,
          totalAttempts: imageResult.totalAttempts || 1,
          retryHistory: imageResult.retryHistory || [],
          originalImage: imageResult.originalImage || null,
          originalScore: imageResult.originalScore || null,
          originalReasoning: imageResult.originalReasoning || null,
          referencePhotos,  // Dev mode: which photos were used
          modelId: imageResult.modelId || null
        };

        // Save final result with quality score (overwrites immediate save)
        await saveCheckpoint(jobId, 'partial_page', pageData, pageNum);
        log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

        return pageData;
      } catch (error) {
        log.error(`❌ [STREAM-IMG] Failed to generate image for page ${pageNum}:`, error.message);
        return {
          pageNumber: pageNum,
          imageData: null,
          description: sceneDesc,
          text: pageText || pageTexts[pageNum] || '',
          error: error.message
        };
      }
    };

    // Set up progressive scene parser to start image generation during streaming
    // DISABLED: Don't stream images in storybook mode - wait for Visual Bible to be parsed first
    // This ensures all images get Visual Bible entries for recurring elements
    const shouldStreamImages = false; // Was: !skipImages && imageGenMode === 'parallel'
    let scenesEmittedCount = 0;

    // Track cover image generation promises
    const streamingCoverPromises = [];
    let streamingVisualBible = null;
    let coverImages = { frontCover: null, initialPage: null, backCover: null };
    const coverPrompts = { front: null, initialPage: null, backCover: null };

    // Helper to build character reference list for cover prompts
    const buildCharacterReferenceList = (photos, characters = null) => {
      if (!photos || photos.length === 0) return '';
      const charDescriptions = photos.map((photo, index) => {
        // Find the original character to get full physical description
        const char = characters?.find(c => c.name === photo.name);
        const age = char?.age ? `${char.age} years old` : '';
        const gender = char?.gender === 'male' ? 'boy/man' : char?.gender === 'female' ? 'girl/woman' : '';
        // Include physical traits with labels (excluding height - AI doesn't understand it for images)
        const physical = char?.physical;
        const physicalParts = [
          physical?.build ? `Build: ${physical.build}` : '',
          physical?.face ? `Face: ${physical.face}` : '',
          physical?.hair ? `Hair: ${physical.hair}` : '',
          physical?.other ? `Other: ${physical.other}` : ''
        ].filter(Boolean);
        const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
        const brief = [photo.name, age, gender, physicalDesc].filter(Boolean).join(', ');
        return `${index + 1}. ${brief}`;
      });
      let result = `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;

      // Add relative height description if characters data is available
      if (characters && characters.length >= 2) {
        // Filter to only characters in this scene (matching photo names)
        const sceneCharacters = characters.filter(c => photos.some(p => p.name === c.name));
        const heightDescription = buildRelativeHeightDescription(sceneCharacters);
        if (heightDescription) {
          result += `\n${heightDescription}\n`;
          log.debug(`📏 [COVER] Added relative heights: ${heightDescription}`);
        }
      }

      return result;
    };

    // Helper function to generate cover image during streaming
    const generateCoverImageDuringStream = async (coverType, sceneDescription, rawBlock = null, extractedTitle = null) => {
      if (skipImages) return null;

      try {
        // Extract clothing from block first (more reliable), fallback to parsing scene
        let clothing = null;
        if (rawBlock) {
          const clothingMatch = rawBlock.match(/CLOTHING:\s*(winter|summer|formal|standard)/i);
          if (clothingMatch) {
            clothing = clothingMatch[1].toLowerCase();
          }
        }
        if (!clothing) {
          clothing = parseClothingCategory(sceneDescription) || 'standard';
        }

        // Determine character selection based on cover type
        let referencePhotos;
        if (coverType === 'titlePage') {
          // Front cover: Main character prominently, maybe 1-2 supporting
          const frontCoverCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
          referencePhotos = getCharacterPhotoDetails(frontCoverCharacters.length > 0 ? frontCoverCharacters : inputData.characters || [], clothing);
          log.debug(`📕 [STREAM-COVER] Generating front cover: ${referencePhotos.length} characters, clothing: ${clothing}`);
        } else {
          // Initial page and back cover: ALL characters
          referencePhotos = getCharacterPhotoDetails(inputData.characters || [], clothing);
          log.debug(`📕 [STREAM-COVER] Generating ${coverType}: ALL ${referencePhotos.length} characters, clothing: ${clothing}`);
        }

        // Build the prompt
        let coverPrompt;
        const visualBibleText = streamingVisualBible ? buildFullVisualBiblePrompt(streamingVisualBible) : '';
        const artStyleId = inputData.artStyle || 'pixar';
        const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

        if (coverType === 'titlePage') {
          // Use extracted title from Claude response, fallback to input title
          const storyTitleForCover = extractedTitle || inputData.title || 'My Story';
          log.debug(`📕 [STREAM-COVER] Using title for front cover: "${storyTitleForCover}"`);
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
            VISUAL_BIBLE: visualBibleText,
            STORY_TITLE: storyTitleForCover
          });
          coverPrompts.front = coverPrompt;
        } else if (coverType === 'initialPage') {
          coverPrompt = inputData.dedication && inputData.dedication.trim()
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
                VISUAL_BIBLE: visualBibleText,
                DEDICATION: inputData.dedication
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
                VISUAL_BIBLE: visualBibleText
              });
          coverPrompts.initialPage = coverPrompt;
        } else if (coverType === 'backCover') {
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
            VISUAL_BIBLE: visualBibleText
          });
          coverPrompts.backCover = coverPrompt;
        }

        // Usage tracker for streaming cover images
        const streamCoverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        // Generate the image (use coverImageModel for covers)
        const coverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
        const result = await generateImageWithQualityRetry(coverPrompt, referencePhotos, null, 'cover', null, streamCoverUsageTracker, null, coverModelOverrides);

        const coverData = {
          imageData: result.imageData,
          description: sceneDescription,
          prompt: coverPrompt,
          qualityScore: result.score,
          qualityReasoning: result.reasoning || null,
          fixTargets: result.fixTargets || [],  // Bounding boxes for auto-repair
          wasRegenerated: result.wasRegenerated || false,
          totalAttempts: result.totalAttempts || 1,
          retryHistory: result.retryHistory || [],
          originalImage: result.originalImage || null,
          originalScore: result.originalScore || null,
          originalReasoning: result.originalReasoning || null,
          referencePhotos: referencePhotos,
          modelId: result.modelId || null
        };

        // Save partial cover checkpoint for progressive display
        const coverKey = coverType === 'titlePage' ? 'frontCover' : coverType;
        // Include title for frontCover so client can transition to story display immediately
        const checkpointData = { type: coverKey, ...coverData };
        if (coverType === 'titlePage' && extractedTitle) {
          checkpointData.storyTitle = extractedTitle;
        }
        await saveCheckpoint(jobId, 'partial_cover', checkpointData,
          coverType === 'titlePage' ? 0 : coverType === 'initialPage' ? 1 : 2);

        console.log(`✅ [STREAM-COVER] ${coverType} cover generated during streaming (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);

        return { type: coverKey, data: coverData };
      } catch (error) {
        log.error(`❌ [STREAM-COVER] Failed to generate ${coverType} cover:`, error.message);
        return null;
      }
    };

    // Set up cover parser to start cover image generation during streaming
    const shouldStreamCovers = !skipImages;
    const coverParser = new ProgressiveCoverParser(
      // onVisualBibleComplete
      (parsedVB, rawSection) => {
        // Filter out main characters from secondary characters (safety net)
        streamingVisualBible = filterMainCharactersFromVisualBible(parsedVB, inputData.characters);
        log.debug(`📖 [STREAM-COVER] Visual Bible ready for cover generation`);
      },
      // onCoverSceneComplete
      (coverType, sceneDescription, rawBlock, extractedTitle) => {
        if (shouldStreamCovers) {
          const coverPromise = streamLimit(() => generateCoverImageDuringStream(coverType, sceneDescription, rawBlock, extractedTitle));
          streamingCoverPromises.push(coverPromise);
        }
      }
    );

    const sceneParser = new ProgressiveSceneParser((completedScene) => {
      // Called when a scene is detected as complete during streaming
      const { pageNumber, text, sceneDescription } = completedScene;

      if (completedSceneNumbers.has(pageNumber)) return;  // Already processed
      completedSceneNumbers.add(pageNumber);
      scenesEmittedCount++;

      // Store the page text for later use
      pageTexts[pageNumber] = text;

      log.debug(`🌊 [STREAM] Scene ${pageNumber} complete during streaming (${scenesEmittedCount}/${sceneCount})`);

      // Start image generation immediately for this scene (only in parallel mode)
      // Pass the page text so it can be saved with the partial result
      if (shouldStreamImages && sceneDescription) {
        const imagePromise = streamLimit(() => generateImageForScene(pageNumber, sceneDescription, text));
        streamingImagePromises.push(imagePromise);
      }
    });

    let response;
    try {
      // Use streaming API call with progressive parsers
      // Pass textModel override if provided (e.g., gemini-2.5-flash)
      const textModelOverride = modelOverrides.textModel || null;
      const streamResult = await callTextModelStreaming(storybookPrompt, 16000, (chunk, fullText) => {
        // Process each chunk to detect complete scenes AND cover scenes
        coverParser.processChunk(chunk, fullText);
        sceneParser.processChunk(chunk, fullText);
      }, textModelOverride);
      response = streamResult.text;
      streamingTextModelId = streamResult.modelId || (textModelOverride ? textModelOverride : getActiveTextModel().modelId);
      addUsage('anthropic', streamResult.usage, 'story_text', streamingTextModelId);
      log.debug(`📖 [STORYBOOK] Streaming complete, received ${response?.length || 0} chars (model: ${streamingTextModelId})`);
      log.debug(`🌊 [STREAM] ${scenesEmittedCount} scenes detected during streaming, ${streamingImagePromises.length} page images started`);
      log.debug(`🌊 [STREAM] ${streamingCoverPromises.length} cover images started during streaming`);
    } catch (apiError) {
      log.error(`[STORYBOOK] Claude API streaming call failed:`, apiError.message);
      throw apiError;
    }

    // Wait for any cover images started during streaming
    if (streamingCoverPromises.length > 0) {
      log.debug(`⚡ [STORYBOOK] Waiting for ${streamingCoverPromises.length} cover images started during streaming...`);
      const coverResults = await Promise.all(streamingCoverPromises);
      coverResults.forEach(result => {
        if (result && result.type && result.data) {
          coverImages[result.type] = result.data;
        }
      });
      log.debug(`✅ [STORYBOOK] ${coverResults.filter(r => r).length} cover images complete from streaming`);
    }

    // Save checkpoint
    await saveCheckpoint(jobId, 'storybook_combined', { response, rawResponse: response });

    // Extract title
    let storyTitle = inputData.title || 'My Picture Book';
    const titleMatch = response.match(/TITLE:\s*(.+)/i);
    if (titleMatch) {
      storyTitle = titleMatch[1].trim();
    }
    log.debug(`📖 [STORYBOOK] Extracted title: ${storyTitle}`);

    // Extract dedication if present
    let dedication = inputData.dedication || '';
    const dedicationMatch = response.match(/DEDICATION:\s*(.+)/i);
    if (dedicationMatch) {
      dedication = dedicationMatch[1].trim();
    }

    // Parse the response to extract text and scenes
    // Split by page markers but keep track of what's before PAGE 1 (title/dedication info)
    const pageSplitRegex = /---PAGE\s+(\d+)---/gi;
    const pageMatches = [...response.matchAll(pageSplitRegex)];

    // Extract COVER SCENES from response (Title Page, Initial Page, Back Cover)
    // These are used for cover image generation, NOT added to allSceneDescriptions
    const coverScenes = {
      titlePage: '',
      initialPage: '',
      backCover: ''
    };

    // Helper to extract clothing from a block
    const extractClothingFromBlock = (block) => {
      const clothingMatch = block.match(/CLOTHING:\s*(winter|summer|formal|standard)/i);
      return clothingMatch ? clothingMatch[1].toLowerCase() : null;
    };

    // Extract TITLE PAGE scene (for front cover)
    const titlePageMatch = response.match(/---TITLE PAGE---\s*([\s\S]*?)(?=---(?:INITIAL PAGE|PAGE\s+\d+)---|$)/i);
    if (titlePageMatch) {
      const titlePageBlock = titlePageMatch[1];
      const sceneMatch = titlePageBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|---|$)/i);
      if (sceneMatch) {
        coverScenes.titlePage = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(titlePageBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Title Page: scene=${coverScenes.titlePage.scene.substring(0, 80)}..., clothing=${coverScenes.titlePage.clothing || 'not found'}`);
      }
    }

    // Extract INITIAL PAGE scene (for dedication/intro page)
    const initialPageMatch = response.match(/---INITIAL PAGE---\s*([\s\S]*?)(?=---VISUAL BIBLE---|---PAGE\s+\d+---|$)/i);
    if (initialPageMatch) {
      const initialPageBlock = initialPageMatch[1];
      const sceneMatch = initialPageBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|---|$)/i);
      if (sceneMatch) {
        coverScenes.initialPage = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(initialPageBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Initial Page: scene=${coverScenes.initialPage.scene.substring(0, 80)}..., clothing=${coverScenes.initialPage.clothing || 'not found'}`);
      }
    }

    // Extract VISUAL BIBLE section for recurring elements
    let visualBible = null;
    const visualBibleMatch = response.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---PAGE\s+\d+---|$)/i);
    if (visualBibleMatch) {
      const visualBibleSection = visualBibleMatch[1];
      log.debug(`📖 [STORYBOOK] Visual Bible section found, length: ${visualBibleSection.length}`);
      log.debug(`📖 [STORYBOOK] Visual Bible raw content:\n${visualBibleSection.substring(0, 500)}...`);
      visualBible = parseVisualBible('## Visual Bible\n' + visualBibleSection);
      // Filter out main characters from secondary characters (safety net)
      visualBible = filterMainCharactersFromVisualBible(visualBible, inputData.characters);
      const totalEntries = (visualBible.secondaryCharacters?.length || 0) +
                          (visualBible.animals?.length || 0) +
                          (visualBible.artifacts?.length || 0) +
                          (visualBible.locations?.length || 0);
      log.debug(`📖 [STORYBOOK] Extracted Visual Bible: ${totalEntries} entries`);
      log.debug(`📖 [STORYBOOK] Visual Bible parsed:`, JSON.stringify(visualBible, null, 2).substring(0, 500));
    } else {
      log.debug(`📖 [STORYBOOK] No Visual Bible section found in response`);
    }

    // Extract BACK COVER scene
    const backCoverMatch = response.match(/---BACK COVER---\s*([\s\S]*?)$/i);
    if (backCoverMatch) {
      const backCoverBlock = backCoverMatch[1];
      const sceneMatch = backCoverBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|$)/i);
      if (sceneMatch) {
        coverScenes.backCover = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(backCoverBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Back Cover: scene=${coverScenes.backCover.scene.substring(0, 80)}..., clothing=${coverScenes.backCover.clothing || 'not found'}`);
      }
    }

    log.debug(`📖 [STORYBOOK] Found ${pageMatches.length} page markers`);

    // Extract content for each page using the markers
    // Note: BACK COVER comes BEFORE pages in the prompt format, so no need to check for it
    for (let i = 0; i < pageMatches.length && i < sceneCount; i++) {
      const match = pageMatches[i];
      const pageNum = parseInt(match[1], 10); // Use the actual page number from the marker
      const startIndex = match.index + match[0].length;
      // End at next page or end of response
      const endIndex = pageMatches[i + 1] ? pageMatches[i + 1].index : response.length;
      const block = response.substring(startIndex, endIndex);

      // Extract TEXT section
      const textMatch = block.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
      const pageText = textMatch ? textMatch[1].trim() : '';

      // Extract SCENE section (stop at any --- marker or end)
      const sceneMatch = block.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
      const sceneDesc = sceneMatch ? sceneMatch[1].trim() : '';

      // Build story text with page markers
      fullStoryText += `--- Page ${pageNum} ---\n${pageText}\n\n`;

      // Build scene description (for scenes not already processed during streaming)
      allSceneDescriptions.push({
        pageNumber: pageNum,
        description: sceneDesc,
        textModelId: streamingTextModelId
      });

      log.debug(`📖 [STORYBOOK] Page ${pageNum}: ${pageText.substring(0, 50)}...`);
    }

    // Save story text checkpoint so client can display text while images generate
    const pageTextMap = {};
    allSceneDescriptions.forEach(scene => {
      // Extract text from fullStoryText for each page
      const pageMatch = fullStoryText.match(new RegExp(`--- Page ${scene.pageNumber} ---\\n([\\s\\S]*?)(?=--- Page \\d+ ---|$)`));
      pageTextMap[scene.pageNumber] = pageMatch ? pageMatch[1].trim() : '';
    });

    await saveCheckpoint(jobId, 'story_text', {
      title: storyTitle,
      dedication: dedication,
      pageTexts: pageTextMap,
      sceneDescriptions: allSceneDescriptions,
      totalPages: sceneCount
    });
    log.debug(`💾 [STORYBOOK] Saved story text checkpoint with ${Object.keys(pageTextMap).length} pages`);

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [30, `Story text complete. ${streamingImagePromises.length} images already generating...`, jobId]
    );

    // Generate images if not skipped
    if (!skipImages) {
      // Note: imageGenMode and MAX_RETRIES already defined above for streaming
      log.debug(`🖼️  [STORYBOOK] Image generation mode: ${imageGenMode.toUpperCase()}`);

      // Helper function to generate a single image (used for sequential mode)
      const generateImage = async (scene, idx, previousImage = null, isSequential = false, vBible = null) => {
        const pageNum = scene.pageNumber;
        try {
          // DEBUG: Log available characters before filtering
          const allChars = inputData.characters || [];
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Total characters: ${allChars.length}`);
          allChars.forEach(char => {
            const hasPhoto = char.photoUrl?.startsWith('data:image');
            const hasBody = char.bodyPhotoUrl?.startsWith('data:image');
            const hasBodyNoBg = char.bodyNoBgUrl?.startsWith('data:image');
            const hasClothing = char.clothingAvatars ? Object.keys(char.clothingAvatars).filter(k => char.clothingAvatars[k]?.startsWith('data:image')).join(',') : 'none';
            log.debug(`   - ${char.name}: face=${hasPhoto}, body=${hasBody}, bodyNoBg=${hasBodyNoBg}, clothing=[${hasClothing}]`);
          });

          // Detect which characters appear in this scene
          const sceneCharacters = getCharactersInScene(scene.description, inputData.characters || []);
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Characters found in scene: ${sceneCharacters.map(c => c.name).join(', ') || 'NONE'}`);

          // Parse clothing category from scene description
          const clothingCategory = parseClothingCategory(scene.description) || 'standard';
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Clothing category: ${clothingCategory}`);

          // Use detailed photo info (with names) for labeled reference images
          const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Reference photos: ${referencePhotos.map(p => `${p.name}:${p.photoType}:${p.photoHash}`).join(', ') || 'NONE'}`);

          // Log visual bible usage
          if (vBible) {
            const relevantEntries = getVisualBibleEntriesForPage(vBible, pageNum);
            log.debug(`📸 [STORYBOOK] Generating image for page ${pageNum} (${sceneCharacters.length} chars, clothing: ${clothingCategory}, ${relevantEntries.length} visual bible entries)...`);
          } else {
            log.debug(`📸 [STORYBOOK] Generating image for page ${pageNum} (${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory})...`);
          }

          // Build image prompt with only scene-specific characters and visual bible
          const imagePrompt = buildImagePrompt(scene.description, inputData, sceneCharacters, isSequential, vBible, pageNum, true); // isStorybook = true
          imagePrompts[pageNum] = imagePrompt;

          // Usage tracker for page images
          const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
            if (imgUsage) addUsage('gemini_image', imgUsage, 'page_images', imgModel);
            if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
          };

          let imageResult = null;
          let retries = 0;

          while (retries <= MAX_RETRIES && !imageResult) {
            try {
              // Pass labeled character photos (name + photoUrl)
              // In sequential mode, also pass previous image for consistency
              // Use quality retry to regenerate if score is below threshold
              const seqSceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
              imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, previousImage, 'scene', null, pageUsageTracker, null, seqSceneModelOverrides);
            } catch (error) {
              retries++;
              log.error(`❌ [STORYBOOK] Page ${pageNum} image attempt ${retries} failed:`, error.message);
              if (retries > MAX_RETRIES) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
          }

          log.debug(`✅ [STORYBOOK] Page ${pageNum} image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

          // Update progress
          const progressPercent = 30 + Math.floor((idx + 1) / sceneCount * 50);
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progressPercent, `Generated image ${idx + 1}/${sceneCount}...`, jobId]
          );

          return {
            pageNumber: pageNum,
            imageData: imageResult.imageData,
            description: scene.description,
            prompt: imagePrompt,
            qualityScore: imageResult.score,
            qualityReasoning: imageResult.reasoning || null,
            qualityModelId: imageResult.qualityModelId || null,
            fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: imageResult.wasRegenerated || false,
            totalAttempts: imageResult.totalAttempts || 1,
            retryHistory: imageResult.retryHistory || [],
            originalImage: imageResult.originalImage || null,
            originalScore: imageResult.originalScore || null,
            originalReasoning: imageResult.originalReasoning || null,
            referencePhotos
          };
        } catch (error) {
          log.error(`❌ [STORYBOOK] Failed to generate image for page ${pageNum}:`, error.message);
          return {
            pageNumber: pageNum,
            imageData: null,
            description: scene.description,
            prompt: null,
            error: error.message,
            referencePhotos: []
          };
        }
      };

      if (imageGenMode === 'sequential') {
        // SEQUENTIAL MODE: Generate images one at a time, passing previous for consistency
        console.log(`🔗 [STORYBOOK] Starting SEQUENTIAL image generation for ${allSceneDescriptions.length} scenes...`);
        if (visualBible) {
          log.debug(`📖 [STORYBOOK] Using visual bible for image generation`);
        }
        let previousImage = null;

        for (let i = 0; i < allSceneDescriptions.length; i++) {
          const scene = allSceneDescriptions[i];
          log.debug(`🔗 [STORYBOOK SEQUENTIAL ${i + 1}/${allSceneDescriptions.length}] Processing page ${scene.pageNumber}...`);

          const result = await generateImage(scene, i, previousImage, true, visualBible); // isSequential = true, with visual bible
          allImages.push(result);

          // Use this image as reference for next image
          if (result.imageData) {
            previousImage = result.imageData;
          }
        }

        log.debug(`🚀 [STORYBOOK] All ${allImages.length} images generated (SEQUENTIAL MODE)!`);
      } else {
        // PARALLEL MODE: Wait for streaming images first, then generate any missing scenes
        log.debug(`⚡ [STORYBOOK] Waiting for ${streamingImagePromises.length} images started during streaming...`);

        // Wait for all images that were started during streaming
        if (streamingImagePromises.length > 0) {
          const streamingResults = await Promise.all(streamingImagePromises);
          streamingResults.forEach(img => {
            if (img) allImages.push(img);
          });
          log.debug(`✅ [STORYBOOK] ${allImages.length} streaming images complete`);
        }

        // Find any scenes that weren't processed during streaming (last scene might be missed)
        const processedPages = new Set(allImages.map(img => img.pageNumber));
        const missingScenes = allSceneDescriptions.filter(scene => !processedPages.has(scene.pageNumber));

        if (missingScenes.length > 0) {
          log.debug(`⚡ [STORYBOOK] Generating ${missingScenes.length} remaining images...`);
          if (visualBible) {
            log.debug(`📖 [STORYBOOK] Using visual bible for remaining images`);
          }
          const limit = pLimit(5);

          const remainingPromises = missingScenes.map((scene) => {
            return limit(() => generateImageForScene(scene.pageNumber, scene.description, null, visualBible));
          });

          const remainingResults = await Promise.all(remainingPromises);
          remainingResults.forEach(img => {
            if (img) allImages.push(img);
          });
        }

        log.debug(`🚀 [STORYBOOK] All ${allImages.length} images generated (PARALLEL MODE with streaming)!`);
      }

      // Sort images by page number
      allImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Count how many covers were already generated during streaming
    const coversFromStreaming = Object.values(coverImages).filter(c => c !== null).length;

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [85, coversFromStreaming > 0 ? `${coversFromStreaming} cover images ready. Generating remaining covers...` : 'Generating cover images...', jobId]
    );

    // Generate any cover images not generated during streaming
    if (!skipImages && !skipCovers) {
      try {
        const artStyleId = inputData.artStyle || 'pixar';
        const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

        // Use AI-generated cover scenes (or fallbacks) - handle both new format {scene, clothing} and legacy string
        const titlePageScene = coverScenes.titlePage?.scene || (typeof coverScenes.titlePage === 'string' ? coverScenes.titlePage : null) || `A beautiful, magical title page featuring the main characters. Decorative elements that reflect the story's theme with space for the title text.`;
        const initialPageScene = coverScenes.initialPage?.scene || (typeof coverScenes.initialPage === 'string' ? coverScenes.initialPage : null) || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
        const backCoverScene = coverScenes.backCover?.scene || (typeof coverScenes.backCover === 'string' ? coverScenes.backCover : null) || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

        // Build visual bible prompt for covers (shows recurring elements like pets, artifacts)
        const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible) : '';

        // Usage tracker for cover images
        const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        // Front cover - only generate if not already done during streaming
        if (!coverImages.frontCover) {
          // Detect which characters appear in the front cover scene
          const frontCoverCharacters = getCharactersInScene(titlePageScene, inputData.characters || []);
          // Use extracted clothing or parse from scene description
          const frontCoverClothing = coverScenes.titlePage?.clothing || parseClothingCategory(titlePageScene) || 'standard';
          // Use detailed photo info (with names) for labeled reference images
          const frontCoverPhotos = getCharacterPhotoDetails(frontCoverCharacters, frontCoverClothing);
          log.debug(`📕 [STORYBOOK] Front cover: ${frontCoverCharacters.length} characters (${frontCoverCharacters.map(c => c.name).join(', ') || 'none'}), clothing: ${frontCoverClothing}`);

          const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: titlePageScene,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(frontCoverPhotos, frontCoverCharacters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.frontCover = frontCoverPrompt;
          const frontCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const frontCoverResult = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker, null, frontCoverModelOverrides);
          log.debug(`✅ [STORYBOOK] Front cover generated (score: ${frontCoverResult.score}${frontCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.frontCover = {
            imageData: frontCoverResult.imageData,
            description: titlePageScene,
            prompt: frontCoverPrompt,
            qualityScore: frontCoverResult.score,
            qualityReasoning: frontCoverResult.reasoning || null,
            fixTargets: frontCoverResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: frontCoverResult.wasRegenerated || false,
            totalAttempts: frontCoverResult.totalAttempts || 1,
            retryHistory: frontCoverResult.retryHistory || [],
            originalImage: frontCoverResult.originalImage || null,
            originalScore: frontCoverResult.originalScore || null,
            originalReasoning: frontCoverResult.originalReasoning || null,
            referencePhotos: frontCoverPhotos,
            modelId: frontCoverResult.modelId || null
          };
        } else {
          log.debug(`⚡ [STORYBOOK] Front cover already generated during streaming (skipping)`);
        }

        // Initial page - only generate if not already done during streaming
        if (!coverImages.initialPage) {
          // Use extracted clothing or parse from scene description
          const initialPageClothing = coverScenes.initialPage?.clothing || parseClothingCategory(initialPageScene) || 'standard';
          const initialPagePhotos = getCharacterPhotoDetails(inputData.characters || [], initialPageClothing);
          log.debug(`📕 [STORYBOOK] Initial page: ALL ${initialPagePhotos.length} characters (group scene with main character centered), clothing: ${initialPageClothing}`);

          const initialPrompt = inputData.dedication && inputData.dedication.trim()
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: initialPageScene,
                STYLE_DESCRIPTION: styleDescription,
                DEDICATION: inputData.dedication,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
                VISUAL_BIBLE: visualBiblePrompt
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: initialPageScene,
                STYLE_DESCRIPTION: styleDescription,
                STORY_TITLE: storyTitle,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
                VISUAL_BIBLE: visualBiblePrompt
              });
          coverPrompts.initialPage = initialPrompt;
          const initialPageModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const initialResult = await generateImageWithQualityRetry(initialPrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker, null, initialPageModelOverrides);
          log.debug(`✅ [STORYBOOK] Initial page generated (score: ${initialResult.score}${initialResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.initialPage = {
            imageData: initialResult.imageData,
            description: initialPageScene,
            prompt: initialPrompt,
            qualityScore: initialResult.score,
            qualityReasoning: initialResult.reasoning || null,
            fixTargets: initialResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: initialResult.wasRegenerated || false,
            totalAttempts: initialResult.totalAttempts || 1,
            retryHistory: initialResult.retryHistory || [],
            originalImage: initialResult.originalImage || null,
            originalScore: initialResult.originalScore || null,
            originalReasoning: initialResult.originalReasoning || null,
            referencePhotos: initialPagePhotos,
            modelId: initialResult.modelId || null
          };
        } else {
          log.debug(`⚡ [STORYBOOK] Initial page already generated during streaming (skipping)`);
        }

        // Back cover - only generate if not already done during streaming
        if (!coverImages.backCover) {
          // Use extracted clothing or parse from scene description
          const backCoverClothing = coverScenes.backCover?.clothing || parseClothingCategory(backCoverScene) || 'standard';
          const backCoverPhotos = getCharacterPhotoDetails(inputData.characters || [], backCoverClothing);
          log.debug(`📕 [STORYBOOK] Back cover: ALL ${backCoverPhotos.length} characters (equal prominence group scene), clothing: ${backCoverClothing}`);

          const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: backCoverScene,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(backCoverPhotos, inputData.characters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.backCover = backCoverPrompt;
          const backCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const backCoverResult = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker, null, backCoverModelOverrides);
          log.debug(`✅ [STORYBOOK] Back cover generated (score: ${backCoverResult.score}${backCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.backCover = {
            imageData: backCoverResult.imageData,
            description: backCoverScene,
            prompt: backCoverPrompt,
            qualityScore: backCoverResult.score,
            qualityReasoning: backCoverResult.reasoning || null,
            fixTargets: backCoverResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: backCoverResult.wasRegenerated || false,
            totalAttempts: backCoverResult.totalAttempts || 1,
            retryHistory: backCoverResult.retryHistory || [],
            originalImage: backCoverResult.originalImage || null,
            originalScore: backCoverResult.originalScore || null,
            originalReasoning: backCoverResult.originalReasoning || null,
            referencePhotos: backCoverPhotos,
            modelId: backCoverResult.modelId || null
          };
        }

        log.debug(`✅ [STORYBOOK] Cover images complete (${coversFromStreaming} from streaming, ${3 - coversFromStreaming} generated after)`);
      } catch (error) {
        log.error(`❌ [STORYBOOK] Cover generation failed:`, error.message);
      }
    }

    // Prepare result data
    const resultData = {
      title: storyTitle,
      storyText: fullStoryText,
      outline: '', // No outline for picture book mode
      visualBible: visualBible, // Recurring visual elements for consistency
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      imagePrompts: imagePrompts,
      coverPrompts: coverPrompts,  // Cover image prompts for dev mode
      storyType: inputData.storyType,
      storyDetails: inputData.storyDetails,
      pages: sceneCount,
      language: lang,
      languageLevel: '1st-grade',
      characters: inputData.characters,
      dedication: dedication,
      artStyle: inputData.artStyle,
      // Developer mode: raw AI response for debugging
      rawAIResponse: response
    };

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: storyTitle,
      storyType: inputData.storyType || 'picture-book',
      artStyle: inputData.artStyle || 'pixar',
      language: lang,
      languageLevel: '1st-grade',
      pages: sceneCount,
      dedication: dedication,
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      outline: '',
      visualBible: visualBible, // Recurring visual elements for consistency
      storyText: fullStoryText,
      originalStory: fullStoryText, // Store original for restore functionality
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      tokenUsage: tokenUsage, // Token usage statistics for cost tracking
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].input_tokens, 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].output_tokens, 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiImageCost = calculateCost('gemini_image', tokenUsage.gemini_image.input_tokens, tokenUsage.gemini_image.output_tokens, tokenUsage.gemini_image.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    const totalCost = anthropicCost.total + geminiImageCost.total + geminiQualityCost.total;
    log.debug(`📊 [STORYBOOK] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` / ${tokenUsage.anthropic.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingImageStr = tokenUsage.gemini_image.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_image.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr} (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out${thinkingImageStr} (${tokenUsage.gemini_image.calls} calls)  $${geminiImageCost.total.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr} (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    // Use first model for cost calculation (model-specific pricing), fall back to provider
    const getCostModel = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models)[0] : funcData.provider;
    if (byFunc.outline.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.outline), byFunc.outline.input_tokens, byFunc.outline.output_tokens, byFunc.outline.thinking_tokens);
      log.debug(`   Outline:       ${byFunc.outline.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.outline.output_tokens.toLocaleString().padStart(8)} out (${byFunc.outline.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.outline)}]`);
    }
    if (byFunc.story_text.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.story_text), byFunc.story_text.input_tokens, byFunc.story_text.output_tokens, byFunc.story_text.thinking_tokens);
      log.debug(`   Story Text:    ${byFunc.story_text.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.story_text.output_tokens.toLocaleString().padStart(8)} out (${byFunc.story_text.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.story_text)}]`);
    }
    if (byFunc.scene_descriptions.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_descriptions), byFunc.scene_descriptions.input_tokens, byFunc.scene_descriptions.output_tokens, byFunc.scene_descriptions.thinking_tokens);
      log.debug(`   Scene Desc:    ${byFunc.scene_descriptions.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_descriptions.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_descriptions.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_descriptions)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_images), byFunc.cover_images.input_tokens, byFunc.cover_images.output_tokens, byFunc.cover_images.thinking_tokens);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_images)}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_images), byFunc.page_images.input_tokens, byFunc.page_images.output_tokens, byFunc.page_images.thinking_tokens);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_images)}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    const thinkingTotal = totalThinkingTokens > 0 ? `, ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);

    // Insert into stories table
    await dbPool.query(
      'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
      [storyId, userId, JSON.stringify(storyData)]
    );
    log.debug(`📚 [STORYBOOK] Story ${storyId} saved to stories table`);

    // Log credit completion (credits were already reserved at job creation)
    try {
      const jobResult = await dbPool.query(
        'SELECT credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const creditsUsed = jobResult.rows[0].credits_reserved;
        const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
        const currentBalance = userResult.rows[0]?.credits || 0;

        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, 0, currentBalance, 'story_complete', jobId, `Story completed - ${creditsUsed} credits used`]
        );
        log.info(`💳 [STORYBOOK] Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ [STORYBOOK] Failed to log credit completion:', creditErr.message);
    }

    // Add storyId to resultData so client can navigate to it
    resultData.storyId = storyId;

    // Mark job as completed and reset credits_reserved to prevent accidental refunds
    await dbPool.query(
      `UPDATE story_jobs SET
        status = 'completed',
        progress = 100,
        progress_message = 'Picture book complete!',
        result_data = $1,
        credits_reserved = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [JSON.stringify(resultData), jobId]
    );

    log.debug(`✅ [STORYBOOK] Job ${jobId} completed successfully`);
    return resultData;

  } catch (error) {
    log.error(`❌ [STORYBOOK] Job ${jobId} failed:`, error);

    // Refund reserved credits on failure - PROPORTIONAL based on work completed
    try {
      const jobResult = await dbPool.query(
        'SELECT user_id, credits_reserved, progress FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const refundUserId = jobResult.rows[0].user_id;
        const totalCredits = jobResult.rows[0].credits_reserved;
        const progressPercent = jobResult.rows[0].progress || 0;

        // Full refund if story is not 100% complete - incomplete stories have no value to user
        const isComplete = progressPercent >= 100;
        const creditsToRefund = isComplete ? 0 : totalCredits;

        if (creditsToRefund > 0) {
          // Get current balance
          const userResult = await dbPool.query(
            'SELECT credits FROM users WHERE id = $1',
            [refundUserId]
          );

          if (userResult.rows.length > 0 && userResult.rows[0].credits !== -1) {
            const currentBalance = userResult.rows[0].credits;
            const newBalance = currentBalance + creditsToRefund;

            // Refund credits
            await dbPool.query(
              'UPDATE users SET credits = $1 WHERE id = $2',
              [newBalance, refundUserId]
            );

            // Create refund transaction record
            const description = `Full refund: ${creditsToRefund} credits - storybook generation failed at ${progressPercent}%`;

          await dbPool.query(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [refundUserId, creditsToRefund, newBalance, 'story_refund', jobId, description]
          );

          // Reset credits_reserved to prevent double refunds
          await dbPool.query(
            'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
            [jobId]
          );

            log.info(`💳 [STORYBOOK] Refunded ${creditsToRefund} credits for failed job ${jobId} (failed at ${progressPercent}%)`);
          }
        }
      }
    } catch (refundErr) {
      log.error('❌ [STORYBOOK] Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs SET
        status = 'failed',
        error_message = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [error.message, jobId]
    );

    throw error;
  }
}

// Background worker function to process a story generation job
// NEW STREAMING ARCHITECTURE: Generate images as story batches complete
async function processStoryJob(jobId) {
  console.log(`🎬 Starting processing for job ${jobId}`);

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility) - includes thinking_tokens for Gemini 2.5
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() }
    }
  };

  // Pricing per million tokens by model (as of Dec 2025)
  const MODEL_PRICING = {
    // Anthropic models
    'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00 },
    'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00 },
    'claude-opus-4-5': { input: 5.00, output: 25.00 },
    // Gemini text models
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-2.0-flash': { input: 0.10, output: 0.40 },
    // Gemini image models
    'gemini-2.5-flash-image': { input: 0.30, output: 30.00 },
    'gemini-3-pro-image-preview': { input: 2.00, output: 120.00 },
    'gemini-2.0-flash-exp-image-generation': { input: 0.10, output: 0.40 }  // Image editing
  };

  // Fallback pricing by provider (if model not found)
  const PROVIDER_PRICING = {
    anthropic: { input: 3.00, output: 15.00 },
    gemini_image: { input: 0.30, output: 30.00 },
    gemini_quality: { input: 0.10, output: 0.40 },
    gemini_text: { input: 0.30, output: 2.50 }
  };

  // Helper to add usage - now supports function-level tracking with model names and thinking tokens
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage[provider].calls += 1;
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage.output_tokens || 0;
      tokenUsage.byFunction[functionName].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      tokenUsage.byFunction[functionName].provider = provider; // Track actual provider used
      if (modelName) {
        tokenUsage.byFunction[functionName].models.add(modelName);
      }
    }
  };

  // Helper to calculate cost - uses model-specific pricing if available
  // Thinking tokens are billed at output rate for Gemini 2.5 models
  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    // Try model-specific pricing first, then fall back to provider pricing
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output; // Thinking billed at output rate
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  try {
    // Get job data
    const jobResult = await dbPool.query(
      'SELECT * FROM story_jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      throw new Error('Job not found');
    }

    const job = jobResult.rows[0];
    const inputData = job.input_data;
    const skipImages = inputData.skipImages === true; // Developer mode: text only
    const skipCovers = inputData.skipCovers === true; // Developer mode: skip cover generation

    // Developer mode: model overrides (admin only)
    // Use centralized MODEL_DEFAULTS from textModels.js
    const modelOverrides = {
      outlineModel: MODEL_DEFAULTS.outline,
      textModel: MODEL_DEFAULTS.storyText,
      sceneDescriptionModel: MODEL_DEFAULTS.sceneDescription,
      imageModel: MODEL_DEFAULTS.pageImage,
      coverImageModel: MODEL_DEFAULTS.coverImage,
      qualityModel: MODEL_DEFAULTS.qualityEval,
      ...inputData.modelOverrides  // User overrides take precedence
    };
    // Always log model defaults being used
    log.debug(`🔧 [PIPELINE] Model defaults: outline=${MODEL_DEFAULTS.outline}, text=${MODEL_DEFAULTS.storyText}, scene=${MODEL_DEFAULTS.sceneDescription}, quality=${MODEL_DEFAULTS.qualityEval}`);
    if (inputData.modelOverrides && Object.keys(inputData.modelOverrides).length > 0) {
      log.debug(`🔧 [PIPELINE] User overrides: ${JSON.stringify(inputData.modelOverrides)}`);
    }

    // Check if this is a picture book (1st-grade) - use simplified combined flow
    const isPictureBook = inputData.languageLevel === '1st-grade';

    // Get language for scene descriptions
    const lang = inputData.language || 'en';
    const langText = lang === 'de' ? 'German' : lang === 'fr' ? 'French' : 'English';

    // Calculate number of story scenes to generate:
    // - Picture Book: 1 scene per page (image + text on same page)
    // - Standard: 1 scene per 2 print pages (text page + facing image page)
    const printPages = inputData.pages;  // Total pages when printed
    const sceneCount = isPictureBook ? printPages : Math.floor(printPages / 2);
    log.debug(`📚 [PIPELINE] Print pages: ${printPages}, Mode: ${isPictureBook ? 'Picture Book' : 'Standard'}, Scenes to generate: ${sceneCount}`);

    if (skipImages) {
      log.debug(`📝 [PIPELINE] Text-only mode enabled - skipping image generation`);
    }
    if (skipCovers) {
      log.debug(`📝 [PIPELINE] Skip covers enabled - skipping cover image generation`);
    }

    // Determine image generation mode: sequential (consistent) or parallel (fast)
    // Sequential passes previous image to next for better character consistency
    const imageGenMode = inputData.imageGenMode || IMAGE_GEN_MODE || 'parallel';
    log.debug(`🖼️  [PIPELINE] Image generation mode: ${imageGenMode.toUpperCase()}`);

    // Extract character photos for reference images (with names for labeling)
    // Use getCharacterPhotoDetails for labeled references
    const characterPhotos = getCharacterPhotoDetails(inputData.characters || []);
    log.debug(`📸 [PIPELINE] Found ${characterPhotos.length} labeled character photos for reference`);

    // Update status to processing
    await dbPool.query(
      'UPDATE story_jobs SET status = $1, progress = $2, progress_message = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      ['processing', 5, 'Starting story generation...', jobId]
    );

    if (isPictureBook) {
      log.debug(`📚 [PIPELINE] Picture Book mode - using combined text+scene generation`);
      return await processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides);
    }

    // Standard flow for normal stories
    await dbPool.query(
      'UPDATE story_jobs SET progress_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Writing story...', jobId]
    );

    // Step 1: Generate story outline
    // Pass sceneCount to ensure outline matches the number of scenes we'll generate
    const outlinePrompt = buildStoryPrompt(inputData, sceneCount);
    const outlineTokens = 16000;
    const outlineModelOverride = modelOverrides.outlineModel || null;
    const outlineModelConfig = outlineModelOverride ? TEXT_MODELS[outlineModelOverride] : getActiveTextModel();
    const outlineProvider = outlineModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';
    log.debug(`📋 [PIPELINE] Generating outline for ${sceneCount} scenes (max tokens: ${outlineTokens}) - STREAMING${outlineModelOverride ? ` [model: ${outlineModelOverride}]` : ''}`);
    const outlineResult = await callTextModelStreaming(outlinePrompt, outlineTokens, null, outlineModelOverride);
    const outline = outlineResult.text;
    // Get the actual model used (override or default)
    const outlineModelUsed = outlineResult.modelId || outlineModelConfig?.modelId;
    const outlineUsage = outlineResult.usage || { input_tokens: 0, output_tokens: 0 };
    addUsage(outlineProvider, outlineResult.usage, 'outline', outlineModelUsed);

    // Save checkpoint: outline (include prompt, model, and token usage for debugging)
    await saveCheckpoint(jobId, 'outline', { outline, outlinePrompt, outlineModelId: outlineModelUsed, outlineUsage });

    // Extract short scene descriptions from outline for better image generation
    const shortSceneDescriptions = extractShortSceneDescriptions(outline);
    log.debug(`📋 [PIPELINE] Extracted ${Object.keys(shortSceneDescriptions).length} short scene descriptions from outline`);

    // Extract page clothing from outline for consistent outfit rendering
    const pageClothingData = extractPageClothing(outline, sceneCount);
    log.debug(`👔 [PIPELINE] Primary clothing: ${pageClothingData.primaryClothing}, changes on ${Object.entries(pageClothingData.pageClothing).filter(([p, c]) => c !== pageClothingData.primaryClothing).length} pages`);

    // Parse Visual Bible for recurring elements consistency
    const visualBible = parseVisualBible(outline);
    // Filter out main characters from secondary characters (safety net)
    filterMainCharactersFromVisualBible(visualBible, inputData.characters);

    // Initialize main characters from inputData.characters with their style analysis
    initializeVisualBibleMainCharacters(visualBible, inputData.characters);

    const visualBibleEntryCount = visualBible.secondaryCharacters.length +
                                   visualBible.animals.length +
                                   visualBible.artifacts.length +
                                   visualBible.locations.length;

    log.debug(`📖 [PIPELINE] Visual Bible after parsing: ${JSON.stringify({
      mainCharacters: visualBible.mainCharacters.length,
      secondaryCharacters: visualBible.secondaryCharacters.length,
      animals: visualBible.animals.length,
      artifacts: visualBible.artifacts.length,
      locations: visualBible.locations.length,
      changeLog: visualBible.changeLog.length
    })}`);

    // Validate visual bible was parsed - if outline contains "visual bible" but we got 0 entries, fail
    if (outline.toLowerCase().includes('visual bible') && visualBibleEntryCount === 0) {
      log.error('❌ [PIPELINE] Visual Bible section exists in outline but parsing returned 0 entries!');
      log.error('📖 [PIPELINE] This indicates a parsing bug. Outline preview around "visual bible":');
      const vbIndex = outline.toLowerCase().indexOf('visual bible');
      log.error(outline.substring(Math.max(0, vbIndex - 50), Math.min(outline.length, vbIndex + 500)));
      throw new Error('Visual Bible parsing failed: section exists but no entries extracted. Check outline format.');
    }

    // Save checkpoint: scene hints and visual bible
    await saveCheckpoint(jobId, 'scene_hints', { shortSceneDescriptions, visualBible });

    // Extract title from outline (for cover generation that starts in parallel)
    // The outline format is typically:
    // # Title
    // **Actual Title Here** or Title: Actual Title Here
    let storyTitle = inputData.title || 'My Story';
    // Try multiple patterns:
    // 1. "# Title\n**Actual Title**" - bold on next line
    // 2. "# Title\nTitle: Actual Title" - "Title:" prefix on next line
    // 3. "# Title\nActual Title" - plain text on next line (not "# " or "---")
    // 4. "TITLE: Actual Title" - inline format
    const boldTitleMatch = outline.match(/^#{1,2}\s*Title\s*\n+\*\*(.+?)\*\*/im);
    const prefixTitleMatch = outline.match(/^#{1,2}\s*Title\s*\n+Title:\s*(.+?)$/im);
    const plainTitleMatch = outline.match(/^#{1,2}\s*Title\s*\n+([^#\-\n].+?)$/im);
    const inlineTitleMatch = outline.match(/TITLE:\s*(.+)/i);

    const titleMatch = boldTitleMatch || prefixTitleMatch || plainTitleMatch || inlineTitleMatch;
    if (titleMatch) {
      storyTitle = titleMatch[1].trim();
      log.debug(`📖 [PIPELINE] Extracted title from outline: "${storyTitle}"`);
    }

    // START COVER GENERATION IN PARALLEL (optimization: don't wait for page images)
    // Covers only need: outline (for scenes), character photos, art style - all available now
    let coverGenerationPromise = null;
    const coverPrompts = {};  // Store cover prompts for dev mode

    if (!skipImages && !skipCovers) {
      console.log(`📕 [PIPELINE] Starting PARALLEL cover generation for job ${jobId}`);

      // Get art style description
      const artStyleId = inputData.artStyle || 'pixar';
      const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

      // Extract cover scene descriptions from outline
      const coverScenes = extractCoverScenes(outline);
      const titlePageScene = coverScenes.titlePage?.scene || `A beautiful, magical title page featuring the main characters. Decorative elements that reflect the story's theme with space for the title text.`;
      const initialPageScene = coverScenes.initialPage?.scene || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
      const backCoverScene = coverScenes.backCover?.scene || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

      // Build visual bible prompt for covers
      const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible) : '';

      // Helper to build character reference list for cover prompts
      const buildCharacterReferenceList = (photos, characters = null) => {
        if (!photos || photos.length === 0) return '';
        const charDescriptions = photos.map((photo, index) => {
          // Find the original character to get full physical description
          const char = characters?.find(c => c.name === photo.name);
          const age = char?.age ? `${char.age} years old` : '';
          const gender = char?.gender === 'male' ? 'boy/man' : char?.gender === 'female' ? 'girl/woman' : '';
          // Include physical traits with labels (excluding height - AI doesn't understand it for images)
          const physical = char?.physical;
          const physicalParts = [
            physical?.build ? `Build: ${physical.build}` : '',
            physical?.face ? `Face: ${physical.face}` : '',
            physical?.hair ? `Hair: ${physical.hair}` : '',
            physical?.other ? `Other: ${physical.other}` : ''
          ].filter(Boolean);
          const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
          const brief = [photo.name, age, gender, physicalDesc].filter(Boolean).join(', ');
          return `${index + 1}. ${brief}`;
        });
        let result = `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;

        // Add relative height description if characters data is available
        if (characters && characters.length >= 2) {
          // Filter to only characters in this scene (matching photo names)
          const sceneCharacters = characters.filter(c => photos.some(p => p.name === c.name));
          const heightDescription = buildRelativeHeightDescription(sceneCharacters);
          if (heightDescription) {
            result += `\n${heightDescription}\n`;
            log.debug(`📏 [COVER] Added relative heights: ${heightDescription}`);
          }
        }

        return result;
      };

      // Prepare all cover generation promises
      // Front cover
      const frontCoverCharacters = getCharactersInScene(titlePageScene, inputData.characters || []);
      const frontCoverClothing = coverScenes.titlePage?.clothing || parseClothingCategory(titlePageScene) || 'standard';
      const frontCoverPhotos = getCharacterPhotoDetails(frontCoverCharacters, frontCoverClothing);
      const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
        TITLE_PAGE_SCENE: titlePageScene,
        STYLE_DESCRIPTION: styleDescription,
        STORY_TITLE: storyTitle,
        CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(frontCoverPhotos, frontCoverCharacters),
        VISUAL_BIBLE: visualBiblePrompt
      });
      coverPrompts.frontCover = frontCoverPrompt;

      // Initial page
      const initialPageClothing = coverScenes.initialPage?.clothing || parseClothingCategory(initialPageScene) || 'standard';
      const initialPagePhotos = getCharacterPhotoDetails(inputData.characters || [], initialPageClothing);
      const initialPagePrompt = inputData.dedication && inputData.dedication.trim()
        ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
            INITIAL_PAGE_SCENE: initialPageScene,
            STYLE_DESCRIPTION: styleDescription,
            DEDICATION: inputData.dedication,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
            VISUAL_BIBLE: visualBiblePrompt
          })
        : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
            INITIAL_PAGE_SCENE: initialPageScene,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
            VISUAL_BIBLE: visualBiblePrompt
          });
      coverPrompts.initialPage = initialPagePrompt;

      // Back cover
      const backCoverClothing = coverScenes.backCover?.clothing || parseClothingCategory(backCoverScene) || 'standard';
      const backCoverPhotos = getCharacterPhotoDetails(inputData.characters || [], backCoverClothing);
      const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
        BACK_COVER_SCENE: backCoverScene,
        STYLE_DESCRIPTION: styleDescription,
        CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(backCoverPhotos, inputData.characters),
        VISUAL_BIBLE: visualBiblePrompt
      });
      coverPrompts.backCover = backCoverPrompt;

      // Usage tracker for cover images
      const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
        if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
        if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
      };

      // Model overrides for cover images (use coverImageModel for covers)
      const pipelineCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };

      // Start all 3 covers in parallel (don't await yet)
      coverGenerationPromise = Promise.all([
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting front cover (${frontCoverCharacters.length} chars, clothing: ${frontCoverClothing})`);
          const result = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides);
          console.log(`✅ [COVER-PARALLEL] Front cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'frontCover', imageData: result.imageData, storyTitle, modelId: result.modelId || null }, 0);
          return { type: 'frontCover', result, photos: frontCoverPhotos, scene: titlePageScene, prompt: frontCoverPrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting initial page (${initialPagePhotos.length} chars, clothing: ${initialPageClothing})`);
          const result = await generateImageWithQualityRetry(initialPagePrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides);
          console.log(`✅ [COVER-PARALLEL] Initial page complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'initialPage', imageData: result.imageData, modelId: result.modelId || null }, 1);
          return { type: 'initialPage', result, photos: initialPagePhotos, scene: initialPageScene, prompt: initialPagePrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting back cover (${backCoverPhotos.length} chars, clothing: ${backCoverClothing})`);
          const result = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides);
          console.log(`✅ [COVER-PARALLEL] Back cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'backCover', imageData: result.imageData, modelId: result.modelId || null }, 2);
          return { type: 'backCover', result, photos: backCoverPhotos, scene: backCoverScene, prompt: backCoverPrompt };
        })()
      ]);

      log.debug(`📕 [PIPELINE] Cover generation started in background (3 covers in parallel)`);
    }

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Writing story...', jobId]
    );

    // STREAMING PIPELINE: Generate story in batches, immediately generate images as pages complete
    // Use STORY_BATCH_SIZE env var: 0 = auto-calculate based on model limits, >0 = fixed batch size
    let BATCH_SIZE;
    if (STORY_BATCH_SIZE > 0) {
      // Use configured batch size
      BATCH_SIZE = STORY_BATCH_SIZE;
      console.log(`📚 [PIPELINE] Using configured batch size: ${BATCH_SIZE} pages per batch`);
    } else {
      // Auto-calculate optimal batch size based on model token limits and reading level
      // Token estimate: max words/page × 1.3 tokens/word × 2 (safety margin)
      const tokensPerPage = getTokensPerPage(inputData.languageLevel);
      BATCH_SIZE = calculateOptimalBatchSize(sceneCount, tokensPerPage, 1.0); // Full capacity
      console.log(`📚 [PIPELINE] Auto-calculated batch size: ${BATCH_SIZE} pages per batch (${tokensPerPage} tokens/page estimate, model max: ${getActiveTextModel().maxOutputTokens})`);
    }
    const numBatches = Math.ceil(sceneCount / BATCH_SIZE);

    let fullStoryText = '';
    const allImages = [];
    const allSceneDescriptions = [];
    const imagePrompts = {};
    const storyTextPrompts = []; // Collect all story text batch prompts for dev mode

    // Create rate limiter for parallel image generation: max 5 concurrent
    const limit = pLimit(5);
    const MAX_RETRIES = 2;

    // Track active image generation promises
    let activeImagePromises = [];

    log.debug(`📚 [STREAMING] Starting streaming pipeline: ${sceneCount} scenes in ${numBatches} batches of ${BATCH_SIZE}`);

    for (let batchNum = 0; batchNum < numBatches; batchNum++) {
      const startScene = batchNum * BATCH_SIZE + 1;
      const endScene = Math.min((batchNum + 1) * BATCH_SIZE, sceneCount);

      log.debug(`📖 [BATCH ${batchNum + 1}/${numBatches}] Generating scenes ${startScene}-${endScene}`);

      // Generate story text for this batch
      const basePrompt = buildBasePrompt(inputData, sceneCount);
      const readingLevel = getReadingLevel(inputData.languageLevel);

      log.debug(`📝 [BATCH ${batchNum + 1}] Reading level: ${inputData.languageLevel || 'standard'} - ${readingLevel}`);

      // Format Visual Bible for story text prompt
      const visualBibleForPrompt = formatVisualBibleForStoryText(visualBible);

      const batchPrompt = PROMPT_TEMPLATES.storyTextBatch
        ? fillTemplate(PROMPT_TEMPLATES.storyTextBatch, {
            BASE_PROMPT: basePrompt,
            OUTLINE: outline,
            PAGES: sceneCount,
            START_PAGE: startScene,
            END_PAGE: endScene,
            READING_LEVEL: readingLevel,
            VISUAL_BIBLE: visualBibleForPrompt,
            INCLUDE_TITLE: batchNum === 0 ? 'Include the title and dedication at the beginning.' : 'Start directly with the page content (no title/dedication).'
          })
        : `${basePrompt}

Here is the story outline:
${outline}

IMPORTANT: Now write pages ${startScene} through ${endScene} of the story following the outline above.
${batchNum === 0 ? 'Include the title and dedication at the beginning.' : 'Start directly with the page content (no title/dedication).'}

**CRITICAL PAGE RANGE RULES:**
- You **MUST** write exactly pages ${startScene} through ${endScene} - no more, no less
- **STOP IMMEDIATELY** after completing page ${endScene}
- Do **NOT** write page ${endScene + 1} or any pages beyond ${endScene}, even if the outline mentions them
- The outline shows the full story for context, but you are ONLY responsible for pages ${startScene}-${endScene}
- Ensure there is **exactly one "--- Page X ---" marker per page**

Output Format:
--- Page ${startScene} ---
[Story text...]

...continue until page ${endScene}...`;

      // Store batch prompt for dev mode
      storyTextPrompts.push({
        batch: batchNum + 1,
        startPage: startScene,
        endPage: endScene,
        prompt: batchPrompt
      });

      // Use the full model capacity - no artificial limits
      // Claude stops naturally when done (end_turn), we only pay for tokens actually used
      const batchSceneCount = endScene - startScene + 1;
      const textModelOverride = modelOverrides.textModel || null;
      const textModelConfig = textModelOverride ? TEXT_MODELS[textModelOverride] : getActiveTextModel();
      const batchTokensNeeded = textModelConfig?.maxOutputTokens || getActiveTextModel().maxOutputTokens;
      log.debug(`📝 [BATCH ${batchNum + 1}] Requesting ${batchTokensNeeded} max tokens for ${batchSceneCount} pages - STREAMING${textModelOverride ? ` [model: ${textModelOverride}]` : ''}`);

      // Track which pages have started image generation (for progressive mode)
      const pagesStarted = new Set();
      // Track page texts for passing previous scenes context
      const pageTextsForContext = {};
      // Track clothing categories for previous scenes context (for consistency)
      const pageClothingForContext = {};

      // Scene description model override
      const sceneModelOverride = modelOverrides.sceneDescriptionModel || null;
      const sceneModelConfig = sceneModelOverride ? TEXT_MODELS[sceneModelOverride] : getActiveTextModel();
      const sceneDescProvider = sceneModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';

      // Helper function to start image generation for a page
      const startPageImageGeneration = (pageNum, pageContent) => {
        if (pagesStarted.has(pageNum)) return; // Already started
        if (pageNum < startScene || pageNum > endScene) return; // Outside batch range
        pagesStarted.add(pageNum);

        // Store this page's text for future pages' context
        pageTextsForContext[pageNum] = pageContent;

        const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

        // Build previous scenes context (last 2 pages)
        // Use pageClothingData from outline (reliable) for clothing, not pageClothingForContext (which may not be ready in parallel mode)
        const previousScenes = [];
        for (let prevPage = pageNum - 2; prevPage < pageNum; prevPage++) {
          if (prevPage >= 1 && pageTextsForContext[prevPage]) {
            previousScenes.push({
              pageNumber: prevPage,
              text: pageTextsForContext[prevPage],
              sceneHint: shortSceneDescriptions[prevPage] || '',
              clothing: pageClothingData?.pageClothing?.[prevPage] || pageClothingForContext[prevPage] || null
            });
          }
        }

        // Generate scene description using Art Director prompt (in story language)
        const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, langText, visualBible, previousScenes);

        // Start scene description + image generation (don't await)
        const imagePromise = limit(async () => {
          try {
            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description...${sceneModelOverride ? ` [model: ${sceneModelOverride}]` : ''}`);

            // Generate detailed scene description (non-streaming for reliability with parallel calls)
            const sceneDescResult = await callTextModel(scenePrompt, 4000, sceneModelOverride);
            let sceneDescription = sceneDescResult.text;

            // Fallback to outline extract if scene description is empty or too short
            if (!sceneDescription || sceneDescription.trim().length < 50) {
              log.warn(`⚠️  [PAGE ${pageNum}] Scene description empty or too short (${sceneDescription?.length || 0} chars), using outline extract`);
              sceneDescription = shortSceneDesc || `Scene for page ${pageNum}`;
            }
            addUsage(sceneDescProvider, sceneDescResult.usage, 'scene_descriptions', sceneModelConfig?.modelId || getActiveTextModel().modelId);

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,
              scenePrompt: scenePrompt,
              textModelId: sceneDescResult.modelId
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            const clothingCategory = parseClothingCategory(sceneDescription) || 'standard';
            // Store clothing for future pages' context (clothing consistency)
            pageClothingForContext[pageNum] = clothingCategory;
            const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
            log.debug(`📸 [PAGE ${pageNum}] Generating image (${sceneCharacters.length} characters, clothing: ${clothingCategory})...`);

            // Generate image
            const imagePrompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, false, visualBible, pageNum);
            imagePrompts[pageNum] = imagePrompt;

            let imageResult = null;
            let retries = 0;

            // Callback for immediate display - saves image before quality evaluation completes
            const onImageReady = async (imgData, modelId) => {
              const partialData = {
                pageNumber: pageNum,
                imageData: imgData,
                description: sceneDescription,
                text: pageContent,
                prompt: imagePrompt,
                qualityScore: null,  // Not yet evaluated
                qualityReasoning: null,
                wasRegenerated: false,
                totalAttempts: 1,
                retryHistory: [],
                referencePhotos: referencePhotos,
                modelId: modelId || null
              };
              await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
              log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
            };

            // Usage tracker for page images
            const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
              if (imgUsage) addUsage('gemini_image', imgUsage, 'page_images', imgModel);
              if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
            };

            while (retries <= MAX_RETRIES && !imageResult) {
              try {
                const parallelSceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
                imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker, null, parallelSceneModelOverrides);
              } catch (error) {
                retries++;
                log.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
                if (retries > MAX_RETRIES) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
              }
            }

            log.debug(`✅ [PAGE ${pageNum}] Image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

            const imageData = {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              text: pageContent,
              prompt: imagePrompt,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              modelId: imageResult.modelId || null
            };

            // Save final result with quality score (overwrites immediate save)
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              text: pageContent,
              prompt: imagePrompt,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              modelId: imageResult.modelId || null
            }, pageNum);
            log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

            return imageData;
          } catch (error) {
            log.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            // Return error result instead of throwing to prevent unhandled rejection crash
            return {
              pageNumber: pageNum,
              imageData: null,
              error: error.message,
              failed: true
            };
          }
        });

        activeImagePromises.push(imagePromise);
      };

      // PROGRESSIVE STREAMING: Start image generation as pages complete during text streaming
      let batchText = '';

      // Track if we've parsed Visual Bible entries from this batch (only do once per batch)
      let visualBibleParsedForBatch = false;

      if (!skipImages && imageGenMode === 'parallel') {
        // Create progressive parser that starts image generation as pages stream in
        const progressiveParser = new ProgressiveStoryPageParser((page) => {
          log.debug(`🌊 [PROGRESSIVE] Page ${page.pageNumber} detected during streaming, starting image generation`);
          startPageImageGeneration(page.pageNumber, page.content);
        });

        // Stream with progressive parsing
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded, (chunk, fullText) => {
          // Check for Visual Bible entries BEFORE pages start (only for first batch)
          if (!visualBibleParsedForBatch && batchNum === 0) {
            // Look for either ---STORY TEXT--- marker or first page marker
            const hasStoryMarker = fullText.includes('---STORY TEXT---');
            const hasPageMarker = fullText.match(/--- Page \d+ ---/i);

            if (hasStoryMarker || hasPageMarker) {
              // Parse and merge new Visual Bible entries BEFORE page 1 image generates
              const newEntries = parseNewVisualBibleEntries(fullText);
              const totalNew = newEntries.animals.length + newEntries.artifacts.length +
                               newEntries.locations.length + newEntries.secondaryCharacters.length;
              if (totalNew > 0) {
                log.debug(`📖 [VISUAL BIBLE] Found ${totalNew} new entries from story text, merging before image generation`);
                mergeNewVisualBibleEntries(visualBible, newEntries);
              }
              visualBibleParsedForBatch = true;
            }
          }
          progressiveParser.processChunk(chunk, fullText);
        }, textModelOverride);
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

        // Finalize to emit the last page
        progressiveParser.finalize(batchText);
        log.debug(`🌊 [PROGRESSIVE] Batch streaming complete, ${pagesStarted.size} pages started during stream`);
      } else {
        // No progressive parsing - just stream text
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded, null, textModelOverride);
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

        // Parse Visual Bible entries for non-progressive mode (first batch only)
        if (batchNum === 0) {
          const newEntries = parseNewVisualBibleEntries(batchText);
          const totalNew = newEntries.animals.length + newEntries.artifacts.length +
                           newEntries.locations.length + newEntries.secondaryCharacters.length;
          if (totalNew > 0) {
            log.debug(`📖 [VISUAL BIBLE] Found ${totalNew} new entries from story text, merging`);
            mergeNewVisualBibleEntries(visualBible, newEntries);
          }
        }
      }

      fullStoryText += batchText + '\n\n';
      console.log(`✅ [BATCH ${batchNum + 1}/${numBatches}] Story batch complete (${batchText.length} chars)`);

      // Save checkpoint: story batch (include prompt for debugging)
      await saveCheckpoint(jobId, 'story_batch', { batchNum, batchText, startScene, endScene, batchPrompt }, batchNum);

      // Parse the pages from this batch (for validation and any pages missed by streaming)
      let batchPages = parseStoryPages(batchText);
      log.debug(`📄 [BATCH ${batchNum + 1}/${numBatches}] Parsed ${batchPages.length} pages`);

      // Filter to only include pages in the expected range (Claude sometimes generates extra)
      const unfilteredCount = batchPages.length;
      batchPages = batchPages.filter(p => p.pageNumber >= startScene && p.pageNumber <= endScene);
      if (batchPages.length < unfilteredCount) {
        log.warn(`[BATCH ${batchNum + 1}] Filtered out ${unfilteredCount - batchPages.length} pages outside range ${startScene}-${endScene}`);
      }

      // VALIDATION: Check if all expected pages were generated
      const expectedPageCount = endScene - startScene + 1;
      const parsedPageNumbers = batchPages.map(p => p.pageNumber);
      const missingPages = [];
      for (let p = startScene; p <= endScene; p++) {
        if (!parsedPageNumbers.includes(p)) {
          missingPages.push(p);
        }
      }

      // RETRY: If pages are missing, request them explicitly
      if (missingPages.length > 0) {
        log.warn(`[BATCH ${batchNum + 1}] Missing pages: ${missingPages.join(', ')}. Retrying for missing pages...`);

        for (const missingPageNum of missingPages) {
          const retryPrompt = `${basePrompt}

Here is the story outline:
${outline}

CRITICAL: You MUST write ONLY page ${missingPageNum} of the story. This page was missing from the previous generation.

Look at what you already wrote for context:
${batchText}

Now write ONLY page ${missingPageNum}. Use EXACTLY this format:

--- Page ${missingPageNum} ---
[Write the story text for page ${missingPageNum} here, following the outline and maintaining continuity with other pages]`;

          log.debug(` Generating missing page ${missingPageNum}...`);
          const retryResult = await callTextModelStreaming(retryPrompt, 1500, null, textModelOverride);
          const retryText = retryResult.text;
          addUsage('anthropic', retryResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

          // Parse the retry response
          const retryPages = parseStoryPages(retryText);
          if (retryPages.length > 0) {
            console.log(`✅ [RETRY] Successfully generated page ${missingPageNum}`);
            batchPages.push(...retryPages);
            fullStoryText += retryText + '\n\n';

            // Start image generation for retry page too
            if (!skipImages && imageGenMode === 'parallel') {
              for (const retryPage of retryPages) {
                startPageImageGeneration(retryPage.pageNumber, retryPage.content);
              }
            }
          } else {
            log.error(`[RETRY] Failed to parse page ${missingPageNum} from retry response`);
          }
        }

        // Sort pages by page number after adding retried pages
        batchPages.sort((a, b) => a.pageNumber - b.pageNumber);
        log.debug(`📄 [BATCH ${batchNum + 1}/${numBatches}] After retry: ${batchPages.length} pages`);
      }

      // Start image generation for any pages that weren't caught by progressive streaming
      // (fallback for edge cases)
      if (!skipImages && imageGenMode === 'parallel') {
        for (const page of batchPages) {
          if (!pagesStarted.has(page.pageNumber)) {
            console.log(`📝 [FALLBACK] Starting image for page ${page.pageNumber} (missed by streaming)`);
            startPageImageGeneration(page.pageNumber, page.content);
          }
        }
      }

      // Update progress after each batch
      const storyProgress = 10 + Math.floor((batchNum + 1) / numBatches * 30); // 10-40%
      const completedImageCount = allImages.length;
      // Show simple progress: either writing or which image we're on
      const progressMsg = completedImageCount > 0
        ? `Image ${completedImageCount}/${sceneCount}...`
        : 'Writing story...';

      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [storyProgress, progressMsg, jobId]
      );
    }

    // Clean up fullStoryText to remove Visual Bible section (keep only story pages)
    fullStoryText = extractStoryTextFromOutput(fullStoryText);

    // Save story_text checkpoint so client can display text while images generate
    // Parse all pages from the full story text and build page text map
    const allStoryPages = parseStoryPages(fullStoryText);
    const pageTextMap = {};
    allStoryPages.forEach(page => {
      pageTextMap[page.pageNumber] = page.content;
    });

    await saveCheckpoint(jobId, 'story_text', {
      title: storyTitle,
      dedication: inputData.dedication || '',
      pageTexts: pageTextMap,
      sceneDescriptions: allSceneDescriptions.map(sd => ({
        pageNumber: sd.pageNumber,
        description: sd.description || '',
        outlineExtract: shortSceneDescriptions[sd.pageNumber] || '',
        scenePrompt: sd.scenePrompt || '',
        textModelId: sd.textModelId || ''
      })),
      totalPages: sceneCount
    });
    log.debug(`💾 [STORY] Saved story_text checkpoint with ${Object.keys(pageTextMap).length} pages for progressive display`);

    // Wait for images only if not skipping
    if (!skipImages) {
      if (imageGenMode === 'parallel') {
        // PARALLEL MODE: Wait for all concurrent image promises
        log.debug(`📚 [STREAMING] All story batches submitted. Waiting for ${activeImagePromises.length} images to complete (PARALLEL MODE)...`);

        // Wait for all images to complete
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [50, `Image 1/${sceneCount}...`, jobId]
        );

        let completedCount = 0;
        let failedCount = 0;
        const imageResults = await Promise.all(
          activeImagePromises.map(async (promise) => {
            const result = await promise;
            completedCount++;

            // Update progress
            const imageProgress = 50 + Math.floor(completedCount / sceneCount * 40); // 50-90%
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [imageProgress, `Image ${completedCount}/${sceneCount}...`, jobId]
            );

            // Only add successful results to allImages
            if (result.failed) {
              failedCount++;
              log.warn(`⚠️  [PARALLEL] Page ${result.pageNumber} failed: ${result.error}`);
            } else {
              allImages.push(result);
            }
            return result;
          })
        );

        // Sort images by page number
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        if (failedCount > 0) {
          log.warn(`⚠️  [STREAMING] ${failedCount}/${sceneCount} images failed to generate`);
        }
        log.debug(`🚀 [STREAMING] ${allImages.length}/${sceneCount} images generated (PARALLEL MODE)!`);
      } else {
        // SEQUENTIAL MODE: Generate images one at a time, passing previous image to next
        log.debug(`📚 [STREAMING] All story batches complete. Starting SEQUENTIAL image generation...`);

        // Parse all pages from the full story text
        let allPages = parseStoryPages(fullStoryText);

        // Deduplicate pages - keep only first occurrence of each page number
        const seenPages = new Set();
        const beforeDedup = allPages.length;
        allPages = allPages.filter(page => {
          if (seenPages.has(page.pageNumber)) {
            log.warn(`[SEQUENTIAL] Removing duplicate page ${page.pageNumber}`);
            return false;
          }
          seenPages.add(page.pageNumber);
          return true;
        });
        if (allPages.length < beforeDedup) {
          log.warn(`[SEQUENTIAL] Removed ${beforeDedup - allPages.length} duplicate pages`);
        }

        log.debug(`📄 [SEQUENTIAL] Found ${allPages.length} pages to generate images for`);

        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [50, `Image 1/${allPages.length}...`, jobId]
        );

        let previousImage = null;
        const pageTextsForContext = {}; // Track page texts for previous scenes context
        const pageClothingForContext = {}; // Track clothing for consistency

        // Scene description model override for sequential mode
        const seqSceneModelOverride = modelOverrides.sceneDescriptionModel || null;
        const seqSceneModelConfig = seqSceneModelOverride ? TEXT_MODELS[seqSceneModelOverride] : getActiveTextModel();
        const seqSceneDescProvider = seqSceneModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';

        for (let i = 0; i < allPages.length; i++) {
          const page = allPages[i];
          const pageNum = page.pageNumber;
          const pageContent = page.content;
          const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

          // Store this page's text for future context
          pageTextsForContext[pageNum] = pageContent;

          // Build previous scenes context (last 2 pages)
          // Use pageClothingData from outline (reliable) for clothing
          const previousScenes = [];
          for (let prevPage = pageNum - 2; prevPage < pageNum; prevPage++) {
            if (prevPage >= 1 && pageTextsForContext[prevPage]) {
              previousScenes.push({
                pageNumber: prevPage,
                text: pageTextsForContext[prevPage],
                sceneHint: shortSceneDescriptions[prevPage] || '',
                clothing: pageClothingData?.pageClothing?.[prevPage] || pageClothingForContext[prevPage] || null
              });
            }
          }

          log.debug(`🔗 [SEQUENTIAL ${i + 1}/${allPages.length}] Processing page ${pageNum}...`);

          try {
            // Generate scene description using Art Director prompt (in story language)
            // Pass visualBible so recurring elements are included in scene description
            const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, langText, visualBible, previousScenes);

            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description...${seqSceneModelOverride ? ` [model: ${seqSceneModelOverride}]` : ''}`);
            const sceneDescResult = await callTextModel(scenePrompt, 4000, seqSceneModelOverride);
            let sceneDescription = sceneDescResult.text;

            // Fallback to outline extract if scene description is empty or too short
            if (!sceneDescription || sceneDescription.trim().length < 50) {
              log.warn(`⚠️  [PAGE ${pageNum}] Scene description empty or too short (${sceneDescription?.length || 0} chars), using outline extract`);
              sceneDescription = shortSceneDesc || `Scene for page ${pageNum}`;
            }
            addUsage(seqSceneDescProvider, sceneDescResult.usage, 'scene_descriptions', seqSceneModelConfig?.modelId || getActiveTextModel().modelId);

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,  // Store the outline extract for debugging
              scenePrompt: scenePrompt,        // Store the Art Director prompt for debugging
              textModelId: sceneDescResult.modelId
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            // Parse clothing category from scene description
            const clothingCategory = parseClothingCategory(sceneDescription) || 'standard';
            // Store clothing for future pages' context (clothing consistency)
            pageClothingForContext[pageNum] = clothingCategory;
            // Use detailed photo info (with names) for labeled reference images
            const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
            log.debug(`📸 [PAGE ${pageNum}] Generating image (${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory})...`);

            // Generate image from scene description with scene-specific characters and visual bible
            const imagePrompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, true, visualBible, pageNum);
            imagePrompts[pageNum] = imagePrompt;

            let imageResult = null;
            let retries = 0;

            // Callback for immediate display - saves image before quality evaluation completes
            const onImageReady = async (imgData, modelId) => {
              const partialData = {
                pageNumber: pageNum,
                imageData: imgData,
                description: sceneDescription,
                prompt: imagePrompt,
                text: pageContent,
                qualityScore: null,  // Not yet evaluated
                qualityReasoning: null,
                wasRegenerated: false,
                totalAttempts: 1,
                retryHistory: [],
                referencePhotos: referencePhotos,
                modelId: modelId || null
              };
              await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
              log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
            };

            // Usage tracker for page images
            const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
              if (imgUsage) addUsage('gemini_image', imgUsage, 'page_images', imgModel);
              if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
            };

            while (retries <= MAX_RETRIES && !imageResult) {
              try {
                // Pass labeled character photos (name + photoUrl) + previous image for continuity (SEQUENTIAL MODE)
                // Use quality retry to regenerate if score is below threshold
                const seqPipelineModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
                imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, previousImage, 'scene', onImageReady, pageUsageTracker, null, seqPipelineModelOverrides);
              } catch (error) {
                retries++;
                log.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
                if (retries > MAX_RETRIES) {
                  throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
              }
            }

            log.debug(`✅ [PAGE ${pageNum}] Image generated successfully (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

            // Store this image as the previous image for the next iteration
            previousImage = imageResult.imageData;

            const imageData = {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              prompt: imagePrompt,
              text: pageContent,  // Include page text for progressive display
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,  // Dev mode: which photos were used
              modelId: imageResult.modelId || null
            };

            // Save final result with quality score (overwrites immediate save)
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              prompt: imagePrompt,
              text: pageContent,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              modelId: imageResult.modelId || null
            }, pageNum);
            log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

            allImages.push(imageData);

            // Update progress
            const imageProgress = 50 + Math.floor((i + 1) / allPages.length * 40); // 50-90%
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [imageProgress, `Image ${i + 1}/${allPages.length}...`, jobId]
            );
          } catch (error) {
            log.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            throw error;
          }
        }

        // Sort images by page number (should already be in order, but ensure consistency)
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        log.debug(`🚀 [STREAMING] All ${allImages.length} images generated (SEQUENTIAL MODE)!`);
      }
    } else {
      log.debug(`📝 [STREAMING] Text-only mode - skipping image wait`);
    }

    // Update title from story text if we found a better one (optional refinement)
    if (fullStoryText) {
      const storyTitleMatch = fullStoryText.match(/^#\s+(.+?)$/m);
      if (storyTitleMatch) {
        const storyTextTitle = storyTitleMatch[1].trim();
        if (storyTextTitle !== storyTitle) {
          log.debug(`📖 [PIPELINE] Story text has different title: "${storyTextTitle}" (outline had: "${storyTitle}")`);
          // Keep the outline title since covers already used it
        }
      }
    }

    // Wait for parallel cover generation to complete
    let coverImages = null;

    if (coverGenerationPromise) {
      log.debug(`📕 [PIPELINE] Waiting for parallel cover generation to complete...`);
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [95, 'Finishing covers...', jobId]
      );

      try {
        const coverResults = await coverGenerationPromise;
        console.log(`✅ [PIPELINE] All 3 covers completed in parallel!`);

        // Build coverImages object from results
        const frontCover = coverResults.find(r => r.type === 'frontCover');
        const initialPage = coverResults.find(r => r.type === 'initialPage');
        const backCover = coverResults.find(r => r.type === 'backCover');

        coverImages = {
          frontCover: {
            imageData: frontCover.result.imageData,
            description: frontCover.scene,
            prompt: frontCover.prompt,
            qualityScore: frontCover.result.score,
            qualityReasoning: frontCover.result.reasoning || null,
            fixTargets: frontCover.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: frontCover.result.wasRegenerated || false,
            totalAttempts: frontCover.result.totalAttempts || 1,
            retryHistory: frontCover.result.retryHistory || [],
            originalImage: frontCover.result.originalImage || null,
            originalScore: frontCover.result.originalScore || null,
            originalReasoning: frontCover.result.originalReasoning || null,
            referencePhotos: frontCover.photos,
            modelId: frontCover.result.modelId || null
          },
          initialPage: {
            imageData: initialPage.result.imageData,
            description: initialPage.scene,
            prompt: initialPage.prompt,
            qualityScore: initialPage.result.score,
            qualityReasoning: initialPage.result.reasoning || null,
            fixTargets: initialPage.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: initialPage.result.wasRegenerated || false,
            totalAttempts: initialPage.result.totalAttempts || 1,
            retryHistory: initialPage.result.retryHistory || [],
            originalImage: initialPage.result.originalImage || null,
            originalScore: initialPage.result.originalScore || null,
            originalReasoning: initialPage.result.originalReasoning || null,
            referencePhotos: initialPage.photos,
            modelId: initialPage.result.modelId || null
          },
          backCover: {
            imageData: backCover.result.imageData,
            description: backCover.scene,
            prompt: backCover.prompt,
            qualityScore: backCover.result.score,
            qualityReasoning: backCover.result.reasoning || null,
            fixTargets: backCover.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: backCover.result.wasRegenerated || false,
            totalAttempts: backCover.result.totalAttempts || 1,
            retryHistory: backCover.result.retryHistory || [],
            originalImage: backCover.result.originalImage || null,
            originalScore: backCover.result.originalScore || null,
            originalReasoning: backCover.result.originalReasoning || null,
            referencePhotos: backCover.photos,
            modelId: backCover.result.modelId || null
          }
        };

        const frontRegen = frontCover.result.wasRegenerated ? ' (regenerated)' : '';
        const initialRegen = initialPage.result.wasRegenerated ? ' (regenerated)' : '';
        const backRegen = backCover.result.wasRegenerated ? ' (regenerated)' : '';
        log.debug(`📊 [PIPELINE] Cover quality scores - Front: ${frontCover.result.score}${frontRegen}, Initial: ${initialPage.result.score}${initialRegen}, Back: ${backCover.result.score}${backRegen}`);
      } catch (error) {
        log.error(`❌ [PIPELINE] Cover generation failed:`, error);
        throw new Error(`Cover generation failed: ${error.message}`);
      }
    } else if (!skipImages && !skipCovers) {
      log.warn(`[PIPELINE] No cover generation promise found - covers may have been skipped`);
    } else {
      log.debug(`📝 [PIPELINE] Text-only mode - skipping cover image generation`);
    }

    // Job complete - save result
    const resultData = {
      outline,
      outlinePrompt,  // API prompt for outline (dev mode)
      storyTextPrompts, // API prompts for story text batches (dev mode)
      visualBible, // Visual Bible for recurring element consistency (dev mode)
      storyText: fullStoryText,
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages,
      imagePrompts,
      coverPrompts,  // Cover image prompts for dev mode
      title: storyTitle,
      textOnly: skipImages // Mark if this was text-only generation
    };

    log.debug('📖 [SERVER] resultData keys:', Object.keys(resultData));
    log.debug('📖 [SERVER] storyText exists?', !!resultData.storyText);
    log.debug('📖 [SERVER] storyText length:', resultData.storyText?.length || 0);
    log.verbose('📖 [SERVER] storyText preview:', resultData.storyText?.substring(0, 200));

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: storyTitle,
      storyType: inputData.storyType || '',
      artStyle: inputData.artStyle || 'pixar',
      language: inputData.language || 'en',
      languageLevel: inputData.languageLevel || '1st-grade',
      pages: inputData.pages || sceneCount,
      dedication: inputData.dedication || '',
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      outline: outline,
      outlinePrompt: outlinePrompt, // API prompt for outline (dev mode)
      storyTextPrompts: storyTextPrompts, // API prompts for story text (dev mode)
      storyText: fullStoryText,
      originalStory: fullStoryText, // Store original for restore functionality
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      visualBible: visualBible, // Visual Bible for recurring element consistency (dev mode)
      pageClothing: pageClothingData, // Clothing per page extracted from outline
      tokenUsage: tokenUsage, // Token usage statistics for cost tracking
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].input_tokens, 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].output_tokens, 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiImageCost = calculateCost('gemini_image', tokenUsage.gemini_image.input_tokens, tokenUsage.gemini_image.output_tokens, tokenUsage.gemini_image.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    const totalCost = anthropicCost.total + geminiImageCost.total + geminiQualityCost.total;
    log.debug(`📊 [PIPELINE] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` / ${tokenUsage.anthropic.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingImageStr = tokenUsage.gemini_image.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_image.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr} (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out${thinkingImageStr} (${tokenUsage.gemini_image.calls} calls)  $${geminiImageCost.total.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr} (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    // Use first model for cost calculation (model-specific pricing), fall back to provider
    const getCostModel = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models)[0] : funcData.provider;
    if (byFunc.outline.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.outline), byFunc.outline.input_tokens, byFunc.outline.output_tokens, byFunc.outline.thinking_tokens);
      log.debug(`   Outline:       ${byFunc.outline.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.outline.output_tokens.toLocaleString().padStart(8)} out (${byFunc.outline.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.outline)}]`);
    }
    if (byFunc.scene_descriptions.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_descriptions), byFunc.scene_descriptions.input_tokens, byFunc.scene_descriptions.output_tokens, byFunc.scene_descriptions.thinking_tokens);
      log.debug(`   Scene Desc:    ${byFunc.scene_descriptions.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_descriptions.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_descriptions.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_descriptions)}]`);
    }
    if (byFunc.story_text.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.story_text), byFunc.story_text.input_tokens, byFunc.story_text.output_tokens, byFunc.story_text.thinking_tokens);
      log.debug(`   Story Text:    ${byFunc.story_text.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.story_text.output_tokens.toLocaleString().padStart(8)} out (${byFunc.story_text.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.story_text)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_images), byFunc.cover_images.input_tokens, byFunc.cover_images.output_tokens, byFunc.cover_images.thinking_tokens);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_images)}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_images), byFunc.page_images.input_tokens, byFunc.page_images.output_tokens, byFunc.page_images.thinking_tokens);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_images)}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    const thinkingTotal = totalThinkingTokens > 0 ? `, ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);

    // Insert into stories table
    await dbPool.query(
      'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
      [storyId, job.user_id, JSON.stringify(storyData)]
    );
    log.debug(`📚 Story ${storyId} saved to stories table`);

    // Log credit completion (credits were already reserved at job creation)
    try {
      const creditJobResult = await dbPool.query(
        'SELECT credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (creditJobResult.rows.length > 0 && creditJobResult.rows[0].credits_reserved > 0) {
        const creditsUsed = creditJobResult.rows[0].credits_reserved;
        const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [job.user_id]);
        const currentBalance = userResult.rows[0]?.credits || 0;

        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [job.user_id, 0, currentBalance, 'story_complete', jobId, `Story completed - ${creditsUsed} credits used`]
        );
        log.debug(`💳 Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ Failed to log credit completion:', creditErr.message);
    }

    // Add storyId to resultData so client can navigate to it
    resultData.storyId = storyId;

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           credits_reserved = 0, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      ['completed', 100, 'Story generation complete!', JSON.stringify(resultData), jobId]
    );

    console.log(`✅ Job ${jobId} completed successfully`);

    // Send story completion email to customer
    try {
      const userResult = await dbPool.query(
        'SELECT email, username, shipping_first_name, preferred_language FROM users WHERE id = $1',
        [job.user_id]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];
        const storyTitle = inputData.storyTitle || inputData.title || 'Your Story';
        // Use shipping_first_name if available, otherwise fall back to username
        const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
        // Get language for email localization - prefer user's preference, fall back to story language
        const emailLanguage = user.preferred_language || inputData.language || 'English';
        await email.sendStoryCompleteEmail(user.email, firstName, storyTitle, storyId, emailLanguage);
      }
    } catch (emailErr) {
      log.error('❌ Failed to send story complete email:', emailErr);
    }

  } catch (error) {
    log.error(`❌ Job ${jobId} failed:`, error);

    // Log all partial data for debugging
    try {
      log.debug('\n' + '='.repeat(80));
      log.error('📋 [DEBUG] PARTIAL DATA DUMP FOR FAILED JOB:', jobId);
      log.debug('='.repeat(80));

      // Get job input data
      const jobDataResult = await dbPool.query('SELECT input_data FROM story_jobs WHERE id = $1', [jobId]);
      if (jobDataResult.rows.length > 0) {
        const inputData = jobDataResult.rows[0].input_data;
        log.debug('\n📥 [INPUT DATA]:');
        log.debug('  Story Type:', inputData?.storyType);
        log.debug('  Story Type Name:', inputData?.storyTypeName);
        log.debug('  Art Style:', inputData?.artStyle);
        log.debug('  Language:', inputData?.language);
        log.debug('  Language Level:', inputData?.languageLevel);
        log.debug('  Pages:', inputData?.pages);
        log.debug('  Story Details:', inputData?.storyDetails?.substring(0, 200) + (inputData?.storyDetails?.length > 200 ? '...' : ''));
        log.debug('  Characters:', inputData?.characters?.map(c => `${c.name} (${c.gender}, ${c.age})`).join(', '));
        log.debug('  Main Characters:', inputData?.mainCharacters);
      }

      // Get all checkpoints
      const checkpoints = await getAllCheckpoints(jobId);
      log.debug(`\n💾 [CHECKPOINTS]: Found ${checkpoints.length} checkpoints`);

      for (const cp of checkpoints) {
        log.debug(`\n--- ${cp.step_name} (index: ${cp.step_index}) at ${cp.created_at} ---`);
        const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

        if (cp.step_name === 'outline') {
          log.debug('📜 [OUTLINE]:', data.outline?.substring(0, 500) + '...');
          if (data.outlinePrompt) {
            log.debug('📜 [OUTLINE PROMPT]:', data.outlinePrompt?.substring(0, 1000) + '...');
          }
        } else if (cp.step_name === 'scene_hints') {
          log.debug('🎬 [SCENE HINTS]:', JSON.stringify(data.shortSceneDescriptions, null, 2).substring(0, 500) + '...');
        } else if (cp.step_name === 'story_batch') {
          log.debug(`📖 [STORY BATCH ${data.batchNum}] Pages ${data.startScene}-${data.endScene}:`);
          log.debug('  Text preview:', data.batchText?.substring(0, 300) + '...');
          if (data.batchPrompt) {
            log.debug('  Batch prompt:', data.batchPrompt?.substring(0, 500) + '...');
          }
        } else if (cp.step_name === 'partial_page') {
          log.debug(`🖼️  [PAGE ${cp.step_index}]:`);
          log.debug('  Scene description:', (data.description || data.sceneDescription?.description)?.substring(0, 200) + '...');
          log.debug('  Image prompt:', (data.prompt || data.imagePrompt)?.substring(0, 200) + '...');
          log.debug('  Has image:', !!data.imageData);
          log.debug('  Quality score:', data.qualityScore || data.score);
        } else if (cp.step_name === 'cover') {
          log.debug(`🎨 [COVER ${data.type}]:`);
          log.debug('  Prompt:', data.prompt?.substring(0, 200) + '...');
        } else if (cp.step_name === 'storybook_combined') {
          log.debug('📚 [STORYBOOK COMBINED]:', data.response?.substring(0, 500) + '...');
        } else {
          log.debug('  Data keys:', Object.keys(data).join(', '));
        }
      }

      log.debug('\n' + '='.repeat(80));
      log.debug('📋 [DEBUG] END OF PARTIAL DATA DUMP');
      log.debug('='.repeat(80) + '\n');

      // SAVE PARTIAL RESULTS - reconstruct story from checkpoints and save to stories table
      try {
        const jobDataResult = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
        if (jobDataResult.rows.length > 0) {
          const userId = jobDataResult.rows[0].user_id;
          const inputData = jobDataResult.rows[0].input_data;

          // Reconstruct story data from checkpoints
          let outline = '';
          let outlinePrompt = '';
          let outlineModelId = null;
          let outlineUsage = null;
          let fullStoryText = '';
          let sceneDescriptions = [];
          let sceneImages = [];
          let storyTextPrompts = [];
          let visualBible = null;
          let coverImages = {};

          for (const cp of checkpoints) {
            const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

            if (cp.step_name === 'outline') {
              outline = data.outline || '';
              outlinePrompt = data.outlinePrompt || '';
              outlineModelId = data.outlineModelId || null;
              outlineUsage = data.outlineUsage || null;
            } else if (cp.step_name === 'scene_hints' && data.visualBible) {
              visualBible = data.visualBible;
            } else if (cp.step_name === 'story_batch') {
              if (data.batchText) {
                fullStoryText += (fullStoryText ? '\n\n' : '') + data.batchText;
              }
              if (data.batchPrompt) {
                storyTextPrompts.push({
                  batch: data.batchNum || storyTextPrompts.length + 1,
                  startPage: data.startScene || 1,
                  endPage: data.endScene || 15,
                  prompt: data.batchPrompt
                });
              }
            } else if (cp.step_name === 'partial_page') {
              const pageNum = cp.step_index;
              // Handle both old format (sceneDescription object) and new format (description string)
              const sceneDesc = data.description || data.sceneDescription?.description || data.sceneDescription || '';
              if (sceneDesc) {
                sceneDescriptions.push({
                  pageNumber: pageNum,
                  description: sceneDesc
                });
              }
              if (data.imageData) {
                sceneImages.push({
                  pageNumber: pageNum,
                  imageData: data.imageData,
                  description: sceneDesc,
                  prompt: data.prompt || data.imagePrompt || '',
                  qualityScore: data.qualityScore || data.score,
                  qualityReasoning: data.qualityReasoning || data.reasoning,
                  totalAttempts: data.totalAttempts,
                  retryHistory: data.retryHistory,
                  wasRegenerated: data.wasRegenerated,
                  originalImage: data.originalImage,
                  originalScore: data.originalScore,
                  originalReasoning: data.originalReasoning,
                  modelId: data.modelId || null
                });
              }
            } else if (cp.step_name === 'cover') {
              const coverType = data.type;
              if (data.imageData) {
                coverImages[coverType] = {
                  imageData: data.imageData,
                  description: data.description || '',
                  prompt: data.prompt || '',
                  qualityScore: data.score,
                  qualityReasoning: data.reasoning,
                  modelId: data.modelId || null
                };
              }
            }
          }

          // Only save if we have at least some content
          const hasContent = outline || fullStoryText || sceneImages.length > 0;
          if (hasContent) {
            const storyTitle = inputData?.title || `Partial Story (${new Date().toLocaleDateString()})`;
            const storyData = {
              id: jobId,
              title: storyTitle + ' [PARTIAL]',
              storyType: inputData?.storyType || 'unknown',
              artStyle: inputData?.artStyle || 'pixar',
              language: inputData?.language || 'en',
              languageLevel: inputData?.languageLevel || 'standard',
              pages: inputData?.pages || sceneImages.length,
              dedication: inputData?.dedication || '',
              characters: inputData?.characters || [],
              mainCharacters: inputData?.mainCharacters || [],
              relationships: inputData?.relationships || {},
              relationshipTexts: inputData?.relationshipTexts || {},
              outline: outline,
              outlinePrompt: outlinePrompt,
              outlineModelId: outlineModelId,
              outlineUsage: outlineUsage,
              story: fullStoryText,
              originalStory: fullStoryText, // Store original for restore functionality
              storyTextPrompts: storyTextPrompts,
              visualBible: visualBible,
              pageClothing: pageClothingData,
              sceneDescriptions: sceneDescriptions,
              sceneImages: sceneImages,
              coverImages: coverImages,
              isPartial: true,
              failureReason: error.message,
              generatedPages: sceneImages.length,
              totalPages: inputData?.pages || 15,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

            await dbPool.query(
              'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
              [jobId, userId, JSON.stringify(storyData)]
            );
            log.debug(`📚 [PARTIAL SAVE] Saved partial story ${jobId} with ${sceneImages.length} images to stories table`);
          } else {
            log.debug('📚 [PARTIAL SAVE] No content to save');
          }
        }
      } catch (partialSaveErr) {
        log.error('❌ [PARTIAL SAVE] Failed to save partial results:', partialSaveErr.message);
      }
    } catch (dumpErr) {
      log.error('❌ Failed to dump partial data:', dumpErr.message);
    }

    // Full refund if story is not 100% complete - incomplete stories have no value to user
    try {
      const jobResult = await dbPool.query(
        'SELECT user_id, credits_reserved, progress FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const refundUserId = jobResult.rows[0].user_id;
        const totalCredits = jobResult.rows[0].credits_reserved;
        const progressPercent = jobResult.rows[0].progress || 0;

        // Full refund if story is not 100% complete - incomplete stories have no value to user
        const isComplete = progressPercent >= 100;
        const creditsToRefund = isComplete ? 0 : totalCredits;

        if (creditsToRefund > 0) {
          // Get current balance
          const userResult = await dbPool.query(
            'SELECT credits FROM users WHERE id = $1',
            [refundUserId]
          );

          if (userResult.rows.length > 0 && userResult.rows[0].credits !== -1) {
            const currentBalance = userResult.rows[0].credits;
            const newBalance = currentBalance + creditsToRefund;

            // Refund credits
            await dbPool.query(
              'UPDATE users SET credits = $1 WHERE id = $2',
              [newBalance, refundUserId]
            );

            // Create refund transaction record
            const description = `Full refund: ${creditsToRefund} credits - story generation failed at ${progressPercent}%`;

            await dbPool.query(
              `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [refundUserId, creditsToRefund, newBalance, 'story_refund', jobId, description]
            );

            // Reset credits_reserved to prevent double refunds
            await dbPool.query(
              'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
              [jobId]
            );

            log.info(`💳 Refunded ${creditsToRefund} credits for failed job ${jobId} (failed at ${progressPercent}%)`);
          }
        }
      }
    } catch (refundErr) {
      log.error('❌ Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      ['failed', error.message, jobId]
    );

    // Send failure notifications
    try {
      const jobResult = await dbPool.query('SELECT user_id FROM story_jobs WHERE id = $1', [jobId]);
      if (jobResult.rows.length > 0) {
        const userId = jobResult.rows[0].user_id;
        const userResult = await dbPool.query(
          'SELECT email, username, shipping_first_name, preferred_language FROM users WHERE id = $1',
          [userId]
        );
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          // Notify admin
          await email.sendAdminStoryFailureAlert(jobId, userId, user.username, user.email || 'N/A', error.message);
          // Notify customer
          if (user.email) {
            const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
            // Get language for email localization - prefer user's preference, fall back to story language
            const emailLanguage = user.preferred_language || inputData.language || 'English';
            await email.sendStoryFailedEmail(user.email, firstName, emailLanguage);
          }
        }
      }
    } catch (emailErr) {
      log.error('❌ Failed to send failure notification emails:', emailErr);
    }
  }
}

// Helper functions for story generation

// Build base prompt with character/setting info for story text generation
// textPageCount: the actual number of text pages/scenes (not total PDF pages)
// NOTE: Prompt builder functions moved to server/lib/storyHelpers.js
// Exports: buildBasePrompt, buildStoryPrompt, parseSceneDescriptions,
// buildRelativeHeightDescription, buildImagePrompt



/**
 * Unified text model API caller
 * Uses the configured TEXT_MODEL env var to select provider
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens in response
 * @returns {Promise<string>} Generated text
 */
// =============================================================================
// NOTE: Text model API functions moved to server/lib/textModels.js
// Includes: callTextModel, callAnthropicAPI, callAnthropicAPIStreaming,
//           callTextModelStreaming, callGeminiTextAPI, callClaudeAPI
// =============================================================================
// =============================================================================
// NOTE: Image generation functions moved to server/lib/images.js
// Includes: generateImageCacheKey, cropImageForSequential, compressImageToJPEG,
//           evaluateImageQuality, rewriteBlockedScene, callGeminiAPIForImage,
//           editImageWithPrompt, generateImageWithQualityRetry
// =============================================================================



// Create a new story generation job
app.post('/api/jobs/create-story', authenticateToken, validateBody(schemas.createStory), async (req, res) => {
  try {
    const userId = req.user.id;

    // Extract and validate idempotency key (optional but recommended)
    const idempotencyKey = req.body.idempotencyKey ? sanitizeString(req.body.idempotencyKey, 100) : null;

    // If idempotency key provided, check for existing job first
    if (idempotencyKey && STORAGE_MODE === 'database') {
      const existingJob = await dbPool.query(
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

    // Sanitize and validate input data
    const inputData = {
      ...req.body,
      pages: sanitizeInteger(req.body.pages, 20, 10, 100),
      language: sanitizeString(req.body.language || 'en', 50),
      languageLevel: sanitizeString(req.body.languageLevel || 'standard', 50),
      storyType: sanitizeString(req.body.storyType || '', 100),
      artStyle: sanitizeString(req.body.artStyle || 'pixar', 50),
      storyDetails: sanitizeString(req.body.storyDetails || '', 2000),
      dedication: sanitizeString(req.body.dedication || '', 500)
    };
    // Remove idempotencyKey from input_data as it's stored separately
    delete inputData.idempotencyKey;

    log.debug(`📝 Creating story job ${jobId} for user ${req.user.username}${idempotencyKey ? ` (idempotency: ${idempotencyKey})` : ''}`);

    // Check email verification (skip for admins)
    if (req.user.role !== 'admin' && STORAGE_MODE === 'database') {
      const emailCheckResult = await dbPool.query(
        'SELECT email_verified FROM users WHERE id = $1',
        [userId]
      );

      // Check if email is NOT verified (NULL or FALSE both require verification, only TRUE passes)
      if (emailCheckResult.rows.length > 0 && emailCheckResult.rows[0].email_verified !== true) {
        log.warn(`User ${req.user.username} attempted story generation without verified email (value: ${emailCheckResult.rows[0].email_verified})`);

        // Send/resend verification email
        let emailSent = false;
        try {
          const userResult = await dbPool.query(
            'SELECT id, username, email FROM users WHERE id = $1',
            [userId]
          );
          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            const verificationToken = crypto.randomBytes(32).toString('hex');
            const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

            await dbPool.query(
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
      const activeJobResult = await dbPool.query(
        `SELECT id, status, created_at FROM story_jobs
         WHERE user_id = $1 AND status IN ('pending', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (activeJobResult.rows.length > 0) {
        const activeJob = activeJobResult.rows[0];
        const jobAgeMinutes = (Date.now() - new Date(activeJob.created_at).getTime()) / (1000 * 60);

        // If job is older than 30 minutes, consider it stale and mark as failed
        const STALE_JOB_TIMEOUT_MINUTES = 30;
        if (jobAgeMinutes > STALE_JOB_TIMEOUT_MINUTES) {
          log.error(`⏰ Job ${activeJob.id} is stale (${Math.round(jobAgeMinutes)} minutes old), marking as failed`);
          await dbPool.query(
            `UPDATE story_jobs
             SET status = 'failed',
                 error_message = 'Job timed out after 30 minutes',
                 updated_at = NOW()
             WHERE id = $1`,
            [activeJob.id]
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
      const hasAnyAvatar = Object.values(avatars).some(url => url && url.startsWith('data:image'));
      return !hasAnyAvatar && (char.photoUrl || char.bodyPhotoUrl); // Has photo but no avatars
    });
    if (charsWithoutAvatars.length > 0) {
      log.warn(`⚠️ [AVATAR CHECK] ${charsWithoutAvatars.length} character(s) missing clothing avatars: ${charsWithoutAvatars.map(c => c.name).join(', ')}. Using fallback photos.`);
    }

    if (STORAGE_MODE === 'database') {
      // Calculate credits needed: 10 credits per page
      const pages = inputData.pages || 10;
      const creditsNeeded = pages * 10;

      // Check user's credits
      const userResult = await dbPool.query(
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
            message: `This story requires ${creditsNeeded} credits (${pages} pages x 10 credits), but you only have ${userCredits} credits.`
          });
        }

        // Reserve credits atomically - this prevents race conditions
        // The UPDATE only succeeds if credits >= creditsNeeded, preventing overdraw
        const updateResult = await dbPool.query(
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
        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, -creditsNeeded, newBalance, 'story_reserve', jobId, `Reserved ${creditsNeeded} credits for ${pages}-page story`]
        );

        log.debug(`💳 Reserved ${creditsNeeded} credits for job ${jobId} (user balance: ${userCredits} -> ${newBalance})`);
      }

      await dbPool.query(
        `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...', userCredits === -1 ? 0 : creditsNeeded, idempotencyKey]
      );

      // Update user's preferred language based on their story language choice
      if (inputData.language) {
        await dbPool.query(
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
    processStoryJob(jobId).catch(err => {
      log.error(`❌ Job ${jobId} failed:`, err);
    });

    res.json({
      success: true,
      jobId,
      message: 'Story generation started. This will take approximately 10 minutes.'
    });
  } catch (err) {
    log.error('Error creating story job:', err);
    res.status(500).json({ error: 'Failed to create story job' });
  }
});

// Get job status
app.get('/api/jobs/:jobId/status', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    if (STORAGE_MODE === 'database') {
      const result = await dbPool.query(
        `SELECT id, status, progress, progress_message, result_data, error_message, created_at, completed_at
         FROM story_jobs
         WHERE id = $1 AND user_id = $2`,
        [jobId, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Job not found' });
      }

      const job = result.rows[0];

      // Fetch user's current credits when job is completed
      let currentCredits = null;
      if (job.status === 'completed') {
        const creditsResult = await dbPool.query(
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
      if (job.status === 'processing') {
        // Fetch partial pages
        const partialPagesResult = await dbPool.query(
          `SELECT step_index, step_data
           FROM story_job_checkpoints
           WHERE job_id = $1 AND step_name = 'partial_page'
           ORDER BY step_index ASC`,
          [jobId]
        );
        partialPages = partialPagesResult.rows.map(row => row.step_data);

        // Fetch partial covers (generated during streaming)
        const partialCoversResult = await dbPool.query(
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
        const storyTextResult = await dbPool.query(
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
        resultData: job.result_data,
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
app.post('/api/jobs/:jobId/cancel', authenticateToken, async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.user.id;

    if (STORAGE_MODE !== 'database') {
      return res.status(503).json({ error: 'Background jobs require database mode' });
    }

    // Verify job belongs to user and is cancellable
    const result = await dbPool.query(
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

    // Mark job as failed (cancelled)
    await dbPool.query(
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
      jobId: jobId
    });
  } catch (err) {
    log.error('Error cancelling job:', err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// Get user's story jobs
app.get('/api/jobs/my-jobs', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    if (STORAGE_MODE === 'database') {
      const result = await dbPool.query(
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

// Initialize and start server
// Initialize database or files based on mode
async function initialize() {
  // Load prompt templates first
  await loadPromptTemplates();

  if (STORAGE_MODE === 'database' && dbPool) {
    try {
      await initializeDatabase();
    } catch (err) {
      log.error('⚠️  Database initialization failed, falling back to file storage');
      await initializeDataFiles();
    }
  } else {
    await initializeDataFiles();
  }
}

// SPA fallback - serve index.html for client-side routing
// This must be the LAST route, after all API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api')) {
    return next();
  }

  // If dist folder exists, serve the built React app
  if (hasDistFolder) {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    // Fallback to legacy index.html
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

initialize().then(() => {
  app.listen(PORT, () => {
    log.debug(`\n=================================`);
    console.log(`🚀 MagicalStory Server Running`);
    log.debug(`=================================`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`💾 Storage: ${STORAGE_MODE.toUpperCase()}`);
    if (STORAGE_MODE === 'database') {
      // Parse DATABASE_URL to show host and database name
      try {
        const url = new URL(DATABASE_URL);
        const dbName = url.pathname.slice(1); // Remove leading /
        console.log(`🗄️  Database: ${url.hostname}/${dbName} (PostgreSQL)`);
      } catch (err) {
        console.log(`🗄️  Database: PostgreSQL (Railway)`);
      }
    } else {
      log.debug(`📝 Logs: data/logs.json`);
      log.debug(`👥 Users: data/users.json`);
    }
    log.debug(`=================================\n`);
  });
}).catch(err => {
  log.error('Failed to initialize server:', err);
  process.exit(1);
});
