import api from './api';
import type { Character, StyleAnalysis } from '@/types/character';
import { createLogger } from './logger';

const log = createLogger('CharacterService');

interface CharacterResponse {
  id: number;
  name: string;
  gender: string;
  age: string;
  height?: string;
  build?: string;
  // Snake_case (new format)
  hair_color?: string;
  other_features?: string;
  special_details?: string;
  photo_url?: string;
  thumbnail_url?: string;
  body_photo_url?: string;
  body_no_bg_url?: string;
  face_box?: { x: number; y: number; width: number; height: number };
  body_box?: { x: number; y: number; width: number; height: number };
  style_analysis?: StyleAnalysis;
  // CamelCase (old format from database)
  hairColor?: string;
  otherFeatures?: string;
  specialDetails?: string;
  photoUrl?: string;
  thumbnailUrl?: string;
  bodyPhotoUrl?: string;
  bodyNoBgUrl?: string;
  faceBox?: { x: number; y: number; width: number; height: number };
  bodyBox?: { x: number; y: number; width: number; height: number };
  styleAnalysis?: StyleAnalysis;
  // Common fields
  clothing?: string;
  strengths: string[];
  flaws?: string[];
  challenges?: string[];
  weaknesses?: string[];
  fears?: string[];
}

function mapCharacterFromApi(char: CharacterResponse): Character {
  return {
    id: char.id,
    name: char.name,
    gender: char.gender as 'male' | 'female' | 'other',
    age: char.age,
    height: char.height,
    build: char.build,
    // Try snake_case first, fall back to camelCase (old format)
    hairColor: char.hair_color || char.hairColor,
    otherFeatures: char.other_features || char.otherFeatures,
    clothing: char.clothing,
    specialDetails: char.special_details || char.specialDetails,
    strengths: char.strengths || [],
    flaws: char.flaws || char.weaknesses || [],
    challenges: char.challenges || char.fears || [],
    // Legacy fields for backward compatibility
    weaknesses: char.weaknesses || char.flaws || [],
    fears: char.fears || char.challenges || [],
    // Try snake_case first, fall back to camelCase (old format)
    photoUrl: char.photo_url || char.photoUrl,
    thumbnailUrl: char.thumbnail_url || char.thumbnailUrl,
    bodyPhotoUrl: char.body_photo_url || char.bodyPhotoUrl,
    bodyNoBgUrl: char.body_no_bg_url || char.bodyNoBgUrl,
    faceBox: char.face_box || char.faceBox,
    bodyBox: char.body_box || char.bodyBox,
    styleAnalysis: char.style_analysis || char.styleAnalysis,
  };
}

function mapCharacterToApi(char: Partial<Character>): Record<string, unknown> {
  return {
    id: char.id,
    name: char.name,
    gender: char.gender,
    age: char.age,
    height: char.height,
    build: char.build,
    hair_color: char.hairColor,
    other_features: char.otherFeatures,
    clothing: char.clothing,
    special_details: char.specialDetails,
    strengths: char.strengths,
    flaws: char.flaws,
    challenges: char.challenges,
    // Legacy fields for backward compatibility
    weaknesses: char.flaws || char.weaknesses,
    fears: char.challenges || char.fears,
    photo_url: char.photoUrl,
    thumbnail_url: char.thumbnailUrl,
    body_photo_url: char.bodyPhotoUrl,
    body_no_bg_url: char.bodyNoBgUrl,
    face_box: char.faceBox,
    body_box: char.bodyBox,
    style_analysis: char.styleAnalysis,
  };
}

interface CharacterDataResponse {
  characters: CharacterResponse[];
  relationships: Record<string, string>;
  relationshipTexts: Record<string, string>;
  customRelationships: string[];
  customStrengths: string[];
  customWeaknesses: string[];
  customFears: string[];
}

export interface CharacterData {
  characters: Character[];
  relationships: Record<string, string>;
  relationshipTexts: Record<string, string>;
  customRelationships: string[];
  customStrengths: string[];
  customWeaknesses: string[];
  customFears: string[];
}

export const characterService = {
  async getCharacters(): Promise<Character[]> {
    const response = await api.get<CharacterDataResponse>('/api/characters');
    return (response.characters || []).map(mapCharacterFromApi);
  },

  async getCharacterData(): Promise<CharacterData> {
    const response = await api.get<CharacterDataResponse>('/api/characters');
    return {
      characters: (response.characters || []).map(mapCharacterFromApi),
      relationships: response.relationships || {},
      relationshipTexts: response.relationshipTexts || {},
      customRelationships: response.customRelationships || [],
      customStrengths: response.customStrengths || [],
      customWeaknesses: response.customWeaknesses || [],
      customFears: response.customFears || [],
    };
  },

  async saveCharacters(characters: Character[]): Promise<void> {
    await api.post('/api/characters', {
      characters: characters.map(mapCharacterToApi),
    });
  },

  async saveCharacterData(data: CharacterData): Promise<void> {
    await api.post('/api/characters', {
      characters: data.characters.map(mapCharacterToApi),
      relationships: data.relationships,
      relationshipTexts: data.relationshipTexts,
      customRelationships: data.customRelationships,
      customStrengths: data.customStrengths,
      customWeaknesses: data.customWeaknesses,
      customFears: data.customFears,
    });
  },

  async analyzePhoto(imageData: string): Promise<{
    success: boolean;
    faceThumbnail?: string;
    bodyCrop?: string;
    bodyNoBg?: string;
    faceBox?: { x: number; y: number; width: number; height: number };
    bodyBox?: { x: number; y: number; width: number; height: number };
    attributes?: {
      age?: string;
      gender?: string;
      height?: string;
      build?: string;
      hairColor?: string;
      clothing?: string;
      otherFeatures?: string;
    };
    styleAnalysis?: StyleAnalysis; // Style DNA for Visual Bible
  }> {
    try {
      const response = await api.post<{
        success: boolean;
        faceThumbnail?: string;
        bodyCrop?: string;
        bodyNoBg?: string;
        faceBox?: { x: number; y: number; width: number; height: number };
        bodyBox?: { x: number; y: number; width: number; height: number };
        attributes?: {
          age?: string;
          gender?: string;
          height?: string;
          build?: string;
          hair_color?: string;
          clothing?: string;
          other_features?: string;
        };
        styleAnalysis?: StyleAnalysis;
        error?: string;
        fallback?: boolean;
      }>('/api/analyze-photo', { imageData });

      return {
        success: response.success,
        faceThumbnail: response.faceThumbnail,
        bodyCrop: response.bodyCrop,
        bodyNoBg: response.bodyNoBg,
        faceBox: response.faceBox,
        bodyBox: response.bodyBox,
        attributes: response.attributes ? {
          age: response.attributes.age,
          gender: response.attributes.gender,
          height: response.attributes.height,
          build: response.attributes.build,
          hairColor: response.attributes.hair_color,
          clothing: response.attributes.clothing,
          otherFeatures: response.attributes.other_features,
        } : undefined,
        styleAnalysis: response.styleAnalysis,
      };
    } catch (error) {
      log.error('Photo analysis failed:', error);
      return { success: false };
    }
  },
};

export default characterService;
