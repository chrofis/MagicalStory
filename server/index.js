/**
 * MagicalStory Server - Modular Entry Point
 *
 * This is the new modular architecture entry point.
 * Routes are being migrated from server.js incrementally.
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

// Import routes
const configRoutes = require('./routes/config');
const healthRoutes = require('./routes/health');
const userRoutes = require('./routes/user');
const characterRoutes = require('./routes/characters');
const authRoutes = require('./routes/auth');
const storyDraftRoutes = require('./routes/storyDraft');
const storiesRoutes = require('./routes/stories');
const filesRoutes = require('./routes/files');
const adminRoutes = require('./routes/admin');

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
      callback(new Error(`Origin ${origin} not allowed by CORS`));
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

// =============================================================================
// MIGRATED ROUTES
// =============================================================================

// Config routes: /api/config/*
app.use('/api/config', configRoutes);

// Health & utility routes: /api/health, /api/check-ip, /api/log-error
app.use('/api', healthRoutes);

// Auth routes: /api/auth/*
app.use('/api/auth', authRoutes);

// User routes: /api/user/*
app.use('/api/user', userRoutes);

// Character routes: /api/characters/*
app.use('/api/characters', characterRoutes);

// Story draft routes: /api/story-draft
app.use('/api/story-draft', storyDraftRoutes);

// Stories routes: /api/stories/* (CRUD only, regenerate/edit still in server.js)
app.use('/api/stories', storiesRoutes);

// Files routes: /api/files/*
app.use('/api/files', filesRoutes);

// Admin routes: /api/admin/*
app.use('/api/admin', adminRoutes);

// =============================================================================
// ROUTES STILL IN server.js (to be migrated):
// - /api/stories/:id/regenerate/* - Story regeneration (AI generation)
// - /api/stories/:id/edit/* - Story editing (AI generation)
// - /api/stories/:id/pdf - PDF generation
// - /api/stripe/* - Payments
// - /api/print-provider/* - Gelato integration
// - /api/jobs/* - Background job management
// - /api/analyze-photo - Photo analysis
// - /api/generate-clothing-avatars - Avatar generation
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
// STANDALONE SERVER MODE
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
        log.info(`📁 Migrated routes: /api/config, /api/health, /api/user, /api/characters`);
      });
    } catch (error) {
      log.error('Failed to start server:', error);
      process.exit(1);
    }
  };

  startServer();
}
