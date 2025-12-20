import api from './api';
import type { Character, CharacterAvatars, ReferenceOutfit, GeneratedOutfit } from '@/types/character';
import { createLogger } from './logger';

const log = createLogger('CharacterService');

// API response format - supports both snake_case (new) and camelCase (legacy) field names
interface CharacterApiResponse {
  id: number;
  name: string;
  gender: string;
  age: string;
  // Physical traits (snake_case + camelCase legacy)
  height?: string;
  build?: string;
  hair_color?: string;
  hairColor?: string;
  other_features?: string;
  otherFeatures?: string;
  // Photos (snake_case + camelCase legacy)
  photo_url?: string;
  photoUrl?: string;
  thumbnail_url?: string;
  thumbnailUrl?: string;
  body_photo_url?: string;
  bodyPhotoUrl?: string;
  body_no_bg_url?: string;
  bodyNoBgUrl?: string;
  face_box?: { x: number; y: number; width: number; height: number };
  faceBox?: { x: number; y: number; width: number; height: number };
  body_box?: { x: number; y: number; width: number; height: number };
  bodyBox?: { x: number; y: number; width: number; height: number };
  // Psychological traits
  strengths?: string[];
  flaws?: string[];
  challenges?: string[];
  special_details?: string;
  specialDetails?: string;
  // Legacy fields
  weaknesses?: string[];
  fears?: string[];
  // Clothing (snake_case + camelCase legacy)
  clothing?: string;
  clothing_avatars?: CharacterAvatars;
  clothingAvatars?: CharacterAvatars;
  // Style analysis (snake_case + camelCase legacy)
  style_analysis?: {
    physical?: { face?: string; hair?: string; build?: string };
    referenceOutfit?: ReferenceOutfit;
    analyzedAt?: string;
  };
  styleAnalysis?: {
    physical?: { face?: string; hair?: string; build?: string };
    referenceOutfit?: ReferenceOutfit;
    analyzedAt?: string;
  };
  reference_outfit?: ReferenceOutfit;
  referenceOutfit?: ReferenceOutfit;
  generated_outfits?: Record<number, unknown>;
  generatedOutfits?: Record<number, unknown>;
}

// Convert API response to frontend Character
// Handles both snake_case (new format) and camelCase (legacy format) for backward compatibility
function mapCharacterFromApi(api: CharacterApiResponse): Character {
  // Get style analysis from either format
  const styleAnalysis = api.style_analysis || api.styleAnalysis;

  // Extract physical traits from style_analysis or direct fields (with legacy fallbacks)
  const physical = {
    height: api.height,
    build: styleAnalysis?.physical?.build || api.build,
    face: styleAnalysis?.physical?.face || api.other_features || api.otherFeatures,
    hair: styleAnalysis?.physical?.hair || api.hair_color || api.hairColor,
  };

  return {
    id: api.id,
    name: api.name,
    gender: api.gender as 'male' | 'female' | 'other',
    age: api.age,

    physical: (physical.height || physical.build || physical.face || physical.hair) ? physical : undefined,

    traits: {
      strengths: api.strengths || [],
      flaws: api.flaws || api.weaknesses || [],
      challenges: api.challenges || api.fears || [],
      specialDetails: api.special_details || api.specialDetails,
    },

    photos: {
      original: api.photo_url || api.photoUrl,
      face: api.thumbnail_url || api.thumbnailUrl,
      body: api.body_photo_url || api.bodyPhotoUrl,
      bodyNoBg: api.body_no_bg_url || api.bodyNoBgUrl,
      faceBox: api.face_box || api.faceBox,
      bodyBox: api.body_box || api.bodyBox,
    },

    avatars: api.clothing_avatars || api.clothingAvatars,

    clothing: api.clothing ? { current: api.clothing } : undefined,

    referenceOutfit: styleAnalysis?.referenceOutfit || api.reference_outfit || api.referenceOutfit,

    generatedOutfits: (api.generated_outfits || api.generatedOutfits) as Record<number, GeneratedOutfit> | undefined,
  };
}

