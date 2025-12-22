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
  console.log(`   ⚠️  Warning: STRIPE_LIVE_SECRET_KEY not set - all users will use test mode`);
}
const sharp = require('sharp');
const email = require('./email');
const admin = require('firebase-admin');

// Import modular routes and database service
const { initializePool: initModularPool } = require('./server/services/database');
const configRoutes = require('./server/routes/config');
const healthRoutes = require('./server/routes/health');
const authRoutes = require('./server/routes/auth');
const userRoutes = require('./server/routes/user');
const characterRoutes = require('./server/routes/characters');
const storyDraftRoutes = require('./server/routes/storyDraft');
const storiesRoutes = require('./server/routes/stories');
const filesRoutes = require('./server/routes/files');
const adminRoutes = require('./server/routes/admin');

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
    console.log('🔥 Firebase Admin SDK initialized from base64 env var');
  } catch (err) {
    console.warn('⚠️  Firebase Admin SDK initialization from base64 failed:', err.message);
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
    console.log('🔥 Firebase Admin SDK initialized from JSON env var');
  } catch (err) {
    console.warn('⚠️  Firebase Admin SDK initialization failed:', err.message);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  try {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    firebaseInitialized = true;
    console.log('🔥 Firebase Admin SDK initialized from file:', process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  } catch (err) {
    console.warn('⚠️  Firebase Admin SDK initialization from file failed:', err.message);
  }
} else {
  console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not configured - Firebase auth disabled');
  console.warn('⚠️  Available env vars with FIREBASE:', Object.keys(process.env).filter(k => k.includes('FIREBASE')));
}

// Image cache for storing generated images (hash of prompt + photos → image data)
const imageCache = new Map();
console.log('💾 Image cache initialized');

// Story Generation Batch Size Configuration
// Set to 0 or a number >= total pages to generate entire story in one API call
// Set to 5-10 for lower API tiers to stay under rate limits (e.g. 8K tokens/minute)
// Recommended values:
//   - Tier 1 (8K tokens/min): 5-8 pages per batch
//   - Tier 2+ (400K tokens/min): 0 (generate all at once)
const STORY_BATCH_SIZE = parseInt(process.env.STORY_BATCH_SIZE) || 0;  // 0 = no batching (generate all at once)

// Image generation mode: 'parallel' (fast) or 'sequential' (consistent - passes previous image)
const IMAGE_GEN_MODE = process.env.IMAGE_GEN_MODE || 'parallel';

// Image quality threshold - regenerate if score below this value (0-100 scale)
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || 50;

// LOG_LEVEL controls verbosity: error < warn < info < debug < trace
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const CURRENT_LOG_LEVEL = LOG_LEVELS[LOG_LEVEL] !== undefined ? LOG_LEVELS[LOG_LEVEL] : LOG_LEVELS.info;

const log = {
  // ERROR: Something failed, needs immediate attention
  error: (msg, ...args) => console.error(`[ERROR] ${msg}`, ...args),
  // WARN: Something unexpected but not broken
  warn: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.warn && console.warn(`[WARN] ${msg}`, ...args),
  // INFO: Key business events (startup, user actions, completions)
  info: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.info && console.log(msg, ...args),
  // DEBUG: Developer troubleshooting (API calls, DB queries, flow tracing)
  debug: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args),
  // TRACE: Super detailed (request/response bodies, token counts, internal state)
  trace: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.trace && console.log(`[TRACE] ${msg}`, ...args),
  // Backwards compatibility alias
  verbose: (msg, ...args) => CURRENT_LOG_LEVEL >= LOG_LEVELS.debug && console.log(`[DEBUG] ${msg}`, ...args)
};

log.info(`📚 Story batch size: ${STORY_BATCH_SIZE === 0 ? 'DISABLED (generate all at once)' : STORY_BATCH_SIZE + ' pages per batch'}`);
log.info(`📊 Log level: ${LOG_LEVEL.toUpperCase()}`);

// =============================================================================
// TEXT MODEL CONFIGURATION
// Set TEXT_MODEL env var to switch between models (default: claude-sonnet)
// =============================================================================
const TEXT_MODELS = {
  'claude-sonnet': {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    maxOutputTokens: 64000,
    description: 'Claude Sonnet 4.5 - Best narrative quality'
  },
  'claude-haiku': {
    provider: 'anthropic',
    modelId: 'claude-3-5-haiku-20241022',
    maxOutputTokens: 8192,
    description: 'Claude Haiku 3.5 - Fast and cheap'
  },
  'gemini-2.5-pro': {
    provider: 'google',
    modelId: 'gemini-2.5-pro',
    maxOutputTokens: 65536,
    description: 'Gemini 2.5 Pro - High quality, large output'
  },
  'gemini-2.5-flash': {
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    maxOutputTokens: 65536,
    description: 'Gemini 2.5 Flash - Fast with large output'
  },
  'gemini-2.0-flash': {
    provider: 'google',
    modelId: 'gemini-2.0-flash',
    maxOutputTokens: 8192,
    description: 'Gemini 2.0 Flash - Very fast'
  },
  'gemini-pro-latest': {
    provider: 'google',
    modelId: 'gemini-pro-latest',
    maxOutputTokens: 65536,
    description: 'Gemini Pro Latest (2.5 Pro) - High quality'
  }
};

// Active text model (configurable via env var)
const TEXT_MODEL = process.env.TEXT_MODEL || 'claude-sonnet';
const activeTextModel = TEXT_MODELS[TEXT_MODEL] || TEXT_MODELS['claude-sonnet'];

log.info(`🤖 Text model: ${TEXT_MODEL} (${activeTextModel.description})`);

/**
 * Calculate optimal batch size based on model token limits
 * @param {number} totalPages - Total number of pages to generate
 * @param {number} tokensPerPage - Estimated tokens needed per page (default: 400 for storybook, 500 for standard)
 * @param {number} safetyMargin - Safety margin to avoid hitting limits (default: 0.8 = use 80% of max)
 * @returns {number} Optimal batch size (number of pages per API call)
 */
function calculateOptimalBatchSize(totalPages, tokensPerPage = 400, safetyMargin = 0.8) {
  const maxTokens = activeTextModel.maxOutputTokens;
  const safeMaxTokens = Math.floor(maxTokens * safetyMargin);
  const optimalBatchSize = Math.floor(safeMaxTokens / tokensPerPage);

  // Ensure at least 1 page per batch, and don't exceed total pages
  const batchSize = Math.max(1, Math.min(optimalBatchSize, totalPages));

  log.verbose(`📊 [BATCH CALC] Model max: ${maxTokens}, safe max: ${safeMaxTokens}, tokens/page: ${tokensPerPage}, optimal batch: ${batchSize} pages`);

  return batchSize;
}

/**
 * Detect which characters are mentioned in a scene description
 * @param {string} sceneDescription - The scene text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Characters that appear in this scene
 */
function getCharactersInScene(sceneDescription, characters) {
  if (!sceneDescription || !characters || characters.length === 0) {
    return [];
  }

  const sceneLower = sceneDescription.toLowerCase();
  return characters.filter(char => {
    if (!char.name) return false;
    // Check for character name in scene (case insensitive)
    const nameLower = char.name.toLowerCase();
    // Also check for first name only (e.g., "Max" from "Max Mustermann")
    const firstName = nameLower.split(' ')[0];
    return sceneLower.includes(nameLower) || sceneLower.includes(firstName);
  });
}

/**
 * Get photo URLs for specific characters based on clothing category
 * Prefers clothing avatar for the category > body with no background > body crop > face photo
 * @param {Array} characters - Array of character objects (filtered to scene)
 * @param {string} clothingCategory - Optional clothing category (winter, summer, formal, standard)
 * @returns {Array} Array of photo URLs for image generation
 */
function getCharacterPhotos(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];
  return characters
    .map(char => {
      // If clothing category specified and character has clothing avatar for it, use it
      if (clothingCategory && char.clothingAvatars && char.clothingAvatars[clothingCategory]) {
        return char.clothingAvatars[clothingCategory];
      }
      // Fall back to body without background > body crop > face photo
      return char.bodyNoBgUrl || char.bodyPhotoUrl || char.photoUrl;
    })
    .filter(url => url); // Remove nulls
}

/**
 * Parse clothing category from scene description
 * Looks for patterns like "Clothing: winter" or "**Clothing:** standard"
 * @param {string} sceneDescription - The scene description text
 * @returns {string|null} Clothing category (winter, summer, formal, standard) or null if not found
 */
function parseClothingCategory(sceneDescription) {
  if (!sceneDescription) return null;

  // Generic approach: find "Clothing" keyword (in any language) and look for value nearby
  // Handles any markdown: **, *, --, __, ##, etc.

  // Markdown chars that might wrap keywords or values
  const md = '[\\*_\\-#\\s\\.\\d]*';

  // Clothing keywords in multiple languages
  const keywords = '(?:Clothing|Kleidung|Vêtements|Tenue)';

  // Valid clothing values
  const values = '(winter|summer|formal|standard)';

  // Pattern 1: Same line - keyword and value on same line with any markdown/separators
  // Handles: **Clothing:** winter, *Clothing*: **winter**, --Clothing--: winter, ## 4. Clothing: winter
  const sameLineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + values, 'i')
  );
  if (sameLineMatch) {
    return sameLineMatch[1].toLowerCase();
  }

  // Pattern 2: Value on next line - handles any markdown formatting
  // Handles: **Clothing:**\n**winter**, ## Clothing\n*winter*, Clothing:\nwinter
  const multilineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + '\\n' + md + values + md, 'i')
  );
  if (multilineMatch) {
    return multilineMatch[1].toLowerCase();
  }

  // Pattern 3: Fallback - find keyword and look for value within next 100 chars
  const keywordMatch = sceneDescription.match(new RegExp(keywords, 'i'));
  if (keywordMatch) {
    const startIndex = keywordMatch.index;
    const nearbyText = sceneDescription.substring(startIndex, startIndex + 100);
    const valueMatch = nearbyText.match(/\b(winter|summer|formal|standard)\b/i);
    if (valueMatch) {
      return valueMatch[1].toLowerCase();
    }
  }

  return null;
}

/**
 * Generate a short hash for image data (for verification in dev mode)
 * @param {string} imageData - Base64 image data URL
 * @returns {string} Short hash (8 characters)
 */
function hashImageData(imageData) {
  if (!imageData) return null;
  const data = imageData.replace(/^data:image\/\w+;base64,/, '');
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8);
}

/**
 * Get detailed photo info for characters (for dev mode display)
 * @param {Array} characters - Array of character objects
 * @param {string} clothingCategory - Optional clothing category to show which avatar is used
 * @returns {Array} Array of objects with character name and photo type used
 */
function getCharacterPhotoDetails(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];
  return characters
    .map(char => {
      let photoType = 'none';
      let photoUrl = null;

      // Support both new structure (char.avatars, char.photos) and legacy (char.clothingAvatars, char.bodyNoBgUrl, etc.)
      const avatars = char.avatars || char.clothingAvatars;
      const photos = char.photos || {};

      // Check for clothing avatar first
      if (clothingCategory && avatars && avatars[clothingCategory]) {
        photoType = `clothing-${clothingCategory}`;
        photoUrl = avatars[clothingCategory];
      } else if (photos.bodyNoBg || char.bodyNoBgUrl) {
        photoType = 'bodyNoBg';
        photoUrl = photos.bodyNoBg || char.bodyNoBgUrl;
      } else if (photos.body || char.bodyPhotoUrl) {
        photoType = 'body';
        photoUrl = photos.body || char.bodyPhotoUrl;
      } else if (photos.face || photos.original || char.photoUrl) {
        photoType = 'face';
        photoUrl = photos.face || photos.original || char.photoUrl;
      }
      return {
        name: char.name,
        id: char.id,
        photoType,
        photoUrl,
        photoHash: hashImageData(photoUrl),  // For dev mode verification
        clothingCategory: clothingCategory || null,
        hasPhoto: photoType !== 'none'
      };
    })
    .filter(info => info.hasPhoto);
}

/**
 * Build a physical description of a character for image generation
 * Only includes visual attributes, not psychological traits
 * @param {Object} char - Character object
 * @returns {string} Physical description string
 */
function buildCharacterPhysicalDescription(char) {
  const age = parseInt(char.age) || 10;
  const gender = char.gender || 'child';

  // Use age-appropriate gender labels
  let genderLabel;
  if (gender === 'male') {
    genderLabel = age >= 18 ? 'man' : 'boy';
  } else if (gender === 'female') {
    genderLabel = age >= 18 ? 'woman' : 'girl';
  } else {
    genderLabel = age >= 18 ? 'person' : 'child';
  }

  let description = `${char.name} is a ${age}-year-old ${genderLabel}`;

  // Support both legacy fields and new physical object structure
  const height = char.physical?.height || char.height;
  const build = char.physical?.build || char.build;
  const hair = char.physical?.hair || char.hairColor;
  const face = char.physical?.face || char.otherFeatures;
  const other = char.physical?.other;
  const clothing = char.clothing?.current || char.clothing;

  if (height) {
    description += `, ${height} cm tall`;
  }
  if (build) {
    description += `, ${build} build`;
  }
  if (hair) {
    description += `, with ${hair} hair`;
  }
  if (face) {
    description += `, ${face}`;
  }
  // Add other physical traits (glasses, birthmarks, always-present accessories)
  if (other && other !== 'none') {
    description += `, ${other}`;
  }
  if (clothing) {
    description += `. Wearing: ${clothing}`;
  }

  return description;
}

