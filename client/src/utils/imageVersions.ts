// Image-version helpers shared by the history modal handlers.
//
// The history modal and the server speak DB `version_index`; the wizard stores
// `imageVersions` as an array that can be SPARSE (a deleted version leaves a gap),
// so indexing the array by versionIndex picks the wrong picture.

/**
 * Find the version entry carrying `versionIndex`. Falls back to the array position
 * ONLY when that entry has no versionIndex of its own (legacy rows, contiguous so
 * position == index) and reports it through `onLegacyFallback`. Returns undefined
 * when entries carry indexes but none matches: guessing would show another picture.
 */
export function findVersionByIndex<T extends { versionIndex?: number }>(
  versions: readonly T[] | null | undefined,
  versionIndex: number,
  onLegacyFallback?: (message: string) => void,
): T | undefined {
  if (!Array.isArray(versions)) return undefined;
  const byField = versions.find(v => v && v.versionIndex === versionIndex);
  if (byField) return byField;
  const byPosition = versions[versionIndex];
  if (byPosition && byPosition.versionIndex === undefined) {
    onLegacyFallback?.(`imageVersions entry at position ${versionIndex} has no versionIndex; using array position (legacy data)`);
    return byPosition;
  }
  return undefined;
}

export type RegenerationErrorKind = 'insufficient_credits' | 'rate_limited' | 'other';

export function regenerationErrorKind(status?: number): RegenerationErrorKind {
  if (status === 402) return 'insufficient_credits';
  if (status === 429) return 'rate_limited';
  return 'other';
}

const MESSAGES: Record<RegenerationErrorKind, Record<string, string>> = {
  insufficient_credits: {
    en: 'Not enough credits for this. Please top up your credits and try again.',
    de: 'Dafür reichen deine Credits nicht. Bitte lade Credits auf und versuche es erneut.',
    fr: 'Vous n\'avez pas assez de crédits. Veuillez recharger vos crédits et réessayer.',
    it: 'Crediti insufficienti. Ricarica i crediti e riprova.',
  },
  rate_limited: {
    en: 'Too many image requests in a short time. Please wait a moment and try again.',
    de: 'Zu viele Bildanfragen in kurzer Zeit. Bitte warte einen Moment und versuche es erneut.',
    fr: 'Trop de demandes d\'images en peu de temps. Veuillez patienter un instant et réessayer.',
    it: 'Troppe richieste di immagini in poco tempo. Attendi un momento e riprova.',
  },
  other: {
    en: 'The image could not be improved. Please try again.',
    de: 'Das Bild konnte nicht verbessert werden. Bitte versuche es erneut.',
    fr: 'L\'image n\'a pas pu être améliorée. Veuillez réessayer.',
    it: 'Non è stato possibile migliorare l\'immagine. Riprova.',
  },
};

/** Localised toast text for a failed "Nochmal" (iterate) call; the raw server text is only logged. */
export function iterateErrorMessage(language: string, status?: number): string {
  const table = MESSAGES[regenerationErrorKind(status)];
  return table[language] || table.en;
}

const TITLE_REPAINT_FAILED: Record<string, string> = {
  en: 'The title was saved, but repainting it on the cover failed. Please try the repaint again.',
  de: 'Der Titel wurde gespeichert, aber das Neumalen auf dem Cover ist fehlgeschlagen. Bitte versuche es erneut.',
  fr: 'Le titre a été enregistré, mais son application sur la couverture a échoué. Veuillez réessayer.',
  it: 'Il titolo è stato salvato, ma il ridisegno sulla copertina non è riuscito. Riprova.',
};

/** Title was saved but the repaint step failed. */
export function titleRepaintFailedMessage(language: string): string {
  return TITLE_REPAINT_FAILED[language] || TITLE_REPAINT_FAILED.en;
}

const SHARE_FAILED: Record<string, string> = {
  en: 'Sharing could not be changed. Please try again.',
  de: 'Die Freigabe konnte nicht geändert werden. Bitte versuche es erneut.',
  fr: 'Le partage n\'a pas pu être modifié. Veuillez réessayer.',
  it: 'Non è stato possibile modificare la condivisione. Riprova.',
};

export function shareFailedMessage(language: string): string {
  return SHARE_FAILED[language] || SHARE_FAILED.en;
}

/**
 * Turn sharing on/off on the server. Returns the new sharing state ONLY when the
 * server confirmed (res.ok); otherwise null, so the UI never claims a state the
 * server did not accept (a failed DELETE must not show "private" while the link is live).
 */
export async function setSharingOnServer(
  fetchFn: (url: string, init: RequestInit) => Promise<{ ok: boolean }>,
  storyId: string,
  enable: boolean,
  headers: Record<string, string>,
): Promise<boolean | null> {
  try {
    const res = await fetchFn(`/api/stories/${storyId}/share`, { method: enable ? 'POST' : 'DELETE', headers });
    return res.ok ? enable : null;
  } catch {
    return null;
  }
}
