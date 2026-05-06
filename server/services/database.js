// Database Service - PostgreSQL connection and query utilities
const { Pool } = require('pg');
const { arrayToDbIndex } = require('../lib/versionManager');
const r2 = require('../lib/r2');
const { log } = require('../utils/logger');

let dbPool = null;

// Initialize database connection pool
function initializePool() {
  if (dbPool) return dbPool;

  // Use Railway's DATABASE_URL if available, otherwise use individual env vars
  const connectionConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('railway.app') ? { rejectUnauthorized: false } : false
      }
    : {
        host: process.env.PGHOST || 'localhost',
        port: process.env.PGPORT || 5432,
        database: process.env.PGDATABASE || 'magicalstory',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || '',
        ssl: false
      };

  // Pool configuration for better resource management
  const poolConfig = {
    ...connectionConfig,
    max: parseInt(process.env.DB_POOL_MAX) || 20, // Maximum connections
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000, // Close idle connections after 30s
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT) || 10000, // Timeout connecting after 10s
    statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT) || 120000, // Query timeout after 120s (prevent infinite hangs)
  };

  dbPool = new Pool(poolConfig);

  dbPool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });

  return dbPool;
}

// Query helper function
async function dbQuery(sql, params = []) {
  if (!dbPool) {
    throw new Error('Database pool not initialized');
  }
  const result = await dbPool.query(sql, params);
  // Return rows with metadata for DELETE/UPDATE operations
  result.rows.rowCount = result.rowCount;
  result.rows.command = result.command;
  return result.rows;
}

// Get the pool directly (for transactions, etc.)
function getPool() {
  return dbPool;
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

    // Add columns if they don't exist
    const columnsToAdd = [
      { table: 'users', column: 'last_login', type: 'TIMESTAMP' },
      { table: 'users', column: 'preferred_language', type: "VARCHAR(20) DEFAULT 'English'" },
      { table: 'users', column: 'credits', type: 'INT DEFAULT 500' },
      { table: 'users', column: 'email_verified', type: 'BOOLEAN DEFAULT FALSE' },
      { table: 'users', column: 'email_verification_token', type: 'VARCHAR(255)' },
      { table: 'users', column: 'email_verification_expires', type: 'TIMESTAMP' },
      { table: 'users', column: 'password_reset_token', type: 'VARCHAR(255)' },
      { table: 'users', column: 'password_reset_expires', type: 'TIMESTAMP' },
      { table: 'users', column: 'photo_consent_at', type: 'TIMESTAMP' },
      { table: 'users', column: 'has_set_password', type: 'BOOLEAN DEFAULT TRUE' },
      { table: 'users', column: 'anonymous', type: 'BOOLEAN DEFAULT FALSE' },
      { table: 'users', column: 'firebase_uid', type: 'VARCHAR(255)' },
    ];

    for (const { table, column, type } of columnsToAdd) {
      await dbPool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    }

    // Normalize email + username columns so login lookups are deterministic.
    // The pre-fix register path stored the same mixed-case value in both columns
    // and didn't lowercase `username`; older rows may therefore have mixed-case
    // emails. Lowercase everything, and realign username = email so code that
    // still reads the username column keeps returning the canonical email.
    await dbPool.query(`UPDATE users SET email = LOWER(email) WHERE email IS NOT NULL AND email <> LOWER(email)`);
    await dbPool.query(`UPDATE users SET username = email WHERE email IS NOT NULL AND username <> email`);
    // Case-insensitive unique index on email — protects identity going forward
    // without blocking on the old UNIQUE(username) constraint.
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_ci ON users (LOWER(email))`);

    // Update existing users with NULL credits
    await dbPool.query(`UPDATE users SET credits = -1 WHERE credits IS NULL AND role = 'admin'`);
    await dbPool.query(`UPDATE users SET credits = 1000 WHERE credits IS NULL AND role = 'user'`);
    await dbPool.query(`UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL`);
    // Set existing users as having consented to photo uploads (retroactive consent)
    await dbPool.query(`UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE photo_consent_at IS NULL`);
    // Trial users with random passwords they don't know should have has_set_password = false
    await dbPool.query(`UPDATE users SET has_set_password = FALSE WHERE is_trial = TRUE AND has_set_password IS NOT FALSE`);

    // Config table
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

    // Logs table
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

    // Characters table (data is JSONB for fast queries)
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS characters (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_characters_user_id ON characters(user_id)`);
    await dbPool.query('CREATE INDEX IF NOT EXISTS idx_characters_data_gin ON characters USING GIN (data)');
    // Add metadata column if missing (for existing databases)
    await dbPool.query(`ALTER TABLE characters ADD COLUMN IF NOT EXISTS metadata JSONB`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_characters_metadata ON characters USING GIN (metadata)`);

    // Stories table (data is JSONB for fast queries)
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id VARCHAR(255) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_user_id ON stories(user_id)`);
    await dbPool.query('CREATE INDEX IF NOT EXISTS idx_stories_data_gin ON stories USING GIN (data)');
    // Add metadata column if missing (for existing databases)
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS metadata JSONB`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_stories_metadata ON stories USING GIN (metadata)`);
    // Add image_version_meta column for fast active image switching
    await dbPool.query(`ALTER TABLE stories ADD COLUMN IF NOT EXISTS image_version_meta JSONB DEFAULT '{}'`);

    // Story drafts table
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_drafts (
        user_id VARCHAR(255) PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Files table
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

    // Gelato products table
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

    // Orders table
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
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(255)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url VARCHAR(500)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMP`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tokens_credited INT DEFAULT 0`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_code_used VARCHAR(20)`);
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_cents INT DEFAULT 0`);

    // Referral system: each user gets a unique promo code; referrers earn credits
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(20)`);
    // Unique constraint on referral_code (idempotent — does nothing if already exists)
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL`);
    // Functional index for case-insensitive lookup (LOWER()) used by validateReferralCodeForUser
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code_lower ON users(LOWER(referral_code)) WHERE referral_code IS NOT NULL`);

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

    // Referral CHF balance: referrer earns CHF per redemption (instead of credits).
    // referral_balance_cents = total earned - total spent (discount/credits/refund).
    // referral_pending_cents = amount held during in-flight checkouts (subtracted
    // from available balance, restored on session expiry).
    // available = balance - pending. CHECK (>=0) + conditional UPDATE in
    // referralBalance.adjustBalance prevents double-spend without SELECT FOR UPDATE.
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_balance_cents >= 0)`);
    await dbPool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_pending_cents INTEGER NOT NULL DEFAULT 0 CHECK (referral_pending_cents >= 0)`);

    // Stripe mode at order creation. Required for refunds: isUserTestMode() is
    // current-state and would route refunds to the wrong account if a user's
    // role changed between order and refund. Existing orders left NULL — refund
    // helper treats NULL as 'live' (admins were rare pre-cutover).
    await dbPool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_mode VARCHAR(8)`);

    // Referral payout ledger — one row per balance change. Source of truth for
    // the available/pending values on users; users.referral_*_cents are caches.
    // type ∈ earned | pending_checkout | spent_discount | spent_credits |
    //        spent_refund | restored | admin_adjust
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

    // Backfill referral codes for existing users who don't have one yet
    {
      const { generateReferralCode: genCode } = require('../lib/referral');
      const missing = await dbPool.query('SELECT id, username, email, shipping_first_name FROM users WHERE referral_code IS NULL');
      for (const row of missing.rows) {
        const emailLocal = (row.email || row.username || '').split('@')[0];
        const nameSource = row.shipping_first_name || emailLocal || 'User';
        for (let attempt = 0; attempt < 10; attempt++) {
          const code = genCode(nameSource);
          try {
            await dbPool.query('UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL', [code, row.id]);
            break;
          } catch (e) {
            if (attempt === 9) {
              console.error(`❌ [DB] ADMIN ALERT: Failed to generate unique referral code for user ${row.id} (${row.username}) after 10 attempts — 900 slots exhausted for this name`);
              // Log to activity table so it shows in admin dashboard
              try {
                await dbPool.query(
                  `INSERT INTO activity_log (user_id, username, action, details) VALUES ($1, $2, $3, $4)`,
                  [row.id, row.username || 'unknown', 'REFERRAL_CODE_GENERATION_FAILED', JSON.stringify({ attempts: 10, username: row.username })]
                );
              } catch { /* activity_log may not exist yet during init */ }
            }
          }
        }
      }
      if (missing.rows.length > 0) {
        console.log(`[DB] Backfilled referral codes for ${missing.rows.length} users`);
      }
    }

    // Credit transactions table
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

    // Story jobs table
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

    // Add credits_reserved column if missing
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

    // Story job checkpoints table
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

    // Consolidator calls table — per-call audit for the feedback consolidator.
    // Lives in its own table because upsertStory writes the whole stories.data
    // blob at the end of generation and would stomp any field written mid-flight
    // by jsonb_set. Separate table sidesteps that race.
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
    // Drop the FK if it exists from an earlier version of the schema.
    // Consolidator runs mid-pipeline before the story row is persisted to the
    // stories table — an FK to stories(id) made every INSERT fail.
    await dbPool.query(`ALTER TABLE consolidator_calls DROP CONSTRAINT IF EXISTS consolidator_calls_story_id_fkey`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story ON consolidator_calls(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_consolidator_calls_story_page ON consolidator_calls(story_id, page_number, round)`);

    // Story retry images table - stores retry history images separately to keep data blob small
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS story_retry_images (
        id SERIAL PRIMARY KEY,
        story_id VARCHAR(255) NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
        page_number INT NOT NULL,
        retry_index INT NOT NULL,
        image_type VARCHAR(50) NOT NULL,
        grid_index INT,
        image_data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_retry_images_story ON story_retry_images(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_retry_images_page ON story_retry_images(story_id, page_number)`);
    // Unique index with COALESCE (can't use inline UNIQUE constraint with functions)
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_retry_images_unique ON story_retry_images(story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))`);

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

    // Seed default pricing tiers if table is empty
    // Hardcover = Softcover + CHF 8 (flat premium)
    // Soft margin scales 12 → 25 across tiers; Hard margin scales 16 → 25
    const pricingCheck = await dbPool.query('SELECT COUNT(*) as count FROM pricing_tiers');
    if (parseInt(pricingCheck[0].count) === 0) {
      const defaultTiers = [
        { maxPages: 30,  label: '1-30',   softcover: 29, hardcover: 37 },
        { maxPages: 40,  label: '31-40',  softcover: 35, hardcover: 43 },
        { maxPages: 50,  label: '41-50',  softcover: 41, hardcover: 49 },
        { maxPages: 60,  label: '51-60',  softcover: 47, hardcover: 55 },
        { maxPages: 70,  label: '61-70',  softcover: 52, hardcover: 60 },
        { maxPages: 80,  label: '71-80',  softcover: 58, hardcover: 66 },
        { maxPages: 90,  label: '81-90',  softcover: 64, hardcover: 72 },
        { maxPages: 100, label: '91-100', softcover: 69, hardcover: 77 },
      ];
      for (const tier of defaultTiers) {
        await dbPool.query(
          'INSERT INTO pricing_tiers (max_pages, label, softcover_price, hardcover_price) VALUES ($1, $2, $3, $4)',
          [tier.maxPages, tier.label, tier.softcover, tier.hardcover]
        );
      }
      console.log('✓ Default pricing tiers seeded');
    } else {
      // Migration: reduce all prices by CHF 5 (2026-03-31)
      const currentFirst = await dbPool.query('SELECT softcover_price FROM pricing_tiers WHERE max_pages = 30');
      if (currentFirst.length > 0 && currentFirst[0].softcover_price > 33) {
        await dbPool.query('UPDATE pricing_tiers SET softcover_price = softcover_price - 5, hardcover_price = hardcover_price - 5');
        console.log('✓ Pricing tiers reduced by CHF 5');
      }

      // Migration: new pricing model with CHF 25 max margin and +CHF 8 hard premium (2026-04-07)
      // Detect by checking if 30p softcover is still at the old anchor (28).
      const newPricingSentinel = await dbPool.query('SELECT softcover_price FROM pricing_tiers WHERE max_pages = 30');
      if (newPricingSentinel.length > 0 && newPricingSentinel[0].softcover_price === 28) {
        const newPrices = [
          { maxPages: 30,  soft: 29, hard: 37 },
          { maxPages: 40,  soft: 35, hard: 43 },
          { maxPages: 50,  soft: 41, hard: 49 },
          { maxPages: 60,  soft: 47, hard: 55 },
          { maxPages: 70,  soft: 52, hard: 60 },
          { maxPages: 80,  soft: 58, hard: 66 },
          { maxPages: 90,  soft: 64, hard: 72 },
          { maxPages: 100, soft: 69, hard: 77 },
        ];
        for (const p of newPrices) {
          await dbPool.query(
            'UPDATE pricing_tiers SET softcover_price = $1, hardcover_price = $2 WHERE max_pages = $3',
            [p.soft, p.hard, p.maxPages]
          );
        }
        console.log('✓ Pricing tiers: applied new model (soft 29-69, hard = soft+8, margin cap 25)');
      }
    }

    // Fix NULL page_number breaking UNIQUE constraint for covers.
    // PostgreSQL treats NULL != NULL in UNIQUE, so ON CONFLICT never fires for covers.
    // Replace the broken constraint with two partial unique indexes.
    await dbPool.query(`ALTER TABLE story_images DROP CONSTRAINT IF EXISTS story_images_story_id_image_type_page_number_version_index_key`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_with_page
      ON story_images(story_id, image_type, page_number, version_index) WHERE page_number IS NOT NULL`);
    await dbPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_images_unique_without_page
      ON story_images(story_id, image_type, version_index) WHERE page_number IS NULL`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_images_story_id ON story_images(story_id)`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS idx_story_images_story_version ON story_images(story_id, version_index)`);

    // R2 migration (Phase 1): nullable URL columns alongside existing image_data.
    // Writers populate both when R2 is configured; readers continue to use image_data
    // until Phase 2. Backfill copies legacy bytes into R2 and fills image_url.
    await dbPool.query(`ALTER TABLE story_images       ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await dbPool.query(`ALTER TABLE story_retry_images ADD COLUMN IF NOT EXISTS image_url TEXT`);
    await dbPool.query(`ALTER TABLE style_lab_images   ADD COLUMN IF NOT EXISTS image_url TEXT`);

    // R2 migration (Phase 1b): the writers set image_data=null once the bytes
    // live in R2 (saveStyleLabImage / story_images write path). The original
    // CREATE TABLE declared image_data NOT NULL, so any URL-only insert dies
    // with "null value in column ... violates not-null constraint" — visible
    // in the Style Lab UI as both Grok and Gemini cards showing the error
    // text in place of the rendered image. Drop NOT NULL on all three R2
    // dual-write tables. IF EXISTS guards make this safe to re-run.
    await dbPool.query(`ALTER TABLE story_images       ALTER COLUMN image_data DROP NOT NULL`);
    await dbPool.query(`ALTER TABLE story_retry_images ALTER COLUMN image_data DROP NOT NULL`);
    await dbPool.query(`ALTER TABLE style_lab_images   ALTER COLUMN image_data DROP NOT NULL`);

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

    console.log('✓ Database tables initialized');

  } catch (err) {
    console.error('❌ Database initialization error:', err.message);
    throw err;
  }
}

