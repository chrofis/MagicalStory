import api from './api';
import type { Character, CharacterAvatars, GeneratedOutfit, AgeCategory } from '@/types/character';
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
  other_features?: string;
  otherFeatures?: string;
  other?: string;  // Glasses, birthmarks, always-present accessories
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
    hairStyle: api.hair_style || api.hairStyle,
    hair: api.hair_color || api.hairColor,  // Legacy: combined hair field
    other: api.other,  // Glasses, birthmarks, always-present accessories
  };

  // Compute ageCategory from API or derive from age
  const ageCategory = (api.age_category || api.ageCategory || getAgeCategory(api.age)) as AgeCategory | undefined;
  // Get apparent age from API (from photo analysis or user override)
  const apparentAge = (api.apparent_age || api.apparentAge) as AgeCategory | undefined;

  return {
    id: api.id,
    name: api.name,
    gender: api.gender as 'male' | 'female' | 'other',
    age: api.age,
    ageCategory,
    apparentAge,

    physical: (physical.height || physical.build || physical.face || physical.eyeColor || physical.hairColor || physical.hairStyle || physical.hair || physical.other) ? physical : undefined,

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

    clothing: api.clothing
      ? { current: api.clothing }
      : undefined,

    generatedOutfits: (api.generated_outfits || api.generatedOutfits) as Record<number, GeneratedOutfit> | undefined,
  };
}

