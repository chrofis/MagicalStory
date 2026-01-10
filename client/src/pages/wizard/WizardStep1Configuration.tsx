import { StoryCategorySelector, ArtStyleSelector } from '@/components/story';

interface WizardStep1Props {
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | 'historical' | '';
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  artStyle: string;
  onCategoryChange: (cat: 'adventure' | 'life-challenge' | 'educational' | 'historical' | '') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange: (text: string) => void;
  onArtStyleChange: (style: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
  developerMode?: boolean;
}

/**
 * Step 1: Story Configuration
 * Handles story category, topic/theme selection, and art style
 */
export function WizardStep1Configuration({
  storyCategory,
  storyTopic,
  storyTheme,
  customThemeText,
  artStyle,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onArtStyleChange,
  onLegacyStoryTypeChange,
  developerMode = false,
}: WizardStep1Props) {
  // Determine if story selection is complete (ready to show art style)
  const isStorySelectionComplete =
    (storyCategory === 'adventure' && storyTheme) ||
    ((storyCategory === 'life-challenge' || storyCategory === 'educational' || storyCategory === 'historical') && storyTopic);

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
      {isStorySelectionComplete && (
        <div id="art-style-section">
          <ArtStyleSelector
            selectedStyle={artStyle}
            onSelect={onArtStyleChange}
          />
        </div>
      )}
    </div>
  );
}
