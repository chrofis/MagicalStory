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
    extractSceneMetadata,
    getLandmarkPhotosForScene,
    convertClothingToCurrentFormat,
  } = getStoryHelpers();

  const {
    generateImageWithQualityRetry,
    generateImageCacheKey,
    deleteFromImageCache,
    blackoutIssueRegions,
    buildVisualBibleGrid,
    buildEmptySceneVbGrid,
  } = require('./images');

  const { getElementReferenceImagesForPage, getElementReferenceImagesByIds, buildFullVisualBiblePrompt } = require('./visualBible');

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

  // Landmark photos (VB grid is built later, after the empty scene, so we can
  // dedupe anything already painted into the empty scene plate).
  // Cover descriptions are plain text (no JSON metadata), so extractSceneMetadata
  // returns null. Fall back to name-matching visual bible locations in the text.
  let coverSceneMetadata = extractSceneMetadata(sceneDescription);
  if (!coverSceneMetadata && visualBible?.locations) {
    const matchedObjects = [];
    const sceneTextLower = sceneDescription.toLowerCase();
    for (const loc of visualBible.locations) {
      if (!loc.isRealLandmark) continue;
      const nameMatch = loc.name && sceneTextLower.includes(loc.name.toLowerCase());
      const queryMatch = loc.landmarkQuery && sceneTextLower.includes(loc.landmarkQuery.toLowerCase());
      if (nameMatch || queryMatch) {
        matchedObjects.push(loc.id ? `${loc.name} [${loc.id}]` : loc.name);
      }
    }
    if (matchedObjects.length > 0) {
      coverSceneMetadata = { objects: matchedObjects };
    }
  }
  const coverLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, coverSceneMetadata) : [];

  // Cover page numbers follow the convention used across entityConsistency, repair
  // workflow, and the streaming generator: -1 frontCover, -2 initialPage, -3 backCover.
  // Used for both the empty-scene VB lookup and the composite VB grid lookup.
  const COVER_PAGE_NUMBERS = { frontCover: -1, initialPage: -2, backCover: -3 };
  const coverPageNumber = COVER_PAGE_NUMBERS[coverKey] ?? -1;

  // --- Generate empty scene for style anchoring ---
  const { generateImageOnly } = require('./images');
  const coverLabel = coverKey === 'frontCover' ? 'FRONT COVER' : coverKey === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
  let coverSceneBackground = null;
  try {
    // Use the anatomy-stripped style description for empty scenes — explicit eye/face
    // details in the style prompt cause stray faces to appear in empty backgrounds.
    const artStyleDesc = resolveArtStyleForEmptyScene(storyData.artStyle || 'pixar')
      || resolveArtStyle(storyData.artStyle || 'pixar')
      || '';
    const emptyDesc = `**SETTING:** ${sceneDescription}\n**CAMERA:** wide shot`;
    const emptyPrompt = fillTemplate(PROMPT_TEMPLATES.emptyScene, {
      STYLE_DESCRIPTION: artStyleDesc,
      EMPTY_SCENE_DESCRIPTION: emptyDesc,
      REQUIRED_OBJECTS: '',
      TEXT_AREA_INSTRUCTION: ''
    });
    // Empty scene gets a FILTERED VB grid: vehicles + non-landmark locations only
    // (chars/animals/artifacts excluded — they belong on the populated cover).
    const emptySceneVbGrid = await buildEmptySceneVbGrid(visualBible, coverPageNumber, coverLandmarkPhotos);
    const emptyResult = await generateImageOnly(emptyPrompt, [], {
      landmarkPhotos: coverLandmarkPhotos,
      visualBibleGrid: emptySceneVbGrid,
      skipCache: true,
      // Use the configured cover aspect so the empty-scene style anchor matches
      // the final cover shape. One source of truth in MODEL_DEFAULTS.coverAspect.
      aspectRatio: MODEL_DEFAULTS.coverAspect
    });
    if (emptyResult?.imageData) {
      coverSceneBackground = emptyResult.imageData;
      log.info(`🎬 [COVER-ITERATE] ${coverLabel}: empty scene generated for style anchoring`);
    }
  } catch (err) {
    log.warn(`⚠️ [COVER-ITERATE] ${coverLabel}: empty scene failed: ${err.message}`);
  }

  // Build VB grid — aligned with regular page logic (preparePageData in server.js
  // at line ~4153). Primary: getElementReferenceImagesForPage with the cover's page
  // number. Fallback: scene-hint IDs from coverSceneMetadata. Same shape as pages so
  // covers stay in sync if appearsInPages ever starts tracking -1/-2/-3.
  let coverVbGrid = null;
  if (visualBible) {
    let elementRefs = getElementReferenceImagesForPage(visualBible, coverPageNumber, 6);
    // Drop location elements when an empty scene background exists — the location
    // is already painted into the background.
    if (coverSceneBackground) {
      elementRefs = elementRefs.filter(e => e.type !== 'location');
    }
    // Additional sources of VB IDs — merge all into one set so covers get
    // the same VB parity as regular pages. Priority:
    //   1. coverHint.objects — authoritative list from the unified prompt
    //      ("Objects: [LOC###, ART###, ...]" under each cover block).
    //   2. coverSceneMetadata.fullData — IDs picked up by expansion, if any.
    const sceneIds = [];
    for (const id of coverHint?.objects || []) {
      if (typeof id === 'string' && !id.startsWith('LOC')) sceneIds.push(id.toUpperCase());
    }
    if (coverSceneMetadata?.fullData) {
      for (const char of coverSceneMetadata.fullData.characters || []) {
        if (char.id && char.id !== 'null') sceneIds.push(char.id);
      }
      for (const obj of coverSceneMetadata.fullData.objects || []) {
        const id = typeof obj === 'string' ? obj.match(/((?:ART|OBJ|CHR|VEH)\d+)/i)?.[1] : obj?.id;
        if (id && !id.startsWith('LOC')) sceneIds.push(id);
      }
    }
    if (sceneIds.length > 0) {
      const idBasedRefs = getElementReferenceImagesByIds(visualBible, sceneIds);
      const existingIds = new Set(elementRefs.map(r => r.id));
      const newRefs = idBasedRefs.filter(r => !existingIds.has(r.id));
      if (newRefs.length > 0) {
        log.info(`🔗 [VB-MATCH] Cover ${coverLabel}: Added ${newRefs.length} element(s) by scene hint ID: ${newRefs.map(r => r.id).join(', ')}`);
        elementRefs = [...elementRefs, ...newRefs].slice(0, 6);
      }
    }
    // Safety net for the iterate path: cover descriptions are plain text, so
    // extractSceneMetadata often returns null and the ID fallback above can't run.
    // If we still have no refs, name-match VB entries against the description.
    if (elementRefs.length === 0) {
      const descLower = (sceneDescription || '').toLowerCase();
      const nameMatched = [];
      const checkEntries = (entries, type, priority) => {
        for (const entry of entries || []) {
          if (!entry.referenceImageData || !entry.name) continue;
          if (!descLower.includes(entry.name.toLowerCase())) continue;
          nameMatched.push({
            id: entry.id,
            name: entry.name,
            type,
            description: entry.extractedDescription || entry.description,
            referenceImageData: entry.referenceImageData,
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
        log.info(`🔗 [VB-NAME-MATCH] Cover ${coverLabel}: Matched ${elementRefs.length} VB entries by name: ${elementRefs.map(r => r.id || r.name).join(', ')}`);
      }
    }
    const secondaryLandmarks = coverLandmarkPhotos.slice(1);
    if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
      coverVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
    }
  }
  if (coverLandmarkPhotos.length > 0 || coverVbGrid) {
    log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${coverLandmarkPhotos.length} landmark photos, VB grid: ${coverVbGrid ? 'yes' : 'no'}`);
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

module.exports = { iterateCover };
