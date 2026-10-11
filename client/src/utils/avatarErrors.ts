// Localised avatar failure text (photo failures: photoFailureMessage in apiErrors.ts). The server's raw message is English and
// developer-styled ("Error: ..."), so the UI shows these and only logs the raw text.

/** HTTP status carried on errors thrown by services/api.ts (undefined for non-HTTP errors). */
export function errorStatusOf(error: unknown): number | undefined {
  const s = (error as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

const AVATAR_FAILED: Record<string, string> = {
  en: 'The avatar could not be created. Please try again.',
  de: 'Der Avatar konnte nicht erstellt werden. Bitte versuche es erneut.',
  fr: 'L\'avatar n\'a pas pu être créé. Veuillez réessayer.',
  it: 'Non è stato possibile creare l\'avatar. Riprova.',
};

const AVATAR_DAILY_LIMIT: Record<string, string> = {
  en: 'Daily avatar limit reached. Please try again tomorrow.',
  de: 'Das Tageslimit für Avatare ist erreicht. Bitte versuche es morgen wieder.',
  fr: 'La limite quotidienne d\'avatars est atteinte. Veuillez réessayer demain.',
  it: 'Limite giornaliero di avatar raggiunto. Riprova domani.',
};

const pick = (table: Record<string, string>, language: string) => table[language] || table.en;

/** 429 = the per-user daily avatar cap; everything else is a plain failure. */
export function avatarFailureMessage(language: string, status?: number): string {
  return status === 429 ? pick(AVATAR_DAILY_LIMIT, language) : pick(AVATAR_FAILED, language);
}
