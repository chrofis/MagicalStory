export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Clothing categories for scene-appropriate avatars
export type ClothingCategory = 'winter' | 'standard' | 'summer' | 'formal';

// Generated avatars for each clothing category
export interface ClothingAvatars {
  winter?: string;   // Warm clothing (coats, scarves, boots)
  standard?: string; // Casual everyday clothing
  summer?: string;   // Light clothing (t-shirts, shorts, dresses)
  formal?: string;   // Formal attire (suits, dresses)
  generatedAt?: string;
  status?: 'pending' | 'generating' | 'complete' | 'failed';
}

// Style Analysis types for Visual Bible integration

export interface PhysicalFeatures {
  face: string;
  hair: string;
  build: string;
}

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
  setting: 'outdoor-warm' | 'outdoor-cold' | 'indoor-casual' | 'indoor-formal' | 'active' | 'sleep' | 'neutral';
}

export interface StyleDNA {
  signatureColors: string[];
  signaturePatterns: string[];
  signatureDetails: string[];
  aesthetic: string;
  alwaysPresent: string[];
}

export interface StyleAnalysis {
  physical: PhysicalFeatures;
  referenceOutfit: ReferenceOutfit;
  styleDNA: StyleDNA;
  analyzedAt: string;
}

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

export interface Character {
  id: number;
  name: string;
  gender: 'male' | 'female' | 'other';
  age: string;
  height?: string;
  build?: string;
  hairColor?: string;
  otherFeatures?: string;
  clothing?: string;
  specialDetails?: string;
  strengths: string[];
  flaws: string[];
  challenges: string[];
  // Legacy fields (for backward compatibility)
  weaknesses?: string[];
  fears?: string[];
  photoUrl?: string;
  thumbnailUrl?: string;  // Smaller cropped face photo for lists
  bodyPhotoUrl?: string;
  bodyNoBgUrl?: string;
  faceBox?: BoundingBox;
  bodyBox?: BoundingBox;
  // Style analysis from photo (for Visual Bible integration)
  styleAnalysis?: StyleAnalysis;
  generatedOutfits?: Record<number, GeneratedOutfit>;
  // Generated avatars for different clothing categories (admin only)
  clothingAvatars?: ClothingAvatars;
}

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
  physical: PhysicalFeatures;
  styleDNA: StyleDNA;
  referenceOutfit: ReferenceOutfit;
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
