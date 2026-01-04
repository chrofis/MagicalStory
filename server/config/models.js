/**
 * AI Model Configuration
 *
 * Centralized configuration for all AI models used in the application.
 * Change these values to update models across the entire pipeline.
 */

// Available text models
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

// Default model selections for each task
const MODEL_DEFAULTS = {
  // Text generation models
  idea: 'claude-sonnet',               // Story idea generation
  outline: 'claude-sonnet',            // Story outline generation
  storyText: 'claude-sonnet',          // Story narrative text
  sceneDescription: 'claude-sonnet',   // Scene description for images

  // Image models
  pageImage: 'gemini-2.5-flash-image',       // Regular page images
  coverImage: 'gemini-3-pro-image-preview',  // Cover images (higher quality)

  // Quality evaluation models
  qualityEval: 'gemini-2.5-flash',     // Image quality evaluation

  // Utility models (inspection, visual bible, etc.)
  utility: 'gemini-2.0-flash'          // Fast utility tasks
};

// Image model configurations
const IMAGE_MODELS = {
  'gemini-2.5-flash-image': {
    modelId: 'gemini-2.5-flash-preview-05-20',
    description: 'Gemini 2.5 Flash Image - Fast image generation'
  },
  'gemini-3-pro-image-preview': {
    modelId: 'gemini-3-pro-image-preview',
    description: 'Gemini 3 Pro Image Preview - Higher quality images'
  }
};

// Approximate pricing per 1M tokens (USD)
const MODEL_PRICING = {
  'claude-sonnet': { input: 3.00, output: 15.00 },
  'claude-haiku': { input: 0.25, output: 1.25 },
  'gemini-2.5-pro': { input: 0.075, output: 0.30 },
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'gemini-2.0-flash': { input: 0.075, output: 0.30 },
  'gemini-pro-latest': { input: 0.075, output: 0.30 }
};

module.exports = {
  TEXT_MODELS,
  MODEL_DEFAULTS,
  IMAGE_MODELS,
  MODEL_PRICING
};
