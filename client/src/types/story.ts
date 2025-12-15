import type { Character, RelationshipMap, RelationshipTextMap, LocalizedString } from './character';

export type Language = 'en' | 'de' | 'fr';
export type LanguageLevel = '1st-grade' | 'standard' | 'advanced';

export interface StoryType {
  id: string;
  name: LocalizedString;
  emoji: string;
}

export interface ArtStyle {
  id: string;
  name: LocalizedString;
  emoji: string;
  image: string;
  description: LocalizedString;
  prompt: string;
}

export interface SceneDescription {
  pageNumber: number;
  description: string;
}

export interface RetryAttempt {
  attempt: number;
  type: 'generation' | 'text_edit' | 'text_edit_failed';
  imageData?: string;
  score?: number;
  reasoning?: string;
  textIssue?: string | null;
  expectedText?: string | null;
  actualText?: string | null;
  error?: string;
  timestamp: string;
}

export interface SceneImage {
  pageNumber: number;
  imageData: string;
  score?: number;
  description?: string;
  prompt?: string;  // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  originalImage?: string;
  originalScore?: number;
  originalReasoning?: string;
}

export interface CoverImageData {
  imageData?: string;
  description?: string;  // Scene description for the cover
  prompt?: string;       // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  originalImage?: string;
  originalScore?: number;
}

export interface CoverImages {
  frontCover: string | CoverImageData | null;
  initialPage: string | CoverImageData | null;
  backCover: string | CoverImageData | null;
}

export interface SavedStory {
  id: string;
  title: string;
  storyType: string;
  artStyle: string;
  language: Language;
  languageLevel: LanguageLevel;
  pages: number;
  dedication?: string;
  characters: Character[];
  mainCharacters: number[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  outline?: string;
  outlinePrompt?: string;
  story?: string;
  storyTextPrompts?: Array<{ batch: number; startPage: number; endPage: number; prompt: string }>;
  visualBible?: {
    secondaryCharacters: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
    animals: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
    artifacts: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
    locations: Array<{ id: string; name: string; appearsInPages: number[]; description: string; extractedDescription: string | null; firstAppearanceAnalyzed: boolean }>;
  };
  sceneDescriptions?: SceneDescription[];
  sceneImages?: SceneImage[];
  coverImages?: CoverImages;
  thumbnail?: string;
  createdAt: string;
  updatedAt?: string;
  // Partial story fields (for stories that failed during generation)
  isPartial?: boolean;
  failureReason?: string;
  generatedPages?: number;
  totalPages?: number;
}

export interface StoryGenerationProgress {
  current: number;
  total: number;
  message: string;
  stage: 'outline' | 'story' | 'scenes' | 'images' | 'covers' | 'complete';
}
