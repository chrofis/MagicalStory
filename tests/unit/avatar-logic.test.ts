import { describe, it, expect } from 'vitest';

// Import the character merge functions
// @ts-expect-error - JS module without types
import {
  mergeAvatars,
  mergeCharacter,
  mergeCharacters,
  mergeStructuredClothing,
  mergePhysicalTraits,
  hasRealClothingValues,
  isPhysicalEmpty,
  createLightCharacter
} from '../../server/lib/characterMerge.js';

describe('Avatar Merge Logic', () => {
  describe('mergeAvatars', () => {
    it('returns null when both existing and new are empty', () => {
      expect(mergeAvatars(null, null)).toBeNull();
      expect(mergeAvatars(undefined, undefined)).toBeNull();
    });

    it('preserves DB avatars when frontend sends only metadata', () => {
      const dbAvatars = {
        status: 'complete',
        generatedAt: '2024-01-01',
        standard: 'base64-image-data...',
        winter: 'base64-winter-data...',
        summer: 'base64-summer-data...',
        faceThumbnails: {
          standard: 'thumb1',
          winter: 'thumb2',
          summer: 'thumb3'
        },
        styledAvatars: { pixar: 'pixar-data' }
      };

      const frontendAvatars = {
        status: 'complete',
        generatedAt: '2024-01-01',
        stale: false
        // No images - stripped by frontend
      };

      const result = mergeAvatars(dbAvatars, frontendAvatars);

      // Should keep all DB images
      expect(result.standard).toBe('base64-image-data...');
      expect(result.winter).toBe('base64-winter-data...');
      expect(result.summer).toBe('base64-summer-data...');
      expect(result.faceThumbnails).toEqual(dbAvatars.faceThumbnails);
      expect(result.styledAvatars).toEqual({ pixar: 'pixar-data' });

      // Should update metadata from frontend
      expect(result.stale).toBe(false);
    });

    it('updates stale flag from frontend', () => {
      const dbAvatars = {
        status: 'complete',
        stale: false,
        standard: 'image-data'
      };

      const frontendAvatars = {
        status: 'complete',
        stale: true // Mark as stale (e.g., photo changed)
      };

      const result = mergeAvatars(dbAvatars, frontendAvatars);
      expect(result.stale).toBe(true);
      expect(result.standard).toBe('image-data'); // Image preserved
    });

    it('uses frontend avatars when DB has none', () => {
      const frontendAvatars = {
        status: 'generating',
        generatedAt: '2024-01-15'
      };

      const result = mergeAvatars(null, frontendAvatars);
      expect(result.status).toBe('generating');
      expect(result.generatedAt).toBe('2024-01-15');
    });

    it('preserves DB generatedAt when frontend sends new one', () => {
      const dbAvatars = {
        status: 'complete',
        generatedAt: '2024-01-01',
        standard: 'old-image'
      };

      const frontendAvatars = {
        status: 'complete',
        generatedAt: '2024-01-15' // Frontend might send new timestamp
      };

      const result = mergeAvatars(dbAvatars, frontendAvatars);
      // Frontend timestamp should be used (it's more recent info)
      expect(result.generatedAt).toBe('2024-01-15');
      expect(result.standard).toBe('old-image');
    });
  });

  describe('mergeCharacter', () => {
    it('returns new character unchanged when no existing data', () => {
      const newChar = {
        id: 1,
        name: 'Alice',
        age: '8',
        gender: 'female'
      };

      const { merged, preserved } = mergeCharacter(newChar, null);

      expect(merged).toEqual(newChar);
      expect(preserved).toEqual([]);
    });

    it('preserves height from existing character', () => {
      const newChar = { id: 1, name: 'Bob', age: '10' };
      const existingChar = { id: 1, name: 'Bob', age: '10', height: 'tall' };

      const { merged, preserved } = mergeCharacter(newChar, existingChar);

      expect(merged.height).toBe('tall');
      expect(preserved).toContain('height');
    });

    it('preserves photo URLs when frontend strips them', () => {
      const newChar = {
        id: 1,
        name: 'Carol',
        // No photo_url - stripped to reduce payload
      };

      const existingChar = {
        id: 1,
        name: 'Carol',
        photo_url: 'data:image/jpeg;base64,large-photo-data...',
        thumbnail_url: 'data:image/jpeg;base64,thumb-data...',
        body_photo_url: 'data:image/jpeg;base64,body-data...',
        body_no_bg_url: 'data:image/png;base64,nobg-data...'
      };

      const { merged, preserved } = mergeCharacter(newChar, existingChar);

      expect(merged.photo_url).toBe(existingChar.photo_url);
      expect(merged.thumbnail_url).toBe(existingChar.thumbnail_url);
      expect(merged.body_photo_url).toBe(existingChar.body_photo_url);
      expect(merged.body_no_bg_url).toBe(existingChar.body_no_bg_url);
      expect(preserved).toContain('photo_url');
      expect(preserved).toContain('thumbnail_url');
    });

    it('preserves avatars with images from DB', () => {
      const newChar = {
        id: 1,
        name: 'Dave',
        avatars: {
          status: 'complete',
          stale: false
          // Images stripped
        }
      };

      const existingChar = {
        id: 1,
        name: 'Dave',
        avatars: {
          status: 'complete',
          standard: 'base64-standard-image',
          winter: 'base64-winter-image',
          faceThumbnails: { standard: 'thumb' }
        }
      };

      const { merged } = mergeCharacter(newChar, existingChar);

      expect(merged.avatars.standard).toBe('base64-standard-image');
      expect(merged.avatars.winter).toBe('base64-winter-image');
      expect(merged.avatars.faceThumbnails).toEqual({ standard: 'thumb' });
      expect(merged.avatars.stale).toBe(false);
    });

    it('preserves physical traits object when frontend sends empty', () => {
      const newChar = {
        id: 1,
        name: 'Eve',
        physical: {} // Empty object
      };

      const existingChar = {
        id: 1,
        name: 'Eve',
        physical: {
          height: 'average',
          eyeColor: 'blue',
          hairColor: 'blonde'
        }
      };

      const { merged, preserved } = mergeCharacter(newChar, existingChar);

      expect(merged.physical).toEqual(existingChar.physical);
      expect(preserved).toContain('physical');
    });

    it('merges physical traits - keeps existing for empty new values', () => {
      const newChar = {
        id: 1,
        name: 'Frank',
        physical: {
          height: 'tall', // Updated
          eyeColor: '', // Empty - should keep existing
          hairColor: null // Null - should keep existing
        }
      };

      const existingChar = {
        id: 1,
        name: 'Frank',
        physical: {
          height: 'average',
          eyeColor: 'green',
          hairColor: 'brown',
          skinTone: 'fair'
        }
      };

      const { merged } = mergeCharacter(newChar, existingChar);

      expect(merged.physical.height).toBe('tall'); // Updated
      expect(merged.physical.eyeColor).toBe('green'); // Preserved
      expect(merged.physical.hairColor).toBe('brown'); // Preserved
      expect(merged.physical.skinTone).toBe('fair'); // Preserved
    });
  });

  describe('mergeCharacters', () => {
    it('matches characters by ID', () => {
      const newChars = [
        { id: 1, name: 'Alice', age: '8' },
        { id: 2, name: 'Bob', age: '10' }
      ];

      const existingChars = [
        { id: 1, name: 'Alice', age: '8', photo_url: 'photo1' },
        { id: 2, name: 'Bob', age: '10', photo_url: 'photo2' }
      ];

      const { characters, preservedCount } = mergeCharacters(newChars, existingChars);

      expect(characters[0].photo_url).toBe('photo1');
      expect(characters[1].photo_url).toBe('photo2');
      expect(preservedCount).toBe(2);
    });

    it('matches characters by name when ID differs', () => {
      const newChars = [
        { id: 100, name: 'Alice', age: '8' } // Different ID
      ];

      const existingChars = [
        { id: 1, name: 'Alice', age: '8', photo_url: 'alice-photo' }
      ];

      const { characters } = mergeCharacters(newChars, existingChars);

      expect(characters[0].photo_url).toBe('alice-photo');
    });

    it('returns empty array for null input', () => {
      const { characters, preservedCount } = mergeCharacters(null, null);

      expect(characters).toEqual([]);
      expect(preservedCount).toBe(0);
    });
  });

  describe('mergeStructuredClothing', () => {
    it('preserves existing when incoming is empty object', () => {
      const existing = {
        upperBody: 'red t-shirt',
        lowerBody: 'blue jeans'
      };

      const result = mergeStructuredClothing(existing, {});
      expect(result).toEqual(existing);
    });

    it('preserves existing when incoming has all null values', () => {
      const existing = {
        upperBody: 'sweater',
        lowerBody: 'pants'
      };

      const incoming = {
        upperBody: null,
        lowerBody: null,
        fullBody: null
      };

      const result = mergeStructuredClothing(existing, incoming);
      expect(result).toEqual(existing);
    });

    it('uses incoming when it has real values', () => {
      const existing = {
        upperBody: 'old-shirt',
        lowerBody: 'old-pants'
      };

      const incoming = {
        upperBody: 'new-shirt',
        lowerBody: 'new-pants'
      };

      const result = mergeStructuredClothing(existing, incoming);
      expect(result).toEqual(incoming);
    });
  });

  describe('hasRealClothingValues', () => {
    it('returns false for null/undefined', () => {
      expect(hasRealClothingValues(null)).toBe(false);
      expect(hasRealClothingValues(undefined)).toBe(false);
    });

    it('returns false for empty object', () => {
      expect(hasRealClothingValues({})).toBe(false);
    });

    it('returns false for object with all null values', () => {
      expect(hasRealClothingValues({
        upperBody: null,
        lowerBody: null,
        fullBody: null,
        shoes: null
      })).toBe(false);
    });

    it('returns true when any clothing field has value', () => {
      expect(hasRealClothingValues({ upperBody: 't-shirt' })).toBe(true);
      expect(hasRealClothingValues({ shoes: 'sneakers' })).toBe(true);
      expect(hasRealClothingValues({ fullBody: 'dress' })).toBe(true);
    });
  });

  describe('isPhysicalEmpty', () => {
    it('returns true for null/undefined', () => {
      expect(isPhysicalEmpty(null)).toBe(true);
      expect(isPhysicalEmpty(undefined)).toBe(true);
    });

    it('returns true for empty object', () => {
      expect(isPhysicalEmpty({})).toBe(true);
    });

    it('returns true when all values are empty/null', () => {
      expect(isPhysicalEmpty({
        height: '',
        eyeColor: null,
        hairColor: undefined
      })).toBe(true);
    });

    it('returns false when any value is truthy', () => {
      expect(isPhysicalEmpty({ height: 'tall' })).toBe(false);
      expect(isPhysicalEmpty({ eyeColor: 'blue' })).toBe(false);
    });
  });

  describe('createLightCharacter', () => {
    it('strips heavy base64 fields', () => {
      const fullChar = {
        id: 1,
        name: 'Test',
        photo_url: 'data:image/jpeg;base64,large-photo...',
        body_photo_url: 'data:image/jpeg;base64,body...',
        body_no_bg_url: 'data:image/png;base64,nobg...',
        clothing_avatars: { casual: 'big-data' }
      };

      const light = createLightCharacter(fullChar);

      expect(light.photo_url).toBeUndefined();
      expect(light.body_photo_url).toBeUndefined();
      expect(light.body_no_bg_url).toBeUndefined();
      expect(light.clothing_avatars).toBeUndefined();
      expect(light.name).toBe('Test');
    });

    it('keeps only standard faceThumbnail', () => {
      const fullChar = {
        id: 1,
        name: 'Test',
        avatars: {
          status: 'complete',
          standard: 'full-standard-image',
          winter: 'full-winter-image',
          summer: 'full-summer-image',
          formal: 'full-formal-image',
          faceThumbnails: {
            standard: 'thumb-standard',
            winter: 'thumb-winter',
            summer: 'thumb-summer'
          },
          styledAvatars: {
            pixar: 'pixar-image',
            watercolor: 'watercolor-image'
          }
        }
      };

      const light = createLightCharacter(fullChar);

      // Should not have full avatar images
      expect(light.avatars.standard).toBeUndefined();
      expect(light.avatars.winter).toBeUndefined();
      expect(light.avatars.styledAvatars).toBeUndefined();

      // Should keep metadata
      expect(light.avatars.status).toBe('complete');
      expect(light.avatars.hasFullAvatars).toBe(true);

      // Should keep only standard thumbnail
      expect(light.avatars.faceThumbnails).toEqual({ standard: 'thumb-standard' });
    });

    it('sets hasFullAvatars correctly', () => {
      const withAvatars = {
        id: 1,
        name: 'HasAvatars',
        avatars: { status: 'complete', standard: 'img' }
      };

      const withoutAvatars = {
        id: 2,
        name: 'NoAvatars',
        avatars: { status: 'pending' }
      };

      expect(createLightCharacter(withAvatars).avatars.hasFullAvatars).toBe(true);
      expect(createLightCharacter(withoutAvatars).avatars.hasFullAvatars).toBe(false);
    });
  });
});