// Load prompt templates from files
const PROMPT_TEMPLATES = {};
async function loadPromptTemplates() {
  try {
    const promptsDir = path.join(__dirname, 'prompts');
    PROMPT_TEMPLATES.outline = await fs.readFile(path.join(promptsDir, 'outline.txt'), 'utf-8');
    PROMPT_TEMPLATES.storyTextBatch = await fs.readFile(path.join(promptsDir, 'story-text-batch.txt'), 'utf-8');
    PROMPT_TEMPLATES.storyTextSingle = await fs.readFile(path.join(promptsDir, 'story-text-single.txt'), 'utf-8');
    PROMPT_TEMPLATES.sceneDescriptions = await fs.readFile(path.join(promptsDir, 'scene-descriptions.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGeneration = await fs.readFile(path.join(promptsDir, 'image-generation.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationDe = await fs.readFile(path.join(promptsDir, 'image-generation-de.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationFr = await fs.readFile(path.join(promptsDir, 'image-generation-fr.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequential = await fs.readFile(path.join(promptsDir, 'image-generation-sequential.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequentialDe = await fs.readFile(path.join(promptsDir, 'image-generation-sequential-de.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationSequentialFr = await fs.readFile(path.join(promptsDir, 'image-generation-sequential-fr.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageGenerationStorybook = await fs.readFile(path.join(promptsDir, 'image-generation-storybook.txt'), 'utf-8');
    PROMPT_TEMPLATES.imageEvaluation = await fs.readFile(path.join(promptsDir, 'image-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.coverImageEvaluation = await fs.readFile(path.join(promptsDir, 'cover-image-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.frontCover = await fs.readFile(path.join(promptsDir, 'front-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageWithDedication = await fs.readFile(path.join(promptsDir, 'initial-page-with-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageNoDedication = await fs.readFile(path.join(promptsDir, 'initial-page-no-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.backCover = await fs.readFile(path.join(promptsDir, 'back-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.storybookCombined = await fs.readFile(path.join(promptsDir, 'storybook-combined.txt'), 'utf-8');
    PROMPT_TEMPLATES.rewriteBlockedScene = await fs.readFile(path.join(promptsDir, 'rewrite-blocked-scene.txt'), 'utf-8');
    // Character analysis prompt
    PROMPT_TEMPLATES.characterAnalysis = await fs.readFile(path.join(promptsDir, 'character-analysis.txt'), 'utf-8');
    // Avatar generation prompts
    PROMPT_TEMPLATES.avatarSystemInstruction = await fs.readFile(path.join(promptsDir, 'avatar-system-instruction.txt'), 'utf-8');
    PROMPT_TEMPLATES.avatarMainPrompt = await fs.readFile(path.join(promptsDir, 'avatar-main-prompt.txt'), 'utf-8');
    PROMPT_TEMPLATES.avatarRetryPrompt = await fs.readFile(path.join(promptsDir, 'avatar-retry-prompt.txt'), 'utf-8');
    // Visual Bible and editing prompts
    PROMPT_TEMPLATES.visualBibleAnalysis = await fs.readFile(path.join(promptsDir, 'visual-bible-analysis.txt'), 'utf-8');
    PROMPT_TEMPLATES.illustrationEdit = await fs.readFile(path.join(promptsDir, 'illustration-edit.txt'), 'utf-8');
    log.info('📝 Prompt templates loaded from prompts/ folder');
  } catch (err) {
    log.error('❌ Failed to load prompt templates:', err.message);
    log.error('   Falling back to hardcoded prompts');
  }
}

// Helper function to replace placeholders in prompt templates
function fillTemplate(template, replacements) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}

const app = express();

// Trust first proxy (Railway, Heroku, etc.) - required for rate limiting to work correctly
// This allows Express to trust X-Forwarded-For headers for client IP detection
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Database Configuration - PostgreSQL (Railway)
const DATABASE_URL = process.env.DATABASE_URL;

// Debug logging
console.log('🔍 Environment Check:');
console.log(`  DATABASE_URL: ${DATABASE_URL ? 'SET (length: ' + DATABASE_URL.length + ')' : 'NOT SET'}`);
console.log(`  STORAGE_MODE: ${process.env.STORAGE_MODE}`);
console.log(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET (length: ' + process.env.GEMINI_API_KEY.length + ')' : 'NOT SET'}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NOT SET'}`);

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
  console.log(`✓ PostgreSQL pool created (Railway)`);

  // Initialize the modular database service pool as well
  initModularPool();
  console.log(`✓ Modular database pool initialized`);
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
      console.warn('⚠️  CORS blocked origin:', origin);
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
    console.error('❌ [STRIPE WEBHOOK] No webhook secrets configured!');
    console.error('   Please add STRIPE_TEST_WEBHOOK_SECRET and/or STRIPE_LIVE_WEBHOOK_SECRET');
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
      console.error('❌ [STRIPE WEBHOOK] Signature verification failed with both secrets:', err.message);
      return res.status(400).json({ error: 'Invalid signature' });
    }
  }

  if (!event) {
    console.error('❌ [STRIPE WEBHOOK] Could not verify webhook signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // Now handle the verified event
  try {
    console.log('💳 [STRIPE WEBHOOK] Received verified event:', event.type);
    console.log(`   Payment type: ${isTestPayment ? 'TEST (admin/developer)' : 'LIVE (real payment)'}`);

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

        console.log('📦 [STRIPE WEBHOOK] Customer Information:');
        console.log('   Name:', customerInfo.name);
        console.log('   Email:', customerInfo.email);
        console.log('   Address:', JSON.stringify(customerInfo.address, null, 2));
        console.log('   Metadata:', JSON.stringify(fullSession.metadata, null, 2));

        // Check if this is a credits purchase
        if (fullSession.metadata?.type === 'credits') {
          console.log('💰 [STRIPE WEBHOOK] Processing credits purchase');
          const userId = parseInt(fullSession.metadata?.userId);
          const creditsToAdd = parseInt(fullSession.metadata?.credits) || 100;

          if (!userId || isNaN(userId)) {
            console.error('❌ [STRIPE WEBHOOK] Invalid userId for credits purchase:', fullSession.metadata);
            throw new Error('Invalid userId in credits purchase metadata');
          }

          if (STORAGE_MODE === 'database') {
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
            console.log(`   Previous balance: ${currentCredits}, New balance: ${newCredits}`);

            // Create transaction record
            await dbPool.query(`
              INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
              VALUES ($1, $2, $3, 'purchase', $4, $5)
            `, [userId, creditsToAdd, newCredits, fullSession.id, `Purchased ${creditsToAdd} credits via Stripe`]);

            console.log('💾 [STRIPE WEBHOOK] Credits transaction recorded');
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
            console.error('❌ [STRIPE WEBHOOK] Invalid or missing userId in metadata:', fullSession.metadata);
            throw new Error('Invalid userId in session metadata');
          }

          // Parse story IDs - support both new storyIds array and legacy storyId
          let allStoryIds = [];
          if (fullSession.metadata?.storyIds) {
            try {
              allStoryIds = JSON.parse(fullSession.metadata.storyIds);
            } catch (e) {
              console.error('❌ [STRIPE WEBHOOK] Failed to parse storyIds:', e);
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
            console.error('❌ [STRIPE WEBHOOK] No story IDs in metadata:', fullSession.metadata);
            throw new Error('Missing story IDs in session metadata - cannot process book order');
          }

          console.log(`📚 [STRIPE WEBHOOK] Processing order with ${allStoryIds.length} stories:`, allStoryIds);

          // Validate all stories exist
          const validatedStoryIds = [];
          for (const sid of allStoryIds) {
            const result = await dbPool.query('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [sid, userId]);
            if (result.rows.length > 0) {
              validatedStoryIds.push(sid);
            } else {
              console.warn(`⚠️ [STRIPE WEBHOOK] Story not found: ${sid}, skipping`);
            }
          }

          if (validatedStoryIds.length === 0) {
            console.error('❌ [STRIPE WEBHOOK] No valid stories found for IDs:', allStoryIds);
            console.error('❌ [STRIPE WEBHOOK] User ID:', userId);
            throw new Error('No valid stories found');
          }

          // Use first story ID as the primary for orders table (for backwards compatibility)
          const primaryStoryId = validatedStoryIds[0];

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

          console.log('💾 [STRIPE WEBHOOK] Order saved to database');
          console.log('   User ID:', userId);
          console.log('   Story IDs:', validatedStoryIds.join(', '));

          // Trigger background PDF generation and print provider order (don't await - fire and forget)
          // Pass isTestPayment so Gelato knows whether to create draft or real order
          // Now passing array of storyIds for combined book generation
          processBookOrder(fullSession.id, userId, validatedStoryIds, customerInfo, address, isTestPayment, orderCoverType).catch(async (err) => {
            console.error('❌ [BACKGROUND] Error processing book order:', err);
            console.error('   Error stack:', err.stack);
            console.error('   Session ID:', fullSession.id);
            console.error('   User ID:', userId);
            console.error('   Story IDs:', validatedStoryIds.join(', '));
            console.error('   CRITICAL: Customer paid but book order failed! Check database for stripe_session_id:', fullSession.id);

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
            console.warn('⚠️ Could not get language for order email:', e.message);
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
          ).catch(err => console.error('❌ Failed to send order confirmation email:', err));

          console.log('🚀 [STRIPE WEBHOOK] Background processing triggered - customer can leave');
        } else {
          console.warn('⚠️  [STRIPE WEBHOOK] Payment received but STORAGE_MODE is not "database" - order not processed!');
          console.warn('   Current STORAGE_MODE:', STORAGE_MODE);
          console.warn('   Session ID:', fullSession.id);
          console.warn('   Amount:', fullSession.amount_total, fullSession.currency);
          console.warn('   This payment succeeded but the customer will NOT receive their book!');
        }

      } catch (retrieveError) {
        console.error('❌ [STRIPE WEBHOOK] Error retrieving/storing session details:', retrieveError);
        console.error('   Error stack:', retrieveError.stack);
        console.error('   Session ID:', session.id);
        console.error('   This payment succeeded but order processing failed!');
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ [STRIPE WEBHOOK] Error processing webhook:', err);
    res.status(400).json({ error: 'Webhook error' });
  }
});

// Gelato webhook endpoint for order status updates
// IMPORTANT: This MUST be defined BEFORE express.json() middleware
app.post('/api/gelato/webhook', express.json(), async (req, res) => {
  try {
    // Verify webhook authorization
    const webhookSecret = process.env.GELATO_WEBHOOK_SECRET;
    const receivedSecret = req.headers['x-gelato-webhook-secret'];

    if (webhookSecret && receivedSecret !== webhookSecret) {
      console.warn('⚠️ [GELATO WEBHOOK] Invalid or missing authorization header');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body;

    console.log('📦 [GELATO WEBHOOK] Received event:', event.event);
    console.log('   Order ID:', event.orderId);
    console.log('   Order Reference:', event.orderReferenceId);
    console.log('   Status:', event.fulfillmentStatus);

    // Handle different event types
    if (event.event === 'order_status_updated') {
      const { orderId, orderReferenceId, fulfillmentStatus, items } = event;

      // Find the order in our database using Gelato order ID
      const orderResult = await dbPool.query(
        'SELECT id, user_id, customer_email, customer_name, story_id FROM orders WHERE gelato_order_id = $1',
        [orderId]
      );

      if (orderResult.rows.length === 0) {
        console.warn('⚠️ [GELATO WEBHOOK] Order not found for Gelato ID:', orderId);
        // Still return 200 to prevent retries
        return res.status(200).json({ received: true, warning: 'Order not found' });
      }

      const order = orderResult.rows[0];
      console.log('   Found order ID:', order.id);
      console.log('   Customer:', order.customer_email);

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
        console.log('   Tracking:', trackingNumber);
        console.log('   Tracking URL:', trackingUrl);
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
          console.error('❌ [GELATO WEBHOOK] Failed to send shipped email:', emailErr.message);
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
    console.error('❌ [GELATO WEBHOOK] Error processing webhook:', err);
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
  console.log('📦 Serving built React app from dist/');
} else {
  // Fallback to legacy: serve files from project root (index.html with Babel)
  app.use(express.static(__dirname));
  console.log('📦 Serving legacy HTML files (no dist/ folder found)');
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

console.log('📦 Modular routes loaded: config, health, auth, user, characters, story-draft, stories, files, admin');

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
    console.log('Data directory already exists');
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
    console.log('⚠️  No database pool - skipping database initialization');
    return;
  }

  try {
    // Test connection first
    await dbPool.query('SELECT 1');
    console.log('✓ Database connection successful');

    // PostgreSQL table creation
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
        preferred_language VARCHAR(20) DEFAULT 'English'
      )
    `);

    // Add last_login column if it doesn't exist
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_login') THEN
          ALTER TABLE users ADD COLUMN last_login TIMESTAMP;
        END IF;
      END $$;
    `);

    // Add preferred_language column if it doesn't exist
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='preferred_language') THEN
          ALTER TABLE users ADD COLUMN preferred_language VARCHAR(20) DEFAULT 'English';
        END IF;
      END $$;
    `);

    // Add credits column to existing users table if it doesn't exist
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='credits') THEN
          ALTER TABLE users ADD COLUMN credits INT DEFAULT 500;
        END IF;
      END $$;
    `);

    // Update existing users with NULL credits: admins get -1 (unlimited), users get 1000
    await dbPool.query(`
      UPDATE users SET credits = -1 WHERE credits IS NULL AND role = 'admin';
    `);
    await dbPool.query(`
      UPDATE users SET credits = 1000 WHERE credits IS NULL AND role = 'user';
    `);

    // Add email verification columns
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email_verified') THEN
          ALTER TABLE users ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
        END IF;
      END $$;
    `);
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email_verification_token') THEN
          ALTER TABLE users ADD COLUMN email_verification_token VARCHAR(255);
        END IF;
      END $$;
    `);
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='email_verification_expires') THEN
          ALTER TABLE users ADD COLUMN email_verification_expires TIMESTAMP;
        END IF;
      END $$;
    `);

    // Add password reset columns
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_reset_token') THEN
          ALTER TABLE users ADD COLUMN password_reset_token VARCHAR(255);
        END IF;
      END $$;
    `);
    await dbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='password_reset_expires') THEN
          ALTER TABLE users ADD COLUMN password_reset_expires TIMESTAMP;
        END IF;
      END $$;
    `);

    // Mark existing users as email verified (they registered before this feature)
    await dbPool.query(`
      UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL;
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

    console.log('✓ Database tables initialized');

    // Run database migrations
    try {
      const { runMigrations } = require('./run-migrations');
      await runMigrations(dbPool, 'postgresql');
    } catch (err) {
      console.error('⚠️  Migration warning:', err.message);
      // Don't fail initialization if migrations fail
    }

  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    console.error('Error code:', err.code);
    if (err.sql) console.error('SQL:', err.sql);
    throw err; // Re-throw to be caught by initialization
  }
}

// Helper functions for file operations
async function readJSON(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
    return [];
  }
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Logging function
async function logActivity(userId, username, action, details) {
  if (STORAGE_MODE === 'database' && dbPool) {
    try {
      const insertQuery = 'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)';
      await dbQuery(insertQuery, [userId, username, action, JSON.stringify(details)]);
    } catch (err) {
      console.error('Log error:', err);
    }
  } else {
    const logs = await readJSON(LOGS_FILE);
    logs.push({
      timestamp: new Date().toISOString(),
      userId,
      username,
      action,
      details
    });
    await writeJSON(LOGS_FILE, logs);
  }
}

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

// =============================================================================
// AUTH ROUTES - MIGRATED TO server/routes/auth.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let newUser;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      // Check if user already exists
      const existingQuery = 'SELECT id FROM users WHERE username = $1';
      const existing = await dbQuery(existingQuery, [username]);

      if (existing.length > 0) {
        return res.status(400).json({ error: 'This email is already registered' });
      }

      // Check if this is the first user (will be admin)
      const userCount = await dbQuery('SELECT COUNT(*) as count FROM users', []);
      const isFirstUser = userCount[0].count === 0;

      const userId = Date.now().toString();
      const role = isFirstUser ? 'admin' : 'user';
      const storyQuota = isFirstUser ? -1 : 2;
      const initialCredits = isFirstUser ? -1 : 500;

      const insertQuery = 'INSERT INTO users (id, username, email, password, role, story_quota, stories_generated, credits) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
      await dbQuery(insertQuery, [userId, username, username, hashedPassword, role, storyQuota, 0, initialCredits]);

      // Create initial credit transaction record
      if (initialCredits > 0) {
        await dbQuery(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, initialCredits, initialCredits, 'initial', 'Welcome credits for new account']
        );
      }

      newUser = {
        id: userId,
        username,
        email: username,
        role,
        storyQuota,
        storiesGenerated: 0,
        credits: initialCredits
      };
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);

      // Check if user already exists
      if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'This email is already registered' });
      }

      const isFirstUser = users.length === 0;
      newUser = {
        id: Date.now().toString(),
        username,
        email: username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        role: isFirstUser ? 'admin' : 'user',
        storyQuota: isFirstUser ? -1 : 2,
        storiesGenerated: 0,
        credits: isFirstUser ? -1 : 500
      };

      users.push(newUser);
      await writeJSON(USERS_FILE, users);
    }

    await logActivity(newUser.id, username, 'USER_REGISTERED', { email });

    // Send verification email for new users (non-admin)
    let emailVerified = false;
    if (STORAGE_MODE === 'database' && newUser.role !== 'admin') {
      try {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        await dbQuery(
          'UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3',
          [verificationToken, verificationExpires, newUser.id]
        );

        const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
        await email.sendEmailVerificationEmail(username, username, verifyUrl);
        console.log(`📧 Verification email sent to: ${username}`);
      } catch (emailErr) {
        console.error('Failed to send verification email:', emailErr.message);
        // Don't fail registration if email fails - user can request resend
      }
    } else if (newUser.role === 'admin') {
      // First user (admin) is auto-verified
      emailVerified = true;
      if (STORAGE_MODE === 'database') {
        await dbQuery('UPDATE users SET email_verified = TRUE WHERE id = $1', [newUser.id]);
      }
    }

    // Generate token
    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, role: newUser.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

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

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    let user;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT * FROM users WHERE username = $1';
      const rows = await dbQuery(selectQuery, [username]);

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
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
        emailVerified: dbUser.email_verified !== false
      };
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      user = users.find(u => u.username === username);

      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await logActivity(user.id, username, 'USER_LOGIN', {});

    // Update last_login timestamp
    if (STORAGE_MODE === 'database' && dbPool) {
      await dbQuery('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${user.username} (role: ${user.role})`);
    log.warn(`TEST LOG - If you see this, logs are working!`);

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
        emailVerified: user.emailVerified !== false
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current user info (for refreshing credits, etc.)
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    let user;

    if (STORAGE_MODE === 'database' && dbPool) {
      const rows = await dbQuery('SELECT * FROM users WHERE id = $1', [userId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const dbUser = rows[0];
      user = {
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email,
        role: dbUser.role,
        storyQuota: dbUser.story_quota,
        storiesGenerated: dbUser.stories_generated,
        credits: dbUser.credits !== undefined ? dbUser.credits : 500,
        preferredLanguage: dbUser.preferred_language || 'English',
        emailVerified: dbUser.email_verified !== false
      };
    } else {
      const users = await readJSON(USERS_FILE);
      user = users.find(u => u.id === userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 2,
        storiesGenerated: user.storiesGenerated || 0,
        credits: user.credits != null ? user.credits : 500,
        preferredLanguage: user.preferredLanguage || 'English',
        emailVerified: user.emailVerified !== false
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Firebase Authentication (Google, Apple, etc.)
app.post('/api/auth/firebase', authLimiter, async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'ID token required' });
    }

    // Check if Firebase Admin is initialized
    if (!admin.apps.length) {
      return res.status(500).json({ error: 'Firebase authentication not configured on server' });
    }

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email: firebaseEmail, name, picture } = decodedToken;

    // Use email as username, fall back to uid if no email
    const username = firebaseEmail || `firebase_${uid}`;
    const displayName = name || username.split('@')[0];

    if (STORAGE_MODE === 'database' && dbPool) {
      // Check if user exists
      const existingUser = await dbQuery('SELECT * FROM users WHERE username = $1', [username]);

      let user;
      if (existingUser.length > 0) {
        // User exists - log them in
        user = existingUser[0];
        await logActivity(user.id, username, 'USER_LOGIN_FIREBASE', { provider: decodedToken.firebase?.sign_in_provider });
      } else {
        // Create new user
        const userCount = await dbQuery('SELECT COUNT(*) as count FROM users', []);
        const isFirstUser = parseInt(userCount[0].count) === 0;
        const role = isFirstUser ? 'admin' : 'user';
        const storyQuota = isFirstUser ? 999 : 2;
        const initialCredits = isFirstUser ? -1 : 500;

        // Generate a random password (user won't need it - they use Firebase)
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        const insertQuery = `
          INSERT INTO users (username, email, password, role, story_quota, stories_generated, credits)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, username, email, role, story_quota, stories_generated, credits
        `;
        const result = await dbQuery(insertQuery, [username, firebaseEmail, hashedPassword, role, storyQuota, 0, initialCredits]);
        user = result[0];

        // Create initial credit transaction record
        if (initialCredits > 0) {
          await dbQuery(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
             VALUES ($1, $2, $3, $4, $5)`,
            [user.id, initialCredits, initialCredits, 'initial', 'Welcome credits for new account']
          );
        }

        await logActivity(user.id, username, 'USER_REGISTERED_FIREBASE', { provider: decodedToken.firebase?.sign_in_provider });
        console.log(`✅ New Firebase user registered: ${username} (role: ${role})`);
      }

      // Update last_login timestamp
      await dbQuery('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

      // Generate JWT token (same as regular login)
      const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

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
          emailVerified: user.email_verified !== false // Firebase users are considered verified
        }
      });
    } else {
      // File mode - not supported for Firebase auth
      return res.status(400).json({ error: 'Firebase auth requires database mode' });
    }
  } catch (err) {
    console.error('Firebase auth error:', err);
    if (err.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    if (err.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    res.status(500).json({ error: 'Firebase authentication failed' });
  }
});

// Password reset - request reset link
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (STORAGE_MODE === 'database') {
      // Find user by email
      const result = await dbPool.query(
        'SELECT id, username, email FROM users WHERE email = $1 OR username = $1',
        [email.toLowerCase()]
      );

      // Always return success to prevent email enumeration
      if (result.rows.length === 0) {
        return res.json({ success: true, message: 'If this email exists, a reset link has been sent' });
      }

      const user = result.rows[0];

      // Generate reset token
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Store token in database
      await dbPool.query(
        'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE id = $3',
        [resetToken, resetExpires, user.id]
      );

      // Send reset email
      const resetUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/reset-password/${resetToken}`;
      console.log(`📧 Sending password reset email to ${user.email}...`);
      const emailResult = await email.sendPasswordResetEmail(user.email, user.username, resetUrl);

      if (!emailResult) {
        console.error('❌ Failed to send password reset email - email service returned null');
        // Still return success to prevent email enumeration
      } else {
        console.log(`✅ Password reset email sent to ${user.email}`);
      }

      res.json({ success: true, message: 'If this email exists, a reset link has been sent' });
    } else {
      res.status(400).json({ error: 'Password reset requires database mode' });
    }
  } catch (err) {
    console.error('Password reset error:', err);
    res.status(500).json({ error: 'Failed to process password reset' });
  }
});

// Password reset - confirm new password
app.post('/api/auth/reset-password/confirm', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (STORAGE_MODE === 'database') {
      // Find user by reset token
      const result = await dbPool.query(
        'SELECT id, email FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      const user = result.rows[0];

      // Hash new password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Update password and clear reset token
      await dbPool.query(
        'UPDATE users SET password = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2',
        [hashedPassword, user.id]
      );

      res.json({ success: true, message: 'Password has been reset successfully' });
    } else {
      res.status(400).json({ error: 'Password reset requires database mode' });
    }
  } catch (err) {
    console.error('Password reset confirm error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Change password (authenticated user)
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    if (STORAGE_MODE === 'database') {
      // Get current user with password
      const result = await dbPool.query(
        'SELECT id, password, firebase_uid FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = result.rows[0];

      // Check if user signed up with Google (no password set)
      if (user.firebase_uid && !user.password) {
        return res.status(400).json({ error: 'Cannot change password for Google accounts. Please use Google to sign in.' });
      }

      // Verify current password
      const validPassword = await bcrypt.compare(currentPassword, user.password);
      if (!validPassword) {
        return res.status(400).json({ error: 'Current password is incorrect' });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await dbPool.query(
        'UPDATE users SET password = $1 WHERE id = $2',
        [hashedPassword, userId]
      );

      res.json({ success: true, message: 'Password changed successfully' });
    } else {
      res.status(400).json({ error: 'Password change requires database mode' });
    }
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Send email verification
app.post('/api/auth/send-verification', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (STORAGE_MODE === 'database') {
      // Get user
      const result = await dbPool.query(
        'SELECT id, username, email, email_verified FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = result.rows[0];

      if (user.email_verified) {
        return res.json({ success: true, message: 'Email already verified' });
      }

      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Store token in database
      await dbPool.query(
        'UPDATE users SET email_verification_token = $1, email_verification_expires = $2 WHERE id = $3',
        [verificationToken, verificationExpires, user.id]
      );

      // Send verification email
      const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
      console.log(`📧 Sending verification email to ${user.email}...`);
      const emailResult = await email.sendEmailVerificationEmail(user.email, user.username, verifyUrl);

      if (!emailResult) {
        console.error('❌ Failed to send verification email - email service returned null');
        return res.status(500).json({ error: 'Failed to send verification email. Please try again later.' });
      }

      console.log(`✅ Verification email sent to ${user.email}`);
      res.json({ success: true, message: 'Verification email sent' });
    } else {
      res.status(400).json({ error: 'Email verification requires database mode' });
    }
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ error: 'Failed to send verification email' });
  }
});

// Verify email with token
app.get('/api/auth/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;

    if (STORAGE_MODE === 'database') {
      // Find user by verification token
      const result = await dbPool.query(
        'SELECT id, email FROM users WHERE email_verification_token = $1 AND email_verification_expires > NOW()',
        [token]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired verification token' });
      }

      const user = result.rows[0];

      // Mark email as verified and clear token
      await dbPool.query(
        'UPDATE users SET email_verified = TRUE, email_verification_token = NULL, email_verification_expires = NULL WHERE id = $1',
        [user.id]
      );

      // Redirect to success page
      res.redirect(`${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/email-verified`);
    } else {
      res.status(400).json({ error: 'Email verification requires database mode' });
    }
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// Change email (requires re-verification)
app.post('/api/auth/change-email', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { newEmail, password } = req.body;

    if (!newEmail || !password) {
      return res.status(400).json({ error: 'New email and current password are required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (STORAGE_MODE === 'database') {
      // Get current user with password
      const result = await dbPool.query(
        'SELECT id, username, email, password FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = result.rows[0];

      // Verify current password
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      // Check if new email is already taken
      const existingEmail = await dbPool.query(
        'SELECT id FROM users WHERE (email = $1 OR username = $1) AND id != $2',
        [newEmail.toLowerCase(), userId]
      );

      if (existingEmail.rows.length > 0) {
        return res.status(400).json({ error: 'This email is already registered' });
      }

      // Generate new verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      // Update email and set to unverified
      await dbPool.query(
        `UPDATE users SET
          email = $1,
          username = $1,
          email_verified = FALSE,
          email_verification_token = $2,
          email_verification_expires = $3
        WHERE id = $4`,
        [newEmail.toLowerCase(), verificationToken, verificationExpires, userId]
      );

      // Send verification email to new address
      const verifyUrl = `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}/api/auth/verify-email/${verificationToken}`;
      await email.sendEmailVerificationEmail(newEmail, user.username, verifyUrl);

      res.json({
        success: true,
        message: 'Email changed. Please verify your new email address.',
        newEmail: newEmail.toLowerCase()
      });
    } else {
      res.status(400).json({ error: 'Email change requires database mode' });
    }
  } catch (err) {
    console.error('Change email error:', err);
    res.status(500).json({ error: 'Failed to change email' });
  }
});

// Get email verification status
app.get('/api/auth/verification-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    if (STORAGE_MODE === 'database') {
      const result = await dbPool.query(
        'SELECT email_verified FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ emailVerified: result.rows[0].email_verified });
    } else {
      // In file mode, assume verified
      res.json({ emailVerified: true });
    }
  } catch (err) {
    console.error('Verification status error:', err);
    res.status(500).json({ error: 'Failed to check verification status' });
  }
});

// Dev auto-login (file mode only - for local development)
app.post('/api/auth/dev-login', async (req, res) => {
  try {
    // Only allow in file mode
    if (STORAGE_MODE === 'database') {
      return res.status(403).json({ error: 'Dev login only available in file mode' });
    }

    // Get first admin user or create one
    const users = await readJSON(USERS_FILE);
    let user = users.find(u => u.role === 'admin');

    if (!user) {
      // Create a dev admin user
      const hashedPassword = await bcrypt.hash('admin', 10);
      user = {
        id: Date.now(),
        username: 'admin@local.dev',
        email: 'admin@local.dev',
        password: hashedPassword,
        role: 'admin',
        storyQuota: 999,
        storiesGenerated: 0,
        createdAt: new Date().toISOString()
      };
      users.push(user);
      await writeJSON(USERS_FILE, users);
    }

    // Generate token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }  // Longer expiration for dev
    );

    log.debug(`🔧 Dev auto-login: ${user.username} (role: ${user.role})`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 999,
        storiesGenerated: user.storiesGenerated || 0
      }
    });
  } catch (err) {
    console.error('Dev login error:', err);
    res.status(500).json({ error: 'Dev login failed' });
  }
});
END OF AUTH ROUTES */

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
    console.error('Config update error:', err);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

// Proxy endpoint for Claude API
app.post('/api/claude', authenticateToken, async (req, res) => {
  console.log('📖 === CLAUDE/ANTHROPIC ENDPOINT CALLED ===');
  console.log(`  User: ${req.user?.username || 'unknown'}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    console.log('🔑 Anthropic API key check:');
    console.log(`  From env: ${anthropicApiKey ? 'SET (length: ' + anthropicApiKey.length + ', starts with: ' + anthropicApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!anthropicApiKey) {
      const config = await readJSON(CONFIG_FILE);
      anthropicApiKey = config.anthropicApiKey;
      console.log(`  From config file: ${anthropicApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!anthropicApiKey) {
      console.log('  ❌ No API key found!');
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
      console.error('Claude API error response:', JSON.stringify(data, null, 2));
      const errorMsg = data.error?.message || data.error?.type || JSON.stringify(data.error) || 'Claude API request failed';
      throw new Error(errorMsg);
    }

    // Log token usage
    if (data.usage) {
      console.log('📊 Token Usage:');
      console.log(`  Input tokens:  ${data.usage.input_tokens.toLocaleString()}`);
      console.log(`  Output tokens: ${data.usage.output_tokens.toLocaleString()}`);
      console.log(`  Total tokens:  ${(data.usage.input_tokens + data.usage.output_tokens).toLocaleString()}`);
      console.log(`  Max requested: ${max_tokens?.toLocaleString() || 'default'}`);

      // Warn if output limit was reached
      if (data.stop_reason === 'max_tokens') {
        console.warn('⚠️  WARNING: Output was truncated - max_tokens limit reached!');
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Claude API error:', err.message);
    console.error('Full error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Claude API' });
  }
});

// Proxy endpoint for Gemini API
app.post('/api/gemini', authenticateToken, async (req, res) => {
  console.log('🎨 === GEMINI ENDPOINT CALLED ===');
  console.log(`  User: ${req.user?.username || 'unknown'}`);
  console.log(`  Time: ${new Date().toISOString()}`);

  try {
    // Prioritize environment variable, fallback to config file
    let geminiApiKey = process.env.GEMINI_API_KEY;

    console.log('🔑 Gemini API key check:');
    console.log(`  From env: ${geminiApiKey ? 'SET (length: ' + geminiApiKey.length + ', starts with: ' + geminiApiKey.substring(0, 6) + ')' : 'NOT SET'}`);

    if (!geminiApiKey) {
      const config = await readJSON(CONFIG_FILE);
      geminiApiKey = config.geminiApiKey;
      console.log(`  From config file: ${geminiApiKey ? 'SET' : 'NOT SET'}`);
    }

    if (!geminiApiKey) {
      console.log('  ❌ No API key found!');
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
      console.error('❌ Gemini API error response:');
      console.error('  Status:', response.status);
      console.error('  Response:', JSON.stringify(data, null, 2));
      console.error('  Request URL:', url.substring(0, 100) + '...');
      console.error('  Model:', model || 'gemini-2.5-flash-image');
      throw new Error(data.error?.message || `Gemini API request failed: ${response.status}`);
    }

    res.json(data);
  } catch (err) {
    console.error('Gemini API error:', err);
    res.status(500).json({ error: err.message || 'Failed to call Gemini API' });
  }
});

// =============================================================================
// ADMIN ROUTES - MIGRATED TO server/routes/admin.js
// NOTE: /api/admin/logs kept here (uses local readJSON)
// NOTE: /api/admin/orders/:orderId/retry-print-order kept here (uses Gelato)
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
app.get('/api/admin/logs', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const logs = await readJSON(LOGS_FILE);
    const limit = parseInt(req.query.limit) || 100;

    res.json(logs.slice(-limit).reverse()); // Return most recent logs first
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/api/admin/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    let safeUsers;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - include order counts with JOIN
      const selectQuery = `
        SELECT
          u.id, u.username, u.email, u.role, u.story_quota, u.stories_generated, u.credits, u.created_at, u.last_login, u.email_verified,
          COALESCE(order_stats.total_orders, 0) as total_orders,
          COALESCE(order_stats.failed_orders, 0) as failed_orders
        FROM users u
        LEFT JOIN (
          SELECT
            user_id,
            COUNT(*) as total_orders,
            COUNT(*) FILTER (WHERE payment_status = 'paid' AND gelato_order_id IS NULL) as failed_orders
          FROM orders
          GROUP BY user_id
        ) order_stats ON u.id::text = order_stats.user_id
        ORDER BY u.created_at ASC
      `;
      const rows = await dbQuery(selectQuery, []);
      safeUsers = rows.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        credits: user.credits != null ? user.credits : 500,
        createdAt: user.created_at,
        lastLogin: user.last_login,
        emailVerified: user.email_verified !== false,
        totalOrders: parseInt(user.total_orders) || 0,
        failedOrders: parseInt(user.failed_orders) || 0
      }));
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      safeUsers = users.map(({ password, ...user }) => ({
        ...user,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 2,
        storiesGenerated: user.storiesGenerated || 0,
        credits: user.credits != null ? user.credits : 500,
        totalOrders: 0,
        failedOrders: 0
      }));
    }

    res.json(safeUsers);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Update user credits (admin only)
app.post('/api/admin/users/:userId/quota', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;
    const { credits } = req.body;

    if (credits === undefined || (credits !== -1 && credits < 0)) {
      return res.status(400).json({ error: 'Invalid credits value. Use -1 for unlimited or a positive number.' });
    }

    let user;
    let previousCredits;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT * FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [userId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      previousCredits = rows[0].credits || 0;
      const creditDiff = credits - previousCredits;

      const updateQuery = 'UPDATE users SET credits = $1 WHERE id = $2';
      await dbQuery(updateQuery, [credits, userId]);

      // Create transaction record
      if (creditDiff !== 0) {
        const transactionType = creditDiff > 0 ? 'admin_add' : 'admin_deduct';
        const description = creditDiff > 0
          ? `Admin added ${creditDiff} credits`
          : `Admin deducted ${Math.abs(creditDiff)} credits`;

        await dbQuery(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, creditDiff, credits, transactionType, req.user.id, description]
        );
      }

      user = {
        id: rows[0].id,
        username: rows[0].username,
        credits: credits
      };
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      user = users.find(u => u.id === userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.credits = credits;
      await writeJSON(USERS_FILE, users);
    }

    await logActivity(req.user.id, req.user.username, 'USER_CREDITS_UPDATED', {
      targetUserId: userId,
      targetUsername: user.username,
      newCredits: credits
    });

    res.json({
      message: 'User credits updated successfully',
      user: {
        id: user.id,
        username: user.username,
        credits: user.credits
      }
    });
  } catch (err) {
    console.error('Error updating user credits:', err);
    res.status(500).json({ error: 'Failed to update user credits' });
  }
});

// ADMIN: Toggle user email verification status (for testing)
app.post('/api/admin/users/:userId/email-verified', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;
    const { emailVerified } = req.body;

    if (typeof emailVerified !== 'boolean') {
      return res.status(400).json({ error: 'emailVerified must be a boolean' });
    }

    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT id, username, email_verified FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [userId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = rows[0];
      const previousStatus = user.email_verified;

      await dbQuery('UPDATE users SET email_verified = $1 WHERE id = $2', [emailVerified, userId]);

      log.debug(`🔧 [ADMIN] Email verification for user ${user.username} changed: ${previousStatus} -> ${emailVerified}`);

      res.json({
        message: `Email verification status updated`,
        user: {
          id: user.id,
          username: user.username,
          emailVerified: emailVerified,
          previousStatus: previousStatus
        }
      });
    } else {
      return res.status(503).json({ error: 'This feature requires database mode' });
    }
  } catch (err) {
    console.error('Error updating email verification status:', err);
    res.status(500).json({ error: 'Failed to update email verification status' });
  }
});

// Get credit transaction history for a user (admin only)
app.get('/api/admin/users/:userId/credits', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const targetUserId = req.params.userId;
    const limit = parseInt(req.query.limit) || 50;

    log.info(`💳 [ADMIN] GET /api/admin/users/${targetUserId}/credits - Admin: ${req.user.username}`);

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database mode required for credit history' });
    }

    // Get user info
    const userResult = await dbPool.query(
      'SELECT username, email, credits FROM users WHERE id = $1',
      [targetUserId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get credit transactions
    const transactionsResult = await dbPool.query(
      `SELECT id, amount, balance_after, transaction_type, reference_id, description, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [targetUserId, limit]
    );

    res.json({
      user: {
        id: targetUserId,
        username: user.username,
        email: user.email,
        currentCredits: user.credits
      },
      transactions: transactionsResult.rows.map(t => ({
        id: t.id,
        amount: t.amount,
        balanceAfter: t.balance_after,
        type: t.transaction_type,
        referenceId: t.reference_id,
        description: t.description,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    console.error('Error fetching credit history:', err);
    res.status(500).json({ error: 'Failed to fetch credit history' });
  }
});

// Get detailed user info (admin only) - for user management
app.get('/api/admin/users/:userId/details', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const targetUserId = req.params.userId;
    log.info(`👤 [ADMIN] GET /api/admin/users/${targetUserId}/details - Admin: ${req.user.username}`);

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(400).json({ error: 'User details requires database mode' });
    }

    // Get user info
    const userResult = await dbQuery(
      'SELECT id, username, email, role, credits, story_quota, stories_generated, created_at, last_login FROM users WHERE id = $1',
      [targetUserId]
    );
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult[0];

    // Get story count and list - data is stored as TEXT containing JSON
    const storiesResult = await dbQuery(
      `SELECT id, data, created_at FROM stories WHERE user_id = $1 ORDER BY created_at DESC`,
      [targetUserId]
    );

    // Calculate totals by parsing JSON data
    let totalCharacters = 0;
    let totalImages = 0;
    // Token usage aggregation
    const totalTokens = {
      anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
    };
    const stories = storiesResult.map(s => {
      try {
        const storyData = typeof s.data === 'string' ? JSON.parse(s.data) : s.data;
        const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
        // Picture book (1st-grade): 1 scene = 1 page. Standard book: 1 scene = 2 pages (text + image)
        const isPictureBook = storyData?.languageLevel === '1st-grade';
        const scenePageCount = isPictureBook ? sceneCount : sceneCount * 2;
        // Add 3 pages for front cover, back cover, and initial page (title page)
        const pageCount = scenePageCount > 0 ? scenePageCount + 3 : 0;
        // Count scene images + cover images (front, back, spine)
        const sceneImageCount = storyData?.sceneImages?.length || 0;
        const coverImageCount = storyData?.coverImages ?
          (storyData.coverImages.frontCover ? 1 : 0) +
          (storyData.coverImages.backCover ? 1 : 0) +
          (storyData.coverImages.spine ? 1 : 0) : 0;
        const imageCount = sceneImageCount + coverImageCount;
        const charCount = storyData?.characters?.length || 0;
        totalImages += imageCount;
        totalCharacters += charCount;

        // Aggregate token usage
        if (storyData?.tokenUsage) {
          const tu = storyData.tokenUsage;
          for (const provider of ['anthropic', 'gemini_text', 'gemini_image', 'gemini_quality']) {
            if (tu[provider]) {
              totalTokens[provider].input_tokens += tu[provider].input_tokens || 0;
              totalTokens[provider].output_tokens += tu[provider].output_tokens || 0;
              totalTokens[provider].calls += tu[provider].calls || 0;
            }
          }
        }

        return {
          id: s.id,
          title: storyData?.title || storyData?.storyTitle || 'Untitled',
          createdAt: s.created_at,
          pageCount,
          imageCount
        };
      } catch {
        return {
          id: s.id,
          title: 'Untitled',
          createdAt: s.created_at,
          pageCount: 0,
          imageCount: 0
        };
      }
    });

    // Get purchase history (orders)
    const ordersResult = await dbQuery(
      `SELECT id, story_id, amount_total, currency, payment_status, gelato_order_id, created_at
       FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [targetUserId]
    );
    const purchases = ordersResult.map(o => ({
      id: o.id,
      storyId: o.story_id,
      amount: o.amount_total,
      currency: o.currency,
      status: o.payment_status,
      gelatoOrderId: o.gelato_order_id,
      createdAt: o.created_at
    }));

    // Get recent credit transactions
    const creditsResult = await dbQuery(
      `SELECT id, amount, balance_after, transaction_type, description, created_at
       FROM credit_transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [targetUserId]
    );
    const creditHistory = creditsResult.map(t => ({
      id: t.id,
      amount: t.amount,
      balanceAfter: t.balance_after,
      type: t.transaction_type,
      description: t.description,
      createdAt: t.created_at
    }));

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        credits: user.credits,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        createdAt: user.created_at,
        lastLogin: user.last_login
      },
      stats: {
        totalStories: stories.length,
        totalCharacters,
        totalImages,
        totalPurchases: purchases.filter(p => p.status === 'paid').length,
        totalSpent: purchases.filter(p => p.status === 'paid').reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0),
        tokenUsage: {
          ...totalTokens,
          totalInputTokens: Object.values(totalTokens).reduce((sum, p) => sum + p.input_tokens, 0),
          totalOutputTokens: Object.values(totalTokens).reduce((sum, p) => sum + p.output_tokens, 0),
          totalCalls: Object.values(totalTokens).reduce((sum, p) => sum + p.calls, 0)
        }
      },
      stories,
      purchases,
      creditHistory
    });
  } catch (err) {
    console.error('Error fetching user details:', err);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Get stories for any user (admin only) - for debugging/fixing crashed stories
app.get('/api/admin/users/:userId/stories', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const targetUserId = parseInt(req.params.userId);
    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`📚 [ADMIN] GET /api/admin/users/${targetUserId}/stories - Admin: ${req.user.username}`);
    let userStories = [];

    if (STORAGE_MODE === 'database' && dbPool) {
      // Get user info first
      const userResult = await dbQuery('SELECT username FROM users WHERE id = $1', [targetUserId]);
      if (userResult.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const targetUsername = userResult[0].username;

      // Get stories for target user
      const selectQuery = 'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC';
      const rows = await dbQuery(selectQuery, [targetUserId]);

      // Return full-quality thumbnails
      userStories = rows.map(row => {
        const story = JSON.parse(row.data);
        return {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
          pageCount: story.sceneImages?.length || 0,
          thumbnail: (story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null)
        };
      });

      log.info(`📚 [ADMIN] Found ${userStories.length} stories for user ${targetUsername} (ID: ${targetUserId})`);
      res.json({ userId: targetUserId, username: targetUsername, stories: userStories });
    } else {
      // File mode - return full-quality thumbnails
      const allStories = await readJSON(STORIES_FILE);
      const fullStories = allStories[targetUserId] || [];

      userStories = fullStories.map(story => ({
        id: story.id,
        title: story.title,
        createdAt: story.createdAt,
        updatedAt: story.updatedAt,
        pages: story.pages,
        language: story.language,
        characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
        pageCount: story.sceneImages?.length || 0,
        thumbnail: (story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null)
      }));

      log.info(`📚 [ADMIN] File mode: Found ${userStories.length} stories for user ${targetUserId}`);
      res.json({ userId: targetUserId, stories: userStories });
    }
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching user stories:', err);
    res.status(500).json({ error: 'Failed to fetch user stories', details: err.message });
  }
});

// Get single story for any user (admin only) - full data including images
app.get('/api/admin/users/:userId/stories/:storyId', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const targetUserId = parseInt(req.params.userId);
    const storyId = req.params.storyId;

    if (isNaN(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    log.info(`📖 [ADMIN] GET /api/admin/users/${targetUserId}/stories/${storyId} - Admin: ${req.user.username}`);

    let story = null;

    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT data FROM stories WHERE id = $1 AND user_id = $2';
      const rows = await dbQuery(selectQuery, [storyId, targetUserId]);

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      const allStories = await readJSON(STORIES_FILE);
      const userStories = allStories[targetUserId] || [];
      story = userStories.find(s => s.id === storyId);
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    log.info(`📖 [ADMIN] Returning story "${story.title}" for user ${targetUserId}`);
    res.json(story);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching story:', err);
    res.status(500).json({ error: 'Failed to fetch story', details: err.message });
  }
});

// =======================
// Print Provider Products Admin Endpoints
// =======================

// Get all print provider products (admin only)
app.get('/api/admin/print-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const selectQuery = 'SELECT * FROM gelato_products ORDER BY created_at DESC';
    const products = await dbQuery(selectQuery, []);

    res.json({ products });
  } catch (err) {
    console.error('Error fetching print provider products:', err);
    res.status(500).json({ error: 'Failed to fetch print provider products' });
  }
});

// Create new print provider product (admin only)
app.post('/api/admin/print-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
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

    // Validate required fields
    if (!product_uid || !product_name || min_pages === undefined || max_pages === undefined) {
      return res.status(400).json({ error: 'Missing required fields: product_uid, product_name, min_pages, max_pages' });
    }

    // Validate JSON format for available_page_counts
    let pageCounts;
    try {
      pageCounts = typeof available_page_counts === 'string'
        ? JSON.parse(available_page_counts)
        : available_page_counts;
      if (!Array.isArray(pageCounts)) {
        throw new Error('Must be an array');
      }
    } catch (err) {
      return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
    }

    const insertQuery = `INSERT INTO gelato_products
         (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`;

    const pageCountsJson = JSON.stringify(pageCounts);
    const params = [
      product_uid,
      product_name,
      description || null,
      size || null,
      cover_type || null,
      min_pages,
      max_pages,
      pageCountsJson,
      is_active !== false
    ];

    const result = await dbQuery(insertQuery, params);

    // For MySQL, fetch the inserted record
    let newProduct;
    newProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_CREATED', {
      productId: newProduct.id,
      productName: product_name
    });

    res.json({ product: newProduct, message: 'Product created successfully' });
  } catch (err) {
    console.error('Error creating print provider product:', err);
    res.status(500).json({ error: 'Failed to create print provider product' });
  }
});

// Update print provider product (admin only)
app.put('/api/admin/print-products/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update query based on provided fields
    const allowedFields = ['product_uid', 'product_name', 'description', 'size', 'cover_type', 'min_pages', 'max_pages', 'available_page_counts', 'is_active'];
    const setClauses = [];
    const params = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        let value = updates[field];

        // Handle available_page_counts JSON validation
        if (field === 'available_page_counts') {
          try {
            const pageCounts = typeof value === 'string' ? JSON.parse(value) : value;
            if (!Array.isArray(pageCounts)) {
              throw new Error('Must be an array');
            }
            value = JSON.stringify(pageCounts);
          } catch (err) {
            return res.status(400).json({ error: 'available_page_counts must be a valid JSON array' });
          }
        }

        setClauses.push(`${field} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);

    const updateQuery = `UPDATE gelato_products SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

    const result = await dbQuery(updateQuery, params);

    // PostgreSQL RETURNING clause returns the updated record
    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_UPDATED', {
      productId: id,
      productName: updatedProduct.product_name
    });

    res.json({ product: updatedProduct, message: 'Product updated successfully' });
  } catch (err) {
    console.error('Error updating print provider product:', err);
    res.status(500).json({ error: 'Failed to update print provider product' });
  }
});

// Toggle product active status (admin only)
app.put('/api/admin/print-products/:id/toggle', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;
    const { is_active } = req.body;

    const updateQuery = 'UPDATE gelato_products SET is_active = $1 WHERE id = $2 RETURNING *';

    const result = await dbQuery(updateQuery, [!is_active, id]);

    // PostgreSQL RETURNING clause returns the updated record
    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_TOGGLED', {
      productId: id,
      isActive: !is_active
    });

    res.json({ product: updatedProduct, message: 'Product status updated successfully' });
  } catch (err) {
    console.error('Error toggling print provider product status:', err);
    res.status(500).json({ error: 'Failed to toggle product status' });
  }
});

// Delete print provider product (admin only)
app.delete('/api/admin/print-products/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for print provider products management' });
    }

    const { id } = req.params;

    // Get product name before deleting for logging
    const selectQuery = 'SELECT product_name FROM gelato_products WHERE id = $1';
    const rows = await dbQuery(selectQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productName = rows[0].product_name;

    const deleteQuery = 'DELETE FROM gelato_products WHERE id = $1';

    await dbQuery(deleteQuery, [id]);

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_DELETED', {
      productId: id,
      productName: productName
    });

    res.json({ message: 'Product deleted successfully' });
  } catch (err) {
    console.error('Error deleting print provider product:', err);
    res.status(500).json({ error: 'Failed to delete print provider product' });
  }
});
END OF ADMIN ROUTES BLOCK 1 */

// =============================================================================
// USER ROUTES - MIGRATED TO server/routes/user.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
app.get('/api/user/quota', authenticateToken, async (req, res) => {
  try {
    let credits;
    let preferredLanguage = 'English';

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT credits, preferred_language FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      credits = rows[0].credits !== undefined ? rows[0].credits : 500;
      preferredLanguage = rows[0].preferred_language || 'English';
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      const user = users.find(u => u.id === req.user.id);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      credits = user.credits != null ? user.credits : 500;
      preferredLanguage = user.preferredLanguage || 'English';
    }

    res.json({
      credits: credits,
      unlimited: credits === -1,
      preferredLanguage: preferredLanguage
    });
  } catch (err) {
    console.error('Error fetching user credits:', err);
    res.status(500).json({ error: 'Failed to fetch user credits' });
  }
});

// Get user's saved shipping address
app.get('/api/user/shipping-address', authenticateToken, async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT shipping_first_name, shipping_last_name, shipping_address_line1, shipping_city, shipping_post_code, shipping_country, shipping_email FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length === 0) {
        return res.json(null);
      }

      const user = rows[0];
      if (!user.shipping_first_name) {
        return res.json(null);
      }

      res.json({
        firstName: user.shipping_first_name,
        lastName: user.shipping_last_name,
        addressLine1: user.shipping_address_line1,
        city: user.shipping_city,
        postCode: user.shipping_post_code,
        country: user.shipping_country,
        email: user.shipping_email
      });
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      const user = users.find(u => u.id === req.user.id);

      if (!user || !user.shippingAddress) {
        return res.json(null);
      }

      res.json(user.shippingAddress);
    }
  } catch (err) {
    console.error('Error fetching shipping address:', err);
    res.status(500).json({ error: 'Failed to fetch shipping address' });
  }
});

// Save user's shipping address
app.put('/api/user/shipping-address', authenticateToken, async (req, res) => {
  try {
    let { firstName, lastName, addressLine1, city, postCode, country, email } = req.body;

    // Validate and normalize country code (must be 2-letter ISO code)
    if (!country || typeof country !== 'string') {
      return res.status(400).json({ error: 'Country code is required' });
    }

    country = country.trim().toUpperCase();

    if (country.length !== 2 || !/^[A-Z]{2}$/.test(country)) {
      return res.status(400).json({
        error: 'Country must be a valid 2-letter ISO code (e.g., US, DE, CH, FR)',
        hint: 'Please use the standard 2-letter country code'
      });
    }

    // Validate email format
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    email = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Please provide a valid email address',
        hint: 'Email format should be like: user@example.com'
      });
    }

    // Validate required fields
    if (!firstName || !lastName || !addressLine1 || !city || !postCode) {
      return res.status(400).json({ error: 'All address fields are required' });
    }

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const updateQuery = 'UPDATE users SET shipping_first_name = $1, shipping_last_name = $2, shipping_address_line1 = $3, shipping_city = $4, shipping_post_code = $5, shipping_country = $6, shipping_email = $7 WHERE id = $8';
      await dbQuery(updateQuery, [firstName, lastName, addressLine1, city, postCode, country, email, req.user.id]);

      await logActivity(req.user.id, req.user.username, 'SHIPPING_ADDRESS_SAVED', { country });
      res.json({ success: true });
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      const user = users.find(u => u.id === req.user.id);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.shippingAddress = { firstName, lastName, addressLine1, city, postCode, country, email };
      await writeJSON(USERS_FILE, users);

      await logActivity(req.user.id, req.user.username, 'SHIPPING_ADDRESS_SAVED', { country });
      res.json({ success: true });
    }
  } catch (err) {
    console.error('Error saving shipping address:', err);
    res.status(500).json({ error: 'Failed to save shipping address' });
  }
});