// Close the pool
async function closePool() {
  if (dbPool) {
    await dbPool.end();
    dbPool = null;
    console.log('Database pool closed');
  }
}

// Helper to check if using database mode
function isDatabaseMode() {
  return process.env.STORAGE_MODE === 'database' && getPool();
}

// Pick the best src value for an image row: bytes if present, otherwise R2 URL.
// Browsers' <img src> accepts both data: URLs and https: URLs identically, so
// callers can keep treating the result as a single string.
function imgSrc(row) {
  if (!row) return null;
  return row.image_data || row.image_url || null;
}

// Materialize bytes for a row: if image_data is set return it as-is; otherwise
// fetch from the R2 URL and return a base64 string. Used by rehydrateStoryImages
// so server-side byte-consumers (repair workflow, sharp metadata reads, semantic
// eval, MagicAPI) keep working after image_data was NULL'd post-R2-migration.
// Returns null on any failure so callers can keep the URL fallback.
async function imgBytesAsync(row) {
  if (!row) return null;
  if (row.image_data) return row.image_data;
  if (!row.image_url) return null;
  try {
    const r2 = require('../lib/r2');
    const buf = await r2.fetchImageBytes(row.image_url);
    if (!buf) return row.image_url;
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
               : buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg'
               : buf[0] === 0x52 && buf[1] === 0x49 ? 'image/webp'
               : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn(`[R2] imgBytesAsync fetch failed: ${err.message}`);
    return row.image_url;
  }
}

