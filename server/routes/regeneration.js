/**
 * Regeneration Routes — Extracted from server.js
 *
 * Contains all image/scene/cover regeneration, repair, and edit endpoints.
 * Mounted at /api/stories in server.js.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pLimit = require('p-limit');

// Middleware
const { authenticateToken } = require('../middleware/auth');
const { imageRegenerationLimiter } = require('../middleware/rateLimit');

// Config
const { CREDIT_CONFIG, CREDIT_COSTS } = require('../config/credits');
const { calculateImageCost, formatCostSummary, MODEL_DEFAULTS, MODEL_PRICING, REPAIR_DEFAULTS, IMAGE_MODELS, TEXT_MODELS } = require('../config/models');

// Services
const { log } = require('../utils/logger');
const { saveStoryData, saveScenePageData, rehydrateStoryImages, saveStoryImage, getStoryImage, getActiveVersion, setActiveVersion, getPool, dbQuery, saveStyleLabImage, getStyleLabThumbnails, getStyleLabRunImages } = require('../services/database');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

// Shared repair logic
const { findBadPages, selectCharRepairTasks } = require('../lib/repairLogic');

// Lib modules
const {
  getPageText,
  convertClothingToCurrentFormat,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildCharacterReferenceList,
  getCharactersInScene,
  buildImagePrompt,
  buildSceneDescriptionPrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForScene,
  extractSceneMetadata,
  extractJsonFromText,
  stripSceneMetadata,
  extractCoverScenes,
  ART_STYLES
} = require('../lib/storyHelpers');
const {
  generateImageOnly,
  generateWithIterativePlacement,
  applyStyleTransfer,
  generateImageWithQualityRetry,
  evaluateImageQuality,
  editImageWithPrompt,
  autoRepairImage,
  autoRepairWithTargets,
  deleteFromImageCache,
  generateImageCacheKey,
  buildVisualBibleGrid,
  blackoutIssueRegions,
  enrichWithBoundingBoxes,
  collectAllIssuesForPage,
  repairCharacterMismatch,
  detectAllBoundingBoxes,
  createBboxOverlayImage,
  callGrokVisionAPI,
  GEMINI_SAFETY_SETTINGS,
  IMAGE_QUALITY_THRESHOLD,
  compareImageStyles,
  compressImageToJPEG,
  runVisualInventory
} = require('../lib/images');
const { callClaudeAPI } = require('../lib/textModels');
const {
  getVisualBibleEntriesForPage,
  getElementReferenceImagesForPage,
  buildFullVisualBiblePrompt
} = require('../lib/visualBible');
const { applyStyledAvatars } = require('../lib/styledAvatars');
const { runEntityConsistencyChecks, repairSinglePage, repairEntityConsistency, getStyledAvatarForClothing, collectEntityAppearances } = require('../lib/entityConsistency');
const { getActiveIndexAfterPush, arrayToDbIndex } = require('../lib/versionManager');
const { hasPhotos: hasCharacterPhotos } = require('../lib/characterPhotos');
const { isGrokConfigured } = require('../lib/grok');

// Cover type ↔ virtual page number mapping
const COVER_PAGE_MAP = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
const COVER_TYPE_TO_PAGE = { frontCover: -1, initialPage: -2, backCover: -3 };
function isCoverPage(pageNumber) { return pageNumber < 0; }
function getCoverType(pageNumber) { return COVER_PAGE_MAP[String(pageNumber)]; }
function getCoverData(storyData, coverType) { return storyData.coverImages?.[coverType]; }

// Look up a scene image or cover image by page number
function findSceneOrCover(sData, pageNum) {
  if (pageNum < 0) {
    const coverType = COVER_PAGE_MAP[String(pageNum)];
    return coverType ? sData.coverImages?.[coverType] || null : null;
  }
  return sData.sceneImages?.find(s => s.pageNumber === pageNum) || null;
}

function getDbPool() { return getPool(); }

// Calculate token-based API cost for Gemini models
function calculateTokenCost(modelId, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[modelId] || { input: 0.10, output: 0.40 };
  if (pricing.perImage) return 0; // Image models use per-image pricing
  return ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
}

// Atomically add repair cost to story analytics
async function addRepairCost(storyId, cost, stepName) {
  if (cost <= 0) return;
  try {
    await getDbPool().query(`
      UPDATE stories SET data = jsonb_set(
        jsonb_set(
          data::jsonb,
          '{analytics,totalCost}',
          to_jsonb(COALESCE((data::jsonb->'analytics'->>'totalCost')::numeric, 0) + $1)
        ),
        '{analytics,repairCost}',
        to_jsonb(COALESCE((data::jsonb->'analytics'->>'repairCost')::numeric, 0) + $1)
      ) WHERE id = $2
    `, [cost, storyId]);
    log.info(`💰 [REPAIR-COST] ${stepName}: $${cost.toFixed(4)} added to story ${storyId}`);
  } catch (err) {
    log.warn(`⚠️ [REPAIR-COST] Failed to update analytics: ${err.message}`);
  }
}

// =============================================================================
// STORY REGENERATION ENDPOINTS - Regenerate individual components
// NOT MIGRATED - These remain active in server.js (AI generation dependencies)
// =============================================================================

// Regenerate scene description for a specific page (no credit cost - image regeneration covers it)
router.post('/:id/regenerate/scene-description/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }

    log.debug(`🔄 Regenerating scene description for story ${id}, page ${pageNumber}`);

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Find the page text
    const fullStoryText = storyData.storyText || storyData.story || '';
    const pageText = getPageText(fullStoryText, pageNumber);
    if (!pageText) {
      return res.status(404).json({ error: `Page ${pageNumber} not found in story` });
    }

    // Get characters from story data
    const characters = storyData.characters || [];

    // Get language code from story data
    const language = storyData.language || 'en';

    // Get Visual Bible for recurring elements
    const visualBible = storyData.visualBible || null;

    // Get page clothing from outline (reliable source) or fall back to parsing scene descriptions
    const pageClothingData = storyData.pageClothing || null;
    const clothingRequirements = storyData.clothingRequirements || null;

    // Build previous scenes context (last 2 pages)
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const previousScenes = [];
    for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
      if (prevPage >= 1) {
        const prevText = getPageText(fullStoryText, prevPage);
        if (prevText) {
          // Get clothing from pageClothing (outline) first, then fall back to parsing scene description
          let prevClothing = pageClothingData?.pageClothing?.[prevPage] || null;
          if (!prevClothing) {
            const prevSceneDesc = sceneDescriptions.find(s => s.pageNumber === prevPage);
            prevClothing = prevSceneDesc ? parseClothingCategory(prevSceneDesc.description) : null;
          }
          previousScenes.push({
            pageNumber: prevPage,
            text: prevText,
            sceneHint: '',
            clothing: prevClothing
          });
        }
      }
    }

    // Log expected clothing for this page based on outline
    const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing || 'standard';
    log.debug(`🔄 [REGEN SCENE ${pageNumber}] Expected clothing from outline: ${expectedClothing}`)

    // Build available avatars - only show clothing categories used in this story
    const availableAvatars = buildAvailableAvatarsForPrompt(characters, clothingRequirements);

    // Generate new scene description (includes Visual Bible recurring elements) — iteration model for regen
    const scenePrompt = buildSceneDescriptionPrompt(pageNumber, pageText, characters, '', language, visualBible, previousScenes, expectedClothing, '', availableAvatars);
    const sceneResult = await callClaudeAPI(scenePrompt, 10000, MODEL_DEFAULTS.sceneIteration, { prefill: '{"previewMismatches":[' });
    const newSceneDescription = sceneResult.text;

    // Update the scene description in story data (sceneDescriptions already loaded above)
    const existingIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);

    // Extract translatedSummary and imageSummary from JSON for easy access
    const metadata = extractSceneMetadata(newSceneDescription);
    const translatedSummary = metadata?.translatedSummary || null;
    const imageSummary = metadata?.imageSummary || null;

    const sceneEntry = {
      pageNumber,
      description: newSceneDescription,
      translatedSummary,
      imageSummary
    };

    if (existingIndex >= 0) {
      sceneDescriptions[existingIndex] = { ...sceneDescriptions[existingIndex], ...sceneEntry };
    } else {
      sceneDescriptions.push(sceneEntry);
      sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Save updated story with metadata
    storyData.sceneDescriptions = sceneDescriptions;
    await saveStoryData(id, storyData);

    log.info(`✅ Scene description regenerated for story ${id}, page ${pageNumber}`);

    res.json({
      success: true,
      pageNumber,
      sceneDescription: newSceneDescription,
      translatedSummary,
      imageSummary
    });

  } catch (err) {
    log.error('Error regenerating scene description:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to regenerate scene description: ' + err.message : 'Failed to regenerate scene description' });
  }
});

// Regenerate image for a specific page (costs credits)
router.post('/:id/regenerate/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { customPrompt, editedScene, characterIds } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    const creditCost = CREDIT_COSTS.IMAGE_REGENERATION;

    // Check if admin is impersonating - they get free regenerations
    const isImpersonating = req.user.impersonating === true;
    if (isImpersonating) {
      log.info(`🔄 [IMPERSONATE] Admin regenerating image for story ${id}, page ${pageNumber} (FREE - impersonating)`);
    } else {
      log.debug(`🔄 Regenerating image for story ${id}, page ${pageNumber} (cost: ${creditCost} credits)${editedScene ? ' [EDITED SCENE]' : ''}`);
    }

    // Check user credits first (-1 means infinite/unlimited, impersonating admins also skip)
    const userResult = await getDbPool().query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userCredits = userResult.rows[0].credits || 0;
    const hasInfiniteCredits = userCredits === -1 || isImpersonating;
    if (!hasInfiniteCredits && userCredits < creditCost) {
      return res.status(402).json({
        error: 'Insufficient credits',
        required: creditCost,
        available: userCredits
      });
    }

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Only load images for the page being regenerated (not entire story).
    // Full rehydrateStoryImages loads ALL pages (~50-100MB for 30 pages) which causes
    // 503 crashes when multiple regenerations fire concurrently.
    const pageImages = await dbQuery(
      `SELECT version_index, image_data FROM story_images
       WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2
       ORDER BY version_index`,
      [id, pageNumber]
    );
    const sceneEntry = (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber);
    if (sceneEntry && pageImages.length > 0) {
      // Load active version's image data into the main imageData field
      const metaResult = await dbQuery('SELECT image_version_meta FROM stories WHERE id = $1', [id]);
      const versionMeta = metaResult[0]?.image_version_meta || {};
      const activeVersion = versionMeta[String(pageNumber)]?.activeVersion || 0;
      const activeImg = pageImages.find(i => i.version_index === activeVersion) || pageImages.find(i => i.version_index === 0);
      if (activeImg) sceneEntry.imageData = activeImg.image_data;

      // Populate imageVersions with their image data from DB
      if (sceneEntry.imageVersions) {
        for (let vIdx = 0; vIdx < sceneEntry.imageVersions.length; vIdx++) {
          const version = sceneEntry.imageVersions[vIdx];
          if (!version.imageData) {
            const dbVersionIndex = arrayToDbIndex(vIdx, 'scene');
            const vImg = pageImages.find(i => i.version_index === dbVersionIndex);
            if (vImg) {
              version.imageData = vImg.image_data;
              version._rehydrated = true;
            }
          }
        }
      }
    }

    // Get scene description
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const sceneDesc = sceneDescriptions.find(s => s.pageNumber === pageNumber);

    if (!sceneDesc && !customPrompt) {
      return res.status(400).json({ error: 'No scene description found. Please provide customPrompt.' });
    }

    // Determine scene description to use
    const originalDescription = sceneDesc?.description || '';
    const inputDescription = editedScene || customPrompt || originalDescription;
    const sceneWasEdited = editedScene && editedScene !== originalDescription;

    // Log scene changes for dev mode visibility
    if (sceneWasEdited) {
      log.debug(`📝 [REGEN] SCENE EDITED for page ${pageNumber}:`);
      log.debug(`   Original: ${originalDescription.substring(0, 100)}${originalDescription.length > 100 ? '...' : ''}`);
      log.debug(`   New:      ${inputDescription.substring(0, 100)}${inputDescription.length > 100 ? '...' : ''}`);
    }

    // Get visual bible from stored story (for recurring elements)
    const visualBible = storyData.visualBible || null;
    if (visualBible) {
      const relevantEntries = getVisualBibleEntriesForPage(visualBible, pageNumber);
      log.debug(`📖 [REGEN] Visual Bible: ${relevantEntries.length} entries relevant to page ${pageNumber}`);
    }

    // Determine which characters appear in this scene
    // Priority: explicit characterIds from user selection > text detection from scene description
    let sceneCharacters;
    if (characterIds && Array.isArray(characterIds) && characterIds.length > 0) {
      // Use explicit character selection from UI
      sceneCharacters = (storyData.characters || []).filter(c => characterIds.includes(c.id));
      log.debug(`👥 [REGEN] Using ${sceneCharacters.length} explicitly selected characters: ${sceneCharacters.map(c => c.name).join(', ')}`);
    } else {
      // Fall back to text detection
      sceneCharacters = getCharactersInScene(inputDescription, storyData.characters || []);
      log.debug(`👥 [REGEN] Detected ${sceneCharacters.length} characters from text: ${sceneCharacters.map(c => c.name).join(', ')}`);
    }

    // Build correction notes from finalChecksReport if available
    let correctionNotes = '';
    const finalChecksReport = storyData.finalChecksReport;
    if (finalChecksReport?.imageChecks?.length > 0) {
      // Find all issues that affect this page (check both pagesToFix and images for relevance)
      const pageIssues = [];
      for (const check of finalChecksReport.imageChecks) {
        if (check.issues?.length > 0) {
          for (const issue of check.issues) {
            // Check if this page is relevant to the issue
            const pagesToFix = issue.pagesToFix || [];
            const involvedImages = issue.images || [];
            const isPageToFix = pagesToFix.includes(pageNumber);
            const isInvolved = involvedImages.includes(pageNumber);

            if (isPageToFix || isInvolved) {
              // Build issue description
              let issueText = `- ${issue.type.replace(/_/g, ' ').toUpperCase()}`;
              if (issue.characterInvolved) {
                issueText += ` (${issue.characterInvolved})`;
              }
              issueText += `: ${issue.description}`;
              if (issue.canonicalVersion) {
                issueText += `\n  TARGET: ${issue.canonicalVersion}`;
              }
              if (issue.recommendation) {
                issueText += `\n  FIX: ${issue.recommendation}`;
              }
              if (issue.details?.[`image${pageNumber}`]) {
                issueText += `\n  DETAIL: ${issue.details[`image${pageNumber}`]}`;
              }
              pageIssues.push(issueText);
            }
          }
        }
      }
      if (pageIssues.length > 0) {
        correctionNotes = `The previous image for this page had the following issues that need to be corrected:\n${pageIssues.join('\n\n')}`;
        log.debug(`📋 [REGEN] Found ${pageIssues.length} correction note(s) from evaluation for page ${pageNumber}`);
      }
    }

    // First, convert JSON format to text if needed (scene descriptions from initial generation are JSON)
    // This ensures we have readable text for the image prompt and display
    let textDescription = inputDescription;
    // Check for JSON format - supports "output" (initial gen), "scene" (iterate), or "draft" wrappers
    const isJsonFormat = inputDescription.trim().startsWith('{') &&
      (inputDescription.includes('"output"') || inputDescription.includes('"scene"') || inputDescription.includes('"draft"'));
    if (isJsonFormat) {
      const converted = stripSceneMetadata(inputDescription);
      if (converted && converted !== inputDescription) {
        log.debug(`📝 [REGEN] Converted JSON scene description to text format (${inputDescription.length} -> ${converted.length} chars)`);
        textDescription = converted;
      }
    }

    // Expand scene to full Art Director format
    // ALWAYS expand if user edited the scene (to ensure fresh, consistent prompts)
    // Also expand if it's a short summary without Art Director sections
    // Also expand if we have correction notes from evaluation (to incorporate fixes)
    let expandedDescription = textDescription;
    const hasArtDirectorFormat = textDescription.includes('**Setting') || textDescription.includes('**Character Composition') || textDescription.includes('## 1. Image Summary');
    const hasCorrectionNotes = correctionNotes.length > 0;
    const shouldExpand = sceneWasEdited || hasCorrectionNotes || (!hasArtDirectorFormat && textDescription.length < 1500);

    if (shouldExpand) {
      log.debug(`📝 [REGEN] Expanding scene using unified 3-step prompt (edited: ${sceneWasEdited}, corrections: ${hasCorrectionNotes}, length: ${inputDescription.length} chars)...`);
      // Use language code (e.g., 'de-ch', 'en') not name (e.g., 'English')
      const language = storyData.language || 'en';
      // Build context for scene description prompt (same as original generation)
      const pageText = getPageText(storyData.storyText || storyData.story || '', pageNumber);
      const previousScenes = buildPreviousScenesContext(sceneDescriptions, pageNumber);
      const clothingData = storyData.clothingRequirements || {};
      // Build available avatars - only show clothing categories used in this story
      const availableAvatars = buildAvailableAvatarsForPrompt(storyData.characters || [], clothingData);
      const expansionPrompt = buildSceneDescriptionPrompt(
        pageNumber,
        pageText || inputDescription,  // Fallback to description if no page text
        sceneCharacters,
        inputDescription,  // Use as shortSceneDesc
        language,
        visualBible,
        previousScenes,
        clothingData,
        correctionNotes,
        availableAvatars
      );

      try {
        const expansionResult = await callClaudeAPI(expansionPrompt, 10000, MODEL_DEFAULTS.sceneIteration, { prefill: '{"previewMismatches":[' });
        expandedDescription = expansionResult.text;
        log.debug(`✅ [REGEN] Scene expanded to ${expandedDescription.length} chars`);
        log.debug(`📝 [REGEN] Expanded scene preview: ${expandedDescription.substring(0, 300)}...`);
      } catch (expansionError) {
        log.error(`⚠️  [REGEN] Scene expansion failed, using original summary:`, expansionError.message);
        // Continue with short summary if expansion fails
      }
    }

    // Get clothing category - prefer outline pageClothing, then parse from description
    const pageClothingData = storyData.pageClothing || null;
    const clothingRequirements = storyData.clothingRequirements || null;

    // pageClothing[pageNumber] can be a string ('standard', 'costumed:Cowboy') or an object (per-character clothing)
    const pageClothingEntry = pageClothingData?.pageClothing?.[pageNumber];
    let clothingCategory;
    let effectiveClothingRequirements = clothingRequirements;

    if (typeof pageClothingEntry === 'string') {
      // Simple string: 'standard', 'costumed:pirate', etc.
      clothingCategory = pageClothingEntry;
    } else if (pageClothingEntry && typeof pageClothingEntry === 'object') {
      // Per-character clothing object: {"Lukas":"costumed:pirate","Manuel":"costumed:pirate"}
      // Convert to _currentClothing format and merge with clothingRequirements
      const perPageClothing = convertClothingToCurrentFormat(pageClothingEntry);
      effectiveClothingRequirements = { ...clothingRequirements };
      for (const [charName, charClothing] of Object.entries(perPageClothing)) {
        effectiveClothingRequirements[charName] = {
          ...effectiveClothingRequirements[charName],
          ...charClothing
        };
      }
      // Determine predominant clothing category from per-character data
      const clothingValues = Object.values(pageClothingEntry);
      const firstClothing = clothingValues[0];
      if (firstClothing && firstClothing.startsWith('costumed:')) {
        clothingCategory = firstClothing; // Use first character's costume as category
      } else {
        clothingCategory = firstClothing || parseClothingCategory(expandedDescription) || pageClothingData?.primaryClothing || 'standard';
      }
      log.debug(`🔄 [REGEN] Using per-character clothing for page ${pageNumber}: ${JSON.stringify(pageClothingEntry)}`);
    } else {
      clothingCategory = parseClothingCategory(expandedDescription) || pageClothingData?.primaryClothing || 'standard';
    }

    const artStyle = storyData.artStyle || 'pixar';
    // Use detailed photo info (with names) for labeled reference images
    let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, artStyle, effectiveClothingRequirements);
    // Apply styled avatars for non-costumed characters
    if (!clothingCategory || !clothingCategory.startsWith('costumed')) {
      referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
    }
    log.debug(`🔄 [REGEN] Scene has ${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory}${pageClothingData ? ' (from outline)' : ' (parsed)'}`);

    // Build landmark photos and Visual Bible grid for this page
    // Extract scene metadata from expanded description to find which landmarks are needed
    const sceneMetadata = extractSceneMetadata(expandedDescription);
    const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];
    if (pageLandmarkPhotos.length > 0) {
      log.debug(`🌍 [REGEN] Page ${pageNumber} has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => l.name).join(', ')}`);
    }

    // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
    let visualBibleGrid = null;
    if (visualBible) {
      const elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
      const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
      if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
        visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
        log.debug(`🔲 [REGEN] Page ${pageNumber} VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
      }
    }

    // Build image prompt with scene-specific characters and visual bible
    // Use isStorybook=true to include Visual Bible section in prompt
    // Note: We don't build originalPrompt separately to avoid duplicate logging - originalDescription is stored for comparison
    let imagePrompt = customPrompt || buildImagePrompt(expandedDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true, referencePhotos);

    // If user selected specific characters, add explicit restriction to prompt
    if (characterIds && Array.isArray(characterIds) && characterIds.length > 0) {
      const selectedNames = sceneCharacters.map(c => c.name);
      const allNames = (storyData.characters || []).map(c => c.name);
      const excludedNames = allNames.filter(n => !selectedNames.includes(n));

      if (excludedNames.length > 0) {
        imagePrompt += `\n\n**CRITICAL CHARACTER RESTRICTION:**\nONLY show these characters: ${selectedNames.join(', ')}\nDo NOT include: ${excludedNames.join(', ')}\nIf the scene description mentions excluded characters, IGNORE those mentions and show ONLY the specified characters.`;
        log.debug(`📸 [REGEN] Added character restriction: show ${selectedNames.join(', ')}, exclude ${excludedNames.join(', ')}`);
      }
    }

    // Log prompt changes for debugging
    if (sceneWasEdited) {
      log.debug(`📝 [REGEN] PROMPT BUILT for page ${pageNumber}:`);
      log.debug(`   Prompt length: ${imagePrompt.length} chars`);
    }

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    if (deleteFromImageCache(cacheKey)) {
      log.debug(`[REGEN] Cleared cache for page ${pageNumber} to force new generation`);
    }

    // Get the current image before regenerating (to store as previous version)
    let sceneImages = storyData.sceneImages || [];
    const currentImage = sceneImages.find(img => img.pageNumber === pageNumber);
    const previousImageData = currentImage?.imageData || null;
    const previousScore = currentImage?.qualityScore || null;
    const previousReasoning = currentImage?.qualityReasoning || null;
    const previousPrompt = currentImage?.prompt || null;
    // Keep the true original if this was already regenerated before
    const trueOriginalImage = currentImage?.originalImage || previousImageData;
    const trueOriginalScore = currentImage?.originalScore || previousScore;
    const trueOriginalReasoning = currentImage?.originalReasoning || previousReasoning;

    log.debug(`📸 [REGEN] Capturing previous image (${previousImageData ? 'has data' : 'none'}, score: ${previousScore}, already regenerated: ${!!currentImage?.originalImage})`);

    // Generate new image with labeled character photos (name + photoUrl)
    // Use quality retry to regenerate if score is below threshold
    // Use same model as initial generation for consistency
    const imageModelId = MODEL_DEFAULTS.pageImage;
    const imageResult = await generateImageWithQualityRetry(
      imagePrompt, referencePhotos, null, 'scene', null, null, null,
      { imageModel: imageModelId },
      `PAGE ${pageNumber}`,
      { landmarkPhotos: pageLandmarkPhotos, visualBibleGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata }
    );

    // Log API costs for this regeneration
    const imageCost = calculateImageCost(imageModelId, imageResult.totalAttempts || 1);
    log.info(`💰 [REGEN] API Cost: ${formatCostSummary(imageModelId, { imageCount: imageResult.totalAttempts || 1 }, imageCost)} (${imageResult.totalAttempts || 1} attempt(s))`);

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: expandedDescription,  // Store the full expanded scene description
      sceneDescription: expandedDescription,  // alias for backward compat
      prompt: imagePrompt,  // Store the prompt used for this regeneration
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning || null,
      qualityModelId: imageResult.qualityModelId || null,
      fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
      wasRegenerated: true,
      totalAttempts: imageResult.totalAttempts || 1,
      retryHistory: imageResult.retryHistory || [],
      // Store previous version (for undo/comparison)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      previousPrompt: previousPrompt,
      // Keep the true original across multiple regenerations
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      referencePhotos,
      landmarkPhotos: pageLandmarkPhotos,
      visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null,
      modelId: imageResult.modelId || null,
      regeneratedAt: new Date().toISOString(),
      regenerationCount: (currentImage?.regenerationCount || 0) + 1,
      // Preserve clothing data from original image for entity consistency
      sceneCharacterClothing: currentImage?.sceneCharacterClothing || currentImage?.characterClothing || null
    };

    log.debug(`📸 [REGEN] New image generated - score: ${imageResult.score}, attempts: ${imageResult.totalAttempts}, model: ${imageResult.modelId}`);

    // Initialize imageVersions if not present (migrate existing image as first version)
    if (currentImage && !currentImage.imageVersions) {
      currentImage.imageVersions = [{
        // Don't copy imageData — the original is already stored at DB version_index 0.
        description: currentImage.description || originalDescription,
        prompt: currentImage.prompt,
        modelId: currentImage.modelId,
        createdAt: storyData.createdAt || new Date().toISOString(),
        isActive: false,
        qualityScore: currentImage.qualityScore ?? null,
        qualityReasoning: currentImage.qualityReasoning || null,
        fixTargets: currentImage.fixTargets || [],
        fixableIssues: currentImage.fixableIssues || [],
        totalAttempts: currentImage.totalAttempts || null,
        referencePhotoNames: (currentImage.referencePhotos || []).map(p => ({
          name: p.name, photoType: p.photoType,
          clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
        })),
      }];
    }

    // Create new version entry
    const regenTimestamp = new Date().toISOString();
    const newVersion = {
      imageData: imageResult.imageData,
      userInput: inputDescription !== expandedDescription ? inputDescription : null,  // User's input before expansion
      description: expandedDescription,  // Full expanded scene description used for this version
      prompt: imagePrompt,
      modelId: imageResult.modelId || null,
      createdAt: regenTimestamp,
      generatedAt: regenTimestamp,  // saveStoryData uses generatedAt for story_images.generated_at
      isActive: true,
      qualityScore: imageResult.score ?? null,
      qualityReasoning: imageResult.reasoning || null,
      fixTargets: imageResult.fixTargets || [],
      fixableIssues: imageResult.fixableIssues || [],
      totalAttempts: imageResult.totalAttempts || null,
      referencePhotoNames: (referencePhotos || []).map(p => ({
        name: p.name, photoType: p.photoType,
        clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
      })),
    };

    if (existingIndex >= 0) {
      // Set all existing versions to inactive
      if (sceneImages[existingIndex].imageVersions) {
        sceneImages[existingIndex].imageVersions.forEach(v => v.isActive = false);
        sceneImages[existingIndex].imageVersions.push(newVersion);
      } else {
        sceneImages[existingIndex].imageVersions = [newVersion];
      }
      // Preserve v0's original metadata before Object.assign overwrites the main blob.
      // This is needed when imageVersions already exists (e.g., repair ran before iterate),
      // so the preservation entry at imageVersions[0] wasn't created above.
      if (!sceneImages[existingIndex].originalMetadata) {
        sceneImages[existingIndex].originalMetadata = {
          description: sceneImages[existingIndex].description || null,
          prompt: sceneImages[existingIndex].prompt || null,
          modelId: sceneImages[existingIndex].modelId || null,
          qualityScore: sceneImages[existingIndex].qualityScore ?? null,
          qualityReasoning: sceneImages[existingIndex].qualityReasoning || null,
          fixTargets: sceneImages[existingIndex].fixTargets || [],
          referencePhotoNames: (sceneImages[existingIndex].referencePhotos || []).map(p => ({
            name: p.name, photoType: p.photoType,
            clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
          })),
        };
      }
      // Update main fields (but NOT imageData - that would cause duplicate image storage)
      // The new image is stored in imageVersions and activeVersion meta points to it
      const { imageData: _unused, ...metadataOnly } = newImageData;
      Object.assign(sceneImages[existingIndex], metadataOnly);
      // Delete rehydrated imageData to prevent saveStoryData from re-saving it at version_index 0
      delete sceneImages[existingIndex].imageData;
    } else {
      newImageData.imageVersions = [newVersion];
      sceneImages.push(newImageData);
      sceneImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Save only the updated page atomically (instead of full saveStoryData which
    // would require all images in memory and risks race conditions with concurrent regenerations)
    storyData.sceneImages = sceneImages;
    const updatedScene = sceneImages.find(s => s.pageNumber === pageNumber);
    const saved = await saveScenePageData(id, pageNumber, updatedScene);
    if (!saved) {
      // Fallback to full save if page not found in sceneImages array
      await saveStoryData(id, storyData);
    }

    // Update imagePrompts separately since we're not saving the full data blob
    await dbQuery(
      `UPDATE stories SET data = jsonb_set(
         COALESCE(data, '{}'::jsonb),
         '{imagePrompts}',
         jsonb_set(
           COALESCE(data->'imagePrompts', '{}'::jsonb),
           $2::text[],
           $3::jsonb
         )
       ) WHERE id = $1`,
      [id, [String(pageNumber)], JSON.stringify(imagePrompt)]
    );

    // Update image_version_meta with new active version (new version is always the last one)
    const scene = sceneImages.find(s => s.pageNumber === pageNumber);
    const newActiveIndex = scene?.imageVersions?.length ? getActiveIndexAfterPush(scene.imageVersions, 'scene') : 0;
    await setActiveVersion(id, pageNumber, newActiveIndex);

    // Deduct credits after successful generation (skip for infinite credits or impersonating admin)
    let newCredits = hasInfiniteCredits ? -1 : userCredits - creditCost;
    if (!hasInfiniteCredits) {
      await getDbPool().query(
        'UPDATE users SET credits = credits - $1 WHERE id = $2',
        [creditCost, req.user.id]
      );
      // Log credit transaction
      await getDbPool().query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
         VALUES ($1, $2, $3, 'image_regeneration', $4)`,
        [req.user.id, -creditCost, newCredits, `Regenerate image for page ${pageNumber}`]
      );
      log.info(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, cost: ${creditCost} credits, remaining: ${newCredits})`);
    } else if (isImpersonating) {
      log.info(`✅ [IMPERSONATE] Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, FREE - admin impersonating)`);
    } else {
      log.info(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, unlimited credits)`);
    }

    // Get version info for response (reuse updatedScene from save above)
    const versionCount = updatedScene?.imageVersions?.length || 1;
    const imageVersions = updatedScene?.imageVersions?.map((v, idx) => ({
      description: v.description,
      prompt: v.prompt,
      userInput: v.userInput,
      modelId: v.modelId,
      createdAt: v.createdAt,
      isActive: v.isActive,
      type: v.type,
      qualityScore: v.qualityScore,
      // Include imageData for all versions so frontend can display them immediately
      imageData: v.imageData || undefined
    })) || [];

    res.json({
      success: true,
      pageNumber,
      imageData: imageResult.imageData,
      prompt: imagePrompt,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning,
      fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: imageResult.modelId || imageModelId,
      totalAttempts: imageResult.totalAttempts || 1,
      retryHistory: imageResult.retryHistory || [],
      wasRegenerated: true,
      regenerationCount: newImageData.regenerationCount,
      // Version info (with metadata for dev mode scene comparison)
      versionCount,
      imageVersions,
      creditsUsed: creditCost,
      creditsRemaining: newCredits,
      // API cost tracking
      apiCost: imageCost,
      apiCostModel: imageModelId,
      // Previous version (immediate predecessor)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      // True original (from initial generation)
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      // Scene editing info (for dev mode)
      originalDescription,
      newDescription: expandedDescription,  // Full expanded description
      inputDescription,  // What user provided (before expansion)
      sceneWasEdited,
      sceneWasExpanded: shouldExpand,  // Flag if expansion was done
      // Reference images used (for dev mode display)
      referencePhotos,
      landmarkPhotos: pageLandmarkPhotos,
      visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null
    });

    // Persist repair cost in background
    addRepairCost(id, imageCost, `Regenerate page ${pageNumber}`).catch(err => log.error('Failed to save regen cost:', err.message));

  } catch (err) {
    log.error('Error regenerating image:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to regenerate image: ' + err.message : 'Failed to regenerate image' });
  }
});

// Test multiple image models on the same page (ADMIN ONLY, no credits, ephemeral results)
router.post('/:id/test-models/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { models, iterativePlacement } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });
    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });
    // Validate models
    if (!Array.isArray(models) || models.length === 0) return res.status(400).json({ error: 'models array required' });
    const unknown = models.filter(m => !IMAGE_MODELS[m]);
    if (unknown.length > 0) return res.status(400).json({ error: `Unknown models: ${unknown.join(', ')}` });
    // Load story
    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
    const artStyle = storyData.artStyle || 'pixar';
    const visualBible = storyData.visualBible || null;
    const clothingReqs = storyData.clothingRequirements || null;
    // Resolve scene description, characters, and prompt
    let prompt, characterPhotos, landmarkPhotos = [], visualBibleGrid = null, sceneMetadata = null;
    if (pageNumber < 0) {
      const coverType = getCoverType(pageNumber);
      if (!coverType) return res.status(400).json({ error: `Invalid cover page number: ${pageNumber}` });
      const cover = getCoverData(storyData, coverType);
      if (!cover) return res.status(400).json({ error: `No cover found for ${coverType}` });
      const chars = getCharactersInScene(cover.description || '', storyData.characters || []);
      characterPhotos = getCharacterPhotoDetails(chars, parseClothingCategory(cover.description || '') || 'standard', artStyle, clothingReqs);
      prompt = buildImagePrompt(cover.description || '', storyData, chars, true, visualBible, pageNumber, true, characterPhotos);
    } else {
      const sceneDesc = (storyData.sceneDescriptions || []).find(s => s.pageNumber === pageNumber);
      if (!sceneDesc) return res.status(400).json({ error: `No scene description for page ${pageNumber}` });
      const desc = sceneDesc.description || '';
      const chars = getCharactersInScene(desc, storyData.characters || []);
      const pcEntry = storyData.pageClothing?.pageClothing?.[pageNumber];
      const clothing = (typeof pcEntry === 'string' ? pcEntry : null) || parseClothingCategory(desc) || storyData.pageClothing?.primaryClothing || 'standard';
      characterPhotos = getCharacterPhotoDetails(chars, clothing, artStyle, clothingReqs);
      if (!clothing.startsWith('costumed')) characterPhotos = applyStyledAvatars(characterPhotos, artStyle);
      sceneMetadata = extractSceneMetadata(desc);
      landmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];
      if (visualBible) {
        const elRefs = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
        const secLm = landmarkPhotos.slice(1);
        if (elRefs.length > 0 || secLm.length > 0) visualBibleGrid = await buildVisualBibleGrid(elRefs, secLm);
      }
      prompt = buildImagePrompt(desc, storyData, chars, false, visualBible, pageNumber, true, characterPhotos);
    }
    log.info(`🧪 [TEST-MODELS] Story ${id}, page ${pageNumber}: testing ${models.length} models${iterativePlacement ? ' (iterative placement)' : ''}`);
    // Run all models in parallel
    const results = {};
    const settled = await Promise.allSettled(models.map(async (model) => {
      const start = Date.now();
      let result;
      if (iterativePlacement && sceneMetadata) {
        const { resolveArtStyle } = require('../lib/storyHelpers');
        const artStyleDesc = resolveArtStyle(storyData.artStyle, IMAGE_MODELS[model].backend) || resolveArtStyle('pixar') || '';
        result = await generateWithIterativePlacement(prompt, characterPhotos, sceneMetadata, {
          imageModelOverride: model, imageBackendOverride: IMAGE_MODELS[model].backend,
          landmarkPhotos, visualBibleGrid, pageNumber, artStyle: artStyleDesc,
        });
      } else {
        result = await generateImageOnly(prompt, characterPhotos, {
          imageModelOverride: model, imageBackendOverride: IMAGE_MODELS[model].backend,
          landmarkPhotos, visualBibleGrid, pageNumber, skipCache: true
        });
      }
      return {
        model, imageData: result.imageData, modelId: result.modelId, elapsed: Date.now() - start, usage: result.usage || null,
        // Iterative placement debug data
        pass1Image: result.pass1Image || null, pass1Prompt: result.pass1Prompt || null, pass2Prompt: result.pass2Prompt || null,
        pass2Failed: result.pass2Failed || false, pass2Error: result.pass2Error || null,
      };
    }));
    for (const [i, s] of settled.entries()) {
      if (s.status === 'fulfilled') {
        const r = s.value;
        results[r.model] = { imageData: r.imageData, modelId: r.modelId, elapsed: r.elapsed, usage: r.usage, pass1Image: r.pass1Image, pass1Prompt: r.pass1Prompt, pass2Prompt: r.pass2Prompt, pass2Failed: r.pass2Failed, pass2Error: r.pass2Error };
      } else {
        results[models[i]] = { error: s.reason?.message || 'Unknown error', modelId: models[i], elapsed: 0 };
      }
    }
    res.json({ success: true, pageNumber, results });
  } catch (err) {
    log.error('Error in test-models:', err);
    res.status(500).json({ error: 'Failed to test models: ' + err.message });
  }
});

// Style transfer: re-render current page image in the story's art style using a different model (admin only)
router.post('/:id/style-transfer/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { targetModel, withAvatars, styleDescription: customStyle } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });
    if (!targetModel) return res.status(400).json({ error: 'targetModel required' });
    if (!IMAGE_MODELS[targetModel]) return res.status(400).json({ error: `Unknown model: ${targetModel}` });

    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    // Load story
    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
    storyData = await rehydrateStoryImages(id, storyData);
    const artStyle = storyData.artStyle || 'pixar';

    // Get the current image for the page
    let currentImageData;
    if (pageNumber < 0) {
      const coverType = getCoverType(pageNumber);
      if (!coverType) return res.status(400).json({ error: `Invalid cover page number: ${pageNumber}` });
      const cover = getCoverData(storyData, coverType);
      if (!cover || !cover.imageData) return res.status(400).json({ error: `No cover image found for ${coverType}` });
      currentImageData = cover.imageData;
    } else {
      const sceneImage = (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber);
      if (!sceneImage || !sceneImage.imageData) return res.status(400).json({ error: `No image found for page ${pageNumber}` });
      currentImageData = sceneImage.imageData;
    }

    // Build character photos if requested (helps preserve facial details)
    let characterPhotos = [];
    if (withAvatars) {
      const characters = storyData.characters || [];
      const sceneImage = pageNumber > 0 ? (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber) : null;
      const sceneDesc = sceneImage?.description || '';
      const sceneChars = getCharactersInScene(sceneDesc, characters);
      const charsToUse = sceneChars.length > 0 ? sceneChars : characters;
      const clothingReqs = convertClothingToCurrentFormat(storyData.clothingRequirements);
      characterPhotos = getCharacterPhotoDetails(charsToUse, 'standard', artStyle, clothingReqs);
      characterPhotos = applyStyledAvatars(characterPhotos, artStyle);
      log.info(`🎨 [STYLE-TRANSFER] Including ${characterPhotos.length} avatar references`);
    }

    log.info(`🎨 [STYLE-TRANSFER] Story ${id}, page ${pageNumber}: transferring to ${targetModel}${withAvatars ? ' (with avatars)' : ''}`);
    const start = Date.now();
    // Use custom style description if provided, otherwise use story's art style
    const effectiveStyle = customStyle || artStyle;
    const result = await applyStyleTransfer(currentImageData, effectiveStyle, {
      imageModelOverride: targetModel,
      imageBackendOverride: IMAGE_MODELS[targetModel].backend,
      characterPhotos,
    });
    const elapsed = Date.now() - start;
    log.info(`🎨 [STYLE-TRANSFER] Completed in ${elapsed}ms`);

    res.json({
      success: true,
      imageData: result.imageData,
      modelId: result.modelId || targetModel,
      elapsed,
    });
  } catch (err) {
    log.error('Error in style-transfer:', err);
    res.status(500).json({ error: 'Failed to apply style transfer: ' + err.message });
  }
});

// Analyze the art style of a page image (DEV MODE ONLY)
router.post('/:id/analyze-style/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });

    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    let storyData = typeof storyResult.rows[0].data === 'string' ? JSON.parse(storyResult.rows[0].data) : storyResult.rows[0].data;
    storyData = await rehydrateStoryImages(id, storyData);

    let imageData;
    if (pageNumber < 0) {
      const coverType = getCoverType(pageNumber);
      const cover = coverType ? getCoverData(storyData, coverType) : null;
      if (!cover?.imageData) return res.status(400).json({ error: 'No cover image found' });
      imageData = cover.imageData;
    } else {
      const scene = (storyData.sceneImages || []).find(s => s.pageNumber === pageNumber);
      if (!scene?.imageData) return res.status(400).json({ error: 'No image found for page' });
      imageData = scene.imageData;
    }

    const start = Date.now();
    const { analyzeImageStyle } = require('../lib/images');
    const result = await analyzeImageStyle(imageData);
    const elapsed = Date.now() - start;

    res.json({ success: true, style: result.style, elapsed, usage: result.usage });
  } catch (err) {
    log.error('Error in analyze-style:', err);
    res.status(500).json({ error: 'Failed to analyze style' });
  }
});

// ============================================
// STYLE LAB ENDPOINTS
// ============================================

// Style Lab: generate same scene with per-model style prompt overrides (admin only)
router.post('/:id/style-lab/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { models, baseStylePrompt, artStyleId, perModelOverrides, runId: existingRunId } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });

    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    // Validate
    if (!Array.isArray(models) || models.length === 0) return res.status(400).json({ error: 'models array required' });
    if (!baseStylePrompt) return res.status(400).json({ error: 'baseStylePrompt required' });
    const unknown = models.filter(m => !IMAGE_MODELS[m]);
    if (unknown.length > 0) return res.status(400).json({ error: `Unknown models: ${unknown.join(', ')}` });

    // Load story
    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
    const artStyle = storyData.artStyle || 'pixar';
    const visualBible = storyData.visualBible || null;
    const clothingReqs = storyData.clothingRequirements || null;

    // Resolve scene description, characters, and references (same as test-models)
    let characterPhotos, landmarkPhotos = [], visualBibleGrid = null;
    if (pageNumber < 0) {
      const coverType = getCoverType(pageNumber);
      if (!coverType) return res.status(400).json({ error: `Invalid cover page number: ${pageNumber}` });
      const cover = getCoverData(storyData, coverType);
      if (!cover) return res.status(400).json({ error: `No cover found for ${coverType}` });
      const chars = getCharactersInScene(cover.description || '', storyData.characters || []);
      characterPhotos = getCharacterPhotoDetails(chars, parseClothingCategory(cover.description || '') || 'standard', artStyle, clothingReqs);
    } else {
      const sceneDesc = (storyData.sceneDescriptions || []).find(s => s.pageNumber === pageNumber);
      if (!sceneDesc) return res.status(400).json({ error: `No scene description for page ${pageNumber}` });
      const desc = sceneDesc.description || '';
      const chars = getCharactersInScene(desc, storyData.characters || []);
      const pcEntry = storyData.pageClothing?.pageClothing?.[pageNumber];
      const clothing = (typeof pcEntry === 'string' ? pcEntry : null) || parseClothingCategory(desc) || storyData.pageClothing?.primaryClothing || 'standard';
      characterPhotos = getCharacterPhotoDetails(chars, clothing, artStyle, clothingReqs);
      if (!clothing.startsWith('costumed')) characterPhotos = applyStyledAvatars(characterPhotos, artStyle);
      const sceneMetadata = extractSceneMetadata(desc);
      landmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, sceneMetadata) : [];
      if (visualBible) {
        const elRefs = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
        const secLm = landmarkPhotos.slice(1);
        if (elRefs.length > 0 || secLm.length > 0) visualBibleGrid = await buildVisualBibleGrid(elRefs, secLm);
      }
    }

    const runId = existingRunId || crypto.randomUUID();
    log.info(`🧪 [STYLE-LAB] Story ${id}, page ${pageNumber}: run ${runId}, models: ${models.join(', ')}`);

    // Build per-model prompts and generate in parallel
    const results = {};
    const settled = await Promise.allSettled(models.map(async (model) => {
      const effectiveStyle = perModelOverrides?.[model] || baseStylePrompt;

      // Resolve scene description for this model with custom style
      const sceneDesc = pageNumber < 0
        ? (getCoverData(storyData, getCoverType(pageNumber))?.description || '')
        : ((storyData.sceneDescriptions || []).find(s => s.pageNumber === pageNumber)?.description || '');
      const chars = getCharactersInScene(sceneDesc, storyData.characters || []);
      const prompt = buildImagePrompt(sceneDesc, storyData, chars, false, visualBible, pageNumber, true, characterPhotos, {
        customStyleDescription: effectiveStyle
      });

      const start = Date.now();
      const result = await generateImageOnly(prompt, characterPhotos, {
        imageModelOverride: model,
        imageBackendOverride: IMAGE_MODELS[model].backend,
        landmarkPhotos, visualBibleGrid, pageNumber, skipCache: true
      });
      const elapsed = Date.now() - start;

      // Save full image + thumbnail to DB
      const thumbnail = await compressImageToJPEG(result.imageData, 60, 200);
      await saveStyleLabImage(id, pageNumber, runId, model, result.imageData, thumbnail, effectiveStyle, elapsed);

      return { model, imageData: result.imageData, modelId: result.modelId, elapsed };
    }));

    for (const [i, s] of settled.entries()) {
      if (s.status === 'fulfilled') {
        const r = s.value;
        results[r.model] = { imageData: r.imageData, modelId: r.modelId, elapsed: r.elapsed };
      } else {
        results[models[i]] = { error: s.reason?.message || 'Unknown error', modelId: models[i], elapsed: 0 };
      }
    }

    // Save run metadata to storyData (without images)
    if (!storyData.styleLabHistory) storyData.styleLabHistory = [];
    const existingIdx = storyData.styleLabHistory.findIndex(r => r.runId === runId);
    const runMeta = {
      runId,
      pageNumber,
      artStyleId: artStyleId || 'custom',
      baseStylePrompt,
      perModelOverrides: perModelOverrides || {},
      models: existingIdx >= 0
        ? [...new Set([...storyData.styleLabHistory[existingIdx].models, ...models])]
        : models,
      createdAt: new Date().toISOString()
    };
    // Preserve existing evaluation if re-running single model
    if (existingIdx >= 0) {
      runMeta.evaluation = storyData.styleLabHistory[existingIdx].evaluation;
      storyData.styleLabHistory[existingIdx] = runMeta;
    } else {
      // Cap history at 50 entries per story, prune oldest
      if (storyData.styleLabHistory.length >= 50) {
        storyData.styleLabHistory = storyData.styleLabHistory.slice(-49);
      }
      storyData.styleLabHistory.push(runMeta);
    }
    await saveStoryData(id, storyData);

    res.json({ success: true, runId, pageNumber, results });
  } catch (err) {
    log.error('Error in style-lab:', err);
    res.status(500).json({ error: 'Failed to run style lab: ' + err.message });
  }
});

// Style Lab: evaluate style similarity between two model results (admin only)
router.post('/:id/style-lab/:pageNum/evaluate', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { runId } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });
    if (!runId) return res.status(400).json({ error: 'runId required' });

    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    // Verify story ownership before loading images
    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });

    // Load images for this run, ordered to match A/B from run metadata
    const imageRows = await getStyleLabRunImages(id, pageNumber, runId);
    if (imageRows.length < 2) return res.status(400).json({ error: `Need 2 images to compare, found ${imageRows.length}` });

    // Use run.models order (A first, B second) instead of alphabetical DB order
    const storyData = typeof storyResult.rows[0].data === 'string' ? JSON.parse(storyResult.rows[0].data) : storyResult.rows[0].data;
    const run = (storyData.styleLabHistory || []).find(r => r.runId === runId);
    const modelOrder = run?.models || imageRows.map(r => r.model_id);
    const imageA = imageRows.find(r => r.model_id === modelOrder[0]) || imageRows[0];
    const imageB = imageRows.find(r => r.model_id === modelOrder[1]) || imageRows[1];

    log.info(`🧪 [STYLE-LAB] Evaluating run ${runId}: A=${imageA.model_id} vs B=${imageB.model_id}`);
    // Compress images for comparison — style analysis doesn't need full resolution
    const imgA = await compressImageToJPEG(imageA.image_data, 80, 512);
    const imgB = await compressImageToJPEG(imageB.image_data, 80, 512);
    const evaluation = await compareImageStyles(imgA, imgB);

    // Save evaluation to storyData (storyData and run already loaded above for model ordering)
    if (run) {
      run.evaluation = { ...evaluation, evaluatedAt: new Date().toISOString() };
      await saveStoryData(id, storyData);
    }

    res.json({ success: true, ...evaluation });
  } catch (err) {
    log.error('Error in style-lab evaluate:', err);
    res.status(500).json({ error: 'Failed to evaluate: ' + err.message });
  }
});

// Style Lab: get history for a page (thumbnails + metadata, no full images)
router.get('/:id/style-lab/:pageNum/history', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });

    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    // Load run metadata from storyData
    const storyResult = await getDbPool().query('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    const storyData = typeof storyResult.rows[0].data === 'string' ? JSON.parse(storyResult.rows[0].data) : storyResult.rows[0].data;
    const allRuns = (storyData.styleLabHistory || []).filter(r => r.pageNumber === pageNumber);

    // Load thumbnails from DB
    const thumbRows = await getStyleLabThumbnails(id, pageNumber);
    const thumbMap = {}; // runId -> { modelId: thumbnail }
    for (const row of thumbRows) {
      if (!thumbMap[row.run_id]) thumbMap[row.run_id] = {};
      thumbMap[row.run_id][row.model_id] = row.thumbnail;
    }

    const runs = allRuns.map(run => ({
      ...run,
      thumbnails: thumbMap[run.runId] || {}
    }));

    res.json({ success: true, runs });
  } catch (err) {
    log.error('Error in style-lab history:', err);
    res.status(500).json({ error: 'Failed to load history: ' + err.message });
  }
});

// Style Lab: get full images for a specific run (lazy load on expand)
router.get('/:id/style-lab/:pageNum/history/:runId', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum, runId } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });

    // Admin only
    const userResult = await getDbPool().query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userResult.rows[0].role !== 'admin' && !req.user.impersonating) return res.status(403).json({ error: 'Admin only' });

    const images = await getStyleLabRunImages(id, pageNumber, runId);
    const results = {};
    for (const img of images) {
      results[img.model_id] = {
        imageData: img.image_data,
        stylePrompt: img.style_prompt,
        elapsed: img.elapsed_ms,
        createdAt: img.created_at
      };
    }

    res.json({ success: true, runId, results });
  } catch (err) {
    log.error('Error in style-lab run images:', err);
    res.status(500).json({ error: 'Failed to load run images: ' + err.message });
  }
});

// Iterate image using 17-check scene description prompt with actual image analysis (DEV MODE ONLY)
// This endpoint analyzes the current image, feeds composition to the scene description prompt,
// runs the 17 validation checks, and regenerates with a corrected scene description
router.post('/:id/iterate/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { imageModel, sceneModel, useOriginalAsReference, blackoutIssues, evaluationFeedback, iterativePlacement } = req.body;  // Optional: model overrides + evaluation feedback
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    const creditCost = CREDIT_COSTS.IMAGE_REGENERATION;

    // Check if admin is impersonating - they get free iterations
    const isImpersonating = req.user.impersonating === true;
    log.info(`🔄 [ITERATE] Starting iteration for story ${id}, page ${pageNumber}${isImpersonating ? ' (admin impersonating)' : ''}`);

    // Check user credits first (-1 means infinite/unlimited, impersonating admins also skip)
    const userResult = await getDbPool().query('SELECT credits, role FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      log.warn(`🔄 [ITERATE] User not found: ${req.user.id}`);
      return res.status(404).json({ error: 'User not found' });
    }
    const userCredits = userResult.rows[0].credits || 0;
    const userRole = userResult.rows[0].role;
    const hasInfiniteCredits = userCredits === -1 || isImpersonating;

    // Only admins can use iteration (dev mode feature)
    if (userRole !== 'admin' && !isImpersonating) {
      log.warn(`🔄 [ITERATE] Access denied: role=${userRole}, impersonating=${isImpersonating}`);
      return res.status(403).json({ error: 'Iteration is only available in developer mode' });
    }

    if (!hasInfiniteCredits && userCredits < creditCost) {
      log.warn(`🔄 [ITERATE] Insufficient credits: ${userCredits} < ${creditCost}`);
      return res.status(402).json({
        error: 'Insufficient credits',
        required: creditCost,
        available: userCredits
      });
    }

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      log.warn(`🔄 [ITERATE] Story not found: ${id} for user ${req.user.id}`);
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from story_images table (images may be stripped from data blob)
    storyData = await rehydrateStoryImages(id, storyData);

    // Determine if this is a cover iteration (negative page numbers)
    const isCover = pageNumber < 0;
    const COVER_PAGE_MAP_REVERSE = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
    const coverKey = isCover ? COVER_PAGE_MAP_REVERSE[String(pageNumber)] : null;

    if (isCover) {
      // =========================================================================
      // COVER ITERATION BRANCH — uses shared iterateCover function
      // =========================================================================
      if (!coverKey) {
        return res.status(400).json({ error: `Invalid cover page number: ${pageNumber}. Use -1 (front), -2 (initial), -3 (back).` });
      }

      storyData.coverImages = storyData.coverImages || {};
      const existingCover = storyData.coverImages[coverKey];
      if (!existingCover || !existingCover.imageData) {
        return res.status(400).json({ error: `No cover image found for ${coverKey}` });
      }

      const sceneDescription = existingCover.description || 'A beautiful illustrated cover page.';
      const normalizedCoverType = coverKey === 'frontCover' ? 'front' : coverKey === 'initialPage' ? 'initialPage' : 'back';

      // Merge avatars: story avatars first, then fresh from characters table as fallback
      const freshCharResult = await getDbPool().query(
        'SELECT data FROM characters WHERE user_id = $1',
        [req.user.id]
      );
      const freshCharData = freshCharResult.rows[0]?.data || {};
      const freshCharacters = freshCharData.characters || [];

      // Use shared cover iterate function
      const { iterateCover } = require('../lib/coverIterate');
      const imageResult = await iterateCover(coverKey, storyData, {
        imageModel: imageModel || null,
        evaluationFeedback,
        useOriginalAsReference: !!useOriginalAsReference,
        blackoutIssues: !!blackoutIssues,
        freshCharacters,
      });

      const previousImageData = imageResult.previousImage;
      const previousScore = imageResult.previousScore;
      const coverCharacterPhotos = imageResult.referencePhotos;
      const coverLandmarkPhotos = []; // Covers don't use landmark photos
      const coverVbGrid = null; // No VB grid for covers
      const coverPrompt = imageResult.prompt;
      const coverImageModelId = imageModel || MODEL_DEFAULTS.coverImage;

      log.info(`🔄 [ITERATE] Cover ${coverKey}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

      // --- Version management ---
      // Initialize imageVersions if needed (lazy migration)
      if (!existingCover.imageVersions) {
        existingCover.imageVersions = [];
        if (existingCover.originalImage) {
          existingCover.imageVersions.push({
            imageData: existingCover.originalImage,
            qualityScore: existingCover.originalScore,
            description: existingCover.description,
            createdAt: storyData.createdAt || new Date().toISOString(),
            type: 'original',
            isActive: false,
            _alreadySaved: true  // Already at DB v0, don't re-save
          });
        }
        const currentImageData = existingCover.imageData || null;
        if (currentImageData && (!existingCover.originalImage || currentImageData !== existingCover.originalImage)) {
          existingCover.imageVersions.push({
            imageData: currentImageData,
            qualityScore: existingCover.qualityScore,
            description: existingCover.description,
            prompt: existingCover.prompt,
            modelId: existingCover.modelId,
            createdAt: existingCover.regeneratedAt || existingCover.generatedAt || new Date().toISOString(),
            type: existingCover.wasRegenerated ? 'regeneration' : 'original',
            isActive: false,
            _alreadySaved: true  // Already in DB, don't re-save (would collide with new version)
          });
        } else if (currentImageData && existingCover.imageVersions.length > 0) {
          existingCover.imageVersions[0].isActive = false;
        }
        log.debug(`🔄 [ITERATE] Migrated legacy cover format to imageVersions[] (${existingCover.imageVersions.length} versions)`);
      }

      // Mark all existing versions as inactive
      existingCover.imageVersions.forEach(v => v.isActive = false);

      // Create new version entry
      const timestamp = new Date().toISOString();
      const newVersion = {
        imageData: imageResult.imageData,
        qualityScore: imageResult.score ?? null,
        qualityReasoning: imageResult.reasoning || null,
        description: sceneDescription,
        prompt: coverPrompt,
        modelId: imageResult.modelId || coverImageModelId,
        createdAt: timestamp,
        generatedAt: timestamp,
        type: 'iteration',
        isActive: true,
        fixTargets: imageResult.fixTargets || [],
        fixableIssues: imageResult.fixableIssues || [],
        totalAttempts: imageResult.totalAttempts || null,
        referencePhotoNames: (coverCharacterPhotos || []).map(p => ({
          name: p.name, photoType: p.photoType,
          clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
        })),
        bboxDetection: imageResult.bboxDetection || null,
      };
      existingCover.imageVersions.push(newVersion);

      // Also update cover-level bboxDetection to match new active image
      existingCover.bboxDetection = imageResult.bboxDetection || null;

      // Query database for actual max version_index to avoid overwriting existing versions
      const maxVersionResult = await dbQuery(
        `SELECT COALESCE(MAX(version_index), -1) as max_version
         FROM story_images
         WHERE story_id = $1 AND image_type = $2 AND page_number IS NULL`,
        [id, coverKey]
      );
      const currentMaxVersion = maxVersionResult[0]?.max_version ?? -1;
      const newVersionIndex = currentMaxVersion + 1;

      // Save the new cover image directly at the correct version_index
      await saveStoryImage(id, coverKey, null, imageResult.imageData, {
        qualityScore: imageResult.score,
        generatedAt: timestamp,
        versionIndex: newVersionIndex
      });
      // Mark as already saved so saveStoryData doesn't re-save it
      newVersion._alreadySaved = true;

      // Update the cover data in storyData
      const coverData = {
        ...existingCover,
        imageData: imageResult.imageData,
        description: sceneDescription,
        prompt: coverPrompt,
        qualityScore: imageResult.score,
        qualityReasoning: imageResult.reasoning || null,
        fixTargets: imageResult.fixTargets || [],
        modelId: imageResult.modelId || coverImageModelId,
        wasIterated: true,
        wasRegenerated: true,
        totalAttempts: imageResult.totalAttempts || 1,
        previousImage: previousImageData,
        previousScore: previousScore,
        originalImage: existingCover.originalImage || previousImageData,
        originalScore: existingCover.originalScore || previousScore,
        referencePhotos: coverCharacterPhotos,
        iteratedAt: timestamp,
        iterationCount: (existingCover.iterationCount || 0) + 1,
        imageVersions: existingCover.imageVersions
      };
      storyData.coverImages[coverKey] = coverData;

      // Update active version in metadata
      await setActiveVersion(id, coverKey, newVersionIndex);

      // Save updated story (covers use saveStoryData, not saveScenePageData)
      await saveStoryData(id, storyData);

      // Deduct credits if not unlimited
      let newCredits = hasInfiniteCredits ? -1 : userCredits - creditCost;
      if (!hasInfiniteCredits) {
        await getDbPool().query(
          'UPDATE users SET credits = credits - $1 WHERE id = $2',
          [creditCost, req.user.id]
        );
        await getDbPool().query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
           VALUES ($1, $2, $3, 'image_iteration', $4)`,
          [req.user.id, -creditCost, newCredits, `Iterate cover ${coverKey}`]
        );
      }

      log.info(`✅ [ITERATE] Cover ${coverKey}: Iteration complete (score: ${imageResult.score})`);

      // Build image versions for response — load all from DB so version picker shows images
      const imageVersions = await Promise.all(existingCover.imageVersions.map(async (v, idx) => {
        let imgData = v.imageData || undefined;
        if (!imgData) {
          try {
            const dbImg = await getStoryImage(id, coverKey, null, arrayToDbIndex(idx, coverKey));
            imgData = dbImg?.imageData || undefined;
          } catch { /* ignore */ }
        }
        return {
          versionIndex: idx,
          description: v.description,
          prompt: v.prompt,
          modelId: v.modelId,
          createdAt: v.createdAt,
          isActive: v.isActive,
          type: v.type,
          qualityScore: v.qualityScore,
          imageData: imgData,
        };
      }));

      // Persist repair cost in background (fire before return so it's not skipped)
      const coverIterateCost = calculateImageCost(coverImageModelId, imageResult.totalAttempts || 1);
      addRepairCost(id, coverIterateCost, `Iterate cover ${coverKey}`).catch(err => log.error('Failed to save cover iterate cost:', err.message));

      return res.json({
        success: true,
        pageNumber,
        coverType: normalizedCoverType,
        // No composition / previewMismatches / checksRun for covers (no scene analysis)
        composition: null,
        previewMismatches: [],
        checksRun: {},
        // New content
        sceneDescription,
        imageData: imageResult.imageData,
        qualityScore: imageResult.score,
        qualityReasoning: imageResult.reasoning,
        modelId: imageResult.modelId || coverImageModelId,
        totalAttempts: imageResult.totalAttempts,
        // Previous version
        previousImage: previousImageData,
        previousScore: previousScore,
        // Blackout image
        blackoutImage: (blackoutIssues && previousImage !== existingCover.imageData) ? previousImage : null,
        // Image versions for history display
        imageVersions,
        // Credits
        creditsUsed: hasInfiniteCredits ? 0 : creditCost,
        creditsRemaining: newCredits,
        // Reference info
        referencePhotos: coverCharacterPhotos,
        landmarkPhotos: coverLandmarkPhotos,
        visualBibleGrid: coverVbGrid ? `data:image/jpeg;base64,${coverVbGrid.toString('base64')}` : null,
        grokRefImages: imageResult.grokRefImages || null,
        message: 'Cover regenerated with fresh generation',
        // Version info
        versionIndex: newVersionIndex
      });
    }

    // =========================================================================
    // SCENE PAGE ITERATION BRANCH (existing flow, unchanged)
    // =========================================================================

    // Get current image
    const sceneImages = storyData.sceneImages || [];
    const currentImage = sceneImages.find(img => img.pageNumber === pageNumber);
    if (!currentImage || !currentImage.imageData) {
      return res.status(400).json({ error: `No image found for page ${pageNumber}` });
    }

    // Get current scene description
    const sceneDescriptions = storyData.sceneDescriptions || [];
    const currentScene = sceneDescriptions.find(s => s.pageNumber === pageNumber);
    if (!currentScene) {
      return res.status(400).json({ error: `No scene description found for page ${pageNumber}` });
    }

    log.info(`🔄 [ITERATE] Page ${pageNumber}: Analyzing current image with vision model...`);

    // Get context for image analysis
    const characters = storyData.characters || [];
    const visualBible = storyData.visualBible || null;
    const clothingRequirements = storyData.clothingRequirements || null;

    // Step 1: Analyze the current image using analyzeGeneratedImage (identifies characters by name)
    const { analyzeGeneratedImage } = require('../lib/sceneValidator');
    const imageDescription = await analyzeGeneratedImage(currentImage.imageData, characters, visualBible, clothingRequirements);
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Composition analysis complete (${imageDescription.description.length} chars)`);
    log.debug(`🔄 [ITERATE] Composition: ${imageDescription.description.substring(0, 200)}...`);

    // Step 2: Build previewFeedback from the image analysis
    const previewFeedback = {
      composition: imageDescription.description
    };

    // Step 3: Gather context for scene description prompt
    const fullStoryText = storyData.storyText || storyData.story || '';
    const pageText = getPageText(fullStoryText, pageNumber);
    if (!pageText) {
      return res.status(404).json({ error: `Page ${pageNumber} text not found` });
    }

    const language = storyData.language || 'en';
    const pageClothingData = storyData.pageClothing || null;

    // Build previous scenes context
    const previousScenes = [];
    for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
      if (prevPage >= 1) {
        const prevText = getPageText(fullStoryText, prevPage);
        if (prevText) {
          let prevClothing = pageClothingData?.pageClothing?.[prevPage] || null;
          if (!prevClothing) {
            const prevSceneDesc = sceneDescriptions.find(s => s.pageNumber === prevPage);
            prevClothing = prevSceneDesc ? parseClothingCategory(prevSceneDesc.description) : null;
          }
          previousScenes.push({
            pageNumber: prevPage,
            text: prevText,
            sceneHint: '',
            clothing: prevClothing
          });
        }
      }
    }

    // Get expected clothing for this page
    const expectedClothing = pageClothingData?.pageClothing?.[pageNumber] || pageClothingData?.primaryClothing || 'standard';
    log.debug(`🔄 [ITERATE] Expected clothing: ${expectedClothing}`);

    // Build available avatars
    const availableAvatars = buildAvailableAvatarsForPrompt(characters, clothingRequirements);

    // Extract short scene description from current scene (the "hint" that will be critiqued)
    let shortSceneDesc = '';
    const sceneMetadata = extractSceneMetadata(currentScene.description);
    if (sceneMetadata?.imageSummary) {
      shortSceneDesc = sceneMetadata.imageSummary;
    } else {
      // Fall back to first part of description
      shortSceneDesc = currentScene.description.substring(0, 500);
    }

    log.info(`🔄 [ITERATE] Page ${pageNumber}: Building scene description prompt with preview feedback...`);

    // Step 4: Build the scene description prompt with preview feedback
    const scenePrompt = buildSceneDescriptionPrompt(
      pageNumber,
      pageText,
      characters,
      shortSceneDesc,  // The current scene hint to critique
      language,
      visualBible,
      previousScenes,
      expectedClothing,
      '',  // No correction notes for iteration
      availableAvatars,
      null,  // rawOutlineContext
      previewFeedback  // The actual image analysis feedback!
    );

    // Step 5: Call Claude to run 17 checks and generate corrected scene (uses iteration model)
    const effectiveSceneModel = sceneModel || MODEL_DEFAULTS.sceneIteration;
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Running 17 validation checks with ${effectiveSceneModel}...`);
    const sceneResult = await callClaudeAPI(scenePrompt, 10000, effectiveSceneModel, { prefill: '{"previewMismatches":[' });
    const newSceneDescription = sceneResult.text;

    // Parse the scene JSON to extract previewMismatches
    let previewMismatches = [];
    let checksRun = {};
    try {
      const cleanedScene = newSceneDescription.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
      const sceneJson = JSON.parse(cleanedScene);
      previewMismatches = sceneJson.previewMismatches || [];
      checksRun = sceneJson.selfCritique || {};
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Found ${previewMismatches.length} mismatches: ${JSON.stringify(previewMismatches)}`);
    } catch (parseErr) {
      log.warn(`🔄 [ITERATE] Could not parse scene JSON for mismatches: ${parseErr.message}`);
    }

    // Update scene description in story data
    const existingSceneIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);
    const translatedSummary = extractSceneMetadata(newSceneDescription)?.translatedSummary || null;
    const imageSummary = extractSceneMetadata(newSceneDescription)?.imageSummary || null;

    const sceneEntry = {
      pageNumber,
      description: newSceneDescription,
      translatedSummary,
      imageSummary,
      iteratedAt: new Date().toISOString(),
      iterationFeedback: previewFeedback.composition
    };

    if (existingSceneIndex >= 0) {
      sceneDescriptions[existingSceneIndex] = { ...sceneDescriptions[existingSceneIndex], ...sceneEntry };
    } else {
      sceneDescriptions.push(sceneEntry);
      sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    log.info(`🔄 [ITERATE] Page ${pageNumber}: Generating new image with corrected scene description...`);

    // Step 6: Regenerate image with corrected scene
    // Determine which characters appear in this scene
    const sceneCharacters = getCharactersInScene(newSceneDescription, characters);

    // Extract metadata from the new scene description FIRST to get per-character clothing
    const newSceneMetadata = extractSceneMetadata(newSceneDescription);

    // Get clothing - PREFER per-character clothing from the new scene description
    // This ensures we use the clothing the scene prompt just generated (e.g., "costumed:wizard")
    // rather than stale pageClothing data
    let clothingCategory;
    let effectiveClothingRequirements = clothingRequirements;

    // Priority 1: Per-character clothing from newly generated scene description
    if (newSceneMetadata?.characterClothing && Object.keys(newSceneMetadata.characterClothing).length > 0) {
      const sceneClothing = newSceneMetadata.characterClothing;
      const perCharClothing = convertClothingToCurrentFormat(sceneClothing);
      effectiveClothingRequirements = { ...clothingRequirements };
      for (const [charName, charClothing] of Object.entries(perCharClothing)) {
        effectiveClothingRequirements[charName] = {
          ...effectiveClothingRequirements[charName],
          ...charClothing
        };
      }
      // Determine predominant clothing category from per-character data
      const clothingValues = Object.values(sceneClothing);
      const firstClothing = clothingValues[0];
      if (firstClothing && firstClothing.startsWith('costumed:')) {
        clothingCategory = firstClothing;
      } else {
        clothingCategory = firstClothing || 'standard';
      }
      log.debug(`🔄 [ITERATE] Using per-character clothing from scene description: ${JSON.stringify(sceneClothing)}`);
    }
    // Priority 2: Per-character clothing from pageClothing (stored data)
    else {
      const pageClothingEntry = pageClothingData?.pageClothing?.[pageNumber];
      if (typeof pageClothingEntry === 'string') {
        clothingCategory = pageClothingEntry;
      } else if (pageClothingEntry && typeof pageClothingEntry === 'object') {
        const perPageClothing = convertClothingToCurrentFormat(pageClothingEntry);
        effectiveClothingRequirements = { ...clothingRequirements };
        for (const [charName, charClothing] of Object.entries(perPageClothing)) {
          effectiveClothingRequirements[charName] = {
            ...effectiveClothingRequirements[charName],
            ...charClothing
          };
        }
        const clothingValues = Object.values(pageClothingEntry);
        const firstClothing = clothingValues[0];
        if (firstClothing && firstClothing.startsWith('costumed:')) {
          clothingCategory = firstClothing;
        } else {
          clothingCategory = firstClothing || 'standard';
        }
        log.debug(`🔄 [ITERATE] Using per-character clothing from pageClothing: ${JSON.stringify(pageClothingEntry)}`);
      } else {
        clothingCategory = parseClothingCategory(newSceneDescription) || pageClothingData?.primaryClothing || 'standard';
      }
    }

    const artStyle = storyData.artStyle || 'pixar';
    let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, artStyle, effectiveClothingRequirements);
    if (!clothingCategory || !clothingCategory.startsWith('costumed')) {
      referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
    }

    // Build landmark photos and VB grid (newSceneMetadata already extracted above)
    const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, newSceneMetadata) : [];

    let visualBibleGrid = null;
    if (visualBible) {
      const elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
      const secondaryLandmarks = pageLandmarkPhotos.slice(1);
      if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
        visualBibleGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
      }
    }

    // Extract only the scene part for image generation (strip previewMismatches, checks, corrections)
    let cleanSceneForImage = newSceneDescription;
    try {
      const parsed = JSON.parse(newSceneDescription);
      const sceneObj = parsed?.previewMismatches?.[0]?.scene || parsed?.scene || parsed;
      if (sceneObj?.imageSummary || sceneObj?.characters) {
        cleanSceneForImage = JSON.stringify({ scene: sceneObj });
      }
    } catch {
      // If JSON parse fails, try extracting scene block with regex
      const sceneMatch = newSceneDescription.match(/"scene"\s*:\s*\{[\s\S]*"imageSummary"/);
      if (sceneMatch) {
        // Find the matching closing brace for the scene object
        const startIdx = newSceneDescription.indexOf(sceneMatch[0]);
        let depth = 0;
        let endIdx = startIdx;
        for (let i = startIdx + '"scene":'.length; i < newSceneDescription.length; i++) {
          if (newSceneDescription[i] === '{') depth++;
          if (newSceneDescription[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
        }
        if (endIdx > startIdx) {
          cleanSceneForImage = newSceneDescription.substring(startIdx, endIdx);
        }
      }
    }

    // Build image prompt (append evaluation feedback if provided)
    // Only include critical issues (missing characters/objects/settings) — not pose/expression nitpicks
    const iterateImageBackend = imageModel ? (IMAGE_MODELS[imageModel]?.backend || null) : null;
    let imagePrompt = buildImagePrompt(cleanSceneForImage, storyData, sceneCharacters, false, visualBible, pageNumber, true, referencePhotos, { imageBackend: iterateImageBackend });
    if (evaluationFeedback) {
      const criticalIssues = (evaluationFeedback.fixableIssues || [])
        .filter(i => {
          const desc = (i.description || i.issue || '').toLowerCase();
          // Only keep issues about missing/wrong elements, not pose or expression differences
          return desc.includes('missing') || desc.includes('absent') || desc.includes('not present')
            || desc.includes('wrong setting') || desc.includes('wrong location');
        });
      if (criticalIssues.length > 0) {
        const feedbackText = 'IMPORTANT — ensure these elements are present this time:\n' +
          criticalIssues.map(i => `- ${i.description || i.issue || i}`).join('\n');
        imagePrompt = `${imagePrompt}\n\n${feedbackText}`;
        log.info(`🔄 [ITERATE] Page ${pageNumber}: Appended ${criticalIssues.length} critical issues as positive instructions (score: ${evaluationFeedback.score ?? 'N/A'})`);
      }
    }

    // Clear cache to force new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    deleteFromImageCache(cacheKey);

    // Store previous image data
    const previousImageData = currentImage.imageData;
    const previousScore = currentImage.qualityScore || null;

    // Generate new image - use developer model override if provided, otherwise use default
    let imageModelOverride = imageModel || null;  // null means use default (gemini-2.5-flash-image for scenes)
    if (imageModelOverride) {
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Using model override: ${imageModelOverride}`);
    }
    let previousImage = null;
    if (blackoutIssues) {
      // Blackout mode: black out issue regions in the current image to force regeneration
      const fixTargets = currentImage.fixTargets || [];
      if (fixTargets.length > 0) {
        log.info(`🔄 [ITERATE] Page ${pageNumber}: Blacking out ${fixTargets.length} issue regions in current image`);
        previousImage = await blackoutIssueRegions(currentImage.imageData, fixTargets);
      } else {
        log.warn(`🔄 [ITERATE] Page ${pageNumber}: No fix targets available for blackout, falling back to original as reference`);
        previousImage = currentImage.imageData;
      }
    } else if (useOriginalAsReference) {
      previousImage = currentImage.imageData;
      log.info(`🔄 [ITERATE] Page ${pageNumber}: Using original image as reference for generation`);
    }
    const iterateSceneMetadata = extractSceneMetadata(newSceneDescription);

    // Route by scene complexity when no explicit model override
    if (!imageModelOverride) {
      const sceneComplexity = iterateSceneMetadata?.sceneComplexity || 'simple';
      if (sceneComplexity === 'complex') {
        imageModelOverride = MODEL_DEFAULTS.complexPageImage;
        log.info(`🎯 [ITERATE] Page ${pageNumber}: complex scene → ${imageModelOverride}`);
      }
    }

    let imageResult;
    if (iterativePlacement) {
      const iterBackend = imageModelOverride ? (IMAGE_MODELS[imageModelOverride]?.backend || null) : null;
      const { resolveArtStyle: resolveIterStyle } = require('../lib/storyHelpers');
      const iterArtStyleDesc = resolveIterStyle(storyData.artStyle || 'pixar', iterBackend) || resolveIterStyle('pixar') || '';
      imageResult = await generateWithIterativePlacement(imagePrompt, referencePhotos, iterateSceneMetadata, {
        imageModelOverride,
        imageBackendOverride: iterBackend,
        landmarkPhotos: pageLandmarkPhotos,
        visualBibleGrid,
        pageNumber,
        artStyle: iterArtStyleDesc,
      });
    } else {
      imageResult = await generateImageWithQualityRetry(
        imagePrompt, referencePhotos, previousImage, 'scene', null, null, null,
        { imageModel: imageModelOverride },
        `PAGE ${pageNumber} ITERATE`,
        { landmarkPhotos: pageLandmarkPhotos, visualBibleGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata: iterateSceneMetadata }
      );
    }

    log.info(`🔄 [ITERATE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

    // Step 7: Update the image in story data
    const existingImageIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: newSceneDescription,
      sceneDescription: newSceneDescription,  // alias for backward compat
      prompt: imagePrompt,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning || null,
      qualityModelId: imageResult.qualityModelId || null,
      fixTargets: imageResult.fixTargets || [],
      wasIterated: true,
      iteratedAt: new Date().toISOString(),
      iterationFeedback: previewFeedback.composition,
      previewMismatches,
      totalAttempts: imageResult.totalAttempts || 1,
      previousImage: previousImageData,
      previousScore: previousScore,
      originalImage: currentImage.originalImage || previousImageData,
      originalScore: currentImage.originalScore || previousScore,
      referencePhotos,
      landmarkPhotos: pageLandmarkPhotos,
      visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null,
      modelId: imageResult.modelId || null,
      iterationCount: (currentImage.iterationCount || 0) + 1,
      // Preserve clothing data from original image for entity consistency
      sceneCharacterClothing: currentImage.sceneCharacterClothing || currentImage.characterClothing || null,
      // Persist scene metadata for future bbox calls (re-evaluate, refresh-bbox, entity consistency)
      sceneMetadata: iterateSceneMetadata || currentImage.sceneMetadata || null,
      // Bbox detection from the new image (so scene-level bbox matches active image)
      bboxDetection: imageResult.bboxDetection || null
    };

    // Initialize imageVersions if needed
    if (currentImage && !currentImage.imageVersions) {
      currentImage.imageVersions = [{
        // Don't copy imageData — the original is already stored at DB version_index 0.
        // Including it here would cause saveStoryData to re-save it at version_index 1,
        // creating a duplicate row and an extra "attempt" in the UI.
        description: currentImage.description,
        prompt: currentImage.prompt,
        modelId: currentImage.modelId,
        createdAt: storyData.createdAt || new Date().toISOString(),
        isActive: false,
        type: 'original',
        qualityScore: currentImage.qualityScore ?? null,
        qualityReasoning: currentImage.qualityReasoning || null,
        fixTargets: currentImage.fixTargets || [],
        fixableIssues: currentImage.fixableIssues || [],
        totalAttempts: currentImage.totalAttempts || null,
        referencePhotoNames: (currentImage.referencePhotos || []).map(p => ({
          name: p.name, photoType: p.photoType,
          clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
        })),
      }];
    }

    // Create new version entry
    const timestamp = new Date().toISOString();
    const newVersion = {
      imageData: imageResult.imageData,
      description: newSceneDescription,
      prompt: imagePrompt,
      modelId: imageResult.modelId || null,
      createdAt: timestamp,
      generatedAt: timestamp,  // saveStoryData uses generatedAt for story_images.generated_at
      isActive: true,
      type: 'iteration',
      iterationFeedback: previewFeedback.composition,
      previewMismatches,
      qualityScore: imageResult.score ?? null,
      qualityReasoning: imageResult.reasoning || null,
      fixTargets: imageResult.fixTargets || [],
      fixableIssues: imageResult.fixableIssues || [],
      totalAttempts: imageResult.totalAttempts || null,
      referencePhotoNames: (referencePhotos || []).map(p => ({
        name: p.name, photoType: p.photoType,
        clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
      })),
      bboxDetection: imageResult.bboxDetection || null,
    };

    if (existingImageIndex >= 0) {
      if (sceneImages[existingImageIndex].imageVersions) {
        sceneImages[existingImageIndex].imageVersions.forEach(v => v.isActive = false);
        sceneImages[existingImageIndex].imageVersions.push(newVersion);
      } else {
        sceneImages[existingImageIndex].imageVersions = [newVersion];
      }
      // Update main fields (but NOT imageData - that would cause duplicate image storage)
      // The new image is stored in imageVersions and activeVersion meta points to it
      const { imageData: _unusedImg, ...metadataOnly } = newImageData;
      Object.assign(sceneImages[existingImageIndex], metadataOnly);
      // Delete rehydrated imageData to prevent saveStoryData from re-saving it at version_index 0
      delete sceneImages[existingImageIndex].imageData;
    } else {
      newImageData.imageVersions = [newVersion];
      sceneImages.push(newImageData);
      sceneImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Update image prompts
    storyData.imagePrompts = storyData.imagePrompts || {};
    storyData.imagePrompts[pageNumber] = imagePrompt;

    // Save updated scene atomically (prevents race condition when pages are redone in parallel)
    storyData.sceneImages = sceneImages;
    storyData.sceneDescriptions = sceneDescriptions;
    const updatedSceneData = sceneImages.find(s => s.pageNumber === pageNumber);
    const savedAtomically = updatedSceneData && await saveScenePageData(id, pageNumber, updatedSceneData);
    if (!savedAtomically) {
      // Fallback: save full blob (scene not found in DB array — shouldn't happen normally)
      await saveStoryData(id, storyData);
    }

    // Update active version in metadata
    const scene = updatedSceneData;
    const newActiveIndex = scene?.imageVersions?.length ? getActiveIndexAfterPush(scene.imageVersions, 'scene') : 0;
    await setActiveVersion(id, pageNumber, newActiveIndex);

    // Deduct credits if not unlimited
    let newCredits = hasInfiniteCredits ? -1 : userCredits - creditCost;
    if (!hasInfiniteCredits) {
      await getDbPool().query(
        'UPDATE users SET credits = credits - $1 WHERE id = $2',
        [creditCost, req.user.id]
      );
      await getDbPool().query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
         VALUES ($1, $2, $3, 'image_iteration', $4)`,
        [req.user.id, -creditCost, newCredits, `Iterate image for page ${pageNumber}`]
      );
    }

    log.info(`✅ [ITERATE] Page ${pageNumber}: Iteration complete (${previewMismatches.length} mismatches addressed, score: ${imageResult.score})`);

    // Get the updated image versions with imageData for all versions
    // Version 0 (original) may not have imageData in the blob — load from DB
    const updatedScene = sceneImages.find(img => img.pageNumber === pageNumber);
    log.debug(`🔄 [ITERATE] Page ${pageNumber}: ${updatedScene?.imageVersions?.length || 0} versions after iterate`);
    const imageVersions = await Promise.all((updatedScene?.imageVersions || []).map(async (v, idx) => {
      let imgData = v.imageData || undefined;
      // Version 0 (original) has no imageData in blob — load from story_images
      if (!imgData && idx === 0 && v.type === 'original') {
        try {
          const origImg = await getStoryImage(id, 'scene', pageNumber, 0);
          imgData = origImg?.imageData || undefined;
        } catch { /* ignore */ }
      }
      return {
        versionIndex: idx,  // DB version_index (identity mapping)
        description: v.description,
        prompt: v.prompt,
        modelId: v.modelId,
        createdAt: v.createdAt,
        isActive: v.isActive,
        type: v.type,
        qualityScore: v.qualityScore,
        imageData: imgData,
      };
    }));

    res.json({
      success: true,
      pageNumber,
      // What the vision model saw
      composition: previewFeedback.composition,
      // Claude's analysis
      previewMismatches,
      checksRun,
      // New content
      sceneDescription: newSceneDescription,
      imageData: imageResult.imageData,
      qualityScore: imageResult.score,
      qualityReasoning: imageResult.reasoning,
      modelId: imageResult.modelId,
      totalAttempts: imageResult.totalAttempts,
      // Previous version
      previousImage: previousImageData,
      previousScore: previousScore,
      // Blackout image (the masked image sent to the generator, only when blackout mode was used with fix targets)
      blackoutImage: (blackoutIssues && previousImage !== currentImage.imageData) ? previousImage : null,
      // Image versions for history display
      imageVersions,
      // Credits
      creditsUsed: hasInfiniteCredits ? 0 : creditCost,
      creditsRemaining: newCredits,
      // Reference info
      referencePhotos,
      landmarkPhotos: pageLandmarkPhotos,
      visualBibleGrid: visualBibleGrid ? `data:image/jpeg;base64,${visualBibleGrid.toString('base64')}` : null,
      // Exact images sent to Grok API (max 3 packed/stitched slots)
      grokRefImages: imageResult.grokRefImages || null,
      // Bbox detection for the new image (so frontend can display immediately)
      bboxDetection: imageResult.bboxDetection || null,
      message: previewMismatches.length > 0
        ? `Found ${previewMismatches.length} mismatch(es), regenerated with corrections`
        : 'No mismatches found, regenerated with fresh analysis'
    });

    // Persist repair cost in background
    const iterateImageModelId = imageModelOverride || MODEL_DEFAULTS.pageImage;
    const iterateCost = calculateImageCost(iterateImageModelId, imageResult.totalAttempts || 1);
    addRepairCost(id, iterateCost, `Iterate page ${pageNumber}`).catch(err => log.error('Failed to save iterate cost:', err.message));

  } catch (err) {
    log.error('Error iterating image:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to iterate image: ' + err.message : 'Failed to iterate image' });
  }
});

