import { useState, useMemo } from 'react';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import type { StoryInput } from '../TrialWizard';
import {
  storyCategories,
  storyTypes,
  lifeChallenges,
  historicalEvents,
  getStoryTypesByGroup,
  getLifeChallengesByGroup,
  getHistoricalEventsByGroup,
} from '@/constants/storyTypes';
import type { Language } from '@/types/story';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Props {
  storyInput: StoryInput;
  onChange: (data: StoryInput) => void;
  onBack: () => void;
  onNext: () => void;
}

type TrialCategory = 'adventure' | 'life-challenge' | 'historical';

// Only show these 3 categories for trial
const trialCategories = storyCategories.filter(
  (c) => c.id === 'adventure' || c.id === 'life-challenge' || c.id === 'historical'
);

// ─── Localized strings ──────────────────────────────────────────────────────

const strings: Record<string, {
  title: string;
  subtitle: string;
  pickCategory: string;
  pickTheme: string;
  pickTopic: string;
  pickStyle: string;
  styleRealistic: string;
  orCustom: string;
  customPlaceholder: string;
  back: string;
  next: string;
  change: string;
}> = {
  en: {
    title: 'Choose Your Story',
    subtitle: 'What kind of adventure should we create?',
    pickCategory: 'Pick a story type',
    pickTheme: 'Pick a theme',
    pickTopic: 'Pick a topic',
    pickStyle: 'Pick a story style (optional)',
    styleRealistic: 'Realistic',
    orCustom: 'Or describe your own topic:',
    customPlaceholder: 'e.g. Learning to share toys with a sibling',
    back: 'Back',
    next: 'Next',
    change: 'Change',
  },
  de: {
    title: 'Wahle deine Geschichte',
    subtitle: 'Welches Abenteuer sollen wir erschaffen?',
    pickCategory: 'Wahle eine Geschichtsart',
    pickTheme: 'Wahle ein Thema',
    pickTopic: 'Wahle ein Thema',
    pickStyle: 'Wahle einen Stil (optional)',
    styleRealistic: 'Realistisch',
    orCustom: 'Oder beschreibe dein eigenes Thema:',
    customPlaceholder: 'z.B. Spielzeug mit Geschwistern teilen lernen',
    back: 'Zuruck',
    next: 'Weiter',
    change: 'Andern',
  },
  fr: {
    title: 'Choisis ton histoire',
    subtitle: 'Quel type d\'aventure allons-nous creer?',
    pickCategory: 'Choisis un type d\'histoire',
    pickTheme: 'Choisis un theme',
    pickTopic: 'Choisis un sujet',
    pickStyle: 'Choisis un style (optionnel)',
    styleRealistic: 'Realiste',
    orCustom: 'Ou decrivez votre propre sujet:',
    customPlaceholder: 'ex. Apprendre a partager ses jouets avec un frere ou une soeur',
    back: 'Retour',
    next: 'Suivant',
    change: 'Changer',
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function TrialTopicStep({ storyInput, onChange, onBack, onNext }: Props) {
  const lang = (storyInput.language === 'de' ? 'de' : storyInput.language === 'fr' ? 'fr' : 'en') as Language;
  const t = useMemo(() => strings[lang] || strings.en, [lang]);

  // Custom topic input for life challenges
  const [customTopic, setCustomTopic] = useState('');

  // ─── Handlers ──────────────────────────────────────────────────────────────

  const handleCategorySelect = (categoryId: TrialCategory) => {
    onChange({
      ...storyInput,
      storyCategory: categoryId,
      storyTopic: '',
      storyTheme: categoryId === 'adventure' || categoryId === 'historical' ? '' : 'realistic',
    });
  };

  const handleThemeSelect = (themeId: string) => {
    onChange({
      ...storyInput,
      storyTheme: themeId,
    });
  };

  const handleTopicSelect = (topicId: string) => {
    onChange({
      ...storyInput,
      storyTopic: topicId,
    });
  };

  const handleResetCategory = () => {
    onChange({
      ...storyInput,
      storyCategory: '',
      storyTopic: '',
      storyTheme: '',
      storyDetails: '',
    });
    setCustomTopic('');
  };

  const handleNext = () => {
    // If custom topic entered for life challenges, save it to storyDetails
    if (storyInput.storyCategory === 'life-challenge' && customTopic.trim() && !storyInput.storyTopic) {
      onChange({ ...storyInput, storyTopic: 'custom', storyDetails: customTopic.trim() });
    }
    onNext();
  };

  // ─── Determine if selection is complete ────────────────────────────────────

  const isComplete = (() => {
    if (!storyInput.storyCategory) return false;
    if (storyInput.storyCategory === 'adventure') return !!storyInput.storyTheme;
    if (storyInput.storyCategory === 'historical') return !!storyInput.storyTopic;
    if (storyInput.storyCategory === 'life-challenge') return (!!storyInput.storyTopic || !!customTopic.trim());
    return !!storyInput.storyTopic;
  })();

  // ─── Render: Category selection ────────────────────────────────────────────

  if (!storyInput.storyCategory) {
    return (
      <div className="max-w-2xl mx-auto pt-4">
        <h2 className="text-2xl font-bold text-gray-900 text-center mb-2">{t.title}</h2>
        <p className="text-gray-500 text-center mb-8">{t.subtitle}</p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          {trialCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id as TrialCategory)}
              className="p-6 rounded-xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-center group"
            >
              <div className="text-5xl mb-3 group-hover:scale-110 transition-transform">{category.emoji}</div>
              <div className="font-bold text-lg text-gray-800">
                {category.name[lang] || category.name.en}
              </div>
              <div className="text-sm text-gray-500 mt-1">
                {category.description[lang] || category.description.en}
              </div>
            </button>
          ))}
        </div>

        {/* Back button */}
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.back}
        </button>
      </div>
    );
  }

  // ─── Render: Adventure theme selection ─────────────────────────────────────

  if (storyInput.storyCategory === 'adventure' && !storyInput.storyTheme) {
    const catData = trialCategories.find((c) => c.id === 'adventure');

    return (
      <div className="max-w-2xl mx-auto pt-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-2 mb-5">
          <div className="inline-flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-indigo-200 shadow-sm text-sm">
            <span className="text-lg">{catData?.emoji}</span>
            <span className="font-semibold text-gray-700">
              {catData?.name[lang] || catData?.name.en}
            </span>
            <button
              onClick={handleResetCategory}
              className="ml-1 text-indigo-500 hover:text-indigo-700 text-xs font-medium"
            >
              {t.change}
            </button>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Sparkles className="text-indigo-600 w-5 h-5" />
          {t.pickTheme}
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-8">
          {getStoryTypesByGroup('popular').map((type) => (
            <button
              key={type.id}
              onClick={() => handleThemeSelect(type.id)}
              className="p-2.5 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-center"
            >
              <div className="text-2xl mb-1">{type.emoji}</div>
              <div className="font-medium text-xs text-gray-700">
                {type.name[lang] || type.name.en}
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.back}
        </button>
      </div>
    );
  }

  // ─── Render: Life Challenge topic + style selection ─────────────────────────

  if (storyInput.storyCategory === 'life-challenge') {
    const catData = trialCategories.find((c) => c.id === 'life-challenge');
    const hasTopicSelected = !!storyInput.storyTopic || !!customTopic.trim();
    const popularThemes = getStoryTypesByGroup('popular');

    return (
      <div className="max-w-2xl mx-auto pt-4">
        <div className="flex items-center gap-2 mb-5">
          <div className="inline-flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-indigo-200 shadow-sm text-sm">
            <span className="text-lg">{catData?.emoji}</span>
            <span className="font-semibold text-gray-700">
              {catData?.name[lang] || catData?.name.en}
            </span>
            <button
              onClick={handleResetCategory}
              className="ml-1 text-indigo-500 hover:text-indigo-700 text-xs font-medium"
            >
              {t.change}
            </button>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Sparkles className="text-indigo-600 w-5 h-5" />
          {t.pickTopic}
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
          {getLifeChallengesByGroup('popular').map((challenge) => (
            <button
              key={challenge.id}
              onClick={() => { handleTopicSelect(challenge.id); setCustomTopic(''); }}
              className={`p-2.5 rounded-lg border transition-all text-left flex items-center gap-2 ${
                storyInput.storyTopic === challenge.id
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                  : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              <span className="text-xl">{challenge.emoji}</span>
              <span className="text-sm font-medium text-gray-700">
                {challenge.name[lang] || challenge.name.en}
              </span>
            </button>
          ))}
        </div>

        {/* Custom topic input */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-600 mb-2">{t.orCustom}</label>
          <input
            type="text"
            value={customTopic}
            onChange={(e) => {
              setCustomTopic(e.target.value);
              if (e.target.value.trim()) {
                onChange({ ...storyInput, storyTopic: '' });
              }
            }}
            placeholder={t.customPlaceholder}
            maxLength={200}
            className="w-full px-4 py-2.5 rounded-lg border border-gray-300 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 outline-none transition-all text-gray-900 placeholder-gray-400"
          />
        </div>

        {/* Adventure style selector — shown when a topic is selected */}
        {hasTopicSelected && (
          <div className="mb-6">
            <h3 className="text-base font-bold text-gray-900 mb-3">{t.pickStyle}</h3>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              <button
                onClick={() => handleThemeSelect('realistic')}
                className={`p-2.5 rounded-lg border transition-all text-center ${
                  storyInput.storyTheme === 'realistic'
                    ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                    : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50'
                }`}
              >
                <div className="text-2xl mb-1">📖</div>
                <div className="font-medium text-xs text-gray-700">{t.styleRealistic}</div>
              </button>
              {popularThemes.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => handleThemeSelect(theme.id)}
                  className={`p-2.5 rounded-lg border transition-all text-center ${
                    storyInput.storyTheme === theme.id
                      ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-200'
                      : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50'
                  }`}
                >
                  <div className="text-2xl mb-1">{theme.emoji}</div>
                  <div className="font-medium text-xs text-gray-700">
                    {theme.name[lang] || theme.name.en}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Next button */}
        {hasTopicSelected && (
          <button
            onClick={handleNext}
            className="w-full py-3 rounded-xl text-base font-semibold flex items-center justify-center gap-2 transition-all bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200 mb-4"
          >
            {t.next}
            <ArrowRight className="w-4 h-4" />
          </button>
        )}

        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.back}
        </button>
      </div>
    );
  }

  // ─── Render: Historical event selection ──────────────────────────────────

  if (storyInput.storyCategory === 'historical' && !storyInput.storyTopic) {
    const catData = trialCategories.find((c) => c.id === 'historical');

    return (
      <div className="max-w-2xl mx-auto pt-4">
        <div className="flex items-center gap-2 mb-5">
          <div className="inline-flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-indigo-200 shadow-sm text-sm">
            <span className="text-lg">{catData?.emoji}</span>
            <span className="font-semibold text-gray-700">
              {catData?.name[lang] || catData?.name.en}
            </span>
            <button
              onClick={handleResetCategory}
              className="ml-1 text-indigo-500 hover:text-indigo-700 text-xs font-medium"
            >
              {t.change}
            </button>
          </div>
        </div>

        <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Sparkles className="text-indigo-600 w-5 h-5" />
          {t.pickTopic}
        </h2>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-8">
          {getHistoricalEventsByGroup('popular').map((event) => (
            <button
              key={event.id}
              onClick={() => handleTopicSelect(event.id)}
              className="p-2.5 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left flex items-center gap-2"
            >
              <span className="text-xl">{event.emoji}</span>
              <span className="text-sm font-medium text-gray-700">
                {event.name[lang] || event.name.en}
              </span>
            </button>
          ))}
        </div>

        <button
          onClick={onBack}
          className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto"
        >
          <ArrowLeft className="w-4 h-4" />
          {t.back}
        </button>
      </div>
    );
  }

  // ─── Render: Selection complete — show summary + Next ──────────────────────

  const categoryData = trialCategories.find((c) => c.id === storyInput.storyCategory);
  const selectedTheme =
    storyInput.storyCategory === 'adventure'
      ? storyTypes.find((t) => t.id === storyInput.storyTheme)
      : null;
  const selectedTopic =
    storyInput.storyCategory === 'life-challenge'
      ? lifeChallenges.find((c) => c.id === storyInput.storyTopic)
      : storyInput.storyCategory === 'historical'
        ? historicalEvents.find((e) => e.id === storyInput.storyTopic)
        : null;

  return (
    <div className="max-w-lg mx-auto pt-4">
      <h2 className="text-2xl font-bold text-gray-900 text-center mb-6">{t.title}</h2>

      {/* Summary cards */}
      <div className="space-y-3 mb-8">
        {/* Category */}
        <div className="flex items-center gap-3 bg-white px-4 py-3 rounded-xl border border-indigo-200 shadow-sm">
          <span className="text-2xl">{categoryData?.emoji}</span>
          <span className="font-semibold text-gray-800 flex-1">
            {categoryData?.name[lang] || categoryData?.name.en}
          </span>
          <button
            onClick={handleResetCategory}
            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
          >
            {t.change}
          </button>
        </div>

        {/* Theme or Topic */}
        {selectedTheme && (
          <div className="flex items-center gap-3 bg-white px-4 py-3 rounded-xl border border-indigo-200 shadow-sm">
            <span className="text-2xl">{selectedTheme.emoji}</span>
            <span className="font-semibold text-gray-800 flex-1">
              {selectedTheme.name[lang] || selectedTheme.name.en}
            </span>
            <button
              onClick={() => onChange({ ...storyInput, storyTheme: '' })}
              className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
            >
              {t.change}
            </button>
          </div>
        )}

        {selectedTopic && (
          <div className="flex items-center gap-3 bg-white px-4 py-3 rounded-xl border border-indigo-200 shadow-sm">
            <span className="text-2xl">{selectedTopic.emoji}</span>
            <span className="font-semibold text-gray-800 flex-1">
              {selectedTopic.name[lang] || selectedTopic.name.en}
            </span>
            <button
              onClick={() => onChange({ ...storyInput, storyTopic: '' })}
              className="text-xs text-indigo-500 hover:text-indigo-700 font-medium"
            >
              {t.change}
            </button>
          </div>
        )}
      </div>

      {/* Next button */}
      <button
        onClick={handleNext}
        disabled={!isComplete}
        className={`w-full py-3 rounded-xl text-base font-semibold flex items-center justify-center gap-2 transition-all ${
          isComplete
            ? 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
            : 'bg-gray-200 text-gray-400 cursor-not-allowed'
        }`}
      >
        {t.next}
        <ArrowRight className="w-4 h-4" />
      </button>

      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-500 hover:text-gray-700 transition-colors mx-auto mt-4"
      >
        <ArrowLeft className="w-4 h-4" />
        {t.back}
      </button>
    </div>
  );
}
