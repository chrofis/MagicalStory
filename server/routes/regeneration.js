/**
 * Regeneration Routes — Extracted from server.js
 *
 * Contains all image/scene/cover regeneration, repair, and edit endpoints.
 * Mounted at /api/stories in server.js.
 */

const express = require('express');
const router = express.Router();
const pLimit = require('p-limit');

// Middleware
const { authenticateToken } = require('../middleware/auth');
const { imageRegenerationLimiter } = require('../middleware/rateLimit');

// Config
const { CREDIT_CONFIG, CREDIT_COSTS } = require('../config/credits');
const { calculateImageCost, formatCostSummary, MODEL_DEFAULTS, MODEL_PRICING } = require('../config/models');

// Services
const { log } = require('../utils/logger');
const { saveStoryData, rehydrateStoryImages, saveStoryImage, setActiveVersion, getPool, dbQuery } = require('../services/database');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

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
  stripSceneMetadata,
  extractCoverScenes,
  ART_STYLES
} = require('../lib/storyHelpers');
const {
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
  IMAGE_QUALITY_THRESHOLD
} = require('../lib/images');
const { callClaudeAPI } = require('../lib/textModels');
const {
  getVisualBibleEntriesForPage,
  getElementReferenceImagesForPage,
  buildFullVisualBiblePrompt
} = require('../lib/visualBible');
const { applyStyledAvatars } = require('../lib/styledAvatars');
const { runEntityConsistencyChecks } = require('../lib/entityConsistency');
const { getActiveIndexAfterPush } = require('../lib/versionManager');
const { hasPhotos: hasCharacterPhotos } = require('../lib/characterPhotos');

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
    const pageText = getPageText(storyData.storyText, pageNumber);
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
        const prevText = getPageText(storyData.storyText, prevPage);
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

    console.log(`✅ Scene description regenerated for story ${id}, page ${pageNumber}`);

    res.json({
      success: true,
      pageNumber,
      sceneDescription: newSceneDescription,
      translatedSummary,
      imageSummary
    });

  } catch (err) {
    log.error('Error regenerating scene description:', err);
    res.status(500).json({ error: 'Failed to regenerate scene description: ' + err.message });
  }
});

