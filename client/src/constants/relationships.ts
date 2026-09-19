import type { RelationshipType, LocalizedString } from '@/types/character';
import type { Language } from '@/types/story';
import sentinels from '../../../shared/relationship-sentinels.json';

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

export const relationshipTypes: RelationshipType[] = [
  { value: NOT_SET_RELATIONSHIP, inverse: NOT_SET_RELATIONSHIP },
  { value: { en: 'Best Friends with', de: 'Beste Freunde mit', fr: 'Meilleurs amis avec', it: 'Migliori amici con' }, inverse: { en: 'Best Friends with', de: 'Beste Freunde mit', fr: 'Meilleurs amis avec', it: 'Migliori amici con' } },
  { value: { en: 'Friends with', de: 'Freunde mit', fr: 'Amis avec', it: 'Amici con' }, inverse: { en: 'Friends with', de: 'Freunde mit', fr: 'Amis avec', it: 'Amici con' } },
  { value: { en: 'Married to', de: 'Verheiratet mit', fr: 'Marié(e) à', it: 'Sposato/a con' }, inverse: { en: 'Married to', de: 'Verheiratet mit', fr: 'Marié(e) à', it: 'Sposato/a con' } },
  { value: { en: 'In a relationship with', de: 'In einer Beziehung mit', fr: 'En relation avec', it: 'In relazione con' }, inverse: { en: 'In a relationship with', de: 'In einer Beziehung mit', fr: 'En relation avec', it: 'In relazione con' } },
  { value: { en: 'Older Sibling of', de: 'Älteres Geschwister von', fr: 'Frère/Sœur aîné(e) de', it: 'Fratello/Sorella maggiore di' }, inverse: { en: 'Younger Sibling of', de: 'Jüngeres Geschwister von', fr: 'Frère/Sœur cadet(te) de', it: 'Fratello/Sorella minore di' } },
  { value: { en: 'Younger Sibling of', de: 'Jüngeres Geschwister von', fr: 'Frère/Sœur cadet(te) de', it: 'Fratello/Sorella minore di' }, inverse: { en: 'Older Sibling of', de: 'Älteres Geschwister von', fr: 'Frère/Sœur aîné(e) de', it: 'Fratello/Sorella maggiore di' } },
  { value: { en: 'Parent of', de: 'Elternteil von', fr: 'Parent de', it: 'Genitore di' }, inverse: { en: 'Child of', de: 'Kind von', fr: 'Enfant de', it: 'Figlio/a di' } },
  { value: { en: 'Child of', de: 'Kind von', fr: 'Enfant de', it: 'Figlio/a di' }, inverse: { en: 'Parent of', de: 'Elternteil von', fr: 'Parent de', it: 'Genitore di' } },
  { value: { en: 'Grandparent of', de: 'Grosselternteil von', fr: 'Grand-parent de', it: 'Nonno/a di' }, inverse: { en: 'Grandchild of', de: 'Enkelkind von', fr: 'Petit-enfant de', it: 'Nipote di' } },
  { value: { en: 'Grandchild of', de: 'Enkelkind von', fr: 'Petit-enfant de', it: 'Nipote di' }, inverse: { en: 'Grandparent of', de: 'Grosselternteil von', fr: 'Grand-parent de', it: 'Nonno/a di' } },
  { value: { en: 'Parent-in-law of', de: 'Schwiegerelternteil von', fr: 'Beau-parent de', it: 'Suocero/a di' }, inverse: { en: 'Child-in-law of', de: 'Schwiegerkind von', fr: 'Bel-enfant de', it: 'Genero/Nuora di' } },
  { value: { en: 'Child-in-law of', de: 'Schwiegerkind von', fr: 'Bel-enfant de', it: 'Genero/Nuora di' }, inverse: { en: 'Parent-in-law of', de: 'Schwiegerelternteil von', fr: 'Beau-parent de', it: 'Suocero/a di' } },
  { value: { en: 'Rivals with', de: 'Rivalen mit', fr: 'Rivaux avec', it: 'Rivali con' }, inverse: { en: 'Rivals with', de: 'Rivalen mit', fr: 'Rivaux avec', it: 'Rivali con' } },
  { value: { en: 'Neighbors with', de: 'Nachbarn mit', fr: 'Voisins avec', it: 'Vicini di' }, inverse: { en: 'Neighbors with', de: 'Nachbarn mit', fr: 'Voisins avec', it: 'Vicini di' } },
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
