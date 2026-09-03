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
  frontCover: ['Title Page', 'Titelseite', 'Page de titre'],
  initialPage: ['Initial Page', 'Einführungsseite', 'Page initiale'],
  visualBible: ['Visual Bible', 'Visuelle Bibel', 'Bible Visuelle'],
  primaryClothing: ['Primary Clothing', 'Hauptkleidung', 'Tenue principale'],
  clothingChange: ['Clothing Change', 'Kleidungswechsel', 'Changement de tenue'],
  pageByPage: ['Page-by-Page', 'Seitenweise', 'Page par page'],
};

// Clothing categories (same across languages). 'formal' was a legacy
// category, fully removed Phase 5. 'costumed' is the bare key — no subtype.
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
      const gazesMatch = obj.match(/"(?:gazesAt|gazes_at|gazes at|gaze)"\s*:\s*"([^"]+)"/);
      if (gazesMatch) annotations.gazesAt = gazesMatch[1].trim();
      const priorityMatch = obj.match(/"priority"\s*:\s*"([^"]+)"/);
      if (priorityMatch) annotations.priority = priorityMatch[1].trim();
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
    // Annotations after clothing: depth / perspective / position / holds / gazes at / priority.
    // "gazes at" has a space inside the key — regex matches both with and without space.
    // Clothing tokens: bare `standard|winter|summer|formal|costumed` OR
    // `costumed:type` / `costumed:{type with spaces}`. The cover-hints prompt
    // (prompts/story-unified.txt §COVER SCENE HINTS) instructs Sonnet to use
    // bare `costumed`; earlier the regex required `costumed:something`, so
    // every cover character line that used bare `costumed` failed the match
    // → characters[] stayed empty → buildCoverSceneFromHint produced nothing
    // → boilerplate fallback fired on every cover. Making the `:type` suffix
    // optional fixes that without affecting scene hints that DO carry typed
    // costumed values.
    const linePattern = /(?:^|,\s*)[-*]?\s*([^(:\r\n]+(?:\([^)]*\))?[^:\r\n]*):\s*(standard|winter|summer|formal|costumed(?::(?:\{[^}]*\}|[^\r\n,]+?))?)((?:\s*,\s*(?:depth|perspective|position|holds|holding|gazes\s+at|gaze|priority)\s*:\s*[^,\r\n]+)*)/gim;
    // Annotation keys Claude may slip into the line (e.g. "depth: foreground", "perspective: side", "holds: book", "gazes at: chest", "priority: essential").
    // We never want these mistaken for character names — they should be silently dropped.
    const ANNOTATION_KEYS = new Set(['depth', 'perspective', 'position', 'pose', 'view', 'shot', 'action', 'holds', 'holding', 'gazes', 'gaze', 'priority', 'mood']);
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
      // Parse trailing annotations like ", depth: background, perspective: back view, holds: book + wand, gazes at: the tower, priority: essential"
      if (annotationsRaw) {
        const annotations = {};
        const annotationPattern = /(depth|perspective|position|holds|holding|gazes\s+at|gaze|priority)\s*:\s*([^,\r\n]+)/gi;
        let annMatch;
        while ((annMatch = annotationPattern.exec(annotationsRaw)) !== null) {
          let key = annMatch[1].toLowerCase().replace(/\s+/g, ' ');
          if (key === 'holding') key = 'holds';
          if (key === 'gazes at' || key === 'gaze') key = 'gazesAt';
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
 * Strip the non-story noise Sonnet emits around page TEXT:
 *   - leading section-header annotations: `*(Page 5 — close-up …)*`
 *   - the word-count line in ANY language: `*(Word count: 111)*`,
 *     `*(Wortanzahl: 115)*`, `*(Nombre de mots : 90)*`
 *   - bare `---` page separators that the lazy TEXT capture runs into on the
 *     last page (the TEXT stop only catches `--- Page N`, not a bare `---`)
 *   - leaked Visual-Bible ids `[ART001]`
 *
 * Robust to ordering: a `*(…)*` block followed by a trailing `---` (the exact
 * shape that leaked on job_1781310332569 p14) is fully removed because the
 * separators are stripped first, then the meta block, then again at end.
 */
function cleanPageText(s) {
  if (typeof s !== 'string') return s;
  return s.trim()
    .replace(/^TEXT:\s*/i, '')
    // trailing bare `---`/`***` separators (with any surrounding blank lines)
    .replace(/(?:\s*\n)+\s*[-*_]{3,}\s*$/g, '')
    // leading meta block on its own line
    .replace(/^\s*\*\([^)]*\)\*\s*\n?/g, '')
    // any meta block sitting on its own line (mid or trailing)
    .replace(/\n[ \t]*\*\([^)]*\)\*[ \t]*(?=\n|$)/g, '')
    // trailing meta block flush against the end
    .replace(/\s*\*\([^)]*\)\*\s*$/g, '')
    // trailing separators again, in case a meta block sat between text and `---`
    .replace(/(?:\s*\n)+\s*[-*_]{3,}\s*$/g, '')
    .replace(/\s*\[[A-Z]{2,3}\d{3}\]/g, '')
    .trim();
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
    text = m ? cleanPageText(m[1]) : '';
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
  // Stop at the FIRST word-count marker in any language, or a section label.
  const stopMatch = content.match(/(\*\(\s*(?:Word count|Wortanzahl|Nombre de mots|Conteggio parole)|SCENE:|METADATA:|SCENE HINT:)/i);
  const stopIndex = stopMatch ? stopMatch.index : content.length;
  const text = cleanPageText(content.substring(0, stopIndex));

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

// ── Scene-first variant (image-first prompt, 2026-07-31) ────────────────────
// The image-first template authors ALL scene work — full SCENE prose +
// METADATA JSON per page — in a dedicated `---SCENE PAGES---` section (after
// the SCENE SEQUENCE critique locks the designs), and the STORY DRAFT then
// carries page TEXT only. The response-format DETECTION is the presence of
// the `---SCENE PAGES---` marker: when absent, parsing is byte-identical to
// the original format (verbatim-duplication of scene blocks into the draft is
// banned — owner decision).
const SCENE_PAGES_MARKER_RE = /---\s*SCENE\s+PAGES\s*---/i;
// Per-page headers inside the SCENE PAGES section: `**Scene 1**`, `Scene 1`,
// `### Scene Page 1`, DE variants — same tolerance as DRAFT_HEADER_RE.
const SCENE_PAGE_HEADER_RE = /^\s*(?:#{1,3}\s*)?\*{0,2}\s*Scene\s*(?:Page|Seite|Página|Pagina)?\s*\[?\s*(\d+)\s*\]?\s*[:\-—]?\s*\*{0,2}\s*$/gim;

/**
 * Extract per-page scene blocks (SCENE prose + METADATA JSON) from the
 * `---SCENE PAGES---` section of a scene-first variant response. Returns an
 * empty Map when the marker is absent (original format — no behavior change).
 * Pure function — returns a fresh Map each call.
 *
 * @param {string} response - Full unified-story response text
 * @returns {Map<number, {sceneProse: string, sceneHint: string, content: string}>}
 */
function extractScenePagesFromText(response) {
  const map = new Map();
  if (!response) return map;

  const markerMatch = response.match(SCENE_PAGES_MARKER_RE);
  if (!markerMatch) return map;

  const sectionStart = markerMatch.index + markerMatch[0].length;
  const tail = response.substring(sectionStart);
  // Section ends at the next top-level section marker (---STORY DRAFT---
  // normally; be tolerant of a skipped draft section).
  const endMatch = tail.match(/---\s*(?:STORY\s+DRAFT|ANALYSIS|TITLE|CLOTHING\s+REQUIREMENTS|VISUAL\s+BIBLE|COVER\s+SCENE\s+HINTS|STORY\s+PAGES)\s*---/i);
  const section = endMatch ? tail.substring(0, endMatch.index) : tail;

  SCENE_PAGE_HEADER_RE.lastIndex = 0;
  const headers = [];
  let m;
  while ((m = SCENE_PAGE_HEADER_RE.exec(section)) !== null) {
    headers.push({ pageNumber: parseInt(m[1], 10), index: m.index, headerEnd: m.index + m[0].length });
  }

  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const nextIndex = i + 1 < headers.length ? headers[i + 1].index : section.length;
    const content = section.substring(cur.headerEnd, nextIndex);
    // parsePatchSections extracts SCENE: prose + METADATA: JSON; there is no
    // TEXT: label in a scene block, so text comes back empty (as intended).
    const { sceneProse, sceneHint } = parsePatchSections(content);
    map.set(cur.pageNumber, { sceneProse, sceneHint, content });
  }

  return map;
}

/**
 * Extract draft-section pages from a full unified-story response.
 * Pure function — returns a fresh Map each call. Callers should cache.
 *
 * Trial stories (`prompts/story-trial.txt`) intentionally don't emit a draft
 * section — they're single-pass for speed. Callers parsing a trial response
 * pass `{ isTrial: true }` to suppress the "marker missing" warning, which
 * is otherwise correct but spurious.
 *
 * @param {string} response - Full unified-story response text
 * @param {object} [options]
 * @param {boolean} [options.isTrial=false] - true when parsing a trial-prompt response
 * @returns {Map<number, {text: string, sceneProse: string, sceneHint: string, content: string}>}
 */
function extractDraftPagesFromText(response, options = {}) {
  const map = new Map();
  if (!response) return map;
  // Trial prompts skip draft → analysis → revise by design. Don't even try
  // to scan; the patch section carries the full story.
  if (options.isTrial) return map;

  // Sonnet sometimes omits the `---STORY DRAFT---` opener and jumps
  // straight into `Draft 1` headers (observed on staging story
  // job_1778967306826_ynmt8lpwa — every page had a `Draft N` header but
  // the section marker was missing, so this parser returned zero drafts
  // and pages 1/3/4/10 ended up with empty text because their patch
  // section was also empty). Fall back to "start of response" when the
  // marker is missing so the Draft headers still get picked up.
  const markedStart = response.search(/---\s*STORY\s+DRAFT\s*---/i);
  const draftStart = markedStart >= 0 ? markedStart : 0;

  // Draft section ends at ---ANALYSIS---, ---TITLE---, or ---STORY PAGES---
  // (whichever comes first).
  const tail = response.substring(draftStart);
  const endMatch = tail.match(/---\s*(?:ANALYSIS|TITLE|STORY\s+PAGES)\s*---/i);
  const draftSection = endMatch ? tail.substring(0, endMatch.index) : tail;
  if (markedStart === -1) {
    log.warn(`[UNIFIED-PARSER] ---STORY DRAFT--- marker missing; scanning ${draftSection.length} chars for Draft N headers as fallback`);
  }

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

  // Scene-first variant merge (format-detected by the ---SCENE PAGES---
  // marker; a no-op for the original format). The scene section supplies
  // sceneProse + sceneHint for pages whose draft carries text only; the
  // scene block's content is appended so the METADATA `"characters":[...]`
  // clothing parse keeps working on the merged content. A draft's own scene
  // sections (model duplicated despite instructions) win — they sit closer
  // to the final text, matching the later-wins patch philosophy.
  const scenePages = extractScenePagesFromText(response);
  if (scenePages.size > 0) {
    for (const [pageNumber, scene] of scenePages.entries()) {
      const draft = map.get(pageNumber);
      if (draft) {
        map.set(pageNumber, {
          text: draft.text,
          sceneProse: draft.sceneProse || scene.sceneProse,
          sceneHint: draft.sceneHint || scene.sceneHint,
          content: `${draft.content || ''}\n${scene.content || ''}`,
        });
      } else {
        // Scene authored but the draft block is missing (truncated/omitted):
        // keep the scene so the page still renders; text may come from a patch.
        map.set(pageNumber, { text: '', sceneProse: scene.sceneProse, sceneHint: scene.sceneHint, content: scene.content || '' });
      }
    }
    log.debug(`[UNIFIED-PARSER] Scene-first format: merged ${scenePages.size} SCENE PAGES blocks into ${map.size} pages`);
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
// VISUAL BIBLE AUTHORING-CONTRACT AUDIT (tripwire, WARN only)
// ============================================================================

// Two authoring gaps that reached the illustrator on staging
// job_1788380714660_4p9mr11xszu and cost 6 of 8 serious page failures:
//
//   1. CHR001's prose never stated her sex ("tall, broad-shouldered, sturdy,
//      square jaw, no facial hair") — the image model rendered a man on three
//      pages. The prompt now requires sex + apparent age in the first sentence.
//   2. VEH001 declared appearsInPages 1-16 although the story moves inland at
//      mid-book, so the vantage-plate builder baked the vessel into two inland
//      hillside scenes. The prompt now requires an earned range.
//
// This audit only REPORTS. It never fails a story, never triggers a
// regeneration, and never edits an entry: the fix belongs in the authoring
// prompt, and a warning is how we find out the prompt slipped again.

const VB_SEX_INDICATOR = /\b(?:sex|female|male|wom[ae]n|girl|lady|ladies|mother|mum|mom|grandmother|grandma|aunt|sister|daughter|wife|widow|she|her|hers|herself|m[ae]n|boy|lad|guy|gentleman|father|dad|grandfather|grandpa|uncle|brother|son|husband|widower|he|him|his|himself)\b/i;

const VB_AGE_INDICATOR = /\b(?:\d{1,3}\s*(?:-|\s)?(?:year|yr)s?(?:\s*-?\s*old)?|aged\s+\d{1,3}|baby|infant|toddler|child|kid|boy|girl|youngster|teen|teenager|teenaged|adolescent|youth|young|adult|grown|middle-aged|mature|elderly|old|older|aging|ageing|senior|elder|twenties|thirties|forties|fifties|sixties|seventies|eighties|nineties)\b/i;

// Fields that carry authored prose. `name` is deliberately excluded: a name is
// not a statement of sex, and "Rossa"/"Mrs Baker" must not satisfy the rule.
const VB_PROSE_FIELDS = ['description', 'age', 'build', 'face', 'hair', 'signatureLook', 'clothing', 'features', 'type', 'setting'];

const VB_CATEGORIES = ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles', 'clothing'];

/** Prose an entry actually authored, joined for indicator matching. */
function vbEntryProse(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return VB_PROSE_FIELDS
    .map(f => (typeof entry[f] === 'string' ? entry[f] : ''))
    .filter(Boolean)
    .join('. ');
}

/**
 * Audit a parsed Visual Bible against the authoring contract.
 *
 * @param {Object|null} visualBible - parsed VB, entries already normalized to `appearsInPages`
 * @param {Object} [options]
 * @param {number} [options.pageCount] - story page count; derived from the
 *   highest page any entry references when the caller does not know it.
 * @param {number} [options.blanketRatio=0.9] - a range covering more than this
 *   share of the story's pages is reported as unearned.
 * @returns {Array<{code: string, id: string, category: string, message: string}>}
 */
function auditVisualBibleContract(visualBible, options = {}) {
  const findings = [];
  if (!visualBible || typeof visualBible !== 'object') return findings;

  const blanketRatio = typeof options.blanketRatio === 'number' ? options.blanketRatio : 0.9;
  const entriesOf = (cat) =>
    (Array.isArray(visualBible[cat]) ? visualBible[cat] : []).filter(e => e && typeof e === 'object');
  const pagesOf = (entry) => (Array.isArray(entry?.appearsInPages) ? entry.appearsInPages : []);

  // Page count: the caller's if known, else the highest page the VB references
  // (vantage `pages` included — a location's span lives there).
  let pageCount = Number(options.pageCount) || 0;
  if (!pageCount) {
    for (const cat of VB_CATEGORIES) {
      for (const entry of entriesOf(cat)) {
        for (const p of pagesOf(entry)) {
          if (Number.isFinite(p) && p > pageCount) pageCount = p;
        }
        for (const v of Array.isArray(entry?.vantages) ? entry.vantages : []) {
          for (const p of Array.isArray(v?.pages) ? v.pages : []) {
            if (Number.isFinite(p) && p > pageCount) pageCount = p;
          }
        }
      }
    }
  }

  // (1) Every secondary-character entry states sex and apparent age.
  for (const entry of entriesOf('secondaryCharacters')) {
    const prose = vbEntryProse(entry);
    const missing = [];
    if (!VB_SEX_INDICATOR.test(prose)) missing.push('sex');
    if (!VB_AGE_INDICATOR.test(prose)) missing.push('apparent age');
    if (missing.length) {
      findings.push({
        code: 'character-missing-sex-or-age',
        id: entry?.id || entry?.name || '(unnamed)',
        category: 'secondaryCharacters',
        message: `${entry?.id || '(no id)'} "${entry?.name || '(unnamed)'}" states no ${missing.join(' and no ')} — the image model will guess`,
      });
    }
  }

  // (2) A range covering nearly the whole book was almost certainly not earned.
  // A genuinely single-setting story can trip this on its one location; the
  // warning is a prompt for a human look, not a defect claim.
  if (pageCount >= 4) {
    for (const cat of VB_CATEGORIES) {
      for (const entry of entriesOf(cat)) {
        const pages = pagesOf(entry);
        const covered = new Set(pages.filter(p => Number.isFinite(p))).size;
        if (covered > pageCount * blanketRatio) {
          findings.push({
            code: 'blanket-appears-in-pages',
            id: entry?.id || entry?.name || '(unnamed)',
            category: cat,
            message: `${entry?.id || '(no id)'} "${entry?.name || '(unnamed)'}" claims ${covered} of ${pageCount} pages — a blanket range bakes the element into scenes that never contain it`,
          });
        }
      }
    }
  }

  return findings;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  log,
  KEYWORDS,
  CLOTHING_CATEGORIES,
  auditVisualBibleContract,
  vbEntryProse,
  parseCharacterClothingBlock,
  cleanPageText,
  parsePatchSections,
  parseDraftSections,
  extractDraftPagesFromText,
  extractScenePagesFromText,
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
