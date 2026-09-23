/**
 * ONE emotion vocabulary for the side that DECLARES a face and the side that
 * READS it (owner, 2026-09-23: "why not have emotion as enum output of both
 * generator and evaluator").
 *
 * The Art Director writes `characters[].emotion` from this list (injected into
 * all four brief-authoring templates through EXPRESSION_FIELD_RULE), and the
 * prompt-blind inventory writes `figures[].emotion` from the same list (injected
 * into image-inventory-unified.txt as {EMOTION_ENUM} at template load). Both
 * sides answer in the same closed words, so code compares two enum values and
 * never reads prose.
 *
 * Severity is the owner's "opposite + near miss" rule, and it is the ONLY thing
 * code decides here — classification belongs to the two prompts:
 *   positive vs negative                              -> CRITICAL
 *   two different negatives, or surprised vs another  -> MINOR
 *   same, or either side neutral / unreadable / off-list -> no finding
 * A neutral face is never a defect and never buys a repair (2026-09-22).
 */
'use strict';

/** The closed list, in the order the prompts show it. */
const EMOTIONS = Object.freeze(['happy', 'sad', 'angry', 'afraid', 'surprised', 'disgusted', 'neutral']);

/** The inventory's one extra answer: the face cannot be read. Never a defect. */
const EMOTION_UNREADABLE = 'unreadable';

/** Tone per emotion. `surprised` and `neutral` carry none. */
const EMOTION_TONE = Object.freeze({
  happy: 'positive',
  sad: 'negative', angry: 'negative', afraid: 'negative', disgusted: 'negative',
});

/** "`happy`, `sad`, …, or `neutral`" — the list as a prompt phrase. */
const EMOTION_ENUM_PHRASE = `${EMOTIONS.slice(0, -1).map(e => `\`${e}\``).join(', ')} or \`${EMOTIONS[EMOTIONS.length - 1]}\``;

/** An answer from the list, lower-cased, or null for anything else. */
function normalizeEmotion(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase().replace(/[.`"']/g, '');
  return EMOTIONS.includes(v) ? v : null;
}

/**
 * @param {string} intended  the brief's `characters[].emotion`
 * @param {string} seen      the inventory's `figures[].emotion`
 * @returns {null|'MINOR'|'CRITICAL'}
 */
function compareEmotion(intended, seen) {
  const a = normalizeEmotion(intended);
  const b = normalizeEmotion(seen);
  if (!a || !b || a === b || a === 'neutral' || b === 'neutral') return null;
  const ta = EMOTION_TONE[a];
  const tb = EMOTION_TONE[b];
  if (ta && tb && ta !== tb) return 'CRITICAL';
  return 'MINOR';
}

module.exports = {
  EMOTIONS, EMOTION_UNREADABLE, EMOTION_TONE, EMOTION_ENUM_PHRASE,
  normalizeEmotion, compareEmotion,
};