// Helper to log activity
async function logActivity(userId, username, action, details) {
  try {
    if (isDatabaseMode()) {
      await dbQuery(
        'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
        [userId, username, action, JSON.stringify(details)]
      );
    }
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

/**
 * Build metadata object from story data for fast list queries.
 * This extracts only the fields needed for listing stories.
 */
function buildStoryMetadata(story) {
  const sceneCount = story.sceneImages?.length || 0;
  const frontCover = story.coverImages?.frontCover;
  const hasThumbnail = !!(
    (frontCover && (frontCover.imageData || frontCover.hasImage)) ||
    story.thumbnail
  );

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    pages: story.pages,
    language: story.language,
    languageLevel: story.languageLevel,
    isPartial: story.isPartial || false,
    generatedPages: story.generatedPages,
    totalPages: story.totalPages,
    sceneCount,
    hasThumbnail,
    characters: (story.characters || []).map(c => ({ id: c.id, name: c.name })),
    // Analytics fields for fast filtering/aggregation
    artStyle: story.artStyle,
    storyType: story.storyType,
    storyCategory: story.storyCategory,
    season: story.season,
    characterCount: (story.characters || []).length,
    totalCost: story.analytics?.totalCost ?? null,
    avgQualityScore: story.analytics?.avgQualityScore ?? null,
    totalDurationMs: story.analytics?.totalDurationMs ?? null,
  };
}

/**
 * Walk a story-data subtree and push every inline base64 / data: URI image
 * payload to R2, replacing the inline value with the R2 URL. Runs BEFORE
 * stripInlineImagesFromStoryData so anything that successfully uploads
 * survives the strip as a real URL.
 *
 * Idempotent: only touches strings that look like base64 / data: URIs;
 * existing http(s) URLs are left as-is. Missing R2 config or upload
 * failures leave the original inline value in place — the strip then
 * removes it (matching the historical behaviour).
 *
 * Mutates `data` in place.
 *
 * @param {string} storyId
 * @param {object} data    storyData blob (or response shape mirroring it)
 */
async function extractInlineImagesToR2(storyId, data) {
  if (!data || typeof data !== 'object') return;
  if (!r2.isConfigured()) return;  // graceful no-op; strip will still drop bytes

  const looksLikeBytes = (s) =>
    typeof s === 'string'
    && (s.startsWith('data:image/') || s.startsWith('/9j/') || s.startsWith('iVBORw0') || s.startsWith('R0lGOD'))
    && s.length > 1024;

  const upload = async (input, key) => {
    try {
      return await r2.uploadImage(input, key);
    } catch (err) {
      log.warn(`[R2-extract] upload failed for ${key}: ${err.message}`);
      return null;
    }
  };

  // sceneImages — per-page debug images
  if (Array.isArray(data.sceneImages)) {
    for (const s of data.sceneImages) {
      if (!s || typeof s !== 'object') continue;
      const pageNum = s.pageNumber;

      if (looksLikeBytes(s.bboxOverlayImage)) {
        const url = await upload(s.bboxOverlayImage, r2.keyForBboxOverlay(storyId, pageNum, 0));
        if (url) s.bboxOverlayImage = url;
      }
      if (looksLikeBytes(s.visualBibleGrid)) {
        const url = await upload(s.visualBibleGrid, r2.keyForVbGrid(storyId, pageNum));
        if (url) s.visualBibleGrid = url;
      }
      if (Array.isArray(s.grokRefImages)) {
        for (let k = 0; k < s.grokRefImages.length; k++) {
          if (looksLikeBytes(s.grokRefImages[k])) {
            const url = await upload(s.grokRefImages[k], r2.keyForGrokRef(storyId, pageNum, 0, k));
            if (url) s.grokRefImages[k] = url;
          }
        }
      }
      if (Array.isArray(s.imageVersions)) {
        for (let i = 0; i < s.imageVersions.length; i++) {
          const v = s.imageVersions[i];
          if (!v) continue;
          if (looksLikeBytes(v.bboxOverlayImage)) {
            const url = await upload(v.bboxOverlayImage, r2.keyForBboxOverlay(storyId, pageNum, i));
            if (url) v.bboxOverlayImage = url;
          }
          if (Array.isArray(v.grokRefImages)) {
            for (let k = 0; k < v.grokRefImages.length; k++) {
              if (looksLikeBytes(v.grokRefImages[k])) {
                const url = await upload(v.grokRefImages[k], r2.keyForGrokRef(storyId, pageNum, i, k));
                if (url) v.grokRefImages[k] = url;
              }
            }
          }
          if (Array.isArray(v.inpaintReferenceImages)) {
            for (let k = 0; k < v.inpaintReferenceImages.length; k++) {
              if (looksLikeBytes(v.inpaintReferenceImages[k])) {
                const url = await upload(v.inpaintReferenceImages[k], r2.keyForInpaintRef(storyId, pageNum, i, k));
                if (url) v.inpaintReferenceImages[k] = url;
              }
            }
          }
        }
      }
      if (Array.isArray(s.landmarkPhotos)) {
        for (let k = 0; k < s.landmarkPhotos.length; k++) {
          const lp = s.landmarkPhotos[k];
          if (lp && typeof lp === 'object' && looksLikeBytes(lp.photoData)) {
            const url = await upload(lp.photoData, r2.keyForLandmarkPhoto(storyId, pageNum, k));
            if (url) {
              lp.photoUrl = url;
              lp.photoData = undefined;
            }
          }
        }
      }
      if (s.entityReport && typeof s.entityReport === 'object') {
        if (Array.isArray(s.entityReport.grids)) {
          for (let k = 0; k < s.entityReport.grids.length; k++) {
            const g = s.entityReport.grids[k];
            if (g && looksLikeBytes(g.gridImage)) {
              const url = await upload(g.gridImage, r2.keyForEntityGrid(storyId, pageNum, k));
              if (url) g.gridImage = url;
            }
          }
        }
        if (s.entityReport.characters && typeof s.entityReport.characters === 'object') {
          for (const [charName, charReport] of Object.entries(s.entityReport.characters)) {
            if (!charReport?.byClothing || typeof charReport.byClothing !== 'object') continue;
            for (const [clothing, clothingReport] of Object.entries(charReport.byClothing)) {
              if (!clothingReport) continue;
              if (looksLikeBytes(clothingReport.gridImage)) {
                const url = await upload(clothingReport.gridImage, r2.keyForCharGrid(storyId, pageNum, charName, clothing, null));
                if (url) clothingReport.gridImage = url;
              }
              if (Array.isArray(clothingReport.gridImages)) {
                for (let k = 0; k < clothingReport.gridImages.length; k++) {
                  if (looksLikeBytes(clothingReport.gridImages[k])) {
                    const url = await upload(clothingReport.gridImages[k], r2.keyForCharGrid(storyId, pageNum, charName, clothing, k));
                    if (url) clothingReport.gridImages[k] = url;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // coverImages — same families of debug images
  if (data.coverImages && typeof data.coverImages === 'object') {
    for (const kind of ['frontCover', 'initialPage', 'backCover']) {
      const cv = data.coverImages[kind];
      if (!cv || typeof cv !== 'object') continue;
      const pageMarker = kind;  // covers use the kind as their slug

      if (looksLikeBytes(cv.bboxOverlayImage)) {
        const url = await upload(cv.bboxOverlayImage, `stories/${storyId}/debug/${pageMarker}/bbox-overlay-v0.jpg`);
        if (url) cv.bboxOverlayImage = url;
      }
      if (looksLikeBytes(cv.visualBibleGrid)) {
        const url = await upload(cv.visualBibleGrid, `stories/${storyId}/debug/${pageMarker}/vb-grid.jpg`);
        if (url) cv.visualBibleGrid = url;
      }
      if (Array.isArray(cv.grokRefImages)) {
        for (let k = 0; k < cv.grokRefImages.length; k++) {
          if (looksLikeBytes(cv.grokRefImages[k])) {
            const url = await upload(cv.grokRefImages[k], `stories/${storyId}/debug/${pageMarker}/v0/grok-ref-${k}.jpg`);
            if (url) cv.grokRefImages[k] = url;
          }
        }
      }
      if (Array.isArray(cv.imageVersions)) {
        for (let i = 0; i < cv.imageVersions.length; i++) {
          const v = cv.imageVersions[i];
          if (!v) continue;
          if (looksLikeBytes(v.bboxOverlayImage)) {
            const url = await upload(v.bboxOverlayImage, `stories/${storyId}/debug/${pageMarker}/bbox-overlay-v${i}.jpg`);
            if (url) v.bboxOverlayImage = url;
          }
          if (Array.isArray(v.grokRefImages)) {
            for (let k = 0; k < v.grokRefImages.length; k++) {
              if (looksLikeBytes(v.grokRefImages[k])) {
                const url = await upload(v.grokRefImages[k], `stories/${storyId}/debug/${pageMarker}/v${i}/grok-ref-${k}.jpg`);
                if (url) v.grokRefImages[k] = url;
              }
            }
          }
          if (Array.isArray(v.inpaintReferenceImages)) {
            for (let k = 0; k < v.inpaintReferenceImages.length; k++) {
              if (looksLikeBytes(v.inpaintReferenceImages[k])) {
                const url = await upload(v.inpaintReferenceImages[k], `stories/${storyId}/debug/${pageMarker}/v${i}/inpaint-ref-${k}.jpg`);
                if (url) v.inpaintReferenceImages[k] = url;
              }
            }
          }
        }
      }
      if (Array.isArray(cv.landmarkPhotos)) {
        for (let k = 0; k < cv.landmarkPhotos.length; k++) {
          const lp = cv.landmarkPhotos[k];
          if (lp && typeof lp === 'object' && looksLikeBytes(lp.photoData)) {
            const url = await upload(lp.photoData, `stories/${storyId}/debug/${pageMarker}/landmark-${k}.jpg`);
            if (url) {
              lp.photoUrl = url;
              lp.photoData = undefined;
            }
          }
        }
      }
      if (Array.isArray(cv.referencePhotos)) {
        for (let k = 0; k < cv.referencePhotos.length; k++) {
          const rp = cv.referencePhotos[k];
          if (!rp || typeof rp !== 'object') continue;
          if (looksLikeBytes(rp.photoUrl)) {
            const url = await upload(rp.photoUrl, `stories/${storyId}/debug/${pageMarker}/ref-photo-${k}.jpg`);
            if (url) rp.photoUrl = url;
          }
          if (looksLikeBytes(rp.originalPhotoUrl)) {
            const url = await upload(rp.originalPhotoUrl, `stories/${storyId}/debug/${pageMarker}/ref-photo-${k}-orig.jpg`);
            if (url) rp.originalPhotoUrl = url;
          }
        }
      }
    }
  }

  // visualBible.locations — Wikimedia ref bytes
  if (data.visualBible && typeof data.visualBible === 'object'
      && Array.isArray(data.visualBible.locations)) {
    for (const loc of data.visualBible.locations) {
      if (!loc || typeof loc !== 'object') continue;
      const entryId = loc.id || loc.dbKey || loc.name;
      if (!entryId) continue;
      if (looksLikeBytes(loc.referencePhotoData)) {
        const url = await upload(loc.referencePhotoData, r2.keyForVbReference(storyId, String(entryId).replace(/[^a-zA-Z0-9_-]/g, '_')));
        if (url) {
          loc.referencePhotoUrl = url;
          loc.referencePhotoData = undefined;
        }
      }
    }
  }

  // finalChecksReport — entity grids + repair comparison images
  if (data.finalChecksReport && typeof data.finalChecksReport === 'object') {
    const fcr = data.finalChecksReport;
    if (fcr.entity?.grids && Array.isArray(fcr.entity.grids)) {
      for (let k = 0; k < fcr.entity.grids.length; k++) {
        const g = fcr.entity.grids[k];
        if (g && looksLikeBytes(g.gridImage)) {
          const url = await upload(g.gridImage, `stories/${storyId}/debug/final-checks/entity-grid-${k}.jpg`);
          if (url) g.gridImage = url;
        }
      }
    }
    if (fcr.entity?.characters && typeof fcr.entity.characters === 'object') {
      for (const [charName, charReport] of Object.entries(fcr.entity.characters)) {
        if (!charReport?.byClothing || typeof charReport.byClothing !== 'object') continue;
        for (const [clothing, clothingReport] of Object.entries(charReport.byClothing)) {
          if (!clothingReport) continue;
          if (looksLikeBytes(clothingReport.gridImage)) {
            const url = await upload(clothingReport.gridImage, r2.keyForCharGrid(storyId, null, `final-${charName}`, clothing, null));
            if (url) clothingReport.gridImage = url;
          }
          if (Array.isArray(clothingReport.gridImages)) {
            for (let k = 0; k < clothingReport.gridImages.length; k++) {
              if (looksLikeBytes(clothingReport.gridImages[k])) {
                const url = await upload(clothingReport.gridImages[k], r2.keyForCharGrid(storyId, null, `final-${charName}`, clothing, k));
                if (url) clothingReport.gridImages[k] = url;
              }
            }
          }
        }
      }
    }
    if (fcr.styleConsistency && typeof fcr.styleConsistency === 'object'
        && looksLikeBytes(fcr.styleConsistency.gridImage)) {
      const url = await upload(fcr.styleConsistency.gridImage, `stories/${storyId}/debug/final-checks/style-consistency-grid.jpg`);
      if (url) fcr.styleConsistency.gridImage = url;
    }
    if (fcr.entityRepairs && typeof fcr.entityRepairs === 'object') {
      for (const [charName, charRepair] of Object.entries(fcr.entityRepairs)) {
        if (!charRepair?.pages || typeof charRepair.pages !== 'object') continue;
        for (const [pageKey, pageRepair] of Object.entries(charRepair.pages)) {
          if (!pageRepair?.comparison || typeof pageRepair.comparison !== 'object') continue;
          for (const k of ['before', 'after', 'grokRawResult', 'blackoutImage', 'blendMask', 'croppedAvatar', 'cutoutSent']) {
            if (looksLikeBytes(pageRepair.comparison[k])) {
              const url = await upload(pageRepair.comparison[k], r2.keyForRepairCompare(storyId, charName, pageKey, k));
              if (url) pageRepair.comparison[k] = url;
            }
          }
        }
      }
    }
  }

  // styledAvatarGeneration / costumedAvatarGeneration — entry inputs
  for (const arrName of ['styledAvatarGeneration', 'costumedAvatarGeneration']) {
    if (!Array.isArray(data[arrName])) continue;
    for (let i = 0; i < data[arrName].length; i++) {
      const e = data[arrName][i];
      if (!e || typeof e !== 'object') continue;
      if (e.inputs && typeof e.inputs === 'object') {
        for (const [field, slot] of Object.entries(e.inputs)) {
          if (slot && typeof slot === 'object' && looksLikeBytes(slot.imageData)) {
            const url = await upload(slot.imageData, r2.keyForStyledAvatarInput(storyId, `${arrName}-${i}`, field));
            if (url) {
              slot.imageUrl = url;
              slot.imageData = undefined;
            }
          }
        }
      }
      if (e.output && typeof e.output === 'object' && looksLikeBytes(e.output.imageData)) {
        const url = await upload(e.output.imageData, r2.keyForStyledAvatarInput(storyId, `${arrName}-${i}`, 'output'));
        if (url) {
          e.output.imageUrl = url;
          e.output.imageData = undefined;
        }
      }
    }
  }
}

/**
 * Strip every inline base64 / data: URI image payload from a story-data
 * subtree. Source of truth lives elsewhere (characters table for character
 * photos+avatars, story_images for scene/cover bytes, R2 for reference
 * sheets), so these payloads only inflate the JSONB row.
 *
 * Targets identified from production audit (per ~150MB story):
 *   - sceneImages[*].entityReport.grids[*].gridImage              (Gemini eval grids)
 *   - sceneImages[*].entityReport.characters.*.byClothing.*.gridImage(s)
 *   - sceneImages[*].sceneCharacters[*].photos.*                  (snapshot)
 *   - sceneImages[*].sceneCharacters[*].avatars.{standard,summer,winter,faceThumbnails,bodyThumbnails,styledAvatars}
 *   - sceneImages[*].imageVersions[*].grokRefImages[*]            (Grok inputs)
 *   - sceneImages[*].imageVersions[*].inpaintReferenceImages[*]   (inpaint refs)
 *   - sceneImages[*].grokRefImages[*]
 *   - sceneImages[*].bboxOverlayImage                             (debug overlay)
 *   - sceneImages[*].visualBibleGrid                              (debug grid)
 *   - sceneImages[*].landmarkPhotos[*].photoData                  (Wikimedia bytes)
 *   - sceneImages[*].referencePhotos[*].{photoUrl,originalPhotoUrl} when data: URI
 *   - coverImages.{front,initial,back}Cover.{retryHistory,grokRefImages,bboxOverlayImage}
 *   - coverImages.*.imageVersions[*].{grokRefImages,inpaintReferenceImages,bboxOverlayImage}
 *   - visualBible.locations[*].referencePhotoData                 (Wikimedia bytes)
 *   - finalChecksReport.entity.grids[*].gridImage
 *   - finalChecksReport.entityRepairs.*.pages.*.comparison.{before,after,grokRawResult,blackoutImage,blendMask,croppedAvatar,cutoutSent}
 *   - styledAvatarGeneration[*].inputs.*.imageData / .output.imageData
 *   - characters[*].photos.*                                       (top-level snapshot duplicates characters table)
 *   - characters[*].avatars.{standard,summer,winter,faceThumbnails,bodyThumbnails,styledAvatars}
 *
 * Mutates `data` in place. Idempotent.
 */
function stripInlineImagesFromStoryData(data) {
  if (!data || typeof data !== 'object') return;

  // Helpers — these preserve real http(s) URLs (left in place for readers)
  // and only clear values that are still inline base64 / data: URIs.
  // After extractInlineImagesToR2 runs, most fields hold URLs; keepUrl is
  // the dominant path. The undefined branch only fires when R2 was
  // unreachable or the field never went through extract.
  const keepUrl = (s) =>
    (typeof s === 'string' && s.length > 0 && !s.startsWith('data:') && !s.startsWith('/9j/')
      && !s.startsWith('iVBORw0') && !s.startsWith('R0lGOD'))
      ? s
      : undefined;
  const filterUrlArray = (arr) => Array.isArray(arr)
    ? arr.filter(s => typeof s === 'string' && s.length > 0
        && !s.startsWith('data:') && !s.startsWith('/9j/')
        && !s.startsWith('iVBORw0') && !s.startsWith('R0lGOD'))
    : undefined;

  // Strip per-character bytes that DUPLICATE the characters table (photos
  // and unstyled avatars/thumbnails are canonical there). Leave styledAvatars
  // and costumed in place — they are per-story specific (this story's art
  // style + this story's costume), so the embedded snapshot is the ONLY
  // place they live. Stripping them caused image gen to fall back to the
  // unstyled standard avatar, leaking modern clothing into costumed scenes.
  const stripCharSnapshot = (c) => {
    if (!c || typeof c !== 'object') return;
    if (c.photos && typeof c.photos === 'object') {
      for (const k of ['original', 'face', 'body', 'bodyNoBg']) c.photos[k] = undefined;
    }
    if (c.avatars && typeof c.avatars === 'object') {
      for (const k of ['standard', 'summer', 'winter', 'formal']) c.avatars[k] = undefined;
      c.avatars.faceThumbnails = undefined;
      c.avatars.bodyThumbnails = undefined;
      // DO NOT strip c.avatars.styledAvatars — per-story data, no other source.
      // DO NOT strip c.avatars.costumed   — per-story data, no other source.
    }
  };

  // sceneImages
  if (Array.isArray(data.sceneImages)) {
    for (const s of data.sceneImages) {
      if (!s || typeof s !== 'object') continue;
      s.bboxOverlayImage = keepUrl(s.bboxOverlayImage);
      s.grokRefImages = filterUrlArray(s.grokRefImages);
      s.originalImage = undefined;
      s.preEntityRepairImage = undefined;
      s.visualBibleGrid = keepUrl(s.visualBibleGrid);
      if (Array.isArray(s.imageVersions)) {
        for (const v of s.imageVersions) {
          if (!v) continue;
          v.grokRefImages = filterUrlArray(v.grokRefImages);
          v.inpaintReferenceImages = filterUrlArray(v.inpaintReferenceImages);
          v.bboxOverlayImage = keepUrl(v.bboxOverlayImage);
        }
      }
      if (Array.isArray(s.sceneCharacters)) {
        for (const c of s.sceneCharacters) stripCharSnapshot(c);
      }
      if (Array.isArray(s.landmarkPhotos)) {
        for (const lp of s.landmarkPhotos) {
          if (lp && typeof lp === 'object') {
            lp.photoData = undefined;
            lp.photoUrl = keepUrl(lp.photoUrl);
          }
        }
      }
      if (Array.isArray(s.referencePhotos)) {
        for (const rp of s.referencePhotos) {
          if (!rp || typeof rp !== 'object') continue;
          rp.photoUrl = keepUrl(rp.photoUrl);
          rp.originalPhotoUrl = keepUrl(rp.originalPhotoUrl);
        }
      }
      if (s.entityReport && typeof s.entityReport === 'object') {
        if (Array.isArray(s.entityReport.grids)) {
          for (const g of s.entityReport.grids) if (g) g.gridImage = keepUrl(g.gridImage);
        }
        if (s.entityReport.characters && typeof s.entityReport.characters === 'object') {
          for (const charReport of Object.values(s.entityReport.characters)) {
            if (charReport?.byClothing && typeof charReport.byClothing === 'object') {
              for (const clothing of Object.values(charReport.byClothing)) {
                if (!clothing) continue;
                clothing.gridImage = keepUrl(clothing.gridImage);
                if (Array.isArray(clothing.gridImages)) {
                  clothing.gridImages = clothing.gridImages.map(keepUrl);
                }
              }
            }
          }
        }
      }
    }
  }

  // coverImages
  if (data.coverImages && typeof data.coverImages === 'object') {
    for (const kind of ['frontCover', 'initialPage', 'backCover']) {
      const cv = data.coverImages[kind];
      if (!cv || typeof cv !== 'object') continue;
      cv.bboxOverlayImage = keepUrl(cv.bboxOverlayImage);
      cv.grokRefImages = filterUrlArray(cv.grokRefImages);
      cv.visualBibleGrid = keepUrl(cv.visualBibleGrid);
      if (Array.isArray(cv.imageVersions)) {
        for (const v of cv.imageVersions) {
          if (!v) continue;
          v.grokRefImages = filterUrlArray(v.grokRefImages);
          v.inpaintReferenceImages = filterUrlArray(v.inpaintReferenceImages);
          v.bboxOverlayImage = keepUrl(v.bboxOverlayImage);
        }
      }
      if (Array.isArray(cv.retryHistory)) {
        for (const r of cv.retryHistory) {
          if (!r) continue;
          r.imageData = undefined;
          r.bboxOverlayImage = keepUrl(r.bboxOverlayImage);
          r.originalImage = undefined;
          r.annotatedOriginal = undefined;
        }
      }
      if (Array.isArray(cv.referencePhotos)) {
        for (const rp of cv.referencePhotos) {
          if (!rp || typeof rp !== 'object') continue;
          rp.photoUrl = keepUrl(rp.photoUrl);
          rp.originalPhotoUrl = keepUrl(rp.originalPhotoUrl);
        }
      }
      if (Array.isArray(cv.landmarkPhotos)) {
        for (const lp of cv.landmarkPhotos) {
          if (lp && typeof lp === 'object') {
            lp.photoData = undefined;
            lp.photoUrl = keepUrl(lp.photoUrl);
          }
        }
      }
    }
  }

  // visualBible.locations[].referencePhotoData — Wikimedia bytes copied per story
  if (data.visualBible && typeof data.visualBible === 'object'
      && Array.isArray(data.visualBible.locations)) {
    for (const loc of data.visualBible.locations) {
      if (!loc || typeof loc !== 'object') continue;
      loc.referencePhotoData = undefined;
      loc.referencePhotoUrl = keepUrl(loc.referencePhotoUrl);
    }
  }

  // finalChecksReport
  if (data.finalChecksReport && typeof data.finalChecksReport === 'object') {
    const fcr = data.finalChecksReport;
    if (fcr.entity?.grids && Array.isArray(fcr.entity.grids)) {
      for (const g of fcr.entity.grids) if (g) g.gridImage = keepUrl(g.gridImage);
    }
    if (fcr.entity?.characters && typeof fcr.entity.characters === 'object') {
      for (const charReport of Object.values(fcr.entity.characters)) {
        if (charReport?.byClothing && typeof charReport.byClothing === 'object') {
          for (const clothing of Object.values(charReport.byClothing)) {
            if (!clothing) continue;
            clothing.gridImage = keepUrl(clothing.gridImage);
            if (Array.isArray(clothing.gridImages)) {
              clothing.gridImages = clothing.gridImages.map(keepUrl);
            }
          }
        }
      }
    }
    if (fcr.styleConsistency && typeof fcr.styleConsistency === 'object') {
      fcr.styleConsistency.gridImage = keepUrl(fcr.styleConsistency.gridImage);
    }
    if (fcr.entityRepairs && typeof fcr.entityRepairs === 'object') {
      for (const charRepair of Object.values(fcr.entityRepairs)) {
        if (charRepair?.pages && typeof charRepair.pages === 'object') {
          for (const pageRepair of Object.values(charRepair.pages)) {
            if (pageRepair?.comparison && typeof pageRepair.comparison === 'object') {
              for (const k of ['before', 'after', 'grokRawResult', 'blackoutImage', 'blendMask', 'croppedAvatar', 'cutoutSent']) {
                pageRepair.comparison[k] = keepUrl(pageRepair.comparison[k]);
              }
            }
          }
        }
      }
    }
  }

  // styledAvatarGeneration / costumedAvatarGeneration — extract leaves a URL on
  // slot.imageUrl and clears slot.imageData. Strip ensures whatever path didn't
  // make it through extract (R2 outage etc.) gets cleared too.
  for (const arrName of ['styledAvatarGeneration', 'costumedAvatarGeneration']) {
    if (!Array.isArray(data[arrName])) continue;
    for (const e of data[arrName]) {
      if (!e) continue;
      if (e.inputs && typeof e.inputs === 'object') {
        for (const v of Object.values(e.inputs)) {
          if (v && typeof v === 'object') {
            if ('imageData' in v) v.imageData = undefined;
            if ('imageUrl' in v) v.imageUrl = keepUrl(v.imageUrl);
          }
        }
      }
      if (e.output && typeof e.output === 'object') {
        if ('imageData' in e.output) e.output.imageData = undefined;
        if ('imageUrl' in e.output) e.output.imageUrl = keepUrl(e.output.imageUrl);
      }
    }
  }

  // top-level characters snapshot — strip photos and inline avatars
  if (Array.isArray(data.characters)) {
    for (const c of data.characters) stripCharSnapshot(c);
  }
}

/**
 * Save story data with metadata column for fast list queries.
 * Use this instead of raw UPDATE to ensure metadata stays in sync.
 * OPTIMIZED: Extracts images to story_images table for faster queries.
 */
async function saveStoryData(storyId, storyData) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  // Deep clone to avoid modifying original
  const dataForStorage = JSON.parse(JSON.stringify(storyData));
  let imagesSaved = 0;

  // Check if this story already has images in the separate story_images table.
  // If so, DON'T re-save v0 imageData (it would overwrite originals with rehydrated active versions).
  // Only save NEW imageVersions entries and strip all imageData from the blob.
  const hasSeparateImages = await hasStorySeparateImages(storyId);

  // Extract and save scene images to story_images table
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    for (const img of dataForStorage.sceneImages) {
      if (img.imageData) {
        if (!hasSeparateImages) {
          // First-time extraction: save v0 to story_images
          await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
            qualityScore: img.qualityScore ?? img.score,
            generatedAt: img.generatedAt,
            versionIndex: 0
          });
          imagesSaved++;
        }
        // Always strip from blob
        delete img.imageData;
      }
      if (img.imageVersions && Array.isArray(img.imageVersions)) {
        for (let i = 0; i < img.imageVersions.length; i++) {
          const version = img.imageVersions[i];
          if (version.imageData) {
            // Skip versions that were rehydrated from DB (marked by rehydrateStoryImages)
            if (!version._rehydrated) {
              await saveStoryImage(storyId, 'scene', img.pageNumber, version.imageData, {
                qualityScore: version.qualityScore ?? version.score,
                generatedAt: version.generatedAt,
                versionIndex: arrayToDbIndex(i, 'scene')
              });
              imagesSaved++;
            }
            delete version.imageData;
          }
          delete version._rehydrated;
        }
      }

      // Save retry history images to separate table and strip from data blob
      if (img.retryHistory?.length) {
        await saveRetryHistoryImages(storyId, img.pageNumber, img.retryHistory);
        for (const entry of img.retryHistory) {
          delete entry.imageData;
          delete entry.bboxOverlayImage;
          delete entry.originalImage;
          delete entry.annotatedOriginal;
          if (entry.grids) {
            for (const grid of entry.grids) {
              // Handle both property naming conventions
              delete grid.imageData;
              delete grid.repairedImageData;
              delete grid.original;
              delete grid.repaired;
            }
          }
        }
      }
      // Save empty scene image separately and set flag for lazy loading
      if (img.emptySceneImage) {
        await saveStoryImage(storyId, 'empty_scene', img.pageNumber, img.emptySceneImage);
        imagesSaved++;
        img.hasEmptySceneImage = true;
      }
      delete img.originalImage;
      delete img.preEntityRepairImage;
      delete img.emptySceneImage;
    }
  }

  // Extract and save cover images (including versions)
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    // Normalize legacy string covers to object format before saving
    if (dataForStorage.coverImages?.[coverType]) {
      dataForStorage.coverImages[coverType] = normalizeCoverValue(dataForStorage.coverImages[coverType]);
    }
    const coverData = dataForStorage.coverImages?.[coverType];
    if (coverData) {
      if (coverData.imageData) {
        if (!hasSeparateImages) {
          // First-time extraction: save v0 to story_images
          await saveStoryImage(storyId, coverType, null, coverData.imageData, {
            qualityScore: coverData.qualityScore ?? null,
            generatedAt: coverData.generatedAt || null,
            versionIndex: 0
          });
          imagesSaved++;
        }
        // Always strip from blob
        delete coverData.imageData;
      }

      // Also save additional cover versions (imageVersions array)
      if (coverData.imageVersions && Array.isArray(coverData.imageVersions)) {
        for (let i = 0; i < coverData.imageVersions.length; i++) {
          const version = coverData.imageVersions[i];
          if (version.imageData) {
            // Skip versions already saved to DB (rehydrated from DB, or pre-saved by cover regen)
            if (!version._rehydrated && !version._alreadySaved) {
              await saveStoryImage(storyId, coverType, null, version.imageData, {
                qualityScore: version.qualityScore,
                generatedAt: version.createdAt || version.generatedAt,
                versionIndex: arrayToDbIndex(i, coverType)
              });
              imagesSaved++;
            }
            delete version.imageData;
          }
          delete version._rehydrated;
          delete version._alreadySaved;
        }
      }
    }
  }

  // Push every remaining inline image (debug overlays, Grok/inpaint refs,
  // entity grids, repair comparison images, landmark photos, VB-location
  // refs, styled-avatar inputs) up to R2 first, replacing the inline base64
  // with the public R2 URL. The strip below then preserves URLs and clears
  // anything that didn't make the round-trip (R2 outage / unconfigured).
  await extractInlineImagesToR2(storyId, dataForStorage);

  // Strip every other inline base64 payload. Source of truth lives in the
  // characters table, story_images, and R2.
  stripInlineImagesFromStoryData(dataForStorage);

  const metadata = buildStoryMetadata(storyData);
  if (imagesSaved > 0) {
    console.log(`💾 [SAVE] Extracted ${imagesSaved} images to story_images for ${storyId}`);
  }
  await dbQuery(
    'UPDATE stories SET data = $1, metadata = $2 WHERE id = $3',
    [JSON.stringify(dataForStorage), JSON.stringify(metadata), storyId]
  );
}

/**
 * Atomically update a single scene entry in `data->'sceneImages'` using jsonb_set.
 * Avoids the full blob read-modify-write of saveStoryData, preventing race conditions
 * when multiple pages are redone in parallel.
 *
 * Handles imageVersions extraction: saves new versions to story_images table
 * and strips imageData from the blob, just like saveStoryData does.
 *
 * @param {string} storyId - Story ID
 * @param {number} pageNumber - Page number to update
 * @param {object} sceneData - The complete scene object (with imageData/imageVersions)
 */
async function saveScenePageData(storyId, pageNumber, sceneData) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  // Deep clone to avoid modifying caller's object
  const dataForStorage = JSON.parse(JSON.stringify(sceneData));
  let imagesSaved = 0;

  // Extract and save imageVersions to story_images table (same logic as saveStoryData)
  if (dataForStorage.imageVersions && Array.isArray(dataForStorage.imageVersions)) {
    for (let i = 0; i < dataForStorage.imageVersions.length; i++) {
      const version = dataForStorage.imageVersions[i];
      if (version.imageData && !version._rehydrated) {
        await saveStoryImage(storyId, 'scene', pageNumber, version.imageData, {
          qualityScore: version.qualityScore ?? version.score,
          generatedAt: version.generatedAt,
          versionIndex: arrayToDbIndex(i, 'scene')
        });
        imagesSaved++;
      }
      delete version.imageData;
      delete version._rehydrated;
    }
  }

  // Strip top-level imageData (already in story_images at version_index 0)
  delete dataForStorage.imageData;

  // Strip retry history images
  if (dataForStorage.retryHistory) {
    for (const entry of dataForStorage.retryHistory) {
      delete entry.imageData;
      delete entry.bboxOverlayImage;
      delete entry.originalImage;
      delete entry.annotatedOriginal;
      if (entry.grids) {
        for (const grid of entry.grids) {
          delete grid.imageData;
          delete grid.repairedImageData;
          delete grid.original;
          delete grid.repaired;
        }
      }
    }
  }
  delete dataForStorage.originalImage;

  // Save empty scene image if present (same as saveStoryData)
  if (dataForStorage.emptySceneImage) {
    await saveStoryImage(storyId, 'empty_scene', pageNumber, dataForStorage.emptySceneImage);
    imagesSaved++;
    dataForStorage.hasEmptySceneImage = true;
  }
  delete dataForStorage.emptySceneImage;

  // Push every remaining inline image to R2 first (Grok/inpaint refs,
  // entity grids, debug overlays, landmark photos), replacing inline
  // base64 with the R2 URL. Then strip preserves URLs and clears anything
  // that didn't upload successfully. Same flow as saveStoryData.
  // The data in scope here is a single sceneImages entry, so we wrap it
  // in the shape both walkers expect.
  const wrappedForExtract = { sceneImages: [dataForStorage] };
  await extractInlineImagesToR2(storyId, wrappedForExtract);
  stripInlineImagesFromStoryData(wrappedForExtract);

  if (imagesSaved > 0) {
    console.log(`💾 [SAVE-SCENE] Extracted ${imagesSaved} images to story_images for ${storyId} page ${pageNumber}`);
  }

  // Atomically update just this scene entry in the sceneImages array using jsonb_set.
  // The subquery finds the array index of the matching pageNumber.
  // Only updates if the page exists in the array (WHERE clause checks existence).
  const result = await dbQuery(
    `UPDATE stories
     SET data = jsonb_set(
       data,
       ('{sceneImages,' || (
         SELECT (ordinality - 1)::text
         FROM jsonb_array_elements(data->'sceneImages') WITH ORDINALITY AS elem(val, ordinality)
         WHERE (val->>'pageNumber')::int = $2
         LIMIT 1
       ) || '}')::text[],
       $3::jsonb
     )
     WHERE id = $1
       AND EXISTS (
         SELECT 1
         FROM jsonb_array_elements(data->'sceneImages') AS elem(val)
         WHERE (val->>'pageNumber')::int = $2
       )`,
    [storyId, pageNumber, JSON.stringify(dataForStorage)]
  );

  if ((result.rowCount ?? 0) === 0) {
    console.warn(`⚠️ [SAVE-SCENE] Page ${pageNumber} not found in sceneImages for story ${storyId}, falling back to full save`);
    return false; // Signal caller to fall back to saveStoryData
  }
  return true;
}

/**
 * Update story data metadata only (without re-saving images).
 * Use this for lightweight updates like changing isActive flags.
 * Images are stripped from the data but NOT re-saved to story_images.
 */
async function updateStoryDataOnly(storyId, storyData) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  // Deep clone to avoid modifying original
  const dataForStorage = JSON.parse(JSON.stringify(storyData));
  let imagesSaved = 0;

  // Strip imageData from scenes (but don't save them - they're already in story_images)
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    for (const img of dataForStorage.sceneImages) {
      delete img.imageData;
      if (img.imageVersions && Array.isArray(img.imageVersions)) {
        for (const version of img.imageVersions) {
          delete version.imageData;
          delete version._rehydrated;
        }
      }
      // Strip retry history images (they're already in story_retry_images)
      if (img.retryHistory) {
        for (const entry of img.retryHistory) {
          delete entry.imageData;
          delete entry.bboxOverlayImage;
          delete entry.originalImage;
          delete entry.annotatedOriginal;
          if (entry.grids) {
            for (const grid of entry.grids) {
              // Handle both property naming conventions
              delete grid.imageData;
              delete grid.repairedImageData;
              delete grid.original;
              delete grid.repaired;
            }
          }
        }
      }
      // Save empty scene image separately and set flag for lazy loading
      if (img.emptySceneImage) {
        await saveStoryImage(storyId, 'empty_scene', img.pageNumber, img.emptySceneImage);
        imagesSaved++;
        img.hasEmptySceneImage = true;
      }
      delete img.originalImage;
      delete img.preEntityRepairImage;
      delete img.emptySceneImage;
    }
  }

  // Strip cover images (normalize to object format first)
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    if (dataForStorage.coverImages?.[coverType]) {
      dataForStorage.coverImages[coverType] = normalizeCoverValue(dataForStorage.coverImages[coverType]);
      // Save main cover imageData to story_images
      if (dataForStorage.coverImages[coverType].imageData) {
        await saveStoryImage(storyId, coverType, null, dataForStorage.coverImages[coverType].imageData, {
          qualityScore: dataForStorage.coverImages[coverType].qualityScore,
          generatedAt: dataForStorage.coverImages[coverType].generatedAt,
          versionIndex: 0
        });
        imagesSaved++;
      }
      delete dataForStorage.coverImages[coverType].imageData;
      // Save cover imageVersions to story_images (same as scene versions)
      if (dataForStorage.coverImages[coverType].imageVersions) {
        for (let i = 0; i < dataForStorage.coverImages[coverType].imageVersions.length; i++) {
          const version = dataForStorage.coverImages[coverType].imageVersions[i];
          if (version.imageData && !version._rehydrated) {
            await saveStoryImage(storyId, coverType, null, version.imageData, {
              qualityScore: version.qualityScore ?? version.score,
              generatedAt: version.generatedAt,
              versionIndex: arrayToDbIndex(i, coverType)
            });
            imagesSaved++;
          }
          delete version.imageData;
          delete version._rehydrated;
        }
      }
    }
  }

  const metadata = buildStoryMetadata(storyData);
  await dbQuery(
    'UPDATE stories SET data = $1, metadata = $2 WHERE id = $3',
    [JSON.stringify(dataForStorage), JSON.stringify(metadata), storyId]
  );
}

/**
 * Insert or update story data with metadata.
 * OPTIMIZED: Extracts images to story_images table for faster queries.
 */
async function upsertStory(storyId, userId, storyData) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  // Deep clone to avoid modifying original
  const dataForStorage = JSON.parse(JSON.stringify(storyData));
  let imagesSaved = 0;

  // IMPORTANT: Insert story record FIRST to satisfy foreign key constraint
  // story_images references stories.id, so story must exist before saving images
  const metadata = buildStoryMetadata(storyData);
  console.log(`💾 [UPSERT] Creating/updating story ${storyId} for user ${userId}, title: "${metadata.title}"`);

  const crypto = require('crypto');
  const shareToken = crypto.randomBytes(32).toString('hex');

  await dbQuery(
    `INSERT INTO stories (id, user_id, data, metadata, share_token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       share_token = COALESCE(stories.share_token, EXCLUDED.share_token)`,
    [storyId, userId, JSON.stringify({}), JSON.stringify(metadata), shareToken]
  );

  // Extract and save scene images to story_images table
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    const emptySceneCount = dataForStorage.sceneImages.filter(i => !!i.emptySceneImage).length;
    if (emptySceneCount > 0) console.log(`🎬 [UPSERT] ${emptySceneCount} pages have emptySceneImage data`);
    for (const img of dataForStorage.sceneImages) {
      if (img.imageData) {
        // Save to story_images table
        await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
          qualityScore: img.qualityScore ?? img.score,
          generatedAt: img.generatedAt,
          versionIndex: 0
        });
        imagesSaved++;
        // Remove imageData from storage (keep metadata)
        delete img.imageData;
      }
      // Also save image versions
      if (img.imageVersions && Array.isArray(img.imageVersions)) {
        for (let i = 0; i < img.imageVersions.length; i++) {
          const version = img.imageVersions[i];
          if (version.imageData) {
            await saveStoryImage(storyId, 'scene', img.pageNumber, version.imageData, {
              qualityScore: version.qualityScore ?? version.score,
              generatedAt: version.generatedAt,
              versionIndex: arrayToDbIndex(i, 'scene')
            });
            imagesSaved++;
            delete version.imageData;
          }
        }
      }

      // Save retry history images to separate table and strip from data blob
      if (img.retryHistory?.length) {
        await saveRetryHistoryImages(storyId, img.pageNumber, img.retryHistory);
        for (const entry of img.retryHistory) {
          delete entry.imageData;
          delete entry.bboxOverlayImage;
          delete entry.originalImage;
          delete entry.annotatedOriginal;
          if (entry.grids) {
            for (const grid of entry.grids) {
              // Handle both property naming conventions
              delete grid.imageData;
              delete grid.repairedImageData;
              delete grid.original;
              delete grid.repaired;
            }
          }
        }
      }
      // Save empty scene image separately and set flag for lazy loading (same as saveStoryData)
      if (img.emptySceneImage) {
        await saveStoryImage(storyId, 'empty_scene', img.pageNumber, img.emptySceneImage);
        imagesSaved++;
        img.hasEmptySceneImage = true;
      }
      delete img.originalImage;
      delete img.preEntityRepairImage;
      delete img.emptySceneImage;
    }
  }

  // Extract and save cover images to story_images table
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  console.log(`💾 [UPSERT] Processing covers for ${storyId}: ${Object.keys(dataForStorage.coverImages || {}).join(', ') || 'none'}`);
  for (const coverType of coverTypes) {
    // Normalize legacy string covers to object format
    if (dataForStorage.coverImages?.[coverType]) {
      dataForStorage.coverImages[coverType] = normalizeCoverValue(dataForStorage.coverImages[coverType]);
    }
    const coverData = dataForStorage.coverImages?.[coverType];
    if (coverData) {
      const imageData = coverData.imageData;
      console.log(`💾 [UPSERT] Cover ${coverType}: hasData=${!!imageData}, dataLength=${imageData?.length || 0}, versions=${coverData.imageVersions?.length || 0}`);
      if (imageData) {
        await saveStoryImage(storyId, coverType, null, imageData, {
          qualityScore: coverData.qualityScore ?? null,
          generatedAt: coverData.generatedAt || null,
          versionIndex: 0
        });
        imagesSaved++;
        console.log(`✅ [UPSERT] Saved ${coverType} to story_images (${imageData.length} chars)`);
        delete coverData.imageData;
      }
      // Also save imageVersions (so the version picker can load every variant —
      // original + character-fix + iterate). Order matters: imageVersions[0] is
      // the original, so saving it after the top-level (best) image overwrites
      // v=0 with the original, putting the canonical history into the DB.
      if (coverData.imageVersions && Array.isArray(coverData.imageVersions)) {
        for (let i = 0; i < coverData.imageVersions.length; i++) {
          const version = coverData.imageVersions[i];
          if (version.imageData && !version._rehydrated) {
            await saveStoryImage(storyId, coverType, null, version.imageData, {
              qualityScore: version.qualityScore ?? version.score ?? null,
              generatedAt: version.generatedAt || null,
              versionIndex: arrayToDbIndex(i, coverType)
            });
            imagesSaved++;
          }
          delete version.imageData;
          delete version._rehydrated;
        }
      }
    }
  }

  // Now update the story with full data and final metadata
  const finalMetadata = buildStoryMetadata(storyData); // Use original for metadata (includes image counts)
  console.log(`💾 [UPSERT] Updating story ${storyId} with full data (${imagesSaved} images saved to story_images)`);

  await dbQuery(
    'UPDATE stories SET data = $1, metadata = $2 WHERE id = $3',
    [JSON.stringify(dataForStorage), JSON.stringify(finalMetadata), storyId]
  );

  console.log(`✅ [UPSERT] Story ${storyId} saved successfully`);
}