// Regenerate cover image (front, initialPage, or back)
router.post('/:id/regenerate/cover/:coverType', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, coverType } = req.params;
    const { customPrompt, editedScene, characterIds, editedTitle, editedDedication } = req.body;

    // Accept both 'initial' and 'initialPage' for backwards compatibility
    const normalizedCoverType = coverType === 'initial' ? 'initialPage' : coverType;
    if (!['front', 'initialPage', 'back'].includes(normalizedCoverType)) {
      return res.status(400).json({ error: 'Invalid cover type. Must be: front, initial/initialPage, or back' });
    }

    // Check if admin is impersonating - they get free regenerations
    const isImpersonating = req.user.impersonating === true;

    // Check user credits before proceeding
    const userResult = await getDbPool().query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userCredits = userResult.rows[0].credits || 0;
    const requiredCredits = CREDIT_COSTS.IMAGE_REGENERATION;
    const hasInfiniteCredits = userCredits === -1 || isImpersonating;

    if (!hasInfiniteCredits && userCredits < requiredCredits) {
      return res.status(402).json({
        error: 'Insufficient credits',
        required: requiredCredits,
        available: userCredits
      });
    }

    if (isImpersonating) {
      log.info(`🔄 [IMPERSONATE] Admin regenerating ${normalizedCoverType} cover for story ${id} (FREE - impersonating)`);
    } else {
      log.debug(`🔄 Regenerating ${normalizedCoverType} cover for story ${id} (user credits: ${hasInfiniteCredits ? 'unlimited' : userCredits})`);
    }

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get art style (with per-backend variant for cover model)
    const artStyleId = storyData.artStyle || 'pixar';
    const { resolveArtStyle: resolveStyle } = require('../lib/storyHelpers');
    const coverModelId = MODEL_DEFAULTS.coverImage || MODEL_DEFAULTS.image;
    const coverBackend = IMAGE_MODELS[coverModelId]?.backend || null;
    const styleDescription = resolveStyle(artStyleId, coverBackend) || resolveStyle('pixar');

    // Build character info with main character emphasis
    let characterInfo = '';
    if (storyData.characters && storyData.characters.length > 0) {
      const mainCharacterIds = storyData.mainCharacters || [];
      const mainChars = storyData.characters.filter(c => mainCharacterIds.includes(c.id));
      const supportingChars = storyData.characters.filter(c => !mainCharacterIds.includes(c.id));

      characterInfo = '\n\n**MAIN CHARACTER(S) - Must be prominently featured in the CENTER of the image:**\n';

      mainChars.forEach((char) => {
        const physicalDesc = buildCharacterPhysicalDescription(char);
        characterInfo += `⭐ MAIN: ${physicalDesc}\n`;
      });

      if (supportingChars.length > 0) {
        characterInfo += '\n**Supporting characters (can appear in background or sides):**\n';
        supportingChars.forEach((char) => {
          const physicalDesc = buildCharacterPhysicalDescription(char);
          characterInfo += `Supporting: ${physicalDesc}\n`;
        });
      }

      characterInfo += '\n**CRITICAL: Main character(s) must be the LARGEST and most CENTRAL figures in the composition.**\n';
    }

    // Build visual bible prompt for covers (shows recurring elements like pets, artifacts)
    const visualBible = storyData.visualBible || null;
    const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true }) : '';

    // Use edited title/dedication if provided, otherwise use story data
    const storyTitle = editedTitle !== undefined ? editedTitle : (storyData.title || 'My Story');
    const coverDedication = editedDedication !== undefined ? editedDedication : storyData.dedication;

    // Determine scene description and clothing for this cover type
    // Primary: use the stored description from initial generation (already correctly parsed)
    // Fallback: re-parse from outline (for legacy stories without stored descriptions)
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' : normalizedCoverType === 'initialPage' ? 'initialPage' : 'backCover';
    const storedDescription = storyData.coverImages?.[coverKey]?.description;

    let sceneDescription;
    let coverClothing;
    if (storedDescription && storedDescription.length >= 20) {
      // Use the stored description from initial generation — already correctly parsed
      sceneDescription = storedDescription;
      coverClothing = parseClothingCategory(storedDescription) || 'standard';
      log.debug(`📕 [COVER REGEN] Using stored description for ${normalizedCoverType} (${storedDescription.length} chars)`);
    } else {
      // Fallback: parse from outline for legacy stories
      const coverScenes = extractCoverScenes(storyData.outline || '');
      if (normalizedCoverType === 'front') {
        sceneDescription = coverScenes.titlePage?.scene || 'A beautiful, magical title page featuring the main characters.';
        coverClothing = coverScenes.titlePage?.clothing || parseClothingCategory(sceneDescription) || 'standard';
      } else if (normalizedCoverType === 'initialPage') {
        sceneDescription = coverScenes.initialPage?.scene || 'A warm, inviting dedication/introduction page.';
        coverClothing = coverScenes.initialPage?.clothing || parseClothingCategory(sceneDescription) || 'standard';
      } else {
        sceneDescription = coverScenes.backCover?.scene || 'A satisfying, conclusive ending scene.';
        coverClothing = coverScenes.backCover?.clothing || parseClothingCategory(sceneDescription) || 'standard';
      }
    }

    // Override scene description with user-provided edit (like regular image regeneration)
    if (editedScene && editedScene.trim()) {
      log.debug(`📕 [COVER REGEN] Using user-provided scene description: "${editedScene.substring(0, 100)}..."`);
      sceneDescription = editedScene.trim();
    }

    // coverClothing passed directly — getCharacterPhotoDetails normalizes costumed:type internally
    // Convert clothingRequirements to _currentClothing format for proper avatar lookup
    // This ensures regenerated covers use the story's costumes (not 'standard' fallback)
    const clothingRequirements = convertClothingToCurrentFormat(storyData.clothingRequirements);

    // Fetch fresh avatar data from characters table (fallback for missing avatars)
    const freshCharResult = await getDbPool().query(
      'SELECT data FROM characters WHERE user_id = $1',
      [req.user.id]
    );
    const freshCharData = freshCharResult.rows[0]?.data || {};
    const freshCharacters = freshCharData.characters || [];

    // Merge avatars: story avatars first, then fresh from characters table as fallback
    const mergedCharacters = (storyData.characters || []).map(storyChar => {
      // If story character already has avatars, use them
      if (storyChar.avatars) {
        return storyChar;
      }
      // Otherwise, try to get avatars from characters table
      const freshChar = freshCharacters.find(fc =>
        fc.id === storyChar.id || fc.name === storyChar.name
      );
      if (freshChar?.avatars) {
        log.debug(`📕 [COVER REGEN] Using fresh avatars for ${storyChar.name} (missing in story)`);
        return {
          ...storyChar,
          avatars: freshChar.avatars
        };
      }
      return storyChar;
    });

    // Get character photos with correct clothing variant
    let coverCharacterPhotos;
    let selectedCoverCharacters;  // Track character objects for bbox detection

    // Cap at 5 characters max — more than 5 almost always produces bad results
    // Strategy: main characters appear on ALL covers, non-main are split across initial/back
    const MAX_COVER_CHARACTERS = 5;
    const mainChars = mergedCharacters.filter(c => c.isMainCharacter === true);
    // If no isMainCharacter flags, treat all as "extras" to split across covers
    const nonMainChars = mainChars.length > 0
      ? mergedCharacters.filter(c => !c.isMainCharacter)
      : mergedCharacters;

    // If user provided specific character IDs, use those (still capped)
    if (characterIds && Array.isArray(characterIds) && characterIds.length > 0) {
      selectedCoverCharacters = mergedCharacters.filter(c => characterIds.includes(c.id));
      if (selectedCoverCharacters.length > MAX_COVER_CHARACTERS) {
        log.info(`📕 [COVER REGEN] Capping selected characters from ${selectedCoverCharacters.length} to ${MAX_COVER_CHARACTERS}`);
        selectedCoverCharacters = selectedCoverCharacters.slice(0, MAX_COVER_CHARACTERS);
      }
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
      log.debug(`📕 [COVER REGEN] ${normalizedCoverType}: SELECTED ${selectedCoverCharacters.map(c => c.name).join(', ')} (${coverCharacterPhotos.length} chars), clothing: ${coverClothing}`);
    } else if (normalizedCoverType === 'front') {
      // Front cover: main characters only (capped)
      selectedCoverCharacters = mainChars.length > 0 ? mainChars : mergedCharacters;
      if (selectedCoverCharacters.length > MAX_COVER_CHARACTERS) {
        log.info(`📕 [COVER REGEN] Capping front cover characters from ${selectedCoverCharacters.length} to ${MAX_COVER_CHARACTERS}`);
        selectedCoverCharacters = selectedCoverCharacters.slice(0, MAX_COVER_CHARACTERS);
      }
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
      log.debug(`📕 [COVER REGEN] Front cover: ${mainChars.length > 0 ? 'MAIN: ' + mainChars.map(c => c.name).join(', ') : 'ALL (no main chars defined)'} (${coverCharacterPhotos.length} chars), clothing: ${coverClothing}`);
    } else {
      // Initial/Back: main characters + different non-main extras per cover
      const mainCapped = mainChars.slice(0, MAX_COVER_CHARACTERS);
      const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
      const halfPoint = Math.ceil(nonMainChars.length / 2);
      let extras;
      if (normalizedCoverType === 'initialPage') {
        extras = nonMainChars.slice(0, halfPoint).slice(0, extraSlots);
      } else {
        // back cover gets the second half
        extras = nonMainChars.slice(halfPoint).slice(0, extraSlots);
      }
      selectedCoverCharacters = [...mainCapped, ...extras];
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCoverCharacters, coverClothing, artStyleId, clothingRequirements);
      log.debug(`📕 [COVER REGEN] ${normalizedCoverType}: ${selectedCoverCharacters.map(c => c.name).join(', ')} (${coverCharacterPhotos.length} chars), clothing: ${coverClothing}`);
    }
    // Apply styled avatars for non-costumed characters
    if (!coverClothing || !coverClothing.startsWith('costumed')) {
      coverCharacterPhotos = applyStyledAvatars(coverCharacterPhotos, artStyleId);
    }

    // Build cover prompt
    let coverPrompt;
    if (customPrompt) {
      coverPrompt = customPrompt;
    } else {
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

      // If user selected specific characters, add explicit restriction to prompt
      if (characterIds && Array.isArray(characterIds) && characterIds.length > 0) {
        const selectedNames = coverCharacterPhotos.map(p => p.name);
        const allNames = (storyData.characters || []).map(c => c.name);
        const excludedNames = allNames.filter(n => !selectedNames.includes(n));

        if (excludedNames.length > 0) {
          coverPrompt += `\n\n**CRITICAL CHARACTER RESTRICTION:**\nONLY show these characters: ${selectedNames.join(', ')}\nDo NOT include: ${excludedNames.join(', ')}\nIf the scene description mentions excluded characters, IGNORE those mentions and show ONLY the specified characters.`;
          log.debug(`📕 [COVER REGEN] Added character restriction: show ${selectedNames.join(', ')}, exclude ${excludedNames.join(', ')}`);
        }
      }
    }

    // Get the current cover image before regenerating (to store as previous version)
    storyData.coverImages = storyData.coverImages || {};
    const existingCover = storyData.coverImages[coverKey] || {};

    // Initialize imageVersions array if missing (lazy migration from legacy format)
    if (!existingCover.imageVersions) {
      existingCover.imageVersions = [];

      // Migrate originalImage as version 0 if exists
      if (existingCover.originalImage) {
        existingCover.imageVersions.push({
          imageData: existingCover.originalImage,
          qualityScore: existingCover.originalScore,
          description: existingCover.description,
          createdAt: storyData.createdAt || new Date().toISOString(),
          type: 'original',
          isActive: false
        });
      }

      // Current image as next version (if different from original or no original)
      const currentImageData = existingCover.imageData || (typeof existingCover === 'string' ? existingCover : null);
      if (currentImageData && (!existingCover.originalImage || currentImageData !== existingCover.originalImage)) {
        existingCover.imageVersions.push({
          imageData: currentImageData,
          qualityScore: existingCover.qualityScore,
          description: existingCover.description,
          prompt: existingCover.prompt,
          modelId: existingCover.modelId,
          createdAt: existingCover.regeneratedAt || existingCover.generatedAt || new Date().toISOString(),
          type: existingCover.wasRegenerated ? 'regeneration' : 'original',
          isActive: true
        });
      } else if (currentImageData) {
        // originalImage exists and equals currentImageData - mark version 0 as active
        if (existingCover.imageVersions.length > 0) {
          existingCover.imageVersions[0].isActive = true;
        }
      }

      log.debug(`📸 [COVER REGEN] Migrated legacy cover format to imageVersions[] (${existingCover.imageVersions.length} versions)`);
    }

    // For backwards compatibility, also capture previous version info
    const previousCover = existingCover;
    const previousImageData = previousCover?.imageData || (typeof previousCover === 'string' ? previousCover : null);
    const previousScore = previousCover?.qualityScore || null;
    const previousReasoning = previousCover?.qualityReasoning || null;
    const previousPrompt = previousCover?.prompt || null;
    // Keep the true original if this was already regenerated before
    const trueOriginalImage = previousCover?.originalImage || previousImageData;
    const trueOriginalScore = previousCover?.originalScore || previousScore;
    const trueOriginalReasoning = previousCover?.originalReasoning || previousReasoning;

    log.debug(`📸 [COVER REGEN] Capturing previous ${normalizedCoverType} cover (${previousImageData ? 'has data' : 'none'}, score: ${previousScore}, versions: ${existingCover.imageVersions?.length || 0})`);

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(coverPrompt, coverCharacterPhotos, null);
    if (deleteFromImageCache(cacheKey)) {
      log.debug(`[REGEN] Cleared cache for ${normalizedCoverType} cover to force new generation`);
    }

    // Generate new cover with quality retry (automatically retries on text errors)
    // Use same model as initial generation for consistency
    const coverLabel = normalizedCoverType === 'front' ? 'FRONT COVER' : normalizedCoverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
    const coverImageModelId = MODEL_DEFAULTS.coverImage;
    const coverRegenSceneMetadata = extractSceneMetadata(sceneDescription);
    const coverResult = await generateImageWithQualityRetry(
      coverPrompt, coverCharacterPhotos, null, 'cover', null, null, null,
      { imageModel: coverImageModelId },
      coverLabel,
      { sceneCharacters: selectedCoverCharacters, sceneMetadata: coverRegenSceneMetadata }
    );

    // Log API costs for this cover regeneration
    const coverImageCost = calculateImageCost(coverImageModelId, coverResult.totalAttempts || 1);
    log.info(`💰 [COVER REGEN] API Cost: ${formatCostSummary(coverImageModelId, { imageCount: coverResult.totalAttempts || 1 }, coverImageCost)} (${coverResult.totalAttempts || 1} attempt(s))`);

    // Create new version entry
    const coverRegenTimestamp = new Date().toISOString();
    const newVersion = {
      imageData: coverResult.imageData,
      qualityScore: coverResult.score,
      description: sceneDescription,
      prompt: coverPrompt,
      modelId: coverResult.modelId || coverImageModelId,
      createdAt: coverRegenTimestamp,
      generatedAt: coverRegenTimestamp,
      type: 'regeneration',
      isActive: true
    };

    // Mark all existing versions as inactive and add new version
    const updatedVersions = (existingCover.imageVersions || []).map(v => ({ ...v, isActive: false }));
    updatedVersions.push(newVersion);

    // Query database for actual max version_index (blob data may have stripped imageData)
    // This ensures we don't overwrite existing versions when the blob's imageVersions is incomplete
    const maxVersionResult = await dbQuery(
      `SELECT COALESCE(MAX(version_index), -1) as max_version
       FROM story_images
       WHERE story_id = $1 AND image_type = $2 AND page_number IS NULL`,
      [id, coverKey]
    );
    const currentMaxVersion = maxVersionResult[0]?.max_version ?? -1;
    const newVersionIndex = currentMaxVersion + 1;

    // Update the cover in story data with new structure including quality, description, prompt, and previous version
    const coverData = {
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning || null,
      fixTargets: coverResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: coverResult.modelId || null,
      wasRegenerated: true,
      totalAttempts: coverResult.totalAttempts || 1,
      retryHistory: coverResult.retryHistory || [],
      // Store previous version (for undo/comparison) - kept for backwards compatibility
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      previousPrompt: previousPrompt,
      // Keep the true original across multiple regenerations - kept for backwards compatibility
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      referencePhotos: coverCharacterPhotos,
      regeneratedAt: new Date().toISOString(),
      regenerationCount: (previousCover?.regenerationCount || 0) + 1,
      bboxDetection: coverResult.bboxDetection || null,
      bboxOverlayImage: coverResult.bboxOverlayImage || null,
      // NEW: imageVersions array for unified versioning
      imageVersions: updatedVersions
    };

    log.debug(`📸 [COVER REGEN] New ${normalizedCoverType} cover generated - score: ${coverResult.score}, attempts: ${coverResult.totalAttempts}, model: ${coverResult.modelId}, version: ${newVersionIndex}`);

    // Save the new cover image directly at the correct version_index BEFORE saveStoryData
    // saveStoryData uses arrayToDbIndex(i, coverType) which maps based on array position,
    // but the array may not have all historical entries (migration can produce 0 versions).
    // Saving directly ensures the image lands at the right version_index.
    const { saveStoryImage } = require('../services/database');
    await saveStoryImage(id, coverKey, null, coverResult.imageData, {
      qualityScore: coverResult.score,
      generatedAt: new Date().toISOString(),
      versionIndex: newVersionIndex
    });
    // Mark the new version's imageData as already saved so saveStoryData doesn't re-save it
    newVersion._alreadySaved = true;

    if (normalizedCoverType === 'front') {
      storyData.coverImages.frontCover = coverData;
    } else if (normalizedCoverType === 'initialPage') {
      storyData.coverImages.initialPage = coverData;
    } else {
      storyData.coverImages.backCover = coverData;
    }

    // Update active version in image_version_meta (same mechanism as scenes)
    await setActiveVersion(id, coverKey, newVersionIndex);

    // Save updated story metadata (imageData will be stripped by saveStoryData)
    await saveStoryData(id, storyData);

    // Deduct credits and log transaction (skip for infinite credits or impersonating admin)
    let newCredits = hasInfiniteCredits ? -1 : userCredits - requiredCredits;
    if (!hasInfiniteCredits) {
      await getDbPool().query('UPDATE users SET credits = $1 WHERE id = $2', [newCredits, req.user.id]);
      await getDbPool().query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, -requiredCredits, newCredits, 'cover_regeneration', `Regenerated ${normalizedCoverType} cover for story ${id}`]
      );
      log.info(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, credits: ${requiredCredits} used, ${newCredits} remaining)`);
    } else if (isImpersonating) {
      log.info(`✅ [IMPERSONATE] ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, FREE - admin impersonating)`);
    } else {
      log.info(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, unlimited credits)`);
    }

    res.json({
      success: true,
      coverType: normalizedCoverType,
      imageData: coverResult.imageData,
      description: sceneDescription,
      prompt: coverPrompt,
      qualityScore: coverResult.score,
      qualityReasoning: coverResult.reasoning,
      fixTargets: coverResult.fixTargets || [],  // Bounding boxes for auto-repair
      modelId: coverResult.modelId || coverImageModelId,
      totalAttempts: coverResult.totalAttempts || 1,
      retryHistory: coverResult.retryHistory || [],
      wasRegenerated: true,
      regenerationCount: coverData.regenerationCount,
      // Previous version (immediate predecessor)
      previousImage: previousImageData,
      previousScore: previousScore,
      previousReasoning: previousReasoning,
      // True original (from initial generation)
      originalImage: trueOriginalImage,
      originalScore: trueOriginalScore,
      originalReasoning: trueOriginalReasoning,
      // Credit info
      creditsUsed: requiredCredits,
      creditsRemaining: newCredits,
      // Reference photos used
      referencePhotos: coverCharacterPhotos,
      // API cost tracking
      apiCost: coverImageCost,
      apiCostModel: coverImageModelId,
      // Version info (for version history UI)
      versionIndex: newVersionIndex,
      imageVersions: updatedVersions.map(v => ({
        imageData: v.imageData,
        qualityScore: v.qualityScore,
        description: v.description,
        createdAt: v.createdAt,
        type: v.type,
        isActive: v.isActive
      }))
    });

    // Persist repair cost in background
    addRepairCost(id, coverImageCost, `Regenerate ${normalizedCoverType} cover`).catch(err => log.error('Failed to save cover regen cost:', err.message));

  } catch (err) {
    log.error('Error regenerating cover:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to regenerate cover: ' + err.message : 'Failed to regenerate cover' });
  }
});

