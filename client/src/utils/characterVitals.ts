/**
 * Age and height in the character form (docs/decisions.md 2026-11-13). Mirror of
 * server/lib/characterVitals.js; the server refuses the same values on save.
 *
 * Age 0 is a real age ("under 1 year"). A height is whole centimetres 40-250: "1.10" (metres) was
 * stored and later read as 1 cm, so it is refused, never converted.
 */
export const HEIGHT_MIN_CM = 40;
export const HEIGHT_MAX_CM = 250;

export function heightProblem(raw: string | number | undefined | null): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (!/^\d{1,3}$/.test(s)) return true;
  const n = Number(s);
  return n < HEIGHT_MIN_CM || n > HEIGHT_MAX_CM;
}

const HEIGHT_HINTS: Record<string, string> = {
  de: 'Grösse in cm, z.B. 110 (zwischen 40 und 250, ganze Zahl).',
  fr: 'Taille en cm, p. ex. 110 (entre 40 et 250, nombre entier).',
  it: 'Altezza in cm, p. es. 110 (tra 40 e 250, numero intero).',
  en: 'Height in cm, e.g. 110 (between 40 and 250, whole number).',
};

export function heightHint(language: string): string {
  return HEIGHT_HINTS[language] || HEIGHT_HINTS.en;
}

const BABY_LABELS: Record<string, string> = {
  de: 'unter 1 Jahr',
  fr: "moins d'un an",
  it: 'meno di 1 anno',
  en: 'under 1 year',
};

/** The age as the customer reads it: "0" is "under 1 year", any other age is "<n> years" in the language. */
export function ageLabel(age: string | number | undefined | null, language: string): string {
  const s = String(age ?? '').trim();
  if (s === '') return '';
  if (Number(s) === 0) return BABY_LABELS[language] || BABY_LABELS.en;
  const unit = language === 'de' ? 'Jahre' : language === 'fr' ? 'ans' : language === 'it' ? 'anni' : 'years';
  return `${s} ${unit}`;
}

const GENDER_LABELS: Record<string, { male: string; female: string; missing: string }> = {
  de: { male: 'Männlich', female: 'Weiblich', missing: 'Geschlecht fehlt' },
  fr: { male: 'Masculin', female: 'Féminin', missing: 'Genre manquant' },
  it: { male: 'Maschile', female: 'Femminile', missing: 'Genere mancante' },
  en: { male: 'Male', female: 'Female', missing: 'Gender missing' },
};

/** The gender as the customer reads it. Gender is male or female only; an unset one reads "not chosen yet", never "Other". */
export function genderLabel(gender: string | undefined | null, language: string): string {
  const l = GENDER_LABELS[language] || GENDER_LABELS.en;
  return gender === 'male' ? l.male : gender === 'female' ? l.female : l.missing;
}

/** "a 7-year-old boy"; age 0 is "a baby boy" (never "a 0-year-old"). */
export function agedNoun(age: number, genderLabel: string): string {
  return age === 0 ? `a baby ${genderLabel}` : `a ${age}-year-old ${genderLabel}`;
}