// Get user's orders
app.get('/api/user/orders', authenticateToken, async (req, res) => {
  try {
    log.debug(`📦 [USER] GET /api/user/orders - User: ${req.user.username}`);

    if (STORAGE_MODE === 'database' && dbPool) {
      const query = `
        SELECT
          o.id,
          o.story_id,
          o.customer_name,
          o.shipping_name,
          o.shipping_address_line1,
          o.shipping_city,
          o.shipping_postal_code,
          o.shipping_country,
          o.amount_total,
          o.currency,
          o.payment_status,
          o.gelato_status,
          o.tracking_number,
          o.tracking_url,
          o.created_at,
          o.shipped_at,
          o.delivered_at,
          s.data as story_data
        FROM orders o
        LEFT JOIN stories s ON o.story_id = s.id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
      `;
      const rows = await dbQuery(query, [req.user.id]);

      // Parse story data to get title
      const orders = rows.map(order => {
        let storyTitle = 'Untitled Story';
        if (order.story_data) {
          try {
            const storyData = JSON.parse(order.story_data);
            storyTitle = storyData.title || storyData.storyTitle || 'Untitled Story';
          } catch (e) {
            // Ignore parse errors
          }
        }

        return {
          id: order.id,
          storyId: order.story_id,
          storyTitle,
          customerName: order.customer_name,
          shippingName: order.shipping_name,
          shippingAddress: {
            line1: order.shipping_address_line1,
            city: order.shipping_city,
            postalCode: order.shipping_postal_code,
            country: order.shipping_country
          },
          amount: order.amount_total,
          currency: order.currency,
          paymentStatus: order.payment_status,
          orderStatus: order.gelato_status || 'processing',
          trackingNumber: order.tracking_number,
          trackingUrl: order.tracking_url,
          createdAt: order.created_at,
          shippedAt: order.shipped_at,
          deliveredAt: order.delivered_at
        };
      });

      // Fetch credit purchases
      const creditPurchasesQuery = `
        SELECT id, amount, balance_after, reference_id, description, created_at
        FROM credit_transactions
        WHERE user_id = $1 AND transaction_type = 'purchase'
        ORDER BY created_at DESC
      `;
      const creditRows = await dbQuery(creditPurchasesQuery, [req.user.id]);

      // Map credit purchases to order-like format
      const creditOrders = creditRows.map(tx => ({
        id: `credit-${tx.id}`,
        type: 'credits',
        creditsAmount: tx.amount,
        balanceAfter: tx.balance_after,
        description: tx.description,
        amount: Math.round((tx.amount / 100) * 500), // CHF 5 per 100 credits
        currency: 'chf',
        paymentStatus: 'paid',
        orderStatus: 'completed',
        createdAt: tx.created_at
      }));

      // Add type to book orders and combine
      const typedOrders = orders.map(o => ({ ...o, type: 'book' }));
      const allOrders = [...typedOrders, ...creditOrders].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      log.debug(`📦 [USER] Found ${orders.length} book orders and ${creditOrders.length} credit purchases`);
      res.json({ orders: allOrders });
    } else {
      // File mode - not implemented for orders
      res.json({ orders: [] });
    }
  } catch (err) {
    console.error('Error fetching user orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Update user's email address
app.put('/api/user/update-email', authenticateToken, async (req, res) => {
  try {
    const { newEmail } = req.body;

    if (!newEmail || !newEmail.includes('@')) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - check if email already exists
      const checkQuery = 'SELECT id FROM users WHERE username = $1 AND id != $2';
      const existing = await dbQuery(checkQuery, [newEmail, req.user.id]);

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      const updateQuery = 'UPDATE users SET username = $1 WHERE id = $2';
      await dbQuery(updateQuery, [newEmail, req.user.id]);

      await logActivity(req.user.id, newEmail, 'EMAIL_UPDATED', { oldEmail: req.user.username });
      res.json({ success: true, username: newEmail });
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      const existing = users.find(u => u.username === newEmail && u.id !== req.user.id);

      if (existing) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      const user = users.find(u => u.id === req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.username = newEmail;
      await writeJSON(USERS_FILE, users);

      await logActivity(req.user.id, newEmail, 'EMAIL_UPDATED', { oldEmail: req.user.username });
      res.json({ success: true, username: newEmail });
    }
  } catch (err) {
    console.error('Error updating email:', err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});
END OF USER ROUTES */

// =============================================================================
// CHARACTER ROUTES - MIGRATED TO server/routes/characters.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
app.get('/api/characters', authenticateToken, async (req, res) => {
  try {
    let characterData = {
      characters: [],
      relationships: {},
      relationshipTexts: {},
      customRelationships: [],
      customStrengths: [],
      customWeaknesses: [],
      customFears: []
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT data FROM characters WHERE user_id = $1 ORDER BY id DESC LIMIT 1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        // Handle both old format (array) and new format (object)
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = {
            ...characterData,
            ...data
          };
        }
      }
    } else {
      // File mode
      const allCharacters = await readJSON(CHARACTERS_FILE);
      const data = allCharacters[req.user.id];

      if (data) {
        // Handle both old format (array) and new format (object)
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = {
            ...characterData,
            ...data
          };
        }
      }
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_LOADED', { count: characterData.characters.length });
    res.json(characterData);
  } catch (err) {
    console.error('Error fetching characters:', err);
    res.status(500).json({ error: 'Failed to fetch characters' });
  }
});

app.post('/api/characters', authenticateToken, async (req, res) => {
  try {
    const { characters, relationships, relationshipTexts, customRelationships, customStrengths, customWeaknesses, customFears } = req.body;

    // Store character data as an object with all related information
    const characterData = {
      characters: characters || [],
      relationships: relationships || {},
      relationshipTexts: relationshipTexts || {},
      customRelationships: customRelationships || [],
      customStrengths: customStrengths || [],
      customWeaknesses: customWeaknesses || [],
      customFears: customFears || []
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - delete old characters and insert new ones
      const deleteQuery = 'DELETE FROM characters WHERE user_id = $1';
      await dbQuery(deleteQuery, [req.user.id]);

      // Insert character data as a single record with all information
      const characterId = `characters_${req.user.id}_${Date.now()}`;
      const insertQuery = 'INSERT INTO characters (id, user_id, data) VALUES ($1, $2, $3)';
      await dbQuery(insertQuery, [characterId, req.user.id, JSON.stringify(characterData)]);
    } else {
      // File mode - save all character data as an object
      const allCharacters = await readJSON(CHARACTERS_FILE);
      allCharacters[req.user.id] = characterData;
      await writeJSON(CHARACTERS_FILE, allCharacters);
    }

    await logActivity(req.user.id, req.user.username, 'CHARACTERS_SAVED', { count: characters.length });
    res.json({ message: 'Characters saved successfully', count: characters.length });
  } catch (err) {
    console.error('Error saving characters:', err);
    res.status(500).json({ error: 'Failed to save characters' });
  }
});
END OF CHARACTER ROUTES */

// =============================================================================
// STORY DRAFT ROUTES - MIGRATED TO server/routes/storyDraft.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
// Story draft endpoints - persist story settings before generation
// This saves step 1 (storyType, artStyle) and step 4 (storyDetails, dedication, pages, languageLevel, mainCharacters) data
app.get('/api/story-draft', authenticateToken, async (req, res) => {
  try {
    let draftData = {
      storyType: '',
      artStyle: 'pixar',
      storyDetails: '',
      dedication: '',
      pages: 30,
      languageLevel: 'standard',
      mainCharacters: []
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT data FROM story_drafts WHERE user_id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        draftData = { ...draftData, ...data };
      }
    } else {
      // File mode
      const allDrafts = await readJSON(STORY_DRAFTS_FILE);
      const data = allDrafts[req.user.id];

      if (data) {
        draftData = { ...draftData, ...data };
      }
    }

    res.json(draftData);
  } catch (err) {
    console.error('Error fetching story draft:', err);
    res.status(500).json({ error: 'Failed to fetch story draft' });
  }
});

app.post('/api/story-draft', authenticateToken, async (req, res) => {
  try {
    const { storyType, artStyle, storyDetails, dedication, pages, languageLevel, mainCharacters } = req.body;

    const draftData = {
      storyType: storyType || '',
      artStyle: artStyle || 'pixar',
      storyDetails: storyDetails || '',
      dedication: dedication || '',
      pages: pages || 30,
      languageLevel: languageLevel || 'standard',
      mainCharacters: mainCharacters || [],
      updatedAt: new Date().toISOString()
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      // Upsert - insert or update on conflict
      const upsertQuery = `
        INSERT INTO story_drafts (user_id, data, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP
      `;
      await dbQuery(upsertQuery, [req.user.id, JSON.stringify(draftData)]);
    } else {
      // File mode
      const allDrafts = await readJSON(STORY_DRAFTS_FILE);
      allDrafts[req.user.id] = draftData;
      await writeJSON(STORY_DRAFTS_FILE, allDrafts);
    }

    log.debug(`📝 [DRAFT] Saved story draft for user ${req.user.username}`);
    res.json({ message: 'Story draft saved successfully' });
  } catch (err) {
    console.error('Error saving story draft:', err);
    res.status(500).json({ error: 'Failed to save story draft' });
  }
});

// Clear story draft (called after successful story generation)
app.delete('/api/story-draft', authenticateToken, async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && dbPool) {
      await dbQuery('DELETE FROM story_drafts WHERE user_id = $1', [req.user.id]);
    } else {
      const allDrafts = await readJSON(STORY_DRAFTS_FILE);
      delete allDrafts[req.user.id];
      await writeJSON(STORY_DRAFTS_FILE, allDrafts);
    }

    log.debug(`🗑️ [DRAFT] Cleared story draft for user ${req.user.username}`);
    res.json({ message: 'Story draft cleared' });
  } catch (err) {
    console.error('Error clearing story draft:', err);
    res.status(500).json({ error: 'Failed to clear story draft' });
  }
});
END OF STORY DRAFT ROUTES */

// =============================================================================
// STORIES CRUD ROUTES - MIGRATED TO server/routes/stories.js
// Note: Regenerate/Edit routes are NOT migrated and remain active below
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
// Story management endpoints
app.get('/api/stories', authenticateToken, async (req, res) => {
  try {
    // Pagination: limit (default 6, max 50) and offset
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    log.debug(`📚 GET/api/stories - User: ${req.user.username}, limit: ${limit}, offset: ${offset}`);
    let userStories = [];
    let totalCount = 0;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - get total count first
      const countResult = await dbQuery('SELECT COUNT(*) as count FROM stories WHERE user_id = $1', [req.user.id]);
      totalCount = parseInt(countResult[0]?.count || 0);

      // Then get paginated data
      const selectQuery = 'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3';
      const rows = await dbQuery(selectQuery, [req.user.id, limit, offset]);
      log.trace(`📚 Query returned ${rows.length} rows (total: ${totalCount})`);

      // Parse the JSON data from each row - return metadata only (no images for performance)
      userStories = rows.map(row => {
        const story = JSON.parse(row.data);
        const hasThumbnail = !!(story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail);
        return {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
          pageCount: story.sceneImages?.length || 0,
          hasThumbnail, // Boolean flag - fetch actual thumbnail via /api/stories/:id/thumbnail
          // Partial story fields
          isPartial: story.isPartial || false,
          generatedPages: story.generatedPages,
          totalPages: story.totalPages
        };
      });
      log.trace(`📚 Parsed ${userStories.length} stories (metadata only, no images)`);

      if (userStories.length > 0) {
        log.trace(`📚 First story: ${userStories[0].title} (ID: ${userStories[0].id})`);
      }
    } else {
      // File mode
      const allStories = await readJSON(STORIES_FILE);
      const fullStories = allStories[req.user.id] || [];
      totalCount = fullStories.length;

      // Sort by createdAt descending, then paginate
      const sortedStories = [...fullStories].sort((a, b) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
      const paginatedStories = sortedStories.slice(offset, offset + limit);

      // Return metadata only (no images for performance)
      userStories = paginatedStories.map(story => {
        const hasThumbnail = !!(story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail);
        return {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
          pageCount: story.sceneImages?.length || 0,
          hasThumbnail, // Boolean flag - fetch actual cover via /api/stories/:id/cover
          // Partial story fields
          isPartial: story.isPartial || false,
          generatedPages: story.generatedPages,
          totalPages: story.totalPages
        };
      });
      console.log(`📚 File mode: Returning ${userStories.length} of ${totalCount} stories`);
    }

    console.log(`📚 Returning ${userStories.length} stories (total size: ${JSON.stringify(userStories).length} bytes)`);
    await logActivity(req.user.id, req.user.username, 'STORIES_LOADED', { count: userStories.length });
    res.json({
      stories: userStories,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + userStories.length < totalCount
      }
    });
  } catch (err) {
    console.error('❌ Error fetching stories:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ error: 'Failed to fetch stories', details: err.message });
  }
});

// Get single story with ALL data (images included)
app.get('/api/stories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📖 GET /api/stories/${id} - User: ${req.user.username}`);

    let story = null;

    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT data FROM stories WHERE id = $1 AND user_id = $2';
      const rows = await dbQuery(selectQuery, [id, req.user.id]);

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      const allStories = await readJSON(STORIES_FILE);
      const userStories = allStories[req.user.id] || [];
      story = userStories.find(s => s.id === id);
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    console.log(`📖 Returning full story: ${story.title} with ${story.sceneImages?.length || 0} images`);
    res.json(story);
  } catch (err) {
    console.error('❌ Error fetching story:', err);
    res.status(500).json({ error: 'Failed to fetch story', details: err.message });
  }
});

// Get story cover image only (for lazy loading in story list)
app.get('/api/stories/:id/cover', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    let coverImage = null;

    if (STORAGE_MODE === 'database' && dbPool) {
      const result = await dbPool.query(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      if (result.rows.length > 0) {
        const story = JSON.parse(result.rows[0].data);
        coverImage = story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null;
      }
    } else {
      const allStories = await readJSON(STORIES_FILE);
      const userStories = allStories[req.user.id] || [];
      const story = userStories.find(s => s.id === id);
      if (story) {
        coverImage = story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null;
      }
    }

    if (!coverImage) {
      return res.status(404).json({ error: 'Cover image not found' });
    }

    res.json({ coverImage });
  } catch (err) {
    console.error('❌ Error fetching cover image:', err);
    res.status(500).json({ error: 'Failed to fetch cover image' });
  }
});

app.post('/api/stories', authenticateToken, async (req, res) => {
  try {
    const { story } = req.body;

    // Add timestamp and ID if not present
    if (!story.id) {
      story.id = Date.now().toString();
    }
    story.createdAt = story.createdAt || new Date().toISOString();
    story.updatedAt = new Date().toISOString();

    let isNewStory;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      // Check if story exists
      const checkQuery = 'SELECT id FROM stories WHERE id = $1 AND user_id = $2';
      const existing = await dbQuery(checkQuery, [story.id, req.user.id]);
      isNewStory = existing.length === 0;

      // Note: Credits are now checked and deducted at job creation time (/api/jobs/create-story)
      // This endpoint is for saving/updating story data only

      // Save or update story
      if (isNewStory) {
        const insertQuery = 'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3)';
        await dbQuery(insertQuery, [story.id, req.user.id, JSON.stringify(story)]);
      } else {
        const updateQuery = 'UPDATE stories SET data = $1 WHERE id = $2 AND user_id = $3';
        await dbQuery(updateQuery, [JSON.stringify(story), story.id, req.user.id]);
      }
    } else {
      // File mode
      const allStories = await readJSON(STORIES_FILE);
      const users = await readJSON(USERS_FILE);

      if (!allStories[req.user.id]) {
        allStories[req.user.id] = [];
      }

      const existingIndex = allStories[req.user.id].findIndex(s => s.id === story.id);
      isNewStory = existingIndex < 0;

      // Note: Credits are now checked and deducted at job creation time (/api/jobs/create-story)
      // This endpoint is for saving/updating story data only

      if (existingIndex >= 0) {
        allStories[req.user.id][existingIndex] = story;
      } else {
        allStories[req.user.id].push(story);
      }

      await writeJSON(STORIES_FILE, allStories);
    }

    await logActivity(req.user.id, req.user.username, 'STORY_SAVED', {
      storyId: story.id,
      isNew: isNewStory
    });

    res.json({ message: 'Story saved successfully', id: story.id });
  } catch (err) {
    console.error('Error saving story:', err);
    res.status(500).json({ error: 'Failed to save story' });
  }
});

app.delete('/api/stories/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️  DELETE /api/stories/${id} - User: ${req.user.username} (ID: ${req.user.id})`);

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const deleteQuery = 'DELETE FROM stories WHERE id = $1 AND user_id = $2';
      const result = await dbQuery(deleteQuery, [id, req.user.id]);

      console.log(`🗑️  Delete result:`, { rowCount: result.rowCount, command: result.command });

      // Check if any rows were deleted using rowCount
      if (!result.rowCount || result.rowCount === 0) {
        log.warn(`Story ${id} not found for user ${req.user.id}`);
        return res.status(404).json({ error: 'Story not found or you do not have permission to delete it' });
      }

      // Also delete the associated story_job (story.id = job.id)
      try {
        const deleteJobResult = await dbPool.query(
          'DELETE FROM story_jobs WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );
        if (deleteJobResult.rowCount > 0) {
          console.log(`🗑️  Also deleted story_job ${id}`);
        }
      } catch (jobErr) {
        log.warn(`Could not delete story_job ${id}:`, jobErr.message);
      }

      console.log(`✅ Successfully deleted story ${id}`);
    } else {
      // File mode
      const allStories = await readJSON(STORIES_FILE);

      if (!allStories[req.user.id]) {
        return res.status(404).json({ error: 'Story not found' });
      }

      const initialLength = allStories[req.user.id].length;
      allStories[req.user.id] = allStories[req.user.id].filter(s => s.id !== id);

      if (allStories[req.user.id].length === initialLength) {
        return res.status(404).json({ error: 'Story not found' });
      }

      await writeJSON(STORIES_FILE, allStories);
    }

    await logActivity(req.user.id, req.user.username, 'STORY_DELETED', { storyId: id });
    res.json({ message: 'Story deleted successfully' });
  } catch (err) {
    console.error('Error deleting story:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});
END OF STORIES CRUD ROUTES */

// =============================================================================
// STORY REGENERATION ENDPOINTS - Regenerate individual components
// NOT MIGRATED - These remain active in server.js (AI generation dependencies)
// =============================================================================

// Regenerate scene description for a specific page
app.post('/api/stories/:id/regenerate/scene-description/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);

    console.log(`🔄 Regenerating scene description for story ${id}, page ${pageNumber}`);

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

    // Generate new scene description (includes Visual Bible recurring elements)
    const scenePrompt = buildSceneDescriptionPrompt(pageNumber, pageText, characters, '', language, visualBible);
    const sceneResult = await callClaudeAPI(scenePrompt, 2048);
    const newSceneDescription = sceneResult.text;

    // Update the scene description in story data
    let sceneDescriptions = storyData.sceneDescriptions || [];
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
    console.error('Error regenerating scene description:', err);
    res.status(500).json({ error: 'Failed to regenerate scene description: ' + err.message });
  }
});

// Regenerate image for a specific page
app.post('/api/stories/:id/regenerate/image/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { customPrompt } = req.body;
    const pageNumber = parseInt(pageNum);

    console.log(`🔄 Regenerating image for story ${id}, page ${pageNumber}`);

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

    // Detect which characters appear in this scene
    const sceneText = customPrompt || sceneDesc?.description || '';
    const sceneCharacters = getCharactersInScene(sceneText, storyData.characters || []);
    // Parse clothing category from scene description
    const clothingCategory = parseClothingCategory(sceneText) || 'standard';
    // Use detailed photo info (with names) for labeled reference images
    const referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory);
    console.log(`🔄 [REGEN] Scene has ${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory}`);

    // Get visual bible from stored story (for recurring elements)
    const visualBible = storyData.visualBible || null;
    if (visualBible) {
      const relevantEntries = getVisualBibleEntriesForPage(visualBible, pageNumber);
      console.log(`📖 [REGEN] Visual Bible: ${relevantEntries.length} entries relevant to page ${pageNumber}`);
    }

    // Build image prompt with scene-specific characters and visual bible
    const imagePrompt = customPrompt || buildImagePrompt(sceneDesc.description, storyData, sceneCharacters, false, visualBible, pageNumber);

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    if (imageCache.has(cacheKey)) {
      imageCache.delete(cacheKey);
      log.debug(`🗑️ [REGEN] Cleared cache for page ${pageNumber} to force new generation`);
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
    const imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene');

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: sceneDesc?.description || customPrompt,
      prompt: imagePrompt,  // Store the prompt used for this regeneration
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning || null,
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

    if (existingIndex >= 0) {
      sceneImages[existingIndex] = newImageData;
    } else {
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

    console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, regeneration #${newImageData.regenerationCount})`);

    res.json({
      success: true,
      pageNumber,
      imageData: imageResult.imageData,
      prompt: imagePrompt,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning,
      modelId: imageResult.modelId || null,
      totalAttempts: imageResult.totalAttempts || 1,
      retryHistory: imageResult.retryHistory || [],
      wasRegenerated: true,
      regenerationCount: newImageData.regenerationCount,
      // Previous version (immediate predecessor)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      // True original (from initial generation)
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning
    });

  } catch (err) {
    console.error('Error regenerating image:', err);
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

    console.log(`🔄 Regenerating ${normalizedCoverType} cover for story ${id}`);

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
    const buildCharRefList = (photos) => {
      if (!photos || photos.length === 0) return '';
      const charDescriptions = photos.map((photo, index) => {
        const age = photo.age ? `${photo.age} years old` : '';
        const gender = photo.gender === 'male' ? 'boy/man' : photo.gender === 'female' ? 'girl/woman' : '';
        const brief = [photo.name, age, gender].filter(Boolean).join(', ');
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
          CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos),
          VISUAL_BIBLE: visualBiblePrompt
        });
      } else if (normalizedCoverType === 'initialPage') {
        coverPrompt = storyData.dedication
          ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
              INITIAL_PAGE_SCENE: sceneDescription,
              STYLE_DESCRIPTION: styleDescription,
              DEDICATION: storyData.dedication,
              CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos),
              VISUAL_BIBLE: visualBiblePrompt
            })
          : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
              INITIAL_PAGE_SCENE: sceneDescription,
              STYLE_DESCRIPTION: styleDescription,
              STORY_TITLE: storyTitle,
              CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos),
              VISUAL_BIBLE: visualBiblePrompt
            });
      } else {
        coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
          BACK_COVER_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_REFERENCE_LIST: buildCharRefList(coverCharacterPhotos),
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
    if (imageCache.has(cacheKey)) {
      imageCache.delete(cacheKey);
      log.debug(`🗑️ [REGEN] Cleared cache for ${normalizedCoverType} cover to force new generation`);
    }

    // Generate new cover with quality retry (automatically retries on text errors)
    const coverResult = await generateImageWithQualityRetry(coverPrompt, coverCharacterPhotos, null, 'cover');

    // Update the cover in story data with new structure including quality, description, prompt, and previous version
    const coverData = {
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning || null,
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

    console.log(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, regeneration #${coverData.regenerationCount})`);

    res.json({
      success: true,
      coverType: normalizedCoverType,
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning,
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
      originalReasoning: trueOriginalReasoning
    });

  } catch (err) {
    console.error('Error regenerating cover:', err);
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
    console.log(`⭐ [EDIT] Evaluating edited image quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'scene');
      qualityScore = evaluation.score;
      qualityReasoning = evaluation.reasoning;
      console.log(`⭐ [EDIT] Edited image score: ${qualityScore}%`);
    } catch (evalErr) {
      console.error(`⚠️ [EDIT] Quality evaluation failed:`, evalErr.message);
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
    console.error('Error editing image:', err);
    res.status(500).json({ error: 'Failed to edit image: ' + err.message });
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
    console.log(`⭐ [COVER EDIT] Evaluating edited cover quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'cover');
      qualityScore = evaluation.score;
      qualityReasoning = evaluation.reasoning;
      console.log(`⭐ [COVER EDIT] Edited cover score: ${qualityScore}%`);
    } catch (evalErr) {
      console.error(`⚠️ [COVER EDIT] Quality evaluation failed:`, evalErr.message);
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
    console.error('Error editing cover:', err);
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

    console.log(`📝 Editing page ${pageNumber} for story ${id}`);

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
    console.error('Error editing page:', err);
    res.status(500).json({ error: 'Failed to edit page: ' + err.message });
  }
});

// Update Visual Bible for a story (developer mode)
app.put('/api/stories/:id/visual-bible', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { visualBible } = req.body;

    if (!visualBible) {
      return res.status(400).json({ error: 'visualBible is required' });
    }

    console.log(`📖 PUT /api/stories/${id}/visual-bible - User: ${req.user.username}`);

    // Get existing story
    const result = await dbPool.query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(result.rows[0].data);

    // Update Visual Bible
    storyData.visualBible = visualBible;
    storyData.updatedAt = new Date().toISOString();

    // Save updated story
    await dbPool.query(
      'UPDATE stories SET data = $1 WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Visual Bible updated for story ${id}`);

    res.json({
      success: true,
      message: 'Visual Bible updated successfully'
    });

  } catch (err) {
    console.error('Error updating Visual Bible:', err);
    res.status(500).json({ error: 'Failed to update Visual Bible: ' + err.message });
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
    console.error('Error getting checkpoints:', err);
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
    console.error('Error getting checkpoint:', err);
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
      console.log(`🖨️ [PRINT] Generating fresh print PDF for story: ${storyId}`);
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
        console.log(`🖨️ [PRINT] PDF generated and saved with URL: ${pdfUrl}, pageCount: ${pageCount}`);
      } catch (pdfErr) {
        console.error(`🖨️ [PRINT] Error generating PDF:`, pdfErr.message);
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
      console.error('Print provider API error:', printData);
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
    console.error('Error creating print provider order:', err);
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

    console.log(`📚 Targeting photobook catalogs: ${photobookCatalogs.join(', ')}`);

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

        console.log(`📡 Search response status: ${searchResponse.status}`);

        if (!searchResponse.ok) {
          const errorText = await searchResponse.text();
          console.error(`❌ Failed to search ${catalogUid}:`, errorText.substring(0, 200));
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
        console.log(`📚 ${catalogUid}: Found ${photobooks.length} products`);

        if (photobooks.length > 0) {
          console.log(`📚 First 3 products from ${catalogUid}:`);
          photobooks.slice(0, 3).forEach((p, i) => {
            console.log(`  ${i+1}. ${p.name || p.productName || 'Unnamed'} (UID: ${p.productUid || p.uid})`);
          });
        } else {
          log.warn(`No products found in ${catalogUid}!`);
        }

        allPhotobooks = allPhotobooks.concat(photobooks);
      } catch (err) {
        console.error(`❌ Error searching catalog ${catalogUid}:`, err.message);
        console.error('Error stack:', err.stack);
      }
    }

    // Remove duplicates based on productUid
    const uniquePhotobooks = Array.from(
      new Map(allPhotobooks.map(p => [p.productUid || p.uid, p])).values()
    );

    console.log('📚 Total unique photobooks found:', uniquePhotobooks.length);

    res.json({
      success: true,
      count: uniquePhotobooks.length,
      products: uniquePhotobooks,
      catalogsSearched: photobookCatalogs.length,
      catalogs: photobookCatalogs
    });

  } catch (err) {
    console.error('Error fetching print provider products:', err);
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
    console.error('Error getting products:', err);
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
    console.error('Error saving product:', err);
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
    console.error('Error seeding products:', err);
    res.status(500).json({ error: 'Failed to seed products', details: err.message });
  }
});

// =============================================================================
// CONFIG ROUTES - MIGRATED TO server/routes/config.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
// Get general app configuration (public, no auth required)
app.get('/api/config', (req, res) => {
  res.json({
    imageGenMode: IMAGE_GEN_MODE  // 'parallel' or 'sequential'
  });
});

// Get active products for users
// Get default print provider product UID from environment
app.get('/api/config/print-product-uid', authenticateToken, (req, res) => {
  const productUid = process.env.GELATO_PHOTOBOOK_UID;

  if (!productUid) {
    return res.status(500).json({
      error: 'Print product UID not configured',
      message: 'Please set GELATO_PHOTOBOOK_UID in environment variables'
    });
  }

  res.json({ productUid });
});
END OF CONFIG ROUTES */

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
    console.error('Error getting active products:', err);
    res.status(500).json({ error: 'Failed to get products', details: err.message });
  }
});

// Photo Analyzer Health Check
app.get('/api/photo-analyzer-status', async (req, res) => {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

  try {
    const response = await fetch(`${photoAnalyzerUrl}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    const data = await response.json();

    console.log('📸 [HEALTH] Python service status:', data);

    res.json({
      status: 'ok',
      pythonService: data,
      url: photoAnalyzerUrl
    });
  } catch (err) {
    console.error('📸 [HEALTH] Python service unavailable:', err.message);
    res.status(503).json({
      status: 'error',
      error: err.message,
      url: photoAnalyzerUrl
    });
  }
});

// Photo Analysis Endpoint (calls Python DeepFace service)
app.post('/api/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      console.log('📸 [PHOTO] Missing imageData in request');
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
          console.log('📸 [GEMINI] No API key, skipping trait extraction');
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
          console.error('📸 [GEMINI] API error:', response.status);
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
          console.log('📸 [GEMINI] Raw response length:', text.length);
          // Extract JSON from response (may have markdown wrapping)
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            // Handle nested traits format or flat format
            if (result.traits) {
              console.log('📸 [GEMINI] Extracted traits:', result.traits);
              return result;
            } else {
              // Flat traits object - wrap in traits
              console.log('📸 [GEMINI] Extracted traits (flat format):', result);
              return { traits: result };
            }
          } else {
            console.error('📸 [GEMINI] No JSON found in response:', text.substring(0, 200));
          }
        } else {
          console.error('📸 [GEMINI] Unexpected response structure:', JSON.stringify(data).substring(0, 200));
        }
        return null;
      } catch (err) {
        console.error('📸 [GEMINI] Trait extraction error:', err.message);
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
        console.error('📸 [PHOTO] Python analysis failed:', analyzerData.error, analyzerData.traceback);
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

      console.log('📸 [PHOTO] Sending response:', {
        hasAttributes: !!analyzerData.attributes,
        clothing: analyzerData.attributes?.clothing
      });
      res.json(response);

    } catch (fetchErr) {
      console.error('Photo analyzer service error:', fetchErr.message);

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
    console.error('Error analyzing photo:', err);
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
        tag = '[WINTER]';
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
    const avatarPrompt = fillTemplate(promptPart, {
      'CLOTHING_STYLE': clothingStyle
    });

    res.json({ success: true, prompt: avatarPrompt });
  } catch (error) {
    console.error('Error getting avatar prompt:', error);
    res.status(500).json({ error: error.message });
  }
});


// Generate clothing avatars for a character (4 categories: winter, standard, summer, formal)
// This creates photorealistic avatars with different clothing for story illustration
// Prompts based on reference implementation - see prompts/clothing-avatars.txt
app.post('/api/generate-clothing-avatars', authenticateToken, async (req, res) => {
  try {
    const { characterId, facePhoto, physicalDescription, name, age, gender } = req.body;

    if (!facePhoto) {
      return res.status(400).json({ error: 'Missing facePhoto' });
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      return res.status(503).json({ error: 'Avatar generation service unavailable' });
    }

    log.debug(`👔 [CLOTHING AVATARS] Starting generation for ${name} (id: ${characterId})`);

    // Parse clothing styles from the template file
    const isFemale = gender === 'female';

    const getClothingStylePrompt = (category) => {
      const template = PROMPT_TEMPLATES.avatarMainPrompt || '';
      const styleSection = template.split('CLOTHING_STYLES:')[1] || '';

      // Build the tag to look for based on category and gender
      let tag;
      if (category === 'winter') {
        tag = '[WINTER]';
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
        console.log(`${config.emoji} [CLOTHING AVATARS] Generating ${category} avatar for ${name} (${gender || 'unknown'})...`);

        // Build the prompt from template (use only the prompt part, not the CLOTHING_STYLES section)
        const promptPart = (PROMPT_TEMPLATES.avatarMainPrompt || '').split('---\nCLOTHING_STYLES:')[0].trim();
        const clothingStyle = getClothingStylePrompt(category);
        console.log(`   [CLOTHING] Style for ${category}: "${clothingStyle}"`);
        const avatarPrompt = fillTemplate(promptPart, {
          'CLOTHING_STYLE': clothingStyle
        });
        console.log(`   [CLOTHING] Prompt includes: "Outfit: ${clothingStyle.substring(0, 50)}..."`);

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
          console.error(`❌ [CLOTHING AVATARS] ${category} generation failed:`, errorText);
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
          console.log(`🔄 [CLOTHING AVATARS] Retrying ${category} with simplified prompt...`);

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
            console.error(`❌ [CLOTHING AVATARS] ${category} retry failed`);
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
        console.error(`❌ [CLOTHING AVATARS] Error generating ${category}:`, err.message);
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
    console.error('Error generating clothing avatars:', err);
    res.status(500).json({ error: 'Failed to generate clothing avatars', details: err.message });
  }
});

// =============================================================================
// FILE MANAGEMENT ROUTES - MIGRATED TO server/routes/files.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
// File Management Endpoints

// Upload file (image or PDF)
app.post('/api/files', authenticateToken, async (req, res) => {
  try {
    const { fileData, fileType, storyId, mimeType, filename } = req.body;

    if (!fileData || !fileType || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: fileData, fileType, mimeType' });
    }

    // Extract base64 data (remove data URL prefix if present)
    const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const fileSize = buffer.length;

    const fileId = `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const insertQuery = 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';

      await dbQuery(insertQuery, [
        fileId,
        req.user.id,
        fileType,
        storyId || null,
        mimeType,
        buffer,
        fileSize,
        filename || null
      ]);
    } else {
      // File mode - save to disk
      const fs = require('fs').promises;
      const path = require('path');
      const uploadsDir = path.join(__dirname, 'data', 'uploads');

      // Create uploads directory if it doesn't exist
      await fs.mkdir(uploadsDir, { recursive: true });

      const filePath = path.join(uploadsDir, fileId);
      await fs.writeFile(filePath, buffer);

      // Save metadata to JSON
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
        fileType,
        storyId: storyId || null,
        mimeType,
        fileSize,
        filename: filename || null,
        createdAt: new Date().toISOString()
      };

      await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'FILE_UPLOADED', {
      fileId,
      fileType,
      fileSize
    });

    res.json({
      success: true,
      fileId,
      fileUrl: `${req.protocol}://${req.get('host')}/api/files/${fileId}`,
      fileSize
    });

  } catch (err) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: 'Failed to upload file', details: err.message });
  }
});

// Get/serve file by ID
app.get('/api/files/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT mime_type, file_data, filename FROM files WHERE id = $1';

      const rows = await dbQuery(selectQuery, [fileId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
      }

      const file = rows[0];

      res.set('Content-Type', file.mime_type);
      if (file.filename) {
        // Sanitize filename for Content-Disposition header (remove/replace non-ASCII chars)
        const safeFilename = file.filename.replace(/[^\x20-\x7E]/g, '_');
        // Use RFC 5987 encoding for proper Unicode support
        const encodedFilename = encodeURIComponent(file.filename).replace(/'/g, '%27');
        res.set('Content-Disposition', `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
      }

      // file_data could be: Buffer (bytea), string (base64), or string (data URL)
      let fileBuffer;
      if (Buffer.isBuffer(file.file_data)) {
        // Already a buffer - check if it's base64 encoded text
        const str = file.file_data.toString('utf8');
        if (str.startsWith('data:')) {
          fileBuffer = Buffer.from(str.split(',')[1], 'base64');
        } else if (/^[A-Za-z0-9+/=]+$/.test(str.substring(0, 100))) {
          // Looks like base64 string stored as buffer
          fileBuffer = Buffer.from(str, 'base64');
        } else {
          fileBuffer = file.file_data;
        }
      } else if (typeof file.file_data === 'string') {
        if (file.file_data.startsWith('data:')) {
          fileBuffer = Buffer.from(file.file_data.split(',')[1], 'base64');
        } else {
          fileBuffer = Buffer.from(file.file_data, 'base64');
        }
      } else {
        fileBuffer = file.file_data;
      }

      res.send(fileBuffer);

    } else {
      // File mode - read from disk
      const fs = require('fs').promises;
      const path = require('path');

      const metadataFile = path.join(__dirname, 'data', 'files.json');
      const data = await fs.readFile(metadataFile, 'utf-8');
      const metadata = JSON.parse(data);

      if (!metadata[fileId]) {
        return res.status(404).json({ error: 'File not found' });
      }

      const fileMetadata = metadata[fileId];
      const filePath = path.join(__dirname, 'data', 'uploads', fileId);
      const fileBuffer = await fs.readFile(filePath);

      res.set('Content-Type', fileMetadata.mimeType);
      if (fileMetadata.filename) {
        // Sanitize filename for Content-Disposition header (remove/replace non-ASCII chars)
        const safeFilename = fileMetadata.filename.replace(/[^\x20-\x7E]/g, '_');
        // Use RFC 5987 encoding for proper Unicode support
        const encodedFilename = encodeURIComponent(fileMetadata.filename).replace(/'/g, '%27');
        res.set('Content-Disposition', `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
      }
      res.send(fileBuffer);
    }

  } catch (err) {
    console.error('Error serving file:', err);
    res.status(500).json({ error: 'Failed to serve file', details: err.message });
  }
});

// Delete file by ID
app.delete('/api/files/:fileId', authenticateToken, async (req, res) => {
  try {
    const { fileId } = req.params;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - verify ownership before deleting
      const deleteQuery = 'DELETE FROM files WHERE id = $1 AND user_id = $2';

      const result = await dbQuery(deleteQuery, [fileId, req.user.id]);

      if (result.length === 0) {
        return res.status(404).json({ error: 'File not found or unauthorized' });
      }
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');

      const metadataFile = path.join(__dirname, 'data', 'files.json');
      const data = await fs.readFile(metadataFile, 'utf-8');
      const metadata = JSON.parse(data);

      if (!metadata[fileId] || metadata[fileId].userId !== req.user.id) {
        return res.status(404).json({ error: 'File not found or unauthorized' });
      }

      // Delete file from disk
      const filePath = path.join(__dirname, 'data', 'uploads', fileId);
      await fs.unlink(filePath);

      // Remove from metadata
      delete metadata[fileId];
      await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2));
    }

    await logActivity(req.user.id, req.user.username, 'FILE_DELETED', { fileId });
    res.json({ success: true, message: 'File deleted successfully' });

  } catch (err) {
    console.error('Error deleting file:', err);
    res.status(500).json({ error: 'Failed to delete file', details: err.message });
  }
});
END OF FILE MANAGEMENT ROUTES */

