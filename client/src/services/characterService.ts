import api from './api';
import type { Character } from '@/types/character';

interface CharacterResponse {
  id: number;
  name: string;
  gender: string;
  age: string;
  height?: string;
  build?: string;
  hair_color?: string;
  other_features?: string;
  clothing?: string;
  special_details?: string;
  strengths: string[];
  weaknesses: string[];
  fears: string[];
  photo_url?: string;
  body_photo_url?: string;
  body_no_bg_url?: string;
  face_box?: { x: number; y: number; width: number; height: number };
  body_box?: { x: number; y: number; width: number; height: number };
}

function mapCharacterFromApi(char: CharacterResponse): Character {
  return {
    id: char.id,
    name: char.name,
    gender: char.gender as 'male' | 'female' | 'other',
    age: char.age,
    height: char.height,
    build: char.build,
    hairColor: char.hair_color,
    otherFeatures: char.other_features,
    clothing: char.clothing,
    specialDetails: char.special_details,
    strengths: char.strengths || [],
    weaknesses: char.weaknesses || [],
    fears: char.fears || [],
    photoUrl: char.photo_url,
    bodyPhotoUrl: char.body_photo_url,
    bodyNoBgUrl: char.body_no_bg_url,
    faceBox: char.face_box,
    bodyBox: char.body_box,
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
    weaknesses: char.weaknesses,
    fears: char.fears,
    photo_url: char.photoUrl,
    body_photo_url: char.bodyPhotoUrl,
    body_no_bg_url: char.bodyNoBgUrl,
    face_box: char.faceBox,
    body_box: char.bodyBox,
  };
}

export const characterService = {
  async getCharacters(): Promise<Character[]> {
    const response = await api.get<{ characters: CharacterResponse[] }>('/api/characters');
    return (response.characters || []).map(mapCharacterFromApi);
  },

  async saveCharacters(characters: Character[]): Promise<void> {
    await api.post('/api/characters', {
      characters: characters.map(mapCharacterToApi),
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
    };
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
        };
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
        } : undefined,
      };
    } catch (error) {
      console.error('Photo analysis failed:', error);
      return { success: false };
    }
  },
};

export default characterService;
