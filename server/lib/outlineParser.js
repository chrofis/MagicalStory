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
// Note: 'formal' replaced by 'costumed' - existing formal avatars used as fallback
const CLOTHING_CATEGORIES = ['winter', 'summer', 'costumed', 'standard'];

// ============================================================================
// SHARED HELPERS - Used by both UnifiedStoryParser and ProgressiveUnifiedParser
// ============================================================================

/**
 * Parse per-character clothing block from page content
 * Format: Characters:\n- Name1: category\n- Name2: category
 * Also supports legacy format: Characters: Name1, Name2 with separate Clothing: line
 * @param {string} content - Block content to parse
 * @returns {{characterClothing: Object, characters: string[]}}
 */
function parseCharacterClothingBlock(content) {
  const characterClothing = {};
  const characters = [];

  // Try new per-character format first:
  // Characters:
  // - Name1: standard
  // - Name2 (alias): costumed:type
  const charactersBlockMatch = content.match(/Characters:\s*([\s\S]*?)(?=---\s*Page|$)/i);
  if (charactersBlockMatch) {
    const block = charactersBlockMatch[1];
    // Match lines like "- Name: category" or "Name: category" (with or without leading hyphen)
    // Also allows "* Name: category" bullet format
    const linePattern = /^[-*]?\s*([^:\n]+):\s*(standard|winter|summer|costumed:\S+)/gim;
    let lineMatch;
    while ((lineMatch = linePattern.exec(block)) !== null) {
      const rawName = lineMatch[1].trim();
      const clothing = lineMatch[2].toLowerCase();
      // Extract base name (remove alias in parentheses for lookup, keep for display)
      const baseName = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim();
      characters.push(rawName);
      characterClothing[baseName] = clothing;
    }
    // Debug: log if Characters block found but no per-character clothing parsed
    if (characters.length === 0 && block.trim()) {
      log.debug(`[CLOTHING-PARSE] Characters block found but no per-char format matched. Block: "${block.substring(0, 200)}..."`);
    }
  } else {
    // Debug: log if no Characters block found at all
    const hasCharactersWord = content.includes('Characters');
    if (hasCharactersWord) {
      log.debug(`[CLOTHING-PARSE] Content has "Characters" but regex didn't match. Content snippet: "${content.substring(content.indexOf('Characters'), content.indexOf('Characters') + 200)}..."`);
    }
  }

  // If no per-character format found, try legacy format
  if (characters.length === 0) {
    // Legacy: Characters: Name1, Name2 on single line
    const legacyMatch = content.match(/Characters:\s*(.+?)(?:\n|$)/i);
    if (legacyMatch) {
      const charList = legacyMatch[1].split(/[,&]/).map(c => c.trim()).filter(c => c.length > 0);
      characters.push(...charList);
    }
    // Legacy: Clothing: category (single value for all)
    const clothingMatch = content.match(/Clothing:\s*(\S+)/i);
    if (clothingMatch) {
      const clothing = clothingMatch[1].toLowerCase();
      // Apply same clothing to all characters
      characters.forEach(char => {
        const baseName = char.replace(/\s*\([^)]*\)\s*$/, '').trim();
        characterClothing[baseName] = clothing === 'same' ? 'standard' : clothing;
      });
    }
  }

  return { characterClothing, characters };
}

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
   * Extract cover scenes from story mode format
   * Handles multiple formats:
   * - "Title Page Scene: content" (inline)
   * - "**Title Page Scene**\nClothing: standard\nScene content..." (block)
   */
  _extractStoryModeCoverScenes(coverScenes) {
    const titleWords = KEYWORDS.titlePage.join('|');
    const backWords = KEYWORDS.backCover.join('|');
    const initialWords = KEYWORDS.initialPage.join('|');

    // Helper to extract scene from a cover block
    const extractFromBlock = (blockText) => {
      const lines = blockText.split('\n');
      const sceneLines = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Skip clothing line
        const clothingPattern = keywordPattern(KEYWORDS.clothing);
        if (clothingPattern.test(trimmed)) {
          // Extract clothing value
          const clothingMatch = trimmed.match(CLOTHING_CATEGORY_PATTERN);
          if (clothingMatch) {
            // Return clothing separately - caller can use it
          }
          continue;
        }

        // Skip if it's another section header
        if (trimmed.match(/^\*\*(?:Title|Initial|Back|Titel|Einführung|Rückseite)/i)) {
          break;
        }

        sceneLines.push(trimmed);
      }

      return sceneLines.join(' ').trim();
    };

    // Pattern for block format: **Title Page Scene**\n followed by content until next section
    // Matches: "**Title Page Scene**" with optional "Scene" word
    const blockPatternTemplate = (words) => new RegExp(
      `\\*\\*(?:${words})\\s*(?:Scene|Szene|Scène)?\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*(?:Title|Initial|Back|Titel|Einführung|Rückseite)|\\n##|$)`,
      'i'
    );

    // Title Page Scene
    if (!coverScenes.titlePage.scene) {
      // Try block format first
      const blockMatch = this.outline.match(blockPatternTemplate(titleWords));
      if (blockMatch) {
        const block = blockMatch[1];
        coverScenes.titlePage.scene = extractFromBlock(block);
        coverScenes.titlePage.clothing = this._extractClothingFromBlock(block);
        log.debug(`[OUTLINE-PARSER] Title Page (block format): ${coverScenes.titlePage.scene.substring(0, 60)}...`);
      } else {
        // Try inline format: **Title Page Scene**: description\nClothing: category
        // Stop at next section header (Title Page|Initial Page|Back Cover) or markdown header, NOT at "Clothing:"
        const sectionStopPattern = `(?:Title Page|Initial Page|Back Cover|Titelseite|Einführungsseite|Rückseite|Page de titre|Page initiale|Quatrième)`;
        // Handle both formats: "**Title Page Scene**:" and "Title Page Scene:"
        const inlineMatch = this.outline.match(
          new RegExp(`\\*{0,2}(?:${titleWords})\\s*(?:Scene|Szene|Scène)?\\*{0,2}[:\\s]+([^\\n]+(?:\\n(?!\\*\\*${sectionStopPattern}|##)[^\\n]+)*)`, 'i')
        );
        if (inlineMatch) {
          const fullBlock = inlineMatch[0];
          // Extract just the scene description (first line), not the clothing
          const sceneText = inlineMatch[1].split('\n')[0];
          coverScenes.titlePage.scene = this.cleanMarkdown(sceneText);
          // Extract clothing from the full block (includes Clothing: line)
          coverScenes.titlePage.clothing = this._extractClothingFromBlock(fullBlock);
          log.debug(`[OUTLINE-PARSER] Title Page (inline format): ${coverScenes.titlePage.scene.substring(0, 60)}..., clothing: ${coverScenes.titlePage.clothing || 'none'}`);
        }
      }
    }

    // Initial Page Scene
    if (!coverScenes.initialPage.scene) {
      const blockMatch = this.outline.match(blockPatternTemplate(initialWords));
      if (blockMatch) {
        const block = blockMatch[1];
        coverScenes.initialPage.scene = extractFromBlock(block);
        coverScenes.initialPage.clothing = this._extractClothingFromBlock(block);
        log.debug(`[OUTLINE-PARSER] Initial Page (block format): ${coverScenes.initialPage.scene.substring(0, 60)}...`);
      } else {
        // Try inline format: **Initial Page Scene**: description\nClothing: category
        // Stop at next section header, NOT at "Clothing:"
        const sectionStopPattern = `(?:Title Page|Initial Page|Back Cover|Titelseite|Einführungsseite|Rückseite|Page de titre|Page initiale|Quatrième)`;
        // Handle both formats: "**Initial Page Scene**:" and "Initial Page Scene:"
        const inlineMatch = this.outline.match(
          new RegExp(`\\*{0,2}(?:${initialWords})\\s*(?:Scene|Szene|Scène)?\\*{0,2}[:\\s]+([^\\n]+(?:\\n(?!\\*\\*${sectionStopPattern}|##)[^\\n]+)*)`, 'i')
        );
        if (inlineMatch) {
          const fullBlock = inlineMatch[0];
          const sceneText = inlineMatch[1].split('\n')[0];
          coverScenes.initialPage.scene = this.cleanMarkdown(sceneText);
          coverScenes.initialPage.clothing = this._extractClothingFromBlock(fullBlock);
          log.debug(`[OUTLINE-PARSER] Initial Page (inline format): ${coverScenes.initialPage.scene.substring(0, 60)}..., clothing: ${coverScenes.initialPage.clothing || 'none'}`);
        }
      }
    }

    // Back Cover Scene
    if (!coverScenes.backCover.scene) {
      const blockMatch = this.outline.match(blockPatternTemplate(backWords));
      if (blockMatch) {
        const block = blockMatch[1];
        coverScenes.backCover.scene = extractFromBlock(block);
        coverScenes.backCover.clothing = this._extractClothingFromBlock(block);
        log.debug(`[OUTLINE-PARSER] Back Cover (block format): ${coverScenes.backCover.scene.substring(0, 60)}...`);
      } else {
        // Try inline format: **Back Cover Scene**: description\nClothing: category
        // Stop at next section header, NOT at "Clothing:"
        const sectionStopPattern = `(?:Title Page|Initial Page|Back Cover|Titelseite|Einführungsseite|Rückseite|Page de titre|Page initiale|Quatrième)`;
        // Handle both formats: "**Back Cover Scene**:" and "Back Cover Scene:"
        const inlineMatch = this.outline.match(
          new RegExp(`\\*{0,2}(?:${backWords})\\s*(?:Scene|Szene|Scène)?\\*{0,2}[:\\s]+([^\\n]+(?:\\n(?!\\*\\*${sectionStopPattern}|##)[^\\n]+)*)`, 'i')
        );
        if (inlineMatch) {
          const fullBlock = inlineMatch[0];
          const sceneText = inlineMatch[1].split('\n')[0];
          coverScenes.backCover.scene = this.cleanMarkdown(sceneText);
          coverScenes.backCover.clothing = this._extractClothingFromBlock(fullBlock);
          log.debug(`[OUTLINE-PARSER] Back Cover (inline format): ${coverScenes.backCover.scene.substring(0, 60)}..., clothing: ${coverScenes.backCover.clothing || 'none'}`);
        }
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

  // --------------------------------------------------------------------------
  // CLOTHING REQUIREMENTS EXTRACTION
  // --------------------------------------------------------------------------

  /**
   * Extract clothing requirements JSON for avatar generation
   * @returns {Object|null} - Parsed clothingRequirements or null if not found
   */
  extractClothingRequirements() {
    if (this._cache.clothingRequirements !== undefined) return this._cache.clothingRequirements;

    // Look for clothingRequirements JSON block
    // Pattern: ```json { "clothingRequirements": { ... } } ``` or inline JSON
    const jsonBlockMatch = this.outline.match(
      /```json\s*(\{[\s\S]*?"clothingRequirements"[\s\S]*?\})\s*```/i
    );

    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]);
        if (parsed.clothingRequirements) {
          this._cache.clothingRequirements = parsed.clothingRequirements;
          log.debug(`[OUTLINE-PARSER] Extracted clothingRequirements for ${Object.keys(parsed.clothingRequirements).length} characters`);
          return this._cache.clothingRequirements;
        }
      } catch (e) {
        log.warn(`[OUTLINE-PARSER] Failed to parse clothingRequirements JSON: ${e.message}`);
      }
    }

    // Fallback: look for ## Clothing Requirements section with inline JSON
    const sectionMatch = this.outline.match(
      /##\s*Clothing\s*Requirements[\s\S]*?```json\s*(\{[\s\S]*?\})\s*```/i
    );

    if (sectionMatch) {
      try {
        const parsed = JSON.parse(sectionMatch[1]);
        if (parsed.clothingRequirements) {
          this._cache.clothingRequirements = parsed.clothingRequirements;
          log.debug(`[OUTLINE-PARSER] Extracted clothingRequirements (section format) for ${Object.keys(parsed.clothingRequirements).length} characters`);
          return this._cache.clothingRequirements;
        }
      } catch (e) {
        log.warn(`[OUTLINE-PARSER] Failed to parse clothingRequirements JSON from section: ${e.message}`);
      }
    }

    this._cache.clothingRequirements = null;
    log.debug('[OUTLINE-PARSER] No clothingRequirements found');
    return null;
  }

  /**
   * Get which clothing variations are needed for a specific character
   * @param {string} characterName - Character name to look up
   * @returns {Object|null} - { standard: {...}, winter: {...}, summer: {...}, costumed: {...} } or null
   */
  getCharacterClothingRequirements(characterName) {
    const requirements = this.extractClothingRequirements();
    if (!requirements) return null;

    // Case-insensitive lookup
    const nameLower = characterName.toLowerCase();
    for (const [name, data] of Object.entries(requirements)) {
      if (name.toLowerCase() === nameLower) {
        return data;
      }
    }
    return null;
  }

  /**
   * Get list of clothing variations needed for avatar generation
   * @returns {Array<{characterName: string, variation: string, signature?: string, costume?: string, description?: string}>}
   */
  getRequiredAvatarVariations() {
    const requirements = this.extractClothingRequirements();
    if (!requirements) return [];

    const variations = [];
    for (const [characterName, data] of Object.entries(requirements)) {
      for (const [variation, config] of Object.entries(data)) {
        if (config && config.used === true) {
          variations.push({
            characterName,
            variation,
            signature: config.signature || null,
            costume: config.costume || null,
            description: config.description || null
          });
        }
      }
    }

    log.debug(`[OUTLINE-PARSER] Required avatar variations: ${variations.length} total`);
    return variations;
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
  // Note: Handle colon inside bold (**Characters:**) or outside (**Characters**:)
  const sectionPattern = new RegExp(
    `(?:^|\\n)\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:${charactersKeywords})(?::\\*{0,2}|\\*{0,2}:?)\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:Objects|Animals|Objekte|Tiere|Objets|Animaux|Setting|Composition|Constraints|Safety)\\*{0,2}|$)`,
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
// UNIFIED STORY PARSER - For parsing unified prompt output (single prompt mode)
// ============================================================================

/**
 * Parser for unified story generation output
 * Extracts all sections from a single combined prompt response
 */
class UnifiedStoryParser {
  /**
   * @param {string} response - The full unified story response
   */
  constructor(response) {
    this.response = response || '';
    this._cache = {};
  }

  /**
   * Extract story title
   * @returns {string|null}
   */
  extractTitle() {
    if (this._cache.title !== undefined) return this._cache.title;

    const match = this.response.match(/---TITLE---\s*(?:TITLE:\s*)?(.+?)(?:\n|$)/i);
    if (match) {
      this._cache.title = match[1].trim();
      log.debug(`[UNIFIED-PARSER] Title: "${this._cache.title}"`);
      return this._cache.title;
    }

    this._cache.title = null;
    return null;
  }

  /**
   * Extract clothing requirements JSON
   * @returns {Object|null}
   */
  extractClothingRequirements() {
    if (this._cache.clothingRequirements !== undefined) return this._cache.clothingRequirements;

    const sectionMatch = this.response.match(/---CLOTHING REQUIREMENTS---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
    if (!sectionMatch) {
      this._cache.clothingRequirements = null;
      return null;
    }

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i) ||
                      section.match(/(\{[\s\S]*?"clothingRequirements"[\s\S]*?\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        this._cache.clothingRequirements = parsed.clothingRequirements || parsed;
        log.debug(`[UNIFIED-PARSER] Clothing requirements for ${Object.keys(this._cache.clothingRequirements).length} characters`);
        return this._cache.clothingRequirements;
      } catch (e) {
        log.error(`[UNIFIED-PARSER] Failed to parse clothing requirements: ${e.message}`);
      }
    }

    this._cache.clothingRequirements = null;
    return null;
  }

  /**
   * Extract character arcs section
   * @returns {Object|null} - Map of character name to arc details
   */
  extractCharacterArcs() {
    if (this._cache.characterArcs !== undefined) return this._cache.characterArcs;

    const sectionMatch = this.response.match(/---CHARACTER ARCS---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
    if (!sectionMatch) {
      this._cache.characterArcs = null;
      return null;
    }

    const section = sectionMatch[1];
    const arcs = {};

    // Match character arc blocks: ### CharacterName followed by fields
    const charPattern = /###\s*(.+?)\s*\n([\s\S]*?)(?=###\s|$)/g;
    let match;
    while ((match = charPattern.exec(section)) !== null) {
      const name = match[1].trim();
      const content = match[2];

      arcs[name] = {
        startingPoint: this._extractField(content, 'Starting Point'),
        keyChallenges: this._extractField(content, 'Key Challenges'),
        turningPoints: this._extractField(content, 'Turning Points'),
        endState: this._extractField(content, 'End State'),
        keyMoments: this._extractField(content, 'Key Moments')
      };
    }

    this._cache.characterArcs = Object.keys(arcs).length > 0 ? arcs : null;
    log.debug(`[UNIFIED-PARSER] Character arcs for ${Object.keys(arcs).length} characters`);
    return this._cache.characterArcs;
  }

  /**
   * Extract plot structure section
   * @returns {Object|null}
   */
  extractPlotStructure() {
    if (this._cache.plotStructure !== undefined) return this._cache.plotStructure;

    const sectionMatch = this.response.match(/---PLOT STRUCTURE---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
    if (!sectionMatch) {
      this._cache.plotStructure = null;
      return null;
    }

    const section = sectionMatch[1];
    const structure = {
      primaryClothing: this._extractField(section, 'Primary Clothing') || 'standard',
      clothingChanges: this._extractField(section, 'Clothing Changes'),
      incitingIncident: this._extractField(section, 'Inciting Incident'),
      risingAction: this._extractField(section, 'Rising Action'),
      climax: this._extractField(section, 'Climax'),
      fallingAction: this._extractField(section, 'Falling Action'),
      resolution: this._extractField(section, 'Resolution'),
      themes: this._extractField(section, 'Themes'),
      tone: this._extractField(section, 'Tone')
    };

    this._cache.plotStructure = structure;
    log.debug(`[UNIFIED-PARSER] Plot structure extracted (primary clothing: ${structure.primaryClothing})`);
    return this._cache.plotStructure;
  }

  /**
   * Extract Visual Bible JSON
   * @returns {Object|null}
   */
  extractVisualBible() {
    if (this._cache.visualBible !== undefined) return this._cache.visualBible;

    const sectionMatch = this.response.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i);
    if (!sectionMatch) {
      this._cache.visualBible = null;
      return null;
    }

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i) ||
                      section.match(/(\{[\s\S]*?"(?:secondaryCharacters|animals|artifacts|locations)"[\s\S]*?\})/);

    if (jsonMatch) {
      try {
        this._cache.visualBible = JSON.parse(jsonMatch[1]);

        // Add computed 'description' field for secondary characters (combining individual fields)
        if (this._cache.visualBible.secondaryCharacters) {
          this._cache.visualBible.secondaryCharacters = this._cache.visualBible.secondaryCharacters.map(char => {
            if (!char.description) {
              const parts = [];
              if (char.age) parts.push(char.age);
              if (char.build) parts.push(char.build);
              if (char.hair) parts.push(`hair: ${char.hair}`);
              if (char.face) parts.push(char.face);
              if (char.signatureLook) parts.push(`Signature: ${char.signatureLook}`);
              if (char.clothing) parts.push(`Clothing: ${char.clothing}`);
              char.description = parts.join('. ') || char.name;
            }
            return char;
          });
        }

        // Add computed 'description' field for animals (combining individual fields)
        if (this._cache.visualBible.animals) {
          this._cache.visualBible.animals = this._cache.visualBible.animals.map(animal => {
            if (!animal.description) {
              const parts = [];
              if (animal.species) parts.push(animal.species);
              if (animal.size) parts.push(animal.size);
              if (animal.coloring) parts.push(animal.coloring);
              if (animal.features) parts.push(animal.features);
              animal.description = parts.join('. ') || animal.name;
            }
            return animal;
          });
        }

        // Add computed 'description' field for locations (combining individual fields)
        if (this._cache.visualBible.locations) {
          this._cache.visualBible.locations = this._cache.visualBible.locations.map(loc => {
            if (!loc.description) {
              const parts = [];
              if (loc.setting) parts.push(loc.setting);
              if (loc.colors) parts.push(`Colors: ${loc.colors}`);
              if (loc.features) parts.push(loc.features);
              if (loc.signatureElement) parts.push(`Signature: ${loc.signatureElement}`);
              loc.description = parts.join('. ') || loc.name;
            }
            return loc;
          });
        }

        const counts = {
          secondary: this._cache.visualBible.secondaryCharacters?.length || 0,
          animals: this._cache.visualBible.animals?.length || 0,
          artifacts: this._cache.visualBible.artifacts?.length || 0,
          locations: this._cache.visualBible.locations?.length || 0
        };
        log.debug(`[UNIFIED-PARSER] Visual Bible: ${counts.secondary} secondary chars, ${counts.animals} animals, ${counts.artifacts} artifacts, ${counts.locations} locations`);
        return this._cache.visualBible;
      } catch (e) {
        log.error(`[UNIFIED-PARSER] Failed to parse Visual Bible: ${e.message}`);
      }
    }

    this._cache.visualBible = null;
    return null;
  }

  /**
   * Extract cover scene hints with per-character clothing
   * @returns {{titlePage: {hint: string, characterClothing: Object, characters: string[]}, ...}}
   */
  extractCoverHints() {
    if (this._cache.coverHints !== undefined) return this._cache.coverHints;

    const sectionMatch = this.response.match(/---COVER SCENE HINTS---\s*([\s\S]*?)(?=---STORY PAGES---|$)/i);
    const defaults = {
      titlePage: { hint: '', characterClothing: {}, characters: [] },
      initialPage: { hint: '', characterClothing: {}, characters: [] },
      backCover: { hint: '', characterClothing: {}, characters: [] }
    };

    if (!sectionMatch) {
      this._cache.coverHints = defaults;
      return defaults;
    }

    const section = sectionMatch[1];

    // Extract each cover hint with per-character clothing
    const extractCover = (label) => {
      // Match the cover block from **Label** to the next **Label** or end
      const blockPattern = new RegExp(`\\*\\*${label}\\*\\*\\s*([\\s\\S]*?)(?=\\n\\*\\*(?:Title Page|Initial Page|Back Cover)\\*\\*|$)`, 'i');
      const blockMatch = section.match(blockPattern);

      if (!blockMatch) {
        return { hint: '', characterClothing: {}, characters: [] };
      }

      const block = blockMatch[1];

      // Extract hint (first line after Hint: or just the first content line)
      const hintMatch = block.match(/(?:Hint:\s*)?([^\n]+)/i);
      const hint = hintMatch ? hintMatch[1].trim() : '';

      // Extract per-character clothing
      const { characterClothing, characters } = parseCharacterClothingBlock(block);

      return { hint, characterClothing, characters };
    };

    this._cache.coverHints = {
      titlePage: extractCover('Title Page'),
      initialPage: extractCover('Initial Page'),
      backCover: extractCover('Back Cover')
    };

    log.debug(`[UNIFIED-PARSER] Cover hints extracted: title=${this._cache.coverHints.titlePage.hint.length > 0}, initial=${this._cache.coverHints.initialPage.hint.length > 0}, back=${this._cache.coverHints.backCover.hint.length > 0}`);
    return this._cache.coverHints;
  }

  /**
   * Extract all story pages with text, scene hint, clothing, and characters
   * @returns {Array<{pageNumber: number, text: string, sceneHint: string, characterClothing: Object, characters: string[]}>}
   */
  extractPages() {
    if (this._cache.pages !== undefined) return this._cache.pages;

    const pages = [];

    // Match page blocks: --- Page X --- followed by TEXT: and SCENE HINT:
    const pagePattern = /---\s*Page\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*Page\s+\d+\s*---|$)/gi;

    let match;
    while ((match = pagePattern.exec(this.response)) !== null) {
      const pageNumber = parseInt(match[1], 10);
      const content = match[2];

      // Extract TEXT section
      const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE HINT:|$)/i);
      const text = textMatch ? textMatch[1].trim() : '';

      // Extract SCENE HINT section (stops at Characters: which is now multi-line)
      const hintMatch = content.match(/SCENE HINT:\s*([\s\S]*?)(?=Characters:|---\s*Page|$)/i);
      const sceneHint = hintMatch ? hintMatch[1].trim() : '';

      // Extract per-character clothing from new format:
      // Characters:
      // - Name1: standard
      // - Name2: costumed:superhero
      const { characterClothing, characters } = parseCharacterClothingBlock(content);

      pages.push({
        pageNumber,
        text,
        sceneHint,
        characterClothing,
        characters
      });
    }

    // Sort by page number
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    this._cache.pages = pages;
    log.debug(`[UNIFIED-PARSER] Extracted ${pages.length} pages`);
    return pages;
  }

  /**
   * Helper: Extract a field value from text
   * @param {string} text - Text to search
   * @param {string} fieldName - Field name to find
   * @returns {string|null}
   */
  _extractField(text, fieldName) {
    const pattern = new RegExp(`\\*\\*${fieldName}\\*\\*:\\s*(.+?)(?=\\n\\*\\*|$)`, 'is');
    const match = text.match(pattern);
    if (match) return match[1].trim();

    // Try without bold
    const plainPattern = new RegExp(`${fieldName}:\\s*(.+?)(?=\\n[A-Z]|$)`, 'is');
    const plainMatch = text.match(plainPattern);
    return plainMatch ? plainMatch[1].trim() : null;
  }

  /**
   * Get a summary of what was parsed
   * @returns {Object}
   */
  getSummary() {
    return {
      hasTitle: !!this.extractTitle(),
      hasClothingRequirements: !!this.extractClothingRequirements(),
      hasCharacterArcs: !!this.extractCharacterArcs(),
      hasPlotStructure: !!this.extractPlotStructure(),
      hasVisualBible: !!this.extractVisualBible(),
      hasCoverHints: !!this.extractCoverHints().titlePage.hint,
      pageCount: this.extractPages().length
    };
  }
}

