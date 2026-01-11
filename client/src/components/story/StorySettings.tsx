import { useState, useEffect } from 'react';
import { Wand2, Sparkles, Loader2, Pencil, Palette, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Modal } from '@/components/common/Modal';
import { StoryCategorySelector } from './StoryCategorySelector';
import { storyTypes, lifeChallenges, educationalTopics } from '@/constants/storyTypes';
import { artStyles } from '@/constants/artStyles';
import type { Character } from '@/types/character';
import type { StoryLanguageCode, UILanguage } from '@/types/story';

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
  storyLanguage: StoryLanguageCode;
  onStoryLanguageChange: (lang: StoryLanguageCode) => void;
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
  generatedIdeas?: string[];
  onSelectIdea?: (idea: string) => void;
  // Story type settings (from step 4)
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
  storyTopic?: string;
  storyTheme?: string;
  customThemeText?: string;
  artStyle?: string;
  onCategoryChange?: (category: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '') => void;
  onTopicChange?: (topic: string) => void;
  onThemeChange?: (theme: string) => void;
  onCustomThemeTextChange?: (text: string) => void;
  onArtStyleChange?: (style: string) => void;
  onLegacyStoryTypeChange?: (storyType: string) => void;
  // Book settings for summary
  languageLevel?: string;
  pages?: number;
}

