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
 * Since 2026-09-18 it guards more than cuts. The stop-reason test used to be a
 * BLACKLIST of truncating values, so a provider REFUSAL — Gemini SAFETY /
 * RECITATION / PROHIBITED_CONTENT, an OpenAI-shaped `content_filter`, an
 * Anthropic `refusal` — fell through as a clean natural completion. It is now
 * an ALLOW-LIST: only a reason known to mean "the model finished" passes, and
 * refusals, cuts and unrecognised reasons all fail loudly with the reason
 * named. See the enumeration below.
 *
 * It never throws: a paid run must not die on a heuristic (gates are
 * guidelines). Callers whose downstream would treat a cut or refused reply as
 * complete read `result.truncation.suspected` and fall back to their input.
 */

// ── Provider stop/finish reasons ────────────────────────────────────────────
// Enumerated from vendor docs and SDK types on 2026-09-18 (docs/decisions.md).
//
// THE ALLOW-LIST IS THE ONLY THING THAT GRANTS A PASS. Until 2026-09-18 this
// was one regex of TRUNCATING reasons and every other value fell through to
// "clean natural completion" — so a provider REFUSAL read as success. Measured
// against the then-current code: SAFETY, RECITATION, PROHIBITED_CONTENT,
// content_filter, Anthropic `refusal`, Anthropic
// `model_context_window_exceeded` and a value no provider has all returned
// "not truncated". Gemini's streaming path (textModels.js
// callGeminiTextAPIStreaming) returns whatever text arrived before a block with
// `stop_reason: 'SAFETY'` and no error, which is exactly that hole — and
// CLAUDE.md's avatar rule is explicit that a refusal must fail loudly, never
// ship an empty page.
//
// So: `NATURAL_STOP` is the whitelist, and anything not in it fails. The other
// two sets never grant a pass — they exist ONLY to word the diagnosis. A value
// that is in none of the three is `unknown` and fails loudly too, which is what
// makes this safe against reasons a provider invents later: OpenRouter's enum
// is formally open (`x-speakeasy-unknown-values: "allow"`), xAI publishes no
// enum at all, and Gemini's REST list has already grown past its own SDK.
//
// This reads a STRUCTURED field the provider returns. No prose is matched.

// Sourced: Anthropic `end_turn` / `stop_sequence` (StopReason union,
// anthropic-sdk-typescript messages.ts); OpenAI / OpenRouter / DeepSeek / Qwen
// `stop`; xAI documents BOTH `stop` and `end_turn` on the same field
// (docs.x.ai/openapi.json); Gemini `STOP`. `tool_calls` / `tool_use` /
// `function_call` end a turn the model chose to end — the text is complete as
// far as it intended — and this codebase sends no tools, so they stay a pass
// rather than a false alarm on a paid run. `eos` / `eos_token` are what several
// OSS upstreams OpenRouter routes to report as their native reason.
const NATURAL_STOP = new Set([
  'end_turn', 'stop_sequence', 'stop', 'eos', 'eos_token',
  'tool_use', 'tool_calls', 'function_call',
]);

// Stopped because room ran out — the reply is a fragment.
// Anthropic `max_tokens` (your ceiling) and `model_context_window_exceeded`
// (the model's) are the only provider that separates the two causes.
// `pause_turn` is Anthropic pausing a long-running turn: the docs say the reply
// is meant to be fed back for continuation, so it is an unfinished reply, not a
// completion. Gemini `MAX_TOKENS`; everyone OpenAI-shaped `length`.
const TRUNCATING_STOP_REASONS = new Set([
  'max_tokens', 'model_context_window_exceeded', 'pause_turn', 'length',
]);

// Blocked by a policy rather than finished. Anthropic `refusal` (streaming
// classifiers); Gemini's candidate-level block family; the OpenAI-shaped
// `content_filter` (OpenAI, OpenRouter's normalised value, DeepSeek).
// Gemini's IMAGE_* block family is deliberately absent: those come back from
// image calls, which never route through this text guard. Its SIBLING,
// server/lib/imageReplyGuard.js, owns them — it imports the three sets below
// and adds only the values that cannot reach a text call, so there is one copy
// of the shared vocabulary and not two (registry set `provider-refusal-guards`,
// scripts/admin/sibling-registry.json). If an IMAGE_* value ever did arrive
// here it lands in `unknown` and still fails loudly.
const REFUSING_STOP_REASONS = new Set([
  'refusal',
  'safety', 'recitation', 'language', 'blocklist', 'prohibited_content', 'spii', 'escalation',
  'content_filter',
]);

// Back-compat export, derived from the set above so there is ONE source of
// truth for what counts as truncation. Case-insensitive now: the old regex
// spelled out `max_tokens|length|MAX_TOKENS` literally and therefore missed
// `Length`, `MAX_tokens` and every other casing a provider might send.
const TRUNCATING_STOP = new RegExp(`^(${[...TRUNCATING_STOP_REASONS].join('|')})$`, 'i');

/**
 * Which class a single provider stop/finish reason belongs to.
 * @returns {'absent'|'natural'|'truncation'|'refusal'|'unknown'}
 */
function classifyStopReason(raw) {
  if (raw == null) return 'absent';
  const v = String(raw).trim().toLowerCase();
  if (!v) return 'absent';
  if (REFUSING_STOP_REASONS.has(v)) return 'refusal';
  if (TRUNCATING_STOP_REASONS.has(v)) return 'truncation';
  if (NATURAL_STOP.has(v)) return 'natural';
  return 'unknown';
}

