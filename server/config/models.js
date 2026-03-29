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
    modelId: 'claude-sonnet-4-6',
    maxOutputTokens: 64000,
    description: 'Claude Sonnet 4.6 - Best narrative quality'
  },
  'claude-haiku': {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    maxOutputTokens: 8192,
    description: 'Claude Haiku 4.5 - Fast and affordable'
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
  },
  'grok-3-mini': {
    provider: 'xai',
    modelId: 'grok-3-mini',
    maxOutputTokens: 32768,
    description: 'Grok 3 Mini - Fast and cheap ($0.30/$0.50 per 1M tokens)'
  },
  'grok-3': {
    provider: 'xai',
    modelId: 'grok-3',
    maxOutputTokens: 32768,
    description: 'Grok 3 - Good quality ($3.00/$15.00 per 1M tokens)'
  },
  'grok-4-fast': {
    provider: 'xai',
    modelId: 'grok-4-1-fast-non-reasoning',
    maxOutputTokens: 65536,
    description: 'Grok 4 Fast - Very cheap, 2M context ($0.20/$0.50 per 1M tokens)'
  }
};

// Default model selections for each task
const MODEL_DEFAULTS = {
  // Text generation models
  idea: 'claude-sonnet',               // Story idea generation
  outline: 'claude-sonnet',            // Story outline generation
  storyText: 'claude-sonnet',          // Story narrative text
  sceneDescription: 'claude-haiku',     // Initial scene expansion (better instruction following for clothing/format)
  sceneIteration: 'claude-haiku',       // Scene iteration/retry (better instruction following for clothing/format)

  // Image models
  pageImage: 'grok-imagine',                 // Regular page images ($0.02/image — vs $0.04 Gemini)
  coverImage: 'grok-imagine',                // Cover images ($0.02/image)

  // Per-page routing by scene complexity (sceneRouting = 'auto')
  simplePageImage: 'grok-imagine',            // Simple scenes: all chars foreground ($0.02)
  complexPageImage: 'gemini-2.5-flash-image', // Complex scenes: background chars need Gemini ($0.04)

  // Quality evaluation models
  // Grok vision is supported via callGrokVisionAPI() — set qualityEval to a grok model to use it
  qualityEval: 'gemini-2.5-flash',     // Image quality evaluation (2.5 for character identification)
  bboxDetection: 'gemini-2.5-flash',   // Bounding box detection (needs 2.5 for spatial precision)

  // Utility models (inspection, visual bible, etc.)
  utility: 'gemini-2.0-flash',         // Fast utility tasks

  // Inpainting backend for auto-repair
  inpaintBackend: 'grok',              // 'gemini', 'runware', or 'grok' ($0.02/repair via Grok edit)

  // Image generation backend (can be overridden in dev mode)
  // 'gemini' = Gemini API (default, best quality)
  // 'runware' = Runware FLUX Schnell (super cheap, good for testing)
  imageBackend: 'gemini',              // Default: Gemini for production quality

  // Feature flags for generation pipeline
  enableAutoRepair: false,             // Auto-repair: inpaint fixable issues (Runware SDXL/FLUX)
  useGridRepair: false,                // Grid-based artifact repair: OFF - we only want character fixes
  enableQualityRetry: false,           // Quality retry: regenerate images scoring below threshold
  enableFinalChecks: false,            // Final checks: run entity consistency + one character fix pass
  checkOnlyMode: false,                // Check-only mode: run checks but skip all regeneration
  generateEmptyScenes: true,           // Pre-generate empty scene backgrounds for style anchoring
};

// Available inpaint backends
const INPAINT_BACKENDS = {
  'gemini': {
    name: 'Gemini',
    description: 'Gemini 2.5 Flash Image - High quality, more expensive (~$0.03/image)',
    costPerImage: 0.03,
    model: 'gemini-2.5-flash-image'
  },
  'runware-sdxl': {
    name: 'Runware SDXL',
    description: 'Runware SDXL - Good quality for objects/backgrounds (~$0.002/image)',
    costPerImage: 0.002,
    model: 'runware:101@1'
  },
  'runware-flux-fill': {
    name: 'Runware FLUX Fill',
    description: 'FLUX Fill - Best quality for face repair (~$0.05/image)',
    costPerImage: 0.05,
    model: 'runware:102@1'
  },
  // Legacy alias
  'runware': {
    name: 'Runware SDXL',
    description: 'Runware SDXL - Good quality, cheap (~$0.002/image)',
    costPerImage: 0.002,
    model: 'runware:101@1'
  }
};

