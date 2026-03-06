// Database Configuration
// Configure your MySQL 8.0 connection here

const mysql = require('mysql2/promise');

// Database connection configuration
// IMPORTANT: Update these values with your web hosting credentials
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'magicalstory',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // MySQL 8.0 specific settings
  charset: 'utf8mb4',
  timezone: '+00:00'
};

// Create connection pool
let pool = null;

/**
 * Initialize database connection pool
 */
function initializePool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connection pool created');
  }
  return pool;
}

/**
 * Get database connection from pool
 */
async function getConnection() {
  if (!pool) {
    initializePool();
  }
  try {
    const connection = await pool.getConnection();
    return connection;
  } catch (error) {
    console.error('❌ Database connection error:', error.message);
    throw error;
  }
}

/**
 * Execute a query with automatic connection handling
 */
async function query(sql, params = []) {
  const connection = await getConnection();
  try {
    const [results] = await connection.execute(sql, params);
    return results;
  } finally {
    connection.release();
  }
}

/**
 * Test database connection
 */
async function testConnection() {
  try {
    const connection = await getConnection();
    await connection.ping();
    console.log('✅ Database connection successful');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

/**
 * Close all database connections
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('✅ Database connection pool closed');
  }
}

module.exports = {
  initializePool,
  getConnection,
  query,
  testConnection,
  closePool,
  pool: () => pool
};
