/**
 * Shared cover iterate logic — used by both manual iterate endpoint
 * and the auto repair pipeline.
 *
 * Extracts the core cover regeneration logic: character selection,
 * prompt building, landmark/VB grid, image generation.
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
const { resolveArtStyle, resolveArtStyleForEmptyScene } = require('./storyHelpers');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { applyStyledAvatars } = require('./styledAvatars');
const { coverKeyToType, coverLabel, COVER_PAGE_NUMBERS } = require('./coverKeys');

function getStoryHelpers() {
  return require('./storyHelpers');
}

/**
 * Enrich a cover hint with artifact reference bytes + a full-VB id→name map.
 * Single source of truth for the producer-side enrichment that the composite
 * path (here) and the regeneration test-models path built identically.
 *
 * Returns a NEW hint (shallow clone, never mutates the input):
 *   _artifactNames — every artifact/animal/location/vehicle id→name across the
 *                    FULL Visual Bible (a character's `holds` can reference an
 *                    id outside coverHint.objects — holds ⊄ objects — and the
 *                    raw id would otherwise leak into pose/action prose as
 *                    paintable text). First-writer-wins per id.
 *   _artifactImages — reference bytes, limited to the ART ids actually declared
 *                     in coverHint.objects (only pasted props need bytes).
 *
 * Pre-existing _artifactNames/_artifactImages on the hint are preserved (the
 * safer of the two prior formulations — regeneration used `|| {}`, coverIterate
 * reset to `{}`; identical in the normal unenriched path).
 *
 * Also stamps:
 *   _artifactDescsEn — ART/VEH id → short ENGLISH descriptor (from the entry's
 *                      description). Image-facing prompts are English-only;
 *                      VB names follow the story language, so consumers that
 *                      write "holds the <X>" prose use this map, not the name.
 *   _language — story language (opts.language), so downstream prompt builders
 *               (composite pass 2) can drop story-language mood text.
 */
function enrichCoverHintWithArtifacts(coverHint, visualBible, opts = {}) {
  const enriched = { ...(coverHint || {}) };
  enriched._artifactImages = enriched._artifactImages || {};
  enriched._artifactNames = enriched._artifactNames || {};
  enriched._artifactDescsEn = enriched._artifactDescsEn || {};
  if (opts.language && !enriched._language) enriched._language = opts.language;
  for (const pool of ['artifacts', 'animals', 'locations', 'vehicles']) {
    for (const entry of (visualBible?.[pool] || [])) {
      if (entry?.id && entry?.name && !enriched._artifactNames[entry.id]) {
        enriched._artifactNames[entry.id] = entry.name;
      }
      if (entry?.id && (pool === 'artifacts' || pool === 'vehicles') && !enriched._artifactDescsEn[entry.id]) {
        const ref = englishEntityRef(entry, pool === 'vehicles' ? 'vehicle' : 'object');
        if (ref) enriched._artifactDescsEn[entry.id] = ref;
      }
    }
  }
  for (const id of (coverHint?.objects || [])) {
    if (!/^ART\d+/.test(String(id))) continue;
    const art = (visualBible?.artifacts || []).find(a => a?.id === id);
    if (!art) continue;
    const src = art.referenceImageUrl || art.referenceImageData;
    if (src) enriched._artifactImages[id] = src;
  }
  return enriched;
}

// englishEntityRef / englishLocationRef / significantEntityTokens moved to
// visualBible.js (canonical implementations, shared with the page-prompt
// builders in storyHelpers.js). Re-exported below for existing consumers.
const { englishEntityRef, englishLocationRef, significantEntityTokens } = require('./visualBible');

/**
 * VB ids the cover hint actually asks for: `Objects:` list ∪ every character's
 * `holds:` id (holds ⊄ objects — the outline sometimes holds an id it forgot
 * to list). Returns null when the hint declares no objects and no holds, so
 * callers keep the legacy unfiltered KEY STORY ELEMENTS for hint-less stories.
 */
function collectCoverHintElementIds(coverHint) {
  const ids = [];
  for (const id of (coverHint?.objects || [])) {
    if (typeof id === 'string' && /^(?:LOC|ART|ANI|VEH|CHR|CLO)\d+/i.test(id.trim())) {
      ids.push(id.trim().toUpperCase());
    }
  }
  const details = (coverHint?.characterDetails && typeof coverHint.characterDetails === 'object')
    ? Object.values(coverHint.characterDetails)
    : [];
  for (const d of details) {
    const m = String(d?.holds || '').trim().match(/^((?:ART|ANI|VEH|CLO)\d+)/i);
    if (m) ids.push(m[1].toUpperCase());
  }
  return ids.length > 0 ? [...new Set(ids)] : null;
}

// Tokenizer for matching a VB artifact against a clothing description —
// shared canon in visualBible.js (significantEntityTokens, imported above).
const significantTokens = significantEntityTokens;

/**
 * Resolve the "item emitted as BOTH clothing and artifact" contradiction for a
 * cover, deterministically:
 *   - HELD wins: when the hint says a character `holds:` an artifact and that
 *     artifact's name/description overlaps the character's clothing line, the
 *     overlapping garment segment is REMOVED from the clothing line (the item
 *     appears once, in the scene's holds prose). Otherwise the prompt says
 *     "worn tied at the neck" AND "held in the hand" about the same item.
 *   - WORN wins: when an artifact overlaps a cover character's clothing line
 *     but nobody holds it, it is part of the worn outfit — its id goes to
 *     `excludeElementIds` so KEY STORY ELEMENTS doesn't emit it a second time.
 *
 * Overlap rule (deterministic): an artifact matches a comma/semicolon segment
 * of a clothing description when they share ≥2 significant tokens, or ≥1
 * token that comes from the artifact's NAME (names are short and specific).
 *
 * Never mutates the input photos — returns cloned photos for the CLOTHING
 * text block only (the originals keep full avatar metadata for image parts).
 *
 * @returns {{ photos: Array, excludeElementIds: Array<string> }}
 */
function applyCoverWornHeldDedupe(photos, coverHint, visualBible) {
  const list = Array.isArray(photos) ? photos : [];
  const artifacts = Array.isArray(visualBible?.artifacts) ? visualBible.artifacts : [];
  const details = (coverHint?.characterDetails && typeof coverHint.characterDetails === 'object')
    ? Object.values(coverHint.characterDetails)
    : [];
  if (list.length === 0 || artifacts.length === 0) {
    return { photos: list, excludeElementIds: [] };
  }

  // Who holds which artifact id (per the hint — the authoritative spec).
  const heldByChar = new Map(); // charNameLower -> Set<id>
  const heldIds = new Set();
  for (const d of details) {
    const m = String(d?.holds || '').trim().match(/^((?:ART|ANI|VEH|CLO)\d+)/i);
    if (!m || !d?.name) continue;
    const id = m[1].toUpperCase();
    heldIds.add(id);
    const key = String(d.name).trim().toLowerCase();
    if (!heldByChar.has(key)) heldByChar.set(key, new Set());
    heldByChar.get(key).add(id);
  }

  const artifactMeta = artifacts
    .filter(a => a?.id)
    .map(a => ({
      id: String(a.id).toUpperCase(),
      nameTokens: significantTokens(a.name),
      allTokens: new Set([...significantTokens(a.name), ...significantTokens(a.extractedDescription || a.description)]),
    }));

  const segmentMatches = (segment, meta) => {
    const segTokens = significantTokens(segment);
    let overlap = 0;
    let nameHit = false;
    for (const t of segTokens) {
      if (meta.allTokens.has(t)) overlap++;
      if (meta.nameTokens.has(t)) nameHit = true;
    }
    return overlap >= 2 || nameHit;
  };

  const excludeElementIds = new Set();
  const outPhotos = list.map(photo => {
    const clothing = photo?.clothingDescription;
    if (!clothing) return photo;
    const charKey = String(photo.name || '').trim().toLowerCase();
    const heldHere = heldByChar.get(charKey) || new Set();
    const segments = String(clothing).split(/\s*[,;]\s*/).filter(Boolean);
    const kept = [];
    let changed = false;
    for (const segment of segments) {
      let drop = false;
      for (const meta of artifactMeta) {
        if (!segmentMatches(segment, meta)) continue;
        if (heldHere.has(meta.id)) {
          // Held per hint → not ALSO worn. Drop the worn phrasing.
          drop = true;
          log.info(`🧥 [COVER-CLOTHING] ${photo.name}: dropped worn segment "${segment}" — ${meta.id} is held per cover hint`);
        } else if (!heldIds.has(meta.id)) {
          // Worn (overlaps an outfit) and held by nobody → clothing keeps it,
          // KEY STORY ELEMENTS must not emit it again.
          excludeElementIds.add(meta.id);
        }
      }
      if (drop) changed = true;
      else kept.push(segment);
    }
    if (!changed) return photo;
    return { ...photo, clothingDescription: kept.join(', ') || null };
  });

  return { photos: outPhotos, excludeElementIds: [...excludeElementIds] };
}

/**
 * COMPOSITION lines for the initial-page templates ({GROUP_COMPOSITION}).
 * The "GROUP scene / MAIN CHARACTER in the CENTER / others arranged AROUND"
 * boilerplate only makes sense for 3+ characters — with 1-2 it contradicts
 * the hint's explicit per-character positions and makes the model invent
 * extra figures to fill out the "group".
 */
