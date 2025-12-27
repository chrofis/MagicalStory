/**
 * Story Helpers Module
 *
 * Common utilities for story generation, prompt building, and text parsing.
 * Used by both processStoryJob and processStorybookJob.
 */

const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { hashImageData } = require('./images');
const { buildVisualBiblePrompt } = require('./visualBible');

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
 * @param {string} sceneDescription - The scene text
 * @param {Array} characters - Array of character objects
 * @returns {Array} Characters that appear in this scene
 */
function getCharactersInScene(sceneDescription, characters) {
  if (!sceneDescription || !characters || characters.length === 0) {
    return [];
  }

  const sceneLower = sceneDescription.toLowerCase();
  return characters.filter(char => {
    if (!char.name) return false;
    // Check for character name in scene (case insensitive)
    const nameLower = char.name.toLowerCase();
    // Also check for first name only (e.g., "Max" from "Max Mustermann")
    const firstName = nameLower.split(' ')[0];
    return sceneLower.includes(nameLower) || sceneLower.includes(firstName);
  });
}

/**
 * Get photo URLs for specific characters based on clothing category
 * Prefers clothing avatar for the category > body with no background > body crop > face photo
 * @param {Array} characters - Array of character objects (filtered to scene)
 * @param {string} clothingCategory - Optional clothing category (winter, summer, formal, standard)
 * @returns {Array} Array of photo URLs for image generation
 */
