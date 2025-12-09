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
console.log(`📚 Story batch size: ${STORY_BATCH_SIZE === 0 ? 'DISABLED (generate all at once)' : STORY_BATCH_SIZE + ' pages per batch'}`);

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

          // Trigger background PDF generation and Gelato order (don't await - fire and forget)
          processBookOrder(fullSession.id, userId, storyId, customerInfo, address).catch(err => {
            console.error('❌ [BACKGROUND] Error processing book order:', err);
            console.error('   Error stack:', err.stack);
            console.error('   Session ID:', fullSession.id);
            console.error('   User ID:', userId);
            console.error('   Story ID:', storyId);
            console.error('   CRITICAL: Customer paid but book order failed! Check database for stripe_session_id:', fullSession.id);
          });

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
      // Database mode - order by created_at to maintain consistent order
      const selectQuery = 'SELECT id, username, email, role, story_quota, stories_generated, created_at FROM users ORDER BY created_at ASC';
      const rows = await dbQuery(selectQuery, []);
      safeUsers = rows.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        storyQuota: user.story_quota,
        storiesGenerated: user.stories_generated,
        createdAt: user.created_at
      }));
    } else {
      // File mode
      const users = await readJSON(USERS_FILE);
      safeUsers = users.map(({ password, ...user }) => ({
        ...user,
        storyQuota: user.storyQuota !== undefined ? user.storyQuota : 2,
        storiesGenerated: user.storiesGenerated || 0
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

// =======================
// Gelato Products Admin Endpoints
// =======================

// Get all Gelato products (admin only)
app.get('/api/admin/gelato-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for Gelato products management' });
    }

    const selectQuery = 'SELECT * FROM gelato_products ORDER BY created_at DESC';
    const products = await dbQuery(selectQuery, []);

    res.json({ products });
  } catch (err) {
    console.error('Error fetching Gelato products:', err);
    res.status(500).json({ error: 'Failed to fetch Gelato products' });
  }
});

// Create new Gelato product (admin only)
app.post('/api/admin/gelato-products', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for Gelato products management' });
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
    console.error('Error creating Gelato product:', err);
    res.status(500).json({ error: 'Failed to create Gelato product' });
  }
});

// Update Gelato product (admin only)
app.put('/api/admin/gelato-products/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for Gelato products management' });
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
    console.error('Error updating Gelato product:', err);
    res.status(500).json({ error: 'Failed to update Gelato product' });
  }
});

// Toggle product active status (admin only)
app.put('/api/admin/gelato-products/:id/toggle', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for Gelato products management' });
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
    console.error('Error toggling Gelato product status:', err);
    res.status(500).json({ error: 'Failed to toggle product status' });
  }
});

// Delete Gelato product (admin only)
app.delete('/api/admin/gelato-products/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (STORAGE_MODE !== 'database' || !dbPool) {
      return res.status(503).json({ error: 'Database required for Gelato products management' });
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
    console.error('Error deleting Gelato product:', err);
    res.status(500).json({ error: 'Failed to delete Gelato product' });
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

// Gelato Print API - Create photobook order
app.post('/api/gelato/order', authenticateToken, async (req, res) => {
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

    const gelatoApiKey = process.env.GELATO_API_KEY;
    const orderType = process.env.GELATO_ORDER_TYPE || 'draft'; // 'draft' or 'order'

    if (!gelatoApiKey || gelatoApiKey === 'your_gelato_api_key_here') {
      return res.status(500).json({
        error: 'Gelato API not configured. Please add GELATO_API_KEY to .env file',
        setupUrl: 'https://dashboard.gelato.com/'
      });
    }

    // Prepare Gelato order payload
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

    // Call Gelato API
    const gelatoResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': gelatoApiKey
      },
      body: JSON.stringify(orderPayload)
    });

    const gelatoData = await gelatoResponse.json();

    if (!gelatoResponse.ok) {
      console.error('Gelato API error:', gelatoData);
      return res.status(gelatoResponse.status).json({
        error: 'Gelato order failed',
        details: gelatoData
      });
    }

    await logActivity(req.user.id, req.user.username, 'GELATO_ORDER_CREATED', {
      orderId: gelatoData.orderId || gelatoData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType
    });

    // Extract preview URLs if available
    const previewUrls = [];
    if (gelatoData.items && Array.isArray(gelatoData.items)) {
      gelatoData.items.forEach(item => {
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
      orderId: gelatoData.orderId || gelatoData.id,
      orderReference: orderPayload.orderReferenceId,
      orderType: orderType,
      isDraft: orderType === 'draft',
      previewUrls: previewUrls,
      dashboardUrl: `https://dashboard.gelato.com/checkout/${gelatoData.orderId || gelatoData.id}/product`,
      data: gelatoData
    });

  } catch (err) {
    console.error('Error creating Gelato order:', err);
    res.status(500).json({ error: 'Failed to create print order', details: err.message });
  }
});

