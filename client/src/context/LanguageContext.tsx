import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from 'react';
import type { Language } from '@/types/story';
import { translations, type TranslationStrings } from '@/constants/translations';
import { isLanguage, resolveVisitorLanguage } from '@/utils/languagePreference';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TranslationStrings;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

const STORAGE_KEY = 'magicalstory_language';

const isBrowser = typeof window !== 'undefined';

// BCP-47 tag for the <html lang> attribute. The regional variant is used
// wherever one exists, matching og:locale (de_CH) and the hreflang table
// (de-CH/fr-CH/it-CH) — the site is written in Swiss German, Swiss French and
// Swiss Italian. Kept in sync with HTML_LANG in server/lib/seoMeta.js; without
// it here, hydration overwrote the server's de-CH back to a bare "de".
const HTML_LANG: Record<Language, string> = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH', en: 'en' };

function detectUrlLanguage(): Language | null {
  if (!isBrowser) return null;
  const params = new URLSearchParams(window.location.search);
  const lang = params.get('lang');
  return isLanguage(lang) ? lang : null;
}

function detectStoredLanguage(): Language | null {
  if (!isBrowser) return null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Detect the visitor's browser language. Walks navigator.languages in order
 * and returns the first one we support — only the primary subtag matters
 * ('fr-CH', 'fr-FR' and 'fr' all map to 'fr'; 'it-CH', 'it-IT' to 'it').
 * Unsupported primary subtags (Spanish, Portuguese, etc.) return null so
 * the caller falls through to the hardcoded German default.
 */
function detectBrowserLanguage(): Language | null {
  if (!isBrowser) return null;
  const tags = (navigator.languages && navigator.languages.length > 0)
    ? navigator.languages
    : navigator.language ? [navigator.language] : [];
  for (const tag of tags) {
    const primary = (tag || '').toLowerCase().split('-')[0];
    if (isLanguage(primary)) return primary;
  }
  return null;
}

interface LanguageProviderProps {
  children: ReactNode;
  /**
   * Initial language injected at SSR time. When present (pre-rendered routes),
   * it is only the FIRST PAINT so hydration matches the server HTML; the
   * visitor's ?lang= / stored language replaces it right after mount.
   */
  initialLanguage?: Language;
}

export function LanguageProvider({ children, initialLanguage }: LanguageProviderProps) {
  const [language, setLanguageState] = useState<Language>(() => {
    // SSR / pre-rendered: trust the value the prerender script picked.
    if (initialLanguage && isLanguage(initialLanguage)) return initialLanguage;
    // CSR: URL ?lang= takes priority, then stored preference, then browser
    // language (navigator.languages), then hardcoded German fallback. A
    // French-speaker visiting fresh now lands on French instead of German.
    return detectUrlLanguage() || detectStoredLanguage() || detectBrowserLanguage() || 'de';
  });

  // Pre-rendered first paint: adopt the visitor's own choice once hydrated.
  // `settled` keeps the persistence effect below from writing the prerender
  // language over the stored preference before this has read it.
  const settled = useRef(!initialLanguage);
  useEffect(() => {
    if (settled.current) return;
    settled.current = true;
    const preferred = resolveVisitorLanguage(detectUrlLanguage(), detectStoredLanguage());
    if (preferred && preferred !== language) setLanguageState(preferred);
    else document.documentElement.lang = HTML_LANG[language];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isBrowser || !settled.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch { /* ignore quota errors */ }
    document.documentElement.lang = HTML_LANG[language];
  }, [language]);

  // Listen for language changes from other tabs / components.
  useEffect(() => {
    if (!isBrowser) return;

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isLanguage(e.newValue)) {
        setLanguageState(e.newValue);
      }
    };

    const handleLanguageUpdate = () => {
      const saved = detectStoredLanguage();
      if (saved && saved !== language) setLanguageState(saved);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('languageUpdated', handleLanguageUpdate);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('languageUpdated', handleLanguageUpdate);
    };
  }, [language]);

  const setLanguage = (lang: Language) => setLanguageState(lang);
  const t = translations[language];

  return (
    <LanguageContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useTranslation must be used within a LanguageProvider');
  }
  return context;
}

// Alias for useTranslation
export const useLanguage = useTranslation;