// Image generation backends
const IMAGE_BACKENDS = {
  'gemini': {
    name: 'Gemini',
    description: 'Google Gemini - Best quality, higher cost (~$0.03-0.04/image)',
    costPerImage: 0.035
  },
  'runware': {
    name: 'Runware FLUX Schnell',
    description: 'FLUX Schnell via Runware - Ultra cheap ($0.0006/image), good for testing',
    costPerImage: 0.0006
  },
  'grok': {
    name: 'Grok Imagine (xAI Aurora)',
    description: 'xAI Grok Imagine - Good quality, cheap ($0.02/image), supports reference images',
    costPerImage: 0.02
  }
};

// Image model configurations
// maxPromptLength: Maximum characters for the prompt (API limit)
// maxCharactersPerScene: Max characters in scene hints (Grok handles more faces via ref images)
const IMAGE_MODELS = {
  'gemini-2.5-flash-image': {
    modelId: 'gemini-2.5-flash-image',
    description: 'Gemini 2.5 Flash Image - Fast image generation',
    backend: 'gemini',
    supportsThinking: false,
    temperature: 0.5,  // Lower temp for more consistent character reproduction
    maxPromptLength: 30000,  // Gemini supports very long prompts
    maxCharactersPerScene: 3
  },
  'gemini-3-pro-image-preview': {
    modelId: 'gemini-3-pro-image-preview',
    description: 'Gemini 3 Pro Image Preview - Higher quality images',
    backend: 'gemini',
    supportsThinking: true,  // Thinks by default; thinkingConfig.includeThoughts returns thought text
    temperature: 0.5,  // Lower temp for more consistent character reproduction
    maxPromptLength: 30000,
    maxCharactersPerScene: 3
  },
  'flux-schnell': {
    modelId: 'runware:5@1',
    description: 'FLUX Schnell via Runware - Ultra fast, cheap ($0.0006/image)',
    backend: 'runware',
    maxPromptLength: 2900,  // Runware limit is 3000, leave margin
    maxCharactersPerScene: 3
  },
  'flux-dev': {
    modelId: 'runware:6@1',
    description: 'FLUX Dev via Runware - Better quality ($0.004/image)',
    backend: 'runware',
    maxPromptLength: 2900,
    maxCharactersPerScene: 3
  },
  'ace-plus-plus': {
    modelId: 'ace-plus-plus',
    description: 'ACE++ via Runware - Face-consistent avatar generation (~$0.005/image)',
    backend: 'runware',
    maxPromptLength: 2900,
    maxCharactersPerScene: 3
  },
  'grok-imagine': {
    modelId: 'grok-imagine-image',
    description: 'Grok Imagine Standard - Good quality ($0.02/image), ref image support',
    backend: 'grok',
    maxPromptLength: 7500,
    maxCharactersPerScene: 5
  },
  'grok-imagine-pro': {
    modelId: 'grok-imagine-image-pro',
    description: 'Grok Imagine Pro - Higher quality ($0.07/image), ref image support',
    backend: 'grok',
    maxPromptLength: 7500,
    maxCharactersPerScene: 5
  }
};

// Repair workflow thresholds — single source of truth for server-side pipeline
const REPAIR_DEFAULTS = {
  scoreThreshold: 60,       // Pages scoring below this need redo (0-100)
  issueThreshold: 5,        // Pages with this many fixable issues need redo
  maxPasses: 3,             // Global passes over all pages
  maxCharRepairPages: 3,    // Max pages to character-repair per run
};

// Approximate pricing per 1M tokens (USD)
// Updated Feb 2026 - check provider websites for latest pricing
// Source: https://platform.claude.com/docs/en/about-claude/pricing
const MODEL_PRICING = {
  // Anthropic Claude models (Feb 2026)
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet-4-5-20250929': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-sonnet': { input: 3.00, output: 15.00, thinking: 15.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, thinking: 5.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, thinking: 5.00 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.00, thinking: 4.00 },
  'claude-haiku': { input: 1.00, output: 5.00, thinking: 5.00 },

  // Google Gemini models (per 1M tokens) - Updated Jan 2026
  // Source: https://ai.google.dev/gemini-api/docs/pricing
  'gemini-2.5-pro': { input: 1.25, output: 10.00, thinking: 10.00 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50, thinking: 2.50 },
  'gemini-2.0-flash': { input: 0.10, output: 0.40, thinking: 0.40 },
  'gemini-pro-latest': { input: 1.25, output: 10.00, thinking: 10.00 },

  // xAI Grok models (Mar 2026)
  // Source: https://docs.x.ai/docs/models
  'grok-3-mini': { input: 0.30, output: 0.50 },
  'grok-3': { input: 3.00, output: 15.00 },
  'grok-4-1-fast-non-reasoning': { input: 0.20, output: 0.50 },

  // Grok Imagine models (fixed cost per image)
  'grok-imagine-image': { perImage: 0.02 },
  'grok-imagine-image-pro': { perImage: 0.07 },

  // Image generation models (fixed cost per image, not per token)
  'gemini-2.5-flash-image': { perImage: 0.04 },
  'gemini-3-pro-image-preview': { perImage: 0.15 },
  'runware:5@1': { perImage: 0.0006 },  // FLUX Schnell
  'runware:6@1': { perImage: 0.004 },   // FLUX Dev
  'ace-plus-plus': { perImage: 0.005 }
};

