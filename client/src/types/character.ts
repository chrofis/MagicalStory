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

// Generated avatars for each clothing category
export interface CharacterAvatars {
  winter?: string;
  standard?: string;
  summer?: string;
  formal?: string;
  generatedAt?: string;
  status?: 'pending' | 'generating' | 'complete' | 'failed';
}

// Clothing information
export interface CharacterClothing {
  current?: string;  // What they're wearing in the reference photo
}

// Reference outfit extracted from photo analysis
export interface ReferenceOutfit {
  garmentType: string;
  primaryColor: string;
  secondaryColors: string[];
  pattern: string;
  patternScale: string;
  seamColor: string;
  seamStyle: string;
  fabric: string;
  neckline: string;
  sleeves: string;
  accessories: string[];
  setting: 'neutral' | 'outdoor-warm' | 'outdoor-cold' | 'indoor-casual' | 'indoor-formal' | 'active' | 'sleep';
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

// Main Character interface - clean structure
export interface Character {
  // Identity
  id: number;
  name: string;
  gender: 'male' | 'female' | 'other';
  age: string;

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

  // Reference outfit from photo analysis (developer feature)
  referenceOutfit?: ReferenceOutfit;

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
