/**
 * Unified Outline Parser
 *
 * Centralizes all extraction logic for story outlines with consistent
 * multilingual support (English, German, French).
 */

const { log } = require('../../utils/logger');

// Lazy-load to avoid circular dependency (storyHelpers imports outlineParser)
let _extractJsonFromText = null;
function getExtractJsonFromText() {
  if (!_extractJsonFromText) {
    _extractJsonFromText = require('../storyHelpers').extractJsonFromText;
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
// PAGE-BLOCK SECTION PARSING - Used by UnifiedStoryParser and the streaming
// parser. These helpers split a single page block into TEXT / SCENE / METADATA
// sections; they are pure functions of their input string.
// ============================================================================

// Terminator lookahead for TEXT/SCENE inside a page block.
// End-of-string is expressed as `(?![\s\S])` rather than `$`, because `$` under
// the `m` flag matches end-of-LINE — which combined with lazy `[\s\S]*?` truncates
// any TEXT/SCENE patch at its first line break (only paragraph 1 was being kept).
const PAGE_SECTION_END = '(?=SCENE:|METADATA:|SCENE HINT:|---\\s*(?:Page|Seite|Página|Pagina)|^#\\s+FINAL|^#\\s+\\w|(?![\\s\\S]))';

const TEXT_RE = new RegExp(`TEXT:\\s*([\\s\\S]*?)${PAGE_SECTION_END}`, 'im');
const SCENE_RE = new RegExp(`SCENE:\\s*([\\s\\S]*?)${PAGE_SECTION_END}`, 'im');
const METADATA_LABEL_RE = /METADATA:\s*(?:```json\s*\n?)?\s*/im;
const SCENE_HINT_LABEL_RE = /SCENE HINT:\s*(?:```json\s*\n?)?\s*/im;
const SCENE_HINT_TEXT_RE = /SCENE HINT:\s*([\s\S]*?)(?=^Characters(?:\s*\([^)]*\))?:|---\s*(?:Page|Seite|Página|Pagina)|^#\s+FINAL|$)/im;
const HAS_TEXT_LABEL_RE = /^\s*TEXT\s*:/im;

/**
 * Extract a balanced JSON object starting at the first `{` at-or-after `startIdx`.
 * Tracks string state (with backslash escapes) so that braces inside strings
 * don't affect depth. Returns the captured substring (including outer braces)
 * or null if no balanced object is found.
 *
 * Replaces a regex-based capture that broke because the terminator lookahead
 * used `$` under the `m` flag — any inner `}` at end-of-line satisfied the
 * lookahead and truncated the captured JSON mid-array.
 */
function extractBalancedJsonObject(text, startIdx = 0) {
  if (!text || typeof text !== 'string') return null;
  const open = text.indexOf('{', startIdx);
  if (open === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(open, i + 1);
    }
  }
  // Unclosed — return what we have so the caller can hand it to a tolerant
  // JSON extractor. JSON.parse will fail, but extractJsonFromText may still
  // recover usable fields, and the loud-log fallback can show the prose.
  return depth > 0 ? text.substring(open) : null;
}

/**
 * Pick a stable index into a candidates list using a hash of the joined
 * candidates as the seed. The progressive (streaming) parser and the final
 * unified parser both read the SAME `TITLE_CANDIDATES` block, but each used
 * `Math.random()` independently — so they picked different titles. The cover
 * gen used the streaming pick; the saved story title used the parser pick;
 * the cover and the title diverged.
 *
 * djb2 hash of `candidates.join('|')` → modulo length. Same input → same
 * output across both call sites and across replays. Different candidate lists
 * (different stories) still produce different picks, so the variety the
 * randomised pick was added for is preserved.
 *
 * @param {string[]} candidates - non-empty array
 * @returns {number} index in [0, candidates.length)
 */
function stableCandidateIndex(candidates) {
  const seed = candidates.join('|');
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) + h) + seed.charCodeAt(i);
    h = h & h;  // force 32-bit
  }
  return Math.abs(h) % candidates.length;
}

/**
 * Parse a labeled patch page block (TEXT / SCENE / METADATA, any subset).
 * Empty string for any section absent from the patch — the caller should
 * fall back to the draft for those sections.
 * @param {string} content - Page block content (after the `--- Page N ---` header)
 * @returns {{text: string, sceneProse: string, sceneHint: string}}
 */