// Convert frontend Character to API format
function mapCharacterToApi(char: Partial<Character>): Record<string, unknown> {
  // Auto-compute ageCategory if not set but age is available
  const ageCategory = char.ageCategory || getAgeCategory(char.age);

  return {
    id: char.id,
    name: char.name,
    gender: char.gender,
    age: char.age,
    age_category: ageCategory,
    apparent_age: char.apparentAge,
    // Physical traits
    height: char.physical?.height,
    build: char.physical?.build,
    eye_color: char.physical?.eyeColor,
    hair_color: char.physical?.hairColor,
    hair_style: char.physical?.hairStyle,
    other_features: char.physical?.face,
    other: char.physical?.other,  // Glasses, birthmarks, always-present accessories
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
    avatars: char.avatars,  // Also send as avatars for backend compatibility
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
// Note: age/gender are NOT extracted - user inputs them
export interface ExtractedTraits {
  build?: string;
  eyeColor?: string;
  hairColor?: string;
  hairLength?: string;
  hairStyle?: string;
  facialHair?: string;
  face?: string;
  other?: string;
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
  async getCharacters(): Promise<Character[]> {
    const response = await api.get<CharacterDataResponse>('/api/characters');
    return (response.characters || []).map(mapCharacterFromApi);
  },

  async getCharacterData(): Promise<CharacterData> {
    const response = await api.get<CharacterDataResponse>('/api/characters');
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

  async saveCharacterData(data: CharacterData): Promise<void> {
    const apiData = {
      characters: data.characters.map(mapCharacterToApi),
      relationships: data.relationships,
      relationshipTexts: data.relationshipTexts,
      customRelationships: data.customRelationships,
      customStrengths: data.customStrengths,
      customWeaknesses: data.customWeaknesses,
      customFears: data.customFears,
    };
    await api.post('/api/characters', apiData);
  },

  async generateClothingAvatars(character: Character): Promise<{
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

      let physicalDescription = `${character.name} is a ${age}-year-old ${genderLabel}`;
      if (character.physical) {
        if (character.physical.hair) physicalDescription += `, ${character.physical.hair}`;
        if (character.physical.face) physicalDescription += `, ${character.physical.face}`;
        if (character.physical.build) physicalDescription += `, ${character.physical.build}`;
        if (character.physical.other) physicalDescription += `, ${character.physical.other}`;
      }

      // Prefer body with no background for best avatar generation results
      const inputPhoto = character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original;
      log.info(`Generating clothing avatars for ${character.name} (id: ${character.id}), using: ${character.photos?.bodyNoBg ? 'bodyNoBg' : character.photos?.body ? 'body' : character.photos?.face ? 'face' : 'original'}`);

      const response = await api.post<{
        success: boolean;
        clothingAvatars?: CharacterAvatars & {
          extractedTraits?: ExtractedTraits;
          structuredClothing?: Record<string, ExtractedClothing>;
          rawEvaluation?: Record<string, unknown>;  // Full unfiltered API response for dev mode
        };
        error?: string;
      }>('/api/generate-clothing-avatars', {
        characterId: character.id,
        facePhoto: inputPhoto,
        physicalDescription,
        name: character.name,
        age: character.age,
        apparentAge: character.apparentAge,
        gender: character.gender,
        build: character.physical?.build,  // Don't send default - server will default to 'athletic'
      });

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
        if (character.physical.other) physicalDescription += `, ${character.physical.other}`;
      }

      // Prefer body with no background for best avatar generation results
      const inputPhoto = character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original;
      log.info(`Generating clothing avatars WITH TRAITS for ${character.name} (id: ${character.id}), using: ${character.photos?.bodyNoBg ? 'bodyNoBg' : character.photos?.body ? 'body' : character.photos?.face ? 'face' : 'original'}`);
      log.info(`Physical traits: ${JSON.stringify(character.physical)}`);

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
        apparentAge: character.apparentAge,
        gender: character.gender,
        build: character.physical?.build || 'average',
        // Pass all physical traits to include in the avatar generation prompt
        physicalTraits: character.physical,
      });

      if (response.success && response.clothingAvatars) {
        log.success(`Clothing avatars WITH TRAITS generated for ${character.name}`);
        return { success: true, avatars: response.clothingAvatars };
      } else {
        log.error(`Failed to generate avatars with traits: ${response.error}`);
        return { success: false, error: response.error };
      }
    } catch (error) {
      log.error('Clothing avatar generation with traits failed:', error);
      return { success: false, error: String(error) };
    }
  },

  async analyzePhoto(imageData: string, language?: string): Promise<{
    success: boolean;
    error?: string;  // Error code (e.g., 'no_face_detected')
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
      }>('/api/analyze-photo', { imageData, language });

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

      // If analysis failed (e.g., no face detected), return error
      if (!response.success) {
        return {
          success: false,
          error: response.error,
        };
      }

      return {
        success: response.success,
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

    // Check if at least one avatar exists
    const hasAnyAvatar = !!(avatars.winter || avatars.standard || avatars.summer || avatars.formal);
    return !hasAnyAvatar;
  },

  /**
   * Generate avatars for a single character and save to storage
   * This is the core function that handles generation + persistence
   * Also populates physical traits and clothing from the evaluation
   */
  async generateAndSaveAvatarForCharacter(
    character: Character,
    onProgress?: (status: 'starting' | 'generating' | 'saving' | 'complete' | 'error', message: string) => void
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
      log.info(`🎨 Generating avatars for ${character.name} (id: ${character.id})`);

      // Generate avatars
      const genResult = await characterService.generateClothingAvatars(character);

      if (!genResult.success || !genResult.avatars) {
        result.error = genResult.error || 'Avatar generation failed';
        onProgress?.('error', result.error);
        return result;
      }

      result.avatars = genResult.avatars;
      result.extractedTraits = genResult.extractedTraits;
      result.extractedClothing = genResult.extractedClothing;

      // Now save back to storage
      onProgress?.('saving', `Saving avatars for ${character.name}...`);

      // Fetch current data to get relationships and other characters
      const currentData = await characterService.getCharacterData();

      // Build updated character with avatars AND extracted traits/clothing
      let updatedCharacter = { ...character, avatars: genResult.avatars };

      // Populate physical traits from extraction (if available)
      // Note: gender and age are NOT extracted - user must input them
      if (genResult.extractedTraits) {
        const traits = genResult.extractedTraits;
        updatedCharacter = {
          ...updatedCharacter,
          // Update physical traits only (not age/gender - user inputs those)
          physical: {
            ...updatedCharacter.physical,
            build: traits.build || updatedCharacter.physical?.build,
            eyeColor: traits.eyeColor || updatedCharacter.physical?.eyeColor,
            hairColor: traits.hairColor || updatedCharacter.physical?.hairColor,
            hairLength: traits.hairLength || updatedCharacter.physical?.hairLength,
            hairStyle: traits.hairStyle || updatedCharacter.physical?.hairStyle,
            facialHair: traits.facialHair || updatedCharacter.physical?.facialHair,
            face: traits.face || updatedCharacter.physical?.face,
            other: traits.other || updatedCharacter.physical?.other,
          },
        };
        log.info(`📋 Populated physical traits from extraction for ${character.name}`);
      }

      // Populate structured clothing from extraction (if available)
      if (genResult.extractedClothing) {
        const clothing = genResult.extractedClothing;
        updatedCharacter = {
          ...updatedCharacter,
          clothing: {
            ...updatedCharacter.clothing,
            structured: {
              upperBody: clothing.upperBody || undefined,
              lowerBody: clothing.lowerBody || undefined,
              shoes: clothing.shoes || undefined,
              fullBody: clothing.fullBody || undefined,
            },
          },
        };
        log.info(`👕 Populated structured clothing from extraction for ${character.name}`);
      }

      // Update the character with new avatars and extracted data
      const updatedCharacters = currentData.characters.map(c =>
        c.id === character.id ? updatedCharacter : c
      );

      // Save back
      await characterService.saveCharacterData({
        ...currentData,
        characters: updatedCharacters,
      });

      result.success = true;
      result.character = updatedCharacter;  // Return the updated character with avatars and extracted data
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

      await characterService.saveCharacterData({
        ...freshData,
        characters: updatedCharacters,
      });

      log.success(`💾 Saved avatar updates for ${updatedCharactersMap.size} characters`);
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
    onProgress?: (status: string, message: string) => void
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
      onProgress ? (status, msg) => onProgress(status, msg) : undefined
    );
  },
};

export default characterService;
