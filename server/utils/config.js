// Configuration and Constants

// Story Generation Batch Size Configuration
const STORY_BATCH_SIZE = parseInt(process.env.STORY_BATCH_SIZE) || 0;

// Image generation mode: 'parallel' (fast) or 'sequential' (consistent)
const IMAGE_GEN_MODE = process.env.IMAGE_GEN_MODE || 'parallel';

// Image quality threshold - regenerate if score below this value (0-100 scale)
const { REPAIR_DEFAULTS } = require('../config/models');
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || REPAIR_DEFAULTS.scoreThreshold;

// Server configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// CORS origins
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

// Gelato API
const GELATO_API_KEY = process.env.GELATO_API_KEY;
const GELATO_API_URL = 'https://order.gelatoapis.com/v4';

// API Keys
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

module.exports = {
  // Story generation
  STORY_BATCH_SIZE,
  IMAGE_GEN_MODE,
  IMAGE_QUALITY_THRESHOLD,

  // Server
  PORT,
  NODE_ENV,
  IS_PRODUCTION,
  CORS_ORIGINS,

  // External APIs
  GELATO_API_KEY,
  GELATO_API_URL,
  ANTHROPIC_API_KEY,
  GOOGLE_API_KEY
};
