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

// Art style prompts for avatar conversion
const ART_STYLE_CONVERSION_PROMPTS = {
  pixar: 'Convert this person into a Pixar 3D animated character style. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a Pixar movie character but be clearly recognizable as the same person. High quality 3D render.',
  watercolor: 'Convert this person into a soft watercolor illustration style. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a beautiful watercolor painting but be clearly recognizable as the same person.',
  'comic-book': 'Convert this person into a comic book illustration style with bold lines and vibrant colors. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a comic book character but be clearly recognizable as the same person.',
  anime: 'Convert this person into an anime/manga illustration style. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like an anime character but be clearly recognizable as the same person.',
  'oil-painting': 'Convert this person into a classical oil painting style with rich textures and warm colors. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a classical portrait but be clearly recognizable as the same person.',
  'colored-pencil': 'Convert this person into a colored pencil sketch illustration style. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a detailed colored pencil drawing but be clearly recognizable as the same person.',
  storybook: 'Convert this person into a classic children\'s storybook illustration style with soft, warm colors. Keep the same pose, clothing, and all physical features (face shape, hair color, hair style, eye color, skin tone, build). The result should look like a storybook character but be clearly recognizable as the same person.',
  realistic: 'Enhance this photo to look like a high-quality professional portrait. Keep the same pose, clothing, and all physical features exactly as shown. Minor enhancement only.',
};

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
 * @param {string} originalAvatar - Base64 image data URL
 * @param {string} artStyle - Target art style (pixar, watercolor, etc.)
 * @param {string} characterName - Character name for logging
 * @returns {Promise<string>} Styled avatar as base64 data URL (downsized)
 */
async function convertAvatarToStyle(originalAvatar, artStyle, characterName) {
  const startTime = Date.now();
  log.debug(`🎨 [STYLED AVATAR] Converting ${characterName} to ${artStyle} style...`);

  // Get conversion prompt for this art style
  const conversionPrompt = ART_STYLE_CONVERSION_PROMPTS[artStyle] || ART_STYLE_CONVERSION_PROMPTS.pixar;

  try {
    // Build prompt with character name for better results
    const fullPrompt = `${conversionPrompt}\n\nThis is ${characterName}. Preserve their identity and all distinguishing features.`;

    // Call image API to convert the avatar
    // We pass the original avatar as a reference photo
    // Use 'avatar' evaluation type (lightweight, no quality retry)
    const result = await callGeminiAPIForImage(fullPrompt, [{
      name: characterName,
      photoUrl: originalAvatar
    }], null, 'avatar');

    if (!result || !result.imageData) {
      throw new Error('No image returned from API');
    }

    // Downsize the result for efficient storage (512px is enough for reference)
    const downsized = await compressImageToJPEG(result.imageData, 85, 512);

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED AVATAR] ${characterName} converted to ${artStyle} in ${duration}ms`);

    return downsized;
  } catch (error) {
    log.error(`❌ [STYLED AVATAR] Failed to convert ${characterName} to ${artStyle}:`, error.message);
    // Return original avatar as fallback
    return originalAvatar;
  }
}

/**
 * Get or create a styled avatar (with locking to prevent duplicate conversions)
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @param {string} originalAvatar - Base64 image data URL
 * @returns {Promise<string>} Styled avatar as base64 data URL
 */
async function getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar) {
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
      const styledAvatar = await convertAvatarToStyle(originalAvatar, artStyle, characterName);
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

  // Collect all unique character + clothing combinations needed
  const neededAvatars = new Map(); // key -> { characterName, clothingCategory, originalAvatar }

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
      const originalAvatar = avatars?.[clothingCategory] ||
                            avatars?.standard ||
                            char.bodyNoBgUrl ||
                            char.photoUrl;

      if (originalAvatar && originalAvatar.startsWith('data:image')) {
        neededAvatars.set(cacheKey, {
          characterName: charName,
          clothingCategory,
          originalAvatar
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
  for (const [cacheKey, { characterName, clothingCategory, originalAvatar }] of neededAvatars) {
    conversionPromises.push(
      getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar)
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

  // Add cover requirements (all characters in various clothing)
  const allCharacterNames = characters.map(c => c.name);
  ['standard', 'winter', 'summer', 'formal'].forEach(clothing => {
    requirements.push({
      pageNumber: 'cover',
      clothingCategory: clothing,
      characterNames: allCharacterNames
    });
  });

  return requirements;
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

  // Utility
  getAvatarCacheKey,

  // Constants (for external use)
  ART_STYLE_CONVERSION_PROMPTS
};
