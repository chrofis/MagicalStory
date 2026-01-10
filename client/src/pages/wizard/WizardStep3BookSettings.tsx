import { useEffect, useState } from 'react';
import { BookOpen, MapPin } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { LanguageLevel, StoryLanguageCode } from '@/types/story';

// Story language options
const STORY_LANGUAGES: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-ch', name: 'Deutsch (Schweiz)', flag: '🇨🇭' },
  { code: 'de-de', name: 'Deutsch (Deutschland)', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

// Season options
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

// Calculate current season based on date (Northern Hemisphere)
function getCurrentSeason(): string {
  const month = new Date().getMonth(); // 0-11
  if (month >= 2 && month <= 4) return 'spring';   // Mar-May
  if (month >= 5 && month <= 7) return 'summer';   // Jun-Aug
  if (month >= 8 && month <= 10) return 'autumn';  // Sep-Nov
  return 'winter'; // Dec-Feb
}

interface UserLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

interface WizardStep3Props {
  languageLevel: LanguageLevel;
  onLanguageLevelChange: (level: LanguageLevel) => void;
  pages: number;
  onPagesChange: (pages: number) => void;
  storyLanguage: StoryLanguageCode;
  onStoryLanguageChange: (lang: StoryLanguageCode) => void;
  developerMode: boolean;
  userLocation: UserLocation | null;
  onLocationChange: (location: UserLocation) => void;
  season: string;
  onSeasonChange: (season: string) => void;
}

/**
 * Step 3: Book Settings
 * Handles book type (reading level) and page count selection
 */
// Export getCurrentSeason for use in parent
export { getCurrentSeason };

export function WizardStep3BookSettings({
  languageLevel,
  onLanguageLevelChange,
  pages,
  onPagesChange,
  storyLanguage,
  onStoryLanguageChange,
  developerMode,
  userLocation,
  onLocationChange,
  season,
  onSeasonChange,
}: WizardStep3Props) {
  const { t, language } = useLanguage();
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [editCity, setEditCity] = useState(userLocation?.city || '');
  const [editCountry, setEditCountry] = useState(userLocation?.country || '');

  // Update edit fields when userLocation changes
  useEffect(() => {
    if (userLocation) {
      setEditCity(userLocation.city || '');
      setEditCountry(userLocation.country || '');
    }
  }, [userLocation]);

  const handleSaveLocation = () => {
    onLocationChange({
      city: editCity || null,
      region: null,
      country: editCountry || null,
    });
    setIsEditingLocation(false);
  };

  // Season labels
  const seasonLabels: Record<string, Record<string, string>> = {
    spring: { de: 'Frühling', fr: 'Printemps', en: 'Spring' },
    summer: { de: 'Sommer', fr: 'Été', en: 'Summer' },
    autumn: { de: 'Herbst', fr: 'Automne', en: 'Autumn' },
    winter: { de: 'Winter', fr: 'Hiver', en: 'Winter' },
  };

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
      {/* Header with Story Language Selection on the right */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <BookOpen size={24} />
          {language === 'de' ? 'Buchformat' : language === 'fr' ? 'Format du livre' : 'Book Format'}
        </h2>

        {/* Story Language Selection - Dropdown on the right */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">
            {language === 'de' ? 'Sprachvariante:' : language === 'fr' ? 'Variante:' : 'Language:'}
          </span>
          <div className="relative">
            <select
              value={storyLanguage}
              onChange={(e) => onStoryLanguageChange(e.target.value as StoryLanguageCode)}
              className="px-4 py-2 border-2 border-indigo-200 rounded-lg focus:border-indigo-600 focus:outline-none text-base font-medium appearance-none bg-white cursor-pointer pr-10"
            >
              {STORY_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            {/* Custom dropdown arrow */}
            <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Location and Season Row */}
      <div className="flex flex-wrap gap-4 p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-xl border border-indigo-100">
        {/* Location */}
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <MapPin className="text-indigo-500" size={20} />
          <span className="text-sm text-gray-600">
            {language === 'de' ? 'Ort:' : language === 'fr' ? 'Lieu:' : 'Location:'}
          </span>
          {isEditingLocation ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                type="text"
                value={editCity}
                onChange={(e) => setEditCity(e.target.value)}
                placeholder={language === 'de' ? 'Stadt' : language === 'fr' ? 'Ville' : 'City'}
                className="px-2 py-1 border border-indigo-300 rounded text-sm w-24 focus:outline-none focus:border-indigo-500"
              />
              <input
                type="text"
                value={editCountry}
                onChange={(e) => setEditCountry(e.target.value)}
                placeholder={language === 'de' ? 'Land' : language === 'fr' ? 'Pays' : 'Country'}
                className="px-2 py-1 border border-indigo-300 rounded text-sm w-24 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleSaveLocation}
                className="px-2 py-1 bg-indigo-600 text-white text-sm rounded hover:bg-indigo-700"
              >
                OK
              </button>
              <button
                onClick={() => setIsEditingLocation(false)}
                className="px-2 py-1 text-gray-600 text-sm hover:text-gray-800"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setIsEditingLocation(true)}
              className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline"
            >
              {userLocation?.city
                ? `${userLocation.city}${userLocation.country ? `, ${userLocation.country}` : ''}`
                : (language === 'de' ? 'Nicht festgelegt' : language === 'fr' ? 'Non défini' : 'Not set')}
            </button>
          )}
        </div>

        {/* Season */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">
            {language === 'de' ? 'Jahreszeit:' : language === 'fr' ? 'Saison:' : 'Season:'}
          </span>
          <div className="flex gap-1">
            {SEASONS.map((s) => {
              const isSelected = season === s;
              const label = seasonLabels[s][language] || seasonLabels[s].en;
              return (
                <button
                  key={s}
                  onClick={() => onSeasonChange(s)}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                    isSelected
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
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