function parsePatchSections(content) {
  let text = '';
  if (HAS_TEXT_LABEL_RE.test(content)) {
    const m = content.match(TEXT_RE);
    // Strip Sonnet's *(meta-comment)* annotations from BOTH ends of the page
    // text. Trailing was already covered (word counts); leading wasn't, so
    // section headers like "*(Page 5 — close-up, 1 char, Lukas nach dem
    // Schuss)*" leaked into the printed page.
    text = m ? m[1].trim()
      .replace(/^\s*\*\([^)]*\)\*\s*/g, '')
      .replace(/\s*\*\([^)]*\)\*\s*$/g, '')
      .replace(/\s*\[[A-Z]{2,3}\d{3}\]/g, '')
      .trim() : '';
  }

  let sceneProse = '';
  const sceneM = content.match(SCENE_RE);
  if (sceneM && sceneM[1].trim().length > 0) {
    sceneProse = sceneM[1].trim().replace(/```[\s\S]*?```/g, '').trim();
  }

  let sceneHint = '';
  const metaLabelM = content.match(METADATA_LABEL_RE);
  if (metaLabelM) {
    const labelEnd = metaLabelM.index + metaLabelM[0].length;
    const json = extractBalancedJsonObject(content, labelEnd);
    if (json) sceneHint = json.trim();
  }
  if (!sceneHint) {
    const hintLabelM = content.match(SCENE_HINT_LABEL_RE);
    if (hintLabelM) {
      const labelEnd = hintLabelM.index + hintLabelM[0].length;
      const json = extractBalancedJsonObject(content, labelEnd);
      if (json) sceneHint = json.trim();
    }
  }
  if (!sceneHint) {
    const hintTextM = content.match(SCENE_HINT_TEXT_RE);
    sceneHint = hintTextM ? hintTextM[1].trim() : '';
  }

  return { text, sceneProse, sceneHint };
}

/**
 * Parse a draft block (`**Draft N**`). Story text is unlabeled — it sits
 * between the heading and either `*(Word count:` or `SCENE:`.
 * @param {string} content - Draft block content (after the `**Draft N**` header)
 * @returns {{text: string, sceneProse: string, sceneHint: string}}
 */
function parseDraftSections(content) {
  const stopMatch = content.match(/(\*\(\s*Word count:|SCENE:|METADATA:|SCENE HINT:)/i);
  const stopIndex = stopMatch ? stopMatch.index : content.length;
  const text = content.substring(0, stopIndex).trim()
    .replace(/^TEXT:\s*/i, '')
    .replace(/^\s*\*\([^)]*\)\*\s*/g, '')         // leading meta-annotation (section header)
    .replace(/\s*\*\([^)]*\)\s*\*?\s*$/g, '')     // trailing meta-annotation (word count etc.)
    .replace(/\s*\[[A-Z]{2,3}\d{3}\]/g, '')
    .trim();

  const { sceneProse, sceneHint } = parsePatchSections(content);
  return { text, sceneProse, sceneHint };
}

// Match draft headers in any of these shapes the unified writer has emitted:
//   `Draft 1`              `**Draft 1**`          `### Draft 1`
//   `Draft Page 1`         `**Draft Page 1**`     `### Draft Page 1`
//   `Draft Seite 1`        `**Draft Seite 1**`    (DE/IT/ES variants)
// The "Page/Seite/Página/Pagina" word between Draft and the number is
// optional. Without this tolerance the regex matched zero drafts on stories
// where Sonnet wrote `**Draft Page N**`, dropping every draft section and
// causing pages with no patch to vanish from the final story.
const DRAFT_HEADER_RE = /^\s*(?:#{1,3}\s*)?\*{0,2}\s*Draft\s*(?:Page|Seite|Página|Pagina)?\s*\[?\s*(\d+)\s*\]?\s*[:\-—]?\s*\*{0,2}\s*$/gim;

/**
 * Extract draft-section pages from a full unified-story response.
 * Pure function — returns a fresh Map each call. Callers should cache.
 * @param {string} response - Full unified-story response text
 * @returns {Map<number, {text: string, sceneProse: string, sceneHint: string, content: string}>}
 */
function extractDraftPagesFromText(response) {
  const map = new Map();
  if (!response) return map;

  const draftStart = response.search(/---\s*STORY\s+DRAFT\s*---/i);
  if (draftStart === -1) return map;

  // Draft section ends at ---ANALYSIS---, ---TITLE---, or ---STORY PAGES---
  // (whichever comes first).
  const tail = response.substring(draftStart);
  const endMatch = tail.match(/---\s*(?:ANALYSIS|TITLE|STORY\s+PAGES)\s*---/i);
  const draftSection = endMatch ? tail.substring(0, endMatch.index) : tail;

  // Reset lastIndex on the shared regex (it's `g`-flagged).
  DRAFT_HEADER_RE.lastIndex = 0;
  const headerMatches = [];
  let m;
  while ((m = DRAFT_HEADER_RE.exec(draftSection)) !== null) {
    headerMatches.push({ pageNumber: parseInt(m[1], 10), index: m.index, headerEnd: m.index + m[0].length });
  }

  for (let i = 0; i < headerMatches.length; i++) {
    const cur = headerMatches[i];
    const nextIndex = i + 1 < headerMatches.length ? headerMatches[i + 1].index : draftSection.length;
    const content = draftSection.substring(cur.headerEnd, nextIndex);
    const { text, sceneProse, sceneHint } = parseDraftSections(content);
    map.set(cur.pageNumber, { text, sceneProse, sceneHint, content });
  }

  return map;
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
// EXPORTS
// ============================================================================

module.exports = {
  log,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  parseCharacterClothingBlock,
  parsePatchSections,
  parseDraftSections,
  extractDraftPagesFromText,
  stableCandidateIndex,
  keywordPattern,
  createPageHeaderPattern,
  createSectionPattern,
  PAGE_HEADER_PATTERN,
  TITLE_HEADER_PATTERN,
  CLOTHING_CATEGORY_PATTERN,
  extractCharacterNamesFromScene,
  getExtractJsonFromText,
};
