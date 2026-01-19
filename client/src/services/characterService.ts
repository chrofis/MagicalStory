import api from './api';
import type { Character, CharacterAvatars, GeneratedOutfit, AgeCategory, StructuredClothing, PhysicalTraitsSource } from '@/types/character';
import { createLogger } from './logger';

const log = createLogger('CharacterService');

/**
 * Get age category from numeric age string
 * Categories: infant (0-1), toddler (1-2), preschooler (3-4), kindergartner (5-6),
 * young-school-age (7-8), school-age (9-10), preteen (11-12), young-teen (13-14),
 * teenager (15-17), young-adult (18-25), adult (26-39), middle-aged (40-59),
 * senior (60-75), elderly (75+)
 */
export function getAgeCategory(age: string | undefined): AgeCategory | undefined {
  if (!age) return undefined;
  const numAge = parseInt(age, 10);
  if (isNaN(numAge) || numAge < 0) return undefined;

  if (numAge <= 1) return 'infant';
  if (numAge <= 2) return 'toddler';
  if (numAge <= 4) return 'preschooler';
  if (numAge <= 6) return 'kindergartner';
  if (numAge <= 8) return 'young-school-age';
  if (numAge <= 10) return 'school-age';
  if (numAge <= 12) return 'preteen';
  if (numAge <= 14) return 'young-teen';
  if (numAge <= 17) return 'teenager';
  if (numAge <= 25) return 'young-adult';
  if (numAge <= 39) return 'adult';
  if (numAge <= 59) return 'middle-aged';
  if (numAge <= 75) return 'senior';
  return 'elderly';
}

// API response format - supports both snake_case (new) and camelCase (legacy) field names
interface CharacterApiResponse {
  id: number;
  name: string;
  gender: string;
  age: string;
  age_category?: string;
  ageCategory?: string;
  apparent_age?: string;
  apparentAge?: string;
  // Physical traits (snake_case + camelCase legacy)
  height?: string;
  build?: string;
  eye_color?: string;
  eyeColor?: string;
  hair_color?: string;
  hairColor?: string;
  hair_style?: string;
  hairStyle?: string;
  hair_length?: string;
  hairLength?: string;
  facial_hair?: string;
  facialHair?: string;
  skin_tone?: string;
  skinTone?: string;
  skin_undertone?: string;
  skinUndertone?: string;
  skin_tone_hex?: string;
  skinToneHex?: string;
  other_features?: string;
  otherFeatures?: string;
  other?: string;  // Glasses, birthmarks, always-present accessories
  detailed_hair_analysis?: string;
  detailedHairAnalysis?: string;
  physical_traits_source?: PhysicalTraitsSource;
  physicalTraitsSource?: PhysicalTraitsSource;
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
  structured_clothing?: StructuredClothing;
  structuredClothing?: StructuredClothing;
  clothing_style?: string;
  clothingStyle?: string;
  clothing_colors?: string;
  clothingColors?: string;
  clothing_avatars?: CharacterAvatars;
  clothingAvatars?: CharacterAvatars;
  avatars?: CharacterAvatars;  // Direct avatars field (includes styledAvatars from story generation)
  // Generated outfits per page
  generated_outfits?: Record<number, unknown>;
  generatedOutfits?: Record<number, unknown>;
}

// Convert API response to frontend Character
// Handles both snake_case (new format) and camelCase (legacy format) for backward compatibility
function mapCharacterFromApi(api: CharacterApiResponse): Character {
  // Extract physical traits from direct fields (with legacy fallbacks)
  const physical = {
    height: api.height,
    build: api.build,
    face: api.other_features || api.otherFeatures,
    eyeColor: api.eye_color || api.eyeColor,
    hairColor: api.hair_color || api.hairColor,
    hairLength: api.hair_length || api.hairLength,
    hairStyle: api.hair_style || api.hairStyle,
    facialHair: api.facial_hair || api.facialHair,
    skinTone: api.skin_tone || api.skinTone,
    skinUndertone: api.skin_undertone || api.skinUndertone,
    skinToneHex: api.skin_tone_hex || api.skinToneHex,
    hair: api.hair_color || api.hairColor,  // Legacy: combined hair field
    other: api.other,  // Glasses, birthmarks, always-present accessories
    detailedHairAnalysis: api.detailed_hair_analysis || api.detailedHairAnalysis,
    apparentAge: (api.apparent_age || api.apparentAge) as AgeCategory | undefined, // How old they look
  };

  // Compute ageCategory from API or derive from age
  const ageCategory = (api.age_category || api.ageCategory || getAgeCategory(api.age)) as AgeCategory | undefined;

  return {
    id: api.id,
    name: api.name,
    gender: api.gender as 'male' | 'female' | 'other',
    age: api.age,
    ageCategory,

    physical: (physical.height || physical.build || physical.face || physical.eyeColor || physical.hairColor || physical.hairLength || physical.hairStyle || physical.facialHair || physical.skinTone || physical.hair || physical.other || physical.detailedHairAnalysis || physical.apparentAge) ? physical : undefined,

    physicalTraitsSource: api.physical_traits_source || api.physicalTraitsSource,

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

    avatars: api.avatars || api.clothing_avatars || api.clothingAvatars,

    clothing: (api.clothing || api.structured_clothing || api.structuredClothing)
      ? {
          current: api.clothing,
          structured: api.structured_clothing || api.structuredClothing,
        }
      : undefined,

    generatedOutfits: (api.generated_outfits || api.generatedOutfits) as Record<number, GeneratedOutfit> | undefined,
  };
}

