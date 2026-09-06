/**
 * Visual-Bible id guard — one definition of "this text still has a raw VB id
 * in it", one runtime WARN, one test assertion.
 *
 * WHY THIS EXISTS. `sanitizeVbIdsInPrompt` (promptBuilders.js) has been the
 * fix for the VB-id leak five times, and each time it was added to ONE more
 * prompt path (page prompts → covers → reference sheets → empty scenes →
 * inpaint edit instructions). The leak kept coming back because there was no
 * way to ASK, at the moment of a model call, whether the text still carried an
 * id. Staging `job_1788641639919_mpjwlzkf1` p8 leaked through a path nobody
 * had thought to sanitise (the feedback consolidator's INPUT), and the model
 * copied `["LOC006","ART001","ART007","LOC005.1"]` straight into its own
 * output plan.
 *
 * So: the sanitiser stays the fix, and this is the smoke alarm. It never
 * throws in production and never edits the text — a WARN naming the call label
 * is what makes the next new prompt path visible on the day it ships instead
 * of five stories later.
 *
 * The id grammar matches the sanitiser's, INCLUDING the dotted vantage form
 * (`LOC005.1` — one camera viewpoint of a location, see
 * prompts/story-unified.txt "vantages").
 */

const { log } = require('../utils/logger');

/** Pool prefixes the Visual Bible mints ids from. */
const VB_ID_POOLS = 'CHR|ANI|ART|LOC|VEH|CLO';

/**
 * A Visual Bible handle: pool prefix + digits + optional `.N` vantage suffix.
 * Global (`g`) — callers must not rely on `lastIndex` across calls; every
 * helper below builds its own copy.
 */
const VB_ID_PATTERN = new RegExp(`(?:${VB_ID_POOLS})\\d+(?:\\.\\d+)?`, 'g');

/**
 * Every VB id occurring in `text`, de-duplicated, in first-seen order.
 * @param {string} text
 * @returns {string[]}
 */
function findVbIds(text) {
  if (!text || typeof text !== 'string') return [];
  const hits = text.match(new RegExp(VB_ID_PATTERN.source, 'g'));
  return hits ? [...new Set(hits)] : [];
}

/**
 * Test/assertion form. Throws with the offending ids and a short excerpt.
 * Used by unit tests over rebuilt prompts — never on a production path,
 * because a thrown error in the middle of a paid generation is worse than a
 * leaked id (docs/decisions.md: "gates are guidelines").
 *
 * @param {string} text
 * @param {string} [label] - what this text is, for the failure message.
 */
function assertNoVbIds(text, label = 'text') {
  const ids = findVbIds(text);
  if (ids.length === 0) return;
  const first = String(text).indexOf(ids[0]);
  const excerpt = String(text).slice(Math.max(0, first - 90), first + 90).replace(/\n/g, ' ⏎ ');
  throw new Error(
    `${label} still contains raw Visual Bible id(s): ${ids.join(', ')} — near: "…${excerpt}…"`
  );
}

/**
 * Call labels for which a VB id in the prompt is CORRECT, not a leak.
 *
 * These are the stages that define or manipulate the id vocabulary itself:
 * the writer mints the ids, the Art Director cites them in `objects[]`, the
 * scene reviewer reads those citations back. Sanitising them would destroy the
 * contract — ids only become a leak once a stage asks a model to write free
 * prose, or asks an image model for pixels.
 *
 * Matched as a prefix set so a `testlab_` mirror of a legitimate stage is
 * legitimate too. An UNKNOWN label warns by design: a new prompt path is
 * exactly the thing this guard exists to surface.
 */
const VB_ID_LEGITIMATE_LABELS = [
  'arc_',
  'beats_clothing_review', 'beats_plan', 'beats_replan', 'beats_scene_expansion',
  'beats_scene_review', 'beats_story_bible',
  'clothing_review',
  'outline_review',
  'regen_expansion', 'regen_iterate', 'regen_refine', 'regen_scene',
  'scene_expansion', 'scene_iterate', 'scene_rewrite', 'scene_validation',
  'story_ideas',
];

/**
 * @param {string} label
 * @returns {boolean} true when raw ids belong in this call's prompt.
 */
function isVbIdLegitimateLabel(label) {
  const l = String(label || '').toLowerCase().replace(/^testlab_/, '');
  return VB_ID_LEGITIMATE_LABELS.some(p => l.startsWith(p));
}

