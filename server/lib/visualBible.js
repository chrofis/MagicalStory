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
// STORY TEXT VISUAL BIBLE FUNCTIONS
// ============================================================================

/**
 * Format Visual Bible entries for inclusion in story text prompt.
 * Shows what's already defined so the model knows what NOT to add.
 */
function formatVisualBibleForStoryText(visualBible) {
  if (!visualBible) return 'None defined yet.';

  const sections = [];

  // Main characters (just names, full details in base prompt)
  if (visualBible.mainCharacters?.length > 0) {
    const names = visualBible.mainCharacters.map(c => c.name).join(', ');
    sections.push(`Main Characters: ${names}`);
  }

  // Secondary characters
  if (visualBible.secondaryCharacters?.length > 0) {
    sections.push('Secondary Characters:');
    for (const char of visualBible.secondaryCharacters) {
      sections.push(`- ${char.name} (pages ${char.pages?.join(', ') || 'multiple'}): ${char.description}`);
    }
  }

  // Animals
  if (visualBible.animals?.length > 0) {
    sections.push('Animals:');
    for (const animal of visualBible.animals) {
      sections.push(`- ${animal.name} (pages ${animal.pages?.join(', ') || 'multiple'}): ${animal.description}`);
    }
  }

  // Artifacts
  if (visualBible.artifacts?.length > 0) {
    sections.push('Artifacts:');
    for (const artifact of visualBible.artifacts) {
      sections.push(`- ${artifact.name} (pages ${artifact.pages?.join(', ') || 'multiple'}): ${artifact.description}`);
    }
  }

  // Locations
  if (visualBible.locations?.length > 0) {
    sections.push('Locations:');
    for (const loc of visualBible.locations) {
      sections.push(`- ${loc.name} (pages ${loc.pages?.join(', ') || 'multiple'}): ${loc.description}`);
    }
  }

  if (sections.length === 0) {
    return 'None defined yet.';
  }

  return sections.join('\n');
}

/**
 * Parse new Visual Bible entries from story text output.
 * Looks for ---NEW VISUAL BIBLE ENTRIES--- section at the beginning.
 */
function parseNewVisualBibleEntries(text) {
  const newEntries = {
    secondaryCharacters: [],
    animals: [],
    artifacts: [],
    locations: []
  };

  if (!text) return newEntries;

  // Find the NEW VISUAL BIBLE ENTRIES section
  const match = text.match(/---NEW VISUAL BIBLE ENTRIES---\s*([\s\S]*?)(?=---STORY TEXT---|--- Page \d+ ---|$)/i);
  if (!match) return newEntries;

  const section = match[1].trim();
  log.debug(`[VISUAL BIBLE] Found new entries section: ${section.substring(0, 200)}...`);

  // Check for "None" or empty
  if (!section || section.toLowerCase() === 'none') {
    log.debug('[VISUAL BIBLE] No new entries to add');
    return newEntries;
  }

  // Parse each type of entry
  // ANIMAL: Name
  // - Species: ...
  // - Coloring: ...
  // - Pages: 3, 5, 7
  const animalMatches = section.matchAll(/ANIMAL:\s*(.+?)(?=\n-)([\s\S]*?)(?=\n(?:ANIMAL|ARTIFACT|LOCATION|SECONDARY CHARACTER):|$)/gi);
  for (const m of animalMatches) {
    const name = m[1].trim();
    const details = m[2];
    const pagesMatch = details.match(/Pages?:\s*([\d,\s]+)/i);
    const pages = pagesMatch ? pagesMatch[1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p)) : [];

    // Build description from other fields
    const species = details.match(/Species:\s*(.+)/i)?.[1]?.trim() || '';
    const coloring = details.match(/Coloring:\s*(.+)/i)?.[1]?.trim() || '';
    const size = details.match(/Size:\s*(.+)/i)?.[1]?.trim() || '';
    const features = details.match(/Features:\s*(.+)/i)?.[1]?.trim() || '';

    const descParts = [species, coloring, size, features].filter(Boolean);
    const description = descParts.join('. ');

    if (name && description) {
      newEntries.animals.push({ name, description, pages });
      log.debug(`[VISUAL BIBLE] Parsed animal: ${name} (pages ${pages.join(',')})`);
    }
  }

  // ARTIFACT: Name
  const artifactMatches = section.matchAll(/ARTIFACT:\s*(.+?)(?=\n-)([\s\S]*?)(?=\n(?:ANIMAL|ARTIFACT|LOCATION|SECONDARY CHARACTER):|$)/gi);
  for (const m of artifactMatches) {
    const name = m[1].trim();
    const details = m[2];
    const pagesMatch = details.match(/Pages?:\s*([\d,\s]+)/i);
    const pages = pagesMatch ? pagesMatch[1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p)) : [];

    const type = details.match(/Type:\s*(.+)/i)?.[1]?.trim() || '';
    const appearance = details.match(/Appearance:\s*(.+)/i)?.[1]?.trim() || '';
    const features = details.match(/Features:\s*(.+)/i)?.[1]?.trim() || '';

    const descParts = [type, appearance, features].filter(Boolean);
    const description = descParts.join('. ');

    if (name && description) {
      newEntries.artifacts.push({ name, description, pages });
      log.debug(`[VISUAL BIBLE] Parsed artifact: ${name} (pages ${pages.join(',')})`);
    }
  }

  // LOCATION: Name
  const locationMatches = section.matchAll(/LOCATION:\s*(.+?)(?=\n-)([\s\S]*?)(?=\n(?:ANIMAL|ARTIFACT|LOCATION|SECONDARY CHARACTER):|$)/gi);
  for (const m of locationMatches) {
    const name = m[1].trim();
    const details = m[2];
    const pagesMatch = details.match(/Pages?:\s*([\d,\s]+)/i);
    const pages = pagesMatch ? pagesMatch[1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p)) : [];

    const setting = details.match(/Setting:\s*(.+)/i)?.[1]?.trim() || '';
    const features = details.match(/Features:\s*(.+)/i)?.[1]?.trim() || '';

    const descParts = [setting, features].filter(Boolean);
    const description = descParts.join('. ');

    if (name && description) {
      newEntries.locations.push({ name, description, pages });
      log.debug(`[VISUAL BIBLE] Parsed location: ${name} (pages ${pages.join(',')})`);
    }
  }

  // SECONDARY CHARACTER: Name
  const charMatches = section.matchAll(/SECONDARY CHARACTER:\s*(.+?)(?=\n-)([\s\S]*?)(?=\n(?:ANIMAL|ARTIFACT|LOCATION|SECONDARY CHARACTER):|$)/gi);
  for (const m of charMatches) {
    const name = m[1].trim();
    const details = m[2];
    const pagesMatch = details.match(/Pages?:\s*([\d,\s]+)/i);
    const pages = pagesMatch ? pagesMatch[1].split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p)) : [];

    const physical = details.match(/Physical:\s*(.+)/i)?.[1]?.trim() || '';
    const clothing = details.match(/Clothing:\s*(.+)/i)?.[1]?.trim() || '';

    const descParts = [physical, clothing].filter(Boolean);
    const description = descParts.join('. Typically wears: ');

    if (name && description) {
      newEntries.secondaryCharacters.push({ name, description, pages });
      log.debug(`[VISUAL BIBLE] Parsed secondary character: ${name} (pages ${pages.join(',')})`);
    }
  }

  const totalNew = newEntries.animals.length + newEntries.artifacts.length +
                   newEntries.locations.length + newEntries.secondaryCharacters.length;
  log.debug(`[VISUAL BIBLE] Parsed ${totalNew} new entries from story text`);

  return newEntries;
}

