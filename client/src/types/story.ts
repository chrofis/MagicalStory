import type { Character, RelationshipMap, RelationshipTextMap, LocalizedString, VisualBible } from './character';

// UI Language - matches LocalizedString keys (used for UI translations)
export type UILanguage = 'en' | 'de' | 'fr' | 'it';
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

// Which world a generated story idea plays in. Resolved server-side
// (resolveIdeaWorlds in server/routes/storyIdeas.js) and shown as a label
// above each idea card; the selected idea's world is sent as `ideaWorld` on
// the create-story payload and persisted on stories.data.
export interface IdeaWorld {
  world: 'location' | 'fantasy';
  theme: string | null;  // wizard theme id backing a fantasy world (null for realistic)
  location: { city: string | null; region?: string | null; country: string | null } | null;
}

// The premise shape an idea arm was built on, picked in code server-side
// (pickPremiseShapes in server/routes/storyIdeas.js from prompts/premise-shapes.txt)
// and echoed back so the wizard can report which shape the customer clicked.
// The shape's definition stays in the prompt file; only the reference travels.
export interface IdeaShapeRef {
  id: number;
  name: string;
}

// What the customer actually clicked: the buy signal the idea-rating series was
// proxying for (owner, 2026-09-21). Sent on create-story, persisted on
// stories.data.ideaPick and logged to idea_events.
export interface IdeaPick {
  index: number | null;          // 0 | 1; null = wrote their own premise
  world: IdeaWorld | null;
  shape: IdeaShapeRef | null;
  worldMode: IdeaWorldMode;
  attempt: number;               // 1 = the first pair; >1 = after regenerating
}

// Steering for idea (re)generation: auto = 1 location + 1 fantasy idea
export type IdeaWorldMode = 'auto' | 'location' | 'fantasy';

// Story category (Adventure, Life Challenge, Educational, Historical, Custom)
export interface StoryCategory {
  id: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom';
  name: LocalizedString;
  description: LocalizedString;
  emoji: string;
}

// Swiss Stories types
// Multilingual string for story ideas (title, description, context)
export type SwissLocalizedString = { en: string; de: string; fr: string; it: string };

export interface SwissStoryIdea {
  id: string;      // 'bern-1'
  // Multilingual (new JSON format) or plain string (legacy MD fallback)
  title: string | SwissLocalizedString;
  description: string | SwissLocalizedString;
  context?: SwissLocalizedString;  // Historical context (only in JSON format)
}

export interface SwissCity {
  id: string;
  name: { en: string; de: string; fr: string; it?: string };
  canton: string;
  lat: number;
  lon: number;
  lang: string;
  ideas: SwissStoryIdea[];
}

export interface SwissSage {
  id: string;
  title: SwissLocalizedString;
  description: SwissLocalizedString;
  context?: SwissLocalizedString;
  themes: string[];
  age: string;
  emoji: string;
}

export interface SwissStoriesData {
  cantons: Record<string, { en: string; de: string; fr: string; it?: string }>;
  cities: SwissCity[];
  sagen?: SwissSage[];
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
  /**
   * The child ages this topic actually lands for, inclusive. Absent means
   * any-age — a life event (a move, a new sibling, a hospital stay) reaches a
   * child at whatever age it happens. `ageGroup` is the picker shelf and is a
   * different thing.
   */
  suitableAges?: [number, number];
  /**
   * How LIVE this topic is for a family right now, in either direction, 1-5.
   * High means the parent is either currently struggling with it (the
   * refusing, the fighting, the not-sleeping, the not-listening) or currently
   * marking it (a first day, a new baby, a thing just mastered). Low means the
   * topic is real but not live: it happens TO the family rather than being what
   * the family is in the middle of.
   *
   * This is NOT topic popularity and NOT how common the event is. A doctor's
   * appointment is common and near-zero liveness — nobody goes looking for a
   * book because an appointment exists.
   *
   * The values are AUTHORED JUDGEMENT, not measurement. The only measured
   * signal that touches them is a 2026-08-26 CH Keyword Planner probe of four
   * German problem queries (docs/decisions.md 2026-09-13).
   */
  liveness?: number;
  /**
   * Which way the topic pulls. `friction` is a current struggle, `milestone` a
   * current joy or thing worth marking, `both` a topic that is genuinely each
   * at once — a new sibling is exciting AND produces jealousy; a first
   * kindergarten day is proud AND frightening. In the trial grid (`composeTrialGrid`)
   * `both` counts toward NEITHER side: it is exempt from the friction quota, and
   * it does not fill the reserved milestone seat, which only a `milestone` topic
   * takes. Documented as "counts toward whichever side is short" until 2026-09-15;
   * the code has never done that.
   */
  pole?: 'friction' | 'milestone' | 'both';
  /**
   * Near-duplicate grouping. At most one topic per family reaches the trial
   * grid, so a parent never sees two tiles that read as the same book.
   */
  family?: string;
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
  category: 'realistic' | 'illustrated' | 'creative';
}

