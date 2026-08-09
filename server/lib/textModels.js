/**
 * Text Model API Module
 * Handles text generation via Anthropic Claude and Google Gemini APIs
 * Extracted from server.js for maintainability
 */

const { log } = require('../utils/logger');
const { TEXT_MODELS, MODEL_DEFAULTS } = require('../config/models');
const { withAnthropic, withGemini, withGrok } = require('./aiConcurrency');
const apiHealth = require('./apiHealth');
const { stripDataUriPrefix } = require('./r2');
const { recordTextUsage } = require('./usageContext');

// Map a text-model provider to its tokenUsage accounting key. Text Gemini
// calls bill to gemini_text (image/quality Gemini are tracked on their own
// paths); xAI text bills to grok.
const USAGE_PROVIDER_KEY = { anthropic: 'anthropic', google: 'gemini_text', xai: 'grok', openrouter: 'openrouter' };

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

      // Record rate-limit / overload hits (Anthropic 429/529 etc.) so they
      // surface in the daily summary. Best-effort, never blocks the retry.
      if (apiHealth.isLimitError(error)) apiHealth.recordApiError(error);

      // Check if error is retryable (network errors, timeouts, 5xx, 429).
      // Anthropic/xAI attach error.status on HTTP failures; retrying 4xx
      // other than 429 (rate limit) wastes quota on errors that won't fix
      // themselves (400 bad request, 401/403 auth, 422 validation).
      const isRetryable =
        error.code === 'UND_ERR_SOCKET' ||
        error.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        error.name === 'HeadersTimeoutError' ||
        error.message?.includes('Headers Timeout') ||
        error.message?.includes('aborted') ||
        error.message?.includes('terminated') ||
        error.message?.includes('reset') ||
        error.message?.includes('ECONNRESET') ||
        error.message?.includes('fetch failed') ||
        error.status === 429 ||
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
async function callAnthropicAPI(prompt, maxTokens, modelId, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  // Calculate timeout based on expected tokens (larger requests need more time)
  // Minimum 5 minutes, + 3 seconds per 1000 tokens for very large requests
  const timeoutMs = Math.max(300000, 180000 + Math.ceil(maxTokens / 1000) * 3000);

  // Build messages - optionally add assistant prefill to prevent preamble
  // Claude 4+ models don't support assistant prefill — move it into the prompt instead
  const supportsAssistantPrefill = !modelId.match(/claude-(sonnet|opus|haiku)-[4-9]/);
  let effectivePrompt = prompt;

  // Build user content — support vision (images) and/or a cacheable prefix.
  // options.cachePrefix: a large STABLE string (template/rules/bible) that
  // repeats across calls of the same type — marked with cache_control so
  // Anthropic bills it at ~10% on cache hits (5-min TTL). Prompt caching is
  // GA; no beta header needed on anthropic-version 2023-06-01.
  let userContent;
  if (options.images && options.images.length > 0) {
    userContent = [];
    if (options.cachePrefix) {
      userContent.push({ type: 'text', text: options.cachePrefix, cache_control: { type: 'ephemeral' } });
    }
    for (const img of options.images) {
      const base64 = stripDataUriPrefix(img);
      const mimeType = img.match(/^data:(image\/\w+);base64,/) ? img.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 }
      });
    }
    userContent.push({ type: 'text', text: prompt });
  } else if (options.cachePrefix) {
    userContent = [
      { type: 'text', text: options.cachePrefix, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: prompt }
    ];
  } else {
    userContent = prompt;
  }

  const messages = [{ role: 'user', content: userContent }];
  if (options.prefill && supportsAssistantPrefill) {
    messages.push({ role: 'assistant', content: options.prefill });
  } else if (options.prefill) {
    effectivePrompt = prompt + `\n\nIMPORTANT: Start your response EXACTLY with: ${options.prefill}`;
    messages[0] = { role: 'user', content: options.images ? [...userContent.slice(0, -1), { type: 'text', text: effectivePrompt }] : effectivePrompt };
  }

  const data = await withAnthropic(() => withRetry(async () => {
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
        messages
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
  }, { maxRetries: 2, baseDelay: 2000 }));

  // Extract token usage. With prompt caching, input_tokens is the NON-cached
  // (full-price) portion; cache_read_input_tokens are billed at ~10% and
  // cache_creation at ~1.25×. Surface them so cache effectiveness is visible.
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;
  const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
  const cacheCreationTokens = data.usage?.cache_creation_input_tokens || 0;

  if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0) {
    const cacheStr = cacheReadTokens > 0 || cacheCreationTokens > 0 ? ` (cache: ${cacheReadTokens.toLocaleString()} read / ${cacheCreationTokens.toLocaleString()} write)` : '';
    log.debug(`📊 [ANTHROPIC] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}${cacheStr}`);
  }

  // Prepend prefill to response only for models that support assistant prefill.
  // With assistant prefill, Claude continues AFTER the prefill (not including it), so we must prepend.
  // For Claude 4+ models, the prefill was moved into the prompt instruction, so Claude's response
  // already includes it — prepending would create invalid/doubled content.
  const responseText = (options.prefill && supportsAssistantPrefill) ? options.prefill + data.content[0].text : data.content[0].text;

  return {
    text: responseText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cache_creation_tokens: cacheCreationTokens
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
async function callAnthropicAPIStreaming(prompt, maxTokens, modelId, onChunk, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('Anthropic API key not configured (ANTHROPIC_API_KEY)');
  }

  // Build messages - optionally add assistant prefill to prevent preamble
  // Claude 4+ models don't support assistant prefill — move it into the prompt instead
  const supportsAssistantPrefill = !modelId.match(/claude-(sonnet|opus|haiku)-[4-9]/);
  const messages = [{ role: 'user', content: prompt }];
  if (options.prefill && supportsAssistantPrefill) {
    messages.push({ role: 'assistant', content: options.prefill });
  } else if (options.prefill) {
    messages[0] = { role: 'user', content: prompt + `\n\nIMPORTANT: Start your response EXACTLY with: ${options.prefill}` };
  }

  // Wrap entire request + stream reading in retry to handle mid-stream socket errors
  return await withRetry(async () => {
    console.log(`🌊 [STREAM] Starting streaming request to Anthropic (${maxTokens} max tokens)...`);
    const startTime = Date.now();

    // Timeout protection: overall max + stream inactivity detection
    const timeoutMs = Math.max(1500000, 900000 + Math.ceil(maxTokens / 1000) * 15000);
    const INACTIVITY_TIMEOUT_MS = 120000; // 120s with no data → abort
    const controller = new AbortController();
    const maxTimer = setTimeout(() => controller.abort(new Error(`streaming timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    let inactivityTimer;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(new Error('stream inactivity timeout (120s)')), INACTIVITY_TIMEOUT_MS);
    };

    try {
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
        messages
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(`Anthropic streaming API error (${res.status}): ${errorText}`);
      error.status = res.status;
      throw error;
    }

    // Process the SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let firstChunkTime = null;
    resetInactivity(); // Start inactivity timer after connection established

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          log.debug('🌊 [STREAM] Stream complete');
          break;
        }

        resetInactivity(); // Reset on every chunk received

        // Capture time-to-first-token (TTFT)
        if (!firstChunkTime && value) {
          firstChunkTime = Date.now();
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

    // Prepend prefill only for models that support assistant prefill (see comment above)
    const responseText = (options.prefill && supportsAssistantPrefill) ? options.prefill + fullText : fullText;

    return {
      text: responseText,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      },
      modelId,
      ttft: firstChunkTime ? firstChunkTime - startTime : null
    };
    } finally {
      clearTimeout(maxTimer);
      clearTimeout(inactivityTimer);
    }
  }, { maxRetries: 2, baseDelay: 2000 });
}

/**
 * Call Google Gemini API for text generation with streaming
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {string} modelId - The model ID to use
 * @param {function} onChunk - Callback function called with each text chunk
 * @returns {Promise<{text: string, usage: object, ttft: number|null}>}
 */
async function callGeminiTextAPIStreaming(prompt, maxTokens, modelId, onChunk, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  // Wrap entire request + stream reading in retry to handle mid-stream socket errors
  return await withRetry(async () => {
    console.log(`🌊 [STREAM] Starting streaming request to Gemini (${maxTokens} max tokens)...`);
    const startTime = Date.now();

    // Timeout protection: overall max + stream inactivity detection
    const timeoutMs = Math.max(1500000, 900000 + Math.ceil(maxTokens / 1000) * 15000);
    const INACTIVITY_TIMEOUT_MS = 120000; // 120s with no data → abort
    const controller = new AbortController();
    const maxTimer = setTimeout(() => controller.abort(new Error(`streaming timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    let inactivityTimer;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(new Error('stream inactivity timeout (120s)')), INACTIVITY_TIMEOUT_MS);
    };

    try {
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
          // Callers that are judging rather than writing pass 0 (see
          // EVAL_TEMPERATURE). Default stays 0.7 for generation.
          temperature: options?.temperature ?? 0.7
        }
      }),
      signal: controller.signal
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
    let firstChunkTime = null;
    resetInactivity(); // Start inactivity timer after connection established

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          log.debug('🌊 [GEMINI STREAM] Stream complete');
          break;
        }

        resetInactivity(); // Reset on every chunk received

        // Capture time-to-first-token (TTFT)
        if (!firstChunkTime && value) {
          firstChunkTime = Date.now();
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
      modelId,
      ttft: firstChunkTime ? firstChunkTime - startTime : null
    };
    } finally {
      clearTimeout(maxTimer);
      clearTimeout(inactivityTimer);
    }
  }, { maxRetries: 2, baseDelay: 2000 });
}