/**
 * Merge new Visual Bible entries into existing Visual Bible.
 * Avoids duplicates by name (case-insensitive).
 */
function mergeNewVisualBibleEntries(visualBible, newEntries) {
  if (!visualBible || !newEntries) return visualBible;

  const existingNames = new Set();

  // Collect all existing names (case-insensitive)
  for (const arr of [visualBible.secondaryCharacters, visualBible.animals, visualBible.artifacts, visualBible.locations]) {
    for (const entry of arr || []) {
      existingNames.add(entry.name.toLowerCase());
    }
  }
  // Also exclude main character names
  for (const char of visualBible.mainCharacters || []) {
    existingNames.add(char.name.toLowerCase());
  }

  let addedCount = 0;

  // Merge each category
  for (const char of newEntries.secondaryCharacters || []) {
    if (!existingNames.has(char.name.toLowerCase())) {
      visualBible.secondaryCharacters.push(char);
      addVisualBibleChangeLog(visualBible, `Added secondary character from story text: ${char.name}`);
      addedCount++;
    }
  }

  for (const animal of newEntries.animals || []) {
    if (!existingNames.has(animal.name.toLowerCase())) {
      visualBible.animals.push(animal);
      addVisualBibleChangeLog(visualBible, `Added animal from story text: ${animal.name}`);
      addedCount++;
    }
  }

  for (const artifact of newEntries.artifacts || []) {
    if (!existingNames.has(artifact.name.toLowerCase())) {
      visualBible.artifacts.push(artifact);
      addVisualBibleChangeLog(visualBible, `Added artifact from story text: ${artifact.name}`);
      addedCount++;
    }
  }

  for (const loc of newEntries.locations || []) {
    if (!existingNames.has(loc.name.toLowerCase())) {
      visualBible.locations.push(loc);
      addVisualBibleChangeLog(visualBible, `Added location from story text: ${loc.name}`);
      addedCount++;
    }
  }

  if (addedCount > 0) {
    log.debug(`[VISUAL BIBLE] Merged ${addedCount} new entries from story text`);
  }

  return visualBible;
}

/**
 * Extract story text from output that may contain Visual Bible additions.
 * Returns just the story pages without the Visual Bible section.
 */
function extractStoryTextFromOutput(text) {
  if (!text) return '';

  // If output has ---STORY TEXT--- marker, extract from there
  const storyMarker = text.indexOf('---STORY TEXT---');
  if (storyMarker !== -1) {
    return text.substring(storyMarker + '---STORY TEXT---'.length).trim();
  }

  // If output has ---NEW VISUAL BIBLE ENTRIES--- but no STORY TEXT marker,
  // look for first page marker
  const newEntriesMarker = text.indexOf('---NEW VISUAL BIBLE ENTRIES---');
  if (newEntriesMarker !== -1) {
    const pageMatch = text.match(/--- Page \d+ ---/i);
    if (pageMatch) {
      return text.substring(pageMatch.index).trim();
    }
  }

  // No special markers, return as-is
  return text;
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
  updateVisualBibleWithExtracted,

  // Story text Visual Bible additions
  formatVisualBibleForStoryText,
  parseNewVisualBibleEntries,
  mergeNewVisualBibleEntries,
  extractStoryTextFromOutput
};
