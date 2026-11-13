/**
 * The name box takes a NAME. Customers typed relationships into it ("Noah, Freund von Louis",
 * "Aurelia Schwester von Aria") and the raw string then reached every prompt and name lookup
 * (docs/decisions.md 2026-11-13). Limits: no comma, at most 3 words (covers "Anne Sophie Müller",
 * "Jean Luc Picard"; a relationship phrase has 4+) and 30 characters. The server also cuts a comma name
 * (server/lib/characterName.js); only this form can stop the no-comma form, because code must not read prose.
 */
export const CHARACTER_NAME_MAX_CHARS = 30;
export const CHARACTER_NAME_MAX_WORDS = 3;

export type CharacterNameProblem = 'comma' | 'tooLong' | null;

export function characterNameProblem(name: string): CharacterNameProblem {
  if (name.includes(',')) return 'comma';
  const trimmed = name.trim();
  if (trimmed.length > CHARACTER_NAME_MAX_CHARS) return 'tooLong';
  if (trimmed.split(/\s+/).filter(Boolean).length > CHARACTER_NAME_MAX_WORDS) return 'tooLong';
  return null;
}

const HINTS: Record<string, string> = {
  de: 'Bitte nur den Namen eingeben (kein Komma, höchstens 3 Wörter). Beziehungen wie «Bruder von Tilo» gehören ins Beziehungsraster oder in die Details.',
  fr: 'Entrez seulement le prénom (pas de virgule, 3 mots au maximum). Les liens comme « frère de Tilo » vont dans la grille des relations ou dans les détails.',
  it: 'Inserisci solo il nome (niente virgole, al massimo 3 parole). Le relazioni come «fratello di Tilo» vanno nella griglia delle relazioni o nei dettagli.',
  en: 'Please enter just the name (no comma, at most 3 words). Relationships like "brother of Tilo" belong in the relationship grid or the details.',
};

export function characterNameHint(language: string): string {
  return HINTS[language] || HINTS.en;
}
