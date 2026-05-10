// MagicalStory Backend Server v1.0.4
// Includes: User quota system, email authentication, admin panel, PostgreSQL database support

// Load environment variables from .env file (for local development)
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const helmet = require('helmet');

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

// Pick Stripe client by recorded order mode (NOT current user state).
// Required for refunds: a user's role may change between order and refund;
// refunds must hit the same Stripe account that processed the original PI.
// Legacy orders without stripe_mode are treated as live (admins were rare pre-cutover).
function getStripeClientForOrder(order) {
  const mode = order?.stripe_mode || 'live';
  if (mode === 'test') return stripeTest || stripeLegacy;
  return stripeLive || stripeTest || stripeLegacy;
}

// Helper: Check if user should use test mode
// Admins AND impersonating admins use test mode (Gelato drafts, test Stripe)
function isUserTestMode(user) {
  return user?.role === 'admin' || user?.impersonating === true;
}

// Log Stripe configuration on startup
log.info(`💳 Stripe Configuration:`);
log.info(`   - Test mode (for admins): ${stripeTest || stripeLegacy ? '✅ Configured' : '❌ Not configured'}`);
log.info(`   - Live mode (for users): ${stripeLive ? '✅ Configured' : '❌ Not configured'}`);
if (!stripeLive) {
  log.warn(`   ⚠️  Warning: STRIPE_LIVE_SECRET_KEY not set - all users will use test mode`);
}
const sharp = require('sharp');
const email = require('./email');
// (firebase-admin removed — Google ID-token verification now uses google-auth-library
//  inside server/routes/auth.js and server/routes/trial.js)

// Import modular routes and services
const { initializePool: initModularPool, logActivity, isDatabaseMode, saveStoryData, upsertStory, saveStoryImage, getStoryImage, setActiveVersion, rehydrateStoryImages } = require('./server/services/database');
const { validateBody, schemas, sanitizeString, sanitizeInteger } = require('./server/middleware/validation');
const { authenticateToken } = require('./server/middleware/auth');
const { authLimiter, registerLimiter, apiLimiter, aiProxyLimiter, storyGenerationLimiter, imageRegenerationLimiter } = require('./server/middleware/rateLimit');
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
  runFinalConsistencyChecks,
  generateReferenceSheet,
  buildVisualBibleGrid,
  buildEmptySceneVbGrid,
  IMAGE_QUALITY_THRESHOLD,
  // Separated evaluation pipeline functions
  generateImageOnly,
  evaluateImageBatch,
  // Unified repair pipeline
  runUnifiedRepairPipeline,
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
  runInCacheScope,
  clearStyledAvatarCache,
  invalidateStyledAvatarForCategory,
  getStyledAvatarCacheStats,
  exportStyledAvatarsForPersistence,
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog
} = require('./server/lib/styledAvatars');
const { reconcileCoverClothingWithRequirements } = require('./server/lib/clothingCategories');
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
  IMAGE_MODELS,
  REPAIR_DEFAULTS,
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
  getElementReferenceImagesForPage,
  getElementReferenceImagesByIds
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

// Clean up expired landmark cache entries every hour
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of userLandmarkCache.entries()) {
    if (now - entry.timestamp > LANDMARK_CACHE_TTL) {
      userLandmarkCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) log.debug(`[LANDMARK CACHE] Cleaned ${cleaned} expired entries, ${userLandmarkCache.size} remaining`);
}, 60 * 60 * 1000);
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
  buildTrialStoryPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForPage,
  getLandmarkPhotosForScene,
  extractSceneMetadata,
  stripSceneMetadata,
  getHistoricalLocations,
  preloadHistoricalLocations,
  getHistoricalObjects,
  preloadHistoricalObjects,
  convertClothingToCurrentFormat,
  getPageText,
  updatePageText,
  resolveArtStyle,
  enforceSpreadTextPosition
} = require('./server/lib/storyHelpers');
const { OutlineParser, UnifiedStoryParser, ProgressiveUnifiedParser } = require('./server/lib/outlineParser');
const { createJobHeartbeat } = require('./server/lib/jobHeartbeat');
const { getActiveIndexAfterPush } = require('./server/lib/versionManager');
const legacyPipelines = require('./server/lib/legacyPipelines');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require('./server/lib/generationLogger');
const { hasPhotos: hasCharacterPhotos, getFacePhoto } = require('./server/lib/characterPhotos');
const { generateSitemap } = require('./server/lib/seoMeta');
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
const trialRoutes = require('./server/routes/trial');
const { apiRouter: sharingApiRoutes, htmlRouter: sharingHtmlRoutes, initSharingRoutes } = require('./server/routes/sharing');
const { initSwissStories, getSwissStoriesResponse } = require('./server/lib/swissStories');

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
          log.warn(`🚨 [ISSUE] [COVER BBOX] ${coverType}: MISSING CHARACTERS - ${missingCharacters.join(', ')}`);
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