// Edit scene image with a user prompt
router.post('/:id/edit/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { editPrompt } = req.body;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }

    if (!editPrompt || editPrompt.trim().length === 0) {
      return res.status(400).json({ error: 'editPrompt is required' });
    }

    log.debug(`✏️ Editing image for story ${id}, page ${pageNumber}`);
    log.debug(`✏️ Edit instruction: "${editPrompt}"`);

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from story_images table (images may be stripped from data blob)
    storyData = await rehydrateStoryImages(id, storyData);

    // Get the current image
    const sceneImages = storyData.sceneImages || [];
    const currentImage = sceneImages.find(img => img.pageNumber === pageNumber);

    if (!currentImage || !currentImage.imageData) {
      return res.status(404).json({ error: 'No image found for this page' });
    }

    // Capture previous image info before editing
    const previousImageData = currentImage.imageData;
    const previousScore = currentImage.qualityScore || null;
    const previousReasoning = currentImage.qualityReasoning || null;
    log.debug(`📸 [EDIT] Capturing previous image (score: ${previousScore})`);

    // Edit the image (pure text/instruction based - no character photos to avoid regeneration artifacts)
    const editResult = await editImageWithPrompt(currentImage.imageData, editPrompt);

    // Log token usage for image editing
    if (editResult?.usage) {
      log.debug(`📊 [PAGE EDIT] Token usage - input: ${editResult.usage.inputTokens}, output: ${editResult.usage.outputTokens}, model: ${editResult.usage.model}`);
    }

    if (!editResult || !editResult.imageData) {
      return res.status(500).json({ error: 'Failed to edit image - no result returned' });
    }

    // Evaluate the edited image quality
    log.debug(`⭐ [EDIT] Evaluating edited image quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'scene');
      if (evaluation) {
        qualityScore = evaluation.score;
        qualityReasoning = evaluation.reasoning;
        log.debug(`⭐ [EDIT] Edited image score: ${qualityScore}%`);
      } else {
        log.warn(`⚠️ [EDIT] Quality evaluation returned null`);
      }
    } catch (evalErr) {
      log.error(`⚠️ [EDIT] Quality evaluation failed:`, evalErr.message);
    }

    // Update the scene metadata (but NOT imageData — that goes into imageVersions)
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);
    if (existingIndex >= 0) {
      const scene = sceneImages[existingIndex];

      // Update scene-level metadata
      scene.qualityScore = qualityScore;
      scene.qualityReasoning = qualityReasoning;
      scene.wasEdited = true;
      scene.lastEditPrompt = editPrompt;
      scene.originalImage = scene.originalImage || previousImageData;
      scene.originalScore = scene.originalScore || previousScore;
      scene.originalReasoning = scene.originalReasoning || previousReasoning;
      scene.editedAt = new Date().toISOString();

      // --- Version management (same pattern as iterate endpoint) ---
      // Lazy-migrate imageVersions if missing
      if (!scene.imageVersions) {
        scene.imageVersions = [{
          // Don't copy imageData — the original is already stored at DB version_index 0.
          description: scene.description,
          prompt: scene.prompt,
          modelId: scene.modelId,
          createdAt: storyData.createdAt || new Date().toISOString(),
          isActive: false,
          type: 'original',
          qualityScore: previousScore ?? null,
          qualityReasoning: previousReasoning || null,
          fixTargets: scene.fixTargets || [],
          fixableIssues: scene.fixableIssues || [],
          totalAttempts: scene.totalAttempts || null,
          referencePhotoNames: (scene.referencePhotos || []).map(p => ({
            name: p.name, photoType: p.photoType,
            clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
          })),
        }];
        log.debug(`✏️ [EDIT] Migrated legacy scene format to imageVersions[] (1 version)`);
      }

      // Mark all existing versions as inactive
      scene.imageVersions.forEach(v => v.isActive = false);

      // Create new version entry
      const timestamp = new Date().toISOString();
      scene.imageVersions.push({
        imageData: editResult.imageData,
        description: scene.description,
        prompt: scene.prompt,
        modelId: editResult.modelId || scene.modelId,
        createdAt: timestamp,
        generatedAt: timestamp,
        isActive: true,
        type: 'edit',
        qualityScore: qualityScore ?? null,
        qualityReasoning: qualityReasoning || null,
        lastEditPrompt: editPrompt,
      });

      // Delete rehydrated imageData to prevent saveStoryData from re-saving it at version_index 0
      delete scene.imageData;

      // Save updated scene atomically
      storyData.sceneImages = sceneImages;
      const savedAtomically = await saveScenePageData(id, pageNumber, scene);
      if (!savedAtomically) {
        await saveStoryData(id, storyData);
      }

      // Update active version in metadata
      const newActiveIndex = getActiveIndexAfterPush(scene.imageVersions, 'scene');
      await setActiveVersion(id, pageNumber, newActiveIndex);
    }

    log.info(`✅ Image edited for story ${id}, page ${pageNumber} (new score: ${qualityScore})`);

    res.json({
      success: true,
      pageNumber,
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning
    });

  } catch (err) {
    log.error('Error editing image:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to edit image: ' + err.message : 'Failed to edit image' });
  }
});

// Auto-repair image (detect and fix physics errors) - DEV ONLY
// Enhanced: supports multi-pass repair, stores evaluation data like automatic auto-repair
router.post('/:id/repair/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }
    const maxPasses = Math.min(Math.max(parseInt(req.body.maxPasses) || 1, 1), 3);  // 1-3 passes
    const providedFixTargets = req.body.fixTargets || null;  // Optional: use existing fix targets instead of re-evaluating

    // Admin-only endpoint (dev mode feature)
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    log.info(`🔧 [REPAIR] Starting manual auto-repair for story ${id}, page ${pageNumber} (max ${maxPasses} passes)`);

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from story_images table (images may be stripped from data blob)
    storyData = await rehydrateStoryImages(id, storyData);

    // Get the current image
    const sceneImages = storyData.sceneImages || [];
    const sceneIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);
    const currentScene = sceneIndex >= 0 ? sceneImages[sceneIndex] : null;

    if (!currentScene || !currentScene.imageData) {
      return res.status(404).json({ error: 'No image found for this page' });
    }

    // Get character photos for reference-based color matching
    const characterPhotos = (storyData.characters || [])
      .filter(c => c.photoData)
      .map(c => c.photoData);

    // Initialize retryHistory if not present
    if (!currentScene.retryHistory) {
      currentScene.retryHistory = [];
    }

    let currentImageData = currentScene.imageData;
    let anyRepaired = false;
    const newRetryEntries = [];
    let allRepairHistory = currentScene.repairHistory || [];

    // Multi-pass repair loop
    for (let pass = 1; pass <= maxPasses; pass++) {
      log.info(`🔧 [REPAIR] Pass ${pass}/${maxPasses} for story ${id}, page ${pageNumber}`);

      // Step 1: Get fix targets - use provided ones on first pass, or evaluate
      let preEvalResult;
      let fixTargets;
      let preRepairScore;

      if (pass === 1 && providedFixTargets && providedFixTargets.length > 0) {
        // Use provided fix targets from existing evaluation (skip re-evaluation)
        log.info(`🔧 [REPAIR] Using ${providedFixTargets.length} provided fix targets (skipping evaluation)`);
        fixTargets = providedFixTargets;
        preRepairScore = currentScene.qualityScore || 0;
        preEvalResult = {
          score: preRepairScore,
          reasoning: currentScene.qualityReasoning || 'Using existing evaluation',
          fixTargets: fixTargets
        };
      } else {
        // Evaluate current image to get score and fix targets
        preEvalResult = await evaluateImageQuality(
          currentImageData,
          currentScene.prompt || '',
          characterPhotos,
          'scene'
        );

        if (!preEvalResult || preEvalResult.score === null) {
          log.warn(`⚠️ [REPAIR] Pre-repair evaluation failed on pass ${pass}`);
          break;
        }

        preRepairScore = preEvalResult.score;
        fixTargets = preEvalResult.fixTargets || [];
      }

      log.info(`🔧 [REPAIR] Pass ${pass}: Pre-repair score ${preRepairScore}%, ${fixTargets.length} fix targets`);

      // If score is already good and no fix targets, skip repair
      if (preRepairScore >= IMAGE_QUALITY_THRESHOLD && fixTargets.length === 0) {
        log.info(`✅ [REPAIR] Pass ${pass}: Score ${preRepairScore}% already good, no repair needed`);
        break;
      }

      // Step 2: Run auto-repair with targets
      let repairResult;
      if (fixTargets.length > 0) {
        repairResult = await autoRepairWithTargets(
          currentImageData,
          fixTargets,
          0,  // No additional inspection-based attempts
          { includeDebugImages: true }  // Include mask/before/after for dev mode
        );
      } else {
        // No fix targets from eval - use inspection-based repair
        repairResult = await autoRepairImage(currentImageData, 1, { includeDebugImages: true });
      }

      if (!repairResult || !repairResult.repaired) {
        log.info(`ℹ️ [REPAIR] Pass ${pass}: No repairs applied`);
        // Still record the attempt
        newRetryEntries.push({
          attempt: currentScene.retryHistory.length + newRetryEntries.length + 1,
          type: 'auto_repair',
          preRepairScore: preRepairScore,
          postRepairScore: preRepairScore,  // Same score since no repair
          fixTargetsCount: fixTargets.length,
          preRepairEval: {
            score: preEvalResult.score,
            reasoning: preEvalResult.reasoning,
            fixTargets: fixTargets
          },
          postRepairEval: null,
          repairDetails: repairResult?.repairHistory || [],
          noRepairNeeded: repairResult?.noErrorsFound || false,
          timestamp: new Date().toISOString()
        });
        break;
      }

      // Step 3: Re-evaluate after repair
      const postEvalResult = await evaluateImageQuality(
        repairResult.imageData,
        currentScene.prompt || '',
        characterPhotos,
        'scene'
      );

      const postRepairScore = postEvalResult?.score ?? preRepairScore;

      log.info(`🔧 [REPAIR] Pass ${pass}: Post-repair score ${postRepairScore}% (was ${preRepairScore}%)`);

      // Step 4: Record retry entry (like automatic auto-repair does)
      newRetryEntries.push({
        attempt: currentScene.retryHistory.length + newRetryEntries.length + 1,
        type: 'auto_repair',
        preRepairScore: preRepairScore,
        postRepairScore: postRepairScore,
        fixTargetsCount: fixTargets.length,
        imageData: repairResult.imageData,  // Include repaired image
        preRepairEval: {
          score: preEvalResult.score,
          reasoning: preEvalResult.reasoning,
          fixTargets: fixTargets
        },
        postRepairEval: postEvalResult ? {
          score: postEvalResult.score,
          reasoning: postEvalResult.reasoning,
          fixTargets: postEvalResult.fixTargets || []
        } : null,
        repairDetails: repairResult.repairHistory || [],
        timestamp: new Date().toISOString()
      });

      // Update state for next pass
      if (postRepairScore > preRepairScore) {
        currentImageData = repairResult.imageData;
        anyRepaired = true;
        allRepairHistory = [...allRepairHistory, ...(repairResult.repairHistory || [])];
        log.info(`✅ [REPAIR] Pass ${pass}: Score improved ${preRepairScore}% → ${postRepairScore}%`);
      } else {
        log.info(`ℹ️ [REPAIR] Pass ${pass}: Score did not improve (${preRepairScore}% → ${postRepairScore}%)`);
        // Still use the repaired image if it was different
        if (repairResult.imageData !== currentImageData) {
          currentImageData = repairResult.imageData;
          anyRepaired = true;
          allRepairHistory = [...allRepairHistory, ...(repairResult.repairHistory || [])];
        }
      }

      // Check if we've reached good quality
      if (postRepairScore >= IMAGE_QUALITY_THRESHOLD) {
        log.info(`✅ [REPAIR] Pass ${pass}: Quality threshold reached (${postRepairScore}% >= ${IMAGE_QUALITY_THRESHOLD}%)`);
        break;
      }
    }

    // Update scene data
    if (anyRepaired || newRetryEntries.length > 0) {
      // Update scene-level metadata
      currentScene.wasAutoRepaired = anyRepaired || currentScene.wasAutoRepaired;
      currentScene.retryHistory = [...currentScene.retryHistory, ...newRetryEntries];
      currentScene.repairHistory = allRepairHistory;
      currentScene.repairedAt = anyRepaired ? new Date().toISOString() : currentScene.repairedAt;

      if (anyRepaired) {
        const lastEntry = newRetryEntries[newRetryEntries.length - 1];
        const repairScore = lastEntry?.postRepairScore || null;

        // Update scene-level quality data
        currentScene.qualityScore = repairScore;

        // --- Version management (same pattern as iterate endpoint) ---
        // Lazy-migrate imageVersions if missing
        if (!currentScene.imageVersions) {
          currentScene.imageVersions = [{
            // Don't copy imageData — the original is already stored at DB version_index 0.
            description: currentScene.description,
            prompt: currentScene.prompt,
            modelId: currentScene.modelId,
            createdAt: storyData.createdAt || new Date().toISOString(),
            isActive: false,
            type: 'original',
            qualityScore: currentScene.qualityScore ?? null,
            qualityReasoning: currentScene.qualityReasoning || null,
            fixTargets: currentScene.fixTargets || [],
            fixableIssues: currentScene.fixableIssues || [],
            totalAttempts: currentScene.totalAttempts || null,
            referencePhotoNames: (currentScene.referencePhotos || []).map(p => ({
              name: p.name, photoType: p.photoType,
              clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
            })),
          }];
          log.debug(`🔧 [REPAIR] Migrated legacy scene format to imageVersions[] (1 version)`);
        }

        // Mark all existing versions as inactive
        currentScene.imageVersions.forEach(v => v.isActive = false);

        // Create new version entry
        const timestamp = new Date().toISOString();
        currentScene.imageVersions.push({
          imageData: currentImageData,
          description: currentScene.description,
          prompt: currentScene.prompt,
          modelId: currentScene.modelId,
          createdAt: timestamp,
          generatedAt: timestamp,
          isActive: true,
          type: 'inpaint-repair',
          qualityScore: repairScore,
          repairHistory: allRepairHistory,
        });

        // Delete rehydrated imageData to prevent saveStoryData from re-saving it at version_index 0
        delete currentScene.imageData;
      }

      sceneImages[sceneIndex] = currentScene;

      // Save updated scene atomically
      storyData.sceneImages = sceneImages;
      const savedAtomically = await saveScenePageData(id, pageNumber, currentScene);
      if (!savedAtomically) {
        await saveStoryData(id, storyData);
      }

      // Update active version in metadata if we created a new version
      if (anyRepaired) {
        const newActiveIndex = getActiveIndexAfterPush(currentScene.imageVersions, 'scene');
        await setActiveVersion(id, pageNumber, newActiveIndex);
      }

      log.info(`✅ [REPAIR] Saved ${newRetryEntries.length} repair entries for story ${id}, page ${pageNumber}`);
    }

    res.json({
      success: true,
      pageNumber,
      repaired: anyRepaired,
      passesRun: newRetryEntries.length,
      imageData: currentImageData,
      retryEntries: newRetryEntries,
      repairHistory: allRepairHistory
    });

  } catch (err) {
    log.error('Error in auto-repair:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to auto-repair image: ' + err.message : 'Failed to auto-repair image' });
  }
});

// Repair entity consistency (regenerate character appearances to match reference) - DEV ONLY
router.post('/:id/repair-entity-consistency', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { entityName, entityType = 'character', pageNumber } = req.body;

    // Admin-only endpoint (dev mode feature)
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!entityName) {
      return res.status(400).json({ error: 'entityName is required' });
    }

    const isSinglePageMode = typeof pageNumber === 'number';
    log.info(`🔧 [ENTITY-REPAIR] Starting ${isSinglePageMode ? 'single-page' : 'full'} entity consistency repair for ${entityName}${isSinglePageMode ? ` page ${pageNumber}` : ''} in story ${id}`);

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from separate table (required for entity appearance collection)
    storyData = await rehydrateStoryImages(id, storyData);

    // Find the character
    let character = storyData.characters?.find(c => c.name === entityName);
    if (!character) {
      return res.status(404).json({ error: `Character "${entityName}" not found in story` });
    }

    // Always try to enrich character with full data from characters table
    // Story data often has stripped/minimal character info
    const artStyle = storyData.artStyle || 'pixar';
    const characterSetId = storyData.characterSetId;
    if (characterSetId) {
      try {
        const charSetResult = await getDbPool().query(
          'SELECT data FROM characters WHERE id = $1',
          [characterSetId]
        );
        if (charSetResult.rows.length > 0) {
          const charSetData = typeof charSetResult.rows[0].data === 'string'
            ? JSON.parse(charSetResult.rows[0].data)
            : charSetResult.rows[0].data;
          const fullChar = charSetData.characters?.find(c => c.name === entityName);
          if (fullChar) {
            // Merge: prefer fullChar data but keep story-specific overrides
            character = { ...fullChar, ...character, avatars: fullChar.avatars || character.avatars };
            log.info(`🔧 [ENTITY-REPAIR] Enriched ${entityName} with avatar data from character set`);

            // Log what avatars we have
            const styledKeys = Object.keys(fullChar.avatars?.styledAvatars?.[artStyle] || {});
            log.info(`🔧 [ENTITY-REPAIR] ${entityName} styledAvatars[${artStyle}] keys: [${styledKeys.join(', ')}]`);
          } else {
            log.warn(`🔧 [ENTITY-REPAIR] Character ${entityName} not found in character set ${characterSetId}`);
          }
        } else {
          log.warn(`🔧 [ENTITY-REPAIR] Character set ${characterSetId} not found in database`);
        }
      } catch (enrichErr) {
        log.warn(`[ENTITY-REPAIR] Failed to enrich character data: ${enrichErr.message}`);
      }
    } else {
      // Fallback: search all user's character sets for matching character by name
      log.info(`🔧 [ENTITY-REPAIR] No characterSetId, searching user's character sets for ${entityName}...`);
      try {
        const userCharSetsResult = await getDbPool().query(
          'SELECT id, data FROM characters WHERE user_id = $1',
          [req.user.id]
        );
        for (const row of userCharSetsResult.rows) {
          const charSetData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          const fullChar = charSetData.characters?.find(c => c.name === entityName);
          const hasPhoto = hasCharacterPhotos(fullChar);
          const hasAvatars = fullChar?.avatars?.styledAvatars;
          if (fullChar && (hasPhoto || hasAvatars)) {
            character = { ...fullChar, ...character, avatars: fullChar.avatars || character.avatars };
            log.info(`🔧 [ENTITY-REPAIR] Found ${entityName} in character set ${row.id} (fallback lookup)`);
            const styledKeys = Object.keys(fullChar.avatars?.styledAvatars?.[artStyle] || {});
            const allArtStyles = Object.keys(fullChar.avatars?.styledAvatars || {});
            log.info(`🔧 [ENTITY-REPAIR] ${entityName} styledAvatars[${artStyle}] keys: [${styledKeys.join(', ')}], all art styles: [${allArtStyles.join(', ')}]`);
            break;
          }
        }
      } catch (fallbackErr) {
        log.warn(`[ENTITY-REPAIR] Fallback character lookup failed: ${fallbackErr.message}`);
      }
    }

    // Log current character avatar state for debugging
    const hasPhoto = hasCharacterPhotos(character);
    const hasStyledAvatar = !!character.avatars?.styledAvatars?.[artStyle]?.standard;
    const allArtStyles = Object.keys(character.avatars?.styledAvatars || {});
    log.info(`🔧 [ENTITY-REPAIR] ${entityName} avatar state: hasPhoto=${hasPhoto}, hasStyledAvatar[${artStyle}].standard=${hasStyledAvatar}, availableArtStyles=[${allArtStyles.join(', ')}]`);

    // Single-page mode: repair just one page
    if (isSinglePageMode) {

      // Get issues for this character from the consistency report
      const entityReport = storyData.finalChecksReport?.entity;
      const charIssues = entityReport?.characters?.[entityName]?.issues || [];
      if (charIssues.length > 0) {
        log.info(`🔧 [ENTITY-REPAIR] Found ${charIssues.length} consistency issues for ${entityName}`);
      }

      const repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });

      // Handle rejected repairs - still return the data so frontend can show it
      if (!repairResult.success) {
        if (repairResult.rejected) {
          // Repair was generated but rejected during verification
          // Return the comparison data so user can see what was rejected
          return res.status(200).json({
            success: false,
            rejected: true,
            reason: repairResult.reason,
            entityName: repairResult.entityName,
            pageNumber: repairResult.pageNumber,
            comparison: repairResult.comparison,
            verification: repairResult.verification,
            promptUsed: repairResult.promptUsed
          });
        }
        return res.status(400).json({ error: repairResult.error || 'Single-page repair failed' });
      }

      // Apply updated image to story
      const sceneImages = storyData.sceneImages || [];
      const sceneIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

      if (sceneIndex < 0) {
        log.error(`❌ [ENTITY-REPAIR] Scene not found for page ${pageNumber}`);
        return res.status(404).json({ error: `Scene not found for page ${pageNumber}` });
      }

      const existingImage = sceneImages[sceneIndex];

      for (const update of repairResult.updatedImages) {
        if (update.pageNumber !== pageNumber) continue;

        // Initialize imageVersions if not present (migrate existing as original)
        if (!existingImage.imageVersions) {
          existingImage.imageVersions = [{
            // Don't copy imageData — the original is already stored at DB version_index 0.
            description: existingImage.description,
            prompt: existingImage.prompt,
            modelId: existingImage.modelId,
            createdAt: existingImage.generatedAt || storyData.createdAt || new Date().toISOString(),
            isActive: false,
            type: 'original',
            qualityScore: existingImage.qualityScore ?? null,
            qualityReasoning: existingImage.qualityReasoning || null,
            fixTargets: existingImage.fixTargets || [],
            totalAttempts: existingImage.totalAttempts || null,
            referencePhotoNames: (existingImage.referencePhotos || []).map(p => ({
              name: p.name, photoType: p.photoType,
              clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
            })),
          }];
        } else {
          // Mark all previous versions as inactive
          existingImage.imageVersions.forEach(v => v.isActive = false);
        }

        // Add new version for entity repair
        const entityRepairTimestamp = new Date().toISOString();
        existingImage.imageVersions.push({
          imageData: update.imageData,
          description: existingImage.description,
          prompt: existingImage.prompt,
          modelId: 'gemini-2.0-flash-preview-image-generation',
          createdAt: entityRepairTimestamp,
          generatedAt: entityRepairTimestamp,
          isActive: true,
          type: 'entity-repair',
          entityRepairedFor: entityName,
          clothingCategory: repairResult.clothingCategory,
          qualityScore: null,
          qualityReasoning: null,
          fixTargets: [],
          totalAttempts: null,
        });

        // Delete rehydrated imageData to prevent saveStoryData from re-saving at version_index 0
        delete existingImage.imageData;
        existingImage.entityRepaired = true;
        existingImage.entityRepairedAt = entityRepairTimestamp;
        existingImage.entityRepairedFor = entityName;
      }

      storyData.sceneImages = sceneImages;

      // Store repair result for dev panel
      if (!storyData.finalChecksReport) storyData.finalChecksReport = {};
      if (!storyData.finalChecksReport.entityRepairs) storyData.finalChecksReport.entityRepairs = {};
      if (!storyData.finalChecksReport.entityRepairs[entityName]) {
        storyData.finalChecksReport.entityRepairs[entityName] = { pages: {} };
      }
      storyData.finalChecksReport.entityRepairs[entityName].pages[pageNumber] = {
        timestamp: new Date().toISOString(),
        clothingCategory: repairResult.clothingCategory,
        comparison: repairResult.comparison,
        referenceGridUsed: repairResult.referenceGridUsed,
        usage: repairResult.usage,
        promptUsed: repairResult.promptUsed
      };

      const newVersionIndex = getActiveIndexAfterPush(existingImage.imageVersions, 'scene');

      await saveStoryData(id, storyData);

      // Note: saveStoryData already saves images from imageVersions to story_images table
      // No need for separate saveStoryImage call

      // Set the new version as active
      await setActiveVersion(id, pageNumber, newVersionIndex);

      log.info(`✅ [ENTITY-REPAIR] Single-page repair complete for ${entityName} page ${pageNumber}`);

      return res.json({
        success: true,
        mode: 'single-page',
        entityName,
        pageNumber,
        clothingCategory: repairResult.clothingCategory,
        comparison: repairResult.comparison,
        referenceGridUsed: repairResult.referenceGridUsed,
        promptUsed: repairResult.promptUsed
      });
    }

    // Full repair mode: repair all pages
    // Get or run entity consistency check
    // Note: stored as 'entity' in finalChecksReport, not 'entityConsistency'
    let entityReport = storyData.finalChecksReport?.entity;

    if (!entityReport || !entityReport.characters?.[entityName]) {
      // Run entity consistency check first
      log.info(`🔧 [ENTITY-REPAIR] Running entity consistency check for ${entityName}`);
      entityReport = await runEntityConsistencyChecks(storyData, storyData.characters || [], {
        checkCharacters: true,
        checkObjects: false
      });
    }

    // Run the repair
    const repairResult = await repairEntityConsistency(storyData, character, entityReport);

    if (!repairResult.success) {
      return res.status(400).json({ error: repairResult.error || 'Repair failed' });
    }

    if (repairResult.noChanges) {
      return res.json({
        success: true,
        message: repairResult.message,
        noChanges: true
      });
    }

    // Apply updated images to story
    const sceneImages = storyData.sceneImages || [];
    for (const update of repairResult.updatedImages) {
      const sceneIndex = sceneImages.findIndex(img => img.pageNumber === update.pageNumber);
      if (sceneIndex >= 0) {
        const existingImage = sceneImages[sceneIndex];

        // Initialize imageVersions if not present (migrate existing as original)
        if (!existingImage.imageVersions) {
          existingImage.imageVersions = [{
            // Don't copy imageData — the original is already stored at DB version_index 0.
            description: existingImage.description,
            prompt: existingImage.prompt,
            modelId: existingImage.modelId,
            createdAt: existingImage.generatedAt || storyData.createdAt || new Date().toISOString(),
            isActive: false,
            type: 'original'
          }];
        } else {
          // Mark all previous versions as inactive
          existingImage.imageVersions.forEach(v => v.isActive = false);
        }

        // Add new version for entity repair
        const entityRepairTs = new Date().toISOString();
        existingImage.imageVersions.push({
          imageData: update.imageData,
          description: existingImage.description,
          prompt: existingImage.prompt,
          modelId: 'gemini-2.0-flash-preview-image-generation',
          createdAt: entityRepairTs,
          generatedAt: entityRepairTs,
          isActive: true,
          type: 'entity-repair',
          entityRepairedFor: entityName,
          clothingCategory: update.clothingCategory
        });

        // Delete rehydrated imageData to prevent saveStoryData from re-saving at version_index 0
        delete existingImage.imageData;
        existingImage.entityRepaired = true;
        existingImage.entityRepairedAt = entityRepairTs;
        existingImage.entityRepairedFor = entityName;
      }
    }

    storyData.sceneImages = sceneImages;

    // Store repair grids in finalChecksReport for dev panel
    if (!storyData.finalChecksReport) {
      storyData.finalChecksReport = {};
    }
    if (!storyData.finalChecksReport.entityRepairs) {
      storyData.finalChecksReport.entityRepairs = {};
    }
    storyData.finalChecksReport.entityRepairs[entityName] = {
      timestamp: new Date().toISOString(),
      originalScore: repairResult.originalScore,
      cellsRepaired: repairResult.cellsRepaired,
      gridBeforeRepair: repairResult.gridBeforeRepair,
      gridAfterRepair: repairResult.gridAfterRepair,
      gridDiff: repairResult.gridDiff,
      cellComparisons: repairResult.cellComparisons,
      usage: repairResult.usage,
      gridsByClothing: repairResult.gridsByClothing,
      clothingGroupCount: repairResult.clothingGroupCount
    };

    // Save updated story (this saves all images from imageVersions to story_images)
    await saveStoryData(id, storyData);

    // Set correct active version for each updated page
    // Note: saveStoryData already saved images, so no need for separate saveStoryImage
    for (const update of repairResult.updatedImages) {
      const existingImage = sceneImages.find(s => s.pageNumber === update.pageNumber);
      if (existingImage && existingImage.imageVersions) {
        const newVersionIndex = getActiveIndexAfterPush(existingImage.imageVersions, 'scene');
        await setActiveVersion(id, update.pageNumber, newVersionIndex);
      }
    }

    log.info(`✅ [ENTITY-REPAIR] Entity consistency repair complete for ${entityName}: ${repairResult.cellsRepaired} pages updated`);

    res.json({
      success: true,
      entityName,
      originalScore: repairResult.originalScore,
      cellsRepaired: repairResult.cellsRepaired,
      updatedPages: repairResult.updatedImages.map(u => u.pageNumber),
      gridBeforeRepair: repairResult.gridBeforeRepair,
      gridAfterRepair: repairResult.gridAfterRepair
    });

  } catch (err) {
    log.error('Error in entity consistency repair:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to repair entity consistency: ' + err.message : 'Failed to repair entity consistency' });
  }
});

