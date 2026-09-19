/**
 * Refusal guard for every GEMINI IMAGE / VISION reply — the sibling of
 * `textReplyGuard.js`, and the same inversion for the same reason.
 *
 * Until 2026-09-18 the image paths tested the candidate's finish reason with an
 * ALLOW-LIST OF REFUSALS:
 *
 *     finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT'
 *
 * — `images.js` (generateImageOnly), `evalPipeline.js` (`isBlockedResponse`,
 * and the P1 visual-inventory block test). Every OTHER refusal fell through as
 * if the call had succeeded: `RECITATION`, `LANGUAGE`, `BLOCKLIST`, `SPII`,
 * `OTHER`, `NO_IMAGE` and the whole `IMAGE_*` family — including `IMAGE_OTHER`,
 * which CLAUDE.md names as the avatar path's routine refusal mode and which is
 * recorded on staging (`job_1787984454250_n257i2cmk`: all three covers) and on
 * production (`job_1768749129515_etqzmleof`, `reason=OTHER`).
 *
 * So: a reason must be on the NATURAL list to pass. Everything else is a
 * refusal, a truncation, or unrecognised — and all three are named, never
 * silently treated as a completion.
 *
 * WHAT THIS MODULE DOES NOT DO — and the difference from the text guard.
 * `assessTextReply` stamps a verdict on a reply and NEVER throws, because a
 * paid text run must not die on a heuristic. The image call sites are the
 * opposite: a blocked image has no usable output at all, and they already
 * throw, `continue` to the next sanitisation level, or fall back to another
 * provider. This module therefore only CLASSIFIES; the caller keeps its own
 * control flow and decides what a block means for it.
 *
 * ONE SOURCE OF TRUTH. The reason vocabulary shared with the text path is
 * IMPORTED from `textReplyGuard.js`, never copied — a second hand-maintained
 * list is exactly the drift this codebase keeps paying for. Only the values
 * that cannot appear on a text call are declared here.
 */

const {
  NATURAL_STOP,
  TRUNCATING_STOP_REASONS,
  REFUSING_STOP_REASONS,
} = require('./textReplyGuard');

// ── Gemini image-only finish reasons ────────────────────────────────────────
// Enumerated 2026-09-18 from the proto the REST API is generated from —
// googleapis/googleapis, google/ai/generativelanguage/v1beta/
// generative_service.proto, `enum FinishReason` (18 values) and
// `enum BlockReason` (6 values). NOT from a repo comment and not from the SDK:
// the installed @google/generative-ai 0.24.1 enum carries 11 FinishReason
// values and stops at MALFORMED_FUNCTION_CALL — it knows none of the IMAGE_*
// family, and spells the block default `BLOCKED_REASON_UNSPECIFIED` where the
// proto says `BLOCK_REASON_UNSPECIFIED`. An SDK enum is a stale snapshot of
// this list, which is why the pass-list is the closed one.
//
// The values below are the ones `textReplyGuard`'s sets do not already carry
// (it holds safety / recitation / language / blocklist / prohibited_content /
// spii / escalation / content_filter / refusal, and deliberately omits the
// IMAGE_* family because those never reach a text call):
//
//   IMAGE_SAFETY             (11) generated images contain safety violations
//   IMAGE_PROHIBITED_CONTENT (14) generated images have other prohibited content
//   IMAGE_RECITATION         (17) image generation stopped due to recitation
//   IMAGE_OTHER              (15) image generation stopped, other issue
//   NO_IMAGE                 (16) an image was expected, none was generated
//   OTHER                     (5) "Unknown reason." — the provider aborted
//   FINISH_REASON_UNSPECIFIED (0) default value, unused; a candidate carrying
//                                 it delivered nothing
//   MALFORMED_FUNCTION_CALL  (10) the model's function call is invalid
//   UNEXPECTED_TOOL_CALL     (12) tool call with no tools enabled
//   TOO_MANY_TOOL_CALLS      (13) system exited after consecutive tool calls
//
// They are all `refusal` here, which in this module means ONE thing: the
// provider did not deliver a usable candidate. It spans a policy block and a
// provider-side abort alike, because every call site does the same thing with
// both — the distinction that matters to an operator is the literal reason,
// and the reason is always printed.
const IMAGE_REFUSAL_REASONS = new Set([
  'image_safety', 'image_prohibited_content', 'image_recitation', 'image_other',
  'no_image', 'other', 'finish_reason_unspecified',
  'malformed_function_call', 'unexpected_tool_call', 'too_many_tool_calls',
]);