// Convert frontend Character to API format
// NOTE: Avatars are NEVER sent - backend manages them exclusively
function mapCharacterToApi(char: Partial<Character>): Record<string, unknown> {
  // Auto-compute ageCategory if not set but age is available
  const ageCategory = char.ageCategory || getAgeCategory(char.age);

  return {
    id: char.id,
    name: char.name,
    gender: char.gender,
    age: char.age,
    age_category: ageCategory,
    apparent_age: char.physical?.apparentAge,
    // Physical traits
    height: char.physical?.height,
    build: char.physical?.build,
    eye_color: char.physical?.eyeColor,
    hair_color: char.physical?.hairColor,
    hair_length: char.physical?.hairLength,
    hair_style: char.physical?.hairStyle,
    facial_hair: char.physical?.facialHair,
    skin_tone: char.physical?.skinTone,
    skin_undertone: char.physical?.skinUndertone,
    skin_tone_hex: char.physical?.skinToneHex,
    other_features: char.physical?.face,
    other: char.physical?.other,  // Glasses, birthmarks, always-present accessories
    detailed_hair_analysis: char.physical?.detailedHairAnalysis,
    physical_traits_source: char.physicalTraitsSource,
    // Photos - NOT sent on regular saves (server preserves existing)
    // This reduces payload from 10-15MB to <1MB
    // Photos are sent via mapCharacterToApiWithPhotos when uploading new photos
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
    // Clothing (text descriptions only - avatars managed by backend)
    clothing: char.clothing?.current,
    structured_clothing: char.clothing?.structured,
    // NOTE: avatars/clothing_avatars NOT sent - backend is source of truth
    // Generated outfits per page
    generated_outfits: char.generatedOutfits,
  };
}

// Custom relationship with forward and inverse
export interface CustomRelationshipPair {
  forward: string;
  inverse: string;
}

// Helper to migrate old string[] format to new CustomRelationshipPair[] format
function migrateCustomRelationships(
  data: string[] | CustomRelationshipPair[] | undefined
): CustomRelationshipPair[] {
  if (!data || data.length === 0) return [];
  // Check if it's old format (array of strings)
  if (typeof data[0] === 'string') {
    // Convert old format: each string becomes both forward and inverse
    return (data as string[]).map(rel => ({ forward: rel, inverse: rel }));
  }
  // Already new format
  return data as CustomRelationshipPair[];
}

interface CharacterDataResponse {
  characters: CharacterApiResponse[];
  relationships: Record<string, string>;
  relationshipTexts: Record<string, string>;
  customRelationships: string[] | CustomRelationshipPair[];
  customStrengths: string[];
  customWeaknesses: string[];
  customFears: string[];
}

export interface CharacterData {
  characters: Character[];
  relationships: Record<string, string>;
  relationshipTexts: Record<string, string>;
  customRelationships: CustomRelationshipPair[];
  customStrengths: string[];
  customWeaknesses: string[];
  customFears: string[];
}

// Extracted traits from avatar evaluation
// Note: gender is NOT extracted - user inputs it. apparentAge IS extracted from avatar.
export interface ExtractedTraits {
  apparentAge?: string;  // Age category based on visual appearance
  build?: string;
  eyeColor?: string;
  eyeColorHex?: string;
  hairColor?: string;
  hairColorHex?: string;
  hairLength?: string;
  hairStyle?: string;
  facialHair?: string;
  skinTone?: string;
  skinToneHex?: string;
  face?: string;
  other?: string;
  detailedHairAnalysis?: string;
}

// Structured clothing from avatar evaluation
export interface ExtractedClothing {
  upperBody?: string | null;
  lowerBody?: string | null;
  shoes?: string | null;
  fullBody?: string | null;
}

