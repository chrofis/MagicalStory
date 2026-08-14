// sceneMetadata.js — scene/page metadata parsers, position handling, page-text helpers.
// Extracted verbatim from storyHelpers.js (docs/plans/storyhelpers-split.md, Wave 2).
// storyHelpers.js re-exports everything here — importers keep requiring storyHelpers.
// This module depends on no other storyHelpers bucket (leaf of the split DAG).

const { log } = require('../utils/logger');
const { OutlineParser, extractCharacterNamesFromScene } = require('./outlineParser');

/**
 * Extract JSON object from a string that may have text before/after it or be wrapped in code blocks
 * @param {string} text - Raw text that may contain JSON
 * @returns {Object|null} Parsed JSON object or null if not found
 */
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  let jsonToParse = text.trim();

  // Fix common AI quirk: doubled opening braces {{ → {
  // The closing brace may not be doubled (e.g., {{"scene":{...}} has 2 open, 1 close)
  // Also fix :{{"key" → :{"key" mid-string
  jsonToParse = jsonToParse.replace(/^\{\{(?=\s*")/,  '{');
  jsonToParse = jsonToParse.replace(/:\s*\{\{(?=\s*")/g, ':{');
  // If we stripped an opening brace but the JSON now has unbalanced braces, strip trailing extra }
  if (jsonToParse.endsWith('}}')) {
    // Check if braces are balanced without the extra }
    const withoutLast = jsonToParse.slice(0, -1);
    let depth = 0, inStr = false, esc = false, balanced = false;
    for (let i = 0; i < withoutLast.length; i++) {
      const ch = withoutLast[i];
      if (ch === '\\' && inStr && !esc) { esc = true; continue; }
      if (esc) { esc = false; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (!inStr) { if (ch === '{') depth++; if (ch === '}') depth--; }
    }
    if (depth === 0) jsonToParse = withoutLast;
  }

  // First, try to extract from ```json ... ``` code block
  const codeBlockMatch = jsonToParse.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    let blockContent = codeBlockMatch[1].trim();
    // Also fix doubled braces inside code blocks
    while (blockContent.startsWith('{{') && blockContent.endsWith('}}')) {
      blockContent = blockContent.slice(1, -1);
    }
    try {
      return JSON.parse(blockContent);
    } catch (e) {
      // Code block content wasn't valid JSON, continue
    }
  }

  // Try parsing the whole thing as JSON
  try {
    const parsed = JSON.parse(jsonToParse);
    // Handle double-nested scene: {"scene":{"scene":{...}}} → unwrap
    if (parsed?.scene?.scene && !parsed.scene.imageSummary && parsed.scene.scene.imageSummary) {
      return { scene: parsed.scene.scene };
    }
    return parsed;
  } catch (e) {
    // Not direct JSON, try to find JSON object
  }

  // Find the first { and try to extract a balanced JSON object
  const jsonStart = jsonToParse.indexOf('{');
  if (jsonStart === -1) return null;

  // Try progressively longer substrings starting from {
  // This handles cases where there's trailing text after the JSON
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = jsonStart; i < jsonToParse.length; i++) {
    const char = jsonToParse[i];

    if (char === '\\' && inString && !escape) {
      escape = true;
      continue;
    }

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          // Found a complete JSON object
          try {
            const parsed = JSON.parse(jsonToParse.substring(jsonStart, i + 1));
            // Handle double-nested scene: {"scene":{"scene":{...}}} → unwrap
            if (parsed?.scene?.scene && !parsed.scene.imageSummary && parsed.scene.scene.imageSummary) {
              return { scene: parsed.scene.scene };
            }
            return parsed;
          } catch (e) {
            // Not valid JSON, continue looking
          }
        }
      }
    }
  }

  return null;
}

/**
 * Drop interactions that reference characters not present in this scene.
 * Scene expansion sometimes names characters from the story text (but not the
 * scene's `characters[]`) in the `character` or `object` field — the evaluator
 * then flags every version as wrong_interaction even though the image is
 * correct. Removing those entries here makes the downstream metadata honest.
 *
 * `object` may be a plain noun (rope, ladder, stairs) — we only drop it when
 * it looks like a bare proper name not in the scene's character list.
 */
function sanitizeInteractions(rawInteractions, characterNames) {
  if (!Array.isArray(rawInteractions)) return [];
  const charSet = new Set(characterNames || []);
  const isBareProperName = (s) => /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]+$/.test(s);
  // Composite-character syntax: "Manuel + Roger" means both characters jointly
  // interact with one shared object (e.g. carrying one basket together).
  // Without this, the structured interactions[] forced one row per character
  // with the same object, which Grok rendered as N separate copies of the
  // object. Splitting on " + " lets the entry stay a single row through to
  // the EXACT POSES block while still validating that every named character
  // is in the scene.
  const splitComposite = (s) => s.split(/\s*\+\s*/).map(p => p.trim()).filter(Boolean);
  const kept = [];
  const dropped = [];
  for (const i of rawInteractions) {
    if (!i || typeof i !== 'object' || !i.character || !i.object) continue;
    const character = String(i.character).trim();
    const object = String(i.object).trim();
    const where = String(i.where || '').trim();
    const characterParts = splitComposite(character);
    const missingPart = characterParts.find(p => !charSet.has(p));
    if (characterParts.length === 0 || missingPart) {
      dropped.push(`${character}→${object} (${missingPart ? `actor "${missingPart}" absent` : 'no actor'})`);
      continue;
    }
    if (isBareProperName(object) && !charSet.has(object)) {
      dropped.push(`${character}→${object} (target absent)`);
      continue;
    }
    // Preserve priority + storyRelevant verbatim — the EXACT POSES builder
    // sorts essentials first, and the gaze-fill defaults uncovered fg/mg
    // characters to a low-priority "not at the viewer" line.
    const priority = ['essential', 'normal', 'low'].includes(String(i.priority || '').toLowerCase())
      ? String(i.priority).toLowerCase()
      : undefined;
    const storyRelevant = (i.storyRelevant === true || i.storyRelevant === false) ? i.storyRelevant : undefined;
    const out = { character, object, where };
    if (priority !== undefined) out.priority = priority;
    if (storyRelevant !== undefined) out.storyRelevant = storyRelevant;
    kept.push(out);
  }
  if (dropped.length > 0) {
    log.info(`[SCENE META] Dropped ${dropped.length} invalid interaction(s): ${dropped.join(', ')}`);
  }
  return kept;
}

/**
 * Parse prose+metadata format: natural prose followed by ---METADATA--- JSON block.
 * Returns { prose, metadata } if detected, null otherwise.
 */
function parseProseMetadataFormat(text) {
  if (!text || typeof text !== 'string') return null;
  const delimiter = '---METADATA---';
  const idx = text.indexOf(delimiter);
  if (idx === -1) return null;

  const prose = text.substring(0, idx).trim();
  const jsonPart = text.substring(idx + delimiter.length).trim();
  if (!prose || !jsonPart) return null;

  try {
    // Try direct parse first, fall back to robust extraction (handles ```json
    // code fences and trailing prose).
    let metadata;
    try {
      metadata = JSON.parse(jsonPart);
    } catch {
      metadata = extractJsonFromText(jsonPart);
    }
    if (!metadata) return null;
    // Unwrap any of the wrapper shapes Sonnet sometimes emits when the model
    // adds critique blocks alongside the scene metadata. Without this, pages
    // whose metadata looks like
    //   { "previewMismatches": [...], "checks": {...}, "scene": { "characters": [...] } }
    // fall through to the legacy JSON-format path (which DOES unwrap) and
    // lose the prose+metadata semantics — EXACT POSES never get extracted.
    if (!metadata.characters) {
      const inner = metadata.scene || metadata.output || metadata.draft
        || metadata.previewMismatches?.[0]?.scene;
      if (inner && inner.characters) {
        metadata = inner;
      }
    }
    if (!metadata.characters) return null;
    return { prose, metadata };
  } catch {
    return null;
  }
}

/**
 * 9-region position abbreviation mapping
 * Used to expand abbreviations from scene descriptions for image generation
 */
const POSITION_ABBREVIATIONS = {
  'TL': 'top-left background',
  'TC': 'top-center background',
  'TR': 'top-right background',
  'ML': 'middle-left midground',
  'MC': 'middle-center midground',
  'MR': 'middle-right midground',
  'BL': 'bottom-left foreground',
  'BC': 'bottom-center foreground',
  'BR': 'bottom-right foreground'
};

/**
 * Expand position abbreviations to full descriptions
 * Handles both standalone codes (MC) and codes in text (MC midground)
 * @param {string} position - Position string that may contain abbreviations
 * @returns {string} Position with abbreviations expanded
 */
function expandPositionAbbreviations(position) {
  if (!position || typeof position !== 'string') return position;

  // Check if the entire position is just an abbreviation
  const upperPos = position.trim().toUpperCase();
  if (POSITION_ABBREVIATIONS[upperPos]) {
    return POSITION_ABBREVIATIONS[upperPos];
  }

  // Replace abbreviations found within the position text (e.g., "MC, facing left")
  let expanded = position;
  for (const [abbrev, full] of Object.entries(POSITION_ABBREVIATIONS)) {
    // Match abbreviation as whole word (not part of another word)
    const regex = new RegExp(`\\b${abbrev}\\b`, 'gi');
    expanded = expanded.replace(regex, full);
  }

  return expanded;
}

/**
 * Strip Visual Bible entity IDs from a string. Matches both bracketed form
 * (`[LOC002]`, `[ART001.2]`) and bare form (`ART002`, `LOC003.1`). The bracketed
 * form comes from scene metadata; the bare form shows up in outline scene hints
 * where the writer references objects inline.
 *
 * These IDs are needed in scene metadata for landmark photo lookup, but they:
 *   1. confuse image generators when they leak into rendered prompts, and
 *   2. make the vision-based semantic eval report the object as "missing" or
 *      "unverifiable" because the IDs are not visible in the image.
 *
 * @param {string} str
 * @returns {string}
 */
function stripEntityIds(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    // Bracketed: "Kurpark [LOC003.2]" → "Kurpark"
    .replace(/\s*\[(?:LOC|ART|CHAR|CLO|OBJ|ANI|VEH|CHR)\d+(?:\.\d+)?\]/gi, '')
    // Bare: "grab ART003 from" → "grab  from" (then collapsed by whitespace pass)
    // Word-boundary anchored to avoid chopping off "LOCATION" or "CHARGE" etc.
    .replace(/\b(?:LOC|ART|CHAR|CLO|OBJ|ANI|VEH|CHR)\d{3,}(?:\.\d+)?\b/g, '')
    // Empty parens left behind: "( )", "(, , )", "(  , )" → ""
    .replace(/\s*\([\s,]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Format a character's holding field for the image prompt.
 *
 * The scene expander emits {leftHand, rightHand} for validation (catches 3-hand
 * errors), but that structure is too prescriptive for image models — telling
 * Gemini "left hand holds X, right hand holds Y" often produces awkward poses
 * because the model tries to force a specific hand. Instead, we merge both
 * values into a single "holding: X, Y" string so the model picks the natural
 * placement itself.
 *
 * Filters out "empty" and deduplicates exact matches so "book left edge" +
 * "book right edge" collapses to one entry.
 *
 * @param {Object} holding - {leftHand, rightHand} object from scene JSON
 * @returns {string} Merged holding description, or '' if nothing held
 */
function formatHoldingForPrompt(holding) {
  if (!holding || typeof holding !== 'object') return '';
  const values = [holding.leftHand, holding.rightHand]
    .filter(v => typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'empty')
    .map(v => stripEntityIds(v).trim());
  if (values.length === 0) return '';
  const unique = [...new Set(values)];
  return unique.join(', ');
}

/**
 * Converts the structured JSON scene to concise prose for image generation prompt
 * @param {Object} scene - The scene section from JSON scene description
 * @returns {string} Formatted prose for image prompt
 */
function buildTextFromJson(scene) {
  if (!scene) return '';

  const lines = [];

  // Main description (imageSummary is the key description)
  if (scene.imageSummary) {
    lines.push(stripEntityIds(scene.imageSummary));
  }

  // Character positions and actions (concise bullet format)
  if (scene.characters && scene.characters.length > 0) {
    lines.push('');
    for (const char of scene.characters) {
      const position = stripEntityIds(expandPositionAbbreviations(char.position) || '');
      const parts = [stripEntityIds(char.name || '') + ':'];
      if (position) parts.push(position);
      if (char.action) parts.push(stripEntityIds(char.action));
      if (char.expression) parts.push(stripEntityIds(char.expression));
      // Holding info: merge both hands' values without specifying which hand.
      // NOTE (2026-08-11 audit): current scene-expansion templates no longer
      // emit `holding` — superseded by interactions[]. This branch only fires
      // for old stories whose stored metadata still carries the field.
      const heldText = formatHoldingForPrompt(char.holding);
      if (heldText) parts.push('holding: ' + heldText);
      lines.push('- ' + parts.join(', '));
    }
  }

  // Setting summary (one line)
  if (scene.setting) {
    const settingParts = [];
    if (scene.setting.location) settingParts.push(stripEntityIds(scene.setting.location));
    if (scene.setting.description) settingParts.push(stripEntityIds(scene.setting.description));
    if (settingParts.length > 0) {
      lines.push('');
      lines.push('Setting: ' + settingParts.join('. '));
    }
    if (scene.setting.camera) {
      lines.push('Camera: ' + scene.setting.camera);
    }
    // Depth layers: tells generator what's close vs far (only when specified)
    if (scene.setting.depthLayers) {
      lines.push('Depth: ' + scene.setting.depthLayers);
    }
    // Weather visibility: prevents snow inside rooms etc. (only when relevant)
    if (scene.setting.weatherVisibility && scene.setting.weatherVisibility !== 'none' && scene.setting.weatherVisibility !== 'not applicable') {
      lines.push('Weather visibility: ' + scene.setting.weatherVisibility);
    }
  }

  // Objects (Visual Bible IDs are stripped — they confuse image generators)
  if (scene.objects && scene.objects.length > 0) {
    const objectLines = scene.objects.map(obj => {
      const cleanName = stripEntityIds(obj.name || '');
      const expandedPos = stripEntityIds(expandPositionAbbreviations(obj.position) || '');
      return `${cleanName}${expandedPos ? ': ' + expandedPos : ''}`;
    });
    if (objectLines.length > 0) {
      lines.push('');
      lines.push('Objects: ' + objectLines.join('; '));
    }
  }

  return lines.join('\n').trim();
}

/**
 * Strip JSON metadata block and translated summary from scene description (for image prompts)
 * Supports two formats:
 * 1. NEW: Full JSON - extracts output section and converts to text
 * 2. LEGACY: Markdown - removes thinking sections, JSON block, and translated summary
 * @param {string} sceneDescription - The scene description text
 * @returns {string} Clean scene description for image generation
 */
function stripSceneMetadata(sceneDescription) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return sceneDescription;

  // Try prose+metadata format first (natural prose + ---METADATA--- JSON block)
  const proseFormat = parseProseMetadataFormat(sceneDescription);
  if (proseFormat) {
    return stripEntityIds(proseFormat.prose);
  }

  // Try structured JSON format using robust extraction
  const parsed = extractJsonFromText(sceneDescription);
  // Support all wrapper formats: "scene" (critique-only), "output" (old), "draft" (unified),
  // "previewMismatches" (iteration/consistency regen), or raw
  let sceneData = parsed?.scene || parsed?.output || parsed?.draft;
  // Handle double-nesting from prefill: {"scene":{"scene":{...}}}
  if (sceneData?.scene && !sceneData.imageSummary) {
    sceneData = sceneData.scene;
  }
  // Handle previewMismatches wrapper: scene is nested inside previewMismatches[0].scene
  if (!sceneData && parsed?.previewMismatches?.[0]?.scene) {
    sceneData = parsed.previewMismatches[0].scene;
  }
  // Fallback: use parsed directly if it has scene fields
  if (!sceneData) sceneData = parsed;
  if (sceneData && (sceneData.imageSummary || sceneData.characters)) {
    // Convert structured JSON to prose for image prompt
    return buildTextFromJson(sceneData);
  }

  // LEGACY: Regex-based stripping for markdown format
  let stripped = sceneDescription;

  // Remove DRAFT section (STEP 1) - internal process, not needed for image generation
  // Handles: "# STEP 1 - DRAFT", "**STEP 1 - DRAFT**", "DRAFT:", etc.
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*1\s*[-–]\s*DRAFT:?\s*\n[\s\S]*?(?=\n#{1,3}\s*STEP\s*2|\n\*{0,2}STEP\s*2)/gi, '')
    .replace(/\n*\*{0,2}(?:STEP\s*1\s*[-–]?\s*)?DRAFT\*{0,2}:?\s*\n[\s\S]*?(?=\n\*{0,2}(?:STEP\s*2|(?:CONNECTION\s*)?REVIEW|CRITICISM))/gi, '')
    .trim();

  // Remove REVIEW / CONNECTION REVIEW / CRITICISM section (STEP 2) - internal process
  // Handles: "# STEP 2 - REVIEW", "# STEP 2 - CONNECTION REVIEW", "**STEP 2 - REVIEW:**", etc.
  // End markers: "# STEP 3", "## 1. Image", "**1. Image", "---\n## 1.", "FINAL OUTPUT", or end of string
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*2\s*[-–]\s*(?:CONNECTION\s*)?REVIEW:?\s*\n[\s\S]*?(?=\n#{1,3}\s*(?:STEP\s*3|1\.)|---\s*\n+#{1,3}\s*1\.|\n\*{0,2}(?:STEP\s*3|FINAL)|$)/gi, '')
    .replace(/\n*\*{0,2}(?:STEP\s*2\s*[-–]?\s*)?(?:(?:CONNECTION\s*)?REVIEW|CRITICISM)\*{0,2}:?\s*\n[\s\S]*?(?=\n#{1,3}\s*1\.|\n\*{0,2}(?:STEP\s*3|FINAL\s*OUTPUT|1\.\s*\*{0,2}Image)|$)/gi, '')
    .trim();

  // Remove FINAL OUTPUT header (STEP 3) - keep the content, just remove the header
  // Handles: "# STEP 3 - FINAL OUTPUT", "**FINAL OUTPUT**", etc.
  stripped = stripped
    .replace(/\n*#{1,3}\s*STEP\s*3\s*[-–]\s*FINAL\s*OUTPUT\s*\n*/gi, '\n')
    .replace(/\n*\*{0,2}(?:STEP\s*3\s*[-–]?\s*)?FINAL\s*OUTPUT\*{0,2}:?\s*\n*/gi, '\n')
    .trim();

  // Remove section header and JSON block: "5. **METADATA (JSON):**\n```json\n...\n```" or just "```json\n...\n```"
  // Also handle variations like "**METADATA:**" or just the JSON block
  stripped = stripped
    .replace(/\n*\d*\.?\s*\*{0,2}METADATA\s*\(?JSON\)?\*{0,2}:?\s*\n*```json[\s\S]*?```\n*/gi, '\n')
    .replace(/```json[\s\S]*?```\n*/gi, '')
    .trim();

  // Remove section 6 (translated summary) - redundant for image generation
  // Matches: "6. **Image Summary (Deutsch)**\n..." or "6. **Image Summary (French)**\n..." etc.
  stripped = stripped
    .replace(/\n*\d+\.?\s*\*{0,2}Image Summary\s*\([^)]+\)\*{0,2}:?\s*\n[\s\S]*$/gi, '')
    .trim();

  // Clean up malformed markdown at the start (e.g., ")**" from partial section headers)
  // This can happen when scene descriptions are incorrectly parsed or generated
  stripped = stripped
    .replace(/^[\s\n]*\)*\*{1,2}\s*/g, '') // Remove leading )** or )* with whitespace
    .replace(/^[\s\n]*\*{1,2}\)*\s*/g, '') // Remove leading **) or *)
    .trim();

  // Final pass: strip Visual Bible entity IDs (e.g., [LOC002], [ART001]) — these confuse
  // image generators. Photo lookup uses parsed scene metadata, not this rendered text.
  stripped = stripEntityIds(stripped);

  return stripped;
}

/**
 * Parse character descriptions from image prompt to extract age/gender info
 * Parses formats:
 * - Scene format: "1. Lukas, Looks: school age, 7 years old, boy, Build: ..."
 * - Cover format: "[Lukas]: Looks: school age, 7 years old, boy, Build: ... Wearing: ..."
 * @param {string} prompt - The full image generation prompt
 * @returns {Object} Map of character names to {age, gender, ageCategory, genderTerm, clothing}
 */
function parseCharacterDescriptions(prompt) {
  if (!prompt || typeof prompt !== 'string') return {};

  const characterInfo = {};
  let match;

  // Match numbered character entries (scene format):
  //   New: "1. Name, Looks: age category, gender, ..."
  //   Legacy: "1. Name, Looks: age category, X years old, gender, ..."
  const charPattern = /^\d+\.\s*([^,]+),\s*Looks:\s*([^,]+),\s*(?:(\d+)\s*years?\s*old,\s*)?(boy|girl|man|woman|child|baby|toddler|teen|teenager)/gmi;

  while ((match = charPattern.exec(prompt)) !== null) {
    const name = match[1].trim();
    const ageCategory = match[2].trim();
    const age = match[3] ? parseInt(match[3], 10) : null;
    const genderTerm = match[4].toLowerCase();

    // Map gender term to gender
    let gender = null;
    if (['boy', 'man'].includes(genderTerm)) gender = 'male';
    else if (['girl', 'woman'].includes(genderTerm)) gender = 'female';

    // Determine if child or adult
    const isChild = (age !== null && age < 18) || ['boy', 'girl', 'child', 'baby', 'toddler', 'teen', 'teenager'].includes(genderTerm);

    characterInfo[name] = {
      age,
      ageCategory,
      gender,
      isChild,
      genderTerm
    };
  }

  // Match cover/reference format:
  //   New: "[Name]: Looks: age category, gender, ..."
  //   Legacy: "[Name]: Looks: age category, X years old, gender, ..."
  // This format includes clothing after "Wearing:"
  // Note: Pattern also matches legacy "[Image N - Name]:" format for backwards compatibility
  const coverPattern = /\[(?:Image\s+\d+\s*-\s*)?([^\]]+)\]:\s*Looks:\s*([^,]+),\s*(?:(\d+)\s*years?\s*old,\s*)?(boy|girl|man|woman|little boy|little girl|teenage boy|teenage girl|young man|young woman|elderly man|elderly woman|baby boy|baby girl)([^\[]*)/gi;

  while ((match = coverPattern.exec(prompt)) !== null) {
    const name = match[1].trim();
    const ageCategory = match[2].trim();
    const age = match[3] ? parseInt(match[3], 10) : null;
    const rawGenderTerm = match[4].toLowerCase();
    const restOfLine = match[5] || '';

    // Normalize gender term (e.g., "teenage boy" -> "boy", "little girl" -> "girl")
    let genderTerm = rawGenderTerm;
    if (rawGenderTerm.includes('boy') || rawGenderTerm.includes('man')) {
      genderTerm = rawGenderTerm.includes('boy') ? 'boy' : 'man';
    } else if (rawGenderTerm.includes('girl') || rawGenderTerm.includes('woman')) {
      genderTerm = rawGenderTerm.includes('girl') ? 'girl' : 'woman';
    }

    // Map gender term to gender
    let gender = null;
    if (['boy', 'man'].includes(genderTerm)) gender = 'male';
    else if (['girl', 'woman'].includes(genderTerm)) gender = 'female';

    // Determine if child or adult
    const isChild = (age !== null && age < 18) || ['boy', 'girl', 'child', 'baby', 'toddler', 'teen', 'teenager'].includes(genderTerm);

    // Extract clothing from "Wearing:" section
    let clothing = '';
    const wearingMatch = restOfLine.match(/Wearing:\s*([^.]+)/i);
    if (wearingMatch) {
      clothing = wearingMatch[1].trim();
    }

    // Only add if not already found (scene format takes precedence)
    if (!characterInfo[name]) {
      characterInfo[name] = {
        age,
        ageCategory,
        gender,
        isChild,
        genderTerm,
        clothing
      };
    }
  }

  // If no patterns matched, try simpler pattern for older formats
  if (Object.keys(characterInfo).length === 0) {
    // Try: "Name (7 years old, boy)" or "Name, 7 years old, boy"
    const simplePattern = /([A-Z][a-z]+)[\s,]+(\d+)\s*years?\s*old,?\s*(boy|girl|man|woman)/gi;
    while ((match = simplePattern.exec(prompt)) !== null) {
      const name = match[1].trim();
      const age = parseInt(match[2], 10);
      const genderTerm = match[3].toLowerCase();
      const gender = ['boy', 'man'].includes(genderTerm) ? 'male' : 'female';
      const isChild = age < 18 || ['boy', 'girl'].includes(genderTerm);

      characterInfo[name] = { age, gender, isChild, genderTerm };
    }
  }

  return characterInfo;
}

/**
 * Enforce book-spread text position rule:
 * Odd pages (left side of spread) → must use left or full, never right.
 * Even pages (right side of spread) → must use right or full, never left.
 * Flips wrong-side positions to the correct side.
 */

function enforceSpreadTextPosition(textPosition, pageNumber) {
  if (!textPosition || !pageNumber || pageNumber < 1) return textPosition;
  const isLeftPage = pageNumber % 2 === 1;  // odd = left in spread
  if (isLeftPage && textPosition.includes('right')) {
    return textPosition.replace('right', 'left');
  }
  if (!isLeftPage && textPosition.includes('left')) {
    return textPosition.replace('left', 'right');
  }
  return textPosition;
}

/**
 * Mirror directional left↔right tokens in prose without touching non-directional
 * uses ("she left the room", "what was left", "leftover", "all right", etc.).
 *
 * Used when enforceSpreadTextPosition flips a page's textPosition to the other
 * side of the spread — the prose Sonnet wrote was anchored to the original side
 * and the empty-scene + page-image both need geometry pointing at the new side.
 *
 * Only swaps `left` / `right` when they appear in one of these directional
 * contexts:
 *   - compound corner words: `top-left`, `upper-right`, `far-left`, `mid-right`, `the right`, …
 *   - positional-noun follower: `left foreground`, `right side`, `left-hand`, …
 *   - prepositional: `to the left`, `from the right`, `into the left`, …
 *   - visual-verb + direction: `facing right`, `aiming left`, `gazes toward the right`, …
 *   - possessive + body-noun: `Roger's left arm`, `her right shoulder`, …
 *   - `leftward` / `rightward` / `leftmost` / `rightmost`
 *
 * Bare `left` and `right` outside these contexts are left alone, so verbs and
 * idioms ("she left", "what was left", "right away", "all right") survive intact.
 *
 * Casing is preserved (`LEFT` ↔ `RIGHT`, `Left` ↔ `Right`, `left` ↔ `right`).
 * Applying the function twice returns the original text.
 *
 * @param {string} text
 * @returns {string}
 */
function mirrorLeftRight(text) {
  if (!text || typeof text !== 'string') return text;

  // Sentinels avoid the "left → right → left" double-swap problem.
  const SL = '';
  const SR = '';

  const tagWord = (m) => {
    const lower = m.toLowerCase();
    const sentinel = lower === 'left' ? SL : SR;
    if (m === m.toUpperCase()) return sentinel + 'U';
    if (m[0] === m[0].toUpperCase()) return sentinel + 'C';
    return sentinel;
  };

  const POSITIONAL_NOUN = '(?:foreground|midground|background|side|half|edge|hand|flank|margin|band|strip|corner|portion|section|column|wall|panel|profile|cheek|shoulder)';
  const BODY_NOUN = '(?:hand|arm|leg|foot|feet|shoulder|knee|hip|cheek|eye|ear|side|profile|fist|wrist|elbow|ankle|finger|thumb|toe|temple)';

  const directionalRegexes = [
    // (upper|lower|top|bottom|far|center|mid|extreme) [-space] left/right
    /(?<=\b(?:upper|lower|top|bottom|far|center|centre|mid|middle|extreme)[-\s])(left|right)\b/gi,
    // left/right [-space] positional-noun
    new RegExp(`\\b(left|right)(?=[-\\s]${POSITIONAL_NOUN}\\b)`, 'gi'),
    // (to|on|from|at|toward|along|across|into|past) [the] left/right
    /(?<=\b(?:to|on|from|at|toward|towards|along|across|into|past)\s+(?:the\s+)?)(left|right)\b/gi,
    // visual-verb (+ optional preposition) + left/right
    /(?<=\b(?:looks?|looking|looked|faces?|facing|faced|aims?|aiming|aimed|points?|pointing|pointed|turns?|turning|turned|gazes?|gazing|gazed|peers?|peering|peered|leans?|leaning|leaned|tilts?|tilting|tilted|sights?|sighting|sighted|veers?|veering|veered|swerves?|swerving|swerved|drifts?|drifting|drifted|shifts?|shifting|shifted|steps?|stepping|stepped|walks?|walking|walked|runs?|running|ran|moves?|moving|moved|crouches?|crouching|crouched)\s+(?:to\s+the\s+|at\s+|toward(?:s)?\s+(?:the\s+)?)?)(left|right)\b/gi,
    // possessive + left/right + body-noun
    new RegExp(`(?<=\\b\\w+'s\\s+)(left|right)(?=\\s+${BODY_NOUN}\\b)`, 'gi'),
    // -ward / -wards / -most
    /\b(left|right)(?=(?:ward|wards|most)\b)/gi,
  ];

  let out = text;
  for (const re of directionalRegexes) {
    out = out.replace(re, tagWord);
  }
  // Resolve sentinels: `left` was tagged SL → becomes "right"; `right` was tagged SR → becomes "left".
  out = out.replace(new RegExp(SL + 'U', 'g'), 'RIGHT');
  out = out.replace(new RegExp(SR + 'U', 'g'), 'LEFT');
  out = out.replace(new RegExp(SL + 'C', 'g'), 'Right');
  out = out.replace(new RegExp(SR + 'C', 'g'), 'Left');
  out = out.replace(new RegExp(SL, 'g'), 'right');
  out = out.replace(new RegExp(SR, 'g'), 'left');
  return out;
}


/**
 * Extract metadata from scene description
 * Supports two formats:
 * 1. NEW: Full JSON with thinking.draft, thinking.review, output.* fields
 * 2. LEGACY: Markdown with embedded ```json block
 * @param {string} sceneDescription - The scene description text
 * @returns {Object|null} Parsed metadata or null if not found/invalid
 */
function extractSceneMetadata(sceneDescription) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return null;

  // Detect intent BEFORE trying the parsers — if the description carries the
  // ---METADATA--- delimiter we'll know any failure is a broken-metadata bug,
  // not "this is a different format". Used at the bottom for loud logging
  // and for the prose-recovery fallback.
  const hasProseDelim = sceneDescription.includes('---METADATA---');

  // Try prose+metadata format first (natural prose + ---METADATA--- JSON block)
  const proseFormat = parseProseMetadataFormat(sceneDescription);
  if (proseFormat) {
    const { prose, metadata } = proseFormat;
    const characterClothing = {};
    const characterPositions = {};
    const characterPerspectives = {};
    const characterNames = [];

    for (const char of metadata.characters || []) {
      if (!char.name) continue;
      characterNames.push(char.name);
      // Read position from metadata if the scene expansion emitted it (e.g.
      // "right foreground", "center background"). Falls back to empty string
      // if absent — downstream code still iterates characterPositions to know
      // which characters are in the scene, so we always include the key.
      characterPositions[char.name] = typeof char.position === 'string' ? char.position.trim() : '';
      // Clothing normalization (same logic as JSON format)
      if (char.clothing) {
        const raw = char.clothing.toLowerCase();
        const costumedMatch = raw.match(/costumed:(?!costumed)(.+)/);
        if (costumedMatch) characterClothing[char.name] = `costumed:${costumedMatch[1].trim()}`;
        else if (raw.includes('costumed')) characterClothing[char.name] = 'costumed';
        else if (raw.includes('winter')) characterClothing[char.name] = 'winter';
        else if (raw.includes('summer')) characterClothing[char.name] = 'summer';
        else characterClothing[char.name] = 'standard';
      }
      // Perspective and depth from metadata
      const annotations = {};
      if (char.perspective) annotations.perspective = String(char.perspective).toLowerCase();
      if (char.depth) annotations.depth = String(char.depth).toLowerCase();
      // Scene-composite pose + flip (consumed only when the scene-composite
      // flag is on — see server/lib/sceneComposite.js).
      if (char.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(char.pose)) {
        annotations.pose = char.pose;
      }
      if (typeof char.flip === 'boolean') annotations.flip = char.flip;
      if (Object.keys(annotations).length > 0) {
        characterPerspectives[char.name] = annotations;
      }
    }

    // Objects are string IDs in prose format (e.g., ["LOC001", "ART002"])
    const objectIds = (metadata.objects || []).filter(o => typeof o === 'string');

    // Extract landmark variants from object IDs (e.g., "LOC003.2")
    const landmarkVariants = {};
    for (const objStr of objectIds) {
      const variantMatch = objStr.match(/LOC(\d+)\.(\d+)/i);
      if (variantMatch) {
        landmarkVariants[`LOC${variantMatch[1].padStart(3, '0')}`] = parseInt(variantMatch[2]);
      }
    }

    // Scene complexity from character depth data
    let sceneComplexity = 'simple';
    if ((metadata.characters || []).some(c => (c.depth || '').toLowerCase() === 'background')) {
      sceneComplexity = 'complex';
    }

    if (Object.keys(landmarkVariants).length > 0) {
      log.info(`[SCENE META] Landmark variants (prose format): ${Object.entries(landmarkVariants).map(([id, v]) => `${id}.${v}`).join(', ')}`);
    }

    // Character interactions: structured list of character-to-object contacts
    // (held, worn, in pocket, climbed, stood on, passed through, etc).
    // Normalize + drop entries whose actor/target isn't in this scene.
    const interactions = sanitizeInteractions(metadata.interactions, characterNames);

    return {
      characters: characterNames,
      characterClothing: Object.keys(characterClothing).length > 0 ? characterClothing : null,
      characterPositions: Object.keys(characterPositions).length > 0 ? characterPositions : null,
      characterPerspectives: Object.keys(characterPerspectives).length > 0 ? characterPerspectives : null,
      clothing: null,
      objects: objectIds,
      interactions: interactions.length > 0 ? interactions : null,
      // fullData carries the metadata fields downstream consumers expect.
      // shot / setting / time / weather are added explicitly because the
      // empty-scene SHOT prefix in server.js reads `fullData.shot` and was
      // silently falling back to "wide shot" on every unified-mode page.
      fullData: {
        characters: metadata.characters,
        objects: metadata.objects,
        interactions,
        imageSummary: prose,
        shot: metadata.shot || null,
        setting: metadata.setting || null,
        // time/weather passthroughs removed 2026-08-11: written for months,
        // read by nothing (metadata-migration audit).
        background: metadata.background || null,
      },
      thinking: null,
      translatedSummary: metadata.translatedSummary || null,
      // Story era for buildEraGuard (anachronism guard) — restored 2026-08-11;
      // lost in the metadata-format migration like `shot`.
      era: metadata.era || null,
      imageSummary: prose,
      landmarkVariants: Object.keys(landmarkVariants).length > 0 ? landmarkVariants : null,
      setting: null, // Setting details are in the prose, not structured
      sceneComplexity,
      emptyScenePrompt: metadata.emptyScenePrompt || null,
      reuseEmptyScene: metadata.reuseEmptyScene ?? null,
      textPosition: metadata.textPosition || null,
      textZoneDescription: metadata.textZoneDescription || null,
      era: metadata.era || null,
      framingPattern: metadata.framingPattern || null,
      sceneIntent: metadata.sceneIntent || null,
      background: metadata.background || null,
      isJsonFormat: true,
      isProseFormat: true
    };
  }

  // Try structured JSON format using robust extraction
  const parsed = extractJsonFromText(sceneDescription);
  // Support all wrapper formats: "scene" (critique-only mode), "output" (old format), "draft" (unified prompt format),
  // "previewMismatches" (iteration/consistency regen), or raw JSON
  let parsedData = parsed?.scene || parsed?.output || parsed?.draft;
  if (!parsedData && parsed?.previewMismatches?.[0]?.scene) {
    parsedData = parsed.previewMismatches[0].scene;
  }
  if (!parsedData) parsedData = parsed;
  // Handle double-nested {scene: {scene: {...}}} from Art Director
  if (parsedData?.scene && typeof parsedData.scene === 'object' &&
      !parsedData.characters && (parsedData.scene.characters || parsedData.scene.objects || parsedData.scene.imageSummary)) {
    parsedData = parsedData.scene;
  }
  if (parsed && parsedData && parsedData.characters) {
    // Extract per-character clothing, positions, and perspective overrides
    const characterClothing = {};
    const characterPositions = {};
    const characterPerspectives = {};
    const characterNames = [];
    for (const char of parsedData.characters) {
      if (char.name) {
        characterNames.push(char.name);
        if (char.clothing) {
          // Normalize: only 4 valid categories — extract from any AI format
          const raw = char.clothing.toLowerCase();
          const costumedMatch = raw.match(/costumed:(?!costumed)(.+)/);
          if (costumedMatch) characterClothing[char.name] = `costumed:${costumedMatch[1].trim()}`;
          else if (raw.includes('costumed')) characterClothing[char.name] = 'costumed';
          else if (raw.includes('winter')) characterClothing[char.name] = 'winter';
          else if (raw.includes('summer')) characterClothing[char.name] = 'summer';
          else characterClothing[char.name] = 'standard';
        }
        if (char.position) {
          characterPositions[char.name] = char.position;
        }
        // Capture explicit perspective/depth overrides AND infer back view from pose text.
        // Scene-iteration emits perspective inside the `pose` field as natural language
        // (e.g. "Back view, seen from behind, gazing at the sea") rather than as a separate field.
        const annotations = {};
        if (char.perspective) annotations.perspective = String(char.perspective).toLowerCase();
        if (char.depth) annotations.depth = String(char.depth).toLowerCase();
        const poseLower = (char.pose || '').toLowerCase();
        if (!annotations.perspective && /\b(back view|seen from behind|from behind)\b/.test(poseLower)) {
          annotations.perspective = 'back view';
        }
        if (Object.keys(annotations).length > 0) {
          characterPerspectives[char.name] = annotations;
        }
      }
    }

    // Extract object IDs - handle both string format ("LOC001") and object format ({id, name})
    const objectIds = (parsedData.objects || []).map(obj => {
      if (typeof obj === 'string') {
        // String format: "LOC001" or "Stadtturm [LOC001]"
        return obj;
      } else if (obj && typeof obj === 'object') {
        // Object format: {id: "LOC001", name: "Stadtturm"}
        return obj.id ? `${obj.name} [${obj.id}]` : obj.name;
      }
      return null;
    }).filter(Boolean);

    // Extract per-landmark variant selections from LOC IDs like "LOC003.2"
    const landmarkVariants = {};
    for (const objStr of objectIds) {
      const variantMatch = objStr.match(/\[LOC(\d+)\.(\d+)\]/i);
      if (variantMatch) {
        landmarkVariants[`LOC${variantMatch[1].padStart(3, '0')}`] = parseInt(variantMatch[2]);
      }
    }

    // Also extract location from setting.location (e.g., "Kurpark [LOC001]" or "Kurpark [LOC001.2]")
    // This ensures landmark photos are passed to image generation
    if (parsedData.setting?.location) {
      const locMatch = parsedData.setting.location.match(/\[LOC(\d+)(?:\.(\d+))?\]/i);
      if (locMatch) {
        objectIds.push(parsedData.setting.location);
        log.debug(`[SCENE META] Found location with LOC ID: "${parsedData.setting.location}"`);
        // Extract variant from setting.location too
        const locId = `LOC${locMatch[1].padStart(3, '0')}`;
        if (locMatch[2]) {
          landmarkVariants[locId] = parseInt(locMatch[2]);
        }
      }
    }

    // Log per-landmark variant selections
    if (Object.keys(landmarkVariants).length > 0) {
      log.info(`[SCENE META] Landmark variants: ${Object.entries(landmarkVariants).map(([id, v]) => `${id}.${v}`).join(', ')}`);
    }

    // Detect scene complexity: explicit field or fallback from character positions
    // Determine scene complexity solely from character depth data.
    // Only scenes with background-depth characters need Gemini (better at placing
    // characters at different depths). Grok handles everything else fine.
    // Ignore AI-written sceneComplexity — it over-classifies busy foreground scenes as complex.
    let sceneComplexity = 'simple';
    if (parsedData.characters && Array.isArray(parsedData.characters)) {
      const hasBackgroundCharacter = parsedData.characters.some(c => {
        const pos = (c.position || '').toLowerCase();
        const depth = (c.depth || '').toLowerCase();
        return depth === 'background' || pos.includes('background');
      });
      if (hasBackgroundCharacter) sceneComplexity = 'complex';
    }

    // Character interactions: structured list of character-to-object contacts
    // (held, worn, in pocket, climbed, stood on, passed through, etc).
    // Normalize + drop entries whose actor/target isn't in this scene.
    const interactionsJson = sanitizeInteractions(parsedData.interactions, characterNames);
    parsedData.interactions = interactionsJson; // mirror into fullData so downstream readers see the sanitized list

    return {
      characters: characterNames,
      characterClothing: Object.keys(characterClothing).length > 0 ? characterClothing : null,
      characterPositions: Object.keys(characterPositions).length > 0 ? characterPositions : null,
      characterPerspectives: Object.keys(characterPerspectives).length > 0 ? characterPerspectives : null,
      clothing: null, // Per-character now, no single value
      objects: objectIds,
      interactions: interactionsJson.length > 0 ? interactionsJson : null,
      // Store full parsed data for buildTextFromJson
      fullData: parsedData,
      thinking: parsed.thinking || null,
      // Extract translated summary for display in user's language
      translatedSummary: parsedData.translatedSummary || null,
      // Extract image summary (English) — new format uses 'description', old uses 'imageSummary'
      imageSummary: parsedData.imageSummary || parsedData.description || null,
      // Per-landmark photo variant selections (e.g., {LOC003: 2, LOC005: 1})
      landmarkVariants: Object.keys(landmarkVariants).length > 0 ? landmarkVariants : null,
      // Store setting for reference
      setting: parsedData.setting || null,
      // Scene complexity for model routing ('simple' | 'complex' | null)
      sceneComplexity,
      // Empty scene prompt from scene expansion (for style-anchor background generation)
      emptyScenePrompt: parsedData.emptyScenePrompt || null,
      // Whether the existing empty scene background can be reused (iteration only)
      reuseEmptyScene: parsedData.reuseEmptyScene ?? null,
      // Text overlay position (where to place story text on the illustration)
      textPosition: parsedData.textPosition || null,
      // Short description of the saturated/high-contrast surface at textPosition
      // (for white text legibility) — used to steer empty-scene + main-scene prompts.
      textZoneDescription: parsedData.textZoneDescription || null,
      era: parsedData.era || null,
      framingPattern: parsedData.framingPattern || null,
      sceneIntent: parsedData.sceneIntent || null,
      isJsonFormat: true
    };
  }

  // LEGACY: Look for ```json block in markdown
  const jsonBlockMatch = sceneDescription.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    try {
      const jsonStr = jsonBlockMatch[1].trim();
      const metadata = JSON.parse(jsonStr);

      // Validate expected fields
      if (metadata.characters && Array.isArray(metadata.characters)) {
        return {
          characters: metadata.characters || [],
          // Support both new per-character format and legacy single-value format
          characterClothing: metadata.characterClothing || null,
          clothing: metadata.clothing || null, // Legacy support
          objects: metadata.objects || [],
          isJsonFormat: false
        };
      }
    } catch (e) { /* fall through to recovery below */ }
  }

  // Recovery path: the description carries the ---METADATA--- delimiter (we
  // intended structured metadata to be there) but every parser failed. Three
  // distinct causes show up here, each logged at a different level:
  //   ERROR — genuinely malformed JSON (the bug case worth investigating).
  //   DEBUG — critique-only output: the JSON parsed but contains
  //           `previewMismatches` instead of a `characters` array. The scene
  //           iteration intentionally returns this when no rewrite is needed.
  //   DEBUG — wrong input: tail doesn't begin with `{` / `\`\`\`json`. Means
  //           something handed us text that isn't a metadata block (e.g. an
  //           image prompt that happens to embed `---METADATA---` upstream).
  // In all cases, return a degraded metadata object that preserves the prose
  // so image prompts still have something to render from.
  if (hasProseDelim) {
    const idx = sceneDescription.indexOf('---METADATA---');
    const prose = sceneDescription.substring(0, idx).trim();
    const tail = sceneDescription.substring(idx + '---METADATA---'.length).trim();
    const tailHead = tail.slice(0, 200).replace(/\n/g, ' ');
    const looksLikeJson = tail.startsWith('{') || /^```json/i.test(tail);
    let critiqueOnly = false;
    if (looksLikeJson) {
      const probe = extractJsonFromText(tail);
      if (probe && probe.previewMismatches !== undefined && !probe.characters && !probe.scene && !probe.output && !probe.draft) {
        critiqueOnly = true;
      }
    }
    if (critiqueOnly) {
      log.debug(`[SCENE META] critique-only output (previewMismatches present, no scene rewrite) — using prose fallback`);
    } else if (!looksLikeJson) {
      log.debug(`[SCENE META] tail after ---METADATA--- isn't JSON (input wasn't a metadata block); using prose fallback. Head: ${tailHead}`);
    } else {
      log.error(`[SCENE META] ---METADATA--- delimiter present but JSON parse failed in BOTH prose+JSON and legacy paths. Sonnet emitted malformed metadata; returning prose-only fallback. Tail snippet (first 200 chars): ${tailHead}`);
    }
    if (prose && prose.length > 50) {
      return {
        characters: [],
        characterClothing: null,
        characterPositions: null,
        characterPerspectives: null,
        clothing: null,
        objects: [],
        interactions: null,
        fullData: { characters: [], objects: [], interactions: [], imageSummary: prose },
        thinking: null,
        translatedSummary: null,
        imageSummary: prose,
        landmarkVariants: null,
        setting: null,
        sceneComplexity: 'simple',
        emptyScenePrompt: null,
        reuseEmptyScene: null,
        textPosition: null,
        textZoneDescription: null,
        era: null,
        framingPattern: null,
        isJsonFormat: true,
        isProseFormat: true,
        isRecovered: true
      };
    }
  }

  return null;
}

/**
 * Every character name a scene references, from all three metadata carriers:
 * `characters` (the cast list), `characterPositions` and `characterClothing`
 * (whose keys are the same cast, but any one of the three can be null on a
 * given page). Deduplicated case-insensitively, first spelling wins.
 *
 * Used to decide which Visual Bible secondary characters belong on a page's
 * expected-character list for figure detection — the scene must actually
 * reference the name, so a secondary that appears on page 9 is never sent to
 * the detector for page 4.
 *
 * @param {Object|null} sceneMetadata - extractSceneMetadata() result
 * @param {string[]} [extraNames] - additional page-scoped names (e.g. scene.outlineCharacters)
 * @returns {string[]} Referenced names
 */
function collectSceneCharacterNames(sceneMetadata, extraNames = []) {
  const m = sceneMetadata || {};
  const raw = [
    ...(Array.isArray(m.characters) ? m.characters : []),
    ...Object.keys(m.characterPositions || {}),
    ...Object.keys(m.characterClothing || {}),
    ...(Array.isArray(extraNames) ? extraNames : []),
  ];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const name = String(typeof entry === 'string' ? entry : (entry && entry.name) || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Cast members the scene PROSE describes but the metadata `characters` list
 * omits. The Art Director emits prose plus a metadata block; the image model
 * renders the prose, while figure naming, the entity grid, clothing validation
 * and garment repair all supervise `characters`. A character described in the
 * prose but absent from that list is drawn and never checked. Staging
 * `job_1786397108357_q1fjbdzbx` p14: the prose describes five people, the
 * metadata lists three.
 *
 * A bare mention is required. An occurrence followed by an apostrophe is a
 * possessive naming a place or a prop ("<Name>'s attic", "<Name>'s torch") and
 * does not put the person in the picture — 4 of the 6 pages the original sweep
 * flagged were exactly that. Boundaries are letter/number based, so a cast
 * member "Ann" never matches "Anna".
 *
 * @param {string} sceneDescription - Prose + ---METADATA--- block
 * @param {string[]} castNames - Story cast names
 * @param {Object|null} [sceneMetadata] - Already-parsed metadata, when the caller has it
 * @returns {string[]} Cast names described in the prose but not listed (cast order)
 */
function findCastMissingFromMetadata(sceneDescription, castNames, sceneMetadata = null) {
  if (!sceneDescription || typeof sceneDescription !== 'string') return [];
  if (!Array.isArray(castNames) || castNames.length === 0) return [];
  const metadata = sceneMetadata || extractSceneMetadata(sceneDescription);
  if (!metadata || !Array.isArray(metadata.characters)) return [];

  const prose = sceneDescription.split('---METADATA---')[0];
  const listed = new Set(metadata.characters
    .map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim().toLowerCase())
    .filter(Boolean));

  const missing = [];
  for (const rawName of castNames) {
    const name = String(rawName || '').trim();
    if (!name || listed.has(name.toLowerCase())) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bare = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}'’])`, 'u');
    if (bare.test(prose)) missing.push(name);
  }
  return missing;
}

// ============================================================================
// AGE CATEGORY MAPPING - Maps numeric age to category for image generation
// ============================================================================


/**
 * Detect which characters are mentioned in a scene description
 * Priority: 1) JSON metadata block, 2) Markdown parsing, 3) Text search fallback
 * @param {string} sceneDescription - The scene text
 * @param {Array} characters - Array of character objects (main characters with reference photos)
 * @returns {Array} Characters that appear in this scene
 */
function getCharactersInScene(sceneDescription, characters) {
  if (!sceneDescription || typeof sceneDescription !== 'string' || !characters || characters.length === 0) {
    return [];
  }

  // Step 0: Try JSON metadata block first (most reliable)
  const metadata = extractSceneMetadata(sceneDescription);
  if (metadata && metadata.characters && metadata.characters.length > 0) {
    // Match JSON character names to available characters
    // Use STRICT matching to avoid "Lukas Zimmer" (a room) matching character "Lukas"
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      return metadata.characters.some(jsonName => {
        const jsonLower = jsonName.toLowerCase().trim();
        const jsonFirstName = jsonLower.split(' ')[0];

        // Exact match on full name or first name
        if (jsonLower === nameLower || jsonLower === firstName) return true;
        if (jsonFirstName === nameLower || jsonFirstName === firstName) return true;

        // Only allow partial matches if the character name IS the scene entry
        // (e.g., character "Lukas" matches scene entry "Lukas", not "Lukas Zimmer")
        // Avoid matching if scene entry is longer and contains additional words
        if (jsonLower.includes(nameLower) && jsonLower.split(' ').length === nameLower.split(' ').length) return true;
        if (nameLower.includes(jsonLower) && nameLower.split(' ').length === jsonLower.split(' ').length) return true;

        return false;
      });
    });

    if (matchedCharacters.length > 0) {
      return matchedCharacters;
    }
  }

  // Step 1: Use robust markdown parser to extract character names
  const parsedNames = extractCharacterNamesFromScene(sceneDescription);

  if (parsedNames.length > 0) {
    // Match main characters whose names appear in the parsed list
    // Use STRICT matching to avoid partial name matches
    const matchedCharacters = characters.filter(char => {
      if (!char.name) return false;
      const nameLower = char.name.toLowerCase().trim();
      const firstName = nameLower.split(' ')[0];

      return parsedNames.some(parsed => {
        const parsedFirstName = parsed.split(' ')[0];

        // Exact match on full name or first name
        if (parsed === nameLower || parsed === firstName) return true;
        if (parsedFirstName === nameLower || parsedFirstName === firstName) return true;

        // Only allow partial matches if same word count (avoid "Lukas Zimmer" matching "Lukas")
        if (parsed.includes(nameLower) && parsed.split(' ').length === nameLower.split(' ').length) return true;
        if (nameLower.includes(parsed) && nameLower.split(' ').length === parsed.split(' ').length) return true;

        return false;
      });
    });

    if (matchedCharacters.length > 0) {
      return matchedCharacters;
    }
  }

  // Step 2: Fallback to simple text matching if parser found nothing
  // Use word boundary matching to avoid partial matches
  const sceneLower = sceneDescription.toLowerCase();

  return characters.filter(char => {
    if (!char.name) return false;
    const nameLower = char.name.toLowerCase();
    const firstName = nameLower.split(' ')[0];

    // Use word boundary regex to match whole words only
    const nameRegex = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const firstNameRegex = new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

    return nameRegex.test(sceneLower) || firstNameRegex.test(sceneLower);
  });
}

