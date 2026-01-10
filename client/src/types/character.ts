export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Detected face for multi-face selection UI
export interface DetectedFace {
  id: number;
  confidence: number;
  faceBox: BoundingBox;
  thumbnail: string;  // Base64 200x200 image
}

// Physical traits from photo analysis
export interface PhysicalTraits {
  height?: string;
  build?: string;
  face?: string;
  eyeColor?: string;     // Eye color (e.g., "blue", "brown", "green")
  eyeColorHex?: string;  // Hex color code for eye color (e.g., "#6B4423")
  hairColor?: string;    // Hair color (e.g., "blonde", "brown", "black")
  hairColorHex?: string; // Hex color code for hair color (e.g., "#3B2314")
  hairLength?: string;   // Hair length (e.g., "shoulder-length", "chin-length", "mid-back")
  hairStyle?: string;    // Hair texture/style (e.g., "straight", "wavy", "curly ponytail")
  hair?: string;         // Legacy: combined hair description (deprecated, use hairColor + hairLength + hairStyle)
  facialHair?: string;   // Facial hair for males (e.g., "none", "stubble", "beard", "mustache", "goatee")
  skinTone?: string;     // Skin tone (e.g., "fair", "medium", "olive", "dark")
  skinUndertone?: string; // Skin undertone (e.g., "warm", "cool", "neutral")
  skinToneHex?: string;  // Hex color code for skin tone (e.g., "#E8BEAC")
  other?: string;        // Glasses, birthmarks, always-present accessories
  detailedHairAnalysis?: string;  // Detailed hair analysis from avatar evaluation
}

// Tracks which physical traits changed from previous photo analysis
export interface ChangedTraits {
  build?: boolean;
  face?: boolean;
  eyeColor?: boolean;
  hairColor?: boolean;
  hairLength?: boolean;
  hairStyle?: boolean;
  hair?: boolean;        // Legacy
  facialHair?: boolean;
  other?: boolean;
  gender?: boolean;
  age?: boolean;
  apparentAge?: boolean;
}

// Source of a physical trait value
export type TraitSource = 'photo' | 'extracted' | 'user';

// Tracks where each physical trait value came from
// Only 'user' source traits are sent to generation (to avoid reinforcing extraction errors)
export interface PhysicalTraitsSource {
  build?: TraitSource;
  face?: TraitSource;
  eyeColor?: TraitSource;
  hairColor?: TraitSource;
  hairLength?: TraitSource;
  hairStyle?: TraitSource;
  hair?: TraitSource;        // Legacy
  facialHair?: TraitSource;
  other?: TraitSource;
}

// Tracks where each clothing value came from
// Only 'user' source clothing is sent to generation (to avoid reinforcing extraction errors)
export interface ClothingSource {
  upperBody?: TraitSource;
  lowerBody?: TraitSource;
  shoes?: TraitSource;
  fullBody?: TraitSource;
}

// Psychological traits
export interface PsychologicalTraits {
  strengths: string[];
  flaws: string[];
  challenges: string[];
  specialDetails?: string;
}

// Photo URLs
export interface CharacterPhotos {
  original?: string;      // Uploaded photo
  face?: string;          // Cropped face thumbnail
  body?: string;          // Cropped body
  bodyNoBg?: string;      // Body with background removed
  faceBox?: BoundingBox;  // Face detection box
  bodyBox?: BoundingBox;  // Body detection box
}

// Clothing categories for scene-appropriate avatars
export type ClothingCategory = 'winter' | 'standard' | 'summer' | 'formal';

// LPIPS perceptual similarity result
export interface LpipsResult {
  lpipsScore: number;       // 0 = identical, 1 = very different
  interpretation: string;   // 'nearly_identical' | 'very_similar' | 'somewhat_similar' | 'different'
  region?: string;          // 'full' or 'cropped'
}

// Face match evaluation result
export interface FaceMatchResult {
  score: number;    // 1-10 score from Gemini
  details: string;  // Full evaluation text with feature breakdown
  lpips?: LpipsResult | null;  // LPIPS perceptual similarity (optional, from Python service)
}

// Styled avatar set for a specific art style (includes standard clothing + costumed)
export interface StyledAvatarSet {
  winter?: string;
  standard?: string;
  summer?: string;
  formal?: string;
  costumed?: Record<string, string>; // Key: costume type (e.g., "Cowboy"), Value: avatar URL
}

// Costumed avatar data (for non-styled costumed avatars)
export interface CostumedAvatarData {
  imageData: string;  // Avatar URL/data
  clothing: string;   // Clothing description used
}