// ========================================
// SHARED PDF GENERATION FUNCTION FOR PRINTING
// Used by both Buy Book (processBookOrder) and Print Book endpoints
// Creates print-ready PDF with back+front cover concatenated
// ========================================
async function generatePrintPdf(storyData) {
  const PDFDocument = require('pdfkit');

  // Helper function to extract image data from cover images
  const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

  const mmToPoints = (mm) => mm * 2.83465;
  const coverWidth = mmToPoints(416);    // 20x20cm cover spread
  const coverHeight = mmToPoints(206);   // 20x20cm cover height with bleed
  const pageSize = mmToPoints(200);      // 20x20cm interior pages

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

  // Add cover page (back cover on left + front cover on right - for print binding)
  doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

  const backCoverImageData = getCoverImageData(storyData.coverImages?.backCover);
  const frontCoverImageData = getCoverImageData(storyData.coverImages?.frontCover);

  if (backCoverImageData && frontCoverImageData) {
    const backCoverBuffer = Buffer.from(backCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const frontCoverBuffer = Buffer.from(frontCoverImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });
    doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });
  }

  // Add initial page (dedication/intro page)
  const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
  if (initialPageImageData) {
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const initialPageData = initialPageImageData.replace(/^data:image\/\w+;base64,/, '');
    const initialPageBuffer = Buffer.from(initialPageData, 'base64');
    doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
  }

  // Parse story pages
  const generatedStoryText = storyData.storyText || storyData.generatedStory || storyData.story || storyData.text || '';
  if (!generatedStoryText) {
    throw new Error('Story text not found in story data. Available keys: ' + Object.keys(storyData).join(', '));
  }

  const pageMatches = generatedStoryText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Seite|Page)\s+\d+)/i);
  const storyPages = pageMatches.slice(1).filter(p => p.trim().length > 0);

  log.debug(`📄 [PRINT PDF] Found ${storyPages.length} story pages`);

  // Determine layout
  const isPictureBook = storyData.languageLevel === '1st-grade';
  log.debug(`📄 [PRINT PDF] Layout: ${isPictureBook ? 'Picture Book (combined)' : 'Standard (separate pages)'}`);

  // Add content pages based on layout type
  if (isPictureBook) {
    // PICTURE BOOK LAYOUT: Combined image on top (~85%), text below (~15%)
    storyPages.forEach((pageText, index) => {
      const pageNumber = index + 1;
      const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
      const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();
      const margin = mmToPoints(5);

      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

      const imageHeight = pageSize * 0.85;
      const textAreaHeight = pageSize * 0.15;
      const textAreaY = imageHeight;

      if (image && image.imageData) {
        try {
          const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          doc.image(imageBuffer, margin, margin, {
            fit: [pageSize - (margin * 2), imageHeight - (margin * 2)],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          console.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
        }
      }

      // Add text in bottom portion with vertical centering
      const textMargin = mmToPoints(3);
      const availableTextWidth = pageSize - (textMargin * 2);
      const availableTextHeight = textAreaHeight - textMargin;

      const lineGap = -2;
      let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
      doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
      let textHeight = doc.heightOfString(cleanText, { width: availableTextWidth, align: 'center', lineGap });

      // Auto-reduce font size if text doesn't fit
      while (textHeight > availableTextHeight && fontSize > 6) {
        fontSize -= 0.5;
        doc.fontSize(fontSize);
        textHeight = doc.heightOfString(cleanText, { width: availableTextWidth, align: 'center', lineGap });
      }

      // Check if text still doesn't fit
      if (textHeight > availableTextHeight) {
        const errorMsg = `Text too long on page ${pageNumber}. Please shorten the story text for this page.`;
        console.error(`❌ [PRINT PDF] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Vertically center text in text area
      const textY = textAreaY + (availableTextHeight - textHeight) / 2;
      doc.text(cleanText, textMargin, textY, { width: availableTextWidth, align: 'center', lineGap });
    });
  } else {
    // STANDARD/ADVANCED LAYOUT: Separate pages for text and image
    storyPages.forEach((pageText, index) => {
      const pageNumber = index + 1;
      const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
      const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

      // Add text page
      const margin = 28;
      doc.addPage({ size: [pageSize, pageSize], margins: { top: margin, bottom: margin, left: margin, right: margin } });

      const availableWidth = pageSize - (margin * 2);
      const availableHeight = pageSize - (margin * 2);

      const lineGap = -2;
      let fontSize = 13;  // Scaled for 20x20cm (was 9pt for 14x14cm)
      doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
      const safeAvailableHeight = availableHeight * 0.9;
      let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });

      // Auto-reduce font size if text doesn't fit
      while (textHeight > safeAvailableHeight && fontSize > 6) {
        fontSize -= 0.5;
        doc.fontSize(fontSize);
        textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left', lineGap });
      }

      if (fontSize < 13) {
        log.debug(`📄 [PRINT PDF] Page ${pageNumber}: Font reduced 13pt → ${fontSize}pt`);
      }

      // Check if text still doesn't fit
      if (textHeight > safeAvailableHeight) {
        const errorMsg = `Text too long on page ${pageNumber}. Please shorten the story text for this page.`;
        console.error(`❌ [PRINT PDF] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      // Vertically center text
      const yPosition = margin + (availableHeight - textHeight) / 2;
      doc.text(cleanText, margin, yPosition, { width: availableWidth, align: 'left', lineGap });

      // Add image page if available
      if (image && image.imageData) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        try {
          const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
          const imgMargin = mmToPoints(5);
          doc.image(imageBuffer, imgMargin, imgMargin, {
            fit: [pageSize - (imgMargin * 2), pageSize - (imgMargin * 2)],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          console.error('Error adding image to PDF:', imgErr);
        }
      }
    });
  }

  // Calculate page count and add blank pages if needed (must be even for print)
  let actualPdfPages;
  if (isPictureBook) {
    actualPdfPages = storyPages.length;
  } else {
    actualPdfPages = storyPages.length * 2;
  }

  const targetPageCount = actualPdfPages % 2 === 0 ? actualPdfPages : actualPdfPages + 1;
  const blankPagesToAdd = targetPageCount - actualPdfPages;

  if (blankPagesToAdd > 0) {
    log.debug(`📄 [PRINT PDF] Adding ${blankPagesToAdd} blank page(s) to reach even count ${targetPageCount}`);
  }

  for (let i = 0; i < blankPagesToAdd; i++) {
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  }

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [PRINT PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${targetPageCount} interior pages`);

  return { pdfBuffer, pageCount: targetPageCount };
}

// Generate combined book PDF from multiple stories
// Used by processBookOrder when ordering a book with multiple stories
async function generateCombinedBookPdf(stories) {
  console.log(`📚 [COMBINED PDF] Generating book with ${stories.length} stories`);

  const PDFDocument = require('pdfkit');
  const mmToPoints = (mm) => mm * 2.83465;
  const coverWidth = mmToPoints(416);       // 20x20cm cover spread
  const coverHeight = mmToPoints(206);      // 20x20cm cover height with bleed
  const pageSize = mmToPoints(200);         // Interior pages: 200x200mm

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
  const getCoverImageData = (img) => typeof img === 'string' ? img : img?.imageData;

  // Helper: Parse story pages from story text
  const parseStoryPages = (storyData) => {
    const storyText = storyData.storyText || storyData.generatedStory || storyData.story || storyData.text || '';
    const pageMatches = storyText.split(/(?:---\s*(?:Page|Seite)\s+\d+\s*---|##\s*(?:Seite|Page)\s+\d+)/i);
    return pageMatches.slice(1).filter(p => p.trim().length > 0);
  };

  // Helper: Add story content pages (text + images)
  const addStoryContentPages = (storyData, storyPages) => {
    const isPictureBook = storyData.languageLevel === '1st-grade';
    const margin = mmToPoints(5);
    const textMargin = 28;

    if (isPictureBook) {
      // Picture Book: combined image + text on same page
      const imageHeight = pageSize * 0.85;
      const textAreaHeight = pageSize * 0.15;
      const textWidth = pageSize - (margin * 2);
      const availableTextHeight = textAreaHeight - margin;
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
            doc.image(imageBuffer, margin, margin, {
              fit: [pageSize - (margin * 2), imageHeight - (margin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            console.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }

        // Add text with vertical centering
        let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
        }

        const textY = imageHeight + (availableTextHeight - textHeight) / 2;
        doc.text(cleanText, margin, textY, { width: textWidth, align: 'center', lineGap });
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

        // Text page
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

        // Image page
        if (image && image.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          totalStoryPages++;
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const imgMargin = mmToPoints(5);
            doc.image(imageBuffer, imgMargin, imgMargin, {
              fit: [pageSize - (imgMargin * 2), pageSize - (imgMargin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            console.error(`Error adding image for page ${pageNumber}:`, err.message);
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

    console.log(`📚 [COMBINED PDF] Processing story ${storyIndex + 1}: "${storyData.title}" with ${storyPages.length} pages`);

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

      // Introduction page
      const initialPageImageData = getCoverImageData(storyData.coverImages?.initialPage);
      if (initialPageImageData) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        const initialPageBuffer = Buffer.from(initialPageImageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
      }

      // Story 1 content pages
      addStoryContentPages(storyData, storyPages);

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

      // Blank page between stories (if not last story)
      if (storyIndex < stories.length - 1) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        totalStoryPages++;
      }
    }
  }

  // Add blank pages if needed to reach even page count for printing
  if (totalStoryPages % 2 !== 0) {
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    totalStoryPages++;
    console.log(`📚 [COMBINED PDF] Added final blank page for even page count`);
  }

  doc.end();
  const pdfBuffer = await pdfPromise;

  console.log(`✅ [COMBINED PDF] Generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB) with ${totalStoryPages} story pages`);

  return { pdfBuffer, pageCount: totalStoryPages };
}

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
        console.error('Error adding front cover:', err.message);
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
        console.error('Error adding initial page:', err.message);
      }
    }

    // 3. STORY PAGES
    if (isPictureBook) {
      // Picture Book: combined image + text on same page
      const margin = mmToPoints(5);
      const imageHeight = pageSize * 0.85;
      const textAreaHeight = pageSize * 0.15;
      const textWidth = pageSize - (margin * 2);
      const availableTextHeight = textAreaHeight - margin;
      const lineGap = -2;

      storyPages.forEach((pageText, index) => {
        const pageNumber = index + 1;
        const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
        const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        if (image && image.imageData) {
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            doc.image(imageBuffer, margin, margin, {
              fit: [pageSize - (margin * 2), imageHeight - (margin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            console.error(`Error adding image for page ${pageNumber}:`, err.message);
          }
        }

        // Add text with vertical centering in text area
        let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
        doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
        let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

        while (textHeight > availableTextHeight && fontSize > 6) {
          fontSize -= 0.5;
          doc.fontSize(fontSize);
          textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
        }

        const textY = imageHeight + (availableTextHeight - textHeight) / 2;
        doc.text(cleanText, margin, textY, { width: textWidth, align: 'center', lineGap });
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

        // Text page with vertical centering
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

        // Image page
        if (image && image.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          try {
            const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const imgMargin = mmToPoints(5);
            doc.image(imageBuffer, imgMargin, imgMargin, {
              fit: [pageSize - (imgMargin * 2), pageSize - (imgMargin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (err) {
            console.error(`Error adding image for page ${pageNumber}:`, err.message);
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
        console.error('Error adding back cover:', err.message);
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
    console.error('Error generating PDF:', err);
    res.status(500).json({ error: 'Failed to generate PDF', details: err.message });
  }
});

// GET PRINT PDF for a story - ADMIN ONLY - uses same format as Buy Book/Print Book
// This allows admins to preview the exact PDF that would be sent to Gelato for printing
app.get('/api/stories/:id/print-pdf', authenticateToken, async (req, res) => {
  try {
    // Admin only
    if (req.user.role !== 'admin') {
      console.log(`🖨️ [ADMIN PRINT PDF] Access denied - user ${req.user.username} is not admin (role: ${req.user.role})`);
      return res.status(403).json({ error: 'Admin access required' });
    }

    const storyId = req.params.id;
    console.log(`🖨️ [ADMIN PRINT PDF] Admin ${req.user.username} requesting print PDF for story: ${storyId}`);
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
      console.log(`🖨️ [ADMIN PRINT PDF] Story not found: ${storyId}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    console.log(`🖨️ [ADMIN PRINT PDF] Story found: ${storyData.title}`);
    console.log(`🖨️ [ADMIN PRINT PDF] Story has: coverImages=${!!storyData.coverImages}, sceneImages=${storyData.sceneImages?.length || 0}, storyText=${!!storyData.storyText || !!storyData.generatedStory}`);

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
    console.error('Error generating print PDF:', err);
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
        const margin = mmToPoints(5);  // 5mm margin around page

        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        // Layout: Image takes top 85%, text takes bottom 15%
        const imageHeight = pageSize * 0.85;
        const textAreaHeight = pageSize * 0.15;
        const textAreaY = imageHeight;

        // Add image at top if available
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');

            doc.image(imageBuffer, margin, margin, {
              fit: [pageSize - (margin * 2), imageHeight - (margin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            console.error(`Error adding image to PDF page ${pageNumber}:`, imgErr);
          }
        }

        // Add text in bottom portion (small area for Picture Book)
        const textMargin = mmToPoints(3);  // Smaller margin for compact text area
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
          console.error(`❌ Page ${pageNumber}: Text too long even at minimum font size (${fontSize}pt) - would be truncated`);
        }
      });

      // Abort if any pages would be truncated
      if (truncatedPages.length > 0) {
        console.error(`❌ [PDF] Aborting: ${truncatedPages.length} pages have text too long for print`);
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

        // Add image page if available (square format)
        const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
        if (sceneImage && sceneImage.imageData) {
          doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

          try {
            const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const imgMargin = mmToPoints(5);

            doc.image(imageBuffer, imgMargin, imgMargin, {
              fit: [pageSize - (imgMargin * 2), pageSize - (imgMargin * 2)],
              align: 'center',
              valign: 'center'
            });
          } catch (imgErr) {
            console.error('Error adding image to PDF:', imgErr);
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
    console.error('Error generating PDF:', err);
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

    console.log(`📚 [BOOK PDF] Generating multi-story book with ${storyIds.length} stories`);

    // Fetch all stories from database
    const stories = [];
    for (const storyId of storyIds) {
      const storyResult = await dbPool.query(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [storyId, userId]
      );

      if (storyResult.rows.length === 0) {
        console.log(`📚 [BOOK PDF] Story not found: ${storyId}`);
        return res.status(404).json({ error: `Story not found: ${storyId}` });
      }

      const storyData = typeof storyResult.rows[0].data === 'string'
        ? JSON.parse(storyResult.rows[0].data)
        : storyResult.rows[0].data;

      stories.push({ id: storyId, data: storyData });
    }

    console.log(`📚 [BOOK PDF] Loaded ${stories.length} stories: ${stories.map(s => s.data.title).join(', ')}`);

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
      const margin = mmToPoints(5);
      const textMargin = 28;

      if (isPictureBook) {
        // Picture Book: combined image + text on same page
        const imageHeight = pageSize * 0.85;
        const textAreaHeight = pageSize * 0.15;
        const textWidth = pageSize - (margin * 2);
        const availableTextHeight = textAreaHeight - margin;
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
              doc.image(imageBuffer, margin, margin, {
                fit: [pageSize - (margin * 2), imageHeight - (margin * 2)],
                align: 'center',
                valign: 'center'
              });
            } catch (err) {
              console.error(`Error adding image for page ${pageNumber}:`, err.message);
            }
          }

          // Add text with vertical centering
          let fontSize = 14;  // Scaled for 20x20cm (was 10pt for 14x14cm)
          doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
          let textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });

          while (textHeight > availableTextHeight && fontSize > 6) {
            fontSize -= 0.5;
            doc.fontSize(fontSize);
            textHeight = doc.heightOfString(cleanText, { width: textWidth, align: 'center', lineGap });
          }

          const textY = imageHeight + (availableTextHeight - textHeight) / 2;
          doc.text(cleanText, margin, textY, { width: textWidth, align: 'center', lineGap });
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

          // Text page
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

          // Image page
          if (image && image.imageData) {
            doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
            totalStoryPages++;
            try {
              const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
              const imgMargin = mmToPoints(5);
              doc.image(imageBuffer, imgMargin, imgMargin, {
                fit: [pageSize - (imgMargin * 2), pageSize - (imgMargin * 2)],
                align: 'center',
                valign: 'center'
              });
            } catch (err) {
              console.error(`Error adding image for page ${pageNumber}:`, err.message);
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

      console.log(`📚 [BOOK PDF] Processing story ${storyIndex + 1}: "${storyData.title}" with ${storyPages.length} pages`);

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
      console.log(`📚 [BOOK PDF] Added final blank page for even page count`);
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
    console.error('📚 [BOOK PDF] Error:', err);
    res.status(500).json({ error: 'Failed to generate book PDF', details: err.message });
  }
});

// ADMIN: Force add shipping columns (emergency fix)
app.post('/api/admin/fix-shipping-columns', async (req, res) => {
  try {
    const results = [];
    const columns = [
      { name: 'shipping_first_name', type: 'VARCHAR(255)' },
      { name: 'shipping_last_name', type: 'VARCHAR(255)' },
      { name: 'shipping_address_line1', type: 'VARCHAR(500)' },
      { name: 'shipping_city', type: 'VARCHAR(255)' },
      { name: 'shipping_post_code', type: 'VARCHAR(50)' },
      { name: 'shipping_country', type: 'VARCHAR(2)' },
      { name: 'shipping_email', type: 'VARCHAR(255)' }
    ];

    for (const col of columns) {
      try {
        await dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.push({ column: col.name, status: 'OK' });
      } catch (err) {
        results.push({ column: col.name, status: 'ERROR', error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Check and cleanup orphaned data (characters/stories without user_id)
app.post('/api/admin/cleanup-orphaned-data', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned data...');

    // Check for orphaned characters
    const orphanedCharsResult = await dbQuery(
      `SELECT COUNT(*) as count FROM characters WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedCharsCount = parseInt(orphanedCharsResult[0].count);

    // Check for orphaned stories
    const orphanedStoriesResult = await dbQuery(
      `SELECT COUNT(*) as count FROM stories WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedStoriesCount = parseInt(orphanedStoriesResult[0].count);

    console.log(`Found ${orphanedCharsCount} orphaned characters, ${orphanedStoriesCount} orphaned stories`);

    // Only delete if requested
    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned data...');

      let deletedChars = 0;
      let deletedStories = 0;

      if (orphanedCharsCount > 0) {
        const deleteCharsResult = await dbQuery(
          `DELETE FROM characters WHERE user_id IS NULL OR user_id = ''`
        );
        deletedChars = deleteCharsResult.rowCount;
        console.log(`✓ Deleted ${deletedChars} orphaned characters`);
      }

      if (orphanedStoriesCount > 0) {
        const deleteStoriesResult = await dbQuery(
          `DELETE FROM stories WHERE user_id IS NULL OR user_id = ''`
        );
        deletedStories = deleteStoriesResult.rowCount;
        console.log(`✓ Deleted ${deletedStories} orphaned stories`);
      }

      res.json({
        success: true,
        action: 'deleted',
        deleted: {
          characters: deletedChars,
          stories: deletedStories
        }
      });
    } else {
      // Just return counts without deleting
      res.json({
        success: true,
        action: 'check',
        found: {
          characters: orphanedCharsCount,
          stories: orphanedStoriesCount
        },
        message: 'Use action=delete to remove orphaned data'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned data:', err);
    res.status(500).json({ error: err.message });
  }
});

// Cleanup orphaned story_jobs (jobs without matching stories)
app.post('/api/admin/cleanup-orphaned-jobs', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned story_jobs...');

    // Find orphaned jobs (jobs without matching stories)
    const orphanedJobsResult = await dbPool.query(`
      SELECT sj.id, sj.user_id, sj.status, sj.created_at, sj.updated_at,
             sj.progress, sj.progress_message, u.username
      FROM story_jobs sj
      LEFT JOIN users u ON sj.user_id = u.id
      WHERE NOT EXISTS (
        SELECT 1 FROM stories s WHERE s.id = sj.id
      )
      ORDER BY sj.created_at DESC
      LIMIT 100
    `);

    const orphanedJobs = orphanedJobsResult.rows;
    console.log(`Found ${orphanedJobs.length} orphaned story_jobs`);

    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned story_jobs...');

      const deleteResult = await dbPool.query(`
        DELETE FROM story_jobs
        WHERE NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_jobs.id
        )
      `);

      console.log(`✓ Deleted ${deleteResult.rowCount} orphaned story_jobs`);

      res.json({
        success: true,
        action: 'deleted',
        deleted: deleteResult.rowCount
      });
    } else {
      // Return list of orphaned jobs
      res.json({
        success: true,
        action: 'check',
        count: orphanedJobs.length,
        jobs: orphanedJobs.map(j => ({
          id: j.id,
          userId: j.user_id,
          username: j.username,
          status: j.status,
          progress: j.progress,
          progressMessage: j.progress_message,
          createdAt: j.created_at,
          updatedAt: j.updated_at
        })),
        message: 'Use action=delete to remove orphaned jobs'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all orders (admin only) - for tracking fulfillment and catching failures
app.get('/api/admin/orders', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'Orders are only available in database mode' });
    }

    console.log('📦 [ADMIN] Fetching all orders...');

    // Get all orders with user info
    const orders = await dbPool.query(`
      SELECT
        o.id,
        o.user_id,
        u.email as user_email,
        o.story_id,
        o.stripe_session_id,
        o.stripe_payment_intent_id,
        o.customer_name,
        o.customer_email,
        o.shipping_name,
        o.shipping_address_line1,
        o.shipping_city,
        o.shipping_postal_code,
        o.shipping_country,
        o.amount_total,
        o.currency,
        o.payment_status,
        o.gelato_order_id,
        o.gelato_status,
        o.created_at,
        o.updated_at,
        CASE
          WHEN o.payment_status = 'paid' AND o.gelato_order_id IS NULL THEN true
          ELSE false
        END as has_issue
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT 100
    `);

    const totalOrders = orders.rows.length;
    const failedOrders = orders.rows.filter(o => o.has_issue);

    log.info(`✅ [ADMIN] Found ${totalOrders} orders, ${failedOrders.length} with issues`);

    res.json({
      success: true,
      totalOrders,
      failedOrdersCount: failedOrders.length,
      orders: orders.rows
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching orders:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin - Retry failed print provider order
app.post('/api/admin/orders/:orderId/retry-print-order', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { orderId } = req.params;
    console.log(`🔄 [ADMIN] Retrying print order for order ID: ${orderId}`);

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
      console.error(`❌ [ADMIN] Print provider API error: ${printResponse.status} - ${errorText}`);
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
    console.error('❌ [ADMIN] Error retrying print order:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Get statistics overview
app.get('/api/admin/stats', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'Admin stats are only available in database mode' });
    }

    console.log('📊 [ADMIN] Fetching dashboard statistics...');

    // Get counts for all main entities
    const userCountResult = await dbPool.query('SELECT COUNT(*) as count FROM users');
    const storyCountResult = await dbPool.query('SELECT COUNT(*) as count FROM stories');
    const fileCountResult = await dbPool.query('SELECT COUNT(*) as count FROM files');

    // Count individual characters (each row contains a JSON array of characters)
    const characterDataResult = await dbPool.query('SELECT data FROM characters');
    let totalCharacters = 0;
    for (const row of characterDataResult.rows) {
      try {
        const charData = JSON.parse(row.data);
        if (charData.characters && Array.isArray(charData.characters)) {
          totalCharacters += charData.characters.length;
        }
      } catch (err) {
        console.warn('⚠️ Skipping malformed character data');
      }
    }

    // Get orphaned files (files with story_id that doesn't exist in stories table)
    const orphanedFilesResult = await dbPool.query(`
      SELECT f.id, f.story_id, f.file_type, f.file_size, f.filename, f.created_at
      FROM files f
      WHERE f.story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = f.story_id
        )
      ORDER BY f.created_at DESC
      LIMIT 100
    `);

    // Count images in files table
    const imageFilesResult = await dbPool.query(
      "SELECT COUNT(*) as count FROM files WHERE file_type = 'image' OR mime_type LIKE 'image/%'"
    );

    // Count total size of orphaned files
    const orphanedSizeResult = await dbPool.query(`
      SELECT COALESCE(SUM(f.file_size), 0) as total_size
      FROM files f
      WHERE f.story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = f.story_id
        )
    `);

    // Count images embedded in story data (sceneImages)
    const storiesWithData = await dbPool.query('SELECT data FROM stories');
    let embeddedImagesCount = 0;
    let totalSceneImagesSize = 0;

    for (const row of storiesWithData.rows) {
      try {
        const storyData = JSON.parse(row.data);
        if (storyData.sceneImages && Array.isArray(storyData.sceneImages)) {
          embeddedImagesCount += storyData.sceneImages.length;
          // Estimate size of base64 images
          storyData.sceneImages.forEach(img => {
            if (img.imageData) {
              // Base64 encoded size is roughly 4/3 of original
              totalSceneImagesSize += img.imageData.length * 0.75;
            }
          });
        }
      } catch (err) {
        // Skip malformed JSON
        console.warn('⚠️ Skipping malformed story data');
      }
    }

    // Get database size
    let databaseSize = 'N/A';
    try {
      const dbSizeResult = await dbPool.query(`
        SELECT pg_size_pretty(pg_database_size(current_database())) as total_size
      `);
      databaseSize = dbSizeResult.rows[0].total_size;
    } catch (dbSizeErr) {
      console.warn('⚠️ Could not get database size:', dbSizeErr.message);
    }

    // Return flat structure matching client interface
    const stats = {
      totalUsers: parseInt(userCountResult.rows[0].count),
      totalStories: parseInt(storyCountResult.rows[0].count),
      totalCharacters: totalCharacters,
      totalImages: embeddedImagesCount + parseInt(imageFilesResult.rows[0].count),
      orphanedFiles: orphanedFilesResult.rows.length,
      databaseSize: databaseSize
    };

    log.info(`✅ [ADMIN] Stats: ${stats.totalUsers} users, ${stats.totalStories} stories, ${stats.totalCharacters} characters, ${stats.totalImages} total images, ${stats.orphanedFiles} orphaned files, DB size: ${stats.databaseSize}`);

    res.json(stats);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Get token usage statistics
app.get('/api/admin/token-usage', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    console.log('📊 [ADMIN] Fetching token usage statistics...');

    // Get all stories with their token usage data
    const storiesResult = await dbPool.query(`
      SELECT
        s.id,
        s.user_id,
        s.data,
        s.created_at,
        u.email as user_email,
        u.username as user_name
      FROM stories s
      LEFT JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at DESC
    `);

    // Aggregate token usage
    const totals = {
      anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
      gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
    };

    const byUser = {};
    const byStoryType = {};
    const byMonth = {};
    const storiesWithUsage = [];
    let storiesWithTokenData = 0;

    for (const row of storiesResult.rows) {
      try {
        const storyData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        const tokenUsage = storyData.tokenUsage;

        if (tokenUsage) {
          storiesWithTokenData++;

          // Add to totals
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              totals[provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              totals[provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              totals[provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Calculate book pages for this story (+3 for title, initial, back cover)
          const storyPages = storyData.pages || 0;
          const bookPages = storyPages + 3;

          // Aggregate by user
          const userKey = row.user_email || row.user_id || 'unknown';
          if (!byUser[userKey]) {
            byUser[userKey] = {
              userId: row.user_id,
              email: row.user_email,
              name: row.user_name,
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
            };
          }
          byUser[userKey].storyCount++;
          byUser[userKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byUser[userKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byUser[userKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byUser[userKey][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Aggregate by story type
          const storyType = storyData.storyType || 'unknown';
          if (!byStoryType[storyType]) {
            byStoryType[storyType] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
            };
          }
          byStoryType[storyType].storyCount++;
          byStoryType[storyType].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byStoryType[storyType][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byStoryType[storyType][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byStoryType[storyType][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Aggregate by month
          const monthKey = row.created_at ? new Date(row.created_at).toISOString().substring(0, 7) : 'unknown';
          if (!byMonth[monthKey]) {
            byMonth[monthKey] = {
              storyCount: 0,
              totalBookPages: 0,
              anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
              gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 }
            };
          }
          byMonth[monthKey].storyCount++;
          byMonth[monthKey].totalBookPages += bookPages;
          for (const provider of Object.keys(totals)) {
            if (tokenUsage[provider]) {
              byMonth[monthKey][provider].input_tokens += tokenUsage[provider].input_tokens || 0;
              byMonth[monthKey][provider].output_tokens += tokenUsage[provider].output_tokens || 0;
              byMonth[monthKey][provider].calls += tokenUsage[provider].calls || 0;
            }
          }

          // Add to detailed list (last 50 stories)
          if (storiesWithUsage.length < 50) {
            // Book pages = story pages + 3 (title page, initial page, back cover)
            const storyPages = storyData.pages || 0;
            const bookPages = storyPages + 3;
            storiesWithUsage.push({
              id: row.id,
              title: storyData.title,
              storyType: storyData.storyType,
              storyPages: storyPages,
              bookPages: bookPages,  // +3 for title, initial, back cover
              userId: row.user_id,
              userEmail: row.user_email,
              createdAt: row.created_at,
              tokenUsage
            });
          }
        }
      } catch (parseErr) {
        console.warn('⚠️ [ADMIN] Error parsing story data:', parseErr.message);
      }
    }

    // Calculate costs (approximate)
    // Claude Sonnet 4.5: $3/MTok input, $15/MTok output
    // Gemini Flash: $0.075/MTok input, $0.30/MTok output (approximate)
    const costs = {
      anthropic: {
        input: (totals.anthropic.input_tokens / 1000000) * 3,
        output: (totals.anthropic.output_tokens / 1000000) * 15,
        total: 0
      },
      gemini_text: {
        input: (totals.gemini_text.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_text.output_tokens / 1000000) * 0.30,
        total: 0
      },
      gemini_image: {
        input: (totals.gemini_image.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_image.output_tokens / 1000000) * 0.30,
        total: 0
      },
      gemini_quality: {
        input: (totals.gemini_quality.input_tokens / 1000000) * 0.075,
        output: (totals.gemini_quality.output_tokens / 1000000) * 0.30,
        total: 0
      }
    };
    costs.anthropic.total = costs.anthropic.input + costs.anthropic.output;
    costs.gemini_text.total = costs.gemini_text.input + costs.gemini_text.output;
    costs.gemini_image.total = costs.gemini_image.input + costs.gemini_image.output;
    costs.gemini_quality.total = costs.gemini_quality.input + costs.gemini_quality.output;
    costs.grandTotal = costs.anthropic.total + costs.gemini_text.total + costs.gemini_image.total + costs.gemini_quality.total;

    // Calculate total book pages across all stories
    const totalBookPages = Object.values(byUser).reduce((sum, u) => sum + u.totalBookPages, 0);

    const response = {
      summary: {
        totalStories: storiesResult.rows.length,
        storiesWithTokenData,
        storiesWithoutTokenData: storiesResult.rows.length - storiesWithTokenData,
        totalBookPages  // Total pages across all books (+3 per story for title, initial, back cover)
      },
      totals,
      costs,
      byUser: Object.values(byUser).sort((a, b) =>
        (b.anthropic.input_tokens + b.anthropic.output_tokens) -
        (a.anthropic.input_tokens + a.anthropic.output_tokens)
      ),
      byStoryType,
      byMonth,
      recentStories: storiesWithUsage
    };

    log.info(`✅ [ADMIN] Token usage: ${storiesWithTokenData}/${storiesResult.rows.length} stories have token data`);
    log.debug(`   Anthropic: ${totals.anthropic.input_tokens.toLocaleString()} in / ${totals.anthropic.output_tokens.toLocaleString()} out`);
    console.log(`   Estimated cost: $${costs.grandTotal.toFixed(2)}`);

    res.json(response);
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching token usage:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Clean orphaned files (matches client adminService)
app.post('/api/admin/cleanup-orphaned', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'File cleanup is only available in database mode' });
    }

    console.log('🗑️ [ADMIN] Cleaning all orphaned files...');

    // Delete all files with story_id that doesn't exist in stories table
    const result = await dbPool.query(`
      DELETE FROM files
      WHERE story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_id
        )
    `);

    const cleaned = result.rowCount || 0;
    log.info(`✅ [ADMIN] Cleaned ${cleaned} orphaned files`);

    res.json({ cleaned });
  } catch (err) {
    console.error('❌ [ADMIN] Error cleaning orphaned files:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Clear cache
app.post('/api/admin/clear-cache', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    console.log('🧹 [ADMIN] Clearing all caches...');

    // Clear image cache
    if (typeof imageCache !== 'undefined' && imageCache.clear) {
      imageCache.clear();
      console.log('✅ [ADMIN] Image cache cleared');
    }

    // Clear any other caches as needed
    // Add more cache clearing logic here if needed

    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (err) {
    console.error('❌ [ADMIN] Error clearing cache:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Delete orphaned files
app.delete('/api/admin/orphaned-files', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'File deletion is only available in database mode' });
    }

    const { fileId } = req.body; // If fileId is 'all', delete all orphaned files

    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required (use "all" to delete all orphaned files)' });
    }

    let deletedCount = 0;

    if (fileId === 'all') {
      console.log('🗑️ [ADMIN] Deleting all orphaned files...');

      // Delete all files with story_id that doesn't exist in stories table
      const result = await dbPool.query(`
        DELETE FROM files
        WHERE story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = files.story_id
          )
      `);

      deletedCount = result.rowCount;
      log.info(`✅ [ADMIN] Deleted ${deletedCount} orphaned files`);
    } else {
      console.log(`🗑️ [ADMIN] Deleting orphaned file: ${fileId}`);

      // First verify the file is actually orphaned
      const checkResult = await dbPool.query(`
        SELECT f.id, f.story_id
        FROM files f
        WHERE f.id = $1
          AND f.story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = f.story_id
          )
      `, [fileId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'File not found or not orphaned' });
      }

      // Delete the file
      await dbPool.query('DELETE FROM files WHERE id = $1', [fileId]);
      deletedCount = 1;
      log.info(`✅ [ADMIN] Deleted orphaned file: ${fileId}`);
    }

    res.json({
      success: true,
      deletedCount,
      message: `Successfully deleted ${deletedCount} orphaned file(s)`
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error deleting orphaned files:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Get server configuration
app.get('/api/admin/config', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    res.json({
      textModel: {
        current: TEXT_MODEL,
        config: activeTextModel,
        available: Object.entries(TEXT_MODELS).map(([key, model]) => ({
          key,
          ...model
        }))
      },
      storyBatchSize: STORY_BATCH_SIZE || 5,
      verboseLogging: VERBOSE_LOGGING,
      storageMode: STORAGE_MODE,
      apiKeys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY
      }
    });
  } catch (err) {
    console.error('Error fetching config:', err);
    res.status(500).json({ error: 'Failed to fetch configuration' });
  }
});

// Admin Dashboard - Get database table sizes
app.get('/api/admin/database-size', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'Database size check is only available in database mode' });
    }

    // Query table sizes
    const tableSizes = await dbPool.query(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
        pg_total_relation_size(schemaname||'.'||tablename) AS size_bytes
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);

    // Get row counts for each table dynamically
    const rowCountMap = {};
    for (const table of tableSizes.rows) {
      try {
        const result = await dbPool.query(`SELECT COUNT(*) as row_count FROM ${table.tablename}`);
        rowCountMap[table.tablename] = parseInt(result.rows[0].row_count);
      } catch (err) {
        log.warn(`Could not get row count for table ${table.tablename}:`, err.message);
        rowCountMap[table.tablename] = 0;
      }
    }

    // Get total database size
    const dbSize = await dbPool.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as total_size,
             pg_database_size(current_database()) as total_size_bytes
    `);

    res.json({
      totalSize: dbSize.rows[0].total_size,
      totalSizeBytes: parseInt(dbSize.rows[0].total_size_bytes),
      tables: tableSizes.rows.map(row => ({
        tablename: row.tablename,
        size: row.size,
        size_bytes: parseInt(row.size_bytes),
        row_count: rowCountMap[row.tablename] || 0
      }))
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching database size:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Get storage usage per user
app.get('/api/admin/user-storage', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database') {
      return res.status(400).json({ error: 'User storage check is only available in database mode' });
    }

    // Get storage usage per user
    const userStorage = await dbPool.query(`
      WITH user_data AS (
        SELECT
          u.id,
          u.username,
          u.email,
          u.role,
          u.created_at,
          COALESCE(SUM(LENGTH(s.data::text)), 0) as stories_size,
          COUNT(DISTINCT s.id) as story_count,
          COALESCE(SUM(LENGTH(f.data::text)), 0) as files_size,
          COUNT(DISTINCT f.id) as file_count,
          COUNT(DISTINCT c.id) as character_count
        FROM users u
        LEFT JOIN stories s ON u.id = s.user_id
        LEFT JOIN files f ON u.id = f.user_id
        LEFT JOIN characters c ON u.id = c.user_id
        GROUP BY u.id, u.username, u.email, u.role, u.created_at
      )
      SELECT
        id,
        username,
        email,
        role,
        created_at,
        stories_size,
        story_count,
        files_size,
        file_count,
        character_count,
        (stories_size + files_size) as total_size
      FROM user_data
      ORDER BY total_size DESC
    `);

    // Format sizes in human-readable format
    const formatSize = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
    };

    const users = userStorage.rows.map(row => ({
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      storyCount: parseInt(row.story_count),
      fileCount: parseInt(row.file_count),
      characterCount: parseInt(row.character_count),
      storiesSize: formatSize(parseInt(row.stories_size)),
      storiesSizeBytes: parseInt(row.stories_size),
      filesSize: formatSize(parseInt(row.files_size)),
      filesSizeBytes: parseInt(row.files_size),
      totalSize: formatSize(parseInt(row.total_size)),
      totalSizeBytes: parseInt(row.total_size)
    }));

    res.json({ users });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching user storage:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Delete user and all their data
app.delete('/api/admin/users/:userId', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const userIdToDelete = parseInt(req.params.userId);

    if (isNaN(userIdToDelete)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Don't allow deleting yourself
    if (userIdToDelete === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    if (STORAGE_MODE === 'database') {
      // Get user info before deleting
      const userResult = await dbPool.query('SELECT username, email FROM users WHERE id = $1', [userIdToDelete]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      log.info(`🗑️ [ADMIN] Deleting user ${user.username} (${user.email}) and all their data...`);

      // Delete in order due to foreign key constraints
      // 1. Delete story_jobs first
      const deletedJobs = await dbPool.query('DELETE FROM story_jobs WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      log.debug(`   Deleted ${deletedJobs.rows.length} story jobs`);

      // 2. Delete orders (if any)
      const deletedOrders = await dbPool.query('DELETE FROM orders WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      log.debug(`   Deleted ${deletedOrders.rows.length} orders`);

      // 3. Delete stories
      const deletedStories = await dbPool.query('DELETE FROM stories WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      log.debug(`   Deleted ${deletedStories.rows.length} stories`);

      // 4. Delete characters
      const deletedCharacters = await dbPool.query('DELETE FROM characters WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      log.debug(`   Deleted ${deletedCharacters.rows.length} characters`);

      // 5. Delete files
      const deletedFiles = await dbPool.query('DELETE FROM files WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      log.debug(`   Deleted ${deletedFiles.rows.length} files`);

      // 6. Delete activity logs (table may not exist)
      let deletedLogsCount = 0;
      try {
        const deletedLogs = await dbPool.query('DELETE FROM activity_log WHERE user_id = $1 RETURNING id', [userIdToDelete]);
        deletedLogsCount = deletedLogs.rows.length;
        log.debug(`   Deleted ${deletedLogsCount} activity logs`);
      } catch (err) {
        console.log(`   Activity log table not found, skipping`);
      }

      // 7. Finally, delete the user
      await dbPool.query('DELETE FROM users WHERE id = $1', [userIdToDelete]);
      log.debug(`   Deleted user account`);

      log.info(`✅ [ADMIN] Successfully deleted user ${user.username} and all associated data`);

      res.json({
        success: true,
        message: `User ${user.username} and all associated data deleted successfully`,
        deletedCounts: {
          storyJobs: deletedJobs.rows.length,
          orders: deletedOrders.rows.length,
          stories: deletedStories.rows.length,
          characters: deletedCharacters.rows.length,
          files: deletedFiles.rows.length,
          activityLogs: deletedLogsCount
        }
      });
    } else {
      // File mode - delete from users.json
      const users = await readJSON(USERS_FILE);
      const userIndex = users.findIndex(u => u.id === userIdToDelete);

      if (userIndex === -1) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = users[userIndex];
      log.info(`🗑️ [ADMIN] Deleting user ${user.username} (${user.email}) from file storage...`);

      users.splice(userIndex, 1);
      await writeJSON(USERS_FILE, users);

      // Note: In file mode, we don't delete stories/files as they are not linked to users
      log.info(`✅ [ADMIN] Successfully deleted user ${user.username}`);

      res.json({
        success: true,
        message: `User ${user.username} deleted successfully`
      });
    }
  } catch (err) {
    console.error('❌ [ADMIN] Error deleting user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Impersonate user (view app as another user)
app.post('/api/admin/impersonate/:userId', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin (and not already impersonating)
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // Prevent nested impersonation
    if (req.user.impersonating) {
      return res.status(400).json({ error: 'Cannot impersonate while already impersonating. Stop current impersonation first.' });
    }

    const targetUserId = req.params.userId;

    // Get the target user
    let targetUser;
    if (STORAGE_MODE === 'database' && dbPool) {
      const result = await dbPool.query('SELECT id, username, email, role FROM users WHERE id = $1', [targetUserId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      targetUser = result.rows[0];
    } else {
      const users = await readJSON(USERS_FILE);
      targetUser = users.find(u => String(u.id) === String(targetUserId));
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }
    }

    // Don't allow impersonating yourself
    if (String(targetUser.id) === String(req.user.id)) {
      return res.status(400).json({ error: 'Cannot impersonate yourself' });
    }

    log.info(`👤 [ADMIN] ${req.user.username} is impersonating user ${targetUser.username}`);

    // Generate impersonation token - includes both the target user info AND the original admin info
    const impersonationToken = jwt.sign(
      {
        id: targetUser.id,
        username: targetUser.username,
        role: targetUser.role,
        impersonating: true,
        originalAdminId: req.user.id,
        originalAdminUsername: req.user.username,
        originalAdminRole: 'admin'
      },
      JWT_SECRET,
      { expiresIn: '2h' } // Shorter expiry for impersonation tokens
    );

    res.json({
      token: impersonationToken,
      user: {
        id: targetUser.id,
        username: targetUser.username,
        email: targetUser.email,
        role: targetUser.role
      },
      impersonating: true,
      originalAdmin: {
        id: req.user.id,
        username: req.user.username
      }
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error impersonating user:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Dashboard - Stop impersonating
app.post('/api/admin/stop-impersonate', authenticateToken, async (req, res) => {
  try {
    // Check if currently impersonating
    if (!req.user.impersonating || !req.user.originalAdminId) {
      return res.status(400).json({ error: 'Not currently impersonating anyone' });
    }

    const originalAdminId = req.user.originalAdminId;

    // Get the original admin user
    let adminUser;
    if (STORAGE_MODE === 'database' && dbPool) {
      const result = await dbPool.query('SELECT id, username, email, role, credits FROM users WHERE id = $1', [originalAdminId]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Original admin user not found' });
      }
      adminUser = result.rows[0];
    } else {
      const users = await readJSON(USERS_FILE);
      adminUser = users.find(u => String(u.id) === String(originalAdminId));
      if (!adminUser) {
        return res.status(404).json({ error: 'Original admin user not found' });
      }
    }

    log.info(`👤 [ADMIN] ${req.user.originalAdminUsername} stopped impersonating ${req.user.username}`);

    // Generate a fresh admin token
    const adminToken = jwt.sign(
      {
        id: adminUser.id,
        username: adminUser.username,
        role: adminUser.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token: adminToken,
      user: {
        id: adminUser.id,
        username: adminUser.username,
        email: adminUser.email,
        role: adminUser.role,
        credits: adminUser.credits
      },
      impersonating: false
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error stopping impersonation:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// HEALTH ROUTES - MIGRATED TO server/routes/health.js
// =============================================================================
/* COMMENTED OUT - Now served from modular routes
// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// IP check endpoint - shows Railway's outgoing IP
app.get('/api/check-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({
      railwayOutgoingIp: data.ip,
      requestIp: req.ip,
      forwardedFor: req.headers['x-forwarded-for'],
      message: 'Railway outgoing IP address for debugging'
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Browser error logging endpoint - receives errors from frontend
app.post('/api/log-error', (req, res) => {
  try {
    const { message, stack, url, line, column, userAgent, userId, timestamp, errorType } = req.body;

    // Log to console with emoji for visibility in Railway logs
    console.error('🔴 BROWSER ERROR:', {
      type: errorType || 'JavaScript Error',
      message,
      url,
      location: line && column ? `Line ${line}, Column ${column}` : 'Unknown',
      user: userId || 'Anonymous',
      userAgent: userAgent || 'Unknown',
      timestamp: timestamp || new Date().toISOString(),
      stack: stack ? stack.substring(0, 500) : 'No stack trace' // Limit stack trace length
    });

    res.json({ success: true, message: 'Error logged' });
  } catch (err) {
    console.error('Error logging browser error:', err);
    res.status(500).json({ success: false, error: 'Failed to log error' });
  }
});
END OF HEALTH ROUTES */

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
    console.log(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}, Cover: ${coverType}`);

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

    // Calculate price based on pages and cover type
    const isHardcover = coverType === 'hardcover';
    let price;
    if (totalPages <= 32) {
      price = isHardcover ? 4900 : 3600; // CHF 49 or 36
    } else if (totalPages <= 64) {
      price = isHardcover ? 5900 : 4600; // CHF 59 or 46
    } else {
      price = isHardcover ? 6900 : 5600; // CHF 69 or 56
    }

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
    console.log(`   Stories: ${stories.length}, Pages: ${totalPages}, Price: CHF ${price / 100}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('❌ Error creating checkout session:', err);
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
    console.log(`   Mode: ${isTestMode ? 'TEST (admin)' : 'LIVE (real payment)'}`);
    console.log(`   Credits: ${credits}, Amount: CHF ${(amount / 100).toFixed(2)}`);

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
    console.error('❌ Error creating credits checkout session:', err);
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
          console.log(`⏳ Order not found yet, waiting... (attempt ${attempt}/${maxRetries})`);
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
    console.error('❌ Error checking order status:', err);
    res.status(500).json({ error: 'Failed to check order status' });
  }
});

// Background function to process book orders after payment
// isTestPayment: true = admin/developer (Gelato draft), false = real user (Gelato real order)
// coverType: 'softcover' or 'hardcover' - determines which product to use
async function processBookOrder(sessionId, userId, storyIds, customerInfo, shippingAddress, isTestPayment = false, coverType = 'softcover') {
  // Normalize storyIds to array (backwards compatible with single storyId)
  const allStoryIds = Array.isArray(storyIds) ? storyIds : [storyIds];

  console.log(`📚 [BACKGROUND] Starting book order processing for session ${sessionId}`);
  console.log(`   Stories: ${allStoryIds.length} (${allStoryIds.join(', ')})`);
  console.log(`   Payment mode: ${isTestPayment ? 'TEST (Gelato draft)' : 'LIVE (real Gelato order)'}`);
  console.log(`   Cover type: ${coverType}`);

  // Determine Gelato order type based on payment mode
  const gelatoOrderType = isTestPayment ? 'draft' : 'order';

  try {
    // Step 1: Update order status to "processing"
    await dbPool.query(`
      UPDATE orders
      SET payment_status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $1
    `, [sessionId]);
    console.log('✅ [BACKGROUND] Order status updated to processing');

    // Step 2: Fetch all stories from database
    const stories = [];
    for (const sid of allStoryIds) {
      const storyResult = await dbPool.query('SELECT data FROM stories WHERE id = $1', [sid]);
      if (storyResult.rows.length === 0) {
        throw new Error(`Story ${sid} not found`);
      }
      let storyData = storyResult.rows[0].data;
      if (typeof storyData === 'string') {
        storyData = JSON.parse(storyData);
      }
      stories.push({ id: sid, data: storyData });
    }

    console.log(`✅ [BACKGROUND] Fetched ${stories.length} stories`);
    console.log('📊 [BACKGROUND] Titles:', stories.map(s => s.data.title).join(', '));

    // Step 3: Generate PDF (single story uses generatePrintPdf, multiple uses combined book)
    let pdfBuffer, targetPageCount;

    if (stories.length === 1) {
      // Single story - use existing generatePrintPdf
      console.log('📄 [BACKGROUND] Generating single-story PDF...');
      const result = await generatePrintPdf(stories[0].data);
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    } else {
      // Multiple stories - generate combined book PDF
      console.log('📄 [BACKGROUND] Generating combined multi-story PDF...');
      const result = await generateCombinedBookPdf(stories);
      pdfBuffer = result.pdfBuffer;
      targetPageCount = result.pageCount;
    }

    const pdfBase64 = pdfBuffer.toString('base64');
    console.log(`✅ [BACKGROUND] PDF generated: ${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB, ${targetPageCount} pages`);

    // Step 3.5: Save PDF to database and get public URL
    console.log('💾 [BACKGROUND] Saving PDF to database...');
    const primaryStoryId = allStoryIds[0];
    const pdfFileId = `pdf-${primaryStoryId}-${Date.now()}`;
    const pdfInsertQuery = `
      INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET file_data = EXCLUDED.file_data
      RETURNING id
    `;
    const filename = allStoryIds.length > 1
      ? `book-${allStoryIds.length}-stories.pdf`
      : `story-${primaryStoryId}.pdf`;
    await dbPool.query(pdfInsertQuery, [
      pdfFileId,
      userId,
      'order_pdf',
      primaryStoryId,
      'application/pdf',
      pdfBase64,
      pdfBuffer.length,
      filename
    ]);

    // Get the base URL from environment or construct it
    const baseUrl = process.env.BASE_URL || 'https://www.magicalstory.ch';
    const pdfUrl = `${baseUrl}/api/files/${pdfFileId}`;
    console.log(`✅ [BACKGROUND] PDF saved with URL: ${pdfUrl}`);

    // Step 4: Create print order
    console.log('📦 [BACKGROUND] Creating print order...');

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      throw new Error('GELATO_API_KEY not configured');
    }

    // Use the same targetPageCount calculated during PDF generation (already added blank pages)
    const printPageCount = targetPageCount;
    log.debug(`📊 [BACKGROUND] Using PDF page count for Gelato: ${printPageCount}`);

    // Fetch product UID from database based on page count and cover type
    let printProductUid = null;
    try {
      // Debug: log all active products
      const allProductsResult = await dbPool.query(
        'SELECT product_uid, product_name, cover_type, min_pages, max_pages FROM gelato_products WHERE is_active = true'
      );
      log.debug(`📦 [BACKGROUND] Active products: ${allProductsResult.rows.length}, looking for "${coverType}" with ${printPageCount} pages`);
      allProductsResult.rows.forEach((p, i) => {
        log.debug(`   ${i+1}. "${p.product_name}" cover_type="${p.cover_type}" pages=${p.min_pages}-${p.max_pages}`);
      });

      const productsResult = await dbPool.query(
        'SELECT product_uid, product_name, min_pages, max_pages, available_page_counts, cover_type FROM gelato_products WHERE is_active = true AND LOWER(cover_type) = LOWER($1)',
        [coverType]
      );

      log.debug(`📦 [BACKGROUND] Products matching "${coverType}": ${productsResult.rows.length}`);

      if (productsResult.rows.length > 0) {
        // Find product matching the page count
        const matchingProduct = productsResult.rows.find(p => {
          if (p.available_page_counts) {
            const availableCounts = JSON.parse(p.available_page_counts || '[]');
            return availableCounts.includes(printPageCount);
          }
          // Fallback: check min/max range
          return printPageCount >= (p.min_pages || 0) && printPageCount <= (p.max_pages || 999);
        });

        if (matchingProduct) {
          printProductUid = matchingProduct.product_uid;
          console.log(`✅ [BACKGROUND] Found matching ${coverType} product: ${matchingProduct.product_name}`);
        } else {
          log.warn(`[BACKGROUND] No ${coverType} product matches page count ${printPageCount}`);
        }
      } else {
        // Log all products to help debug
        const availableTypes = allProductsResult.rows.map(p => `"${p.cover_type}"`).join(', ');
        log.warn(`[BACKGROUND] No active ${coverType} products found. Available cover_types: ${availableTypes || 'none'}`);
      }
    } catch (err) {
      console.error('❌ [BACKGROUND] Error fetching products:', err.message);
    }

    // Fallback to environment variable or first active product of any type
    if (!printProductUid) {
      // Try to get any active product as fallback
      try {
        const fallbackResult = await dbPool.query(
          'SELECT product_uid, product_name FROM gelato_products WHERE is_active = true LIMIT 1'
        );
        if (fallbackResult.rows.length > 0) {
          printProductUid = fallbackResult.rows[0].product_uid;
          log.warn(`[BACKGROUND] Using fallback product: ${fallbackResult.rows[0].product_name}`);
        }
      } catch (err) {
        console.error('❌ [BACKGROUND] Error fetching fallback product:', err.message);
      }
    }

    // Final fallback to environment variable
    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID;
      if (printProductUid) {
        log.warn(`[BACKGROUND] Using environment fallback product UID`);
      } else {
        throw new Error('No active products configured. Please add products in admin dashboard.');
      }
    }

    // Use gelatoOrderType determined from isTestPayment parameter
    log.debug(`📦 [BACKGROUND] Creating Gelato ${gelatoOrderType} order`);

    // Use CHF currency for print orders
    const currency = 'CHF';

    // Create order reference using first story ID or combined if multiple
    const orderRefId = storyIds.length === 1 ? storyIds[0] : `multi-${storyIds.length}-${storyIds[0]}`;

    const printOrderPayload = {
      orderType: gelatoOrderType,
      orderReferenceId: `story-${orderRefId}-${Date.now()}`,
      customerReferenceId: userId,
      currency: currency,
      items: [{
        itemReferenceId: `item-${orderRefId}-${Date.now()}`,
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
        firstName: customerInfo.name.split(' ')[0] || customerInfo.name,
        lastName: customerInfo.name.split(' ').slice(1).join(' ') || '',
        addressLine1: shippingAddress.line1 || '',
        addressLine2: shippingAddress.line2 || '',
        city: shippingAddress.city || '',
        postCode: shippingAddress.postal_code || '',
        state: shippingAddress.state || '',
        country: shippingAddress.country || 'CH',
        email: customerInfo.email,
        phone: shippingAddress.phone || ''
      }
    };

    log.debug(`📦 [BACKGROUND] Print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, orderType=${gelatoOrderType}`);

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
      throw new Error(`Print provider API error: ${printResponse.status} - ${errorText}`);
    }

    const printOrder = await printResponse.json();
    console.log('✅ [BACKGROUND] Print order created:', printOrder.orderId);

    // Step 5: Update order with print order ID and status
    await dbPool.query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $2
    `, [printOrder.orderId, sessionId]);

    console.log('🎉 [BACKGROUND] Book order processing completed successfully!');

  } catch (error) {
    console.error('❌ [BACKGROUND] Error processing book order:', error);

    // Update order status to failed
    try {
      await dbPool.query(`
        UPDATE orders
        SET payment_status = 'failed',
            updated_at = CURRENT_TIMESTAMP
        WHERE stripe_session_id = $1
      `, [sessionId]);
    } catch (updateError) {
      console.error('❌ [BACKGROUND] Failed to update order status:', updateError);
    }

    // Send failure notification email to customer
    try {
      const { sendEmail } = require('./email.js');
      await sendEmail({
        to: customerInfo.email,
        subject: 'Book Order Failed - MagicalStory',
        text: `Dear ${customerInfo.name},

Unfortunately, your book order could not be processed.

Error: ${error.message}

Please contact us at support@magicalstory.ch for assistance.

We apologize for the inconvenience.

Best regards,
The MagicalStory Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #dc2626;">Book Order Failed</h2>
            <p>Dear ${customerInfo.name},</p>
            <p>Unfortunately, your book order could not be processed.</p>
            <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <strong>Error:</strong> ${error.message}
            </div>
            <p>Please contact us at <a href="mailto:support@magicalstory.ch">support@magicalstory.ch</a> for assistance.</p>
            <p>We apologize for the inconvenience.</p>
            <p>Best regards,<br>The MagicalStory Team</p>
          </div>
        `
      });
      console.log(`📧 [BACKGROUND] Failure notification sent to ${customerInfo.email}`);
    } catch (emailError) {
      console.error('❌ [BACKGROUND] Failed to send failure email:', emailError);
    }

    throw error;
  }
}

// ===================================
// BACKGROUND STORY GENERATION JOBS
// ===================================

// Art styles definitions (matches index.html)
const ART_STYLES = {
  pixar: 'pixar style 3d character, vibrant Disney/Pixar 3D animation, warm lighting, child-friendly',
  cartoon: '2D cartoon style, bold outlines, vibrant flat colors, classic animation look',
  anime: 'anime style, Japanese animation, expressive eyes, dynamic poses, cel-shaded',
  chibi: 'chibi style, super deformed, cute, big head, small body, kawaii, adorable',
  steampunk: 'steampunk anime style, Victorian era, gears, brass, copper, goggles, mechanical details, vintage technology, anime influenced',
  comic: 'comic book style, bold ink lines, halftone dots, dynamic action, speech bubbles aesthetic, superhero comic art',
  manga: 'manga style, Japanese comic art, detailed linework, screentones, dramatic shading, expressive characters',
  watercolor: 'watercolor painting style, soft edges, flowing colors, delicate washes, artistic brushstrokes, dreamy atmosphere, traditional watercolor illustration'
};

// Language level definitions - controls text length per page
const LANGUAGE_LEVELS = {
  '1st-grade': {
    description: 'Simple words and very short sentences for early readers',
    wordsPerPageMin: 20,
    wordsPerPageMax: 35,
  },
  'standard': {
    description: 'Age-appropriate vocabulary for elementary school children',
    wordsPerPageMin: 120,
    wordsPerPageMax: 150,
  },
  'advanced': {
    description: 'More complex vocabulary and varied sentence structure for advanced readers',
    wordsPerPageMin: 250,
    wordsPerPageMax: 300,
  }
};

// Helper function to get reading level text for prompts
function getReadingLevel(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  const pageLength = languageLevel === '1st-grade'
    ? `2-3 sentences per page (approximately ${levelInfo.wordsPerPageMin}-${levelInfo.wordsPerPageMax} words)`
    : `approximately ${levelInfo.wordsPerPageMin}-${levelInfo.wordsPerPageMax} words per page`;
  return `${levelInfo.description}. ${pageLength}`;
}

// Helper function to estimate tokens per page for batch size calculation
function getTokensPerPage(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  // Use max words, multiply by ~1.3 tokens/word (English average), add 2x safety margin
  const tokensPerPage = Math.ceil(levelInfo.wordsPerPageMax * 1.3 * 2);
  return tokensPerPage;
}

// Helper function to parse Visual Bible from outline
// Now includes mainCharacters (populated separately) and changeLog
function parseVisualBible(outline) {
  const visualBible = {
    mainCharacters: [],      // Populated from inputData.characters
    secondaryCharacters: [], // Parsed from outline
    animals: [],             // Parsed from outline
    artifacts: [],           // Parsed from outline
    locations: [],           // Parsed from outline
    changeLog: []            // Track all updates during story generation
  };

  if (!outline) return visualBible;

  // Log outline length for debugging
  log.debug(`📖 [VISUAL BIBLE] Parsing outline, length: ${outline.length} chars`);

  // Check if outline contains Visual Bible mention at all (case-insensitive)
  if (!outline.toLowerCase().includes('visual bible')) {
    console.log('📖 [VISUAL BIBLE] Outline does not contain "Visual Bible" text');
    return visualBible;
  }

  // Find the Visual Bible section - simplified regex
  // Matches: "# VISUAL BIBLE", "## Visual Bible", "# Part 5: Visual Bible", etc.
  const visualBibleMatch = outline.match(/#+\s*(?:Part\s*\d+[:\s]*)?Visual\s*Bible\b([\s\S]*?)(?=\n#[^#]|\n---|$)/i);
  if (!visualBibleMatch) {
    console.log('📖 [VISUAL BIBLE] Regex did not match Visual Bible section');
    // Try alternate regex patterns
    const altMatch = outline.match(/Visual\s*Bible[\s\S]{0,50}/i);
    if (altMatch) {
      log.debug(`📖 [VISUAL BIBLE] Found text near "Visual Bible": "${altMatch[0].substring(0, 100)}..."`);
    }
    return visualBible;
  }

  const visualBibleSection = visualBibleMatch[1];
  log.debug(`📖 [VISUAL BIBLE] Found section, length: ${visualBibleSection.length} chars`);
  log.debug(`📖 [VISUAL BIBLE] Section preview: "${visualBibleSection.substring(0, 200)}..."`);

  // Log what subsections we find
  log.debug(`📖 [VISUAL BIBLE] Looking for ### Secondary Characters...`);
  log.debug(`📖 [VISUAL BIBLE] Looking for ### Animals...`);
  log.debug(`📖 [VISUAL BIBLE] Looking for ### Artifacts...`);
  log.debug(`📖 [VISUAL BIBLE] Looking for ### Locations...`);

  // Parse Secondary Characters (supports ## or ### headers)
  const secondaryCharsMatch = visualBibleSection.match(/#{2,3}\s*Secondary\s*Characters?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (secondaryCharsMatch) {
    log.debug(`📖 [VISUAL BIBLE] Secondary Characters section found, length: ${secondaryCharsMatch[1].length}`);
    if (!secondaryCharsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(secondaryCharsMatch[1]);
      visualBible.secondaryCharacters = entries;
      log.debug(`📖 [VISUAL BIBLE] Parsed ${entries.length} secondary characters`);
    } else {
      log.debug(`📖 [VISUAL BIBLE] Secondary Characters section contains "None"`);
    }
  } else {
    log.debug(`📖 [VISUAL BIBLE] No Secondary Characters section found`);
  }

  // Parse Animals & Creatures (supports ## or ### headers)
  const animalsMatch = visualBibleSection.match(/#{2,3}\s*Animals?\s*(?:&|and)?\s*Creatures?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (animalsMatch) {
    log.debug(`📖 [VISUAL BIBLE] Animals section found, length: ${animalsMatch[1].length}`);
    if (!animalsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(animalsMatch[1]);
      visualBible.animals = entries;
      log.debug(`📖 [VISUAL BIBLE] Parsed ${entries.length} animals`);
    } else {
      log.debug(`📖 [VISUAL BIBLE] Animals section contains "None"`);
    }
  } else {
    log.debug(`📖 [VISUAL BIBLE] No Animals section found`);
  }

  // Parse Artifacts (supports ## or ### headers, also "Important Artifacts")
  const artifactsMatch = visualBibleSection.match(/#{2,3}\s*(?:Important\s*)?Artifacts?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (artifactsMatch) {
    log.debug(`📖 [VISUAL BIBLE] Artifacts section found, length: ${artifactsMatch[1].length}`);
    if (!artifactsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(artifactsMatch[1]);
      visualBible.artifacts = entries;
      log.debug(`📖 [VISUAL BIBLE] Parsed ${entries.length} artifacts`);
    } else {
      log.debug(`📖 [VISUAL BIBLE] Artifacts section contains "None"`);
    }
  } else {
    log.debug(`📖 [VISUAL BIBLE] No Artifacts section found`);
  }

  // Parse Locations (supports ## or ### headers, also "Recurring Locations")
  const locationsMatch = visualBibleSection.match(/#{2,3}\s*(?:Recurring\s*)?Locations?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (locationsMatch) {
    log.debug(`📖 [VISUAL BIBLE] Locations section found, length: ${locationsMatch[1].length}`);
    if (!locationsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(locationsMatch[1]);
      visualBible.locations = entries;
      log.debug(`📖 [VISUAL BIBLE] Parsed ${entries.length} locations`);
    } else {
      log.debug(`📖 [VISUAL BIBLE] Locations section contains "None"`);
    }
  } else {
    log.debug(`📖 [VISUAL BIBLE] No Locations section found`);
  }

  const totalEntries = visualBible.secondaryCharacters.length +
                       visualBible.animals.length +
                       visualBible.artifacts.length +
                       visualBible.locations.length;

  log.debug(`📖 [VISUAL BIBLE] Parsed ${totalEntries} entries: ` +
    `${visualBible.secondaryCharacters.length} characters, ` +
    `${visualBible.animals.length} animals, ` +
    `${visualBible.artifacts.length} artifacts, ` +
    `${visualBible.locations.length} locations`);

  return visualBible;
}

/**
 * Filter out main characters from Visual Bible secondary characters
 * This is a safety net in case Claude includes main characters despite the prompt instruction
 * @param {Object} visualBible - Parsed Visual Bible object
 * @param {Array} mainCharacters - Array of main character objects with name property
 * @returns {Object} Visual Bible with filtered secondary characters
 */
function filterMainCharactersFromVisualBible(visualBible, mainCharacters) {
  if (!visualBible || !mainCharacters || mainCharacters.length === 0) {
    return visualBible;
  }

  // Build set of main character names (lowercase for case-insensitive matching)
  const mainNames = new Set(mainCharacters.map(c => c.name?.toLowerCase()).filter(Boolean));

  if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
    const originalCount = visualBible.secondaryCharacters.length;
    visualBible.secondaryCharacters = visualBible.secondaryCharacters.filter(sc => {
      const scName = sc.name?.toLowerCase();
      const isMainChar = mainNames.has(scName);
      if (isMainChar) {
        console.log(`🚫 [VISUAL BIBLE] Filtering out "${sc.name}" - matches main character`);
      }
      return !isMainChar;
    });
    const filteredCount = originalCount - visualBible.secondaryCharacters.length;
    if (filteredCount > 0) {
      console.log(`🚫 [VISUAL BIBLE] Filtered ${filteredCount} main characters from secondary characters`);
    }
  }

  return visualBible;
}

// Helper to parse individual Visual Bible entries
function parseVisualBibleEntries(sectionText) {
  const entries = [];

  // Log raw section text for debugging
  log.debug(`📖 [VISUAL BIBLE ENTRIES] Parsing section text (${sectionText.length} chars):`);
  log.debug(`📖 [VISUAL BIBLE ENTRIES] First 300 chars: "${sectionText.substring(0, 300)}..."`);

  // Match entries that start with **Name** (pages X, Y, Z)
  // Support English "pages/page", German "Seiten/Seite", French "pages/page"
  const pageKeyword = '(?:pages?|Seiten?|Page)';
  const entryPattern = new RegExp(`\\*\\*([^*]+)\\*\\*\\s*\\(${pageKeyword}\\s*([^)]+)\\)([\\s\\S]*?)(?=\\*\\*[^*]+\\*\\*\\s*\\(${pageKeyword}|$)`, 'gi');
  let match;

  while ((match = entryPattern.exec(sectionText)) !== null) {
    const name = match[1].trim();
    const pagesStr = match[2].trim();
    const descriptionBlock = match[3].trim();

    // Parse page numbers (handle special pages: Title/Front=0, Initial=-1, Back=-2)
    const pages = [];
    const pageTokens = pagesStr.split(/,\s*/);
    for (const token of pageTokens) {
      const t = token.trim().toLowerCase();
      if (t.includes('title') || t.includes('front')) {
        pages.push(0); // Title/Front cover = page 0
      } else if (t.includes('initial')) {
        pages.push(-1); // Initial page = -1
      } else if (t.includes('back')) {
        pages.push(-2); // Back cover = -2
      } else {
        const num = parseInt(t.replace(/\D/g, ''));
        if (!isNaN(num)) {
          pages.push(num);
        }
      }
    }

    // Combine all description lines
    const descriptionLines = descriptionBlock.split('\n')
      .map(line => line.replace(/^[-•]\s*/, '').trim())
      .filter(line => line.length > 0);

    const description = descriptionLines.join('. ');

    log.debug(`📖 [VISUAL BIBLE ENTRIES] Entry "${name}" pages raw: "${pagesStr}" → parsed: [${pages.join(', ')}]`);

    if (name && pages.length > 0) {
      entries.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name,
        appearsInPages: pages,
        description,
        extractedDescription: null, // Will be filled after first image analysis
        firstAppearanceAnalyzed: false
      });
    }
  }

  return entries;
}

// Initialize main characters in Visual Bible from inputData.characters
// Called at the start of story generation to populate mainCharacters array
function initializeVisualBibleMainCharacters(visualBible, characters) {
  if (!visualBible || !characters || !Array.isArray(characters)) {
    return visualBible;
  }

  log.debug(`📖 [VISUAL BIBLE] Initializing ${characters.length} main characters...`);

  visualBible.mainCharacters = characters.map(char => {
    // Build physical description from character data
    // Support both new structure (char.physical.*) and legacy (char.height, char.build, etc.)
    const physical = char.physical || {};
    const mainChar = {
      id: char.id,
      name: char.name,
      physical: {
        age: char.age || 'Unknown',
        gender: char.gender || 'Unknown',
        height: physical.height || char.height || 'Unknown',
        build: physical.build || char.build || 'Unknown',
        face: physical.face || char.other_features || char.otherFeatures || 'Not analyzed',
        hair: physical.hair || char.hair_color || char.hairColor || 'Not analyzed',
        other: physical.other || char.other || ''
      },
      referenceOutfit: char.referenceOutfit || char.reference_outfit || null,
      generatedOutfits: char.generatedOutfits || char.generated_outfits || {}
    };

    // Debug: Log what physical data we're using
    log.debug(`📖 [VISUAL BIBLE] Added main character: ${char.name} (id: ${char.id})`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.age: "${mainChar.physical.age}"`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.gender: "${mainChar.physical.gender}"`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.height: "${mainChar.physical.height}"`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.build: "${mainChar.physical.build}"`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.face: "${mainChar.physical.face?.substring(0, 60)}..."`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.hair: "${mainChar.physical.hair}"`);
    log.debug(`📖 [VISUAL BIBLE]   - physical.other: "${mainChar.physical.other}"`);
    return mainChar;
  });

  return visualBible;
}

// Add a change log entry to Visual Bible
function addVisualBibleChangeLog(visualBible, pageNumber, element, type, change, before, after) {
  if (!visualBible) return;

  const entry = {
    timestamp: new Date().toISOString(),
    page: pageNumber,
    element,
    type,
    change,
    before: before || null,
    after
  };

  visualBible.changeLog.push(entry);
  console.log(`📖 [VISUAL BIBLE CHANGE] Page ${pageNumber}: ${element} (${type}) - ${change}`);
}

// Update main character's generated outfit in Visual Bible
function updateMainCharacterOutfit(visualBible, characterId, pageNumber, outfit) {
  if (!visualBible || !characterId) return;

  const mainChar = visualBible.mainCharacters.find(c => c.id === characterId);
  if (!mainChar) {
    log.debug(`📖 [VISUAL BIBLE] Main character ${characterId} not found for outfit update`);
    return;
  }

  const previousOutfit = mainChar.generatedOutfits[pageNumber]?.outfit || null;
  mainChar.generatedOutfits[pageNumber] = outfit;

  addVisualBibleChangeLog(
    visualBible,
    pageNumber,
    mainChar.name,
    'generatedOutfit',
    previousOutfit ? 'Updated outfit' : 'New outfit extracted',
    previousOutfit,
    outfit.outfit
  );

  log.debug(`📖 [VISUAL BIBLE] Updated outfit for ${mainChar.name} on page ${pageNumber}`);
}

// Get Visual Bible entries relevant to a specific page
function getVisualBibleEntriesForPage(visualBible, pageNumber) {
  if (!visualBible) return [];

  const relevant = [];

  const checkEntries = (entries, type) => {
    for (const entry of entries) {
      if (entry.appearsInPages.includes(pageNumber)) {
        relevant.push({ ...entry, type });
      }
    }
  };

  checkEntries(visualBible.secondaryCharacters || [], 'character');
  checkEntries(visualBible.animals || [], 'animal');
  checkEntries(visualBible.artifacts || [], 'artifact');
  checkEntries(visualBible.locations || [], 'location');

  return relevant;
}

// Build Visual Bible prompt section for image generation
// Includes ALL visual bible elements (not filtered by page) with optional intro text
function buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames = null, language = 'en') {
  log.debug(`📖 [VISUAL BIBLE PROMPT] Building prompt for page ${pageNumber}`);

  if (!visualBible) return '';

  // Collect all entries (not filtered by page)
  const allEntries = [];
  for (const entry of visualBible.secondaryCharacters || []) {
    allEntries.push({ ...entry, type: 'character' });
  }
  for (const entry of visualBible.animals || []) {
    allEntries.push({ ...entry, type: 'animal' });
  }
  for (const entry of visualBible.artifacts || []) {
    allEntries.push({ ...entry, type: 'artifact' });
  }
  for (const entry of visualBible.locations || []) {
    allEntries.push({ ...entry, type: 'location' });
  }

  log.debug(`📖 [VISUAL BIBLE PROMPT] Total entries: ${allEntries.length} (${allEntries.map(e => e.name).join(', ') || 'none'})`);

  // If no entries, return empty
  if (allEntries.length === 0) {
    return '';
  }

  // Build intro text based on language
  let introText;
  if (language === 'de') {
    introText = `**VISUELLE REFERENZELEMENTE (optional):**
Du kannst Elemente aus der visuellen Bibel unten verwenden, wenn sie für diese Szene passend sind.
Diese Elemente sind NICHT erforderlich - füge sie nur hinzu, wenn sie natürlich ins Bild passen.`;
  } else if (language === 'fr') {
    introText = `**ÉLÉMENTS DE RÉFÉRENCE VISUELS (optionnel):**
Vous pouvez utiliser les éléments de la bible visuelle ci-dessous s'ils sont appropriés pour cette scène.
Ces éléments ne sont PAS obligatoires - incluez-les uniquement s'ils s'intègrent naturellement dans l'image.`;
  } else {
    introText = `**VISUAL REFERENCE ELEMENTS (optional):**
You may use elements from the visual bible below if appropriate for this scene.
These elements are NOT required - only include them if they naturally fit the image.`;
  }

  let prompt = `\n${introText}\n\n`;

  // Add all recurring elements
  for (const entry of allEntries) {
    const description = entry.extractedDescription || entry.description;
    prompt += `**${entry.name}** (${entry.type}): ${description}\n`;
  }

  return prompt;
}

// Build Visual Bible prompt for covers (all main characters + 2-3 key story elements)
function buildFullVisualBiblePrompt(visualBible) {
  if (!visualBible) return '';

  let prompt = '';

  // Add ALL main characters with their style DNA
  if (visualBible.mainCharacters && visualBible.mainCharacters.length > 0) {
    prompt += '\n\n**MAIN CHARACTERS - Must match reference photos exactly:**\n';
    for (const char of visualBible.mainCharacters) {
      prompt += `**${char.name}:**\n`;
      if (char.physical) {
        // Basic traits
        if (char.physical.age && char.physical.age !== 'Unknown') {
          prompt += `- Age: ${char.physical.age} years old\n`;
        }
        if (char.physical.gender && char.physical.gender !== 'Unknown') {
          prompt += `- Gender: ${char.physical.gender}\n`;
        }
        if (char.physical.height && char.physical.height !== 'Unknown') {
          prompt += `- Height: ${char.physical.height} cm\n`;
        }
        if (char.physical.build && char.physical.build !== 'Unknown' && char.physical.build !== 'Not analyzed') {
          prompt += `- Build: ${char.physical.build}\n`;
        }
        // Detailed features
        if (char.physical.face && char.physical.face !== 'Not analyzed') {
          prompt += `- Face: ${char.physical.face}\n`;
        }
        if (char.physical.hair && char.physical.hair !== 'Not analyzed') {
          prompt += `- Hair: ${char.physical.hair}\n`;
        }
        // Include other physical traits (glasses, birthmarks, always-present accessories)
        if (char.physical.other && char.physical.other !== 'Not analyzed' && char.physical.other !== 'none') {
          prompt += `- Other features: ${char.physical.other}\n`;
        }
      }
    }
  }

  // Add only 2-3 key story elements (prioritize animals and important artifacts)
  const keyElements = [];

  // First add animals (pets, companions - usually most important)
  for (const entry of visualBible.animals || []) {
    if (keyElements.length < 3) {
      keyElements.push({ ...entry, type: 'animal' });
    }
  }

  // Then add artifacts if we have room
  for (const entry of visualBible.artifacts || []) {
    if (keyElements.length < 3) {
      keyElements.push({ ...entry, type: 'artifact' });
    }
  }

  if (keyElements.length > 0) {
    prompt += '\n**KEY STORY ELEMENTS:**\n';
    for (const entry of keyElements) {
      const description = entry.extractedDescription || entry.description;
      prompt += `**${entry.name}** (${entry.type}): ${description}\n`;
    }
  }

  return prompt;
}

// Analyze generated image to extract detailed descriptions of Visual Bible elements
async function analyzeVisualBibleElements(imageData, elementsToAnalyze) {
  if (!elementsToAnalyze || elementsToAnalyze.length === 0) {
    return [];
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('⚠️  [VISUAL BIBLE] Gemini API key not configured, skipping analysis');
    return [];
  }

  try {
    // Build the analysis prompt from template
    const elementsList = elementsToAnalyze.map(e => `- ${e.name} (${e.type})`).join('\n');
    const analysisPrompt = fillTemplate(PROMPT_TEMPLATES.visualBibleAnalysis, {
      '{ELEMENTS_LIST}': elementsList
    });

    // Extract base64 and mime type
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build content array
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: analysisPrompt }
    ];

    // Use Gemini Flash for analysis
    const modelId = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.3
        }
      })
    });

    if (!response.ok) {
      log.warn(`[VISUAL BIBLE] Gemini API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON response
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('⚠️  [VISUAL BIBLE] Could not parse JSON response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const results = parsed.elements || [];

    log.debug(`📖 [VISUAL BIBLE] Analyzed ${results.length} elements from image`);

    return results;
  } catch (error) {
    console.error('⚠️  [VISUAL BIBLE] Error analyzing image:', error.message);
    return [];
  }
}

// Update Visual Bible with extracted descriptions after first appearance
function updateVisualBibleWithExtracted(visualBible, pageNumber, extractedDescriptions) {
  if (!visualBible || !extractedDescriptions || extractedDescriptions.length === 0) {
    return visualBible;
  }

  const updateEntries = (entries) => {
    for (const entry of entries) {
      // Check if this is the first appearance for this entry
      const firstAppearancePage = Math.min(...entry.appearsInPages);
      if (firstAppearancePage === pageNumber && !entry.firstAppearanceAnalyzed) {
        // Find matching extracted description
        const extracted = extractedDescriptions.find(
          e => e.name.toLowerCase() === entry.name.toLowerCase()
        );
        if (extracted && extracted.description) {
          entry.extractedDescription = extracted.description;
          entry.firstAppearanceAnalyzed = true;
          log.debug(`📖 [VISUAL BIBLE] Updated "${entry.name}" with extracted description`);
        }
      }
    }
  };

  updateEntries(visualBible.secondaryCharacters || []);
  updateEntries(visualBible.animals || []);
  updateEntries(visualBible.artifacts || []);
  updateEntries(visualBible.locations || []);

  return visualBible;
}

// Get elements that need analysis for a given page (first appearances only)
function getElementsNeedingAnalysis(visualBible, pageNumber) {
  if (!visualBible) return [];

  const needsAnalysis = [];

  const checkEntries = (entries, type) => {
    for (const entry of entries) {
      const firstAppearancePage = Math.min(...entry.appearsInPages);
      if (firstAppearancePage === pageNumber && !entry.firstAppearanceAnalyzed) {
        needsAnalysis.push({ ...entry, type });
      }
    }
  };

  checkEntries(visualBible.secondaryCharacters || [], 'character');
  checkEntries(visualBible.animals || [], 'animal');
  checkEntries(visualBible.artifacts || [], 'artifact');
  checkEntries(visualBible.locations || [], 'location');

  return needsAnalysis;
}

// Helper function to extract cover scene descriptions and clothing from outline
// Returns: { titlePage: { scene, clothing }, initialPage: { scene, clothing }, backCover: { scene, clothing } }
function extractCoverScenes(outline) {
  const coverScenes = {
    titlePage: { scene: '', clothing: null },
    initialPage: { scene: '', clothing: null },
    backCover: { scene: '', clothing: null }
  };

  const lines = outline.split('\n');
  let currentCoverType = null;
  let sceneBuffer = '';

  // Helper to save current buffer and extract clothing
  const saveCurrentScene = () => {
    if (currentCoverType && sceneBuffer) {
      coverScenes[currentCoverType].scene = sceneBuffer.trim();
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Look for cover page patterns
    const titlePageMatch = line.match(/(?:\*\*)?Title\s+Page(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (titlePageMatch) {
      saveCurrentScene();
      currentCoverType = 'titlePage';
      sceneBuffer = titlePageMatch[1].trim();
      continue;
    }

    // Match both "Initial Page" and legacy "Page 0" for backward compatibility
    const initialPageMatch = line.match(/(?:\*\*)?(?:Initial\s+Page|Page\s+0)(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (initialPageMatch) {
      saveCurrentScene();
      currentCoverType = 'initialPage';
      sceneBuffer = initialPageMatch[1].trim();
      continue;
    }

    const backCoverMatch = line.match(/(?:\*\*)?Back\s+Cover(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (backCoverMatch) {
      saveCurrentScene();
      currentCoverType = 'backCover';
      sceneBuffer = backCoverMatch[1].trim();
      continue;
    }

    // Stop collecting if we hit section separators or new sections
    if (line === '---' || line.match(/^#{1,3}\s*(Visual Bible|Page-by-Page|Characters|Animals|Locations|Plot)/i)) {
      saveCurrentScene();
      currentCoverType = null;
      sceneBuffer = '';
      continue;
    }

    // Extract Clothing for current cover type (handles various markdown formats)
    const clothingMatch = line.match(/^[\*_\-#\s\d\.]*(?:Clothing|Kleidung|Vêtements|Tenue)[\*_\-#\s]*:?\s*[\*_\-#\s]*(winter|summer|formal|standard)?/i);
    if (clothingMatch && currentCoverType) {
      if (clothingMatch[1]) {
        // Clothing value on same line
        coverScenes[currentCoverType].clothing = clothingMatch[1].toLowerCase();
      } else {
        // Clothing value might be on next line
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1].trim();
          const valueMatch = nextLine.match(/^[\*_\-#\s]*(winter|summer|formal|standard)[\*_\-#\s]*$/i);
          if (valueMatch) {
            coverScenes[currentCoverType].clothing = valueMatch[1].toLowerCase();
            i++; // Skip the value line
          }
        }
      }
      continue;
    }

    // Look for "Scene:" pattern
    const sceneMatch = line.match(/^(?:\*\*)?Scene(?:\*\*)?:\s*(.+)/i);
    if (sceneMatch) {
      sceneBuffer = sceneMatch[1].trim();
    } else if (currentCoverType && line.length > 0 && !line.match(/^(Page|Title|Back\s+Cover)/i)) {
      // Continue collecting multi-line scene descriptions
      sceneBuffer += ' ' + line;
    }

    // If we hit a regular page number, stop collecting cover scenes
    if (line.match(/^(?:\*\*)?Page\s+\d+(?:\*\*)?[\s:]/i)) {
      saveCurrentScene();
      currentCoverType = null;
      sceneBuffer = '';
    }
  }

  // Save last buffer
  saveCurrentScene();

  log.debug(`📋 [COVER-EXTRACT] Title Page: clothing=${coverScenes.titlePage.clothing || 'not found'}, scene=${coverScenes.titlePage.scene.substring(0, 50)}...`);
  log.debug(`📋 [COVER-EXTRACT] Initial Page: clothing=${coverScenes.initialPage.clothing || 'not found'}, scene=${coverScenes.initialPage.scene.substring(0, 50)}...`);
  log.debug(`📋 [COVER-EXTRACT] Back Cover: clothing=${coverScenes.backCover.clothing || 'not found'}, scene=${coverScenes.backCover.scene.substring(0, 50)}...`);

  return coverScenes;
}

// Helper function to build Art Director scene description prompt (matches frontend)
function buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc = '', language = 'English', visualBible = null) {
  // Debug: Log Visual Bible mainCharacters status
  log.debug(`📖 [SCENE PROMPT P${pageNumber}] Building prompt for ${characters.length} characters`);
  log.debug(`📖 [SCENE PROMPT P${pageNumber}] Visual Bible mainCharacters: ${visualBible?.mainCharacters?.length || 0}`);

  // Build detailed character descriptions - include full physical details from Visual Bible
  const characterDetails = characters.map(c => {
    // Check if character has detailed description in Visual Bible
    let visualBibleDesc = null;
    if (visualBible && visualBible.mainCharacters) {
      const vbChar = visualBible.mainCharacters.find(vbc =>
        vbc.id === c.id || vbc.name.toLowerCase().trim() === c.name.toLowerCase().trim()
      );

      // Debug logging
      log.debug(`📖 [SCENE PROMPT P${pageNumber}] Looking for "${c.name}" (id: ${c.id}) in Visual Bible...`);
      log.debug(`📖 [SCENE PROMPT P${pageNumber}] Found match: ${vbChar ? vbChar.name : 'NO'}, has physical: ${vbChar?.physical ? 'YES' : 'NO'}`);
      if (vbChar?.physical) {
        log.debug(`📖 [SCENE PROMPT P${pageNumber}] Physical data: age="${vbChar.physical.age}", gender="${vbChar.physical.gender}", height="${vbChar.physical.height}", build="${vbChar.physical.build}", face="${vbChar.physical.face?.substring(0, 50)}...", hair="${vbChar.physical.hair}", other="${vbChar.physical.other}"`);
      }

      if (vbChar && vbChar.physical) {
        // Build description from Visual Bible physical object - include ALL traits
        const vbParts = [];
        // Basic traits
        if (vbChar.physical.age && vbChar.physical.age !== 'Unknown') vbParts.push(`${vbChar.physical.age} years old`);
        if (vbChar.physical.gender && vbChar.physical.gender !== 'Unknown') vbParts.push(vbChar.physical.gender);
        if (vbChar.physical.height && vbChar.physical.height !== 'Unknown') vbParts.push(`${vbChar.physical.height} cm tall`);
        if (vbChar.physical.build && vbChar.physical.build !== 'Unknown') vbParts.push(`${vbChar.physical.build} build`);
        // Detailed features
        if (vbChar.physical.face) vbParts.push(vbChar.physical.face);
        if (vbChar.physical.hair) vbParts.push(`Hair: ${vbChar.physical.hair}`);
        // Other physical traits (glasses, birthmarks, always-present accessories)
        if (vbChar.physical.other && vbChar.physical.other !== 'none') vbParts.push(`Other: ${vbChar.physical.other}`);
        if (vbParts.length > 0) {
          visualBibleDesc = vbParts.join(' | ');
          log.debug(`📖 [SCENE PROMPT P${pageNumber}] Using Visual Bible description for ${c.name}`);
        }
      }
    }

    // Build comprehensive physical description from character data
    const physicalParts = [];

    // Basic info
    if (c.age) physicalParts.push(`${c.age} years old`);
    if (c.gender) physicalParts.push(c.gender === 'male' ? 'male' : c.gender === 'female' ? 'female' : 'non-binary');

    // Physical traits (support both snake_case and camelCase)
    const face = c.other_features || c.otherFeatures || c.face;
    const hair = c.hair_color || c.hairColor;
    const build = c.build;
    const other = c.other;

    if (face) physicalParts.push(`Face: ${face}`);
    if (hair) physicalParts.push(`Hair: ${hair}`);
    if (build) physicalParts.push(`Build: ${build}`);
    if (other && other !== 'none') physicalParts.push(`Other: ${other}`);

    // Additional features
    if (c.otherFeatures) physicalParts.push(c.otherFeatures);
    if (c.specialDetails) physicalParts.push(c.specialDetails);

    // Use Visual Bible description if available (preferred), otherwise use character data
    const physicalDesc = visualBibleDesc || physicalParts.join('. ');

    return `* **${c.name}:**\n  PHYSICAL: ${physicalDesc}`;
  }).join('\n\n');

  // Build Visual Bible recurring elements section - include ALL entries (not filtered by page)
  let recurringElements = '';
  if (visualBible) {
    // Add ALL secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      for (const sc of visualBible.secondaryCharacters) {
        const description = sc.extractedDescription || sc.description;
        recurringElements += `* **${sc.name}** (secondary character): ${description}\n`;
      }
    }
    // Add ALL locations
    if (visualBible.locations && visualBible.locations.length > 0) {
      for (const loc of visualBible.locations) {
        const description = loc.extractedDescription || loc.description;
        recurringElements += `* **${loc.name}** (location): ${description}\n`;
      }
    }
    // Add ALL animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      for (const animal of visualBible.animals) {
        const description = animal.extractedDescription || animal.description;
        recurringElements += `* **${animal.name}** (animal): ${description}\n`;
      }
    }
    // Add ALL artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      for (const artifact of visualBible.artifacts) {
        const description = artifact.extractedDescription || artifact.description;
        recurringElements += `* **${artifact.name}** (object): ${description}\n`;
      }
    }
    log.debug(`📖 [SCENE PROMPT P${pageNumber}] Including ALL Visual Bible entries in scene description`);
  }

  // Default message if no recurring elements
  if (!recurringElements) {
    recurringElements = '(None available)';
  }

  // Use template from file if available
  if (PROMPT_TEMPLATES.sceneDescriptions) {
    return fillTemplate(PROMPT_TEMPLATES.sceneDescriptions, {
      SCENE_SUMMARY: shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : '',
      PAGE_NUMBER: pageNumber.toString(),
      PAGE_CONTENT: pageContent,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      LANGUAGE: language
    });
  }

  // Fallback to hardcoded prompt if template not loaded
  return `**ROLE:**
You are an expert Art Director creating an illustration brief for a children's book.

**SCENE CONTEXT:**
${shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : ''}Story Text (Page ${pageNumber}):
${pageContent}

**AVAILABLE CHARACTERS & VISUAL REFERENCES:**
${characterDetails}
${recurringElements}
**TASK:**
Create a detailed visual description of ONE key moment from the scene context provided.

Focus on essential characters only (1-2 maximum unless the story specifically requires more). Choose the most impactful visual moment that captures the essence of the scene.

**OUTPUT FORMAT:**
1. **Setting & Atmosphere:** Describe the background, time of day, lighting, and mood.
2. **Composition:** Describe the camera angle (e.g., low angle, wide shot) and framing.
3. **Characters:**
   * **[Character Name]:** Exact action, body language, facial expression, and location in the frame.
   (Repeat for each character present in this specific scene)

**CONSTRAINTS:**
- Do not include dialogue or speech
- Focus purely on visual elements
- Use simple, clear language
- Only include characters essential to this scene
- If recurring elements appear, describe them consistently as specified above`;
}

// Helper function to parse story text into pages
function parseStoryPages(storyText) {
  // Split by page markers (## Seite X, ## Page X, or --- Page X ---)
  const pageRegex = /(?:##\s*(?:Seite|Page)\s+(\d+)|---\s*Page\s+(\d+)\s*---)/gi;
  const pages = [];
  let lastIndex = 0;
  let lastPageNum = 0;
  let match;

  // Find all page markers
  const matches = [];
  while ((match = pageRegex.exec(storyText)) !== null) {
    const pageNum = parseInt(match[1] || match[2]);
    matches.push({ index: match.index, pageNum, length: match[0].length });
  }

  // Extract content between markers
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const contentStart = current.index + current.length;
    const contentEnd = next ? next.index : storyText.length;
    const content = storyText.substring(contentStart, contentEnd).trim();

    if (content) {
      pages.push({
        pageNumber: current.pageNum,
        content: content
      });
    }
  }

  return pages;
}

// Helper function to extract short scene descriptions from outline
function extractShortSceneDescriptions(outline) {
  const descriptions = {};
  const lines = outline.split('\n');

  // Debug: Log outline length and preview to understand format
  log.debug(`📋 [SCENE-EXTRACT] Outline length: ${outline.length} chars, ${lines.length} lines`);
  log.debug(`📋 [SCENE-EXTRACT] Outline preview (first 500 chars): ${outline.substring(0, 500).replace(/\n/g, '\\n')}`);

  // Look for the Page-by-Page Breakdown section first
  let inPageSection = false;
  let pagesFound = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect when we enter the page breakdown section
    if (line.match(/page[\s-]*by[\s-]*page|seitenweise/i)) {
      inPageSection = true;
      log.debug(`📋 [SCENE-EXTRACT] Found page breakdown section at line ${i + 1}`);
    }

    // Look for various page header formats:
    // - "Page X:" or "**Page X:**" or "Page X -"
    // - "## Page X" (markdown header)
    // - "Seite X:" (German)
    // - More flexible: Page/Seite followed by number, with various separators
    const pageMatch = line.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+(\d+)\s*(?::|\.|-|\*{0,2})/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]);
      pagesFound.push(pageNum);

      // First check if scene is on the same line (e.g., "Page 1: Scene: description")
      const inlineSceneMatch = line.match(/(?:Scene|Szene|Scène)(?:\s+Description)?[:\s]+(.+)/i);
      if (inlineSceneMatch && inlineSceneMatch[1].trim().length > 10) {
        descriptions[pageNum] = inlineSceneMatch[1].trim();
        log.debug(`📋 [SCENE-EXTRACT] Page ${pageNum} (inline): ${descriptions[pageNum].substring(0, 60)}...`);
        continue;
      }

      // Look for Scene: in the next 10 lines (template format has Scene after Character Focus and Clothing)
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const sceneLine = lines[j].trim();

        // Match various Scene formats with more flexibility (EN, DE, FR)
        // Also match "Scène" (French) and lines starting with "Scene:" directly
        const sceneMatch = sceneLine.match(/^[-*•]?\s*\*{0,2}(?:Scene|Szene|Scène|Visual|Setting|Image)(?:\s+Description)?[:\s]*\*{0,2}\s*(.*)/i);
        if (sceneMatch && sceneMatch[1].trim().length > 5) {
          descriptions[pageNum] = sceneMatch[1].trim();
          log.debug(`📋 [SCENE-EXTRACT] Page ${pageNum}: ${descriptions[pageNum].substring(0, 60)}...`);
          break;
        }
        // Stop if we hit another Page marker
        if (sceneLine.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+\d+/i)) break;
      }

      // If no scene found yet, try to find any descriptive text after skipping structured fields
      if (!descriptions[pageNum]) {
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const nextLine = lines[j].trim();
          // Skip empty lines, structured field labels, and short lines
          if (!nextLine) continue;
          if (nextLine.match(/^(?:Character\s*Focus|Clothing|Title|Titel|Text|Story|Personnage|Vêtements)/i)) continue;
          if (nextLine.length < 20) continue;
          // Stop if we hit another Page marker
          if (nextLine.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+\d+/i)) break;

          // Use this as fallback scene description (strip markdown formatting)
          descriptions[pageNum] = nextLine.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '').replace(/^\[|\]$/g, '').trim();
          log.debug(`📋 [SCENE-EXTRACT] Page ${pageNum} (fallback): ${descriptions[pageNum].substring(0, 60)}...`);
          break;
        }
      }
    }
  }

  log.debug(`📋 [SCENE-EXTRACT] Pages found: ${pagesFound.join(', ') || 'none'}`);
  log.debug(`📋 [SCENE-EXTRACT] Total extracted: ${Object.keys(descriptions).length} scene descriptions`);
  return descriptions;
}

// Process picture book (storybook) job - simplified flow with combined text+scene generation
async function processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId) {
  log.debug(`📖 [STORYBOOK] Starting picture book generation for job ${jobId}`);

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility)
    anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      storybook_combined: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() }
    }
  };

  // Pricing per million tokens (as of Dec 2024)
  const PRICING = {
    anthropic: { input: 3.00, output: 15.00 },      // Claude Sonnet 4
    gemini_image: { input: 0.075, output: 0.30 },   // Gemini Flash
    gemini_quality: { input: 0.075, output: 0.30 }, // Gemini Flash
    gemini_text: { input: 0.075, output: 0.30 }     // Gemini Flash
  };

  // Helper to add usage - now supports function-level tracking with model names
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].calls += 1;
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage.output_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      if (modelName) {
        tokenUsage.byFunction[functionName].models.add(modelName);
      }
    }
  };

  // Helper to calculate cost for a usage entry
  const calculateCost = (provider, inputTokens, outputTokens) => {
    const pricing = PRICING[provider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, total: inputCost + outputCost };
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
            imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker);
          } catch (error) {
            retries++;
            console.error(`❌ [STREAM-IMG] Page ${pageNum} attempt ${retries} failed:`, error.message);
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
          wasRegenerated: imageResult.wasRegenerated || false,
          totalAttempts: imageResult.totalAttempts || 1,
          retryHistory: imageResult.retryHistory || [],
          originalImage: imageResult.originalImage || null,
          originalScore: imageResult.originalScore || null,
          originalReasoning: imageResult.originalReasoning || null,
          referencePhotos  // Dev mode: which photos were used
        };

        // Save final result with quality score (overwrites immediate save)
        await saveCheckpoint(jobId, 'partial_page', pageData, pageNum);
        log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

        return pageData;
      } catch (error) {
        console.error(`❌ [STREAM-IMG] Failed to generate image for page ${pageNum}:`, error.message);
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
        // Find the original character to get age/gender
        const char = characters?.find(c => c.name === photo.name);
        const age = char?.age ? `${char.age} years old` : '';
        const gender = char?.gender === 'male' ? 'boy/man' : char?.gender === 'female' ? 'girl/woman' : '';
        const brief = [photo.name, age, gender].filter(Boolean).join(', ');
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

        // Generate the image
        const result = await generateImageWithQualityRetry(coverPrompt, referencePhotos, null, 'cover', null, streamCoverUsageTracker);

        const coverData = {
          imageData: result.imageData,
          description: sceneDescription,
          prompt: coverPrompt,
          qualityScore: result.score,
          qualityReasoning: result.reasoning || null,
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
        console.error(`❌ [STREAM-COVER] Failed to generate ${coverType} cover:`, error.message);
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
        console.log(`📖 [STREAM-COVER] Visual Bible ready for cover generation`);
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

      console.log(`🌊 [STREAM] Scene ${pageNumber} complete during streaming (${scenesEmittedCount}/${sceneCount})`);

      // Start image generation immediately for this scene (only in parallel mode)
      // Pass the page text so it can be saved with the partial result
      if (shouldStreamImages && sceneDescription) {
        const imagePromise = streamLimit(() => generateImageForScene(pageNumber, sceneDescription, text));
        streamingImagePromises.push(imagePromise);
      }
    });

    let response;
    try {
      // Use streaming API call
      const streamResult = await callTextModelStreaming(storybookPrompt, 16000, (chunk, fullText) => {
        // Process each chunk to detect complete scenes AND cover scenes
        coverParser.processChunk(chunk, fullText);
        sceneParser.processChunk(chunk, fullText);
      });
      response = streamResult.text;
      addUsage('anthropic', streamResult.usage, 'storybook_combined', activeTextModel.modelId);
      log.debug(`📖 [STORYBOOK] Streaming complete, received ${response?.length || 0} chars`);
      console.log(`🌊 [STREAM] ${scenesEmittedCount} scenes detected during streaming, ${streamingImagePromises.length} page images started`);
      console.log(`🌊 [STREAM] ${streamingCoverPromises.length} cover images started during streaming`);
    } catch (apiError) {
      console.error(`❌ [STORYBOOK] Claude API streaming call failed:`, apiError.message);
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
        description: sceneDesc
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
              imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, previousImage, 'scene', null, pageUsageTracker);
            } catch (error) {
              retries++;
              console.error(`❌ [STORYBOOK] Page ${pageNum} image attempt ${retries} failed:`, error.message);
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
            wasRegenerated: imageResult.wasRegenerated || false,
            totalAttempts: imageResult.totalAttempts || 1,
            retryHistory: imageResult.retryHistory || [],
            originalImage: imageResult.originalImage || null,
            originalScore: imageResult.originalScore || null,
            originalReasoning: imageResult.originalReasoning || null,
            referencePhotos
          };
        } catch (error) {
          console.error(`❌ [STORYBOOK] Failed to generate image for page ${pageNum}:`, error.message);
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
          console.log(`🔗 [STORYBOOK SEQUENTIAL ${i + 1}/${allSceneDescriptions.length}] Processing page ${scene.pageNumber}...`);

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
          console.log(`📕 [STORYBOOK] Front cover: ${frontCoverCharacters.length} characters (${frontCoverCharacters.map(c => c.name).join(', ') || 'none'}), clothing: ${frontCoverClothing}`);

          const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: titlePageScene,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(frontCoverPhotos, frontCoverCharacters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.frontCover = frontCoverPrompt;
          const frontCoverResult = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker);
          log.debug(`✅ [STORYBOOK] Front cover generated (score: ${frontCoverResult.score}${frontCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.frontCover = {
            imageData: frontCoverResult.imageData,
            description: titlePageScene,
            prompt: frontCoverPrompt,
            qualityScore: frontCoverResult.score,
            qualityReasoning: frontCoverResult.reasoning || null,
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
          console.log(`📕 [STORYBOOK] Initial page: ALL ${initialPagePhotos.length} characters (group scene with main character centered), clothing: ${initialPageClothing}`);

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
          const initialResult = await generateImageWithQualityRetry(initialPrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker);
          log.debug(`✅ [STORYBOOK] Initial page generated (score: ${initialResult.score}${initialResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.initialPage = {
            imageData: initialResult.imageData,
            description: initialPageScene,
            prompt: initialPrompt,
            qualityScore: initialResult.score,
            qualityReasoning: initialResult.reasoning || null,
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
          console.log(`📕 [STORYBOOK] Back cover: ALL ${backCoverPhotos.length} characters (equal prominence group scene), clothing: ${backCoverClothing}`);

          const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: backCoverScene,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(backCoverPhotos, inputData.characters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.backCover = backCoverPrompt;
          const backCoverResult = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker);
          log.debug(`✅ [STORYBOOK] Back cover generated (score: ${backCoverResult.score}${backCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          coverImages.backCover = {
            imageData: backCoverResult.imageData,
            description: backCoverScene,
            prompt: backCoverPrompt,
            qualityScore: backCoverResult.score,
            qualityReasoning: backCoverResult.reasoning || null,
            wasRegenerated: backCoverResult.wasRegenerated || false,
            totalAttempts: backCoverResult.totalAttempts || 1,
            retryHistory: backCoverResult.retryHistory || [],
            originalImage: backCoverResult.originalImage || null,
            originalScore: backCoverResult.originalScore || null,
            originalReasoning: backCoverResult.originalReasoning || null,
            referencePhotos: backCoverPhotos,
            modelId: backCoverResult.modelId || null
          };
        } else {
          log.debug(`⚡ [STORYBOOK] Back cover already generated during streaming (skipping)`);
        }

        log.debug(`✅ [STORYBOOK] Cover images complete (${coversFromStreaming} from streaming, ${3 - coversFromStreaming} generated after)`);
      } catch (error) {
        console.error(`❌ [STORYBOOK] Cover generation failed:`, error.message);
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
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      tokenUsage: tokenUsage, // Token usage statistics for cost tracking
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Log token usage summary with costs
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].input_tokens, 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].output_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens);
    const geminiImageCost = calculateCost('gemini_image', tokenUsage.gemini_image.input_tokens, tokenUsage.gemini_image.output_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens);
    const totalCost = anthropicCost.total + geminiImageCost.total + geminiQualityCost.total;
    log.debug(`📊 [STORYBOOK] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_image.calls} calls)  $${geminiImageCost.total.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    if (byFunc.storybook_combined.calls > 0) {
      const cost = calculateCost(byFunc.storybook_combined.provider, byFunc.storybook_combined.input_tokens, byFunc.storybook_combined.output_tokens);
      console.log(`   Story+Scenes:  ${byFunc.storybook_combined.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.storybook_combined.output_tokens.toLocaleString().padStart(8)} out (${byFunc.storybook_combined.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.storybook_combined)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const cost = calculateCost(byFunc.cover_images.provider, byFunc.cover_images.input_tokens, byFunc.cover_images.output_tokens);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_images)}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(byFunc.cover_quality.provider, byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const cost = calculateCost(byFunc.page_images.provider, byFunc.page_images.input_tokens, byFunc.page_images.output_tokens);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_images)}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(byFunc.page_quality.provider, byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output tokens`);
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
      console.error('❌ [STORYBOOK] Failed to log credit completion:', creditErr.message);
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
    console.error(`❌ [STORYBOOK] Job ${jobId} failed:`, error);

    // Refund reserved credits on failure
    try {
      const jobResult = await dbPool.query(
        'SELECT user_id, credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const refundUserId = jobResult.rows[0].user_id;
        const creditsToRefund = jobResult.rows[0].credits_reserved;

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
          await dbPool.query(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [refundUserId, creditsToRefund, newBalance, 'story_refund', jobId, `Refunded ${creditsToRefund} credits - storybook generation failed`]
          );

          // Reset credits_reserved to prevent double refunds
          await dbPool.query(
            'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
            [jobId]
          );

          log.info(`💳 [STORYBOOK] Refunded ${creditsToRefund} credits for failed job ${jobId}`);
        }
      }
    } catch (refundErr) {
      console.error('❌ [STORYBOOK] Failed to refund credits:', refundErr.message);
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
    // By provider (for backwards compatibility)
    anthropic: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() }
    }
  };

  // Pricing per million tokens (as of Dec 2024)
  const PRICING = {
    anthropic: { input: 3.00, output: 15.00 },      // Claude Sonnet 4
    gemini_image: { input: 0.075, output: 0.30 },   // Gemini Flash
    gemini_quality: { input: 0.075, output: 0.30 }, // Gemini Flash
    gemini_text: { input: 0.075, output: 0.30 }     // Gemini Flash
  };

  // Helper to add usage - now supports function-level tracking with model names
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      tokenUsage[provider].input_tokens += usage.input_tokens || 0;
      tokenUsage[provider].output_tokens += usage.output_tokens || 0;
      tokenUsage[provider].calls += 1;
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      tokenUsage.byFunction[functionName].input_tokens += usage.input_tokens || 0;
      tokenUsage.byFunction[functionName].output_tokens += usage.output_tokens || 0;
      tokenUsage.byFunction[functionName].calls += 1;
      if (modelName) {
        tokenUsage.byFunction[functionName].models.add(modelName);
      }
    }
  };

  // Helper to calculate cost for a usage entry
  const calculateCost = (provider, inputTokens, outputTokens) => {
    const pricing = PRICING[provider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, total: inputCost + outputCost };
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
    console.log(`📚 [PIPELINE] Print pages: ${printPages}, Mode: ${isPictureBook ? 'Picture Book' : 'Standard'}, Scenes to generate: ${sceneCount}`);

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
      console.log(`📚 [PIPELINE] Picture Book mode - using combined text+scene generation`);
      return await processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, job.user_id);
    }

    // Standard flow for normal stories
    await dbPool.query(
      'UPDATE story_jobs SET progress_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Writing story...', jobId]
    );

    // Step 1: Generate story outline (using Claude API)
    // Pass sceneCount to ensure outline matches the number of scenes we'll generate
    const outlinePrompt = buildStoryPrompt(inputData, sceneCount);
    // Claude can handle up to 64,000 output tokens - use generous limit for outlines
    const outlineTokens = 16000;
    log.debug(`📋 [PIPELINE] Generating outline for ${sceneCount} scenes (max tokens: ${outlineTokens}) - STREAMING`);
    const outlineResult = await callTextModelStreaming(outlinePrompt, outlineTokens);
    const outline = outlineResult.text;
    addUsage('anthropic', outlineResult.usage, 'outline', activeTextModel.modelId);

    // Save checkpoint: outline (include prompt for debugging)
    await saveCheckpoint(jobId, 'outline', { outline, outlinePrompt });

    // Extract short scene descriptions from outline for better image generation
    const shortSceneDescriptions = extractShortSceneDescriptions(outline);
    log.debug(`📋 [PIPELINE] Extracted ${Object.keys(shortSceneDescriptions).length} short scene descriptions from outline`);

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

    console.log(`📖 [PIPELINE] Visual Bible after parsing: ${JSON.stringify({
      mainCharacters: visualBible.mainCharacters.length,
      secondaryCharacters: visualBible.secondaryCharacters.length,
      animals: visualBible.animals.length,
      artifacts: visualBible.artifacts.length,
      locations: visualBible.locations.length,
      changeLog: visualBible.changeLog.length
    })}`);

    // Validate visual bible was parsed - if outline contains "visual bible" but we got 0 entries, fail
    if (outline.toLowerCase().includes('visual bible') && visualBibleEntryCount === 0) {
      console.error('❌ [PIPELINE] Visual Bible section exists in outline but parsing returned 0 entries!');
      console.error('📖 [PIPELINE] This indicates a parsing bug. Outline preview around "visual bible":');
      const vbIndex = outline.toLowerCase().indexOf('visual bible');
      console.error(outline.substring(Math.max(0, vbIndex - 50), Math.min(outline.length, vbIndex + 500)));
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
    const boldTitleMatch = outline.match(/^#\s*Title\s*\n+\*\*(.+?)\*\*/im);
    const prefixTitleMatch = outline.match(/^#\s*Title\s*\n+Title:\s*(.+?)$/im);
    const plainTitleMatch = outline.match(/^#\s*Title\s*\n+([^#\-\n].+?)$/im);
    const inlineTitleMatch = outline.match(/TITLE:\s*(.+)/i);

    const titleMatch = boldTitleMatch || prefixTitleMatch || plainTitleMatch || inlineTitleMatch;
    if (titleMatch) {
      storyTitle = titleMatch[1].trim();
      console.log(`📖 [PIPELINE] Extracted title from outline: "${storyTitle}"`);
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
          // Find the original character to get age/gender
          const char = characters?.find(c => c.name === photo.name);
          const age = char?.age ? `${char.age} years old` : '';
          const gender = char?.gender === 'male' ? 'boy/man' : char?.gender === 'female' ? 'girl/woman' : '';
          const brief = [photo.name, age, gender].filter(Boolean).join(', ');
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

      // Start all 3 covers in parallel (don't await yet)
      coverGenerationPromise = Promise.all([
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting front cover (${frontCoverCharacters.length} chars, clothing: ${frontCoverClothing})`);
          const result = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker);
          console.log(`✅ [COVER-PARALLEL] Front cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'frontCover', imageData: result.imageData, storyTitle }, 0);
          return { type: 'frontCover', result, photos: frontCoverPhotos, scene: titlePageScene, prompt: frontCoverPrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting initial page (${initialPagePhotos.length} chars, clothing: ${initialPageClothing})`);
          const result = await generateImageWithQualityRetry(initialPagePrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker);
          console.log(`✅ [COVER-PARALLEL] Initial page complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'initialPage', imageData: result.imageData }, 1);
          return { type: 'initialPage', result, photos: initialPagePhotos, scene: initialPageScene, prompt: initialPagePrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting back cover (${backCoverPhotos.length} chars, clothing: ${backCoverClothing})`);
          const result = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker);
          console.log(`✅ [COVER-PARALLEL] Back cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          await saveCheckpoint(jobId, 'partial_cover', { type: 'backCover', imageData: result.imageData }, 2);
          return { type: 'backCover', result, photos: backCoverPhotos, scene: backCoverScene, prompt: backCoverPrompt };
        })()
      ]);

      console.log(`📕 [PIPELINE] Cover generation started in background (3 covers in parallel)`);
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
      console.log(`📚 [PIPELINE] Auto-calculated batch size: ${BATCH_SIZE} pages per batch (${tokensPerPage} tokens/page estimate, model max: ${activeTextModel.maxOutputTokens})`);
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

      const batchPrompt = PROMPT_TEMPLATES.storyTextBatch
        ? fillTemplate(PROMPT_TEMPLATES.storyTextBatch, {
            BASE_PROMPT: basePrompt,
            OUTLINE: outline,
            PAGES: sceneCount,
            START_PAGE: startScene,
            END_PAGE: endScene,
            READING_LEVEL: readingLevel,
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
      const batchTokensNeeded = activeTextModel.maxOutputTokens; // Use full capacity (64000)
      log.debug(`📝 [BATCH ${batchNum + 1}] Requesting ${batchTokensNeeded} max tokens for ${batchSceneCount} pages - STREAMING`);

      // Track which pages have started image generation (for progressive mode)
      const pagesStarted = new Set();

      // Helper function to start image generation for a page
      const startPageImageGeneration = (pageNum, pageContent) => {
        if (pagesStarted.has(pageNum)) return; // Already started
        if (pageNum < startScene || pageNum > endScene) return; // Outside batch range
        pagesStarted.add(pageNum);

        const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

        // Generate scene description using Art Director prompt (in story language)
        const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, langText, visualBible);

        // Start scene description + image generation (don't await)
        const imagePromise = limit(async () => {
          try {
            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description... (streaming)`);

            // Generate detailed scene description
            const sceneDescResult = await callTextModelStreaming(scenePrompt, 4000);
            const sceneDescription = sceneDescResult.text;
            addUsage('anthropic', sceneDescResult.usage, 'scene_descriptions', activeTextModel.modelId);

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,
              scenePrompt: scenePrompt
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            const clothingCategory = parseClothingCategory(sceneDescription) || 'standard';
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
                imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker);
              } catch (error) {
                retries++;
                console.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
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
            console.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            throw error;
          }
        });

        activeImagePromises.push(imagePromise);
      };

      // PROGRESSIVE STREAMING: Start image generation as pages complete during text streaming
      let batchText = '';
      if (!skipImages && imageGenMode === 'parallel') {
        // Create progressive parser that starts image generation as pages stream in
        const progressiveParser = new ProgressiveStoryPageParser((page) => {
          console.log(`🌊 [PROGRESSIVE] Page ${page.pageNumber} detected during streaming, starting image generation`);
          startPageImageGeneration(page.pageNumber, page.content);
        });

        // Stream with progressive parsing
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded, (chunk, fullText) => {
          progressiveParser.processChunk(chunk, fullText);
        });
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', activeTextModel.modelId);

        // Finalize to emit the last page
        progressiveParser.finalize(batchText);
        console.log(`🌊 [PROGRESSIVE] Batch streaming complete, ${pagesStarted.size} pages started during stream`);
      } else {
        // No progressive parsing - just stream text
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded);
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', activeTextModel.modelId);
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
          const retryResult = await callTextModelStreaming(retryPrompt, 1500);
          const retryText = retryResult.text;
          addUsage('anthropic', retryResult.usage, 'story_text', activeTextModel.modelId);

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
        outlineExtract: shortSceneDescriptions[sd.pageNumber] || ''
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

            allImages.push(result);
            return result;
          })
        );

        // Sort images by page number
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        log.debug(`🚀 [STREAMING] All ${allImages.length} images generated (PARALLEL MODE)!`);
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

        for (let i = 0; i < allPages.length; i++) {
          const page = allPages[i];
          const pageNum = page.pageNumber;
          const pageContent = page.content;
          const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

          console.log(`🔗 [SEQUENTIAL ${i + 1}/${allPages.length}] Processing page ${pageNum}...`);

          try {
            // Generate scene description using Art Director prompt (in story language)
            // Pass visualBible so recurring elements are included in scene description
            const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, langText, visualBible);

            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description... (streaming)`);
            const sceneDescResult = await callTextModelStreaming(scenePrompt, 4000);
            const sceneDescription = sceneDescResult.text;
            addUsage('anthropic', sceneDescResult.usage, 'scene_descriptions', activeTextModel.modelId);

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,  // Store the outline extract for debugging
              scenePrompt: scenePrompt         // Store the Art Director prompt for debugging
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            // Parse clothing category from scene description
            const clothingCategory = parseClothingCategory(sceneDescription) || 'standard';
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
                imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, previousImage, 'scene', onImageReady, pageUsageTracker);
              } catch (error) {
                retries++;
                console.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
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
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos  // Dev mode: which photos were used
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
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos
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
            console.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            throw error;
          }
        }

        // Sort images by page number (should already be in order, but ensure consistency)
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        log.debug(`🚀 [STREAMING] All ${allImages.length} images generated (SEQUENTIAL MODE)!`);
      }
    } else {
      console.log(`📝 [STREAMING] Text-only mode - skipping image wait`);
    }

    // Update title from story text if we found a better one (optional refinement)
    if (fullStoryText) {
      const storyTitleMatch = fullStoryText.match(/^#\s+(.+?)$/m);
      if (storyTitleMatch) {
        const storyTextTitle = storyTitleMatch[1].trim();
        if (storyTextTitle !== storyTitle) {
          console.log(`📖 [PIPELINE] Story text has different title: "${storyTextTitle}" (outline had: "${storyTitle}")`);
          // Keep the outline title since covers already used it
        }
      }
    }

    // Wait for parallel cover generation to complete
    let coverImages = null;

    if (coverGenerationPromise) {
      console.log(`📕 [PIPELINE] Waiting for parallel cover generation to complete...`);
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
        console.error(`❌ [PIPELINE] Cover generation failed:`, error);
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
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      visualBible: visualBible, // Visual Bible for recurring element consistency (dev mode)
      tokenUsage: tokenUsage, // Token usage statistics for cost tracking
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Log token usage summary with costs
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].input_tokens, 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].output_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens);
    const geminiImageCost = calculateCost('gemini_image', tokenUsage.gemini_image.input_tokens, tokenUsage.gemini_image.output_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens);
    const totalCost = anthropicCost.total + geminiImageCost.total + geminiQualityCost.total;
    log.debug(`📊 [PIPELINE] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_image.calls} calls)  $${geminiImageCost.total.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    if (byFunc.outline.calls > 0) {
      const cost = calculateCost(byFunc.outline.provider, byFunc.outline.input_tokens, byFunc.outline.output_tokens);
      console.log(`   Outline:       ${byFunc.outline.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.outline.output_tokens.toLocaleString().padStart(8)} out (${byFunc.outline.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.outline)}]`);
    }
    if (byFunc.scene_descriptions.calls > 0) {
      const cost = calculateCost(byFunc.scene_descriptions.provider, byFunc.scene_descriptions.input_tokens, byFunc.scene_descriptions.output_tokens);
      console.log(`   Scene Desc:    ${byFunc.scene_descriptions.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_descriptions.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_descriptions.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_descriptions)}]`);
    }
    if (byFunc.story_text.calls > 0) {
      const cost = calculateCost(byFunc.story_text.provider, byFunc.story_text.input_tokens, byFunc.story_text.output_tokens);
      console.log(`   Story Text:    ${byFunc.story_text.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.story_text.output_tokens.toLocaleString().padStart(8)} out (${byFunc.story_text.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.story_text)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const cost = calculateCost(byFunc.cover_images.provider, byFunc.cover_images.input_tokens, byFunc.cover_images.output_tokens);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_images)}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(byFunc.cover_quality.provider, byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const cost = calculateCost(byFunc.page_images.provider, byFunc.page_images.input_tokens, byFunc.page_images.output_tokens);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_images)}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(byFunc.page_quality.provider, byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);

    // Insert into stories table
    await dbPool.query(
      'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = $3',
      [storyId, job.user_id, JSON.stringify(storyData)]
    );
    console.log(`📚 Story ${storyId} saved to stories table`);

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
        console.log(`💳 Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      console.error('❌ Failed to log credit completion:', creditErr.message);
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
      console.error('❌ Failed to send story complete email:', emailErr);
    }

  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error);

    // Log all partial data for debugging
    try {
      console.log('\n' + '='.repeat(80));
      console.log('📋 [DEBUG] PARTIAL DATA DUMP FOR FAILED JOB:', jobId);
      console.log('='.repeat(80));

      // Get job input data
      const jobDataResult = await dbPool.query('SELECT input_data FROM story_jobs WHERE id = $1', [jobId]);
      if (jobDataResult.rows.length > 0) {
        const inputData = jobDataResult.rows[0].input_data;
        console.log('\n📥 [INPUT DATA]:');
        console.log('  Story Type:', inputData?.storyType);
        console.log('  Story Type Name:', inputData?.storyTypeName);
        console.log('  Art Style:', inputData?.artStyle);
        console.log('  Language:', inputData?.language);
        console.log('  Language Level:', inputData?.languageLevel);
        console.log('  Pages:', inputData?.pages);
        console.log('  Story Details:', inputData?.storyDetails?.substring(0, 200) + (inputData?.storyDetails?.length > 200 ? '...' : ''));
        console.log('  Characters:', inputData?.characters?.map(c => `${c.name} (${c.gender}, ${c.age})`).join(', '));
        console.log('  Main Characters:', inputData?.mainCharacters);
      }

      // Get all checkpoints
      const checkpoints = await getAllCheckpoints(jobId);
      console.log(`\n💾 [CHECKPOINTS]: Found ${checkpoints.length} checkpoints`);

      for (const cp of checkpoints) {
        console.log(`\n--- ${cp.step_name} (index: ${cp.step_index}) at ${cp.created_at} ---`);
        const data = typeof cp.step_data === 'string' ? JSON.parse(cp.step_data) : cp.step_data;

        if (cp.step_name === 'outline') {
          console.log('📜 [OUTLINE]:', data.outline?.substring(0, 500) + '...');
          if (data.outlinePrompt) {
            console.log('📜 [OUTLINE PROMPT]:', data.outlinePrompt?.substring(0, 1000) + '...');
          }
        } else if (cp.step_name === 'scene_hints') {
          console.log('🎬 [SCENE HINTS]:', JSON.stringify(data.shortSceneDescriptions, null, 2).substring(0, 500) + '...');
        } else if (cp.step_name === 'story_batch') {
          console.log(`📖 [STORY BATCH ${data.batchNum}] Pages ${data.startScene}-${data.endScene}:`);
          console.log('  Text preview:', data.batchText?.substring(0, 300) + '...');
          if (data.batchPrompt) {
            console.log('  Batch prompt:', data.batchPrompt?.substring(0, 500) + '...');
          }
        } else if (cp.step_name === 'partial_page') {
          log.debug(`🖼️  [PAGE ${cp.step_index}]:`);
          console.log('  Scene description:', (data.description || data.sceneDescription?.description)?.substring(0, 200) + '...');
          console.log('  Image prompt:', (data.prompt || data.imagePrompt)?.substring(0, 200) + '...');
          console.log('  Has image:', !!data.imageData);
          console.log('  Quality score:', data.qualityScore || data.score);
        } else if (cp.step_name === 'cover') {
          log.debug(`🎨 [COVER ${data.type}]:`);
          console.log('  Prompt:', data.prompt?.substring(0, 200) + '...');
        } else if (cp.step_name === 'storybook_combined') {
          console.log('📚 [STORYBOOK COMBINED]:', data.response?.substring(0, 500) + '...');
        } else {
          console.log('  Data keys:', Object.keys(data).join(', '));
        }
      }

      console.log('\n' + '='.repeat(80));
      console.log('📋 [DEBUG] END OF PARTIAL DATA DUMP');
      console.log('='.repeat(80) + '\n');

      // SAVE PARTIAL RESULTS - reconstruct story from checkpoints and save to stories table
      try {
        const jobDataResult = await dbPool.query('SELECT user_id, input_data FROM story_jobs WHERE id = $1', [jobId]);
        if (jobDataResult.rows.length > 0) {
          const userId = jobDataResult.rows[0].user_id;
          const inputData = jobDataResult.rows[0].input_data;

          // Reconstruct story data from checkpoints
          let outline = '';
          let outlinePrompt = '';
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
                  originalReasoning: data.originalReasoning
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
                  qualityReasoning: data.reasoning
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
              story: fullStoryText,
              storyTextPrompts: storyTextPrompts,
              visualBible: visualBible,
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
            console.log(`📚 [PARTIAL SAVE] Saved partial story ${jobId} with ${sceneImages.length} images to stories table`);
          } else {
            console.log('📚 [PARTIAL SAVE] No content to save');
          }
        }
      } catch (partialSaveErr) {
        console.error('❌ [PARTIAL SAVE] Failed to save partial results:', partialSaveErr.message);
      }
    } catch (dumpErr) {
      console.error('❌ Failed to dump partial data:', dumpErr.message);
    }

    // Refund reserved credits on failure
    try {
      const jobResult = await dbPool.query(
        'SELECT user_id, credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const refundUserId = jobResult.rows[0].user_id;
        const creditsToRefund = jobResult.rows[0].credits_reserved;

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
          await dbPool.query(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [refundUserId, creditsToRefund, newBalance, 'story_refund', jobId, `Refunded ${creditsToRefund} credits - story generation failed`]
          );

          // Reset credits_reserved to prevent double refunds
          await dbPool.query(
            'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
            [jobId]
          );

          console.log(`💳 Refunded ${creditsToRefund} credits for failed job ${jobId} (user balance: ${currentBalance} -> ${newBalance})`);
        }
      }
    } catch (refundErr) {
      console.error('❌ Failed to refund credits:', refundErr.message);
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
      console.error('❌ Failed to send failure notification emails:', emailErr);
    }
  }
}