/**
 * Extract scene metadata (characters, setting, time, weather) from scene hint
 * Parses format: "Characters: Luis: knight, Noel: standard\nSetting: indoor | Time: midday | Weather: n/a"
 *
 * @param {string} sceneHint - The scene hint text from outline
 * @returns {Object|null} { characters, setting, time, weather } or null if not found
 */
function parseSceneHintMetadata(sceneHint) {
  if (!sceneHint || typeof sceneHint !== 'string') return null;

  // Try JSON format first (new format)
  try {
    const jsonMatch = sceneHint.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.characters || parsed.description) {
        return {
          description: parsed.description || null,
          characters: parsed.characters || null, // Array of {name, position, clothing, depth?, perspective?}
          setting: parsed.setting || null,
          time: parsed.time || null,
          weather: parsed.weather || null,
          shot: parsed.shot || null,
          isJson: true,
        };
      }
    }
  } catch {
    // Not valid JSON, fall through to text parsing
  }

  // Legacy text format fallback
  const result = { characters: null, setting: null, time: null, weather: null, shot: null, isJson: false };

  // Try to match Characters section
  const charsMatch = sceneHint.match(/Characters?:\s*([\s\S]*?)(?=Setting:|$)/i);
  if (charsMatch) {
    const charBlock = charsMatch[1].trim();
    if (charBlock.includes('\n') && /^[-*]\s*\w/m.test(charBlock)) {
      const charEntries = [];
      // Bare `costumed` accepted (optional `:type` / `:{type}` suffix) — same
      // canonical clothing-token pattern as outlineParser/shared.js:117-126.
      const linePattern = /^[-*]\s*([^:\r\n]+:\s*(?:standard|winter|summer|formal|costumed(?::(?:\{[^}]*\}|[^\r\n,]+))?))/gim;
      let lineMatch;
      while ((lineMatch = linePattern.exec(charBlock)) !== null) {
        charEntries.push(lineMatch[1].trim());
      }
      result.characters = charEntries.length > 0 ? charEntries.join(', ') : charBlock;
    } else {
      result.characters = charBlock;
    }
  }

  const settingMatch = sceneHint.match(/Setting:\s*([^|]+)/i);
  if (settingMatch) result.setting = settingMatch[1].trim();

  const timeMatch = sceneHint.match(/Time:\s*([^|]+)/i);
  if (timeMatch) result.time = timeMatch[1].trim();

  const weatherMatch = sceneHint.match(/Weather:\s*([^|\n]+)/i);
  if (weatherMatch) result.weather = weatherMatch[1].trim();

  const shotMatch = sceneHint.match(/Shot:\s*([^|\n]+)/i);
  if (shotMatch) result.shot = shotMatch[1].trim();

  if (!result.characters && !result.setting && !result.time && !result.weather && !result.shot) {
    return null;
  }

  return result;
}