// Gelato Product Management (Admin Only)

// Fetch products from Gelato API
app.get('/api/admin/gelato/fetch-products', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const gelatoApiKey = process.env.GELATO_API_KEY;
    if (!gelatoApiKey || gelatoApiKey === 'your_gelato_api_key_here') {
      return res.status(500).json({ error: 'Gelato API not configured' });
    }

    // Step 1: Fetch all available catalogs from Gelato
    const catalogsResponse = await fetch('https://product.gelatoapis.com/v3/catalogs', {
      headers: {
        'X-API-KEY': gelatoApiKey
      }
    });

    if (!catalogsResponse.ok) {
      const errorData = await catalogsResponse.json();
      return res.status(catalogsResponse.status).json({ error: 'Failed to fetch catalogs from Gelato', details: errorData });
    }

    const catalogsData = await catalogsResponse.json();
    console.log('📁 Gelato catalogs RAW response:', JSON.stringify(catalogsData).substring(0, 500));

    // Try different possible response structures
    const catalogs = catalogsData.catalogs || catalogsData.data || catalogsData.results || catalogsData || [];
    const catalogArray = Array.isArray(catalogs) ? catalogs : (catalogs.items || []);

    console.log('📁 Gelato catalogs:', {
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
            'X-API-KEY': gelatoApiKey
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
    console.error('Error fetching Gelato products:', err);
    res.status(500).json({ error: 'Failed to fetch products', details: err.message });
  }
});

