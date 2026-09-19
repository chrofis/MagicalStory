/**
 * Relationship sentinels, server side.
 *
 * The wizard matrix stores a LOCALIZED label per ordered character pair. Two of
 * those labels are sentinels rather than relationships, and the server has to
 * tell them apart from a real relationship before it puts a line in a prompt:
 *
 *   notSet     the auto-filled default. The user has not answered. Says nothing,
 *              so it contributes no line to any brief.
 *   strangers  a deliberate choice: the user has stated these two are strangers.
 *              That IS a fact about the cast, so it reaches the writer.
 *
 * The labels themselves live in shared/relationship-sentinels.json — the ONE
 * table this module and client/src/constants/relationships.ts both read. Before
 * 2026-09-19 the server compared the English literal 'Not Known to' only, so for
 * de/fr/it the guard never fired and every unanswered cell was handed to the arc
 * author as an assertion that the cast were strangers. The two files are
 * registered as siblings (scripts/admin/sibling-registry.json,
 * `relationship-sentinel-predicates`) because the STRINGS are shared but the
 * predicate is written once per runtime.
 */

const SENTINELS = require('../../shared/relationship-sentinels.json');

const LANGS = ['en', 'de', 'fr', 'it'];

const labelsOf = (localized) => LANGS.map(l => localized && localized[l]).filter(Boolean);

// Legacy values (pre-split, when one value was both the default and the only way
// to say "strangers") read as notSet: not distinguishable retroactively, and the
// safe reading is the one that emits nothing (owner 2026-09-19).
const NOT_SET_LABELS = new Set([
  ...labelsOf(SENTINELS.notSet),
  ...(SENTINELS.legacyNotSet || []).flatMap(labelsOf),
]);
const STRANGERS_LABELS = new Set(labelsOf(SENTINELS.strangers));

/** True when the cell says nothing: empty, the default, or a legacy stored value. */
function isNotSetRelationship(value) {
  if (!value) return true;
  return NOT_SET_LABELS.has(String(value).trim());
}

/** True only for the deliberate "they do not know each other" choice. */
function isStrangersRelationship(value) {
  if (!value) return false;
  return STRANGERS_LABELS.has(String(value).trim());
}

/** The label the matrix auto-fills with, in the story's language. */
function getNotSetRelationship(lang) {
  return SENTINELS.notSet[lang] || SENTINELS.notSet.en;
}

/** The label of the deliberate strangers choice, in the story's language. */
function getStrangersRelationship(lang) {
  return SENTINELS.strangers[lang] || SENTINELS.strangers.en;
}

module.exports = {
  isNotSetRelationship,
  isStrangersRelationship,
  getNotSetRelationship,
  getStrangersRelationship,
  RELATIONSHIP_SENTINELS: SENTINELS,
};
