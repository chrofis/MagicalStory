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
const { OutlineParser, UnifiedStoryParser, extractCharacterNamesFromScene } = require('./outlineParser');
const { getLanguageNote, getLanguageInstruction, getLanguageNameEnglish } = require('./languages');
const { getEventById } = require('./historicalEvents');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format a clothing object into a readable string
 * @param {Object} clothingObj - Object with upperBody, lowerBody, shoes, fullBody properties
 * @returns {string} Formatted clothing description
 */
function formatClothingObject(clothingObj) {
  if (!clothingObj) return '';
  if (typeof clothingObj === 'string') return clothingObj;

  const parts = [];
  if (clothingObj.fullBody) {
    parts.push(clothingObj.fullBody);
  } else {
    if (clothingObj.upperBody) parts.push(clothingObj.upperBody);
    if (clothingObj.lowerBody) parts.push(clothingObj.lowerBody);
  }
  if (clothingObj.shoes) parts.push(clothingObj.shoes);

  return parts.join(', ');
}

/**
 * Build detailed hair description using both simple fields and detailedHairAnalysis
 * Uses detailed analysis when available for better consistency across scenes
 * User-edited values (from physicalTraitsSource) take priority over auto-extracted values
 * @param {Object} physical - Physical traits object containing hair fields
 * @param {Object} physicalTraitsSource - Optional object tracking source of each trait ('photo', 'extracted', 'user')
 * @returns {string} Formatted hair description (without "Hair:" prefix)
 */
function buildHairDescription(physical, physicalTraitsSource = null) {
  if (!physical) return '';

  const parts = [];
  const detailed = physical.detailedHairAnalysis;

  // Color (always use if available)
  if (physical.hairColor) parts.push(physical.hairColor);

  // Type/texture: User-edited hairStyle takes priority over detailed analysis
  // This allows users to correct "wavy" -> "ponytail" even if AI extracted "wavy" from photo
  if (physicalTraitsSource?.hairStyle === 'user' && physical.hairStyle) {
    // User explicitly set hairStyle - use it
    parts.push(physical.hairStyle);
  } else if (detailed?.type) {
    // Use detailed analysis type (wavy, curly, straight)
    parts.push(detailed.type);
  } else if (physical.hairStyle && !['messy', 'natural', 'tousled', 'styled'].includes(physical.hairStyle?.toLowerCase())) {
    // Only use simple hairStyle if it's specific (ponytail, braids, etc), not vague (messy)
    parts.push(physical.hairStyle);
  }

  // Length - use detailed analysis with descriptive terms (short, ear-length, shoulder-length, etc.)
  // Length scale: bald < buzz cut < short < ear-length < chin-length < neck-length < shoulder-length < mid-back < waist-length
  const lengthOrder = ['bald', 'buzz cut', 'shaved', 'short', 'ear-length', 'chin-length', 'neck-length', 'shoulder-length', 'mid-back', 'waist-length'];

  if (detailed?.lengthTop) {
    const topLength = detailed.lengthTop?.toLowerCase();
    const sidesLength = detailed.lengthSides?.toLowerCase();

    // Check if sides are significantly shorter than top (fade/undercut style)
    if (sidesLength && sidesLength !== 'same as top') {
      const topIdx = lengthOrder.indexOf(topLength);
      const sidesIdx = lengthOrder.indexOf(sidesLength);

      // If sides are at least 2 steps shorter than top, describe the difference
      if (topIdx >= 0 && sidesIdx >= 0 && topIdx - sidesIdx >= 2) {
        parts.push(`${sidesLength} on sides, ${topLength} on top`);
      } else if (topLength && topLength !== 'bald') {
        parts.push(topLength);
      }
    } else if (topLength && topLength !== 'bald') {
      // Uniform length - just use the top length
      parts.push(topLength);
    }
  } else if (physical.hairLength) {
    // Fall back to simple hairLength field
    parts.push(physical.hairLength);
  }

  // Bangs from detailed analysis
  if (detailed?.bangsEndAt && detailed.bangsEndAt !== 'no bangs') {
    parts.push(`bangs ${detailed.bangsEndAt}`);
  }

  // Parting/direction from detailed analysis (if specific)
  if (detailed?.direction && !['natural', 'back', 'forward'].includes(detailed.direction)) {
    parts.push(detailed.direction);
  }

  // If no detailed parts, fall back to legacy hair field
  if (parts.length === 0 && physical.hair) {
    return physical.hair;
  }

  return parts.join(', ');
}

// ============================================================================
// JSON METADATA EXTRACTION - Parse structured data from scene descriptions
// ============================================================================

/**
 * Extract JSON object from a string that may have text before/after it or be wrapped in code blocks
 * @param {string} text - Raw text that may contain JSON
 * @returns {Object|null} Parsed JSON object or null if not found
 */
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  let jsonToParse = text.trim();

  // First, try to extract from ```json ... ``` code block
  const codeBlockMatch = jsonToParse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Code block content wasn't valid JSON, continue
    }
  }

  // Try parsing the whole thing as JSON
  try {
    return JSON.parse(jsonToParse);
  } catch (e) {
    // Not direct JSON, try to find JSON object
  }

  // Find the first { and try to extract a balanced JSON object
  const jsonStart = jsonToParse.indexOf('{');
  if (jsonStart === -1) return null;

  // Try progressively longer substrings starting from {
  // This handles cases where there's trailing text after the JSON
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = jsonStart; i < jsonToParse.length; i++) {
    const char = jsonToParse[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          // Found a complete JSON object
          try {
            return JSON.parse(jsonToParse.substring(jsonStart, i + 1));
          } catch (e) {
            // Not valid JSON, continue looking
          }
        }
      }
    }
  }

  return null;
}

/**
 * Build readable text from JSON scene description output
 * Converts the structured JSON to markdown text for image generation prompt
 * @param {Object} output - The output section from JSON scene description
 * @returns {string} Formatted text for image prompt
 */
function buildTextFromJson(output) {
  if (!output) return '';

  let text = '';

  // Section 1: Image Summary
  if (output.imageSummary) {
    text += `## 1. Image Summary\n${output.imageSummary}\n\n`;
  }

  // Section 2: Setting & Atmosphere & Camera
  if (output.setting) {
    text += `## 2. Setting & Atmosphere & Camera\n`;
    if (output.setting.location) {
      text += `**${output.setting.location}**: `;
    }
    if (output.setting.description) {
      text += `${output.setting.description} `;
    }
    if (output.setting.lighting) {
      text += `${output.setting.lighting}. `;
    }
    text += '\n';
    if (output.setting.camera) {
      text += `Camera: ${output.setting.camera}\n`;
    }
    if (output.setting.depthLayers) {
      text += `Depth layers: ${output.setting.depthLayers}\n`;
    }
    text += '\n';
  }

  // Section 3: Character Composition
  if (output.characters && output.characters.length > 0) {
    text += `## 3. Character Composition\n\n`;
    for (const char of output.characters) {
      text += `**${char.name}:**\n`;
      if (char.position) text += `- POSITION: ${char.position}\n`;
      if (char.pose) text += `- POSE: ${char.pose}\n`;
      if (char.action) text += `- ACTION: ${char.action}\n`;
      if (char.expression) text += `- EXPRESSION: ${char.expression}\n`;
      text += '\n';
    }
  }

  // Section 4: Objects & Animals
  if (output.objects && output.objects.length > 0) {
    text += `## 4. Objects & Animals\n`;
    for (const obj of output.objects) {
      const idPart = obj.id ? ` [${obj.id}]` : '';
      text += `* ${obj.name}${idPart}: ${obj.position || 'in scene'}\n`;
    }
    text += '\n';
  }

  return text.trim();
}

/**
 * Strip JSON metadata block and translated summary from scene description (for image prompts)
 * Supports two formats:
 * 1. NEW: Full JSON - extracts output section and converts to text
 * 2. LEGACY: Markdown - removes thinking sections, JSON block, and translated summary
 * @param {string} sceneDescription - The scene description text
 * @returns {string} Clean scene description for image generation
 */