// Regenerate image for a specific page (costs credits)
router.post('/:id/regenerate/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { customPrompt, editedScene, characterIds } = req.body;
    const pageNumber = parseInt(pageNum);
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

    // Rehydrate images from story_images table (images may be stripped from data blob)
    storyData = await rehydrateStoryImages(id, storyData);

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
      console.log(`📝 [REGEN] SCENE EDITED for page ${pageNumber}:`);
      console.log(`   Original: ${originalDescription.substring(0, 100)}${originalDescription.length > 100 ? '...' : ''}`);
      console.log(`   New:      ${inputDescription.substring(0, 100)}${inputDescription.length > 100 ? '...' : ''}`);
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
        console.log(`📋 [REGEN] Found ${pageIssues.length} correction note(s) from evaluation for page ${pageNumber}`);
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
      console.log(`📝 [REGEN] Expanding scene using unified 3-step prompt (edited: ${sceneWasEdited}, corrections: ${hasCorrectionNotes}, length: ${inputDescription.length} chars)...`);
      // Use language code (e.g., 'de-ch', 'en') not name (e.g., 'English')
      const language = storyData.language || 'en';
      // Build context for scene description prompt (same as original generation)
      const pageText = getPageText(storyData.storyText, pageNumber);
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
        console.log(`✅ [REGEN] Scene expanded to ${expandedDescription.length} chars`);
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

    // Handle costumed:type format
    let effectiveClothing = clothingCategory;
    let costumeType = null;
    if (clothingCategory && clothingCategory.startsWith('costumed:')) {
      costumeType = clothingCategory.split(':')[1];
      effectiveClothing = 'costumed';
    }
    const artStyle = storyData.artStyle || 'pixar';
    // Use detailed photo info (with names) for labeled reference images
    let referencePhotos = getCharacterPhotoDetails(sceneCharacters, effectiveClothing, costumeType, artStyle, effectiveClothingRequirements);
    // Apply styled avatars for non-costumed characters
    if (effectiveClothing !== 'costumed') {
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
    let vbGrid = null;
    if (visualBible) {
      const elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
      const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
      if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
        vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
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
      console.log(`📝 [REGEN] PROMPT BUILT for page ${pageNumber}:`);
      console.log(`   Prompt length: ${imagePrompt.length} chars`);
    }

    // Clear the image cache for this prompt to force a new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    if (deleteFromImageCache(cacheKey)) {
      log.debug(`[REGEN] Cleared cache for page ${pageNumber} to force new generation`);
    }

    // Get the current image before regenerating (to store as previous version)
    let sceneImages = storyData.sceneImages || [];
    const existingImage = sceneImages.find(img => img.pageNumber === pageNumber);
    const previousImageData = existingImage?.imageData || null;
    const previousScore = existingImage?.qualityScore || null;
    const previousReasoning = existingImage?.qualityReasoning || null;
    const previousPrompt = existingImage?.prompt || null;
    // Keep the true original if this was already regenerated before
    const trueOriginalImage = existingImage?.originalImage || previousImageData;
    const trueOriginalScore = existingImage?.originalScore || previousScore;
    const trueOriginalReasoning = existingImage?.originalReasoning || previousReasoning;

    log.debug(`📸 [REGEN] Capturing previous image (${previousImageData ? 'has data' : 'none'}, score: ${previousScore}, already regenerated: ${!!existingImage?.originalImage})`);

    // Generate new image with labeled character photos (name + photoUrl)
    // Use quality retry to regenerate if score is below threshold
    // User-initiated regenerations use Gemini 3 Pro for higher quality
    const imageModelId = 'gemini-3-pro-image-preview';
    const imageResult = await generateImageWithQualityRetry(
      imagePrompt, referencePhotos, null, 'scene', null, null, null,
      { imageModel: imageModelId },
      `PAGE ${pageNumber}`,
      { landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata }
    );

    // Log API costs for this regeneration
    const imageCost = calculateImageCost(imageModelId, imageResult.totalAttempts || 1);
    console.log(`💰 [REGEN] API Cost: ${formatCostSummary(imageModelId, { imageCount: imageResult.totalAttempts || 1 }, imageCost)} (${imageResult.totalAttempts || 1} attempt(s))`);

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: expandedDescription,  // Store the full expanded scene description
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
      visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
      modelId: imageResult.modelId || null,
      regeneratedAt: new Date().toISOString(),
      regenerationCount: (existingImage?.regenerationCount || 0) + 1
    };

    log.debug(`📸 [REGEN] New image generated - score: ${imageResult.score}, attempts: ${imageResult.totalAttempts}, model: ${imageResult.modelId}`);

    // Initialize imageVersions if not present (migrate existing image as first version)
    if (existingImage && !existingImage.imageVersions) {
      existingImage.imageVersions = [{
        // Don't copy imageData — the original is already stored at DB version_index 0.
        description: existingImage.description || originalDescription,
        prompt: existingImage.prompt,
        modelId: existingImage.modelId,
        createdAt: storyData.createdAt || new Date().toISOString(),
        isActive: false,
        qualityScore: existingImage.qualityScore ?? null,
        qualityReasoning: existingImage.qualityReasoning || null,
        fixTargets: existingImage.fixTargets || [],
        fixableIssues: existingImage.fixableIssues || [],
        totalAttempts: existingImage.totalAttempts || null,
        referencePhotoNames: (existingImage.referencePhotos || []).map(p => ({
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

    // Update image prompts
    storyData.imagePrompts = storyData.imagePrompts || {};
    storyData.imagePrompts[pageNumber] = imagePrompt;

    // Save updated story with metadata
    storyData.sceneImages = sceneImages;
    await saveStoryData(id, storyData);

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
      console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, cost: ${creditCost} credits, remaining: ${newCredits})`);
    } else if (isImpersonating) {
      console.log(`✅ [IMPERSONATE] Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, FREE - admin impersonating)`);
    } else {
      console.log(`✅ Image regenerated for story ${id}, page ${pageNumber} (quality: ${imageResult.score}, unlimited credits)`);
    }

    // Get version info for response
    const updatedScene = sceneImages.find(s => s.pageNumber === pageNumber);
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
      // Only include imageData for latest versions to keep response small
      imageData: idx >= (updatedScene.imageVersions.length - 2) ? v.imageData : undefined
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
      prompt: imagePrompt,
      sceneWasEdited,
      sceneWasExpanded: shouldExpand,  // Flag if expansion was done
      // All image versions
      imageVersions: sceneImages.find(s => s.pageNumber === pageNumber)?.imageVersions || [],
      // Reference images used (for dev mode display)
      referencePhotos,
      landmarkPhotos: pageLandmarkPhotos,
      visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null
    });

  } catch (err) {
    log.error('Error regenerating image:', err);
    res.status(500).json({ error: 'Failed to regenerate image: ' + err.message });
  }
});

// Iterate image using 17-check scene description prompt with actual image analysis (DEV MODE ONLY)
// This endpoint analyzes the current image, feeds composition to the scene description prompt,
// runs the 17 validation checks, and regenerates with a corrected scene description
router.post('/:id/iterate/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { imageModel, useOriginalAsReference, blackoutIssues } = req.body;  // Optional: developer model override
    const pageNumber = parseInt(pageNum);
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
    const pageText = getPageText(storyData.storyText, pageNumber);
    if (!pageText) {
      return res.status(404).json({ error: `Page ${pageNumber} text not found` });
    }

    const language = storyData.language || 'en';
    const pageClothingData = storyData.pageClothing || null;

    // Build previous scenes context
    const previousScenes = [];
    for (let prevPage = pageNumber - 2; prevPage < pageNumber; prevPage++) {
      if (prevPage >= 1) {
        const prevText = getPageText(storyData.storyText, prevPage);
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
    log.info(`🔄 [ITERATE] Page ${pageNumber}: Running 17 validation checks with Claude...`);
    const sceneResult = await callClaudeAPI(scenePrompt, 10000, MODEL_DEFAULTS.sceneIteration, { prefill: '{"previewMismatches":[' });
    const newSceneDescription = sceneResult.text;

    // Parse the scene JSON to extract previewMismatches
    let previewMismatches = [];
    let checksRun = {};
    try {
      const sceneJson = JSON.parse(newSceneDescription);
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

    let effectiveClothing = clothingCategory;
    let costumeType = null;
    if (clothingCategory && clothingCategory.startsWith('costumed:')) {
      costumeType = clothingCategory.split(':')[1];
      effectiveClothing = 'costumed';
    }

    const artStyle = storyData.artStyle || 'pixar';
    let referencePhotos = getCharacterPhotoDetails(sceneCharacters, effectiveClothing, costumeType, artStyle, effectiveClothingRequirements);
    if (effectiveClothing !== 'costumed') {
      referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
    }

    // Build landmark photos and VB grid (newSceneMetadata already extracted above)
    const pageLandmarkPhotos = visualBible ? await getLandmarkPhotosForScene(visualBible, newSceneMetadata) : [];

    let vbGrid = null;
    if (visualBible) {
      const elementReferences = getElementReferenceImagesForPage(visualBible, pageNumber, 6);
      const secondaryLandmarks = pageLandmarkPhotos.slice(1);
      if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
        vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
      }
    }

    // Build image prompt
    const imagePrompt = buildImagePrompt(newSceneDescription, storyData, sceneCharacters, false, visualBible, pageNumber, true, referencePhotos);

    // Clear cache to force new generation
    const cacheKey = generateImageCacheKey(imagePrompt, referencePhotos.map(p => p.photoUrl), null);
    deleteFromImageCache(cacheKey);

    // Store previous image data
    const previousImageData = currentImage.imageData;
    const previousScore = currentImage.qualityScore || null;

    // Generate new image - use developer model override if provided, otherwise use default
    const imageModelOverride = imageModel || null;  // null means use default (gemini-2.5-flash-image for scenes)
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
    const imageResult = await generateImageWithQualityRetry(
      imagePrompt, referencePhotos, previousImage, 'scene', null, null, null,
      { imageModel: imageModelOverride },
      `PAGE ${pageNumber} ITERATE`,
      { landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, sceneCharacterCount: sceneCharacters.length, sceneCharacters, sceneMetadata: iterateSceneMetadata }
    );

    log.info(`🔄 [ITERATE] Page ${pageNumber}: New image generated (score: ${imageResult.score}, attempts: ${imageResult.totalAttempts})`);

    // Step 7: Update the image in story data
    const existingImageIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);

    const newImageData = {
      pageNumber,
      imageData: imageResult.imageData,
      description: newSceneDescription,
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
      visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
      modelId: imageResult.modelId || null,
      iterationCount: (currentImage.iterationCount || 0) + 1
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

    // Save updated story
    storyData.sceneImages = sceneImages;
    storyData.sceneDescriptions = sceneDescriptions;
    await saveStoryData(id, storyData);

    // Update active version in metadata
    const scene = sceneImages.find(s => s.pageNumber === pageNumber);
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

    // Get the updated image versions (without imageData to reduce response size)
    const updatedScene = sceneImages.find(img => img.pageNumber === pageNumber);
    const imageVersions = updatedScene?.imageVersions?.map((v, idx) => ({
      description: v.description,
      prompt: v.prompt,
      modelId: v.modelId,
      createdAt: v.createdAt,
      isActive: v.isActive,
      type: v.type,
      qualityScore: v.qualityScore,
      // Only include imageData for latest versions to keep response small
      imageData: idx >= (updatedScene.imageVersions.length - 2) ? v.imageData : undefined
    })) || [];

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
      visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
      message: previewMismatches.length > 0
        ? `Found ${previewMismatches.length} mismatch(es), regenerated with corrections`
        : 'No mismatches found, regenerated with fresh analysis'
    });

  } catch (err) {
    log.error('Error iterating image:', err);
    res.status(500).json({ error: 'Failed to iterate image: ' + err.message });
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

    // Get art style
    const artStyleId = storyData.artStyle || 'pixar';
    const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

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

    // Extract cover scenes with clothing info
    const coverScenes = extractCoverScenes(storyData.outline || '');
    // Use edited title/dedication if provided, otherwise use story data
    const storyTitle = editedTitle !== undefined ? editedTitle : (storyData.title || 'My Story');
    const coverDedication = editedDedication !== undefined ? editedDedication : storyData.dedication;

    // Determine scene description and clothing for this cover type
    let sceneDescription;
    let coverClothing;
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

    // Override scene description with user-provided edit (like regular image regeneration)
    if (editedScene && editedScene.trim()) {
      log.debug(`📕 [COVER REGEN] Using user-provided scene description: "${editedScene.substring(0, 100)}..."`);
      sceneDescription = editedScene.trim();
    }

    // Handle costumed:type format
    let effectiveCoverClothing = coverClothing;
    let coverCostumeType = null;
    if (coverClothing && coverClothing.startsWith('costumed:')) {
      coverCostumeType = coverClothing.split(':')[1];
      effectiveCoverClothing = 'costumed';
    }
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
      let selectedCharacters = mergedCharacters.filter(c => characterIds.includes(c.id));
      if (selectedCharacters.length > MAX_COVER_CHARACTERS) {
        log.info(`📕 [COVER REGEN] Capping selected characters from ${selectedCharacters.length} to ${MAX_COVER_CHARACTERS}`);
        selectedCharacters = selectedCharacters.slice(0, MAX_COVER_CHARACTERS);
      }
      coverCharacterPhotos = getCharacterPhotoDetails(selectedCharacters, effectiveCoverClothing, coverCostumeType, artStyleId, clothingRequirements);
      log.debug(`📕 [COVER REGEN] ${normalizedCoverType}: SELECTED ${selectedCharacters.map(c => c.name).join(', ')} (${coverCharacterPhotos.length} chars), clothing: ${coverClothing}`);
    } else if (normalizedCoverType === 'front') {
      // Front cover: main characters only (capped)
      let charactersToUse = mainChars.length > 0 ? mainChars : mergedCharacters;
      if (charactersToUse.length > MAX_COVER_CHARACTERS) {
        log.info(`📕 [COVER REGEN] Capping front cover characters from ${charactersToUse.length} to ${MAX_COVER_CHARACTERS}`);
        charactersToUse = charactersToUse.slice(0, MAX_COVER_CHARACTERS);
      }
      coverCharacterPhotos = getCharacterPhotoDetails(charactersToUse, effectiveCoverClothing, coverCostumeType, artStyleId, clothingRequirements);
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
      const coverChars = [...mainCapped, ...extras];
      coverCharacterPhotos = getCharacterPhotoDetails(coverChars, effectiveCoverClothing, coverCostumeType, artStyleId, clothingRequirements);
      log.debug(`📕 [COVER REGEN] ${normalizedCoverType}: ${coverChars.map(c => c.name).join(', ')} (${coverCharacterPhotos.length} chars), clothing: ${coverClothing}`);
    }
    // Apply styled avatars for non-costumed characters
    if (effectiveCoverClothing !== 'costumed') {
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
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' : normalizedCoverType === 'initialPage' ? 'initialPage' : 'backCover';
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
    // User-initiated regenerations use Gemini 3 Pro for higher quality
    const coverLabel = normalizedCoverType === 'front' ? 'FRONT COVER' : normalizedCoverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
    const coverImageModelId = 'gemini-3-pro-image-preview';
    const coverResult = await generateImageWithQualityRetry(
      coverPrompt, coverCharacterPhotos, null, 'cover', null, null, null,
      { imageModel: coverImageModelId },
      coverLabel
    );

    // Log API costs for this cover regeneration
    const coverImageCost = calculateImageCost(coverImageModelId, coverResult.totalAttempts || 1);
    console.log(`💰 [COVER REGEN] API Cost: ${formatCostSummary(coverImageModelId, { imageCount: coverResult.totalAttempts || 1 }, coverImageCost)} (${coverResult.totalAttempts || 1} attempt(s))`);

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

    if (normalizedCoverType === 'front') {
      storyData.coverImages.frontCover = coverData;
    } else if (normalizedCoverType === 'initialPage') {
      storyData.coverImages.initialPage = coverData;
    } else {
      storyData.coverImages.backCover = coverData;
    }

    // Save new version to story_images table with incrementing version_index
    await saveStoryImage(id, coverKey, null, coverResult.imageData, {
      qualityScore: coverResult.score,
      generatedAt: new Date().toISOString(),
      versionIndex: newVersionIndex
    });

    // Update active version in image_version_meta (same mechanism as scenes)
    await setActiveVersion(id, coverKey, newVersionIndex);

    // Save updated story with metadata (imageData will be stripped by saveStoryData)
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
      console.log(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, credits: ${requiredCredits} used, ${newCredits} remaining)`);
    } else if (isImpersonating) {
      console.log(`✅ [IMPERSONATE] ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, FREE - admin impersonating)`);
    } else {
      console.log(`✅ ${normalizedCoverType} cover regenerated for story ${id} (score: ${coverResult.score}, unlimited credits)`);
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

  } catch (err) {
    log.error('Error regenerating cover:', err);
    res.status(500).json({ error: 'Failed to regenerate cover: ' + err.message });
  }
});

