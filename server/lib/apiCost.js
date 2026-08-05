/**
 * Weekly AI API spend, from what the pipeline already records.
 *
 * Railway is only part of the bill. Every story writes `data.tokenUsage` with a
 * `byFunction` breakdown carrying, per function: the provider, the model ids,
 * token counts, and `direct_cost` for per-image providers. That is enough to
 * price a week without adding any new tracking.
 *
 * Pricing comes from server/config/models.js (MODEL_PRICING / calculateTextCost
 * / calculateImageCost) — the same tables the pipeline itself uses, so this
 * report can't drift from production's own cost accounting.
 *
 * SCOPE, stated honestly: this covers spend attributed to a STORY row. Work that
 * never lands on a story — Test Lab experiments, standalone avatar jobs — is not
 * counted here, so treat the total as "story generation spend", not the whole
 * provider invoice.
 */

'use strict';

const { calculateTextCost, calculateImageCost, MODEL_DEFAULTS } = require('../config/models');

const IMAGE_MODEL_RE = /image|imagine|flux|sdxl|ace/i;

// Some call sites record tokens without their model id — `cover_quality` is one,
// and it alone accounted for 86k untracked tokens over 30 days, which would have
// silently under-reported the bill. Falling back to the CONFIGURED default for
// that provider prices them instead of dropping them. Read from MODEL_DEFAULTS
// rather than hardcoded, so switching the quality model reprices the history
// too. Anything priced this way is counted in `estimatedTokens` so the report
// can distinguish measured from inferred.
const PROVIDER_FALLBACK_MODEL = {
  gemini_quality: MODEL_DEFAULTS.qualityEval,
  gemini_text: MODEL_DEFAULTS.utility,
  gemini: MODEL_DEFAULTS.utility,
  anthropic: MODEL_DEFAULTS.storyText,
  openrouter: MODEL_DEFAULTS.storyText,
};

// Per-image providers report real spend in direct_cost; token-priced providers
// report tokens. A function can be BOTH (e.g. an image call that also consumed
// text tokens for its prompt), so the two are summed rather than chosen between.
function pickTextModel(models) {
  if (!Array.isArray(models)) return null;
  // Prefer a model that isn't obviously an image model — those are priced per
  // image via direct_cost and would return 0 (plus a warning) from the text path.
  const textish = models.find((m) => typeof m === 'string' && !IMAGE_MODEL_RE.test(m));
  return textish || null;
}

function pickImageModel(models) {
  if (!Array.isArray(models)) return null;
  return models.find((m) => typeof m === 'string' && IMAGE_MODEL_RE.test(m)) || null;
}

function emptyBucket() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, directCost: 0, tokenCost: 0, total: 0 };
}

function addTo(bucket, { calls, input, output, thinking, direct, tokenCost }) {
  bucket.calls += calls;
  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.thinkingTokens += thinking;
  bucket.directCost += direct;
  bucket.tokenCost += tokenCost;
  bucket.total = bucket.directCost + bucket.tokenCost;
}

/**
 * @param {object} opts
 * @param {import('pg').Pool} opts.pool  database pool
 * @param {number} [opts.days=7]
 * @returns {Promise<object>} { days, stories, byProvider, byFunction, totals }
 */
async function buildApiCostReport({ pool, days = 7 }) {
  const { rows } = await pool.query(
    `SELECT data->'tokenUsage' AS usage
       FROM stories
      WHERE created_at > NOW() - ($1 || ' days')::interval
        AND data ? 'tokenUsage'`,
    [String(days)]
  );

  const byProvider = {};
  const byFunction = {};
  let unpriced = 0;
  let estimated = 0;

  for (const row of rows) {
    const bf = row.usage?.byFunction;
    if (!bf) continue;

    for (const [fnName, fn] of Object.entries(bf)) {
      if (!fn || !fn.calls) continue;

      const input = fn.input_tokens || 0;
      const output = fn.output_tokens || 0;
      const thinking = fn.thinking_tokens || 0;
      let direct = fn.direct_cost || 0;

      const textModel = pickTextModel(fn.models);
      const imageModel = pickImageModel(fn.models);

      let tokenCost = 0;
      if (input || output || thinking) {
        const fallback = PROVIDER_FALLBACK_MODEL[fn.provider];
        if (textModel) {
          tokenCost = calculateTextCost(textModel, {
            input_tokens: input, output_tokens: output, thinking_tokens: thinking,
          });
        } else if (!imageModel && fallback) {
          tokenCost = calculateTextCost(fallback, {
            input_tokens: input, output_tokens: output, thinking_tokens: thinking,
          });
          estimated += input + output + thinking;
        } else if (!imageModel) {
          // Tokens recorded, no identifiable model and no fallback. Count them so
          // the report can admit the gap rather than silently under-reporting.
          unpriced += input + output + thinking;
        }
        // If the only model is an image model, its tokens are NOT separately
        // billable — the call is priced per image below. Counting both would
        // double-charge it.
      }

      // Image providers normally report real spend in direct_cost. Some (Gemini
      // image) report only tokens, which left 5 calls showing $0.00. Fall back to
      // the per-image price so those stop reading as free.
      if (!direct && imageModel) {
        direct = calculateImageCost(imageModel, fn.calls);
      }

      const provider = fn.provider || 'unknown';
      byProvider[provider] ||= emptyBucket();
      byFunction[fnName] ||= emptyBucket();
      const payload = { calls: fn.calls, input, output, thinking, direct, tokenCost };
      addTo(byProvider[provider], payload);
      addTo(byFunction[fnName], payload);
    }
  }

  const sortDesc = (obj) =>
    Object.entries(obj).sort((a, b) => b[1].total - a[1].total).map(([name, v]) => ({ name, ...v }));

  const providers = sortDesc(byProvider);
  const functions = sortDesc(byFunction);
  const total = providers.reduce((s, p) => s + p.total, 0);

  return {
    days,
    stories: rows.length,
    providers,
    functions,
    unpricedTokens: unpriced,
    estimatedTokens: estimated,
    totals: {
      total,
      directCost: providers.reduce((s, p) => s + p.directCost, 0),
      tokenCost: providers.reduce((s, p) => s + p.tokenCost, 0),
      calls: providers.reduce((s, p) => s + p.calls, 0),
    },
    perStory: rows.length ? total / rows.length : 0,
    projectedMonthly: total * (30 / days),
  };
}

module.exports = { buildApiCostReport };
