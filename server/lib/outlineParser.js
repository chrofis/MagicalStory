/**
 * Unified Outline Parser
 *
 * Centralizes all extraction logic for story outlines with consistent
 * multilingual support (English, German, French).
 */

const { log } = require('../utils/logger');

// Lazy-load to avoid circular dependency (storyHelpers imports outlineParser)
let _extractJsonFromText = null;
function getExtractJsonFromText() {
  if (!_extractJsonFromText) {
    _extractJsonFromText = require('./storyHelpers').extractJsonFromText;
  }
  return _extractJsonFromText;
}

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
 * Format: Characters:\n- Name1: category\n- Name2: category, depth: background, perspective: back view
 * Also supports legacy format: Characters: Name1, Name2 with separate Clothing: line
 * @param {string} content - Block content to parse
 * @returns {{characterClothing: Object, characterPerspectives: Object, characters: string[]}}
 *   characterPerspectives: { Name: { depth?: string, perspective?: string } } — only includes
 *   entries for characters that had explicit annotations after their clothing token.
 */
function parseCharacterClothingBlock(content) {
  const characterClothing = {};
  const characterPerspectives = {};
  const characters = [];

  // JSON scene hint format (current story-unified.txt page hints):
  //   "characters": [
  //     { "name": "Lukas", "position": "left", "clothing": "costumed:roman" },
  //     { "name": "Sophie", "clothing": "costumed:roman", "depth": "background", "perspective": "back view" }
  //   ]
  const jsonCharsMatch = content.match(/"characters"\s*:\s*\[([\s\S]*?)\]/);
  if (jsonCharsMatch) {
    const charsBlock = jsonCharsMatch[1];
    // Match each { ... } object — supports nested braces (e.g., costumed:{type})
    const charObjectPattern = /\{([^{}]*(?:\{[^}]*\}[^{}]*)*)\}/g;
    let objMatch;
    while ((objMatch = charObjectPattern.exec(charsBlock)) !== null) {
      const obj = objMatch[1];
      const nameMatch = obj.match(/"name"\s*:\s*"([^"]+)"/);
      const clothingMatch = obj.match(/"clothing"\s*:\s*"([^"]+)"/);
      if (!nameMatch || !clothingMatch) continue;
      const name = nameMatch[1].trim();
      const baseName = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      characters.push(name);
      characterClothing[baseName] = clothingMatch[1].trim().toLowerCase();
      const annotations = {};
      const depthMatch = obj.match(/"depth"\s*:\s*"([^"]+)"/);
      if (depthMatch) annotations.depth = depthMatch[1].trim();
      const perspMatch = obj.match(/"perspective"\s*:\s*"([^"]+)"/);
      if (perspMatch) annotations.perspective = perspMatch[1].trim();
      const posMatch = obj.match(/"position"\s*:\s*"([^"]+)"/);
      if (posMatch) annotations.position = posMatch[1].trim();
      const holdsMatch = obj.match(/"holds"\s*:\s*"([^"]+)"/);
      if (holdsMatch) annotations.holds = holdsMatch[1].trim();
      if (Object.keys(annotations).length > 0) {
        characterPerspectives[baseName] = annotations;
      }
    }
    if (characters.length > 0) return { characterClothing, characterPerspectives, characters };
  }

  // Bullet list format (used by cover scene hints in story-unified.txt):
  //   Characters:
  //   - Name1 (position): standard, holds: book
  //   - Name2 (alias): costumed:type, depth: background, perspective: back view
  const charactersBlockMatch = content.match(/Characters(?:\s*\([^)]*\))?:\s*([\s\S]*?)(?=---\s*(?:Page|Seite|Página|Pagina)|$)/i);
  if (charactersBlockMatch) {
    const block = charactersBlockMatch[1];
    // Match "Name: category" entries - supports both multi-line (with bullets) and single-line comma-separated
    // Name pattern: plain name chars followed by optional parenthesized metadata (which may contain colons).
    // IMPORTANT: Uses possessive-safe pattern to avoid catastrophic backtracking (O(2^n) with nested quantifiers).
    // Clothing pattern handles costumed:{...} (braces with commas inside) and costumed:type (plain).
    // We capture an optional trailing annotations group (depth/perspective/position) up to end-of-line.
    const linePattern = /(?:^|,\s*)[-*]?\s*([^(:\r\n]+(?:\([^)]*\))?[^:\r\n]*):\s*(standard|winter|summer|formal|costumed:(?:\{[^}]*\}|[^\r\n,]+))((?:\s*,\s*(?:depth|perspective|position|holds|holding)\s*:\s*[^,\r\n]+)*)/gim;
    // Annotation keys Claude may slip into the line (e.g. "depth: foreground", "perspective: side", "holds: book").
    // We never want these mistaken for character names — they should be silently dropped.
    const ANNOTATION_KEYS = new Set(['depth', 'perspective', 'position', 'pose', 'view', 'shot', 'action', 'holds', 'holding']);
    let lineMatch;
    while ((lineMatch = linePattern.exec(block)) !== null) {
      const rawName = lineMatch[1].trim();
      let clothing = lineMatch[2].trim().toLowerCase().replace(/\r$/, ''); // Strip trailing \r if present
      const annotationsRaw = (lineMatch[3] || '').trim();
      // Strip curly brace wrapper from costumed descriptions: costumed:{desc} -> costumed:desc
      clothing = clothing.replace(/^(costumed:)\{([^}]*)\}$/, '$1$2');
      // Extract base name (remove alias in parentheses for lookup, keep for display)
      const baseName = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim();
      // Skip annotation keys that snuck through as if they were names
      if (ANNOTATION_KEYS.has(baseName.toLowerCase())) {
        log.debug(`[PARSE-CLOTHING] Skipping annotation key "${baseName}" (not a character)`);
        continue;
      }
      characters.push(rawName);
      characterClothing[baseName] = clothing;
      // Parse trailing annotations like ", depth: background, perspective: back view, holds: book + wand"
      if (annotationsRaw) {
        const annotations = {};
        const annotationPattern = /(depth|perspective|position|holds|holding)\s*:\s*([^,\r\n]+)/gi;
        let annMatch;
        while ((annMatch = annotationPattern.exec(annotationsRaw)) !== null) {
          const key = annMatch[1].toLowerCase() === 'holding' ? 'holds' : annMatch[1].toLowerCase();
          annotations[key] = annMatch[2].trim();
        }
        if (Object.keys(annotations).length > 0) {
          characterPerspectives[baseName] = annotations;
          log.verbose(`[PARSE-CLOTHING] Parsed: "${baseName}" -> "${clothing}" + ${JSON.stringify(annotations)}`);
        } else {
          log.verbose(`[PARSE-CLOTHING] Parsed: "${baseName}" -> "${clothing}"`);
        }
      } else {
        log.verbose(`[PARSE-CLOTHING] Parsed: "${baseName}" -> "${clothing}"`);
      }
    }
  }

  return { characterClothing, characterPerspectives, characters };
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
      this._cache.title = this.cleanMarkdown(boldMatch[1]);
      log.debug(`[OUTLINE-PARSER] Title (bold format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 2: Header followed by "Title: value"
    const prefixMatch = this.outline.match(
      new RegExp(`^#{1,2}\\s*(?:${titleWords})\\s*\\n+(?:${titleWords}):\\s*(.+?)$`, 'im')
    );
    if (prefixMatch) {
      this._cache.title = this.cleanMarkdown(prefixMatch[1]);
      log.debug(`[OUTLINE-PARSER] Title (prefix format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 3: Header followed by plain text (not another header or divider)
    const plainMatch = this.outline.match(
      new RegExp(`^#{1,2}\\s*(?:${titleWords})\\s*\\n+([^#\\-\\n].+?)$`, 'im')
    );
    if (plainMatch) {
      this._cache.title = this.cleanMarkdown(plainMatch[1]);
      log.debug(`[OUTLINE-PARSER] Title (plain format): "${this._cache.title}"`);
      return this._cache.title;
    }

    // Pattern 4: Inline "TITLE: value"
    const inlineMatch = this.outline.match(
      new RegExp(`(?:${titleWords}):\\s*(.+)`, 'i')
    );
    if (inlineMatch) {
      this._cache.title = this.cleanMarkdown(inlineMatch[1]);
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
   * Now includes Scene Characters and Scene Setting metadata when available
   * @returns {Object<number, string>} - Map of page number to scene description (with metadata appended)
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
        // Also look for Scene Characters and Scene Setting metadata
        const metadata = this._extractSceneMetadata(pageLines);
        descriptions[pageNum] = this._buildFullSceneDescription(scene, metadata);
        log.debug(`[OUTLINE-PARSER] Page ${pageNum} scene (field): ${scene.substring(0, 60)}...`);
        if (metadata.characters || metadata.setting) {
          log.debug(`[OUTLINE-PARSER] Page ${pageNum} metadata: chars=${!!metadata.characters}, setting=${!!metadata.setting}`);
        }
        continue;
      }

      // Method 2: Check same line as page header for inline scene
      const headerLine = this.lines[lineIndex];
      const inlineMatch = headerLine.match(
        new RegExp(`(?:${sceneKeywords.join('|')})(?:\\s+Description)?[:\\s]+(.+)`, 'i')
      );
      if (inlineMatch && inlineMatch[1].trim().length > 10) {
        const metadata = this._extractSceneMetadata(pageLines);
        descriptions[pageNum] = this._buildFullSceneDescription(inlineMatch[1].trim(), metadata);
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

        const metadata = this._extractSceneMetadata(pageLines);
        descriptions[pageNum] = this._buildFullSceneDescription(this.cleanMarkdown(trimmed), metadata);
        log.debug(`[OUTLINE-PARSER] Page ${pageNum} scene (fallback): ${descriptions[pageNum].substring(0, 60)}...`);
        break;
      }
    }

    this._cache.sceneDescriptions = descriptions;
    log.debug(`[OUTLINE-PARSER] Extracted ${Object.keys(descriptions).length} scene descriptions`);
    return descriptions;
  }

  /**
   * Extract Scene Characters and Scene Setting metadata from page lines
   * @private
   */
  _extractSceneMetadata(pageLines) {
    const metadata = { characters: null, setting: null, time: null, weather: null };

    for (const line of pageLines) {
      const trimmed = line.trim();

      // Match "Scene Characters:" or "Characters:" at start of line
      const charsMatch = trimmed.match(/^(?:Scene\s+)?Characters?:\s*(.+)/i);
      if (charsMatch) {
        metadata.characters = charsMatch[1].trim();
      }

      // Match "Scene Setting:" or combined "Setting: X | Time: Y | Weather: Z"
      const settingMatch = trimmed.match(/^(?:Scene\s+)?Setting:\s*([^|]+)/i);
      if (settingMatch) {
        metadata.setting = settingMatch[1].trim();

        // Also extract Time and Weather if on same line
        const timeMatch = trimmed.match(/Time:\s*([^|]+)/i);
        if (timeMatch) metadata.time = timeMatch[1].trim();

        const weatherMatch = trimmed.match(/Weather:\s*([^|\n]+)/i);
        if (weatherMatch) metadata.weather = weatherMatch[1].trim();
      }
    }

    return metadata;
  }

  /**
   * Build full scene description with metadata appended
   * @private
   */
  _buildFullSceneDescription(scene, metadata) {
    let full = scene;

    // Append characters if available
    if (metadata.characters) {
      full += `\nCharacters: ${metadata.characters}`;
    }

    // Append setting/time/weather if available
    const settingParts = [];
    if (metadata.setting) settingParts.push(`Setting: ${metadata.setting}`);
    if (metadata.time) settingParts.push(`Time: ${metadata.time}`);
    if (metadata.weather) settingParts.push(`Weather: ${metadata.weather}`);

    if (settingParts.length > 0) {
      full += `\n${settingParts.join(' | ')}`;
    }

    return full;
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

    // Use robust JSON extractor to find clothingRequirements block
    try {
      const parsed = getExtractJsonFromText()(this.outline);
      if (parsed?.clothingRequirements) {
        this._cache.clothingRequirements = parsed.clothingRequirements;
        // Log details about what was extracted
        for (const [charName, reqs] of Object.entries(parsed.clothingRequirements)) {
          const categories = Object.keys(reqs);
          const signatures = categories.filter(cat => reqs[cat]?.signature && reqs[cat].signature !== 'none');
          log.debug(`[OUTLINE-PARSER] ${charName}: categories=${categories.join(',')}, signatures=${signatures.length > 0 ? signatures.map(c => `${c}:"${reqs[c].signature}"`).join(',') : 'none'}`);
        }
        log.debug(`[OUTLINE-PARSER] Extracted clothingRequirements for ${Object.keys(parsed.clothingRequirements).length} characters`);
        return this._cache.clothingRequirements;
      }
    } catch (e) {
      log.warn(`[OUTLINE-PARSER] Failed to parse clothingRequirements JSON: ${e.message}`);
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
  if (!sceneDescription || typeof sceneDescription !== 'string') return [];

  const characterNames = [];
  const charactersKeywords = KEYWORDS.characters.join('|');

  // Step 1: Try to find the Characters section
  // Matches: "5. **Characters:**", "**Characters:**", "## Characters:", etc.
  // Note: Handle colon inside bold (**Characters:**) or outside (**Characters**:)
  const sectionPattern = new RegExp(
    `(?:^|\\n)\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:${charactersKeywords})(?:\\s*\\([^)]*\\))?(?::\\*{0,2}|\\*{0,2}:?)\\s*([\\s\\S]*?)(?=\\n\\s*(?:\\d+\\.\\s*)?(?:#{1,3}\\s*)?\\*{0,2}(?:Objects|Animals|Objekte|Tiere|Objets|Animaux|Setting|Composition|Constraints|Safety)\\*{0,2}|$)`,
    'i'
  );
  const sectionMatch = sceneDescription.match(sectionPattern);
  log.verbose(`[SCENE-PARSER] Looking for Characters section in scene (${sceneDescription.length} chars)`);
  log.verbose(`[SCENE-PARSER] Section pattern match: ${sectionMatch ? 'FOUND' : 'NOT FOUND'}`);

  if (sectionMatch && sectionMatch[1]) {
    const charactersSection = sectionMatch[1];

    // DEBUG: Log the captured section
    log.verbose(`[SCENE-PARSER] Characters section captured (${charactersSection.length} chars):`);
    log.verbose(`[SCENE-PARSER] Section content: "${charactersSection.substring(0, 500)}"`);

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
      // Non-bold: "- Name (position): clothing" or "- Name: clothing"
      // Requires bullet + clothing value to avoid matching section headers
      /^[\t ]*[-*\u2022]\s+([^:\r\n(]+?)(?:\s*\([^)]*\))?\s*:\s*(?:standard|winter|summer|formal|costumed)/gm,
    ];

    for (const pattern of namePatterns) {
      let match;
      log.verbose(`[SCENE-PARSER] Trying pattern: ${pattern.toString().substring(0, 80)}...`);
      while ((match = pattern.exec(charactersSection)) !== null) {
        const name = match[1].trim();
        log.verbose(`[SCENE-PARSER]   Raw match: "${name}" at index ${match.index}`);
        // Skip if it looks like a section header or is too short
        if (name.length >= 2 && !name.match(/^(?:Characters|Charaktere|Personnages|Physical|Description)$/i)) {
          const nameLower = name.toLowerCase();
          if (!characterNames.includes(nameLower)) {
            characterNames.push(nameLower);
            log.verbose(`[SCENE-PARSER]   -> Added: "${nameLower}"`);
          } else {
            log.verbose(`[SCENE-PARSER]   -> Duplicate, skipped`);
          }
        } else {
          log.verbose(`[SCENE-PARSER]   -> Filtered out (header or too short)`);
        }
      }
    }

    if (characterNames.length > 0) {
      log.verbose(`[SCENE-PARSER] Found ${characterNames.length} characters in section: ${characterNames.join(', ')}`);
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
      log.verbose(`[SCENE-PARSER] Found ${characterNames.length} characters from "Main characters:": ${characterNames.join(', ')}`);
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
    log.verbose(`[SCENE-PARSER] Found ${characterNames.length} characters from Composition section: ${characterNames.join(', ')}`);
    return characterNames;
  }

  // Step 5: Fallback - look for character headers anywhere in the scene (bold format)
  // This handles scenes without a dedicated Characters section
  log.verbose(`[SCENE-PARSER] No Characters section found, using text matching`);

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
    log.verbose(`[SCENE-PARSER] Text matching found ${characterNames.length} characters: ${characterNames.join(', ')}`);
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

    // Find the final TITLE: line inside the ---TITLE--- section. Sonnet
    // outputs a TITLE_CANDIDATES: list followed by "TITLE: <chosen>", so we
    // must anchor on a TITLE: that is NOT followed by an underscore (which
    // would match TITLE_CANDIDATES:). Scan only the TITLE section so we don't
    // accidentally pick up stray lines.
    const sectionMatch = this.response.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*[A-Z])/i);
    const section = sectionMatch ? sectionMatch[1] : '';
    const titleLineMatch = section.match(/^\s*(?:\*{1,2})?\s*TITLE(?!_)\s*:\s*(.+?)\s*(?:\*{1,2})?\s*$/im);
    if (titleLineMatch) {
      this._cache.title = titleLineMatch[1].trim()
        .replace(/^\*{1,2}|\*{1,2}$/g, '')
        .replace(/^"|"$/g, '')
        .trim();
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
    try {
      const parsed = getExtractJsonFromText()(section);
      if (parsed) {
        this._cache.clothingRequirements = parsed.clothingRequirements || parsed;
        log.debug(`[UNIFIED-PARSER] Clothing requirements for ${Object.keys(this._cache.clothingRequirements).length} characters`);
        return this._cache.clothingRequirements;
      }
    } catch (e) {
      log.error(`[UNIFIED-PARSER] Failed to parse clothing requirements: ${e.message}`);
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

        // Normalize pages -> appearsInPages field mapping (Claude generates "pages", code expects "appearsInPages")
        const normalizeVisualBibleEntries = (entries) => {
          if (!entries || !Array.isArray(entries)) return entries;
          return entries.map(entry => ({
            ...entry,
            appearsInPages: entry.appearsInPages || entry.pages || [],
          }));
        };

        // Apply normalization to all entry arrays
        if (this._cache.visualBible.secondaryCharacters) {
          this._cache.visualBible.secondaryCharacters = normalizeVisualBibleEntries(this._cache.visualBible.secondaryCharacters);
        }
        if (this._cache.visualBible.artifacts) {
          this._cache.visualBible.artifacts = normalizeVisualBibleEntries(this._cache.visualBible.artifacts);
        }
        if (this._cache.visualBible.animals) {
          this._cache.visualBible.animals = normalizeVisualBibleEntries(this._cache.visualBible.animals);
        }
        if (this._cache.visualBible.vehicles) {
          this._cache.visualBible.vehicles = normalizeVisualBibleEntries(this._cache.visualBible.vehicles);
        }
        if (this._cache.visualBible.locations) {
          this._cache.visualBible.locations = normalizeVisualBibleEntries(this._cache.visualBible.locations);
        }
        if (this._cache.visualBible.clothing) {
          this._cache.visualBible.clothing = normalizeVisualBibleEntries(this._cache.visualBible.clothing);
        }

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
      titlePage: { hint: '', objects: [], characterClothing: {}, characters: [] },
      initialPage: { hint: '', objects: [], characterClothing: {}, characters: [] },
      backCover: { hint: '', objects: [], characterClothing: {}, characters: [] }
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
        return { hint: '', objects: [], characterClothing: {}, characters: [] };
      }

      const block = blockMatch[1];

      // Extract hint - specifically look for "Hint:" line first
      // The block may start with "(Front Cover)" label, so we need to find the actual hint
      const hintLineMatch = block.match(/^Hint:\s*(.+)$/im);
      let hint = '';
      if (hintLineMatch) {
        hint = hintLineMatch[1].trim();
      } else {
        // Fallback: get first non-empty line that isn't a label like "(Front Cover)"
        const lines = block.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^\(.*\)$/));
        hint = lines[0] || '';
      }

      // Extract Objects: line — list of Visual Bible element IDs (LOC, ANI, ART, OBJ, VEH, CHR)
      const objectsMatch = block.match(/^Objects?:\s*(.+)$/im);
      const objects = objectsMatch
        ? objectsMatch[1].match(/(?:LOC|ANI|ART|OBJ|VEH|CHR)\d+/gi)?.map(id => id.toUpperCase()) || []
        : [];

      // Extract per-character clothing + optional perspective annotations
      const { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(block);

      return { hint, objects, characterClothing, characterPerspectives, characters };
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

    // First, extract just the STORY PAGES section to avoid content after pages
    // This prevents the regex from failing when there's AI sign-off text after the last page
    let pagesSection = this.response;
    const storyPagesStart = this.response.indexOf('---STORY PAGES---');
    if (storyPagesStart !== -1) {
      pagesSection = this.response.substring(storyPagesStart);
      log.debug(`[UNIFIED-PARSER] Found ---STORY PAGES--- section at position ${storyPagesStart}`);
    } else {
      log.debug(`[UNIFIED-PARSER] No ---STORY PAGES--- marker found, searching entire response`);
    }

    // Match page blocks: --- Page/Seite/Página X --- (multilingual: EN/DE/FR/ES)
    // Using greedy match with explicit next-page lookahead, plus end-of-string fallback
    const pagePattern = /---\s*(?:Page|Seite|Página|Pagina)\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*(?:Page|Seite|Página|Pagina)\s+\d+\s*---|$)/gi;

    let match;
    let lastPageNumber = 0;
    while ((match = pagePattern.exec(pagesSection)) !== null) {
      const pageNumber = parseInt(match[1], 10);
      const content = match[2];
      lastPageNumber = Math.max(lastPageNumber, pageNumber);

      // Extract TEXT section — stops at SCENE:, METADATA:, or SCENE HINT:
      const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|METADATA:|SCENE HINT:|$)/i);
      // Strip any trailing metadata like "*(Word count: 331)*" or similar
      const text = textMatch ? textMatch[1].trim().replace(/\s*\*\([^)]*\)\*\s*$/g, '').replace(/\s*\[[A-Z]{2,3}\d{3}\]/g, '').trim() : '';

      // NEW FORMAT (unifiedSceneProse): SCENE: <prose> + METADATA: <json>
      // Both blocks are emitted by Sonnet directly — no Haiku expansion step.
      // The prose becomes sceneDescription (fed to Grok), the JSON becomes
      // sceneHint (parsed for characters/objects/textPosition/etc).
      //
      // OLD FORMAT (legacy): SCENE HINT: <json>
      // The parser still accepts this for backward compatibility.
      let sceneProse = '';
      let sceneHint = '';
      const nextPageBoundary = /(?=---\s*(?:Page|Seite|Página|Pagina)|$)/;

      // Try new format: SCENE: prose block
      const sceneProseMatch = content.match(/SCENE:\s*([\s\S]*?)(?=METADATA:|SCENE HINT:|---\s*(?:Page|Seite|Página|Pagina)|$)/i);
      if (sceneProseMatch && sceneProseMatch[1].trim().length > 0) {
        sceneProse = sceneProseMatch[1].trim().replace(/```[\s\S]*?```/g, '').trim();
      }

      // Try new format: METADATA: JSON block
      const metadataMatch = content.match(/METADATA:\s*(?:```json\s*\n?)?\s*(\{[\s\S]*?\})\s*(?:```\s*)?(?=---\s*(?:Page|Seite|Página|Pagina)|SCENE HINT:|$)/i);
      if (metadataMatch) {
        sceneHint = metadataMatch[1].trim();
      } else {
        // Legacy fallback: SCENE HINT: JSON
        const jsonHintMatch = content.match(/SCENE HINT:\s*(?:```json\s*\n?)?\s*(\{[\s\S]*?\})\s*(?:```\s*)?(?=---\s*(?:Page|Seite|Página|Pagina)|$)/i);
        if (jsonHintMatch) {
          sceneHint = jsonHintMatch[1].trim();
        } else {
          // Legacy text-format SCENE HINT (pre-JSON era)
          const textHintMatch = content.match(/SCENE HINT:\s*([\s\S]*?)(?=^Characters(?:\s*\([^)]*\))?:|---\s*(?:Page|Seite|Página|Pagina))/im);
          sceneHint = textHintMatch ? textHintMatch[1].trim() : '';
        }
      }

      // Extract per-character clothing + perspective annotations from text-based format:
      // Characters:
      // - Name1: standard
      // - Name2: costumed:superhero, depth: background, perspective: back view
      let { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(content);

      // Fallback: extract clothing + perspective from JSON scene hint (trial prompt format)
      // JSON hints have characters[].clothing/depth/perspective inside the scene object
      if (Object.keys(characterClothing).length === 0 && sceneHint) {
        try {
          // Strip markdown code fences if present
          const jsonStr = sceneHint.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
          const parsed = JSON.parse(jsonStr);
          const sceneData = parsed?.scene || parsed;
          if (sceneData?.characters && Array.isArray(sceneData.characters)) {
            for (const char of sceneData.characters) {
              if (char.name && char.clothing) {
                let baseName = char.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
                // Resolve VB IDs (CHR001, ANI001, etc.) to actual names
                if (/^(CHR|ANI|ART|LOC|VEH|CLO)\d{3}$/i.test(baseName) && this._cache?.visualBible) {
                  const vb = this._cache.visualBible;
                  const allEntries = [...(vb.mainCharacters || []), ...(vb.secondaryCharacters || []), ...(vb.animals || []), ...(vb.artifacts || []), ...(vb.locations || []), ...(vb.vehicles || []), ...(vb.clothing || [])];
                  const match = allEntries.find(e => e.id === baseName.toUpperCase());
                  if (match?.name) {
                    log.debug(`[UNIFIED-PARSER] Resolved VB ID ${baseName} → ${match.name}`);
                    baseName = match.name;
                  }
                }
                // Normalize: only 4 valid categories
                const raw = char.clothing.toLowerCase();
                const costumedMatch = raw.match(/costumed:(?!costumed)(.+)/);
                let clothing = 'standard';
                if (costumedMatch) clothing = `costumed:${costumedMatch[1].trim()}`;
                else if (raw.includes('costumed')) clothing = 'costumed';
                else if (raw.includes('winter')) clothing = 'winter';
                else if (raw.includes('summer')) clothing = 'summer';
                characterClothing[baseName] = clothing;
                characters.push(char.name);
                // Capture optional depth/perspective from JSON char object
                const annotations = {};
                if (char.depth) annotations.depth = String(char.depth).toLowerCase();
                if (char.perspective) annotations.perspective = String(char.perspective).toLowerCase();
                if (Object.keys(annotations).length > 0) {
                  characterPerspectives[baseName] = annotations;
                }
              }
            }
          }
        } catch {
          // Not valid JSON — that's fine, text-based hints don't need this fallback
        }
      }

      pages.push({
        pageNumber,
        text,
        sceneHint,
        sceneProse,  // new: Sonnet-authored prose (unifiedSceneProse path)
        characterClothing,
        characterPerspectives,
        characters
      });

      log.debug(`[UNIFIED-PARSER] Page ${pageNumber}: text=${text.length} chars, prose=${sceneProse.length} chars, hint=${sceneHint.length} chars, clothing=${Object.keys(characterClothing).join(',') || 'none'}`);
    }

    // Sort by page number
    pages.sort((a, b) => a.pageNumber - b.pageNumber);

    this._cache.pages = pages;
    log.debug(`[UNIFIED-PARSER] Extracted ${pages.length} pages (highest page number: ${lastPageNumber})`);

    // Warn if there's a mismatch between page count and highest page number
    if (pages.length > 0 && pages.length !== lastPageNumber) {
      log.warn(`[UNIFIED-PARSER] Page count mismatch: found ${pages.length} pages but highest page number is ${lastPageNumber}`);
    }

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
   * @param {Function} callbacks.onCoverScene - Called when cover scene JSON is complete (trial flow)
   * @param {Function} callbacks.onCoverHints - Called when cover hints section is complete
   * @param {Function} callbacks.onPageComplete - Called when a story page is complete
   * @param {Function} callbacks.onProgress - Called with progress updates for UI
   */
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.fullText = '';
    this._isTrial = options.isTrial || false;

    // Track which sections have been emitted
    this.emitted = {
      title: false,
      clothingRequirements: false,
      characterArcs: false,
      plotStructure: false,
      visualBible: false,
      coverScene: false,
      coverHints: false,
      pages: new Set()
    };

    // Set to true during finalize() to relax last-page detection
    this._finalized = false;

    // Section markers in order (must match actual output format from story-unified.txt)
    this.sectionMarkers = [
      '---TITLE---',
      '---CLOTHING REQUIREMENTS---',
      '---VISUAL BIBLE---',
      '---COVER SCENE---',
      '---COVER SCENE HINTS---',
      '---STORY PAGES---'
    ];
  }

  /**
   * Check if a section marker exists in the text, tolerating spaces around the name.
   * e.g. _hasMarker('TITLE') matches both '---TITLE---' and '--- TITLE ---'
   */
  _hasMarker(name) {
    return new RegExp(`---\\s*${name.replace(/\s+/g, '\\s+')}\\s*---`).test(this.fullText);
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
    if (this._isTrial) this._checkCoverScene();
    this._checkCoverHints();
    this._checkPages();
  }

  /**
   * Check if title section is complete
   */
  _checkTitle() {
    if (this.emitted.title) return;

    // Title is complete when we see the next section marker
    // Full flow: TITLE → CLOTHING REQUIREMENTS
    // Trial flow: TITLE → VISUAL BIBLE
    if (!this._hasMarker('TITLE')) return;
    if (!this._hasMarker('CLOTHING REQUIREMENTS') && !this._hasMarker('VISUAL BIBLE')) return;

    // Scan only the TITLE section so we can pick the FINAL TITLE: line and
    // ignore the TITLE_CANDIDATES: list header Sonnet emits above it.
    const sectionMatch = this.fullText.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*(?:CLOTHING|VISUAL))/i);
    const section = sectionMatch ? sectionMatch[1] : null;
    // TITLE(?!_) negative-lookahead excludes TITLE_CANDIDATES:.
    const titleLineMatch = section ? section.match(/^\s*(?:\*{1,2})?\s*TITLE(?!_)\s*:\s*(.+?)\s*(?:\*{1,2})?\s*$/im) : null;
    if (titleLineMatch) {
      const title = titleLineMatch[1].trim()
        .replace(/^\*{1,2}|\*{1,2}$/g, '')
        .replace(/^"|"$/g, '')
        .trim();
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

    // Complete when we see VISUAL BIBLE marker (next section in output)
    if (!this._hasMarker('CLOTHING REQUIREMENTS')) return;
    if (!this._hasMarker('VISUAL BIBLE')) return;

    const sectionMatch = this.fullText.match(/---\s*CLOTHING\s+REQUIREMENTS\s*---\s*([\s\S]*?)(?=---\s*VISUAL\s+BIBLE\s*---)/i);
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
        // JSON parse error - log it for debugging
        log.debug(`[STREAM-UNIFIED] Clothing requirements JSON parse error (may be incomplete): ${e.message}`);
      }
    }
  }

  /**
   * Check if character arcs section is complete
   */
  _checkCharacterArcs() {
    if (this.emitted.characterArcs) return;

    if (!this._hasMarker('CHARACTER ARCS')) return;
    if (!this._hasMarker('PLOT STRUCTURE')) return;

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

    if (!this._hasMarker('PLOT STRUCTURE')) return;
    if (!this._hasMarker('VISUAL BIBLE')) return;

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

    // Visual Bible is complete when we see the next section marker
    // Full flow: VISUAL BIBLE → COVER SCENE HINTS
    // Trial flow: VISUAL BIBLE → COVER SCENE → STORY PAGES
    if (!this._hasMarker('VISUAL BIBLE')) return;
    if (!this._hasMarker('COVER SCENE HINTS') && !this._hasMarker('COVER SCENE') && !this._hasMarker('STORY PAGES')) return;

    const sectionMatch = this.fullText.match(/---\s*VISUAL\s+BIBLE\s*---\s*([\s\S]*?)(?=---\s*(?:COVER\s+SCENE(?:\s+HINTS)?|STORY\s+PAGES)\s*---)/i);
    if (!sectionMatch) return;

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        this.emitted.visualBible = true;

        // Normalize pages -> appearsInPages field mapping (Claude generates "pages", code expects "appearsInPages")
        const normalizeVisualBibleEntries = (entries) => {
          if (!entries || !Array.isArray(entries)) return entries;
          return entries.map(entry => ({
            ...entry,
            appearsInPages: entry.appearsInPages || entry.pages || [],
          }));
        };

        // Apply normalization to all entry arrays
        if (parsed.secondaryCharacters) parsed.secondaryCharacters = normalizeVisualBibleEntries(parsed.secondaryCharacters);
        if (parsed.artifacts) parsed.artifacts = normalizeVisualBibleEntries(parsed.artifacts);
        if (parsed.animals) parsed.animals = normalizeVisualBibleEntries(parsed.animals);
        if (parsed.vehicles) parsed.vehicles = normalizeVisualBibleEntries(parsed.vehicles);
        if (parsed.locations) parsed.locations = normalizeVisualBibleEntries(parsed.locations);
        if (parsed.clothing) parsed.clothing = normalizeVisualBibleEntries(parsed.clothing);

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
        // JSON parse error - log it for debugging
        log.debug(`[STREAM-UNIFIED] Visual Bible JSON parse error (may be incomplete): ${e.message}`);
      }
    }
  }

  /**
   * Check if cover scene JSON is complete (trial flow: COVER SCENE between VISUAL BIBLE and STORY PAGES)
   */
  _checkCoverScene() {
    if (this.emitted.coverScene) return;

    if (!this._hasMarker('COVER SCENE')) return;
    if (!this._hasMarker('STORY PAGES')) return;

    // Make sure we match the exact ---COVER SCENE--- marker and not ---COVER SCENE HINTS---
    const sectionMatch = this.fullText.match(/---\s*COVER\s+SCENE\s*---\s*([\s\S]*?)(?=---\s*STORY\s+PAGES\s*---)/i);
    if (!sectionMatch) return;

    const section = sectionMatch[1];
    const jsonMatch = section.match(/```json\s*([\s\S]*?)```/i);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]);
        this.emitted.coverScene = true;
        log.debug(`[PARSER] Cover scene detected`);

        if (this.callbacks.onCoverScene) {
          this.callbacks.onCoverScene(parsed);
        }
        if (this.callbacks.onProgress) {
          this.callbacks.onProgress('coverScene', 'Cover scene defined');
        }
      } catch (e) {
        log.debug(`[STREAM-UNIFIED] Cover scene JSON parse error (may be incomplete): ${e.message}`);
      }
    }
  }

  /**
   * Check if cover hints section is complete
   */
  _checkCoverHints() {
    if (this.emitted.coverHints) return;

    if (!this._hasMarker('COVER SCENE HINTS')) return;
    if (!this._hasMarker('STORY PAGES')) return;

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
    if (!this._hasMarker('STORY PAGES')) return;

    // Find all page blocks (multilingual: Page/Seite/Página)
    const pagePattern = /---\s*(?:Page|Seite|Página|Pagina)\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*(?:Page|Seite|Página|Pagina)\s+\d+\s*---|$)/gi;

    let match;
    while ((match = pagePattern.exec(this.fullText)) !== null) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      // Skip if already emitted
      if (this.emitted.pages.has(pageNum)) continue;

      // A page is complete when we have TEXT and either:
      //   - METADATA: (new unified-scene-prose format), or
      //   - SCENE HINT: (legacy format)
      const hasText = /TEXT:\s*\S/.test(content);
      const hasHint = /SCENE HINT:\s*\S/.test(content) || /METADATA:\s*\S/.test(content);

      // Check if there's a next page (means this one is complete) or end of content
      // Check for next page marker in any language (Page/Seite/Página)
      const nextPageRegex = new RegExp(`---\\s*(?:Page|Seite|Página|Pagina)\\s+${pageNum + 1}\\s*---`);
      const nextPageMatch = this.fullText.match(nextPageRegex);
      const nextPageIndex = nextPageMatch ? this.fullText.indexOf(nextPageMatch[0]) : -1;
      const isLastKnownPage = nextPageIndex === -1;

      // Page completeness detection:
      // 1. Non-last page: If the next page marker exists, this page is COMPLETE by definition.
      //    All content has been streamed. We just need TEXT + SCENE HINT to be useful.
      // 2. Last page during streaming: Content may still be arriving, so require evidence
      //    the page is fully received (clothing data or Setting: line present).
      // 3. At finalize() time: this._finalized is true, so even the last page emits
      //    with just TEXT + SCENE HINT (all content has been received).

      // Detect any clothing-related content (handles all formats: bulleted, non-bulleted, inline)
      // Matches "Name: standard/winter/summer/formal/costumed:xxx" anywhere in the Characters block
      const hasCharacterClothing = /Characters(?:\s*\([^)]*\))?:[\s\S]*?\w[^:\r\n]*:\s*(?:standard|winter|summer|formal|costumed:[^\r\n]+)/i.test(content);

      // For the last page during streaming, check if the page looks complete:
      // Has Setting: line, OR has a blank line after Characters block, OR has clothing data at end of content
      const hasSettingLine = /\bSetting:\s*\S/i.test(content);

      // Emit conditions:
      // - Non-last page: next page marker exists AND we have TEXT + HINT (page is definitively complete)
      // - Last page: TEXT + HINT + (Setting line OR clothing data OR finalized)
      const isNonLastComplete = nextPageIndex > match.index && hasText && hasHint;
      const isLastComplete = isLastKnownPage && hasText && hasHint && (hasSettingLine || hasCharacterClothing || this._finalized);

      if (isNonLastComplete || isLastComplete) {
        // Extract page data
        // TEXT: stops at SCENE:, METADATA:, or SCENE HINT:
        const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|METADATA:|SCENE HINT:|$)/i);
        // Strip any trailing metadata like "*(Word count: 331)*" or similar
        const text = textMatch ? textMatch[1].trim().replace(/\s*\*\([^)]*\)\*\s*$/g, '').replace(/\s*\[[A-Z]{2,3}\d{3}\]/g, '').trim() : '';

        // New format: SCENE: prose (Sonnet-authored)
        const sceneProseMatch = content.match(/SCENE:\s*([\s\S]*?)(?=METADATA:|SCENE HINT:|---\s*(?:Page|Seite|Página|Pagina)|$)/i);
        const sceneProse = sceneProseMatch ? sceneProseMatch[1].trim().replace(/```[\s\S]*?```/g, '').trim() : '';

        // New format: METADATA: JSON. Legacy fallback: SCENE HINT: JSON.
        const metadataMatch = content.match(/METADATA:\s*(?:```json\s*\n?)?\s*(\{[\s\S]*?\})\s*(?:```\s*)?(?=---\s*(?:Page|Seite|Página|Pagina)|SCENE HINT:|$)/i);
        let sceneHint = '';
        if (metadataMatch) {
          sceneHint = metadataMatch[1].trim();
        } else {
          const hintMatch = content.match(/SCENE HINT:\s*([\s\S]*?)(?=Characters(?:\s*\([^)]*\))?:|---\s*(?:Page|Seite|Página|Pagina)|$)/i);
          sceneHint = hintMatch ? hintMatch[1].trim() : '';
        }

        // Extract per-character clothing from the page content (JSON scene hint format
        // or legacy bullet list). parseCharacterClothingBlock handles both.
        const { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(content);

        this.emitted.pages.add(pageNum);
        const clothingStr = Object.keys(characterClothing).length > 0
          ? Object.entries(characterClothing).map(([n, c]) => `${n}:${c}`).join(', ')
          : 'none';
        const perspectiveStr = Object.keys(characterPerspectives).length > 0
          ? ` perspectives: ${Object.entries(characterPerspectives).map(([n, a]) => `${n}:${a.perspective || a.depth}`).join(', ')}`
          : '';
        log.debug(`🌊 [STREAM-UNIFIED] Page ${pageNum} complete (prose: ${sceneProse.length} chars, clothing: ${clothingStr}${perspectiveStr})`);

        if (this.callbacks.onPageComplete) {
          this.callbacks.onPageComplete({
            pageNumber: pageNum,
            text,
            sceneHint,
            sceneProse,
            characterClothing,
            characterPerspectives,
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
   * Get the raw outline block for a specific page (for passing to scene expansion)
   * Returns the exact text from "--- Page X ---" to the next page marker or end
   * @param {number} pageNumber - The page number to get
   * @returns {string|null} Raw page block or null if not found
   */
  getRawPageBlock(pageNumber) {
    if (!this.fullText) return null;

    // Match the specific page block (multilingual: Page/Seite/Página)
    const pattern = new RegExp(
      `---\\s*(?:Page|Seite|Página|Pagina)\\s+${pageNumber}\\s*---\\s*([\\s\\S]*?)(?=---\\s*(?:Page|Seite|Página|Pagina)\\s+\\d+\\s*---|$)`,
      'i'
    );
    const match = this.fullText.match(pattern);
    if (!match) return null;

    // Return the header + content (normalize to English "Page" for downstream)
    return `--- Page ${pageNumber} ---\n${match[1].trim()}`;
  }

  /**
   * Get raw outline blocks for multiple pages (for previous scenes context)
   * @param {number[]} pageNumbers - Array of page numbers to get
   * @returns {string} Combined raw blocks, or empty string if none found
   */
  getRawPageBlocks(pageNumbers) {
    const blocks = pageNumbers
      .map(pn => this.getRawPageBlock(pn))
      .filter(Boolean);
    return blocks.join('\n\n');
  }

  /**
   * Finalize parsing - emit any remaining pages and warn about missing sections
   */
  finalize() {
    // Mark as finalized so _checkPages() relaxes last-page detection
    // (all content has been received, so TEXT + HINT is sufficient)
    this._finalized = true;

    // Rescue truncated cover scene before final page check
    if (this._isTrial) this._checkCoverScene();

    // Re-check pages one more time to catch the last page
    this._checkPages();

    // Warn about required sections that weren't detected during streaming
    // Only warn about sections that actually exist in the response (trial mode skips clothing/covers)
    const hasClothingSection = this.fullText.includes('---') && this.fullText.includes('CLOTHING REQUIREMENTS');
    const hasCoverHintsSection = this._hasMarker('COVER SCENE HINTS');
    const hasCoverSceneSection = this.fullText.includes('---') && /---\s*COVER\s+SCENE\s*---/.test(this.fullText);
    const missingSections = [];
    if (!this.emitted.title) missingSections.push('TITLE');
    if (!this.emitted.clothingRequirements && hasClothingSection) missingSections.push('CLOTHING REQUIREMENTS');
    if (!this.emitted.visualBible) missingSections.push('VISUAL BIBLE');
    if (!this.emitted.coverScene && hasCoverSceneSection) missingSections.push('COVER SCENE');
    if (!this.emitted.coverHints && hasCoverHintsSection) missingSections.push('COVER SCENE HINTS');

    if (missingSections.length > 0) {
      log.warn(`⚠️ [STREAM-UNIFIED] Missing sections not detected during streaming: ${missingSections.join(', ')}`);
      // Log which markers were found to help debug
      const foundMarkers = this.sectionMarkers.filter(m => this.fullText.includes(m));
      log.debug(`[STREAM-UNIFIED] Markers found in response: ${foundMarkers.join(', ') || 'none'}`);
    }

    log.debug(`🌊 [STREAM-UNIFIED] Finalized: ${this.emitted.pages.size} pages emitted`);
    return {
      title: this.emitted.title,
      clothingRequirements: this.emitted.clothingRequirements,
      characterArcs: this.emitted.characterArcs,
      plotStructure: this.emitted.plotStructure,
      visualBible: this.emitted.visualBible,
      coverScene: this.emitted.coverScene,
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