// Result type for avatar generation
export interface AvatarGenerationResult {
  characterId: number;
  characterName: string;
  success: boolean;
  avatars?: CharacterAvatars;
  character?: Character;                   // Updated character with avatars and extracted traits/clothing
  extractedTraits?: ExtractedTraits;      // Physical traits extracted from reference photo
  extractedClothing?: ExtractedClothing;   // Clothing extracted from generated avatar
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export const characterService = {
  /**
   * Get characters from API
   * @param includeAllAvatars - If true, includes all avatar variants (dev mode only, requires admin role)
   */
  async getCharacters(includeAllAvatars = false): Promise<Character[]> {
    const url = includeAllAvatars ? '/api/characters?includeAllAvatars=true' : '/api/characters';
    const response = await api.get<CharacterDataResponse>(url);
    return (response.characters || []).map(mapCharacterFromApi);
  },

  /**
   * Get full character data including relationships
   * @param includeAllAvatars - If true, includes all avatar variants (dev mode only, requires admin role)
   */
  async getCharacterData(includeAllAvatars = false): Promise<CharacterData> {
    const url = includeAllAvatars ? '/api/characters?includeAllAvatars=true' : '/api/characters';
    const response = await api.get<CharacterDataResponse>(url);
    const mapped = (response.characters || []).map(mapCharacterFromApi);
    return {
      characters: mapped,
      relationships: response.relationships || {},
      relationshipTexts: response.relationshipTexts || {},
      customRelationships: migrateCustomRelationships(response.customRelationships),
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

  async saveCharacterData(data: CharacterData, options?: { includePhotos?: boolean }): Promise<void> {
    // Map each character - avatars are NEVER sent (backend is source of truth)
    const mapCharacter = (char: Character) => {
      const result = mapCharacterToApi(char);
      if (options?.includePhotos) {
        result.photo_url = char.photos?.original;
        result.thumbnail_url = char.photos?.face;
        result.body_photo_url = char.photos?.body;
        result.body_no_bg_url = char.photos?.bodyNoBg;
      }
      return result;
    };
    const apiData = {
      characters: data.characters.map(mapCharacter),
      relationships: data.relationships,
      relationshipTexts: data.relationshipTexts,
      customRelationships: data.customRelationships,
      customStrengths: data.customStrengths,
      customWeaknesses: data.customWeaknesses,
      customFears: data.customFears,
    };
    await api.post('/api/characters', apiData);
  },

  /**
   * Delete a single character by ID (much faster than re-saving all characters)
   * Server handles relationship cleanup
   */
  async deleteCharacter(characterId: number): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await api.delete<{ success: boolean; message: string; remainingCount: number }>(
        `/api/characters/${characterId}`
      );
      log.success(`Deleted character ${characterId}: ${response.message}`);
      return { success: true };
    } catch (error) {
      log.error(`Failed to delete character ${characterId}:`, error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Load full avatars for a specific character (on-demand)
   * Used when editing a character to avoid loading all avatars upfront
   */
  async loadCharacterAvatars(characterId: number): Promise<CharacterAvatars | null> {
    try {
      const response = await api.get<{ avatars: CharacterAvatars }>(`/api/characters/${characterId}/avatars`);
      log.info(`Loaded full avatars for character ${characterId}`);
      return response.avatars || null;
    } catch (error) {
      log.error(`Failed to load avatars for character ${characterId}:`, error);
      return null;
    }
  },

  /**
   * Load full character data for editing (on-demand)
   * Includes heavy fields: body_no_bg_url, body_photo_url, photo_url, clothing_avatars, avatars
   * These are stripped from the list view to reduce payload from ~3MB to ~100KB per character
   */
  async loadFullCharacter(characterId: number): Promise<Character | null> {
    try {
      const response = await api.get<{ character: CharacterApiResponse }>(`/api/characters/${characterId}/full`);
      if (response.character) {
        log.info(`Loaded full data for character ${characterId}`);
        return mapCharacterFromApi(response.character);
      }
      return null;
    } catch (error) {
      log.error(`Failed to load full data for character ${characterId}:`, error);
      return null;
    }
  },

  /**
   * Generate 3 avatar options for user to choose from
   */
  async generateAvatarOptions(facePhoto: string, gender: string): Promise<{
    success: boolean;
    options: Array<{ id: number; imageData: string }>;
    error?: string;
  }> {
    try {
      const response = await api.post<{
        success: boolean;
        options: Array<{ id: number; imageData: string }>;
        error?: string;
      }>('/api/generate-avatar-options', {
        facePhoto,
        gender,
        category: 'standard'
      });
      return response;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, options: [], error: message };
    }
  },

  async generateClothingAvatars(character: Character, options?: { avatarModel?: string }): Promise<{
    success: boolean;
    avatars?: CharacterAvatars;
    extractedTraits?: ExtractedTraits;
    extractedClothing?: ExtractedClothing;
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

      // Use name if available, otherwise generic description
      const nameOrGeneric = character.name?.trim() || `This ${genderLabel}`;
      let physicalDescription = `${nameOrGeneric} is a ${age}-year-old ${genderLabel}`;
      if (character.physical) {
        if (character.physical.hair) physicalDescription += `, ${character.physical.hair}`;
        if (character.physical.face) physicalDescription += `, ${character.physical.face}`;
        if (character.physical.build) physicalDescription += `, ${character.physical.build}`;
        if (character.physical.other) physicalDescription += `, ${character.physical.other}`;
      }

      // Prefer body with no background for best avatar generation results
      const inputPhoto = character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original;
      log.info(`🎨 Generating clothing avatars for ${character.name || 'unnamed'} (id: ${character.id})`);

      // Use async mode to avoid blocking connections
      // This allows character loading and other requests to proceed in parallel
      const startResponse = await api.post<{
        success: boolean;
        async?: boolean;
        jobId?: string;
        clothingAvatars?: CharacterAvatars & {
          extractedTraits?: ExtractedTraits;
          structuredClothing?: Record<string, ExtractedClothing>;
          rawEvaluation?: Record<string, unknown>;
        };
        error?: string;
      }>('/api/generate-clothing-avatars?async=true', {
        characterId: character.id,
        facePhoto: inputPhoto,
        physicalDescription,
        name: character.name,
        age: character.age,
        apparentAge: character.physical?.apparentAge,
        gender: character.gender,
        build: character.physical?.build,
        clothing: character.clothing?.structured,
        avatarModel: options?.avatarModel,
      });

      // If async mode, poll for completion
      if (startResponse.async && startResponse.jobId) {
        log.info(`Avatar job started: ${startResponse.jobId}, polling for completion...`);

        // Poll every 2 seconds for up to 2 minutes
        const maxAttempts = 60;
        const pollInterval = 2000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          const statusResponse = await api.get<{
            jobId: string;
            status: string;
            progress?: number;
            message?: string;
            success?: boolean;
            clothingAvatars?: CharacterAvatars & {
              extractedTraits?: ExtractedTraits;
              structuredClothing?: Record<string, ExtractedClothing>;
              rawEvaluation?: Record<string, unknown>;
            };
            error?: string;
          }>(`/api/avatar-jobs/${startResponse.jobId}`);

          if (statusResponse.status === 'complete' && statusResponse.clothingAvatars) {
            log.success(`Avatar job ${startResponse.jobId} completed after ${(attempt + 1) * 2}s`);
            // Process the result same as sync mode
            const extractedTraits = statusResponse.clothingAvatars.extractedTraits;
            const extractedClothing = statusResponse.clothingAvatars.structuredClothing?.standard;
            log.info(`🔍 [DEBUG] extractedTraits: ${JSON.stringify(extractedTraits)?.substring(0, 100)}`);
            log.info(`🔍 [DEBUG] extractedClothing: ${JSON.stringify(extractedClothing)}`);
            log.info(`🔍 [DEBUG] structuredClothing keys: ${Object.keys(statusResponse.clothingAvatars.structuredClothing || {})}`);
            return {
              success: true,
              avatars: statusResponse.clothingAvatars,
              extractedTraits,
              extractedClothing,
            };
          }

          if (statusResponse.status === 'failed') {
            log.error(`Avatar job failed: ${statusResponse.error}`);
            return { success: false, error: statusResponse.error };
          }

          // Still processing, continue polling
          if (attempt % 5 === 0) {
            log.info(`Avatar job ${startResponse.jobId}: ${statusResponse.message || statusResponse.status} (${statusResponse.progress || 0}%)`);
          }
        }

        return { success: false, error: 'Avatar generation timed out' };
      }

      // Fallback: sync response (shouldn't happen with async=true)
      const response = startResponse;
      if (response.success && response.clothingAvatars) {
        log.success(`Clothing avatars generated for ${character.name}`);

        // Extract traits and clothing from the response
        const extractedTraits = response.clothingAvatars.extractedTraits;
        const extractedClothing = response.clothingAvatars.structuredClothing?.standard;

        if (extractedTraits) {
          log.info(`Extracted traits: ${JSON.stringify(extractedTraits)}`);
        }
        if (extractedClothing) {
          log.info(`Extracted clothing: ${JSON.stringify(extractedClothing)}`);
        }

        return {
          success: true,
          avatars: response.clothingAvatars,
          extractedTraits,
          extractedClothing,
        };
      } else {
        log.error(`Failed to generate avatars: ${response.error}`);
        return { success: false, error: response.error };
      }
    } catch (error) {
      log.error('Clothing avatar generation failed:', error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Generate clothing avatars WITH physical traits included in the prompt.
   * This passes all user-modified traits (glasses, hair color, etc.) to avatar generation.
   * Use this to compare results with the standard generation method.
   */
  async generateClothingAvatarsWithTraits(character: Character): Promise<{
    success: boolean;
    avatars?: CharacterAvatars;
    extractedTraits?: ExtractedTraits;
    extractedClothing?: ExtractedClothing;
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

      // Use name if available, otherwise generic description
      const nameOrGeneric = character.name?.trim() || `This ${genderLabel}`;
      let physicalDescription = `${nameOrGeneric} is a ${age}-year-old ${genderLabel}`;
      if (character.physical) {
        if (character.physical.hair) physicalDescription += `, ${character.physical.hair}`;
        if (character.physical.face) physicalDescription += `, ${character.physical.face}`;
        if (character.physical.build) physicalDescription += `, ${character.physical.build}`;
        if (character.physical.other) physicalDescription += `, ${character.physical.other}`;
      }

      // Prefer body with no background for best avatar generation results
      const inputPhoto = character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original;
      const photoSource = character.photos?.bodyNoBg ? 'bodyNoBg' : character.photos?.body ? 'body' : character.photos?.face ? 'face' : 'original';
      const photoSize = inputPhoto ? Math.round(inputPhoto.length / 1024) : 0;
      const isPNG = inputPhoto?.startsWith('data:image/png');
      log.info(`🎨 Generating clothing avatars WITH TRAITS for ${character.name} (id: ${character.id})`);
      log.info(`📸 Photo source: ${photoSource}, size: ${photoSize}KB, format: ${isPNG ? 'PNG' : 'JPEG'}`);
      log.info(`📸 Available photos: bodyNoBg=${!!character.photos?.bodyNoBg}, body=${!!character.photos?.body}, face=${!!character.photos?.face}, original=${!!character.photos?.original}`);
      log.info(`Physical traits: ${JSON.stringify(character.physical)}`);

      // Filter traits to only include those with 'user' source
      // This prevents reinforcing extraction errors during regeneration
      const traitsSource = character.physicalTraitsSource || {};
      log.info(`Physical traits source: ${JSON.stringify(traitsSource)}`);
      log.info(`Physical skinTone value: '${character.physical?.skinTone}', source: '${traitsSource.skinTone}'`);
      log.info(`Physical hairStyle value: '${character.physical?.hairStyle}', source: '${traitsSource.hairStyle}'`);

      const userTraits: typeof character.physical = {};
      if (character.physical) {
        if (traitsSource.eyeColor === 'user' && character.physical.eyeColor) {
          userTraits.eyeColor = character.physical.eyeColor;
        }
        if (traitsSource.hairColor === 'user' && character.physical.hairColor) {
          userTraits.hairColor = character.physical.hairColor;
        }
        if (traitsSource.hairLength === 'user' && character.physical.hairLength) {
          userTraits.hairLength = character.physical.hairLength;
        }
        if (traitsSource.hairStyle === 'user' && character.physical.hairStyle) {
          userTraits.hairStyle = character.physical.hairStyle;
        }
        if (traitsSource.build === 'user' && character.physical.build) {
          userTraits.build = character.physical.build;
        }
        if (traitsSource.skinTone === 'user' && character.physical.skinTone) {
          userTraits.skinTone = character.physical.skinTone;
          // Also include hex if available (uses same source as skinTone)
          if (character.physical.skinToneHex) {
            userTraits.skinToneHex = character.physical.skinToneHex;
          }
        }
        if (traitsSource.face === 'user' && character.physical.face) {
          userTraits.face = character.physical.face;
        }
        if (traitsSource.facialHair === 'user' && character.physical.facialHair) {
          userTraits.facialHair = character.physical.facialHair;
        }
        if (traitsSource.other === 'user' && character.physical.other) {
          userTraits.other = character.physical.other;
        }
      }

      const hasUserTraits = Object.keys(userTraits).length > 0;
      log.info(`Physical traits to send (user-edited only): ${hasUserTraits ? JSON.stringify(userTraits) : 'none'}`);

      // Filter clothing to only include user-edited items (not AI-extracted)
      // This prevents reinforcing extraction errors during regeneration
      const clothingSource = character.clothingSource || {};
      const userClothing: { upperBody?: string; lowerBody?: string; shoes?: string; fullBody?: string } = {};
      if (character.clothing?.structured) {
        if (clothingSource.upperBody === 'user' && character.clothing.structured.upperBody) {
          userClothing.upperBody = character.clothing.structured.upperBody;
        }
        if (clothingSource.lowerBody === 'user' && character.clothing.structured.lowerBody) {
          userClothing.lowerBody = character.clothing.structured.lowerBody;
        }
        if (clothingSource.shoes === 'user' && character.clothing.structured.shoes) {
          userClothing.shoes = character.clothing.structured.shoes;
        }
        if (clothingSource.fullBody === 'user' && character.clothing.structured.fullBody) {
          userClothing.fullBody = character.clothing.structured.fullBody;
        }
      }
      const hasUserClothing = Object.keys(userClothing).length > 0;
      log.info(`Clothing to send (user-edited only): ${hasUserClothing ? JSON.stringify(userClothing) : 'none'}`);

      const startResponse = await api.post<{
        success: boolean;
        async?: boolean;
        jobId?: string;
        clothingAvatars?: CharacterAvatars & {
          extractedTraits?: ExtractedTraits;
          structuredClothing?: Record<string, ExtractedClothing>;
        };
        error?: string;
      }>('/api/generate-clothing-avatars?async=true', {
        characterId: character.id,
        facePhoto: inputPhoto,
        physicalDescription,
        name: character.name,
        age: character.age,
        apparentAge: character.physical?.apparentAge,
        gender: character.gender,
        build: userTraits.build || 'average',
        // Only pass user-edited physical traits (not extracted ones)
        physicalTraits: hasUserTraits ? userTraits : undefined,
        // Only pass user-edited clothing (not AI-extracted)
        clothing: hasUserClothing ? userClothing : undefined,
      });

      // Async mode: poll for job completion
      if (startResponse.async && startResponse.jobId) {
        log.info(`Avatar job started: ${startResponse.jobId}, polling for completion...`);

        // Poll every 2 seconds for up to 2 minutes
        const maxAttempts = 60;
        const pollInterval = 2000;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));

          const statusResponse = await api.get<{
            jobId: string;
            status: string;
            progress?: number;
            message?: string;
            success?: boolean;
            clothingAvatars?: CharacterAvatars & {
              extractedTraits?: ExtractedTraits;
              structuredClothing?: Record<string, ExtractedClothing>;
            };
            error?: string;
          }>(`/api/avatar-jobs/${startResponse.jobId}`);

          if (statusResponse.status === 'complete' && statusResponse.clothingAvatars) {
            log.success(`Avatar job ${startResponse.jobId} completed after ${(attempt + 1) * 2}s`);
            const extractedTraits = statusResponse.clothingAvatars.extractedTraits;
            const extractedClothing = statusResponse.clothingAvatars.structuredClothing?.standard;
            return {
              success: true,
              avatars: statusResponse.clothingAvatars,
              extractedTraits,
              extractedClothing,
            };
          }

          if (statusResponse.status === 'failed') {
            log.error(`Avatar job failed: ${statusResponse.error}`);
            return { success: false, error: statusResponse.error };
          }

          // Log progress periodically
          if (attempt % 5 === 0) {
            log.info(`Avatar job ${startResponse.jobId}: ${statusResponse.message || statusResponse.status} (${statusResponse.progress || 0}%)`);
          }
        }

        return { success: false, error: 'Avatar generation timed out' };
      }

      // Fallback: sync response (shouldn't happen with async=true)
      if (startResponse.success && startResponse.clothingAvatars) {
        log.success(`Clothing avatars WITH TRAITS generated for ${character.name}`);
        const extractedTraits = startResponse.clothingAvatars.extractedTraits;
        const extractedClothing = startResponse.clothingAvatars.structuredClothing?.standard;
        return {
          success: true,
          avatars: startResponse.clothingAvatars,
          extractedTraits,
          extractedClothing,
        };
      } else {
        log.error(`Failed to generate avatars with traits: ${startResponse.error}`);
        return { success: false, error: startResponse.error };
      }
    } catch (error) {
      log.error('Clothing avatar generation with traits failed:', error);
      return { success: false, error: String(error) };
    }
  },

