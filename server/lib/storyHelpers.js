/**
 * Story Helpers Module
 *
 * Common utilities for story generation, prompt building, and text parsing.
 * Used by both processStoryJob and processStorybookJob.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { hashImageData } = require('./images');
const { buildVisualBiblePrompt } = require('./visualBible');
const { OutlineParser, extractCharacterNamesFromScene } = require('./outlineParser');
const { getLanguageNote } = require('./languages');

// ============================================================================
// JSON METADATA EXTRACTION - Parse structured data from scene descriptions
// ============================================================================

/**
 * Strip JSON metadata block from scene description (for image prompts)
 * Removes the ```json ... ``` block so it doesn't go to the image API
 * @param {string} sceneDescription - The scene description text
 * @returns {string} Scene description without JSON metadata block
 */
function stripSceneMetadata(sceneDescription) {
  if (!sceneDescription) return sceneDescription;

  // Remove section header and JSON block: "7. **METADATA (JSON):**\n```json\n...\n```" or just "```json\n...\n```"
  // Also handle variations like "**METADATA:**" or just the JSON block
  let stripped = sceneDescription
    .replace(/\n*\d*\.?\s*\*{0,2}METADATA\s*\(?JSON\)?\*{0,2}:?\s*\n*```json[\s\S]*?```\n*/gi, '\n')
    .replace(/```json[\s\S]*?```\n*/gi, '')
    .trim();

  return stripped;
}

/**
 * Extract JSON metadata block from scene description
 * Looks for ```json ... ``` block containing characters, clothing, objects
 * @param {string} sceneDescription - The scene description text
 * @returns {Object|null} Parsed metadata or null if not found/invalid
 */
function extractSceneMetadata(sceneDescription) {
  if (!sceneDescription) return null;

  // Look for ```json block
  const jsonBlockMatch = sceneDescription.match(/```json\s*([\s\S]*?)```/i);
  if (!jsonBlockMatch || !jsonBlockMatch[1]) {
    log.debug('[METADATA] No JSON block found in scene description');
    return null;
  }

  try {
    const jsonStr = jsonBlockMatch[1].trim();
    const metadata = JSON.parse(jsonStr);

    // Validate expected fields
    if (!metadata.characters || !Array.isArray(metadata.characters)) {
      log.debug('[METADATA] JSON block missing or invalid "characters" array');
      return null;
    }

    log.debug(`[METADATA] Extracted: ${metadata.characters.length} characters, clothing="${metadata.clothing}", ${(metadata.objects || []).length} objects`);
    return {
      characters: metadata.characters || [],
      clothing: metadata.clothing || null,
      objects: metadata.objects || []
    };
  } catch (e) {
    log.debug(`[METADATA] Failed to parse JSON block: ${e.message}`);
    return null;
  }
}

// ============================================================================
// AGE CATEGORY MAPPING - Maps numeric age to category for image generation
// ============================================================================

/**
 * Get age category from numeric age
 * Categories: infant (0-1), toddler (1-2), preschooler (3-4), kindergartner (5-6),
 * young-school-age (7-8), school-age (9-10), preteen (11-12), young-teen (13-14),
 * teenager (15-17), young-adult (18-25), adult (26-39), middle-aged (40-59),
 * senior (60-75), elderly (75+)
 */
function getAgeCategory(age) {
  const numAge = parseInt(age, 10);
  if (isNaN(numAge) || numAge < 0) return null;

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

/**
 * Get human-readable age category label for prompts
 */
function getAgeCategoryLabel(ageCategory) {
  const labels = {
    'infant': 'infant/baby (0-1 years)',
    'toddler': 'toddler (1-2 years)',
    'preschooler': 'preschooler (3-4 years)',
    'kindergartner': 'kindergartner (5-6 years)',
    'young-school-age': 'young school-age child (7-8 years)',
    'school-age': 'school-age child (9-10 years)',
    'preteen': 'preteen (11-12 years)',
    'young-teen': 'young teen (13-14 years)',
    'teenager': 'teenager (15-17 years)',
    'young-adult': 'young adult (18-25 years)',
    'adult': 'adult (26-39 years)',
    'middle-aged': 'middle-aged (40-59 years)',
    'senior': 'senior (60-75 years)',
    'elderly': 'elderly (75+ years)'
  };
  return labels[ageCategory] || ageCategory;
}

// ============================================================================
// TEACHING GUIDES - Loaded from text files for easy editing
// ============================================================================

/**
 * Parse a teaching guide file into a map of id -> guide content
 * Format: [topic-id] followed by content until next [topic-id] or end
 */
function parseTeachingGuideFile(filePath) {
  const guides = new Map();
  try {
    if (!fs.existsSync(filePath)) {
      log.warn(`Teaching guide file not found: ${filePath}`);
      return guides;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    let currentId = null;
    let currentContent = [];

    for (const line of lines) {
      // Check for new section: [topic-id]
      const match = line.match(/^\[([a-z0-9-]+)\]$/);
      if (match) {
        // Save previous section if exists
        if (currentId) {
          guides.set(currentId, currentContent.join('\n').trim());
        }
        currentId = match[1];
        currentContent = [];
      } else if (currentId) {
        // Skip comment lines at start of file
        if (!line.startsWith('#') || currentContent.length > 0) {
          currentContent.push(line);
        }
      }
    }

    // Save last section
    if (currentId) {
      guides.set(currentId, currentContent.join('\n').trim());
    }

    log.debug(`Loaded ${guides.size} teaching guides from ${path.basename(filePath)}`);
  } catch (err) {
    log.error(`Error loading teaching guide file ${filePath}:`, err.message);
  }
  return guides;
}

// Load teaching guides at startup
const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const EDUCATIONAL_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'educational-guides.txt'));
const LIFE_CHALLENGE_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'life-challenge-guides.txt'));

/**
 * Get teaching guide for a specific topic
 * @param {string} category - 'educational' or 'life-challenge'
 * @param {string} topicId - The topic ID (e.g., 'months-year', 'potty-training')
 * @returns {string|null} The teaching guide content or null if not found
 */