function stripSceneMetadata(sceneDescription) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return sceneDescription;

  // Try NEW JSON format first using robust extraction
  const parsed = extractJsonFromText(sceneDescription);
  if (parsed && parsed.output) {
    // Convert structured JSON to text for image prompt
    return buildTextFromJson(parsed.output);
  }

  // LEGACY: Regex-based stripping for markdown format
  let stripped = sceneDescription;

  // Remove DRAFT section (STEP 1) - internal process, not needed for image generation
  // Handles: "# STEP 1 - DRAFT", "**STEP 1 - DRAFT**", "DRAFT:", etc.
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*1\s*[-–]\s*DRAFT:?\s*\n[\s\S]*?(?=\n#{1,3}\s*STEP\s*2|\n\*{0,2}STEP\s*2)/gi, '')
    .replace(/\n*\*{0,2}(?:STEP\s*1\s*[-–]?\s*)?DRAFT\*{0,2}:?\s*\n[\s\S]*?(?=\n\*{0,2}(?:STEP\s*2|(?:CONNECTION\s*)?REVIEW|CRITICISM))/gi, '')
    .trim();

  // Remove REVIEW / CONNECTION REVIEW / CRITICISM section (STEP 2) - internal process
  // Handles: "# STEP 2 - REVIEW", "# STEP 2 - CONNECTION REVIEW", "**STEP 2 - REVIEW:**", etc.
  // End markers: "# STEP 3", "## 1. Image", "**1. Image", "---\n## 1.", "FINAL OUTPUT", or end of string
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*2\s*[-–]\s*(?:CONNECTION\s*)?REVIEW:?\s*\n[\s\S]*?(?=\n#{1,3}\s*(?:STEP\s*3|1\.)|---\s*\n+#{1,3}\s*1\.|\n\*{0,2}(?:STEP\s*3|FINAL)|$)/gi, '')
    .replace(/\n*\*{0,2}(?:STEP\s*2\s*[-–]?\s*)?(?:(?:CONNECTION\s*)?REVIEW|CRITICISM)\*{0,2}:?\s*\n[\s\S]*?(?=\n#{1,3}\s*1\.|\n\*{0,2}(?:STEP\s*3|FINAL\s*OUTPUT|1\.\s*\*{0,2}Image)|$)/gi, '')
    .trim();

  // Remove FINAL OUTPUT header (STEP 3) - keep the content, just remove the header
  // Handles: "# STEP 3 - FINAL OUTPUT", "**FINAL OUTPUT**", etc.
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*3\s*[-–]\s*FINAL\s*OUTPUT\s*\n*/gi, '\n')
    .replace(/\n*\*{0,2}(?:STEP\s*3\s*[-–]?\s*)?FINAL\s*OUTPUT\*{0,2}:?\s*\n*/gi, '\n')
    .trim();

  // Remove section header and JSON block: "5. **METADATA (JSON):**\n```json\n...\n```" or just "```json\n...\n```"
  // Also handle variations like "**METADATA:**" or just the JSON block
  stripped = stripped
    .replace(/\n*\d*\.?\s*\*{0,2}METADATA\s*\(?JSON\)?\*{0,2}:?\s*\n*```json[\s\S]*?```\n*/gi, '\n')
    .replace(/```json[\s\S]*?```\n*/gi, '')
    .trim();

  // Remove section 6 (translated summary) - redundant for image generation
  // Matches: "6. **Image Summary (Deutsch)**\n..." or "6. **Image Summary (French)**\n..." etc.
  stripped = stripped
    .replace(/\n*\d+\.?\s*\*{0,2}Image Summary\s*\([^)]+\)\*{0,2}:?\s*\n[\s\S]*$/gi, '')
    .trim();

  // Clean up malformed markdown at the start (e.g., ")**" from partial section headers)
  // This can happen when scene descriptions are incorrectly parsed or generated
  stripped = stripped
    .replace(/^[\s\n]*\)*\*{1,2}\s*/g, '') // Remove leading )** or )* with whitespace
    .replace(/^[\s\n]*\*{1,2}\)*\s*/g, '') // Remove leading **) or *)
    .trim();

  return stripped;
}

/**
 * Extract metadata from scene description
 * Supports two formats:
 * 1. NEW: Full JSON with thinking.draft, thinking.review, output.* fields
 * 2. LEGACY: Markdown with embedded ```json block
 * @param {string} sceneDescription - The scene description text
 * @returns {Object|null} Parsed metadata or null if not found/invalid
 */
function extractSceneMetadata(sceneDescription) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Try NEW JSON format first using robust extraction
  const parsed = extractJsonFromText(sceneDescription);
  if (parsed && parsed.output && parsed.output.characters) {
    // Extract per-character clothing
    const characterClothing = {};
    const characterNames = [];
    for (const char of parsed.output.characters) {
      if (char.name) {
        characterNames.push(char.name);
        if (char.clothing) {
          characterClothing[char.name] = char.clothing;
        }
      }
    }

    // Extract object IDs
    const objectIds = (parsed.output.objects || []).map(obj =>
      obj.id ? `${obj.name} [${obj.id}]` : obj.name
    );

    // Also extract location from setting.location (e.g., "Kurpark [LOC001]")
    // This ensures landmark photos are passed to image generation
    if (parsed.output.setting?.location) {
      const locMatch = parsed.output.setting.location.match(/\[LOC\d+\]/i);
      if (locMatch) {
        objectIds.push(parsed.output.setting.location);
      }
    }

    return {
      characters: characterNames,
      characterClothing: Object.keys(characterClothing).length > 0 ? characterClothing : null,
      clothing: null, // Per-character now, no single value
      objects: objectIds,
      // Store full parsed data for buildTextFromJson
      fullData: parsed.output,
      thinking: parsed.thinking || null,
      // Extract translated summary for display in user's language
      translatedSummary: parsed.output.translatedSummary || null,
      // Extract image summary (English) for reference
      imageSummary: parsed.output.imageSummary || null,
      isJsonFormat: true
    };
  }

  // LEGACY: Look for ```json block in markdown
  const jsonBlockMatch = sceneDescription.match(/```json\s*([\s\S]*?)```/i);
  if (!jsonBlockMatch || !jsonBlockMatch[1]) {
    return null;
  }

  try {
    const jsonStr = jsonBlockMatch[1].trim();
    const metadata = JSON.parse(jsonStr);

    // Validate expected fields
    if (!metadata.characters || !Array.isArray(metadata.characters)) {
      return null;
    }

    return {
      characters: metadata.characters || [],
      // Support both new per-character format and legacy single-value format
      characterClothing: metadata.characterClothing || null,
      clothing: metadata.clothing || null, // Legacy support
      objects: metadata.objects || [],
      isJsonFormat: false
    };
  } catch (e) {
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

  } catch (err) {
    log.error(`Error loading teaching guide file ${filePath}:`, err.message);
  }
  return guides;
}

// Load teaching guides at startup
const PROMPTS_DIR = path.join(__dirname, '../../prompts');
const EDUCATIONAL_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'educational-guides.txt'));
const LIFE_CHALLENGE_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'life-challenge-guides.txt'));
const ADVENTURE_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'adventure-guides.txt'));
const HISTORICAL_GUIDES = parseTeachingGuideFile(path.join(PROMPTS_DIR, 'historical-guides.txt'));

/**
 * Get teaching guide for a specific topic
 * @param {string} category - 'educational', 'life-challenge', 'adventure', or 'historical'
 * @param {string} topicId - The topic ID (e.g., 'months-year', 'potty-training', 'pirate', 'moon-landing')
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
  } else if (category === 'adventure') {
    return ADVENTURE_GUIDES.get(normalizedId) || null;
  } else if (category === 'historical') {
    return HISTORICAL_GUIDES.get(normalizedId) || null;
  }
  return null;
}

// Historical Locations Databank
const HISTORICAL_LOCATIONS_FILE = path.join(__dirname, '../data/historical-locations.json');
let historicalLocationsCache = null;

/**
 * Load historical locations databank (lazy loading with cache)
 * @returns {Object|null} The databank object or null if not available
 */
function loadHistoricalLocationsDatabank() {
  if (historicalLocationsCache !== null) {
    log.debug(`[LOCATIONS] Using cached databank with ${Object.keys(historicalLocationsCache).length} events`);
    return historicalLocationsCache;
  }

  log.info(`[LOCATIONS] Loading historical locations from: ${HISTORICAL_LOCATIONS_FILE}`);
  try {
    if (fs.existsSync(HISTORICAL_LOCATIONS_FILE)) {
      historicalLocationsCache = JSON.parse(fs.readFileSync(HISTORICAL_LOCATIONS_FILE, 'utf-8'));
      const eventIds = Object.keys(historicalLocationsCache);
      log.info(`[LOCATIONS] Loaded historical locations databank with ${eventIds.length} events: ${eventIds.slice(0, 5).join(', ')}${eventIds.length > 5 ? '...' : ''}`);
    } else {
      log.warn(`[LOCATIONS] Historical locations databank NOT FOUND at: ${HISTORICAL_LOCATIONS_FILE}`);
      historicalLocationsCache = {};
    }
  } catch (err) {
    log.warn(`[LOCATIONS] Error loading historical locations databank: ${err.message}`);
    historicalLocationsCache = {};
  }

  return historicalLocationsCache;
}

/**
 * Get pre-fetched location photos for a historical event
 * Randomly selects one photo per location for variety
 * @param {string} eventId - The historical event ID (e.g., 'moon-landing', 'pyramids')
 * @returns {Array} Array of location objects with randomly selected photo
 */
