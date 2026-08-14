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
// (extracted to server/lib/serverLog.js — pipeline split)
const { log, LOG_LEVEL } = require('./server/lib/serverLog');

// Story pipeline module (checkpoints; processStoryJob follows in wave 2).
// Root-level module by design — see docs/plans/serverjs-pipeline-extraction.md (D1).
const {
  initStoryJobPipeline,
  saveCheckpoint,
  getCheckpoint,
  getAllCheckpoints,
  deleteJobCheckpoints,
  savePartialStoryFromCheckpoints,
  processStoryJob,
} = require('./storyJobPipeline');

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
const { PROMPT_TEMPLATES, loadPromptTemplates, fillTemplate, buildEmptyScenePrompt } = require('./server/services/prompts');
const { generatePrintPdf, generateViewPdf, generateCombinedBookPdf } = require('./server/lib/pdf');
const { processBookOrder, getCoverDimensions } = require('./server/lib/gelato');
const {
  hashImageData,
  generateImageCacheKey,
  evaluateImageQuality,
  callGeminiAPIForImage,
  editImageWithPrompt,
  deleteFromImageCache,
  compressImageToJPEG,
  IMAGE_QUALITY_THRESHOLD,
  // Separated evaluation pipeline functions
  generateImageOnly,
  evaluateImageBatch
} = require('./server/lib/images');
const { generateReferenceSheet, buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./server/lib/referenceSheets');
const { runUnifiedRepairPipeline } = require('./server/lib/repairPipeline');
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
  callClaudeAPI
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
  getElementReferenceImagesByIds,
  dedupeSecondaryCharacterIds
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
  buildSceneExpansionPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildUnifiedStoryPrompt,
  buildOutlineReviewPrompt,
  buildTrialStoryPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,
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
  enforceSpreadTextPosition,
  buildSceneClothingRequirements,
} = require('./server/lib/storyHelpers');
const { OutlineParser, UnifiedStoryParser, ProgressiveUnifiedParser } = require('./server/lib/outlineParser');
const { checkSceneConsistency, formatSceneConsistencySummary } = require('./server/lib/sceneConsistencyCheck');
const { generateStoryViaBeats, resolvePipelineMode } = require('./server/lib/beatsPipeline');
const { createJobHeartbeat } = require('./server/lib/jobHeartbeat');
const { getActiveIndexAfterPush } = require('./server/lib/versionManager');
const { GenerationLogger, setCurrentLogger, clearCurrentLogger } = require('./server/lib/generationLogger');
const { hasPhotos: hasCharacterPhotos, getFacePhoto } = require('./server/lib/characterPhotos');
const { generateSitemap } = require('./server/lib/seoMeta');
const { stripDataUriPrefix } = require('./server/lib/r2');
const configRoutes = require('./server/routes/config');
const healthRoutes = require('./server/routes/health');
const authRoutes = require('./server/routes/auth');
const userRoutes = require('./server/routes/user');
const characterRoutes = require('./server/routes/characters');
const storyDraftRoutes = require('./server/routes/storyDraft');
const storiesRoutes = require('./server/routes/stories');
const filesRoutes = require('./server/routes/files');
const { adminRoutes, initAdminRoutes } = require('./server/routes/admin');
const adminStatsRoutes = require('./server/routes/adminStats');
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
const { COVER_PAGE_NUMBERS } = require('./server/lib/coverKeys');

// App-side cover typography (MODEL_DEFAULTS.appSideCoverType). Figure boxes for placement come
// from the shared Phase 5b-pre detection (covers are pipeline pages -1/-2/-3), copied back onto
// coverImages[key].bboxDetection. Bakes the title / dedication / "magicalstory.ch" onto the
// textless art AND every version (so the served imageVersions[active] row carries the text everywhere
// — viewer, share, PDF, print), keeping the textless source in artImageData for no-AI title edits.
// Implementation lives in server/lib/coverTypography.js (single source of truth, unit-testable).
// Cover typography is baked post-persistence via bakeCoverTypographyPostPersist
// (required inline at its call site). The in-pipeline applyCoverTypography was
// removed 2026-07-20 (double-brand fix — see cover-typography call site).

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