function getTeachingGuide(category, topicId) {
  if (!topicId) return null;

  // Normalize the topic ID (handle display names that might be passed)
  const normalizedId = topicId.toLowerCase().replace(/\s+/g, '-');

  if (category === 'educational') {
    return EDUCATIONAL_GUIDES.get(normalizedId) || null;
  } else if (category === 'life-challenge') {
    return LIFE_CHALLENGE_GUIDES.get(normalizedId) || null;
  }
  return null;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Art styles definitions (matches index.html)
 */
const ART_STYLES = {
  pixar: '3D render, Pixar cinematic style, natural eye proportion, subtle expression, highly detailed textures, octane render, volumetric lighting, vibrant colors, smooth shading, family-friendly',
  cartoon: '2D cartoon style, bold black outlines, vibrant flat colors (minimal shading/cel-shading), smooth vector quality, classic Saturday morning animation aesthetic',
  anime: 'Modern digital anime art, high detail, expressive large eyes, dynamic composition, detailed cel-shading, vibrant palette, style of Makoto Shinkai',
  chibi: 'Chibi style, super deformed (SD) proportions, massive head, tiny body, kawaii aesthetic, adorable, smooth illustration, minimalist detail',
  steampunk: 'Steampunk graphic novel illustration, Victorian aesthetic, intricate gears, brass and copper mechanisms, leather textures, sepia/muted color palette, detailed linework',
  comic: 'Classic American comic book art, heavy black ink lines, dynamic composition, visible halftone/Ben-Day dots, vibrant CMYK colors, style of Jack Kirby/Jim Lee',
  manga: 'Traditional manga style, Japanese comic art, intricate detailed linework, black and white/monochrome, atmospheric screentones, dramatic lighting and composition',
  watercolor: 'Traditional watercolor painting, textured paper, delicate color washes (wet-on-wet technique), soft edges, visible artistic brushstrokes, transparent and flowing colors',
  oil: 'Classic oil painting style, visible impasto brushstrokes, rich texture, heavy pigment, chiaroscuro lighting, canvas texture, museum quality art',
  lowpoly: 'Low poly 3D model, isometric perspective, minimalist geometric shapes, vibrant solid colors, clear edges, retro video game aesthetic, style of Monument Valley',
  concept: 'Highly detailed digital concept art, dramatic lighting, epic composition, smooth rendering, focus on mood and atmosphere, wide-angle lens, matte painting aesthetic',
  pixel: '16-bit pixel art style, low resolution, limited color palette, detailed sprite work, retro video game aesthetic, style of Final Fantasy VI',
  cyber: 'Cyberpunk aesthetic, neon reflections, rainy streets, chrome, dense complexity, high contrast, dark atmosphere, volumetric fog, graphic novel illustration'
};

/**
 * Language level definitions - controls text length per page
 */
const LANGUAGE_LEVELS = {
  '1st-grade': {
    description: 'Simple words and very short sentences for early readers',
    wordsPerPageMin: 20,
    wordsPerPageMax: 35,
  },
  'standard': {
    description: 'Age-appropriate vocabulary for elementary school children',
    wordsPerPageMin: 120,
    wordsPerPageMax: 150,
  },
  'advanced': {
    description: 'More complex vocabulary and varied sentence structure for advanced readers',
    wordsPerPageMin: 250,
    wordsPerPageMax: 300,
  }
};

// ============================================================================
// LEVEL HELPERS
// ============================================================================

/**
 * Get reading level text for prompts
 */
function getReadingLevel(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  const pageLength = languageLevel === '1st-grade'
    ? `2-3 sentences per page (approximately ${levelInfo.wordsPerPageMin}-${levelInfo.wordsPerPageMax} words)`
    : `approximately ${levelInfo.wordsPerPageMin}-${levelInfo.wordsPerPageMax} words per page`;
  return `${levelInfo.description}. ${pageLength}`;
}

/**
 * Estimate tokens per page for batch size calculation
 */
function getTokensPerPage(languageLevel) {
  const levelInfo = LANGUAGE_LEVELS[languageLevel] || LANGUAGE_LEVELS['standard'];
  // Use max words, multiply by ~1.3 tokens/word (English average), add 2x safety margin
  const tokensPerPage = Math.ceil(levelInfo.wordsPerPageMax * 1.3 * 2);
  return tokensPerPage;
}

// ============================================================================
// PAGE CALCULATIONS
// ============================================================================

/**
 * Calculate the actual page count for a story
 * Picture book (1st-grade): 1 scene = 1 page (text + image combined)
 * Standard book: 1 scene = 2 pages (text page + image page)
 * @param {Object} storyData - The story data object
 * @param {boolean} includeCoverPages - Whether to add 3 pages for covers (default: true)
 * @returns {number} Total page count
 */
function calculateStoryPageCount(storyData, includeCoverPages = true) {
  const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
  if (sceneCount === 0) return 0;

  // Picture book (1st-grade): 1 scene = 1 page. Standard book: 1 scene = 2 pages
  const isPictureBook = storyData?.languageLevel === '1st-grade';
  const scenePageCount = isPictureBook ? sceneCount : sceneCount * 2;

  // Add 3 pages for front cover, back cover, and initial page (title page)
  return includeCoverPages ? scenePageCount + 3 : scenePageCount;
}

// ============================================================================
// CHARACTER HELPERS
// ============================================================================

/**
 * Detect which characters are mentioned in a scene description
 * Priority: 1) JSON metadata block, 2) Markdown parsing, 3) Text search fallback
 * @param {string} sceneDescription - The scene text
 * @param {Array} characters - Array of character objects (main characters with reference photos)
 * @returns {Array} Characters that appear in this scene
 */
function getCharactersInScene(sceneDescription, characters) {
  if (!sceneDescription || !characters || characters.length === 0) {
    return [];
  }

  // DEBUG: Log available characters for matching
  log.debug(`[CHAR DETECT] Available characters for matching: ${characters.map(c => c.name).join(', ')} (${characters.length} total)`);

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.characters && metadata.characters.length > 0) {
    log.debug(`[CHAR DETECT] Using JSON metadata: ${metadata.characters.join(', ')}`);

    // Match JSON character names to available characters
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      const matched = metadata.characters.some(jsonName => {
        const jsonLower = jsonName.toLowerCase().trim();
        return jsonLower === nameLower ||
               jsonLower === firstName ||
               jsonLower.includes(nameLower) ||
               nameLower.includes(jsonLower) ||
               jsonLower.includes(firstName) ||
               firstName.includes(jsonLower);
      });

      log.debug(`[CHAR DETECT]   - "${char.name}" -> ${matched ? 'MATCHED' : 'NO MATCH'} (JSON)`);
      return matched;
    });

    if (matchedCharacters.length > 0) {
      log.debug(`[CHAR DETECT] Matched ${matchedCharacters.length} characters from JSON: ${matchedCharacters.map(c => c.name).join(', ')}`);
      return matchedCharacters;
    }
  }

  // Step 1: Use robust markdown parser to extract character names
  const parsedNames = extractCharacterNamesFromScene(sceneDescription);

  if (parsedNames.length > 0) {
    log.debug(`[CHAR DETECT] Parsed ${parsedNames.length} character names (markdown): ${parsedNames.join(', ')}`);

    // Match main characters whose names appear in the parsed list
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      const matched = parsedNames.some(parsed =>
        parsed === nameLower ||
        parsed === firstName ||
        parsed.includes(nameLower) ||
        nameLower.includes(parsed) ||
        // Handle partial matches (e.g., "sophie" matches "Sophie Miller")
        parsed.includes(firstName) ||
        firstName.includes(parsed)
      );

      // DEBUG: Log each character match attempt
      log.debug(`[CHAR DETECT]   - "${char.name}" (nameLower="${nameLower}", firstName="${firstName}") -> ${matched ? 'MATCHED' : 'NO MATCH'}`);

      return matched;
    });

    if (matchedCharacters.length > 0) {
      log.debug(`[CHAR DETECT] Matched ${matchedCharacters.length} main characters: ${matchedCharacters.map(c => c.name).join(', ')}`);
      return matchedCharacters;
    }
  }

  // Step 2: Fallback to simple text matching if parser found nothing
  log.debug(`[CHAR DETECT] No structured matches, falling back to text search`);
  const sceneLower = sceneDescription.toLowerCase();

  return characters.filter(char => {
    if (!char.name) return false;
    const nameLower = char.name.toLowerCase();
    const firstName = nameLower.split(' ')[0];
    return sceneLower.includes(nameLower) || sceneLower.includes(firstName);
  });
}

/**
 * Get photo URLs for specific characters based on clothing category
 * Prefers clothing avatar for the category > fallback categories > body with no background > body crop > face photo
 * @param {Array} characters - Array of character objects (filtered to scene)
 * @param {string} clothingCategory - Optional clothing category (winter, summer, formal, standard)
 * @returns {Array} Array of photo URLs for image generation
 */
