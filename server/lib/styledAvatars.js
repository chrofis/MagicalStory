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
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { buildHairDescription } = require('./storyHelpers');
const { generateStyledCostumedAvatar, evaluateAvatarFaceMatch } = require('../routes/avatars');
const { getFacePhoto, getPrimaryPhoto } = require('./characterPhotos');

// Quality gate constants for styled avatar evaluation
const MAX_STYLED_AVATAR_RETRIES = 2;
const MIN_FACE_MATCH_SCORE = 5;
const MIN_CLOTHING_MATCH_SCORE = 5;

// Art style ID to sample image file mapping
const ART_STYLE_SAMPLES = {
  'watercolor': 'water color style.jpg',
  'concept': 'concept art style.jpg',
  'anime': 'anime style.jpg',
  'pixar': 'pixar art style 2.jpg',
  'cartoon': 'cartoon style.jpg',
  'comic': 'comic book style.jpg',
  'oil': 'oil painting style.jpg',
  'steampunk': 'steampunk style.jpg',
  'cyber': 'cyber punk style.jpg',
  'chibi': 'chibi style.jpg',
  'manga': 'manga style.jpg',
  'pixel': 'pixel style.jpg',
  'lowpoly': 'low poly 3-D style.jpg'
};

// Cache for loaded style sample images (base64)
const styleSampleCache = new Map();

/**
 * Load art style sample image as base64
 * @param {string} artStyle - Art style ID
 * @returns {string|null} Base64 data URL or null if not found
 */
