import { useState, useEffect } from 'react';
import { Wand2, Sparkles, Loader2, Pencil, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useRotatingMessage } from '@/hooks/useRotatingMessage';
import { storyTypes, lifeChallenges, educationalTopics, historicalEvents, realisticSetting } from '@/constants/storyTypes';
import { artStyles } from '@/constants/artStyles';
import type { Character } from '@/types/character';
import type { StoryLanguageCode } from '@/types/story';
import type { GenerationMode } from '@/hooks/useDeveloperMode';

// All story language options for display lookup (user-friendly names, no codes shown)
const STORY_LANGUAGES: { code: StoryLanguageCode; name: string }[] = [
  // German variants
  { code: 'de-ch', name: 'Deutsch (Schweiz)' },
  { code: 'de-de', name: 'Hochdeutsch' },
  { code: 'de-de-north', name: 'Norddeutsch' },
  { code: 'de-de-south', name: 'Süddeutsch' },
  { code: 'de-at', name: 'Deutsch (Österreich)' },
  { code: 'de-it', name: 'Deutsch (Südtirol)' },
  // French variants
  { code: 'fr-ch', name: 'Français (Suisse)' },
  { code: 'fr-fr', name: 'Français (France)' },
  { code: 'fr-be', name: 'Français (Belgique)' },
  { code: 'fr-ca', name: 'Français (Québec)' },
  { code: 'fr-af', name: 'Français (Afrique)' },
  // Italian variants
  { code: 'it-ch', name: 'Italiano (Svizzera)' },
  { code: 'it-it', name: 'Italiano (Standard)' },
  { code: 'it-it-north', name: 'Italiano (Nord)' },
  { code: 'it-it-central', name: 'Italiano (Toscana)' },
  { code: 'it-it-south', name: 'Italiano (Sud)' },
  { code: 'it-sm', name: 'Italiano (San Marino)' },
  // English variants
  { code: 'en-gb', name: 'English (British)' },
  { code: 'en-us', name: 'English (American)' },
  { code: 'en-ca', name: 'English (Canadian)' },
  { code: 'en-au', name: 'English (Australian)' },
  { code: 'en-ie', name: 'English (Irish)' },
  { code: 'en-za', name: 'English (South African)' },
  // Swiss German dialects (Mundart)
  { code: 'gsw-zh', name: 'Züritüütsch' },
  { code: 'gsw-be', name: 'Bärndütsch' },
  { code: 'gsw-bs', name: 'Baseldytsch' },
  { code: 'gsw-lu', name: 'Luzärndütsch' },
  { code: 'gsw-sg', name: 'Sanggallerdütsch' },
  { code: 'gsw-vs', name: 'Walliserdütsch' },
  { code: 'gsw-gr', name: 'Bündnerdütsch' },
  // Legacy codes
  { code: 'en', name: 'English (British)' },
  { code: 'fr', name: 'Français (Suisse)' },
  { code: 'de', name: 'Deutsch (Schweiz)' },
  { code: 'it', name: 'Italiano (Standard)' },
];

interface UserLocation {
  city: string | null;
  region: string | null;
  country: string | null;
}

