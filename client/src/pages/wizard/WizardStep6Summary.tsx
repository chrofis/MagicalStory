import { Wand2, Sparkles, Loader2, Palette, Pencil } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { storyTypes, lifeChallenges, educationalTopics, realisticSetting } from '@/constants/storyTypes';
import { artStyles } from '@/constants/artStyles';
import type { Character } from '@/types/character';
import type { StoryLanguageCode } from '@/types/story';

// Story language options (same as WizardStep3BookSettings)
const STORY_LANGUAGES: { code: StoryLanguageCode; name: string; flag: string }[] = [
  { code: 'de-ch', name: 'Deutsch (Schweiz)', flag: '🇨🇭' },
  { code: 'de-de', name: 'Deutsch (Deutschland)', flag: '🇩🇪' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
];

interface WizardStep6Props {
  // Summary data
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic: string;
  storyTheme: string;
  artStyle: string;
  storyLanguage: StoryLanguageCode;
  languageLevel: string;
  pages: number;
  // Editable fields
  storyDetails: string;
  onStoryDetailsChange: (details: string) => void;
  dedication: string;
  onDedicationChange: (dedication: string) => void;
  // Idea generator
  onGenerateIdeas: () => Promise<void>;
  isGeneratingIdeas: boolean;
  ideaPrompt: { prompt: string; model: string } | null;
  // Navigation
  onEditStep: (step: number) => void;
  // Developer options
  developerMode: boolean;
  imageGenMode: 'parallel' | 'sequential' | null;
  onImageGenModeChange: (mode: 'parallel' | 'sequential' | null) => void;
}

/**
 * Step 6: Summary & Story Details
 * Shows summary of all selections and allows entering story details
 */
export function WizardStep6Summary({
  characters,
  mainCharacters,
  excludedCharacters,
  storyCategory,
  storyTopic,
  storyTheme,
  artStyle,
  storyLanguage,
  languageLevel,
  pages,
  storyDetails,
  onStoryDetailsChange,
  dedication,
  onDedicationChange,
  onGenerateIdeas,
  isGeneratingIdeas,
  ideaPrompt,
  onEditStep,
  developerMode,
  imageGenMode,
  onImageGenModeChange,
}: WizardStep6Props) {
  const { language } = useLanguage();
  const lang = language as 'en' | 'de' | 'fr';

  // Helper functions
  const getMainCharacterNames = () => {
    return characters
      .filter(c => mainCharacters.includes(c.id))
      .map(c => c.name)
      .join(', ');
  };

  const getSupportingCharacterNames = () => {
    return characters
      .filter(c => !mainCharacters.includes(c.id) && !excludedCharacters.includes(c.id))
      .map(c => c.name)
      .join(', ');
  };

  const getTopicName = () => {
    const challenge = lifeChallenges.find(c => c.id === storyTopic);
    if (challenge) return challenge.name[lang] || challenge.name.en;
    const topic = educationalTopics.find(t => t.id === storyTopic);
    if (topic) return topic.name[lang] || topic.name.en;
    return '';
  };

  const getThemeName = () => {
    if (storyTheme === 'realistic') return realisticSetting.name[lang] || realisticSetting.name.en;
    const theme = storyTypes.find(t => t.id === storyTheme);
    return theme ? theme.name[lang] || theme.name.en : '';
  };

  const getArtStyleName = () => {
    const style = artStyles.find(s => s.id === artStyle);
    return style ? style.name[lang] || style.name.en : artStyle;
  };

  const getStoryLanguageName = () => {
    const langInfo = STORY_LANGUAGES.find(l => l.code === storyLanguage);
    return langInfo ? langInfo.name : storyLanguage;
  };

  const getReadingLevelLabel = () => {
    // Use same labels as WizardStep3BookSettings
    if (languageLevel === '1st-grade') return language === 'de' ? 'Bilderbuch' : language === 'fr' ? 'Album Illustré' : 'Picture Book';
    if (languageLevel === 'standard') return language === 'de' ? 'Kinderbuch' : language === 'fr' ? 'Livre Enfant' : 'Chapter Book';
    if (languageLevel === 'advanced') return language === 'de' ? 'Jugendbuch' : language === 'fr' ? 'Roman Jeunesse' : 'Young Adult';
    return '';
  };

  const t = {
    title: language === 'de' ? 'Geschichte erstellen' : language === 'fr' ? 'Créer l\'histoire' : 'Create Your Story',
    storyDetails: language === 'de' ? 'Geschichte / Handlung' : language === 'fr' ? 'Histoire / Intrigue' : 'Story / Plot',
    storyDetailsPlaceholder: language === 'de'
      ? 'Beschreiben Sie die Handlung Ihrer Geschichte...'
      : language === 'fr'
      ? 'Décrivez l\'intrigue de votre histoire...'
      : 'Describe the plot of your story...',
    optional: language === 'de' ? '(optional)' : language === 'fr' ? '(optionnel)' : '(optional)',
    dedication: language === 'de' ? 'Widmung' : language === 'fr' ? 'Dédicace' : 'Dedication',
    dedicationPlaceholder: language === 'de'
      ? 'z.B. "Für meine liebe Tochter Emma zum 5. Geburtstag"'
      : language === 'fr'
      ? 'Par exemple "Pour ma chère fille Emma pour son 5ème anniversaire"'
      : 'e.g. "For my dear daughter Emma on her 5th birthday"',
    dedicationHelp: language === 'de'
      ? 'Dieser Text wird auf der Einführungsseite Ihres Buches gedruckt.'
      : language === 'fr'
      ? 'Ce texte sera imprimé sur la page d\'introduction de votre livre.'
      : 'This text will be printed on the initial page of your book.',
    generateIdeas: language === 'de' ? 'Vorschlag generieren' : language === 'fr' ? 'Générer une suggestion' : 'Generate Suggestion',
    generating: language === 'de' ? 'Generiere...' : language === 'fr' ? 'Génération...' : 'Generating...',
    storyType: language === 'de' ? 'Geschichte' : language === 'fr' ? 'Histoire' : 'Story',
    artStyleLabel: language === 'de' ? 'Kunststil' : language === 'fr' ? 'Style' : 'Art Style',
    languageLabel: language === 'de' ? 'Sprache' : language === 'fr' ? 'Langue' : 'Language',
    mainChars: language === 'de' ? 'Hauptfiguren' : language === 'fr' ? 'Personnages principaux' : 'Main characters',
    supportingChars: language === 'de' ? 'Nebenfiguren' : language === 'fr' ? 'Personnages secondaires' : 'Also in story',
    level: language === 'de' ? 'Lesestufe' : language === 'fr' ? 'Niveau' : 'Level',
    pagesLabel: language === 'de' ? 'Seiten' : language === 'fr' ? 'Pages' : 'Pages',
  };

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Wand2 size={24} /> {t.title}
      </h2>

      {/* Summary of all selections - ordered by wizard flow */}
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {/* 1. Main Characters → Step 1 */}
          {getMainCharacterNames() && (
            <div className="bg-white rounded-lg p-2 border border-indigo-200 relative group">
              <button
                onClick={() => onEditStep(1)}
                className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
                title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
              >
                <Pencil size={12} />
              </button>
              <span className="text-gray-500 text-xs block">{t.mainChars}</span>
              <span className="font-medium text-indigo-700">{getMainCharacterNames()}</span>
            </div>
          )}

          {/* 2. Supporting Characters → Step 1 */}
          {getSupportingCharacterNames() && (
            <div className="bg-white rounded-lg p-2 border border-gray-200 relative group">
              <button
                onClick={() => onEditStep(1)}
                className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
                title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
              >
                <Pencil size={12} />
              </button>
              <span className="text-gray-500 text-xs block">{t.supportingChars}</span>
              <span className="font-medium text-gray-700">{getSupportingCharacterNames()}</span>
            </div>
          )}

          {/* 3. Language → Step 2 */}
          <div className="bg-white rounded-lg p-2 border border-blue-200 relative group">
            <button
              onClick={() => onEditStep(2)}
              className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
              title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
            >
              <Pencil size={12} />
            </button>
            <span className="text-gray-500 text-xs block">{t.languageLabel}</span>
            <span className="font-medium text-gray-800">{getStoryLanguageName()}</span>
          </div>

          {/* 4. Reading Level & Pages → Step 2 */}
          <div className="bg-white rounded-lg p-2 border border-gray-200 relative group">
            <button
              onClick={() => onEditStep(2)}
              className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
              title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
            >
              <Pencil size={12} />
            </button>
            <span className="text-gray-500 text-xs block">{t.level} / {t.pagesLabel}</span>
            <span className="font-medium text-gray-700">{getReadingLevelLabel()} / {pages} {t.pagesLabel.toLowerCase()}</span>
          </div>

          {/* 5. Story Type → Step 3 */}
          <div className="bg-white rounded-lg p-2 border border-green-200 relative group">
            <button
              onClick={() => onEditStep(3)}
              className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
              title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
            >
              <Pencil size={12} />
            </button>
            <span className="text-gray-500 text-xs block">{t.storyType}</span>
            <span className="font-medium text-gray-800">
              {storyCategory === 'adventure' ? getThemeName() : (
                <>
                  {getTopicName()}
                  {storyTheme && storyTheme !== 'realistic' && ` + ${getThemeName()}`}
                </>
              )}
            </span>
          </div>

          {/* 6. Art Style → Step 4 */}
          <div className="bg-white rounded-lg p-2 border border-purple-200 relative group">
            <button
              onClick={() => onEditStep(4)}
              className="absolute top-1 right-1 p-1 text-gray-400 hover:text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity"
              title={language === 'de' ? 'Bearbeiten' : language === 'fr' ? 'Modifier' : 'Edit'}
            >
              <Pencil size={12} />
            </button>
            <span className="text-gray-500 text-xs block">{t.artStyleLabel}</span>
            <span className="font-medium text-gray-800 flex items-center gap-1">
              <Palette size={14} className="text-purple-600" />
              {getArtStyleName()}
            </span>
          </div>
        </div>
      </div>

      {/* Story Details - Required */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-xl font-semibold">
            {t.storyDetails} <span className="text-red-500">*</span>
          </label>
          <button
            onClick={onGenerateIdeas}
            disabled={isGeneratingIdeas}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {isGeneratingIdeas ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                {t.generating}
              </>
            ) : (
              <>
                <Sparkles size={18} />
                {t.generateIdeas}
              </>
            )}
          </button>
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
      </div>

      {/* Dedication - Optional */}
      <div>
        <label className="block text-xl font-semibold mb-3">
          {t.dedication} <span className="text-sm font-normal text-gray-500">{t.optional}</span>
        </label>
        <textarea
          value={dedication}
          onChange={(e) => onDedicationChange(e.target.value)}
          placeholder={t.dedicationPlaceholder}
          className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-indigo-600 focus:outline-none text-base"
          rows={2}
          maxLength={200}
        />
        <p className="text-sm text-gray-500 mt-1">{t.dedicationHelp}</p>
      </div>

      {/* Developer Options */}
      {developerMode && (
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-4">
          <h3 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
            {language === 'de' ? 'Entwickler-Optionen' : language === 'fr' ? 'Options développeur' : 'Developer Options'}
          </h3>

          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              {language === 'de' ? 'Bildgenerierungsmodus' : language === 'fr' ? 'Mode de génération d\'images' : 'Image Generation Mode'}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => onImageGenModeChange(null)}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  imageGenMode === null
                    ? 'bg-yellow-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {language === 'de' ? 'Server-Standard' : language === 'fr' ? 'Par défaut serveur' : 'Server Default'}
              </button>
              <button
                onClick={() => onImageGenModeChange('parallel')}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  imageGenMode === 'parallel'
                    ? 'bg-yellow-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {language === 'de' ? 'Parallel (schnell)' : language === 'fr' ? 'Parallèle (rapide)' : 'Parallel (fast)'}
              </button>
              <button
                onClick={() => onImageGenModeChange('sequential')}
                className={`px-3 py-2 rounded-lg text-sm font-medium ${
                  imageGenMode === 'sequential'
                    ? 'bg-yellow-500 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                {language === 'de' ? 'Sequenziell (konsistent)' : language === 'fr' ? 'Séquentiel (cohérent)' : 'Sequential (consistent)'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
