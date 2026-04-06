import { useEffect, useState, useRef, useCallback } from 'react';
import { BookOpen, MapPin, ChevronDown, Pencil, X, Plus, Baby, Book, BookText } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { LanguageLevel, StoryLanguageCode } from '@/types/story';

// Language family type
type LanguageFamily = 'de' | 'fr' | 'it' | 'en' | 'gsw';

// Main language options (shown in dropdown)
const MAIN_LANGUAGES: { code: StoryLanguageCode; name: string; family: LanguageFamily }[] = [
  { code: 'de-ch', name: 'Deutsch', family: 'de' },
  { code: 'fr-ch', name: 'Français', family: 'fr' },
  { code: 'it-ch', name: 'Italiano', family: 'it' },
  { code: 'en-gb', name: 'English', family: 'en' },
  { code: 'gsw-zh', name: 'Mundart', family: 'gsw' },
];

// Regional variants for each language family (user-friendly names, no codes)
const LANGUAGE_VARIANTS: Record<LanguageFamily, { code: StoryLanguageCode; name: string }[]> = {
  de: [
    { code: 'de-ch', name: 'Schweiz' },
    { code: 'de-de', name: 'Hochdeutsch' },
    { code: 'de-de-north', name: 'Norddeutsch' },
    { code: 'de-de-south', name: 'Süddeutsch' },
    { code: 'de-at', name: 'Österreich' },
    { code: 'de-it', name: 'Südtirol' },
  ],
  fr: [
    { code: 'fr-ch', name: 'Suisse' },
    { code: 'fr-fr', name: 'France' },
    { code: 'fr-be', name: 'Belgique' },
    { code: 'fr-ca', name: 'Québec' },
    { code: 'fr-af', name: 'Afrique' },
  ],
  it: [
    { code: 'it-ch', name: 'Svizzera' },
    { code: 'it-it', name: 'Standard' },
    { code: 'it-it-north', name: 'Nord' },
    { code: 'it-it-central', name: 'Toscana' },
    { code: 'it-it-south', name: 'Sud' },
    { code: 'it-sm', name: 'San Marino' },
  ],
  en: [
    { code: 'en-gb', name: 'British' },
    { code: 'en-us', name: 'American' },
    { code: 'en-ca', name: 'Canadian' },
    { code: 'en-au', name: 'Australian' },
    { code: 'en-ie', name: 'Irish' },
    { code: 'en-za', name: 'South African' },
  ],
  gsw: [
    { code: 'gsw-zh', name: 'Züritüütsch' },
    { code: 'gsw-be', name: 'Bärndütsch' },
    { code: 'gsw-bs', name: 'Baseldytsch' },
    { code: 'gsw-lu', name: 'Luzärndütsch' },
    { code: 'gsw-sg', name: 'Sanggallerdütsch' },
    { code: 'gsw-vs', name: 'Walliserdütsch' },
    { code: 'gsw-gr', name: 'Bündnerdütsch' },
  ],
};

