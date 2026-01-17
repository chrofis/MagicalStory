/**
 * Text Model API Module
 * Handles text generation via Anthropic Claude and Google Gemini APIs
 * Extracted from server.js for maintainability
 */

const { log } = require('../utils/logger');
const { TEXT_MODELS, MODEL_DEFAULTS } = require('../config/models');

// Get active model from environment (legacy - prefer MODEL_DEFAULTS)
const TEXT_MODEL = process.env.TEXT_MODEL || 'claude-sonnet';
const activeTextModel = TEXT_MODELS[TEXT_MODEL] || TEXT_MODELS['claude-sonnet'];

/**
 * Retry wrapper with exponential backoff for transient failures
 * @param {Function} fn - Async function to retry
 * @param {Object} options - { maxRetries: 2, baseDelay: 2000, maxDelay: 30000 }
 * @returns {Promise} - Result of fn() or throws after all retries exhausted
 */
async function withRetry(fn, options = {}) {
  const { maxRetries = 2, baseDelay = 2000, maxDelay = 30000 } = options;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Check if error is retryable (network errors, timeouts, 5xx)
      const isRetryable =
        error.code === 'UND_ERR_SOCKET' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.message?.includes('terminated') ||
        error.message?.includes('reset') ||
        error.message?.includes('ECONNRESET') ||
        (error.status >= 500 && error.status < 600);

      if (!isRetryable || attempt === maxRetries) {
        throw lastError;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
      log.warn(`⚠️ [RETRY] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.message}. Retrying in ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Get model defaults - single source of truth for all model selections
 */
function getModelDefaults() {
  return { ...MODEL_DEFAULTS };
}

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

  const data = await withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(`Anthropic API error (${res.status}): ${errorText}`);
      error.status = res.status;
      throw error;
    }

    return res.json();
  }, { maxRetries: 2, baseDelay: 2000 });

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

  const response = await withRetry(async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(`Anthropic streaming API error (${res.status}): ${errorText}`);
      error.status = res.status;
      throw error;
    }

    return res;
  }, { maxRetries: 2, baseDelay: 2000 });

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

  // Always log token usage for debugging, even if 0
  log.debug(`📊 [ANTHROPIC STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  if (inputTokens === 0 && outputTokens === 0) {
    log.warn(`⚠️ [ANTHROPIC STREAM] No token usage captured! Buffer remaining: ${buffer.length} chars`);
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
  let thinkingTokens = 0;

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
            thinkingTokens = event.usageMetadata.thoughtsTokenCount || thinkingTokens;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Always log token usage for debugging, even if 0
  const thinkingInfo = thinkingTokens > 0 ? `, thinking: ${thinkingTokens.toLocaleString()}` : '';
  log.debug(`📊 [GEMINI STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${thinkingInfo}`);
  if (inputTokens === 0 && outputTokens === 0) {
    log.warn(`⚠️ [GEMINI STREAM] No token usage captured! Buffer remaining: ${buffer.length} chars`);
  }

  return {
    text: fullText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thinking_tokens: thinkingTokens
    },
    modelId
  };
}

/**
 * Call Google Gemini API for text generation
 * Includes retry logic with fallback to gemini-2.0-flash on empty responses
 */
async function callGeminiTextAPI(prompt, maxTokens, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  const callAPI = async (model) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    return fetch(url, {
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
  };

  let response = await callAPI(modelId);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${error}`);
  }

  let data = await response.json();

  // Extract token usage (including thinking tokens for Gemini 2.5)
  const inputTokens = data.usageMetadata?.promptTokenCount || 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0;
  const thinkingTokens = data.usageMetadata?.thoughtsTokenCount || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    const thinkingInfo = thinkingTokens > 0 ? `, thinking: ${thinkingTokens.toLocaleString()}` : '';
    log.debug(`📊 [GEMINI] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${thinkingInfo}`);
  }

  // Check for empty/blocked response and retry with fallback model
  if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
    const blockReason = data.promptFeedback?.blockReason || 'empty response';

    // Try fallback to gemini-2.0-flash if using a different model
    if (modelId !== 'gemini-2.0-flash') {
      log.warn(`⚠️  [GEMINI] No text response (${blockReason}), retrying with gemini-2.0-flash...`);
      response = await callAPI('gemini-2.0-flash');

      if (!response.ok) {
        throw new Error('No text in Gemini response (fallback also failed)');
      }

      data = await response.json();

      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        throw new Error('No text in Gemini response (both models failed)');
      }
    } else {
      throw new Error('No text in Gemini response');
    }
  }

  return {
    text: data.candidates[0].content.parts[0].text,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thinking_tokens: thinkingTokens
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

// =============================================================================
// TEXT CONSISTENCY CHECK
// Quality check for story text (spelling, grammar, flow)
// =============================================================================

/**
 * Evaluate story text for consistency and quality issues
 * Used for final quality checks before completing story generation
 *
 * @param {string} storyText - Full story text (all pages concatenated)
 * @param {string} language - Language code (e.g., 'de-ch', 'en', 'fr')
 * @param {Array<string>} characterNames - Names of main characters
 * @param {string} languageInstruction - Detailed language/spelling instructions
 * @param {string} languageLevel - Reading level ('1st-grade', 'standard', 'advanced')
 * @param {string} textModel - Model to use (should match story generation model)
 * @returns {Promise<object>} Text quality analysis result
 */
async function evaluateTextConsistency(storyText, language = 'en', characterNames = [], languageInstruction = '', languageLevel = 'standard', textModel = null) {
  try {
    if (!storyText || storyText.length < 100) {
      log.verbose('[TEXT CHECK] Story text too short for consistency check');
      return { quality: 'good', overallScore: 10, issues: [], summary: 'Text too short for analysis' };
    }

    // Use lazy-loaded prompt templates to avoid circular dependency
    const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
    const { getReadingLevel } = require('./storyHelpers');

    // Load prompt template
    const promptTemplate = PROMPT_TEMPLATES.textConsistencyCheck;
    if (!promptTemplate) {
      log.error('❌ [TEXT CHECK] Missing prompt template: text-consistency-check.txt');
      return null;
    }

    // Language name mapping (all supported variants)
    const languageNames = {
      'de-ch': 'Swiss German (de-ch)',
      'de-de': 'German Standard (de-de)',
      'de-de-north': 'German North (de-de-north)',
      'de-de-south': 'German South (de-de-south)',
      'de-at': 'Austrian German (de-at)',
      'de-it': 'South Tyrolean German (de-it)',
      'de': 'German (de)',
      'en': 'English (en)',
      'fr': 'French (fr)'
    };
    const languageName = languageNames[language] || language;

    // Get reading level and text formatting requirements
    const readingLevelText = getReadingLevel(languageLevel);
    const textFormatRequirements = `**Reading Level:** ${readingLevelText}

**Text Formatting Rules:**
- Write in flowing paragraphs with 2-4 sentences each
- Maximum 3-4 paragraphs per page
- Dialogues flow inline with the narrative text
- Scene changes or location changes should start a new page`;

    // Fill template - include detailed language/spelling instructions
    const prompt = fillTemplate(promptTemplate, {
      LANGUAGE: languageName,
      STORY_TEXT: storyText,
      CHARACTER_NAMES: characterNames.join(', ') || 'Not specified',
      LANGUAGE_INSTRUCTION: languageInstruction || `Write in ${languageName}.`,
      TEXT_FORMAT_REQUIREMENTS: textFormatRequirements
    });

    // Use same model as story generation for consistency
    const modelToUse = textModel || getActiveTextModel().modelId;
    log.info(`🔍 [TEXT CHECK] Checking story text (${storyText.length} chars, ${language}, model: ${modelToUse})`);

    // Use 16000 tokens (same as image evaluation) to avoid truncation
    const result = await callTextModel(prompt, 16000, null, modelToUse);

    if (!result?.text) {
      log.warn('⚠️  [TEXT CHECK] No response from text model');
      return null;
    }

    // Log token usage
    if (result?.usage) {
      log.debug(`📊 [TEXT CHECK] Token usage - input: ${result.usage.input_tokens || 0}, output: ${result.usage.output_tokens || 0}, model: ${modelToUse}`);
    }

    // Parse JSON response
    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const textCheck = JSON.parse(jsonMatch[0]);

        // Log summary
        const issueCount = textCheck.issues?.length || 0;
        if (issueCount > 0) {
          log.warn(`⚠️  [TEXT CHECK] Found ${issueCount} issue(s): ${textCheck.summary || 'see details'}`);
        } else {
          log.info(`✅ [TEXT CHECK] Text is well-written (score: ${textCheck.overallScore || 'N/A'})`);
        }

        return { ...textCheck, usage: result.usage, evaluationPrompt: prompt };
      }
    } catch (parseError) {
      log.error(`❌ [TEXT CHECK] Failed to parse response: ${parseError.message}`);
      log.debug(`Response was: ${result.text.substring(0, 500)}`);
    }

    return { evaluationPrompt: prompt }; // Return prompt even on parse failure for debugging
  } catch (error) {
    log.error(`❌ [TEXT CHECK] Error: ${error.message}`);
    return null;
  }
}

module.exports = {
  // Configuration
  TEXT_MODELS,
  MODEL_DEFAULTS,
  getModelDefaults,
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
  callClaudeAPI,

  // Text consistency check
  evaluateTextConsistency
};
