import { useEffect } from 'react';
import { Wand2, Star } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { Character } from '@/types/character';
import type { LanguageLevel } from '@/types/story';

// Character role in story: 'out' = not in story, 'in' = side character, 'main' = main character
export type CharacterRole = 'out' | 'in' | 'main';

interface StorySettingsProps {
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  onCharacterRoleChange: (charId: number, role: CharacterRole) => void;
  languageLevel: LanguageLevel;
  onLanguageLevelChange: (level: LanguageLevel) => void;
  pages: number;
  onPagesChange: (pages: number) => void;
  dedication: string;
  onDedicationChange: (dedication: string) => void;
  storyDetails: string;
  onStoryDetailsChange: (details: string) => void;
  developerMode?: boolean;
  imageGenMode?: 'parallel' | 'sequential' | null;
  onImageGenModeChange?: (mode: 'parallel' | 'sequential' | null) => void;
}

export function StorySettings({
  characters,
  mainCharacters,
  excludedCharacters,
  onCharacterRoleChange,
  languageLevel,
  onLanguageLevelChange,
  pages,
  onPagesChange,
  dedication,
  onDedicationChange,
  storyDetails,
  onStoryDetailsChange,
  developerMode = false,
  imageGenMode,
  onImageGenModeChange,
}: StorySettingsProps) {
  const { t, language } = useLanguage();

  // Helper to determine character's current role
  const getCharacterRole = (charId: number): CharacterRole => {
    if (excludedCharacters.includes(charId)) return 'out';
    if (mainCharacters.includes(charId)) return 'main';
    return 'in';
  };

  // Available page options based on developer mode
  // Only even numbers so text/image split works (pageCount / 2 must be whole number)
  const availablePageOptions = developerMode ? [4, 10, 14, 20, 24, 30, 34, 40, 44, 50] : [10, 14, 20, 24, 30, 34, 40, 44, 50];

  // If current pages value is not in available options, reset to default (10)
  useEffect(() => {
    const validOptions = developerMode ? [4, 10, 14, 20, 24, 30, 34, 40, 44, 50] : [10, 14, 20, 24, 30, 34, 40, 44, 50];
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

  // Role labels for 3-state buttons
  const roleLabels = {
    out: language === 'de' ? 'Nicht dabei' : language === 'fr' ? 'Absent' : 'Out',
    in: language === 'de' ? 'Dabei' : language === 'fr' ? 'Présent' : 'In',
    main: language === 'de' ? 'Hauptrolle' : language === 'fr' ? 'Principal' : 'Main',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Wand2 size={24} /> {t.storySettings}
      </h2>

      <div className="space-y-6">
        {/* Character Role Selection */}
        <div>
          <label className="block text-xl font-semibold mb-3">
            {language === 'de' ? 'Charaktere in der Geschichte' : language === 'fr' ? 'Personnages dans l\'histoire' : 'Characters in the Story'}
          </label>
          <div className="grid md:grid-cols-2 gap-3">
            {characters.map((char) => {
              const role = getCharacterRole(char.id);
              const isOut = role === 'out';
              const isIn = role === 'in';
              const isMain = role === 'main';
              // Count characters currently in story (not excluded)
              const charactersInStory = characters.filter(c => !excludedCharacters.includes(c.id));
              // Prevent removing the last character from the story
              const isLastInStory = !isOut && charactersInStory.length === 1;

              return (
                <div
                  key={char.id}
                  className={`p-4 rounded-lg transition-all flex flex-col md:flex-row md:items-center md:justify-between gap-3 ${
                    isOut
                      ? 'border-2 border-dashed border-gray-300 bg-gray-50 opacity-60'
                      : isMain
                      ? 'border-3 border-indigo-600 bg-indigo-50'
                      : 'border-2 border-indigo-400 bg-white'
                  }`}
                >
                  {/* Character info - top on mobile, left on desktop */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    {(char.photos?.face || char.photos?.original) && (
                      <img
                        src={char.photos?.face || char.photos?.original}
                        alt={char.name}
                        className={`w-12 h-12 rounded-full object-cover flex-shrink-0 ${isOut ? 'grayscale' : ''}`}
                      />
                    )}
                    <div className="min-w-0">
                      <div className="font-bold text-base flex items-center gap-2">
                        <span className="truncate">{char.name}</span>
                        {isMain && <Star size={18} className="text-indigo-600 fill-indigo-600 flex-shrink-0" />}
                      </div>
                      <div className="text-sm text-gray-500 truncate">
                        {char.gender === 'male' ? t.male : char.gender === 'female' ? t.female : t.other}, {char.age}
                      </div>
                    </div>
                  </div>

                  {/* Role selector - full width on mobile, right side on desktop */}
                  <div className="flex rounded-lg overflow-hidden border border-gray-300 w-full md:w-auto">
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'out')}
                      disabled={isLastInStory}
                      title={isLastInStory ? (language === 'de' ? 'Mindestens ein Charakter muss in der Geschichte sein' : language === 'fr' ? 'Au moins un personnage doit être dans l\'histoire' : 'At least one character must be in the story') : undefined}
                      className={`flex-1 md:flex-initial px-3 py-2 text-sm font-medium transition-colors ${
                        isOut
                          ? 'bg-gray-500 text-white'
                          : isLastInStory
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {roleLabels.out}
                    </button>
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'in')}
                      className={`flex-1 md:flex-initial px-3 py-2 text-sm font-medium transition-colors border-l border-r border-gray-300 ${
                        isIn
                          ? 'bg-indigo-500 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {roleLabels.in}
                    </button>
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'main')}
                      className={`flex-1 md:flex-initial px-3 py-2 text-sm font-medium transition-colors flex items-center justify-center gap-1 ${
                        isMain
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      <Star size={14} className={isMain ? 'fill-white' : ''} />
                      {roleLabels.main}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Reading Level Selection */}
        <div>
          <label className="block text-xl font-semibold mb-3">{t.readingLevel}</label>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {readingLevels.map((level) => (
              <button
                key={level.value}
                onClick={() => onLanguageLevelChange(level.value)}
                className={`text-left rounded-lg border-2 transition-all overflow-hidden ${
                  languageLevel === level.value
                    ? 'border-indigo-600 ring-2 ring-indigo-200'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="w-full bg-gray-100 p-2">
                  <img
                    src={level.image}
                    alt={level.label}
                    className="w-full h-auto object-contain"
                  />
                </div>
                <div className="p-3">
                  <div className="font-semibold text-base">{level.label}</div>
                  <div className="text-sm text-gray-500">{level.desc}</div>
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

        {/* Story Plot / Story Details */}
        <div>
          <label className="block text-xl font-semibold mb-3">
            {t.storyDetails} <span className="text-sm font-normal text-gray-500">{t.storyDetailsOptional}</span>
          </label>
          <textarea
            value={storyDetails}
            onChange={(e) => onStoryDetailsChange(e.target.value)}
            placeholder={t.storyDetailsPlaceholder}
            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-base"
            rows={6}
          />
        </div>

        {/* Dedication (Widmung) - Optional */}
        <div>
          <label className="block text-xl font-semibold mb-3">
            {language === 'de' ? 'Widmung' : language === 'fr' ? 'Dédicace' : 'Dedication'} <span className="text-sm font-normal text-gray-500">{t.storyDetailsOptional}</span>
          </label>
          <textarea
            value={dedication}
            onChange={(e) => onDedicationChange(e.target.value)}
            placeholder={language === 'de'
              ? 'z.B. "Für meine liebe Tochter Emma zum 5. Geburtstag"'
              : language === 'fr'
              ? 'Par exemple "Pour ma chère fille Emma pour son 5ème anniversaire"'
              : 'e.g. "For my dear daughter Emma on her 5th birthday"'}
            className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-base"
            rows={2}
            maxLength={200}
          />
          <p className="text-sm text-gray-500 mt-1">
            {language === 'de'
              ? 'Dieser Text wird auf Seite 0 Ihres Buches gedruckt. Wenn Sie nichts eingeben, wird Seite 0 nur eine Illustration ohne Text enthalten.'
              : language === 'fr'
              ? 'Ce texte sera imprimé sur la page 0 de votre livre. Si vous ne saisissez rien, la page 0 ne contiendra qu\'une illustration sans texte.'
              : 'This text will be printed on page 0 of your book. If you leave it empty, page 0 will contain only an illustration with no text.'}
          </p>
        </div>

        {/* Developer Mode Options */}
        {developerMode && (
          <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4">
            <h3 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
              🛠️ {language === 'de' ? 'Entwickler-Optionen' : language === 'fr' ? 'Options développeur' : 'Developer Options'}
            </h3>

            {/* Image Generation Mode */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                {language === 'de' ? 'Bildgenerierungsmodus' : language === 'fr' ? 'Mode de génération d\'images' : 'Image Generation Mode'}
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => onImageGenModeChange?.(null)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium ${
                    imageGenMode === null
                      ? 'bg-yellow-500 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {language === 'de' ? 'Server-Standard' : language === 'fr' ? 'Par défaut serveur' : 'Server Default'}
                </button>
                <button
                  onClick={() => onImageGenModeChange?.('parallel')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium ${
                    imageGenMode === 'parallel'
                      ? 'bg-yellow-500 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {language === 'de' ? 'Parallel (schnell)' : language === 'fr' ? 'Parallèle (rapide)' : 'Parallel (fast)'}
                </button>
                <button
                  onClick={() => onImageGenModeChange?.('sequential')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium ${
                    imageGenMode === 'sequential'
                      ? 'bg-yellow-500 text-white'
                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {language === 'de' ? 'Sequenziell (konsistent)' : language === 'fr' ? 'Séquentiel (cohérent)' : 'Sequential (consistent)'}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                {language === 'de'
                  ? 'Parallel = alle Bilder gleichzeitig. Sequenziell = jedes Bild basiert auf dem vorherigen.'
                  : language === 'fr'
                  ? 'Parallèle = toutes les images simultanément. Séquentiel = chaque image basée sur la précédente.'
                  : 'Parallel = all images at once. Sequential = each image based on previous one.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default StorySettings;
