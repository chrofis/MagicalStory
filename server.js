// MagicalStory Backend Server v1.0.2
// Includes: User quota system, email authentication, admin panel, MySQL database support
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const path = require('path');
const mysql = require('mysql2/promise');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';

// Detect database type: PostgreSQL (Railway) or MySQL (IONOS)
const DATABASE_URL = process.env.DATABASE_URL; // Railway PostgreSQL
const DB_TYPE = DATABASE_URL ? 'postgresql' : 'mysql';

// Debug logging
console.log('🔍 Environment Check:');
console.log(`  DATABASE_URL: ${DATABASE_URL ? 'SET (length: ' + DATABASE_URL.length + ')' : 'NOT SET'}`);
console.log(`  STORAGE_MODE: ${process.env.STORAGE_MODE}`);
console.log(`  DB_HOST: ${process.env.DB_HOST || 'NOT SET'}`);
console.log(`  DB_USER: ${process.env.DB_USER || 'NOT SET'}`);
console.log(`  GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET (length: ' + process.env.GEMINI_API_KEY.length + ')' : 'NOT SET'}`);
console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET (length: ' + process.env.ANTHROPIC_API_KEY.length + ')' : 'NOT SET'}`);

// Default to file mode for safety - only use database if explicitly configured AND credentials exist
const STORAGE_MODE = (process.env.STORAGE_MODE === 'database' &&
                     (DATABASE_URL || (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME)))
                     ? 'database'
                     : 'file';

console.log(`📦 Storage mode: ${STORAGE_MODE}`);
if (STORAGE_MODE === 'database') {
  console.log(`🗄️  Database type: ${DB_TYPE}`);
}

// Database connection pool (only used if STORAGE_MODE=database)
let dbPool = null;
if (STORAGE_MODE === 'database') {
  if (DB_TYPE === 'postgresql') {
    // Railway PostgreSQL
    dbPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    });
    console.log(`✓ PostgreSQL pool created (Railway)`);
  } else {
    // MySQL (IONOS)
    dbPool = mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 10000
    });
    console.log(`✓ MySQL pool created: ${process.env.DB_HOST}`);
  }
}

// Middleware
app.use(cors());
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

// Database query wrapper - works with both PostgreSQL and MySQL
async function dbQuery(sql, params = []) {
  if (DB_TYPE === 'postgresql') {
    // PostgreSQL uses $1, $2, etc for parameters
    const result = await dbPool.query(sql, params);
    return result.rows;
  } else {
    // MySQL uses ? for parameters
    const [rows] = await dbPool.execute(sql, params);
    return rows;
  }
}