/**
 * Save a story image to the story_images table.
 * @param {string} storyId - Story ID
 * @param {string} imageType - 'scene', 'frontCover', 'initialPage', 'backCover'
 * @param {number|null} pageNumber - Page number for scene images, null for covers
 * @param {string} imageData - Base64 encoded image data
 * @param {object} options - Additional options (qualityScore, generatedAt, versionIndex)
 */
/**
 * Upload an avatar slot to R2 and return the public URL. Stateless — does
 * NOT update the characters table; caller is responsible for storing the URL
 * on the avatar object alongside (or instead of) the inline base64.
 *
 * Returns null when R2 is not configured or upload fails — caller decides
 * whether to fall back to inline storage.
 *
 * @param {string|number} userId
 * @param {string|number} characterId
 * @param {string} slot           - 'standard' | 'summer' | 'winter'
 * @param {string} imageData      - base64 (with or without data: prefix)
 * @returns {Promise<string|null>} public R2 URL, or null on failure
 */
async function saveAvatarToR2(userId, characterId, slot, imageData) {
  if (!imageData || !userId || !characterId || !slot) return null;
  try {
    const r2 = require('../lib/r2');
    if (!r2.isConfigured()) return null;
    const key = r2.keyForCharacterAvatar(userId, characterId, slot);
    return await r2.uploadImage(imageData, key);
  } catch (err) {
    console.warn(`[R2] saveAvatarToR2 upload skipped (${userId}/${characterId}/${slot}): ${err.message}`);
    return null;
  }
}