// (Firebase Admin SDK removed — Google sign-in now uses google-auth-library directly,
//  see server/routes/auth.js POST /api/auth/google and server/routes/trial.js claim flows.)
if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
  log.warn('⚠️  GOOGLE_OAUTH_CLIENT_ID not configured — Google sign-in will reject all requests');
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
  log.info(`🗄️  Database: PostgreSQL (Railway)`);
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

    // Also allow any Railway.app domain (strict suffix check to prevent spoofing)
    const isRailway = origin.endsWith('.railway.app') || origin === 'https://railway.app';
    if (isRailway || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      log.warn('⚠️  CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(require('cookie-parser')());
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

// Apply general rate limit to all API routes (limiters imported from server/middleware/rateLimit.js)
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
      log.info('✅ [STRIPE WEBHOOK] Verified with LIVE webhook secret');
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
      log.info('✅ [STRIPE WEBHOOK] Verified with TEST webhook secret');
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

      log.info('✅ [STRIPE WEBHOOK] Payment successful!');
      log.info('   Session ID:', session.id);
      log.info('   Payment Intent:', session.payment_intent);
      log.info('   Amount:', session.amount_total, session.currency);

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
        log.info('   Email:', customerInfo.email);
        log.debug('   Address:', JSON.stringify(customerInfo.address, null, 2));
        log.debug('   Metadata:', JSON.stringify(fullSession.metadata, null, 2));

        // Check if this is a credits purchase
        if (fullSession.metadata?.type === 'credits') {
          log.debug('💰 [STRIPE WEBHOOK] Processing credits purchase');
          const userId = fullSession.metadata?.userId;

          // SERVER-SIDE VALIDATION: Look up package by amount paid
          const amountPaid = fullSession.amount_total || 0; // in cents
          const pkg = CREDIT_CONFIG.PRICING.PACKAGES.find(p => p.amountCents === amountPaid);
          const metadataCredits = parseInt(fullSession.metadata?.credits) || 0;

          if (!pkg) {
            log.warn(`⚠️ [STRIPE WEBHOOK] No matching package for amount ${amountPaid} cents. Using metadata credits: ${metadataCredits}`);
          }
          const creditsToAdd = pkg ? pkg.credits : metadataCredits;

          if (!creditsToAdd || creditsToAdd <= 0) {
            log.error(`❌ [STRIPE WEBHOOK] Cannot determine credits for amount ${amountPaid} cents, metadata: ${metadataCredits}`);
            throw new Error('Cannot determine credits to add');
          }

          if (!userId) {
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

            log.info(`✅ [STRIPE WEBHOOK] Added ${creditsToAdd} credits to user ${userId}`);
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
          const userId = fullSession.metadata?.userId;
          const address = fullSession.shipping?.address || fullSession.customer_details?.address || {};
          const orderCoverType = fullSession.metadata?.coverType || 'softcover';
          const orderBookFormat = fullSession.metadata?.bookFormat || 'square';
          const orderQuantity = parseInt(fullSession.metadata?.quantity) || 1;

          // Validate required metadata
          if (!userId) {
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

          // stripe_mode: which Stripe account processed this PI. Required for
          // refunds — refunds must hit the same account that took the payment.
          // Set in checkout session metadata at creation time. Default 'live'
          // for legacy/missing metadata.
          const stripeMode = fullSession.metadata?.stripeMode === 'test' ? 'test' : 'live';

          await dbPool.query(`
            INSERT INTO orders (
              user_id, story_id, stripe_session_id, stripe_payment_intent_id,
              customer_name, customer_email,
              shipping_name, shipping_address_line1, shipping_address_line2,
              shipping_city, shipping_state, shipping_postal_code, shipping_country,
              amount_total, currency, payment_status, quantity, stripe_mode
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
          `, [
            userId, primaryStoryId, fullSession.id, fullSession.payment_intent,
            customerInfo.name, customerInfo.email,
            fullSession.shipping?.name || customerInfo.name,
            address.line1, address.line2,
            address.city, address.state, address.postal_code, address.country,
            fullSession.amount_total, fullSession.currency, fullSession.payment_status,
            orderQuantity, stripeMode
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

          // ── Referral cashback: if a valid referral code was used, credit
          // the referrer's CHF balance (was credits pre-cutover). Idempotent
          // via referral_events UNIQUE(stripe_session_id) AND the partial unique
          // index on referral_payouts(session_id) WHERE type='earned'.
          //
          // RACE PROTECTION: re-check hasPaidOrder(buyerUserId) inside the
          // transaction. The referral code claim happens at checkout creation
          // (print.js TOCTOU lock on referred_by), but a buyer could complete
          // a non-referral checkout between code claim and this webhook, which
          // would mean they're no longer a first-time buyer. Skip the reward
          // in that case — leave referred_by claim intact for audit.
          const refCode = fullSession.metadata?.referralCode;
          const refReferrerId = fullSession.metadata?.referrerUserId;
          const refDiscountCents = parseInt(fullSession.metadata?.discountCents) || 0;
          if (refCode && refReferrerId) {
            const client = await dbPool.connect();
            try {
              await client.query('BEGIN');

              const existing = await client.query(
                'SELECT id FROM referral_events WHERE order_stripe_session_id = $1', [fullSession.id]
              );
              if (existing.rows.length > 0) {
                await client.query('ROLLBACK');
                log.warn('⚠️ [STRIPE WEBHOOK] Referral already processed for session:', fullSession.id);
              } else {
                // First-time-buyer race re-check. NOTE: this order itself
                // hasn't been counted yet (orders.payment_status update happens
                // above but in same flow) — exclude THIS session from the check.
                const { hasPaidOrder } = require('./server/lib/orders');
                const otherPaid = await client.query(
                  `SELECT 1 FROM orders
                     WHERE user_id = $1
                       AND payment_status = 'paid'
                       AND stripe_session_id != $2
                     LIMIT 1`,
                  [userId, fullSession.id]
                );
                if (otherPaid.rows.length > 0) {
                  await client.query('ROLLBACK');
                  log.warn(`⚠️ [STRIPE WEBHOOK] Buyer ${userId} already had a paid order — skipping referral reward (race window).`);
                } else {
                  const cashbackCents = CREDIT_CONFIG.REFERRAL.REFERRER_CASHBACK_CENTS;

                  // Audit row (legacy table; credits_granted=0 since we no longer grant credits)
                  await client.query(`
                    INSERT INTO referral_events (referrer_user_id, buyer_user_id, order_stripe_session_id, discount_cents, credits_granted)
                    VALUES ($1, $2, $3, $4, 0)
                  `, [refReferrerId, userId, fullSession.id, refDiscountCents]);

                  // Buyer's order: record code + discount applied
                  await client.query(
                    'UPDATE orders SET referral_code_used = $1, discount_cents = $2 WHERE stripe_session_id = $3',
                    [refCode, refDiscountCents, fullSession.id]
                  );

                  // Credit referrer's CHF balance via the dedicated module.
                  const { creditEarned } = require('./server/lib/referralBalance');
                  await creditEarned({
                    userId: refReferrerId,
                    amountCents: cashbackCents,
                    sessionId: fullSession.id,
                    sourceUserId: userId,
                    description: `Referral cashback: code ${refCode} used by buyer ${userId}`,
                  }, client);

                  await client.query('COMMIT');
                  log.info(`🎁 [STRIPE WEBHOOK] Referral cashback: CHF ${(cashbackCents / 100).toFixed(2)} to ${refReferrerId} (code ${refCode}, buyer ${userId}, discount CHF ${refDiscountCents / 100})`);
                }
              }
            } catch (refErr) {
              await client.query('ROLLBACK').catch(() => {});
              log.error('❌ [STRIPE WEBHOOK] Referral cashback failed (rolled back):', refErr.message);
              // Don't throw — the order itself is already saved outside this block
            } finally {
              client.release();
            }
          }

          // ── Confirm pending balance hold: if the BUYER used their referral
          // balance on this checkout, convert the pending hold into a confirmed
          // spend (decrement both balance and pending). Idempotent.
          const useBalanceCents = parseInt(fullSession.metadata?.useBalanceCents) || 0;
          if (useBalanceCents > 0 && userId) {
            try {
              const { confirmPending } = require('./server/lib/referralBalance');
              const result = await confirmPending({ userId, sessionId: fullSession.id });
              if (result.confirmed) {
                log.info(`💰 [STRIPE WEBHOOK] Confirmed referral balance spend: CHF ${(result.amountCents / 100).toFixed(2)} from ${userId} (session ${fullSession.id})`);
              } else if (result.alreadyResolved) {
                log.warn(`⚠️ [STRIPE WEBHOOK] Pending balance already ${result.resolvedAs} for session ${fullSession.id}`);
              }
            } catch (confirmErr) {
              log.error(`❌ [STRIPE WEBHOOK] confirmPending failed for session ${fullSession.id}:`, confirmErr.message);
              // Don't throw — order is saved, this is a balance bookkeeping issue
            }
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
          processBookOrder(dbPool, fullSession.id, userId, validatedStoryIds, customerInfo, address, isTestPayment, orderCoverType, orderBookFormat, orderQuantity).catch(async (err) => {
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

          log.info('🚀 [STRIPE WEBHOOK] Background processing triggered - customer can leave');
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

    // ── checkout.session.expired: release any referral balance hold so the
    // user gets their pending CHF back. Stripe expires unfinished sessions
    // after ~24h. Idempotent.
    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const useBalanceCents = parseInt(session.metadata?.useBalanceCents) || 0;
      const buyerUserId = session.metadata?.userId;
      if (useBalanceCents > 0 && buyerUserId) {
        try {
          const { releasePending } = require('./server/lib/referralBalance');
          const result = await releasePending({
            userId: buyerUserId,
            sessionId: session.id,
            reason: `Checkout session expired (${new Date().toISOString()})`,
          });
          if (result.released) {
            log.info(`💰 [STRIPE WEBHOOK] Released referral balance hold: CHF ${(result.amountCents / 100).toFixed(2)} back to ${buyerUserId} (expired session ${session.id})`);
          } else if (result.alreadyResolved) {
            log.warn(`⚠️ [STRIPE WEBHOOK] Pending balance already ${result.resolvedAs} for expired session ${session.id} — skipping`);
          }
        } catch (relErr) {
          log.error(`❌ [STRIPE WEBHOOK] releasePending failed for expired session ${session.id}:`, relErr.message);
        }
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
            log.info('✅ [GELATO WEBHOOK] Linked order via story ID fallback:', orderResult.rows[0].id);
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
              shipped_at = CASE WHEN $4 = 'shipped' AND shipped_at IS NULL THEN NOW() ELSE shipped_at END,
              delivered_at = CASE WHEN $4 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $5
        `, [newStatus, trackingNumber, trackingUrl, newStatus, orderId]);
      } else {
        await dbPool.query(`
          UPDATE orders
          SET gelato_status = $1,
              delivered_at = CASE WHEN $2 = 'delivered' AND delivered_at IS NULL THEN NOW() ELSE delivered_at END,
              updated_at = NOW()
          WHERE gelato_order_id = $3
        `, [newStatus, newStatus, orderId]);
      }

      log.info('✅ [GELATO WEBHOOK] Order status updated to:', newStatus);

      // Send order confirmation email when Gelato validates the order (passed or in_production)
      // This ensures customers only receive "Order Confirmed" after Gelato accepts the order
      if ((fulfillmentStatus === 'passed' || fulfillmentStatus === 'in_production') && order.customer_email) {
        try {
          // Check if confirmation email was already sent (idempotency)
          const emailCheck = await dbPool.query(
            `SELECT confirmation_email_sent, delivery_estimate_min, delivery_estimate_max,
                    amount_total, currency,
                    shipping_address_line1, shipping_address_line2, shipping_city,
                    shipping_state, shipping_postal_code, shipping_country
             FROM orders WHERE id = $1`,
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

            const shippingAddress = {
              line1: orderData.shipping_address_line1,
              line2: orderData.shipping_address_line2,
              city: orderData.shipping_city,
              state: orderData.shipping_state,
              postal_code: orderData.shipping_postal_code,
              country: orderData.shipping_country
            };

            await email.sendOrderConfirmationEmail(
              order.customer_email,
              order.customer_name,
              {
                orderId: orderId.substring(0, 8).toUpperCase(),
                amount: orderData.amount_total ? (orderData.amount_total / 100).toFixed(2) : '0.00',
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

            log.info('📧 [GELATO WEBHOOK] Order confirmation email sent to:', order.customer_email);
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
          log.info('📧 [GELATO WEBHOOK] Shipped notification sent to:', order.customer_email);
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

        log.info('✅ [GELATO WEBHOOK] Delivery estimate stored for order:', order.id);

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

// Global body limit — character data includes base64 photos, so needs to be generous
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
  // Lazy-loaded so the route module isn't hot-required on every request.
  const r2 = require('./server/lib/r2');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    r2: r2.isConfigured() ? 'configured' : 'not configured',
  });
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

// Initialize trial routes with server.js-local dependencies
if (trialRoutes.initTrialRoutes) {
  trialRoutes.initTrialRoutes({ processStoryJob });
}

// Initialize Swiss stories cache (parses MD files at startup)
initSwissStories();

// Initialize auth routes with server.js-local dependencies (for trial job processing on email verify)
if (authRoutes.initAuthRoutes) {
  authRoutes.initAuthRoutes({ processStoryJob });
}

if (hasDistFolder) {
  // Serve the built React app from dist/
  app.use(express.static(distPath, { index: false }));
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
app.use('/api/characters', express.json({ limit: '50mb' }), characterRoutes);
app.use('/api/story-draft', storyDraftRoutes);
app.use('/api/stories', express.json({ limit: '50mb' }), storiesRoutes);
app.use('/api/stories', express.json({ limit: '50mb' }), regenerationRoutes);  // Image/scene/cover regeneration & repair
app.use('/api/files', filesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/photos', photosRoutes);
app.use('/api', express.json({ limit: '50mb' }), avatarsRoutes);  // /api/analyze-photo, /api/avatar-prompt, /api/generate-clothing-avatars
app.use('/api', aiProxyRoutes);  // /api/claude, /api/gemini
// Expose order-aware Stripe picker so the referral cashout route can pick test/live
// based on the order's stripe_mode rather than current user state.
app.locals.getStripeClientForOrder = getStripeClientForOrder;
app.use('/api', printRoutes);  // Print provider, PDF generation, Stripe payments, pricing
app.use('/api/jobs', express.json({ limit: '50mb' }), jobRoutes);  // Job creation, status, cancellation, checkpoints
app.use('/api', express.json({ limit: '50mb' }), storyIdeasRoutes);  // Story idea generation

// Swiss Stories API — serves city data with story ideas (parsed from docs/story-ideas/*.md)
app.get('/api/swiss-stories', (req, res) => {
  try {
    const data = getSwissStoriesResponse();
    res.json(data);
  } catch (err) {
    log.error('[SWISS] API error:', err.message);
    res.status(500).json({ error: 'Failed to load Swiss stories data' });
  }
});
app.use('/api/trial', express.json({ limit: '50mb' }), trialRoutes);  // Anonymous trial story flow
app.use('/api', sharingApiRoutes);  // /api/shared/* (public story data, images, OG image)
app.use('/', sharingHtmlRoutes);  // /s/:shareToken, /shared/:shareToken (HTML)

log.info('📦 Modular routes loaded: config, health, auth, user, characters, story-draft, stories, files, admin, photos, sharing');

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
    log.info('✓ Database connection successful');

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

    // Add anonymous column for anonymous trial accounts (no email yet)
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='anonymous') THEN
          ALTER TABLE users ADD COLUMN anonymous BOOLEAN DEFAULT FALSE;
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

    // Trial daily stats (persistent, survives deploys)
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS trial_daily_stats (
        date DATE PRIMARY KEY,
        stories_generated INT DEFAULT 0,
        avatars_generated INT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      log.info('✓ Default pricing tiers seeded');
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

    // Historical locations table (pre-fetched photos for historical stories)
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS historical_locations (
        id SERIAL PRIMARY KEY,
        event_id VARCHAR(100) NOT NULL,
        location_name VARCHAR(255) NOT NULL,
        location_query VARCHAR(255),
        location_type VARCHAR(100),
        aliases JSONB DEFAULT '[]',
        photo_url TEXT NOT NULL DEFAULT '',
        photo_data TEXT,
        photo_attribution TEXT,
        photo_description TEXT,
        photo_score INT,
        photo_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(event_id, location_name, photo_url)
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_historical_locations_event ON historical_locations(event_id)`);

    // Style Lab images table - stores style convergence test images separately
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS style_lab_images (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        page_number INT NOT NULL,
        run_id VARCHAR(100) NOT NULL,
        model_id VARCHAR(100) NOT NULL,
        image_data TEXT NOT NULL,
        thumbnail TEXT,
        style_prompt TEXT NOT NULL,
        elapsed_ms INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_style_lab_story ON style_lab_images(story_id)`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_style_lab_unique ON style_lab_images(story_id, page_number, run_id, model_id)`);

    // R2 dual-write migrations — the writers (saveStyleLabImage, story_images
    // write path) set image_data=null when the bytes succeed at uploading to
    // R2, with the URL stored in image_url. Original CREATE TABLE blocks
    // declared image_data NOT NULL, so URL-only inserts crashed with
    // "null value in column image_data violates not-null constraint" — most
    // visibly in the Style Lab UI as both Grok and Gemini cards showing the
    // constraint error in place of the rendered image. Migrations live HERE
    // (not in server/services/database.js) because that file's
    // initializeDatabase isn't on the startup path in prod — see the comment
    // on the referral block below for the same lesson.
    await dbPool.query(`ALTER TABLE story_images       ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await dbPool.query(`ALTER TABLE story_retry_images ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await dbPool.query(`ALTER TABLE style_lab_images   ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await dbPool.query(`ALTER TABLE story_images       ALTER COLUMN image_data DROP NOT NULL`);
    await dbPool.query(`ALTER TABLE story_retry_images ALTER COLUMN image_data DROP NOT NULL`);
    await dbPool.query(`ALTER TABLE style_lab_images   ALTER COLUMN image_data DROP NOT NULL`);

    // Referral system — separate from the legacy DDL block so it always runs on
    // startup and can be added to existing prod databases. Previously these
    // were only in server/services/database.js which isn't on the startup path,
    // so prod was throwing `relation "referral_events/payouts" does not exist`
    // on the account page.
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20)`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_balance_cents >= 0)`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_pending_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_pending_cents >= 0)`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_lower ON users(LOWER(referral_code)) WHERE referral_code IS NOT NULL`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code_used VARCHAR(20)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INT DEFAULT 0`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_mode VARCHAR(8)`);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS referral_events (
        id SERIAL PRIMARY KEY,
        referrer_user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        buyer_user_id VARCHAR(255) NOT NULL,
        order_stripe_session_id VARCHAR(255) NOT NULL UNIQUE,
        discount_cents INT NOT NULL,
        credits_granted INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_referral_events_referrer ON referral_events(referrer_user_id)`);
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS referral_payouts (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        type VARCHAR(20) NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        pending_after_cents INTEGER NOT NULL,
        order_stripe_session_id VARCHAR(255),
        stripe_refund_id VARCHAR(255),
        source_user_id VARCHAR(255),
        description TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_referral_payouts_user_id ON referral_payouts(user_id, created_at DESC)`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payouts_earned_session ON referral_payouts(order_stripe_session_id) WHERE type = 'earned'`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_payouts_pending_session ON referral_payouts(order_stripe_session_id) WHERE type = 'pending_checkout'`);

    log.info('✓ Database tables initialized');

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

// Save partial story from checkpoints — used when a job fails or is found as a zombie after restart.
// Reads all checkpoints, reconstructs story data, and saves to the stories table with [PARTIAL] title.
async function savePartialStoryFromCheckpoints(jobId, failureReason = 'Unknown failure') {
  if (STORAGE_MODE !== 'database' || !dbPool) return;

  try {
    const jobDataResult = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
    if (jobDataResult.rows.length === 0) return;

    const userId = jobDataResult.rows[0].user_id;
    const inputData = jobDataResult.rows[0].input_data;
    const checkpoints = await getAllCheckpoints(jobId);
    if (checkpoints.length === 0) return;

    let outline = '';
    let outlinePrompt = '';
    let outlineModelId = null;
    let outlineUsage = null;
    let fullStoryText = '';
    const sceneDescMap = new Map();
    let sceneImages = [];
    let storyTextPrompts = [];
    let visualBible = null;
    let coverImages = {};
    let pageClothingData = null;
    const lang = inputData?.language || 'en';
    const pageWord = lang.startsWith('de') ? 'Seite' : lang.startsWith('fr') ? 'Page' : 'Page';

    for (const cp of checkpoints) {
      const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

      if (cp.step_name === 'outline') {
        outline = data.outline || '';
        outlinePrompt = data.outlinePrompt || '';
        outlineModelId = data.outlineModelId || null;
        outlineUsage = data.outlineUsage || null;
        if (outline) {
          try { pageClothingData = extractPageClothing(outline, inputData?.pages || 15); } catch { /* ignore */ }
        }
      } else if (cp.step_name === 'unified_story') {
        if (data.storyPages?.length) {
          fullStoryText = data.storyPages.map(p => `## ${pageWord} ${p.pageNumber}\n\n${p.text}`).join('\n\n');
          for (const page of data.storyPages) {
            if (page.sceneHint) sceneDescMap.set(page.pageNumber, page.sceneHint);
          }
        }
        if (data.visualBible) visualBible = data.visualBible;
        if (data.clothingRequirements) pageClothingData = data.clothingRequirements;
        if (data.unifiedPrompt) {
          outlinePrompt = data.unifiedPrompt;
          outlineModelId = data.unifiedModelId || null;
          outlineUsage = data.unifiedUsage || null;
        }
      } else if (cp.step_name === 'story_text') {
        if (!fullStoryText && data.pageTexts) {
          const pageNums = Object.keys(data.pageTexts).sort((a, b) => Number(a) - Number(b));
          fullStoryText = pageNums.map(n => `## ${pageWord} ${n}\n\n${data.pageTexts[n]}`).join('\n\n');
        }
        if (sceneDescMap.size === 0 && Array.isArray(data.sceneDescriptions)) {
          for (const sd of data.sceneDescriptions) {
            if (sd.description) sceneDescMap.set(sd.pageNumber, sd.description);
          }
        }
      } else if (cp.step_name === 'story_batch') {
        if (data.batchText) fullStoryText += (fullStoryText ? '\n\n' : '') + data.batchText;
        if (data.batchPrompt) storyTextPrompts.push({ batch: data.batchNum || storyTextPrompts.length + 1, startPage: data.startScene || 1, endPage: data.endScene || 15, prompt: data.batchPrompt });
      } else if (cp.step_name === 'partial_page') {
        const pageNum = cp.step_index;
        const sceneDesc = data.description || data.sceneDescription?.description || data.sceneDescription || '';
        if (sceneDesc && !sceneDescMap.has(pageNum)) sceneDescMap.set(pageNum, sceneDesc);
        if (data.imageData) {
          sceneImages.push({ pageNumber: pageNum, imageData: data.imageData, description: sceneDesc, prompt: data.prompt || data.imagePrompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, totalAttempts: data.totalAttempts, retryHistory: data.retryHistory, wasRegenerated: data.wasRegenerated, originalImage: data.originalImage, originalScore: data.originalScore, originalReasoning: data.originalReasoning, modelId: data.modelId || null, referencePhotos: data.referencePhotos || null, imageAspect: inputData?.layout?.imageAspect || data.imageAspect, textInImage: inputData?.layout?.textInImage ?? data.textInImage });
        }
      } else if (cp.step_name === 'cover' || cp.step_name === 'partial_cover') {
        if (data.imageData && data.type) {
          coverImages[data.type] = { imageData: data.imageData, description: data.description || '', prompt: data.prompt || '', qualityScore: data.qualityScore || data.score, qualityReasoning: data.qualityReasoning || data.reasoning, modelId: data.modelId || null };
        }
      }
    }

    const sceneDescriptions = Array.from(sceneDescMap.entries()).map(([pageNumber, description]) => ({ pageNumber, description })).sort((a, b) => a.pageNumber - b.pageNumber);
    const hasContent = outline || fullStoryText || sceneImages.length > 0;
    if (!hasContent) return;

    const storyTitle = inputData?.title || `Partial Story (${new Date().toLocaleDateString()})`;
    const storyData = {
      id: jobId, title: storyTitle + ' [PARTIAL]',
      storyType: inputData?.storyType || 'unknown', storyTypeName: inputData?.storyTypeName || '',
      storyCategory: inputData?.storyCategory || '', storyTopic: inputData?.storyTopic || '',
      storyTheme: inputData?.storyTheme || '', storyDetails: inputData?.storyDetails || '',
      artStyle: inputData?.artStyle || 'pixar', language: lang,
      languageLevel: inputData?.languageLevel || 'standard',
      pages: inputData?.pages || sceneImages.length, dedication: inputData?.dedication || '',
      season: inputData?.season || '', userLocation: inputData?.userLocation || null,
      characters: inputData?.characters || [], mainCharacters: inputData?.mainCharacters || [],
      relationships: inputData?.relationships || {}, relationshipTexts: inputData?.relationshipTexts || {},
      outline, outlinePrompt, outlineModelId, outlineUsage,
      story: fullStoryText, originalStory: fullStoryText, storyTextPrompts,
      visualBible, pageClothing: pageClothingData, sceneDescriptions, sceneImages, coverImages,
      isPartial: true, failureReason, generatedPages: sceneImages.length,
      totalPages: inputData?.pages || 15,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };

    await upsertStory(jobId, userId, storyData);
    log.info(`📚 [PARTIAL SAVE] Saved partial story ${jobId} with ${sceneImages.length} images, ${sceneDescriptions.length} scene descriptions`);
  } catch (err) {
    log.error(`❌ [PARTIAL SAVE] Failed to save partial story ${jobId}: ${err.message}`);
  }
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
          "SELECT COUNT(*) as count FROM landmark_index WHERE LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñ', 'uuaaaooeeeeiicn')) = LOWER(translate($1, 'üùäàâöôéèêëîïçñ', 'uuaaaooeeeeiicn'))",
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
app.patch('/api/stories/:id/page/:pageNum', express.json({ limit: '50mb' }), authenticateToken, async (req, res) => {
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

    // Update page text if provided (handle both field names for compatibility)
    if (text !== undefined) {
      const currentText = storyData.story || storyData.storyText || '';
      const updatedText = updatePageText(currentText, pageNumber, text);
      storyData.story = updatedText;
      storyData.storyText = updatedText;
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

    log.info(`✅ Page ${pageNumber} updated for story ${id}`);

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
async function processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableFullRepair = true, checkCancellation = async () => {}) {
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
  // Register so deep helpers (images.js, entityConsistency.js) can record
  // apiUsage without threading genLog through every signature.
  setCurrentLogger(genLog);
  genLog.setStage('outline');

  // Token usage tracker - same structure as other modes
  const tokenUsage = {
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // Runware/Grok use direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    grok: { direct_cost: 0, calls: 0 },
    byFunction: {
      unified_story: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_expansion: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_iterate: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_expansion: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      phantom_patch: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
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
      // Accumulate direct_cost for providers that use it (Grok, Runware)
      if (usage.direct_cost != null && tokenUsage[provider].direct_cost !== undefined) {
        tokenUsage[provider].direct_cost += usage.direct_cost;
      }
    }
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage?.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage?.output_tokens || 0;
      tokenUsage.byFunction[functionName].thinking_tokens += usage?.thinking_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      tokenUsage.byFunction[functionName].provider = provider;
      if (modelName) tokenUsage.byFunction[functionName].models.add(modelName);
      // Accumulate direct_cost on byFunction entries that support it
      if (usage?.direct_cost != null && tokenUsage.byFunction[functionName].direct_cost !== undefined) {
        tokenUsage.byFunction[functionName].direct_cost += usage.direct_cost;
      }
    }
  };

  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  // Picture-book layout for all reading levels: 1 page = 1 scene
  // (image on top, text below). The reading level controls text density only.
  const sceneCount = inputData.pages;
  const lang = inputData.language || 'en';

  // Resolve page layout once at the top of the pipeline. Read from layout
  // throughout via inputData.layout — passing as a separate parameter would
  // require threading through many existing helpers. inputData is request-
  // local (sanitized in the route handler, not shared), so augmenting it here
  // is safe.
  // 'advanced' → square + text-below. Others → A4 + text-overlay.
  const { resolveLayout } = require('./server/lib/layout');
  const layout = resolveLayout(inputData.languageLevel, inputData.layoutOverride);
  inputData.layout = layout;
  log.debug(`📖 [UNIFIED] Input: ${inputData.pages} pages, level: ${inputData.languageLevel} → ${sceneCount} scenes, layout: ${layout.mode} (${layout.imageAspect}, textInImage=${layout.textInImage})`);
  const { getLanguageNameEnglish } = require('./server/lib/languages');
  const langText = getLanguageNameEnglish(lang);

  try {
    // PHASE 1: Generate complete story with unified prompt
    await checkCancellation();
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [1, 'Starting story generation...', jobId]
    );

    const unifiedPrompt = inputData.trialMode
      ? buildTrialStoryPrompt(inputData, sceneCount)
      : buildUnifiedStoryPrompt(inputData, sceneCount);
    log.debug(`📖 [UNIFIED] Prompt length: ${unifiedPrompt.length} chars, requesting ${sceneCount} pages${inputData.trialMode ? ' (trial mode)' : ''}`);

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
    const sceneBackgrounds = {}; // Populated by trial mode early background generation OR Phase 5a-pre
    let streamingAvatarStylingPromise = null; // Promise for early avatar styling (started when clothing requirements ready)
    let earlyAvatarStylingSucceeded = false; // Track whether early styling actually cached avatars

    // Track parallel tasks started during streaming
    const streamingSceneExpansionPromises = new Map(); // pageNum -> promise
    const streamingCoverPromises = new Map(); // coverType -> promise
    const streamingTrialPageImagePromises = new Map(); // pageNum -> promise (trial mode only)
    const streamingExpandedPages = new Map(); // pageNum -> page data (for scene expansion)
    let coversStartedDuringStreaming = false;

    // TRIAL MODE: Start avatar styling immediately using pre-defined costumes
    // This runs in parallel with story generation (no need to wait for outline clothing)
    if (inputData.trialMode && !skipImages && artStyle !== 'realistic') {
      const { getTrialCostume } = require('./server/config/trialCostumes');
      const mainChar = (inputData.characters || [])[0];
      // For life-challenge: storyTheme has the adventure type (pirate), storyTopic has the challenge (cleaning-up)
      // For adventure: storyTheme has the theme, storyTopic may be empty
      // For historical: storyTopic has the event ID
      const lookupCategory = inputData.storyCategory === 'historical' ? 'historical' : 'adventure';
      const lookupTopic = inputData.storyCategory === 'historical'
        ? (inputData.storyTopic || '')
        : (inputData.storyTheme || inputData.storyTopic || '');
      const costume = getTrialCostume(
        lookupTopic,
        lookupCategory,
        mainChar?.gender || ''
      );

      // Build clothing requirements from config (not from outline)
      const trialClothingRequirements = {};
      for (const char of (inputData.characters || [])) {
        trialClothingRequirements[char.name] = {
          standard: { used: true, signature: 'none' },
          costumed: costume
            ? { used: true, costume: costume.costumeType, description: costume.description }
            : { used: false }
        };
      }

      // Store for later use (skip outline-generated clothing)
      inputData._trialClothingRequirements = trialClothingRequirements;
      inputData._trialCostumeType = costume?.costumeType || null;
      log.debug(`🎭 [TRIAL] _trialCostumeType set to: ${inputData._trialCostumeType} (costume: ${costume ? costume.costumeType : 'null'}, mainChar gender: ${mainChar?.gender})`);
      log.debug(`🎭 [TRIAL] Characters isMainCharacter: ${(inputData.characters || []).map(c => `${c.name}=${c.isMainCharacter}`).join(', ')}`);

      const trialAvatarRequirements = (inputData.characters || []).flatMap(char => {
        const cats = ['standard'];
        if (costume) cats.push(`costumed:${costume.costumeType}`);
        return cats.map(cat => ({
          pageNumber: 'pre-cover',
          clothingCategory: cat,
          characterNames: [char.name]
        }));
      });

      // Seed cache with pre-generated styled avatars from prepare-title (avoid re-generating)
      const preGenAvatars = (inputData.characters || [])[0]?.preGeneratedStyledAvatars;
      if (preGenAvatars) {
        let seeded = 0;
        for (const [charName, avatars] of Object.entries(preGenAvatars)) {
          for (const [category, imageData] of Object.entries(avatars)) {
            if (category === 'costumed' && typeof avatars.costumed === 'object') {
              for (const [costumeType, img] of Object.entries(avatars.costumed)) {
                setStyledAvatar(charName, `costumed:${costumeType}`, artStyle, img);
                seeded++;
              }
            } else if (category !== 'costumed') {
              setStyledAvatar(charName, category, artStyle, imageData);
              seeded++;
            }
          }
        }
        if (seeded > 0) log.info(`♻️ [TRIAL] Seeded ${seeded} styled avatars from prepare-title cache`);
      }

      log.info(`🎨 [TRIAL] Starting immediate avatar styling (${trialAvatarRequirements.length} variants)...`);
      streamingAvatarStylingPromise = (async () => {
        try {
          await prepareStyledAvatars(inputData.characters || [], artStyle, trialAvatarRequirements, trialClothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
          earlyAvatarStylingSucceeded = getStyledAvatarCacheStats().size > 0;
          log.info(`✅ [TRIAL] Early avatar styling complete: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.warn(`⚠️ [TRIAL] Early avatar styling failed: ${error.message}`);
        }
      })();
    }

    // Rate limiters for streaming tasks (aggressive parallelism)
    const streamSceneLimit = pLimit(10);   // Scene expansions are text-only, can parallelize heavily
    const streamCoverLimit = pLimit(3);    // Only 3 covers total anyway

    // NOTE: Avatar generation removed from streaming. Avatars should exist before story starts.

    // Helper: Start scene expansion for a page
    const startSceneExpansion = (page) => {
      if (streamingSceneExpansionPromises.has(page.pageNumber)) return;

      // Need visual bible for scene expansion - queue if not available yet
      const expansionPromise = streamSceneLimit(async () => {
        // Wait for visual bible if not yet available (cap at 5 minutes)
        let vbWait = 0;
        while (!streamingVisualBible && vbWait < 3000) {
          await new Promise(r => setTimeout(r, 100));
          vbWait++;
        }
        if (!streamingVisualBible) {
          log.warn('[STREAM] Timed out waiting for Visual Bible in scene expansion — skipping');
          return null;
        }

        // Wait for landmark photo descriptions to be loaded (so variants are in the prompt)
        if (landmarkDescriptionsPromise) {
          await landmarkDescriptionsPromise;
        }

        // Build character list from OUTLINE HINT only (not page text).
        // The outline's characters[] array is authoritative — it specifies who is
        // VISIBLE in the illustration. The page text may mention other characters
        // (narration, dialogue) who should NOT be drawn.
        // Also scan the outline's background field for secondary characters.
        let sceneCharacters = [];
        const allChars = inputData.characters || [];

        // 1. Characters from outline's characters[] array (primary — foreground/center)
        if (page.characters && page.characters.length > 0) {
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

        // 2. Characters mentioned in outline's background text (secondary — visible but background)
        // Claude occasionally names a character in the background prose without
        // listing them in characters[]; pick them up here, and log a warning
        // so we can see how often the hint diverges from itself.
        const hintJson = page.sceneHint || '';
        const backgroundMentionAdded = [];
        try {
          const hintParsed = JSON.parse(hintJson.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
          const bgText = (hintParsed.background || '').toLowerCase();
          if (bgText) {
            for (const char of allChars) {
              if (char.name && bgText.includes(char.name.toLowerCase()) && !sceneCharacters.some(sc => sc.name === char.name)) {
                sceneCharacters.push(char);
                backgroundMentionAdded.push(char.name);
              }
            }
          }
        } catch { /* not valid JSON — skip background parsing */ }
        if (backgroundMentionAdded.length > 0) {
          const missing = backgroundMentionAdded.filter(n => !(page.characterClothing && page.characterClothing[n]));
          if (missing.length > 0) {
            log.warn(`[SCENE HINT] Page ${page.pageNumber}: characters named in background but missing from characters[]: ${missing.join(', ')} — falling back to global clothing requirements`);
          }
        }

        // 3. Fallback: if outline parsing found nothing, scan scene hint text only (not page text)
        if (sceneCharacters.length === 0) {
          sceneCharacters = getCharactersInScene(
            page.sceneHint || '',
            allChars
          );
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
        const imgModelConfig = IMAGE_MODELS[modelOverrides.imageModel];

        // Resolve per-scene reference photos so the scene expansion prompt can include
        // the actual avatar clothing descriptions for each character. This pre-resolves
        // what would otherwise be built later in the pipeline at image-prompt time.
        // Use per-page clothing from outline hint (page.characterClothing) to ensure
        // costumed characters get costume descriptions, not standard clothing.
        let expansionPagePhotos = null;
        try {
          // Merge per-page clothing into a copy of clothing requirements so
          // getCharacterPhotoDetails picks the correct avatar (costumed vs standard).
          // CRITICAL: must clone the nested character entry before writing
          // _currentClothing. A shallow spread shares nested references, so
          // mutating pageClothingReqs[charName]._currentClothing would write
          // straight through to streamingClothingRequirements[charName] and
          // leak that per-page value into every future page.
          const pageClothingReqs = { ...streamingClothingRequirements };
          if (page.characterClothing) {
            for (const [charName, clothingCat] of Object.entries(page.characterClothing)) {
              pageClothingReqs[charName] = {
                ...(pageClothingReqs[charName] || {}),
                _currentClothing: clothingCat
              };
            }
          }
          // Fill gaps for background-mention characters (in sceneCharacters but
          // absent from page.characterClothing — Claude forgot to list them in
          // the hint's characters[] array). Mirrors the page-render path at
          // ~line 4596 so both paths resolve clothing the same way and the
          // safety net in getCharacterPhotoDetails never has to fire.
          for (const char of sceneCharacters) {
            if (pageClothingReqs[char.name]?._currentClothing) continue;
            const globalReqs = pageClothingReqs[char.name];
            const fallback = (globalReqs?.costumed?.used && globalReqs.costumed.costume)
              ? `costumed:${globalReqs.costumed.costume}`
              : 'standard';
            pageClothingReqs[char.name] = {
              ...(globalReqs || {}),
              _currentClothing: fallback
            };
          }
          expansionPagePhotos = getCharacterPhotoDetails(
            sceneCharacters,
            'standard',
            inputData.artStyle,
            pageClothingReqs
          );
        } catch (photoErr) {
          log.debug(`[SCENE EXPANSION] Could not pre-resolve photos for page ${page.pageNumber}: ${photoErr.message}`);
        }

        // Unified-scene-prose path: Sonnet wrote the ~300-word scene paragraph
        // directly in the unified pass (emitted as page.sceneProse alongside
        // page.sceneHint). When that field is present AND the feature flag is
        // on, skip the Haiku expansion call entirely — the prose goes straight
        // into sceneDescription. Haiku stays in its classifier roles (iterate
        // repair, feedback consolidator).
        const useUnifiedProse = MODEL_DEFAULTS.unifiedSceneProse === true && page.sceneProse && page.sceneProse.length > 50;

        let expansionPrompt = null;
        let expansionResult = null;
        let finalSceneDescription;

        if (useUnifiedProse) {
          // Build the "expansion prompt" only for dev-panel traceability — never call the model.
          // The sceneDescription we emit is Sonnet's prose concatenated with the METADATA JSON
          // block so downstream extractors (characters[], objects[], textPosition, interactions[])
          // still work via extractSceneMetadata().
          const metadataBlock = page.sceneHint ? `\n\n---METADATA---\n${page.sceneHint}` : '';
          finalSceneDescription = `${page.sceneProse}${metadataBlock}`;
          log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} scene prose from unified pass (${page.sceneProse.length} chars) — Haiku expansion skipped`);
          genLog.info('scene_expanded', `Page ${page.pageNumber} scene prose from Sonnet unified pass`, null, { pageNumber: page.pageNumber, source: 'unified' });
        } else {
          // Legacy path: Haiku scene-expansion.
          expansionPrompt = buildSceneExpansionPrompt(
            page.pageNumber,
            page.text,
            sceneCharacters,
            lang,
            streamingVisualBible,
            availableAvatars,
            rawOutlineContext, // pass raw outline blocks directly
            {
              maxCharactersPerScene: imgModelConfig?.maxCharactersPerScene || 3,
              artStyleId: inputData.artStyle,
              imageBackend: imgModelConfig?.backend,
              referencePhotos: expansionPagePhotos
            }
          );

          // Heartbeat keeps story_jobs.updated_at fresh during scene expansion streaming.
          // 24 parallel scene expansions can each take 30-60s; without heartbeating,
          // the row would only get updated when the first one finishes.
          const expansionHeartbeat = createJobHeartbeat(jobId, dbPool);
          expansionResult = await callTextModelStreaming(expansionPrompt, 10000, () => expansionHeartbeat(), modelOverrides.sceneDescriptionModel);
          const expansionProvider = expansionResult.provider === 'google' ? 'gemini_text' : 'anthropic';
          addUsage(expansionProvider, expansionResult.usage, 'scene_expansion', expansionResult.modelId);
          finalSceneDescription = expansionResult.text;

          log.debug(`✅ [STREAM-SCENE] Page ${page.pageNumber} scene expanded (Haiku)`);
          genLog.info('scene_expanded', `Page ${page.pageNumber} scene expanded`, null, { pageNumber: page.pageNumber, model: expansionResult.modelId });
        }

        // Post-expansion validation: validate and repair scene composition (disabled — was enableSceneValidation)
        if (false) {
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
          sceneDescriptionModelId: expansionResult ? expansionResult.modelId : 'claude-sonnet:unified',
          characterClothing: page.characterClothing,
          characters: page.characters,
          // Store outline's intended character list — eval uses this to distinguish
          // "outline-required" (penalty if missing) vs "scene-expansion-added" (no penalty)
          outlineCharacters: page.characters || []
        };
      });

      streamingSceneExpansionPromises.set(page.pageNumber, expansionPromise);
      log.debug(`⚡ [STREAM-SCENE] Started expansion for page ${page.pageNumber}`);
    };

    // Helper: Start trial page image generation as soon as a page completes streaming
    // For trial mode only — generates the page image in parallel with the rest of streaming.
    // Skips empty scene generation, ref sheets, and landmark photos (trial stories are simple).
    const startTrialPageImageGeneration = (page) => {
      if (!inputData.trialMode || skipImages) return;
      if (streamingTrialPageImagePromises.has(page.pageNumber)) return;

      const imagePromise = (async () => {
        try {
          // Wait for prerequisites: visual bible + early avatar styling (cap at 5 minutes)
          let vbWait = 0;
          while (!streamingVisualBible && vbWait < 3000) {
            await new Promise(r => setTimeout(r, 100));
            vbWait++;
          }
          if (!streamingVisualBible) {
            log.warn('[TRIAL-PAGE] Timed out waiting for Visual Bible — skipping page image');
            return null;
          }
          if (streamingAvatarStylingPromise) {
            await streamingAvatarStylingPromise;
          }

          // Build per-character clothing for this page
          const perCharClothing = page.characterClothing || {};
          // Trial mode fallback: if no clothing parsed, use the trial costume type for main characters
          if (inputData._trialCostumeType && Object.keys(perCharClothing).length === 0) {
            const mainCharIds = inputData.mainCharacters || [];
            for (const char of (inputData.characters || [])) {
              const isMain = char.isMainCharacter === true || mainCharIds.includes(char.id);
              if (isMain) {
                perCharClothing[char.name] = `costumed:${inputData._trialCostumeType}`;
              }
            }
          }

          // Determine which characters appear in this scene
          const sceneCharacters = getCharactersInScene(
            (page.sceneHint || '') + '\n' + (page.text || ''),
            inputData.characters
          );

          // Build clothing requirements with _currentClothing per character.
          // Clone the character entry before writing — sharing the nested
          // object with inputData._trialClothingRequirements lets a per-scene
          // value pollute the global requirements and leak into later pages.
          const sceneClothingRequirements = { ...(inputData._trialClothingRequirements || {}) };
          for (const char of sceneCharacters) {
            const charClothing = perCharClothing[char.name] || 'standard';
            sceneClothingRequirements[char.name] = {
              ...(sceneClothingRequirements[char.name] || {}),
              _currentClothing: charClothing
            };
          }

          // Get character photos with styled avatars applied
          let pagePhotos = getCharacterPhotoDetails(sceneCharacters, 'standard', inputData.artStyle, sceneClothingRequirements);
          pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);

          // Build the image prompt — trial uses rich scene hint as scene description
          const sceneDescription = page.sceneHint || page.text || '';
          const pageImageModel = MODEL_DEFAULTS.simplePageImage;
          const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
          const isGrokImage = pageImageBackend === 'grok';

          const imagePrompt = buildImagePrompt(
            sceneDescription, inputData, sceneCharacters, false, streamingVisualBible,
            page.pageNumber, true, pagePhotos, { skipVisualBible: isGrokImage }
          );

          // Resolve landmarks and VB grid for Grok reference slots
          const sceneMetadata = extractSceneMetadata(sceneDescription);
          const pageLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, sceneMetadata);
          let elementRefs = getElementReferenceImagesForPage(streamingVisualBible, page.pageNumber, 6);
          // Also match by IDs from scene hint (same as Phase 5a)
          if (sceneMetadata?.fullData) {
            const sceneIds = [];
            for (const char of sceneMetadata.fullData.characters || []) {
              if (char.id && char.id !== 'null') sceneIds.push(char.id);
            }
            for (const obj of sceneMetadata.fullData.objects || []) {
              const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
              if (id && !id.startsWith('LOC')) sceneIds.push(id);
            }
            if (sceneIds.length > 0) {
              const idBasedRefs = getElementReferenceImagesByIds(streamingVisualBible, sceneIds);
              const existingIds = new Set(elementRefs.map(r => r.id));
              const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
              if (newRefs.length > 0) elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
            }
          }
          const secondaryLandmarks = pageLandmarkPhotos.slice(1);
          let trialVbGrid = null;
          if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
            trialVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
          }

          log.info(`⚡ [TRIAL-STREAM] Page ${page.pageNumber} image generation starting (parallel with streaming)${pageLandmarkPhotos.length ? ` [${pageLandmarkPhotos.length} landmark(s)]` : ''}${trialVbGrid ? ' [VB grid]' : ''}`);
          const startTime = Date.now();

          const genResult = await generateImageOnly(imagePrompt, pagePhotos, {
            aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
            imageModelOverride: pageImageModel,
            imageBackendOverride: pageImageBackend,
            pageNumber: page.pageNumber,
            landmarkPhotos: pageLandmarkPhotos,
            visualBibleGrid: trialVbGrid,
          });

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log.info(`✅ [TRIAL-STREAM] Page ${page.pageNumber} image ready in ${elapsed}s`);

          // Track usage
          if (genResult.usage) {
            const isRunware = genResult.modelId?.startsWith('runware:');
            const isGrok = genResult.modelId?.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, genResult.usage, 'page_images', genResult.modelId);
          }

          // Save partial_page checkpoint for progressive display
          if (genResult.imageData) {
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: page.pageNumber,
              text: page.text,
              sceneDescription,
              imageData: genResult.imageData,
              modelId: genResult.modelId
            }, page.pageNumber);
          }

          // Detect calm region for text overlay (~30ms, non-blocking)
          let calmRegion = null;
          if (genResult.imageData) {
            try {
              const { detectCalmRegion } = require('./server/lib/calmRegion');
              const { enforceSpreadTextPosition } = require('./server/lib/storyHelpers');
              const textPos = enforceSpreadTextPosition(sceneMetadata?.textPosition || null, page.pageNumber);
              if (textPos) {
                const imgBuf = Buffer.from(genResult.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
                calmRegion = await detectCalmRegion(imgBuf, textPos).catch(() => null);
              }
            } catch (e) { /* calm region detection is optional */ }
          }

          return {
            pageNumber: page.pageNumber,
            imageData: genResult.imageData,
            modelId: genResult.modelId,
            usage: genResult.usage,
            prompt: imagePrompt,
            characterPhotos: pagePhotos,
            grokRefImages: genResult.grokRefImages || null,
            sceneDescription,
            text: page.text,
            sceneCharacters,
            perCharClothing,
            calmRegion,
          };
        } catch (err) {
          log.warn(`⚠️ [TRIAL-STREAM] Page ${page.pageNumber} image gen failed: ${err.message}`);
          return null;
        }
      })();

      streamingTrialPageImagePromises.set(page.pageNumber, imagePromise);
    };

    // Helper: Start cover generation
    const startCoverGeneration = (coverType, hint) => {
      if (streamingCoverPromises.has(coverType) || skipImages) return;
      if (inputData.titlePageOnly && coverType !== 'titlePage') return;
      if (skipCovers) return;

      const coverPromise = streamCoverLimit(async () => {
        // Wait for visual bible if not yet available (cap at 5 minutes)
        let vbWait = 0;
        while (!streamingVisualBible && vbWait < 3000) {
          await new Promise(r => setTimeout(r, 100));
          vbWait++;
        }
        if (!streamingVisualBible) {
          log.warn('[STREAM-COVER] Timed out waiting for Visual Bible — skipping cover');
          return null;
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

        // Inject explicit per-character holdings from the outline `holds` annotations.
        // Outline parser captures `- Lukas (center): standard, holds: book + Eli` into
        // hint.characterPerspectives[name].holds. Cap at 2 items per character (2 hands)
        // and append a structured "Items per character" block to the cover scene description
        // so the image model gets an unambiguous list (instead of relying on prose alone).
        const perspectives = hint.characterPerspectives || {};
        const itemLines = [];
        for (const [charName, ann] of Object.entries(perspectives)) {
          if (!ann.holds) continue;
          const holdsRaw = String(ann.holds).trim();
          if (!holdsRaw || holdsRaw.toLowerCase() === 'nothing' || holdsRaw.toLowerCase() === 'none' || holdsRaw === '-') continue;
          // Split on " + " or "&" or " and " (lightweight, just to count)
          const items = holdsRaw.split(/\s*\+\s*|\s*&\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
          if (items.length === 0) continue;
          const capped = items.slice(0, 2);
          if (items.length > 2) {
            log.warn(`📕 [COVER] ${coverType}: ${charName} had ${items.length} items in 'holds', capped to 2: ${capped.join(' + ')} (dropped: ${items.slice(2).join(', ')})`);
          }
          itemLines.push(`- ${charName}: ${capped.join(' + ')}`);
        }
        if (itemLines.length > 0) {
          sceneDescription += `\n\n**Items per character (max 2 per character — 2 hands):**\n${itemLines.join('\n')}`;
          log.info(`📕 [COVER] ${coverType}: Injected items for ${itemLines.length} character(s)`);
        }

        // Primary: use hint.characterClothing (authoritative — explicitly lists who should appear)
        // Fallback: match character names in scene text
        let coverCharacters = [];
        if (hint.characterClothing && Object.keys(hint.characterClothing).length > 0) {
          const clothingCharNames = Object.keys(hint.characterClothing);
          coverCharacters = inputData.characters.filter(c =>
            clothingCharNames.some(name => name.toLowerCase() === c.name.toLowerCase())
          );
          if (coverCharacters.length > 0) {
            log.debug(`📕 [COVER] ${coverType}: Using ${coverCharacters.length} characters from hint.characterClothing: ${coverCharacters.map(c => c.name).join(', ')}`);
          }
        }

        // Fallback: if characterClothing didn't yield results, try scene text matching
        if (coverCharacters.length === 0) {
          coverCharacters = getCharactersInScene(sceneDescription, inputData.characters);
        }

        // Back cover is a main-characters-only group portrait (same rule as title page).
        // Drop any supporting characters Claude may have listed in the hint.
        if (coverType === 'backCover' && coverCharacters.length > 0) {
          const isMainChar = (c) =>
            c.isMainCharacter === true ||
            (inputData.mainCharacters?.length > 0 && inputData.mainCharacters.includes(c.id));
          const mainOnly = coverCharacters.filter(isMainChar);
          if (mainOnly.length !== coverCharacters.length) {
            const dropped = coverCharacters.filter(c => !isMainChar(c)).map(c => c.name).join(', ');
            log.info(`📕 [COVER] backCover: Dropping non-main characters: ${dropped}`);
          }
          coverCharacters = mainOnly;
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
          defaultClothingCategory,
          artStyle,
          mergedClothingRequirements
        );
        coverPhotos = applyStyledAvatars(coverPhotos, artStyle);

        // Cover prompt setup — routed model/backend determined after scene expansion.
        const visualBibleText = streamingVisualBible ? buildFullVisualBiblePrompt(streamingVisualBible, { skipMainCharacters: true }) : '';
        let characterRefList = buildCharacterReferenceList(coverPhotos, inputData.characters);

        // Run the cover hint through scene expansion (same as pages) so covers get
        // a structured description with emptyScenePrompt and objects metadata.
        // Wait for landmark photo descriptions so variants are in the prompt.
        if (landmarkDescriptionsPromise) {
          await landmarkDescriptionsPromise;
        }
        // Initial model guess for scene expansion's maxCharactersPerScene / backend hint.
        // The actual image model is chosen after expansion (complexity-aware routing).
        const initialCoverModel = modelOverrides.coverImageModel || MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
        const initialCoverBackend = IMAGE_MODELS[initialCoverModel]?.backend || null;
        let coverExpandedDescription = sceneDescription;
        let coverExpandedMetadata = null;
        try {
          // Build a synthetic raw outline block for the cover so the scene expander
          // has the same input shape as a page (TEXT + SCENE HINT).
          const coverHintJson = {
            description: hint.hint || '',
            characters: Object.entries(hint.characterClothing || {}).map(([name, clothing]) => ({
              name,
              position: 'center',
              clothing,
            })),
            objects: hint.objects || [],
            background: 'landmark',
            setting: 'outdoor',
            shot: 'wide',
          };
          const syntheticPageBlock = `--- Cover: ${coverType} ---\nTEXT:\n${hint.hint || ''}\n\nSCENE HINT:\n${JSON.stringify(coverHintJson, null, 2)}\n`;
          const coverAvailableAvatars = buildAvailableAvatarsForPrompt(charactersForCover, streamingClothingRequirements);
          const coverExpansionPrompt = buildSceneExpansionPrompt(
            0, // page number 0 = cover
            hint.hint || '',
            charactersForCover,
            lang,
            streamingVisualBible,
            coverAvailableAvatars,
            { previousPages: '', currentPage: syntheticPageBlock },
            {
              maxCharactersPerScene: IMAGE_MODELS[initialCoverModel]?.maxCharactersPerScene || 5,
              artStyleId: inputData.artStyle,
              imageBackend: initialCoverBackend,
              referencePhotos: coverPhotos,
            }
          );
          const coverExpansionResult = await callTextModelStreaming(
            coverExpansionPrompt,
            10000,
            null,
            modelOverrides.sceneDescriptionModel
          );
          const coverExpansionProvider = coverExpansionResult.provider === 'google' ? 'gemini_text' : 'anthropic';
          addUsage(coverExpansionProvider, coverExpansionResult.usage, 'cover_expansion', coverExpansionResult.modelId);
          const expandedText = coverExpansionResult.text || '';
          // Reject expansion outputs that aren't real scene prose (refusal text, "I cannot…", empty-hint analysis).
          // A valid expansion always contains the ---METADATA--- block.
          const looksLikeRefusal = !expandedText.includes('---METADATA---')
            || /Empty scene hint|I cannot generate|I appreciate the detailed|Please provide the actual/i.test(expandedText);
          if (looksLikeRefusal) {
            log.warn(`⚠️ [STREAM-COVER] ${coverType} scene expansion returned non-prose / refusal — falling back to raw hint`);
            coverExpandedDescription = sceneDescription;
            coverExpandedMetadata = null;
          } else {
            coverExpandedDescription = expandedText;
            coverExpandedMetadata = extractSceneMetadata(coverExpandedDescription);
            log.debug(`✅ [STREAM-COVER] ${coverType} scene expanded`);
          }
        } catch (expansionErr) {
          log.warn(`⚠️ [STREAM-COVER] ${coverType} scene expansion failed: ${expansionErr.message} — using raw hint`);
        }
        // Use the expanded description (falls back to raw hint if expansion failed)
        // Strip metadata block before using as image prompt — the ---METADATA--- JSON
        // is for code consumption, not for the image model
        sceneDescription = stripSceneMetadata(coverExpandedDescription) || coverExpandedDescription;

        // If scene expansion produced prose (already contains character descriptions),
        // don't duplicate with the structured CHARACTER_REFERENCE_LIST
        const isProseScene = coverExpandedDescription.includes('---METADATA---');
        if (isProseScene) {
          characterRefList = ''; // Prose already describes characters
        }

        const coverLabel = coverType === 'titlePage' ? 'FRONT COVER' : coverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';

        // Per-cover image model routing based on scene complexity (same as pages).
        // sceneComplexity comes from scene expansion metadata (set to 'complex' when
        // a character has depth:background, otherwise 'simple').
        const coverSceneComplexity = coverExpandedMetadata?.sceneComplexity || 'simple';
        const coverSceneRouting = modelOverrides.sceneRouting || 'auto';
        let coverImageModel, coverImageBackend;
        if (modelOverrides.coverImageModel) {
          // Explicit cover model override always wins
          coverImageModel = modelOverrides.coverImageModel;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || null;
        } else if (coverSceneRouting === 'auto') {
          coverImageModel = coverSceneComplexity === 'complex'
            ? MODEL_DEFAULTS.complexPageImage
            : MODEL_DEFAULTS.simplePageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'gemini';
          log.info(`🎯 [ROUTING] ${coverLabel}: ${coverSceneComplexity} → ${coverImageModel} (${coverImageBackend})`);
        } else if (coverSceneRouting === 'grok') {
          coverImageModel = MODEL_DEFAULTS.simplePageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'grok';
        } else if (coverSceneRouting === 'gemini') {
          coverImageModel = MODEL_DEFAULTS.complexPageImage;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || 'gemini';
        } else {
          coverImageModel = MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
          coverImageBackend = IMAGE_MODELS[coverImageModel]?.backend || null;
        }
        const coverModelOverrides = { imageModel: coverImageModel, qualityModel: modelOverrides.qualityModel };

        // Build style description using the routed backend (same as pages at buildImagePrompt time)
        const styleDescription = resolveArtStyle(artStyle, coverImageBackend) || resolveArtStyle('pixar');

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

        // Usage tracker for cover images
        const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) {
            const isRunware = imgModel && imgModel.startsWith('runware:');
            const isGrok = imgModel && imgModel.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, imgUsage, 'cover_images', imgModel);
          }
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        // Build cover references via the shared helper — same one iterate uses,
        // so v0 / iterate / legacy streaming all share one source of truth.
        const { buildCoverReferences } = require('./server/lib/coverIterate');
        const coverKeyForRefs = coverType === 'titlePage' ? 'frontCover' : coverType;
        const skipEmptyScene = (typeof modelOverrides.singlePassScene === 'boolean'
          ? modelOverrides.singlePassScene
          : MODEL_DEFAULTS.singlePassScene === true)
          || modelOverrides.generateEmptyScenes === false;
        const coverRefs = await buildCoverReferences({
          coverKey: coverKeyForRefs,
          visualBible: streamingVisualBible,
          artStyle: inputData.artStyle,
          sceneDescription,
          coverHint: hint, // hint.objects carries LOC + ART IDs from the unified prompt
          sceneMetadata: coverExpandedMetadata, // pre-computed by scene expansion
          imageModel: skipEmptyScene ? null : coverImageModel,
          imageBackend: skipEmptyScene ? null : coverImageBackend,
          emptyScenePromptOverride: coverExpandedMetadata?.emptyScenePrompt || null,
          usageTracker: skipEmptyScene ? null : (usage, modelId) => {
            const isRunware = modelId?.startsWith('runware:');
            const isGrok = modelId?.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, usage, 'cover_images', modelId);
          },
          logLabel: coverLabel,
        });
        const coverLandmarkPhotos = coverRefs.landmarkPhotos;
        const coverVbGrid = coverRefs.visualBibleGrid;
        const coverSceneBackground = coverRefs.sceneBackground;
        const coverSceneMetadata = coverRefs.sceneMetadata;
        if (coverLandmarkPhotos.length > 0) {
          log.info(`🌍 [COVER] ${coverLabel} has ${coverLandmarkPhotos.length} landmark(s): ${coverLandmarkPhotos.map(l => `${l.name}${l.variantNumber > 1 ? ` (v${l.variantNumber})` : ''}`).join(', ')}`);
        }

        const coverResult = await generateImageWithQualityRetry(
          coverPrompt, coverPhotos, null, 'cover', null, coverUsageTracker, null, coverModelOverrides, coverLabel, { isAdmin, landmarkPhotos: coverLandmarkPhotos, visualBibleGrid: coverVbGrid, sceneCharacters: charactersForCover, sceneMetadata: coverSceneMetadata, sceneBackground: coverSceneBackground, visualBible }
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
          landmarkPhotos: coverLandmarkPhotos,
          emptySceneImage: coverSceneBackground || null,
          modelId: coverResult.modelId,
          grokRefImages: coverResult.grokRefImages || null
        };
      });

      // Attach a no-op catch to prevent unhandled rejection if cover fails before being awaited
      coverPromise.catch(err => log.warn(`⚠️ [STREAM-COVER] ${coverType} failed (will be handled when awaited): ${err.message}`));
      streamingCoverPromises.set(coverType, coverPromise);
      log.debug(`⚡ [STREAM-COVER] Started generation for ${coverType}`);
    };

    // Progressive parser with callbacks for streaming updates AND parallel task initiation
    const progressiveParser = new ProgressiveUnifiedParser({
      onTitle: (title) => {
        streamingTitle = title;
        // Trial cover generation moved to onCoverScene (richer structured data from Claude)
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
        if (!inputData.trialMode && !skipImages && artStyle !== 'realistic' && !streamingAvatarStylingPromise) {
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
              await prepareStyledAvatars(inputData.characters || [], artStyle, basicRequirements, requirements, addUsage, modelOverrides.storyAvatarModel || null);
              earlyAvatarStylingSucceeded = getStyledAvatarCacheStats().size > 0;
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

        // Inject historical locations into the STREAMING VB so cover gen and
        // page gen (which both read streamingVisualBible, not the finalize-time
        // visualBible) can resolve LOC ids to the curated photo. Without this,
        // covers/pages logged "[LANDMARK-SCENE] matched but has no photos
        // (variants=0, fetchStatus=none)" — the entry was in the streaming VB
        // (added by Sonnet) but the photo bytes only landed on the finalize-time
        // visualBible at line 4023, which is a separate object.
        if (inputData.storyCategory === 'historical' && inputData.storyTopic) {
          const historicalLocations = getHistoricalLocations(inputData.storyTopic);
          if (historicalLocations?.length > 0) {
            injectHistoricalLocations(streamingVisualBible, historicalLocations);
            log.info(`📍 [STREAM] Injected ${historicalLocations.length} pre-fetched historical location(s) into streaming VB`);
          }
        }

        // Link pre-discovered landmarks and load photo variant descriptions
        // This must happen BEFORE scene expansion so variants are available in the prompt
        if (inputData.availableLandmarks?.length > 0) {
          linkPreDiscoveredLandmarks(streamingVisualBible, inputData.availableLandmarks);
        }
        // Start async loading of photo descriptions (scene expansion will wait for this)
        landmarkDescriptionsPromise = loadLandmarkPhotoDescriptions(streamingVisualBible);

        log.debug(`⚡ [STREAM] Visual Bible ready - scene expansions can now proceed`);

        // Trial mode: generate empty scene backgrounds from visual bible immediately
        // Backgrounds arrive early in the stream, so we can start generating before pages are done
        if (inputData.trialMode && vb.backgrounds?.length > 0) {
          log.info(`🎬 [TRIAL] Starting early empty scene generation from ${vb.backgrounds.length} visual bible backgrounds`);
          const artStyleDesc = resolveArtStyle(inputData.artStyle || 'watercolor') || '';
          const bgLimit = pLimit(5);
          const bgPromises = [];

          for (const bg of vb.backgrounds) {
            if (!bg.description || !bg.pages?.length) continue;
            for (const pageNum of bg.pages) {
              bgPromises.push(bgLimit(async () => {
                try {
                  const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
                    STYLE_DESCRIPTION: artStyleDesc,
                    EMPTY_SCENE_DESCRIPTION: bg.description,
                    REQUIRED_OBJECTS: '',
                    TEXT_AREA_INSTRUCTION: '',
                    ERA_GUARD: '',
                  });
                  const result = await generateImageOnly(emptyPrompt, [], {
                    landmarkPhotos: [],
                    skipCache: true
                  });
                  if (result?.imageData) {
                    sceneBackgrounds[pageNum] = { imageData: result.imageData, prompt: emptyPrompt };
                    log.info(`🎬 [TRIAL] Empty scene for page ${pageNum} generated (${Math.round(result.imageData.length / 1024)}KB)`);
                    if (result.usage) {
                      const isGrok = result.modelId?.startsWith('grok-imagine');
                      addUsage(isGrok ? 'grok' : 'gemini_image', result.usage, 'trial_empty_scene', result.modelId);
                    }
                  }
                } catch (err) {
                  log.warn(`⚠️ [TRIAL] Empty scene for page ${pageNum} failed: ${err.message}`);
                }
              }));
            }
          }
          // Don't await — let them run in background while outline continues streaming
          Promise.all(bgPromises).then(() => {
            log.info(`🎬 [TRIAL] All ${Object.keys(sceneBackgrounds).length} empty scenes ready`);
          }).catch(() => {});
        }
      },
      onCoverScene: (coverData) => {
        // TRIAL MODE: Generate title page from the structured cover scene JSON
        if (!inputData.trialMode) return;
        if (streamingCoverPromises.has('titlePage') || skipImages || skipCovers) return;

        const coverTitle = coverData.title || streamingTitle || 'My Story';
        const coverScene = coverData.scene || coverData;

        const coverPromise = (async () => {
          try {
            // Wait for prerequisites: visual bible + avatar styling (cap at 5 minutes)
            let vbWait = 0;
            while (!streamingVisualBible && vbWait < 3000) {
              await new Promise(r => setTimeout(r, 100));
              vbWait++;
            }
            if (!streamingVisualBible) {
              log.warn('[TRIAL-COVER] Timed out waiting for Visual Bible — skipping cover');
              return null;
            }
            if (streamingAvatarStylingPromise) {
              log.debug(`[TRIAL-COVER] Waiting for avatar styling...`);
              await streamingAvatarStylingPromise;
            }

            // Build scene description from the cover hint JSON
            const sceneDescription = '```json\n' + JSON.stringify(coverScene, null, 2) + '\n```';

            // Determine which characters appear in the cover scene
            let coverCharacters = [];
            if (coverScene.characters?.length > 0) {
              const sceneCharNames = coverScene.characters.map(c => c.name?.toLowerCase());
              coverCharacters = (inputData.characters || []).filter(c =>
                sceneCharNames.includes(c.name?.toLowerCase())
              );
            }
            if (coverCharacters.length === 0) {
              coverCharacters = (inputData.characters || []).filter(c => c.isMainCharacter === true);
            }
            if (coverCharacters.length === 0) {
              coverCharacters = (inputData.characters || []).slice(0, 3);
            }

            // Build per-character clothing requirements
            const coverClothingReqs = { ...(inputData._trialClothingRequirements || {}) };
            if (coverScene.characters?.length > 0) {
              for (const sc of coverScene.characters) {
                if (sc.name && sc.clothing) {
                  coverClothingReqs[sc.name] = {
                    ...(coverClothingReqs[sc.name] || {}),
                    _currentClothing: sc.clothing
                  };
                }
              }
            }
            // Fallback: apply trial costume type for characters without explicit clothing.
            // Clone the entry before assigning so we don't pollute inputData._trialClothingRequirements.
            if (inputData._trialCostumeType) {
              for (const char of coverCharacters) {
                if (!coverClothingReqs[char.name]?._currentClothing) {
                  coverClothingReqs[char.name] = {
                    ...(coverClothingReqs[char.name] || {}),
                    _currentClothing: `costumed:${inputData._trialCostumeType}`
                  };
                }
              }
            }

            // Get character photos with styled avatars
            let coverPhotos = getCharacterPhotoDetails(coverCharacters, 'standard', artStyle, coverClothingReqs);
            coverPhotos = applyStyledAvatars(coverPhotos, artStyle);

            // Build prompt components
            const pageImageModel = MODEL_DEFAULTS.simplePageImage;
            const pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
            const styleDescription = resolveArtStyle(artStyle, pageImageBackend) || resolveArtStyle('pixar');
            const characterRefList = buildCharacterReferenceList(coverPhotos, inputData.characters);
            const visualBibleText = buildFullVisualBiblePrompt(streamingVisualBible, { skipMainCharacters: true });

            const coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
              TITLE_PAGE_SCENE: sceneDescription,
              STORY_TITLE: coverTitle,
              STYLE_DESCRIPTION: styleDescription,
              CHARACTER_REFERENCE_LIST: characterRefList,
              VISUAL_BIBLE: visualBibleText
            });

            // Build metadata directly — extractSceneMetadata can't parse our code-fenced JSON
            const sceneMetadata = {
              objects: coverScene.objects || [],
              fullData: coverScene,
              characters: coverScene.characters || [],
              setting: coverScene.setting || null,
            };
            const coverLandmarkPhotos = await getLandmarkPhotosForScene(streamingVisualBible, sceneMetadata);

            // Build VB grid (page number -1 = front cover convention)
            let elementRefs = getElementReferenceImagesForPage(streamingVisualBible, -1, 6);
            // Also match by IDs from cover scene objects
            if (coverScene.objects?.length > 0) {
              const sceneIds = coverScene.objects
                .map(obj => typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH|LOC)\d+)/i)?.[1] : null)
                .filter(Boolean);
              if (sceneIds.length > 0) {
                const idBasedRefs = getElementReferenceImagesByIds(streamingVisualBible, sceneIds.filter(id => !id.startsWith('LOC')));
                const existingIds = new Set(elementRefs.map(r => r.id));
                const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
                if (newRefs.length > 0) elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
              }
            }
            const secondaryLandmarks = coverLandmarkPhotos.slice(1);
            let coverVbGrid = null;
            if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
              coverVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
            }

            log.info(`[TRIAL-COVER] Starting title page generation (title: "${coverTitle}", ${coverCharacters.length} chars, ${coverLandmarkPhotos.length} landmarks${coverVbGrid ? ', VB grid' : ''})`);
            const startTime = Date.now();

            // Generate the image using simplePageImage model (same as trial pages)
            const result = await generateImageOnly(coverPrompt, coverPhotos, {
              imageModelOverride: pageImageModel,
              imageBackendOverride: pageImageBackend,
              landmarkPhotos: coverLandmarkPhotos,
              visualBibleGrid: coverVbGrid,
              aspectRatio: MODEL_DEFAULTS.coverAspect,
              pageNumber: -1
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            log.info(`[TRIAL-COVER] Title page image ready in ${elapsed}s`);

            // Track usage
            if (result.usage) {
              const isGrok = result.modelId?.startsWith('grok-imagine');
              const provider = isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, result.usage, 'cover_images', result.modelId);
            }

            // Save checkpoint for progressive display
            if (result.imageData) {
              await saveCheckpoint(jobId, 'partial_cover', {
                type: 'frontCover',
                imageData: result.imageData,
                storyTitle: coverTitle
              }, 0);
              log.debug(`[TRIAL-COVER] Saved partial_cover checkpoint`);
            }

            return {
              type: 'titlePage',
              imageData: result.imageData,
              description: sceneDescription,
              prompt: coverPrompt,
              modelId: result.modelId,
              referencePhotos: coverPhotos,
              landmarkPhotos: coverLandmarkPhotos,
              grokRefImages: result.grokRefImages || null
            };
          } catch (err) {
            log.warn(`[TRIAL-COVER] Title page generation failed: ${err.message}`);
            return null;
          }
        })();

        coverPromise.catch(err => log.warn(`[TRIAL-COVER] Promise failed (will be handled when awaited): ${err.message}`));
        streamingCoverPromises.set('titlePage', coverPromise);
        log.info(`[TRIAL-COVER] Started cover generation from streaming cover scene`);
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
        if (inputData.trialMode) {
          // Trial mode: kick off page image generation immediately (parallel with rest of stream)
          startTrialPageImageGeneration(page);
        } else {
          // Normal mode: scene expansion (image gen happens in Phase 5a)
          startSceneExpansion(page);
        }
      },
      onProgress: async (type, message, pageNum) => {
        // Rate limit progress updates (max once per 500ms)
        const now = Date.now();
        if (now - lastProgressUpdate < 500) return;
        lastProgressUpdate = now;

        // Calculate progress based on parallel work happening
        // Checkpoints numbered by ARRIVAL ORDER (not logical order)
        // Streaming: arcs → title → clothing → plot → VB → covers → pages
        // 1=start, 2=arcs, 3=title, 4=clothing, 5=plot, 6=VB, 7=covers/pages
        // 8=text done, 9=avatars, 10=scenes, 11-30=images, 31+=repair, 73=finalize, 100=done
        let progress = 1;
        if (type === 'arcs') progress = 2;                   // arrives first
        else if (type === 'title') progress = 3;             // arrives second
        else if (type === 'clothing') progress = 4;          // arrives third
        else if (type === 'plot') progress = 5;              // arrives fourth
        else if (type === 'visualBible') progress = 6;       // arrives fifth
        else if (type === 'covers') progress = 7;            // cover hints
        else if (type === 'page') progress = 7;              // pages streaming (same phase)

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
    }, { isTrial: !!inputData.trialMode });

    // Use streaming with progressive parsing and parallel task initiation
    // Use 64000 tokens to match Claude Sonnet's max output capacity for longer stories
    timing.storyGenStart = Date.now();
    // Heartbeat keeps story_jobs.updated_at fresh during the unified Sonnet
    // streaming phase. Without it, the status endpoint's 5-min stale check
    // would mark the job as failed mid-stream when the frontend polls — even
    // though the backend is happily streaming text. Long stories can take
    // 15+ minutes for the Sonnet response alone.
    const unifiedHeartbeat = createJobHeartbeat(jobId, dbPool);
    const unifiedResult = await callTextModelStreaming(unifiedPrompt, 64000, (chunk, fullText) => {
      progressiveParser.processChunk(chunk, fullText);
      unifiedHeartbeat();  // throttled — fires at most every 30s
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
    const titleCandidates = parser.extractTitleCandidates();
    const clothingRequirements = inputData.trialMode
      ? inputData._trialClothingRequirements
      : (parser.extractClothingRequirements() || streamingClothingRequirements);
    const visualBible = parser.extractVisualBible() || streamingVisualBible || {};
    const coverHints = parser.extractCoverHints();

    // Reconcile cover hint clothing against the story's clothingRequirements.
    // Claude can write a cover hint that asks for a clothing category that the
    // character did NOT mark used (e.g. back cover wants Sophie:standard but
    // Sophie's only used category is costumed:zauberlehrling). Generating a
    // never-otherwise-needed avatar would be wasted work AND a silent fallback
    // to the raw face photo would degrade quality. Override the cover hint to
    // use what the character actually has — mutates coverHints in place.
    const reconcileResult = reconcileCoverClothingWithRequirements(coverHints, clothingRequirements, log);
    if (reconcileResult.overrides.length > 0) {
      log.warn(`⚠️ [UNIFIED] Cover clothing reconciliation: ${reconcileResult.overrides.length} override(s) applied`);
    }

    // Debug: log cover hints character clothing (post-reconciliation)
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

    // Text consistency check removed (now handled by unified repair pipeline)

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

    // Phantom character detection: any name in scene hints that isn't in
    // main characters or the Visual Bible. Without this, the image generator
    // invents a different person for the same name on every page.
    try {
      const { detectAndPatchPhantomCharacters } = require('./server/lib/phantomCharacters');
      const phantomUsage = await detectAndPatchPhantomCharacters({
        storyPages,
        visualBible,
        inputCharacters: inputData.characters || [],
        modelId: MODEL_DEFAULTS.sceneIteration || 'claude-haiku-4-5',
      });
      if (phantomUsage) {
        addUsage('anthropic', phantomUsage, 'phantom_patch', phantomUsage.modelId || MODEL_DEFAULTS.sceneIteration);
      }
    } catch (err) {
      log.warn(`👻 [PHANTOM] Detection/patch failed (continuing): ${err.message}`);
    }

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

    // Cover-backdrop validation. Sonnet's cover-rule says every cover backdrop
    // LOC must (a) be marked isRealLandmark:true in the visual bible, AND
    // (b) trace back to a name in the AVAILABLE_LANDMARKS list. When Sonnet
    // breaks the rule (it does — see job_1778400519362_xwufe7ptv where it
    // invented LOC005 Limmatufer for the back cover), the composite-cover
    // pipeline ends up with no landmark photo and falls back to figures-on-
    // white. Catch the rule violation here and substitute a valid landmark
    // so the downstream cover gen actually has a backdrop.
    if (coverHints && Array.isArray(visualBible?.locations)) {
      const availableLandmarkNames = new Set(
        (inputData.availableLandmarks || []).map(l => String(l.name || '').toLowerCase())
      );
      // Pool of valid backdrops: VB locations that are real landmarks AND
      // whose landmarkQuery matches the input list. Prefer photo-bearing
      // (referencePhotoUrl from Swiss pre-indexed, or referenceImageUrl from
      // historical curation) so the substitute actually has bytes available.
      const validBackdrops = visualBible.locations.filter(loc => {
        if (!loc?.id || !loc.isRealLandmark) return false;
        if (!loc.landmarkQuery) return false;
        if (availableLandmarkNames.size > 0
            && !availableLandmarkNames.has(String(loc.landmarkQuery).toLowerCase())) return false;
        return true;
      });
      const photoBearing = validBackdrops.filter(loc =>
        loc.referencePhotoUrl || loc.referencePhotoData
        || loc.referenceImageUrl || loc.referenceImageData
        || (Array.isArray(loc.photoVariants) && loc.photoVariants.length > 0)
      );
      const fallback = photoBearing[0] || validBackdrops[0] || null;

      for (const [coverType, hint] of Object.entries(coverHints)) {
        if (!hint || !Array.isArray(hint.objects)) continue;
        const locIds = hint.objects.filter(o => typeof o === 'string' && /^LOC\d+/i.test(o));
        if (locIds.length === 0) continue;
        // Test the FIRST LOC (the primary backdrop). Subsequent LOCs are
        // secondary references and don't drive the composite landmark slot.
        const primary = locIds[0];
        const loc = visualBible.locations.find(l => l.id && l.id.toUpperCase() === primary.toUpperCase());
        if (!loc) continue;
        const isValidBackdrop = loc.isRealLandmark
          && loc.landmarkQuery
          && (availableLandmarkNames.size === 0
              || availableLandmarkNames.has(String(loc.landmarkQuery).toLowerCase()));
        if (isValidBackdrop) continue; // ✅ Sonnet picked correctly
        // ❌ Rule violation
        if (!fallback) {
          log.warn(`⚠️ [COVER-VALIDATE] ${coverType}: Sonnet picked ${primary} (${loc.name}) — not a real landmark from input — and NO valid fallback exists in this story's VB. Composite will run without a landmark backdrop.`);
          continue;
        }
        log.warn(`⚠️ [COVER-VALIDATE] ${coverType}: Sonnet picked ${primary} (${loc.name}) — not a real landmark from input. Substituting with ${fallback.id} (${fallback.name}).`);
        // Replace primary LOC, keep ART/other entries
        hint.objects = [fallback.id, ...hint.objects.filter(o => o !== primary)];
      }
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
      const refSheetModel = MODEL_DEFAULTS.image;
      const refSheetBackend = IMAGE_MODELS[refSheetModel]?.backend || null;
      const styleDescription = resolveArtStyle(artStyle, refSheetBackend) || resolveArtStyle('pixar');
      referenceSheetPromise = generateReferenceSheet(visualBible, styleDescription, {
        minAppearances: 2, // Elements appearing on 2+ pages
        maxPerBatch: 4,    // Max 4 elements per grid for quality
        maxElements: null, // Generate reference sheets for all qualifying elements
        storyId: jobId,    // Phase 1d R2 dual-write: refs upload to stories/{jobId}/vb/{entryId}.jpg
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
    // Picture-book layout for all reading levels: 1 scene = 1 print page
    const printPageCount = storyPages.length;

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
      [8, `Story complete: "${title}" (${scenesStarted} scenes in parallel)`, jobId]  // 8 = text complete
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
          await prepareStyledAvatars(inputData.characters || [], artStyle, basicCoverRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
          log.debug(`✅ [UNIFIED] Pre-cover styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.warn(`⚠️ [UNIFIED] Pre-cover styled avatar prep failed: ${error.message}`);
        }
      }
    }

    // NOTE: Avatar generation removed. Avatars should already exist from character creation.

    // PHASE 2: Prepare styled avatars
    await checkCancellation();
    genLog.setStage('avatars');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [9, `Preparing styled avatars...`, jobId]  // 9 = avatar styling
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
    // Skip if early avatar styling already succeeded (avoids duplicate costumed avatar generation)
    // If early styling was attempted but failed (promise exists but succeeded=false), run PHASE 2 as fallback
    // Run avatar styling when: non-realistic style OR costumed clothing exists (costumes need generation even for realistic)
    const hasCostumedClothing = Object.values(clothingRequirements || {}).some(r => r?.costumed?.used);
    if (avatarRequirements.length > 0 && (artStyle !== 'realistic' || hasCostumedClothing) && !earlyAvatarStylingSucceeded) {
      // Validate that characters have base avatars
      const charactersWithoutAvatars = (inputData.characters || []).filter(c =>
        !c.avatars?.standard && !c.photoUrl && !c.bodyNoBgUrl
      );
      if (charactersWithoutAvatars.length > 0) {
        log.warn(`⚠️ [UNIFIED] Characters missing base avatars: ${charactersWithoutAvatars.map(c => c.name).join(', ')}`);
      }

      log.debug(`🎨 [UNIFIED] Preparing ${avatarRequirements.length} styled avatars for ${artStyle} (early styling did not run)`);
      await prepareStyledAvatars(inputData.characters, artStyle, avatarRequirements, clothingRequirements, addUsage, modelOverrides.storyAvatarModel || null);
    } else if (earlyAvatarStylingSucceeded) {
      log.debug(`⏭️ [UNIFIED] Skipping PHASE 2 avatar styling - early styling already completed (${getStyledAvatarCacheStats().size} cached)`);
    }

    // Start cover generation NOW that avatars are ready (covers need avatars as reference photos)
    if (!skipImages && !skipCovers) {
      const coverTypes = inputData.titlePageOnly
        ? ['titlePage']
        : ['titlePage', 'initialPage', 'backCover'];
      for (const coverType of coverTypes) {
        if (streamingCoverPromises.has(coverType)) continue;
        const hint = coverHints?.[coverType];
        if (hint) {
          startCoverGeneration(coverType, hint);
        } else if (coverType === 'titlePage') {
          // Trial mode: Claude may not output cover hints — use a default hint
          const mainCharNames = inputData.characters
            ?.filter(c => c.isMainCharacter)
            .map(c => c.name)
            .join(', ') || inputData.characters?.map(c => c.name).slice(0, 3).join(', ') || 'the main character';
          const theme = inputData.storyTopic || inputData.storyTheme || 'adventure';
          const defaultHint = {
            hint: `A magical, eye-catching front cover scene featuring ${mainCharNames} in a ${theme}-themed setting. The main characters are prominently displayed, looking excited and ready for adventure. The composition leaves space at the top for the title.`,
            characterClothing: {}
          };
          if (inputData._trialCostumeType) {
            for (const char of (inputData.characters || [])) {
              defaultHint.characterClothing[char.name] = `costumed:${inputData._trialCostumeType}`;
            }
          }
          startCoverGeneration(coverType, defaultHint);
        }
      }
      log.debug(`⚡ [UNIFIED] Started ${streamingCoverPromises.size} cover generations (avatars ready)`);
    }

    // PHASE 3: Scene descriptions
    let expandedScenes;

    if (inputData.trialMode) {
      // Trial mode: use enriched scene hints directly as scene descriptions
      log.info(`⏭️ [TRIAL] Skipping scene expansion — using rich scene hints directly`);
      expandedScenes = storyPages.map(page => ({
        pageNumber: page.pageNumber,
        text: page.text,
        sceneHint: page.sceneHint,
        sceneDescription: page.sceneHint,
        sceneDescriptionPrompt: null,
        sceneDescriptionModelId: null,
        characterClothing: page.characterClothing || {},
        characters: page.characters
      }));
    } else {
      // Normal flow: wait for scene expansions
      genLog.setStage('scenes');
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [10, `Finalizing ${streamingSceneExpansionPromises.size} scene expansions...`, jobId]  // 10 = scenes expanded
      );

      // Start any missing scene expansions
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

      // Sort by page number
      expandedScenes = sceneResults.sort((a, b) => a.pageNumber - b.pageNumber);
      log.debug(`✅ [UNIFIED] All ${expandedScenes.length} scene expansions complete`);
      genLog.info('scenes_complete', `All ${expandedScenes.length} scene expansions complete`);

      // FIX: Update characterClothing from full re-parse
      for (const scene of expandedScenes) {
        const fullParsePage = storyPages.find(p => p.pageNumber === scene.pageNumber);
        if (fullParsePage?.characterClothing && Object.keys(fullParsePage.characterClothing).length > 0) {
          const streamingClothing = scene.characterClothing || {};
          const fullClothing = fullParsePage.characterClothing;
          for (const [charName, fullValue] of Object.entries(fullClothing)) {
            const streamingValue = streamingClothing[charName];
            if (streamingValue && fullValue && streamingValue !== fullValue) {
              log.debug(`[CLOTHING FIX] Page ${scene.pageNumber} ${charName}: "${streamingValue}" -> "${fullValue}"`);
            }
          }
          scene.characterClothing = fullClothing;
        }
      }
    }

    // Log streaming efficiency (for non-trial)
    if (!inputData.trialMode) {
      const pagesFromStreaming = streamingExpandedPages.size;
      log.debug(`📊 [UNIFIED] Streaming efficiency: ${pagesFromStreaming}/${storyPages.length} pages started during streaming`);
    }

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

    // Batch-translate scene summaries to story language (separate from scene expansion)
    // One cheap Haiku call with all summaries — ~1-2s, ~$0.001
    if (lang !== 'en') {
      try {
        const summaries = allSceneDescriptions
          .map(s => `Page ${s.pageNumber}: ${s.imageSummary || ''}`)
          .filter(s => s.includes(': ') && s.split(': ')[1].trim())
          .join('\n');
        if (summaries) {
          const { getLanguageInstruction } = require('./server/lib/languages');
          const langInstruction = getLanguageInstruction(lang);
          const translationPrompt = `Translate each scene summary below to the target language. Output ONLY the translations, one per line, in the same order. Keep it concise (1-2 sentences each).\n\nTarget language: ${langInstruction}\n\n${summaries}`;
          const { callTextModelStreaming } = require('./server/lib/textModels');
          const transResult = await callTextModelStreaming(translationPrompt, 2000, null, 'claude-haiku-4-5-20251001');
          if (transResult?.text) {
            const translations = transResult.text.trim().split('\n').filter(l => l.trim());
            let tIdx = 0;
            for (const scene of allSceneDescriptions) {
              if (scene.imageSummary && tIdx < translations.length) {
                // Strip "Page N: " prefix if the model echoed it
                scene.translatedSummary = translations[tIdx].replace(/^Page\s+\d+:\s*/i, '').trim();
                tIdx++;
              }
            }
            addUsage('anthropic', transResult.usage, 'scene_translation', transResult.modelId);
            log.info(`🌐 [TRANSLATION] Batch-translated ${tIdx} scene summaries to ${lang} ($${(transResult.usage?.cost || 0).toFixed(4)})`);
          }
        }
      } catch (transErr) {
        log.warn(`⚠️ [TRANSLATION] Batch translation failed: ${transErr.message}`);
      }
    }

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

      // Create promise but don't await yet - covers run parallel with page images.
      // IMPORTANT: .catch() here prevents unhandled rejection crash if a cover fails
      // before coverAwaitPromise is awaited at line ~4214. Without this, a Grok 500
      // error between promise creation and await crashes the Node process.
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
              landmarkPhotos: result.landmarkPhotos,
              grokRefImages: result.grokRefImages || null,
              modelId: result.modelId,
              generatedAt: new Date().toISOString()
            };
          }
        }
        log.debug(`✅ [UNIFIED] All ${Object.keys(coverImages).length} cover images complete`);
        log.debug(`⏱️ [UNIFIED] Cover images: ${((timing.coversEnd - (timing.coversStart || timing.storyGenEnd)) / 1000).toFixed(1)}s`);
      }).catch(err => {
        timing.coversEnd = Date.now();
        log.error(`❌ [UNIFIED] Cover generation failed: ${err.message}`);
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
    let referenceSheetSourceGrids = null;
    let referenceSheetBatchMeta = null;
    if (referenceSheetPromise) {
      const refResult = await referenceSheetPromise;
      if (refResult.generated > 0) {
        log.info(`🖼️ [UNIFIED] Reference images ready: ${refResult.generated} generated for secondary elements`);
      }
      // Capture source grids + batch metadata. The image bytes go to
      // story_images (saved after upsert). The lightweight metadata
      // (element names per batch) goes into storyData so the dev panel can
      // label which cell corresponds to which element.
      referenceSheetSourceGrids = refResult.sourceGrids || null;
      if (referenceSheetSourceGrids) {
        referenceSheetBatchMeta = referenceSheetSourceGrids.map(g => ({
          batchIdx: g.batchIdx,
          elementNames: g.elementNames,
          elementIds: g.elementIds,
        }));
      }
    }

    // PHASE 5: Generate page images
    // Sequential mode when incremental consistency is enabled, parallel otherwise
    await checkCancellation();
    genLog.setStage('images');
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [11, 'Generating page illustrations...', jobId]  // 11 = images start
    );

    timing.pagesStart = Date.now();
    let allImages;
    let pipelineEntityReport = null;
    let pipelineCharFixDetails = null;
    let pipelineStyleConsistency = null;

    {
      // =======================================================================
      // UNIFIED PIPELINE: Generate all → Evaluate → Repair (if enabled)
      // =======================================================================
      log.info(`🚀 [UNIFIED] Using unified pipeline (fullRepair=${enableFullRepair})`);

      // Helper function to prepare page data without generation (for later use by pipeline)
      const preparePageData = async (scene, index) => {
        const pageNum = scene.pageNumber;

        // Spread-parity flip: when Sonnet picks a textPosition on the wrong
        // side for the spread (odd=left / even=right), enforceSpreadTextPosition
        // flips the corner. The prose Sonnet wrote — character positions, path
        // direction, vanishing-point references, "upper-X corner" surfaces —
        // was anchored to the original side, so the empty scene and page image
        // would receive a calm-zone instruction on one side and geometry
        // pointing at the other. Mirror left↔right in the prose + emptyScene
        // prompt so both renderers see side-consistent geometry.
        //
        // mirrorLeftRight only swaps directional uses of left/right (compound
        // corners, positional-noun followers, prepositional, visual-verb
        // contexts, possessive + body-noun) — bare verb/idiom uses ("she left",
        // "what was left", "right away") are preserved.
        try {
          const { mirrorLeftRight } = require('./server/lib/storyHelpers');
          const sonnetMeta = extractSceneMetadata(scene.sceneDescription);
          const sonnetTP = sonnetMeta?.textPosition || null;
          const correctedTP = enforceSpreadTextPosition(sonnetTP, pageNum);
          if (sonnetTP && correctedTP && sonnetTP !== correctedTP) {
            log.warn(`🪞 [SIDE-MIRROR] Page ${pageNum}: textPosition ${sonnetTP} → ${correctedTP}; mirroring left↔right in scene prose + emptyScenePrompt`);
            scene.sceneDescription = mirrorLeftRight(scene.sceneDescription);
            // The mirror flips textPosition inside the metadata block too
            // (e.g. "top-left" → "top-right"). That's actually what we want
            // since the corrected value matches, but be defensive: stamp the
            // corrected value back in case the metadata had a different shape.
            scene.sceneDescription = scene.sceneDescription.replace(
              /("textPosition"\s*:\s*")(top-left|top-right|bottom-left|bottom-right|top-full|bottom-full)(")/g,
              `$1${correctedTP}$3`
            );
            if (scene.emptyScenePrompt) scene.emptyScenePrompt = mirrorLeftRight(scene.emptyScenePrompt);
            if (scene.sceneHint && typeof scene.sceneHint === 'string' && scene.sceneHint.includes('emptyScenePrompt')) {
              scene.sceneHint = mirrorLeftRight(scene.sceneHint).replace(
                /("textPosition"\s*:\s*")(top-left|top-right|bottom-left|bottom-right|top-full|bottom-full)(")/g,
                `$1${correctedTP}$3`
              );
            }
          }
        } catch (err) {
          log.warn(`[SIDE-MIRROR] Page ${pageNum}: mirror step failed, continuing without flip — ${err.message}`);
        }

        const sceneCharacters = getCharactersInScene(scene.sceneDescription, inputData.characters);
        // Characters section takes priority over scene metadata JSON (may have stale costume data)
        const sceneMetadataForClothing = extractSceneMetadata(scene.sceneDescription);
        const perCharClothing = {
          ...(sceneMetadataForClothing?.characterClothing || {}),
          ...(scene.characterClothing || {})
        };
        // Warn when scene expansion metadata disagrees with outline clothing
        // (the outline wins via the spread operator above, but the prose may still
        // describe the wrong outfit — the prompt fix in scene-expansion.txt addresses this)
        const outlineClothing = scene.characterClothing || {};
        const sceneClothing = sceneMetadataForClothing?.characterClothing || {};
        for (const [name, outfitFromOutline] of Object.entries(outlineClothing)) {
          const outfitFromScene = sceneClothing[name];
          if (outfitFromScene && outfitFromScene !== outfitFromOutline) {
            log.warn(`⚠️ [CLOTHING MISMATCH] P${pageNum} ${name}: outline="${outfitFromOutline}" but scene expansion wrote "${outfitFromScene}" — using outline`);
          }
        }
        // Trial mode fallback: if parser didn't extract clothing from JSON scene hint,
        // use the trial costume type for main characters
        if (inputData.trialMode && inputData._trialCostumeType && Object.keys(perCharClothing).length === 0) {
          const mainCharIds = inputData.mainCharacters || [];
          for (const char of (inputData.characters || [])) {
            const isMain = char.isMainCharacter === true || mainCharIds.includes(char.id);
            if (isMain) {
              perCharClothing[char.name] = `costumed:${inputData._trialCostumeType}`;
              log.debug(`🎭 [TRIAL COSTUME] Page ${pageNum}: Fallback — no clothing parsed, using costumed:${inputData._trialCostumeType} for ${char.name}`);
            }
          }
        }
        const defaultClothing = 'standard';
        // Shallow spread shares nested character objects with clothingRequirements.
        // We MUST clone the inner entry before assigning _currentClothing —
        // otherwise the per-scene value leaks into storyData.clothingRequirements
        // and sticks around for every subsequent page and iterate call.
        const sceneClothingRequirements = { ...clothingRequirements };
        for (const char of sceneCharacters) {
          const charNameTrimmed = char.name.trim().toLowerCase();
          // Per-scene clothing from Claude's hint or Art Director expansion
          let charClothing = Object.entries(perCharClothing).find(
            ([name]) => name.trim().toLowerCase() === charNameTrimmed
          )?.[1];
          // Fallback: if not in per-scene data, check global clothingRequirements for a costumed variant
          if (!charClothing) {
            const globalReqs = clothingRequirements?.[char.name] || Object.entries(clothingRequirements || {}).find(([n]) => n.trim().toLowerCase() === charNameTrimmed)?.[1];
            if (globalReqs?.costumed?.used && globalReqs.costumed.costume) {
              charClothing = `costumed:${globalReqs.costumed.costume}`;
              log.debug(`👕 [CLOTHING FALLBACK] ${char.name}: no per-scene clothing, using global costumed:${globalReqs.costumed.costume}`);
            } else {
              charClothing = defaultClothing;
            }
          }
          sceneClothingRequirements[char.name] = {
            ...(sceneClothingRequirements[char.name] || {}),
            _currentClothing: charClothing
          };
        }
        let pagePhotos = getCharacterPhotoDetails(sceneCharacters, defaultClothing, inputData.artStyle, sceneClothingRequirements);
        // applyStyledAvatars now skips costumed-* entries internally (see
        // styledAvatars.js), so it's safe to call on a mixed-clothing scene.
        pagePhotos = applyStyledAvatars(pagePhotos, inputData.artStyle);
        let sceneMetadata = extractSceneMetadata(scene.sceneDescription);
        // over-the-shoulder: the target character is tiny, soft-focused, in the
        // distance — attaching its reference photo would force Grok to render it
        // at portrait scale. Keep only the first character (the acting one) as a
        // reference; the rest ride in prose only.
        if (sceneMetadata?.framingPattern === 'over-the-shoulder' && pagePhotos.length > 1) {
          const dropped = pagePhotos.slice(1).map(p => p.name).join(', ');
          pagePhotos = pagePhotos.slice(0, 1);
          log.info(`🎯 [FRAMING] Page ${pageNum} over-the-shoulder: kept ${pagePhotos[0]?.name}, dropped refs for ${dropped}`);
        }
        // Trial mode fallback: scene hints are plain text, so extract LOC IDs manually
        if (!sceneMetadata && scene.sceneDescription) {
          const locMatches = [...scene.sceneDescription.matchAll(/\[LOC(\d+)\]/gi)];
          const locNameMatches = [...scene.sceneDescription.matchAll(/([A-Za-zÀ-ÿ][\w\s()-]*?)\s*\[LOC\d+\]/gi)];
          if (locMatches.length > 0) {
            sceneMetadata = {
              objects: locMatches.map((m, i) => {
                const name = locNameMatches[i]?.[1]?.trim() || '';
                return name ? `${name} [LOC${m[1].padStart(3, '0')}]` : `LOC${m[1].padStart(3, '0')}`;
              }),
              setting: {},
              isJsonFormat: false,
            };
          }
        }
        const pageLandmarkPhotos = await getLandmarkPhotosForScene(visualBible, sceneMetadata);
        let elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
        // Drop location elements when an empty scene background exists — the location
        // is already painted into the background, so a VB grid cell showing the same
        // location is redundant and wastes a reference slot.
        if (sceneBackgrounds[pageNum]) {
          elementReferences = elementReferences.filter(e => e.type !== 'location');
        }
        // Fallback: also match by IDs found in scene hint (covers page mismatch between VB and scene)
        if (sceneMetadata?.fullData) {
          const sceneIds = [];
          // Extract CHR IDs from characters
          for (const char of sceneMetadata.fullData.characters || []) {
            if (char.id && char.id !== 'null') sceneIds.push(char.id);
          }
          // Extract ART/OBJ IDs from objects
          for (const obj of sceneMetadata.fullData.objects || []) {
            const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
            if (id && !id.startsWith('LOC')) sceneIds.push(id);
          }
          if (sceneIds.length > 0) {
            const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds);
            const existingIds = new Set(elementReferences.map(r => r.id));
            const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
            if (newRefs.length > 0) {
              log.info(`🔗 [VB-MATCH] Page ${pageNum}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
              elementReferences = [...elementReferences, ...newRefs].slice(0, 6);
            }
          }
        }
        const secondaryLandmarks = pageLandmarkPhotos.slice(1);
        let visualBibleGrid = null;
        if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
          visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
        }
        // Determine per-page image model based on scene complexity
        const sceneComplexity = sceneMetadata?.sceneComplexity || 'simple';
        const sceneRouting = modelOverrides.sceneRouting || 'auto';
        let pageImageModel, pageImageBackend;

        if (sceneRouting === 'auto') {
          pageImageModel = sceneComplexity === 'complex'
            ? MODEL_DEFAULTS.complexPageImage
            : MODEL_DEFAULTS.simplePageImage;
          pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'gemini';
          log.info(`🎯 [ROUTING] Page ${pageNum}: ${sceneComplexity} → ${pageImageModel} (${pageImageBackend})`);
        } else if (sceneRouting === 'grok') {
          pageImageModel = MODEL_DEFAULTS.simplePageImage;
          pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'grok';
        } else if (sceneRouting === 'gemini') {
          pageImageModel = MODEL_DEFAULTS.complexPageImage;
          pageImageBackend = IMAGE_MODELS[pageImageModel]?.backend || 'gemini';
        } else {
          pageImageModel = modelOverrides.imageModel;
          pageImageBackend = modelOverrides.imageBackend;
        }

        // Skip Visual Bible text when using Grok (8000 char limit; VB grid sent as reference image)
        const imageModelConfig = IMAGE_MODELS[pageImageModel];
        const isGrokImage = imageModelConfig?.backend === 'grok';
        const imagePrompt = buildImagePrompt(
          scene.sceneDescription, inputData, sceneCharacters, false, visualBible, pageNum, true, pagePhotos, { skipVisualBible: isGrokImage }
        );
        // Extract emptyScenePrompt from outline hint (Sonnet-generated, high quality)
        // Falls back to scene expansion's emptyScenePrompt via sceneMetadata
        let outlineEmptyScenePrompt = null;
        try {
          const hintJson = scene.sceneHint || scene.outlineExtract || '';
          if (hintJson.includes('{')) {
            const parsed = JSON.parse(hintJson.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim());
            outlineEmptyScenePrompt = parsed?.emptyScenePrompt || null;
          }
        } catch { /* not valid JSON — fine */ }

        return {
          pageNumber: pageNum,
          index,
          scene,
          prompt: imagePrompt,
          characterPhotos: pagePhotos,
          landmarkPhotos: pageLandmarkPhotos,
          visualBibleGrid,
          sceneCharacters,
          sceneMetadata,
          perCharClothing,
          pageImageModel,
          pageImageBackend,
          sceneComplexity,
          // Outline-level emptyScenePrompt (from Sonnet) — used if scene expansion doesn't produce one
          emptyScenePrompt: outlineEmptyScenePrompt,
        };
      };

      // Phase 5a: Prepare all page data
      log.info(`📸 [UNIFIED] Phase 5a: Preparing ${expandedScenes.length} pages for image generation...`);
      const pageDataArray = await Promise.all(
        expandedScenes.map((scene, index) => preparePageData(scene, index))
      );

      // Reference-mode + single-pass flags resolved once for the run. Per-page
      // overrides (test-models / iterate) are read in the call sites.
      const runReferenceMode = modelOverrides.referenceMode || MODEL_DEFAULTS.referenceMode || 'strict';
      // Explicit false from the wizard must beat MODEL_DEFAULTS.singlePassScene=true.
      const runSinglePassScene = typeof modelOverrides.singlePassScene === 'boolean'
        ? modelOverrides.singlePassScene
        : MODEL_DEFAULTS.singlePassScene === true;
      log.info(`🎛️ [UNIFIED] referenceMode=${runReferenceMode} singlePassScene=${runSinglePassScene}`);

      // Phase 5a-pre-vantage: render ONE backdrop canvas per Visual Bible
      // location vantage and reuse it across every page that uses that vantage.
      // Runs regardless of singlePassScene — the canvas is shared, so the cost
      // is bounded by the number of distinct vantages (typically 2-5 per story)
      // and the win is location consistency across pages.
      if (modelOverrides.generateEmptyScenes !== false && visualBible?.locations?.length > 0) {
        const { groupPagesByVantage, enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./server/lib/storyHelpers');
        const groups = groupPagesByVantage(pageDataArray, visualBible);
        const realGroups = Array.from(groups.entries()).filter(([key]) => key !== '__unassigned__');
        if (realGroups.length > 0) {
          log.info(`🏛️ [UNIFIED] Phase 5a-pre-vantage: ${realGroups.length} location vantage(s) for ${pageDataArray.length} page(s)`);
          const vStart = Date.now();
          const vLimit = pLimit(20);
          const { getTextAreaMask } = require('./server/lib/textMasks');
          await Promise.all(realGroups.map(([vantageId, group]) => vLimit(async () => {
            await checkCancellation();
            const v = group.vantage;
            // Pull a representative page so we can inherit aspect / model / landmark refs.
            const repPageNum = group.pageNumbers[0];
            const repPageData = pageDataArray.find(pd => pd.pageNumber === repPageNum);
            if (!repPageData) return;
            const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', repPageData.pageImageBackend) || '';
            const layoutAspect = inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect;
            // Vantage canvas is GENERIC — no character-space hints (the canvas
            // serves multiple pages with different cast/positions), no calm-zone
            // (text overlay zone differs per page via spread rule). The per-page
            // image render handles those.
            const eraGuard = buildEraGuard(repPageData.sceneMetadata?.era || null);
            const shotPrefix = v.shot ? `**SHOT:** ${v.shot}\n\n` : '';
            const emptySceneDesc = `${shotPrefix}**LOCATION:** ${v.locationName || ''}\n**VANTAGE:** ${v.name || ''}\n\n${v.description || ''}`;
            const characterSpace = `Render this as an empty location backdrop. Foreground, midground and background bands all show the scene's natural ground/floor/water surface continuing unbroken — characters will be composited into them later. No figures, no animals.`;
            // Pull landmark photos for the LOC if real — used as a strict
            // visual reference for the Wikimedia-photo case.
            const landmarkPhotos = (v.location?.isRealLandmark && v.location?.referencePhotoData)
              ? [{ name: v.location.name, photoData: v.location.referencePhotoData, attribution: v.location.photoAttribution, source: v.location.photoSource }]
              : (repPageData.landmarkPhotos || []);
            const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
              STYLE_DESCRIPTION: artStyleDesc,
              EMPTY_SCENE_DESCRIPTION: emptySceneDesc,
              CHARACTER_SPACE: characterSpace,
              TEXT_AREA_INSTRUCTION: '',
              ERA_GUARD: eraGuard,
            });
            try {
              const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, repPageNum, landmarkPhotos);
              const emptySceneVbGridDataUrl = emptySceneVbGrid
                ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
                : null;
              const result = await generateImageOnly(emptyPrompt, [], {
                aspectRatio: layoutAspect,
                imageModelOverride: repPageData.pageImageModel,
                imageBackendOverride: repPageData.pageImageBackend,
                landmarkPhotos,
                visualBibleGrid: emptySceneVbGrid,
                pageNumber: repPageNum,
                skipCache: true,
                pageContext: `vantage-${vantageId}`,
              });
              if (result?.usage) {
                const isRunware = result.modelId?.startsWith('runware:');
                const isGrok = result.modelId?.startsWith('grok-imagine');
                const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
                addUsage(provider, result.usage, 'page_images', result.modelId);
              }
              if (!result?.imageData) {
                log.warn(`⚠️ [VANTAGE] ${vantageId} (${v.locationName} – ${v.name}) produced no image`);
                return;
              }
              // Fan out the same canvas to every page in the group.
              for (const pn of group.pageNumbers) {
                if (sceneBackgrounds[pn]) continue; // pre-populated (e.g. trial mode)
                sceneBackgrounds[pn] = {
                  imageData: result.imageData,
                  prompt: emptyPrompt,
                  textAreaMask: null,
                  emptySceneVbGrid: emptySceneVbGridDataUrl,
                  vantageId,
                  vantageName: v.name,
                  locationName: v.locationName,
                };
              }
              log.info(`🏛️ [VANTAGE] ${vantageId} ${v.locationName} – ${v.name}: 1 canvas → pages [${group.pageNumbers.join(',')}]`);
            } catch (err) {
              log.warn(`⚠️ [VANTAGE] ${vantageId} failed: ${err.message}`);
            }
          })));
          const vElapsed = ((Date.now() - vStart) / 1000).toFixed(1);
          const covered = Object.keys(sceneBackgrounds).length;
          log.info(`🏛️ [UNIFIED] Phase 5a-pre-vantage: ${realGroups.length} canvases → ${covered} pages covered in ${vElapsed}s (saved ${Math.max(0, covered - realGroups.length)} redundant generations)`);
        }
      }

      // Phase 5a-pre: Generate empty scene backgrounds (no characters) for style anchoring
      // Note: sceneBackgrounds may already have entries from trial mode early generation
      // OR from Phase 5a-pre-vantage above (vantage canvas covers most pages).
      if (modelOverrides.generateEmptyScenes !== false && !runSinglePassScene) {
        log.info(`🎨 [UNIFIED] Phase 5a-pre: Generating ${pageDataArray.length} empty scene backgrounds...`);
        const bgStartTime = Date.now();
        const bgLimit = pLimit(50);

        const emptyScenes = await Promise.all(
          pageDataArray.map(pageData => bgLimit(async () => {
            await checkCancellation();
            // Skip if already generated (e.g., trial mode early generation from visual bible)
            if (sceneBackgrounds[pageData.pageNumber]) return null;
            const sceneMetadata = pageData.sceneMetadata;
            const settingDesc = sceneMetadata?.setting?.description || sceneMetadata?.imageSummary || '';
            // emptyScenePrompt lives on pageData (from scene expansion), not on sceneMetadata
            const expandedEmptyPrompt = pageData.emptyScenePrompt || sceneMetadata?.emptyScenePrompt || '';
            if (!settingDesc && !expandedEmptyPrompt) return null;

            const artStyleDesc = resolveArtStyle(inputData.artStyle || 'pixar', pageData.pageImageBackend) || '';
            const camera = sceneMetadata?.setting?.camera || 'wide shot';
            const lighting = sceneMetadata?.setting?.lighting || '';
            const weather = sceneMetadata?.setting?.weather || '';

            // Use rich emptyScenePrompt from scene expansion if available, fallback to metadata fields.
            // Prepend a **SHOT:** line — the template ends with "Use the exact camera angle and
            // perspective described above" but Sonnet's emptyScenePrompt prose usually omits shot,
            // so without this prefix the "above" reference is dead text and Grok picks its own
            // angle (often disagreeing with the populated-page angle that uses the same background).
            const shotForCamera = (sceneMetadata?.fullData?.shot || camera || '').trim();
            const shotPrefix = shotForCamera ? `**SHOT:** ${shotForCamera}\n\n` : '';
            const emptySceneDesc = shotPrefix + (expandedEmptyPrompt
              || `**SETTING:** ${settingDesc}\n**CAMERA:** ${camera}${lighting ? `\n**LIGHTING:** ${lighting}` : ''}${weather ? `\n**WEATHER:** ${weather}` : ''}`);

            // Classify each character by depth AND lateral side so the empty scene leaves
            // room in the right band. "Leave space for 2 figures in the far background" is
            // useless when the two figures need to be at opposite edges — Grok will paint
            // buildings flanking both sides and the characters get jammed together later.
            const characters = sceneMetadata?.fullData?.characters || [];
            const buckets = { fgLeft: 0, fgRight: 0, fgCenter: 0, mgLeft: 0, mgRight: 0, mgCenter: 0, bgLeft: 0, bgRight: 0, bgCenter: 0 };
            for (const char of characters) {
              const depth = (char.depth || '').toLowerCase();
              const pos = (char.position || '').toLowerCase();
              const isBg = depth === 'background' || pos.includes('far background') || pos.includes('tiny figure') || pos.includes('background');
              const isMg = !isBg && (depth === 'midground' || pos.includes('midground'));
              const depthKey = isBg ? 'bg' : isMg ? 'mg' : 'fg';
              // Parse lateral side — normalise "center-left"/"left-center" to just "left" etc.
              const isLeft = /\bfar[-\s]?left|\bleft\b/.test(pos) && !/right/.test(pos);
              const isRight = /\bfar[-\s]?right|\bright\b/.test(pos) && !/left/.test(pos);
              const sideKey = isLeft ? 'Left' : isRight ? 'Right' : 'Center';
              buckets[depthKey + sideKey]++;
            }
            const total = (depth) => buckets[depth + 'Left'] + buckets[depth + 'Right'] + buckets[depth + 'Center'];
            let characterSpace = '';
            if (total('fg') + total('mg') + total('bg') > 0) {
              const parts = [];
              const describe = (depth, label) => {
                const L = buckets[depth + 'Left'], R = buckets[depth + 'Right'], C = buckets[depth + 'Center'];
                const t = L + R + C;
                if (t === 0) return;
                const sides = [];
                if (L > 0) sides.push(`${L} on the left`);
                if (R > 0) sides.push(`${R} on the right`);
                if (C > 0) sides.push(`${C} in the center`);
                parts.push(`${t} character${t > 1 ? 's' : ''} in the ${label}${sides.length > 0 ? ` (${sides.join(', ')})` : ''}`);
              };
              describe('fg', 'foreground');
              describe('mg', 'midground');
              describe('bg', 'far background');
              // Frame these bands as scene material that continues unbroken — NOT as
              // "open space" or "leave room", which Grok reads as render-less and
              // resolves with blank patches or half-finished building fragments.
              // The figure will be composited on top later; until then the band must
              // render as the scene's natural ground (cobblestones, grass, road,
              // floor, sand — whichever the setting calls for).
              characterSpace = `${parts.join(' and ').replace(/^./, c => c.toUpperCase())} will be composited into this scene later. Render those bands as the scene's natural ground surface (cobblestones, grass, road, floor, sand — whatever the setting calls for) continuing through unbroken. Lighting and ground texture must continue across them. They hold no props, signage, vehicles, or extra structures, but they ARE part of the scene — never blank, white, or unfinished patches, never abrupt building cutoffs.`;

              // If any depth band needs both-sides placement, spell it out so Grok doesn't
              // wall the frame with buildings on left and right.
              const bothSides = ['fg', 'mg', 'bg'].find(d => buckets[d + 'Left'] > 0 && buckets[d + 'Right'] > 0);
              if (bothSides) {
                const label = { fg: 'foreground', mg: 'midground', bg: 'far background' }[bothSides];
                characterSpace += ` Both the far-left and far-right ${label} render as flat continuous ground — no building walls, props, or barriers between the two sides.`;
              }

              // For close-up/medium shots, add explicit space guidance so the empty scene
              // doesn't fill the frame with just furniture (e.g. table surface only)
              const shotType = (sceneMetadata?.fullData?.shot || camera || '').toLowerCase();
              if (shotType.includes('close') || shotType.includes('medium')) {
                characterSpace += ` This is a ${shotType.includes('close') ? 'close-up' : 'medium'} shot — characters will be composited into this scene later. The frame must include enough space for character bodies to be placed naturally.`;
              }
            }

            // Build text area instruction from scene metadata (keeps text area calm in empty scene too)
            // Enforce spread rule: odd pages = left side, even = right side
            const { enforceSpreadTextPosition, buildTextZoneInstruction, buildEraGuard } = require('./server/lib/storyHelpers');
            const sonnetTextPos = sceneMetadata?.textPosition || null;
            const textPos = enforceSpreadTextPosition(sonnetTextPos, pageData.pageNumber);
            // If spread rule flipped Sonnet's left/right, Sonnet's textZoneDescription
            // was written for the wrong side — discard it and let the code-generated
            // fallback (generic saturated-surface wording) drive the instruction.
            const sideFlipped = sonnetTextPos && textPos && sonnetTextPos !== textPos;
            const textZoneDesc = sideFlipped ? null : (sceneMetadata?.textZoneDescription || null);
            if (sideFlipped) {
              log.warn(`⚠️ [UNIFIED] Page ${pageData.pageNumber}: Sonnet picked ${sonnetTextPos} against spread rule → flipped to ${textPos}, discarding textZoneDescription`);
            }
            const langLevel = inputData.languageLevel || 'standard';
            // textInImage drives whether we ask the model to keep a calm zone for
            // text overlay AND whether we attach the visual mask reference. When
            // text is rendered below the image (advanced layout), neither is needed.
            const layoutTextInImage = inputData?.layout?.textInImage !== false;
            const layoutAspect = inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect;
            // Load pre-built text area mask (black=text zone ~20%, white=scene ~80%).
            // Sent as a reference slot so the model sees the shape directly.
            const { getTextAreaMask } = require('./server/lib/textMasks');
            const textAreaMask = layoutTextInImage ? getTextAreaMask(textPos, langLevel) : null;

            // Calm-zone instruction for the empty-scene generator. Story text is
            // WHITE and overlaid at textPos, so the zone must render as a saturated,
            // high-contrast surface. Sonnet picks the corner + surface; the code
            // owns wording + spread-rule enforcement.
            const emptyAreaPct = langLevel === '1st-grade' ? '10%' : langLevel === 'advanced' ? '40%' : '30%';
            const emptyTextAreaInstr = (layoutTextInImage && textPos)
              ? buildTextZoneInstruction(textPos, textZoneDesc, emptyAreaPct, { isEmptyScene: true })
              : '';

            const eraGuard = buildEraGuard(sceneMetadata?.era || null);

            const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
              STYLE_DESCRIPTION: artStyleDesc,
              EMPTY_SCENE_DESCRIPTION: emptySceneDesc,
              CHARACTER_SPACE: characterSpace,
              TEXT_AREA_INSTRUCTION: emptyTextAreaInstr,
              ERA_GUARD: eraGuard,
            });

            try {
              // Build a FILTERED VB grid for empty-scene generation: vehicles + non-landmark
              // locations only. Characters, animals, and artifacts are excluded — they should
              // appear in the populated page, not in the background, and including them caused
              // doubling (e.g. an artifact rendered both in the empty scene and in the
              // character's hand on the page).
              const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, pageData.pageNumber, pageData.landmarkPhotos || []);
              // Persist the filtered grid as a data URL so the dev UI can show what
              // was actually attached to the empty-scene call (main-scene VB grid is
              // different; before this, the UI was displaying the wrong one).
              const emptySceneVbGridDataUrl = emptySceneVbGrid
                ? `data:image/jpeg;base64,${Buffer.from(emptySceneVbGrid).toString('base64')}`
                : null;

              const result = await generateImageOnly(emptyPrompt, [], {
                aspectRatio: layoutAspect,
                imageModelOverride: pageData.pageImageModel,
                imageBackendOverride: pageData.pageImageBackend,
                landmarkPhotos: pageData.landmarkPhotos,
                visualBibleGrid: emptySceneVbGrid,
                textAreaMask,
                pageNumber: pageData.pageNumber,
                skipCache: true
              });
              // Track empty scene token usage
              if (result?.usage) {
                const isRunware = result.modelId?.startsWith('runware:');
                const isGrok = result.modelId?.startsWith('grok-imagine');
                const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
                addUsage(provider, result.usage, 'page_images', result.modelId);
              }

              // Validate the empty scene before using it as a background.
              // Phase 1: pixel analysis (white boxes, too dark, text area calmness) — <50ms, free
              // Phase 2: Gemini Flash-lite vision (people, landmark, artifacts) — ~2s, cheap
              // Skipped entirely when layout has no text-in-image: the calm-zone QC
              // checks don't apply, and we save the vision call cost on those pages.
              if (result?.imageData && layoutTextInImage) {
                const { validateEmptyScene } = require('./server/lib/images');
                const textPos = enforceSpreadTextPosition(sceneMetadata?.textPosition || null, pageData.pageNumber);
                // Pass the outline's declared character positions so the vision check
                // can verify each has usable flat ground in the rendered empty scene.
                const placements = (sceneMetadata?.fullData?.characters || [])
                  .filter(c => c?.name && c?.position)
                  .map(c => ({ name: c.name, position: c.position, depth: c.depth }));
                // Derive story era for the anachronism check. Any character marked
                // as costumed with a specific costume type is a strong period signal
                // (e.g. "mittelalterlich" → medieval, "1920s" → early 20th century).
                // Fallback to storyTheme/Topic/Type. If nothing indicates an era,
                // leave null — the vision check will then skip the anachronism gate
                // rather than false-flag a legitimate present-day scene.
                let storyEra = null;
                const costumedTypes = Object.values(streamingClothingRequirements || {})
                  .map(r => r?.costumed?.used && r?.costumed?.costume)
                  .filter(Boolean);
                if (costumedTypes.length > 0) {
                  const themeBits = [inputData.storyTheme, inputData.storyTopic, inputData.storyType].filter(Boolean).join(' / ');
                  storyEra = themeBits ? `${costumedTypes[0]} (${themeBits})` : costumedTypes[0];
                }
                const qc = await validateEmptyScene(result.imageData, textPos, `P${pageData.pageNumber}`, {
                  sceneDescription: emptySceneDesc,
                  characterPlacements: placements.length > 0 ? placements : null,
                  mainScenePrompt: pageData.scene?.sceneDescription || null,
                  storyEra,
                });
                if (!qc.pass) {
                  // Retry with a modified prompt that incorporates Gemini's feedback.
                  // Don't just drop the text area instruction — soften it and add the fix hint.
                  const fixHint = qc.visionFeedback
                    ? `\n\nIMPORTANT: The previous attempt had this problem: ${qc.visionFeedback}. Fix this in the new version.`
                    : '';
                  // Soften the text area instruction using the shared builder. White
                  // text will be overlaid, so the zone must be a saturated, high-
                  // contrast surface — never a flat black rectangle or blank patch.
                  const softerTextInstr = textPos
                    ? buildTextZoneInstruction(textPos, textZoneDesc, emptyAreaPct, { isEmptyScene: true })
                    : '';
                  log.info(`🔄 [EMPTY SCENE] P${pageData.pageNumber} failed QC (${qc.issues.join(', ')}), retrying with feedback...`);
                  const retryPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
                    STYLE_DESCRIPTION: artStyleDesc,
                    EMPTY_SCENE_DESCRIPTION: emptySceneDesc + fixHint,
                    CHARACTER_SPACE: characterSpace,
                    TEXT_AREA_INSTRUCTION: softerTextInstr,
                    ERA_GUARD: eraGuard,
                  });
                  const retryResult = await generateImageOnly(retryPrompt, [], {
                    aspectRatio: layoutAspect,
                    imageModelOverride: pageData.pageImageModel,
                    imageBackendOverride: pageData.pageImageBackend,
                    visualBibleGrid: emptySceneVbGrid,
                    landmarkPhotos: pageData.landmarkPhotos,
                    textAreaMask,
                    pageContext: `empty-P${pageData.pageNumber}-retry`,
                  });
                  if (retryResult?.imageData) {
                    // Validate retry (pixel only — skip vision to avoid double API cost)
                    const retryQc = await validateEmptyScene(retryResult.imageData, textPos, `P${pageData.pageNumber}-retry`, { skipVision: true });
                    if (retryQc.pass) {
                      log.info(`✅ [EMPTY SCENE] P${pageData.pageNumber} retry passed QC`);
                      // Return both versions so they can be compared in dev mode
                      return { pageNumber: pageData.pageNumber, imageData: retryResult.imageData, prompt: retryPrompt, v1ImageData: result.imageData, v1Issues: qc.issues, visionFeedback: qc.visionFeedback, retryPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
                    }
                    log.warn(`⚠️ [EMPTY SCENE] P${pageData.pageNumber} retry also failed pixel QC — picking best of v1/v2`);
                    // Pick whichever version has fewer issues
                    const bestImage = retryQc.issues.length < qc.issues.length ? retryResult.imageData : result.imageData;
                    return { pageNumber: pageData.pageNumber, imageData: bestImage, prompt: retryPrompt, v1ImageData: result.imageData, v1Issues: qc.issues, visionFeedback: qc.visionFeedback, retryPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
                  }
                }
              }

              return { pageNumber: pageData.pageNumber, imageData: result?.imageData || null, prompt: emptyPrompt, textAreaMask, emptySceneVbGrid: emptySceneVbGridDataUrl };
            } catch (err) {
              log.warn(`⚠️ [EMPTY SCENE] Page ${pageData.pageNumber} failed: ${err.message}`);
              return null;
            }
          }))
        );

        for (const bg of emptyScenes) {
          if (bg?.imageData) {
            sceneBackgrounds[bg.pageNumber] = {
              imageData: bg.imageData,
              prompt: bg.prompt,
              textAreaMask: bg.textAreaMask || null,
              emptySceneVbGrid: bg.emptySceneVbGrid || null,
              // Store QC data for dev mode comparison (v1 failed, v2 retry)
              ...(bg.v1ImageData ? {
                v1ImageData: bg.v1ImageData,
                v1Issues: bg.v1Issues,
                visionFeedback: bg.visionFeedback || null,
                retryPrompt: bg.retryPrompt || null,
              } : {}),
            };
          }
        }
        const bgElapsed = ((Date.now() - bgStartTime) / 1000).toFixed(1);
        log.info(`🎨 [UNIFIED] Phase 5a-pre: ${Object.keys(sceneBackgrounds).length}/${pageDataArray.length} empty scenes in ${bgElapsed}s`);
      }

      // Phase 5a continued: Generate ALL images (no evaluation)
      log.info(`📸 [UNIFIED] Phase 5a: Generating all ${expandedScenes.length} images...`);
      const genStartTime = Date.now();
      const genLimit = pLimit(50);

      const rawImages = await Promise.all(
        pageDataArray.map(pageData => genLimit(async () => {
          await checkCancellation();
          // 11-30 = images generating (1 checkpoint per page, up to 20 pages)
          const progressPercent = 11 + Math.min(19, Math.floor((pageData.index / expandedScenes.length) * 19));
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progressPercent, `Generating illustration ${pageData.pageNumber}/${expandedScenes.length}...`, jobId]
          );

          // Trial mode: reuse pre-generated streaming image if available
          if (inputData.trialMode && streamingTrialPageImagePromises.has(pageData.pageNumber)) {
            const streamResult = await streamingTrialPageImagePromises.get(pageData.pageNumber);
            if (streamResult && streamResult.imageData) {
              log.info(`♻️ [TRIAL-STREAM] Page ${pageData.pageNumber}: reusing pre-generated streaming image`);
              return {
                pageNumber: pageData.pageNumber,
                imageData: streamResult.imageData,
                modelId: streamResult.modelId,
                thinkingText: null,
                usage: streamResult.usage,
                prompt: streamResult.prompt,
                characterPhotos: streamResult.characterPhotos,
                landmarkPhotos: pageData.landmarkPhotos,
                visualBibleGrid: pageData.visualBibleGrid,
                grokRefImages: streamResult.grokRefImages,
                emptySceneImage: null,
                emptyScenePrompt: null,
                sceneDescription: pageData.scene.sceneDescription,
                text: pageData.scene.text,
                sceneCharacters: pageData.sceneCharacters,
                sceneMetadata: pageData.sceneMetadata,
                perCharClothing: pageData.perCharClothing,
                scene: pageData.scene
              };
            }
          }

          try {
            // Apply reference-mode flag — strips refs/grid per the chosen mode.
            // singlePassScene already prevented the empty-scene plate from being
            // generated above, so sceneBackground is naturally null in that mode.
            const refApplied = require('./server/lib/storyHelpers').applyReferenceMode({
              mode: runReferenceMode,
              characterPhotos: pageData.characterPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              landmarkPhotos: pageData.landmarkPhotos,
              sceneBackground: sceneBackgrounds[pageData.pageNumber]?.imageData || null,
              sceneMetadata: pageData.sceneMetadata,
            });
            const genResult = await generateImageOnly(
              pageData.prompt,
              refApplied.characterPhotos,
              {
                aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
                imageModelOverride: pageData.pageImageModel,
                imageBackendOverride: pageData.pageImageBackend,
                landmarkPhotos: refApplied.landmarkPhotos,
                visualBibleGrid: refApplied.visualBibleGrid,
                pageNumber: pageData.pageNumber,
                sceneBackground: refApplied.sceneBackground,
                // Text-zone mask only attached when text is overlaid on image
                // (textInImage=true). For square+below layout this is null —
                // the model is free to fill the whole frame.
                textAreaMask: (inputData?.layout?.textInImage !== false)
                  ? (sceneBackgrounds[pageData.pageNumber]?.textAreaMask || null)
                  : null
              }
            );

            // Track usage
            if (genResult.usage) {
              const isRunware = genResult.modelId && genResult.modelId.startsWith('runware:');
              const isGrok = genResult.modelId && genResult.modelId.startsWith('grok-imagine');
              const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
              addUsage(provider, genResult.usage, 'page_images', genResult.modelId);
            }

            // Scale-repair pass — UNCONDITIONAL on any page where the
            // outline declared one or more characters with depth=background
            // alongside foreground/midground characters. Grok consistently
            // fails to render the tiny-figure-in-distance composition; the
            // eval flags it but the regular repair workflow can't shrink
            // figures, only fix identity. This pass runs Grok edit on the
            // just-rendered image with a focused "shrink the bg figure"
            // prompt + the bg character's avatar attached.
            // No threshold, no eval — outline intent is the trigger.
            let scaleRepairResult = null;
            if (genResult.imageData && pageData.sceneMetadata) {
              try {
                const { needsScaleRepair, runScaleRepair } = require('./server/lib/scaleRepair');
                if (needsScaleRepair(pageData.sceneMetadata)) {
                  // Resolve avatar refs only for the background characters.
                  const helpers = require('./server/lib/storyHelpers');
                  const { applyStyledAvatars } = require('./server/lib/styledAvatars');
                  const allChars = pageData.sceneMetadata.fullData?.characters || [];
                  const bgNames = new Set(allChars
                    .filter(c => (c.depth || '').toLowerCase() === 'background')
                    .map(c => (c.name || '').toLowerCase()));
                  const bgCharObjs = (inputData.characters || []).filter(c =>
                    bgNames.has((c.name || '').toLowerCase()));
                  // Background character avatars INTENTIONALLY NOT ATTACHED.
                  // A face avatar tells Grok "render this person identifiably"
                  // and the model upsizes the figure to fit a recognisable
                  // face — directly contradicting "tiny in the background".
                  // Description-only is enough; the foreground composition
                  // is preserved from the source image so no foreground
                  // avatar is needed either.
                  // Physical descriptions — Grok has no idea who "Gessler" is
                  // by name. Build a hair/face/clothing line for each bg char
                  // so the prompt can describe them.
                  // Per-page clothing override: the unified outline may have
                  // declared `costumed:medieval` (or winter/summer) for this
                  // page. Without an override the helper falls back to the
                  // standard avatar slot — modern clothes leak into a
                  // medieval scene.
                  const clothingByName = new Map(allChars.map(c => [
                    (c.name || '').toLowerCase(),
                    c.clothing || null,
                  ]));
                  const clothingReqs = pageData.sceneMetadata?.fullData?.clothingRequirements
                    || pageData.sceneMetadata?.clothingRequirements
                    || null;
                  const bgDescriptions = bgCharObjs.map(c => {
                    const label = clothingByName.get((c.name || '').toLowerCase()) || null;
                    const override = helpers.resolveClothingForPage(c, label, clothingReqs);
                    return {
                      name: c.name,
                      description: helpers.buildCharacterPhysicalDescription(c, override) || '',
                    };
                  }).filter(x => x.description);
                  scaleRepairResult = await runScaleRepair(genResult.imageData, pageData.sceneMetadata, {
                    pageNumber: pageData.pageNumber,
                    sceneBackground: sceneBackgrounds[pageData.pageNumber]?.imageData || null,
                    backgroundCharacterRefs: [],  // intentionally empty — see comment above
                    backgroundCharacterDescriptions: bgDescriptions,
                    artStyleDescription: helpers.resolveArtStyle(inputData.artStyle, 'grok') || null,
                    aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
                    usageTracker: addUsage,
                  });
                }
              } catch (e) {
                log.warn(`⚠️ [SCALE-REPAIR] Page ${pageData.pageNumber} failed: ${e.message}`);
              }
            }

            // Promote the scale-repaired image to the active version when it succeeded.
            // The pre-repair image is preserved as a separate version on the scene.
            const activeImageData = scaleRepairResult?.imageData || genResult.imageData;
            const activeModelId = scaleRepairResult?.modelId || genResult.modelId;

            // Save checkpoint for progressive display
            if (activeImageData) {
              await saveCheckpoint(jobId, 'partial_page', {
                pageNumber: pageData.pageNumber,
                text: pageData.scene.text,
                sceneDescription: pageData.scene.sceneDescription,
                imageData: activeImageData,
                modelId: activeModelId
              }, pageData.pageNumber);
            }

            // Detect calm region for text overlay (~30ms, non-blocking)
            let calmRegion = null;
            if (activeImageData) {
              try {
                const { detectCalmRegion } = require('./server/lib/calmRegion');
                const textPos = enforceSpreadTextPosition(pageData.sceneMetadata?.textPosition || null, pageData.pageNumber);
                if (textPos) {
                  const imgBuf = Buffer.from(activeImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
                  calmRegion = await detectCalmRegion(imgBuf, textPos).catch(() => null);
                }
              } catch (e) { /* calm region detection is optional */ }
            }

            // Attach empty scene data for frontend display
            const emptySceneData = sceneBackgrounds[pageData.pageNumber] || null;

            return {
              pageNumber: pageData.pageNumber,
              imageData: activeImageData,
              modelId: activeModelId,
              // When scale-repair ran, the original image is preserved as a
              // pre-repair version so the version picker shows both.
              preScaleRepairImage: scaleRepairResult ? genResult.imageData : null,
              preScaleRepairModelId: scaleRepairResult ? genResult.modelId : null,
              scaleRepairPrompt: scaleRepairResult ? scaleRepairResult.prompt : null,
              scaleRepairGrokRefImages: scaleRepairResult ? scaleRepairResult.grokRefImages : null,
              thinkingText: genResult.thinkingText || null,
              usage: genResult.usage,
              prompt: pageData.prompt,
              characterPhotos: pageData.characterPhotos,
              landmarkPhotos: pageData.landmarkPhotos,
              visualBibleGrid: pageData.visualBibleGrid,
              grokRefImages: genResult.grokRefImages || null,
              emptySceneImage: emptySceneData?.imageData || null,
              emptyScenePrompt: emptySceneData?.prompt || null,
              textAreaMask: emptySceneData?.textAreaMask || null,
              emptySceneVbGrid: emptySceneData?.emptySceneVbGrid || null,
              emptySceneQc: emptySceneData?.v1Issues ? {
                v1ImageData: emptySceneData.v1ImageData,
                v1Issues: emptySceneData.v1Issues,
                visionFeedback: emptySceneData.visionFeedback || null,
                retryPrompt: emptySceneData.retryPrompt || null,
              } : null,
              sceneDescription: pageData.scene.sceneDescription,
              text: pageData.scene.text,
              sceneCharacters: pageData.sceneCharacters,
              sceneMetadata: pageData.sceneMetadata,
              perCharClothing: pageData.perCharClothing,
              scene: pageData.scene,
              calmRegion,
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

      // Await covers before repair pipeline so covers go through the same quality checks
      const COVER_PAGE_MAP = { frontCover: -1, initialPage: -2, backCover: -3 };
      if (coverAwaitPromise) {
        if (!timing.coversEnd) {
          log.debug(`⏳ [UNIFIED] Waiting for covers before repair pipeline...`);
        }
        try {
          await Promise.race([
            coverAwaitPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Cover generation timed out')), 180000))
          ]);
        } catch (coverErr) {
          log.error(`❌ [UNIFIED] Cover await failed: ${coverErr.message}`);
        }
        // Add covers to rawImages with negative page numbers
        for (const [coverKey, coverData] of Object.entries(coverImages)) {
          if (coverData?.imageData && COVER_PAGE_MAP[coverKey] != null) {
            // Include text requirements so cover evaluator knows what text to check
            let coverEvalPrompt = coverData.description || coverData.prompt || '';
            if (coverKey === 'frontCover') {
              const title = inputData.title || inputData.storyTitle || '';
              if (title) coverEvalPrompt += `\n\nTEXT REQUIREMENT - CRITICAL: The image MUST include this exact title text: "${title}"`;
            } else if (coverKey === 'initialPage') {
              const dedication = inputData.dedication || '';
              if (dedication) coverEvalPrompt += `\n\nTEXT REQUIREMENT - CRITICAL: The image MUST include this exact dedication text: "${dedication}"`;
            } else if (coverKey === 'backCover') {
              coverEvalPrompt += '\n\nTEXT REQUIREMENT - CRITICAL: The image MUST include this exact text: "magicalstory.ch" in the bottom left corner.';
            }
            // Resolve full character objects for the figures appearing on this
            // cover so downstream eval/enrich/char-repair can identify them by
            // name. Without this, covers reach BBOX-ENRICH with 0 expected
            // characters and every figure comes back UNKNOWN — char repair
            // then filters them all out and `protectedFaces` ends up empty,
            // so only the target face gets blurred.
            const coverCharacterNames = (coverData.referencePhotos || [])
              .map(p => p.name)
              .filter(Boolean);
            const coverSceneCharacters = (inputData.characters || [])
              .filter(c => coverCharacterNames.includes(c.name));
            rawImages.push({
              pageNumber: COVER_PAGE_MAP[coverKey],
              text: '',
              sceneDescription: coverEvalPrompt,
              imageData: coverData.imageData,
              prompt: coverData.prompt,
              characterPhotos: coverData.referencePhotos || [],
              sceneCharacters: coverSceneCharacters,
              scene: { outlineExtract: coverData.description },
              evaluationType: 'cover', // Use cover evaluation (includes text checks)
            });
            log.info(`📸 [UNIFIED] Added ${coverKey} (page ${COVER_PAGE_MAP[coverKey]}) to repair pipeline`);
          }
        }
        coverAwaitPromise = null; // Mark as consumed
      }

      // Phases 5b-5g: Unified repair pipeline
      // Evaluate + entity consistency (parallel) → regen low-scoring (max 2) → pick best → character fix
      const skipQualityEval = inputData.skipQualityEval === true;

      // ── Text-space gate + repair: count calm pixels INSIDE the polygon the
      // renderer will draw text into. If calmFound < calmNeeded for the page's
      // word count and font size, re-roll the image with a mask hint up to
      // REPAIR.maxRetries. All candidates are persisted as separate
      // imageVersions so the user can pick a different one in dev mode. One
      // helper, one rule, one source of truth.
      const { ensureCalmZone } = require('./server/lib/textSpaceRepair');
      const textRegionResults = {}; // pageNumber → { winnerImage, position, report }
      // Skip the entire phase for layouts where text isn't overlaid on the
      // image (advanced/square+below renders text in a separate strip), OR
      // when the global enableTextOverlay flag is false.
      const skipTextRegionPhase = MODEL_DEFAULTS.enableTextOverlay === false
        || inputData?.layout?.textInImage === false;
      try {
        if (skipTextRegionPhase) {
          log.info(`📝 [TEXT-REGION] Skipped (layout.textInImage=false — text rendered below image)`);
        }
        const scenePages = !skipTextRegionPhase ? rawImages.filter(img => img.pageNumber > 0 && img.imageData) : [];
        await Promise.all(scenePages.map(async (img) => {
          const preferred = enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber);

          // Caller-supplied retry image generator. Wraps generateImageOnly so
          // ensureCalmZone doesn't import images.js (would be circular).
          const generateImage = (repairPrompt, opts) => generateImageOnly(repairPrompt, img.characterPhotos || [], {
            imageModelOverride: img.sceneMetadata?.pageImageModel || null,
            imageBackendOverride: img.sceneMetadata?.pageImageBackend || null,
            landmarkPhotos: img.landmarkPhotos || [],
            visualBibleGrid: img.visualBibleGrid || null,
            previousImage: opts.previousImage,
            textAreaMask: opts.textAreaMask,
            pageNumber: img.pageNumber,
            skipCache: true,
            aspectRatio: inputData?.layout?.imageAspect || MODEL_DEFAULTS.pageAspect,
          });

          const onUsage = (result) => {
            if (!result.usage) return;
            const isRunware = result.modelId?.startsWith('runware:');
            const isGrok = result.modelId?.startsWith('grok-imagine');
            const provider = isRunware ? 'runware' : isGrok ? 'grok' : 'gemini_image';
            addUsage(provider, result.usage, 'page_images', result.modelId);
          };

          const result = await ensureCalmZone({
            imageData: img.imageData,
            text: img.text,
            textPosition: preferred,
            pageNumber: img.pageNumber,
            languageLevel: inputData?.languageLevel || 'standard',
            textAreaMask: img.textAreaMask,
            sceneDescription: img.sceneDescription || '',
            generateImage,
            onUsage,
            label: 'TEXT-SPACE',
          });

          img.imageData = result.winnerImageData;
          // Persist all candidates so the dev viewer can show each attempt.
          // Candidate 0 inherits the original's Grok refs; repair candidates
          // carry their own captured by ensureCalmZone.
          img.textSpaceCandidates = result.candidates.length > 1
            ? result.candidates.map((c, i) => ({
                imageData: c.imageData,
                position: c.position,
                rect: c.rect,
                calmFoundPx: c.calmFoundPx,
                areaPx: c.areaPx,
                source: c.source,
                prompt: c.prompt,
                modelId: c.modelId || img.modelId || null,
                grokRefImages: i === 0 ? (img.grokRefImages || null) : c.grokRefImages,
                isWinner: i === result.winnerIndex,
              }))
            : null;
          img.textCoverageReport = result.report;
          textRegionResults[img.pageNumber] = {
            position: result.winnerCandidate.position,
            rect: result.winnerCandidate.rect,
            report: result.report,
          };
        }));
        const passed = Object.entries(textRegionResults).filter(([, r]) => r.report.passed).length;
        const repaired = Object.entries(textRegionResults).filter(([, r]) => r.report.retriesUsed > 0).length;
        log.info(`📝 [TEXT-REGION] Processed ${scenePages.length} pages, ${passed} passed, ${repaired} repaired for text space`);
      } catch (trErr) {
        log.warn(`⚠️ [TEXT-REGION] Detection failed: ${trErr.message} — using original images`);
      }

      if (skipQualityEval) {
        // Trial/lightweight mode: skip evaluation and repair entirely
        log.info(`⏭️ [UNIFIED] Skipping quality evaluation and repair pipeline (skipQualityEval=true)`);
        allImages = rawImages.map(img => ({
          pageNumber: img.pageNumber,
          text: img.text,
          description: img.sceneDescription,
          sceneDescription: img.sceneDescription,  // alias for backward compat
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          thinkingText: img.thinkingText || null,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid || null,
          grokRefImages: img.grokRefImages || null,
          emptySceneImage: img.emptySceneImage || null,
          emptyScenePrompt: img.emptyScenePrompt || null,
          emptySceneQc: img.emptySceneQc || (sceneBackgrounds[img.pageNumber]?.v1Issues ? {
            v1ImageData: sceneBackgrounds[img.pageNumber]?.v1ImageData || null,
            v1Issues: sceneBackgrounds[img.pageNumber]?.v1Issues || null,
            visionFeedback: sceneBackgrounds[img.pageNumber]?.visionFeedback || null,
            retryPrompt: sceneBackgrounds[img.pageNumber]?.retryPrompt || null,
          } : null),
          emptySceneVbGrid: img.emptySceneVbGrid || sceneBackgrounds[img.pageNumber]?.emptySceneVbGrid || null,
          // Mask sent to Grok during empty-scene generation (Pass 1). Persisted so the
          // dev-mode references panel can show the thumbnail of what was actually sent.
          textAreaMask: img.textAreaMask || sceneBackgrounds[img.pageNumber]?.textAreaMask || null,
          sceneCharacters: img.sceneCharacters,
          sceneCharacterClothing: img.perCharClothing,
          // textPosition is only meaningful for layouts that overlay text on
          // the image (1st-grade). For standard/advanced layouts the text is
          // rendered beside the image, so persisting a textPosition here would
          // leak calm-zone language into downstream prompts (inpaint, char
          // repair). Gate on the same flag the text-region phase uses so the
          // two stay in lock-step.
          textPosition: skipTextRegionPhase
            ? null
            : (textRegionResults[img.pageNumber]?.position || enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber)),
          textRect: textRegionResults[img.pageNumber]?.rect || null,
          textCoverageReport: textRegionResults[img.pageNumber]?.report || null,
          calmRegion: img.calmRegion || null,
          outlineCharacters: img.scene?.outlineCharacters || null,
          imageVersions: [],
        }));
      } else {
        log.info(`🔧 [UNIFIED] Running unified repair pipeline...`);

        // Phase 5b-pre: Shared bbox detection — runs ONCE per image before quality eval
        // and entity consistency. Both consume the same result, avoiding redundant API calls.
        const { detectAllBoundingBoxes } = require('./server/lib/images');
        const bboxLimit = pLimit(3); // throttle to 3 parallel Gemini calls to avoid 503s
        const bboxStartTime = Date.now();
        log.info(`🔍 [UNIFIED] Phase 5b-pre: Shared bbox detection for ${rawImages.length} images...`);
        await Promise.all(rawImages.filter(img => img.imageData).map(img => bboxLimit(async () => {
          try {
            const expectedCharacters = (img.sceneCharacters || []).map(c => ({
              name: c.name || c,
              description: typeof c === 'object' ? (c.description || '') : '',
            }));
            const sceneMetadata = img.sceneMetadata || {};
            const expectedObjects = Array.isArray(sceneMetadata.objects)
              ? sceneMetadata.objects.filter(o => typeof o === 'string')
              : [];
            img.sharedBboxDetection = await detectAllBoundingBoxes(img.imageData, {
              expectedCharacters,
              expectedObjects,
              sceneContext: img.sceneDescription || null,
              pageContext: `PAGE ${img.pageNumber}`,
            });
            const figCount = img.sharedBboxDetection?.figures?.length || 0;
            const idCount = img.sharedBboxDetection?.figures?.filter(f => f.name && f.name !== 'UNKNOWN').length || 0;
            log.debug(`🔍 [BBOX-SHARED] P${img.pageNumber}: ${figCount} figures, ${idCount} identified`);
          } catch (err) {
            log.warn(`⚠️ [BBOX-SHARED] P${img.pageNumber}: Detection failed: ${err.message} — fallback will run`);
            img.sharedBboxDetection = null;
          }
        })));
        const bboxElapsed = ((Date.now() - bboxStartTime) / 1000).toFixed(1);
        const sharedCount = rawImages.filter(img => img.sharedBboxDetection).length;
        log.info(`🔍 [UNIFIED] Phase 5b-pre: ${sharedCount}/${rawImages.length} shared bbox detections in ${bboxElapsed}s`);

        // Build storyData for iterate (needs scene descriptions, characters, visual bible)
        const pipelineStoryData = {
          characters: inputData.characters,
          sceneDescriptions: expandedScenes,
          story: fullStoryText,
          storyText: fullStoryText,
          visualBible,
          artStyle: inputData.artStyle,
          language: inputData.language,
          clothingRequirements: clothingRequirements,
          pageClothing: pageClothingData,
          // Preserve per-scene layout fields (imageAspect, textInImage) so any
          // iterate/redo inside the repair pipeline regenerates at the right
          // aspect. Stripping these would silently revert advanced-layout pages
          // back to 3:4 on auto-repair.
          sceneImages: rawImages.map(r => ({
            pageNumber: r.pageNumber,
            imageData: r.imageData,
            description: r.sceneDescription,
            imageAspect: inputData?.layout?.imageAspect,
            textInImage: inputData?.layout?.textInImage,
            // The page's locked text-overlay position. Used by iteratePageCore
            // (re-injected as COPY SPACE) and by character-repair (so Grok
            // doesn't drop the figure into the text zone during inpaint).
            // Only set for overlay layouts — see persistence note above.
            textPosition: skipTextRegionPhase
              ? null
              : (textRegionResults[r.pageNumber]?.position
                || enforceSpreadTextPosition(r.sceneMetadata?.textPosition || null, r.pageNumber)),
          })),
          coverImages,  // Needed by iterateCover when pipeline redoes low-scoring covers
          coverHints,   // Needed by iterateCover for per-character clothing on covers
          title,
          dedication: inputData.dedication || '',
        };

        const { results: pipelineResult, charFixDetails, styleConsistency } = await runUnifiedRepairPipeline(rawImages, {
          characters: inputData.characters,
          modelOverrides,
          usageTracker: (provider, usage, funcName, modelId) => {
            // Some legacy call sites in images.js call this as (null, usage, null, modelId).
            // Infer provider + function name from the model so the tokens aren't lost.
            if (provider == null && usage && modelId) {
              const m = String(modelId).toLowerCase();
              if (m.includes('claude') || m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
                provider = 'anthropic';
                if (!funcName) funcName = 'scene_expansion';
              } else if (m.includes('gemini')) {
                // Default Gemini calls without a function name to quality eval
                provider = 'gemini_quality';
                if (!funcName) funcName = 'consistency_check';
              }
            }
            return addUsage(provider, usage, funcName, modelId);
          },
          visualBible,
          artStyle: inputData.artStyle,
          jobId,
          dbPool,
          storyData: pipelineStoryData
        }, {
          maxRegenAttempts: enableFullRepair ? REPAIR_DEFAULTS.maxPasses : 0,  // 0 = evaluate only
          evalConcurrency: 500,
          qualityModelOverride: modelOverrides.qualityModel,
          useIteratePage: true  // Use iterate (re-expansion) for better redo quality
        });

        // Hoist pipeline data for use outside this block (finalChecksReport)
        pipelineEntityReport = pipelineResult[0]?.entityReport || null;
        pipelineCharFixDetails = charFixDetails;
        pipelineStyleConsistency = styleConsistency || null;

        // Map pipeline results to allImages format
        allImages = pipelineResult.map(img => ({
          pageNumber: img.pageNumber,
          text: img.text,
          description: img.sceneDescription,
          sceneDescription: img.sceneDescription,  // alias for backward compat
          outlineExtract: img.scene?.outlineExtract || img.scene?.sceneHint || '',
          imageData: img.imageData,
          generatedAt: new Date().toISOString(),
          prompt: img.prompt,
          sceneDescriptionPrompt: img.scene?.sceneDescriptionPrompt,
          sceneDescriptionModelId: img.scene?.sceneDescriptionModelId,
          qualityScore: img.qualityScore,
          qualityReasoning: img.qualityReasoning,
          thinkingText: img.thinkingText || null,
          wasRegenerated: img.wasRegenerated,
          wasCharacterFixed: img.wasCharacterFixed,
          bestSource: img.bestSource,
          referencePhotos: img.characterPhotos,
          landmarkPhotos: img.landmarkPhotos,
          visualBibleGrid: img.visualBibleGrid ? (typeof img.visualBibleGrid === 'string' ? img.visualBibleGrid : `data:image/jpeg;base64,${img.visualBibleGrid.toString('base64')}`) : null,
          grokRefImages: img.grokRefImages || null,
          emptySceneImage: img.emptySceneImage || null,
          emptyScenePrompt: img.emptyScenePrompt || null,
          emptySceneQc: img.emptySceneQc || (sceneBackgrounds[img.pageNumber]?.v1Issues ? {
            v1ImageData: sceneBackgrounds[img.pageNumber]?.v1ImageData || null,
            v1Issues: sceneBackgrounds[img.pageNumber]?.v1Issues || null,
            visionFeedback: sceneBackgrounds[img.pageNumber]?.visionFeedback || null,
            retryPrompt: sceneBackgrounds[img.pageNumber]?.retryPrompt || null,
          } : null),
          emptySceneVbGrid: img.emptySceneVbGrid || sceneBackgrounds[img.pageNumber]?.emptySceneVbGrid || null,
          // Mask sent to Grok during empty-scene generation (Pass 1). Persisted so the
          // dev-mode references panel can show the thumbnail of what was actually sent.
          textAreaMask: img.textAreaMask || sceneBackgrounds[img.pageNumber]?.textAreaMask || null,
          sceneCharacters: img.sceneCharacters,
          sceneCharacterClothing: img.perCharClothing,
          bboxDetection: img.bboxDetection,
          bboxOverlayImage: img.bboxOverlayImage,
          fixTargets: img.fixTargets || [],
          fixableIssues: img.fixableIssues || [],
          semanticResult: img.semanticResult || null,
          semanticScore: img.semanticScore ?? null,
          // Three-stage evaluation: Stage 1 = vision inventory text, Stage 2 =
          // Sonnet compliance JSON. Persisted so the dev-mode version picker
          // can show what Gemini actually saw vs what Sonnet judged.
          threeStageResult: img.threeStageResult || null,
          issuesSummary: img.issuesSummary || null,
          verdict: img.verdict || null,
          imageVersions: img.imageVersions || [],
          retryHistory: img.retryHistory || [],
          entityReport: img.entityReport || null,
          // textPosition is only meaningful for layouts that overlay text on
          // the image (1st-grade). For standard/advanced layouts the text is
          // rendered beside the image, so persisting a textPosition here would
          // leak calm-zone language into downstream prompts (inpaint, char
          // repair). Gate on the same flag the text-region phase uses so the
          // two stay in lock-step.
          textPosition: skipTextRegionPhase
            ? null
            : (textRegionResults[img.pageNumber]?.position || enforceSpreadTextPosition(img.sceneMetadata?.textPosition || null, img.pageNumber)),
          textRect: textRegionResults[img.pageNumber]?.rect || null,
          textCoverageReport: textRegionResults[img.pageNumber]?.report || null,
          calmRegion: img.calmRegion || null,
          outlineCharacters: img.scene?.outlineCharacters || null
        }));

        // Extract covers from pipeline results back into coverImages (updated with eval data)
        const COVER_TYPE_MAP = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
        allImages = allImages.filter(img => {
          if (img.pageNumber < 0) {
            const coverKey = COVER_TYPE_MAP[String(img.pageNumber)];
            if (coverKey && coverImages[coverKey]) {
              // Update cover with pipeline eval results
              coverImages[coverKey].qualityScore = img.qualityScore;
              coverImages[coverKey].qualityReasoning = img.qualityReasoning;
              coverImages[coverKey].fixTargets = img.fixTargets;
              coverImages[coverKey].fixableIssues = img.fixableIssues;
              coverImages[coverKey].semanticResult = img.semanticResult;
              coverImages[coverKey].semanticScore = img.semanticScore;
              coverImages[coverKey].issuesSummary = img.issuesSummary;
              coverImages[coverKey].verdict = img.verdict;
              coverImages[coverKey].bboxDetection = img.bboxDetection;
              coverImages[coverKey].bboxOverlayImage = img.bboxOverlayImage;
              // Copy imageVersions if pipeline produced new ones (regen, character fix, or first time)
              if (img.wasRegenerated || img.wasCharacterFixed || !coverImages[coverKey].imageVersions?.length ||
                  (img.imageVersions?.length > (coverImages[coverKey].imageVersions?.length || 0))) {
                coverImages[coverKey].imageVersions = img.imageVersions;
              }
              if (img.imageData) coverImages[coverKey].imageData = img.imageData;
              if (img.wasRegenerated) coverImages[coverKey].wasRegenerated = true;
              log.info(`📸 [UNIFIED] ${coverKey} pipeline result: score ${img.qualityScore}, ${img.wasRegenerated ? 'regenerated' : 'original'}`);
            }
            return false; // Remove from allImages (covers stored separately)
          }
          return true;
        });
      }

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
          [31, 'Finishing cover images...', jobId]  // 31 = covers finishing
        );
      }
      const COVER_TIMEOUT_MS = 180000; // 3 minutes
      try {
        await Promise.race([
          coverAwaitPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Cover generation timed out after 3 minutes')), COVER_TIMEOUT_MS))
        ]);

        // Run bbox detection on covers for entity consistency checks
        // Skip when quality evaluation is disabled (trial mode) — bbox data won't be used
        if (!inputData.skipQualityEval) {
          try {
            await detectBboxOnCovers(coverImages, inputData.characters);
          } catch (bboxErr) {
            log.warn(`⚠️ [UNIFIED] Cover bbox detection failed: ${bboxErr.message}`);
          }
        }
      } catch (coverErr) {
        log.error(`❌ [UNIFIED] Cover generation failed/timed out: ${coverErr.message}`);
        genLog.error('covers_failed', coverErr.message);
        // Continue without covers — story is still usable
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
    // Grok/Runware direct costs are already included in imageCost via calculateImageCost — use these for logging only
    const grokDirectCost = tokenUsage.grok?.direct_cost || 0;
    const runwareDirectCost = tokenUsage.runware?.direct_cost || 0;
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
    if (grokDirectCost > 0) {
      log.debug(`   Grok:           ${tokenUsage.grok.calls} images  $${grokDirectCost.toFixed(4)}`);
    }
    if (runwareDirectCost > 0) {
      log.debug(`   Runware:        ${tokenUsage.runware.calls} images  $${runwareDirectCost.toFixed(4)}`);
    }

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
    if (byFunc.scene_iterate?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_iterate), byFunc.scene_iterate.input_tokens, byFunc.scene_iterate.output_tokens, byFunc.scene_iterate.thinking_tokens);
      log.debug(`   Scene Iterate:${byFunc.scene_iterate.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_iterate.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_iterate.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_iterate)}]`);
    }
    if (byFunc.cover_expansion?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_expansion), byFunc.cover_expansion.input_tokens, byFunc.cover_expansion.output_tokens, byFunc.cover_expansion.thinking_tokens);
      log.debug(`   Cover Expand: ${byFunc.cover_expansion.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_expansion.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_expansion.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_expansion)}]`);
    }
    if (byFunc.phantom_patch?.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.phantom_patch), byFunc.phantom_patch.input_tokens, byFunc.phantom_patch.output_tokens, byFunc.phantom_patch.thinking_tokens);
      log.debug(`   Phantom Patch:${byFunc.phantom_patch.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.phantom_patch.output_tokens.toLocaleString().padStart(8)} out (${byFunc.phantom_patch.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.phantom_patch)}]`);
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
      // Grok/Runware bill per-image and report cost as direct_cost, not as tokens.
      // Use direct_cost when present; fall back to token-based for Gemini.
      const directCost = byFunc.inpaint.direct_cost || 0;
      const cost = directCost > 0
        ? { total: directCost }
        : calculateCost(getCostModel(byFunc.inpaint), byFunc.inpaint.input_tokens, byFunc.inpaint.output_tokens, byFunc.inpaint.thinking_tokens);
      log.debug(`   Inpaint:       ${byFunc.inpaint.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.inpaint.output_tokens.toLocaleString().padStart(8)} out (${byFunc.inpaint.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.inpaint)}]`);
    }

    const thinkingTotal = totalThinkingTokens > 0 ? ` + ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);

    // INTENTIONALLY no checkCancellation() here. By this point the pipeline
    // has fully completed — every image generated, every cost paid, the
    // ✅ [UNIFIED PIPELINE] Complete log line has fired. The remaining work
    // is just persistence (writing the finished story to the stories table).
    // Aborting here would discard the in-memory completed story without
    // ever saving it — which is what bricked job_1777312806388_aja96pys7
    // (cancel signal arrived 1ms after Pipeline Complete and the catch
    // block returned null without persisting). After Pipeline Complete the
    // user's intent to "stop work" no longer applies — work is done; saving
    // the result is what turns paid compute into a deliverable. Earlier
    // checkCancellation() calls (before each page generation, etc.) still
    // honour cancellation while there's expensive work left to skip.
    log.debug(`📝 [UNIFIED] Updating job status to 95% (finalizing)...`);
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [73, 'Finalizing story...', jobId]  // 73 = finalizing
    );

    // Extract entity report from unified pipeline results (same on every page)
    let finalChecksReport = pipelineEntityReport ? { entity: pipelineEntityReport } : null;

    // Build entityRepairs from character fix data for StoryDisplay before/after visualization
    if (finalChecksReport?.entity && pipelineCharFixDetails && Object.keys(pipelineCharFixDetails).length > 0) {
      finalChecksReport.entityRepairs = {};
      for (const [charName, charData] of Object.entries(pipelineCharFixDetails)) {
        finalChecksReport.entityRepairs[charName] = {
          timestamp: new Date().toISOString(),
          pages: charData.pages,
          cellsRepaired: Object.keys(charData.pages).length
        };
      }
    }

    // Style consistency audit (Step 8) — surface the verdict on the same
    // finalChecksReport that the StoryDisplay reads, so the dev panel can
    // show the cross-page style cluster + outliers without a separate fetch.
    if (pipelineStyleConsistency) {
      finalChecksReport = finalChecksReport || {};
      finalChecksReport.styleConsistency = pipelineStyleConsistency;
    }

    let originalStoryText = null;

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
    clearCurrentLogger();
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
      titleCandidates: titleCandidates || null, // Full list the model produced; null if legacy single-line TITLE
      storyType: inputData.storyType || '',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
      artStyle: inputData.artStyle || 'pixar',
      language: inputData.language || 'en',
      languageLevel: inputData.languageLevel || '1st-grade',
      // Persist layout on storyData so PDF / shared-viewer / re-iteration code
      // doesn't need to re-derive it from languageLevel. Computed upfront in
      // processStoryJob and carried through the pipeline via inputData.
      layout: inputData.layout || null,
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
      story: fullStoryText, // Canonical field name — frontend reads 'story'
      storyText: fullStoryText, // Keep for backwards compatibility with existing blobs
      originalStory: originalStoryText || fullStoryText, // Store original AI text for dev mode
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      coverHints: coverHints, // Cover scene hints with per-character clothing from outline
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
          enableFullRepair,
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

    // Attach reference sheet batch metadata so the dev panel can label cells.
    // The actual source grid images live in story_images (saved after upsert);
    // this is just the lightweight per-batch element list.
    if (referenceSheetBatchMeta) {
      storyData.referenceSheetBatches = referenceSheetBatchMeta;
    }

    // Debug: Log what's being saved for storyCategory/storyTheme in unified mode
    log.debug(`📝 [UNIFIED SAVE] storyCategory: "${storyData.storyCategory}", storyTopic: "${storyData.storyTopic}", storyTheme: "${storyData.storyTheme}"`);
    log.debug(`📝 [UNIFIED SAVE] mainCharacters: ${JSON.stringify(storyData.mainCharacters)}, characters count: ${storyData.characters?.length || 0}`);

    log.debug(`💾 [UNIFIED] Saving story to database... (generationLog has ${storyData.generationLog?.length || 0} entries)`);
    await upsertStory(storyId, userId, storyData);
    log.debug(`📚 [UNIFIED] Story ${storyId} saved to stories table`);

    // Persist reference sheet source grids for the dev panel. Each batch
    // becomes a story_images row with image_type='ref_sheet_source' and
    // page_number=batchIdx. Element names are encoded into the quality_score
    // column as a JSON string... actually no — we use a separate metadata
    // mechanism. For now we just save the image with the batch index.
    if (referenceSheetSourceGrids && referenceSheetSourceGrids.length > 0) {
      try {
        for (const grid of referenceSheetSourceGrids) {
          await saveStoryImage(storyId, 'ref_sheet_source', grid.batchIdx, grid.imageData, {
            generatedAt: new Date().toISOString(),
          });
        }
        log.info(`💾 [UNIFIED] Saved ${referenceSheetSourceGrids.length} reference sheet source grid(s) for dev inspection`);
      } catch (refSheetSaveErr) {
        log.warn(`⚠️ [UNIFIED] Failed to persist reference sheet source grids: ${refSheetSaveErr.message}`);
      }
    }

    // Initialize image_version_meta with active versions for all pages.
    // The pipeline's Step 7 (pick-best) already picked the winner and stamped it
    // onto scene.bestSource. We honor that decision directly by finding the
    // version whose `source` matches `bestSource`. This correctly handles cases
    // where a character-fix version made things worse than the pre-fix best.
    if (storyData.sceneImages?.length > 0) {
      for (const scene of storyData.sceneImages) {
        if (scene.imageVersions?.length > 0) {
          let activeIdx = -1;
          // Primary: match bestSource from Step 7 pick-best
          if (scene.bestSource) {
            activeIdx = scene.imageVersions.findIndex(v => v.source === scene.bestSource);
          }
          // Fallback: highest qualityScore
          if (activeIdx < 0) {
            let bestScore = -1;
            for (let i = 0; i < scene.imageVersions.length; i++) {
              const s = scene.imageVersions[i].qualityScore;
              if (s != null && s > bestScore) { bestScore = s; activeIdx = i; }
            }
          }
          if (activeIdx < 0) activeIdx = scene.imageVersions.length - 1;
          await setActiveVersion(storyId, scene.pageNumber, activeIdx);
        }
      }
      log.debug(`📚 [UNIFIED] Initialized image_version_meta for ${storyData.sceneImages.length} pages`);
    }

    // Initialize image_version_meta for covers too (covers always have one version — use last)
    if (storyData.coverImages) {
      for (const coverType of ['frontCover', 'initialPage', 'backCover']) {
        const cover = storyData.coverImages[coverType];
        if (cover?.imageVersions?.length > 0) {
          await setActiveVersion(storyId, coverType, cover.imageVersions.length - 1);
        }
      }
      log.debug(`📚 [UNIFIED] Initialized image_version_meta for covers`);
    }

    // Persist styled avatars to BOTH story data AND characters table
    if ((artStyle !== 'realistic' || hasCostumedClothing) && inputData.characters) {
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

    // Fetch shareToken so the client can show "View Story" button immediately
    let shareToken = null;
    try {
      const stResult = await dbPool.query('SELECT share_token FROM stories WHERE id = $1', [storyId]);
      shareToken = stResult.rows[0]?.share_token || null;
    } catch { /* non-critical */ }

    // Build final result
    const resultData = {
      storyId,
      shareToken,
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
    // Strip ALL base64 image data from result_data to keep it lightweight
    // Images are already saved in story_images table via upsertStory
    // The client only needs metadata from result_data to navigate to the story
    const stripImageData = (img) => {
      if (!img) return img;
      const { imageData, referencePhotos, visualBibleGrid, bboxOverlayImage, ...metadata } = img;
      // Keep referencePhotos metadata but strip actual photo data (rebuild from character avatars on demand)
      const strippedRefPhotos = referencePhotos?.map(p => ({
        name: p.name, photoType: p.photoType, clothingCategory: p.clothingCategory,
        clothingDescription: p.clothingDescription, hasPhoto: !!(p.photoUrl || p.photoData)
      }));
      // Keep landmarkPhotos WITH photoData (small, unique per page, needed for display)
      const stripped = { ...metadata, hasImage: !!imageData, hasVisualBibleGrid: !!visualBibleGrid, referencePhotos: strippedRefPhotos };
      // Strip imageData from imageVersions
      if (stripped.imageVersions) {
        stripped.imageVersions = stripped.imageVersions.map(v => {
          const { imageData: vData, ...vMeta } = v;
          return { ...vMeta, hasImage: !!vData };
        });
      }
      // Strip imageData from retryHistory
      if (stripped.retryHistory) {
        stripped.retryHistory = stripped.retryHistory.map(r => {
          const { imageData: rData, ...rMeta } = r;
          return { ...rMeta, hasImage: !!rData };
        });
      }
      return stripped;
    };
    // Strip photo data from visualBible locations
    const strippedVisualBible = resultData.visualBible ? {
      ...resultData.visualBible,
      locations: (resultData.visualBible.locations || []).map(loc => {
        const { referencePhotoData, ...locMeta } = loc;
        return { ...locMeta, hasPhoto: !!referencePhotoData };
      })
    } : resultData.visualBible;
    const resultDataForStorage = {
      ...resultData,
      visualBible: strippedVisualBible,
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
        'SELECT email, username, shipping_first_name, preferred_language, is_trial, claim_token FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];
        const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
        // Prefer story language over DB default (DB defaults to 'English' for trial users)
        const emailLanguage = inputData.language || user.preferred_language || 'English';

        const emailOptions = {};
        if (shareToken) emailOptions.shareToken = shareToken;

        // For trial users: generate PDF and claim URL to include in email
        if (user.is_trial) {
          try {
            // Generate a claim token if user doesn't have one
            let claimToken = user.claim_token;
            if (!claimToken) {
              claimToken = crypto.randomBytes(32).toString('hex');
              const claimExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
              await dbPool.query(
                'UPDATE users SET claim_token = $1, claim_token_expires = $2 WHERE id = $3',
                [claimToken, claimExpires, userId]
              );
            }
            emailOptions.claimUrl = `${process.env.FRONTEND_URL || 'https://magicalstory.ch'}/claim/${claimToken}`;

            // Generate a view PDF to attach to the email
            // Fetch the full story data with images (rehydrate from story_images table)
            const pdfStoryResult = await dbPool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
            if (pdfStoryResult.rows.length > 0) {
              let pdfStoryData = typeof pdfStoryResult.rows[0].data === 'string'
                ? JSON.parse(pdfStoryResult.rows[0].data)
                : pdfStoryResult.rows[0].data;
              pdfStoryData = await rehydrateStoryImages(storyId, pdfStoryData);

              const pdfBuffer = await generateViewPdf(pdfStoryData, 'square');
              const pdfSizeMB = pdfBuffer.length / 1024 / 1024;
              log.info(`[UNIFIED] Generated trial PDF for email (${pdfSizeMB.toFixed(2)} MB)`);
              if (pdfSizeMB > 35) {
                log.warn(`[UNIFIED] Trial PDF too large for email (${pdfSizeMB.toFixed(2)} MB > 35MB) - sending without attachment`);
              } else {
                emailOptions.pdfBuffer = pdfBuffer;
                emailOptions.pdfFilename = `${title || 'story'}.pdf`;
              }
            }
          } catch (pdfErr) {
            log.error('[UNIFIED] Failed to generate trial PDF for email (sending without attachment):', pdfErr.message);
            // Continue sending email without PDF - better to send without attachment than not at all
          }
        }

        await email.sendStoryCompleteEmail(user.email, firstName, title, storyId, emailLanguage, emailOptions);
      }
    } catch (emailErr) {
      log.error('❌ [UNIFIED] Failed to send story complete email:', emailErr);
    }

    return resultData;

  } catch (error) {
    // If the job was cancelled by the user, don't treat it as a pipeline error
    if (error.name === 'JobCancelledError') {
      log.info(`🛑 [UNIFIED] Pipeline aborted for cancelled job ${jobId}`);
      // Credits already refunded by the cancel endpoint — just stop
      return null;
    }

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
  // Run entire job inside a cache scope so styled avatars don't collide between concurrent jobs
  return runInCacheScope(jobId, () => _processStoryJobImpl(jobId));
}

async function _processStoryJobImpl(jobId) {
  log.info(`🎬 Starting processing for job ${jobId}`);

  // Cancellation check — query DB status before each major phase
  // Throws a special error that the outer catch can distinguish from real failures
  class JobCancelledError extends Error {
    constructor(jobId) { super(`Job ${jobId} was cancelled`); this.name = 'JobCancelledError'; }
  }
  async function checkCancellation() {
    const result = await dbPool.query('SELECT status FROM story_jobs WHERE id = $1', [jobId]);
    if (result.rows.length === 0 || result.rows[0].status === 'failed') {
      log.info(`🛑 [PIPELINE] Job ${jobId} cancelled — aborting pipeline`);
      throw new JobCancelledError(jobId);
    }
  }

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
    // Runware/Grok use direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    grok: { direct_cost: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: 'gemini_image', models: new Set() },
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
      // Handle Runware/Grok (direct cost) vs token-based providers
      if (provider === 'runware' || provider === 'grok') {
        tokenUsage[provider].direct_cost += usage.direct_cost || usage.cost || 0;
        tokenUsage[provider].calls += 1;
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

    // Stamp the layout from languageLevel onto inputData so image generation,
    // scene expansion, and PDF rendering all read from the same source of
    // truth. Advanced stories → square image + text-below strip; standard
    // and 1st-grade → A4 image + overlay. Without this, buildImagePrompt
    // falls through to its default (textInImage=true) regardless of level.
    try {
      const { resolveLayout } = require('./server/lib/layout');
      inputData.layout = resolveLayout(inputData.languageLevel);
      log.info(`📐 [PROCESS] Layout for level=${inputData.languageLevel}: mode=${inputData.layout.mode}, aspect=${inputData.layout.imageAspect}, textInImage=${inputData.layout.textInImage}`);
    } catch (e) {
      log.warn(`📐 [PROCESS] resolveLayout failed: ${e.message} — layout not stamped`);
    }

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

    // For swiss-stories, ALWAYS use the story's city for landmarks (not user's home city)
    // Swiss stories (including Sagen) are city-bound — landmarks must match the story location
    if (inputData.storyCategory === 'swiss-stories' && inputData.storyTopic) {
      let storyCity = null;

      // City-based stories: derive city from topic ID (e.g., "basel-3" → "Basel")
      if (!inputData.storyTopic.startsWith('sage-')) {
        const { getSwissCityById } = require('./server/lib/swissStories');
        const cityId = inputData.storyTopic.replace(/-\d+$/, '');
        const cityMeta = getSwissCityById(cityId);
        if (cityMeta) storyCity = cityMeta.name.en;
      } else {
        // Sagen: look up city from swiss-sagen.json
        try {
          const sagen = require('./server/data/swiss-sagen.json');
          const sage = sagen.find(s => s.id === inputData.storyTopic);
          if (sage?.city) storyCity = sage.city;
        } catch (e) { /* ignore */ }
      }

      if (storyCity) {
        if (inputData.userLocation?.city && inputData.userLocation.city.toLowerCase() !== storyCity.toLowerCase()) {
          log.info(`[SWISS] Overriding userLocation from ${inputData.userLocation.city} to ${storyCity} (story is set in ${storyCity})`);
        }
        inputData.userLocation = { city: storyCity, country: 'Switzerland' };
        log.debug(`[SWISS] Using story city ${storyCity} for landmark discovery (storyTopic: ${inputData.storyTopic})`);
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
    const enableFullRepair = inputData.enableFullRepair !== false; // Full repair after generation (default: ON)

    log.info(`🔧 [PIPELINE] Settings: enableFullRepair=${enableFullRepair}, skipImages=${skipImages}, skipCovers=${skipCovers}`);

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
      bboxModel: MODEL_DEFAULTS.bboxDetection,
      imageBackend: MODEL_DEFAULTS.imageBackend,
      storyAvatarModel: null,  // null = use default (gemini-2.5-flash-image)
      sceneRouting: null,      // 'auto', 'grok', 'gemini', or null (= 'auto')
      generateEmptyScenes: MODEL_DEFAULTS.generateEmptyScenes ?? true,
      ...filteredUserOverrides  // Only non-null user overrides
    };
    // Trial mode: use Sonnet for story generation (best narrative quality)
    if (inputData.trialMode) {
      modelOverrides.outlineModel = 'claude-sonnet';
      log.info(`⚡ [TRIAL] Using Claude Sonnet for story generation (best quality)`);
    }
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

    // Picture-book layout for all reading levels: 1 page = 1 scene
    const printPages = inputData.pages;  // Total pages when printed
    const sceneCount = printPages;
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

    // Route to appropriate processing function based on generation mode
    if (generationMode === 'unified') {
      log.debug(`📚 [PIPELINE] Unified mode - single prompt + Art Director scene expansion`);
      return await processUnifiedStoryJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin, enableFullRepair, checkCancellation);
    }

    if (generationMode === 'pictureBook') {
      log.debug(`📚 [PIPELINE] Picture Book mode - using combined text+scene generation`);
      return await legacyPipelines.processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin);
    }

    // outlineAndText mode (legacy): Separate outline + text generation
    log.debug(`📚 [PIPELINE] OutlineAndText mode - using legacy outline+text pipeline`);
    return await legacyPipelines.processOutlineAndTextJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id, modelOverrides, isAdmin);

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
      await savePartialStoryFromCheckpoints(jobId, error.message);
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
            // Prefer story language over DB default (DB defaults to 'English' for trial users)
            const emailLanguage = user.preferred_language || 'en';
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

      // Clean up zombie jobs from previous container lifecycle
      // If the server restarts (deploy, crash), any "processing"/"pending" jobs are dead
      try {
        // First, find zombie jobs that need cleanup
        const zombieResult = await dbPool.query(
          `SELECT id, user_id, credits_reserved FROM story_jobs
           WHERE status IN ('pending', 'processing')`
        );
        if (zombieResult.rows.length > 0) {
          // Mark all zombie jobs as failed
          await dbPool.query(
            `UPDATE story_jobs
             SET status = 'failed',
                 error_message = 'Server restarted during generation',
                 credits_reserved = 0,
                 updated_at = NOW()
             WHERE status IN ('pending', 'processing')`
          );
          log.info(`🧹 Cleaned up ${zombieResult.rows.length} zombie job(s) from previous server lifecycle: ${zombieResult.rows.map(r => r.id).join(', ')}`);
          // Save partial results and refund credits for each zombie job
          for (const zombie of zombieResult.rows) {
            try {
              await savePartialStoryFromCheckpoints(zombie.id, 'Server restarted during generation');
            } catch (partialErr) {
              log.error(`❌ Failed to save partial story for zombie job ${zombie.id}:`, partialErr.message);
            }
          }
          for (const zombie of zombieResult.rows) {
            if (zombie.credits_reserved > 0) {
              try {
                const refundResult = await dbPool.query(
                  'UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits != -1 RETURNING credits',
                  [zombie.credits_reserved, zombie.user_id]
                );
                if (refundResult.rows.length > 0) {
                  await dbPool.query(
                    `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [zombie.user_id, zombie.credits_reserved, refundResult.rows[0].credits, 'story_refund', zombie.id,
                     'Auto-refund: server restarted during generation']
                  );
                  log.info(`💳 Auto-refunded ${zombie.credits_reserved} credits for zombie job ${zombie.id}`);
                }
              } catch (refundErr) {
                log.error(`❌ Failed to refund credits for zombie job ${zombie.id}:`, refundErr.message);
              }
            }
          }
        }
      } catch (cleanupErr) {
        log.error('⚠️ Failed to clean up zombie jobs:', cleanupErr.message);
      }

      // Preload historical locations from DB into memory cache
      await preloadHistoricalLocations();
      // Preload historical objects (period weapons/symbols/artifacts) into memory cache
      await preloadHistoricalObjects();
      // Load trial counters from DB so they survive deploys
      if (trialRoutes.loadTrialCountersFromDb) {
        await trialRoutes.loadTrialCountersFromDb();
      }
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
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin/\nDisallow: /create/\nDisallow: /stories\nDisallow: /orders\nDisallow: /book-builder\nDisallow: /welcome\nDisallow: /trial-generation\nDisallow: /claim/\nDisallow: /reset-password/\nDisallow: /email-verified\n\nSitemap: https://magicalstory.ch/sitemap.xml`);
  }
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(generateSitemap());
});

