/**
 * Legacy Pipeline Functions — Archived from server.js
 *
 * Contains:
 * - processStorybookJob: Picture Book mode (combined text+scene generation)
 * - processOutlineAndTextJob: Outline+Text mode (separate outline + text generation)
 *
 * These are legacy generation modes, kept for backwards compatibility.
 * The primary mode is "unified" (processUnifiedStoryJob in server.js).
 *
 * Dependencies are received via init() for server.js-local items,
 * and require()'d directly for modular services.
 */

// --- Module imports (same as server.js) ---
const { CREDIT_CONFIG } = require('../config/credits');
const pLimit = require('p-limit');
const { getActiveIndexAfterPush } = require('./versionManager');
const { GenerationLogger } = require('./generationLogger');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const {
  generateImageWithQualityRetry,
  runFinalConsistencyChecks,
  generateReferenceSheet,
  buildVisualBibleGrid,
  IMAGE_QUALITY_THRESHOLD,
  generateImageOnly,
  evaluateImageBatch,
  buildRepairPlan,
  executeRepairPlan,
  mergeRepairResults,
  detectAllBoundingBoxes,
  createBboxOverlayImage,
  autoRepairImage,
  autoRepairWithTargets
} = require('./images');
const { runEntityConsistencyChecks } = require('./entityConsistency');
const {
  prepareStyledAvatars,
  applyStyledAvatars,
  collectAvatarRequirements,
  clearStyledAvatarCache,
  getStyledAvatarCacheStats,
  exportStyledAvatarsForPersistence,
  getStyledAvatarGenerationLog,
  clearStyledAvatarGenerationLog
} = require('./styledAvatars');
const {
  getCostumedAvatarGenerationLog,
  clearCostumedAvatarGenerationLog
} = require('../routes/avatars');
const {
  TEXT_MODELS,
  MODEL_DEFAULTS,
  getActiveTextModel,
  calculateOptimalBatchSize,
  callTextModel,
  callTextModelStreaming,
  evaluateTextConsistency
} = require('./textModels');
const {
  MODEL_PRICING,
  calculateTextCost,
  calculateImageCost: calculateImageCostConfig,
  formatCostSummary
} = require('../config/models');
const {
  parseVisualBible,
  filterMainCharactersFromVisualBible,
  initializeVisualBibleMainCharacters,
  getVisualBibleEntriesForPage,
  buildFullVisualBiblePrompt,
  buildVisualBiblePrompt,
  analyzeVisualBibleElements,
  updateVisualBibleWithExtracted,
  getElementsNeedingAnalysis,
  formatVisualBibleForStoryText,
  parseNewVisualBibleEntries,
  mergeNewVisualBibleEntries,
  extractStoryTextFromOutput,
  linkPreDiscoveredLandmarks,
  injectHistoricalLocations,
  getElementReferenceImagesForPage
} = require('./visualBible');
const {
  prefetchLandmarkPhotos,
  loadLandmarkPhotoDescriptions,
  getLandmarkPhotoOnDemand
} = require('./landmarkPhotos');
const {
  ART_STYLES,
  getReadingLevel,
  getTokensPerPage,
  getCharactersInScene,
  parseClothingCategory,
  getCharacterPhotoDetails,
  buildCharacterPhysicalDescription,
  buildCharacterReferenceList,
  parseStoryPages,
  parseSceneDescriptions,
  extractShortSceneDescriptions,
  extractCoverScenes,
  extractPageClothing,
  buildBasePrompt,
  buildStoryPrompt,
  buildSceneDescriptionPrompt,
  buildImagePrompt,
  buildPreviousScenesContext,
  buildAvailableAvatarsForPrompt,
  getLandmarkPhotosForPage,
  getLandmarkPhotosForScene,
  extractSceneMetadata,
  stripSceneMetadata,
  getHistoricalLocations,
  convertClothingToCurrentFormat
} = require('./storyHelpers');
const { OutlineParser, ProgressiveUnifiedParser } = require('./outlineParser');
const { initializePool, saveStoryData, upsertStory, saveStoryImage, setActiveVersion, getPool } = require('../services/database');

// --- Server.js-local dependencies received via init() ---
let deps = {};

function init(serverDeps) {
  deps = serverDeps;
}

// Convenience accessors
function getDbPool() { return deps.dbPool || getPool(); }
function getLog() { return deps.log || console; }


// =============================================================================
// PROGRESSIVE STREAMING PARSERS (used by Picture Book mode)
// =============================================================================

/**
 * Progressive cover parser for streaming storybook generation
 * Detects Visual Bible and cover scenes as text streams in
 * and triggers callbacks to start cover image generation early
 */
class ProgressiveCoverParser {
  constructor(onVisualBibleComplete, onCoverSceneComplete, onClothingRequirementsComplete) {
    this.onVisualBibleComplete = onVisualBibleComplete;
    this.onCoverSceneComplete = onCoverSceneComplete;
    this.onClothingRequirementsComplete = onClothingRequirementsComplete;
    this.fullText = '';
    this.clothingRequirementsEmitted = false;
    this.visualBibleEmitted = false;
    this.emittedCovers = new Set();  // 'titlePage', 'initialPage', 'backCover'
  }

  /**
   * Process new text chunk and emit Visual Bible and cover scenes as they complete
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Check for Clothing Requirements completion
    // Clothing Requirements is complete when we see ---VISUAL BIBLE--- after ---CLOTHING REQUIREMENTS---
    if (!this.clothingRequirementsEmitted && fullText.includes('---CLOTHING REQUIREMENTS---') && fullText.includes('---VISUAL BIBLE---')) {
      const clothingMatch = fullText.match(/---CLOTHING REQUIREMENTS---\s*([\s\S]*?)(?=---VISUAL BIBLE---|$)/i);
      if (clothingMatch) {
        this.clothingRequirementsEmitted = true;
        const clothingSection = clothingMatch[1].trim();
        log.debug(`🌊 [STREAM-COVER] Clothing Requirements section complete (${clothingSection.length} chars)`);

        // Extract JSON from the section (may be wrapped in ```json ... ```)
        const jsonMatch = clothingSection.match(/```json\s*([\s\S]*?)```/i) ||
                          clothingSection.match(/\{[\s\S]*"clothingRequirements"[\s\S]*\}/);
        if (jsonMatch && this.onClothingRequirementsComplete) {
          try {
            const jsonStr = jsonMatch[1] || jsonMatch[0];
            const parsed = JSON.parse(jsonStr);
            log.debug(`👕 [STREAM-COVER] Parsed clothing requirements for ${Object.keys(parsed.clothingRequirements || parsed).length} characters`);
            this.onClothingRequirementsComplete(parsed.clothingRequirements || parsed);
          } catch (e) {
            log.error(`❌ [STREAM-COVER] Failed to parse clothing requirements JSON: ${e.message}`);
          }
        }
      }
    }

    // Check for Visual Bible completion
    // Visual Bible is complete when we see ---TITLE PAGE--- after ---VISUAL BIBLE---
    if (!this.visualBibleEmitted && fullText.includes('---VISUAL BIBLE---') && fullText.includes('---TITLE PAGE---')) {
      const visualBibleMatch = fullText.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---TITLE PAGE---|$)/i);
      if (visualBibleMatch) {
        this.visualBibleEmitted = true;
        const visualBibleSection = visualBibleMatch[1].trim();
        log.debug(`🌊 [STREAM-COVER] Visual Bible section complete (${visualBibleSection.length} chars)`);
        if (this.onVisualBibleComplete) {
          const parsedVB = parseVisualBible('## Visual Bible\n' + visualBibleSection);
          this.onVisualBibleComplete(parsedVB, visualBibleSection);
        }
      }
    }

    // Check for Title Page scene completion
    // Title Page is complete when we see ---INITIAL PAGE--- after ---TITLE PAGE---
    if (!this.emittedCovers.has('titlePage') && fullText.includes('---TITLE PAGE---') && fullText.includes('---INITIAL PAGE---')) {
      const titlePageMatch = fullText.match(/---TITLE PAGE---\s*([\s\S]*?)(?=---INITIAL PAGE---|$)/i);
      if (titlePageMatch) {
        const titlePageBlock = titlePageMatch[1];
        const sceneMatch = titlePageBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('titlePage');
          const scene = sceneMatch[1].trim();
          // Extract title from the streaming text for progressive display
          let extractedTitle = null;
          const titleMatch = fullText.match(/TITLE:\s*(.+)/i);
          if (titleMatch) {
            extractedTitle = titleMatch[1].trim();
          }
          log.debug(`🌊 [STREAM-COVER] Title Page scene complete: ${scene.substring(0, 80)}...${extractedTitle ? ` (title: ${extractedTitle})` : ''}`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('titlePage', scene, titlePageBlock, extractedTitle);
          }
        }
      }
    }

    // Check for Initial Page scene completion
    // Initial Page is complete when we see ---BACK COVER--- after ---INITIAL PAGE---
    if (!this.emittedCovers.has('initialPage') && fullText.includes('---INITIAL PAGE---') && fullText.includes('---BACK COVER---')) {
      const initialPageMatch = fullText.match(/---INITIAL PAGE---\s*([\s\S]*?)(?=---BACK COVER---|$)/i);
      if (initialPageMatch) {
        const initialPageBlock = initialPageMatch[1];
        const sceneMatch = initialPageBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('initialPage');
          const scene = sceneMatch[1].trim();
          log.debug(`🌊 [STREAM-COVER] Initial Page scene complete: ${scene.substring(0, 80)}...`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('initialPage', scene, initialPageBlock);
          }
        }
      }
    }

    // Check for Back Cover scene completion
    // Back Cover is complete when we see ---PAGE 1--- after ---BACK COVER---
    if (!this.emittedCovers.has('backCover') && fullText.includes('---BACK COVER---') && fullText.includes('---PAGE 1---')) {
      const backCoverMatch = fullText.match(/---BACK COVER---\s*([\s\S]*?)(?=---PAGE 1---|$)/i);
      if (backCoverMatch) {
        const backCoverBlock = backCoverMatch[1];
        const sceneMatch = backCoverBlock.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
        if (sceneMatch) {
          this.emittedCovers.add('backCover');
          const scene = sceneMatch[1].trim();
          log.debug(`🌊 [STREAM-COVER] Back Cover scene complete: ${scene.substring(0, 80)}...`);
          if (this.onCoverSceneComplete) {
            this.onCoverSceneComplete('backCover', scene, backCoverBlock);
          }
        }
      }
    }
  }

  /**
   * Check if all cover scenes have been emitted
   */
  allCoversEmitted() {
    return this.emittedCovers.size === 3;
  }
}

/**
 * Progressive scene parser for streaming story generation
 * Detects complete scenes as text streams in and triggers callbacks
 */
class ProgressiveSceneParser {
  constructor(onSceneComplete) {
    this.onSceneComplete = onSceneComplete;
    this.fullText = '';
    this.completedScenes = new Set();
    this.scenePattern = /---PAGE\s+(\d+)---\s*([\s\S]*?)(?=---PAGE\s+\d+---|---BACK COVER---|$)/gi;
  }

  /**
   * Process new text chunk and emit any newly completed scenes
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Find all complete scenes in the current text
    const matches = [...fullText.matchAll(this.scenePattern)];

    for (const match of matches) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      // Only emit if this scene hasn't been emitted yet and appears complete
      // A scene is complete if there's another scene after it or we've seen ---BACK COVER---
      const hasNextScene = fullText.includes(`---PAGE ${pageNum + 1}---`);
      const hasBackCover = fullText.includes('---BACK COVER---');
      const isComplete = hasNextScene || hasBackCover;

      if (isComplete && !this.completedScenes.has(pageNum)) {
        this.completedScenes.add(pageNum);

        // Extract TEXT and SCENE from the page content
        const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
        const sceneMatch = content.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);

        const pageText = textMatch ? textMatch[1].trim() : '';
        const sceneDesc = sceneMatch ? sceneMatch[1].trim() : '';

        log.debug(`🌊 [STREAM-PARSE] Scene ${pageNum} complete, emitting...`);

        if (this.onSceneComplete) {
          this.onSceneComplete({
            pageNumber: pageNum,
            text: pageText,
            sceneDescription: sceneDesc
          });
        }
      }
    }
  }

  /**
   * Get all parsed scenes (for final processing)
   */
  getAllScenes() {
    const scenes = [];
    const matches = [...this.fullText.matchAll(this.scenePattern)];

    for (const match of matches) {
      const pageNum = parseInt(match[1], 10);
      const content = match[2];

      const textMatch = content.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
      const sceneMatch = content.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);

      scenes.push({
        pageNumber: pageNum,
        text: textMatch ? textMatch[1].trim() : '',
        sceneDescription: sceneMatch ? sceneMatch[1].trim() : ''
      });
    }

    return scenes.sort((a, b) => a.pageNumber - b.pageNumber);
  }
}

/**
 * Progressive page parser for streaming normal story text generation
 * Detects complete pages as text streams in (format: "--- Page X ---")
 * and triggers callbacks to start image generation early
 */
class ProgressiveStoryPageParser {
  constructor(onPageComplete) {
    this.onPageComplete = onPageComplete;
    this.fullText = '';
    this.emittedPages = new Set();
    // Pattern matches "--- Page X ---" with flexible spacing
    this.pagePattern = /---\s*Page\s+(\d+)\s*---/gi;
  }

  /**
   * Process new text chunk and emit any newly completed pages
   * A page is complete when we see the start of the next page
   * @param {string} chunk - New text chunk
   * @param {string} fullText - Complete text so far
   */
  processChunk(chunk, fullText) {
    this.fullText = fullText;

    // Find all page markers in the text
    const markers = [];
    let match;
    const patternCopy = new RegExp(this.pagePattern.source, 'gi');
    while ((match = patternCopy.exec(fullText)) !== null) {
      markers.push({
        pageNumber: parseInt(match[1], 10),
        startIndex: match.index,
        markerEnd: match.index + match[0].length
      });
    }

    // For each page marker (except the last), extract and emit if not already done
    for (let i = 0; i < markers.length - 1; i++) {
      const current = markers[i];
      const next = markers[i + 1];
      const pageNum = current.pageNumber;

      if (!this.emittedPages.has(pageNum)) {
        // Extract content between this marker and the next
        const content = fullText.substring(current.markerEnd, next.startIndex).trim();

        if (content.length > 0) {
          this.emittedPages.add(pageNum);
          log.debug(`🌊 [STREAM-PAGE] Page ${pageNum} complete (${content.length} chars), emitting...`);

          if (this.onPageComplete) {
            this.onPageComplete({
              pageNumber: pageNum,
              content: content
            });
          }
        }
      }
    }
  }

  /**
   * Finalize parsing - emit the last page when stream ends
   * @param {string} fullText - Final complete text
   */
  finalize(fullText) {
    this.fullText = fullText;

    // Find the last page marker
    const markers = [];
    let match;
    const patternCopy = new RegExp(this.pagePattern.source, 'gi');
    while ((match = patternCopy.exec(fullText)) !== null) {
      markers.push({
        pageNumber: parseInt(match[1], 10),
        startIndex: match.index,
        markerEnd: match.index + match[0].length
      });
    }

    if (markers.length > 0) {
      const lastMarker = markers[markers.length - 1];
      const pageNum = lastMarker.pageNumber;

      if (!this.emittedPages.has(pageNum)) {
        // Extract content from last marker to end of text
        const content = fullText.substring(lastMarker.markerEnd).trim();

        if (content.length > 0) {
          this.emittedPages.add(pageNum);
          log.debug(`🌊 [STREAM-PAGE] Final page ${pageNum} complete (${content.length} chars), emitting...`);

          if (this.onPageComplete) {
            this.onPageComplete({
              pageNumber: pageNum,
              content: content
            });
          }
        }
      }
    }

    return this.emittedPages.size;
  }

  /**
   * Get set of emitted page numbers
   */
  getEmittedPages() {
    return new Set(this.emittedPages);
  }
}


// ============================================================================
// PICTURE BOOK GENERATION (Legacy)
// Combined text+scene in single prompt
// ============================================================================

