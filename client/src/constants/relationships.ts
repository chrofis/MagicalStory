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

// A label in the shared table -> its typed key. A custom or sentinel label is absent: never guessed.
const KEY_BY_LABEL = new Map<string, string>();
for (const t of SHARED_TYPES) for (const label of labelsOf(t.labels)) KEY_BY_LABEL.set(label, t.key);

/** The typed key of a stored matrix label in any UI language, or null (custom label, sentinel, empty). */
export function relationshipKeyOf(label: string | undefined | null): string | null {
  if (!label) return null;
  return KEY_BY_LABEL.get(label.trim()) || null;
}

// Which way the ages must run for a type to make sense: 'older' = the first character (the cell's
// subject) must be the older one, 'younger' = the younger one.
const AGE_DIRECTION_BY_KEY: Record<string, 'older' | 'younger'> = {
  parentOf: 'older', grandparentOf: 'older', parentInLawOf: 'older',
  childOf: 'younger', grandchildOf: 'younger', childInLawOf: 'younger',
};

/**
 * True when the typed relationship cannot hold with the structured ages: the subject is the
 * parent/grandparent/parent-in-law of someone OLDER, or the child/grandchild/child-in-law of
 * someone YOUNGER. Decided from the age fields and the typed key only; a custom label never
 * warns (code does not read label text). Equal ages do not warn; a missing age never warns.
 */
export function relationshipAgeConflict(
  label: string | undefined | null,
  subjectAge: string | number | undefined | null,
  otherAge: string | number | undefined | null,
): boolean {
  const dir = AGE_DIRECTION_BY_KEY[relationshipKeyOf(label) || ''];
  if (!dir) return false;
  const parse = (v: string | number | undefined | null) => {
    const s = String(v ?? '').trim();
    return s === '' ? NaN : Number(s);
  };
  const a = parse(subjectAge);
  const b = parse(otherAge);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return dir === 'older' ? a < b : a > b;
}

const AGE_CONFLICT_TEXT: Record<Language, string> = {
  de: 'Bitte prüfen: Nach den Altersangaben passt diese Beziehung nicht (ein jüngerer Mensch kann nicht Elternteil oder Grosselternteil eines älteren sein). Sie können trotzdem weitermachen.',
  fr: 'À vérifier : d’après les âges indiqués, cette relation ne convient pas (une personne plus jeune ne peut pas être le parent ou le grand-parent d’une plus âgée). Vous pouvez quand même continuer.',
  it: 'Da controllare: secondo le età indicate questa relazione non torna (una persona più giovane non può essere genitore o nonno/a di una più anziana). Puoi comunque continuare.',
  en: 'Please check: going by the ages entered, this relationship does not fit (a younger person cannot be the parent or grandparent of an older one). You can still continue.',
};

export function relationshipAgeConflictText(lang: Language): string {
  return AGE_CONFLICT_TEXT[lang] || AGE_CONFLICT_TEXT.en;
}