  async analyzePhoto(imageData: string, language?: string, selectedFaceId?: number, cachedFaces?: Array<{ id: number; x: number; y: number; width: number; height: number; confidence: number }>, existingCharacterId?: number): Promise<{
    success: boolean;
    error?: string;  // Error code (e.g., 'no_face_detected')
    // Character ID created by server
    characterId?: number;
    // Multi-face detection fields
    multipleFacesDetected?: boolean;
    faceCount?: number;
    faces?: Array<{
      id: number;
      confidence: number;
      faceBox: { x: number; y: number; width: number; height: number };
      thumbnail: string;
    }>;
    // Normal response fields (only when single face or face selected)
    photos?: {
      face?: string;
      body?: string;
      bodyNoBg?: string;
      faceBox?: { x: number; y: number; width: number; height: number };
      bodyBox?: { x: number; y: number; width: number; height: number };
    };
    // Basic info extracted from photo
    age?: string;
    apparentAge?: AgeCategory;  // How old they look (from photo analysis)
    gender?: string;
    physical?: {
      height?: string;
      build?: string;
      face?: string;
      eyeColor?: string;
      hairColor?: string;
      hairLength?: string;
      hairStyle?: string;
      hair?: string;   // Legacy: combined hair description
      other?: string;  // Glasses, birthmarks, always-present accessories
    };
    clothing?: {
      current?: string;
      style?: string;
    };
    // Debug info for dev mode
    _debug?: {
      rawResponse?: string;
      error?: string;
    };
  }> {
    try {
      const response = await api.post<{
        success: boolean;
        // Character ID created by server
        characterId?: number;
        // Multi-face detection fields
        multipleFacesDetected?: boolean;
        faceCount?: number;
        faces?: Array<{
          id: number;
          confidence: number;
          faceBox: { x: number; y: number; width: number; height: number };
          thumbnail: string;
        }>;
        // Normal response fields
        faceThumbnail?: string;
        bodyCrop?: string;
        bodyNoBg?: string;
        faceBox?: { x: number; y: number; width: number; height: number };
        bodyBox?: { x: number; y: number; width: number; height: number };
        attributes?: {
          age?: string;
          apparent_age?: string;  // Age category from visual analysis
          gender?: string;
          height?: string;
          build?: string;
          face?: string;  // Face description
          eye_color?: string;
          eyeColor?: string;
          hair_color?: string;
          hairColor?: string;
          hair_length?: string;
          hairLength?: string;
          hair_style?: string;
          hairStyle?: string;
          clothing?: string;
          clothingStyle?: string;  // Colors and patterns of clothing
          clothingColors?: string;  // Legacy: main colors of clothing
          other_features?: string;  // Distinctive markings (glasses, etc.)
        };
        error?: string;
        fallback?: boolean;
        _debug?: { rawResponse?: string; error?: string };
      }>('/api/analyze-photo', { imageData, language, selectedFaceId, cachedFaces, existingCharacterId });

      // If analysis failed (e.g., no face detected), return error
      if (!response.success) {
        return {
          success: false,
          error: response.error,
        };
      }

      // If multiple faces detected and no selection made, return faces for selection
      if (response.multipleFacesDetected && response.faces) {
        log.info(`Multiple faces detected (${response.faceCount}), showing selection UI`);
        return {
          success: true,
          multipleFacesDetected: true,
          faceCount: response.faceCount,
          faces: response.faces,
        };
      }

      // Extract physical traits from attributes
      const physical = {
        height: response.attributes?.height,
        build: response.attributes?.build,
        face: response.attributes?.face,  // Face description
        eyeColor: response.attributes?.eye_color || response.attributes?.eyeColor,
        hairColor: response.attributes?.hair_color || response.attributes?.hairColor,
        hairLength: response.attributes?.hair_length || response.attributes?.hairLength,
        hairStyle: response.attributes?.hair_style || response.attributes?.hairStyle,
        hair: response.attributes?.hair_color || response.attributes?.hairColor,  // Legacy compatibility
        other: response.attributes?.other_features,  // Distinctive markings
      };

      return {
        success: response.success,
        characterId: response.characterId,  // Server-created character ID
        multipleFacesDetected: false,
        faceCount: response.faceCount,
        photos: {
          face: response.faceThumbnail,
          body: response.bodyCrop,
          bodyNoBg: response.bodyNoBg,
          faceBox: response.faceBox,
          bodyBox: response.bodyBox,
        },
        // Basic info from analysis
        age: response.attributes?.age,
        apparentAge: response.attributes?.apparent_age as AgeCategory | undefined,
        gender: response.attributes?.gender,
        physical: (physical.height || physical.build || physical.face || physical.eyeColor || physical.hairColor || physical.hairLength || physical.hairStyle || physical.hair || physical.other) ? physical : undefined,
        clothing: response.attributes?.clothing || response.attributes?.clothingStyle || response.attributes?.clothingColors
          ? { current: response.attributes.clothing, style: response.attributes.clothingStyle || response.attributes.clothingColors }
          : undefined,
        _debug: response._debug,
      };
    } catch (error) {
      log.error('Photo analysis failed:', error);
      return { success: false, error: 'unknown_error' };
    }
  },