/**
 * Call Google Gemini API for text generation
 * Includes retry logic with fallback to gemini-2.0-flash on empty responses
 */
async function callGeminiTextAPI(prompt, maxTokens, modelId, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not configured (GEMINI_API_KEY)');
  }

  // PIPE-9: options used to be silently dropped on the google branch. Support the
  // common ones (system, prefill) additively; warn loudly for image inputs which
  // this text path cannot carry (callers must use the vision path instead).
  const prefill = options && options.prefill;
  if (options && Array.isArray(options.images) && options.images.length) {
    log.warn('⚠️ [GEMINI TEXT] image options are not supported by callGeminiTextAPI — use the vision path; images were ignored');
  }

  const callAPI = async (model) => {
    return withGemini(() => withRetry(async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const reqBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: options?.temperature ?? 0.7
        }
      };
      if (options && options.system) reqBody.systemInstruction = { parts: [{ text: options.system }] };
      // Prefill: seed a model turn so the model continues from it (e.g. '{' for JSON).
      if (prefill) reqBody.contents.push({ role: 'model', parts: [{ text: prefill }] });
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify(reqBody)
      });
      // fetch resolves (not rejects) on HTTP 429/5xx, so the old !response.ok
      // check OUTSIDE withRetry never retried rate limits. Throw here with
      // .status so withRetry backs off on 429/5xx.
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        const err = new Error(`Gemini API error (${res.status}): ${bodyText.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    }, { maxRetries: 2, baseDelay: 2000 }));
  };

  // callAPI throws on non-ok (after retries), so `response` is always ok here.
  let response = await callAPI(modelId);

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

    // Try fallback to Grok (no PROHIBITED_CONTENT issues), then a second Gemini
    // tier as last resort. NOTE: gemini-2.0-flash was RETIRED by Google (404),
    // so the last resort is gemini-2.5-flash-lite.
    const LAST_RESORT_GEMINI = 'gemini-2.5-flash-lite';
    if (modelId !== LAST_RESORT_GEMINI) {
      const grokFallbackModel = TEXT_MODELS['grok-4-fast'];
      if (grokFallbackModel && process.env.XAI_API_KEY) {
        log.warn(`⚠️  [GEMINI] No text response (${blockReason}), retrying with grok-4-fast...`);
        try {
          const grokResult = await callXaiAPI(prompt, maxTokens, grokFallbackModel.modelId, prefill ? { prefill } : {});
          return { ...grokResult, modelId: grokFallbackModel.modelId };
        } catch (grokErr) {
          log.warn(`⚠️  [GEMINI] Grok fallback also failed: ${grokErr.message}, trying ${LAST_RESORT_GEMINI}...`);
        }
      } else {
        log.warn(`⚠️  [GEMINI] No text response (${blockReason}), retrying with ${LAST_RESORT_GEMINI}...`);
      }

      response = await callAPI(LAST_RESORT_GEMINI);

      data = await response.json();

      if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
        throw new Error('No text in Gemini response (all fallbacks failed)');
      }
    } else {
      throw new Error('No text in Gemini response');
    }
  }

  // With a seeded model turn, Gemini returns only the continuation — prepend the
  // prefill so callers get the complete text (mirrors the Anthropic path).
  const geminiText = data.candidates[0].content.parts[0].text;
  return {
    text: prefill ? prefill + geminiText : geminiText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thinking_tokens: thinkingTokens
    }
  };
}

/**
 * Call an OpenRouter model (OpenAI-compatible chat/completions). Used for
 * A/B-testing Qwen / DeepSeek on eval + consolidation. Supports vision via
 * options.images (image_url content parts) for the Qwen-VL image-eval A/B.
 * Never the default for German story prose until an A/B proves quality.
 */
async function callOpenRouterAPI(prompt, maxTokens, modelId, options = {}) {
  // Delegates to the streaming implementation with no onChunk. Identical result
  // shape, and it inherits the two things this path could never have on its own:
  //   - immunity to undici's 300s headersTimeout, which killed any completion
  //     that took over five minutes (a non-streaming response sends no headers
  //     until it is finished)
  //   - live fastest-provider routing + the real cost OpenRouter reports
  // Keeping a second hand-rolled request here would mean maintaining those in
  // two places, which is how the streaming path ended up ahead of this one.
  return callOpenRouterAPIStreaming(prompt, maxTokens, modelId, null, options);
}

/**
 * Call xAI Grok API (OpenAI-compatible)
 */
async function callXaiAPI(prompt, maxTokens, modelId, options = {}) {
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    throw new Error('xAI API key not configured (XAI_API_KEY)');
  }

  const timeoutMs = Math.max(300000, 180000 + Math.ceil(maxTokens / 1000) * 3000);

  const messages = [{ role: 'user', content: prompt }];
  if (options.prefill) {
    // xAI supports assistant prefill like OpenAI
    messages.push({ role: 'assistant', content: options.prefill });
  }

  const data = await withGrok(() => withRetry(async () => {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        messages
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(`xAI API error (${res.status}): ${errorText}`);
      error.status = res.status;
      throw error;
    }

    return res.json();
  }, { maxRetries: 2, baseDelay: 2000 }));

  const inputTokens = data.usage?.prompt_tokens || 0;
  const outputTokens = data.usage?.completion_tokens || 0;

  if (inputTokens > 0 || outputTokens > 0) {
    log.debug(`📊 [XAI] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);
  }

  const responseText = data.choices?.[0]?.message?.content || '';
  // Prepend prefill if we used it (xAI continues after prefill)
  const fullText = options.prefill ? options.prefill + responseText : responseText;

  return {
    text: fullText,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Call xAI Grok API with streaming (OpenAI-compatible SSE)
 */
async function callXaiAPIStreaming(prompt, maxTokens, modelId, onChunk, options = {}) {
  const apiKey = process.env.XAI_API_KEY;

  if (!apiKey) {
    throw new Error('xAI API key not configured (XAI_API_KEY)');
  }

  const messages = [{ role: 'user', content: prompt }];
  if (options.prefill) {
    messages.push({ role: 'assistant', content: options.prefill });
  }

  return await withRetry(async () => {
    console.log(`🌊 [STREAM] Starting streaming request to xAI (${maxTokens} max tokens)...`);
    const startTime = Date.now();

    const timeoutMs = Math.max(1500000, 900000 + Math.ceil(maxTokens / 1000) * 15000);
    const INACTIVITY_TIMEOUT_MS = 120000;
    const controller = new AbortController();
    const maxTimer = setTimeout(() => controller.abort(new Error(`streaming timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    let inactivityTimer;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(new Error('stream inactivity timeout (120s)')), INACTIVITY_TIMEOUT_MS);
    };

    try {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          // Unset previously — the provider default (~1.0) is why the qwen
          // compliance/consolidator judges were non-reproducible.
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
          stream: true,
          stream_options: { include_usage: true },
          messages
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errorText = await res.text();
        const error = new Error(`xAI streaming API error (${res.status}): ${errorText}`);
        error.status = res.status;
        throw error;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let firstChunkTime = null;
      resetInactivity();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            log.debug('🌊 [XAI STREAM] Stream complete');
            break;
          }

          resetInactivity();

          if (!firstChunkTime && value) {
            firstChunkTime = Date.now();
          }

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              // OpenAI-compatible streaming format
              if (event.choices?.[0]?.delta?.content) {
                const chunk = event.choices[0].delta.content;
                fullText += chunk;
                if (onChunk) {
                  onChunk(chunk, fullText);
                }
              }

              // Usage info (may come in the final chunk)
              if (event.usage) {
                inputTokens = event.usage.prompt_tokens || inputTokens;
                outputTokens = event.usage.completion_tokens || outputTokens;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      log.debug(`📊 [XAI STREAM] Token usage - input: ${inputTokens.toLocaleString()}, output: ${outputTokens.toLocaleString()}`);

      const responseText = options.prefill ? options.prefill + fullText : fullText;

      return {
        text: responseText,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        },
        modelId,
        ttft: firstChunkTime ? firstChunkTime - startTime : null
      };
    } finally {
      clearTimeout(maxTimer);
      clearTimeout(inactivityTimer);
    }
  }, { maxRetries: 2, baseDelay: 2000 });
}

/**
 * Call OpenRouter with SSE streaming (OpenAI-compatible, same shape as xAI).
 *
 * WHY THIS EXISTS: the non-streaming call above cannot survive a generation
 * longer than five minutes. undici's default headersTimeout is 300000 ms, and a
 * non-streaming response sends no headers until the completion is finished, so
 * the request dies with "fetch failed" — which withRetry treats as retryable and
 * burns three times over. Reasoning models (DeepSeek V4 Pro) and 32k-token
 * reviews routinely cross that line. Streaming gets headers immediately, so the
 * ceiling never applies and an inactivity timer catches a genuinely dead stream.
 */
async function callOpenRouterAPIStreaming(prompt, maxTokens, modelId, onChunk, options = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OpenRouter API key not configured (OPENROUTER_API_KEY)');
  }

  // Same prompt assembly as the non-streaming path: cachePrefix carries required
  // content (OpenRouter just can't discount it), and vision goes as image_url parts.
  const fullPrompt = (options.cachePrefix || '') + prompt;
  let userContent;
  if (options.images && options.images.length > 0) {
    userContent = options.images.map(img => ({
      type: 'image_url',
      image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${stripDataUriPrefix(img)}` }
    }));
    userContent.push({ type: 'text', text: fullPrompt });
  } else {
    userContent = fullPrompt;
  }

  const messages = [{ role: 'user', content: userContent }];
  if (options.prefill) {
    messages.push({ role: 'assistant', content: options.prefill });
  }

  // ROUTING: OpenRouter serves one model from many upstream providers, and left
  // to itself it balances on price, not speed. Measured on the same call, same
  // day: deepseek-v4-pro returned 6,285 tokens in 1202s (5.2 tok/s) from Railway
  // while a local run of the same request got 12,687 tokens in 144s (88 tok/s) —
  // a 17x spread that is purely which upstream answered. Sorting by throughput
  // makes that the selection criterion instead of a lottery.
  // Cost note: this can pick a pricier provider for the same model, and
  // MODEL_PRICING has a single price per modelId — so we ask OpenRouter for the
  // ACTUAL cost of each call (usage.include) and prefer it over our estimate.
  const providerPref = process.env.OPENROUTER_PROVIDER_SORT || 'throughput';
  // An explicit order is the only lever that actually selects; sort is advisory
  // and drifts. Built from live throughput stats (openrouterRouting.js) and
  // cached, so it can't go stale the way a hand-written list would. Null on any
  // lookup failure → we still send sort:throughput.
  const fastOrder = providerPref === 'off'
    ? null
    : await require('./openrouterRouting').fastProviderOrder(modelId).catch(() => null);

  return await withRetry(async () => {
    console.log(`🌊 [STREAM] Starting streaming request to OpenRouter (${maxTokens} max tokens)...`);
    const startTime = Date.now();

    const timeoutMs = Math.max(1500000, 900000 + Math.ceil(maxTokens / 1000) * 15000);
    const INACTIVITY_TIMEOUT_MS = 120000;
    const controller = new AbortController();
    const maxTimer = setTimeout(() => controller.abort(new Error(`streaming timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    let inactivityTimer;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => controller.abort(new Error('stream inactivity timeout (120s)')), INACTIVITY_TIMEOUT_MS);
    };

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://magicalstory.ch',
          'X-Title': 'MagicalStory'
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          usage: { include: true },                      // real cost, not our estimate
          // Reasoning control. Measured on deepseek-v4-pro: {enabled:false}
          // takes reasoning tokens to zero (1.7x cheaper, 1.5x faster, same
          // answer). Do NOT use {effort:'low'} or {max_tokens:N} — both are
          // ignored and measured 9x MORE expensive than the baseline.
          ...(options.reasoning ? { reasoning: options.reasoning } : {}),
          // allow_fallbacks keeps the call alive if every pinned provider is
          // down — it drops to OpenRouter's own choice rather than failing.
          ...(providerPref !== 'off'
            ? { provider: fastOrder ? { order: fastOrder, allow_fallbacks: true } : { sort: providerPref } }
            : {}),
          messages
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        const errorText = await res.text();
        const error = new Error(`OpenRouter streaming API error (${res.status}): ${errorText}`);
        error.status = res.status;
        throw error;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let firstChunkTime = null;
      let upstream = null;      // which provider actually served this
      let actualCost = null;    // OpenRouter's real charge, when it reports one
      resetInactivity();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            log.debug('🌊 [OPENROUTER STREAM] Stream complete');
            break;
          }

          // OpenRouter emits ": OPENROUTER PROCESSING" SSE comments as keep-alives
          // while a slow provider spins up. They are not data lines (skipped
          // below), but they DO prove the connection is alive — so resetting the
          // inactivity timer on any bytes is what keeps a slow model from being
          // killed at 120s while it is still queued upstream.
          resetInactivity();

          if (!firstChunkTime && value) firstChunkTime = Date.now();

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);
              // Only `content` is the answer. Reasoning models also stream
              // `delta.reasoning`, which the non-streaming path never returned
              // either — including it here would corrupt every parsed response.
              if (event.choices?.[0]?.delta?.content) {
                const chunk = event.choices[0].delta.content;
                fullText += chunk;
                if (onChunk) onChunk(chunk, fullText);
              }
              // Which upstream served this — the single most useful field when a
              // model is inexplicably slow, and the one we were missing.
              if (event.provider && !upstream) upstream = event.provider;
              if (event.usage) {
                inputTokens = event.usage.prompt_tokens || inputTokens;
                outputTokens = event.usage.completion_tokens || outputTokens;
                if (typeof event.usage.cost === 'number') actualCost = event.usage.cost;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Throughput is the diagnostic: the same model on a different upstream has
      // measured 5 tok/s vs 88 tok/s. Without this line a slow route is invisible.
      const elapsedSec = (Date.now() - startTime) / 1000;
      const tps = outputTokens > 0 ? (outputTokens / elapsedSec).toFixed(1) : '0';
      log.info(
        `📊 [OPENROUTER STREAM] ${modelId} via ${upstream || 'unknown'} — ` +
        `in ${inputTokens.toLocaleString()}, out ${outputTokens.toLocaleString()}, ` +
        `${elapsedSec.toFixed(1)}s (${tps} tok/s)` +
        (actualCost !== null ? `, $${actualCost.toFixed(4)} actual` : '')
      );

      const responseText = options.prefill ? options.prefill + fullText : fullText;
      return {
        text: responseText,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          // direct_cost is the existing channel for providers that report a real
          // charge (Grok, Runware); addUsage already accumulates it. Populating
          // it keeps the breakdown honest now that throughput routing can land on
          // an upstream priced well above the single MODEL_PRICING entry —
          // measured 4x on deepseek-v4-pro via BaseTen.
          ...(actualCost !== null ? { direct_cost: actualCost } : {}),
        },
        modelId,
        provider: upstream,
        actualCost,
        ttft: firstChunkTime ? firstChunkTime - startTime : null
      };
    } finally {
      clearTimeout(maxTimer);
      clearTimeout(inactivityTimer);
    }
  }, { maxRetries: 2, baseDelay: 2000 });
}

/**
 * Main text model caller - routes to appropriate provider
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate (capped to model limit)
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callTextModel(prompt, maxTokens = 4096, modelOverride = null, options = {}) {
  // Use override if provided, otherwise use global active model
  let model = activeTextModel;
  let modelName = TEXT_MODEL;

  if (modelOverride && TEXT_MODELS[modelOverride]) {
    model = TEXT_MODELS[modelOverride];
    modelName = modelOverride;
    log.debug(`🔧 [TEXT] Using model override: ${modelOverride}`);
  }

  // Cap to the model's limit — and treat a null/0 request as "give me the
  // model's maximum" (owner, 2026-08-09). Hard-coded budgets at the call
  // sites silently truncated real work: the scene reviewer hit exactly 16000
  // output tokens, emitted rewritten briefs for pages 1-6 and was cut off
  // before pages 7, 12 and 13 — the ones it had correctly named as faulted.
  // The failure looked like the model ignoring instructions.
  const requested = (maxTokens == null || maxTokens <= 0) ? model.maxOutputTokens : maxTokens;
  const effectiveMaxTokens = Math.min(requested, model.maxOutputTokens);

  log.verbose(`🤖 [TEXT] Calling ${modelName} (${model.modelId}) with max ${effectiveMaxTokens} tokens`);

  let result;
  // Wall-clock per call, attached to usage below so the byFunction breakdown
  // carries a duration for EVERY function without each stage timing itself.
  const startedAt = Date.now();
  switch (model.provider) {
    case 'anthropic':
      result = await callAnthropicAPI(prompt, effectiveMaxTokens, model.modelId, options);
      break;
    case 'google':
      result = await callGeminiTextAPI(prompt, effectiveMaxTokens, model.modelId, options);
      break;
    case 'xai':
      result = await callXaiAPI(prompt, effectiveMaxTokens, model.modelId, options);
      break;
    case 'openrouter':
      result = await callOpenRouterAPI(prompt, effectiveMaxTokens, model.modelId, options);
      break;
    default:
      throw new Error(`Unknown provider: ${model.provider}`);
  }
  // Single source of truth for text usage: record EVERY call here so no caller
  // can silently escape accounting (see usageContext.js). No-op outside a job.
  if (result.usage && typeof result.usage === 'object') result.usage.elapsed_ms = Date.now() - startedAt;
  recordTextUsage(USAGE_PROVIDER_KEY[model.provider] || model.provider, result.usage, options.usageLabel, model.modelId);
  // Same chokepoint, same reason: every Lab stage's prompt is captured here so
  // no stage has to remember to stash it (see promptCapture.js). No-op outside
  // a Test Lab experiment.
  require('./promptCapture').recordPrompt(options.usageLabel || 'text', model.modelId, prompt, { kind: 'text' });
  return { ...result, modelId: model.modelId };
}

/**
 * Text model caller with streaming support
 * @param {string} prompt - The prompt to send
 * @param {number} maxTokens - Maximum tokens to generate
 * @param {function} onChunk - Callback for each text chunk
 * @returns {Promise<{text: string, usage: object}>}
 */
async function callTextModelStreaming(prompt, maxTokens = 4096, onChunk = null, modelOverride = null, options = {}) {
  // Use override if provided, otherwise use global active model
  let model = activeTextModel;
  let modelName = TEXT_MODEL;

  if (modelOverride && TEXT_MODELS[modelOverride]) {
    model = TEXT_MODELS[modelOverride];
    modelName = modelOverride;
    log.debug(`🔧 [TEXT STREAM] Using model override: ${modelOverride}`);
  }

  // Cap to the model's limit — and treat a null/0 request as "give me the
  // model's maximum" (owner, 2026-08-09). Hard-coded budgets at the call
  // sites silently truncated real work: the scene reviewer hit exactly 16000
  // output tokens, emitted rewritten briefs for pages 1-6 and was cut off
  // before pages 7, 12 and 13 — the ones it had correctly named as faulted.
  // The failure looked like the model ignoring instructions.
  const requested = (maxTokens == null || maxTokens <= 0) ? model.maxOutputTokens : maxTokens;
  const effectiveMaxTokens = Math.min(requested, model.maxOutputTokens);

  log.verbose(`🌊 [TEXT STREAM] Calling ${modelName} (${model.modelId}) with max ${effectiveMaxTokens} tokens`);

  let result;
  const streamStartedAt = Date.now();
  switch (model.provider) {
    case 'anthropic':
      result = await callAnthropicAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk, options);
      break;
    case 'google':
      result = await callGeminiTextAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk, options);
      break;
    case 'xai':
      result = await callXaiAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk, options);
      break;
    case 'openrouter':
      result = await callOpenRouterAPIStreaming(prompt, effectiveMaxTokens, model.modelId, onChunk, options);
      break;
    default:
      // Fall back to non-streaming for unknown providers
      log.debug(`🌊 [TEXT STREAM] Provider ${model.provider} doesn't support streaming, falling back to regular call`);
      // options must ride along — dropping it loses usageLabel, so the fallback's
      // tokens land in the daily summary unattributed.
      result = await callTextModel(prompt, maxTokens, modelOverride, options);
      if (onChunk) {
        onChunk(result.text, result.text);
      }
      // callTextModel already recorded usage for this fallback path — return early
      // to avoid double-counting.
      return { ...result, modelId: model.modelId };
  }
  if (result.usage && typeof result.usage === 'object') result.usage.elapsed_ms = Date.now() - streamStartedAt;
  recordTextUsage(USAGE_PROVIDER_KEY[model.provider] || model.provider, result.usage, options.usageLabel, model.modelId);
  require('./promptCapture').recordPrompt(options.usageLabel || 'text', model.modelId, prompt, { kind: 'text' });
  return { ...result, modelId: model.modelId };
}

/**
 * Backward compatibility alias for Claude API
 */
async function callClaudeAPI(prompt, maxTokens = 4096, modelOverride = null, options = {}) {
  return callTextModel(prompt, maxTokens, modelOverride, options);
}

module.exports = {
  // Configuration
  TEXT_MODELS,
  MODEL_DEFAULTS,
  getModelDefaults,
  getActiveTextModel,
  getTextModelName,
  calculateOptimalBatchSize,

  // Utility
  withRetry,

  // API functions
  callTextModel,
  callTextModelStreaming,
  callAnthropicAPI,
  callAnthropicAPIStreaming,
  callGeminiTextAPI,
  callGeminiTextAPIStreaming,
  callXaiAPI,
  callXaiAPIStreaming,
  callOpenRouterAPI,
  callClaudeAPI
};
