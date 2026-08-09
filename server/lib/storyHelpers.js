/**
 * Story Helpers Module
 *
 * Common utilities for story generation, prompt building, and text parsing.
 * Used by both processStoryJob and processStorybookJob.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { IMAGE_MODELS, MODEL_DEFAULTS } = require('../config/models');
const { buildVisualBiblePrompt, englishEntityRef, englishLocationRef, significantEntityTokens } = require('./visualBible');
const { getPrimaryPhoto, getFacePhoto, getStandardAvatar, getFaceThumb, getBodyThumb } = require('./characterPhotos');
const { getPhysical } = require('./characterPhysical');
const { getTraits } = require('./characterTraits');
const { frameColorForName } = require('./characterFrames');

// Lazy-load images module to avoid circular dependency
// (images.js imports storyHelpers.js, so we can't import at top level)
const { parseClothingCategory, parseCharacterClothing, resolveClothingForPage, buildSceneClothingRequirements, buildAvailableAvatarsForPrompt, convertClothingToCurrentFormat, getCharacterPhotos, getCharacterPhotoDetails, prefetchAvatarBytesForCharacters, applyReferenceMode } = require('./clothingResolve');
const { OutlineParser, UnifiedStoryParser, extractCharacterNamesFromScene } = require('./outlineParser');
const { getLanguageNote, getLanguageInstruction, getLanguageNameEnglish } = require('./languages');
const { getEventById } = require('./historicalEvents');
const { loadLandmarkPhotoVariant } = require('./landmarkPhotos');
const { getSwissStoryResearch, getSwissCityById } = require('./swissStories');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Wrap user-provided text in XML boundary markers to mitigate prompt injection.
 * The <user_input> tags signal to the AI model that the enclosed content is
 * user-provided data and should be treated as data only, not as instructions.
 * @param {string} value - The user-provided string
 * @returns {string} The value wrapped in <user_input> tags, or the original if empty/None
 */
const { wrapUserInput, stripAgeWords, buildHairDescription, buildCharacterDescriptionsForBbox, buildTextZoneInstruction, buildEraGuard, buildLandmarkFidelityBlock, getAgeCategory, getAgeCategoryLabel, AGE_CATEGORY_ORDER, getAgeCategoryIndex, clampApparentAge, getTeachingGuide, preloadHistoricalLocations, getHistoricalLocations, preloadHistoricalObjects, getHistoricalObjects, getAdventureGuide, getSceneComplexityGuide, ART_STYLES, WORLD_ART_STYLES, buildStyleWardrobeBlock, resolveArtStyle, resolveArtStyleForEmptyScene, resolveArtStyleForSheet, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage, extractCharacterVisualProfile, buildCharacterPhysicalDescription, buildGroundingPrompt, buildCharacterPromptBlock, buildRelativeHeightDescription, buildCharacterRestriction, buildCharacterReferenceList, buildBasePrompt, buildSceneExpansionAllPrompt, buildSceneExpansionPrompt, buildSceneDescriptionPrompt, textDeclaresNonWornPlacement, sceneDeclaresNonWornState, stripWornStateFromDescription, buildImagePrompt, sanitizeVbIdsInPrompt, buildOutlineReviewPrompt, buildTextRefinePrompt, parseRefinedText, buildBeatsPrompt, buildBeatsReviewPrompt, buildClothingReviewPrompt, parseClothingReview, parseBeats, buildSceneReviewPrompt, buildDoNotWriteSection, buildStoryTextFromBeatsPrompt, buildStoryBibleFromBeatsPrompt, buildUnifiedStoryPrompt, buildTrialStoryPrompt, buildAvailableLandmarksSection, buildPreviousScenesContext } = require('./promptBuilders');
const { extractJsonFromText, parseProseMetadataFormat, POSITION_ABBREVIATIONS, expandPositionAbbreviations, stripEntityIds, stripSceneMetadata, parseCharacterDescriptions, enforceSpreadTextPosition, mirrorLeftRight, extractSceneMetadata, getCharactersInScene, parseSceneHintMetadata, parseStoryPages, parseSceneDescriptions, extractShortSceneDescriptions, extractCoverScenes, extractPageClothing, getPrimaryVantageForPage, groupPagesByVantage, normalizePositionToLCR, getPageText, updatePageText } = require('./sceneMetadata');
function calculateStoryPageCount(storyData, includeCoverPages = true) {
  const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
  if (sceneCount === 0) return 0;

  // 1 scene = 1 physical page in picture-book layout
  // Add 3 pages for front cover, back cover, and initial page (title page)
  return includeCoverPages ? sceneCount + 3 : sceneCount;
}