  /**
   * Check if a character needs avatar generation
   * Returns true if character has a photo but no complete avatars
   */
  needsAvatars(character: Character): boolean {
    // Must have a photo
    const hasPhoto = !!(character.photos?.original || character.photos?.face || character.photos?.body || character.photos?.bodyNoBg);
    if (!hasPhoto) return false;

    // Check if avatars are missing or incomplete
    const avatars = character.avatars;
    if (!avatars) return true;
    if (avatars.status === 'generating' || avatars.status === 'pending') return false; // Already in progress
    if (avatars.status === 'failed') return true; // Retry failed ones

    // Check if at least one avatar exists (or hasFullAvatars flag is set)
    const hasAnyAvatar = !!(avatars.winter || avatars.standard || avatars.summer || avatars.formal || avatars.hasFullAvatars);
    return !hasAnyAvatar;
  },

  /**
   * Generate avatars for a single character and save to storage
   * This is the core function that handles generation + persistence
   * Also populates physical traits and clothing from the evaluation
   */
  async generateAndSaveAvatarForCharacter(
    character: Character,
    onProgress?: (status: 'starting' | 'generating' | 'saving' | 'complete' | 'error', message: string) => void,
    options?: { avatarModel?: string }
  ): Promise<AvatarGenerationResult> {
    const result: AvatarGenerationResult = {
      characterId: character.id,
      characterName: character.name,
      success: false,
    };

    try {
      // Check if character has a photo
      const hasPhoto = !!(character.photos?.original || character.photos?.face || character.photos?.body || character.photos?.bodyNoBg);
      if (!hasPhoto) {
        result.skipped = true;
        result.skipReason = 'No photo available';
        return result;
      }

      onProgress?.('generating', `Generating avatars for ${character.name}...`);
      log.info(`🎨 Generating avatars for ${character.name} (id: ${character.id})${options?.avatarModel ? `, model: ${options.avatarModel}` : ''}`);

      // Generate avatars
      const genResult = await characterService.generateClothingAvatars(character, options);

      if (!genResult.success || !genResult.avatars) {
        result.error = genResult.error || 'Avatar generation failed';
        onProgress?.('error', result.error);
        return result;
      }

      result.avatars = genResult.avatars;
      result.extractedTraits = genResult.extractedTraits;
      result.extractedClothing = genResult.extractedClothing;

      // Server avatar job already saved to database directly - no need to save again
      // Just fetch fresh data to get the server's version with extracted traits/clothing
      onProgress?.('saving', `Fetching updated data for ${character.name}...`);

      // Fetch FULL character data from server (avatar job already saved everything)
      // Use loadFullCharacter which works for all users (not just admins)
      // Use retry logic with exponential backoff to handle race condition where avatar job
      // DB write may still be in progress. Avatar jobs take 10-15 seconds, so we need patience.
      let freshCharacter: Character | null = null;
      const maxAttempts = 30; // 30 attempts with backoff = up to ~60 seconds total
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          // Exponential backoff: 500ms, 600ms, 720ms, ... up to 3000ms max
          const backoffDelay = Math.min(500 * Math.pow(1.2, attempt), 3000);
          log.info(`[AVATAR] Retry ${attempt + 1}/${maxAttempts}: waiting ${Math.round(backoffDelay)}ms for avatar data...`);
          await new Promise(r => setTimeout(r, backoffDelay));
        }
        freshCharacter = await characterService.loadFullCharacter(character.id);
        // Check if avatars are actually present in the response
        if (freshCharacter?.avatars?.standard || freshCharacter?.avatars?.winter || freshCharacter?.avatars?.summer) {
          log.info(`[AVATAR] Got fresh data with avatars on attempt ${attempt + 1}`);
          break;
        }
      }