// Edit scene image with a user prompt
router.post('/:id/edit/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { editPrompt } = req.body;
    const pageNumber = parseInt(pageNum);

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

    // Update the image in story data
    const existingIndex = sceneImages.findIndex(img => img.pageNumber === pageNumber);
    if (existingIndex >= 0) {
      sceneImages[existingIndex] = {
        ...sceneImages[existingIndex],
        imageData: editResult.imageData,
        qualityScore,
        qualityReasoning,
        wasEdited: true,
        lastEditPrompt: editPrompt,
        originalImage: previousImageData,
        originalScore: previousScore,
        originalReasoning: previousReasoning,
        editedAt: new Date().toISOString()
      };
    }

    // Persist edited image directly to story_images (saveStoryData won't re-save v0)
    await saveStoryImage(id, 'scene', pageNumber, editResult.imageData, {
      qualityScore,
      versionIndex: 0
    });

    // Save updated story with metadata
    storyData.sceneImages = sceneImages;
    await saveStoryData(id, storyData);

    console.log(`✅ Image edited for story ${id}, page ${pageNumber} (new score: ${qualityScore})`);

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
    res.status(500).json({ error: 'Failed to edit image: ' + err.message });
  }
});

// Auto-repair image (detect and fix physics errors) - DEV ONLY
// Enhanced: supports multi-pass repair, stores evaluation data like automatic auto-repair
router.post('/:id/repair/image/:pageNum', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const pageNumber = parseInt(pageNum);
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
      sceneImages[sceneIndex] = {
        ...currentScene,
        imageData: currentImageData,
        wasAutoRepaired: anyRepaired || currentScene.wasAutoRepaired,
        retryHistory: [...currentScene.retryHistory, ...newRetryEntries],
        repairHistory: allRepairHistory,
        repairedAt: anyRepaired ? new Date().toISOString() : currentScene.repairedAt
      };

      // Persist repaired image directly to story_images (saveStoryData won't re-save v0)
      if (anyRepaired) {
        const lastEntry = newRetryEntries[newRetryEntries.length - 1];
        const repairScore = lastEntry?.postRepairScore || null;
        await saveStoryImage(id, 'scene', pageNumber, currentImageData, { qualityScore: repairScore, versionIndex: 0 });
      }

      // Save updated story
      storyData.sceneImages = sceneImages;
      await saveStoryData(id, storyData);

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
    res.status(500).json({ error: 'Failed to auto-repair image: ' + err.message });
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
      const { repairSinglePage } = require('../lib/entityConsistency');

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
        existingImage.imageVersions.push({
          imageData: update.imageData,
          description: existingImage.description,
          prompt: existingImage.prompt,
          modelId: 'gemini-2.0-flash-preview-image-generation',
          createdAt: new Date().toISOString(),
          isActive: true,
          type: 'entity-repair',
          entityRepairedFor: entityName,
          clothingCategory: repairResult.clothingCategory,
          qualityScore: null,
          qualityReasoning: null,
          fixTargets: [],
          totalAttempts: null,
        });

        // Keep preEntityRepairImage for backward compatibility
        if (!existingImage.preEntityRepairImage) {
          existingImage.preEntityRepairImage = existingImage.imageData;
        }
        // Delete rehydrated imageData to prevent saveStoryData from re-saving at version_index 0
        delete existingImage.imageData;
        existingImage.entityRepaired = true;
        existingImage.entityRepairedAt = new Date().toISOString();
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
      const { runEntityConsistencyChecks } = require('../lib/entityConsistency');
      entityReport = await runEntityConsistencyChecks(storyData, storyData.characters || [], {
        checkCharacters: true,
        checkObjects: false
      });
    }

    // Run the repair
    const { repairEntityConsistency } = require('../lib/entityConsistency');
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
        existingImage.imageVersions.push({
          imageData: update.imageData,
          description: existingImage.description,
          prompt: existingImage.prompt,
          modelId: 'gemini-2.0-flash-preview-image-generation',
          createdAt: new Date().toISOString(),
          isActive: true,
          type: 'entity-repair',
          entityRepairedFor: entityName,
          clothingCategory: update.clothingCategory
        });

        // Keep preEntityRepairImage for backward compatibility
        if (!existingImage.preEntityRepairImage) {
          existingImage.preEntityRepairImage = existingImage.imageData;
        }
        // Delete rehydrated imageData to prevent saveStoryData from re-saving at version_index 0
        delete existingImage.imageData;
        existingImage.entityRepaired = true;
        existingImage.entityRepairedAt = new Date().toISOString();
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
    res.status(500).json({ error: 'Failed to repair entity consistency: ' + err.message });
  }
});