/**
 * Parse story text into pages
 */
function parseStoryPages(storyText) {
  // Split by page markers (## Seite/Page X, or --- Page/Seite/Página X ---)
  const pageRegex = /(?:##\s*(?:Seite|Page|Página)\s+(\d+)|---\s*(?:Page|Seite|Página|Pagina)\s+(\d+)\s*---)/gi;
  const pages = [];
  let match;

  // Find all page markers
  const matches = [];
  while ((match = pageRegex.exec(storyText)) !== null) {
    const pageNum = parseInt(match[1] || match[2]);
    if (isNaN(pageNum)) continue;
    matches.push({ index: match.index, pageNum, length: match[0].length });
  }

  // Extract content between markers
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const contentStart = current.index + current.length;
    const contentEnd = next ? next.index : storyText.length;
    const content = storyText.substring(contentStart, contentEnd).trim();

    if (content) {
      pages.push({
        pageNumber: current.pageNum,
        content: content
      });
    }
  }

  return pages;
}

/**
 * Parse scene descriptions from generated text
 */
function parseSceneDescriptions(text, expectedCount) {
  // Split by double newlines and filter out invalid entries
  const scenes = text.split('\n\n')
    .map(s => s.trim())
    .filter(s => {
      // Filter out empty, separators, or very short scenes
      if (!s) return false;
      if (s === '---' || s === '***' || s === '___') return false;
      if (s.length < 20) return false; // Too short to be a real scene description
      if (s.match(/^(Page|Scene|Chapter)\s+\d+/i)) return false; // Page headers
      return true;
    });

  log.debug(`[PARSE] Found ${scenes.length} valid scenes (expected ${expectedCount})`);

  // Log each scene for debugging
  scenes.forEach((scene, i) => {
    const preview = scene.substring(0, 80) + (scene.length > 80 ? '...' : '');
    log.debug(`[PARSE] Scene ${i + 1}: ${preview}`);
  });

  // If we have more scenes than expected, take only the first expectedCount
  if (scenes.length > expectedCount) {
    log.warn(`[PARSE] Got ${scenes.length} scenes but expected ${expectedCount}, trimming excess`);
    return scenes.slice(0, expectedCount);
  }

  // If we have fewer scenes than expected, warn but continue
  if (scenes.length < expectedCount) {
    log.warn(`[PARSE] Got only ${scenes.length} scenes but expected ${expectedCount}`);
  }

  return scenes;
}