/**
 * Upload a styled avatar (per-clothing variant) to R2.
 * Key format: characters/{userId}/{characterId}/avatars/styled/{key}.jpg
 * @param {string|number} userId
 * @param {string|number} characterId
 * @param {string} key            - styled avatar key (e.g. 'medieval', 'modern-summer')
 * @param {string} imageData      - base64
 * @returns {Promise<string|null>}
 */
async function saveStyledAvatarToR2(userId, characterId, key, imageData) {
  if (!imageData || !userId || !characterId || !key) return null;
  try {
    const r2 = require('../lib/r2');
    if (!r2.isConfigured()) return null;
    const r2Key = r2.keyForCharacterStyledAvatar(userId, characterId, key);
    return await r2.uploadImage(imageData, r2Key);
  } catch (err) {
    console.warn(`[R2] saveStyledAvatarToR2 upload skipped (${userId}/${characterId}/${key}): ${err.message}`);
    return null;
  }
}

/**
 * Upload an avatar thumbnail (face or body) for a clothing slot.
 * Key format: characters/{userId}/{characterId}/avatars/thumbs/{kind}-{slot}.jpg
 * @param {string|number} userId
 * @param {string|number} characterId
 * @param {string} kind           - 'face' | 'body'
 * @param {string} slot           - 'standard' | 'summer' | 'winter'
 * @param {string} imageData      - base64
 * @returns {Promise<string|null>}
 */
