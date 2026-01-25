// Database Service - PostgreSQL connection and query utilities
const { Pool } = require('pg');

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
    ];

    for (const { table, column, type } of columnsToAdd) {
      await dbPool.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='${table}' AND column_name='${column}') THEN
            ALTER TABLE ${table} ADD COLUMN ${column} ${type};
          END IF;
        END $$;
      `);
    }

    // Update existing users with NULL credits
    await dbPool.query(`UPDATE users SET credits = -1 WHERE credits IS NULL AND role = 'admin'`);
    await dbPool.query(`UPDATE users SET credits = 1000 WHERE credits IS NULL AND role = 'user'`);
    await dbPool.query(`UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL`);
    // Set existing users as having consented to photo uploads (retroactive consent)
    await dbPool.query(`UPDATE users SET photo_consent_at = CURRENT_TIMESTAMP WHERE photo_consent_at IS NULL`);

    // Config table
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS config (
        id SERIAL PRIMARY KEY,
        config_key VARCHAR(255) UNIQUE NOT NULL,
        config_value TEXT
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

    // Seed default pricing tiers if table is empty
    const pricingCheck = await dbPool.query('SELECT COUNT(*) as count FROM pricing_tiers');
    if (parseInt(pricingCheck[0].count) === 0) {
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
  const hasThumbnail = !!(
    story.coverImages?.frontCover?.imageData ||
    story.coverImages?.frontCover ||
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
  };
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

  // Extract and save scene images to story_images table
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    for (const img of dataForStorage.sceneImages) {
      if (img.imageData) {
        await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
          qualityScore: img.qualityScore || img.score,
          generatedAt: img.generatedAt,
          versionIndex: 0
        });
        imagesSaved++;
        delete img.imageData;
      }
      if (img.imageVersions && Array.isArray(img.imageVersions)) {
        for (let i = 0; i < img.imageVersions.length; i++) {
          const version = img.imageVersions[i];
          if (version.imageData) {
            await saveStoryImage(storyId, 'scene', img.pageNumber, version.imageData, {
              qualityScore: version.qualityScore || version.score,
              generatedAt: version.generatedAt,
              versionIndex: i + 1
            });
            imagesSaved++;
            delete version.imageData;
          }
        }
      }
    }
  }

  // Extract and save cover images
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    const coverData = dataForStorage.coverImages?.[coverType];
    if (coverData) {
      const imageData = typeof coverData === 'string' ? coverData : coverData.imageData;
      if (imageData) {
        await saveStoryImage(storyId, coverType, null, imageData, {
          qualityScore: typeof coverData === 'object' ? coverData.qualityScore : null,
          generatedAt: typeof coverData === 'object' ? coverData.generatedAt : null,
          versionIndex: 0
        });
        imagesSaved++;
        if (typeof coverData === 'object') {
          delete coverData.imageData;
        } else {
          dataForStorage.coverImages[coverType] = { stripped: true };
        }
      }
    }
  }

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

  // Strip imageData from scenes (but don't save them - they're already in story_images)
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    for (const img of dataForStorage.sceneImages) {
      delete img.imageData;
      if (img.imageVersions && Array.isArray(img.imageVersions)) {
        for (const version of img.imageVersions) {
          delete version.imageData;
        }
      }
    }
  }

  // Strip cover images
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    const coverData = dataForStorage.coverImages?.[coverType];
    if (coverData) {
      if (typeof coverData === 'object') {
        delete coverData.imageData;
      } else if (typeof coverData === 'string') {
        dataForStorage.coverImages[coverType] = { stripped: true };
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

  await dbQuery(
    'INSERT INTO stories (id, user_id, data, metadata) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id',
    [storyId, userId, JSON.stringify({}), JSON.stringify(metadata)]
  );

  // Extract and save scene images to story_images table
  if (dataForStorage.sceneImages && Array.isArray(dataForStorage.sceneImages)) {
    for (const img of dataForStorage.sceneImages) {
      if (img.imageData) {
        // Save to story_images table
        await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
          qualityScore: img.qualityScore || img.score,
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
              qualityScore: version.qualityScore || version.score,
              generatedAt: version.generatedAt,
              versionIndex: i + 1
            });
            imagesSaved++;
            delete version.imageData;
          }
        }
      }
    }
  }

  // Extract and save cover images to story_images table
  const coverTypes = ['frontCover', 'initialPage', 'backCover'];
  for (const coverType of coverTypes) {
    const coverData = dataForStorage.coverImages?.[coverType];
    if (coverData) {
      const imageData = typeof coverData === 'string' ? coverData : coverData.imageData;
      if (imageData) {
        await saveStoryImage(storyId, coverType, null, imageData, {
          qualityScore: typeof coverData === 'object' ? coverData.qualityScore : null,
          generatedAt: typeof coverData === 'object' ? coverData.generatedAt : null,
          versionIndex: 0
        });
        imagesSaved++;
        // Remove imageData from storage (keep metadata for object type)
        if (typeof coverData === 'object') {
          delete coverData.imageData;
        } else {
          // For string-only cover data, replace with placeholder
          dataForStorage.coverImages[coverType] = { stripped: true };
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
async function saveStoryImage(storyId, imageType, pageNumber, imageData, options = {}) {
  if (!isDatabaseMode()) {
    throw new Error('Database mode required');
  }

  const { qualityScore = null, generatedAt = null, versionIndex = 0 } = options;

  await dbQuery(
    `INSERT INTO story_images (story_id, image_type, page_number, version_index, image_data, quality_score, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (story_id, image_type, page_number, version_index)
     DO UPDATE SET image_data = EXCLUDED.image_data, quality_score = EXCLUDED.quality_score, generated_at = EXCLUDED.generated_at`,
    [storyId, imageType, pageNumber, versionIndex, imageData, qualityScore, generatedAt]
  );
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
    `SELECT image_data, quality_score, generated_at FROM story_images
     WHERE story_id = $1 AND image_type = $2 AND page_number IS NOT DISTINCT FROM $3 AND version_index = $4`,
    [storyId, imageType, pageNumber, versionIndex]
  );

  if (rows.length === 0) {
    return null;
  }

  return {
    imageData: rows[0].image_data,
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
    `SELECT version_index, image_data, quality_score, generated_at FROM story_images
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
      imageData: r.image_data,
      qualityScore: r.quality_score,
      generatedAt: r.generated_at
    }));

  return {
    imageData: mainImage.image_data,
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
    `SELECT image_type, page_number, version_index, image_data, quality_score, generated_at
     FROM story_images WHERE story_id = $1 ORDER BY image_type, page_number, version_index`,
    [storyId]
  );
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
  updateStoryDataOnly,
  upsertStory,
  // Image functions
  saveStoryImage,
  getStoryImage,
  getStoryImageWithVersions,
  getAllStoryImages,
  hasStorySeparateImages,
  deleteStoryImages
};