// =============================================================================
// Repair Workflow Endpoints
// =============================================================================

// Step 4: Re-evaluate pages
router.post('/:id/repair-workflow/re-evaluate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { pageNumbers, qualityModelOverride, scoreThreshold } = req.body;

    if (!pageNumbers || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
      return res.status(400).json({ error: 'pageNumbers array is required' });
    }
    if (!pageNumbers.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'All pageNumbers must be integers' });
    }

    log.info(`📊 [REPAIR-WORKFLOW] Re-evaluating pages ${pageNumbers.join(', ')} in story ${id}`);

    // Get story data
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    // Rehydrate images from story_images table (they're stripped from JSON on save)
    storyData = await rehydrateStoryImages(id, storyData);

    const pages = {};

    // Get character photos for reference images
    const characters = storyData.characters || [];
    const characterPhotos = characters
      .filter(c => c.photoUrl || c.avatars?.styled)
      .map(c => ({
        name: c.name,
        photoUrl: c.avatars?.styled || c.photoUrl
      }));

    // Run evaluations in parallel with concurrency limit
    const evalLimit = pLimit(100);
    const fullStoryText = storyData.storyText || storyData.generatedStory || storyData.story || '';

    await Promise.all(pageNumbers.map(pageNumber => evalLimit(async () => {
      let scene;
      let evaluationType = 'scene';
      let pageLabel = `PAGE ${pageNumber}`;
      if (isCoverPage(pageNumber)) {
        const coverType = getCoverType(pageNumber);
        scene = getCoverData(storyData, coverType);
        evaluationType = 'cover';
        pageLabel = coverType.toUpperCase();
      } else {
        scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      }
      if (!scene) return;

      try {
        // Get image data - look up active version from DB, then fallback to scene.imageData
        let imageData = scene.imageData;
        if (scene.imageVersions?.length > 0) {
          const activeDbIndex = await getActiveVersion(id, pageNumber);
          const activeVersion = scene.imageVersions?.[activeDbIndex];
          if (activeVersion?.imageData) {
            imageData = activeVersion.imageData;
          }
        }

        if (!imageData || !imageData.startsWith('data:image/')) {
          log.warn(`[REPAIR-WORKFLOW] ${pageLabel} has no valid image data, skipping`);
          pages[pageNumber] = {
            qualityScore: null,
            fixableIssues: [],
            error: 'No valid image data'
          };
          return;
        }

        // Get page text for semantic fidelity check
        const pageText = isCoverPage(pageNumber) ? null : (getPageText(fullStoryText, pageNumber) || scene.text || null);

        // Get scene hint (most direct statement of what image should show)
        const sceneHint = scene.outlineExtract || scene.sceneHint || null;

        // Run evaluation with full parameters including storyText for semantic check
        const evaluation = await evaluateImageQuality(
          imageData,
          scene.description,       // originalPrompt
          characterPhotos,         // referenceImages
          evaluationType,          // evaluationType
          qualityModelOverride || null,
          pageLabel,               // pageContext
          pageText,                // storyText for semantic fidelity
          sceneHint                // sceneHint for semantic evaluation
        );

        if (!evaluation) {
          log.warn(`[REPAIR-WORKFLOW] ${pageLabel} evaluation returned null`);
          pages[pageNumber] = {
            qualityScore: null,
            fixableIssues: [],
            error: 'Evaluation returned null'
          };
          return;
        }

        // Validate semantic evaluation ran when expected
        if (evaluation.semanticScore === null && sceneHint) {
          log.warn(`⚠️ [RE-EVALUATE] ${pageLabel}: Semantic evaluation failed despite sceneHint being available`);
        }

        // Log both scores for debugging
        const qualityPct = evaluation.qualityScore ?? evaluation.score;
        const semanticPct = evaluation.semanticScore ?? 100;
        log.info(`📊 [REPAIR-WORKFLOW] ${pageLabel} - Quality: ${qualityPct}, Semantic: ${semanticPct}, Final: ${evaluation.score}`);
        if (evaluation.issuesSummary) {
          log.info(`📊 [REPAIR-WORKFLOW] ${pageLabel} - issues: ${evaluation.issuesSummary}`);
        }

        // Update scene with new evaluation
        scene.qualityScore = evaluation.qualityScore ?? evaluation.score;
        scene.qualityReasoning = evaluation.reasoning;
        scene.semanticScore = evaluation.semanticScore ?? null;
        scene.semanticResult = evaluation.semanticResult ?? null;
        scene.fixTargets = evaluation.fixTargets || evaluation.enrichedFixTargets || [];
        scene.fixableIssues = evaluation.fixableIssues || [];

        // Collect ALL issues for this page (quality eval + entity + imageChecks + retries)
        const allIssues = collectAllIssuesForPage(scene, storyData, pageNumber);

        // Compute entity/image-check penalties (quality eval issues already reflected in score)
        let entityPenalty = 0;
        for (const issue of allIssues) {
          if (issue.source === 'entity check' || issue.source === 'image checks') {
            if (issue.severity === 'critical') entityPenalty += 30;
            else if (issue.severity === 'major') entityPenalty += 20;
            else entityPenalty += 10;
          }
        }
        const adjustedScore = Math.max(0, evaluation.score - entityPenalty);
        if (entityPenalty > 0) {
          log.info(`📊 [RE-EVALUATE] ${pageLabel}: entity penalty ${entityPenalty} (${evaluation.score} → ${adjustedScore})`);
        }

        // Run bbox enrichment — always run to keep bboxDetection in sync with active image
        {
          const characterDescriptions = {};
          for (const char of (storyData.characters || [])) {
            characterDescriptions[char.name] = {
              richDescription: buildCharacterPhysicalDescription(char)
            };
          }
          const sceneMetadata = scene.sceneMetadata || extractSceneMetadata(scene.description || '');
          const expectedPositions = sceneMetadata?.characterPositions || {};
          const expectedClothing = sceneMetadata?.characterClothing || {};
          const expectedObjects = sceneMetadata?.objects || [];

          const enrichResult = await enrichWithBoundingBoxes(
            imageData, allIssues, [], [],
            expectedPositions, expectedObjects, characterDescriptions, expectedClothing
          );
          scene.fixTargets = enrichResult.targets || [];
          scene.bboxDetection = enrichResult.detectionHistory || null;
          if (allIssues.length > 0) {
            log.info(`🎯 [RE-EVALUATE] ${pageLabel} - bbox enrichment: ${scene.fixTargets.length} targets from ${allIssues.length} issues`);
          }
        }

        // Store combined issues + bbox results on scene and active version
        scene.fixableIssues = allIssues;
        const activeDbIdx = await getActiveVersion(id, pageNumber);
        const activeVersion = scene.imageVersions?.[activeDbIdx];
        if (activeVersion) {
          activeVersion.fixTargets = scene.fixTargets;
          activeVersion.fixableIssues = allIssues;
          activeVersion.qualityScore = adjustedScore;
          activeVersion.semanticScore = evaluation.semanticScore ?? null;
          activeVersion.entityPenalty = entityPenalty || 0;
          activeVersion.evaluatedAt = new Date().toISOString();
          activeVersion.issuesSummary = evaluation.issuesSummary || '';
          activeVersion.bboxDetection = scene.bboxDetection || null;
        }

        // Update scene with adjusted score
        scene.qualityScore = adjustedScore;

        pages[pageNumber] = {
          score: adjustedScore,                       // Combined final score (quality - semantic - entity penalties)
          qualityScore: evaluation.qualityScore ?? evaluation.score,  // Visual quality only
          semanticScore: evaluation.semanticScore ?? null,            // Semantic fidelity only
          entityPenalty: entityPenalty || 0,           // Penalty from entity/image-check issues
          rawScore: evaluation.rawScore,
          verdict: evaluation.verdict,
          issuesSummary: evaluation.issuesSummary || '',
          reasoning: evaluation.reasoning,
          fixableIssues: allIssues,                   // ALL sources, not just quality eval
          fixTargets: scene.fixTargets,               // bbox-enriched
          semanticResult: evaluation.semanticResult || null,
          usage: evaluation.usage || null
        };
      } catch (evalErr) {
        log.error(`❌ [RE-EVALUATE] ${pageLabel} evaluation failed:`, evalErr);
        pages[pageNumber] = {
          qualityScore: null,
          fixableIssues: [],
          error: evalErr.message
        };
      }
    })));

    // Calculate cost before responding
    let totalInput = 0, totalOutput = 0;
    for (const pageData of Object.values(pages)) {
      if (pageData.usage) {
        totalInput += pageData.usage.input_tokens || 0;
        totalOutput += pageData.usage.output_tokens || 0;
      }
    }
    const evalModel = qualityModelOverride || 'gemini-2.5-flash';
    const apiCost = calculateTokenCost(evalModel, totalInput, totalOutput);

    log.info(`✅ [REPAIR-WORKFLOW] Re-evaluation complete for ${Object.keys(pages).length} pages`);
    const badPages = findBadPages(pages, scoreThreshold ? { scoreThreshold } : {});
    res.json({ pages, badPages, apiCost });

    // Save to DB in background (don't block the response)
    saveStoryData(id, storyData).catch(err => log.error('Failed to save re-evaluation:', err.message));
    addRepairCost(id, apiCost, 'Re-evaluate').catch(err => log.error('Failed to save re-eval cost:', err.message));
  } catch (err) {
    log.error('❌ [RE-EVALUATE] Failed to re-evaluate pages:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to re-evaluate: ' + err.message : 'Failed to re-evaluate' });
  }
});