/**
 * Extract short scene descriptions from outline
 * Uses the unified OutlineParser for consistent multilingual support
 */
function extractShortSceneDescriptions(outline) {
  const parser = new OutlineParser(outline);
  return parser.extractSceneDescriptions();
}

/**
 * Extract cover scene descriptions and clothing from outline
 * Uses the unified OutlineParser for consistent multilingual support
 * Returns: { titlePage: { scene, clothing }, initialPage: { scene, clothing }, backCover: { scene, clothing } }
 */
function extractCoverScenes(outline) {
  const parser = new OutlineParser(outline);
  return parser.extractCoverScenes();
}

/**
 * Extract clothing information for all pages from outline
 * Uses the unified OutlineParser for consistent multilingual support
 * @param {string} outline - The story outline text
 * @param {number} totalPages - Total number of story pages
 * @returns {Object} { primaryClothing: string, pageClothing: { [pageNum]: string } }
 */
function extractPageClothing(outline, totalPages = 20) {
  const parser = new OutlineParser(outline);
  return parser.extractPageClothing(totalPages);
}

// ============================================================================
// PROMPT BUILDERS
// ============================================================================


/**
 * Extract the page's primary location vantage from scene metadata.
 *
 * Convention: the FIRST `LOC###` (or `LOC###.N`) entry in `metadata.objects[]`
 * is the page's primary backdrop. The N suffix names a vantage on that LOC.
 *
 * Returns the resolved vantage object (with `id`, `name`, `shot`, `description`,
 * plus a `locId` and `locationName` from the parent), or null when the page
 * has no LOC reference or the LOC has no vantages defined (legacy stories).
 *
 * @param {Object} sceneMetadata - per-page metadata, expected to have `objects: []`
 * @param {Object} visualBible   - story-level visual bible with `locations[]`
 * @returns {Object|null} { locId, locationName, vantageId, name, shot, description, location } or null
 */
