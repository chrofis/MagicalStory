/**
 * Text Model API Module
 * Handles text generation via Anthropic Claude and Google Gemini APIs
 * Extracted from server.js for maintainability
 */

const { log } = require('../utils/logger');

// Available text models configuration
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

// Get active model from environment
const TEXT_MODEL = process.env.TEXT_MODEL || 'claude-sonnet';
const activeTextModel = TEXT_MODELS[TEXT_MODEL] || TEXT_MODELS['claude-sonnet'];

/**
 * Get the currently active text model configuration
 */
function getActiveTextModel() {
  return activeTextModel;
}

/**
 * Get the text model name
 */
function getTextModelName() {
  return TEXT_MODEL;
}

/**
 * Calculate optimal batch size based on model token limits
 * @param {number} totalPages - Total number of pages to generate
 * @param {number} tokensPerPage - Estimated tokens needed per page (default: 400 for storybook, 500 for standard)
 * @param {number} safetyMargin - Safety margin to avoid hitting limits (default: 0.8 = use 80% of max)
 * @returns {number} Optimal batch size (number of pages per API call)
 */
function calculateOptimalBatchSize(totalPages, tokensPerPage = 400, safetyMargin = 0.8) {
  const maxTokens = activeTextModel.maxOutputTokens;
  const safeMaxTokens = Math.floor(maxTokens * safetyMargin);
  const optimalBatchSize = Math.floor(safeMaxTokens / tokensPerPage);

  // Ensure at least 1 page per batch, and don't exceed total pages
  const batchSize = Math.max(1, Math.min(optimalBatchSize, totalPages));

  log.debug(`📊 [BATCH] Model ${TEXT_MODEL} max tokens: ${maxTokens.toLocaleString()}, safe: ${safeMaxTokens.toLocaleString()}`);
  log.debug(`📊 [BATCH] Tokens/page: ${tokensPerPage}, optimal batch: ${optimalBatchSize}, using: ${batchSize}`);

  return batchSize;
}

/**
 * Call Anthropic Claude API
 */
