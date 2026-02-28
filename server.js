// MagicalStory Backend Server v1.0.4
// Includes: User quota system, email authentication, admin panel, PostgreSQL database support

// Load environment variables from .env file (for local development)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
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

// Credit costs and pricing configuration (shared across route modules)
const { CREDIT_CONFIG, CREDIT_COSTS } = require('./server/config/credits');

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

// Helper: Get appropriate Stripe client for user (admins and impersonating admins get test mode)
function getStripeForUser(user) {
  if (isUserTestMode(user)) {
    return stripeTest || stripeLegacy;
  }
  return stripeLive || stripeTest || stripeLegacy; // fallback chain for live users
}

// Helper: Check if user should use test mode
// Admins AND impersonating admins use test mode (Gelato drafts, test Stripe)
function isUserTestMode(user) {
  return user?.role === 'admin' || user?.impersonating === true;
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
const { initializePool: initModularPool, logActivity, isDatabaseMode, saveStoryData, upsertStory, saveStoryImage, getStoryImage, setActiveVersion, rehydrateStoryImages } = require('./server/services/database');
const { validateBody, schemas, sanitizeString, sanitizeInteger } = require('./server/middleware/validation');
const { storyGenerationLimiter, imageRegenerationLimiter } = require('./server/middleware/rateLimit');
const { PROMPT_TEMPLATES, loadPromptTemplates, fillTemplate } = require('./server/services/prompts');
const { generatePrintPdf, generateViewPdf, generateCombinedBookPdf } = require('./server/lib/pdf');
const { processBookOrder, getCoverDimensions } = require('./server/lib/gelato');
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
  runFinalConsistencyChecks,
  generateReferenceSheet,
  buildVisualBibleGrid,
  IMAGE_QUALITY_THRESHOLD,
  // Separated evaluation pipeline functions
  generateImageOnly,
  evaluateImageBatch,
  buildRepairPlan,
  executeRepairPlan,
  mergeRepairResults,
  // Bbox detection for covers
  detectAllBoundingBoxes,
  createBboxOverlayImage
} = require('./server/lib/images');
const {
  runEntityConsistencyChecks
} = require('./server/lib/entityConsistency');
const {
  prepareStyledAvatars,
  applyStyledAvatars,
  collectAvatarRequirements,
  setStyledAvatar,
  clearStyledAvatarCache,
  invalidateStyledAvatarForCategory,
  getStyledAvatarCacheStats,
  exportStyledAvatarsForPersistence,
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog
} = require('./server/lib/styledAvatars');
const {
  getCostumedAvatarGenerationLog,
  clearCostumedAvatarGenerationLog
} = require('./server/routes/avatars');
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
  callClaudeAPI,
  evaluateTextConsistency
} = require('./server/lib/textModels');
const {
  MODEL_PRICING,
  calculateTextCost,
  calculateImageCost,
  formatCostSummary
} = require('./server/config/models');
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
  extractStoryTextFromOutput,
  linkPreDiscoveredLandmarks,
  injectHistoricalLocations,
  getElementReferenceImagesForPage
} = require('./server/lib/visualBible');
const {
  prefetchLandmarkPhotos,
  discoverLandmarksForLocation,
  // Indexed landmarks (works for any city worldwide)
  indexLandmarksForCities,
  indexLandmarksForCity,
  getIndexedLandmarksNearLocation,
  getIndexedLandmarks,
  getLandmarkIndexStats,
  getLandmarkPhotoOnDemand,
  SWISS_CITIES,
  // Lazy photo variant loading
  loadLandmarkPhotoDescriptions,
  loadLandmarkPhotoVariant
} = require('./server/lib/landmarkPhotos');

// Landmark discovery cache - stores pre-discovered landmarks per user location
// Key: `${city}_${country}` (normalized), Value: { landmarks: [], timestamp }
const userLandmarkCache = new Map();
const LANDMARK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week
const {
  ART_STYLES,
  LANGUAGE_LEVELS,
  getReadingLevel,
  getTokensPerPage,
  calculateStoryPageCount,
  getAgeCategory,
  getAgeCategoryLabel,
  getCharactersInScene,
  getCharacterPhotos,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildRelativeHeightDescription,
  buildCharacterReferenceList,
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  buildBasePrompt,
  buildStoryPrompt,
  buildSceneExpansionPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildUnifiedStoryPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForPage,
  getLandmarkPhotosForScene,
  extractSceneMetadata,
  stripSceneMetadata,
  getHistoricalLocations,
  convertClothingToCurrentFormat,
  getPageText,
  updatePageText
} = require('./server/lib/storyHelpers');
const { OutlineParser, UnifiedStoryParser, ProgressiveUnifiedParser } = require('./server/lib/outlineParser');
const { getActiveIndexAfterPush } = require('./server/lib/versionManager');
const legacyPipelines = require('./server/lib/legacyPipelines');
const { GenerationLogger } = require('./server/lib/generationLogger');
const { hasPhotos: hasCharacterPhotos, getFacePhoto } = require('./server/lib/characterPhotos');
const configRoutes = require('./server/routes/config');
const healthRoutes = require('./server/routes/health');
const authRoutes = require('./server/routes/auth');
const userRoutes = require('./server/routes/user');
const characterRoutes = require('./server/routes/characters');
const storyDraftRoutes = require('./server/routes/storyDraft');
const storiesRoutes = require('./server/routes/stories');
const filesRoutes = require('./server/routes/files');
const { adminRoutes, initAdminRoutes } = require('./server/routes/admin');
const photosRoutes = require('./server/routes/photos');
const avatarsRoutes = require('./server/routes/avatars');
const aiProxyRoutes = require('./server/routes/ai-proxy');
const regenerationRoutes = require('./server/routes/regeneration');
const printRoutes = require('./server/routes/print');
const { jobRoutes, initJobRoutes } = require('./server/routes/jobs');
const storyIdeasRoutes = require('./server/routes/storyIdeas');
const { apiRouter: sharingApiRoutes, htmlRouter: sharingHtmlRoutes, initSharingRoutes } = require('./server/routes/sharing');

/**
 * Build scene image objects for cover images to include in consistency checks.
 * Covers are assigned page numbers beyond the story pages:
 * - frontCover: totalPages + 1
 * - initialPage: totalPages + 2
 * - backCover: totalPages + 3
 *
 * @param {Object} coverImages - Cover images object with frontCover, initialPage, backCover
 * @param {Array} characters - Array of character objects from the story
 * @param {number} totalStoryPages - Number of story pages (to calculate cover page numbers)
 * @returns {Array} Array of scene image objects for covers
 */
function buildCoverSceneImages(coverImages, characters, totalStoryPages) {
  const coverSceneImages = [];

  const coverTypes = [
    { key: 'frontCover', offset: 1, label: 'Front Cover' },
    { key: 'initialPage', offset: 2, label: 'Initial Page' },
    { key: 'backCover', offset: 3, label: 'Back Cover' }
  ];

  for (const { key, offset, label } of coverTypes) {
    const cover = coverImages?.[key];
    if (!cover) continue;

    const imageData = cover.imageData;
    if (!imageData) continue;

    // Build retryHistory with bboxDetection if available (for entity consistency cropping)
    const retryHistory = [];
    if (cover.bboxDetection) {
      retryHistory.push({
        type: 'bbox_detection_only',
        bboxDetection: cover.bboxDetection,
        bboxOverlayImage: cover.bboxOverlayImage
      });
    }

    // Extract character names from the cover's reference photos if available
    const coverCharacters = cover.referencePhotos?.map(p => p.name).filter(Boolean) ||
                           characters.map(c => c.name);

    coverSceneImages.push({
      pageNumber: totalStoryPages + offset,
      imageData: imageData,
      characters: coverCharacters,
      clothing: 'standard',  // Covers use standard or costumed clothing
      characterClothing: {},  // Could be parsed from cover description if needed
      sceneSummary: `${label} - group scene with characters`,
      referenceCharacters: coverCharacters,
      referenceClothing: cover.referencePhotos?.reduce((acc, p) => {
        if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
        return acc;
      }, {}) || {},
      retryHistory
    });
  }

  return coverSceneImages;
}

/**
 * Run bbox detection on cover images to identify character positions.
 * This enables entity consistency checks to include covers.
 *
 * @param {Object} coverImages - Cover images object with frontCover, initialPage, backCover
 * @param {Array} characters - Array of character objects from the story
 * @returns {Promise<Object>} Updated coverImages with bboxDetection and bboxOverlayImage
 */
async function detectBboxOnCovers(coverImages, characters) {
  if (!coverImages) return coverImages;

  const coverTypes = ['frontCover', 'initialPage', 'backCover'];

  for (const coverType of coverTypes) {
    const cover = coverImages[coverType];
    if (!cover) continue;

    const imageData = cover.imageData;
    if (!imageData) continue;

    // Skip if already has bbox detection
    if (cover.bboxDetection) continue;

    // Use cover's referencePhotos (only the characters that appear on THIS cover)
    // Fall back to all characters if referencePhotos not available
    const coverCharacterNames = cover.referencePhotos
      ? cover.referencePhotos.map(p => p.name)
      : (characters || []).map(c => c.name);
    // Build detailed descriptions using full character physical info for better bbox matching
    const charLookup = new Map((characters || []).map(c => [c.name.toLowerCase(), c]));
    const expectedCharacters = coverCharacterNames.map(name => {
      const char = charLookup.get(name.toLowerCase());
      return {
        name,
        description: char ? buildCharacterPhysicalDescription(char) : 'character',
        position: null  // Covers don't have expected positions
      };
    });

    log.debug(`📦 [COVER BBOX] ${coverType}: expecting ${expectedCharacters.length} characters: ${expectedCharacters.map(c => c.name).join(', ')}`);

    try {
      log.debug(`📦 [COVER BBOX] Running bbox detection on ${coverType}...`);

      const bboxDetection = await detectAllBoundingBoxes(imageData, {
        expectedCharacters,
        expectedObjects: []
      });

      if (bboxDetection) {
        const bboxOverlayImage = await createBboxOverlayImage(imageData, bboxDetection);

        // Calculate missing characters (expected but not identified)
        const foundNames = new Set(
          (bboxDetection.figures || [])
            .map(f => f.name?.toLowerCase())
            .filter(n => n && n !== 'unknown')
        );
        const missingCharacters = expectedCharacters
          .filter(c => !foundNames.has(c.name.toLowerCase()))
          .map(c => c.name);

        // Add missing info to detection result
        bboxDetection.missingCharacters = missingCharacters;

        // Log results with warnings for missing characters
        const figCount = bboxDetection.figures?.length || 0;
        const identifiedCount = bboxDetection.figures?.filter(f => f.name && f.name !== 'UNKNOWN').length || 0;
        log.debug(`📦 [COVER BBOX] ${coverType}: detected ${figCount} figures, ${identifiedCount} identified`);

        if (missingCharacters.length > 0) {
          log.warn(`⚠️ [COVER BBOX] ${coverType}: MISSING CHARACTERS - ${missingCharacters.join(', ')}`);
        }

        // Update cover with bbox data
        cover.bboxDetection = bboxDetection;
        cover.bboxOverlayImage = bboxOverlayImage;
      }
    } catch (err) {
      log.warn(`⚠️ [COVER BBOX] Failed to detect bbox on ${coverType}: ${err.message}`);
    }
  }

  return coverImages;
}

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

// Default to file mode for safety - only use database if explicitly configured
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' && DATABASE_URL)
                     ? 'database'
                     : 'file';

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

  // Initialize the modular database service pool as well
  initModularPool();

  // Initialize legacy pipelines with server.js-local dependencies
  legacyPipelines.init({
    dbPool, log, email,
    saveCheckpoint, getCheckpoint, deleteJobCheckpoints, getAllCheckpoints,
    detectBboxOnCovers, buildCoverSceneImages,
    IMAGE_GEN_MODE, STORAGE_MODE, STORY_BATCH_SIZE
  });

  log.debug(`✓ Database pools initialized`);
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
      'http://localhost:5173',  // Vite dev server
      'http://localhost:5174',  // Vite dev server (alternate port)
      'http://localhost:5175',  // Vite dev server (alternate port)
      'http://127.0.0.1:8000',
      'http://127.0.0.1:5173',
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

// Gzip compression for all responses (reduces 33MB avatar data to ~5MB)
app.use(compression());