// =============================================================================
// Repair Workflow Endpoints (Manual Multi-Step Repair)
// =============================================================================

// Step 1: Collect feedback from existing evaluation data
router.post('/:id/repair-workflow/collect-feedback', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

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

    const pages = {};
    let totalIssues = 0;

    // Process each scene image
    for (const scene of (storyData.sceneImages || [])) {
      const feedback = {
        pageNumber: scene.pageNumber,
        qualityScore: scene.qualityScore,
        fixableIssues: [],
        entityIssues: [],
        manualNotes: '',
        needsFullRedo: false
      };

      // Get fixable issues from retry history
      const latestRetry = scene.retryHistory?.slice(-1)[0];
      if (latestRetry?.postRepairEval?.fixableIssues) {
        feedback.fixableIssues = latestRetry.postRepairEval.fixableIssues;
      } else if (latestRetry?.preRepairEval?.fixableIssues) {
        feedback.fixableIssues = latestRetry.preRepairEval.fixableIssues;
      }

      // Fallback: read fixableIssues or fixTargets directly from scene (stored by generation and re-evaluate)
      if (feedback.fixableIssues.length === 0 && scene.fixableIssues?.length > 0) {
        feedback.fixableIssues = scene.fixableIssues;
      }
      if (feedback.fixableIssues.length === 0 && scene.fixTargets?.length > 0) {
        feedback.fixableIssues = scene.fixTargets.map(ft => ({
          issue: ft.description || ft.issue || 'Quality issue detected',
          severity: ft.severity || 'medium',
          bbox: ft.bbox || null
        }));
      }

      // Get entity issues from finalChecksReport
      if (storyData.finalChecksReport?.entity?.characters) {
        for (const [charName, charResult] of Object.entries(storyData.finalChecksReport.entity.characters)) {
          const charIssues = (charResult.issues || []).filter(i =>
            i.pagesToFix?.includes(scene.pageNumber) || i.pageNumber === scene.pageNumber
          );

          for (const issue of charIssues) {
            feedback.entityIssues.push({
              character: charName,
              issue: issue.description,
              severity: issue.severity
            });
          }
        }
      }

      totalIssues += feedback.fixableIssues.length + feedback.entityIssues.length;
      pages[scene.pageNumber] = feedback;
    }

    res.json({ pages, totalIssues });
  } catch (err) {
    log.error('Error collecting repair feedback:', err);
    res.status(500).json({ error: 'Failed to collect feedback: ' + err.message });
  }
});