function getPrimaryVantageForPage(sceneMetadata, visualBible) {
  if (!sceneMetadata?.objects || !Array.isArray(sceneMetadata.objects)) return null;
  if (!visualBible?.locations) return null;

  // Find the first LOC###(.N) reference in objects[]. objects can be strings
  // ("LOC001.2", "Burgruine Stein [LOC002]") or objects ({id: "LOC001"}).
  const extractLoc = (raw) => {
    if (!raw) return null;
    const str = typeof raw === 'string' ? raw : (raw.id || raw.name || '');
    const m = str.match(/LOC(\d+)(?:\.(\d+))?/i);
    if (!m) return null;
    return { locId: `LOC${m[1].padStart(3, '0')}`, vantageNum: m[2] ? parseInt(m[2], 10) : null };
  };

  let parsed = null;
  for (const obj of sceneMetadata.objects) {
    parsed = extractLoc(obj);
    if (parsed) break;
  }
  if (!parsed) return null;

  const location = visualBible.locations.find(l => (l.id || '').toUpperCase() === parsed.locId);
  if (!location) return null;

  // Pick the vantage. If page specified .N → look it up by id. If page only
  // gave the bare LOC, default to vantage 1. If the location has no vantages
  // defined (legacy outline), return a synthetic single-vantage entry so the
  // canvas grouping still works.
  const vantages = Array.isArray(location.vantages) ? location.vantages : [];
  let vantage = null;
  if (parsed.vantageNum && vantages.length > 0) {
    vantage = vantages.find(v => {
      const m = (v.id || '').match(/\.(\d+)$/);
      return m && parseInt(m[1], 10) === parsed.vantageNum;
    });
  }
  if (!vantage && vantages.length > 0) {
    vantage = vantages[0];
  }
  if (!vantage) {
    // Legacy: synthesize a default vantage from the LOC's own description.
    vantage = {
      id: `${parsed.locId}.1`,
      name: location.name || 'default view',
      shot: 'wide',
      description: location.description
        || [location.setting, location.colors, location.features, location.signatureElement]
            .filter(Boolean).join('. '),
    };
  }

  return {
    locId: parsed.locId,
    locationName: location.name,
    vantageId: vantage.id || `${parsed.locId}.1`,
    name: vantage.name,
    shot: vantage.shot || 'wide',
    description: vantage.description || '',
    location, // full LOC entry for landmark photo lookup, attribution, etc.
    vantage,  // raw vantage entry (in case caller needs canvasImage etc.)
  };
}

