import type { Character, RelationshipMap, RelationshipTextMap, LocalizedString, VisualBible } from './character';

// UI Language - matches LocalizedString keys (used for UI translations)
export type UILanguage = 'en' | 'de' | 'fr';
// Legacy alias for backwards compatibility
export type Language = UILanguage;

// Story Language - used for AI story generation (supports regional variants)
export type StoryLanguageCode = 'en' | 'de' | 'de-ch' | 'de-de' | 'fr';
export type LanguageLevel = '1st-grade' | 'standard' | 'advanced';

export type AdventureThemeGroupId = 'historical' | 'fantasy' | 'locations' | 'professions' | 'seasonal' | 'custom';

export interface StoryType {
  id: string;
  name: LocalizedString;
  emoji: string;
  group?: AdventureThemeGroupId;
}

export interface AdventureThemeGroup {
  id: AdventureThemeGroupId;
  name: LocalizedString;
}

// Story category (Adventure, Life Challenge, Educational)
export interface StoryCategory {
  id: 'adventure' | 'life-challenge' | 'educational';
  name: LocalizedString;
  description: LocalizedString;
  emoji: string;
}

// Life challenge topic
export interface LifeChallenge {
  id: string;
  name: LocalizedString;
  emoji: string;
  ageGroup: 'toddler' | 'preschool' | 'early-school' | 'family' | 'preteen';
}

export interface LifeChallengeGroup {
  id: string;
  name: LocalizedString;
  ageRange: string;
}

// Educational topic
export interface EducationalTopic {
  id: string;
  name: LocalizedString;
  emoji: string;
  group: 'letters' | 'numbers' | 'colors' | 'science' | 'animals' | 'body' | 'time' | 'geography' | 'arts';
}

export interface EducationalGroup {
  id: string;
  name: LocalizedString;
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
  outlineExtract?: string;  // Short scene description from outline
  scenePrompt?: string;     // Art Director prompt used to generate description
  textModelId?: string;     // Text model used to generate the scene description
}

export interface EvaluationData {
  score: number;
  reasoning: string;
  fixTargets?: Array<{
    boundingBox: number[];
    issue: string;
    fixPrompt: string;
  }>;
}

export interface RetryAttempt {
  attempt: number;
  type: 'generation' | 'text_edit' | 'text_edit_failed' | 'auto_repair' | 'auto_repair_failed';
  imageData?: string;
  score?: number;
  reasoning?: string;
  textIssue?: string | null;
  expectedText?: string | null;
  actualText?: string | null;
  error?: string;
  timestamp: string;
  // Auto-repair specific fields
  preRepairScore?: number;
  postRepairScore?: number;
  fixTargetsCount?: number;
  preRepairEval?: EvaluationData;
  postRepairEval?: EvaluationData;
  repairDetails?: RepairAttempt[];
}

export interface RepairAttempt {
  attempt: number;
  errorType: string;
  description: string;
  boundingBox: number[];
  fixPrompt: string;
  maskImage?: string;
  beforeImage?: string;
  afterImage?: string | null;
  success: boolean;
  timestamp: string;
}

export interface ReferencePhoto {
  name: string;
  id: number;
  photoType: 'face' | 'body' | 'bodyNoBg' | 'body-no-bg' | 'clothing-winter' | 'clothing-summer' | 'clothing-formal' | 'clothing-standard' | 'none';
  photoUrl: string | null;
  photoHash?: string | null;  // SHA256 hash (first 8 chars) for verification
  hasPhoto: boolean;
  clothingCategory?: 'winter' | 'summer' | 'formal' | 'standard' | null;
  isStyled?: boolean;  // True if this is a pre-converted styled avatar
  originalPhotoUrl?: string | null;  // Original photo URL before styling
}

// Individual image version (for user-initiated regenerations)
export interface ImageVersion {
  imageData: string;
  description?: string;  // Scene description (what user sees/edits)
  prompt?: string;       // Full API prompt (for dev mode)
  modelId?: string;
  createdAt: string;
  isActive: boolean;
}

export interface SceneImage {
  pageNumber: number;
  imageData: string;
  score?: number;
  description?: string;
  prompt?: string;  // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  qualityModelId?: string;  // Model used for quality evaluation
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  originalImage?: string;
  originalScore?: number;
  originalReasoning?: string;
  // Reference photos used (for dev mode)
  referencePhotos?: ReferencePhoto[];
  // API model used (for dev mode)
  modelId?: string;
  // User-initiated image versions (first is original, subsequent are regenerations)
  imageVersions?: ImageVersion[];
  // Auto-repair history (dev mode)
  wasAutoRepaired?: boolean;
  repairHistory?: RepairAttempt[];
  repairedAt?: string;
  // Face evaluation data (dev mode)
  faceEvaluation?: unknown;
}

export interface CoverImageData {
  imageData?: string;
  description?: string;  // Scene description for the cover
  prompt?: string;       // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  qualityModelId?: string;  // Model used for quality evaluation
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  originalImage?: string;
  originalScore?: number;
  // Reference photos used (for dev mode)
  referencePhotos?: ReferencePhoto[];
  // API model used (for dev mode)
  modelId?: string;
  // Story title (sent with frontCover during streaming for early display transition)
  storyTitle?: string;
}

export interface CoverImages {
  frontCover: string | CoverImageData | null;
  initialPage: string | CoverImageData | null;
  backCover: string | CoverImageData | null;
}

// Token usage info for dev mode display
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface SavedStory {
  id: string;
  title: string;
  storyType: string;  // Legacy: adventure theme (pirate, knight, etc.)
  // New story structure
  storyCategory?: 'adventure' | 'life-challenge' | 'educational';  // What kind of story
  storyTopic?: string;  // Life challenge or educational topic ID
  storyTheme?: string;  // Adventure theme wrapper (or 'realistic' for no wrapper)
  artStyle: string;
  language: StoryLanguageCode;
  languageLevel: LanguageLevel;
  pages: number;
  dedication?: string;
  characters: Character[];
  mainCharacters: number[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  outline?: string;
  outlinePrompt?: string;
  outlineModelId?: string;  // Model used for outline generation
  outlineUsage?: TokenUsage;  // Token usage for outline
  story?: string;
  originalStory?: string;  // Original AI-generated story text (preserved on first edit)
  storyTextPrompts?: Array<{
    batch: number;
    startPage: number;
    endPage: number;
    prompt: string;
    modelId?: string;  // Model used for this batch
    usage?: TokenUsage;  // Token usage for this batch
  }>;
  visualBible?: Partial<VisualBible>;
  styledAvatarGeneration?: Array<{
    timestamp: string;
    characterName: string;
    artStyle: string;
    durationMs: number;
    success: boolean;
    error?: string;
    inputs: {
      facePhoto: { identifier: string; sizeKB: number } | null;
      originalAvatar: { identifier: string; sizeKB: number };
    };
    prompt?: string;
    output?: { identifier: string; sizeKB: number };
  }>;
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