// Security headers with helmet
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP as it can interfere with inline scripts/styles
  crossOriginEmbedderPolicy: false, // Allow embedding external resources
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Required for Google OAuth popup
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow WhatsApp/Facebook crawlers to fetch OG images
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
          // Use centralized pricing config
          const amountPaid = fullSession.amount_total || 0; // in cents
          const creditsToAdd = Math.floor(amountPaid / CREDIT_CONFIG.PRICING.CENTS_PER_CREDIT);

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
          const orderBookFormat = fullSession.metadata?.bookFormat || 'square';

          // Validate required metadata
          if (!userId || isNaN(userId)) {
            log.error('❌ [STRIPE WEBHOOK] Invalid or missing userId in metadata:', fullSession.metadata);
            throw new Error('Invalid userId in session metadata');
          }

          // Look up user's preferred language for emails
          try {
            const langResult = await dbPool.query('SELECT preferred_language FROM users WHERE id = $1', [userId]);
            customerInfo.language = langResult.rows[0]?.preferred_language || 'English';
          } catch (langErr) {
            log.warn('⚠️ [STRIPE WEBHOOK] Failed to look up user language, defaulting to English:', langErr.message);
            customerInfo.language = 'English';
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

          // Credit tokens for book purchase: 10 per page (or 20 with 2x promo)
          const totalPages = parseInt(fullSession.metadata?.totalPages) || 0;
          let tokensToCredit = 0;
          if (totalPages > 0 && userId) {
            // Check for 2x promo multiplier
            const promoResult = await dbPool.query(
              "SELECT config_value FROM config WHERE config_key = 'token_promo_multiplier'"
            );
            const multiplier = promoResult.rows[0]?.config_value ? parseInt(promoResult.rows[0].config_value) : 1;
            const tokensPerPage = 10 * multiplier;
            tokensToCredit = totalPages * tokensPerPage;

            // Credit tokens to user
            await dbPool.query(
              'UPDATE users SET credits = credits + $1 WHERE id = $2',
              [tokensToCredit, userId]
            );

            // Record transaction
            const balanceResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
            await dbPool.query(`
              INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
              VALUES ($1, $2, $3, 'book_purchase_reward', $4, $5)
            `, [
              userId,
              tokensToCredit,
              balanceResult.rows[0]?.credits || tokensToCredit,
              fullSession.id,
              `Book purchase reward: ${totalPages} pages × ${tokensPerPage} tokens${multiplier > 1 ? ' (2x promo)' : ''}`
            ]);

            // Update order with tokens credited
            await dbPool.query(
              'UPDATE orders SET tokens_credited = $1 WHERE stripe_session_id = $2',
              [tokensToCredit, fullSession.id]
            );

            log.info(`💰 [STRIPE WEBHOOK] Credited ${tokensToCredit} tokens to user ${userId} for book purchase (${totalPages} pages × ${tokensPerPage})`);
          }

          log.debug('💾 [STRIPE WEBHOOK] Order saved to database');
          log.debug('   User ID:', userId);
          log.debug('   Story IDs:', validatedStoryIds.join(', '));
          if (tokensToCredit > 0) {
            log.debug('   Tokens credited:', tokensToCredit);
          }

          // Trigger background PDF generation and print provider order (don't await - fire and forget)
          // Pass isTestPayment so Gelato knows whether to create draft or real order
          // Now passing array of storyIds for combined book generation
          processBookOrder(dbPool, fullSession.id, userId, validatedStoryIds, customerInfo, address, isTestPayment, orderCoverType, orderBookFormat).catch(async (err) => {
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

          // Order confirmation email is now sent when Gelato validates the order (via webhook)
          // This prevents sending "Order Confirmed" followed by "Order Failed" if Gelato rejects
          // See Gelato webhook handler for 'passed' status

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
      let orderResult = await dbPool.query(
        'SELECT id, user_id, customer_email, customer_name, story_id FROM orders WHERE gelato_order_id = $1',
        [orderId]
      );

      // Fallback: if not found by gelato_order_id, try orderReferenceId which contains story ID
      // Format: "story-{storyId}-{timestamp}" or "story-multi-{count}-{storyId}-{timestamp}"
      if (orderResult.rows.length === 0 && orderReferenceId) {
        log.debug('📦 [GELATO WEBHOOK] Trying fallback lookup by orderReferenceId:', orderReferenceId);
        const storyIdMatch = orderReferenceId.match(/story-(?:multi-\d+-)?([^-]+)-\d+/);
        if (storyIdMatch) {
          const storyId = storyIdMatch[1];
          // Find recent order for this story that doesn't have a gelato_order_id yet
          orderResult = await dbPool.query(
            `SELECT id, user_id, customer_email, customer_name, story_id FROM orders
             WHERE story_id = $1 AND (gelato_order_id IS NULL OR gelato_order_id = $2)
             ORDER BY created_at DESC LIMIT 1`,
            [storyId, orderId]
          );

          if (orderResult.rows.length > 0) {
            // Update the order with the Gelato order ID for future webhooks
            await dbPool.query(
              'UPDATE orders SET gelato_order_id = $1, updated_at = NOW() WHERE id = $2',
              [orderId, orderResult.rows[0].id]
            );
            console.log('✅ [GELATO WEBHOOK] Linked order via story ID fallback:', orderResult.rows[0].id);
          }
        }
      }

      if (orderResult.rows.length === 0) {
        log.warn('⚠️ [GELATO WEBHOOK] Order not found for Gelato ID:', orderId, '| orderReferenceId:', orderReferenceId);
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
      // Note: Cast $1 to text in CASE comparisons to avoid PostgreSQL type inference error (42P08)
      if (trackingNumber) {
        await dbPool.query(`
          UPDATE orders
          SET gelato_status = $1,
              tracking_number = $2,
              tracking_url = $3,
              shipped_at = CASE WHEN $1::text = 'shipped' AND shipped_at IS NULL THEN NOW() ELSE shipped_at END,
              delivered_at = CASE WHEN $1::text = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $4
        `, [newStatus, trackingNumber, trackingUrl, orderId]);
      } else {
        await dbPool.query(`
          UPDATE orders
          SET gelato_status = $1,
              delivered_at = CASE WHEN $1::text = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $2
        `, [newStatus, orderId]);
      }

      console.log('✅ [GELATO WEBHOOK] Order status updated to:', newStatus);

      // Send order confirmation email when Gelato validates the order (passed or in_production)
      // This ensures customers only receive "Order Confirmed" after Gelato accepts the order
      if ((fulfillmentStatus === 'passed' || fulfillmentStatus === 'in_production') && order.customer_email) {
        try {
          // Check if confirmation email was already sent (idempotency)
          const emailCheck = await dbPool.query(
            'SELECT confirmation_email_sent, delivery_estimate_min, delivery_estimate_max, amount, currency, shipping_address FROM orders WHERE id = $1',
            [order.id]
          );
          const orderData = emailCheck.rows[0];

          if (!orderData?.confirmation_email_sent) {
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

            // Parse shipping address
            const shippingAddress = typeof orderData.shipping_address === 'string'
              ? JSON.parse(orderData.shipping_address)
              : orderData.shipping_address;

            await email.sendOrderConfirmationEmail(
              order.customer_email,
              order.customer_name,
              {
                orderId: orderId.substring(0, 8).toUpperCase(),
                amount: orderData.amount ? (orderData.amount / 100).toFixed(2) : '0.00',
                currency: (orderData.currency || 'CHF').toUpperCase(),
                shippingAddress: shippingAddress,
                deliveryEstimateMin: orderData.delivery_estimate_min,
                deliveryEstimateMax: orderData.delivery_estimate_max
              },
              language
            );

            // Mark confirmation email as sent (prevent duplicates)
            await dbPool.query(
              'UPDATE orders SET confirmation_email_sent = TRUE WHERE id = $1',
              [order.id]
            );

            console.log('📧 [GELATO WEBHOOK] Order confirmation email sent to:', order.customer_email);
          } else {
            log.debug('📧 [GELATO WEBHOOK] Confirmation email already sent for order:', order.id);
          }
        } catch (emailErr) {
          log.error('❌ [GELATO WEBHOOK] Failed to send confirmation email:', emailErr.message);
        }
      }

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
              orderId: orderId.substring(0, 8).toUpperCase(),
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

    // Handle delivery estimate updates from Gelato
    if (event.event === 'order_delivery_estimate_updated') {
      const { orderId, minDeliveryDate, maxDeliveryDate } = event;

      log.debug('📦 [GELATO WEBHOOK] Delivery estimate update for order:', orderId);
      log.debug('   Min delivery:', minDeliveryDate);
      log.debug('   Max delivery:', maxDeliveryDate);

      // Find the order
      const orderResult = await dbPool.query(
        'SELECT id, user_id FROM orders WHERE gelato_order_id = $1',
        [orderId]
      );

      if (orderResult.rows.length > 0) {
        const order = orderResult.rows[0];

        // Store delivery estimates in database
        await dbPool.query(`
          UPDATE orders
          SET delivery_estimate_min = $1,
              delivery_estimate_max = $2,
              updated_at = NOW()
          WHERE gelato_order_id = $3
        `, [minDeliveryDate || null, maxDeliveryDate || null, orderId]);

        console.log('✅ [GELATO WEBHOOK] Delivery estimate stored for order:', order.id);

        // Log activity
        await logActivity(order.user_id, null, 'DELIVERY_ESTIMATE_UPDATED', {
          orderId: order.id,
          gelatoOrderId: orderId,
          minDeliveryDate,
          maxDeliveryDate
        });
      } else {
        log.warn('⚠️ [GELATO WEBHOOK] Order not found for delivery estimate update:', orderId);
      }
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

// Protection against malformed URL attacks (e.g. /%c0 path traversal probes)
app.use((req, res, next) => {
  try {
    decodeURIComponent(req.path);
    next();
  } catch (e) {
    log.warn(`🛡️ Blocked malformed URL: ${req.path}`);
    res.status(400).send('Bad Request');
  }
});

// Fast health check - BEFORE static files for quick Railway health checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static files
// Priority: 1. Built React app (dist/), 2. Images folder, 3. Legacy HTML files
const distPath = path.join(__dirname, 'dist');
const hasDistFolder = require('fs').existsSync(distPath);

// Initialize sharing routes with dist folder config
initSharingRoutes({ distPath, hasDistFolder });

// Initialize job routes with server.js-local dependencies
initJobRoutes({ processStoryJob, getCheckpoint, getAllCheckpoints });

// Initialize admin routes with server.js-local dependencies
initAdminRoutes({ processStoryJob, userLandmarkCache });

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
app.use('/api/stories', regenerationRoutes);  // Image/scene/cover regeneration & repair
app.use('/api/files', filesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/photos', photosRoutes);
app.use('/api', avatarsRoutes);  // /api/analyze-photo, /api/avatar-prompt, /api/generate-clothing-avatars
app.use('/api', aiProxyRoutes);  // /api/claude, /api/gemini
app.use('/api', printRoutes);  // Print provider, PDF generation, Stripe payments, pricing
app.use('/api/jobs', jobRoutes);  // Job creation, status, cancellation, checkpoints
app.use('/api', storyIdeasRoutes);  // Story idea generation
app.use('/api', sharingApiRoutes);  // /api/shared/* (public story data, images, OG image)
app.use('/', sharingHtmlRoutes);  // /s/:shareToken, /shared/:shareToken (HTML)

console.log('📦 Modular routes loaded: config, health, auth, user, characters, story-draft, stories, files, admin, photos, sharing');

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

    // Story sharing columns (migration for existing tables)
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS is_shared BOOLEAN DEFAULT FALSE`);
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS share_token VARCHAR(255)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_share_token ON stories(share_token) WHERE share_token IS NOT NULL`);

    // Image version metadata column (migration for existing tables)
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS image_version_meta JSONB DEFAULT '{}'`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_image_version_meta ON stories USING GIN (image_version_meta)`);

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

    // Add idempotency_key column for preventing duplicate job creation
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='story_jobs' AND column_name='idempotency_key') THEN
          ALTER TABLE story_jobs ADD COLUMN idempotency_key VARCHAR(100);
        END IF;
      END $$;
    `);
    // Create unique index on user_id + idempotency_key (only where key is not null)
    await dbPool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_story_jobs_idempotency
      ON story_jobs(user_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
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

    // Add created_at column if missing (for tables created before this column existed)
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='story_job_checkpoints' AND column_name='created_at') THEN
          ALTER TABLE story_job_checkpoints ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);

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

    // Note: discovered_landmarks table is deprecated - all landmarks now in landmark_index
    // The table will be dropped after migration (see below)

    // Landmark index - pre-indexed landmarks for ANY city worldwide
    // Stores metadata + AI description, photos fetched on-demand
    // Renamed from swiss_landmarks to support global coverage
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS landmark_index (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        wikipedia_page_id INT,
        wikidata_qid VARCHAR(20),
        lang VARCHAR(10),

        -- Location
        latitude DECIMAL(10, 7),
        longitude DECIMAL(10, 7),
        nearest_city VARCHAR(100),
        country VARCHAR(100),
        region VARCHAR(50),

        -- Classification
        type VARCHAR(50),
        boost_amount INT DEFAULT 0,
        categories TEXT[],

        -- Photo metadata (NOT the actual photo - fetched on demand)
        photo_url TEXT,
        photo_attribution TEXT,
        photo_source VARCHAR(50),

        -- AI-analyzed description (the valuable cached part)
        photo_description TEXT,

        -- Scoring
        commons_photo_count INT DEFAULT 0,
        score INT DEFAULT 0,

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        UNIQUE(wikidata_qid)
      )
    `);

    // Migration: rename swiss_landmarks to landmark_index if exists
    await dbPool.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'swiss_landmarks')
           AND NOT EXISTS (SELECT FROM pg_tables WHERE tablename = 'landmark_index') THEN
          -- Rename table
          ALTER TABLE swiss_landmarks RENAME TO landmark_index;
          -- Add country column if missing
          ALTER TABLE landmark_index ADD COLUMN IF NOT EXISTS country VARCHAR(100);
          -- Rename canton to region
          IF EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'landmark_index' AND column_name = 'canton') THEN
            ALTER TABLE landmark_index RENAME COLUMN canton TO region;
          END IF;
          -- Rename indexes
          IF EXISTS (SELECT FROM pg_indexes WHERE indexname = 'idx_swiss_landmarks_location') THEN
            ALTER INDEX idx_swiss_landmarks_location RENAME TO idx_landmark_index_location;
          END IF;
          IF EXISTS (SELECT FROM pg_indexes WHERE indexname = 'idx_swiss_landmarks_city') THEN
            ALTER INDEX idx_swiss_landmarks_city RENAME TO idx_landmark_index_city;
          END IF;
          IF EXISTS (SELECT FROM pg_indexes WHERE indexname = 'idx_swiss_landmarks_type') THEN
            ALTER INDEX idx_swiss_landmarks_type RENAME TO idx_landmark_index_type;
          END IF;
          -- Set country to Switzerland for existing records
          UPDATE landmark_index SET country = 'Switzerland' WHERE country IS NULL;
        END IF;
      END $$;
    `).catch(() => {}); // Ignore if already migrated

    // Add photo columns (3 exterior + 3 interior = 6 variants total)
    await dbPool.query(`
      ALTER TABLE landmark_index
      ADD COLUMN IF NOT EXISTS photo_url_2 TEXT,
      ADD COLUMN IF NOT EXISTS photo_attribution_2 TEXT,
      ADD COLUMN IF NOT EXISTS photo_description_2 TEXT,
      ADD COLUMN IF NOT EXISTS photo_url_3 TEXT,
      ADD COLUMN IF NOT EXISTS photo_attribution_3 TEXT,
      ADD COLUMN IF NOT EXISTS photo_description_3 TEXT,
      ADD COLUMN IF NOT EXISTS photo_url_4 TEXT,
      ADD COLUMN IF NOT EXISTS photo_attribution_4 TEXT,
      ADD COLUMN IF NOT EXISTS photo_description_4 TEXT,
      ADD COLUMN IF NOT EXISTS photo_url_5 TEXT,
      ADD COLUMN IF NOT EXISTS photo_attribution_5 TEXT,
      ADD COLUMN IF NOT EXISTS photo_description_5 TEXT,
      ADD COLUMN IF NOT EXISTS photo_url_6 TEXT,
      ADD COLUMN IF NOT EXISTS photo_attribution_6 TEXT,
      ADD COLUMN IF NOT EXISTS photo_description_6 TEXT,
      ADD COLUMN IF NOT EXISTS wikipedia_extract TEXT
    `).catch(() => {});  // Ignore if columns already exist

    // Indexes for landmark_index
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS idx_landmark_index_location
      ON landmark_index(latitude, longitude)
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS idx_landmark_index_city
      ON landmark_index(LOWER(nearest_city))
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS idx_landmark_index_type
      ON landmark_index(type)
    `);
    await dbPool.query(`
      CREATE INDEX IF NOT EXISTS idx_landmark_index_country
      ON landmark_index(LOWER(country))
    `);

    // Drop obsolete discovered_landmarks table (now unified in landmark_index)
    await dbPool.query(`DROP TABLE IF EXISTS discovered_landmarks`).catch(() => {});

    console.log('✓ Database tables initialized');

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

// Delete all checkpoints for a job (call after job completes)
async function deleteJobCheckpoints(jobId) {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    const result = await dbPool.query(
      'DELETE FROM story_job_checkpoints WHERE job_id = $1',
      [jobId]
    );
    if (result.rowCount > 0) {
      log.debug(`🧹 Deleted ${result.rowCount} checkpoints for job ${jobId}`);
    }
  } catch (err) {
    log.error(`❌ Failed to delete checkpoints for job ${jobId}:`, err.message);
  }
}