// Helper functions for story generation

// Build base prompt with character/setting info for story text generation
// textPageCount: the actual number of text pages/scenes (not total PDF pages)
function buildBasePrompt(inputData, textPageCount = null) {
  const mainCharacterIds = inputData.mainCharacters || [];
  // Use textPageCount if provided, otherwise calculate from total pages
  // For advanced/standard: total PDF pages / 2 = text pages (since each scene = 1 text + 1 image page)
  // For 1st-grade: total PDF pages = text pages (combined layout)
  const actualTextPages = textPageCount || (
    inputData.languageLevel === '1st-grade'
      ? (inputData.pages || 15)
      : Math.ceil((inputData.pages || 15) / 2)
  );

  // For story text generation, we use BASIC character info (no strengths/weaknesses)
  // Strengths/weaknesses are only used in outline generation to avoid repetitive trait mentions
  // Support both new structure (char.traits.*) and legacy (char.specialDetails)
  const characterSummary = (inputData.characters || []).map(char => {
    const isMain = mainCharacterIds.includes(char.id);
    const traits = char.traits || {};
    return {
      name: char.name,
      isMainCharacter: isMain,
      gender: char.gender,
      age: char.age,
      specialDetails: traits.specialDetails || char.specialDetails || ''  // Includes hobbies, hopes, fears, favorite animals
    };
  });

  // Build relationship descriptions
  let relationshipDescriptions = '';
  if (inputData.relationships) {
    const relationships = inputData.relationships;
    const relationshipTexts = inputData.relationshipTexts || {};
    const characters = inputData.characters || [];

    const relationshipLines = Object.entries(relationships)
      .filter(([key, type]) => type && type !== 'Not Known to')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = characters.find(c => c.id === char1Id);
        const char2 = characters.find(c => c.id === char2Id);
        if (!char1 || !char2) return null;
        const customText = relationshipTexts[key] || '';
        const baseRelationship = `${char1.name} is ${type} ${char2.name}`;
        return customText ? `${baseRelationship}. ${customText}` : baseRelationship;
      })
      .filter(Boolean);

    if (relationshipLines.length > 0) {
      relationshipDescriptions = `\n- **Relationships**:\n${relationshipLines.map(r => `  - ${r}`).join('\n')}`;
    }
  }

  const readingLevel = getReadingLevel(inputData.languageLevel);

  // Add German language note if applicable
  const language = inputData.language || 'en';
  const languageNote = language === 'de' || language === 'German'
    ? ' (use ä, ö, ü normally. Do not use ß, use ss instead)'
    : '';

  return `# Story Parameters

- **Title**: ${inputData.title || 'Untitled'}
- **Length**: ${actualTextPages} text pages (write exactly this many pages, each within word limit)
- **Language**: ${language}${languageNote}
- **Reading Level**: ${readingLevel}
- **Story Type**: ${inputData.storyType || 'adventure'}
- **Story Details**: ${inputData.storyDetails || 'None'}
- **Characters**: ${JSON.stringify(characterSummary, null, 2)}${relationshipDescriptions}`;
}

