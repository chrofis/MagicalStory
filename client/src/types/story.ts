import type { Character, RelationshipMap, RelationshipTextMap, LocalizedString, VisualBible } from './character';

// UI Language - matches LocalizedString keys (used for UI translations)
export type UILanguage = 'en' | 'de' | 'fr';
// Legacy alias for backwards compatibility
export type Language = UILanguage;

// Story Language - used for AI story generation (supports regional variants)
export type StoryLanguageCode =
  | 'en' | 'en-gb' | 'en-us' | 'en-ca' | 'en-au' | 'en-ie' | 'en-za'  // English variants
  | 'fr' | 'fr-fr' | 'fr-ch' | 'fr-be' | 'fr-ca' | 'fr-af'  // French regions
  | 'de-ch' | 'de-de' | 'de-at' | 'de-it'           // German regions
  | 'de-de-north' | 'de-de-south'                   // German sub-variants
  | 'de'                                            // German legacy fallback
  | 'it' | 'it-it' | 'it-ch' | 'it-it-north' | 'it-it-central' | 'it-it-south' | 'it-sm'  // Italian variants
  | 'gsw-zh' | 'gsw-be' | 'gsw-bs' | 'gsw-lu' | 'gsw-sg' | 'gsw-vs' | 'gsw-gr';  // Swiss German dialects
export type LanguageLevel = '1st-grade' | 'standard' | 'advanced';

export type AdventureThemeGroupId = 'popular' | 'historical' | 'fantasy' | 'locations' | 'professions' | 'seasonal' | 'custom';

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

// Story category (Adventure, Life Challenge, Educational, Historical, Custom)
export interface StoryCategory {
  id: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom';
  name: LocalizedString;
  description: LocalizedString;
  emoji: string;
}

// Historical event topic
export interface HistoricalEvent {
  id: string;
  name: LocalizedString;
  shortName: LocalizedString;
  emoji: string;
  year: number | string;
  category: 'swiss' | 'exploration' | 'science' | 'invention' | 'rights' | 'construction' | 'culture' | 'archaeology';
  mainPerson?: string;  // Main historical figure (e.g., "Neil Armstrong")
}

export interface HistoricalEventGroup {
  id: string;
  name: LocalizedString;
  icon: string;
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
  translatedSummary?: string;  // Pre-extracted translated summary (user's language)
  imageSummary?: string;       // Pre-extracted image summary (English)
  outlineExtract?: string;     // Short scene description from outline
  scenePrompt?: string;        // Art Director prompt used to generate description
  textModelId?: string;        // Text model used to generate the scene description
}

export interface EvaluationData {
  score: number;
  reasoning: string;
  fixTargets?: Array<{
    boundingBox: number[];
    issue: string;
    fixPrompt: string;
  }>;
  fixableIssues?: Array<{
    description: string;
    severity: string;
    type: string;
    fix: string;
  }>;
}

// Two-stage bounding box detection result
export interface BboxDetectionResult {
  issue: string;
  severity: string;
  type: string;
  success: boolean;
  faceBox?: number[] | null;  // [ymin, xmin, ymax, xmax] normalized 0-1
  bodyBox?: number[] | null;  // [ymin, xmin, ymax, xmax] normalized 0-1
  label?: string;
  usage?: { input_tokens: number; output_tokens: number };
  timestamp: string;
}

