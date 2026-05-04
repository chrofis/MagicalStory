/**
 * Unified Story Parser
 *
 * Parses output from the unified prompt (story-unified.txt). The model emits
 * a DRAFT, an ANALYSIS, and a STORY PAGES patch block; this parser merges
 * them per-section into a final per-page array.
 */

const {
  log,
  KEYWORDS,
  parseCharacterClothingBlock,
  parsePatchSections,
  parseDraftSections,
  extractDraftPagesFromText,
  extractCharacterNamesFromScene,
  getExtractJsonFromText,
} = require('./shared');

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

    const sectionMatch = this.response.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*[A-Z])/i);
    const section = sectionMatch ? sectionMatch[1] : '';

    // Prefer the TITLE_CANDIDATES list and pick one at random — the model
    // would otherwise converge on the most "iconic" candidate every run
    // (e.g. always "Der zweite Bolzen" for any Tell story). Random pick
    // delivers the variety the prompt asked the model to produce.
    const candidatesMatch = section.match(/TITLE_CANDIDATES\s*:\s*([\s\S]+?)(?=\n\s*(?:TITLE\s*:|---|$))/i);
    if (candidatesMatch) {
      const candidates = candidatesMatch[1]
        .split('\n')
        .map(l => l.match(/^\s*\d+[.)]\s*(.+?)\s*$/))
        .filter(Boolean)
        .map(m => m[1].trim()
          .replace(/^\*{1,2}|\*{1,2}$/g, '')
          .replace(/^"|"$/g, '')
          .replace(/^\[|\]$/g, '')
          .trim())
        .filter(s => s.length > 0 && !/^\[.*\]$/.test(s));
      if (candidates.length > 0) {
        // Deterministic pick: stableCandidateIndex hashes the candidates and
        // picks the same index here as the streaming parser does. Without
        // this, two independent Math.random() calls produced two different
        // titles — cover gen used the streaming pick, story save used the
        // parser pick, and they diverged.
        const { stableCandidateIndex } = require('./shared');
        const pick = candidates[stableCandidateIndex(candidates)];
        this._cache.title = pick;
        this._cache.titleCandidates = candidates;
        log.info(`[UNIFIED-PARSER] Picked title (stable) from ${candidates.length} candidates: "${pick}"`);
        return pick;
      }
    }

    // Fallback: legacy `TITLE: <value>` line for older runs / partial outputs
    // where TITLE_CANDIDATES is missing.
    const titleLineMatch = section.match(/^\s*(?:\*{1,2})?\s*TITLE(?!_)\s*:\s*(.+?)\s*(?:\*{1,2})?\s*$/im);
    if (titleLineMatch) {
      this._cache.title = titleLineMatch[1].trim()
        .replace(/^\*{1,2}|\*{1,2}$/g, '')
        .replace(/^"|"$/g, '')
        .trim();
      this._cache.titleCandidates = null;
      log.debug(`[UNIFIED-PARSER] Title (legacy single-line): "${this._cache.title}"`);
      return this._cache.title;
    }

    this._cache.title = null;
    this._cache.titleCandidates = null;
    return null;
  }

  /**
   * Returns the full list of title candidates the model produced (or null
   * if the outline used the legacy single `TITLE:` line). Triggers parsing
   * on first call so the cache is populated.
   */
  extractTitleCandidates() {
    if (this._cache.titleCandidates === undefined) this.extractTitle();
    return this._cache.titleCandidates ?? null;
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
  // Parsing helpers are module-level (see parsePatchSections / parseDraftSections
  // near the top of this file). They are pure and shared with the streaming parser.

  /**
   * Extract draft-section pages keyed by pageNumber. Cached on the instance.
   * @private
   */
  _extractDraftPages() {
    if (this._cache.draftPages !== undefined) return this._cache.draftPages;
    const map = extractDraftPagesFromText(this.response);
    this._cache.draftPages = map;
    if (map.size > 0) {
      log.debug(`[UNIFIED-PARSER] Draft pages extracted: ${map.size} (page numbers: ${[...map.keys()].join(',')})`);
    }
    return map;
  }

  /**
   * Extract patch pages (---STORY PAGES--- block) keyed by pageNumber.
   * Each value may have empty strings for sections not emitted in the patch.
   * Returns Map<number, { text, sceneProse, sceneHint, content }>.
   * @private
   */
  _extractPatchPages() {
    if (this._cache.patchPages !== undefined) return this._cache.patchPages;

    const map = new Map();
    let pagesSection = this.response;
    const storyPagesStart = this.response.indexOf('---STORY PAGES---');
    if (storyPagesStart !== -1) {
      pagesSection = this.response.substring(storyPagesStart);
    }

    const pagePattern = /---\s*(?:Page|Seite|Página|Pagina)\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*(?:Page|Seite|Página|Pagina)\s+\d+\s*---|$)/gi;
    let match;
    while ((match = pagePattern.exec(pagesSection)) !== null) {
      const pageNumber = parseInt(match[1], 10);
      const content = match[2];
      const { text, sceneProse, sceneHint } = parsePatchSections(content);
      map.set(pageNumber, { text, sceneProse, sceneHint, content });
    }

    this._cache.patchPages = map;
    return map;
  }

  extractPages() {
    if (this._cache.pages !== undefined) return this._cache.pages;

    const pages = [];

    const draftPages = this._extractDraftPages();
    const patchPages = this._extractPatchPages();

    log.debug(`[UNIFIED-PARSER] Merging ${patchPages.size} patch pages onto ${draftPages.size} draft pages`);

    // Determine which page numbers to materialize. Use the union; if neither
    // produced anything (legacy responses without DRAFT/PATCH), fall back to
    // re-running the old single-pass extractor against the whole response.
    const pageNums = new Set([...draftPages.keys(), ...patchPages.keys()]);
    if (pageNums.size === 0) {
      this._cache.pages = pages;
      return pages;
    }

    const sortedNums = [...pageNums].sort((a, b) => a - b);
    let lastPageNumber = sortedNums[sortedNums.length - 1] || 0;

    for (const pageNumber of sortedNums) {
      const draft = draftPages.get(pageNumber) || { text: '', sceneProse: '', sceneHint: '', content: '' };
      const patch = patchPages.get(pageNumber) || { text: '', sceneProse: '', sceneHint: '', content: '' };

      // Patch wins on a per-section basis; draft fills the rest.
      const text = patch.text || draft.text;
      const sceneProse = patch.sceneProse || draft.sceneProse;
      const sceneHint = patch.sceneHint || draft.sceneHint;

      // Build merged content for character/clothing parsing. The textual
      // "Characters: - Name: clothing" block can live in either draft or patch.
      const mergedContent = `${draft.content || ''}\n${patch.content || ''}`;

      let { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(mergedContent);

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

module.exports = { UnifiedStoryParser };
