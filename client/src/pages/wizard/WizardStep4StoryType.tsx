import { Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { StoryCategorySelector } from '@/components/story/StoryCategorySelector';

interface WizardStep4Props {
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  onCategoryChange: (cat: 'adventure' | 'life-challenge' | 'educational' | '') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange: (text: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
}

/**
 * Step 4: Story Type Selection
 * Only handles story category and topic/theme selection
 */
export function WizardStep4StoryType({
  storyCategory,
  storyTopic,
  storyTheme,
  customThemeText,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onLegacyStoryTypeChange,
}: WizardStep4Props) {
  const { language } = useLanguage();

  const title = language === 'de'
    ? 'Welche Art von Geschichte?'
    : language === 'fr'
    ? 'Quel type d\'histoire?'
    : 'What kind of story?';

  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Sparkles size={24} /> {title}
      </h2>
      <StoryCategorySelector
        storyCategory={storyCategory}
        storyTopic={storyTopic}
        storyTheme={storyTheme}
        customThemeText={customThemeText}
        onCategoryChange={onCategoryChange}
        onTopicChange={onTopicChange}
        onThemeChange={onThemeChange}
        onCustomThemeTextChange={onCustomThemeTextChange}
        onLegacyStoryTypeChange={onLegacyStoryTypeChange}
      />
    </div>
  );
}