function buildInitialPageComposition(characterCount) {
  const n = Number(characterCount) || 0;
  if (n === 1) {
    return [
      '- Draw EXACTLY the single character described in the SCENE — no more, no fewer. Do not invent extra figures.',
      '- Place the character at the position given in the SCENE',
      '- The character should be clearly visible and recognizable',
    ].join('\n');
  }
  if (n === 2) {
    return [
      '- Draw EXACTLY the two characters described in the SCENE — no more, no fewer. Do not invent extra figures.',
      '- Place each character at the position given in the SCENE',
      '- Both characters should be clearly visible and recognizable',
    ].join('\n');
  }
  // 3+ (and unknown/0 → legacy group behaviour)
  return [
    "- This is a GROUP scene introducing all the story's characters",
    '- The MAIN CHARACTER should be positioned in the CENTER',
    '- Other characters should be arranged AROUND the main character',
    '- Everyone should be clearly visible and recognizable',
  ].join('\n');
}

/**
 * Back cover is a main-characters-only group portrait — drop supporting
 * characters that slipped in via the hint or scene description. Single source
 * of truth for the filter used by both the iterate path and the regeneration
 * test-models path.
 *
 * Keeps the length-check safety: only narrows the cast when at least one main
 * character remains (never returns an empty cast). Returns
 *   { characters, dropped }
 * where `dropped` is the removed names (empty when nothing changed), so callers
 * can log and decide whether to recompute derived state.
 */
function filterBackCoverToMainCharacters(characters, mainIds) {
  const list = Array.isArray(characters) ? characters : [];
  const ids = Array.isArray(mainIds) ? mainIds : [];
  const isMain = (c) => c.isMainCharacter === true || (ids.length > 0 && ids.includes(c.id));
  const mainOnly = list.filter(isMain);
  if (mainOnly.length > 0 && mainOnly.length !== list.length) {
    const dropped = list.filter(c => !isMain(c)).map(c => c.name);
    return { characters: mainOnly, dropped };
  }
  return { characters: list, dropped: [] };
}

/**
 * Owner rule (2026-07-31): characters explicitly listed in a cover HINT are
 * authoritative — EVERY hint-listed character's avatar must be packed with
 * the cover render. (The title page previously dropped a hint-listed second
 * protagonist because they weren't flagged "main", so their styled avatar
 * never went along as a reference and the model invented the face.)
 *
 * The main-only narrowing filters therefore apply ONLY to casts derived by
 * FALLBACK (scene-text matching / all-characters distribution) — never to a
 * cast that came from the cover hint's character list.
 *
 * Single decision point used by the streaming cover path (server.js), the
 * iterate path (iterateCover), and the test-models cover-composite dispatch
 * (routes/regeneration.js).
 *
 * @param {Array} cast - selected cover characters (full character objects)
 * @param {Object} opts
 * @param {boolean} opts.castFromHint - true when the cast came from the cover
 *   hint's character list (characterClothing / characterDetails)
 * @param {Array} [opts.mainIds] - storyData.mainCharacters ids
 * @returns {{ characters: Array, dropped: string[], applied: boolean }}
 */
function narrowCoverCastToMains(cast, { castFromHint = false, mainIds = null } = {}) {
  const list = Array.isArray(cast) ? cast : [];
  if (castFromHint) return { characters: list, dropped: [], applied: false };
  const { characters, dropped } = filterBackCoverToMainCharacters(list, mainIds);
  return { characters, dropped, applied: dropped.length > 0 };
}

/**
 * Drop sentences that mention a character by name. Used on the cover
 * empty-scene plate description: covers fall back to the full group-portrait
 * prose, and any character sentence left in makes the "empty" plate render
 * placeholder figures (with held VB props painted as literal ID signs). The
 * final render then keeps those placeholders alongside the real cast —
 * phantom duplicate figures.
 */
function stripCharacterSentences(description, characterNames = []) {
  if (!description) return description;
  const names = (characterNames || [])
    .filter(n => typeof n === 'string' && n.trim().length > 1)
    .map(n => n.trim().toLowerCase());
  if (names.length === 0) return description;
  return description
    .split('\n')
    .map(line => line
      .split(/(?<=[.!?])\s+/)
      .filter(sentence => {
        const s = sentence.toLowerCase();
        return !names.some(n => s.includes(n));
      })
      .join(' '))
    .join('\n');
}

/**
 * Build the PEOPLE-FREE description for the cover empty-scene plate.
 * Strips character sentences, rewrites the hint builder's composition
 * starters ("group portrait", "Only these two people appear") to a
 * setting-only view, and resolves/drops VB ids so no raw ART###/CHR###
 * token reaches the image model as paintable text.
 */
function buildPlateDescription(emptyDescRaw, characterNames, visualBible, pageNumber) {
  const { sanitizeVbIdsInPrompt } = getStoryHelpers();
  const stripped = stripCharacterSentences(emptyDescRaw, characterNames)
    .replace(/\ba wide group portrait set before\b/gi, 'A wide view of')
    .replace(/\ba portrait of (?:two characters|a single character) set before\b/gi, 'A wide view of')
    .replace(/\bOnly (?:these two people|this one person) appears?[^.]*\.\s*/gi, '')
    // Drop mood/atmosphere sentences that imply a group of people. The empty-
    // scene generator reads "warm family gathering" / "reunion" as a cue to
    // paint figures into a plate that must stay people-free — the painted-in
    // figure then survives as a phantom duplicate once the real character
    // cutouts are composited on top. Name-stripping alone misses these because
    // the mood phrase carries no character name.
    .split(/(?<=[.!?])\s+/)
    .filter(s => !/\b(gathering|gather|gathers|reunion|crowd|together|everyone|group portrait|family portrait)\b/i.test(s))
    .join(' ')
    .trim();
  return sanitizeVbIdsInPrompt(stripped, visualBible, pageNumber);
}

/**
 * Iterate a cover page: rebuild prompt from templates, select characters,
 * build landmark/VB references, generate new image. The single entry point
 * for every cover-render call site — unified-pipeline auto-repair, dev-mode
 * iterate button, and user-triggered "regenerate cover" all funnel through
 * here so there's exactly one place that decides composite vs direct.
 *
 * @param {string} coverKey - 'frontCover' | 'initialPage' | 'backCover'
 * @param {Object} storyData - Full story data (characters, visualBible, etc.)
 * @param {Object} options
 * @param {string} [options.imageModel] - Image model override
 * @param {Object} [options.evaluationFeedback] - { score, reasoning, fixableIssues }
 * @param {boolean} [options.useOriginalAsReference] - Pass current image as reference
 * @param {boolean} [options.blackoutIssues] - Black out issue regions
 * @param {Function} [options.usageTracker] - Usage tracking callback
 * @param {Array} [options.freshCharacters] - Fresh characters from DB (optional, for avatar merging)
 * @param {Array<number>} [options.selectedCharacterIds] - Filter cover characters to this set of IDs (user-regenerate UI feature)
 * @returns {Promise<Object>} { imageData, score, reasoning, modelId, prompt, referencePhotos, landmarkPhotos, visualBibleGrid, grokRefImages }
 */
