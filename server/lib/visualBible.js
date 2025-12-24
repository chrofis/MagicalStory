/**
 * Visual Bible Module
 *
 * Tracks recurring elements (characters, animals, artifacts, locations)
 * for visual consistency across story scenes.
 *
 * Used by both processStoryJob and processStorybookJob.
 */

const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

/**
 * Parse Visual Bible from story outline
 * Extracts: secondaryCharacters, animals, artifacts, locations
 * Also initializes empty mainCharacters array and changeLog
 */
function parseVisualBible(outline) {
  const visualBible = {
    mainCharacters: [],      // Populated from inputData.characters
    secondaryCharacters: [], // Parsed from outline
    animals: [],             // Parsed from outline
    artifacts: [],           // Parsed from outline
    locations: [],           // Parsed from outline
    changeLog: []            // Track all updates during story generation
  };

  if (!outline) return visualBible;

  // Log outline length for debugging
  log.debug(`[VISUAL BIBLE] Parsing outline, length: ${outline.length} chars`);

  // Check if outline contains Visual Bible mention at all (case-insensitive)
  if (!outline.toLowerCase().includes('visual bible')) {
    log.debug('[VISUAL BIBLE] Outline does not contain "Visual Bible" text');
    return visualBible;
  }

  // Find the Visual Bible section - simplified regex
  // Matches: "# VISUAL BIBLE", "## Visual Bible", "# Part 5: Visual Bible", etc.
  const visualBibleMatch = outline.match(/#+\s*(?:Part\s*\d+[:\s]*)?Visual\s*Bible\b([\s\S]*?)(?=\n#[^#]|\n---|$)/i);
  if (!visualBibleMatch) {
    log.debug('[VISUAL BIBLE] Regex did not match Visual Bible section');
    // Try alternate regex patterns
    const altMatch = outline.match(/Visual\s*Bible[\s\S]{0,50}/i);
    if (altMatch) {
      log.debug(`[VISUAL BIBLE] Found text near "Visual Bible": "${altMatch[0].substring(0, 100)}..."`);
    }
    return visualBible;
  }

  const visualBibleSection = visualBibleMatch[1];
  log.debug(`[VISUAL BIBLE] Found section, length: ${visualBibleSection.length} chars`);
  log.debug(`[VISUAL BIBLE] Section preview: "${visualBibleSection.substring(0, 200)}..."`);

  // Log what subsections we find
  log.debug(`[VISUAL BIBLE] Looking for ### Secondary Characters...`);
  log.debug(`[VISUAL BIBLE] Looking for ### Animals...`);
  log.debug(`[VISUAL BIBLE] Looking for ### Artifacts...`);
  log.debug(`[VISUAL BIBLE] Looking for ### Locations...`);

  // Parse Secondary Characters (supports ## or ### headers)
  const secondaryCharsMatch = visualBibleSection.match(/#{2,3}\s*Secondary\s*Characters?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (secondaryCharsMatch) {
    log.debug(`[VISUAL BIBLE] Secondary Characters section found, length: ${secondaryCharsMatch[1].length}`);
    if (!secondaryCharsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(secondaryCharsMatch[1]);
      visualBible.secondaryCharacters = entries;
      log.debug(`[VISUAL BIBLE] Parsed ${entries.length} secondary characters`);
    } else {
      log.debug(`[VISUAL BIBLE] Secondary Characters section contains "None"`);
    }
  } else {
    log.debug(`[VISUAL BIBLE] No Secondary Characters section found`);
  }

  // Parse Animals & Creatures (supports ## or ### headers)
  const animalsMatch = visualBibleSection.match(/#{2,3}\s*Animals?\s*(?:&|and)?\s*Creatures?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (animalsMatch) {
    log.debug(`[VISUAL BIBLE] Animals section found, length: ${animalsMatch[1].length}`);
    if (!animalsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(animalsMatch[1]);
      visualBible.animals = entries;
      log.debug(`[VISUAL BIBLE] Parsed ${entries.length} animals`);
    } else {
      log.debug(`[VISUAL BIBLE] Animals section contains "None"`);
    }
  } else {
    log.debug(`[VISUAL BIBLE] No Animals section found`);
  }

  // Parse Artifacts (supports ## or ### headers, also "Important Artifacts")
  const artifactsMatch = visualBibleSection.match(/#{2,3}\s*(?:Important\s*)?Artifacts?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (artifactsMatch) {
    log.debug(`[VISUAL BIBLE] Artifacts section found, length: ${artifactsMatch[1].length}`);
    if (!artifactsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(artifactsMatch[1]);
      visualBible.artifacts = entries;
      log.debug(`[VISUAL BIBLE] Parsed ${entries.length} artifacts`);
    } else {
      log.debug(`[VISUAL BIBLE] Artifacts section contains "None"`);
    }
  } else {
    log.debug(`[VISUAL BIBLE] No Artifacts section found`);
  }

  // Parse Locations (supports ## or ### headers, also "Recurring Locations")
  const locationsMatch = visualBibleSection.match(/#{2,3}\s*(?:Recurring\s*)?Locations?([\s\S]*?)(?=\n#{2,3}\s|$)/i);
  if (locationsMatch) {
    log.debug(`[VISUAL BIBLE] Locations section found, length: ${locationsMatch[1].length}`);
    if (!locationsMatch[1].toLowerCase().includes('none')) {
      const entries = parseVisualBibleEntries(locationsMatch[1]);
      visualBible.locations = entries;
      log.debug(`[VISUAL BIBLE] Parsed ${entries.length} locations`);
    } else {
      log.debug(`[VISUAL BIBLE] Locations section contains "None"`);
    }
  } else {
    log.debug(`[VISUAL BIBLE] No Locations section found`);
  }

  const totalEntries = visualBible.secondaryCharacters.length +
                       visualBible.animals.length +
                       visualBible.artifacts.length +
                       visualBible.locations.length;

  log.debug(`[VISUAL BIBLE] Parsed ${totalEntries} entries: ` +
    `${visualBible.secondaryCharacters.length} characters, ` +
    `${visualBible.animals.length} animals, ` +
    `${visualBible.artifacts.length} artifacts, ` +
    `${visualBible.locations.length} locations`);

  return visualBible;
}

/**
 * Filter out main characters from Visual Bible secondary characters
 * This is a safety net in case Claude includes main characters despite the prompt instruction
 * @param {Object} visualBible - Parsed Visual Bible object
 * @param {Array} mainCharacters - Array of main character objects with name property
 * @returns {Object} Visual Bible with filtered secondary characters
 */
function filterMainCharactersFromVisualBible(visualBible, mainCharacters) {
  if (!visualBible || !mainCharacters || mainCharacters.length === 0) {
    return visualBible;
  }

  // Build set of main character names (lowercase for case-insensitive matching)
  const mainNames = new Set(mainCharacters.map(c => c.name?.toLowerCase()).filter(Boolean));

  if (visualBible.secondaryCharacters && visualBible.secondaryCharacters.length > 0) {
    const originalCount = visualBible.secondaryCharacters.length;
    visualBible.secondaryCharacters = visualBible.secondaryCharacters.filter(sc => {
      const scName = sc.name?.toLowerCase();
      const isMainChar = mainNames.has(scName);
      if (isMainChar) {
        log.debug(`[VISUAL BIBLE] Filtering out "${sc.name}" - matches main character`);
      }
      return !isMainChar;
    });
    const filteredCount = originalCount - visualBible.secondaryCharacters.length;
    if (filteredCount > 0) {
      log.debug(`[VISUAL BIBLE] Filtered ${filteredCount} main characters from secondary characters`);
    }
  }

  return visualBible;
}

/**
 * Parse individual Visual Bible entries from a section
 * Handles multi-language page keywords (pages, Seiten, Page)
 */
function parseVisualBibleEntries(sectionText) {
  const entries = [];

  // Log raw section text for debugging
  log.debug(`[VISUAL BIBLE ENTRIES] Parsing section text (${sectionText.length} chars):`);
  log.debug(`[VISUAL BIBLE ENTRIES] First 300 chars: "${sectionText.substring(0, 300)}..."`);

  // Match entries that start with **Name** (pages X, Y, Z)
  // Support English "pages/page", German "Seiten/Seite", French "pages/page"
  const pageKeyword = '(?:pages?|Seiten?|Page)';
  const entryPattern = new RegExp(`\\*\\*([^*]+)\\*\\*\\s*\\(${pageKeyword}\\s*([^)]+)\\)([\\s\\S]*?)(?=\\*\\*[^*]+\\*\\*\\s*\\(${pageKeyword}|$)`, 'gi');
  let match;

  while ((match = entryPattern.exec(sectionText)) !== null) {
    const name = match[1].trim();
    const pagesStr = match[2].trim();
    const descriptionBlock = match[3].trim();

    // Parse page numbers (handle special pages: Title/Front=0, Initial=-1, Back=-2)
    const pages = [];
    const pageTokens = pagesStr.split(/,\s*/);
    for (const token of pageTokens) {
      const t = token.trim().toLowerCase();
      if (t.includes('title') || t.includes('front')) {
        pages.push(0); // Title/Front cover = page 0
      } else if (t.includes('initial')) {
        pages.push(-1); // Initial page = -1
      } else if (t.includes('back')) {
        pages.push(-2); // Back cover = -2
      } else {
        const num = parseInt(t.replace(/\D/g, ''));
        if (!isNaN(num)) {
          pages.push(num);
        }
      }
    }

    // Combine all description lines
    const descriptionLines = descriptionBlock.split('\n')
      .map(line => line.replace(/^[-•]\s*/, '').trim())
      .filter(line => line.length > 0);

    const description = descriptionLines.join('. ');

    log.debug(`[VISUAL BIBLE ENTRIES] Entry "${name}" pages raw: "${pagesStr}" -> parsed: [${pages.join(', ')}]`);

    if (name && pages.length > 0) {
      entries.push({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        name,
        appearsInPages: pages,
        description,
        extractedDescription: null, // Will be filled after first image analysis
        firstAppearanceAnalyzed: false
      });
    }
  }

  return entries;
}

// ============================================================================
// INITIALIZATION FUNCTIONS
// ============================================================================

/**
 * Initialize main characters in Visual Bible from inputData.characters
 * Called at the start of story generation to populate mainCharacters array
 */
function initializeVisualBibleMainCharacters(visualBible, characters) {
  if (!visualBible || !characters || !Array.isArray(characters)) {
    return visualBible;
  }

  log.debug(`[VISUAL BIBLE] Initializing ${characters.length} main characters...`);

  visualBible.mainCharacters = characters.map(char => {
    // Build physical description from character data
    // Support both new structure (char.physical.*) and legacy (char.height, char.build, etc.)
    const physical = char.physical || {};
    const mainChar = {
      id: char.id,
      name: char.name,
      physical: {
        age: char.age || 'Unknown',
        gender: char.gender || 'Unknown',
        height: physical.height || char.height || 'Unknown',
        build: physical.build || char.build || 'Unknown',
        face: physical.face || char.other_features || char.otherFeatures || 'Not analyzed',
        hair: physical.hair || char.hair_color || char.hairColor || 'Not analyzed',
        other: physical.other || char.other || ''
      },
      referenceOutfit: char.referenceOutfit || char.reference_outfit || null,
      generatedOutfits: char.generatedOutfits || char.generated_outfits || {}
    };

    // Debug: Log what physical data we're using
    log.debug(`[VISUAL BIBLE] Added main character: ${char.name} (id: ${char.id})`);
    log.debug(`[VISUAL BIBLE]   - physical.age: "${mainChar.physical.age}"`);
    log.debug(`[VISUAL BIBLE]   - physical.gender: "${mainChar.physical.gender}"`);
    log.debug(`[VISUAL BIBLE]   - physical.height: "${mainChar.physical.height}"`);
    log.debug(`[VISUAL BIBLE]   - physical.build: "${mainChar.physical.build}"`);
    log.debug(`[VISUAL BIBLE]   - physical.face: "${mainChar.physical.face?.substring(0, 60)}..."`);
    log.debug(`[VISUAL BIBLE]   - physical.hair: "${mainChar.physical.hair}"`);
    log.debug(`[VISUAL BIBLE]   - physical.other: "${mainChar.physical.other}"`);
    return mainChar;
  });

  return visualBible;
}

// ============================================================================
// CHANGE TRACKING FUNCTIONS
// ============================================================================

/**
 * Add a change log entry to Visual Bible
 */
function addVisualBibleChangeLog(visualBible, pageNumber, element, type, change, before, after) {
  if (!visualBible) return;

  const entry = {
    timestamp: new Date().toISOString(),
    page: pageNumber,
    element,
    type,
    change,
    before: before || null,
    after
  };

  visualBible.changeLog.push(entry);
  log.debug(`[VISUAL BIBLE CHANGE] Page ${pageNumber}: ${element} (${type}) - ${change}`);
}

/**
 * Update main character's generated outfit in Visual Bible
 */
function updateMainCharacterOutfit(visualBible, characterId, pageNumber, outfit) {
  if (!visualBible || !characterId) return;

  const mainChar = visualBible.mainCharacters.find(c => c.id === characterId);
  if (!mainChar) {
    log.debug(`[VISUAL BIBLE] Main character ${characterId} not found for outfit update`);
    return;
  }

  const previousOutfit = mainChar.generatedOutfits[pageNumber]?.outfit || null;
  mainChar.generatedOutfits[pageNumber] = outfit;

  addVisualBibleChangeLog(
    visualBible,
    pageNumber,
    mainChar.name,
    'generatedOutfit',
    previousOutfit ? 'Updated outfit' : 'New outfit extracted',
    previousOutfit,
    outfit.outfit
  );

  log.debug(`[VISUAL BIBLE] Updated outfit for ${mainChar.name} on page ${pageNumber}`);
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

/**
 * Get Visual Bible entries relevant to a specific page
 */
function getVisualBibleEntriesForPage(visualBible, pageNumber) {
  if (!visualBible) return [];

  const relevant = [];

  const checkEntries = (entries, type) => {
    for (const entry of entries) {
      if (entry.appearsInPages.includes(pageNumber)) {
        relevant.push({ ...entry, type });
      }
    }
  };

  checkEntries(visualBible.secondaryCharacters || [], 'character');
  checkEntries(visualBible.animals || [], 'animal');
  checkEntries(visualBible.artifacts || [], 'artifact');
  checkEntries(visualBible.locations || [], 'location');

  return relevant;
}

/**
 * Get elements that need analysis for a given page (first appearances only)
 */
function getElementsNeedingAnalysis(visualBible, pageNumber) {
  if (!visualBible) return [];

  const needsAnalysis = [];

  const checkEntries = (entries, type) => {
    for (const entry of entries) {
      const firstAppearancePage = Math.min(...entry.appearsInPages);
      if (firstAppearancePage === pageNumber && !entry.firstAppearanceAnalyzed) {
        needsAnalysis.push({ ...entry, type });
      }
    }
  };

  checkEntries(visualBible.secondaryCharacters || [], 'character');
  checkEntries(visualBible.animals || [], 'animal');
  checkEntries(visualBible.artifacts || [], 'artifact');
  checkEntries(visualBible.locations || [], 'location');

  return needsAnalysis;
}

// ============================================================================
// PROMPT BUILDING FUNCTIONS
// ============================================================================

/**
 * Build Visual Bible prompt section for image generation
 * Includes ALL visual bible elements (not filtered by page) with optional intro text
 */
function buildVisualBiblePrompt(visualBible, pageNumber, sceneCharacterNames = null, language = 'en') {
  log.debug(`[VISUAL BIBLE PROMPT] Building prompt for page ${pageNumber}`);

  if (!visualBible) return '';

  // Collect all entries (not filtered by page)
  const allEntries = [];
  for (const entry of visualBible.secondaryCharacters || []) {
    allEntries.push({ ...entry, type: 'character' });
  }
  for (const entry of visualBible.animals || []) {
    allEntries.push({ ...entry, type: 'animal' });
  }
  for (const entry of visualBible.artifacts || []) {
    allEntries.push({ ...entry, type: 'artifact' });
  }
  for (const entry of visualBible.locations || []) {
    allEntries.push({ ...entry, type: 'location' });
  }

  log.debug(`[VISUAL BIBLE PROMPT] Total entries: ${allEntries.length} (${allEntries.map(e => e.name).join(', ') || 'none'})`);

  // If no entries, return empty
  if (allEntries.length === 0) {
    return '';
  }

  // Build intro text based on language
  let introText;
  if (language === 'de') {
    introText = `**VISUELLE REFERENZELEMENTE (optional):**
Du kannst Elemente aus der visuellen Bibel unten verwenden, wenn sie fuer diese Szene passend sind.
Diese Elemente sind NICHT erforderlich - fuege sie nur hinzu, wenn sie natuerlich ins Bild passen.`;
  } else if (language === 'fr') {
    introText = `**ELEMENTS DE REFERENCE VISUELS (optionnel):**
Vous pouvez utiliser les elements de la bible visuelle ci-dessous s'ils sont appropries pour cette scene.
Ces elements ne sont PAS obligatoires - incluez-les uniquement s'ils s'integrent naturellement dans l'image.`;
  } else {
    introText = `**VISUAL REFERENCE ELEMENTS (optional):**
You may use elements from the visual bible below if appropriate for this scene.
These elements are NOT required - only include them if they naturally fit the image.`;
  }

  let prompt = `\n${introText}\n\n`;

  // Add all recurring elements
  for (const entry of allEntries) {
    const description = entry.extractedDescription || entry.description;
    prompt += `**${entry.name}** (${entry.type}): ${description}\n`;
  }

  return prompt;
}

/**
 * Build Visual Bible prompt for covers (all main characters + 2-3 key story elements)
 */
function buildFullVisualBiblePrompt(visualBible) {
  if (!visualBible) return '';

  let prompt = '';

  // Add ALL main characters with their style DNA
  if (visualBible.mainCharacters && visualBible.mainCharacters.length > 0) {
    prompt += '\n\n**MAIN CHARACTERS - Must match reference photos exactly:**\n';
    for (const char of visualBible.mainCharacters) {
      prompt += `**${char.name}:**\n`;
      if (char.physical) {
        // Basic traits
        if (char.physical.age && char.physical.age !== 'Unknown') {
          prompt += `- Age: ${char.physical.age} years old\n`;
        }
        if (char.physical.gender && char.physical.gender !== 'Unknown') {
          prompt += `- Gender: ${char.physical.gender}\n`;
        }
        if (char.physical.height && char.physical.height !== 'Unknown') {
          prompt += `- Height: ${char.physical.height} cm\n`;
        }
        if (char.physical.build && char.physical.build !== 'Unknown' && char.physical.build !== 'Not analyzed') {
          prompt += `- Build: ${char.physical.build}\n`;
        }
        // Detailed features
        if (char.physical.face && char.physical.face !== 'Not analyzed') {
          prompt += `- Face: ${char.physical.face}\n`;
        }
        if (char.physical.hair && char.physical.hair !== 'Not analyzed') {
          prompt += `- Hair: ${char.physical.hair}\n`;
        }
        // Include other physical traits (glasses, birthmarks, always-present accessories)
        if (char.physical.other && char.physical.other !== 'Not analyzed' && char.physical.other !== 'none') {
          prompt += `- Other features: ${char.physical.other}\n`;
        }
      }
    }
  }

  // Add only 2-3 key story elements (prioritize animals and important artifacts)
  const keyElements = [];

  // First add animals (pets, companions - usually most important)
  for (const entry of visualBible.animals || []) {
    if (keyElements.length < 3) {
      keyElements.push({ ...entry, type: 'animal' });
    }
  }

  // Then add artifacts if we have room
  for (const entry of visualBible.artifacts || []) {
    if (keyElements.length < 3) {
      keyElements.push({ ...entry, type: 'artifact' });
    }
  }

  if (keyElements.length > 0) {
    prompt += '\n**KEY STORY ELEMENTS:**\n';
    for (const entry of keyElements) {
      const description = entry.extractedDescription || entry.description;
      prompt += `**${entry.name}** (${entry.type}): ${description}\n`;
    }
  }

  return prompt;
}

// ============================================================================
// IMAGE ANALYSIS FUNCTIONS
// ============================================================================

/**
 * Analyze generated image to extract detailed descriptions of Visual Bible elements
 * Uses Gemini Flash for efficient image analysis
 */
async function analyzeVisualBibleElements(imageData, elementsToAnalyze) {
  if (!elementsToAnalyze || elementsToAnalyze.length === 0) {
    return [];
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    log.warn('[VISUAL BIBLE] Gemini API key not configured, skipping analysis');
    return [];
  }

  try {
    // Build the analysis prompt from template
    const elementsList = elementsToAnalyze.map(e => `- ${e.name} (${e.type})`).join('\n');
    const analysisPrompt = fillTemplate(PROMPT_TEMPLATES.visualBibleAnalysis, {
      '{ELEMENTS_LIST}': elementsList
    });

    // Extract base64 and mime type
    const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
    const mimeType = imageData.match(/^data:(image\/\w+);base64,/) ?
      imageData.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    // Build content array
    const parts = [
      {
        inline_data: {
          mime_type: mimeType,
          data: base64Data
        }
      },
      { text: analysisPrompt }
    ];

    // Use Gemini Flash for analysis
    const modelId = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: 2000,
          temperature: 0.3
        }
      })
    });

    if (!response.ok) {
      log.warn(`[VISUAL BIBLE] Gemini API error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Parse JSON response
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn('[VISUAL BIBLE] Could not parse JSON response');
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const results = parsed.elements || [];

    log.debug(`[VISUAL BIBLE] Analyzed ${results.length} elements from image`);

    return results;
  } catch (error) {
    log.error('[VISUAL BIBLE] Error analyzing image:', error.message);
    return [];
  }
}

/**
 * Update Visual Bible with extracted descriptions after first appearance
 */
function updateVisualBibleWithExtracted(visualBible, pageNumber, extractedDescriptions) {
  if (!visualBible || !extractedDescriptions || extractedDescriptions.length === 0) {
    return visualBible;
  }

  const updateEntries = (entries) => {
    for (const entry of entries) {
      // Check if this is the first appearance for this entry
      const firstAppearancePage = Math.min(...entry.appearsInPages);
      if (firstAppearancePage === pageNumber && !entry.firstAppearanceAnalyzed) {
        // Find matching extracted description
        const extracted = extractedDescriptions.find(
          e => e.name.toLowerCase() === entry.name.toLowerCase()
        );
        if (extracted && extracted.description) {
          entry.extractedDescription = extracted.description;
          entry.firstAppearanceAnalyzed = true;
          log.debug(`[VISUAL BIBLE] Updated "${entry.name}" with extracted description`);
        }
      }
    }
  };

  updateEntries(visualBible.secondaryCharacters || []);
  updateEntries(visualBible.animals || []);
  updateEntries(visualBible.artifacts || []);
  updateEntries(visualBible.locations || []);

  return visualBible;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Parsing
  parseVisualBible,
  filterMainCharactersFromVisualBible,
  parseVisualBibleEntries,

  // Initialization
  initializeVisualBibleMainCharacters,

  // Change tracking
  addVisualBibleChangeLog,
  updateMainCharacterOutfit,

  // Query
  getVisualBibleEntriesForPage,
  getElementsNeedingAnalysis,

  // Prompt building
  buildVisualBiblePrompt,
  buildFullVisualBiblePrompt,

  // Image analysis
  analyzeVisualBibleElements,
  updateVisualBibleWithExtracted
};