// ============================================================================
// PROGRESSIVE UNIFIED PARSER (for streaming)
// ============================================================================

/**
 * Progressive parser for unified story responses during streaming.
 * Detects completed sections and pages as they arrive and triggers callbacks.
 */
class ProgressiveUnifiedParser {
  /**
   * @param {Object} callbacks - Callbacks for each section type
   * @param {Function} callbacks.onTitle - Called when title is detected
   * @param {Function} callbacks.onClothingRequirements - Called when clothing JSON is complete
   * @param {Function} callbacks.onCharacterArcs - Called when character arcs section is complete
   * @param {Function} callbacks.onPlotStructure - Called when plot structure section is complete
   * @param {Function} callbacks.onVisualBible - Called when visual bible JSON is complete
   * @param {Function} callbacks.onCoverHints - Called when cover hints section is complete
   * @param {Function} callbacks.onPageComplete - Called when a story page is complete
   * @param {Function} callbacks.onProgress - Called with progress updates for UI
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.fullText = '';

    // Track which sections have been emitted
    this.emitted = {
      title: false,
      clothingRequirements: false,
      characterArcs: false,
      plotStructure: false,
      visualBible: false,
      coverHints: false,
      pages: new Set()
    };

    // Section markers in order
    this.sectionMarkers = [
      '---TITLE---',
      '---CLOTHING REQUIREMENTS---',
      '---CHARACTER ARCS---',
      '---PLOT STRUCTURE---',
      '---VISUAL BIBLE---',
      '---COVER SCENE HINTS---',
      '---STORY PAGES---'
    ];
  }

  /**
   * Process a new chunk of streamed text
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Check for newly completed sections
    this._checkTitle();
    this._checkClothingRequirements();
    this._checkCharacterArcs();
    this._checkPlotStructure();
    this._checkVisualBible();
    this._checkCoverHints();
    this._checkPages();
  }

  /**
   * Check if title section is complete
   */
  _checkTitle() {
    if (this.emitted.title) return;

    // Title is complete when we see the next section marker
    if (!this.fullText.includes('---TITLE---')) return;
    if (!this.fullText.includes('---CLOTHING REQUIREMENTS---')) return;

    const match = this.fullText.match(/---TITLE---\s*(?:TITLE:\s*)?(.+?)(?:\n|---CLOTHING)/i);
    if (match) {
      const title = match[1].trim();
      this.emitted.title = true;
      log.debug(`🌊 [STREAM-UNIFIED] Title detected: "${title}"`);

      if (this.callbacks.onTitle) {
        this.callbacks.onTitle(title);
      }
      if (this.callbacks.onProgress) {
        this.callbacks.onProgress('title', `Story title: "${title}"`);
      }
    }
  }