export interface SceneDescription {
  pageNumber: number;
  description: string;
  translatedSummary?: string;  // Pre-extracted translated summary (user's language)
  imageSummary?: string;       // Pre-extracted image summary (English)
  outlineExtract?: string;     // Short scene description from outline
  /**
   * Index into `SceneExpansionReport.prompts[]` — the Art Director prompt that
   * wrote this page's brief. The prompt is ~112 KB and identical for every page
   * of a book, so it is stored once per story, not once per page.
   * Resolve with `resolveScenePrompt()` in `utils/scenePrompt.ts`.
   */
  scenePromptRef?: number | null;
  /** Inline Art Director prompt — stories written before 2026-09-21 only. */
  scenePrompt?: string;
  textModelId?: string;        // Text model used to generate the scene description
}

/** The Art Director's own prompt(s), rolled up by distinct prompt. */
export interface SceneExpansionReport {
  prompts?: Array<{ prompt: string; modelId: string | null; pages: number[] }>;
  durationMs?: number;
  fallbackPages?: number[];
}

// Semantic fidelity evaluation result (parallel check for action/relationship accuracy)
export interface SemanticEvaluationResult {
  score: number | null;
  verdict: string;
  semanticIssues: Array<{
    action?: string;
    problem: string;
    severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
    observed?: string;
    expected?: string;
    type?: string;
    item?: string;
  }>;
  // New prompt format - what was visible vs expected
  visible?: {
    characters?: string[];
    objects?: string[];
    setting?: string;
    action?: string;
  };
  expected?: {
    characters?: string[];
    objects?: string[];
    setting?: string;
    action?: string;
  };
  issues?: Array<{
    type: string;
    item?: string;
    severity: string;
    problem: string;
  }>;
  // Legacy fields (old prompt format)
  storyActions?: Array<{
    action: string;
    actor: string;
    target: string;
    expected_spatial: string;
  }>;
}

export interface EvaluationData {
  score: number;
  reasoning: string;
  issuesSummary?: string;
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
  semanticResult?: SemanticEvaluationResult | null;
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
  // Which imageVersions[] entry this attempt IS (2026-09-21). The repair
  // pipeline writes one retry entry per version; the detection lives on the
  // version, and this is the link to it. Absent on stories generated before
  // that date, which carry their own `bboxDetection` copy instead.
  versionIndex?: number;
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
  // 'critical'|'major'|'minor' is the canonical vocabulary (final-consistency-check.txt); low/medium/high kept for stored legacy reports.
  severity: 'critical' | 'major' | 'minor' | 'low' | 'medium' | 'high';
}