// Generated avatars for each clothing category
export interface CharacterAvatars {
  winter?: string;
  standard?: string;
  summer?: string;
  formal?: string;
  faceThumbnails?: Record<ClothingCategory, string>; // Extracted face thumbnails for display
  generatedAt?: string;
  status?: 'pending' | 'generating' | 'complete' | 'failed';
  stale?: boolean; // True when avatars were generated from a previous photo
  faceMatch?: Record<ClothingCategory, FaceMatchResult>; // Face match evaluation results (dev mode only)
  clothing?: Record<ClothingCategory, string>; // Extracted clothing descriptions per avatar (e.g., "red winter parka, blue jeans")
  prompts?: Record<ClothingCategory, string>; // Actual prompts used for generation (dev mode only)
  rawEvaluation?: Record<string, unknown>; // Full unfiltered API response (dev mode only)
  // Styled avatars converted to different art styles (e.g., Pixar, watercolor)
  // Key: art style (e.g., 'pixar'), Value: avatars per clothing category + optional costumed avatars
  styledAvatars?: Record<string, StyledAvatarSet>;
  // Dynamic costumed avatars (from visual bible costumes, e.g., "Cowboy", "Pirate")
  costumed?: Record<string, CostumedAvatarData>;
  // Cross-avatar LPIPS similarity scores (dev mode only)
  crossLpips?: Record<string, number>;
}

// Structured clothing details
export interface StructuredClothing {
  upperBody?: string;    // T-shirt, sweater, blouse, jacket, etc.
  lowerBody?: string;    // Pants, jeans, skirt, shorts, etc.
  shoes?: string;        // Sneakers, boots, sandals, heels, etc.
  fullBody?: string;     // Dress, gown, jumpsuit - overrides upper+lower when set
}

// Clothing information
export interface CharacterClothing {
  current?: string;           // Legacy: free-text description
  structured?: StructuredClothing;  // Structured clothing details
}

// Generated outfit for a specific page
export interface GeneratedOutfit {
  setting: string;
  outfit: string;
  timestamp: string;
  extractedFrom: string;
  details?: {
    top?: string;
    bottom?: string;
    outerwear?: string;
    footwear?: string;
    accessories?: string[];
  };
}

// Age categories for image generation consistency
export type AgeCategory =
  | 'infant' | 'toddler' | 'preschooler' | 'kindergartner'
  | 'young-school-age' | 'school-age' | 'preteen' | 'young-teen'
  | 'teenager' | 'young-adult' | 'adult' | 'middle-aged' | 'senior' | 'elderly';

// Main Character interface - clean structure
export interface Character {
  // Identity
  id: number;
  name: string;
  gender: 'male' | 'female' | 'other';
  age: string;
  ageCategory?: AgeCategory; // Auto-filled from age, used for image generation
  apparentAge?: AgeCategory; // How old they look in photo (from analysis or user override)

  // Physical traits (from photo analysis)
  physical?: PhysicalTraits;
  // Tracks the source of each physical trait (photo, extracted, user)
  physicalTraitsSource?: PhysicalTraitsSource;

  // Psychological traits
  traits: PsychologicalTraits;

  // Photos
  photos?: CharacterPhotos;

  // Clothing avatars (4 seasonal variations)
  avatars?: CharacterAvatars;

  // Clothing (what they're wearing in reference photo)
  clothing?: CharacterClothing;
  // Tracks the source of each clothing value (extracted, user)
  clothingSource?: ClothingSource;

  // Generated outfits per page (during story generation)
  generatedOutfits?: Record<number, GeneratedOutfit>;
}

// Relationship types
export interface RelationshipMap {
  [key: string]: string; // "charId1-charId2" -> relationship type
}

export interface RelationshipTextMap {
  [key: string]: string; // "charId1-charId2" -> custom text
}

export interface RelationshipType {
  value: LocalizedString;
  inverse: LocalizedString;
}

export interface LocalizedString {
  en: string;
  de: string;
  fr: string;
}

// Visual Bible types
export interface VisualBibleMainCharacter {
  id: number;
  name: string;
  physical: PhysicalTraits;
  generatedOutfits: Record<number, GeneratedOutfit>;
}

export interface VisualBibleEntry {
  id: string;
  name: string;
  appearsInPages: number[];
  description: string;
  extractedDescription: string | null;
  firstAppearanceAnalyzed: boolean;
  source?: 'outline' | 'story_text';  // Where this entry was added from
  // Landmark-related properties (for locations)
  isRealLandmark?: boolean;
  landmarkQuery?: string;  // Exact name to search for landmark photo
  photoFetchStatus?: 'pending' | 'success' | 'failed';
  referencePhotoUrl?: string;
  referencePhotoData?: string;  // Base64 photo data
  photoAttribution?: string;
}

export interface VisualBibleClothingEntry extends VisualBibleEntry {
  wornBy?: string;  // Character who wears this item
  howWorn?: string; // How it's worn
}

export interface VisualBibleChangeLogEntry {
  timestamp: string;
  page: number;
  element: string;
  type: 'mainCharacter' | 'secondaryCharacter' | 'animal' | 'artifact' | 'location' | 'vehicle' | 'clothing' | 'generatedOutfit';
  change: string;
  before: string | null;
  after: string;
}

export interface VisualBible {
  mainCharacters: VisualBibleMainCharacter[];
  secondaryCharacters: VisualBibleEntry[];
  animals: VisualBibleEntry[];
  artifacts: VisualBibleEntry[];
  locations: VisualBibleEntry[];
  vehicles: VisualBibleEntry[];
  clothing: VisualBibleClothingEntry[];
  changeLog: VisualBibleChangeLogEntry[];
}

// Legacy type aliases for backward compatibility during migration
// TODO: Remove these after full migration
export type ClothingAvatars = CharacterAvatars;
export type PhysicalFeatures = PhysicalTraits;
