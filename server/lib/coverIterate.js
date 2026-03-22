/**
 * Shared cover iterate logic — used by both manual iterate endpoint
 * and the auto repair pipeline.
 *
 * Extracts the core cover regeneration logic: character selection,
 * prompt building, landmark/VB grid, image generation.
 */

const { log } = require('../utils/logger');
const { ART_STYLES, MODEL_DEFAULTS } = require('../config/models');
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
    buildFullVisualBiblePrompt,
  } = getStoryHelpers();

  const {
    generateImageWithQualityRetry,
    generateImageCacheKey,
    deleteFromImageCache,
    blackoutIssueRegions,
    buildVisualBibleGrid,
  } = require('./images');

  const { getElementReferenceImagesForPage } = require('./visualBible');

  // Get existing cover data
  storyData.coverImages = storyData.coverImages || {};
  const existingCover = storyData.coverImages[coverKey];
  if (!existingCover?.imageData) {
    throw new Error(`No cover image found for ${coverKey}`);
  }

  const sceneDescription = existingCover.description || 'A beautiful illustrated cover page.';
  log.info(`🔄 [COVER-ITERATE] ${coverKey}: Using stored description (${sceneDescription.length} chars)`);

  // --- Art style ---
  const artStyleId = storyData.artStyle || 'pixar';
  const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

  // --- Characters ---
  const characters = storyData.characters || [];
  const visualBible = storyData.visualBible || null;

  // Parse clothing from scene description
  let coverClothing = parseClothingCategory(sceneDescription) || 'standard';
  let effectiveCoverClothing = coverClothing;
  let coverCostumeType = null;
  if (coverClothing?.startsWith('costumed:')) {
    coverCostumeType = coverClothing.split(':')[1];
    effectiveCoverClothing = 'costumed';
  }
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

  // Character selection: main chars for front, main+extras for initial/back
  const MAX_COVER_CHARACTERS = 5;
  const mainChars = mergedCharacters.filter(c => c.isMainCharacter === true);
  const nonMainChars = mainChars.length > 0
    ? mergedCharacters.filter(c => !c.isMainCharacter)
    : mergedCharacters;

  const normalizedCoverType = coverKey === 'frontCover' ? 'front' : coverKey === 'initialPage' ? 'initialPage' : 'back';
  let coverCharacterPhotos;
  if (normalizedCoverType === 'front') {
    let charactersToUse = mainChars.length > 0 ? mainChars : mergedCharacters;
    if (charactersToUse.length > MAX_COVER_CHARACTERS) {
      charactersToUse = charactersToUse.slice(0, MAX_COVER_CHARACTERS);
    }
    coverCharacterPhotos = getCharacterPhotoDetails(charactersToUse, effectiveCoverClothing, coverCostumeType, artStyleId, clothingRequirements);
  } else {
    const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
    const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
    const halfPoint = Math.ceil(nonMainChars.length / 2);
    const extras = normalizedCoverType === 'initialPage'
      ? nonMainChars.slice(0, halfPoint).slice(0, extraSlots)
      : nonMainChars.slice(halfPoint).slice(0, extraSlots);
    coverCharacterPhotos = getCharacterPhotoDetails([...mainCapped, ...extras], effectiveCoverClothing, coverCostumeType, artStyleId, clothingRequirements);
  }

  // Apply styled avatars
  if (effectiveCoverClothing !== 'costumed') {
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

  // Landmark photos and VB grid
  const coverSceneMetadata = extractSceneMetadata(sceneDescription);
  const coverLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, coverSceneMetadata) : [];
  let coverVbGrid = null;
  if (visualBible) {
    const elementRefs = getElementReferenceImagesForPage(visualBible, 0, 6);
    const secondaryLandmarks = coverLandmarkPhotos.slice(1);
    if (elementRefs.length > 0 || secondaryLandmarks.length > 0) {
      coverVbGrid = await buildVisualBibleGrid(elementRefs, secondaryLandmarks);
    }
  }

  if (coverLandmarkPhotos.length > 0 || coverVbGrid) {
    log.debug(`🔄 [COVER-ITERATE] ${coverKey}: ${coverLandmarkPhotos.length} landmark photos, VB grid: ${coverVbGrid ? 'yes' : 'no'}`);
  }

  // --- Generate image ---
  const coverLabel = coverKey === 'frontCover' ? 'FRONT COVER' : coverKey === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
  const imageResult = await generateImageWithQualityRetry(
    coverPrompt, coverCharacterPhotos, previousImage, 'cover', null, usageTracker, null,
    { imageModel: imageModel || null },
    `${coverLabel} ITERATE`,
    { landmarkPhotos: coverLandmarkPhotos, visualBibleGrid: coverVbGrid }
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