function getCharacterPhotos(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];
  return characters
    .map(char => {
      // If clothing category specified and character has clothing avatar for it, use it
      if (clothingCategory && char.clothingAvatars && char.clothingAvatars[clothingCategory]) {
        return char.clothingAvatars[clothingCategory];
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

  // Generic approach: find "Clothing" keyword (in any language) and look for value nearby
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

      // Check for exact clothing avatar first
      if (clothingCategory && avatars && avatars[clothingCategory]) {
        photoType = `clothing-${clothingCategory}`;
        photoUrl = avatars[clothingCategory];
      }
      // Try fallback clothing avatars before falling back to body photo
      else if (clothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[clothingCategory] || ['standard', 'formal', 'summer', 'winter'];
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            photoType = `clothing-${fallbackCategory}`;
            photoUrl = avatars[fallbackCategory];
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
        clothingCategory: clothingCategory || null,
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
  const hair = char.physical?.hair || char.hairColor;
  const face = char.physical?.face || char.otherFeatures;
  const other = char.physical?.other;
  const clothing = char.clothing?.current || char.clothing;

  if (height) {
    description += `, ${height} cm tall`;
  }
  if (build) {
    description += `, ${build} build`;
  }
  if (hair) {
    description += `, with ${hair} hair`;
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
 */
function extractShortSceneDescriptions(outline) {
  const descriptions = {};
  const lines = outline.split('\n');

  // Debug: Log outline length and preview to understand format
  log.debug(`[SCENE-EXTRACT] Outline length: ${outline.length} chars, ${lines.length} lines`);
  log.debug(`[SCENE-EXTRACT] Outline preview (first 500 chars): ${outline.substring(0, 500).replace(/\n/g, '\\n')}`);

  // Look for the Page-by-Page Breakdown section first
  let inPageSection = false;
  let pagesFound = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect when we enter the page breakdown section
    if (line.match(/page[\s-]*by[\s-]*page|seitenweise/i)) {
      inPageSection = true;
      log.debug(`[SCENE-EXTRACT] Found page breakdown section at line ${i + 1}`);
    }

    // Look for various page header formats:
    // - "Page X:" or "**Page X:**" or "Page X -"
    // - "## Page X" (markdown header)
    // - "Seite X:" (German)
    // - More flexible: Page/Seite followed by number, with various separators
    const pageMatch = line.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+(\d+)\s*(?::|\.|-|\*{0,2})/i);
    if (pageMatch) {
      const pageNum = parseInt(pageMatch[1]);
      pagesFound.push(pageNum);

      // First check if scene is on the same line (e.g., "Page 1: Scene: description")
      const inlineSceneMatch = line.match(/(?:Scene|Szene|Scene)(?:\s+Description)?[:\s]+(.+)/i);
      if (inlineSceneMatch && inlineSceneMatch[1].trim().length > 10) {
        descriptions[pageNum] = inlineSceneMatch[1].trim();
        log.debug(`[SCENE-EXTRACT] Page ${pageNum} (inline): ${descriptions[pageNum].substring(0, 60)}...`);
        continue;
      }

      // Look for Scene: in the next 10 lines (template format has Scene after Character Focus and Clothing)
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const sceneLine = lines[j].trim();

        // Match various Scene formats with more flexibility (EN, DE, FR)
        // Also match "Scene" (French) and lines starting with "Scene:" directly
        const sceneMatch = sceneLine.match(/^[-*\u2022]?\s*\*{0,2}(?:Scene|Szene|Scene|Visual|Setting|Image)(?:\s+Description)?[:\s]*\*{0,2}\s*(.*)/i);
        if (sceneMatch && sceneMatch[1].trim().length > 5) {
          descriptions[pageNum] = sceneMatch[1].trim();
          log.debug(`[SCENE-EXTRACT] Page ${pageNum}: ${descriptions[pageNum].substring(0, 60)}...`);
          break;
        }
        // Stop if we hit another Page marker
        if (sceneLine.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+\d+/i)) break;
      }

      // If no scene found yet, try to find any descriptive text after skipping structured fields
      if (!descriptions[pageNum]) {
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const nextLine = lines[j].trim();
          // Skip empty lines, structured field labels, and short lines
          if (!nextLine) continue;
          if (nextLine.match(/^(?:Character\s*Focus|Clothing|Title|Titel|Text|Story|Personnage|Vetements)/i)) continue;
          if (nextLine.length < 20) continue;
          // Stop if we hit another Page marker
          if (nextLine.match(/^(?:#{1,3}\s*)?\*{0,2}(?:Page|Seite)\s+\d+/i)) break;

          // Use this as fallback scene description (strip markdown formatting)
          descriptions[pageNum] = nextLine.replace(/^\*{1,2}/, '').replace(/\*{1,2}$/, '').replace(/^\[|\]$/g, '').trim();
          log.debug(`[SCENE-EXTRACT] Page ${pageNum} (fallback): ${descriptions[pageNum].substring(0, 60)}...`);
          break;
        }
      }
    }
  }

  log.debug(`[SCENE-EXTRACT] Pages found: ${pagesFound.join(', ') || 'none'}`);
  log.debug(`[SCENE-EXTRACT] Total extracted: ${Object.keys(descriptions).length} scene descriptions`);
  return descriptions;
}

/**
 * Extract cover scene descriptions and clothing from outline
 * Supports both story mode format ("Back Cover Scene: ...") and storybook format ("---BACK COVER---")
 * Returns: { titlePage: { scene, clothing }, initialPage: { scene, clothing }, backCover: { scene, clothing } }
 */
function extractCoverScenes(outline) {
  const coverScenes = {
    titlePage: { scene: '', clothing: null },
    initialPage: { scene: '', clothing: null },
    backCover: { scene: '', clothing: null }
  };

  const lines = outline.split('\n');
  let currentCoverType = null;
  let sceneBuffer = '';
  let collectingMultilineScene = false;

  // Track multiline scene parts for storybook format (Setting, Characters, Action, Mood)
  let sceneParts = { setting: '', characters: '', action: '', mood: '' };

  // Helper to save current buffer
  const saveCurrentScene = () => {
    if (currentCoverType && sceneBuffer) {
      coverScenes[currentCoverType].scene = sceneBuffer.trim();
    }
  };

  // Helper to build scene from storybook multiline format
  const buildSceneFromParts = (parts) => {
    const sceneParts = [];
    if (parts.setting) sceneParts.push(parts.setting);
    if (parts.characters) sceneParts.push(`Characters: ${parts.characters}`);
    if (parts.action) sceneParts.push(parts.action);
    if (parts.mood) sceneParts.push(`Mood: ${parts.mood}`);
    return sceneParts.join('. ').replace(/\.\./g, '.');
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // ===== STORYBOOK FORMAT: Section headers like ---TITLE PAGE---, ---BACK COVER--- =====
    const storybookTitleMatch = line.match(/^---\s*TITLE\s+PAGE\s*---$/i);
    if (storybookTitleMatch) {
      saveCurrentScene();
      currentCoverType = 'titlePage';
      sceneBuffer = '';
      sceneParts = { setting: '', characters: '', action: '', mood: '' };
      collectingMultilineScene = true;
      continue;
    }

    const storybookInitialMatch = line.match(/^---\s*INITIAL\s+PAGE\s*---$/i);
    if (storybookInitialMatch) {
      saveCurrentScene();
      currentCoverType = 'initialPage';
      sceneBuffer = '';
      sceneParts = { setting: '', characters: '', action: '', mood: '' };
      collectingMultilineScene = true;
      continue;
    }

    const storybookBackCoverMatch = line.match(/^---\s*BACK\s+COVER\s*---$/i);
    if (storybookBackCoverMatch) {
      saveCurrentScene();
      currentCoverType = 'backCover';
      sceneBuffer = '';
      sceneParts = { setting: '', characters: '', action: '', mood: '' };
      collectingMultilineScene = true;
      continue;
    }

    // Detect end of storybook cover section (next page or section)
    if (line.match(/^---\s*PAGE\s+\d+\s*---$/i) || line.match(/^---\s*VISUAL\s+BIBLE\s*---$/i) || line.match(/^---\s*TITLE\s*---$/i)) {
      if (collectingMultilineScene && currentCoverType) {
        const builtScene = buildSceneFromParts(sceneParts);
        if (builtScene) {
          sceneBuffer = builtScene;
        }
        saveCurrentScene();
      }
      currentCoverType = null;
      sceneBuffer = '';
      collectingMultilineScene = false;
      sceneParts = { setting: '', characters: '', action: '', mood: '' };
      continue;
    }

    // ===== STORY MODE FORMAT: "Title Page Scene:", "Back Cover Scene:" etc =====
    const titlePageMatch = line.match(/(?:\*\*)?Title\s+Page(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (titlePageMatch) {
      saveCurrentScene();
      currentCoverType = 'titlePage';
      sceneBuffer = titlePageMatch[1].trim();
      collectingMultilineScene = false;
      continue;
    }

    // Match both "Initial Page" and legacy "Page 0" for backward compatibility
    const initialPageMatch = line.match(/(?:\*\*)?(?:Initial\s+Page|Page\s+0)(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (initialPageMatch) {
      saveCurrentScene();
      currentCoverType = 'initialPage';
      sceneBuffer = initialPageMatch[1].trim();
      collectingMultilineScene = false;
      continue;
    }

    const backCoverMatch = line.match(/(?:\*\*)?Back\s+Cover(?:\s+Scene)?(?:\*\*)?:\s*(.+)/i);
    if (backCoverMatch) {
      saveCurrentScene();
      currentCoverType = 'backCover';
      sceneBuffer = backCoverMatch[1].trim();
      collectingMultilineScene = false;
      continue;
    }

    // Stop collecting if we hit section separators or new sections (story mode)
    if (line === '---' || line.match(/^#{1,3}\s*(Visual Bible|Page-by-Page|Characters|Animals|Locations|Plot)/i)) {
      saveCurrentScene();
      currentCoverType = null;
      sceneBuffer = '';
      collectingMultilineScene = false;
      continue;
    }

    // ===== COLLECT SCENE PARTS (works for both formats) =====

    // Extract Clothing for current cover type
    const clothingMatch = line.match(/^[\*_\-#\s\d\.]*(?:Clothing|Kleidung|Vetements|Tenue)[\*_\-#\s]*:?\s*[\*_\-#\s]*(winter|summer|formal|standard)?/i);
    if (clothingMatch && currentCoverType) {
      if (clothingMatch[1]) {
        coverScenes[currentCoverType].clothing = clothingMatch[1].toLowerCase();
      } else if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        const valueMatch = nextLine.match(/^[\*_\-#\s]*(winter|summer|formal|standard)[\*_\-#\s]*$/i);
        if (valueMatch) {
          coverScenes[currentCoverType].clothing = valueMatch[1].toLowerCase();
          i++;
        }
      }
      continue;
    }

    // Storybook multiline format: collect Setting, Characters, Action, Mood
    if (collectingMultilineScene && currentCoverType) {
      const settingMatch = line.match(/^Setting:\s*(.+)/i);
      if (settingMatch) {
        sceneParts.setting = settingMatch[1].trim();
        continue;
      }

      const charactersMatch = line.match(/^Characters:\s*(.+)/i);
      if (charactersMatch) {
        sceneParts.characters = charactersMatch[1].trim();
        continue;
      }

      const actionMatch = line.match(/^Action:\s*(.+)/i);
      if (actionMatch) {
        sceneParts.action = actionMatch[1].trim();
        continue;
      }

      const moodMatch = line.match(/^Mood:\s*(.+)/i);
      if (moodMatch) {
        sceneParts.mood = moodMatch[1].trim();
        continue;
      }

      // Also capture SCENE: line in storybook format (skip parenthetical instructions)
      const sceneLineMatch = line.match(/^SCENE:\s*(.+)/i);
      if (sceneLineMatch) {
        const sceneText = sceneLineMatch[1].trim();
        if (!sceneText.startsWith('(')) {
          sceneBuffer = sceneText;
        }
        continue;
      }
    }

    // Look for "Scene:" pattern (story mode format)
    const sceneMatch = line.match(/^(?:\*\*)?Scene(?:\*\*)?:\s*(.+)/i);
    if (sceneMatch && !collectingMultilineScene) {
      sceneBuffer = sceneMatch[1].trim();
    } else if (currentCoverType && !collectingMultilineScene && line.length > 0 && !line.match(/^(Page|Title|Back\s+Cover)/i)) {
      // Continue collecting multi-line scene descriptions (story mode)
      sceneBuffer += ' ' + line;
    }

    // If we hit a regular page number, stop collecting cover scenes
    if (line.match(/^(?:\*\*)?Page\s+\d+(?:\*\*)?[\s:]/i)) {
      saveCurrentScene();
      currentCoverType = null;
      sceneBuffer = '';
      collectingMultilineScene = false;
    }
  }

  // Save last buffer (handle end of file for storybook format)
  if (collectingMultilineScene && currentCoverType) {
    const builtScene = buildSceneFromParts(sceneParts);
    if (builtScene) {
      sceneBuffer = builtScene;
    }
  }
  saveCurrentScene();

  log.debug(`[COVER-EXTRACT] Title Page: clothing=${coverScenes.titlePage.clothing || 'not found'}, scene=${coverScenes.titlePage.scene.substring(0, 50)}...`);
  log.debug(`[COVER-EXTRACT] Initial Page: clothing=${coverScenes.initialPage.clothing || 'not found'}, scene=${coverScenes.initialPage.scene.substring(0, 50)}...`);
  log.debug(`[COVER-EXTRACT] Back Cover: clothing=${coverScenes.backCover.clothing || 'not found'}, scene=${coverScenes.backCover.scene.substring(0, 50)}...`);

  return coverScenes;
}

/**
 * Extract clothing information for all pages from outline
 * Parses primary clothing and per-page changes
 * @param {string} outline - The story outline text
 * @param {number} totalPages - Total number of story pages
 * @returns {Object} { primaryClothing: string, pageClothing: { [pageNum]: string } }
 */
function extractPageClothing(outline, totalPages = 20) {
  const result = {
    primaryClothing: 'standard',
    pageClothing: {}  // { 1: 'summer', 2: 'summer', 8: 'standard', ... }
  };

  if (!outline) return result;

  const lines = outline.split('\n');

  // Pattern 1: Find Primary Clothing
  // Matches: "**Primary Clothing:** summer", "Primary Clothing: winter", etc.
  const primaryMatch = outline.match(/(?:\*\*)?Primary\s+Clothing(?:\*\*)?:\s*\[?\s*(winter|summer|formal|standard)/i);
  if (primaryMatch) {
    result.primaryClothing = primaryMatch[1].toLowerCase();
    log.debug(`[PAGE CLOTHING] Primary clothing: ${result.primaryClothing}`);
  }

  // Initialize all pages with primary clothing
  for (let i = 1; i <= totalPages; i++) {
    result.pageClothing[i] = result.primaryClothing;
  }

  // Pattern 2: Find Clothing Change Events section
  // Format: "Page 8 (bedtime scene → standard)" or "Page 8: change to standard"
  const changeEventsMatch = outline.match(/Clothing\s+Change\s+Events[:\s]*([\s\S]*?)(?=\n\s*\n|\n---|\n#|$)/i);
  if (changeEventsMatch) {
    const changesText = changeEventsMatch[1];
    // Find patterns like "Page 8 (...→ standard)" or "Page 8 (change to: winter)"
    const changePattern = /Page\s+(\d+)\s*[:\(][^)]*?(?:→|->|change\s+to:?\s*)\s*(winter|summer|formal|standard)/gi;
    let match;
    while ((match = changePattern.exec(changesText)) !== null) {
      const pageNum = parseInt(match[1]);
      const clothing = match[2].toLowerCase();
      result.pageClothing[pageNum] = clothing;
      log.debug(`[PAGE CLOTHING] Page ${pageNum} changes to: ${clothing}`);
    }
  }

  // Pattern 3: Parse per-page clothing in page breakdown
  // Format: "**Clothing:** [same]" or "**Clothing:** [change to: winter]" or "Clothing: summer"
  let currentPage = 0;
  let lastClothing = result.primaryClothing;

  for (const line of lines) {
    // Detect page header: "Page 1:", "**Page 3:**", "---PAGE 5---"
    const pageHeaderMatch = line.match(/(?:\*\*)?Page\s+(\d+)(?:\*\*)?[:\s]|^---\s*PAGE\s+(\d+)\s*---/i);
    if (pageHeaderMatch) {
      currentPage = parseInt(pageHeaderMatch[1] || pageHeaderMatch[2]);
      continue;
    }

    // If we're in a page section, look for clothing info
    if (currentPage > 0) {
      // Match clothing specification
      const clothingMatch = line.match(/(?:\*\*)?Clothing(?:\*\*)?:\s*(?:\[|\*\*)?\s*(same|change\s+to:?\s*(winter|summer|formal|standard)|(winter|summer|formal|standard))/i);
      if (clothingMatch) {
        if (clothingMatch[1].toLowerCase() === 'same') {
          result.pageClothing[currentPage] = lastClothing;
        } else if (clothingMatch[2]) {
          // "change to: winter" format
          result.pageClothing[currentPage] = clothingMatch[2].toLowerCase();
          lastClothing = result.pageClothing[currentPage];
        } else if (clothingMatch[3]) {
          // Direct value "Clothing: winter"
          result.pageClothing[currentPage] = clothingMatch[3].toLowerCase();
          lastClothing = result.pageClothing[currentPage];
        }
      }
    }
  }

  // Log summary of clothing changes
  const changes = Object.entries(result.pageClothing)
    .filter(([page, clothing]) => clothing !== result.primaryClothing)
    .map(([page, clothing]) => `P${page}:${clothing}`);
  if (changes.length > 0) {
    log.debug(`[PAGE CLOTHING] Changes from primary (${result.primaryClothing}): ${changes.join(', ')}`);
  }

  return result;
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

  // Add German language note if applicable
  const language = inputData.language || 'en';
  const languageNote = language === 'de' || language === 'German'
    ? ' (use ae, oe, ue normally. Do not use ss, use ss instead)'
    : '';

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

  // Use template if available, otherwise fall back to hardcoded prompt
  if (PROMPT_TEMPLATES.outline) {
    const prompt = fillTemplate(PROMPT_TEMPLATES.outline, {
      TITLE: inputData.title || 'Untitled',
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: pageCount,  // Use calculated page count, not raw input
      LANGUAGE: inputData.language || 'en',
      READING_LEVEL: readingLevel,
      CHARACTERS: JSON.stringify(characterSummary),
      CHARACTER_NAMES: characterNames,  // For Visual Bible exclusion warning
      STORY_TYPE: inputData.storyType || 'adventure',
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

  // Build detailed character descriptions - include full physical details from Visual Bible
  const characterDetails = characters.map(c => {
    // Check if character has detailed description in Visual Bible
    let visualBibleDesc = null;
    if (visualBible && visualBible.mainCharacters) {
      const vbChar = visualBible.mainCharacters.find(vbc =>
        vbc.id === c.id || vbc.name.toLowerCase().trim() === c.name.toLowerCase().trim()
      );

      if (vbChar && vbChar.physical) {
        vbMatches.push(c.name);
        // Build description from Visual Bible physical object - include ALL traits
        const vbParts = [];
        // Basic traits
        if (vbChar.physical.age && vbChar.physical.age !== 'Unknown') vbParts.push(`${vbChar.physical.age} years old`);
        if (vbChar.physical.gender && vbChar.physical.gender !== 'Unknown') vbParts.push(vbChar.physical.gender);
        if (vbChar.physical.height && vbChar.physical.height !== 'Unknown') vbParts.push(`${vbChar.physical.height} cm tall`);
        if (vbChar.physical.build && vbChar.physical.build !== 'Unknown') vbParts.push(`${vbChar.physical.build} build`);
        // Detailed features
        if (vbChar.physical.face) vbParts.push(vbChar.physical.face);
        if (vbChar.physical.hair) vbParts.push(`Hair: ${vbChar.physical.hair}`);
        // Other physical traits (glasses, birthmarks, always-present accessories)
        if (vbChar.physical.other && vbChar.physical.other !== 'none') vbParts.push(`Other: ${vbChar.physical.other}`);
        if (vbParts.length > 0) {
          visualBibleDesc = vbParts.join(' | ');
        }
      } else {
        vbMisses.push(c.name);
      }
    }

    // Build comprehensive physical description from character data
    const physicalParts = [];

    // Basic info
    if (c.age) physicalParts.push(`${c.age} years old`);
    if (c.gender) physicalParts.push(c.gender === 'male' ? 'male' : c.gender === 'female' ? 'female' : 'non-binary');

    // Physical traits (support both snake_case and camelCase)
    const face = c.other_features || c.otherFeatures || c.face;
    const hair = c.hair_color || c.hairColor;
    const build = c.build;
    const other = c.other;

    if (face) physicalParts.push(`Face: ${face}`);
    if (hair) physicalParts.push(`Hair: ${hair}`);
    if (build) physicalParts.push(`Build: ${build}`);
    if (other && other !== 'none') physicalParts.push(`Other: ${other}`);

    // Additional features
    if (c.otherFeatures) physicalParts.push(c.otherFeatures);
    if (c.specialDetails) physicalParts.push(c.specialDetails);

    // Use Visual Bible description if available (preferred), otherwise use character data
    const physicalDesc = visualBibleDesc || physicalParts.join('. ');

    return `* **${c.name}:**\n  PHYSICAL: ${physicalDesc}`;
  }).join('\n\n');

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
      LANGUAGE: language
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
function buildImagePrompt(sceneDescription, inputData, sceneCharacters = null, isSequential = false, visualBible = null, pageNumber = null, isStorybook = false) {
  // Build image generation prompt (matches step-by-step format)
  // For storybook mode: visualBible entries are added here since there's no separate scene description step
  // For parallel/sequential modes: Visual Bible is also in scene description, but adding here ensures consistency
  const artStyleId = inputData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;
  const language = (inputData.language || 'en').toLowerCase();

  // Build character reference list (Option B: explicit labeling in prompt)
  let characterReferenceList = '';
  if (sceneCharacters && sceneCharacters.length > 0) {
    log.debug(`[IMAGE PROMPT] Scene characters: ${sceneCharacters.map(c => c.name).join(', ')}`);

    // Build a numbered list of characters with full physical descriptions INCLUDING CLOTHING
    const charDescriptions = sceneCharacters.map((char, index) => {
      const age = char.age ? `${char.age} years old` : '';
      const gender = char.gender === 'male' ? 'boy/man' : char.gender === 'female' ? 'girl/woman' : '';
      // Include physical traits with labels (excluding height - AI doesn't understand it for images)
      const physical = char.physical;
      // Get clothing COLORS from character analysis - used for avatar color matching
      // Avatar determines the style (coat, hoodie, t-shirt), we just need the colors to match
      const clothingColors = char.clothingColors || char.clothing_colors || char.clothing?.colors;
      if (clothingColors) {
        log.debug(`[IMAGE PROMPT] ${char.name} clothing colors: "${clothingColors}"`);
      } else {
        log.debug(`[IMAGE PROMPT] ${char.name} has no clothing color info`);
      }
      const physicalParts = [
        physical?.build ? `Build: ${physical.build}` : '',
        physical?.face ? `Face: ${physical.face}` : '',
        physical?.hair ? `Hair: ${physical.hair}` : '',
        physical?.other ? `Other: ${physical.other}` : '',
        clothingColors ? `CLOTHING COLORS (MUST MATCH): ${clothingColors}` : ''
      ].filter(Boolean);
      const physicalDesc = physicalParts.length > 0 ? physicalParts.join('. ') : '';
      const brief = [char.name, age, gender, physicalDesc].filter(Boolean).join(', ');
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
      SCENE_DESCRIPTION: sceneDescription,
      CHARACTER_REFERENCE_LIST: characterReferenceList,
      VISUAL_BIBLE: visualBibleSection,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8
    });
  }

  // Fallback to hardcoded prompt
  return `Create a cinematic scene in ${styleDescription}.

${characterReferenceList}
Scene Description: ${sceneDescription}
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
  let template = null;

  if (langCode === 'de' && PROMPT_TEMPLATES.sceneExpansionDe) {
    template = PROMPT_TEMPLATES.sceneExpansionDe;
  } else if (langCode === 'fr' && PROMPT_TEMPLATES.sceneExpansionFr) {
    template = PROMPT_TEMPLATES.sceneExpansionFr;
  } else if (PROMPT_TEMPLATES.sceneExpansion) {
    template = PROMPT_TEMPLATES.sceneExpansion;
  }

  if (template) {
    return fillTemplate(template, {
      SCENE_SUMMARY: sceneSummary,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      LANGUAGE: langCode === 'de' ? 'Deutsch' : langCode === 'fr' ? 'Français' : 'English'
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

  // Character helpers
  getCharactersInScene,
  getCharacterPhotos,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildRelativeHeightDescription,

  // Parsers
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,

  // Prompt builders
  buildBasePrompt,
  buildStoryPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildSceneExpansionPrompt
};
