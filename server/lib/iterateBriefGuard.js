/**
 * Structural guard for the ITERATE round's rewritten scene brief.
 *
 * Measured failure (staging `job_1789207854566_l43qgl34w`, page 7, 2026-09-12):
 * the `scene_iterate` reply stopped mid-sentence at 1884 characters — inside a
 * character description ("Saira — a young adult young woman with dark") — and
 * carried no `---METADATA---` block at all. `extractSceneMetadata()` therefore
 * returned null, `newSceneMetadata` was persisted as null, and every downstream
 * reader of that block (cast, objects, character positions, text placement) got
 * nothing for that page. The page shipped with a wrong roster and the only
 * trace in the logs was one line about a missing `sceneIntent`.
 *
 * Why the generic truncation guard (textReplyGuard.js) could not catch it: the
 * reply was ~500 output tokens against qwen-plus's 32,768-token ceiling, so
 * `cap_hit` / `near_cap` cannot fire, and the caller never read
 * `result.truncation` anyway. A brief that is cut LONG BEFORE the ceiling is
 * only detectable structurally — the contract says prose + `---METADATA---` +
 * parseable JSON containing `sceneIntent`, and a cut reply fails that contract.
 *
 * This module decides usability; it never throws and never repairs. The caller
 * retries once and then REFUSES to overwrite the previous good brief (owner
 * standard: a truncated brief must fail loudly, never be silently persisted).
 */

const METADATA_MARKER = '---METADATA---';

/**
 * Is this iterate reply a usable scene brief?
 *
 * @param {string} text  the model's raw reply
 * @param {object} [o]
 * @param {object|null} [o.truncation]  `result.truncation` from callTextModel
 *   (textReplyGuard verdict). A suspected cut makes the brief unusable even
 *   when it happens to parse.
 * @param {function|null} [o.extractSceneMetadata]  injected parser; defaults to
 *   the real one in sceneMetadata.js
 * @returns {{ usable:boolean, reason:string|null, detail:string }}
 *   reason ∈ null | 'empty' | 'reply_truncated' | 'no_metadata_block'
 *   | 'metadata_unparseable' | 'no_scene_intent'
 */
function assessIterateBrief(text, o = {}) {
  const { truncation = null } = o;
  const extract = o.extractSceneMetadata || require('./sceneMetadata').extractSceneMetadata;
  const raw = String(text || '');
  const trimmed = raw.trim();

  if (!trimmed) {
    return { usable: false, reason: 'empty', detail: 'the model returned nothing' };
  }
  if (truncation && truncation.suspected) {
    const { describeTruncation } = require('./textReplyGuard');
    return { usable: false, reason: 'reply_truncated', detail: describeTruncation(truncation) };
  }
  // The METADATA MARKER IS NOT REQUIRED. `extractSceneMetadata` accepts three
  // shapes — prose + `---METADATA---` + JSON, prose + a fenced ```json block,
  // and bare JSON — and all three are real in stored rows (measured across 120
  // staging stories). Requiring the marker rejected `job_1787991502308_i9ah2221i`
  // pages, which are complete briefs in the fenced form. What the contract
  // actually requires is a metadata OBJECT that parses and carries sceneIntent;
  // the marker only sharpens the log line below.
  let meta = null;
  try {
    meta = extract(raw);
  } catch (err) {
    return { usable: false, reason: 'metadata_unparseable', detail: `parser threw: ${err.message}` };
  }
  if (!meta || !meta.fullData) {
    const had = trimmed.includes(METADATA_MARKER);
    return {
      usable: false,
      reason: had ? 'metadata_unparseable' : 'no_metadata_block',
      detail: had
        ? `a ${METADATA_MARKER} block is present but its JSON did not parse — reply ends: "${tail(trimmed)}"`
        : `no parseable scene metadata in ${trimmed.length} characters — reply ends: "${tail(trimmed)}"`,
    };
  }
  if (!meta.sceneIntent) {
    // Pre-existing contract (the image prompt's THIS IMAGE DEPICTS overview).
    return { usable: false, reason: 'no_scene_intent', detail: 'metadata JSON parsed but carries no sceneIntent' };
  }
  return { usable: true, reason: null, detail: 'well-formed brief' };
}

/** One-line human description of an unusable-brief verdict (for logs/errors). */
function describeIterateBrief(a) {
  if (!a || a.usable) return 'usable brief';
  return `${a.reason}: ${a.detail}`;
}

function tail(s) {
  return String(s).replace(/\s+/g, ' ').slice(-80);
}

module.exports = { assessIterateBrief, describeIterateBrief, METADATA_MARKER };