// Clean up old completed/failed jobs (call when new job starts)

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    log.warn(`🔐 [AUTH] No token provided for ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      log.warn(`🔐 [AUTH] Token verification failed for ${req.method} ${req.path}: ${err.message}`);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// Trigger landmark discovery early (called when user enters wizard or gets location)
// This runs in background so landmarks are ready when story generation starts
app.post('/api/landmarks/discover', async (req, res) => {
  try {
    const { city, country } = req.body;

    if (!city) {
      return res.json({ status: 'skipped', reason: 'no city provided' });
    }

    const cacheKey = `${city}_${country || ''}`.toLowerCase().replace(/\s+/g, '_');

    // Check if we already have landmarks in landmark_index
    try {
      const indexedLandmarks = await getIndexedLandmarks(city, 1);  // Just check if any exist
      if (indexedLandmarks.length > 0) {
        // Count total landmarks for this city
        const countResult = await dbPool.query(
          'SELECT COUNT(*) as count FROM landmark_index WHERE LOWER(nearest_city) = LOWER($1)',
          [city]
        );
        const landmarkCount = parseInt(countResult.rows[0].count);
        log.debug(`[LANDMARK] Already have ${landmarkCount} indexed landmarks for ${city}`);
        return res.json({
          status: 'indexed',
          landmarkCount,
          source: 'landmark_index'
        });
      }
    } catch (dbErr) {
      log.debug(`[LANDMARK] Index check failed: ${dbErr.message}`);
    }

    // Check in-memory cache
    const cachedLandmarks = userLandmarkCache.get(cacheKey);
    if (cachedLandmarks && Date.now() - cachedLandmarks.timestamp < LANDMARK_CACHE_TTL) {
      log.debug(`[LANDMARK] Already have ${cachedLandmarks.landmarks.length} cached landmarks for ${city}`);
      return res.json({
        status: 'cached',
        landmarkCount: cachedLandmarks.landmarks.length,
        source: 'memory_cache'
      });
    }

    // Trigger discovery in background (don't await)
    log.info(`[LANDMARK] 🔍 Early discovery triggered for ${city}, ${country || ''}`);

    discoverLandmarksForLocation(city, country || '')
      .then(async landmarks => {
        // Update in-memory cache
        userLandmarkCache.set(cacheKey, {
          landmarks,
          city,
          country: country || '',
          timestamp: Date.now()
        });
        log.info(`[LANDMARK] ✅ Early discovery: found ${landmarks.length} landmarks for ${city}`);
      })
      .catch(err => {
        log.error(`[LANDMARK] Early discovery failed for ${city}: ${err.message}`);
      });

    // Return immediately - discovery runs in background
    res.json({ status: 'discovering', city, country: country || '' });

  } catch (err) {
    log.error('Landmark discovery trigger error:', err);
    res.status(500).json({ error: err.message });
  }
});
// Edit page text, scene description, or image directly
app.patch('/api/stories/:id/page/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { text, sceneDescription, imageData } = req.body;
    const pageNumber = parseInt(pageNum);

    if (!text && !sceneDescription && !imageData) {
      return res.status(400).json({ error: 'Provide text, sceneDescription, or imageData to update' });
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
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from story_images table (images may be stripped from data blob)
    // Needed for imageData updates (reverting repairs)
    if (imageData !== undefined) {
      storyData = await rehydrateStoryImages(id, storyData);
    }

    // Update page text if provided
    if (text !== undefined) {
      storyData.storyText = updatePageText(storyData.storyText, pageNumber, text);
    }

    // Update scene description if provided
    if (sceneDescription !== undefined) {
      let sceneDescriptions = storyData.sceneDescriptions || [];
      const existingIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);

      // Extract translatedSummary from JSON for easy access
      const { extractSceneMetadata } = require('./server/lib/storyHelpers');
      const metadata = extractSceneMetadata(sceneDescription);
      const translatedSummary = metadata?.translatedSummary || null;
      const imageSummary = metadata?.imageSummary || null;

      const sceneEntry = {
        pageNumber,
        description: sceneDescription,
        translatedSummary,
        imageSummary
      };

      if (existingIndex >= 0) {
        sceneDescriptions[existingIndex] = { ...sceneDescriptions[existingIndex], ...sceneEntry };
      } else {
        sceneDescriptions.push(sceneEntry);
        sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
      }
      storyData.sceneDescriptions = sceneDescriptions;
    }

    // Update image if provided (admin only - used for reverting repairs)
    if (imageData !== undefined) {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can update images directly' });
      }
      let sceneImages = storyData.sceneImages || [];
      const imageIndex = sceneImages.findIndex(s => s.pageNumber === pageNumber);

      if (imageIndex >= 0) {
        sceneImages[imageIndex].imageData = imageData;
        sceneImages[imageIndex].wasAutoRepaired = false;  // Mark as reverted
        log.info(`🔄 [REVERT] Image reverted for page ${pageNumber} of story ${id}`);
      } else {
        return res.status(404).json({ error: `No image found for page ${pageNumber}` });
      }
      storyData.sceneImages = sceneImages;
    }

    // Save updated story with metadata
    await saveStoryData(id, storyData);

    console.log(`✅ Page ${pageNumber} updated for story ${id}`);

    res.json({
      success: true,
      pageNumber,
      updated: { text: text !== undefined, sceneDescription: sceneDescription !== undefined, imageData: imageData !== undefined }
    });

  } catch (err) {
    log.error('Error editing page:', err);
    res.status(500).json({ error: 'Failed to edit page: ' + err.message });
  }
});
// ===================================
// BACKGROUND STORY GENERATION JOBS
// ===================================

// NOTE: Config and parser functions moved to server/lib/storyHelpers.js
// Exports: ART_STYLES, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage,
// extractCoverScenes, buildSceneDescriptionPrompt, parseStoryPages, extractShortSceneDescriptions

// ============================================================================
// UNIFIED STORY GENERATION
// Single prompt generates complete story, Art Director expands scenes, then images
// ============================================================================
async function processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableAutoRepair = false, useGridRepair = true, enableFinalChecks = false, incrementalConsistencyConfig = null, checkOnlyMode = false, enableSceneValidation = false, separatedEvaluation = false, enableQualityRetry = true) {
  const timingStart = Date.now();
  log.debug(`📖 [UNIFIED] Starting unified story generation for job ${jobId}`);

  // Debug: Log inputData values at start of unified processing
  log.debug(`📝 [UNIFIED INPUT] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"`);
  log.debug(`📝 [UNIFIED INPUT] mainCharacters: ${JSON.stringify(inputData.mainCharacters)}, characters count: ${inputData.characters?.length || 0}`);

  // Timing tracker for all stages
  const timing = {
    start: timingStart,
    storyGenStart: null,
    storyGenEnd: null,
    coversStart: null,
    coversEnd: null,
    pagesStart: null,
    pagesEnd: null,
    end: null
  };

  // Clear avatar generation logs for fresh tracking
  clearStyledAvatarGenerationLog();
  clearCostumedAvatarGenerationLog();

  // Generation logger for debugging
  const genLog = new GenerationLogger();
  genLog.setStage('outline');

  // Token usage tracker - same structure as other modes
  const tokenUsage = {
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // Runware uses direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    byFunction: {
      unified_story: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_expansion: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Avatar generation tracking
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Consistency check tracking
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      // Scene rewrite tracking (when safety blocks trigger rewrites)
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Fallback pricing by provider (uses centralized MODEL_PRICING from server/config/models.js)
  // Note: gemini_image uses per-image pricing, not token pricing - see calculateImageCost
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  // Helper to calculate image generation cost (per-image pricing, not token-based)
  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) {
      return pricing.perImage * imageCount;
    }
    // Fallback to default Gemini image pricing
    return 0.04 * imageCount;
  };

  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
      tokenUsage[provider].calls += 1;
    }
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage?.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage?.output_tokens || 0;
      tokenUsage.byFunction[functionName].thinking_tokens += usage?.thinking_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      tokenUsage.byFunction[functionName].provider = provider;
      if (modelName) tokenUsage.byFunction[functionName].models.add(modelName);
    }
  };

  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  // Calculate scene count based on layout:
  // - Picture Book (1st-grade): 1 scene per page (image + text combined)
  // - Standard/Advanced: 1 scene per 2 pages (text page + image page)
  const isPictureBookLayout = inputData.languageLevel === '1st-grade';
  const sceneCount = isPictureBookLayout ? inputData.pages : Math.floor(inputData.pages / 2);
  const lang = inputData.language || 'en';
  log.debug(`📖 [UNIFIED] Input: ${inputData.pages} pages, level: ${inputData.languageLevel}, layout: ${isPictureBookLayout ? 'Picture Book' : 'Standard'} → ${sceneCount} scenes`);
  const { getLanguageNameEnglish } = require('./server/lib/languages');
  const langText = getLanguageNameEnglish(lang);

  try {
    // PHASE 1: Generate complete story with unified prompt
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [5, 'Starting story generation...', jobId]
    );

    const unifiedPrompt = buildUnifiedStoryPrompt(inputData, sceneCount);
    log.debug(`📖 [UNIFIED] Prompt length: ${unifiedPrompt.length} chars, requesting ${sceneCount} pages`);

    // Art style for avatar generation
    const artStyle = inputData.artStyle || 'pixar';

    // Track streaming progress and parallel tasks
    let streamingTitle = null;
    let streamingClothingRequirements = null;
    let streamingVisualBible = null;
    let streamingCoverHints = null;
    let streamingPagesDetected = 0;
    let lastProgressUpdate = Date.now();
    let landmarkDescriptionsPromise = null; // Promise for loading landmark photo descriptions
    let streamingAvatarStylingPromise = null; // Promise for early avatar styling (started when clothing requirements ready)

    // Track parallel tasks started during streaming
    const streamingSceneExpansionPromises = new Map(); // pageNum -> promise
    const streamingCoverPromises = new Map(); // coverType -> promise
    const streamingExpandedPages = new Map(); // pageNum -> page data (for scene expansion)
    let coversStartedDuringStreaming = false;

    // Rate limiters for streaming tasks (aggressive parallelism)
    const streamSceneLimit = pLimit(10);   // Scene expansions are text-only, can parallelize heavily
    const streamCoverLimit = pLimit(3);    // Only 3 covers total anyway

    // NOTE: Avatar generation removed from streaming. Avatars should exist before story starts.

    // Helper: Start scene expansion for a page
    const startSceneExpansion = (page) => {
      if (streamingSceneExpansionPromises.has(page.pageNumber)) return;

      // Need visual bible for scene expansion - queue if not available yet
      const expansionPromise = streamSceneLimit(async () => {
        // Wait for visual bible if not yet available
        while (!streamingVisualBible) {
          await new Promise(r => setTimeout(r, 100));
        }

        // Wait for landmark photo descriptions to be loaded (so variants are in the prompt)
        if (landmarkDescriptionsPromise) {
          await landmarkDescriptionsPromise;
        }

        // Always detect characters from scene text (reliable, not dependent on streaming completeness)
        let sceneCharacters = getCharactersInScene(
          (page.sceneHint || '') + '\n' + (page.text || ''),
          inputData.characters
        );
        // Also include any characters from clothing parsing that text matching might have missed
        if (page.characters && page.characters.length > 0) {
          const allChars = inputData.characters || [];
          for (const parsed of page.characters) {
            const parsedLower = parsed.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim();
            const match = allChars.find(char => {
              if (!char.name) return false;
              const nameLower = char.name.toLowerCase().trim();
              const firstName = nameLower.split(' ')[0];
              return parsedLower === nameLower || parsedLower === firstName;
            });
            if (match && !sceneCharacters.some(sc => sc.name === match.name)) {
              sceneCharacters.push(match);
            }
          }
        }

        // SIMPLE: Get raw outline blocks directly from parser (no parsing/reconstruction needed)
        // Previous pages = raw outline blocks for pages N-2 and N-1
        // Current page = raw outline block for page N
        const prevPageNumbers = [];
        for (let p = page.pageNumber - 2; p < page.pageNumber; p++) {
          if (p >= 1) prevPageNumbers.push(p);
        }
        const rawOutlineContext = {
          previousPages: progressiveParser.getRawPageBlocks(prevPageNumbers),
          currentPage: progressiveParser.getRawPageBlock(page.pageNumber)
        };

        log.debug(`⚡ [STREAM-SCENE] Page ${page.pageNumber} starting expansion (prev: ${prevPageNumbers.join(',') || 'none'})`);

        // Build available avatars string - only show clothing categories used in this story
        const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters, streamingClothingRequirements);

        // Initial expansion: simplified prompt, no preview feedback (fast/cheap)
        const expansionPrompt = buildSceneExpansionPrompt(
          page.pageNumber,
          page.text,
          sceneCharacters,
          lang,
          streamingVisualBible,
          availableAvatars,
          rawOutlineContext // pass raw outline blocks directly
        );

        const expansionResult = await callTextModelStreaming(expansionPrompt, 10000, null, modelOverrides.sceneDescriptionModel, { prefill: '{"scene":{' });
        const expansionProvider = expansionResult.provider === 'google' ? 'gemini_text' : 'anthropic';
        addUsage(expansionProvider, expansionResult.usage, 'scene_expansion', expansionResult.modelId);

        log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} scene expanded`);
        genLog.info('scene_expanded', `Page ${page.pageNumber} scene expanded`, null, { pageNumber: page.pageNumber, model: expansionResult.modelId });

        // Post-expansion validation: validate and repair scene composition if enabled
        let finalSceneDescription = expansionResult.text;
        if (enableSceneValidation) {
          try {
            const { validateAndRepairScene, isValidationAvailable } = require('./server/lib/sceneValidator');
            const { extractSceneMetadata } = require('./server/lib/storyHelpers');
            const sceneMetadata = extractSceneMetadata(expansionResult.text);

            if (sceneMetadata && isValidationAvailable()) {
              log.debug(`🔍 [STREAM-SCENE] Page ${page.pageNumber} running composition validation...`);
              const validationResult = await validateAndRepairScene(sceneMetadata);

              // Track validation costs
              if (validationResult.usage) {
                if (validationResult.usage.previewCost) {
                  addUsage('runware', { cost: validationResult.usage.previewCost }, 'scene_validation_preview');
                }
                if (validationResult.usage.visionCost || validationResult.usage.comparisonCost) {
                  addUsage('gemini_text', {
                    promptTokenCount: (validationResult.usage.visionTokens || 0) + (validationResult.usage.comparisonTokens || 0),
                    candidatesTokenCount: 0
                  }, 'scene_validation_analysis');
                }
                if (validationResult.repair?.usage) {
                  addUsage('anthropic', validationResult.repair.usage, 'scene_validation_repair');
                }
              }

              if (validationResult.wasRepaired) {
                log.info(`🔧 [STREAM-SCENE] Page ${page.pageNumber} scene repaired: ${validationResult.repair.fixes.length} fixes applied`);
                finalSceneDescription = JSON.stringify(validationResult.finalScene);
              } else if (!validationResult.validation.passesCompositionCheck) {
                log.warn(`⚠️  [STREAM-SCENE] Page ${page.pageNumber} has composition issues but repair failed`);
              } else {
                log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} passes composition check`);
              }
            }
          } catch (err) {
            log.warn(`⚠️  [STREAM-SCENE] Page ${page.pageNumber} validation failed: ${err.message}`);
            // Continue with original scene description
          }
        }

        return {
          pageNumber: page.pageNumber,
          text: page.text,
          sceneHint: page.sceneHint,
          sceneDescription: finalSceneDescription,
          sceneDescriptionPrompt: expansionPrompt,
          sceneDescriptionModelId: expansionResult.modelId,
          characterClothing: page.characterClothing,
          characters: page.characters
        };
      });

      streamingSceneExpansionPromises.set(page.pageNumber, expansionPromise);
      log.debug(`⚡ [STREAM-SCENE] Started expansion for page ${page.pageNumber}`);
    };

    // Helper: Start cover generation
    const startCoverGeneration = (coverType, hint) => {
      if (streamingCoverPromises.has(coverType) || skipImages || skipCovers) return;

      const coverPromise = streamCoverLimit(async () => {
        // Wait for visual bible if not yet available
        while (!streamingVisualBible) {
          await new Promise(r => setTimeout(r, 100));
        }

        // Build per-character clothing requirements from hint.characterClothing
        // hint.characterClothing = { 'Manuel': 'winter', 'Sophie': 'standard', 'Roger': 'costumed:knight' }
        let sceneDescription = hint.hint || hint.scene || '';

        // Fallback: If scene description is empty or too short, generate a meaningful one
        if (!sceneDescription || sceneDescription.length < 20) {
          const mainCharNames = inputData.characters
            .filter(c => c.isMainCharacter)
            .map(c => c.name)
            .join(', ') || inputData.characters.map(c => c.name).slice(0, 3).join(', ');
          const theme = inputData.storyTheme || inputData.storyTopic || 'adventure';

          if (coverType === 'titlePage') {
            sceneDescription = `A magical, eye-catching front cover scene featuring ${mainCharNames} in a ${theme}-themed setting. The main characters are prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`;
          } else if (coverType === 'initialPage') {
            sceneDescription = `A warm, inviting introduction scene showing ${mainCharNames} at the beginning of their ${theme} story. A cozy atmosphere that welcomes readers into the adventure.`;
          } else {
            sceneDescription = `A satisfying conclusion scene showing ${mainCharNames} after their ${theme} adventure. They look happy and content, with visual elements reflecting how the story ended.`;
          }
          log.debug(`📕 [COVER] ${coverType}: Using fallback scene description (hint was empty)`);
        }

        let coverCharacters = getCharactersInScene(sceneDescription, inputData.characters);

        // Fallback: if scene description doesn't contain character names, use characters from hint.characterClothing
        // This handles cases like "Two brothers stand..." where names aren't in the description but ARE in the character list
        if (coverCharacters.length === 0 && hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          const clothingCharNames = Object.keys(hint.characterClothing);
          coverCharacters = inputData.characters.filter(c =>
            clothingCharNames.some(name => name.toLowerCase() === c.name.toLowerCase())
          );
          if (coverCharacters.length > 0) {
            log.debug(`📕 [COVER] ${coverType}: Using ${coverCharacters.length} characters from hint.characterClothing (scene didn't contain names)`);
          }
        }

        // Final fallback for title page: use main characters or all characters
        if (coverCharacters.length === 0 && coverType === 'titlePage') {
          // Try isMainCharacter property first
          let mainChars = inputData.characters.filter(c => c.isMainCharacter === true);

          // Fallback: use mainCharacters array of IDs from input (e.g., [1767791620341, 1767793922148])
          if (mainChars.length === 0 && inputData.mainCharacters && inputData.mainCharacters.length > 0) {
            mainChars = inputData.characters.filter(c => inputData.mainCharacters.includes(c.id));
            if (mainChars.length > 0) {
              log.debug(`📕 [COVER] ${coverType}: Found ${mainChars.length} main characters by ID lookup`);
            }
          }

          coverCharacters = mainChars.length > 0 ? mainChars : inputData.characters;
          log.debug(`📕 [COVER] ${coverType}: Using ${mainChars.length > 0 ? 'main' : 'all'} ${coverCharacters.length} characters (no names found in hint)`);
        }

        // Build coverClothingRequirements with _currentClothing for per-character lookup
        const coverClothingRequirements = {};
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          for (const [charName, clothing] of Object.entries(hint.characterClothing)) {
            coverClothingRequirements[charName] = { _currentClothing: clothing };
          }
          log.debug(`🎨 [COVER] ${coverType}: Using per-character clothing: ${JSON.stringify(hint.characterClothing)}`);
        }

        // Merge with streamingClothingRequirements (cover-specific takes precedence)
        // IMPORTANT: Convert streamingClothingRequirements to _currentClothing format for characters
        // not explicitly mentioned in cover hint, so they use the story's costume (not 'standard')
        const mergedClothingRequirements = convertClothingToCurrentFormat(streamingClothingRequirements);

        // Then overlay cover-specific clothing (takes precedence)
        for (const [charName, data] of Object.entries(coverClothingRequirements)) {
          if (!mergedClothingRequirements[charName]) {
            mergedClothingRequirements[charName] = data;
          } else {
            mergedClothingRequirements[charName] = { ...mergedClothingRequirements[charName], ...data };
          }
        }

        // Default clothing category (used if no per-character clothing specified)
        const defaultClothingCategory = 'standard';
        let effectiveCategory = defaultClothingCategory;
        let costumeType = null;

        // Cap characters at 5 — more than 5 almost always produces bad results
        // Main characters appear on ALL covers, non-main are split across initial/back
        const MAX_COVER_CHARACTERS = 5;
        let charactersForCover;
        if (coverCharacters.length > 0) {
          // Scene description contained character names - use exactly those
          charactersForCover = coverCharacters.length > MAX_COVER_CHARACTERS
            ? coverCharacters.slice(0, MAX_COVER_CHARACTERS)
            : coverCharacters;
        } else if (coverType !== 'titlePage') {
          // initialPage/backCover without scene-based characters: distribute across covers
          const allChars = inputData.characters || [];
          let mainChars = allChars.filter(c => c.isMainCharacter === true);
          // Fallback: use mainCharacters array of IDs (same as titlePage logic)
          if (mainChars.length === 0 && inputData.mainCharacters?.length > 0) {
            mainChars = allChars.filter(c => inputData.mainCharacters.includes(c.id));
          }
          const nonMainChars = mainChars.length > 0
            ? allChars.filter(c => !c.isMainCharacter)
            : allChars;
          const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
          const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
          const halfPoint = Math.ceil(nonMainChars.length / 2);
          let extras;
          if (coverType === 'initialPage') {
            extras = nonMainChars.slice(0, halfPoint).slice(0, extraSlots);
          } else {
            // backCover gets the second half
            extras = nonMainChars.slice(halfPoint).slice(0, extraSlots);
          }
          charactersForCover = [...mainCapped, ...extras];
          log.debug(`📕 [COVER] ${coverType}: ${charactersForCover.map(c => c.name).join(', ')} (${mainCapped.length} main + ${extras.length} extras, capped at ${MAX_COVER_CHARACTERS})`);
        } else {
          // titlePage without characters (shouldn't happen due to earlier fallbacks)
          charactersForCover = coverCharacters;
        }

        // Get character photos with clothing - per-character clothing from mergedClothingRequirements takes precedence
        let coverPhotos = getCharacterPhotoDetails(
          charactersForCover,
          effectiveCategory,
          costumeType,
          artStyle,
          mergedClothingRequirements
        );
        coverPhotos = applyStyledAvatars(coverPhotos, artStyle);

        // Build cover prompt using proper templates (not generic buildImagePrompt)
        const styleDescription = ART_STYLES[artStyle] || ART_STYLES.pixar;
        const visualBibleText = streamingVisualBible ? buildFullVisualBiblePrompt(streamingVisualBible, { skipMainCharacters: true }) : '';
        const characterRefList = buildCharacterReferenceList(coverPhotos, inputData.characters);

        let coverPrompt;
        if (coverType === 'titlePage') {
          // Front cover: include title for text rendering
          const storyTitle = streamingTitle || inputData.title || 'My Story';
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: characterRefList,
            VISUAL_BIBLE: visualBibleText
          });
        } else if (coverType === 'initialPage') {
          // Initial page: with or without dedication
          coverPrompt = inputData.dedication && inputData.dedication.trim()
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                DEDICATION: inputData.dedication,
                CHARACTER_REFERENCE_LIST: characterRefList,
                VISUAL_BIBLE: visualBibleText
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: characterRefList,
                VISUAL_BIBLE: visualBibleText
              });
        } else {
          // Back cover
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: characterRefList,
            VISUAL_BIBLE: visualBibleText
          });
        }

        const coverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
        const coverLabel = coverType === 'titlePage' ? 'FRONT COVER' : coverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';

        // Get landmark photos for cover scene (same as regular pages)
        // Cover hints are plain text (no JSON), so extractSceneMetadata may return null.
        // Fallback: scan plain text for landmark names from the visual bible.
        let coverSceneMetadata = extractSceneMetadata(sceneDescription);
        if (!coverSceneMetadata && streamingVisualBible?.locations) {
          const matchedObjects = [];
          for (const loc of streamingVisualBible.locations) {
            if (loc.isRealLandmark && loc.name && sceneDescription.toLowerCase().includes(loc.name.toLowerCase())) {
              matchedObjects.push(loc.id ? `${loc.name} [${loc.id}]` : loc.name);
            }
          }
          if (matchedObjects.length > 0) {
            coverSceneMetadata = { objects: matchedObjects };
          }
        }
        const coverLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, coverSceneMetadata);
        if (coverLandmarkPhotos.length > 0) {
          log.info(`🌍 [COVER] ${coverLabel} has ${coverLandmarkPhotos.length} landmark(s): ${coverLandmarkPhotos.map(l => `${l.name}${l.variantNumber > 1 ? ` (v${l.variantNumber})` : ''}`).join(', ')}`);
        }

        // Usage tracker for cover images
        const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        const coverResult = await generateImageWithQualityRetry(
          coverPrompt, coverPhotos, null, 'cover', null, coverUsageTracker, null, coverModelOverrides, coverLabel, { isAdmin, enableAutoRepair, enableQualityRetry, useGridRepair, checkOnlyMode, landmarkPhotos: coverLandmarkPhotos }
        );
        log.debug(`✅ [STREAM-COVER] ${coverLabel} generated (score: ${coverResult.score})`);
        // Track scene rewrite usage if a safety block triggered a rewrite
        if (coverResult?.rewriteUsage) {
          addUsage('anthropic', coverResult.rewriteUsage, 'scene_rewrite');
        }

        // Save partial_cover checkpoint for progressive display
        const coverKey = coverType === 'titlePage' ? 'frontCover' : coverType;
        const checkpointData = {
          type: coverKey,
          imageData: coverResult.imageData,
          description: sceneDescription,
          qualityScore: coverResult.score,
          modelId: coverResult.modelId
        };
        // Include title for frontCover so UI can transition to story display
        if (coverType === 'titlePage' && streamingTitle) {
          checkpointData.storyTitle = streamingTitle;
        }
        const checkpointIndex = coverType === 'titlePage' ? 0 : coverType === 'initialPage' ? 1 : 2;
        await saveCheckpoint(jobId, 'partial_cover', checkpointData, checkpointIndex);
        log.debug(`💾 [UNIFIED] Saved ${coverKey} for progressive display`);

        return {
          type: coverType,
          imageData: coverResult.imageData,
          description: sceneDescription,
          prompt: coverPrompt,
          qualityScore: coverResult.score,
          qualityReasoning: coverResult.reasoning,
          wasRegenerated: coverResult.wasRegenerated,
          totalAttempts: coverResult.totalAttempts,
          retryHistory: coverResult.retryHistory,
          referencePhotos: coverPhotos,
          modelId: coverResult.modelId
        };
      });

      streamingCoverPromises.set(coverType, coverPromise);
      log.debug(`⚡ [STREAM-COVER] Started generation for ${coverType}`);
    };

    // Progressive parser with callbacks for streaming updates AND parallel task initiation
    const progressiveParser = new ProgressiveUnifiedParser({
      onTitle: (title) => {
        streamingTitle = title;
      },
      onClothingRequirements: (requirements) => {
        streamingClothingRequirements = requirements;
        // Bug #13 fix: Log completeness check for clothing requirements
        const reqCharCount = Object.keys(requirements).length;
        const expectedCharCount = (inputData.characters || []).length;
        if (reqCharCount < expectedCharCount) {
          log.warn(`⚠️ [STREAM] Clothing requirements incomplete: ${reqCharCount}/${expectedCharCount} characters`);
        } else {
          log.debug(`✅ [STREAM] Clothing requirements complete: ${reqCharCount}/${expectedCharCount} characters`);
        }

        // START AVATAR STYLING EARLY - we have everything we need now
        // This saves ~3min by running in parallel with story text generation
        if (!skipImages && artStyle !== 'realistic' && !streamingAvatarStylingPromise) {
          log.debug(`🎨 [STREAM] Starting early avatar styling (${reqCharCount} characters, ${artStyle} style)...`);
          streamingAvatarStylingPromise = (async () => {
            try {
              const basicRequirements = (inputData.characters || []).flatMap(char => {
                const charNameTrimmed = char.name?.trim();
                const charNameLower = charNameTrimmed?.toLowerCase();
                const charReqs = requirements?.[char.name] ||
                                 requirements?.[charNameTrimmed] ||
                                 requirements?.[charNameLower] ||
                                 (requirements && Object.entries(requirements)
                                   .find(([k]) => k.trim().toLowerCase() === charNameLower)?.[1]);

                let usedCategories = charReqs
                  ? Object.entries(charReqs)
                      .filter(([cat, config]) => config?.used)
                      .map(([cat, config]) => cat === 'costumed' && config?.costume
                        ? `costumed:${config.costume.toLowerCase()}`
                        : cat)
                  : ['standard'];

                if (usedCategories.length === 0) {
                  usedCategories = ['standard'];
                }

                return usedCategories.map(cat => ({
                  pageNumber: 'pre-cover',
                  clothingCategory: cat,
                  characterNames: [char.name]
                }));
              });
              await prepareStyledAvatars(inputData.characters || [], artStyle, basicRequirements, requirements, addUsage);
              log.debug(`✅ [STREAM] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
            } catch (error) {
              log.warn(`⚠️ [STREAM] Early avatar styling failed: ${error.message}`);
            }
          })();
        }
      },
      onVisualBible: (vb) => {
        streamingVisualBible = vb;
        // Filter main characters from Visual Bible
        filterMainCharactersFromVisualBible(streamingVisualBible, inputData.characters);
        // Initialize main characters from inputData.characters
        initializeVisualBibleMainCharacters(streamingVisualBible, inputData.characters);

        // Link pre-discovered landmarks and load photo variant descriptions
        // This must happen BEFORE scene expansion so variants are available in the prompt
        if (inputData.availableLandmarks?.length > 0) {
          linkPreDiscoveredLandmarks(streamingVisualBible, inputData.availableLandmarks);
        }
        // Start async loading of photo descriptions (scene expansion will wait for this)
        landmarkDescriptionsPromise = loadLandmarkPhotoDescriptions(streamingVisualBible);

        log.debug(`⚡ [STREAM] Visual Bible ready - scene expansions can now proceed`);
      },
      onCoverHints: () => {
        // Cover hints section complete - we'll start covers when we have individual hints
        // The parser doesn't provide individual hints in the callback, so we'll handle this differently
      },
      onPageComplete: (page) => {
        streamingPagesDetected = Math.max(streamingPagesDetected, page.pageNumber);
        genLog.info('page_streamed', `Page ${page.pageNumber} parsed from stream`, null, { pageNumber: page.pageNumber, textLength: page.text?.length || 0 });
        // Store page data for scene expansion
        streamingExpandedPages.set(page.pageNumber, page);
        // Start scene expansion immediately
        startSceneExpansion(page);
      },
      onProgress: async (type, message, pageNum) => {
        // Rate limit progress updates (max once per 500ms)
        const now = Date.now();
        if (now - lastProgressUpdate < 500) return;
        lastProgressUpdate = now;

        // Calculate progress based on parallel work happening
        let progress = 5;
        if (type === 'title') progress = 6;
        else if (type === 'clothing') progress = 7;
        else if (type === 'arcs') progress = 8;
        else if (type === 'plot') progress = 9;
        else if (type === 'visualBible') progress = 10;
        else if (type === 'covers') progress = 11;
        else if (type === 'page' && pageNum) {
          progress = 12 + Math.min(3, Math.floor((pageNum / sceneCount) * 3));
        }

        // Enhance message to show parallel work
        let enhancedMessage = message;
        const scenesInProgress = streamingSceneExpansionPromises.size;
        if (scenesInProgress > 0) {
          enhancedMessage = `${message} (${scenesInProgress} scenes in progress)`;
        }

        try {
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progress, enhancedMessage, jobId]
          );
        } catch (e) {
          // Ignore progress update errors
        }
      }
    });

    // Use streaming with progressive parsing and parallel task initiation
    // Use 64000 tokens to match Claude Sonnet's max output capacity for longer stories
    timing.storyGenStart = Date.now();
    const unifiedResult = await callTextModelStreaming(unifiedPrompt, 64000, (chunk, fullText) => {
      progressiveParser.processChunk(chunk, fullText);
    }, modelOverrides.outlineModel);
    timing.storyGenEnd = Date.now();
    const unifiedResponse = unifiedResult.text;
    const unifiedModelId = unifiedResult.modelId;
    const unifiedUsage = unifiedResult.usage || { input_tokens: 0, output_tokens: 0 };
    // Determine provider from model ID since streaming doesn't return provider
    const isGeminiModel = unifiedModelId?.startsWith('gemini') || false;
    const unifiedProvider = isGeminiModel ? 'gemini_text' : 'anthropic';
    log.debug(`📊 [UNIFIED] Story usage - model: ${unifiedModelId}, provider: ${unifiedProvider}, input: ${unifiedUsage.input_tokens}, output: ${unifiedUsage.output_tokens}`);
    addUsage(unifiedProvider, unifiedUsage, 'unified_story', unifiedModelId);
    log.debug(`⏱️ [UNIFIED] Story generation: ${((timing.storyGenEnd - timing.storyGenStart) / 1000).toFixed(1)}s`);

    // Finalize streaming parser
    progressiveParser.finalize();
    log.debug(`📖 [UNIFIED] Response length: ${unifiedResponse.length} chars, ${streamingPagesDetected} pages detected during streaming`);

    // Parse the unified response (full parse for complete data)
    const parser = new UnifiedStoryParser(unifiedResponse);
    const title = parser.extractTitle() || streamingTitle || inputData.storyType || 'Untitled Story';
    const clothingRequirements = parser.extractClothingRequirements() || streamingClothingRequirements;
    const visualBible = parser.extractVisualBible() || streamingVisualBible || {};
    const coverHints = parser.extractCoverHints();
    // Debug: log cover hints character clothing
    if (coverHints) {
      for (const [coverType, hint] of Object.entries(coverHints)) {
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          log.debug(`🎨 [UNIFIED] Cover ${coverType} character clothing: ${JSON.stringify(hint.characterClothing)}`);
        }
      }
    }
    const storyPages = parser.extractPages();

    // Construct fullStoryText from parsed pages (for storage compatibility)
    // Use let so it can be modified by text consistency corrections
    let fullStoryText = storyPages.map(page =>
      `--- Page ${page.pageNumber} ---\n${page.text}`
    ).join('\n\n');

    log.debug(`📖 [UNIFIED] Parsed: title="${title}", ${storyPages.length} pages, ${Object.keys(clothingRequirements || {}).length} clothing reqs`);
    genLog.info('story_parsed', `"${title}" - ${storyPages.length} pages, ${Object.keys(clothingRequirements || {}).length} clothing reqs`, null, { title, pageCount: storyPages.length });
    log.debug(`📖 [UNIFIED] Visual Bible: ${visualBible.secondaryCharacters?.length || 0} chars, ${visualBible.locations?.length || 0} locs, ${visualBible.animals?.length || 0} animals, ${visualBible.artifacts?.length || 0} artifacts`);

    // Start text consistency check early (runs in parallel with image generation)
    // Only needs the story text, so we can fire it as soon as the outline is parsed
    let textCheckPromise = null;
    if (enableFinalChecks && fullStoryText && fullStoryText.length > 100) {
      const characterNames = (inputData.characters || []).map(c => c.name).filter(Boolean);
      const langCode = inputData.language || 'en';
      const { getLanguageInstruction } = require('./server/lib/languages');
      const languageInstruction = getLanguageInstruction(langCode);
      const languageLevel = inputData.languageLevel || 'standard';
      log.info(`📝 [UNIFIED] Starting text consistency check in background (parallel with images)...`);
      textCheckPromise = evaluateTextConsistency(fullStoryText, langCode, characterNames, languageInstruction, languageLevel, unifiedModelId)
        .catch(err => {
          log.warn(`⚠️ [UNIFIED] Early text check failed: ${err.message}`);
          return null;
        });
    }

    // Compare streaming vs final parse results
    if (streamingPagesDetected !== storyPages.length) {
      log.warn(`⚠️ [UNIFIED] Page count mismatch: streaming detected ${streamingPagesDetected} pages, final parse found ${storyPages.length} pages`);
      log.warn(`⚠️ [UNIFIED] Pages from final parse: ${storyPages.map(p => p.pageNumber).join(', ')}`);
    }

    // Check if we got the requested number of pages
    if (storyPages.length !== sceneCount) {
      log.warn(`⚠️ [UNIFIED] Requested ${sceneCount} scenes but parsed ${storyPages.length} pages`);
    }

    // Filter main characters from Visual Bible (safety net)
    filterMainCharactersFromVisualBible(visualBible, inputData.characters);

    // Initialize main characters from inputData.characters with their style analysis
    // This populates visualBible.mainCharacters for the dev panel display
    initializeVisualBibleMainCharacters(visualBible, inputData.characters);

    // Inject historical locations with pre-fetched photos (for historical stories)
    if (inputData.storyCategory === 'historical' && inputData.storyTopic) {
      const historicalLocations = getHistoricalLocations(inputData.storyTopic);
      if (historicalLocations?.length > 0) {
        injectHistoricalLocations(visualBible, historicalLocations);
        log.info(`📍 [UNIFIED] Injected ${historicalLocations.length} pre-fetched historical location(s)`);
      }
    }

    // Link pre-discovered landmarks (if available) to skip fetching later
    if (inputData.availableLandmarks?.length > 0) {
      linkPreDiscoveredLandmarks(visualBible, inputData.availableLandmarks);
    }

    // Load photo variant descriptions for Swiss landmarks (descriptions only, no image data)
    // This enables scene description AI to intelligently select which photo variant to use
    await loadLandmarkPhotoDescriptions(visualBible);

    // Start background fetch for landmark reference photos (runs in parallel with avatar generation)
    // NOTE: For Swiss landmarks with photo variants, we'll load photos on-demand during image generation
    // This prefetch handles non-Swiss landmarks (historical events, Wikimedia search) that don't have variants
    let landmarkFetchPromise = null;
    let landmarkCount = 0;
    const nonVariantLandmarks = (visualBible.locations || []).filter(
      l => l.isRealLandmark && !l.photoVariants?.length && l.photoFetchStatus !== 'success'
    );
    if (nonVariantLandmarks.length > 0 && !skipImages) {
      landmarkCount = nonVariantLandmarks.length;
      log.info(`🌍 [UNIFIED] Starting background fetch for ${nonVariantLandmarks.length} non-variant landmark photo(s)`);
      landmarkFetchPromise = prefetchLandmarkPhotos(visualBible);
    }

    // Start background reference sheet generation for secondary elements
    // This generates reference images for recurring characters, animals, artifacts etc.
    let referenceSheetPromise = null;
    if (!skipImages) {
      const styleDescription = ART_STYLES[artStyle] || ART_STYLES.pixar;
      referenceSheetPromise = generateReferenceSheet(visualBible, styleDescription, {
        minAppearances: 2, // Elements appearing on 2+ pages
        maxPerBatch: 4     // Max 4 elements per grid for quality
      }).catch(err => {
        log.warn(`⚠️ [UNIFIED] Reference sheet generation failed: ${err.message}`);
        return { generated: 0, failed: 0, elements: [] };
      });
    }

    // Save checkpoint
    await saveCheckpoint(jobId, 'unified_story', {
      title,
      clothingRequirements,
      visualBible,
      coverHints,
      storyPages,
      unifiedPrompt,
      unifiedModelId,
      unifiedUsage
    });

    // Save story_text checkpoint for progressive display (UI can show text immediately)
    const pageTextMap = {};
    storyPages.forEach(page => {
      pageTextMap[page.pageNumber] = page.text;
    });
    // Calculate actual print page count:
    // Picture book (1st-grade): 1 page per scene
    // Standard/Advanced: 2 pages per scene (text page + image page)
    const isPictureBook = inputData.languageLevel === '1st-grade';
    const printPageCount = isPictureBook ? storyPages.length : storyPages.length * 2;

    // Frontend expects: { title, dedication, pageTexts, sceneDescriptions, totalPages, totalScenes }
    await saveCheckpoint(jobId, 'story_text', {
      title,
      dedication: inputData.dedication || '',
      pageTexts: pageTextMap,
      sceneDescriptions: storyPages.map(page => ({
        pageNumber: page.pageNumber,
        description: page.sceneHint || '',
        characterClothing: page.characterClothing || {}
      })),
      totalPages: printPageCount,  // Print page count (text + image pages)
      totalScenes: storyPages.length  // Scene count (= number of images to expect)
    });
    log.debug(`💾 [UNIFIED] Saved story text for progressive display (${storyPages.length} scenes = ${printPageCount} print pages)`);

    // Update progress: Story text complete
    const scenesStarted = streamingSceneExpansionPromises.size;
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [18, `Story complete: "${title}" (${scenesStarted} scenes in parallel)`, jobId]
    );

    // Wait for early avatar styling (started during streaming when clothing requirements detected)
    // This runs in parallel with story text generation, saving ~3min
    if (!skipImages && artStyle !== 'realistic') {
      if (streamingAvatarStylingPromise) {
        log.debug(`🎨 [UNIFIED] Waiting for early avatar styling to complete...`);
        await streamingAvatarStylingPromise;
        log.debug(`✅ [UNIFIED] Pre-cover styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
      } else {
        // Fallback: style avatars now if early styling didn't start
        log.debug(`🎨 [UNIFIED] Preparing styled avatars for covers (fallback)...`);
        try {
          const basicCoverRequirements = (inputData.characters || []).flatMap(char => {
            const charNameLower = char.name?.toLowerCase();
            const charReqs = clothingRequirements?.[char.name] ||
                             clothingRequirements?.[charNameLower] ||
                             (clothingRequirements && Object.entries(clothingRequirements)
                               .find(([k]) => k.toLowerCase() === charNameLower)?.[1]);

            let usedCategories = charReqs
              ? Object.entries(charReqs)
                  .filter(([cat, config]) => config?.used)
                  .map(([cat, config]) => cat === 'costumed' && config?.costume
                    ? `costumed:${config.costume.toLowerCase()}`
                    : cat)
              : ['standard'];

            if (usedCategories.length === 0) {
              usedCategories = ['standard'];
            }

            return usedCategories.map(cat => ({
              pageNumber: 'pre-cover',
              clothingCategory: cat,
              characterNames: [char.name]
            }));
          });
          await prepareStyledAvatars(inputData.characters || [], artStyle, basicCoverRequirements, clothingRequirements, addUsage);
          log.debug(`✅ [UNIFIED] Pre-cover styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.warn(`⚠️ [UNIFIED] Pre-cover styled avatar prep failed: ${error.message}`);
        }
      }
    }

    // NOTE: Avatar generation removed. Avatars should already exist from character creation.

    // PHASE 2: Prepare styled avatars
    genLog.setStage('avatars');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [20, `Preparing styled avatars...`, jobId]
    );

    // Collect avatar requirements and prepare styled avatars
    const sceneDescriptions = storyPages.map(page => ({
      pageNumber: page.pageNumber || storyPages.indexOf(page) + 1,
      description: page.sceneHint || page.text || ''
    }));
    // Build pageClothing from per-character clothing data
    const pageClothing = {};
    storyPages.forEach((page, index) => {
      if (page.characterClothing && Object.keys(page.characterClothing).length > 0) {
        pageClothing[page.pageNumber || index + 1] = page.characterClothing;
      }
    });

    const avatarRequirements = collectAvatarRequirements(
      sceneDescriptions,
      inputData.characters || [],
      pageClothing,
      'standard',
      clothingRequirements
    );

    // NOTE: Avatar generation removed from story processing.
    // Base avatars should already exist from character creation.
    // For costumed/signature avatars, use server/lib/storyAvatarGeneration.js if needed.

    // Prepare styled avatars (convert existing avatars to target art style)
    // Skip if early avatar styling already completed (avoids duplicate costumed avatar generation)
    if (avatarRequirements.length > 0 && artStyle !== 'realistic' && !streamingAvatarStylingPromise) {
      // Validate that characters have base avatars
      const charactersWithoutAvatars = (inputData.characters || []).filter(c =>
        !c.avatars?.standard && !c.photoUrl && !c.bodyNoBgUrl
      );
      if (charactersWithoutAvatars.length > 0) {
        log.warn(`⚠️ [UNIFIED] Characters missing base avatars: ${charactersWithoutAvatars.map(c => c.name).join(', ')}`);
      }

      log.debug(`🎨 [UNIFIED] Preparing ${avatarRequirements.length} styled avatars for ${artStyle} (early styling did not run)`);
      await prepareStyledAvatars(inputData.characters, artStyle, avatarRequirements, clothingRequirements, addUsage);
    } else if (streamingAvatarStylingPromise) {
      log.debug(`⏭️ [UNIFIED] Skipping PHASE 2 avatar styling - early styling already completed (${getStyledAvatarCacheStats().size} cached)`);
    }

    // Start cover generation NOW that avatars are ready (covers need avatars as reference photos)
    if (!skipImages && !skipCovers && coverHints) {
      const coverTypes = ['titlePage', 'initialPage', 'backCover'];
      for (const coverType of coverTypes) {
        const hint = coverHints[coverType];
        if (hint && !streamingCoverPromises.has(coverType)) {
          startCoverGeneration(coverType, hint);
        }
      }
      log.debug(`⚡ [UNIFIED] Started ${streamingCoverPromises.size} cover generations (avatars ready)`);
    }

    // PHASE 3: Wait for scene expansion to complete (most should be done by now)
    genLog.setStage('scenes');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [30, `Finalizing ${streamingSceneExpansionPromises.size} scene expansions...`, jobId]
    );

    // Start any missing scene expansions (pages that weren't detected during streaming)
    for (const page of storyPages) {
      if (!streamingSceneExpansionPromises.has(page.pageNumber)) {
        log.debug(`⚡ [UNIFIED] Starting late scene expansion for page ${page.pageNumber}`);
        startSceneExpansion(page);
      }
    }

    // Wait for all scene expansions
    log.debug(`⏳ [UNIFIED] Waiting for ${streamingSceneExpansionPromises.size} scene expansions...`);
    const sceneResults = await Promise.all(
      Array.from(streamingSceneExpansionPromises.values())
    );

    // Sort by page number and create expandedScenes array
    const expandedScenes = sceneResults.sort((a, b) => a.pageNumber - b.pageNumber);
    log.debug(`✅ [UNIFIED] All ${expandedScenes.length} scene expansions complete`);
    genLog.info('scenes_complete', `All ${expandedScenes.length} scene expansions complete`);

    // FIX: Update characterClothing from full re-parse to fix truncated costume names from streaming
    // Streaming can truncate costume names (e.g., "costumed:gla" instead of "costumed:gladiator")
    // The full re-parse in storyPages has complete data
    for (const scene of expandedScenes) {
      const fullParsePage = storyPages.find(p => p.pageNumber === scene.pageNumber);
      if (fullParsePage?.characterClothing && Object.keys(fullParsePage.characterClothing).length > 0) {
        // Check if streaming truncated any costume names
        const streamingClothing = scene.characterClothing || {};
        const fullClothing = fullParsePage.characterClothing;
        let updated = false;
        for (const [charName, fullValue] of Object.entries(fullClothing)) {
          const streamingValue = streamingClothing[charName];
          if (streamingValue && fullValue && streamingValue !== fullValue) {
            log.debug(`[CLOTHING FIX] Page ${scene.pageNumber} ${charName}: "${streamingValue}" -> "${fullValue}"`);
            updated = true;
          }
        }
        // Always use the full parse data
        scene.characterClothing = fullClothing;
      }
    }

    // Log streaming efficiency
    const pagesFromStreaming = streamingExpandedPages.size;
    log.debug(`📊 [UNIFIED] Streaming efficiency: ${pagesFromStreaming}/${storyPages.length} pages started during streaming`);

    // Create allSceneDescriptions array for storage compatibility
    const allSceneDescriptions = expandedScenes.map(scene => {
      // Extract translatedSummary and imageSummary for edit modal display
      const sceneMetadata = extractSceneMetadata(scene.sceneDescription);
      return {
        pageNumber: scene.pageNumber,
        description: scene.sceneDescription,
        characterClothing: scene.characterClothing || {},
        outlineExtract: scene.outlineExtract || scene.sceneHint || '',
        // Dev mode: Art Director prompt and model used
        scenePrompt: scene.sceneDescriptionPrompt,
        textModelId: scene.sceneDescriptionModelId,
        // Pre-extracted summaries for edit modal (avoids JSON parsing on frontend)
        translatedSummary: sceneMetadata?.translatedSummary || null,
        imageSummary: sceneMetadata?.imageSummary || null
      };
    });

    // Update pageClothing for storage compatibility (per-character format)
    storyPages.forEach((page, index) => {
      if (page.characterClothing && Object.keys(page.characterClothing).length > 0) {
        pageClothing[index + 1] = page.characterClothing;
      }
    });
    // pageClothingData now stores per-character clothing objects
    const pageClothingData = {
      primaryClothing: 'standard',  // Legacy field, kept for compatibility
      pageClothing
    };

    // Skip image generation if requested
    if (skipImages) {
      log.debug(`📖 [UNIFIED] Skipping image generation (text-only mode)`);

      const result = {
        title,
        pages: expandedScenes.map(scene => ({
          pageNumber: scene.pageNumber,
          text: scene.text,
          sceneDescription: scene.sceneDescription,
          image: null
        })),
        coverImages: {},
        visualBible,
        tokenUsage,
        generationMode: 'unified'
      };

      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [100, 'Story generation complete (text only)', jobId]
      );

      return result;
    }

    // PHASE 4: Start cover images await (runs PARALLEL with page images)
    // Covers and page images don't depend on each other - both need story/avatars but not each other
    const coverImages = {};
    let coverAwaitPromise = null;

    if (streamingCoverPromises.size > 0) {
      timing.coversStart = timing.coversStart || Date.now(); // May have started during streaming
      log.debug(`⏳ [UNIFIED] Cover generations in progress (${streamingCoverPromises.size} covers, running parallel with page images)...`);

      // Create promise but don't await yet - covers run parallel with page images
      coverAwaitPromise = Promise.all(
        Array.from(streamingCoverPromises.values())
      ).then(coverResults => {
        timing.coversEnd = Date.now();
        // Map results to coverImages object
        for (const result of coverResults) {
          if (result?.imageData) {
            // Map coverType to frontend expected keys
            const storageKey = result.type === 'titlePage' ? 'frontCover' : result.type;
            coverImages[storageKey] = {
              imageData: result.imageData,
              description: result.description,
              prompt: result.prompt,
              qualityScore: result.qualityScore,
              qualityReasoning: result.qualityReasoning,
              wasRegenerated: result.wasRegenerated,
              totalAttempts: result.totalAttempts,
              retryHistory: result.retryHistory,
              referencePhotos: result.referencePhotos,
              modelId: result.modelId
            };
          }
        }
        log.debug(`✅ [UNIFIED] All ${Object.keys(coverImages).length} cover images complete`);
        log.debug(`⏱️ [UNIFIED] Cover images: ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
      });
    } else {
      log.debug(`📖 [UNIFIED] No cover images to generate (skipCovers=${skipCovers})`);
    }

    // Wait for landmark photos before generating page images
    if (landmarkFetchPromise) {
      await landmarkFetchPromise;
      const successCount = (visualBible.locations || []).filter(l => l.photoFetchStatus === 'success').length;
      log.info(`🌍 [UNIFIED] Landmark photos ready: ${successCount}/${landmarkCount} fetched successfully`);
    }

    // Wait for reference sheet generation (for secondary element consistency)
    if (referenceSheetPromise) {
      const refResult = await referenceSheetPromise;
      if (refResult.generated > 0) {
        log.info(`🖼️ [UNIFIED] Reference images ready: ${refResult.generated} generated for secondary elements`);
      }
    }

    // PHASE 5: Generate page images
    // Sequential mode when incremental consistency is enabled, parallel otherwise
    genLog.setStage('images');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [50, 'Generating page illustrations...', jobId]
    );

    timing.pagesStart = Date.now();
    let allImages;

    // Helper function to generate a single page image (shared between parallel and sequential modes)
    const generatePageImage = async (scene, index, incrConfig = null) => {
      const pageNum = scene.pageNumber;
      const progressPercent = 50 + Math.floor((index / expandedScenes.length) * 40);

      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [progressPercent, `Generating illustration ${pageNum}/${expandedScenes.length}...`, jobId]
      );

      const sceneCharacters = getCharactersInScene(scene.sceneDescription, inputData.characters);

      // Extract clothing from scene expansion's JSON output AND from Characters section (streaming parser)
      // Characters section (scene.characterClothing) takes priority — it's the explicit per-page assignment
      // Scene metadata JSON may carry stale costume data from other pages
      const sceneMetadataForClothing = extractSceneMetadata(scene.sceneDescription);
      const perCharClothing = {
        ...(sceneMetadataForClothing?.characterClothing || {}),
        ...(scene.characterClothing || {})
      };

      // Always default to 'standard' for unlisted characters (not first character's costume)
      // This prevents inheriting costumes from other characters
      const defaultClothing = 'standard';
      let defaultCategory = defaultClothing;
      let defaultCostumeType = null;

      // Pass per-character clothing requirements merged with story-level requirements
      // Each character's clothing category from scene.characterClothing
      const sceneClothingRequirements = { ...clothingRequirements };
      for (const char of sceneCharacters) {
        // Find clothing using trimmed name comparison (handles trailing whitespace)
        const charNameTrimmed = char.name.trim().toLowerCase();
        const charClothing = Object.entries(perCharClothing).find(
          ([name]) => name.trim().toLowerCase() === charNameTrimmed
        )?.[1] || defaultClothing;
        if (!sceneClothingRequirements[char.name]) {
          sceneClothingRequirements[char.name] = {};
        }
        // Add the current scene's clothing selection
        sceneClothingRequirements[char.name]._currentClothing = charClothing;
      }

      let pagePhotos = getCharacterPhotoDetails(sceneCharacters, defaultCategory, defaultCostumeType, inputData.artStyle, sceneClothingRequirements);
      // Apply styled avatars for non-costumed characters
      if (defaultCategory !== 'costumed') {
        pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
      }

      // Log avatar selections for each character
      for (const photo of pagePhotos) {
        if (photo.photoType === 'none' || !photo.hasPhoto) {
          genLog.avatarFallback(photo.name, `No avatar found for ${defaultCategory}`, {
            pageNumber: pageNum,
            requestedCategory: defaultCategory,
            costumeType: defaultCostumeType
          });
        } else {
          genLog.avatarLookup(photo.name, `Using ${photo.photoType}${photo.isStyled ? ' (styled)' : ''}`, {
            pageNumber: pageNum,
            photoType: photo.photoType,
            isStyled: photo.isStyled,
            clothingCategory: photo.clothingCategory
          });
        }
      }

      // Get landmark photos for this scene from metadata objects like "Burgruine Stein [LOC002]"
      // This loads the selected photo variant on-demand for Swiss landmarks
      const sceneMetadata = extractSceneMetadata(scene.sceneDescription);
      const pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata);
      if (pageLandmarkPhotos.length > 0) {
        log.info(`🌍 [UNIFIED] Page ${pageNum} has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => `${l.name}${l.variantNumber > 1 ? ` (v${l.variantNumber})` : ''}`).join(', ')}`);
      }

      // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
      // VB elements are NO LONGER added individually to referencePhotos
      const elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
      const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
      let vbGrid = null;
      if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
        vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
        log.debug(`🔲 [UNIFIED] Page ${pageNum} VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
      }

      // Only character photos go in allReferencePhotos (no VB elements)
      const allReferencePhotos = pagePhotos;

      const imagePrompt = buildImagePrompt(
        scene.sceneDescription,
        inputData,
        sceneCharacters,
        false,
        visualBible,
        pageNum,
        true,
        allReferencePhotos
      );

      const pageModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };

      // Usage tracker for page images (5th param isInpaint distinguishes inpaint from generation)
      const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel, isInpaint = false) => {
        if (imgUsage) {
          // Detect provider from model name (Runware uses direct_cost, Gemini uses tokens)
          const isRunware = imgModel && imgModel.startsWith('runware:');
          const provider = isRunware ? 'runware' : 'gemini_image';
          const funcName = isInpaint ? 'inpaint' : 'page_images';
          addUsage(provider, imgUsage, funcName, imgModel);
        }
        if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
      };

      // Add current page's characters to incremental consistency config
      // This tells the model which characters should actually be in this scene
      const incrConfigWithCurrentChars = incrConfig ? {
        ...incrConfig,
        currentCharacters: sceneCharacters.map(c => c.name)
      } : null;

      const imageResult = await generateImageWithQualityRetry(
        imagePrompt,
        allReferencePhotos,
        null,
        'scene',
        null,
        pageUsageTracker,
        null,
        pageModelOverrides,
        `PAGE ${pageNum}`,
        { isAdmin, enableAutoRepair, enableQualityRetry, useGridRepair, checkOnlyMode, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata, incrementalConsistency: incrConfigWithCurrentChars, storyText: scene.text, sceneHint: scene.outlineExtract || scene.sceneHint || null }
      );

      // Track scene rewrite usage if a safety block triggered a rewrite
      if (imageResult?.rewriteUsage) {
        addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
      }

      if (imageResult?.imageData) {
        genLog.imageGenerated(pageNum, true, { model: imageResult.modelId, score: imageResult.score, attempts: imageResult.totalAttempts || 1 });

        // Save partial_page checkpoint for progressive display
        await saveCheckpoint(jobId, 'partial_page', {
          pageNumber: pageNum,
          text: scene.text,
          sceneDescription: scene.sceneDescription,
          imageData: imageResult.imageData,
          qualityScore: imageResult.score,
          modelId: imageResult.modelId
        }, pageNum);
        log.debug(`💾 [UNIFIED] Saved page ${pageNum} for progressive display`);
      } else {
        genLog.imageGenerated(pageNum, false, { model: imageResult?.modelId });
      }

      return {
        pageNumber: pageNum,
        text: scene.text,
        description: scene.sceneDescription,
        outlineExtract: scene.outlineExtract || scene.sceneHint || '',  // Short scene hint for re-expansion
        imageData: imageResult?.imageData || null,
        prompt: imagePrompt,
        // Dev mode: Art Director prompt used to create scene description
        sceneDescriptionPrompt: scene.sceneDescriptionPrompt,
        sceneDescriptionModelId: scene.sceneDescriptionModelId,
        // Include quality info if available
        qualityScore: imageResult?.score,
        qualityReasoning: imageResult?.reasoning,
        fixTargets: imageResult?.fixTargets || [],
        fixableIssues: imageResult?.fixableIssues || [],
        thinkingText: imageResult?.thinkingText || null,
        // Semantic evaluation (text-to-image fidelity)
        semanticResult: imageResult?.semanticResult || null,
        semanticScore: imageResult?.semanticScore ?? null,
        issuesSummary: imageResult?.issuesSummary || null,
        verdict: imageResult?.verdict || null,
        wasRegenerated: imageResult?.wasRegenerated,
        totalAttempts: imageResult?.totalAttempts,
        retryHistory: imageResult?.retryHistory,
        // Dev mode: which reference photos/avatars were used (includes element references)
        referencePhotos: allReferencePhotos,
        // Landmark photos (separate for frontend display)
        landmarkPhotos: pageLandmarkPhotos,
        // Visual Bible grid (combined VB elements + secondary landmarks)
        visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
        // Include characters info for incremental consistency tracking
        sceneCharacters,
        // Per-character clothing selections for this scene (e.g., {"Lukas": "costumed:pirate", "Franziska": "standard"})
        sceneCharacterClothing: perCharClothing
      };
    };

    if (separatedEvaluation && !incrementalConsistencyConfig?.enabled) {
      // =======================================================================
      // SEPARATED EVALUATION PIPELINE (NEW ARCHITECTURE)
      // Phase 5a: Generate ALL images first (no retry)
      // Phase 5b: Evaluate ALL in parallel
      // Phase 5c: Build repair plan
      // Phase 5d: Execute repairs
      // =======================================================================
      log.info(`🚀 [UNIFIED] Using SEPARATED EVALUATION pipeline`);

      // Helper function to prepare page data without generation (for later use by pipeline)
      const preparePageData = async (scene, index) => {
        const pageNum = scene.pageNumber;
        const sceneCharacters = getCharactersInScene(scene.sceneDescription, inputData.characters);
        // Characters section takes priority over scene metadata JSON (may have stale costume data)
        const sceneMetadataForClothing = extractSceneMetadata(scene.sceneDescription);
        const perCharClothing = {
          ...(sceneMetadataForClothing?.characterClothing || {}),
          ...(scene.characterClothing || {})
        };
        const defaultClothing = 'standard';
        const sceneClothingRequirements = { ...clothingRequirements };
        for (const char of sceneCharacters) {
          const charNameTrimmed = char.name.trim().toLowerCase();
          const charClothing = Object.entries(perCharClothing).find(
            ([name]) => name.trim().toLowerCase() === charNameTrimmed
          )?.[1] || defaultClothing;
          if (!sceneClothingRequirements[char.name]) {
            sceneClothingRequirements[char.name] = {};
          }
          sceneClothingRequirements[char.name]._currentClothing = charClothing;
        }
        let pagePhotos = getCharacterPhotoDetails(sceneCharacters, defaultClothing, null, inputData.artStyle, sceneClothingRequirements);
        pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
        const sceneMetadata = extractSceneMetadata(scene.sceneDescription);
        const pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata);
        const elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
        const secondaryLandmarks = pageLandmarkPhotos.slice(1);
        let vbGrid = null;
        if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
          vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
        }
        const imagePrompt = buildImagePrompt(
          scene.sceneDescription, inputData, sceneCharacters, false, visualBible, pageNum, true, pagePhotos
        );
        return {
          pageNumber: pageNum,
          index,
          scene,
          prompt: imagePrompt,
          characterPhotos: pagePhotos,
          landmarkPhotos: pageLandmarkPhotos,
          visualBibleGrid: vbGrid,
          sceneCharacters,
          sceneMetadata,
          perCharClothing
        };
      };

      // Phase 5a: Prepare all page data
      log.info(`📸 [UNIFIED] Phase 5a: Preparing ${expandedScenes.length} pages for image generation...`);
      const pageDataArray = await Promise.all(
        expandedScenes.map((scene, index) => preparePageData(scene, index))
      );

      // Phase 5a continued: Generate ALL images (no evaluation)
      log.info(`📸 [UNIFIED] Phase 5a: Generating all ${expandedScenes.length} images...`);
      const genStartTime = Date.now();
      const genLimit = pLimit(5);

      const rawImages = await Promise.all(
        pageDataArray.map(pageData => genLimit(async () => {
          const progressPercent = 50 + Math.floor((pageData.index / expandedScenes.length) * 30);
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progressPercent, `Generating illustration ${pageData.pageNumber}/${expandedScenes.length}...`, jobId]
          );

          try {
            const genResult = await generateImageOnly(
              pageData.prompt,
              pageData.characterPhotos,
              {
                imageModelOverride: modelOverrides.imageModel,
                imageBackendOverride: modelOverrides.imageBackend,
                landmarkPhotos: pageData.landmarkPhotos,
                visualBibleGrid: pageData.visualBibleGrid,
                pageNumber: pageData.pageNumber
              }
            );

            // Track usage
            if (genResult.usage) {
              const isRunware = genResult.modelId && genResult.modelId.startsWith('runware:');
              const provider = isRunware ? 'runware' : 'gemini_image';
              addUsage(provider, genResult.usage, 'page_images', genResult.modelId);
            }

            // Save checkpoint for progressive display
            if (genResult.imageData) {
              await saveCheckpoint(jobId, 'partial_page', {
                pageNumber: pageData.pageNumber,
                text: pageData.scene.text,
                sceneDescription: pageData.scene.sceneDescription,
                imageData: genResult.imageData,
                modelId: genResult.modelId
              }, pageData.pageNumber);
            }

            return {
              pageNumber: pageData.pageNumber,
              imageData: genResult.imageData,
              modelId: genResult.modelId,
              thinkingText: genResult.thinkingText || null,
              usage: genResult.usage,
              prompt: pageData.prompt,
              characterPhotos: pageData.characterPhotos,
              landmarkPhotos: pageData.landmarkPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene
            };
          } catch (genError) {
            log.error(`❌ [UNIFIED] Page ${pageData.pageNumber} generation failed: ${genError.message}`);
            return {
              pageNumber: pageData.pageNumber,
              imageData: null,
              error: genError.message,
              prompt: pageData.prompt,
              characterPhotos: pageData.characterPhotos,
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene
            };
          }
        }))
      );

      const genDuration = ((Date.now() - genStartTime) / 1000).toFixed(1);
      const successCount = rawImages.filter(r => r.imageData).length;
      log.info(`✅ [UNIFIED] Phase 5a complete: ${successCount}/${rawImages.length} images generated in ${genDuration}s`);

      // Phase 5b: Evaluate ALL images in parallel
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [85, 'Evaluating image quality...', jobId]
      );

      log.info(`🔍 [UNIFIED] Phase 5b: Evaluating all ${successCount} images...`);
      const evalStartTime = Date.now();

      const evaluations = await evaluateImageBatch(
        rawImages.filter(r => r.imageData).map(img => ({
          imageData: img.imageData,
          pageNumber: img.pageNumber,
          prompt: img.prompt,
          characterPhotos: img.characterPhotos,
          sceneDescription: img.sceneDescription,
          sceneCharacters: img.sceneCharacters,
          sceneMetadata: img.sceneMetadata,
          pageText: img.text,  // Story text for semantic fidelity check
          sceneHint: img.scene?.outlineExtract || img.scene?.sceneHint || null  // Scene hint for semantic evaluation
        })),
        {
          concurrency: 10,
          qualityModelOverride: modelOverrides.qualityModel
        }
      );

      // Track quality eval usage
      for (const evalResult of evaluations) {
        if (evalResult.usage) {
          addUsage('gemini_quality', evalResult.usage, 'page_quality', evalResult.modelId);
        }
      }

      const evalDuration = ((Date.now() - evalStartTime) / 1000).toFixed(1);
      const avgScore = evaluations.reduce((sum, e) => sum + (e.qualityScore || 0), 0) / Math.max(1, evaluations.length);
      log.info(`✅ [UNIFIED] Phase 5b complete: ${evaluations.length} evaluations in ${evalDuration}s (avg score: ${avgScore.toFixed(0)}%)`);

      // Phase 5c: Build repair plan
      log.info(`📋 [UNIFIED] Phase 5c: Building repair plan...`);
      const repairPlan = buildRepairPlan(evaluations, {
        regenerateThreshold: 30,
        repairThreshold: enableAutoRepair ? 70 : 0,  // Only plan repairs if autoRepair is enabled
        keepThreshold: 50
      });

      log.info(`📋 [UNIFIED] Repair plan: ${repairPlan.pagesToRegenerate.length} regen, ${repairPlan.pagesToRepair.length} repair, ${repairPlan.pagesToKeep.length} keep`);

      // Phase 5d: Execute repair plan (if enabled)
      if (enableAutoRepair && (repairPlan.pagesToRegenerate.length > 0 || repairPlan.pagesToRepair.length > 0)) {
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [90, 'Repairing images...', jobId]
        );

        log.info(`🔧 [UNIFIED] Phase 5d: Executing repair plan...`);

        // Build page data and evaluation maps
        const pageDataMap = new Map();
        const evalMap = new Map();
        for (const img of rawImages) {
          pageDataMap.set(img.pageNumber, img);
        }
        for (const evalResult of evaluations) {
          evalMap.set(evalResult.pageNumber, evalResult);
        }

        const repairResults = await executeRepairPlan(
          repairPlan,
          pageDataMap,
          evalMap,
          {
            modelOverrides,
            usageTracker: (imgUsage, qualUsage, imgModel, qualModel, isInpaint) => {
              if (imgUsage) {
                const isRunware = imgModel && imgModel.startsWith('runware:');
                const provider = isRunware ? 'runware' : 'gemini_image';
                const funcName = isInpaint ? 'inpaint' : 'page_images';
                addUsage(provider, imgUsage, funcName, imgModel);
              }
              if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
            },
            visualBible,
            isAdmin
          },
          { repairFirst: true, useGridRepair }
        );

        log.info(`✅ [UNIFIED] Phase 5d complete: ${repairResults.repaired.size} repaired, ${repairResults.regenerated.size} regenerated`);

        // Merge results
        allImages = mergeRepairResults(rawImages, evaluations, repairResults).map(img => ({
          pageNumber: img.pageNumber,
          text: img.text,
          description: img.sceneDescription,
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          imageData: img.imageData,
          prompt: img.prompt,
          sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          qualityScore: img.qualityScore,
          qualityReasoning: img.qualityReasoning,
          thinkingText: img.thinkingText || null,
          wasRegenerated: img.wasRegenerated,
          wasRepaired: img.wasRepaired,
          repairMethod: img.repairMethod,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid ? (typeof img.visualBibleGrid === 'string' ? img.visualBibleGrid : `data:image/jpeg;base64,${img.visualBibleGrid.toString('base64')}`) : null,
          sceneCharacters: img.sceneCharacters,
          sceneCharacterClothing: img.perCharClothing,
          bboxDetection: img.bboxDetection,
          bboxOverlayImage: img.bboxOverlayImage,
          fixTargets: img.fixTargets || [],
          fixableIssues: img.fixableIssues || [],
          semanticResult: img.semanticResult || null,
          semanticScore: img.semanticScore ?? null,
          issuesSummary: img.issuesSummary || null,
          verdict: img.verdict || null,
          imageVersions: img.imageVersions || [],
          retryHistory: [{
            attempt: 1,
            type: 'separated_evaluation',
            score: img.qualityScore,
            bboxDetection: img.bboxDetection,
            bboxOverlayImage: img.bboxOverlayImage,
            timestamp: new Date().toISOString()
          }]
        }));
      } else {
        // No repair needed - just merge raw images with evaluation data
        allImages = rawImages.map(img => {
          const evalResult = evaluations.find(e => e.pageNumber === img.pageNumber);
          return {
            pageNumber: img.pageNumber,
            text: img.text,
            description: img.sceneDescription,
            outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
            imageData: img.imageData,
            prompt: img.prompt,
            sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
            sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
            qualityScore: evalResult?.qualityScore,
            qualityReasoning: evalResult?.reasoning,
            fixTargets: evalResult?.fixTargets || evalResult?.enrichedFixTargets || [],
            fixableIssues: evalResult?.fixableIssues || [],
            semanticResult: evalResult?.semanticResult || null,
            semanticScore: evalResult?.semanticScore ?? null,
            issuesSummary: evalResult?.issuesSummary || null,
            verdict: evalResult?.verdict || null,
            thinkingText: img.thinkingText || null,
            referencePhotos: img.characterPhotos,
            landmarkPhotos: img.landmarkPhotos,
            visualBibleGrid: img.visualBibleGrid ? (typeof img.visualBibleGrid === 'string' ? img.visualBibleGrid : `data:image/jpeg;base64,${img.visualBibleGrid.toString('base64')}`) : null,
            sceneCharacters: img.sceneCharacters,
            sceneCharacterClothing: img.perCharClothing,
            bboxDetection: evalResult?.bboxDetection,
            bboxOverlayImage: evalResult?.bboxOverlayImage,
            retryHistory: [{
              attempt: 1,
              type: 'separated_evaluation',
              score: evalResult?.qualityScore,
              bboxDetection: evalResult?.bboxDetection,
              bboxOverlayImage: evalResult?.bboxOverlayImage,
              timestamp: new Date().toISOString()
            }]
          };
        });
      }

    } else if (incrementalConsistencyConfig?.enabled) {
      // SEQUENTIAL MODE for incremental consistency
      // Generate images one at a time, comparing each against previous images
      log.info(`🔍 [UNIFIED] Using SEQUENTIAL image generation for incremental consistency (lookback: ${incrementalConsistencyConfig.lookbackCount})`);
      const previousImagesForConsistency = [];
      allImages = [];

      for (let index = 0; index < expandedScenes.length; index++) {
        const scene = expandedScenes[index];
        const pageNum = scene.pageNumber;

        // Build incremental consistency config with previous images
        let incrConfig = null;
        if (previousImagesForConsistency.length > 0) {
          const lookbackImages = previousImagesForConsistency.slice(-incrementalConsistencyConfig.lookbackCount);
          incrConfig = {
            enabled: true,
            dryRun: incrementalConsistencyConfig.dryRun,
            lookbackCount: incrementalConsistencyConfig.lookbackCount,
            previousImages: lookbackImages,
            forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold
          };
          log.debug(`🔍 [UNIFIED] Page ${pageNum}: checking against ${lookbackImages.length} previous page(s)`);
        } else if (incrementalConsistencyConfig?.forceRepairThreshold != null) {
          // Even without previous images (first page), pass forceRepairThreshold if set
          incrConfig = { forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold };
        }

        // Generate image with incremental consistency
        const pageResult = await generatePageImage(scene, index, incrConfig);
        allImages.push(pageResult);

        // Track this image for future consistency checks
        if (pageResult.imageData) {
          // Use per-character clothing from the scene (e.g., {"Lukas": "costumed:pirate", "Franziska": "standard"})
          // This is the actual clothing category selected for each character in this specific scene
          previousImagesForConsistency.push({
            imageData: pageResult.imageData,
            pageNumber: pageNum,
            characters: (pageResult.sceneCharacters || []).map(c => c.name),
            characterClothing: pageResult.sceneCharacterClothing || {}
          });
        }
      }
    } else {
      // PARALLEL MODE (default) - faster but no incremental consistency
      log.debug(`🖼️ [UNIFIED] Using PARALLEL image generation (5 concurrent)`);
      const imageLimit = pLimit(5);
      // Even in parallel mode, pass forceRepairThreshold if set
      const parallelIncrConfig = incrementalConsistencyConfig?.forceRepairThreshold != null
        ? { forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold }
        : null;
      allImages = await Promise.all(
        expandedScenes.map((scene, index) => imageLimit(() => generatePageImage(scene, index, parallelIncrConfig)))
      );
    }

    timing.pagesEnd = Date.now();
    const imgSuccess = allImages.filter(p => p.imageData).length;
    log.debug(`📖 [UNIFIED] Generated ${imgSuccess}/${allImages.length} page images`);
    log.debug(`⏱️ [UNIFIED] Page images: ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s`);
    genLog.info('images_complete', `Generated ${imgSuccess}/${allImages.length} page images in ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s`);

    // Wait for cover images if still running (they ran parallel with page images)
    if (coverAwaitPromise) {
      if (!timing.coversEnd) {
        genLog.setStage('covers');
        log.debug(`⏳ [UNIFIED] Waiting for cover images to finish (page images done first)...`);
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [95, 'Finishing cover images...', jobId]
        );
      }
      await coverAwaitPromise;

      // Run bbox detection on covers for entity consistency checks
      try {
        await detectBboxOnCovers(coverImages, inputData.characters);
      } catch (bboxErr) {
        log.warn(`⚠️ [UNIFIED] Cover bbox detection failed: ${bboxErr.message}`);
      }
    }

    timing.end = Date.now();

    // Log timing summary
    log.debug(`⏱️ [UNIFIED] Timing summary:`);
    log.debug(`   Story generation: ${((timing.storyGenEnd - timing.storyGenStart) / 1000).toFixed(1)}s`);
    if (timing.coversEnd) {
      log.debug(`   Cover images:     ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
    }
    log.debug(`   Page images:      ${((timing.pagesEnd - timing.pagesStart) / 1000).toFixed(1)}s`);
    log.debug(`   TOTAL:            ${((timing.end - timing.start) / 1000).toFixed(1)}s`);

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiTextCost = calculateCost('gemini_text', tokenUsage.gemini_text.input_tokens, tokenUsage.gemini_text.output_tokens, tokenUsage.gemini_text.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    // Calculate image costs using per-image pricing (not token-based)
    const byFunc = tokenUsage.byFunction;
    const getModels = (func) => Array.from(func.models).join(', ') || func.provider || 'unknown';
    const imageCost = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed']
      .reduce((sum, fn) => sum + (byFunc[fn]?.calls > 0 ? calculateImageCost(getModels(byFunc[fn]), byFunc[fn].calls) : 0), 0);
    const totalCost = anthropicCost.total + geminiTextCost.total + imageCost + geminiQualityCost.total;

    log.debug(`📊 [UNIFIED] Token usage & cost summary:`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` + ${tokenUsage.anthropic.thinking_tokens.toLocaleString()} think` : '';
    const thinkingTextStr = tokenUsage.gemini_text.thinking_tokens > 0 ? ` + ${tokenUsage.gemini_text.thinking_tokens.toLocaleString()} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` + ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString()} think` : '';
    log.debug(`   Anthropic:      ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr}  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Text:    ${tokenUsage.gemini_text.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_text.output_tokens.toLocaleString().padStart(8)} out${thinkingTextStr}  $${geminiTextCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:   ${tokenUsage.gemini_image.calls} images  $${imageCost.toFixed(4)}`);
    log.debug(`   Gemini Quality: ${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr}  $${geminiQualityCost.total.toFixed(4)}`);

    // Log by function
    log.debug(`   BY FUNCTION:`);
    // Use first model for cost calculation (model-specific pricing), fall back to provider
    const getCostModel = (func) => func.models?.size > 0 ? Array.from(func.models)[0] : (func.provider || 'anthropic');

    if (byFunc.unified_story?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.unified_story), byFunc.unified_story.input_tokens, byFunc.unified_story.output_tokens, byFunc.unified_story.thinking_tokens);
      const thinkStr = byFunc.unified_story.thinking_tokens > 0 ? ` + ${byFunc.unified_story.thinking_tokens.toLocaleString()} think` : '';
      log.debug(`   Unified Story: ${byFunc.unified_story.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.unified_story.output_tokens.toLocaleString().padStart(8)} out${thinkStr} (${byFunc.unified_story.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.unified_story)}]`);
    }
    if (byFunc.scene_expansion?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_expansion), byFunc.scene_expansion.input_tokens, byFunc.scene_expansion.output_tokens, byFunc.scene_expansion.thinking_tokens);
      log.debug(`   Scene Expand:  ${byFunc.scene_expansion.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_expansion.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_expansion.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_expansion)}]`);
    }
    if (byFunc.cover_images?.calls > 0) {
      const model = getModels(byFunc.cover_images);
      const cost = calculateImageCost(model, byFunc.cover_images.calls);
      log.debug(`   Cover Images:  ${byFunc.cover_images.calls} images  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.cover_quality?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images?.calls > 0) {
      const model = getModels(byFunc.page_images);
      const cost = calculateImageCost(model, byFunc.page_images.calls);
      log.debug(`   Page Images:   ${byFunc.page_images.calls} images  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.page_quality?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    if (byFunc.inpaint?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.inpaint), byFunc.inpaint.input_tokens, byFunc.inpaint.output_tokens, byFunc.inpaint.thinking_tokens);
      log.debug(`   Inpaint:       ${byFunc.inpaint.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.inpaint.output_tokens.toLocaleString().padStart(8)} out (${byFunc.inpaint.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.inpaint)}]`);
    }

    const thinkingTotal = totalThinkingTokens > 0 ? ` + ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);

    log.debug(`📝 [UNIFIED] Updating job status to 95% (finalizing)...`);
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [95, 'Finalizing story...', jobId]
    );

    // =========================================================================
    // FINAL CONSISTENCY CHECKS (if enabled)
    // =========================================================================
    let finalChecksReport = null;
    let originalStoryText = null; // Will store original text if corrections are applied
    if (enableFinalChecks && !skipImages && allImages.length >= 2) {
      try {
        genLog.setStage('final_checks');
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [97, 'Running final consistency checks...', jobId]
        );
        log.info(`🔍 [UNIFIED] Running final consistency checks...`);

        // Run image consistency checks - include scene context for accurate evaluation
        const imageCheckData = {
          sceneImages: allImages.map((img, idx) => {
            // Extract metadata from scene description (characters, clothing, objects)
            const metadata = extractSceneMetadata(img.description) || {};

            // Extract scene summary
            // New JSON format: use imageSummary from fullData
            // Legacy format: text before the ```json block
            let sceneSummary = '';
            if (metadata.fullData?.imageSummary) {
              sceneSummary = metadata.fullData.imageSummary.substring(0, 150);
            } else if (img.description) {
              const beforeJson = img.description.split('```json')[0].trim();
              const lines = beforeJson.split('\n').filter(l => l.trim() && !l.startsWith('#'));
              sceneSummary = lines[0]?.substring(0, 150) || '';
            }

            // Prefer stored sceneCharacterClothing (from page generation) over metadata extraction
            // sceneCharacterClothing has the actual clothing used, e.g., {"Lukas": "costumed:pirate", "Sophie": "winter"}
            const perCharClothing = img.sceneCharacterClothing || metadata.characterClothing || {};

            return {
              imageData: img.imageData,
              pageNumber: img.pageNumber || idx + 1,
              characters: metadata.characters || [],  // Which characters appear in this scene
              clothing: metadata.clothing || 'standard',  // Clothing category for this scene (legacy)
              characterClothing: perCharClothing,  // Per-character clothing for entity grouping
              sceneSummary,  // Brief description of what's in the scene
              // Also include character names from reference photos as fallback
              referenceCharacters: (img.referencePhotos || []).map(p => p.name).filter(Boolean),
              // Include per-character clothing from referencePhotos if available
              referenceClothing: (img.referencePhotos || []).reduce((acc, p) => {
                if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
                return acc;
              }, {}),
              // Include retryHistory for entity consistency check (has bbox detection)
              retryHistory: img.retryHistory || []
            };
          })
        };

        // Add cover images to consistency check (use page numbers after story pages)
        const coverSceneImages = buildCoverSceneImages(
          coverImages,
          inputData.characters || [],
          allImages.length  // Base: frontCover = length+1, initialPage = length+2, backCover = length+3
        );
        if (coverSceneImages.length > 0) {
          imageCheckData.sceneImages.push(...coverSceneImages);
          log.debug(`📊 [UNIFIED FINAL CHECKS] Added ${coverSceneImages.length} cover images to consistency check (pages ${coverSceneImages.map(c => c.pageNumber).join(', ')})`);
        }

        // LEGACY: Full-image consistency check
        const legacyReport = await runFinalConsistencyChecks(imageCheckData, inputData.characters || [], {
          checkCharacters: true
        });

        // Track legacy check token usage
        if (legacyReport?.tokenUsage) {
          addUsage('gemini_quality', {
            input_tokens: legacyReport.tokenUsage.inputTokens || 0,
            output_tokens: legacyReport.tokenUsage.outputTokens || 0
          }, 'consistency_check', legacyReport.tokenUsage.model || 'gemini-2.5-flash');
        }

        // NEW: Entity-grouped consistency check (stores grids for review)
        log.info('🔍 [UNIFIED] Running entity-grouped consistency checks...');
        const entityReport = await runEntityConsistencyChecks(imageCheckData, inputData.characters || [], {
          checkCharacters: true,
          checkObjects: false,  // Objects not yet implemented
          minAppearances: 2,
          saveGrids: false  // Grids stored in report instead
        });

        // Track entity check token usage
        if (entityReport?.tokenUsage) {
          addUsage('gemini_quality', {
            input_tokens: entityReport.tokenUsage.inputTokens || 0,
            output_tokens: entityReport.tokenUsage.outputTokens || 0
          }, 'entity_consistency_check', entityReport.tokenUsage.model || 'gemini-2.5-flash');
        }

        // Combine reports: entity as primary, legacy as fallback
        finalChecksReport = {
          ...legacyReport,
          entity: entityReport,
          legacy: {
            imageChecks: legacyReport.imageChecks,
            summary: legacyReport.summary
          },
          // Use entity issues as primary if available
          totalIssues: (entityReport?.totalIssues || 0) + (legacyReport?.totalIssues || 0),
          overallConsistent: (entityReport?.overallConsistent ?? true) && (legacyReport?.overallConsistent ?? true),
          summary: entityReport?.summary || legacyReport?.summary
        };

        // =====================================================================
        // AUTO-REGENERATE IMAGES WITH CONSISTENCY ISSUES
        // =====================================================================
        if (finalChecksReport?.imageChecks?.length > 0 && !inputData.skipConsistencyRegen) {
          const pagesToRegenerate = new Set();
          const pageIssueMap = new Map(); // pageNum -> issues[]

          // Collect pages with high severity issues only (medium severity not auto-regenerated)
          // Use pagesToFix (new) or fall back to images (legacy) for which pages to regenerate
          for (const check of finalChecksReport.imageChecks) {
            for (const issue of (check.issues || [])) {
              const pagesToFix = issue.pagesToFix || issue.images || [];
              log.debug(`🔍 [CONSISTENCY REGEN] Issue: type=${issue.type}, severity=${issue.severity || 'MISSING'}, pagesToFix=${JSON.stringify(pagesToFix)}, images=${JSON.stringify(issue.images)}`);
              if (!issue.severity) {
                log.warn(`⚠️ [CONSISTENCY] Issue ${issue.type} missing severity field, skipping`);
              }
              if (issue.severity === 'high') {
                for (const pageNum of pagesToFix) {
                  pagesToRegenerate.add(pageNum);
                  if (!pageIssueMap.has(pageNum)) pageIssueMap.set(pageNum, []);
                  pageIssueMap.get(pageNum).push(issue);
                }
              }
            }
          }

          // Filter out cover pages (those beyond story pages) - covers use different generation flow
          const totalStoryPages = allImages.length;
          const coverPageNumbers = [...pagesToRegenerate].filter(p => p > totalStoryPages);
          if (coverPageNumbers.length > 0) {
            log.info(`📋 [CONSISTENCY REGEN] Skipping ${coverPageNumbers.length} cover page(s) (${coverPageNumbers.join(', ')}) - covers require separate regeneration`);
            for (const coverPage of coverPageNumbers) {
              pagesToRegenerate.delete(coverPage);
            }
          }

          if (pagesToRegenerate.size === 0 && finalChecksReport.totalIssues > 0) {
            log.info(`📋 [CONSISTENCY REGEN] No pages selected for regeneration (${finalChecksReport.totalIssues} issues found but none with high severity)`);
          }

          if (pagesToRegenerate.size > 0) {
            log.info(`🔄 [CONSISTENCY REGEN] Regenerating ${pagesToRegenerate.size} page(s) with issues: ${[...pagesToRegenerate].join(', ')}`);
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [98, `Fixing ${pagesToRegenerate.size} consistency issue(s)...`, jobId]
            );

            for (const pageNum of pagesToRegenerate) {
              try {
              const pageIssues = pageIssueMap.get(pageNum);
              const pageIndex = pageNum - 1;
              const existingImage = allImages.find(img => img.pageNumber === pageNum);

              if (!existingImage) {
                log.warn(`⚠️ [CONSISTENCY REGEN] Page ${pageNum} not found, skipping`);
                continue;
              }

              // Build correction notes from issues (include canonicalVersion for clear target)
              const correctionNotes = pageIssues.map(issue => {
                let note = `- ${issue.type.toUpperCase()}${issue.characterInvolved ? ` (${issue.characterInvolved})` : ''}: ${issue.description}`;
                if (issue.canonicalVersion) {
                  note += `\n  TARGET: ${issue.canonicalVersion}`;
                }
                note += `\n  FIX: ${issue.recommendation}`;
                return note;
              }).join('\n\n');

              // Re-expand scene using unified 3-step prompt with correction notes
              log.info(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Re-expanding with unified 3-step prompt and corrections...`);

              // Reuse existing quality evaluation as preview feedback (avoids duplicate vision call)
              let previewFeedback = null;
              if (existingImage.qualityReasoning) {
                previewFeedback = { composition: existingImage.qualityReasoning };
                log.debug(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Using existing evaluation as preview feedback`);
              }

              // Get short scene hint for re-expansion (NOT the already-expanded description)
              // The outlineExtract contains the original short scene summary like "Sophie finds a magic key"
              // Using the expanded description would cause "double expansion" - distorting the scene
              let sceneHint = existingImage.outlineExtract || '';
              if (sceneHint) {
                log.debug(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Using original scene hint for re-expansion`);
              } else {
                // Fallback to description/prompt if no scene hint available (shouldn't happen in unified flow)
                sceneHint = existingImage.description || existingImage.prompt || '';
                log.warn(`⚠️ [CONSISTENCY REGEN] [PAGE ${pageNum}] No scene hint available, using expanded description as fallback`);
              }
              if (typeof sceneHint !== 'string') {
                log.warn(`⚠️ [CONSISTENCY REGEN] Page ${pageNum} has non-string scene hint (${typeof sceneHint}), using prompt instead`);
                sceneHint = typeof existingImage.prompt === 'string' ? existingImage.prompt : '';
              }
              if (!sceneHint) {
                log.warn(`⚠️ [CONSISTENCY REGEN] Page ${pageNum} has no scene hint or description, skipping`);
                continue;
              }

              // Use the full description (not hint) for character detection since it has more detail
              const fullDescription = existingImage.description || sceneHint;
              const sceneCharacters = getCharactersInScene(fullDescription, inputData.characters);

              // Build context for unified 3-step scene description prompt (same as original generation)
              const pageText = existingImage.text || '';
              // Build previous scenes context from allImages (which have descriptions)
              const previousScenes = allImages
                .filter(img => img.pageNumber < pageNum)
                .sort((a, b) => b.pageNumber - a.pageNumber)
                .slice(0, 2)
                .map(img => ({
                  pageNumber: img.pageNumber,
                  summary: img.description?.substring(0, 200) || ''
                }));
              const clothingDataForPrompt = clothingRequirements || {};
              // Build available avatars - only show clothing categories used in this story
              const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);
              const expansionPrompt = buildSceneDescriptionPrompt(
                pageNum,
                pageText || sceneHint,  // Fallback to scene hint if no page text
                sceneCharacters,
                sceneHint,  // Use as shortSceneDesc
                inputData.language,
                visualBible,
                previousScenes,
                clothingDataForPrompt,
                correctionNotes,
                availableAvatars,
                null,  // rawOutlineContext
                previewFeedback  // Pass existing image analysis for comparison
              );

              const expandedDescriptionResult = await callClaudeAPI(expansionPrompt, 10000, modelOverrides?.sceneIterationModel, { prefill: '{"previewMismatches":[' });

              // Track token usage for scene expansion (Issue #1 fix)
              if (expandedDescriptionResult?.usage) {
                addUsage('anthropic', expandedDescriptionResult.usage, 'consistency_regen_expansion', expandedDescriptionResult.modelId);
              }

              // Validate expansion result (Issue #2 fix)
              if (!expandedDescriptionResult?.text) {
                log.warn(`⚠️ [CONSISTENCY REGEN] Page ${pageNum} expansion failed, skipping`);
                continue;
              }
              const expandedDescription = expandedDescriptionResult.text;

              // Get reference photos for this scene with CORRECT clothing
              // Use NEW expanded description for metadata (Issue #3 fix)
              const sceneMetadataForClothing = extractSceneMetadata(expandedDescription) || {};

              // Build per-character clothing requirements for this page
              // Priority: 1) per-character from scene metadata, 2) story-level clothingRequirements, 3) existingImage.clothing, 4) 'standard'
              const pageClothingReqs = {};

              // First, add story-level requirements
              if (clothingRequirements) {
                for (const [charName, reqs] of Object.entries(clothingRequirements)) {
                  if (reqs && reqs._currentClothing) {
                    pageClothingReqs[charName] = { _currentClothing: reqs._currentClothing };
                  }
                }
              }

              // Override with per-character clothing from scene metadata (new JSON format)
              if (sceneMetadataForClothing.characterClothing && Object.keys(sceneMetadataForClothing.characterClothing).length > 0) {
                for (const [charName, clothing] of Object.entries(sceneMetadataForClothing.characterClothing)) {
                  pageClothingReqs[charName] = { _currentClothing: clothing };
                }
              }

              // Determine default clothing for getCharacterPhotoDetails (for characters not in the map)
              // Priority: existingImage.clothing, first character's clothing from metadata, or 'standard'
              let originalClothing = existingImage.clothing;
              if (!originalClothing && sceneMetadataForClothing.characterClothing) {
                const firstCharClothing = Object.values(sceneMetadataForClothing.characterClothing)[0];
                originalClothing = firstCharClothing || 'standard';
              }
              if (!originalClothing) {
                originalClothing = sceneMetadataForClothing.clothing || 'standard'; // Legacy fallback
              }

              let clothingCategory = originalClothing;
              let costumeType = null;
              if (originalClothing.startsWith('costumed:')) {
                clothingCategory = 'costumed';
                costumeType = originalClothing.split(':')[1];
              }

              const clothingDebug = Object.keys(pageClothingReqs).length > 0
                ? Object.entries(pageClothingReqs).map(([n, r]) => `${n}:${r._currentClothing}`).join(', ')
                : originalClothing;
              log.debug(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Using clothing: ${clothingDebug}`);
              let pagePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, costumeType, inputData.artStyle, pageClothingReqs);
              pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);

              // Get landmark photos (loads selected variant on-demand for Swiss landmarks)
              const sceneMetadata = extractSceneMetadata(expandedDescription);
              const pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata);

              // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
              // VB elements are NO LONGER added individually to referencePhotos
              const elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
              const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
              let vbGrid = null;
              if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
                vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
                log.debug(`🔲 [CONSISTENCY REGEN] Page ${pageNum} VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
              }

              // Only character photos go in allReferencePhotos (no VB elements)
              const allReferencePhotos = pagePhotos;

              // Build new image prompt
              const imagePrompt = buildImagePrompt(
                expandedDescription,
                inputData,
                sceneCharacters,
                false,
                visualBible,
                pageNum,
                true,
                allReferencePhotos
              );

              // Usage tracker for consistency regen
              const regenUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
                if (imgUsage) addUsage('gemini_image', imgUsage, 'consistency_regen', imgModel);
                if (qualUsage) addUsage('gemini_quality', qualUsage, 'consistency_regen_quality', qualModel);
              };

              // Regenerate with quality retry
              // Pass vbGrid for combined reference (instead of individual VB element photos)
              log.info(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Generating new image...`);
              const imageResult = await generateImageWithQualityRetry(
                imagePrompt,
                allReferencePhotos,
                pageNum > 1 ? allImages[pageIndex - 1]?.imageData : null,
                'scene',
                null,
                regenUsageTracker,
                null,
                { imageModel: modelOverrides?.imageModel, qualityModel: modelOverrides?.qualityModel },
                `PAGE ${pageNum} (consistency fix)`,
                { isAdmin: false, enableAutoRepair: false, useGridRepair: false, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata: sceneMetadataForClothing }
              );

              // Track scene rewrite usage if a safety block triggered a rewrite
              if (imageResult?.rewriteUsage) {
                addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
              }

              if (imageResult?.imageData) {
                // Summarize avatar info (without base64 data)
                const avatarsUsed = pagePhotos.map(p => ({
                  name: p.name,
                  hasPhoto: p.hasPhoto,
                  category: p.category,
                  photoType: p.photoType
                }));

                // Store original image and prompt before replacing (with retry history for dev mode)
                existingImage.consistencyRegen = {
                  originalImage: existingImage.imageData,
                  originalPrompt: existingImage.prompt,
                  originalDescription: existingImage.description,
                  fixedImage: imageResult.imageData,
                  fixedPrompt: imagePrompt,
                  fixedDescription: expandedDescription,
                  correctionNotes: correctionNotes,
                  issues: pageIssues,
                  score: imageResult.score,
                  timestamp: new Date().toISOString(),
                  retryHistory: imageResult.retryHistory || [],
                  totalAttempts: imageResult.totalAttempts || 1,
                  wasRegenerated: imageResult.wasRegenerated || false,
                  clothing: originalClothing,
                  avatarsUsed: avatarsUsed
                };

                // Replace with fixed image
                // Debug: Log image data hash to verify different images are generated
                const oldHash = existingImage.imageData ? existingImage.imageData.slice(-20) : 'none';
                const newHash = imageResult.imageData ? imageResult.imageData.slice(-20) : 'none';
                log.debug(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] existingImage.pageNumber=${existingImage.pageNumber}, arrayIndex=${allImages.indexOf(existingImage)}`);
                log.debug(`🔄 [CONSISTENCY REGEN] [PAGE ${pageNum}] Image hash: ${oldHash} -> ${newHash}`);

                // Add consistency regen as a new version
                // Note: original image is already saved as versionIndex 0 via img.imageData
                // in saveStoryData, so we don't duplicate it into imageVersions
                if (!existingImage.imageVersions) {
                  existingImage.imageVersions = [];
                }
                // Add consistency-fixed image as new version
                existingImage.imageVersions.push({
                  imageData: imageResult.imageData,
                  prompt: imagePrompt,
                  description: expandedDescription,
                  qualityScore: imageResult.score,
                  qualityReasoning: imageResult.reasoning || null,
                  fixTargets: imageResult.fixTargets || [],
                  totalAttempts: imageResult.totalAttempts || null,
                  generatedAt: new Date().toISOString(),
                  source: 'consistency-regen'
                });

                // NOTE: Do NOT copy to existingImage.imageData - that would cause the image
                // to be saved twice (once as version 0, once in imageVersions). The new image
                // is stored in imageVersions and activeVersion meta points to it.
                // Keep metadata on main object for display purposes.
                existingImage.prompt = imagePrompt;
                existingImage.description = expandedDescription;
                existingImage.qualityScore = imageResult.score;
                log.info(`✅ [CONSISTENCY REGEN] [PAGE ${pageNum}] Added new version (score: ${imageResult.score || 'N/A'}%, version ${existingImage.imageVersions.length})`);

                log.debug(`💾 [CONSISTENCY REGEN] [PAGE ${pageNum}] New version added to imageVersions (will be saved with story)`);
              } else {
                log.warn(`⚠️ [CONSISTENCY REGEN] [PAGE ${pageNum}] Regeneration failed, keeping original`);
              }
              } catch (pageErr) {
                // Issue #4 fix: Catch per-page errors so other pages can still regenerate
                log.error(`❌ [CONSISTENCY REGEN] [PAGE ${pageNum}] Error during regeneration: ${pageErr.message}`);
                log.debug(`   Stack: ${pageErr.stack?.split('\n').slice(0, 3).join(' -> ')}`);
                // Continue to next page
              }
            }

            // Track which pages were regenerated (skip redundant re-check - each image already evaluated)
            finalChecksReport.pagesRegenerated = [...pagesToRegenerate];
            log.info(`📋 [CONSISTENCY REGEN] Regeneration complete for ${pagesToRegenerate.size} page(s)`);

            // Note: story_images cleanup skipped during initial generation
            // The story doesn't exist in the database yet, so there are no stale entries to delete
            // story_images entries are only created when explicitly saving individual images later

            // Debug: Verify all images have unique data after consistency regen
            const imageHashes = allImages.map(img => ({
              page: img.pageNumber,
              hash: img.imageData ? img.imageData.slice(-20) : 'none'
            }));
            const hashGroups = {};
            for (const { page, hash } of imageHashes) {
              if (!hashGroups[hash]) hashGroups[hash] = [];
              hashGroups[hash].push(page);
            }
            const duplicates = Object.entries(hashGroups).filter(([, pages]) => pages.length > 1);
            if (duplicates.length > 0) {
              log.warn(`⚠️ [CONSISTENCY REGEN] DUPLICATE IMAGES DETECTED: ${JSON.stringify(duplicates.map(([hash, pages]) => ({ hash, pages })))}`);
            } else {
              log.debug(`✅ [CONSISTENCY REGEN] All ${allImages.length} images have unique data`);
            }
          }
        }

        // Await text consistency check (started early, in parallel with image generation)
        if (textCheckPromise) {
          log.debug(`📝 [UNIFIED] Awaiting early text consistency check result...`);
          const textCheck = await textCheckPromise;
          if (textCheck) {
            // Track token usage for text check
            if (textCheck.usage) {
              const textCheckProvider = unifiedModelId?.startsWith('gemini') ? 'gemini_text' : 'anthropic';
              addUsage(textCheckProvider, {
                input_tokens: textCheck.usage.input_tokens || 0,
                output_tokens: textCheck.usage.output_tokens || 0
              }, 'text_check', unifiedModelId);
            }
            // Add original text to textCheck for display
            textCheck.fullOriginalText = fullStoryText;
            finalChecksReport.textCheck = textCheck;
            if (textCheck.quality !== 'good') {
              finalChecksReport.overallConsistent = false;
            }
            finalChecksReport.totalIssues += textCheck.issues?.length || 0;

            // Auto-apply text corrections if available
            if (textCheck.fullCorrectedText && textCheck.issues?.length > 0) {
              log.info(`✏️  [UNIFIED] Applying ${textCheck.issues.length} text correction(s) to story`);
              originalStoryText = fullStoryText; // Preserve original for dev mode
              fullStoryText = textCheck.fullCorrectedText; // Apply corrected text
              finalChecksReport.textCorrectionApplied = true;
            }
          }
        }

        // Log results to generation log
        genLog.info('final_checks_result', `Final checks: ${finalChecksReport.summary}`, null, {
          imageChecks: finalChecksReport.imageChecks?.length || 0,
          textCheck: finalChecksReport.textCheck ? 'completed' : 'skipped',
          textCorrectionApplied: finalChecksReport.textCorrectionApplied || false,
          totalIssues: finalChecksReport.totalIssues || 0,
          overallConsistent: finalChecksReport.overallConsistent,
          summary: finalChecksReport.summary
        });

        log.info(`📋 [UNIFIED] Final checks complete: ${finalChecksReport.summary}`);
      } catch (checkErr) {
        log.error('❌ [UNIFIED] Final checks failed:', checkErr.message);
        genLog.error('final_checks_failed', checkErr.message);
        // Non-fatal - story generation continues
      }
    }

    // Log API usage to generationLog BEFORE saving story (so it's included in the saved data)
    genLog.setStage('finalize');
    log.debug(`📊 [UNIFIED] Logging API usage to generationLog. Functions with calls:`);
    // Image generation functions use per-image pricing, not token-based
    const IMAGE_FUNCTIONS = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed'];
    for (const [funcName, funcData] of Object.entries(byFunc)) {
      log.debug(`   - ${funcName}: ${funcData.calls} calls, ${funcData.input_tokens} in, ${funcData.output_tokens} out, thinking: ${funcData.thinking_tokens || 0}`);
      if (funcData.calls > 0) {
        const model = getModels(funcData);
        const directCost = funcData.direct_cost || 0;
        let cost;
        if (directCost > 0) {
          cost = directCost;
        } else if (IMAGE_FUNCTIONS.includes(funcName)) {
          cost = calculateImageCost(model, funcData.calls);
        } else {
          cost = calculateCost(getCostModel(funcData), funcData.input_tokens, funcData.output_tokens, funcData.thinking_tokens).total;
        }
        log.debug(`   >>> genLog.apiUsage('${funcName}', '${model}', {in: ${funcData.input_tokens}, out: ${funcData.output_tokens}}, cost: $${cost.toFixed(4)})`);
        genLog.apiUsage(funcName, model, {
          inputTokens: funcData.input_tokens,
          outputTokens: funcData.output_tokens,
          thinkingTokens: funcData.thinking_tokens,
          directCost: directCost
        }, cost);
      }
    }
    // Add total cost summary to generation log
    genLog.info('total_cost', `💰 Total API cost: $${totalCost.toFixed(4)}`, null, {
      totalCost: totalCost,
      totalInputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0),
      totalOutputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0),
      runwareCost: tokenUsage.runware?.direct_cost || 0
    });
    genLog.finalize();
    log.debug(`📊 [UNIFIED] genLog now has ${genLog.getEntries().length} entries (including API usage)`);

    // Compute quality aggregates for analytics
    const qualityScores = allImages
      .map(img => img.qualityScore)
      .filter(s => s != null && !isNaN(s));
    const avgQualityScore = qualityScores.length > 0
      ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
      : null;
    const minQualityScore = qualityScores.length > 0 ? Math.min(...qualityScores) : null;
    const maxQualityScore = qualityScores.length > 0 ? Math.max(...qualityScores) : null;
    const firstAttemptPassRate = allImages.length > 0
      ? Math.round(allImages.filter(img => !img.totalAttempts || img.totalAttempts <= 1).length / allImages.length * 100)
      : null;
    const totalRetries = allImages.reduce((sum, img) => sum + Math.max(0, (img.totalAttempts || 1) - 1), 0);
    const pagesWithIssues = qualityScores.filter(s => s < 70).length;
    const contentBlocked = allImages.reduce((sum, img) =>
      sum + (img.retryHistory?.filter(r => r.blocked)?.length || 0), 0);

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: title,
      storyType: inputData.storyType || '',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
      artStyle: inputData.artStyle || 'pixar',
      language: inputData.language || 'en',
      languageLevel: inputData.languageLevel || '1st-grade',
      pages: inputData.pages || sceneCount,
      dedication: inputData.dedication || '',
      season: inputData.season || '', // Season when story takes place
      userLocation: inputData.userLocation || null, // User's location for personalization
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      outline: unifiedResult.text, // Full unified response
      outlinePrompt: unifiedPrompt, // Prompt sent to API (dev mode)
      outlineModelId: unifiedModelId, // Model used (dev mode)
      outlineUsage: unifiedUsage, // Token usage (dev mode)
      storyTextPrompts: [], // Not used in unified mode (single prompt generates all)
      visualBible: visualBible, // Recurring visual elements for consistency
      styledAvatarGeneration: getStyledAvatarGenerationLog(), // Styled avatar generation log (dev mode)
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(), // Costumed avatar generation log (dev mode)
      storyText: fullStoryText, // May be corrected text if text check found issues
      originalStory: originalStoryText || fullStoryText, // Store original AI text for dev mode
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      pageClothing: pageClothingData, // Clothing per page
      clothingRequirements: clothingRequirements, // Per-character clothing requirements
      tokenUsage: JSON.parse(JSON.stringify(tokenUsage, (k, v) => v instanceof Set ? [...v] : v)), // Token usage (Sets to Arrays)
      generationLog: genLog.getEntries(), // Generation log for dev mode
      finalChecksReport: finalChecksReport || null, // Final consistency checks report (dev mode)
      analytics: {
        // Cost
        totalCost,
        // Timing (ms)
        totalDurationMs: timing.end - timing.start,
        storyGenDurationMs: timing.storyGenEnd - timing.storyGenStart,
        imagesDurationMs: timing.pagesEnd - timing.pagesStart,
        coversDurationMs: timing.coversEnd ? timing.coversEnd - (timing.coversStart || timing.storyGenEnd) : null,
        // Quality
        avgQualityScore,
        minQualityScore,
        maxQualityScore,
        firstAttemptPassRate,
        totalRetries,
        pagesWithIssues,
        contentBlocked,
        // Counts
        characterCount: (inputData.characters || []).length,
        sceneCount: allImages.length,
        coverCount: Object.keys(coverImages || {}).filter(k => coverImages[k]?.imageData || coverImages[k]?.hasImage).length,
        // Pipeline config
        pipelineConfig: {
          enableQualityRetry,
          enableAutoRepair,
          useGridRepair,
          enableFinalChecks,
          separatedEvaluation,
          enableSceneValidation,
          incrementalConsistency: !!incrementalConsistencyConfig,
          checkOnlyMode,
        },
        // Models used
        models: {
          text: unifiedModelId,
          image: byFunc.page_images?.models ? Array.from(byFunc.page_images.models) : [],
          quality: byFunc.page_quality?.models ? Array.from(byFunc.page_quality.models) : [],
          sceneExpansion: byFunc.scene_expansion?.models ? Array.from(byFunc.scene_expansion.models) : [],
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Debug: Log what's being saved for storyCategory/storyTheme in unified mode
    log.debug(`📝 [UNIFIED SAVE] storyCategory: "${storyData.storyCategory}", storyTopic: "${storyData.storyTopic}", storyTheme: "${storyData.storyTheme}"`);
    log.debug(`📝 [UNIFIED SAVE] mainCharacters: ${JSON.stringify(storyData.mainCharacters)}, characters count: ${storyData.characters?.length || 0}`);

    log.debug(`💾 [UNIFIED] Saving story to database... (generationLog has ${storyData.generationLog?.length || 0} entries)`);
    await upsertStory(storyId, userId, storyData);
    log.debug(`📚 [UNIFIED] Story ${storyId} saved to stories table`);

    // Initialize image_version_meta with active versions for all pages
    // After consistency regen, the active version is the last one in imageVersions
    if (storyData.sceneImages?.length > 0) {
      for (const scene of storyData.sceneImages) {
        if (scene.imageVersions?.length > 0) {
          const activeIndex = getActiveIndexAfterPush(scene.imageVersions, 'scene');
          await setActiveVersion(storyId, scene.pageNumber, activeIndex);
        }
      }
      log.debug(`📚 [UNIFIED] Initialized image_version_meta for ${storyData.sceneImages.length} pages`);
    }

    // Persist styled avatars to BOTH story data AND characters table
    if (artStyle !== 'realistic' && inputData.characters) {
      try {
        const styledAvatarsMap = exportStyledAvatarsForPersistence(inputData.characters, artStyle);
        if (styledAvatarsMap.size > 0) {
          log.debug(`💾 [UNIFIED] Persisting ${styledAvatarsMap.size} styled avatar sets...`);

          // 1. Save to story data (inputData.characters) - IMPORTANT for repair workflow
          for (const char of inputData.characters) {
            const styledAvatars = styledAvatarsMap.get(char.name) || styledAvatarsMap.get(char.name?.trim());
            if (styledAvatars) {
              if (!char.avatars) char.avatars = {};
              if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
              char.avatars.styledAvatars[artStyle] = styledAvatars;
              log.debug(`   ✓ Story data: ${Object.keys(styledAvatars).length} ${artStyle} avatars for "${char.name}"`);
            }
          }

          // 2. Also save to characters table (for character editor)
          const characterId = `characters_${userId}`;
          const charResult = await dbPool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
          if (charResult.rows.length > 0) {
            // Handle both TEXT and JSONB column types
            const rawData = charResult.rows[0].data;
            const charData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
            const chars = charData.characters || [];
            let updatedCount = 0;
            for (const dbChar of chars) {
              // Match by name (trim to handle trailing spaces)
              const styledAvatars = styledAvatarsMap.get(dbChar.name) || styledAvatarsMap.get(dbChar.name?.trim());
              if (styledAvatars) {
                if (!dbChar.avatars) dbChar.avatars = {};
                if (!dbChar.avatars.styledAvatars) dbChar.avatars.styledAvatars = {};
                dbChar.avatars.styledAvatars[artStyle] = styledAvatars;
                updatedCount++;
              }
            }
            if (updatedCount > 0) {
              charData.characters = chars;
              await dbPool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
              log.debug(`💾 [UNIFIED] Updated ${updatedCount} characters in database with ${artStyle} styled avatars`);
            }
          }
        }
      } catch (persistErr) {
        log.error('❌ [UNIFIED] Failed to persist styled avatars:', persistErr.message);
        // Non-fatal - story generation continues
      }
    }

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
        log.info(`💳 [UNIFIED] Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ [UNIFIED] Failed to log credit completion:', creditErr.message);
    }

    // Build final result
    const resultData = {
      storyId,
      title,
      outline: unifiedResult.text,
      outlinePrompt: unifiedPrompt,
      outlineModelId: unifiedModelId,
      outlineUsage: unifiedUsage,
      storyTextPrompts: [], // Not used in unified mode
      story: fullStoryText,  // Frontend expects 'story' not 'storyText'
      visualBible,
      styledAvatarGeneration: getStyledAvatarGenerationLog(),
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(),
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages,
      tokenUsage,
      estimatedCost: totalCost,
      generationMode: 'unified',
      generationLog: genLog.getEntries(),
      finalChecksReport: finalChecksReport || null
    };

    // Mark job as completed
    // Strip imageData from result_data to keep it lightweight (~10KB vs ~10MB)
    // Images are already saved in story_images table via upsertStory
    const stripImageData = (img) => {
      if (!img) return img;
      const { imageData, ...metadata } = img;
      const stripped = { ...metadata, hasImage: !!imageData };
      // Also strip imageData from imageVersions
      if (stripped.imageVersions) {
        stripped.imageVersions = stripped.imageVersions.map(v => {
          const { imageData: vData, ...vMeta } = v;
          return { ...vMeta, hasImage: !!vData };
        });
      }
      return stripped;
    };
    const resultDataForStorage = {
      ...resultData,
      sceneImages: allImages.map(stripImageData),
      coverImages: coverImages ? {
        frontCover: stripImageData(coverImages.frontCover),
        initialPage: stripImageData(coverImages.initialPage),
        backCover: stripImageData(coverImages.backCover),
      } : coverImages,
    };
    log.debug(`📊 [UNIFIED] resultData generationLog has ${resultData.generationLog?.length || 0} entries`);
    const resultJson = JSON.stringify(resultDataForStorage);
    log.debug(`📊 [UNIFIED] result_data size: ${(resultJson.length / 1024).toFixed(1)}KB (images stripped)`);
    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           credits_reserved = 0, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      ['completed', 100, 'Story generation complete!', resultJson, jobId]
    );

    // Clean up checkpoints immediately - story is saved, no longer needed
    await deleteJobCheckpoints(jobId);

    // Clear styled avatar cache to free memory
    clearStyledAvatarCache();

    log.info(`✅ [UNIFIED] Job ${jobId} completed successfully`);

    // Send story completion email to customer
    try {
      const userResult = await dbPool.query(
        'SELECT email, username, shipping_first_name, preferred_language FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];
        const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
        const emailLanguage = user.preferred_language || inputData.language || 'English';
        await email.sendStoryCompleteEmail(user.email, firstName, title, storyId, emailLanguage);
      }
    } catch (emailErr) {
      log.error('❌ [UNIFIED] Failed to send story complete email:', emailErr);
    }

    return resultData;

  } catch (error) {
    log.error(`❌ [UNIFIED] Error generating story:`, error.message);
    genLog.error('pipeline_error', error.message, null, { stage: genLog.currentStage, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });

    // Try to refund credits on failure
    try {
      const jobRow = await dbPool.query('SELECT credits_reserved, user_id FROM story_jobs WHERE id = $1', [jobId]);
      if (jobRow.rows.length > 0) {
        const creditsToRefund = jobRow.rows[0].credits_reserved || 0;
        const refundUserId = jobRow.rows[0].user_id;

        if (creditsToRefund > 0 && refundUserId) {
          await dbPool.query(
            'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
            [creditsToRefund, refundUserId]
          );
          await dbPool.query(
            'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
            [jobId]
          );
          log.info(`💳 [UNIFIED] Refunded ${creditsToRefund} credits for failed job ${jobId}`);
        }
      }
    } catch (refundErr) {
      log.error('❌ [UNIFIED] Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [error.message, jobId]
    );

    throw error;
  }
}