  /**
   * Check if clothing requirements JSON is complete
   */
  _checkClothingRequirements() {
    if (this.emitted.clothingRequirements) return;

    // Complete when we see CHARACTER ARCS marker
    if (!this.fullText.includes('---CLOTHING REQUIREMENTS---')) return;
    if (!this.fullText.includes('---CHARACTER ARCS---')) return;

    const sectionMatch = this.fullText.match(/---CLOTHING REQUIREMENTS---\s*([\s\S]*?)(?=---CHARACTER ARCS---)/i);
    if (!sectionMatch) return;

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i) ||
                      section.match(/(\{[\s\S]*?"clothingRequirements"[\s\S]*?\})/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        const requirements = parsed.clothingRequirements || parsed;
        this.emitted.clothingRequirements = true;
        log.debug(`🌊 [STREAM-UNIFIED] Clothing requirements detected for ${Object.keys(requirements).length} characters`);

        if (this.callbacks.onClothingRequirements) {
          this.callbacks.onClothingRequirements(requirements);
        }
        if (this.callbacks.onProgress) {
          this.callbacks.onProgress('clothing', `Clothing for ${Object.keys(requirements).length} characters`);
        }
      } catch (e) {
        // JSON not valid yet, wait for more data
      }
    }
  }

  /**
   * Check if character arcs section is complete
   */
  _checkCharacterArcs() {
    if (this.emitted.characterArcs) return;

    if (!this.fullText.includes('---CHARACTER ARCS---')) return;
    if (!this.fullText.includes('---PLOT STRUCTURE---')) return;

    this.emitted.characterArcs = true;
    log.debug(`🌊 [STREAM-UNIFIED] Character arcs section complete`);

    if (this.callbacks.onCharacterArcs) {
      this.callbacks.onCharacterArcs();
    }
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress('arcs', 'Character development planned');
    }
  }

  /**
   * Check if plot structure section is complete
   */
  _checkPlotStructure() {
    if (this.emitted.plotStructure) return;

    if (!this.fullText.includes('---PLOT STRUCTURE---')) return;
    if (!this.fullText.includes('---VISUAL BIBLE---')) return;

    this.emitted.plotStructure = true;
    log.debug(`🌊 [STREAM-UNIFIED] Plot structure section complete`);

    if (this.callbacks.onPlotStructure) {
      this.callbacks.onPlotStructure();
    }
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress('plot', 'Story structure defined');
    }
  }

  /**
   * Check if visual bible JSON is complete
   */
  _checkVisualBible() {
    if (this.emitted.visualBible) return;

    if (!this.fullText.includes('---VISUAL BIBLE---')) return;
    if (!this.fullText.includes('---COVER SCENE HINTS---')) return;

    const sectionMatch = this.fullText.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---COVER SCENE HINTS---)/i);
    if (!sectionMatch) return;

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        this.emitted.visualBible = true;

        // Add computed 'description' field for all entry types (same logic as extractVisualBible)
        if (parsed.secondaryCharacters) {
          parsed.secondaryCharacters = parsed.secondaryCharacters.map(char => {
            if (!char.description) {
              const parts = [];
              if (char.age) parts.push(char.age);
              if (char.build) parts.push(char.build);
              if (char.hair) parts.push(`hair: ${char.hair}`);
              if (char.face) parts.push(char.face);
              if (char.signatureLook) parts.push(`Signature: ${char.signatureLook}`);
              if (char.clothing) parts.push(`Clothing: ${char.clothing}`);
              char.description = parts.join('. ') || char.name;
            }
            return char;
          });
        }

        if (parsed.animals) {
          parsed.animals = parsed.animals.map(animal => {
            if (!animal.description) {
              const parts = [];
              if (animal.species) parts.push(animal.species);
              if (animal.size) parts.push(animal.size);
              if (animal.coloring) parts.push(animal.coloring);
              if (animal.features) parts.push(animal.features);
              animal.description = parts.join('. ') || animal.name;
            }
            return animal;
          });
        }

        if (parsed.artifacts) {
          parsed.artifacts = parsed.artifacts.map(item => {
            if (!item.description) {
              const parts = [];
              if (item.type) parts.push(item.type);
              if (item.appearance) parts.push(item.appearance);
              if (item.size) parts.push(item.size);
              item.description = parts.join('. ') || item.name;
            }
            return item;
          });
        }

        if (parsed.locations) {
          parsed.locations = parsed.locations.map(loc => {
            if (!loc.description) {
              const parts = [];
              if (loc.type) parts.push(loc.type);
              if (loc.atmosphere) parts.push(loc.atmosphere);
              if (loc.keyFeatures) parts.push(loc.keyFeatures);
              loc.description = parts.join('. ') || loc.name;
            }
            return loc;
          });
        }

        if (parsed.vehicles) {
          parsed.vehicles = parsed.vehicles.map(v => {
            if (!v.description) {
              const parts = [];
              if (v.type) parts.push(v.type);
              if (v.appearance) parts.push(v.appearance);
              if (v.size) parts.push(v.size);
              v.description = parts.join('. ') || v.name;
            }
            return v;
          });
        }

        const entryCount = (parsed.secondaryCharacters?.length || 0) +
                          (parsed.animals?.length || 0) +
                          (parsed.artifacts?.length || 0) +
                          (parsed.locations?.length || 0);

        log.debug(`🌊 [STREAM-UNIFIED] Visual Bible detected with ${entryCount} entries`);

        if (this.callbacks.onVisualBible) {
          this.callbacks.onVisualBible(parsed);
        }
        if (this.callbacks.onProgress) {
          this.callbacks.onProgress('visualBible', `Visual Bible: ${entryCount} elements`);
        }
      } catch (e) {
        // JSON not valid yet
      }
    }
  }

  /**
   * Check if cover hints section is complete
   */
  _checkCoverHints() {
    if (this.emitted.coverHints) return;

    if (!this.fullText.includes('---COVER SCENE HINTS---')) return;
    if (!this.fullText.includes('---STORY PAGES---')) return;

    this.emitted.coverHints = true;
    log.debug(`🌊 [STREAM-UNIFIED] Cover hints section complete`);

    if (this.callbacks.onCoverHints) {
      this.callbacks.onCoverHints();
    }
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress('covers', 'Cover scenes defined');
    }
  }

  /**
   * Check for newly completed story pages
   */
  _checkPages() {
    if (!this.fullText.includes('---STORY PAGES---')) return;

    // Find all page blocks
    const pagePattern = /---\s*Page\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*Page\s+\d+\s*---|$)/gi;

    let match;
    while ((match = pagePattern.exec(this.fullText)) !== null) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      // Skip if already emitted
      if (this.emitted.pages.has(pageNum)) continue;

      // A page is complete when we have TEXT and SCENE HINT
      const hasText = /TEXT:\s*\S/.test(content);
      const hasHint = /SCENE HINT:\s*\S/.test(content);

      // Check if there's a next page (means this one is complete) or end of content
      const nextPageIndex = this.fullText.indexOf(`--- Page ${pageNum + 1} ---`);
      const isLastKnownPage = nextPageIndex === -1;

      // Only emit if we're confident the page is complete
      // Either there's a next page, or we have both TEXT and SCENE HINT
      if (nextPageIndex > match.index || (isLastKnownPage && hasText && hasHint && content.includes('Characters:'))) {
        // Extract page data
        const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE HINT:|$)/i);
        const text = textMatch ? textMatch[1].trim() : '';

        const hintMatch = content.match(/SCENE HINT:\s*([\s\S]*?)(?=Characters:|---\s*Page|$)/i);
        const sceneHint = hintMatch ? hintMatch[1].trim() : '';

        // Extract per-character clothing using shared helper
        const { characterClothing, characters } = parseCharacterClothingBlock(content);

        this.emitted.pages.add(pageNum);
        const clothingStr = Object.keys(characterClothing).length > 0
          ? Object.entries(characterClothing).map(([n, c]) => `${n}:${c}`).join(', ')
          : 'none';
        log.debug(`🌊 [STREAM-UNIFIED] Page ${pageNum} complete (clothing: ${clothingStr})`);

        if (this.callbacks.onPageComplete) {
          this.callbacks.onPageComplete({
            pageNumber: pageNum,
            text,
            sceneHint,
            characterClothing,
            characters
          });
        }
        if (this.callbacks.onProgress) {
          this.callbacks.onProgress('page', `Writing page ${pageNum}...`, pageNum);
        }
      }
    }
  }

  /**
   * Finalize parsing - emit any remaining pages
   */
  finalize() {
    // Re-check pages one more time to catch the last page
    this._checkPages();

    log.debug(`🌊 [STREAM-UNIFIED] Finalized: ${this.emitted.pages.size} pages emitted`);
    return {
      title: this.emitted.title,
      clothingRequirements: this.emitted.clothingRequirements,
      characterArcs: this.emitted.characterArcs,
      plotStructure: this.emitted.plotStructure,
      visualBible: this.emitted.visualBible,
      coverHints: this.emitted.coverHints,
      pageCount: this.emitted.pages.size
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  OutlineParser,
  UnifiedStoryParser,
  ProgressiveUnifiedParser,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  extractCharacterNamesFromScene
};
