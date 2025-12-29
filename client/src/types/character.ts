export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Physical traits from photo analysis
export interface PhysicalTraits {
  height?: string;
  build?: string;
  face?: string;
  hair?: string;
  other?: string;  // Glasses, birthmarks, always-present accessories
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

// Face match evaluation result
export interface FaceMatchResult {
  score: number;    // 1-10 score
  details: string;  // Full evaluation text with feature breakdown
}

// Generated avatars for each clothing category
export interface CharacterAvatars {
  winter?: string;
  standard?: string;
  summer?: string;
  formal?: string;
  generatedAt?: string;
  status?: 'pending' | 'generating' | 'complete' | 'failed';
  stale?: boolean; // True when avatars were generated from a previous photo
  faceMatch?: Record<ClothingCategory, FaceMatchResult>; // Face match evaluation results (dev mode only)
  clothing?: Record<ClothingCategory, string>; // Extracted clothing descriptions per avatar (e.g., "red winter parka, blue jeans")
  prompts?: Record<ClothingCategory, string>; // Actual prompts used for generation (dev mode only)
}

// Clothing information
export interface CharacterClothing {
  current?: string;  // What they're wearing in the reference photo
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

  // Psychological traits
  traits: PsychologicalTraits;

  // Photos
  photos?: CharacterPhotos;

  // Clothing avatars (4 seasonal variations)
  avatars?: CharacterAvatars;

  // Clothing (what they're wearing in reference photo)
  clothing?: CharacterClothing;

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
}

export interface VisualBibleChangeLogEntry {
  timestamp: string;
  page: number;
  element: string;
  type: 'mainCharacter' | 'secondaryCharacter' | 'animal' | 'artifact' | 'location' | 'generatedOutfit';
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
  changeLog: VisualBibleChangeLogEntry[];
}

// Legacy type aliases for backward compatibility during migration
// TODO: Remove these after full migration
export type ClothingAvatars = CharacterAvatars;
export type PhysicalFeatures = PhysicalTraits;