function getHistoricalLocations(eventId) {
  if (!eventId) {
    log.debug(`[LOCATIONS] getHistoricalLocations called with no eventId`);
    return [];
  }

  log.info(`[LOCATIONS] Getting locations for event: ${eventId}`);
  const databank = loadHistoricalLocationsDatabank();
  const eventData = databank[eventId];

  if (!eventData?.locations?.length) {
    log.warn(`[LOCATIONS] No locations found for event: ${eventId} (event exists: ${!!eventData})`);
    return [];
  }

  log.info(`[LOCATIONS] Found ${eventData.locations.length} locations for ${eventId}`);

  // For each location, randomly pick one of the stored photos
  return eventData.locations.map(loc => {
    if (!loc.photos || loc.photos.length === 0) {
      return {
        name: loc.name,
        type: loc.type,
        hasPhoto: false
      };
    }

    // Random selection from available photos
    const randomPhoto = loc.photos[Math.floor(Math.random() * loc.photos.length)];

    return {
      name: loc.name,
      type: loc.type,
      query: loc.query,
      description: randomPhoto.description,
      photoUrl: randomPhoto.photoUrl,
      photoData: randomPhoto.photoData,
      attribution: randomPhoto.attribution,
      hasPhoto: true
    };
  }).filter(loc => loc.hasPhoto);
}

/**
 * Get adventure theme guide directly (for always including in story ideas)
 * @param {string} themeId - The adventure theme ID (e.g., 'pirate', 'knight', 'wizard')
 * @returns {string|null} The adventure guide content or null if not found
 */
function getAdventureGuide(themeId) {
  if (!themeId) return null;
  const normalizedId = themeId.toLowerCase().replace(/\s+/g, '-');
  return ADVENTURE_GUIDES.get(normalizedId) || null;
}

/**
 * Get scene complexity guide based on number of scenes
 * Provides guidance on story complexity for different scene counts
 * @param {number} sceneCount - Number of scenes/illustrations in the story
 * @returns {string} Complexity guide text
 */