// Evaluate a single page with full prompt/output visibility (admin-only, no DB writes)
router.post('/:id/evaluate-single/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }

    // Admin/dev-mode only
    if (req.user.role !== 'admin' && !req.user.impersonating) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { evalType, model } = req.body;
    const validTypes = ['quality', 'semantic', 'visual-inventory'];
    if (!evalType || !validTypes.includes(evalType)) {
      return res.status(400).json({ error: `evalType must be one of: ${validTypes.join(', ')}` });
    }

    log.info(`🔬 [EVAL-SINGLE] ${evalType} eval for story ${id}, page ${pageNumber}${model ? ` (model: ${model})` : ''}`);

    // Load story data with rehydrated images
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    let storyData = typeof storyResult.rows[0].data === 'string'
      ? JSON.parse(storyResult.rows[0].data)
      : storyResult.rows[0].data;
    storyData = await rehydrateStoryImages(id, storyData);

    // Find the page or cover
    let scene;
    let evaluationType = 'scene';
    let pageLabel = `PAGE ${pageNumber}`;
    if (isCoverPage(pageNumber)) {
      const coverType = getCoverType(pageNumber);
      if (!coverType) return res.status(400).json({ error: 'Invalid cover page number' });
      scene = getCoverData(storyData, coverType);
      evaluationType = 'cover';
      pageLabel = coverType.toUpperCase();
    } else {
      scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
    }
    if (!scene) {
      return res.status(404).json({ error: `Page ${pageNumber} not found` });
    }

    // Get active version's image data
    let imageData = scene.imageData;
    if (scene.imageVersions?.length > 0) {
      const activeDbIndex = await getActiveVersion(id, pageNumber);
      const activeVersion = scene.imageVersions?.[activeDbIndex];
      if (activeVersion?.imageData) {
        imageData = activeVersion.imageData;
      }
    }
    if (!imageData || !imageData.startsWith('data:image/')) {
      return res.status(400).json({ error: 'No valid image data for this page' });
    }

    // Build character reference images (same pattern as re-evaluate)
    const characters = storyData.characters || [];
    const characterPhotos = characters
      .filter(c => c.photoUrl || c.avatars?.styled)
      .map(c => ({
        name: c.name,
        photoUrl: c.avatars?.styled || c.photoUrl
      }));

    // Get page text and scene hint
    const fullStoryText = storyData.storyText || storyData.generatedStory || storyData.story || '';
    const pageText = isCoverPage(pageNumber) ? null : (getPageText(fullStoryText, pageNumber) || scene.text || null);
    const sceneHint = scene.outlineExtract || scene.sceneHint || null;

    // ─── QUALITY EVALUATION ────────────────────────────────────────────
    if (evalType === 'quality') {
      const qualityModelOverride = model || null;

      // Build the filled prompt text for visibility
      let evaluationTemplate;
      if (evaluationType === 'cover' && PROMPT_TEMPLATES.coverImageEvaluation) {
        evaluationTemplate = PROMPT_TEMPLATES.coverImageEvaluation;
      } else if (PROMPT_TEMPLATES.imageEvaluation) {
        evaluationTemplate = PROMPT_TEMPLATES.imageEvaluation;
      } else {
        evaluationTemplate = null;
      }
      const filledPrompt = evaluationTemplate
        ? fillTemplate(evaluationTemplate, { ORIGINAL_PROMPT: scene.description || '' })
        : '(no evaluation template loaded)';

      // Run the actual evaluation
      const evaluation = await evaluateImageQuality(
        imageData,
        scene.description,       // originalPrompt
        characterPhotos,         // referenceImages
        evaluationType,
        qualityModelOverride,
        pageLabel,
        null,                    // storyText — run quality only, semantic is separate
        null                     // sceneHint — not used for quality-only
      );

      if (!evaluation) {
        return res.status(500).json({ error: 'Quality evaluation returned null (content blocked or API error)' });
      }

      return res.json({
        evalType: 'quality',
        pageNumber,
        prompt: filledPrompt,
        rawResponse: evaluation.reasoning,
        score: evaluation.score,
        qualityScore: evaluation.qualityScore,
        rawScore: evaluation.rawScore,
        verdict: evaluation.verdict,
        issuesSummary: evaluation.issuesSummary,
        fixableIssues: evaluation.fixableIssues,
        figures: evaluation.figures,
        matches: evaluation.matches,
        modelId: evaluation.modelId,
        usage: evaluation.usage
      });
    }

    // ─── SEMANTIC EVALUATION ───────────────────────────────────────────
    if (evalType === 'semantic') {
      if (!pageText && !sceneHint) {
        return res.status(400).json({ error: 'No story text or scene hint available for semantic evaluation' });
      }

      // Build the filled prompt text for visibility
      const semanticTemplate = PROMPT_TEMPLATES.imageSemantic;
      const filledPrompt = semanticTemplate
        ? fillTemplate(semanticTemplate, {
            STORY_TEXT: pageText || 'Not provided',
            SCENE_HINT: sceneHint || 'Not provided',
            IMAGE_PROMPT: scene.description || 'No prompt provided'
          })
        : '(no semantic template loaded)';

      // Run the semantic evaluation
      const { evaluateSemanticFidelity } = require('../lib/sceneValidator');
      const semanticResult = await evaluateSemanticFidelity(
        imageData,
        pageText || sceneHint,   // storyText (falls back to sceneHint)
        scene.description,       // imagePrompt
        sceneHint                // sceneHint
      );

      if (!semanticResult) {
        return res.status(500).json({ error: 'Semantic evaluation returned null' });
      }

      return res.json({
        evalType: 'semantic',
        pageNumber,
        prompt: filledPrompt,
        rawResponse: semanticResult.rawResponse || JSON.stringify({
          score: semanticResult.rawScore,
          verdict: semanticResult.verdict,
          semanticIssues: semanticResult.semanticIssues,
          visible: semanticResult.visible,
          expected: semanticResult.expected
        }, null, 2),
        score: semanticResult.score,
        rawScore: semanticResult.rawScore,
        verdict: semanticResult.verdict,
        semanticIssues: semanticResult.semanticIssues,
        visible: semanticResult.visible,
        expected: semanticResult.expected,
        usage: semanticResult.usage
      });
    }

    // ─── VISUAL INVENTORY ──────────────────────────────────────────────
    if (evalType === 'visual-inventory') {
      const inventoryModel = model || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash';
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'Gemini API key not configured' });
      }

      // Build parts array (image + reference images) — same structure as evaluateImageQuality
      const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
      const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
      const parts = [
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ];

      // Add reference images (compressed)
      for (const ref of characterPhotos) {
        const photoUrl = ref.photoUrl;
        if (photoUrl && typeof photoUrl === 'string' && photoUrl.startsWith('data:image')) {
          const compressed = await compressImageToJPEG(photoUrl, 85, 768);
          const compressedBase64 = compressed.replace(/^data:image\/\w+;base64,/, '');
          parts.push({ text: `Reference: ${ref.name}` });
          parts.push({ inline_data: { mime_type: 'image/jpeg', data: compressedBase64 } });
        }
      }

      // Get the filled prompt for visibility
      const inventoryTemplate = PROMPT_TEMPLATES.imageVisualInventory || '';
      const filledPrompt = inventoryTemplate || '(no visual inventory template loaded)';

      // Run visual inventory
      const inventoryResult = await runVisualInventory(parts, inventoryModel, apiKey, pageLabel);

      if (!inventoryResult) {
        return res.status(500).json({ error: 'Visual inventory returned null (content blocked or parse failed)' });
      }

      return res.json({
        evalType: 'visual-inventory',
        pageNumber,
        prompt: filledPrompt,
        rawResponse: JSON.stringify({
          figures: inventoryResult.figures,
          matches: inventoryResult.matches,
          objectMatches: inventoryResult.objectMatches,
          rendering: inventoryResult.rendering
        }, null, 2),
        figures: inventoryResult.figures,
        matches: inventoryResult.matches,
        objectMatches: inventoryResult.objectMatches,
        rendering: inventoryResult.rendering,
        usage: {
          input_tokens: inventoryResult.inputTokens,
          output_tokens: inventoryResult.outputTokens
        }
      });
    }
  } catch (err) {
    log.error('❌ [EVAL-SINGLE] Failed:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Evaluation failed: ' + err.message : 'Evaluation failed' });
  }
});