async function saveAvatarThumbToR2(userId, characterId, kind, slot, imageData) {
  if (!imageData || !userId || !characterId || !kind || !slot) return null;
  try {
    const r2 = require('../lib/r2');
    if (!r2.isConfigured()) return null;
    const key = r2.keyForCharacterThumb(userId, characterId, kind, slot);
    return await r2.uploadImage(imageData, key);
  } catch (err) {
    console.warn(`[R2] saveAvatarThumbToR2 upload skipped (${userId}/${characterId}/${kind}/${slot}): ${err.message}`);
    return null;
  }
}

/**
 * Upload a Visual Bible reference image to R2. Stateless.
 * Key format: stories/{storyId}/vb/{entryId}.jpg
 * @param {string} storyId
 * @param {string} entryId        - VB entry id (e.g. 'ART003', 'CHR012')
 * @param {string} imageData      - base64
 * @returns {Promise<string|null>}
 */
async function saveVbReferenceToR2(storyId, entryId, imageData) {
  if (!imageData || !storyId || !entryId) return null;
  try {
    const r2 = require('../lib/r2');
    if (!r2.isConfigured()) return null;
    const key = r2.keyForVbReference(storyId, entryId);
    return await r2.uploadImage(imageData, key);
  } catch (err) {
    console.warn(`[R2] saveVbReferenceToR2 upload skipped (${storyId}/${entryId}): ${err.message}`);
    return null;
  }
}

async function saveStoryImage(storyId, imageType, pageNumber, imageData, options = {}) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  const { qualityScore = null, generatedAt = null, versionIndex = 0 } = options;

  // Normalize covers to exact A4 aspect at write time — every cover render
  // is the full bleed page, so a 1% Grok drift would show as a misaligned
  // strip in print. Scenes and empty_scenes are NOT normalized: their
  // aspect is owned by the story's layout (advanced/Jugendbuch wants 1:1
  // square + text below; standard wants 3:4 with text overlay). Forcing
  // every scene to A4 here was cropping square scenes into portrait.
  const COVER_A4_TYPES = new Set(['frontCover', 'initialPage', 'backCover']);
  if (imageData && COVER_A4_TYPES.has(imageType)) {
    const { normalizeImageToA4 } = require('../lib/aspectNormalize');
    imageData = await normalizeImageToA4(imageData);
  }

  // R2 write. Once Phase 1 dual-write proved stable, we stopped persisting
  // image_data when R2 has the bytes — the column was eating 200 MB of DB
  // space across rows that had a working image_url. If R2 isn't configured
  // or upload fails, we still fall back to bytes-only so reads don't break.
  let imageUrl = null;
  try {
    const r2 = require('../lib/r2');
    if (r2.isConfigured() && imageData) {
      const key = r2.keyForStoryImage(storyId, imageType, pageNumber, versionIndex);
      imageUrl = await r2.uploadImage(imageData, key);
    }
  } catch (err) {
    // R2 failure is non-fatal — fall back to bytes-only.
    console.warn(`[R2] saveStoryImage upload skipped: ${err.message}`);
  }

  // Only persist image_data when R2 didn't accept the bytes. Otherwise R2 is
  // the source of truth and keeping the inline copy just bloats Postgres.
  const persistedImageData = imageUrl ? null : imageData;

  if (pageNumber == null) {
    // Covers: use partial index ON CONFLICT for NULL page_number
    await dbQuery(
      `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7)
       ON CONFLICT (story_id, image_type, version_index) WHERE page_number IS NULL
       DO UPDATE SET image_data = EXCLUDED.image_data, image_url = EXCLUDED.image_url, quality_score = EXCLUDED.quality_score, generated_at = EXCLUDED.generated_at`,
      [storyId, imageType, versionIndex, persistedImageData, imageUrl, qualityScore, generatedAt]
    );
  } else {
    // Scenes: use partial index ON CONFLICT for non-NULL page_number
    await dbQuery(
      `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, image_url, quality_score, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (story_id, image_type, page_number, version_index) WHERE page_number IS NOT NULL
       DO UPDATE SET image_data = EXCLUDED.image_data, image_url = EXCLUDED.image_url, quality_score = EXCLUDED.quality_score, generated_at = EXCLUDED.generated_at`,
      [storyId, imageType, pageNumber, versionIndex, persistedImageData, imageUrl, qualityScore, generatedAt]
    );
  }
}

/**
 * Get a story image from the story_images table.
 * @param {string} storyId - Story ID
 * @param {string} imageType - 'scene', 'frontCover', 'initialPage', 'backCover'
 * @param {number|null} pageNumber - Page number for scene images, null for covers
 * @param {number} versionIndex - Version index (default 0)
 * @returns {object|null} Image data with metadata or null if not found
 */
async function getStoryImage(storyId, imageType, pageNumber, versionIndex = 0) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  const rows = await dbQuery(
    `SELECT image_data, image_url, quality_score, generated_at FROM story_images
     WHERE story_id = $1 AND image_type = $2 AND page_number IS NOT DISTINCT FROM $3 AND version_index = $4`,
    [storyId, imageType, pageNumber, versionIndex]
  );

  if (rows.length === 0) {
    console.log(`🔍 [GET_IMAGE] No image found: storyId=${storyId}, type=${imageType}, page=${pageNumber}, version=${versionIndex}`);
    return null;
  }

  console.log(`🔍 [GET_IMAGE] Found image: storyId=${storyId}, type=${imageType}, dataLength=${rows[0].image_data?.length || 0}, hasUrl=${!!rows[0].image_url}`);
  return {
    imageData: rows[0].image_data,
    imageUrl: rows[0].image_url,
    qualityScore: rows[0].quality_score,
    generatedAt: rows[0].generated_at
  };
}

/**
 * Get story image with all its versions in a single query (optimized).
 * @param {string} storyId - Story ID
 * @param {string} imageType - 'scene', 'frontCover', 'initialPage', 'backCover'
 * @param {number|null} pageNumber - Page number (null for covers)
 * @returns {object|null} Main image with versions array, or null if not found
 */