// Helper to determine language family from code
function getLanguageFamily(code: StoryLanguageCode): LanguageFamily {
  if (code.startsWith('gsw')) return 'gsw';
  if (code.startsWith('de')) return 'de';
  if (code.startsWith('fr')) return 'fr';
  if (code.startsWith('it')) return 'it';
  return 'en';
}


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
  userCredits: number; // User's available credits (-1 = unlimited)
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
  userCredits,
}: WizardStep3Props) {
  const { t, language } = useLanguage();
  const [isEditingLocation, setIsEditingLocation] = useState(false);
  const [editCity, setEditCity] = useState(userLocation?.city || '');
  const [editCountry, setEditCountry] = useState(userLocation?.country || '');
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false);
  const languageDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (languageDropdownRef.current && !languageDropdownRef.current.contains(event.target as Node)) {
        setIsLanguageDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Get display text for the closed dropdown: "Language (Variant)"
  const getLanguageDisplayText = useCallback(() => {
    const family = getLanguageFamily(storyLanguage);
    const mainLang = MAIN_LANGUAGES.find(l => l.family === family);
    const variant = LANGUAGE_VARIANTS[family].find(v => v.code === storyLanguage)
      || LANGUAGE_VARIANTS[family][0]; // Fall back to first variant (e.g., de -> de-ch)
    if (mainLang && variant) {
      return `${mainLang.name} (${variant.name})`;
    }
    return mainLang?.name || storyLanguage;
  }, [storyLanguage]);

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

  const handleClearLocation = () => {
    onLocationChange({ city: null, region: null, country: null });
    setEditCity('');
    setEditCountry('');
    setIsEditingLocation(false);
  };

  // Season labels
  const seasonLabels: Record<string, Record<string, string>> = {
    spring: { de: 'Frühling', fr: 'Printemps', en: 'Spring' },
    summer: { de: 'Sommer', fr: 'Été', en: 'Summer' },
    autumn: { de: 'Herbst', fr: 'Automne', en: 'Autumn' },
    winter: { de: 'Winter', fr: 'Hiver', en: 'Winter' },
  };

  // Page slider configuration
  // 1 page = 1 scene = 1 image (picture-book layout for all reading levels).
  // Max 25 pages keeps a 24-page story around $3 / 250 credits.
  const minPages = developerMode ? 4 : 10;
  const absoluteMaxPages = 25;
  const pageStep = 1;
  const creditsPerPage = 10;

  // Calculate max pages based on user credits (-1 = unlimited)
  const hasUnlimitedCredits = userCredits === -1;
  const maxAffordablePages = hasUnlimitedCredits
    ? absoluteMaxPages
    : Math.floor(userCredits / creditsPerPage);
  // Check if user can't afford even the minimum
  const minCreditsNeeded = minPages * creditsPerPage;
  const cannotAffordMinimum = !hasUnlimitedCredits && userCredits < minCreditsNeeded;
  const creditsNeededForMin = minCreditsNeeded - userCredits;
  // Effective max is the lower of absolute max and what user can afford
  const effectiveMaxPages = cannotAffordMinimum
    ? minPages // Show minimum even if can't afford (slider will be disabled)
    : Math.min(absoluteMaxPages, Math.max(minPages, maxAffordablePages));
  const isLimitedByCredits = !hasUnlimitedCredits && maxAffordablePages < absoluteMaxPages;

  // Clamp pages to the affordable range
  useEffect(() => {
    const validPages = Math.max(minPages, Math.min(effectiveMaxPages, pages));
    if (validPages !== pages) {
      onPagesChange(validPages);
    }
  }, [pages, minPages, effectiveMaxPages, onPagesChange]);

  // All reading levels use the same picture-book layout (image on top, text below).
  // The only difference is text density: short, medium, or long text per page.
  // Approximate words/page comes from server/lib/storyHelpers.js LANGUAGE_LEVELS.
  const wordsLabel = language === 'de' ? 'Wörter pro Seite' : language === 'fr' ? 'mots par page' : 'words per page';
  const readingLevels = [
    {
      value: '1st-grade' as LanguageLevel,
      label: t.firstGrade,
      desc: t.firstGradeDesc,
      icon: Baby,
      wordRange: `~20-35 ${wordsLabel}`,
    },
    {
      value: 'standard' as LanguageLevel,
      label: t.standard,
      desc: t.standardDesc,
      icon: Book,
      wordRange: `~120-150 ${wordsLabel}`,
    },
    {
      value: 'advanced' as LanguageLevel,
      label: t.advanced,
      desc: t.advancedDesc,
      icon: BookText,
      wordRange: `~250-300 ${wordsLabel}`,
    },
  ];

  // Page label is now uniform across reading levels: each page = 1 scene
  // (image + text combined on the same page in picture-book layout).
  const getPageLabel = (pageCount: number, isTest = false) => {
    const testSuffix = isTest ? ' (Test)' : '';
    const creditsCost = pageCount * 10;
    const creditsLabel = language === 'de' ? 'Credits' : language === 'fr' ? 'crédits' : 'credits';
    const pagesLabel = language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages';
    return `${pageCount} ${pagesLabel} = ${creditsCost} ${creditsLabel}${testSuffix}`;
  };

  return (
    <div className="space-y-6">
      {/* Header with Language, Location, Season on one line */}
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <BookOpen size={24} />
          {language === 'de' ? 'Buchformat' : language === 'fr' ? 'Format du livre' : 'Book Format'}
        </h2>

        {/* Language, Location, Season Row - full width */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Language Selection - Custom dropdown with languages and variants */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">
              {language === 'de' ? 'Sprache:' : language === 'fr' ? 'Langue:' : 'Language:'}
            </span>
            <div className="relative" ref={languageDropdownRef}>
              {/* Dropdown trigger button */}
              <button
                type="button"
                onClick={() => setIsLanguageDropdownOpen(!isLanguageDropdownOpen)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none text-sm font-medium bg-white cursor-pointer pr-8 flex items-center gap-1 min-w-[160px]"
              >
                {getLanguageDisplayText()}
                <ChevronDown
                  size={16}
                  className={`absolute right-2 text-gray-400 transition-transform ${isLanguageDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>

              {/* Dropdown menu */}
              {isLanguageDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg z-50 min-w-[180px] py-1">
                  {/* Main Languages */}
                  {MAIN_LANGUAGES.map((lang) => {
                    const isCurrentFamily = getLanguageFamily(storyLanguage) === lang.family;
                    return (
                      <button
                        key={lang.family}
                        type="button"
                        onClick={() => {
                          // Switch to the first variant of that family (Swiss by default)
                          const defaultVariant = LANGUAGE_VARIANTS[lang.family][0];
                          onStoryLanguageChange(defaultVariant.code);
                          // Keep dropdown open when switching language family
                        }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 ${
                          isCurrentFamily ? 'font-semibold text-indigo-500' : 'text-gray-700'
                        }`}
                      >
                        {lang.name}
                      </button>
                    );
                  })}

                  {/* Separator - just a line */}
                  <div className="border-t border-gray-300 my-1" />

                  {/* Variants for current language family */}
                  {LANGUAGE_VARIANTS[getLanguageFamily(storyLanguage)].map((variant) => (
                    <button
                      key={variant.code}
                      type="button"
                      onClick={() => {
                        onStoryLanguageChange(variant.code);
                        setIsLanguageDropdownOpen(false); // Close dropdown when selecting variant
                      }}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-indigo-50 ${
                        storyLanguage === variant.code
                          ? 'bg-indigo-100 text-indigo-700 font-medium'
                          : 'text-gray-700'
                      }`}
                    >
                      {variant.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Location */}
          <div className="flex items-center gap-2 flex-wrap">
            <MapPin className="text-gray-500 shrink-0" size={16} />
            <span className="text-sm text-gray-600">
              {language === 'de' ? 'Ort:' : language === 'fr' ? 'Lieu:' : 'Location:'}
            </span>
            {isEditingLocation ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={editCity}
                  onChange={(e) => setEditCity(e.target.value)}
                  placeholder={language === 'de' ? 'Stadt' : language === 'fr' ? 'Ville' : 'City'}
                  className="px-2 py-1 border border-gray-300 rounded text-base w-24 focus:outline-none focus:border-indigo-500"
                />
                <input
                  type="text"
                  value={editCountry}
                  onChange={(e) => setEditCountry(e.target.value)}
                  placeholder={language === 'de' ? 'Land' : language === 'fr' ? 'Pays' : 'Country'}
                  className="px-2 py-1 border border-gray-300 rounded text-base w-24 focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleSaveLocation}
                  className="px-2 py-1 bg-indigo-500 text-white text-xs rounded hover:bg-indigo-600"
                >
                  OK
                </button>
                <button
                  onClick={() => setIsEditingLocation(false)}
                  className="px-1 text-gray-500 text-xs hover:text-gray-700"
                >
                  ✕
                </button>
              </div>
            ) : userLocation?.city ? (
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-800">
                  {userLocation.city}{userLocation.country ? `, ${userLocation.country}` : ''}
                </span>
                <button
                  onClick={() => setIsEditingLocation(true)}
                  className="p-1.5 rounded-md text-indigo-500 hover:bg-indigo-50 hover:text-indigo-600 transition-colors border border-indigo-200"
                  title={language === 'de' ? 'Ort ändern' : language === 'fr' ? 'Modifier le lieu' : 'Change location'}
                  aria-label={language === 'de' ? 'Ort ändern' : language === 'fr' ? 'Modifier le lieu' : 'Change location'}
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={handleClearLocation}
                  className="p-1.5 rounded-md text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors border border-red-200"
                  title={language === 'de' ? 'Ort entfernen' : language === 'fr' ? 'Supprimer le lieu' : 'Remove location'}
                  aria-label={language === 'de' ? 'Ort entfernen' : language === 'fr' ? 'Supprimer le lieu' : 'Remove location'}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-400 italic">
                  {language === 'de' ? 'Kein Ort' : language === 'fr' ? 'Aucun lieu' : 'No location'}
                </span>
                <button
                  onClick={() => setIsEditingLocation(true)}
                  className="text-xs font-medium text-indigo-500 hover:text-indigo-600 flex items-center gap-0.5"
                >
                  <Plus size={12} />
                  {language === 'de' ? 'Ort hinzufügen' : language === 'fr' ? 'Ajouter un lieu' : 'Add location'}
                </button>
              </div>
            )}
          </div>

          {/* Season Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">
              {language === 'de' ? 'Jahreszeit:' : language === 'fr' ? 'Saison:' : 'Season:'}
            </span>
            <div className="relative">
              <select
                value={season}
                onChange={(e) => onSeasonChange(e.target.value)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none text-sm font-medium appearance-none bg-white cursor-pointer pr-8"
              >
                {SEASONS.map((s) => (
                  <option key={s} value={s}>
                    {seasonLabels[s][language] || seasonLabels[s].en}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Reading Level Selection */}
      <div>
        <label className="block text-xl font-semibold mb-3">{t.readingLevel}</label>
        <div className="flex overflow-x-auto gap-3 pb-2 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:pb-0 -mx-3 px-3 md:mx-0 md:px-0">
          {readingLevels.map((level) => {
            const Icon = level.icon;
            const isSelected = languageLevel === level.value;
            return (
              <button
                key={level.value}
                onClick={() => onLanguageLevelChange(level.value)}
                className={`flex-shrink-0 w-56 md:w-auto text-left rounded-lg border-2 p-4 transition-all ${
                  isSelected
                    ? 'border-indigo-500 ring-2 ring-indigo-200 bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-300 bg-white'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon size={28} className={isSelected ? 'text-indigo-500' : 'text-gray-400'} />
                  <div className="font-semibold text-base">{level.label}</div>
                </div>
                <div className="text-xs text-indigo-600 font-medium mb-1">{level.wordRange}</div>
                <div className="text-xs text-gray-500 whitespace-pre-line">{level.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Number of Pages - shown after reading level is selected */}
      {languageLevel && (
        <div>
          <label className="block text-xl font-semibold mb-3">
            {t.numberOfPages}
          </label>

          {/* Not enough credits warning */}
          {cannotAffordMinimum ? (
            <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 text-center">
              <p className="text-red-700 font-semibold mb-2">
                {language === 'de'
                  ? 'Nicht genügend Credits'
                  : language === 'fr'
                  ? 'Crédits insuffisants'
                  : 'Not enough credits'}
              </p>
              <p className="text-red-600 text-sm">
                {language === 'de'
                  ? `Du benötigst mindestens ${minCreditsNeeded} Credits für eine Geschichte mit ${minPages} Seiten. Dir fehlen noch ${creditsNeededForMin} Credits.`
                  : language === 'fr'
                  ? `Vous avez besoin d'au moins ${minCreditsNeeded} crédits pour une histoire de ${minPages} pages. Il vous manque ${creditsNeededForMin} crédits.`
                  : `You need at least ${minCreditsNeeded} credits for a ${minPages}-page story. You need ${creditsNeededForMin} more credits.`}
              </p>
              <p className="text-gray-500 text-xs mt-2">
                {language === 'de'
                  ? `Aktuell: ${userCredits} Credits`
                  : language === 'fr'
                  ? `Actuel: ${userCredits} crédits`
                  : `Current: ${userCredits} credits`}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Range Slider — shows full range, clamps to affordable max */}
              <input
                type="range"
                min={minPages}
                max={absoluteMaxPages}
                step={pageStep}
                value={Math.min(pages, effectiveMaxPages)}
                onChange={(e) => onPagesChange(Math.min(parseInt(e.target.value), effectiveMaxPages))}
                className="w-full h-3 bg-indigo-100 rounded-lg appearance-none cursor-pointer accent-indigo-600 touch-none
                           [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6
                           [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer
                           [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:hover:bg-indigo-600
                           [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:bg-indigo-500
                           [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
              />

              {/* Value display with min/max */}
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">{minPages}</span>
                <span className="text-xl font-bold text-indigo-500">
                  {pages} {language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'}
                </span>
                <span className="text-sm text-gray-400">{absoluteMaxPages}</span>
              </div>

              {/* Credit limit warning */}
              {isLimitedByCredits && (
                <div className="text-center text-sm text-orange-600 bg-orange-50 rounded-lg py-2 px-3">
                  {language === 'de'
                    ? `Max. ${effectiveMaxPages} Seiten mit ${userCredits} Credits möglich`
                    : language === 'fr'
                    ? `Max. ${effectiveMaxPages} pages possibles avec ${userCredits} crédits`
                    : `Max. ${effectiveMaxPages} pages possible with ${userCredits} credits`}
                </div>
              )}

              {/* Credits and description */}
              <div className="text-center">
                <p className="text-base font-medium text-gray-700">
                  {getPageLabel(pages, pages === 4)}
                </p>
                <p className="text-sm text-gray-500 mt-1">
                  {language === 'de' ? 'Jede Seite enthält ein Bild mit Text darunter' : language === 'fr' ? 'Chaque page contient une image avec du texte en dessous' : 'Each page contains an image with text below'}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
