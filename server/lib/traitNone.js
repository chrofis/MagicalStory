'use strict';
/**
 * The ONE answer to "does this stored physical-trait value say none?" (glasses, other,
 * facialHair). bugs.json none-value-rules-disagree, docs/decisions.md 2026-11-13.
 *
 * Four readers each had their own rule (a word list in promptBuilders, only 'none' in
 * avatarOverrides, raw `!== 'none'` in styledAvatars and routes/avatars), so one stored
 * glasses "nein" printed "Glasses: nein" on the avatar sheet while the story prompts hid it.
 *
 * This is a closed sentinel set for a stored enum-like value that our own character form,
 * the photo analyzer and the migration write; it is NOT a reader of what a customer
 * typed. The form now writes 'none' (client/src/utils/traitSwitch.ts); the other words are
 * values written before that switch and stay here until scripts/admin/fix-trait-none-words.js
 * has repaired the stored rows. Do not add words: new "no" answers come from a switch.
 */
const NONE_WORDS = Object.freeze(['none', 'no', 'nein', 'aucun', 'niente', '-', 'keine']);
const NONE_SET = new Set(NONE_WORDS);

/** True for an empty value or a sentinel word: the trait is absent. */
function isNone(v) {
  return !v || NONE_SET.has(String(v).toLowerCase().trim());
}

module.exports = { isNone, NONE_WORDS };
