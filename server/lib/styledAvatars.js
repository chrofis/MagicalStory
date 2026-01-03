/**
 * Styled Avatars Module
 *
 * Pre-converts character reference avatars to target art styles (e.g., Pixar)
 * to avoid repeated style conversion during image generation.
 *
 * Features:
 * - On-the-fly conversion with caching
 * - Promise-based locking to prevent duplicate conversions
 * - Parallel conversion for multiple characters
 * - Downsized storage for efficiency
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { compressImageToJPEG, callGeminiAPIForImage } = require('./images');

// In-memory cache for styled avatars
// Key: `${characterName}_${clothingCategory}_${artStyle}`
// Value: base64 image data (downsized)
const styledAvatarCache = new Map();

// In-progress conversions (Promise-based locking)
// Key: same as cache
// Value: Promise that resolves to the styled avatar
const conversionInProgress = new Map();

// Generation log for developer mode auditing
// Tracks all avatar conversions with inputs, prompts, outputs, timing
let styledAvatarGenerationLog = [];

/**
 * Create a short identifier for an image (first 8 chars of base64 data after header)
 * Used for logging without storing full image data
 */
function getImageIdentifier(imageData) {
  if (!imageData || typeof imageData !== 'string') return null;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return base64.substring(0, 12) + '...';
}

/**
 * Get the size of an image in KB from base64
 */
function getImageSizeKB(imageData) {
  if (!imageData || typeof imageData !== 'string') return 0;
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  return Math.round((base64.length * 3 / 4) / 1024);
}

// Load art style prompts from prompts/art-styles.txt
function loadArtStylePrompts() {
  const promptsPath = path.join(__dirname, '../../prompts/art-styles.txt');
  const prompts = {};
  try {
    const content = fs.readFileSync(promptsPath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
          const styleId = trimmed.substring(0, colonIndex).trim();
          const prompt = trimmed.substring(colonIndex + 1).trim();
          prompts[styleId] = prompt;
        }
      }
    }
  } catch (err) {
    log.error(`[STYLED AVATARS] Failed to load art-styles.txt:`, err.message);
  }
  return prompts;
}

// Load styled avatar prompt template from prompts/styled-avatar.txt
function loadStyledAvatarTemplate() {
  const templatePath = path.join(__dirname, '../../prompts/styled-avatar.txt');
  try {
    const content = fs.readFileSync(templatePath, 'utf8');
    // Remove comment lines
    const lines = content.split('\n').filter(line => !line.trim().startsWith('#'));
    const template = lines.join('\n').trim();
    return template;
  } catch (err) {
    log.error(`[STYLED AVATARS] Failed to load styled-avatar.txt:`, err.message);
    return null;
  }
}

// Load prompts at module initialization
const ART_STYLE_PROMPTS = loadArtStylePrompts();
const STYLED_AVATAR_TEMPLATE = loadStyledAvatarTemplate();

/**
 * Generate cache key for styled avatar
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @returns {string}
 */
function getAvatarCacheKey(characterName, clothingCategory, artStyle) {
  return `${characterName.toLowerCase()}_${clothingCategory}_${artStyle}`;
}

/**
 * Convert a single avatar to target art style
 * @param {string} originalAvatar - Base64 image data URL (clothing/body reference)
 * @param {string} artStyle - Target art style (pixar, watercolor, etc.)
 * @param {string} characterName - Character name for logging
 * @param {string} facePhoto - High-resolution face photo for identity (optional)
 * @returns {Promise<string>} Styled avatar as base64 data URL (downsized)
 */
