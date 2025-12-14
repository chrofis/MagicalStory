export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
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
  weaknesses: string[];
  fears: string[];
  photoUrl?: string;
  thumbnailUrl?: string;  // Smaller cropped face photo for lists
  bodyPhotoUrl?: string;
  bodyNoBgUrl?: string;
  faceBox?: BoundingBox;
  bodyBox?: BoundingBox;
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