async function callAnthropicAPI(prompt, maxTokens, modelId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  // Calculate timeout based on expected tokens (larger requests need more time)
  // Minimum 5 minutes, + 3 seconds per 1000 tokens for very large requests
  const timeoutMs = Math.max(300000, 180000 + Math.ceil(maxTokens / 1000) * 3000);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: prompt
      }]
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Extract token usage
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [ANTHROPIC] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  return {
    text: data.content[0].text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Call Anthropic Claude API with streaming
 * Streams text as it's generated, calling onChunk for each piece
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {string} modelId - The model ID to use
 * @param {function} onChunk - Callback function called with each text chunk: (chunk: string, fullText: string) => void
 * @returns {Promise<{text: string, usage: object}>} The complete generated text and usage
 */
async function callAnthropicAPIStreaming(prompt, maxTokens, modelId, onChunk) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  console.log(`🌊 [STREAM] Starting streaming request to Anthropic (${maxTokens} max tokens)...`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: maxTokens,
      stream: true,
      messages: [{
        role: 'user',
        content: prompt
      }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${error}`);
  }

  // Process the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        log.debug('🌊 [STREAM] Stream complete');
        break;
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6); // Remove 'data: ' prefix

        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Handle different event types
          if (event.type === 'content_block_delta' && event.delta?.text) {
            const chunk = event.delta.text;
            fullText += chunk;
            if (onChunk) {
              onChunk(chunk, fullText);
            }
          } else if (event.type === 'message_delta' && event.usage) {
            // Final message with usage stats
            outputTokens = event.usage.output_tokens || 0;
          } else if (event.type === 'message_start' && event.message?.usage) {
            // Initial message with input token count
            inputTokens = event.message.usage.input_tokens || 0;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [ANTHROPIC STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  return {
    text: fullText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    },
    modelId
  };
}

/**
 * Call Google Gemini API for text generation with streaming
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {string} modelId - The model ID to use
 * @param {function} onChunk - Callback function called with each text chunk
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callGeminiTextAPIStreaming(prompt, maxTokens, modelId, onChunk) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  console.log(`🌊 [STREAM] Starting streaming request to Gemini (${maxTokens} max tokens)...`);

  // Use streamGenerateContent endpoint for streaming
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  // Process the SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        log.debug('🌊 [GEMINI STREAM] Stream complete');
        break;
      }

      // Decode the chunk and add to buffer
      buffer += decoder.decode(value, { stream: true });

      // Process complete events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6); // Remove 'data: ' prefix

        if (data === '[DONE]' || data.trim() === '') continue;

        try {
          const event = JSON.parse(data);

          // Extract text from candidates
          if (event.candidates?.[0]?.content?.parts?.[0]?.text) {
            const chunk = event.candidates[0].content.parts[0].text;
            fullText += chunk;
            if (onChunk) {
              onChunk(chunk, fullText);
            }
          }

          // Extract usage metadata (usually in the last chunk)
          if (event.usageMetadata) {
            inputTokens = event.usageMetadata.promptTokenCount || inputTokens;
            outputTokens = event.usageMetadata.candidatesTokenCount || outputTokens;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [GEMINI STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  return {
    text: fullText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    },
    modelId
  };
}

/**
 * Call Google Gemini API for text generation
 */
async function callGeminiTextAPI(prompt, maxTokens, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.7
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  const data = await response.json();

  // Extract token usage
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [GEMINI] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error('No text in Gemini response');
  }

  return {
    text: data.candidates[0].content.parts[0].text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Main text model caller - routes to appropriate provider
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate (capped to model limit)
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callTextModel(prompt, maxTokens = 4096, modelOverride = null) {
  // Use override if provided, otherwise use global active model
  let model = activeTextModel;
  let modelName = TEXT_MODEL;

  if (modelOverride && TEXT_MODELS[modelOverride]) {
    model = TEXT_MODELS[modelOverride];
    modelName = modelOverride;
    log.debug(`🔧 [TEXT] Using model override: ${modelOverride}`);
  }

  // Cap maxTokens to model limit
  const effectiveMaxTokens = Math.min(maxTokens, model.maxOutputTokens);

  log.verbose(`🤖 [TEXT] Calling ${modelName} (${model.modelId}) with max ${effectiveMaxTokens} tokens`);

  let result;
  switch (model.provider) {
    case 'anthropic':
      result = await callAnthropicAPI(prompt, effectiveMaxTokens, model.modelId);
      break;
    case 'google':
      result = await callGeminiTextAPI(prompt, effectiveMaxTokens, model.modelId);
      break;
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
  return { ...result, modelId: model.modelId };
}

/**
 * Text model caller with streaming support
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {function} onChunk - Callback for each text chunk
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callTextModelStreaming(prompt, maxTokens = 4096, onChunk = null, modelOverride = null) {
  // Use override if provided, otherwise use global active model
  let model = activeTextModel;
  let modelName = TEXT_MODEL;

  if (modelOverride && TEXT_MODELS[modelOverride]) {
    model = TEXT_MODELS[modelOverride];
    modelName = modelOverride;
    log.debug(`🔧 [TEXT STREAM] Using model override: ${modelOverride}`);
  }

  // Cap maxTokens to model limit
  const effectiveMaxTokens = Math.min(maxTokens, model.maxOutputTokens);

  log.verbose(`🌊 [TEXT STREAM] Calling ${modelName} (${model.modelId}) with max ${effectiveMaxTokens} tokens`);

  let result;
  switch (model.provider) {
    case 'anthropic':
      result = await callAnthropicAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk);
      break;
    case 'google':
      result = await callGeminiTextAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk);
      break;
    default:
      // Fall back to non-streaming for unknown providers
      log.debug(`🌊 [TEXT STREAM] Provider ${model.provider} doesn't support streaming, falling back to regular call`);
      result = await callTextModel(prompt, maxTokens, modelOverride);
      if (onChunk) {
        onChunk(result.text, result.text);
      }
  }
  return { ...result, modelId: model.modelId };
}

/**
 * Backward compatibility alias for Claude API
 */
async function callClaudeAPI(prompt, maxTokens = 4096) {
  return callTextModel(prompt, maxTokens);
}

module.exports = {
  // Configuration
  TEXT_MODELS,
  getActiveTextModel,
  getTextModelName,
  calculateOptimalBatchSize,

  // API functions
  callTextModel,
  callTextModelStreaming,
  callAnthropicAPI,
  callAnthropicAPIStreaming,
  callGeminiTextAPI,
  callGeminiTextAPIStreaming,
  callClaudeAPI
};
