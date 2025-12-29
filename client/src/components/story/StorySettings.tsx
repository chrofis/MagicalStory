import { useEffect, useState } from 'react';
import { Wand2, Star, Sparkles, Loader2, Pencil, Palette } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Modal } from '@/components/common/Modal';
import { StoryCategorySelector } from './StoryCategorySelector';
import { ArtStyleSelector } from './ArtStyleSelector';
import { storyTypes, lifeChallenges, educationalTopics } from '@/constants/storyTypes';
import { artStyles } from '@/constants/artStyles';
import type { Character } from '@/types/character';
import type { LanguageLevel, StoryLanguageCode, UILanguage } from '@/types/story';

// Character role in story: 'out' = not in story, 'in' = side character, 'main' = main character
export type CharacterRole = 'out' | 'in' | 'main';

// Re-export for backwards compatibility
export type StoryLanguage = StoryLanguageCode;

export const STORY_LANGUAGES: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-ch', name: 'Deutsch (Schweiz)', flag: '🇨🇭' },
  { code: 'de-de', name: 'Deutsch (Deutschland)', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

interface StorySettingsProps {
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  onCharacterRoleChange: (charId: number, role: CharacterRole) => void;
  storyLanguage: StoryLanguageCode;
  onStoryLanguageChange: (lang: StoryLanguageCode) => void;
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
  // Generate Ideas
  onGenerateIdeas?: () => Promise<void>;
  isGeneratingIdeas?: boolean;
  ideaPrompt?: { prompt: string; model: string } | null;
  // Story type settings (from step 1)
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic?: string;
  storyTheme?: string;
  artStyle?: string;
  onCategoryChange?: (category: 'adventure' | 'life-challenge' | 'educational') => void;
  onTopicChange?: (topic: string) => void;
  onThemeChange?: (theme: string) => void;
  onArtStyleChange?: (style: string) => void;
  onLegacyStoryTypeChange?: (storyType: string) => void;
}

export function StorySettings({
  characters,
  mainCharacters,
  excludedCharacters,
  onCharacterRoleChange,
  storyLanguage,
  onStoryLanguageChange,
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
  onGenerateIdeas,
  isGeneratingIdeas = false,
  ideaPrompt,
  // Story type settings (from step 1)
  storyCategory = '',
  storyTopic = '',
  storyTheme = '',
  artStyle = '',
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onArtStyleChange,
  onLegacyStoryTypeChange,
}: StorySettingsProps) {
  const { t, language } = useLanguage();
  const lang = language as UILanguage;

  // Modal state for editing story type settings
  const [isEditSettingsOpen, setIsEditSettingsOpen] = useState(false);
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false);
  const [isStoryDropdownOpen, setIsStoryDropdownOpen] = useState(false);
  const [isArtStyleDropdownOpen, setIsArtStyleDropdownOpen] = useState(false);

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

  // Helper functions for display names
  const getThemeName = () => {
    if (!storyTheme || storyTheme === 'realistic') return '';
    const theme = storyTypes.find(t => t.id === storyTheme);
    return theme ? (theme.name[lang] || theme.name.en) : '';
  };

  const getThemeEmoji = () => {
    if (!storyTheme || storyTheme === 'realistic') return '';
    const theme = storyTypes.find(t => t.id === storyTheme);
    return theme?.emoji || '';
  };

  const getTopicName = () => {
    if (!storyTopic) return '';
    const challenge = lifeChallenges.find(c => c.id === storyTopic);
    if (challenge) return challenge.name[lang] || challenge.name.en;
    const topic = educationalTopics.find(t => t.id === storyTopic);
    if (topic) return topic.name[lang] || topic.name.en;
    return '';
  };

  const getTopicEmoji = () => {
    if (!storyTopic) return '';
    const challenge = lifeChallenges.find(c => c.id === storyTopic);
    if (challenge) return challenge.emoji;
    const topic = educationalTopics.find(t => t.id === storyTopic);
    return topic?.emoji || '';
  };

  const getArtStyleName = () => {
    const style = artStyles.find(s => s.id === artStyle);
    return style ? (style.name[lang] || style.name.en) : '';
  };

  const getStoryLanguageInfo = () => {
    return STORY_LANGUAGES.find(l => l.code === storyLanguage) || STORY_LANGUAGES[0];
  };

  // Check if we should show the settings summary bar
  const showSettingsSummary = storyCategory && artStyle && (
    storyCategory === 'adventure' ? storyTheme : storyTopic
  );

  return (
    <div className="space-y-6">
      {/* Story Settings Bar - 3 columns: Story, Art Style, Language */}
      {showSettingsSummary && (
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-3">
          <div className="grid grid-cols-3 gap-2 text-sm">
            {/* LEFT: Story Topic/Theme - clickable */}
            <div className="relative">
              <button
                onClick={() => {
                  setIsStoryDropdownOpen(!isStoryDropdownOpen);
                  setIsArtStyleDropdownOpen(false);
                  setIsLanguageDropdownOpen(false);
                }}
                className="w-full inline-flex items-center justify-center gap-1 bg-white border border-green-200 rounded-lg px-2 py-2 hover:border-green-400 transition-colors"
              >
                <span>{getTopicEmoji() || getThemeEmoji()}</span>
                <span className="font-medium text-gray-700 truncate">
                  {storyCategory === 'adventure' ? getThemeName() : (
                    <>
                      {getTopicName()}
                      {storyTheme && storyTheme !== 'realistic' && ` + ${getThemeName()}`}
                    </>
                  )}
                </span>
              </button>
              {isStoryDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 w-full min-w-[200px]">
                  <button
                    onClick={() => {
                      setIsEditSettingsOpen(true);
                      setIsStoryDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-3 text-left hover:bg-gray-50 rounded-lg"
                  >
                    <Pencil size={14} className="text-gray-500" />
                    <span className="font-medium text-gray-700">
                      {language === 'de' ? 'Thema ändern...' : language === 'fr' ? 'Changer le thème...' : 'Change topic...'}
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* MIDDLE: Art Style - clickable */}
            <div className="relative">
              <button
                onClick={() => {
                  setIsArtStyleDropdownOpen(!isArtStyleDropdownOpen);
                  setIsStoryDropdownOpen(false);
                  setIsLanguageDropdownOpen(false);
                }}
                className="w-full inline-flex items-center justify-center gap-1 bg-white border border-purple-200 rounded-lg px-2 py-2 hover:border-purple-400 transition-colors"
              >
                <Palette size={14} className="text-purple-600" />
                <span className="font-medium text-gray-700 truncate">{getArtStyleName()}</span>
              </button>
              {isArtStyleDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 w-full min-w-[200px] max-h-[300px] overflow-y-auto">
                  {artStyles.map((style) => (
                    <button
                      key={style.id}
                      onClick={() => {
                        onArtStyleChange?.(style.id);
                        setIsArtStyleDropdownOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg ${
                        artStyle === style.id ? 'bg-purple-50' : ''
                      }`}
                    >
                      <span>{style.emoji}</span>
                      <span className="font-medium text-gray-700">{style.name[lang] || style.name.en}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* RIGHT: Story Language - clickable */}
            <div className="relative">
              <button
                onClick={() => {
                  setIsLanguageDropdownOpen(!isLanguageDropdownOpen);
                  setIsStoryDropdownOpen(false);
                  setIsArtStyleDropdownOpen(false);
                }}
                className="w-full inline-flex items-center justify-center gap-1 bg-white border border-blue-200 rounded-lg px-2 py-2 hover:border-blue-400 transition-colors"
              >
                <span className="text-base">{getStoryLanguageInfo().flag}</span>
                <span className="font-medium text-gray-700 truncate">{getStoryLanguageInfo().name}</span>
              </button>
              {isLanguageDropdownOpen && (
                <div className="absolute top-full right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 min-w-[180px]">
                  {STORY_LANGUAGES.map((langOption) => (
                    <button
                      key={langOption.code}
                      onClick={() => {
                        onStoryLanguageChange(langOption.code);
                        setIsLanguageDropdownOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 first:rounded-t-lg last:rounded-b-lg ${
                        storyLanguage === langOption.code ? 'bg-blue-50' : ''
                      }`}
                    >
                      <span className="text-base">{langOption.flag}</span>
                      <span className="font-medium text-gray-700">{langOption.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
                      ? 'border-4 border-indigo-600 bg-indigo-50'
                      : 'bg-indigo-50'
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
                          ? 'bg-indigo-600 text-white'
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

        {/* Story Plot / Story Details - Required */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <label className="text-xl font-semibold">
              {t.storyDetails} <span className="text-red-500">*</span>
            </label>
            {onGenerateIdeas && (
              <button
                onClick={onGenerateIdeas}
                disabled={isGeneratingIdeas}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isGeneratingIdeas ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {language === 'de' ? 'Generiere...' : language === 'fr' ? 'Génération...' : 'Generating...'}
                  </>
                ) : (
                  <>
                    <Sparkles size={18} />
                    {language === 'de' ? 'Ideen generieren' : language === 'fr' ? 'Générer des idées' : 'Generate Ideas'}
                  </>
                )}
              </button>
            )}
          </div>
          {/* Developer mode: Show idea generator prompt */}
          {developerMode && ideaPrompt && (
            <details className="mt-2 text-left">
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                Show idea generator prompt ({ideaPrompt.model})
              </summary>
              <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-64 border bg-gray-100 border-gray-200">
                {ideaPrompt.prompt}
              </pre>
            </details>
          )}
          <textarea
            value={storyDetails}
            onChange={(e) => onStoryDetailsChange(e.target.value)}
            placeholder={t.storyDetailsPlaceholder}
            className={`w-full px-3 py-2 border-2 rounded-lg focus:border-indigo-600 focus:outline-none text-base ${
              storyDetails.trim() ? 'border-gray-300' : 'border-orange-300 bg-orange-50'
            }`}
            rows={6}
            disabled={isGeneratingIdeas}
          />
          <p className="text-sm text-gray-500 mt-2">
            {language === 'de'
              ? 'Beschreiben Sie die Handlung oder klicken Sie auf "Ideen generieren"'
              : language === 'fr'
              ? 'Décrivez l\'intrigue ou cliquez sur "Générer des idées"'
              : 'Describe the plot or click "Generate Ideas"'}
          </p>
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
              ? 'Dieser Text wird auf der Einführungsseite Ihres Buches gedruckt. Wenn Sie nichts eingeben, enthält die Einführungsseite nur eine Illustration ohne Text.'
              : language === 'fr'
              ? 'Ce texte sera imprimé sur la page d\'introduction de votre livre. Si vous ne saisissez rien, la page d\'introduction ne contiendra qu\'une illustration sans texte.'
              : 'This text will be printed on the initial page of your book. If you leave it empty, the initial page will contain only an illustration with no text.'}
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

      {/* Edit Settings Modal */}
      {isEditSettingsOpen && onCategoryChange && onTopicChange && onThemeChange && onArtStyleChange && onLegacyStoryTypeChange && (
        <Modal
          isOpen={isEditSettingsOpen}
          onClose={() => setIsEditSettingsOpen(false)}
          title={language === 'de' ? 'Einstellungen bearbeiten' : language === 'fr' ? 'Modifier les paramètres' : 'Edit Settings'}
          size="xl"
        >
          <div className="space-y-6 max-h-[70vh] overflow-y-auto">
            {/* Story Category Selector */}
            <StoryCategorySelector
              storyCategory={storyCategory as 'adventure' | 'life-challenge' | 'educational' | ''}
              storyTopic={storyTopic}
              storyTheme={storyTheme}
              onCategoryChange={onCategoryChange}
              onTopicChange={onTopicChange}
              onThemeChange={onThemeChange}
              onLegacyStoryTypeChange={onLegacyStoryTypeChange}
            />

            {/* Art Style Selector - only show when story type is fully selected */}
            {storyCategory && (storyCategory === 'adventure' ? storyTheme : storyTopic) && (
              <div className="border-t border-gray-200 pt-6">
                <ArtStyleSelector
                  selectedStyle={artStyle}
                  onSelect={onArtStyleChange}
                />
              </div>
            )}

            {/* Done Button */}
            <div className="flex justify-end pt-4 border-t border-gray-200">
              <button
                onClick={() => setIsEditSettingsOpen(false)}
                className="px-6 py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
              >
                {language === 'de' ? 'Fertig' : language === 'fr' ? 'Terminé' : 'Done'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default StorySettings;
