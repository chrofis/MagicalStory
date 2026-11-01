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
const RELATIONSHIP_TYPES = require('../../shared/relationship-types.json').types;

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

// label (any language, trimmed) -> typed key. A label in the table is unique per
// language; a label that is not in the table (custom, legacy, sentinel) is absent.
const KEY_BY_LABEL = new Map();
for (const t of RELATIONSHIP_TYPES) {
  for (const label of labelsOf(t.labels)) KEY_BY_LABEL.set(label, t.key);
}
const TYPE_BY_KEY = new Map(RELATIONSHIP_TYPES.map(t => [t.key, t]));

/**
 * The typed key ('parentOf', 'childOf', 'olderSiblingOf', ...) of a stored matrix
 * label in ANY UI language, or null for anything not in
 * shared/relationship-types.json (a custom relationship, a legacy value, a
 * sentinel, empty). Never guessed: an unknown label is null.
 */
function relationshipKeyOf(label) {
  if (!label) return null;
  return KEY_BY_LABEL.get(String(label).trim()) || null;
}

/** The key of the inverse type ('parentOf' -> 'childOf'), or null for an unknown key. */
function inverseRelationshipKey(key) {
  const t = TYPE_BY_KEY.get(key);
  return t ? t.inverse : null;
}

// How close a family tie is for choosing who stands on a cover when the cast is
// larger than the cover cap (owner 2026-11-01 "Rank by role", docs/decisions.md).
// Direction is ignored on purpose: customers fill the matrix backwards ("Ludovica
// Genitore di Mamma" when Mamma is Ludovica's parent), so parentOf and childOf
// are the same tie. Anything not listed (friends, in-laws, strangers, unknown
// labels) is not a tier.
const FAMILY_TIER_BY_KEY = Object.freeze({
  parentOf: 1, childOf: 1,
  olderSiblingOf: 2, youngerSiblingOf: 2, grandparentOf: 2, grandchildOf: 2,
});
const NO_FAMILY_TIER = 3;

/**
 * The family tier (1 parent/child, 2 sibling or grandparent/grandchild, 3 none)
 * of the tie between two characters, reading BOTH matrix cells of the pair
 * ("A-B" and "B-A") and taking the closest.
 *
 * @param {Object<string,string>|null} relationships  inputData.relationships (localized labels, keyed "<idA>-<idB>")
 */
function familyTierBetween(relationships, idA, idB) {
  if (!relationships || typeof relationships !== 'object') return NO_FAMILY_TIER;
  let best = NO_FAMILY_TIER;
  for (const cell of [`${idA}-${idB}`, `${idB}-${idA}`]) {
    const tier = FAMILY_TIER_BY_KEY[relationshipKeyOf(relationships[cell])];
    if (tier && tier < best) best = tier;
  }
  return best;
}

module.exports = {
  familyTierBetween,
  NO_FAMILY_TIER,
  relationshipKeyOf,
  inverseRelationshipKey,
  RELATIONSHIP_TYPES,
  isNotSetRelationship,
  isStrangersRelationship,
  getNotSetRelationship,
  getStrangersRelationship,
  RELATIONSHIP_SENTINELS: SENTINELS,
};