function buildStoryPrompt(inputData, sceneCount = null) {
  // Build the story generation prompt based on input data
  // Use sceneCount if provided (for standard mode where print pages != scenes)
  const pageCount = sceneCount || inputData.pages || 15;
  const readingLevel = getReadingLevel(inputData.languageLevel);
  const mainCharacterIds = inputData.mainCharacters || [];

  // Extract only essential character info (NO PHOTOS to avoid token limit)
  // Support both new structure (char.traits.*) and legacy (char.strengths, etc.)
  const characterSummary = (inputData.characters || []).map(char => {
    const traits = char.traits || {};
    return {
      name: char.name,
      isMainCharacter: mainCharacterIds.includes(char.id),
      gender: char.gender,
      age: char.age,
      personality: char.personality,
      strengths: traits.strengths || char.strengths || [],
      flaws: traits.flaws || char.weaknesses || [],
      challenges: traits.challenges || char.fears || [],
      specialDetails: traits.specialDetails || char.specialDetails || ''
      // Explicitly exclude photoUrl and other large fields
    };
  });

  // Log the prompt parameters for debugging
  console.log(`📝 [PROMPT] Building outline prompt:`);
  console.log(`   - Language Level: ${inputData.languageLevel || 'standard'}`);
  console.log(`   - Reading Level: ${readingLevel}`);
  console.log(`   - Pages: ${pageCount}`);

  // Use template if available, otherwise fall back to hardcoded prompt
  if (PROMPT_TEMPLATES.outline) {
    const prompt = fillTemplate(PROMPT_TEMPLATES.outline, {
      TITLE: inputData.title || 'Untitled',
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: pageCount,  // Use calculated page count, not raw input
      LANGUAGE: inputData.language || 'en',
      READING_LEVEL: readingLevel,
      CHARACTERS: JSON.stringify(characterSummary),
      STORY_TYPE: inputData.storyType || 'adventure',
      STORY_DETAILS: inputData.storyDetails || 'None',
      DEDICATION: inputData.dedication || 'None'
    });
    console.log(`📝 [PROMPT] Outline prompt length: ${prompt.length} chars`);
    return prompt;
  }

  // Fallback to hardcoded prompt
  return `Create a children's story with the following parameters:
    Title: ${inputData.title || 'Untitled'}
    Age: ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years
    Length: ${pageCount} pages
    Language: ${inputData.language || 'en'}
    Characters: ${JSON.stringify(characterSummary)}
    Story Type: ${inputData.storyType || 'adventure'}
    Story Details: ${inputData.storyDetails || 'None'}
    Dedication: ${inputData.dedication || 'None'}`;
}

