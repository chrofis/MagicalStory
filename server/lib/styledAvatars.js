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
const { buildHairDescription, getHeadBodyRatio } = require('./storyHelpers');
const { getFacePhoto, getPrimaryPhoto } = require('./characterPhotos');
const { normalizeClothingCategory } = require('./clothingCategories');
const { fetchImageBytes } = require('./r2');

/**
 * Resolve an avatar's bytes for one of the standard categories. After the R2
 * migration `avatars[category]` is null and the bytes live at
 * `avatars[`${category}Url`]` only — calling code that read `avatars.standard`
 * directly used to silently fall through to the raw photo.
 *
 * Returns a `data:image/...;base64,...` data URL or null.
 *
 * @param {Object} avatars - the character's avatars object (char.avatars)
 * @param {string} category - 'standard' | 'winter' | 'summer'
 */
async function resolveAvatarBytes(avatars, category) {
  if (!avatars || !category) return null;
  // Inline data URL — always wins.
  const inline = avatars[category];
  if (typeof inline === 'string' && inline.startsWith('data:image')) return inline;
  if (inline && typeof inline === 'object' && typeof inline.imageData === 'string'
      && inline.imageData.startsWith('data:image')) {
    return inline.imageData;
  }
  // Fallback to R2.
  const url = avatars[`${category}Url`];
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  try {
    const buf = await fetchImageBytes(url);
    if (!buf) return null;
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
               : buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg'
               : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (err) {
    log.warn(`[STYLED AVATARS] resolveAvatarBytes(${category}) R2 fetch failed: ${err.message}`);
    return null;
  }
}

// Quality gate constants for styled avatar evaluation
// MAX_STYLED_AVATAR_RETRIES removed (2026-05-17): the outer retry loop
// was unwound when the redundant outer evaluateAvatarFaceMatch call was
// deleted. The inner generator (generateCharacter2x4Sheet) handles
// best-of-N retries for both passes internally.
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

// In-memory cache for styled avatars, scoped per job to prevent cross-job collisions
// Key: `${scopePrefix}${characterName}_${clothingCategory}_${artStyle}`
// Value: base64 image data (downsized)
const styledAvatarCache = new Map();

// AsyncLocalStorage for per-job cache scoping (supports concurrent jobs)
const { AsyncLocalStorage } = require('async_hooks');
const cacheContext = new AsyncLocalStorage();

/** Get the current cache scope prefix from async context */
function getCacheScope() {
  const scope = cacheContext.getStore();
  return scope ? `${scope}::` : '';
}

// In-progress conversions (Promise-based locking)
// Key: same as cache
// Value: Promise that resolves to the styled avatar
const conversionInProgress = new Map();

// Generation log for developer mode auditing
// Tracks all avatar conversions with inputs, prompts, outputs, timing
let styledAvatarGenerationLog = [];
const MAX_GENERATION_LOG_ENTRIES = 50;

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

  // Age and body proportions — critical for correct child vs adult rendering.
  // Ratio comes from getHeadBodyRatio() in storyHelpers so avatar generation
  // and image evaluation share a single source of truth.
  const age = character?.age ? parseInt(character.age, 10) : null;
  if (age) {
    let ageCategory;
    if (age <= 3) ageCategory = 'toddler';
    else if (age <= 6) ageCategory = 'young child';
    else if (age <= 10) ageCategory = 'child';
    else if (age <= 12) ageCategory = 'preteen';
    else if (age <= 17) ageCategory = 'teenager';
    else ageCategory = 'adult';
    const headToBody = getHeadBodyRatio(age);
    parts.push(`Age: ${age} years old (${ageCategory}) — head-to-body ratio ${headToBody}`);
  }

  // Use detailed hair description from storyHelpers (handles detailedHairAnalysis)
  const hairDesc = buildHairDescription(traits, character?.physicalTraitsSource);
  if (hairDesc) parts.push(`Hair: ${hairDesc}`);

  if (traits.build) parts.push(`Build: ${traits.build}`);
  if (traits.skinTone) parts.push(`Skin tone: ${traits.skinTone}`);
  if (traits.eyeColor) parts.push(`Eye color: ${traits.eyeColor}`);
  if (traits.facialHair && traits.facialHair !== 'none') {
    if (traits.facialHair.toLowerCase() === 'clean-shaven') {
      parts.push(`Facial hair: NO beard, NO mustache, NO stubble — clean-shaven face`);
    } else {
      parts.push(`Facial hair: ${traits.facialHair}`);
    }
  }
  if (traits.glasses && traits.glasses !== 'none') {
    parts.push(`Glasses: ${traits.glasses}`);
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
  // Collapse clothing category to one of 4 canonical buckets BEFORE building
  // the key. Phase 5/6 — costumed subtype keying is gone. One costume per
  // character per story → bare 'costumed' is enough; the subtype lives on
  // clothingRequirements / visualBible.costumes.
  const keyCategory = normalizeClothingCategory(clothingCategory);
  const name = String(characterName || '').trim().toLowerCase();
  return `${getCacheScope()}${name}_${keyCategory}_${artStyle}`;
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
async function convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto = null, clothingDescription = null, clothingCategory = 'standard', addUsage = null, character = null, imageModelOverride = null, { skipQualityEval = false } = {}) {
  const startTime = Date.now();

  // CANONICAL PATH (2026-05-14): styled avatars are 2×4 reference sheets
  // (face×4 + body×4 angles) generated in one Grok edit call with phantom +
  // standard avatar + face photo as references. No more Gemini styled-2×2;
  // the 2×4 IS the styled avatar. Everything below this block is the legacy
  // 2×2 Gemini path, kept for fallback when generateCharacter2x4Sheet throws
  // (e.g. XAI_API_KEY missing).
  try {
    const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
    const adHocChar = {
      name: characterName,
      avatars: { standard: originalAvatar },
      photos: { face: facePhoto || originalAvatar },
    };
    const costumeDescription = clothingDescription
      || (clothingCategory.startsWith('costumed:')
            ? `${clothingCategory.split(':')[1]} costume`
            : clothingCategory === 'costumed'
              ? 'costume'
              : 'standard outfit');
    // ONE call per pass, no outer retry. The inner generator already does
    // best-of-N for both Pass 1 (realistic identity anchor — one Gemini call
    // checks layout + identity-vs-source + costume-match) and Pass 2 (style
    // transfer — one Gemini call checks layout + identity preserved + style
    // applied + costume preserved). The previous outer evaluateAvatarFaceMatch
    // call was a third Gemini eval per attempt that scored the same sheet on
    // partially-overlapping criteria, and an outer retry loop on top of all
    // that. Removed — Pass 1 eval is now the authoritative quality gate.
    log.debug(`🎨 [STYLED AVATAR] ${characterName}/${artStyle}/${clothingCategory} → 2×4 via Grok`);
    const result = await generateCharacter2x4Sheet(adHocChar, {
      clothingCategory,
      costumeDescription,
      artStyle,
      usageTracker: addUsage,
    });
    if (!result?.imageData) {
      throw new Error(`[STYLED AVATAR] 2×4 produced no image for ${characterName}/${clothingCategory}/${artStyle}`);
    }
    const downsizedSheet = await compressImageToJPEG(result.imageData, 85, 1024);

    const usedPhantom = result.refs?.phantom || null;
    const usedStandard = result.refs?.standardAvatar || originalAvatar;
    const usedFace = result.refs?.facePhoto || facePhoto;

    // Map the inner verdict to the dev-panel face/clothing slots so the UI
    // keeps rendering. faceMatchScore = sourceMatch from Pass 1's eval (head
    // cells vs source photo). clothingMatchScore = outfit from Pass 1's eval
    // (costume item-by-item match against REQUESTED_OUTFIT — newly strict per
    // the prompt change in this commit).
    const pass1Verdict = result.passes?.pass1?.finalVerdict;
    const faceMatchScore = pass1Verdict?.sourceMatch?.sourceMatchScore ?? pass1Verdict?.sourceMatchScore ?? null;
    const clothingMatchScore = pass1Verdict?.outfit?.outfitScore ?? pass1Verdict?.outfitScore ?? null;
    const innerFinal = typeof result.finalScore === 'number' ? result.finalScore : 0;
    const passed = (faceMatchScore == null || faceMatchScore >= MIN_FACE_MATCH_SCORE)
                && (clothingMatchScore == null || clothingMatchScore >= MIN_CLOTHING_MATCH_SCORE);

    const logEntry = {
      timestamp: new Date().toISOString(),
      characterName, artStyle, clothingCategory,
      durationMs: Date.now() - startTime,
      success: passed,
      attempt: 1,
      sheetFormat: '2x4',
      prompt: result.prompt || null,
      faceMatchScore,
      clothingMatchScore,
      innerLayoutScore: pass1Verdict?.layout?.layoutScore ?? null,
      innerIdentityScore: pass1Verdict?.identity?.identityScore ?? null,
      innerOutfitScore: pass1Verdict?.outfit?.outfitScore ?? null,
      innerFinalScore: innerFinal,
      combinedScore: innerFinal,
      innerAttemptHistory: result.attemptHistory || null,
      passes: result.passes || null,
      realisticImageData: result.realisticImageData || null,
      faceMatchDetails: pass1Verdict?.sourceMatch?.reason || null,
      clothingMatchReason: pass1Verdict?.outfit?.reason || null,
      inputs: {
        phantom: usedPhantom ? { sizeKB: getImageSizeKB(usedPhantom), imageData: usedPhantom } : null,
        standardAvatar: usedStandard ? { sizeKB: getImageSizeKB(usedStandard), imageData: usedStandard } : null,
        facePhoto: usedFace ? { sizeKB: getImageSizeKB(usedFace), imageData: usedFace } : null,
      },
      output: { sizeKB: getImageSizeKB(downsizedSheet), imageData: downsizedSheet },
      ...(passed ? {} : { warning: `face=${faceMatchScore}/10, clothing=${clothingMatchScore}/10, inner=${innerFinal}/10` }),
    };
    styledAvatarGenerationLog.push(logEntry);
    if (styledAvatarGenerationLog.length > MAX_GENERATION_LOG_ENTRIES) {
      styledAvatarGenerationLog = styledAvatarGenerationLog.slice(-MAX_GENERATION_LOG_ENTRIES);
    }

    if (passed) {
      log.info(`✅ [STYLED AVATAR] ${characterName}/${artStyle}/${clothingCategory} passed (face=${faceMatchScore}/10, clothing=${clothingMatchScore}/10, inner=${innerFinal}/10)`);
    } else {
      log.warn(`⚠️ [STYLED AVATAR] ${characterName}/${artStyle}/${clothingCategory} below threshold (face=${faceMatchScore}, clothing=${clothingMatchScore}, inner=${innerFinal}) — shipping anyway`);
    }
    return downsizedSheet;
  } catch (err) {
    log.error(`[STYLED AVATAR] 2×4 generation threw for ${characterName}/${clothingCategory}/${artStyle}: ${err.message}`);
    throw err;
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
async function getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto = null, clothingDescription = null, addUsage = null, character = null, imageModelOverride = null, { skipQualityEval = false } = {}) {
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
      const styledAvatar = await convertAvatarToStyle(originalAvatar, artStyle, characterName, facePhoto, clothingDescription, clothingCategory, addUsage, character, imageModelOverride, { skipQualityEval });
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
async function prepareStyledAvatars(characters, artStyle, pageRequirements, clothingRequirements = null, addUsage = null, imageModelOverride = null, { skipQualityEval = false } = {}) {
  log.debug(`🎨 [STYLED AVATARS] Preparing styled avatars for ${characters.length} characters in ${artStyle} style`);

  // For realistic style, skip standard/winter/summer style conversion (photos are already realistic)
  // But still generate costumed avatars — costumes need to be drawn on the character
  const isRealistic = artStyle === 'realistic';
  if (isRealistic) {
    log.debug(`🎨 [STYLED AVATARS] Realistic style — skipping style conversion, will only generate costumed avatars if needed`);
  }

  // NOTE: We intentionally do NOT preload existing styled avatars from character data.
  // This ensures covers and pages always use freshly generated styled avatars from
  // the current story's source avatars (standard, winter, summer, costumed).
  // Previously, preloading caused covers to use different styled avatars than pages
  // when the character's saved styledAvatars differed from freshly generated ones.

  // Collect all unique character + clothing combinations needed
  const neededAvatars = new Map(); // key -> { characterName, clothingCategory, originalAvatar, facePhoto }
  // Collect costumed avatars that need on-demand generation (to run in parallel)
  const pendingCostumedGenerations = []; // { charName, char, clothingCategory, cacheKey, costumeType, costumeConfig }

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

      // Skip if already pending costumed generation
      if (pendingCostumedGenerations.some(p => p.cacheKey === cacheKey)) continue;

      // STYLED AVATARS ARE ALWAYS FRESH PER STORY.
      // Earlier code reused styled avatars from char.avatars.styledAvatars when
      // present — but the architecture is "always regenerate per run", and the
      // reuse branches contradicted that. Removed so the only path forward is
      // a fresh conversion through neededAvatars / pendingCostumedGenerations.

      // Get original avatar for this clothing category. After the R2 migration
      // the inline `avatars[cat]` field is null and the bytes live at
      // `avatars[`${cat}Url`]`; resolveAvatarBytes handles both. Without this
      // every styled-avatar conversion silently fell through to the raw photo
      // (getPrimaryPhoto), which is NOT the locked standard avatar — Bug #1.
      const avatars = char.avatars || char.clothingAvatars;
      let originalAvatar = null;

      // Handle costumed clothing — accepts both legacy 'costumed:<sub>' and
      // the new bare 'costumed' (Phase 5). Each story has at most one costume
      // per character, so when we see bare 'costumed' we derive the costume
      // key (= costume.costume slugified) from clothingRequirements.
      // Costumed avatars are GENERATED by generateCharacter2x4Sheet, not
      // converted here. If the avatar doesn't exist, queue it for parallel
      // generation; if no costume config exists, fall back to standard.
      if (clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:')) {
        let charReqs = clothingRequirements?.[charName] || clothingRequirements?.[charName.trim()];
        if (!charReqs && clothingRequirements) {
          const charNameLower = charName.trim().toLowerCase();
          const matchingKey = Object.keys(clothingRequirements).find(k => k.trim().toLowerCase() === charNameLower);
          if (matchingKey) charReqs = clothingRequirements[matchingKey];
        }
        const costumeConfig = charReqs?.costumed;
        const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const colonKey = clothingCategory.startsWith('costumed:') ? clothingCategory.split(':')[1] : null;
        const costumeType = colonKey || slugify(costumeConfig?.costume) || 'default';
        originalAvatar = avatars?.costumed?.[costumeType];
        if (!originalAvatar) {
          if (costumeConfig?.used && costumeConfig?.description) {
            pendingCostumedGenerations.push({ charName, char, clothingCategory, cacheKey, costumeType, costumeConfig });
            continue; // Will be generated in parallel below
          } else {
            log.warn(`⚠️ [STYLED AVATARS] ${charName}: costumed avatar (key=${costumeType}) not found and no costume config, falling back to standard`);
            clothingCategory = 'standard';
          }
        }
      } else {
        // No reuse of styledAvatars[clothingCategory] — always regenerate.
        // Standard / winter / summer — these are R2-migrated, so resolve
        // through the inline-or-R2 helper. Without this `originalAvatar` is
        // null after the migration even when a perfectly good avatar exists
        // in R2, and the pipeline silently uses the raw photo instead.
        originalAvatar = await resolveAvatarBytes(avatars, clothingCategory);
      }

      // Avatars are always strings (clothing stored separately)

      // Fallback chain (only for non-costumed avatars). Standard → raw photo.
      // 'formal' was a legacy clothing category — fully removed Phase 5.
      if (!originalAvatar) {
        originalAvatar = (await resolveAvatarBytes(avatars, 'standard'))
                      || getPrimaryPhoto(char);  // last-resort raw photo
        if (originalAvatar && (await resolveAvatarBytes(avatars, 'standard'))) {
          log.debug(`[STYLED AVATARS] ${charName}: standard avatar resolved from R2 fallback`);
        } else if (originalAvatar) {
          log.warn(`⚠️ [STYLED AVATARS] ${charName}:${clothingCategory} — fell back to raw photo (no usable standard avatar inline OR in R2)`);
        }
      }

      // Get high-resolution face photo for identity preservation
      // Priority: face thumbnail (768px) > original photo
      const facePhoto = getFacePhoto(char);  // Uses canonical photos.* with legacy fallback

      // Log what data is available for debugging
      log.debug(`🎨 [STYLED AVATAR] ${charName}: facePhoto=${facePhoto ? 'yes' : 'no'}, photos.face=${char.photos?.face ? 'yes' : 'no'}, physical=${Object.keys(char.physical || {}).length} keys`);

      // Get clothing description text (for explicit clothing in styled avatar).
      // Priority chain:
      //   1. clothingRequirements[char][category].description — Sonnet's
      //      story-specific FULL final outfit (the new schema, story-unified.txt).
      //      Used verbatim. No concatenation.
      //   2. char.avatars.clothing[category] — the character's stored base
      //      clothing (e.g. Noah's green T-Rex hoodie). Used when no outline
      //      override is present.
      //   3. Legacy signature-only outline → concat with the conflict guard
      //      (drops signature if it names a main garment slot already in the
      //      base, the old Noah "blue zip-up hoodie + green T-Rex hoodie" case).
      let clothingDescription = null;
      if (!clothingCategory.startsWith('costumed:') && clothingCategory !== 'costumed') {
        // Look up the outline's clothingRequirements for this character
        let charReqs = clothingRequirements?.[charName] || clothingRequirements?.[charName.trim()];
        if (!charReqs && clothingRequirements) {
          const charNameLower = charName.trim().toLowerCase();
          const matchingKey = Object.keys(clothingRequirements).find(k => k.trim().toLowerCase() === charNameLower);
          if (matchingKey) {
            charReqs = clothingRequirements[matchingKey];
            log.debug(`🔍 [STYLED AVATARS] ${charName}: found clothingRequirements via case-insensitive match: "${matchingKey}"`);
          }
        }
        const catReqs = charReqs?.[clothingCategory];

        // Priority 1: story-specific full description from Sonnet
        if (catReqs?.description && typeof catReqs.description === 'string' && catReqs.description.trim()) {
          clothingDescription = catReqs.description.trim();
          log.debug(`🔍 [STYLED AVATARS] ${charName}:${clothingCategory} - using story-specific description from clothingRequirements`);
        } else {
          // Priority 2: stored base clothing
          clothingDescription = char.avatars?.clothing?.[clothingCategory] || null;
          // Priority 3: legacy signature concat (backward compat for older outlines)
          let signature = char.avatars?.signatures?.[clothingCategory];
          if (!signature && catReqs?.signature && catReqs.signature !== 'none') {
            signature = catReqs.signature;
          }
          if (signature) {
            const GARMENT_SLOTS = ['hoodie', 'jacket', 'coat', 'sweater', 'shirt',
              't-shirt', 'tshirt', 'top', 'blouse', 'dress', 'skirt', 'trousers',
              'pants', 'shorts', 'jeans', 'shoes', 'sneakers', 'boots', 'sandals'];
            const sigLower = String(signature).toLowerCase();
            const baseLower = String(clothingDescription || '').toLowerCase();
            const conflictingSlot = GARMENT_SLOTS.find(slot =>
              sigLower.includes(slot) && baseLower.includes(slot)
            );
            if (clothingDescription && !conflictingSlot) {
              clothingDescription = `${clothingDescription}\n\nSIGNATURE ITEMS (MUST INCLUDE): ${signature}`;
            } else if (!clothingDescription) {
              clothingDescription = `SIGNATURE ITEMS (MUST INCLUDE): ${signature}`;
            } else if (conflictingSlot) {
              log.warn(`[STYLED AVATARS] ${charName}:${clothingCategory} — dropping legacy signature "${signature}" (conflicts with "${conflictingSlot}" already in clothing).`);
            }
          }
        }
        log.debug(`🔍 [STYLED AVATARS] ${charName}:${clothingCategory} - final clothingDescription: ${clothingDescription ? `${clothingDescription.substring(0, 80)}…` : 'none'}`);
      }

      if (originalAvatar && typeof originalAvatar === 'string' && originalAvatar.startsWith('data:image')) {
        // For realistic style, skip style conversion of standard/winter/summer avatars
        // (they're already realistic photos). Only costumed avatars need generation.
        if (isRealistic && !clothingCategory.startsWith('costumed:') && clothingCategory !== 'costumed') {
          log.debug(`⏭️ [STYLED AVATARS] ${charName}:${clothingCategory} - skipping for realistic style (already a photo)`);
        } else {
          neededAvatars.set(cacheKey, {
            characterName: charName,
            clothingCategory,
            originalAvatar,
            facePhoto,
            clothingDescription,
            character: char  // Pass full character object for physical traits
          });
        }
      } else {
        // Log why we can't convert this avatar - helps debug cache misses later
        const reason = !originalAvatar ? 'no base avatar found' :
                       typeof originalAvatar !== 'string' ? `avatar is ${typeof originalAvatar}, not string` :
                       !originalAvatar.startsWith('data:image') ? 'avatar is not base64 image' : 'unknown';
        log.warn(`⚠️ [STYLED AVATARS] Cannot convert ${charName}:${clothingCategory} to ${artStyle}: ${reason}`);
      }
    }
  }

  // Run ALL avatar generation in parallel: costumed + standard style conversions together
  const allPromises = [];
  const startTime = Date.now();

  // Costumed avatar promises (previously sequential — was the main pipeline bottleneck)
  if (pendingCostumedGenerations.length > 0) {
    log.info(`🎭 [STYLED AVATARS] Generating ${pendingCostumedGenerations.length} costumed + ${neededAvatars.size} standard avatars in PARALLEL...`);
  } else if (neededAvatars.size > 0) {
    log.debug(`🔄 [STYLED AVATARS] Converting ${neededAvatars.size} avatars in parallel...`);
  } else {
    log.debug(`✅ [STYLED AVATARS] All needed avatars already cached`);
    return styledAvatarCache;
  }

  for (const { charName, char, clothingCategory, cacheKey, costumeType, costumeConfig } of pendingCostumedGenerations) {
    // Use the same convertAvatarToStyle path as standard avatars — routes through
    // callGeminiAPIForImage which respects imageModelOverride (Grok, Gemini, etc.)
    const avatars = char.avatars || char.clothingAvatars;
    // Resolve standard avatar via inline OR R2 URL. Post-Phase-4 the inline
    // field is null and the bytes live at standardUrl. Without resolveAvatarBytes
    // the fallback to getPrimaryPhoto() returns the raw bodyNoBg/body photo
    // (modern clothes) which Grok then renders into the costumed scene — and
    // there was no warning, so the failure was invisible.
    let originalAvatar = await resolveAvatarBytes(avatars, 'standard');
    if (!originalAvatar) {
      const fallback = getPrimaryPhoto(char);
      if (fallback) {
        log.error(`❌ [STYLED AVATARS] ${charName}: standard avatar UNRESOLVABLE (avatars.standard=${avatars?.standard ? 'set' : 'null'}, standardUrl=${avatars?.standardUrl ? 'set' : 'null'}) — falling back to raw photo for costumed:${costumeType}. This will leak the raw photo's clothing/background into the costume render.`);
        originalAvatar = fallback;
      }
    }
    const facePhoto = getFacePhoto(char);
    const costumeDescription = costumeConfig.description || `${costumeType} costume`;

    if (originalAvatar && typeof originalAvatar === 'string' && originalAvatar.startsWith('data:image')) {
      allPromises.push(
        getOrCreateStyledAvatar(charName, clothingCategory, artStyle, originalAvatar, facePhoto, costumeDescription, addUsage, char, imageModelOverride, { skipQualityEval })
          .then(styledAvatar => {
            // Store on character object
            if (!char.avatars) char.avatars = {};
            if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
            if (!char.avatars.styledAvatars[artStyle]) char.avatars.styledAvatars[artStyle] = {};
            if (!char.avatars.styledAvatars[artStyle].costumed) char.avatars.styledAvatars[artStyle].costumed = {};
            char.avatars.styledAvatars[artStyle].costumed[costumeType] = styledAvatar;
            // Store costumed clothing description for image prompt use
            if (costumeDescription) {
              if (!char.avatars.clothing) char.avatars.clothing = {};
              if (!char.avatars.clothing.costumed) char.avatars.clothing.costumed = {};
              char.avatars.clothing.costumed[costumeType] = costumeDescription;
            }
            return { type: 'costumed', cacheKey, characterName: charName, clothingCategory, character: char, styledAvatar, costumeType, success: true };
          })
          .catch(error => {
            log.error(`❌ [STYLED AVATARS] Failed costumed ${charName}:${costumeType}: ${error.message}`);
            return { type: 'costumed', charName, char, costumeType, success: false };
          })
      );
    } else {
      log.warn(`⚠️ [STYLED AVATARS] ${charName}: no base avatar for costumed:${costumeType}, skipping`);
    }
  }

  // Standard style conversion promises (run simultaneously with costumed)
  for (const [cacheKey, { characterName, clothingCategory, originalAvatar, facePhoto, clothingDescription, character }] of neededAvatars) {
    allPromises.push(
      getOrCreateStyledAvatar(characterName, clothingCategory, artStyle, originalAvatar, facePhoto, clothingDescription, addUsage, character, imageModelOverride, { skipQualityEval })
        .then(styledAvatar => ({ type: 'standard', cacheKey, characterName, clothingCategory, character, styledAvatar, success: true }))
        .catch(error => {
          log.error(`❌ [STYLED AVATARS] Failed ${cacheKey}: ${error.message}`);
          log.debug(`   Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`);
          return { type: 'standard', cacheKey, success: false };
        })
    );
  }

  const allResults = await Promise.all(allPromises);
  const duration = Date.now() - startTime;

  // Process results
  let costumeSuccess = 0, costumeTotal = 0, standardSuccess = 0, standardTotal = 0;

  for (const result of allResults) {
    if (result.type === 'costumed') {
      costumeTotal++;
      if (result.success) costumeSuccess++;
      // Failed costumed: generate standard fallback (rare — handled after this loop)
    } else {
      standardTotal++;
      if (result.success && result.styledAvatar) {
        standardSuccess++;
        // Store on character object
        const { character, clothingCategory } = result;
        if (character) {
          if (!character.avatars) character.avatars = {};
          if (!character.avatars.styledAvatars) character.avatars.styledAvatars = {};
          if (!character.avatars.styledAvatars[artStyle]) character.avatars.styledAvatars[artStyle] = {};
          if (clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:')) {
            // Phase 5/6: stories have ONE costume per character. The result
            // object carries the original costumeType from the pending
            // generation entry; fall back to slugified costume name from
            // clothingRequirements (passed earlier into pendingCostumedGenerations)
            // when bare 'costumed' arrived. Default key is 'default' so the
            // slot is never lost.
            const costumeType = (clothingCategory.startsWith('costumed:'))
              ? clothingCategory.split(':')[1]
              : (result.costumeType || 'default');
            if (!character.avatars.styledAvatars[artStyle].costumed) character.avatars.styledAvatars[artStyle].costumed = {};
            character.avatars.styledAvatars[artStyle].costumed[costumeType] = result.styledAvatar;
          } else {
            character.avatars.styledAvatars[artStyle][clothingCategory] = result.styledAvatar;
          }
        }
      }
    }
  }

  // Handle failed costumed avatars: generate standard fallback
  const failedCostumed = allResults.filter(r => r.type === 'costumed' && !r.success);
  if (failedCostumed.length > 0) {
    log.warn(`⚠️ [STYLED AVATARS] ${failedCostumed.length} costumed avatars failed, generating standard fallbacks...`);
    const fallbackPromises = [];
    for (const { charName, char } of failedCostumed) {
      if (!char) continue;
      const fallbackKey = getAvatarCacheKey(charName, 'standard', artStyle);
      if (styledAvatarCache.has(fallbackKey)) continue;
      const avatars = char.avatars || char.clothingAvatars;
      // Same resolveAvatarBytes pattern — handles inline + R2 URL. Without it,
      // post-Phase-4 character rows silently fall back to getPrimaryPhoto (raw
      // body photo) and the styled avatar inherits the raw photo's clothing.
      let originalAvatar = await resolveAvatarBytes(avatars, 'standard');
      if (!originalAvatar) {
        const fallback = getPrimaryPhoto(char);
        if (fallback) {
          log.error(`❌ [STYLED AVATARS] ${charName}: standard avatar UNRESOLVABLE (avatars.standard=${avatars?.standard ? 'set' : 'null'}, standardUrl=${avatars?.standardUrl ? 'set' : 'null'}) — falling back to raw photo for standard fallback. Costume failed AND base avatar missing.`);
          originalAvatar = fallback;
        }
      }
      const facePhoto = getFacePhoto(char);
      if (originalAvatar && typeof originalAvatar === 'string' && originalAvatar.startsWith('data:image')) {
        fallbackPromises.push(
          getOrCreateStyledAvatar(charName, 'standard', artStyle, originalAvatar, facePhoto, null, addUsage, char, imageModelOverride)
            .then(styledAvatar => {
              if (char) {
                if (!char.avatars) char.avatars = {};
                if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
                if (!char.avatars.styledAvatars[artStyle]) char.avatars.styledAvatars[artStyle] = {};
                char.avatars.styledAvatars[artStyle].standard = styledAvatar;
              }
              return { success: true };
            })
            .catch(err => {
              log.error(`❌ [STYLED AVATARS] Fallback failed for ${charName}: ${err.message}`);
              return { success: false };
            })
        );
      }
    }
    if (fallbackPromises.length > 0) {
      await Promise.all(fallbackPromises);
    }
  }

  const totalSuccess = costumeSuccess + standardSuccess;
  const totalCount = costumeTotal + standardTotal;
  log.debug(`💾 [STYLED AVATARS] Stored ${totalSuccess}/${totalCount} styled avatars in ${duration}ms (${costumeSuccess} costumed, ${standardSuccess} standard) for ${artStyle}`);

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
  const styledAvatar = styledAvatarCache.get(cacheKey);

  // Safety: if we have no cache scope set, log a WARN — means a code path escaped
  // runInCacheScope(). The write would have had a scope, the read wouldn't,
  // prefixes would differ, and we'd get a spurious miss.
  if (getCacheScope() === '') {
    log.warn(`⚠️ [STYLED-AVATAR] No cache scope set for lookup "${cacheKey}" — code path escaped runInCacheScope()`);
  }

  if (styledAvatar) return styledAvatar;

  // Pre-fallback: caller asked for a bucket we don't have for this character
  // (e.g. story is medieval-only → only `costumed` was generated, but a
  // scene/cover defaulted to `standard`). Substitute another available
  // styled bucket for the same character before falling back to raw photo —
  // a styled avatar in the wrong-but-available bucket is still infinitely
  // better than a raw modern-day photo for a medieval scene (the latter
  // leaks modern clothing into the rendered image).
  //
  // Preference order: costumed > standard > winter > summer (costumed wins
  // because it's the strongest signal for "this is the only outfit this
  // character has in this story").
  const requestedCanonical = normalizeClothingCategory(clothingCategory);
  const fallbackOrder = ['costumed', 'standard', 'winter', 'summer'];
  for (const bucket of fallbackOrder) {
    if (bucket === requestedCanonical) continue;
    const altKey = getAvatarCacheKey(characterName, bucket, artStyle);
    const alt = styledAvatarCache.get(altKey);
    if (alt) {
      log.warn(`🧥 [STYLED-AVATAR] Bucket substitution: ${cacheKey} not in cache → using ${altKey} (only available variant for this character)`);
      return alt;
    }
  }

  // Genuine miss — character has no styled avatar in any bucket.
  log.error(`❌ [STYLED-AVATAR] CACHE MISS — quality will degrade: ${cacheKey} (canonical: ${requestedCanonical}); no alternate bucket available either`);
  return null;
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
 * Run a callback within a cache scope (call at start of each story job).
 * All cache operations inside the callback will be prefixed with this scope,
 * preventing cross-job collisions when multiple jobs run concurrently.
 * Uses AsyncLocalStorage so concurrent jobs each see their own scope.
 * @param {string} scopeId - Unique scope identifier (e.g., jobId)
 * @param {Function} fn - Async function to run within the scope
 * @returns {Promise} Result of fn
 */
function runInCacheScope(scopeId, fn) {
  log.debug(`🔒 [STYLED AVATARS] Running in cache scope: ${scopeId}`);
  return cacheContext.run(scopeId, fn);
}

/**
 * Clear the styled avatar cache for the current scope only.
 * Call this at the end of story generation to free memory.
 */
function clearStyledAvatarCache() {
  const scope = getCacheScope();
  if (scope) {
    // Only clear entries belonging to the current scope
    let cleared = 0;
    for (const key of [...styledAvatarCache.keys()]) {
      if (key.startsWith(scope)) {
        styledAvatarCache.delete(key);
        cleared++;
      }
    }
    for (const key of [...conversionInProgress.keys()]) {
      if (key.startsWith(scope)) {
        conversionInProgress.delete(key);
      }
    }
    log.debug(`🗑️ [STYLED AVATARS] Cleared ${cleared} entries for scope ${scope} (${styledAvatarCache.size} remain)`);
  } else {
    // No scope set — clear everything (backward compat)
    const size = styledAvatarCache.size;
    styledAvatarCache.clear();
    conversionInProgress.clear();
    log.debug(`🗑️ [STYLED AVATARS] Cache cleared (${size} entries)`);
  }
}

/**
 * Get stats about the styled avatar cache
 * @returns {Object} Cache statistics including size
 */
function getStyledAvatarCacheStats() {
  // Count only entries in current scope
  const scope = getCacheScope();
  let scopedSize = 0;
  if (scope) {
    for (const key of styledAvatarCache.keys()) {
      if (key.startsWith(scope)) scopedSize++;
    }
  } else {
    scopedSize = styledAvatarCache.size;
  }
  return {
    size: scopedSize,
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
  const charLower = characterName.trim().toLowerCase();
  const scope = getCacheScope();
  let clearedCount = 0;

  // Clear from in-memory cache for all art styles (within current scope)
  const keysToDelete = [];
  for (const key of styledAvatarCache.keys()) {
    // Key format: scope::charactername_clothingcategory_artstyle
    if (key.startsWith(`${scope}${charLower}_${clothingCategory}_`)) {
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

      // Handle costumed (bare or legacy 'costumed:<type>') — clear ALL nested
      // costumed entries since stories only have one per character.
      if (clothingCategory === 'costumed' || clothingCategory.startsWith('costumed:')) {
        if (styledForStyle.costumed) {
          const keysCleared = Object.keys(styledForStyle.costumed);
          delete styledForStyle.costumed;
          clearedCount += keysCleared.length;
          log.debug(`🗑️ [STYLED AVATARS] Invalidated ${characterName}'s ${artStyle} costumed (${keysCleared.join(',')}) from character data`);
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
    // Don't overwrite a costumed photoUrl. getCharacterPhotoDetails already
    // resolved Noah's `styledAvatars.<style>.costumed.<key>.imageUrl` and set
    // photoType='costumed-<key>'; restyling here would replace the pirate
    // costume with a styled-standard image and silently break the contract
    // "always use the costumed avatar when costumed:<key> is requested".
    if (photo.photoType?.startsWith('costumed-')) {
      return photo;
    }
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
    // Cache miss means quality degradation — one or more characters will render
    // from the raw face photo instead of the styled avatar. Log as ERROR so it
    // surfaces in monitoring.
    log.error(`❌ [STYLED-AVATAR] CACHE MISS batch for ${artStyle}: ${missed.join(', ')} — ${missed.length} character(s) falling back to raw photo`);
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
  // Phase 5/6: collapse all costumed inputs to bare 'costumed'. The subtype is
  // captured separately on clothingRequirements.costumed.costume.
  if (normalized.startsWith('costumed:') || normalized.startsWith('costume:') ||
      normalized.startsWith('costuum:') || normalized.startsWith('kostüm:') ||
      normalized.startsWith('kostum:')) {
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
  const clothingCategories = ['winter', 'standard', 'summer'];
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

  // Costumed entry — Phase 5/6: one costume slot per character, cached at
  // bare `_costumed_` key. Persists under `result.costumed.default` so the
  // exporter caller (which iterates Object.values) sees it.
  const costumedKey = getAvatarCacheKey(characterName, 'costumed', artStyle);
  const costumedValue = styledAvatarCache.get(costumedKey);
  if (costumedValue) {
    if (!result.costumed) result.costumed = {};
    result.costumed.default = costumedValue;
    foundAny = true;
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
  runInCacheScope,
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
