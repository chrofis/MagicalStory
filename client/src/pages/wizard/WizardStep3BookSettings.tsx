import { useEffect } from 'react';
import { BookOpen, Globe } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { LanguageLevel, StoryLanguageCode } from '@/types/story';

// Story language options
const STORY_LANGUAGES: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-ch', name: 'Deutsch (Schweiz)', flag: '🇨🇭' },
  { code: 'de-de', name: 'Deutsch (Deutschland)', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

interface WizardStep3Props {
  languageLevel: LanguageLevel;
  onLanguageLevelChange: (level: LanguageLevel) => void;
  pages: number;
  onPagesChange: (pages: number) => void;
  storyLanguage: StoryLanguageCode;
  onStoryLanguageChange: (lang: StoryLanguageCode) => void;
  developerMode: boolean;
}

/**
 * Step 3: Book Settings
 * Handles book type (reading level) and page count selection
 */
export function WizardStep3BookSettings({
  languageLevel,
  onLanguageLevelChange,
  pages,
  onPagesChange,
  storyLanguage,
  onStoryLanguageChange,
  developerMode,
}: WizardStep3Props) {
  const { t, language } = useLanguage();

  // Available page options based on developer mode
  const availablePageOptions = developerMode
    ? [4, 10, 14, 20, 24, 30, 34, 40, 44, 50]
    : [10, 14, 20, 24, 30, 34, 40, 44, 50];

  // If current pages value is not in available options, reset to default (10)
  useEffect(() => {
    const validOptions = developerMode
      ? [4, 10, 14, 20, 24, 30, 34, 40, 44, 50]
      : [10, 14, 20, 24, 30, 34, 40, 44, 50];
    if (!validOptions.includes(pages)) {
      onPagesChange(10);
    }
  }, [pages, developerMode, onPagesChange]);

  const readingLevels = [
    {
      value: '1st-grade' as LanguageLevel,
      label: t.firstGrade,
      desc: t.firstGradeDesc,
      image: '/images/text and image on each page.jpg',
    },
    {
      value: 'standard' as LanguageLevel,
      label: t.standard,
      desc: t.standardDesc,
      image: '/images/left page text, right page image.jpg',
    },
    {
      value: 'advanced' as LanguageLevel,
      label: t.advanced,
      desc: t.advancedDesc,
      image: '/images/dense text left.jpg',
    },
  ];

  // Generate page option label based on language level
  const getPageLabel = (pageCount: number, isTest = false) => {
    const testSuffix = isTest ? ' (Test)' : '';
    const creditsCost = pageCount * 10;
    const creditsLabel = language === 'de' ? 'Credits' : language === 'fr' ? 'crédits' : 'credits';

    if (languageLevel === '1st-grade') {
      return `${pageCount} ${language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'} = ${creditsCost} ${creditsLabel}${testSuffix}`;
    }
    const textPages = Math.floor(pageCount / 2);
    const imagePages = Math.floor(pageCount / 2);
    if (language === 'de') {
      return `${pageCount} Seiten (${textPages} Text + ${imagePages} Bilder) = ${creditsCost} ${creditsLabel}${testSuffix}`;
    } else if (language === 'fr') {
      return `${pageCount} pages (${textPages} texte + ${imagePages} images) = ${creditsCost} ${creditsLabel}${testSuffix}`;
    }
    return `${pageCount} pages (${textPages} text + ${imagePages} images) = ${creditsCost} ${creditsLabel}${testSuffix}`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <BookOpen size={24} />
        {language === 'de' ? 'Buchformat' : language === 'fr' ? 'Format du livre' : 'Book Format'}
      </h2>

      {/* Story Language Selection */}
      <div>
        <label className="block text-xl font-semibold mb-3 flex items-center gap-2">
          <Globe size={20} />
          {language === 'de' ? 'Sprache der Geschichte' : language === 'fr' ? 'Langue de l\'histoire' : 'Story Language'}
        </label>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {STORY_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              onClick={() => onStoryLanguageChange(lang.code)}
              className={`px-4 py-3 rounded-lg border-2 font-medium transition-all flex items-center justify-center gap-2 ${
                storyLanguage === lang.code
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-200'
                  : 'border-gray-200 hover:border-indigo-300'
              }`}
            >
              <span className="text-lg">{lang.flag}</span>
              <span className="text-sm">{lang.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Reading Level Selection */}
      <div>
        <label className="block text-xl font-semibold mb-3">{t.readingLevel}</label>
        <div className="flex overflow-x-auto gap-3 pb-2 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:pb-0 -mx-4 px-4 md:mx-0 md:px-0">
          {readingLevels.map((level) => (
            <button
              key={level.value}
              onClick={() => onLanguageLevelChange(level.value)}
              className={`flex-shrink-0 w-40 md:w-auto text-left rounded-lg border-2 transition-all overflow-hidden ${
                languageLevel === level.value
                  ? 'border-indigo-600 ring-2 ring-indigo-200'
                  : 'border-gray-200 hover:border-indigo-300'
              }`}
            >
              <div className="w-full bg-gray-100 p-2 h-28 md:h-auto">
                <img
                  src={level.image}
                  alt={level.label}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="p-2 md:p-3">
                <div className="font-semibold text-sm md:text-base mb-1">{level.label}</div>
                <div className="text-xs md:text-sm text-gray-500 whitespace-pre-line">{level.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Number of Pages - shown after reading level is selected */}
      {languageLevel && (
        <div>
          <label className="block text-xl font-semibold mb-3">
            {t.numberOfPages}
          </label>
          <select
            value={pages}
            onChange={(e) => onPagesChange(parseInt(e.target.value))}
            className="w-full px-4 py-3 border-2 border-indigo-200 rounded-lg focus:border-indigo-600 focus:outline-none text-base md:text-lg font-semibold"
          >
            {availablePageOptions.map((pageOption) => (
              <option key={pageOption} value={pageOption}>
                {getPageLabel(pageOption, pageOption === 4)}
              </option>
            ))}
          </select>
          <p className="text-sm text-gray-500 mt-2">
            {languageLevel === '1st-grade'
              ? (language === 'de' ? 'Jede Seite enthält ein Bild mit Text darunter' : language === 'fr' ? 'Chaque page contient une image avec du texte en dessous' : 'Each page contains an image with text below')
              : (language === 'de' ? 'Abwechselnd Textseite und Bildseite' : language === 'fr' ? 'Alternance de pages de texte et d\'images' : 'Alternating text page and image page')
            }
          </p>
        </div>
      )}
    </div>
  );
}