function getSceneComplexityGuide(sceneCount) {
  if (sceneCount <= 5) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- SUPER SIMPLE - one clear problem, one solution
- Single storyline only, no subplots
- 2-3 main events maximum
- Very straightforward cause-and-effect`;
  } else if (sceneCount <= 10) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Simple but engaging story
- One main storyline with 1-2 obstacles
- 4-5 key events
- Can include a small twist or surprise`;
  } else if (sceneCount <= 20) {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Moderate complexity
- Main storyline PLUS one secondary element or subplot
- At least 2 interwoven themes or character developments
- 6-8 key events with meaningful progression`;
  } else {
    return `STORY COMPLEXITY (${sceneCount} scenes):
- Rich, multi-layered story told concisely
- Main storyline with key turning points and resolution
- 2-3 interwoven themes or character developments
- Focus on main plot arc - describe in 8 sentences or less`;
  }
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
  if (!sceneDescription || typeof sceneDescription !== 'string' || !characters || characters.length === 0) {
    return [];
  }

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.characters && metadata.characters.length > 0) {
    // Match JSON character names to available characters
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      return metadata.characters.some(jsonName => {
        const jsonLower = jsonName.toLowerCase().trim();
        return jsonLower === nameLower ||
               jsonLower === firstName ||
               jsonLower.includes(nameLower) ||
               nameLower.includes(jsonLower) ||
               jsonLower.includes(firstName) ||
               firstName.includes(jsonLower);
      });
    });

    if (matchedCharacters.length > 0) {
      return matchedCharacters;
    }
  }

  // Step 1: Use robust markdown parser to extract character names
  const parsedNames = extractCharacterNamesFromScene(sceneDescription);

  if (parsedNames.length > 0) {
    // Match main characters whose names appear in the parsed list
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      return parsedNames.some(parsed =>
        parsed === nameLower ||
        parsed === firstName ||
        parsed.includes(nameLower) ||
        nameLower.includes(parsed) ||
        parsed.includes(firstName) ||
        firstName.includes(parsed)
      );
    });

    if (matchedCharacters.length > 0) {
      return matchedCharacters;
    }
  }

  // Step 2: Fallback to simple text matching if parser found nothing
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
 * @param {string} clothingCategory - Optional clothing category (winter, summer, formal, standard, costumed)
 * @returns {Array} Array of photo URLs for image generation
 */
function getCharacterPhotos(characters, clothingCategory = null) {
  if (!characters || characters.length === 0) return [];

  // Helper to extract URL from avatar data (handles object format)
  const extractUrl = (avatarData) => {
    if (!avatarData) return null;
    if (typeof avatarData === 'string') return avatarData;
    if (typeof avatarData === 'object' && avatarData.imageData) return avatarData.imageData;
    return null;
  };

  // Fallback priority for clothing avatars (same as getCharacterPhotoDetails)
  const clothingFallbackOrder = {
    winter: ['standard', 'formal', 'summer'],
    summer: ['standard', 'formal', 'winter'],
    formal: ['standard', 'winter', 'summer'],
    standard: ['formal', 'summer', 'winter'],
    costumed: ['standard', 'formal']
  };

  return characters
    .map(char => {
      // Support both avatar structures (char.avatars and char.clothingAvatars)
      const avatars = char.avatars || char.clothingAvatars;

      // Handle costumed category - auto-detect costume type
      if (clothingCategory === 'costumed' && avatars?.costumed) {
        const availableCostumes = Object.keys(avatars.costumed);
        if (availableCostumes.length > 0) {
          const url = extractUrl(avatars.costumed[availableCostumes[0]]);
          if (url) return url;
        }
      }

      // If clothing category specified and character has clothing avatar for it, use it
      if (clothingCategory && clothingCategory !== 'costumed' && avatars && avatars[clothingCategory]) {
        return extractUrl(avatars[clothingCategory]);
      }

      // Try fallback clothing categories before falling back to body photos
      if (clothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[clothingCategory] || ['standard', 'formal', 'summer', 'winter'];
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            log.debug(`[AVATAR FALLBACK] ${char.name}: wanted ${clothingCategory}, using ${fallbackCategory}`);
            return extractUrl(avatars[fallbackCategory]);
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
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.clothing) {
    const clothingLower = metadata.clothing.toLowerCase();

    // Handle "costumed:pirate" format (return full string for sub-type parsing)
    if (clothingLower.startsWith('costumed:')) {
      log.debug(`[CLOTHING] Using JSON metadata: "${metadata.clothing}" (costumed with sub-type)`);
      return metadata.clothing.toLowerCase();
    }

    // Standard categories
    const validValues = ['winter', 'summer', 'standard', 'costumed'];
    if (validValues.includes(clothingLower)) {
      log.debug(`[CLOTHING] Using JSON metadata: "${clothingLower}"`);
      return clothingLower;
    }

    // Backwards compatibility: map 'formal' to 'standard'
    if (clothingLower === 'formal') {
      log.debug(`[CLOTHING] Mapping legacy "formal" to "standard"`);
      return 'standard';
    }
  }

  // Fallback: Generic approach - find "Clothing" keyword (in any language) and look for value nearby
  // Handles any markdown: **, *, --, __, ##, etc.

  // Markdown chars that might wrap keywords or values
  const md = '[\\*_\\-#\\s\\.\\d]*';

  // Clothing keywords in multiple languages
  const keywords = '(?:Clothing|Kleidung|Vêtements|Tenue)';

  // Valid clothing values (including costumed with optional sub-type)
  const values = '(winter|summer|standard|costumed(?::[a-z]+)?)';

  // Pattern 1: Same line - keyword and value on same line with any markdown/separators
  // Handles: **Clothing:** winter, *Clothing*: **winter**, --Clothing--: winter, ## 4. Clothing: winter
  const sameLineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + values, 'i')
  );
  if (sameLineMatch) {
    const value = sameLineMatch[1].toLowerCase();
    // Map formal to standard
    return value === 'formal' ? 'standard' : value;
  }

  // Pattern 2: Value on next line - handles any markdown formatting
  // Handles: **Clothing:**\n**winter**, ## Clothing\n*winter*, Clothing:\nwinter
  const multilineMatch = sceneDescription.match(
    new RegExp(keywords + md + ':?' + md + '\\n' + md + values + md, 'i')
  );
  if (multilineMatch) {
    const value = multilineMatch[1].toLowerCase();
    return value === 'formal' ? 'standard' : value;
  }

  // Pattern 3: Fallback - find keyword and look for value within next 100 chars
  const keywordMatch = sceneDescription.match(new RegExp(keywords, 'i'));
  if (keywordMatch) {
    const startIndex = keywordMatch.index;
    const nearbyText = sceneDescription.substring(startIndex, startIndex + 100);
    const valueMatch = nearbyText.match(/\b(winter|summer|standard|costumed(?::[a-z]+)?)\b/i);
    if (valueMatch) {
      const value = valueMatch[1].toLowerCase();
      return value === 'formal' ? 'standard' : value;
    }

    // Check for legacy 'formal' value
    const formalMatch = nearbyText.match(/\bformal\b/i);
    if (formalMatch) {
      log.debug(`[CLOTHING] Mapping legacy "formal" to "standard"`);
      return 'standard';
    }

    // Found keyword but no valid value - log warning
    if (warnOnInvalid) {
      // Extract what value was actually there (first word after colon)
      const invalidValueMatch = nearbyText.match(/:\s*\*{0,2}(\w+)/i);
      const invalidValue = invalidValueMatch ? invalidValueMatch[1] : 'unknown';
      log.warn(`[CLOTHING] Invalid clothing value "${invalidValue}" found, defaulting to standard. Valid values: winter, summer, standard, costumed`);
    }
  }

  return null;
}

/**
 * Parse per-character clothing from scene description metadata
 * Returns a map of character name to clothing category
 * @param {string} sceneDescription - The scene description text
 * @returns {Object|null} Map of {characterName: clothingCategory} or null if not found
 */
function parseCharacterClothing(sceneDescription) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.characterClothing && typeof metadata.characterClothing === 'object') {
    // Normalize keys to handle case differences
    const normalized = {};
    for (const [name, clothing] of Object.entries(metadata.characterClothing)) {
      if (typeof clothing === 'string') {
        normalized[name] = clothing.toLowerCase();
      }
    }
    if (Object.keys(normalized).length > 0) {
      log.debug(`[CLOTHING] Per-character clothing from metadata: ${JSON.stringify(normalized)}`);
      return normalized;
    }
  }

  // Fallback: if we have legacy single clothing value, we can't determine per-character
  // Return null and let caller use the legacy parseClothingCategory
  return null;
}

/**
 * Get detailed photo info for characters (for dev mode display)
 * @param {Array} characters - Array of character objects
 * @param {string} clothingCategory - Optional clothing category to show which avatar is used
 * @param {string} costumeType - Optional costume type for 'costumed' category (e.g., 'pirate', 'superhero')
 * @param {string} artStyle - Optional art style to look for styled avatars first
 * @param {Object} clothingRequirements - Optional per-character clothing requirements from outline
 * @returns {Array} Array of objects with character name and photo type used
 */
function getCharacterPhotoDetails(characters, clothingCategory = null, costumeType = null, artStyle = null, clothingRequirements = null) {
  if (!characters || characters.length === 0) return [];

  // Fallback priority for clothing avatars when exact match not found
  // Note: 'formal' replaced by 'costumed' but kept for backwards compatibility
  const clothingFallbackOrder = {
    winter: ['standard', 'summer'],
    summer: ['standard', 'winter'],
    standard: ['summer', 'winter'],
    costumed: ['standard']  // Costumed falls back to standard
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

      // Check for per-character clothing from scene (_currentClothing field)
      // This overrides the default clothingCategory for this specific character
      let effectiveClothingCategory = clothingCategory;
      let effectiveCostumeType = costumeType;
      if (clothingRequirements && clothingRequirements[char.name]?._currentClothing) {
        const charCurrentClothing = clothingRequirements[char.name]._currentClothing;
        if (charCurrentClothing.startsWith('costumed:')) {
          effectiveClothingCategory = 'costumed';
          effectiveCostumeType = charCurrentClothing.split(':')[1];
          log.debug(`[AVATAR LOOKUP] ${char.name}: per-scene clothing = ${charCurrentClothing}`);
        } else {
          effectiveClothingCategory = charCurrentClothing;
          effectiveCostumeType = null;
          log.debug(`[AVATAR LOOKUP] ${char.name}: per-scene clothing = ${effectiveClothingCategory}`);
        }
      }

      // Handle costumed category - check styled avatars first, then regular costumed
      if (effectiveClothingCategory === 'costumed') {
        // If specific costumeType provided, use it; otherwise look up from clothingRequirements
        let costumeKey = effectiveCostumeType?.toLowerCase();

        // Look up costume type from clothingRequirements (per-character)
        // clothingRequirements can be:
        // - Nested: { "CharName": { "costumed": { "costume": "superhero", "used": true } } }
        // - Flat: { "CharName": "costumed:superhero" }
        // - With _currentClothing: { "CharName": { "_currentClothing": "costumed:superhero" } }
        if (!costumeKey && clothingRequirements) {
          const charClothing = clothingRequirements[char.name];
          if (typeof charClothing === 'string' && charClothing.startsWith('costumed:')) {
            // Flat format
            costumeKey = charClothing.split(':')[1].toLowerCase();
            log.debug(`[AVATAR LOOKUP] ${char.name}: found costume "${costumeKey}" from flat clothingRequirements`);
          } else if (charClothing && typeof charClothing === 'object') {
            // Bug #11 fix: Handle multiple nested formats
            // Format 1: { _currentClothing: "costumed:X" } - check this first (already handled above, but double-check)
            if (charClothing._currentClothing && charClothing._currentClothing.startsWith('costumed:')) {
              costumeKey = charClothing._currentClothing.split(':')[1].toLowerCase();
              log.debug(`[AVATAR LOOKUP] ${char.name}: found costume "${costumeKey}" from _currentClothing`);
            }
            // Format 2: { costumed: { costume: "X", used: true } }
            else if (charClothing.costumed) {
              if (charClothing.costumed.costume) {
                // Accept costume even if 'used' is not explicitly true (backwards compat)
                // Many places set costume without the 'used' flag
                costumeKey = charClothing.costumed.costume.toLowerCase();
                log.debug(`[AVATAR LOOKUP] ${char.name}: found costume "${costumeKey}" from nested clothingRequirements (used: ${charClothing.costumed.used})`);
              }
            }
          }
        }

        // Auto-detect costume from styledAvatars or regular costumed (fallback)
        if (!costumeKey) {
          // First check styled avatars for this art style
          if (artStyle && avatars?.styledAvatars?.[artStyle]?.costumed) {
            const styledCostumes = Object.keys(avatars.styledAvatars[artStyle].costumed);
            if (styledCostumes.length > 0) {
              costumeKey = styledCostumes[0];
              log.debug(`[AVATAR AUTO-DETECT] ${char.name}: found styled costume "${costumeKey}" for ${artStyle}`);
            }
          }
          // Then check regular costumed avatars
          if (!costumeKey && avatars?.costumed) {
            const regularCostumes = Object.keys(avatars.costumed);
            if (regularCostumes.length > 0) {
              costumeKey = regularCostumes[0];
              log.debug(`[AVATAR AUTO-DETECT] ${char.name}: found costume "${costumeKey}"`);
            }
          }
        }

        if (costumeKey) {
          // Helper: find costume key by prefix match (handles truncated names from streaming)
          const findCostumeByPrefix = (costumeObj, prefix) => {
            if (!costumeObj || !prefix) return null;
            // First try exact match
            if (costumeObj[prefix]) return prefix;
            // Then try prefix match (e.g., "gla" matches "gladiator")
            const matchingKey = Object.keys(costumeObj).find(key => key.startsWith(prefix));
            if (matchingKey) {
              log.debug(`[AVATAR LOOKUP] Prefix match: "${prefix}" -> "${matchingKey}"`);
            }
            return matchingKey;
          };

          // Check styled costumed avatars (generated during this story's creation)
          // No fallback to base costumed - different stories have different costumes
          const foundKey = artStyle && findCostumeByPrefix(avatars?.styledAvatars?.[artStyle]?.costumed, costumeKey);

          if (foundKey) {
            let avatarData = avatars.styledAvatars[artStyle].costumed[foundKey];
            if (typeof avatarData === 'object' && avatarData.imageData) {
              photoUrl = avatarData.imageData;
              if (avatarData.clothing) {
                clothingDescription = typeof avatarData.clothing === 'string'
                  ? avatarData.clothing
                  : formatClothingObject(avatarData.clothing);
              }
            } else {
              photoUrl = avatarData;
            }
            photoType = `costumed-${foundKey}`;
            usedClothingCategory = `costumed:${foundKey}`;
            log.debug(`[AVATAR LOOKUP] ${char.name}: using styled costumed "${foundKey}"`);

            // Get clothing description from separate clothing object if not already set
            if (!clothingDescription && avatars?.clothing?.costumed?.[foundKey]) {
              const clothingData = avatars.clothing.costumed[foundKey];
              clothingDescription = typeof clothingData === 'string'
                ? clothingData
                : formatClothingObject(clothingData);
            }
          }
          // If not found, will fall through to standard avatar fallback below
        }
      }
      // Check styled avatars first (with signature items from this story)
      else if (effectiveClothingCategory && effectiveClothingCategory !== 'costumed' &&
               artStyle && avatars?.styledAvatars?.[artStyle]?.[effectiveClothingCategory]) {
        let avatarData = avatars.styledAvatars[artStyle][effectiveClothingCategory];
        if (typeof avatarData === 'object' && avatarData.imageData) {
          photoUrl = avatarData.imageData;
          if (avatarData.clothing) {
            clothingDescription = typeof avatarData.clothing === 'string'
              ? avatarData.clothing
              : formatClothingObject(avatarData.clothing);
          }
        } else {
          photoUrl = avatarData;
        }
        photoType = `styled-${effectiveClothingCategory}`;
        usedClothingCategory = effectiveClothingCategory;
        log.debug(`[AVATAR LOOKUP] ${char.name}: using styled ${effectiveClothingCategory} for ${artStyle}`);
      }
      // Fall back to unstyled clothing avatar (standard, winter, summer)
      else if (effectiveClothingCategory && effectiveClothingCategory !== 'costumed' && avatars && avatars[effectiveClothingCategory]) {
        photoType = `clothing-${effectiveClothingCategory}`;
        photoUrl = avatars[effectiveClothingCategory];
        usedClothingCategory = effectiveClothingCategory;
        // Get extracted clothing description for this avatar
        if (avatars.clothing && avatars.clothing[effectiveClothingCategory]) {
          const clothingData = avatars.clothing[effectiveClothingCategory];
          clothingDescription = typeof clothingData === 'string' ? clothingData : formatClothingObject(clothingData);
        }
        log.debug(`[AVATAR LOOKUP] ${char.name}: using unstyled ${effectiveClothingCategory} (no styled avatar found)`);
      }

      // Backwards compatibility: use legacy 'formal' avatar for costumed requests
      if (!photoUrl && effectiveClothingCategory === 'costumed' && avatars?.formal) {
        log.debug(`[AVATAR COMPAT] ${char.name}: Using legacy 'formal' avatar for costumed request`);
        photoType = 'clothing-formal';
        photoUrl = avatars.formal;
        usedClothingCategory = 'formal';
        if (avatars.clothing?.formal) {
          const clothingData = avatars.clothing.formal;
          clothingDescription = typeof clothingData === 'string' ? clothingData : formatClothingObject(clothingData);
        }
      }

      // Try fallback clothing avatars before falling back to body photo
      // NOTE: We skip styled avatar fallbacks - only use unstyled base avatars
      // applyStyledAvatars() will convert to target style via fresh cache
      if (!photoUrl && effectiveClothingCategory && avatars) {
        const fallbacks = clothingFallbackOrder[effectiveClothingCategory] || ['standard', 'summer', 'winter'];

        // Check unstyled avatars only (styling applied later via cache)
        for (const fallbackCategory of fallbacks) {
          if (avatars[fallbackCategory]) {
            photoType = `clothing-${fallbackCategory}`;
            photoUrl = avatars[fallbackCategory];
            usedClothingCategory = fallbackCategory;
            if (avatars.clothing && avatars.clothing[fallbackCategory]) {
              const clothingData = avatars.clothing[fallbackCategory];
              clothingDescription = typeof clothingData === 'string' ? clothingData : formatClothingObject(clothingData);
            }
            log.debug(`[AVATAR FALLBACK] ${char.name}: wanted ${effectiveClothingCategory}, using unstyled ${fallbackCategory}`);
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

      // Bug #9 fix: Log when no photo found for a character
      if (!photoUrl) {
        const searchedFor = effectiveClothingCategory || clothingCategory || 'any';
        const hasAvatars = !!avatars;
        const hasPhotos = Object.keys(photos).length > 0;
        log.warn(`[PHOTO LOOKUP] No photo found for "${char.name}" (wanted: ${searchedFor}, hasAvatars: ${hasAvatars}, hasPhotos: ${hasPhotos})`);
      }

      // Fallback 1: Try avatars.clothing[category] directly
      // This is needed because metadata strips avatar IMAGES but keeps clothing DESCRIPTIONS
      // The actual image comes from styled avatar cache, but description is in character data
      if (!clothingDescription && avatars?.clothing) {
        const categoryToCheck = usedClothingCategory || effectiveClothingCategory;
        if (categoryToCheck && avatars.clothing[categoryToCheck]) {
          const clothingData = avatars.clothing[categoryToCheck];
          clothingDescription = typeof clothingData === 'string' ? clothingData : formatClothingObject(clothingData);
          log.debug(`[CLOTHING DESC] ${char.name}: using avatars.clothing.${categoryToCheck}: "${clothingDescription}"`);
        }
      }

      // Fallback 2: use signature from clothingRequirements if still no clothingDescription
      // clothingRequirements has format: { "CharName": { "winter": { "used": true, "signature": "red scarf" } } }
      if (!clothingDescription && clothingRequirements && clothingRequirements[char.name]) {
        const charReqs = clothingRequirements[char.name];
        const categoryToCheck = usedClothingCategory || effectiveClothingCategory;
        if (categoryToCheck && charReqs[categoryToCheck]?.signature) {
          clothingDescription = charReqs[categoryToCheck].signature;
          log.debug(`[CLOTHING DESC] ${char.name}: using signature from clothingRequirements: "${clothingDescription}"`);
        }
      }

      return {
        name: char.name,
        id: char.id,
        photoType,
        photoUrl,
        photoHash: hashImageData(photoUrl),  // For dev mode verification
        clothingCategory: usedClothingCategory || effectiveClothingCategory || null,
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

  if (height) {
    description += `, ${height} cm tall`;
  }
  if (build) {
    description += `, ${build} build`;
  }

  // Build hair description using detailed analysis helper (pass trait sources to respect user edits)
  const hairDesc = buildHairDescription(char.physical, char.physicalTraitsSource);
  if (hairDesc) {
    description += `. Hair: ${hairDesc}`;
  }
  // Facial hair for males (skip if "none")
  const facialHair = char.physical?.facialHair;
  if (gender === 'male' && facialHair && facialHair.toLowerCase() !== 'none') {
    description += `. Facial hair: ${facialHair}`;
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
 * @returns {string} Description like "Height order: Emma (shortest) -> Max (taller) -> Dad (slightly taller)"
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
        descriptor = 'similar height';
      } else if (diff <= 10) {
        descriptor = 'slightly taller';
      } else if (diff <= 25) {
        descriptor = 'taller';
      } else {
        descriptor = 'noticeably taller';
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
    const effectiveAgeCategory = char?.physical?.apparentAge || char?.ageCategory || (char?.age ? getAgeCategory(char.age) : null);
    const visualAge = effectiveAgeCategory ? `Looks: ${effectiveAgeCategory.replace(/-/g, ' ')}` : '';
    const age = char?.age ? `${char.age} years old` : '';
    const gender = getGenderTerm(char?.gender, effectiveAgeCategory);

    // Include physical traits with labels
    const physical = char?.physical;

    // Build hair description using detailed analysis helper (pass trait sources to respect user edits)
    const hairDescText = buildHairDescription(physical, char?.physicalTraitsSource);
    const hairDesc = hairDescText ? `Hair: ${hairDescText}` : '';

    const physicalParts = [
      physical?.build ? `Build: ${physical.build}` : '',
      // Face shape removed - let reference image handle facial geometry
      physical?.eyeColor ? `Eyes: ${physical.eyeColor}` : '',
      hairDesc,
      // Facial hair for males (skip if "none")
      char?.gender === 'male' && physical?.facialHair && physical.facialHair.toLowerCase() !== 'none' ? `Facial hair: ${physical.facialHair}` : '',
      physical?.other && physical.other.toLowerCase() !== 'none' ? `Other: ${physical.other}` : '',
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

  // Build character clothing info for signature accessory selection
  const characterClothing = (inputData.characters || []).map(char => {
    const clothing = char.avatars?.clothing?.standard;
    if (clothing) {
      return `- ${char.name}: ${clothing}`;
    }
    return `- ${char.name}: (no clothing info available)`;
  }).join('\n');

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
  } else if (storyCategory === 'historical') {
    // Get historical event context from txt guide
    const historicalGuide = getTeachingGuide('historical', storyTopic);
    const historicalEvent = getEventById(storyTopic);
    // Get pre-fetched location photos
    const historicalLocations = getHistoricalLocations(storyTopic);
    if (historicalGuide) {
      const eventName = historicalEvent?.name || storyTopic;
      const eventYear = historicalEvent?.year || '';

      // Build location references section if locations are available
      let locationsSection = '';
      if (historicalLocations?.length > 0) {
        locationsSection = `

**PRE-POPULATED LOCATIONS (reference images available for these):**
${historicalLocations.map(loc => `- ${loc.name} (${loc.type}): ${loc.description || 'Historical landmark'}`).join('\n')}
Include these locations in the story when appropriate - we have reference photos for accurate image generation.`;
        log.debug(`[PROMPT] Including ${historicalLocations.length} pre-fetched location photos for ${storyTopic}`);
      }

      categoryGuidelines = `This is a HISTORICAL story about the real event: "${eventName}"${eventYear ? ` (${eventYear})` : ''}.

**CRITICAL: HISTORICAL ACCURACY REQUIRED**
This story MUST be historically accurate. Do NOT invent facts. Use ONLY the verified information provided below.

${historicalGuide}${locationsSection}

**GUIDELINES:**
- The main character(s) should witness or participate in this historical event
- Include historically accurate details about the time period
- Characters should wear period-appropriate clothing as described above
- Use the suggested story angles or create a similar child-appropriate perspective
- Make the history come alive through the eyes of a child character
- Balance historical education with an engaging adventure narrative
- The story should help children understand what life was like during this event`;
    } else {
      // Fallback if event not found
      categoryGuidelines = `This is a HISTORICAL story about "${storyTopic}".

**IMPORTANT GUIDELINES for Historical Stories:**
- Create a story set during this historical event or period
- Include historically accurate details about the time
- Characters should wear period-appropriate clothing
- Make history accessible and engaging for children
- Balance education with entertainment`;
    }
  } else {
    categoryGuidelines = `This is an ADVENTURE story with a ${storyTheme || inputData.storyType || 'adventure'} theme.

**IMPORTANT GUIDELINES for Adventure Stories:**
- Create an exciting, engaging adventure appropriate for the age group
- Include elements typical of the ${storyTheme || inputData.storyType || 'adventure'} theme
- Balance action and excitement with character development
- Include challenges that the characters must overcome`;
  }

  // Build available landmarks section if landmarks were pre-discovered
  const availableLandmarksSection = buildAvailableLandmarksSection(inputData.availableLandmarks);
  if (inputData.availableLandmarks?.length > 0) {
    log.debug(`[PROMPT] Including ${inputData.availableLandmarks.length} pre-discovered landmarks in outline prompt`);
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
      CHARACTER_CLOTHING: characterClothing || 'No clothing info available',
      STORY_CATEGORY: storyCategory,
      STORY_TYPE: storyTheme || inputData.storyType || 'adventure',
      STORY_TOPIC: storyTopic || 'None',
      CATEGORY_GUIDELINES: categoryGuidelines,
      STORY_DETAILS: inputData.storyDetails || 'None',
      DEDICATION: inputData.dedication || 'None',
      AVAILABLE_LANDMARKS_SECTION: availableLandmarksSection
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
 * @param {Array} previousScenes - Array of {pageNumber, text, sceneHint, characterClothing} for previous pages (max 2)
 * @param {Object|string} characterClothing - Per-character clothing map {Name: 'category'} or legacy string
 */
function buildSceneDescriptionPrompt(pageNumber, pageContent, characters, shortSceneDesc = '', language = 'en', visualBible = null, previousScenes = [], characterClothing = {}) {
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
  // Each entry includes its unique ID for robust matching (e.g., CHR001, LOC001)
  let recurringElements = '';
  if (visualBible) {
    // Helper to format ID label
    const idLabel = (entry) => entry.id ? ` [${entry.id}]` : '';

    // Add ALL secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      for (const sc of visualBible.secondaryCharacters) {
        const description = sc.extractedDescription || sc.description;
        recurringElements += `* **${sc.name}**${idLabel(sc)} (secondary character): ${description}\n`;
      }
    }
    // Add ALL locations
    if (visualBible.locations && visualBible.locations.length > 0) {
      for (const loc of visualBible.locations) {
        const description = loc.extractedDescription || loc.description;
        recurringElements += `* **${loc.name}**${idLabel(loc)} (location): ${description}\n`;
      }
    }
    // Add ALL vehicles
    if (visualBible.vehicles && visualBible.vehicles.length > 0) {
      for (const veh of visualBible.vehicles) {
        const description = veh.extractedDescription || veh.description;
        recurringElements += `* **${veh.name}**${idLabel(veh)} (vehicle): ${description}\n`;
      }
    }
    // Add ALL animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      for (const animal of visualBible.animals) {
        const description = animal.extractedDescription || animal.description;
        recurringElements += `* **${animal.name}**${idLabel(animal)} (animal): ${description}\n`;
      }
    }
    // Add ALL artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      for (const artifact of visualBible.artifacts) {
        const description = artifact.extractedDescription || artifact.description;
        recurringElements += `* **${artifact.name}**${idLabel(artifact)} (object): ${description}\n`;
      }
    }
    // Add ALL clothing/costumes
    if (visualBible.clothing && visualBible.clothing.length > 0) {
      for (const item of visualBible.clothing) {
        const description = item.extractedDescription || item.description;
        const wornBy = item.wornBy ? ` (worn by ${item.wornBy})` : '';
        recurringElements += `* **${item.name}**${idLabel(item)}${wornBy} (clothing): ${description}\n`;
      }
    }
  }

  // Consolidated logging for scene prompt
  const vbEntryCount = (visualBible?.secondaryCharacters?.length || 0) +
                       (visualBible?.locations?.length || 0) +
                       (visualBible?.vehicles?.length || 0) +
                       (visualBible?.animals?.length || 0) +
                       (visualBible?.artifacts?.length || 0) +
                       (visualBible?.clothing?.length || 0);
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
      // Show per-character clothing for previous scenes
      if (prev.characterClothing && typeof prev.characterClothing === 'object') {
        const clothingList = Object.entries(prev.characterClothing)
          .map(([name, cat]) => `${name}: ${cat}`)
          .join(', ');
        if (clothingList) {
          previousScenesText += `  Clothing: ${clothingList}\n`;
        }
      } else if (prev.clothing) {
        // Legacy format fallback
        previousScenesText += `  Clothing: ${prev.clothing}\n`;
      }
    }
    previousScenesText += '\n';
  }

  // Format per-character clothing for prompt
  let characterClothingText = '';
  if (characterClothing && typeof characterClothing === 'object' && Object.keys(characterClothing).length > 0) {
    characterClothingText = Object.entries(characterClothing)
      .map(([name, category]) => `- ${name}: ${category}`)
      .join('\n');
  } else if (typeof characterClothing === 'string') {
    // Legacy format: single clothing for all
    characterClothingText = `All characters: ${characterClothing}`;
  } else {
    characterClothingText = 'All characters: standard';
  }

  // Use template from file if available
  if (PROMPT_TEMPLATES.sceneDescriptions) {
    // Get the full language instruction with spelling rules (e.g., 'Write in German with Swiss spelling. Use ä,ö,ü...')
    const languageInstruction = getLanguageInstruction(language);
    const languageName = getLanguageNameEnglish(language);
    return fillTemplate(PROMPT_TEMPLATES.sceneDescriptions, {
      PREVIOUS_SCENES: previousScenesText,
      SCENE_SUMMARY: shortSceneDesc ? `Scene Summary: ${shortSceneDesc}\n\n` : '',
      PAGE_NUMBER: pageNumber.toString(),
      PAGE_CONTENT: pageContent,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      CHARACTER_CLOTHING: characterClothingText,
      LANGUAGE_NAME: languageName,
      LANGUAGE_INSTRUCTION: languageInstruction,
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
      const visualAge = char.physical?.apparentAge ? `Looks: ${char.physical.apparentAge.replace(/-/g, ' ')}` : '';
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
      const gender = getGenderTerm(char.gender, char.physical?.apparentAge);
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
      // Build hair description using detailed analysis helper (pass trait sources to respect user edits)
      const hairDescText = buildHairDescription(physical, char.physicalTraitsSource);
      const hairDesc = hairDescText ? `Hair: ${hairDescText}` : '';

      const physicalParts = [
        physical?.build ? `Build: ${physical.build}` : '',
        // Face shape removed - let reference image handle facial geometry
        physical?.eyeColor ? `Eyes: ${physical.eyeColor}` : '',
        hairDesc,
        // Facial hair for males (skip if "none")
        char.gender === 'male' && physical?.facialHair && physical.facialHair.toLowerCase() !== 'none' ? `Facial hair: ${physical.facialHair}` : '',
        physical?.other && physical.other.toLowerCase() !== 'none' ? `Other: ${physical.other}` : '',
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

  // Build required objects section from metadata.objects by looking up in Visual Bible
  // This ensures objects listed in scene metadata are included with their full descriptions
  // Supports lookup by name OR identifier (e.g., "CLO001", "ART002", etc.)
  //
  // OPTIMIZATION: Scene description already selects which visual bible elements are needed
  // and outputs them in JSON metadata. We use ONLY those elements instead of the entire bible.
  let requiredObjectsSection = '';
  let hasRequiredObjects = false;
  if (metadata && metadata.objects && metadata.objects.length > 0 && visualBible) {
    const requiredObjects = [];

    // Helper function to match by name OR ID
    // NOTE: For character names, we use STRICT matching to avoid "Luis" matching "Luis' Mama"
    const matchesEntry = (entry, searchTerm, strictMode = false) => {
      const searchLower = searchTerm.toLowerCase().trim();
      const nameLower = (entry.name || '').toLowerCase().trim();
      const idLower = (entry.id || '').toLowerCase().trim();

      // Match by ID (exact match, e.g., "CLO001", "CHR002")
      if (idLower && idLower === searchLower) return true;

      // Extract ID from search term if present (e.g., "Der weise Ritter [CHR002]" -> "CHR002")
      const idMatch = searchTerm.match(/\[([A-Z]{3}\d{3})\]/);
      if (idMatch && idLower === idMatch[1].toLowerCase()) return true;

      // Exact name match (always allowed)
      if (nameLower === searchLower) return true;

      // For strict mode (characters), only allow exact matches or ID matches
      if (strictMode) return false;

      // For non-strict mode (objects/locations), allow partial matches
      if (nameLower.includes(searchLower)) return true;
      if (searchLower.includes(nameLower) && nameLower.length >= 3) return true;

      return false;
    };

    // First, look up secondary characters from metadata.characters
    // Use STRICT matching to avoid "Luis" matching "Luis' Mama"
    if (metadata.characters && metadata.characters.length > 0) {
      for (const charName of metadata.characters) {
        // Look up in secondaryCharacters with strict mode to prevent partial name matches
        const secondaryChar = (visualBible.secondaryCharacters || []).find(sc => matchesEntry(sc, charName, true));
        if (secondaryChar) {
          const description = secondaryChar.extractedDescription || secondaryChar.description;
          requiredObjects.push({ name: secondaryChar.name, id: secondaryChar.id, type: 'secondary character', description });
        }
      }
    }

    for (const objName of metadata.objects) {
      // Look up in artifacts
      const artifact = (visualBible.artifacts || []).find(a => matchesEntry(a, objName));
      if (artifact) {
        const description = artifact.extractedDescription || artifact.description;
        requiredObjects.push({ name: artifact.name, id: artifact.id, type: 'object', description });
        continue;
      }

      // Look up in animals
      const animal = (visualBible.animals || []).find(a => matchesEntry(a, objName));
      if (animal) {
        const description = animal.extractedDescription || animal.description;
        requiredObjects.push({ name: animal.name, id: animal.id, type: 'animal', description });
        continue;
      }

      // Look up in locations
      const location = (visualBible.locations || []).find(l => matchesEntry(l, objName));
      if (location) {
        const description = location.extractedDescription || location.description;
        requiredObjects.push({ name: location.name, id: location.id, type: 'location', description });
        continue;
      }

      // Look up in vehicles
      const vehicle = (visualBible.vehicles || []).find(v => matchesEntry(v, objName));
      if (vehicle) {
        const description = vehicle.extractedDescription || vehicle.description;
        requiredObjects.push({ name: vehicle.name, id: vehicle.id, type: 'vehicle', description });
        continue;
      }

      // Look up in clothing/costumes
      const clothing = (visualBible.clothing || []).find(c => matchesEntry(c, objName));
      if (clothing) {
        const description = clothing.extractedDescription || clothing.description;
        const wornBy = clothing.wornBy ? ` (worn by ${clothing.wornBy})` : '';
        requiredObjects.push({ name: clothing.name, id: clothing.id, type: 'clothing', description: description + wornBy });
      }
    }

    if (requiredObjects.length > 0) {
      hasRequiredObjects = true;
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
        // Note: obj.id exists for Visual Bible tracking but is not included in image prompts
        // as image models don't use these identifiers
        requiredObjectsSection += `* **${obj.name}** (${obj.type}): ${obj.description}\n`;
      }

      log.debug(`[IMAGE PROMPT] Added ${requiredObjects.length} required objects from metadata (skipping full Visual Bible)`);
    }
  }

  // FALLBACK: Only add full Visual Bible if scene description didn't specify required objects
  // This handles storybook mode where there's no separate scene description step
  let visualBibleSection = '';
  if (!hasRequiredObjects && visualBible && pageNumber !== null) {
    const sceneCharacterNames = sceneCharacters ? sceneCharacters.map(c => c.name) : null;
    visualBibleSection = buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames, language);
    if (visualBibleSection) {
      log.debug(`[IMAGE PROMPT] Added full Visual Bible section for page ${pageNumber} (no metadata.objects)`);
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
function buildSceneExpansionPrompt(sceneSummary, inputData, sceneCharacters, visualBible, language = 'en', correctionNotes = '') {
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

  // Build recurring elements from Visual Bible (with IDs for robust matching)
  let recurringElements = '';
  if (visualBible) {
    const elements = [];
    const idLabel = (entry) => entry.id ? ` [${entry.id}]` : '';

    // Add secondary characters
    if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
      visualBible.secondaryCharacters.forEach(char => {
        elements.push(`* **${char.name}**${idLabel(char)} (secondary character): ${char.description}`);
      });
    }

    // Add locations
    if (visualBible.locations && visualBible.locations.length > 0) {
      visualBible.locations.forEach(location => {
        elements.push(`* **${location.name}**${idLabel(location)} (location): ${location.description}`);
      });
    }

    // Add vehicles
    if (visualBible.vehicles && visualBible.vehicles.length > 0) {
      visualBible.vehicles.forEach(vehicle => {
        elements.push(`* **${vehicle.name}**${idLabel(vehicle)} (vehicle): ${vehicle.description}`);
      });
    }

    // Add animals
    if (visualBible.animals && visualBible.animals.length > 0) {
      visualBible.animals.forEach(animal => {
        elements.push(`* **${animal.name}**${idLabel(animal)} (animal): ${animal.description}`);
      });
    }

    // Add artifacts
    if (visualBible.artifacts && visualBible.artifacts.length > 0) {
      visualBible.artifacts.forEach(artifact => {
        elements.push(`* **${artifact.name}**${idLabel(artifact)} (object): ${artifact.description}`);
      });
    }

    // Add clothing/costumes
    if (visualBible.clothing && visualBible.clothing.length > 0) {
      visualBible.clothing.forEach(item => {
        const wornBy = item.wornBy ? ` (worn by ${item.wornBy})` : '';
        elements.push(`* **${item.name}**${idLabel(item)}${wornBy} (clothing): ${item.description}`);
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
    // Build correction notes section if provided
    const correctionSection = correctionNotes
      ? `\n**CORRECTION NOTES (from previous evaluation):**\n${correctionNotes}\n`
      : '';
    return fillTemplate(template, {
      SCENE_SUMMARY: sceneSummary,
      CHARACTERS: characterDetails,
      RECURRING_ELEMENTS: recurringElements,
      CORRECTION_NOTES: correctionSection,
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
// UNIFIED STORY GENERATION
// ============================================================================

/**
 * Build unified story generation prompt
 * Generates complete story with character arcs, plot structure, visual bible, and all pages
 * @param {Object} inputData - Story parameters
 * @param {number} sceneCount - Number of story pages to generate
 * @returns {string} Filled prompt template
 */
function buildUnifiedStoryPrompt(inputData, sceneCount = null) {
  const pageCount = sceneCount || inputData.pages || 15;
  const readingLevel = getReadingLevel(inputData.languageLevel);
  const mainCharacterIds = inputData.mainCharacters || [];
  const language = inputData.language || 'en';

  // Extract character info with strengths/flaws for character arcs
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
    };
  });

  // Extract character names for Visual Bible exclusion
  const characterNames = characterSummary.map(c => c.name).join(', ');

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
      relationshipDescriptions = `\n**Relationships:**\n${relationshipLines.map(r => `- ${r}`).join('\n')}`;
    }
  }

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
  } else if (storyCategory === 'historical') {
    // Get historical event context from txt guide
    const historicalGuide = getTeachingGuide('historical', storyTopic);
    const historicalEvent = getEventById(storyTopic);
    // Get pre-fetched location photos (unified prompt)
    const historicalLocations = getHistoricalLocations(storyTopic);
    if (historicalGuide) {
      const eventName = historicalEvent?.name || storyTopic;
      const eventYear = historicalEvent?.year || '';

      // Build location references section if locations are available
      let locationsSection = '';
      if (historicalLocations?.length > 0) {
        locationsSection = `

**PRE-POPULATED LOCATIONS (reference images available for these):**
${historicalLocations.map(loc => `- ${loc.name} (${loc.type}): ${loc.description || 'Historical landmark'}`).join('\n')}
Include these locations in the story when appropriate - we have reference photos for accurate image generation.`;
        log.debug(`[UNIFIED] Including ${historicalLocations.length} pre-fetched location photos for ${storyTopic}`);
      }

      categoryGuidelines = `This is a HISTORICAL story about the real event: "${eventName}"${eventYear ? ` (${eventYear})` : ''}.

**CRITICAL: HISTORICAL ACCURACY REQUIRED**
This story MUST be historically accurate. Do NOT invent facts. Use ONLY the verified information provided below.

${historicalGuide}${locationsSection}

**GUIDELINES:**
- The main character(s) should witness or participate in this historical event
- Include historically accurate details about the time period
- Characters should wear period-appropriate clothing as described above
- Use the suggested story angles or create a similar child-appropriate perspective
- Make the history come alive through the eyes of a child character
- Balance historical education with an engaging adventure narrative
- The story should help children understand what life was like during this event`;
    } else {
      // Fallback if event not found
      categoryGuidelines = `This is a HISTORICAL story about "${storyTopic}".

**IMPORTANT GUIDELINES for Historical Stories:**
- Create a story set during this historical event or period
- Include historically accurate details about the time
- Characters should wear period-appropriate clothing
- Make history accessible and engaging for children
- Balance education with entertainment`;
    }
  } else {
    // Adventure category - get theme-specific guide
    const adventureGuide = getTeachingGuide('adventure', storyTheme);

    categoryGuidelines = `This is an ADVENTURE story with a "${storyTheme || 'adventure'}" theme.

**IMPORTANT GUIDELINES for Adventure Stories:**
- Create an exciting, engaging adventure appropriate for the age group
- Include elements typical of the ${storyTheme || 'adventure'} theme
- Balance action and excitement with character development
- Include challenges that the characters must overcome
- Historical and fantasy themes SHOULD use costumed clothing for authenticity

${adventureGuide ? `**THEME-SPECIFIC GUIDANCE for "${storyTheme}":**
${adventureGuide}` : ''}`;
  }

  // Build characters JSON with relationships
  const charactersJson = JSON.stringify(characterSummary, null, 2) + relationshipDescriptions;

  // Build available landmarks section if landmarks were pre-discovered
  const availableLandmarksSection = buildAvailableLandmarksSection(inputData.availableLandmarks);
  if (inputData.availableLandmarks?.length > 0) {
    log.debug(`[PROMPT] Including ${inputData.availableLandmarks.length} pre-discovered landmarks in unified prompt`);
  }

  // Use template if available
  if (PROMPT_TEMPLATES.storyUnified) {
    const prompt = fillTemplate(PROMPT_TEMPLATES.storyUnified, {
      LANGUAGE_INSTRUCTION: getLanguageInstruction(language),
      PAGES: pageCount,
      LANGUAGE: getLanguageNameEnglish(language),
      LANGUAGE_NOTE: getLanguageNote(language),
      READING_LEVEL: readingLevel,
      STORY_CATEGORY: storyCategory,
      STORY_TYPE: storyTheme,
      STORY_TOPIC: storyTopic || 'None',
      STORY_DETAILS: inputData.storyDetails || 'None',
      CHARACTERS: charactersJson,
      CHARACTER_NAMES: characterNames,
      CATEGORY_GUIDELINES: categoryGuidelines,
      AVAILABLE_LANDMARKS_SECTION: availableLandmarksSection
    });
    log.debug(`[PROMPT] Unified story prompt length: ${prompt.length} chars`);
    return prompt;
  }

  // Fallback to hardcoded prompt
  log.warn('[PROMPT] storyUnified template not loaded, using fallback');
  return `Create a complete children's story with ${pageCount} pages.
Language: ${getLanguageNameEnglish(language)}
Reading Level: ${readingLevel}
Characters: ${charactersJson}
Story Type: ${storyTheme}
Story Details: ${inputData.storyDetails || 'None'}

Output: Title, clothing requirements, character arcs, plot structure, visual bible, cover scenes, and all ${pageCount} pages with text and scene hints.`;
}

// ============================================================================
// LANDMARK PHOTO HELPERS
// ============================================================================

/**
 * Get landmark reference photos for a specific page
 * Returns photos for real-world landmarks that appear on the given page
 * @param {Object} visualBible - Visual Bible object with locations
 * @param {number} pageNumber - The page number to get landmarks for
 * @returns {Array<{name: string, photoData: string, attribution: string}>} Landmark photos
 */
function getLandmarkPhotosForPage(visualBible, pageNumber) {
  if (!visualBible?.locations) return [];

  return visualBible.locations
    .filter(loc =>
      loc.isRealLandmark &&
      loc.referencePhotoData &&
      loc.photoFetchStatus === 'success' &&
      loc.appearsInPages?.includes(pageNumber)
    )
    .map(loc => ({
      name: loc.name,
      photoData: loc.referencePhotoData,
      attribution: loc.photoAttribution,
      source: loc.photoSource
    }));
}

/**
 * Get landmark reference photos for a scene based on LOC IDs in scene metadata
 * Parses objects like "Burgruine Stein [LOC002]" to extract LOC IDs
 * @param {Object} visualBible - Visual Bible object with locations
 * @param {Object} sceneMetadata - Scene metadata with objects array containing LOC IDs
 * @returns {Array<{name: string, photoData: string, attribution: string, source: string}>} Landmark photos
 */
function getLandmarkPhotosForScene(visualBible, sceneMetadata) {
  if (!visualBible?.locations || !sceneMetadata?.objects) return [];

  // Extract LOC IDs and names from objects like "Burgruine Stein [LOC002]" or "Kennedy Space Center [LOC001]"
  const locIds = [];
  const locNames = [];
  for (const obj of sceneMetadata.objects) {
    // Match [LOC###] pattern in string like "Kennedy Space Center [LOC001]"
    const bracketMatch = obj.match(/\[LOC(\d+)\]/i);
    if (bracketMatch) {
      locIds.push(`LOC${bracketMatch[1].padStart(3, '0')}`);
      // Also extract the name before the bracket
      const namePart = obj.replace(/\s*\[LOC\d+\]\s*/i, '').trim();
      if (namePart) locNames.push(namePart.toLowerCase());
    }
    // Also match plain "LOC002" format
    else if (obj.match(/^LOC\d+$/i)) {
      locIds.push(obj.toUpperCase());
    }
    // Fallback: treat as location name (for historical locations)
    else if (obj.trim()) {
      locNames.push(obj.trim().toLowerCase());
    }
  }

  if (locIds.length === 0 && locNames.length === 0) return [];

  return visualBible.locations
    .filter(loc =>
      (locIds.includes(loc.id) || locNames.includes(loc.name?.toLowerCase())) &&
      loc.isRealLandmark &&
      loc.referencePhotoData &&
      loc.photoFetchStatus === 'success'
    )
    .map(loc => ({
      name: loc.name,
      photoData: loc.referencePhotoData,
      attribution: loc.photoAttribution,
      source: loc.photoSource
    }));
}

// ============================================================================
// AVAILABLE LANDMARKS SECTION BUILDER
// ============================================================================

/**
 * Build the available landmarks section for the outline prompt
 * @param {Array} landmarks - Pre-discovered landmarks from userLandmarkCache
 * @returns {string} - Prompt section with available landmarks, or empty string if none
 */
function buildAvailableLandmarksSection(landmarks) {
  if (!landmarks || landmarks.length === 0) {
    return '';
  }

  // Format with photo descriptions if available:
  // "- Kurpark (Baden) [Park]: A beautiful public park with manicured lawns..."
  const landmarkList = landmarks
    .map(l => {
      let entry = `- ${l.name}`;
      if (l.type) entry += ` [${l.type}]`;
      if (l.photoDescription) entry += `\n  PHOTO DESCRIPTION: ${l.photoDescription}`;
      return entry;
    })
    .join('\n');

  const hasDescriptions = landmarks.some(l => l.photoDescription);

  return `**REAL LANDMARKS - You must use at least 2 landmarks from below list:**

${landmarkList}

When you use a landmark from the list (even if you rename it in your story):
- Set "isRealLandmark": true
- Set "landmarkQuery": copy-paste the EXACT name from the list above (WITHOUT the [type])
${hasDescriptions ? `- IMPORTANT: If the landmark has a PHOTO DESCRIPTION above, copy it EXACTLY to "description" - do NOT invent your own!` : ''}

EXAMPLE - Using "Ruine Stein [Ruins]" as "The Enchanted Castle" in your story:
{
  "name": "The Enchanted Castle",
  "isRealLandmark": true,
  "landmarkQuery": "Ruine Stein",
  "description": "<copy the PHOTO DESCRIPTION if provided, otherwise write your own>"
}

Your "name" can be creative, but "landmarkQuery" MUST match the original name exactly (without the [type] suffix)!
`;
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
  parseCharacterClothing,
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
  buildUnifiedStoryPrompt,

  // Teaching guides
  getTeachingGuide,
  getAdventureGuide,
  getSceneComplexityGuide,

  // Historical locations
  getHistoricalLocations,

  // Landmark helpers
  getLandmarkPhotosForPage,
  getLandmarkPhotosForScene,
  buildAvailableLandmarksSection
};