// Step 3: Redo pages (complete regeneration via iterate)
router.post('/:id/repair-workflow/redo-pages', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { pageNumbers, useOriginalAsReference } = req.body;

    if (!pageNumbers || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
      return res.status(400).json({ error: 'pageNumbers array is required' });
    }

    log.info(`🔄 [REPAIR-WORKFLOW] Starting redo for pages ${pageNumbers.join(', ')} in story ${id}`);

    const pagesCompleted = [];
    const newVersions = {};

    // Process each page using the iterate endpoint logic
    for (const pageNumber of pageNumbers) {
      try {
        // Get current story data (refresh on each iteration)
        const storyResult = await getDbPool().query(
          'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );

        if (storyResult.rows.length === 0) {
          continue;
        }

        const story = storyResult.rows[0];
        let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

        // Rehydrate images from story_images table (images are stored separately)
        storyData = await rehydrateStoryImages(id, storyData);

        // Find the scene
        const sceneIndex = storyData.sceneImages?.findIndex(s => s.pageNumber === pageNumber);
        if (sceneIndex === -1) {
          log.warn(`Page ${pageNumber} not found in story ${id}`);
          continue;
        }

        const scene = storyData.sceneImages[sceneIndex];

        // Generate new image using existing iterate logic
        const { iteratePage } = require('../lib/images');
        const result = await iteratePage(scene.imageData, pageNumber, storyData, {
          useOriginalAsReference: !!useOriginalAsReference,
        });

        if (result.imageData) {
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
            imageData: result.imageData,
            description: result.newScene,
            prompt: result.imagePrompt,
            createdAt: new Date().toISOString(),
            isActive: true,
            type: 'iteration',
            qualityScore: result.score,
            qualityReasoning: result.reasoning || null,
            fixTargets: result.fixTargets || [],
            fixableIssues: result.fixableIssues || [],
            totalAttempts: result.totalAttempts || null,
          });

          // Mark all other versions as inactive
          scene.imageVersions.forEach((v, i) => {
            v.isActive = i === newVersionIndex;
          });

          // Update scene metadata (but NOT imageData - that would cause duplicate image storage)
          // The new image is stored in imageVersions and activeVersion meta points to it
          scene.description = result.newScene;
          scene.prompt = result.imagePrompt;
          scene.qualityScore = result.score;
          // Delete rehydrated imageData to prevent saveStoryData from re-saving it at version_index 0
          delete scene.imageData;

          storyData.sceneImages[sceneIndex] = scene;

          // Save story (this saves images from imageVersions to story_images)
          await saveStoryData(id, storyData);

          // Set active version to the new image
          await setActiveVersion(id, pageNumber, getActiveIndexAfterPush(scene.imageVersions, 'scene'));

          pagesCompleted.push(pageNumber);
          newVersions[pageNumber] = newVersionIndex;
        }
      } catch (pageErr) {
        log.error(`Error redoing page ${pageNumber}:`, pageErr);
      }
    }

    log.info(`✅ [REPAIR-WORKFLOW] Redo complete: ${pagesCompleted.length}/${pageNumbers.length} pages`);
    res.json({ pagesCompleted, newVersions });
  } catch (err) {
    log.error('Error in redo pages:', err);
    res.status(500).json({ error: 'Failed to redo pages: ' + err.message });
  }
});

