/**
 * Legacy outline parser
 *
 * Parses the old `outline.txt`-style response (separate outline + text mode).
 * The unified-prompt path uses UnifiedStoryParser instead — see ./unified.
 */

const {
  log,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  PAGE_HEADER_PATTERN,
  TITLE_HEADER_PATTERN,
  CLOTHING_CATEGORY_PATTERN,
  parseCharacterClothingBlock,
  getExtractJsonFromText,
} = require('./shared');

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

    // Try unified-outline format FIRST (---COVER SCENE HINTS--- with
    // **Title Page** / **Initial Page** / **Back Cover** markers). This is
    // the format `prompts/story-unified.txt` produces today. Must run before
    // _extractStoryModeCoverScenes because the latter's inline regex
    // (\*{0,2}Title Page\*{0,2}[:\s]+ ...) over-eagerly matches `**Title Page`
    // and captures `(Front Cover)**` as the prose.
    this._extractUnifiedCoverScenes(coverScenes);

    // Try storybook format (---TITLE PAGE---, ---BACK COVER---)
    this._extractStorybookCoverScenes(coverScenes);

    // Try story mode format (Title Page Scene:, Back Cover Scene:)
    this._extractStoryModeCoverScenes(coverScenes);

    this._cache.coverScenes = coverScenes;

    log.debug(`[OUTLINE-PARSER] Cover scenes extracted:`);
    log.debug(`  Title Page: ${coverScenes.titlePage.scene.substring(0, 50) || 'none'}...`);
    log.debug(`  Initial Page: ${coverScenes.initialPage.scene.substring(0, 50) || 'none'}...`);
    log.debug(`  Back Cover: ${coverScenes.backCover.scene.substring(0, 50) || 'none'}...`);

    // Loud failure: if outline is non-empty but ALL covers came back empty,
    // the parser failed to recognise the format. Don't fail silently —
    // downstream cover-expansion fills in chat-style preamble that becomes
    // the SCENE prose. Log ERROR so format drift gets caught immediately.
    const allEmpty = !coverScenes.titlePage.scene && !coverScenes.initialPage.scene && !coverScenes.backCover.scene;
    if (allEmpty && this.outline && this.outline.length > 100) {
      const idx = this.outline.search(/cover\s+scene\s+hints|title\s+page|back\s+cover/i);
      const excerpt = idx >= 0 ? this.outline.slice(idx, idx + 400) : this.outline.slice(0, 400);
      log.error(`[OUTLINE-PARSER] Cover scene extraction returned EMPTY for all 3 covers despite a ${this.outline.length}-char outline. Format may have drifted. Excerpt:\n${excerpt}`);
    }

    return coverScenes;
  }

  /**
   * Extract cover scenes from the unified-outline format used by
   * `prompts/story-unified.txt`:
   *
   *   ---COVER SCENE HINTS---
   *
   *   **Title Page**
   *   Hint: prose paragraph here.
   *   Objects: LOC001, ART002
   *   Characters:
   *   - Name (position): clothing, holds: items
   *
   * The `Hint:` label is optional — Sonnet sometimes drops it. Either form
   * is accepted. Tolerates legacy `**Title Page (Front Cover)**` parenthetical.
   */
  _extractUnifiedCoverScenes(coverScenes) {
    const headerToKey = {
      'title page': 'titlePage',
      'initial page': 'initialPage',
      'back cover': 'backCover',
    };
    const headerRe = /\*\*\s*(Title Page|Initial Page|Back Cover)(?:\s*\([^)]*\))?\s*\*\*/gi;
    const matches = [];
    let m;
    while ((m = headerRe.exec(this.outline)) !== null) {
      matches.push({ key: headerToKey[m[1].toLowerCase()], start: m.index + m[0].length, headerEnd: m.index });
    }
    if (matches.length === 0) return;

    for (let i = 0; i < matches.length; i++) {
      const { key, start } = matches[i];
      if (!key) continue;
      const end = i + 1 < matches.length ? matches[i + 1].headerEnd : this.outline.length;
      const blockRaw = this.outline.slice(start, end);
      // Stop the block at the next major section divider.
      const stopMatch = blockRaw.match(/\n---[A-Z][A-Z\s]+---/);
      const block = stopMatch ? blockRaw.slice(0, stopMatch.index) : blockRaw;
      // Pull the scene prose: optional `Hint:` line then the paragraph(s)
      // before `Objects:` / `Characters:` / a bullet list / parenthetical
      // documentation lines.
      const lines = block.split('\n');
      const proseLines = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
          if (proseLines.length > 0) break;  // blank line ends prose once we have some
          continue;
        }
        if (/^(ONLY|NO|Pick|Place|Always|\(.*\)$)/i.test(line)) continue;
        if (/^Objects\s*:/i.test(line)) break;
        if (/^Characters?\s*:/i.test(line)) break;
        if (/^[-*]\s/.test(line)) break;
        const stripped = line.replace(/^Hint\s*:\s*/i, '').trim();
        if (stripped) proseLines.push(stripped);
      }
      const scene = proseLines.join(' ').trim();
      if (scene && !coverScenes[key].scene) {
        coverScenes[key].scene = scene;
        coverScenes[key].clothing = this._extractClothingFromBlock(block);
      }
    }
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

module.exports = { OutlineParser };
