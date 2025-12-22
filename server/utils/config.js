// Configuration and Constants

// Story Generation Batch Size Configuration
const STORY_BATCH_SIZE = parseInt(process.env.STORY_BATCH_SIZE) || 0;

// Image generation mode: 'parallel' (fast) or 'sequential' (consistent)
const IMAGE_GEN_MODE = process.env.IMAGE_GEN_MODE || 'parallel';

// Image quality threshold - regenerate if score below this value (0-100 scale)
const IMAGE_QUALITY_THRESHOLD = parseFloat(process.env.IMAGE_QUALITY_THRESHOLD) || 50;

// Text Model Configuration
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

// Active text model
const TEXT_MODEL = process.env.TEXT_MODEL || 'claude-sonnet';
const activeTextModel = TEXT_MODELS[TEXT_MODEL] || TEXT_MODELS['claude-sonnet'];

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

/**
 * Calculate optimal batch size based on model token limits
 */
function calculateOptimalBatchSize(totalPages, tokensPerPage = 400, safetyMargin = 0.8) {
  const maxTokens = activeTextModel.maxOutputTokens;
  const safeMaxTokens = Math.floor(maxTokens * safetyMargin);
  const optimalBatchSize = Math.floor(safeMaxTokens / tokensPerPage);

  // If configured batch size is 0, return optimal; otherwise respect the configured size
  if (STORY_BATCH_SIZE === 0) {
    return Math.min(optimalBatchSize, totalPages);
  }
  return Math.min(STORY_BATCH_SIZE, optimalBatchSize, totalPages);
}

module.exports = {
  // Story generation
  STORY_BATCH_SIZE,
  IMAGE_GEN_MODE,
  IMAGE_QUALITY_THRESHOLD,

  // Text models
  TEXT_MODELS,
  TEXT_MODEL,
  activeTextModel,
  calculateOptimalBatchSize,

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