function loadStyleSampleImage(artStyle) {
  // Check cache first
  if (styleSampleCache.has(artStyle)) {
    return styleSampleCache.get(artStyle);
  }

  const filename = ART_STYLE_SAMPLES[artStyle];
  if (!filename) {
    log.debug(`[STYLE SAMPLE] No sample image defined for art style: ${artStyle}`);
    return null;
  }

  const imagePath = path.join(__dirname, '../../images', filename);

  try {
    if (!fs.existsSync(imagePath)) {
      log.warn(`[STYLE SAMPLE] Sample image not found: ${imagePath}`);
      return null;
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    const mimeType = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64}`;

    // Cache it
    styleSampleCache.set(artStyle, dataUrl);
    log.debug(`[STYLE SAMPLE] Loaded and cached sample for ${artStyle} (${Math.round(imageBuffer.length / 1024)}KB)`);

    return dataUrl;
  } catch (error) {
    log.error(`[STYLE SAMPLE] Failed to load sample for ${artStyle}: ${error.message}`);
    return null;
  }
}

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

// Load prompts at module initialization
const ART_STYLE_PROMPTS = loadArtStylePrompts();

/**
 * Build physical traits string for avatar prompt
 * Uses detailed hair analysis from storyHelpers for accurate hair description
 * @param {Object} character - Character object with physical traits
 * @returns {string} Physical traits description or default message
 */
function buildPhysicalTraitsString(character) {
  const traits = character?.physical || {};
  const parts = [];

  // Use detailed hair description from storyHelpers (handles detailedHairAnalysis)
  const hairDesc = buildHairDescription(traits, character?.physicalTraitsSource);
  if (hairDesc) parts.push(`Hair: ${hairDesc}`);

  if (traits.eyeColor) parts.push(`Eye color: ${traits.eyeColor}`);
  if (traits.facialHair && traits.facialHair !== 'none' && traits.facialHair !== 'clean-shaven') {
    parts.push(`Facial hair: ${traits.facialHair}`);
  }
  if (traits.other && traits.other !== 'none') {
    parts.push(`Other features: ${traits.other}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'Match reference photo exactly';
}

/**
 * Generate cache key for styled avatar
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @returns {string}
 */
function getAvatarCacheKey(characterName, clothingCategory, artStyle) {
  return `${characterName.trim().toLowerCase()}_${clothingCategory.trim().toLowerCase()}_${artStyle}`;
}

/**
 * Convert a single avatar to target art style
 * @param {string} originalAvatar - Base64 image data URL (clothing/body reference)
 * @param {string} artStyle - Target art style (pixar, watercolor, etc.)
 * @param {string} characterName - Character name for logging
 * @param {string} facePhoto - High-resolution face photo for identity (optional)
 * @param {string} clothingDescription - Text description of clothing to wear (optional)
 * @param {string} clothingCategory - Clothing category (standard, winter, summer) for logging
 * @param {Function} addUsage - Usage tracking callback (optional)
 * @param {Object} character - Character object with physical traits (optional)
 * @returns {Promise<string>} Styled avatar as base64 data URL (downsized)
 */
async function convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto = null, clothingDescription = null, clothingCategory = 'standard', addUsage = null, character = null) {
  const startTime = Date.now();
  const hasMultipleRefs = facePhoto && facePhoto !== originalAvatar;
  const hasClothing = !!clothingDescription;
  log.debug(`🎨 [STYLED AVATAR] Converting ${characterName} to ${artStyle} style (${hasMultipleRefs ? '2 reference images' : 'single image'}, ${hasClothing ? 'with clothing desc' : 'no clothing desc'})...`);
  if (hasClothing) {
    log.debug(`👕 [STYLED AVATAR] ${characterName} clothing: ${clothingDescription.substring(0, 100)}${clothingDescription.length > 100 ? '...' : ''}`);
  }

  // Get art style prompt from loaded prompts
  // Use character-specific art style (without scene elements like "rainy streets")
  const characterArtStyle = `${artStyle}-character`;
  const artStylePrompt = ART_STYLE_PROMPTS[characterArtStyle] || ART_STYLE_PROMPTS[artStyle] || ART_STYLE_PROMPTS['pixar-character'];
  if (!artStylePrompt) {
    log.error(`[STYLED AVATAR] No art style prompt found for "${artStyle}"`);
    return originalAvatar;
  }
  log.debug(`[STYLED AVATAR] Using art style: ${ART_STYLE_PROMPTS[characterArtStyle] ? characterArtStyle : artStyle}`);

  // Declare outside try so it's accessible in catch error handler
  let styleSample = null;

  try {
    // Build full prompt using the unified styled-costumed-avatar template
    // (same template used by generateStyledAvatarWithSignature in avatars.js)
    // Use clothing description if provided, otherwise fallback to "clothing from reference image"
    const clothingText = clothingDescription || 'the clothing shown in Image 2 (reference avatar)';

    const template = PROMPT_TEMPLATES.styledCostumedAvatar || '';
    let fullPrompt;

    if (template) {
      const physicalTraits = buildPhysicalTraitsString(character);
      log.debug(`🎨 [STYLED AVATAR] ${characterName} physical traits: ${physicalTraits.substring(0, 100)}${physicalTraits.length > 100 ? '...' : ''}`);
      fullPrompt = fillTemplate(template, {
        'ART_STYLE_PROMPT': artStylePrompt,
        'COSTUME_DESCRIPTION': clothingText,
        'COSTUME_TYPE': 'standard outfit',
        'PHYSICAL_TRAITS': physicalTraits
      });
    } else {
      // Fallback if template not loaded
      const physicalTraits = buildPhysicalTraitsString(character);
      fullPrompt = `Convert this person into the following art style: ${artStylePrompt}\n\nThis is ${characterName}. Preserve their identity and all distinguishing features. Wearing: ${clothingText}\n\nPHYSICAL TRAITS TO PRESERVE:\n${physicalTraits}`;
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

    // Image 3: Art style sample (for style reference)
    styleSample = loadStyleSampleImage(artStyle);
    if (styleSample) {
      referencePhotos.push({
        name: 'style_sample',
        photoUrl: styleSample
      });
      // Append style sample instruction to prompt
      fullPrompt += `\n\nImage ${referencePhotos.length} is a STYLE SAMPLE - match this exact art style for the output.`;
      log.debug(`🎨 [STYLED AVATAR] Added style sample as Image ${referencePhotos.length}`);
    }

    // Retry loop: generate image, evaluate face/clothing match, retry if poor quality
    let downsized = null;
    let faceMatchScore = null;
    let clothingMatchScore = null;
    let successAttempt = 1;

    for (let attempt = 1; attempt <= MAX_STYLED_AVATAR_RETRIES; attempt++) {
      // Call image API to convert the avatar
      // Use 'avatar' evaluation type (lightweight, no quality retry)
      const result = await callGeminiAPIForImage(fullPrompt, referencePhotos, null, 'avatar');

      if (!result || !result.imageData || typeof result.imageData !== 'string') {
        log.warn(`⚠️ [STYLED AVATAR] No valid image returned (attempt ${attempt}/${MAX_STYLED_AVATAR_RETRIES})`);
        continue;
      }

      // Track usage if callback provided
      if (addUsage && result.imageUsage) {
        addUsage('gemini_image', result.imageUsage, 'avatar_styled', result.modelId);
      }

      // Downsize the result for efficient storage (512px is enough for reference)
      downsized = await compressImageToJPEG(result.imageData, 85, 512);

      // Evaluate face/clothing match if we have a face photo to compare against
      if (hasMultipleRefs && facePhoto) {
        const evalResult = await evaluateAvatarFaceMatch(facePhoto, downsized, process.env.GEMINI_API_KEY, clothingDescription);
        if (evalResult) {
          faceMatchScore = evalResult.score || null;
          clothingMatchScore = evalResult.clothingMatch?.score || null;

          const faceFail = faceMatchScore != null && faceMatchScore < MIN_FACE_MATCH_SCORE;
          const clothingFail = clothingMatchScore != null && clothingMatchScore < MIN_CLOTHING_MATCH_SCORE;

          if ((faceFail || clothingFail) && attempt < MAX_STYLED_AVATAR_RETRIES) {
            log.warn(`⚠️ [STYLED AVATAR] Quality gate failed for ${characterName} (attempt ${attempt}): face=${faceMatchScore}/10, clothing=${clothingMatchScore}/10 — retrying`);
            downsized = null; // Clear so we retry
            continue;
          }

          if (faceFail || clothingFail) {
            log.warn(`⚠️ [STYLED AVATAR] Quality gate failed for ${characterName} (final attempt ${attempt}): face=${faceMatchScore}/10, clothing=${clothingMatchScore}/10 — accepting`);
          }
        }
      }

      // Accept this result
      successAttempt = attempt;
      break;
    }

    if (!downsized) {
      throw new Error(`All ${MAX_STYLED_AVATAR_RETRIES} attempts failed to produce a valid image`);
    }

    const duration = Date.now() - startTime;
    log.debug(`✅ [STYLED AVATAR] ${characterName} converted to ${artStyle} in ${duration}ms${successAttempt > 1 ? ` (attempt ${successAttempt})` : ''}${faceMatchScore != null ? ` face=${faceMatchScore}/10` : ''}${clothingMatchScore != null ? ` clothing=${clothingMatchScore}/10` : ''}`);

    // Log generation details for developer mode auditing
    styledAvatarGenerationLog.push({
      timestamp: new Date().toISOString(),
      characterName,
      artStyle,
      clothingCategory,
      durationMs: duration,
      success: true,
      faceMatchScore,
      clothingMatchScore,
      attempt: successAttempt,
      inputs: {
        facePhoto: hasMultipleRefs ? {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto),
          imageData: facePhoto // Full image for dev mode display
        } : null,
        originalAvatar: {
          identifier: getImageIdentifier(originalAvatar),
          sizeKB: getImageSizeKB(originalAvatar),
          imageData: originalAvatar // Full image for dev mode display
        },
        styleSample: styleSample ? {
          identifier: getImageIdentifier(styleSample),
          sizeKB: getImageSizeKB(styleSample),
          imageData: styleSample // Full image for dev mode display
        } : null
      },
      prompt: fullPrompt,
      output: {
        identifier: getImageIdentifier(downsized),
        sizeKB: getImageSizeKB(downsized),
        imageData: downsized // Full image for dev mode display
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
      clothingCategory,
      durationMs: Date.now() - startTime,
      success: false,
      error: error.message,
      inputs: {
        facePhoto: hasMultipleRefs ? {
          identifier: getImageIdentifier(facePhoto),
          sizeKB: getImageSizeKB(facePhoto),
          imageData: facePhoto
        } : null,
        originalAvatar: {
          identifier: getImageIdentifier(originalAvatar),
          sizeKB: getImageSizeKB(originalAvatar),
          imageData: originalAvatar
        },
        styleSample: styleSample ? {
          identifier: getImageIdentifier(styleSample),
          sizeKB: getImageSizeKB(styleSample),
          imageData: styleSample
        } : null
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
 * @param {string} clothingDescription - Text description of clothing (optional)
 * @param {Function} addUsage - Usage tracking callback (optional)
 * @param {Object} character - Character object with physical traits (optional)
 * @returns {Promise<string>} Styled avatar as base64 data URL
 */
async function getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto = null, clothingDescription = null, addUsage = null, character = null) {
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
      const styledAvatar = await convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto, clothingDescription, clothingCategory, addUsage, character);
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
async function prepareStyledAvatars(characters, artStyle, pageRequirements, clothingRequirements = null, addUsage = null) {
  log.debug(`🎨 [STYLED AVATARS] Preparing styled avatars for ${characters.length} characters in ${artStyle} style`);

  // Skip for realistic style (no conversion needed)
  if (artStyle === 'realistic') {
    log.debug(`⏭️ [STYLED AVATARS] Skipping conversion for realistic style`);
    return new Map();
  }

  // NOTE: We intentionally do NOT preload existing styled avatars from character data.
  // This ensures covers and pages always use freshly generated styled avatars from
  // the current story's source avatars (standard, winter, summer, costumed).
  // Previously, preloading caused covers to use different styled avatars than pages
  // when the character's saved styledAvatars differed from freshly generated ones.

  // Collect all unique character + clothing combinations needed
  const neededAvatars = new Map(); // key -> { characterName, clothingCategory, originalAvatar, facePhoto }

  for (const requirement of pageRequirements) {
    let { clothingCategory, characterNames } = requirement;

    for (const charName of characterNames || []) {
      // Case-insensitive character lookup with exact match fallback
      const char = characters.find(c => c.name === charName) ||
                   characters.find(c => c.name.toLowerCase() === charName.toLowerCase());
      if (!char) continue;

      const cacheKey = getAvatarCacheKey(charName, clothingCategory, artStyle);

      // Skip if already cached
      if (styledAvatarCache.has(cacheKey)) continue;

      // Skip if already in our list to convert
      if (neededAvatars.has(cacheKey)) continue;

      // For costumed avatars, check if styled version already exists in character data
      // (generateStyledCostumedAvatar creates styled versions directly)
      // NOTE: With fresh avatars per story, styledAvatars is cleared at job start,
      // so these checks should not match. Keeping for defensive coding.
      if (clothingCategory.startsWith('costumed:')) {
        const costumeType = clothingCategory.split(':')[1];
        const existingStyledCostumed = char.avatars?.styledAvatars?.[artStyle]?.costumed;
        if (existingStyledCostumed) {
          // Check for exact match or any costume that starts with this type
          const matchingKey = Object.keys(existingStyledCostumed).find(key =>
            key === costumeType || key.startsWith(costumeType) || costumeType.startsWith(key)
          );
          if (matchingKey && existingStyledCostumed[matchingKey]) {
            // Ensure cache is populated even if setStyledAvatar was missed
            // Extract imageData if legacy object format {imageData, clothing}
            if (!styledAvatarCache.has(cacheKey)) {
              const avatarValue = existingStyledCostumed[matchingKey];
              const avatarString = (typeof avatarValue === 'object' && avatarValue.imageData) ? avatarValue.imageData : avatarValue;
              styledAvatarCache.set(cacheKey, avatarString);
              log.debug(`📥 [STYLED AVATARS] ${charName}:${clothingCategory} - populated cache from character data (costumed)`);
            }
            log.debug(`⏭️ [STYLED AVATARS] Skipping ${charName}:${clothingCategory} - already has styled costumed avatar`);
            continue;
          }
        }
      }

      // Get original avatar for this clothing category
      const avatars = char.avatars || char.clothingAvatars;
      let originalAvatar = null;

      // Handle costumed:pirate format
      // IMPORTANT: Costumed avatars must be GENERATED by generateStyledCostumedAvatar, not converted here
      // If the costumed avatar doesn't exist, skip it - don't fall back to standard
      if (clothingCategory.startsWith('costumed:')) {
        const costumeType = clothingCategory.split(':')[1];
        originalAvatar = avatars?.costumed?.[costumeType];
        // Also check if already styled (generateStyledCostumedAvatar creates styled directly)
        const existingStyled = avatars?.styledAvatars?.[artStyle]?.costumed?.[costumeType];
        if (existingStyled) {
          // Ensure cache is populated even if setStyledAvatar was missed
          // Extract imageData if legacy object format {imageData, clothing}
          if (!styledAvatarCache.has(cacheKey)) {
            const avatarString = (typeof existingStyled === 'object' && existingStyled.imageData) ? existingStyled.imageData : existingStyled;
            styledAvatarCache.set(cacheKey, avatarString);
            log.debug(`📥 [STYLED AVATARS] ${charName}: costumed:${costumeType} - populated cache from character data`);
          }
          log.debug(`⏭️ [STYLED AVATARS] ${charName}: costumed:${costumeType} already styled, skipping`);
          continue;
        }
        if (!originalAvatar) {
          // Costumed avatar doesn't exist - GENERATE it on-demand
          // Look up costume config from clothingRequirements
          let charReqs = clothingRequirements?.[charName] || clothingRequirements?.[charName.trim()];
          if (!charReqs && clothingRequirements) {
            // Fallback: case-insensitive + trimmed lookup
            const charNameLower = charName.trim().toLowerCase();
            const matchingKey = Object.keys(clothingRequirements).find(k => k.trim().toLowerCase() === charNameLower);
            if (matchingKey) charReqs = clothingRequirements[matchingKey];
          }
          const costumeConfig = charReqs?.costumed;

          if (costumeConfig?.used && costumeConfig?.description) {
            log.debug(`🎭 [STYLED AVATARS] ${charName}: generating costumed:${costumeType} on-demand...`);
            let generationSucceeded = false;
            try {
              const result = await generateStyledCostumedAvatar(char, {
                costume: costumeConfig.costume || costumeType,
                description: costumeConfig.description
              }, artStyle);

              if (result.success && result.imageData) {
                // Store in cache
                setStyledAvatar(charName, clothingCategory, artStyle, result.imageData);
                // Store on character object for persistence
                if (!char.avatars) char.avatars = {};
                if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
                if (!char.avatars.styledAvatars[artStyle]) char.avatars.styledAvatars[artStyle] = {};
                if (!char.avatars.styledAvatars[artStyle].costumed) char.avatars.styledAvatars[artStyle].costumed = {};
                char.avatars.styledAvatars[artStyle].costumed[costumeType] = result.imageData;
                // Store clothing description if available
                if (result.clothing) {
                  if (!char.avatars.clothing) char.avatars.clothing = {};
                  if (!char.avatars.clothing.costumed) char.avatars.clothing.costumed = {};
                  char.avatars.clothing.costumed[costumeType] = result.clothing;
                }
                log.debug(`✅ [STYLED AVATARS] ${charName}: costumed:${costumeType}@${artStyle} generated successfully`);
                generationSucceeded = true;
              } else {
                log.warn(`⚠️ [STYLED AVATARS] ${charName}: costumed:${costumeType} generation failed: ${result.error || 'unknown'}, falling back to standard`);
              }
            } catch (err) {
              log.error(`❌ [STYLED AVATARS] ${charName}: costumed:${costumeType} generation error: ${err.message}, falling back to standard`);
            }

            if (generationSucceeded) {
              continue; // Skip adding to neededAvatars - we already have the styled costumed avatar
            }
            // Fall through to add standard avatar to neededAvatars
            clothingCategory = 'standard';
          } else {
            log.warn(`⚠️ [STYLED AVATARS] ${charName}: costumed:${costumeType} not found and no costume config, falling back to standard`);
            clothingCategory = 'standard';
          }
          // Don't continue - let it fall through to neededAvatars with standard avatar
        }
      } else {
        // Check if this category was already generated with signature items
        // (generateStyledAvatarWithSignature creates styled versions directly)
        if (char.avatars?.signatures?.[clothingCategory]) {
          const existingStyled = avatars?.styledAvatars?.[artStyle]?.[clothingCategory];
          if (existingStyled) {
            // Ensure cache is populated even if setStyledAvatar was missed
            // Extract imageData if legacy object format {imageData, clothing}
            if (!styledAvatarCache.has(cacheKey)) {
              const avatarString = (typeof existingStyled === 'object' && existingStyled.imageData) ? existingStyled.imageData : existingStyled;
              styledAvatarCache.set(cacheKey, avatarString);
              log.debug(`📥 [STYLED AVATARS] ${charName}:${clothingCategory} - populated cache from character data (signature avatar)`);
            }
            log.debug(`⏭️ [STYLED AVATARS] ${charName}:${clothingCategory} already styled with signature, skipping`);
            continue;
          }
        }
        originalAvatar = avatars?.[clothingCategory];
      }

      // Avatars are always strings (clothing stored separately)

      // Fallback chain (only for non-costumed avatars)
      if (!originalAvatar) {
        originalAvatar = avatars?.standard ||
                         avatars?.formal ||  // Legacy backwards compat
                         getPrimaryPhoto(char);  // Uses canonical photos.* with legacy fallback
      }

      // Get high-resolution face photo for identity preservation
      // Priority: face thumbnail (768px) > original photo
      const facePhoto = getFacePhoto(char);  // Uses canonical photos.* with legacy fallback

      // Log what data is available for debugging
      log.debug(`🎨 [STYLED AVATAR] ${charName}: facePhoto=${facePhoto ? 'yes' : 'no'}, photos.face=${char.photos?.face ? 'yes' : 'no'}, physical=${Object.keys(char.physical || {}).length} keys`);

      // Get clothing description text (for explicit clothing in styled avatar)
      let clothingDescription = null;
      if (!clothingCategory.startsWith('costumed:')) {
        // Get stored clothing description for this category
        clothingDescription = char.avatars?.clothing?.[clothingCategory];
        // Also check for signature items to include
        // First try char.avatars.signatures, then fallback to clothingRequirements
        let signature = char.avatars?.signatures?.[clothingCategory];

        // Debug: log what's in clothingRequirements for this character
        // Use case-insensitive lookup for character name (Claude might use different casing)
        let charReqs = clothingRequirements?.[charName] || clothingRequirements?.[charName.trim()];
        if (!charReqs && clothingRequirements) {
          // Fallback: case-insensitive + trimmed lookup
          const charNameLower = charName.trim().toLowerCase();
          const matchingKey = Object.keys(clothingRequirements).find(k => k.trim().toLowerCase() === charNameLower);
          if (matchingKey) {
            charReqs = clothingRequirements[matchingKey];
            log.debug(`🔍 [STYLED AVATARS] ${charName}: found clothingRequirements via case-insensitive match: "${matchingKey}"`);
          }
        }
        const catReqs = charReqs?.[clothingCategory];
        log.debug(`🔍 [STYLED AVATARS] ${charName}:${clothingCategory} - charReqs keys: ${charReqs ? Object.keys(charReqs).join(',') : 'none'}, catReqs: ${JSON.stringify(catReqs || 'none')}`);

        if (!signature && catReqs?.signature && catReqs.signature !== 'none') {
          signature = catReqs.signature;
          log.debug(`🔍 [STYLED AVATARS] ${charName}:${clothingCategory} - using signature from clothingRequirements: "${signature}"`);
        }
        log.debug(`🔍 [STYLED AVATARS] ${charName}:${clothingCategory} - clothing: ${clothingDescription ? 'yes' : 'no'}, signature: ${signature ? signature.substring(0, 50) + '...' : 'no'}`);
        if (signature && clothingDescription) {
          clothingDescription = `${clothingDescription}\n\nSIGNATURE ITEMS (MUST INCLUDE): ${signature}`;
        } else if (signature && !clothingDescription) {
          clothingDescription = `SIGNATURE ITEMS (MUST INCLUDE): ${signature}`;
        }
      }

      if (originalAvatar && typeof originalAvatar === 'string' && originalAvatar.startsWith('data:image')) {
        neededAvatars.set(cacheKey, {
          characterName: charName,
          clothingCategory,
          originalAvatar,
          facePhoto,
          clothingDescription,
          character: char  // Pass full character object for physical traits
        });
      } else {
        // Log why we can't convert this avatar - helps debug cache misses later
        const reason = !originalAvatar ? 'no base avatar found' :
                       typeof originalAvatar !== 'string' ? `avatar is ${typeof originalAvatar}, not string` :
                       !originalAvatar.startsWith('data:image') ? 'avatar is not base64 image' : 'unknown';
        log.warn(`⚠️ [STYLED AVATARS] Cannot convert ${charName}:${clothingCategory} to ${artStyle}: ${reason}`);
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
  for (const [cacheKey, { characterName, clothingCategory, originalAvatar, facePhoto, clothingDescription, character }] of neededAvatars) {
    conversionPromises.push(
      getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto, clothingDescription, addUsage, character)
        .then(styledAvatar => ({ cacheKey, styledAvatar, success: true }))
        .catch(error => {
          // Bug #14 fix: Include stack trace for better debugging
          log.error(`❌ [STYLED AVATARS] Failed ${cacheKey}: ${error.message}`);
          log.debug(`   Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`);
          return { cacheKey, success: false };
        })
    );
  }

  const results = await Promise.all(conversionPromises);
  const successCount = results.filter(r => r.success).length;
  const duration = Date.now() - startTime;

  log.debug(`✅ [STYLED AVATARS] Converted ${successCount}/${neededAvatars.size} avatars in ${duration}ms`);

  // Store styled avatars on character objects immediately (not just in cache)
  // This ensures consistency checks can find them later in the pipeline
  for (const result of results) {
    if (!result.success || !result.styledAvatar) continue;

    // Parse the cache key to get character and clothing info
    const { cacheKey } = result;
    const info = neededAvatars.get(cacheKey);
    if (!info?.character) continue;

    const { character, clothingCategory } = info;

    // Initialize styledAvatars structure if not exists
    if (!character.avatars) character.avatars = {};
    if (!character.avatars.styledAvatars) character.avatars.styledAvatars = {};
    if (!character.avatars.styledAvatars[artStyle]) character.avatars.styledAvatars[artStyle] = {};

    // Store the styled avatar
    if (clothingCategory.startsWith('costumed:')) {
      const costumeType = clothingCategory.split(':')[1];
      if (!character.avatars.styledAvatars[artStyle].costumed) {
        character.avatars.styledAvatars[artStyle].costumed = {};
      }
      character.avatars.styledAvatars[artStyle].costumed[costumeType] = result.styledAvatar;
    } else {
      character.avatars.styledAvatars[artStyle][clothingCategory] = result.styledAvatar;
    }
  }

  log.debug(`💾 [STYLED AVATARS] Stored ${successCount} styled avatars on character objects for ${artStyle}`);

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
  let styledAvatar = styledAvatarCache.get(cacheKey);
  if (!styledAvatar && clothingCategory.startsWith('costumed:')) {
    // Prefix match: find any costumed avatar for this character+style
    const prefix = `${characterName.toLowerCase()}_costumed:`;
    const suffix = `_${artStyle}`;
    for (const [key, value] of styledAvatarCache.entries()) {
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        log.debug(`🔄 [STYLED AVATARS] Fuzzy match: wanted "${cacheKey}", found "${key}"`);
        styledAvatar = value;
        break;
      }
    }
  }
  if (!styledAvatar) {
    log.info(`📍 [STYLED AVATARS] Cache miss: ${cacheKey}`);
  }
  return styledAvatar || null;
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
 * Add a styled avatar to cache (for avatars generated elsewhere)
 * Use this when generating styled avatars directly (e.g., with signature items)
 * @param {string} characterName
 * @param {string} clothingCategory
 * @param {string} artStyle
 * @param {string} imageData - Base64 image data
 */
function setStyledAvatar(characterName, clothingCategory, artStyle, imageData) {
  const cacheKey = getAvatarCacheKey(characterName, clothingCategory, artStyle);
  styledAvatarCache.set(cacheKey, imageData);
  log.debug(`📥 [STYLED AVATARS] Added to cache: ${cacheKey}`);
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
 * Get stats about the styled avatar cache
 * @returns {Object} Cache statistics including size
 */
function getStyledAvatarCacheStats() {
  return {
    size: styledAvatarCache.size,
    inProgress: 0 // No longer tracked, kept for backward compatibility with logging
  };
}

/**
 * Invalidate styled avatars for a specific character and clothing category.
 * Call this when a new source avatar is generated to ensure styled versions are regenerated.
 *
 * @param {string} characterName - Character name
 * @param {string} clothingCategory - Clothing category (e.g., 'summer', 'winter', 'costumed:pirate')
 * @param {Object} character - Optional character object to also clear styledAvatars from character data
 */
function invalidateStyledAvatarForCategory(characterName, clothingCategory, character = null) {
  const charLower = characterName.toLowerCase();
  let clearedCount = 0;

  // Clear from in-memory cache for all art styles
  const keysToDelete = [];
  for (const key of styledAvatarCache.keys()) {
    // Key format: charactername_clothingcategory_artstyle
    if (key.startsWith(`${charLower}_${clothingCategory}_`)) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    styledAvatarCache.delete(key);
    clearedCount++;
  }

  // Also clear from character data if provided
  if (character && character.avatars?.styledAvatars) {
    for (const artStyle of Object.keys(character.avatars.styledAvatars)) {
      const styledForStyle = character.avatars.styledAvatars[artStyle];
      if (!styledForStyle) continue;

      // Handle costumed:type format
      if (clothingCategory.startsWith('costumed:')) {
        const costumeType = clothingCategory.split(':')[1];
        if (styledForStyle.costumed && styledForStyle.costumed[costumeType]) {
          delete styledForStyle.costumed[costumeType];
          clearedCount++;
          log.debug(`🗑️ [STYLED AVATARS] Invalidated ${characterName}'s ${artStyle} costumed:${costumeType} from character data`);
        }
      } else if (styledForStyle[clothingCategory]) {
        delete styledForStyle[clothingCategory];
        clearedCount++;
        log.debug(`🗑️ [STYLED AVATARS] Invalidated ${characterName}'s ${artStyle} ${clothingCategory} from character data`);
      }
    }
  }

  if (clearedCount > 0) {
    log.debug(`🗑️ [STYLED AVATARS] Invalidated ${clearedCount} styled avatar(s) for ${characterName}:${clothingCategory}`);
  }

  return clearedCount;
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
  const missed = [];
  const result = characterPhotos.map(photo => {
    const styledAvatar = getStyledAvatar(photo.name, photo.clothingCategory, artStyle);
    if (styledAvatar) {
      appliedCount++;
      // Handle legacy object format {imageData, clothing} if present in cache
      const styledPhotoUrl = (typeof styledAvatar === 'object' && styledAvatar.imageData)
        ? styledAvatar.imageData
        : styledAvatar;
      return {
        ...photo,
        photoUrl: styledPhotoUrl,
        isStyled: true,
        originalPhotoUrl: photo.photoUrl // Keep original for debugging
      };
    }
    // Track cache misses for debugging
    missed.push(`${photo.name}:${photo.clothingCategory}`);
    return photo;
  });

  if (appliedCount > 0) {
    log.debug(`🎨 [STYLED AVATARS] Applied ${appliedCount}/${characterPhotos.length} styled avatars for ${artStyle}`);
  }
  if (missed.length > 0) {
    log.warn(`⚠️ [STYLED AVATARS] Cache miss for ${artStyle}: ${missed.join(', ')} - using fallback avatars`);
  }

  return result;
}

/**
 * Find nearest matching clothing category using fuzzy matching
 * Handles typos like "COSTUUM" → "costumed", "sommer" → "summer", "winer" → "winter"
 *
 * @param {string} raw - Raw clothing value from scene description
 * @returns {string|null} Normalized clothing category or null if no match
 */
function findNearestClothingCategory(raw) {
  if (!raw) return null;
  const normalized = raw.toLowerCase().trim();

  // Valid categories
  const validCategories = ['standard', 'winter', 'summer', 'costumed'];

  // Exact match
  if (validCategories.includes(normalized)) return normalized;

  // Handle costumed:type format (including typos like "costuum:", "costume:", "kostüm:")
  if (normalized.startsWith('costumed:') || normalized.startsWith('costume:') ||
      normalized.startsWith('costuum:') || normalized.startsWith('kostüm:') ||
      normalized.startsWith('kostum:')) {
    // Extract costume type after the colon
    const colonIdx = raw.indexOf(':');
    if (colonIdx > 0) {
      return `costumed:${raw.substring(colonIdx + 1).trim().toLowerCase()}`;
    }
    return 'costumed';
  }

  // Check if it's any variation of "costumed" without colon
  if (normalized.startsWith('costum') || normalized.startsWith('kostüm') ||
      normalized.startsWith('kostum')) {
    return 'costumed';
  }

  // Fuzzy match: prefix matching
  for (const cat of validCategories) {
    if (cat.startsWith(normalized) || normalized.startsWith(cat)) {
      return cat;
    }
  }

  // Simple similarity: find closest match (handles "sommer" → "summer", "winer" → "winter")
  const similarity = (a, b) => {
    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;
    if (longer.length === 0) return 1;
    const matches = [...shorter].filter((c, i) => longer[i] === c).length;
    return matches / longer.length;
  };

  let best = null, bestScore = 0;
  for (const cat of validCategories) {
    const score = similarity(normalized, cat);
    if (score > bestScore && score > 0.5) { // At least 50% character match
      bestScore = score;
      best = cat;
    }
  }

  if (best) {
    log.debug(`[CLOTHING] Fuzzy matched "${raw}" → "${best}" (score: ${bestScore.toFixed(2)})`);
  }

  return best;
}

/**
 * Collect all avatar requirements from scene data
 * Used to prepare all needed avatars before image generation
 *
 * @param {Array} sceneDescriptions - Array of scene descriptions
 * @param {Array} characters - All characters in the story
 * @param {Object} pageClothing - Clothing per page { pageNum: clothingCategory }
 * @param {string} defaultClothing - Default clothing category
 * @param {Object} clothingRequirements - Per-character clothing requirements from outline (optional)
 * @returns {Array<{pageNumber, clothingCategory, characterNames}>}
 */
function collectAvatarRequirements(sceneDescriptions, characters, pageClothing = {}, defaultClothing = 'standard', clothingRequirements = null) {
  const { getCharactersInScene, parseClothingCategory, parseCharacterClothing } = require('./storyHelpers');

  const requirements = [];

  // If we have explicit per-character clothing requirements from outline, use those
  if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
    // Build per-character clothing map: { charNameLower: [clothingCategories] }
    // Use lowercase keys for case-insensitive matching (Claude might use different casing)
    // A character can have MULTIPLE used categories (e.g., standard AND costumed)
    const characterClothingMap = {};
    for (const [charName, reqs] of Object.entries(clothingRequirements)) {
      const keyLower = charName.trim().toLowerCase();
      characterClothingMap[keyLower] = [];
      // Collect ALL categories with used=true
      for (const [category, config] of Object.entries(reqs)) {
        if (config && config.used) {
          if (category === 'costumed' && config.costume) {
            characterClothingMap[keyLower].push(`costumed:${config.costume.toLowerCase()}`);
          } else {
            characterClothingMap[keyLower].push(category);
          }
        }
      }
      // Default to standard if no category is used
      if (characterClothingMap[keyLower].length === 0) {
        characterClothingMap[keyLower] = ['standard'];
      }
    }

    log.debug(`🎨 [AVATAR REQS] Per-character clothing: ${JSON.stringify(characterClothingMap)}`);

    // For each scene, add requirements per character based on their specific clothing
    for (const scene of sceneDescriptions) {
      const pageNum = scene.pageNumber;
      const description = scene.description || '';

      // Get characters in this scene
      const sceneCharacters = getCharactersInScene(description, characters);

      // Add requirement for each character with ALL their clothing categories
      for (const char of sceneCharacters) {
        const clothingCategories = characterClothingMap[char.name.trim().toLowerCase()] || [defaultClothing];
        for (const clothingCategory of clothingCategories) {
          requirements.push({
            pageNumber: pageNum,
            clothingCategory,
            characterNames: [char.name]
          });
        }
      }
    }

    // For covers, each character needs ALL their clothing variations
    for (const char of characters) {
      const clothingCategories = characterClothingMap[char.name.trim().toLowerCase()] || [defaultClothing];
      for (const clothingCategory of clothingCategories) {
        requirements.push({
          pageNumber: 'cover',
          clothingCategory,
          characterNames: [char.name]
        });
      }
    }
  } else {
    // Fallback: infer from page clothing or scene description metadata
    for (const scene of sceneDescriptions) {
      const pageNum = scene.pageNumber;
      const description = scene.description || '';

      // Get characters in this scene
      const sceneCharacters = getCharactersInScene(description, characters);

      // Try to get per-character clothing from scene description metadata first
      const perCharClothing = parseCharacterClothing(description);

      // Get page-level clothing as fallback
      const pageClothingValue = pageClothing[pageNum];
      const pageLevelClothing = (typeof pageClothingValue === 'string' ? pageClothingValue : null) ||
                                 parseClothingCategory(description) ||
                                 defaultClothing;

      // Add requirement for each character with their specific clothing
      for (const char of sceneCharacters) {
        // Priority: per-character from scene metadata > page-level > default
        let clothingCategory = pageLevelClothing;
        let rawClothing = null;

        // Try per-character clothing with case-insensitive lookup
        if (perCharClothing) {
          rawClothing = perCharClothing[char.name];
          if (!rawClothing) {
            // Fallback: case-insensitive lookup
            const charNameLower = char.name.toLowerCase();
            const matchingKey = Object.keys(perCharClothing).find(k => k.toLowerCase() === charNameLower);
            if (matchingKey) {
              rawClothing = perCharClothing[matchingKey];
            }
          }
        }

        // If no per-char clothing found, try pageClothing with case-insensitive lookup
        if (!rawClothing && typeof pageClothingValue === 'object') {
          rawClothing = pageClothingValue[char.name];
          if (!rawClothing) {
            const charNameLower = char.name.toLowerCase();
            const matchingKey = Object.keys(pageClothingValue).find(k => k.toLowerCase() === charNameLower);
            if (matchingKey) {
              rawClothing = pageClothingValue[matchingKey];
            }
          }
        }

        // Normalize clothing category with fuzzy matching
        if (rawClothing) {
          clothingCategory = findNearestClothingCategory(rawClothing) || pageLevelClothing;
        }

        requirements.push({
          pageNumber: pageNum,
          clothingCategory,
          characterNames: [char.name]
        });
      }
    }

    // Add cover requirements for clothing categories used in the story
    const usedClothingCategories = new Set(requirements.map(r => r.clothingCategory));
    usedClothingCategories.add('standard'); // Always include standard as fallback

    const allCharacterNames = characters.map(c => c.name);
    for (const clothing of usedClothingCategories) {
      requirements.push({
        pageNumber: 'cover',
        clothingCategory: clothing,
        characterNames: allCharacterNames
      });
    }
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
  setStyledAvatar,
  hasStyledAvatar,
  clearStyledAvatarCache,
  getStyledAvatarCacheStats,
  invalidateStyledAvatarForCategory,

  // Persistence
  getStyledAvatarsForCharacter,
  exportStyledAvatarsForPersistence,

  // Developer mode auditing
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog,

  // Utility
  getAvatarCacheKey,

  // Loaded prompts (for external use)
  ART_STYLE_PROMPTS
};