// NOTE: IMAGE_GEN_MODE moved to storyJobPipeline.js (only pipeline code reads it)

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
    },
    statement_timeout: 120000,
    connectionTimeoutMillis: 10000
  });

  // An error emitted by an IDLE client (e.g. Railway Postgres restart, network
  // reset) surfaces as 'error' on the Pool. With no listener, Node treats it as
  // an unhandled 'error' event and crashes the process — killing every in-flight
  // story generation. Log and let the pool evict the dead client instead.
  dbPool.on('error', (err) => {
    log.error('❌ [PG POOL] Idle client error (evicted, not fatal):', err.message);
  });

  // Initialize the modular database service pool as well
  initModularPool();

  // Hand the story pipeline module its server-local state (injection seam, D4)
  initStoryJobPipeline({ dbPool, STORAGE_MODE, userLandmarkCache, LANDMARK_CACHE_TTL });

  log.debug(`✓ Database pools initialized`);
}

// Middleware
// Configure CORS to allow requests from your domains.
// Allowed list = hardcoded baseline (prod + local dev) + anything in the
// CORS_ORIGINS env var (comma-separated). Staging adds its own domain via
// CORS_ORIGINS so no code change is needed when spinning up new environments.
const ENV_CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BASE_ALLOWED_ORIGINS = [
  'http://localhost:8000',
  'http://localhost:3000',
  'http://localhost:5173',  // Vite dev server
  'http://localhost:5174',  // Vite dev server (alternate port)
  'http://localhost:5175',  // Vite dev server (alternate port)
  'http://127.0.0.1:8000',
  'http://127.0.0.1:5173',
  'https://www.magicalstory.ch',
  'https://magicalstory.ch',
];