function parseSceneDescriptions(text, expectedCount) {
  // Parse scene descriptions from the generated text
  // Split by double newlines and filter out invalid entries
  const scenes = text.split('\n\n')
    .map(s => s.trim())
    .filter(s => {
      // Filter out empty, separators, or very short scenes
      if (!s) return false;
      if (s === '---' || s === '***' || s === '___') return false;
      if (s.length < 20) return false; // Too short to be a real scene description
      if (s.match(/^(Page|Scene|Chapter)\s+\d+/i)) return false; // Page headers
      return true;
    });

  log.debug(`📋 [PARSE] Found ${scenes.length} valid scenes (expected ${expectedCount})`);

  // Log each scene for debugging
  scenes.forEach((scene, i) => {
    const preview = scene.substring(0, 80) + (scene.length > 80 ? '...' : '');
    log.debug(`📋 [PARSE] Scene ${i + 1}: ${preview}`);
  });

  // If we have more scenes than expected, take only the first expectedCount
  if (scenes.length > expectedCount) {
    log.warn(`[PARSE] Got ${scenes.length} scenes but expected ${expectedCount}, trimming excess`);
    return scenes.slice(0, expectedCount);
  }

  // If we have fewer scenes than expected, warn but continue
  if (scenes.length < expectedCount) {
    log.warn(`[PARSE] Got only ${scenes.length} scenes but expected ${expectedCount}`);
  }

  return scenes;
}

/**
 * Build relative height description for characters
 * Instead of absolute cm values, describes relative heights which AI understands better
 * @param {Array} characters - Array of character objects with name and height properties
 * @returns {string} Description like "Height order: Emma (shortest), Max (much taller), Dad (slightly taller)"
 */
function buildRelativeHeightDescription(characters) {
  if (!characters || characters.length < 2) return '';

  // Filter characters that have height and sort by height
  // Support both new structure (char.physical.height) and legacy (char.height)
  const withHeight = characters
    .map(c => {
      const height = c.height || c.physical?.height;
      return { name: c.name, height: height ? parseInt(height) : NaN };
    })
    .filter(c => !isNaN(c.height))
    .sort((a, b) => a.height - b.height);

  if (withHeight.length < 2) return '';

  // Build relative description
  const descriptions = [];

  for (let i = 0; i < withHeight.length; i++) {
    const char = withHeight[i];

    if (i === 0) {
      // First (shortest) character
      descriptions.push(`${char.name} (shortest)`);
    } else {
      // Compare to previous character
      const prev = withHeight[i - 1];
      const diff = char.height - prev.height;

      let descriptor;
      if (diff <= 3) {
        descriptor = 'about the same height';
      } else if (diff <= 8) {
        descriptor = 'slightly taller';
      } else if (diff <= 15) {
        descriptor = 'a bit taller';
      } else if (diff <= 25) {
        descriptor = 'taller';
      } else if (diff <= 40) {
        descriptor = 'much taller';
      } else {
        descriptor = 'a lot taller';
      }

      descriptions.push(`${char.name} (${descriptor})`);
    }
  }

  return `**HEIGHT ORDER (shortest to tallest):** ${descriptions.join(' → ')}`;
}