function getCharacterPhotos(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];

  // Fallback priority for clothing avatars (same as getCharacterPhotoDetails)
  const clothingFallbackOrder = {
    winter: ['standard', 'formal', 'summer'],
    summer: ['standard', 'formal', 'winter'],
    formal: ['standard', 'winter', 'summer'],
    standard: ['formal', 'summer', 'winter']
  };

  return characters
    .map(char => {
      // Support both avatar structures (char.avatars and char.clothingAvatars)
      const avatars = char.avatars || char.clothingAvatars;

      // If clothing category specified and character has clothing avatar for it, use it
      if (clothingCategory && avatars && avatars[clothingCategory]) {
        return avatars[clothingCategory];
      }

      // Try fallback clothing categories before falling back to body photos
      if (clothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[clothingCategory] || ['standard', 'formal', 'summer', 'winter'];
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            log.debug(`[AVATAR FALLBACK] ${char.name}: wanted ${clothingCategory}, using ${fallbackCategory}`);
            return avatars[fallbackCategory];
          }
        }
      }

      // Fall back to body without background > body crop > face photo
      return char.bodyNoBgUrl || char.bodyPhotoUrl || char.photoUrl;
    })
    .filter(url => url); // Remove nulls
}

/**
 * Parse clothing category from scene description
 * Looks for patterns like "Clothing: winter" or "**Clothing:** standard"
 * @param {string} sceneDescription - The scene description text
 * @param {boolean} warnOnInvalid - Log warning if keyword found but no valid value (default: true)
 * @returns {string|null} Clothing category (winter, summer, formal, standard) or null if not found
 */
function parseClothingCategory(sceneDescription, warnOnInvalid = true) {
  if (!sceneDescription) return null;

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.clothing) {
    const validValues = ['winter', 'summer', 'formal', 'standard'];
    const clothingLower = metadata.clothing.toLowerCase();
    if (validValues.includes(clothingLower)) {
      log.debug(`[CLOTHING] Using JSON metadata: "${clothingLower}"`);
      return clothingLower;
    }
  }

  // Fallback: Generic approach - find "Clothing" keyword (in any language) and look for value nearby
  // Handles any markdown: **, *, --, __, ##, etc.

  // Markdown chars that might wrap keywords or values
  const md = '[\\*_\\-#\\s\\.\\d]*';

  // Clothing keywords in multiple languages
  const keywords = '(?:Clothing|Kleidung|Vêtements|Tenue)';

  // Valid clothing values
  const values = '(winter|summer|formal|standard)';

  // Pattern 1: Same line - keyword and value on same line with any markdown/separators
  // Handles: **Clothing:** winter, *Clothing*: **winter**, --Clothing--: winter, ## 4. Clothing: winter
  const sameLineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + values, 'i')
  );
  if (sameLineMatch) {
    return sameLineMatch[1].toLowerCase();
  }

  // Pattern 2: Value on next line - handles any markdown formatting
  // Handles: **Clothing:**\n**winter**, ## Clothing\n*winter*, Clothing:\nwinter
  const multilineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + '\\n' + md + values + md, 'i')
  );
  if (multilineMatch) {
    return multilineMatch[1].toLowerCase();
  }

  // Pattern 3: Fallback - find keyword and look for value within next 100 chars
  const keywordMatch = sceneDescription.match(new RegExp(keywords, 'i'));
  if (keywordMatch) {
    const startIndex = keywordMatch.index;
    const nearbyText = sceneDescription.substring(startIndex, startIndex + 100);
    const valueMatch = nearbyText.match(/\b(winter|summer|formal|standard)\b/i);
    if (valueMatch) {
      return valueMatch[1].toLowerCase();
    }

    // Found keyword but no valid value - log warning
    if (warnOnInvalid) {
      // Extract what value was actually there (first word after colon)
      const invalidValueMatch = nearbyText.match(/:\s*\*{0,2}(\w+)/i);
      const invalidValue = invalidValueMatch ? invalidValueMatch[1] : 'unknown';
      log.warn(`[CLOTHING] Invalid clothing value "${invalidValue}" found, defaulting to standard. Valid values: winter, summer, formal, standard`);
    }
  }

  return null;
}

/**
 * Get detailed photo info for characters (for dev mode display)
 * @param {Array} characters - Array of character objects
 * @param {string} clothingCategory - Optional clothing category to show which avatar is used
 * @returns {Array} Array of objects with character name and photo type used
 */
function getCharacterPhotoDetails(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];

  // Fallback priority for clothing avatars when exact match not found
  const clothingFallbackOrder = {
    winter: ['standard', 'formal', 'summer'],
    summer: ['standard', 'formal', 'winter'],
    formal: ['standard', 'winter', 'summer'],
    standard: ['formal', 'summer', 'winter']
  };

  return characters
    .map(char => {
      let photoType = 'none';
      let photoUrl = null;

      // Support both new structure (char.avatars, char.photos) and legacy (char.clothingAvatars, char.bodyNoBgUrl, etc.)
      const avatars = char.avatars || char.clothingAvatars;
      const photos = char.photos || {};

      let clothingDescription = null;
      let usedClothingCategory = null;

      // Check for exact clothing avatar first
      if (clothingCategory && avatars && avatars[clothingCategory]) {
        photoType = `clothing-${clothingCategory}`;
        photoUrl = avatars[clothingCategory];
        usedClothingCategory = clothingCategory;
        // Get extracted clothing description for this avatar
        if (avatars.clothing && avatars.clothing[clothingCategory]) {
          clothingDescription = avatars.clothing[clothingCategory];
        }
      }
      // Try fallback clothing avatars before falling back to body photo
      else if (clothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[clothingCategory] || ['standard', 'formal', 'summer', 'winter'];
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            photoType = `clothing-${fallbackCategory}`;
            photoUrl = avatars[fallbackCategory];
            usedClothingCategory = fallbackCategory;
            // Get extracted clothing description for fallback avatar
            if (avatars.clothing && avatars.clothing[fallbackCategory]) {
              clothingDescription = avatars.clothing[fallbackCategory];
            }
            log.debug(`[AVATAR FALLBACK] ${char.name}: wanted ${clothingCategory}, using ${fallbackCategory}`);
            break;
          }
        }
      }

      // If still no avatar, fall back to body photos
      if (!photoUrl) {
        if (photos.bodyNoBg || char.bodyNoBgUrl) {
          photoType = 'bodyNoBg';
          photoUrl = photos.bodyNoBg || char.bodyNoBgUrl;
        } else if (photos.body || char.bodyPhotoUrl) {
          photoType = 'body';
          photoUrl = photos.body || char.bodyPhotoUrl;
        } else if (photos.face || photos.original || char.photoUrl) {
          photoType = 'face';
          photoUrl = photos.face || photos.original || char.photoUrl;
        }
      }

      return {
        name: char.name,
        id: char.id,
        photoType,
        photoUrl,
        photoHash: hashImageData(photoUrl),  // For dev mode verification
        clothingCategory: usedClothingCategory || clothingCategory || null,
        clothingDescription,  // Exact clothing from avatar eval (e.g., "red winter parka, blue jeans")
        hasPhoto: photoType !== 'none'
      };
    })
    .filter(info => info.hasPhoto);
}

/**
 * Build a physical description of a character for image generation
 * Only includes visual attributes, not psychological traits
 * @param {Object} char - Character object
 * @returns {string} Physical description string
 */