// Full scene bbox detection result (figures + objects)
export interface BboxSceneDetection {
  figures: Array<{
    name?: string;           // Character name (from AI identification) or "UNKNOWN"
    label: string;           // Visual description (e.g., 'boy in blue hoodie')
    bodyBox?: number[] | null;  // [ymin, xmin, ymax, xmax] normalized 0-1
    faceBox?: number[] | null;
    position?: string;       // "left", "center", "right"
    confidence?: string;     // "high", "medium", "low" for character identification
  }>;
  objects: Array<{
    name?: string;           // Expected object name (if matched)
    found?: boolean;         // Whether the expected object was found
    label?: string;          // Visual description
    bodyBox?: number[] | null;
    position?: string;
  }>;
  usage?: { input_tokens: number; output_tokens: number };
  timestamp?: string;
  // Expected characters passed to bbox detection
  expectedCharacters?: Array<{
    name: string;
    description: string;
    position: string;
  }>;
  // Expected positions from scene description (e.g., "Luna": "bottom-left foreground")
  expectedPositions?: Record<string, string>;
  // Position mismatches: character was expected at one position but detected at another
  positionMismatches?: Array<{
    character: string;
    expected: string;      // Full position string from scene description
    expectedLCR: string;   // Normalized to "left", "center", "right"
    actual: string;        // Detected position
  }>;
  // Characters expected in scene but not identified by AI
  missingCharacters?: string[];
  // Expected objects from scene description
  expectedObjects?: string[];
  // Objects that were expected and found in the image
  foundObjects?: string[];
  matchedObjects?: Array<{
    expected: string;      // Original expected object string
    matched: string;       // Detected object label that matched
  }>;
  // Objects expected in scene but not detected in image
  missingObjects?: string[];
  // Number of UNKNOWN figures detected
  unknownFigures?: number;
  // Character descriptions parsed from prompt (age, gender, isChild)
  characterDescriptions?: Record<string, {
    age?: number;
    gender?: string;
    isChild?: boolean;
    genderTerm?: string;
  }>;
  // Raw prompt and response for dev mode debugging
  rawPrompt?: string;
  rawResponse?: string;
}

// Grid repair manifest issue
export interface GridManifestIssue {
  letter: string;
  issueId?: string;
  source?: string;
  type?: string;
  severity?: string;
  description?: string;
  fixInstruction?: string;
}

// Per-repair verification result for UI display
export interface GridRepairVerification {
  letter: string;
  issueId: string;
  type?: string;
  severity?: string;
  description?: string;
  fixInstruction?: string;
  originalThumbnail?: string;    // base64 encoded 256x256 before
  repairedThumbnail?: string;    // base64 encoded 256x256 after
  diffImage?: string;            // base64 encoded diff image highlighting changes
  comparisonImage?: string;      // base64 encoded side-by-side comparison
  verification?: {
    fixed: boolean;
    changed: boolean;
    confidence: number;
    explanation: string;
    newProblems: string[];
    accepted: boolean;
    reason: string;
  };
}

// Grid repair data for UI display
export interface GridRepairData {
  batchNum?: number;
  original?: string;  // base64 encoded grid image
  repaired?: string;  // base64 encoded repaired grid image
  prompt?: string;    // repair prompt sent to Gemini
  manifest?: {
    createdAt?: string;
    title?: string;
    dimensions?: { width: number; height: number };
    cellSize?: number;
    cols?: number;
    rows?: number;
    issues?: GridManifestIssue[];
  };
  // Per-repair verification results
  repairs?: GridRepairVerification[];
}

export interface RetryAttempt {
  attempt: number;
  type: 'generation' | 'text_edit' | 'text_edit_failed' | 'auto_repair' | 'auto_repair_failed' | 'grid_repair' | 'grid_repair_failed' | 'bbox_detection_only';
  imageData?: string;
  score?: number;
  reasoning?: string;
  prompt?: string;  // Input prompt used for generation
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
  // Two-stage bounding box detection results (old format: per-issue, new format: full scene)
  bboxDetection?: BboxDetectionResult[] | BboxSceneDetection | null;
  bboxOverlayImage?: string;  // Image with bbox rectangles drawn for visualization
  repairDetails?: RepairAttempt[];
  // Grid repair specific fields
  grids?: GridRepairData[];
  gridFixedCount?: number;
  gridFailedCount?: number;
  gridTotalIssues?: number;
  failReason?: string;  // For grid_repair_failed: why the repair was not used
  // Annotated original image with bounding boxes (base64)
  annotatedOriginal?: string;
  // Lazy loading flags (when images are stripped from dev-metadata)
  hasImageData?: boolean;
  hasOriginalImage?: boolean;
  hasBboxOverlay?: boolean;
  hasAnnotatedOriginal?: boolean;
  hasGrids?: boolean;
  gridsCount?: number;
  // Bbox detection only fields
  fixableIssuesCount?: number;
  enrichedTargetsCount?: number;
  autoRepairEnabled?: boolean;
}

