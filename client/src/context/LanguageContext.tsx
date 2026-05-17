import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { Language } from '@/types/story';
import { translations, type TranslationStrings } from '@/constants/translations';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: TranslationStrings;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

const STORAGE_KEY = 'magicalstory_language';
const SUPPORTED: Language[] = ['en', 'de', 'fr', 'it'];
const isLanguage = (v: unknown): v is Language => typeof v === 'string' && SUPPORTED.includes(v as Language);

const isBrowser = typeof window !== 'undefined';

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
   * this is the source of truth — overrides URL/localStorage detection so the
   * server HTML and client hydration agree.
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

  useEffect(() => {
    if (!isBrowser) return;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch { /* ignore quota errors */ }
    document.documentElement.lang = language;
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