interface WizardStep6Props {
  // Summary data
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
  storyTopic: string;
  storyTheme: string;
  customThemeText?: string;
  onCustomThemeTextChange?: (text: string) => void;
  artStyle: string;
  storyLanguage: StoryLanguageCode;
  languageLevel: string;
  pages: number;
  userLocation: UserLocation | null;
  season: string;
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
  ideaProgress1?: number;  // Progress 0-100 for idea 1
  ideaProgress2?: number;  // Progress 0-100 for idea 2
  ideaPrompt: { prompt: string; model: string } | null;
  ideaFullResponse?: string;
  generatedIdeas: string[];
  onSelectIdea: (idea: string, index?: number) => void;  // index: 0 or 1 for generated ideas, undefined for custom
  onUseDirectly?: () => void;  // Called when "Use my theme directly" is clicked to start generation
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
  customThemeText = '',
  onCustomThemeTextChange,
  artStyle,
  storyLanguage,
  languageLevel,
  pages,
  userLocation,
  season,
  storyDetails: _storyDetails,
  onStoryDetailsChange: _onStoryDetailsChange,
  dedication,
  onDedicationChange,
  onGenerateIdeas,
  isGeneratingIdeas,
  isGeneratingIdea1 = false,
  isGeneratingIdea2 = false,
  ideaProgress1 = 0,
  ideaProgress2 = 0,
  ideaPrompt,
  ideaFullResponse,
  generatedIdeas,
  onSelectIdea,
  onUseDirectly,
  onEditStep,
  developerMode,
  imageGenMode,
  onImageGenModeChange,
  generationMode = 'auto',
  onGenerationModeChange,
}: WizardStep6Props) {
  const { language } = useLanguage();
  const lang = language as 'en' | 'de' | 'fr';
  const thinkingMessage = useRotatingMessage(lang);

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
    onSelectIdea(editableIdeas[index], index);
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
    const event = historicalEvents.find(e => e.id === storyTopic);
    if (event) {
      const eventName = event.shortName[lang] || event.shortName.en;
      // Show mainPerson if available (e.g., "Mondlandung Neil Armstrong")
      return event.mainPerson ? `${eventName} ${event.mainPerson}` : eventName;
    }
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

  const getSeasonLabel = () => {
    const seasonLabels: Record<string, Record<string, string>> = {
      spring: { de: 'Frühling', fr: 'Printemps', en: 'Spring' },
      summer: { de: 'Sommer', fr: 'Été', en: 'Summer' },
      autumn: { de: 'Herbst', fr: 'Automne', en: 'Autumn' },
      winter: { de: 'Winter', fr: 'Hiver', en: 'Winter' },
    };
    return seasonLabels[season]?.[language] || seasonLabels[season]?.en || season;
  };

  const getLocationLabel = () => {
    if (!userLocation?.city) return language === 'de' ? 'Nicht festgelegt' : language === 'fr' ? 'Non défini' : 'Not set';
    return userLocation.country ? `${userLocation.city}, ${userLocation.country}` : userLocation.city;
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
    lengthLabel: language === 'de' ? 'Länge' : language === 'fr' ? 'Longueur' : 'Length',
    locationLabel: language === 'de' ? 'Ort' : language === 'fr' ? 'Lieu' : 'Location',
    seasonLabel: language === 'de' ? 'Jahreszeit' : language === 'fr' ? 'Saison' : 'Season',
    chooseIdea: language === 'de' ? 'Wählen Sie eine Idee oder bearbeiten Sie sie:' : language === 'fr' ? 'Choisissez une idée ou modifiez-la:' : 'Choose an idea or edit it:',
    useThis: language === 'de' ? 'Diese verwenden' : language === 'fr' ? 'Utiliser celle-ci' : 'Use this',
    option1: language === 'de' ? 'Option 1' : language === 'fr' ? 'Option 1' : 'Option 1',
    option2: language === 'de' ? 'Option 2' : language === 'fr' ? 'Option 2' : 'Option 2',
    selected: language === 'de' ? 'Ausgewählt' : language === 'fr' ? 'Sélectionné' : 'Selected',
    customTheme: language === 'de' ? 'Eigenes Thema' : language === 'fr' ? 'Thème personnalisé' : 'Custom Theme',
    customThemePlaceholder: language === 'de' ? 'Beschreibe dein Abenteuer-Thema...' : language === 'fr' ? 'Décris ton thème...' : 'Describe your adventure theme...',
    useMyTheme: language === 'de' ? 'Mein Thema direkt verwenden' : language === 'fr' ? 'Utiliser mon thème directement' : 'Use my theme directly',
  };

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Wand2 size={24} /> {t.title}
      </h2>

      {/* Summary of all selections - responsive: stack on mobile, 3x3 grid on wide */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-sm bg-gray-50 rounded-lg p-3">
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
        {/* Location - hide for historical stories */}
        {storyCategory !== 'historical' && (
          <div className="flex items-center gap-1 group">
            <span className="text-gray-500 whitespace-nowrap">{t.locationLabel}:</span>
            <span className="font-medium truncate">{getLocationLabel()}</span>
            <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
          </div>
        )}
        {/* Season - hide for historical stories */}
        {storyCategory !== 'historical' && (
          <div className="flex items-center gap-1 group">
            <span className="text-gray-500 whitespace-nowrap">{t.seasonLabel}:</span>
            <span className="font-medium truncate">{getSeasonLabel()}</span>
            <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
          </div>
        )}
        {/* Reading Level */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.level}:</span>
          <span className="font-medium truncate">{getReadingLevelLabel()}</span>
          <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Length (Pages) */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.lengthLabel}:</span>
          <span className="font-medium truncate">{pages} {t.pagesLabel}</span>
          <button onClick={() => onEditStep(2)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
        {/* Art Style */}
        <div className="flex items-center gap-1 group">
          <span className="text-gray-500 whitespace-nowrap">{t.artStyleLabel}:</span>
          <span className="font-medium truncate">{getArtStyleName()}</span>
          <button onClick={() => onEditStep(4)} className="p-0.5 text-gray-400 hover:text-indigo-600 flex-shrink-0 md:opacity-0 md:group-hover:opacity-100" title={language === 'de' ? 'Bearbeiten' : 'Edit'}><Pencil size={10} /></button>
        </div>
      </div>

      {/* Custom Theme - shown when storyTheme is 'custom' */}
      {storyTheme === 'custom' && (
        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-lg font-semibold text-indigo-800 flex items-center gap-2">
              ✨ {t.customTheme}
            </label>
            <button
              onClick={() => {
                if (customThemeText.trim()) {
                  onSelectIdea(customThemeText);
                  onUseDirectly?.();
                }
              }}
              disabled={!customThemeText.trim()}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              <Check size={14} />
              {t.useMyTheme}
            </button>
          </div>
          <textarea
            value={customThemeText}
            onChange={(e) => onCustomThemeTextChange?.(e.target.value)}
            placeholder={t.customThemePlaceholder}
            className="w-full px-3 py-2 border-2 border-indigo-300 rounded-lg focus:border-indigo-500 focus:outline-none text-base bg-white"
            rows={3}
          />
          <p className="text-xs text-indigo-600 mt-1">
            {language === 'de'
              ? 'Dieses Thema wird für die Ideengenerierung verwendet. Du kannst es auch direkt als Handlung verwenden.'
              : language === 'fr'
              ? 'Ce thème sera utilisé pour la génération d\'idées. Tu peux aussi l\'utiliser directement comme intrigue.'
              : 'This theme will be used for idea generation. You can also use it directly as your plot.'}
          </p>
        </div>
      )}

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

        {/* Two-idea selection UI - always show grid layout for consistency */}
        <div className="space-y-4">
          <p className="text-sm text-gray-600 mb-2">{t.chooseIdea}</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[0, 1].map((index) => {
              const idea = editableIdeas[index] || '';
              const hasIdea = !!idea;
              // Show loading if we're generating this specific idea and don't have it yet
              const isLoading = (index === 0 ? isGeneratingIdea1 : isGeneratingIdea2) && !hasIdea;
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
                    <div className="flex items-center justify-center h-64 bg-gray-50 px-8">
                      <div className="text-center text-gray-500 w-full max-w-xs">
                        {/* Progress bar */}
                        <div className="mb-4">
                          <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-indigo-600 rounded-full transition-all duration-300 ease-out"
                              style={{ width: `${index === 0 ? ideaProgress1 : ideaProgress2}%` }}
                            />
                          </div>
                          <div className="text-xs text-gray-400 text-right mt-1">
                            {index === 0 ? ideaProgress1 : ideaProgress2}%
                          </div>
                        </div>
                        <p className="text-sm">
                          {(index === 0 ? ideaProgress1 : ideaProgress2) < 80
                            ? thinkingMessage
                            : (lang === 'de' ? 'Schreibe Idee...' : lang === 'fr' ? 'Rédaction...' : 'Writing idea...')}
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
                        {lang === 'de' ? 'Klicke auf "Vorschlag generieren"' :
                         lang === 'fr' ? 'Cliquez sur "Générer"' :
                         'Click "Generate Suggestion"'}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
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