// Inpaint verification result (LPIPS + LLM)
export interface InpaintVerification {
  lpips?: {
    lpipsScore: number;       // 0 = identical, 1 = very different
    interpretation: string;   // 'nearly_identical' | 'very_similar' | 'somewhat_similar' | 'different'
    region?: string;          // 'full' or 'cropped'
    changed: boolean;         // True if meaningful change detected
  } | null;
  llm?: {
    fixed: boolean;           // Whether the issue was fixed
    confidence: number;       // 0.0-1.0
    explanation: string;      // Brief explanation
  } | null;
  success: boolean;           // Overall verification success
  combinedBbox?: number[];    // Combined bounding box used for verification
  error?: string;             // Error message if verification failed
}

export interface RepairAttempt {
  attempt: number;
  errorType: string;
  description: string;
  boundingBox: number[];
  fixPrompt: string;
  fullPrompt?: string;  // Full inpainting prompt with coordinates (for display)
  modelId?: string;     // Model used for inpainting
  maskImage?: string;
  beforeImage?: string;
  afterImage?: string | null;
  diffImage?: string;   // Pixel diff image highlighting changes
  success: boolean;
  timestamp: string;
  verification?: InpaintVerification;  // Targeted verification results (LPIPS + LLM)
}

// Final consistency checks report
export interface FinalChecksImageIssue {
  images: number[];  // All pages involved in the issue (for context)
  pagesToFix?: number[];  // Specific pages to regenerate (subset of images)
  type: 'character_appearance' | 'position_swap' | 'clothing_mismatch' | 'prop_inconsistency' | 'style_drift';
  characterInvolved?: string;  // Which character has the issue
  description: string;
  details?: Record<string, string>;  // Per-image details (e.g., { "image2": "red hair", "image4": "blonde hair" })
  canonicalVersion?: string;  // What the correct/target appearance should be
  recommendation?: string;  // Specific fix suggestion (single action, not "either/or")
  severity: 'low' | 'medium' | 'high';
}

export interface FinalChecksTextIssue {
  page?: number;
  type: 'spelling' | 'grammar' | 'formatting' | 'flow' | 'character' | 'logic';
  text?: string;  // Legacy field
  originalText?: string;  // The problematic text
  correctedText?: string;  // The corrected version
  issue: string;
  suggestion?: string;  // Legacy field
  severity: 'low' | 'medium' | 'high';
}

export interface FinalChecksImageCheck {
  type: 'full' | 'character' | 'sequence';
  characterName?: string;
  consistent: boolean;
  overallScore?: number;
  issues: FinalChecksImageIssue[];
  summary?: string;
  evaluationPrompt?: string;  // Prompt used for evaluation (for dev mode)
  evaluationPrompts?: string[];  // All prompts if batched (for dev mode)
  rawResponses?: string[];  // Raw API responses for debugging/fine-tuning
}

export interface FinalChecksTextCheck {
  quality: 'good' | 'needs_review' | 'has_issues';
  overallScore?: number;
  issues: FinalChecksTextIssue[];
  summary?: string;
  fullOriginalText?: string;   // Original story text before corrections
  fullCorrectedText?: string;  // Complete story text with all corrections applied
  evaluationPrompt?: string;   // The prompt used for evaluation (for debugging)
  rawResponse?: string;        // Raw API response for debugging
  parseError?: boolean;        // True if response couldn't be parsed as JSON
}