// ============================================================================
// CHARACTER HELPERS
// ============================================================================

/**
 * Detect which characters are mentioned in a scene description
 * Priority: 1) JSON metadata block, 2) Markdown parsing, 3) Text search fallback
 * @param {string} sceneDescription - The scene text
 * @param {Array} characters - Array of character objects (main characters with reference photos)
 * @returns {Array} Characters that appear in this scene
 */
function getLandmarkPhotosForPage(visualBible, pageNumber) {
  if (!visualBible?.locations) return [];

  return visualBible.locations
    .filter(loc =>
      loc.isRealLandmark &&
      (loc.referencePhotoUrl || loc.referencePhotoData) &&
      loc.photoFetchStatus === 'success' &&
      loc.appearsInPages?.includes(pageNumber)
    )
    .map(loc => ({
      name: loc.name,
      photoUrl: loc.referencePhotoUrl || null,
      photoData: loc.referencePhotoData || null,
      attribution: loc.photoAttribution,
      source: loc.photoSource
    }));
}

/**
 * Get landmark reference photos for a scene based on LOC IDs in scene metadata
 * Parses objects like "Burgruine Stein [LOC002]" to extract LOC IDs
 * Also checks setting.location for landmark references
 * Supports on-demand loading of photo variants for Swiss landmarks
 * @param {Object} visualBible - Visual Bible object with locations
 * @param {Object} sceneMetadata - Scene metadata with objects array, setting.location, and landmarkVariants
 * @returns {Promise<Array<{name: string, photoData: string, attribution: string, source: string, variantNumber: number}>>} Landmark photos
 */
