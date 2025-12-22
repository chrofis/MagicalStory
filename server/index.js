/**
 * MagicalStory Server - Modular Entry Point
 *
 * This is the new modular architecture entry point.
 * Routes can be migrated from server.js incrementally.
 *
 * Migration Guide:
 * 1. Create a new route file in /server/routes/ (e.g., auth.js)
 * 2. Move the route handlers from server.js to the new file
 * 3. Import and use the router here
 * 4. Remove the routes from server.js
 *
 * Currently this file re-exports the legacy server.js
 * As routes are migrated, they will be imported here instead.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

// Import modular components
const { dbQuery, initializePool, initializeDatabase, getPool } = require('./services/database');
const { authenticateToken, requireAdmin } = require('./middleware/auth');
const { apiLimiter, authLimiter, registerLimiter } = require('./middleware/rateLimit');
const { log, CORS_ORIGINS, PORT, IS_PRODUCTION } = require('./utils');

// Create Express app
const app = express();

// Trust proxy for rate limiting behind reverse proxies
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);

    // Check allowed origins
    if (CORS_ORIGINS.includes(origin) || origin.includes('localhost') || origin.includes('magicalstory')) {
      callback(null, true);
    } else {
      log.warn(`CORS blocked origin: ${origin}`);
      callback(null, true); // Allow anyway for now, but log it
    }
  },
  credentials: true
};
app.use(cors(corsOptions));

// Rate limiting
app.use('/api/', apiLimiter);

// Body parsing (after raw body handlers for webhooks)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Static files
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.use('/images', express.static(path.join(__dirname, '..', 'images')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =============================================================================
// MIGRATED ROUTES GO HERE
// As routes are extracted from server.js, import and use them here:
//
// const authRoutes = require('./routes/auth');
// const storyRoutes = require('./routes/stories');
// app.use('/api/auth', authRoutes);
// app.use('/api/stories', storyRoutes);
// =============================================================================

// Export for use by legacy server.js during migration
module.exports = {
  app,
  dbQuery,
  getPool,
  initializePool,
  initializeDatabase,
  authenticateToken,
  requireAdmin,
  apiLimiter,
  authLimiter,
  registerLimiter,
  log
};

// =============================================================================
// LEGACY COMPATIBILITY
// During migration, the legacy server.js can import this module
// and use its exports, or this can import from server.js
// =============================================================================

// If run directly (not imported), start the server
if (require.main === module) {
  const startServer = async () => {
    try {
      // Initialize database
      initializePool();
      await initializeDatabase();

      // Start server
      app.listen(PORT, () => {
        log.info(`🚀 Server running on port ${PORT}`);
        log.info(`📊 Environment: ${IS_PRODUCTION ? 'production' : 'development'}`);
      });
    } catch (error) {
      log.error('Failed to start server:', error);
      process.exit(1);
    }
  };

  startServer();
}