async function getStoryImageWithVersions(storyId, imageType, pageNumber) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  const rows = await dbQuery(
    `SELECT version_index, image_data, image_url, quality_score, generated_at FROM story_images
     WHERE story_id = $1 AND image_type = $2 AND page_number IS NOT DISTINCT FROM $3
     ORDER BY version_index`,
    [storyId, imageType, pageNumber]
  );

  if (rows.length === 0) {
    return null;
  }

  // First row (version_index = 0) is the main image
  const mainImage = rows.find(r => r.version_index === 0);
  if (!mainImage) {
    return null;
  }

  // Remaining rows are versions
  const versions = rows
    .filter(r => r.version_index > 0)
    .map(r => ({
      versionIndex: r.version_index,
      imageData: r.image_data,
      imageUrl: r.image_url,
      qualityScore: r.quality_score,
      generatedAt: r.generated_at
    }));

  return {
    imageData: mainImage.image_data,
    imageUrl: mainImage.image_url,
    qualityScore: mainImage.quality_score,
    generatedAt: mainImage.generated_at,
    versions: versions.length > 0 ? versions : undefined
  };
}

/**
 * Get all images for a story (for migration/export purposes).
 * @param {string} storyId - Story ID
 * @returns {array} Array of image records
 */
async function getAllStoryImages(storyId) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  return await dbQuery(
    `SELECT image_type, page_number, version_index, image_data, image_url, quality_score, generated_at
     FROM story_images WHERE story_id = $1 ORDER BY image_type, page_number, version_index`,
    [storyId]
  );
}

/**
 * Get ONLY active images for a story (for fast initial load).
 * Uses image_version_meta to determine which version is active for each page/cover.
 * Returns ~3MB instead of ~53MB by excluding inactive versions.
 * @param {string} storyId - Story ID
 * @returns {array} Array of active image records only
 */
async function getActiveStoryImages(storyId) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  // Single optimized query: join images with active version metadata
  // Uses CTEs for both active versions and version counts to avoid correlated subqueries.
  // Falls back to version_index 0 if the active version doesn't exist in story_images
  // (can happen if activeVersion points to a deleted or never-saved version row).
  const results = await dbQuery(
    `WITH active_versions AS (
      SELECT
        key as page_key,
        COALESCE((value->>'activeVersion')::int, 0) as active_version
      FROM stories, jsonb_each(COALESCE(image_version_meta, '{}'))
      WHERE id = $1
    ),
    version_counts AS (
      SELECT story_id, image_type, page_number, COUNT(*) as version_count
      FROM story_images
      WHERE story_id = $1
      GROUP BY story_id, image_type, page_number
    ),
    target_versions AS (
      SELECT
        si.story_id, si.image_type, si.page_number,
        COALESCE(av.active_version, 0) as requested_version,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM story_images si2
            WHERE si2.story_id = si.story_id
              AND si2.image_type = si.image_type
              AND si2.page_number IS NOT DISTINCT FROM si.page_number
              AND si2.version_index = COALESCE(av.active_version, 0)
          ) THEN COALESCE(av.active_version, 0)
          ELSE 0
        END as effective_version
      FROM (
        SELECT DISTINCT story_id, image_type, page_number
        FROM story_images WHERE story_id = $1
      ) si
      LEFT JOIN active_versions av ON (
        (si.image_type = 'scene' AND av.page_key = si.page_number::text) OR
        (si.image_type != 'scene' AND av.page_key = si.image_type)
      )
    )
    SELECT si.image_type, si.page_number, si.version_index, si.image_data, si.image_url, si.quality_score, si.generated_at,
           COALESCE(vc.version_count, 1) as version_count
    FROM story_images si
    JOIN target_versions tv ON (
      tv.story_id = si.story_id
      AND tv.image_type = si.image_type
      AND tv.page_number IS NOT DISTINCT FROM si.page_number
      AND si.version_index = tv.effective_version
    )
    LEFT JOIN version_counts vc ON (
      vc.story_id = si.story_id
      AND vc.image_type = si.image_type
      AND vc.page_number IS NOT DISTINCT FROM si.page_number
    )
    WHERE si.story_id = $1
    ORDER BY si.image_type, si.page_number`,
    [storyId]
  );

  return results;
}

/**
 * Check if a story has images in the new table.
 * @param {string} storyId - Story ID
 * @returns {boolean} True if images exist in new table
 */
async function hasStorySeparateImages(storyId) {
  if (!isDatabaseMode()) {
    return false;
  }

  const rows = await dbQuery(
    'SELECT 1 FROM story_images WHERE story_id = $1 LIMIT 1',
    [storyId]
  );

  return rows.length > 0;
}

/**
 * Delete all images for a story.
 * @param {string} storyId - Story ID
 */
async function deleteStoryImages(storyId) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  await dbQuery('DELETE FROM story_images WHERE story_id = $1', [storyId]);
}

// ============================================
// ACTIVE IMAGE VERSION FUNCTIONS
// ============================================

/**
 * Get active version for a page from image_version_meta column.
 * Falls back to data.sceneImages for backwards compatibility.
 * @param {string} storyId - Story ID
 * @param {number|string} pageNumber - Page number or cover type
 * @returns {Promise<number>} Active version index (0-based)
 */
/**
 * Fast existence check for a set of image types on a story.
 * Returns a Set of imageType strings that have at least one row with usable
 * data (image_data OR image_url present). Single round-trip, no blob fetch.
 *
 * Use this instead of looping getActiveVersion + getStoryImage when you only
 * need a yes/no flag — the latter pulls multi-MB byteas just to see existence.
 *
 * @param {string} storyId
 * @param {string[]} imageTypes - e.g. ['frontCover', 'initialPage', 'backCover']
 * @returns {Promise<Set<string>>}
 */
async function imagesExistByType(storyId, imageTypes) {
  if (!isDatabaseMode() || !Array.isArray(imageTypes) || imageTypes.length === 0) {
    return new Set();
  }
  const rows = await dbQuery(
    `SELECT DISTINCT image_type FROM story_images
     WHERE story_id = $1
       AND image_type = ANY($2::text[])
       AND (image_data IS NOT NULL OR image_url IS NOT NULL)`,
    [storyId, imageTypes]
  );
  return new Set(rows.map(r => r.image_type));
}

async function getActiveVersion(storyId, pageNumber) {
  if (!isDatabaseMode()) {
    return 0;
  }

  const pageKey = pageNumber.toString();

  // Try new column first (fast path)
  const metaRows = await dbQuery(
    `SELECT image_version_meta->$1 as meta FROM stories WHERE id = $2`,
    [pageKey, storyId]
  );

  if (metaRows.length > 0 && metaRows[0].meta?.activeVersion !== undefined) {
    return metaRows[0].meta.activeVersion;
  }

  // Fall back to data.sceneImages for backwards compatibility
  const dataRows = await dbQuery(
    `SELECT data->'sceneImages' as scene_images FROM stories WHERE id = $1`,
    [storyId]
  );

  if (dataRows.length > 0 && dataRows[0].scene_images) {
    const pageNum = parseInt(pageNumber);
    const scene = dataRows[0].scene_images.find(s => s.pageNumber === pageNum);
    if (scene?.imageVersions) {
      const activeIdx = scene.imageVersions.findIndex(v => v.isActive);
      if (activeIdx >= 0) {
        // Convert array index to DB version_index (what setActiveVersion stores)
        const pageNum = parseInt(pageNumber);
        const imageType = isNaN(pageNum) ? pageNumber : 'scene';
        return arrayToDbIndex(activeIdx, imageType);
      }
      return 0;
    }
  }

  return 0;
}

/**
 * Set active version for a page in image_version_meta column.
 * Uses jsonb_set for O(1) targeted update instead of full data blob rewrite.
 * @param {string} storyId - Story ID
 * @param {number|string} pageNumber - Page number or cover type
 * @param {number} versionIndex - Version index to set as active (0-based)
 */
async function setActiveVersion(storyId, pageNumber, versionIndex) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  const pageKey = pageNumber.toString();

  // Single targeted update using jsonb_set (~1ms vs 6+ seconds)
  await dbQuery(
    `UPDATE stories
     SET image_version_meta = jsonb_set(
       COALESCE(image_version_meta, '{}')::jsonb,
       $1::text[],
       $2::jsonb
     )
     WHERE id = $3`,
    [[pageKey], JSON.stringify({ activeVersion: versionIndex }), storyId]
  );
}

/**
 * Get all active versions for a story from image_version_meta column.
 * @param {string} storyId - Story ID
 * @returns {Promise<object>} Map of pageNumber -> activeVersion
 */
async function getAllActiveVersions(storyId) {
  if (!isDatabaseMode()) {
    return {};
  }

  const rows = await dbQuery(
    `SELECT image_version_meta FROM stories WHERE id = $1`,
    [storyId]
  );

  if (rows.length === 0 || !rows[0].image_version_meta) {
    return {};
  }

  // Convert to simpler format: { "1": 0, "2": 2 }
  const result = {};
  for (const [pageKey, meta] of Object.entries(rows[0].image_version_meta)) {
    result[pageKey] = meta.activeVersion ?? 0;
  }
  return result;
}

/**
 * Rehydrate story data by loading images from story_images table back into the data blob.
 * Used by PDF generation, regeneration endpoints, etc.
 * @param {string} storyId - Story ID
 * @param {object} storyData - Parsed story data blob (sceneImages, coverImages, etc.)
 * @param {object} options - Options
 * @param {boolean} options.activeOnly - If true, only load the active version per page (fast path).
 *   Default: true. Set to false only when you need ALL version imageData (e.g., version picker).
 * @returns {object} storyData with imageData populated from story_images table
 */