// Entity consistency check issue (from entity grid evaluation)
export interface EntityConsistencyIssue {
  id: string;
  source: 'entity';
  pageNumber: number | null;
  region: null;
  type: 'consistency';
  subType: 'face_mismatch' | 'hair_change' | 'skin_tone' | 'age_shift' | 'clothing_inconsistent' | 'color_change' | 'shape_change';
  severity: 'minor' | 'major' | 'critical';
  description: string;
  fixInstruction: string;
  affectedCharacter: string;
  cells?: string[];
  pagesToFix?: number[];
  canonicalVersion?: string;
}

// Entity check result per clothing category
export interface EntityClothingResult {
  gridImage?: string;  // Base64 data URI of the grid
  consistent: boolean;
  score: number;
  issues: EntityConsistencyIssue[];
  summary?: string;
  cellCount?: number;
  error?: string;
}

// Entity check result (per character or object)
// Supports both legacy (flat) and new (byClothing) structures
export interface EntityCheckResult {
  // New per-clothing structure
  byClothing?: Record<string, EntityClothingResult>;
  overallConsistent?: boolean;
  overallScore?: number;
  totalIssues?: number;

  // Legacy flat structure (still supported for backward compat)
  gridImage?: string;  // Base64 data URI of the grid
  consistent?: boolean;
  score?: number;
  issues?: EntityConsistencyIssue[];
  summary?: string;
  error?: string;
}

// Entity grid entry (for dev panel display)
export interface EntityGridEntry {
  entityName: string;
  entityType: 'character' | 'object';
  gridImage: string;  // Base64 data URI
  manifest: {
    createdAt: string;
    title: string;
    dimensions: { width: number; height: number };
    cellSize: number;
    cols: number;
    rows: number;
    cellCount: number;
    cells: Array<{
      letter: string;
      pageNumber?: number;
      isReference?: boolean;
      clothing?: string;
      cropType?: string;
    }>;
  };
  cellCount: number;
}

// Entity consistency report
export interface EntityConsistencyReport {
  timestamp: string;
  characters: Record<string, EntityCheckResult>;
  objects: Record<string, EntityCheckResult>;
  grids: EntityGridEntry[];
  totalIssues: number;
  overallConsistent: boolean;
  summary: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    model: string;
  };
  error?: string;
}

// Legacy consistency report (full-image checks)
export interface LegacyConsistencyReport {
  imageChecks: FinalChecksImageCheck[];
  summary: string;
}

export interface FinalChecksReport {
  timestamp: string;
  imageChecks: FinalChecksImageCheck[];
  textCheck?: FinalChecksTextCheck | null;
  overallConsistent: boolean;
  totalIssues: number;
  summary: string;
  error?: string;
  // New entity consistency report
  entity?: EntityConsistencyReport;
  // Legacy full-image consistency report
  legacy?: LegacyConsistencyReport;
  // Entity repair results (from "Repair Consistency" button)
  entityRepairs?: Record<string, {
    timestamp?: string;
    originalScore?: number;
    cellsRepaired?: number;
    gridBeforeRepair?: string;
    gridAfterRepair?: string;
    gridDiff?: string | null;
    cellComparisons?: Array<{
      letter: string;
      pageNumber: number;
      clothingCategory?: string;
      before: string;
      after: string;
      diff: string;
    }>;
    // NEW: Per-clothing-group results
    gridsByClothing?: Array<{
      clothingCategory: string;
      cropCount: number;
      gridBefore: string;
      gridAfter: string;
      gridDiff?: string | null;
      referenceUsed: 'styled' | 'original';
      cellComparisons: Array<{
        letter: string;
        pageNumber: number;
        clothingCategory: string;
        before: string;
        after: string;
        diff: string;
      }>;
    }>;
    clothingGroupCount?: number;
    usage?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    // Single-page repair results (from individual page repair buttons)
    pages?: Record<string, {
      timestamp: string;
      clothingCategory?: string;
      comparison?: {
        before?: string;
        after?: string;
        diff?: string;
      };
      referenceGridUsed?: string;
      usage?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
      promptUsed?: string;
    }>;
  }>;
  // Token usage for all consistency checks
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    calls: number;
    model: string | null;
  };
}