// Convert frontend Character to API format
function mapCharacterToApi(char: Partial<Character>): Record<string, unknown> {
  return {
    id: char.id,
    name: char.name,
    gender: char.gender,
    age: char.age,
    // Physical traits
    height: char.physical?.height,
    build: char.physical?.build,
    hair_color: char.physical?.hair,
    other_features: char.physical?.face,
    // Photos
    photo_url: char.photos?.original,
    thumbnail_url: char.photos?.face,
    body_photo_url: char.photos?.body,
    body_no_bg_url: char.photos?.bodyNoBg,
    face_box: char.photos?.faceBox,
    body_box: char.photos?.bodyBox,
    // Psychological traits
    strengths: char.traits?.strengths,
    flaws: char.traits?.flaws,
    challenges: char.traits?.challenges,
    special_details: char.traits?.specialDetails,
    // Legacy fields (for backward compatibility)
    weaknesses: char.traits?.flaws,
    fears: char.traits?.challenges,
    // Clothing
    clothing: char.clothing?.current,
    clothing_avatars: char.avatars,
    // Style analysis (legacy format for backend)
    style_analysis: char.physical ? {
      physical: {
        face: char.physical.face,
        hair: char.physical.hair,
        build: char.physical.build,
      },
      referenceOutfit: char.referenceOutfit,
    } : undefined,
    reference_outfit: char.referenceOutfit,
    generated_outfits: char.generatedOutfits,
  };
}

interface CharacterDataResponse {
  characters: CharacterApiResponse[];
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

  async generateClothingAvatars(character: Character): Promise<{
    success: boolean;
    avatars?: CharacterAvatars;
    error?: string;
  }> {
    try {
      // Build physical description from character data
      const age = parseInt(character.age) || 10;
      const gender = character.gender || 'child';
      let genderLabel;
      if (gender === 'male') {
        genderLabel = age >= 18 ? 'man' : 'boy';
      } else if (gender === 'female') {
        genderLabel = age >= 18 ? 'woman' : 'girl';
      } else {
        genderLabel = age >= 18 ? 'person' : 'child';
      }

      let physicalDescription = `${character.name} is a ${age}-year-old ${genderLabel}`;
      if (character.physical) {
        if (character.physical.hair) physicalDescription += `, ${character.physical.hair}`;
        if (character.physical.face) physicalDescription += `, ${character.physical.face}`;
        if (character.physical.build) physicalDescription += `, ${character.physical.build}`;
      }

      // Prefer body with no background for best avatar generation results
      const inputPhoto = character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original;
      log.info(`Generating clothing avatars for ${character.name} (id: ${character.id}), using: ${character.photos?.bodyNoBg ? 'bodyNoBg' : character.photos?.body ? 'body' : character.photos?.face ? 'face' : 'original'}`);

      const response = await api.post<{
        success: boolean;
        clothingAvatars?: CharacterAvatars;
        error?: string;
      }>('/api/generate-clothing-avatars', {
        characterId: character.id,
        facePhoto: inputPhoto,
        physicalDescription,
        name: character.name,
        age: character.age,
        gender: character.gender,
      });

      if (response.success && response.clothingAvatars) {
        log.success(`Clothing avatars generated for ${character.name}`);
        return { success: true, avatars: response.clothingAvatars };
      } else {
        log.error(`Failed to generate avatars: ${response.error}`);
        return { success: false, error: response.error };
      }
    } catch (error) {
      log.error('Clothing avatar generation failed:', error);
      return { success: false, error: String(error) };
    }
  },

  async analyzePhoto(imageData: string): Promise<{
    success: boolean;
    photos?: {
      face?: string;
      body?: string;
      bodyNoBg?: string;
      faceBox?: { x: number; y: number; width: number; height: number };
      bodyBox?: { x: number; y: number; width: number; height: number };
    };
    physical?: {
      height?: string;
      build?: string;
      face?: string;
      hair?: string;
    };
    clothing?: {
      current?: string;
    };
    referenceOutfit?: ReferenceOutfit;
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
        styleAnalysis?: {
          physical?: { face?: string; hair?: string; build?: string };
          referenceOutfit?: ReferenceOutfit;
        };
        error?: string;
        fallback?: boolean;
      }>('/api/analyze-photo', { imageData });

      // Merge physical from attributes and styleAnalysis
      const physical = {
        height: response.attributes?.height,
        build: response.styleAnalysis?.physical?.build || response.attributes?.build,
        face: response.styleAnalysis?.physical?.face || response.attributes?.other_features,
        hair: response.styleAnalysis?.physical?.hair || response.attributes?.hair_color,
      };

      return {
        success: response.success,
        photos: {
          face: response.faceThumbnail,
          body: response.bodyCrop,
          bodyNoBg: response.bodyNoBg,
          faceBox: response.faceBox,
          bodyBox: response.bodyBox,
        },
        physical: (physical.height || physical.build || physical.face || physical.hair) ? physical : undefined,
        clothing: response.attributes?.clothing ? { current: response.attributes.clothing } : undefined,
        referenceOutfit: response.styleAnalysis?.referenceOutfit,
      };
    } catch (error) {
      log.error('Photo analysis failed:', error);
      return { success: false };
    }
  },
};

export default characterService;