// Background worker function to process a story generation job
// NEW STREAMING ARCHITECTURE: Generate images as story batches complete
async function processStoryJob(jobId) {
  console.log(`🎬 Starting processing for job ${jobId}`);

  // Generation logger for tracking API usage and debugging
  const genLog = new GenerationLogger();
  genLog.setStage('outline');

  // Clear avatar generation logs for fresh tracking
  clearStyledAvatarGenerationLog();
  clearCostumedAvatarGenerationLog();

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility) - includes thinking_tokens for Gemini 2.5
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // Runware uses direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Avatar generation tracking
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Consistency check tracking
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      // Scene rewrite tracking (when safety blocks trigger rewrites)
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Fallback pricing by provider (uses centralized MODEL_PRICING from server/config/models.js)
  // Note: gemini_image uses per-image pricing, not token pricing - see calculateImageCost
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  // Helper to calculate image generation cost (per-image pricing, not token-based)
  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) {
      return pricing.perImage * imageCount;
    }
    // Fallback to default Gemini image pricing
    return 0.04 * imageCount;
  };

  // Helper to add usage - now supports function-level tracking with model names, thinking tokens, and direct costs
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      // Handle Runware (direct cost) vs token-based providers
      if (provider === 'runware') {
        tokenUsage.runware.direct_cost += usage.direct_cost || 0;
        tokenUsage.runware.calls += 1;
      } else {
        tokenUsage[provider].input_tokens += usage.input_tokens || 0;
        tokenUsage[provider].output_tokens += usage.output_tokens || 0;
        tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
        tokenUsage[provider].calls += 1;
      }
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      const func = tokenUsage.byFunction[functionName];
      func.input_tokens += usage.input_tokens || 0;
      func.output_tokens += usage.output_tokens || 0;
      func.thinking_tokens += usage.thinking_tokens || 0;
      func.direct_cost = (func.direct_cost || 0) + (usage.direct_cost || 0);
      func.calls += 1;
      func.provider = provider; // Track actual provider used
      if (modelName) {
        func.models.add(modelName);
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

    // Debug: Log inputData values when job starts processing
    log.debug(`📝 [JOB PROCESS] storyCategory: "${inputData.storyCategory}", storyTopic: "${inputData.storyTopic}", storyTheme: "${inputData.storyTheme}"`);
    log.debug(`📝 [JOB PROCESS] mainCharacters: ${JSON.stringify(inputData.mainCharacters)}, characters count: ${inputData.characters?.length || 0}`);

    // Fetch full character data from database (job stores stripped metadata)
    // This ensures processing has access to photos and avatar images
    const requestedCharacterIds = (inputData.characters || []).map(c => c.id);
    if (requestedCharacterIds.length > 0 && job.user_id) {
      try {
        const characterRowId = `characters_${job.user_id}`;
        const charResult = await dbPool.query(
          'SELECT data FROM characters WHERE id = $1',
          [characterRowId]
        );
        if (charResult.rows.length > 0 && charResult.rows[0].data) {
          const fullCharData = typeof charResult.rows[0].data === 'string'
            ? JSON.parse(charResult.rows[0].data)
            : charResult.rows[0].data;
          const allChars = Array.isArray(fullCharData) ? fullCharData : (fullCharData.characters || []);

          // Replace stripped characters with full data (preserving request order)
          const fullCharacters = requestedCharacterIds
            .map(id => allChars.find(c => c.id === id))
            .filter(Boolean);

          if (fullCharacters.length > 0) {
            log.debug(`📸 [PROCESS] Loaded full character data for ${fullCharacters.length} characters`);
            // Clear styledAvatars - regenerate fresh per story for consistency
            for (const char of fullCharacters) {
              if (char.avatars) {
                char.avatars.styledAvatars = {};
              }
            }
            inputData.characters = fullCharacters;
          }
        }
      } catch (dbErr) {
        log.warn(`📸 [PROCESS] Failed to load character data from DB: ${dbErr.message}`);
      }
    }

    // Inject pre-discovered landmarks if available for this user's location
    // Check landmark_index first (works for any city worldwide), then fall back to in-memory cache
    // Skip for historical stories - they use historically accurate locations, not local landmarks
    if (inputData.userLocation?.city && inputData.storyCategory !== 'historical') {
      const cacheKey = `${inputData.userLocation.city}_${inputData.userLocation.country || ''}`.toLowerCase().replace(/\s+/g, '_');
      let landmarks = null;

      // Check landmark_index table first (works for any city worldwide)
      try {
        const indexedLandmarks = await getIndexedLandmarks(inputData.userLocation.city, 30);
        if (indexedLandmarks.length > 0) {
          // Convert indexed landmarks to the format expected by linkPreDiscoveredLandmarks
          landmarks = indexedLandmarks.map(l => ({
            name: l.name,
            query: l.name,
            type: l.type,
            lat: parseFloat(l.latitude),
            lon: parseFloat(l.longitude),
            score: l.score,
            // Indexed landmarks don't have photoData - they have photoUrl for lazy loading
            photoUrl: l.photo_url,
            photoDescription: l.photo_description,
            attribution: l.photo_attribution,
            wikipediaExtract: l.wikipedia_extract,
            // Flag for lazy photo loading (support both old and new field names)
            isIndexed: true,
            isSwissPreIndexed: true,  // For backward compatibility
            landmarkIndexId: l.id,
            swissLandmarkId: l.id  // For backward compatibility
          }));
          log.info(`[LANDMARK] 📍 Injecting ${landmarks.length} indexed landmarks for ${inputData.userLocation.city}`);
        }
      } catch (indexErr) {
        log.debug(`[LANDMARK] Indexed landmarks lookup failed: ${indexErr.message}`);
      }

      // Fall back to in-memory cache if index didn't have it
      if (!landmarks) {
        const cachedLandmarks = userLandmarkCache.get(cacheKey);
        if (cachedLandmarks && Date.now() - cachedLandmarks.timestamp < LANDMARK_CACHE_TTL) {
          landmarks = cachedLandmarks.landmarks;
          log.info(`[LANDMARK] 📍 Injecting ${landmarks.length} in-memory cached landmarks for ${inputData.userLocation.city}`);
        }
      }

      if (landmarks && landmarks.length > 0) {
        // Select landmark names in story language (using Wikidata variants)
        // Each landmark has variants: [{name: "Ruine Stein", lang: "de"}, {name: "Stein Castle", lang: "en"}]
        if (inputData.language) {
          const baseLang = inputData.language.split('-')[0].toLowerCase();
          for (const landmark of landmarks) {
            if (landmark.variants && landmark.variants.length > 0) {
              // Find variant matching story language
              const match = landmark.variants.find(v => v.lang === baseLang);
              if (match && match.name !== landmark.name) {
                log.debug(`[LANDMARK] Using ${baseLang} name: "${match.name}" (was: "${landmark.name}")`);
                landmark.originalName = landmark.name;
                landmark.name = match.name;
                landmark.query = match.name;
              }
            }
          }
        }
        inputData.availableLandmarks = landmarks;
      } else {
        log.debug(`[LANDMARK] No cached landmarks available for ${inputData.userLocation.city}`);
      }
    } else if (inputData.storyCategory === 'historical') {
      log.debug(`[LANDMARK] Skipping local landmarks for historical story (uses historical locations instead)`);
    }

    const skipImages = inputData.skipImages === true; // Developer mode: text only
    const skipCovers = inputData.skipCovers === true; // Developer mode: skip cover generation
    const enableQualityRetry = inputData.enableQualityRetry === true; // Developer mode: retry on low quality scores (default: OFF)
    const enableAutoRepair = inputData.enableAutoRepair === true; // Developer mode: auto-repair images (default: OFF)
    const useGridRepair = inputData.useGridRepair !== false; // Use grid-based repair (default: ON when autoRepair is on)
    const forceRepairThreshold = typeof inputData.forceRepairThreshold === 'number' ? inputData.forceRepairThreshold : null; // Force repair on pages with issues below this score
    const enableFinalChecks = inputData.enableFinalChecks !== false; // Final consistency checks (default: ON, disable with enableFinalChecks: false)
    const checkOnlyMode = inputData.checkOnlyMode === true; // Developer mode: run checks but skip all regeneration
    const enableSceneValidation = inputData.enableSceneValidation === true; // Developer mode: validate scene composition with cheap preview (default: OFF)
    // Separated Evaluation: Generate all images first, then evaluate/repair in batch
    // This reduces latency and allows smarter repair decisions across all pages
    const separatedEvaluation = inputData.separatedEvaluation === true || MODEL_DEFAULTS.separatedEvaluation === true;
    log.debug(`🔧 [PIPELINE] Scene validation input: ${inputData.enableSceneValidation} (type: ${typeof inputData.enableSceneValidation}), resolved: ${enableSceneValidation}`);
    if (separatedEvaluation) {
      log.info(`🔧 [PIPELINE] Separated evaluation ENABLED - will generate all images first, then batch evaluate`);
    }

    // Incremental consistency check options (check each image against previous N images)
    const incrementalConsistencyOptions = inputData.incrementalConsistency || {};
    const enableIncrementalConsistency = incrementalConsistencyOptions.enabled === true;
    const incrementalConsistencyDryRun = incrementalConsistencyOptions.dryRun === true;
    const incrementalConsistencyLookback = incrementalConsistencyOptions.lookbackCount || 3;
    if (enableIncrementalConsistency) {
      log.debug(`🔍 [PIPELINE] Incremental consistency check ENABLED (lookback: ${incrementalConsistencyLookback}, dryRun: ${incrementalConsistencyDryRun})`);
    }
    if (checkOnlyMode) {
      log.debug(`🔍 [PIPELINE] Check-only mode ENABLED - all regeneration will be skipped`);
    }
    if (enableSceneValidation) {
      log.debug(`🔍 [PIPELINE] Scene validation ENABLED - will generate preview images for composition checks`);
    }

    log.info(`🔧 [PIPELINE] Settings: qualityRetry=${enableQualityRetry}, autoRepair=${enableAutoRepair}, gridRepair=${useGridRepair}, ` +
      `forceRepairThreshold=${forceRepairThreshold}, finalChecks=${enableFinalChecks}, ` +
      `checkOnly=${checkOnlyMode}, sceneValidation=${enableSceneValidation}, ` +
      `separatedEval=${separatedEvaluation}, skipImages=${skipImages}, skipCovers=${skipCovers}, ` +
      `incrementalConsistency=${enableIncrementalConsistency}${enableIncrementalConsistency ? ` (dryRun=${incrementalConsistencyDryRun}, lookback=${incrementalConsistencyLookback})` : ''}`);

    // Check if user is admin (for including debug images in repair history)
    const userResult = await dbPool.query('SELECT role FROM users WHERE id = $1', [job.user_id]);
    const isAdmin = userResult.rows.length > 0 && userResult.rows[0].role === 'admin';

    // Developer mode: model overrides (admin only)
    // Use centralized MODEL_DEFAULTS from textModels.js
    // Filter out null/undefined user overrides so they don't overwrite defaults
    const userOverrides = inputData.modelOverrides || {};
    const filteredUserOverrides = Object.fromEntries(
      Object.entries(userOverrides).filter(([_, v]) => v != null)
    );
    const modelOverrides = {
      outlineModel: MODEL_DEFAULTS.outline,
      textModel: MODEL_DEFAULTS.storyText,
      sceneDescriptionModel: MODEL_DEFAULTS.sceneDescription,
      sceneIterationModel: MODEL_DEFAULTS.sceneIteration,
      imageModel: MODEL_DEFAULTS.pageImage,
      coverImageModel: MODEL_DEFAULTS.coverImage,
      qualityModel: MODEL_DEFAULTS.qualityEval,
      ...filteredUserOverrides  // Only non-null user overrides
    };
    // Always log model defaults being used
    log.debug(`🔧 [PIPELINE] Models: outline=${modelOverrides.outlineModel}, text=${modelOverrides.textModel}, scene=${modelOverrides.sceneDescriptionModel}, sceneIter=${modelOverrides.sceneIterationModel}, quality=${modelOverrides.qualityModel}`);
    if (Object.keys(filteredUserOverrides).length > 0) {
      log.debug(`🔧 [PIPELINE] User overrides applied: ${JSON.stringify(filteredUserOverrides)}`);
    }

    // Determine generation mode:
    // - 'unified' (default): Single prompt + Art Director scene expansion (highest quality)
    // - 'pictureBook': Combined text+scene in single prompt (faster, simpler)
    // - 'outlineAndText': Separate outline + text prompts (legacy mode)
    let generationMode;
    if (inputData.generationMode === 'pictureBook') {
      generationMode = 'pictureBook';
      log.debug(`📚 [PIPELINE] Generation mode override: pictureBook (forced single prompt)`);
    } else if (inputData.generationMode === 'outlineAndText') {
      generationMode = 'outlineAndText';
      log.debug(`📚 [PIPELINE] Generation mode override: outlineAndText (forced outline+text)`);
    } else if (inputData.generationMode === 'unified') {
      generationMode = 'unified';
      log.debug(`📚 [PIPELINE] Generation mode: unified (single prompt + Art Director)`);
    } else {
      // Default: unified mode for all stories (best quality)
      generationMode = 'unified';
      log.debug(`📚 [PIPELINE] Generation mode: unified (default - single prompt + Art Director)`);
    }

    // Get language for scene descriptions (use centralized config)
    const lang = inputData.language || 'en';
    const { getLanguageNameEnglish } = require('./server/lib/languages');
    const langText = getLanguageNameEnglish(lang);

    // Calculate number of story scenes to generate:
    // - Picture Book (1st-grade): 1 scene per page (image + text on same page)
    // - Standard/Advanced: 1 scene per 2 print pages (text page + facing image page)
    const printPages = inputData.pages;  // Total pages when printed
    const isPictureBookLayout = inputData.languageLevel === '1st-grade';
    const sceneCount = isPictureBookLayout ? printPages : Math.floor(printPages / 2);
    log.debug(`📚 [PIPELINE] Print pages: ${printPages}, Mode: ${generationMode}, Scenes to generate: ${sceneCount}`);

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

    // Build incremental consistency config for passing to processing functions
    const incrementalConsistencyConfig = enableIncrementalConsistency ? {
      enabled: true,
      dryRun: incrementalConsistencyDryRun,
      lookbackCount: incrementalConsistencyLookback,
      forceRepairThreshold  // Pass through for image generation
    } : { forceRepairThreshold };  // Even without incremental consistency, pass repair threshold

    // Route to appropriate processing function based on generation mode
    if (generationMode === 'unified') {
      log.debug(`📚 [PIPELINE] Unified mode - single prompt + Art Director scene expansion`);
      return await processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableAutoRepair, useGridRepair, enableFinalChecks, incrementalConsistencyConfig, checkOnlyMode, enableSceneValidation, separatedEvaluation, enableQualityRetry);
    }

    if (generationMode === 'pictureBook') {
      log.debug(`📚 [PIPELINE] Picture Book mode - using combined text+scene generation`);
      return await legacyPipelines.processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableAutoRepair, useGridRepair, enableFinalChecks, incrementalConsistencyConfig, checkOnlyMode, enableSceneValidation);
    }

    // outlineAndText mode (legacy): Separate outline + text generation
    log.debug(`📚 [PIPELINE] OutlineAndText mode - using legacy outline+text pipeline`);
    return await legacyPipelines.processOutlineAndTextJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableAutoRepair, useGridRepair, enableFinalChecks, incrementalConsistencyConfig, checkOnlyMode, enableSceneValidation);

  } catch (error) {
    // Clear styled avatar cache on error too
    clearStyledAvatarCache();

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
          let pageClothingData = null;

          for (const cp of checkpoints) {
            const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

            if (cp.step_name === 'outline') {
              outline = data.outline || '';
              outlinePrompt = data.outlinePrompt || '';
              outlineModelId = data.outlineModelId || null;
              outlineUsage = data.outlineUsage || null;
              // Extract clothing data from outline
              if (outline) {
                try {
                  pageClothingData = extractPageClothing(outline, inputData?.pages || 15);
                } catch (e) {
                  log.debug(`[PARTIAL SAVE] Could not extract clothing: ${e.message}`);
                }
              }
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
                  modelId: data.modelId || null,
                  referencePhotos: data.referencePhotos || null  // For consistency check character names
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
              storyTypeName: inputData?.storyTypeName || '',
              storyCategory: inputData?.storyCategory || '',
              storyTopic: inputData?.storyTopic || '',
              storyTheme: inputData?.storyTheme || '',
              storyDetails: inputData?.storyDetails || '',
              artStyle: inputData?.artStyle || 'pixar',
              language: inputData?.language || 'en',
              languageLevel: inputData?.languageLevel || 'standard',
              pages: inputData?.pages || sceneImages.length,
              dedication: inputData?.dedication || '',
              season: inputData?.season || '',
              userLocation: inputData?.userLocation || null,
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

            await upsertStory(jobId, userId, storyData);
            log.debug(`📚 [PARTIAL SAVE] Saved partial story ${jobId} with ${sceneImages.length} images to stories table`);

            // Initialize image_version_meta with active versions for partial stories
            if (sceneImages?.length > 0) {
              for (const scene of sceneImages) {
                if (scene.imageVersions?.length > 0) {
                  const activeIndex = getActiveIndexAfterPush(scene.imageVersions, 'scene');
                  await setActiveVersion(jobId, scene.pageNumber, activeIndex);
                }
              }
            }
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

// SEO files - serve before SPA fallback to ensure correct content-type
app.get('/robots.txt', (req, res) => {
  const robotsPath = path.join(distPath, 'robots.txt');
  if (hasDistFolder && require('fs').existsSync(robotsPath)) {
    res.type('text/plain').sendFile(robotsPath);
  } else {
    // Fallback inline robots.txt
    res.type('text/plain').send(`User-agent: *\nAllow: /\nAllow: /api/shared/\nDisallow: /api/\nDisallow: /admin/\nSitemap: https://magicalstory.ch/sitemap.xml`);
  }
});

app.get('/sitemap.xml', (req, res) => {
  const sitemapPath = path.join(distPath, 'sitemap.xml');
  if (hasDistFolder && require('fs').existsSync(sitemapPath)) {
    res.type('application/xml').sendFile(sitemapPath);
  } else {
    // Fallback inline sitemap
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://magicalstory.ch/</loc><priority>1.0</priority></url>
</urlset>`);
  }
});

// NOTE: Public shared story routes moved to server/routes/sharing.js

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
  const server = app.listen(PORT, () => {
    console.log(`🚀 MagicalStory Server Running`);
    console.log(`📍 URL: http://localhost:${PORT}`);
  });

  // Configure server timeouts to prevent premature connection closures
  // This helps with Railway's edge proxy and HTTP/2 connection management
  server.keepAliveTimeout = 65000; // 65 seconds (longer than typical proxy timeout of 60s)
  server.headersTimeout = 66000;   // Slightly longer than keepAliveTimeout
  console.log(`🔗 Keep-alive timeout: ${server.keepAliveTimeout}ms`);
}).catch(err => {
  log.error('Failed to initialize server:', err);
  process.exit(1);
});