      if (freshCharacter) {
        result.character = freshCharacter;
        // Warn if avatars are missing - this indicates a server-side issue
        const hasAvatars = freshCharacter.avatars?.standard || freshCharacter.avatars?.winter || freshCharacter.avatars?.summer;
        if (!hasAvatars) {
          log.warn(`⚠️ Fresh DB data for ${character.name} missing avatars after ${maxAttempts} retries - server may not have saved them`);
        }
        log.info(`📋 Using server-saved data for ${character.name}`);
      } else {
        // Character not found in DB - this is a server-side bug
        log.error(`❌ Character ${character.name} (id: ${character.id}) not found in DB after avatar job - avatars lost!`);
        result.character = {
          ...character,
          avatars: { status: 'failed' as const },
          physical: genResult.extractedTraits ? {
            ...character.physical,
            apparentAge: (genResult.extractedTraits.apparentAge as AgeCategory) || character.physical?.apparentAge,
            build: genResult.extractedTraits.build || character.physical?.build,
            eyeColor: genResult.extractedTraits.eyeColor || character.physical?.eyeColor,
            eyeColorHex: genResult.extractedTraits.eyeColorHex || character.physical?.eyeColorHex,
            hairColor: genResult.extractedTraits.hairColor || character.physical?.hairColor,
            hairColorHex: genResult.extractedTraits.hairColorHex || character.physical?.hairColorHex,
            hairLength: genResult.extractedTraits.hairLength || character.physical?.hairLength,
            hairStyle: genResult.extractedTraits.hairStyle || character.physical?.hairStyle,
            skinTone: genResult.extractedTraits.skinTone || character.physical?.skinTone,
            skinToneHex: genResult.extractedTraits.skinToneHex || character.physical?.skinToneHex,
          } : character.physical,
          clothing: genResult.extractedClothing ? {
            ...character.clothing,
            structured: {
              upperBody: genResult.extractedClothing.upperBody || undefined,
              lowerBody: genResult.extractedClothing.lowerBody || undefined,
              shoes: genResult.extractedClothing.shoes || undefined,
              fullBody: genResult.extractedClothing.fullBody || undefined,
            },
          } : character.clothing,
        };
      }