function buildCharacterPhysicalDescription(char) {
  const age = parseInt(char.age) || 10;
  const gender = char.gender || 'child';

  // Use age-appropriate gender labels
  let genderLabel;
  if (gender === 'male') {
    genderLabel = age >= 18 ? 'man' : 'boy';
  } else if (gender === 'female') {
    genderLabel = age >= 18 ? 'woman' : 'girl';
  } else {
    genderLabel = age >= 18 ? 'person' : 'child';
  }

  let description = `${char.name} is a ${age}-year-old ${genderLabel}`;

  // Support both legacy fields and new physical object structure
  const height = char.physical?.height || char.height;
  const build = char.physical?.build || char.build;
  const face = char.physical?.face || char.otherFeatures;
  const other = char.physical?.other;
  const clothing = char.clothing?.current || char.clothing;

  // Hair: prefer new separate fields, fall back to legacy combined field
  const hairColor = char.physical?.hairColor;
  const hairLength = char.physical?.hairLength;
  const hairStyle = char.physical?.hairStyle;
  const legacyHair = char.physical?.hair || char.hairColor;

  if (height) {
    description += `, ${height} cm tall`;
  }
  if (build) {
    description += `, ${build} build`;
  }

  // Build hair description from separate fields or use legacy
  if (hairColor || hairLength || hairStyle) {
    const hairParts = [];
    if (hairLength) hairParts.push(hairLength);
    if (hairColor) hairParts.push(hairColor);
    if (hairStyle) hairParts.push(hairStyle);
    description += `. Hair: ${hairParts.join(', ')}`;
  } else if (legacyHair) {
    description += `, with ${legacyHair} hair`;
  }
  if (face) {
    description += `, ${face}`;
  }
  // Add other physical traits (glasses, birthmarks, always-present accessories)
  if (other && other !== 'none') {
    description += `, ${other}`;
  }
  if (clothing) {
    description += `. Wearing: ${clothing}`;
  }

  return description;
}

/**
 * Build relative height description for characters
 * Instead of absolute cm values, describes relative heights which AI understands better
 * @param {Array} characters - Array of character objects with name and height properties
 * @returns {string} Description like "Height order: Emma (shortest), Max (much taller), Dad (slightly taller)"
 */
function buildRelativeHeightDescription(characters) {
  if (!characters || characters.length < 2) return '';

  // Filter characters that have height and sort by height
  // Support both new structure (char.physical.height) and legacy (char.height)
  const withHeight = characters
    .map(c => {
      const height = c.height || c.physical?.height;
      return { name: c.name, height: height ? parseInt(height) : NaN };
    })
    .filter(c => !isNaN(c.height))
    .sort((a, b) => a.height - b.height);

  if (withHeight.length < 2) return '';

  // Build relative description
  const descriptions = [];

  for (let i = 0; i < withHeight.length; i++) {
    const char = withHeight[i];

    if (i === 0) {
      // First (shortest) character
      descriptions.push(`${char.name} (shortest)`);
    } else {
      // Compare to previous character
      const prev = withHeight[i - 1];
      const diff = char.height - prev.height;

      let descriptor;
      if (diff <= 3) {
        descriptor = 'about the same height';
      } else if (diff <= 8) {
        descriptor = 'slightly taller';
      } else if (diff <= 15) {
        descriptor = 'a bit taller';
      } else if (diff <= 25) {
        descriptor = 'taller';
      } else if (diff <= 40) {
        descriptor = 'much taller';
      } else {
        descriptor = 'a lot taller';
      }

      descriptions.push(`${char.name} (${descriptor})`);
    }
  }

  return `**HEIGHT ORDER (shortest to tallest):** ${descriptions.join(' -> ')}`;
}

/**
 * Build character reference list for image prompts (covers and story pages)
 * Creates a numbered list with consistent formatting across all image types
 * @param {Array} photos - Reference photos with name, clothingDescription
 * @param {Array} characters - Original character data with physical descriptions
 * @returns {string} Formatted character reference list
 */
