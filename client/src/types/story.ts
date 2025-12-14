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

export interface SceneImage {
  pageNumber: number;
  imageData: string;
  score?: number;
}

export interface CoverImages {
  frontCover: string | null;
  initialPage: string | null;
  backCover: string | null;
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
  story?: string;
  sceneDescriptions?: SceneDescription[];
  sceneImages?: SceneImage[];
  coverImages?: CoverImages;
  thumbnail?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface StoryGenerationProgress {
  current: number;
  total: number;
  message: string;
  stage: 'outline' | 'story' | 'scenes' | 'images' | 'covers' | 'complete';
}