/**
 * Every stop/finish reason carried by a result, wherever the provider nests it.
 *
 * `result.stop_reason` is what textModels.js normalises all four providers into
 * and is the usual single answer. The rest are tolerated because OpenRouter —
 * the route DeepSeek, Qwen and OpenAI all reach us by — passes the upstream's
 * RAW reason through as `native_finish_reason` alongside its own normalised
 * one, and because a caller may hand this guard a provider payload directly.
 */
function collectStopReasons(result) {
  if (!result || typeof result !== 'object') return [];
  const out = [];
  const push = (v) => { if (v != null && String(v).trim()) out.push(String(v).trim()); };
  push(result.stop_reason);
  push(result.native_finish_reason);
  push(result.finish_reason);
  push(result.finishReason);
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  if (choice) { push(choice.finish_reason); push(choice.native_finish_reason); }
  const candidate = Array.isArray(result.candidates) ? result.candidates[0] : null;
  if (candidate) push(candidate.finishReason);
  const seen = new Set();
  return out.filter((v) => { const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Which class wins when a result carries more than one reason. A refusal or a
// truncation anywhere beats a normalised `stop` — OpenRouter reporting `stop`
// while the upstream's native reason says SAFETY must not pass. `unknown` ranks
// LAST on purpose: an unrecognised companion value next to a recognised natural
// one is not evidence of failure, and ranking it above `natural` would invent
// false alarms out of every upstream whose vocabulary we have not enumerated.
const STOP_CLASS_RANK = { refusal: 3, truncation: 2, natural: 1, unknown: 0 };

/**
 * The one stop-reason verdict for a result.
 * @returns {{ cls:'absent'|'natural'|'truncation'|'refusal'|'unknown', value:string|null, all:string[] }}
 */
function resolveStopReason(result) {
  const all = collectStopReasons(result);
  if (!all.length) return { cls: 'absent', value: null, all };
  let best = null;
  for (const value of all) {
    const cls = classifyStopReason(value);
    if (!best || STOP_CLASS_RANK[cls] > STOP_CLASS_RANK[best.cls]) best = { cls, value };
  }
  return { ...best, all };
}

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
  // The reason that DECIDES the verdict, whichever field the provider put it in.
  const stop = resolveStopReason(result);
  const stopReason = stop.value;
  const base = {
    suspected: false,
    reason: null,
    outputTokens,
    capInForce: capInForce != null ? Number(capInForce) : null,
    stopReason,
    stopReasonClass: stop.cls,
    stopReasons: stop.all,
    provider: (result && result.provider) || provider || null,
    model: (result && result.modelId) || model || null,
  };
  // A REFUSAL IS NAMED BEFORE EMPTINESS. Both are loud, but "blocked by SAFETY"
  // tells the operator why the page is missing and "empty" does not.
  if (stop.cls === 'refusal') return { ...base, suspected: true, reason: 'refusal' };
  if (!trimmed) return { ...base, suspected: true, reason: 'empty' };
  if (stop.cls === 'truncation') return { ...base, suspected: true, reason: 'stop_reason' };
  // An UNRECOGNISED reason is the case the old blacklist passed silently. It
  // cannot default to OK: the provider said something about how it stopped and
  // we do not know that it means "finished".
  if (stop.cls === 'unknown') return { ...base, suspected: true, reason: 'unknown_stop' };
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
  // Only 'natural' and 'absent' reach here — every other class returned above.
  const naturalStop = stop.cls === 'natural';
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

/**
 * One-line human description of a reply verdict (for logs and errors).
 *
 * Covers refusals and unrecognised stops as well as cuts — the name is
 * historical, and every caller already phrases it as "<what> reply <this>".
 */
function describeTruncation(t) {
  if (!t || !t.suspected) return 'not truncated';
  const tok = t.outputTokens != null ? `${t.outputTokens} output tokens` : '? output tokens';
  const cap = t.capInForce != null ? `cap ${t.capInForce}` : 'cap ?';
  switch (t.reason) {
    case 'empty': return `returned an EMPTY response (${tok})`;
    case 'refusal': return `was REFUSED by the provider: stop_reason=${t.stopReason} at ${tok}`;
    case 'unknown_stop': return `stopped for an UNRECOGNISED reason: stop_reason=${t.stopReason} at ${tok} (${cap})`;
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
  stats.last = { at: new Date().toISOString(), usageLabel: label, model: t.model, provider: t.provider, reason: t.reason, outputTokens: t.outputTokens, capInForce: t.capInForce, stopReason: t.stopReason, stopReasonClass: t.stopReasonClass || null, preview: String(preview || '').slice(0, 120) };
}

function getTruncationStats() {
  return { suspected: stats.suspected, byReason: { ...stats.byReason }, byLabel: { ...stats.byLabel }, last: stats.last ? { ...stats.last } : null };
}

/** Test hook — never called in production code. */
function _resetTruncationStats() {
  stats.suspected = 0; stats.byReason = {}; stats.byLabel = {}; stats.last = null;
}

module.exports = {
  assessTextReply, describeTruncation, noteTruncation, getTruncationStats, _resetTruncationStats,
  classifyStopReason, resolveStopReason, collectStopReasons,
  NATURAL_STOP, TRUNCATING_STOP_REASONS, REFUSING_STOP_REASONS, TRUNCATING_STOP,
};
