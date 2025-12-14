import { useLanguage } from '@/context/LanguageContext';
import type { Language } from '@/types/story';

const languages: { code: Language; flag: string; label: string }[] = [
  { code: 'en', flag: '🇬🇧', label: 'English' },
  { code: 'de', flag: '🇩🇪', label: 'Deutsch' },
  { code: 'fr', flag: '🇫🇷', label: 'Français' },
];

interface LanguageSelectorProps {
  variant?: 'dropdown' | 'buttons';
  showLabel?: boolean;
}

export function LanguageSelector({ variant = 'buttons', showLabel = false }: LanguageSelectorProps) {
  const { language, setLanguage } = useLanguage();

  if (variant === 'dropdown') {
    return (
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
        className="px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500"
      >
        {languages.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.flag} {lang.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <div className="flex gap-2">
      {languages.map((lang) => (
        <button
          key={lang.code}
          onClick={() => setLanguage(lang.code)}
          className={`
            px-3 py-2 rounded-lg transition-all duration-200
            ${language === lang.code
              ? 'bg-purple-100 text-purple-700 ring-2 ring-purple-500'
              : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
            }
          `}
          title={lang.label}
        >
          <span className="text-lg">{lang.flag}</span>
          {showLabel && <span className="ml-2">{lang.label}</span>}
        </button>
      ))}
    </div>
  );
}

export default LanguageSelector;