async function rehydrateStoryImages(storyId, storyData, { activeOnly = true } = {}) {
  if (!isDatabaseMode() || !storyData) return storyData;

  const hasSeparate = await hasStorySeparateImages(storyId);
  if (!hasSeparate) return storyData; // Images still inline in data blob

  if (activeOnly) {
    // Fast path: single optimized query returns only the active image per page/cover
    const activeImages = await getActiveStoryImages(storyId);

    // Populate sceneImages with active image only — fetch bytes from R2 in
    // parallel when the row is URL-only so byte-consumers (repair, sharp
    // metadata, semantic eval) get base64 like before the migration.
    if (storyData.sceneImages) {
      await Promise.all(storyData.sceneImages.map(async (scene) => {
        if (!scene.imageData) {
          const img = activeImages.find(i => i.image_type === 'scene' && i.page_number === scene.pageNumber);
          if (img) scene.imageData = await imgBytesAsync(img);
        }
        const activeV = scene.imageVersions?.find(v => v.isActive);
        if (activeV?.bboxDetection) {
          scene.bboxDetection = activeV.bboxDetection;
        }
      }));
    }

    // Populate coverImages with active image only
    if (storyData.coverImages) {
      await Promise.all(['frontCover', 'backCover', 'initialPage'].map(async (coverType) => {
        storyData.coverImages[coverType] = normalizeCoverValue(storyData.coverImages[coverType]);
        const cover = storyData.coverImages[coverType];
        if (cover && !getCoverData(cover)) {
          const img = activeImages.find(i => i.image_type === coverType);
          if (img) cover.imageData = await imgBytesAsync(img);
        }
      }));
    }

    return storyData;
  }

  // Full path: load ALL versions (for version picker / full rehydration)
  const allVersionImages = await dbQuery(
    `SELECT image_type, page_number, version_index, image_data, image_url
     FROM story_images WHERE story_id = $1
     ORDER BY page_number, version_index`,
    [storyId]
  );

  // Load active versions from image_version_meta
  const metaResult = await dbQuery('SELECT image_version_meta FROM stories WHERE id = $1', [storyId]);
  const versionMeta = metaResult[0]?.image_version_meta || {};

  // Build a map of active overrides (keyed by "type:page" or "type:null" for covers).
  // This avoids mutating the v0 entries in the images array, which would cause
  // saveStoryData to overwrite the original v0 with the active version's data.
  const activeOverrides = {};
  const coverTypes = ['frontCover', 'backCover', 'initialPage'];
  await Promise.all(Object.entries(versionMeta).map(async ([key, meta]) => {
    if (meta.activeVersion && meta.activeVersion > 0) {
      const isCover = coverTypes.includes(key);
      const activeImg = isCover
        ? allVersionImages.find(i => i.image_type === key && i.page_number == null && i.version_index === meta.activeVersion)
        : allVersionImages.find(i => i.image_type === 'scene' && i.page_number === parseInt(key) && i.version_index === meta.activeVersion);
      if (activeImg) {
        const overrideKey = isCover ? `${key}:null` : `scene:${parseInt(key)}`;
        activeOverrides[overrideKey] = await imgBytesAsync(activeImg);
      }
    }
  }));

  // Populate sceneImages
  if (storyData.sceneImages) {
    await Promise.all(storyData.sceneImages.map(async (scene) => {
      if (!scene.imageData) {
        const overrideKey = `scene:${scene.pageNumber}`;
        if (activeOverrides[overrideKey]) {
          scene.imageData = activeOverrides[overrideKey];
        } else {
          const img = allVersionImages.find(i => i.image_type === 'scene' && i.page_number === scene.pageNumber && i.version_index === 0);
          if (img) scene.imageData = await imgBytesAsync(img);
        }
      }

      if (scene.imageVersions && scene.imageVersions.length > 0) {
        await Promise.all(scene.imageVersions.map(async (version, vIdx) => {
          if (!version.imageData) {
            const dbVersionIndex = arrayToDbIndex(vIdx, 'scene');
            const versionImg = allVersionImages.find(
              i => i.image_type === 'scene' && i.page_number === scene.pageNumber && i.version_index === dbVersionIndex
            );
            if (versionImg) {
              version.imageData = await imgBytesAsync(versionImg);
              version._rehydrated = true;
            }
          }
        }));
      }

      const activeV = scene.imageVersions?.find(v => v.isActive);
      if (activeV?.bboxDetection) {
        scene.bboxDetection = activeV.bboxDetection;
      }
    }));
  }

  // Populate coverImages
  if (storyData.coverImages) {
    await Promise.all(coverTypes.map(async (coverType) => {
      storyData.coverImages[coverType] = normalizeCoverValue(storyData.coverImages[coverType]);
      const cover = storyData.coverImages[coverType];

      if (cover && !getCoverData(cover)) {
        const overrideKey = `${coverType}:null`;
        if (activeOverrides[overrideKey]) {
          cover.imageData = activeOverrides[overrideKey];
        } else {
          const img = allVersionImages.find(i => i.image_type === coverType && i.version_index === 0);
          if (img) cover.imageData = await imgBytesAsync(img);
        }
      }

      if (cover && cover.imageVersions && cover.imageVersions.length > 0) {
        await Promise.all(cover.imageVersions.map(async (version, vIdx) => {
          if (!version.imageData) {
            const dbVersionIndex = arrayToDbIndex(vIdx, coverType);
            const versionImg = allVersionImages.find(
              i => i.image_type === coverType && i.version_index === dbVersionIndex
            );
            if (versionImg) {
              version.imageData = await imgBytesAsync(versionImg);
              version._rehydrated = true;
            }
          }
        }));
      }
    }));
  }

  return storyData;
}

function getCoverData(cover) {
  if (!cover) return null;
  if (cover.imageData) return cover.imageData;
  return null;
}

/**
 * Normalize a cover value to always be an object { imageData, ... } or null.
 * Handles legacy string format (just base64 data) and converts it.
 */
function normalizeCoverValue(cover) {
  if (!cover) return null;
  if (typeof cover === 'string') return { imageData: cover };
  return cover;
}

// ============================================
// RETRY HISTORY IMAGE FUNCTIONS
// ============================================

/**
 * Save retry history images to a separate table.
 * This keeps the main data blob small for fast /metadata queries.
 * @param {string} storyId - Story ID
 * @param {number} pageNumber - Page number
 * @param {array} retryHistory - Array of retry history entries
 */
async function saveRetryHistoryImages(storyId, pageNumber, retryHistory) {
  if (!isDatabaseMode() || !retryHistory?.length) return;

  // Single insert helper: handles R2 dual-write + DB upsert. R2 upload is best-
  // effort (logs and returns null on failure); inline bytes always get stored.
  const r2 = require('./../lib/r2');
  const insertOne = async (retryIdx, imageType, data, gridIdx = null) => {
    if (!data) return;
    let imageUrl = null;
    if (r2.isConfigured()) {
      try {
        const key = r2.keyForRetryImage(storyId, pageNumber, retryIdx, imageType, gridIdx);
        imageUrl = await r2.uploadImage(data, key);
      } catch (err) {
        console.warn(`[R2] retry-image upload skipped: ${err.message}`);
      }
    }
    const persistedData = imageUrl ? null : data;
    await dbQuery(
      `INSERT INTO story_retry_images (story_id, page_number, retry_index, image_type, grid_index, image_data, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))
       DO UPDATE SET image_data = EXCLUDED.image_data, image_url = EXCLUDED.image_url`,
      [storyId, pageNumber, retryIdx, imageType, gridIdx, persistedData, imageUrl]
    );
  };

  for (let retryIdx = 0; retryIdx < retryHistory.length; retryIdx++) {
    const entry = retryHistory[retryIdx];
    await insertOne(retryIdx, 'attempt',          entry.imageData);
    await insertOne(retryIdx, 'bboxOverlay',      entry.bboxOverlayImage);
    await insertOne(retryIdx, 'original',         entry.originalImage);
    await insertOne(retryIdx, 'annotatedOriginal',entry.annotatedOriginal);

    if (entry.grids?.length) {
      for (let gridIdx = 0; gridIdx < entry.grids.length; gridIdx++) {
        const grid = entry.grids[gridIdx];
        // Handle both naming conventions: original/repaired (backend) and imageData/repairedImageData
        const originalData = grid.original || grid.imageData;
        const repairedData = grid.repaired || grid.repairedImageData;
        await insertOne(retryIdx, 'grid',         originalData, gridIdx);
        await insertOne(retryIdx, 'gridRepaired', repairedData, gridIdx);
      }
    }
  }
}

/**
 * Get retry history images from the separate table.
 * Used for lazy-loading retry images in dev mode.
 * @param {string} storyId - Story ID
 * @param {number} pageNumber - Page number
 * @returns {array} Reconstructed retry history with images
 */
async function getRetryHistoryImages(storyId, pageNumber) {
  if (!isDatabaseMode()) return [];

  const rows = await dbQuery(
    `SELECT retry_index, image_type, grid_index, image_data
     FROM story_retry_images
     WHERE story_id = $1 AND page_number = $2
     ORDER BY retry_index, image_type, grid_index`,
    [storyId, pageNumber]
  );

  if (rows.length === 0) return [];

  // Reconstruct retryHistory structure preserving original indices
  // Important: retry_index must be preserved because the UI looks up images by index
  // e.g., if entries exist at indices 0 and 2 (but not 1), we need result[2] to work
  const result = [];
  for (const row of rows) {
    const idx = row.retry_index;
    if (!result[idx]) {
      result[idx] = { grids: [] };
    }
    const entry = result[idx];

    switch (row.image_type) {
      case 'attempt': entry.imageData = row.image_data; break;
      case 'bboxOverlay': entry.bboxOverlayImage = row.image_data; break;
      case 'original': entry.originalImage = row.image_data; break;
      case 'annotatedOriginal': entry.annotatedOriginal = row.image_data; break;
      case 'grid':
        entry.grids[row.grid_index] = entry.grids[row.grid_index] || {};
        // Use both property names for compatibility
        entry.grids[row.grid_index].original = row.image_data;
        entry.grids[row.grid_index].imageData = row.image_data;
        break;
      case 'gridRepaired':
        entry.grids[row.grid_index] = entry.grids[row.grid_index] || {};
        // Use both property names for compatibility
        entry.grids[row.grid_index].repaired = row.image_data;
        entry.grids[row.grid_index].repairedImageData = row.image_data;
        break;
    }
  }

  return result;
}

// ============================================
// STYLE LAB IMAGE FUNCTIONS
// ============================================

/**
 * Save a style lab image (upsert by story_id, page_number, run_id, model_id).
 */
async function saveStyleLabImage(storyId, pageNumber, runId, modelId, imageData, thumbnail, stylePrompt, elapsedMs) {
  if (!isDatabaseMode()) return;

  // R2 dual-write — best effort, falls back to bytes-only on any failure.
  let imageUrl = null;
  try {
    const r2 = require('../lib/r2');
    if (r2.isConfigured() && imageData) {
      const key = r2.keyForStyleLabImage(storyId, pageNumber, runId, modelId);
      imageUrl = await r2.uploadImage(imageData, key);
    }
  } catch (err) {
    console.warn(`[R2] style-lab upload skipped: ${err.message}`);
  }

  const persistedImageData = imageUrl ? null : imageData;
  await dbQuery(
    `INSERT INTO style_lab_images (story_id, page_number, run_id, model_id, image_data, image_url, thumbnail, style_prompt, elapsed_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (story_id, page_number, run_id, model_id)
     DO UPDATE SET image_data = EXCLUDED.image_data, image_url = EXCLUDED.image_url,
                   thumbnail = EXCLUDED.thumbnail,
                   style_prompt = EXCLUDED.style_prompt, elapsed_ms = EXCLUDED.elapsed_ms,
                   created_at = CURRENT_TIMESTAMP`,
    [storyId, pageNumber, runId, modelId, persistedImageData, imageUrl, thumbnail, stylePrompt, elapsedMs]
  );
}

/**
 * Get all style lab thumbnails for a page (for history strip).
 * Returns rows with run_id, model_id, thumbnail, style_prompt, elapsed_ms, created_at.
 */
async function getStyleLabThumbnails(storyId, pageNumber) {
  if (!isDatabaseMode()) return [];
  return await dbQuery(
    `SELECT run_id, model_id, thumbnail, style_prompt, elapsed_ms, created_at
     FROM style_lab_images
     WHERE story_id = $1 AND page_number = $2
     ORDER BY created_at DESC
     LIMIT 200`,
    [storyId, pageNumber]
  );
}

/**
 * Get full images for a specific style lab run (lazy load on expand).
 */
async function getStyleLabRunImages(storyId, pageNumber, runId) {
  if (!isDatabaseMode()) return [];
  return await dbQuery(
    `SELECT model_id, image_data, style_prompt, elapsed_ms, created_at
     FROM style_lab_images
     WHERE story_id = $1 AND page_number = $2 AND run_id = $3
     ORDER BY model_id`,
    [storyId, pageNumber, runId]
  );
}

module.exports = {
  initializePool,
  initializeDatabase,
  dbQuery,
  getPool,
  closePool,
  isDatabaseMode,
  logActivity,
  buildStoryMetadata,
  saveStoryData,
  saveScenePageData,
  stripInlineImagesFromStoryData,
  extractInlineImagesToR2,
  updateStoryDataOnly,
  upsertStory,
  // Image functions
  saveStoryImage,
  getStoryImage,
  imagesExistByType,
  imgBytesAsync,
  saveAvatarToR2,
  saveStyledAvatarToR2,
  saveAvatarThumbToR2,
  saveVbReferenceToR2,
  getStoryImageWithVersions,
  getAllStoryImages,
  getActiveStoryImages,
  hasStorySeparateImages,
  deleteStoryImages,
  rehydrateStoryImages,
  // Active version functions
  getActiveVersion,
  setActiveVersion,
  getAllActiveVersions,
  // Retry history image functions
  saveRetryHistoryImages,
  getRetryHistoryImages,
  // Style Lab image functions
  saveStyleLabImage,
  getStyleLabThumbnails,
  getStyleLabRunImages,
  // Exposed for testing
  normalizeCoverValue,
  getCoverData
};