async function iterateCover(coverKey, storyData, options = {}) {
  const {
    imageModel = null,
    evaluationFeedback = null,
    useOriginalAsReference = false,
    blackoutIssues = false,
    usageTracker = null,
    freshCharacters = null,
    selectedCharacterIds = null,
    // Explicit template override (Test Lab A/B runs) — replaces whichever
    // cover template would be selected below. Never swap PROMPT_TEMPLATES
    // keys around this async function; pass the override here instead.
    promptTemplateOverride = null,
    // Post-generation callers (user-triggered regen/iterate routes) set this
    // so a story WITHOUT a ${coverKey}Art row — generated before app-side
    // cover typography — still gets its title/dedication stamped onto the
    // fresh textless render. Without it those stories served a TITLE-LESS
    // cover on regen (the "initial bake handles it" assumption only holds
    // during story generation). Stamping here is safe: the input is always a
    // fresh textless render, never an already-titled image. Side effect: the
    // returned artImageData gets persisted by the caller, upgrading the old
    // story to editable cover text from that version on.
    forceRestampWhenUnbaked = false,
    // Pipeline callers (executeIterateAction) score round results themselves
    // (round detect + batch eval), so they pass skipEval to keep covers
    // evaluated exactly once. External callers (cover regen routes, Test Lab)
    // keep the scored contract: eval + detection run here.
    skipEval = false,
  } = options;

  const {
    getCharacterPhotoDetails,
    parseClothingCategory,
    buildCharacterReferenceList,
    buildReferenceCardColours,
    buildCoverPrompt,
    convertClothingToCurrentFormat,
    buildCharacterRestriction,
  } = getStoryHelpers();

  const {
    generateImageOnly,
    _maybeGenerateComposite,
    evaluateImageQuality,
    detectAllBoundingBoxes,
    createBboxOverlayImage,
    generateImageCacheKey,
    deleteFromImageCache,
  } = require('./images');
  const { blackoutIssueRegions } = require('./imageInpainting');

  const { buildFullVisualBiblePrompt } = require('./visualBible');

  // Get existing cover data. After the R2 migration `imageData` is stripped
  // from the JSON blob on save (bytes live in story_images + R2 URLs), so
  // requiring `imageData` to be non-null falsely rejected migrated stories
  // — including the test-models composite-preview path, which doesn't read
  // the existing image at all. Just require the cover record to exist; the
  // few downstream branches that DO need bytes (useOriginalAsReference /
  // blackoutIssues) rehydrate from story_images on-demand below.
  storyData.coverImages = storyData.coverImages || {};
  const existingCover = storyData.coverImages[coverKey];
  if (!existingCover) {
    throw new Error(`No cover image found for ${coverKey}`);
  }

  // Strip any perspective/depth annotations from the cover description.
  // Covers are group portraits — every character must face the viewer (see story-unified.txt
  // COVER RULES). If Claude slipped a `, depth: background, perspective: back view` into a
  // cover Characters line, drop it here so the cover prompt never sees it.
  const stripCoverAnnotations = (text) => {
    if (!text || typeof text !== 'string') return text;
    let stripped = text.replace(/(\s*,\s*(?:depth|perspective|position)\s*:\s*[^,\r\n]+)+/gi, '');
    // Count how many lines we touched for logging
    const stripCount = (text.match(/(?:depth|perspective|position)\s*:/gi) || []).length;
    if (stripCount > 0) {
      log.warn(`🔄 [COVER-ITERATE] ${coverKey}: Stripped ${stripCount} perspective/depth annotation(s) from cover description (covers must show all characters facing forward)`);
    }
    return stripped;
  };
  const rawSceneDescription = existingCover.description || 'A beautiful illustrated cover page.';
  const sceneDescription = stripCoverAnnotations(rawSceneDescription);
  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Using stored description (${sceneDescription.length} chars)`);

  // --- Art style ---
  const artStyleId = storyData.artStyle || 'pixar';
  const coverModel = MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
  const coverBackend = IMAGE_MODELS[coverModel]?.backend || null;
  const styleDescription = resolveArtStyle(artStyleId, coverBackend) || resolveArtStyle('pixar');

  // --- Characters ---
  const characters = storyData.characters || [];
  const visualBible = storyData.visualBible || null;

  // Parse clothing from the cover's own scene description, then the story's
  // primary category. NO DEFAULT (owner, 2026-08-07): 'standard' is a category
  // most stories never use, so it has no description and resolves to the
  // character's stored wardrobe from an unrelated story — on a cover, the most
  // visible page in the book.
  const coverClothing = parseClothingCategory(sceneDescription)
    || storyData.pageClothing?.primaryClothing;
  if (!coverClothing) {
    throw new Error(`[COVER] No clothing category: the cover scene description names none and the story has no primaryClothing. Refusing to default to 'standard'.`);
  }
  const clothingRequirements = convertClothingToCurrentFormat(storyData.clothingRequirements);

  // Re-hydrate avatars from the fresh characters-table rows. The usable-avatar
  // check matters: generation can leave a present-but-empty shell on the story
  // blob ({} or {styledAvatars:{}}) when the styled-avatar persist runs after
  // upsertStory. The old truthy-existence guard treated that shell as "has
  // avatars", skipped the fresh merge, and the composite cover then found
  // neither styled nor base avatars → every figure dropped → "No figures could
  // be assembled" → character-less Überarbeiten covers.
  const { mergeFreshAvatars } = require('./characterPhotos');
  const mergedCharacters = mergeFreshAvatars(
    characters, freshCharacters, artStyleId,
    (msg) => log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${msg}`)
  );

  // Character selection: use cover hints (authoritative) > scene description > fallback
  const MAX_COVER_CHARACTERS = 5;
  const normalizedCoverType = coverKeyToType(coverKey);

  // Cover hints from outline — authoritative character list with per-character clothing
  const coverHint = storyData.coverHints?.[coverKey];
  const hintCharClothing = coverHint?.characterClothing;

  let coverCharacterPhotos;
  let selectedCoverCharacters;
  // Hint-derived casts are authoritative (owner rule — see narrowCoverCastToMains):
  // the main-only narrowing below must never drop a hint-listed character.
  let castFromHint = false;

  if (hintCharClothing && Object.keys(hintCharClothing).length > 0) {
    castFromHint = true;
    // Primary: use outline's character list (matches initial generation logic)
    const hintCharNames = Object.keys(hintCharClothing);
    selectedCoverCharacters = mergedCharacters.filter(c =>
      hintCharNames.some(name => name.trim().toLowerCase() === String(c.name || '').trim().toLowerCase())
    ).slice(0, MAX_COVER_CHARACTERS);
    // Merge hint clothing into clothingRequirements for avatar lookup
    const mergedClothing = { ...clothingRequirements };
    for (const [charName, clothing] of Object.entries(hintCharClothing)) {
      mergedClothing[charName] = { ...(mergedClothing[charName] || {}), _currentClothing: clothing };
    }
    coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, mergedClothing);
    log.info(`🔄 [COVER-ITERATE] ${coverKey}: Selected ${selectedCoverCharacters.map(c => c.name).join(', ')} from coverHints`);
  } else {
    // Fallback: extract characters mentioned in the scene description
    const sceneDescLower = sceneDescription.toLowerCase();
    const mentionedChars = mergedCharacters.filter(c => sceneDescLower.includes(c.name.toLowerCase()));

    if (mentionedChars.length > 0) {
      selectedCoverCharacters = mentionedChars.slice(0, MAX_COVER_CHARACTERS);
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Selected ${selectedCoverCharacters.map(c => c.name).join(', ')} from scene description`);
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    } else {
      // Last fallback: main chars for front, split for others
      const mainChars = mergedCharacters.filter(c => c.isMainCharacter === true);
      const nonMainChars = mainChars.length > 0
        ? mergedCharacters.filter(c => !c.isMainCharacter)
        : mergedCharacters;
      if (normalizedCoverType === 'front') {
        selectedCoverCharacters = mainChars.length > 0 ? mainChars : mergedCharacters;
      } else {
        const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
        const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
        const halfPoint = Math.ceil(nonMainChars.length / 2);
        const extras = normalizedCoverType === 'initialPage'
          ? nonMainChars.slice(0, halfPoint).slice(0, extraSlots)
          : nonMainChars.slice(halfPoint).slice(0, extraSlots);
        selectedCoverCharacters = [...mainCapped, ...extras];
      }
      selectedCoverCharacters = selectedCoverCharacters.slice(0, MAX_COVER_CHARACTERS);
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

  // User-supplied character filter (the "Regenerate cover" UI lets the user
  // pick which characters appear). When provided, restrict selectedCover
  // Characters to that set — overrides hint/scene-description selection.
  if (Array.isArray(selectedCharacterIds) && selectedCharacterIds.length > 0) {
    const filterSet = new Set(selectedCharacterIds);
    const filtered = selectedCoverCharacters.filter(c => filterSet.has(c.id));
    if (filtered.length > 0) {
      const dropped = selectedCoverCharacters.filter(c => !filterSet.has(c.id)).map(c => c.name);
      if (dropped.length > 0) log.info(`🔄 [COVER-ITERATE] ${coverKey}: User filter dropped: ${dropped.join(', ')}`);
      selectedCoverCharacters = filtered;
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

    // Identity lines for the detector, built once and used by BOTH detection
    // calls below (gen-time and the composite re-detect). It used to be a const
    // inside the `if (!skipEval ...)` block, so the second call referenced an
    // out-of-scope name and threw a ReferenceError — swallowed by its own
    // try/catch, which logged "detection failed" and served the cover with no
    // bboxes at all. A function keeps one definition without hoisting the work
    // itself: it only runs where it is called.
    // A COVER FIGURE MUST ARRIVE DRESSED (owner, 2026-08-18).
    //
    // Every figure on all three covers of job_1787001865052_lehb1p64c came back
    // with seedTrace "no garment colour in the identity line" and seeds=0, so
    // MobileSAM had nothing but a face point and the cut-outs were a face and
    // limbs with no shirt or trousers. The pages of the same story were fine:
    // they say "Wearing: A blue short-sleeved cotton t-shirt" and their seeds
    // land. The clothing existed all along — clothingRequirements holds a full
    // description per character, and every coverHint carries
    // characterClothing {Max: standard, ...}. One empty lookup dropped it, and
    // nothing downstream noticed because an unclothed identity line is
    // indistinguishable from a character who happens to have no clothing.
    //
    // So: resolve through the hint, fall back to the category the story marked
    // `used`, then to the character's own wardrobe — and SAY SO when all three
    // fail, instead of silently shipping a naked prompt.
    const buildExpectedCoverCharacters = () => {
      const coverClothingByName = hintCharClothing || {};
      const sh = getStoryHelpers();
      return (selectedCoverCharacters || []).map(c => {
        const name = c.name || c;
        if (typeof c !== 'object') return { name, description: '' };
        const clothingText = sh.buildIdentityClothingText(
          c, coverClothingByName[name], artStyleId, storyData.clothingRequirements || null,
          { label: `${coverKey} ` });
        return { name, description: sh.buildIdentityLine(c, clothingText) };
      });
    };

  // Back cover main-only narrowing — FALLBACK casts only. A hint-derived cast
  // is authoritative: every hint-listed character's avatar must be packed
  // (owner rule 2026-07-31 — see narrowCoverCastToMains).
  if (normalizedCoverType === 'back' && selectedCoverCharacters.length > 0) {
    const { characters: mainOnly, dropped, applied } = narrowCoverCastToMains(selectedCoverCharacters, {
      castFromHint,
      mainIds: storyData.mainCharacters,
    });
    if (applied) {
      log.info(`🔄 [COVER-ITERATE] backCover: Dropping non-main characters (fallback cast): ${dropped.join(', ')}`);
      selectedCoverCharacters = mainOnly;
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
    }
  }

  // Apply styled avatars (skip if photos already have styled data from story persistence)
  const allAlreadyStyled = coverCharacterPhotos.every(p =>
    p.photoType?.startsWith('styled-') || p.photoType?.startsWith('costumed-')
  );
  if (!allAlreadyStyled && !coverClothing.startsWith('costumed')) {
    coverCharacterPhotos = applyStyledAvatars(coverCharacterPhotos, artStyleId);
  }
  // Phase 7: cell-crop refs from story-scoped 2×4 sheets when present.
  // Covers use front pose by default (head-on shot).
  {
    const sav = require('./storyAvatars');
    const fakeMeta = (coverCharacterPhotos || []).map(p => ({ name: p.name, pose: 'front', flip: false }));
    await sav.applyStoryCellRefs(coverCharacterPhotos, storyData.characterAvatars || null, fakeMeta);
  }

  log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${coverCharacterPhotos.length} characters, clothing: ${coverClothing}`);

  // --- Build cover prompt ---
  // KEY STORY ELEMENTS filtered to what the cover hint actually asks for
  // (objects ∪ holds); worn-vs-held dedupe resolves the "same item as both
  // clothing and artifact" contradiction before any text block is built.
  const hintElementIds = collectCoverHintElementIds(coverHint);
  const { photos: clothingDedupedPhotos, excludeElementIds } =
    applyCoverWornHeldDedupe(coverCharacterPhotos, coverHint, visualBible);
  const visualBiblePrompt = visualBible
    ? buildFullVisualBiblePrompt(visualBible, {
        skipMainCharacters: true,
        allowedElementIds: hintElementIds,
        excludeElementIds,
      })
    : '';
  // Identical to the page path (owner, 2026-08-26): the per-character block
  // binds each garment to its wearer, and the colour legend says which framed
  // reference card is whom. grok.js frames cover cards exactly as it frames page
  // cards; covers were the only consumer shipping those frames with no key.
  const characterRefList = buildCharacterReferenceList(clothingDedupedPhotos, storyData.characters, { includeClothing: true })
    + buildReferenceCardColours(
        (storyData.characters || []).filter(c => clothingDedupedPhotos.some(p => p.name === c.name)),
        clothingDedupedPhotos
      );
  const storyTitle = storyData.title || 'My Story';
  const coverDedication = storyData.dedication;

  // ONE builder for covers and pages (owner, 2026-08-26). This used to fill one
  // of four cover-only templates here, a second copy in the streaming cover and
  // a third in the trial cover — three parallel paths that never received what
  // pages got. Cover art is generated TEXTLESS and the title is composited by
  // the typography pass afterwards, so no template needs a TITLE block.
  const groupComposition = normalizedCoverType === 'initialPage'
    ? buildInitialPageComposition(coverCharacterPhotos.length)
    : '';
  // `let`, not `const`: the character restriction, the evaluation feedback and
  // the VB-id sanitizer below all REASSIGN this. Same regression as the
  // streaming cover path (c0d594a75) — as a const, every cover regeneration
  // threw "Assignment to constant variable" before reaching the image model.
  let coverPrompt = buildCoverPrompt(normalizedCoverType, {
    sceneDescription,
    inputData: { ...storyData, artStyle: artStyleId },
    characters: (storyData.characters || []).filter(c => clothingDedupedPhotos.some(p => p.name === c.name)),
    visualBible,
    referencePhotos: clothingDedupedPhotos,
    groupComposition,
    options: {
      customStyleDescription: styleDescription,
      characterReferenceListOverride: characterRefList,
      visualBibleOverride: visualBiblePrompt,
      promptTemplateOverride,
    },
  });

  // Explicit character restriction. The reference-photo filter above drops an
  // excluded character's photo, but the cover prose still names them and the
  // image model draws anyone it's told about (a supporting character reappeared
  // on a back cover the user regenerated without them). Same restriction the
  // scene-page regen uses — exclude anyone not in the final cover cast.
  {
    const selectedNames = selectedCoverCharacters.map(c => c.name).filter(Boolean);
    const excludedNames = mergedCharacters.map(c => c.name).filter(n => n && !selectedNames.includes(n));
    const restriction = buildCharacterRestriction(selectedNames, excludedNames);
    if (restriction) {
      coverPrompt += restriction;
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: character restriction — show [${selectedNames.join(', ')}], exclude [${excludedNames.join(', ')}]`);
    }
  }

  // Append evaluation feedback
  if (evaluationFeedback) {
    const feedbackParts = [];
    if (evaluationFeedback.reasoning) {
      feedbackParts.push(`IMPORTANT - The previous generation had these quality issues that MUST be fixed:\n${evaluationFeedback.reasoning}`);
    }
    if (evaluationFeedback.fixableIssues?.length > 0) {
      feedbackParts.push('Specific problems to avoid:\n' +
        evaluationFeedback.fixableIssues.slice(0, 10).map(i => `- ${i.description || i.issue || i}`).join('\n'));
    }
    if (feedbackParts.length > 0) {
      coverPrompt = `${coverPrompt}\n\n${feedbackParts.join('\n\n')}`;
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Appended evaluation feedback (score: ${evaluationFeedback.score ?? 'N/A'})`);
    }
  }

  // Final chokepoint — same VB-id protection buildImagePrompt gives pages.
  // The deterministic hint builder falls back to the bare id when `holds`
  // references an id missing from hint.objects, and evaluation feedback
  // quotes ids back verbatim ("missing ART002") — resolve them all here so
  // no raw id reaches the image model as paintable text.
  {
    const { sanitizeVbIdsInPrompt } = getStoryHelpers();
    coverPrompt = sanitizeVbIdsInPrompt(coverPrompt, visualBible, COVER_PAGE_NUMBERS[coverKey] ?? -1);
  }

  // Clear cache
  const cacheKey = generateImageCacheKey(coverPrompt, coverCharacterPhotos, null);
  deleteFromImageCache(cacheKey);

  // --- Build reference images ---
  // Rehydrate imageData on demand only for the two branches that actually
  // need the bytes. After R2 migration `existingCover.imageData` is usually
  // null; the active version's bytes live in story_images. Without this,
  // blackoutIssueRegions / useOriginalAsReference passed null and downstream
  // sharp operations threw "Input buffer contains unsupported image format".
  let previousImage = null;
  const needsImageBytes = blackoutIssues || useOriginalAsReference;
  let rehydratedCoverBytes = existingCover.imageData;
  if (needsImageBytes && !rehydratedCoverBytes) {
    try {
      const { getActiveVersion, getStoryImage } = require('../services/database');
      const storyId = storyData.id || storyData.storyId;
      if (storyId) {
        const activeIdx = await getActiveVersion(storyId, coverKey);
        const row = await getStoryImage(storyId, coverKey, null, activeIdx);
        // R2-1: post-migration rows have image_data NULL and bytes at imageUrl —
        // resolve from either source (inline first, else fetch the R2 URL).
        if (row?.imageData) {
          rehydratedCoverBytes = row.imageData;
        } else if (row?.imageUrl) {
          const { bytesFromAnyImage } = require('./r2');
          const buf = await bytesFromAnyImage(row.imageUrl);
          if (buf) rehydratedCoverBytes = buf.toString('base64');
        }
        if (rehydratedCoverBytes) {
          log.info(`🔄 [COVER-ITERATE] ${coverKey}: Rehydrated active version bytes from story_images (v${activeIdx})`);
        }
      }
    } catch (rehydrateErr) {
      log.warn(`🔄 [COVER-ITERATE] ${coverKey}: Rehydrate failed: ${rehydrateErr.message}`);
    }
  }
  if (blackoutIssues) {
    const fixTargets = existingCover.fixTargets || [];
    if (fixTargets.length > 0 && rehydratedCoverBytes) {
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Blacking out ${fixTargets.length} issue regions`);
      previousImage = await blackoutIssueRegions(rehydratedCoverBytes, fixTargets);
    } else {
      previousImage = rehydratedCoverBytes;
    }
  } else if (useOriginalAsReference) {
    previousImage = rehydratedCoverBytes;
  }

  // --- Build cover references (landmark photos, empty-scene plate, VB grid) ---
  // Shared with the streaming initial-gen path so v0 and iterate use the same anchors.
  const coverLabelStr = coverLabel(coverKey);
  const refs = await buildCoverReferences({
    coverKey,
    visualBible,
    artStyle: storyData.artStyle,
    sceneDescription,
    coverHint,
    logLabel: `${coverLabelStr} ITERATE`,
  });
  const {
    landmarkPhotos: coverLandmarkPhotos,
    visualBibleGrid: coverVbGrid,
    sceneBackground: rawCoverSceneBackground,
    sceneMetadata: coverSceneMetadata,
  } = refs;

  // A1 (2026-08-07) — an EDIT gets ONLY the image being edited.
  // The empty-scene plate is a style anchor for FIRST generation. Passing it
  // alongside `previousImage` gives Grok two scene-sized references, and with
  // more than one reference Grok COMPOSES instead of editing: on
  // job_1786053708336_8cdsca519 the round-1 edit ("Remove all neon signs…")
  // came back with the empty-scene background laid in as a band across the top
  // of the cover — the "background twice" the owner reported. Same failure mode
  // that made the title plate paste whole-cover content into a title crop.
  const isEditOfExistingCover = !!previousImage;

  // A2 (2026-08-07) — an EDIT must be rendered at the aspect of the image being
  // edited, not at the config constant. MODEL_DEFAULTS.coverAspect is '3:4'
  // (0.750) but real covers are 864x1222 (0.707); Grok CENTRE-CROPS every input
  // to the requested ratio, so ~6% was being sliced off each reference before
  // the model saw it, and the mismatch pushes it toward recomposition. Snap to
  // the nearest preset both Grok and Gemini accept (raw ratios are rejected).
  let coverAspectOverride = null;
  if (isEditOfExistingCover) {
    try {
      const sharpLib = require('sharp');
      const { bytesFromAnyImage } = require('./r2');
      const pbuf = Buffer.isBuffer(previousImage) ? previousImage
        : await bytesFromAnyImage(typeof previousImage === 'string' && previousImage.startsWith('data:')
          ? previousImage : `data:image/jpeg;base64,${previousImage}`);
      const pm = pbuf ? await sharpLib(pbuf).metadata() : null;
      if (pm?.width && pm?.height) {
        const r = pm.width / pm.height;
        const PRESETS = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5],
          ['1:1', 1], ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9]];
        coverAspectOverride = PRESETS.reduce((best, p2) =>
          Math.abs(p2[1] - r) < Math.abs(best[1] - r) ? p2 : best)[0];
        if (coverAspectOverride !== MODEL_DEFAULTS.coverAspect) {
          log.info(`🔄 [COVER-ITERATE] ${coverLabelStr}: editing at the source aspect ${coverAspectOverride} (${pm.width}x${pm.height} = ${r.toFixed(3)}), not the ${MODEL_DEFAULTS.coverAspect} default`);
        }
      }
    } catch (e) {
      log.warn(`🔄 [COVER-ITERATE] ${coverLabelStr}: could not measure the source aspect (${e.message}) — using ${MODEL_DEFAULTS.coverAspect}`);
    }
  }
  const coverSceneBackground = isEditOfExistingCover ? null : rawCoverSceneBackground;
  if (isEditOfExistingCover && rawCoverSceneBackground) {
    log.info(`🔄 [COVER-ITERATE] ${coverLabelStr}: edit of an existing cover — empty-scene plate withheld (it composes instead of edits)`);
  }

  // --- Composite-vs-direct decision (unchanged gate) ────────────────────
  // Composite dispatch is the standalone `_maybeGenerateComposite` route
  // helper (images.js). We decide compositeOn exactly as before and call the
  // helper directly; it returns null when the landmark-buffer prerequisite is
  // missing or the composite generator throws, and the direct render below
  // runs instead.
  //
  // options.compositeCovers === false is an explicit opt-out: the user-facing
  // "Überarbeiten" (regenerate-from-scratch) endpoint passes it so a from-scratch
  // render never routes through composite. Direct render handles up to 5 figures
  // fine (Pixar @5 verified, user decision 2026-07-19), so composite — slower,
  // needs the analyzer, looks more "assembled" — is only worth it for CROWDED
  // covers (>5 figures). The default flag gates on figure count; an explicit
  // options.compositeCovers === true (Test Lab) still forces composite.
  const coverFigureCount = coverCharacterPhotos?.length || 0;
  const compositeOn = options.compositeCovers === false
    ? false
    : options.compositeCovers === true
      ? true
      : (MODEL_DEFAULTS.compositeCovers === true && coverFigureCount > 5);
  if (!compositeOn && MODEL_DEFAULTS.compositeCovers === true && options.compositeCovers == null) {
    log.info(`🔄 [COVER-ITERATE] ${coverKey}: ${coverFigureCount} figure(s) ≤ 5 — direct render (composite reserved for >5)`);
  }

  // When composite is on, assemble the inputs the composite generator needs
  // (artifact-enriched hint + resolved landmark bytes). These stay HERE because
  // they are cover-domain producer helpers; the shared image path only consumes
  // the ready-made bundle. landmarkBuf may be null → the shared path detects the
  // missing prerequisite and renders direct (the location prose drives the
  // backdrop). options.landmarkBufOverride lets a caller (Test Lab) BORROW a
  // background plate so composite can be exercised on a landmark-less story.
  let compositeInputs = null;
  if (compositeOn) {
    // Pull artifact prop bytes + a full-VB id→name map so the composite layer
    // has everything ready (shared producer helper — same enrichment the
    // regeneration test-models path uses).
    const enrichedHint = enrichCoverHintWithArtifacts(coverHint, visualBible, { language: storyData.language });
    const landmarkBuf = options.landmarkBufOverride
      || (coverLandmarkPhotos?.[0] ? await loadLandmarkBytes(coverLandmarkPhotos[0]) : null);
    compositeInputs = {
      coverKey,
      // mergedCharacters (fresh avatars merged) so the composite pulls the same
      // costumed avatars the rest of the pipeline uses.
      characters: mergedCharacters,
      coverHint: enrichedHint,
      // Full scene prose so the composite passes carry the story-specific action
      // (who holds what, eyes on which contents) instead of generic pose templates.
      sceneDescription,
      // VB grid as a labeled reference slot for every artifact / animal /
      // secondary character the cover hint references.
      vbGrid: coverVbGrid,
      landmarkBuf,
      // Already-styled empty scene of the landmark → composite single-pass branch
      // (uses it as the figure backdrop, one Grok refinement edit, no re-style /
      // re-protect of the landmark).
      sceneBackground: coverSceneBackground,
      artStyle: storyData.artStyle || 'watercolor',
      title: storyData.title || '',
      dedication: storyData.dedication || '',
      styleHint: styleDescription,
      // Full VB — id→name resolution + final sanitize scrub on both pass prompts.
      visualBible,
      // Figure orientation strategy (Test Lab / docs/image-routing.md). Default
      // 'frontal' when unset — production behaviour unchanged.
      orient: options.orient || 'frontal',
    };
  }

  // --- Generate image (shared page generation; composite via route helper) ──
  const iterateLabel = `${coverLabelStr} ITERATE`;
  let imageResult = compositeOn
    ? await _maybeGenerateComposite({ composite: true, compositeInputs }, usageTracker, `[${iterateLabel}] `)
    : null;
  if (!imageResult) {
    // Direct render — the same generation entry pages use. Aspect is explicit:
    // the measured source aspect for edits of an existing cover, else the
    // configured cover aspect (never inferred from an evaluationType).
    const genResult = await generateImageOnly(coverPrompt, coverCharacterPhotos, {
      previousImage,
      imageModelOverride: imageModel || null,
      landmarkPhotos: coverLandmarkPhotos,
      visualBibleGrid: coverVbGrid,
      sceneBackground: coverSceneBackground,
      pageNumber: COVER_PAGE_NUMBERS[coverKey] ?? -1,
      // Covers keep their full frame — title paint depends on exact bounds.
      stripBorder: false,
      artStyle: artStyleId,
      skipCache: true,
      aspectRatio: coverAspectOverride || MODEL_DEFAULTS.coverAspect,
      captureLabel: 'image_cover',
    });
    // Usage: same provider-style cover_images bucket quality-retry emitted.
    if (usageTracker && genResult?.usage) {
      const m = genResult.modelId || '';
      const genProvider = m.startsWith('runware:') ? 'runware' : m.startsWith('grok-imagine') ? 'grok' : 'gemini_image';
      usageTracker(genProvider, genResult.usage, 'cover_images', genResult.modelId);
    }

    // Shared eval + detection — the same primitives the pipeline's Step 1 /
    // round loop use, run once here for callers that consume the scored
    // contract (regen routes, Test Lab). Pipeline callers pass skipEval and
    // score the version in their round eval instead.
    let evalScore = null;
    let evalReasoning = skipEval ? 'no gen-time eval (pipeline scores versions)' : null;
    let coverBboxDetection = null;
    let coverBboxOverlay = null;

    if (!skipEval && genResult?.imageData) {
      try {
        // evalOptions empty on purpose: the cover prompt carries the full ART
        // STYLE block, which the evaluator extracts itself (same as the old
        // gen-time eval did).
        const qualityResult = await evaluateImageQuality(
          genResult.imageData, coverPrompt, coverCharacterPhotos, 'cover', null,
          iterateLabel, null, sceneDescription, selectedCoverCharacters, {}
        );
        if (qualityResult) {
          evalScore = qualityResult.score ?? null;
          evalReasoning = qualityResult.reasoning || null;
          if (usageTracker && qualityResult.usage) {
            usageTracker('gemini_quality', qualityResult.usage, 'cover_quality', qualityResult.modelId);
          }
        }
      } catch (evalErr) {
        log.warn(`⚠️ [COVER-ITERATE] ${coverKey}: eval failed (${evalErr.message}) — serving unscored render`);
      }
      // A COVER GETS THE SAME CLOTHING INFO AS A PAGE (owner, 2026-08-15).
      //
      // This built `description: c.description || ''` - and a character object
      // has no `description` key, so every cover figure reached the detector
      // as a bare name. The three page paths were fixed earlier; this one was
      // missed, which is why cover cut-outs had no garment colours to seed
      // SAM with and Sarah's silhouette came back full of holes.
      //
      // The information was there all along: coverHints[coverKey]
      // .characterClothing is the cover's own per-character category map,
      // exactly analogous to a page's perCharClothing - on
      // job_1786780194082_s980g4s9a it reads
      //   {Emma: summer, Hans: summer, Noah: summer, Sarah: summer, Daniel: summer}
      // It simply was never passed on. Resolution goes through
      // clothingRequirements, the canonical source, like everywhere else.
      const expectedCoverCharacters = buildExpectedCoverCharacters();
      try {
        coverBboxDetection = await detectAllBoundingBoxes(genResult.imageData, {
          expectedCharacters: expectedCoverCharacters,
          expectedObjects: Array.isArray(coverSceneMetadata?.objects)
            ? coverSceneMetadata.objects.filter(o => typeof o === 'string')
            : [],
          sceneContext: sceneDescription,
          pageContext: iterateLabel,
          artStyle: artStyleId,
        });
        if (coverBboxDetection) {
          coverBboxOverlay = await createBboxOverlayImage(genResult.imageData, coverBboxDetection);
        }
      } catch (bboxErr) {
        log.warn(`⚠️ [COVER-ITERATE] ${coverKey}: detection failed (${bboxErr.message})`);
      }
    }

    imageResult = {
      imageData: genResult.imageData,
      score: evalScore,
      reasoning: evalReasoning,
      modelId: genResult.modelId,
      totalAttempts: 1,
      prompt: genResult.prompt || coverPrompt,
      grokRefImages: genResult.grokRefImages || null,
      usage: genResult.usage || null,
      bboxDetection: coverBboxDetection,
      bboxOverlayImage: coverBboxOverlay,
    };
  }

  // Composite path skips the app-side restamp (title/dedication are baked in by
  // the composite passes) but is NOT exempt from scoring or detection any more
  // (owner order 2026-08-15: covers and pages the same — an unscored version is
  // invisible to pickBestVersionIndex and previously shipped on a hard pin,
  // the docs/scoring-review.md divergence). Same eval + detection primitives as
  // the direct path above; skipEval callers still score in their round eval.
  if (imageResult.composite) {
    let compScore = null;
    let compReasoning = skipEval ? 'no gen-time eval (pipeline scores versions)' : 'composite-cover (eval failed)';
    let compBbox = null;
    let compOverlay = null;
    if (!skipEval && imageResult.imageData) {
      try {
        const qualityResult = await evaluateImageQuality(
          imageResult.imageData, coverPrompt, coverCharacterPhotos, 'cover', null,
          iterateLabel, null, sceneDescription, selectedCoverCharacters, {}
        );
        if (qualityResult) {
          compScore = qualityResult.score ?? null;
          compReasoning = qualityResult.reasoning || null;
          if (usageTracker && qualityResult.usage) {
            usageTracker('gemini_quality', qualityResult.usage, 'cover_quality', qualityResult.modelId);
          }
        }
      } catch (evalErr) {
        log.warn(`⚠️ [COVER-ITERATE] ${coverKey}: composite eval failed (${evalErr.message}) — serving unscored render`);
      }
      try {
        compBbox = await detectAllBoundingBoxes(imageResult.imageData, {
          // Same identity lines as the first detection above - a second call
          // that sends bare names would overwrite a good detection with a blind
          // one, exactly as the round re-detect used to on the page paths.
          expectedCharacters: buildExpectedCoverCharacters(),
          expectedObjects: Array.isArray(coverSceneMetadata?.objects)
            ? coverSceneMetadata.objects.filter(o => typeof o === 'string')
            : [],
          sceneContext: sceneDescription,
          pageContext: iterateLabel,
          artStyle: artStyleId,
        });
        if (compBbox) {
          compOverlay = await createBboxOverlayImage(imageResult.imageData, compBbox);
        }
      } catch (bboxErr) {
        log.warn(`⚠️ [COVER-ITERATE] ${coverKey}: composite detection failed (${bboxErr.message})`);
      }
    }
    return {
      imageData: imageResult.imageData,
      score: compScore,
      reasoning: compReasoning,
      modelId: imageResult.modelId,
      totalAttempts: imageResult.totalAttempts || 1,
      prompt: imageResult.prompt,
      referencePhotos: coverCharacterPhotos,
      landmarkPhotos: coverLandmarkPhotos,
      visualBibleGrid: null,
      grokRefImages: null,
      usage: imageResult.usage,
      previousImage: rehydratedCoverBytes,
      previousScore: existingCover.qualityScore || null,
      compositeDebug: imageResult.compositeDebug,
      bboxDetection: compBbox,
      bboxOverlayImage: compOverlay,
    };
  }

  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  // App-side typography: the render above is TEXTLESS (frontCoverTextless etc.).
  // Re-composite the title / dedication / branding so the served cover keeps its
  // text after this repaint — reuses composeCover via restampCover. Expose the
  // textless bytes as artImageData so callers persist ${key}Art for future
  // no-AI title edits.
  //
  // ONLY restamp once the post-persist bake has already run — signalled by the
  // ${key}Art row existing. During INITIAL generation the cover is intentionally
  // textless and bakeCoverTypographyPostPersist stamps it later; restamping here
  // would double-bake. Post-generation repaints (regenerate/edit/repair) run
  // after the bake, so ${key}Art exists and they DO need the restamp.
  let servedImageData = imageResult.imageData;
  let artImageData = null;
  let typographySpec = null;
  // Cover art is ALWAYS generated textless now (2026-08-26) — the title,
  // dedication and branding are composited by the typography pass, which is the
  // one extra pass a cover gets over a page. There is no longer a text-baking
  // template to gate this on.
  {
    let bakeAlreadyRan = false;
    try {
      const { dbQuery } = require('../services/database');
      const rows = await dbQuery("SELECT 1 FROM story_images WHERE story_id=$1 AND image_type=$2 LIMIT 1", [storyData.id, `${coverKey}Art`]);
      bakeAlreadyRan = rows.length > 0;
    } catch (e) { /* check failed → skip restamp (safe: textless served, initial bake handles it) */ }
    if (bakeAlreadyRan || forceRestampWhenUnbaked) {
      try {
        const { restampCover } = require('./coverTypography');
        const figures = existingCover.bboxDetection?.figures || [];
        const stamped = await restampCover(storyData, coverKey, imageResult.imageData, { seed: storyData.title, figures });
        servedImageData = stamped.titledData;
        artImageData = stamped.textlessData;
        typographySpec = stamped.spec;
        // The detection ran on the textless render; the served bytes are the
        // stamped ones. Re-point the fp (the ONLY sanctioned fp restamp — see
        // restampDetectionForCoverText) so the stored boxes stay pairable.
        if (imageResult.bboxDetection) {
          require('./images').restampDetectionForCoverText(imageResult.bboxDetection, servedImageData);
        }
        log.info(`🅰️ [COVER-ITERATE] ${coverKey}: re-composited text (${typographySpec?.fontId || '?'}/${typographySpec?.layout || '?'})`);
      } catch (e) {
        log.warn(`⚠️ [COVER-ITERATE] ${coverKey}: restamp failed (${e.message}) — serving textless render`);
      }
    }
  }

  return {
    imageData: servedImageData,
    artImageData,
    typography: typographySpec,
    score: imageResult.score,
    reasoning: imageResult.reasoning,
    modelId: imageResult.modelId,
    totalAttempts: imageResult.totalAttempts,
    prompt: coverPrompt,
    referencePhotos: coverCharacterPhotos,
    landmarkPhotos: coverLandmarkPhotos,
    visualBibleGrid: coverVbGrid ? `data:image/jpeg;base64,${coverVbGrid.toString('base64')}` : null,
    grokRefImages: imageResult.grokRefImages || null,
    usage: imageResult.usage,
    previousImage: rehydratedCoverBytes,
    previousScore: existingCover.qualityScore || null,
    // Detection is part of every image version (owner decision 2026-07-31).
    // Computed by the shared detection above (skipEval callers get theirs
    // from the pipeline's round detect instead).
    bboxDetection: imageResult.bboxDetection || null,
    bboxOverlayImage: imageResult.bboxOverlayImage || null,
  };
}

// Helper: turn a landmark-photo entry from getLandmarkPhotosForScene
// (could be { photoUrl, photoData, ... }) into a Buffer.
async function loadLandmarkBytes(lm) {
  if (!lm) return null;
  const r2 = require('./r2');
  const candidates = [lm.photoUrl, lm.photoData].filter(s => typeof s === 'string' && s.length > 0);
  for (const src of candidates) {
    try {
      const buf = await r2.bytesFromAnyImage(src);
      if (buf) return buf;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build the cover-specific reference set (landmark photos, optional empty-scene
 * background plate, VB grid) so initial-gen and iterate can both use the same
 * anchors. Returns the same shape both call sites pass into
 * the shared generation call (generateImageOnly + composite route helper).
 *
 * @param {Object} args
 * @param {string} args.coverKey - 'frontCover' | 'initialPage' | 'backCover'
 * @param {Object} [args.visualBible]
 * @param {string} [args.artStyle]
 * @param {string} args.sceneDescription
 * @param {Object} [args.coverHint] - storyData.coverHints[coverKey]: { objects: ['LOC###','ART###',...] }
 * @param {Object} [args.sceneMetadata] - pre-computed metadata from scene expansion. When provided, replaces the extractSceneMetadata + landmark-name-match path.
 * @param {string} [args.imageModel] - empty-scene model override
 * @param {string} [args.imageBackend] - empty-scene backend override
 * @param {string} [args.emptyScenePromptOverride] - structured emptyScenePrompt from scene expansion
 * @param {Function} [args.usageTracker] - (usage, modelId) => void for empty-scene cost tracking
 * @param {string} [args.logLabel] - prefix for log lines (defaults to cover label)
 * @returns {Promise<{landmarkPhotos: Array, visualBibleGrid: Buffer|null, sceneBackground: string|null, sceneMetadata: Object|null, coverPageNumber: number}>}
 */
async function buildCoverReferences({
  coverKey,
  visualBible,
  artStyle,
  sceneDescription,
  coverHint = null,
  sceneMetadata: sceneMetadataInput = null,
  imageModel = null,
  imageBackend = null,
  emptyScenePromptOverride = null,
  usageTracker = null,
  logLabel = null,
}) {
  const { resolveArtStyle, resolveArtStyleForEmptyScene, extractSceneMetadata, getLandmarkPhotosForScene } = getStoryHelpers();
  const { generateImageOnly } = require('./images');
  const { buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./referenceSheets');
  const { getElementReferenceImagesForPage, getElementReferenceImagesByIds } = require('./visualBible');

  const label = logLabel || coverLabel(coverKey);

  // Resolve scene metadata: caller-provided wins; otherwise try parsing the
  // description (rarely succeeds for covers — they're plain prose) and fall
  // back to name-matching real landmarks against the text.
  let sceneMetadata = sceneMetadataInput || extractSceneMetadata(sceneDescription);
  if (!sceneMetadata && visualBible?.locations) {
    const matchedObjects = [];
    const sceneTextLower = (sceneDescription || '').toLowerCase();
    for (const loc of visualBible.locations) {
      if (!loc.isRealLandmark) continue;
      const nameMatch = loc.name && sceneTextLower.includes(loc.name.toLowerCase());
      const queryMatch = loc.landmarkQuery && sceneTextLower.includes(loc.landmarkQuery.toLowerCase());
      if (nameMatch || queryMatch) {
        matchedObjects.push(loc.id ? `${loc.name} [${loc.id}]` : loc.name);
      }
    }
    if (matchedObjects.length > 0) {
      sceneMetadata = { objects: matchedObjects };
    }
  }

  // Merge LOC IDs from coverHint.objects into sceneMetadata.objects so the
  // landmark photo lookup picks them up (cover scene expansion typically
  // emits ART IDs only — without this merge the explicit landmark from the
  // outline would be silently dropped).
  //
  // Photo-bearing non-landmarks (curated locations like Limmatufer) need a
  // separate channel: getLandmarkPhotosForScene gates on isRealLandmark and
  // would drop them. Track them here and append directly to landmarkPhotos
  // below so the composite-cover pipeline gets a backdrop.
  const photoOnlyLocs = [];
  if (coverHint?.objects && coverHint.objects.length > 0 && visualBible?.locations) {
    const matchedLocs = [];
    for (const id of coverHint.objects) {
      if (typeof id !== 'string' || !/^LOC\d+/i.test(id)) continue;
      const loc = visualBible.locations.find(l => l.id && l.id.toUpperCase() === id.toUpperCase());
      if (!loc) continue;
      // Locations carry photos under two field families (referencePhoto* is
      // the landmark path's, referenceImage* the older curated one) — accept both.
      const photoUrl = loc.referencePhotoUrl || loc.referenceImageUrl || null;
      const photoData = loc.referencePhotoData || loc.referenceImageData || null;
      if (loc.isRealLandmark) {
        matchedLocs.push(`${loc.name} [${loc.id}]`);
      } else if (photoUrl || photoData) {
        // Curated photo location — usable as a cover backdrop even though it's
        // not a real Wikidata-sourced landmark. Don't go through
        // getLandmarkPhotosForScene (which gates on isRealLandmark); load
        // directly and append to landmarkPhotos.
        photoOnlyLocs.push({
          name: loc.name,
          photoUrl,
          photoData,
          source: 'curated-non-landmark',
          attribution: loc.attribution || loc.photoAttribution || null,
        });
        log.info(`🔗 [COVER-REFS] ${label}: using curated photo from ${loc.id} (${loc.name}) — not a real landmark but has a usable photo`);
      } else {
        log.info(`🔗 [COVER-REFS] ${label}: invented location ${loc.id} (${loc.name}) — composite path skipped, using normal generation`);
      }
    }
    if (matchedLocs.length > 0) {
      const existing = (sceneMetadata?.objects || []).filter(Boolean);
      const existingLocSet = new Set(
        existing
          .map(o => (typeof o === 'string' ? o : o?.id || '').match(/LOC\d+/i)?.[0]?.toUpperCase())
          .filter(Boolean)
      );
      const toAppend = matchedLocs.filter(m => !existingLocSet.has(m.match(/LOC\d+/i)?.[0]?.toUpperCase()));
      sceneMetadata = { ...(sceneMetadata || {}), objects: [...existing, ...toAppend] };
    }
  }

  let landmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];
  // Append curated non-landmark photos so the composite path's landmarkBuf
  // resolves and pass 2 (watercolor + landmark) actually runs. Without this
  // back covers whose outline picked a curated location (e.g. Limmatufer
  // Baden) silently fell back to figures-on-white because pass 2 was skipped.
  if (photoOnlyLocs.length > 0) {
    landmarkPhotos = [...landmarkPhotos, ...photoOnlyLocs];
  }

  const coverPageNumber = COVER_PAGE_NUMBERS[coverKey] ?? -1;

  // --- Generate empty scene for style anchoring ---
  // Respect MODEL_DEFAULTS.singlePassScene: when true (the default), pages render
  // in a single pass with no plate.
  let sceneBackground = null;
  if (MODEL_DEFAULTS.singlePassScene === true) {
    log.info(`🎛️ [COVER-REFS] ${label}: singlePassScene=true — skipping empty-scene plate`);
  } else {
    try {
      const artStyleDesc = resolveArtStyleForEmptyScene(artStyle || 'pixar')
        || resolveArtStyle(artStyle || 'pixar')
        || '';
      const emptyDescRaw = emptyScenePromptOverride
        || `**SETTING:** ${sceneDescription}\n**CAMERA:** wide shot`;
      // The plate must be PEOPLE-FREE. Covers fall back to the full
      // group-portrait prose, so drop every sentence that names a character
      // (those sentences also carry the held VB props) — a placeholder
      // figure left on the plate survives into the final render as a
      // phantom duplicate, and a raw "ART002" gets painted as a literal sign.
      const coverCastNames = [
        ...Object.values(coverHint?.characterDetails || {}).map(d => d?.name),
        ...(Array.isArray(coverHint?.characters) ? coverHint.characters : []),
        ...((visualBible?.mainCharacters || []).map(c => c?.name)),
        ...((visualBible?.secondaryCharacters || []).map(c => c?.name)),
      ];
      const emptyDesc = buildPlateDescription(emptyDescRaw, coverCastNames, visualBible, coverPageNumber);
      const { buildEmptyScenePrompt } = require('../services/prompts');
      const emptyPrompt = buildEmptyScenePrompt({
        style: artStyleDesc,
        // Covers paste the figures at a fixed bottom-centre position (see
        // coverComposite.js groundY), so the plate MUST paint solid dry ground
        // across the bottom or the figures land in whatever is there — on a
        // beach/lakeside/river scene that is open water, and the single Grok
        // pass cannot reliably carve a bank out of a "preserve the water" plate.
        // Plate-level variant of the canonical SOLID-GROUND rule (docs/
        // decisions.md) — plates prepare the ground BEFORE figures exist,
        // so this speaks about the frame band, not about feet.
        characterSpace: 'The bottom fifth of the frame must be solid dry standing ground spanning the full width — sand above the waterline, beach berm, boardwalk, grass, path, stone, or deck — where the characters will stand firmly. Any ocean, river, lake, surf, pool, or open water stays in the mid-ground or higher and never touches the bottom edge of the frame.',
        description: emptyDesc,
        // Named landmark-fidelity block when a landmark photo is attached
        // below — '' otherwise (was trial-only).
        landmarkFidelity: getStoryHelpers().buildLandmarkFidelityBlock(landmarkPhotos?.[0]),
        visualBible,
        pageNumber: coverPageNumber,
      });
      const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, coverPageNumber, landmarkPhotos);
      const emptyOptions = {
        landmarkPhotos,
        visualBibleGrid: emptySceneVbGrid,
        skipCache: true,
        aspectRatio: MODEL_DEFAULTS.coverAspect
      };
      if (imageModel) emptyOptions.imageModelOverride = imageModel;
      if (imageBackend) emptyOptions.imageBackendOverride = imageBackend;
      emptyOptions.stripBorder = false; // cover asset — keep full frame
      const emptyResult = await generateImageOnly(emptyPrompt, [], emptyOptions);
      if (emptyResult?.imageData) {
        sceneBackground = emptyResult.imageData;
        log.info(`🎬 [COVER-REFS] ${label}: empty scene generated for style anchoring`);
        if (usageTracker && emptyResult.usage) {
          usageTracker(emptyResult.usage, emptyResult.modelId);
        }
      }
    } catch (err) {
      log.warn(`⚠️ [COVER-REFS] ${label}: empty scene failed: ${err.message}`);
    }
  }

  // --- Build VB grid ---
  let visualBibleGrid = null;
  if (visualBible) {
    let elementRefs = getElementReferenceImagesForPage(visualBible, coverPageNumber, 6);
    if (sceneBackground) {
      elementRefs = elementRefs.filter(e => e.type !== 'location');
    }
    // Merge IDs from coverHint.objects + sceneMetadata.fullData.
    const sceneIds = [];
    for (const id of coverHint?.objects || []) {
      if (typeof id === 'string' && !id.startsWith('LOC')) sceneIds.push(id.toUpperCase());
    }
    if (sceneMetadata?.fullData) {
      for (const char of sceneMetadata.fullData.characters || []) {
        if (char.id && char.id !== 'null') sceneIds.push(char.id);
      }
      for (const obj of sceneMetadata.fullData.objects || []) {
        const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
        if (id && !id.startsWith('LOC')) sceneIds.push(id);
      }
    }
    if (sceneIds.length > 0) {
      const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds);
      const existingIds = new Set(elementRefs.map(r => r.id));
      const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
      if (newRefs.length > 0) {
        log.info(`🔗 [VB-MATCH] Cover ${label}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
        elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
      }
    }
    // Safety net: name-match VB entries against the description when nothing else matched.
    if (elementRefs.length === 0) {
      const descLower = (sceneDescription || '').toLowerCase();
      const nameMatched = [];
      const checkEntries = (entries, type, priority) => {
        for (const entry of entries || []) {
          if ((!entry.referenceImageData && !entry.referenceImageUrl) || !entry.name) continue;
          if (!descLower.includes(entry.name.toLowerCase())) continue;
          nameMatched.push({
            id: entry.id,
            name: entry.name,
            type,
            description: entry.extractedDescription || entry.description,
            referenceImageData: entry.referenceImageData,
            referenceImageUrl: entry.referenceImageUrl,
            priority,
          });
        }
      };
      checkEntries(visualBible.secondaryCharacters, 'character', 1);
      checkEntries(visualBible.animals, 'animal', 2);
      checkEntries(visualBible.artifacts, 'artifact', 3);
      checkEntries(visualBible.vehicles, 'vehicle', 4);
      if (nameMatched.length > 0) {
        nameMatched.sort((a, b) => a.priority - b.priority);
        elementRefs = nameMatched.slice(0, 6);
        log.info(`🔗 [VB-NAME-MATCH] Cover ${label}: Matched ${elementRefs.length} VB entries by name: ${elementRefs.map(r => r.id || r.name).join(', ')}`);
      }
    }
    const secondaryLandmarks = landmarkPhotos.slice(1);
    if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
      visualBibleGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
    }
  }

  if (landmarkPhotos.length > 0 || visualBibleGrid) {
    log.debug(`🔗 [COVER-REFS] ${label}: ${landmarkPhotos.length} landmark photos, VB grid: ${visualBibleGrid ? 'yes' : 'no'}`);
  }

  return { landmarkPhotos, visualBibleGrid, sceneBackground, sceneMetadata, coverPageNumber };
}