export interface FinalChecksTextIssue {
  page?: number;
  type: 'spelling' | 'grammar' | 'formatting' | 'flow' | 'character' | 'logic';
  text?: string;  // Legacy field
  originalText?: string;  // The problematic text
  correctedText?: string;  // The corrected version
  issue: string;
  suggestion?: string;  // Legacy field
  // 'critical'|'major'|'minor' is the canonical vocabulary (final-consistency-check.txt); low/medium/high kept for stored legacy reports.
  severity: 'critical' | 'major' | 'minor' | 'low' | 'medium' | 'high';
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
export type EntityIssueSubType =
  | 'face_mismatch' | 'face_drift' | 'face_destroyed' | 'hair_change' | 'hair_nuance' | 'skin_tone' | 'age_shift'
  | 'cutout_artifact'
  | 'body_build'
  | 'clothing_inconsistent' | 'garment_colour' | 'color_change' | 'shape_change';

export interface EntityConsistencyIssue {
  id: string;
  source: 'entity';
  pageNumber: number | null;
  region: null;
  /**
   * The evaluator's own type. Older stored evaluations carry the constant
   * 'consistency' here and keep the real type in `subType`; read `subType ||
   * type` when you need the specific one.
   */
  type: 'consistency' | EntityIssueSubType;
  subType: EntityIssueSubType;
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
  gridImage?: string;  // Base64 data URI of the primary grid
  gridImages?: string[];  // All grid images (multi-grid for stories with many pages)
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
  // Per-run history of entity consistency checks. Grid images are stripped
  // from history on the wire — lazy-load via /entity-grid-image?runIndex=N.
  entityHistory?: Array<{
    runIndex: number;
    timestamp: string;
    triggeredBy?: string;
    report: EntityConsistencyReport | null;
  }>;
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
  versionIndex?: number; // DB version_index for correct metadata mapping
  userInput?: string;    // User's input before expansion (for dev mode)
  description?: string;  // Expanded scene description (AI's output)
  // The prompt THIS version's render was handed — never a neighbour's. `null`
  // is a real, meaningful value: a render that sent no prompt of its own (a
  // mechanical recolour) stores null rather than inheriting the page's, so the
  // version record can't answer confidently and wrongly. Read the page-level
  // `prompt` when you need the page's.
  prompt?: string | null;
  modelId?: string;
  createdAt: string;
  type?: 'original' | 'regeneration' | 'iteration' | 'edit' | 'repair' | 'entity-repair' | 'scale-repair' | 'text-space-repair';
  // Specific method that produced this version. Finer-grained than `type`:
  //   - "original"
  //   - "iterate-round-{N}"   (full regen with eval feedback)
  //   - "inpaint-round-{N}"   (Grok inpaint)
  //   - "char-fix-round-{N}"  (legacy character-fix naming)
  //   - "character-fix:{CharName}"  (targeted Grok blended on one character)
  //   - "character-fix"        (generic, final pass)
  //   - "entity-repair"
  //   - "scale-repair"         (tiny-bg-figure repair)
  //   - "post-repair-text-space"
  //   - "edit"
  source?: string;
  qualityScore?: number;
  /** Single score the UI displays = qualityScore − entityPenalty. Set by the backend. */
  finalScore?: number | null;
  rawQualityScore?: number | null;
  semanticScore?: number | null;
  semanticResult?: SemanticEvaluationResult | null;
  // Three-stage eval — Stage 1 vision-inventory text + Stage 2 Sonnet
  // compliance JSON. Stored verbatim per version so the dev panel can show
  // what Gemini actually described in the image vs how Sonnet judged it.
  threeStageResult?: {
    score?: number;
      verdict?: string;
    issuesSummary?: string;
    visionInventory?: string;
    complianceResult?: Record<string, unknown> | null;
  } | null;
  entityPenalty?: number;
  /** Issues that produced this version's entityPenalty, captured at eval time. */
  entityIssues?: Array<{
    name: string;
    severity: string;
    description: string;
    source: string;
  }>;
  evaluatedAt?: string;
  issuesSummary?: string;
  qualityReasoning?: string;
  fixTargets?: Array<{ boundingBox: number[]; issue: string; fixPrompt: string }>;
  fixableIssues?: Array<{
    description: string;
    severity: string;
    type: string;
    fix: string;
    source?: string;
    character?: string;
  }>;
  totalAttempts?: number;
  referencePhotoNames?: Array<{ name: string; photoType?: string; clothingCategory?: string; clothingDescription?: string }>;
  // Bounding box detection (per-version, computed on this version's image)
  bboxDetection?: BboxSceneDetection | null;
  bboxOverlayImage?: string | null;
  // Grok reference images sent for this version
  grokRefImages?: string[] | null;
  // Inpaint repair details
  inpaintInstruction?: string | null;
  inpaintReferenceImages?: string[] | null;
  // Entity repair specific
  entityRepairedFor?: string;
  clothingCategory?: string;
  // Text-space repair: coverage % of the calm region detected for overlay text,
  // and the side the text sits on (top-left/bottom-right/etc). Present on
  // original + each text-space-repair-N candidate so the user can compare.
  textSpaceCoveragePct?: number | null;
  textSpacePosition?: string | null;
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
  /** Single score the UI displays = qualityScore − entityPenalty. Set by the backend. */
  finalScore?: number | null;
  /**
   * CRITICAL/CATASTROPHIC findings still present on the version that shipped,
   * after the repair budget (repairMaxPasses) ran out. `null` when the page is
   * clean — distinguishable from "never checked" (field absent).
   */
  unrepairedCritical?: Array<{
    type: string | null;
    severity: string;
    description: string;
    finalScore: number | null;
  }> | null;
  qualityReasoning?: string;
  qualityModelId?: string;  // Model used for quality evaluation
  semanticScore?: number | null;  // Semantic fidelity score (0-100)
  semanticResult?: SemanticEvaluationResult | null;  // Full semantic evaluation result
  // Three-stage eval (vision-inventory + Sonnet compliance). Stored verbatim
  // so the dev panel can surface what Gemini actually described in the image
  // (Stage 1) and how Sonnet judged it against the prompt (Stage 2).
  threeStageResult?: {
    score?: number;
      verdict?: string;
    issuesSummary?: string;
    visionInventory?: string;
    complianceResult?: Record<string, unknown> | null;
  } | null;
  verdict?: string;  // PASS / SOFT_FAIL / FAIL from quality gate
  issuesSummary?: string;  // One-line summary of issues from evaluation
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
  hasVisualBibleGrid?: boolean;  // Flag when visualBibleGrid is stripped (for lazy loading)
  // Empty scene pre-generation (Pass 1: style anchor)
  emptySceneImage?: string;  // Base64 data URL of generated empty scene
  emptyScenePrompt?: string;  // Prompt used for empty scene generation
  hasEmptySceneImage?: boolean;  // Flag when emptySceneImage is stripped (for lazy loading)
  emptySceneQc?: {  // QC data when empty scene was retried (dev mode)
    v1ImageData?: string;
    v1Issues?: string[];
    visionFeedback?: string;
    retryPrompt?: string;
  } | null;
  textAreaMask?: string | null;  // Base64 data URL — B/W mask sent to Grok marking the text zone (black ~20% = text zone, white ~80% = rest of scene)
  emptySceneVbGrid?: string | null;  // Base64 data URL — filtered VB grid (vehicles + non-landmark locations) actually sent to the empty-scene call
  textCoverageReport?: {  // Text-space repair outcome (dev mode)
    words: number;
    fontPt: number;
    calmNeededPx: number;
    calmFoundPx: number;
    areaPx: number;
    passed: boolean;
    retriesUsed: number;
    winnerIndex: number;
    candidates: { index: number; source: string; calmFoundPx: number; calmPct: number; position: string }[];
    postRepairChecked?: boolean;
  } | null;
  // API model used (for dev mode)
  modelId?: string;
  // User-initiated image versions (first is original, subsequent are regenerations)
  imageVersions?: ImageVersion[];
  // Index of the active version in imageVersions (replaces isActive on individual versions)
  activeVersion?: number;
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
  // Bounding box detection from latest evaluation (for dev mode)
  bboxDetection?: BboxSceneDetection | null;
  bboxOverlayImage?: string | null;
  // Text overlay positioning (from scene expansion + post-gen region detection)
  textPosition?: string;
  textRect?: { x: number; y: number; w: number; h: number; imgWidth: number; imgHeight: number };
  // Layout per page — set at scene-expansion time from languageLevel via resolveLayout().
  // imageAspect: '1:1' (square) for advanced level, '3:4' (A4 portrait) otherwise.
  // textInImage: true means text is rendered as overlay on the image (calm-zone QC + mask + repair run).
  // false means text is rendered in a separate strip below the image (none of those run).
  // Both default to legacy values (3:4 + true) for stories generated before this field existed.
  imageAspect?: '1:1' | '3:4';
  textInImage?: boolean;
}

export interface CoverImageData {
  imageData?: string;
  hasImage?: boolean;  // True if image exists (for lazy loading placeholder)
  description?: string;  // Scene description for the cover (English, for image generation)
  translatedDescription?: string;  // Scene description in story's language (for display in edit modal)
  prompt?: string;       // The actual prompt sent to image generation API
  qualityScore?: number;
  /** Single score the UI displays = qualityScore − entityPenalty. Set by the backend. */
  finalScore?: number | null;
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
  hasVisualBibleGrid?: boolean;  // Flag when visualBibleGrid is stripped (for lazy loading)
  // Exact images packed and padded before sending to Grok edit API (dev mode)
  grokRefImages?: string[] | null;
  // API model used (for dev mode)
  modelId?: string;
  // Bounding box detection for character identification (for dev mode)
  bboxDetection?: BboxSceneDetection | null;
  bboxOverlayImage?: string | null;  // Image with bounding boxes drawn
  // Evaluation fix targets and issues (from repair workflow re-evaluate)
  fixTargets?: Array<{ boundingBox: number[]; issue: string; fixPrompt: string }>;
  fixableIssues?: Array<{ description: string; severity: string; type: string; fix: string; source?: string }>;
  semanticScore?: number | null;
  semanticResult?: Record<string, unknown> | null;
  // Story title (sent with frontCover during streaming for early display transition)
  storyTitle?: string;
  // User-initiated image versions (same pattern as scene images)
  imageVersions?: ImageVersion[];
  // Index of the active version in imageVersions (replaces isActive on individual versions)
  activeVersion?: number;
  // App-side cover typography (MODEL_DEFAULTS.appSideCoverType): the TEXTLESS art the title /
  // dedication / branding was composited onto (persisted as `${coverType}Art` in story_images),
  // plus the computed layout spec. artImageData is stripped from the blob on save (bytes live in R2).
  artImageData?: string;  // Base64 data URL — textless source art (re-composite on title/dedication edit)
  typography?: { kind?: string; fontId?: string; layout?: string; face?: string; lines?: string[]; skipped?: string; [k: string]: unknown } | null;
}

export interface CoverImages {
  frontCover: CoverImageData | null;
  initialPage: CoverImageData | null;
  backCover: CoverImageData | null;
}

// Token usage info for dev mode display
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Per-page before/after produced by a review stage that rewrites pages.
 * Shared shape so the dev-mode diff panels (beats review, scene review, text
 * refine) render from one contract instead of three near-copies.
 */
/**
 * The arc stage's record: the arc as first drafted, the reviewer's analysis
 * (with its fix ledger), and whether the review rewrote it. The APPROVED arc
 * itself travels on beatsReviewReport.arc and in the outline transcript.
 */
/** One panelist's answer in an arc round — the arc's reviewers. */
export interface ArcPanelist {
  letter?: string;
  model?: string | null;
  text?: string;
}

/** One panel + re-tell round of the arc machine. */
export interface ArcRound {
  round?: number;
  panel?: ArcPanelist[];
  failedPanelists?: string[];
  retellModel?: string | null;
  /** The updated STORY LOGIC the re-telling wrote first (2026-09-24). */
  logic?: string;
  finalArc?: string;
  critique?: string;
  fixing?: string;
  keeping?: string;
  used?: string;
  maxSeverity?: string | null;
  /** Dev-mode inspection: what this round actually asked (2026-09-11). */
  panelPrompt?: string | null;
  retellPrompt?: string | null;
  /** The re-telling's raw reply, before parsing (2026-09-23). */
  retellRaw?: string | null;
}

/**
 * The arc machine's record: create (one arc, its STORY LOGIC first) → panel →
 * re-tell. Stories written before 2026-09-24 store the two-arc shape
 * (`committedArc`, `discarded`); both shapes are read.
 *
 * This replaced a single draft-and-review shape, and the old field names
 * (`drafted`, `analysis`, `planModel`, `changed`) were left behind here while
 * the pipeline moved on — so the dev-mode panel rendered nothing from a report
 * that was full of data. Every field below is one the pipeline writes.
 */
export interface ArcReviewReport {
  machine?: string;
  creatorModel?: string | null;
  panelModels?: string[];
  roundsConfigured?: number;
  roundsRun?: number;
  durationMs?: number;
  /** Raw creation output: the story logic, the arc and its critique. */
  create?: string;
  createPrompt?: string | null;
  /** The block the panel read: the create's logic, arc and critique. */
  committed?: string;
  /** The STORY LOGIC the final arc was told from, and the create's own (2026-09-24). */
  logic?: string;
  createLogic?: string;
  /** The names the story logic gives the commission's central figure; null for none. */
  centralFigure?: string[] | null;
  /** Code counts per round (round 0 = the create), logged against their ranges. */
  counts?: Array<{
    round: number;
    sentences: number;
    sentenceRange: { lo: number; hi: number };
    chainLinks: number;
    chainRange: { lo: number; hi: number };
    invented: string[];
    inventedAllowance: number;
  }>;
  /** Stories before 2026-09-24 only: which of two arcs won, and the other one. */
  committedArc?: number;
  discarded?: string;
  rounds?: ArcRound[];
  finalArc?: string;
  critique?: string;
  fixing?: string;
  keeping?: string;
  maxSeverity?: string | null;
  arcHints?: string;
  /** The hint pass: model, the prompt it was sent and its raw reply (2026-09-23). */
  hintsModel?: string;
  hintsPrompt?: string | null;
  hintsRaw?: string | null;
}

/**
 * The wardrobe review's record (beats pipeline, step 3b). It runs on every
 * story before any avatar exists and rewrote an outfit on roughly half of
 * recent staging runs, so what it changed is worth reading.
 *
 * Note the two category spellings: `outfitsIn[].category` is the wardrobe slot
 * (`standard` | `costumed`) with the costume in its own field, while
 * `changed[].category` carries the costume inline as `costumed:<costume>`.
 * `outfitsIn[].description` is the outfit AFTER the review (the report is
 * built once the rewrites are merged) — the pre-review text lives only in
 * `changed[].before`.
 */
export interface ClothingReviewReport {
  model?: string | null;
  durationMs?: number;
  analysis?: string;
  changed?: { name: string; category: string; before: string; after: string }[];
  outfitsIn?: { name: string; category: string; costume?: string | null; description: string }[];
  /**
   * The exact prompt the reviewer received (~13 KB). Present on the live
   * generation payload only — the saved-story metadata route strips it rather
   * than ship it on every story load.
   */
  prompt?: string | null;
}

export interface ReviewDiffReport {
  model?: string | null;
  durationMs?: number;
  changedPages?: number[];
  analysis?: string;
  /**
   * The rewritten pages. `before` is no longer written (2026-09-21): it was a
   * byte-identical copy of the page's `briefsIn` entry. Still present on rows
   * stored before that date.
   */
  pages?: { pageNumber: number; before?: string; after: string }[];
  /** Pages the analysis faulted but never rewrote (surfaced in dev mode). */
  namedButNotRewritten?: number[];
  /** The exact prompt this reviewer received — dev-mode inspection. */
  prompt?: string | null;
  /** Beats review only: the approved arc the pages were written from. */
  arc?: string;
  /** Beats review only: the page plan (may predate the review's rewrites). */
  pagePlan?: string;
  /** Every brief as SENT, including the ones the reviewer left alone. */
  briefsIn?: { pageNumber: number; brief: string }[];
  /** The mechanical clothing-fault block handed to the reviewer, if any. */
  clothingFindings?: string | null;
  /** Clothing faults still present after the review. */
  clothingUnfixed?: { pageNumber: number; type: string; character?: string; detail?: string }[];
  /**
   * Text refine only. The merged audit findings with the outcome the repair
   * pass gave each one, and how many of them nothing closed. Stored since the
   * chain's first ledger; rendered by nothing until 2026-09-20.
   */
  findingLedger?: { pageNumber: number | null; category?: string; sources?: string[]; text: string; outcome: string; reason?: string | null }[];
  unresolvedCount?: number;
  /** Text refine only: corrections the appliers refused, with the reason. */
  lectorDropped?: { pageNumber: number; quote: string; correction?: string; reason?: string }[];
  diffDropped?: { pageNumber: number; quote: string; correction?: string; reason?: string }[];
  /** Text refine only: the per-round trace, including failed rounds. */
  roundTrace?: {
    round: number; kind?: string | null; ok?: boolean; modelId?: string | null;
    error?: string | null; appliedCount?: number | null; changedPages?: number[];
    droppedFindings?: { pageNumber: number; quote?: string; reason?: string }[];
    unparsedLines?: { line: string; reason: string }[];
    prompt?: string; rawResponse?: string;
    pages?: { pageNumber: number; after: string }[];
  }[];
}

export interface SavedStory {
  id: string;
  title: string;
  storyType: string;  // Legacy: adventure theme (pirate, knight, etc.)
  storyTypeName?: string;  // Display name for story type
  // New story structure
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom';  // What kind of story
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
  /** Split-review metadata: which model reviewed, how long, how many fixes. */
  outlineReview?: { model?: string; modelId?: string; durationMs?: number; fixCount?: number; reviewChars?: number; hintCount?: number; reviewedAt?: string } | null;
  /** Per-function model/token/cost/time ledger (dev mode "Models used" panel). */
  tokenUsage?: Record<string, unknown> | null;
  /** Per-page before/after from the parallel text-refine pass (dev mode diff). */
  textRefineReport?: (ReviewDiffReport & { rounds?: number }) | null;
  /** Per-page before/after from the beats review (beats pipeline, dev-mode diff). */
  arcReviewReport?: ArcReviewReport | null;
  beatsReviewReport?: ReviewDiffReport | null;
  /** Per-page before/after from the scene review (beats pipeline, dev-mode diff). */
  sceneReviewReport?: ReviewDiffReport | null;
  /** What the wardrobe review was given and what it rewrote (dev-mode panel). */
  clothingReviewReport?: ClothingReviewReport | null;
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
    clothingCategory?: string;
    durationMs: number;
    success: boolean;
    error?: string;
    attempt?: number;
    sheetFormat?: string;
    faceMatchScore?: number | null;
    clothingMatchScore?: number | null;
    innerLayoutScore?: number | null;
    innerIdentityScore?: number | null;
    innerOutfitScore?: number | null;
    innerFinalScore?: number | null;
    combinedScore?: number | null;
    inputs: {
      facePhoto?: { identifier?: string; sizeKB?: number; imageData?: string } | null;
      originalAvatar?: { identifier?: string; sizeKB?: number; imageData?: string };
      phantom?: { identifier?: string; sizeKB?: number; imageData?: string } | null;
      standardAvatar?: { identifier?: string; sizeKB?: number; imageData?: string } | null;
      styleSample?: { identifier?: string; sizeKB?: number; imageData?: string };
    };
    prompt?: string;
    output?: { identifier?: string; sizeKB?: number; imageData?: string };
    // Two-pass pipeline payload (added 2026-05). Each pass has best-of-N
    // retries with per-task Gemini scores; frontend renders both side-by-side.
    realisticImageData?: string | null;
    passes?: {
      pass1: {
        prompt?: string;
        selectedAttempt: number | null;
        finalScore: number | null;
        attempts: Array<{
          attempt: number;
          stage: string;
          score: number;
          layoutScore?: number | null;
          identityScore?: number | null;
          outfitScore?: number | null;
          sourceMatchScore?: number | null;
          reasons?: string[];
          imageData?: string | null;
        }>;
      };
      pass2: {
        prompt?: string;
        selectedAttempt: number | null;
        finalScore: number | null;
        attempts: Array<{
          attempt: number;
          stage: string;
          score: number;
          layoutScore?: number | null;
          identityScore?: number | null;
          styleScore?: number | null;
          outfitScore?: number | null;
          reasons?: string[];
          imageData?: string | null;
        }>;
      } | null;
    } | null;
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
      facePhoto?: { identifier: string; sizeKB: number } | null;
      standardAvatar?: { identifier: string; sizeKB: number } | null;
      referenceAvatar?: { identifier: string; sizeKB: number } | null;
    };
    prompt?: string;
    output?: { identifier: string; sizeKB: number };
    costumeEvaluation?: {
      pass: boolean;
      confidence: 'high' | 'medium' | 'low';
      reason: string;
      details?: {
        bottomLeft?: { hasCostume: boolean; costumeMatch: string; description: string };
        bottomRight?: { hasCostume: boolean; costumeMatch: string; description: string };
        consistent?: boolean;
      };
    } | null;
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
  | 'inpaint-repair'
  | 'round-1'
  | 'round-2'
  | 'round-3'
  | 'evaluate'
  | 'pick-best'
  | 'style-audit'
  | 'final-pick';

export type StepStatus = 'pending' | 'in-progress' | 'completed' | 'skipped' | 'failed';

export interface PageFeedback {
  pageNumber: number;
  /** Raw visual quality score from Gemini eval (before semantic/entity penalties) */
  qualityScore?: number;
  semanticScore?: number | null;
  entityPenalty?: number;
  /** Final combined score = qualityScore - semanticPenalties - entityPenalties. Used for redo threshold. */
  score?: number;
  verdict?: string;
  issuesSummary?: string;
  semanticResult?: SemanticEvaluationResult | null;
  fixableIssues: Array<{
    description: string;
    severity: string;
    type: string;
    fix: string;
    source?: string;
  }>;
  entityIssues: Array<{
    character: string;
    issue: string;
    severity: string;
    type?: string;
    subType?: string;
    source?: string;
  }>;
  // Object consistency issues (from entity.objects)
  objectIssues: Array<{
    object: string;
    issue: string;
    severity: string;
    type?: string;
    subType?: string;
    source?: string;
  }>;
  // Semantic/legacy image check issues (character_appearance, position_swap, etc.)
  semanticIssues: Array<{
    type: 'character_appearance' | 'position_swap' | 'clothing_mismatch' | 'prop_inconsistency' | 'style_drift';
    description: string;
    severity: string;
    characterInvolved?: string;
    recommendation?: string;
    source?: string;
  }>;
  needsFullRedo: boolean;
}

export interface RepairComparison {
  before: string | null;
  after: string;
  diff?: string;
  reference: string;
  croppedAvatar?: string | null;
  blackoutImage?: string | null;
  grokRawResult?: string | null;
  blendMask?: string | null;
}

/**
 * One rejected repair draw. The repair loop redraws up to three times; every
 * attempt keeps the frames that show what the model was given, what it returned
 * and which gate stopped it — the only way to judge a rejection by looking.
 */
export interface RepairAttemptFrame {
  attempt: number;
  rejectedReason: string | null;
  gateMessage: string | null;
  grokRawResult: string | null;
  blackoutImage: string | null;
  blendMask?: string | null;
  cutoutSent?: string | null;
  iou?: number | null;
}

export interface RepairVerification {
  improved: boolean;
  confidence: string;
  explanation: string;
}

export interface RepairPageResult {
  pageNumber: number;
  comparison?: RepairComparison | null;
  verification?: RepairVerification | null;
  method?: string;
  beforeScore?: number | null;
  afterScore?: number | null;
  afterReasoning?: string | null;
  versionIndex?: number;
  rejected?: boolean;
  retryCount?: number;
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
    pageDetails: Record<number, {
      previousScore: number | null;
      newScore: number | null;
      previousImage: string | null;
      newImage: string | null;
      blackoutImage: string | null;
    }>;
  };
  reEvaluationResults: {
    pages: Record<number, {
      score?: number | null;         // Legacy alias of finalScore
      finalScore?: number | null;    // The stamped version's canonical score
      evalScore?: number | null;     // The stamped version's pre-entity score
      qualityScore: number;          // Visual evaluator's own number
      semanticScore?: number | null; // Semantic fidelity score only
      entityPenalty?: number;        // The stamped version's entity charge
      entityIssues?: Array<{ name?: string | null; severity: string; description?: string; type?: string | null; subType?: string }>;
      scoreBreakdown?: { visual?: { score?: number | null }; semantic?: { score?: number | null } | null; entity?: { penalty?: number | null } } | null;
          verdict?: string;
      issuesSummary?: string;
      reasoning?: string;
      fixableIssues: EvaluationData['fixableIssues'];
      fixTargets?: Array<{ boundingBox: number[]; issue: string; fixPrompt: string }>;
      semanticResult?: SemanticEvaluationResult | null;
    }>;
  };
  consistencyResults: {
    report?: EntityConsistencyReport;
  };
  characterRepairResults: {
    charactersProcessed: string[];
    pagesRepaired: Record<string, RepairPageResult[]>;
    pagesFailed: Record<string, Array<{
      pageNumber: number;
      reason: string;
      rejected?: boolean;
      comparison?: RepairComparison | null;
      /** One entry per rejected draw — the pictures behind a "rejected" verdict. */
      attemptFrames?: RepairAttemptFrame[];
      /** The character was never in the picture; a face repair cannot apply. */
      notOnPage?: boolean;
    }>>;
  };
  inpaintResults: Record<number, {
    repaired: boolean;
    preScore: number | null;
    postScore: number | null;
    afterImage?: string;
    fixTargetsCount: number;
    noErrorsFound?: boolean;
  }>;
  stepErrors: Partial<Record<RepairWorkflowStep, string>>;
  sessionId: string;
  roundResults: {
    [round: number]: {
      actions: Record<number, 'inpaint' | 'iterate' | 'skip'>;
      results: Record<number, { success: boolean; newScore?: number; previousScore?: number }>;
    };
  };
  // Result of the style-audit step (cross-page art-style consistency check).
  // Optional — populated only after the workflow runs the style-audit step.
  styleAuditResult?: {
    verdict: 'consistent' | 'mixed' | 'fragmented';
    dominantCluster: number[];
    anchorPage: number;
    outliers: Array<{ page: number; severity: 'major' | 'moderate' | 'minor'; differences: string[] }>;
    reasoning: string;
    gridImage: string;
  } | null;
}