async function getLandmarkPhotosForScene(visualBible, sceneMetadata) {
  if (!visualBible?.locations) return [];

  // Extract LOC IDs and names from objects like "Burgruine Stein [LOC002]" or "Kennedy Space Center [LOC001.2]"
  const locIds = [];
  const locNames = [];
  const variantMap = {};

  // Helper to extract LOC ID and name from a string like "Ruine Stein [LOC001]" or "Ruine Stein [LOC001.2]"
  const extractLocFromString = (str) => {
    if (!str || typeof str !== 'string') return;
    // Match [LOC###] or [LOC###.N] pattern
    const bracketMatch = str.match(/\[LOC(\d+)(?:\.(\d+))?\]/i);
    if (bracketMatch) {
      const locId = `LOC${bracketMatch[1].padStart(3, '0')}`;
      locIds.push(locId);
      // Store variant if specified (e.g., [LOC003.2] → variant 2)
      if (bracketMatch[2]) {
        variantMap[locId] = parseInt(bracketMatch[2]);
      }
      // Also extract the name before the bracket
      const namePart = str.replace(/\s*\[LOC\d+(?:\.\d+)?\]\s*/gi, '').trim();
      if (namePart) locNames.push(namePart.toLowerCase());
    }
    // Also match plain "LOC002" or "LOC002.3" format
    else if (str.match(/^LOC\d+(\.\d+)?$/i)) {
      const parts = str.split('.');
      const locId = parts[0].toUpperCase();
      locIds.push(locId);
      if (parts[1]) variantMap[locId] = parseInt(parts[1]);
    }
    // Fallback: treat as location name (for historical locations)
    else if (str.trim()) {
      locNames.push(str.trim().toLowerCase());
    }
  };

  // Check setting.location first (e.g., "Ruine Stein [LOC001]")
  if (sceneMetadata?.setting?.location) {
    extractLocFromString(sceneMetadata.setting.location);
  }

  // Then check objects array (objects can be strings or {id, name, position} objects)
  if (sceneMetadata?.objects) {
    for (const obj of sceneMetadata.objects) {
      if (typeof obj === 'string') {
        extractLocFromString(obj);
      } else if (obj && typeof obj === 'object') {
        extractLocFromString(obj.id);
        extractLocFromString(obj.name);
      }
    }
  }

  if (locIds.length === 0 && locNames.length === 0) return [];

  // Per-landmark variants from [LOC003.2] format, falling back to metadata landmarkVariants
  const perLandmarkVariants = { ...variantMap, ...(sceneMetadata?.landmarkVariants || {}) };

  // Find matching locations
  const matchingLocations = visualBible.locations.filter(loc =>
    (locIds.includes(loc.id) || locNames.includes(loc.name?.toLowerCase())) &&
    loc.isRealLandmark
  );

  if (matchingLocations.length === 0) {
    // Debug: explain why no matches
    const allVbLocIds = visualBible.locations.map(l => `${l.id}(${l.isRealLandmark ? 'landmark' : 'location'})`);
    log.debug(`[LANDMARK-SCENE] No matches for IDs=[${locIds.join(',')}] names=[${locNames.join(',')}] in VB locations: [${allVbLocIds.join(', ')}]`);
    return [];
  }

  // Load photos for each matching location
  const results = [];
  for (const loc of matchingLocations) {
    // Check if this location has photo variants (Swiss pre-indexed)
    if (loc.photoVariants && loc.photoVariants.length > 0) {
      // Load the selected variant on-demand (per-landmark variant from [LOC003.2] format)
      const requestedVariant = perLandmarkVariants[loc.id] || 1;
      const variant = await loadLandmarkPhotoVariant(visualBible, loc.id, requestedVariant);
      if (variant) {
        results.push({
          name: loc.name,
          photoData: variant.photoData,
          attribution: variant.attribution,
          source: 'swiss-variant',
          variantNumber: variant.variantNumber
        });
        log.debug(`[LANDMARK-SCENE] Loaded "${loc.name}" variant ${variant.variantNumber} (requested: ${requestedVariant})`);
      }
    }
    // Fall back to existing reference photo (referencePhotoUrl post-Phase-2,
    // referencePhotoData on legacy entries).
    else if ((loc.referencePhotoUrl || loc.referencePhotoData) && loc.photoFetchStatus === 'success') {
      results.push({
        name: loc.name,
        photoUrl: loc.referencePhotoUrl || null,
        photoData: loc.referencePhotoData || null,
        attribution: loc.photoAttribution,
        source: loc.photoSource,
        variantNumber: 1
      });
    } else {
      log.debug(`[LANDMARK-SCENE] "${loc.name}" (${loc.id}) matched but has no photos (variants=${loc.photoVariants?.length || 0}, fetchStatus=${loc.photoFetchStatus || 'none'})`);
    }
  }

  return results;
}

// ============================================================================
// AVAILABLE LANDMARKS SECTION BUILDER
// ============================================================================

/**
 * Build the available landmarks section for the outline prompt
 * @param {Array} landmarks - Pre-discovered landmarks from userLandmarkCache
 * @returns {string} - Prompt section with available landmarks, or empty string if none
 */
function getHeadBodyRatio(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return null;
  if (n <= 3) return '1:4';
  if (n <= 6) return '1:5';
  if (n <= 10) return '1:6';
  if (n <= 12) return '1:6.5';
  if (n <= 17) return '1:7';
  return '1:8';
}

