/**
 * Truncation guard for EVERY text-model reply (owner order, 2026-09-11:
 * "remove the token caps everywhere and install a guard everywhere that
 * detects truncated replies").
 *
 * A reply that stopped at the output ceiling looks, to every parser in this
 * codebase, like a shorter reply: fewer pages, fewer findings, an empty fault
 * list. Measured failures — the scene reviewer at exactly 16,000 tokens
 * (docs/decisions.md 2026-08-09), the Lab's 6-of-8 truncated reviews stored as
 * "reviewed" (2026-09-11), the text-repair pass parsing a cut reply as "nothing
 * to rewrite" (job_1787423677246) — were all invisible until someone read the
 * usage numbers by hand. `assessTextReply` runs inside callTextModel /
 * callTextModelStreaming, so every result carries `result.truncation` and a
 * suspected cut is logged at ERROR level and counted for /api/health/config.
 *
 * It never throws: a paid run must not die on a heuristic (gates are
 * guidelines). Callers whose downstream would treat a cut reply as complete
 * read `result.truncation.suspected` and fall back to their input.
 */

// Provider finish reasons that mean "stopped because the ceiling was reached":
// Anthropic `stop_reason: 'max_tokens'`, OpenAI-compatible (xAI, OpenRouter)
// `finish_reason: 'length'`, Gemini `finishReason: 'MAX_TOKENS'`.
const TRUNCATING_STOP = /^(max_tokens|length|MAX_TOKENS)$/;

// OpenRouter streams sometimes report `usage.cost` but no finish reason; a
// reply that lands within this fraction of the ceiling is treated as cut.
const NEAR_CAP_FRACTION = 0.99;

/**
 * Decide whether a text reply is (suspected) truncated.
 *
 * @param {object} result  the provider result: { text, usage:{output_tokens,
 *   direct_cost?}, stop_reason?, provider?, modelId? }
 * @param {object} [o]
 * @param {string|null} [o.model]       TEXT_MODELS key or model id (for the report)
 * @param {string|null} [o.provider]    provider name when the result has none
 * @param {number|null} [o.capInForce]  the max-tokens ceiling the call actually
 *   ran under — the number passed, or the model's maxOutputTokens
 * @param {number} [o.minMeaningfulChars=2000]  a reply longer than this that
 *   `parsedOk === false` is a format failure or a cut, never "found nothing"
 * @param {boolean|null} [o.parsedOk]  caller's parse verdict; null = not parsed here
 * @returns {{ suspected:boolean, reason:string|null, outputTokens:number|null,
 *   capInForce:number|null, stopReason:string|null, provider:string|null,
 *   model:string|null }}
 */
function assessTextReply(result, o = {}) {
  const { model = null, provider = null, capInForce = null, minMeaningfulChars = 2000, parsedOk = null } = o;
  const text = String((result && result.text) || '');
  const trimmed = text.trim();
  const usage = (result && result.usage) || {};
  const outputTokens = usage.output_tokens != null ? Number(usage.output_tokens) : null;
  const stopReason = (result && result.stop_reason) != null ? String(result.stop_reason) : null;
  const base = {
    suspected: false,
    reason: null,
    outputTokens,
    capInForce: capInForce != null ? Number(capInForce) : null,
    stopReason,
    provider: (result && result.provider) || provider || null,
    model: (result && result.modelId) || model || null,
  };
  if (!trimmed) return { ...base, suspected: true, reason: 'empty' };
  if (stopReason && TRUNCATING_STOP.test(stopReason)) return { ...base, suspected: true, reason: 'stop_reason' };
  // A REPORTED NATURAL STOP BEATS TOKEN ARITHMETIC (2026-09-11). The cap_hit and
  // near_cap rules below are inferences for providers that report no finish
  // reason at all; when the provider says it stopped on its own, the reply is
  // complete and the numbers cannot overrule it.
  //
  // Measured against OpenRouter (`openai/gpt-5.6-luna-pro`, 2026-09-11):
  //   - `completion_tokens` INCLUDES `completion_tokens_details.reasoning_tokens`
  //     — 161 completion tokens for a 110-character answer, 67 of them reasoning.
  //     Output tokens therefore have no fixed relation to the visible reply.
  //   - `max_tokens` is NOT enforced on that total: 300 requested, 965 returned.
  // Together those make `outputTokens >= capInForce` fire on complete replies —
  // the two false cap_hit suspects (arc_panel, plan_recheck) on
  // job_1789147573901_m3uam0nxi, both of whose replies were used normally.
  const naturalStop = stopReason && !TRUNCATING_STOP.test(stopReason);
  if (!naturalStop) {
    if (base.capInForce != null && outputTokens != null && outputTokens >= base.capInForce) {
      return { ...base, suspected: true, reason: 'cap_hit' };
    }
    if (!stopReason && base.capInForce != null && outputTokens != null
        && typeof usage.direct_cost === 'number' && outputTokens >= base.capInForce * NEAR_CAP_FRACTION) {
      return { ...base, suspected: true, reason: 'near_cap' };
    }
  }
  if (parsedOk === false && trimmed.length > minMeaningfulChars) return { ...base, suspected: true, reason: 'unparsed' };
  return base;
}

/** One-line human description of a truncation verdict (for logs and errors). */
function describeTruncation(t) {
  if (!t || !t.suspected) return 'not truncated';
  const tok = t.outputTokens != null ? `${t.outputTokens} output tokens` : '? output tokens';
  const cap = t.capInForce != null ? `cap ${t.capInForce}` : 'cap ?';
  switch (t.reason) {
    case 'empty': return `returned an EMPTY response (${tok})`;
    case 'stop_reason': return `TRUNCATED: stop_reason=${t.stopReason} at ${tok} (${cap})`;
    case 'cap_hit': return `TRUNCATED: ${t.outputTokens} output tokens hit the ${t.capInForce}-token ceiling`;
    case 'near_cap': return `TRUNCATED (suspected): ${tok} within 1% of the ${t.capInForce}-token ceiling, no finish reason reported`;
    case 'unparsed': return `unparseable reply (${tok}, ${cap}) — format failure or cut-off`;
    default: return `TRUNCATED (${t.reason}): ${tok}, ${cap}`;
  }
}

// Process-wide counter, reported on GET /api/health/config as `textTruncation`.
const stats = { suspected: 0, byReason: {}, byLabel: {}, last: null };

function noteTruncation(t, { usageLabel = null, preview = '' } = {}) {
  if (!t || !t.suspected) return;
  stats.suspected += 1;
  stats.byReason[t.reason] = (stats.byReason[t.reason] || 0) + 1;
  const label = usageLabel || 'text';
  stats.byLabel[label] = (stats.byLabel[label] || 0) + 1;
  stats.last = { at: new Date().toISOString(), usageLabel: label, model: t.model, provider: t.provider, reason: t.reason, outputTokens: t.outputTokens, capInForce: t.capInForce, stopReason: t.stopReason, preview: String(preview || '').slice(0, 120) };
}

function getTruncationStats() {
  return { suspected: stats.suspected, byReason: { ...stats.byReason }, byLabel: { ...stats.byLabel }, last: stats.last ? { ...stats.last } : null };
}

/** Test hook — never called in production code. */
function _resetTruncationStats() {
  stats.suspected = 0; stats.byReason = {}; stats.byLabel = {}; stats.last = null;
}

module.exports = { assessTextReply, describeTruncation, noteTruncation, getTruncationStats, _resetTruncationStats, TRUNCATING_STOP };