/**
 * Runtime smoke alarm. WARNs (never throws, never edits) when a model-facing
 * text still carries a VB id at the moment of the call.
 *
 * @param {string} text - the assembled prompt / instruction.
 * @param {string} label - the call label (usageLabel, or a caller-supplied tag).
 * @param {{ kind?: string }} [opts] - `kind` is 'text' | 'image', for the log line.
 * @returns {string[]} the ids found (empty when clean).
 */
function warnIfVbIds(text, label, opts = {}) {
  if (isVbIdLegitimateLabel(label)) return [];
  const ids = findVbIds(text);
  if (ids.length === 0) return ids;
  const kind = opts.kind ? `${opts.kind} ` : '';
  const first = String(text).indexOf(ids[0]);
  const excerpt = String(text).slice(Math.max(0, first - 70), first + 70).replace(/\s+/g, ' ');
  log.warn(
    `[VB-ID-LEAK] ${kind}call "${label || '(unlabelled)'}" carries raw Visual Bible id(s) ` +
    `${ids.join(', ')} — the prompt was not run through sanitizeVbIdsInPrompt. Near: "…${excerpt}…"`
  );
  return ids;
}

/** Pool → the noun a reader can still act on when the id cannot be resolved. */
const GENERIC_NOUN = {
  CHR: 'the person', ANI: 'the animal', ART: 'the object',
  LOC: 'the place', VEH: 'the vehicle', CLO: 'the outfit',
};

/**
 * Scrub VB ids out of a model-facing text that has NO Visual Bible to resolve
 * them against.
 *
 * `sanitizeVbIdsInPrompt` is the real fix and is used whenever a bible is in
 * scope. Several model-facing texts genuinely have none — the evaluators take
 * a scene hint and an image, never the bible — and for those the choice is
 * between shipping the raw id and shipping a generic noun. The generic noun
 * wins on both counts: a vision judge cannot see "ART001" in a picture either
 * way, and the id is the token that gets echoed into a finding, copied into a
 * repair plan, and eventually lettered onto a page. The `where`/prose around
 * the id almost always names the thing anyway ("her red woollen hat").
 *
 * @param {string} text
 * @param {Object|null} [visualBible] - when present, the real sanitiser runs.
 * @param {number|null} [pageNumber]  - log attribution for the sanitiser.
 * @returns {string}
 */
function scrubVbIds(text, visualBible = null, pageNumber = null) {
  if (!text || typeof text !== 'string') return text;
  if (visualBible) {
    try {
      const { sanitizeVbIdsInPrompt } = require('./promptBuilders');
      return sanitizeVbIdsInPrompt(text, visualBible, pageNumber);
    } catch { /* fall through to the generic-noun pass */ }
  }
  return text.replace(new RegExp(VB_ID_PATTERN.source, 'g'),
    (id) => GENERIC_NOUN[id.slice(0, 3).toUpperCase()] || 'the object');
}

/**
 * The `INTERACTIONS_BLOCK` every evaluator renders, built once.
 *
 * Three evaluators built this line themselves (`- ${i.character} + ${i.object}:
 * ${i.where}`) and all three emitted `i.object` — a raw VB id — straight into
 * the judge's prompt, while the surrounding fields went through a strip pass.
 * sceneValidator.js even labelled its copy "before sanitization". One builder,
 * one scrub.
 *
 * @param {Array} interactions - metadata.interactions[]
 * @param {Object|null} [visualBible]
 * @returns {string} the block, or '(none declared)'.
 */
function formatInteractionsBlock(interactions, visualBible = null) {
  const list = Array.isArray(interactions) ? interactions : [];
  if (list.length === 0) return '(none declared)';
  const block = list
    .map(i => `- ${i?.character || '?'} + ${i?.object || '?'}: ${i?.where || '(no placement given)'}`)
    .join('\n');
  return scrubVbIds(block, visualBible) || '(none declared)';
}

module.exports = {
  VB_ID_POOLS,
  VB_ID_PATTERN,
  findVbIds,
  assertNoVbIds,
  warnIfVbIds,
  isVbIdLegitimateLabel,
  VB_ID_LEGITIMATE_LABELS,
  scrubVbIds,
  formatInteractionsBlock,
};