async function processStorybookJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableAutoRepair = false, useGridRepair = true, enableFinalChecks = false, incrementalConsistencyConfig = null, checkOnlyMode = false, enableSceneValidation = false) {
  // Destructure server.js-local dependencies
  const { dbPool, log, saveCheckpoint, detectBboxOnCovers, buildCoverSceneImages, IMAGE_GEN_MODE } = deps;

  log.debug(`📖 [STORYBOOK] Starting picture book generation for job ${jobId}`);

  // Generation logger for tracking API usage and debugging
  const genLog = new GenerationLogger();
  genLog.setStage('outline');

  // Clear avatar generation logs for fresh tracking
  clearStyledAvatarGenerationLog();
  clearCostumedAvatarGenerationLog();

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    // By provider (for backwards compatibility) - includes thinking_tokens for Gemini 2.5
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    // Runware uses direct cost instead of tokens
    runware: { direct_cost: 0, calls: 0 },
    // By function (for detailed breakdown)
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Avatar generation tracking
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      // Consistency check tracking
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      // Scene rewrite tracking (when safety blocks trigger rewrites)
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Fallback pricing by provider (uses centralized MODEL_PRICING from server/config/models.js)
  // Note: gemini_image uses per-image pricing, not token pricing - see calculateImageCost
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  // Helper to calculate image generation cost (per-image pricing, not token-based)
  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) {
      return pricing.perImage * imageCount;
    }
    // Fallback to default Gemini image pricing
    return 0.04 * imageCount;
  };

  // Helper to add usage - now supports function-level tracking with model names, thinking tokens, and direct costs
  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      // Handle Runware (direct cost) vs token-based providers
      if (provider === 'runware') {
        tokenUsage.runware.direct_cost += usage.direct_cost || 0;
        tokenUsage.runware.calls += 1;
      } else {
        tokenUsage[provider].input_tokens += usage.input_tokens || 0;
        tokenUsage[provider].output_tokens += usage.output_tokens || 0;
        tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
        tokenUsage[provider].calls += 1;
      }
    }
    // Also track by function if specified
    if (functionName && tokenUsage.byFunction[functionName]) {
      const func = tokenUsage.byFunction[functionName];
      func.input_tokens += usage.input_tokens || 0;
      func.output_tokens += usage.output_tokens || 0;
      func.thinking_tokens += usage.thinking_tokens || 0;
      func.direct_cost = (func.direct_cost || 0) + (usage.direct_cost || 0);
      func.calls += 1;
      func.provider = provider; // Track actual provider used
      if (modelName) {
        func.models.add(modelName);
      }
    }
  };

  // Helper to calculate cost - uses model-specific pricing if available
  // Thinking tokens are billed at output rate for Gemini 2.5 models
  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    // Try model-specific pricing first, then fall back to provider pricing
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output; // Thinking billed at output rate
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  // For Picture Book: pages = scenes (each page has image + text)
  // inputData.pages is the actual print page count, which equals scene count in picture book mode
  const sceneCount = inputData.pages;

  try {
    // Build character descriptions
    const characterDescriptions = (inputData.characters || []).map(char => {
      const isMain = (inputData.mainCharacters || []).includes(char.id) ? ' (MAIN CHARACTER)' : '';
      let desc = `${char.name}${isMain} (${char.gender}, ${char.age} years old)`;
      const details = [];
      if (char.strengths && char.strengths.length > 0) {
        details.push(`Strengths: ${char.strengths.join(', ')}`);
      }
      if (char.weaknesses && char.weaknesses.length > 0) {
        details.push(`Weaknesses: ${char.weaknesses.join(', ')}`);
      }
      const specialDetails = char.traits?.specialDetails || char.specialDetails || char.special_details;
      if (specialDetails) {
        details.push(`Details: ${specialDetails}`);
      }
      if (details.length > 0) {
        desc += `: ${details.join(', ')}`;
      }
      return desc;
    }).join('\n');

    // Build relationship descriptions
    const relationshipDescriptions = Object.entries(inputData.relationships || {})
      .filter(([key, type]) => type !== 'Not Known to' && type !== 'kennt nicht' && type !== 'ne connaît pas')
      .map(([key, type]) => {
        const [char1Id, char2Id] = key.split('-').map(Number);
        const char1 = (inputData.characters || []).find(c => c.id === char1Id);
        const char2 = (inputData.characters || []).find(c => c.id === char2Id);
        return `${char1?.name} is ${type} ${char2?.name}`;
      }).join('\n');

    const storyTypeName = inputData.storyType || 'adventure';
    const middlePage = Math.ceil(sceneCount / 2);
    const lang = inputData.language || 'en';

    // Get language name, note, and instruction from centralized config
    const { getLanguageNameEnglish, getLanguageNote, getLanguageInstruction } = require('./languages');
    const languageName = getLanguageNameEnglish(lang);
    const languageNote = getLanguageNote(lang);
    const languageInstruction = getLanguageInstruction(lang);

    // Build list of main character names for Visual Bible exclusion
    const mainCharacterNames = (inputData.characters || []).map(c => c.name).join(', ');

    // Build the storybook combined prompt using template file
    const storybookPrompt = fillTemplate(PROMPT_TEMPLATES.storybookCombined, {
      TITLE: storyTypeName,
      AGE_FROM: inputData.ageFrom || 3,
      AGE_TO: inputData.ageTo || 8,
      PAGES: sceneCount,
      LANGUAGE: languageName,
      LANGUAGE_NOTE: languageNote,
      LANGUAGE_INSTRUCTION: languageInstruction,
      STORY_TYPE: storyTypeName,
      STORY_DETAILS: inputData.storyDetails || '',
      DEDICATION: inputData.dedication || '',
      CHARACTERS: characterDescriptions,
      RELATIONSHIPS: relationshipDescriptions || '',
      MIDDLE_PAGE: middlePage,
      MIDDLE_PAGE_PLUS_1: middlePage + 1,
      MAIN_CHARACTER_NAMES: mainCharacterNames || 'None'
    });

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Generating picture book story and scenes...', jobId]
    );

    // STREAMING APPROACH: Generate text with streaming, start image generation as scenes complete
    log.debug(`📖 [STORYBOOK] Calling Claude API with STREAMING for combined generation (${sceneCount} scenes)...`);
    log.debug(`📖 [STORYBOOK] Prompt length: ${storybookPrompt.length} chars`);

    let fullStoryText = '';
    let streamingTextModelId = null;  // Track which model was used for streaming text generation
    let streamingTextUsage = null;    // Track token usage for dev mode
    const allSceneDescriptions = [];  // Only story pages (1, 2, 3...), NOT cover pages
    const allImages = [];
    const imagePrompts = {};

    // Track image generation promises (started during streaming)
    const streamingImagePromises = [];
    const completedSceneNumbers = new Set();
    const imageGenMode = inputData.imageGenMode || IMAGE_GEN_MODE || 'parallel';
    const MAX_RETRIES = 2;

    // Rate limiter for parallel image generation during streaming
    const streamLimit = pLimit(3);  // Limit concurrent image generation during streaming

    // Track completed pages for partial results (text -> sceneText mapping)
    const pageTexts = {};

    // Helper function to generate image for a scene (used during streaming)
    const generateImageForScene = async (pageNum, sceneDesc, pageText = null, vBible = null) => {
      try {
        // DEBUG: Log available characters before filtering
        const allCharacters = inputData.characters || [];
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Total available characters: ${allCharacters.length}`);
        allCharacters.forEach(char => {
          const hasPhoto = char.photoUrl?.startsWith('data:image');
          const hasBody = char.bodyPhotoUrl?.startsWith('data:image');
          const hasBodyNoBg = char.bodyNoBgUrl?.startsWith('data:image');
          const hasClothing = char.clothingAvatars ? Object.keys(char.clothingAvatars).filter(k => char.clothingAvatars[k]?.startsWith('data:image')).join(',') : 'none';
          log.debug(`   - ${char.name}: face=${hasPhoto}, body=${hasBody}, bodyNoBg=${hasBodyNoBg}, clothing=[${hasClothing}]`);
        });

        const sceneCharacters = getCharactersInScene(sceneDesc, inputData.characters || []);
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Characters found in scene: ${sceneCharacters.map(c => c.name).join(', ') || 'NONE'}`);

        // Parse clothing category from scene description
        // Handle costumed:type format (e.g., "costumed:pirate")
        const clothingRaw = parseClothingCategory(sceneDesc) || 'standard';
        let clothingCategory = clothingRaw;
        let costumeType = null;
        if (clothingRaw.startsWith('costumed:')) {
          clothingCategory = 'costumed';
          costumeType = clothingRaw.split(':')[1];
        }
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Clothing category: ${clothingCategory}${costumeType ? ':' + costumeType : ''}`);

        // Use detailed photo info (with names) for labeled reference images
        // Pass artStyle and clothingRequirements for per-character costume lookup
        let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, costumeType, artStyle, streamingClothingRequirements);
        // Apply styled avatars for non-costumed characters (costumed already styled via getCharacterPhotoDetails)
        if (clothingCategory !== 'costumed') {
          referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
        }
        log.debug(`🔍 [DEBUG PAGE ${pageNum}] Reference photos selected: ${referencePhotos.map(p => `${p.name}:${p.photoType}:${p.photoHash}`).join(', ') || 'NONE'}`);

        // Get landmark photos for this page (fetched early so we can separate primary vs secondary)
        const pageLandmarkPhotos = vBible ? getLandmarkPhotosForPage(vBible, pageNum) : [];
        if (pageLandmarkPhotos.length > 0) {
          log.debug(`🌍 [STREAM-IMG] Page ${pageNum} has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => l.name).join(', ')}`);
        }

        // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
        // VB elements are NO LONGER added individually to referencePhotos
        let vbGrid = null;
        if (vBible) {
          const elementReferences = getElementReferenceImagesForPage(vBible, pageNum, 6);
          const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
          if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
            vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
            log.debug(`🔲 [STREAM-IMG] Page ${pageNum} VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
          }
          const relevantEntries = getVisualBibleEntriesForPage(vBible, pageNum);
          log.debug(`📸 [STREAM-IMG] Generating image for page ${pageNum} (${sceneCharacters.length} chars, ${relevantEntries.length} visual bible entries)...`);
        } else {
          log.debug(`📸 [STREAM-IMG] Generating image for page ${pageNum} (${sceneCharacters.length} characters)...`);
        }

        const imagePrompt = buildImagePrompt(sceneDesc, inputData, sceneCharacters, false, vBible, pageNum, true, referencePhotos); // isStorybook = true
        imagePrompts[pageNum] = imagePrompt;

        let imageResult = null;
        let retries = 0;
        const pageTextContent = pageText || pageTexts[pageNum] || '';

        // Callback for immediate display - saves image before quality evaluation completes
        const onImageReady = async (imgData, modelId) => {
          const partialData = {
            pageNumber: pageNum,
            imageData: imgData,
            description: sceneDesc,
            prompt: imagePrompt,
            text: pageTextContent,
            qualityScore: null,  // Not yet evaluated
            qualityReasoning: null,
            wasRegenerated: false,
            totalAttempts: 1,
            retryHistory: [],
            referencePhotos,
            modelId: modelId || null
          };
          await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
          log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
        };

        // Usage tracker for page images (5th param isInpaint distinguishes inpaint from generation)
        const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel, isInpaint = false) => {
          if (imgUsage) {
            // Detect provider from model name (Runware uses direct_cost, Gemini uses tokens)
            const isRunware = imgModel && imgModel.startsWith('runware:');
            const provider = isRunware ? 'runware' : 'gemini_image';
            const funcName = isInpaint ? 'inpaint' : 'page_images';
            addUsage(provider, imgUsage, funcName, imgModel);
          }
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
        };

        // Pass forceRepairThreshold if set
        const streamingIncrConfig = incrementalConsistencyConfig?.forceRepairThreshold != null
          ? { forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold }
          : null;

        while (retries <= MAX_RETRIES && !imageResult) {
          try {
            // Use quality retry with labeled character photos (name + photoUrl)
            // Pass vbGrid for combined reference (instead of individual VB element photos)
            const sceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
            imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker, null, sceneModelOverrides, `PAGE ${pageNum}`, { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, incrementalConsistency: streamingIncrConfig, sceneCharacters });
          } catch (error) {
            retries++;
            log.error(`❌ [STREAM-IMG] Page ${pageNum} attempt ${retries} failed:`, error.message);
            if (retries > MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          }
        }

        console.log(`✅ [STREAM-IMG] Page ${pageNum} image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

        // Track scene rewrite usage if a safety block triggered a rewrite
        if (imageResult?.rewriteUsage) {
          addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
        }

        const pageData = {
          pageNumber: pageNum,
          imageData: imageResult.imageData,
          description: sceneDesc,
          prompt: imagePrompt,
          text: pageTextContent,
          qualityScore: imageResult.score,
          qualityReasoning: imageResult.reasoning || null,
          qualityModelId: imageResult.qualityModelId || null,  // Model used for quality eval
          fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
          wasRegenerated: imageResult.wasRegenerated || false,
          totalAttempts: imageResult.totalAttempts || 1,
          retryHistory: imageResult.retryHistory || [],
          originalImage: imageResult.originalImage || null,
          originalScore: imageResult.originalScore || null,
          originalReasoning: imageResult.originalReasoning || null,
          referencePhotos,  // Dev mode: which character photos were used
          landmarkPhotos: pageLandmarkPhotos,  // Dev mode: which landmark photos were used
          visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,  // Dev mode: VB grid used
          modelId: imageResult.modelId || null
        };

        // Save final result with quality score (overwrites immediate save)
        await saveCheckpoint(jobId, 'partial_page', pageData, pageNum);
        log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

        return pageData;
      } catch (error) {
        log.error(`❌ [STREAM-IMG] Failed to generate image for page ${pageNum}:`, error.message);
        return {
          pageNumber: pageNum,
          imageData: null,
          description: sceneDesc,
          text: pageText || pageTexts[pageNum] || '',
          landmarkPhotos: pageLandmarkPhotos,  // Include even on error for debugging
          error: error.message
        };
      }
    };

    // Set up progressive scene parser to start image generation during streaming
    // DISABLED: Don't stream images in storybook mode - wait for Visual Bible to be parsed first
    // This ensures all images get Visual Bible entries for recurring elements
    const shouldStreamImages = false; // Was: !skipImages && imageGenMode === 'parallel'
    let scenesEmittedCount = 0;

    // Track cover image generation promises
    const streamingCoverPromises = [];
    let streamingVisualBible = null;
    let coverImages = { frontCover: null, initialPage: null, backCover: null };
    const coverPrompts = { front: null, initialPage: null, backCover: null };

    // Helper function to generate cover image during streaming
    const generateCoverImageDuringStream = async (coverType, sceneDescription, rawBlock = null, extractedTitle = null) => {
      if (skipImages) return null;

      try {
        // Extract clothing from block first (more reliable), fallback to parsing scene
        // Handle both simple (winter/summer/standard) and costumed:type formats
        let clothing = null;
        let costumeType = null;
        if (rawBlock) {
          const clothingMatch = rawBlock.match(/CLOTHING:\s*(winter|summer|standard|costumed(?::\w+)?)/i);
          if (clothingMatch) {
            clothing = clothingMatch[1].toLowerCase();
          }
        }
        if (!clothing) {
          clothing = parseClothingCategory(sceneDescription) || 'standard';
        }
        // Parse costumed:type format
        if (clothing && clothing.startsWith('costumed:')) {
          costumeType = clothing.split(':')[1];
          clothing = 'costumed';
        }

        // Get art style for avatar lookup
        const artStyleId = inputData.artStyle || 'pixar';

        // Convert streamingClothingRequirements to _currentClothing format
        // This ensures all characters use the story's costume (not 'standard' fallback)
        const convertedClothingRequirements = convertClothingToCurrentFormat(streamingClothingRequirements);

        // Determine character selection based on cover type
        // Cap at 5 characters max — more than 5 almost always produces bad results
        // Strategy: main characters appear on ALL covers, non-main are split across initial/back
        const MAX_COVER_CHARACTERS = 5;
        const allCharacters = inputData.characters || [];
        const mainCharacters = allCharacters.filter(c => c.isMainCharacter === true);
        // If no isMainCharacter flags, treat all as "extras" to split across covers
        const nonMainCharacters = mainCharacters.length > 0
          ? allCharacters.filter(c => !c.isMainCharacter)
          : allCharacters;
        let referencePhotos;

        if (coverType === 'titlePage') {
          // Front cover: main characters only (or all capped if none flagged)
          let charactersToUse = mainCharacters.length > 0 ? mainCharacters : allCharacters;
          if (charactersToUse.length > MAX_COVER_CHARACTERS) {
            log.info(`📕 [STREAM-COVER] Capping front cover characters from ${charactersToUse.length} to ${MAX_COVER_CHARACTERS}`);
            charactersToUse = charactersToUse.slice(0, MAX_COVER_CHARACTERS);
          }
          referencePhotos = getCharacterPhotoDetails(charactersToUse, clothing, costumeType, artStyleId, convertedClothingRequirements);
          log.debug(`📕 [STREAM-COVER] Generating front cover: ${mainCharacters.length > 0 ? 'MAIN: ' + mainCharacters.map(c => c.name).join(', ') : 'ALL (no main chars defined)'} (${referencePhotos.length} chars), clothing: ${clothing}${costumeType ? ':' + costumeType : ''}`);
        } else {
          // Initial page & back cover: main characters + different non-main extras
          // Split non-main into two halves so each cover shows different characters
          const mainCapped = mainCharacters.slice(0, MAX_COVER_CHARACTERS);
          const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
          const halfPoint = Math.ceil(nonMainCharacters.length / 2);
          let extras;
          if (coverType === 'initialPage') {
            extras = nonMainCharacters.slice(0, halfPoint).slice(0, extraSlots);
          } else {
            // backCover gets the second half
            extras = nonMainCharacters.slice(halfPoint).slice(0, extraSlots);
          }
          const coverCharacters = [...mainCapped, ...extras];
          referencePhotos = getCharacterPhotoDetails(coverCharacters, clothing, costumeType, artStyleId, convertedClothingRequirements);
          log.debug(`📕 [STREAM-COVER] Generating ${coverType}: ${coverCharacters.map(c => c.name).join(', ')} (${referencePhotos.length} chars), clothing: ${clothing}${costumeType ? ':' + costumeType : ''}`);
        }
        // Apply styled avatars for non-costumed characters
        if (clothing !== 'costumed') {
          referencePhotos = applyStyledAvatars(referencePhotos, artStyleId);
        }

        // Build the prompt
        let coverPrompt;
        const visualBibleText = streamingVisualBible ? buildFullVisualBiblePrompt(streamingVisualBible, { skipMainCharacters: true }) : '';
        const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

        if (coverType === 'titlePage') {
          // Use extracted title from Claude response, fallback to input title
          const storyTitleForCover = extractedTitle || inputData.title || 'My Story';
          log.debug(`📕 [STREAM-COVER] Using title for front cover: "${storyTitleForCover}"`);
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
            VISUAL_BIBLE: visualBibleText,
            STORY_TITLE: storyTitleForCover
          });
          coverPrompts.front = coverPrompt;
        } else if (coverType === 'initialPage') {
          coverPrompt = inputData.dedication && inputData.dedication.trim()
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
                VISUAL_BIBLE: visualBibleText,
                DEDICATION: inputData.dedication
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: sceneDescription,
                STYLE_DESCRIPTION: styleDescription,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
                VISUAL_BIBLE: visualBibleText
              });
          coverPrompts.initialPage = coverPrompt;
        } else if (coverType === 'backCover') {
          coverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: sceneDescription,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(referencePhotos, inputData.characters),
            VISUAL_BIBLE: visualBibleText
          });
          coverPrompts.backCover = coverPrompt;
        }

        // Usage tracker for streaming cover images
        const streamCoverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        // Generate the image (use coverImageModel for covers)
        const coverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
        const streamCoverLabel = coverType === 'front' ? 'FRONT COVER' : coverType === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
        const result = await generateImageWithQualityRetry(coverPrompt, referencePhotos, null, 'cover', null, streamCoverUsageTracker, null, coverModelOverrides, streamCoverLabel, { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });

        // Track scene rewrite usage if a safety block triggered a rewrite
        if (result?.rewriteUsage) {
          addUsage('anthropic', result.rewriteUsage, 'scene_rewrite');
        }

        const coverData = {
          imageData: result.imageData,
          description: sceneDescription,
          prompt: coverPrompt,
          qualityScore: result.score,
          qualityReasoning: result.reasoning || null,
          fixTargets: result.fixTargets || [],  // Bounding boxes for auto-repair
          wasRegenerated: result.wasRegenerated || false,
          totalAttempts: result.totalAttempts || 1,
          retryHistory: result.retryHistory || [],
          originalImage: result.originalImage || null,
          originalScore: result.originalScore || null,
          originalReasoning: result.originalReasoning || null,
          referencePhotos: referencePhotos,
          modelId: result.modelId || null
        };

        // Save partial cover checkpoint for progressive display
        const coverKey = coverType === 'titlePage' ? 'frontCover' : coverType;
        // Include title for frontCover so client can transition to story display immediately
        const checkpointData = { type: coverKey, ...coverData };
        if (coverType === 'titlePage' && extractedTitle) {
          checkpointData.storyTitle = extractedTitle;
        }
        await saveCheckpoint(jobId, 'partial_cover', checkpointData,
          coverType === 'titlePage' ? 0 : coverType === 'initialPage' ? 1 : 2);

        console.log(`✅ [STREAM-COVER] ${coverType} cover generated during streaming (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);

        return { type: coverKey, data: coverData };
      } catch (error) {
        log.error(`❌ [STREAM-COVER] Failed to generate ${coverType} cover:`, error.message);
        return null;
      }
    };

    // Set up cover parser to start cover image generation during streaming
    const shouldStreamCovers = !skipImages;

    // Track clothing requirements
    let streamingClothingRequirements = null;

    const coverParser = new ProgressiveCoverParser(
      // onVisualBibleComplete
      (parsedVB, rawSection) => {
        // Filter out main characters from secondary characters (safety net)
        streamingVisualBible = filterMainCharactersFromVisualBible(parsedVB, inputData.characters);
        // Initialize main characters from inputData.characters
        initializeVisualBibleMainCharacters(streamingVisualBible, inputData.characters);
        log.debug(`📖 [STREAM-COVER] Visual Bible ready for cover generation`);
      },
      // onCoverSceneComplete
      (coverType, sceneDescription, rawBlock, extractedTitle) => {
        if (shouldStreamCovers) {
          const coverPromise = streamLimit(() => generateCoverImageDuringStream(coverType, sceneDescription, rawBlock, extractedTitle));
          streamingCoverPromises.push(coverPromise);
        }
      },
      // onClothingRequirementsComplete
      async (clothingRequirements) => {
        streamingClothingRequirements = clothingRequirements;
        if (skipImages) return;

        // NOTE: Avatar generation removed from story processing.
        // Base avatars should already exist from character creation.
        // For costumed/signature avatars, use server/lib/storyAvatarGeneration.js if needed.

        const characters = inputData.characters || [];
        const reqCharCount = Object.keys(clothingRequirements).length;
        const expectedCharCount = characters.length;
        if (reqCharCount < expectedCharCount) {
          log.warn(`⚠️ [STORYBOOK] Clothing requirements incomplete: ${reqCharCount}/${expectedCharCount} characters`);
        } else {
          log.debug(`✅ [STORYBOOK] Clothing requirements complete: ${reqCharCount}/${expectedCharCount} characters`);
        }
      }
    );

    // Prepare styled avatars ONLY for clothing categories actually used in the story
    // This populates the cache so streaming images can use styled avatars
    if (artStyle !== 'realistic') {
      try {
        const basicRequirements = (inputData.characters || []).flatMap(char => {
          const charNameLower = char.name?.toLowerCase();
          // Find clothing requirements for this character (case-insensitive lookup)
          const charReqs = streamingClothingRequirements?.[char.name] ||
                           streamingClothingRequirements?.[charNameLower] ||
                           (streamingClothingRequirements && Object.entries(streamingClothingRequirements)
                             .find(([k]) => k.toLowerCase() === charNameLower)?.[1]);

          // Get categories with used=true, default to ['standard'] if no requirements
          let usedCategories = charReqs
            ? Object.entries(charReqs)
                .filter(([cat, config]) => config?.used)
                .map(([cat, config]) => cat === 'costumed' && config?.costume
                  ? `costumed:${config.costume}`
                  : cat)
            : ['standard'];

          // At minimum, always include 'standard' if no categories found
          if (usedCategories.length === 0) {
            usedCategories = ['standard'];
          }

          log.debug(`🔍 [STYLED AVATARS] ${char.name}: using categories [${usedCategories.join(', ')}]`);
          return usedCategories.map(cat => ({
            pageNumber: 'pre-stream',
            clothingCategory: cat,
            characterNames: [char.name]
          }));
        });
        await prepareStyledAvatars(inputData.characters || [], artStyle, basicRequirements, streamingClothingRequirements, addUsage);
        log.debug(`✅ [STORYBOOK] Pre-streaming styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
      } catch (error) {
        // Bug #14 fix: Include stack trace for better debugging
        log.warn(`⚠️ [STORYBOOK] Pre-streaming styled avatar prep failed: ${error.message}`);
        log.debug(`   Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`);
      }
    }

    const sceneParser = new ProgressiveSceneParser((completedScene) => {
      // Called when a scene is detected as complete during streaming
      const { pageNumber, text, sceneDescription } = completedScene;

      if (completedSceneNumbers.has(pageNumber)) return;  // Already processed
      completedSceneNumbers.add(pageNumber);
      scenesEmittedCount++;

      // Store the page text for later use
      pageTexts[pageNumber] = text;

      log.debug(`🌊 [STREAM] Scene ${pageNumber} complete during streaming (${scenesEmittedCount}/${sceneCount})`);

      // Start image generation immediately for this scene (only in parallel mode)
      // Pass the page text so it can be saved with the partial result
      if (shouldStreamImages && sceneDescription) {
        const imagePromise = streamLimit(() => generateImageForScene(pageNumber, sceneDescription, text));
        streamingImagePromises.push(imagePromise);
      }
    });

    let response;
    try {
      // Use streaming API call with progressive parsers
      // Pass textModel override if provided (e.g., gemini-2.5-flash)
      const textModelOverride = modelOverrides.textModel || null;
      const streamResult = await callTextModelStreaming(storybookPrompt, 16000, (chunk, fullText) => {
        // Process each chunk to detect complete scenes AND cover scenes
        coverParser.processChunk(chunk, fullText);
        sceneParser.processChunk(chunk, fullText);
      }, textModelOverride);
      response = streamResult.text;
      streamingTextModelId = streamResult.modelId || (textModelOverride ? textModelOverride : getActiveTextModel().modelId);
      streamingTextUsage = streamResult.usage || { input_tokens: 0, output_tokens: 0 };  // Save usage for dev mode
      addUsage('anthropic', streamResult.usage, 'story_text', streamingTextModelId);
      // Log time-to-first-token for performance monitoring
      if (streamResult.ttft) {
        console.log(`[TIMING] TTFT unified story: ${streamResult.ttft}ms`);
      }
      log.debug(`📖 [STORYBOOK] Streaming complete, received ${response?.length || 0} chars (model: ${streamingTextModelId})`);
      log.debug(`🌊 [STREAM] ${scenesEmittedCount} scenes detected during streaming, ${streamingImagePromises.length} page images started`);
      log.debug(`🌊 [STREAM] ${streamingCoverPromises.length} cover images started during streaming`);
    } catch (apiError) {
      log.error(`[STORYBOOK] Claude API streaming call failed:`, apiError.message);
      throw apiError;
    }

    // Wait for any cover images started during streaming
    if (streamingCoverPromises.length > 0) {
      log.debug(`⚡ [STORYBOOK] Waiting for ${streamingCoverPromises.length} cover images started during streaming...`);
      const coverResults = await Promise.all(streamingCoverPromises);
      coverResults.forEach(result => {
        if (result && result.type && result.data) {
          coverImages[result.type] = result.data;
        }
      });
      log.debug(`✅ [STORYBOOK] ${coverResults.filter(r => r).length} cover images complete from streaming`);
    }

    // Save checkpoint (include prompt, model, and usage for dev mode)
    await saveCheckpoint(jobId, 'storybook_combined', {
      response,
      rawResponse: response,
      outlinePrompt: storybookPrompt,
      outlineModelId: streamingTextModelId,
      outlineUsage: streamingTextUsage
    });

    // Extract title
    let storyTitle = inputData.title || 'My Picture Book';
    const titleMatch = response.match(/TITLE:\s*(.+)/i);
    if (titleMatch) {
      storyTitle = titleMatch[1].trim();
    }
    log.debug(`📖 [STORYBOOK] Extracted title: ${storyTitle}`);

    // Extract dedication if present
    let dedication = inputData.dedication || '';
    const dedicationMatch = response.match(/DEDICATION:\s*(.+)/i);
    if (dedicationMatch) {
      dedication = dedicationMatch[1].trim();
    }

    // Parse the response to extract text and scenes
    // Split by page markers but keep track of what's before PAGE 1 (title/dedication info)
    const pageSplitRegex = /---PAGE\s+(\d+)---/gi;
    const pageMatches = [...response.matchAll(pageSplitRegex)];

    // Extract COVER SCENES from response (Title Page, Initial Page, Back Cover)
    // These are used for cover image generation, NOT added to allSceneDescriptions
    const coverScenes = {
      titlePage: '',
      initialPage: '',
      backCover: ''
    };

    // Helper to extract clothing from a block (supports costumed:type format)
    const extractClothingFromBlock = (block) => {
      const clothingMatch = block.match(/CLOTHING:\s*(winter|summer|standard|costumed(?::\w+)?)/i);
      return clothingMatch ? clothingMatch[1].toLowerCase() : null;
    };

    // Extract TITLE PAGE scene (for front cover)
    const titlePageMatch = response.match(/---TITLE PAGE---\s*([\s\S]*?)(?=---(?:INITIAL PAGE|PAGE\s+\d+)---|$)/i);
    if (titlePageMatch) {
      const titlePageBlock = titlePageMatch[1];
      const sceneMatch = titlePageBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|---|$)/i);
      if (sceneMatch) {
        coverScenes.titlePage = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(titlePageBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Title Page: scene=${coverScenes.titlePage.scene.substring(0, 80)}..., clothing=${coverScenes.titlePage.clothing || 'not found'}`);
      }
    }

    // Extract INITIAL PAGE scene (for dedication/intro page)
    const initialPageMatch = response.match(/---INITIAL PAGE---\s*([\s\S]*?)(?=---VISUAL BIBLE---|---PAGE\s+\d+---|$)/i);
    if (initialPageMatch) {
      const initialPageBlock = initialPageMatch[1];
      const sceneMatch = initialPageBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|---|$)/i);
      if (sceneMatch) {
        coverScenes.initialPage = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(initialPageBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Initial Page: scene=${coverScenes.initialPage.scene.substring(0, 80)}..., clothing=${coverScenes.initialPage.clothing || 'not found'}`);
      }
    }

    // Extract VISUAL BIBLE section for recurring elements
    let visualBible = null;
    const visualBibleMatch = response.match(/---VISUAL BIBLE---\s*([\s\S]*?)(?=---PAGE\s+\d+---|$)/i);
    if (visualBibleMatch) {
      const visualBibleSection = visualBibleMatch[1];
      log.debug(`📖 [STORYBOOK] Visual Bible section found, length: ${visualBibleSection.length}`);
      log.debug(`📖 [STORYBOOK] Visual Bible raw content:\n${visualBibleSection.substring(0, 500)}...`);
      visualBible = parseVisualBible('## Visual Bible\n' + visualBibleSection);
      // Filter out main characters from secondary characters (safety net)
      visualBible = filterMainCharactersFromVisualBible(visualBible, inputData.characters);
      // Initialize main characters from inputData.characters with their style analysis
      // This populates visualBible.mainCharacters for the dev panel display
      initializeVisualBibleMainCharacters(visualBible, inputData.characters);
      // Inject historical locations with pre-fetched photos (for historical stories)
      if (inputData.storyCategory === 'historical' && inputData.storyTopic) {
        const historicalLocations = getHistoricalLocations(inputData.storyTopic);
        if (historicalLocations?.length > 0) {
          injectHistoricalLocations(visualBible, historicalLocations);
          log.info(`📍 [STORYBOOK] Injected ${historicalLocations.length} pre-fetched historical location(s)`);
        }
      }
      const totalEntries = (visualBible.secondaryCharacters?.length || 0) +
                          (visualBible.animals?.length || 0) +
                          (visualBible.artifacts?.length || 0) +
                          (visualBible.locations?.length || 0);
      log.debug(`📖 [STORYBOOK] Extracted Visual Bible: ${totalEntries} entries`);
      log.debug(`📖 [STORYBOOK] Visual Bible parsed:`, JSON.stringify(visualBible, null, 2).substring(0, 500));
    } else {
      log.debug(`📖 [STORYBOOK] No Visual Bible section found in response`);
    }

    // Extract BACK COVER scene
    const backCoverMatch = response.match(/---BACK COVER---\s*([\s\S]*?)$/i);
    if (backCoverMatch) {
      const backCoverBlock = backCoverMatch[1];
      const sceneMatch = backCoverBlock.match(/SCENE:\s*([\s\S]*?)(?=CLOTHING:|$)/i);
      if (sceneMatch) {
        coverScenes.backCover = {
          scene: sceneMatch[1].trim(),
          clothing: extractClothingFromBlock(backCoverBlock)
        };
        log.debug(`📖 [STORYBOOK] Extracted Back Cover: scene=${coverScenes.backCover.scene.substring(0, 80)}..., clothing=${coverScenes.backCover.clothing || 'not found'}`);
      }
    }

    log.debug(`📖 [STORYBOOK] Found ${pageMatches.length} page markers`);

    // Extract content for each page using the markers
    // Note: BACK COVER comes BEFORE pages in the prompt format, so no need to check for it
    for (let i = 0; i < pageMatches.length && i < sceneCount; i++) {
      const match = pageMatches[i];
      const pageNum = parseInt(match[1], 10); // Use the actual page number from the marker
      const startIndex = match.index + match[0].length;
      // End at next page or end of response
      const endIndex = pageMatches[i + 1] ? pageMatches[i + 1].index : response.length;
      const block = response.substring(startIndex, endIndex);

      // Extract TEXT section
      const textMatch = block.match(/TEXT:\s*([\s\S]*?)(?=SCENE:|$)/i);
      const pageText = textMatch ? textMatch[1].trim() : '';

      // Extract SCENE section (stop at any --- marker or end)
      const sceneMatch = block.match(/SCENE:\s*([\s\S]*?)(?=---|$)/i);
      const sceneDesc = sceneMatch ? sceneMatch[1].trim() : '';

      // Build story text with page markers
      fullStoryText += `--- Page ${pageNum} ---\n${pageText}\n\n`;

      // Build scene description (for scenes not already processed during streaming)
      allSceneDescriptions.push({
        pageNumber: pageNum,
        description: sceneDesc,
        textModelId: streamingTextModelId
      });

      log.debug(`📖 [STORYBOOK] Page ${pageNum}: ${pageText.substring(0, 50)}...`);
    }

    // Save story text checkpoint so client can display text while images generate
    const pageTextMap = {};
    allSceneDescriptions.forEach(scene => {
      // Extract text from fullStoryText for each page
      const pageMatch = fullStoryText.match(new RegExp(`--- Page ${scene.pageNumber} ---\\n([\\s\\S]*?)(?=--- Page \\d+ ---|$)`));
      pageTextMap[scene.pageNumber] = pageMatch ? pageMatch[1].trim() : '';
    });

    await saveCheckpoint(jobId, 'story_text', {
      title: storyTitle,
      dedication: dedication,
      pageTexts: pageTextMap,
      sceneDescriptions: allSceneDescriptions,
      totalPages: sceneCount
    });
    log.debug(`💾 [STORYBOOK] Saved story text checkpoint with ${Object.keys(pageTextMap).length} pages`);

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [30, `Story text complete. ${streamingImagePromises.length} images already generating...`, jobId]
    );

    // Get art style for styled avatar preparation
    const artStyle = inputData.artStyle || 'pixar';

    // Generate images if not skipped
    if (!skipImages) {
      // Note: imageGenMode and MAX_RETRIES already defined above for streaming
      log.debug(`🖼️  [STORYBOOK] Image generation mode: ${imageGenMode.toUpperCase()}`);

      // Prepare styled avatars (convert reference photos to target art style)
      // This is done once at the start to avoid repeated style conversion in each image
      if (artStyle !== 'realistic') {
        log.debug(`🎨 [STORYBOOK] Preparing styled avatars for ${artStyle} style...`);
        try {
          // Collect avatar requirements from all scenes
          const avatarRequirements = collectAvatarRequirements(
            allSceneDescriptions,
            inputData.characters || [],
            {}, // pageClothing - will parse from scene descriptions
            'standard',
            streamingClothingRequirements // Pass per-character clothing requirements
          );
          // Convert avatars in parallel (pass clothingRequirements for signature lookup)
          await prepareStyledAvatars(inputData.characters || [], artStyle, avatarRequirements, streamingClothingRequirements, addUsage);
          log.debug(`✅ [STORYBOOK] Styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
        } catch (error) {
          log.error(`⚠️ [STORYBOOK] Failed to prepare styled avatars, using original photos:`, error.message);
        }
      }

      // Generate reference images for secondary elements (recurring characters, artifacts, etc.)
      if (visualBible) {
        const styleDescription = ART_STYLES[artStyle] || ART_STYLES.pixar;
        try {
          const refResult = await generateReferenceSheet(visualBible, styleDescription, {
            minAppearances: 2,
            maxPerBatch: 4
          });
          if (refResult.generated > 0) {
            log.info(`🖼️ [STORYBOOK] Reference images ready: ${refResult.generated} generated for secondary elements`);
          }
        } catch (err) {
          log.warn(`⚠️ [STORYBOOK] Reference sheet generation failed: ${err.message}`);
        }
      }

      // Helper function to generate a single image (used for sequential mode)
      const generateImage = async (scene, idx, previousImage = null, isSequential = false, vBible = null, incrConfig = null) => {
        const pageNum = scene.pageNumber;
        try {
          // DEBUG: Log available characters before filtering
          const allChars = inputData.characters || [];
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Total characters: ${allChars.length}`);
          allChars.forEach(char => {
            const hasPhoto = char.photoUrl?.startsWith('data:image');
            const hasBody = char.bodyPhotoUrl?.startsWith('data:image');
            const hasBodyNoBg = char.bodyNoBgUrl?.startsWith('data:image');
            const hasClothing = char.clothingAvatars ? Object.keys(char.clothingAvatars).filter(k => char.clothingAvatars[k]?.startsWith('data:image')).join(',') : 'none';
            log.debug(`   - ${char.name}: face=${hasPhoto}, body=${hasBody}, bodyNoBg=${hasBodyNoBg}, clothing=[${hasClothing}]`);
          });

          // Detect which characters appear in this scene
          const sceneCharacters = getCharactersInScene(scene.description, inputData.characters || []);
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Characters found in scene: ${sceneCharacters.map(c => c.name).join(', ') || 'NONE'}`);

          // Parse clothing category from scene description
          // Handle costumed:type format (e.g., "costumed:pirate")
          const clothingRaw = parseClothingCategory(scene.description) || 'standard';
          let clothingCategory = clothingRaw;
          let costumeType = null;
          if (clothingRaw.startsWith('costumed:')) {
            clothingCategory = 'costumed';
            costumeType = clothingRaw.split(':')[1];
          }
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Clothing category: ${clothingCategory}${costumeType ? ':' + costumeType : ''}`);

          // Use detailed photo info (with names) for labeled reference images
          // Pass artStyle and clothingRequirements for per-character costume lookup
          let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, costumeType, artStyle, streamingClothingRequirements);
          log.debug(`🔍 [DEBUG STORYBOOK PAGE ${pageNum}] Reference photos: ${referencePhotos.map(p => `${p.name}:${p.photoType}:${p.photoHash}`).join(', ') || 'NONE'}`);

          // Apply styled avatars for non-costumed characters (costumed already styled via getCharacterPhotoDetails)
          if (clothingCategory !== 'costumed') {
            referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
          }

          // Get landmark photos for this page (fetched early so we can separate primary vs secondary)
          const pageLandmarkPhotos = vBible ? getLandmarkPhotosForPage(vBible, pageNum) : [];
          if (pageLandmarkPhotos.length > 0) {
            log.debug(`🌍 [STORYBOOK] Page ${pageNum} has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => l.name).join(', ')}`);
          }

          // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
          // VB elements are NO LONGER added individually to referencePhotos
          let vbGrid = null;
          if (vBible) {
            const elementReferences = getElementReferenceImagesForPage(vBible, pageNum, 6);
            const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
            if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
              vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
              log.debug(`🔲 [STORYBOOK] Page ${pageNum} VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
            }
            const relevantEntries = getVisualBibleEntriesForPage(vBible, pageNum);
            log.debug(`📸 [STORYBOOK] Generating image for page ${pageNum} (${sceneCharacters.length} chars, clothing: ${clothingCategory}, ${relevantEntries.length} visual bible entries)...`);
          } else {
            log.debug(`📸 [STORYBOOK] Generating image for page ${pageNum} (${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingCategory})...`);
          }

          // Build image prompt with only scene-specific characters and visual bible
          const imagePrompt = buildImagePrompt(scene.description, inputData, sceneCharacters, isSequential, vBible, pageNum, true, referencePhotos); // isStorybook = true
          imagePrompts[pageNum] = imagePrompt;

          // Usage tracker for page images (5th param isInpaint distinguishes inpaint from generation)
          const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel, isInpaint = false) => {
            if (imgUsage) {
              // Detect provider from model name (Runware uses direct_cost, Gemini uses tokens)
              const isRunware = imgModel && imgModel.startsWith('runware:');
              const provider = isRunware ? 'runware' : 'gemini_image';
              const funcName = isInpaint ? 'inpaint' : 'page_images';
              addUsage(provider, imgUsage, funcName, imgModel);
            }
            if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
          };

          let imageResult = null;
          let retries = 0;

          while (retries <= MAX_RETRIES && !imageResult) {
            try {
              // Pass labeled character photos (name + photoUrl)
              // In sequential mode, also pass previous image for consistency
              // Use quality retry to regenerate if score is below threshold
              // Pass vbGrid for combined reference (instead of individual VB element photos)
              const seqSceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
              // Add current page's characters to incremental consistency config
              const incrConfigWithCurrentChars = incrConfig ? {
                ...incrConfig,
                currentCharacters: sceneCharacters.map(c => c.name)
              } : null;
              imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, previousImage, 'scene', null, pageUsageTracker, null, seqSceneModelOverrides, `PAGE ${pageNum}`, { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, incrementalConsistency: incrConfigWithCurrentChars, sceneCharacters });
            } catch (error) {
              retries++;
              log.error(`❌ [STORYBOOK] Page ${pageNum} image attempt ${retries} failed:`, error.message);
              if (retries > MAX_RETRIES) throw error;
              await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
          }

          log.debug(`✅ [STORYBOOK] Page ${pageNum} image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

          // Track scene rewrite usage if a safety block triggered a rewrite
          if (imageResult?.rewriteUsage) {
            addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
          }

          // Update progress
          const progressPercent = 30 + Math.floor((idx + 1) / sceneCount * 50);
          await dbPool.query(
            'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [progressPercent, `Generated image ${idx + 1}/${sceneCount}...`, jobId]
          );

          // Build per-character clothing map (in storybook, all chars share same scene clothing)
          const perCharClothing = {};
          for (const char of sceneCharacters) {
            perCharClothing[char.name] = clothingRaw;  // e.g., "costumed:pirate" or "standard"
          }

          return {
            pageNumber: pageNum,
            imageData: imageResult.imageData,
            description: scene.description,
            prompt: imagePrompt,
            qualityScore: imageResult.score,
            qualityReasoning: imageResult.reasoning || null,
            qualityModelId: imageResult.qualityModelId || null,
            fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: imageResult.wasRegenerated || false,
            totalAttempts: imageResult.totalAttempts || 1,
            retryHistory: imageResult.retryHistory || [],
            originalImage: imageResult.originalImage || null,
            originalScore: imageResult.originalScore || null,
            originalReasoning: imageResult.originalReasoning || null,
            referencePhotos,
            landmarkPhotos: pageLandmarkPhotos,
            visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
            sceneCharacters,  // Include for incremental consistency tracking
            sceneCharacterClothing: perCharClothing  // Per-character clothing for this scene
          };
        } catch (error) {
          log.error(`❌ [STORYBOOK] Failed to generate image for page ${pageNum}:`, error.message);
          return {
            pageNumber: pageNum,
            imageData: null,
            description: scene.description,
            prompt: null,
            error: error.message,
            referencePhotos: [],
            landmarkPhotos: [],
            visualBibleGrid: null,
            sceneCharacters: [],
            sceneCharacterClothing: {}
          };
        }
      };

      // Use sequential mode for either explicit sequential setting or incremental consistency
      const useSequentialMode = imageGenMode === 'sequential' || incrementalConsistencyConfig?.enabled;

      if (useSequentialMode) {
        // SEQUENTIAL MODE: Generate images one at a time
        // Required for incremental consistency (comparing against previous images)
        const modeReason = incrementalConsistencyConfig?.enabled
          ? `incremental consistency (lookback: ${incrementalConsistencyConfig.lookbackCount})`
          : 'sequential image mode';
        console.log(`🔗 [STORYBOOK] Starting SEQUENTIAL image generation for ${allSceneDescriptions.length} scenes (${modeReason})...`);
        if (visualBible) {
          log.debug(`📖 [STORYBOOK] Using visual bible for image generation`);
        }
        let previousImage = null;
        const previousImagesForConsistency = [];

        for (let i = 0; i < allSceneDescriptions.length; i++) {
          const scene = allSceneDescriptions[i];
          const pageNum = scene.pageNumber;
          log.debug(`🔗 [STORYBOOK SEQUENTIAL ${i + 1}/${allSceneDescriptions.length}] Processing page ${pageNum}...`);

          // Build incremental consistency config with previous images
          let incrConfig = null;
          if (incrementalConsistencyConfig?.enabled && previousImagesForConsistency.length > 0) {
            const lookbackImages = previousImagesForConsistency.slice(-incrementalConsistencyConfig.lookbackCount);
            incrConfig = {
              enabled: true,
              dryRun: incrementalConsistencyConfig.dryRun,
              lookbackCount: incrementalConsistencyConfig.lookbackCount,
              previousImages: lookbackImages,
              forceRepairThreshold: incrementalConsistencyConfig?.forceRepairThreshold
            };
            log.debug(`🔍 [STORYBOOK] Page ${pageNum}: checking against ${lookbackImages.length} previous page(s)`);
          } else if (incrementalConsistencyConfig?.forceRepairThreshold != null) {
            // Even without incremental consistency, pass forceRepairThreshold if set
            incrConfig = { forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold };
          }

          const result = await generateImage(scene, i, previousImage, true, visualBible, incrConfig); // isSequential = true, with visual bible
          allImages.push(result);

          // Use this image as reference for next image
          if (result.imageData) {
            previousImage = result.imageData;

            // Track for incremental consistency
            if (incrementalConsistencyConfig?.enabled) {
              previousImagesForConsistency.push({
                imageData: result.imageData,
                pageNumber: pageNum,
                characters: (result.sceneCharacters || []).map(c => c.name),
                characterClothing: result.sceneCharacterClothing || {}
              });
            }
          }
        }

        log.debug(`🚀 [STORYBOOK] All ${allImages.length} images generated (SEQUENTIAL MODE)!`);
      } else {
        // PARALLEL MODE: Wait for streaming images first, then generate any missing scenes
        log.debug(`⚡ [STORYBOOK] Waiting for ${streamingImagePromises.length} images started during streaming...`);

        // Wait for all images that were started during streaming
        if (streamingImagePromises.length > 0) {
          const streamingResults = await Promise.all(streamingImagePromises);
          streamingResults.forEach(img => {
            if (img) allImages.push(img);
          });
          log.debug(`✅ [STORYBOOK] ${allImages.length} streaming images complete`);
        }

        // Find any scenes that weren't processed during streaming (last scene might be missed)
        const processedPages = new Set(allImages.map(img => img.pageNumber));
        const missingScenes = allSceneDescriptions.filter(scene => !processedPages.has(scene.pageNumber));

        if (missingScenes.length > 0) {
          log.debug(`⚡ [STORYBOOK] Generating ${missingScenes.length} remaining images...`);
          if (visualBible) {
            log.debug(`📖 [STORYBOOK] Using visual bible for remaining images`);
          }
          const limit = pLimit(5);

          const remainingPromises = missingScenes.map((scene) => {
            return limit(() => generateImageForScene(scene.pageNumber, scene.description, null, visualBible));
          });

          const remainingResults = await Promise.all(remainingPromises);
          remainingResults.forEach(img => {
            if (img) allImages.push(img);
          });
        }

        log.debug(`🚀 [STORYBOOK] All ${allImages.length} images generated (PARALLEL MODE with streaming)!`);
      }

      // Sort images by page number
      allImages.sort((a, b) => a.pageNumber - b.pageNumber);
    }

    // Count how many covers were already generated during streaming
    const coversFromStreaming = Object.values(coverImages).filter(c => c !== null).length;

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [85, coversFromStreaming > 0 ? `${coversFromStreaming} cover images ready. Generating remaining covers...` : 'Generating cover images...', jobId]
    );

    // Generate any cover images not generated during streaming
    if (!skipImages && !skipCovers) {
      try {
        const artStyleId = inputData.artStyle || 'pixar';
        const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

        // Use AI-generated cover scenes (or fallbacks) - handle both new format {scene, clothing} and legacy string
        const titlePageScene = coverScenes.titlePage?.scene || (typeof coverScenes.titlePage === 'string' ? coverScenes.titlePage : null) || `A beautiful, magical title page featuring the main characters. Decorative elements that reflect the story's theme with space for the title text.`;
        const initialPageScene = coverScenes.initialPage?.scene || (typeof coverScenes.initialPage === 'string' ? coverScenes.initialPage : null) || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
        const backCoverScene = coverScenes.backCover?.scene || (typeof coverScenes.backCover === 'string' ? coverScenes.backCover : null) || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

        // Build visual bible prompt for covers (shows recurring elements like pets, artifacts)
        const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true }) : '';

        // Usage tracker for cover images
        const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
          if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
          if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
        };

        // Front cover - only generate if not already done during streaming
        if (!coverImages.frontCover) {
          // Front cover: use only MAIN characters (isMainCharacter: true)
          const allCharacters = inputData.characters || [];
          const mainCharacters = allCharacters.filter(c => c.isMainCharacter === true);
          // Fallback to all characters if no main characters defined
          const frontCoverCharacters = mainCharacters.length > 0 ? mainCharacters : allCharacters;
          // Use extracted clothing or parse from scene description
          const frontCoverClothing = coverScenes.titlePage?.clothing || parseClothingCategory(titlePageScene) || 'standard';
          // Handle costumed:type format
          let frontCoverClothingCat = frontCoverClothing;
          let frontCoverCostumeType = null;
          if (frontCoverClothing.startsWith('costumed:')) {
            frontCoverCostumeType = frontCoverClothing.split(':')[1];
            frontCoverClothingCat = 'costumed';
          }
          // Use detailed photo info (with names) for labeled reference images
          // Convert clothingRequirements to _currentClothing format so all characters use story costumes
          const convertedFrontClothingReqs = convertClothingToCurrentFormat(streamingClothingRequirements);
          let frontCoverPhotos = getCharacterPhotoDetails(frontCoverCharacters, frontCoverClothingCat, frontCoverCostumeType, artStyleId, convertedFrontClothingReqs);
          // Apply styled avatars (pre-converted to target art style) for non-costumed
          if (frontCoverClothingCat !== 'costumed') {
            frontCoverPhotos = applyStyledAvatars(frontCoverPhotos, artStyle);
          }
          log.debug(`📕 [STORYBOOK] Front cover: ${mainCharacters.length > 0 ? 'MAIN: ' + mainCharacters.map(c => c.name).join(', ') : 'ALL (no main chars defined)'} (${frontCoverCharacters.length} chars), clothing: ${frontCoverClothing}`);

          const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
            TITLE_PAGE_SCENE: titlePageScene,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(frontCoverPhotos, frontCoverCharacters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.frontCover = frontCoverPrompt;
          const frontCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const frontCoverResult = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker, null, frontCoverModelOverrides, 'FRONT COVER', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          log.debug(`✅ [STORYBOOK] Front cover generated (score: ${frontCoverResult.score}${frontCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (frontCoverResult?.rewriteUsage) {
            addUsage('anthropic', frontCoverResult.rewriteUsage, 'scene_rewrite');
          }
          coverImages.frontCover = {
            imageData: frontCoverResult.imageData,
            description: titlePageScene,
            prompt: frontCoverPrompt,
            qualityScore: frontCoverResult.score,
            qualityReasoning: frontCoverResult.reasoning || null,
            fixTargets: frontCoverResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: frontCoverResult.wasRegenerated || false,
            totalAttempts: frontCoverResult.totalAttempts || 1,
            retryHistory: frontCoverResult.retryHistory || [],
            originalImage: frontCoverResult.originalImage || null,
            originalScore: frontCoverResult.originalScore || null,
            originalReasoning: frontCoverResult.originalReasoning || null,
            referencePhotos: frontCoverPhotos,
            modelId: frontCoverResult.modelId || null,
            bboxDetection: frontCoverResult.bboxDetection || null,
            bboxOverlayImage: frontCoverResult.bboxOverlayImage || null
          };
        } else {
          log.debug(`⚡ [STORYBOOK] Front cover already generated during streaming (skipping)`);
        }

        // Initial page - only generate if not already done during streaming
        if (!coverImages.initialPage) {
          // Use extracted clothing or parse from scene description
          const initialPageClothing = coverScenes.initialPage?.clothing || parseClothingCategory(initialPageScene) || 'standard';
          // Handle costumed:type format
          let initialClothingCat = initialPageClothing;
          let initialCostumeType = null;
          if (initialPageClothing.startsWith('costumed:')) {
            initialCostumeType = initialPageClothing.split(':')[1];
            initialClothingCat = 'costumed';
          }
          // Convert clothingRequirements to _currentClothing format so all characters use story costumes
          const convertedInitialClothingReqs = convertClothingToCurrentFormat(streamingClothingRequirements);
          let initialPagePhotos = getCharacterPhotoDetails(inputData.characters || [], initialClothingCat, initialCostumeType, artStyleId, convertedInitialClothingReqs);
          // Apply styled avatars (pre-converted to target art style) for non-costumed
          if (initialClothingCat !== 'costumed') {
            initialPagePhotos = applyStyledAvatars(initialPagePhotos, artStyle);
          }
          log.debug(`📕 [STORYBOOK] Initial page: ALL ${initialPagePhotos.length} characters (group scene with main character centered), clothing: ${initialPageClothing}`);

          const initialPrompt = inputData.dedication && inputData.dedication.trim()
            ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
                INITIAL_PAGE_SCENE: initialPageScene,
                STYLE_DESCRIPTION: styleDescription,
                DEDICATION: inputData.dedication,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
                VISUAL_BIBLE: visualBiblePrompt
              })
            : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
                INITIAL_PAGE_SCENE: initialPageScene,
                STYLE_DESCRIPTION: styleDescription,
                STORY_TITLE: storyTitle,
                CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, inputData.characters),
                VISUAL_BIBLE: visualBiblePrompt
              });
          coverPrompts.initialPage = initialPrompt;
          const initialPageModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const initialResult = await generateImageWithQualityRetry(initialPrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker, null, initialPageModelOverrides, 'INITIAL PAGE', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          log.debug(`✅ [STORYBOOK] Initial page generated (score: ${initialResult.score}${initialResult.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (initialResult?.rewriteUsage) {
            addUsage('anthropic', initialResult.rewriteUsage, 'scene_rewrite');
          }
          coverImages.initialPage = {
            imageData: initialResult.imageData,
            description: initialPageScene,
            prompt: initialPrompt,
            qualityScore: initialResult.score,
            qualityReasoning: initialResult.reasoning || null,
            fixTargets: initialResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: initialResult.wasRegenerated || false,
            totalAttempts: initialResult.totalAttempts || 1,
            retryHistory: initialResult.retryHistory || [],
            originalImage: initialResult.originalImage || null,
            originalScore: initialResult.originalScore || null,
            originalReasoning: initialResult.originalReasoning || null,
            referencePhotos: initialPagePhotos,
            modelId: initialResult.modelId || null,
            bboxDetection: initialResult.bboxDetection || null,
            bboxOverlayImage: initialResult.bboxOverlayImage || null
          };
        } else {
          log.debug(`⚡ [STORYBOOK] Initial page already generated during streaming (skipping)`);
        }

        // Back cover - only generate if not already done during streaming
        if (!coverImages.backCover) {
          // Use extracted clothing or parse from scene description
          const backCoverClothing = coverScenes.backCover?.clothing || parseClothingCategory(backCoverScene) || 'standard';
          // Handle costumed:type format
          let backClothingCat = backCoverClothing;
          let backCostumeType = null;
          if (backCoverClothing.startsWith('costumed:')) {
            backCostumeType = backCoverClothing.split(':')[1];
            backClothingCat = 'costumed';
          }
          // Convert clothingRequirements to _currentClothing format so all characters use story costumes
          const convertedBackClothingReqs = convertClothingToCurrentFormat(streamingClothingRequirements);
          let backCoverPhotos = getCharacterPhotoDetails(inputData.characters || [], backClothingCat, backCostumeType, artStyleId, convertedBackClothingReqs);
          // Apply styled avatars (pre-converted to target art style) for non-costumed
          if (backClothingCat !== 'costumed') {
            backCoverPhotos = applyStyledAvatars(backCoverPhotos, artStyle);
          }
          log.debug(`📕 [STORYBOOK] Back cover: ALL ${backCoverPhotos.length} characters (equal prominence group scene), clothing: ${backCoverClothing}`);

          const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
            BACK_COVER_SCENE: backCoverScene,
            STYLE_DESCRIPTION: styleDescription,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(backCoverPhotos, inputData.characters),
            VISUAL_BIBLE: visualBiblePrompt
          });
          coverPrompts.backCover = backCoverPrompt;
          const backCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };
          const backCoverResult = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker, null, backCoverModelOverrides, 'BACK COVER', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          log.debug(`✅ [STORYBOOK] Back cover generated (score: ${backCoverResult.score}${backCoverResult.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (backCoverResult?.rewriteUsage) {
            addUsage('anthropic', backCoverResult.rewriteUsage, 'scene_rewrite');
          }
          coverImages.backCover = {
            imageData: backCoverResult.imageData,
            description: backCoverScene,
            prompt: backCoverPrompt,
            qualityScore: backCoverResult.score,
            qualityReasoning: backCoverResult.reasoning || null,
            fixTargets: backCoverResult.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: backCoverResult.wasRegenerated || false,
            totalAttempts: backCoverResult.totalAttempts || 1,
            retryHistory: backCoverResult.retryHistory || [],
            originalImage: backCoverResult.originalImage || null,
            originalScore: backCoverResult.originalScore || null,
            originalReasoning: backCoverResult.originalReasoning || null,
            referencePhotos: backCoverPhotos,
            modelId: backCoverResult.modelId || null,
            bboxDetection: backCoverResult.bboxDetection || null,
            bboxOverlayImage: backCoverResult.bboxOverlayImage || null
          };
        }

        log.debug(`✅ [STORYBOOK] Cover images complete (${coversFromStreaming} from streaming, ${3 - coversFromStreaming} generated after)`);

        // Run bbox detection on covers for entity consistency checks
        try {
          await detectBboxOnCovers(coverImages, inputData.characters);
        } catch (bboxErr) {
          log.warn(`⚠️ [STORYBOOK] Cover bbox detection failed: ${bboxErr.message}`);
        }
      } catch (error) {
        log.error(`❌ [STORYBOOK] Cover generation failed:`, error.message);
      }
    }

    // Prepare result data
    const resultData = {
      title: storyTitle,
      storyText: fullStoryText,
      outline: response, // Full combined response for dev mode
      outlinePrompt: storybookPrompt, // Prompt sent to API (dev mode)
      outlineModelId: streamingTextModelId, // Model used (dev mode)
      outlineUsage: streamingTextUsage, // Token usage (dev mode)
      visualBible: visualBible, // Recurring visual elements for consistency
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      imagePrompts: imagePrompts,
      coverPrompts: coverPrompts,  // Cover image prompts for dev mode
      styledAvatarGeneration: getStyledAvatarGenerationLog(),  // Styled avatar generation log for dev mode
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(),  // Costumed avatar generation log for dev mode
      finalChecksReport: finalChecksReport || null,  // Final consistency checks report (dev mode)
      storyType: inputData.storyType,
      storyDetails: inputData.storyDetails,
      pages: sceneCount,
      language: lang,
      languageLevel: '1st-grade',
      characters: inputData.characters,
      dedication: dedication,
      artStyle: inputData.artStyle,
      // Developer mode: raw AI response for debugging
      rawAIResponse: response
    };

    // Persist styled avatars to character data before saving story
    if (artStyle !== 'realistic' && inputData.characters) {
      try {
        const styledAvatarsMap = exportStyledAvatarsForPersistence(inputData.characters, artStyle);
        if (styledAvatarsMap.size > 0) {
          log.debug(`💾 [STORYBOOK] Persisting ${styledAvatarsMap.size} styled avatar sets to character data...`);
          for (const char of inputData.characters) {
            const styledAvatars = styledAvatarsMap.get(char.name);
            if (styledAvatars) {
              // Initialize styledAvatars object if not exists
              if (!char.avatars) char.avatars = {};
              if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
              // Store under artStyle key
              char.avatars.styledAvatars[artStyle] = styledAvatars;
              log.debug(`  - ${char.name}: ${Object.keys(styledAvatars).length} ${artStyle} avatars saved`);
            }
          }

          // Also persist styled avatars to the characters table (for viewing on Characters page)
          try {
            const characterId = `characters_${userId}`;
            const charResult = await dbPool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
            if (charResult.rows.length > 0) {
              // Handle both TEXT and JSONB column types
              const rawData = charResult.rows[0].data;
              const charData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
              const chars = charData.characters || [];
              let updatedCount = 0;

              for (const dbChar of chars) {
                const styledAvatars = styledAvatarsMap.get(dbChar.name);
                if (styledAvatars) {
                  if (!dbChar.avatars) dbChar.avatars = {};
                  if (!dbChar.avatars.styledAvatars) dbChar.avatars.styledAvatars = {};
                  dbChar.avatars.styledAvatars[artStyle] = styledAvatars;
                  updatedCount++;
                }
              }

              if (updatedCount > 0) {
                charData.characters = chars;
                await dbPool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
                log.debug(`💾 [STORYBOOK] Updated ${updatedCount} characters in database with ${artStyle} styled avatars`);
              }
            }
          } catch (dbError) {
            log.error(`⚠️ [STORYBOOK] Failed to persist styled avatars to characters table:`, dbError.message);
          }
        }
      } catch (error) {
        // Bug #14 fix: Include more context for styled avatar persistence errors
        log.error(`⚠️ [STORYBOOK] Failed to persist styled avatars: ${error.message}`);
        log.debug(`   Stack: ${error.stack?.split('\n').slice(0, 3).join(' -> ')}`);
      }
    }

    // =========================================================================
    // FINAL CONSISTENCY CHECKS (if enabled)
    // =========================================================================
    let finalChecksReport = null;
    let originalStoryText = null; // Will store original text if corrections are applied
    if (enableFinalChecks && !skipImages && allImages.length >= 2) {
      try {
        genLog.setStage('final_checks');
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [97, 'Running final consistency checks...', jobId]
        );
        log.info(`🔍 [STORYBOOK] Running final consistency checks...`);

        // Run image consistency checks - include scene context for accurate evaluation
        const imageCheckData = {
          sceneImages: allImages.map((img, idx) => {
            // Extract metadata from scene description (characters, clothing, objects)
            const metadata = extractSceneMetadata(img.description) || {};

            // Extract scene summary
            // New JSON format: use imageSummary from fullData
            // Legacy format: text before the ```json block
            let sceneSummary = '';
            if (metadata.fullData?.imageSummary) {
              sceneSummary = metadata.fullData.imageSummary.substring(0, 150);
            } else if (img.description) {
              const beforeJson = img.description.split('```json')[0].trim();
              const lines = beforeJson.split('\n').filter(l => l.trim() && !l.startsWith('#'));
              sceneSummary = lines[0]?.substring(0, 150) || '';
            }

            // Prefer stored sceneCharacterClothing (from page generation) over metadata extraction
            // sceneCharacterClothing has the actual clothing used, e.g., {"Lukas": "costumed:pirate", "Sophie": "winter"}
            const perCharClothing = img.sceneCharacterClothing || metadata.characterClothing || {};

            return {
              imageData: img.imageData,
              pageNumber: img.pageNumber || idx + 1,
              characters: metadata.characters || [],  // Which characters appear in this scene
              clothing: metadata.clothing || 'standard',  // Clothing category for this scene (legacy)
              characterClothing: perCharClothing,  // Per-character clothing for entity grouping
              sceneSummary,  // Brief description of what's in the scene
              // Also include character names from reference photos as fallback
              referenceCharacters: (img.referencePhotos || []).map(p => p.name).filter(Boolean),
              // Include per-character clothing from referencePhotos if available
              referenceClothing: (img.referencePhotos || []).reduce((acc, p) => {
                if (p.name && p.clothingCategory) acc[p.name] = p.clothingCategory;
                return acc;
              }, {}),
              // Include retryHistory for entity consistency check (has bbox detection)
              retryHistory: img.retryHistory || []
            };
          })
        };

        // Add cover images to consistency check (use page numbers after story pages)
        const coverSceneImages = buildCoverSceneImages(
          coverImages,
          inputData.characters || [],
          allImages.length  // Base: frontCover = length+1, initialPage = length+2, backCover = length+3
        );
        if (coverSceneImages.length > 0) {
          imageCheckData.sceneImages.push(...coverSceneImages);
          log.debug(`📊 [STORYBOOK FINAL CHECKS] Added ${coverSceneImages.length} cover images to consistency check (pages ${coverSceneImages.map(c => c.pageNumber).join(', ')})`);
        }

        // LEGACY: Full-image consistency check
        const legacyReport = await runFinalConsistencyChecks(imageCheckData, inputData.characters || [], {
          checkCharacters: true
        });

        // Track legacy check token usage
        if (legacyReport?.tokenUsage) {
          addUsage('gemini_quality', {
            input_tokens: legacyReport.tokenUsage.inputTokens || 0,
            output_tokens: legacyReport.tokenUsage.outputTokens || 0
          }, 'consistency_check', legacyReport.tokenUsage.model || 'gemini-2.5-flash');
        }

        // NEW: Entity-grouped consistency check (stores grids for review)
        log.info('🔍 [STORYBOOK] Running entity-grouped consistency checks...');
        const entityReport = await runEntityConsistencyChecks(imageCheckData, inputData.characters || [], {
          checkCharacters: true,
          checkObjects: false,  // Objects not yet implemented
          minAppearances: 2,
          saveGrids: false  // Grids stored in report instead
        });

        // Track entity check token usage
        if (entityReport?.tokenUsage) {
          addUsage('gemini_quality', {
            input_tokens: entityReport.tokenUsage.inputTokens || 0,
            output_tokens: entityReport.tokenUsage.outputTokens || 0
          }, 'entity_consistency_check', entityReport.tokenUsage.model || 'gemini-2.5-flash');
        }

        // Combine reports: entity as primary, legacy as fallback
        finalChecksReport = {
          ...legacyReport,
          entity: entityReport,
          legacy: {
            imageChecks: legacyReport.imageChecks,
            summary: legacyReport.summary
          },
          // Use entity issues as primary if available
          totalIssues: (entityReport?.totalIssues || 0) + (legacyReport?.totalIssues || 0),
          overallConsistent: (entityReport?.overallConsistent ?? true) && (legacyReport?.overallConsistent ?? true),
          summary: entityReport?.summary || legacyReport?.summary
        };

        // Run text consistency check - include detailed language instructions and reading level
        // Use same model as story generation for language consistency
        if (fullStoryText && fullStoryText.length > 100) {
          const characterNames = (inputData.characters || []).map(c => c.name).filter(Boolean);
          const langCode = inputData.language || lang;
          const languageInstruction = getLanguageInstruction(langCode);
          const languageLevel = inputData.languageLevel || 'standard';
          const textCheck = await evaluateTextConsistency(fullStoryText, langCode, characterNames, languageInstruction, languageLevel, streamingTextModelId);
          if (textCheck) {
            // Track token usage for text check
            if (textCheck.usage) {
              const textCheckProvider = streamingTextModelId?.startsWith('gemini') ? 'gemini_text' : 'anthropic';
              addUsage(textCheckProvider, {
                input_tokens: textCheck.usage.input_tokens || 0,
                output_tokens: textCheck.usage.output_tokens || 0
              }, 'text_check', streamingTextModelId);
            }
            // Add original text to textCheck for display
            textCheck.fullOriginalText = fullStoryText;
            finalChecksReport.textCheck = textCheck;
            if (textCheck.quality !== 'good') {
              finalChecksReport.overallConsistent = false;
            }
            finalChecksReport.totalIssues += textCheck.issues?.length || 0;

            // Auto-apply text corrections if available
            if (textCheck.fullCorrectedText && textCheck.issues?.length > 0) {
              log.info(`✏️  [STORYBOOK] Applying ${textCheck.issues.length} text correction(s) to story`);
              originalStoryText = fullStoryText; // Preserve original for dev mode
              fullStoryText = textCheck.fullCorrectedText; // Apply corrected text
              finalChecksReport.textCorrectionApplied = true;
            }
          }
        }

        // Log results to generation log
        genLog.info('final_checks_result', `Final checks: ${finalChecksReport.summary}`, null, {
          imageChecks: finalChecksReport.imageChecks?.length || 0,
          textCheck: finalChecksReport.textCheck ? 'completed' : 'skipped',
          textCorrectionApplied: finalChecksReport.textCorrectionApplied || false,
          totalIssues: finalChecksReport.totalIssues || 0,
          overallConsistent: finalChecksReport.overallConsistent,
          summary: finalChecksReport.summary
        });

        log.info(`📋 [STORYBOOK] Final checks complete: ${finalChecksReport.summary}`);

        // Update resultData with final checks report and corrected text (resultData was built before checks ran)
        resultData.finalChecksReport = finalChecksReport;
        if (finalChecksReport.textCorrectionApplied) {
          resultData.storyText = fullStoryText;  // Use corrected text
        }
      } catch (checkErr) {
        log.error('❌ [STORYBOOK] Final checks failed:', checkErr.message);
        genLog.error('final_checks_failed', checkErr.message);
        // Non-fatal - story generation continues
      }
    }

    // Save story to stories table so it appears in My Stories
    const storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: storyTitle,
      storyType: inputData.storyType || 'picture-book',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
      artStyle: inputData.artStyle || 'pixar',
      language: lang,
      languageLevel: '1st-grade',
      pages: sceneCount,
      dedication: dedication,
      season: inputData.season || '', // Season when story takes place
      userLocation: inputData.userLocation || null, // User's location for personalization
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      outline: response, // Full combined response for dev mode
      outlinePrompt: storybookPrompt, // Prompt sent to API (dev mode)
      outlineModelId: streamingTextModelId, // Model used (dev mode)
      outlineUsage: streamingTextUsage, // Token usage (dev mode)
      visualBible: visualBible, // Recurring visual elements for consistency
      storyText: fullStoryText, // May be corrected text if text check found issues
      originalStory: originalStoryText || fullStoryText, // Store original AI text for dev mode
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      pageClothing: pageClothing, // Clothing per page
      clothingRequirements: streamingClothingRequirements, // Per-character clothing requirements
      tokenUsage: JSON.parse(JSON.stringify(tokenUsage, (k, v) => v instanceof Set ? [...v] : v)), // Token usage (Sets to Arrays)
      generationLog: [], // Will be populated after apiUsage logging
      styledAvatarGeneration: getStyledAvatarGenerationLog(), // Styled avatar generation log (dev mode)
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(), // Costumed avatar generation log (dev mode)
      finalChecksReport: finalChecksReport || null, // Final consistency checks report (dev mode)
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Debug: Log what's being saved for storyCategory/storyTheme
    log.debug(`📝 [STORY SAVE] storyCategory: "${storyData.storyCategory}", storyTopic: "${storyData.storyTopic}", storyTheme: "${storyData.storyTheme}"`);
    log.debug(`📝 [STORY SAVE] mainCharacters: ${JSON.stringify(storyData.mainCharacters)}, characters count: ${storyData.characters?.length || 0}`);

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    // Calculate image costs using per-image pricing (not token-based)
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    const imageCost = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed']
      .reduce((sum, fn) => sum + (byFunc[fn]?.calls > 0 ? calculateImageCost(getModels(byFunc[fn]), byFunc[fn].calls) : 0), 0);
    const totalCost = anthropicCost.total + imageCost + geminiQualityCost.total;
    log.debug(`📊 [STORYBOOK] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` / ${tokenUsage.anthropic.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr} (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_image.calls} calls)  $${imageCost.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr} (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    // Use first model for cost calculation (model-specific pricing), fall back to provider
    const getCostModel = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models)[0] : funcData.provider;

    // Log API usage to generationLog for dev mode visibility
    genLog.setStage('finalize');
    log.debug(`📊 [STORYBOOK] Logging API usage to generationLog. Functions with calls:`);
    // Image generation functions use per-image pricing, not token-based
    const IMAGE_FUNCTIONS = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed'];
    for (const [funcName, funcData] of Object.entries(byFunc)) {
      log.debug(`   - ${funcName}: ${funcData.calls} calls, ${funcData.input_tokens} in, ${funcData.output_tokens} out`);
      if (funcData.calls > 0) {
        const model = getModels(funcData);
        const directCost = funcData.direct_cost || 0;
        let cost;
        if (directCost > 0) {
          cost = directCost;
        } else if (IMAGE_FUNCTIONS.includes(funcName)) {
          cost = calculateImageCost(model, funcData.calls);
        } else {
          cost = calculateCost(getCostModel(funcData), funcData.input_tokens, funcData.output_tokens, funcData.thinking_tokens).total;
        }
        genLog.apiUsage(funcName, model, {
          inputTokens: funcData.input_tokens,
          outputTokens: funcData.output_tokens,
          thinkingTokens: funcData.thinking_tokens,
          directCost: directCost,
          calls: funcData.calls
        }, cost);
      }
    }

    // Add total cost summary to generation log
    genLog.info('total_cost', `💰 Total API cost: $${totalCost.toFixed(4)}`, null, {
      totalCost: totalCost,
      totalInputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0),
      totalOutputTokens: Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0),
      runwareCost: tokenUsage.runware?.direct_cost || 0
    });

    // Finalize and populate generationLog for storage
    genLog.finalize();
    storyData.generationLog = genLog.getEntries();
    log.debug(`📊 [STORYBOOK] Generation log has ${storyData.generationLog.length} entries`);

    if (byFunc.outline.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.outline), byFunc.outline.input_tokens, byFunc.outline.output_tokens, byFunc.outline.thinking_tokens);
      log.debug(`   Outline:       ${byFunc.outline.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.outline.output_tokens.toLocaleString().padStart(8)} out (${byFunc.outline.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.outline)}]`);
    }
    if (byFunc.story_text.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.story_text), byFunc.story_text.input_tokens, byFunc.story_text.output_tokens, byFunc.story_text.thinking_tokens);
      log.debug(`   Story Text:    ${byFunc.story_text.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.story_text.output_tokens.toLocaleString().padStart(8)} out (${byFunc.story_text.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.story_text)}]`);
    }
    if (byFunc.scene_descriptions.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_descriptions), byFunc.scene_descriptions.input_tokens, byFunc.scene_descriptions.output_tokens, byFunc.scene_descriptions.thinking_tokens);
      log.debug(`   Scene Desc:    ${byFunc.scene_descriptions.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_descriptions.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_descriptions.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_descriptions)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const model = getModels(byFunc.cover_images);
      const cost = calculateImageCost(model, byFunc.cover_images.calls);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const model = getModels(byFunc.page_images);
      const cost = calculateImageCost(model, byFunc.page_images.calls);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    if (byFunc.inpaint.calls > 0) {
      const directCost = byFunc.inpaint.direct_cost || 0;
      const cost = directCost > 0
        ? { total: directCost }
        : calculateCost(getCostModel(byFunc.inpaint), byFunc.inpaint.input_tokens, byFunc.inpaint.output_tokens, byFunc.inpaint.thinking_tokens);
      log.debug(`   Inpaint:       ${byFunc.inpaint.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.inpaint.output_tokens.toLocaleString().padStart(8)} out${directCost > 0 ? ` + $${directCost.toFixed(4)} direct` : ''} (${byFunc.inpaint.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.inpaint)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    const thinkingTotal = totalThinkingTokens > 0 ? `, ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);

    // Insert into stories table with metadata for fast list queries
    await upsertStory(storyId, userId, storyData);
    log.debug(`📚 [STORYBOOK] Story ${storyId} saved to stories table`);

    // Initialize image_version_meta with active versions for all pages
    if (storyData.sceneImages?.length > 0) {
      for (const scene of storyData.sceneImages) {
        if (scene.imageVersions?.length > 0) {
          const activeIndex = getActiveIndexAfterPush(scene.imageVersions, 'scene');
          await setActiveVersion(storyId, scene.pageNumber, activeIndex);
        }
      }
      log.debug(`📚 [STORYBOOK] Initialized image_version_meta for ${storyData.sceneImages.length} pages`);
    }

    // Log credit completion (credits were already reserved at job creation)
    try {
      const jobResult = await dbPool.query(
        'SELECT credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const creditsUsed = jobResult.rows[0].credits_reserved;
        const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
        const currentBalance = userResult.rows[0]?.credits || 0;

        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, 0, currentBalance, 'story_complete', jobId, `Story completed - ${creditsUsed} credits used`]
        );
        log.info(`💳 [STORYBOOK] Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ [STORYBOOK] Failed to log credit completion:', creditErr.message);
    }

    // Add storyId to resultData so client can navigate to it
    resultData.storyId = storyId;

    // Mark job as completed and reset credits_reserved to prevent accidental refunds
    await dbPool.query(
      `UPDATE story_jobs SET
        status = 'completed',
        progress = 100,
        progress_message = 'Picture book complete!',
        result_data = $1,
        credits_reserved = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [JSON.stringify(resultData), jobId]
    );

    // Clear styled avatar cache to free memory
    clearStyledAvatarCache();

    log.debug(`✅ [STORYBOOK] Job ${jobId} completed successfully`);
    return resultData;

  } catch (error) {
    // Clear styled avatar cache on error too
    clearStyledAvatarCache();
    log.error(`❌ [STORYBOOK] Job ${jobId} failed:`, error);

    // Refund reserved credits on failure - PROPORTIONAL based on work completed
    try {
      const jobResult = await dbPool.query(
        'SELECT user_id, credits_reserved, progress FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (jobResult.rows.length > 0 && jobResult.rows[0].credits_reserved > 0) {
        const refundUserId = jobResult.rows[0].user_id;
        const totalCredits = jobResult.rows[0].credits_reserved;
        const progressPercent = jobResult.rows[0].progress || 0;

        // Full refund if story is not 100% complete - incomplete stories have no value to user
        const isComplete = progressPercent >= 100;
        const creditsToRefund = isComplete ? 0 : totalCredits;

        if (creditsToRefund > 0) {
          // Get current balance
          const userResult = await dbPool.query(
            'SELECT credits FROM users WHERE id = $1',
            [refundUserId]
          );

          if (userResult.rows.length > 0 && userResult.rows[0].credits !== -1) {
            const currentBalance = userResult.rows[0].credits;
            const newBalance = currentBalance + creditsToRefund;

            // Refund credits
            await dbPool.query(
              'UPDATE users SET credits = $1 WHERE id = $2',
              [newBalance, refundUserId]
            );

            // Create refund transaction record
            const description = `Full refund: ${creditsToRefund} credits - storybook generation failed at ${progressPercent}%`;

          await dbPool.query(
            `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [refundUserId, creditsToRefund, newBalance, 'story_refund', jobId, description]
          );

          // Reset credits_reserved to prevent double refunds
          await dbPool.query(
            'UPDATE story_jobs SET credits_reserved = 0 WHERE id = $1',
            [jobId]
          );

            log.info(`💳 [STORYBOOK] Refunded ${creditsToRefund} credits for failed job ${jobId} (failed at ${progressPercent}%)`);
          }
        }
      }
    } catch (refundErr) {
      log.error('❌ [STORYBOOK] Failed to refund credits:', refundErr.message);
    }

    await dbPool.query(
      `UPDATE story_jobs SET
        status = 'failed',
        error_message = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
      [error.message, jobId]
    );

    throw error;
  }
}

// ============================================================================
// OUTLINE AND TEXT GENERATION (Legacy)
// Separate outline + text prompts
// ============================================================================

async function processOutlineAndTextJob(jobId, inputData, characterPhotos, skipImages, skipCovers, userId, modelOverrides = {}, isAdmin = false, enableAutoRepair = false, useGridRepair = true, enableFinalChecks = false, incrementalConsistencyConfig = null, checkOnlyMode = false, enableSceneValidation = false) {
  // Destructure server.js-local dependencies
  const { dbPool, log, saveCheckpoint, getCheckpoint, deleteJobCheckpoints, getAllCheckpoints, detectBboxOnCovers, buildCoverSceneImages, IMAGE_GEN_MODE, email } = deps;

  log.debug(`📖 [OUTLINE+TEXT] Starting outline+text generation for job ${jobId}`);

  // Generation logger for tracking API usage and debugging
  const genLog = new GenerationLogger();
  genLog.setStage('outline');

  // Clear avatar generation logs for fresh tracking
  clearStyledAvatarGenerationLog();
  clearCostumedAvatarGenerationLog();

  // Token usage tracker - accumulates usage from all API calls by provider and function
  const tokenUsage = {
    anthropic: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_image: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    gemini_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0 },
    runware: { direct_cost: 0, calls: 0 },
    byFunction: {
      outline: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      scene_descriptions: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      story_text: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() },
      cover_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      cover_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      page_images: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_image', models: new Set() },
      page_quality: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      inpaint: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_styled: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      avatar_costumed: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, direct_cost: 0, calls: 0, provider: null, models: new Set() },
      consistency_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'gemini_quality', models: new Set() },
      text_check: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: null, models: new Set() },
      scene_rewrite: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, calls: 0, provider: 'anthropic', models: new Set() }
    }
  };

  // Pricing by provider
  const PROVIDER_PRICING = {
    anthropic: MODEL_PRICING['claude-sonnet-4-5'] || { input: 3.00, output: 15.00 },
    gemini_quality: MODEL_PRICING['gemini-2.0-flash'] || { input: 0.10, output: 0.40 },
    gemini_text: MODEL_PRICING['gemini-2.5-flash'] || { input: 0.30, output: 2.50 }
  };

  const calculateImageCost = (modelId, imageCount) => {
    const pricing = MODEL_PRICING[modelId];
    if (pricing?.perImage) return pricing.perImage * imageCount;
    return 0.04 * imageCount;
  };

  const addUsage = (provider, usage, functionName = null, modelName = null) => {
    if (usage && tokenUsage[provider]) {
      if (provider === 'runware') {
        tokenUsage.runware.direct_cost += usage.direct_cost || 0;
        tokenUsage.runware.calls += 1;
      } else {
        tokenUsage[provider].input_tokens += usage.input_tokens || 0;
        tokenUsage[provider].output_tokens += usage.output_tokens || 0;
        tokenUsage[provider].thinking_tokens += usage.thinking_tokens || 0;
        tokenUsage[provider].calls += 1;
      }
    }
    if (functionName && tokenUsage.byFunction[functionName]) {
      const func = tokenUsage.byFunction[functionName];
      func.input_tokens += usage.input_tokens || 0;
      func.output_tokens += usage.output_tokens || 0;
      func.thinking_tokens += usage.thinking_tokens || 0;
      func.direct_cost = (func.direct_cost || 0) + (usage.direct_cost || 0);
      func.calls += 1;
      func.provider = provider;
      if (modelName) func.models.add(modelName);
    }
  };

  const calculateCost = (modelOrProvider, inputTokens, outputTokens, thinkingTokens = 0) => {
    const pricing = MODEL_PRICING[modelOrProvider] || PROVIDER_PRICING[modelOrProvider] || { input: 0, output: 0 };
    const inputCost = (inputTokens / 1000000) * pricing.input;
    const outputCost = (outputTokens / 1000000) * pricing.output;
    const thinkingCost = (thinkingTokens / 1000000) * pricing.output;
    return { input: inputCost, output: outputCost, thinking: thinkingCost, total: inputCost + outputCost + thinkingCost };
  };

  // Compute values normally provided by processStoryJob's setup code
  // Note: artStyle is re-declared in the extracted code below
  let storyId = jobId;
  const lang = inputData.language || 'en';
  const { getLanguageNameEnglish } = require('./languages');
  const langText = getLanguageNameEnglish(lang);
  const printPages = inputData.pages;
  const isPictureBookLayout = inputData.languageLevel === '1st-grade';
  const sceneCount = isPictureBookLayout ? printPages : Math.floor(printPages / 2);
  const imageGenMode = inputData.imageGenMode || IMAGE_GEN_MODE || 'parallel';
  const enableIncrementalConsistency = incrementalConsistencyConfig?.enabled === true;
  const incrementalConsistencyDryRun = incrementalConsistencyConfig?.dryRun === true;
  const incrementalConsistencyLookback = incrementalConsistencyConfig?.lookbackCount || 3;
  const forceRepairThreshold = incrementalConsistencyConfig?.forceRepairThreshold ?? null;

  // --- Begin extracted outlineAndText code ---
    await dbPool.query(
      'UPDATE story_jobs SET progress_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['Writing story...', jobId]
    );

    // Step 1: Generate story outline
    // Pass sceneCount to ensure outline matches the number of scenes we'll generate
    const outlinePrompt = buildStoryPrompt(inputData, sceneCount);
    const outlineTokens = 64000;
    const outlineModelOverride = modelOverrides.outlineModel || null;
    const outlineModelConfig = outlineModelOverride ? TEXT_MODELS[outlineModelOverride] : getActiveTextModel();
    const outlineProvider = outlineModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';
    log.debug(`📋 [PIPELINE] Generating outline for ${sceneCount} scenes (max tokens: ${outlineTokens}) - STREAMING${outlineModelOverride ? ` [model: ${outlineModelOverride}]` : ''}`);
    const outlineResult = await callTextModelStreaming(outlinePrompt, outlineTokens, null, outlineModelOverride);
    const outline = outlineResult.text;
    // Get the actual model used (override or default)
    const outlineModelUsed = outlineResult.modelId || outlineModelConfig?.modelId;
    const outlineUsage = outlineResult.usage || { input_tokens: 0, output_tokens: 0 };
    addUsage(outlineProvider, outlineResult.usage, 'outline', outlineModelUsed);

    // Save checkpoint: outline (include prompt, model, and token usage for debugging)
    await saveCheckpoint(jobId, 'outline', { outline, outlinePrompt, outlineModelId: outlineModelUsed, outlineUsage });

    // Extract short scene descriptions from outline for better image generation
    const shortSceneDescriptions = extractShortSceneDescriptions(outline);
    log.debug(`📋 [PIPELINE] Extracted ${Object.keys(shortSceneDescriptions).length} short scene descriptions from outline`);

    // Extract page clothing from outline for consistent outfit rendering
    const pageClothingData = extractPageClothing(outline, sceneCount);
    log.debug(`👔 [PIPELINE] Primary clothing: ${pageClothingData.primaryClothing}, changes on ${Object.entries(pageClothingData.pageClothing).filter(([p, c]) => c !== pageClothingData.primaryClothing).length} pages`);

    // Parse Visual Bible for recurring elements consistency
    const visualBible = parseVisualBible(outline);
    // Filter out main characters from secondary characters (safety net)
    filterMainCharactersFromVisualBible(visualBible, inputData.characters);

    // Initialize main characters from inputData.characters with their style analysis
    initializeVisualBibleMainCharacters(visualBible, inputData.characters);

    // Link pre-discovered landmarks (if available) to skip fetching later
    if (inputData.availableLandmarks?.length > 0) {
      linkPreDiscoveredLandmarks(visualBible, inputData.availableLandmarks);
    }

    // Load photo variant descriptions for Swiss landmarks (descriptions only, no image data)
    await loadLandmarkPhotoDescriptions(visualBible);

    const visualBibleEntryCount = visualBible.secondaryCharacters.length +
                                   visualBible.animals.length +
                                   visualBible.artifacts.length +
                                   visualBible.locations.length;

    log.debug(`📖 [PIPELINE] Visual Bible after parsing: ${JSON.stringify({
      mainCharacters: visualBible.mainCharacters.length,
      secondaryCharacters: visualBible.secondaryCharacters.length,
      animals: visualBible.animals.length,
      artifacts: visualBible.artifacts.length,
      locations: visualBible.locations.length,
      changeLog: visualBible.changeLog.length
    })}`);

    // Validate visual bible was parsed - if outline contains "visual bible" but we got 0 entries, fail
    if (outline.toLowerCase().includes('visual bible') && visualBibleEntryCount === 0) {
      log.error('❌ [PIPELINE] Visual Bible section exists in outline but parsing returned 0 entries!');
      log.error('📖 [PIPELINE] This indicates a parsing bug. Outline preview around "visual bible":');
      const vbIndex = outline.toLowerCase().indexOf('visual bible');
      log.error(outline.substring(Math.max(0, vbIndex - 50), Math.min(outline.length, vbIndex + 500)));
      throw new Error('Visual Bible parsing failed: section exists but no entries extracted. Check outline format.');
    }

    // Save checkpoint: scene hints and visual bible
    await saveCheckpoint(jobId, 'scene_hints', { shortSceneDescriptions, visualBible });

    // Start background fetch for landmark reference photos
    // NOTE: For Swiss landmarks with photo variants, we'll load photos on-demand during image generation
    let landmarkFetchPromise = null;
    let landmarkCount = 0;
    const nonVariantLandmarks = (visualBible.locations || []).filter(
      l => l.isRealLandmark && !l.photoVariants?.length && l.photoFetchStatus !== 'success'
    );
    if (nonVariantLandmarks.length > 0 && !skipImages) {
      landmarkCount = nonVariantLandmarks.length;
      log.info(`🌍 [PIPELINE] Starting background fetch for ${nonVariantLandmarks.length} non-variant landmark photo(s)`);
      landmarkFetchPromise = prefetchLandmarkPhotos(visualBible);
    }

    // Extract title from outline using unified OutlineParser
    const outlineParser = new OutlineParser(outline);
    const extractedTitle = outlineParser.extractTitle();
    let storyTitle = extractedTitle || inputData.title || 'My Story';
    if (extractedTitle) {
      log.debug(`📖 [PIPELINE] Extracted title from outline: "${storyTitle}"`);
      // Update inputData so buildBasePrompt uses the extracted title
      inputData.title = storyTitle;
    }

    // ===== CLOTHING REQUIREMENTS =====
    // NOTE: Avatar generation removed from story processing.
    // Base avatars should already exist from character creation.
    // For costumed/signature avatars, use server/lib/storyAvatarGeneration.js if needed.
    const clothingRequirements = outlineParser.extractClothingRequirements();
    const artStyle = inputData.artStyle || 'pixar';

    if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
      log.debug(`👔 [PIPELINE] Clothing requirements found for ${Object.keys(clothingRequirements).length} characters`);
    }

    // START COVER GENERATION IN PARALLEL (optimization: don't wait for page images)
    // Covers only need: outline (for scenes), character photos, art style - all available now
    let coverGenerationPromise = null;
    const coverPrompts = {};  // Store cover prompts for dev mode

    // Prepare styled avatars for non-realistic art styles (parallel with outline parsing)
    // Note: artStyle is already declared earlier in this scope
    if (artStyle !== 'realistic' && inputData.characters && !skipImages) {
      log.debug(`🎨 [PIPELINE] Preparing styled avatars for ${artStyle} style...`);
      try {
        // Build avatar requirements based on per-character clothing from outline
        const avatarRequirements = [];

        // Use clothing requirements from outline for per-character avatars
        if (clothingRequirements && Object.keys(clothingRequirements).length > 0) {
          for (const [charName, reqs] of Object.entries(clothingRequirements)) {
            // Collect ALL used clothing categories for this character (not just the first!)
            const usedCategories = new Set();

            for (const [category, config] of Object.entries(reqs)) {
              if (config && config.used) {
                if (category === 'costumed' && config.costume) {
                  usedCategories.add(`costumed:${config.costume.toLowerCase()}`);
                } else {
                  usedCategories.add(category);
                }
                // NO break here - collect ALL categories
              }
            }

            // Always include standard as fallback for covers
            usedCategories.add('standard');

            // Add avatar requirements for each used category
            for (const clothingCategory of usedCategories) {
              avatarRequirements.push({ pageNumber: 'cover', clothingCategory, characterNames: [charName] });
              for (let i = 1; i <= sceneCount; i++) {
                avatarRequirements.push({ pageNumber: i, clothingCategory, characterNames: [charName] });
              }
            }
          }
          log.debug(`🎨 [PIPELINE] Built ${avatarRequirements.length} avatar requirements from clothing requirements`);
        } else {
          // Fallback: use page clothing data (old behavior)
          const allCharNames = inputData.characters.map(c => c.name);
          avatarRequirements.push({ pageNumber: 'cover', clothingCategory: 'standard', characterNames: allCharNames });
          for (let i = 1; i <= sceneCount; i++) {
            const clothing = pageClothingData.pageClothing[i] || pageClothingData.primaryClothing || 'standard';
            avatarRequirements.push({ pageNumber: i, clothingCategory: clothing, characterNames: allCharNames });
          }
        }

        // Convert avatars in parallel (pass clothingRequirements for signature lookup)
        await prepareStyledAvatars(inputData.characters || [], artStyle, avatarRequirements, clothingRequirements, addUsage);
        log.debug(`✅ [PIPELINE] Styled avatars ready: ${getStyledAvatarCacheStats().size} cached`);
      } catch (error) {
        log.error(`⚠️ [PIPELINE] Failed to prepare styled avatars, using original photos:`, error.message);
      }
    }

    if (!skipImages && !skipCovers) {
      console.log(`📕 [PIPELINE] Starting PARALLEL cover generation for job ${jobId}`);

      // Get art style description
      const artStyleId = inputData.artStyle || 'pixar';
      const styleDescription = ART_STYLES[artStyleId] || ART_STYLES.pixar;

      // Extract cover scene descriptions from outline
      const coverScenes = extractCoverScenes(outline);
      const titlePageScene = coverScenes.titlePage?.scene || `A beautiful, magical title page featuring the main characters. Decorative elements that reflect the story's theme with space for the title text.`;
      const initialPageScene = coverScenes.initialPage?.scene || `A warm, inviting dedication/introduction page that sets the mood and welcomes readers.`;
      const backCoverScene = coverScenes.backCover?.scene || `A satisfying, conclusive ending scene that provides closure and leaves readers with a warm feeling.`;

      // Translate cover scenes for non-English stories (for display in edit modal)
      let translatedTitlePageScene = titlePageScene;
      let translatedInitialPageScene = initialPageScene;
      let translatedBackCoverScene = backCoverScene;

      if (lang && !lang.startsWith('en')) {
        const { getLanguageInstruction } = require('./languages');
        const langInstruction = getLanguageInstruction(lang);

        const translateScene = async (scene) => {
          if (!scene) return scene;
          try {
            const result = await callTextModel(
              `Translate this image scene description to the target language. Keep it concise (1-2 sentences). Output ONLY the translation, nothing else.\n\n${langInstruction}\n\nScene: ${scene}`,
              { maxTokens: 300 }
            );
            return result.text?.trim() || scene;
          } catch (err) {
            log.warn(`⚠️ [COVER] Failed to translate scene: ${err.message}`);
            return scene;
          }
        };

        log.debug(`🌐 [COVER] Translating cover scenes to ${lang}...`);
        [translatedTitlePageScene, translatedInitialPageScene, translatedBackCoverScene] = await Promise.all([
          translateScene(titlePageScene),
          translateScene(initialPageScene),
          translateScene(backCoverScene)
        ]);
        log.debug(`🌐 [COVER] Cover scene translations complete`);
      }

      // Build visual bible prompt for covers
      const visualBiblePrompt = visualBible ? buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true }) : '';

      // Prepare all cover generation promises
      // Front cover - use only MAIN characters (isMainCharacter: true), capped at 5
      const allCharacters = inputData.characters || [];
      const mainCharacters = allCharacters.filter(c => c.isMainCharacter === true);
      let frontCoverCharacters = mainCharacters.length > 0 ? mainCharacters : allCharacters;
      if (frontCoverCharacters.length > 5) {
        log.info(`📕 [PIPELINE] Capping front cover characters from ${frontCoverCharacters.length} to 5`);
        frontCoverCharacters = frontCoverCharacters.slice(0, 5);
      }
      log.debug(`📕 [PIPELINE] Front cover: ${mainCharacters.length > 0 ? 'MAIN: ' + mainCharacters.map(c => c.name).join(', ') : 'ALL (no main chars defined)'} (${frontCoverCharacters.length} chars)`);
      const frontCoverClothingRaw = coverScenes.titlePage?.clothing || parseClothingCategory(titlePageScene) || 'standard';
      let frontCoverClothing = frontCoverClothingRaw;
      let frontCoverCostumeType = null;
      if (frontCoverClothingRaw.startsWith('costumed:')) {
        frontCoverClothing = 'costumed';
        frontCoverCostumeType = frontCoverClothingRaw.split(':')[1];
      }
      // Convert clothingRequirements to _currentClothing format so all characters use story costumes
      const convertedPipelineClothingReqs = convertClothingToCurrentFormat(clothingRequirements);
      let frontCoverPhotos = getCharacterPhotoDetails(frontCoverCharacters, frontCoverClothing, frontCoverCostumeType, artStyle, convertedPipelineClothingReqs);
      // For non-costumed avatars, apply styled avatars from cache
      if (frontCoverClothing !== 'costumed') {
        frontCoverPhotos = applyStyledAvatars(frontCoverPhotos, artStyle);
      }
      const frontCoverPrompt = fillTemplate(PROMPT_TEMPLATES.frontCover, {
        TITLE_PAGE_SCENE: titlePageScene,
        STYLE_DESCRIPTION: styleDescription,
        STORY_TITLE: storyTitle,
        CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(frontCoverPhotos, frontCoverCharacters),
        VISUAL_BIBLE: visualBiblePrompt
      });
      coverPrompts.frontCover = frontCoverPrompt;

      // Initial page & back cover: cap at 5 characters, split non-main across covers
      const MAX_COVER_CHARACTERS = 5;
      const nonMainCharacters = mainCharacters.length > 0
        ? allCharacters.filter(c => !c.isMainCharacter)
        : allCharacters;
      const mainCapped = mainCharacters.slice(0, MAX_COVER_CHARACTERS);
      const extraSlots = Math.max(0, MAX_COVER_CHARACTERS - mainCapped.length);
      const halfPoint = Math.ceil(nonMainCharacters.length / 2);
      const initialPageExtras = nonMainCharacters.slice(0, halfPoint).slice(0, extraSlots);
      const backCoverExtras = nonMainCharacters.slice(halfPoint).slice(0, extraSlots);
      const initialPageCharacters = [...mainCapped, ...initialPageExtras];
      const backCoverCharacters = [...mainCapped, ...backCoverExtras];
      log.debug(`📕 [PIPELINE] Initial page: ${initialPageCharacters.map(c => c.name).join(', ')} (${initialPageCharacters.length} chars)`);
      log.debug(`📕 [PIPELINE] Back cover: ${backCoverCharacters.map(c => c.name).join(', ')} (${backCoverCharacters.length} chars)`);

      // Initial page - pass artStyle for styled costumed avatars
      const initialPageClothingRaw = coverScenes.initialPage?.clothing || parseClothingCategory(initialPageScene) || 'standard';
      let initialPageClothing = initialPageClothingRaw;
      let initialPageCostumeType = null;
      if (initialPageClothingRaw.startsWith('costumed:')) {
        initialPageClothing = 'costumed';
        initialPageCostumeType = initialPageClothingRaw.split(':')[1];
      }
      // Use converted clothing requirements (defined earlier for front cover)
      let initialPagePhotos = getCharacterPhotoDetails(initialPageCharacters, initialPageClothing, initialPageCostumeType, artStyle, convertedPipelineClothingReqs);
      if (initialPageClothing !== 'costumed') {
        initialPagePhotos = applyStyledAvatars(initialPagePhotos, artStyle);
      }
      const initialPagePrompt = inputData.dedication && inputData.dedication.trim()
        ? fillTemplate(PROMPT_TEMPLATES.initialPageWithDedication, {
            INITIAL_PAGE_SCENE: initialPageScene,
            STYLE_DESCRIPTION: styleDescription,
            DEDICATION: inputData.dedication,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, initialPageCharacters),
            VISUAL_BIBLE: visualBiblePrompt
          })
        : fillTemplate(PROMPT_TEMPLATES.initialPageNoDedication, {
            INITIAL_PAGE_SCENE: initialPageScene,
            STYLE_DESCRIPTION: styleDescription,
            STORY_TITLE: storyTitle,
            CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(initialPagePhotos, initialPageCharacters),
            VISUAL_BIBLE: visualBiblePrompt
          });
      coverPrompts.initialPage = initialPagePrompt;

      // Back cover - pass artStyle for styled costumed avatars
      const backCoverClothingRaw = coverScenes.backCover?.clothing || parseClothingCategory(backCoverScene) || 'standard';
      let backCoverClothing = backCoverClothingRaw;
      let backCoverCostumeType = null;
      if (backCoverClothingRaw.startsWith('costumed:')) {
        backCoverClothing = 'costumed';
        backCoverCostumeType = backCoverClothingRaw.split(':')[1];
      }
      // Use converted clothing requirements (defined earlier for front cover)
      let backCoverPhotos = getCharacterPhotoDetails(backCoverCharacters, backCoverClothing, backCoverCostumeType, artStyle, convertedPipelineClothingReqs);
      if (backCoverClothing !== 'costumed') {
        backCoverPhotos = applyStyledAvatars(backCoverPhotos, artStyle);
      }
      const backCoverPrompt = fillTemplate(PROMPT_TEMPLATES.backCover, {
        BACK_COVER_SCENE: backCoverScene,
        STYLE_DESCRIPTION: styleDescription,
        CHARACTER_REFERENCE_LIST: buildCharacterReferenceList(backCoverPhotos, backCoverCharacters),
        VISUAL_BIBLE: visualBiblePrompt
      });
      coverPrompts.backCover = backCoverPrompt;

      // Usage tracker for cover images
      const coverUsageTracker = (imgUsage, qualUsage, imgModel, qualModel) => {
        if (imgUsage) addUsage('gemini_image', imgUsage, 'cover_images', imgModel);
        if (qualUsage) addUsage('gemini_quality', qualUsage, 'cover_quality', qualModel);
      };

      // Model overrides for cover images (use coverImageModel for covers)
      const pipelineCoverModelOverrides = { imageModel: modelOverrides.coverImageModel, qualityModel: modelOverrides.qualityModel };

      // Start all 3 covers in parallel (don't await yet)
      coverGenerationPromise = Promise.all([
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting front cover (${frontCoverCharacters.length} chars, clothing: ${frontCoverClothing})`);
          const result = await generateImageWithQualityRetry(frontCoverPrompt, frontCoverPhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides, 'FRONT COVER', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          console.log(`✅ [COVER-PARALLEL] Front cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (result?.rewriteUsage) {
            addUsage('anthropic', result.rewriteUsage, 'scene_rewrite');
          }
          await saveCheckpoint(jobId, 'partial_cover', { type: 'frontCover', imageData: result.imageData, storyTitle, modelId: result.modelId || null }, 0);
          return { type: 'frontCover', result, photos: frontCoverPhotos, scene: titlePageScene, translatedScene: translatedTitlePageScene, prompt: frontCoverPrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting initial page (${initialPagePhotos.length} chars, clothing: ${initialPageClothing})`);
          const result = await generateImageWithQualityRetry(initialPagePrompt, initialPagePhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides, 'INITIAL PAGE', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          console.log(`✅ [COVER-PARALLEL] Initial page complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (result?.rewriteUsage) {
            addUsage('anthropic', result.rewriteUsage, 'scene_rewrite');
          }
          await saveCheckpoint(jobId, 'partial_cover', { type: 'initialPage', imageData: result.imageData, modelId: result.modelId || null }, 1);
          return { type: 'initialPage', result, photos: initialPagePhotos, scene: initialPageScene, translatedScene: translatedInitialPageScene, prompt: initialPagePrompt };
        })(),
        (async () => {
          log.debug(`📕 [COVER-PARALLEL] Starting back cover (${backCoverPhotos.length} chars, clothing: ${backCoverClothing})`);
          const result = await generateImageWithQualityRetry(backCoverPrompt, backCoverPhotos, null, 'cover', null, coverUsageTracker, null, pipelineCoverModelOverrides, 'BACK COVER', { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode });
          console.log(`✅ [COVER-PARALLEL] Back cover complete (score: ${result.score}${result.wasRegenerated ? ', regenerated' : ''})`);
          // Track scene rewrite usage if a safety block triggered a rewrite
          if (result?.rewriteUsage) {
            addUsage('anthropic', result.rewriteUsage, 'scene_rewrite');
          }
          await saveCheckpoint(jobId, 'partial_cover', { type: 'backCover', imageData: result.imageData, modelId: result.modelId || null }, 2);
          return { type: 'backCover', result, photos: backCoverPhotos, scene: backCoverScene, translatedScene: translatedBackCoverScene, prompt: backCoverPrompt };
        })()
      ]);

      log.debug(`📕 [PIPELINE] Cover generation started in background (3 covers in parallel)`);
    }

    await dbPool.query(
      'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [10, 'Writing story...', jobId]
    );

    // Wait for landmark photos before generating page images
    if (landmarkFetchPromise) {
      await landmarkFetchPromise;
      const successCount = (visualBible.locations || []).filter(l => l.photoFetchStatus === 'success').length;
      log.info(`🌍 [PIPELINE] Landmark photos ready: ${successCount}/${landmarkCount} fetched successfully`);
    }

    // STREAMING PIPELINE: Generate story in batches, immediately generate images as pages complete
    // Use STORY_BATCH_SIZE env var: 0 = auto-calculate based on model limits, >0 = fixed batch size
    let BATCH_SIZE;
    if (STORY_BATCH_SIZE > 0) {
      // Use configured batch size
      BATCH_SIZE = STORY_BATCH_SIZE;
      console.log(`📚 [PIPELINE] Using configured batch size: ${BATCH_SIZE} pages per batch`);
    } else {
      // Auto-calculate optimal batch size based on model token limits and reading level
      // Token estimate: max words/page × 1.3 tokens/word × 2 (safety margin)
      const tokensPerPage = getTokensPerPage(inputData.languageLevel);
      BATCH_SIZE = calculateOptimalBatchSize(sceneCount, tokensPerPage, 1.0); // Full capacity
      console.log(`📚 [PIPELINE] Auto-calculated batch size: ${BATCH_SIZE} pages per batch (${tokensPerPage} tokens/page estimate, model max: ${getActiveTextModel().maxOutputTokens})`);
    }
    const numBatches = Math.ceil(sceneCount / BATCH_SIZE);

    let fullStoryText = '';
    const allImages = [];
    const allSceneDescriptions = [];
    const imagePrompts = {};
    const storyTextPrompts = []; // Collect all story text batch prompts for dev mode

    // Create rate limiter for parallel image generation: max 5 concurrent
    const limit = pLimit(5);
    const MAX_RETRIES = 2;

    // Track active image generation promises
    let activeImagePromises = [];

    log.debug(`📚 [STREAMING] Starting streaming pipeline: ${sceneCount} scenes in ${numBatches} batches of ${BATCH_SIZE}`);

    for (let batchNum = 0; batchNum < numBatches; batchNum++) {
      const startScene = batchNum * BATCH_SIZE + 1;
      const endScene = Math.min((batchNum + 1) * BATCH_SIZE, sceneCount);

      log.debug(`📖 [BATCH ${batchNum + 1}/${numBatches}] Generating scenes ${startScene}-${endScene}`);

      // Generate story text for this batch
      const basePrompt = buildBasePrompt(inputData, sceneCount);
      const readingLevel = getReadingLevel(inputData.languageLevel);

      log.debug(`📝 [BATCH ${batchNum + 1}] Reading level: ${inputData.languageLevel || 'standard'} - ${readingLevel}`);

      // Format Visual Bible for story text prompt
      const visualBibleForPrompt = formatVisualBibleForStoryText(visualBible);

      // Get language instruction for story text
      const { getLanguageInstruction } = require('./languages');
      const storyLanguage = inputData.language || 'en';
      const languageInstruction = getLanguageInstruction(storyLanguage);

      const batchPrompt = PROMPT_TEMPLATES.storyText
        ? fillTemplate(PROMPT_TEMPLATES.storyText, {
            BASE_PROMPT: basePrompt,
            OUTLINE: outline,
            START_PAGE: startScene,
            END_PAGE: endScene,
            START_PAGE_PLUS_1: startScene + 1,
            READING_LEVEL: readingLevel,
            LANGUAGE_INSTRUCTION: languageInstruction,
            VISUAL_BIBLE: visualBibleForPrompt,
            INCLUDE_TITLE: batchNum === 0 ? 'Include the title and dedication before Page 1.' : 'Start directly with Page {START_PAGE} (no title/dedication).'
          })
        : `${basePrompt}

Here is the story outline:
${outline}

IMPORTANT: Now write pages ${startScene} through ${endScene} of the story following the outline above.
${batchNum === 0 ? 'Include the title and dedication at the beginning.' : 'Start directly with the page content (no title/dedication).'}

**CRITICAL PAGE RANGE RULES:**
- You **MUST** write exactly pages ${startScene} through ${endScene} - no more, no less
- **STOP IMMEDIATELY** after completing page ${endScene}
- Do **NOT** write page ${endScene + 1} or any pages beyond ${endScene}, even if the outline mentions them
- The outline shows the full story for context, but you are ONLY responsible for pages ${startScene}-${endScene}
- Ensure there is **exactly one "--- Page X ---" marker per page**

Output Format:
--- Page ${startScene} ---
[Story text...]

...continue until page ${endScene}...`;

      // Store batch prompt for dev mode
      storyTextPrompts.push({
        batch: batchNum + 1,
        startPage: startScene,
        endPage: endScene,
        prompt: batchPrompt
      });

      // Use the full model capacity - no artificial limits
      // Claude stops naturally when done (end_turn), we only pay for tokens actually used
      const batchSceneCount = endScene - startScene + 1;
      const textModelOverride = modelOverrides.textModel || null;
      const textModelConfig = textModelOverride ? TEXT_MODELS[textModelOverride] : getActiveTextModel();
      const batchTokensNeeded = textModelConfig?.maxOutputTokens || getActiveTextModel().maxOutputTokens;
      log.debug(`📝 [BATCH ${batchNum + 1}] Requesting ${batchTokensNeeded} max tokens for ${batchSceneCount} pages - STREAMING${textModelOverride ? ` [model: ${textModelOverride}]` : ''}`);

      // Track which pages have started image generation (for progressive mode)
      const pagesStarted = new Set();
      // Track page texts for passing previous scenes context
      const pageTextsForContext = {};
      // Track clothing categories for previous scenes context (for consistency)
      const pageClothingForContext = {};

      // Scene description model override
      const sceneModelOverride = modelOverrides.sceneDescriptionModel || null;
      const sceneModelConfig = sceneModelOverride ? TEXT_MODELS[sceneModelOverride] : getActiveTextModel();
      const sceneDescProvider = sceneModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';

      // Helper function to start image generation for a page
      const startPageImageGeneration = (pageNum, pageContent) => {
        if (pagesStarted.has(pageNum)) return; // Already started
        if (pageNum < startScene || pageNum > endScene) return; // Outside batch range
        pagesStarted.add(pageNum);

        // Store this page's text for future pages' context
        pageTextsForContext[pageNum] = pageContent;

        const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

        // Build previous scenes context (last 2 pages)
        // Use pageClothingData from outline (reliable) for clothing, not pageClothingForContext (which may not be ready in parallel mode)
        const previousScenes = [];
        for (let prevPage = pageNum - 2; prevPage < pageNum; prevPage++) {
          if (prevPage >= 1 && pageTextsForContext[prevPage]) {
            previousScenes.push({
              pageNumber: prevPage,
              text: pageTextsForContext[prevPage],
              sceneHint: shortSceneDescriptions[prevPage] || '',
              clothing: pageClothingData?.pageClothing?.[prevPage] || pageClothingForContext[prevPage] || null
            });
          }
        }

        // Get current page's clothing from outline
        const currentClothing = pageClothingData?.pageClothing?.[pageNum] || pageClothingData?.primaryClothing || 'standard';

        // Build available avatars - only show clothing categories used in this story
        const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);

        // Generate scene description using Art Director prompt (in story language)
        const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, lang, visualBible, previousScenes, currentClothing, '', availableAvatars);

        // Start scene description + image generation (don't await)
        const imagePromise = limit(async () => {
          try {
            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description...${sceneModelOverride ? ` [model: ${sceneModelOverride}]` : ''}`);

            // Generate detailed scene description (non-streaming for reliability with parallel calls)
            const sceneDescResult = await callTextModel(scenePrompt, 4000, sceneModelOverride, { prefill: '{"previewMismatches":[' });
            let sceneDescription = sceneDescResult.text;

            // Fallback to outline extract if scene description is empty or too short
            if (!sceneDescription || sceneDescription.trim().length < 50) {
              log.warn(`⚠️  [PAGE ${pageNum}] Scene description empty or too short (${sceneDescription?.length || 0} chars), using outline extract`);
              sceneDescription = shortSceneDesc || `Scene for page ${pageNum}`;
            }
            addUsage(sceneDescProvider, sceneDescResult.usage, 'scene_descriptions', sceneModelConfig?.modelId || getActiveTextModel().modelId);

            // Extract translatedSummary and imageSummary from JSON
            let sceneMetadata = extractSceneMetadata(sceneDescription);

            // Scene validation: generate cheap preview, analyze geometry, repair if issues found
            let validationResult = null;
            if (enableSceneValidation && sceneMetadata) {
              try {
                const { validateAndRepairScene, isValidationAvailable } = require('./sceneValidator');
                if (isValidationAvailable()) {
                  log.debug(`🔍 [PAGE ${pageNum}] Running scene composition validation...`);
                  validationResult = await validateAndRepairScene(sceneMetadata);

                  // Track validation costs
                  if (validationResult.usage) {
                    if (validationResult.usage.previewCost) {
                      addUsage('runware', { cost: validationResult.usage.previewCost }, 'scene_validation_preview');
                    }
                    if (validationResult.usage.visionCost || validationResult.usage.comparisonCost) {
                      addUsage('gemini_text', {
                        promptTokenCount: validationResult.usage.visionTokens + validationResult.usage.comparisonTokens,
                        candidatesTokenCount: 0
                      }, 'scene_validation_analysis');
                    }
                    if (validationResult.repair?.usage) {
                      addUsage('anthropic', validationResult.repair.usage, 'scene_validation_repair');
                    }
                  }

                  if (validationResult.wasRepaired) {
                    log.info(`🔧 [PAGE ${pageNum}] Scene repaired: ${validationResult.repair.fixes.length} fixes applied`);
                    // Update scene description with repaired version
                    sceneDescription = JSON.stringify(validationResult.finalScene);
                    sceneMetadata = validationResult.finalScene;
                  } else if (!validationResult.validation.passesCompositionCheck) {
                    log.warn(`⚠️  [PAGE ${pageNum}] Scene has composition issues but repair failed`);
                  } else {
                    log.debug(`✅ [PAGE ${pageNum}] Scene passes composition check`);
                  }
                } else {
                  log.debug(`[PAGE ${pageNum}] Scene validation skipped - Runware or Gemini not configured`);
                }
              } catch (validationError) {
                log.warn(`⚠️  [PAGE ${pageNum}] Scene validation error: ${validationError.message}`);
                // Continue with original scene on validation error
              }
            }

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,
              scenePrompt: scenePrompt,
              textModelId: sceneDescResult.modelId,
              translatedSummary: sceneMetadata?.translatedSummary || null,
              imageSummary: sceneMetadata?.imageSummary || null,
              validationResult: validationResult ? {
                passesCompositionCheck: validationResult.validation?.passesCompositionCheck,
                wasRepaired: validationResult.wasRepaired,
                fixes: validationResult.repair?.fixes || [],
                issues: validationResult.validation?.compositionIssues || []
              } : null
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            const clothingRaw = parseClothingCategory(sceneDescription) || 'standard';
            // Parse costumed:pirate format
            let clothingCategory = clothingRaw;
            let costumeType = null;
            if (clothingRaw.startsWith('costumed:')) {
              clothingCategory = 'costumed';
              costumeType = clothingRaw.split(':')[1];
            }
            // Store clothing for future pages' context (clothing consistency)
            pageClothingForContext[pageNum] = clothingRaw;
            // Pass artStyle and clothingRequirements for per-character costume lookup
            let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, costumeType, artStyle, clothingRequirements);
            // Apply styled avatars for non-costumed characters (costumed already styled via getCharacterPhotoDetails)
            if (clothingCategory !== 'costumed') {
              referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
            }

            // Get landmark photos for this page (fetched early so we can separate primary vs secondary)
            const pageLandmarkPhotos = getLandmarkPhotosForPage(visualBible, pageNum);
            if (pageLandmarkPhotos.length > 0) {
              log.debug(`🌍 [PAGE ${pageNum}] Has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => l.name).join(', ')}`);
            }

            // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
            // VB elements are NO LONGER added individually to referencePhotos
            let vbGrid = null;
            if (visualBible) {
              const elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
              const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
              if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
                vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
                log.debug(`🔲 [PAGE ${pageNum}] VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
              }
            }
            log.debug(`📸 [PAGE ${pageNum}] Generating image (${sceneCharacters.length} characters, clothing: ${clothingRaw})...`);

            // Generate image
            const imagePrompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, false, visualBible, pageNum, false, referencePhotos);
            imagePrompts[pageNum] = imagePrompt;

            let imageResult = null;
            let retries = 0;

            // Callback for immediate display - saves image before quality evaluation completes
            const onImageReady = async (imgData, modelId) => {
              const partialData = {
                pageNumber: pageNum,
                imageData: imgData,
                description: sceneDescription,
                text: pageContent,
                prompt: imagePrompt,
                qualityScore: null,  // Not yet evaluated
                qualityReasoning: null,
                wasRegenerated: false,
                totalAttempts: 1,
                retryHistory: [],
                referencePhotos: referencePhotos,
                modelId: modelId || null
              };
              await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
              log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
            };

            // Usage tracker for page images (5th param isInpaint distinguishes inpaint from generation)
            const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel, isInpaint = false) => {
              if (imgUsage) {
                // Detect provider from model name (Runware uses direct_cost, Gemini uses tokens)
                const isRunware = imgModel && imgModel.startsWith('runware:');
                const provider = isRunware ? 'runware' : 'gemini_image';
                const funcName = isInpaint ? 'inpaint' : 'page_images';
                addUsage(provider, imgUsage, funcName, imgModel);
              }
              if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
            };

            // Pass forceRepairThreshold if set
            const parallelPipelineIncrConfig = incrementalConsistencyConfig?.forceRepairThreshold != null
              ? { forceRepairThreshold: incrementalConsistencyConfig.forceRepairThreshold }
              : null;

            while (retries <= MAX_RETRIES && !imageResult) {
              try {
                // Pass vbGrid for combined reference (instead of individual VB element photos)
                const parallelSceneModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
                imageResult = await generateImageWithQualityRetry(imagePrompt, referencePhotos, null, 'scene', onImageReady, pageUsageTracker, null, parallelSceneModelOverrides, `PAGE ${pageNum}`, { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, incrementalConsistency: parallelPipelineIncrConfig, sceneCharacters });
              } catch (error) {
                retries++;
                log.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
                if (retries > MAX_RETRIES) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
              }
            }

            log.debug(`✅ [PAGE ${pageNum}] Image generated (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

            // Track scene rewrite usage if a safety block triggered a rewrite
            if (imageResult?.rewriteUsage) {
              addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
            }

            const imageData = {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              text: pageContent,
              prompt: imagePrompt,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              landmarkPhotos: pageLandmarkPhotos,  // Dev mode: which landmark photos were used
              visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
              modelId: imageResult.modelId || null
            };

            // Save final result with quality score (overwrites immediate save)
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              text: pageContent,
              prompt: imagePrompt,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              modelId: imageResult.modelId || null
            }, pageNum);
            log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

            return imageData;
          } catch (error) {
            log.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            // Return error result instead of throwing to prevent unhandled rejection crash
            return {
              pageNumber: pageNum,
              imageData: null,
              error: error.message,
              failed: true
            };
          }
        });

        activeImagePromises.push(imagePromise);
      };

      // PROGRESSIVE STREAMING: Start image generation as pages complete during text streaming
      let batchText = '';

      // Track if we've parsed Visual Bible entries from this batch (only do once per batch)
      let visualBibleParsedForBatch = false;

      if (!skipImages && imageGenMode === 'parallel') {
        // Create progressive parser that starts image generation as pages stream in
        const progressiveParser = new ProgressiveStoryPageParser((page) => {
          log.debug(`🌊 [PROGRESSIVE] Page ${page.pageNumber} detected during streaming, starting image generation`);
          startPageImageGeneration(page.pageNumber, page.content);
        });

        // Stream with progressive parsing
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded, (chunk, fullText) => {
          // Check for Visual Bible entries BEFORE pages start (only for first batch)
          if (!visualBibleParsedForBatch && batchNum === 0) {
            // Look for either ---STORY TEXT--- marker or first page marker
            const hasStoryMarker = fullText.includes('---STORY TEXT---');
            const hasPageMarker = fullText.match(/--- Page \d+ ---/i);

            if (hasStoryMarker || hasPageMarker) {
              // Parse and merge new Visual Bible entries BEFORE page 1 image generates
              const newEntries = parseNewVisualBibleEntries(fullText);
              const totalNew = newEntries.animals.length + newEntries.artifacts.length +
                               newEntries.locations.length + newEntries.secondaryCharacters.length;
              if (totalNew > 0) {
                log.debug(`📖 [VISUAL BIBLE] Found ${totalNew} new entries from story text, merging before image generation`);
                mergeNewVisualBibleEntries(visualBible, newEntries);
              }
              visualBibleParsedForBatch = true;
            }
          }
          progressiveParser.processChunk(chunk, fullText);
        }, textModelOverride);
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

        // Finalize to emit the last page
        progressiveParser.finalize(batchText);
        log.debug(`🌊 [PROGRESSIVE] Batch streaming complete, ${pagesStarted.size} pages started during stream`);
      } else {
        // No progressive parsing - just stream text
        const batchResult = await callTextModelStreaming(batchPrompt, batchTokensNeeded, null, textModelOverride);
        batchText = batchResult.text;
        addUsage('anthropic', batchResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

        // Parse Visual Bible entries for non-progressive mode (first batch only)
        if (batchNum === 0) {
          const newEntries = parseNewVisualBibleEntries(batchText);
          const totalNew = newEntries.animals.length + newEntries.artifacts.length +
                           newEntries.locations.length + newEntries.secondaryCharacters.length;
          if (totalNew > 0) {
            log.debug(`📖 [VISUAL BIBLE] Found ${totalNew} new entries from story text, merging`);
            mergeNewVisualBibleEntries(visualBible, newEntries);
          }
        }
      }

      fullStoryText += batchText + '\n\n';
      console.log(`✅ [BATCH ${batchNum + 1}/${numBatches}] Story batch complete (${batchText.length} chars)`);

      // Add raw response to storyTextPrompts for dev mode (unfiltered API response)
      storyTextPrompts[batchNum].rawResponse = batchText;
      storyTextPrompts[batchNum].modelId = textModelConfig?.modelId || getActiveTextModel().modelId;

      // Save checkpoint: story batch (include prompt for debugging)
      await saveCheckpoint(jobId, 'story_batch', { batchNum, batchText, startScene, endScene, batchPrompt }, batchNum);

      // Parse the pages from this batch (for validation and any pages missed by streaming)
      let batchPages = parseStoryPages(batchText);
      log.debug(`📄 [BATCH ${batchNum + 1}/${numBatches}] Parsed ${batchPages.length} pages`);

      // Filter to only include pages in the expected range (Claude sometimes generates extra)
      const unfilteredCount = batchPages.length;
      batchPages = batchPages.filter(p => p.pageNumber >= startScene && p.pageNumber <= endScene);
      if (batchPages.length < unfilteredCount) {
        log.warn(`[BATCH ${batchNum + 1}] Filtered out ${unfilteredCount - batchPages.length} pages outside range ${startScene}-${endScene}`);
      }

      // VALIDATION: Check if all expected pages were generated
      const expectedPageCount = endScene - startScene + 1;
      const parsedPageNumbers = batchPages.map(p => p.pageNumber);
      const missingPages = [];
      for (let p = startScene; p <= endScene; p++) {
        if (!parsedPageNumbers.includes(p)) {
          missingPages.push(p);
        }
      }

      // RETRY: If pages are missing, request them explicitly
      if (missingPages.length > 0) {
        log.warn(`[BATCH ${batchNum + 1}] Missing pages: ${missingPages.join(', ')}. Retrying for missing pages...`);

        for (const missingPageNum of missingPages) {
          const retryPrompt = `${basePrompt}

Here is the story outline:
${outline}

CRITICAL: You MUST write ONLY page ${missingPageNum} of the story. This page was missing from the previous generation.

Look at what you already wrote for context:
${batchText}

Now write ONLY page ${missingPageNum}. Use EXACTLY this format:

--- Page ${missingPageNum} ---
[Write the story text for page ${missingPageNum} here, following the outline and maintaining continuity with other pages]`;

          log.debug(` Generating missing page ${missingPageNum}...`);
          const retryResult = await callTextModelStreaming(retryPrompt, 1500, null, textModelOverride);
          const retryText = retryResult.text;
          addUsage('anthropic', retryResult.usage, 'story_text', textModelConfig?.modelId || getActiveTextModel().modelId);

          // Parse the retry response
          const retryPages = parseStoryPages(retryText);
          if (retryPages.length > 0) {
            console.log(`✅ [RETRY] Successfully generated page ${missingPageNum}`);
            batchPages.push(...retryPages);
            fullStoryText += retryText + '\n\n';

            // Start image generation for retry page too
            if (!skipImages && imageGenMode === 'parallel') {
              for (const retryPage of retryPages) {
                startPageImageGeneration(retryPage.pageNumber, retryPage.content);
              }
            }
          } else {
            log.error(`[RETRY] Failed to parse page ${missingPageNum} from retry response`);
          }
        }

        // Sort pages by page number after adding retried pages
        batchPages.sort((a, b) => a.pageNumber - b.pageNumber);
        log.debug(`📄 [BATCH ${batchNum + 1}/${numBatches}] After retry: ${batchPages.length} pages`);
      }

      // Start image generation for any pages that weren't caught by progressive streaming
      // (fallback for edge cases)
      if (!skipImages && imageGenMode === 'parallel') {
        for (const page of batchPages) {
          if (!pagesStarted.has(page.pageNumber)) {
            console.log(`📝 [FALLBACK] Starting image for page ${page.pageNumber} (missed by streaming)`);
            startPageImageGeneration(page.pageNumber, page.content);
          }
        }
      }

      // Update progress after each batch
      const storyProgress = 10 + Math.floor((batchNum + 1) / numBatches * 30); // 10-40%
      const completedImageCount = allImages.length;
      // Show simple progress: either writing or which image we're on
      const progressMsg = completedImageCount > 0
        ? `Image ${completedImageCount}/${sceneCount}...`
        : 'Writing story...';

      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [storyProgress, progressMsg, jobId]
      );
    }

    // Clean up fullStoryText to remove Visual Bible section (keep only story pages)
    fullStoryText = extractStoryTextFromOutput(fullStoryText);

    // Save story_text checkpoint so client can display text while images generate
    // Parse all pages from the full story text and build page text map
    const allStoryPages = parseStoryPages(fullStoryText);
    const pageTextMap = {};
    allStoryPages.forEach(page => {
      pageTextMap[page.pageNumber] = page.content;
    });

    // Calculate actual print page count:
    // Picture book (1st-grade): 1 page per scene
    // Standard/Advanced: 2 pages per scene (text page + image page)
    // Note: isPictureBookLayout is already defined above based on generationMode
    const printPageCount = isPictureBookLayout ? sceneCount : sceneCount * 2;

    await saveCheckpoint(jobId, 'story_text', {
      title: storyTitle,
      dedication: inputData.dedication || '',
      pageTexts: pageTextMap,
      sceneDescriptions: allSceneDescriptions.map(sd => ({
        pageNumber: sd.pageNumber,
        description: sd.description || '',
        outlineExtract: shortSceneDescriptions[sd.pageNumber] || '',
        scenePrompt: sd.scenePrompt || '',
        textModelId: sd.textModelId || ''
      })),
      totalPages: printPageCount  // Use print page count for accurate display
    });
    log.debug(`💾 [STORY] Saved story_text checkpoint with ${Object.keys(pageTextMap).length} scenes = ${printPageCount} print pages for progressive display`);

    // Wait for images only if not skipping
    if (!skipImages) {
      if (imageGenMode === 'parallel') {
        // PARALLEL MODE: Wait for all concurrent image promises
        log.debug(`📚 [STREAMING] All story batches submitted. Waiting for ${activeImagePromises.length} images to complete (PARALLEL MODE)...`);

        // Wait for all images to complete
        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [50, `Image 1/${sceneCount}...`, jobId]
        );

        let completedCount = 0;
        let failedCount = 0;
        const imageResults = await Promise.all(
          activeImagePromises.map(async (promise) => {
            const result = await promise;
            completedCount++;

            // Update progress
            const imageProgress = 50 + Math.floor(completedCount / sceneCount * 40); // 50-90%
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [imageProgress, `Image ${completedCount}/${sceneCount}...`, jobId]
            );

            // Only add successful results to allImages
            if (result.failed) {
              failedCount++;
              log.warn(`⚠️  [PARALLEL] Page ${result.pageNumber} failed: ${result.error}`);
            } else {
              allImages.push(result);
            }
            return result;
          })
        );

        // Sort images by page number
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        if (failedCount > 0) {
          log.warn(`⚠️  [STREAMING] ${failedCount}/${sceneCount} images failed to generate`);
        }
        log.debug(`🚀 [STREAMING] ${allImages.length}/${sceneCount} images generated (PARALLEL MODE)!`);
      } else {
        // SEQUENTIAL MODE: Generate images one at a time, passing previous image to next
        log.debug(`📚 [STREAMING] All story batches complete. Starting SEQUENTIAL image generation...`);

        // Parse all pages from the full story text
        let allPages = parseStoryPages(fullStoryText);

        // Deduplicate pages - keep only first occurrence of each page number
        const seenPages = new Set();
        const beforeDedup = allPages.length;
        allPages = allPages.filter(page => {
          if (seenPages.has(page.pageNumber)) {
            log.warn(`[SEQUENTIAL] Removing duplicate page ${page.pageNumber}`);
            return false;
          }
          seenPages.add(page.pageNumber);
          return true;
        });
        if (allPages.length < beforeDedup) {
          log.warn(`[SEQUENTIAL] Removed ${beforeDedup - allPages.length} duplicate pages`);
        }

        log.debug(`📄 [SEQUENTIAL] Found ${allPages.length} pages to generate images for`);

        await dbPool.query(
          'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
          [50, `Image 1/${allPages.length}...`, jobId]
        );

        let previousImage = null;
        const pageTextsForContext = {}; // Track page texts for previous scenes context
        const pageClothingForContext = {}; // Track clothing for consistency
        const previousImagesForConsistency = []; // Track images for incremental consistency checks

        // Scene description model override for sequential mode
        const seqSceneModelOverride = modelOverrides.sceneDescriptionModel || null;
        const seqSceneModelConfig = seqSceneModelOverride ? TEXT_MODELS[seqSceneModelOverride] : getActiveTextModel();
        const seqSceneDescProvider = seqSceneModelConfig?.provider === 'google' ? 'gemini_text' : 'anthropic';

        for (let i = 0; i < allPages.length; i++) {
          const page = allPages[i];
          const pageNum = page.pageNumber;
          const pageContent = page.content;
          const shortSceneDesc = shortSceneDescriptions[pageNum] || '';

          // Store this page's text for future context
          pageTextsForContext[pageNum] = pageContent;

          // Build previous scenes context (last 2 pages)
          // Use pageClothingData from outline (reliable) for clothing
          const previousScenes = [];
          for (let prevPage = pageNum - 2; prevPage < pageNum; prevPage++) {
            if (prevPage >= 1 && pageTextsForContext[prevPage]) {
              previousScenes.push({
                pageNumber: prevPage,
                text: pageTextsForContext[prevPage],
                sceneHint: shortSceneDescriptions[prevPage] || '',
                clothing: pageClothingData?.pageClothing?.[prevPage] || pageClothingForContext[prevPage] || null
              });
            }
          }

          log.debug(`🔗 [SEQUENTIAL ${i + 1}/${allPages.length}] Processing page ${pageNum}...`);

          // Get current page's clothing from outline
          const currentClothing = pageClothingData?.pageClothing?.[pageNum] || pageClothingData?.primaryClothing || 'standard';

          // Build available avatars - only show clothing categories used in this story
          const availableAvatars = buildAvailableAvatarsForPrompt(inputData.characters || [], clothingRequirements);

          try {
            // Generate scene description using Art Director prompt (in story language)
            // Pass visualBible so recurring elements are included in scene description
            const scenePrompt = buildSceneDescriptionPrompt(pageNum, pageContent, inputData.characters || [], shortSceneDesc, lang, visualBible, previousScenes, currentClothing, '', availableAvatars);

            log.debug(`🎨 [PAGE ${pageNum}] Generating scene description...${seqSceneModelOverride ? ` [model: ${seqSceneModelOverride}]` : ''}`);
            const sceneDescResult = await callTextModel(scenePrompt, 4000, seqSceneModelOverride, { prefill: '{"previewMismatches":[' });
            let sceneDescription = sceneDescResult.text;

            // Fallback to outline extract if scene description is empty or too short
            if (!sceneDescription || sceneDescription.trim().length < 50) {
              log.warn(`⚠️  [PAGE ${pageNum}] Scene description empty or too short (${sceneDescription?.length || 0} chars), using outline extract`);
              sceneDescription = shortSceneDesc || `Scene for page ${pageNum}`;
            }
            addUsage(seqSceneDescProvider, sceneDescResult.usage, 'scene_descriptions', seqSceneModelConfig?.modelId || getActiveTextModel().modelId);

            // Extract translatedSummary and imageSummary from JSON
            let sceneMetadata = extractSceneMetadata(sceneDescription);

            // Scene validation: generate cheap preview, analyze geometry, repair if issues found
            let validationResult = null;
            if (enableSceneValidation && sceneMetadata) {
              try {
                const { validateAndRepairScene, isValidationAvailable } = require('./sceneValidator');
                if (isValidationAvailable()) {
                  log.debug(`🔍 [PAGE ${pageNum}] Running scene composition validation...`);
                  validationResult = await validateAndRepairScene(sceneMetadata);

                  // Track validation costs
                  if (validationResult.usage) {
                    if (validationResult.usage.previewCost) {
                      addUsage('runware', { cost: validationResult.usage.previewCost }, 'scene_validation_preview');
                    }
                    if (validationResult.usage.visionCost || validationResult.usage.comparisonCost) {
                      addUsage('gemini_text', {
                        promptTokenCount: validationResult.usage.visionTokens + validationResult.usage.comparisonTokens,
                        candidatesTokenCount: 0
                      }, 'scene_validation_analysis');
                    }
                    if (validationResult.repair?.usage) {
                      addUsage('anthropic', validationResult.repair.usage, 'scene_validation_repair');
                    }
                  }

                  if (validationResult.wasRepaired) {
                    log.info(`🔧 [PAGE ${pageNum}] Scene repaired: ${validationResult.repair.fixes.length} fixes applied`);
                    // Update scene description with repaired version
                    sceneDescription = JSON.stringify(validationResult.finalScene);
                    sceneMetadata = validationResult.finalScene;
                  } else if (!validationResult.validation.passesCompositionCheck) {
                    log.warn(`⚠️  [PAGE ${pageNum}] Scene has composition issues but repair failed`);
                  } else {
                    log.debug(`✅ [PAGE ${pageNum}] Scene passes composition check`);
                  }
                } else {
                  log.debug(`[PAGE ${pageNum}] Scene validation skipped - Runware or Gemini not configured`);
                }
              } catch (validationError) {
                log.warn(`⚠️  [PAGE ${pageNum}] Scene validation error: ${validationError.message}`);
                // Continue with original scene on validation error
              }
            }

            allSceneDescriptions.push({
              pageNumber: pageNum,
              description: sceneDescription,
              outlineExtract: shortSceneDesc,  // Store the outline extract for debugging
              scenePrompt: scenePrompt,        // Store the Art Director prompt for debugging
              textModelId: sceneDescResult.modelId,
              translatedSummary: sceneMetadata?.translatedSummary || null,
              imageSummary: sceneMetadata?.imageSummary || null,
              validationResult: validationResult ? {
                passesCompositionCheck: validationResult.validation?.passesCompositionCheck,
                wasRepaired: validationResult.wasRepaired,
                fixes: validationResult.repair?.fixes || [],
                issues: validationResult.validation?.compositionIssues || []
              } : null
            });

            // Detect which characters appear in this scene
            const sceneCharacters = getCharactersInScene(sceneDescription, inputData.characters || []);
            // Parse clothing category from scene description
            const clothingRaw = parseClothingCategory(sceneDescription) || 'standard';
            // Parse costumed:pirate format
            let clothingCategory = clothingRaw;
            let costumeType = null;
            if (clothingRaw.startsWith('costumed:')) {
              clothingCategory = 'costumed';
              costumeType = clothingRaw.split(':')[1];
            }
            // Store clothing for future pages' context (clothing consistency)
            pageClothingForContext[pageNum] = clothingRaw;
            // Use detailed photo info (with names) for labeled reference images
            // Pass artStyle and clothingRequirements for per-character costume lookup
            let referencePhotos = getCharacterPhotoDetails(sceneCharacters, clothingCategory, costumeType, artStyle, clothingRequirements);
            // Apply styled avatars for non-costumed characters (costumed already styled via getCharacterPhotoDetails)
            if (clothingCategory !== 'costumed') {
              referencePhotos = applyStyledAvatars(referencePhotos, artStyle);
            }

            // Get landmark photos for this page (fetched early so we can separate primary vs secondary)
            const pageLandmarkPhotos = getLandmarkPhotosForPage(visualBible, pageNum);
            if (pageLandmarkPhotos.length > 0) {
              log.debug(`🌍 [PAGE ${pageNum}] Has ${pageLandmarkPhotos.length} landmark(s): ${pageLandmarkPhotos.map(l => l.name).join(', ')}`);
            }

            // Build Visual Bible grid (combines VB elements + secondary landmarks into single image)
            // VB elements are NO LONGER added individually to referencePhotos
            let vbGrid = null;
            if (visualBible) {
              const elementReferences = getElementReferenceImagesForPage(visualBible, pageNum, 6);
              const secondaryLandmarks = pageLandmarkPhotos.slice(1); // 2nd+ landmarks go in grid
              if (elementReferences.length > 0 || secondaryLandmarks.length > 0) {
                vbGrid = await buildVisualBibleGrid(elementReferences, secondaryLandmarks);
                log.debug(`🔲 [PAGE ${pageNum}] VB grid: ${elementReferences.length} elements + ${secondaryLandmarks.length} secondary landmarks`);
              }
            }
            log.debug(`📸 [PAGE ${pageNum}] Generating image (${sceneCharacters.length} characters: ${sceneCharacters.map(c => c.name).join(', ') || 'none'}, clothing: ${clothingRaw})...`);

            // Generate image from scene description with scene-specific characters and visual bible
            const imagePrompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, true, visualBible, pageNum, false, referencePhotos);
            imagePrompts[pageNum] = imagePrompt;

            let imageResult = null;
            let retries = 0;

            // Callback for immediate display - saves image before quality evaluation completes
            const onImageReady = async (imgData, modelId) => {
              const partialData = {
                pageNumber: pageNum,
                imageData: imgData,
                description: sceneDescription,
                prompt: imagePrompt,
                text: pageContent,
                qualityScore: null,  // Not yet evaluated
                qualityReasoning: null,
                wasRegenerated: false,
                totalAttempts: 1,
                retryHistory: [],
                referencePhotos: referencePhotos,
                modelId: modelId || null
              };
              await saveCheckpoint(jobId, 'partial_page', partialData, pageNum);
              log.debug(`💾 [PARTIAL] Saved partial result for page ${pageNum} (immediate, quality pending)`);
            };

            // Usage tracker for page images (5th param isInpaint distinguishes inpaint from generation)
            const pageUsageTracker = (imgUsage, qualUsage, imgModel, qualModel, isInpaint = false) => {
              if (imgUsage) {
                // Detect provider from model name (Runware uses direct_cost, Gemini uses tokens)
                const isRunware = imgModel && imgModel.startsWith('runware:');
                const provider = isRunware ? 'runware' : 'gemini_image';
                const funcName = isInpaint ? 'inpaint' : 'page_images';
                addUsage(provider, imgUsage, funcName, imgModel);
              }
              if (qualUsage) addUsage('gemini_quality', qualUsage, 'page_quality', qualModel);
            };

            // Build incrementalConsistency options with previous images
            let incrementalConsistencyConfig = null;
            if (enableIncrementalConsistency && previousImagesForConsistency.length > 0) {
              // Get last N images for comparison
              const lookbackImages = previousImagesForConsistency.slice(-incrementalConsistencyLookback);
              incrementalConsistencyConfig = {
                enabled: true,
                dryRun: incrementalConsistencyDryRun,
                lookbackCount: incrementalConsistencyLookback,
                previousImages: lookbackImages,
                currentCharacters: sceneCharacters.map(c => c.name)  // Tell model which characters are in THIS scene
              };
            }

            while (retries <= MAX_RETRIES && !imageResult) {
              try {
                // Pass labeled character photos (name + photoUrl) + previous image for continuity (SEQUENTIAL MODE)
                // Pass vbGrid for combined reference (instead of individual VB element photos)
                // Use quality retry to regenerate if score is below threshold
                const seqPipelineModelOverrides = { imageModel: modelOverrides.imageModel, qualityModel: modelOverrides.qualityModel };
                imageResult = await generateImageWithQualityRetry(
                  imagePrompt, referencePhotos, previousImage, 'scene', onImageReady, pageUsageTracker, null, seqPipelineModelOverrides, `PAGE ${pageNum}`,
                  { isAdmin, enableAutoRepair, useGridRepair, checkOnlyMode, landmarkPhotos: pageLandmarkPhotos, visualBibleGrid: vbGrid, incrementalConsistency: incrementalConsistencyConfig, sceneCharacters }
                );
              } catch (error) {
                retries++;
                log.error(`❌ [PAGE ${pageNum}] Image generation attempt ${retries} failed:`, error.message);
                if (retries > MAX_RETRIES) {
                  throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
              }
            }

            log.debug(`✅ [PAGE ${pageNum}] Image generated successfully (score: ${imageResult.score}${imageResult.wasRegenerated ? ', regenerated' : ''})`);

            // Track scene rewrite usage if a safety block triggered a rewrite
            if (imageResult?.rewriteUsage) {
              addUsage('anthropic', imageResult.rewriteUsage, 'scene_rewrite');
            }

            // Store this image as the previous image for the next iteration
            previousImage = imageResult.imageData;

            // Store image data for incremental consistency checks on future pages
            if (enableIncrementalConsistency) {
              // Build clothing info for each character in this scene
              const clothingInfo = {};
              for (const char of sceneCharacters) {
                const charClothing = char.clothing?.current?.[clothingCategory] || char.clothing?.current?.standard || null;
                clothingInfo[char.name] = charClothing
                  ? `${charClothing.top || ''} ${charClothing.bottom || ''} ${charClothing.accessories || ''}`.trim()
                  : clothingRaw;
              }
              previousImagesForConsistency.push({
                imageData: imageResult.imageData,
                pageNumber: pageNum,
                characters: sceneCharacters.map(c => c.name),
                clothing: clothingInfo
              });
            }

            const imageData = {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              prompt: imagePrompt,
              text: pageContent,  // Include page text for progressive display
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,  // Dev mode: which photos were used
              landmarkPhotos: pageLandmarkPhotos,
              visualBibleGrid: vbGrid ? `data:image/jpeg;base64,${vbGrid.toString('base64')}` : null,
              modelId: imageResult.modelId || null
            };

            // Save final result with quality score (overwrites immediate save)
            await saveCheckpoint(jobId, 'partial_page', {
              pageNumber: pageNum,
              imageData: imageResult.imageData,
              description: sceneDescription,
              prompt: imagePrompt,
              text: pageContent,
              qualityScore: imageResult.score,
              qualityReasoning: imageResult.reasoning || null,
              qualityModelId: imageResult.qualityModelId || null,
              fixTargets: imageResult.fixTargets || [],  // Bounding boxes for auto-repair
              wasRegenerated: imageResult.wasRegenerated || false,
              totalAttempts: imageResult.totalAttempts || 1,
              retryHistory: imageResult.retryHistory || [],
              originalImage: imageResult.originalImage || null,
              originalScore: imageResult.originalScore || null,
              originalReasoning: imageResult.originalReasoning || null,
              referencePhotos: referencePhotos,
              modelId: imageResult.modelId || null
            }, pageNum);
            log.debug(`💾 [PARTIAL] Saved final result for page ${pageNum} (score: ${imageResult.score})`);

            allImages.push(imageData);

            // Update progress
            const imageProgress = 50 + Math.floor((i + 1) / allPages.length * 40); // 50-90%
            await dbPool.query(
              'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
              [imageProgress, `Image ${i + 1}/${allPages.length}...`, jobId]
            );
          } catch (error) {
            log.error(`❌ [PAGE ${pageNum}] Failed to generate:`, error.message);
            throw error;
          }
        }

        // Sort images by page number (should already be in order, but ensure consistency)
        allImages.sort((a, b) => a.pageNumber - b.pageNumber);
        allSceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);

        log.debug(`🚀 [STREAMING] All ${allImages.length} images generated (SEQUENTIAL MODE)!`);
      }
    } else {
      log.debug(`📝 [STREAMING] Text-only mode - skipping image wait`);
    }

    // Update title from story text if we found a better one (optional refinement)
    if (fullStoryText) {
      const storyTitleMatch = fullStoryText.match(/^#\s+(.+?)$/m);
      if (storyTitleMatch) {
        const storyTextTitle = storyTitleMatch[1].trim();
        if (storyTextTitle !== storyTitle) {
          log.debug(`📖 [PIPELINE] Story text has different title: "${storyTextTitle}" (outline had: "${storyTitle}")`);
          // Keep the outline title since covers already used it
        }
      }
    }

    // Wait for parallel cover generation to complete
    let coverImages = null;

    if (coverGenerationPromise) {
      log.debug(`📕 [PIPELINE] Waiting for parallel cover generation to complete...`);
      await dbPool.query(
        'UPDATE story_jobs SET progress = $1, progress_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [95, 'Finishing covers...', jobId]
      );

      try {
        const coverResults = await coverGenerationPromise;
        console.log(`✅ [PIPELINE] All 3 covers completed in parallel!`);

        // Build coverImages object from results
        const frontCover = coverResults.find(r => r.type === 'frontCover');
        const initialPage = coverResults.find(r => r.type === 'initialPage');
        const backCover = coverResults.find(r => r.type === 'backCover');

        coverImages = {
          frontCover: {
            imageData: frontCover.result.imageData,
            description: frontCover.scene,
            translatedDescription: frontCover.translatedScene,
            prompt: frontCover.prompt,
            qualityScore: frontCover.result.score,
            qualityReasoning: frontCover.result.reasoning || null,
            fixTargets: frontCover.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: frontCover.result.wasRegenerated || false,
            totalAttempts: frontCover.result.totalAttempts || 1,
            retryHistory: frontCover.result.retryHistory || [],
            originalImage: frontCover.result.originalImage || null,
            originalScore: frontCover.result.originalScore || null,
            originalReasoning: frontCover.result.originalReasoning || null,
            referencePhotos: frontCover.photos,
            modelId: frontCover.result.modelId || null,
            bboxDetection: frontCover.result.bboxDetection || null,
            bboxOverlayImage: frontCover.result.bboxOverlayImage || null
          },
          initialPage: {
            imageData: initialPage.result.imageData,
            description: initialPage.scene,
            translatedDescription: initialPage.translatedScene,
            prompt: initialPage.prompt,
            qualityScore: initialPage.result.score,
            qualityReasoning: initialPage.result.reasoning || null,
            fixTargets: initialPage.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: initialPage.result.wasRegenerated || false,
            totalAttempts: initialPage.result.totalAttempts || 1,
            retryHistory: initialPage.result.retryHistory || [],
            originalImage: initialPage.result.originalImage || null,
            originalScore: initialPage.result.originalScore || null,
            originalReasoning: initialPage.result.originalReasoning || null,
            referencePhotos: initialPage.photos,
            modelId: initialPage.result.modelId || null,
            bboxDetection: initialPage.result.bboxDetection || null,
            bboxOverlayImage: initialPage.result.bboxOverlayImage || null
          },
          backCover: {
            imageData: backCover.result.imageData,
            description: backCover.scene,
            translatedDescription: backCover.translatedScene,
            prompt: backCover.prompt,
            qualityScore: backCover.result.score,
            qualityReasoning: backCover.result.reasoning || null,
            fixTargets: backCover.result.fixTargets || [],  // Bounding boxes for auto-repair
            wasRegenerated: backCover.result.wasRegenerated || false,
            totalAttempts: backCover.result.totalAttempts || 1,
            retryHistory: backCover.result.retryHistory || [],
            originalImage: backCover.result.originalImage || null,
            originalScore: backCover.result.originalScore || null,
            originalReasoning: backCover.result.originalReasoning || null,
            referencePhotos: backCover.photos,
            modelId: backCover.result.modelId || null,
            bboxDetection: backCover.result.bboxDetection || null,
            bboxOverlayImage: backCover.result.bboxOverlayImage || null
          }
        };

        const frontRegen = frontCover.result.wasRegenerated ? ' (regenerated)' : '';
        const initialRegen = initialPage.result.wasRegenerated ? ' (regenerated)' : '';
        const backRegen = backCover.result.wasRegenerated ? ' (regenerated)' : '';
        log.debug(`📊 [PIPELINE] Cover quality scores - Front: ${frontCover.result.score}${frontRegen}, Initial: ${initialPage.result.score}${initialRegen}, Back: ${backCover.result.score}${backRegen}`);
      } catch (error) {
        log.error(`❌ [PIPELINE] Cover generation failed:`, error);
        throw new Error(`Cover generation failed: ${error.message}`);
      }
    } else if (!skipImages && !skipCovers) {
      log.warn(`[PIPELINE] No cover generation promise found - covers may have been skipped`);
    } else {
      log.debug(`📝 [PIPELINE] Text-only mode - skipping cover image generation`);
    }

    // Job complete - save result
    const resultData = {
      outline,
      outlinePrompt,  // API prompt for outline (dev mode)
      outlineModelId: outlineModelUsed,  // Model used for outline (dev mode)
      storyTextPrompts, // API prompts for story text batches (dev mode)
      visualBible, // Visual Bible for recurring element consistency (dev mode)
      storyText: fullStoryText,
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages,
      imagePrompts,
      coverPrompts,  // Cover image prompts for dev mode
      styledAvatarGeneration: getStyledAvatarGenerationLog(),  // Styled avatar generation log for dev mode
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(),  // Costumed avatar generation log for dev mode
      title: storyTitle,
      textOnly: skipImages // Mark if this was text-only generation
    };

    log.debug('📖 [SERVER] resultData keys:', Object.keys(resultData));
    log.debug('📖 [SERVER] storyText exists?', !!resultData.storyText);
    log.debug('📖 [SERVER] storyText length:', resultData.storyText?.length || 0);
    log.verbose('📖 [SERVER] storyText preview:', resultData.storyText?.substring(0, 200));

    // Persist styled avatars to character data before saving story
    if (artStyle !== 'realistic' && inputData.characters) {
      try {
        const cacheStats = getStyledAvatarCacheStats();
        log.debug(`💾 [PIPELINE] Cache before export: ${cacheStats.size} entries, ${cacheStats.inProgress} in progress`);
        const styledAvatarsMap = exportStyledAvatarsForPersistence(inputData.characters, artStyle);
        log.debug(`💾 [PIPELINE] Export returned ${styledAvatarsMap.size} character sets for ${artStyle}`);
        for (const [name, avatars] of styledAvatarsMap) {
          log.debug(`   - "${name}": ${Object.keys(avatars).join(', ')}`);
        }
        if (styledAvatarsMap.size > 0) {
          log.debug(`💾 [PIPELINE] Persisting ${styledAvatarsMap.size} styled avatar sets to character data...`);
          for (const char of inputData.characters) {
            const styledAvatars = styledAvatarsMap.get(char.name);
            if (styledAvatars) {
              if (!char.avatars) char.avatars = {};
              if (!char.avatars.styledAvatars) char.avatars.styledAvatars = {};
              char.avatars.styledAvatars[artStyle] = styledAvatars;
              log.debug(`  - ${char.name}: ${Object.keys(styledAvatars).length} ${artStyle} avatars saved`);
            }
          }

          // Also persist styled avatars to the characters table
          try {
            const characterId = `characters_${userId}`;
            log.debug(`💾 [PIPELINE] Looking up characters table with id: ${characterId}`);
            const charResult = await dbPool.query('SELECT data FROM characters WHERE id = $1', [characterId]);
            if (charResult.rows.length > 0) {
              // Handle both TEXT and JSONB column types
              const rawData = charResult.rows[0].data;
              const charData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
              const chars = charData.characters || [];
              log.debug(`💾 [PIPELINE] Found ${chars.length} characters in DB: ${chars.map(c => `"${c.name}"`).join(', ')}`);
              let updatedCount = 0;
              for (const dbChar of chars) {
                const styledAvatars = styledAvatarsMap.get(dbChar.name);
                if (styledAvatars) {
                  if (!dbChar.avatars) dbChar.avatars = {};
                  if (!dbChar.avatars.styledAvatars) dbChar.avatars.styledAvatars = {};
                  dbChar.avatars.styledAvatars[artStyle] = styledAvatars;
                  updatedCount++;
                  log.debug(`   ✓ Matched "${dbChar.name}" with ${Object.keys(styledAvatars).length} styled avatars`);
                } else {
                  log.debug(`   ✗ No match for "${dbChar.name}" in styledAvatarsMap`);
                }
              }
              if (updatedCount > 0) {
                charData.characters = chars;
                await dbPool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(charData), characterId]);
                log.debug(`💾 [PIPELINE] Updated ${updatedCount} characters in database with ${artStyle} styled avatars`);
              } else {
                log.debug(`💾 [PIPELINE] No characters matched for styled avatar update`);
              }
            } else {
              log.debug(`💾 [PIPELINE] No characters table entry found for ${characterId}`);
            }
          } catch (dbError) {
            log.error(`⚠️ [PIPELINE] Failed to persist styled avatars to characters table:`, dbError.message);
          }
        } else {
          log.debug(`💾 [PIPELINE] No styled avatars to persist (cache empty for ${artStyle})`);
        }
      } catch (error) {
        log.error(`⚠️ [PIPELINE] Failed to persist styled avatars:`, error.message);
      }
    }

    // Save story to stories table so it appears in My Stories
    storyId = jobId; // Use jobId as storyId for consistency
    const storyData = {
      id: storyId,
      title: storyTitle,
      storyType: inputData.storyType || '',
      storyTypeName: inputData.storyTypeName || '', // Display name for story type
      storyCategory: inputData.storyCategory || '', // adventure, life-challenge, educational
      storyTopic: inputData.storyTopic || '', // Specific topic within category
      storyTheme: inputData.storyTheme || '', // Theme/setting for the story
      storyDetails: inputData.storyDetails || '', // User's custom story idea
      artStyle: inputData.artStyle || 'pixar',
      language: inputData.language || 'en',
      languageLevel: inputData.languageLevel || '1st-grade',
      pages: inputData.pages || sceneCount,
      dedication: inputData.dedication || '',
      season: inputData.season || '',
      userLocation: inputData.userLocation || null,
      characters: inputData.characters || [],
      mainCharacters: inputData.mainCharacters || [],
      relationships: inputData.relationships || {},
      relationshipTexts: inputData.relationshipTexts || {},
      outline: outline,
      outlinePrompt: outlinePrompt, // API prompt for outline (dev mode)
      outlineModelId: outlineModelUsed, // Model used for outline (dev mode)
      outlineUsage: outlineUsage, // Token usage for outline (dev mode)
      storyTextPrompts: storyTextPrompts, // API prompts for story text (dev mode)
      storyText: fullStoryText,
      originalStory: fullStoryText, // Store original for restore functionality
      sceneDescriptions: allSceneDescriptions,
      sceneImages: allImages,
      coverImages: coverImages,
      visualBible: visualBible, // Visual Bible for recurring element consistency (dev mode)
      pageClothing: pageClothingData, // Clothing per page extracted from outline
      clothingRequirements: clothingRequirements, // Per-character clothing requirements
      tokenUsage: JSON.parse(JSON.stringify(tokenUsage, (k, v) => v instanceof Set ? [...v] : v)), // Token usage (Sets to Arrays)
      styledAvatarGeneration: getStyledAvatarGenerationLog(), // Styled avatar generation log (dev mode)
      costumedAvatarGeneration: getCostumedAvatarGenerationLog(), // Costumed avatar generation log (dev mode)
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Log token usage summary with costs (including thinking tokens)
    const totalInputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].input_tokens || 0), 0);
    const totalOutputTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + (tokenUsage[k].output_tokens || 0), 0);
    const totalThinkingTokens = Object.keys(tokenUsage).filter(k => k !== 'byFunction').reduce((sum, k) => sum + tokenUsage[k].thinking_tokens, 0);
    const anthropicCost = calculateCost('anthropic', tokenUsage.anthropic.input_tokens, tokenUsage.anthropic.output_tokens, tokenUsage.anthropic.thinking_tokens);
    const geminiQualityCost = calculateCost('gemini_quality', tokenUsage.gemini_quality.input_tokens, tokenUsage.gemini_quality.output_tokens, tokenUsage.gemini_quality.thinking_tokens);
    // Calculate image costs using per-image pricing (not token-based)
    const byFunc = tokenUsage.byFunction;
    const getModels = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models).join(', ') : 'N/A';
    const imageCost = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed']
      .reduce((sum, fn) => sum + (byFunc[fn]?.calls > 0 ? calculateImageCost(getModels(byFunc[fn]), byFunc[fn].calls) : 0), 0);
    const totalCost = anthropicCost.total + imageCost + geminiQualityCost.total;
    log.debug(`📊 [PIPELINE] Token usage & cost summary:`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY PROVIDER:`);
    const thinkingAnthropicStr = tokenUsage.anthropic.thinking_tokens > 0 ? ` / ${tokenUsage.anthropic.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    const thinkingQualityStr = tokenUsage.gemini_quality.thinking_tokens > 0 ? ` / ${tokenUsage.gemini_quality.thinking_tokens.toLocaleString().padStart(6)} think` : '';
    log.debug(`   Anthropic:     ${tokenUsage.anthropic.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.anthropic.output_tokens.toLocaleString().padStart(8)} out${thinkingAnthropicStr} (${tokenUsage.anthropic.calls} calls)  $${anthropicCost.total.toFixed(4)}`);
    log.debug(`   Gemini Image:  ${tokenUsage.gemini_image.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_image.output_tokens.toLocaleString().padStart(8)} out (${tokenUsage.gemini_image.calls} calls)  $${imageCost.toFixed(4)}`);
    log.debug(`   Gemini Quality:${tokenUsage.gemini_quality.input_tokens.toLocaleString().padStart(8)} in / ${tokenUsage.gemini_quality.output_tokens.toLocaleString().padStart(8)} out${thinkingQualityStr} (${tokenUsage.gemini_quality.calls} calls)  $${geminiQualityCost.total.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    log.debug(`   BY FUNCTION:`);
    // Use first model for cost calculation (model-specific pricing), fall back to provider
    const getCostModel = (funcData) => funcData.models.size > 0 ? Array.from(funcData.models)[0] : funcData.provider;
    if (byFunc.outline.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.outline), byFunc.outline.input_tokens, byFunc.outline.output_tokens, byFunc.outline.thinking_tokens);
      log.debug(`   Outline:       ${byFunc.outline.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.outline.output_tokens.toLocaleString().padStart(8)} out (${byFunc.outline.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.outline)}]`);
    }
    if (byFunc.scene_descriptions.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.scene_descriptions), byFunc.scene_descriptions.input_tokens, byFunc.scene_descriptions.output_tokens, byFunc.scene_descriptions.thinking_tokens);
      log.debug(`   Scene Desc:    ${byFunc.scene_descriptions.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.scene_descriptions.output_tokens.toLocaleString().padStart(8)} out (${byFunc.scene_descriptions.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.scene_descriptions)}]`);
    }
    if (byFunc.story_text.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.story_text), byFunc.story_text.input_tokens, byFunc.story_text.output_tokens, byFunc.story_text.thinking_tokens);
      log.debug(`   Story Text:    ${byFunc.story_text.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.story_text.output_tokens.toLocaleString().padStart(8)} out (${byFunc.story_text.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.story_text)}]`);
    }
    if (byFunc.cover_images.calls > 0) {
      const model = getModels(byFunc.cover_images);
      const cost = calculateImageCost(model, byFunc.cover_images.calls);
      log.debug(`   Cover Images:  ${byFunc.cover_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_images.calls} calls)  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.cover_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.cover_quality), byFunc.cover_quality.input_tokens, byFunc.cover_quality.output_tokens, byFunc.cover_quality.thinking_tokens);
      log.debug(`   Cover Quality: ${byFunc.cover_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.cover_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.cover_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.cover_quality)}]`);
    }
    if (byFunc.page_images.calls > 0) {
      const model = getModels(byFunc.page_images);
      const cost = calculateImageCost(model, byFunc.page_images.calls);
      log.debug(`   Page Images:   ${byFunc.page_images.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_images.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_images.calls} calls)  $${cost.toFixed(4)}  [${model}]`);
    }
    if (byFunc.page_quality.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.page_quality), byFunc.page_quality.input_tokens, byFunc.page_quality.output_tokens, byFunc.page_quality.thinking_tokens);
      log.debug(`   Page Quality:  ${byFunc.page_quality.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.page_quality.output_tokens.toLocaleString().padStart(8)} out (${byFunc.page_quality.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.page_quality)}]`);
    }
    if (byFunc.inpaint.calls > 0) {
      const cost = calculateCost(getCostModel(byFunc.inpaint), byFunc.inpaint.input_tokens, byFunc.inpaint.output_tokens, byFunc.inpaint.thinking_tokens);
      log.debug(`   Inpaint:       ${byFunc.inpaint.input_tokens.toLocaleString().padStart(8)} in / ${byFunc.inpaint.output_tokens.toLocaleString().padStart(8)} out (${byFunc.inpaint.calls} calls)  $${cost.total.toFixed(4)}  [${getModels(byFunc.inpaint)}]`);
    }
    log.trace(`   ─────────────────────────────────────────────────────────────`);
    const thinkingTotal = totalThinkingTokens > 0 ? `, ${totalThinkingTokens.toLocaleString()} thinking` : '';
    log.debug(`   TOTAL: ${totalInputTokens.toLocaleString()} input, ${totalOutputTokens.toLocaleString()} output${thinkingTotal} tokens`);
    log.debug(`   💰 TOTAL COST: $${totalCost.toFixed(4)}`);
    log.trace(`   ─────────────────────────────────────────────────────────────`);

    // Log API usage to generationLog for dev mode visibility
    genLog.setStage('finalize');
    // Image generation functions use per-image pricing, not token-based
    const IMAGE_FUNCTIONS = ['cover_images', 'page_images', 'avatar_styled', 'avatar_costumed'];
    for (const [funcName, funcData] of Object.entries(byFunc)) {
      if (funcData.calls > 0) {
        const model = getModels(funcData);
        const directCost = funcData.direct_cost || 0;
        let cost;
        if (directCost > 0) {
          cost = directCost;
        } else if (IMAGE_FUNCTIONS.includes(funcName)) {
          cost = calculateImageCost(model, funcData.calls);
        } else {
          cost = calculateCost(getCostModel(funcData), funcData.input_tokens, funcData.output_tokens, funcData.thinking_tokens).total;
        }
        genLog.apiUsage(funcName, model, {
          inputTokens: funcData.input_tokens,
          outputTokens: funcData.output_tokens,
          thinkingTokens: funcData.thinking_tokens,
          directCost: directCost,
          calls: funcData.calls
        }, cost);
      }
    }

    // Add total cost summary to generation log
    genLog.info('total_cost', `💰 Total API cost: $${totalCost.toFixed(4)}`, null, {
      totalCost: totalCost,
      totalInputTokens,
      totalOutputTokens,
      runwareCost: tokenUsage.runware?.direct_cost || 0
    });
    genLog.finalize();

    // Add generationLog to storyData
    storyData.generationLog = genLog.getEntries();
    storyData.styledAvatarGeneration = getStyledAvatarGenerationLog();
    storyData.costumedAvatarGeneration = getCostumedAvatarGenerationLog();

    // Insert into stories table with metadata for fast list queries
    await upsertStory(storyId, userId, storyData);
    log.debug(`📚 Story ${storyId} saved to stories table`);

    // Initialize image_version_meta with active versions for all pages
    if (storyData.sceneImages?.length > 0) {
      for (const scene of storyData.sceneImages) {
        if (scene.imageVersions?.length > 0) {
          const activeIndex = getActiveIndexAfterPush(scene.imageVersions, 'scene');
          await setActiveVersion(storyId, scene.pageNumber, activeIndex);
        }
      }
      log.debug(`📚 Initialized image_version_meta for ${storyData.sceneImages.length} pages`);
    }

    // Log credit completion (credits were already reserved at job creation)
    try {
      const creditJobResult = await dbPool.query(
        'SELECT credits_reserved FROM story_jobs WHERE id = $1',
        [jobId]
      );
      if (creditJobResult.rows.length > 0 && creditJobResult.rows[0].credits_reserved > 0) {
        const creditsUsed = creditJobResult.rows[0].credits_reserved;
        const userResult = await dbPool.query('SELECT credits FROM users WHERE id = $1', [userId]);
        const currentBalance = userResult.rows[0]?.credits || 0;

        await dbPool.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, 0, currentBalance, 'story_complete', jobId, `Story completed - ${creditsUsed} credits used`]
        );
        log.debug(`💳 Story completed, ${creditsUsed} credits used for job ${jobId}`);
      }
    } catch (creditErr) {
      log.error('❌ Failed to log credit completion:', creditErr.message);
    }

    // Add storyId to resultData so client can navigate to it
    resultData.storyId = storyId;

    await dbPool.query(
      `UPDATE story_jobs
       SET status = $1, progress = $2, progress_message = $3, result_data = $4,
           credits_reserved = 0, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $5`,
      ['completed', 100, 'Story generation complete!', JSON.stringify(resultData), jobId]
    );

    // Clean up checkpoints immediately - story is saved, no longer needed
    await deleteJobCheckpoints(jobId);

    // Clear styled avatar cache to free memory
    clearStyledAvatarCache();

    console.log(`✅ Job ${jobId} completed successfully`);

    // Send story completion email to customer
    try {
      const userResult = await dbPool.query(
        'SELECT email, username, shipping_first_name, preferred_language FROM users WHERE id = $1',
        [userId]
      );
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        const user = userResult.rows[0];
        const storyTitle = inputData.storyTitle || inputData.title || 'Your Story';
        // Use shipping_first_name if available, otherwise fall back to username
        const firstName = user.shipping_first_name || user.username?.split(' ')[0] || null;
        // Get language for email localization - prefer user's preference, fall back to story language
        const emailLanguage = user.preferred_language || inputData.language || 'English';
        await email.sendStoryCompleteEmail(user.email, firstName, storyTitle, storyId, emailLanguage);
      }
    } catch (emailErr) {
      log.error('❌ Failed to send story complete email:', emailErr);
    }

}

module.exports = {
  init,
  processStorybookJob,
  processOutlineAndTextJob
};