/**
 * Group page numbers by primary vantage ID. Pages without a primary vantage
 * are returned in the special `__unassigned__` bucket.
 *
 * @param {Array<{pageNumber, sceneMetadata}>} pageDataArray
 * @param {Object} visualBible
 * @returns {Map<string, {vantage, pageNumbers: number[]}>}
 *   key = vantageId, value = { vantage: getPrimaryVantageForPage result, pageNumbers }
 *   plus a `__unassigned__` entry { vantage: null, pageNumbers }
 */
function groupPagesByVantage(pageDataArray, visualBible) {
  const groups = new Map();
  const unassigned = [];
  for (const pd of pageDataArray) {
    const v = getPrimaryVantageForPage(pd.sceneMetadata, visualBible);
    if (!v) { unassigned.push(pd.pageNumber); continue; }
    const key = v.vantageId;
    if (!groups.has(key)) groups.set(key, { vantage: v, pageNumbers: [] });
    groups.get(key).pageNumbers.push(pd.pageNumber);
  }
  if (unassigned.length > 0) {
    groups.set('__unassigned__', { vantage: null, pageNumbers: unassigned });
  }
  return groups;
}

// ============================================================================
// POSITION NORMALIZATION
// ============================================================================

/**
 * Normalize a position string like "bottom-left foreground" to simple L/C/R.
 * Used to match expected character positions from scene descriptions to detected figures.
 * @param {string} position - Position string from scene description
 * @returns {string|null} "left", "center", "right", or null if no match
 */
