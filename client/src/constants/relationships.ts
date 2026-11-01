import type { RelationshipType, LocalizedString } from '@/types/character';
import type { Language } from '@/types/story';
import sentinels from '../../../shared/relationship-sentinels.json';
import relationshipTypesJson from '../../../shared/relationship-types.json';

// The two sentinels are NOT relationships — they are answers about whether a
// relationship was given. Their labels live in shared/relationship-sentinels.json,
// the ONE table this file and server/lib/relationships.js both read, so the
// server can recognise a de/fr/it cell without a hand-copied string list.
//
//   NOT_SET    the default every matrix cell is seeded with. Says nothing, and
//              emits nothing to the writer.
//   STRANGERS  a deliberate choice: the user states these two are strangers.
//              That is a fact about the cast, and it does reach the writer.
//
// Both are symmetric — each is its own inverse.
export const NOT_SET_RELATIONSHIP: LocalizedString = sentinels.notSet;
export const STRANGERS_RELATIONSHIP: LocalizedString = sentinels.strangers;

// Values stored before the split (2026-09-19), when one value was both the
// auto-fill default and the only way to say "strangers". The two cases are not
// distinguishable retroactively, so every legacy occurrence reads as NOT SET.
const LEGACY_NOT_SET: LocalizedString[] = sentinels.legacyNotSet;

// The real types (everything between the two sentinels) come from
// shared/relationship-types.json, the ONE table the server also reads to map a
// stored label to a typed key. Order is the wizard's dropdown order.
type SharedRelationshipType = { key: string; inverse: string; labels: LocalizedString };
const SHARED_TYPES = relationshipTypesJson.types as SharedRelationshipType[];
const labelsByKey = new Map(SHARED_TYPES.map(t => [t.key, t.labels]));

export const relationshipTypes: RelationshipType[] = [
  { value: NOT_SET_RELATIONSHIP, inverse: NOT_SET_RELATIONSHIP },
  ...SHARED_TYPES.map(t => ({ value: t.labels, inverse: labelsByKey.get(t.inverse) as LocalizedString })),
  { value: STRANGERS_RELATIONSHIP, inverse: STRANGERS_RELATIONSHIP },
];

const labelsOf = (localized: LocalizedString): string[] =>
  (['en', 'de', 'fr', 'it'] as const).map(l => localized[l]).filter(Boolean);

const NOT_SET_LABELS = new Set<string>([
  ...labelsOf(NOT_SET_RELATIONSHIP),
  ...LEGACY_NOT_SET.flatMap(labelsOf),
]);
const STRANGERS_LABELS = new Set<string>(labelsOf(STRANGERS_RELATIONSHIP));

/** The label a fresh matrix cell is seeded with. */
export function getNotSetRelationship(lang: Language): string {
  return NOT_SET_RELATIONSHIP[lang] || NOT_SET_RELATIONSHIP.en;
}

/** The label of the deliberate "they do not know each other" choice. */
export function getStrangersRelationship(lang: Language): string {
  return STRANGERS_RELATIONSHIP[lang] || STRANGERS_RELATIONSHIP.en;
}

/** True when the cell is unanswered: empty, the default, or a legacy stored value. */
export function isNotSetRelationship(value: string | undefined | null): boolean {
  if (!value) return true;
  return NOT_SET_LABELS.has(value.trim());
}

/** True only for the deliberate strangers choice — which is a COMPLETE answer. */
export function isStrangersRelationship(value: string | undefined | null): boolean {
  if (!value) return false;
  return STRANGERS_LABELS.has(value.trim());
}

export function getLocalizedRelationship(rel: LocalizedString, lang: Language): string {
  return rel[lang] || rel.en;
}

export interface CustomRelationshipPair {
  forward: string;
  inverse: string;
}

export function findInverseRelationship(
  value: string,
  lang: Language,
  customRelationships: CustomRelationshipPair[] = []
): string {
  // First check built-in relationships (both sentinels are their own inverse)
  for (const rel of relationshipTypes) {
    if (rel.value[lang] === value) {
      return rel.inverse[lang] || rel.inverse.en;
    }
  }
  // Then check custom relationships (both directions)
  for (const custom of customRelationships) {
    if (custom.forward === value) {
      return custom.inverse;
    }
    if (custom.inverse === value) {
      return custom.forward;
    }
  }
  return value;
}
