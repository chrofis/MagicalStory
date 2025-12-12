// MagicalStory Backend Server v1.0.4
// Includes: User quota system, email authentication, admin panel, PostgreSQL database support
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');
const { Pool } = require('pg');
const pLimit = require('p-limit');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_TEST_API_KEY);
const sharp = require('sharp');
const email = require('./email');
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('🔥 Firebase Admin SDK initialized');
  } catch (err) {
    console.warn('⚠️  Firebase Admin SDK initialization failed:', err.message);
  }
} else {
  console.warn('⚠️  FIREBASE_SERVICE_ACCOUNT not configured - Firebase auth disabled');
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

// Verbose logging mode - set VERBOSE_LOGGING=true for detailed debug output
const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true';

// Logging helper functions
const log = {
  info: (msg, ...args) => console.log(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
  warn: (msg, ...args) => console.warn(msg, ...args),
  // Verbose logs only show when VERBOSE_LOGGING is enabled
  verbose: (msg, ...args) => VERBOSE_LOGGING && console.log(`[VERBOSE] ${msg}`, ...args),
  // Debug logs for development
  debug: (msg, ...args) => VERBOSE_LOGGING && console.log(`[DEBUG] ${msg}`, ...args)
};

log.info(`📚 Story batch size: ${STORY_BATCH_SIZE === 0 ? 'DISABLED (generate all at once)' : STORY_BATCH_SIZE + ' pages per batch'}`);
log.info(`🔊 Verbose logging: ${VERBOSE_LOGGING ? 'ENABLED' : 'DISABLED'}`);

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
    PROMPT_TEMPLATES.imageEvaluation = await fs.readFile(path.join(promptsDir, 'image-evaluation.txt'), 'utf-8');
    PROMPT_TEMPLATES.frontCover = await fs.readFile(path.join(promptsDir, 'front-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageWithDedication = await fs.readFile(path.join(promptsDir, 'initial-page-with-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.initialPageNoDedication = await fs.readFile(path.join(promptsDir, 'initial-page-no-dedication.txt'), 'utf-8');
    PROMPT_TEMPLATES.backCover = await fs.readFile(path.join(promptsDir, 'back-cover.txt'), 'utf-8');
    PROMPT_TEMPLATES.storybookCombined = await fs.readFile(path.join(promptsDir, 'storybook-combined.txt'), 'utf-8');
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

console.log(`📦 Storage mode: ${STORAGE_MODE}`);
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
      callback(null, true); // Allow anyway for now, log for debugging
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Stripe webhook endpoint needs raw body for signature verification
// IMPORTANT: This MUST be defined BEFORE express.json() middleware
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Check if webhook secret is configured
  if (!webhookSecret) {
    console.error('❌ [STRIPE WEBHOOK] STRIPE_WEBHOOK_SECRET not configured in environment variables!');
    console.error('   Please add STRIPE_WEBHOOK_SECRET to your Railway environment variables');
    console.error('   Get the webhook signing secret from: https://dashboard.stripe.com/webhooks');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    // Verify the webhook signature to ensure it came from Stripe
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log('✅ [STRIPE WEBHOOK] Signature verified successfully');
  } catch (err) {
    console.error('❌ [STRIPE WEBHOOK] Signature verification failed:', err.message);
    console.error('   This webhook request did not come from Stripe or has been tampered with');
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }

  // Now handle the verified event
  try {
    console.log('💳 [STRIPE WEBHOOK] Received verified event:', event.type);

    // Handle the checkout.session.completed event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      console.log('✅ [STRIPE WEBHOOK] Payment successful!');
      console.log('   Session ID:', session.id);
      console.log('   Payment Intent:', session.payment_intent);
      console.log('   Amount:', session.amount_total, session.currency);

      // Retrieve full session with customer details
      try {
        const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
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

        // Store order in database
        if (STORAGE_MODE === 'database') {
          const userId = parseInt(fullSession.metadata?.userId);
          // Get storyId from metadata - could be numeric ID or job ID
          const storyIdRaw = fullSession.metadata?.storyId || fullSession.metadata?.story_id;
          const address = fullSession.shipping?.address || fullSession.customer_details?.address || {};

          // Validate required metadata
          if (!userId || isNaN(userId)) {
            console.error('❌ [STRIPE WEBHOOK] Invalid or missing userId in metadata:', fullSession.metadata);
            throw new Error('Invalid userId in session metadata');
          }
          if (!storyIdRaw) {
            console.error('❌ [STRIPE WEBHOOK] Missing storyId in metadata:', fullSession.metadata);
            console.error('❌ [STRIPE WEBHOOK] Session ID:', fullSession.id);
            throw new Error('Missing storyId in session metadata - cannot process book order');
          }

          // Handle both numeric story IDs and job IDs
          let storyId = null;
          let storyData = null;

          // Try as numeric ID first
          const numericId = parseInt(storyIdRaw);
          if (!isNaN(numericId)) {
            // It's a numeric story ID
            const result = await dbPool.query('SELECT id, data FROM stories WHERE id = $1 AND user_id = $2', [numericId, userId]);
            if (result.rows.length > 0) {
              storyId = numericId;
              storyData = result.rows[0].data;
              console.log('✅ [STRIPE WEBHOOK] Found story by numeric ID:', storyId);
            }
          }

          // If not found by numeric ID, try as job ID (which IS the database ID for job-based stories)
          if (!storyId && storyIdRaw.startsWith('job_')) {
            console.log('🔍 [STRIPE WEBHOOK] Searching for story with ID:', storyIdRaw);
            console.log('🔍 [STRIPE WEBHOOK] User ID:', userId);

            // The job_id IS the primary key in the stories table
            const result = await dbPool.query(
              'SELECT id, data FROM stories WHERE id = $1 AND user_id = $2',
              [storyIdRaw, userId]
            );

            if (result.rows.length > 0) {
              storyId = result.rows[0].id;
              storyData = result.rows[0].data;
              console.log('✅ [STRIPE WEBHOOK] Found story by ID:', storyIdRaw);
            } else {
              console.log('❌ [STRIPE WEBHOOK] Story not found in database with ID:', storyIdRaw);
            }
          }

          // If still not found, error out
          if (!storyId) {
            console.error('❌ [STRIPE WEBHOOK] Story not found for storyId:', storyIdRaw);
            console.error('❌ [STRIPE WEBHOOK] User ID:', userId);
            console.error('❌ [STRIPE WEBHOOK] This might be a job that hasn\'t completed or been saved yet');
            throw new Error(`Story not found: ${storyIdRaw}`);
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
            userId, storyId, fullSession.id, fullSession.payment_intent,
            customerInfo.name, customerInfo.email,
            fullSession.shipping?.name || customerInfo.name,
            address.line1, address.line2,
            address.city, address.state, address.postal_code, address.country,
            fullSession.amount_total, fullSession.currency, fullSession.payment_status
          ]);

          console.log('💾 [STRIPE WEBHOOK] Order saved to database');
          console.log('   User ID:', userId);
          console.log('   Story ID:', storyId);

          // Trigger background PDF generation and print provider order (don't await - fire and forget)
          processBookOrder(fullSession.id, userId, storyId, customerInfo, address).catch(async (err) => {
            console.error('❌ [BACKGROUND] Error processing book order:', err);
            console.error('   Error stack:', err.stack);
            console.error('   Session ID:', fullSession.id);
            console.error('   User ID:', userId);
            console.error('   Story ID:', storyId);
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
          email.sendOrderConfirmationEmail(
            customerInfo.email,
            customerInfo.name,
            {
              orderId: fullSession.id.slice(-8).toUpperCase(),
              amount: (fullSession.amount_total / 100).toFixed(2),
              currency: fullSession.currency.toUpperCase(),
              shippingAddress: address
            }
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

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Serve static files (HTML, CSS, JS, images)
app.use(express.static(__dirname));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Serve index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// File paths for simple file-based storage
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const LOGS_FILE = path.join(__dirname, 'data', 'logs.json');
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const CHARACTERS_FILE = path.join(__dirname, 'data', 'characters.json');
const STORIES_FILE = path.join(__dirname, 'data', 'stories.json');

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_session_id ON orders(stripe_session_id)`);

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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_jobs_user ON story_jobs(user_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_jobs_status ON story_jobs(status)`);

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

// Auth endpoints
app.post('/api/auth/register', async (req, res) => {
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

      const insertQuery = 'INSERT INTO users (id, username, email, password, role, story_quota, stories_generated) VALUES ($1, $2, $3, $4, $5, $6, $7)';
      await dbQuery(insertQuery, [userId, username, username, hashedPassword, role, storyQuota, 0]);

      newUser = {
        id: userId,
        username,
        email: username,
        role,
        storyQuota,
        storiesGenerated: 0
      };
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);

      // Check if user already exists
      if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'This email is already registered' });
      }

      newUser = {
        id: Date.now().toString(),
        username,
        email: username,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        role: users.length === 0 ? 'admin' : 'user',
        storyQuota: users.length === 0 ? -1 : 2,
        storiesGenerated: 0
      };

      users.push(newUser);
      await writeJSON(USERS_FILE, users);
    }

    await logActivity(newUser.id, username, 'USER_REGISTERED', { email });

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
        storiesGenerated: newUser.storiesGenerated
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
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
        storiesGenerated: dbUser.stories_generated
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

    // Generate token
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${user.username} (role: ${user.role})`);
    console.log(`⚠️  TEST LOG - If you see this, logs are working!`);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 2,
        storiesGenerated: user.storiesGenerated || 0
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Firebase Authentication (Google, Apple, etc.)
app.post('/api/auth/firebase', async (req, res) => {
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

        // Generate a random password (user won't need it - they use Firebase)
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        const insertQuery = `
          INSERT INTO users (username, email, password, role, story_quota, stories_generated)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, username, email, role, story_quota, stories_generated
        `;
        const result = await dbQuery(insertQuery, [username, firebaseEmail, hashedPassword, role, storyQuota, 0]);
        user = result[0];

        await logActivity(user.id, username, 'USER_REGISTERED_FIREBASE', { provider: decodedToken.firebase?.sign_in_provider });
        console.log(`✅ New Firebase user registered: ${username} (role: ${role})`);
      }

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
          storiesGenerated: user.stories_generated || 0
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

    console.log(`🔧 Dev auto-login: ${user.username} (role: ${user.role})`);

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

// API Key management (admin only)
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

    const { model, contents, safetySettings } = req.body;

    await logActivity(req.user.id, req.user.username, 'GEMINI_API_CALL', {
      model: model || 'gemini-2.5-flash-image'
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.5-flash-image'}:generateContent?key=${geminiApiKey}`;

    const requestBody = { contents };
    if (safetySettings) {
      requestBody.safetySettings = safetySettings;
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

// Admin endpoints
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
          u.id, u.username, u.email, u.role, u.story_quota, u.stories_generated, u.created_at,
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
        createdAt: user.created_at,
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

// Update user quota (admin only)
app.patch('/api/admin/users/:userId/quota', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { userId } = req.params;
    const { storyQuota } = req.body;

    if (storyQuota === undefined || (storyQuota !== -1 && storyQuota < 0)) {
      return res.status(400).json({ error: 'Invalid quota value. Use -1 for unlimited or a positive number.' });
    }

    let user;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT * FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [userId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updateQuery = 'UPDATE users SET story_quota = $1 WHERE id = $2';
      await dbQuery(updateQuery, [storyQuota, userId]);

      user = {
        id: rows[0].id,
        username: rows[0].username,
        storyQuota: storyQuota,
        storiesGenerated: rows[0].stories_generated
      };
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      user = users.find(u => u.id === userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.storyQuota = storyQuota;
      await writeJSON(USERS_FILE, users);
    }

    await logActivity(req.user.id, req.user.username, 'USER_QUOTA_UPDATED', {
      targetUserId: userId,
      targetUsername: user.username,
      newQuota: storyQuota
    });

    res.json({
      message: 'User quota updated successfully',
      user: {
        id: user.id,
        username: user.username,
        storyQuota: user.storyQuota,
        storiesGenerated: user.storiesGenerated || 0
      }
    });
  } catch (err) {
    console.error('Error updating user quota:', err);
    res.status(500).json({ error: 'Failed to update user quota' });
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

    console.log(`📚 [ADMIN] GET /api/admin/users/${targetUserId}/stories - Admin: ${req.user.username}`);
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

      console.log(`📚 [ADMIN] Found ${userStories.length} stories for user ${targetUsername} (ID: ${targetUserId})`);
      res.json({ userId: targetUserId, username: targetUsername, stories: userStories });
    } else {
      // File mode
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

      console.log(`📚 [ADMIN] File mode: Found ${userStories.length} stories for user ${targetUserId}`);
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

    console.log(`📖 [ADMIN] GET /api/admin/users/${targetUserId}/stories/${storyId} - Admin: ${req.user.username}`);

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

    console.log(`📖 [ADMIN] Returning story "${story.title}" for user ${targetUserId}`);
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

    const updateQuery = `UPDATE gelato_products
         SET product_uid = $1, product_name = $2, description = $3, size = $4,
             cover_type = $5, min_pages = $6, max_pages = $7,
             available_page_counts = $8, is_active = $9
         WHERE id = $10
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
      is_active !== false,
      id
    ];

    const result = await dbQuery(updateQuery, params);

    // PostgreSQL RETURNING clause returns the updated record
    if (result.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const updatedProduct = result[0];

    await logActivity(req.user.id, req.user.username, 'GELATO_PRODUCT_UPDATED', {
      productId: id,
      productName: product_name
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

// Get current user's quota status
app.get('/api/user/quota', authenticateToken, async (req, res) => {
  try {
    let quota, generated;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT story_quota, stories_generated FROM users WHERE id = $1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      quota = rows[0].story_quota !== undefined ? rows[0].story_quota : 2;
      generated = rows[0].stories_generated || 0;
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      const user = users.find(u => u.id === req.user.id);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      quota = user.storyQuota !== undefined ? user.storyQuota : 2;
      generated = user.storiesGenerated || 0;
    }

    const remaining = quota === -1 ? -1 : Math.max(0, quota - generated);

    res.json({
      quota: quota,
      used: generated,
      remaining: remaining,
      unlimited: quota === -1
    });
  } catch (err) {
    console.error('Error fetching user quota:', err);
    res.status(500).json({ error: 'Failed to fetch user quota' });
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

// Character management endpoints
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

// Story management endpoints
app.get('/api/stories', authenticateToken, async (req, res) => {
  try {
    console.log(`📚 GET /api/stories - User: ${req.user.username} (ID: ${req.user.id}), Mode: ${STORAGE_MODE}`);
    let userStories = [];

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = 'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC';

      console.log(`📚 Executing query: ${selectQuery} with user_id: ${req.user.id}`);
      const rows = await dbQuery(selectQuery, [req.user.id]);
      console.log(`📚 Query returned ${rows.length} rows`);

      // Parse the JSON data from each row - return ONLY metadata (NO images)
      userStories = rows.map(row => {
        const story = JSON.parse(row.data);
        // Return metadata only - no images at all to minimize response size
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
      console.log(`📚 Parsed ${userStories.length} stories (metadata only, NO images)`);

      if (userStories.length > 0) {
        console.log(`📚 First story: ${userStories[0].title} (ID: ${userStories[0].id})`);
      }
    } else {
      // File mode
      const allStories = await readJSON(STORIES_FILE);
      const fullStories = allStories[req.user.id] || [];
      // Return ONLY metadata (NO images) to minimize response size
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
      console.log(`📚 File mode: Found ${userStories.length} stories for user ${req.user.id} (metadata only, NO images)`);
    }

    console.log(`📚 Returning ${userStories.length} stories (total size: ${JSON.stringify(userStories).length} bytes)`);
    await logActivity(req.user.id, req.user.username, 'STORIES_LOADED', { count: userStories.length });
    res.json(userStories);
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

      // Check quota only for new stories
      if (isNewStory) {
        const userQuery = 'SELECT story_quota, stories_generated FROM users WHERE id = $1';
        const userRows = await dbQuery(userQuery, [req.user.id]);
        if (userRows.length > 0) {
          const quota = userRows[0].story_quota !== undefined ? userRows[0].story_quota : 2;
          const generated = userRows[0].stories_generated || 0;

          if (quota !== -1 && generated >= quota) {
            return res.status(403).json({
              error: 'Story quota exceeded',
              quota: quota,
              used: generated,
              remaining: 0
            });
          }

          // Increment story counter
          const updateQuery = 'UPDATE users SET stories_generated = stories_generated + 1 WHERE id = $1';
          await dbQuery(updateQuery, [req.user.id]);
        }
      }

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

      // Check quota only for new stories
      if (isNewStory) {
        const user = users.find(u => u.id === req.user.id);
        if (user) {
          const quota = user.storyQuota !== undefined ? user.storyQuota : 2;
          const generated = user.storiesGenerated || 0;

          if (quota !== -1 && generated >= quota) {
            return res.status(403).json({
              error: 'Story quota exceeded',
              quota: quota,
              used: generated,
              remaining: 0
            });
          }

          user.storiesGenerated = generated + 1;
          await writeJSON(USERS_FILE, users);
        }
      }

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
        console.log(`⚠️  Story ${id} not found for user ${req.user.id}`);
        return res.status(404).json({ error: 'Story not found or you do not have permission to delete it' });
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

// =============================================================================
// STORY REGENERATION ENDPOINTS - Regenerate individual components
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
    const storyData = story.story_data;

    // Find the page text
    const pageText = getPageText(storyData.storyText, pageNumber);
    if (!pageText) {
      return res.status(404).json({ error: `Page ${pageNumber} not found in story` });
    }

    // Get characters from story data
    const characters = storyData.characters || [];

    // Generate new scene description
    const scenePrompt = buildSceneDescriptionPrompt(pageNumber, pageText, characters, '');
    const newSceneDescription = await callClaudeAPI(scenePrompt, 2048);

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
      'UPDATE stories SET story_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
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
    const storyData = story.story_data;

    // Get scene description
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);

    if (!sceneDesc && !customPrompt) {
      return res.status(400).json({ error: 'No scene description found. Please provide customPrompt.' });
    }

    // Get character photos
    const characterPhotos = [];
    if (storyData.characters) {
      storyData.characters.forEach(char => {
        if (char.photoUrl) characterPhotos.push(char.photoUrl);
      });
    }

    // Build image prompt
    const imagePrompt = customPrompt || buildImagePrompt(sceneDesc.description, storyData);

    // Generate new image
    const imageResult = await callGeminiAPIForImage(imagePrompt, characterPhotos);

    // Update the image in story data
    let images = storyData.images || [];
    const existingIndex = images.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: sceneDesc?.description || customPrompt,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning || null
    };

    if (existingIndex >= 0) {
      images[existingIndex] = newImageData;
    } else {
      images.push(newImageData);
      images.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Update image prompts
    storyData.imagePrompts = storyData.imagePrompts || {};
    storyData.imagePrompts[pageNumber] = imagePrompt;

    // Save updated story
    storyData.images = images;
    await dbPool.query(
      'UPDATE stories SET story_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score})`);

    res.json({
      success: true,
      pageNumber,
      imageData: imageResult.imageData,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning
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

    if (!['front', 'initialPage', 'back'].includes(coverType)) {
      return res.status(400).json({ error: 'Invalid cover type. Must be: front, initialPage, or back' });
    }

    console.log(`🔄 Regenerating ${coverType} cover for story ${id}`);

    // Get the story
    const storyResult = await dbPool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = story.story_data;

    // Get character photos
    const characterPhotos = [];
    if (storyData.characters) {
      storyData.characters.forEach(char => {
        if (char.photoUrl) characterPhotos.push(char.photoUrl);
      });
    }

    // Get art style
    const artStyleId = storyData.artStyle || 'pixar';
    const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

    // Build character info
    let characterInfo = '';
    if (storyData.characters && storyData.characters.length > 0) {
      characterInfo = '\n\nThe cover MUST feature the following characters:\n';
      storyData.characters.forEach((char, idx) => {
        characterInfo += `Character ${idx + 1} (${char.name}): ${char.age} years old, ${char.gender}.\n`;
      });
    }

    // Build cover prompt
    let coverPrompt;
    if (customPrompt) {
      coverPrompt = customPrompt;
    } else {
      const storyTitle = storyData.title || 'My Story';
      const coverScenes = extractCoverScenes(storyData.outline || '');

      if (coverType === 'front') {
        const titlePageScene = coverScenes.titlePage || 'A beautiful, magical title page featuring the main characters.';
        coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
          TITLE_PAGE_SCENE: titlePageScene,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_INFO: characterInfo,
          STORY_TITLE: storyTitle
        });
      } else if (coverType === 'initialPage') {
        const initialPageScene = coverScenes.initialPage || 'A warm, inviting dedication/introduction page.';
        coverPrompt = storyData.dedication
          ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
              INITIAL_PAGE_SCENE: initialPageScene,
              STYLE_DESCRIPTION: styleDescription,
              CHARACTER_INFO: characterInfo,
              DEDICATION: storyData.dedication
            })
          : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
              INITIAL_PAGE_SCENE: initialPageScene,
              STYLE_DESCRIPTION: styleDescription,
              CHARACTER_INFO: characterInfo,
              STORY_TITLE: storyTitle
            });
      } else {
        const backCoverScene = coverScenes.backCover || 'A satisfying, conclusive ending scene.';
        coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
          BACK_COVER_SCENE: backCoverScene,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_INFO: characterInfo
        });
      }
    }

    // Generate new cover
    const coverResult = await callGeminiAPIForImage(coverPrompt, characterPhotos);

    // Update the cover in story data with new structure including quality
    storyData.coverImages = storyData.coverImages || {};
    const coverData = {
      imageData: coverResult.imageData,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning || null
    };

    if (coverType === 'front') {
      storyData.coverImages.frontCover = coverData;
    } else if (coverType === 'initialPage') {
      storyData.coverImages.initialPage = coverData;
    } else {
      storyData.coverImages.backCover = coverData;
    }

    // Save updated story
    await dbPool.query(
      'UPDATE stories SET story_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [JSON.stringify(storyData), id]
    );

    console.log(`✅ ${coverType} cover regenerated for story ${id} (score: ${coverResult.score})`);

    res.json({
      success: true,
      coverType,
      imageData: coverResult.imageData,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning
    });

  } catch (err) {
    console.error('Error regenerating cover:', err);
    res.status(500).json({ error: 'Failed to regenerate cover: ' + err.message });
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
    const storyData = story.story_data;

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
      'UPDATE stories SET story_data = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
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
    let { pdfUrl, shippingAddress, orderReference, productUid, pageCount } = req.body;

    if (!pdfUrl || !shippingAddress || !productUid || !pageCount) {
      return res.status(400).json({ error: 'Missing required fields: pdfUrl, shippingAddress, productUid, pageCount' });
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
    const orderType = process.env.GELATO_ORDER_TYPE || 'draft'; // 'draft' or 'order'

    if (!printApiKey || printApiKey === 'your_print_api_key_here') {
      return res.status(500).json({
        error: 'Print provider API not configured. Please add GELATO_API_KEY to .env file',
        setupUrl: 'https://dashboard.gelato.com/'
      });
    }

    // Prepare print provider order payload
    const orderPayload = {
      orderType: orderType, // 'draft' for preview only, 'order' for actual printing
      orderReferenceId: orderReference || `magical-story-${Date.now()}`,
      customerReferenceId: req.user.id,
      currency: 'USD',
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
        console.log(`🔍 Searching photobook catalog: ${catalogUid}`);
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
        console.log(`📦 ${catalogUid} response:`, {
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
          console.log(`⚠️  No products found in ${catalogUid}!`);
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

    // Default 14x14cm photobook product from your URL
    const defaultProduct = {
      product_uid: 'photobooks-softcover_pf_140x140-mm-5_5x5_5-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_250-gsm-100-lb-cover-coated-silk_ver',
      product_name: '14x14cm Softcover Photobook',
      description: 'Square softcover photobook with matt lamination, 170gsm coated silk paper',
      size: '14x14cm (5.5x5.5 inch)',
      cover_type: 'Softcover',
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

// Photo Analysis Endpoint (calls Python DeepFace service)
app.post('/api/analyze-photo', authenticateToken, async (req, res) => {
  try {
    const { imageData } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'Missing imageData' });
    }

    // Call Python photo analyzer service
    // Use 127.0.0.1 instead of localhost to avoid IPv6 issues
    const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';

    try {
      const analyzerResponse = await fetch(`${photoAnalyzerUrl}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ image: imageData }),
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      const analyzerData = await analyzerResponse.json();

      if (!analyzerResponse.ok || !analyzerData.success) {
        return res.status(500).json({
          error: 'Photo analysis failed',
          details: analyzerData.error || 'Unknown error'
        });
      }

      await logActivity(req.user.id, req.user.username, 'PHOTO_ANALYZED', {
        age: analyzerData.attributes?.age,
        gender: analyzerData.attributes?.gender
      });

      res.json(analyzerData);

    } catch (fetchErr) {
      console.error('Python photo analyzer service unavailable:', fetchErr.message);

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
        res.set('Content-Disposition', `inline; filename="${file.filename}"`);
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
        res.set('Content-Disposition', `inline; filename="${fileMetadata.filename}"`);
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

// Generate PDF from story
app.post('/api/generate-pdf', authenticateToken, async (req, res) => {
  try {
    const { storyId, storyTitle, storyPages, sceneImages, coverImages } = req.body;

    if (!storyPages || !Array.isArray(storyPages) || storyPages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyPages' });
    }

    const PDFDocument = require('pdfkit');
    const stream = require('stream');

    // Convert mm to points (1mm = 2.83465 points)
    const mmToPoints = (mm) => mm * 2.83465;

    // Page dimensions for 14x14cm photobook
    const coverWidth = mmToPoints(290.27);  // Cover spread width with bleed
    const coverHeight = mmToPoints(146.0);   // Cover height with bleed
    const pageSize = mmToPoints(140);        // Interior pages: 140x140mm

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

    // PDF Page 1: Back Cover + Front Cover (spread, 290.27 x 146.0 mm)
    doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (coverImages && coverImages.backCover && coverImages.frontCover) {
      // Add back cover on left half
      const backCoverData = coverImages.backCover.replace(/^data:image\/\w+;base64,/, '');
      const backCoverBuffer = Buffer.from(backCoverData, 'base64');
      doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });

      // Add front cover on right half
      const frontCoverData = coverImages.frontCover.replace(/^data:image\/\w+;base64,/, '');
      const frontCoverBuffer = Buffer.from(frontCoverData, 'base64');
      doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });

      // Add title text overlay on front cover (right half)
      if (storyTitle) {
        const titleX = coverWidth / 2 + 20;
        const titleY = 40;
        const titleWidth = (coverWidth / 2) - 40;

        doc.fontSize(24)
          .fillColor('white')
          .text(storyTitle, titleX, titleY, {
            width: titleWidth,
            align: 'center'
          });
      }
    }

    // PDF Page 2: Initial Page (140 x 140 mm)
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (coverImages && coverImages.initialPage) {
      const initialPageData = coverImages.initialPage.replace(/^data:image\/\w+;base64,/, '');
      const initialPageBuffer = Buffer.from(initialPageData, 'base64');
      doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
    }

    // Add content pages (140 x 140 mm square)
    storyPages.forEach((page, index) => {
      const pageNumber = index + 1;

      // Add text page (square format)
      const margin = 28;
      doc.addPage({ size: [pageSize, pageSize], margins: { top: margin, bottom: margin, left: margin, right: margin } });

      // Calculate available space
      const availableWidth = pageSize - (margin * 2);
      const availableHeight = pageSize - (margin * 2);

      // Start with smaller font size to ensure text fits
      let fontSize = 9;  // Reduced from 11 to 9
      let textHeight;
      let fontReduced = false;

      // Measure text height and reduce font if needed
      doc.fontSize(fontSize).font('Helvetica');
      textHeight = doc.heightOfString(page.text, {
        width: availableWidth,
        align: 'left'
      });

      // If text doesn't fit, reduce font size to minimum 5pt
      while (textHeight > availableHeight && fontSize > 5) {
        fontSize -= 0.5;
        doc.fontSize(fontSize);
        textHeight = doc.heightOfString(page.text, {
          width: availableWidth,
          align: 'left'
        });
        fontReduced = true;
      }

      // If text still doesn't fit even at 5pt, truncate it
      let textToRender = page.text;
      if (textHeight > availableHeight) {
        console.error(`⚠️  Page ${pageNumber}: Text too long even at ${fontSize}pt, truncating...`);
        // Truncate text to fit
        const words = page.text.split(' ');
        textToRender = '';
        for (let i = 0; i < words.length; i++) {
          const testText = textToRender + (textToRender ? ' ' : '') + words[i];
          const testHeight = doc.heightOfString(testText, {
            width: availableWidth,
            align: 'left'
          });
          if (testHeight <= availableHeight) {
            textToRender = testText;
          } else {
            break;
          }
        }
        textToRender += '...';
      }

      // Log warning if font was reduced
      if (fontReduced) {
        console.warn(`⚠️  Page ${pageNumber}: Text too long, reduced font to ${fontSize}pt`);
      }

      // Calculate vertical position to center text
      textHeight = doc.heightOfString(textToRender, {
        width: availableWidth,
        align: 'left'
      });
      const yPosition = margin + (availableHeight - textHeight) / 2;

      // Render text (left-aligned, vertically centered)
      doc.fillColor('#333333')  // Dark gray instead of pure black to reduce ink
         .text(textToRender, margin, yPosition, {
           width: availableWidth,
           align: 'left'
         });

      // Add image page if available (square format)
      const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
      if (sceneImage && sceneImage.imageData) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

        // Extract base64 data
        const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');

        // Add image to fill page with small margin
        try {
          const margin = mmToPoints(5);  // 5mm margin
          doc.image(imageBuffer, margin, margin, {
            fit: [pageSize - (margin * 2), pageSize - (margin * 2)],
            align: 'center',
            valign: 'center'
          });
        } catch (imgErr) {
          console.error('Error adding image to PDF:', imgErr);
          // Continue without image if there's an error
        }
      }
    });

    // Finalize PDF
    doc.end();

    // Wait for PDF generation to complete
    const pdfBuffer = await pdfPromise;
    const fileSize = pdfBuffer.length;
    const fileId = `file-pdf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const filename = `${storyTitle || 'story'}.pdf`;

    // Store PDF in database
    if (STORAGE_MODE === 'database' && dbPool) {
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

    console.log(`✅ [ADMIN] Found ${totalOrders} orders, ${failedOrders.length} with issues`);

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
    const printPageCount = storyScenes * 2;

    // Get print product UID
    const productsResult = await dbPool.query(
      'SELECT product_uid, product_name FROM gelato_products WHERE is_active = true'
    );

    let printProductUid = null;
    if (productsResult.rows.length > 0) {
      const sortedProducts = productsResult.rows.sort((a, b) => {
        const aMin = parseInt(a.product_uid.match(/\d+/)?.[0] || 0);
        const bMin = parseInt(b.product_uid.match(/\d+/)?.[0] || 0);
        return aMin - bMin;
      });
      printProductUid = sortedProducts[0].product_uid;
    }

    if (!printProductUid) {
      printProductUid = 'photobooks-softcover_pf_140x140-mm-5_5x5_5-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_250-gsm-100-lb-cover-coated-silk_ver';
    }

    const printApiKey = process.env.GELATO_API_KEY;
    if (!printApiKey) {
      return res.status(500).json({ error: 'GELATO_API_KEY not configured' });
    }

    const orderType = process.env.GELATO_ORDER_TYPE || 'order';

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

    console.log(`📦 [ADMIN] Retry print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, pdfUrl=${pdfUrl}`);

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
    const characterCountResult = await dbPool.query('SELECT COUNT(*) as count FROM characters');
    const fileCountResult = await dbPool.query('SELECT COUNT(*) as count FROM files');

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

    const stats = {
      users: {
        total: parseInt(userCountResult.rows[0].count)
      },
      stories: {
        total: parseInt(storyCountResult.rows[0].count),
        embeddedImagesCount: embeddedImagesCount,
        embeddedImagesSizeMB: (totalSceneImagesSize / 1024 / 1024).toFixed(2)
      },
      characters: {
        total: parseInt(characterCountResult.rows[0].count)
      },
      files: {
        total: parseInt(fileCountResult.rows[0].count),
        images: parseInt(imageFilesResult.rows[0].count),
        orphaned: orphanedFilesResult.rows.length,
        orphanedSizeMB: (parseInt(orphanedSizeResult.rows[0].total_size) / 1024 / 1024).toFixed(2)
      },
      orphanedFiles: orphanedFilesResult.rows.map(f => ({
        id: f.id,
        storyId: f.story_id,
        fileType: f.file_type,
        fileSizeKB: (f.file_size / 1024).toFixed(2),
        filename: f.filename,
        createdAt: f.created_at
      })),
      totalImages: embeddedImagesCount + parseInt(imageFilesResult.rows[0].count)
    };

    console.log(`✅ [ADMIN] Stats: ${stats.users.total} users, ${stats.stories.total} stories, ${stats.characters.total} characters, ${stats.totalImages} total images, ${stats.files.orphaned} orphaned files`);

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error fetching stats:', err);
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
      console.log(`✅ [ADMIN] Deleted ${deletedCount} orphaned files`);
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
      console.log(`✅ [ADMIN] Deleted orphaned file: ${fileId}`);
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
        console.warn(`⚠️  Could not get row count for table ${table.tablename}:`, err.message);
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
      console.log(`🗑️  [ADMIN] Deleting user ${user.username} (${user.email}) and all their data...`);

      // Delete in order due to foreign key constraints
      // 1. Delete story_jobs first
      const deletedJobs = await dbPool.query('DELETE FROM story_jobs WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedJobs.rows.length} story jobs`);

      // 2. Delete orders (if any)
      const deletedOrders = await dbPool.query('DELETE FROM orders WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedOrders.rows.length} orders`);

      // 3. Delete stories
      const deletedStories = await dbPool.query('DELETE FROM stories WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedStories.rows.length} stories`);

      // 4. Delete characters
      const deletedCharacters = await dbPool.query('DELETE FROM characters WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedCharacters.rows.length} characters`);

      // 5. Delete files
      const deletedFiles = await dbPool.query('DELETE FROM files WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedFiles.rows.length} files`);

      // 6. Delete activity logs (table may not exist)
      let deletedLogsCount = 0;
      try {
        const deletedLogs = await dbPool.query('DELETE FROM activity_log WHERE user_id = $1 RETURNING id', [userIdToDelete]);
        deletedLogsCount = deletedLogs.rows.length;
        console.log(`   Deleted ${deletedLogsCount} activity logs`);
      } catch (err) {
        console.log(`   Activity log table not found, skipping`);
      }

      // 7. Finally, delete the user
      await dbPool.query('DELETE FROM users WHERE id = $1', [userIdToDelete]);
      console.log(`   Deleted user account`);

      console.log(`✅ [ADMIN] Successfully deleted user ${user.username} and all associated data`);

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
      console.log(`🗑️  [ADMIN] Deleting user ${user.username} (${user.email}) from file storage...`);

      users.splice(userIndex, 1);
      await writeJSON(USERS_FILE, users);

      // Note: In file mode, we don't delete stories/files as they are not linked to users
      console.log(`✅ [ADMIN] Successfully deleted user ${user.username}`);

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

// Create Stripe checkout session for book purchase
app.post('/api/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    const { storyId } = req.body;
    const userId = req.user.id;

    console.log(`💳 Creating Stripe checkout session for user ${userId}, story ${storyId}`);

    // Get story details
    const story = await (STORAGE_MODE === 'database'
      ? dbPool.query('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [storyId, userId]).then(r => r.rows[0] ? JSON.parse(r.rows[0].data) : null)
      : JSON.parse(await fs.readFile(path.join(dataDir, 'stories.json'), 'utf8')).find(s => s.id === storyId));

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: `Personalized Storybook: ${story.title}`,
            description: `A personalized ${story.pages}-page storybook`,
          },
          unit_amount: 3600, // CHF 36.00 in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://www.magicalstory.ch'}?payment=cancelled`,
      metadata: {
        userId: userId.toString(),
        storyId: storyId.toString(),
        storyTitle: story.title
      },
      shipping_address_collection: {
        allowed_countries: ['DE', 'AT', 'CH', 'FR', 'IT', 'NL', 'BE', 'LU']
      },
    });

    console.log(`✅ Checkout session created: ${session.id}`);
    console.log(`   URL: ${session.url}`);

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error('❌ Error creating checkout session:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Check payment/order status (no auth required - session ID is already secure)
app.get('/api/stripe/order-status/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    console.log(`🔍 Checking order status for session: ${sessionId}`);

    // Check database for order
    if (STORAGE_MODE === 'database') {
      const order = await dbPool.query(
        'SELECT * FROM orders WHERE stripe_session_id = $1',
        [sessionId]
      );

      if (order.rows.length > 0) {
        console.log(`✅ Order found in database:`, order.rows[0]);
        return res.json({
          status: 'completed',
          order: order.rows[0]
        });
      }
    }

    // If not in database yet, check Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    console.log(`📋 Stripe session status: ${session.payment_status}`);

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
async function processBookOrder(sessionId, userId, storyId, customerInfo, shippingAddress) {
  console.log(`📚 [BACKGROUND] Starting book order processing for session ${sessionId}`);

  try {
    // Step 1: Update order status to "processing"
    await dbPool.query(`
      UPDATE orders
      SET payment_status = 'processing', updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $1
    `, [sessionId]);
    console.log('✅ [BACKGROUND] Order status updated to processing');

    // Step 2: Fetch story data from database
    const storyResult = await dbPool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
    if (storyResult.rows.length === 0) {
      throw new Error(`Story ${storyId} not found`);
    }

    let storyData = storyResult.rows[0].data;

    // Parse JSON if needed
    if (typeof storyData === 'string') {
      storyData = JSON.parse(storyData);
    }

    console.log('✅ [BACKGROUND] Story data fetched');
    console.log('📊 [BACKGROUND] Story data keys:', Object.keys(storyData));

    // Step 3: Generate PDF using PDFKit
    console.log('📄 [BACKGROUND] Generating PDF...');
    const PDFDocument = require('pdfkit');

    const mmToPoints = (mm) => mm * 2.83465;
    const coverWidth = mmToPoints(290.27);
    const coverHeight = mmToPoints(146.0);
    const pageSize = mmToPoints(140);

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

    // Add cover page
    doc.addPage({ size: [coverWidth, coverHeight], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (storyData.coverImages?.backCover && storyData.coverImages?.frontCover) {
      const backCoverBuffer = Buffer.from(storyData.coverImages.backCover.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      const frontCoverBuffer = Buffer.from(storyData.coverImages.frontCover.replace(/^data:image\/\w+;base64,/, ''), 'base64');

      doc.image(backCoverBuffer, 0, 0, { width: coverWidth / 2, height: coverHeight });
      doc.image(frontCoverBuffer, coverWidth / 2, 0, { width: coverWidth / 2, height: coverHeight });
    }

    // Add initial page (dedication/intro page)
    if (storyData.coverImages?.initialPage) {
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      const initialPageData = storyData.coverImages.initialPage.replace(/^data:image\/\w+;base64,/, '');
      const initialPageBuffer = Buffer.from(initialPageData, 'base64');
      doc.image(initialPageBuffer, 0, 0, { width: pageSize, height: pageSize });
    }

    // Add story pages (text + images alternating)
    // The generated story might be in different fields depending on how it was saved
    const generatedStoryText = storyData.generatedStory || storyData.story || storyData.text || '';
    if (!generatedStoryText) {
      throw new Error('Story text not found in story data. Available keys: ' + Object.keys(storyData).join(', '));
    }

    // Parse pages using the same pattern as frontend: ## Seite X or ## Page X
    const pageMatches = generatedStoryText.split(/##\s*(?:Seite|Page)\s+\d+/i);
    const storyPages = pageMatches.slice(1).filter(p => p.trim().length > 0);

    console.log(`📄 [BACKGROUND] Found ${storyPages.length} story pages to add to PDF`);

    storyPages.forEach((pageText, index) => {
      const pageNumber = index + 1;
      const image = storyData.sceneImages?.find(img => img.pageNumber === pageNumber);
      const cleanText = pageText.trim().replace(/^-+|-+$/g, '').trim();

      // Text page with proper font sizing
      const margin = 28;
      doc.addPage({ size: [pageSize, pageSize], margins: { top: margin, bottom: margin, left: margin, right: margin } });

      const availableWidth = pageSize - (margin * 2);
      const availableHeight = pageSize - (margin * 2);

      // Start with font size 9 and reduce if needed
      let fontSize = 9;
      doc.fontSize(fontSize).font('Helvetica').fillColor('#333');
      let textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left' });

      while (textHeight > availableHeight && fontSize > 5) {
        fontSize -= 0.5;
        doc.fontSize(fontSize);
        textHeight = doc.heightOfString(cleanText, { width: availableWidth, align: 'left' });
      }

      doc.text(cleanText, margin, margin, {
        width: availableWidth,
        height: availableHeight,
        align: 'left'
      });

      // Image page
      if (image && image.imageData) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imageBuffer, 0, 0, { width: pageSize, height: pageSize });
      }
    });

    doc.end();
    const pdfBuffer = await pdfPromise;
    const pdfBase64 = pdfBuffer.toString('base64');
    console.log(`✅ [BACKGROUND] PDF generated (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Step 3.5: Save PDF to database and get public URL
    console.log('💾 [BACKGROUND] Saving PDF to database...');
    const pdfFileId = `pdf-${storyId}-${Date.now()}`;
    const pdfInsertQuery = `
      INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET file_data = EXCLUDED.file_data
      RETURNING id
    `;
    await dbPool.query(pdfInsertQuery, [
      pdfFileId,
      userId,
      'story_pdf',
      storyId,
      'application/pdf',
      pdfBase64,
      pdfBuffer.length,
      `story-${storyId}.pdf`
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

    // Calculate page count: each scene = 2 print pages (1 text + 1 image)
    const storyScenes = storyData.pages || storyData.sceneImages?.length || 15;
    const printPageCount = storyScenes * 2;
    console.log(`📊 [BACKGROUND] Story scenes: ${storyScenes}, Print pages: ${printPageCount}`);

    // Fetch product UID from database based on page count (same logic as frontend)
    let printProductUid = null;
    try {
      const productsResult = await dbPool.query(
        'SELECT product_uid, product_name, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = true'
      );

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
          console.log(`✅ [BACKGROUND] Found matching product: ${matchingProduct.product_name}`);
        } else {
          console.warn(`⚠️ [BACKGROUND] No product matches page count ${printPageCount}`);
        }
      }
    } catch (err) {
      console.error('❌ [BACKGROUND] Error fetching products:', err.message);
    }

    // Fallback to environment variable or hardcoded default
    if (!printProductUid) {
      printProductUid = process.env.GELATO_PHOTOBOOK_UID || 'photobooks-softcover_pf_140x140-mm-5_5x5_5-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_250-gsm-100-lb-cover-coated-silk_ver';
      console.log(`⚠️ [BACKGROUND] Using fallback product UID: ${printProductUid}`);
    }

    const orderType = process.env.GELATO_ORDER_TYPE || 'order'; // 'draft' or 'order'

    // Use CHF currency for print orders
    const currency = 'CHF';

    const printOrderPayload = {
      orderType: orderType,
      orderReferenceId: `story-${storyId}-${Date.now()}`,
      customerReferenceId: userId,
      currency: currency,
      items: [{
        itemReferenceId: `item-${storyId}-${Date.now()}`,
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

    console.log(`📦 [BACKGROUND] Print order payload: productUid=${printProductUid}, pageCount=${printPageCount}, orderType=${orderType}`);

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
  steampunk: 'steampunk style, Victorian era, gears, brass, copper, goggles, mechanical details, vintage technology',
  comic: 'comic book style, bold ink lines, halftone dots, dynamic action, speech bubbles aesthetic, superhero comic art',
  manga: 'manga style, Japanese comic art, detailed linework, screentones, dramatic shading, expressive characters'
};

// Helper function to extract cover scene descriptions from outline
function extractCoverScenes(outline) {
  const coverScenes = {
    titlePage: '',
    initialPage: '',
    backCover: ''
  };

  const lines = outline.split('\n');
  let currentCoverType = null;
  let sceneBuffer = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Look for cover page patterns
    const titlePageMatch = line.match(/(?:\*\*)?Title\s+Page(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (titlePageMatch) {
      if (currentCoverType && sceneBuffer) {
        coverScenes[currentCoverType] = sceneBuffer.trim();
      }
      currentCoverType = 'titlePage';
      sceneBuffer = titlePageMatch[1].trim();
      continue;
    }

    // Match both "Initial Page" and legacy "Page 0" for backward compatibility
    const initialPageMatch = line.match(/(?:\*\*)?(?:Initial\s+Page|Page\s+0)(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (initialPageMatch) {
      if (currentCoverType && sceneBuffer) {
        coverScenes[currentCoverType] = sceneBuffer.trim();
      }
      currentCoverType = 'initialPage';
      sceneBuffer = initialPageMatch[1].trim();
      continue;
    }

    const backCoverMatch = line.match(/(?:\*\*)?Back\s+Cover(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (backCoverMatch) {
      if (currentCoverType && sceneBuffer) {
        coverScenes[currentCoverType] = sceneBuffer.trim();
      }
      currentCoverType = 'backCover';
      sceneBuffer = backCoverMatch[1].trim();
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
      if (currentCoverType && sceneBuffer) {
        coverScenes[currentCoverType] = sceneBuffer.trim();
      }
      currentCoverType = null;
      sceneBuffer = '';
    }
  }

  // Save last buffer
  if (currentCoverType && sceneBuffer) {
    coverScenes[currentCoverType] = sceneBuffer.trim();
  }

  return coverScenes;
}

// Helper function to build Art Director scene description prompt (matches frontend)
function buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc = '') {
  const characterDetails = characters.map(c => {
    const details = [];
    if (c.age) details.push(`Age ${c.age}`);
    if (c.gender) details.push(c.gender === 'male' ? 'Male' : c.gender === 'female' ? 'Female' : 'Non-binary');
    if (c.hairColor) details.push(c.hairColor);
    if (c.clothing) details.push(c.clothing);
    if (c.otherFeatures) details.push(c.otherFeatures);
    if (c.specialDetails) details.push(c.specialDetails);
    return `* **${c.name}:** ${details.join(', ')}`;
  }).join('\n');

  // Use template from file if available
  if (PROMPT_TEMPLATES.sceneDescriptions) {
    return fillTemplate(PROMPT_TEMPLATES.sceneDescriptions, {
      SCENE_SUMMARY: shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : '',
      PAGE_NUMBER: pageNumber.toString(),
      PAGE_CONTENT: pageContent,
      CHARACTERS: characterDetails
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
- Only include characters essential to this scene`;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for "Scene:" lines after "Page X:" lines
    const pageMatch = line.match(/^Page\s+(\d+):/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]);
      // Look for Scene: in the next few lines
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (lines[j].startsWith('Scene:')) {
          descriptions[pageNum] = lines[j].substring(6).trim();
          break;
        }
        // Stop if we hit another Page: marker
        if (lines[j].match(/^Page\s+\d+:/i)) break;
      }
    }
  }

  return descriptions;
}

// Process picture book (storybook) job - simplified flow with combined text+scene generation
async function processStorybookJob(jobId, inputData, characterPhotos, skipImages) {
  console.log(`📖 [STORYBOOK] Starting picture book generation for job ${jobId}`);

  // For Picture Book: pages = scenes (each page has image + text)
  // inputData.pages is the actual print page count
  const totalPages = inputData.pages;

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
    const middlePage = Math.ceil(totalPages / 2);
    const lang = inputData.language || 'en';

    // Build the storybook combined prompt
    const storybookPrompt = `You are an expert children's picture book author. Create a simple, heartwarming story with SHORT text and vivid scene descriptions for illustrations.

# Story Parameters

- **Title**: ${storyTypeName}
- **Target Age**: ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years (early readers)
- **Length**: ${totalPages} pages
- **Language**: ${lang === 'de' ? 'German (use "ss" instead of "ß", and use ä, ö, ü normally)' : lang === 'fr' ? 'French' : 'English'}
- **Story Type**: ${storyTypeName}
${inputData.storyDetails ? `- **Story Details**: ${inputData.storyDetails}` : ''}
${inputData.dedication ? `- **Dedication**: ${inputData.dedication}` : ''}
- **Characters**:
${characterDescriptions}
${relationshipDescriptions ? `- **Relationships**: \n${relationshipDescriptions}` : ''}

# CRITICAL TEXT LENGTH RULES

This is a PICTURE BOOK. Each page has a large illustration with only a SMALL amount of text.

**TEXT LIMITS PER PAGE:**
- Maximum 3-4 SHORT sentences per page
- Maximum 30-40 words total per page
- Use simple vocabulary for early readers
- Short, punchy sentences that complement the illustration

**GOOD EXAMPLE (Page text):**
"Leo loved to explore new places.
He jumped over rocks with happy faces.
His trusty brown backpack held all he needs!"

**BAD EXAMPLE (Too long):**
"Leo the Lion was a curious young cub who lived in a cozy cave at the edge of the Whispering Woods. Every morning, he would wake up with the sunrise..."

# Story Structure

Create a simple story arc:
1. **Beginning** (Pages 1-2): Introduce the main character and setting
2. **Middle** (Pages 3-${middlePage}): A small challenge or adventure
3. **End** (Pages ${middlePage + 1}-${totalPages}): Happy resolution with a gentle lesson

# Output Format

You MUST start with the TITLE PAGE, then provide ALL story pages. Use this exact format:

---TITLE PAGE---
TITLE: [Creative story title]
${inputData.dedication ? 'DEDICATION: [Dedication text]' : ''}

SCENE:
Setting: [Cover scene that sets the mood for the story]
Characters: [Main character(s) featured on cover]
Action: [An inviting cover moment]
Mood: [Welcoming, magical, exciting, etc.]

---PAGE 1---
TEXT:
[Short story text - 3-4 sentences max, 30-40 words]

SCENE:
Setting: [Location, time of day, atmosphere]
Characters: [Who is in this scene]
Action: [What is happening - the key visual moment]
Mood: [Emotional tone]

---PAGE 2---
TEXT:
[Short story text]

SCENE:
Setting: [Description]
Characters: [Who is present]
Action: [Key visual moment]
Mood: [Emotional tone]

... continue for all ${totalPages} pages ...

# Important

- You MUST include the TITLE PAGE first, followed by PAGE 1, PAGE 2, etc.
- Write the COMPLETE story for ALL ${totalPages} pages
- Keep text SHORT - this is a picture book!
- Scene descriptions should be detailed enough for an illustrator
- The story should feel complete with a satisfying ending
- Write entirely in ${lang === 'de' ? 'German' : lang === 'fr' ? 'French' : 'English'}`;

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Generating picture book story and scenes...', jobId]
    );

    // Generate the combined text + scenes in one call
    console.log(`📖 [STORYBOOK] Calling Claude API for combined generation...`);
    const response = await callClaudeAPI(storybookPrompt, 16000);

    // Save checkpoint
    await saveCheckpoint(jobId, 'storybook_combined', { response, rawResponse: response });

    // Extract title
    let storyTitle = inputData.title || 'My Picture Book';
    const titleMatch = response.match(/TITLE:\s*(.+)/i);
    if (titleMatch) {
      storyTitle = titleMatch[1].trim();
    }
    console.log(`📖 [STORYBOOK] Extracted title: ${storyTitle}`);

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

    let fullStoryText = '';
    const allSceneDescriptions = [];
    const allImages = [];
    const imagePrompts = {};

    // Also check for TITLE PAGE section
    let titlePageScene = null;
    const titlePageMatch = response.match(/---TITLE PAGE---\s*([\s\S]*?)(?=---PAGE\s+\d+---|$)/i);
    if (titlePageMatch) {
      const titlePageBlock = titlePageMatch[1];
      const sceneMatch = titlePageBlock.match(/SCENE:\s*([\s\S]*?)$/i);
      if (sceneMatch) {
        titlePageScene = {
          pageNumber: 0,
          description: sceneMatch[1].trim()
        };
        allSceneDescriptions.push(titlePageScene);
      }
    }

    console.log(`📖 [STORYBOOK] Found ${pageMatches.length} page markers`);

    // Extract content for each page using the markers
    for (let i = 0; i < pageMatches.length && i < totalPages; i++) {
      const match = pageMatches[i];
      const pageNum = parseInt(match[1], 10); // Use the actual page number from the marker
      const startIndex = match.index + match[0].length;
      const endIndex = pageMatches[i + 1] ? pageMatches[i + 1].index : response.length;
      const block = response.substring(startIndex, endIndex);

      // Extract TEXT section
      const textMatch = block.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
      const pageText = textMatch ? textMatch[1].trim() : '';

      // Extract SCENE section
      const sceneMatch = block.match(/SCENE:\s*([\s\S]*?)$/i);
      const sceneDesc = sceneMatch ? sceneMatch[1].trim() : '';

      // Build story text with page markers
      fullStoryText += `--- Page ${pageNum} ---\n${pageText}\n\n`;

      // Build scene description
      allSceneDescriptions.push({
        pageNumber: pageNum,
        description: sceneDesc
      });

      console.log(`📖 [STORYBOOK] Page ${pageNum}: ${pageText.substring(0, 50)}...`);
    }

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [30, 'Story text complete. Generating images...', jobId]
    );

    // Generate images if not skipped
    if (!skipImages) {
      const limit = pLimit(5);
      const MAX_RETRIES = 2;

      const imagePromises = allSceneDescriptions.map((scene, idx) => {
        return limit(async () => {
          const pageNum = scene.pageNumber;
          try {
            console.log(`📸 [STORYBOOK] Generating image for page ${pageNum}...`);

            // Build image prompt
            const imagePrompt = buildImagePrompt(scene.description, inputData);
            imagePrompts[pageNum] = imagePrompt;

            let imageResult = null;
            let retries = 0;

            while (retries <= MAX_RETRIES && !imageResult) {
              try {
                imageResult = await callGeminiAPIForImage(imagePrompt, characterPhotos);
              } catch (error) {
                retries++;
                console.error(`❌ [STORYBOOK] Page ${pageNum} image attempt ${retries} failed:`, error.message);
                if (retries > MAX_RETRIES) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
              }
            }

            console.log(`✅ [STORYBOOK] Page ${pageNum} image generated (score: ${imageResult.score})`);

            // Update progress
            const progressPercent = 30 + Math.floor((idx + 1) / totalPages * 50);
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [progressPercent, `Generated image ${idx + 1}/${totalPages}...`, jobId]
            );

            return {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: scene.description,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null
            };
          } catch (error) {
            console.error(`❌ [STORYBOOK] Failed to generate image for page ${pageNum}:`, error.message);
            return {
              pageNumber: pageNum,
              imageData: null,
              description: scene.description,
              error: error.message
            };
          }
        });
      });

      const imageResults = await Promise.all(imagePromises);
      imageResults.forEach(img => {
        if (img) allImages.push(img);
      });

      // Sort images by page number
      allImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [85, 'Generating cover images...', jobId]
    );

    // Generate cover images (simplified for picture book)
    let coverImages = { frontCover: null, initialPage: null, backCover: null };

    if (!skipImages) {
      try {
        const artStyleId = inputData.artStyle || 'pixar';
        const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;
        const characterInfo = (inputData.characters || []).map(c => `${c.name} (${c.age} years old)`).join(', ');

        // Front cover
        const frontCoverPrompt = `Create a cheerful children's book cover illustration for "${storyTitle}". Feature the main character(s): ${characterInfo}. Style: ${styleDescription}. Make it colorful and inviting.`;
        const frontCoverResult = await callGeminiAPIForImage(frontCoverPrompt, characterPhotos);
        coverImages.frontCover = { imageData: frontCoverResult.imageData, qualityScore: frontCoverResult.score };

        // Initial page
        const initialPrompt = inputData.dedication
          ? `Create a warm, welcoming illustration for a children's book dedication page. Include the text: "${inputData.dedication}". Style: ${styleDescription}.`
          : `Create a warm, welcoming introduction page illustration for "${storyTitle}". Style: ${styleDescription}. No text.`;
        const initialResult = await callGeminiAPIForImage(initialPrompt, characterPhotos);
        coverImages.initialPage = { imageData: initialResult.imageData, qualityScore: initialResult.score };

        // Back cover
        const backCoverPrompt = `Create a satisfying conclusion illustration for "${storyTitle}". Show a happy ending scene. Style: ${styleDescription}. Include "magicalstory.ch" text in corner.`;
        const backCoverResult = await callGeminiAPIForImage(backCoverPrompt, characterPhotos);
        coverImages.backCover = { imageData: backCoverResult.imageData, qualityScore: backCoverResult.score };

        console.log(`✅ [STORYBOOK] Cover images generated`);
      } catch (error) {
        console.error(`❌ [STORYBOOK] Cover generation failed:`, error.message);
      }
    }

    // Prepare result data
    const resultData = {
      title: storyTitle,
      storyText: fullStoryText,
      outline: '', // No outline for picture book mode
      sceneDescriptions: allSceneDescriptions,
      images: allImages,
      coverImages: coverImages,
      imagePrompts: imagePrompts,
      storyType: inputData.storyType,
      storyDetails: inputData.storyDetails,
      pages: totalPages,
      language: lang,
      languageLevel: '1st-grade',
      characters: inputData.characters,
      dedication: dedication,
      artStyle: inputData.artStyle,
      // Developer mode: raw AI response for debugging
      rawAIResponse: response
    };

    // Mark job as completed
    await dbPool.query(
      `UPDATE story_jobs SET
        status = 'completed',
        progress = 100,
        progress_message = 'Picture book complete!',
        result_data = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [JSON.stringify(resultData), jobId]
    );

    console.log(`✅ [STORYBOOK] Job ${jobId} completed successfully`);
    return resultData;

  } catch (error) {
    console.error(`❌ [STORYBOOK] Job ${jobId} failed:`, error);

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

    // Check if this is a picture book (1st-grade) - use simplified combined flow
    const isPictureBook = inputData.languageLevel === '1st-grade';

    // Calculate total scenes/pages to generate:
    // - Picture Book: pages = scenes (each page has image + text on same page)
    // - Standard: pages = print pages, so scenes = pages / 2 (text page + image page per scene)
    const totalPages = isPictureBook ? inputData.pages : Math.floor(inputData.pages / 2);
    console.log(`📚 [PIPELINE] Input pages: ${inputData.pages}, Mode: ${isPictureBook ? 'Picture Book' : 'Standard'}, Scenes to generate: ${totalPages}`);

    if (skipImages) {
      console.log(`📝 [PIPELINE] Text-only mode enabled - skipping image generation`);
    }

    // Extract character photos for reference images
    const characterPhotos = [];
    if (inputData.characters && inputData.characters.length > 0) {
      inputData.characters.forEach(char => {
        if (char.photoUrl) {
          characterPhotos.push(char.photoUrl);
        }
      });
      console.log(`📸 [PIPELINE] Found ${characterPhotos.length} character photos for reference`);
    }

    // Update status to processing
    await dbPool.query(
      'UPDATE story_jobs SET status = $1, progress = $2, progress_message = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      ['processing', 5, 'Starting story generation...', jobId]
    );

    if (isPictureBook) {
      console.log(`📚 [PIPELINE] Picture Book mode - using combined text+scene generation`);
      return await processStorybookJob(jobId, inputData, characterPhotos, skipImages);
    }

    // Standard flow for normal stories
    await dbPool.query(
      'UPDATE story_jobs SET progress_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Step 1: Generating story outline...', jobId]
    );

    // Step 1: Generate story outline (using Claude API)
    const outlinePrompt = buildStoryPrompt(inputData);
    const outline = await callClaudeAPI(outlinePrompt, 8192);

    // Save checkpoint: outline
    await saveCheckpoint(jobId, 'outline', { outline });

    // Extract short scene descriptions from outline for better image generation
    const shortSceneDescriptions = extractShortSceneDescriptions(outline);
    console.log(`📋 [PIPELINE] Extracted ${Object.keys(shortSceneDescriptions).length} short scene descriptions from outline`);

    // Save checkpoint: scene hints
    await saveCheckpoint(jobId, 'scene_hints', { shortSceneDescriptions });

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Step 2: Writing story and generating images...', jobId]
    );

    // STREAMING PIPELINE: Generate story in batches, immediately generate images as pages complete
    // Use STORY_BATCH_SIZE env var: 0 = generate all at once, >0 = batch size
    const BATCH_SIZE = STORY_BATCH_SIZE > 0 ? STORY_BATCH_SIZE : totalPages; // 0 means all pages at once
    const numBatches = Math.ceil(totalPages / BATCH_SIZE);
    console.log(`📚 [PIPELINE] Using batch size: ${BATCH_SIZE === totalPages ? 'ALL AT ONCE' : BATCH_SIZE + ' pages per batch'}`);

    let fullStoryText = '';
    const allImages = [];
    const allSceneDescriptions = [];
    const imagePrompts = {};

    // Create rate limiter for parallel image generation: max 5 concurrent
    const limit = pLimit(5);
    const MAX_RETRIES = 2;

    // Track active image generation promises
    let activeImagePromises = [];

    console.log(`📚 [STREAMING] Starting streaming pipeline: ${totalPages} pages in ${numBatches} batches of ${BATCH_SIZE}`);

    for (let batchNum = 0; batchNum < numBatches; batchNum++) {
      const startPage = batchNum * BATCH_SIZE + 1;
      const endPage = Math.min((batchNum + 1) * BATCH_SIZE, totalPages);

      console.log(`📖 [BATCH ${batchNum + 1}/${numBatches}] Generating pages ${startPage}-${endPage}`);

      // Generate story text for this batch
      const basePrompt = buildBasePrompt(inputData);
      const batchPrompt = PROMPT_TEMPLATES.storyTextBatch
        ? fillTemplate(PROMPT_TEMPLATES.storyTextBatch, {
            BASE_PROMPT: basePrompt,
            OUTLINE: outline,
            PAGES: totalPages,
            START_PAGE: startPage,
            END_PAGE: endPage,
            INCLUDE_TITLE: batchNum === 0 ? 'Include the title and dedication at the beginning.' : 'Start directly with the page content (no title/dedication).'
          })
        : `${basePrompt}

Here is the story outline:
${outline}

IMPORTANT: Now write pages ${startPage} through ${endPage} of the story following the outline above.
${batchNum === 0 ? 'Include the title and dedication at the beginning.' : 'Start directly with the page content (no title/dedication).'}

You **MUST** write exactly pages ${startPage} through ${endPage}.
Ensure there is **exactly one "--- Page X ---" marker per page**.

Output Format:
--- Page ${startPage} ---
[Story text...]

...continue until page ${endPage}...`;

      const batchText = await callClaudeAPI(batchPrompt, 16000);
      fullStoryText += batchText + '\n\n';

      console.log(`✅ [BATCH ${batchNum + 1}/${numBatches}] Story batch complete (${batchText.length} chars)`);

      // Save checkpoint: story batch
      await saveCheckpoint(jobId, 'story_batch', { batchNum, batchText, startPage, endPage }, batchNum);

      // Parse the pages from this batch
      const batchPages = parseStoryPages(batchText);
      console.log(`📄 [BATCH ${batchNum + 1}/${numBatches}] Parsed ${batchPages.length} pages`);

      // IMMEDIATELY start generating scene descriptions and images for these pages (unless skipImages)
      if (!skipImages) {
        for (const page of batchPages) {
          const pageNum = page.pageNumber;
          const pageContent = page.content;
          const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

          // Generate scene description using Art Director prompt
          const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc);

          // Start scene description + image generation (don't await yet)
          const imagePromise = limit(async () => {
            try {
              console.log(`🎨 [PAGE ${pageNum}] Generating scene description...`);

              // Generate detailed scene description (2048 tokens to avoid MAX_TOKENS cutoff)
              const sceneDescription = await callClaudeAPI(scenePrompt, 2048);

              allSceneDescriptions.push({
                pageNumber: pageNum,
                description: sceneDescription
              });

              console.log(`📸 [PAGE ${pageNum}] Generating image...`);

              // Generate image from scene description
              const imagePrompt = buildImagePrompt(sceneDescription, inputData);
              imagePrompts[pageNum] = imagePrompt;

              let imageResult = null;
              let retries = 0;

              while (retries <= MAX_RETRIES && !imageResult) {
                try {
                  imageResult = await callGeminiAPIForImage(imagePrompt, characterPhotos);
                } catch (error) {
                  retries++;
                  console.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
                  if (retries > MAX_RETRIES) {
                    throw error;
                  }
                  await new Promise(resolve => setTimeout(resolve, 1000 * retries));
                }
              }

              console.log(`✅ [PAGE ${pageNum}] Image generated successfully (score: ${imageResult.score})`);

              const imageData = {
                pageNumber: pageNum,
                imageData: imageResult.imageData,
                description: sceneDescription,
                qualityScore: imageResult.score,
                qualityReasoning: imageResult.reasoning || null
              };

              // Save checkpoint: page image (scene description + image)
              await saveCheckpoint(jobId, 'page_image', {
                pageNumber: pageNum,
                sceneDescription,
                imagePrompt: imagePrompt,
                qualityScore: imageResult.score,
                qualityReasoning: imageResult.reasoning || null
              }, pageNum);

              return imageData;
            } catch (error) {
              console.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
              throw error;
            }
          });

          activeImagePromises.push(imagePromise);
        }
      }

      // Update progress after each batch
      const storyProgress = 10 + Math.floor((batchNum + 1) / numBatches * 30); // 10-40%
      const completedImageCount = allImages.length;
      const progressMsg = `Writing story (${endPage}/${totalPages} pages), generating images (${completedImageCount}/${totalPages})...`;

      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [storyProgress, progressMsg, jobId]
      );
    }

    // Wait for images only if not skipping
    if (!skipImages) {
      console.log(`📚 [STREAMING] All story batches submitted. Waiting for ${activeImagePromises.length} images to complete...`);

      // Wait for all images to complete
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [50, `Generating images (0/${totalPages} complete)...`, jobId]
      );

      let completedCount = 0;
      const imageResults = await Promise.all(
        activeImagePromises.map(async (promise) => {
          const result = await promise;
          completedCount++;

          // Update progress
          const imageProgress = 50 + Math.floor(completedCount / totalPages * 40); // 50-90%
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [imageProgress, `Generating images (${completedCount}/${totalPages} complete)...`, jobId]
          );

          allImages.push(result);
          return result;
        })
      );

      // Sort images by page number
      allImages.sort((a, b) => a.pageNumber - b.pageNumber);
      allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

      console.log(`🚀 [STREAMING] All ${allImages.length} images generated!`);
    } else {
      console.log(`📝 [STREAMING] Text-only mode - skipping image wait`);
    }

    // Extract title from generated story text (AI-generated title, not user input)
    let storyTitle = inputData.title || 'My Story';
    if (fullStoryText) {
      const titleMatch = fullStoryText.match(/^#\s+(.+?)$/m);
      if (titleMatch) {
        storyTitle = titleMatch[1].trim();
        console.log(`📖 [PIPELINE] Extracted AI-generated title from storyText: "${storyTitle}"`);
      }
    }

    let coverImages = null;

    // Step 5: Generate cover images (unless skipImages)
    if (!skipImages) {
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [95, 'Generating cover images...', jobId]
      );

      console.log(`📕 [PIPELINE] Generating cover images for job ${jobId}`);

      // Get art style description
      const artStyleId = inputData.artStyle || 'pixar';
      const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

      // Build character info (matches step-by-step format)
      let characterInfo = '';
      if (inputData.characters && inputData.characters.length > 0) {
        characterInfo = '\n\nThe cover MUST feature the following characters:\n';
        inputData.characters.forEach((char, idx) => {
          characterInfo += `Character ${idx + 1} (${char.name}): ${char.age} years old, ${char.gender}.\n`;
        });
      }

      // Extract cover scene descriptions from outline (matches step-by-step)
      const coverScenes = extractCoverScenes(outline);
      const titlePageScene = coverScenes.titlePage || `A beautiful, magical title page featuring the main characters. Decorative elements that reflect the story's theme with space for the title text.`;
      const initialPageScene = coverScenes.initialPage || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
      const backCoverScene = coverScenes.backCover || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

      let frontCoverResult, initialPageResult, backCoverResult;

      // Generate front cover (matches step-by-step prompt format)
      try {
        console.log(`📕 [PIPELINE] Generating front cover for job ${jobId}`);
        const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
          TITLE_PAGE_SCENE: titlePageScene,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_INFO: characterInfo,
          STORY_TITLE: storyTitle
        });
        frontCoverResult = await callGeminiAPIForImage(frontCoverPrompt, characterPhotos);
        console.log(`✅ [PIPELINE] Front cover generated successfully`);
        // Save checkpoint: front cover
        await saveCheckpoint(jobId, 'cover', { type: 'front', prompt: frontCoverPrompt }, 0);
      } catch (error) {
        console.error(`❌ [PIPELINE] Failed to generate front cover for job ${jobId}:`, error);
        throw new Error(`Front cover generation failed: ${error.message}`);
      }

      // Generate initial page (dedication page) - matches step-by-step prompt format
      try {
        console.log(`📕 [PIPELINE] Generating initial page (dedication) for job ${jobId}`);
        const initialPagePrompt = inputData.dedication && inputData.dedication.trim()
          ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
              INITIAL_PAGE_SCENE: initialPageScene,
              STYLE_DESCRIPTION: styleDescription,
              CHARACTER_INFO: characterInfo,
              DEDICATION: inputData.dedication
            })
          : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
              INITIAL_PAGE_SCENE: initialPageScene,
              STYLE_DESCRIPTION: styleDescription,
              CHARACTER_INFO: characterInfo,
              STORY_TITLE: storyTitle
            });
        initialPageResult = await callGeminiAPIForImage(initialPagePrompt, characterPhotos);
        console.log(`✅ [PIPELINE] Initial page generated successfully`);
        // Save checkpoint: initial page cover
        await saveCheckpoint(jobId, 'cover', { type: 'initialPage', prompt: initialPagePrompt }, 1);
      } catch (error) {
        console.error(`❌ [PIPELINE] Failed to generate initial page for job ${jobId}:`, error);
        throw new Error(`Initial page generation failed: ${error.message}`);
      }

      // Generate back cover (matches step-by-step prompt format)
      try {
        console.log(`📕 [PIPELINE] Generating back cover for job ${jobId}`);
        const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
          BACK_COVER_SCENE: backCoverScene,
          STYLE_DESCRIPTION: styleDescription,
          CHARACTER_INFO: characterInfo
        });
        backCoverResult = await callGeminiAPIForImage(backCoverPrompt, characterPhotos);
        console.log(`✅ [PIPELINE] Back cover generated successfully`);
        // Save checkpoint: back cover
        await saveCheckpoint(jobId, 'cover', { type: 'back', prompt: backCoverPrompt }, 2);
      } catch (error) {
        console.error(`❌ [PIPELINE] Failed to generate back cover for job ${jobId}:`, error);
        throw new Error(`Back cover generation failed: ${error.message}`);
      }

      coverImages = {
        frontCover: {
          imageData: frontCoverResult.imageData,
          qualityScore: frontCoverResult.score,
          qualityReasoning: frontCoverResult.reasoning || null
        },
        initialPage: {
          imageData: initialPageResult.imageData,
          qualityScore: initialPageResult.score,
          qualityReasoning: initialPageResult.reasoning || null
        },
        backCover: {
          imageData: backCoverResult.imageData,
          qualityScore: backCoverResult.score,
          qualityReasoning: backCoverResult.reasoning || null
        }
      };

      console.log(`📊 [PIPELINE] Cover quality scores - Front: ${frontCoverResult.score}, Initial: ${initialPageResult.score}, Back: ${backCoverResult.score}`);
    } else {
      console.log(`📝 [PIPELINE] Text-only mode - skipping cover image generation`);
    }

    // Job complete - save result
    const resultData = {
      outline,
      storyText: fullStoryText,
      sceneDescriptions: allSceneDescriptions,
      images: allImages,
      coverImages,
      imagePrompts,
      title: storyTitle,
      textOnly: skipImages // Mark if this was text-only generation
    };

    log.debug('📖 [SERVER] resultData keys:', Object.keys(resultData));
    log.debug('📖 [SERVER] storyText exists?', !!resultData.storyText);
    log.debug('📖 [SERVER] storyText length:', resultData.storyText?.length || 0);
    log.verbose('📖 [SERVER] storyText preview:', resultData.storyText?.substring(0, 200));

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      ['completed', 100, 'Story generation complete!', JSON.stringify(resultData), jobId]
    );

    console.log(`✅ Job ${jobId} completed successfully`);

    // Send story completion email to customer
    try {
      const userResult = await dbPool.query('SELECT email, username FROM users WHERE id = $1', [job.user_id]);
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];
        const storyTitle = inputData.storyTitle || inputData.title || 'Your Story';
        await email.sendStoryCompleteEmail(user.email, user.username, storyTitle);
      }
    } catch (emailErr) {
      console.error('❌ Failed to send story complete email:', emailErr);
    }

  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error);

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
        const userResult = await dbPool.query('SELECT email, username FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length > 0) {
          const user = userResult.rows[0];
          // Notify admin
          await email.sendAdminStoryFailureAlert(jobId, userId, user.username, user.email || 'N/A', error.message);
          // Notify customer
          if (user.email) {
            await email.sendStoryFailedEmail(user.email, user.username);
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
function buildBasePrompt(inputData) {
  const mainCharacterIds = inputData.mainCharacters || [];

  // For story text generation, we use BASIC character info (no strengths/weaknesses)
  // Strengths/weaknesses are only used in outline generation to avoid repetitive trait mentions
  const characterSummary = (inputData.characters || []).map(char => {
    const isMain = mainCharacterIds.includes(char.id);
    return {
      name: char.name,
      isMainCharacter: isMain,
      gender: char.gender,
      age: char.age,
      specialDetails: char.specialDetails  // Includes hobbies, hopes, fears, favorite animals
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

  // Map language level to reading instructions with page length guidance
  const languageLevelDescriptions = {
    '1st-grade': {
      description: 'Simple words and very short sentences for early readers',
      pageLength: '2-4 sentences per page (approximately 30-50 words)'
    },
    'standard': {
      description: 'Age-appropriate vocabulary for elementary school children',
      pageLength: 'About 10 sentences per page (approximately 80-120 words)'
    },
    'advanced': {
      description: 'More complex vocabulary and varied sentence structure for advanced readers',
      pageLength: '15-20 sentences per page (approximately 150-250 words)'
    }
  };
  const levelInfo = languageLevelDescriptions[inputData.languageLevel] || languageLevelDescriptions['standard'];
  const readingLevel = `${levelInfo.description}. ${levelInfo.pageLength}`;

  // Add German language note if applicable
  const language = inputData.language || 'en';
  const languageNote = language === 'de' || language === 'German'
    ? ' (NOTE: Always use "ss" instead of "ß" - e.g., "Strasse" not "Straße", "gross" not "groß")'
    : '';

  return `# Story Parameters

- **Title**: ${inputData.title || 'Untitled'}
- **Length**: ${inputData.pages || 15} pages
- **Language**: ${language}${languageNote}
- **Reading Level**: ${readingLevel}
- **Story Type**: ${inputData.storyType || 'adventure'}
- **Story Details**: ${inputData.storyDetails || 'None'}
- **Characters**: ${JSON.stringify(characterSummary, null, 2)}${relationshipDescriptions}`;
}

function buildStoryPrompt(inputData) {
  // Build the story generation prompt based on input data
  // Extract only essential character info (NO PHOTOS to avoid token limit)
  const characterSummary = (inputData.characters || []).map(char => ({
    name: char.name,
    gender: char.gender,
    age: char.age,
    personality: char.personality,
    strengths: char.strengths,
    weaknesses: char.weaknesses,
    fears: char.fears,
    specialDetails: char.specialDetails
    // Explicitly exclude photoUrl and other large fields
  }));

  // Use template if available, otherwise fall back to hardcoded prompt
  if (PROMPT_TEMPLATES.outline) {
    return fillTemplate(PROMPT_TEMPLATES.outline, {
      TITLE: inputData.title || 'Untitled',
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: inputData.pages || 15,
      LANGUAGE: inputData.language || 'en',
      CHARACTERS: JSON.stringify(characterSummary),
      STORY_TYPE: inputData.storyType || 'adventure',
      STORY_DETAILS: inputData.storyDetails || 'None',
      DEDICATION: inputData.dedication || 'None'
    });
  }

  // Fallback to hardcoded prompt
  return `Create a children's story with the following parameters:
    Title: ${inputData.title || 'Untitled'}
    Age: ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years
    Length: ${inputData.pages || 15} pages
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

  console.log(`📋 [PARSE] Found ${scenes.length} valid scenes (expected ${expectedCount})`);

  // Log each scene for debugging
  scenes.forEach((scene, i) => {
    const preview = scene.substring(0, 80) + (scene.length > 80 ? '...' : '');
    console.log(`📋 [PARSE] Scene ${i + 1}: ${preview}`);
  });

  // If we have more scenes than expected, take only the first expectedCount
  if (scenes.length > expectedCount) {
    console.warn(`⚠️  [PARSE] Got ${scenes.length} scenes but expected ${expectedCount}, trimming excess`);
    return scenes.slice(0, expectedCount);
  }

  // If we have fewer scenes than expected, warn but continue
  if (scenes.length < expectedCount) {
    console.warn(`⚠️  [PARSE] Got only ${scenes.length} scenes but expected ${expectedCount}`);
  }

  return scenes;
}

function buildImagePrompt(sceneDescription, inputData) {
  // Build image generation prompt (matches step-by-step format)
  const artStyleId = inputData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

  // Build character info for consistency
  let characterPrompts = '';
  if (inputData.characters && inputData.characters.length > 0) {
    characterPrompts = '\n\nCHARACTER APPEARANCE GUIDE - Maintain consistency:\n\n';
    inputData.characters.forEach((char, idx) => {
      characterPrompts += `[${char.name}]: ${char.age} years old, ${char.gender}.\n`;
    });
    characterPrompts += '\nCRITICAL: These characters must maintain visual consistency across ALL pages.';
  }

  // Use template if available, otherwise fall back to hardcoded prompt
  if (PROMPT_TEMPLATES.imageGeneration) {
    return fillTemplate(PROMPT_TEMPLATES.imageGeneration, {
      STYLE_DESCRIPTION: styleDescription,
      SCENE_DESCRIPTION: sceneDescription,
      CHARACTER_PROMPTS: characterPrompts,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8
    });
  }

  // Fallback to hardcoded prompt
  return `Create a cinematic scene in ${styleDescription}.

Scene Description: ${sceneDescription}${characterPrompts}

Important:
- Show only the emotions visible on faces (happy, sad, surprised, worried, excited)
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
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
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

  return data.candidates[0].content.parts[0].text;
}

// Backward compatibility alias
async function callClaudeAPI(prompt, maxTokens = 4096) {
  return callTextModel(prompt, maxTokens);
}

/**
 * Generate cache key for image generation
 * Creates a hash from prompt + character photo hashes
 */
function generateImageCacheKey(prompt, characterPhotos = []) {
  // Hash each photo and sort them for consistency
  const photoHashes = characterPhotos
    .filter(p => p && p.startsWith('data:image'))
    .map(photoUrl => {
      const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
      return crypto.createHash('sha256').update(base64Data).digest('hex').substring(0, 16);
    })
    .sort()
    .join('|');

  // Combine prompt + photo hashes
  const combined = `${prompt}|${photoHashes}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
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
 * @returns {Promise<number>} Quality score from 0-100
 */
async function evaluateImageQuality(imageData, originalPrompt = '', referenceImages = []) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      log.verbose('⚠️  [QUALITY] Claude API key not configured, skipping quality evaluation');
      return null;
    }

    // Extract base64 and mime type for generated image
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Use prompt template if available, with placeholder replacement
    const evaluationPrompt = PROMPT_TEMPLATES.imageEvaluation
      ? fillTemplate(PROMPT_TEMPLATES.imageEvaluation, { ORIGINAL_PROMPT: originalPrompt })
      : 'Evaluate this AI-generated children\'s storybook illustration on a scale of 0-100. Consider: visual appeal, clarity, artistic quality, age-appropriateness, and technical quality. Respond with ONLY a number between 0-100, nothing else.';

    // Build content array with generated image first, then reference images
    const content = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: base64Data
        }
      }
    ];

    // Add reference images if provided
    if (referenceImages && referenceImages.length > 0) {
      referenceImages.forEach(refImg => {
        if (refImg && refImg.startsWith('data:image')) {
          const refBase64 = refImg.replace(/^data:image\/\w+;base64,/, '');
          const refMimeType = refImg.match(/^data:(image\/\w+);base64,/) ?
            refImg.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: refMimeType,
              data: refBase64
            }
          });
        }
      });
      log.verbose(`⭐ [QUALITY] Added ${referenceImages.length} reference images for evaluation`);
    }

    // Add evaluation prompt text
    content.push({
      type: 'text',
      text: evaluationPrompt
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: content
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      log.error('❌ [QUALITY] Claude API error:', error);
      return null;
    }

    const data = await response.json();
    const responseText = data.content[0].text.trim();

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
    const reasoningMatch = responseText.match(/Reasoning:\s*([\s\S]*)/i);
    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

    log.verbose(`⭐ [QUALITY] Image quality score: ${score}/100`);
    if (reasoning) {
      log.verbose(`⭐ [QUALITY] Reasoning: ${reasoning.substring(0, 150)}...`);
    }

    // Return both score and reasoning
    return { score, reasoning };
  } catch (error) {
    log.error('❌ [QUALITY] Error evaluating image quality:', error);
    return null;
  }
}

async function callGeminiAPIForImage(prompt, characterPhotos = []) {
  // Check cache first
  const cacheKey = generateImageCacheKey(prompt, characterPhotos);

  if (imageCache.has(cacheKey)) {
    log.verbose('💾 [IMAGE CACHE] Cache HIT - reusing previously generated image');
    log.debug('💾 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');
    log.debug('💾 [IMAGE CACHE] Cache size:', imageCache.size, 'images');
    return imageCache.get(cacheKey);
  }

  log.verbose('🆕 [IMAGE CACHE] Cache MISS - generating new image');
  log.debug('🆕 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');

  // Call Gemini API for image generation with optional character reference images
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured');
  }

  // Build parts array with prompt + character reference images
  const parts = [{ text: prompt }];

  // Add character photos as reference images
  if (characterPhotos && characterPhotos.length > 0) {
    characterPhotos.forEach(photoUrl => {
      if (photoUrl && photoUrl.startsWith('data:image')) {
        const base64Data = photoUrl.replace(/^data:image\/\w+;base64,/, '');
        const mimeType = photoUrl.match(/^data:(image\/\w+);base64,/) ?
          photoUrl.match(/^data:(image\/\w+);base64,/)[1] : 'image/png';

        parts.push({
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        });
      }
    });
    console.log(`🖼️  [IMAGE GEN] Added ${characterPhotos.length} character reference images`);
  }

  const requestBody = {
    contents: [{
      parts: parts
    }]
  };

  console.log('🖼️  [IMAGE GEN] Calling Gemini API with prompt:', prompt.substring(0, 100) + '...');
  console.log('🖼️  [IMAGE GEN] Model: gemini-2.5-flash-image');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`,
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
      if (part.inlineData && part.inlineData.data) {
        const imageDataSize = part.inlineData.data.length;
        const imageSizeKB = (imageDataSize / 1024).toFixed(2);
        console.log(`✅ [IMAGE GEN] Successfully extracted image data (${imageSizeKB} KB base64)`);
        const pngImageData = `data:image/png;base64,${part.inlineData.data}`;

        // Compress PNG to JPEG
        console.log('🗜️  [COMPRESSION] Compressing image to JPEG...');
        const compressedImageData = await compressImageToJPEG(pngImageData);

        // Evaluate image quality with prompt and reference images
        console.log('⭐ [QUALITY] Evaluating image quality...');
        const qualityResult = await evaluateImageQuality(compressedImageData, prompt, characterPhotos);

        // Extract score and reasoning from quality result
        const score = qualityResult ? qualityResult.score : null;
        const reasoning = qualityResult ? qualityResult.reasoning : null;

        // Store in cache
        const result = { imageData: compressedImageData, score, reasoning };
        imageCache.set(cacheKey, result);
        log.verbose('💾 [IMAGE CACHE] Stored in cache. Total cached:', imageCache.size, 'images');

        return result;
      }
    }
  } else {
    console.error('❌ [IMAGE GEN] Unexpected candidate structure. Keys:', Object.keys(candidate));
  }

  console.error('❌ [IMAGE GEN] No image data found in any part');
  throw new Error('No image data in response - check logs for API response structure');
}

// Create a new story generation job
app.post('/api/jobs/create-story', authenticateToken, async (req, res) => {
  try {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userId = req.user.id;
    const inputData = req.body;

    console.log(`📝 Creating story job ${jobId} for user ${req.user.username}`);

    if (STORAGE_MODE === 'database') {
      await dbPool.query(
        `INSERT INTO story_jobs (id, user_id, status, input_data, progress, progress_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [jobId, userId, 'pending', JSON.stringify(inputData), 0, 'Job created, waiting to start...']
      );
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
      res.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progress_message,
        resultData: job.result_data,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        completedAt: job.completed_at
      });
    } else {
      return res.status(503).json({ error: 'Background jobs require database mode' });
    }
  } catch (err) {
    console.error('Error fetching job status:', err);
    res.status(500).json({ error: 'Failed to fetch job status' });
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

initialize().then(() => {
  app.listen(PORT, () => {
    console.log(`\n=================================`);
    console.log(`🚀 MagicalStory Server Running`);
    console.log(`=================================`);
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
    console.log(`=================================\n`);
  });
}).catch(err => {
  console.error('Failed to initialize server:', err);
  process.exit(1);
});
