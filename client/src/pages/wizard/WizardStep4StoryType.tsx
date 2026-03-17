import { StoryCategorySelector } from '@/components/story/StoryCategorySelector';

type StoryCategoryId = 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom' | '';

interface WizardStep4Props {
  storyCategory: StoryCategoryId;
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  userLocation?: { city: string | null; region: string | null; country: string | null } | null;
  onCategoryChange: (cat: StoryCategoryId) => void;
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
  userLocation,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onLegacyStoryTypeChange,
}: WizardStep4Props) {
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
