/**
 * Phantom Character Detection
 *
 * A "phantom character" is a name that appears in a page's scene hint
 * (the `characterClothing` field, which is what the image generator
 * uses to know who to render) but is NOT declared in either:
 *   - inputData.characters (main + primary characters)
 *   - visualBible.secondaryCharacters (secondary characters Claude declared)
 *
 * Without a declaration, the image generator has no description or
 * reference photo for that name and invents a different person for it on
 * every page.
 *
 * This module detects phantoms after the unified parse, then makes a small
 * Claude Haiku call to generate Visual Bible entries for them. The patched
 * entries are merged into visualBible.secondaryCharacters in place.
 */

const { log } = require('../utils/logger');
const { callClaudeAPI } = require('./textModels');

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Find names that appear in scene hints but aren't declared anywhere.
 *
 * @param {Array} storyPages - Pages from the parser, each with `characterClothing`
 * @param {Object} visualBible - VB object with `secondaryCharacters`
 * @param {Array} inputCharacters - User-provided main + primary characters
 * @returns {string[]} array of phantom names (original casing)
 */
function findPhantomNames(storyPages, visualBible, inputCharacters) {
  const known = new Set();
  for (const c of (inputCharacters || [])) {
    if (c.name) known.add(normalizeName(c.name));
  }
  for (const sc of (visualBible.secondaryCharacters || [])) {
    if (sc.name) known.add(normalizeName(sc.name));
  }

  const phantoms = new Map(); // normalizedName -> originalName
  for (const page of (storyPages || [])) {
    const names = Object.keys(page.characterClothing || {});
    for (const name of names) {
      const norm = normalizeName(name);
      if (!norm || known.has(norm)) continue;
      if (!phantoms.has(norm)) phantoms.set(norm, name.trim());
    }
  }
  return [...phantoms.values()];
}

/**
 * Build the Haiku prompt that asks for VB entries for the phantom characters.
 * Generic — does not assume children, gender, story type. Lets Claude infer
 * everything from the story text it sees.
 */
function buildPatchPrompt(phantomNames, storyPages, knownNames) {
  // Pull up to 4 short text snippets per phantom for context
  const contextBlocks = phantomNames.map(name => {
    const norm = normalizeName(name);
    const samples = (storyPages || [])
      .filter(p => Object.keys(p.characterClothing || {}).some(k => normalizeName(k) === norm))
      .slice(0, 4)
      .map(p => `[p${p.pageNumber}] ${(p.text || '').substring(0, 220).replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    return `### ${name}\n${samples || '(no sample text available)'}`;
  }).join('\n\n');

  return `These character names appear in a story but are missing from its Visual Bible:

${phantomNames.map(n => `- ${n}`).join('\n')}

Sample passages where each character appears:

${contextBlocks}

Already-known characters (do NOT regenerate, do NOT make new ones look like these):
${knownNames.length > 0 ? knownNames.map(n => `- ${n}`).join('\n') : '(none)'}

For EACH missing character above, write a Visual Bible entry. Infer age, gender, build, hair, and clothing from the passages. If the passages give no clue for some field, pick reasonable defaults consistent with the story tone. Make every character VISUALLY DISTINCT from each other and from the already-known characters above (different hair color, different build, different signature element).

Output ONLY a JSON array — no markdown fence, no commentary:

[
  {
    "name": "<exact name as written above>",
    "age": "<age category, e.g. 'child ~8', 'teen ~15', 'adult ~30', 'elderly ~70'>",
    "build": "<height + body type>",
    "hair": "<color, length, style>",
    "face": "<eye color, skin tone, distinctive features>",
    "signatureLook": "<one memorable visual element>",
    "clothing": "<specific colors and details>"
  }
]`;
}

/**
 * Detect phantom characters and patch the Visual Bible in place.
 *
 * @param {Object} args
 * @param {Array} args.storyPages - parsed pages with characterClothing
 * @param {Object} args.visualBible - VB to patch (mutated in place)
 * @param {Array} args.inputCharacters - user-provided characters
 * @param {string} args.modelId - Claude model to use for the patch call
 * @returns {Promise<Object|null>} usage object if a call was made, else null
 */
async function detectAndPatchPhantomCharacters({ storyPages, visualBible, inputCharacters, modelId }) {
  const phantoms = findPhantomNames(storyPages, visualBible, inputCharacters);
  if (phantoms.length === 0) return null;

  log.warn(`👻 [PHANTOM] Detected ${phantoms.length} character(s) missing from Visual Bible: ${phantoms.join(', ')}`);

  const knownNames = [
    ...(inputCharacters || []).map(c => c.name).filter(Boolean),
    ...((visualBible.secondaryCharacters || []).map(s => s.name).filter(Boolean)),
  ];

  const prompt = buildPatchPrompt(phantoms, storyPages, knownNames);

  let result;
  try {
    result = await callClaudeAPI(prompt, 4000, modelId || 'claude-haiku-4-5');
  } catch (callErr) {
    log.warn(`👻 [PHANTOM] Patch call failed: ${callErr.message}`);
    return null;
  }
  if (!result || !result.text) return null;

  // Parse the JSON array. Tolerate markdown fences or trailing prose.
  let entries;
  try {
    const cleaned = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    entries = JSON.parse(cleaned);
  } catch {
    const match = result.text.match(/\[[\s\S]*\]/);
    if (match) {
      try { entries = JSON.parse(match[0]); } catch { entries = null; }
    }
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    log.warn(`👻 [PHANTOM] Could not parse Claude response as JSON array — phantoms NOT patched`);
    return null;
  }

  if (!Array.isArray(visualBible.secondaryCharacters)) {
    visualBible.secondaryCharacters = [];
  }

  // Build the set of pages each phantom appears on (for the `pages` field)
  const pagesByPhantom = {};
  for (const phantom of phantoms) {
    const norm = normalizeName(phantom);
    pagesByPhantom[norm] = (storyPages || [])
      .filter(p => Object.keys(p.characterClothing || {}).some(k => normalizeName(k) === norm))
      .map(p => p.pageNumber);
  }

  // Assign sequential CHR IDs continuing from existing entries
  const existingIds = new Set(visualBible.secondaryCharacters.map(s => s.id).filter(Boolean));
  let nextNum = visualBible.secondaryCharacters.length + 1;
  const nextId = () => {
    while (existingIds.has(`CHR${String(nextNum).padStart(3, '0')}`)) nextNum++;
    const id = `CHR${String(nextNum).padStart(3, '0')}`;
    existingIds.add(id);
    nextNum++;
    return id;
  };

  let added = 0;
  for (const entry of entries) {
    if (!entry || !entry.name) continue;
    // Drop entries Claude returned for characters that are NOT phantoms
    // (defensive against the model adding extras)
    const isPhantom = phantoms.some(p => normalizeName(p) === normalizeName(entry.name));
    if (!isPhantom) continue;

    entry.id = nextId();
    entry.pages = pagesByPhantom[normalizeName(entry.name)] || [];
    visualBible.secondaryCharacters.push(entry);
    log.info(`👻 [PHANTOM] Added "${entry.name}" to Visual Bible as ${entry.id} (pages: ${entry.pages.join(',')})`);
    added++;
  }

  if (added === 0) {
    log.warn(`👻 [PHANTOM] No usable entries returned from patch call`);
    return null;
  }

  // Return usage so the caller can track cost
  return {
    input_tokens: result.usage?.input_tokens || 0,
    output_tokens: result.usage?.output_tokens || 0,
    modelId: result.modelId || modelId,
  };
}

module.exports = {
  findPhantomNames,
  detectAndPatchPhantomCharacters,
};