function buildImagePrompt(sceneDescription, inputData, sceneCharacters = null, isSequential = false, visualBible = null, pageNumber = null, isStorybook = false) {
  // Build image generation prompt (matches step-by-step format)
  // For storybook mode: visualBible entries are added here since there's no separate scene description step
  // For parallel/sequential modes: Visual Bible is also in scene description, but adding here ensures consistency
  const artStyleId = inputData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;
  const language = (inputData.language || 'en').toLowerCase();

  // Build character reference list (Option B: explicit labeling in prompt)
  let characterReferenceList = '';
  if (sceneCharacters && sceneCharacters.length > 0) {
    console.log(`📖 [IMAGE PROMPT] Scene characters: ${sceneCharacters.map(c => c.name).join(', ')}`);

    // Build a numbered list of characters with brief descriptions
    const charDescriptions = sceneCharacters.map((char, index) => {
      const age = char.age ? `${char.age} years old` : '';
      const gender = char.gender === 'male' ? 'boy/man' : char.gender === 'female' ? 'girl/woman' : '';
      const brief = [char.name, age, gender].filter(Boolean).join(', ');
      return `${index + 1}. ${brief}`;
    });

    // Build relative height description (AI understands this better than cm values)
    const heightDescription = buildRelativeHeightDescription(sceneCharacters);

    characterReferenceList = `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;

    if (heightDescription) {
      characterReferenceList += `\n${heightDescription}\n`;
      console.log(`📏 [IMAGE PROMPT] Added relative heights: ${heightDescription}`);
    }
  }

  // Build Visual Bible section with ALL recurring elements (animals, artifacts, locations)
  let visualBibleSection = '';
  if (visualBible && pageNumber !== null) {
    const sceneCharacterNames = sceneCharacters ? sceneCharacters.map(c => c.name) : null;
    visualBibleSection = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames, language);
    if (visualBibleSection) {
      console.log(`📖 [IMAGE PROMPT] Added Visual Bible section for page ${pageNumber}`);
    }
  }

  // Select the correct template based on mode and language
  let template = null;
  let templateName = '';
  if (isStorybook && PROMPT_TEMPLATES.imageGenerationStorybook) {
    // Storybook mode template (includes Visual Bible section)
    template = PROMPT_TEMPLATES.imageGenerationStorybook;
    templateName = 'storybook';
  } else if (isSequential) {
    // Sequential mode templates (with visual continuity instructions)
    if (language === 'de' && PROMPT_TEMPLATES.imageGenerationSequentialDe) {
      template = PROMPT_TEMPLATES.imageGenerationSequentialDe;
    } else if (language === 'fr' && PROMPT_TEMPLATES.imageGenerationSequentialFr) {
      template = PROMPT_TEMPLATES.imageGenerationSequentialFr;
    } else if (PROMPT_TEMPLATES.imageGenerationSequential) {
      template = PROMPT_TEMPLATES.imageGenerationSequential;
    }
    templateName = 'sequential';
  } else {
    // Parallel mode templates
    if (language === 'de' && PROMPT_TEMPLATES.imageGenerationDe) {
      template = PROMPT_TEMPLATES.imageGenerationDe;
    } else if (language === 'fr' && PROMPT_TEMPLATES.imageGenerationFr) {
      template = PROMPT_TEMPLATES.imageGenerationFr;
    } else if (PROMPT_TEMPLATES.imageGeneration) {
      template = PROMPT_TEMPLATES.imageGeneration;
    }
    templateName = 'parallel';
  }

  // Use template if available, otherwise fall back to hardcoded prompt
  if (template) {
    console.log(`📝 [IMAGE PROMPT] Using ${templateName} template for language: ${language}`);
    // Fill all placeholders in template
    return fillTemplate(template, {
      STYLE_DESCRIPTION: styleDescription,
      SCENE_DESCRIPTION: sceneDescription,
      CHARACTER_REFERENCE_LIST: characterReferenceList,
      VISUAL_BIBLE: visualBibleSection,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8
    });
  }

  // Fallback to hardcoded prompt
  return `Create a cinematic scene in ${styleDescription}.

${characterReferenceList}
Scene Description: ${sceneDescription}
${visualBibleSection}
Important:
- Match characters to the reference photos provided
- Show appropriate emotions on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years old`;
}

/**
 * Unified text model API caller
 * Uses the configured TEXT_MODEL env var to select provider
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens in response
 * @returns {Promise<string>} Generated text
 */
async function callTextModel(prompt, maxTokens = 4096) {
  const model = activeTextModel;

  // Cap maxTokens to model limit
  const effectiveMaxTokens = Math.min(maxTokens, model.maxOutputTokens);

  log.verbose(`🤖 [TEXT] Calling ${TEXT_MODEL} (${model.modelId}) with max ${effectiveMaxTokens} tokens`);

  switch (model.provider) {
    case 'anthropic':
      return await callAnthropicAPI(prompt, effectiveMaxTokens, model.modelId);
    case 'google':
      return await callGeminiTextAPI(prompt, effectiveMaxTokens, model.modelId);
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
}

/**
 * Call Anthropic Claude API
 */
async function callAnthropicAPI(prompt, maxTokens, modelId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  // Calculate timeout based on expected tokens (larger requests need more time)
  // Minimum 5 minutes, + 3 seconds per 1000 tokens for very large requests
  const timeoutMs = Math.max(300000, 180000 + Math.ceil(maxTokens / 1000) * 3000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: prompt
      }]
    }),
    signal: AbortSignal.timeout(timeoutMs)  // Dynamic timeout based on token count
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Extract token usage
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [ANTHROPIC] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  return {
    text: data.content[0].text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Call Anthropic Claude API with streaming
 * Streams text as it's generated, calling onChunk for each piece
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {string} modelId - The model ID to use
 * @param {function} onChunk - Callback function called with each text chunk: (chunk: string, fullText: string) => void
 * @returns {Promise<string>} The complete generated text
 */
async function callAnthropicAPIStreaming(prompt, maxTokens, modelId, onChunk) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  console.log(`🌊 [STREAM] Starting streaming request to Anthropic (${maxTokens} max tokens)...`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      stream: true,  // Enable streaming
      messages: [{
        role: 'user',
        content: prompt
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  // Process the Server-Sent Events stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  // Helper function to process SSE lines
  const processLine = (line) => {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);  // Remove 'data: ' prefix

      if (data === '[DONE]') return;

      try {
        const event = JSON.parse(data);

        // Handle content_block_delta events (these contain the text)
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const textChunk = event.delta.text;
          fullText += textChunk;

          // Call the onChunk callback
          if (onChunk) {
            onChunk(textChunk, fullText);
          }
        }

        // Handle error events from Claude API
        if (event.type === 'error') {
          console.error(`❌ [STREAM] API error event:`, event.error);
          throw new Error(`Claude API stream error: ${event.error?.message || JSON.stringify(event.error)}`);
        }

        // Capture input tokens from message_start
        if (event.type === 'message_start' && event.message?.usage?.input_tokens) {
          inputTokens = event.message.usage.input_tokens;
        }

        // Capture stop_reason and output tokens from message_delta
        if (event.type === 'message_delta') {
          if (event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          if (event.usage?.output_tokens) {
            outputTokens = event.usage.output_tokens;
          }
        }

        // Log when streaming completes
        if (event.type === 'message_stop') {
          console.log(`🌊 [STREAM] Streaming complete, received ${fullText.length} chars, stop_reason: ${stopReason}`);
          log.debug(`📊 [STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
        }
      } catch (parseError) {
        // Log parse errors for debugging (but don't fail on empty lines)
        if (data && data !== '[DONE]') {
          log.warn(`[STREAM] Failed to parse SSE data: ${data.substring(0, 100)}`);
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';  // Keep incomplete line in buffer

      for (const line of lines) {
        processLine(line);
      }
    }

    // Process any remaining buffer content after stream ends
    if (buffer.trim()) {
      const remainingLines = buffer.split('\n');
      for (const line of remainingLines) {
        processLine(line);
      }
    }

    // Flush the decoder to get any remaining bytes
    const remaining = decoder.decode();
    if (remaining) {
      const finalLines = remaining.split('\n');
      for (const line of finalLines) {
        processLine(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Warn if response was truncated due to max_tokens
  if (stopReason === 'max_tokens') {
    log.warn(`[STREAM] Response was TRUNCATED due to max_tokens limit (${maxTokens})! Text may be incomplete.`);
  }

  // Warn if response is empty (possible API issue)
  if (fullText.length === 0) {
    console.error(`❌ [STREAM] Response is EMPTY! stopReason: ${stopReason}, maxTokens: ${maxTokens}`);
  }

  return {
    text: fullText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Call text model with streaming support
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {function} onChunk - Callback for each text chunk: (chunk: string, fullText: string) => void
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}}>} The complete generated text and usage
 */
async function callTextModelStreaming(prompt, maxTokens = 4096, onChunk = null) {
  const model = activeTextModel;

  // Cap maxTokens to model limit
  const effectiveMaxTokens = Math.min(maxTokens, model.maxOutputTokens);

  log.verbose(`🤖 [TEXT-STREAM] Calling ${TEXT_MODEL} (${model.modelId}) with max ${effectiveMaxTokens} tokens (streaming)`);

  switch (model.provider) {
    case 'anthropic':
      return await callAnthropicAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk);
    case 'google':
      // Fallback to non-streaming for Gemini (streaming implementation can be added later)
      log.warn(`[TEXT-STREAM] Gemini streaming not implemented, falling back to non-streaming`);
      const result = await callGeminiTextAPI(prompt, effectiveMaxTokens, model.modelId);
      // callGeminiTextAPI returns { text, usage } - pass through
      return result;
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
}

/**
 * Progressive cover parser for streaming story generation
 * Detects Visual Bible and cover scenes as they complete during streaming
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
        console.log(`🌊 [STREAM-COVER] Visual Bible section complete (${visualBibleSection.length} chars)`);
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
          console.log(`🌊 [STREAM-COVER] Title Page scene complete: ${scene.substring(0, 80)}...${extractedTitle ? ` (title: ${extractedTitle})` : ''}`);
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
          console.log(`🌊 [STREAM-COVER] Initial Page scene complete: ${scene.substring(0, 80)}...`);
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
          console.log(`🌊 [STREAM-COVER] Back Cover scene complete: ${scene.substring(0, 80)}...`);
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

        console.log(`🌊 [STREAM-PARSE] Scene ${pageNum} complete, emitting...`);

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
          console.log(`🌊 [STREAM-PAGE] Page ${pageNum} complete (${content.length} chars), emitting...`);

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
          console.log(`🌊 [STREAM-PAGE] Final page ${pageNum} complete (${content.length} chars), emitting...`);

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

/**
 * Call Google Gemini API for text generation
 */
async function callGeminiTextAPI(prompt, maxTokens, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
        ]
      })
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Log full response for debugging
  if (!data.candidates || data.candidates.length === 0) {
    console.error('❌ [GEMINI] Empty response. Full data:', JSON.stringify(data, null, 2));
    if (data.promptFeedback) {
      console.error('❌ [GEMINI] Prompt feedback:', JSON.stringify(data.promptFeedback));
    }
    throw new Error(`No response from Gemini API: ${data.promptFeedback?.blockReason || 'unknown reason'}`);
  }

  // Check if content was blocked
  if (data.candidates[0].finishReason === 'SAFETY') {
    console.error('❌ [GEMINI] Content blocked by safety filter');
    throw new Error('Gemini blocked content due to safety filter');
  }

  if (!data.candidates[0].content || !data.candidates[0].content.parts) {
    console.error('❌ [GEMINI] Missing content in response:', JSON.stringify(data.candidates[0], null, 2));
    throw new Error('Gemini returned empty content');
  }

  // Extract token usage from usageMetadata
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [GEMINI-TEXT] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  return {
    text: data.candidates[0].content.parts[0].text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

// Backward compatibility alias
async function callClaudeAPI(prompt, maxTokens = 4096) {
  return callTextModel(prompt, maxTokens);
}

/**
 * Generate cache key for image generation
 * Creates a hash from prompt + character photo hashes
 */
function generateImageCacheKey(prompt, characterPhotos = [], sequentialMarker = null) {
  // Hash each photo and sort them for consistency
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  const photoHashes = characterPhotos
    .map(p => typeof p === 'string' ? p : p?.photoUrl)
    .filter(url => url && url.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  // Combine prompt + photo hashes + sequential marker (to distinguish sequential vs parallel cache)
  const combined = `${prompt}|${photoHashes}|${sequentialMarker || ''}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Crop image to change aspect ratio for sequential mode
 * Used in sequential mode to prevent AI from copying too much from the reference image
 * Crops 15% from top and 15% from bottom to force regeneration while preserving central context
 * @param {string} imageBase64 - Base64 encoded image (with data URI prefix)
 * @returns {Promise<string>} Cropped base64 encoded image with data URI prefix
 */
async function cropImageForSequential(imageBase64) {
  try {
    // Remove data URI prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get image metadata to know dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    if (!width || !height) {
      console.log('⚠️ [CROP] Could not get image dimensions, returning original');
      return imageBase64;
    }

    // Crop 15% from top and 15% from bottom (30% total) - focuses on central content
    const cropTop = Math.floor(height * 0.15);
    const cropBottom = Math.floor(height * 0.15);
    const newHeight = height - cropTop - cropBottom;

    console.log(`✂️ [CROP] Cropping reference image: ${width}x${height} → ${width}x${newHeight} (removed ${cropTop}px from top, ${cropBottom}px from bottom)`);

    // Crop the image - extract from cropTop offset
    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left: 0, top: cropTop, width: width, height: newHeight })
      .png()
      .toBuffer();

    // Convert back to base64 with data URI prefix
    const croppedBase64 = `data:image/png;base64,${croppedBuffer.toString('base64')}`;

    return croppedBase64;
  } catch (err) {
    console.error('❌ [CROP] Error cropping image:', err.message);
    // Return original image if cropping fails
    return imageBase64;
  }
}

/**
 * Compress PNG image to JPEG format
 * Converts base64 PNG to JPEG with compression to reduce file size
 * @param {string} pngBase64 - Base64 encoded PNG image (with or without data URI prefix)
 * @returns {Promise<string>} Base64 encoded JPEG image with data URI prefix
 */
async function compressImageToJPEG(pngBase64) {
  try {
    // Remove data URI prefix if present
    const base64Data = pngBase64.replace(/^data:image\/\w+;base64,/, '');

    // Convert base64 to buffer
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Get original size
    const originalSizeKB = (imageBuffer.length / 1024).toFixed(2);

    // Compress to JPEG with quality 85 (good balance between quality and size)
    const compressedBuffer = await sharp(imageBuffer)
      .jpeg({ quality: 85, progressive: true })
      .toBuffer();

    // Convert back to base64
    const compressedBase64 = compressedBuffer.toString('base64');
    const compressedSizeKB = (compressedBuffer.length / 1024).toFixed(2);

    console.log(`🗜️  [COMPRESSION] PNG ${originalSizeKB} KB → JPEG ${compressedSizeKB} KB (${((1 - compressedBuffer.length / imageBuffer.length) * 100).toFixed(1)}% reduction)`);

    return `data:image/jpeg;base64,${compressedBase64}`;
  } catch (error) {
    console.error('❌ [COMPRESSION] Error compressing image:', error);
    throw error;
  }
}

/**
 * Evaluate image quality using Claude API
 * Sends the image to Claude for quality assessment
 * @param {string} imageData - Base64 encoded image with data URI prefix
 * @param {string} originalPrompt - The prompt used to generate the image
 * @param {string[]} referenceImages - Reference images used for generation
 * @param {string} evaluationType - Type of evaluation: 'scene' (default) or 'cover' (text-focused)
 * @returns {Promise<number>} Quality score from 0-100
 */
async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = [], evaluationType = 'scene') {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      log.verbose('⚠️  [QUALITY] Gemini API key not configured, skipping quality evaluation');
      return null;
    }

    // Extract base64 and mime type for generated image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Select evaluation prompt based on type
    // Cover images use text-focused evaluation (automatic 0 for text errors)
    // Scene images use standard character/style evaluation
    let evaluationTemplate;
    if (evaluationType === 'cover' && PROMPT_TEMPLATES.coverImageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.coverImageEvaluation;
      log.verbose('⭐ [QUALITY] Using COVER evaluation (text-focused)');
    } else if (PROMPT_TEMPLATES.imageEvaluation) {
      evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      log.verbose('⭐ [QUALITY] Using SCENE evaluation (standard)');
    } else {
      evaluationTemplate = null;
    }

    const evaluationPrompt = evaluationTemplate
      ? fillTemplate(evaluationTemplate, { ORIGINAL_PROMPT: originalPrompt })
      : 'Evaluate this AI-generated children\'s storybook illustration on a scale of 0-100. Consider: visual appeal, clarity, artistic quality, age-appropriateness, and technical quality. Respond with ONLY a number between 0-100, nothing else.';

    // Build content array for Gemini format
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Add reference images if provided
    // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
    if (referenceImages && referenceImages.length > 0) {
      let addedCount = 0;
      referenceImages.forEach(refImg => {
        // Handle both formats: string URL or {name, photoUrl} object
        const photoUrl = typeof refImg === 'string' ? refImg : refImg?.photoUrl;
        if (photoUrl && photoUrl.startsWith('data:image')) {
          const refBase64 = photoUrl.replace(/^data:image\/\w+;base64,/, '');
          const refMimeType = photoUrl.match(/^data:(image\/\w+);base64,/) ?
            photoUrl.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';
          parts.push({
            inline_data: {
              mime_type: refMimeType,
              data: refBase64
            }
          });
          addedCount++;
        }
      });
      log.verbose(`⭐ [QUALITY] Added ${addedCount}/${referenceImages.length} reference images for evaluation`);
    }

    // Add evaluation prompt text
    parts.push({ text: evaluationPrompt });

    // Use Gemini Flash for fast quality evaluation
    const modelId = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.3
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [QUALITY] Gemini API error:', error);
      return null;
    }

    const data = await response.json();

    // Extract and log token usage for quality evaluation
    const qualityInputTokens = data.usageMetadata?.promptTokenCount || 0;
    const qualityOutputTokens = data.usageMetadata?.candidatesTokenCount || 0;
    if (qualityInputTokens > 0 || qualityOutputTokens > 0) {
      log.verbose(`📊 [QUALITY] Token usage - input: ${qualityInputTokens.toLocaleString()}, output: ${qualityOutputTokens.toLocaleString()}`);
    }

    if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
      log.warn('⚠️  [QUALITY] No text response from Gemini');
      return null;
    }

    const responseText = data.candidates[0].content.parts[0].text.trim();

    // Parse the new format: "Score: XX/100\n\nReasoning: ..."
    const scoreMatch = responseText.match(/Score:\s*(\d+)\/100/i);
    if (!scoreMatch) {
      // Fallback to old format (just a number)
      const score = parseFloat(responseText);
      if (!isNaN(score) && score >= 0 && score <= 100) {
        log.verbose(`⭐ [QUALITY] Image quality score: ${score}/100 (legacy format)`);
        return score;
      }
      log.warn('⚠️  [QUALITY] Could not parse score from response:', responseText.substring(0, 100));
      return null;
    }

    const score = parseInt(scoreMatch[1]);
    // Match "Reasoning:" or "Reasoning" (with or without colon) - captures until "Score:" at end
    const reasoningMatch = responseText.match(/Reasoning:?\s*([\s\S]*?)(?=\nScore:|$)/i);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

    // Also capture the new "Picture analysis" section if present
    const pictureAnalysisMatch = responseText.match(/Picture analysis:\s*([\s\S]*?)(?=\nReasoning|$)/i);
    const pictureAnalysis = pictureAnalysisMatch ? pictureAnalysisMatch[1].trim() : '';

    // Parse cover-specific fields (text error detection)
    const textErrorOnlyMatch = responseText.match(/Text_Error_Only:\s*(YES|NO)/i);
    const expectedTextMatch = responseText.match(/Expected_Text:\s*([^\n]+)/i);
    const actualTextMatch = responseText.match(/Actual_Text:\s*([^\n]+)/i);
    const textIssueMatch = responseText.match(/Text_Issue:\s*(NONE|MISSPELLED|WRONG_WORDS|MISSING|ILLEGIBLE|PARTIAL|UNWANTED)/i);

    const textErrorOnly = textErrorOnlyMatch ? textErrorOnlyMatch[1].toUpperCase() === 'YES' : false;
    const expectedText = expectedTextMatch ? expectedTextMatch[1].trim() : null;
    const actualText = actualTextMatch ? actualTextMatch[1].trim() : null;
    const textIssue = textIssueMatch ? textIssueMatch[1].toUpperCase() : null;

    // Debug logging for quality parsing
    if (evaluationType === 'cover') {
      log.verbose(`⭐ [QUALITY PARSE] Raw score: ${score}, Text_Issue: ${textIssue || 'not found'}, Expected_Text: ${expectedText || 'not found'}, Actual_Text: ${actualText || 'not found'}`);
      // If score is 0 but no text issue detected, log full response for debugging
      if (score === 0 && (!textIssue || textIssue === 'NONE')) {
        log.warn(`⚠️  [QUALITY] AI returned score 0 but no text issue detected! Full response (first 500 chars):\n${responseText.substring(0, 500)}`);
      }
    }

    // ENFORCE text error = score 0 for covers (Gemini sometimes ignores this instruction)
    let finalScore = score;

    // Exception: If no text was expected and text is missing, that's correct behavior
    const noTextExpected = expectedText && expectedText.toUpperCase() === 'NO TEXT';
    const isExpectedNoText = noTextExpected && textIssue === 'MISSING';

    if (evaluationType === 'cover' && textIssue && textIssue !== 'NONE' && !isExpectedNoText) {
      log.warn(`⚠️  [QUALITY] Cover text error detected (${textIssue}) - enforcing score = 0`);
      log.warn(`⚠️  [QUALITY] Expected: "${expectedText}" | Actual: "${actualText}"`);
      log.warn(`⚠️  [QUALITY] Original Gemini score was ${score}, overriding to 0`);
      finalScore = 0;
    } else if (isExpectedNoText) {
      log.verbose(`✅ [QUALITY] No text expected and none found - correct behavior`);
    }

    log.verbose(`⭐ [QUALITY] Image quality score: ${finalScore}/100`);
    if (textIssue && textIssue !== 'NONE') {
      log.verbose(`⭐ [QUALITY] Text issue detected: ${textIssue}`);
      log.verbose(`⭐ [QUALITY] Expected: "${expectedText}" | Actual: "${actualText}"`);
      log.verbose(`⭐ [QUALITY] Text error only: ${textErrorOnly}`);
    }
    if (reasoning) {
      log.verbose(`⭐ [QUALITY] Reasoning: ${reasoning.substring(0, 150)}...`);
    }

    // Return score, full raw response, text-specific info, usage, and model for covers
    return {
      score: finalScore,
      reasoning: responseText, // Return full raw API response for transparency
      textErrorOnly,
      expectedText,
      actualText,
      textIssue,
      usage: { input_tokens: qualityInputTokens, output_tokens: qualityOutputTokens },
      modelId: modelId  // Include quality model for usage tracking
    };
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
    return null;
  }
}

/**
 * Rewrite a blocked scene description to be safer while preserving the story moment
 * @param {string} sceneDescription - The original scene that was blocked
 * @returns {Promise<string>} - The rewritten, safer scene description
 */
async function rewriteBlockedScene(sceneDescription) {
  console.log(`🔄 [REWRITE] Rewriting blocked scene to be safer...`);
  console.log(`🔄 [REWRITE] Original: ${sceneDescription.substring(0, 100)}...`);

  try {
    const rewritePrompt = fillTemplate(PROMPT_TEMPLATES.rewriteBlockedScene, {
      SCENE_DESCRIPTION: sceneDescription
    });

    const rewriteResult = await callTextModel(rewritePrompt, 1000);
    const rewrittenScene = rewriteResult.text;
    console.log(`✅ [REWRITE] Scene rewritten: ${rewrittenScene.substring(0, 100)}...`);
    return rewrittenScene.trim();
  } catch (error) {
    console.error(`❌ [REWRITE] Failed to rewrite scene:`, error.message);
    throw error;
  }
}

async function callGeminiAPIForImage(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null) {
  // Check cache first (include previousImage presence in cache key for sequential mode)
  const cacheKey = generateImageCacheKey(prompt, characterPhotos, previousImage ? 'seq' : null);

  if (imageCache.has(cacheKey)) {
    log.verbose('💾 [IMAGE CACHE] Cache HIT - reusing previously generated image');
    log.debug('💾 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');
    log.debug('💾 [IMAGE CACHE] Cache size:', imageCache.size, 'images');
    const cachedResult = imageCache.get(cacheKey);
    // Call onImageReady for cache hits too (for progressive display)
    if (onImageReady && cachedResult.imageData) {
      try {
        await onImageReady(cachedResult.imageData, cachedResult.modelId);
        console.log('📤 [IMAGE CACHE] Cached image sent for immediate display');
      } catch (callbackError) {
        console.error('⚠️ [IMAGE CACHE] onImageReady callback error:', callbackError.message);
      }
    }
    return cachedResult;
  }

  log.verbose('🆕 [IMAGE CACHE] Cache MISS - generating new image');
  log.debug('🆕 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');

  // Call Gemini API for image generation with optional character reference images
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Build parts array with prompt + reference images
  const parts = [{ text: prompt }];

  // For sequential mode: Add PREVIOUS scene image FIRST (most important for continuity)
  // Crop the image slightly to change aspect ratio - this forces AI to regenerate
  // rather than copying too much from the reference image
  if (previousImage && previousImage.startsWith('data:image')) {
    // Crop 15% from top and bottom to change aspect ratio
    const croppedImage = await cropImageForSequential(previousImage);

    const base64Data = croppedImage.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = croppedImage.match(/^data:(image\/\w+);base64,/) ?
      croppedImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

    parts.push({
      inline_data: {
        mime_type: mimeType,
        data: base64Data
      }
    });
    log.debug(`🖼️  [IMAGE GEN] Added cropped previous scene image for visual continuity (SEQUENTIAL MODE)`);
  }

  // Add character photos as reference images
  // Supports both: array of URLs (legacy) or array of {name, photoUrl} objects (new)
  if (characterPhotos && characterPhotos.length > 0) {
    let addedCount = 0;
    let skippedCount = 0;
    const characterNames = [];
    const apiImageHashes = [];  // Track hashes of images actually sent to API

    characterPhotos.forEach((photoData, index) => {
      // Handle both formats: string URL or {name, photoUrl} object
      const photoUrl = typeof photoData === 'string' ? photoData : photoData?.photoUrl;
      const characterName = typeof photoData === 'object' ? photoData?.name : null;
      const providedHash = typeof photoData === 'object' ? photoData?.photoHash : null;

      if (photoUrl && photoUrl.startsWith('data:image')) {
        const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = photoUrl.match(/^data:(image\/\w+);base64,/) ?
          photoUrl.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

        // Calculate hash of the actual data being sent to API
        const apiHash = hashImageData(photoUrl);
        apiImageHashes.push({
          name: characterName || `photo_${index + 1}`,
          hash: apiHash,
          matchesProvided: providedHash ? apiHash === providedHash : null
        });

        // Option A: Add text label BEFORE the image if we have a name
        if (characterName) {
          parts.push({ text: `[Reference photo of ${characterName}]:` });
          characterNames.push(characterName);
        }

        parts.push({
          inline_data: {
            mime_type: mimeType,
            data: base64Data
          }
        });
        addedCount++;
      } else {
        skippedCount++;
        // Log warning for skipped photos to help diagnose issues
        const preview = photoUrl ? photoUrl.substring(0, 50) : 'null/undefined';
        log.warn(`[IMAGE GEN] Skipping character photo ${index + 1}: not a valid data URL (starts with: ${preview}...)`);
      }
    });

    // Log hashes of images being sent to API
    if (apiImageHashes.length > 0) {
      console.log(`🔐 [IMAGE GEN] API image hashes:`, apiImageHashes.map(h => `${h.name}:${h.hash}`).join(', '));
    }

    if (characterNames.length > 0) {
      log.debug(`🖼️  [IMAGE GEN] Added ${addedCount} LABELED reference images: ${characterNames.join(', ')}`);
    } else {
      log.debug(`🖼️  [IMAGE GEN] Added ${addedCount}/${characterPhotos.length} character reference images (unlabeled)`);
    }
    if (skippedCount > 0) {
      log.warn(`[IMAGE GEN] WARNING: ${skippedCount} photos were SKIPPED (not base64 data URLs)`);
    }
  }

  // Use Gemini 3 Pro Image for covers (higher quality), 2.5 Flash for scenes (faster)
  const modelId = evaluationType === 'cover' ? 'gemini-3-pro-image-preview' : 'gemini-2.5-flash-image';

  const requestBody = {
    contents: [{
      parts: parts
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.8,
      imageConfig: {
        aspectRatio: "1:1"
      }
    }
  };

  console.log('🖼️  [IMAGE GEN] Calling Gemini API with prompt:', prompt.substring(0, 100) + '...');
  log.debug(`🖼️  [IMAGE GEN] Model: ${modelId}, Aspect Ratio: 1:1, Temperature: 0.8`);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }
  );

  console.log('🖼️  [IMAGE GEN] Response status:', response.status, response.statusText);

  if (!response.ok) {
    const error = await response.text();
    console.error('❌ [IMAGE GEN] Gemini API error response:', error);
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Extract token usage from response
  const imageUsage = {
    input_tokens: data.usageMetadata?.promptTokenCount || 0,
    output_tokens: data.usageMetadata?.candidatesTokenCount || 0
  };
  if (imageUsage.input_tokens > 0 || imageUsage.output_tokens > 0) {
    log.debug(`📊 [IMAGE GEN] Token usage - input: ${imageUsage.input_tokens.toLocaleString()}, output: ${imageUsage.output_tokens.toLocaleString()}`);
  }

  // Log response structure (without base64 data to avoid massive logs)
  console.log('🖼️  [IMAGE GEN] Response structure:', {
    hasCandidates: !!data.candidates,
    candidatesCount: data.candidates?.length || 0,
    responseKeys: Object.keys(data)
  });

  if (!data.candidates || data.candidates.length === 0) {
    console.error('❌ [IMAGE GEN] No candidates in response. Response keys:', Object.keys(data));
    throw new Error('No image generated - no candidates in response');
  }

  // Extract image data
  const candidate = data.candidates[0];
  console.log('🖼️  [IMAGE GEN] Candidate structure:', {
    hasContent: !!candidate.content,
    hasParts: !!candidate.content?.parts,
    partsCount: candidate.content?.parts?.length || 0,
    candidateKeys: Object.keys(candidate)
  });

  if (candidate.content && candidate.content.parts) {
    console.log('🖼️  [IMAGE GEN] Found', candidate.content.parts.length, 'parts in candidate');
    for (const part of candidate.content.parts) {
      console.log('🖼️  [IMAGE GEN] Part keys:', Object.keys(part));
      // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API may vary
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data) {
        const imageDataSize = inlineData.data.length;
        const imageSizeKB = (imageDataSize / 1024).toFixed(2);
        console.log(`✅ [IMAGE GEN] Successfully extracted image data (${imageSizeKB} KB base64)`);
        const pngImageData = `data:image/png;base64,${inlineData.data}`;

        // Compress PNG to JPEG
        console.log('🗜️  [COMPRESSION] Compressing image to JPEG...');
        const compressedImageData = await compressImageToJPEG(pngImageData);

        // Call onImageReady callback immediately (before quality eval) for progressive display
        if (onImageReady) {
          try {
            await onImageReady(compressedImageData, modelId);
            console.log('📤 [IMAGE GEN] Image sent for immediate display (quality eval pending)');
          } catch (callbackError) {
            console.error('⚠️ [IMAGE GEN] onImageReady callback error:', callbackError.message);
          }
        }

        // Evaluate image quality with prompt and reference images
        console.log(`⭐ [QUALITY] Evaluating image quality (${evaluationType})...`);
        const qualityResult = await evaluateImageQuality(compressedImageData, prompt, characterPhotos, evaluationType);

        // Extract score, reasoning, and text error info from quality result
        const score = qualityResult ? qualityResult.score : null;
        const reasoning = qualityResult ? qualityResult.reasoning : null;
        const textIssue = qualityResult ? qualityResult.textIssue : null;
        const textErrorOnly = qualityResult ? qualityResult.textErrorOnly : false;
        const expectedText = qualityResult ? qualityResult.expectedText : null;
        const actualText = qualityResult ? qualityResult.actualText : null;
        const qualityUsage = qualityResult ? qualityResult.usage : null;
        const qualityModelId = qualityResult ? qualityResult.modelId : null;

        // Store in cache (include text error info for covers)
        const result = {
          imageData: compressedImageData,
          score,
          reasoning,
          textIssue,
          textErrorOnly,
          expectedText,
          actualText,
          modelId,  // Include which model was used for image generation
          qualityModelId,  // Include which model was used for quality evaluation
          imageUsage: imageUsage,  // Token usage for image generation
          qualityUsage: qualityUsage  // Token usage for quality evaluation
        };
        imageCache.set(cacheKey, result);
        log.verbose('💾 [IMAGE CACHE] Stored in cache. Total cached:', imageCache.size, 'images');

        return result;
      }
    }
  } else {
    console.error('❌ [IMAGE GEN] Unexpected candidate structure. Keys:', Object.keys(candidate));
    // Log the finishReason and finishMessage to understand why image was blocked
    if (candidate.finishReason) {
      console.error('🚫 [IMAGE GEN] FINISH REASON:', candidate.finishReason);
    }
    if (candidate.finishMessage) {
      console.error('🚫 [IMAGE GEN] FINISH MESSAGE:', candidate.finishMessage);
    }
    // Log the full candidate for debugging
    console.error('🚫 [IMAGE GEN] FULL CANDIDATE DUMP:', JSON.stringify(candidate, null, 2));

    // Throw with more context about why it failed
    const reason = candidate.finishReason || 'unknown';
    const message = candidate.finishMessage || 'no message';
    throw new Error(`Image blocked by API: reason=${reason}, message=${message}`);
  }

  console.error('❌ [IMAGE GEN] No image data found in any part');
  throw new Error('No image data in response - check logs for API response structure');
}

/**
 * Edit an image based on a user-provided prompt using Gemini's image editing capabilities
 * Pure text/instruction based - no character photos to avoid regeneration artifacts
 * @param {string} imageData - The original image data (base64)
 * @param {string} editInstruction - What the user wants to change
 * @returns {Promise<{imageData: string}|null>}
 */
async function editImageWithPrompt(imageData, editInstruction) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('Gemini API key not configured');
    }

    console.log(`✏️  [IMAGE EDIT] Editing image with instruction: "${editInstruction}"`);

    // Extract base64 and mime type from the image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build the editing prompt from template
    const editPrompt = fillTemplate(PROMPT_TEMPLATES.illustrationEdit, {
      '{EDIT_INSTRUCTION}': editInstruction
    });

    // Build parts array with ONLY the image and prompt - no character references
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: editPrompt }
    ];

    // Use Gemini 2.0 Flash for image editing (supports image generation/editing)
    const modelId = 'gemini-2.0-flash-exp-image-generation';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ['image', 'text'],
          temperature: 0.6
        }
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ [IMAGE EDIT] Gemini API error:', error);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();

    // Log response structure for debugging
    console.log('✏️  [IMAGE EDIT] Response structure:', {
      hasCandidates: !!data.candidates,
      candidatesCount: data.candidates?.length || 0,
      responseKeys: Object.keys(data)
    });

    // Extract the edited image from the response
    if (data.candidates && data.candidates[0]?.content?.parts) {
      const parts = data.candidates[0].content.parts;
      console.log(`✏️  [IMAGE EDIT] Found ${parts.length} parts in response`);

      for (const part of parts) {
        console.log('✏️  [IMAGE EDIT] Part keys:', Object.keys(part));
        // Check both camelCase (inlineData) and snake_case (inline_data) - Gemini API varies
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData && inlineData.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || 'image/png';
          const editedImageData = `data:${mimeType};base64,${inlineData.data}`;
          console.log(`✅ [IMAGE EDIT] Successfully edited image`);
          return { imageData: editedImageData };
        }
        if (part.text) {
          console.log('✏️  [IMAGE EDIT] Text response:', part.text.substring(0, 200));
        }
      }
    } else if (data.candidates && data.candidates[0]) {
      const candidate = data.candidates[0];
      console.log('✏️  [IMAGE EDIT] Candidate structure:', {
        hasContent: !!candidate.content,
        finishReason: candidate.finishReason,
        finishMessage: candidate.finishMessage
      });
    }

    console.warn('⚠️  [IMAGE EDIT] No edited image in response');
    return null;
  } catch (error) {
    console.error('❌ [IMAGE EDIT] Error editing image:', error);
    throw error;
  }
}

/**
 * Generate image with automatic retry if quality score is below threshold
 * Stores all attempts for dev mode viewing
 * @param {string} prompt - The image generation prompt
 * @param {string[]} characterPhotos - Character reference photos
 * @param {string|null} previousImage - Previous image for sequential mode
 * @param {string} evaluationType - Type of evaluation ('scene' or 'cover')
 * @param {Function|null} onImageReady - Optional callback called immediately when image is generated (before quality eval)
 * @param {Function|null} usageTracker - Optional callback to track token usage: (imageUsage, qualityUsage) => void
 * @returns {Promise<{imageData, score, reasoning, wasRegenerated, retryHistory, totalAttempts}>}
 */
async function generateImageWithQualityRetry(prompt, characterPhotos = [], previousImage = null, evaluationType = 'scene', onImageReady = null, usageTracker = null) {
  // MAX ATTEMPTS: 3 for both covers and scenes (allows 2 retries after initial attempt)
  const MAX_ATTEMPTS = 3;
  let bestResult = null;
  let bestScore = -1;
  let attempts = 0;
  let currentPrompt = prompt;
  let wasSceneRewritten = false;

  // Store all attempts for dev mode
  const retryHistory = [];

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    log.debug(`🎨 [QUALITY RETRY] Attempt ${attempts}/${MAX_ATTEMPTS} (threshold: ${IMAGE_QUALITY_THRESHOLD}%)...`);

    // Clear cache for retries to force new generation
    if (attempts > 1) {
      const cacheKey = generateImageCacheKey(currentPrompt, characterPhotos, previousImage ? 'seq' : null);
      imageCache.delete(cacheKey);
    }

    let result;
    try {
      result = await callGeminiAPIForImage(currentPrompt, characterPhotos, previousImage, evaluationType, onImageReady);
      // Track usage if tracker provided
      if (usageTracker && result) {
        usageTracker(result.imageUsage, result.qualityUsage, result.modelId, result.qualityModelId);
      }
    } catch (error) {
      // Check if this is a safety/content block error
      const errorMsg = error.message.toLowerCase();
      const isSafetyBlock = errorMsg.includes('blocked') || errorMsg.includes('safety') ||
                           errorMsg.includes('prohibited') || errorMsg.includes('filtered');

      if (isSafetyBlock && !wasSceneRewritten && attempts < MAX_ATTEMPTS) {
        console.log(`🚫 [QUALITY RETRY] Image blocked by safety filter, attempting to rewrite scene...`);

        // Extract scene description from prompt - supports English, German, and French
        const sceneMatch = currentPrompt.match(/Scene Description:\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/\*\*SCENE:\*\*\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/Szenenbeschreibung:\s*([\s\S]*?)(?=\n\n\*\*|$)/i) ||
                          currentPrompt.match(/Description de la scène:\s*([\s\S]*?)(?=\n\n\*\*|$)/i);

        if (sceneMatch && sceneMatch[1]) {
          try {
            const originalScene = sceneMatch[1].trim();
            const rewrittenScene = await rewriteBlockedScene(originalScene);

            // Replace scene in prompt
            currentPrompt = currentPrompt.replace(originalScene, rewrittenScene);
            wasSceneRewritten = true;

            // Record the rewrite attempt
            retryHistory.push({
              attempt: attempts,
              type: 'safety_block_rewrite',
              originalScene: originalScene.substring(0, 200),
              rewrittenScene: rewrittenScene.substring(0, 200),
              error: error.message,
              timestamp: new Date().toISOString()
            });

            // Don't increment attempts for the rewrite, let it retry with new prompt
            attempts--;
            continue;
          } catch (rewriteError) {
            console.error(`❌ [QUALITY RETRY] Scene rewrite failed:`, rewriteError.message);
          }
        } else {
          log.warn(`[QUALITY RETRY] Could not extract scene from prompt for rewriting. First 500 chars: ${currentPrompt.substring(0, 500)}`);
        }
      }

      // If we can't recover, record the error and continue
      retryHistory.push({
        attempt: attempts,
        type: 'generation_failed',
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // If this was the last attempt, throw the error
      if (attempts >= MAX_ATTEMPTS) {
        throw error;
      }
      continue;
    }
    const score = result.score || 0;
    console.log(`⭐ [QUALITY RETRY] Attempt ${attempts} score: ${score}%`);

    // Check for text errors on covers (but not when "NO TEXT" was expected and is missing)
    const noTextExpected = result.expectedText && result.expectedText.toUpperCase() === 'NO TEXT';
    const isExpectedNoText = noTextExpected && result.textIssue === 'MISSING';
    const hasTextError = evaluationType === 'cover' &&
      result.textIssue &&
      result.textIssue !== 'NONE' &&
      !isExpectedNoText;

    if (hasTextError) {
      log.debug(` RETRY] Text error: ${result.textIssue}`);
      log.debug(` RETRY] Expected: "${result.expectedText}" | Actual: "${result.actualText}"`);
    } else if (isExpectedNoText) {
      console.log(`✅ [QUALITY RETRY] No text expected and none found - correct`);
    }

    // Store this attempt in history
    retryHistory.push({
      attempt: attempts,
      type: 'generation',
      imageData: result.imageData,
      score: score,
      reasoning: result.reasoning,
      textIssue: result.textIssue || null,
      expectedText: result.expectedText || null,
      actualText: result.actualText || null,
      timestamp: new Date().toISOString()
    });

    // Track best result
    if (score > bestScore) {
      bestScore = score;
      bestResult = result;
    }

    // Success: meets threshold AND no text error
    if (score >= IMAGE_QUALITY_THRESHOLD && !hasTextError) {
      console.log(`✅ [QUALITY RETRY] Success on attempt ${attempts}! Score ${score}% >= ${IMAGE_QUALITY_THRESHOLD}%${wasSceneRewritten ? ' (scene was rewritten for safety)' : ''}`);
      return {
        imageData: result.imageData,
        score: result.score,
        reasoning: result.reasoning,
        wasRegenerated: attempts > 1,
        wasSceneRewritten: wasSceneRewritten,
        totalAttempts: attempts,
        retryHistory: retryHistory,
        modelId: result.modelId  // Include which model was used
      };
    }

  }

  // Exhausted all attempts - return best result we got
  log.warn(`[QUALITY RETRY] Max attempts (${MAX_ATTEMPTS}) reached. Best score: ${bestScore}%${wasSceneRewritten ? ' (scene was rewritten for safety)' : ''}`);
  return {
    imageData: bestResult.imageData,
    score: bestResult.score,
    reasoning: bestResult.reasoning,
    wasRegenerated: true,
    wasSceneRewritten: wasSceneRewritten,
    totalAttempts: attempts,
    retryHistory: retryHistory,
    modelId: bestResult.modelId  // Include which model was used
  };
}


// Create a new story generation job
app.post('/api/jobs/create-story', authenticateToken, async (req, res) => {
  try {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userId = req.user.id;
    const inputData = req.body;

    console.log(`📝 Creating story job ${jobId} for user ${req.user.username}`);

    // Check email verification (skip for admins)
    if (req.user.role !== 'admin' && STORAGE_MODE === 'database') {
      const emailCheckResult = await dbPool.query(
        'SELECT email_verified FROM users WHERE id = $1',
        [userId]
      );

      if (emailCheckResult.rows.length > 0 && !emailCheckResult.rows[0].email_verified) {
        log.warn(`User ${req.user.username} attempted story generation without verified email`);

        // Send/resend verification email
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
            await email.sendEmailVerificationEmail(user.email, user.username, verifyUrl);
            console.log(`📧 Verification email resent to: ${user.email}`);
          }
        } catch (emailErr) {
          console.error('Failed to send verification email:', emailErr.message);
        }

        return res.status(403).json({
          error: 'Email verification required',
          code: 'EMAIL_NOT_VERIFIED',
          message: 'Please verify your email first. We just sent you a verification link - story generation will start as soon as you verify your email.'
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
          console.log(`⏰ Job ${activeJob.id} is stale (${Math.round(jobAgeMinutes)} minutes old), marking as failed`);
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

        // Reserve credits (deduct from balance)
        const newBalance = userCredits - creditsNeeded;
        await dbPool.query(
          'UPDATE users SET credits = $1 WHERE id = $2',
          [newBalance, userId]
        );

        // Create transaction record for credit reservation
        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, -creditsNeeded, newBalance, 'story_reserve', jobId, `Reserved ${creditsNeeded} credits for ${pages}-page story`]
        );

        console.log(`💳 Reserved ${creditsNeeded} credits for job ${jobId} (user balance: ${userCredits} -> ${newBalance})`);
      }

      await dbPool.query(
        `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message, credits_reserved)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...', userCredits === -1 ? 0 : creditsNeeded]
      );

      // Update user's preferred language based on their story language choice
      if (inputData.language) {
        await dbPool.query(
          'UPDATE users SET preferred_language = $1 WHERE id = $2',
          [inputData.language, userId]
        );
        console.log(`🌐 Updated preferred language for user ${userId}: ${inputData.language}`);
      }
    } else {
      // File mode fallback - not supported for background jobs
      return res.status(503).json({
        error: 'Background jobs require database mode. Please use manual generation instead.'
      });
    }

    // Start processing the job asynchronously (don't await)
    processStoryJob(jobId).catch(err => {
      console.error(`❌ Job ${jobId} failed:`, err);
    });

    res.json({
      success: true,
      jobId,
      message: 'Story generation started. This will take approximately 10 minutes.'
    });
  } catch (err) {
    console.error('Error creating story job:', err);
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
    console.error('Error fetching job status:', err);
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

    console.log(`🛑 Job ${jobId} cancelled by user ${req.user.username}`);

    res.json({
      success: true,
      message: 'Job cancelled successfully',
      jobId: jobId
    });
  } catch (err) {
    console.error('Error cancelling job:', err);
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
    console.error('Error fetching user jobs:', err);
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
      console.error('⚠️  Database initialization failed, falling back to file storage');
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
    console.log(`\n=================================`);
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
      console.log(`📝 Logs: data/logs.json`);
      console.log(`👥 Users: data/users.json`);
    }
    log.debug(`=================================\n`);
  });
}).catch(err => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