// NOTE: Public shared story routes moved to server/routes/sharing.js

// Pre-rendered SEO files live under dist/prerendered/{path}.{lang}.html
// Built by `node scripts/prerender.mjs` after the client + SSR builds.
const PRERENDER_DIR = path.join(distPath, 'prerendered');
const SUPPORTED_LANGS = new Set(['de', 'en', 'fr']);

function resolvePrerenderedFile(routePath, lang) {
  // Path traversal guard: only allow alnum, dash, underscore, slash, dot
  if (!/^[a-zA-Z0-9/_.-]*$/.test(routePath)) return null;
  if (routePath.includes('..')) return null;
  const slug = routePath === '/' ? '/index' : routePath.replace(/\/$/, '');
  const filePath = path.join(PRERENDER_DIR, `${slug}.${lang}.html`);
  // Ensure the resolved path stays within PRERENDER_DIR (defensive)
  if (!filePath.startsWith(PRERENDER_DIR)) return null;
  return require('fs').existsSync(filePath) ? filePath : null;
}

// NOTE: /shared/:token HTML response is handled by htmlRouter in
// server/routes/sharing.js — that handler now also injects the cover-image
// preconnect/preload hints alongside the OG tags it was already adding.

// SPA fallback — serves pre-rendered HTML for SEO routes, raw index.html for app routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api')) {
    return next();
  }

  const lang = SUPPORTED_LANGS.has(req.query.lang) ? req.query.lang : 'de';

  // Try pre-rendered file first (SEO routes)
  const prerenderedFile = resolvePrerenderedFile(req.path, lang);
  if (prerenderedFile) {
    // Long CDN cache — files only change on deploy
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.type('html').sendFile(prerenderedFile);
  }

  // App routes (/create, /wizard, /admin, etc.) — serve SPA shell
  if (hasDistFolder) {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

initialize().then(() => {
  // Force R2 init at boot so the [R2] config line appears in deploy logs
  // without waiting for the first image-save call.
  require('./server/lib/r2').isConfigured();

  const server = app.listen(PORT, () => {
    log.info(`🚀 MagicalStory Server Running`);
    log.info(`📍 URL: http://localhost:${PORT}`);
  });

  // Configure server timeouts to prevent premature connection closures
  // This helps with Railway's edge proxy and HTTP/2 connection management
  server.keepAliveTimeout = 65000; // 65 seconds (longer than typical proxy timeout of 60s)
  server.headersTimeout = 66000;   // Slightly longer than keepAliveTimeout
  log.info(`🔗 Keep-alive timeout: ${server.keepAliveTimeout}ms`);
}).catch(err => {
  log.error('Failed to initialize server:', err);
  process.exit(1);
});