// Step 4: Re-evaluate pages
router.post('/:id/repair-workflow/re-evaluate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { pageNumbers } = req.body;

    if (!pageNumbers || !Array.isArray(pageNumbers) || pageNumbers.length === 0) {
      return res.status(400).json({ error: 'pageNumbers array is required' });
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
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    // Rehydrate images from story_images table (they're stripped from JSON on save)
    await rehydrateStoryImages(id, storyData);

    const pages = {};

    // Get character photos for reference images
    const characters = storyData.characters || [];
    const characterPhotos = characters
      .filter(c => c.photoUrl || c.avatars?.styled)
      .map(c => ({
        name: c.name,
        photoUrl: c.avatars?.styled || c.photoUrl
      }));

    // Helper to extract page text from story
    const getPageText = (storyText, pageNum) => {
      if (!storyText) return null;
      const pageRegex = new RegExp(`---\\s*Page\\s*${pageNum}\\s*---([\\s\\S]*?)(?=---\\s*Page|$)`, 'i');
      const match = storyText.match(pageRegex);
      return match ? match[1].trim() : null;
    };

    // Run evaluations in parallel with concurrency limit
    // Each page makes 2 API calls (quality + semantic), so limit to 5 pages = 10 concurrent calls
    const evalLimit = pLimit(5);
    const fullStoryText = storyData.storyText || storyData.generatedStory || storyData.story || '';

    await Promise.all(pageNumbers.map(pageNumber => evalLimit(async () => {
      const scene = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
      if (!scene) return;

      try {
        // Get image data - check active version first, then fallback to scene.imageData
        let imageData = scene.imageData;
        if (scene.imageVersions?.length > 0) {
          const activeVersion = scene.imageVersions.find(v => v.isActive);
          if (activeVersion?.imageData) {
            imageData = activeVersion.imageData;
          }
        }

        if (!imageData || !imageData.startsWith('data:image/')) {
          log.warn(`[REPAIR-WORKFLOW] Page ${pageNumber} has no valid image data, skipping`);
          pages[pageNumber] = {
            qualityScore: null,
            fixableIssues: [],
            error: 'No valid image data'
          };
          return;
        }

        // Get page text for semantic fidelity check
        const pageText = getPageText(fullStoryText, pageNumber) || scene.text || null;

        // Get scene hint (most direct statement of what image should show)
        const sceneHint = scene.outlineExtract || scene.sceneHint || null;

        // Run evaluation with full parameters including storyText for semantic check
        const evaluation = await evaluateImageQuality(
          imageData,
          scene.description,       // originalPrompt
          characterPhotos,         // referenceImages
          'scene',                 // evaluationType
          null,                    // qualityModelOverride
          `PAGE ${pageNumber}`,    // pageContext
          pageText,                // storyText for semantic fidelity
          sceneHint                // sceneHint for semantic evaluation
        );

        if (!evaluation) {
          log.warn(`[REPAIR-WORKFLOW] Page ${pageNumber} evaluation returned null`);
          pages[pageNumber] = {
            qualityScore: null,
            fixableIssues: [],
            error: 'Evaluation returned null'
          };
          return;
        }

        // Validate semantic evaluation ran when expected
        if (evaluation.semanticScore === null && sceneHint) {
          log.warn(`⚠️ [RE-EVALUATE] Page ${pageNumber}: Semantic evaluation failed despite sceneHint being available`);
        }

        // Log both scores for debugging
        const qualityPct = evaluation.qualityScore ?? evaluation.score;
        const semanticPct = evaluation.semanticScore ?? 100;
        log.info(`📊 [REPAIR-WORKFLOW] Page ${pageNumber} - Quality: ${qualityPct}, Semantic: ${semanticPct}, Final: ${evaluation.score}`);
        if (evaluation.issuesSummary) {
          log.info(`📊 [REPAIR-WORKFLOW] Page ${pageNumber} - issues: ${evaluation.issuesSummary}`);
        }

        // Update scene with new evaluation
        scene.qualityScore = evaluation.score;
        scene.qualityReasoning = evaluation.reasoning;
        scene.semanticScore = evaluation.semanticScore ?? null;
        scene.semanticResult = evaluation.semanticResult ?? null;
        scene.fixTargets = evaluation.fixTargets || evaluation.enrichedFixTargets || [];
        scene.fixableIssues = evaluation.fixableIssues || [];

        // Collect ALL issues for this page (quality eval + entity + imageChecks + retries)
        const allIssues = collectAllIssuesForPage(scene, storyData, pageNumber);

        // Run bbox enrichment if there are any issues
        if (allIssues.length > 0) {
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
          log.info(`🎯 [RE-EVALUATE] Page ${pageNumber} - bbox enrichment: ${scene.fixTargets.length} targets from ${allIssues.length} issues`);
        }

        // Store combined issues + bbox results on scene and active version
        scene.fixableIssues = allIssues;
        const activeVersion = scene.imageVersions?.find(v => v.isActive);
        if (activeVersion) {
          activeVersion.fixTargets = scene.fixTargets;
          activeVersion.fixableIssues = allIssues;
        }

        pages[pageNumber] = {
          score: evaluation.score,                    // Combined final score
          qualityScore: evaluation.qualityScore ?? evaluation.score,  // Visual quality only
          semanticScore: evaluation.semanticScore ?? null,            // Semantic fidelity only
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
        log.error(`❌ [RE-EVALUATE] Page ${pageNumber} evaluation failed:`, evalErr);
        pages[pageNumber] = {
          qualityScore: null,
          fixableIssues: [],
          error: evalErr.message
        };
      }
    })));

    // Save updated story
    await saveStoryData(id, storyData);

    // Calculate and persist repair cost
    let totalInput = 0, totalOutput = 0;
    for (const pageData of Object.values(pages)) {
      if (pageData.usage) {
        totalInput += pageData.usage.input_tokens || 0;
        totalOutput += pageData.usage.output_tokens || 0;
      }
    }
    const apiCost = calculateTokenCost('gemini-2.5-flash', totalInput, totalOutput);
    await addRepairCost(id, apiCost, 'Re-evaluate');

    log.info(`✅ [REPAIR-WORKFLOW] Re-evaluation complete for ${Object.keys(pages).length} pages`);
    res.json({ pages, apiCost });
  } catch (err) {
    log.error('❌ [RE-EVALUATE] Failed to re-evaluate pages:', err);
    res.status(500).json({ error: 'Failed to re-evaluate: ' + err.message });
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
    const { runEntityConsistencyChecks } = require('../lib/entityConsistency');
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

    await saveStoryData(id, storyData);

    // Calculate and persist repair cost
    const { inputTokens = 0, outputTokens = 0, model: checkModel } = report.tokenUsage || {};
    const apiCost = calculateTokenCost(checkModel || 'gemini-2.5-flash', inputTokens, outputTokens);
    await addRepairCost(id, apiCost, 'Consistency check');

    log.info(`✅ [REPAIR-WORKFLOW] Consistency check complete: ${report.totalIssues} issues found`);
    res.json({ report, apiCost });
  } catch (err) {
    log.error('Error in consistency check:', err);
    res.status(500).json({ error: 'Failed to run consistency check: ' + err.message });
  }
});