function buildCharacterReferenceList(photos, characters = null) {
  if (!photos || photos.length === 0) return '';

  // Age-specific gender term based on apparentAge
  const getGenderTerm = (gender, apparentAge) => {
    if (!gender || gender === 'other') return '';
    const isMale = gender === 'male';
    switch (apparentAge) {
      case 'infant':
        return isMale ? 'baby boy' : 'baby girl';
      case 'toddler':
      case 'preschooler':
      case 'kindergartner':
        return isMale ? 'little boy' : 'little girl';
      case 'young-school-age':
      case 'school-age':
        return isMale ? 'boy' : 'girl';
      case 'preteen':
      case 'young-teen':
      case 'teenager':
        return isMale ? 'teenage boy' : 'teenage girl';
      case 'young-adult':
        return isMale ? 'young man' : 'young woman';
      case 'adult':
      case 'middle-aged':
        return isMale ? 'man' : 'woman';
      case 'senior':
      case 'elderly':
        return isMale ? 'elderly man' : 'elderly woman';
      default:
        return isMale ? 'boy/man' : 'girl/woman';
    }
  };

  const charDescriptions = photos.map((photo, index) => {
    // Find the original character to get full physical description
    const char = characters?.find(c => c.name === photo.name);

    // Visual age first (how old they look), then actual age
    const effectiveAgeCategory = char?.apparentAge || char?.ageCategory || (char?.age ? getAgeCategory(char.age) : null);
    const visualAge = effectiveAgeCategory ? `Looks: ${effectiveAgeCategory.replace(/-/g, ' ')}` : '';
    const age = char?.age ? `${char.age} years old` : '';
    const gender = getGenderTerm(char?.gender, effectiveAgeCategory);

    // Include physical traits with labels
    const physical = char?.physical;

    // Build hair description from separate fields or legacy field
    let hairDesc = '';
    if (physical?.hairColor || physical?.hairLength || physical?.hairStyle) {
      const hairParts = [];
      if (physical?.hairLength) hairParts.push(physical.hairLength);
      if (physical?.hairColor) hairParts.push(physical.hairColor);
      if (physical?.hairStyle) hairParts.push(physical.hairStyle);
      hairDesc = `Hair: ${hairParts.join(', ')}`;
    } else if (physical?.hair) {
      hairDesc = `Hair: ${physical.hair}`;
    }

    const physicalParts = [
      physical?.build ? `Build: ${physical.build}` : '',
      physical?.face ? `Face: ${physical.face}` : '',
      physical?.eyeColor ? `Eyes: ${physical.eyeColor}` : '',
      hairDesc,
      physical?.other ? `Other: ${physical.other}` : '',
      // Include clothing description from avatar if available
      photo.clothingDescription ? `Wearing: ${photo.clothingDescription}` : ''
    ].filter(Boolean);
    const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
    const brief = [photo.name, visualAge, age, gender, physicalDesc].filter(Boolean).join(', ');
    return `${index + 1}. ${brief}`;
  });

  let result = `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;

  // Add relative height description if characters data is available
  if (characters && characters.length >= 2) {
    // Filter to only characters in this scene (matching photo names)
    const sceneCharacters = characters.filter(c => photos.some(p => p.name === c.name));
    const heightDescription = buildRelativeHeightDescription(sceneCharacters);
    if (heightDescription) {
      result += `\n${heightDescription}\n`;
      log.debug(`📏 Added relative heights: ${heightDescription}`);
    }
  }

  return result;
}

// ============================================================================
// PARSERS
// ============================================================================

/**
 * Parse story text into pages
 */
function parseStoryPages(storyText) {
  // Split by page markers (## Seite X, ## Page X, or --- Page X ---)
  const pageRegex = /(?:##\s*(?:Seite|Page)\s+(\d+)|---\s*Page\s+(\d+)\s*---)/gi;
  const pages = [];
  let match;

  // Find all page markers
  const matches = [];
  while ((match = pageRegex.exec(storyText)) !== null) {
    const pageNum = parseInt(match[1] || match[2]);
    matches.push({ index: match.index, pageNum, length: match[0].length });
  }

  // Extract content between markers
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const contentStart = current.index + current.length;
    const contentEnd = next ? next.index : storyText.length;
    const content = storyText.substring(contentStart, contentEnd).trim();

    if (content) {
      pages.push({
        pageNumber: current.pageNum,
        content: content
      });
    }
  }

  return pages;
}

/**
 * Parse scene descriptions from generated text
 */
function parseSceneDescriptions(text, expectedCount) {
  // Split by double newlines and filter out invalid entries
  const scenes = text.split('\n\n')
    .map(s => s.trim())
    .filter(s => {
      // Filter out empty, separators, or very short scenes
      if (!s) return false;
      if (s === '---' || s === '***' || s === '___') return false;
      if (s.length < 20) return false; // Too short to be a real scene description
      if (s.match(/^(Page|Scene|Chapter)\s+\d+/i)) return false; // Page headers
      return true;
    });

  log.debug(`[PARSE] Found ${scenes.length} valid scenes (expected ${expectedCount})`);

  // Log each scene for debugging
  scenes.forEach((scene, i) => {
    const preview = scene.substring(0, 80) + (scene.length > 80 ? '...' : '');
    log.debug(`[PARSE] Scene ${i + 1}: ${preview}`);
  });

  // If we have more scenes than expected, take only the first expectedCount
  if (scenes.length > expectedCount) {
    log.warn(`[PARSE] Got ${scenes.length} scenes but expected ${expectedCount}, trimming excess`);
    return scenes.slice(0, expectedCount);
  }

  // If we have fewer scenes than expected, warn but continue
  if (scenes.length < expectedCount) {
    log.warn(`[PARSE] Got only ${scenes.length} scenes but expected ${expectedCount}`);
  }

  return scenes;
}

/**
 * Extract short scene descriptions from outline
 * Uses the unified OutlineParser for consistent multilingual support
 */
function extractShortSceneDescriptions(outline) {
  const parser = new OutlineParser(outline);
  return parser.extractSceneDescriptions();
}

/**
 * Extract cover scene descriptions and clothing from outline
 * Uses the unified OutlineParser for consistent multilingual support
 * Returns: { titlePage: { scene, clothing }, initialPage: { scene, clothing }, backCover: { scene, clothing } }
 */
function extractCoverScenes(outline) {
  const parser = new OutlineParser(outline);
  return parser.extractCoverScenes();
}

/**
 * Extract clothing information for all pages from outline
 * Uses the unified OutlineParser for consistent multilingual support
 * @param {string} outline - The story outline text
 * @param {number} totalPages - Total number of story pages
 * @returns {Object} { primaryClothing: string, pageClothing: { [pageNum]: string } }
 */
function extractPageClothing(outline, totalPages = 20) {
  const parser = new OutlineParser(outline);
  return parser.extractPageClothing(totalPages);
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

/**
 * Build base prompt for story text generation
 */
function buildBasePrompt(inputData, textPageCount = null) {
  const mainCharacterIds = inputData.mainCharacters || [];
  // Use textPageCount if provided, otherwise calculate from total pages
  // For advanced/standard: total PDF pages / 2 = text pages (since each scene = 1 text + 1 image page)
  // For 1st-grade: total PDF pages = text pages (combined layout)
  const actualTextPages = textPageCount || (
    inputData.languageLevel === '1st-grade'
      ? (inputData.pages || 15)
      : Math.ceil((inputData.pages || 15) / 2)
  );

  // For story text generation, we use BASIC character info (no strengths/weaknesses)
  // Strengths/weaknesses are only used in outline generation to avoid repetitive trait mentions
  // Support both new structure (char.traits.*) and legacy (char.specialDetails)
  const characterSummary = (inputData.characters || []).map(char => {
    const isMain = mainCharacterIds.includes(char.id);
    const traits = char.traits || {};
    return {
      name: char.name,
      isMainCharacter: isMain,
      gender: char.gender,
      age: char.age,
      specialDetails: traits.specialDetails || char.specialDetails || ''  // Includes hobbies, hopes, fears, favorite animals
    };
  });

  // Build relationship descriptions
  let relationshipDescriptions = '';
  if (inputData.relationships) {
    const relationships = inputData.relationships;
    const relationshipTexts = inputData.relationshipTexts || {};
    const characters = inputData.characters || [];

    const relationshipLines = Object.entries(relationships)
      .filter(([key, type]) => type && type !== 'Not Known to')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = characters.find(c => c.id === char1Id);
        const char2 = characters.find(c => c.id === char2Id);
        if (!char1 || !char2) return null;
        const customText = relationshipTexts[key] || '';
        const baseRelationship = `${char1.name} is ${type} ${char2.name}`;
        return customText ? `${baseRelationship}. ${customText}` : baseRelationship;
      })
      .filter(Boolean);

    if (relationshipLines.length > 0) {
      relationshipDescriptions = `\n- **Relationships**:\n${relationshipLines.map(r => `  - ${r}`).join('\n')}`;
    }
  }

  const readingLevel = getReadingLevel(inputData.languageLevel);

  // Add language-specific note from centralized config
  const language = inputData.language || 'en';
  const languageNote = getLanguageNote(language);

  return `# Story Parameters

- **Title**: ${inputData.title || 'Untitled'}
- **Length**: ${actualTextPages} text pages (write exactly this many pages, each within word limit)
- **Language**: ${language}${languageNote}
- **Reading Level**: ${readingLevel}
- **Story Type**: ${inputData.storyType || 'adventure'}
- **Story Details**: ${inputData.storyDetails || 'None'}
- **Characters**: ${JSON.stringify(characterSummary, null, 2)}${relationshipDescriptions}`;
}

/**
 * Build story outline generation prompt
 */
function buildStoryPrompt(inputData, sceneCount = null) {
  // Build the story generation prompt based on input data
  // Use sceneCount if provided (for standard mode where print pages != scenes)
  const pageCount = sceneCount || inputData.pages || 15;
  const readingLevel = getReadingLevel(inputData.languageLevel);
  const mainCharacterIds = inputData.mainCharacters || [];

  // Extract only essential character info (NO PHOTOS to avoid token limit)
  // Support both new structure (char.traits.*) and legacy (char.strengths, etc.)
  const characterSummary = (inputData.characters || []).map(char => {
    const traits = char.traits || {};
    return {
      name: char.name,
      isMainCharacter: mainCharacterIds.includes(char.id),
      gender: char.gender,
      age: char.age,
      personality: char.personality,
      strengths: traits.strengths || char.strengths || [],
      flaws: traits.flaws || char.weaknesses || [],
      challenges: traits.challenges || char.fears || [],
      specialDetails: traits.specialDetails || char.specialDetails || ''
      // Explicitly exclude photoUrl and other large fields
    };
  });

  // Log the prompt parameters for debugging
  log.debug(`[PROMPT] Building outline prompt:`);
  log.debug(`   - Language Level: ${inputData.languageLevel || 'standard'}`);
  log.debug(`   - Reading Level: ${readingLevel}`);
  log.debug(`   - Pages: ${pageCount}`);

  // Extract character names for Visual Bible exclusion warning
  const characterNames = characterSummary.map(c => c.name).join(', ');

  // Determine story category and build category-specific guidelines
  const storyCategory = inputData.storyCategory || 'adventure';
  const storyTopic = inputData.storyTopic || '';
  const storyTheme = inputData.storyTheme || inputData.storyType || 'adventure';

  // Get teaching guide from external file if available
  const teachingGuide = getTeachingGuide(storyCategory, storyTopic);

  let categoryGuidelines = '';
  if (storyCategory === 'life-challenge') {
    categoryGuidelines = `This is a LIFE SKILLS story about "${storyTopic}".

**IMPORTANT GUIDELINES for Life Skills Stories:**
- The story should help children understand and cope with the topic: ${storyTopic}
- Show the main character(s) facing this challenge naturally within the story
- Provide positive, age-appropriate messages about handling this situation
- Include practical tips or coping strategies woven into the narrative
- End with a hopeful, empowering message
- Avoid being preachy - let the lesson emerge naturally from the story
${storyTheme && storyTheme !== 'realistic' ? `- The story is wrapped in a ${storyTheme} adventure setting - integrate the life lesson into this theme creatively` : '- This is a realistic story set in everyday life situations'}

${teachingGuide ? `**SPECIFIC GUIDANCE for "${storyTopic}":**
${teachingGuide}` : ''}`;
  } else if (storyCategory === 'educational') {
    categoryGuidelines = `This is an EDUCATIONAL story teaching about "${storyTopic}".

**IMPORTANT GUIDELINES for Educational Stories:**
- Weave the educational content naturally into an engaging narrative
- Include accurate, age-appropriate information about the topic
- Use repetition and reinforcement to help children learn
- Make the learning fun and memorable through story elements
- Include moments where characters discover or apply what they're learning
${storyTheme && storyTheme !== 'realistic' ? `- The story is wrapped in a ${storyTheme} adventure setting - make learning part of the adventure` : '- Use everyday situations to explore the educational topic'}

${teachingGuide ? `**SPECIFIC TEACHING GUIDE for "${storyTopic}":**
${teachingGuide}` : `- The story should teach children about: ${storyTopic}`}`;
  } else {
    categoryGuidelines = `This is an ADVENTURE story with a ${storyTheme || inputData.storyType || 'adventure'} theme.

**IMPORTANT GUIDELINES for Adventure Stories:**
- Create an exciting, engaging adventure appropriate for the age group
- Include elements typical of the ${storyTheme || inputData.storyType || 'adventure'} theme
- Balance action and excitement with character development
- Include challenges that the characters must overcome`;
  }

  // Use template if available, otherwise fall back to hardcoded prompt
  if (PROMPT_TEMPLATES.outline) {
    const prompt = fillTemplate(PROMPT_TEMPLATES.outline, {
      TITLE: inputData.title || 'Untitled',
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: pageCount,  // Use calculated page count, not raw input
      LANGUAGE: inputData.language || 'en',
      LANGUAGE_NOTE: getLanguageNote(inputData.language || 'en'),
      READING_LEVEL: readingLevel,
      CHARACTERS: JSON.stringify(characterSummary),
      CHARACTER_NAMES: characterNames,  // For Visual Bible exclusion warning
      STORY_CATEGORY: storyCategory,
      STORY_TYPE: storyTheme || inputData.storyType || 'adventure',
      STORY_TOPIC: storyTopic || 'None',
      CATEGORY_GUIDELINES: categoryGuidelines,
      STORY_DETAILS: inputData.storyDetails || 'None',
      DEDICATION: inputData.dedication || 'None'
    });
    log.debug(`[PROMPT] Outline prompt length: ${prompt.length} chars`);
    return prompt;
  }

  // Fallback to hardcoded prompt
  return `Create a children's story with the following parameters:
    Title: ${inputData.title || 'Untitled'}
    Age: ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years
    Length: ${pageCount} pages
    Language: ${inputData.language || 'en'}
    Characters: ${JSON.stringify(characterSummary)}
    Story Type: ${inputData.storyType || 'adventure'}
    Story Details: ${inputData.storyDetails || 'None'}
    Dedication: ${inputData.dedication || 'None'}`;
}

/**
 * Build Art Director scene description prompt
 * @param {number} pageNumber - Current page number
 * @param {string} pageContent - Text content for current page
 * @param {Array} characters - Character data array
 * @param {string} shortSceneDesc - Scene hint from outline (current page)
 * @param {string} language - Output language
 * @param {Object} visualBible - Visual Bible data
 * @param {Array} previousScenes - Array of {pageNumber, text, sceneHint} for previous pages (max 2)
 */
function buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc = '', language = 'English', visualBible = null, previousScenes = []) {
  // Track Visual Bible matches for consolidated logging
  const vbMatches = [];
  const vbMisses = [];

  // Build character names list ONLY - physical descriptions are passed directly to image generation
  // This prevents the text model from "copying" and potentially modifying character traits
  const characterDetails = characters.map(c => {
    // Track Visual Bible matches for logging
    if (visualBible && visualBible.mainCharacters) {
      const vbChar = visualBible.mainCharacters.find(vbc =>
        vbc.id === c.id || vbc.name.toLowerCase().trim() === c.name.toLowerCase().trim()
      );
      if (vbChar) {
        vbMatches.push(c.name);
      } else {
        vbMisses.push(c.name);
      }
    }
    // Only return the character name - NO physical traits (those go directly to image generation)
    return `* **${c.name}**`;
  }).join('\n');

  // Build Visual Bible recurring elements section - include ALL entries (not filtered by page)
  let recurringElements = '';
  if (visualBible) {
    // Add ALL secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      for (const sc of visualBible.secondaryCharacters) {
        const description = sc.extractedDescription || sc.description;
        recurringElements += `* **${sc.name}** (secondary character): ${description}\n`;
      }
    }
    // Add ALL locations
    if (visualBible.locations && visualBible.locations.length > 0) {
      for (const loc of visualBible.locations) {
        const description = loc.extractedDescription || loc.description;
        recurringElements += `* **${loc.name}** (location): ${description}\n`;
      }
    }
    // Add ALL animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      for (const animal of visualBible.animals) {
        const description = animal.extractedDescription || animal.description;
        recurringElements += `* **${animal.name}** (animal): ${description}\n`;
      }
    }
    // Add ALL artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      for (const artifact of visualBible.artifacts) {
        const description = artifact.extractedDescription || artifact.description;
        recurringElements += `* **${artifact.name}** (object): ${description}\n`;
      }
    }
  }

  // Consolidated logging for scene prompt
  const vbEntryCount = (visualBible?.secondaryCharacters?.length || 0) +
                       (visualBible?.locations?.length || 0) +
                       (visualBible?.animals?.length || 0) +
                       (visualBible?.artifacts?.length || 0);
  const matchInfo = vbMatches.length > 0 ? vbMatches.join(', ') : 'none';
  const missInfo = vbMisses.length > 0 ? `, missing: ${vbMisses.join(', ')}` : '';
  log.debug(`[SCENE PROMPT P${pageNumber}] ${characters.length} chars (VB: ${matchInfo}${missInfo}), ${vbEntryCount} recurring elements`);

  // Default message if no recurring elements
  if (!recurringElements) {
    recurringElements = '(None available)';
  }

  // Build previous scenes context (for narrative continuity and clothing consistency)
  let previousScenesText = '';
  if (previousScenes && previousScenes.length > 0) {
    previousScenesText = '**PREVIOUS SCENES (for context only - do NOT illustrate these):**\n';
    for (const prev of previousScenes) {
      // Include full text - context is valuable and tokens are cheap
      previousScenesText += `Page ${prev.pageNumber}: ${prev.text}\n`;
      if (prev.sceneHint) {
        previousScenesText += `  Scene: ${prev.sceneHint}\n`;
      }
      if (prev.clothing) {
        previousScenesText += `  Clothing: ${prev.clothing}\n`;
      }
    }
    previousScenesText += '\n';
  }

  // Use template from file if available
  if (PROMPT_TEMPLATES.sceneDescriptions) {
    return fillTemplate(PROMPT_TEMPLATES.sceneDescriptions, {
      PREVIOUS_SCENES: previousScenesText,
      SCENE_SUMMARY: shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : '',
      PAGE_NUMBER: pageNumber.toString(),
      PAGE_CONTENT: pageContent,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      LANGUAGE: language,
      LANGUAGE_NOTE: getLanguageNote(language)
    });
  }

  // Fallback to hardcoded prompt if template not loaded
  return `**ROLE:**
You are an expert Art Director creating an illustration brief for a children's book.

${previousScenesText}**CURRENT SCENE (Page ${pageNumber}) - YOUR FOCUS:**
${shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : ''}Story Text:
${pageContent}

**AVAILABLE CHARACTERS & VISUAL REFERENCES:**
${characterDetails}
${recurringElements}
**TASK:**
Create a detailed visual description of ONE key moment from the scene context provided.

Focus on essential characters only (1-2 maximum unless the story specifically requires more). Choose the most impactful visual moment that captures the essence of the scene.

**OUTPUT FORMAT:**
1. **Setting & Atmosphere:** Describe the background, time of day, lighting, and mood.
2. **Composition:** Describe the camera angle (e.g., low angle, wide shot) and framing.
3. **Characters:**
   * **[Character Name]:** Exact action, body language, facial expression, and location in the frame.
   (Repeat for each character present in this specific scene)

**CONSTRAINTS:**
- Do not include dialogue or speech
- Focus purely on visual elements
- Use simple, clear language
- Only include characters essential to this scene
- If recurring elements appear, describe them consistently as specified above`;
}

/**
 * Build image generation prompt
 */
function buildImagePrompt(sceneDescription, inputData, sceneCharacters = null, isSequential = false, visualBible = null, pageNumber = null, isStorybook = false, referencePhotos = null) {
  // Build image generation prompt (matches step-by-step format)
  // For storybook mode: visualBible entries are added here since there's no separate scene description step
  // For parallel/sequential modes: Visual Bible is also in scene description, but adding here ensures consistency

  // Extract metadata BEFORE stripping (needed for objects lookup)
  const metadata = extractSceneMetadata(sceneDescription);

  // Strip JSON metadata block from scene description (not needed in image prompt)
  const cleanSceneDescription = stripSceneMetadata(sceneDescription);

  const artStyleId = inputData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;
  const language = (inputData.language || 'en').toLowerCase();

  // Build character reference list (Option B: explicit labeling in prompt)
  let characterReferenceList = '';
  if (sceneCharacters && sceneCharacters.length > 0) {
    log.debug(`[IMAGE PROMPT] Scene characters: ${sceneCharacters.map(c => c.name).join(', ')}`);

    // Build a map of character names to their clothing descriptions from referencePhotos
    const clothingMap = {};
    if (referencePhotos && referencePhotos.length > 0) {
      referencePhotos.forEach(photo => {
        if (photo.name && photo.clothingDescription) {
          clothingMap[photo.name.toLowerCase()] = photo.clothingDescription;
          log.debug(`[IMAGE PROMPT] ${photo.name} wearing: "${photo.clothingDescription}" (${photo.clothingCategory})`);
        }
      });
    }

    // Build a numbered list of characters with full physical descriptions INCLUDING CLOTHING
    const charDescriptions = sceneCharacters.map((char, index) => {
      // Visual age first (how old they look), then actual age
      const visualAge = char.apparentAge ? `Looks: ${char.apparentAge.replace(/-/g, ' ')}` : '';
      const age = char.age ? `${char.age} years old` : '';

      // Age-specific gender term based on apparentAge
      const getGenderTerm = (gender, apparentAge) => {
        if (!gender || gender === 'other') return '';
        const isMale = gender === 'male';
        switch (apparentAge) {
          case 'infant':
            return isMale ? 'baby boy' : 'baby girl';
          case 'toddler':
          case 'preschooler':
          case 'kindergartner':
            return isMale ? 'little boy' : 'little girl';
          case 'young-school-age':
          case 'school-age':
            return isMale ? 'boy' : 'girl';
          case 'preteen':
          case 'young-teen':
          case 'teenager':
            return isMale ? 'teenage boy' : 'teenage girl';
          case 'young-adult':
            return isMale ? 'young man' : 'young woman';
          case 'adult':
          case 'middle-aged':
            return isMale ? 'man' : 'woman';
          case 'senior':
          case 'elderly':
            return isMale ? 'elderly man' : 'elderly woman';
          default:
            return isMale ? 'boy/man' : 'girl/woman';
        }
      };
      const gender = getGenderTerm(char.gender, char.apparentAge);
      // Include physical traits with labels (excluding height - AI doesn't understand it for images)
      const physical = char.physical;
      // Get clothing STYLE from character analysis - colors AND patterns
      // Avatar determines the garment type (coat, hoodie, t-shirt), we need colors + patterns to match
      const clothingStyle = char.clothingStyle || char.clothing_style || char.clothing?.style || char.clothingColors || char.clothing_colors || char.clothing?.colors;
      // Get clothing DESCRIPTION from avatar eval (what they're actually wearing in the selected avatar)
      const avatarClothing = clothingMap[char.name?.toLowerCase()] || null;
      if (clothingStyle) {
        log.debug(`[IMAGE PROMPT] ${char.name} clothing style: "${clothingStyle}"`);
      }
      if (avatarClothing) {
        log.debug(`[IMAGE PROMPT] ${char.name} avatar clothing: "${avatarClothing}"`);
      }
      // Build hair description from separate fields or legacy field
      let hairDesc = '';
      if (physical?.hairColor || physical?.hairLength || physical?.hairStyle) {
        const hairParts = [];
        if (physical?.hairLength) hairParts.push(physical.hairLength);
        if (physical?.hairColor) hairParts.push(physical.hairColor);
        if (physical?.hairStyle) hairParts.push(physical.hairStyle);
        hairDesc = `Hair: ${hairParts.join(', ')}`;
      } else if (physical?.hair) {
        hairDesc = `Hair: ${physical.hair}`;
      }

      const physicalParts = [
        physical?.build ? `Build: ${physical.build}` : '',
        physical?.face ? `Face: ${physical.face}` : '',
        physical?.eyeColor ? `Eyes: ${physical.eyeColor}` : '',
        hairDesc,
        physical?.other ? `Other: ${physical.other}` : '',
        // Prefer avatar clothing description if available, otherwise use clothing style
        avatarClothing ? `Wearing: ${avatarClothing}` : (clothingStyle ? `CLOTHING STYLE (MUST MATCH - colors and patterns): ${clothingStyle}` : '')
      ].filter(Boolean);
      const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
      const brief = [char.name, visualAge, age, gender, physicalDesc].filter(Boolean).join(', ');
      return `${index + 1}. ${brief}`;
    });

    // Build relative height description (AI understands this better than cm values)
    const heightDescription = buildRelativeHeightDescription(sceneCharacters);

    characterReferenceList = `\n**CHARACTER REFERENCE PHOTOS (in order):**\n${charDescriptions.join('\n')}\nMatch each character to their corresponding reference photo above.\n`;

    if (heightDescription) {
      characterReferenceList += `\n${heightDescription}\n`;
      log.debug(`[IMAGE PROMPT] Added relative heights: ${heightDescription}`);
    }
  }

  // Build Visual Bible section with ALL recurring elements (animals, artifacts, locations)
  let visualBibleSection = '';
  if (visualBible && pageNumber !== null) {
    const sceneCharacterNames = sceneCharacters ? sceneCharacters.map(c => c.name) : null;
    visualBibleSection = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames, language);
    if (visualBibleSection) {
      log.debug(`[IMAGE PROMPT] Added Visual Bible section for page ${pageNumber}`);
    }
  }

  // Build required objects section from metadata.objects by looking up in Visual Bible
  // This ensures objects listed in scene metadata are included with their full descriptions
  let requiredObjectsSection = '';
  if (metadata && metadata.objects && metadata.objects.length > 0 && visualBible) {
    const requiredObjects = [];

    for (const objName of metadata.objects) {
      const objNameLower = objName.toLowerCase().trim();

      // Look up in artifacts
      const artifact = (visualBible.artifacts || []).find(a =>
        a.name.toLowerCase().trim() === objNameLower ||
        a.name.toLowerCase().includes(objNameLower) ||
        objNameLower.includes(a.name.toLowerCase())
      );
      if (artifact) {
        const description = artifact.extractedDescription || artifact.description;
        requiredObjects.push({ name: artifact.name, type: 'object', description });
        continue;
      }

      // Look up in animals
      const animal = (visualBible.animals || []).find(a =>
        a.name.toLowerCase().trim() === objNameLower ||
        a.name.toLowerCase().includes(objNameLower) ||
        objNameLower.includes(a.name.toLowerCase())
      );
      if (animal) {
        const description = animal.extractedDescription || animal.description;
        requiredObjects.push({ name: animal.name, type: 'animal', description });
        continue;
      }

      // Look up in locations (in case location is listed as object)
      const location = (visualBible.locations || []).find(l =>
        l.name.toLowerCase().trim() === objNameLower ||
        l.name.toLowerCase().includes(objNameLower) ||
        objNameLower.includes(l.name.toLowerCase())
      );
      if (location) {
        const description = location.extractedDescription || location.description;
        requiredObjects.push({ name: location.name, type: 'location', description });
      }
    }

    if (requiredObjects.length > 0) {
      // Build the required objects section with language-appropriate header
      let header;
      if (language === 'de') {
        header = '**ERFORDERLICHE OBJEKTE IN DIESER SZENE (MÜSSEN im Bild erscheinen):**';
      } else if (language === 'fr') {
        header = '**OBJETS REQUIS DANS CETTE SCÈNE (DOIVENT apparaître dans l\'image):**';
      } else {
        header = '**REQUIRED OBJECTS IN THIS SCENE (MUST appear in the image):**';
      }

      requiredObjectsSection = `\n${header}\n`;
      for (const obj of requiredObjects) {
        requiredObjectsSection += `* **${obj.name}** (${obj.type}): ${obj.description}\n`;
      }

      log.debug(`[IMAGE PROMPT] Added ${requiredObjects.length} required objects from metadata: ${requiredObjects.map(o => o.name).join(', ')}`);
    }
  }

  // Select the correct template based on mode and language
  let template = null;
  let templateName = '';
  if (isStorybook && PROMPT_TEMPLATES.imageGenerationStorybook) {
    // Storybook mode template (includes Visual Bible section)
    template = PROMPT_TEMPLATES.imageGenerationStorybook;
    templateName = 'storybook';
  } else if (isSequential) {
    // Sequential mode templates (with visual continuity instructions)
    if (language === 'de' && PROMPT_TEMPLATES.imageGenerationSequentialDe) {
      template = PROMPT_TEMPLATES.imageGenerationSequentialDe;
    } else if (language === 'fr' && PROMPT_TEMPLATES.imageGenerationSequentialFr) {
      template = PROMPT_TEMPLATES.imageGenerationSequentialFr;
    } else if (PROMPT_TEMPLATES.imageGenerationSequential) {
      template = PROMPT_TEMPLATES.imageGenerationSequential;
    }
    templateName = 'sequential';
  } else {
    // Parallel mode templates
    if (language === 'de' && PROMPT_TEMPLATES.imageGenerationDe) {
      template = PROMPT_TEMPLATES.imageGenerationDe;
    } else if (language === 'fr' && PROMPT_TEMPLATES.imageGenerationFr) {
      template = PROMPT_TEMPLATES.imageGenerationFr;
    } else if (PROMPT_TEMPLATES.imageGeneration) {
      template = PROMPT_TEMPLATES.imageGeneration;
    }
    templateName = 'parallel';
  }

  // Use template if available, otherwise fall back to hardcoded prompt
  if (template) {
    console.log(`[IMAGE PROMPT] Using ${templateName} template for language: ${language}`);
    // Fill all placeholders in template
    return fillTemplate(template, {
      STYLE_DESCRIPTION: styleDescription,
      SCENE_DESCRIPTION: cleanSceneDescription,
      CHARACTER_REFERENCE_LIST: characterReferenceList,
      VISUAL_BIBLE: visualBibleSection,
      REQUIRED_OBJECTS: requiredObjectsSection,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8
    });
  }

  // Fallback to hardcoded prompt
  return `Create a cinematic scene in ${styleDescription}.

${characterReferenceList}
Scene Description: ${cleanSceneDescription}
${requiredObjectsSection}
${visualBibleSection}
Important:
- Match characters to the reference photos provided
- Show appropriate emotions on faces (happy, sad, surprised, worried, excited)
- Maintain consistent character appearance across ALL pages
- Clean, clear composition
- Age-appropriate for ${inputData.ageFrom || 3}-${inputData.ageTo || 8} years old`;
}

/**
 * Build scene expansion prompt for regeneration
 * Takes a short scene summary and expands it to full Art Director format
 */
function buildSceneExpansionPrompt(sceneSummary, inputData, sceneCharacters, visualBible, language = 'en') {
  // Build character details for prompt
  let characterDetails = '';
  if (sceneCharacters && sceneCharacters.length > 0) {
    characterDetails = sceneCharacters.map(char => {
      const physicalDesc = buildCharacterPhysicalDescription(char);
      return `* **${char.name}:** ${physicalDesc}`;
    }).join('\n');
  } else {
    characterDetails = '(No main characters with reference photos in this scene)';
  }

  // Build recurring elements from Visual Bible
  let recurringElements = '';
  if (visualBible) {
    const elements = [];

    // Add animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      visualBible.animals.forEach(animal => {
        elements.push(`* **${animal.name}:** ${animal.description}`);
      });
    }

    // Add artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      visualBible.artifacts.forEach(artifact => {
        elements.push(`* **${artifact.name}:** ${artifact.description}`);
      });
    }

    // Add locations
    if (visualBible.locations && visualBible.locations.length > 0) {
      visualBible.locations.forEach(location => {
        elements.push(`* **${location.name}:** ${location.description}`);
      });
    }

    // Add secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      visualBible.secondaryCharacters.forEach(char => {
        elements.push(`* **${char.name}:** ${char.description}`);
      });
    }

    recurringElements = elements.length > 0 ? elements.join('\n') : '(No recurring elements defined)';
  } else {
    recurringElements = '(No recurring elements defined)';
  }

  // Select language-appropriate template
  const langCode = (language || 'en').toLowerCase();
  // Check for German variants (de, de-de, de-ch)
  const isGerman = langCode.startsWith('de');
  const isFrench = langCode === 'fr';
  let template = null;

  if (isGerman && PROMPT_TEMPLATES.sceneExpansionDe) {
    template = PROMPT_TEMPLATES.sceneExpansionDe;
  } else if (isFrench && PROMPT_TEMPLATES.sceneExpansionFr) {
    template = PROMPT_TEMPLATES.sceneExpansionFr;
  } else if (PROMPT_TEMPLATES.sceneExpansion) {
    template = PROMPT_TEMPLATES.sceneExpansion;
  }

  if (template) {
    // Use centralized language functions
    const { getLanguageNameEnglish } = require('./languages');
    return fillTemplate(template, {
      SCENE_SUMMARY: sceneSummary,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      LANGUAGE: getLanguageNameEnglish(langCode),
      LANGUAGE_NOTE: getLanguageNote(langCode)
    });
  }

  // Fallback if templates not loaded
  return `Expand this scene summary into a detailed illustration brief:

Scene Summary: ${sceneSummary}

Characters: ${characterDetails}

Recurring Elements: ${recurringElements}

Output a detailed scene description with:
1. Image Summary
2. Setting & Atmosphere
3. Composition (with character positions and actions)
4. Clothing category
5. Characters (with full physical descriptions)
6. Objects & Animals (if applicable)`;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Config
  ART_STYLES,
  LANGUAGE_LEVELS,

  // Level helpers
  getReadingLevel,
  getTokensPerPage,

  // Page calculations
  calculateStoryPageCount,

  // Age category
  getAgeCategory,
  getAgeCategoryLabel,

  // Character helpers
  getCharactersInScene,
  getCharacterPhotos,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildRelativeHeightDescription,
  buildCharacterReferenceList,

  // Parsers
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  extractSceneMetadata,
  stripSceneMetadata,

  // Prompt builders
  buildBasePrompt,
  buildStoryPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildSceneExpansionPrompt,

  // Teaching guides
  getTeachingGuide
};
