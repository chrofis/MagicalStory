import type { Language } from '../types/story';

export const SUPPORTED_LANGUAGES: Language[] = ['en', 'de', 'fr', 'it'];
export const isLanguage = (v: unknown): v is Language => typeof v === 'string' && SUPPORTED_LANGUAGES.includes(v as Language);

/**
 * Language precedence AFTER load (decision #12): an explicit ?lang= wins, then the visitor's
 * stored choice. A pre-rendered page's language is only the first paint (so hydration matches
 * the server HTML); it never overrides a visitor who picked a language. Returns null when the
 * visitor expressed no preference, in which case the current (prerender) language stays.
 */
export function resolveVisitorLanguage(urlLang: unknown, storedLang: unknown): Language | null {
  if (isLanguage(urlLang)) return urlLang;
  if (isLanguage(storedLang)) return storedLang;
  return null;
}