async function convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto = null) {
  const startTime = Date.now();
  const hasMultipleRefs = facePhoto && facePhoto !== originalAvatar;
  log.debug(`🎨 [STYLED AVATAR] Converting ${characterName} to ${artStyle} style (${hasMultipleRefs ? '2 reference images' : 'single image'})...`);

  // Get art style prompt from loaded prompts
  const artStylePrompt = ART_STYLE_PROMPTS[artStyle] || ART_STYLE_PROMPTS.pixar;
  if (!artStylePrompt) {
    log.error(`[STYLED AVATAR] No art style prompt found for "${artStyle}"`);
    return originalAvatar;
  }

  try {
    // Build full prompt using template
    let fullPrompt;
    if (STYLED_AVATAR_TEMPLATE) {
      fullPrompt = STYLED_AVATAR_TEMPLATE
        .replace('{ART_STYLE_PROMPT}', artStylePrompt)
        .replace('{CHARACTER_NAME}', characterName);
    } else {
      // Fallback if template not loaded
      fullPrompt = `Convert this person into the following art style: ${artStylePrompt}\n\nThis is ${characterName}. Preserve their identity and all distinguishing features.`;
    }

    // Build reference photos array
    // Image 1: Face photo (for identity) - if available
    // Image 2: Original avatar (for body/clothing)
    const referencePhotos = [];

    if (hasMultipleRefs) {
      // Pass face photo first (Image 1 - identity reference)
      referencePhotos.push({
        name: `${characterName}_face`,
        photoUrl: facePhoto
      });
    }

    // Pass original avatar (Image 2 - body/clothing reference, or Image 1 if no face photo)
    referencePhotos.push({
      name: hasMultipleRefs ? `${characterName}_avatar` : characterName,
      photoUrl: originalAvatar
    });

    // Call image API to convert the avatar
    // Use 'avatar' evaluation type (lightweight, no quality retry)
    const result = await callGeminiAPIForImage(fullPrompt, referencePhotos, null, 'avatar');

    if (!result || !result.imageData) {
      throw new Error('No image returned from API');
    }

    // Downsize the result for efficient storage (512px is enough for reference)
    const downsized = await compressImageToJPEG(result.imageData, 85, 512);

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED AVATAR] ${characterName} converted to ${artStyle} in ${duration}ms`);

    // Log generation details for developer mode auditing
    styledAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName,
      artStyle,
      durationMs: duration,
      success: true,
      inputs: {
        facePhoto: hasMultipleRefs ? {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto)
        } : null,
        originalAvatar: {
          identifier: getImageIdentifier(originalAvatar),
          sizeKB: getImageSizeKB(originalAvatar)
        }
      },
      prompt: fullPrompt,
      output: {
        identifier: getImageIdentifier(downsized),
        sizeKB: getImageSizeKB(downsized)
      }
    });

    return downsized;
  } catch (error) {
    log.error(`❌ [STYLED AVATAR] Failed to convert ${characterName} to ${artStyle}:`, error.message);

    // Log failed generation
    styledAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName,
      artStyle,
      durationMs: Date.now() - startTime,
      success: false,
      error: error.message,
      inputs: {
        facePhoto: hasMultipleRefs ? {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto)
        } : null,
        originalAvatar: {
          identifier: getImageIdentifier(originalAvatar),
          sizeKB: getImageSizeKB(originalAvatar)
        }
      }
    });

    // Return original avatar as fallback
    return originalAvatar;
  }
}

/**
 * Get or create a styled avatar (with locking to prevent duplicate conversions)
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @param {string} originalAvatar - Base64 image data URL (body/clothing reference)
 * @param {string} facePhoto - High-resolution face photo for identity (optional)
 * @returns {Promise<string>} Styled avatar as base64 data URL
 */
async function getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto = null) {
  const cacheKey = getAvatarCacheKey(characterName, clothingCategory, artStyle);

  // Check cache first
  if (styledAvatarCache.has(cacheKey)) {
    log.debug(`💾 [STYLED AVATAR] Cache HIT: ${cacheKey}`);
    return styledAvatarCache.get(cacheKey);
  }

  // Check if conversion is already in progress
  if (conversionInProgress.has(cacheKey)) {
    log.debug(`⏳ [STYLED AVATAR] Waiting for in-progress conversion: ${cacheKey}`);
    return conversionInProgress.get(cacheKey);
  }

  // Start new conversion
  log.debug(`🆕 [STYLED AVATAR] Starting conversion: ${cacheKey}`);

  const conversionPromise = (async () => {
    try {
      const styledAvatar = await convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto);
      styledAvatarCache.set(cacheKey, styledAvatar);
      return styledAvatar;
    } finally {
      // Clean up in-progress tracker
      conversionInProgress.delete(cacheKey);
    }
  })();

  // Track in-progress conversion
  conversionInProgress.set(cacheKey, conversionPromise);

  return conversionPromise;
}

/**
 * Prepare styled avatars for all characters needed in story generation
 * Converts all needed avatars in parallel before image generation starts
 *
 * @param {Array} characters - Array of character objects with avatars
 * @param {string} artStyle - Target art style
 * @param {Array<{pageNumber, clothingCategory, characterNames}>} pageRequirements - What's needed for each page
 * @returns {Promise<Map>} Map of cacheKey -> styledAvatar
 */
async function prepareStyledAvatars(characters, artStyle, pageRequirements) {
  log.debug(`🎨 [STYLED AVATARS] Preparing styled avatars for ${characters.length} characters in ${artStyle} style`);

  // Skip for realistic style (no conversion needed)
  if (artStyle === 'realistic') {
    log.debug(`⏭️ [STYLED AVATARS] Skipping conversion for realistic style`);
    return new Map();
  }

  // Pre-populate cache with any existing styled avatars from character data
  // This avoids regenerating avatars that were created in previous story generations
  let preloadedCount = 0;
  for (const char of characters) {
    const existingStyled = char.avatars?.styledAvatars?.[artStyle];
    if (existingStyled) {
      for (const [clothingCategory, styledAvatarOrObject] of Object.entries(existingStyled)) {
        // Handle nested costumed structure: { costumed: { pirate: "...", superhero: "..." } }
        if (clothingCategory === 'costumed' && typeof styledAvatarOrObject === 'object' && styledAvatarOrObject !== null) {
          for (const [costumeType, styledAvatar] of Object.entries(styledAvatarOrObject)) {
            if (styledAvatar && typeof styledAvatar === 'string' && styledAvatar.startsWith('data:image')) {
              const cacheKey = getAvatarCacheKey(char.name, `costumed:${costumeType}`, artStyle);
              if (!styledAvatarCache.has(cacheKey)) {
                styledAvatarCache.set(cacheKey, styledAvatar);
                preloadedCount++;
              }
            }
          }
        }
        // Standard categories (winter, summer, standard, formal)
        else if (typeof styledAvatarOrObject === 'string' && styledAvatarOrObject.startsWith('data:image')) {
          const cacheKey = getAvatarCacheKey(char.name, clothingCategory, artStyle);
          if (!styledAvatarCache.has(cacheKey)) {
            styledAvatarCache.set(cacheKey, styledAvatarOrObject);
            preloadedCount++;
          }
        }
      }
    }
  }
  if (preloadedCount > 0) {
    log.debug(`♻️ [STYLED AVATARS] Preloaded ${preloadedCount} existing ${artStyle} avatars from character data`);
  }

  // Collect all unique character + clothing combinations needed
  const neededAvatars = new Map(); // key -> { characterName, clothingCategory, originalAvatar, facePhoto }

  for (const requirement of pageRequirements) {
    const { clothingCategory, characterNames } = requirement;

    for (const charName of characterNames || []) {
      const char = characters.find(c => c.name === charName);
      if (!char) continue;

      const cacheKey = getAvatarCacheKey(charName, clothingCategory, artStyle);

      // Skip if already cached
      if (styledAvatarCache.has(cacheKey)) continue;

      // Skip if already in our list to convert
      if (neededAvatars.has(cacheKey)) continue;

      // Get original avatar for this clothing category
      const avatars = char.avatars || char.clothingAvatars;
      let originalAvatar = null;

      // Handle costumed:pirate format
      if (clothingCategory.startsWith('costumed:')) {
        const costumeType = clothingCategory.split(':')[1];
        originalAvatar = avatars?.costumed?.[costumeType];
      } else {
        originalAvatar = avatars?.[clothingCategory];
      }

      // Handle object avatar format (from dynamic avatar generation: {imageData, clothing})
      if (originalAvatar && typeof originalAvatar === 'object' && originalAvatar.imageData) {
        originalAvatar = originalAvatar.imageData;
      }

      // Fallback chain
      if (!originalAvatar) {
        let fallbackAvatar = avatars?.standard ||
                             avatars?.formal ||  // Legacy backwards compat
                             char.bodyNoBgUrl ||
                             char.photoUrl;
        // Handle object format in fallback too
        if (fallbackAvatar && typeof fallbackAvatar === 'object' && fallbackAvatar.imageData) {
          fallbackAvatar = fallbackAvatar.imageData;
        }
        originalAvatar = fallbackAvatar;
      }

      // Get high-resolution face photo for identity preservation
      // Priority: face thumbnail (768px) > original photo
      const facePhoto = char.photos?.face || char.photos?.original || char.photoUrl || null;

      if (originalAvatar && typeof originalAvatar === 'string' && originalAvatar.startsWith('data:image')) {
        neededAvatars.set(cacheKey, {
          characterName: charName,
          clothingCategory,
          originalAvatar,
          facePhoto
        });
      }
    }
  }

  if (neededAvatars.size === 0) {
    log.debug(`✅ [STYLED AVATARS] All needed avatars already cached`);
    return styledAvatarCache;
  }

  log.debug(`🔄 [STYLED AVATARS] Converting ${neededAvatars.size} avatars in parallel...`);
  const startTime = Date.now();

  // Convert all needed avatars in parallel
  const conversionPromises = [];
  for (const [cacheKey, { characterName, clothingCategory, originalAvatar, facePhoto }] of neededAvatars) {
    conversionPromises.push(
      getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto)
        .then(styledAvatar => ({ cacheKey, styledAvatar, success: true }))
        .catch(error => {
          log.error(`❌ [STYLED AVATARS] Failed ${cacheKey}:`, error.message);
          return { cacheKey, success: false };
        })
    );
  }

  const results = await Promise.all(conversionPromises);
  const successCount = results.filter(r => r.success).length;
  const duration = Date.now() - startTime;

  log.debug(`✅ [STYLED AVATARS] Converted ${successCount}/${neededAvatars.size} avatars in ${duration}ms`);

  return styledAvatarCache;
}

/**
 * Get styled avatar from cache (for use during image generation)
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @returns {string|null} Styled avatar base64 or null if not cached
 */
function getStyledAvatar(characterName, clothingCategory, artStyle) {
  const cacheKey = getAvatarCacheKey(characterName, clothingCategory, artStyle);
  return styledAvatarCache.get(cacheKey) || null;
}

/**
 * Check if a styled avatar exists in cache
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @returns {boolean}
 */
function hasStyledAvatar(characterName, clothingCategory, artStyle) {
  const cacheKey = getAvatarCacheKey(characterName, clothingCategory, artStyle);
  return styledAvatarCache.has(cacheKey);
}

/**
 * Clear the styled avatar cache
 * Call this at the end of story generation to free memory
 */
function clearStyledAvatarCache() {
  const size = styledAvatarCache.size;
  styledAvatarCache.clear();
  conversionInProgress.clear();
  log.debug(`🗑️ [STYLED AVATARS] Cache cleared (${size} entries)`);
}

/**
 * Get cache statistics
 * @returns {{size: number, inProgress: number}}
 */
function getStyledAvatarCacheStats() {
  return {
    size: styledAvatarCache.size,
    inProgress: conversionInProgress.size
  };
}

/**
 * Apply styled avatars to character photo details array
 * Replaces photoUrl with styled version from cache if available
 *
 * @param {Array} characterPhotos - Array from getCharacterPhotoDetails()
 * @param {string} artStyle - Target art style
 * @returns {Array} Same array with photoUrl replaced by styled versions
 */
function applyStyledAvatars(characterPhotos, artStyle) {
  if (!characterPhotos || characterPhotos.length === 0) return characterPhotos;

  // Skip for realistic style
  if (artStyle === 'realistic') return characterPhotos;

  let appliedCount = 0;
  const result = characterPhotos.map(photo => {
    const styledAvatar = getStyledAvatar(photo.name, photo.clothingCategory, artStyle);
    if (styledAvatar) {
      appliedCount++;
      return {
        ...photo,
        photoUrl: styledAvatar,
        isStyled: true,
        originalPhotoUrl: photo.photoUrl // Keep original for debugging
      };
    }
    return photo;
  });

  if (appliedCount > 0) {
    log.debug(`🎨 [STYLED AVATARS] Applied ${appliedCount}/${characterPhotos.length} styled avatars`);
  }

  return result;
}

/**
 * Collect all avatar requirements from scene data
 * Used to prepare all needed avatars before image generation
 *
 * @param {Array} sceneDescriptions - Array of scene descriptions
 * @param {Array} characters - All characters in the story
 * @param {Object} pageClothing - Clothing per page { pageNum: clothingCategory }
 * @param {string} defaultClothing - Default clothing category
 * @returns {Array<{pageNumber, clothingCategory, characterNames}>}
 */
function collectAvatarRequirements(sceneDescriptions, characters, pageClothing = {}, defaultClothing = 'standard') {
  const { getCharactersInScene, parseClothingCategory } = require('./storyHelpers');

  const requirements = [];

  for (const scene of sceneDescriptions) {
    const pageNum = scene.pageNumber;
    const description = scene.description || '';

    // Get characters in this scene
    const sceneCharacters = getCharactersInScene(description, characters);
    const characterNames = sceneCharacters.map(c => c.name);

    // Get clothing for this page
    const clothingCategory = pageClothing[pageNum] || parseClothingCategory(description) || defaultClothing;

    requirements.push({
      pageNumber: pageNum,
      clothingCategory,
      characterNames
    });
  }

  // Add cover requirements ONLY for clothing categories actually used in the story
  // This avoids generating unused styled avatars (e.g., winter avatars for a summer story)
  const usedClothingCategories = new Set(requirements.map(r => r.clothingCategory));
  // Always include 'standard' as fallback for covers
  usedClothingCategories.add('standard');

  const allCharacterNames = characters.map(c => c.name);
  for (const clothing of usedClothingCategories) {
    requirements.push({
      pageNumber: 'cover',
      clothingCategory: clothing,
      characterNames: allCharacterNames
    });
  }

  return requirements;
}

/**
 * Export styled avatars for a character from the cache
 * Used to persist styled avatars to character data after story generation
 *
 * @param {string} characterName
 * @param {string} artStyle
 * @returns {Record<string, string>|null} Map of clothingCategory -> styledAvatar, or null if none found
 */
function getStyledAvatarsForCharacter(characterName, artStyle) {
  const clothingCategories = ['winter', 'standard', 'summer', 'formal'];
  const result = {};
  let foundAny = false;

  // Check standard categories
  for (const category of clothingCategories) {
    const cacheKey = getAvatarCacheKey(characterName, category, artStyle);
    const styledAvatar = styledAvatarCache.get(cacheKey);
    if (styledAvatar) {
      result[category] = styledAvatar;
      foundAny = true;
    }
  }

  // Check for costumed sub-types in cache (pattern: charactername_costumed:type_artstyle)
  const charPrefix = `${characterName.toLowerCase()}_costumed:`;
  const styleSuffix = `_${artStyle}`;
  for (const [key, value] of styledAvatarCache.entries()) {
    if (key.startsWith(charPrefix) && key.endsWith(styleSuffix)) {
      // Extract costume type from key
      const costumeType = key.slice(charPrefix.length, key.length - styleSuffix.length);
      if (costumeType) {
        if (!result.costumed) result.costumed = {};
        result.costumed[costumeType] = value;
        foundAny = true;
      }
    }
  }

  return foundAny ? result : null;
}

/**
 * Export all styled avatars from cache organized by character and art style
 * Used to persist styled avatars to character data after story generation
 *
 * @param {Array} characters - Array of character objects
 * @param {string} artStyle - Target art style
 * @returns {Map<string, Record<string, string>>} Map of characterName -> {clothingCategory: styledAvatar}
 */
function exportStyledAvatarsForPersistence(characters, artStyle) {
  const result = new Map();

  for (const char of characters) {
    const avatars = getStyledAvatarsForCharacter(char.name, artStyle);
    if (avatars) {
      result.set(char.name, avatars);
    }
  }

  return result;
}

/**
 * Get the styled avatar generation log for developer mode auditing
 * @returns {Array} Array of generation log entries
 */
function getStyledAvatarGenerationLog() {
  return [...styledAvatarGenerationLog];
}

/**
 * Clear the styled avatar generation log
 * Call this at the start of a new story generation
 */
function clearStyledAvatarGenerationLog() {
  const count = styledAvatarGenerationLog.length;
  styledAvatarGenerationLog = [];
  log.debug(`🗑️ [STYLED AVATARS] Generation log cleared (${count} entries)`);
}

module.exports = {
  // Core functions
  getOrCreateStyledAvatar,
  prepareStyledAvatars,
  convertAvatarToStyle,

  // Apply styled avatars to photo arrays
  applyStyledAvatars,
  collectAvatarRequirements,

  // Cache access
  getStyledAvatar,
  hasStyledAvatar,
  clearStyledAvatarCache,
  getStyledAvatarCacheStats,

  // Persistence
  getStyledAvatarsForCharacter,
  exportStyledAvatarsForPersistence,

  // Developer mode auditing
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog,

  // Utility
  getAvatarCacheKey,

  // Loaded prompts (for external use)
  ART_STYLE_PROMPTS,
  STYLED_AVATAR_TEMPLATE
};
