import { useEffect, useState } from 'react';
import { BookOpen, MapPin } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { LanguageLevel, StoryLanguageCode } from '@/types/story';

// Primary story language options (shown first)
const STORY_LANGUAGES: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-ch', name: 'Deutsch (Schweiz)', flag: '🇨🇭' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

// German regional variants (shown after separator)
const GERMAN_VARIANTS: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-de', name: 'Deutsch (Standard)', flag: '🇩🇪' },
  { code: 'de-de-north', name: 'Deutsch (Nord)', flag: '🇩🇪' },
  { code: 'de-de-south', name: 'Deutsch (Süd)', flag: '🇩🇪' },
  { code: 'de-at', name: 'Deutsch (Österreich)', flag: '🇦🇹' },
  { code: 'de-it', name: 'Deutsch (Südtirol)', flag: '🇮🇹' },
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

  // Page slider configuration
  const minPages = developerMode ? 4 : 10;
  const absoluteMaxPages = 50;
  const pageStep = 2; // Only even values
  const creditsPerPage = 10;

  // Calculate max pages based on user credits (-1 = unlimited)
  const hasUnlimitedCredits = userCredits === -1;
  const affordablePages = hasUnlimitedCredits
    ? absoluteMaxPages
    : Math.floor(userCredits / creditsPerPage);
  // Round down to nearest even number
  const maxAffordablePages = Math.floor(affordablePages / 2) * 2;
  // Check if user can't afford even the minimum
  const minCreditsNeeded = minPages * creditsPerPage;
  const cannotAffordMinimum = !hasUnlimitedCredits && userCredits < minCreditsNeeded;
  const creditsNeededForMin = minCreditsNeeded - userCredits;
  // Effective max is the lower of absolute max and what user can afford
  const effectiveMaxPages = cannotAffordMinimum
    ? minPages // Show minimum even if can't afford (slider will be disabled)
    : Math.min(absoluteMaxPages, Math.max(minPages, maxAffordablePages));
  const isLimitedByCredits = !hasUnlimitedCredits && maxAffordablePages < absoluteMaxPages;

  // Ensure pages value is even and within range
  useEffect(() => {
    let validPages = pages;

    // Ensure even
    if (validPages % 2 !== 0) {
      validPages = Math.round(validPages / 2) * 2;
    }
    // Ensure in range (use effectiveMaxPages to respect credit limit)
    validPages = Math.max(minPages, Math.min(effectiveMaxPages, validPages));

    if (validPages !== pages) {
      onPagesChange(validPages);
    }
  }, [pages, minPages, effectiveMaxPages, onPagesChange]);

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
      {/* Header with Language, Location, Season on one line */}
      <div className="flex flex-col gap-4">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <BookOpen size={24} />
          {language === 'de' ? 'Buchformat' : language === 'fr' ? 'Format du livre' : 'Book Format'}
        </h2>

        {/* Language, Location, Season Row - full width */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Language Dropdown */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">
              {language === 'de' ? 'Sprache:' : language === 'fr' ? 'Langue:' : 'Language:'}
            </span>
            <div className="relative">
              <select
                value={storyLanguage}
                onChange={(e) => onStoryLanguageChange(e.target.value as StoryLanguageCode)}
                className="px-3 py-1.5 border border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-sm font-medium appearance-none bg-white cursor-pointer pr-8"
              >
                {STORY_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
                <option disabled className="text-gray-400">
                  ──── {language === 'de' ? 'Regionale Varianten' : language === 'fr' ? 'Variantes régionales' : 'Regional Variants'} ────
                </option>
                {GERMAN_VARIANTS.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name}
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

          {/* Location */}
          <div className="flex items-center gap-2">
            <MapPin className="text-gray-500" size={16} />
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
                  className="px-2 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700"
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
            ) : (
              <button
                onClick={() => setIsEditingLocation(true)}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:underline"
              >
                {userLocation?.city
                  ? `${userLocation.city}${userLocation.country ? `, ${userLocation.country}` : ''}`
                  : (language === 'de' ? 'Festlegen' : language === 'fr' ? 'Définir' : 'Set')}
              </button>
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
                className="px-3 py-1.5 border border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-sm font-medium appearance-none bg-white cursor-pointer pr-8"
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
        <div className="flex overflow-x-auto gap-3 pb-2 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:pb-0 -mx-4 px-4 md:mx-0 md:px-0">
          {readingLevels.map((level) => (
            <button
              key={level.value}
              onClick={() => onLanguageLevelChange(level.value)}
              className={`flex-shrink-0 w-56 md:w-auto text-left rounded-lg border-2 transition-all overflow-hidden ${
                languageLevel === level.value
                  ? 'border-indigo-600 ring-2 ring-indigo-200'
                  : 'border-gray-200 hover:border-indigo-300'
              }`}
            >
              <div className="w-full bg-gray-100 p-2 h-48 md:h-56">
                <img
                  src={level.image}
                  alt={level.label}
                  className="w-full h-full object-contain"
                />
              </div>
              <div className="p-2 md:p-2.5">
                <div className="font-semibold text-sm mb-0.5">{level.label}</div>
                <div className="text-xs text-gray-500 whitespace-pre-line">{level.desc}</div>
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
              {/* Range Slider */}
              <input
                type="range"
                min={minPages}
                max={effectiveMaxPages}
                step={pageStep}
                value={Math.min(pages, effectiveMaxPages)}
                onChange={(e) => onPagesChange(parseInt(e.target.value))}
                className="w-full h-3 bg-indigo-100 rounded-lg appearance-none cursor-pointer accent-indigo-600
                           [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6
                           [&::-webkit-slider-thumb]:bg-indigo-600 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer
                           [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:hover:bg-indigo-700
                           [&::-moz-range-thumb]:w-6 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:bg-indigo-600
                           [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
              />

              {/* Value display with min/max */}
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">{minPages}</span>
                <span className="text-xl font-bold text-indigo-600">
                  {pages} {language === 'de' ? 'Seiten' : language === 'fr' ? 'pages' : 'pages'}
                </span>
                <span className={`text-sm ${isLimitedByCredits ? 'text-orange-500 font-medium' : 'text-gray-400'}`}>
                  {effectiveMaxPages}
                  {isLimitedByCredits && ' ⚠️'}
                </span>
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
                  {languageLevel === '1st-grade'
                    ? (language === 'de' ? 'Jede Seite enthält ein Bild mit Text darunter' : language === 'fr' ? 'Chaque page contient une image avec du texte en dessous' : 'Each page contains an image with text below')
                    : (language === 'de' ? 'Abwechselnd Textseite und Bildseite' : language === 'fr' ? 'Alternance de pages de texte et d\'images' : 'Alternating text page and image page')
                  }
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
