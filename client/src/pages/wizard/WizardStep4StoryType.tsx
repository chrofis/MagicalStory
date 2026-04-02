import { useState } from 'react';
import { useLanguage } from '@/context/LanguageContext';
import { StoryCategorySelector } from '@/components/story/StoryCategorySelector';
import { lifeChallenges, storyTypes as adventureTypes, educationalTopics, historicalEvents } from '@/constants/storyTypes';
import { Check, RefreshCw } from 'lucide-react';

type StoryCategoryId = 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom' | '';

interface WizardStep4Props {
  storyCategory: StoryCategoryId;
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  userLocation?: { city: string | null; region: string | null; country: string | null } | null;
  preselectedFromUrl?: boolean;
  onCategoryChange: (cat: StoryCategoryId) => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange: (text: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
}

const categoryLabels: Record<string, Record<string, string>> = {
  'adventure': { en: 'Adventure', de: 'Abenteuer', fr: 'Aventure' },
  'life-challenge': { en: 'Life Challenge', de: 'Lebensthema', fr: 'Défi de vie' },
  'educational': { en: 'Educational', de: 'Lerngeschichte', fr: 'Éducatif' },
  'historical': { en: 'History', de: 'Geschichte', fr: 'Histoire' },
  'swiss-stories': { en: 'Swiss Stories', de: 'Schweizer Geschichten', fr: 'Histoires Suisses' },
};

/**
 * Step 4: Story Type Selection
 * Shows compact pre-selection if topic came from theme page URL, otherwise full selector
 */
export function WizardStep4StoryType({
  storyCategory,
  storyTopic,
  storyTheme,
  customThemeText,
  userLocation,
  preselectedFromUrl = false,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onLegacyStoryTypeChange,
}: WizardStep4Props) {
  const { language } = useLanguage();
  const [showFullSelector, setShowFullSelector] = useState(!preselectedFromUrl);

  // Look up topic name for compact display
  const getTopicDisplay = () => {
    if (!storyCategory || !storyTopic) return null;
    const allThemes = [...lifeChallenges, ...adventureTypes, ...educationalTopics, ...historicalEvents];
    const found = allThemes.find(t => t.id === storyTopic);
    if (!found) return null;
    const topicName = (found.name as unknown as Record<string, string>)[language] || found.name.en;
    const catLabel = categoryLabels[storyCategory]?.[language] || categoryLabels[storyCategory]?.en || storyCategory;
    return { name: topicName, emoji: found.emoji, category: catLabel };
  };

  const topicDisplay = getTopicDisplay();

  // Show compact pre-selection card
  if (!showFullSelector && topicDisplay) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl md:text-3xl font-bold text-gray-800">
          {language === 'de' ? 'Dein Thema' : language === 'fr' ? 'Votre thème' : 'Your Topic'}
        </h2>
        <div className="bg-white border-2 border-indigo-200 rounded-2xl p-6 flex items-center gap-4">
          <span className="text-4xl">{topicDisplay.emoji}</span>
          <div className="flex-1">
            <div className="text-xs font-medium text-indigo-500 uppercase tracking-wide">{topicDisplay.category}</div>
            <div className="text-xl font-bold text-gray-800">{topicDisplay.name}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="bg-green-100 text-green-700 text-xs font-bold px-2.5 py-1 rounded-full flex items-center gap-1">
              <Check size={12} /> {language === 'de' ? 'Gewählt' : language === 'fr' ? 'Choisi' : 'Selected'}
            </span>
            <button
              onClick={() => setShowFullSelector(true)}
              className="text-xs text-indigo-500 hover:text-indigo-800 font-medium flex items-center gap-1 px-2 py-1 rounded hover:bg-indigo-50"
            >
              <RefreshCw size={12} />
              {language === 'de' ? 'Ändern' : language === 'fr' ? 'Changer' : 'Change'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Full selector (default, or after clicking "Change")
  return (
    <div className="space-y-6">
      <StoryCategorySelector
        storyCategory={storyCategory}
        storyTopic={storyTopic}
        storyTheme={storyTheme}
        customThemeText={customThemeText}
        userLocation={userLocation}
        onCategoryChange={onCategoryChange}
        onTopicChange={onTopicChange}
        onThemeChange={onThemeChange}
        onCustomThemeTextChange={onCustomThemeTextChange}
        onLegacyStoryTypeChange={onLegacyStoryTypeChange}
      />
    </div>
  );
}
