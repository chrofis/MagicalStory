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

function detectUrlLanguage(): Language | null {
  const params = new URLSearchParams(window.location.search);
  const lang = params.get('lang');
  if (lang && ['en', 'de', 'fr'].includes(lang)) return lang as Language;
  return null;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    // URL ?lang= param takes highest priority (used by hreflang SEO links)
    const urlLang = detectUrlLanguage();
    if (urlLang) return urlLang;
    // Saved preference from previous visit
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && ['en', 'de', 'fr'].includes(saved)) {
      return saved as Language;
    }
    // Default to German (Swiss market, matches server-side default).
    // This ensures Googlebot and first-time visitors see German content,
    // consistent with <html lang="de"> and German meta tags.
    return 'de';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, language);
    document.documentElement.lang = language;
  }, [language]);

  // Listen for language changes from other parts of the app (e.g., after login)
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue && ['en', 'de', 'fr'].includes(e.newValue)) {
        setLanguageState(e.newValue as Language);
      }
    };

    // Also listen for custom event for same-tab updates
    const handleLanguageUpdate = () => {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && ['en', 'de', 'fr'].includes(saved) && saved !== language) {
        setLanguageState(saved as Language);
      }
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('languageUpdated', handleLanguageUpdate);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('languageUpdated', handleLanguageUpdate);
    };
  }, [language]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
  };

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
