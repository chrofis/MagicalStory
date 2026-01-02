import { StorySettings, type StoryLanguage } from '@/components/story';
import type { Character } from '@/types/character';

interface WizardStep4Props {
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  storyLanguage: StoryLanguage;
  onStoryLanguageChange: (lang: StoryLanguage) => void;
  // Book settings for summary
  languageLevel: string;
  pages: number;
  dedication: string;
  onDedicationChange: (dedication: string) => void;
  storyDetails: string;
  onStoryDetailsChange: (details: string) => void;
  developerMode: boolean;
  imageGenMode: 'parallel' | 'sequential' | null;
  onImageGenModeChange: (mode: 'parallel' | 'sequential' | null) => void;
  onGenerateIdeas: () => Promise<void>;
  isGeneratingIdeas: boolean;
  ideaPrompt: { prompt: string; model: string } | null;
  // Story type settings (step 4)
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic: string;
  storyTheme: string;
  customThemeText: string;
  artStyle: string;
  onCategoryChange: (cat: 'adventure' | 'life-challenge' | 'educational' | '') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange: (text: string) => void;
  onArtStyleChange: (style: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
}

/**
 * Step 4: Story Type & Settings
 * Handles story type selection, main character selection, and story details
 */
export function WizardStep4Settings(props: WizardStep4Props) {
  return (
    <StorySettings
      characters={props.characters}
      mainCharacters={props.mainCharacters}
      excludedCharacters={props.excludedCharacters}
      storyLanguage={props.storyLanguage}
      onStoryLanguageChange={props.onStoryLanguageChange}
      dedication={props.dedication}
      onDedicationChange={props.onDedicationChange}
      storyDetails={props.storyDetails}
      onStoryDetailsChange={props.onStoryDetailsChange}
      developerMode={props.developerMode}
      imageGenMode={props.imageGenMode}
      onImageGenModeChange={props.onImageGenModeChange}
      onGenerateIdeas={props.onGenerateIdeas}
      isGeneratingIdeas={props.isGeneratingIdeas}
      ideaPrompt={props.ideaPrompt}
      storyCategory={props.storyCategory}
      storyTopic={props.storyTopic}
      storyTheme={props.storyTheme}
      customThemeText={props.customThemeText}
      artStyle={props.artStyle}
      onCategoryChange={props.onCategoryChange}
      onTopicChange={props.onTopicChange}
      onThemeChange={props.onThemeChange}
      onCustomThemeTextChange={props.onCustomThemeTextChange}
      onArtStyleChange={props.onArtStyleChange}
      onLegacyStoryTypeChange={props.onLegacyStoryTypeChange}
      languageLevel={props.languageLevel}
      pages={props.pages}
    />
  );
}
