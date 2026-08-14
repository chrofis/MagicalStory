/**
 * Story Helpers — re-export facade
 *
 * storyHelpers.js was split into domain modules (docs/plans/storyhelpers-split.md):
 *   - promptBuilders.js  — story/scene/image prompt builders + support data
 *                          (character descriptions, teaching guides, historical
 *                          locations/objects, art styles, language levels, ages)
 *   - sceneMetadata.js   — scene/page metadata parsers + position handling
 *   - clothingResolve.js — clothing/avatar category resolution + photo assembly
 *
 * This facade re-exports everything so existing `require('./storyHelpers')`
 * importers keep working byte-identically. New code may require the domain
 * modules directly; importer migration is opportunistic, never bulk
 * (docs/decisions.md). Only small residue lives here: landmark photo loaders,
 * calculateStoryPageCount, getHeadBodyRatio.
 */

const { log } = require('../utils/logger');
const { loadLandmarkPhotoVariant } = require('./landmarkPhotos');
const { parseClothingCategory, parseCharacterClothing, resolveClothingForPage, buildSceneClothingRequirements, buildAvailableAvatarsForPrompt, convertClothingToCurrentFormat, getCharacterPhotos, getCharacterPhotoDetails, prefetchAvatarBytesForCharacters, applyReferenceMode } = require('./clothingResolve');
const { wrapUserInput, stripAgeWords, buildHairDescription, buildCharacterDescriptionsForBbox, buildSecondaryCharacterDescriptions, buildSecondaryExpectedCharacters, buildTextZoneInstruction, buildEraGuard, buildLandmarkFidelityBlock, getAgeCategory, getAgeCategoryLabel, AGE_CATEGORY_ORDER, getAgeCategoryIndex, clampApparentAge, getTeachingGuide, preloadHistoricalLocations, getHistoricalLocations, preloadHistoricalObjects, getHistoricalObjects, getAdventureGuide, getSceneComplexityGuide, ART_STYLES, WORLD_ART_STYLES, buildStyleWardrobeBlock, resolveArtStyle, resolveArtStyleForEmptyScene, resolveArtStyleForSheet, LANGUAGE_LEVELS, getReadingLevel, getTokensPerPage, extractCharacterVisualProfile, buildCharacterPhysicalDescription, buildGroundingPrompt, buildCharacterPromptBlock, buildRelativeHeightDescription, buildCharacterRestriction, buildCharacterReferenceList, buildBasePrompt, buildSceneExpansionAllPrompt, buildSceneExpansionPrompt, buildSceneDescriptionPrompt, textDeclaresNonWornPlacement, sceneDeclaresNonWornState, stripWornStateFromDescription, buildImagePrompt, sanitizeVbIdsInPrompt, buildOutlineReviewPrompt, buildTextRefinePrompt, parseRefinedText, buildBeatsPrompt, buildBeatsReviewPrompt, buildClothingReviewPrompt, parseClothingReview, parseBeats, buildSceneReviewPrompt, buildDoNotWriteSection, buildStoryTextFromBeatsPrompt, buildStoryBibleFromBeatsPrompt, buildUnifiedStoryPrompt, buildTrialStoryPrompt, buildAvailableLandmarksSection, buildPreviousScenesContext } = require('./promptBuilders');
const { extractJsonFromText, parseProseMetadataFormat, POSITION_ABBREVIATIONS, expandPositionAbbreviations, stripEntityIds, stripSceneMetadata, parseCharacterDescriptions, enforceSpreadTextPosition, mirrorLeftRight, extractSceneMetadata, collectSceneCharacterNames, findCastMissingFromMetadata, getCharactersInScene, parseSceneHintMetadata, parseStoryPages, parseSceneDescriptions, extractShortSceneDescriptions, extractCoverScenes, extractPageClothing, getPrimaryVantageForPage, groupPagesByVantage, normalizePositionToLCR, getPageText, updatePageText } = require('./sceneMetadata');

/**
 * Calculate the actual page count for a story
 * Picture-book layout is the default for all reading levels: 1 scene = 1 page
 * (image on top, text below). Reading level only controls text density, not layout.
 * @param {Object} storyData - The story data object
 * @param {boolean} includeCoverPages - Whether to add 3 pages for covers (default: true)
 * @returns {number} Total page count
 */
function calculateStoryPageCount(storyData, includeCoverPages = true) {
  const sceneCount = storyData?.sceneImages?.length || storyData?.scenes?.length || 0;
  if (sceneCount === 0) return 0;

  // 1 scene = 1 physical page in picture-book layout
  // Add 3 pages for front cover, back cover, and initial page (title page)
  return includeCoverPages ? sceneCount + 3 : sceneCount;
}

// ============================================================================
// LANDMARK PHOTO LOADERS
// ============================================================================

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
      // Variant 0 = "no photo matches this scene's vantage" (owner, 2026-08-11):
      // the Art Director writes `.0` when the action is inside/under a landmark
      // and no interior variant exists — attaching an exterior photo to an
      // interior scene anchors the model to the wrong view (P6-P8 bridge:
      // exterior photo, walkway action). Prose carries the setting instead.
      const requestedVariant = perLandmarkVariants[loc.id] ?? 1;
      if (requestedVariant === 0) {
        log.info(`📍 [LANDMARK-SCENE] ${loc.name}: variant .0 — no photo attached (no variant matches the scene's vantage)`);
        continue;
      }
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

/**
 * Age → head-to-body ratio lookup, used both at avatar-generation time
 * (prescribes the expected proportion) and at image-evaluation time (verifies
 * the generated figure matches). Returns a string like "1:6" or null if age
 * is missing/non-numeric.
 *
 * Keep this the single source of truth — `styledAvatars.js` and
 * `images.js` both call it so the prescribed and checked ratios can't drift.
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
  buildSecondaryCharacterDescriptions,
  buildSecondaryExpectedCharacters,
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
  collectSceneCharacterNames,
  findCastMissingFromMetadata,
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
