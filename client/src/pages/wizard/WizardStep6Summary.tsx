import { useState, useEffect } from 'react';
import { Wand2, Sparkles, Loader2, Pencil, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { storyTypes, lifeChallenges, educationalTopics, realisticSetting } from '@/constants/storyTypes';
import { artStyles } from '@/constants/artStyles';
import type { Character } from '@/types/character';
import type { StoryLanguageCode } from '@/types/story';
import type { GenerationMode } from '@/hooks/useDeveloperMode';

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
  isGeneratingIdea1?: boolean;
  isGeneratingIdea2?: boolean;
  ideaPrompt: { prompt: string; model: string } | null;
  ideaFullResponse?: string;
  generatedIdeas: string[];
  onSelectIdea: (idea: string) => void;
  // Navigation
  onEditStep: (step: number) => void;
  // Developer options
  developerMode: boolean;
  imageGenMode: 'parallel' | 'sequential' | null;
  onImageGenModeChange: (mode: 'parallel' | 'sequential' | null) => void;
  generationMode?: GenerationMode;
  onGenerationModeChange?: (mode: GenerationMode) => void;
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
  isGeneratingIdea1 = false,
  isGeneratingIdea2 = false,
  ideaPrompt,
  ideaFullResponse,
  generatedIdeas,
  onSelectIdea,
  onEditStep,
  developerMode,
  imageGenMode,
  onImageGenModeChange,
  generationMode = 'auto',
  onGenerationModeChange,
}: WizardStep6Props) {
  const { language } = useLanguage();
  const lang = language as 'en' | 'de' | 'fr';

  // Editable versions of the generated ideas
  const [editableIdeas, setEditableIdeas] = useState<string[]>([]);
  // Track which option is selected (null = none, 0 = first, 1 = second)
  const [selectedOption, setSelectedOption] = useState<number | null>(null);

  // Sync editable ideas when generated ideas change
  useEffect(() => {
    if (generatedIdeas.length > 0) {
      setEditableIdeas([...generatedIdeas]);
      setSelectedOption(null); // Reset selection when new ideas arrive
    } else {
      setEditableIdeas([]);
      setSelectedOption(null);
    }
  }, [generatedIdeas]);

  // Handle option selection
  const handleSelectOption = (index: number) => {
    setSelectedOption(index);
    onSelectIdea(editableIdeas[index]);
  };

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
      ? 'Beschreibe die Handlung deiner Geschichte...'
      : language === 'fr'
      ? 'Décris l\'intrigue de ton histoire...'
      : 'Describe the plot of your story...',
    optional: language === 'de' ? '(optional)' : language === 'fr' ? '(optionnel)' : '(optional)',
    dedication: language === 'de' ? 'Widmung' : language === 'fr' ? 'Dédicace' : 'Dedication',
    dedicationPlaceholder: language === 'de'
      ? 'z.B. "Für meine liebe Tochter Emma zum 5. Geburtstag"'
      : language === 'fr'
      ? 'Par exemple "Pour ma chère fille Emma pour son 5ème anniversaire"'
      : 'e.g. "For my dear daughter Emma on her 5th birthday"',
    dedicationHelp: language === 'de'
      ? 'Dieser Text wird auf der Einführungsseite deines Buches gedruckt.'
      : language === 'fr'
      ? 'Ce texte sera imprimé sur la page d\'introduction de ton livre.'
      : 'This text will be printed on the initial page of your book.',
    generateIdeas: language === 'de' ? 'Vorschlag generieren' : language === 'fr' ? 'Générer une suggestion' : 'Generate Suggestion',
    generating: language === 'de' ? 'Generiere...' : language === 'fr' ? 'Génération...' : 'Generating...',
    storyType: language === 'de' ? 'Geschichte' : language === 'fr' ? 'Histoire' : 'Story',
    artStyleLabel: language === 'de' ? 'Kunststil' : language === 'fr' ? 'Style' : 'Art Style',
    languageLabel: language === 'de' ? 'Sprachvariante' : language === 'fr' ? 'Variante de langue' : 'Language Variant',
    mainChars: language === 'de' ? 'Hauptfiguren' : language === 'fr' ? 'Personnages principaux' : 'Main characters',
    supportingChars: language === 'de' ? 'Nebenfiguren' : language === 'fr' ? 'Personnages secondaires' : 'Also in story',
    level: language === 'de' ? 'Lesestufe' : language === 'fr' ? 'Niveau' : 'Level',
    pagesLabel: language === 'de' ? 'Seiten' : language === 'fr' ? 'Pages' : 'Pages',
    chooseIdea: language === 'de' ? 'Wählen Sie eine Idee oder bearbeiten Sie sie:' : language === 'fr' ? 'Choisissez une idée ou modifiez-la:' : 'Choose an idea or edit it:',
    useThis: language === 'de' ? 'Diese verwenden' : language === 'fr' ? 'Utiliser celle-ci' : 'Use this',
    option1: language === 'de' ? 'Option 1' : language === 'fr' ? 'Option 1' : 'Option 1',
    option2: language === 'de' ? 'Option 2' : language === 'fr' ? 'Option 2' : 'Option 2',
    selected: language === 'de' ? 'Ausgewählt' : language === 'fr' ? 'Sélectionné' : 'Selected',
  };

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Wand2 size={24} /> {t.title}
      </h2>

      {/* Summary of all selections - responsive: stack on mobile, 3x2 grid on wide */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-sm bg-gray-50 rounded-lg p-3">
        {/* Main Characters */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.mainChars}:</span>
          <span className="font-medium text-indigo-700 truncate">{getMainCharacterNames() || '-'}</span>
          <button onClick={() => onEditStep(1)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Supporting Characters */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.supportingChars}:</span>
          <span className="font-medium text-gray-700 truncate">{getSupportingCharacterNames() || '-'}</span>
          <button onClick={() => onEditStep(1)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Language */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.languageLabel}:</span>
          <span className="font-medium truncate">{getStoryLanguageName()}</span>
          <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Reading Level & Pages */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.level}:</span>
          <span className="font-medium truncate">{getReadingLevelLabel()} / {pages} {language === 'de' ? t.pagesLabel : t.pagesLabel.toLowerCase()}</span>
          <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Story Type */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.storyType}:</span>
          <span className="font-medium truncate">
            {storyCategory === 'adventure' ? getThemeName() : (
              <>{getTopicName()}{storyTheme && storyTheme !== 'realistic' && ` + ${getThemeName()}`}</>
            )}
          </span>
          <button onClick={() => onEditStep(3)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Art Style */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.artStyleLabel}:</span>
          <span className="font-medium truncate">{getArtStyleName()}</span>
          <button onClick={() => onEditStep(4)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
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

        {/* Developer mode: Show idea generator prompt and response */}
        {developerMode && ideaPrompt && (
          <div className="space-y-2 mt-2 text-left">
            <details>
              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                Show idea generator prompt ({ideaPrompt.model})
              </summary>
              <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-64 border bg-gray-100 border-gray-200">
                {ideaPrompt.prompt}
              </pre>
            </details>
            {ideaFullResponse && (
              <details>
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                  Show full LLM response
                </summary>
                <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-64 border bg-blue-50 border-blue-200">
                  {ideaFullResponse}
                </pre>
              </details>
            )}
          </div>
        )}

        {/* Two-idea selection UI - show grid as soon as we have any ideas or are generating */}
        {(editableIdeas.length >= 1 || isGeneratingIdea1 || isGeneratingIdea2) ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 mb-2">{t.chooseIdea}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {[0, 1].map((index) => {
                const idea = editableIdeas[index] || '';
                const hasIdea = !!idea;
                // Show loading if we're generating and don't have this story yet
                const isLoading = isGeneratingIdeas && !hasIdea;
                const isSelected = selectedOption === index;
                const optionTitle = index === 0 ? t.option1 : t.option2;

                return (
                  <div
                    key={index}
                    className={`flex flex-col rounded-xl overflow-hidden transition-all ${
                      isLoading
                        ? 'ring-1 ring-gray-200 opacity-75'
                        : isSelected
                        ? 'ring-4 ring-green-500 shadow-lg shadow-green-100'
                        : 'ring-1 ring-gray-200 hover:ring-2 hover:ring-indigo-300'
                    }`}
                  >
                    {/* Title bar */}
                    <div className={`px-4 py-2 font-semibold flex items-center justify-between ${
                      isLoading
                        ? 'bg-gray-100 text-gray-500'
                        : isSelected
                        ? 'bg-green-500 text-white'
                        : 'bg-gray-100 text-gray-700'
                    }`}>
                      <span>{optionTitle}</span>
                      {isSelected && !isLoading && (
                        <span className="flex items-center gap-1 text-sm">
                          <Check size={16} />
                          {t.selected}
                        </span>
                      )}
                    </div>

                    {/* Content area */}
                    {isLoading ? (
                      <div className="flex items-center justify-center h-64 bg-gray-50">
                        <div className="text-center text-gray-500">
                          <Loader2 size={32} className="animate-spin mx-auto mb-2" />
                          <p className="text-sm">
                            {lang === 'de' ? 'Geschichte wird erstellt...' :
                             lang === 'fr' ? 'Création de l\'histoire...' :
                             'Creating story idea...'}
                          </p>
                        </div>
                      </div>
                    ) : hasIdea ? (
                      <>
                        {/* Textarea */}
                        <textarea
                          value={idea}
                          onChange={(e) => {
                            const newIdeas = [...editableIdeas];
                            newIdeas[index] = e.target.value;
                            setEditableIdeas(newIdeas);
                            // If this option was selected, update the story details too
                            if (isSelected) {
                              onSelectIdea(e.target.value);
                            }
                          }}
                          className={`w-full px-4 py-3 border-0 focus:outline-none focus:ring-0 text-base resize-none ${
                            isSelected ? 'bg-green-50' : 'bg-white'
                          }`}
                          rows={10}
                        />
                        {/* Select button */}
                        <button
                          onClick={() => handleSelectOption(index)}
                          className={`flex items-center justify-center gap-2 px-4 py-3 font-semibold transition-all ${
                            isSelected
                              ? 'bg-green-600 text-white cursor-default'
                              : 'bg-indigo-600 text-white hover:bg-indigo-700'
                          }`}
                        >
                          <Check size={18} />
                          {isSelected ? t.selected : t.useThis}
                        </button>
                      </>
                    ) : (
                      <div className="flex items-center justify-center h-64 bg-gray-50 text-gray-400">
                        <p className="text-sm">
                          {lang === 'de' ? 'Warte auf Idee...' :
                           lang === 'fr' ? 'En attente...' :
                           'Waiting...'}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
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
        )}
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

          {/* Generation Pipeline */}
          {onGenerationModeChange && (
            <div className="mt-4">
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Generation Pipeline
              </label>
              <select
                value={generationMode}
                onChange={(e) => onGenerationModeChange(e.target.value as GenerationMode)}
                className="w-full px-3 py-2 border-2 border-yellow-400 rounded-lg focus:border-yellow-600 focus:outline-none text-sm font-medium bg-white"
              >
                <option value="auto">Auto (based on reading level)</option>
                <option value="pictureBook">Single Prompt (Picture Book)</option>
                <option value="outlineAndText">Outline + Text (Standard)</option>
              </select>
              <p className="text-xs text-gray-600 mt-1">
                Auto: 1st-grade uses single prompt, standard/advanced use outline+text.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
