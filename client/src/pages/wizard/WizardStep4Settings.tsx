import { StorySettings, type CharacterRole, type StoryLanguage } from '@/components/story';
import type { Character } from '@/types/character';
import type { LanguageLevel } from '@/types/story';

interface WizardStep4Props {
  characters: Character[];
  mainCharacters: number[];
  excludedCharacters: number[];
  onCharacterRoleChange: (charId: number, role: CharacterRole) => void;
  storyLanguage: StoryLanguage;
  onStoryLanguageChange: (lang: StoryLanguage) => void;
  languageLevel: LanguageLevel;
  onLanguageLevelChange: (level: LanguageLevel) => void;
  pages: number;
  onPagesChange: (pages: number) => void;
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
  // Story type settings (from step 1)
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic: string;
  storyTheme: string;
  artStyle: string;
  onCategoryChange: (cat: 'adventure' | 'life-challenge' | 'educational' | '') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onArtStyleChange: (style: string) => void;
  onLegacyStoryTypeChange: (type: string) => void;
}

/**
 * Step 4: Story Settings
 * Handles main character selection, language level, page count, and dedication
 */
export function WizardStep4Settings(props: WizardStep4Props) {
  return (
    <StorySettings
      characters={props.characters}
      mainCharacters={props.mainCharacters}
      excludedCharacters={props.excludedCharacters}
      onCharacterRoleChange={props.onCharacterRoleChange}
      storyLanguage={props.storyLanguage}
      onStoryLanguageChange={props.onStoryLanguageChange}
      languageLevel={props.languageLevel}
      onLanguageLevelChange={props.onLanguageLevelChange}
      pages={props.pages}
      onPagesChange={props.onPagesChange}
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
      artStyle={props.artStyle}
      onCategoryChange={props.onCategoryChange}
      onTopicChange={props.onTopicChange}
      onThemeChange={props.onThemeChange}
      onArtStyleChange={props.onArtStyleChange}
      onLegacyStoryTypeChange={props.onLegacyStoryTypeChange}
    />
  );
}
