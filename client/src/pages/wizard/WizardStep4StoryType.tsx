import { StoryCategorySelector } from '@/components/story/StoryCategorySelector';

interface WizardStep4Props {
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  onCategoryChange: (cat: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange: (text: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
  developerMode?: boolean;
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
  developerMode = false,
}: WizardStep4Props) {
  return (
    <div className="space-y-6">
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
        developerMode={developerMode}
      />
    </div>
  );
}