/**
 * Calculate the cost for a text model API call
 * @param {string} modelId - The model ID used (e.g., 'claude-sonnet-4-5-20250929', 'gemini-2.5-flash')
 * @param {object} usage - Token usage: { inputTokens, outputTokens, thinkingTokens? }
 * @returns {number} Estimated cost in USD
 */
function calculateTextCost(modelId, usage) {
  // Find pricing - try exact match first, then normalize
  let pricing = MODEL_PRICING[modelId];

  if (!pricing) {
    // Try to find a matching key by normalizing the model ID
    const normalizedId = modelId.toLowerCase().replace(/-\d+$/, '');
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      if (key.toLowerCase().startsWith(normalizedId) || modelId.includes(key)) {
        pricing = value;
        break;
      }
    }
  }

  if (!pricing || pricing.perImage) {
    // Unknown text model or this is an image model
    console.warn(`[COST] No token pricing found for model: ${modelId}`);
    return 0;
  }

  const inputTokens = usage.inputTokens || usage.input_tokens || 0;
  const outputTokens = usage.outputTokens || usage.output_tokens || 0;
  const thinkingTokens = usage.thinkingTokens || usage.thinking_tokens || 0;

  // Calculate cost: price per 1M tokens * (tokens / 1M)
  const inputCost = (pricing.input * inputTokens) / 1_000_000;
  const outputCost = (pricing.output * outputTokens) / 1_000_000;
  const thinkingCost = (pricing.thinking || pricing.output) * thinkingTokens / 1_000_000;

  return inputCost + outputCost + thinkingCost;
}

/**
 * Calculate the cost for an image generation API call
 * @param {string} modelId - The model ID or backend used
 * @param {number} imageCount - Number of images generated (default: 1)
 * @returns {number} Estimated cost in USD
 */
function calculateImageCost(modelId, imageCount = 1) {
  // Check IMAGE_BACKENDS first (e.g. 'grok', 'gemini', 'runware')
  if (IMAGE_BACKENDS[modelId]) {
    return IMAGE_BACKENDS[modelId].costPerImage * imageCount;
  }

  // Check MODEL_PRICING for image models (e.g. 'grok-imagine-image')
  const pricing = MODEL_PRICING[modelId];
  if (pricing?.perImage) {
    return pricing.perImage * imageCount;
  }

  // Resolve display name → backend via IMAGE_MODELS (e.g. 'grok-imagine' → backend 'grok')
  const imageModelConfig = IMAGE_MODELS[modelId];
  if (imageModelConfig?.backend && IMAGE_BACKENDS[imageModelConfig.backend]) {
    return IMAGE_BACKENDS[imageModelConfig.backend].costPerImage * imageCount;
  }
  // Also check the internal modelId (e.g. 'grok-imagine' → modelId 'grok-imagine-image')
  if (imageModelConfig?.modelId) {
    const internalPricing = MODEL_PRICING[imageModelConfig.modelId];
    if (internalPricing?.perImage) {
      return internalPricing.perImage * imageCount;
    }
  }

  // Default to Gemini pricing if unknown
  console.warn(`[COST] No image pricing found for model: ${modelId}, using default`);
  return 0.035 * imageCount;
}

/**
 * Get a summary of cost breakdown for logging
 * @param {string} modelId - The model ID used
 * @param {object} usage - Token usage or image count
 * @param {number} cost - Calculated cost
 * @returns {string} Human-readable cost summary
 */
function formatCostSummary(modelId, usage, cost) {
  if (usage.inputTokens || usage.input_tokens) {
    const input = usage.inputTokens || usage.input_tokens || 0;
    const output = usage.outputTokens || usage.output_tokens || 0;
    const thinking = usage.thinkingTokens || usage.thinking_tokens || 0;
    const thinkingStr = thinking > 0 ? ` + ${thinking.toLocaleString()} thinking` : '';
    return `${modelId}: ${input.toLocaleString()} in / ${output.toLocaleString()} out${thinkingStr} = $${cost.toFixed(6)}`;
  } else {
    return `${modelId}: $${cost.toFixed(6)}`;
  }
}

module.exports = {
  TEXT_MODELS,
  MODEL_DEFAULTS,
  IMAGE_MODELS,
  IMAGE_BACKENDS,
  MODEL_PRICING,
  INPAINT_BACKENDS,
  REPAIR_DEFAULTS,
  // Cost calculation utilities
  calculateTextCost,
  calculateImageCost,
  formatCostSummary
};