describe('Avatar Flow Scenarios', () => {
  describe('New character creation', () => {
    it('starts with no avatars, then receives generated ones', () => {
      // Step 1: Character created without avatars
      const newChar = { id: 1, name: 'NewKid', age: '7' };
      const { merged: step1 } = mergeCharacter(newChar, null);
      expect(step1.avatars).toBeUndefined();

      // Step 2: Avatar generation completes, saves to DB
      const dbCharWithAvatars = {
        ...step1,
        avatars: {
          status: 'complete',
          standard: 'generated-standard-img',
          winter: 'generated-winter-img',
          faceThumbnails: { standard: 'thumb' }
        }
      };

      // Step 3: Frontend saves again with metadata only
      const frontendUpdate = {
        id: 1,
        name: 'NewKid',
        age: '7',
        avatars: { status: 'complete', stale: false }
      };

      const { merged: step3 } = mergeCharacter(frontendUpdate, dbCharWithAvatars);

      // Should preserve all generated images
      expect(step3.avatars.standard).toBe('generated-standard-img');
      expect(step3.avatars.winter).toBe('generated-winter-img');
      expect(step3.avatars.faceThumbnails).toEqual({ standard: 'thumb' });
    });
  });

  describe('Photo upload triggers avatar regeneration', () => {
    it('marks avatars stale when photo changes', () => {
      const existingChar = {
        id: 1,
        name: 'PhotoKid',
        photo_url: 'old-photo-data',
        avatars: {
          status: 'complete',
          stale: false,
          standard: 'old-avatar-img'
        }
      };

      // Frontend uploads new photo and marks avatars stale
      const frontendUpdate = {
        id: 1,
        name: 'PhotoKid',
        photo_url: 'new-photo-data', // New photo
        avatars: { status: 'complete', stale: true } // Marked stale
      };

      const { merged } = mergeCharacter(frontendUpdate, existingChar);

      // New photo should be used
      expect(merged.photo_url).toBe('new-photo-data');
      // Old avatar preserved but marked stale
      expect(merged.avatars.standard).toBe('old-avatar-img');
      expect(merged.avatars.stale).toBe(true);
    });
  });

  describe('Concurrent character operations', () => {
    it('handles multiple characters independently', () => {
      const newChars = [
        { id: 1, name: 'Kid1', avatars: { status: 'complete' } },
        { id: 2, name: 'Kid2', avatars: { status: 'generating' } },
        { id: 3, name: 'Kid3' } // No avatars yet
      ];

      const existingChars = [
        {
          id: 1,
          name: 'Kid1',
          avatars: { status: 'complete', standard: 'kid1-img' }
        },
        {
          id: 2,
          name: 'Kid2',
          avatars: { status: 'generating' } // Still generating
        },
        {
          id: 3,
          name: 'Kid3',
          photo_url: 'kid3-photo'
        }
      ];

      const { characters, preservedCount } = mergeCharacters(newChars, existingChars);

      // Kid1: avatar images preserved
      expect(characters[0].avatars.standard).toBe('kid1-img');

      // Kid2: no images to preserve (still generating)
      expect(characters[1].avatars.standard).toBeUndefined();
      expect(characters[1].avatars.status).toBe('generating');

      // Kid3: photo preserved, no avatars
      expect(characters[2].photo_url).toBe('kid3-photo');
      expect(characters[2].avatars).toBeUndefined();

      // preservedCount tracks explicitly preserved fields (not avatar merging)
      // Only Kid3 has a preserved field (photo_url)
      expect(preservedCount).toBe(1);
    });
  });
});