/**
 * Build a deterministic SCENE prose string from a structured coverHint.
 *
 * This REPLACES the previous Haiku scene-expansion call for covers. The
 * outline already produced everything we need (mood + objects + per-
 * character details with holds/priority — gaze is code-owned, always the
 * viewer); this function templates
 * those structured fields into the SCENE string the cover prompt templates
 * (frontCover.txt / initialPage*.txt / backCover.txt) expect.
 *
 * Zero LLM calls. Pure JavaScript. Same result every time for the same input.
 *
 * Used by:
 *  - server.js streaming cover initial-gen (no second LLM call needed)
 *  - coverIterate.js iterate path (when stored description is missing or
 *    the caller wants a fresh deterministic rebuild)
 *  - regeneration.js user-triggered regenerate
 *
 * @param {Object} hint - coverHint shape from extractCoverHints():
 *                        { mood, objects, characterDetails, characters,
 *                          characterClothing, hint? }
 * @param {Object} visualBible - story.visualBible (for landmark + artifact name lookup)
 * @param {Array<Object>} characters - scene characters with physical traits
 * @param {Object} [opts]
 * @param {string} [opts.language] - STORY language. Image-facing cover prompts
 *   are English-only: the hint's free-text `Mood:` is model-authored in the
 *   story language, so it is only emitted verbatim when the story language is
 *   English — for any other language it is dropped (the cover templates carry
 *   their own atmosphere lines). Deterministic; see docs/decisions.md.
 * @returns {string} SCENE prose ready to drop into the cover prompt template
 */
