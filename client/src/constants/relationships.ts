import type { RelationshipType, LocalizedString } from '@/types/character';
import type { Language } from '@/types/story';

export const relationshipTypes: RelationshipType[] = [
  { value: { en: 'Best Friends with', de: 'Beste Freunde mit', fr: 'Meilleurs amis avec' }, inverse: { en: 'Best Friends with', de: 'Beste Freunde mit', fr: 'Meilleurs amis avec' } },
  { value: { en: 'Friends with', de: 'Freunde mit', fr: 'Amis avec' }, inverse: { en: 'Friends with', de: 'Freunde mit', fr: 'Amis avec' } },
  { value: { en: 'Married to', de: 'Verheiratet mit', fr: 'Marié(e) à' }, inverse: { en: 'Married to', de: 'Verheiratet mit', fr: 'Marié(e) à' } },
  { value: { en: 'In a relationship with', de: 'In einer Beziehung mit', fr: 'En relation avec' }, inverse: { en: 'In a relationship with', de: 'In einer Beziehung mit', fr: 'En relation avec' } },
  { value: { en: 'Older Sibling of', de: 'Älteres Geschwister von', fr: 'Frère/Sœur aîné(e) de' }, inverse: { en: 'Younger Sibling of', de: 'Jüngeres Geschwister von', fr: 'Frère/Sœur cadet(te) de' } },
  { value: { en: 'Younger Sibling of', de: 'Jüngeres Geschwister von', fr: 'Frère/Sœur cadet(te) de' }, inverse: { en: 'Older Sibling of', de: 'Älteres Geschwister von', fr: 'Frère/Sœur aîné(e) de' } },
  { value: { en: 'Parent of', de: 'Elternteil von', fr: 'Parent de' }, inverse: { en: 'Child of', de: 'Kind von', fr: 'Enfant de' } },
  { value: { en: 'Child of', de: 'Kind von', fr: 'Enfant de' }, inverse: { en: 'Parent of', de: 'Elternteil von', fr: 'Parent de' } },
  { value: { en: 'Rivals with', de: 'Rivalen mit', fr: 'Rivaux avec' }, inverse: { en: 'Rivals with', de: 'Rivalen mit', fr: 'Rivaux avec' } },
  { value: { en: 'Neighbors with', de: 'Nachbarn mit', fr: 'Voisins avec' }, inverse: { en: 'Neighbors with', de: 'Nachbarn mit', fr: 'Voisins avec' } },
  { value: { en: 'Not Known to', de: 'Nicht bekannt mit', fr: 'Pas connu de' }, inverse: { en: 'Not Known to', de: 'Nicht bekannt mit', fr: 'Pas connu de' } },
];

export function getNotKnownRelationship(lang: Language): string {
  const notKnown = relationshipTypes.find(r => r.value.en === 'Not Known to');
  return notKnown ? notKnown.value[lang] : 'Not Known to';
}

export function isNotKnownRelationship(value: string): boolean {
  const notKnown = relationshipTypes.find(r => r.value.en === 'Not Known to');
  if (!notKnown) return false;
  return value === notKnown.value.en || value === notKnown.value.de || value === notKnown.value.fr;
}

export function getLocalizedRelationship(rel: LocalizedString, lang: Language): string {
  return rel[lang];
}

export function findInverseRelationship(value: string, lang: Language): string {
  for (const rel of relationshipTypes) {
    if (rel.value[lang] === value) {
      return rel.inverse[lang];
    }
  }
  return value;
}
