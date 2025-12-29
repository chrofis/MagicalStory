/**
 * Unified Outline Parser
 *
 * Centralizes all extraction logic for story outlines with consistent
 * multilingual support (English, German, French).
 */

const { log } = require('../utils/logger');

// ============================================================================
// CENTRALIZED KEYWORDS - Single source of truth for all languages
// ============================================================================

const KEYWORDS = {
  title: ['Title', 'Titel', 'Titre'],
  page: ['Page', 'Seite', 'Page'],
  scene: ['Scene', 'Szene', 'Scène', 'Visual', 'Setting', 'Image'],
  clothing: ['Clothing', 'Kleidung', 'Vêtements', 'Tenue'],
  characterFocus: ['Character Focus', 'Charakterfokus', 'Personnage Principal'],
  characters: ['Characters', 'Charaktere', 'Personnages'],
  text: ['Text', 'Text', 'Texte'],
  story: ['Story', 'Geschichte', 'Histoire'],
  backCover: ['Back Cover', 'Rückseite', 'Quatrième de couverture'],
  titlePage: ['Title Page', 'Titelseite', 'Page de titre'],
  initialPage: ['Initial Page', 'Einführungsseite', 'Page initiale'],
  visualBible: ['Visual Bible', 'Visuelle Bibel', 'Bible Visuelle'],
  primaryClothing: ['Primary Clothing', 'Hauptkleidung', 'Tenue principale'],
  clothingChange: ['Clothing Change', 'Kleidungswechsel', 'Changement de tenue'],
  pageByPage: ['Page-by-Page', 'Seitenweise', 'Page par page'],
};

// Clothing categories (same across languages)
const CLOTHING_CATEGORIES = ['winter', 'summer', 'formal', 'standard'];

// ============================================================================
// REGEX BUILDERS - Create patterns from keywords
// ============================================================================

/**
 * Create a regex pattern that matches any of the keywords
 * @param {string[]} keywords - Array of keyword variants
 * @param {string} flags - Regex flags (default: 'i' for case-insensitive)
 */
function keywordPattern(keywords, flags = 'i') {
  const escaped = keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:${escaped.join('|')})`, flags);
}

/**
 * Create a pattern for matching page headers
 * Matches: "Page 1:", "## Page 1", "**Page 1:**", "--- Page 1 ---", "Seite 1:", etc.
 */
function createPageHeaderPattern() {
  const pageWords = KEYWORDS.page.join('|');
  return new RegExp(
    `^(?:#{1,3}\\s*)?(?:---\\s*)?\\*{0,2}(?:${pageWords})\\s+(\\d+)\\s*(?:\\*{0,2})?(?::|\\.|\\-|\\s*---)`,
    'im'
  );
}

/**
 * Create a pattern for matching section headers (Title, Scene, etc.)
 * @param {string[]} keywords - Section keywords to match
 */
function createSectionPattern(keywords) {
  const pattern = keywordPattern(keywords).source;
  return new RegExp(
    `^(?:#{1,2}\\s*)?(?:\\*{0,2})?${pattern}(?:\\*{0,2})?\\s*(?::|\\n)`,
    'im'
  );
}

// Pre-compiled patterns for performance
const PAGE_HEADER_PATTERN = createPageHeaderPattern();
const TITLE_HEADER_PATTERN = new RegExp(
  `^#{1,2}\\s*(?:${KEYWORDS.title.join('|')})\\s*\\n+`,
  'im'
);
const CLOTHING_CATEGORY_PATTERN = new RegExp(
  `(${CLOTHING_CATEGORIES.join('|')})`,
  'i'
);

// ============================================================================
// OUTLINE PARSER CLASS
// ============================================================================

class OutlineParser {
  /**
   * @param {string} outline - The story outline text
   */
  constructor(outline) {
    this.outline = outline || '';
    this.lines = this.outline.split('\n');
    this._cache = {}; // Cache extracted results
  }

  // --------------------------------------------------------------------------
  // UTILITY METHODS
  // --------------------------------------------------------------------------