// Refresh bbox detection for a single page (runs on active image, saves result)
router.post('/:id/refresh-bbox/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) {
      return res.status(400).json({ error: 'Invalid page number' });
    }

    // Admin/dev-mode only
    if (req.user.role !== 'admin' && !req.user.impersonating) {
      return res.status(403).json({ error: 'Admin only' });
    }

    log.info(`📦 [REFRESH-BBOX] Starting bbox detection for story ${id}, page ${pageNumber}`);

    // Load story data with rehydrated images
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    let storyData = typeof storyResult.rows[0].data === 'string'
      ? JSON.parse(storyResult.rows[0].data)
      : storyResult.rows[0].data;
    storyData = await rehydrateStoryImages(id, storyData);

    // Find scene
    const isCover = pageNumber < 0;
    let scene, imageData;

    if (isCover) {
      const coverMap = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
      const coverKey = coverMap[String(pageNumber)];
      if (!coverKey) return res.status(400).json({ error: 'Invalid cover page number' });
      scene = storyData.coverImages?.[coverKey];
      imageData = scene?.imageData;
    } else {
      scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      imageData = scene?.imageData;
    }

    if (!scene || !imageData?.startsWith('data:image/')) {
      return res.status(400).json({ error: 'No valid image for this page' });
    }

    // Build character descriptions
    const characterDescriptions = {};
    for (const char of (storyData.characters || [])) {
      characterDescriptions[char.name] = {
        richDescription: buildCharacterPhysicalDescription(char)
      };
    }

    // Get scene metadata for expected positions/clothing/objects
    const sceneMetadata = scene.sceneMetadata || extractSceneMetadata(scene.description || '');
    const expectedPositions = sceneMetadata?.characterPositions || {};
    const expectedClothing = sceneMetadata?.characterClothing || {};
    const expectedObjects = sceneMetadata?.objects || [];

    // Run enriched bbox detection (optional model override from request body)
    const bboxModelOverride = req.body.bboxModel || null;
    const enrichResult = await enrichWithBoundingBoxes(
      imageData, [], [], [],
      expectedPositions, expectedObjects, characterDescriptions, expectedClothing,
      null, bboxModelOverride
    );

    const bboxDetection = enrichResult.detectionHistory || null;
    const fixTargets = enrichResult.targets || [];

    // Create overlay image
    let bboxOverlayImage = null;
    if (bboxDetection) {
      bboxOverlayImage = await createBboxOverlayImage(imageData, bboxDetection);
    }

    // Save to scene + active version
    scene.bboxDetection = bboxDetection;
    scene.fixTargets = fixTargets;
    if (scene.imageVersions) {
      const activeVersion = scene.imageVersions.find(v => v.isActive);
      if (activeVersion) {
        activeVersion.bboxDetection = bboxDetection;
        activeVersion.fixTargets = fixTargets;
      }
    }

    const figCount = bboxDetection?.figures?.length || 0;
    const objCount = bboxDetection?.objects?.length || 0;
    const identifiedCount = bboxDetection?.figures?.filter(f => f.name && f.name !== 'UNKNOWN').length || 0;
    log.info(`✅ [REFRESH-BBOX] Page ${pageNumber}: ${figCount} figures (${identifiedCount} identified), ${objCount} objects, ${fixTargets.length} fix targets`);

    res.json({ bboxDetection, bboxOverlayImage, fixTargets });

    // Save to DB in background
    if (isCover) {
      saveStoryData(id, storyData).catch(err => log.error('Failed to save bbox refresh:', err.message));
    } else {
      saveScenePageData(id, pageNumber, scene).catch(err => {
        log.error('Failed to save bbox refresh atomically, falling back:', err.message);
        saveStoryData(id, storyData).catch(err2 => log.error('Fallback save failed:', err2.message));
      });
    }
  } catch (err) {
    log.error('❌ [REFRESH-BBOX] Failed:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Bbox detection failed: ' + err.message : 'Bbox detection failed' });
  }
});