// Generation log entry for debugging story generation
export type GenerationLogStage = 'outline' | 'avatars' | 'scenes' | 'images' | 'covers' | 'finalize';
export type GenerationLogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface GenerationLogEntry {
  timestamp: string;
  stage: GenerationLogStage;
  level: GenerationLogLevel;
  event: string;           // Short event name (e.g., 'avatar_lookup', 'fallback', 'costume_generated')
  message: string;         // Human-readable description
  character?: string;      // Character name if relevant
  details?: Record<string, unknown>;  // Additional structured data
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
  userInput?: string;    // User's input before expansion (for dev mode)
  description?: string;  // Expanded scene description (AI's output)
  prompt?: string;       // Full API prompt (for dev mode)
  modelId?: string;
  createdAt: string;
  isActive: boolean;
  type?: 'original' | 'regeneration' | 'iteration' | 'edit' | 'repair' | 'entity-repair';
  qualityScore?: number;
  // Entity repair specific
  entityRepairedFor?: string;
  clothingCategory?: string;
}

// Landmark reference photo for real-world locations
export interface LandmarkPhoto {
  name: string;
  photoData: string;
  attribution?: string;
  source?: string;
}

export interface SceneImage {
  pageNumber: number;
  imageData?: string;  // Optional for lazy loading - undefined means not loaded yet
  hasImage?: boolean;  // True if image exists (for lazy loading placeholder)
  score?: number;
  description?: string;
  prompt?: string;  // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  qualityModelId?: string;  // Model used for quality evaluation
  fixTargets?: Array<{  // Bounding boxes for auto-repair from quality evaluation
    boundingBox: number[];
    issue: string;
    fixPrompt: string;
  }>;
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  originalImage?: string;
  originalScore?: number;
  originalReasoning?: string;
  // Reference photos used (for dev mode)
  referencePhotos?: ReferencePhoto[];
  // Landmark photos used (for dev mode)
  landmarkPhotos?: LandmarkPhoto[];
  // Visual Bible grid image (combines VB elements + secondary landmarks)
  visualBibleGrid?: string;  // Base64 data URL
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
  // Consistency regeneration data (dev mode)
  consistencyRegen?: {
    originalImage: string;
    originalPrompt: string;
    originalDescription: string;
    fixedImage: string;
    fixedPrompt: string;
    fixedDescription: string;
    correctionNotes: string;
    issues: Array<{
      type: string;
      characterInvolved?: string;
      description: string;
      recommendation: string;
      severity: string;
    }>;
    score: number;
    timestamp: string;
  };
}

