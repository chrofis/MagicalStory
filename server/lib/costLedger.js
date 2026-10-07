'use strict';

/**
 * The per-job cost ledger: ONE place that turns a provider call into dollars
 * and books it. docs/decisions.md 2026-10-08 "Cost accounting: one pricer".
 *
 * Before this, three pricers disagreed (the spend cap, the headline total and
 * the Grok per-image table) and a bucket holding several models was priced at
 * the FIRST model of its set. Now every call is priced when it is recorded,
 * with the model it actually ran on (`priceUsage`, config/models.js), and the
 * result is added to the provider bucket, the function bucket and the running
 * job total. The headline total, the per-call api_usage events and the spend
 * cap all read those same numbers, so they cannot drift apart.
 *
 * Usage shapes: providerUsage.js. A call's `usage` may carry `direct_cost` (the
 * provider's own charge: OpenRouter, Runware, Grok per image), cache subsets
 * (`cached_input_tokens`, `cache_write_tokens`), `cut: true` (a stream that
 * never finished, booked with what it had reported) and `thinking_in_output`
 * (Anthropic: reasoning is inside output_tokens, so thinking_tokens 0 means
 * "inside output", not "none").
 */

const { priceUsage, pricingKnown } = require('../config/models');
const { log } = require('../utils/logger');

const tokenBucket = (extra = {}) => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, ...extra });
const fnBucket = (provider, withDirect = false) =>
  tokenBucket({ ...(withDirect ? { direct_cost: 0 } : {}), provider, models: new Set() });

/** A fresh job ledger with the standard provider and function buckets. */
function newTokenUsage() {
  return {
    anthropic: tokenBucket(),
    gemini_text: tokenBucket(),
    gemini_image: tokenBucket(),
    gemini_quality: tokenBucket(),
    // OpenRouter-hosted models. direct_cost carries OpenRouter's ACTUAL charge
    // (usage.cost): throughput-sorted routing can pick a pricier upstream than
    // MODEL_PRICING assumes, so the reported figure beats the estimate.
    openrouter: tokenBucket({ direct_cost: 0 }),
    // Runware/Grok report a charge per image instead of tokens.
    runware: { direct_cost: 0, calls: 0 },
    grok: { direct_cost: 0, calls: 0 },
    byFunction: {
      unified_story: fnBucket(null),
      scene_expansion: fnBucket(null),
      scene_iterate: fnBucket(null),
      cover_expansion: fnBucket(null),
      phantom_patch: fnBucket(null),
      cover_images: fnBucket('gemini_image', true),
      cover_quality: fnBucket('gemini_quality'),
      page_images: fnBucket('gemini_image', true),
      page_quality: fnBucket('gemini_quality'),
      inpaint: fnBucket(null, true),
      avatar_styled: fnBucket(null, true),
      avatar_costumed: fnBucket(null, true),
      consistency_check: fnBucket('gemini_quality'),
      text_check: fnBucket(null),
      scene_rewrite: fnBucket('anthropic'),
    },
  };
}

const modelIdOf = (modelName, usage) =>
  (typeof modelName === 'string' ? modelName : (modelName && (modelName.modelId || modelName.model)))
  || usage?.modelId || null;

const warnedUnpriced = new Set();

/**
 * Book one call. Returns { cost, unpriced }.
 * @param {object} tokenUsage - from newTokenUsage()
 * @param {string} provider - ledger key (anthropic / gemini_text / gemini_quality / gemini_image / openrouter / grok / runware)
 * @param {object} usage - normalised usage (providerUsage.js), optionally with direct_cost
 * @param {string|null} functionName - byFunction bucket; null books under 'unlabelled' so no call escapes the headline
 * @param {string|object|null} modelName - the model the call ran on
 */
function recordCall(tokenUsage, provider, usage, functionName = null, modelName = null) {
  // Idempotency guard: the text chokepoint records every callTextModel result;
  // if a caller ALSO hands the same usage object here, count it once. Marks the
  // object (non-enumerable) so a second add of the identical reference no-ops.
  if (usage && usage.__accounted) return { cost: 0, unpriced: false, duplicate: true };
  if (usage && typeof usage === 'object') {
    try { Object.defineProperty(usage, '__accounted', { value: true, configurable: true, enumerable: false }); } catch { /* frozen usage — skip guard */ }
  }

  const modelId = modelIdOf(modelName, usage);
  let cost = 0;
  let unpriced = false;
  if (usage && typeof usage === 'object') {
    if (usage.direct_cost != null) {
      cost = usage.direct_cost || 0;
    } else if (modelId && pricingKnown(modelId)) {
      cost = priceUsage(modelId, usage);
    } else if (usage.input_tokens || usage.output_tokens || usage.thinking_tokens || provider === 'gemini_image' || provider === 'grok' || provider === 'runware') {
      // No provider charge and no price for this model: say so, book $0, and
      // count it so the ledger shows how much of the total is unpriced.
      unpriced = true;
      const key = `${provider}|${functionName}|${modelId}`;
      if (!warnedUnpriced.has(key)) {
        warnedUnpriced.add(key);
        log.error(`❌ [COST] unpriced call: provider=${provider} function=${functionName} model=${modelId || 'none'} — booked $0 (no direct_cost and no MODEL_PRICING row)`);
      }
    }
  }

  const apply = (b, fnLevel) => {
    b.input_tokens = (b.input_tokens || 0) + (usage?.input_tokens || 0);
    b.output_tokens = (b.output_tokens || 0) + (usage?.output_tokens || 0);
    b.thinking_tokens = (b.thinking_tokens || 0) + (usage?.thinking_tokens || 0);
    // Subsets of output_tokens / input_tokens: recorded alongside, never added.
    if (usage?.reasoning_tokens) b.reasoning_tokens = (b.reasoning_tokens || 0) + usage.reasoning_tokens;
    if (usage?.cached_input_tokens) b.cached_input_tokens = (b.cached_input_tokens || 0) + usage.cached_input_tokens;
    if (usage?.cache_write_tokens) b.cache_write_tokens = (b.cache_write_tokens || 0) + usage.cache_write_tokens;
    if (usage?.thinking_in_output) b.thinking_in_output = true;
    if (usage?.cut) b.cut_calls = (b.cut_calls || 0) + 1;
    if (unpriced) b.unpriced_calls = (b.unpriced_calls || 0) + 1;
    b.calls += 1;
    b.cost = (b.cost || 0) + cost;
    if (usage?.direct_cost != null && b.direct_cost !== undefined) b.direct_cost += usage.direct_cost;
    if (fnLevel) {
      b.elapsed_ms = (b.elapsed_ms || 0) + (usage?.elapsed_ms || 0);
      // Marks a bucket whose `cost` is the sum of per-call prices. Older stored
      // buckets carry a `cost` priced at the bucket's first model (or none);
      // apiCost.js tells them apart by this.
      b.ledger = 2;
    }
  };

  if (usage && tokenUsage[provider]) apply(tokenUsage[provider], false);

  const fn = functionName || 'unlabelled';
  if (!tokenUsage.byFunction[fn]) tokenUsage.byFunction[fn] = fnBucket(null, true);
  const f = tokenUsage.byFunction[fn];
  apply(f, true);
  f.provider = provider;
  if (modelId) f.models.add(modelId);
  return { cost, unpriced };
}

/** The headline total: the sum of every call booked (== sum of the byFunction costs). */
function ledgerTotal(tokenUsage) {
  return Object.values(tokenUsage.byFunction).reduce((sum, f) => sum + (f.cost || 0), 0);
}

module.exports = { newTokenUsage, recordCall, ledgerTotal, modelIdOf };