// Iterate bbox: send overlay image + current detections back to vision model for refinement
router.post('/:id/iterate-bbox/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
    if (isNaN(pageNumber)) return res.status(400).json({ error: 'Invalid page number' });
    if (req.user.role !== 'admin' && !req.user.impersonating) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const { bboxModel, currentDetection, overlayImage } = req.body;
    if (!currentDetection || !overlayImage) {
      return res.status(400).json({ error: 'currentDetection and overlayImage are required' });
    }

    const modelId = bboxModel || MODEL_DEFAULTS.bboxDetection || 'gemini-2.5-flash';
    log.info(`🔄 [ITERATE-BBOX] Page ${pageNumber}: Refining bbox with ${modelId}`);

    // Only send main characters (identified by name), skip UNKNOWN crowd figures
    const mainCharacters = (currentDetection.figures || []).filter(f => f.name && f.name !== 'UNKNOWN');
    if (mainCharacters.length === 0) {
      return res.status(400).json({ error: 'No identified characters to refine — run Re-detect first' });
    }
    log.info(`🔄 [ITERATE-BBOX] Refining ${mainCharacters.length} main characters (skipping ${(currentDetection.figures || []).length - mainCharacters.length} crowd figures)`);

    const figuresSummary = mainCharacters.map((f, i) => {
      const fb = f.faceBox ? `face:[${f.faceBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no face';
      const bb = f.bodyBox ? `body:[${f.bodyBox.map(v => Math.round(v * 1000)).join(',')}]` : 'no body';
      return `  ${i + 1}. "${f.name}" (${f.confidence}) — ${fb}, ${bb}`;
    }).join('\n');

    const iteratePrompt = `The attached image shows bounding boxes drawn on an illustration.
- THICK GREEN boxes = character BODY region
- THICK BLUE boxes labeled "FACE" = character FACE region (most important!)

CURRENT FACE & BODY BOXES (coordinates in 0-1000 scale, format [ymin, xmin, ymax, xmax]):
${figuresSummary || '  (none)'}

Your task: Look at the image carefully and REFINE these bounding boxes so they accurately capture each character.

FACE BOX RULES (most important):
- Must include the COMPLETE face: forehead to chin, ear to ear. Nothing cut off.
- Include hair/hat if it's part of the head silhouette.
- Must NOT include shoulders or neck below the jawline.
- If the face is turned or at an angle, the box should still capture the full visible face area.

BODY BOX RULES:
- Must include the COMPLETE character from head to feet. Nothing cut off.
- Include arms, legs, clothing, accessories — everything that is part of the character.
- If feet are visible, the box must extend to the bottom of the feet.
- If a character is holding something, include the held object in the body box.

Common issues to fix:
- Box shifted away from the actual element (move it to center on the character)
- Box too small — part of the face/body is cut off (EXPAND it)
- Box too large — includes background or other characters (SHRINK it)

Return CORRECTED coordinates. Keep the same character names. Only adjust the box positions.

Output JSON (ONLY figures, no objects):
{
  "figures": [
    {"name": "CharName", "label": "description", "position": "center", "confidence": "high", "face_box": [ymin, xmin, ymax, xmax], "body_box": [ymin, xmin, ymax, xmax]}
  ]
}

Coordinates use 0-1000 scale where [0,0] is top-left and [1000,1000] is bottom-right.
Respond with ONLY the JSON, no explanation.`;

    // Send overlay image + prompt to vision model
    const overlayBase64 = overlayImage.replace(/^data:image\/\w+;base64,/, '');
    const overlayMime = overlayImage.match(/^data:(image\/\w+);base64,/) ?
      overlayImage.match(/^data:(image\/\w+);base64,/)[1] : 'image/jpeg';

    const parts = [
      { inline_data: { mime_type: overlayMime, data: overlayBase64 } },
      { text: iteratePrompt }
    ];

    const modelConfig = TEXT_MODELS[modelId];
    let data;

    if (modelConfig?.provider === 'xai') {
      const grokResponse = await callGrokVisionAPI(modelId, modelConfig.modelId || modelId, parts, iteratePrompt);
      data = await grokResponse.json();
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: 16000, temperature: 0.1, responseMimeType: 'application/json' },
          safetySettings: GEMINI_SAFETY_SETTINGS
        })
      });
      if (!response.ok) {
        const error = await response.text();
        return res.status(500).json({ error: `Model error: ${error.substring(0, 200)}` });
      }
      data = await response.json();
    }

    const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!responseText) {
      return res.status(500).json({ error: 'Model returned no response' });
    }

    // Parse refined detections
    let refined;
    try {
      refined = extractJsonFromText(responseText);
    } catch (e) {
      return res.status(500).json({ error: 'Failed to parse model response', raw: responseText.substring(0, 500) });
    }

    // Normalize coordinates from 0-1000 to 0-1
    const normalizeBox = (box) => {
      if (!box || !Array.isArray(box) || box.length !== 4) return null;
      const [ymin, xmin, ymax, xmax] = box;
      const scale = (ymin > 1 || xmin > 1 || ymax > 1 || xmax > 1) ? 1000 : 1;
      return [
        Math.max(0, Math.min(1, ymin / scale)),
        Math.max(0, Math.min(1, xmin / scale)),
        Math.max(0, Math.min(1, ymax / scale)),
        Math.max(0, Math.min(1, xmax / scale))
      ];
    };

    const refinedMainFigures = (refined.figures || []).map(fig => ({
      name: fig.name || 'UNKNOWN',
      label: fig.label,
      position: fig.position,
      faceBox: normalizeBox(fig.face_box),
      bodyBox: normalizeBox(fig.body_box),
      confidence: fig.confidence || 'medium',
      _source: 'refined'
    }));

    // Merge: refined main characters + unchanged crowd figures + unchanged objects
    const crowdFigures = (currentDetection.figures || []).filter(f => !f.name || f.name === 'UNKNOWN');
    const figures = [...refinedMainFigures, ...crowdFigures];
    const objects = currentDetection.objects || [];

    const refinedDetection = { figures, objects, iterated: true };

    // Load story to get the original image for overlay
    const storyResult = await getDbPool().query('SELECT * FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (storyResult.rows.length === 0) return res.status(404).json({ error: 'Story not found' });
    let storyData = typeof storyResult.rows[0].data === 'string' ? JSON.parse(storyResult.rows[0].data) : storyResult.rows[0].data;
    storyData = await rehydrateStoryImages(id, storyData);

    const isCover = pageNumber < 0;
    let scene, imageData;
    if (isCover) {
      const coverMap = { '-1': 'frontCover', '-2': 'initialPage', '-3': 'backCover' };
      scene = storyData.coverImages?.[coverMap[String(pageNumber)]];
      imageData = scene?.imageData;
    } else {
      scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      imageData = scene?.imageData;
    }

    // Create new overlay with refined boxes
    let newOverlay = null;
    if (imageData) {
      newOverlay = await createBboxOverlayImage(imageData, refinedDetection);
    }

    // Save refined detection to scene
    if (scene) {
      scene.bboxDetection = refinedDetection;
      if (scene.imageVersions) {
        const activeVersion = scene.imageVersions.find(v => v.isActive);
        if (activeVersion) activeVersion.bboxDetection = refinedDetection;
      }
      if (isCover) {
        saveStoryData(id, storyData).catch(err => log.error('Failed to save iterated bbox:', err.message));
      } else {
        saveScenePageData(id, pageNumber, scene).catch(err => {
          saveStoryData(id, storyData).catch(err2 => log.error('Fallback save failed:', err2.message));
        });
      }
    }

    log.info(`✅ [ITERATE-BBOX] Page ${pageNumber}: Refined to ${figures.length} figures, ${objects.length} objects`);
    res.json({ bboxDetection: refinedDetection, bboxOverlayImage: newOverlay });
  } catch (err) {
    log.error('❌ [ITERATE-BBOX] Failed:', err);
    res.status(500).json({ error: 'Bbox iteration failed: ' + err.message });
  }
});

// Step 5: Run entity consistency check
router.post('/:id/repair-workflow/consistency-check', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    log.info(`🔍 [REPAIR-WORKFLOW] Running consistency check for story ${id}`);

    // Get story data
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    // Rehydrate image data into a COPY for crop extraction (don't modify original)
    const rehydratedData = await rehydrateStoryImages(id, JSON.parse(JSON.stringify(storyData)));

    // Run entity consistency check with rehydrated data
    const characters = rehydratedData.characters || [];
    const report = await runEntityConsistencyChecks(rehydratedData, characters);

    // Save any newly-generated bboxDetection back to the original storyData
    // so it's cached in retryHistory for next time (avoids redundant API calls)
    if (report.pagesWithNewBbox?.length > 0) {
      log.info(`🔍 [REPAIR-WORKFLOW] Saving fallback bboxDetection for pages: ${report.pagesWithNewBbox.join(', ')}`);
      for (const pageNumber of report.pagesWithNewBbox) {
        const rehydratedScene = rehydratedData.sceneImages?.find(s => s.pageNumber === pageNumber);
        const originalScene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
        if (rehydratedScene?.bboxDetection && originalScene) {
          if (!originalScene.retryHistory) originalScene.retryHistory = [];
          // Attach bbox data to the last generation entry (bbox is analysis, not a generation attempt)
          const lastGenEntry = [...originalScene.retryHistory].reverse().find(h => h.type === 'generation' || h.type === 'incremental_consistency');
          if (lastGenEntry) {
            lastGenEntry.bboxDetection = rehydratedScene.bboxDetection;
            lastGenEntry.source = 'consistency-check-fallback';
          } else {
            // No generation entry exists — store on first entry as fallback
            if (originalScene.retryHistory.length > 0) {
              originalScene.retryHistory[originalScene.retryHistory.length - 1].bboxDetection = rehydratedScene.bboxDetection;
            }
          }
        }
      }
    }

    // Save report to ORIGINAL story data (without image data) to avoid re-saving images
    if (!storyData.finalChecksReport) {
      storyData.finalChecksReport = {};
    }
    storyData.finalChecksReport.entity = report;
    // Update top-level fields so frontend display is consistent
    const legacyIssues = storyData.finalChecksReport.legacy?.totalIssues || 0;
    storyData.finalChecksReport.totalIssues = (report.totalIssues || 0) + legacyIssues;
    storyData.finalChecksReport.overallConsistent = (report.totalIssues || 0) + legacyIssues === 0;

    // Calculate cost before responding
    const { inputTokens = 0, outputTokens = 0, model: checkModel } = report.tokenUsage || {};
    const apiCost = calculateTokenCost(checkModel || 'gemini-2.5-flash', inputTokens, outputTokens);

    log.info(`✅ [REPAIR-WORKFLOW] Consistency check complete: ${report.totalIssues} issues found`);
    res.json({ report, apiCost });

    // Save to DB in background (don't block the response)
    saveStoryData(id, storyData).catch(err => log.error('Failed to save entity report:', err.message));
    addRepairCost(id, apiCost, 'Consistency check').catch(err => log.error('Failed to save repair cost:', err.message));
  } catch (err) {
    log.error('Error in consistency check:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to run consistency check: ' + err.message : 'Failed to run consistency check' });
  }
});

// Step 6: Pick best version per page (highest qualityScore from imageVersions)
router.post('/:id/repair-workflow/pick-best-versions', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { pageNumbers } = req.body;

    if (!pageNumbers || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
      return res.status(400).json({ error: 'pageNumbers array is required' });
    }
    if (!pageNumbers.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'All pageNumbers must be integers' });
    }

    log.info(`🏆 [REPAIR-WORKFLOW] Picking best versions for ${pageNumbers.length} pages`);

    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    const results = {};
    for (const pageNumber of pageNumbers) {
      let scene;
      let imageType = 'scene';
      if (isCoverPage(pageNumber)) {
        const coverType = getCoverType(pageNumber);
        scene = getCoverData(storyData, coverType);
        imageType = coverType;
      } else {
        scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      }
      if (!scene?.imageVersions || scene.imageVersions.length <= 1) {
        results[pageNumber] = { switched: false, reason: 'single version' };
        continue;
      }

      // Find version with highest qualityScore (skip null/unevaluated versions)
      let bestIndex = -1;
      let bestScore = -1;
      let activeIndex = -1;
      for (let i = 0; i < scene.imageVersions.length; i++) {
        const v = scene.imageVersions[i];
        if (v.isActive) activeIndex = i;
        const score = v.qualityScore;
        if (score != null && score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      // Don't switch away from an unevaluated entity-repair version — it was applied
      // intentionally to fix character issues and hasn't been scored yet
      const activeVersion = activeIndex >= 0 ? scene.imageVersions[activeIndex] : null;
      const isUnevaluatedRepair = activeVersion?.type === 'entity-repair' && activeVersion?.qualityScore == null;

      if (isUnevaluatedRepair) {
        log.info(`🏆 [REPAIR-WORKFLOW] Page ${pageNumber}: keeping unevaluated entity-repair version (index ${activeIndex})`);
        results[pageNumber] = { switched: false, toIndex: activeIndex, score: null, reason: 'unevaluated-entity-repair' };
      } else if (bestIndex >= 0 && bestIndex !== activeIndex) {
        // Switch active version
        scene.imageVersions.forEach((v, i) => { v.isActive = (i === bestIndex); });

        const dbIndex = arrayToDbIndex(bestIndex, imageType);

        const versionId = isCoverPage(pageNumber) ? getCoverType(pageNumber) : pageNumber;
        await setActiveVersion(id, versionId, dbIndex);
        log.info(`🏆 [REPAIR-WORKFLOW] Page ${pageNumber}: switched to version ${bestIndex} (db index ${dbIndex}, score ${bestScore}, was ${activeIndex})`);
        results[pageNumber] = { switched: true, toIndex: bestIndex, score: bestScore, fromIndex: activeIndex };
      } else {
        results[pageNumber] = { switched: false, toIndex: activeIndex, score: bestScore };
      }
    }

    log.info(`✅ [REPAIR-WORKFLOW] Pick-best complete: ${Object.values(results).filter(r => r.switched).length} pages switched`);
    res.json({ results });

    // Save to DB in background (don't block the response)
    saveStoryData(id, storyData).catch(err => log.error('Failed to save pick-best:', err.message));
  } catch (err) {
    log.error('❌ [REPAIR-WORKFLOW] Failed to pick best versions:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to pick best versions: ' + err.message : 'Failed to pick best versions' });
  }
});

// Step 7: Repair characters using repairSinglePage, MagicAPI, or Grok
router.post('/:id/repair-workflow/character-repair', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { repairs: manualRepairs, useMagicApiRepair, autoSelect, grokRepairMode, whiteoutTarget, maxCharRepairPages: maxCharRepairPagesOverride } = req.body;

    let repairs;

    // Load story data once upfront (shared by autoSelect and repair phases)
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }
    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;
    storyData = await rehydrateStoryImages(id, storyData);

    if (autoSelect) {
      // Auto-select mode: derive repairs from entity report in DB
      const storyEntityReport = storyData.finalChecksReport?.entity;

      if (!storyEntityReport || !storyEntityReport.characters) {
        return res.json({ results: [], message: 'No entity report found, nothing to repair' });
      }

      const pageScores = {};
      for (const scene of (storyData.sceneImages || [])) {
        if (scene.pageNumber != null) pageScores[scene.pageNumber] = scene.qualityScore ?? 100;
      }
      // Include covers in repair candidate scoring
      if (storyData.coverImages) {
        const coverPageMap = { frontCover: -1, initialPage: -2, backCover: -3 };
        for (const [coverType, cover] of Object.entries(storyData.coverImages)) {
          if (cover && coverPageMap[coverType] != null) {
            pageScores[coverPageMap[coverType]] = cover.qualityScore ?? 100;
          }
        }
      }
      const { repairs: autoRepairs, dropped } = selectCharRepairTasks(storyEntityReport, { pageScores, ...(maxCharRepairPagesOverride != null ? { maxTasks: maxCharRepairPagesOverride } : {}) });
      if (autoRepairs.length === 0) {
        return res.json({ results: [], message: 'No major/critical issues found' });
      }
      repairs = autoRepairs;
      log.info(`👤 [REPAIR-WORKFLOW] Auto-selected ${repairs.length} character repairs (${dropped} dropped)`);
    } else {
      // Manual mode: use provided repairs array
      repairs = manualRepairs;
      if (!repairs || !Array.isArray(repairs) || repairs.length === 0) {
        return res.status(400).json({ error: 'repairs array is required (or use autoSelect: true)' });
      }

      // Limit total repair attempts using shared constant
      const maxRepairPages = REPAIR_DEFAULTS.maxCharRepairPages;
      let totalPageCount = 0;
      for (const repair of repairs) {
        totalPageCount += (repair.pages?.length || 0);
      }
      if (totalPageCount > maxRepairPages) {
        log.info(`👤 [REPAIR-WORKFLOW] Limiting character repairs: ${totalPageCount} pages requested, capping at ${maxRepairPages}`);
        let remaining = maxRepairPages;
        for (const repair of repairs) {
          if (remaining <= 0) {
            repair.pages = [];
          } else {
            repair.pages = repair.pages.slice(0, remaining);
            remaining -= repair.pages.length;
          }
        }
      }
    }

    const repairMethod = grokRepairMode ? `Grok ${grokRepairMode}` : useMagicApiRepair ? 'MagicAPI' : isGrokConfigured() ? 'Grok blended' : 'Gemini';
    log.info(`👤 [REPAIR-WORKFLOW] Starting character repair for story ${id} using ${repairMethod}`);

    const results = [];
    let totalGeminiRepairs = 0, totalMagicApiRepairs = 0, totalGrokRepairs = 0;
    let totalVerifyTokensIn = 0, totalVerifyTokensOut = 0;
    const artStyle = storyData.artStyle || 'pixar';

    // Flatten all (character, page) pairs into parallel repair tasks
    const repairTasks = [];
    for (const repair of repairs) {
      const { character: characterName, pages } = repair;
      let character = storyData.characters?.find(c => c.name === characterName);
      if (!character) {
        results.push({ character: characterName, pagesRepaired: [], error: `Character "${characterName}" not found` });
        continue;
      }

      // Check if character has usable avatar data
      const hasStyledStandard = !!character.avatars?.styledAvatars?.[artStyle]?.standard;
      const hasBaseStandard = !!character.avatars?.standard;
      if (!hasStyledStandard && !hasBaseStandard) {
        log.info(`🔧 [REPAIR-WORKFLOW] Character ${characterName} missing standard avatar, fetching from database...`);
        try {
          const characterSetId = storyData.characterSetId;
          if (characterSetId) {
            const charSetResult = await getDbPool().query(
              'SELECT data FROM characters WHERE id = $1',
              [characterSetId]
            );
            if (charSetResult.rows.length > 0) {
              const charSetData = typeof charSetResult.rows[0].data === 'string'
                ? JSON.parse(charSetResult.rows[0].data)
                : charSetResult.rows[0].data;
              const fullChar = charSetData.characters?.find(c => c.name === characterName);
              if (fullChar) {
                character = { ...character, ...fullChar, avatars: fullChar.avatars || character.avatars };
                log.info(`🔧 [REPAIR-WORKFLOW] Enriched ${characterName} with avatar data from character set`);
              }
            }
          }
        } catch (enrichErr) {
          log.warn(`[REPAIR-WORKFLOW] Failed to enrich character data: ${enrichErr.message}`);
        }
      }

      const entityReport = storyData.finalChecksReport?.entity;
      // Collect issues from both legacy flat format and modern byClothing format
      const charResult = entityReport?.characters?.[characterName];
      const charIssues = [];
      if (charResult) {
        // Legacy format: issues at character root
        if (charResult.issues) charIssues.push(...charResult.issues);
        // Modern format: issues nested under byClothing
        if (charResult.byClothing) {
          for (const clothingResult of Object.values(charResult.byClothing)) {
            for (const issue of (clothingResult.issues || [])) {
              if (!charIssues.some(i => i.id === issue.id)) charIssues.push(issue);
            }
          }
        }
      }
      if (charIssues.length > 0) {
        log.info(`🔧 [REPAIR-WORKFLOW] Found ${charIssues.length} consistency issues for ${characterName}`);
      }

      for (const pageNumber of pages) {
        // Filter to issues relevant to this page
        const pageCharIssues = charIssues.filter(i =>
          i.pagesToFix?.includes(pageNumber) || i.pageNumber === pageNumber
        );
        repairTasks.push({ characterName, character, pageNumber, charIssues: pageCharIssues });
      }
    }

    // Phase 1: Run repair API calls — parallel across pages, sequential within a page
    // Multiple characters on the same page must be repaired sequentially because each
    // repair modifies the scene image (blackout region → Grok fix → blend). Running them
    // in parallel would cause each to start from the original, and only the last write wins.
    const tasksByPage = new Map();
    for (const task of repairTasks) {
      const key = task.pageNumber;
      if (!tasksByPage.has(key)) tasksByPage.set(key, []);
      tasksByPage.get(key).push(task);
    }
    const multiCharPages = [...tasksByPage.values()].filter(t => t.length > 1).length;
    log.info(`🔧 [REPAIR-WORKFLOW] Running ${repairTasks.length} repair tasks across ${tasksByPage.size} pages (${multiCharPages} pages with multiple characters — sequential within page)...`);

    const repairLimit = pLimit(50);
    // Each "unit" is one page — characters on that page run sequentially
    const apiResults = (await Promise.all([...tasksByPage.entries()].map(([pageNumber, pageTasks]) => repairLimit(async () => {
      const pageResults = [];
      for (const task of pageTasks) {
        // For sequential repairs on the same page, update the scene image reference
        // so the next character repair starts from the already-repaired image
        if (pageResults.length > 0) {
          const lastSuccess = pageResults.filter(r => r.repairResult?.success).pop();
          if (lastSuccess?.repairResult?.updatedImages?.[0]?.imageData) {
            // Update the in-memory scene image so the next repair uses the already-fixed image
            const sceneImage = findSceneOrCover(storyData, pageNumber);
            if (sceneImage) {
              sceneImage.imageData = lastSuccess.repairResult.updatedImages[0].imageData;
              log.debug(`🔗 [REPAIR-WORKFLOW] Chaining: page ${pageNumber} updated with ${lastSuccess.task.characterName}'s repair for next character`);
            }
          }
        }
        const result = await (async () => {
      const { characterName, character, pageNumber, charIssues } = task;
      try {
        log.info(`🔧 [REPAIR-WORKFLOW] Repairing ${characterName} on page ${pageNumber} with ${repairMethod}`);

        let repairResult;

        if (useMagicApiRepair) {
          const { repairFaceWithMagicApi, isMagicApiConfigured } = require('../lib/magicApi');

          if (!isMagicApiConfigured()) {
            log.warn(`[REPAIR-WORKFLOW] MagicAPI not configured, falling back to Gemini`);
            repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
          } else {
            const sceneImage = findSceneOrCover(storyData, pageNumber);
            if (!sceneImage || !sceneImage.imageData) {
              log.warn(`[REPAIR-WORKFLOW] No scene image for page ${pageNumber}`);
              return { task, error: true, failReason: 'No scene image data for this page' };
            }

            const sceneDescriptions = storyData.sceneDescriptions || [];
            const entityAppearances = await collectEntityAppearances([sceneImage], [character], sceneDescriptions, { skipMinAppearancesFilter: true });
            const appearances = entityAppearances.get(characterName);
            const appearance = appearances?.find(a => a.pageNumber === pageNumber);

            if (!appearance?.faceBox && !appearance?.bodyBox) {
              log.warn(`[REPAIR-WORKFLOW] No bounding box for ${characterName} on page ${pageNumber}`);
              repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
            } else {
              const clothingCategory = appearance.clothing || 'standard';
              const styledAvatar = getStyledAvatarForClothing(character, artStyle, clothingCategory);

              if (!styledAvatar) {
                log.warn(`[REPAIR-WORKFLOW] No avatar for ${characterName}, falling back to Gemini`);
                repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
              } else {
                const sceneBuffer = Buffer.from(
                  sceneImage.imageData.replace(/^data:image\/\w+;base64,/, ''),
                  'base64'
                );
                const avatarBuffer = styledAvatar.startsWith('data:')
                  ? Buffer.from(styledAvatar.replace(/^data:image\/\w+;base64,/, ''), 'base64')
                  : Buffer.from(styledAvatar, 'base64');

                const bbox = appearance.faceBox || appearance.bodyBox;
                const hairConfig = {
                  color: character.physical?.hairColor,
                  style: character.physical?.hairStyle || character.physical?.hairLength,
                  property: 'textured'
                };

                log.info(`[REPAIR-WORKFLOW] MagicAPI repair: bbox=${JSON.stringify(bbox)}, hair=${JSON.stringify(hairConfig)}`);

                try {
                  const magicResult = await repairFaceWithMagicApi(sceneBuffer, avatarBuffer, bbox, hairConfig);
                  const avatarDataUri = `data:image/png;base64,${avatarBuffer.toString('base64')}`;

                  if (magicResult.success && magicResult.repairedBuffer) {
                    const repairedDataUri = `data:image/png;base64,${magicResult.repairedBuffer.toString('base64')}`;

                    let beforeDataUri = null;
                    try {
                      const sharp = require('sharp');
                      const imgMeta = await sharp(sceneBuffer).metadata();
                      const cropX = Math.round(bbox.x * imgMeta.width);
                      const cropY = Math.round(bbox.y * imgMeta.height);
                      const cropW = Math.round(bbox.width * imgMeta.width);
                      const cropH = Math.round(bbox.height * imgMeta.height);
                      if (cropW > 0 && cropH > 0) {
                        const cropBuf = await sharp(sceneBuffer)
                          .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
                          .jpeg({ quality: 80 })
                          .toBuffer();
                        beforeDataUri = `data:image/jpeg;base64,${cropBuf.toString('base64')}`;
                      }
                    } catch (cropErr) {
                      log.debug(`[REPAIR-WORKFLOW] Could not extract bbox crop for comparison: ${cropErr.message}`);
                    }

                    repairResult = {
                      success: true,
                      updatedImages: [{ pageNumber, imageData: repairedDataUri }],
                      method: 'magicapi',
                      clothingCategory,
                      cropHistory: magicResult.cropHistory,
                      comparison: { before: beforeDataUri, after: repairedDataUri, reference: avatarDataUri },
                    };
                  } else {
                    log.error(`[REPAIR-WORKFLOW] MagicAPI returned no result for ${characterName} on page ${pageNumber}`);
                    return { task, error: true, failReason: 'MagicAPI returned no result' };
                  }
                } catch (magicErr) {
                  log.error(`[REPAIR-WORKFLOW] MagicAPI repair failed for ${characterName} on page ${pageNumber}: ${magicErr.message}`);
                  return { task, error: true, failReason: `MagicAPI: ${magicErr.message}` };
                }
              }
            }
          }
        } else if (grokRepairMode || isGrokConfigured()) {
          // Grok repair: blended (default), cutout, or blackout
          const effectiveMode = grokRepairMode || 'blended';

          const sceneImage = findSceneOrCover(storyData, pageNumber);
          if (!sceneImage || !sceneImage.imageData) {
            return { task, error: true, failReason: 'No scene image data for this page' };
          }

          // Determine clothing for this character on this page
          // Priority: scene metadata > clothingRequirements > 'standard'
          let pageClothing = 'standard';
          const sceneMetadata = sceneImage.sceneMetadata || (sceneImage.description ? extractSceneMetadata(sceneImage.description) : null);
          if (sceneMetadata?.characterClothing?.[characterName]) {
            pageClothing = sceneMetadata.characterClothing[characterName];
          } else if (storyData.clothingRequirements?.[characterName]) {
            const charReqs = storyData.clothingRequirements[characterName];
            if (charReqs?.costumed?.used && charReqs.costumed.costume) {
              pageClothing = `costumed:${charReqs.costumed.costume}`;
            }
          }

          // 1. Try bbox from quality evaluation (stored on scene/version — most reliable)
          let storedAppearance = null;
          const sceneBbox = sceneImage.bboxDetection;
          if (sceneBbox?.figures) {
            const fig = sceneBbox.figures.find(f =>
              f.name?.toLowerCase() === characterName.toLowerCase()
            );
            if (fig && (fig.faceBox || fig.bodyBox)) {
              storedAppearance = { faceBox: fig.faceBox, bodyBox: fig.bodyBox, clothing: pageClothing };
              log.info(`✅ [CHAR REPAIR] Found ${characterName} bbox from scene evaluation (page ${pageNumber}, clothing: ${pageClothing})`);
            }
          }

          // 2. Try entity consistency report (stored during consistency check)
          if (!storedAppearance) {
            const storedEntityReport = storyData.finalChecksReport?.entity;
            const charReport = storedEntityReport?.characters?.[characterName];
            if (charReport?.byClothing) {
              for (const [, clothingData] of Object.entries(charReport.byClothing)) {
                const app = clothingData.appearances?.find(a => a.pageNumber === pageNumber);
                if (app?.faceBox || app?.bodyBox) {
                  storedAppearance = app;
                  log.info(`✅ [CHAR REPAIR] Found ${characterName} bbox from entity report (page ${pageNumber})`);
                  break;
                }
              }
            }
          }

          // 3. Fallback: fresh detection if neither source has bbox
          if (!storedAppearance?.faceBox && !storedAppearance?.bodyBox) {
            log.info(`🔍 [CHAR REPAIR] No stored bbox for ${characterName} on page ${pageNumber}, running fresh detection...`);
            const physDesc = buildCharacterPhysicalDescription(character);
            const detection = await detectAllBoundingBoxes(sceneImage.imageData, {
              expectedCharacters: [{ name: characterName, description: physDesc }]
            });
            const charFigure = detection?.figures?.find(f =>
              f.name?.toLowerCase() === characterName.toLowerCase() ||
              f.label?.toLowerCase().includes(characterName.toLowerCase())
            );
            if (charFigure && (charFigure.faceBox || charFigure.bodyBox)) {
              storedAppearance = {
                faceBox: charFigure.faceBox,
                bodyBox: charFigure.bodyBox,
                clothing: pageClothing
              };
              log.info(`✅ [CHAR REPAIR] Fresh bbox for ${characterName}: face=${charFigure.faceBox ? 'yes' : 'no'}, body=${charFigure.bodyBox ? 'yes' : 'no'}`);
            } else {
              return { task, error: true, failReason: `Could not locate ${characterName} on page ${pageNumber}` };
            }
          }

          const clothingCategory = storedAppearance.clothing || 'standard';
          const styledAvatar = getStyledAvatarForClothing(character, artStyle, clothingCategory);
          const avatarData = styledAvatar || character.avatars?.standard || character.avatarUrl;

          if (!avatarData) {
            return { task, error: true, failReason: `No avatar for ${characterName}` };
          }

          // Determine repair region based on issue types
          // face issues → use faceBox, clothing issues → use bodyBox, both → bodyBox
          const issueDesc = charIssues.length > 0
            ? charIssues.map(i => i.issue || i.description || '').filter(Boolean).join('; ')
            : '';
          const issueText = issueDesc.toLowerCase();
          const hasFaceIssue = issueText.includes('face') || issueText.includes('hair') || issueText.includes('skin') || issueText.includes('eye') || issueText.includes('age');
          const hasClothingIssue = issueText.includes('cloth') || issueText.includes('outfit') || issueText.includes('dress') || issueText.includes('shirt') || issueText.includes('jacket') || issueText.includes('color');

          // Pick the right box: user override > auto-detect from issues
          const useFaceOnly = whiteoutTarget === 'face' ? !!storedAppearance.faceBox
            : whiteoutTarget === 'body' ? false
            : (hasFaceIssue && !hasClothingIssue && !!storedAppearance.faceBox);
          const repairBox = useFaceOnly ? storedAppearance.faceBox : (storedAppearance.bodyBox || storedAppearance.faceBox);
          // Bbox can be either [ymin, xmin, ymax, xmax] (array from detectAllBoundingBoxes)
          // or {x, y, width, height} (object from some legacy paths)
          let bbox;
          if (Array.isArray(repairBox)) {
            bbox = repairBox; // Already [ymin, xmin, ymax, xmax]
          } else {
            bbox = [repairBox.y, repairBox.x, repairBox.y + repairBox.height, repairBox.x + repairBox.width];
          }

          // Get clothing description for the prompt
          const clothingDesc = character.avatars?.clothing?.[clothingCategory] || '';

          // Get scene description for context (what is the character doing?)
          const sceneDesc = sceneImage.description || sceneImage.translatedDescription || '';

          log.info(`👤 [CHAR REPAIR] ${characterName} on page ${pageNumber}: ${useFaceOnly ? 'FACE only' : 'FULL character'} repair (face:${hasFaceIssue}, clothing:${hasClothingIssue})`);

          // Get face bbox for head whiteout (separate from repair bbox which may be full body)
          let faceBbox = null;
          const faceData = storedAppearance.faceBox;
          if (faceData) {
            faceBbox = Array.isArray(faceData) ? faceData : [faceData.y, faceData.x, faceData.y + faceData.height, faceData.x + faceData.width];
          }

          // Collect face bboxes of OTHER characters on the same page to protect during blend
          const protectedFaces = [];
          const entityReportForProtection = storyData.finalChecksReport?.entity;
          if (entityReportForProtection?.characters) {
            for (const [otherName, otherCharReport] of Object.entries(entityReportForProtection.characters)) {
              if (otherName === characterName) continue;
              if (!otherCharReport?.byClothing) continue;
              for (const clothingData of Object.values(otherCharReport.byClothing)) {
                const app = clothingData.appearances?.find(a => a.pageNumber === pageNumber);
                if (app?.faceBox) {
                  const fb = app.faceBox;
                  const normalized = Array.isArray(fb) ? fb : [fb.y, fb.x, fb.y + fb.height, fb.x + fb.width];
                  protectedFaces.push(normalized);
                  log.info(`🛡️ [CHAR REPAIR] Protecting ${otherName}'s face at [${normalized.map(v => Math.round(v*100)+'%').join(', ')}]`);
                }
              }
            }
          }

          const grokResult = await repairCharacterMismatch(
            sceneImage.imageData,
            avatarData.startsWith('data:') ? avatarData : `data:image/jpeg;base64,${avatarData}`,
            bbox,
            characterName,
            {
              imageBackend: 'grok',
              useBlended: effectiveMode === 'blended',
              useCutout: effectiveMode === 'cutout',
              issueDescription: issueDesc,
              clothingDescription: clothingDesc,
              sceneDescription: sceneDesc,
              faceBbox,
              protectedFaces,
              whiteoutTarget: whiteoutTarget || (useFaceOnly ? 'face' : 'body'),
              includeDebug: req.user.role === 'admin',
            }
          );

          if (grokResult.imageData) {
            repairResult = {
              success: true,
              updatedImages: [{ pageNumber, imageData: grokResult.imageData }],
              method: grokResult.method,
              usage: grokResult.usage,
              debug: grokResult.debug || null,
              comparison: {
                before: sceneImage.imageData,
                after: grokResult.imageData,
                reference: avatarData.startsWith('data:') ? avatarData : `data:image/jpeg;base64,${avatarData}`,
                blackoutImage: grokResult.blackoutImage || null,
                grokRawResult: grokResult.grokRawResult || null,
                blendMask: grokResult.blendMask || null,
              },
            };
          } else {
            return { task, error: true, failReason: 'Grok repair returned no image' };
          }
        } else {
          // Fallback to Gemini when Grok not configured
          repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
        }

        return { task, repairResult };
      } catch (pageErr) {
        log.error(`Error repairing ${characterName} on page ${pageNumber}:`, pageErr);
        return { task, error: true, failReason: pageErr.message };
      }
        })();
        pageResults.push(result);
      }
      return pageResults;
    })))).flat();

    // Phase 2: Apply results to DB sequentially (avoids race conditions on storyData blob)
    // Re-read storyData fresh before applying
    const freshResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (freshResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found during Phase 2 write-back' });
    }
    storyData = typeof freshResult.rows[0].data === 'string' ? JSON.parse(freshResult.rows[0].data) : freshResult.rows[0].data;
    storyData = await rehydrateStoryImages(id, storyData);

    // Group results by character for output
    const resultsByChar = new Map();
    for (const repair of repairs) {
      if (!resultsByChar.has(repair.character)) {
        resultsByChar.set(repair.character, { pagesRepaired: [], pagesFailed: [] });
      }
    }

    for (const apiResult of apiResults) {
      if (!apiResult) continue;
      const { task, repairResult, error, failReason } = apiResult;
      const { characterName, pageNumber } = task;
      const charResult = resultsByChar.get(characterName);
      if (!charResult) continue;

      if (error) {
        charResult.pagesFailed.push({ pageNumber, reason: failReason });
        continue;
      }

      // Track repair cost
      if (repairResult.method === 'magicapi') {
        totalMagicApiRepairs++;
      } else if (repairResult.method?.startsWith('grok_')) {
        totalGrokRepairs++;
      } else {
        totalGeminiRepairs++;
      }
      // Track verify tokens (only for non-Grok methods — Grok returns direct_cost, not token counts)
      if (repairResult.usage && !repairResult.method?.startsWith('grok_')) {
        totalVerifyTokensIn += repairResult.usage.promptTokenCount || 0;
        totalVerifyTokensOut += repairResult.usage.candidatesTokenCount || 0;
      }

      if (!repairResult.success) {
        const reason = repairResult.reason || repairResult.error || 'Unknown error';
        log.warn(`[REPAIR-WORKFLOW] Repair failed for ${characterName} on page ${pageNumber}: ${reason}`);
        charResult.pagesFailed.push({
          pageNumber,
          reason,
          rejected: repairResult.rejected || false,
          comparison: repairResult.comparison || null
        });
        continue;
      }

      // Apply updated image to story (sequential DB writes)
      const sceneImages = storyData.sceneImages || [];
      for (const update of repairResult.updatedImages || []) {
        // Look up the existing image — in sceneImages for regular pages, in coverImages for covers
        let existingImage;
        let isCover = false;
        let coverType = null;
        const sceneIndex = sceneImages.findIndex(img => img.pageNumber === update.pageNumber);
        if (sceneIndex >= 0) {
          existingImage = sceneImages[sceneIndex];
        } else if (update.pageNumber < 0) {
          coverType = COVER_PAGE_MAP[String(update.pageNumber)];
          existingImage = coverType ? storyData.coverImages?.[coverType] : null;
          isCover = !!existingImage;
        }

        if (!existingImage) continue;

          if (!existingImage.imageVersions) {
            existingImage.imageVersions = [{
              description: existingImage.description,
              prompt: existingImage.prompt,
              modelId: existingImage.modelId,
              createdAt: existingImage.generatedAt || storyData.createdAt || new Date().toISOString(),
              isActive: false,
              type: 'original'
            }];
          } else {
            existingImage.imageVersions.forEach(v => v.isActive = false);
          }

          const isMagicApiMethod = repairResult.method === 'magicapi';
          const isGrokMethod = repairResult.method?.startsWith('grok_');
          const repairModelId = isMagicApiMethod ? 'magicapi-faceswap-hair' : isGrokMethod ? `grok-imagine (${repairResult.method})` : 'gemini-2.0-flash-preview-image-generation';
          existingImage.imageVersions.push({
            imageData: update.imageData,
            description: existingImage.description,
            prompt: existingImage.prompt,
            modelId: repairModelId,
            createdAt: new Date().toISOString(),
            generatedAt: new Date().toISOString(),
            isActive: true,
            type: 'entity-repair',
            qualityScore: null,
            entityRepairedFor: characterName,
            clothingCategory: repairResult.clothingCategory,
            ...(isMagicApiMethod && repairResult.cropHistory && { cropHistory: repairResult.cropHistory })
          });

          delete existingImage.imageData;
          existingImage.entityRepaired = true;
          existingImage.entityRepairedAt = new Date().toISOString();
          existingImage.entityRepairedFor = characterName;

          const imageType = isCover ? 'cover' : 'scene';
          const newDbVersionIndex = getActiveIndexAfterPush(existingImage.imageVersions, imageType);

          if (!isCover) {
            storyData.sceneImages = sceneImages;
          }
          await saveStoryData(id, storyData);
          // Note: saveStoryData already saves images from imageVersions to story_images table
          // For covers, use coverType string as the version identifier
          const versionId = isCover ? coverType : update.pageNumber;
          await setActiveVersion(id, versionId, newDbVersionIndex);

          charResult.pagesRepaired.push({
            pageNumber: update.pageNumber,
            imageData: update.imageData,
            versionIndex: newDbVersionIndex,
            comparison: repairResult.comparison || null,
            verification: repairResult.verification || null,
            method: repairResult.method || 'gemini',
            cropHistory: repairResult.cropHistory || null,
            debug: repairResult.debug || null,
          });
      }
    }

    for (const [characterName, charResult] of resultsByChar) {
      results.push({ character: characterName, ...charResult });
    }

    // Calculate and persist repair cost (Gemini + Grok per-image costs + verify tokens)
    const perImageCost = MODEL_PRICING['gemini-2.5-flash-image']?.perImage ?? 0.04;
    const grokPerImageCost = MODEL_PRICING['grok-imagine-image']?.perImage ?? 0.02;
    const imageGenCost = totalGeminiRepairs * perImageCost + totalGrokRepairs * grokPerImageCost;
    const verifyTokenCost = calculateTokenCost('gemini-2.5-flash', totalVerifyTokensIn, totalVerifyTokensOut);
    const apiCost = imageGenCost + verifyTokenCost;
    const totalAttempts = totalGeminiRepairs + totalMagicApiRepairs + totalGrokRepairs;
    log.info(`✅ [REPAIR-WORKFLOW] Character repair complete`);
    res.json({ results, apiCost });

    // Save cost in background
    addRepairCost(id, apiCost, `Character repair (${totalAttempts} attempts, ${totalGeminiRepairs} Gemini, ${totalGrokRepairs} Grok)`).catch(err => log.error('Failed to save repair cost:', err.message));
  } catch (err) {
    log.error('Error in character repair:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to repair characters: ' + err.message : 'Failed to repair characters' });
  }
});