// Step 6: Repair characters using repairSinglePage or MagicAPI
router.post('/:id/repair-workflow/character-repair', authenticateToken, imageRegenerationLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { repairs, useMagicApiRepair } = req.body;

    if (!repairs || !Array.isArray(repairs) || repairs.length === 0) {
      return res.status(400).json({ error: 'repairs array is required' });
    }

    const repairMethod = useMagicApiRepair ? 'MagicAPI' : 'Gemini';
    log.info(`👤 [REPAIR-WORKFLOW] Starting character repair for story ${id} using ${repairMethod}`);

    const { repairSinglePage } = require('../lib/entityConsistency');
    const results = [];
    let totalGeminiRepairs = 0, totalMagicApiRepairs = 0;
    let totalVerifyTokensIn = 0, totalVerifyTokensOut = 0;

    for (const repair of repairs) {
      const { character: characterName, pages } = repair;

      try {
        // Get fresh story data for each character (in case previous repairs updated it)
        const storyResult = await getDbPool().query(
          'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
          [id, req.user.id]
        );

        if (storyResult.rows.length === 0) {
          results.push({ character: characterName, pagesRepaired: [], error: 'Story not found' });
          continue;
        }

        const story = storyResult.rows[0];
        let storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

        // Rehydrate images (required for entity appearance collection)
        storyData = await rehydrateStoryImages(id, storyData);

        // Find the character object
        let character = storyData.characters?.find(c => c.name === characterName);
        if (!character) {
          results.push({ character: characterName, pagesRepaired: [], error: `Character "${characterName}" not found` });
          continue;
        }

        // Check if character has usable avatar data - need styled standard or at least base standard
        const artStyle = storyData.artStyle || 'pixar';
        const hasStyledStandard = !!character.avatars?.styledAvatars?.[artStyle]?.standard;
        const hasBaseStandard = !!character.avatars?.standard;
        if (!hasStyledStandard && !hasBaseStandard) {
          log.info(`🔧 [REPAIR-WORKFLOW] Character ${characterName} missing standard avatar, fetching from database...`);
          try {
            // Get the character set ID from story data
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
                  // Merge avatar data from full character
                  character = { ...character, ...fullChar, avatars: fullChar.avatars || character.avatars };
                  log.info(`🔧 [REPAIR-WORKFLOW] Enriched ${characterName} with avatar data from character set`);
                }
              }
            }
          } catch (enrichErr) {
            log.warn(`[REPAIR-WORKFLOW] Failed to enrich character data: ${enrichErr.message}`);
          }
        }

        const pagesRepaired = [];
        const pagesFailed = [];

        // Get issues for this character from the consistency report
        const entityReport = storyData.finalChecksReport?.entity;
        const charIssues = entityReport?.characters?.[characterName]?.issues || [];
        if (charIssues.length > 0) {
          log.info(`🔧 [REPAIR-WORKFLOW] Found ${charIssues.length} consistency issues for ${characterName}`);
        }

        for (const pageNumber of pages) {
          try {
            log.info(`🔧 [REPAIR-WORKFLOW] Repairing ${characterName} on page ${pageNumber} with ${repairMethod}`);

            let repairResult;

            if (useMagicApiRepair) {
              // Use MagicAPI face swap + hair fix pipeline
              const { repairFaceWithMagicApi, isMagicApiConfigured } = require('../lib/magicApi');
              const { getStyledAvatarForClothing, collectEntityAppearances } = require('../lib/entityConsistency');

              if (!isMagicApiConfigured()) {
                log.warn(`[REPAIR-WORKFLOW] MagicAPI not configured, falling back to Gemini`);
                repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
              } else {
                // Get the scene image for this page
                const sceneImage = storyData.sceneImages?.find(s => s.pageNumber === pageNumber);
                if (!sceneImage || !sceneImage.imageData) {
                  log.warn(`[REPAIR-WORKFLOW] No scene image for page ${pageNumber}`);
                  pagesFailed.push({ pageNumber, reason: 'No scene image data for this page' });
                  continue;
                }

                // Get character appearance with bounding box
                const sceneDescriptions = storyData.sceneDescriptions || [];
                const entityAppearances = await collectEntityAppearances([sceneImage], [character], sceneDescriptions, { skipMinAppearancesFilter: true });
                const appearances = entityAppearances.get(characterName);
                const appearance = appearances?.find(a => a.pageNumber === pageNumber);

                if (!appearance?.faceBox && !appearance?.bodyBox) {
                  log.warn(`[REPAIR-WORKFLOW] No bounding box for ${characterName} on page ${pageNumber}`);
                  // Fall back to Gemini repair
                  repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
                } else {
                  // Get avatar for this character
                  const clothingCategory = appearance.clothing || 'standard';
                  const styledAvatar = getStyledAvatarForClothing(character, artStyle, clothingCategory);

                  if (!styledAvatar) {
                    log.warn(`[REPAIR-WORKFLOW] No avatar for ${characterName}, falling back to Gemini`);
                    repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
                  } else {
                    // Convert images to buffers
                    const sceneBuffer = Buffer.from(
                      sceneImage.imageData.replace(/^data:image\/\w+;base64,/, ''),
                      'base64'
                    );
                    const avatarBuffer = styledAvatar.startsWith('data:')
                      ? Buffer.from(styledAvatar.replace(/^data:image\/\w+;base64,/, ''), 'base64')
                      : Buffer.from(styledAvatar, 'base64');

                    // Get bounding box (prefer face box, fall back to body box)
                    const bbox = appearance.faceBox || appearance.bodyBox;

                    // Build hair config from character physical traits
                    const hairConfig = {
                      color: character.physical?.hairColor,
                      style: character.physical?.hairStyle || character.physical?.hairLength,
                      property: 'textured'
                    };

                    log.info(`[REPAIR-WORKFLOW] MagicAPI repair: bbox=${JSON.stringify(bbox)}, hair=${JSON.stringify(hairConfig)}`);

                    try {
                      // Call MagicAPI repair
                      const magicResult = await repairFaceWithMagicApi(sceneBuffer, avatarBuffer, bbox, hairConfig);

                      // Build comparison reference from avatar
                      const avatarDataUri = `data:image/png;base64,${avatarBuffer.toString('base64')}`;

                      if (magicResult.success && magicResult.repairedBuffer) {
                        // Convert result to base64 data URI
                        const repairedDataUri = `data:image/png;base64,${magicResult.repairedBuffer.toString('base64')}`;

                        // Extract bbox crop as "before" image for comparison
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
                          updatedImages: [{
                            pageNumber,
                            imageData: repairedDataUri
                          }],
                          method: 'magicapi',
                          clothingCategory,
                          cropHistory: magicResult.cropHistory,
                          comparison: {
                            before: beforeDataUri,
                            after: repairedDataUri,
                            reference: avatarDataUri,
                          },
                        };
                      } else {
                        log.error(`[REPAIR-WORKFLOW] MagicAPI returned no result for ${characterName} on page ${pageNumber}`);
                        pagesFailed.push({ pageNumber, reason: 'MagicAPI returned no result' });
                        continue;
                      }
                    } catch (magicErr) {
                      log.error(`[REPAIR-WORKFLOW] MagicAPI repair failed for ${characterName} on page ${pageNumber}: ${magicErr.message}`);
                      pagesFailed.push({ pageNumber, reason: `MagicAPI: ${magicErr.message}` });
                      continue;
                    }
                  }
                }
              }
            } else {
              // Use standard Gemini repair
              repairResult = await repairSinglePage(storyData, character, pageNumber, { issues: charIssues });
            }

            // Track repair cost: count attempts and accumulate verification tokens
            if (repairResult.method === 'magicapi') {
              totalMagicApiRepairs++;
            } else {
              totalGeminiRepairs++;
            }
            if (repairResult.usage) {
              totalVerifyTokensIn += repairResult.usage.promptTokenCount || 0;
              totalVerifyTokensOut += repairResult.usage.candidatesTokenCount || 0;
            }

            if (!repairResult.success) {
              const reason = repairResult.reason || repairResult.error || 'Unknown error';
              log.warn(`[REPAIR-WORKFLOW] Repair failed for ${characterName} on page ${pageNumber}: ${reason}`);
              pagesFailed.push({
                pageNumber,
                reason,
                rejected: repairResult.rejected || false,
                comparison: repairResult.comparison || null
              });
              continue;
            }

            // Apply updated image to story
            const sceneImages = storyData.sceneImages || [];
            for (const update of repairResult.updatedImages || []) {
              const sceneIndex = sceneImages.findIndex(img => img.pageNumber === update.pageNumber);
              if (sceneIndex >= 0) {
                const existingImage = sceneImages[sceneIndex];

                // Initialize imageVersions if not present
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
                  existingImage.imageVersions.forEach(v => v.isActive = false);
                }

                // Add new version
                const isMagicApiMethod = repairResult.method === 'magicapi';
                existingImage.imageVersions.push({
                  imageData: update.imageData,
                  description: existingImage.description,
                  prompt: existingImage.prompt,
                  modelId: isMagicApiMethod ? 'magicapi-faceswap-hair' : 'gemini-2.0-flash-preview-image-generation',
                  createdAt: new Date().toISOString(),
                  isActive: true,
                  type: 'entity-repair',
                  entityRepairedFor: characterName,
                  clothingCategory: repairResult.clothingCategory,
                  ...(isMagicApiMethod && repairResult.cropHistory && { cropHistory: repairResult.cropHistory })
                });

                // Delete rehydrated imageData to prevent saveStoryData from re-saving at version_index 0
                delete existingImage.imageData;
                existingImage.entityRepaired = true;
                existingImage.entityRepairedAt = new Date().toISOString();
                existingImage.entityRepairedFor = characterName;

                const newDbVersionIndex = getActiveIndexAfterPush(existingImage.imageVersions, 'scene');

                // Save the story data with updated sceneImages
                storyData.sceneImages = sceneImages;
                await saveStoryData(id, storyData);

                // Save the repaired image to story_images table with correct version index
                await saveStoryImage(id, 'scene', update.pageNumber, update.imageData, { versionIndex: newDbVersionIndex });

                // Set the new version as active
                await setActiveVersion(id, update.pageNumber, newDbVersionIndex);

                pagesRepaired.push({
                  pageNumber: update.pageNumber,
                  imageData: update.imageData,
                  versionIndex: newDbVersionIndex,
                  // Debug data for repair panel
                  comparison: repairResult.comparison || null,
                  verification: repairResult.verification || null,
                  method: repairResult.method || 'gemini',
                  cropHistory: repairResult.cropHistory || null,
                });
              }
            }

          } catch (pageErr) {
            log.error(`Error repairing ${characterName} on page ${pageNumber}:`, pageErr);
            pagesFailed.push({ pageNumber, reason: pageErr.message });
          }
        }

        results.push({ character: characterName, pagesRepaired, pagesFailed });
      } catch (repairErr) {
        log.error(`Error repairing character ${characterName}:`, repairErr);
        results.push({ character: characterName, pagesRepaired: [], pagesFailed: [], error: repairErr.message });
      }
    }

    // Calculate and persist repair cost (only Gemini repairs have per-image cost)
    const perImageCost = MODEL_PRICING['gemini-2.5-flash-image']?.perImage ?? 0.04;
    const imageGenCost = totalGeminiRepairs * perImageCost;
    const verifyTokenCost = calculateTokenCost('gemini-2.5-flash', totalVerifyTokensIn, totalVerifyTokensOut);
    const apiCost = imageGenCost + verifyTokenCost;
    const totalAttempts = totalGeminiRepairs + totalMagicApiRepairs;
    await addRepairCost(id, apiCost, `Character repair (${totalAttempts} attempts, ${totalGeminiRepairs} Gemini)`);

    log.info(`✅ [REPAIR-WORKFLOW] Character repair complete`);
    res.json({ results, apiCost });
  } catch (err) {
    log.error('Error in character repair:', err);
    res.status(500).json({ error: 'Failed to repair characters: ' + err.message });
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

    const pagesProcessed = [];
    let issuesFixed = 0;

    // Process each page with grid repair
    const { gridBasedRepair } = await import('./server/lib/images.js');

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
    res.status(500).json({ error: 'Failed to repair artifacts: ' + err.message });
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
    const storyData = typeof story.data === 'string'
      ? JSON.parse(story.data)
      : story.data;

    // Get the current cover image
    const coverImages = storyData.coverImages || {};
    const coverKey = normalizedCoverType === 'front' ? 'frontCover' :
                     normalizedCoverType === 'back' ? 'backCover' : 'initialPage';
    const currentCover = coverImages[coverKey];

    if (!currentCover) {
      return res.status(404).json({ error: 'No cover image found' });
    }

    // Get the image data (handle both string and object formats)
    const currentImageData = typeof currentCover === 'string' ? currentCover : currentCover.imageData;
    if (!currentImageData) {
      return res.status(404).json({ error: 'No cover image data found' });
    }

    // Capture previous image info before editing
    const previousImageData = currentImageData;
    const previousScore = typeof currentCover === 'object' ? currentCover.qualityScore || null : null;
    const previousReasoning = typeof currentCover === 'object' ? currentCover.qualityReasoning || null : null;
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

    // Update the cover image in story data
    const updatedCover = {
      imageData: editResult.imageData,
      qualityScore,
      qualityReasoning,
      wasEdited: true,
      lastEditPrompt: editPrompt,
      originalImage: previousImageData,
      originalScore: previousScore,
      originalReasoning: previousReasoning,
      editedAt: new Date().toISOString(),
      // Preserve other existing fields
      ...(typeof currentCover === 'object' ? {
        description: currentCover.description,
        prompt: currentCover.prompt
      } : {})
    };
    coverImages[coverKey] = updatedCover;

    // Persist edited cover image directly to story_images (saveStoryData won't re-save v0)
    await saveStoryImage(id, coverKey, null, editResult.imageData, {
      qualityScore,
      versionIndex: 0
    });

    // Save updated story with metadata
    storyData.coverImages = coverImages;
    await saveStoryData(id, storyData);

    console.log(`✅ Cover edited for story ${id}, type: ${normalizedCoverType} (new score: ${qualityScore})`);

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
    res.status(500).json({ error: 'Failed to edit cover: ' + err.message });
  }
});

module.exports = router;
