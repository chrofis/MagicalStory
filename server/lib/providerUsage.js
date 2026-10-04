'use strict';

/**
 * Provider usage objects → the pipeline's ONE usage shape.
 *
 *   { input_tokens, output_tokens, thinking_tokens }
 *
 * `addUsage` (storyJobPipeline) and `calculateTextCost` (config/models.js)
 * price `thinking_tokens` at the output rate ON TOP of `output_tokens`, so
 * `thinking_tokens` must hold exactly the reasoning tokens the vendor bills
 * that are NOT already inside `output_tokens`. The three wire formats differ
 * on exactly that point, which is why every call site reads usage through
 * this module instead of parsing it itself:
 *
 * - GEMINI (`usageMetadata`): `candidatesTokenCount` EXCLUDES thinking;
 *   `thoughtsTokenCount` is separate and billed at the output rate.
 *   Measured 2026-09-27 on gemini-2.5-flash: candidates 1, thoughts 790,
 *   total 804 = 13 + 1 + 790. Reading only the first two under-reported the
 *   entity check ~5-7x (thinking 1.1k-4.7k per call).
 * - xAI direct (`usage`, OpenAI-shaped): `completion_tokens` EXCLUDES
 *   `completion_tokens_details.reasoning_tokens`. Measured 2026-09-27 on
 *   grok-4.3: completion 1, reasoning 213, total 417 = 203 + 1 + 213.
 * - OpenRouter (`usage`, OpenAI-shaped): `completion_tokens` INCLUDES the
 *   reasoning tokens (textReplyGuard.js, measured 2026-09-11), so
 *   `thinking_tokens` stays 0 and `reasoning_tokens` is informational only.
 * - Anthropic needs no normaliser: `output_tokens` includes extended thinking.
 */

/** Gemini `usageMetadata` (REST or SDK `response.usageMetadata`). */
function geminiUsage(usageMetadata) {
  const um = usageMetadata || {};
  return {
    input_tokens: um.promptTokenCount || 0,
    output_tokens: um.candidatesTokenCount || 0,
    thinking_tokens: um.thoughtsTokenCount || 0,
  };
}

/** xAI (api.x.ai) chat-completions `usage`. */
function xaiUsage(usage) {
  const u = usage || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    thinking_tokens: u.completion_tokens_details?.reasoning_tokens || 0,
  };
}

/** OpenRouter chat-completions `usage`. Reasoning is already in output_tokens. */
function openRouterUsage(usage) {
  const u = usage || {};
  return {
    input_tokens: u.prompt_tokens || 0,
    output_tokens: u.completion_tokens || 0,
    thinking_tokens: 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens || 0,
    cached_input_tokens: u.prompt_tokens_details?.cached_tokens || 0,
  };
}

/** Sum normalised usages (for a call site that makes several calls). */
function sumUsage(usages) {
  const total = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
  for (const u of usages || []) {
    if (!u) continue;
    total.input_tokens += u.input_tokens || 0;
    total.output_tokens += u.output_tokens || 0;
    total.thinking_tokens += u.thinking_tokens || 0;
  }
  return total;
}

module.exports = { geminiUsage, xaiUsage, openRouterUsage, sumUsage };