// Step 7: Repair artifacts via grid repair
router.post('/:id/repair-workflow/artifact-repair', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { pageNumbers } = req.body;

    if (!pageNumbers || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
      return res.status(400).json({ error: 'pageNumbers array is required' });
    }
    if (!pageNumbers.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'All pageNumbers must be integers' });
    }

    log.info(`🔧 [REPAIR-WORKFLOW] Starting artifact repair for pages ${pageNumbers.join(', ')} in story ${id}`);

    // Get story data
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    // Rehydrate images from story_images table (they're stripped from JSON on save)
    storyData = await rehydrateStoryImages(id, storyData);

    const pagesProcessed = [];
    let issuesFixed = 0;

    // Process each page with grid repair
    const { gridBasedRepair } = require('../lib/gridBasedRepair');

    for (const pageNumber of pageNumbers) {
      const sceneIndex = storyData.sceneImages?.findIndex(s => s.pageNumber === pageNumber);
      if (sceneIndex === -1) continue;

      const scene = storyData.sceneImages[sceneIndex];

      try {
        // Run grid repair on the scene
        const repairResult = await gridBasedRepair(scene, { retryHistory: scene.retryHistory || [] });

        if (repairResult.repaired && repairResult.imageData) {
          // Add to image versions
          if (!scene.imageVersions) {
            scene.imageVersions = [{
              // Don't copy imageData — the original is already stored at DB version_index 0.
              // Including it here would cause saveStoryData to re-save it at version_index 1,
              // creating a duplicate row and an extra "attempt" in the UI.
              description: scene.description,
              prompt: scene.prompt,
              createdAt: new Date().toISOString(),
              isActive: false,
              type: 'original',
              qualityScore: scene.qualityScore,
              qualityReasoning: scene.qualityReasoning || null,
              fixTargets: scene.fixTargets || [],
              fixableIssues: scene.fixableIssues || [],
              totalAttempts: scene.totalAttempts || null,
              referencePhotoNames: (scene.referencePhotos || []).map(p => ({
                name: p.name, photoType: p.photoType,
                clothingCategory: p.clothingCategory, clothingDescription: p.clothingDescription
              })),
            }];
          }

          const newVersionIndex = scene.imageVersions.length;
          scene.imageVersions.push({
            imageData: repairResult.imageData,
            description: scene.description,
            createdAt: new Date().toISOString(),
            generatedAt: new Date().toISOString(),
            isActive: true,
            type: 'repair',
            qualityScore: repairResult.score,
            qualityReasoning: repairResult.reasoning || null,
            fixTargets: repairResult.fixTargets || [],
            fixableIssues: repairResult.fixableIssues || [],
            totalAttempts: null,
          });

          // Mark all other versions as inactive
          scene.imageVersions.forEach((v, i) => {
            v.isActive = i === newVersionIndex;
          });

          // Update scene metadata (but NOT imageData - that would cause duplicate image storage)
          // The new image is stored in imageVersions and activeVersion meta points to it
          scene.qualityScore = repairResult.score;

          pagesProcessed.push(pageNumber);
          issuesFixed += repairResult.fixedCount || 1;
        }
      } catch (pageErr) {
        log.error(`Error repairing artifacts on page ${pageNumber}:`, pageErr);
      }
    }

    // Save updated story (this saves all images from imageVersions to story_images)
    await saveStoryData(id, storyData);

    // Set active version for each repaired page
    for (const pageNumber of pagesProcessed) {
      const scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      if (scene?.imageVersions?.length) {
        await setActiveVersion(id, pageNumber, getActiveIndexAfterPush(scene.imageVersions, 'scene'));
      }
    }

    log.info(`✅ [REPAIR-WORKFLOW] Artifact repair complete: ${pagesProcessed.length} pages, ${issuesFixed} issues fixed`);
    res.json({ pagesProcessed, issuesFixed });
  } catch (err) {
    log.error('Error in artifact repair:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to repair artifacts: ' + err.message : 'Failed to repair artifacts' });
  }
});

// Edit cover image with a user prompt
router.post('/:id/edit/cover/:coverType', authenticateToken, async (req, res) => {
  try {
    const { id, coverType } = req.params;
    const { editPrompt } = req.body;

    // Accept both 'initial' and 'initialPage' for backwards compatibility
    const normalizedCoverType = coverType === 'initial' ? 'initialPage' : coverType;
    if (!['front', 'initialPage', 'back'].includes(normalizedCoverType)) {
      return res.status(400).json({ error: 'Invalid cover type. Must be: front, initial/initialPage, or back' });
    }

    if (!editPrompt || editPrompt.trim().length === 0) {
      return res.status(400).json({ error: 'editPrompt is required' });
    }

    log.debug(`✏️ Editing ${normalizedCoverType} cover for story ${id}`);
    log.debug(`✏️ Edit instruction: "${editPrompt}"`);

    // Get the story
    const storyResult = await getDbPool().query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    let storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Rehydrate images from story_images table (images may be stripped from data blob)
    storyData = await rehydrateStoryImages(id, storyData);

    // Get the current cover image
    const coverImages = storyData.coverImages || {};
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' :
                     normalizedCoverType === 'back' ? 'backCover' : 'initialPage';
    const existingCover = coverImages[coverKey];

    if (!existingCover) {
      return res.status(404).json({ error: 'No cover image found' });
    }

    // Get the image data (handle both string and object formats)
    const currentImageData = typeof existingCover === 'string' ? existingCover : existingCover.imageData;
    if (!currentImageData) {
      return res.status(404).json({ error: 'No cover image data found' });
    }

    // Capture previous image info before editing
    const previousImageData = currentImageData;
    const previousScore = typeof existingCover === 'object' ? existingCover.qualityScore || null : null;
    const previousReasoning = typeof existingCover === 'object' ? existingCover.qualityReasoning || null : null;
    log.debug(`📸 [COVER EDIT] Capturing previous image (score: ${previousScore})`);

    // Edit the cover image (pure text/instruction based - no character photos to avoid regeneration artifacts)
    const editResult = await editImageWithPrompt(currentImageData, editPrompt);

    // Log token usage for cover editing
    if (editResult?.usage) {
      log.debug(`📊 [COVER EDIT] Token usage - input: ${editResult.usage.inputTokens}, output: ${editResult.usage.outputTokens}, model: ${editResult.usage.model}`);
    }

    if (!editResult || !editResult.imageData) {
      return res.status(500).json({ error: 'Failed to edit cover - no result returned' });
    }

    // Evaluate the edited cover quality
    log.debug(`⭐ [COVER EDIT] Evaluating edited cover quality...`);
    let qualityScore = null;
    let qualityReasoning = null;
    try {
      const evaluation = await evaluateImageQuality(editResult.imageData, 'cover');
      if (evaluation) {
        qualityScore = evaluation.score;
        qualityReasoning = evaluation.reasoning;
        log.debug(`⭐ [COVER EDIT] Edited cover score: ${qualityScore}%`);
      } else {
        log.warn(`⚠️ [COVER EDIT] Quality evaluation returned null`);
      }
    } catch (evalErr) {
      log.error(`⚠️ [COVER EDIT] Quality evaluation failed:`, evalErr.message);
    }

    // --- Version management (same pattern as cover iterate endpoint) ---
    // Lazy-migrate imageVersions if missing
    if (!existingCover.imageVersions) {
      existingCover.imageVersions = [];
      if (existingCover.imageData) {
        existingCover.imageVersions.push({
          imageData: existingCover.imageData,
          qualityScore: existingCover.qualityScore,
          description: existingCover.description,
          createdAt: storyData.createdAt || new Date().toISOString(),
          type: 'original',
          isActive: false,
          _alreadySaved: true
        });
      }
      log.debug(`✏️ [COVER EDIT] Migrated legacy cover format to imageVersions[] (${existingCover.imageVersions.length} versions)`);
    }

    // Mark all existing versions as inactive
    existingCover.imageVersions.forEach(v => v.isActive = false);

    // Create new edit version entry
    const timestamp = new Date().toISOString();
    existingCover.imageVersions.push({
      imageData: editResult.imageData,
      description: existingCover.description,
      createdAt: timestamp,
      generatedAt: timestamp,
      isActive: true,
      type: 'edit',
      qualityScore: qualityScore ?? null,
      qualityReasoning: qualityReasoning || null,
      lastEditPrompt: editPrompt,
      _alreadySaved: true  // Will be saved explicitly below
    });

    // Update metadata on the cover object (in-place, no replacement)
    existingCover.wasEdited = true;
    existingCover.lastEditPrompt = editPrompt;
    existingCover.qualityScore = qualityScore;
    existingCover.qualityReasoning = qualityReasoning;
    existingCover.editedAt = new Date().toISOString();
    delete existingCover.imageData;

    // Query database for actual max version_index to avoid overwriting existing versions
    const maxVersionResult = await dbQuery(
      `SELECT COALESCE(MAX(version_index), -1) as max_version
       FROM story_images
       WHERE story_id = $1 AND image_type = $2 AND page_number IS NULL`,
      [id, coverKey]
    );
    const newVersionIndex = (maxVersionResult[0]?.max_version ?? -1) + 1;

    // Save the new cover image at the correct version_index
    await saveStoryImage(id, coverKey, null, editResult.imageData, {
      qualityScore,
      generatedAt: timestamp,
      versionIndex: newVersionIndex
    });
    await saveStoryData(id, storyData);
    await setActiveVersion(id, coverKey, newVersionIndex);

    log.info(`✅ Cover edited for story ${id}, type: ${normalizedCoverType} (new score: ${qualityScore})`);

    res.json({
      success: true,
      coverType: normalizedCoverType,
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning
    });

  } catch (err) {
    log.error('Error editing cover:', err);
    const isAdmin = req.user?.role === 'admin' || req.user?.impersonating;
    res.status(500).json({ error: isAdmin ? 'Failed to edit cover: ' + err.message : 'Failed to edit cover' });
  }
});

module.exports = router;