// Initialize database tables
async function initializeDatabase() {
  if (!dbPool) {
    console.log('⚠️  No database pool - skipping database initialization');
    return;
  }

  try {
    // Test connection first
    if (DB_TYPE === 'postgresql') {
      await dbPool.query('SELECT 1');
    } else {
      await dbPool.execute('SELECT 1');
    }
    console.log('✓ Database connection successful');

    if (DB_TYPE === 'postgresql') {
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

    } else {
      // MySQL table creation
      await dbPool.execute(`
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

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS config (
          id INT PRIMARY KEY AUTO_INCREMENT,
          config_key VARCHAR(255) UNIQUE NOT NULL,
          config_value TEXT
        )
      `);

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS logs (
          id INT PRIMARY KEY AUTO_INCREMENT,
          user_id VARCHAR(255),
          username VARCHAR(255),
          action VARCHAR(255),
          details TEXT,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS characters (
          id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          data TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX(user_id)
        )
      `);

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS stories (
          id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          data TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX(user_id)
        )
      `);

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS files (
          id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255) NOT NULL,
          file_type VARCHAR(50) NOT NULL,
          story_id VARCHAR(255),
          mime_type VARCHAR(100) NOT NULL,
          file_data LONGBLOB NOT NULL,
          file_size INT,
          filename VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX(user_id),
          INDEX(story_id)
        )
      `);

      await dbPool.execute(`
        CREATE TABLE IF NOT EXISTS gelato_products (
          id INT PRIMARY KEY AUTO_INCREMENT,
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
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX(is_active)
        )
      `);
    }

    console.log('✓ Database tables initialized');

    // Run database migrations
    try {
      const { runMigrations } = require('./run-migrations');
      await runMigrations(dbPool, DB_TYPE);
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
      const insertQuery = DB_TYPE === 'postgresql'
        ? 'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)'
        : 'INSERT INTO logs (user_id, username, action, details) VALUES (?, ?, ?, ?)';
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
      const existingQuery = DB_TYPE === 'postgresql'
        ? 'SELECT id FROM users WHERE username = $1'
        : 'SELECT id FROM users WHERE username = ?';
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

      const insertQuery = DB_TYPE === 'postgresql'
        ? 'INSERT INTO users (id, username, email, password, role, story_quota, stories_generated) VALUES ($1, $2, $3, $4, $5, $6, $7)'
        : 'INSERT INTO users (id, username, email, password, role, story_quota, stories_generated) VALUES (?, ?, ?, ?, ?, ?, ?)';
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
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT * FROM users WHERE username = $1'
        : 'SELECT * FROM users WHERE username = ?';
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
        model: 'claude-3-haiku-20240307',
        max_tokens: max_tokens || 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Claude API error response:', JSON.stringify(data, null, 2));
      const errorMsg = data.error?.message || data.error?.type || JSON.stringify(data.error) || 'Claude API request failed';
      throw new Error(errorMsg);
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
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT * FROM users WHERE id = $1'
        : 'SELECT * FROM users WHERE id = ?';
      const rows = await dbQuery(selectQuery, [userId]);

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const updateQuery = DB_TYPE === 'postgresql'
        ? 'UPDATE users SET story_quota = $1 WHERE id = $2'
        : 'UPDATE users SET story_quota = ? WHERE id = ?';
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

// Get current user's quota status
app.get('/api/user/quota', authenticateToken, async (req, res) => {
  try {
    let quota, generated;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT story_quota, stories_generated FROM users WHERE id = $1'
        : 'SELECT story_quota, stories_generated FROM users WHERE id = ?';
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
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT shipping_first_name, shipping_last_name, shipping_address_line1, shipping_city, shipping_post_code, shipping_country, shipping_email FROM users WHERE id = $1'
        : 'SELECT shipping_first_name, shipping_last_name, shipping_address_line1, shipping_city, shipping_post_code, shipping_country, shipping_email FROM users WHERE id = ?';
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
    const { firstName, lastName, addressLine1, city, postCode, country, email } = req.body;

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const updateQuery = DB_TYPE === 'postgresql'
        ? 'UPDATE users SET shipping_first_name = $1, shipping_last_name = $2, shipping_address_line1 = $3, shipping_city = $4, shipping_post_code = $5, shipping_country = $6, shipping_email = $7 WHERE id = $8'
        : 'UPDATE users SET shipping_first_name = ?, shipping_last_name = ?, shipping_address_line1 = ?, shipping_city = ?, shipping_post_code = ?, shipping_country = ?, shipping_email = ? WHERE id = ?';
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
      const checkQuery = DB_TYPE === 'postgresql'
        ? 'SELECT id FROM users WHERE username = $1 AND id != $2'
        : 'SELECT id FROM users WHERE username = ? AND id != ?';
      const existing = await dbQuery(checkQuery, [newEmail, req.user.id]);

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Email already in use' });
      }

      const updateQuery = DB_TYPE === 'postgresql'
        ? 'UPDATE users SET username = $1 WHERE id = $2'
        : 'UPDATE users SET username = ? WHERE id = ?';
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
      customRelationships: []
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT data FROM characters WHERE user_id = $1 ORDER BY id DESC LIMIT 1'
        : 'SELECT data FROM characters WHERE user_id = ? ORDER BY id DESC LIMIT 1';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        // Handle both old format (array) and new format (object)
        if (Array.isArray(data)) {
          characterData.characters = data;
        } else {
          characterData = data;
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
          characterData = data;
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
    const { characters, relationships, relationshipTexts, customRelationships } = req.body;

    // Store character data as an object with all related information
    const characterData = {
      characters: characters || [],
      relationships: relationships || {},
      relationshipTexts: relationshipTexts || {},
      customRelationships: customRelationships || []
    };

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode - delete old characters and insert new ones
      const deleteQuery = DB_TYPE === 'postgresql'
        ? 'DELETE FROM characters WHERE user_id = $1'
        : 'DELETE FROM characters WHERE user_id = ?';
      await dbQuery(deleteQuery, [req.user.id]);

      // Insert character data as a single record with all information
      const characterId = `characters_${req.user.id}_${Date.now()}`;
      const insertQuery = DB_TYPE === 'postgresql'
        ? 'INSERT INTO characters (id, user_id, data) VALUES ($1, $2, $3)'
        : 'INSERT INTO characters (id, user_id, data) VALUES (?, ?, ?)';
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
    let userStories = [];

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC'
        : 'SELECT data FROM stories WHERE user_id = ? ORDER BY created_at DESC';
      const rows = await dbQuery(selectQuery, [req.user.id]);

      // Parse the JSON data from each row
      userStories = rows.map(row => JSON.parse(row.data));
    } else {
      // File mode
      const allStories = await readJSON(STORIES_FILE);
      userStories = allStories[req.user.id] || [];
    }

    await logActivity(req.user.id, req.user.username, 'STORIES_LOADED', { count: userStories.length });
    res.json(userStories);
  } catch (err) {
    console.error('Error fetching stories:', err);
    res.status(500).json({ error: 'Failed to fetch stories' });
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
      const checkQuery = DB_TYPE === 'postgresql'
        ? 'SELECT id FROM stories WHERE id = $1 AND user_id = $2'
        : 'SELECT id FROM stories WHERE id = ? AND user_id = ?';
      const existing = await dbQuery(checkQuery, [story.id, req.user.id]);
      isNewStory = existing.length === 0;

      // Check quota only for new stories
      if (isNewStory) {
        const userQuery = DB_TYPE === 'postgresql'
          ? 'SELECT story_quota, stories_generated FROM users WHERE id = $1'
          : 'SELECT story_quota, stories_generated FROM users WHERE id = ?';
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
          const updateQuery = DB_TYPE === 'postgresql'
            ? 'UPDATE users SET stories_generated = stories_generated + 1 WHERE id = $1'
            : 'UPDATE users SET stories_generated = stories_generated + 1 WHERE id = ?';
          await dbQuery(updateQuery, [req.user.id]);
        }
      }

      // Save or update story
      if (isNewStory) {
        const insertQuery = DB_TYPE === 'postgresql'
          ? 'INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3)'
          : 'INSERT INTO stories (id, user_id, data) VALUES (?, ?, ?)';
        await dbQuery(insertQuery, [story.id, req.user.id, JSON.stringify(story)]);
      } else {
        const updateQuery = DB_TYPE === 'postgresql'
          ? 'UPDATE stories SET data = $1 WHERE id = $2 AND user_id = $3'
          : 'UPDATE stories SET data = ? WHERE id = ? AND user_id = ?';
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

    if (STORAGE_MODE === 'database' && dbPool) {
      // Database mode
      const deleteQuery = DB_TYPE === 'postgresql'
        ? 'DELETE FROM stories WHERE id = $1 AND user_id = $2'
        : 'DELETE FROM stories WHERE id = ? AND user_id = ?';
      const result = await dbQuery(deleteQuery, [id, req.user.id]);

      // Check if any rows were deleted (PostgreSQL returns rows, MySQL returns affectedRows info)
      if (DB_TYPE === 'postgresql' && result.length === 0) {
        return res.status(404).json({ error: 'Story not found' });
      }
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
    const { pdfUrl, shippingAddress, orderReference, productUid, pageCount } = req.body;

    if (!pdfUrl || !shippingAddress || !productUid || !pageCount) {
      return res.status(400).json({ error: 'Missing required fields: pdfUrl, shippingAddress, productUid, pageCount' });
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
      dashboardUrl: `https://dashboard.gelato.com/orders/${gelatoData.orderId || gelatoData.id}`,
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

    // Fetch products from Gelato API
    const response = await fetch('https://product.gelatoapis.com/v3/products?limit=100', {
      headers: {
        'X-API-KEY': gelatoApiKey
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: 'Failed to fetch from Gelato', details: errorData });
    }

    const data = await response.json();

    // Filter for photobooks only
    const photobooks = (data.products || []).filter(product =>
      product.productUid && product.productUid.includes('photobook')
    );

    res.json({
      success: true,
      count: photobooks.length,
      products: photobooks
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
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT * FROM gelato_products ORDER BY is_active DESC, created_at DESC'
        : 'SELECT * FROM gelato_products ORDER BY is_active DESC, created_at DESC';

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
      const upsertQuery = DB_TYPE === 'postgresql'
        ? `INSERT INTO gelato_products
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
             updated_at = CURRENT_TIMESTAMP`
        : `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             product_name = VALUES(product_name),
             description = VALUES(description),
             size = VALUES(size),
             cover_type = VALUES(cover_type),
             min_pages = VALUES(min_pages),
             max_pages = VALUES(max_pages),
             available_page_counts = VALUES(available_page_counts),
             is_active = VALUES(is_active),
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
      const upsertQuery = DB_TYPE === 'postgresql'
        ? `INSERT INTO gelato_products
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
             updated_at = CURRENT_TIMESTAMP`
        : `INSERT INTO gelato_products
           (product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             product_name = VALUES(product_name),
             description = VALUES(description),
             size = VALUES(size),
             cover_type = VALUES(cover_type),
             min_pages = VALUES(min_pages),
             max_pages = VALUES(max_pages),
             available_page_counts = VALUES(available_page_counts),
             is_active = VALUES(is_active),
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
app.get('/api/gelato/products', async (req, res) => {
  try {
    if (STORAGE_MODE === 'database' && dbPool) {
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = true ORDER BY product_name'
        : 'SELECT product_uid, product_name, description, size, cover_type, min_pages, max_pages, available_page_counts FROM gelato_products WHERE is_active = 1 ORDER BY product_name';

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
      const insertQuery = DB_TYPE === 'postgresql'
        ? 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)'
        : 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

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
      const selectQuery = DB_TYPE === 'postgresql'
        ? 'SELECT mime_type, file_data, filename FROM files WHERE id = $1'
        : 'SELECT mime_type, file_data, filename FROM files WHERE id = ?';

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
      const deleteQuery = DB_TYPE === 'postgresql'
        ? 'DELETE FROM files WHERE id = $1 AND user_id = $2'
        : 'DELETE FROM files WHERE id = ? AND user_id = ?';

      const result = await dbQuery(deleteQuery, [fileId, req.user.id]);

      if (DB_TYPE === 'postgresql' && result.length === 0) {
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
    const { storyId, storyTitle, storyPages, sceneImages } = req.body;

    if (!storyPages || !Array.isArray(storyPages) || storyPages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid storyPages' });
    }

    const PDFDocument = require('pdfkit');
    const stream = require('stream');

    // Create PDF document
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 72, bottom: 72, left: 72, right: 72 }
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

    // Add content to PDF
    storyPages.forEach((page, index) => {
      const pageNumber = index + 1;

      // Add text page
      if (index > 0) doc.addPage();

      doc.fontSize(16)
         .font('Helvetica')
         .text(page.text, {
           align: 'center',
           valign: 'center'
         });

      // Add image page if available
      const sceneImage = sceneImages.find(img => img.pageNumber === pageNumber);
      if (sceneImage && sceneImage.imageData) {
        doc.addPage();

        // Extract base64 data
        const base64Data = sceneImage.imageData.replace(/^data:image\/\w+;base64,/, '');
        const imageBuffer = Buffer.from(base64Data, 'base64');

        // Add image centered on page
        try {
          doc.image(imageBuffer, {
            fit: [doc.page.width - 144, doc.page.height - 144],
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
      const insertQuery = DB_TYPE === 'postgresql'
        ? 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)'
        : 'INSERT INTO files (id, user_id, file_type, story_id, mime_type, file_data, file_size, filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// IP check endpoint - shows Railway's outgoing IP for database whitelisting
app.get('/api/check-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({
      railwayOutgoingIp: data.ip,
      requestIp: req.ip,
      forwardedFor: req.headers['x-forwarded-for'],
      message: 'Add the railwayOutgoingIp to your IONOS database whitelist'
    });
  } catch (err) {
    res.json({ error: err.message });
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
      console.log(`🗄️  Database: ${process.env.DB_HOST}/${process.env.DB_NAME}`);
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