      result.success = true;
      onProgress?.('complete', `Avatars saved for ${character.name}`);
      log.success(`✅ Avatars generated and saved for ${character.name}`);

      return result;

    } catch (error) {
      result.error = String(error);
      onProgress?.('error', result.error);
      log.error(`Failed to generate/save avatars for ${character.name}:`, error);
      return result;
    }
  },

  /**
   * Generate avatars for multiple characters in parallel
   * Fetches current data, generates avatars, and saves all updates
   *
   * @param characterIds - Array of character IDs to generate avatars for. If empty, generates for all characters needing avatars.
   * @param options.forceRegenerate - If true, regenerates even if avatars exist
   * @param options.maxConcurrent - Maximum concurrent generations (default: 2)
   * @param options.onProgress - Callback for progress updates
   */
  async generateAvatarsForCharacters(
    characterIds?: number[],
    options?: {
      forceRegenerate?: boolean;
      maxConcurrent?: number;
      onProgress?: (characterId: number, status: string, message: string) => void;
    }
  ): Promise<{
    results: AvatarGenerationResult[];
    successCount: number;
    failCount: number;
    skipCount: number;
  }> {
    const { forceRegenerate = false, maxConcurrent = 2, onProgress } = options || {};

    log.info(`🎨 Starting batch avatar generation...`);

    // Fetch current character data
    const currentData = await characterService.getCharacterData();

    // Determine which characters to process
    let charactersToProcess: Character[];
    if (characterIds && characterIds.length > 0) {
      charactersToProcess = currentData.characters.filter(c => characterIds.includes(c.id));
    } else {
      // All characters that need avatars
      charactersToProcess = currentData.characters.filter(c =>
        forceRegenerate ? !!(c.photos?.original || c.photos?.face) : characterService.needsAvatars(c)
      );
    }

    if (charactersToProcess.length === 0) {
      log.info('No characters need avatar generation');
      return { results: [], successCount: 0, failCount: 0, skipCount: 0 };
    }

    log.info(`Processing ${charactersToProcess.length} characters for avatar generation`);

    const results: AvatarGenerationResult[] = [];
    const updatedCharactersMap = new Map<number, Character>();

    // Process in batches to limit concurrency
    for (let i = 0; i < charactersToProcess.length; i += maxConcurrent) {
      const batch = charactersToProcess.slice(i, i + maxConcurrent);

      const batchPromises = batch.map(async (character) => {
        const result: AvatarGenerationResult = {
          characterId: character.id,
          characterName: character.name,
          success: false,
        };

        try {
          // Check if should skip
          const hasPhoto = !!(character.photos?.original || character.photos?.face || character.photos?.body || character.photos?.bodyNoBg);
          if (!hasPhoto) {
            result.skipped = true;
            result.skipReason = 'No photo available';
            return result;
          }

          if (!forceRegenerate && character.avatars?.winter) {
            result.skipped = true;
            result.skipReason = 'Avatars already exist';
            return result;
          }

          onProgress?.(character.id, 'generating', `Generating avatars for ${character.name}...`);
          log.info(`🎨 Generating avatars for ${character.name}...`);

          // Generate avatars
          const genResult = await characterService.generateClothingAvatars(character);

          if (!genResult.success || !genResult.avatars) {
            result.error = genResult.error || 'Avatar generation failed';
            onProgress?.(character.id, 'error', result.error);
            return result;
          }

          result.avatars = genResult.avatars;
          result.success = true;

          // Store updated character for batch save
          updatedCharactersMap.set(character.id, {
            ...character,
            avatars: genResult.avatars,
          });

          onProgress?.(character.id, 'complete', `Avatars generated for ${character.name}`);
          log.success(`✅ Avatars generated for ${character.name}`);

          return result;

        } catch (error) {
          result.error = String(error);
          onProgress?.(character.id, 'error', result.error);
          log.error(`Failed to generate avatars for ${character.name}:`, error);
          return result;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }

    // Save all updates in one batch
    if (updatedCharactersMap.size > 0) {
      log.info(`💾 Saving ${updatedCharactersMap.size} character avatar updates...`);

      // Fetch fresh data to avoid conflicts
      const freshData = await characterService.getCharacterData();

      const updatedCharacters = freshData.characters.map(c => {
        const updated = updatedCharactersMap.get(c.id);
        return updated || c;
      });

      // NOTE: Avatars are already saved by backend avatar job - this save is just for
      // any other character data that might have changed. Avatars NOT sent.
      await characterService.saveCharacterData({
        ...freshData,
        characters: updatedCharacters,
      });

      log.success(`💾 Saved character data for ${updatedCharactersMap.size} characters`);
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success && !r.skipped).length;
    const skipCount = results.filter(r => r.skipped).length;

    log.info(`Avatar generation complete: ${successCount} success, ${failCount} failed, ${skipCount} skipped`);

    return { results, successCount, failCount, skipCount };
  },

  /**
   * Regenerate avatars for a specific character (clears existing and regenerates)
   * Useful when photo has changed
   */
  async regenerateAvatarsForCharacter(
    characterId: number,
    onProgress?: (status: string, message: string) => void,
    options?: { avatarModel?: string }
  ): Promise<AvatarGenerationResult> {
    log.info(`🔄 Regenerating avatars for character ${characterId}...`);

    // Fetch current data
    const currentData = await characterService.getCharacterData();
    const character = currentData.characters.find(c => c.id === characterId);

    if (!character) {
      return {
        characterId,
        characterName: 'Unknown',
        success: false,
        error: 'Character not found',
      };
    }

    // Clear existing avatars first
    const characterWithClearedAvatars = {
      ...character,
      avatars: { status: 'pending' as const },
    };

    // Generate and save
    return characterService.generateAndSaveAvatarForCharacter(
      characterWithClearedAvatars,
      onProgress ? (status, msg) => onProgress(status, msg) : undefined,
      options
    );
  },
};

export default characterService;
