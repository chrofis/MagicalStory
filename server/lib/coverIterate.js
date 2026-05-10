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

function getStoryHelpers() {
  return require('./storyHelpers');
}

/**
 * Iterate a cover page: rebuild prompt from templates, select characters,
 * build landmark/VB references, generate new image.
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
  } = options;

  const {
    getCharacterPhotoDetails,
    parseClothingCategory,
    buildCharacterReferenceList,
    convertClothingToCurrentFormat,
  } = getStoryHelpers();

  const {
    generateImageWithQualityRetry,
    generateImageCacheKey,
    deleteFromImageCache,
    blackoutIssueRegions,
  } = require('./images');

  const { buildFullVisualBiblePrompt } = require('./visualBible');

  // Get existing cover data
  storyData.coverImages = storyData.coverImages || {};
  const existingCover = storyData.coverImages[coverKey];
  if (!existingCover?.imageData) {
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

  // Parse clothing from scene description
  const coverClothing = parseClothingCategory(sceneDescription) || 'standard';
  const clothingRequirements = convertClothingToCurrentFormat(storyData.clothingRequirements);

  // Merge avatars with fresh characters if provided
  const mergedCharacters = freshCharacters
    ? characters.map(storyChar => {
        if (storyChar.avatars) return storyChar;
        const freshChar = freshCharacters.find(fc => fc.id === storyChar.id || fc.name === storyChar.name);
        if (freshChar?.avatars) {
          log.debug(`🔄 [COVER-ITERATE] ${coverKey}: Using fresh avatars for ${storyChar.name}`);
          return { ...storyChar, avatars: freshChar.avatars };
        }
        return storyChar;
      })
    : characters;

  // Character selection: use cover hints (authoritative) > scene description > fallback
  const MAX_COVER_CHARACTERS = 5;
  const normalizedCoverType = coverKey === 'frontCover' ? 'front' : coverKey === 'initialPage' ? 'initialPage' : 'back';

  // Cover hints from outline — authoritative character list with per-character clothing
  const hintKey = coverKey === 'frontCover' ? 'titlePage' : coverKey === 'initialPage' ? 'initialPage' : 'backCover';
  const coverHint = storyData.coverHints?.[hintKey];
  const hintCharClothing = coverHint?.characterClothing;

  let coverCharacterPhotos;
  let selectedCoverCharacters;

  if (hintCharClothing && Object.keys(hintCharClothing).length > 0) {
    // Primary: use outline's character list (matches initial generation logic)
    const hintCharNames = Object.keys(hintCharClothing);
    selectedCoverCharacters = mergedCharacters.filter(c =>
      hintCharNames.some(name => name.toLowerCase() === c.name.toLowerCase())
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

  // Back cover is a main-characters-only group portrait (same rule as front cover).
  // Drop any supporting characters that slipped in through the hint or scene description.
  if (normalizedCoverType === 'back' && selectedCoverCharacters.length > 0) {
    const mainIds = Array.isArray(storyData.mainCharacters) ? storyData.mainCharacters : [];
    const isMainChar = (c) =>
      c.isMainCharacter === true || (mainIds.length > 0 && mainIds.includes(c.id));
    const mainOnly = selectedCoverCharacters.filter(isMainChar);
    if (mainOnly.length > 0 && mainOnly.length !== selectedCoverCharacters.length) {
      const dropped = selectedCoverCharacters.filter(c => !isMainChar(c)).map(c => c.name).join(', ');
      log.info(`🔄 [COVER-ITERATE] backCover: Dropping non-main characters: ${dropped}`);
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

  log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${coverCharacterPhotos.length} characters, clothing: ${coverClothing}`);

  // --- Build cover prompt ---
  const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true }) : '';
  const storyTitle = storyData.title || 'My Story';
  const coverDedication = storyData.dedication;

  let coverPrompt;
  if (normalizedCoverType === 'front') {
    coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
      TITLE_PAGE_SCENE: sceneDescription,
      STYLE_DESCRIPTION: styleDescription,
      STORY_TITLE: storyTitle,
      CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
      VISUAL_BIBLE: visualBiblePrompt
    });
  } else if (normalizedCoverType === 'initialPage') {
    coverPrompt = coverDedication
      ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
          INITIAL_PAGE_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          DEDICATION: coverDedication,
          CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        })
      : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
          INITIAL_PAGE_SCENE: sceneDescription,
          STYLE_DESCRIPTION: styleDescription,
          STORY_TITLE: storyTitle,
          CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
          VISUAL_BIBLE: visualBiblePrompt
        });
  } else {
    coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
      BACK_COVER_SCENE: sceneDescription,
      STYLE_DESCRIPTION: styleDescription,
      CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(coverCharacterPhotos, storyData.characters),
      VISUAL_BIBLE: visualBiblePrompt
    });
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

  // Clear cache
  const cacheKey = generateImageCacheKey(coverPrompt, coverCharacterPhotos, null);
  deleteFromImageCache(cacheKey);

  // --- Build reference images ---
  let previousImage = null;
  if (blackoutIssues) {
    const fixTargets = existingCover.fixTargets || [];
    if (fixTargets.length > 0) {
      log.info(`🔄 [COVER-ITERATE] ${coverKey}: Blacking out ${fixTargets.length} issue regions`);
      previousImage = await blackoutIssueRegions(existingCover.imageData, fixTargets);
    } else {
      previousImage = existingCover.imageData;
    }
  } else if (useOriginalAsReference) {
    previousImage = existingCover.imageData;
  }

  // --- Build cover references (landmark photos, empty-scene plate, VB grid) ---
  // Shared with the streaming initial-gen path so v0 and iterate use the same anchors.
  const coverLabel = coverKey === 'frontCover' ? 'FRONT COVER' : coverKey === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
  const refs = await buildCoverReferences({
    coverKey,
    visualBible,
    artStyle: storyData.artStyle,
    sceneDescription,
    coverHint,
    logLabel: `${coverLabel} ITERATE`,
  });
  const {
    landmarkPhotos: coverLandmarkPhotos,
    visualBibleGrid: coverVbGrid,
    sceneBackground: coverSceneBackground,
    sceneMetadata: coverSceneMetadata,
  } = refs;

  // --- Composite Cover branch (flag-gated) ──────────────────────────────
  // When MODEL_DEFAULTS.compositeCovers is true (or modelOverrides override),
  // skip the normal generation path and use the manual-composite + 2-pass
  // Grok edit method. Same return shape so all callers stay agnostic.
  const compositeOn = options.compositeCovers === true
    || MODEL_DEFAULTS.compositeCovers === true;
  if (compositeOn) {
    try {
      const { generateCoverViaComposite } = require('./coverComposite');
      // Pull artifact images from the visual bible so the composite layer
      // has the prop bytes ready.
      const enrichedHint = { ...(coverHint || {}) };
      enrichedHint._artifactImages = {};
      enrichedHint._artifactNames = {};
      for (const id of (coverHint?.objects || [])) {
        if (!/^ART\d+/.test(String(id))) continue;
        const art = (visualBible?.artifacts || []).find(a => a?.id === id);
        if (!art) continue;
        enrichedHint._artifactNames[id] = art.name || id;
        const src = art.referenceImageUrl || art.referenceImageData;
        if (src) enrichedHint._artifactImages[id] = src;
      }
      // First landmark photo for the cover
      const landmarkBuf = coverLandmarkPhotos?.[0]
        ? await loadLandmarkBytes(coverLandmarkPhotos[0])
        : null;
      const compositeResult = await generateCoverViaComposite({
        coverKey,
        // Use mergedCharacters (with fresh avatars merged) so the composite
        // pulls the same costumed avatars the rest of the pipeline uses.
        characters: mergedCharacters,
        coverHint: enrichedHint,
        landmarkBuf,
        artStyle: storyData.artStyle || 'watercolor',
        title: storyData.title || '',
        styleHint: styleDescription,
        usageTracker,
      });
      log.info(`🎨 [COVER-ITERATE] ${coverKey}: composite-cover generated (modelId=${compositeResult.modelId})`);
      return {
        imageData: compositeResult.imageData,
        score: null, // composite path skips quality eval — returns immediately
        reasoning: 'composite-cover (no quality eval)',
        modelId: compositeResult.modelId,
        totalAttempts: compositeResult.totalAttempts || 1,
        prompt: compositeResult.prompt,
        referencePhotos: coverCharacterPhotos,
        landmarkPhotos: coverLandmarkPhotos,
        visualBibleGrid: null,
        grokRefImages: null,
        usage: { cost: 0.04, direct_cost: 0.04 }, // 2 Grok edits
        previousImage: existingCover.imageData,
        previousScore: existingCover.qualityScore || null,
        compositeDebug: compositeResult.debug,
      };
    } catch (err) {
      log.warn(`⚠️ [COVER-ITERATE] composite path failed: ${err.message} — falling back to normal path`);
    }
  }

  // --- Generate image ---
  const imageResult = await generateImageWithQualityRetry(
    coverPrompt, coverCharacterPhotos, previousImage, 'cover', null, usageTracker, null,
    { imageModel: imageModel || null },
    `${coverLabel} ITERATE`,
    { landmarkPhotos: coverLandmarkPhotos, visualBibleGrid: coverVbGrid, sceneCharacters: selectedCoverCharacters, sceneMetadata: coverSceneMetadata, sceneBackground: coverSceneBackground }
  );

  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

  return {
    imageData: imageResult.imageData,
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
    previousImage: existingCover.imageData,
    previousScore: existingCover.qualityScore || null,
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
 * generateImageWithQualityRetry's options bag.
 *
 * @param {Object} args
 * @param {string} args.coverKey - 'frontCover' | 'initialPage' | 'backCover'
 * @param {Object} [args.visualBible]
 * @param {string} [args.artStyle]
 * @param {string} args.sceneDescription
 * @param {Object} [args.coverHint] - storyData.coverHints[hintKey]: { objects: ['LOC###','ART###',...] }
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
  const { generateImageOnly, buildVisualBibleGrid, buildEmptySceneVbGrid } = require('./images');
  const { getElementReferenceImagesForPage, getElementReferenceImagesByIds } = require('./visualBible');

  const label = logLabel || (coverKey === 'frontCover' ? 'FRONT COVER' : coverKey === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER');

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
  if (coverHint?.objects && coverHint.objects.length > 0 && visualBible?.locations) {
    const matchedLocs = [];
    for (const id of coverHint.objects) {
      if (typeof id !== 'string' || !/^LOC\d+/i.test(id)) continue;
      const loc = visualBible.locations.find(l => l.id && l.id.toUpperCase() === id.toUpperCase());
      if (loc?.isRealLandmark) {
        matchedLocs.push(`${loc.name} [${loc.id}]`);
      } else if (loc) {
        log.warn(`⚠️ [COVER-REFS] ${label}: outline picked ${loc.id} (${loc.name}) but it's not a real landmark — no photo available`);
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

  const landmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];

  // Cover page numbers follow the convention used across entityConsistency, repair
  // workflow, and the streaming generator: -1 frontCover, -2 initialPage, -3 backCover.
  const COVER_PAGE_NUMBERS = { frontCover: -1, initialPage: -2, backCover: -3 };
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
      const emptyDesc = emptyScenePromptOverride
        || `**SETTING:** ${sceneDescription}\n**CAMERA:** wide shot`;
      const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
        STYLE_DESCRIPTION: artStyleDesc,
        EMPTY_SCENE_DESCRIPTION: emptyDesc,
        CHARACTER_SPACE: '',
        REQUIRED_OBJECTS: '',
        TEXT_AREA_INSTRUCTION: ''
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

module.exports = { iterateCover, buildCoverReferences };