// Get all saved Gelato products from database
app.get('/api/admin/gelato/products', authenticateToken, async (req, res) => {
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
      const productsFile = path.join(__dirname, 'data', 'gelato_products.json');

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

// Save/Update Gelato product
app.post('/api/admin/gelato/products', authenticateToken, async (req, res) => {
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
      const productsFile = path.join(__dirname, 'data', 'gelato_products.json');

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
app.post('/api/admin/gelato/seed-products', authenticateToken, async (req, res) => {
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
// Get default Gelato product UID from environment
app.get('/api/config/gelato-product-uid', authenticateToken, (req, res) => {
  const productUid = process.env.GELATO_PHOTOBOOK_UID;

  if (!productUid) {
    return res.status(500).json({
      error: 'Gelato product UID not configured',
      message: 'Please set GELATO_PHOTOBOOK_UID in environment variables'
    });
  }

  res.json({ productUid });
});

app.get('/api/gelato/products', async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = 'SELECT product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = true ORDER BY product_name';

      const rows = await dbQuery(selectQuery, []);
      res.json({ success: true, products: rows });
    } else {
      // File mode
      const fs = require('fs').promises;
      const path = require('path');
      const productsFile = path.join(__dirname, 'data', 'gelato_products.json');

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
      res.send(file.file_data);

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

    // PDF Page 2: Page 0 (140 x 140 mm)
    doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });

    if (coverImages && coverImages.page0) {
      const page0Data = coverImages.page0.replace(/^data:image\/\w+;base64,/, '');
      const page0Buffer = Buffer.from(page0Data, 'base64');
      doc.image(page0Buffer, 0, 0, { width: pageSize, height: pageSize });
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

      // 6. Delete activity logs
      const deletedLogs = await dbPool.query('DELETE FROM activity_log WHERE user_id = $1 RETURNING id', [userIdToDelete]);
      console.log(`   Deleted ${deletedLogs.rows.length} activity logs`);

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
          activityLogs: deletedLogs.rows.length
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

    // Add story pages (text + images alternating)
    // The generated story might be in different fields depending on how it was saved
    const generatedStoryText = storyData.generatedStory || storyData.story || storyData.text || '';
    if (!generatedStoryText) {
      throw new Error('Story text not found in story data. Available keys: ' + Object.keys(storyData).join(', '));
    }
    const storyPages = generatedStoryText.split(/---\s*Page\s+\d+\s*---/i).slice(1).filter(p => p.trim());

    storyPages.forEach((pageText, index) => {
      const pageNumber = index + 1;
      const image = storyData.sceneImages.find(img => img.pageNumber === pageNumber);

      // Text page
      doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      doc.fontSize(14).fillColor('#333').text(pageText.trim(), mmToPoints(20), mmToPoints(20), {
        width: mmToPoints(100),
        height: mmToPoints(100),
        align: 'center',
        valign: 'center'
      });

      // Image page
      if (image && image.imageData) {
        doc.addPage({ size: [pageSize, pageSize], margins: { top: 0, bottom: 0, left: 0, right: 0 } });
        const imageBuffer = Buffer.from(image.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(imageBuffer, mmToPoints(10), mmToPoints(10), {
          width: mmToPoints(120),
          height: mmToPoints(120),
          fit: [mmToPoints(120), mmToPoints(120)],
          align: 'center',
          valign: 'center'
        });
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

    // Step 4: Create Gelato order
    console.log('📦 [BACKGROUND] Creating Gelato order...');

    const gelatoApiKey = process.env.GELATO_API_KEY;
    if (!gelatoApiKey) {
      throw new Error('GELATO_API_KEY not configured');
    }

    const gelatoProductUid = storyData.gelatoProductUid || 'product_photobooks_hardcover_140x140_32';
    const orderType = process.env.GELATO_ORDER_TYPE || 'order'; // 'draft' or 'order'

    // Use CHF currency for Gelato orders
    const currency = 'CHF';

    // Calculate page count from story data
    const pageCount = storyData.pages || 32;

    const gelatoOrderPayload = {
      orderType: orderType,
      orderReferenceId: `story-${storyId}-${Date.now()}`,
      customerReferenceId: userId,
      currency: currency,
      items: [{
        itemReferenceId: `item-${storyId}-${Date.now()}`,
        productUid: gelatoProductUid,
        pageCount: parseInt(pageCount),
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

    const gelatoResponse = await fetch('https://order.gelatoapis.com/v4/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': gelatoApiKey
      },
      body: JSON.stringify(gelatoOrderPayload)
    });

    if (!gelatoResponse.ok) {
      const errorText = await gelatoResponse.text();
      throw new Error(`Gelato API error: ${gelatoResponse.status} - ${errorText}`);
    }

    const gelatoOrder = await gelatoResponse.json();
    console.log('✅ [BACKGROUND] Gelato order created:', gelatoOrder.orderId);

    // Step 5: Update order with Gelato order ID and status
    await dbPool.query(`
      UPDATE orders
      SET gelato_order_id = $1,
          gelato_status = 'submitted',
          payment_status = 'completed',
          updated_at = CURRENT_TIMESTAMP
      WHERE stripe_session_id = $2
    `, [gelatoOrder.orderId, sessionId]);

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
    page0: '',
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

    const page0Match = line.match(/(?:\*\*)?Page\s+0(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (page0Match) {
      if (currentCoverType && sceneBuffer) {
        coverScenes[currentCoverType] = sceneBuffer.trim();
      }
      currentCoverType = 'page0';
      sceneBuffer = page0Match[1].trim();
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

// Background worker function to process a story generation job
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

    // Update status to processing
    await dbPool.query(
      'UPDATE story_jobs SET status = $1, progress = $2, progress_message = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
      ['processing', 10, 'Step 1/4: Generating story outline...', jobId]
    );

    // Step 1: Generate story outline (using Claude API)
    const outlinePrompt = buildStoryPrompt(inputData);
    const outline = await callClaudeAPI(outlinePrompt, 8192);  // Increased to match frontend

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [30, 'Step 2/4: Writing full story...', jobId]
    );

    // Step 2: Generate full story text (using Claude API)
    // Check if batch processing is needed
    const totalPages = inputData.pages;
    const useBatching = STORY_BATCH_SIZE > 0 && STORY_BATCH_SIZE < totalPages;

    let storyText = '';

    if (useBatching) {
      // BATCH MODE: Generate story in batches to stay under rate limits
      console.log(`📚 [BATCH MODE] Generating ${totalPages} pages in batches of ${STORY_BATCH_SIZE}`);
      const numBatches = Math.ceil(totalPages / STORY_BATCH_SIZE);

      for (let batchNum = 0; batchNum < numBatches; batchNum++) {
        const startPage = batchNum * STORY_BATCH_SIZE + 1;
        const endPage = Math.min((batchNum + 1) * STORY_BATCH_SIZE, totalPages);
        const pagesInBatch = endPage - startPage + 1;

        console.log(`📖 [BATCH ${batchNum + 1}/${numBatches}] Generating pages ${startPage}-${endPage} (${pagesInBatch} pages)`);

        const batchPrompt = `Based on this outline:\n\n${outline}\n\nNow write the complete story text with full narrative details, descriptions, and dialogue for PAGES ${startPage} through ${endPage} ONLY.

CRITICAL: You MUST preserve ALL page markers exactly as they appear in the outline:
- Keep all "## Seite X" or "## Page X" headers for pages ${startPage}-${endPage}
- Keep all "---" separators between pages
- ${batchNum === 0 ? 'Include the title and dedication at the beginning' : 'Start directly with the page content (no title/dedication)'}
- Write ONLY pages ${startPage} through ${endPage}

Write the full story content for each page in this range, but maintain the exact page structure from the outline.`;

        const batchText = await callClaudeAPI(batchPrompt, 16000);  // Smaller output per batch
        storyText += batchText + '\n\n';

        // Update progress
        const batchProgress = 30 + Math.floor((batchNum + 1) / numBatches * 20);
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [batchProgress, `Step 2/4: Writing story (batch ${batchNum + 1}/${numBatches})...`, jobId]
        );

        console.log(`✅ [BATCH ${batchNum + 1}/${numBatches}] Completed (${batchText.length} chars)`);
      }

      console.log(`✅ [BATCH MODE] All ${numBatches} batches complete. Total story length: ${storyText.length} chars`);
    } else {
      // SINGLE-SHOT MODE: Generate entire story in one API call
      console.log(`📚 [SINGLE-SHOT MODE] Generating all ${totalPages} pages in one call`);
      const storyPrompt = `Based on this outline:\n\n${outline}\n\nNow write the complete story text with full narrative details, descriptions, and dialogue.

CRITICAL: You MUST preserve ALL page markers exactly as they appear in the outline:
- Keep all "## Seite X" or "## Page X" headers
- Keep all "---" separators between pages
- The structure must remain: Title, dedication, then each page with its marker

Write the full story content for each page, but maintain the exact page structure from the outline.`;
      storyText = await callClaudeAPI(storyPrompt, 64000);  // Claude Sonnet 4.5's 64K output limit
      console.log(`✅ [SINGLE-SHOT MODE] Story generated (${storyText.length} chars)`);
    }

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [50, 'Step 3/4: Generating scene descriptions...', jobId]
    );

    // Step 3: Generate scene descriptions (using Claude API)
    const sceneDescriptionsPrompt = `From this story, create EXACTLY ${inputData.pages} scene descriptions for the ${inputData.pages} pages of the story.

Format: Provide ONLY the scene descriptions, one per line, separated by double newlines. Do NOT include:
- Page numbers
- Introductory text
- Explanations
- Separators like "---"
- Any other formatting

Each scene description should be a single paragraph describing what should be illustrated for that page.

Story:
${storyText}`;
    const sceneDescriptions = await callClaudeAPI(sceneDescriptionsPrompt, 4096);

    console.log(`📋 [PIPELINE] Raw scene descriptions length: ${sceneDescriptions.length} characters`);

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [70, 'Step 4/4: Generating illustrations (this may take several minutes)...', jobId]
    );

    // Step 4: Generate images (using Gemini API)
    const sceneArray = parseSceneDescriptions(sceneDescriptions, inputData.pages);
    const images = [];
    const imagePrompts = {}; // Store prompts for developer features

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

    console.log(`📸 [PIPELINE] Parsed ${sceneArray.length} scenes (expected ${inputData.pages})`);
    console.log(`📸 [PIPELINE] Generating ${sceneArray.length} scene images IN PARALLEL for job ${jobId}`);

    // Create rate limiter: max 5 concurrent image generations
    const limit = pLimit(5);
    const MAX_RETRIES = 2;

    // Helper function to generate a single image with retry logic
    const generateImageWithRetry = async (sceneDescription, sceneIndex) => {
      let imageResult = null;
      let retries = 0;

      while (retries <= MAX_RETRIES && !imageResult) {
        try {
          if (retries > 0) {
            console.log(`🔄 [PIPELINE] Retrying image ${sceneIndex + 1}/${sceneArray.length} (attempt ${retries + 1}/${MAX_RETRIES + 1}) for job ${jobId}`);
          } else {
            console.log(`📸 [PIPELINE] Generating image ${sceneIndex + 1}/${sceneArray.length} for job ${jobId}`);
          }

          const imagePrompt = buildImagePrompt(sceneDescription, inputData);
          imagePrompts[sceneIndex + 1] = imagePrompt; // Save prompt for this page
          imageResult = await callGeminiAPIForImage(imagePrompt, characterPhotos);
          console.log(`✅ [PIPELINE] Image ${sceneIndex + 1}/${sceneArray.length} generated successfully`);
        } catch (error) {
          retries++;
          console.error(`❌ [PIPELINE] Failed to generate image ${sceneIndex + 1}/${sceneArray.length} (attempt ${retries}/${MAX_RETRIES + 1}):`, error.message);

          if (retries > MAX_RETRIES) {
            throw new Error(`Image generation failed for scene ${sceneIndex + 1} after ${MAX_RETRIES + 1} attempts: ${error.message}`);
          }

          // Wait a bit before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
      }

      return {
        pageNumber: sceneIndex + 1,
        imageData: imageResult.imageData,
        description: sceneDescription,
        qualityScore: imageResult.score,
        qualityReasoning: null
      };
    };

    // Generate all images in parallel with rate limiting
    const imageGenerationPromises = sceneArray.map((scene, index) =>
      limit(() => generateImageWithRetry(scene, index))
    );

    // Track progress as images complete
    let completedImages = 0;
    const imageResults = await Promise.all(
      imageGenerationPromises.map(async (promise) => {
        const result = await promise;
        completedImages++;

        // Update progress in database
        const imageProgress = 70 + Math.floor(completedImages / sceneArray.length * 25);
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [imageProgress, jobId]
        );

        return result;
      })
    );

    // Store images in order by page number
    images.push(...imageResults.sort((a, b) => a.pageNumber - b.pageNumber));

    console.log(`🚀 [PIPELINE] All ${sceneArray.length} images generated in parallel!`);

    // Build sceneDescriptions array in proper format (matches step-by-step structure)
    const sceneDescriptionsArray = sceneArray.map((desc, i) => ({
      pageNumber: i + 1,
      description: desc
    }));

    // Step 5: Generate cover images
    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [95, 'Generating cover images...', jobId]
    );

    console.log(`📕 [PIPELINE] Generating cover images for job ${jobId}`);

    // Get art style description
    const artStyleId = inputData.artStyle || 'pixar';
    const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

    // Extract title from generated story text (AI-generated title, not user input)
    let storyTitle = inputData.title || 'My Story';
    if (storyText) {
      const titleMatch = storyText.match(/^#\s+(.+?)$/m);
      if (titleMatch) {
        storyTitle = titleMatch[1].trim();
        console.log(`📖 [PIPELINE] Extracted AI-generated title from storyText: "${storyTitle}"`);
      }
    }

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
    const page0Scene = coverScenes.page0 || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
    const backCoverScene = coverScenes.backCover || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

    let frontCoverResult, page0Result, backCoverResult;

    // Generate front cover (matches step-by-step prompt format)
    try {
      console.log(`📕 [PIPELINE] Generating front cover for job ${jobId}`);
      const frontCoverPrompt = `${titlePageScene}\n\nStyle: ${styleDescription}.${characterInfo}\n\nCreate this as a beautiful title page illustration for the children's book "${storyTitle}".\n\nIMPORTANT: The image should include the story title "${storyTitle}" integrated beautifully into the illustration. Make the title prominent and visually appealing as part of the cover art.`;
      frontCoverResult = await callGeminiAPIForImage(frontCoverPrompt, characterPhotos);
      console.log(`✅ [PIPELINE] Front cover generated successfully`);
    } catch (error) {
      console.error(`❌ [PIPELINE] Failed to generate front cover for job ${jobId}:`, error);
      throw new Error(`Front cover generation failed: ${error.message}`);
    }

    // Generate page 0 (dedication page) - matches step-by-step prompt format
    try {
      console.log(`📕 [PIPELINE] Generating page 0 (dedication) for job ${jobId}`);
      const page0Prompt = inputData.dedication && inputData.dedication.trim()
        ? `${page0Scene}\n\nStyle: ${styleDescription}.${characterInfo}\n\nCRITICAL: Include ONLY this exact text in the image: "${inputData.dedication}"\n\nDo not add any other text. Only "${inputData.dedication}" must appear. No additional words allowed.`
        : `${page0Scene}\n\nStyle: ${styleDescription}.${characterInfo}\n\nCreate this as an introduction page for "${storyTitle}".\n\nIMPORTANT: This image should contain NO TEXT at all - create a purely visual, atmospheric illustration that sets the mood for the story.`;
      page0Result = await callGeminiAPIForImage(page0Prompt, characterPhotos);
      console.log(`✅ [PIPELINE] Page 0 generated successfully`);
    } catch (error) {
      console.error(`❌ [PIPELINE] Failed to generate page 0 for job ${jobId}:`, error);
      throw new Error(`Page 0 generation failed: ${error.message}`);
    }

    // Generate back cover (matches step-by-step prompt format)
    try {
      console.log(`📕 [PIPELINE] Generating back cover for job ${jobId}`);
      const backCoverPrompt = `${backCoverScene}\n\nStyle: ${styleDescription}.${characterInfo}\n\nCRITICAL: Include ONLY this exact text in the image: "magicalstory.ch" in elegant letters in the bottom left corner.\n\nDo not add any other text. Only "magicalstory.ch" must appear. No additional words allowed.`;
      backCoverResult = await callGeminiAPIForImage(backCoverPrompt, characterPhotos);
      console.log(`✅ [PIPELINE] Back cover generated successfully`);
    } catch (error) {
      console.error(`❌ [PIPELINE] Failed to generate back cover for job ${jobId}:`, error);
      throw new Error(`Back cover generation failed: ${error.message}`);
    }

    const coverImages = {
      frontCover: frontCoverResult.imageData,
      page0: page0Result.imageData,
      backCover: backCoverResult.imageData
    };

    // Job complete - save result
    const resultData = {
      outline,
      storyText,
      sceneDescriptions: sceneDescriptionsArray, // Use parsed array instead of raw string
      images,
      coverImages,
      imagePrompts, // Include image prompts for developer features
      title: storyTitle // Use AI-extracted title from story text
    };

    console.log('📖 [SERVER] resultData keys:', Object.keys(resultData));
    console.log('📖 [SERVER] storyText exists?', !!resultData.storyText);
    console.log('📖 [SERVER] storyText length:', resultData.storyText?.length || 0);
    console.log('📖 [SERVER] storyText preview:', resultData.storyText?.substring(0, 200));

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      ['completed', 100, 'Story generation complete!', JSON.stringify(resultData), jobId]
    );

    console.log(`✅ Job ${jobId} completed successfully`);

  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error);

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      ['failed', error.message, jobId]
    );
  }
}

// Helper functions for story generation

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

  return `Create a cinematic scene in ${styleDescription}.

Scene Description: ${sceneDescription}${characterPrompts}

Important:
- Show only the emotions visible on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years old`;
}

async function callClaudeAPI(prompt, maxTokens = 4096) {
  // Call Claude API for text generation
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Claude API key not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: prompt
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
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
 * @returns {Promise<number>} Quality score from 0-10
 */
async function evaluateImageQuality(imageData) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.warn('⚠️  [QUALITY] Claude API key not configured, skipping quality evaluation');
      return null;
    }

    // Extract base64 and mime type
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: 'Evaluate this AI-generated children\'s storybook illustration on a scale of 0-10. Consider: visual appeal, clarity, artistic quality, age-appropriateness, and technical quality (no artifacts, good composition). Respond with ONLY a number between 0-10, nothing else.'
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ [QUALITY] Claude API error:', error);
      return null;
    }

    const data = await response.json();
    const scoreText = data.content[0].text.trim();
    const score = parseFloat(scoreText);

    if (isNaN(score) || score < 0 || score > 10) {
      console.warn('⚠️  [QUALITY] Invalid score received:', scoreText);
      return null;
    }

    console.log(`⭐ [QUALITY] Image quality score: ${score}/10`);
    return score;
  } catch (error) {
    console.error('❌ [QUALITY] Error evaluating image quality:', error);
    return null;
  }
}

async function callGeminiAPIForImage(prompt, characterPhotos = []) {
  // Check cache first
  const cacheKey = generateImageCacheKey(prompt, characterPhotos);

  if (imageCache.has(cacheKey)) {
    console.log('💾 [IMAGE CACHE] Cache HIT - reusing previously generated image');
    console.log('💾 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');
    console.log('💾 [IMAGE CACHE] Cache size:', imageCache.size, 'images');
    return imageCache.get(cacheKey);
  }

  console.log('🆕 [IMAGE CACHE] Cache MISS - generating new image');
  console.log('🆕 [IMAGE CACHE] Cache key:', cacheKey.substring(0, 16) + '...');

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

        // Evaluate image quality
        console.log('⭐ [QUALITY] Evaluating image quality...');
        const qualityScore = await evaluateImageQuality(compressedImageData);

        // Store in cache
        const result = { imageData: compressedImageData, score: qualityScore };
        imageCache.set(cacheKey, result);
        console.log('💾 [IMAGE CACHE] Stored in cache. Total cached:', imageCache.size, 'images');

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