// `promptFeedback.blockReason` is a SEPARATE, smaller enum on the same
// response: BLOCK_REASON_UNSPECIFIED, SAFETY, OTHER, BLOCKLIST,
// PROHIBITED_CONTENT, IMAGE_SAFETY. Exported for documentation and tests; the
// code never needs it, because ANY non-empty blockReason means the prompt was
// blocked — there is no "everything went fine" value that a response actually
// carries here.
const PROMPT_BLOCK_REASONS = new Set([
  'block_reason_unspecified', 'blocked_reason_unspecified',
  'safety', 'other', 'blocklist', 'prohibited_content', 'image_safety',
]);

/**
 * Which class a Gemini image/vision finish reason belongs to.
 *
 * 'natural' is the ONLY class that means the candidate is usable. `STOP` is
 * Gemini's; `stop` / `end_turn` ride along from `NATURAL_STOP` and are what the
 * synthesised Grok-vision and OpenRouter-vision envelopes in images.js stamp.
 *
 * @param {*} raw
 * @returns {'absent'|'natural'|'truncation'|'refusal'|'unknown'}
 */
function classifyImageFinishReason(raw) {
  if (raw == null) return 'absent';
  const v = String(raw).trim().toLowerCase();
  if (!v) return 'absent';
  if (IMAGE_REFUSAL_REASONS.has(v)) return 'refusal';
  if (REFUSING_STOP_REASONS.has(v)) return 'refusal';
  if (TRUNCATING_STOP_REASONS.has(v)) return 'truncation';
  if (NATURAL_STOP.has(v)) return 'natural';
  return 'unknown';
}

/**
 * The one verdict for a Gemini image or vision response.
 *
 * @param {object} data  the parsed Gemini response body
 * @returns {{
 *   blocked: boolean,     // the response carries nothing usable
 *   truncated: boolean,   // MAX_TOKENS — a cut reply, NOT a block (callers
 *                         // that retry with a smaller thinking budget key off
 *                         // this and must keep doing so)
 *   cls: 'absent'|'natural'|'truncation'|'refusal'|'unknown',
 *   reason: string|null,  // the literal provider value, for the operator
 *   source: 'promptFeedback'|'candidate'|'no-candidates'|null
 * }}
 */
function assessImageResponse(data) {
  const blockReason = data?.promptFeedback?.blockReason || null;
  if (blockReason) {
    return { blocked: true, truncated: false, cls: 'refusal', reason: String(blockReason), source: 'promptFeedback' };
  }
  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    return { blocked: true, truncated: false, cls: 'refusal', reason: 'no candidates', source: 'no-candidates' };
  }
  // A candidate may carry its own blockReason on some responses; it means the
  // same thing as the prompt-level one.
  const candBlock = data.candidates[0]?.blockReason || null;
  if (candBlock) {
    return { blocked: true, truncated: false, cls: 'refusal', reason: String(candBlock), source: 'candidate' };
  }
  const raw = data.candidates[0]?.finishReason;
  const cls = classifyImageFinishReason(raw);
  return {
    // UNKNOWN IS BLOCKED. The provider said something about how it stopped and
    // we do not know that it means "finished" — which is precisely the hole the
    // two-value allow-list left open for the IMAGE_* family.
    blocked: cls === 'refusal' || cls === 'unknown',
    truncated: cls === 'truncation',
    cls,
    reason: cls === 'absent' ? null : String(raw),
    source: cls === 'absent' ? null : 'candidate',
  };
}

/**
 * One-line human description of a block verdict, for a log line or an Error.
 * Always names the literal reason so an operator can see WHY a page is missing.
 *
 * @param {ReturnType<typeof assessImageResponse>} v
 */
function describeImageBlock(v) {
  if (!v || (!v.blocked && !v.truncated)) return 'not blocked';
  if (v.source === 'no-candidates') return 'no candidates in response';
  if (v.source === 'promptFeedback') return `prompt blocked (blockReason=${v.reason})`;
  if (v.cls === 'truncation') return `TRUNCATED (finishReason=${v.reason})`;
  if (v.cls === 'unknown') return `stopped for an UNRECOGNISED reason (finishReason=${v.reason})`;
  return `refused by the provider (finishReason=${v.reason})`;
}

/**
 * Always-informative one-liner for a site that EXPECTED an image or a text
 * answer and got neither: the block wording when the provider refused, and the
 * raw finish reason otherwise, so the message is never just "no image".
 *
 * @param {ReturnType<typeof assessImageResponse>} v
 */
function describeImageOutcome(v) {
  if (v && (v.blocked || v.truncated)) return describeImageBlock(v);
  return v && v.reason ? `finishReason=${v.reason}` : 'no finish reason reported';
}

module.exports = {
  assessImageResponse,
  classifyImageFinishReason,
  describeImageBlock,
  describeImageOutcome,
  IMAGE_REFUSAL_REASONS,
  PROMPT_BLOCK_REASONS,
};