export interface CoverImageData {
  imageData?: string;
  hasImage?: boolean;  // True if image exists (for lazy loading placeholder)
  description?: string;  // Scene description for the cover (English, for image generation)
  translatedDescription?: string;  // Scene description in story's language (for display in edit modal)
  prompt?: string;       // The actual prompt sent to image generation API
  qualityScore?: number;
  qualityReasoning?: string;
  qualityModelId?: string;  // Model used for quality evaluation
  // Regeneration info (for dev mode)
  wasRegenerated?: boolean;
  totalAttempts?: number;
  retryHistory?: RetryAttempt[];
  regenerationCount?: number;
  // Previous version (immediate predecessor) - legacy, kept for backwards compatibility
  previousImage?: string;
  previousScore?: number;
  // Original version (from initial generation) - legacy, kept for backwards compatibility
  originalImage?: string;
  originalScore?: number;
  // Reference photos used (for dev mode)
  referencePhotos?: ReferencePhoto[];
  // Landmark photos used (for dev mode)
  landmarkPhotos?: LandmarkPhoto[];
  // Visual Bible grid image (combines VB elements + secondary landmarks)
  visualBibleGrid?: string;  // Base64 data URL
  // API model used (for dev mode)
  modelId?: string;
  // Bounding box detection for character identification (for dev mode)
  bboxDetection?: BboxSceneDetection | null;
  bboxOverlayImage?: string | null;  // Image with bounding boxes drawn
  // Story title (sent with frontCover during streaming for early display transition)
  storyTitle?: string;
  // User-initiated image versions (same pattern as scene images)
  imageVersions?: ImageVersion[];
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
  storyTypeName?: string;  // Display name for story type
  // New story structure
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom';  // What kind of story
  storyTopic?: string;  // Life challenge or educational topic ID
  storyTheme?: string;  // Adventure theme wrapper (or 'realistic' for no wrapper)
  storyDetails?: string;  // User's custom story idea/description
  artStyle: string;
  language: StoryLanguageCode;
  languageLevel: LanguageLevel;
  pages: number;
  dedication?: string;
  season?: string;  // Season when story takes place
  userLocation?: {
    city: string | null;
    region: string | null;
    country: string | null;
  } | null;
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
  clothingRequirements?: Record<string, {
    standard?: { used: boolean; signature?: string };
    winter?: { used: boolean; signature?: string };
    summer?: { used: boolean; signature?: string };
    costumed?: { used: boolean; costume?: string; description?: string };
  }>;
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
  costumedAvatarGeneration?: Array<{
    timestamp: string;
    characterName: string;
    costumeType: string;
    artStyle: string;
    costumeDescription: string;
    durationMs: number;
    success: boolean;
    error?: string;
    inputs: {
      facePhoto: { identifier: string; sizeKB: number };
      standardAvatar: { identifier: string; sizeKB: number } | null;
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
  // Generation log for debugging (dev mode)
  generationLog?: GenerationLogEntry[];
  // Final consistency checks report (for evaluation-guided regeneration)
  finalChecksReport?: FinalChecksReport;
}

export interface StoryGenerationProgress {
  current: number;
  total: number;
  message: string;
  stage: 'outline' | 'story' | 'scenes' | 'images' | 'covers' | 'complete';
}

// =============================================================================
// Repair Workflow Types
// =============================================================================

export type RepairWorkflowStep =
  | 'idle'
  | 'collect-feedback'
  | 'identify-redo-pages'
  | 'redo-pages'
  | 're-evaluate'
  | 'consistency-check'
  | 'character-repair'
  | 'artifact-repair';

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'skipped' | 'failed';

export interface PageFeedback {
  pageNumber: number;
  qualityScore?: number;
  fixableIssues: Array<{
    description: string;
    severity: string;
    type: string;
    fix: string;
  }>;
  entityIssues: Array<{
    character: string;
    issue: string;
    severity: string;
  }>;
  // Object consistency issues (from entity.objects)
  objectIssues: Array<{
    object: string;
    issue: string;
    severity: string;
  }>;
  // Semantic/legacy image check issues (character_appearance, position_swap, etc.)
  semanticIssues: Array<{
    type: 'character_appearance' | 'position_swap' | 'clothing_mismatch' | 'prop_inconsistency' | 'style_drift';
    description: string;
    severity: string;
    characterInvolved?: string;
    recommendation?: string;
  }>;
  manualNotes: string;
  needsFullRedo: boolean;
}

export interface RepairWorkflowState {
  currentStep: RepairWorkflowStep;
  stepStatus: Record<RepairWorkflowStep, StepStatus>;
  collectedFeedback: {
    pages: Record<number, PageFeedback>;
    totalIssues: number;
  };
  redoPages: {
    pageNumbers: number[];
    reasons: Record<number, string>;
  };
  redoResults: {
    pagesCompleted: number[];
    newVersions: Record<number, number>;
  };
  reEvaluationResults: {
    pages: Record<number, {
      qualityScore: number;
      rawScore?: number;
      verdict?: string;
      issuesSummary?: string;
      reasoning?: string;
      fixableIssues: EvaluationData['fixableIssues'];
    }>;
  };
  consistencyResults: {
    report?: EntityConsistencyReport;
  };
  characterRepairResults: {
    charactersProcessed: string[];
    pagesRepaired: Record<string, number[]>;
  };
  artifactRepairResults: {
    pagesProcessed: number[];
    issuesFixed: number;
  };
  sessionId: string;
}