  /**
   * Find all page header positions in the outline
   * @returns {Array<{pageNum: number, lineIndex: number, line: string}>}
   */
  findPageHeaders() {
    if (this._cache.pageHeaders) return this._cache.pageHeaders;

    const headers = [];
    const pageWords = KEYWORDS.page.join('|');
    const pattern = new RegExp(
      `^(?:#{1,3}\\s*)?(?:---\\s*)?\\*{0,2}(?:${pageWords})\\s+(\\d+)\\s*(?:\\*{0,2})?(?::|\\.|\\-|\\s*---)`,
      'i'
    );

    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i].trim();
      const match = line.match(pattern);
      if (match) {
        headers.push({
          pageNum: parseInt(match[1]),
          lineIndex: i,
          line: line
        });
      }
    }

    this._cache.pageHeaders = headers;
    return headers;
  }

  /**
   * Get lines between two indices (exclusive of end)
   */
  getLinesBetween(startIndex, endIndex) {
    return this.lines.slice(startIndex + 1, endIndex);
  }

  /**
   * Find a field value in a set of lines
   * @param {string[]} lines - Lines to search
   * @param {string[]} keywords - Field keywords to match
   * @returns {string|null} - Field value or null
   */
  findFieldValue(lines, keywords) {
    const pattern = keywordPattern(keywords);
    for (const line of lines) {
      const trimmed = line.trim();
      // Match: "**Keyword:** value" or "Keyword: value" or "- Keyword: value"
      const match = trimmed.match(
        new RegExp(`^[-*\\u2022]?\\s*\\*{0,2}${pattern.source}\\*{0,2}[:\\s]+(.+)`, 'i')
      );
      if (match && match[1]) {
        return match[1].replace(/^\*{1,2}|\*{1,2}$/g, '').trim();
      }
    }
    return null;
  }

  /**
   * Clean markdown formatting from text
   */
  cleanMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/^\*{1,2}|\*{1,2}$/g, '')  // Remove bold markers
      .replace(/^\[|\]$/g, '')             // Remove brackets
      .replace(/^#+\s*/, '')               // Remove heading markers
      .trim();
  }

  // --------------------------------------------------------------------------
  // TITLE EXTRACTION
  // --------------------------------------------------------------------------

  /**
   * Extract story title from outline
   * Supports multiple formats:
   * - "# Title\n**Actual Title**"
   * - "# Title\nTitle: Actual Title"
   * - "# Title\nActual Title"
   * - "TITLE: Actual Title"
   * @returns {string|null}
   */
  extractTitle() {
    if (this._cache.title !== undefined) return this._cache.title;

    const titleWords = KEYWORDS.title.join('|');

    // Pattern 1: Header followed by bold title
    const boldMatch = this.outline.match(
      new RegExp(`^#{1,2}\\s*(?:${titleWords})\\s*\\n+\\*\\*(.+?)\\*\\*`, 'im')
    );
    if (boldMatch) {
      this._cache.title = boldMatch[1].trim();
      log.debug(`[OUTLINE-PARSER] Title (bold format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 2: Header followed by "Title: value"
    const prefixMatch = this.outline.match(
      new RegExp(`^#{1,2}\\s*(?:${titleWords})\\s*\\n+(?:${titleWords}):\\s*(.+?)$`, 'im')
    );
    if (prefixMatch) {
      this._cache.title = prefixMatch[1].trim();
      log.debug(`[OUTLINE-PARSER] Title (prefix format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 3: Header followed by plain text (not another header or divider)
    const plainMatch = this.outline.match(
      new RegExp(`^#{1,2}\\s*(?:${titleWords})\\s*\\n+([^#\\-\\n].+?)$`, 'im')
    );
    if (plainMatch) {
      this._cache.title = plainMatch[1].trim();
      log.debug(`[OUTLINE-PARSER] Title (plain format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 4: Inline "TITLE: value"
    const inlineMatch = this.outline.match(
      new RegExp(`(?:${titleWords}):\\s*(.+)`, 'i')
    );
    if (inlineMatch) {
      this._cache.title = inlineMatch[1].trim();
      log.debug(`[OUTLINE-PARSER] Title (inline format): "${this._cache.title}"`);
      return this._cache.title;
    }

    this._cache.title = null;
    log.debug('[OUTLINE-PARSER] No title found');
    return null;
  }

  // --------------------------------------------------------------------------
  // SCENE DESCRIPTIONS EXTRACTION
  // --------------------------------------------------------------------------

  /**
   * Extract short scene descriptions for each page
   * @returns {Object<number, string>} - Map of page number to scene description
   */
  extractSceneDescriptions() {
    if (this._cache.sceneDescriptions) return this._cache.sceneDescriptions;

    const descriptions = {};
    const pageHeaders = this.findPageHeaders();
    const sceneKeywords = KEYWORDS.scene;

    log.debug(`[OUTLINE-PARSER] Found ${pageHeaders.length} page headers`);

    for (let i = 0; i < pageHeaders.length; i++) {
      const { pageNum, lineIndex } = pageHeaders[i];
      const nextIndex = pageHeaders[i + 1]?.lineIndex || this.lines.length;
      const pageLines = this.getLinesBetween(lineIndex, nextIndex);

      // Try to find scene description in page content
      let scene = null;

      // Method 1: Look for explicit Scene: field
      scene = this.findFieldValue(pageLines, sceneKeywords);
      if (scene && scene.length > 10) {
        descriptions[pageNum] = scene;
        log.debug(`[OUTLINE-PARSER] Page ${pageNum} scene (field): ${scene.substring(0, 60)}...`);
        continue;
      }

      // Method 2: Check same line as page header for inline scene
      const headerLine = this.lines[lineIndex];
      const inlineMatch = headerLine.match(
        new RegExp(`(?:${sceneKeywords.join('|')})(?:\\s+Description)?[:\\s]+(.+)`, 'i')
      );
      if (inlineMatch && inlineMatch[1].trim().length > 10) {
        descriptions[pageNum] = inlineMatch[1].trim();
        log.debug(`[OUTLINE-PARSER] Page ${pageNum} scene (inline): ${descriptions[pageNum].substring(0, 60)}...`);
        continue;
      }

      // Method 3: Use first substantial line that's not a known field
      const skipPatterns = keywordPattern([
        ...KEYWORDS.characterFocus,
        ...KEYWORDS.clothing,
        ...KEYWORDS.title,
        ...KEYWORDS.text,
        ...KEYWORDS.story
      ]);

      for (const line of pageLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.length < 20) continue;
        if (skipPatterns.test(trimmed)) continue;

        descriptions[pageNum] = this.cleanMarkdown(trimmed);
        log.debug(`[OUTLINE-PARSER] Page ${pageNum} scene (fallback): ${descriptions[pageNum].substring(0, 60)}...`);
        break;
      }
    }

    this._cache.sceneDescriptions = descriptions;
    log.debug(`[OUTLINE-PARSER] Extracted ${Object.keys(descriptions).length} scene descriptions`);
    return descriptions;
  }

  // --------------------------------------------------------------------------
  // COVER SCENES EXTRACTION
  // --------------------------------------------------------------------------

  /**
   * Extract cover scene descriptions and clothing
   * @returns {{titlePage: {scene: string, clothing: string|null}, initialPage: {scene: string, clothing: string|null}, backCover: {scene: string, clothing: string|null}}}
   */
  extractCoverScenes() {
    if (this._cache.coverScenes) return this._cache.coverScenes;

    const coverScenes = {
      titlePage: { scene: '', clothing: null },
      initialPage: { scene: '', clothing: null },
      backCover: { scene: '', clothing: null }
    };

    // Try storybook format first (---TITLE PAGE---, ---BACK COVER---)
    this._extractStorybookCoverScenes(coverScenes);

    // Try story mode format (Title Page Scene:, Back Cover Scene:)
    this._extractStoryModeCoverScenes(coverScenes);

    this._cache.coverScenes = coverScenes;

    log.debug(`[OUTLINE-PARSER] Cover scenes extracted:`);
    log.debug(`  Title Page: ${coverScenes.titlePage.scene.substring(0, 50) || 'none'}...`);
    log.debug(`  Initial Page: ${coverScenes.initialPage.scene.substring(0, 50) || 'none'}...`);
    log.debug(`  Back Cover: ${coverScenes.backCover.scene.substring(0, 50) || 'none'}...`);

    return coverScenes;
  }

  /**
   * Extract cover scenes from storybook format (---TITLE PAGE---)
   */
  _extractStorybookCoverScenes(coverScenes) {
    // Title Page
    const titlePageMatch = this.outline.match(
      /---\s*TITLE\s+PAGE\s*---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i
    );
    if (titlePageMatch) {
      const block = titlePageMatch[1];
      coverScenes.titlePage.scene = this._extractSceneFromBlock(block);
      coverScenes.titlePage.clothing = this._extractClothingFromBlock(block);
    }

    // Initial Page
    const initialPageMatch = this.outline.match(
      /---\s*INITIAL\s+PAGE\s*---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i
    );
    if (initialPageMatch) {
      const block = initialPageMatch[1];
      coverScenes.initialPage.scene = this._extractSceneFromBlock(block);
      coverScenes.initialPage.clothing = this._extractClothingFromBlock(block);
    }

    // Back Cover
    const backCoverMatch = this.outline.match(
      /---\s*BACK\s+COVER\s*---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i
    );
    if (backCoverMatch) {
      const block = backCoverMatch[1];
      coverScenes.backCover.scene = this._extractSceneFromBlock(block);
      coverScenes.backCover.clothing = this._extractClothingFromBlock(block);
    }
  }

  /**
   * Extract cover scenes from story mode format (Title Page Scene:)
   */
  _extractStoryModeCoverScenes(coverScenes) {
    const titleWords = KEYWORDS.titlePage.join('|');
    const backWords = KEYWORDS.backCover.join('|');
    const initialWords = KEYWORDS.initialPage.join('|');

    // Title Page Scene
    if (!coverScenes.titlePage.scene) {
      const match = this.outline.match(
        new RegExp(`(?:${titleWords})\\s*(?:Scene)?[:\\s]+([^\\n]+(?:\\n(?![A-Z][a-z]+\\s*(?:Scene|Page)?:)[^\\n]+)*)`, 'i')
      );
      if (match) {
        coverScenes.titlePage.scene = this.cleanMarkdown(match[1]);
      }
    }

    // Back Cover Scene
    if (!coverScenes.backCover.scene) {
      const match = this.outline.match(
        new RegExp(`(?:${backWords})\\s*(?:Scene)?[:\\s]+([^\\n]+(?:\\n(?![A-Z][a-z]+\\s*(?:Scene|Page)?:)[^\\n]+)*)`, 'i')
      );
      if (match) {
        coverScenes.backCover.scene = this.cleanMarkdown(match[1]);
      }
    }

    // Initial Page Scene
    if (!coverScenes.initialPage.scene) {
      const match = this.outline.match(
        new RegExp(`(?:${initialWords})\\s*(?:Scene)?[:\\s]+([^\\n]+(?:\\n(?![A-Z][a-z]+\\s*(?:Scene|Page)?:)[^\\n]+)*)`, 'i')
      );
      if (match) {
        coverScenes.initialPage.scene = this.cleanMarkdown(match[1]);
      }
    }
  }

  /**
   * Extract scene description from a block of text
   */
  _extractSceneFromBlock(block) {
    const lines = block.split('\n');
    const parts = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Look for structured parts (Setting:, Characters:, Action:, Mood:)
      const settingMatch = trimmed.match(/^(?:\*\*)?Setting(?:\*\*)?[:\s]+(.+)/i);
      const charactersMatch = trimmed.match(/^(?:\*\*)?Characters(?:\*\*)?[:\s]+(.+)/i);
      const actionMatch = trimmed.match(/^(?:\*\*)?Action(?:\*\*)?[:\s]+(.+)/i);
      const moodMatch = trimmed.match(/^(?:\*\*)?Mood(?:\*\*)?[:\s]+(.+)/i);
      const sceneMatch = trimmed.match(
        new RegExp(`^(?:\\*\\*)?(?:${KEYWORDS.scene.join('|')})(?:\\*\\*)?[:\\s]+(.+)`, 'i')
      );

      if (settingMatch) parts.push(settingMatch[1]);
      else if (charactersMatch) parts.push(`Characters: ${charactersMatch[1]}`);
      else if (actionMatch) parts.push(actionMatch[1]);
      else if (moodMatch) parts.push(`Mood: ${moodMatch[1]}`);
      else if (sceneMatch) parts.push(sceneMatch[1]);
    }

    if (parts.length > 0) {
      return parts.join(' ').trim();
    }

    // Fallback: use first substantial line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 20 && !trimmed.match(/^(?:\*\*)?(?:Clothing|Setting|Characters|Action|Mood)/i)) {
        return this.cleanMarkdown(trimmed);
      }
    }

    return '';
  }

  /**
   * Extract clothing category from a block of text
   */
  _extractClothingFromBlock(block) {
    const clothingKeywords = KEYWORDS.clothing.join('|');
    const match = block.match(
      new RegExp(`(?:${clothingKeywords})[:\\s]+\\[?\\s*(${CLOTHING_CATEGORIES.join('|')})`, 'i')
    );
    return match ? match[1].toLowerCase() : null;
  }

  // --------------------------------------------------------------------------
  // PAGE CLOTHING EXTRACTION
  // --------------------------------------------------------------------------

  /**
   * Extract clothing information for all pages
   * @param {number} totalPages - Total number of story pages
   * @returns {{primaryClothing: string, pageClothing: Object<number, string>}}
   */
  extractPageClothing(totalPages = 20) {
    const cacheKey = `pageClothing_${totalPages}`;
    if (this._cache[cacheKey]) return this._cache[cacheKey];

    const result = {
      primaryClothing: 'standard',
      pageClothing: {}
    };

    // Step 1: Find primary clothing
    const primaryKeywords = KEYWORDS.primaryClothing.join('|');
    const primaryMatch = this.outline.match(
      new RegExp(`(?:\\*\\*)?(?:${primaryKeywords})(?:\\*\\*)?[:\\s]+\\[?\\s*(${CLOTHING_CATEGORIES.join('|')})`, 'i')
    );
    if (primaryMatch) {
      result.primaryClothing = primaryMatch[1].toLowerCase();
      log.debug(`[OUTLINE-PARSER] Primary clothing: ${result.primaryClothing}`);
    }

    // Step 2: Initialize all pages with primary clothing
    for (let i = 1; i <= totalPages; i++) {
      result.pageClothing[i] = result.primaryClothing;
    }

    // Step 3: Find clothing changes in change events section
    const changeKeywords = KEYWORDS.clothingChange.join('|');
    const changeEventsMatch = this.outline.match(
      new RegExp(`(?:${changeKeywords})\\s*(?:Events)?[:\\s]*([\\s\\S]*?)(?=\\n\\s*\\n|\\n---|\\n#|$)`, 'i')
    );
    if (changeEventsMatch) {
      this._parseClothingChanges(changeEventsMatch[1], result.pageClothing);
    }

    // Step 4: Parse per-page clothing in page breakdown
    this._parsePerPageClothing(result);

    // Log summary
    const changes = Object.entries(result.pageClothing)
      .filter(([, clothing]) => clothing !== result.primaryClothing)
      .map(([page, clothing]) => `P${page}:${clothing}`);
    if (changes.length > 0) {
      log.debug(`[OUTLINE-PARSER] Clothing changes: ${changes.join(', ')}`);
    }

    this._cache[cacheKey] = result;
    return result;
  }

  /**
   * Parse clothing changes from change events text
   */
  _parseClothingChanges(changesText, pageClothing) {
    const pageWords = KEYWORDS.page.join('|');
    const pattern = new RegExp(
      `(?:${pageWords})\\s+(\\d+)\\s*[:\\(][^)]*?(?:→|->|change\\s+to:?\\s*)\\s*(${CLOTHING_CATEGORIES.join('|')})`,
      'gi'
    );

    let match;
    while ((match = pattern.exec(changesText)) !== null) {
      const pageNum = parseInt(match[1]);
      const clothing = match[2].toLowerCase();
      pageClothing[pageNum] = clothing;
      log.debug(`[OUTLINE-PARSER] Page ${pageNum} changes to: ${clothing}`);
    }
  }

  /**
   * Parse clothing from per-page breakdown
   */
  _parsePerPageClothing(result) {
    const pageHeaders = this.findPageHeaders();
    let lastClothing = result.primaryClothing;

    for (let i = 0; i < pageHeaders.length; i++) {
      const { pageNum, lineIndex } = pageHeaders[i];
      const nextIndex = pageHeaders[i + 1]?.lineIndex || this.lines.length;
      const pageLines = this.getLinesBetween(lineIndex, nextIndex);

      const clothingValue = this.findFieldValue(pageLines, KEYWORDS.clothing);
      if (clothingValue) {
        const lowerValue = clothingValue.toLowerCase();

        if (lowerValue === 'same' || lowerValue.includes('[same]')) {
          result.pageClothing[pageNum] = lastClothing;
        } else {
          // Look for clothing category
          const categoryMatch = lowerValue.match(CLOTHING_CATEGORY_PATTERN);
          if (categoryMatch) {
            result.pageClothing[pageNum] = categoryMatch[1].toLowerCase();
            lastClothing = result.pageClothing[pageNum];
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // VISUAL BIBLE EXTRACTION (PLACEHOLDER)
  // --------------------------------------------------------------------------

  /**
   * Check if outline has a Visual Bible section
   * @returns {boolean}
   */
  hasVisualBible() {
    const keywords = KEYWORDS.visualBible.join('|');
    return new RegExp(`(?:${keywords})`, 'i').test(this.outline);
  }

  /**
   * Get the Visual Bible section text
   * @returns {string|null}
   */
  getVisualBibleSection() {
    const keywords = KEYWORDS.visualBible.join('|');
    const match = this.outline.match(
      new RegExp(`(?:#{1,3}\\s*)?(?:${keywords})[:\\s]*([\\s\\S]*?)(?=\\n#{1,3}\\s|\\n---\\s*(?:PAGE|BACK)|$)`, 'i')
    );
    return match ? match[1].trim() : null;
  }
}

// ============================================================================
// SCENE DESCRIPTION PARSER - For extracting character names from scene descriptions
// ============================================================================

/**
 * Extract character names from a scene description's Characters section
 * Robust parsing that handles multiple formats:
 * - "* **Name:**" or "* **Name**:" or "- **Name:**"
 * - "**Name:**" without bullet
 * - Numbered: "1. **Name:**"
 * - With or without trailing content
 *
 * @param {string} sceneDescription - The full scene description text
 * @returns {string[]} - Array of character names found (lowercased, trimmed)
 */
function extractCharacterNamesFromScene(sceneDescription) {
  if (!sceneDescription) return [];

  const characterNames = [];
  const charactersKeywords = KEYWORDS.characters.join('|');

  // Step 1: Try to find the Characters section
  // Matches: "5. **Characters:**", "**Characters:**", "## Characters:", etc.
  const sectionPattern = new RegExp(
    `(?:^|\\n)\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:${charactersKeywords})\\*{0,2}\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:Objects|Animals|Objekte|Tiere|Objets|Animaux|Setting|Composition|Constraints|Safety)\\*{0,2}|$)`,
    'i'
  );
  const sectionMatch = sceneDescription.match(sectionPattern);
  log.debug(`[SCENE-PARSER] Looking for Characters section in scene (${sceneDescription.length} chars)`);
  log.debug(`[SCENE-PARSER] Section pattern match: ${sectionMatch ? 'FOUND' : 'NOT FOUND'}`);

  if (sectionMatch && sectionMatch[1]) {
    const charactersSection = sectionMatch[1];

    // DEBUG: Log the captured section
    log.debug(`[SCENE-PARSER] Characters section captured (${charactersSection.length} chars):`);
    log.debug(`[SCENE-PARSER] Section content: "${charactersSection.substring(0, 500)}"`);

    // Step 2: Extract names from the section
    // Pattern handles multiple formats:
    // - "* **Name:**" or "- **Name:**" (bullet + bold + colon)
    // - "* **Name**" or "- **Name**" (bullet + bold, no colon)
    // - "**Name:**" (bold + colon, no bullet)
    // - "1. **Name:**" (numbered)
    const namePatterns = [
      // Bullet (single *, -, •) + space + bold name with optional colon
      // Note: Use [\s]* for whitespace only, then optional single bullet, to avoid consuming **
      /^[\t ]*(?:[\-\*\u2022]\s*)?(?:\d+\.\s*)?\*\*([^*:]+?)\*\*\s*:?/gm,
      // Bold name at start of line (no bullet)
      /^\s*\*\*([^*:]+?)\*\*\s*:?/gm,
    ];

    for (const pattern of namePatterns) {
      let match;
      log.debug(`[SCENE-PARSER] Trying pattern: ${pattern.toString().substring(0, 80)}...`);
      while ((match = pattern.exec(charactersSection)) !== null) {
        const name = match[1].trim();
        log.debug(`[SCENE-PARSER]   Raw match: "${name}" at index ${match.index}`);
        // Skip if it looks like a section header or is too short
        if (name.length >= 2 && !name.match(/^(?:Characters|Charaktere|Personnages|Physical|Description)$/i)) {
          const nameLower = name.toLowerCase();
          if (!characterNames.includes(nameLower)) {
            characterNames.push(nameLower);
            log.debug(`[SCENE-PARSER]   -> Added: "${nameLower}"`);
          } else {
            log.debug(`[SCENE-PARSER]   -> Duplicate, skipped`);
          }
        } else {
          log.debug(`[SCENE-PARSER]   -> Filtered out (header or too short)`);
        }
      }
    }

    if (characterNames.length > 0) {
      log.debug(`[SCENE-PARSER] Found ${characterNames.length} characters in section: ${characterNames.join(', ')}`);
      return characterNames;
    }
  }

  // Step 3: Fallback - look for "Main characters:" in Image Summary
  // Format: "Main characters: Name1, Name2, Name3."
  const mainCharsMatch = sceneDescription.match(/Main characters?:\s*([^.]+)/i);
  if (mainCharsMatch && mainCharsMatch[1]) {
    const names = mainCharsMatch[1].split(/[,&]/).map(n => n.trim().toLowerCase()).filter(n => n.length >= 2);
    for (const name of names) {
      if (!characterNames.includes(name)) {
        characterNames.push(name);
      }
    }
    if (characterNames.length > 0) {
      log.debug(`[SCENE-PARSER] Found ${characterNames.length} characters from "Main characters:": ${characterNames.join(', ')}`);
      return characterNames;
    }
  }

  // Step 4: Fallback - look for character headers in Composition section
  // Format: "* Name:" followed by ACTION/POSITION/EXPRESSION (not bold)
  const compositionPattern = /[\s\-\*\u2022]+([A-Z][a-zäöü]+)\s*:\s*\n[\s\-]+(?:ACTION|POSITION|EXPRESSION)/gi;
  let compMatch;
  while ((compMatch = compositionPattern.exec(sceneDescription)) !== null) {
    const name = compMatch[1].trim().toLowerCase();
    // Skip common non-character words
    if (name.length >= 2 && !characterNames.includes(name) && !['action', 'position', 'expression', 'orientation', 'pose'].includes(name)) {
      characterNames.push(name);
    }
  }
  if (characterNames.length > 0) {
    log.debug(`[SCENE-PARSER] Found ${characterNames.length} characters from Composition section: ${characterNames.join(', ')}`);
    return characterNames;
  }

  // Step 5: Fallback - look for character headers anywhere in the scene (bold format)
  // This handles scenes without a dedicated Characters section
  log.debug(`[SCENE-PARSER] No Characters section found, using fallback pattern matching`);

  // Look for patterns like "* **Name:**" followed by action/position keywords
  const fallbackPattern = /[\s\-\*\u2022]+\*\*([^*:]+?)\*\*\s*:[\s\S]*?(?:ACTION|POSITION|EXPRESSION|action|position|expression)/gi;
  let match;
  while ((match = fallbackPattern.exec(sceneDescription)) !== null) {
    const name = match[1].trim().toLowerCase();
    if (name.length >= 2 && !characterNames.includes(name)) {
      characterNames.push(name);
    }
  }

  if (characterNames.length > 0) {
    log.debug(`[SCENE-PARSER] Fallback found ${characterNames.length} characters: ${characterNames.join(', ')}`);
  }

  return characterNames;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  OutlineParser,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  extractCharacterNamesFromScene
};