const ALLOWED_ORIGINS = [...BASE_ALLOWED_ORIGINS, ...ENV_CORS_ORIGINS];
log.info(`🔒 CORS allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or server-to-server)
    if (!origin) return callback(null, true);

    // Also allow any Railway.app domain (strict suffix check to prevent spoofing)
    const isRailway = origin.endsWith('.railway.app') || origin === 'https://railway.app';
    if (isRailway || ALLOWED_ORIGINS.includes(origin)) {
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

// Stamps every request as activity for the staging idle-shutdown watcher.
// Mounted before the routes (and before the static handlers) so any traffic at
// all keeps the container awake. Inert unless STAGING_IDLE_SHUTDOWN=true.
app.use(require('./server/lib/idleShutdown').activityMiddleware);

// HTTP Basic Auth gate for staging / preview environments. Activated only
// when STAGING_AUTH_PASSWORD is set in the environment — prod leaves it
// unset and gets no gating. Mounted before everything else so unauthenticated
// requests are rejected as cheaply as possible.
//
// Bypassed paths (must remain reachable without browser-prompt auth):
//   - /api/*                — all API routes. Browsers don't reliably replay
//     Basic Auth credentials on XHR/fetch, so gating /api triggers an
//     endless Basic Auth prompt loop the moment the frontend tries to
//     register, log in, etc. The API has its own auth layer (JWT, Turnstile,
//     rate-limit). The Basic Auth gate's job is to hide the *site* from
//     casual visitors / search engines, not to be the API's authentication.
//   - PWA / SEO static metadata — manifest.json, robots.txt, sitemap.xml,
//     favicons, og-image. Browsers fetch these without credentials by spec;
//     gating them breaks PWA install + social-link previews + favicons even
//     for authenticated users.
const STAGING_AUTH_USER = process.env.STAGING_AUTH_USER || 'staging';
const STAGING_AUTH_PASSWORD = process.env.STAGING_AUTH_PASSWORD || null;
if (STAGING_AUTH_PASSWORD) {
  const crypto = require('crypto');
  const expectedUser = Buffer.from(STAGING_AUTH_USER);
  const expectedPass = Buffer.from(STAGING_AUTH_PASSWORD);
  const BYPASS_PATHS = new Set([
    '/manifest.json',
    '/robots.txt',
    '/sitemap.xml',
    '/favicon.ico',
  ]);
  // Pattern match for files where exact path varies (different sizes / variants).
  const BYPASS_PATTERNS = [
    // All API routes — browsers don't replay Basic Auth on fetch/XHR reliably,
    // so gating /api here breaks login/register/etc.
    /^\/api(\/|$)/i,
    /^\/favicon(-\d+)?\.png$/i,
    /^\/apple-touch-icon(-\d+x\d+)?\.png$/i,
    /^\/og-image(-\w+)?\.(png|jpg|jpeg|webp)$/i,
  ];
  const timingSafe = (a, b) => {
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  };
  app.use((req, res, next) => {
    if (BYPASS_PATHS.has(req.path)) return next();
    if (BYPASS_PATTERNS.some(re => re.test(req.path))) return next();
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="MagicalStory Staging"');
      return res.status(401).send('Staging access requires authentication.');
    }
    let providedUser = '', providedPass = '';
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      providedUser = decoded.slice(0, idx);
      providedPass = decoded.slice(idx + 1);
    } catch { /* fall through to 401 */ }
    const userBuf = Buffer.from(providedUser);
    const passBuf = Buffer.from(providedPass);
    if (timingSafe(userBuf, expectedUser) && timingSafe(passBuf, expectedPass)) {
      return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="MagicalStory Staging"');
    return res.status(401).send('Invalid credentials.');
  });
  log.info(`🔒 Staging Basic Auth enabled (user: "${STAGING_AUTH_USER}")`);
}

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
            // Atomic credit grant. Previously the SELECT-then-UPDATE sequence
            // ran outside a transaction, so two concurrent Stripe webhook
            // deliveries (Stripe retries on HTTP 5xx) could both pass the
            // idempotency check, both read the same balance, and both write
            // the same new balance — one grant silently lost. The
            // uq_credit_transactions_purchase_ref unique index now prevents
            // the duplicate INSERT, and the SELECT ... FOR UPDATE on the
            // user row serializes concurrent credit mutations for the same
            // user. Re-run the idempotency check inside the lock so the
            // happy path returns early without UPDATEing.
            const dbClient = await dbPool.connect();
            try {
              await dbClient.query('BEGIN');
              // Lock the user row first to serialize all credit mutations for
              // this user during this transaction.
              const userResult = await dbClient.query(
                'SELECT credits FROM users WHERE id = $1 FOR UPDATE',
                [userId]
              );
              if (userResult.rows.length === 0) {
                throw new Error('User not found for credits purchase');
              }
              // Re-check idempotency under the lock — a sibling webhook may
              // have already inserted the transaction row.
              const existingTransaction = await dbClient.query(
                'SELECT id FROM credit_transactions WHERE reference_id = $1 AND transaction_type = $2',
                [fullSession.id, 'purchase']
              );
              if (existingTransaction.rows.length > 0) {
                await dbClient.query('COMMIT');
                log.warn('⚠️ [STRIPE WEBHOOK] Credits already added for this session, skipping duplicate:', fullSession.id);
                res.json({ received: true, type: 'credits', duplicate: true });
                return;
              }

              const currentCredits = userResult.rows[0].credits || 0;
              // Don't add to unlimited credits (-1)
              const newCredits = currentCredits === -1 ? -1 : currentCredits + creditsToAdd;

              await dbClient.query('UPDATE users SET credits = $1 WHERE id = $2', [newCredits, userId]);

              // Defense-in-depth: the unique partial index on
              // (reference_id WHERE transaction_type='purchase') guarantees
              // this INSERT throws on a true duplicate, so the transaction
              // rolls back without granting credits.
              await dbClient.query(`
                INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description, price_cents)
                VALUES ($1, $2, $3, 'purchase', $4, $5, $6)
              `, [userId, creditsToAdd, newCredits, fullSession.id, `Purchased ${creditsToAdd} credits via Stripe (CHF ${(amountPaid / 100).toFixed(2)})`, amountPaid]);

              await dbClient.query('COMMIT');

              log.info(`✅ [STRIPE WEBHOOK] Added ${creditsToAdd} credits to user ${userId}`);
              log.debug(`   Previous balance: ${currentCredits}, New balance: ${newCredits}`);
              log.debug('💾 [STRIPE WEBHOOK] Credits transaction recorded');
              await logActivity(userId, null, 'CREDITS_PURCHASED', {
                sessionId: fullSession.id,
                creditsAdded: creditsToAdd,
                amountCents: amountPaid,
                currency: fullSession.currency,
                balanceAfter: newCredits,
                isTestPayment,
              });
            } catch (txErr) {
              await dbClient.query('ROLLBACK').catch(() => {});
              throw txErr;
            } finally {
              dbClient.release();
            }
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

          // IDEMPOTENCY CHECK + ORDER + TOKEN GRANT — single transaction.
          // The order INSERT, the credits UPDATE, and the credit_transactions
          // INSERT must commit together. If they don't, a crash between
          // them leaves an order without tokens credited; a retry then sees
          // the order row, exits via the idempotency check, and the user
          // never gets the tokens they paid for.
          const stripeMode = fullSession.metadata?.stripeMode === 'test' ? 'test' : 'live';
          const totalPages = parseInt(fullSession.metadata?.totalPages) || 0;
          let tokensToCredit = 0;
          let postTokenBalance = null;

          const orderClient = await dbPool.connect();
          try {
            await orderClient.query('BEGIN');

            // Re-check idempotency inside the tx so a sibling webhook can't
            // race past us between the check and the INSERT.
            const existingOrder = await orderClient.query(
              'SELECT id FROM orders WHERE stripe_session_id = $1',
              [fullSession.id]
            );
            if (existingOrder.rows.length > 0) {
              await orderClient.query('COMMIT');
              log.warn('⚠️ [STRIPE WEBHOOK] Order already processed, skipping duplicate:', fullSession.id);
              res.json({ received: true, duplicate: true });
              return;
            }

            await orderClient.query(`
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
            if (totalPages > 0 && userId) {
              const promoResult = await orderClient.query(
                "SELECT config_value FROM config WHERE config_key = 'token_promo_multiplier'"
              );
              const multiplier = promoResult.rows[0]?.config_value ? parseInt(promoResult.rows[0].config_value) : 1;
              const tokensPerPage = 10 * multiplier;
              tokensToCredit = totalPages * tokensPerPage;

              // Atomic increment with RETURNING — no SELECT-then-UPDATE race;
              // balance_after below is the true post-write value for THIS
              // tx, not whatever another concurrent tx left after.
              const upd = await orderClient.query(
                'UPDATE users SET credits = credits + $1 WHERE id = $2 RETURNING credits',
                [tokensToCredit, userId]
              );
              postTokenBalance = upd.rows[0]?.credits ?? tokensToCredit;

              await orderClient.query(`
                INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
                VALUES ($1, $2, $3, 'book_purchase_reward', $4, $5)
              `, [
                userId,
                tokensToCredit,
                postTokenBalance,
                fullSession.id,
                `Book purchase reward: ${totalPages} pages × ${tokensPerPage} tokens${multiplier > 1 ? ' (2x promo)' : ''}`
              ]);

              await orderClient.query(
                'UPDATE orders SET tokens_credited = $1 WHERE stripe_session_id = $2',
                [tokensToCredit, fullSession.id]
              );
            }

            await orderClient.query('COMMIT');

            await logActivity(userId, customerInfo.email, 'ORDER_PLACED', {
              sessionId: fullSession.id,
              paymentIntentId: fullSession.payment_intent,
              primaryStoryId,
              amountCents: fullSession.amount_total,
              currency: fullSession.currency,
              quantity: orderQuantity,
              coverType: orderCoverType,
              bookFormat: orderBookFormat,
              stripeMode,
            });
            if (tokensToCredit > 0) {
              const tokensPerPage = tokensToCredit / totalPages;
              log.info(`💰 [STRIPE WEBHOOK] Credited ${tokensToCredit} tokens to user ${userId} for book purchase (${totalPages} pages × ${tokensPerPage})`);
            }
          } catch (txErr) {
            await orderClient.query('ROLLBACK').catch(() => {});
            throw txErr;
          } finally {
            orderClient.release();
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
        // Rethrow so the outer handler buffers this event into
        // stripe_webhook_retry for out-of-band replay. Swallowing it here
        // acks 200 to Stripe → the event is never retried and never buffered,
        // leaving the customer charged with no order/credits. The duplicate
        // guards above already `return` before reaching this point, so a
        // rethrow only fires on genuine processing failures.
        throw retrieveError;
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
    // Signature was verified upstream, so this is a processing error inside
    // our handler — DB blip, unexpected throw, etc. Returning non-200 makes
    // Stripe retry 3× and then give up permanently; the customer ends up
    // charged with no order. Buffer the event to stripe_webhook_retry for
    // out-of-band replay, then ack 200 so Stripe doesn't abandon it.
    log.error('❌ [STRIPE WEBHOOK] Error processing webhook:', err);
    log.error('   Event type:', event?.type);
    log.error('   Event ID:', event?.id);
    log.error('   Stack:', err.stack);

    if (event) {
      try {
        await dbPool.query(
          `INSERT INTO stripe_webhook_retry (event_id, event_type, payload, error_message, error_stack)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id) DO NOTHING`,
          [event.id, event.type, JSON.stringify(event), err.message, err.stack]
        );
        log.warn(`💾 [STRIPE WEBHOOK] Buffered event ${event.id} (${event.type}) to stripe_webhook_retry for replay`);
      } catch (bufferErr) {
        log.error('❌ [STRIPE WEBHOOK] CRITICAL: failed to buffer event for retry:', bufferErr.message);
        log.error('   Event payload was:', JSON.stringify(event));
      }
    }

    res.json({ received: true, deferred: true });
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

    // Constant-time comparison (SEC-3) — matches the timingSafeEqual standard the
    // repo adopted for the trial admin-secret check; a plain !== leaks timing.
    const secretOk = (() => {
      if (typeof receivedSecret !== 'string') return false;
      const a = Buffer.from(receivedSecret);
      const b = Buffer.from(webhookSecret);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    })();
    if (!secretOk) {
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
                deliveryEstimateMax: orderData.delivery_estimate_max,
                // Lets email.js render the cover thumbnail on the email.
                storyId: order.story_id
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
              trackingUrl,
              // Lets email.js render the cover thumbnail on the email.
              storyId: order.story_id
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
    // Deployed commit — lets deploy scripts verify the running build instead
    // of racing Railway's cutover (Railway injects RAILWAY_GIT_COMMIT_SHA).
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8) || null,
  });
});
// Is work in flight that a deploy would destroy? Read by the pre-push hook
// (.githooks/pre-push) so a push can't restart the container on top of a running
// story generation or Test Lab experiment. Same busy probes the idle-shutdown
// watcher uses — one definition of "busy", not two that can drift.
app.get('/api/health/busy', async (req, res) => {
  try {
    const { busyReport } = require('./server/lib/idleShutdown');
    const report = await busyReport();
    res.json({
      ...report,
      env: process.env.RAILWAY_ENVIRONMENT_NAME || 'unknown',
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8) || null,
    });
  } catch (err) {
    // Unknown is not idle — say so explicitly and let the hook block.
    res.status(500).json({ busy: true, reasons: [`busy check failed: ${err.message}`] });
  }
});