module.exports = {
  // Config
  ART_STYLES,
  resolveArtStyle,
  resolveArtStyleForEmptyScene,
  resolveArtStyleForSheet,
  LANGUAGE_LEVELS,

  // Level helpers
  getReadingLevel,
  getTokensPerPage,

  // Page calculations
  calculateStoryPageCount,

  // Age category
  getAgeCategory,
  getAgeCategoryLabel,

  // Character helpers
  getCharactersInScene,
  getCharacterPhotos,
  parseClothingCategory,
  parseCharacterClothing,
  getCharacterPhotoDetails,
  prefetchAvatarBytesForCharacters,
  buildCharacterPhysicalDescription,
  extractCharacterVisualProfile,
  buildGroundingPrompt,
  resolveClothingForPage,
  buildSceneClothingRequirements,
  buildCharacterPromptBlock,
  buildRelativeHeightDescription,
  buildCharacterReferenceList,
  buildCharacterRestriction,
  buildHairDescription,
  getHeadBodyRatio,

  // Text position
  enforceSpreadTextPosition,
  mirrorLeftRight,
  buildCharacterDescriptionsForBbox,
  buildTextZoneInstruction,
  buildEraGuard,
  buildLandmarkFidelityBlock,
  applyReferenceMode,

  // Parsers
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  extractSceneMetadata,
  stripSceneMetadata,
  parseSceneHintMetadata,
  parseProseMetadataFormat,

  // Prompt builders
  buildBasePrompt,
  buildSceneExpansionPrompt,
  buildSceneExpansionAllPrompt,
  buildSceneDescriptionPrompt,
  buildSceneIterationPrompt: buildSceneDescriptionPrompt,  // Alias: iteration = full description prompt
  buildImagePrompt,
  // Worn-vs-held / state-aware page-prompt guards (unit-tested)
  textDeclaresNonWornPlacement,
  sceneDeclaresNonWornState,
  stripWornStateFromDescription,
  buildUnifiedStoryPrompt,
  buildOutlineReviewPrompt,
  buildTextRefinePrompt,
  parseRefinedText,
  buildBeatsPrompt,
  buildBeatsReviewPrompt,
  buildClothingReviewPrompt,
  buildStyleWardrobeBlock,
  WORLD_ART_STYLES,
  parseClothingReview,
  buildSceneReviewPrompt,
  buildStoryTextFromBeatsPrompt,
  buildStoryBibleFromBeatsPrompt,
  buildDoNotWriteSection,
  parseBeats,
  buildTrialStoryPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,

  // Teaching guides
  getTeachingGuide,
  getAdventureGuide,
  getSceneComplexityGuide,

  // Historical locations
  preloadHistoricalLocations,
  getHistoricalLocations,

  // Historical objects (Visual Bible — period objects)
  preloadHistoricalObjects,
  getHistoricalObjects,

  // Landmark helpers
  getLandmarkPhotosForPage,
  getLandmarkPhotosForScene,
  buildAvailableLandmarksSection,

  // Location vantages (canvas-per-vantage pipeline)
  getPrimaryVantageForPage,
  groupPagesByVantage,

  // Position utilities
  expandPositionAbbreviations,
  normalizePositionToLCR,
  POSITION_ABBREVIATIONS,

  // Entity ID stripping (for image prompts)
  stripEntityIds,
  sanitizeVbIdsInPrompt,

  // Character parsing for bbox matching
  parseCharacterDescriptions,

  // Age-word stripping for legacy face/distinguishing-mark text
  stripAgeWords,

  // Apparent-age clamp + helpers
  AGE_CATEGORY_ORDER,
  getAgeCategoryIndex,
  clampApparentAge,

  // Clothing format conversion
  convertClothingToCurrentFormat,

  // Page text helpers
  getPageText,
  updatePageText,

  // JSON extraction
  extractJsonFromText,

  // Exposed for testing
  wrapUserInput
};