function normalizePositionToLCR(position) {
  if (!position || typeof position !== 'string') return null;
  const lower = position.toLowerCase();
  if (lower.includes('left')) return 'left';
  if (lower.includes('right')) return 'right';
  // "center", "middle", "foreground" without left/right = center
  return 'center';
}

// ============================================================================
// EXPORTS
// ============================================================================


/**
 * Get text for a specific page from storyText
 * @param {string|Array} storyText - Full story text with page markers, or array of {pageNumber, text}
 * @param {number} pageNumber - Page number to extract
 * @returns {string|null} Page text or null if not found
 */
function getPageText(storyText, pageNumber) {
  if (!storyText) return null;
  const safeNum = parseInt(pageNumber, 10);
  if (isNaN(safeNum)) return null;

  // Strip Sonnet's meta-annotations from page text before returning. Without
  // this, the trailing `*(Word count: N)*` and similar `*( ... )*` blocks
  // that Sonnet writes between sections leak into the rendered story page
  // (user observed `*(Word count: 111)*` at the end of page 4 in smoke #5).
  // Applied to both the array-format text and the regex-extracted text.
  const stripMetaAnnotations = (s) => {
    if (typeof s !== 'string') return s;
    return s
      .replace(/^\s*\*\([^)]*\)\*\s*\n?/g, '')            // leading meta blocks
      .replace(/\n\s*\*\([^)]*\)\*\s*(?=\n|$)/g, '')      // any mid/trailing meta block on its own line
      .replace(/\s*\*\([^)]*\)\*\s*$/g, '')               // trailing meta block at end of string
      .trim();
  };

  // Handle array format (unified mode)
  if (Array.isArray(storyText)) {
    const page = storyText.find(p => p.pageNumber === safeNum);
    return page?.text ? stripMetaAnnotations(page.text) : null;
  }

  // Match page markers like "--- Page/Seite/Página X ---" or "## Page/Seite X"
  const pageRegex = new RegExp(`(?:---|##)\\s*(?:Page|Seite|Página|Pagina)\\s+${safeNum}\\s*(?:---|\\n)([\\s\\S]*?)(?=(?:---|##)\\s*(?:Page|Seite|Página|Pagina)\\s+\\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  return match ? stripMetaAnnotations(match[1]) : null;
}

/**
 * Update text for a specific page in storyText
 * @param {string} storyText - Full story text with page markers
 * @param {number} pageNumber - Page number to update
 * @param {string} newText - New text for the page
 * @returns {string} Updated story text
 */
function updatePageText(storyText, pageNumber, newText) {
  const safeNum = parseInt(pageNumber, 10);
  if (isNaN(safeNum)) return storyText || '';
  if (!storyText) return `--- Page ${safeNum} ---\n${newText}\n`;

  const pageRegex = new RegExp(`((?:---|##)\\s*(?:Page|Seite|Página|Pagina)\\s+${safeNum}\\s*(?:---|\\n))([\\s\\S]*?)(?=(?:---|##)\\s*(?:Page|Seite|Página|Pagina)\\s+\\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  // Escape '$' in the user-supplied replacement so sequences like $1/$&/$` in the
  // edited text aren't interpreted as regex capture-group references (PIPE-3).
  const safeText = String(newText == null ? '' : newText).replace(/\$/g, '$$$$');

  if (match) {
    return storyText.replace(pageRegex, `$1\n${safeText}\n`);
  } else {
    // Page doesn't exist, append it
    return storyText + `\n--- Page ${safeNum} ---\n${newText}\n`;
  }
}


module.exports = {
  extractJsonFromText,
  sanitizeInteractions,
  parseProseMetadataFormat,
  POSITION_ABBREVIATIONS,
  expandPositionAbbreviations,
  stripEntityIds,
  formatHoldingForPrompt,
  buildTextFromJson,
  stripSceneMetadata,
  parseCharacterDescriptions,
  enforceSpreadTextPosition,
  mirrorLeftRight,
  extractSceneMetadata,
  collectSceneCharacterNames,
  findCastMissingFromMetadata,
  getCharactersInScene,
  parseSceneHintMetadata,
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  getPrimaryVantageForPage,
  groupPagesByVantage,
  normalizePositionToLCR,
  getPageText,
  updatePageText
};