// Serve static files
// Priority: 1. Built React app (dist/), 2. Images folder, 3. Legacy HTML files
const distPath = path.join(__dirname, 'dist');
const hasDistFolder = require('fs').existsSync(distPath);

// Initialize sharing routes with dist folder config
initSharingRoutes({ distPath, hasDistFolder });

// Initialize job routes with server.js-local dependencies
initJobRoutes({ processStoryJob, getCheckpoint, getAllCheckpoints, savePartialStoryFromCheckpoints });

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
  // Serve the built React app from dist/. express.static defaults to
  // Cache-Control: max-age=0, so every hashed bundle (index-<hash>.js/.css) was
  // re-downloaded on every visit. Vite content-hashes everything under /assets/,
  // so those are safe to cache immutably forever; /fonts/ are stable too. HTML
  // and other unhashed files keep the default (revalidate) so deploys show up.
  app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.includes(`${path.sep}fonts${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
      }
    },
  }));
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
app.use('/api/admin', adminStatsRoutes);  // /api/admin/story-metrics (Story Stats tab; /stats is taken by analytics)
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

// Schema management is now in migrations/00N_*.sql, executed by
// server/services/migrate.js → runMigrations(). The previous inline
// initializeDatabase() (630 lines of CREATE / ALTER IF NOT EXISTS) is
// captured verbatim in migrations/001_baseline.sql.
async function REMOVED_initializeDatabase_DEAD() {
  return; // dead — kept only until the next refactor lands cleanly
  /* DELETED — see migrations/001_baseline.sql
  if (!dbPool) {
    log.warn('⚠️  No database pool - skipping database initialization');
    return;
  }

  try {
    await dbPool.query('SELECT 1');
    log.info('✓ Database connection successful');

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
    // metadata column added later — writers do INSERT ... (id, user_id, data, metadata).
    // Fresh DBs (staging) need this; prod was migrated manually long ago.
    await dbPool.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS metadata JSONB`);
    // Runtime uses JSONB operators on characters.data (data->'characters', etc.)
    // but the original CREATE TABLE above declared it TEXT. Prod was converted
    // manually; fresh DBs need this. DO block is no-op when already JSONB.
    await dbPool.query(`
      DO $$
      BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='characters' AND column_name='data') = 'text' THEN
          ALTER TABLE characters ALTER COLUMN data TYPE JSONB USING data::jsonb;
        END IF;
      END $$;
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id)`);
    // metadata column added later — readers do SELECT metadata FROM stories.
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS metadata JSONB`);
    // Same TEXT → JSONB conversion as characters.data (see above).
    await dbPool.query(`
      DO $$
      BEGIN
        IF (SELECT data_type FROM information_schema.columns
            WHERE table_name='stories' AND column_name='data') = 'text' THEN
          ALTER TABLE stories ALTER COLUMN data TYPE JSONB USING data::jsonb;
        END IF;
      END $$;
    `);

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
    // (stripe_webhook_retry now lives in migrations/005_stripe_webhook_retry.sql —
    // the prior inline addition here never ran because this whole function is dead.)

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

    // consolidator_calls — per-call audit for the feedback consolidator.
    // Same staging vs prod story: prod has it manually, fresh DBs don't.
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS consolidator_calls (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL,
        page_number INT,
        round INT,
        full_prompt TEXT,
        raw_response TEXT,
        plan JSONB,
        usage JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story ON consolidator_calls(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story_page ON consolidator_calls(story_id, page_number, round)`);

    // story_images + story_retry_images tables — prod has them from a manual
    // migration long ago; fresh DBs (staging) need them created here so the
    // ALTER TABLE statements below don't blow up with "relation does not exist".
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_images (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        image_type VARCHAR(50) NOT NULL,
        page_number INT,
        version_index INT NOT NULL DEFAULT 0,
        image_data TEXT,
        image_url TEXT,
        quality_score INT,
        generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_with_page
      ON story_images(story_id, image_type, page_number, version_index) WHERE page_number IS NOT NULL`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_without_page
      ON story_images(story_id, image_type, version_index) WHERE page_number IS NULL`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_images_story_id ON story_images(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_images_story_version ON story_images(story_id, version_index)`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_retry_images (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        page_number INT NOT NULL,
        retry_index INT NOT NULL,
        image_type VARCHAR(50) NOT NULL,
        grid_index INT,
        image_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_retry_images_story ON story_retry_images(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_retry_images_page ON story_retry_images(story_id, page_number)`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_images_unique ON story_retry_images(story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))`);

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
    throw err;
  }
  */ // end DELETED block — see migrations/001_baseline.sql
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
// NOTE: Checkpoint system moved to storyJobPipeline.js (saveCheckpoint,
// getCheckpoint, getAllCheckpoints, deleteJobCheckpoints, savePartialStoryFromCheckpoints)

// ===================================
// NOTE: Story generation pipeline (processUnifiedStoryJob, processStoryJob,
// _processStoryJobImpl) moved to storyJobPipeline.js — see
// docs/plans/serverjs-pipeline-extraction.md
// ===================================

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
//           editImageWithPrompt, generateImageOnly
// =============================================================================




// Initialize and start server
// Initialize database or files based on mode
const { runMigrations } = require('./server/services/migrate');

async function initialize() {
  // Load prompt templates first
  await loadPromptTemplates();

  if (STORAGE_MODE === 'database' && dbPool) {
    // Run schema migrations. If this throws, the app refuses to boot —
    // we intentionally no longer fall back to file storage, because that
    // mode masked the staging schema-drift bug for hours. A broken DB
    // should make startup loud and obvious.
    await runMigrations(dbPool, log);

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

  // Staging-only: stop the container once it's provably idle so we stop paying
  // for ~1.2 GB of resident RAM per minute between test runs. Triple-gated and
  // a no-op in production — see server/lib/idleShutdown.js.
  require('./server/lib/idleShutdown').startIdleShutdown();

  // Trial reminder sweep — emails unclaimed trial accounts at day-5 and day-25.
  // Hourly cadence: the cohorts move slowly (trials are created sporadically,
  // reminders fire on day boundaries), so hourly is plenty and bounds slippage
  // to <1h. setInterval is fine here — node-cron would be overkill for a
  // single hourly job.
  if (STORAGE_MODE === 'database' && dbPool) {
    const { runTrialReminderSweep } = require('./server/lib/trialReminders');
    // Run once shortly after boot (skip the first hour wait), then every hour.
    setTimeout(() => {
      runTrialReminderSweep(dbPool, log).catch(err => {
        log.error('[trial-reminders] sweep crashed:', err.message);
      });
    }, 60 * 1000); // 60s grace so boot work settles first
    setInterval(() => {
      runTrialReminderSweep(dbPool, log).catch(err => {
        log.error('[trial-reminders] sweep crashed:', err.message);
      });
    }, 60 * 60 * 1000); // every hour

    // Proactive stale-job watchdog. A worker death (OOM / crash / infra restart)
    // leaves the story_job at 'processing' with no chance to write an error, so
    // without this it spins forever (2026-07-19: two 5-page jobs each orphaned
    // ~2h). Key on updated_at, not created_at: a live job keeps writing progress,
    // a dead one goes silent — 15 min of silence = dead. The /my-jobs per-request
    // pass is only a backstop for users who happen to poll; this catches every
    // dead job server-side within 5 min.
    const sweepStaleJobs = async () => {
      try {
        // Fail + atomically claim credits_reserved in ONE statement: zeroing
        // credits_reserved in the same UPDATE that fails the job means a
        // concurrent cancel (WHERE credits_reserved > 0) can't also refund it.
        // Without this, the sweep marked jobs failed but never refunded, and
        // cleanupOldCompletedJobs then deleted the row (+ the reserved amount)
        // after 1h — the user silently lost the full story price.
        const r = await dbPool.query(
          `UPDATE story_jobs s SET status='failed',
             error_message='Job stalled — no progress for 15 min (worker died: OOM/crash/restart)',
             credits_reserved=0, updated_at=NOW()
           FROM (SELECT id, credits_reserved AS prev, user_id, progress
                   FROM story_jobs
                  WHERE status IN ('pending','processing')
                    AND updated_at < NOW() - INTERVAL '15 minutes') old
           WHERE s.id = old.id
           RETURNING s.id, old.prev AS refund_amount, old.user_id, old.progress`);
        if (r.rowCount > 0) {
          log.warn(`[STALE-JOB-SWEEP] failed ${r.rowCount} stalled job(s): ${r.rows.map(x => x.id).join(', ')}`);
          for (const job of r.rows) {
            // Refund reserved credits (credits != -1 guards unlimited/admin accounts)
            if (job.refund_amount && job.refund_amount > 0 && job.user_id) {
              try {
                const refundRes = await dbPool.query(
                  `UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits != -1 RETURNING credits`,
                  [job.refund_amount, job.user_id]);
                if (refundRes.rows.length > 0) {
                  await dbPool.query(
                    `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
                     VALUES ($1, $2, $3, 'story_refund', $4, $5)`,
                    [job.user_id, job.refund_amount, refundRes.rows[0].credits, job.id,
                     `Auto-refund: stale job swept (progress ${job.progress || 0}%)`]);
                  log.info(`💳 [STALE-JOB-SWEEP] refunded ${job.refund_amount} credits for ${job.id}`);
                }
              } catch (refundErr) {
                log.error(`[STALE-JOB-SWEEP] refund failed for ${job.id}: ${refundErr.message}`);
              }
            }
            // Salvage any completed pages from checkpoints (same as boot cleanup)
            try {
              await savePartialStoryFromCheckpoints(job.id, 'Job stalled — recovered partial story');
            } catch (saveErr) {
              log.warn(`[STALE-JOB-SWEEP] partial-save failed for ${job.id}: ${saveErr.message}`);
            }
          }
        }
      } catch (err) {
        log.warn(`[STALE-JOB-SWEEP] sweep failed: ${err.message}`);
      }
    };
    setTimeout(sweepStaleJobs, 60 * 1000);       // first sweep 1 min after boot
    setInterval(sweepStaleJobs, 5 * 60 * 1000);  // then every 5 min

    // Daily admin summary email — same hourly cadence; sends once per
    // Swiss-local day after 07:00 (config row daily_summary_last_sent
    // dedupes across restarts).
    const { runDailySummarySweep } = require('./server/lib/dailySummary');
    setTimeout(() => {
      runDailySummarySweep(dbPool, log).catch(err => {
        log.error('[daily-summary] sweep crashed:', err.message);
      });
    }, 90 * 1000);
    setInterval(() => {
      runDailySummarySweep(dbPool, log).catch(err => {
        log.error('[daily-summary] sweep crashed:', err.message);
      });
    }, 60 * 60 * 1000); // every hour

    // Weekly Railway cost report — same hourly cadence, sends Mondays after
    // 07:00 Swiss (config row weekly_cost_last_sent dedupes). Railway bills
    // resident memory per minute, so cost drifts silently between invoices;
    // this surfaces it while it's still cheap to react to. Inert until
    // RAILWAY_API_TOKEN + RAILWAY_PROJECT_ID are set.
    const { runWeeklyCostSweep } = require('./server/lib/costReport');
    setInterval(() => {
      runWeeklyCostSweep(dbPool, log).catch(err => {
        log.error('[weekly-cost] sweep crashed:', err.message);
      });
    }, 60 * 60 * 1000); // every hour

    // Stripe webhook retry monitor — polls every 5 min for buffered events
    // that landed during a DB blip / processing throw. Emits an ERROR-level
    // alert when unprocessed rows exist. Operators inspect + manually
    // resolve via /api/admin/stripe-webhook-retry (full auto-replay is
    // tracked as the BullMQ refactor in the long-term plan).
    const checkStripeRetryBuffer = async () => {
      try {
        const result = await dbPool.query(`
          SELECT COUNT(*)::int AS unprocessed,
                 MIN(created_at) AS oldest
          FROM stripe_webhook_retry
          WHERE processed_at IS NULL
        `);
        const { unprocessed, oldest } = result.rows[0] || {};
        if (unprocessed > 0) {
          const ageMin = oldest ? Math.round((Date.now() - new Date(oldest).getTime()) / 60000) : 0;
          log.error(`🚨 [STRIPE-RETRY-MONITOR] ${unprocessed} buffered event(s) need triage — oldest is ${ageMin} min old. Inspect at /api/admin/stripe-webhook-retry`);
        }
      } catch (err) {
        log.warn(`[STRIPE-RETRY-MONITOR] check failed: ${err.message}`);
      }
    };
    setTimeout(checkStripeRetryBuffer, 30 * 1000);          // first check 30s after boot
    setInterval(checkStripeRetryBuffer, 5 * 60 * 1000);     // then every 5 min
  }

  // Configure server timeouts to prevent premature connection closures
  // This helps with Railway's edge proxy and HTTP/2 connection management
  server.keepAliveTimeout = 65000; // 65 seconds (longer than typical proxy timeout of 60s)
  server.headersTimeout = 66000;   // Slightly longer than keepAliveTimeout
  log.info(`🔗 Keep-alive timeout: ${server.keepAliveTimeout}ms`);
}).catch(err => {
  log.error('Failed to initialize server:', err);
  process.exit(1);
});
