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

// Phantom strings matching this pattern are Visual Bible ID placeholders that
// Claude emitted in scene metadata without declaring an actual entry — not
// literal character names. Store them as the entry's `id`, not `name`.
const VB_ID_PATTERN = /^CHR\d+$/i;

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Find names that appear in scene hints but aren't declared anywhere.
 *
 * Checks every named-entity list in the Visual Bible — not just secondary
 * characters. Animals (e.g. a dragon companion), vehicles, artifacts, and
 * locations all have names that the scene generator can reference as
 * characters in the metadata. Without checking these lists we duplicate
 * a known animal as a phantom secondary character.
 *
 * @param {Array} storyPages - Pages from the parser, each with `characterClothing`
 * @param {Object} visualBible - VB object with named-entity lists
 * @param {Array} inputCharacters - User-provided main + primary characters
 * @returns {string[]} array of phantom names (original casing)
 */
function findPhantomNames(storyPages, visualBible, inputCharacters) {
  const known = new Set();
  for (const c of (inputCharacters || [])) {
    if (c.name) known.add(normalizeName(c.name));
  }
  // Every Visual Bible list with named entities — anything Claude could
  // reasonably reference by name in the scene metadata's `characters` array.
  const vbLists = [
    visualBible?.secondaryCharacters,
    visualBible?.mainCharacters,  // may be empty in some pipelines, defensive
    visualBible?.animals,         // dragons, pets, creatures
    visualBible?.vehicles,        // named bikes, trains, ships
    visualBible?.artifacts,       // named magical objects
  ];
  for (const list of vbLists) {
    for (const entry of (list || [])) {
      if (entry?.name) known.add(normalizeName(entry.name));
    }
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

  // Annotate ID-pattern phantoms so Claude knows to invent a descriptive name.
  // Without this, Claude echoes back the placeholder (e.g. "CHR001") as the name
  // and downstream code mistakes the entry's name for a VB id.
  const phantomLines = phantomNames.map(n => {
    return VB_ID_PATTERN.test(n)
      ? `- ${n}  [placeholder ID — invent a descriptive name from the passages]`
      : `- ${n}`;
  }).join('\n');

  return `These character references appear in a story but are missing from its Visual Bible:

${phantomLines}

Sample passages where each character appears:

${contextBlocks}

Already-known characters (do NOT regenerate, do NOT make new ones look like these):
${knownNames.length > 0 ? knownNames.map(n => `- ${n}`).join('\n') : '(none)'}

For EACH missing character above, write a Visual Bible entry. Infer age, gender, build, hair, and clothing from the passages. If the passages give no clue for some field, pick reasonable defaults consistent with the story tone. Make every character VISUALLY DISTINCT from each other and from the already-known characters above (different hair color, different build, different signature element).

For a "placeholder ID" phantom (e.g. CHR001), the "name" field must be a descriptive human name or role invented from the passages (e.g. "Wanderer", "Oma", "Baker"). Do NOT echo the placeholder ID back as the name.

Output ONLY a JSON array — no markdown fence, no commentary:

[
  {
    "phantom": "<exact phantom string from the list above>",
    "name": "<descriptive name — invented for placeholder IDs, echoed verbatim for regular names>",
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
 * Resolve character keys that are VB ids of ALREADY-DEFINED entries.
 *
 * Sonnet sometimes writes `"name": "CHR001"` in page metadata for a character
 * it declared in the Visual Bible (e.g. CHR001 = Luca). The phantom detector
 * only knows NAMES, so without this step the id-key reads as an unknown
 * person and Haiku invents a DUPLICATE character with a different look.
 * Renaming the key to the entry's real name also repairs the downstream
 * avatar / clothing lookups, which are name-keyed.
 *
 * Mutates pages in place. Returns the number of keys remapped.
 */
function resolveVbIdCharacterKeys(storyPages, visualBible) {
  const idToName = new Map();
  for (const list of [visualBible?.secondaryCharacters, visualBible?.mainCharacters, visualBible?.animals]) {
    for (const entry of (list || [])) {
      if (entry?.id && entry?.name) idToName.set(String(entry.id).toUpperCase(), entry.name);
    }
  }
  if (idToName.size === 0) return 0;

  let remapped = 0;
  for (const page of (storyPages || [])) {
    for (const key of Object.keys(page.characterClothing || {})) {
      if (!/^(CHR|ANI)\d+$/i.test(key.trim())) continue;
      const realName = idToName.get(key.trim().toUpperCase());
      if (!realName || page.characterClothing[realName] !== undefined) continue;
      page.characterClothing[realName] = page.characterClothing[key];
      delete page.characterClothing[key];
      if (page.characterPerspectives?.[key] !== undefined) {
        page.characterPerspectives[realName] = page.characterPerspectives[key];
        delete page.characterPerspectives[key];
      }
      if (Array.isArray(page.characters)) {
        page.characters = page.characters.map(n => (n?.trim?.().toUpperCase() === key.trim().toUpperCase() ? realName : n));
      }
      log.info(`👻 [PHANTOM] Page ${page.pageNumber}: remapped id-key "${key}" → "${realName}" (already defined in VB)`);
      remapped++;
    }
  }
  return remapped;
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
  // First resolve id-keys of already-defined characters — they are NOT
  // phantoms and must not get duplicate invented entries.
  resolveVbIdCharacterKeys(storyPages, visualBible);

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
    if (!entry) continue;
    // Match the entry back to its phantom via the `phantom` field (new) or
    // the `name` field (fallback for older model outputs that didn't include phantom).
    const phantomKey = entry.phantom || entry.name;
    if (!phantomKey) continue;
    const matchedPhantom = phantoms.find(p => normalizeName(p) === normalizeName(phantomKey));
    if (!matchedPhantom) continue;

    // ID-pattern phantom (e.g. "CHR001") → preserve the placeholder as the id.
    // Regular name phantom (e.g. "Oma") → sequential CHR id, name echoed.
    if (VB_ID_PATTERN.test(matchedPhantom)) {
      entry.id = matchedPhantom.toUpperCase();
      existingIds.add(entry.id);
      // entry.name should be the descriptive name Claude invented. If Claude
      // ignored the instruction and echoed the placeholder, fall back to a
      // generic label so downstream name-based lookups don't re-trip the VB-id regex.
      if (!entry.name || VB_ID_PATTERN.test(entry.name)) {
        entry.name = 'unnamed character';
      }
    } else {
      entry.id = nextId();
      // Preserve the original name casing from the phantom reference
      entry.name = matchedPhantom;
    }
    delete entry.phantom;
    entry.pages = pagesByPhantom[normalizeName(matchedPhantom)] || [];
    visualBible.secondaryCharacters.push(entry);
    log.info(`👻 [PHANTOM] Added "${entry.name}" (phantom=${matchedPhantom}) to Visual Bible as ${entry.id} (pages: ${entry.pages.join(',')})`);
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

// ───────────────────────────────────────────────────────────────────────────
// Orphan object ids: ART/ANI/VEH/LOC/CLO ids referenced in page metadata but
// never defined in the Visual Bible. The image-prompt sanitizer drops lines
// with unresolved ids, so an orphan id silently erases scene content. Same
// repair pattern as phantom characters: a small Haiku call writes the
// missing entries from the page context.
// ───────────────────────────────────────────────────────────────────────────

const ORPHAN_POOLS = {
  ART: 'artifacts',
  ANI: 'animals',
  VEH: 'vehicles',
  LOC: 'locations',
  CLO: 'clothing',
};

function collectUsedObjectIds(storyPages) {
  const used = new Map(); // baseId -> Set(pageNumbers)
  const re = /\b(ART|ANI|VEH|LOC|CLO)\d+(?:\.\d+)?\b/gi;
  for (const page of (storyPages || [])) {
    const haystack = `${page.sceneHint || ''}\n${page.sceneProse || ''}`;
    let m;
    while ((m = re.exec(haystack)) !== null) {
      const base = m[0].toUpperCase().split('.')[0];
      if (!used.has(base)) used.set(base, new Set());
      used.get(base).add(page.pageNumber);
    }
  }
  return used;
}

/**
 * Detect object ids used in page metadata that have no VB entry, and patch
 * the Visual Bible in place via a Haiku call. Mirrors
 * detectAndPatchPhantomCharacters.
 *
 * @returns {Promise<Object|null>} usage object if a call was made, else null
 */
async function detectAndPatchOrphanObjectIds({ storyPages, visualBible, modelId }) {
  if (!visualBible) return null;
  const defined = new Set();
  for (const pool of Object.values(ORPHAN_POOLS).concat(['mainCharacters', 'secondaryCharacters'])) {
    for (const entry of (visualBible[pool] || [])) {
      if (entry?.id) defined.add(String(entry.id).toUpperCase().split('.')[0]);
    }
  }

  const used = collectUsedObjectIds(storyPages);
  const orphans = [...used.keys()].filter(id => !defined.has(id));
  if (orphans.length === 0) return null;

  log.warn(`👻 [ORPHAN-ID] ${orphans.length} object id(s) used in pages but missing from Visual Bible: ${orphans.join(', ')}`);

  // Context: scene text of up to 3 pages per orphan id
  const contextBlocks = orphans.map(id => {
    const pages = [...(used.get(id) || [])].slice(0, 3);
    const samples = (storyPages || [])
      .filter(p => pages.includes(p.pageNumber))
      .map(p => `[p${p.pageNumber}] ${(`${p.sceneProse || p.sceneHint || ''}`).substring(0, 300).replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    return `### ${id}\n${samples || '(no context found)'}`;
  }).join('\n\n');

  const prompt = `These Visual Bible ids are referenced in a children's story's scene metadata but were never defined:

${orphans.join(', ')}

Scene passages where each id appears (the prose describes the object in words):

${contextBlocks}

For EACH id, write its Visual Bible entry. Infer what the object is from the passages — the id prefix tells you the type (ART artifact/prop, ANI animal, VEH vehicle, LOC location, CLO clothing item). The description must be purely visual (shape, size, colors, material).

Output ONLY a JSON array — no markdown fence, no commentary:

[
  { "id": "<exact id>", "name": "<short name>", "description": "<2-3 sentence visual description>" }
]`;

  let result;
  try {
    result = await callClaudeAPI(prompt, 3000, modelId || 'claude-haiku-4-5');
  } catch (err) {
    log.warn(`👻 [ORPHAN-ID] Patch call failed: ${err.message}`);
    return null;
  }
  if (!result?.text) return null;

  let entries;
  try {
    const cleaned = result.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    entries = JSON.parse(cleaned);
  } catch {
    const match = result.text.match(/\[[\s\S]*\]/);
    if (match) { try { entries = JSON.parse(match[0]); } catch { entries = null; } }
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    log.warn(`👻 [ORPHAN-ID] Could not parse patch response — orphan ids NOT patched`);
    return null;
  }

  let added = 0;
  for (const entry of entries) {
    const id = String(entry?.id || '').toUpperCase();
    const prefix = id.slice(0, 3);
    const pool = ORPHAN_POOLS[prefix];
    if (!pool || !orphans.includes(id) || !entry.name) continue;
    if (!Array.isArray(visualBible[pool])) visualBible[pool] = [];
    const newEntry = {
      id,
      name: entry.name,
      description: entry.description || '',
      appearsInPages: [...(used.get(id) || [])],
      referenceImageData: null,
      referenceImageGenerated: false,
    };
    if (pool === 'locations') newEntry.isRealLandmark = false;
    visualBible[pool].push(newEntry);
    log.info(`👻 [ORPHAN-ID] Added ${id} "${entry.name}" to visualBible.${pool} (pages: ${newEntry.appearsInPages.join(',')})`);
    added++;
  }
  if (added === 0) return null;

  return {
    input_tokens: result.usage?.input_tokens || 0,
    output_tokens: result.usage?.output_tokens || 0,
    modelId: result.modelId || modelId,
  };
}

module.exports = {
  findPhantomNames,
  resolveVbIdCharacterKeys,
  detectAndPatchPhantomCharacters,
  detectAndPatchOrphanObjectIds,
};
