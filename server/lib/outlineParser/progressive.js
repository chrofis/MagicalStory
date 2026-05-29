/**
 * Progressive Unified Story Parser
 *
 * Streaming companion to UnifiedStoryParser. Cache the draft as soon as the
 * ANALYSIS section is buffered, parse FIXES REQUIRED to learn which pages
 * have patches, eagerly emit unpatched pages from the draft so downstream
 * scene expansion / image generation can start in parallel, then merge each
 * patched page with the draft as its block completes.
 */

const {
  log,
  parseCharacterClothingBlock,
  parsePatchSections,
  extractDraftPagesFromText,
} = require('./shared');

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

    // Cached draft (populated once ---ANALYSIS--- appears) and patched-page set
    // (populated once ---STORY PAGES--- appears, derived from FIXES REQUIRED).
    this._draftPages = null;          // Map<number, {text, sceneProse, sceneHint, content}>
    this._patchedPageNumbers = null;  // Set<number> | null (null = unknown / fallback)

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
   * Parse the buffered DRAFT section into a per-page map. Idempotent — only
   * runs the heavy work once. Called as soon as ---ANALYSIS--- (or any later
   * marker) appears, since at that point the draft is complete.
   * @private
   */
  _ensureDraftPages() {
    if (this._draftPages !== null) return this._draftPages;
    this._draftPages = extractDraftPagesFromText(this.fullText, { isTrial: this._isTrial });
    return this._draftPages;
  }

  /**
   * Parse FIXES REQUIRED to determine which pages have patches and which
   * sections (TEXT/SCENE/METADATA) per page. Idempotent — only runs once.
   * Called when the FIXES REQUIRED block is complete (signaled by the next
   * top-level marker arriving: ---TITLE--- or ---STORY PAGES---).
   * @private
   */
  _ensurePatchedPageNumbers() {
    if (this._patchedPageNumbers !== null) return this._patchedPageNumbers;

    // Find the FIXES REQUIRED block in the analysis
    const fixesMatch = this.fullText.match(/\*{0,2}FIXES\s+REQUIRED\*{0,2}\s*[:\n]([\s\S]*?)(?=---\s*(?:TITLE|STORY\s+PAGES)\s*---|$)/i);
    if (!fixesMatch) {
      // No FIXES REQUIRED block found yet — leave as null so we don't lock in.
      return null;
    }

    const block = fixesMatch[1];
    const numbers = new Set();
    // Match "Pages 2,3,5: TEXT,SCENE: ..." or "Pages 5: ..." (with or without leading dash/bullet)
    const linePattern = /^[\s\-*•]*Pages?\s+([\d,\s]+?)\s*:/gim;
    let m;
    while ((m = linePattern.exec(block)) !== null) {
      const list = m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
      for (const n of list) numbers.add(n);
    }

    this._patchedPageNumbers = numbers;
    log.debug(`🌊 [STREAM-UNIFIED] Patched pages from FIXES REQUIRED: ${[...numbers].sort((a, b) => a - b).join(',') || 'none'}`);
    return numbers;
  }

  /**
   * Emit a draft-only (unpatched) page immediately so downstream work
   * (scene expansion, image generation) can start in parallel with the
   * remaining stream. Called for each pageNumber NOT in _patchedPageNumbers
   * once ---STORY PAGES--- arrives.
   * @private
   */
  _emitDraftOnlyPage(pageNumber, draft) {
    if (this.emitted.pages.has(pageNumber)) return;
    this.emitted.pages.add(pageNumber);

    const text = draft.text || '';
    const sceneProse = draft.sceneProse || '';
    const sceneHint = draft.sceneHint || '';
    const { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(draft.content || '');

    log.debug(`🌊 [STREAM-UNIFIED] Page ${pageNumber} draft-only emit (no patch — text=${text.length}, prose=${sceneProse.length}, hint=${sceneHint.length})`);

    if (this.callbacks.onPageComplete) {
      this.callbacks.onPageComplete({
        pageNumber,
        text,
        sceneHint,
        sceneProse,
        characterClothing,
        characterPerspectives,
        characters
      });
    }
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress('page', `Page ${pageNumber} ready (no fixes)`, pageNumber);
    }
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

    const sectionMatch = this.fullText.match(/---\s*TITLE\s*---\s*([\s\S]*?)(?=---\s*(?:CLOTHING|VISUAL))/i);
    const section = sectionMatch ? sectionMatch[1] : null;
    if (!section) return;

    let title = null;

    // Prefer TITLE_CANDIDATES list and pick one at random — same logic as the
    // unified parser. The model would otherwise converge on the most-iconic
    // candidate every run, and even when it does emit a TITLE: line we want
    // server-side variety, not its preference.
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
        // Deterministic pick — see comment in unified.js. Both parsers must
        // pick the same title or the cover image (built from this pick) and
        // the saved story title (built from the unified parser's pick) will
        // diverge.
        const { stableCandidateIndex } = require('./shared');
        title = candidates[stableCandidateIndex(candidates)];
        log.info(`🌊 [STREAM-UNIFIED] Title picked (stable) from ${candidates.length} candidates: "${title}"`);
      }
    }

    // Fallback: legacy `TITLE: <value>` line (older runs / partial outputs).
    if (!title) {
      const titleLineMatch = section.match(/^\s*(?:\*{1,2})?\s*TITLE(?!_)\s*:\s*(.+?)\s*(?:\*{1,2})?\s*$/im);
      if (titleLineMatch) {
        title = titleLineMatch[1].trim()
          .replace(/^\*{1,2}|\*{1,2}$/g, '')
          .replace(/^"|"$/g, '')
          .trim();
        log.debug(`🌊 [STREAM-UNIFIED] Title (legacy single-line): "${title}"`);
      }
    }

    if (title) {
      this.emitted.title = true;
      if (this.callbacks.onTitle) this.callbacks.onTitle(title);
      if (this.callbacks.onProgress) this.callbacks.onProgress('title', `Story title: "${title}"`);
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
   * Check for newly completed story pages.
   *
   * With the patch-based prompt, this does three things:
   * 1. As soon as ---STORY PAGES--- arrives, the DRAFT and ANALYSIS are both
   *    complete. We parse the draft into a per-page map and parse the
   *    FIXES REQUIRED list to learn which pages have patches.
   * 2. For pages NOT in the patch set, we emit immediately from the draft so
   *    scene expansion / image generation can start in parallel with the
   *    rest of the stream.
   * 3. For pages IN the patch set, we wait for their `--- Page N ---` block
   *    to be complete in STORY PAGES, then merge the patch sections onto the
   *    draft and emit.
   */
  _checkPages() {
    if (!this._hasMarker('STORY PAGES')) return;

    // Step 1: Hydrate caches from buffered text (idempotent).
    const draftPages = this._ensureDraftPages();
    const patchedSet = this._ensurePatchedPageNumbers();

    // Step 2: Eagerly emit any draft-only pages we now know are unpatched.
    // Only do this if FIXES REQUIRED was successfully parsed AND we have draft
    // data — otherwise fall through to the legacy per-block path so legacy
    // (full-rewrite) responses still parse.
    if (patchedSet !== null && draftPages.size > 0) {
      for (const [pageNum, draft] of draftPages.entries()) {
        if (!patchedSet.has(pageNum) && !this.emitted.pages.has(pageNum)) {
          this._emitDraftOnlyPage(pageNum, draft);
        }
      }
    }

    // Step 3: Find page blocks in STORY PAGES and emit when each is complete.
    // Restrict the search to the STORY PAGES section so we don't pick up the
    // draft's `**Draft N**` blocks.
    const storyPagesIdx = this.fullText.indexOf('---STORY PAGES---');
    const pagesText = storyPagesIdx === -1 ? this.fullText : this.fullText.substring(storyPagesIdx);
    const baseOffset = storyPagesIdx === -1 ? 0 : storyPagesIdx;

    const pagePattern = /---\s*(?:Page|Seite|Página|Pagina)\s+(\d+)\s*---\s*([\s\S]*?)(?=---\s*(?:Page|Seite|Página|Pagina)\s+\d+\s*---|$)/gi;

    let match;
    while ((match = pagePattern.exec(pagesText)) !== null) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      // Skip if already emitted (either as draft-only or as a previous patch).
      if (this.emitted.pages.has(pageNum)) continue;

      // A patch page block is "complete" when we know no more content will
      // arrive in it. That's true if the next page marker appears later in
      // the buffer, or the FINAL CHECKLIST marker appears, or finalize() ran.
      const nextPageRegex = new RegExp(`---\\s*(?:Page|Seite|Página|Pagina)\\s+\\d+\\s*---`, 'g');
      nextPageRegex.lastIndex = match.index + match[0].length;
      const nextPageMatch = nextPageRegex.exec(pagesText);
      const hasNextPage = !!nextPageMatch;
      const hasFinalChecklist = /#\s*FINAL\s+CHECKLIST/i.test(pagesText.substring(match.index));
      const isLastBlock = !hasNextPage;

      // For a patch page, ANY labeled section (TEXT/SCENE/METADATA) qualifies
      // as a useful patch. We don't require all three.
      const hasAnySection = /(?:^|\n)\s*(?:TEXT|SCENE|METADATA|SCENE HINT)\s*:/i.test(content);
      if (!hasAnySection) continue;

      const blockComplete = hasNextPage || hasFinalChecklist || this._finalized;
      if (!blockComplete) continue;

      // Parse the patch sections (any subset may be present). Pure module helper.
      const patch = parsePatchSections(content);

      // Merge with the draft for this page (if available).
      const draft = draftPages.get(pageNum) || { text: '', sceneProse: '', sceneHint: '', content: '' };
      const text = patch.text || draft.text;
      const sceneProse = patch.sceneProse || draft.sceneProse;
      const sceneHint = patch.sceneHint || draft.sceneHint;
      const mergedContent = `${draft.content || ''}\n${content}`;
      const { characterClothing, characterPerspectives, characters } = parseCharacterClothingBlock(mergedContent);

      this.emitted.pages.add(pageNum);
      const clothingStr = Object.keys(characterClothing).length > 0
        ? Object.entries(characterClothing).map(([n, c]) => `${n}:${c}`).join(', ')
        : 'none';
      const sectionsPatched = [
        patch.text ? 'TEXT' : null,
        patch.sceneProse ? 'SCENE' : null,
        patch.sceneHint ? 'METADATA' : null
      ].filter(Boolean).join('+') || '(none)';
      log.debug(`🌊 [STREAM-UNIFIED] Page ${pageNum} patch-merged (patched=${sectionsPatched}, prose=${sceneProse.length} chars, clothing=${clothingStr})`);

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
        this.callbacks.onProgress('page', `Page ${pageNum} patched (${sectionsPatched})`, pageNum);
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

    // Expected path when the writer didn't need to patch a page: the page
    // never appears in STORY PAGES because the draft was already final.
    // Emit the draft content so all pages are accounted for.
    const draftPages = this._ensureDraftPages();
    for (const [pageNum, draft] of draftPages.entries()) {
      if (!this.emitted.pages.has(pageNum)) {
        log.debug(`[STREAM-UNIFIED] Page ${pageNum}: using draft (no patch needed in STORY PAGES)`);
        this._emitDraftOnlyPage(pageNum, draft);
      }
    }

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

module.exports = { ProgressiveUnifiedParser };