export function StorySettings({
  characters,
  mainCharacters,
  excludedCharacters,
  storyLanguage,
  onStoryLanguageChange,
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
  generatedIdeas = [],
  onSelectIdea,
  // Story type settings (from step 4)
  storyCategory = '',
  storyTopic = '',
  storyTheme = '',
  customThemeText = '',
  artStyle = '',
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onArtStyleChange,
  onLegacyStoryTypeChange,
  // Book settings for summary
  languageLevel = '',
  pages = 0,
}: StorySettingsProps) {
  const { t, language } = useLanguage();
  const lang = language as UILanguage;

  // Modal state for editing story type settings
  const [isEditSettingsOpen, setIsEditSettingsOpen] = useState(false);
  const [isLanguageDropdownOpen, setIsLanguageDropdownOpen] = useState(false);
  const [isStoryDropdownOpen, setIsStoryDropdownOpen] = useState(false);
  const [isArtStyleDropdownOpen, setIsArtStyleDropdownOpen] = useState(false);

  // Editable versions of the generated ideas
  const [editableIdeas, setEditableIdeas] = useState<string[]>([]);

  // Sync editable ideas when generated ideas change
  useEffect(() => {
    if (generatedIdeas.length > 0) {
      setEditableIdeas([...generatedIdeas]);
    } else {
      setEditableIdeas([]);
    }
  }, [generatedIdeas]);

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

  // Get main character names
  const getMainCharacterNames = () => {
    return characters
      .filter(c => mainCharacters.includes(c.id))
      .map(c => c.name)
      .join(', ');
  };

  // Get supporting character names (in story but not main)
  const getSupportingCharacterNames = () => {
    return characters
      .filter(c => !excludedCharacters.includes(c.id) && !mainCharacters.includes(c.id))
      .map(c => c.name)
      .join(', ');
  };

  // Get reading level label
  const getReadingLevelLabel = () => {
    if (languageLevel === '1st-grade') return t.firstGrade;
    if (languageLevel === 'standard') return t.standard;
    if (languageLevel === 'advanced') return t.advanced;
    return '';
  };

  // Check if story type selection is complete (artStyle is now a separate step)
  const isStoryTypeComplete = storyCategory && (
    storyCategory === 'adventure' ? storyTheme : storyTopic
  );

  return (
    <div className="space-y-6">
      {/* Story Type Selection - Show inline when not complete */}
      {!isStoryTypeComplete && onCategoryChange && onTopicChange && onThemeChange && onLegacyStoryTypeChange && (
        <StoryCategorySelector
          storyCategory={storyCategory as 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | ''}
          storyTopic={storyTopic}
          storyTheme={storyTheme}
          customThemeText={customThemeText}
          onCategoryChange={onCategoryChange}
          onTopicChange={onTopicChange}
          onThemeChange={onThemeChange}
          onCustomThemeTextChange={onCustomThemeTextChange}
          onLegacyStoryTypeChange={onLegacyStoryTypeChange}
        />
      )}

      {/* Story Settings Bar - 3 columns: Story, Art Style, Language (shown when story type is complete) */}
      {isStoryTypeComplete && (
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
        {/* Compact Summary - Characters and Book Settings */}
        {isStoryTypeComplete && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {/* Main Characters */}
              {getMainCharacterNames() && (
                <div>
                  <span className="text-gray-500">
                    {language === 'de' ? 'Hauptfiguren' : language === 'fr' ? 'Personnages principaux' : 'Main characters'}:
                  </span>{' '}
                  <span className="font-medium text-indigo-700">{getMainCharacterNames()}</span>
                </div>
              )}
              {/* Supporting Characters */}
              {getSupportingCharacterNames() && (
                <div>
                  <span className="text-gray-500">
                    {language === 'de' ? 'Nebenfiguren' : language === 'fr' ? 'Personnages secondaires' : 'Also in story'}:
                  </span>{' '}
                  <span className="font-medium">{getSupportingCharacterNames()}</span>
                </div>
              )}
              {/* Reading Level */}
              {languageLevel && (
                <div>
                  <span className="text-gray-500">
                    {language === 'de' ? 'Lesestufe' : language === 'fr' ? 'Niveau' : 'Level'}:
                  </span>{' '}
                  <span className="font-medium">{getReadingLevelLabel()}</span>
                </div>
              )}
              {/* Pages */}
              {pages > 0 && (
                <div>
                  <span className="text-gray-500">
                    {language === 'de' ? 'Seiten' : language === 'fr' ? 'Pages' : 'Pages'}:
                  </span>{' '}
                  <span className="font-medium">{pages}</span>
                </div>
              )}
            </div>
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
                    {language === 'de' ? 'Vorschlag generieren' : language === 'fr' ? 'Générer une suggestion' : 'Generate Suggestion'}
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

          {/* Two-idea selection UI */}
          {editableIdeas.length >= 2 ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 mb-2">
                {language === 'de'
                  ? 'Wählen Sie eine Idee oder bearbeiten Sie sie:'
                  : language === 'fr'
                  ? 'Choisissez une idée ou modifiez-la:'
                  : 'Choose an idea or edit it:'}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {editableIdeas.map((idea, index) => (
                  <div key={index} className="flex flex-col">
                    <textarea
                      value={idea}
                      onChange={(e) => {
                        const newIdeas = [...editableIdeas];
                        newIdeas[index] = e.target.value;
                        setEditableIdeas(newIdeas);
                      }}
                      className="w-full px-3 py-2 border-2 border-gray-300 rounded-t-lg focus:border-indigo-600 focus:outline-none text-base resize-none"
                      rows={6}
                    />
                    <button
                      onClick={() => onSelectIdea?.(editableIdeas[index])}
                      className="flex items-center justify-center gap-2 px-4 py-2 bg-green-600 text-white rounded-b-lg font-semibold hover:bg-green-700 transition-all"
                    >
                      <Check size={18} />
                      {language === 'de' ? 'Diese verwenden' : language === 'fr' ? 'Utiliser celle-ci' : 'Use this'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <>
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
                  ? 'Beschreiben Sie die Handlung oder klicken Sie auf "Vorschlag generieren"'
                  : language === 'fr'
                  ? 'Décrivez l\'intrigue ou cliquez sur "Générer une suggestion"'
                  : 'Describe the plot or click "Generate Suggestion"'}
              </p>
            </>
          )}
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
      {isEditSettingsOpen && onCategoryChange && onTopicChange && onThemeChange && onLegacyStoryTypeChange && (
        <Modal
          isOpen={isEditSettingsOpen}
          onClose={() => setIsEditSettingsOpen(false)}
          title={language === 'de' ? 'Einstellungen bearbeiten' : language === 'fr' ? 'Modifier les paramètres' : 'Edit Settings'}
          size="xl"
        >
          <div className="space-y-6 max-h-[70vh] overflow-y-auto">
            {/* Story Category Selector */}
            <StoryCategorySelector
              storyCategory={storyCategory as 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | ''}
              storyTopic={storyTopic}
              storyTheme={storyTheme}
              onCategoryChange={onCategoryChange}
              onTopicChange={onTopicChange}
              onThemeChange={onThemeChange}
              onLegacyStoryTypeChange={onLegacyStoryTypeChange}
            />

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