function buildCoverSceneFromHint(hint, visualBible, characters, opts = {}) {
  if (!hint) return '';

  const language = String(opts.language || 'en').trim().toLowerCase();
  const isEnglish = language === 'en' || language.startsWith('en-') || language === 'english';

  // Resolve the backdrop from the first LOC### in objects. The bare location
  // name is story-language and — for invented locations — carries zero visual
  // information, so inline the VB entry's visual fields (features/colors/
  // signatureElement) right after it.
  const objects = Array.isArray(hint.objects) ? hint.objects : [];
  const locId = objects.find(o => typeof o === 'string' && /^LOC\d+/i.test(o));
  const loc = locId && Array.isArray(visualBible?.locations)
    ? visualBible.locations.find(l => l?.id && l.id.toUpperCase() === locId.toUpperCase())
    : null;
  const landmarkName = (loc && englishLocationRef(loc))
    || (locId ? 'the landmark' : 'a scenic outdoor setting');

  // Resolve any VB id (ART/ANI/VEH/CLO) to its VB entry across all pools.
  // The outline sometimes declares `holds: ART001` without listing ART001 in
  // hint.objects (spec gap: holds ⊆ objects is not enforced), so resolution
  // must NOT depend on the objects list — an unresolved id here propagates
  // into the scene description, where the final sanitizer used to drop the
  // entire single-line description (empty SCENE section, lost layout).
  const holdablePools = [
    ['artifacts', 'object'],
    ['animals', 'animal'],
    ['vehicles', 'vehicle'],
    ['clothing', 'outfit'],
  ];
  const resolveHoldable = (id) => {
    const upper = String(id || '').toUpperCase();
    for (const [pool, genericNoun] of holdablePools) {
      const arr = Array.isArray(visualBible?.[pool]) ? visualBible[pool] : [];
      const hit = arr.find(e => e?.id && String(e.id).toUpperCase() === upper);
      // English-only prompt: never emit the story-language VB NAME as the
      // thing to hold — use the English descriptor built from the entry's
      // description (animals keep their proper name, like characters do).
      if (hit) {
        if (pool === 'animals' && hit.name) return hit.name;
        return englishEntityRef(hit, genericNoun);
      }
    }
    return null;
  };

  // Sort characters by priority (essential first, then normal, then low) so
  // the most important figures lead the prose.
  const PRIO_RANK = { essential: 0, normal: 1, low: 2 };
  const details = (hint.characterDetails && typeof hint.characterDetails === 'object')
    ? Object.values(hint.characterDetails)
    : [];
  const sortedDetails = details
    .filter(d => d && d.name)
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1));

  const charSentences = sortedDetails.map(d => {
    const pos = d.position ? `in the ${d.position}` : '';
    const physChar = Array.isArray(characters)
      ? characters.find(c => String(c?.name || '').trim().toLowerCase() === String(d.name || '').trim().toLowerCase())
      : null;
    // Brief physical descriptor — the cover prompt template's CHARACTER_REFERENCE_LIST
    // also provides per-character details, but mentioning the name in prose ties
    // pose to identity. APPARENT-AGE bucket, never the numeric age: avatar and
    // eval anchor to the bucket ("school-age boy", not "8-year-old male") and
    // scene prose forbids numeric ages — same source the scene path uses.
    let physTraits = '';
    if (physChar) {
      const { extractCharacterVisualProfile } = getStoryHelpers();
      const prof = extractCharacterVisualProfile(physChar);
      const bucket = prof.ageCategory ? prof.ageCategory.replace(/-/g, ' ') : null;
      const term = prof.genderTerm || null;
      physTraits = bucket && term ? `a ${bucket} ${term}` : (term ? `a ${term}` : '');
    }
    const intro = physTraits ? `${d.name}, ${physTraits},` : `${d.name}`;

    // Action: holds resolved; gaze is code-owned (decision 2026-07-11):
    // covers are head-on portraits, every figure looks at the viewer. Any
    // parsed `gazes at:` value (old stored stories) is ignored.
    const holds = String(d.holds || '').trim();
    const parts = [];
    if (pos) parts.push(`stands ${pos}`);
    if (holds && holds.toLowerCase() !== 'nothing') {
      const m = holds.match(/^((?:ART|ANI|VEH|CLO)\d+)/i);
      const name = m ? (resolveHoldable(m[1]) || holds) : holds;
      parts.push(`holds the ${name}`);
    }
    parts.push('eyes on the viewer');
    return `${intro} ${parts.join(', ')}.`;
  });

  // Mood at the front; landmark behind everything; per-character sentences.
  // English-only guard: the hint's mood is model-authored in the STORY
  // language — only paste it when the story language is English.
  const moodPhrase = (hint.mood && isEnglish) ? `${hint.mood[0].toUpperCase()}${hint.mood.slice(1)}.` : '';
  // Scale the composition phrase to the actual cast. "Group portrait" with only
  // one or two named characters makes the model invent extra strangers to fill
  // out the "group" — so only say "group" for 3+; otherwise state the exact
  // count and forbid extra figures.
  const nChars = sortedDetails.length;
  const sceneStarter = nChars >= 3
    ? `A wide group portrait set before ${landmarkName}.`
    : nChars === 2
      ? `A portrait of two characters set before ${landmarkName}. Only these two people appear; no other figures, no crowd.`
      : `A portrait of a single character set before ${landmarkName}. Only this one person appears; no other figures, no crowd.`;
  const lines = [moodPhrase, sceneStarter, ...charSentences].filter(Boolean);
  return lines.join(' ');
}

module.exports = {
  iterateCover,
  buildCoverReferences,
  buildCoverSceneFromHint,
  stripCharacterSentences,
  buildPlateDescription,
  enrichCoverHintWithArtifacts,
  filterBackCoverToMainCharacters,
  narrowCoverCastToMains,
  // Cover-prompt hygiene helpers (shared with the streaming initial-gen path)
  collectCoverHintElementIds,
  applyCoverWornHeldDedupe,
  buildInitialPageComposition,
  englishEntityRef,
};
